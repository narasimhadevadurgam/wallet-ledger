import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/query.js";
import { AppError } from "../http/errors.js";
import { serializeAmount } from "../money/money.js";
import { writeTransferAudit } from "./auditService.js";
import { evaluateRisk, writeRiskFlag } from "./riskService.js";
import {
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
 *   - FEAT-004 (idempotency, design §9.1 step 3 / §11): LIVE. When the optional
 *     `idempotency` field on TransferContext is set, the key is inserted FIRST
 *     inside the txn (`insertIdempotencyKeyFirst`); a same-key replay is
 *     detected SOLELY by the UNIQUE(user_id,key) violation (never by SELECTing
 *     an in_progress key), the committed response is replayed byte-for-byte, a
 *     body-hash mismatch → 422, and a rolled-back first attempt persists no key
 *     so a retry re-executes (Case 2). The field stays optional so non-money
 *     callers (none today) can still execute without a key.
 *   - FEAT-005 (fraud, design §9.1 step 6): the seam `evaluateFraud` runs AFTER
 *     the funds check and BEFORE ledger writes, under the FOR UPDATE locks, and
 *     may return a HELD outcome (commit with no ledger entries) or a flag.
 *     Today it is a no-op that always returns `{ decision: "proceed" }`.
 */

export type TransferType = "top_up" | "peer_transfer" | "withdrawal";

/**
 * The HTTP response a money route would send for a freshly-executed transfer:
 * the status code and the exact JSON body. This is what gets persisted on the
 * idempotency key at step 11 and replayed byte-for-byte on a later same-key
 * request (design §11.2). `body` is a plain JSON-serializable object (money as
 * strings already).
 */
export interface TransferResponse {
  code: number;
  body: Record<string, unknown>;
}

/**
 * Idempotency context (design §9.1 step 3 / §11). When present, the key is
 * inserted FIRST inside the transfer transaction and a replay is detected
 * SOLELY by the `UNIQUE(user_id, key)` violation — no code path ever SELECTs an
 * `in_progress` key to branch on (design §11.2 invariant).
 *
 *   - `userId`  — the owning user whose keyspace the key lives in (design §11:
 *                 owner of `from_wallet_id` for a peer transfer; the path
 *                 wallet's `accounts.user_id` for top-up/withdraw).
 *   - `key`     — the client UUID from the `Idempotency-Key` header.
 *   - `bodyHash`— SHA-256 of the canonicalized body (design §11.1).
 *   - `buildResponse` — maps the executed result to the exact `{ code, body }`
 *                 the route will send; stored at step 11 so replays return it
 *                 byte-for-byte.
 */
export interface IdempotencyContext {
  userId: bigint;
  key: string;
  bodyHash: string;
  buildResponse: (result: TransferResult) => TransferResponse;
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

/**
 * What `executeTransfer` hands back to a money route. Either the transfer ran
 * fresh (`executed`, carrying the computed `result` and the `response` the
 * route should send and which was persisted on the key), or a same-key replay
 * was detected and the saved `response` is returned byte-for-byte with no money
 * moved (`replay`). When no idempotency context is supplied only `executed` is
 * possible and `response` is undefined (the route serializes `result` itself).
 */
export type TransferOutcome =
  | { kind: "executed"; result: TransferResult; response?: TransferResponse }
  | { kind: "replay"; response: TransferResponse };

/** Postgres SQLSTATE for a unique-violation (the UNIQUE(user_id,key) conflict). */
const UNIQUE_VIOLATION = "23505";

/**
 * Internal sentinel thrown by `insertIdempotencyKeyFirst` when the step-3 INSERT
 * hits the `UNIQUE(user_id, key)` violation. It aborts the transfer transaction
 * (so NO money moves and, per Case 2, an uncommitted key disappears) and is
 * caught by `executeTransfer` AFTER the rollback, which then resolves the replay
 * against the COMMITTED key row read on the pool. This is the ONLY replay
 * trigger — no code path SELECTs an `in_progress` key to branch on (§11.2).
 */
class IdempotencyConflict extends Error {
  constructor() {
    super("idempotency key conflict");
    this.name = "IdempotencyConflict";
  }
}

/** Narrow an unknown thrown value to a pg error carrying a SQLSTATE `code`. */
function pgErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * STEP 3 (design §9.1 / §11): insert the idempotency key FIRST, as the very
 * first in-transaction write, with `status='in_progress'`. On the
 * `UNIQUE(user_id, key)` violation throw `IdempotencyConflict` to abort the txn
 * and route the request to the replay path. The `in_progress` row is NEVER read
 * by any other request to make a decision; replay is detected only here.
 */
async function insertIdempotencyKeyFirst(
  client: PoolClient,
  idempotency: IdempotencyContext,
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO idempotency_keys (user_id, key, body_hash, status)
       VALUES ($1, $2, $3, 'in_progress')`,
      [idempotency.userId.toString(), idempotency.key, idempotency.bodyHash],
    );
  } catch (err) {
    if (pgErrorCode(err) === UNIQUE_VIOLATION) {
      throw new IdempotencyConflict();
    }
    throw err;
  }
}

/**
 * STEP 11 (design §9.1): mark the key `completed` and persist the saved HTTP
 * status + response body (JSONB) so a later same-key request can replay them
 * byte-for-byte. Runs inside the same transaction as the money movement, so the
 * saved response and the money commit (or roll back) atomically together.
 */
async function completeIdempotencyKey(
  client: PoolClient,
  idempotency: IdempotencyContext,
  response: TransferResponse,
): Promise<void> {
  await client.query(
    `UPDATE idempotency_keys
       SET status = 'completed', response_code = $4, response_body = $5
     WHERE user_id = $1 AND key = $2 AND body_hash = $3`,
    [
      idempotency.userId.toString(),
      idempotency.key,
      idempotency.bodyHash,
      response.code,
      JSON.stringify(response.body),
    ],
  );
}

/**
 * Resolve a replay against the COMMITTED key row (design §11.2 Case 1). Read on
 * the POOL, AFTER the transfer txn rolled back on the unique violation — the
 * row that caused the conflict is committed, so there is no `in_progress` read
 * here. If the stored `body_hash` matches, return the saved `response_code` +
 * `response_body` exactly (no money moved); if it differs → `422
 * IDEMPOTENCY_BODY_MISMATCH`. A row still `in_progress` (its owner has not yet
 * committed) means the conflict came from an uncommitted insert that has since
 * been resolved; we never replay such a row — it either committed (completed,
 * handled here) or rolled back (no row, handled by Case 2 re-execute, which
 * means we would not have conflicted). We treat an absent/non-completed row as
 * a race the caller should re-execute by surfacing the original conflict.
 */
async function resolveReplay(
  pool: Pool,
  idempotency: IdempotencyContext,
): Promise<TransferResponse> {
  const result = await pool.query<{
    body_hash: string;
    status: string;
    response_code: number | null;
    response_body: Record<string, unknown> | null;
  }>(
    `SELECT body_hash, status, response_code, response_body
     FROM idempotency_keys
     WHERE user_id = $1 AND key = $2`,
    [idempotency.userId.toString(), idempotency.key],
  );
  const row = result.rows[0];
  if (!row || row.status !== "completed" || row.response_code === null || row.response_body === null) {
    // The conflicting row was not a committed outcome by the time we read it.
    // Re-execute from scratch (Case 2): a transient conflict with a key that
    // ultimately did not persist a response must not poison the client's retry.
    throw new IdempotencyConflict();
  }
  if (row.body_hash !== idempotency.bodyHash) {
    throw new AppError(
      "IDEMPOTENCY_BODY_MISMATCH",
      "the Idempotency-Key was already used with a different request body",
    );
  }
  return { code: row.response_code, body: row.response_body };
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
 * Upper bound on re-execution after a transient idempotency conflict (design
 * §11.2 Case 2 / the x10-parallel case). Each re-execution happens only when a
 * conflicting key did NOT persist a committed response (the winner rolled back),
 * so progress is guaranteed; the bound is a safety net against a pathological
 * churn, not expected to be reached in practice.
 */
const MAX_IDEMPOTENCY_ATTEMPTS = 50;

/**
 * Execute a transfer per design §9.1. When `ctx.idempotency` is set the key is
 * inserted FIRST (step 3) and a same-key replay is detected SOLELY by the
 * `UNIQUE(user_id, key)` violation (§11.2) — never by SELECTing an in_progress
 * key. Returns a `TransferOutcome`: an `executed` fresh run (carrying the
 * computed result and the persisted response) or a `replay` of the committed
 * saved response, byte-for-byte, with no money moved. Fee applies to
 * peer_transfer only (design §9.1.2); top_up/withdrawal carry no fee.
 */
export async function executeTransfer(
  pool: Pool,
  ctx: TransferContext,
): Promise<TransferOutcome> {
  for (let attempt = 0; attempt < MAX_IDEMPOTENCY_ATTEMPTS; attempt++) {
    try {
      return await runTransferTxn(pool, ctx);
    } catch (err) {
      if (err instanceof IdempotencyConflict && ctx.idempotency) {
        // The step-3 INSERT hit UNIQUE(user_id, key); the txn has rolled back
        // (no money moved, no key persisted by THIS attempt). Resolve against
        // the COMMITTED conflicting row on the pool. A completed row → replay
        // (or 422 on body mismatch); a non-committed row (winner rolled back,
        // its key vanished) → resolveReplay re-throws IdempotencyConflict so we
        // loop and re-execute from scratch (Case 2).
        const response = await resolveReplay(pool, ctx.idempotency);
        return { kind: "replay", response };
      }
      throw err;
    }
  }
  // Exhausted re-executions without ever committing or finding a completed row.
  throw new AppError(
    "INTERNAL",
    "idempotency key conflict could not be resolved after repeated retries",
  );
}

/** One attempt: the single §9.1 transfer transaction at READ COMMITTED. */
async function runTransferTxn(
  pool: Pool,
  ctx: TransferContext,
): Promise<TransferOutcome> {
  return withTransaction(
    pool,
    async (client): Promise<TransferOutcome> => {
      // --- STEP 3: insert idempotency key FIRST (design §9.1 step 3 / §11) ---
      // On the UNIQUE(user_id,key) violation this throws IdempotencyConflict,
      // aborting the txn before any money moves (replay handled post-rollback).
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

      // --- STEP 6 (design §9.1 step 6 / §14): fraud rules under lock, post-funds ---
      // Rules are evaluated AFTER the funds check and BEFORE any ledger write,
      // with both account rows held FOR UPDATE. The source account funds the
      // outflow, so it is the wallet the velocity / rapid-drain rules observe.
      const risk = await evaluateRisk(client, {
        sourceAccountId: ctx.fromAccountId,
        amount: ctx.amount,
      });
      if (risk.decision === "hold") {
        // A fired 'hold' rule: write the transfer HELD, record the risk flag,
        // audit NULL->HELD, and COMMIT with NO ledger entries / NO balance
        // change (design §9.1 step 6 / §9.1.1). Money moves only on release.
        const transferId = await insertTransfer(client, ctx, "HELD");
        await writeRiskFlag(client, transferId, risk.ruleName);
        await writeTransferAudit(client, {
          transferId,
          oldStatus: null,
          newStatus: "HELD",
          actor: ctx.actor,
        });
        const result: TransferResult = {
          transfer_id: transferId.toString(),
          status: "HELD",
          type: ctx.type,
          amount: serializeAmount(ctx.amount),
          fee: serializeAmount(fee),
          wallet_balance: actingBalanceString(ctx, source, dest, 0n, 0n),
        };
        return finishTransfer(client, ctx, result);
      }

      // --- STEP 7: insert the transfers row (COMPLETED) ---
      const transferId = await insertTransfer(client, ctx, "COMPLETED");

      // A fired 'flag' rule (allow-with-flag): record each flag against the now
      // -created transfer and PROCEED to move money (design §9.1 step 6).
      for (const ruleName of risk.flagged) {
        await writeRiskFlag(client, transferId, ruleName);
      }

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

      // --- STEP 11: mark idempotency key completed with the saved response ---
      // --- STEP 12: COMMIT (handled by withTransaction) ---
      const result: TransferResult = {
        transfer_id: transferId.toString(),
        status: "COMPLETED",
        type: ctx.type,
        amount: serializeAmount(ctx.amount),
        fee: serializeAmount(fee),
        wallet_balance: actingBalanceString(ctx, source, dest, outflow, ctx.amount),
      };
      return finishTransfer(client, ctx, result);
    },
    { isolationLevel: "READ COMMITTED" },
  );
}

/**
 * STEP 11 tail: build the route's response from the result, persist it on the
 * key (when idempotent) so later replays return it byte-for-byte, and hand the
 * `executed` outcome back. When there is no idempotency context the response is
 * left to the route (returned undefined) and no key is written.
 */
async function finishTransfer(
  client: PoolClient,
  ctx: TransferContext,
  result: TransferResult,
): Promise<TransferOutcome> {
  if (!ctx.idempotency) {
    return { kind: "executed", result };
  }
  const response = ctx.idempotency.buildResponse(result);
  await completeIdempotencyKey(client, ctx.idempotency, response);
  return { kind: "executed", result, response };
}

/** A HELD transfers row as the release path reads it (money as strings from pg). */
interface HeldTransferRow {
  id: string;
  type: TransferType | "reversal";
  status: string;
  amount: string;
  from_account_id: string;
  to_account_id: string;
}

/** The successful release result returned to the admin route. */
export interface ReleaseResult {
  transfer_id: string;
  status: "COMPLETED";
  type: string;
  amount: string;
  fee: string;
  /** The sender wallet's balance after the release, as a string. */
  wallet_balance: string;
}

/**
 * Release a HELD transfer (design §9.1.1, FR-12). ONE transaction at READ
 * COMMITTED that:
 *   1. locks the HELD transfer row AND both its accounts FOR UPDATE, ascending
 *      by account id (the same deadlock-avoidance order as the money path);
 *   2. 409 TRANSFER_NOT_HELD if the transfer is not currently HELD (covers the
 *      not-found, already-released, and second-call cases);
 *   3. re-reads balances under lock and re-checks funds (balance >= amount +
 *      fee). If insufficient, transitions HELD->FAILED, audits, and throws
 *      422 INSUFFICIENT_FUNDS (the transfer stays FAILED — the only FAILED path);
 *   4. otherwise inserts the balanced ledger entries, updates stored balances
 *      (exactly as the money path steps 8-9), transitions HELD->COMPLETED,
 *      audits, and commits.
 *
 * Idempotency-exempt: a second call sees a non-HELD row and 409s.
 */
export async function releaseTransfer(
  pool: Pool,
  transferId: bigint,
  actor: string,
): Promise<ReleaseResult> {
  return withTransaction(
    pool,
    async (client): Promise<ReleaseResult> => {
      // --- 1a: lock the transfer row FOR UPDATE ---
      const txResult = await client.query<HeldTransferRow>(
        `SELECT id, type, status, amount, from_account_id, to_account_id
         FROM transfers WHERE id = $1 FOR UPDATE`,
        [transferId.toString()],
      );
      const transfer = txResult.rows[0];
      // --- 2: must still be HELD (not-found / already-released -> 409) ---
      if (!transfer || transfer.status !== "HELD") {
        throw new AppError(
          "TRANSFER_NOT_HELD",
          `transfer ${transferId} is not in a releasable HELD state`,
        );
      }

      const fromId = BigInt(transfer.from_account_id);
      const toId = BigInt(transfer.to_account_id);
      const amount = BigInt(transfer.amount);

      // --- 1b: lock both accounts ascending by id (deadlock-avoidance order) ---
      const locked = await lockAccountsAscending(client, [fromId, toId]);
      const source = locked.get(fromId.toString());
      const dest = locked.get(toId.toString());
      if (!source || !dest) {
        throw new AppError("INTERNAL", `release: account rows missing for transfer ${transferId}`);
      }

      // Fee is recomputed from current config, as at hold time, for peer transfers.
      const fee = transfer.type === "peer_transfer" ? await readFeePaise(client) : 0n;
      const outflow = amount + fee;

      // --- 3: re-check funds under lock; insufficient -> HELD->FAILED + 422 ---
      const sourceBalance = BigInt(source.balance);
      if (!source.is_system && sourceBalance < outflow) {
        await client.query(
          `UPDATE transfers SET status = 'FAILED' WHERE id = $1`,
          [transferId.toString()],
        );
        await writeTransferAudit(client, {
          transferId,
          oldStatus: "HELD",
          newStatus: "FAILED",
          actor,
        });
        throw new AppError(
          "INSUFFICIENT_FUNDS",
          `insufficient funds to release transfer ${transferId}: balance ${source.balance} < required ${outflow.toString()}`,
        );
      }

      // --- 4: balanced ledger entries + stored balances (as money path 8-9) ---
      await insertLedgerEntry(client, transferId, fromId, "debit", amount);
      await insertLedgerEntry(client, transferId, toId, "credit", amount);
      let feeRevenueId: bigint | null = null;
      if (fee > 0n) {
        const feeRevenue = await getSystemAccount(client, "fee_revenue");
        feeRevenueId = BigInt(feeRevenue.id);
        await insertLedgerEntry(client, transferId, fromId, "debit", fee);
        await insertLedgerEntry(client, transferId, feeRevenueId, "credit", fee);
      }
      await adjustBalance(client, fromId, -outflow);
      await adjustBalance(client, toId, amount);
      if (fee > 0n && feeRevenueId !== null) {
        await adjustBalance(client, feeRevenueId, fee);
      }

      // --- transition HELD -> COMPLETED, audit, commit ---
      await client.query(
        `UPDATE transfers SET status = 'COMPLETED' WHERE id = $1`,
        [transferId.toString()],
      );
      await writeTransferAudit(client, {
        transferId,
        oldStatus: "HELD",
        newStatus: "COMPLETED",
        actor,
      });

      return {
        transfer_id: transferId.toString(),
        status: "COMPLETED",
        type: transfer.type,
        amount: serializeAmount(amount),
        fee: serializeAmount(fee),
        wallet_balance: (sourceBalance - outflow).toString(),
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
