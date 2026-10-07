import { Router } from "express";
import type { Pool } from "pg";
import { serializeAmount } from "../../money/money.js";
import { createUser } from "../../services/userService.js";
import { createWallet } from "../../services/walletService.js";
import {
  createUserSchema,
  createWalletSchema,
  idParamSchema,
  parseOrThrow,
} from "../validation.js";

/**
 * User routes (design §8):
 *   POST /users               -> create a user (idempotency-exempt; no money)
 *   POST /users/{id}/wallets  -> create a user wallet (idempotency-exempt)
 * Both responses carry request_id and serialize money as strings.
 */
export function usersRouter(pool: Pool): Router {
  const router = Router();

  router.post("/users", async (req, res, next) => {
    try {
      const input = parseOrThrow(createUserSchema, req.body);
      const user = await createUser(pool, input);
      res.status(201).json({
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        kyc_status: user.kyc_status,
        request_id: req.request_id,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/users/:id/wallets", async (req, res, next) => {
    try {
      const { id } = parseOrThrow(idParamSchema, req.params);
      // Body currency must equal INR (validated, mapped to UNSUPPORTED_CURRENCY).
      parseOrThrow(createWalletSchema, req.body);
      const wallet = await createWallet(pool, id);
      res.status(201).json({
        id: wallet.id,
        user_id: wallet.user_id,
        currency: wallet.currency,
        balance: serializeAmount(BigInt(wallet.balance)),
        request_id: req.request_id,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
