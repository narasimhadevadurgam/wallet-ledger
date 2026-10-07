import type { Pool } from "pg";
import { query } from "../db/query.js";
import { AppError } from "../http/errors.js";
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
