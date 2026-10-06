import type { Pool } from "pg";
import { createPool } from "../../src/db/pool.js";

/**
 * Integration tests run against a REAL Postgres and are skipped automatically
 * when DATABASE_URL is not set (e.g. local dev without Docker/Postgres). Each
 * test file guards its suite with `describe.skipIf(SKIP_INTEGRATION)` so the
 * suite is a no-op rather than a failure when there is no database.
 *
 * We export a plain boolean (not a wrapped `describe`) so no vitest-internal,
 * un-exported type leaks into a declaration position (TS4023).
 */
export const DATABASE_URL = process.env.DATABASE_URL;

export const SKIP_INTEGRATION = !DATABASE_URL;

/** Build a pool against the test database. Caller is responsible for ending it. */
export function createTestPool(): Pool {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is required for integration tests");
  }
  return createPool(DATABASE_URL);
}
