-- 0012_indexes.sql
-- Every index from schema.md §6, supporting the real query shapes (statements,
-- reconciliation checks, fraud rules, cursor pagination). The UNIQUE(user_id,key)
-- on idempotency_keys already exists (0005) and is not repeated here.

-- Statement by wallet ordered by time; recon checks (c)/(d).
CREATE INDEX ledger_entries_account_created_idx
    ON ledger_entries (account_id, created_at DESC);

-- Per-transfer debits == credits (recon check (b), balanced trigger).
CREATE INDEX ledger_entries_transfer_idx
    ON ledger_entries (transfer_id);

-- Statement + velocity / rapid-drain fraud rules.
CREATE INDEX transfers_from_account_created_idx
    ON transfers (from_account_id, created_at DESC);
CREATE INDEX transfers_to_account_created_idx
    ON transfers (to_account_id, created_at DESC);

-- Global statement ordering + cursor pagination keyset.
CREATE INDEX transfers_created_id_idx
    ON transfers (created_at DESC, id DESC);

CREATE INDEX risk_flags_transfer_idx
    ON risk_flags (transfer_id);

CREATE INDEX audit_log_transfer_idx
    ON audit_log (transfer_id);

CREATE INDEX reconciliation_problems_run_idx
    ON reconciliation_problems (run_id);
