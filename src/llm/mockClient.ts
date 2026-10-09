import type { LlmClient } from "./LlmClient.js";
import { extractQuestion } from "./statementPrompt.js";
import { extractRuleName, EXPLAIN_OPEN } from "./explainPrompt.js";

/**
 * Deterministic MockLlmClient (design §10.1). No network, no API key; used in
 * ALL tests and in CI/compose by default (LLM_PROVIDER=mock). It is NOT a fixed
 * blob — it inspects the prompt and routes:
 *
 *   - ASK prompt kind: extract the quoted question from the delimited data
 *     block (the SAME block the real model would read) and return the canned
 *     parse JSON via `ASK_FIXTURE` using first-case-insensitive-substring-match
 *     -wins. No match -> an intentionally invalid shape `{"type":99}` so the
 *     422 UNSUPPORTED_QUESTION path is exercised.
 *   - EXPLAIN prompt kind: return a fixed two-sentence explanation plus a label
 *     derived from the firing rule name (e.g. single_over_max -> "review").
 *
 * `ASK_FIXTURE` is EXPORTED so statementAsk.test.ts imports the exact same
 * table and asserts one parse per question (design §10.1).
 */

/** The 4-type parse shape the mock returns (as JSON text) for a matched question. */
export interface AskParse {
  type: number;
  counterparty?: string;
  from?: string;
  to?: string;
}

/** One fixture row: a lowercased substring to match, and the parse it yields. */
export interface AskFixtureEntry {
  /** Human-facing sample question (documentation / test seeding reference). */
  question: string;
  /** Lowercased substring; the FIRST entry contained in the lowered question wins. */
  match: string;
  /** The parse JSON the mock returns for this question. */
  parse: AskParse;
}

/**
 * The authoritative §10.1 fixture: 10 sample questions -> expected parse. Order
 * matters: matching is "first entry whose `match` is a substring of the
 * lowercased question wins". Entries 1 and 9 both mention "send to rahul", so
 * each keys on the fuller month-qualified substring and the August entry is
 * listed first; neither can shadow the other. Question 10 has no entry and
 * falls through to the invalid `{"type":99}` shape.
 */
export const ASK_FIXTURE: readonly AskFixtureEntry[] = [
  {
    question: "How much did I send to rahul in August 2026?",
    match: "send to rahul in august",
    parse: { type: 1, counterparty: "Rahul", from: "2026-08-01", to: "2026-08-31" },
  },
  {
    question: "How much did I send to rahul in July 2026? (empty range)",
    match: "send to rahul in july",
    parse: { type: 1, counterparty: "Rahul", from: "2026-07-01", to: "2026-07-31" },
  },
  {
    question: "Total I sent to priya last month?",
    match: "sent to priya",
    parse: { type: 1, counterparty: "Priya", from: "2026-08-01", to: "2026-08-31" },
  },
  {
    question: "What did I receive between Aug 1 and Aug 31 2026?",
    match: "receive",
    parse: { type: 2, from: "2026-08-01", to: "2026-08-31" },
  },
  {
    question: "Total money received in August 2026?",
    match: "money received",
    parse: { type: 2, from: "2026-08-01", to: "2026-08-31" },
  },
  {
    question: "What was my largest transfer in August 2026?",
    match: "largest transfer",
    parse: { type: 3, from: "2026-08-01", to: "2026-08-31" },
  },
  {
    question: "Show my biggest payment that month.",
    match: "biggest payment",
    parse: { type: 3, from: "2026-08-01", to: "2026-08-31" },
  },
  {
    question: "How many transfers did I make in August 2026?",
    match: "how many transfers",
    parse: { type: 4, from: "2026-08-01", to: "2026-08-31" },
  },
  {
    question: "Count of transactions in August 2026?",
    match: "count of transactions",
    parse: { type: 4, from: "2026-08-01", to: "2026-08-31" },
  },
] as const;

/**
 * The §10.1 "no match" sentinel: an intentionally invalid shape so the code
 * validation rejects it with 422 UNSUPPORTED_QUESTION. Question #10
 * ("what is the weather today?") routes here.
 */
export const ASK_NO_MATCH: AskParse = { type: 99 };

/**
 * Route a question to its fixture parse (first-substring-match-wins, case
 * -insensitive). Exported so a test can assert the routing independently of the
 * client plumbing. Returns the invalid `{type:99}` shape when nothing matches.
 */
export function routeAskQuestion(question: string): AskParse {
  const lowered = question.toLowerCase();
  for (const entry of ASK_FIXTURE) {
    if (lowered.includes(entry.match)) {
      return entry.parse;
    }
  }
  return ASK_NO_MATCH;
}

/**
 * Map a firing rule name to a deterministic Part-B label (design §10.1): the
 * hold rules read as "review", the flag rule as "likely_ok"; an unknown rule
 * falls back to "review". The explanation is a fixed two-sentence string.
 */
function labelForRule(ruleName: string): "likely_ok" | "review" | "likely_fraud" {
  switch (ruleName) {
    case "single_over_max":
    case "velocity":
      return "review";
    case "rapid_drain":
      return "likely_ok";
    default:
      return "review";
  }
}

export class MockLlmClient implements LlmClient {
  async complete(prompt: string): Promise<string> {
    // EXPLAIN prompt kind: fenced flag-data block present.
    if (prompt.includes(EXPLAIN_OPEN)) {
      const ruleName = extractRuleName(prompt) ?? "unknown";
      const explanation =
        `This transfer was flagged by the ${ruleName} rule. ` +
        "Review the wallet's recent activity before releasing or failing it.";
      return JSON.stringify({ explanation, label: labelForRule(ruleName) });
    }

    // ASK prompt kind: extract the quoted question and route via the fixture.
    const question = extractQuestion(prompt);
    if (question === null) {
      return JSON.stringify(ASK_NO_MATCH);
    }
    return JSON.stringify(routeAskQuestion(question));
  }
}
