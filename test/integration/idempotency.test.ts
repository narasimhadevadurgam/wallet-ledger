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
 * Idempotency acceptance tests (design §11, §12 AC-2..AC-5) — against a REAL
 * Postgres. Everything runs through the actual HTTP app (listen(0) + fetch) so
 * the middleware (400 missing key), the insert-key-first replay path, and the
 * byte-for-byte saved-response replay are all exercised end to end.
 *
 *   AC-2  5 sequential same-key calls on a successful request -> exactly 1
 *         transfer row and 5 byte-identical response bodies.
 *   AC-3  10 parallel same-key calls (Promise.all) -> exactly 1 transfer row.
 *   AC-4  same key + different amount -> 422 IDEMPOTENCY_BODY_MISMATCH, no
 *         money moved.
 *   AC-5  a money POST without the header -> 400 MISSING_IDEMPOTENCY_KEY; an
 *         exempt POST (/users/{id}/wallets) does NOT 400 for a missing key.
 *   §11.3 Case-2 retry: a same-key first attempt that fails on insufficient
 *         funds persists NO key; after a top-up a retry with the SAME key
 *         succeeds and creates a transfer.
 */

describe.skipIf(SKIP_INTEGRATION)("idempotency (AC-2..AC-5, §11.3)", () => {
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
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await pool.end();
  });

  it("AC-2: 5 sequential same-key top-ups -> 1 transfer, 5 identical responses", async () => {
    const walletId = await createWallet(baseUrl);
    const key = randomUUID();
    const body = { amount: "1000" };

    const responses: Array<{ status: number; text: string }> = [];
    for (let i = 0; i < 5; i++) {
      responses.push(await postJson(`${baseUrl}/wallets/${walletId}/top-up`, body, key));
    }

    // Every call returns 201 and the body is byte-identical to the first.
    const first = responses[0]!;
    expect(first.status).toBe(201);
    for (const r of responses) {
      expect(r.status).toBe(201);
      expect(r.text).toBe(first.text);
    }

    // Exactly ONE top_up transfer landed on this wallet.
    expect(await countTransfers(pool, walletId)).toBe(1);
    // The wallet moved exactly once (1000 paise), not five times.
    expect(await walletBalance(pool, walletId)).toBe("1000");
  });

  it("AC-3: 10 parallel same-key top-ups -> exactly 1 transfer", async () => {
    const walletId = await createWallet(baseUrl);
    const key = randomUUID();
    const body = { amount: "2500" };

    const attempts = Array.from({ length: 10 }, () =>
      postJson(`${baseUrl}/wallets/${walletId}/top-up`, body, key),
    );
    const results = await Promise.all(attempts);

    // All 10 return 201 (one fresh, nine replays) with the identical body.
    const texts = new Set(results.map((r) => r.text));
    for (const r of results) {
      expect(r.status).toBe(201);
    }
    expect(texts.size).toBe(1);

    // Exactly ONE transfer, exactly one movement.
    expect(await countTransfers(pool, walletId)).toBe(1);
    expect(await walletBalance(pool, walletId)).toBe("2500");
  });

  it("AC-4: same key + different amount -> 422, no money moved", async () => {
    const walletId = await createWallet(baseUrl);
    const key = randomUUID();

    const first = await postJson(`${baseUrl}/wallets/${walletId}/top-up`, { amount: "1000" }, key);
    expect(first.status).toBe(201);
    const afterFirst = await walletBalance(pool, walletId);
    expect(afterFirst).toBe("1000");

    // Same key, different body -> body-hash mismatch.
    const mismatch = await postJson(`${baseUrl}/wallets/${walletId}/top-up`, { amount: "2000" }, key);
    expect(mismatch.status).toBe(422);
    expect(JSON.parse(mismatch.text).code).toBe("IDEMPOTENCY_BODY_MISMATCH");

    // No additional money moved and still exactly one transfer.
    expect(await walletBalance(pool, walletId)).toBe("1000");
    expect(await countTransfers(pool, walletId)).toBe(1);
  });

  it("AC-5: money POST without Idempotency-Key -> 400; exempt POST does not 400", async () => {
    const userId = await createUser(baseUrl);

    // Money POST without the header -> 400 MISSING_IDEMPOTENCY_KEY, no DB work.
    const walletRes = await postJsonNoKey(`${baseUrl}/users/${userId}/wallets`, { currency: "INR" });
    expect(walletRes.status).toBe(201); // exempt POST: no key required.
    const walletId = String(JSON.parse(walletRes.text).id);

    const topUpNoKey = await postJsonNoKey(`${baseUrl}/wallets/${walletId}/top-up`, { amount: "500" });
    expect(topUpNoKey.status).toBe(400);
    expect(JSON.parse(topUpNoKey.text).code).toBe("MISSING_IDEMPOTENCY_KEY");

    // A non-UUID key is also rejected.
    const badKey = await postJson(`${baseUrl}/wallets/${walletId}/top-up`, { amount: "500" }, "not-a-uuid");
    expect(badKey.status).toBe(400);
    expect(JSON.parse(badKey.text).code).toBe("MISSING_IDEMPOTENCY_KEY");

    // The rejected calls moved no money and created no transfer.
    expect(await walletBalance(pool, walletId)).toBe("0");
    expect(await countTransfers(pool, walletId)).toBe(0);
  });

  it("§11.3 Case-2: failed first attempt persists no key; same-key retry after top-up succeeds", async () => {
    const senderId = await createUser(baseUrl);
    const senderWallet = await createWalletForUser(baseUrl, senderId);
    const recipientId = await createUser(baseUrl);
    const recipientWallet = await createWalletForUser(baseUrl, recipientId);

    const key = randomUUID();
    const body = {
      from_wallet_id: Number(senderWallet),
      to_wallet_id: Number(recipientWallet),
      amount: "1000",
    };

    // First attempt: sender has 0 balance -> INSUFFICIENT_FUNDS (422), rolls
    // back, so the step-3 key row disappears with the txn (Case 2).
    const failed = await postJson(`${baseUrl}/transfers`, body, key);
    expect(failed.status).toBe(422);
    expect(JSON.parse(failed.text).code).toBe("INSUFFICIENT_FUNDS");
    expect(await keyExists(pool, senderId, key)).toBe(false);
    expect(await countTransfers(pool, senderWallet)).toBe(0);

    // Top the sender up (its own idempotency key) so the retry can fund.
    const topUp = await postJson(
      `${baseUrl}/wallets/${senderWallet}/top-up`,
      { amount: "1000" },
      randomUUID(),
    );
    expect(topUp.status).toBe(201);

    // Retry the SAME transfer key: no committed key exists, so it re-executes
    // from scratch and now succeeds, creating a transfer.
    const retry = await postJson(`${baseUrl}/transfers`, body, key);
    expect(retry.status).toBe(201);
    expect(JSON.parse(retry.text).status).toBe("COMPLETED");
    expect(await keyExists(pool, senderId, key)).toBe(true);
    // The peer transfer moved 1000 out of the sender (fee defaults to 0).
    expect(await walletBalance(pool, senderWallet)).toBe("0");
    expect(await walletBalance(pool, recipientWallet)).toBe("1000");
    // Exactly one COMPLETED peer transfer from the sender for this retry.
    expect(await countPeerTransfersFrom(pool, senderWallet)).toBe(1);
  });
});

// --- HTTP helpers -----------------------------------------------------------

interface RawResponse {
  status: number;
  text: string;
}

/** POST JSON with an Idempotency-Key header; return status + raw body text. */
async function postJson(
  url: string,
  body: unknown,
  idempotencyKey: string,
): Promise<RawResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

/** POST JSON with NO Idempotency-Key header. */
async function postJsonNoKey(url: string, body: unknown): Promise<RawResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

/** Create a user via the exempt POST /users and return its id. */
async function createUser(baseUrl: string): Promise<string> {
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  const res = await postJsonNoKey(`${baseUrl}/users`, {
    name: "Idem",
    email: `idem.${suffix}@example.com`,
    phone: `+1${suffix.replace(/\D/g, "").slice(0, 13)}`,
  });
  if (res.status !== 201) {
    throw new Error(`createUser failed: ${res.status} ${res.text}`);
  }
  return String(JSON.parse(res.text).id);
}

/** Create a wallet for an existing user via the exempt POST /users/{id}/wallets. */
async function createWalletForUser(baseUrl: string, userId: string): Promise<string> {
  const res = await postJsonNoKey(`${baseUrl}/users/${userId}/wallets`, { currency: "INR" });
  if (res.status !== 201) {
    throw new Error(`createWallet failed: ${res.status} ${res.text}`);
  }
  return String(JSON.parse(res.text).id);
}

/** Create a fresh user + wallet and return the wallet id. */
async function createWallet(baseUrl: string): Promise<string> {
  const userId = await createUser(baseUrl);
  return createWalletForUser(baseUrl, userId);
}

// --- DB assertions ----------------------------------------------------------

/** Count transfers touching `walletId` (as source OR destination). */
async function countTransfers(pool: Pool, walletId: string): Promise<number> {
  const res = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM transfers
     WHERE from_account_id = $1 OR to_account_id = $1`,
    [walletId],
  );
  return Number(res.rows[0]!.n);
}

/** Count COMPLETED peer transfers whose source is `walletId`. */
async function countPeerTransfersFrom(pool: Pool, walletId: string): Promise<number> {
  const res = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM transfers
     WHERE from_account_id = $1 AND type = 'peer_transfer' AND status = 'COMPLETED'`,
    [walletId],
  );
  return Number(res.rows[0]!.n);
}

/** Current stored balance (string) of a wallet. */
async function walletBalance(pool: Pool, walletId: string): Promise<string> {
  const res = await pool.query<{ balance: string }>(
    `SELECT balance FROM accounts WHERE id = $1`,
    [walletId],
  );
  return res.rows[0]!.balance;
}

/** Whether an idempotency key row exists for (userId, key). */
async function keyExists(pool: Pool, userId: string, key: string): Promise<boolean> {
  const res = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
    [userId, key],
  );
  return Number(res.rows[0]!.n) > 0;
}
