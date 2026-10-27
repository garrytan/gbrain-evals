INPUT: eng 2ea3b35280d7f37a6d2ac5843bc6089f3c3ac7b02ffd288e073cbb190c36810c

# Eng review, round 2 (native voice): LHF wave 2, revision 2

Reviewer: anthropic/claude-opus-5-5 (native), gstack plan-eng-review methodology (runner profile), unattended.
`gstack: ok 1.91.101.0 for=autoplan` (this machine, `scripts/install.sh --check --for autoplan`, exit 0).
Target: the revised implementation plan at the INPUT hash. Checkout: the shared gbrain checkout on `capy/lhf-wave-2` at
`8e615169` (master `7f3c9f5f`, v0.60.252.0, merged over item 0; 112 commits since the round-1 base `3c16e9ba`),
read-only. No provider spend. New keyless receipts this round, all in scratch (local audit notes (not committed)):

- `prec.ts`: 200 random 1024-d pairs, pgvector 0.8.1 on PGLite versus the JS `cosineSimilarity` formula.
- `exists.sql`: `EXPLAIN ANALYZE` of item 1's batched `EXISTS` and the existing `DISTINCT` on the audit's 20k-page
  Postgres 16 brain (`audit-latency-pg`, database `g20k`). I started the stopped container for this run and stopped
  it again afterwards; nothing else on it changed.

Persistence: this voice writes only this file. The QA test plan, task JSONL, TODOS, review log and learnings are
presented as **not persisted**.

## Verdict

Revision 2 fixes the round-1 problems by cutting the risky items, and what's left is a sound, mostly
pure-performance wave. Items 4, 8 and 10 and the post-fusion fan-out are out. Item 2 now keeps the exact query.
Item 1 runs the full type list only on a miss. Two lanes own disjoint files, and harness G runs on master before
anything lands. Of my 17 round-1 findings, 12 are resolved, 4 are partly resolved and 1 no longer applies.

The remaining problems sit in the gates and in details that master's segmented-storage merge moved:

1. **Item 3's parity tolerance is tighter than pgvector's measured error.** The plan allows 1e-6; I measured a
   worst case of 1.8e-6 for cosine. Lean rows print scores to 4 significant digits, and evidence flips at a cosine
   of 0.8. As written, the ship rule will either block a correct item 3 or get loosened by hand.
2. **Item 1's JIT-off read costs extra round trips on servers that already run with JIT off.** I measured that
   the batched `EXISTS` does need JIT off when JIT is on: estimated cost 894,982 against `jit_above_cost` 100,000,
   577 ms of JIT for 0.3 ms of work. But the wrapper is 4 serial round trips, which is pure cost on Supabase,
   PG19 and other JIT-off servers.
3. **Harness G can't stay byte-identical as specified.** Unchanged code returns random `answer_id`s, and every run
   writes state (feedback rows, page retrievals, request-log rows). Interleaved runs on one database will differ
   even with no code change.
4. **Item 2's −25 to −200 ms comes from a different mechanism**, an FTS microbench. Its insert gate (p50 and p95)
   misses how GIN's pending list behaves on PGLite.
5. **The item 3 and item 7 specs predate master's chunk-visibility predicates.** The new SQL has to use
   `chunkVisibleFilter`, and #6747 has to be ported onto a walk statement that master changed.

None of these changes the wave's direction. Each is a short addition to an item's gate or spec.

## Round-1 findings: status

| Round 1 | Status in revision 2 | Note |
|---|---|---|
| F1 lanes overlap | Partly resolved | Two lanes with disjoint ownership plus integrator-owned shared files. Lane S's list misses `hybrid.ts`, `engine.ts`, files #6734 touches and `relational-recall.ts` (N10). |
| F2 FTS prefilter loses facts | Resolved | Trigram index on the unchanged query. New risks: gain receipt (N4), pending list (N5). |
| F3 context_pack breaks v1 | Resolved | Cut to NOT in scope with the right preconditions. |
| F4 keyword count saves ~0 | Resolved | Cut; deferred design matches the TODOS rule. |
| F5 item 1 notice / JIT | Resolved | Lazy DISTINCT, `executeRaw({ jitOff })`. New: round-trip cost (N3). |
| F6 SQL cosine edges | Partly resolved | Guards added. Zero-norm mapped to NULL changes the all-unhydrated early return; tolerance (N1). |
| F7 walk on Postgres | Resolved | Postgres E2E plan test and two-source row added. |
| F8 post-fusion fan-out | Resolved | Cut. |
| F9 CLI snapshot / log bound | Partly resolved | CLI cut, queue bounded; the drop counter isn't visible across processes (N9). |
| F10 ANALYZE for present brains | Partly resolved | Staleness check added. On Postgres nothing runs it automatically, and the rebuild hint is wrong (N7). |
| F11 lean-row defaults | Resolved | Cut. |
| F12 size ceilings | Partly resolved | "No growth" isn't achievable for interface members; `engine.ts` is also at its ceiling (N8). |
| F13 blind digest gate | Resolved | Harness G. New: determinism and tolerance (N1, N2). |
| F14 expansion resolver / OCR | Resolved | Cut, with the right preconditions. |
| F15 "2 rewrites" | Resolved | Cut. |
| F16 item 9 tests | No longer applies | 9b cut; 9a now has a guard (N13 for the guard's placement). |
| F17 estimate across trees | Resolved | Labelled an estimate (~800 ms) and to be re-measured. |

## Step 0: Scope Challenge

### A. Assess the target

**What already solves each sub-problem.**

- Item 1: `jitOffRead` (`src/core/postgres-engine.ts`, private) and `executeRaw` options (`timeoutMs`,
  `deadlineAt`). The plan's option route is right. **[Layer 1]**
- Item 2: #6734's index definition (`idx_facts_match_trgm`, a whole-table GIN on the haystack expression) and
  `buildIndexOnline`. `pg_trgm` already backs `idx_pages_slug_trgm` (v240). **[Layer 1]**
- Item 3: `getEmbeddingsByChunkIds` now filters with `chunkVisibleFilter('p','cc')`
  (`src/core/engine-sql/chunks.ts:1016`), not `currentTextProjectionFilter`; the new method must reuse it (N6).
- Item 6: Postgres repair already has a bounded ANALYZE (`repairPlannerTable`, 60 s statement and 2 s lock
  timeouts, `src/core/planner-stats.ts:161-172`); `maybeRefreshPlannerStats` is PGLite-only (`:245`).
- Item 9: seed resolution with a meeting/event exact-title tier already exists (`titleSeedTypes`,
  `src/core/search/relational-recall.ts:131-133`, used at `:446`).

**Minimum changes.** All six performance items are small or medium and independent apart from item 2's gate,
which needs item 6. Item 5 is the only large port, and it's correctly behind a lateness rule (N11 on making that
rule work).

**Complexity check** [estimated]: about 25-30 changed source files (item 5's port is about 15 of them), one new
migration, two engine-interface additions (`executeRaw` `jitOff`, the cosine read), harness G as one large script
change plus fixtures. That's still over the B gate (8+ files).

**Search check.** No new architectural pattern beyond round 1's per-request ALS snapshot (Bun's thenable
context-loss bug, oven-sh/bun#34277, is fixed in current builds, and the failure direction is a safe live read).
GIN `fastupdate` pending-list behavior is in-distribution Postgres knowledge (N5). **[Layer 1]**

**TODOS cross-reference.** `TODOS.md:22` stays open (item 4 deferred). Item 11 closes `TODOS.md:322`, `:400` and
marks `:499`.

**Distribution check.** No new artifact. The new migration changes `registry.generated.ts`,
`latest.generated.ts` and the catalog/migration goldens, which the integrator owns but lane S needs in order to
run its tests (N10).

### Premise table (REALITY: premise-table)

| # | Premise | Receipt | Verdict |
|---|---|---|---|
| P1 | Item 1's EXISTS needs JIT off | `exists.sql` on g20k: estimated cost 894,982 > `jit_above_cost` 100,000; JIT total 576.8 ms, execution 593.6 ms; with JIT off 0.315 ms | TRUE (measured) |
| P2 | `jitOffRead` is BEGIN, SET LOCAL, query, COMMIT | `src/core/postgres-engine.ts:370-373`, `src/core/postgres-engine/search-settings.ts:24-30` | TRUE: 4 round trips |
| P3 | DISTINCT with JIT off is about 30 ms | `exists.sql`: 37.1 ms at 20k | TRUE |
| P4 | Item 2: query text unchanged keeps semantics | index on the same expression; `matchingSavedFacts` unchanged at `src/core/ops/search.ts:383-429` | TRUE |
| P5 | Item 2: −25 to −200 ms | figures are the FTS prefilter microbench (`docs/plans/2026-10-15-lhf-wave-2/audit/evals-findings.md:55-57`); #6734's numbers are for its rewritten MATERIALIZED statement | UNSUPPORTED for the trigram mechanism |
| P6 | "Terms shorter than three characters still scan" | terms are already filtered to `length >= 3` at `src/core/ops/search.ts:387` | MOOT (no such terms reach SQL) |
| P7 | Item 3: zero-norm → NULL is the JS behavior | JS hydrates the vector and returns 0 (`src/core/search/hybrid.ts:1646-1647`); an all-unhydrated set returns early (`:1604`) | FALSE in the all-zero case |
| P8 | Item 3: scores within 1e-6 | `prec.ts`: max cosine difference 1.81e-6 over 200 pairs; score moves 0.3×, about 5.4e-7 | FALSE for cosine and evidence near 0.8; tight for scores |
| P9 | Item 3 matches `getEmbeddingsByChunkIds`' "current-projection filter" | master now uses `chunkVisibleFilter` (`src/core/engine-sql/chunks.ts:1016`) | STALE |
| P10 | Item 7 takes #6747 as is | master rewrote the walk's join block (`src/core/search/vector-statement.ts:377-384`: sources LATERAL, chunk-alias visibility) | NEEDS PORT |
| P11 | Item 6: present brains heal "on the next maintenance pass" (both engines) | `maybeRefreshPlannerStats` skips Postgres (`src/core/planner-stats.ts:245`); Postgres only via `gbrain repair planner-stats --apply` (`:161`) | PGLite only |
| P12 | Files at ceilings get no growth | `hybrid.ts` 1648/1648, `postgres-engine.ts` 3082/3082, `pglite-engine.ts` 3065/3065, `engine.ts` 2822/2822 (`scripts/module-size-limits.tsv`) | NOT ACHIEVABLE as stated for interface members |
| P13 | Harness can normalize only timings | random `answer_id` (`src/core/feedback/record.ts:36`) | FALSE |
| P14 | Item 0 GBRA-94: 298 vs 299 | gbrain-evals `verdict.json` (A1 299, B 298) | TRUE |
| P15 | Nightly 20k 36.3 ms / 10k 68.4 ms | `docs/plans/2026-10-15-lhf-wave-2/audit/latency.md:257-261`; not re-fetched | UNVERIFIED |
| P16 | Item 0 `query` p50 2,022 → 227 ms | commit `d5861ac6` message; not found in the evals markdown | UNVERIFIED |

unverified=2

### Reality rows

```
REALITY: premise-table finding 16 premises; P5 P7 P8 P9 P10 P11 P12 P13 false, stale or unsupported; unverified=2 src/core/engine-sql/chunks.ts:1016
REALITY: already-done pass branch now merges master 7f3c9f5f (commit 8e615169); no merged commit implements items 1-9; segmented storage changed the predicates items 3 and 7 use src/core/search/vector-statement.ts:377
REALITY: surface-check pass executeRaw opts, buildIndexOnline, repair planner-stats and bench --backend exist; --rtt-ms is new (existing toxiproxy --rtt per DX) scripts/bench-refactor-wave-1.ts:644
REALITY: binding-decisions pass round-1 cuts (items 4, 8, 10) honored as NOT in scope; item 0 approval respected; no decision log entries src/core/search/mode.ts:473
REALITY: numbers finding item 2 gain borrowed from the FTS microbench (docs/plans/2026-10-15-lhf-wave-2/audit/evals-findings.md:56); item 1 JIT cost measured here on g20k (local audit notes (not committed)); item 5 800 ms is labelled an estimate (docs/plans/2026-10-15-lhf-wave-2/audit/latency.md:126)
REALITY: deferred-asks pass every cut item is in NOT in scope with its precondition; audit's item 1 lazy DISTINCT now included docs/plans/2026-10-15-lhf-wave-2/audit/latency.md:69
REALITY: pr-count pass one wave PR plus an optional item 5 PR under the lateness rule .gstack/ship-policy.json:1
REALITY: transaction-semantics finding item 1 jitOff adds a 4-statement transaction per typed search; item 5 settings consolidation keeps the nested restore; pool-2 contention mode added src/core/postgres-engine/search-settings.ts:24
REALITY: units pass no unit changes; tolerance 1e-6 is on scores and is the one numeric threshold at issue (N1) src/core/search/hybrid.ts:1624
REALITY: perf-table finding interleaved base/branch runs now required, but runs mutate shared state (feedback, retrievals, request log) between arms src/core/feedback/record.ts:36
REALITY: recall pass item 2 keeps exact LIKE semantics; item 7 keeps predicates; harness checks both src/core/ops/search.ts:413
REALITY: prior-art pass #6734 trigram index adopted, threshold-in-SQL and OR-retry rejected with reasons; #6747 adopted docs/plans/2026-10-15-lhf-wave-2/audit/latency.md:146
REALITY: contract-assumptions finding gbrain-evals attendance-world scorer and split names assumed; item 3 and 7 specs assume pre-merge predicates src/core/search/safe-chunks.ts:65
REALITY: dependency-fallback pass item 5 lateness rule names what ships without it; item 2 dropped if insert gate fails; item 2's planner gate depends on item 6 (lane M) src/core/schema-migrations/helpers.ts:94
REALITY: obligation-tiers pass items are droppable individually; the integrator removes failing items before the single full gate src/core/schema-migrations/helpers.ts:114
REALITY: falsification-box n/a not an incident plan -
REALITY: stop-reasons n/a not an incident plan -
REALITY: reporter-environment n/a not an incident plan -
```

PLAN_REALITY: phase=eng rows=15/15 missing=none verdict=complete (`gstack-plan-reality check --phase eng --scope
db,perf,search,dependency` on this file; the three incident-scope rows are n/a).

### B. Complexity selectors

The gate trips again (about 25-30 files). Unattended run, so the questions are recorded, not asked.

- **Feature cuts:** none proposed. Revision 2 already cut the risky items.
- **Structure question (pending, D1).** `Original arrangement`: lane S (items 1, 3, 7, 2, 5 in order) and lane M
  (6, 9, 11), integrator-owned shared files. `Smaller arrangement`: the same, but item 5 runs on its own branch
  from the start (lane S2, owning `config-snapshot.ts`, `mcp/dispatch.ts`, `serve-http*.ts`, `search-settings.ts`,
  `vector-settings.ts` and #6734's other files), so the lateness rule can actually trigger. Lane S then owns
  `ops/search.ts`, `engine-sql/*`, both engines, `engine.ts`, `hybrid.ts` and `vector-statement.ts`. Item 5's
  edits to the engines and `ops/search.ts` are sequenced after S lands. **Recommended: Smaller arrangement**
  (N11). Pending remedies: N1-N14.
- Scope record (not persisted): `feature answers: none asked; structure: pending D1 (recommend B); accepted scope:
  revision 2 items 0, G, 1, 2, 3, 5, 6, 7, 9, 11; pending remedies: N1-N14`.

### C. Findings from the Scope Challenge

1. **N8 (Medium, 9/10, code):** "no growth" on ceiling files can't hold for interface members (Section 2).
2. **N10 (Low, 8/10, code):** lane S's file list is incomplete (Section 1).
3. **N11 (Low, 8/10, plan text):** the lateness rule can't trigger with item 5 last in lane S (Section 1).

Dispositions: pending. Scope Challenge result: **scope accepted as-is**.

## 1. Architecture review

### Request-path diagram (revision 2)

```
MCP dispatch ──[5: snapshot for mutating:false ops; writes live]──► search/query (src/core/ops/search.ts)
  setup ... reconcileTypeFilter ............ [1] EXISTS(expanded sets) jitOff → miss? DISTINCT jitOff → notice
  hybridSearchCached (hybrid.ts)
     arms: keyword | title | vector walk ... [7] key probes (port onto master's sources LATERAL + chunk visibility)
            search transactions .......... [5] one settings statement
     fuse → cosineReScore ................ [3] SQL cosine via chunkVisibleFilter; JS fallback on failure
     post-fusion stages (unchanged, serial)
  buildRetrievalResponseMeta ............. [5] Promise.all(unsealed, readiness, entityFacts, savedFacts [2], held)
     matchingSavedFacts .................. [2] unchanged SQL, served by idx_facts_match_trgm
  mcp_request_log ........................ [5] off-reply insert, bounded queue, drops counted
apply-migrations → buildIndexOnline ...... [6] best-effort ANALYZE; [2] trigram index built here
F4b (PGLite, throttled 2 s) .............. [6] flags expression index with no pg_stats row under its name
relational intent/recall ................. [9] new attendance phrasings; broad verbs gated on seed type
```

### Findings

**N7 (Medium, 8/10). Item 6's Postgres recovery has no automatic owner, and the rebuild hint is wrong for item 2's
index.** `maybeRefreshPlannerStats` returns `skipped: 'not_pglite'` on Postgres (`src/core/planner-stats.ts:245`).
So on Postgres, "the next maintenance pass" only means doctor flags the table and a person runs
`gbrain repair planner-stats --apply` (`:161-172`). An already-present expression index on a quiet Postgres brain
stays without statistics until then. `buildIndexOnline`'s invalid-build error tells the user to run
`gbrain repair request-indexes --apply` (`src/core/schema-migrations/helpers.ts:114`), which repairs request indexes,
not `idx_facts_match_trgm`. This confirms CEO outside-4 and DX outside-2/4. Fix: state that the Postgres path is
doctor-flagged repair (or run the existing bounded `repairPlannerTable` once from `post-upgrade` for flagged
tables); make the helper's message name the index's own rebuild (rerun `gbrain apply-migrations`, or a generic
`gbrain repair indexes`); have the staleness reason print as "expression statistics missing", not a row delta (DX
native-3).

**N9 (Medium, 8/10). The request-log drop counter lives in the serving process, and doctor can't see it.**
`gbrain doctor` runs as its own process. An in-memory counter in `serve --http` is invisible to it, and it resets
on restart. The table feeds the admin dashboard and per-client usage (`src/commands/serve-http-admin-api.ts:81-90,
260-273`). This confirms DX native-1/2 and outside-3. Fix: persist drops. When the queue drains, write a summary
row (`operation='request_log_dropped'`, count, window), or upsert a counter row that doctor reads. Keep a config
switch for blocking inserts for operators who need complete audit rows. Test that a forced backpressure run
produces the persisted count.

**N10 (Low, 8/10). Lane S's file list is incomplete, and one file has no owner.** Item 3 changes `cosineReScore`
in `src/core/search/hybrid.ts:1568-1634`. Items 1 and 3 add members to the `BrainEngine` interface in
`src/core/engine.ts`. Item 5's port touches `title-statement.ts`, `sql-ranking.ts`, `alias-fanout.ts`,
`mentions/policy.ts`, `engine-sql/{titles,keyword-pages,cjk-search}.ts` and `provenance-demotion.ts` (#6734 file
list), and master changed several of these since. Item 9's seed-type guard belongs in
`src/core/search/relational-recall.ts`, which neither lane lists. The new migration regenerates integrator-owned
files that lane S needs for its own tests. Item 2's "planner uses the index after ANALYZE" gate depends on lane M's
item 6. Fix: complete lane S's list and give `relational-recall.ts` to lane M; lanes regenerate goldens locally and
the integrator commits the canonical copy; run item 2's planner gate after M merges. This confirms CEO native-7.

**N11 (Low, 8/10). The lateness rule can't fire as worded.** Item 5 is last in lane S, so when the other items
are ready, item 5 hasn't started. Fix: D1's smaller arrangement (item 5 on its own branch from the start), with
its engine and `ops/search.ts` edits rebased onto S after S merges. Confirms CEO native-6.

Security: no new auth surface. The cosine method keeps `COLUMN_NAME_REGEX`/`quoteIdentifier`
(`src/core/engine-sql/chunks.ts:1002-1015`). The trigram index is over text already readable through
`matchingSavedFacts`' visibility predicates, which stay in the query. The per-request snapshot is keyed by engine
object and ALS context.

Dispositions: N7, N9, N10, N11 pending (N11 via D1).

## 2. Code quality review

**N6 (Medium, 9/10). Items 3 and 7 are specified against pre-merge predicates.** Master's segmented storage
(v248, merged at `8e615169`) changed both statements:

- `getEmbeddingsByChunkIds` now filters `chunkVisibleFilter('p','cc')`, which adds the body-generation predicate
  (`src/core/engine-sql/chunks.ts:1016`; `src/core/search/safe-chunks.ts:65-67`). The plan says item 3 matches
  "the current-projection filter". If the new method copies that wording, it can rescore staged or retired chunk
  rows of a segmented page. `bun run check:chunk-visibility` also fails any new uncovered `FROM content_chunks`
  literal (`scripts/check-chunk-visibility.ts`, rows only shrink).
- The walk's join block now has a sources `CROSS JOIN LATERAL` and a chunk-alias visibility clause
  (`src/core/search/vector-statement.ts:377-384`). #6747's hunk replaces exactly those join lines, and its string
  assertion in `test/search/vector-statement.test.ts` pins the old text.

Fix: item 3 uses `chunkVisibleFilter`; port #6747 by hand onto the new walk (the `${visibilityClause}` with
`chunkAlias: 'cc'` keeps it covered by the guard); harness G adds a segmented page with staged and retired
generations to the cosine and walk fixtures. Confirms CEO native-1 with receipts.

**N8 (Medium, 9/10). "No growth" on ceiling files can't hold for interface members.** At `8e615169`:
`hybrid.ts` 1648/1648, `postgres-engine.ts` 3082/3082, `pglite-engine.ts` 3065/3065, and also `engine.ts`
2822/2822 (`scripts/module-size-limits.tsv`). Item 1 adds `jitOff` to `executeRaw`'s option type in the interface
and both engines. Item 3 adds an interface method plus a one-line delegate per engine and changes
`cosineReScore`'s read and fallback in `hybrid.ts`. None of that can live in a peeled module. Fix: name the
compensating peels in the lane prompt (for example, move `cosineReScore` and `cosineSimilarity` to
`search/cosine-rescore.ts` and re-export from `hybrid.ts`, which frees about 70 lines; fold the two engines'
delegates through an existing shared helper), or have the integrator raise those four rows once, with notes.
Confirms CEO native-8 and adds `engine.ts`.

**N12 (Low, 8/10). Item 3's fallback to JS is silent.** A statement that always fails, for example on an older
pgvector, removes the gain with no signal. Fix: warn once per process with the SQLSTATE, add a
`cosine_rescore: 'js_fallback'` marker to `_meta.retrieval.timings` or `degraded`, and have harness G assert the
SQL path ran on both engines. Confirms DX native-6.

**N13 (Low, 7/10). Item 9's broad-verb guard has a natural home that the plan doesn't name, and false routes are
already mostly harmless.** Seed resolution happens in `resolveSeedScoped`, with the attendance title tier
hardcoded to `['meeting', 'event']` (`src/core/search/relational-recall.ts:131-133,446`). The guard needs the
resolved seed's page type, which is one more read per broad-verb query, and schema-pack expansion of the meeting
types (CEO native-11). A company seed under "joined" fans out over `attended` edges, finds none and returns an
empty relational list (`:447`, `:459`), so the observable risk is small. Fix: implement the guard in
`resolveSeedScoped` using `expandEngineTypeFilters` on `['meeting','event']`. Negative tests should assert that
final results equal master's for employment, education and location wordings, not only the relation label.

Dispositions: N6, N8, N12, N13 pending.

## 3. Test review

**N1 (High, 9/10). Item 3's parity tolerance is tighter than measured pgvector error, and the zero-norm mapping
changes an edge case.** `prec.ts` (pgvector 0.8.1, 1024-d, 200 pairs, half of them near-parallel): the largest
difference between SQL `1 - (a <=> b)` and the JS float64 formula is 1.81e-6. The plan's rule is "scores within
1e-6, order identical". Four places break:

1. The blended score moves 0.3× the cosine difference (about 5.4e-7), inside 1e-6. But the `cosine` field
   (full rows, `--explain`) moves 1.8e-6, outside it.
2. Lean rows print `score.toPrecision(4)` (`src/core/search/lean-rows.ts:58-60`), so a 5e-7 difference flips the
   printed digit whenever the score sits near a rounding edge. Over hundreds of rows, that will happen.
3. `high_vector_match` is a threshold at cosine 0.8 (`src/core/search/evidence.ts:63,71`), so evidence and
   `create_safety` flip for any row within 2e-6 of it, and the plan's "threshold-boundary fixtures" are designed
   to land there.
4. "Order identical" fails on near-ties.

Separately, mapping a zero-norm vector to NULL ("not hydrated") differs from JS, which hydrates it and returns 0
(`src/core/search/hybrid.ts:1646-1647`). When every row is zero or missing, JS still blends while the SQL path
returns early (`:1604`) with raw RRF scores. That confirms CEO native-3 and outside-2.

Fix: (a) return 0 for zero-norm and dimension-mismatched rows and omit only absent or invisible rows, so hydration
presence matches JS; (b) define parity on pre-projection values: cosine within 5e-6, score within 2e-6, order
identical except permutations among rows whose scores differ by less than the tolerance, lean scores compared by
re-rounding the tolerance-equal raw values, and evidence/`create_safety` compared only where |cosine − floor| is
greater than the tolerance. Boundary fixtures then assert that classification is consistent with the SQL cosine.
Write this into G before item 3 lands, so the rule isn't tuned after a failure.

**N2 (High, 8/10). Harness G's "only timings normalized" rule fails on unchanged code, and interleaved runs share
mutable state.** Each `search`/`query` response carries a random `answer_id` (`src/core/feedback/record.ts:36`)
and a per-client rating cadence, and each run writes feedback rows, `page_retrievals` bumps
(`bumpLastRetrievedAt`, `src/core/ops/search.ts:807`), request-log rows and query capture. Base and branch runs
interleaved on one database therefore see different state, and a master-versus-master run won't come back
byte-identical. After item 2's migration, the base arm also runs against a database with the extra index and a
newer schema version. Fix: per-arm database clones restored from one template before each pass (Postgres
`CREATE DATABASE … TEMPLATE`, PGLite directory copy); normalize opaque ids by position; disable feedback and
retrieval writes in harness mode, or diff them separately; prove the harness with a master-versus-master run
that must be byte-clean before any item's gate counts. Confirms CEO native-2 and DX outside-1, and adds the
state-mutation and schema-skew cases.

### Coverage diagram

```
CODE PATHS                                                    USER FLOWS
[+] reconcileTypeFilter [1]                                   [+] agent typed search (remote PG)
  ├── [★★ TESTED] keep/drop/notice — search-type-filter-reconcile      ├── [GAP] [→E2E] jit=on: no JIT on EXISTS or DISTINCT
  ├── [GAP] alias kept via expanded set (planned)                      └── [GAP] jit=off server: round trips not worse (N3)
  └── [GAP] [→E2E] plan test, both statements (planned)
[+] matchingSavedFacts + trigram [2]                          [+] remember → search
  ├── [★★ TESTED] same facts — search-saved-facts                      └── [GAP] parity on all token-class fixtures (planned)
  ├── [GAP] EXPLAIN uses idx_facts_match_trgm, both engines (N4)
  ├── [GAP] insert p99/max, batch throughput, pending-list search cost (N5)
  └── [GAP] index build failure message (N7)
[+] cosineReScore SQL [3]
  ├── [★★ TESTED] chunkless head start — cosine-rescore-chunkless-headstart
  ├── [GAP] tolerance-aware parity incl. all-zero set (N1)
  ├── [GAP] segmented staged/retired rows excluded (N6)
  └── [GAP] fallback marker emitted (N12)
[+] walk key probes [7]
  ├── [★★ TESTED] PGLite plan — vector-index-walk (#6747)
  └── [GAP] [→E2E] Postgres plan + segmented page (planned + N6)
[+] item 5 snapshot / settings / meta / log
  ├── [GAP] snapshot sees own writes; next request sees external write
  ├── [GAP] one settings statement; nested restore; #6543 budget
  ├── [GAP] [→E2E] pool 2 and 6 contention (planned)
  └── [GAP] persisted drop count under forced backpressure (N9)
[+] ANALYZE + staleness [6]
  ├── [GAP] pre-existing v240 index gets stats (PGLite, planned)
  ├── [GAP] forced ANALYZE failure keeps migration (planned)
  └── [GAP] Postgres: doctor flags, repair clears (N7)
[+] attendance lexicon [9]                                    [+] "who attended / was present at X"
  ├── [GAP] parser tests per phrase (planned)                          └── [GAP] [→EVAL] attendance-world split + held-out 30
  └── [GAP] negatives: final results equal master (N13)
[+] harness G
  └── [GAP] master-vs-master byte-clean run (N2)

LLM integration: [→EVAL] item 9 only (paid N9 arm, cap $2); no prompt changes remain.
COVERAGE: 5/27 paths tested (19%)  |  Code paths: 5/22  |  User flows: 0/5
QUALITY: ★★★:0 ★★:5 ★:0  |  GAPS: 22 (5 E2E, 1 eval)
```

Legend: ★★★ behavior + edge + error | ★★ happy path | ★ smoke check | [→E2E] integration test | [→EVAL] LLM eval.

### Test plan (QA artifact, not persisted)

```markdown
# Test Plan
Generated by /plan-eng-review on 2026-10-15
Branch: capy/lhf-wave-2
Repo: garrytan/gbrain

## Affected Pages/Routes
- MCP `search` / `query` (rows, `_meta.retrieval`, notices) on PGLite and Postgres
- `gbrain apply-migrations` / upgrade (trigram index, ANALYZE)
- `gbrain doctor` / `gbrain repair planner-stats` (expression statistics, request-log drops)

## Key Interactions to Verify
- Typed search with a guessed type on a JIT-on and a JIT-off Postgres
- `remember` then search, across the token-class fixtures, before and after the trigram index
- 8 concurrent searches + a write at pool 2 and 6, base and branch interleaved on cloned databases

## Edge Cases
- All candidate chunks zero-norm or missing
  Value: protects=score parity; fails_when=SQL path returns early where JS blends; why_new=SQL cosine; seam=none; no_claim=image space
- Cosine within 2e-6 of the 0.8 evidence floor
  Value: protects=create_safety stability; fails_when=classification flips; why_new=float32 accumulation; seam=none; no_claim=other floors
- Segmented page with staged and retired generations
  Value: protects=chunk visibility; fails_when=staged rows rescored or walked; why_new=master v248; seam=none; no_claim=inline pages
- Facts insert burst past the GIN pending-list limit on PGLite
  Value: protects=write and search latency; fails_when=flush spike or slow pending scan; why_new=new GIN; seam=none; no_claim=Postgres autovacuum timing

## Critical Paths
- Harness G master-vs-master run byte-clean after normalization
  Value: protects=every item's gate; fails_when=random ids or shared state differ; why_new=new harness; seam=none; no_claim=float tolerance
- Upgrade of a brain with a pre-existing expression index
  Value: protects=55k entity-names latency; fails_when=stats never collected; why_new=present path; seam=none; no_claim=Postgres autovacuum

## Tests to Retire
- none

## Pending Decisions
- D2 cosine tolerance definition (N1)
- D3 harness isolation method (N2)
```

Dispositions: N1, N2 pending (D2, D3).

## 4. Performance review

**N3 (Medium, 9/10). Item 1's JIT-off wrapper costs extra round trips on servers that already have JIT off.**
Measured on g20k: the batched `EXISTS` does need JIT off when JIT is on (estimated cost 894,982, JIT 576.8 ms,
execution 593.6 ms; 0.315 ms with JIT off), so the plan is right to wrap it. But `jitOffRead` is a transaction
of BEGIN, `SET LOCAL jit = off`, the query and COMMIT (`src/core/postgres-engine.ts:370-373`), which is 4 serial
round trips. That's +90 ms at 30 ms RTT on Supabase-style JIT-off servers, where the plain statement already took
one round trip. That's the population item 5 targets. Fix: read `jit` once per engine (or per pooled connection,
for example with the first search's settings statement) and skip the wrapper when it's off. Or pipeline BEGIN,
SET and the query inside the transaction without awaiting each. Add a JIT-off-server row to the item 1 receipt.
Confirms CEO native-4 with the measurement.

**N4 (Medium, 8/10). Item 2's expected gain was measured for a different mechanism.** The −25 to −200 ms figures
are the FTS prefilter microbench (`docs/plans/2026-10-15-lhf-wave-2/audit/evals-findings.md:55-57`). #6734's measurement was for its
own rewritten statement, a MATERIALIZED CTE whose comment says that, left to itself, the planner scanned every
fact to sort before the visibility joins. Revision 2 keeps master's query (`ORDER BY f.valid_from DESC, f.id DESC
LIMIT 200` with correlated visibility predicates, `src/core/ops/search.ts:406-417`), where the planner may prefer
walking a `valid_from` index and filtering, so the trigram index may go unused. Scale: unknown until measured.
Fix: the item 2 receipt is the unchanged query at 10k/50k/100k facts on both engines, with an EXPLAIN assertion
that a bitmap scan on `idx_facts_match_trgm` serves it after ANALYZE. If it isn't used or doesn't gain, drop the
item under the same rule as the insert gate.

**N5 (Medium, 7/10). Item 2's insert gate (p50/p95 within +25%) misses GIN's pending-list behavior.**
`idx_facts_match_trgm` has default `fastupdate`, so inserts append to a pending list that is merged in bulk.
Per-insert p50/p95 look cheap, while the merge shows up as a p99/max spike on the insert that crosses
`gin_pending_list_limit`, or during VACUUM. PGLite runs no autovacuum, so the list grows until an insert triggers
the merge, and every search scans the unmerged list until then. Fact writes also arrive in batches (extraction,
backfill), not one at a time. Fix: measure insert p99 and max, batch throughput at 100k facts, and search latency
with a full pending list, on both engines. If PGLite spikes, create the index `WITH (fastupdate = off)` there, or
on both engines, and re-measure.

**N14 (Low, 7/10). Item 6's ANALYZE time during migrations isn't in the operational-changes list.** ANALYZE
samples about 30k rows per table, so it's bounded, but upgrades now print and spend it, and PGLite's
`buildIndexOnline` branch prints no progress line (DX native-4). Fix: add it to the PR body's operational changes
with the measured time at 55k pages, plus a one-line PGLite progress notice. Confirms CEO native-10 and DX
native-8.

Memory and caching: item 5's snapshot reads the whole config table once per read request (a handful of rows). The
bounded queue caps request-log memory (N9 on visibility). No new unbounded structures.

Dispositions: N3, N4, N5, N14 pending.

## Outside voice

Not run by this voice; the parent's dual-voice runner owns it.

## NOT in scope

Revision 2's list stands, and each cut item carries the precondition reviewers raised:

- Tool-result size: needs per-brain `row_defaults`, opt-in or v2 `context_pack`, and a powered Cat 40 rule.
- PGLite keyword count: needs a skip with its own state and the full TODOS gate.
- Expansion model and rewrite count: needs one resolver shared by serving and `gbrain models`, plus the OCR
  fallback decision.
- Post-fusion fan-out, fusion prefetch and the CLI snapshot: each needs its own failure and staleness design.
- Year tokens in planner anchors: needs anchor spans kept through the parser.
- Typed vector walk, `full` surface budget, Family E, mention links, H1, brief gaps, scoped HNSW recall,
  chat-key `tokenmax`, embed dedupe, PGLite `stale` subquery and #6771: unrelated or minor, filed.

This voice adds nothing to the list.

## What already exists

- Bench and round-trip counts (`scripts/bench-refactor-wave-1.ts`); harness G extends it (N2 on isolation).
- `jitOffRead`, `withSearchJitOff`; `executeRaw` options (item 1 reuses them; N3 on cost).
- #6734's trigram index definition; `buildIndexOnline`; `pg_trgm` (v240).
- `chunkVisibleFilter` and the chunk-visibility guard (N6: item 3 and item 7 must use them).
- `repairPlannerTable` (bounded Postgres ANALYZE) for item 6's Postgres path (N7).
- `resolveSeedScoped` / `titleSeedTypes` for item 9's guard (N13).

## Failure modes

| Path | Realistic production failure | Test / handling | User sees |
|---|---|---|---|
| [1] type check | JIT-off Postgres pays 4 round trips per typed search | none / none | slower, silent |
| [2] trigram | Planner ignores the index under ORDER BY … LIMIT 200 | planned planner test (after item 6) | no gain, write cost paid |
| [2] trigram | PGLite pending-list merge spikes an insert; searches scan the list | p50/p95 gate only | slow write or search, silent |
| [2] build | CONCURRENTLY build fails; message points at request-indexes repair | throw with wrong hint | confusing error |
| [3] SQL cosine | Statement fails on an old pgvector; JS fallback forever | fallback, silent | no gain, silent |
| [3] SQL cosine | Wrong visibility filter rescored staged segmented chunks | none planned | **silent wrong ranking (critical gap)** |
| [5] snapshot | Read op writes config through raw SQL, then reads it in the same request | writes read live only for mutating ops | stale read, silent |
| [5] request log | Queue drops rows under backpressure; doctor can't see the count | in-memory counter | **silent audit gap (critical gap until persisted)** |
| [6] ANALYZE | Postgres brain with an existing index never gets expression stats | doctor flag, manual repair | slow entity-names, flagged |
| [7] walk | #6747 hunk conflicts with master's visibility join; ported wrong | Postgres + PGLite plan tests | slower or wrong rows |
| [9] lexicon | Broad verb routes employment question to attendance | negative tests | empty relational arm (low harm) |
| [G] harness | Random ids or shared state fail parity on unchanged code | none planned | gate noise, ad-hoc loosening |

Critical gaps: the item 3 visibility filter (N6) and request-log drops without a persisted count (N9).

## Worktree parallelization strategy

| Step | Modules touched | Depends on |
|---|---|---|
| G harness + master baselines | `scripts/`, `test/fixtures/` | — |
| S search path (items 1, 3, 7, 2) | `src/core/ops/`, `src/core/search/` (incl. `hybrid.ts`, `vector-statement.ts`), `src/core/engine-sql/`, `src/core/engine.ts`, both engines, item 2 migration | G |
| S2 item 5 | `src/core/config-snapshot.ts`, `src/mcp/`, `src/commands/serve-http*`, `src/core/postgres-engine/`, `src/core/search/vector-settings.ts`, #6734's engine-sql/search files | G; rebased onto S for shared files |
| M small items (6, 9, 11) | `src/core/schema-migrations/helpers.ts`, `src/core/planner-stats.ts`, `src/core/search/relational-{intent,recall}.ts`, `TODOS.md` | G |
| I integration | `behavior-change-notice.ts`, `CHANGELOG.md`, `scripts/*.tsv`, goldens, generated trees | S, S2, M |

**Parallel lanes.** Lane S: items 1 → 3 → 7 → 2. Lane S2: item 5, starting from G and owning only its own files
until S merges. Lane M: 6 → 9 → 11.

**Execution order.** Land G with baselines. Launch S, S2 and M. Merge M (item 2's planner gate needs item 6),
then S, then rebase S2 onto S for `ops/search.ts`, the engines and `postgres-engine/search-settings.ts`. Merge S2
if it's parity-clean and green, otherwise ship without it. Integrator regenerates and runs the full gate once.

**Conflict flags.** `ops/search.ts`, both engines, `engine.ts` (S, then S2); `relational-recall.ts` (M only);
ceiling rows in `module-size-limits.tsv` (integrator only). 3 lanes: 3 parallel at launch, with one rebase point.

## Implementation Tasks

Synthesized from this review's findings. Each task derives from a specific finding above.

- [ ] **T1 (P1, human: ~3h / CC: ~20min)** — harness — Tolerance-aware cosine parity; zero-norm returns 0, not NULL
  - Surfaced by: Section 3 — N1
  - Files: `scripts/bench-refactor-wave-1.ts`, `src/core/engine-sql/chunks.ts`
  - Verify: all-zero fixture blends like JS; near-floor fixture classification consistent; master-vs-branch clean
- [ ] **T2 (P1, human: ~4h / CC: ~30min)** — harness — Per-arm DB clones, opaque-id normalization, write side effects off; master-vs-master proof
  - Surfaced by: Section 3 — N2
  - Files: `scripts/bench-refactor-wave-1.ts`
  - Verify: master-vs-master full remote comparison byte-clean twice in a row
- [ ] **T3 (P1, human: ~2h / CC: ~15min)** — search — Item 3 uses chunkVisibleFilter; port #6747 onto master's walk; segmented fixtures
  - Surfaced by: Section 2 — N6
  - Files: `src/core/engine-sql/chunks.ts`, `src/core/search/vector-statement.ts`, `test/search/vector-statement.test.ts`
  - Verify: `bun run check:chunk-visibility`; staged/retired rows absent from cosine and walk results
- [ ] **T4 (P2, human: ~2h / CC: ~15min)** — type filter — Skip the JIT-off wrapper when server JIT is off (or pipeline it)
  - Surfaced by: Section 4 — N3
  - Files: `src/core/postgres-engine.ts` (or a peeled helper)
  - Verify: round-trip count on a JIT-off Postgres equals master's; JIT-on plan test has no JIT block
- [ ] **T5 (P2, human: ~3h / CC: ~20min)** — saved facts — Trigram receipt and EXPLAIN on the unchanged query at 10k/50k/100k
  - Surfaced by: Section 4 — N4
  - Files: harness fixtures; `test/` planner test
  - Verify: bitmap scan on `idx_facts_match_trgm` after ANALYZE; latency below master
- [ ] **T6 (P2, human: ~2h / CC: ~15min)** — saved facts — Pending-list p99/max, batch throughput, search with full list; fastupdate decision
  - Surfaced by: Section 4 — N5
  - Files: harness insert-cost mode; item 2 migration
  - Verify: p99 within the gate on both engines
- [ ] **T7 (P2, human: ~2h / CC: ~15min)** — planner stats — Postgres recovery path stated; index-specific rebuild hint; staleness wording
  - Surfaced by: Section 1 — N7
  - Files: `src/core/schema-migrations/helpers.ts`, `src/core/planner-stats.ts`, doctor check
  - Verify: Postgres fixture flagged by doctor, cleared by repair; failed build message names the right command
- [ ] **T8 (P2, human: ~2h / CC: ~15min)** — guards — Name peels or one integrator ceiling raise for the four ceiling files
  - Surfaced by: Section 2 — N8
  - Files: `src/core/search/hybrid.ts`, `src/core/engine.ts`, both engines, `scripts/module-size-limits.tsv`
  - Verify: `bun run check:module-size` on the integrated tree
- [ ] **T9 (P2, human: ~3h / CC: ~20min)** — request log — Persist drop counts; blocking-insert switch
  - Surfaced by: Section 1 — N9
  - Files: `src/commands/serve-http-mcp.ts`, doctor check
  - Verify: forced backpressure produces a persisted count doctor reports
- [ ] **T10 (P3, human: ~1h / CC: ~10min)** — coordination — Complete lane S list; give relational-recall.ts to M; item 5 on its own branch
  - Surfaced by: Section 1 — N10, N11
  - Files: lane prompts
  - Verify: `gstack-lane-check` clear for S, S2, M
- [ ] **T11 (P3, human: ~1h / CC: ~10min)** — cosine — Fallback warning and meta marker; harness asserts SQL path
  - Surfaced by: Section 2 — N12
  - Files: `src/core/search/hybrid.ts` (or peeled module)
  - Verify: forced failure emits marker once
- [ ] **T12 (P3, human: ~1h / CC: ~10min)** — relational — Guard in resolveSeedScoped with expanded meeting types; result-equality negatives
  - Surfaced by: Section 2 — N13
  - Files: `src/core/search/relational-recall.ts`, relational tests
  - Verify: employment/education/location wordings return master's results
- [ ] **T13 (P3, human: ~30min / CC: ~5min)** — release — List ANALYZE time in operational changes; PGLite progress line
  - Surfaced by: Section 4 — N14
  - Files: PR body, `src/core/schema-migrations/helpers.ts`
  - Verify: upgrade output shows the line

JSONL artifact: not persisted (read-only voice).

## TODOS.md updates (proposed; not persisted)

1. **Automatic Postgres expression-statistics recovery** — What: run the bounded `repairPlannerTable` for flagged
   expression indexes from `post-upgrade` or a cycle phase. Why: N7. Depends on: item 6. Recommendation: A (add)
   unless T7 builds it now.
2. **GIN fastupdate policy for facts** — only if T6 shows spikes and the fix isn't taken in this wave.

## Unresolved decisions that may bite you later

- D1: item 5 on its own branch from the start (recommended) or last in lane S.
- D2: cosine parity tolerance definition (N1); recommended values above.
- D3: harness isolation by per-arm database clones (recommended) or by disabling writes only.
- D4: item 1 wrapper skip on JIT-off servers (recommended) or pipelining.
- D5: request-log drop persistence shape and whether a blocking mode ships.

## Completion summary

- Step 0: Scope Challenge — scope accepted as-is
- Reality rows: 15/15 applicable rows emitted (`PLAN_REALITY: phase=eng rows=15/15 missing=none verdict=complete`), 2 unverified premises
- Architecture Review: 4 issues found (N7, N9, N10, N11)
- Code Quality Review: 4 issues found (N6, N8, N12, N13)
- Test Review: diagram produced, 22 gaps identified (N1, N2)
- Performance Review: 4 issues found (N3, N4, N5, N14)
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 2 items proposed (not persisted)
- Failure modes: 2 critical gaps flagged
- Unresolved decisions: 5 in this review
- Outside voice: not run by this voice (parent's runner owns it)
- Parallelization: 3 lanes, 3 parallel / 0 sequential (one rebase point)
- Lake Score: N/A (unattended voice)
- Round-1 carry-over: 12 resolved, 4 partly resolved (folded into N1, N7, N8, N9, N10), 1 no longer applies

## Review log row (not written; the parent owns autoplan logging)

`plan-eng-review status=issues_open issues_found=14 critical_gaps=2 unresolved=5 mode=scope_accepted commit=8e615169`

## Next steps

The parent reconciles this voice with the outside voice and carries D1-D5 to the gate. No user challenge this
round: every finding changes a gate or spec inside the plan's direction.

## Learnings (not written)

- Parity gates for float math need a tolerance derived from the engines' measured error, applied before rounding.
- A parity harness must be proven byte-clean on master against master before it can gate anything.
- After a large master merge, re-read every predicate a plan says it will "match".

```gstack-findings
{"id":"N1","severity":"High","title":"Item 3's parity rule (scores within 1e-6, order identical) is tighter than measured pgvector error (cosine max 1.81e-6), lean scores print at 4 significant digits and evidence flips at cosine 0.8; mapping zero-norm to NULL also changes the all-unhydrated early return","file":"src/core/search/hybrid.ts","line":1604,"fix":"Return 0 for zero-norm and dimension-mismatched rows (omit only absent/invisible rows); define parity on pre-projection values with measured tolerances (cosine 5e-6, score 2e-6), allow permutations among tolerance-equal scores, compare lean scores by re-rounding raw values, and compare evidence/create_safety only away from the floor; write it into harness G before item 3 lands"}
{"id":"N2","severity":"High","title":"Harness G's 'only timings normalized' parity fails on unchanged code (random answer_id, rating cadence) and interleaved runs mutate shared state (feedback, page_retrievals, request log, capture), with schema skew after item 2's migration","file":"src/core/feedback/record.ts","line":36,"fix":"Restore per-arm database clones from one template before each pass, normalize opaque ids by position, disable or separately diff write side effects, and require a byte-clean master-vs-master run before any item gate counts"}
{"id":"N3","severity":"Medium","title":"Item 1's batched EXISTS does need JIT off (measured: cost 894,982, 577 ms JIT, 0.3 ms without), but jitOffRead is 4 serial round trips, a regression on JIT-off servers such as Supabase","file":"src/core/postgres-engine.ts","line":370,"fix":"Read the server jit setting once per engine or connection and skip the wrapper when off, or pipeline BEGIN/SET LOCAL/query; add a JIT-off-server row to the receipt"}
{"id":"N4","severity":"Medium","title":"Item 2's -25 to -200 ms comes from the FTS microbench and #6734's rewritten statement; with master's unchanged ORDER BY valid_from LIMIT 200 query the planner may not use the trigram index","file":"src/core/ops/search.ts","line":406,"fix":"Receipt the unchanged query at 10k/50k/100k facts on both engines with an EXPLAIN assertion that idx_facts_match_trgm serves it after ANALYZE; drop the item if unused or no gain"}
{"id":"N5","severity":"Medium","title":"Item 2's insert gate (p50/p95 within +25%) misses GIN pending-list merges: spikes at p99/max, PGLite has no autovacuum so searches scan the unmerged list, and fact writes arrive in batches","file":"src/core/schema-migrations/helpers.ts","line":94,"fix":"Measure insert p99/max, batch throughput and search latency with a full pending list on both engines; use WITH (fastupdate = off) if PGLite spikes"}
{"id":"N6","severity":"Medium","title":"Items 3 and 7 are specified against pre-merge predicates: getEmbeddingsByChunkIds now uses chunkVisibleFilter (generation-aware) and master rewrote the walk's join block that #6747 replaces; check:chunk-visibility fails uncovered content_chunks reads","file":"src/core/engine-sql/chunks.ts","line":1016,"fix":"Item 3 uses chunkVisibleFilter; port #6747 by hand onto master's walk keeping the chunk-alias visibility clause; add a segmented page with staged and retired generations to harness fixtures"}
{"id":"N7","severity":"Medium","title":"Item 6's Postgres recovery for present indexes has no automatic owner (maybeRefreshPlannerStats skips Postgres) and buildIndexOnline's failure hint names request-indexes repair, wrong for the facts trigram index","file":"src/core/planner-stats.ts","line":245,"fix":"State the Postgres path (doctor flag plus repair planner-stats, or run repairPlannerTable from post-upgrade for flagged tables); make the helper's message name the index's own rebuild; word the staleness reason as missing expression statistics"}
{"id":"N8","severity":"Medium","title":"'No growth' on ceiling files cannot hold: items 1 and 3 add BrainEngine interface members and engine delegates and change cosineReScore; engine.ts (2822/2822) is also at its ceiling","file":"scripts/module-size-limits.tsv","line":1,"fix":"Name compensating peels (e.g. move cosineReScore/cosineSimilarity to search/cosine-rescore.ts) or have the integrator raise the four rows once with notes"}
{"id":"N9","severity":"Medium","title":"The request-log drop counter lives in the serve process; doctor runs in another process and cannot see it, and the table feeds the admin dashboard and usage counts","file":"src/commands/serve-http-admin-api.ts","line":81,"fix":"Persist drops (summary row or counter row read by doctor) and keep a blocking-insert switch; test forced backpressure produces the persisted count"}
{"id":"N10","severity":"Low","title":"Lane S's file list omits hybrid.ts, engine.ts and #6734's other files; relational-recall.ts (item 9 guard) has no owner; item 2's planner gate depends on lane M's item 6","file":"src/core/search/relational-recall.ts","line":131,"fix":"Complete lane S's list, give relational-recall.ts to lane M, let lanes regenerate goldens locally with the integrator committing them, and run item 2's planner gate after M merges"}
{"id":"N11","severity":"Low","title":"The item 5 lateness rule cannot trigger because item 5 is last in lane S","fix":"Run item 5 on its own branch from G, owning its own files, rebased onto lane S for shared files after S merges"}
{"id":"N12","severity":"Low","title":"Item 3's JS fallback on SQL failure is silent, so a permanently failing statement removes the gain unnoticed","file":"src/core/search/hybrid.ts","line":1599,"fix":"Warn once per process with SQLSTATE, add a js_fallback marker to retrieval meta, and have harness G assert the SQL path ran on both engines"}
{"id":"N13","severity":"Low","title":"Item 9's broad-verb guard belongs in resolveSeedScoped, which hardcodes ['meeting','event']; false routes already yield an empty relational list, so negatives should assert final results equal master","file":"src/core/search/relational-recall.ts","line":131,"fix":"Implement the guard in resolveSeedScoped with schema-pack expansion of meeting types and assert unchanged final results for employment, education and location wordings"}
{"id":"N14","severity":"Low","title":"Item 6's ANALYZE time during upgrades is not in the PR's operational-changes list and PGLite's buildIndexOnline branch prints no progress","file":"src/core/schema-migrations/helpers.ts","line":94,"fix":"List ANALYZE time (measured at 55k pages) in the operational changes and add a PGLite progress line"}
```
