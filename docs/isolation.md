# Isolation Lab (`docs/isolation.md`)

> Authored in the implementation phase per design §9.3. This is a two-session
> `psql` lab you can reproduce against the project's Postgres 15 (e.g.
> `docker compose up db`, then `psql "$DATABASE_URL"` in two terminals). Each
> scenario labels **Session A** and **Session B**, shows the exact commands in
> the order you run them, and describes the observed/expected output.
>
> Why this matters for the ledger: the money path (design §9.2) runs at
> `READ COMMITTED` and relies on `SELECT ... FOR UPDATE` row locks for
> serialization, while the reconciliation job (design §13) runs at
> `REPEATABLE READ` for a stable snapshot across many unlocked reads. The four
> scenarios below demonstrate exactly the behaviours those two choices depend on.

A throwaway table is used so the lab never touches ledger data:

```sql
-- run once, in either session, before the scenarios
CREATE TABLE IF NOT EXISTS iso_demo (
    id      BIGINT PRIMARY KEY,
    label   TEXT    NOT NULL,
    balance BIGINT  NOT NULL
);
TRUNCATE iso_demo;
INSERT INTO iso_demo (id, label, balance) VALUES
    (1, 'alice', 100),
    (2, 'bob',   100);
```

---

## (a) `READ COMMITTED`: a transaction sees another session's committed change mid-transaction

`READ COMMITTED` takes a **new snapshot at the start of each statement**, so a
committed change made by another session becomes visible to the next statement
in an already-open transaction. This is precisely why the transfer path cannot
rely on isolation alone and takes `FOR UPDATE` locks.

| Step | Session A | Session B |
| --- | --- | --- |
| 1 | `BEGIN;` | |
| 2 | `SET TRANSACTION ISOLATION LEVEL READ COMMITTED;` | |
| 3 | `SELECT balance FROM iso_demo WHERE id = 1;` → `100` | |
| 4 | | `UPDATE iso_demo SET balance = 150 WHERE id = 1;` |
| 5 | | `COMMIT;` |
| 6 | `SELECT balance FROM iso_demo WHERE id = 1;` → **`150`** | |
| 7 | `COMMIT;` | |

**Observed/expected:** Session A's first read (step 3) returns `100`. After
Session B commits `150` (steps 4–5), Session A's second read **inside the same
transaction** (step 6) returns `150` — the committed change is visible
mid-transaction. The two reads disagree; `READ COMMITTED` does not give a stable
snapshot.

---

## (b) `REPEATABLE READ`: a stable snapshot for the whole transaction

`REPEATABLE READ` takes **one snapshot at the first statement** and reuses it for
the entire transaction, so a concurrent committed change is **not** seen until
the transaction ends. This is what the reconciliation job wants: every check
reads the same consistent view.

| Step | Session A | Session B |
| --- | --- | --- |
| 1 | `BEGIN;` | |
| 2 | `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;` | |
| 3 | `SELECT balance FROM iso_demo WHERE id = 1;` → `100` | |
| 4 | | `UPDATE iso_demo SET balance = 200 WHERE id = 1;` |
| 5 | | `COMMIT;` |
| 6 | `SELECT balance FROM iso_demo WHERE id = 1;` → **`100`** | |
| 7 | `COMMIT;` | |
| 8 | `SELECT balance FROM iso_demo WHERE id = 1;` → `200` | |

**Observed/expected:** both reads inside Session A's transaction (steps 3 and 6)
return `100`, even though Session B committed `200` in between. Only **after**
Session A commits does a fresh read (step 8) see `200`. The snapshot is stable
for the whole transaction.

---

## (c) `SERIALIZABLE`: write-skew aborts with `40001`

`SERIALIZABLE` detects dangerous read/write dependency cycles (such as
write-skew) and aborts one transaction with
`ERROR: could not serialize access due to read/write dependencies among
transactions` (SQLSTATE `40001`). The classic write-skew: both sessions read the
pair of rows, each decides it is safe to decrement its own row because the
*other* row still looks funded, and both write — a state neither would have
allowed had they run one after the other.

Rule for the demo: the combined balance of alice + bob must stay `>= 100`. Start
with `100 + 100 = 200`; each session withdraws `100` from one row only if the
pair still totals `>= 200`.

| Step | Session A | Session B |
| --- | --- | --- |
| 1 | `BEGIN;` | |
| 2 | `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;` | |
| 3 | | `BEGIN;` |
| 4 | | `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;` |
| 5 | `SELECT SUM(balance) FROM iso_demo;` → `200` | |
| 6 | | `SELECT SUM(balance) FROM iso_demo;` → `200` |
| 7 | `UPDATE iso_demo SET balance = balance - 100 WHERE id = 1;` | |
| 8 | | `UPDATE iso_demo SET balance = balance - 100 WHERE id = 2;` |
| 9 | `COMMIT;` → **succeeds** | |
| 10 | | `COMMIT;` → **`ERROR: 40001` could not serialize access** |

**Observed/expected:** both sessions read the sum `200` on their own snapshot
(steps 5–6), then each decrements a different row (steps 7–8). The first commit
(step 9) succeeds; the second commit (step 10) is aborted by Postgres with
SQLSTATE `40001`. Without `SERIALIZABLE` both commits would succeed and leave the
combined balance at `0`, violating the invariant — a write-skew. Under
`SERIALIZABLE` the loser must retry its transaction. This is exactly the
`40001` retry loop the design (§9.2) notes the transfer path avoids by using
explicit `FOR UPDATE` row locks instead.

---

## (d) `REPEATABLE READ` with a join: snapshot stability across joined tables

Snapshot stability is **per transaction, not per table** — a `REPEATABLE READ`
transaction sees a consistent view across *all* tables it reads, including a
join, regardless of concurrent commits to either side.

Second throwaway table for the join:

```sql
CREATE TABLE IF NOT EXISTS iso_demo_meta (
    id    BIGINT PRIMARY KEY,
    tier  TEXT   NOT NULL
);
TRUNCATE iso_demo_meta;
INSERT INTO iso_demo_meta (id, tier) VALUES (1, 'standard'), (2, 'standard');
```

| Step | Session A | Session B |
| --- | --- | --- |
| 1 | `BEGIN;` | |
| 2 | `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;` | |
| 3 | `SELECT d.balance, m.tier FROM iso_demo d JOIN iso_demo_meta m USING (id) WHERE d.id = 1;` → `100, standard` | |
| 4 | | `UPDATE iso_demo SET balance = 300 WHERE id = 1;` |
| 5 | | `UPDATE iso_demo_meta SET tier = 'gold' WHERE id = 1;` |
| 6 | | `COMMIT;` |
| 7 | `SELECT d.balance, m.tier FROM iso_demo d JOIN iso_demo_meta m USING (id) WHERE d.id = 1;` → **`100, standard`** | |
| 8 | `COMMIT;` | |
| 9 | `SELECT d.balance, m.tier FROM iso_demo d JOIN iso_demo_meta m USING (id) WHERE d.id = 1;` → `300, gold` | |

**Observed/expected:** Session A's joined read is identical before and after
Session B commits changes to **both** joined tables (steps 3 and 7 both return
`100, standard`). The single transaction snapshot covers both `iso_demo` and
`iso_demo_meta` consistently; only after Session A commits does a fresh join
(step 9) reflect `300, gold`. This is the cross-table consistency the
reconciliation job relies on when it joins `accounts`, `transfers`, and
`ledger_entries` under one `REPEATABLE READ` snapshot (design §13).

---

### Cleanup

```sql
DROP TABLE IF EXISTS iso_demo;
DROP TABLE IF EXISTS iso_demo_meta;
```
