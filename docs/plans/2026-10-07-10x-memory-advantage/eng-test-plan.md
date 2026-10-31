# Eng test plan: 10x memory advantage, waves 0 to 2

Source plan: gbrain-evals `docs/plans/2026-10-07-10x-memory-advantage/PLAN.md` (eng input SHA-256 3945060500fe2af5e1c4c70e4f3956d03a1b0cbe70b9e9a33b4408c1f79ebd83).
Pins: gbrain master `7aa2caa0` (v0.60.106.0), gbrain-evals main `f1ce49fe`.
Written by the autoplan eng phase (native reviewer), 2026-10-07. Every row names the test that proves the item, whether it exists today, the CONTRIBUTING.md change kind, and the regenerate command. "Forced probe" means the test fails on master and passes on the branch, per `CONTRIBUTING.md` "Discrimination test".

## Gate that applies to every gbrain wave PR

1. `bun run verify` (typecheck, guards, generated-file freshness).
2. Full gate on the exact tree: `UBI_OWNER=gbra60 bun run ci:ubicloud` (check `scripts/ubicloud/ubi-runner.sh usage` first; fall back to `bun run ci:local`, reported as local). E2E selection is retired (`docs/TESTING.md` "E2E selection"): any non-doc change runs every `test/e2e/*.test.ts`, including PgBouncer passes of `scripts/e2e-backend-matrix.txt`.
3. `bun run test:stress <touched test files>` (the PR stress gate runs each touched file 10 times).
4. Regenerated goldens named in the PR body with the reason.
5. When the PR in front is #6271 or #6066, gate ahead on the branch merged with that PR's head and the version it will get.

## Wave 0, gbrain (one batched PR)

| Item | Change kind | Test (new unless marked existing) | Forced probe | Regenerate |
|---|---|---|---|---|
| D1 empty and unknown-only `request_tools` | op handler | `test/request-tools.test.ts` (existing, extend): `{tools: []}` and `{tools: ['no_such_op']}` return the grouped catalog; an existing-but-invisible name and a nonexistent name give byte-identical HTTP responses; "did you mean" candidates come only from `visibleOpsForCaller`; mixed lists keep today's behavior. `test/request-tools-stdio.test.ts` (existing): widenable stdio still lists the widen note | `{tools: []}` returns `{tools: []}` on master | `bun run scripts/generate-tool-catalog.ts` if the description changes; `test/mcp-schema-budget.test.ts` (existing) must stay at or under 25,000 starter chars |
| D1 hidden-tool sentence position | instructions | `test/mcp-initialize-instructions.test.ts` (existing, `HARNESS_READ_LIMIT = 2_048`): the `request_tools` sentence ends before char 2,048 for starter with `hiddenCallable > 0`; byte-identity with `GBRAIN_MCP_INSTRUCTIONS` when no `tools` is passed still holds | sentence index > 2,048 on master for a starter + writeback + status-line configuration | none |
| D4 profile default | grants | `test/client-grants.test.ts` / new `test/grant-profiles-surface.test.ts`: `resolveGrantProfile('memory-writer'|'coding-agent')` yields surface `full`; `memory-reader` stays read-only (no `put_pages` in `allowedOperations`); explicit re-profile of an existing client is the only path that widens | memory-writer surface is `starter` on master | none |
| D4 caller diagnosis (`whoami` field, once-per-session notice) | op + notice | `test/whoami.test.ts` (existing, extend; `whoami` lives in `src/core/ops/sources.ts`): snapshot-blocked, pin-blocked, both, scope-blocked, server-ceiling cases each name the right blocker and count ops without naming them; count uses the scope-eligible set, not the raw catalog. Notice ledger: one delivery per (principal, session) on stdio and HTTP, including stateless HTTP calls with no session id | no field on master | `bun run build:error-codes` for any new code; `docs/guides/error-codes.md` |
| D4 doctor `grant_new_ops_available` | doctor check | new `test/doctor-grant-new-ops.test.ts` on in-memory PGLite (copy `test/doctor-slug-collisions.test.ts`): token and client argvs differ; fix is `ask_user`; `--operations all` never the default; plus `bun test test/doctor-registry.test.ts` | check absent on master | `GBRAIN_TEST_UPDATE_GOLDENS=1 bun test test/doctor-registry-golden.test.ts test/doctor-json-golden.test.ts`; entry in `DOCTOR_CHECK_REGISTRY` and `src/core/doctor-categories.ts` |
| D4 hermetic end to end | E2E | `test/e2e/client-grants.test.ts` / `test/e2e/oauth-client-grant-axes.test.ts` (existing, extend): fresh memory-writer client calls `put_pages`; operator-pinned old client is reported, not widened; restricted client and reader still refused. N6 visibility fuzz unchanged (0 leaks) | fresh client refused on master | none |
| D4 `BEHAVIOR_CHANGES` row | notice table | `test/behavior-change-notice.test.ts` (existing) | n/a | `since:` set by `bun run release:restamp` at the merge slot |
| S0 surface constant | registration + docs | `test/mcp-registration.test.ts`, `test/bootstrap-hooks-writers.test.ts:259,276`, `test/check-bootstrap-guards.test.ts:480`, `test/codex-plugin-manifest.test.ts`, `test/bootstrap-plugin-lane.serial.test.ts` (all existing; update the pinned value deliberately); new grep test: README, `docs/mcp/*`, `INSTALL_FOR_AGENTS.md`, `BOOTSTRAP_FOR_AGENTS.md`, `docs/guides/push-context.md` and the three manifests carry only the constant's value; full-surface `tools/list` byte size recorded | grep finds `verbs`, `starter` and bare `serve` defaults on master | `bun run scripts/generate-plugin-tree.ts --out plugin`, `bun run check:plugin-tree`, `bun run build:llms` |
| E-A embed phase warn | cycle phase | new `test/cycle-embed-phase-warn.test.ts` on PGLite: blocked image page + stale chunks gives phase `warn`, cycle status `partial`; `lock_skipped` stays `ok`; `test/e2e/cycle.test.ts` (existing) unaffected; autopilot daemon treats `partial` as non-fatal (existing behavior, add an assertion) | phase `ok` on master with `failures > 0` | none |
| E-B doctor backlog age | doctor check + engine read | `test/doctor-embedding-backlog.test.ts` (existing, extend): 95% coverage, 50k missing, pending older than threshold and no progress gives `warn`; fresh brain mid-drain gives `ok`; edited old page (chunk `created_at` old, embedding just cleared) gives `ok`; model-swap invalidation actively draining gives `ok`; keyless gives `info`. If a pending-since column is added: schema-migration row below | `ok` on master at 89% with 136k missing | doctor goldens as for D4 |
| Pending-since column (only if chosen) | schema migration | `bun run new:migration chunk_embedding_pending_since`; `bun test test/scripts/build-schema-migrations.test.ts test/migrate.test.ts`; `GBRAIN_TEST_UPDATE_GOLDENS=1 bun test test/migrations-golden.test.ts test/schema-catalog-golden.test.ts`; every NULL-ing site sets it (`engine-sql/chunks.ts` upsert, `embedding-invalidation.ts`, `embedding-migration.ts`, `embedding-dim-check.ts` text) with a case in `test/helpers/engine-sql-rollback-cases.ts` | n/a | `bun run build:schema`, `bun run build:pglite-snapshot` |

## Wave 0, gbrain-evals

| Item | Test | Probe |
|---|---|---|
| A1 usage on every reader row | new `test/eval/memory-qa-usage.test.ts` (no memory-qa unit test exists today): the think lane records `res.usage.input_tokens`, not `approxTokens(question)`; every row carries provider tokens and cl100k delivered tokens. gbrain side: extend `test/eval-longmemeval-cli-smoke.test.ts` so `generateAnswer` returns provider usage | think row input equals question tokens on master |
| A1 W10a rescoring | script receipt reproduces the 22,167 mean | n/a |
| R1 prices | `test/eval/budget-ledger.test.ts` (existing): `anthropic:claude-haiku-5-5` priced | absent on master |
| B1 adapter (on #89) | `test/eval/memory-systems.test.ts`, `test/eval/systems-conformance.test.ts` on `capy/oss-memory-shootout`: gbrain arm returns `query` evidence-delivery items, chunk arm kept as diagnostic | adapter calls `hybridSearch` today |

## Wave 1 (eval-only items build off master; A8 and A9 gbrain)

| Item | Test |
|---|---|
| A3 brief builder | new `test/evidence-brief.test.ts`: pointer and SHA round trip, injection fixture adds no claim, five adversarial fixtures caught or counted, ungrounded claims dropped, full-text fallback when grounding fails |
| A4 arms | byte-identical A0 replay test; 2-question keyless smoke per arm |
| A8 `think.evidence_brief` | `test/think-*.test.ts` family: default off is byte-identical to today; config key registered (`bun run build:flag-registry` if a CLI flag) |
| A9 `assemble_evidence {mode: 'brief'}` | `test/e2e/mcp-budget-reservation-postgres.test.ts` pattern: reservation and settle for a synchronous op; budget-exhausted refusal with `fix.next: ask_user`; null-budget grants get the declared default cap, not unlimited; keyless returns intact evidence plus notice; `cost_usd` present; N6 fuzz |

## Wave 2

| Item | Test |
|---|---|
| D2 `next` | installed-configuration matrix (starter, full, verbs, read-only stdio, pinned HTTP, client ignoring `tools/list_changed`): every emitted `next` is callable on that connection; reuse `test/hidden-tool-hint.test.ts` (existing) decision cases |
| D8 `gbrain setup` | CLI-only command row: `test/setup.test.ts` spawning `bun src/cli.ts setup`, `bun test test/cli-command-table.test.ts test/cli-flag-validation.test.ts`, CLI goldens (`test/cli-goldens.test.ts test/cli-dispatch-phase.test.ts test/cli-dispatch-thin-client.test.ts`), phase `pre-connect`; adoption cases; consent negatives; `--remove` and second run; `gbrain status --funnel` is a flag (`bun run build:flag-registry`) |
| E-C readiness | `test/projection-readiness.test.ts`, `test/search-projection-readiness.test.ts`, `test/e2e/projection-readiness-currency.test.ts` (existing, extend): per-projection states, disabled distinct from pending, cache invalidates on embedding writes (not only the page clock), paired privacy probes identical N/M/K; latency probe at 1M chunks |
| E-D | `test/doctor-*sync*` family plus a cursor-with-progress-no-checkpoint probe; lands after #6279 |

## Merge-order constraints found by the eng review

- Wave 0's gbrain PR edits files #6271 edits (`src/mcp/dispatch.ts` notice ledger, `src/core/behavior-change-notice.ts`, `src/core/error-registry.ts`, `docs/TOOL_CATALOG.md`) and files #6066 edits (`src/core/cycle.ts`, `src/core/doctor-categories.ts`, `src/core/error-registry.ts`, `.codex-plugin/mcp.json`, `docs/TOOL_CATALOG.md`). Build D4's notice on #6271's `NoticeAudience`, merge master in with merge commits after each lands, and gate on the merged tree.
- E-D after #6279 (GBRA-45; edits `src/core/persistence/sync-drain.ts`).
- #6271 and #6066 both carry a v220 migration; any wave 0 migration takes its number at the slot via `release:restamp`.
