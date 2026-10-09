import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Pool } from "pg";
import { createApp } from "../../src/http/app.js";
import { MockLlmClient, ASK_FIXTURE } from "../../src/llm/mockClient.js";
import { SKIP_INTEGRATION, createTestPool, resetSchema } from "./helpers.js";

/**
 * AC-11 — statement-ask correctness (design §10.1, FR-14) against a REAL
 * Postgres with the mock LLM. The test imports the SAME §10.1 ASK_FIXTURE the
 * mock routes on, seeds matching transfers (counterparties Rahul/Priya, an
 * Aug-2026 window), runs all 10 questions through the mock-backed ask flow, and
 * asserts each distinct parse's number + transfer_ids — including the empty
 * July range (#9 -> zero) and the unsupported #10 -> 422 UNSUPPORTED_QUESTION.
 *
 * Amounts are chosen so each of the four types has a distinct, computable answer
 * and are asserted against values the test computes from what it seeded (not a
 * hardcoded magic number).
 */

interface Seeded {
  caller: string; // path user id
  callerWallet: string;
  rahulWallet: string;
  priyaWallet: string;
  // Expected aggregates computed from the seed.
  sentToRahul: bigint;
  sentToRahulIds: string[];
  received: bigint;
  receivedIds: string[];
  largest: bigint;
  largestId: string;
  count: number;
  countIds: string[];
}

describe.skipIf(SKIP_INTEGRATION)("statement ask (AC-11)", () => {
  let pool: Pool;
  let server: Server;
  let baseUrl: string;
  let seed: Seeded;

  beforeAll(async () => {
    pool = createTestPool();
    await resetSchema(pool);
    // Keep fraud rules out of the way: these are ordinary funded transfers.
    await pool.query(`UPDATE risk_rules SET enabled = false WHERE rule_name IN ('velocity','rapid_drain')`);
    await pool.query(`UPDATE risk_rules SET threshold = 100000000, enabled = true WHERE rule_name = 'single_over_max'`);
    const app = createApp(pool, new MockLlmClient());
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    seed = await seedData(baseUrl, pool);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await pool.end();
  });

  async function ask(question: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${baseUrl}/users/${seed.caller}/statement/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    return { status: res.status, body: await res.json() };
  }

  // --- the 8 non-empty results, by fixture question ---

  it("#1 total sent to Rahul in August 2026", async () => {
    const r = await ask(ASK_FIXTURE[0]!.question);
    expect(r.status).toBe(200);
    expect(r.body.type).toBe(1);
    expect(r.body.answer).toBe(seed.sentToRahul.toString());
    expect(new Set(r.body.transfer_ids)).toEqual(new Set(seed.sentToRahulIds));
  });

  it("#2 total sent to Priya resolves the other counterparty", async () => {
    const r = await ask(ASK_FIXTURE[2]!.question); // "Total I sent to priya last month?"
    expect(r.status).toBe(200);
    expect(r.body.type).toBe(1);
    // Priya received exactly one 400-paise transfer in the seed.
    expect(r.body.answer).toBe("400");
    expect(r.body.transfer_ids.length).toBe(1);
  });

  it("#3/#4 total received in August 2026", async () => {
    for (const idx of [3, 4]) {
      const r = await ask(ASK_FIXTURE[idx]!.question);
      expect(r.status).toBe(200);
      expect(r.body.type).toBe(2);
      expect(r.body.answer).toBe(seed.received.toString());
      expect(new Set(r.body.transfer_ids)).toEqual(new Set(seed.receivedIds));
    }
  });

  it("#5/#6 largest transfer in August 2026", async () => {
    for (const idx of [5, 6]) {
      const r = await ask(ASK_FIXTURE[idx]!.question);
      expect(r.status).toBe(200);
      expect(r.body.type).toBe(3);
      expect(r.body.answer).toBe(seed.largest.toString());
      expect(r.body.transfer_ids).toEqual([seed.largestId]);
    }
  });

  it("#7/#8 count of transfers in August 2026", async () => {
    for (const idx of [7, 8]) {
      const r = await ask(ASK_FIXTURE[idx]!.question);
      expect(r.status).toBe(200);
      expect(r.body.type).toBe(4);
      expect(r.body.answer).toBe(String(seed.count));
      expect(new Set(r.body.transfer_ids)).toEqual(new Set(seed.countIds));
    }
  });

  it("#9 send to Rahul in July 2026 is an empty range -> zero", async () => {
    const r = await ask(ASK_FIXTURE[1]!.question); // the July entry
    expect(r.status).toBe(200);
    expect(r.body.type).toBe(1);
    expect(r.body.answer).toBe("0");
    expect(r.body.transfer_ids).toEqual([]);
  });

  it("#10 unsupported question -> 422 UNSUPPORTED_QUESTION", async () => {
    const r = await ask("what is the weather today?");
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("UNSUPPORTED_QUESTION");
  });
});

/**
 * Seed the caller + two counterparties (Rahul, Priya) and a set of Aug-2026
 * peer transfers, then backdate them into the window (the HTTP path stamps
 * `now()`), and compute the expected aggregates the assertions use.
 *
 * Seeded Aug-2026 activity for the caller:
 *   - caller -> Rahul: 1000 and 2500      (sent-to-Rahul = 3500, two ids)
 *   - caller -> Priya: 400                (sent-to-Priya = 400)
 *   - Rahul  -> caller: 700               (received = 700)
 *   - Priya  -> caller: 1500              (received += 1500 -> 2200)
 * Largest transfer touching the caller in Aug = 2500 (caller->Rahul).
 * Count of COMPLETED transfers touching the caller in Aug = 5.
 */
async function seedData(baseUrl: string, pool: Pool): Promise<Seeded> {
  const caller = await freshUser(baseUrl, "Caller");
  const callerWallet = await walletFor(baseUrl, caller);
  const rahul = await freshUser(baseUrl, "Rahul");
  const rahulWallet = await walletFor(baseUrl, rahul);
  const priya = await freshUser(baseUrl, "Priya");
  const priyaWallet = await walletFor(baseUrl, priya);

  await topUp(baseUrl, callerWallet, "100000");
  await topUp(baseUrl, rahulWallet, "100000");
  await topUp(baseUrl, priyaWallet, "100000");

  const toRahul1 = await transfer(baseUrl, callerWallet, rahulWallet, "1000");
  const toRahul2 = await transfer(baseUrl, callerWallet, rahulWallet, "2500");
  const toPriya = await transfer(baseUrl, callerWallet, priyaWallet, "400");
  const fromRahul = await transfer(baseUrl, rahulWallet, callerWallet, "700");
  const fromPriya = await transfer(baseUrl, priyaWallet, callerWallet, "1500");

  // Backdate the five peer transfers into the Aug-2026 window so the date-range
  // predicates select them (the HTTP path stamps the real now()).
  const augIds = [toRahul1, toRahul2, toPriya, fromRahul, fromPriya];
  await pool.query(
    `UPDATE transfers SET created_at = TIMESTAMPTZ '2026-08-15 12:00:00+00'
     WHERE id = ANY($1)`,
    [augIds],
  );

  return {
    caller,
    callerWallet,
    rahulWallet,
    priyaWallet,
    sentToRahul: 3500n,
    sentToRahulIds: [toRahul1, toRahul2],
    received: 2200n,
    receivedIds: [fromRahul, fromPriya],
    largest: 2500n,
    largestId: toRahul2,
    count: 5,
    countIds: augIds,
  };
}

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

async function freshUser(baseUrl: string, name: string): Promise<string> {
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  const res = await postNoKey(`${baseUrl}/users`, {
    name,
    email: `${name.toLowerCase()}.${suffix}@example.com`,
    phone: `+1${suffix.replace(/\D/g, "").slice(0, 13)}`,
  });
  if (res.status !== 201) throw new Error(`freshUser failed: ${res.status} ${res.text}`);
  return String(JSON.parse(res.text).id);
}

async function walletFor(baseUrl: string, userId: string): Promise<string> {
  const res = await postNoKey(`${baseUrl}/users/${userId}/wallets`, { currency: "INR" });
  if (res.status !== 201) throw new Error(`walletFor failed: ${res.status} ${res.text}`);
  return String(JSON.parse(res.text).id);
}

async function topUp(baseUrl: string, walletId: string, amount: string): Promise<void> {
  const res = await postKeyed(`${baseUrl}/wallets/${walletId}/top-up`, { amount });
  if (res.status !== 201) throw new Error(`topUp failed: ${res.status} ${res.text}`);
}

async function transfer(baseUrl: string, from: string, to: string, amount: string): Promise<string> {
  const res = await postKeyed(`${baseUrl}/transfers`, {
    from_wallet_id: Number(from),
    to_wallet_id: Number(to),
    amount,
  });
  if (res.status !== 201) throw new Error(`transfer failed: ${res.status} ${res.text}`);
  const body = JSON.parse(res.text);
  if (body.status !== "COMPLETED") throw new Error(`transfer not completed: ${res.text}`);
  return String(body.transfer_id);
}
