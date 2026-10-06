-- 0003_transfers.sql
-- A money-movement record. Both account FKs are NOT NULL: every flow has a
-- concrete account on each side (top_up: cash_in->wallet, withdrawal:
-- wallet->cash_out, peer_transfer: wallet->wallet, reversal swaps the two).
-- A reversal is a transfers row with type='reversal' and reverses_transfer_id
-- pointing at the original (self-FK). There is NO 'fee' type: a fee is extra
-- ledger entries on the peer_transfer row (schema.md §2/§8, design §9.1.2).

CREATE TABLE transfers (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    type                 TEXT NOT NULL
        CHECK (type IN ('top_up', 'peer_transfer', 'withdrawal', 'reversal')),
    status               TEXT NOT NULL
        CHECK (status IN ('PENDING', 'HELD', 'COMPLETED', 'REVERSED', 'FAILED')),
    amount               BIGINT NOT NULL CHECK (amount > 0),
    from_account_id      BIGINT NOT NULL REFERENCES accounts (id),
    to_account_id        BIGINT NOT NULL REFERENCES accounts (id),
    note                 TEXT NULL,
    reverses_transfer_id BIGINT NULL REFERENCES transfers (id),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
