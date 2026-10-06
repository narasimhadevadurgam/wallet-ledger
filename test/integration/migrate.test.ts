import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runMigrations } from "../../src/db/migrateRunner.js";
import { SKIP_INTEGRATION, createTestPool } from "./helpers.js";

/**
 * AC-15: migrate from an EMPTY database builds the full schema with zero errors,
 * and a second run is a no-op.
 *
 * This test assumes DATABASE_URL points at a database it is free to migrate
 * (CI uses a throwaway Postgres service). It does not drop anything; it relies
 * on the runner being idempotent, which is exactly what it asserts.
 */

const EXPECTED_TABLES = [
  "users",
  "accounts",
  "transfers",
  "ledger_entries",
  "idempotency_keys",
  "reconciliation_runs",
  "reconciliation_problems",
  "job_locks",
  "risk_rules",
  "risk_flags",
  "audit_log",
  "config",
  "schema_migrations",
];

const EXPECTED_TRIGGERS = [
  "ledger_entries_insert_only",
  "ledger_entries_balanced",
];

describe.skipIf(SKIP_INTEGRATION)("migrations (AC-15)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createTestPool();
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates every expected table", async () => {
    const res = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'`,
    );
    const names = new Set(res.rows.map((r) => r.table_name));
    for (const table of EXPECTED_TABLES) {
      expect(names.has(table), `missing table ${table}`).toBe(true);
    }
  });

  it("creates the insert-only and balanced triggers on ledger_entries", async () => {
    const res = await pool.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relname = 'ledger_entries' AND NOT t.tgisinternal`,
    );
    const names = new Set(res.rows.map((r) => r.tgname));
    for (const trigger of EXPECTED_TRIGGERS) {
      expect(names.has(trigger), `missing trigger ${trigger}`).toBe(true);
    }
  });

  it("seeds the three system accounts, risk rules, config and job lock", async () => {
    const systemAccounts = await pool.query<{ system_type: string }>(
      `SELECT system_type FROM accounts WHERE is_system = true ORDER BY system_type`,
    );
    expect(systemAccounts.rows.map((r) => r.system_type)).toEqual([
      "cash_in",
      "cash_out",
      "fee_revenue",
    ]);

    const rules = await pool.query<{ rule_name: string }>(
      `SELECT rule_name FROM risk_rules ORDER BY rule_name`,
    );
    expect(rules.rows.map((r) => r.rule_name)).toEqual([
      "rapid_drain",
      "single_over_max",
      "velocity",
    ]);

    const fee = await pool.query<{ value: string }>(
      `SELECT value FROM config WHERE key = 'fee_paise'`,
    );
    expect(fee.rows[0]?.value).toBe("0");

    const lock = await pool.query<{ job_name: string }>(
      `SELECT job_name FROM job_locks WHERE job_name = 'reconciliation'`,
    );
    expect(lock.rows).toHaveLength(1);
  });

  it("is a no-op on a second run", async () => {
    const before = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM schema_migrations`,
    );
    const result = await runMigrations(pool);
    expect(result.applied).toEqual([]);
    const after = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM schema_migrations`,
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});
