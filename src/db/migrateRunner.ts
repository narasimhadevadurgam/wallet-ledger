import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the migrations directory (repo-root/migrations). */
const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

export interface MigrationResult {
  /** Versions applied during this run, in order (empty if already up to date). */
  applied: string[];
}

function listMigrationFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // No migrations directory yet (empty schema) — nothing to apply.
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Apply every migration in `migrations/` that has not yet been recorded in
 * `schema_migrations`, in lexicographic (zero-padded) order. Each file runs in
 * its own transaction: BEGIN, run SQL, record the version, COMMIT. A failure
 * rolls that file back and aborts the whole run (the error propagates). Safe to
 * re-run — already-applied files are skipped. Builds the schema from empty.
 */
export async function runMigrations(
  pool: Pool,
  migrationsDir: string = MIGRATIONS_DIR,
): Promise<MigrationResult> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );

  const appliedRows = await pool.query<{ version: string }>(
    "SELECT version FROM schema_migrations",
  );
  const alreadyApplied = new Set(appliedRows.rows.map((r) => r.version));

  const files = listMigrationFiles(migrationsDir);
  const applied: string[] = [];

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (alreadyApplied.has(version)) continue;

    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1)",
        [version],
      );
      await client.query("COMMIT");
      applied.push(version);
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // keep the original failure
      }
      throw new Error(
        `Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    } finally {
      client.release();
    }
  }

  return { applied };
}
