import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { SKIP_INTEGRATION, createTestPool, resetSchema } from "./helpers.js";

/**
 * AC-13: the non-negative balance constraint.
 *   - A non-system (user) wallet cannot be driven negative:
 *     CHECK (is_system OR balance >= 0) raises.
 *   - A system account MAY go negative (the same CHECK exempts is_system rows).
 *
 * Uses a throwaway user + wallet (unique email/phone per run) for the user
 * case, and the seeded cash_in system account for the system case.
 */

describe.skipIf(SKIP_INTEGRATION)("balance constraints (AC-13)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createTestPool();
    await resetSchema(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("rejects driving a non-system wallet negative", async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (name, email, phone, kyc_status)
       VALUES ('Constraint Test', $1, $2, 'verified') RETURNING id`,
      [`constraints.${suffix}@example.com`, `+99${suffix.replace(/\D/g, "").slice(0, 12)}`],
    );
    const userId = user.rows[0]!.id;
    const wallet = await pool.query<{ id: string }>(
      `INSERT INTO accounts (user_id, is_system, system_type, currency, balance)
       VALUES ($1, false, NULL, 'INR', 100) RETURNING id`,
      [userId],
    );
    const walletId = wallet.rows[0]!.id;

    await expect(
      pool.query(`UPDATE accounts SET balance = -1 WHERE id = $1`, [walletId]),
    ).rejects.toThrow();
  });

  it("allows a system account to go negative", async () => {
    const cashIn = await pool.query<{ id: string }>(
      `SELECT id FROM accounts WHERE is_system = true AND system_type = 'cash_in'`,
    );
    const cashInId = cashIn.rows[0]!.id;

    // Should NOT throw; system accounts are exempt from the non-negative CHECK.
    await pool.query(`UPDATE accounts SET balance = -500 WHERE id = $1`, [
      cashInId,
    ]);
    const after = await pool.query<{ balance: string }>(
      `SELECT balance FROM accounts WHERE id = $1`,
      [cashInId],
    );
    expect(after.rows[0]?.balance).toBe("-500");

    // Restore to zero so a shared DB stays at its seeded baseline.
    await pool.query(`UPDATE accounts SET balance = 0 WHERE id = $1`, [
      cashInId,
    ]);
  });
});
