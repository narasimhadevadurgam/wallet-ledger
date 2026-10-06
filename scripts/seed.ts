import type { Pool, PoolClient } from "pg";
import { loadConfig } from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrateRunner.js";

/**
 * FR-17 bulk seed: 1,000 users, 2,000 wallets (2 per user), and 100,000
 * peer_transfer rows with balanced ledger entries, all via chunked multi-row
 * INSERTs so it stays fast and never violates a constraint.
 *
 * Shape of the seed (deterministic, so it is reusable):
 *   - Users u1..u1000; each owns wallets w(2k-1), w(2k).
 *   - Every wallet is funded by one opening top_up (cash_in -> wallet) of
 *     OPENING_BALANCE paise, so every wallet starts well above zero.
 *   - 100,000 peer_transfers move a small fixed amount from one wallet to the
 *     next (round-robin), each writing a balanced debit/credit pair. The source
 *     always has funds because OPENING_BALANCE >> total it can ever send here.
 *   - Stored balances are computed in memory and written in one bulk UPDATE at
 *     the end, so accounts.balance stays exactly equal to credits - debits
 *     (reconciliation check (c) passes on the seeded data).
 *
 * This is distinct from per-test seeding; it exists so `npm run seed` yields a
 * realistic data set for manual exploration and performance work (EXPLAIN).
 */

const USER_COUNT = 1000;
const WALLETS_PER_USER = 2;
const WALLET_COUNT = USER_COUNT * WALLETS_PER_USER; // 2000
const TRANSFER_COUNT = 100_000;
const PEER_AMOUNT = 100n; // paise per peer transfer
// Each wallet is the source of at most ceil(TRANSFER_COUNT / WALLET_COUNT)
// transfers; fund it far above that so it can never go negative.
const OPENING_BALANCE = 100_000_000n; // 1,000,000 INR in paise

/** Insert rows in chunks of this many to keep each statement a sane size. */
const CHUNK = 1000;

/** Build "($1,$2,...),($n,...)" placeholders for a multi-row INSERT. */
function placeholders(rowCount: number, colCount: number): string {
  const rows: string[] = [];
  let p = 1;
  for (let r = 0; r < rowCount; r++) {
    const cols: string[] = [];
    for (let c = 0; c < colCount; c++) cols.push(`$${p++}`);
    rows.push(`(${cols.join(",")})`);
  }
  return rows.join(",");
}

/** Run `fn` over `rows` in CHUNK-sized batches. */
async function inChunks<T>(
  rows: readonly T[],
  fn: (batch: readonly T[]) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await fn(rows.slice(i, i + CHUNK));
  }
}

async function seedUsers(client: PoolClient): Promise<void> {
  const users: Array<[string, string, string, string]> = [];
  for (let i = 1; i <= USER_COUNT; i++) {
    users.push([
      `Seed User ${i}`,
      `seed.user.${i}@example.com`,
      `+91${String(1000000000 + i)}`,
      "verified",
    ]);
  }
  await inChunks(users, async (batch) => {
    const flat = batch.flat();
    await client.query(
      `INSERT INTO users (name, email, phone, kyc_status)
       VALUES ${placeholders(batch.length, 4)}`,
      flat,
    );
  });
}

/** Returns the seeded user ids in ascending order. */
async function fetchUserIds(client: PoolClient): Promise<string[]> {
  const res = await client.query<{ id: string }>(
    `SELECT id FROM users WHERE email LIKE 'seed.user.%@example.com' ORDER BY id`,
  );
  return res.rows.map((r) => r.id);
}

async function seedWallets(
  client: PoolClient,
  userIds: readonly string[],
): Promise<void> {
  const wallets: Array<[string]> = [];
  for (const userId of userIds) {
    for (let w = 0; w < WALLETS_PER_USER; w++) wallets.push([userId]);
  }
  await inChunks(wallets, async (batch) => {
    const flat = batch.flat();
    await client.query(
      `INSERT INTO accounts (user_id, is_system, system_type, currency, balance)
       SELECT v.user_id, false, NULL, 'INR', 0
       FROM (VALUES ${placeholders(batch.length, 1)}) AS v(user_id)`,
      flat,
    );
  });
}

async function fetchSeedWalletIds(client: PoolClient): Promise<string[]> {
  const res = await client.query<{ id: string }>(
    `SELECT a.id
     FROM accounts a
     JOIN users u ON u.id = a.user_id
     WHERE a.is_system = false
       AND u.email LIKE 'seed.user.%@example.com'
     ORDER BY a.id`,
  );
  return res.rows.map((r) => r.id);
}

async function fetchCashInId(client: PoolClient): Promise<string> {
  const res = await client.query<{ id: string }>(
    `SELECT id FROM accounts WHERE is_system = true AND system_type = 'cash_in'`,
  );
  const row = res.rows[0];
  if (!row) throw new Error("cash_in system account not found; run migrations first");
  return row.id;
}

/**
 * One batched pass that, for each (transfer, entries) pair, inserts the transfer
 * then its balanced ledger entries. We insert transfers and entries in separate
 * batched statements but within the SAME transaction, so the deferred balance
 * trigger validates each transfer at COMMIT.
 *
 * `rows` is a list of transfers to create; each produces exactly one debit on
 * `fromId` and one credit on `toId` for `amount`.
 */
async function insertBalancedTransfers(
  client: PoolClient,
  rows: ReadonlyArray<{
    type: string;
    fromId: string;
    toId: string;
    amount: bigint;
  }>,
): Promise<void> {
  await inChunks(rows, async (batch) => {
    // Insert the transfers and get their generated ids back, preserving order.
    const tParams: unknown[] = [];
    const tPlaceholders: string[] = [];
    let p = 1;
    for (const r of batch) {
      tPlaceholders.push(
        `($${p++},'COMPLETED',$${p++},$${p++},$${p++})`,
      );
      tParams.push(r.type, r.amount.toString(), r.fromId, r.toId);
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO transfers (type, status, amount, from_account_id, to_account_id)
       VALUES ${tPlaceholders.join(",")}
       RETURNING id`,
      tParams,
    );

    // Build the two balanced entries per transfer.
    const eParams: unknown[] = [];
    const ePlaceholders: string[] = [];
    let q = 1;
    for (let i = 0; i < batch.length; i++) {
      const r = batch[i]!;
      const transferId = inserted.rows[i]!.id;
      ePlaceholders.push(`($${q++},$${q++},'debit',$${q++})`);
      eParams.push(transferId, r.fromId, r.amount.toString());
      ePlaceholders.push(`($${q++},$${q++},'credit',$${q++})`);
      eParams.push(transferId, r.toId, r.amount.toString());
    }
    await client.query(
      `INSERT INTO ledger_entries (transfer_id, account_id, direction, amount)
       VALUES ${ePlaceholders.join(",")}`,
      eParams,
    );
  });
}

async function run(pool: Pool): Promise<void> {
  // Ensure the schema (and system-account seed) exists before we insert.
  await runMigrations(pool);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const cashInId = await fetchCashInId(client);

    await seedUsers(client);
    const userIds = await fetchUserIds(client);
    await seedWallets(client, userIds);
    const walletIds = await fetchSeedWalletIds(client);
    if (walletIds.length !== WALLET_COUNT) {
      throw new Error(
        `expected ${WALLET_COUNT} seeded wallets, found ${walletIds.length}`,
      );
    }

    // Track final balances in memory so the stored balance ends up exactly
    // equal to credits - debits for every account.
    const balances = new Map<string, bigint>();
    for (const id of walletIds) balances.set(id, 0n);
    let cashInBalance = 0n; // system account, may go negative

    // 1. Opening top-ups: cash_in -> each wallet for OPENING_BALANCE.
    const topUps = walletIds.map((walletId) => ({
      type: "top_up",
      fromId: cashInId,
      toId: walletId,
      amount: OPENING_BALANCE,
    }));
    await insertBalancedTransfers(client, topUps);
    for (const walletId of walletIds) {
      balances.set(walletId, balances.get(walletId)! + OPENING_BALANCE);
      cashInBalance -= OPENING_BALANCE;
    }

    // 2. 100,000 peer transfers, round-robin wallet[i] -> wallet[i+1].
    const peers: Array<{
      type: string;
      fromId: string;
      toId: string;
      amount: bigint;
    }> = [];
    for (let i = 0; i < TRANSFER_COUNT; i++) {
      const fromId = walletIds[i % WALLET_COUNT]!;
      const toId = walletIds[(i + 1) % WALLET_COUNT]!;
      peers.push({ type: "peer_transfer", fromId, toId, amount: PEER_AMOUNT });
      balances.set(fromId, balances.get(fromId)! - PEER_AMOUNT);
      balances.set(toId, balances.get(toId)! + PEER_AMOUNT);
    }
    await insertBalancedTransfers(client, peers);

    // 3. Write stored balances to match computed balances exactly.
    const walletUpdates: Array<[string, string]> = walletIds.map((id) => [
      id,
      balances.get(id)!.toString(),
    ]);
    await inChunks(walletUpdates, async (batch) => {
      const flat = batch.flat();
      await client.query(
        `UPDATE accounts AS a
         SET balance = v.balance::bigint
         FROM (VALUES ${placeholders(batch.length, 2)}) AS v(id, balance)
         WHERE a.id = v.id::bigint`,
        flat,
      );
    });
    await client.query(
      `UPDATE accounts SET balance = $1 WHERE id = $2`,
      [cashInBalance.toString(), cashInId],
    );

    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // preserve original error
    }
    throw err;
  } finally {
    client.release();
  }

  console.log(
    `Seed complete: ${USER_COUNT} users, ${WALLET_COUNT} wallets, ` +
      `${WALLET_COUNT + TRANSFER_COUNT} transfers ` +
      `(${WALLET_COUNT} opening top-ups + ${TRANSFER_COUNT} peer transfers).`,
  );
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);
  try {
    await run(pool);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
