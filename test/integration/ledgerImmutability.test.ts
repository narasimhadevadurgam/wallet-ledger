import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { SKIP_INTEGRATION, createTestPool, resetSchema } from "./helpers.js";

/**
 * AC-12: the ledger is insert-only and per-transfer debits == credits is
 * DB-enforced.
 *   - UPDATE and DELETE on ledger_entries both raise (insert-only trigger, 0013).
 *   - An unbalanced per-transfer entry set (a debit with no matching credit)
 *     cannot COMMIT (deferred balance trigger, 0014).
 *
 * We use the seeded system accounts as endpoints so we do not depend on any
 * user/wallet seed; they may go negative, so no non-negative CHECK interferes.
 */

interface SystemAccounts {
  cashIn: string;
  cashOut: string;
}

async function systemAccountIds(pool: Pool): Promise<SystemAccounts> {
  const res = await pool.query<{ system_type: string; id: string }>(
    `SELECT system_type, id FROM accounts WHERE is_system = true`,
  );
  const byType = new Map(res.rows.map((r) => [r.system_type, r.id]));
  const cashIn = byType.get("cash_in");
  const cashOut = byType.get("cash_out");
  if (!cashIn || !cashOut) throw new Error("system accounts not seeded");
  return { cashIn, cashOut };
}

describe.skipIf(SKIP_INTEGRATION)("ledger immutability (AC-12)", () => {
  let pool: Pool;
  let accounts: SystemAccounts;

  beforeAll(async () => {
    pool = createTestPool();
    await resetSchema(pool);
    accounts = await systemAccountIds(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("rejects UPDATE and DELETE on ledger_entries", async () => {
    const client = await pool.connect();
    let entryId: string;
    try {
      await client.query("BEGIN");
      const t = await client.query<{ id: string }>(
        `INSERT INTO transfers (type, status, amount, from_account_id, to_account_id)
         VALUES ('top_up', 'COMPLETED', 500, $1, $2) RETURNING id`,
        [accounts.cashIn, accounts.cashOut],
      );
      const transferId = t.rows[0]!.id;
      const e = await client.query<{ id: string }>(
        `INSERT INTO ledger_entries (transfer_id, account_id, direction, amount)
         VALUES ($1, $2, 'debit', 500), ($1, $3, 'credit', 500)
         RETURNING id`,
        [transferId, accounts.cashIn, accounts.cashOut],
      );
      entryId = e.rows[0]!.id;
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    await expect(
      pool.query(`UPDATE ledger_entries SET amount = 1 WHERE id = $1`, [entryId]),
    ).rejects.toThrow(/insert-only/i);

    await expect(
      pool.query(`DELETE FROM ledger_entries WHERE id = $1`, [entryId]),
    ).rejects.toThrow(/insert-only/i);
  });

  it("rejects an unbalanced transfer at COMMIT via the deferred trigger", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const t = await client.query<{ id: string }>(
        `INSERT INTO transfers (type, status, amount, from_account_id, to_account_id)
         VALUES ('top_up', 'COMPLETED', 700, $1, $2) RETURNING id`,
        [accounts.cashIn, accounts.cashOut],
      );
      const transferId = t.rows[0]!.id;
      // A lone debit with no matching credit: allowed transiently (deferred),
      // must fail at COMMIT.
      await client.query(
        `INSERT INTO ledger_entries (transfer_id, account_id, direction, amount)
         VALUES ($1, $2, 'debit', 700)`,
        [transferId, accounts.cashIn],
      );
      await expect(client.query("COMMIT")).rejects.toThrow(/unbalanced/i);
    } finally {
      // The failed COMMIT already ended the transaction; ensure a clean state.
      try {
        await client.query("ROLLBACK");
      } catch {
        // no active transaction after a failed COMMIT; ignore
      }
      client.release();
    }
  });
});
