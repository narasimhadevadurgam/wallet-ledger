import { Router } from "express";
import type { Pool } from "pg";
import { run as runReconciliation } from "../../services/reconciliationService.js";
import { releaseTransfer } from "../../services/transferService.js";
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
 * The release route (FEAT-006) runs the single-transaction HELD-completion
 * (design §9.1.1): re-lock the HELD transfer + both accounts ascending, re-check
 * funds, write the balanced ledger entries, and transition HELD->COMPLETED
 * (or HELD->FAILED + 422 when the sender drained since the hold).
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
   * Release a HELD transfer (design §9.1.1 / FR-12). Idempotency-exempt: a
   * second call sees a non-HELD row and returns `409 TRANSFER_NOT_HELD`. An
   * insufficient-funds release transitions the transfer to FAILED and returns
   * `422 INSUFFICIENT_FUNDS`.
   */
  router.post("/admin/transfers/:id/release", async (req, res, next) => {
    try {
      const { id } = parseOrThrow(idParamSchema, req.params);
      const outcome = await releaseTransfer(pool, id, "admin");
      // An underfunded release committed the HELD->FAILED transition (design
      // §9.1.1); surface it as 422 AFTER that commit, so the transfer stays
      // permanently FAILED rather than being rolled back to HELD.
      if (outcome.kind === "insufficient") {
        throw new AppError("INSUFFICIENT_FUNDS", outcome.message);
      }
      const result = outcome.result;
      res.status(200).json({
        transfer_id: result.transfer_id,
        status: result.status,
        type: result.type,
        amount: result.amount,
        fee: result.fee,
        wallet_balance: result.wallet_balance,
        request_id: req.request_id,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
