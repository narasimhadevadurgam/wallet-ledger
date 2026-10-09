import { Router } from "express";
import type { Pool } from "pg";
import type { LlmClient } from "../../llm/LlmClient.js";
import {
  answerStatementQuestion,
  getStatementCursor,
  getStatementOffset,
} from "../../services/statementService.js";
import {
  askSchema,
  cursorQuerySchema,
  idParamSchema,
  parseOrThrow,
  statementQuerySchema,
} from "../validation.js";

/**
 * Statement routes (design §8, §10):
 *   GET  /wallets/{id}/statement?limit&offset        -> OFFSET pagination
 *   GET  /wallets/{id}/statement/cursor?limit&cursor -> keyset pagination (bonus)
 *   POST /users/{id}/statement/ask                   -> LLM-assisted NL query
 *
 * The GETs order by created_at DESC, id DESC and serialize money as strings.
 * The ask route is idempotency-exempt (read-only, moves no money): the LLM only
 * parses the question to JSON and code runs its own parameterized SQL scoped to
 * the path user's accounts (design §10 / FR-14).
 */
export function statementRouter(pool: Pool, llm: LlmClient): Router {
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

  router.post("/users/:id/statement/ask", async (req, res, next) => {
    try {
      const { id } = parseOrThrow(idParamSchema, req.params);
      const { question } = parseOrThrow(askSchema, req.body);
      const result = await answerStatementQuestion(pool, llm, id, question);
      res.status(200).json({
        type: result.type,
        answer: result.answer,
        transfer_ids: result.transfer_ids,
        request_id: req.request_id,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
