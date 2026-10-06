-- 0013_ledger_insert_only_trigger.sql
-- Insert-only ledger (design §7, schema.md §6). Belt-and-suspenders:
--   1. A BEFORE UPDATE OR DELETE trigger that RAISE EXCEPTIONs, giving a clear
--      message and catching even the privileged seed path.
--   2. A privilege-level backstop: REVOKE UPDATE, DELETE on the table.
-- The trigger blocks ONLY UPDATE/DELETE, never INSERT, so seed and transfer
-- INSERTs still work.
--
-- App-role note: this exercise connects as a single Postgres role (the one in
-- DATABASE_URL) rather than a separate least-privilege app role. There is no
-- dedicated "app" role to target, so the REVOKE is issued against PUBLIC, which
-- removes the privilege from every non-owner role (design §7 "if running as a
-- single role, REVOKE from PUBLIC/that role"). The table owner (the role that
-- ran this migration) still implicitly holds UPDATE/DELETE at the privilege
-- level, which is why the trigger above is the primary, owner-proof guard.

CREATE FUNCTION ledger_entries_block_mutation()
    RETURNS TRIGGER
    LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'ledger_entries is insert-only: % is not permitted', TG_OP
        USING ERRCODE = 'raise_exception';
END;
$$;

CREATE TRIGGER ledger_entries_insert_only
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW
    EXECUTE FUNCTION ledger_entries_block_mutation();

REVOKE UPDATE, DELETE ON ledger_entries FROM PUBLIC;
