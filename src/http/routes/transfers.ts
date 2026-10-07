import { Router } from "express";
import type { Pool } from "pg";
import { executeTransfer } from "../../services/transferService.js";
import { getAccount } from "../../services/walletService.js";
import { AppError } from "../errors.js";
import { parseOrThrow, transferSchema } from "../validation.js";

/**
 * Transfer route (design §8):
 *   POST /transfers -> peer transfer (wallet -> wallet), status may be HELD.
 *
 * Money-mutating POST; FEAT-004 adds the Idempotency-Key requirement + replay.
 * The acting user (for audit / idempotency scope) is the owner of
 * `from_wallet_id` (design §9.1 / §11). Both sides must be USER wallets.
 */
export function transfersRouter(pool: Pool): Router {
  const router = Router();

  router.post("/transfers", async (req, res, next) => {
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

      const result = await executeTransfer(pool, {
        type: "peer_transfer",
        fromAccountId: input.from_wallet_id,
        toAccountId: input.to_wallet_id,
        amount: input.amount,
        note: input.note,
        actor: source.user_id,
      });

      res.status(201).json({
        transfer_id: result.transfer_id,
        status: result.status,
        type: result.type,
        amount: result.amount,
        fee: result.fee,
        wallet_balance: result.wallet_balance,
        request_id: req.request_id,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
