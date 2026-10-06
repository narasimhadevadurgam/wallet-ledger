-- 0011_config.sql
-- Flat operational key/value settings that are not fraud rules. Holds the fee
-- amount ('fee_paise', default '0', seeded in 0015). Kept out of risk_rules,
-- whose rows all require a hold/flag action meaningless for a flat fee
-- (schema.md §1/§2 finding 11). Standalone, no FKs.

CREATE TABLE config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
