import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runMigrations } from "../../src/db/migrateRunner.js";
import {
  getStatementCursor,
  getStatementOffset,
} from "../../src/services/statementService.js";
import { SKIP_INTEGRATION, createTestPool } from "./helpers.js";

/**
 * AC-14 — statement pagination (design §8). Seed several transfers for one
 * wallet, then assert:
 *   - OFFSET pagination returns rows in `created_at DESC, id DESC` order and
 *     pages tile the full set with no gaps/overlaps;
 *   - the cursor endpoint walks the SAME ordering with a stable keyset cursor,
 *     producing byte-identical row order to the OFFSET read.
 *
 * We write ledger entries with controlled, strictly-increasing `created_at` so
 * the ordering is deterministic and the DESC total order is unambiguous.
 */

const SEED_COUNT = 25;

describe.skipIf(SKIP_INTEGRATION)("statement pagination (AC-14)", () => {
  let pool: Pool;
  let walletId: bigint;

  beforeAll(async () => {
    pool = createTestPool();
    await runMigrations(pool);

    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (name, email, phone, kyc_status)
       VALUES ('Pagination', $1, $2, 'verified') RETURNING id`,
      [`pagination.${suffix}@example.com`, `+2${suffix.replace(/\D/g, "").slice(0, 13)}`],
    );
    const userId = user.rows[0]!.id;
    const wallet = await pool.query<{ id: string }>(
      `INSERT INTO accounts (user_id, is_system, system_type, currency, balance)
       VALUES ($1, false, NULL, 'INR', 0) RETURNING id`,
      [userId],
    );
    walletId = BigInt(wallet.rows[0]!.id);

    const cashIn = await pool.query<{ id: string }>(
      `SELECT id FROM accounts WHERE is_system = true AND system_type = 'cash_in'`,
    );
    const cashInId = cashIn.rows[0]!.id;

    // Seed SEED_COUNT top_up transfers, each with a balanced debit/credit pair
    // and a strictly-increasing created_at so DESC order is deterministic.
    const base = new Date("2024-01-01T00:00:00.000Z").getTime();
    for (let i = 0; i < SEED_COUNT; i++) {
      const ts = new Date(base + i * 60_000).toISOString();
      const transfer = await pool.query<{ id: string }>(
        `INSERT INTO transfers (type, status, amount, from_account_id, to_account_id, created_at)
         VALUES ('top_up', 'COMPLETED', $1, $2, $3, $4) RETURNING id`,
        [String(100 + i), cashInId, wallet.rows[0]!.id, ts],
      );
      const transferId = transfer.rows[0]!.id;
      await pool.query(
        `INSERT INTO ledger_entries (transfer_id, account_id, direction, amount, created_at) VALUES
           ($1, $2, 'debit', $3, $5), ($1, $4, 'credit', $3, $5)`,
        [transferId, cashInId, String(100 + i), wallet.rows[0]!.id, ts],
      );
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it("OFFSET pages are ordered created_at DESC, id DESC and tile the full set", async () => {
    const all = await getStatementOffset(pool, walletId, 100, 0);
    expect(all.items.length).toBe(SEED_COUNT);

    // Verify the ordering is a strict DESC total order on (created_at, id).
    for (let i = 1; i < all.items.length; i++) {
      const prev = all.items[i - 1]!;
      const cur = all.items[i]!;
      const prevKey: [string, bigint] = [prev.created_at, BigInt(prev.entry_id)];
      const curKey: [string, bigint] = [cur.created_at, BigInt(cur.entry_id)];
      expect(compareDesc(prevKey, curKey)).toBe(true);
    }

    // Two pages of 10 + a final page of 5 reconstruct the full ordered list.
    const page1 = await getStatementOffset(pool, walletId, 10, 0);
    const page2 = await getStatementOffset(pool, walletId, 10, 10);
    const page3 = await getStatementOffset(pool, walletId, 10, 20);
    const tiled = [...page1.items, ...page2.items, ...page3.items].map((r) => r.entry_id);
    expect(tiled).toEqual(all.items.map((r) => r.entry_id));
  });

  it("cursor pagination walks the same ordering with a stable keyset cursor", async () => {
    const all = await getStatementOffset(pool, walletId, 100, 0);
    const expectedOrder = all.items.map((r) => r.entry_id);

    const collected: string[] = [];
    let cursor: string | undefined;
    // Page size 10 -> 3 pages (10 + 10 + 5).
    for (let guard = 0; guard < 10; guard++) {
      const page = await getStatementCursor(pool, walletId, 10, cursor);
      collected.push(...page.items.map((r) => r.entry_id));
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }

    expect(collected).toEqual(expectedOrder);
  });
});

/** True when `a` strictly precedes `b` under DESC order of (created_at, id). */
function compareDesc(a: [string, bigint], b: [string, bigint]): boolean {
  if (a[0] !== b[0]) return a[0] > b[0];
  return a[1] > b[1];
}
