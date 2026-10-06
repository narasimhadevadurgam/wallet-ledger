-- 0009_risk_flags.sql
-- A flag raised on a transfer by a firing rule. The nightly LLM step fills
-- explanation (2 sentences) and label; both are NULL until then (design §13/§14).

CREATE TABLE risk_flags (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transfer_id BIGINT NOT NULL REFERENCES transfers (id),
    rule_name   TEXT NOT NULL,
    explanation TEXT NULL,
    label       TEXT NULL
        CHECK (label IN ('likely_ok', 'review', 'likely_fraud')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
