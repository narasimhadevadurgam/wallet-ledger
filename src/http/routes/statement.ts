import { Router } from "express";
import type { Pool } from "pg";
import {
  getStatementCursor,
  getStatementOffset,
} from "../../services/statementService.js";
import {
  cursorQuerySchema,
  idParamSchema,
  parseOrThrow,
  statementQuerySchema,
} from "../validation.js";

/**
 * Statement routes (design §8):
 *   GET /wallets/{id}/statement?limit&offset        -> OFFSET pagination
 *   GET /wallets/{id}/statement/cursor?limit&cursor -> keyset pagination (bonus)
 *
 * Both order by created_at DESC, id DESC and serialize money as strings.
 */
export function statementRouter(pool: Pool): Router {
  const router = Router();

  router.get("/wallets/:id/statement", async (req, res, next) => {
    try {
      const { id } = parseOrThrow(idParamSchema, req.params);
      const { limit, offset } = parseOrThrow(statementQuerySchema, req.query);
      const page = await getStatementOffset(pool, id, limit, offset);
      res.status(200).json({
        items: page.items,
        limit: page.limit,
        offset: page.offset,
        request_id: req.request_id,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/wallets/:id/statement/cursor", async (req, res, next) => {
    try {
      const { id } = parseOrThrow(idParamSchema, req.params);
      const { limit, cursor } = parseOrThrow(cursorQuerySchema, req.query);
      const page = await getStatementCursor(pool, id, limit, cursor);
      res.status(200).json({
        items: page.items,
        next_cursor: page.next_cursor,
        request_id: req.request_id,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
