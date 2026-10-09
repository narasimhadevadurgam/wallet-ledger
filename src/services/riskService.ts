import type { Pool, PoolClient } from "pg";
import type { LlmClient } from "../llm/LlmClient.js";
import {
  buildExplainPrompt,
  type ExplainTransfer,
} from "../llm/explainPrompt.js";

/**
 * Fraud rules (design §9.1 step 6, §14 Part A + Part B).
 *
 * Part A runs INSIDE the transfer transaction, under the FOR UPDATE account
 * locks, AFTER the step-5 funds check and BEFORE any ledger write. Thresholds
 * come from the `risk_rules` table (never hard-coded). The initial rule set:
 *   - single_over_max : the transfer amount exceeds `threshold`.
 *   - velocity        : the count of transfers from the source wallet within
 *                       `window_seconds` (this one included) exceeds `threshold`.
 *   - rapid_drain     : the outflow sum from the source wallet within
 *                       `window_seconds` (this one included) exceeds `threshold`.
 * A fired `hold` rule -> transfer committed HELD, no money moved, a risk_flags
 * row written, release required. A fired `flag` rule -> a risk_flags row is
 * written and the transfer PROCEEDS (allow-with-flag).
 *
 * The seeded defaults (migration 0015) are pinned high so normal operation
 * never trips them; AC-9 lowers velocity for its own run (design §14 finding 8).
 *
 * Part B is the nightly worker step (`explainFlagsForDay`): for each transfer
 * flagged that day it asks the LLM to explain the firing rule in two sentences
 * and classify it, then writes `explanation` + `label` back to `risk_flags`.
 */

/** A row from `risk_rules` (enabled rules only are evaluated). */
interface RiskRule {
  rule_name: string;
  threshold: string; // BIGINT as string from pg
  window_seconds: number | null;
  action: "hold" | "flag";
}

/** The decision Part-A hands back to transferService. */
export type RiskDecision =
  | { decision: "proceed"; flagged: string[] }
  | { decision: "hold"; ruleName: string };

/**
 * Evaluate the enabled risk rules for the transfer being processed (design §9.1
 * step 6). Called from transferService under the FOR UPDATE locks, after the
 * funds check. The FIRST firing `hold` rule short-circuits to a hold; any
 * firing `flag` rules are collected so the caller records them after the
 * transfer row exists. Rules are evaluated in a stable order (by id).
 *
 * `sourceAccountId` is the wallet money leaves (the sender for a peer transfer /
 * withdrawal, the system cash_in for a top-up — fraud rules only meaningfully
 * fire on user-wallet outflow, but the predicates are id-scoped so a system
 * source simply has no recent user activity).
 */
export async function evaluateRisk(
  client: PoolClient,
  params: { sourceAccountId: bigint; amount: bigint },
): Promise<RiskDecision> {
  const rules = await loadEnabledRules(client);

  const flagged: string[] = [];
  for (const rule of rules) {
    const fired = await ruleFires(client, rule, params);
    if (!fired) continue;
    if (rule.action === "hold") {
      // First hold wins: stop evaluating and let the caller commit HELD.
      return { decision: "hold", ruleName: rule.rule_name };
    }
    // action === 'flag': remember it; the transfer still proceeds.
    flagged.push(rule.rule_name);
  }
  return { decision: "proceed", flagged };
}

/** Load enabled rules in a deterministic order (by id). */
async function loadEnabledRules(client: PoolClient): Promise<RiskRule[]> {
  const result = await client.query<RiskRule>(
    `SELECT rule_name, threshold, window_seconds, action
     FROM risk_rules
     WHERE enabled = true
     ORDER BY id`,
  );
  return result.rows;
}

/** Evaluate a single rule's SQL predicate against committed history + this transfer. */
async function ruleFires(
  client: PoolClient,
  rule: RiskRule,
  params: { sourceAccountId: bigint; amount: bigint },
): Promise<boolean> {
  const threshold = BigInt(rule.threshold);
  const sourceId = params.sourceAccountId.toString();

  switch (rule.rule_name) {
    case "single_over_max":
      // The amount of THIS transfer exceeds the configured max.
      return params.amount > threshold;

    case "velocity": {
      // Count transfers already sent from this wallet within the window; this
      // transfer is the (count + 1)th. Fires when that count exceeds threshold.
      const windowSeconds = rule.window_seconds ?? 60;
      const result = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n
         FROM transfers
         WHERE from_account_id = $1
           AND created_at >= now() - ($2 || ' seconds')::interval`,
        [sourceId, windowSeconds.toString()],
      );
      const priorCount = BigInt(result.rows[0]?.n ?? "0");
      return priorCount + 1n > threshold;
    }

    case "rapid_drain": {
      // Sum outflow (debits on the source account) within the window; this
      // transfer adds `amount`. Fires when the running total exceeds threshold.
      // Intentional asymmetry vs. `velocity`: velocity counts `transfers` rows
      // (which includes HELD transfers that moved no money), while rapid_drain
      // sums only *settled* debits in `ledger_entries` (a HELD transfer writes
      // none). So a held-then-released drain contributes to this window at
      // release time, not at hold time. This is deliberate: rapid_drain measures
      // money that actually left, velocity measures attempt rate.
      const windowSeconds = rule.window_seconds ?? 60;
      const result = await client.query<{ s: string }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS s
         FROM ledger_entries
         WHERE account_id = $1
           AND direction = 'debit'
           AND created_at >= now() - ($2 || ' seconds')::interval`,
        [sourceId, windowSeconds.toString()],
      );
      const priorOutflow = BigInt(result.rows[0]?.s ?? "0");
      return priorOutflow + params.amount > threshold;
    }

    default:
      // Unknown rule name: do not fire (fail open to "proceed"); the design's
      // rule set is fixed and new rules add a case here.
      return false;
  }
}

/**
 * Write a `risk_flags` row for a fired rule (design §14). Runs on the SAME
 * transaction client as the transfer so the flag commits atomically with the
 * HELD/flagged transfer. `explanation` and `label` are left NULL; the nightly
 * Part-B step fills them in.
 */
export async function writeRiskFlag(
  client: PoolClient,
  transferId: bigint,
  ruleName: string,
): Promise<void> {
  await client.query(
    `INSERT INTO risk_flags (transfer_id, rule_name) VALUES ($1, $2)`,
    [transferId.toString(), ruleName],
  );
}

/** The LLM's validated explanation reply (Part B). */
interface ExplainReply {
  explanation: string;
  label: "likely_ok" | "review" | "likely_fraud";
}

/** Parse + validate the LLM's explanation JSON; return null on any invalid shape. */
function parseExplainReply(raw: string): ExplainReply | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const explanation = obj.explanation;
  const label = obj.label;
  if (typeof explanation !== "string" || explanation.length === 0) return null;
  if (label !== "likely_ok" && label !== "review" && label !== "likely_fraud") {
    return null;
  }
  return { explanation, label };
}

/**
 * Nightly LLM explanation step (design §14 Part B). For each risk_flags row
 * created on `day` (UTC date, YYYY-MM-DD) that is not yet explained, send the
 * firing rule + the flagged wallet's last 10 transfers to the LLM, validate the
 * JSON reply in code, and store the 2-sentence explanation + label. The LLM is
 * mocked in tests. Runs on the pool (no money is touched); each flag is updated
 * independently so one bad reply does not abort the batch.
 *
 * The "flagged wallet" is the source (`from_account_id`) of the flagged
 * transfer — the wallet whose activity tripped the rule.
 *
 * Returns the number of flags successfully explained.
 */
export async function explainFlagsForDay(
  pool: Pool,
  llm: LlmClient,
  day: string,
): Promise<number> {
  const flags = await pool.query<{
    flag_id: string;
    transfer_id: string;
    rule_name: string;
    from_account_id: string;
  }>(
    `SELECT rf.id AS flag_id, rf.transfer_id, rf.rule_name, t.from_account_id
     FROM risk_flags rf
     JOIN transfers t ON t.id = rf.transfer_id
     WHERE rf.explanation IS NULL
       AND rf.created_at::date = $1::date
     ORDER BY rf.id`,
    [day],
  );

  let explained = 0;
  for (const flag of flags.rows) {
    const recent = await lastTenTransfers(pool, flag.from_account_id);
    const prompt = buildExplainPrompt(flag.rule_name, recent);
    const raw = await llm.complete(prompt);
    const reply = parseExplainReply(raw);
    if (!reply) continue; // leave NULL; a later run can retry.
    await pool.query(
      `UPDATE risk_flags SET explanation = $2, label = $3 WHERE id = $1`,
      [flag.flag_id, reply.explanation, reply.label],
    );
    explained += 1;
  }
  return explained;
}

/** The flagged wallet's most recent 10 transfers (either direction) as data. */
async function lastTenTransfers(
  pool: Pool,
  accountId: string,
): Promise<ExplainTransfer[]> {
  const result = await pool.query<ExplainTransfer>(
    `SELECT id::text AS transfer_id, type, status, amount::text AS amount,
            created_at::text AS created_at
     FROM transfers
     WHERE from_account_id = $1 OR to_account_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT 10`,
    [accountId],
  );
  return result.rows;
}
