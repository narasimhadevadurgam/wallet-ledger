import { Router } from "express";
import type { Pool } from "pg";
import {
  executeTransfer,
  type TransferResult,
} from "../../services/transferService.js";
import { getAccount } from "../../services/walletService.js";
import { AppError } from "../errors.js";
import { requireIdempotency } from "../idempotency.js";
import { parseOrThrow, transferSchema } from "../validation.js";

/**
 * Transfer route (design §8):
 *   POST /transfers -> peer transfer (wallet -> wallet), status may be HELD.
 *
 * Money-mutating POST: REQUIRES a valid UUID `Idempotency-Key` header. The
 * `requireIdempotency` middleware rejects a missing/invalid key with
 * `400 MISSING_IDEMPOTENCY_KEY` before any DB work and computes the body hash;
 * transferService inserts the key first and detects replay by the unique
 * violation (§11). The acting user and the §11 keyspace owner is the owner of
 * `from_wallet_id` (design §9.1 / §11). Both sides must be USER wallets.
 */
export function transfersRouter(pool: Pool): Router {
  const router = Router();

  router.post("/transfers", requireIdempotency, async (req, res, next) => {
    try {
      const input = parseOrThrow(transferSchema, req.body);

      const source = await getAccount(pool, input.from_wallet_id);
      if (source.is_system || source.user_id === null) {
        throw new AppError("NOT_FOUND", `wallet ${input.from_wallet_id} is not a user wallet`);
      }
      const dest = await getAccount(pool, input.to_wallet_id);
      if (dest.is_system || dest.user_id === null) {
        throw new AppError("NOT_FOUND", `wallet ${input.to_wallet_id} is not a user wallet`);
      }

      const requestId = req.request_id;
      const ownerUserId = source.user_id;
      const outcome = await executeTransfer(pool, {
        type: "peer_transfer",
        fromAccountId: input.from_wallet_id,
        toAccountId: input.to_wallet_id,
        amount: input.amount,
        note: input.note,
        actor: ownerUserId,
        idempotency: {
          userId: BigInt(ownerUserId),
          key: req.idempotency!.key,
          bodyHash: req.idempotency!.bodyHash,
          buildResponse: (result) => ({
            code: 201,
            body: JSON.stringify(transferBody(result, requestId)),
          }),
        },
      });

      if (outcome.response) {
        // Send the EXACT stored bytes (built on execute, read verbatim on a
        // replay) so a replay is byte-identical to the first response (§11.2).
        res
          .status(outcome.response.code)
          .type("application/json")
          .send(outcome.response.body);
      } else if (outcome.kind === "executed") {
        res.status(201).json(transferBody(outcome.result, requestId));
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** The 201 body for a peer transfer (money as strings; carries request_id). */
function transferBody(
  result: TransferResult,
  requestId: string,
): Record<string, unknown> {
  return {
    transfer_id: result.transfer_id,
    status: result.status,
    type: result.type,
    amount: result.amount,
    fee: result.fee,
    wallet_balance: result.wallet_balance,
    request_id: requestId,
  };
}
