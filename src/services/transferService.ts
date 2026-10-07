import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/query.js";
import { AppError } from "../http/errors.js";
import { serializeAmount } from "../money/money.js";
import { writeTransferAudit } from "./auditService.js";
import {
  getAccountOnClient,
  getSystemAccount,
  type AccountRecord,
} from "./walletService.js";

/**
 * THE money path (design §9.1). All three client flows — top_up, peer_transfer,
 * withdrawal — are ONE `withTransaction` at READ COMMITTED. The row locks
 * (`SELECT ... FOR UPDATE` on both accounts in ascending id order) provide the
 * serialization; see design §9.2. This module is the ONLY place (besides
 * reconciliation) that manages a transaction and locks explicitly.
 *
 * SEAMS for later FEATs — intentionally left as marked hooks so those FEATs
 * EXTEND this method rather than rewrite it:
 *   - FEAT-004 (idempotency, design §9.1 step 3): the `idempotency` field on
 *     TransferContext carries the resolved key + body_hash. The seam
 *     `insertIdempotencyKeyFirst` runs as the first in-transaction write; the
 *     replay path is detected ONLY by the UNIQUE(user_id,key) violation. Today
 *     the field is optional and the seam is a no-op when absent.
 *   - FEAT-005 (fraud, design §9.1 step 6): the seam `evaluateFraud` runs AFTER
 *     the funds check and BEFORE ledger writes, under the FOR UPDATE locks, and
 *     may return a HELD outcome (commit with no ledger entries) or a flag.
 *     Today it is a no-op that always returns `{ decision: "proceed" }`.
 */

export type TransferType = "top_up" | "peer_transfer" | "withdrawal";

/**
 * Idempotency context (FEAT-004 seam). When present, the key is inserted first
 * inside the transaction and replay is detected by the unique violation.
 */
export interface IdempotencyContext {
  userId: bigint;
  key: string;
  bodyHash: string;
}

export interface TransferContext {
  type: TransferType;
  /** Source account id (sender wallet, or cash_in for a top-up). */
  fromAccountId: bigint;
  /** Destination account id (recipient wallet, or cash_out for a withdrawal). */
  toAccountId: bigint;
  amount: bigint;
  note?: string | undefined;
  /** The acting user id for audit (wallet owner); null only for system-driven flows. */
  actor: string;
  /** FEAT-004 seam — see module doc. Absent until FEAT-004 wires it in. */
  idempotency?: IdempotencyContext | undefined;
}

export interface TransferResult {
  transfer_id: string;
  status: "COMPLETED" | "HELD";
  type: TransferType;
  amount: string;
  fee: string;
  /** The acting (path/sender) wallet's balance after the transfer, as a string. */
  wallet_balance: string;
}

/** The fraud-seam outcome. FEAT-005 fills in HELD / flag; today always proceed. */
type FraudDecision =
  | { decision: "proceed" }
  | { decision: "hold"; ruleName: string };

/**
 * FEAT-004 SEAM. Insert the idempotency key FIRST (design §9.1 step 3) and
 * detect replay by the UNIQUE(user_id,key) violation. No-op until FEAT-004
 * populates `ctx.idempotency`. FEAT-004 replaces the body of this function; the
 * call site below does not move.
 */
async function insertIdempotencyKeyFirst(
  _client: PoolClient,
  _idempotency: IdempotencyContext,
): Promise<void> {
  // FEAT-004: INSERT INTO idempotency_keys(user_id,key,body_hash,status)
  //           VALUES (u,k,hash,'in_progress'); on 23505 -> replay path.
  // Intentionally a no-op seam for FEAT-003.
}

/**
 * FEAT-005 SEAM. Evaluate fraud rules inside the txn, under the FOR UPDATE
 * locks, AFTER the funds check and BEFORE any ledger write (design §9.1 step 6).
 * No-op until FEAT-005: always proceeds. FEAT-005 replaces the body; the call
 * site below does not move.
 */
async function evaluateFraud(
  _client: PoolClient,
  _ctx: TransferContext,
  _fee: bigint,
): Promise<FraudDecision> {
  // FEAT-005: load enabled risk_rules, evaluate each predicate under lock;
  // 'hold' rule -> return { decision: 'hold', ruleName }; 'flag' -> record and proceed.
  return { decision: "proceed" };
}

/** Read the configured flat fee (paise) from the config table; defaults to 0. */
async function readFeePaise(client: PoolClient): Promise<bigint> {
  const result = await client.query<{ value: string }>(
    "SELECT value FROM config WHERE key = 'fee_paise'",
  );
  const row = result.rows[0];
  if (!row) return 0n;
  try {
    return BigInt(row.value);
  } catch {
    return 0n;
  }
}

/**
 * Lock both accounts in ascending id order and return them keyed by id.
 * Ordering is the deadlock-avoidance guarantee (design §9.1 step 4): all
 * transfers acquire locks in the same global order.
 */
async function lockAccountsAscending(
  client: PoolClient,
  ids: bigint[],
): Promise<Map<string, AccountRecord>> {
  const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const result = await client.query<AccountRecord>(
    `SELECT id, user_id, is_system, system_type, currency, balance
     FROM accounts
     WHERE id = ANY($1)
     ORDER BY id
     FOR UPDATE`,
    [sorted.map((v) => v.toString())],
  );
  const map = new Map<string, AccountRecord>();
  for (const row of result.rows) {
    map.set(row.id, row);
  }
  return map;
}

/**
 * Execute a transfer per design §9.1. Returns a result object the routes
 * serialize (money as strings). Fee applies to peer_transfer only (design
 * §9.1.2); top_up/withdrawal carry no fee.
 */
export async function executeTransfer(
  pool: Pool,
  ctx: TransferContext,
): Promise<TransferResult> {
  return withTransaction(
    pool,
    async (client) => {
      // --- STEP 3 (FEAT-004 seam): insert idempotency key first ---
      if (ctx.idempotency) {
        await insertIdempotencyKeyFirst(client, ctx.idempotency);
      }

      // Fee only applies to peer transfers; it is always charged to the sender.
      const fee = ctx.type === "peer_transfer" ? await readFeePaise(client) : 0n;

      // --- STEP 4: lock both accounts in ascending id order (FOR UPDATE) ---
      const locked = await lockAccountsAscending(client, [
        ctx.fromAccountId,
        ctx.toAccountId,
      ]);
      const source = locked.get(ctx.fromAccountId.toString());
      const dest = locked.get(ctx.toAccountId.toString());
      if (!source) {
        throw new AppError("NOT_FOUND", `wallet ${ctx.fromAccountId} not found`);
      }
      if (!dest) {
        throw new AppError("NOT_FOUND", `wallet ${ctx.toAccountId} not found`);
      }

      // --- STEP 5: re-read balance under lock; reject if insufficient ---
      // Source must cover the full outflow amount + fee (design §9.1.2).
      const sourceBalance = BigInt(source.balance);
      const outflow = ctx.amount + fee;
      // System source accounts (cash_in on a top-up) are exempt from the
      // non-negativity check and fund any amount.
      if (!source.is_system && sourceBalance < outflow) {
        throw new AppError(
          "INSUFFICIENT_FUNDS",
          `insufficient funds: balance ${source.balance} < required ${outflow.toString()}`,
        );
      }

      // --- STEP 6 (FEAT-005 seam): fraud evaluation under lock, post-funds ---
      const fraud = await evaluateFraud(client, ctx, fee);
      if (fraud.decision === "hold") {
        // FEAT-005 completes this branch (write risk_flags, commit with no
        // ledger entries). The structural shape is here so FEAT-005 extends it.
        const transferId = await insertTransfer(client, ctx, "HELD");
        await writeTransferAudit(client, {
          transferId,
          oldStatus: null,
          newStatus: "HELD",
          actor: ctx.actor,
        });
        // No ledger entries, no balance change on HELD (design §9.1.1).
        return {
          transfer_id: transferId.toString(),
          status: "HELD" as const,
          type: ctx.type,
          amount: serializeAmount(ctx.amount),
          fee: serializeAmount(fee),
          wallet_balance: actingBalanceString(ctx, source, dest, 0n, 0n),
        };
      }

      // --- STEP 7: insert the transfers row (COMPLETED) ---
      const transferId = await insertTransfer(client, ctx, "COMPLETED");

      // --- STEP 8: insert balanced ledger entries ---
      // Primary pair: debit source, credit dest, for `amount`.
      await insertLedgerEntry(client, transferId, ctx.fromAccountId, "debit", ctx.amount);
      await insertLedgerEntry(client, transferId, ctx.toAccountId, "credit", ctx.amount);
      // Fee pair (peer transfer only, fee > 0): second debit on the SENDER and a
      // credit to the fee_revenue system account (design §9.1.2). The sender is
      // the source account for a peer transfer.
      let feeRevenueId: bigint | null = null;
      if (fee > 0n) {
        const feeRevenue = await getSystemAccount(client, "fee_revenue");
        feeRevenueId = BigInt(feeRevenue.id);
        await insertLedgerEntry(client, transferId, ctx.fromAccountId, "debit", fee);
        await insertLedgerEntry(client, transferId, feeRevenueId, "credit", fee);
      }

      // --- STEP 9: update stored balances ---
      await adjustBalance(client, ctx.fromAccountId, -outflow);
      await adjustBalance(client, ctx.toAccountId, ctx.amount);
      if (fee > 0n && feeRevenueId !== null) {
        await adjustBalance(client, feeRevenueId, fee);
      }

      // --- STEP 10: audit NULL -> COMPLETED ---
      await writeTransferAudit(client, {
        transferId,
        oldStatus: null,
        newStatus: "COMPLETED",
        actor: ctx.actor,
      });

      // --- STEP 11 (FEAT-004 seam): mark idempotency key completed with saved
      // response. No-op today (insertIdempotencyKeyFirst was a no-op). ---

      // --- STEP 12: COMMIT (handled by withTransaction) ---
      return {
        transfer_id: transferId.toString(),
        status: "COMPLETED" as const,
        type: ctx.type,
        amount: serializeAmount(ctx.amount),
        fee: serializeAmount(fee),
        wallet_balance: actingBalanceString(ctx, source, dest, outflow, ctx.amount),
      };
    },
    { isolationLevel: "READ COMMITTED" },
  );
}

async function insertTransfer(
  client: PoolClient,
  ctx: TransferContext,
  status: "COMPLETED" | "HELD",
): Promise<bigint> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO transfers (type, status, amount, from_account_id, to_account_id, note)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      ctx.type,
      status,
      ctx.amount.toString(),
      ctx.fromAccountId.toString(),
      ctx.toAccountId.toString(),
      ctx.note ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError("INTERNAL", "transfer insert returned no row");
  }
  return BigInt(row.id);
}

async function insertLedgerEntry(
  client: PoolClient,
  transferId: bigint,
  accountId: bigint,
  direction: "debit" | "credit",
  amount: bigint,
): Promise<void> {
  await client.query(
    `INSERT INTO ledger_entries (transfer_id, account_id, direction, amount)
     VALUES ($1, $2, $3, $4)`,
    [transferId.toString(), accountId.toString(), direction, amount.toString()],
  );
}

/** Apply a signed delta to a stored balance. The non-negative CHECK is the final guard. */
async function adjustBalance(
  client: PoolClient,
  accountId: bigint,
  delta: bigint,
): Promise<void> {
  await client.query(
    `UPDATE accounts SET balance = balance + $2 WHERE id = $1`,
    [accountId.toString(), delta.toString()],
  );
}

/**
 * Compute the acting wallet's post-transfer balance for the response. The
 * acting wallet is the path wallet for top_up (destination) and withdraw
 * (source), and the sender (source) for a peer transfer. `sourceDelta` is the
 * outflow subtracted from source; `destDelta` the amount added to dest.
 */
function actingBalanceString(
  ctx: TransferContext,
  source: AccountRecord,
  dest: AccountRecord,
  sourceDelta: bigint,
  destDelta: bigint,
): string {
  if (ctx.type === "top_up") {
    return (BigInt(dest.balance) + destDelta).toString();
  }
  // withdrawal and peer_transfer: acting wallet is the source.
  return (BigInt(source.balance) - sourceDelta).toString();
}
