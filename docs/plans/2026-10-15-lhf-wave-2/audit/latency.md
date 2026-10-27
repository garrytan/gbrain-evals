# Search hot-path latency audit (gbrain master 3c16e9ba, v0.60.250.0)

Auditor: latency lane. Date: 2026-10-15. No paid provider calls ($0): every run used the deterministic stub
embedder and reranker. Nothing in the shared gbrain checkout or the evals checkout was modified.

## How this was measured

- Scratch copy of master at local audit notes (not committed) (`git archive 3c16e9ba`). Harness
  `scripts/audit-trace.ts` (scratch only) builds a brain through `importFromContent` with the stub embedder
  and runs the real `search` and `query` operations (`remote:false` and `remote:true`), reading
  `_meta.retrieval.timings`. PGLite statements are timed by wrapping `PgliteStatementCache.query`;
  Postgres statements come from `log_min_duration_statement` and `auto_explain` (log_analyze).
- Brains: PGLite 400 pages and 10,000 pages; Postgres (pgvector/pgvector:pg16, the same image as
  `GBRAIN_PG_IMAGE` in `src/core/docker-postgres.ts:18`, server defaults, so `jit=on`) at 20,000 pages.
  Corpus: 30% `email`, 10% `person`, 10% `company`, 50% `note`, with links; 4 x 80-word paragraphs from the
  bench's 256-word vocabulary.
- Remote-pooler latency: a TCP proxy (`delay-proxy.ts`) adds 15 ms each way, so RTT is 30 ms, the same as
  the ~31 ms pooler RTT in #6721.
- Machine: 4 vCPU AMD EPYC. Some early PGLite numbers ran while a build was going on; the A/B numbers below
  were re-run with nothing else running. Expect about ±10 ms noise.
- Caveat: two-word queries drawn from a 256-word vocabulary match a large share of chunks. That is a worst
  case for the keyword arm and count. Absolute keyword times are pessimistic, but the round-trip, JIT and
  plan-shape findings don't depend on the corpus.
- Raw artifacts: local audit notes (not committed) (`pglite400.json`, `trace400.json`, `pg20k-*.log`,
  `scale/*.json`).

Baseline, Postgres 20k, warm, remote search (MCP path): **189 ms at RTT 0, 1,550 ms at RTT 30 ms**. Stage
growth from RTT 0 to RTT 30: setup 7→411, lexical 135→326 (title arm 24→326), fuse 10→75,
post_fusion 27→326, alias_fanout 9→230, anchoring 0→31, response 8→136, query facts_arm 16→192.
That is about 44 serial round trips on the critical path. Baseline, PGLite 10k search: 221-244 ms p50.

## Ranked summary (impact / effort)

| # | Item | Effort | Expected gain | Confidence | New? |
|---|------|--------|---------------|------------|------|
| 1 | Typed search: `reconcileTypeFilter` DISTINCT type statement is JIT-compiled on every typed search | S | −500 ms per typed search, Postgres with jit on; −36 ms with jit off | High (measured) | NEW |
| 2 | Typed vector arm skips the index walk and gets seq scan + external sort | M | −150 to −400 ms per typed search (PG 20k 462→~60 ms target; PGLite 10k 195→~60 ms) | Medium (cause measured, fix not built) | NEW (sizes TODOS P2s) |
| 3 | Remote Postgres: about 44 serial round trips per search (PR #6734 covers about half) | M (revise #6734) | −835 ms at 30 ms RTT (measured with #6734: 1,569→735 ms); about −20 to −30 ms at 1 ms RTT | High | Contributor PR, reproduced |
| 4 | Post-fusion reads still serial (about 10 RTT, about 300 ms at 30 ms RTT, even with #6734) | S-M | −240 ms at 30 ms RTT; 0 on PGLite | High (RTT count measured) | Filed P1, now sized |
| 5 | `cosineReScore` ships 1024-d vectors to JS; compute cosine in SQL | S | PGLite 10k −26 ms fuse (−35 ms wall); 400 pages −35 ms; PG −3 to −5 ms | High | NEW |
| 6 | PGLite keyword count runs first on the single connection, so every search waits on it | S | PGLite 10k −32 ms wall (−13%) | High | TODOS P2, now sized |
| 7 | Expression-index stats missing after `buildIndexOnline` (v240 and 9 others) | S | TODOS: 50-name batch 5.4 s→1.2 s at 55k | High (code), numbers from TODOS | TODOS P2, fix site found |
| 8 | Stale TODOs to close: JIT title arm, MCP 10k→20k cliff, #4951 | XS | n/a (bookkeeping, plus a 20k ceiling) | High | — |
| 9 | Semantic result cache is hard-off; query-embed cache has no in-flight dedupe | S | Small $ and ms on concurrent identical queries (unmeasured) | Low | NEW (minor) |
| 10 | PGLite keyword arm: per-chunk timeline `stale` subquery evaluated before LIMIT | S | −7 ms at 10k with empty timeline; more with a real timeline (unmeasured) | Low-Med | NEW (minor) |
| 11 | PR #6747 (index walk key probes): take as is | S | Contributor: PGLite federated 1.3 s→0.5 s; not reproduced (needs 2 sources) | Medium | Contributor PR |

---

## 1. Typed searches JIT-compile `SELECT DISTINCT p.type` (NEW, top item)

1. **Problem.** Every `search`/`query` with `types` first runs
   `SELECT DISTINCT p.type FROM pages p WHERE <full pageReadFilter> LIMIT 500` to drop guessed types
   (Cat 40 fix). It scans every readable page, and its estimated cost (3.54M) is far above `jit_above_cost`
   and the inline/optimize thresholds, so Postgres JIT-compiles it with LLVM on every call. It runs through
   plain `executeRaw`, outside the `jitOff` wrappers that #6039 added to the search statements.
2. **Evidence.** Postgres 20k, typed remote search: `setup` stage **542-555 ms** (untyped: 7 ms); wall
   931 ms for `types:['email']`, 701 ms for `['person']`, 189 ms untyped. The statement log shows the
   DISTINCT statement at 507-631 ms per call (`pg20k-email.log`). `EXPLAIN ANALYZE` (`dt.sql`) with jit on:
   execution 583.6 ms, of which JIT is **534.4 ms** (inlining 54, optimization 273, emission 204; 113
   functions). With jit off the same statement runs in 35.9 ms. Turning JIT off for the whole database
   brought the email-typed search from 931 to 429 ms p50 (setup 542→43 ms). An auto_explain scan of every
   statement in typed and untyped search and query found this as the **only** JIT-compiled statement on
   the search path (`pg20k-jitscan.log`). PGLite 10k: the same statement takes 7-10 ms (no JIT there).
3. **Still on master?** Yes: `src/core/ops/search.ts:264-285` (statement at :271), called from
   `:727` (search) and `:990` (query). There's no jit wrapper.
4. **Fix.** (a) Ask only about the requested types:
   `SELECT t FROM unnest($types) t WHERE EXISTS (SELECT 1 FROM pages p WHERE p.type = t AND <filter> LIMIT 1)`
   (`idx_pages_type` exists). Run the full DISTINCT list only when a type is missing, which is the rare path
   that builds the "Page types in this brain" notice. (b) Run either read through the engine's JIT-off read
   on Postgres, for example a small engine method next to `jitOffRead` (`src/core/postgres-engine.ts:371`).
   Optional: memoize the per-engine type set for a few seconds.
5. **Effort.** S (one function plus an engine helper).
6. **Impact.** −500 ms per typed search on Postgres with jit on (self-hosted PG ≤18, gbrain's own
   docker pg16, Neon/RDS if left on), and about −35 ms at 20k with jit off. This scales with page count, so
   expect more at 55k. Supabase appears to default to jit off (its pooler docs show `options=-c jit=true`
   to turn it on, unverified for every plan), and PG19 flips the default to off. Confidence: high for the
   mechanism. Unverified: whether this is the cause of the Hard run's "email-typed searches are 44% of
   search time" (TODOS P2, line 18). That run's engine and jit setting weren't checked. Items 1 and 2
   together reproduce the symptom on a synthetic brain.
7. **Gate.** Keyless: an e2e Postgres test asserting no `JIT:` block in the plan of the type probe at
   10k+ synthetic pages (the pattern of `test/e2e/jit-off-reads-postgres.test.ts`). The behavior test for
   dropped and kept types already exists (Cat 40 notice); keep it green. Bench: `audit-trace` typed run.
8. **Risk.** Low. Same keep/missing decision; the notice text only changes order when computed lazily.

## 2. Type-filtered vector arm skips the index walk; the planner seq-scans and sorts every chunk (NEW)

1. **Problem.** A `type`/`types`/date filter marks the vector statement `narrowed`, which disables the
   index walk (`src/core/search/vector-statement.ts:303-306`). The joined `hnsw_candidates` statement then
   lets the planner pick Parallel Seq Scan on `content_chunks` + external-merge Sort by distance (spills
   9 MB) + a Materialize of the type's pages re-scanned per candidate (4.3M rows removed by join filter).
   That's the same pathology #6728 fixed for the walk.
2. **Evidence.** `engine.searchVector(limit 50)` p50 (`scripts/vec.ts`):
   Postgres 20k: none 56 ms, **email 462 ms**, person 71 ms. PGLite 10k: none 58 ms, **email 195 ms**,
   person 42 ms. auto_explain of the email statement (`pg20k-email-vec.log:98-125`): 520-545 ms, Sort Method
   external merge, `Rows Removed by Join Filter: 4303954`. With `enable_seqscan=off` it's still 280 ms, so
   a planner nudge isn't enough. JIT isn't involved (the statement runs JIT-off).
3. **Still on master?** Yes (lines above; `searchVector` at `postgres-engine.ts` ~1364 and
   `pglite-engine.ts:1698`).
4. **Fix.** Let the walk serve type filters. Compute the filter's page share from `pg_stats`
   (`most_common_vals/freqs` for `pages.type`, like the existing `PAGE_SOURCE_STATS_SQL` for sources),
   multiply it into `share`, and let `indexWalkOverfetch(share)` size the window (email 30% gives about 7x).
   Keep `narrowed` only for shares below `INDEX_WALK_MIN_SCOPE_SHARE`, which keep the exact scope scan.
   Land #6747's key probes first (item 11) so the walk's page join stays bounded. Date filters can follow.
5. **Effort.** M (statement builder, stats read, tests).
6. **Impact.** About −400 ms per email-typed search on PG 20k and about −135 ms on PGLite 10k, assuming
   the walk gets typed searches to untyped speed (not built, so an estimate). Confidence: medium.
7. **Gate.** Keyless plan test like `test/search/vector-index-walk.test.ts`: a typed walk has no
   Materialize, no seq scan on `content_chunks`, and returns the same rows as the exact scan on a fixture.
   A recall check against `exactSql` on the 10k synthetic brain (recall@20 ≥ 0.98).
8. **Risk.** Medium: a type's share from stats can be wrong. If the walk comes back short it already
   falls back to the pool and exact attempts (`searchVectorPool`), so the risk is latency, not missing
   rows.

## 3. Remote Postgres: ~44 serial round trips per search (PR #6734 reproduced)

1. **Problem.** On a pooled or remote database every serial statement costs one RTT, and a search issues
   about 67 statements (Postgres 20k statement log, `pg20k-remote-search.log`). Per search: 17 single-key
   `SELECT value FROM config WHERE key=$1`, 2 whole-table config reads, and 6 BEGIN / `SET LOCAL jit=off` /
   `set_config(statement_timeout)` / COMMIT envelopes around 1-ms statements. The vector attempt is
   8 statements (read settings, set, timeout, query, restore). The title arm runs two transactions in
   sequence (about 10 RTT, 326 ms at RTT 30).
2. **Evidence.** RTT 0 → RTT 30: search 189 → 1,550 ms, query 221 → 1,690 ms (stage table above). The
   timeline of one search (`pg20k-rtt-one.log`) shows 12 serial config reads before the first arm
   (~380 ms). **PR #6734 head 55dc07cb, same harness and corpus, wrapped in `withRequestConfigSnapshot` as
   MCP dispatch does: search 1,569 → 735 ms, query 1,722 → 876 ms at RTT 30** (setup 410→33,
   alias_fanout 233→42, lexical 324→245, response 138→73, fuse 78→38; post_fusion unchanged 336→295).
   At RTT 0 there's no change (174 vs 171 ms). Without the snapshot wrapper the PR saves only
   1,569→1,230 ms, so the snapshot is most of the win. Confound: the PR is 250 commits behind master and
   was measured on its own 20k database.
3. **Still on master?** Yes: no `withRequestConfigSnapshot` on master; `withSearchJitOff` issues its own
   `SET LOCAL` (`src/core/postgres-engine/search-settings.ts:24-30`); `withVectorSettings` does
   read/set/restore (`src/core/search/vector-settings.ts:13`).
4. **Fix: the #6734 parts to take, revised in the wave PR.**
   - (Low-hanging) per-request config snapshot, `src/core/config-snapshot.ts` + `src/mcp/dispatch.ts`.
     Apply it in CLI operation dispatch too: the CLI against a remote database pays the same 13 RTT.
     About −13 RTT.
   - (Low-hanging) one `set_config` statement per search transaction (`search-settings.ts`,
     `vector-settings.ts`, `postgres-engine.ts` arms), including the nested-transaction restore fix.
     About −3 RTT per arm. Further option: pipeline the settings statement with the query (postgres.js
     pipelines queries issued without await inside `begin`), so BEGIN + settings + query + COMMIT becomes
     about 2-3 RTT.
   - (Low-hanging) concurrent response-meta reads (`buildRetrievalResponseMeta`, `ops/search.ts:449`),
     `fusion-prefetch.ts`, concurrent `resolveQueryEntities`.
   - (Low-hanging) non-blocking `mcp_request_log` insert (serve-http only).
   - (Heavy, keep separate) the saved-fact threshold moved into SQL. That's a **behavior change** (finds
     facts the 200-row cap missed: 116/116 vs 36/116 responses in the PR), so it needs a quality gate. The
     v246 trigram index **collides with master's v246** (`v246-page-embedding-budget.ts`) and adds a
     whole-table GIN index on `facts` (write amplification on every fact insert). The OR-retry gating
     commit (55dc07cb) changes keyword-arm semantics and needs its own review.
5. **Effort.** M (port about 60% of +1657/-405 onto current master, renumber, drop or split the
   behavior change).
6. **Impact.** −835 ms per search at 30 ms RTT (measured). At 1-2 ms RTT (same-region hosted) about
   −25 to −50 ms. 0 on PGLite. Confidence: high.
7. **Gate.** Keyless: `scripts/bench-refactor-wave-1.ts --backend pgbouncer` round-trip counts (already
   reports `sql_round_trips`), plus a delay-proxy A/B like this one. The PR's discrimination tests. The
   full Postgres e2e tier.
8. **Risk.** Medium. The snapshot can serve stale config inside a request; the PR scopes it and reads live
   in write operations, and that needs review of every raw-SQL config writer. Settings consolidation
   touches the #6543 `statement_timeout` budget contract (the PR keeps the literal).

## 4. Post-fusion stage reads are serial (P1 "parallel post-fusion reads"), sized

1. **Problem.** `runPostFusionStages` (`src/core/search/hybrid.ts:537-682`) awaits backlink counts,
   salience, effective dates, graph signals (2 reads), alias-resolved, and the supersede probe one after
   another. Backlink counts additionally run in a `jitOffRead` transaction (`postgres-engine.ts:1766`),
   so that's BEGIN / SET LOCAL / query / COMMIT = 4 RTT for a 0.7 ms statement. Then
   `applyIdentityBoosts` and generated-page demotion follow.
2. **Evidence.** post_fusion 27 ms at RTT 0, 326 ms at RTT 30 (about 10 RTT), and still **295 ms with
   #6734** (its prefetch covers only the three fusion reads). Statement timeline: `pg20k-rtt-one.log`
   3791-4008 ms. On PGLite post_fusion is 11-15 ms at 10k (CPU-bound; parallelism doesn't help there).
3. **Still on master?** Yes.
4. **Fix.** All the reads take the same `(pageIds/refs, policy)` inputs known on entry. Start them with
   one `Promise.all` and apply the boosts in the existing order (the floor threshold is computed once at
   entry, so read order doesn't affect math). Drop the jitOff transaction for backlink counts when the
   fanout is small, or fold `jit=off` into the same pipelined statement as in item 3.
5. **Effort.** S-M.
6. **Impact.** −240 ms at 30 ms RTT (10 RTT → 2); about −8 ms at 1 ms RTT; 0 on PGLite. Confidence:
   high.
7. **Gate.** Keyless: digest equality on `bench-refactor-wave-1.ts --phases timings` (results must not
   change); round-trip counts on the pgbouncer backend.
8. **Risk.** Low (read-only and order-preserving). It uses more pool connections per search, which
   matters at `GBRAIN_POOL_SIZE` 2-6 under concurrent searches.

## 5. Cosine re-score transfers full embeddings; compute cosine in SQL (NEW)

1. **Problem.** `cosineReScore` (`hybrid.ts:1568`, read at `:1595`) fetches every fused candidate's
   1024-float vector (`getEmbeddingsByChunkIds`, `src/core/engine-sql/chunks.ts:966-992`,
   `vector_send` + JS decode) just to compute one dot product per row. On PGLite the vector copy out of WASM
   dominates. It's on the critical path (the `fuse` stage).
2. **Evidence.** PGLite 400-page trace: this is the single most expensive statement in a search
   (41-43 ms of a 94-118 ms statement total). Micro-bench (`scripts/audit-cosine.ts`), current path vs
   `SELECT id, 1-(embedding <=> $q)`:
   PGLite 10k: 100 ids 30.1→5.1 ms, 200 ids 50.2→5.9 ms. PGLite 400 pages: 100 ids 51.6→7.6 ms.
   Postgres 20k direct: 100 ids 4.3→0.9 ms; at RTT 30, 42→34 ms. End to end, PGLite 10k search with the
   read replaced: `fuse` 29→3 ms, wall p50 244→209 ms.
3. **Still on master?** Yes.
4. **Fix.** New engine method `getCosineByChunkIds(ids, column, queryEmbedding)` returning
   `Map<id, number>` (same filters as today; cast halfvec with `::vector`). Use it in `cosineReScore` for
   both the text and image spaces. Fusion rows that came from the vector arm already carry
   `raw_score = 1 - distance`, so the read could skip them, but that isn't needed for the win.
5. **Effort.** S.
6. **Impact.** PGLite −25 to −45 ms per hybrid search (scales with candidate count, not corpus);
   Postgres −3 to −8 ms and about 400 KB less wire per search. Confidence: high.
7. **Gate.** Keyless unit test: cosine from SQL equals the JS `cosineSimilarity` within 1e-6 on fixture
   vectors. Bench digest (ties may reorder at the 1e-7 level, so compare top-k sets).
8. **Risk.** Low. pgvector and JS float accumulation can differ in the last bits, which only matters for
   exact ties.

## 6. PGLite keyword count blocks the single connection (TODOS P2 "Measure the keyword count at scale")

1. **Problem.** `startKeywordCount` (`ops/search.ts:762,775`; `search/keyword-paging.ts:148`) is started
   before the search "to run concurrently", but PGLite has one connection, so the count runs first and
   everything else queues behind it (it shows up inside `setup`: 26 ms vs 2 ms without it). The count
   statement walks `idx_chunks_page` with a tsquery filter, capped at 10,001 rows.
2. **Evidence.** PGLite 10k search: count statement 79-85 ms. Wall p50 244 → 213 ms with the count
   stubbed out (−32 ms, −13%). With item 5 as well: 189 ms. On Postgres 20k the count is 145-210 ms per
   call (auto_explain: `Index Scan using idx_chunks_page … Rows Removed by Filter: 9399`) but overlaps
   the arms, so it isn't on the critical path at RTT 0 or RTT 30. It does hold a pool connection.
3. **Still on master?** Yes.
4. **Fix.** On PGLite, start the count after the hybrid search resolves, and only when the keyword arm
   filled its page (`keyword_truncated` can't otherwise be true). Or apply the TODOS gate: skip the count
   on PGLite brains above N pages and report `keyword_total: null` with the documented degraded stage.
5. **Effort.** S.
6. **Impact.** −30 to −80 ms per PGLite `search` at 10k on common-term queries (less on real corpora with
   rarer terms). Confidence: high for the mechanism, medium for real-corpus size.
7. **Gate.** Keyless: `keyword_count_unavailable` rate and p50 on the bench (TODOS gate: under 1%,
   under 100 ms added at 55k).
8. **Risk.** Low; a count arriving later is still inside its grace deadline.

## 7. Expression-index statistics after index migrations (TODOS P2 v240), fix site found

1. **Problem.** `buildIndexOnline` (`src/core/schema-migrations/helpers.ts:83-116`) creates indexes and
   returns without ANALYZE. F4b's row-delta refresh (`src/core/planner-stats.ts`) only marks a table
   stale on row churn or when `pg_stats` has **no rows for the table** (`:111,:125`). An expression index
   (`lower(title)` in v240) gets no statistics until the next ANALYZE, and that never fires on a quiet
   brain. Postgres autovacuum doesn't analyze on index creation either.
2. **Evidence.** TODOS.md line 24: 55,838-page PGLite brain, 50-name `entity names` p50 5,378 ms → 1,200 ms
   after `ANALYZE pages` (on 09d21554, which already contains F4b af7dffc8). I didn't re-measure at 55k.
3. **Still on master?** Yes. v240 has no ANALYZE; 10 migrations use `buildIndexOnline`.
4. **Fix.** In `buildIndexOnline`, after `created`/`rebuilt`, run `ANALYZE <index.table>` (PGLite inline;
   Postgres through the reserved connection) and publish the planner watermark
   (`maybeRefreshPlannerStats(engine, 'repair', { throttle:false })` on PGLite). One-time backfill: a
   migration that ANALYZEs `pages` on PGLite for brains that already ran v240.
5. **Effort.** S. **Impact.** As TODOS (−4 s on a 50-name batch at 55k; −47 ms single name).
   Confidence: high.
6. **Gate.** Keyless plan test on an upgraded PGLite fixture: after v240, `pg_stats` has rows for
   `idx_pages_source_title_lower` and the entity-names plan uses it.
7. **Risk.** ANALYZE on a 55k-page table takes about 1 s inside the migration; that's acceptable.

## 8. Stale TODO entries (close with evidence)

- **"JIT off for the remote title arm" (TODOS :400): already done** by #6039. The title, keyword, CJK and
  vector statements all run under `withSearchJitOff` (`postgres-engine.ts:1146,1186,1336,1356,1389,1444`),
  and the statement log shows `SET LOCAL jit = off` before each `WITH top_pages`. My JIT scan found only
  item 1's statement compiling.
- **"MCP search on Postgres slows between 10k and 20k" (TODOS :322): no longer reproduces.** The 615 ms
  figure is from v0.60.53.0 (CHANGELOG :5661, 2026-10-04). Nightly scale-tier artifacts
  `scale-report-postgres-20000`: MCP search p50 74.1 ms (run 37439100525, 10-06), 45.8 (10-08), 33.7
  (10-10), **36.3 ms** (run 38708604843, 10-15; 10k: 68.4 ms). My own 20k direct run: 189 ms on a
  harder corpus. Close it and add the 20k interactive ceiling the entry asked for.
- **#4951 (stale planner stats wedge, TODOS :500): likely mitigated** by F4b, which ANALYZEs stale hot
  tables before the first planner-sensitive read (`beforePlannerRead` in `searchKeyword`/`searchVector`,
  `pglite-engine.ts:1395,1699`). Not verified against the reporter's `readAdjacencyBoosts` plan; item 7's
  gap is what remains.

## 9. Semantic query cache: off, costs nothing; one small dedupe gap (NEW, minor)

- `semanticResultCacheAvailable()` returns `false` (`src/core/search/query-cache.ts:35`), so
  `hybridSearchCached` skips the cache setup and the cache-lookup embed (`hybrid.ts:1231-1274`). The bench
  confirms `cache_statuses: ["disabled"]`, 0 `query_cache` rows. There's no extra embed and no hit rate to
  measure. Removing the dead code is cleanup, not latency.
- The exact-match in-process query-embed cache (`src/core/ai/query-embed-cache.ts`, 512 entries,
  10 min) stores only resolved vectors. Two concurrent identical queries (an agent's AND/OR prefetch, or
  `query` escalation) both call the provider. Fix: memoize the in-flight promise per key (S). Impact:
  one embed (about 100-300 ms provider time and fractions of a cent) per duplicate pair. Unmeasured.

## 10. PGLite keyword arm evaluates the `stale` subquery for every matched chunk (NEW, minor)

- `pglite-engine.ts:1490-1492` and `:1684` compute `SELECT MAX(te.created_at) FROM timeline_entries`
  per chunk in the CTE's select list, before `ORDER BY … LIMIT`, so it runs for every match. Postgres
  uses `false AS stale`. Measured PGLite 10k `searchKeyword(limit 60)` p50 78.6 → 72.0 ms with the
  subquery removed. My brains have **empty** `timeline_entries`, so real brains pay more (unmeasured).
- Fix: compute `stale` in the outer `best_per_page` select (after LIMIT). S, low risk; equivalence test
  on the existing PGLite stale-flag tests.

## 11. Contributor PR #6747 (index walk key probes, +43/-5): assessment

- **Change.** `indexWalkCandidates` joins `content_chunks` and `pages` as `CROSS JOIN LATERAL (… WHERE
  id = ann.id OFFSET 0)` probes instead of plain joins. Same filters, unused columns pruned (the
  contributor checked with EXPLAIN VERBOSE). It adds a plan test that fails without the fix.
- **Correctness risk: low.** The predicates are unchanged; one PK probe per ANN row bounds the plan by the
  window. Only the walk statement changes; the joined/exact/scope-scan statements are untouched.
- **Repro.** Not reproduced: my brains are single-source, so the walk runs with share 1 and never
  materializes. The contributor's numbers (production copy, 2 sources: vector p50 850-930 → 64-88 ms,
  17 GB → 66 MB reads per 16 searches) are credible and match the plan shape I saw on the typed path
  (item 2). **Low-hanging: take as is**, then build item 2 on top of it.

## 12. PR #6734 assessment (see item 3 for numbers)

- Low-hanging and verified to help: config snapshot (the biggest part), one-statement settings,
  concurrent response meta, fusion prefetch, concurrent entity resolve, non-blocking request log.
- Heavy or needing a decision: the saved-fact threshold behavior change, the v246 index (renumber, and
  the whole-table GIN on `facts` adds write cost), the OR-retry-inside-statement change (keyword
  semantics), and 250 commits of drift. Combine the fusion prefetch with item 5: prefetch cosines, not
  vectors.

## Other observations (no action proposed)

- PGLite 10k search wall (≈220-245 ms) is essentially the serial sum of its statements. The top ones on
  this corpus: keyword arm 61-90 ms, title arm 52-83 ms, count 80-85 ms, cosine hydration 25-37 ms.
  Items 5 + 6 measured together: 244 → 189 ms.
- `page_retrievals` INSERT on every search is fire-and-forget (`src/core/last-retrieved.ts`), but on
  PGLite it still occupies the single connection, together with the WAL checkpoint probe
  (`pg_control_checkpoint`, 8-15 ms observed in `query`). Worth a look if PGLite p95 matters.
- New pool connections each pay a `pg_type` lookup plus the handshake. At RTT 30 the first search after
  idle opened 3-5 connections at about 3-4 RTT each (`pg20k-rtt-one.log` 577-1022, 2201). The
  30-60 min max lifetime keeps that rare.
