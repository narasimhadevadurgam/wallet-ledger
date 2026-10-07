import { loadConfig } from "./config/env.js";
import { createPool } from "./db/pool.js";
import { runMigrations } from "./db/migrateRunner.js";
import { createApp } from "./http/app.js";

/**
 * API entrypoint. Build the pool from env, apply migrations to completion, and
 * only THEN start listening — the server must never serve against a half-built
 * schema (design §5, §16).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);

  const { applied } = await runMigrations(pool);
  if (applied.length > 0) {
    console.log(`Migrations applied: ${applied.join(", ")}`);
  }

  const app = createApp(pool);
  app.listen(config.PORT, () => {
    console.log(`wallet-ledger API listening on port ${config.PORT}`);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
