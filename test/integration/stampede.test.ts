import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Pool } from "pg";
import { createApp } from "../../src/http/app.js";
import { MockLlmClient } from "../../src/llm/mockClient.js";
import { SKIP_INTEGRATION, createTestPool, resetSchema } from "./helpers.js";

/**
 * AC-1 — the stampede / concurrency acceptance test (design §12, §15).
 *
 * Per iteration:
 *   - create a fresh user + wallet, top it up to 50000 paise;
 *   - DISABLE the velocity and rapid_drain rules for the run (so fraud never
 *     holds a withdrawal and the test measures ONLY the locking/funds path);
 *   - fire 100 concurrent 1000-paise withdrawals via Promise.all, each with a
 *     distinct, valid-UUID Idempotency-Key header (the money POSTs require a
 *     UUID key per FEAT-004; 100 distinct keys per iteration keep every attempt
 *     a fresh request so exactly 50 win on funds, not on replay);
 *   - assert EXACTLY 50 succeed (201), the wallet ends at exactly 0, no read
 *     ever observed a negative balance, and the GLOBAL ledger stays balanced
 *     (SUM(debit) == SUM(credit)).
 *
 * ~20 iterations. The row locks (SELECT ... FOR UPDATE ascending by id) are what
 * make this deterministic at READ COMMITTED (design §9.2): the 101st-through
 * concurrent request blocks on the lock, re-reads the committed balance, and is
 * correctly rejected once the wallet is drained.
 */

const ITERATIONS = 20;
const CONCURRENCY = 100;
const WITHDRAW_PAISE = 1000;
const START_BALANCE = 50000; // exactly 50 successful 1000-paise withdrawals

describe.skipIf(SKIP_INTEGRATION)("stampede: 100 concurrent withdrawals (AC-1)", () => {
  let pool: Pool;
  let server: Server;
  let baseUrl: string;
  // Saved so we can restore the shared seed after the run.
  let savedRules: Array<{ rule_name: string; enabled: boolean }> = [];

  beforeAll(async () => {
    pool = createTestPool();
    await resetSchema(pool);

    // Disable the fraud rules that could hold a withdrawal.
    const current = await pool.query<{ rule_name: string; enabled: boolean }>(
      `SELECT rule_name, enabled FROM risk_rules
       WHERE rule_name IN ('velocity', 'rapid_drain')`,
    );
    savedRules = current.rows;
    await pool.query(
      `UPDATE risk_rules SET enabled = false
       WHERE rule_name IN ('velocity', 'rapid_drain')`,
    );

    const app = createApp(pool, new MockLlmClient());
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    // Restore the fraud rules to their seeded state.
    for (const rule of savedRules) {
      await pool.query(`UPDATE risk_rules SET enabled = $2 WHERE rule_name = $1`, [
        rule.rule_name,
        rule.enabled,
      ]);
    }
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await pool.end();
  });

  it(`runs ${ITERATIONS} iterations with exactly 50 winners each`, async () => {
    for (let iter = 0; iter < ITERATIONS; iter++) {
      const walletId = await createFundedWallet(pool, START_BALANCE, iter);

      const attempts = Array.from({ length: CONCURRENCY }, () =>
        withdraw(baseUrl, walletId, WITHDRAW_PAISE, randomUUID()),
      );
      const results = await Promise.all(attempts);

      const successes = results.filter((r) => r.status === 201);
      const rejected = results.filter((r) => r.status === 422);

      // Exactly 50 succeed; the rest are INSUFFICIENT_FUNDS (422).
      expect(successes).toHaveLength(50);
      expect(rejected).toHaveLength(50);
      for (const r of rejected) {
        expect(r.body.code).toBe("INSUFFICIENT_FUNDS");
      }

      // No successful response ever reported a negative wallet balance.
      for (const r of successes) {
        expect(BigInt(r.body.wallet_balance as string) >= 0n).toBe(true);
      }

      // Wallet ends at exactly 0.
      const bal = await pool.query<{ balance: string }>(
        `SELECT balance FROM accounts WHERE id = $1`,
        [walletId],
      );
      expect(bal.rows[0]?.balance).toBe("0");
    }

    // Global invariant across EVERYTHING written this run: debits == credits.
    const totals = await pool.query<{ debit: string; credit: string }>(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0)  AS debit,
         COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0) AS credit
       FROM ledger_entries`,
    );
    expect(totals.rows[0]?.debit).toBe(totals.rows[0]?.credit);
  }, 120_000);
});

/** Create a user + wallet, then top it up to `balance` paise via the service path. */
async function createFundedWallet(pool: Pool, balance: number, iter: number): Promise<string> {
  const suffix = `${Date.now()}_${iter}_${Math.floor(Math.random() * 1e6)}`;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (name, email, phone, kyc_status)
     VALUES ('Stampede', $1, $2, 'verified') RETURNING id`,
    [`stampede.${suffix}@example.com`, `+1${suffix.replace(/\D/g, "").slice(0, 13)}`],
  );
  const userId = user.rows[0]!.id;
  const wallet = await pool.query<{ id: string }>(
    `INSERT INTO accounts (user_id, is_system, system_type, currency, balance)
     VALUES ($1, false, NULL, 'INR', 0) RETURNING id`,
    [userId],
  );
  const walletId = wallet.rows[0]!.id;

  // Top up through a real top_up transfer so the ledger stays balanced.
  const cashIn = await pool.query<{ id: string }>(
    `SELECT id FROM accounts WHERE is_system = true AND system_type = 'cash_in'`,
  );
  const cashInId = cashIn.rows[0]!.id;
  const transfer = await pool.query<{ id: string }>(
    `INSERT INTO transfers (type, status, amount, from_account_id, to_account_id)
     VALUES ('top_up', 'COMPLETED', $1, $2, $3) RETURNING id`,
    [String(balance), cashInId, walletId],
  );
  const transferId = transfer.rows[0]!.id;
  await pool.query(
    `INSERT INTO ledger_entries (transfer_id, account_id, direction, amount) VALUES
       ($1, $2, 'debit', $3), ($1, $4, 'credit', $3)`,
    [transferId, cashInId, String(balance), walletId],
  );
  await pool.query(`UPDATE accounts SET balance = balance + $2 WHERE id = $1`, [
    walletId,
    String(balance),
  ]);
  await pool.query(`UPDATE accounts SET balance = balance - $2 WHERE id = $1`, [
    cashInId,
    String(balance),
  ]);

  return walletId;
}

interface WithdrawResponse {
  status: number;
  body: Record<string, unknown>;
}

/** POST a withdrawal to the real HTTP app and return status + parsed body. */
async function withdraw(
  baseUrl: string,
  walletId: string,
  amount: number,
  key: string,
): Promise<WithdrawResponse> {
  const res = await fetch(`${baseUrl}/wallets/${walletId}/withdraw`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify({ amount }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}
