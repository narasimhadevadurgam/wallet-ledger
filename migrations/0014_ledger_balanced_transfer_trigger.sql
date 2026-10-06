-- 0014_ledger_balanced_transfer_trigger.sql
-- DB-enforced per-transfer debits == credits (design §9.1.3, schema.md §6).
-- A DEFERRABLE INITIALLY DEFERRED CONSTRAINT TRIGGER fires at COMMIT, so the
-- transient imbalance between the first and last entry insert of a transfer is
-- allowed, but an unbalanced transfer can never COMMIT. The function
-- re-aggregates SUM(debit) vs SUM(credit) for the touched transfer_id and
-- RAISE EXCEPTIONs (SQLSTATE 23514, check_violation class) on mismatch. It
-- fires once per inserted entry (2-4x per transfer); the redundant re-aggregate
-- is acceptable because entry counts per transfer are tiny.

CREATE FUNCTION check_transfer_balanced()
    RETURNS TRIGGER
    LANGUAGE plpgsql
AS $$
DECLARE
    debit_total  BIGINT;
    credit_total BIGINT;
BEGIN
    SELECT
        COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0),
        COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)
    INTO debit_total, credit_total
    FROM ledger_entries
    WHERE transfer_id = NEW.transfer_id;

    IF debit_total <> credit_total THEN
        RAISE EXCEPTION
            'transfer % is unbalanced: debits=% credits=%',
            NEW.transfer_id, debit_total, credit_total
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
    AFTER INSERT ON ledger_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION check_transfer_balanced();
