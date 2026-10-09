import type { Pool } from "pg";
import { query } from "../db/query.js";
import { AppError } from "../http/errors.js";
import type { LlmClient } from "../llm/LlmClient.js";
import { buildStatementPrompt } from "../llm/statementPrompt.js";
import { getAccount } from "./walletService.js";

/**
 * Statement reads (design §8). A statement row is a ledger entry on the wallet's
 * account joined to its transfer, newest first. Ordering is ALWAYS
 * `created_at DESC, id DESC` on the ledger entry — a total order that is stable
 * for both OFFSET and keyset (cursor) pagination.
 */
export interface StatementItem {
  entry_id: string;
  transfer_id: string;
  direction: string;
  amount: string;
  created_at: string;
  transfer_type: string;
  transfer_status: string;
  note: string | null;
  counterparty_account_id: string;
}

export interface OffsetPage {
  items: StatementItem[];
  limit: number;
  offset: number;
}

export interface CursorPage {
  items: StatementItem[];
  next_cursor: string | null;
}

const SELECT_COLUMNS = `
  le.id            AS entry_id,
  le.transfer_id   AS transfer_id,
  le.direction     AS direction,
  le.amount        AS amount,
  le.created_at    AS created_at,
  t.type           AS transfer_type,
  t.status         AS transfer_status,
  t.note           AS note,
  CASE WHEN t.from_account_id = le.account_id THEN t.to_account_id
       ELSE t.from_account_id END AS counterparty_account_id`;

/**
 * OFFSET pagination (design §8): `ORDER BY created_at DESC, id DESC` with
 * LIMIT/OFFSET. Validates the wallet exists first (404 otherwise).
 */
export async function getStatementOffset(
  pool: Pool,
  accountId: bigint,
  limit: number,
  offset: number,
): Promise<OffsetPage> {
  await getAccount(pool, accountId); // 404 if the wallet does not exist

  const result = await query<StatementItem>(
    pool,
    `SELECT ${SELECT_COLUMNS}
     FROM ledger_entries le
     JOIN transfers t ON t.id = le.transfer_id
     WHERE le.account_id = $1
     ORDER BY le.created_at DESC, le.id DESC
     LIMIT $2 OFFSET $3`,
    [accountId.toString(), limit, offset],
  );

  return { items: result.rows, limit, offset };
}

/**
 * Keyset (cursor) pagination (design §8, bonus): a stable cursor on
 * `(created_at, id)` encoded as opaque base64. Each page returns `next_cursor`
 * (base64 of the last row's created_at + id) or null when the page is the last.
 */
export async function getStatementCursor(
  pool: Pool,
  accountId: bigint,
  limit: number,
  cursor: string | undefined,
): Promise<CursorPage> {
  await getAccount(pool, accountId); // 404 if the wallet does not exist

  const decoded = cursor ? decodeCursor(cursor) : null;

  let result;
  if (decoded) {
    // Keyset predicate for DESC order: fetch rows strictly "older" than the
    // cursor by the (created_at, id) total order.
    result = await query<StatementItem>(
      pool,
      `SELECT ${SELECT_COLUMNS}
       FROM ledger_entries le
       JOIN transfers t ON t.id = le.transfer_id
       WHERE le.account_id = $1
         AND (le.created_at, le.id) < ($2::timestamptz, $3::bigint)
       ORDER BY le.created_at DESC, le.id DESC
       LIMIT $4`,
      [accountId.toString(), decoded.createdAt, decoded.id, limit],
    );
  } else {
    result = await query<StatementItem>(
      pool,
      `SELECT ${SELECT_COLUMNS}
       FROM ledger_entries le
       JOIN transfers t ON t.id = le.transfer_id
       WHERE le.account_id = $1
       ORDER BY le.created_at DESC, le.id DESC
       LIMIT $2`,
      [accountId.toString(), limit],
    );
  }

  const items = result.rows;
  // A full page implies there MAY be more; emit a cursor from the last row.
  let nextCursor: string | null = null;
  if (items.length === limit && items.length > 0) {
    const last = items[items.length - 1]!;
    nextCursor = encodeCursor(last.created_at, last.entry_id);
  }

  return { items, next_cursor: nextCursor };
}

interface DecodedCursor {
  createdAt: string;
  id: string;
}

/** Encode a `(created_at, id)` keyset into an opaque base64 cursor. */
function encodeCursor(createdAt: string, id: string): string {
  const payload = JSON.stringify({ c: createdAt, i: id });
  return Buffer.from(payload, "utf8").toString("base64");
}

/** Decode an opaque base64 cursor; a malformed cursor is a VALIDATION_ERROR. */
function decodeCursor(cursor: string): DecodedCursor {
  try {
    const json = Buffer.from(cursor, "base64").toString("utf8");
    const parsed = JSON.parse(json) as { c?: unknown; i?: unknown };
    if (typeof parsed.c !== "string" || typeof parsed.i !== "string") {
      throw new Error("missing fields");
    }
    return { createdAt: parsed.c, id: parsed.i };
  } catch {
    throw new AppError("VALIDATION_ERROR", "invalid cursor");
  }
}

/* -------------------------------------------------------------------------- */
/* Statement ask (design §10, §10.1, FR-14)                                   */
/* -------------------------------------------------------------------------- */

/**
 * The validated LLM parse (one of the four supported question types). The LLM
 * returns ONLY this JSON; our code validates it and builds the parameterized
 * SQL — the LLM never writes SQL and never widens scope (design §10).
 */
export interface ParsedQuestion {
  type: 1 | 2 | 3 | 4;
  counterparty?: string;
  from: string;
  to: string;
}

/** The answer returned to the caller: `answer` is a string (money/count). */
export interface AskAnswer {
  type: number;
  answer: string;
  transfer_ids: string[];
}

/** ISO date `YYYY-MM-DD` with a real calendar date. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Validate the raw LLM text against the strict 4-type schema (design §10). Any
 * deviation (unparseable, unknown type, bad/`from > to` dates, missing
 * counterparty for type 1) -> throw `422 UNSUPPORTED_QUESTION`. This runs in
 * CODE, not the model, so a prompt-injected or malformed reply is rejected.
 */
export function parseAndValidate(raw: string): ParsedQuestion {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw unsupported("could not parse the question");
  }
  if (!parsed || typeof parsed !== "object") {
    throw unsupported("could not parse the question");
  }
  const obj = parsed as Record<string, unknown>;
  const type = obj.type;
  if (type !== 1 && type !== 2 && type !== 3 && type !== 4) {
    throw unsupported("unsupported question type");
  }
  if (!isValidIsoDate(obj.from) || !isValidIsoDate(obj.to)) {
    throw unsupported("question is missing a valid date range");
  }
  const from = obj.from as string;
  const to = obj.to as string;
  if (from > to) {
    throw unsupported("date range is inverted (from must be <= to)");
  }
  if (type === 1) {
    if (typeof obj.counterparty !== "string" || obj.counterparty.length === 0) {
      throw unsupported("a counterparty name is required for this question");
    }
    return { type, counterparty: obj.counterparty, from, to };
  }
  return { type, from, to };
}

function unsupported(message: string): AppError {
  return new AppError("UNSUPPORTED_QUESTION", message);
}

/** Inclusive-day upper bound: the day AFTER `to`, so `created_at < to+1day`. */
function toExclusiveUpper(to: string): string {
  const d = new Date(`${to}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Answer a natural-language statement question for the path user (design §10,
 * §10.1, FR-14). The flow:
 *   1. build the ask prompt (question fenced as DATA) and call the LLM;
 *   2. validate the JSON reply in CODE against the 4-type schema (422 on any
 *      deviation);
 *   3. for type 1, resolve the counterparty case-insensitively, RESTRICTED to
 *      users the path user has transacted with (zero/multiple -> 422);
 *   4. run the corresponding parameterized SQL ALWAYS scoped to the path user's
 *      accounts (the path user id is bound as a parameter), aggregating across
 *      ALL the path user's wallets;
 *   5. return `{ type, answer, transfer_ids }`.
 *
 * Nothing the question (or any transfer note surfaced in it) says can change
 * the account scope — the SQL is built by code and the path user id is the only
 * identity in it (AC-10).
 */
export async function answerStatementQuestion(
  pool: Pool,
  llm: LlmClient,
  pathUserId: bigint,
  question: string,
): Promise<AskAnswer> {
  // The path user must exist (clean 404 rather than an empty aggregate).
  const userExists = await query(pool, "SELECT 1 FROM users WHERE id = $1", [
    pathUserId.toString(),
  ]);
  if (userExists.rowCount === 0) {
    throw new AppError("NOT_FOUND", `user ${pathUserId} not found`);
  }

  const raw = await llm.complete(buildStatementPrompt(question));
  const q = parseAndValidate(raw);
  const upper = toExclusiveUpper(q.to);

  switch (q.type) {
    case 1:
      return answerSentToCounterparty(pool, pathUserId, q.counterparty!, q.from, upper);
    case 2:
      return answerReceived(pool, pathUserId, q.from, upper);
    case 3:
      return answerLargest(pool, pathUserId, q.from, upper);
    case 4:
      return answerCount(pool, pathUserId, q.from, upper);
  }
}

/**
 * Resolve a counterparty name to a single user id, case-insensitively and
 * EXACTLY (`lower(name)=lower($1)`), restricted to users the path user has
 * actually transacted with via a `peer_transfer` on any wallet the path user
 * owns (design §10.1). Zero or multiple matches -> 422 UNSUPPORTED_QUESTION.
 */
async function resolveCounterparty(
  pool: Pool,
  pathUserId: bigint,
  name: string,
): Promise<bigint> {
  const result = await query<{ id: string }>(
    pool,
    `SELECT DISTINCT cp.id
     FROM users cp
     JOIN accounts cpa ON cpa.user_id = cp.id
     JOIN transfers t
       ON (t.from_account_id = cpa.id OR t.to_account_id = cpa.id)
     JOIN accounts mine
       ON (mine.id = t.from_account_id OR mine.id = t.to_account_id)
      AND mine.user_id = $1
     WHERE t.type = 'peer_transfer'
       AND cp.id <> $1
       AND lower(cp.name) = lower($2)`,
    [pathUserId.toString(), name],
  );
  if (result.rowCount === 0) {
    throw unsupported(`no counterparty named '${name}' in your transfer history`);
  }
  if (result.rowCount! > 1) {
    throw unsupported(`counterparty name '${name}' is ambiguous`);
  }
  return BigInt(result.rows[0]!.id);
}

/**
 * Type 1: total sent (peer_transfer, COMPLETED) from ANY wallet the path user
 * owns TO any wallet the resolved counterparty owns, in the date range. Returns
 * the summed amount (paise string) and the contributing transfer ids.
 */
async function answerSentToCounterparty(
  pool: Pool,
  pathUserId: bigint,
  counterpartyName: string,
  from: string,
  upperExclusive: string,
): Promise<AskAnswer> {
  const counterpartyId = await resolveCounterparty(pool, pathUserId, counterpartyName);
  const result = await query<{ id: string; amount: string }>(
    pool,
    `SELECT t.id, t.amount
     FROM transfers t
     JOIN accounts src ON src.id = t.from_account_id AND src.user_id = $1
     JOIN accounts dst ON dst.id = t.to_account_id   AND dst.user_id = $2
     WHERE t.type = 'peer_transfer'
       AND t.status = 'COMPLETED'
       AND t.created_at >= $3::date
       AND t.created_at <  $4::date
     ORDER BY t.id`,
    [pathUserId.toString(), counterpartyId.toString(), from, upperExclusive],
  );
  const total = result.rows.reduce((acc, r) => acc + BigInt(r.amount), 0n);
  return { type: 1, answer: total.toString(), transfer_ids: result.rows.map((r) => r.id) };
}

/**
 * Type 2: total received, i.e. the sum of credit ledger entries on the path
 * user's wallets from COMPLETED peer transfers in the range. Scoped to the path
 * user's accounts; transfer ids are the contributing transfers.
 */
async function answerReceived(
  pool: Pool,
  pathUserId: bigint,
  from: string,
  upperExclusive: string,
): Promise<AskAnswer> {
  const result = await query<{ id: string; amount: string }>(
    pool,
    `SELECT t.id, le.amount
     FROM ledger_entries le
     JOIN accounts a ON a.id = le.account_id AND a.user_id = $1
     JOIN transfers t ON t.id = le.transfer_id
     WHERE le.direction = 'credit'
       AND t.type = 'peer_transfer'
       AND t.status = 'COMPLETED'
       AND t.created_at >= $2::date
       AND t.created_at <  $3::date
     ORDER BY t.id`,
    [pathUserId.toString(), from, upperExclusive],
  );
  const total = result.rows.reduce((acc, r) => acc + BigInt(r.amount), 0n);
  // Distinct transfer ids (a transfer credits at most one of the user's wallets).
  const ids = Array.from(new Set(result.rows.map((r) => r.id)));
  return { type: 2, answer: total.toString(), transfer_ids: ids };
}

/**
 * Type 3: the largest single COMPLETED transfer touching any wallet the path
 * user owns (sent or received) in the range. Returns the max amount and the id
 * of that transfer (empty when there is none).
 */
async function answerLargest(
  pool: Pool,
  pathUserId: bigint,
  from: string,
  upperExclusive: string,
): Promise<AskAnswer> {
  const result = await query<{ id: string; amount: string }>(
    pool,
    `SELECT DISTINCT t.id, t.amount
     FROM transfers t
     JOIN accounts a
       ON (a.id = t.from_account_id OR a.id = t.to_account_id)
      AND a.user_id = $1
     WHERE t.status = 'COMPLETED'
       AND t.created_at >= $2::date
       AND t.created_at <  $3::date
     ORDER BY t.amount DESC, t.id ASC
     LIMIT 1`,
    [pathUserId.toString(), from, upperExclusive],
  );
  const row = result.rows[0];
  if (!row) {
    return { type: 3, answer: "0", transfer_ids: [] };
  }
  return { type: 3, answer: BigInt(row.amount).toString(), transfer_ids: [row.id] };
}

/**
 * Type 4: count of COMPLETED transfers touching any wallet the path user owns
 * (sent or received) in the range. Returns the count and the contributing ids.
 */
async function answerCount(
  pool: Pool,
  pathUserId: bigint,
  from: string,
  upperExclusive: string,
): Promise<AskAnswer> {
  const result = await query<{ id: string }>(
    pool,
    `SELECT DISTINCT t.id
     FROM transfers t
     JOIN accounts a
       ON (a.id = t.from_account_id OR a.id = t.to_account_id)
      AND a.user_id = $1
     WHERE t.status = 'COMPLETED'
       AND t.created_at >= $2::date
       AND t.created_at <  $3::date
     ORDER BY t.id`,
    [pathUserId.toString(), from, upperExclusive],
  );
  return {
    type: 4,
    answer: result.rowCount!.toString(),
    transfer_ids: result.rows.map((r) => r.id),
  };
}
