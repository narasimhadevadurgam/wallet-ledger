-- 0004_ledger_entries.sql
-- A single debit or credit on exactly one account. A transfer writes 2+ entries
-- and per-transfer debits == credits (enforced by the deferred constraint trigger
-- in 0014). Direction + positive amount (never signed) keeps the balance math a
-- clean SUM(... FILTER direction='debit') vs 'credit' (design §7). INSERT-ONLY:
-- 0013 adds a BEFORE UPDATE/DELETE trigger + REVOKE.

CREATE TABLE ledger_entries (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transfer_id BIGINT NOT NULL REFERENCES transfers (id),
    account_id  BIGINT NOT NULL REFERENCES accounts (id),
    direction   TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
    amount      BIGINT NOT NULL CHECK (amount > 0),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
