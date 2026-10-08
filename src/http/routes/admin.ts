import { Router } from "express";
import type { Pool } from "pg";
import { run as runReconciliation } from "../../services/reconciliationService.js";
import { AppError } from "../errors.js";
import { idParamSchema, parseOrThrow } from "../validation.js";

/**
 * Admin routes (design §8, §13):
 *   POST /admin/reconciliation/run     -> trigger a reconciliation run
 *   POST /admin/transfers/{id}/release -> release a HELD transfer (FEAT-006)
 *
 * Both are IDEMPOTENCY-EXEMPT (design §8 "Idempotency scope"): they carry no
 * `Idempotency-Key` and are made safe to repeat by their OWN guards — the
 * `job_locks` NOWAIT lock for reconciliation (409 RECON_LOCKED) and the
 * `409 TRANSFER_NOT_HELD` status guard for release. They are therefore NOT
 * wired to `requireIdempotency`.
 *
 * The release route is a STUB here (FEAT-005): it validates the id and returns
 * `409 TRANSFER_NOT_HELD`. FEAT-006 fills in the HELD-completion money logic
 * (hold/release belongs with fraud, design §14/FR-12). FEAT-006 extends THIS
 * router (same `adminRouter(pool)` shape) rather than replacing it.
 */
export function adminRouter(pool: Pool): Router {
  const router = Router();

  /**
   * Trigger reconciliation. The service takes the `job_locks` row FOR UPDATE
   * NOWAIT as its first statement, so a concurrent run returns `locked` here,
   * which maps to `409 RECON_LOCKED` (design §13). A completed run returns
   * `202 {run_id}`. A check error surfaces as `500 INTERNAL`.
   */
  router.post("/admin/reconciliation/run", async (req, res, next) => {
    try {
      const outcome = await runReconciliation(pool, { lockedBy: "admin-trigger" });
      if (outcome.kind === "locked") {
        throw new AppError(
          "RECON_LOCKED",
          "a reconciliation run is already in progress",
        );
      }
      if (outcome.kind === "error") {
        throw new AppError("INTERNAL", "reconciliation run failed");
      }
      res.status(202).json({
        run_id: outcome.runId.toString(),
        status: outcome.status,
        problem_count: outcome.problemCount,
        request_id: req.request_id,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Release a HELD transfer (FEAT-006). STUB for now: validate the id, then
   * return `409 TRANSFER_NOT_HELD`. FEAT-006 replaces the body with the
   * single-transaction release (re-lock, re-check funds, write ledger entries,
   * audit HELD->COMPLETED or HELD->FAILED) per design §9.1.1.
   */
  router.post("/admin/transfers/:id/release", async (req, res, next) => {
    try {
      parseOrThrow(idParamSchema, req.params);
      // FEAT-006 implements the money path; until then a release is a no-op
      // conflict (the transfer is not in a releasable HELD state we can honor).
      throw new AppError(
        "TRANSFER_NOT_HELD",
        "release is not available until the hold/release flow is implemented",
      );
    } catch (err) {
      next(err);
    }
  });

  return router;
}
