import express, { type Express } from "express";
import type { Pool } from "pg";
import "./types.js";
import type { LlmClient } from "../llm/LlmClient.js";
import { errorMiddleware } from "./errors.js";
import { requestId } from "./requestId.js";
import { usersRouter } from "./routes/users.js";
import { walletsRouter } from "./routes/wallets.js";
import { transfersRouter } from "./routes/transfers.js";
import { statementRouter } from "./routes/statement.js";
import { adminRouter } from "./routes/admin.js";

/**
 * Build the Express app. Middleware order matters:
 *   1. express.json()  -> parse bodies
 *   2. requestId       -> assign/echo request_id (before any route can error)
 *   3. routers         -> users, wallets, transfers, statement
 *   4. errorMiddleware -> LAST, renders the uniform {code,message,request_id}
 *
 * The admin router (/admin/*) is mounted by FEAT-005. The statement-ask route
 * (POST /users/{id}/statement/ask) lives on the statement router (FEAT-006)
 * and needs an `LlmClient`; the entrypoint builds one from `LLM_PROVIDER` via
 * the factory and passes it in. Tests inject the deterministic mock directly.
 *
 * NOTE: statementRouter is mounted LAST among the resource routers but BEFORE
 * the error middleware; the admin router is mounted alongside the others.
 */
export function createApp(pool: Pool, llm: LlmClient): Express {
  const app = express();

  app.use(express.json());
  app.use(requestId);

  // A trivial liveness probe (compose/CI healthcheck). Carries request_id too.
  app.get("/health", (req, res) => {
    res.status(200).json({ status: "ok", request_id: req.request_id });
  });

  app.use(usersRouter(pool));
  app.use(walletsRouter(pool));
  app.use(transfersRouter(pool));
  app.use(statementRouter(pool, llm));
  app.use(adminRouter(pool));

  app.use(errorMiddleware);

  return app;
}
