-- 0001_users.sql
-- A person. System-generated BIGINT surrogate PK. email/phone are externally
-- controlled data (UNIQUE for lookup/dedupe) and must NOT be primary keys
-- (schema.md §1/§4). kyc_status is a small fixed enum enforced by a CHECK.

CREATE TABLE users (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL UNIQUE,
    phone      TEXT NOT NULL UNIQUE,
    kyc_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (kyc_status IN ('pending', 'verified', 'rejected')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
