import type { NextFunction, Request, Response } from "express";
import "./types.js";

/**
 * The full error catalogue from design §8. Each code maps to a fixed HTTP
 * status. Every error response is rendered as the single uniform shape
 * `{ code, message, request_id }` by the error middleware below — there is no
 * other error shape anywhere in the API.
 */
export type ErrorCode =
  | "VALIDATION_ERROR"
  | "INVALID_AMOUNT"
  | "UNSUPPORTED_CURRENCY"
  | "SAME_WALLET"
  | "MISSING_IDEMPOTENCY_KEY"
  | "IDEMPOTENCY_BODY_MISMATCH"
  | "INSUFFICIENT_FUNDS"
  | "NOT_FOUND"
  | "WALLET_FROZEN"
  | "TRANSFER_NOT_HELD"
  | "RECON_LOCKED"
  | "UNSUPPORTED_QUESTION"
  | "INTERNAL";

/** Fixed HTTP status for every error code (design §8). */
const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  INVALID_AMOUNT: 400,
  UNSUPPORTED_CURRENCY: 400,
  SAME_WALLET: 400,
  MISSING_IDEMPOTENCY_KEY: 400,
  IDEMPOTENCY_BODY_MISMATCH: 422,
  INSUFFICIENT_FUNDS: 422,
  NOT_FOUND: 404,
  WALLET_FROZEN: 409,
  TRANSFER_NOT_HELD: 409,
  RECON_LOCKED: 409,
  UNSUPPORTED_QUESTION: 422,
  INTERNAL: 500,
};

/**
 * A domain error carrying the catalogue `code`, its mapped `httpStatus`, and a
 * client-safe `message`. Services throw these; the error middleware renders
 * them. Anything thrown that is NOT an AppError is treated as an unexpected
 * INTERNAL (500) with a generic message so internals never leak.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
  }
}

/** The uniform error body (design §8 / FR-16). */
export interface ErrorBody {
  code: ErrorCode;
  message: string;
  request_id: string;
}

/**
 * Express error middleware — MUST be registered last (after all routers). It
 * renders every error as `{ code, message, request_id }`. Known AppErrors use
 * their code+status+message; anything else becomes a generic INTERNAL 500 so
 * stack traces and driver messages never reach the client.
 */
export function errorMiddleware(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  const requestId = req.request_id ?? "";

  if (err instanceof AppError) {
    const body: ErrorBody = {
      code: err.code,
      message: err.message,
      request_id: requestId,
    };
    res.status(err.httpStatus).json(body);
    return;
  }

  // Unexpected: log server-side, return an opaque 500.
  console.error(`[${requestId}] unhandled error:`, err);
  const body: ErrorBody = {
    code: "INTERNAL",
    message: "An unexpected error occurred.",
    request_id: requestId,
  };
  res.status(500).json(body);
}
