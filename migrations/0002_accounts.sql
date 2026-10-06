-- 0002_accounts.sql
-- The ledger participant. Holds BOTH user wallets (is_system=false, user_id set)
-- and the three system accounts (is_system=true, user_id NULL, system_type set),
-- sharing one id space so every transfer/ledger entry is a plain FK (schema.md §3).
-- balance is stored paise (BIGINT); it is maintained under lock on the transfer
-- path and independently recomputed by reconciliation. User wallets can never go
-- negative; system accounts may (schema.md §6).

CREATE TABLE accounts (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT NULL REFERENCES users (id),
    is_system   BOOLEAN NOT NULL,
    system_type TEXT NULL
        CHECK (system_type IN ('cash_in', 'cash_out', 'fee_revenue')),
    currency    TEXT NOT NULL DEFAULT 'INR'
        CHECK (currency = 'INR'),
    balance     BIGINT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Account-kind coherence: a system account has no user and a system_type;
    -- a user wallet has a user and no system_type.
    CONSTRAINT accounts_kind_coherence CHECK (
        (is_system     AND user_id IS NULL     AND system_type IS NOT NULL)
     OR (NOT is_system AND user_id IS NOT NULL AND system_type IS NULL)
    ),

    -- User wallets never go negative; system accounts may.
    CONSTRAINT accounts_non_negative CHECK (is_system OR balance >= 0)
);
