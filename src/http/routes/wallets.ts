import { Router } from "express";
import type { Pool } from "pg";
import { serializeAmount } from "../../money/money.js";
import {
  executeTransfer,
  type TransferResult,
} from "../../services/transferService.js";
import { getAccount } from "../../services/walletService.js";
import { query } from "../../db/query.js";
import { AppError } from "../errors.js";
import { requireIdempotency } from "../idempotency.js";
import { amountBodySchema, idParamSchema, parseOrThrow } from "../validation.js";

/**
 * Wallet routes (design §8):
 *   POST /wallets/{id}/top-up   -> cash_in -> wallet
 *   POST /wallets/{id}/withdraw -> wallet -> cash_out
 *   GET  /wallets/{id}/balance  -> stored balance
 *
 * top-up/withdraw are money-mutating POSTs and REQUIRE a valid UUID
 * `Idempotency-Key` header (design §8/§11): the `requireIdempotency` middleware
 * rejects a missing/invalid key with `400 MISSING_IDEMPOTENCY_KEY` BEFORE any
 * DB work, computes the body hash, and transferService inserts the key first
 * inside the txn. The path wallet must be a USER wallet; a system account path
 * wallet is rejected (design §9.1 step 3) and no key is inserted. The key owner
 * (`user_id` for the §11 keyspace) is the path wallet's owner.
 */
export function walletsRouter(pool: Pool): Router {
  const router = Router();

  router.post("/wallets/:id/top-up", requireIdempotency, async (req, res, next) => {
    try {
      const { id } = parseOrThrow(idParamSchema, req.params);
      const { amount } = parseOrThrow(amountBodySchema, req.body);
      const wallet = await resolveUserWallet(pool, id);
      const cashIn = await getSystemAccountId(pool, "cash_in");

      const requestId = req.request_id;
      const outcome = await executeTransfer(pool, {
        type: "top_up",
        fromAccountId: cashIn,
        toAccountId: id,
        amount,
        actor: wallet.user_id,
        idempotency: {
          userId: BigInt(wallet.user_id),
          key: req.idempotency!.key,
          bodyHash: req.idempotency!.bodyHash,
          buildResponse: (result) => ({
            code: 201,
            body: walletTransferBody(result, requestId),
          }),
        },
      });

      sendOutcome(res, outcome, requestId);
    } catch (err) {
      next(err);
    }
  });

  router.post("/wallets/:id/withdraw", requireIdempotency, async (req, res, next) => {
    try {
      const { id } = parseOrThrow(idParamSchema, req.params);
      const { amount } = parseOrThrow(amountBodySchema, req.body);
      const wallet = await resolveUserWallet(pool, id);
      const cashOut = await getSystemAccountId(pool, "cash_out");

      const requestId = req.request_id;
      const outcome = await executeTransfer(pool, {
        type: "withdrawal",
        fromAccountId: id,
        toAccountId: cashOut,
        amount,
        actor: wallet.user_id,
        idempotency: {
          userId: BigInt(wallet.user_id),
          key: req.idempotency!.key,
          bodyHash: req.idempotency!.bodyHash,
          buildResponse: (result) => ({
            code: 201,
            body: walletTransferBody(result, requestId),
          }),
        },
      });

      sendOutcome(res, outcome, requestId);
    } catch (err) {
      next(err);
    }
  });

  router.get("/wallets/:id/balance", async (req, res, next) => {
    try {
      const { id } = parseOrThrow(idParamSchema, req.params);
      const account = await getAccount(pool, id);
      res.status(200).json({
        wallet_id: account.id,
        balance: serializeAmount(BigInt(account.balance)),
        request_id: req.request_id,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** The 201 body for a top-up/withdraw (money as strings; carries request_id). */
function walletTransferBody(
  result: TransferResult,
  requestId: string,
): Record<string, unknown> {
  return {
    transfer_id: result.transfer_id,
    status: result.status,
    wallet_balance: result.wallet_balance,
    request_id: requestId,
  };
}

/**
 * Send a transfer outcome. For a fresh `executed` run and a `replay` the
 * response was built (and, for a replay, saved) inside transferService; we send
 * it verbatim so a replay is byte-identical to the original (design §11.2).
 */
function sendOutcome(
  res: import("express").Response,
  outcome: Awaited<ReturnType<typeof executeTransfer>>,
  requestId: string,
): void {
  if (outcome.response) {
    res.status(outcome.response.code).json(outcome.response.body);
    return;
  }
  // Reached only for an `executed` outcome without a stored response (no
  // idempotency context — not reachable from the money routes, which always
  // supply one). Serialize the result with this request_id.
  if (outcome.kind === "executed") {
    res.status(201).json(walletTransferBody(outcome.result, requestId));
  }
}

/**
 * Resolve a path wallet, requiring it to be a USER wallet. A system account on
 * a `/wallets/{id}/...` money path is a client error (design §9.1 step 3).
 */
async function resolveUserWallet(pool: Pool, id: bigint): Promise<{ user_id: string }> {
  const account = await getAccount(pool, id);
  if (account.is_system || account.user_id === null) {
    throw new AppError("NOT_FOUND", `wallet ${id} is not a user wallet`);
  }
  return { user_id: account.user_id };
}

/** Resolve a system account id by type from the pool (seeded by migration 0015). */
async function getSystemAccountId(
  pool: Pool,
  systemType: "cash_in" | "cash_out",
): Promise<bigint> {
  const result = await query<{ id: string }>(
    pool,
    "SELECT id FROM accounts WHERE is_system = true AND system_type = $1",
    [systemType],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError("INTERNAL", `system account ${systemType} is not seeded`);
  }
  return BigInt(row.id);
}
