# Final Code Review — Payments-Grade Wallet Ledger

Reviewer: final-review step (fresh read of code, docs, migrations, tests)
Repo: `c:\Users\Narasimha.Devadurgam\source\repos\wallet-ledger` — branch `main`
Stack: Node 22 + TypeScript (strict) + Express + `pg` + Vitest; PostgreSQL 15.

## Method & verification

I read the authoritative docs (`docs/design.md`, `docs/schema.md`), the prior
`.agents/tasks/design-review.md`, and the full money-path / reconciliation / risk /
statement-ask / idempotency implementation, migrations, HTTP routes, the seed script,
CI, compose, README, `.env.example`, `.gitignore`, and the modified integration tests.

- **Test suite:** the user's own run (session message #2) is **62/62 passing (13 suites)**
  against the real Postgres at `postgres://wallet:wallet@localhost:5432/wallet_ledger`,
  including every acceptance test. The earlier 4 failures (AC-6 non-negative CHECK, AC-8/AC-9
  422-vs-201) were fixed in the working tree before that green run.
- **tsc:** `tsc --noEmit` ran clean (no diagnostics) in this review.
- **Note on tooling:** the PowerShell terminal in this session became unreliable after a
  long vitest invocation (PowerShell execution policy blocks `npx.ps1`; later commands
  returned no output). I did not re-run the suite here. The green state rests on the user's
  verbatim 62/62 run plus the static review below. This does not affect any finding.

The requirement-by-requirement checks the brief called out all hold up (money-as-BIGINT,
double-entry + DB triggers, visible locked SQL, idempotency byte-identical replay,
reconciliation NULL handling, release FAILED persistence, seed volumes, CI, no committed
secrets, parameterized SQL). Details inline in the findings and the "Verified" section.

---

## Findings

### HIGH

**H-1 — README "Verification status" is stale and now actively false.**
Location: `README.md` → "### Verification status" (the three bullets under *Running it*).

The section states, verbatim, that the Postgres-backed integration/acceptance tests are
"**Authored but NOT run here**", that "This build environment has no Docker and no
Postgres", and "**No Postgres-backed pass is claimed here.**" That was true during the
original build environment, but it is false now: the suite passes **62/62 against a real
Postgres locally** (user session message #2), and the task context confirms the same. This
is precisely the README-overclaiming / stale-note class the brief flags (item b) and the
exact kind of thing the prior-project reviews caught. The user's message #3 ("check
reviewer previous comments... as per that we need follow") points at this.

It overclaims in the *pessimistic* direction (claims less works than actually does), which
is less dangerous than claiming a passing feature that doesn't — but it is still inaccurate
and will mislead a reviewer into thinking the acceptance tests have never been exercised.

Suggested fix: replace the "Authored but NOT run here" / "No Postgres-backed pass is
claimed here" wording with the current honest state, e.g.:

> - **Ran and passing locally:** `tsc --noEmit` (zero diagnostics), the unit suite, and the
>   full Postgres-backed suite — `62/62` across 13 suites against a local `postgres:15`
>   (`DATABASE_URL=postgres://wallet:wallet@localhost:5432/wallet_ledger`), including every
>   acceptance test (AC-1 stampede, AC-2..AC-5 idempotency, AC-6/AC-7 reconciliation,
>   AC-8/AC-9 fraud, AC-10 prompt-injection, AC-11 statement Q&A).
> - **Where they also run:** `.github/workflows/ci.yml` provisions a `postgres:15` service,
>   migrates, and runs the full suite with `LLM_PROVIDER=mock`.

Keep a short "integration tests skip when `DATABASE_URL` is unset" note — that part is true
and useful.

---

### MEDIUM

(none)

---

### NIT

**N-1 — Replayed idempotent responses carry the original request's `request_id`.**
Location: `src/http/routes/transfers.ts` `transferBody(...)` (and the top-up/withdraw
routes), `src/services/transferService.ts` `completeIdempotencyKey` / `resolveReplay`.

The 201 body — including `request_id` — is serialized once, stored verbatim on the key, and
replayed byte-for-byte. That is exactly what AC-2 and design §11.2 require (byte-identical
replay), so it is correct by design. The only wrinkle: a replayed response's `request_id`
is the *first* call's id, not the replaying call's, so a client correlating that header to
its own request will see a mismatch on replays. This is a deliberate, documented tradeoff,
not a bug. Optional: add one sentence to the README "Money and bigint" / idempotency note
("a replay returns the original response bytes verbatim, including its `request_id`") so the
behavior is explicit. No code change needed.

**N-2 — `.env.example` ships an empty `ADMIN_TOKEN=` with admin endpoints currently
unauthenticated.**
Location: `.env.example`, `src/http/routes/admin.ts`.

`ADMIN_TOKEN` is in `.env.example` and documented as "guarding admin endpoints", but
`adminRouter` wires no auth middleware — the token is not read or enforced anywhere. The
README's "No authentication" trade-off is honest about this for the exercise, so it is not a
contradiction, but the `.env.example` comment ("Bearer token guarding admin endpoints")
implies enforcement that does not exist. Either drop the comment's "guarding" claim (e.g.
"reserved for future admin auth; not yet enforced — see README trade-offs") or note it in
the "What I'd do next" list alongside caller-identity/auth. Doc-only.

---

## Requirement checks (verified, no action needed)

- **Money as paise BIGINT, never float.** `accounts.balance`, `transfers.amount`,
  `ledger_entries.amount` are all `BIGINT` with `CHECK(amount>0)` (migrations 0002/0003/0004).
  `src/money/money.ts` parses to `bigint` and serializes to strings; a grep for
  `parseFloat|toFixed|FLOAT|DOUBLE|NUMERIC|::float|::numeric` found nothing on money paths.
  The only `Number(...)` uses are on ids and `limit`/`offset` (safe small integers).
- **Double-entry, DB-enforced.** Deferred `CONSTRAINT TRIGGER ledger_entries_balanced`
  (0014) re-aggregates `SUM(debit)=SUM(credit)` per `transfer_id` at COMMIT; insert-only
  ledger via `BEFORE UPDATE OR DELETE` trigger **plus** `REVOKE UPDATE,DELETE ... FROM PUBLIC`
  (0013, with an honest note that the single-role setup makes the trigger the owner-proof
  guard); non-negative user wallets via `CHECK (is_system OR balance >= 0)` (0002).
- **Money path: single txn, FOR UPDATE ascending, re-read, reject, READ COMMITTED, visible
  SQL, no ORM.** `transferService.runTransferTxn` is one `withTransaction` at READ COMMITTED;
  `lockAccountsAscending` sorts ids ascending and `SELECT ... FOR UPDATE`; step-5 funds check
  on `amount + fee`; raw `pg` SQL throughout.
- **Idempotency.** Middleware requires a UUID `Idempotency-Key` on the 3 money POSTs
  (400 otherwise); key inserted first; replay detected *only* by the UNIQUE(user_id,key)
  violation (no SELECT of an in_progress row); saved response replayed **byte-for-byte**
  (`res.send(outcome.response.body)`); body-hash mismatch → 422; `(user_id,key)` unique.
  AC-2..AC-5 and the §11.3 Case-2 retry assert exactly this.
- **Reconciliation.** Five checks in one REPEATABLE READ txn; `job_locks FOR UPDATE NOWAIT`
  is the first statement (→ 409 RECON_LOCKED); reports-never-fixes; one run row + one problem
  row per problem. The earlier NULL-handling fix (**COALESCE each one-sided SUM before
  subtracting**) is present in checks (c) stored_vs_computed, (d) negative_balance, and the
  (a)/(b) balance checks. Orphan sub-check scoped to `status IN ('COMPLETED','REVERSED')`.
- **Fraud in `risk_rules` (not hardcoded), inside the txn after the funds check.**
  `evaluateRisk` runs under the locks post-funds; thresholds from `risk_rules`; first `hold`
  wins (commits HELD, no entries/balance change); `flag` proceeds. Release path re-locks,
  re-validates, and **commits** HELD→FAILED on insufficiency (returned as a discriminated
  outcome, not a throw, so the FAILED transition persists — AC-8 companion asserts FAILED +
  no money moved). Seeded thresholds pinned high (velocity 1000, single_over_max 1e8) so
  normal/stampede traffic doesn't trip; AC-9 lowers velocity for its run only.
- **LLM boundary.** `LlmClient` interface, deterministic Mock default, Ollama impl; the model
  only returns JSON that code validates against 4 types; every statement-ask query is built by
  code with the path user id bound as a `$1` parameter — content/notes cannot widen scope
  (AC-10). All statement/ask SQL is parameterized; counterparty resolved via `lower(name)=lower($2)`.
- **Uniform error shape `{code,message,request_id}`**, documented error catalogue in README.
- **Pagination** `ORDER BY created_at DESC, id DESC` OFFSET + keyset cursor bonus; README has
  the OFFSET-100000 EXPLAIN discussion, index-on-write cost, and recon full-scan-vs-index notes.
- **Compose / migrations / seed / CI.** `docker compose up` starts db+api+worker, migrate on
  startup; `scripts/seed.ts` inserts 1000 users / 2000 wallets / 100000 peer transfers via
  chunked multi-row INSERTs with balances reconciled in one bulk UPDATE; CI uses a `postgres:15`
  service, migrates, runs `vitest run` with `LLM_PROVIDER=mock`.
- **Secrets.** No `.env` committed; `.gitignore` excludes `.env`; `.env.example` has an empty
  `ADMIN_TOKEN`.
- **Docs present and consistent.** `schema.md` has the noun list, cardinality + FK placement,
  and a Mermaid ER diagram; `isolation.md` present; README answers all design questions. The
  fee double-model and system-account-seed concerns from the pre-impl design-review are
  resolved in the shipped code (single fee model; system accounts seeded 0/0).

---

## Verdict

**APPROVE** (with one doc fix recommended before submission).

The implementation is payments-grade and matches the authoritative design against every
hard requirement: DB-enforced double-entry, visible locked money-path SQL with ascending
lock order, byte-identical idempotent replay, correct reconciliation NULL handling, a
release path that persists FAILED, parameterized statement-ask that cannot be widened by
prompt injection, and a green 62/62 suite. There are no correctness or security blockers.

Fix before submitting:
1. **H-1** — update the README "Verification status" section so it reflects the real
   62/62 Postgres-backed pass instead of "authored but not run / no Postgres pass claimed".
   This is the one item that makes the README dishonest today.

Optional polish (non-blocking): N-1 (one-sentence note that replays return the original
`request_id` verbatim) and N-2 (`.env.example` `ADMIN_TOKEN` comment vs. no enforced admin
auth).
