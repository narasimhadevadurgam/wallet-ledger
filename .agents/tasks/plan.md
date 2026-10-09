# Implementation Plan — Payments-Grade Wallet Ledger

Built from `docs/design.md` (authoritative design) + `docs/schema.md` (authoritative where the two
disagree). The design is NOT re-derived or re-reviewed; this plans the build.

Environment note discovered during planning: Node v26.8.1 is installed, but **Docker and psql/Postgres
are NOT available on this machine**. `tsc` and unit tests (no DB) can run; integration/acceptance tests
need a real Postgres and likely CANNOT run in-environment. Per the task: if a check cannot run, state
exactly what did and did not run in the FINAL SUMMARY and README — never fabricate a pass. Repo has NO
git remote: commit incrementally on `main`, never push, never add a remote.

This same build is also expressed as FEAT artifacts under
`.agents/tasks/task-wallet-ledger-build/` (task.json, context.json, features/FEAT-001..006.json); the
items below are the single-file equivalent and the fallback if the workflow tail is not restructured.

- [ ] 1. Scaffold the TypeScript toolchain and shared foundation (M0).
      package.json (engines.node>=22, type=module; deps express pg node-cron zod uuid; dev typescript vitest tsx cross-env @types/*; scripts build/typecheck/test/test:unit/migrate/seed/start:api/start:worker), tsconfig.json (strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, NodeNext), vitest.config.ts, src/config/env.ts (zod-validated env), src/db/pool.ts (pg Pool; BIGINT stays string), src/db/query.ts (query + withTransaction owning BEGIN/COMMIT/ROLLBACK with isolation-level option), src/money/money.ts (parse/serialize bigint + canonicalJson §11.1 + sha256Hex), src/db/migrateRunner.ts (ordered .sql runner + schema_migrations), scripts/migrate.ts, .env.example, Dockerfile, docker-compose.yml (db+api+worker §16), .github/workflows/ci.yml (postgres:15 service, migrate then vitest with LLM_PROVIDER=mock).
      Files: package.json, tsconfig.json, vitest.config.ts, src/config/env.ts, src/db/pool.ts, src/db/query.ts, src/money/money.ts, src/db/migrateRunner.ts, scripts/migrate.ts, .env.example, Dockerfile, docker-compose.yml, .github/workflows/ci.yml, test/unit/money.test.ts
      Verify: `npx tsc --noEmit` zero errors; `npm run build` emits dist/; `npx vitest run test/unit` passes.

- [ ] 2. M1 — schema + migrations from empty + seed.
      Create migrations/0001_users..0012_config, 0012_indexes (all indexes schema §6), 0013_ledger_insert_only_trigger (BEFORE UPDATE/DELETE RAISE + REVOKE UPDATE,DELETE), 0014_ledger_balanced_transfer_trigger (CONSTRAINT TRIGGER AFTER INSERT DEFERRABLE INITIALLY DEFERRED FOR EACH ROW re-aggregating by NEW.transfer_id), 0015 seed (3 system accounts balance=0 zero entries; risk_rules pinned single_over_max/velocity hold, rapid_drain flag with §20.3-H thresholds; config fee_paise=0; job_locks reconciliation row). scripts/seed.ts (1000 users / 2000 wallets / 100000 transfers via batched inserts).
      Files: migrations/0001..0015*.sql, scripts/seed.ts, test/integration/migrate.test.ts, test/integration/ledgerImmutability.test.ts, test/integration/constraints.test.ts
      Verify: `npx tsc --noEmit` clean; if Postgres available `npm run migrate` on empty DB exits 0 and is a no-op on re-run (AC-15), then `npx vitest run test/integration/migrate.test.ts test/integration/ledgerImmutability.test.ts test/integration/constraints.test.ts` pass (AC-12, AC-13); else record not-run in findings.

- [ ] 3. M2 — transfer money path + HTTP skeleton + isolation lab.
      src/http/{requestId,errors,validation}.ts (uniform {code,message,request_id}, error catalogue §8, zod schemas §8), src/services/{auditService,userService,walletService}.ts, src/services/transferService.ts (one withTransaction READ COMMITTED: lock both accounts FOR UPDATE ordered asc by id, re-read, reject insufficient amount+fee, write balanced entries, update balances, audit, commit; leave idempotency+fraud seams), routes users/wallets/transfers/statement, src/services/statementService.ts (OFFSET + cursor), src/http/app.ts, src/server.ts (migrate then listen), docs/isolation.md (four two-psql-session scenarios §9.3).
      Files: src/http/requestId.ts, src/http/errors.ts, src/http/validation.ts, src/http/app.ts, src/http/routes/{users,wallets,transfers,statement}.ts, src/services/{auditService,userService,walletService,transferService,statementService}.ts, src/server.ts, docs/isolation.md, test/integration/stampede.test.ts, test/integration/pagination.test.ts
      Verify: `npx tsc --noEmit` clean; if Postgres available `npx vitest run test/integration/stampede.test.ts test/integration/pagination.test.ts` pass — STAMPEDE: exactly 50 of 100 succeed each of ~20 iterations, wallet ends 0, never negative, debits==credits (AC-1); else record not-run.

- [ ] 4. M3 — idempotency (§11).
      src/http/idempotency.ts (require UUID Idempotency-Key on the 3 money POSTs -> 400 if missing; body_hash via canonicalJson+sha256). Extend transferService: insert key FIRST inside txn (user_id resolved per §9.1/§11), replay detected ONLY by UNIQUE(user_id,key) violation (committed -> return saved response; body mismatch -> 422; rolled back -> no key, re-execute); never SELECT an in_progress key. Wire middleware into the 3 money routes.
      Files: src/http/idempotency.ts, src/services/transferService.ts (extend), src/http/routes/{wallets,transfers}.ts (wire), test/integration/idempotency.test.ts
      Verify: `npx tsc --noEmit` clean; if Postgres available `npx vitest run test/integration/idempotency.test.ts` pass — AC-2 (x5 seq -> 1 transfer, 5 identical), AC-3 (x10 parallel -> 1), AC-4 (diff body -> 422 no money), AC-5 (missing key -> 400; exempt POST not 400), §11.3 Case-2 retry; else record not-run.

- [ ] 5. M4 — reconciliation worker + admin trigger.
      src/services/reconciliationService.ts (REPEATABLE READ txn; job_locks FOR UPDATE NOWAIT FIRST -> 55P03 => 409 RECON_LOCKED; five checks a–e each one query, orphan sub-check restricted to status IN ('COMPLETED','REVERSED'); one run row + one problem row per problem; reports never fixes; error handling; optional 24h key cleanup), src/http/routes/admin.ts (POST /admin/reconciliation/run), src/worker.ts (node-cron + migrate-if-needed).
      Files: src/services/reconciliationService.ts, src/http/routes/admin.ts, src/http/app.ts (mount admin), src/worker.ts, test/integration/reconciliation.test.ts
      Verify: `npx tsc --noEmit` clean; if Postgres available `npx vitest run test/integration/reconciliation.test.ts` pass — AC-6 (10k settled, corrupt 3 -> exactly 3 problems + nothing else), AC-7 (409 RECON_LOCKED); else record not-run.

- [ ] 6. M5 — fraud rules + LLM + admin release + README.
      src/services/riskService.ts (evaluate risk_rules inside transfer txn after funds check before commit; hold->HELD no money + risk_flags + audit, flag->risk_flags + proceed), release endpoint in admin.ts + transferService (§9.1.1 HELD->COMPLETED or HELD->FAILED), src/llm/{LlmClient,factory,ollamaClient,mockClient,statementPrompt,explainPrompt}.ts (mock is shared substring-keyed fixture §10.1), statement/ask route + executor (validated JSON, counterparty resolution §10, parameterized SQL scoped to path user), nightly LLM explanation worker step, and the full README deliverable (design-question answers, routes/errors table, trade-offs, what-I'd-do-next, 5-minute demo-video script).
      Files: src/services/riskService.ts, src/services/transferService.ts (extend), src/services/statementService.ts (extend), src/http/routes/{admin,statement}.ts, src/llm/{LlmClient,factory,ollamaClient,mockClient,statementPrompt,explainPrompt}.ts, src/worker.ts (extend), README.md, test/integration/{risk,promptInjection,statementAsk}.test.ts
      Verify: `npx tsc --noEmit` clean; unit tests for mock LLM / ask JSON validation pass; if Postgres available `npx vitest run test/integration/risk.test.ts test/integration/promptInjection.test.ts test/integration/statementAsk.test.ts` pass — AC-8/AC-9 (HELD/release/FAILED, velocity hold+flag), AC-10 (injection note does not widen scope), AC-11 (10 questions, #10 -> 422); else record not-run.

- [ ] 7. STEP-4 real verification sweep + honest final summary.
      Run `npx tsc --noEmit` (build) and the full `npx vitest run`. Start a real Postgres 15 (docker compose up, or local/containerized Postgres if compose unavailable), run migrations from empty, run the full suite and make the FOUR acceptance tests (STAMPEDE, IDEMPOTENCY, RECONCILIATION, PROMPT-INJECTION) pass for real; if Docker is available also verify `docker compose up` brings up db+api+worker + a health check. Clean up temporary artifacts.
      Files: README.md (verification section), .agents/tasks/ (final summary)
      Verify: full `npx vitest run` result recorded truthfully. If Docker/Postgres cannot run in-environment, the FINAL SUMMARY and README state exactly which checks ran (tsc, unit tests) and which did not (integration/acceptance, compose) and why — NEVER a fabricated pass.
