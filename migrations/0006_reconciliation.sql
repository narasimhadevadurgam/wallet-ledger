-- 0006_reconciliation.sql
-- Reconciliation run + problem rows. One run row per execution with the overall
-- status, global_ok flag, total problem_count, and a per-check count column for
-- each of the five checks (design §13): (a) global balance, (b) per-transfer
-- balance, (c) stored vs computed balance, (d) negative user wallet, (e) orphans.
-- One problem row per finding with check_name/entity_id/expected/actual.

CREATE TABLE reconciliation_runs (
    id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    started_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at               TIMESTAMPTZ NULL,
    status                    TEXT NOT NULL
        CHECK (status IN ('running', 'ok', 'problems', 'error')),
    global_ok                 BOOLEAN NULL,
    problem_count             INT NOT NULL DEFAULT 0,
    global_balance_count      INT NOT NULL DEFAULT 0,
    per_transfer_balance_count INT NOT NULL DEFAULT 0,
    stored_vs_computed_count  INT NOT NULL DEFAULT 0,
    negative_balance_count    INT NOT NULL DEFAULT 0,
    orphan_count              INT NOT NULL DEFAULT 0
);

CREATE TABLE reconciliation_problems (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id     BIGINT NOT NULL REFERENCES reconciliation_runs (id),
    check_name TEXT NOT NULL,
    entity_id  BIGINT NULL,
    expected   TEXT NULL,
    actual     TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
