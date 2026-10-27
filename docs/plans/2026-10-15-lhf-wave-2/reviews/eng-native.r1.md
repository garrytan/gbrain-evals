INPUT: eng 6fa9d38bfc024b00e8503e41313d327403736c9f865b87ef3dc5083abc1ba736

# Eng review (native voice): LHF wave 2, search latency and agent-visible result size

Reviewer: anthropic/claude-opus-5-5 (native), gstack plan-eng-review methodology (runner profile), unattended.
`gstack: ok 1.91.101.0 for=autoplan` (this machine, `scripts/install.sh --check --for autoplan`, exit 0).
Target: the implementation plan at the INPUT hash. Checkout: the shared gbrain checkout on `capy/lhf-wave-2`
(master `3c16e9ba` + item 0 `d5861ac6`), read-only. No provider spend. Two keyless probes, run in scratch
(local audit notes (not committed), `ts2.ts`, `vec.ts`, in-memory PGLite with pgvector), are quoted where used.
Persistence: this voice writes only this file. The QA test plan, task JSONL, TODOS, review log and learnings
are presented below as **not persisted**; the parent owns autoplan logging.

## Verdict

The direction is right and most items are real wins, but the plan as written has four engineering problems that
its gates won't catch. First, the lane split fails the coordinator's one-owner-per-file lane check: lanes A and B
both edit `ops/search.ts`, both engines and `hybrid.ts`, and item 5's fusion prefetch rewrites the same
`cosineReScore` read that item 3 replaces. Second, two items don't do what they claim. Item 4 saves about nothing
on PGLite as written, because the response still awaits the count on the same single connection; the −32 ms came
from stubbing the count out. Item 2's FTS prefilter drops saved facts in more ways than "ops in devops" (probed
below). Third, item 8b breaks the frozen v1 `context_pack` schema (`summary` and `open_threads` are required) and
the existing `budget_used ≤ budget` tests, and the v1 conformance case can't see it because it packs a
nonexistent entity. Fourth, four of the files the wave must grow are already at their module-size ratchet
ceilings, which nobody has budgeted for.

None of these needs a new direction for the wave. A file-ownership lane layout (below), an explicit choice for
item 4's skip rule, an honest classification of item 2, and an opt-in or schema-safe 8b fix them. Items 3, 6, 7
and 10 need edge-case and scope corrections that are cheap if they're written into the lane prompts now.

## Step 0: Scope Challenge

### A. Assess the target

**What already solves each sub-problem.**

- Item 1: `jitOffRead` exists but is private to the Postgres engine (`src/core/postgres-engine.ts:370-372`);
  `withSearchJitOff` takes a transaction handle (`src/core/postgres-engine/search-settings.ts:24-30`). The type
  probe runs through plain `ctx.engine.executeRaw` at the ops layer (`src/core/ops/search.ts:270-271`), so there's
  no ops-level JIT-off path today. `executeRaw` already carries per-call options (`timeoutMs`, `deadlineAt`,
  `src/core/postgres-engine.ts:2857-2860`), which is the natural place for a `jitOff` flag. **[Layer 1]**
- Item 2: the facts GIN index and its document builder exist (`src/core/fts-language.ts:119-128`), and the
  question-recall arm already uses it. `entitySavedFacts` (`src/core/search/entity-facts.ts:44`) already returns
  facts about a resolved entity on both `search` and `query` (`ops/search.ts:811,1220`), which partly offsets the
  prefilter's slug gap (F2).
- Item 3: `getEmbeddingsByChunkIds` holds the visibility filter and the column-name injection guard
  (`src/core/engine-sql/chunks.ts:966-992`); the new method should reuse both. **[Layer 1]**
- Item 5: `fusion-prefetch.ts` in #6734 is the right shape for the post-fusion reads too (start reads from one
  object, consume them at the old step, keep each stage's catch).
- Item 8: `createSafetyFor(evidence)` (`src/core/search/evidence.ts:102-113`) makes `create_safety` derivable;
  `resultRowsFor` and `fields: "full"` already exist (`src/core/search/lean-rows.ts:50-54`).
- Item 10: the measured-default pattern exists for facts extraction (`src/core/facts/extract.ts:65-91`), but
  expansion resolves at gateway configure time across two config planes (`src/core/ai/gateway.ts:583-629`), not
  per call, so the pattern can't be copied verbatim (F14).

**Minimum changes.** Items 1 (EXISTS on the happy path, DISTINCT only on a miss, both JIT-off), 3, 6 and 7 are
small and independent of the payload contract. Item 4 is only worth shipping if it skips the count (F4). Item 8b
is the one item that could be deferred without blocking the wave's goal; its savings are real but it carries the
only frozen-protocol risk.

**Complexity check** [estimated from the plan plus #6734's file list, local audit notes (not committed)]:
about 40-45 changed source files (#6734's port alone touches about 25), one new module
(`search/hybrid/fusion-prefetch.ts`), two or three new engine methods or options (cosine read, JIT-off read,
possibly a type-existence read), and about 10 new or extended test files. That trips the B gate (8+ files).

**Search check.** One query run (web search), for the one new concurrency pattern (per-request config snapshot
in `AsyncLocalStorage` under Bun): Bun had an ALS context-loss bug for thenables returned from async functions,
fixed in its August 2026 WebKit bump (oven-sh/bun#34277, superseded by #34669). The snapshot's failure direction
is safe (a lost context reads config live, so it costs round trips but never serves stale data), and the
`--backend pgbouncer` round-trip counts will catch a lost win on CI's Bun. **[Layer 1]** for ALS; the
`Promise.all` read fan-out is standard practice with the pool-size caveat in F8. Other patterns: in-distribution
knowledge only.

**TODOS cross-reference.** `TODOS.md:22` (keyword count at scale) sets a two-part gate: unavailable rate under 1%
**and** added p50 under 100 ms on a 55k calibration slot. The plan keeps only the first half and measures it on a
400-page bench (F4). `TODOS.md:322`, `:400` and `:499` are the three bookkeeping items in item 11.

**Completeness check.** The test plan names parity tests for items 2, 3 and 6 but has no regression coverage for
the v1 context_pack schema, the keyword trailer's states, Postgres plans for the shared walk statement, or pool-2
concurrency. Those are cheap with AI and are listed in Section 3.

**Distribution check.** No new artifact, binary or package. Generated trees (plugin variants, `llms-full.txt`,
`operation-manifest.generated.ts`) must be regenerated once by the integrator (item 0 already touched them,
`git show --stat d5861ac6`).

### Premise table (REALITY: premise-table)

| # | Premise | Claim | Receipt | Verdict |
|---|---|---|---|---|
| P1 | Item 1 | DISTINCT type probe is JIT-compiled, ~500 ms per typed search on PG with jit on | `ops/search.ts:270-271` (plain `executeRaw`); `latency.md:57-61` | TRUE (measured by audit) |
| P2 | Item 1 | EXISTS gives "the same keep/missing decision and notice" | notice lists all types from the DISTINCT set, `ops/search.ts:284-287` | FALSE for the notice |
| P3 | Item 2 | GIN facts index exists | `fts-language.ts:126-128` | TRUE |
| P4 | Item 2 | The only semantic change is a term inside a word | probe: `people/alice` path lexeme, `alice@acme-example.com` email lexeme, stopword-only tsquery `""` | FALSE |
| P5 | Item 2/5 | #6734's v246 collides with master | `src/core/schema-migrations/v246-page-embedding-budget.ts` exists | TRUE |
| P6 | Item 3 | Cosine read ships full vectors; PGLite −20 to −35 ms | `chunks.ts:979-983`; `latency.md:191-196` | TRUE (measured) |
| P7 | Item 4 | −32 ms at 10k by starting the count after the search | `latency.md:216-217` measured with the count **stubbed out**; response awaits it, `ops/search.ts:812` | MISATTRIBUTED |
| P8 | Item 5 | 30 ms RTT search 1,550 → under 500 ms | 735 ms measured with #6734 on a 250-commit-behind tree (`latency.md:125-129`) minus an estimated −240 ms (`latency.md:178`) | ESTIMATED |
| P9 | Item 6 | `buildIndexOnline` used by 10 migrations | 10 files under `src/core/schema-migrations/` import it (grep) | TRUE |
| P10 | Item 7 | A PGLite federated walk change | one `indexWalkSql` serves both engines: `postgres-engine.ts:1437`, `pglite-engine.ts:1720` | FALSE (both engines) |
| P11 | Item 8a | The `[gbrain search]` trailer states the defaults once | returns null without `keyword_total`, `keyword-paging.ts:247`; `query` never sets it | FALSE on `query` |
| P12 | Item 8b | Cards can drop duplicated prose and stay v1 | `verbs.ts:822` requires `summary`, `open_threads` | FALSE |
| P13 | Item 10 | Copy the measured-default pattern of `extract.ts:65-91` | pattern TRUE; expansion resolves in `gateway.ts:583-629` across two planes | PARTIAL |
| P14 | Item 10 | Asking for 2 rewrites changes the rewrite count | output already capped at 2, `expansion.ts:51-52`, prompt asks 3-4, `ai/expansion-prompt.ts:8` | PARTIAL (cuts output tokens only) |
| P15 | Item 0 | 300 questions, strict recall@10 298 vs 299 | gbrain-evals `2026-10-14-expansion-latency/results/verdict.json` (A1 r10 299, B 298, A2 298) | TRUE |
| P16 | Item 11 | Title arm already JIT-off (#6039) | `search-settings.ts:24-30`; `latency.md:253-256` | TRUE |
| P17 | Item 11 | Nightly 20k MCP search 36.3 ms, 10k 68.4 ms | `latency.md:257-261` cites run 38708604843; not re-fetched | UNVERIFIED |
| P18 | Item 0 | `query` p50 2,022 → 227 ms | commit message `d5861ac6`; not found in the evals checkout's markdown | UNVERIFIED |

unverified=2

### Reality rows

```
REALITY: premise-table finding 18 premises, 5 false or misattributed (P2 P4 P7 P10 P11/P12), 2 unverified src/core/ops/search.ts:284
REALITY: already-done pass master moved 3c16e9ba->56bc4e93 (v0.60.251.0) with no change to any named search file; only behavior-change-notice.ts overlaps; no open PR overlaps besides #6734 src/core/behavior-change-notice.ts:1
REALITY: surface-check pass bench flags --backend pgbouncer and --phases exist; ci:ubicloud:diff, gstack-lane-check, gstack-pregate exist scripts/bench-refactor-wave-1.ts:644
REALITY: binding-decisions pass no branch decisions recorded (gstack-decision-search empty); item 0 approval by Garry is respected; no overruled default reintroduced src/core/search/mode.ts:473
REALITY: numbers finding item 4 -32 ms measured with the count stubbed out (docs/plans/2026-10-15-lhf-wave-2/audit/latency.md:216); item 5 under-500 ms is 735 ms measured on the PR tree (docs/plans/2026-10-15-lhf-wave-2/audit/latency.md:126) minus -240 ms [estimated] (docs/plans/2026-10-15-lhf-wave-2/audit/latency.md:178); item 8a upper end unmeasured, -10.4% on one world (docs/plans/2026-10-15-lhf-wave-2/audit/cost.md:145)
REALITY: deferred-asks finding audit asks left out are listed in NOT in scope (docs/plans/2026-10-15-lhf-wave-2/audit/latency.md:34); two audit asks dropped without a reason: item 1 lazy DISTINCT (docs/plans/2026-10-15-lhf-wave-2/audit/latency.md:69) and item 6 backfill migration (docs/plans/2026-10-15-lhf-wave-2/audit/latency.md:244)
REALITY: pr-count pass one wave PR; ship-policy default pr_count 1; queue cost one slot .gstack/ship-policy.json:1
REALITY: transaction-semantics finding item 5 settings consolidation and item 1 JIT-off read touch SET LOCAL/savepoint restore; item 6 ANALYZE runs on a reserved connection that may be transaction-pooled; no crash-robot or pool-2 rerun named src/core/postgres-engine/search-settings.ts:24
REALITY: units pass no unit changes; KEYWORD_COUNT_GRACE_MS 250 and TIMEOUT 2000 unchanged if item 4 starts later src/core/search/keyword-paging.ts:42
REALITY: perf-table finding receipts are single-machine synthetic (4 vCPU, 256-word vocab), no base/branch interleave named, 400-page bench cannot exercise items 1 2 4 7 scripts/bench-refactor-wave-1.ts:466
REALITY: recall finding item 2 changes saved-fact recall (probe) and item 7 changes the walk on Postgres too; neither has a recall-vs-exact check across buckets src/core/fts-language.ts:119
REALITY: prior-art pass #6734 diverges intentionally (trigram v246, threshold-in-SQL, OR-retry dropped) and #6747 adopted; reasons stated in plan item 2/5 docs/plans/2026-10-15-lhf-wave-2/audit/latency.md:146
REALITY: contract-assumptions finding gbrain-evals harness defaults assumed (GBRA-94 rule, Cat 40 world M) not rechecked against merged harness code; v1 memory-verb schema assumption false (P12) src/core/verbs.ts:822
REALITY: dependency-fallback finding item 5 fusion prefetch depends on item 3's cosine method across lanes; no stated fallback if item 3 is reverted by its gate src/core/search/hybrid.ts:1595
REALITY: obligation-tiers finding every item is must-ship in one PR with no size budget or lateness rule; recommend 8b and item 4 as droppable tiers scripts/module-size-limits.tsv:1
REALITY: falsification-box n/a not an incident plan -
REALITY: stop-reasons n/a not an incident plan -
REALITY: reporter-environment n/a not an incident plan -
```

PLAN_REALITY: phase=eng rows=15/15 missing=none verdict=complete (`gstack-plan-reality check --phase eng --scope db,perf,search,dependency` on this file; the three incident-scope rows are n/a).

### B. Complexity selectors (gate tripped: about 40-45 files, 1 new module, 2-3 new engine methods)

Unattended run, so the questions are recorded, not asked.

- **Feature cuts.** No cut proposed by this voice beyond what Section findings already put to decisions (item 4's
  route, item 8b's default). Feature list kept.
- **Structure question (pending, D1).** `Original arrangement`: lanes A (items 1, 3, 4, 7), B (2, 5), C (8),
  D (6, 9, 10, 11), every lane free to edit shared stamp, guard and generated files. `Smaller arrangement`: the
  same items owned by file, not by theme: lane A owns the engines and `hybrid.ts` (3, 5b, 7, plus item 1's
  `executeRaw({ jitOff })`), lane B owns `ops/search.ts` and `keyword-paging.ts` (1's call site, 2, 4, 5c), lane C
  owns dispatch and config (5a), lane D owns the payload (8, trailer edit after B), lane E the small items
  (6, 9, 10, 11), and the integrator alone owns `behavior-change-notice.ts`, `CHANGELOG.md`,
  `scripts/module-size-limits.tsv`, `scripts/engine-sql-baseline.tsv`, goldens and generated trees. Both keep the
  same feature list and contracts. **Recommended: Smaller arrangement**, because the original fails
  `gstack-lane-check` (F1). Pending remedies not decided here: F2-F18.
- Scope record (not persisted): `feature answers: none asked (unattended); structure: pending D1 (recommend B);
  accepted scope: plan items 1-11 as written; pending remedies: F1-F18`.

### C. Findings from the Scope Challenge

1. **F1 (High, confidence 9/10, source: code + contract).** Lane split fails the one-owner lane check. Details in
   Section 1.
2. **F12 (Medium, 9/10, source: `scripts/module-size-limits.tsv`).** Four touched files are at their ratchet
   ceilings. Details in Section 2.
3. **F4 (High, 8/10, source: code + audit).** Item 4's saving is misattributed. Details in Section 4.

Dispositions: all pending (unattended); Scope Challenge result: **scope accepted as-is** (no reduction applied;
D1 is an arrangement, not a reduction).

## 1. Architecture review

### Request-path diagram with item placement

```
MCP dispatch (src/mcp/dispatch.ts) ──[5a: per-request config snapshot, read ops only]──┐
CLI op dispatch ──────────────────────[5a: widened; see F9]────────────────────────────┤
                                                                                         ▼
search/query handler (src/core/ops/search.ts)
  setup: snippetCap, scope, assertSourceLive, excludePrivate
         reconcileTypeFilter ............................. [1] EXISTS per expanded type; DISTINCT only on miss; JIT-off
  startKeywordCount ──────────────────────────────┐ ....... [4] PGLite: same single connection as everything below
  hybridSearchCached (src/core/search/hybrid.ts)  │
     arms: keyword (+keywordOrFallback) | title | vector (index walk [7], settings stmt [5b])
     fuse: unverified marks, cosineReScore ........ [3] SQL cosine   <── [5b] fusion prefetch (cosines, not vectors)
     runPostFusionStages: backlinks(jitOffRead) → salience → recency → title → graph → alias → supersede
                         ........................... [5b] reads started together, applied in this order
  alias_fanout, anchoring                          │
  evidenceOutput → projectRows/leanRow ........... [8a] elide defaulted fields
     buildRetrievalResponseMeta: unsealed probe, readiness, entitySavedFacts,
         matchingSavedFacts [2], stampHeldHits ... [5c] Promise.all
     await keywordCount ◄──────────────────────────┘ → keywordCountMeta → searchCountLine trailer [8a]
  mcp_request_log insert ......................... [5a] non-blocking
context_pack (src/core/ops/facts.ts:847-880) ..... [8b] drop card prose; budget_used redefined
expansion (src/core/ai/gateway.ts) ............... [10] measured default → also getImageOcrModel fallback
```

### Findings

**F1 (High, 9/10). The lane split fails `gstack-lane-check` and hides a cross-lane code dependency.**
The contract requires `clear` for each lane's planned files against every other lane, and the tool's own
description is "one owner per file". As planned:

- `src/core/ops/search.ts`: item 1 (`reconcileTypeFilter`, `:264`) and item 4 (count start, `:775`) in lane A;
  items 2 (`matchingSavedFacts`, `:383`) and 5 (response meta `:449`, entity resolve) in lane B.
- `src/core/search/hybrid.ts`: item 3 rewrites `cosineReScore`'s read (`:1595`) in lane A; item 5's fusion prefetch
  replaces that same read with a prefetched map and the post-fusion change rewrites `:537-682` in lane B.
- Both engines and `engine.ts`: item 3's new method (A), item 1's JIT-off read (A), item 5's settings consolidation
  (B).
- `src/core/search/vector-statement.ts`: item 7 (A) and #6734's own edits to it (B, file list in the PR diff).
- `src/core/search/keyword-paging.ts`: item 4's count (A) and item 8a's trailer (`searchCountLine`, `:229-252`)
  (C).
- `src/core/behavior-change-notice.ts`, `CHANGELOG.md`, generated plugin/llms trees, `docs/architecture/key-files/*`,
  `scripts/module-size-limits.tsv`, `scripts/engine-sql-baseline.tsv`, `test/fixtures/goldens/exports/types.json`:
  several lanes each.

The dependency: item 5's prefetch of cosines can't be written until item 3's method exists, and if item 3's gate
reverts it, item 5's prefetch has to fall back to vectors. Fix: adopt the file-ownership layout in the
Worktree section, with the integrator owning every shared stamp, guard, golden and generated file, and state
item 5b's fallback (prefetch `getEmbeddingsByChunkIds` exactly as #6734 does) if item 3 doesn't ship.

**F7 (Medium, 8/10). Item 7 changes the Postgres walk too.** `buildVectorSearchStatement` produces one
`indexWalkSql` that Postgres runs (`src/core/postgres-engine.ts:1437`) and PGLite runs
(`src/core/pglite-engine.ts:1720`). #6747's LATERAL `OFFSET 0` probes change the Postgres plan for every federated
or narrowed walk, but the plan names only a PGLite receipt and keeps only #6747's PGLite plan test. The change is
probably good on Postgres too (it bounds the plan by the window), but it is unmeasured there. Fix: add a Postgres
E2E plan test (same assertions: no Materialize, PK probes with loops > 1, no `idx_chunks_page`) and a two-source
Postgres timing row in the bench report; list it under `## Behavior changes` as a Postgres plan change.

**F9 (Medium, 7/10). Item 5's snapshot and log changes need tighter boundaries.**
#6734 gates the snapshot on `operations.find(o => o.name === name)?.mutating === false` (PR diff,
`src/mcp/dispatch.ts`). For MCP that's one request. Widened to CLI operation dispatch, a long-running read op
holds one snapshot for its whole run, so a `gbrain config set` kill switch from another process is ignored until
it ends. The non-blocking `mcp_request_log` insert has a shutdown settle in the PR, but no bound: when the
database is slow, pending inserts accumulate in memory, and the table feeds the admin dashboard and per-client
usage counts (`src/commands/serve-http-admin-api.ts:81-90,260-273`). Fix: apply the CLI snapshot only to an
allowlist of short read ops (search, query, get_page, list), or leave CLI out of this wave; give the request log a
bounded queue with a drop counter that doctor reports; add a test that a config write from a second connection is
seen by the next request and is not seen mid-request.

**F14 (Medium, 8/10). Item 10 must resolve the measured default where expansion actually resolves.**
Facts extraction resolves per call (`extract.ts:76-91`). Expansion resolves once in
`reconfigureGatewayWithEngine` across the DB plane (`resolveModelDetailed`, `gateway.ts:587-591`) and then the
file plane (`resolveEffectiveExpansionModel`, `:617-619`), and the comment at `:599-603` warns that a boot fold
makes a pinned value and a fabricated default indistinguishable in `cfg`. Putting the measured default in the
wrong layer either overrides an init-era `expansion_model` pin or leaves `gbrain models` showing Haiku 4.5. And
`getImageOcrModel` falls back to the expansion model (`gateway.ts:880-881`), so item 10 moves OCR to Haiku 5.5 for
every install without `embedding_image_ocr_model`, even with expansion off after item 0 (both prior voices
confirmed this). Fix: apply the measured default inside `resolveEffectiveExpansionModel` after both planes report
`tier_default`/`fallback`, so the gateway and `gbrain models` share it; pin OCR's fallback to the previous default
or ship the OCR change with its own BEHAVIOR_CHANGES row; tests: a file-plane pin survives, `gbrain models`
reports `measured_default`, OCR model unchanged (or changed and noticed).

Security: no new auth surface. The cosine method must keep `COLUMN_NAME_REGEX` and `quoteIdentifier`
(`chunks.ts:974-981`), and item 2's tsquery must be built from the same `[\p{L}\p{N}'-]` terms (probe: no syntax
errors from `'`, `-` or trailing punctuation, so injection isn't a concern, but phrase operators appear). The
snapshot is per engine object and per ALS context, so concurrent requests and other brains don't share it.

Dispositions: F1 pending D1; F7, F9, F14 pending.

## 2. Code quality review

**F12 (Medium, 9/10). Files the wave must grow are at their ratchet ceilings.** `scripts/module-size-limits.tsv`:
`src/core/search/hybrid.ts` 1648/1648, `src/core/postgres-engine.ts` 3060/3060, `src/core/pglite-engine.ts`
3043/3043, `src/core/ai/gateway.ts` 4523/4523. Unlisted files cap at 1500 (`scripts/check-module-size.sh:36`):
`src/core/ops/search.ts` is at 1431 and `src/core/ops/facts.ts` at 1479. Items 1, 2, 3, 4, 5, 8 and 10 all add
lines to these. Each lane will either raise a ceiling (a reviewer-visible act the guard expects to be justified)
or peel code, and two lanes raising the same row conflict. Fix: plan the peels now. Move `matchingSavedFacts` and
`reconcileTypeFilter` out of `ops/search.ts` into `search/saved-facts.ts` and `search/type-filter.ts` (both are
self-contained); put the cosine SQL in `engine-sql/chunks.ts` beside `getEmbeddingsByChunkIds` with one-line
engine delegates; put the post-fusion read prefetch in `search/hybrid/` next to `fusion-prefetch.ts`; put the
expansion measured default in the model-resolution module, not `gateway.ts`. The integrator owns the TSV.

**F5 (Medium, 8/10). Item 1 needs an ops-level JIT-off read and the lazy DISTINCT the audit specified.**
The notice's "Page types in this brain" list (`ops/search.ts:284-287`) can only come from the full DISTINCT set.
The audit's fix ran DISTINCT only when a type is missing (`latency.md:69-70`); the plan dropped that half. The miss
path is not rare: `reconcileTypeFilter` exists because agents guess types (Cat 40, `ops/search.ts:257-262`), so
the miss-path DISTINCT still JIT-compiles for about 500 ms unless it also runs JIT-off. "Inside the existing
jit-off search settings" has no API at the ops layer. Fix: add `jitOff?: boolean` to `executeRaw`'s options
(Postgres routes through `jitOffRead`, PGLite ignores it), run one EXISTS per requested type over that type's
**expanded** set (`expandEngineTypeFilters`, `:280`; a schema-pack alias must count), and run DISTINCT only on a
miss, both with `jitOff`. Shared-code rubric: one verified caller today (`reconcileTypeFilter`), a second proposed
(the miss-path DISTINCT); the option is small, mirrors `timeoutMs`, and needs a contract test on both engines.
Estimated +15 to +25 implementation lines, net growth; no extraction beyond the option.

**F6 (Medium, 8/10). Item 3's SQL cosine has edge semantics the JS path handles and SQL doesn't.**
Probe (`vec.ts`, PGLite + pgvector): a zero vector gives `1 - ('[0,0,0]' <=> '[1,0,0]')` = NaN (driver shows
null); a NULL embedding gives NULL; a dimension mismatch is a statement **error** ("different vector dimensions
2 and 3"). JS returns 0 for a zero norm and for a length mismatch per row (`hybrid.ts:1636-1647`). In SQL, the
error aborts the whole read, `cosineReScore`'s catch returns every row unrescored (`:1599-1602`), and a NaN that
reaches `blended` breaks the sort comparator (`:1633`). Fix: return `CASE WHEN x IS NULL OR x = 'NaN' THEN NULL
ELSE x END` and treat NULL as "not hydrated" (cosine 0, the #3695 rule), keep `currentTextProjectionFilter` and
the halfvec `::vector` cast (probe: identical values), and extend the parity test to zero, NULL and halfvec rows on
both engines.

**F15 (Low, 8/10). Item 10's "2 rewrites" doesn't change search fan-out.** `sanitizeExpansionOutput` already keeps
at most 2 rewrites (`src/core/search/expansion.ts:51-52`; `MAX_QUERIES = 3`), while the prompt asks for 3-4
(`src/core/ai/expansion-prompt.ts:8`). Asking for 2 cuts output tokens and changes which rewrites survive; it also
removes the slack that absorbs a rewrite equal to the original, because the original is deduped after the cap
(`expansion.ts:76-79`). Fix: say this in the item; dedupe against the original inside `sanitizeExpansionOutput`
before the cap; report the share of calls with fewer than 2 surviving rewrites in the GBRA-94 rerun. The eval
cost planner reuses the prompt (`src/eval/longmemeval/call-plan.ts:290`), so its token estimates move too.

**F16 (Low, 9/10). Item 9's two changes need tests that can fail.** 9b can't fire on a quoted anchor: the planner
refuses any `"` at `relational-plan.ts:211`, before the year rule at `:215`. 9a's "joined" is employment wording
that `works_at` users type ("who joined Acme"). Fix: 9b's test uses an unquoted resolvable title with a year
token plus a quoted one (decide whether quotes are in scope); 9a adds negative tests for "joined <company>" and
"was at <company>" routing to `works_at`, not `attended`.

Dispositions: F5, F6, F12, F15, F16 pending.

## 3. Test review

Framework: Bun test (`bun test`), E2E against Postgres (`bun run test:e2e`), Ubicloud gate. Existing coverage
found: `test/search-type-filter-reconcile.test.ts`, `test/search-saved-facts.test.ts`,
`test/cosine-rescore-chunkless-headstart.test.ts`, `test/search-keyword-paging.test.ts`,
`test/e2e/search-keyword-paging-parity.test.ts`, `test/search/vector-index-walk.test.ts`,
`test/search-lean-rows.test.ts`, `test/ambient-recall.test.ts`, `test/context-pack-newer-mentions.test.ts`,
`test/relational-plan.test.ts`, `test/facts-extraction-model-default.test.ts`, `test/ai/ocr-model-routing.test.ts`,
`test/e2e/jit-off-reads-postgres.test.ts`, `test/fixtures/memory-verbs/cases.json`.

**F3 (High, 9/10). Item 8b breaks the frozen v1 contract and existing invariant tests, and the conformance gate
can't see it.** The v1 output schema requires `cards[].summary` and `cards[].open_threads`
(`src/core/verbs.ts:822`). `MEMORY_VERBS_v1.md:866-867` defines `budget_used` as tokens of `text`, and the
packer prices rendered lines so `text` fits. Existing tests assert `budget_used ≤ budget`
(`test/ambient-recall.test.ts:740,754,891`, `test/context-pack-newer-mentions.test.ts:136`). If `budget_used`
measures the serialized result while packing still prices `text`, those tests fail, and loosening them is not
allowed. If packing follows the serialized size, `text` shrinks at the same `budget_tokens`. The only
`context_pack` conformance case with `validateSchema` packs `conformance-nonexistent-…` (empty `cards`), so a
schema break passes. Fix: keep the v1 shape; offer compaction as an explicit opt-in (`fields: "lean"`, or a new
optional param) or under a protocol bump; leave `budget_used` meaning tokens of `text` and add a separate
`result_chars` if needed; add a conformance case with a real entity and `validateSchema: true`. CRITICAL
regression requirement under the iron rule.

**F13 (Medium, 9/10). The digest and bench gates can't see most items.** Confirmed in code: the digest hashes
`score` (`scripts/bench-refactor-wave-1.ts:474`), runs `remote: false` (`:466`), uses no `types`, no facts, one
source, and hashes rows only, not `_meta.retrieval` (so `saved_facts` and `type_filter_notice` are invisible).
Fix: order-only digest of `[source_id, slug, chunk_index]` plus a separate score tolerance; add a `remote: true`
pass (lean rows, saved facts, safe-index probe); typed queries including a missing type and a schema-pack alias;
seeded facts covering the F2 classes; two sources; a digest of `saved_facts` ids and `type_filter_notice`; commit
the 30 ms delay proxy (local audit notes (not committed) is scratch) as a bench helper.

**F11 (Medium, 8/10). Item 8a needs a machine-checkable recovery contract.** The trailer can't carry the
defaults on `query` (`searchCountLine` returns null without `keyword_total`, `keyword-paging.ts:247`; rendered at
`src/mcp/dispatch.ts:417`), and the defaults are brain-specific. Fix: put `row_defaults: { trust_tier, origin,
effective_date_source }` in `_meta.retrieval`, elide a field only when it equals that object, keep the prose line
as a rendering of it, keep `create_safety` unless `evidence → create_safety` is stated in the tool descriptions,
and add a property test: for every fixture row, `{ ...row_defaults, ...lean } ` equals `leanRow(full)` on every
elided key. The `[gbrain dates]` label (`date-labels.ts`) must read the default, not treat absence as unrecorded.

### Coverage diagram

```
CODE PATHS                                                   USER FLOWS
[+] ops/search.ts reconcileTypeFilter [1]                    [+] Agent typed search
  ├── [★★ TESTED] keep/drop/notice — search-type-filter-reconcile    ├── [GAP] [→E2E] typed search on PG jit=on: no JIT block, both statements
  ├── [GAP] schema-pack alias kept by EXISTS                          └── [GAP] miss path still lists types (notice parity)
  └── [GAP] [→E2E] JIT-off on both statements, 10k pages
[+] matchingSavedFacts [2]                                   [+] remember → next-session search
  ├── [★★ TESTED] same facts on #5932 fixtures — search-saved-facts   ├── [GAP] slug-only fact, name not a resolvable entity
  ├── [GAP] substring/slug-path/email/stopword-only classes           └── [GAP] fact older than the 200th LIKE candidate (direction change)
  ├── [GAP] LIKE fallback when idx_facts_fts missing or other language
  └── [GAP] CJK terms stay on LIKE
[+] cosineReScore SQL [3]
  ├── [★★ TESTED] chunkless head start (#3695)
  ├── [GAP] parity 1e-6 incl. zero/NULL/halfvec, both engines
  └── [GAP] dimension mismatch does not drop rescoring for all rows
[+] keyword count on PGLite [4]                              [+] count line the agent reads
  ├── [★★ TESTED] unavailable/timeout meta — search-keyword-paging    ├── [GAP] skipped count renders as skipped, not "failed"
  ├── [GAP] derived total equals countKeywordPages (if derived)       └── [GAP] no wrong "Keyword matches: N" under OR fallback
  └── [GAP] 55k slot: unavailable <1% AND added p50 <100 ms
[+] item 5 snapshot / settings / prefetch / post-fusion / meta
  ├── [GAP] snapshot: read sees own setConfig; next request sees external write
  ├── [GAP] settings: one statement; nested restore; statement_timeout from deadline (#6543)
  ├── [GAP] post-fusion: same scores/order as serial on fixture (all stages on)
  ├── [GAP] [→E2E] pool size 2, 8 concurrent searches, delay proxy: no timeout, p95 ≤ master
  └── [GAP] request log bounded; settles on shutdown
[+] buildIndexOnline ANALYZE [6]
  ├── [★ TESTED] index build paths — persistence-request-indexes-postgres
  ├── [GAP] pg_stats rows under the index name after build (PGLite + PG)
  ├── [GAP] pre-existing index ('present') self-heals via staleness check
  └── [GAP] ANALYZE failure does not fail the migration
[+] vector walk key probes [7]
  ├── [★★ TESTED] PGLite plan — vector-index-walk (from #6747)
  └── [GAP] [→E2E] Postgres plan assertions
[+] lean rows / context_pack [8]                             [+] session-start context_pack
  ├── [★★ TESTED] lean projection — search-lean-rows                  ├── [GAP] v1 schema with a real entity (conformance)
  ├── [GAP] lean + row_defaults ≡ full                                └── [GAP] budget_used ≤ budget unchanged
  └── [GAP] [gbrain dates] label with elided source
[+] relational [9]
  ├── [★★ TESTED] planner refusals — relational-plan
  └── [GAP] quoted vs unquoted anchor with year; "joined <company>" negative
[+] expansion default [10]
  ├── [★★ TESTED] measured default pattern (facts) — facts-extraction-model-default
  ├── [GAP] file-plane pin survives; gbrain models agrees
  └── [GAP] OCR model unchanged or noticed — ocr-model-routing extended

LLM integration: [GAP] [→EVAL] item 10 prompt change — GBRA-94 harness rerun (300 q, Haiku 5.5); item 9 lexicon — relational paraphrase + template splits; item 8 — Cat 40 dev smoke

COVERAGE: 10/43 paths tested (23%)  |  Code paths: 9/33  |  User flows: 1/10
QUALITY: ★★★:0 ★★:8 ★:1  |  GAPS: 33 (5 E2E, 3 eval)
```

Legend: ★★★ behavior + edge + error | ★★ happy path | ★ smoke check | [→E2E] integration test | [→EVAL] LLM eval.

### Test plan (QA artifact, not persisted)

```markdown
# Test Plan
Generated by /plan-eng-review on 2026-10-15
Branch: capy/lhf-wave-2
Repo: garrytan/gbrain

## Affected Pages/Routes
- MCP `search` / `query` — rows, `_meta.retrieval`, trailer lines (lean rows, saved facts, type notice, count line)
- MCP `context_pack` — v1 schema, `text`, `budget_used`
- CLI `gbrain search` / `gbrain query` against remote Postgres — config snapshot, round trips
- `gbrain apply-migrations` / upgrade — ANALYZE after index builds
- `gbrain models` — expansion and OCR model rows

## Key Interactions to Verify
- Typed search with a guessed type on Postgres (jit=on): notice lists real types, no JIT block
- `remember` a fact with only an entity slug, then search the person's first name
- Concurrent searches at GBRAIN_POOL_SIZE=2 through a 30 ms delay proxy
- context_pack for a real entity with budget_tokens set

## Edge Cases
- Saved-fact query whose only matching term sits in an email, URL, slug path or inside a word
  Value: protects=saved-fact recall; fails_when=FTS prefilter drops the fact; why_new=no fixture covers token classes; seam=none; no_claim=CJK
- Zero-norm / NULL / halfvec embeddings in cosine rescoring
  Value: protects=ranking order; fails_when=NaN reaches the sort; why_new=SQL path new; seam=none; no_claim=image space
- Hybrid search under keywordOrFallback with a derived keyword count
  Value: protects=count truthfulness; fails_when=derived total ≠ strict count; why_new=new skip rule; seam=none; no_claim=keyword mode
- Index already present before the upgrade
  Value: protects=55k entity-names latency; fails_when=stats never collected; why_new=present path untested; seam=none; no_claim=Postgres autovacuum

## Critical Paths
- context_pack v1 conformance with a real entity and validateSchema
  Value: protects=frozen v1 schema; fails_when=cards drop summary/open_threads; why_new=existing case packs nothing; seam=none; no_claim=text content
- Bench order digests (order-only) equal to master on PGLite and Postgres with remote:true, types, facts, two sources
  Value: protects=no retrieval change for items 1,3,4,5,7; fails_when=any order moves; why_new=current digest blind to these; seam=none; no_claim=float scores

## Tests to Retire
- none

## Pending Decisions
- D2 item 2 approach decides whether the F2 classes are "expected differences" or failures
- D3 item 8b decides whether the v1 conformance case is a gate or documents a protocol bump
- D4 item 4 route decides between the skipped-state test and the derived-count equivalence test
```

Eval scope (LLM/prompt patterns): item 10 changes `src/core/ai/expansion-prompt.ts` (prompt template) and the
expansion model; the GBRA-94 harness rerun on the same 300 questions is the eval, with baseline A1/B from
`verdict.json` (A1 299, B 298, `C-haiku-5-5` 298 at the current prompt). Item 9 needs the relational paraphrase and
template splits. Item 8's Cat 40 smoke is underpowered at its stated rule (CEO phase); this voice adds nothing to
that.

Dispositions: F3, F11, F13 pending.

## 4. Performance review

**F4 (High, 8/10). Item 4 as written saves about 0 ms on PGLite, and its skip rule is where all the saving and all
the risk live.** The search op awaits the count before it returns (`ops/search.ts:811-812`), and PGLite runs every
statement on one connection, so starting the 80 ms count after the hybrid search moves it later on the critical
path without removing it. The audit's −32 ms came from stubbing the count out (`latency.md:216-217`). The saving
exists only when the count is skipped. "Only when the keyword arm needs it" means deriving the total from the
hybrid keyword arm, and that arm differs from the strict count whenever `keywordOrFallback` fires (on in two mode
bundles, `src/core/search/mode.ts:473,535`; threaded at `hybrid/request.ts:287`), and under the arm's own limit,
`pageRankCut`, time scope and alias handling. A wrong derivation prints a wrong "Keyword matches: N pages" that
agents act on. The plan also keeps only half of the TODOS gate (`TODOS.md:22`: under 1% unavailable **and** under
100 ms added p50 on a 55k slot). Fix (decision D4): either (a) skip the count on PGLite above a page threshold,
report a distinct `keyword_count_skipped` state, and render it as skipped rather than "failed; not a count of
zero" (`keyword-paging.ts:243`), or (b) derive the total only when the arm ran strict, unnarrowed and returned
fewer rows than its limit, with an equivalence test against `countKeywordPages`. Measure on the 10k audit brain
and the 55k slot with the full TODOS gate. Recommend (a): simpler, honest, and it is the route TODOS already names.

**F2 (High, 8/10). Item 2's prefilter changes which saved facts surface, so it isn't a pure-performance item.**
Probes (`ts.ts`, `ts2.ts`, English config, PGLite):

- Entity slugs: `factsFtsDocument` replaces `-` but not `/`, so `people/alice-example` indexes as the path lexeme
  `'people/alice'` plus `'exampl'`. `to_tsvector('Prefers email over Slack people/alice example') @@
  to_tsquery('alice:*')` is **false**. Today's LIKE on the raw slug matches. `entitySavedFacts` covers this only
  when the name resolves to an entity page (`entity-facts.ts:44-49`), which a `remember`-only entity may not have.
- Emails, URLs and hosts are single lexemes (`'alice@acme-example.com'`, `'acme.com/pricing'`), so "acme" no
  longer finds them.
- A query whose terms are all English stopwords the JS list misses gives an empty tsquery (`'very:* | only:*'`
  → `""`), which matches nothing.
- The other direction: the prefilter shrinks the candidate set before `ORDER BY valid_from DESC LIMIT 200`
  (`ops/search.ts:415-416`), so facts older than today's 200th LIKE candidate can now surface. That's the same
  behavior change #6734 measured (36/116 → 116/116, `latency.md:146-148`).
- Prefix stemming broadens matches ("running" → `run:*`); the unchanged JS rule filters those, so that one is safe.

The latency claim is a PGLite microbench of the bare predicate (`evals-findings.md:55-57`); there's no Postgres or
real-brain number. And if the index was built under another FTS language, the literal regconfig won't match it, so
the prefilter computes `to_tsvector` per row and is slower than LIKE. Fix (decision D2, user challenge):
reclassify item 2 as a behavior change with a quality gate, or measure the write cost of an exact-preserving
trigram index on a 100k-fact brain before rejecting it (its only stated cost). If FTS stays: fall back to LIKE
when the index for the **current** language isn't valid (`pg_index` check, cached per engine), for CJK terms and
for an empty tsquery; add the token-class fixture; document the slug and email classes as accepted differences.

**F8 (Medium, 7/10). The post-fusion `Promise.all` is a refactor, and the read fan-out needs a pool-2 check.**
Four of the post-fusion reads live inside apply functions with their own gating and failure contracts:
`applyGraphSignals` (`graph-signals.ts:336-351`, failure writer, `onMeta` duration), `applyAliasResolvedBoost`
(`hybrid.ts:810`), `applySupersedeDownrank` (`hybrid.ts:747`, TTL-memoized edge probe), and backlinks inside a
4-statement `jitOffRead` transaction. Starting them together means splitting each into read and apply halves
while keeping order and each catch, in a file with zero ceiling headroom (F12). The math is order-safe (boosts
don't re-sort; `computeFloorThreshold` runs once at entry, `hybrid.ts:560`; graph signals' top-K is the entry
order). With 5 concurrent response-meta reads and up to 7 post-fusion reads, one search can ask for many
connections, and doctor tells Supavisor users to set `GBRAIN_POOL_SIZE=2`
(`src/commands/doctor/checks/consolidation-cycle.ts:115`). Scale: unknown under concurrency; not measured.
Fix: one prefetch object per stage group (the `fusion-prefetch.ts` pattern), an E2E at pool size 2 with 8
concurrent searches through the delay proxy (no timeout, p95 not worse than master), and a small concurrency cap
if p95 regresses.

**F10 (Medium, 8/10). Item 6 misses brains that already have the index, and its failure path is unspecified.**
`buildIndexOnline` returns `'present'` before any work on both engines (`helpers.ts:94-97,105`), so the 55k brain
behind the TODOS entry, which already ran v240, never gets ANALYZE. F4b's `has_stats` checks
`pg_stats.tablename = <table>` (`planner-stats.ts:112`), but expression-index statistics are stored under the
index's name, so a table with column stats looks fresh. On Postgres, ANALYZE takes a ShareUpdateExclusive lock and
can hit the session timeouts the reserved connection inherits. ANALYZE samples about 30k rows, so its cost is
bounded by the sample, not the table. Fix: run ANALYZE best-effort after `created`/`rebuilt` (catch, print a
notice, never fail a migration whose index is valid); teach the staleness check (PGLite F4b and the Postgres
doctor/repair variant) to flag an expression index with no `pg_stats` row under its own name, so present brains
self-heal on the next planner read; test on a fixture where the index existed before the upgrade.

**F17 (Low, 7/10). Item 5's "under 500 ms" is an estimate across two trees.** 735 ms was measured with #6734 on
its own database, 250 commits behind master; the −240 ms post-fusion figure is estimated (`latency.md:125-129,178`).
Fix: label it `[estimated]` in the plan and re-measure on the integrated tree with the committed delay proxy,
interleaving base and branch runs.

Memory and caching: the per-request snapshot reads the whole config table once per read request; the table is a
handful of rows (`config-snapshot.ts:15`), so this is a win. The cosine read cuts about 400 KB of wire per Postgres
search (`latency.md:204`). No unbounded caches added, apart from F9's log queue.

Dispositions: F2 pending D2 (user challenge), F4 pending D4, F8, F10, F17 pending.

## Outside voice

Not run by this voice; the parent's dual-voice runner owns the outside review and reconciliation.

## Cross-item interactions the plan doesn't state

- Items 3 and 5: the prefetch should read cosines (item 3) or fall back to vectors if item 3 is reverted (F1).
- Items 4 and 8a: if item 4 skips counts, the trailer that 8a relies on disappears on more calls (F4, F11).
- Items 2 and 5: #6734 removed the "any active fact?" probe because its trigram index made it redundant; with an FTS
  prefilter and a LIKE fallback, the probe still saves a scan on fact-free brains, so keep it or measure.
- Items 0 and 10: with expansion off by default, item 10's widest effect is the OCR fallback (F14).
- Items 1 and 5: `expandEngineTypeFilters` runs once per requested type; under the snapshot its config reads are
  free, without it (CLI, pre-5) each is a round trip.

## NOT in scope

- Type-filtered vector search through the index walk: needs stats-sized overfetch and a recall check; its own plan
  after item 1.
- `TIER_DEFAULTS` and utility-tier callers on the 5.5 generation (TODO-D): needs per-consumer quality evals.
- A size budget for the `full` tool surface: its own DX plan.
- Family E ranking, mention links on write, H1 aggregation, proactive brief gaps, scoped HNSW recall: unrelated to
  this wave's latency and size goals.
- Chat-key-only `tokenmax` without a reranker: needs a current measurement.
- Query-embedding in-flight dedupe and the PGLite timeline `stale` subquery: minor, filed as TODOs.
- #6771 code-metadata repair: different subsystem.
- This voice adds: Postgres two-source walk benchmarking beyond one receipt (F7) and a general read-concurrency
  limiter (F8) unless the pool-2 test regresses.

## What already exists

- `_meta.retrieval.timings` and `--explain` (#6601); bench `scripts/bench-refactor-wave-1.ts` with
  `--backend pgbouncer` round-trip counts (reuse; extend per F13).
- `withSearchJitOff` / `jitOffRead` (reuse through an `executeRaw` option, F5).
- Facts FTS index and `factsFtsDocument` (reuse with the F2 fallbacks); `cjk-keyword-sql.ts` for CJK.
- `vector-statement.ts` and `test/search/vector-index-walk.test.ts` (reuse; add Postgres, F7).
- `lean-rows.ts`, `createSafetyFor` (reuse; add `row_defaults`, F11).
- `fusion-prefetch.ts` from #6734 (reuse its pattern for post-fusion reads, F8).
- `FACTS_EXTRACTION_MEASURED_DEFAULTS` (reuse the idea; resolve in `resolveEffectiveExpansionModel`, F14).
- gbrain-evals GBRA-94 harness and verdict, Cat 40 runner, relational paraphrase runner (reuse as gates).

## Failure modes

| Path | Realistic production failure | Test / handling | User sees |
|---|---|---|---|
| [1] type probe | Agent guesses a type; miss-path DISTINCT JIT-compiles for 500 ms | none planned / none | slow, silent |
| [2] saved-fact prefilter | Fact keyed only by entity slug or containing an email isn't surfaced | none planned / none | **silent miss (critical gap)** |
| [2] fallback | `idx_facts_fts` built under another language; prefilter seq-scans with per-row `to_tsvector` | none / none | slower, silent |
| [3] SQL cosine | Zero-norm legacy embedding gives NaN; order corrupts | none / catch only for errors | silent wrong order |
| [4] count skip | Derived count under OR fallback shows a wrong total | none / none | **silent wrong count (critical gap if derived)** |
| [5a] snapshot (CLI) | Long read op ignores a config kill switch set mid-run | none / none | silent |
| [5a] request log | DB slow; pending inserts grow memory | settle on shutdown only | eventual OOM / lost rows |
| [5b] post-fusion fan-out | Pool 2 + concurrent searches queue; p95 rises or reads time out | per-stage catch (fail-open) | slower; boosts silently skipped |
| [6] ANALYZE | Lock or timeout after the index built; migration fails and repeats | none / none | upgrade error |
| [7] walk on Postgres | Plan regression on a federated Postgres brain | PGLite plan test only | slower |
| [8a] lean rows | Agent reads missing `effective_date_source` as unrecorded | none / none | wrong date reasoning |
| [8b] context_pack | Harness reads `cards[i].summary`, gets undefined | conformance case blind | broken integration |
| [10] expansion/OCR | OCR silently moves to Haiku 5.5 | none / none | silent model change |

Critical gaps (no test, no handling, silent): [2] saved-fact miss, [4] derived count (route b only), [3] NaN order,
[8b] schema break, [10] OCR move.

## Worktree parallelization strategy

| Step | Modules touched | Depends on |
|---|---|---|
| S1 engine read primitives (item 3 cosine method; item 1 `executeRaw({ jitOff })`) | `src/core/engine*`, `src/core/engine-sql/`, `src/core/postgres-engine/` | — |
| S2 hybrid pipeline (item 5b settings statement, fusion prefetch of cosines, post-fusion split; item 7) | `src/core/search/hybrid*`, `src/core/search/vector-*`, `src/core/search/graph-signals.ts`, `src/core/engine-sql/` | S1 |
| S3 search op (item 1 call site, 2, 4, 5c response meta and entity resolve) | `src/core/ops/search.ts`, `src/core/search/keyword-paging.ts`, new `src/core/search/{saved-facts,type-filter}.ts` | S1 (jitOff) |
| S4 dispatch and config (item 5a snapshot, request log) | `src/mcp/`, `src/commands/serve-http*`, `src/core/config-snapshot.ts`, CLI dispatch | — |
| S5 payload (item 8a lean rows, 8b context_pack; trailer edit last) | `src/core/search/lean-rows.ts`, `src/core/ops/facts.ts`, `src/core/verbs.ts`, `src/core/search/date-labels.ts` | S3 for `keyword-paging.ts` |
| S6 small items (6, 9, 10, 11) | `src/core/schema-migrations/helpers.ts`, `src/core/planner-stats.ts`, `src/core/search/relational-*`, `src/core/ai/`, `TODOS.md` | — |
| S7 integration (stamps, guards, goldens, generated trees, docs) | `src/core/behavior-change-notice.ts`, `CHANGELOG.md`, `scripts/*.tsv`, `test/fixtures/goldens/`, plugin/llms trees, `docs/architecture/key-files/` | all |

**Parallel lanes.** Lane A: S1 → S2 (engines and hybrid, sequential). Lane B: S3 (after S1's small first commit
lands). Lane C: S4 (independent). Lane D: S5 (lean rows and 8b in parallel; the trailer edit after B). Lane E: S6
(independent). Integrator: S7.

**Execution order.** Launch A, C, D and E. Land A's S1 commit first (hours), then launch B. Merge A → B → C → D
→ E into `capy/lhf-wave-2`, regenerate goldens and generated trees once, then run the bench and the full gate.

**Conflict flags.** `ops/search.ts` (B only), `hybrid.ts` and both engines (A only), `keyword-paging.ts` (B, then
D), `vector-statement.ts` (A only: item 7 and #6734's edits together), every stamp, guard, golden and generated
file (integrator only). 5 lanes: 4 parallel at launch, 1 sequenced behind S1.

## Implementation Tasks

Synthesized from this review's findings. Each task derives from a specific finding above. Effort assumes CC +
gstack; human estimates use the methodology's default ratios.

- [ ] **T1 (P1, human: ~2h / CC: ~15min)** — coordination — Re-cut lanes by file ownership; integrator owns shared files
  - Surfaced by: Section 1 — F1
  - Files: lane prompts; `scripts/module-size-limits.tsv`, `src/core/behavior-change-notice.ts` (integrator)
  - Verify: `gstack-lane-check --planned …` clear for each lane
- [ ] **T2 (P1, human: ~1d / CC: ~1h)** — saved facts — Reclassify item 2 or keep exact semantics; add token-class fixture and fallbacks
  - Surfaced by: Section 4 — F2
  - Files: `src/core/ops/search.ts` (or new `src/core/search/saved-facts.ts`), `test/search-saved-facts.test.ts`
  - Verify: parity fixture (slug path, email, substring, stopword-only, >200 candidates) on PGLite and Postgres
- [ ] **T3 (P1, human: ~4h / CC: ~30min)** — context_pack — Keep v1 shape and budget_used meaning; add real-entity conformance case
  - Surfaced by: Section 3 — F3
  - Files: `src/core/ops/facts.ts`, `src/core/verbs.ts`, `test/fixtures/memory-verbs/cases.json`
  - Verify: conformance suite with `validateSchema`; `test/ambient-recall.test.ts` unchanged and green
- [ ] **T4 (P1, human: ~4h / CC: ~30min)** — keyword count — Pick the skip route; render skipped honestly; full TODOS gate
  - Surfaced by: Section 4 — F4
  - Files: `src/core/search/keyword-paging.ts`, `src/core/ops/search.ts`, `test/search-keyword-paging.test.ts`
  - Verify: 10k audit brain and 55k slot: unavailable <1%, added p50 <100 ms; trailer test for the skipped state
- [ ] **T5 (P2, human: ~3h / CC: ~20min)** — type filter — `executeRaw({ jitOff })`, EXISTS over expanded sets, DISTINCT on miss
  - Surfaced by: Section 2 — F5
  - Files: `src/core/engine.ts`, `src/core/postgres-engine.ts`, `src/core/pglite-engine.ts`, `src/core/ops/search.ts`
  - Verify: `test/search-type-filter-reconcile.test.ts` + alias case; Postgres E2E no `JIT:` on both statements
- [ ] **T6 (P2, human: ~2h / CC: ~15min)** — cosine — Guard NULL/NaN/dimension cases; parity incl. halfvec
  - Surfaced by: Section 2 — F6
  - Files: `src/core/engine-sql/chunks.ts`, `src/core/search/hybrid.ts`
  - Verify: parity test within 1e-6 on both engines with zero/NULL/halfvec rows
- [ ] **T7 (P2, human: ~2h / CC: ~15min)** — vector walk — Postgres plan test and receipt for #6747's statement
  - Surfaced by: Section 1 — F7
  - Files: `test/e2e/` (new Postgres walk plan test)
  - Verify: E2E plan assertions on a two-source Postgres fixture
- [ ] **T8 (P2, human: ~1d / CC: ~1h)** — post-fusion — Read/apply split with one prefetch; pool-2 concurrency E2E
  - Surfaced by: Section 4 — F8
  - Files: `src/core/search/hybrid.ts`, `src/core/search/graph-signals.ts`, `src/core/search/hybrid/`
  - Verify: order-only digest equal; pool-2 E2E p95 ≤ master
- [ ] **T9 (P2, human: ~3h / CC: ~20min)** — snapshot/log — CLI allowlist (or exclude), bounded request-log queue
  - Surfaced by: Section 1 — F9
  - Files: `src/core/config-snapshot.ts`, CLI dispatch, `src/commands/serve-http-mcp.ts`
  - Verify: external-write visibility test; queue bound test
- [ ] **T10 (P2, human: ~3h / CC: ~20min)** — ANALYZE — Best-effort ANALYZE; expression-index staleness on both engines
  - Surfaced by: Section 4 — F10
  - Files: `src/core/schema-migrations/helpers.ts`, `src/core/planner-stats.ts`
  - Verify: upgraded PGLite fixture with a pre-existing index gets `pg_stats` rows under the index name
- [ ] **T11 (P2, human: ~3h / CC: ~20min)** — lean rows — `row_defaults` in `_meta.retrieval`; round-trip property test
  - Surfaced by: Section 3 — F11
  - Files: `src/core/search/lean-rows.ts`, `src/core/search/date-labels.ts`, `src/mcp/dispatch.ts`
  - Verify: property test lean + defaults ≡ full; `[gbrain dates]` label unchanged
- [ ] **T12 (P2, human: ~2h / CC: ~15min)** — guards — Plan peels out of ceiling-bound files
  - Surfaced by: Section 2 — F12
  - Files: `src/core/ops/search.ts`, `src/core/search/hybrid.ts`, `src/core/ai/gateway.ts`, `scripts/module-size-limits.tsv`
  - Verify: `bun run check:module-size` on the integrated tree
- [ ] **T13 (P2, human: ~4h / CC: ~30min)** — bench — Order-only digest; remote/typed/facts/two-source passes; commit delay proxy
  - Surfaced by: Section 3 — F13
  - Files: `scripts/bench-refactor-wave-1.ts`, new bench helper for the proxy
  - Verify: digest equal on master vs master (stable), differs when a fixture fact is removed
- [ ] **T14 (P2, human: ~3h / CC: ~20min)** — expansion — Measured default in the shared resolver; OCR pinned or noticed
  - Surfaced by: Section 1 — F14
  - Files: model resolver module, `src/core/ai/gateway.ts`, `test/ai/ocr-model-routing.test.ts`
  - Verify: pin-survives test; `gbrain models` shows the measured default
- [ ] **T15 (P3, human: ~1h / CC: ~10min)** — expansion — Dedupe against the original before the cap; report short expansions
  - Surfaced by: Section 2 — F15
  - Files: `src/core/search/expansion.ts`, `test/query-sanitization.test.ts`
  - Verify: unit test with a rewrite equal to the original
- [ ] **T16 (P3, human: ~1h / CC: ~10min)** — relational — Quoted/unquoted anchor and "joined" negative tests
  - Surfaced by: Section 2 — F16
  - Files: `test/relational-plan.test.ts`, relational intent tests
  - Verify: tests fail on master behavior where intended
- [ ] **T17 (P3, human: ~30min / CC: ~5min)** — numbers — Label item 5's figure estimated; re-measure interleaved
  - Surfaced by: Section 4 — F17
  - Files: plan, gbrain-evals report
  - Verify: report row with base/branch interleaved runs

JSONL artifact: not persisted (read-only voice).

## TODOS.md updates (proposed; unattended, so not asked one by one; not persisted)

1. **Facts trigram write cost** — What: measure insert cost of a trigram GIN on `facts` at 100k facts. Why: the only
   stated reason for rejecting the exact-preserving index. Pros: settles D2 with data. Cons: a bench run. Depends
   on: D2. Recommendation: A (add) if D2 keeps FTS.
2. **Read-concurrency cap for pooled installs** — What: a small per-request concurrency limit for meta and
   post-fusion reads. Why: pool-2 Supavisor installs. Depends on: T8's pool-2 result. Recommendation: A only if
   T8 regresses p95.
3. **Keyword count at 55k** (`TODOS.md:22`) — keep open until T4's full gate passes; don't close on the 400-page
   bench.

## Unresolved decisions that may bite you later

- D1: lane arrangement (recommend file-ownership layout). Missing answer.
- D2 (user challenge): item 2 as a behavior change with a quality gate, or measure the trigram write cost first.
- D3 (user challenge): item 8b as opt-in (or protocol bump) instead of the remote default.
- D4: item 4 route, skip-above-threshold (recommended) or derived count.
- D5: item 10 OCR fallback pinned to the old default or changed with a notice.
- D6: CLI snapshot scope (allowlist or out of this wave).

## Completion summary

- Step 0: Scope Challenge — scope accepted as-is
- Reality rows: 15/15 applicable rows emitted (`PLAN_REALITY: phase=eng rows=15/15 missing=none verdict=complete`), 2 unverified premises
- Architecture Review: 4 issues found (F1, F7, F9, F14)
- Code Quality Review: 5 issues found (F5, F6, F12, F15, F16)
- Test Review: diagram produced, 33 gaps identified (F3, F11, F13)
- Performance Review: 5 issues found (F2, F4, F8, F10, F17)
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 3 items proposed (not persisted)
- Failure modes: 5 critical gaps flagged
- Unresolved decisions: 6 in this review
- Outside voice: not run by this voice (parent's runner owns it)
- Parallelization: 5 lanes, 4 parallel / 1 sequential
- Lake Score: N/A (no answers scored in an unattended voice)

## Review log row (not written; the parent owns autoplan logging)

`plan-eng-review status=issues_open issues_found=17 critical_gaps=5 unresolved=6 mode=scope_accepted commit=d5861ac6`

## Next steps

The parent reconciles this voice with the outside voice, then carries D1-D6 to the autoplan gate. The user
challenges are D2 and D3; the recommended defaults are the file-ownership lanes (D1), skip-above-threshold (D4),
pinning OCR (D5) and leaving CLI out of the snapshot in this wave (D6).

## Learnings (not written)

- A digest gate that hashes rows can't see response-meta changes; hash `_meta.retrieval` fields an item touches.
- "Move it off the critical path" on a single-connection engine only helps if the work is skipped.
- Ratchet ceilings at exactly the measured size make every lane a guard conflict; budget peels in the plan.

```gstack-findings
{"id":"F1","severity":"High","title":"Lane split fails the one-owner lane check: A and B share ops/search.ts, hybrid.ts and both engines; item 5's prefetch rewrites the read item 3 replaces; items 4 and 8a share keyword-paging.ts; shared stamp/guard/golden files have several owners","file":"src/core/ops/search.ts","line":383,"fix":"Re-cut lanes by file ownership (A: engines+hybrid incl. items 3, 5b, 7 and executeRaw jitOff; B: ops/search.ts+keyword-paging.ts items 1, 2, 4, 5c; C: dispatch/config 5a; D: payload 8 with the trailer edit after B; E: 6, 9, 10, 11); integrator alone owns behavior-change-notice.ts, CHANGELOG, module-size-limits.tsv, engine-sql-baseline.tsv, goldens and generated trees; state item 5b's vector-prefetch fallback if item 3 is reverted"}
{"id":"F2","severity":"High","title":"Item 2's FTS prefilter drops saved facts beyond 'ops in devops' (slug path lexeme people/alice, email/URL lexemes, stopword-only empty tsquery) and changes results the other way via the LIMIT 200 cut; it is a behavior change, not a pure-performance item","file":"src/core/fts-language.ts","line":121,"fix":"Reclassify item 2 with a quality gate, or measure the trigram index's write cost at 100k facts before rejecting it; if FTS stays, fall back to LIKE when the current-language idx_facts_fts is not valid, for CJK terms and for an empty tsquery, and add a token-class parity fixture","user_challenge":true,"changes":"direction"}
{"id":"F3","severity":"High","title":"Item 8b breaks the frozen v1 context_pack schema (cards.summary and open_threads are required) and the budget_used <= budget tests; the only schema conformance case packs a nonexistent entity so it cannot catch this","file":"src/core/verbs.ts","line":822,"fix":"Keep the v1 card shape and budget_used as tokens of text; offer compaction as an explicit opt-in or under a protocol bump; add a conformance case with a real entity and validateSchema true","user_challenge":true,"changes":"scope"}
{"id":"F4","severity":"High","title":"Item 4 saves about 0 ms on PGLite as written (the response awaits the count on the same single connection; -32 ms came from stubbing it out), and deriving the count from the hybrid keyword arm is wrong under keywordOrFallback and narrowing","file":"src/core/ops/search.ts","line":812,"fix":"Choose explicitly: skip the count on PGLite above a page threshold with a distinct keyword_count_skipped state rendered as skipped (recommended), or derive only when the arm ran strict, unnarrowed and under its limit with an equivalence test; gate on the full TODOS rule (under 1% unavailable and under 100 ms added p50 on the 55k slot)"}
{"id":"F5","severity":"Medium","title":"Item 1 cannot keep the notice without the full DISTINCT list, the miss path is the common agent case and still JIT-compiles, and there is no ops-level JIT-off read","file":"src/core/ops/search.ts","line":284,"fix":"Add jitOff to executeRaw options (Postgres via jitOffRead, PGLite no-op); EXISTS per requested type over its expanded set; DISTINCT only on a miss; both JIT-off; Postgres E2E with no JIT block on both statements and an alias keep test"}
{"id":"F6","severity":"Medium","title":"Item 3's SQL cosine returns NaN for zero vectors, NULL for missing ones and errors on dimension mismatch, where JS returns 0 per row; NaN breaks the sort and an error drops rescoring for every row","file":"src/core/search/hybrid.ts","line":1599,"fix":"Map NULL/NaN to not-hydrated (cosine 0) and avoid statement-level errors; keep the column-name guard, visibility filter and halfvec cast; parity test with zero, NULL and halfvec rows on both engines"}
{"id":"F7","severity":"Medium","title":"Item 7 changes the Postgres index walk too (one indexWalkSql for both engines) but is scoped and tested as PGLite only","file":"src/core/postgres-engine.ts","line":1437,"fix":"Add a Postgres E2E plan test with #6747's assertions and a two-source Postgres timing row; list it as a Postgres plan change"}
{"id":"F8","severity":"Medium","title":"Item 5's post-fusion Promise.all requires splitting four apply functions into read/apply halves in a file at its size ceiling, and the combined read fan-out is unmeasured at GBRAIN_POOL_SIZE=2","file":"src/core/search/hybrid.ts","line":537,"fix":"Use one prefetch object per stage group (fusion-prefetch pattern) keeping order and per-stage catches; add a pool-2, 8-concurrent-search E2E through the delay proxy (no timeout, p95 not worse than master); cap concurrency only if it regresses"}
{"id":"F9","severity":"Medium","title":"Item 5 widens the config snapshot to CLI ops gated only by mutating === false, so long read ops ignore mid-run config changes; the non-blocking mcp_request_log has no bound and feeds admin usage counts","file":"src/core/config-snapshot.ts","line":1,"fix":"Apply the CLI snapshot to an allowlist of short read ops or leave CLI out of this wave; bound the request-log queue with a drop counter in doctor; test external-write visibility per request"}
{"id":"F10","severity":"Medium","title":"Item 6 never reaches brains whose index is already present (buildIndexOnline returns 'present' first), F4b checks table-name stats while expression stats live under the index name, and ANALYZE failure handling is unspecified","file":"src/core/schema-migrations/helpers.ts","line":94,"fix":"Best-effort ANALYZE after created/rebuilt (never fail a migration with a valid index); staleness check flags expression indexes with no pg_stats row under their own name on both engines; test a pre-existing-index upgrade fixture"}
{"id":"F11","severity":"Medium","title":"Item 8a's elided defaults are not machine-recoverable: the trailer is null on query and the defaults are brain-specific","file":"src/core/search/keyword-paging.ts","line":247,"fix":"Emit row_defaults in _meta.retrieval, elide only fields equal to it, render the prose line from it, keep create_safety unless the evidence mapping is in tool descriptions, and add a lean+defaults == full property test plus a [gbrain dates] label test"}
{"id":"F12","severity":"Medium","title":"hybrid.ts, postgres-engine.ts, pglite-engine.ts and gateway.ts are at their exact ratchet ceilings and ops/search.ts / ops/facts.ts are near the 1500 new-file cap; most items grow them","file":"scripts/module-size-limits.tsv","line":1,"fix":"Plan peels in the lane prompts (saved-facts and type-filter modules out of ops/search.ts, cosine SQL in engine-sql/chunks.ts, post-fusion prefetch in search/hybrid/, expansion default outside gateway.ts); integrator owns the TSV"}
{"id":"F13","severity":"Medium","title":"The order-digest gate is blind to most items: it hashes score, runs remote:false, has no types, facts or second source, and ignores _meta.retrieval; the delay proxy is uncommitted scratch","file":"scripts/bench-refactor-wave-1.ts","line":474,"fix":"Order-only digest plus score tolerance; add remote:true, typed (missing type and alias), seeded-facts and two-source passes; digest saved_facts ids and type_filter_notice; commit the delay proxy as a bench helper"}
{"id":"F14","severity":"Medium","title":"Item 10's measured default must sit where expansion resolves (two config planes at gateway configure time), or it overrides pins and disagrees with gbrain models; it also moves the OCR fallback model","file":"src/core/ai/gateway.ts","line":880,"fix":"Apply the default inside resolveEffectiveExpansionModel after both planes report tier_default/fallback; pin getImageOcrModel's fallback to the previous default or ship a BEHAVIOR_CHANGES row; tests for pin survival, gbrain models and OCR"}
{"id":"F15","severity":"Low","title":"Item 10's '2 rewrites' does not change search fan-out (output already capped at 2) and removes slack when a rewrite equals the original","file":"src/core/search/expansion.ts","line":51,"fix":"State that the change only cuts output tokens; dedupe against the original before the cap; report the share of calls with fewer than 2 surviving rewrites in the GBRA-94 rerun"}
{"id":"F16","severity":"Low","title":"Item 9b cannot fire on quoted anchors (quoted queries are refused first) and 9a's 'joined' collides with works_at wording; planned tests would not catch either","file":"src/core/search/relational-plan.ts","line":211,"fix":"Test an unquoted resolvable title with a year and decide on quoted titles; add negative tests for 'joined <company>' and 'was at <company>'"}
{"id":"F17","severity":"Low","title":"Item 5's '1,550 to under 500 ms' is a subtraction across two trees (PR measured 250 commits behind on its own DB plus an estimated post-fusion gain)","file":"docs/plans/2026-10-15-lhf-wave-2/audit/latency.md","line":125,"fix":"Label it estimated and re-measure on the integrated tree with the committed delay proxy, interleaving base and branch runs"}
```
