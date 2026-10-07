import type { NextFunction, Request, Response } from "express";
import { validate as isUuid, v4 as uuidv4 } from "uuid";

/**
 * Every request carries a `request_id` that appears in every response
 * (including errors), so a client can correlate a call with its outcome
 * (design §8). We honour a client-supplied `X-Request-Id` when it is a valid
 * UUID, otherwise we mint a fresh v4. The id is stashed on `req.request_id`
 * and echoed back on the `X-Request-Id` response header.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const supplied = req.header("X-Request-Id");
  const id = supplied && isUuid(supplied) ? supplied : uuidv4();
  req.request_id = id;
  res.setHeader("X-Request-Id", id);
  next();
}
