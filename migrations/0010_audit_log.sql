-- 0010_audit_log.sql
-- Every transfer status change: who (actor) and when. The FK is to transfers
-- ONLY; actor is free TEXT with NO FK to users (schema.md §2, design §6).

CREATE TABLE audit_log (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transfer_id BIGINT NOT NULL REFERENCES transfers (id),
    old_status  TEXT NULL,
    new_status  TEXT NOT NULL,
    actor       TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
