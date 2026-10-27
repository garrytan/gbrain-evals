## Review record

(filled by autoplan)

### gstack-autoplan run log (run autoplan-20261015220653, session_kind unattended, status complete)

Host: gstack-autoplan. Scope: UI no (1 matches); DX yes (8 term matches, agent primary). Phase order: ceo → dx → eng.
Deviation: autoplan guard: not enforced by this host; publication order is unverified (GUARD_NOT_INSTALLED)

#### ceo: closed 2026-10-15T23:04:29.778Z; snapshot 2ea3b35280d7f37a6d2ac5843bc6089f3c3ac7b02ffd288e073cbb190c36810c

- native completed (model anthropic/claude-opus-5-5, provider host-subagent, 11 findings, sha256 320b445a8f71)
- outside completed (model openai/gpt-6-astra, provider unknown, 4 findings, sha256 75e4efd1e6fe)

```
CEO DUAL VOICES — CONSENSUS TABLE:
  Severity        anthropic/claude-opus-5-5(native) openai/gpt-6-astra(unknown)
  Critical        0                            0
  High            2                            2
  Medium          3                            2
  Low             6                            0
  Informational   0                            0
  Findings        11                           4
CONFIRMED 1 · DISAGREE 0 · NEW (outside only) 3 · native only 10. Both completed.

Reconciliation (each outside finding against the native result):
| outside | native | disposition | resolution |
|---|---|---|---|
| autoplan-20261015220653-ceo-outside-1 Attendance scope caps firing at 76%, and the named scorer counts false edges rather than false routes | — | new | not raised by the native voice |
| autoplan-20261015220653-ceo-outside-2 SQL cosine must preserve hydration presence, not collapse zero and wrong-dimension vectors into missing rows | autoplan-20261015220653-ceo-native-3 Item 3's byte-parity rule doesn't fit float math: pgvector accumulates in float32 and JS in float64, lean rows print scores at 4 significant digits, and high_vector_match is a threshold at cosine 0.8; mapping zero-norm vectors to NULL also changes the all-unhydrated early return | confirmed | both voices (src/core/search/hybrid.ts:1604): Item 3's byte-parity rule doesn't fit float math: pgvector accumulates in float32 and JS in float64, lean rows print scores at 4 significant digits, and high_vector_match is a threshold at cosine 0.8; mapping zero-norm vectors to NULL also changes the all-unhydrated early return |
| autoplan-20261015220653-ceo-outside-3 The parity and per-item performance gates lack an explicit controlled baseline | — | new | not raised by the native voice |
| autoplan-20261015220653-ceo-outside-4 The promised automatic Postgres expression-statistics backfill has no specified execution path | — | new | not raised by the native voice |
| — | autoplan-20261015220653-ceo-native-1 The plan is written against 3c16e9ba, but master is now 7f3c9f5f (v0.60.252.0, 109 commits of segmented storage) and changes the predicates items 3 and 7 must match | native_only | not raised by the outside voice |
| — | autoplan-20261015220653-ceo-native-2 Item G's 'only timings normalized' rule will report differences on unchanged code: a random answer_id per call, a per-client how_to_rate cadence, implicit cited-feedback learning, and a behavior-change disclosure that differs between master and the wave | native_only | not raised by the outside voice |
| — | autoplan-20261015220653-ceo-native-4 Item 1's JIT-off wrapper turns the type check into BEGIN, SET LOCAL, query, COMMIT (4 round trips), a regression on remote databases already running with JIT off | native_only | not raised by the outside voice |
| — | autoplan-20261015220653-ceo-native-5 Item 9's gating split is circular: the lexicon adds exactly that split's three wordings, so 80% firing is near-certain, while the 30 held-out paraphrases have no pass bar | native_only | not raised by the outside voice |
| — | autoplan-20261015220653-ceo-native-6 The lateness rule for item 5 can't trigger as worded: item 5 is last in lane S, so 'when the other items are' ready, it has not started | native_only | not raised by the outside voice |
| — | autoplan-20261015220653-ceo-native-7 Lane S's planned-file list leaves out files its items must change: hybrid.ts (cosineReScore), engine.ts (the BrainEngine interface for executeRaw jitOff and the new method), files #6734 touched (alias-fanout.ts, mentions/policy.ts, engine-sql/titles.ts and others); relational-recall.ts (the item 9 guard) belongs to neither lane | native_only | not raised by the outside voice |
| — | autoplan-20261015220653-ceo-native-8 'No growth' on files at their size ceiling conflicts with items 1 and 3, which need engine members or signature changes in both engines (postgres-engine.ts is exactly at its 3,060-line ceiling) | native_only | not raised by the outside voice |
| — | autoplan-20261015220653-ceo-native-9 Item 6's new expression-index staleness probe must not add a statement to every search on remote Postgres | native_only | not raised by the outside voice |
| — | autoplan-20261015220653-ceo-native-10 The PR's operational changes list leaves out item 6's ANALYZE time during migrations; under the contract an omitted change found in review is Critical | native_only | not raised by the outside voice |
| — | autoplan-20261015220653-ceo-native-11 Item 9's meeting/event guard hardcodes type names ('meeting', 'event' in titleSeedTypes), so brains whose schema pack aliases meeting types are blocked | native_only | not raised by the outside voice |
```

#### design: skipped (no UI scope detected)

#### dx: closed 2026-10-15T23:10:04.944Z; snapshot 2ea3b35280d7f37a6d2ac5843bc6089f3c3ac7b02ffd288e073cbb190c36810c

- native completed (model anthropic/claude-opus-5-5, provider host-subagent, 9 findings, sha256 8e43e6684477)
- outside completed (model openai/gpt-6-astra, provider unknown, 4 findings, sha256 56173781eaf2)

```
DX DUAL VOICES — CONSENSUS TABLE:
  Severity        anthropic/claude-opus-5-5(native) openai/gpt-6-astra(unknown)
  Critical        0                            0
  High            0                            1
  Medium          5                            3
  Low             4                            0
  Informational   0                            0
  Findings        9                            4
CONFIRMED 0 · DISAGREE 0 · NEW (outside only) 4 · native only 9. Both completed.

Reconciliation (each outside finding against the native result):
| outside | native | disposition | resolution |
|---|---|---|---|
| autoplan-20261015220653-dx-outside-1 The remote parity gate fails unchanged executions unless state and opaque outputs are controlled | — | new | not raised by the native voice |
| autoplan-20261015220653-dx-outside-2 The online-index helper sends a failed facts-index build to a request-only repair command | — | new | not raised by the native voice |
| autoplan-20261015220653-dx-outside-3 A bounded request-log queue needs cross-process completeness reporting for its usage-derived advice | — | new | not raised by the native voice |
| autoplan-20261015220653-dx-outside-4 Already-present Postgres expression indexes have no specified automatic statistics-recovery owner | — | new | not raised by the native voice |
| — | autoplan-20261015220653-dx-native-1 Item 5's request-log drop counter is 'reported by doctor', but gbrain doctor runs in a different process from gbrain serve --http and can't see an in-memory counter | native_only | not raised by the outside voice |
| — | autoplan-20261015220653-dx-native-2 Item 5 makes request-log rows droppable with no opt-out, though the admin dashboard, per-client usage and last_used_at read mcp_request_log | native_only | not raised by the outside voice |
| — | autoplan-20261015220653-dx-native-3 Item 6's new staleness reason would print through the existing message as '<table> (0 rows changed since ANALYZE, threshold N)' and blame autovacuum on Postgres, which contradicts itself | native_only | not raised by the outside voice |
| — | autoplan-20261015220653-dx-native-4 PGLite upgrades build item 2's trigram GIN and run item 6's ANALYZE with no progress line, because buildIndexOnline's PGLite branch prints nothing | native_only | not raised by the outside voice |
| — | autoplan-20261015220653-dx-native-5 The plan has no documentation work beyond item 9's notice row, and the item G parity harness it relies on is undocumented and named after refactor wave 1 | native_only | not raised by the outside voice |
| — | autoplan-20261015220653-dx-native-6 Item 3's fallback to the JS cosine path on SQL failure is silent, so a permanently failing statement removes the gain with no signal | native_only | not raised by the outside voice |
| — | autoplan-20261015220653-dx-native-7 Item 9's BEHAVIOR_CHANGES row doesn't name the way back if a new phrasing misroutes, though both switches already exist | native_only | not raised by the outside voice |
| — | autoplan-20261015220653-dx-native-8 The PR body's operational changes leave out item 2's fact-insert cost (gate allows up to +25%) and item 6's ANALYZE time during migrations, and the contract makes an omission Critical at review | native_only | not raised by the outside voice |
| — | autoplan-20261015220653-dx-native-9 `--rtt-ms` adds a second latency injector and flag name next to the existing toxiproxy harness and `--rtt` in scripts/bench | native_only | not raised by the outside voice |
```

#### eng: closed 2026-10-15T23:22:13.694Z; snapshot 2ea3b35280d7f37a6d2ac5843bc6089f3c3ac7b02ffd288e073cbb190c36810c

- native completed (model anthropic/claude-opus-5-5, provider host-subagent, 14 findings, sha256 c50bb7de728b)
- outside completed (model openai/gpt-6-astra, provider unknown, 9 findings, sha256 c23720da2dd8)

```
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
```

Reopened ceo at gate_rev 1: revise v1 (2026-10-15T22:56:58.019Z)
Reopened dx at gate_rev 1: revise v1 (2026-10-15T22:56:58.019Z)
Reopened eng at gate_rev 1: revise v1 (2026-10-15T22:56:58.020Z)

Gate: gate_rev 2, 9 decisions (8 pending); answered "all" answered by human. Findings: 51. Tasks: 10.
