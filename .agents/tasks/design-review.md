# Design Review — Payments-Grade Wallet Ledger

Reviewer: design-review subagent (fresh read, no authoring context)
Documents reviewed: `docs/design.md`, `docs/schema.md`
Repo state at review: docs-only; no `migrations/`, `src/`, `scripts/`, or `README` body exist yet (expected — this is a pre-implementation gate). `README.md` contains only a title.

## Method

I read both design documents in full and cross-checked the internal consistency of the sections the task enumerated (double-entry invariants, locked transfer txn, idempotency, reconciliation, fraud, LLM boundary, money representation, migrations, compose, CI). Because no source exists yet, "unverified assumption" findings are limited to claims the design makes about *its own* mechanisms and about PostgreSQL behavior; I verified those against documented Postgres semantics and against the two docs' mutual agreement. I also confirmed the design's claimed resolutions of the prior `.agents/tasks/design-review.{json,md}` findings actually land in the text.

The design is on its second revision and is unusually complete. The prior four findings (orphan-check scope, admin-POST idempotency scope, mock LLM determinism, pinned risk-rule actions) are genuinely resolved in the current text. The findings below are issues those passes did not surface.

---

## Findings

### 1. HIGH — Fee is modeled both as extra ledger entries *inside* the peer transfer and as a separate `fee`-type transfer; the two models conflict, and the `fee`-type transfer has no defined flow.

Location: `design.md` §9.1 step 8, §9.1.2; `schema.md` §1 ("Fee / fee revenue"), §8, transfer-type enum (`transfers.type` includes `fee`).

The conflict: `design.md` §9.1 step 8 says a fee writes "a second `debit` on the sender and a `credit` to the `fee_revenue`" **referencing the same transfer** (one `transfers` row, four ledger entries). But `schema.md` §1 defines the fee noun as "a `fee`-type transfer / extra ledger entry pair," and the `transfers.type` enum carries a dedicated `fee` value. Nothing in §9 ever creates a `fee`-type `transfers` row, and no flow is specified for one. So either:
- the fee is extra entries on the peer transfer (design §9 model) — in which case the `fee` transfer type is dead and the per-transfer balance check (§9.1.3) must tolerate a 4-entry transfer whose debit sum = `amount + fee` and credit sum = `amount + fee`; or
- the fee is its own `fee`-type transfer — in which case §9.1 step 8 is wrong and there must be a second idempotency/locking story for the fee transfer.

This is HIGH because it sits directly on the money path and the double-entry invariant. An implementer cannot write migration `0003` (transfer type enum) and `transferService` step 8 without a decision, and the deferred balance trigger's correctness depends on which model is chosen.

Concrete fix: pick one model explicitly. Recommended: "A fee does **not** create a separate `transfers` row. The fee is two additional ledger entries (`debit` sender, `credit` fee_revenue) attached to the originating `peer_transfer` row. The `fee` value in the `transfers.type` enum is removed (or explicitly reserved/unused with a note)." Then restate the §9.1.3 trigger example for the 4-entry case: `SUM(debit)=amount+fee`, `SUM(credit)=amount+fee`.

### 2. HIGH — Reconciliation check (c) "stored vs computed balance" is contradicted by the HELD-transfer balance model: a HELD transfer updates no balance and writes no entries, but step 9's balance update happens only on COMPLETED, so stored==computed holds — *except* the design never states that `accounts.balance` is left untouched for HELD/FAILED. Separately, check (c) will mis-handle system accounts seeded with a nonzero balance.

Location: `design.md` §13 check (c); §9.1 step 6 (HELD commits "without changing balances"); §9.1 step 9; `schema.md` §2 (`accounts.balance DEFAULT 0`), §8 (seed).

Two concrete problems:

(a) Check (c) compares `accounts.balance` against `SUM(credit) - SUM(debit)` over `ledger_entries` for every account. For a freshly seeded system account this is fine only if the seed inserts balance 0 and no opening ledger entries. The seed (§8 / migration `0014`) inserts the three system accounts but the design never states their opening balance or whether any opening ledger entries are written. If a system account is seeded with a nonzero `balance` and no matching entries (or vice versa), check (c) reports a false problem on every run — and would corrupt AC-6's "exactly 3 problems" count. The design must pin: system accounts seed with `balance = 0` and **zero** ledger entries, so computed (0) == stored (0).

(b) The design says HELD commits "without changing balances" (good), but does not state the same for the sender on a `HELD`→`FAILED` release. §9.1.1 step 3 (FAILED path) writes an audit row and returns 422 but is silent on balances; since no entries were ever written and no balance was ever changed, computed and stored both stay consistent — but this needs to be stated so an implementer does not "revert" something that was never applied.

This is HIGH because check (c) is one of the five reconciliation checks whose precision AC-6 asserts to the exact count; an unpinned seed balance makes AC-6 nondeterministic.

Concrete fix: in `schema.md` §8 / `design.md` §9.1.3-adjacent, state: "System accounts are seeded with `balance = 0` and no opening `ledger_entries`; all system-account balance movement happens only through transfer ledger entries, so reconciliation check (c) computes 0 == 0 at baseline." Add an explicit sentence to §9.1.1 FAILED path: "no balances were modified and none are reverted."

### 3. MEDIUM — Top-up and withdrawal require an `Idempotency-Key` and execute §9.1 step 3 (insert key with `user_id`), but top-up/withdraw bodies do not carry a user id and the wallet's owner is a system account on one side; which `user_id` scopes the key is unspecified.

Location: `design.md` §9.1 step 3 (`INSERT INTO idempotency_keys(user_id, key, ...)`), §8 API table (`POST /wallets/{id}/top-up`, `/withdraw` bodies are `{amount}` only), §11; `schema.md` `idempotency_keys.user_id FK→users` NOT NULL.

`idempotency_keys.user_id` is a non-null FK to `users` and the uniqueness is `UNIQUE(user_id, key)`. For a peer transfer the "user `u`" is clear-ish (the sender's owner). For top-up and withdraw, the request addresses a wallet by `{id}`; the design must say the key's `user_id` is resolved as "the owner (`accounts.user_id`) of the wallet named in the path." It never states this. It also doesn't handle the case where the path wallet is somehow a system account (should be rejected before key insert). Without this, two different users reusing the same client-chosen UUID on *different* wallets could either collide or not, depending on an undefined mapping.

Concrete fix: add to §9.1/§11: "For top-up and withdraw, the idempotency key's `user_id` is the `accounts.user_id` of the path wallet (resolved before step 3; a path wallet that is a system account → `400`/`404`). For peer transfer it is the owner of `from_wallet_id`." State that `(user_id, key)` is therefore unique per owning user.

### 4. MEDIUM — The idempotency "insert key first, then do work, replay the saved body" model cannot return the exact saved body for a response whose content is only known *after* commit (e.g. `wallet_balance`, `transfer_id`), yet the key row is written inside the same txn before those values exist; the design says the key is updated to `completed` with the saved body at step 11, which is fine — but step 3 inserts `status='in_progress'` and a concurrent replay that reads an `in_progress` row is defined to *block on the unique index*, which only works if the blocking happens at INSERT time, not at a SELECT. Confirm no code path SELECTs the in_progress row.

Location: `design.md` §9.1 steps 3/11, §11.2 "Concurrency".

§11.2 is mostly rigorous and correct: a racing duplicate blocks on the `UNIQUE(user_id,key)` **insert** until the winner commits or rolls back. That is the right mechanism. The residual risk is a MEDIUM-severity ambiguity, not a contradiction: §11 twice refers to an `in_progress` key being "replayed" (e.g. §17 edge case "Replay of an `in_progress` key under concurrency → blocks then replays"). There is no SELECT-based read of an `in_progress` row anywhere in the committed design, and there must not be — if any code path tried to SELECT-then-decide on an `in_progress` row it would reintroduce the race the insert-first design eliminates. The design should state the negative invariant so an implementer does not add such a read.

Concrete fix: add one sentence to §11.2: "No code path ever SELECTs an `in_progress` key to make a replay decision; replay is detected **only** by the `UNIQUE` violation on the step-3 INSERT. `in_progress` is an internal transient state visible only to the owning transaction."

### 5. MEDIUM — Reconciliation runs at `REPEATABLE READ`, but check (c) compares `accounts.balance` (mutated by concurrent live transfers) against entries computed in the same snapshot; under REPEATABLE READ the snapshot is consistent, yet the job's own `job_locks FOR UPDATE NOWAIT` does not stop concurrent transfers, so a transfer that commits *after* the recon snapshot opened is correctly invisible — but a transfer that was *mid-flight* (locked both accounts, not yet committed) at snapshot time means the recon snapshot sees the pre-transfer balance and pre-transfer entries consistently. This is actually correct; the gap is that the design never states recon tolerates live traffic, and AC-6 seeds a static DB, so the concurrent-with-live-traffic case is never tested or claimed.

Location: `design.md` §13 (REPEATABLE READ rationale), §9.2 (recon reads broadly without locking), §12 AC-6.

The isolation choice is sound: REPEATABLE READ gives the five checks a single consistent snapshot, and because `ledger_entries` is insert-only and balance updates are committed atomically with their entries inside the transfer txn, any committed transfer appears in the snapshot *entirely or not at all*. So check (c) is self-consistent per account even under live load. The MEDIUM issue is that the design does not say this, and reconciliation on a live payments system runs concurrently with transfers by definition. AC-6 only tests a quiescent DB. If an implementer or reviewer later assumes recon must run during a maintenance window, that is a silent, undocumented operational constraint.

Concrete fix: add to §13: "Because every transfer commits its balance update and its ledger entries atomically, the REPEATABLE READ snapshot sees each committed transfer whole; check (c) is therefore correct even when transfers commit concurrently with a running reconciliation. (Not covered by AC-6, which uses a static DB; a concurrent-traffic recon test is a documented next step.)" If the intent is instead to require quiescence, state that explicitly.

### 6. MEDIUM — `transfers.from_account_id` / `to_account_id` are nullable in the schema, but every flow writes both; and the ER/`schema.md` names them `from_account_id`/`to_account_id` while the HTTP body and some index names use `from_wallet_id`/`to_wallet_id`. The wallet-id → account-id translation is never specified.

Location: `schema.md` §2 (`from_account_id FK NULL`, `to_account_id FK NULL`), §6 index "`transfers (from_account_id ...)`" vs §6 "`transfers(from_wallet_id, created_at)`" in `design.md` §14; `design.md` §8 body (`from_wallet_id`, `to_wallet_id`).

Two concrete problems:
- Naming drift: `design.md` §14 names an index `transfers(from_wallet_id, created_at)` and FR-9 text uses "wallet", while `schema.md` §2/§6 use `from_account_id`. A wallet *is* an account (schema §1), so the column is `from_account_id`; the API field is `from_wallet_id`. The design should state the mapping once ("the API's `from_wallet_id` is the `accounts.id` of a user wallet; `transfers.from_account_id` stores it") and fix the index name to the real column.
- Nullability: both FKs are declared `NULL`, justified as "nullable for pure system-origin cases if needed." No flow produces a null side (top-up has cash_in as the from-account, withdraw has cash_out as the to-account). Leaving them nullable with no flow invites inconsistent rows. State that both are NOT NULL in practice, or name the exact flow that uses NULL.

Concrete fix: add a one-line mapping note and make both columns `NOT NULL` (every top-up/withdraw/peer transfer has a concrete account on both sides via the system accounts). Rename the §14 index reference to `transfers(from_account_id, created_at DESC)`.

### 7. MEDIUM — The deferred constraint trigger (§9.1.3) is specified to fire "for each `transfer_id` touched in the transaction," but a `CONSTRAINT TRIGGER` in Postgres fires per-row (per inserted `ledger_entries` row), not once per transaction; the design does not say how it enumerates "transfers touched" or avoids O(n) redundant re-checks within one txn.

Location: `design.md` §9.1.3; `schema.md` §6 (per-transfer debits==credits mechanism).

A `DEFERRABLE INITIALLY DEFERRED CONSTRAINT TRIGGER ... FOR EACH ROW` fires once per inserted row at COMMIT, with `NEW` bound to that row. To implement "SUM(debit)=SUM(credit) for each transfer touched," the trigger body typically re-queries all entries for `NEW.transfer_id` and compares — which is correct but runs once per inserted entry (so 2–4× per transfer, each doing the same aggregate). That is functionally fine but the design presents it as if it evaluates once per transfer, which a `FOR EACH STATEMENT` constraint trigger cannot do (statement-level constraint triggers can't be deferred the same way and don't see per-row transition cleanly pre-PG10 transition tables). The feasibility is fine; the *specification* is imprecise enough that an implementer could pick a non-working variant.

Concrete fix: specify it concretely: "`CREATE CONSTRAINT TRIGGER ... AFTER INSERT ON ledger_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_transfer_balanced();` the function re-aggregates `SELECT SUM(amount) FILTER(...)` for `NEW.transfer_id` and `RAISE EXCEPTION` on imbalance. It fires once per inserted entry (2–4× per transfer); the redundant re-check at COMMIT is acceptable given transfer entry counts are tiny. (Alternatively use a per-statement trigger with transition tables.)" Pick one.

### 8. MEDIUM — AC-1 stampede math assumes a transfer of exactly 1,000 paise from a 50,000 wallet yields "exactly 50 succeed," but the seeded fee default is 0, so this holds — *only if no fraud rule fires*. The seed pins `single_over_max → hold` and `velocity → hold`; 100 rapid withdrawals from one wallet will trip the velocity and/or rapid_drain rules, HOLDing or flagging transfers and breaking the "exactly 50 succeed, wallet ends at 0" assertion.

Location: `design.md` §12 AC-1, §14 Part A (velocity → hold, rapid_drain → flag), §9.1 step 6 (fraud runs inside every transfer txn).

AC-1 fires 100 concurrent withdrawals from one wallet in a tight loop, ~20 iterations. Fraud rules run *inside every transfer txn* (§9.1 step 6) with thresholds from `risk_rules`, and the seed enables `velocity` (hold) and `rapid_drain` (flag) by default. 100 withdrawals from one wallet in milliseconds is precisely what a velocity/rapid-drain rule is designed to catch. If those rules fire during AC-1, some transfers become HELD (no money moves) and the "exactly 50 succeed / balance 0" invariant fails — or the test only passes because the velocity threshold happens to be set above 100, which the design never pins. AC-1 and AC-9 therefore have an unstated dependency: AC-1 needs fraud rules effectively disabled or thresholds set above the stampede volume; AC-9 needs them enabled.

This is MEDIUM: it is a concrete test-determinism conflict between two acceptance criteria driven by one shared seed.

Concrete fix: state how AC-1 isolates from fraud. Either (a) AC-1 seeds/overrides `risk_rules` to disable velocity/rapid_drain (or sets thresholds > 100) for its wallet/run, or (b) the default velocity/rapid_drain thresholds are pinned high enough that 100 withdrawals do not trip them and AC-9 uses an explicitly lower threshold. Pin the numbers in §14 Part A and reference them from AC-1 and AC-9.

### 9. NIT — `job_locks` single-run guard uses `FOR UPDATE NOWAIT` inside the reconciliation transaction, but the design also says reconciliation runs at `REPEATABLE READ`; a `SELECT ... FOR UPDATE NOWAIT` on the lock row is fine under RR, yet the design should confirm the lock is acquired as the *first* statement so the snapshot and the lock are taken together.

Location: `design.md` §13, §9.2.

Minor ordering clarity: under REPEATABLE READ the snapshot is fixed at the first query. The `FOR UPDATE NOWAIT` on `job_locks` should be that first statement so a losing contender fails fast (55P03) before opening a snapshot it will not use.

Concrete fix: "The `SELECT ... FROM job_locks ... FOR UPDATE NOWAIT` is the first statement in the recon transaction."

### 10. NIT — `idempotency_keys.body_hash` typed as `BYTEA/CHAR(64)` (schema §2) is left as an either/or; §11.1 pins it to `CHAR(64)` lowercase hex. Pick one in the schema to avoid a mismatch at migration time.

Location: `schema.md` §2 (`body_hash BYTEA/CHAR(64)`); `design.md` §11.1 ("store as `CHAR(64)` lowercase hex").

Concrete fix: change `schema.md` §2 to `body_hash CHAR(64) NOT NULL  -- SHA-256 lowercase hex`, matching §11.1.

### 11. NIT — `risk_rules` holds fraud thresholds, but the "fee amount" is described as living "in config/`risk_rules`" (design §9.1.2, schema §8) while `risk_rules` has no amount/fee column distinct from `threshold`, and `fee` is not a rule action (`action ∈ hold|flag`). Where the fee amount is stored is under-specified.

Location: `design.md` §9.1.2, §19; `schema.md` §1, §8, `risk_rules` columns (§2).

`risk_rules` columns are `rule_name, threshold, window_seconds, action(hold|flag), enabled`. A fee is not a hold/flag rule and has no window; overloading a `risk_rules` row for "fee = 0" is a type mismatch (what is its `action`?). The design should state the fee amount's home concretely.

Concrete fix: either add a dedicated `config` key or a `fee` row convention: "the fee amount is a `risk_rules` row with `rule_name='fee'`, `threshold`=fee-in-paise, `action` ignored (set to `flag`), `enabled=true`; code reads `threshold` as the flat fee." Or introduce a small `config(key,value)` table. Pin it so migration `0014` is writable.

---

## Verified Assumptions

These claims in the design were checked and hold:

- **Money as BIGINT paise, bigint in TS, JSON string at the boundary** (§2.1): internally consistent; `pg` returning BIGINT as string and re-parsing to `bigint` is accurate Postgres/node-postgres behavior. Accept-number-or-string with range/integer validation is specified concretely.
- **Lock ordering for deadlock avoidance** (§9.1 step 4): `SELECT ... WHERE id = ANY($1) ORDER BY id FOR UPDATE` with the id array pre-sorted ascending is a correct, standard deadlock-avoidance pattern. The claim that the second concurrent transfer blocks on the lock and then sees committed state under READ COMMITTED is accurate Postgres semantics.
- **READ COMMITTED + row locks is sufficient for the transfer path** (§9.2): the argument that explicit `FOR UPDATE` locks provide serialization (so SERIALIZABLE is unnecessary) is correct for this access pattern (both contended rows are locked). The §9.2 reasoning that `CHECK(balance>=0)` is a last-line guard, not the concurrency mechanism, is sound.
- **Insert-first idempotency + UNIQUE(user_id,key) replay detection** (§11.2): the two-case model (committed → unique conflict → replay; rolled-back → row vanishes → re-execute) and the concurrency winner-commits/winner-rolls-back analysis are internally consistent and match Postgres unique-index blocking behavior. (The residual gap is finding 4, a documentation/negative-invariant issue, not a correctness error.)
- **Body canonicalization** (§11.1): parse-then-normalize, money→canonical bigint decimal, lexicographically sorted keys, NFC strings, SHA-256 over UTF-8 → lowercase hex, headers/path/request_id excluded — fully specified and reproducible.
- **Orphan check (e) scoped to `status IN ('COMPLETED','REVERSED')`** (§13, §9.1.1): correctly reconciles with the HELD/FAILED-have-no-entries model; resolves prior finding 1. The exact predicate is given.
- **Admin-POST idempotency scope** (§8 "Idempotency scope"): the three money-mutating POSTs carry keys; `/admin/*`, `/users*`, `/statement/ask` are exempt with their own guards (`409 TRANSFER_NOT_HELD`, `409 RECON_LOCKED`). Internally consistent across §8, FR-8, §9.1, §13; resolves prior finding 2.
- **Mock LLM determinism** (§10.1): substring-keyed lookup table shared as a fixture between mock and test, 10 distinct questions → distinct parses, unknown → invalid shape → 422. Resolves prior finding 3; AC-11 is now determinate.
- **Pinned risk-rule actions** (§14 Part A, schema §8): `single_over_max→hold`, `velocity→hold`, `rapid_drain→flag`, all enabled, fee=0. Resolves prior finding 4 (except for the AC-1 interaction raised as finding 8 here).
- **LLM boundary** (§10): LlmClient interface, mock default, never writes/receives SQL, never decides money, statement-ask JSON validated in code against 4 types, caller-scoped parameterized query with path-user id bound. The prompt-injection guarantee is scoped accurately (content cannot widen scope; does not claim cross-user auth, which is out of scope).
- **Migrations from empty + ordered runner + schema_migrations tracking** (§6): dependency-ordered, idempotent, builds from empty, runs on startup before serving. Migration order is dependency-correct (insert-only trigger blocks only UPDATE/DELETE so seed-after-trigger is safe; deferred balance trigger does not interfere with single-entry seed rows).
- **Docker compose topology** (§16): db + api + worker, migrate-on-startup in api/worker entrypoints, api waits for migrations before listen, LLM_PROVIDER=mock default. Matches FR-17.
- **CI against real Postgres** (§15): `postgres:15` service, migrate then `vitest run`, `LLM_PROVIDER=mock`. Matches NFR-2/FR-17.
- **schema.md completeness**: contains the noun list (§1, every noun with table/not-table rationale), cardinality decisions with FK placement (§5), and a Mermaid `erDiagram` (§7). `docs/isolation.md` is planned with a concrete content spec (§9.3). All required by the task.
- **Global and per-transfer balance invariants**: `SUM(debit)=SUM(credit)` globally (recon a) and per-transfer via deferred constraint trigger (§9.1.3) plus independent recon verification (b). (Trigger *specification* precision is finding 7; the invariant intent is sound.)

## Unverified / Wrong Assumptions

- **Wrong — "the fee is an extra entry pair *and* a `fee`-type transfer"**: `schema.md` §1 and the `transfers.type` enum assume a `fee` transfer type that `design.md` §9's flow never creates and that conflicts with the same-transfer extra-entries model. See finding 1. The design's own two documents disagree.
- **Wrong/under-determined — "AC-1 yields exactly 50 successes"**: this assumes fraud rules do not fire during a 100-withdrawal stampede, but the pinned seed enables velocity (hold) and rapid_drain (flag). The assumption that AC-1 is unaffected by the seeded rules is not established. See finding 8.
- **Unverified — system-account seed balances**: the design asserts recon check (c) will find "exactly 3 problems" in AC-6 but never pins the opening balance / opening entries of the three seeded system accounts; if nonzero/mismatched, check (c) reports false positives. See finding 2(a). Could not verify because the seed DDL (`migration 0014`) does not exist yet and the design does not state the values.
- **Unverified — idempotency key `user_id` for top-up/withdraw**: the design assumes a `user_id` is available to insert at step 3 for all three money POSTs, but top-up/withdraw bodies carry no user id and the mapping from path wallet to owning user is unstated. See finding 3. Cannot verify the FK will always be satisfiable until the mapping is pinned.
- **Unverified — deferred constraint trigger granularity**: the design assumes the balance trigger evaluates "once per transfer touched"; Postgres constraint triggers are per-row. The functional outcome is reachable but the stated mechanism is imprecise. See finding 7.
- **Not applicable to verify by execution**: no source, migrations, or tests exist yet (pre-implementation gate), so runtime behavior (actual stampede outcome, actual recon counts, actual trigger firing) could not be executed. Findings are based on document analysis and documented Postgres semantics only.

---

## Verdict

HIGH findings: 2 (findings 1, 2)
MEDIUM findings: 6 (findings 3, 4, 5, 6, 7, 8)
NIT findings: 3 (findings 9, 10, 11)

HIGH + MEDIUM = 8 (> 0) → **CHANGES_REQUESTED**.

The design is mature and the prior review passes are genuinely resolved, but the fee double-model (finding 1), the unpinned system-account seed balances threatening AC-6 (finding 2), and the AC-1/fraud-rule determinism conflict (finding 8) are real correctness/testability gaps that should be closed before implementation starts.
