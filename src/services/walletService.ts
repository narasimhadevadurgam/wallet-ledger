import type { Pool, PoolClient } from "pg";
import { query } from "../db/query.js";
import { AppError } from "../http/errors.js";

/** An accounts row as the money path needs it (balance stays a string from pg). */
export interface AccountRecord {
  id: string;
  user_id: string | null;
  is_system: boolean;
  system_type: string | null;
  currency: string;
  balance: string;
}

export interface WalletCreated {
  id: string;
  user_id: string;
  currency: string;
  balance: string;
}

/**
 * Create a user wallet account: is_system=false, currency INR, balance 0,
 * owned by `userId`. Rejects NOT_FOUND if the user does not exist (the FK would
 * also reject, but we check first for a clean 404 and message).
 */
export async function createWallet(pool: Pool, userId: bigint): Promise<WalletCreated> {
  const user = await query(pool, "SELECT id FROM users WHERE id = $1", [userId.toString()]);
  if (user.rowCount === 0) {
    throw new AppError("NOT_FOUND", `user ${userId} not found`);
  }
  const result = await query<WalletCreated>(
    pool,
    `INSERT INTO accounts (user_id, is_system, system_type, currency, balance)
     VALUES ($1, false, NULL, 'INR', 0)
     RETURNING id, user_id, currency, balance`,
    [userId.toString()],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError("INTERNAL", "wallet insert returned no row");
  }
  return row;
}

/** Resolve an account by id (pool), 404 if absent. Used by balance reads. */
export async function getAccount(pool: Pool, accountId: bigint): Promise<AccountRecord> {
  const result = await query<AccountRecord>(
    pool,
    `SELECT id, user_id, is_system, system_type, currency, balance
     FROM accounts WHERE id = $1`,
    [accountId.toString()],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError("NOT_FOUND", `wallet ${accountId} not found`);
  }
  return row;
}

/**
 * Resolve an account by id ON a transaction client (no lock) — used inside the
 * transfer transaction to resolve/validate the path wallet and counterparties
 * before the FOR UPDATE lock step. 404 if absent.
 */
export async function getAccountOnClient(
  client: PoolClient,
  accountId: bigint,
): Promise<AccountRecord> {
  const result = await client.query<AccountRecord>(
    `SELECT id, user_id, is_system, system_type, currency, balance
     FROM accounts WHERE id = $1`,
    [accountId.toString()],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError("NOT_FOUND", `wallet ${accountId} not found`);
  }
  return row;
}

/**
 * Resolve the single system account of a given type (cash_in/cash_out/
 * fee_revenue) on a transaction client. These are seeded by migration 0015, so
 * absence is an INTERNAL misconfiguration, not a client NOT_FOUND.
 */
export async function getSystemAccount(
  client: PoolClient,
  systemType: "cash_in" | "cash_out" | "fee_revenue",
): Promise<AccountRecord> {
  const result = await client.query<AccountRecord>(
    `SELECT id, user_id, is_system, system_type, currency, balance
     FROM accounts WHERE is_system = true AND system_type = $1`,
    [systemType],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError("INTERNAL", `system account ${systemType} is not seeded`);
  }
  return row;
}
