import { loadConfig } from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrateRunner.js";

/**
 * CLI migration runner. Builds the pool from env and applies all pending
 * migrations. Exits non-zero on any failure (including a missing/unreachable
 * database), so CI and startup fail loudly rather than silently.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);
  try {
    const { applied } = await runMigrations(pool);
    if (applied.length === 0) {
      console.log("Migrations: already up to date.");
    } else {
      console.log(`Migrations applied: ${applied.join(", ")}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
