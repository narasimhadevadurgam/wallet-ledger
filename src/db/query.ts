import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

export type IsolationLevel = "READ COMMITTED" | "REPEATABLE READ";

export interface TransactionOptions {
  isolationLevel?: IsolationLevel;
}

/**
 * One-shot parameterized query against the pool. Never interpolate values into
 * `text`; always pass them as `params` so pg binds them safely.
 */
export function query<T extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  text: string,
  params: readonly unknown[] = [],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params as unknown[]);
}

/**
 * Run `fn` inside a single transaction. Acquires a client, issues BEGIN (with
 * the requested isolation level), runs `fn(client)`, then COMMITs. On any throw
 * it ROLLBACKs and re-throws. The client is always released.
 *
 * Only transferService and reconciliationService use this directly — they own
 * the money path's locking and the recon REPEATABLE READ snapshot respectively.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const isolationLevel = options.isolationLevel ?? "READ COMMITTED";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original error; a failed rollback (e.g. dead connection)
      // should not mask why the transaction aborted.
    }
    throw err;
  } finally {
    client.release();
  }
}
