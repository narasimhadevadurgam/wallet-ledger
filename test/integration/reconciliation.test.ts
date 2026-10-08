import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Pool, PoolClient } from "pg";
import { runMigrations } from "../../src/db/migrateRunner.js";
import { createApp } from "../../src/http/app.js";
import { run as runReconciliation } from "../../src/services/reconciliationService.js";
import { SKIP_INTEGRATION, createTestPool } from "./helpers.js";

/**
 * Reconciliation acceptance tests (design §13, §12 AC-6/AC-7) — against a REAL
 * Postgres. These require a migrated Postgres (DATABASE_URL) and skip
 * automatically when none is configured.
 *
 * AC-6 model (exactly three problem rows across three distinct checks):
 *   The five checks are not mutually independent — the global sum IS the sum of
 *   the per-transfer sums, so unbalancing one transfer necessarily unbalances
 *   the global total. We therefore inject corruptions that drive EXACTLY these
 *   three check_names and nothing else:
 *
 *     1. global_balance + per_transfer_balance: add ONE extra `debit`
 *        ledger_entry to a settled transfer tA (INSERT is allowed; UPDATE/DELETE
 *        are blocked by the insert-only trigger). This makes SUM(debit) exceed
 *        SUM(credit) globally (check a) AND for transfer tA (check b). We then
 *        raise tA's source account's STORED balance by the same delta so its
 *        stored-vs-computed stays consistent (check c does NOT fire for it).
 *        => exactly two rows: one `global_balance`, one `per_transfer_balance`.
 *
 *     2. stored_vs_computed: bump a SPARE account's stored balance by +1. That
 *        account has zero ledger entries, so computed = 0, stored = 1 -> exactly
 *        one `stored_vs_computed` row (and 1 >= 0 so negative_balance is quiet).
 *
 *   Total: exactly three reconciliation_problems and one reconciliation_runs
 *   row. The orphan check reports nothing: every settled transfer still has its
 *   entries, and the settled-only predicate (status IN ('COMPLETED','REVERSED'))
 *   means any HELD/FAILED rows a sibling test leaves behind can never add a
 *   fourth problem (design §13 finding + settled-only orphan predicate).
 *
 * AC-7: hold the job_locks row in one open transaction, then (i) call the
 *   service run() directly and (ii) POST /admin/reconciliation/run; assert the
 *   direct run exits immediately as `locked` and the HTTP call returns 409
 *   RECON_LOCKED, having done no scan work.
 */

describe.skipIf(SKIP_INTEGRATION)("reconciliation (AC-6, AC-7)", () => {
  let pool: Pool;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    pool = createTestPool();
    await runMigrations(pool);
    const app = createApp(pool);
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await pool.end();
  });

  it("AC-6: injected corruptions -> exactly 3 problems across 3 checks, 1 run row", async () => {
    const seed = await seedSettledTransfers(pool, 10_000);

    // Baseline sanity: with no corruption the run is clean (0 problems).
    const baseline = await runReconciliation(pool, { lockedBy: "test-baseline" });
    expect(baseline.kind).toBe("completed");
    if (baseline.kind !== "completed") throw new Error("expected completed baseline");
    expect(baseline.problemCount).toBe(0);

    // Corruption 1: global_balance + per_transfer_balance on transfer tA.
    const tA = seed.transfers[0]!;
    const delta = tA.amount;
    await pool.query(
      `INSERT INTO ledger_entries (transfer_id, account_id, direction, amount)
       VALUES ($1, $2, 'debit', $3)`,
      [tA.transferId, tA.fromAccountId, delta.toString()],
    );
    // Keep tA's source stored balance consistent with its new computed value so
    // stored_vs_computed does NOT fire for that account.
    await pool.query(`UPDATE accounts SET balance = balance - $2 WHERE id = $1`, [
      tA.fromAccountId,
      delta.toString(),
    ]);

    // Corruption 2: stored_vs_computed on a spare zero-entry account.
    const acctB = seed.spareAccountId;
    await pool.query(`UPDATE accounts SET balance = balance + 1 WHERE id = $1`, [acctB]);

    // Run reconciliation through the service directly.
    const outcome = await runReconciliation(pool, { lockedBy: "test" });
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") throw new Error("expected completed");

    // Exactly three problem rows and one run row for this execution.
    const problems = await loadProblems(pool, outcome.runId);
    expect(problems).toHaveLength(3);
    expect(outcome.problemCount).toBe(3);

    const byCheck = new Map(problems.map((p) => [p.check_name, p]));
    expect([...byCheck.keys()].sort()).toEqual([
      "global_balance",
      "per_transfer_balance",
      "stored_vs_computed",
    ]);

    // per_transfer_balance names tA with debit exceeding credit by delta.
    const perTransfer = byCheck.get("per_transfer_balance")!;
    expect(perTransfer.entity_id).toBe(tA.transferId);
    expect(perTransfer.expected).toBe(tA.amount.toString()); // credit sum
    expect(perTransfer.actual).toBe((tA.amount + delta).toString()); // debit sum

    // stored_vs_computed names acctB: stored 1, computed 0.
    const stored = byCheck.get("stored_vs_computed")!;
    expect(stored.entity_id).toBe(acctB);
    expect(stored.expected).toBe("1"); // stored
    expect(stored.actual).toBe("0"); // computed

    // global_balance is a single aggregate row (entity_id NULL).
    expect(byCheck.get("global_balance")!.entity_id).toBeNull();

    // Exactly one run row carries these counts; status is 'problems'.
    const runRow = await loadRun(pool, outcome.runId);
    expect(runRow.status).toBe("problems");
    expect(runRow.problem_count).toBe(3);
    expect(runRow.global_balance_count).toBe(1);
    expect(runRow.per_transfer_balance_count).toBe(1);
    expect(runRow.stored_vs_computed_count).toBe(1);
    expect(runRow.negative_balance_count).toBe(0);
    expect(runRow.orphan_count).toBe(0);
  }, 120_000);

  it("AC-7: lock held -> direct run exits locked, POST returns 409 RECON_LOCKED", async () => {
    // Hold the job_locks row in a separate open transaction for the duration.
    const holder: PoolClient = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        `SELECT job_name FROM job_locks WHERE job_name = 'reconciliation' FOR UPDATE`,
      );

      // (i) Direct service run must fail fast as `locked` (no scan work).
      const outcome = await runReconciliation(pool, { lockedBy: "test" });
      expect(outcome.kind).toBe("locked");

      // (ii) The admin trigger must return 409 RECON_LOCKED.
      const res = await fetch(`${baseUrl}/admin/reconciliation/run`, { method: "POST" });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("RECON_LOCKED");
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });
});

// --- Seeding ----------------------------------------------------------------

interface SeededTransfer {
  transferId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: bigint;
}

interface SeedResult {
  transfers: SeededTransfer[];
  /** An account NOT referenced by any transfer, used for the stored-balance corruption. */
  spareAccountId: string;
}

/**
 * Seed `count` COMPLETED peer transfers, each with a balanced debit/credit pair,
 * between a small ring of user wallets whose stored balances are set to their
 * exact computed net so the BASELINE recon run is clean (zero problems). Returns
 * the created transfers plus a spare account with zero entries and stored 0.
 *
 * Done in ONE transaction with multi-row INSERT batches for speed.
 */
async function seedSettledTransfers(pool: Pool, count: number): Promise<SeedResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const user = await client.query<{ id: string }>(
      `INSERT INTO users (name, email, phone, kyc_status)
       VALUES ('Recon Seed', $1, $2, 'pending') RETURNING id`,
      [`recon.${Date.now()}@example.com`, `+1${Date.now()}`],
    );
    const userId = user.rows[0]!.id;

    // A ring of wallets; transfers cycle through consecutive wallets so every
    // wallet's net stored balance is recomputable and set exactly.
    const WALLETS = 50;
    const accountIds: string[] = [];
    for (let i = 0; i < WALLETS; i++) {
      const acct = await client.query<{ id: string }>(
        `INSERT INTO accounts (user_id, is_system, system_type, currency, balance)
         VALUES ($1, false, NULL, 'INR', 0) RETURNING id`,
        [userId],
      );
      accountIds.push(acct.rows[0]!.id);
    }
    // A spare wallet with zero entries and a known stored balance of 0.
    const spare = await client.query<{ id: string }>(
      `INSERT INTO accounts (user_id, is_system, system_type, currency, balance)
       VALUES ($1, false, NULL, 'INR', 0) RETURNING id`,
      [userId],
    );
    const spareAccountId = spare.rows[0]!.id;

    const amount = 1000n;
    const transfers: SeededTransfer[] = [];
    const net = new Map<string, bigint>(accountIds.map((id) => [id, 0n]));

    const BATCH = 500;
    for (let start = 0; start < count; start += BATCH) {
      const end = Math.min(start + BATCH, count);

      const transferValues: string[] = [];
      const transferParams: unknown[] = [];
      const pairs: Array<{ from: string; to: string }> = [];
      let p = 1;
      for (let i = start; i < end; i++) {
        const from = accountIds[i % WALLETS]!;
        const to = accountIds[(i + 1) % WALLETS]!;
        pairs.push({ from, to });
        transferValues.push(`('peer_transfer', 'COMPLETED', $${p++}, $${p++}, $${p++})`);
        transferParams.push(amount.toString(), from, to);
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO transfers (type, status, amount, from_account_id, to_account_id)
         VALUES ${transferValues.join(", ")}
         RETURNING id`,
        transferParams,
      );

      const entryValues: string[] = [];
      const entryParams: unknown[] = [];
      let q = 1;
      inserted.rows.forEach((row, idx) => {
        const { from, to } = pairs[idx]!;
        transfers.push({ transferId: row.id, fromAccountId: from, toAccountId: to, amount });
        net.set(from, net.get(from)! - amount);
        net.set(to, net.get(to)! + amount);
        entryValues.push(`($${q++}, $${q++}, 'debit',  $${q++})`);
        entryParams.push(row.id, from, amount.toString());
        entryValues.push(`($${q++}, $${q++}, 'credit', $${q++})`);
        entryParams.push(row.id, to, amount.toString());
      });
      await client.query(
        `INSERT INTO ledger_entries (transfer_id, account_id, direction, amount)
         VALUES ${entryValues.join(", ")}`,
        entryParams,
      );
    }

    // Set each wallet's stored balance to its exact computed net (clean baseline).
    for (const [accountId, netBalance] of net) {
      await client.query(`UPDATE accounts SET balance = $2 WHERE id = $1`, [
        accountId,
        netBalance.toString(),
      ]);
    }

    await client.query("COMMIT");
    return { transfers, spareAccountId };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// --- Readback helpers -------------------------------------------------------

interface ProblemRow {
  check_name: string;
  entity_id: string | null;
  expected: string | null;
  actual: string | null;
}

async function loadProblems(pool: Pool, runId: bigint): Promise<ProblemRow[]> {
  const res = await pool.query<ProblemRow>(
    `SELECT check_name, entity_id::text AS entity_id, expected, actual
     FROM reconciliation_problems WHERE run_id = $1 ORDER BY id`,
    [runId.toString()],
  );
  return res.rows;
}

interface RunRow {
  status: string;
  problem_count: number;
  global_balance_count: number;
  per_transfer_balance_count: number;
  stored_vs_computed_count: number;
  negative_balance_count: number;
  orphan_count: number;
}

async function loadRun(pool: Pool, runId: bigint): Promise<RunRow> {
  const res = await pool.query<RunRow>(
    `SELECT status, problem_count, global_balance_count, per_transfer_balance_count,
            stored_vs_computed_count, negative_balance_count, orphan_count
     FROM reconciliation_runs WHERE id = $1`,
    [runId.toString()],
  );
  return res.rows[0]!;
}
