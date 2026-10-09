import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/query.js";

/**
 * Reconciliation worker (design §13, FR-10). The job runs the five SQL checks
 * (a–e) inside ONE `REPEATABLE READ` transaction and REPORTS problems — it
 * NEVER mutates ledger_entries or accounts to "fix" anything. It writes one
 * `reconciliation_runs` row and one `reconciliation_problems` row per problem.
 *
 * Single-run safety (design §13 "lock first"): the VERY FIRST statement in the
 * transaction is `SELECT ... FROM job_locks WHERE job_name='reconciliation'
 * FOR UPDATE NOWAIT`. A losing contender fails fast on SQLSTATE 55P03
 * (lock-not-available) BEFORE doing any scan work; that is an expected,
 * non-error early exit (`{ status: "locked" }`) which the manual trigger maps
 * to `409 RECON_LOCKED`. Taking the lock first also establishes the
 * `REPEATABLE READ` snapshot and the lock together at the start of the txn.
 *
 * Only this service and `transferService` manage transactions/locks explicitly
 * (design §5 separation of concerns).
 */

/** Postgres SQLSTATE for `FOR UPDATE NOWAIT` on an already-locked row. */
const LOCK_NOT_AVAILABLE = "55P03";

/** The five checks, named exactly as stored in `reconciliation_problems.check_name`. */
export type CheckName =
  | "global_balance"
  | "per_transfer_balance"
  | "stored_vs_computed"
  | "negative_balance"
  | "orphan";

/** A single reported problem (one row in `reconciliation_problems`). */
export interface Problem {
  checkName: CheckName;
  entityId: bigint | null;
  expected: string | null;
  actual: string | null;
}

/**
 * The outcome of a `run()`:
 *   - `completed` — the job ran to the end (status 'ok' when no problems, or
 *     'problems' when at least one was found). `runId` is the written row.
 *   - `locked`    — another run holds the job_locks row; this invocation did no
 *     scan work and wrote no run row. Manual trigger → 409 RECON_LOCKED.
 *   - `error`     — a check query errored; the run row is marked 'error', the
 *     transaction rolled back the problem rows but the run row is persisted in a
 *     separate connection so the failure is auditable.
 */
export type ReconciliationOutcome =
  | { kind: "completed"; runId: bigint; status: "ok" | "problems"; problemCount: number }
  | { kind: "locked" }
  | { kind: "error"; message: string };

/** Per-check problem counts, used to populate the run row's count columns. */
interface CheckCounts {
  global_balance: number;
  per_transfer_balance: number;
  stored_vs_computed: number;
  negative_balance: number;
  orphan: number;
}

export interface RunOptions {
  /**
   * When set (> 0), the run also deletes `idempotency_keys` older than this many
   * hours in the SAME transaction (design §13 optional cleanup). Defaults to
   * disabled (undefined) so cleanup only happens when the worker opts in.
   */
  idempotencyCleanupHours?: number | undefined;
  /** Recorded in `job_locks.locked_by` / run logs; identifies the trigger source. */
  lockedBy?: string | undefined;
}

/** Minimal logger seam so the worker/tests can inject one; defaults to console. */
export interface ReconLogger {
  info(message: string): void;
  error(message: string): void;
}

const defaultLogger: ReconLogger = {
  info: (m) => console.log(m),
  error: (m) => console.error(m),
};

/** Narrow an unknown thrown value to a pg error carrying a SQLSTATE `code`. */
function pgErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * Internal sentinel: the `FOR UPDATE NOWAIT` could not take the lock (another
 * run holds it). Thrown as the first statement so no scan runs; caught by
 * `run()` which returns `{ kind: "locked" }` after the txn ends.
 */
class ReconLockHeld extends Error {
  constructor() {
    super("reconciliation lock held by another run");
    this.name = "ReconLockHeld";
  }
}

/**
 * Run reconciliation. Opens a `REPEATABLE READ` transaction, takes the
 * job_locks row FOR UPDATE NOWAIT FIRST, runs the five checks, and writes the
 * run + problem rows. Returns a `ReconciliationOutcome`. Never throws for the
 * expected lock-held case (returns `locked`); a check failure is captured as
 * `error` with the run row marked 'error' on a separate connection.
 */
export async function run(
  pool: Pool,
  options: RunOptions = {},
  logger: ReconLogger = defaultLogger,
): Promise<ReconciliationOutcome> {
  const startedAt = new Date();
  try {
    return await withTransaction(
      pool,
      async (client): Promise<ReconciliationOutcome> => {
        // --- FIRST STATEMENT: take the single-run lock, fail fast if held. ---
        await acquireJobLock(client, options.lockedBy ?? "worker");

        // --- Run the five checks (each a single query), collect problems. ---
        const problems: Problem[] = [];
        problems.push(...(await checkGlobalBalance(client)));
        problems.push(...(await checkPerTransferBalance(client)));
        problems.push(...(await checkStoredVsComputed(client)));
        problems.push(...(await checkNegativeBalance(client)));
        problems.push(...(await checkOrphans(client)));

        // --- Optional 24h idempotency-key cleanup in the same transaction. ---
        if (options.idempotencyCleanupHours && options.idempotencyCleanupHours > 0) {
          await cleanupIdempotencyKeys(client, options.idempotencyCleanupHours);
        }

        const counts = tallyCounts(problems);
        const globalOk = counts.global_balance === 0;
        const status: "ok" | "problems" = problems.length === 0 ? "ok" : "problems";

        const runId = await insertRunRow(client, {
          startedAt,
          finishedAt: new Date(),
          status,
          globalOk,
          problemCount: problems.length,
          counts,
        });
        for (const problem of problems) {
          await insertProblemRow(client, runId, problem);
        }

        logger.info(
          `reconciliation run ${runId} ${status}: ${problems.length} problem(s)`,
        );
        return { kind: "completed", runId, status, problemCount: problems.length };
      },
      { isolationLevel: "REPEATABLE READ" },
    );
  } catch (err) {
    if (err instanceof ReconLockHeld) {
      // Expected, non-error early exit (design §13): another run holds the lock.
      logger.info("reconciliation lock held by another run; exiting (RECON_LOCKED)");
      return { kind: "locked" };
    }
    // A check (or write) query errored. The transaction rolled back, releasing
    // the lock; record an 'error' run row on a fresh connection so the failure
    // is auditable, and log at error (design §13 error handling).
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`reconciliation run failed: ${message}`);
    await recordErrorRun(pool, startedAt, message).catch(() => {
      // Best effort: if even the error-row write fails, don't mask the original.
    });
    return { kind: "error", message };
  }
}

/**
 * FIRST statement in the recon transaction (design §13). `FOR UPDATE NOWAIT`
 * on the job_locks row: if another run holds it, Postgres raises SQLSTATE
 * 55P03 immediately (no wait, no scan) and we throw `ReconLockHeld`.
 */
async function acquireJobLock(client: PoolClient, lockedBy: string): Promise<void> {
  try {
    await client.query(
      `SELECT job_name FROM job_locks
       WHERE job_name = 'reconciliation'
       FOR UPDATE NOWAIT`,
    );
  } catch (err) {
    if (pgErrorCode(err) === LOCK_NOT_AVAILABLE) {
      throw new ReconLockHeld();
    }
    throw err;
  }
  // Mark the lock holder for observability; harmless if the txn rolls back.
  await client.query(
    `UPDATE job_locks SET locked_at = now(), locked_by = $1
     WHERE job_name = 'reconciliation'`,
    [lockedBy],
  );
}

/**
 * Check (a) GLOBAL balance: over all ledger_entries, SUM(debit) must equal
 * SUM(credit). A single row is returned; if the two totals differ it is one
 * global problem (entity_id NULL, expected = total credits, actual = total
 * debits). Empty ledger → both 0 → no problem.
 */
async function checkGlobalBalance(client: PoolClient): Promise<Problem[]> {
  const result = await client.query<{ debit: string; credit: string }>(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'),  0)::text AS debit,
       COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)::text AS credit
     FROM ledger_entries`,
  );
  const row = result.rows[0];
  if (!row || row.debit === row.credit) return [];
  return [
    {
      checkName: "global_balance",
      entityId: null,
      expected: row.credit,
      actual: row.debit,
    },
  ];
}

/**
 * Check (b) PER-TRANSFER balance: GROUP BY transfer_id HAVING
 * SUM(debit) <> SUM(credit) — each offending transfer is one problem
 * (entity_id = transfer_id, expected = that transfer's credit sum, actual =
 * its debit sum).
 */
async function checkPerTransferBalance(client: PoolClient): Promise<Problem[]> {
  const result = await client.query<{
    transfer_id: string;
    debit: string;
    credit: string;
  }>(
    `SELECT
       transfer_id,
       COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'),  0)::text AS debit,
       COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)::text AS credit
     FROM ledger_entries
     GROUP BY transfer_id
     HAVING SUM(amount) FILTER (WHERE direction = 'debit')
          <> SUM(amount) FILTER (WHERE direction = 'credit')
     ORDER BY transfer_id`,
  );
  return result.rows.map((row) => ({
    checkName: "per_transfer_balance",
    entityId: BigInt(row.transfer_id),
    expected: row.credit,
    actual: row.debit,
  }));
}

/**
 * Check (c) STORED vs COMPUTED: for each account compare the stored
 * `accounts.balance` against SUM(credit) − SUM(debit) recomputed from
 * ledger_entries. Each drifted account is one problem (entity_id = account_id,
 * expected = stored, actual = computed). A LEFT JOIN covers accounts with zero
 * entries (computed 0); system accounts are included — at baseline they are
 * seeded 0/0 so they never raise a false positive (design §13 finding 2a).
 *
 * Each side's SUM is wrapped in COALESCE(...,0) BEFORE subtracting: an account
 * with entries on only ONE side (e.g. a system cash_in with only debits) has a
 * NULL SUM on the empty side, and `NULL - x` is NULL, which would otherwise
 * collapse the computed balance to 0 and misreport (or hide) a real drift.
 */
async function checkStoredVsComputed(client: PoolClient): Promise<Problem[]> {
  const result = await client.query<{
    account_id: string;
    stored: string;
    computed: string;
  }>(
    `SELECT
       a.id::text AS account_id,
       a.balance::text AS stored,
       (COALESCE(SUM(le.amount) FILTER (WHERE le.direction = 'credit'), 0)
      - COALESCE(SUM(le.amount) FILTER (WHERE le.direction = 'debit'),  0))::text AS computed
     FROM accounts a
     LEFT JOIN ledger_entries le ON le.account_id = a.id
     GROUP BY a.id, a.balance
     HAVING a.balance <>
         COALESCE(SUM(le.amount) FILTER (WHERE le.direction = 'credit'), 0)
       - COALESCE(SUM(le.amount) FILTER (WHERE le.direction = 'debit'),  0)
     ORDER BY a.id`,
  );
  return result.rows.map((row) => ({
    checkName: "stored_vs_computed",
    entityId: BigInt(row.account_id),
    expected: row.stored,
    actual: row.computed,
  }));
}

/**
 * Check (d) NEGATIVE balance: any NON-system account whose COMPUTED balance
 * (from ledger_entries) is < 0. Each is one problem (entity_id = account_id,
 * expected = "0" lower bound, actual = computed). System accounts may legally
 * go negative and are excluded.
 */
async function checkNegativeBalance(client: PoolClient): Promise<Problem[]> {
  const result = await client.query<{ account_id: string; computed: string }>(
    `SELECT
       a.id::text AS account_id,
       (COALESCE(SUM(le.amount) FILTER (WHERE le.direction = 'credit'), 0)
      - COALESCE(SUM(le.amount) FILTER (WHERE le.direction = 'debit'),  0))::text AS computed
     FROM accounts a
     LEFT JOIN ledger_entries le ON le.account_id = a.id
     WHERE a.is_system = false
     GROUP BY a.id
     HAVING
         COALESCE(SUM(le.amount) FILTER (WHERE le.direction = 'credit'), 0)
       - COALESCE(SUM(le.amount) FILTER (WHERE le.direction = 'debit'),  0) < 0
     ORDER BY a.id`,
  );
  return result.rows.map((row) => ({
    checkName: "negative_balance",
    entityId: BigInt(row.account_id),
    expected: "0",
    actual: row.computed,
  }));
}

/**
 * Check (e) ORPHANS: two sub-checks unioned.
 *   1. ledger entries whose transfer_id OR account_id points at no row (should
 *      be impossible given the FKs; a non-zero count signals corruption that
 *      bypassed them). entity_id = the offending ledger entry id.
 *   2. SETTLED transfers (status IN ('COMPLETED','REVERSED')) with NO ledger
 *      entries — the EXACT predicate from design §13. HELD/FAILED/PENDING
 *      transfers legitimately have zero entries and are EXCLUDED, which keeps
 *      AC-6 deterministic in a shared DB. entity_id = the transfer id.
 */
async function checkOrphans(client: PoolClient): Promise<Problem[]> {
  const orphanEntries = await client.query<{ id: string }>(
    `SELECT le.id::text AS id
     FROM ledger_entries le
     WHERE NOT EXISTS (SELECT 1 FROM transfers t WHERE t.id = le.transfer_id)
        OR NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = le.account_id)
     ORDER BY le.id`,
  );
  const settledNoEntries = await client.query<{ id: string }>(
    `SELECT t.id::text AS id
     FROM transfers t
     WHERE t.status IN ('COMPLETED', 'REVERSED')
       AND NOT EXISTS (SELECT 1 FROM ledger_entries le WHERE le.transfer_id = t.id)
     ORDER BY t.id`,
  );
  const problems: Problem[] = [];
  for (const row of orphanEntries.rows) {
    problems.push({
      checkName: "orphan",
      entityId: BigInt(row.id),
      expected: "ledger_entry references existing transfer and account",
      actual: "dangling ledger_entry",
    });
  }
  for (const row of settledNoEntries.rows) {
    problems.push({
      checkName: "orphan",
      entityId: BigInt(row.id),
      expected: "settled transfer has ledger entries",
      actual: "settled transfer has no ledger entries",
    });
  }
  return problems;
}

/**
 * Optional (design §13): delete idempotency_keys older than `hours`. Runs in
 * the SAME transaction as the checks so it commits with the run row (or rolls
 * back with it on error). Reporting-only invariant is unaffected: idempotency
 * keys are operational, not ledger/accounts data.
 */
async function cleanupIdempotencyKeys(client: PoolClient, hours: number): Promise<void> {
  await client.query(
    `DELETE FROM idempotency_keys
     WHERE created_at < now() - make_interval(hours => $1)`,
    [hours],
  );
}

function tallyCounts(problems: Problem[]): CheckCounts {
  const counts: CheckCounts = {
    global_balance: 0,
    per_transfer_balance: 0,
    stored_vs_computed: 0,
    negative_balance: 0,
    orphan: 0,
  };
  for (const problem of problems) {
    counts[problem.checkName] += 1;
  }
  return counts;
}

interface RunRowInput {
  startedAt: Date;
  finishedAt: Date;
  status: "ok" | "problems";
  globalOk: boolean;
  problemCount: number;
  counts: CheckCounts;
}

async function insertRunRow(client: PoolClient, input: RunRowInput): Promise<bigint> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO reconciliation_runs (
       started_at, finished_at, status, global_ok, problem_count,
       global_balance_count, per_transfer_balance_count, stored_vs_computed_count,
       negative_balance_count, orphan_count
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      input.startedAt.toISOString(),
      input.finishedAt.toISOString(),
      input.status,
      input.globalOk,
      input.problemCount,
      input.counts.global_balance,
      input.counts.per_transfer_balance,
      input.counts.stored_vs_computed,
      input.counts.negative_balance,
      input.counts.orphan,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("reconciliation_runs insert returned no row");
  }
  return BigInt(row.id);
}

async function insertProblemRow(
  client: PoolClient,
  runId: bigint,
  problem: Problem,
): Promise<void> {
  await client.query(
    `INSERT INTO reconciliation_problems (run_id, check_name, entity_id, expected, actual)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      runId.toString(),
      problem.checkName,
      problem.entityId === null ? null : problem.entityId.toString(),
      problem.expected,
      problem.actual,
    ],
  );
}

/**
 * Record a run row with status='error' on a FRESH connection (the checks' txn
 * already rolled back, releasing the lock). This is best-effort auditing of the
 * failure; it does not re-run the checks.
 */
async function recordErrorRun(
  pool: Pool,
  startedAt: Date,
  _message: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO reconciliation_runs (started_at, finished_at, status, global_ok, problem_count)
     VALUES ($1, now(), 'error', NULL, 0)`,
    [startedAt.toISOString()],
  );
}
