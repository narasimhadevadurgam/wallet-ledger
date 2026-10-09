import cron from "node-cron";
import { loadConfig } from "./config/env.js";
import { createPool } from "./db/pool.js";
import { runMigrations } from "./db/migrateRunner.js";
import { createLlmClient } from "./llm/factory.js";
import type { LlmClient } from "./llm/LlmClient.js";
import { run as runReconciliation } from "./services/reconciliationService.js";
import { explainFlagsForDay } from "./services/riskService.js";

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
  const llm = createLlmClient({
    provider: config.LLM_PROVIDER,
    ollamaUrl: config.OLLAMA_URL,
    ollamaModel: config.OLLAMA_MODEL,
  });

  const { applied } = await runMigrations(pool);
  if (applied.length > 0) {
    console.log(`Migrations applied: ${applied.join(", ")}`);
  }

  if (!cron.validate(config.RECON_CRON)) {
    throw new Error(`invalid RECON_CRON expression: ${config.RECON_CRON}`);
  }

  cron.schedule(config.RECON_CRON, () => {
    void runScheduled(pool, config.IDEMPOTENCY_CLEANUP_HOURS);
    void runFlagExplanations(pool, llm);
  });

  console.log(`wallet-ledger worker started; reconciliation cron: ${config.RECON_CRON}`);
}

/**
 * Nightly LLM explanation step (design §14 Part B). For each risk_flags row
 * created today that is not yet explained, asks the LLM (mock by default) to
 * explain the firing rule and classify it, then stores the result. Errors are
 * caught and logged so a model hiccup never crashes the worker.
 */
async function runFlagExplanations(
  pool: import("pg").Pool,
  llm: LlmClient,
): Promise<void> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const explained = await explainFlagsForDay(pool, llm, today);
    console.log(`nightly flag explanation: ${explained} flag(s) explained for ${today}`);
  } catch (err) {
    console.error(
      `nightly flag explanation threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
