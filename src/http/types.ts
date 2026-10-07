/**
 * Ambient augmentation so `req.request_id` (assigned by the requestId
 * middleware) is typed across the HTTP layer. Importing this module for its
 * side effect is unnecessary — it is picked up globally by the compiler — but
 * it lives in src/http so the augmentation ships with the HTTP code.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      request_id: string;
    }
  }
}

export {};
