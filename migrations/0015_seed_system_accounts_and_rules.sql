-- 0015_seed_system_accounts_and_rules.sql
-- Baseline data so compose/CI have a working schema with zero manual steps
-- (schema.md §8, design §13/§14). This runs after the insert-only trigger (0013)
-- which blocks only UPDATE/DELETE, and inserts NO multi-entry transfers, so the
-- deferred balance trigger (0014) does not interfere.
--
-- Seeds:
--   * three system accounts (cash_in, cash_out, fee_revenue), each is_system=true,
--     user_id NULL, balance=0, with ZERO opening ledger_entries so reconciliation
--     check (c) computes 0 == 0 at baseline (finding 2a);
--   * the pinned default risk_rules (design §14/§20.3-H);
--   * config('fee_paise','0');
--   * the job_locks row for 'reconciliation'.
-- Idempotent via ON CONFLICT so a re-run against an already-seeded DB is a no-op.

-- ON CONFLICT on the partial unique index accounts_system_type_uidx (0012) makes
-- this insert a true no-op on re-run, matching risk_rules/config/job_locks below.
INSERT INTO accounts (user_id, is_system, system_type, currency, balance)
VALUES
    (NULL, true, 'cash_in',     'INR', 0),
    (NULL, true, 'cash_out',    'INR', 0),
    (NULL, true, 'fee_revenue', 'INR', 0)
ON CONFLICT (system_type) WHERE is_system DO NOTHING;

INSERT INTO risk_rules (rule_name, threshold, window_seconds, action, enabled)
VALUES
    ('single_over_max', 100000000, NULL, 'hold', true),
    ('velocity',             1000,   60, 'hold', true),
    ('rapid_drain',     100000000,   60, 'flag', true)
ON CONFLICT (rule_name) DO NOTHING;

INSERT INTO config (key, value)
VALUES ('fee_paise', '0')
ON CONFLICT (key) DO NOTHING;

INSERT INTO job_locks (job_name, locked_at, locked_by)
VALUES ('reconciliation', NULL, NULL)
ON CONFLICT (job_name) DO NOTHING;
