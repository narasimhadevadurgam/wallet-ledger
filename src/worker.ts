import cron from "node-cron";
import { loadConfig } from "./config/env.js";
import { createPool } from "./db/pool.js";
import { runMigrations } from "./db/migrateRunner.js";
import { run as runReconciliation } from "./services/reconciliationService.js";

/**
 * Worker entrypoint (design §5, §13, §16). Shares the codebase with the API but
 * runs a different process: it applies migrations if needed, then schedules the
 * nightly reconciliation via `node-cron` (`RECON_CRON`). The admin trigger
 * (POST /admin/reconciliation/run on the API) invokes the SAME
 * `reconciliationService.run`; the `job_locks` FOR UPDATE NOWAIT lock inside
 * the run guarantees a single concurrent run regardless of trigger source, so
 * the two paths never need to coordinate out of band.
 *
 * The optional 24h idempotency-key cleanup is enabled on the scheduled run via
 * `IDEMPOTENCY_CLEANUP_HOURS` (design §13); the manual admin trigger runs the
 * checks only (no cleanup) so an operator triggering a run never silently
 * prunes keys.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);

  const { applied } = await runMigrations(pool);
  if (applied.length > 0) {
    console.log(`Migrations applied: ${applied.join(", ")}`);
  }

  if (!cron.validate(config.RECON_CRON)) {
    throw new Error(`invalid RECON_CRON expression: ${config.RECON_CRON}`);
  }

  cron.schedule(config.RECON_CRON, () => {
    void runScheduled(pool, config.IDEMPOTENCY_CLEANUP_HOURS);
  });

  console.log(`wallet-ledger worker started; reconciliation cron: ${config.RECON_CRON}`);
}

/**
 * One scheduled reconciliation tick. Errors are caught and logged (never thrown
 * out of the cron callback) so a single failed run does not crash the worker;
 * cron retries on the next schedule (design §13 error handling).
 */
async function runScheduled(
  pool: import("pg").Pool,
  cleanupHours: number,
): Promise<void> {
  try {
    const outcome = await runReconciliation(pool, {
      lockedBy: "cron",
      idempotencyCleanupHours: cleanupHours,
    });
    if (outcome.kind === "locked") {
      console.log("scheduled reconciliation skipped: another run holds the lock");
    } else if (outcome.kind === "error") {
      console.error(`scheduled reconciliation errored: ${outcome.message}`);
    } else {
      console.log(
        `scheduled reconciliation run ${outcome.runId} ${outcome.status}: ` +
          `${outcome.problemCount} problem(s)`,
      );
    }
  } catch (err) {
    console.error(
      `scheduled reconciliation threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
