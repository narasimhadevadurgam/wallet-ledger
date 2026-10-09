import type { Pool } from "pg";
import { createPool } from "../../src/db/pool.js";
import { runMigrations } from "../../src/db/migrateRunner.js";

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

/**
 * Reset the public schema to empty, then migrate from scratch. Every DB-backed
 * suite calls this in its `beforeAll` so it starts from a KNOWN-CLEAN state and
 * never observes rows another suite left behind (the suites share one Postgres
 * and run serially — see vitest.config.ts). Dropping and recreating `public`
 * wipes all tables, types, triggers and sequences in one shot, so a re-run can
 * never collide on CREATE TABLE / pg_type the way concurrent raw migrations did.
 */
export async function resetSchema(pool: Pool): Promise<void> {
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await runMigrations(pool);
}
