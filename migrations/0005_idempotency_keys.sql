-- 0005_idempotency_keys.sql
-- Per-user idempotency. UNIQUE(user_id, key) enables the "insert key first"
-- replay detection in one atomic step (design §11). body_hash is the SHA-256
-- lowercase hex of the canonicalized request body (CHAR(64)). The surrogate id
-- is the PK; the client-supplied UUID key is unique only per user.

CREATE TABLE idempotency_keys (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id       BIGINT NOT NULL REFERENCES users (id),
    key           UUID NOT NULL,
    body_hash     CHAR(64) NOT NULL,
    status        TEXT NOT NULL
        CHECK (status IN ('in_progress', 'completed')),
    response_code INT NULL,
    response_body JSONB NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT idempotency_keys_user_key_unique UNIQUE (user_id, key)
);
