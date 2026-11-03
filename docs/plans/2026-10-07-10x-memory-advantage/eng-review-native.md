INPUT: eng 3945060500fe2af5e1c4c70e4f3956d03a1b0cbe70b9e9a33b4408c1f79ebd83

# Eng review (native): Build the 10x memory advantage, waves 0 to 2

I read the whole input: 524 lines, 151,769 bytes, SHA-256 56275fe4…26df1e0, with lines 184, 231 and 233 recovered in full past the 2,000-character display cap. I checked it against gbrain master `7aa2caa0` (v0.60.106.0), gbrain-evals `f1ce49fe`, `origin/capy/oss-memory-shootout` (`9c07b7e`), and the full file lists of #6271 (138 files), #6066 (238) and #6279 (GBRA-45's `capy/sync-feeder-fast-writes`, 115), pulled through the GitHub API with pagination. GBRA-58 has no open PR yet: its thread plans PR1 (purge), PR2 (trust tiers) and PR3 (write gate), and #5575 and #6278 are issues, not PRs. Everything was read-only, with no paid calls. The test plan is at `/home/user/.gstack/projects/garrytan-gbrain-evals/eng-test-plan-10x-memory-advantage.md`.

The direction holds, and most of wave 0 is smaller than estimated. Three claims are wrong in ways that would ship bugs or conflicts:
- The backlog-age design reads a timestamp that does not mean what the plan assumes.
- The one wave 0 to 2 migration names a column that already exists.
- Wave 0 is scheduled as if it did not collide with #6271 and #6066, but it does.

## 1. Scope challenge, grounded in code

**Smaller than the plan says**
- **E-A (0.5 / 3).** Since #6223/#6269, blocked pages already land in `EmbedResult.failures` (`src/commands/embed.ts:1627-1649`). `runPhaseEmbed` (`src/core/cycle.ts:1621-1666`) returns `status: 'ok'` without reading `failures`. So the "blocked or failed pages exist" half is a few lines plus a forced probe. The "0 embedded for N cycles" half has no substrate: no cycle-history table exists, and nothing persists across cycles (grep for cycle_runs/history finds nothing). Either add a small config-key ring or drop that half in favour of E-B's age signal.
- **A1.** `think` already returns `usage` (`src/core/think/index.ts:217`). The evals bug is the single line `tin += approxTokens(q.question)` (`eval/runner/memory-qa/run.ts:380`). The gbrain reader drops `response.usage` in `generateAnswer` (`src/eval/longmemeval/reader.ts:147-185`). No collisions: neither #6066 nor #6271 touches these files.
- **D1 (0.75 / 4).** It is a handler branch in `request-tools.ts:298-320` plus one sentence moved in `buildMcpInstructions` (`instructions.ts:114-115` appends after the contract today). The test seam already exists: `HARNESS_READ_LIMIT = 2_048` in `test/mcp-initialize-instructions.test.ts`.

**Larger than the plan says**
- **E-B ("no migration").** "Oldest unembedded chunk age" can only be read from `content_chunks.created_at` (`schema.sql:321`). The upsert's `ON CONFLICT … DO UPDATE` never resets `created_at` (`engine-sql/chunks.ts:252-285`), but it NULLs the embedding when text changes. Model-swap invalidation (`embedding-invalidation.ts:202`, `embedding-migration.ts:223`) NULLs embeddings without touching `created_at` either. So the moment someone edits an old page, or the brain changes embedding model, the backlog reads as months old. The "old **or** no progress" rule then warns on a brain that is draining normally. That is the exact false positive the plan's last risk row promises to avoid. The fix is either a pending-since timestamp (an additive migration, `embedding_pending_since`, set at every NULL-ing site) or a page-time proxy plus a required no-progress condition.
- **E-C (3 / 14).** Its declared migration, "one additive (`content_chunks.embedded_at`)", already exists (`schema.sql:315`, written by `engine-sql/chunks.ts:160`). The column E-C actually needs for "embedded-at minus created-at" is the same pending-since timestamp, because `created_at` is wrong for re-embedded chunks. The readiness extension is also a hot-path change. Today's probe is one `EXISTS` over `pages`, cached by `page_generation_clock_seq` (`search/projection-readiness.ts:35-116`). Embedding, fact and graph writes do not advance that clock, so a cached "vector ready" answer goes stale, and per-request `COUNT`/`MIN` over 1.28M chunks is not free.
- **D4 (2.5 / 12).** The `budget_usd_per_day` and notice pieces touch #6271's notice-ledger refactor (section 6). The "once per session" notice needs a defined behaviour for stateless HTTP calls.
- **D8 (8 / 40).** It is credible only as an orchestrator over `bootstrap`, which already carries `--harness --remove --no-hooks --surface --dry-run` (`cli-flag-registry.generated.ts:27`). It must be `phase: 'pre-connect'`. The funnel's "use after seven days" needs a local persisted counter the plan never specifies; keep it a file under `GBRAIN_HOME`, not a DB table. It overlaps `gbrain onboard` and the `harness_wiring` doctor check (reuse that check's smoke as setup's verify).

**Named wrongly or missing**
- **`whoami`** lives in `src/core/ops/sources.ts:32`, not `src/core/ops/admin.ts` (D4).
- **Doctor checks** belong in `src/commands/doctor/checks/<topic>.ts` plus `registry.ts`, `src/core/doctor-categories.ts` and the doctor goldens, not in `src/commands/doctor.ts` (D4, E-C).
- **D4's `grant_new_ops_available`** belongs next to `checks/legacy-token-grants.ts`.
- **E-C's "new doctor check"** duplicates the existing `text_projection_readiness` (`checks/projection-readiness.ts`), so extend that instead.
- **`skills-catalog.ts`** is `src/core/ops/skills-catalog.ts`.
- **`gbrain status --funnel`** is a flag on an existing command (`thinClient: 'none'`, `command-table.ts:322`). It needs `build:flag-registry`, not a new command-table record.
- **D2 misses two files.** `src/mcp/hidden-tool-hint.ts` already implements the hidden-but-widenable vs CLI-equivalent decision on stdio (F6). `src/core/ops/request-tools.ts` is the other. D2 should reuse that decision, not write a second one.
- **S0 misses docs and tests.** `docs/mcp/CODEX.md:46,207` says `starter`. The stale hook-lane claim also sits in `BOOTSTRAP_FOR_AGENTS.md:96` and `docs/guides/push-context.md:98`, not only `INSTALL_FOR_AGENTS.md:182-184`; `docs/guides/bootstrap.md:187` is already correct. `docs/mcp/ADMIN.md:484` names starter, and the tests that pin `starter` are `test/bootstrap-hooks-writers.test.ts:259,276` and `test/check-bootstrap-guards.test.ts:480`.
- **S0 misses its regenerate steps.** The manifests feed a generated tree: `bun run scripts/generate-plugin-tree.ts --out plugin`, enforced by `check:plugin-tree`. README and INSTALL edits need `bun run build:llms`.
- **The error catalogue is split across two files.** `src/core/error-catalogue.ts` holds only `{code, docs}`, and its test requires the anchor to live in `repair.md` or `write-refusals.md`. The `why`, `fix` and `summary` fields live in `src/core/error-registry.ts` (`CodeEntry`), regenerated by `bun run build:error-codes`. Warnings are not codes at all: E-A is a cycle `PhaseResult` and E-B a doctor `Check` with an `Action` (`embedBackfillFix`). So "catalogue entry" is the wrong mechanism for E-A and E-B, and notices go through `agent-output` `Notice` plus the notice ledger.

## 2. Architecture: what waves 0 to 2 add

```
 WRITE PATH (unchanged except where marked)        READ PATH
 put_page/put_pages ─► persistence ─► pages        MCP tools/call ─► dispatch.ts ─► ops/*
   │ (D4: memory-writer grant now callable full)     │  allowedOps gate (dispatch.ts:739-744)
   ▼                                                 │  unknownToolEnvelope + hidden-tool-hint (D2 reuses)
 content_chunks (embedding NULL)                     │  admitNotices/NoticeAudience (#6271) ◄─ D4 stale-grant notice
   │  [+pending_since? F1]                           ▼
   ▼                                               ops/search.ts query/search ─► evidence-delivery
 cycle ─► runPhaseEmbed ─► runEmbedCore              │  buildRetrievalResponseMeta
   │  E-A: failures>0 → 'warn' → cycle 'partial'     │   └─ probeProjectionReadiness ◄─ E-C: per-projection
   ▼                                                 │        (cache key = page clock; E-C needs embed clock)
 doctor embeddings (schema-health.ts:339-393)        │  assemble_evidence {mode:'brief'} ◄─ A9 (wave 1)
   E-B: backlog + age/no-progress → warn             │        └─ budget-meter reserve/settle (NEW for sync ops)
 doctor grant_new_ops_available (D4)                 ▼
                                                   think ─► gather ─► (A8 think.evidence_brief flag, off)
 REGISTRATION / INSTRUCTIONS                                      └─ A3 evidence-brief builder (eval-only first;
 REGISTRATION_SURFACE (mcp-registration.ts:23) ◄─ S0                 groundSource + synthesize-verify + sanitize)
   ├─ bootstrap hooks writers, plugin generator ─► .claude-plugin / .codex-plugin / plugin/ tree
   └─ gbrain setup <harness> (D8, pre-connect) ─► bootstrap/connect/init (reused), harness_wiring verify
 buildMcpInstructions: D1 sentence inside first 2,048 chars; request_tools empty/unknown → catalog
 thin CLI ─► remote MCP ─► volunteer_context (D8b push route) ─► resolve-ipc.ts
```

The coupling to watch is that D4, D2, E-C and A9 all emit model-visible text through `dispatch.ts` and the notice ledger, which #6271 is rewriting right now. Build them on the merged ledger API, not on master's.

## 3. Codepath to test

```
D1 handler ─────► test/request-tools.test.ts (extend) + request-tools-stdio.test.ts; mcp-schema-budget.test.ts
D1 sentence ────► test/mcp-initialize-instructions.test.ts (2,048 seam)
D4 profiles ────► client-grants / new grant-profiles-surface.test.ts
D4 whoami ──────► test/whoami.test.ts (ops/sources.ts)
D4 doctor ──────► new test/doctor-grant-new-ops.test.ts + doctor goldens (GBRAIN_TEST_UPDATE_GOLDENS=1)
D4 e2e ─────────► test/e2e/client-grants.test.ts, oauth-client-grant-axes.test.ts; N6 fuzz
S0 ─────────────► mcp-registration, bootstrap-hooks-writers, check-bootstrap-guards, codex-plugin-manifest,
                  bootstrap-plugin-lane.serial; new grep test; regen plugin tree + build:llms
E-A ────────────► new test/cycle-embed-phase-warn.test.ts (forced probe), e2e/cycle.test.ts
E-B ────────────► test/doctor-embedding-backlog.test.ts (extend: edit + model-swap negatives)
[migration?] ───► new:migration; build-schema-migrations + migrate + migrations/schema-catalog goldens;
                  build:schema; build:pglite-snapshot; engine-sql-rollback-cases
A1 ─────────────► evals new test/eval/memory-qa-usage.test.ts; gbrain eval-longmemeval-cli-smoke
R1 ─────────────► evals test/eval/budget-ledger.test.ts
B1 ─────────────► #89 test/eval/memory-systems.test.ts, systems-conformance.test.ts
A3/A8/A9 ───────► new evidence-brief.test.ts; think tests; e2e/mcp-budget-reservation-postgres pattern
D2 ─────────────► installed-config matrix + test/hidden-tool-hint.test.ts
D8 ─────────────► CLI-only row: test/setup.test.ts, cli-command-table, cli-flag-validation, CLI goldens
E-C ────────────► projection-readiness, search-projection-readiness, e2e/projection-readiness-currency
E-D ────────────► sync doctor tests, after #6279
```

## 4. NOT in scope (for this eng phase)
- Waves 3 to 6 implementation detail, beyond the migration checks in section 7.
- Paid-run design: the A5 arms, sealed openings and Cat 40 smoke budgets belong to the CEO and DX phases.
- #89 Phase 7 hold policy (challenge 1), the write-path default (challenge 2) and the surface outcome (challenge 3). This review only notes what each decision blocks.
- GBRA-59's sync-stall fix and GBRA-58's trust tiers themselves.

## 5. What already exists (reuse, don't rebuild)
- **`hiddenToolHint`** (`src/mcp/hidden-tool-hint.ts`) already decides between widen and CLI-equivalent for D2.
- **`unknownToolEnvelope`** (`dispatch.ts:534`) and `suggestNearest` cover D1's "did you mean". Note that its candidates are `allowedOps`, while `request_tools` uses `visibleOpsForCaller`; D1 should draw from the latter.
- **`embedBackfillFix`** (`embed-consent.ts:37`) and the `failures` / `failure_samples` fields of `EmbedResult` serve E-A and E-B.
- **The `content_chunks.embedded_at` column and the partial index** `(page_id, chunk_index) WHERE embedding IS NULL` (`schema.sql:367`) already exist.
- **The `text_projection_readiness` doctor check** and the `projection_readiness` cache already exist.
- **`budget-meter` `reserve`/`settle` and `mcp_spend_reservations`** exist, but they are wired only into delegated jobs (`minions/delegated-spend.ts`).
- **Stale-grant messaging** exists: `harness.ts:807` says "N newer operation(s) withheld", and the token-only `auth rescope --refresh-operations` (`auth.ts:1221`) covers the token side.
- **`BEHAVIOR_CHANGES`** has its row machinery and the `behavior-changes` doctor check.
- **`harness_wiring`** already does a doctor smoke of registrations, and `bootstrap` already carries D8's escape-hatch flags.

## 6. Merge-queue sequencing, verified against the PR file lists

| Wave 0–2 file | #6271 (GBRA-39) | #6066 (GBRA-52) | #6279 (GBRA-45) | Item |
|---|---|---|---|---|
| `src/mcp/dispatch.ts` (notice ledger → `NoticeAudience`) | yes | | | D4, D2 |
| `src/core/behavior-change-notice.ts` (+11 rows at 0.60.107.0) | yes | | | D4, S0 |
| `src/core/error-registry.ts` | yes | yes | | D4, D8, E-C (GBRA-58 PR1 too) |
| `src/core/cycle.ts` (new `standing_questions` phase) | | yes | | E-A |
| `src/core/doctor-categories.ts`, `doctor/registry.ts` | | yes | | E-B, D4 |
| `.codex-plugin/mcp.json` | | yes | | S0 |
| `src/cli/command-table.ts` | | yes | | D8 |
| `src/core/ops/search.ts`, `operations-descriptions.ts`, `interop-notices.ts` | yes | yes (not interop) | | D2, E-C |
| `src/core/config.ts` | yes | yes | yes | D3, A8 |
| `src/core/persistence/sync-drain.ts` | | | yes | E-D |
| `docs/TOOL_CATALOG.md` (generated) | yes | yes | | D1 |

The plan's wave 2 claim (D2 and D3 collide with #6271 and #6066) is correct, and E-D after GBRA-45 is correct (`sync-drain.ts` is confirmed). Wave 0 is the problem: section 6 opens its gbrain PR on Oct 8 to 9 with no dependency, yet D4, S0, E-A and E-B touch six files that #6271 or #6066 also edit. Both of those PRs are drafts, and #6066 stays a draft "until sealed results". Most conflicts are append-only (registry entries and `BEHAVIOR_CHANGES` rows). D4's notice is a real semantic dependency on #6271's ledger API. A8 (`think/index.ts`) overlaps GBRA-58 PR2's `think/` and #6066's `temporal-context.ts`, which the plan already names. #6271 and #6066 both carry a v220 migration, so whichever lands second renumbers.

## 7. Migration claims
- **Waves 0 to 2 as written: zero true migrations.** E-C's declared one is a no-op, because `embedded_at` exists. If E-B and E-C keep "age of the backlog", they need one additive nullable column (`embedding_pending_since TIMESTAMPTZ`) set at each NULL-ing site: the `chunks.ts` upsert, `embedding-invalidation.ts:202`, `embedding-migration.ts:223,1321`, and the text in `embedding-dim-check.ts:271`. Ship it in wave 0 with E-B, or use the proxy.
- **The pattern fits.** `bun run new:migration` creates `src/core/schema-migrations/v<NNN>-*.ts` (v214 is the template: `CREATE TABLE IF NOT EXISTS`, indexes and the `DO $rls$` block that enables RLS only when the role has BYPASSRLS; the v35 `auto_rls_on_create_table` trigger covers Postgres). Fresh-install DDL goes in `schema.sql`, then `build:schema` and `build:pglite-snapshot` run, and the migrations and schema-catalog goldens regenerate. PGLite runs the same SQL, and the RLS block is guarded.
- **W1 `belief_events` (wave 4).** It fits the additive pattern, but `migrate-engine` copies pages through the engine (fresh SERIAL ids) and only three tables explicitly (`migrate-engine.ts:860`), so `page_versions` is not copied, which confirms W5. A ledger keyed on `page_id` or fact row ids will not survive `migrate-engine`; key it on `(source_id, slug, stable fact/take/link key)` or add id remapping. W9's `page_refresh_proposals` has the same problem.

## 8. Ubicloud gate and E2E tier
E2E diff narrowing is retired (`docs/TESTING.md` "E2E selection"), so every wave PR, including S0, runs every `test/e2e/*.test.ts` plus the PgBouncer passes. S0 is not doc-only, because it touches `mcp-registration.ts`. One full gate is about 5 minutes on 4 VMs. With #6271, #6066 and #6279 queued ahead of wave 0, the "gate ahead on the merged tree" rule pays off: gate wave 0 on master + #6271's head. Doctor, CLI and migration goldens are regenerated on purpose and named in the PR body. `UBI_OWNER=gbra60` is the owner, with teardown after each gate.

## 9. Failure-modes registry (critical gaps)

| # | Ships wrong → production effect | Forced probe that catches it |
|---|---|---|
| FM1 | E-B ages backlog by `created_at` → every edited old page or model swap fires "old backlog, paid fix" on a healthy draining brain; agents ask users to approve spend needlessly | old page edited (chunk text changed, embedding NULL), backlog shrinking → must be `ok` |
| FM2 | E-C caches vector readiness under the page clock → search says "ready" while chunks are unembedded (or the reverse) | embed a chunk without a page write; readiness must change under cache on |
| FM3 | A9 relies on `budget_usd_per_day` → null for default grants, enforced only for delegated jobs → a read-scope client runs unbounded paid briefs | memory-reader with null budget calls `mode:'brief'` N times → refusal at the declared default cap |
| FM4 | D1 "did you mean" uses `allowedOps` or raw catalog on HTTP → existence oracle for hidden or ungranted ops | invisible-existing vs nonexistent name → byte-identical HTTP envelopes |
| FM5 | D4 notice counts raw catalog delta → memory-writer told "predates 30 ops" that are admin-only; noise, and a count oracle | writer grant vs catalog with new admin op → count 0 |
| FM6 | D4 notice "once per session" on stateless HTTP → fires every call or never | 3 stateless calls same principal → exactly 1 notice |
| FM7 | E-A `warn` → cycle `partial` → a consumer treating partial as failure trips a breaker | daemon keeps cycling with a permanent blocked page (assert on `autopilot-daemon.ts:625` path) |
| FM8 | S0 flips the plugin and bootstrap default to `full` → harnesses with tool-count caps truncate or reject 140 tools; then challenge 3 narrows → two flips | record full `tools/list` bytes and count in S0's proof; merge only after challenge 3 is decided |
| FM9 | D8 setup on a live PGLite brain starts a second owner | live serve holds lock → setup must refuse with the owner-conflict code |
| FM10 | W1 ledger keyed on row ids → history silently lost on `migrate-engine` | round trip PGLite→Postgres → event count and keys equal |

## 10. Findings (consensus-ready)

1. **HIGH, wrong timestamp for backlog age.** Plan text: E-B "…only when the backlog is also old (its oldest unembedded chunk is older than a threshold) or has made no progress for N cycles…", Migration "no". `created_at` is not reset when an upsert or model swap NULLs the embedding (`chunks.ts:252-285`, `embedding-invalidation.ts:202`). Fix: add `embedding_pending_since` (an additive wave 0 migration), or require no-progress AND age from a page-time proxy. Add the edit and model-swap negatives to the proof.
2. **HIGH, E-C's migration already exists.** Plan text: E-C "**yes**, one additive (`content_chunks.embedded_at`)". The column is at `schema.sql:315`. Fix: drop it, and use finding 1's column for embedded-at latency.
3. **HIGH, wave 0 collides with #6271 and #6066.** Plan text: section 6 "Oct 8 to 9 | Wave 0 PRs open: … D1 …, D4 …, S0, E-A, E-B …" while only wave 2 "branches from master after both merge". The collisions are verified in section 6, including D4's dependency on #6271's `NoticeAudience`. Fix: send the wave 0 file list to GBRA-40, build D4 on #6271's ledger, merge master after each lands, and gate on master + #6271.
4. **MEDIUM-HIGH, A9's spend cap is unlimited for most grants.** Plan text: A9 "the cap is the grant's existing `budget_usd_per_day` (`grants/model.ts`)". It is null by default (`profiles.ts`), and it is enforced only for delegated jobs (`minions/delegated-spend.ts`). Fix: wire `reserve`/`settle` for synchronous paid ops, and give a null budget a declared default cap, not unlimited.
5. **MEDIUM, E-C's readiness cache goes stale.** Plan text: E-C "extends it to report keyword, vector, facts and graph state separately…". The cache generation is the page clock only (`projection-readiness.ts:35-48`). Fix: add an embed/facts/graph generation component, keep the per-request work to bounded `EXISTS`, and push counts and ages to doctor and status. Add a 1M-chunk latency probe.
6. **MEDIUM, error catalogue mechanics.** Plan text: "gets an entry in gbrain's `src/core/error-catalogue.ts` with a code, a `why`, a `fix.next`, a read-only `fix.verify` and a docs anchor". Fix: codes go in `error-registry.ts` plus `bun run build:error-codes`, with the catalogue anchor in repair.md or write-refusals.md. E-A and E-B are a `PhaseResult` and a `Check` with `embedBackfillFix`, not codes. Notices use notice codes.
7. **MEDIUM, S0 is a behaviour change.** Plan text: S0 "callable `full` and advertised `full` (what challenge 3 picks, if it narrows)… `REGISTRATION_SURFACE` (`starter` today)". Fix: merge S0's runtime part only after challenge 3 is decided. Add CODEX.md, BOOTSTRAP_FOR_AGENTS.md:96, push-context.md:98, the plugin-tree regeneration and `build:llms`, and record the full `tools/list` size.
8. **MEDIUM, wrong file names.** Plan text: D4 "`src/core/ops/admin.ts` (`whoami`)", "`src/commands/doctor.ts`"; E-C "`skills-catalog.ts`… new doctor check"; "every new CLI command (… `gbrain status --funnel`)". Fix as in section 1.
9. **MEDIUM, D2 should reuse F6.** Plan text: D2's file list omits `src/mcp/hidden-tool-hint.ts`. Fix: reuse its decision, and extend `test/hidden-tool-hint.test.ts`.
10. **MEDIUM, E-A's no-progress half has no substrate.** Plan text: E-A "…or when a backlog stays > 0 with 0 embedded for N cycles". Fix: ship `failures > 0 → warn` now (excluding `lock_skipped`), and drop the N-cycle half or add a config-key ring with its own test.
11. **MEDIUM, D8 funnel state is unspecified.** Plan text: D8 "`gbrain status --funnel --json` … use after seven days". Fix: a local file under `GBRAIN_HOME` (no migration), setup as `pre-connect`, and reuse `harness_wiring` as the verify.
12. **LOW, `belief_events` keys.** Plan text: W1 "keyed on their existing stable identities"; this must mean slug-level keys, not row ids, for `migrate-engine`. Add the explicit copy at `migrate-engine.ts:860`.
13. **LOW, A1 has no test home.** No memory-qa unit test exists in gbrain-evals. Add `test/eval/memory-qa-usage.test.ts`.

Recommendation: approve waves 0 to 2 with these amendments: decide the backlog-age column (findings 1 and 2) before wave 0's branch is cut, put wave 0's gbrain PR behind #6271 with D4 built on its notice ledger (finding 3), and fix A9's spend cap before wave 1 can approve it (finding 4). The plan's direction and gates are sound. What doesn't hold is the shipping mechanics, which conflict with the code as it stands at `7aa2caa0` and with the PRs queued ahead of it.
