import type { PoolClient } from "pg";

/**
 * Audit of a transfer status change (design §9.1 step 10, schema audit_log).
 * `old_status` is NULL for a freshly-created transfer (NULL -> COMPLETED/HELD),
 * set for a transition (HELD -> COMPLETED/FAILED). `actor` is free text (the
 * owning user id as a string, or "admin" on the release path); audit_log has NO
 * FK to users by design. Always written on the SAME client/transaction as the
 * money movement so the audit row commits atomically with the status change.
 */
export async function writeTransferAudit(
  client: PoolClient,
  params: {
    transferId: bigint;
    oldStatus: string | null;
    newStatus: string;
    actor: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (transfer_id, old_status, new_status, actor)
     VALUES ($1, $2, $3, $4)`,
    [params.transferId.toString(), params.oldStatus, params.newStatus, params.actor],
  );
}
