-- 0008_risk_rules.sql
-- Fraud rule thresholds live in the DB, not code (design §14). action is either
-- 'hold' (block until admin release) or 'flag' (allow-with-flag). window_seconds
-- is NULL for rules that are not windowed (e.g. single_over_max). The default
-- rows are seeded in 0015 with pinned thresholds.

CREATE TABLE risk_rules (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    rule_name      TEXT NOT NULL UNIQUE,
    threshold      BIGINT NOT NULL,
    window_seconds INT NULL,
    action         TEXT NOT NULL CHECK (action IN ('hold', 'flag')),
    enabled        BOOLEAN NOT NULL DEFAULT true
);
