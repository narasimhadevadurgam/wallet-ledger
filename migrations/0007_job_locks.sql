-- 0007_job_locks.sql
-- One row per background job (job_name is the PK). The reconciliation job takes
-- its row with SELECT ... FOR UPDATE NOWAIT as the first statement in its
-- transaction for single-run safety (design §13). The 'reconciliation' row is
-- seeded in 0015.

CREATE TABLE job_locks (
    job_name  TEXT PRIMARY KEY,
    locked_at TIMESTAMPTZ NULL,
    locked_by TEXT NULL
);
