import type { NextFunction, Request, Response } from "express";
import { validate as isUuid } from "uuid";
import { canonicalJson, sha256Hex } from "../money/money.js";
import { AppError } from "./errors.js";
import "./types.js";

/**
 * Idempotency for the money-mutating client POSTs (design §8 "Idempotency
 * scope", §11): `POST /wallets/{id}/top-up`, `POST /transfers`, and
 * `POST /wallets/{id}/withdraw`. Each REQUIRES an `Idempotency-Key: <uuid>`
 * header; a missing or non-UUID header is rejected `400 MISSING_IDEMPOTENCY_KEY`
 * BEFORE any DB work. The other POSTs (`/users`, `/users/{id}/wallets`,
 * `/users/{id}/statement/ask`, `/admin/*`) do NOT carry a key and are not wired
 * to this middleware — they rely on their own guards (§8).
 *
 * The middleware also computes `body_hash = sha256Hex(canonicalJson(body))`
 * (design §11.1, implemented in money/money.ts) and stashes `{ key, bodyHash }`
 * on the request. transferService inserts that key FIRST inside the transfer
 * transaction (design §9.1 step 3) and detects a replay SOLELY by the
 * `UNIQUE(user_id, key)` violation — it never SELECTs an `in_progress` key.
 */

/** The resolved idempotency data a money route forwards into transferService. */
export interface RequestIdempotency {
  /** The client-supplied UUID from the `Idempotency-Key` header. */
  key: string;
  /** SHA-256 (lowercase hex) of the canonicalized request body (design §11.1). */
  bodyHash: string;
}

/**
 * Express middleware for the three money POSTs. Requires a valid UUID
 * `Idempotency-Key` header (else `400 MISSING_IDEMPOTENCY_KEY`), computes the
 * body hash, and stashes both on `req.idempotency` for the route to forward.
 * Registered per-route so it runs before any DB work; the body is already
 * parsed by `express.json()` upstream.
 */
export function requireIdempotency(req: Request, _res: Response, next: NextFunction): void {
  const supplied = req.header("Idempotency-Key");
  if (!supplied || !isUuid(supplied)) {
    next(
      new AppError(
        "MISSING_IDEMPOTENCY_KEY",
        "a valid UUID Idempotency-Key header is required on this request",
      ),
    );
    return;
  }
  req.idempotency = {
    key: supplied,
    bodyHash: sha256Hex(canonicalJson(req.body)),
  };
  next();
}
