import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Pool } from "pg";
import { runMigrations } from "../../src/db/migrateRunner.js";
import { createApp } from "../../src/http/app.js";
import { MockLlmClient } from "../../src/llm/mockClient.js";
import { SKIP_INTEGRATION, createTestPool } from "./helpers.js";

/**
 * Fraud acceptance tests (design §9.1 step 6, §9.1.1, §14; §12 AC-8/AC-9) —
 * against a REAL Postgres. Authored for FEAT-006; executed only when
 * DATABASE_URL is set (skipped otherwise; see helpers.ts).
 *
 *   AC-8 (single_over_max -> hold): a FUNDABLE transfer above the configured
 *        max is created HELD and moves NO money; release then COMPLETES it and
 *        moves money exactly once. A companion case drains the sender between
 *        hold and release and asserts release -> 422 INSUFFICIENT_FUNDS with the
 *        transfer left FAILED and no money moved.
 *   AC-9 (velocity -> hold): velocity is overridden to a LOW threshold for the
 *        run; a burst within the window trips the rule, so the tripping transfer
 *        is HELD, moves no money, and has a risk_flags row naming velocity.
 */

describe.skipIf(SKIP_INTEGRATION)("fraud rules (AC-8, AC-9)", () => {
  let pool: Pool;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    pool = createTestPool();
    await runMigrations(pool);
    const app = createApp(pool, new MockLlmClient());
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    // Restore seeded rule defaults so a shared DB is left clean for other suites.
    await pool.query(
      `UPDATE risk_rules SET threshold = 100000000, enabled = true WHERE rule_name = 'single_over_max'`,
    );
    await pool.query(
      `UPDATE risk_rules SET threshold = 1000, window_seconds = 60, enabled = true WHERE rule_name = 'velocity'`,
    );
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await pool.end();
  });

  it("AC-8: fundable over-max transfer is HELD and moves no money; release completes it", async () => {
    // Lower single_over_max so a modest, fundable transfer trips it; keep
    // velocity/rapid_drain out of the way for this case.
    await pool.query(`UPDATE risk_rules SET enabled = false WHERE rule_name IN ('velocity','rapid_drain')`);
    await pool.query(`UPDATE risk_rules SET threshold = 500, enabled = true WHERE rule_name = 'single_over_max'`);

    const sender = await freshWallet(baseUrl);
    const recipient = await freshWallet(baseUrl);
    await topUp(baseUrl, sender, "5000");

    // 1000 > 500 threshold, but the sender holds 5000 -> fundable -> HELD.
    const res = await postKeyed(`${baseUrl}/transfers`, {
      from_wallet_id: Number(sender),
      to_wallet_id: Number(recipient),
      amount: "1000",
    });
    expect(res.status).toBe(201);
    const held = JSON.parse(res.text);
    expect(held.status).toBe("HELD");
    const transferId = String(held.transfer_id);

    // No money moved on hold; a risk_flags row names single_over_max.
    expect(await balance(pool, sender)).toBe("5000");
    expect(await balance(pool, recipient)).toBe("0");
    expect(await ledgerCount(pool, transferId)).toBe(0);
    expect(await flagRule(pool, transferId)).toBe("single_over_max");

    // Release -> COMPLETED, money moves exactly once.
    const rel = await postNoKey(`${baseUrl}/admin/transfers/${transferId}/release`, {});
    expect(rel.status).toBe(200);
    expect(JSON.parse(rel.text).status).toBe("COMPLETED");
    expect(await balance(pool, sender)).toBe("4000");
    expect(await balance(pool, recipient)).toBe("1000");
    expect(await ledgerCount(pool, transferId)).toBe(2);
    expect(await transferStatus(pool, transferId)).toBe("COMPLETED");

    // A second release is idempotency-exempt and 409s (no longer HELD).
    const rel2 = await postNoKey(`${baseUrl}/admin/transfers/${transferId}/release`, {});
    expect(rel2.status).toBe(409);
    expect(JSON.parse(rel2.text).code).toBe("TRANSFER_NOT_HELD");
  });

  it("AC-8 companion: draining the sender before release -> 422 and transfer left FAILED", async () => {
    await pool.query(`UPDATE risk_rules SET enabled = false WHERE rule_name IN ('velocity','rapid_drain')`);
    await pool.query(`UPDATE risk_rules SET threshold = 500, enabled = true WHERE rule_name = 'single_over_max'`);

    const sender = await freshWallet(baseUrl);
    const recipient = await freshWallet(baseUrl);
    const sink = await freshWallet(baseUrl);
    await topUp(baseUrl, sender, "5000");

    // Create a HELD over-max transfer (fundable at hold time).
    const res = await postKeyed(`${baseUrl}/transfers`, {
      from_wallet_id: Number(sender),
      to_wallet_id: Number(recipient),
      amount: "1000",
    });
    const transferId = String(JSON.parse(res.text).transfer_id);
    expect(JSON.parse(res.text).status).toBe("HELD");

    // Drain the sender to 0 via normal transfers (set threshold high so these
    // small transfers complete, then restore for the release).
    await pool.query(`UPDATE risk_rules SET threshold = 100000000 WHERE rule_name = 'single_over_max'`);
    await postKeyed(`${baseUrl}/transfers`, {
      from_wallet_id: Number(sender),
      to_wallet_id: Number(sink),
      amount: "5000",
    });
    expect(await balance(pool, sender)).toBe("0");

    // Release now finds insufficient funds -> 422, transfer FAILED, no money moved.
    const rel = await postNoKey(`${baseUrl}/admin/transfers/${transferId}/release`, {});
    expect(rel.status).toBe(422);
    expect(JSON.parse(rel.text).code).toBe("INSUFFICIENT_FUNDS");
    expect(await transferStatus(pool, transferId)).toBe("FAILED");
    expect(await ledgerCount(pool, transferId)).toBe(0);
    expect(await balance(pool, recipient)).toBe("0");
  });

  it("AC-9: a velocity burst trips a HOLD naming the velocity rule, moving no money", async () => {
    // Isolate: single_over_max/rapid_drain high/off; velocity LOW for this run.
    await pool.query(`UPDATE risk_rules SET threshold = 100000000, enabled = true WHERE rule_name = 'single_over_max'`);
    await pool.query(`UPDATE risk_rules SET enabled = false WHERE rule_name = 'rapid_drain'`);
    // threshold=2 within 60s: the 3rd transfer in the window trips (prior count 2 +1 > 2).
    await pool.query(`UPDATE risk_rules SET threshold = 2, window_seconds = 60, enabled = true WHERE rule_name = 'velocity'`);

    const sender = await freshWallet(baseUrl);
    const recipient = await freshWallet(baseUrl);
    await topUp(baseUrl, sender, "10000");

    const statuses: string[] = [];
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await postKeyed(`${baseUrl}/transfers`, {
        from_wallet_id: Number(sender),
        to_wallet_id: Number(recipient),
        amount: "100",
      });
      expect(res.status).toBe(201);
      const body = JSON.parse(res.text);
      statuses.push(body.status);
      ids.push(String(body.transfer_id));
    }

    // First two complete; the third trips velocity and is HELD.
    expect(statuses[0]).toBe("COMPLETED");
    expect(statuses[1]).toBe("COMPLETED");
    expect(statuses[2]).toBe("HELD");

    const heldId = ids[2]!;
    expect(await flagRule(pool, heldId)).toBe("velocity");
    expect(await ledgerCount(pool, heldId)).toBe(0);
    expect(await transferStatus(pool, heldId)).toBe("HELD");
    // Only the two completed transfers moved money: 2 * 100 = 200 debited.
    expect(await balance(pool, sender)).toBe("9800");
    expect(await balance(pool, recipient)).toBe("200");
  });
});

/* --- HTTP + DB helpers (mirrors idempotency.test.ts) ------------------------ */

interface RawResponse {
  status: number;
  text: string;
}

async function postKeyed(url: string, body: unknown): Promise<RawResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

async function postNoKey(url: string, body: unknown): Promise<RawResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

async function freshUser(baseUrl: string): Promise<string> {
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  const res = await postNoKey(`${baseUrl}/users`, {
    name: "Risk",
    email: `risk.${suffix}@example.com`,
    phone: `+1${suffix.replace(/\D/g, "").slice(0, 13)}`,
  });
  if (res.status !== 201) throw new Error(`freshUser failed: ${res.status} ${res.text}`);
  return String(JSON.parse(res.text).id);
}

async function freshWallet(baseUrl: string): Promise<string> {
  const userId = await freshUser(baseUrl);
  const res = await postNoKey(`${baseUrl}/users/${userId}/wallets`, { currency: "INR" });
  if (res.status !== 201) throw new Error(`freshWallet failed: ${res.status} ${res.text}`);
  return String(JSON.parse(res.text).id);
}

async function topUp(baseUrl: string, walletId: string, amount: string): Promise<void> {
  const res = await postKeyed(`${baseUrl}/wallets/${walletId}/top-up`, { amount });
  if (res.status !== 201) throw new Error(`topUp failed: ${res.status} ${res.text}`);
}

async function balance(pool: Pool, walletId: string): Promise<string> {
  const res = await pool.query<{ balance: string }>(`SELECT balance FROM accounts WHERE id = $1`, [walletId]);
  return res.rows[0]!.balance;
}

async function ledgerCount(pool: Pool, transferId: string): Promise<number> {
  const res = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ledger_entries WHERE transfer_id = $1`,
    [transferId],
  );
  return Number(res.rows[0]!.n);
}

async function transferStatus(pool: Pool, transferId: string): Promise<string> {
  const res = await pool.query<{ status: string }>(`SELECT status FROM transfers WHERE id = $1`, [transferId]);
  return res.rows[0]!.status;
}

async function flagRule(pool: Pool, transferId: string): Promise<string | null> {
  const res = await pool.query<{ rule_name: string }>(
    `SELECT rule_name FROM risk_flags WHERE transfer_id = $1 ORDER BY id LIMIT 1`,
    [transferId],
  );
  return res.rows[0]?.rule_name ?? null;
}
