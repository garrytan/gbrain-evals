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
