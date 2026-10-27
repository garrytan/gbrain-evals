ENG DUAL VOICES — CONSENSUS TABLE:
  Severity        anthropic/claude-opus-5-5(native) openai/gpt-6-astra(unknown)
  Critical        0                            0
  High            2                            4
  Medium          7                            5
  Low             5                            0
  Informational   0                            0
  Findings        14                           9
CONFIRMED 2 · DISAGREE 0 · NEW (outside only) 7 · native only 12. Both completed.

Reconciliation (each outside finding against the native result):
| outside | native | disposition | resolution |
|---|---|---|---|
| autoplan-20261015220653-eng-outside-1 A resolver-only attendance rejection still changes keyword weights and title-mention ranking | — | new | not raised by the native voice |
| autoplan-20261015220653-eng-outside-2 Zero and wrong-dimension vectors must retain hydration presence in the scalar cosine result | autoplan-20261015220653-eng-native-1 Item 3's parity rule (scores within 1e-6, order identical) is tighter than measured pgvector error (cosine max 1.81e-6), lean scores print at 4 significant digits and evidence flips at cosine 0.8; mapping zero-norm to NULL also changes the all-unhydrated early return | confirmed | both voices (src/core/search/hybrid.ts:1604): Item 3's parity rule (scores within 1e-6, order identical) is tighter than measured pgvector error (cosine max 1.81e-6), lean scores print at 4 significant digits and evidence flips at cosine 0.8; mapping zero-norm to NULL also changes the all-unhydrated early return |
| autoplan-20261015220653-eng-outside-3 G lacks deterministic state, compatible normalization rules and a controlled per-item baseline | — | new | not raised by the native voice |
| autoplan-20261015220653-eng-outside-4 The attendance vocabulary misses the required noun frame and the named scorer does not enforce the routing gate | — | new | not raised by the native voice |
| autoplan-20261015220653-eng-outside-5 The executeRaw jitOff wrapper can add remote latency and must compose with existing deadlines and cancellation | — | new | not raised by the native voice |
| autoplan-20261015220653-eng-outside-6 Postgres expression-statistics recovery needs a named full-table executor beyond the existing narrow search refresh | — | new | not raised by the native voice |
| autoplan-20261015220653-eng-outside-7 Integrator-only generated artifacts leave lane pregates and integration dependencies unresolved | — | new | not raised by the native voice |
| autoplan-20261015220653-eng-outside-8 G does not exercise current master's staged and retired chunk-generation visibility | autoplan-20261015220653-eng-native-6 Items 3 and 7 are specified against pre-merge predicates: getEmbeddingsByChunkIds now uses chunkVisibleFilter (generation-aware) and master rewrote the walk's join block that #6747 replaces; check:chunk-visibility fails uncovered content_chunks reads | confirmed | both voices (src/core/engine-sql/chunks.ts:1016): Items 3 and 7 are specified against pre-merge predicates: getEmbeddingsByChunkIds now uses chunkVisibleFilter (generation-aware) and master rewrote the walk's join block that #6747 replaces; check:chunk-visibility fails uncovered content_chunks reads |
| autoplan-20261015220653-eng-outside-9 Request-log drops need cross-process completeness reporting for usage-derived advice | — | new | not raised by the native voice |
| — | autoplan-20261015220653-eng-native-2 Harness G's 'only timings normalized' parity fails on unchanged code (random answer_id, rating cadence) and interleaved runs mutate shared state (feedback, page_retrievals, request log, capture), with schema skew after item 2's migration | native_only | not raised by the outside voice |
| — | autoplan-20261015220653-eng-native-3 Item 1's batched EXISTS does need JIT off (measured: cost 894,982, 577 ms JIT, 0.3 ms without), but jitOffRead is 4 serial round trips, a regression on JIT-off servers such as Supabase | native_only | not raised by the outside voice |
| — | autoplan-20261015220653-eng-native-4 Item 2's -25 to -200 ms comes from the FTS microbench and #6734's rewritten statement; with master's unchanged ORDER BY valid_from LIMIT 200 query the planner may not use the trigram index | native_only | not raised by the outside voice |
| — | autoplan-20261015220653-eng-native-5 Item 2's insert gate (p50/p95 within +25%) misses GIN pending-list merges: spikes at p99/max, PGLite has no autovacuum so searches scan the unmerged list, and fact writes arrive in batches | native_only | not raised by the outside voice |
| — | autoplan-20261015220653-eng-native-7 Item 6's Postgres recovery for present indexes has no automatic owner (maybeRefreshPlannerStats skips Postgres) and buildIndexOnline's failure hint names request-indexes repair, wrong for the facts trigram index | native_only | not raised by the outside voice |
| — | autoplan-20261015220653-eng-native-8 'No growth' on ceiling files cannot hold: items 1 and 3 add BrainEngine interface members and engine delegates and change cosineReScore; engine.ts (2822/2822) is also at its ceiling | native_only | not raised by the outside voice |
| — | autoplan-20261015220653-eng-native-9 The request-log drop counter lives in the serve process; doctor runs in another process and cannot see it, and the table feeds the admin dashboard and usage counts | native_only | not raised by the outside voice |
| — | autoplan-20261015220653-eng-native-10 Lane S's file list omits hybrid.ts, engine.ts and #6734's other files; relational-recall.ts (item 9 guard) has no owner; item 2's planner gate depends on lane M's item 6 | native_only | not raised by the outside voice |
| — | autoplan-20261015220653-eng-native-11 The item 5 lateness rule cannot trigger because item 5 is last in lane S | native_only | not raised by the outside voice |
| — | autoplan-20261015220653-eng-native-12 Item 3's JS fallback on SQL failure is silent, so a permanently failing statement removes the gain unnoticed | native_only | not raised by the outside voice |
| — | autoplan-20261015220653-eng-native-13 Item 9's broad-verb guard belongs in resolveSeedScoped, which hardcodes ['meeting','event']; false routes already yield an empty relational list, so negatives should assert final results equal master | native_only | not raised by the outside voice |
| — | autoplan-20261015220653-eng-native-14 Item 6's ANALYZE time during upgrades is not in the PR's operational-changes list and PGLite's buildIndexOnline branch prints no progress | native_only | not raised by the outside voice |
