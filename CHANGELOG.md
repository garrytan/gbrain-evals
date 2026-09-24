# Changelog

This records what each gbrain-evals release changed and what its measurements meant at the time. Versions follow `VERSION` and `package.json`. Historical scores keep their original dates; later corrections do not turn them into measurements of today's code.

## [0.9.0] - 2026-09-23

Engineers can now test whether situation cues help retrieve the original notes
needed by an indirectly worded question, and inspect the evidence required to
reject a regression. This release adds the
[evaluation protocol and harness](docs/benchmarks/2026-09-23-situation-recall-protocol.md),
not a measured retrieval gain. No paid comparison or all-category no-regression
result is published here.

### Added

- Cat36 Associative Retrieval: 120 fictional scenario families across five
  domains, with 160 development and 320 holdout probes. Its primary metric
  requires all labeled source spans in the five actual production chunks,
  rather than crediting a correct page with the wrong passage.
- Production cue-build receipts, frozen-index Scene/Horizon read-time
  comparisons, separate Bridge construction, and a real contextual-summary
  control. Deterministic provider stubs remain nonpublishable plumbing checks.
- A complete category inventory and paired release gate covering native metric
  denominators, floors, slices, source identity, execution observations and
  critical case losses. Missing, partial, stale or unsupported cells block release.
- Explicit programmatic category drivers, a native Cat13b pilot, source and
  reminder replays, and separate answer-grounding replays that retain original
  outputs and judge attempts. The LongMemEval secondary check is not official
  answer accuracy.
- OpenRouter development controls with fixed model routes, local request and
  reservation limits, and fsynced, sanitized request/response evidence. A closed
  source-only policy separates construction from embedding-only replay; it is
  preparatory infrastructure, not a new dataset or measured capability result.
  Operator-controlled diagnostics remain nonpublishable and do not claim an
  external provider credit cap.
- A separately registered v2 source-only policy for the v4 source-reference
  formatter. It checks the actual installed formatter's canonical wire content
  without treating internal excerpt metadata as a public request shape. The
  historical v1/v3 contract and all financial and output ceilings remain intact.

### Changed

- Pin the candidate product to `939232f1746381b4e932d620d6c709e29198f14c`
  (gbrain v0.55.0.0), while keeping the historical dependency and fresh baseline
  identities distinct. CI uses supported Bun 1.3.13.
- Retain previously omitted native per-item observations without changing
  benchmark inputs, scoring formulas or published historical artifacts.
- Add opt-in LongMemEval evidence capture and isolated HOME/configuration paths,
  with exact loaded-code, model, source and build identities.

### Fixed

- Keep the existing keyword and identity fixtures readable through current,
  revision-bound projections while preserving their original text and labels.
- Distinguish a valid zero-score judge control from an unavailable judge, and
  update tool-bridge test fixtures for atomic page snapshots without relaxing
  their behavior assertions.
- Preserve malformed or over-budget raw responses and existing LongMemEval
  receipts on rejected capture, score legitimate bounded search misses, and
  verify the product's actual configuration-file resolver.

### Not yet measured

For publishable comparisons, independent corpus and recipe review, real input
catalogs, supported transport and protocol coverage, enforced external provider
allowances, and complete live B/C0/C1 receipts remain prerequisites. The cue
builder's durable cap does not create a whole-cell spending limit. Unattributable
traversal results and other missing evidence remain blocked; hermetic checks do
not prove semantic quality, privacy, reminder precision or release readiness.

## [0.8.0] - 2026-09-09

Engineers can now choose a retrieval configuration by the questions they need to
answer. The rewritten guides explain word search, vectors, relationships, and
ranking through concrete cases. The [retrieval refresh](docs/benchmarks/2026-09-09-retrieval-refresh.md)
publishes all eleven planned experiment cells, including losses and the settings
that produced them.

### Added

- Three reading paths: [understand retrieval](docs/retrieval-lessons.md),
  [choose settings](docs/settings.md), and [inspect the research](docs/README.md).
- A controlled production relationship comparison with shared indexes and query
  vectors. It improved recall on 15 of 145 questions in each of three ingestion
  orders, with no recall losses; attendance questions did not improve.
- Complete concept, source-preference, baseline, and PrecisionMemBench results,
  with per-question rankings, paired comparisons, charts, and API accounting.
  Recorded usage estimates total $0.7133 before credits, within the $1,000 ceiling.
- Reproduction and verification scripts, explicit configuration records, and
  regression tests for result order, failed features, shared evidence, and spending limits.

### Changed

- Rewrote all 42 authored documents, including 18 historical reports, in plain
  English. Preserved benchmark inputs, generated evidence, tested prompts,
  historical measurements, and the gbrain dependency pin.
- Separated finding evidence from answering correctly. The September 6
  LongMemEval records support recounting retrieval and saved judgments; omitted
  answer text prevents independent re-judging.
- Dated external comparisons, corrected stale configuration and cache guidance,
  and linked adoption recommendations to their workloads and evidence.

### Fixed

- Hybrid adapters preserve gbrain's final order and keep the first occurrence
  of each page, so they no longer undo reranking or deliberate relationship placement.
- Failed searches produce valid diagnostic receipts. Offline publication checks
  reject incomplete relationship comparisons and can follow saved report paths
  after the repository moves to another checkout.

## [0.7.0] - 2026-09-06

The [ranking experiment](docs/benchmarks/2026-09-06-longmemeval-ranker-wave.md) showed that preserving additional evidence helped multi-part conversation questions. The release default reached **95.53% strict recall_all@5 (449/470)**, compared with **80.64%** for the previous default. The result-cutoff step had been dropping a second required session.

The first judged answer-quality run scored **86.6% (433/500)**. That is a different measure from finding the evidence, and this release made no cross-system answer-quality claim.

Two other changes addressed specific ranking failures: the metadata boost gate improved Cat13 held-out nDCG@5 from **53.0 to 57.8**, and preserving graph-derived relational results through reranking improved NamedThingBench hit@1 from **3/39 to 21/39**. Expansion-weight budgeting and keyword-arm confidence did not satisfy their decision rules and did not become defaults.

### Evidence and configuration

- Added compacted per-question results for eight LongMemEval arms and the judged run, cutoff replays, miss diagnostics, Cat13 E0/E2/E3 results, NamedThingBench R1 results, aggregate JSON and two SVG charts.
- Added a converter from the gbrain harness's NDJSON into the chart runner's `RunnerOutput` format.
- Updated both dependency files to the ranking release. The installed pin became merge commit `2efaaf8f`, gbrain v0.48.4.0. Updating only `package.json` had previously left frozen installation broken and local runs on v0.48.2.0.
- Cat13 receipts now identify the resolved `balanced` bundle and explicit overrides. They expose whether two nominally similar runs inherited different defaults.
- E1 localization and Cat27 graph-signal comparisons explicitly select `search.metadata_boost_gate=always` when testing the old, ungated behavior. The E1 live result records `gate_always` so its replay can be checked.

### Cat13 runner improvements

All adapters now use the selected embedding model and dimensions. Flags override `CAT13_EMBEDDING_MODEL` and `CAT13_EMBED_DIMS`; defaults remain `openai:text-embedding-3-large` at 1536 dimensions. Receipts record the gateway state after each adapter initializes, and mismatched settings invalidate the run.

The gbrain-backed adapters accept explicit reranker and autocut flags, both off by default in this runner. Reranker-on selects `voyage:rerank-2.5`, requires a Voyage key, rejects fake embeddings, and must produce observed reranker scores. Expansion budgeting, keyword-arm confidence and generic `--search-pin KEY=VALUE` support controlled comparisons. Unknown CLI flags are rejected.

The concept split defaults to 20 tuning concepts and 10 held-out concepts, seed 42. Scores and per-template results are reported separately; questions spanning both sets stay in the overall result but not either subset. See the [Cat13 recipe](eval/runner/README-cat13-phase-e0.md).

### Test reliability

A process-global embedding transport could be reset by another test, causing a supposedly hermetic run to call a live provider. The runner now reinstalls its transport and verifies it before ingestion and queries.

PGLite's roughly 1 GB WASM allocation also delayed garbage collection. Tests accumulated 1–2 GB of temporary objects and more than 50,000 memory mappings, approaching the default kernel limit of 65,530. Collection is paced every 40 imported pages, every 25 queries and after teardown. Full-suite peak mappings fell from about 55,000 to 16,000 without changing assertions.

## [0.6.1] - 2026-09-02

A fresh [LongMemEval-S comparison](docs/benchmarks/2026-05-07-longmemeval-s.md) measured gbrain v0.48.2.0 on the cleaned September 2025 dataset. Each arm scored 470 answerable questions at k=5 in one run, with zero errors.

| Arm | Strict recall_all@5 | Questions |
|---|---|---|
| Hybrid | 93.19% | 438/470 |
| Hybrid with reranking | 95.32% | 448/470 |
| Hybrid with session diversity | 93.40% | 439/470 |
| Session diversity plus reranking | 95.53% | 449/470 |
| Hybrid with query expansion | 54.89% | 258/470 |

The reranker gained 18 questions and lost 8 compared with hybrid. Its any-hit score was 99.79%. Temporal-reasoning recall rose from 84.3% to 89.8% (107 to 114 of 127), the knowledge-update and three single-session types reached 100%, and multi-session recall stayed at 92.6% (112/121).

Session diversity added one question without reranking. Expansion lost 183 and gained 3; its earlier v0.48.0.0 measurement was 49.6%. More alternative phrasings did not help at this five-result limit.

### Reproducibility and comparisons

The dependency moved to `5cfb84f1`, the v0.48.2.0 PR #4792 head, pending its merge pin. Reranker specifications explicitly selected `voyage:rerank-2.5` and derived the required `VOYAGE_API_KEY` from that model choice.

The 93.19% hybrid result matched the v0.48.0.0 receipt and could be compared with the May 83.40% result. A pre-fix run at `2a56b512` recorded 51.39%. All five arms and the pre-fix stream were committed with artifact hashes, an aggregate and regenerated charts.

The charts separated strict recall from any-hit and answer accuracy. Their contextual comparisons used our recomputation of MemPalace's strict scores, 85.7% raw and 90.0% with LLM reranking, and ContextFit's self-reported 87.45% with its label-leakage qualification.

### Compatibility fixes

- Reconciled `package.json`, previously 0.5.1, with `VERSION` at 0.6.1.
- Updated graph traversal contract tests for gbrain #4704's bidirectional `GraphPath[]` result shape. Tests retained the depth-10 cap, explicit depth and depth-2 default checks.
- Cat15 reads `PROPOSE_TAKES_PROMPT_VERSION` from gbrain instead of a stale literal. The prompt text also changed in gbrain #4736, so the old Cat15 F1 result required a live remeasurement.

## [0.6.0] - 2026-09-01

Outside reviews #26 and #24 prompted stronger links between claims and saved results. The review's sub-claim about PR #13 containing benchmark figures was refuted.

### Saved evidence

- Committed the May LongMemEval stream: 2,696 rows, hash `a26453…3d0b`. An offline regression test recalculates all four adapters' summaries and per-type results. The previously referenced but missing NDJSON validator was added.
- Added `docs/receipts-manifest.json`, which maps selected claims to artifact hashes and expected values or explicit gaps. The declared gaps were SkillOpt, relational recall and the stability snapshot.
- Committed the June Cat34 originals and a dated offline rerun at `2a56b512`: know-to-ask failures 0/149 and push recall 0.9063 / 1.000 / 0.5521. The report disclosed that it relies on counters reported by the system under test and preserved historical charts.
- Cat35 receipts began recording server-reported model IDs and call counts. Cross-run deltas require matching resolved models; `claude-sonnet-4-6` remained a movable alias rather than a dated snapshot.

### Session-level diagnostics

The May top-five chunk lists averaged 2.68 distinct sessions, with 99.6% containing fewer than five distinct sessions. This motivated explicit session-diversity adapters, including expansion and reranker variants. It did not itself prove diversity would improve accuracy. Existing adapters retained their behavior, rows gained a `run_config_hash`, and aggregation rejected mixed configurations.

### Clearer claims

The comparison guide identified MemPalace's 96.6% as any-hit recall and labeled the then-quoted 97.66% gbrain comparison accordingly. ContextFit's 84.3% token-plus-certificates and 87.45% fused strict scores were separated from gbrain's May 83.40% / 84.26%. LETHE, Memoria, Mem0 and a PrecisionMemBench comparison were added with sources.

PrecisionMemBench's 0.582 became an explicitly qualified upper bound and the default was corrected to 0.075. Cat35's “zero junk leakage” became 1.2% (1/86), Cat34's 0.552 Codex integration result was included, and the historical relational 97.9% / 49.1% result gained a pre-audit qualification.

CI stopped swallowing typechecker crashes. Phase 2 smoke arguments were changed to an array.

## [0.5.1] - 2026-08-31

The May LongMemEval scoring error was corrected at $0 by rescoring the saved output. The same returned and expected sessions produced:

| Adapter | Strict recall_all@5 |
|---|---|
| Keyword | 10.64% |
| Vector | 79.36% |
| Hybrid | 83.40% |
| Hybrid with expansion | 84.26% |

There were 470 scored questions; 30 abstention questions were excluded. Hybrid multi-session recall was 71.9% and temporal-reasoning recall 69.3%. Knowledge-update also lost credit on one question requiring multiple sessions.

The old score reconciled exactly: 459 answerable any-hits plus 29 abstention any-hits gave 488/500 = 97.60%. All 500 reference answer sets matched the dataset, there were no error rows, and 696 resume duplicates were removed with successful rows preferred. Saved summaries are `rescore-may-2026-08-31.json` and its generated Markdown companion.

Under strict scoring, expansion added four questions, or 0.85 percentage points overall, and 3.9 points on temporal reasoning. The earlier “no effect” conclusion came from an almost saturated any-hit metric.

Reproduction examples were corrected: `--path` takes the file path, `--dataset` the split name, and the runner defaults to k=8. A published k=5 comparison must select it explicitly. A fresh run of newer gbrain code remained separate work at this release.

## [0.5.0] - 2026-08-31

**Scoring definitions changed. Earlier scores cannot be compared directly with post-audit runs.** The [audit](docs/audit/2026-08-31-eval-audit.md) verified 237 findings and drove these changes:

- Recall counts unique IDs; precision@k divides by k. LongMemEval uses all-required-session recall. Model judges must return every required criterion at temperature 0.
- Common receipts distinguish success, failure, skip and error origin. The category runner reads receipts instead of interpreting every zero exit as success. System failures remain scored misses; excessive harness failures invalidate a run at the stated greater-than-10% limit.
- Fixed Cat13/Cat13b gateway setup, asynchronous link extraction, LongMemEval imports and 17 runners' version stamps. The gbrain dependency and lockfile were pinned.
- About 12 tests that could not previously fail gained reachable failure conditions, feature boundaries and negative controls. Judges were blinded where needed. Unintended reranking was removed from embedder comparisons.
- Repaired source-data references, an overwritten synthetic deal page and the q11 answer label with a recorded rationale. Baseline latency capture became serial; the old concurrent measurements were about ten times too high.
- Added offline CI checks for types, tests, data integrity, selected end-to-end runners and the qrels/baseline comparison.
- SkillOpt held-out tasks gained different, stricter judging criteria. Earlier held-out scores tested topic transfer but reused training criteria.
- Wrapper scripts now propagate failed categories. The LongMemEval batch script respects the dataset and its size. Shootout scripts check each cell, and Phase 1 has a wall-clock limit. The prior environment-expansion bug had silently killed four of seven cells.

Releases 0.3.0 and 0.4.0 landed during remediation. The final pin was v0.47.8.0 (`2a56b512`), six commits after the audited v0.47.6.0 code. The remediated suite was rechecked against it.

## [0.4.0] - 2026-08-31

The [Cat35 report](docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill.md) added before-and-after runs around gbrain's write-path fixes in [PR #4742](https://github.com/garrytan/gbrain/pull/4742). They used the same corpus, judge model and prompt version.

Dream-lane retention reached **88.1%**, with a 95% interval of **82.0–93.5**, compared with 61.5% in the original publication and 70.2% immediately before the change. All 20 expected sessions produced pages, up from 16. The four recovered sessions used verified quoted segments despite falling below the ordinary triage threshold; routine controls did not trigger the rescue.

Quote fidelity reached 82.7% from 45.4%, claim hallucination fell to 7.0% from 14.1%, and facts-lane recall reached 64.8%. Adding an idea category improved idea recall from 38.3% to 50.0%. Both new receipts were preserved alongside the original, with qualifications about single-run judge variation, changed quote denominators and a distractor judgment changing.

The [Cat34 update](docs/benchmarks/2026-06-12-brainbench-memory.md) recorded know-to-ask failure falling from 0.150 to 0.000 on all three integrations after gbrain v0.46.15.0. False fires were 0.000, push recall 0.906 / 1.000 / 0.552, and precision 1.000.

The dependency advanced to `2a56b512`, v0.47.8.0. The PGLite teardown freeze no longer reproduced there; six skipped test teardowns were restored after watchdog-protected verification.

## [0.3.0] - 2026-08-27

Added Cat35 to measure what survives when a working conversation becomes memory: facts, ideas, decisions, entities and emotional context.

The [first publication](docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill.md) measured **61.5% retained content** (95% interval 45.0–77.6), 85% usability, zero distractor leakage and 14.1% hallucinated claims. The verbatim control measured 93.1% judged coverage, 100% leakage after the case-insensitive correction, and 0% usability. Emotional-context recall was 71.4% versus 52.5% for facts; the separate facts extractor scored 69% on facts and 38% on ideas.

The committed corpus contains 24 fictional sessions, six scenarios, 173 important content units with verbatim anchors, 86 distractors and two attribution hazards. Its skeleton is deterministic; its prose came from cached Opus generation.

The runner defaults to a small paid setup check, historically about $0.10. The full package command selects `CAT35_FULL` and performs a cost preflight. Receipts include comparison deltas, triage thresholds and a judge-calibration scaffold.

Review added case-insensitive anchor checks, full-corpus publication requirements, evidence-backed judge verdicts, explicit judge-failure handling and transcript hash validation. The leakage correction changed the verbatim floor from 96.5% to 100%; dream remained 0%.

The dependency was pinned to gbrain v0.46.3.0, installation gained the PGLite path repair, and category-runner/tool-bridge tests were fixed. The Bun teardown freeze was temporarily worked around and tracked upstream.

## [0.2.0] - 2026-05-29

Integrated [PrecisionMemBench](https://github.com/tenurehq/precisionmembench), using tenurehq's MIT fixtures and scorer at `c9689ca`. The test separates how much relevant material search returns from whether a later model writes a good answer.

The initial default hybrid score was reported as **0.076 precision**, with recall 0.99. Returning many pages made recall high but precision low. Later documentation reconciled the default to its saved value, 0.0752.

That experiment led to optional adaptive result limits. The historical tight setting scored **0.582 precision, 29 active passes and 44/77 overall cases**, compared with the cited supermemory row of 0.43 and 17 active passes at roughly three times the latency. These comparisons describe that recorded setup; subsequent adapter corrections required remeasurement.

A proposed score-gap detector did not separate right from wrong first results: the rank-one/rank-two gap was 0.60 for correct results and 0.57 for incorrect ones. Restricting result count accounted for the useful improvement in this experiment.

The report distinguished the 35-belief lexical corpus, harness-computed structural cases and the think adapter's citation-based view from ordinary search. Adaptive behavior stayed off by default pending a recall comparison. The then-promoted LongMemEval 97.60% number used the old any-hit metric; release 0.5.1 later corrected its interpretation.

Added the external fixtures, scorer, adapters, seed code, attribution, four-mode runner, instrumentation and tests. The adaptive option initially needed a local unreleased gbrain checkout.

Saved JSONs were added for the tight result and ordinary settings. One shipped-default adaptive row was reconciled to its actual run: 0.16 precision, one active pass and 8/77 cases. The scorer's type import was corrected to its local layout, the gold-schema test excluded unrelated subset files, and the fictional v0.41-launch baseline/qrels work was included.

## [0.1.0] - prior

Initial BrainBench included world-v1 and amara-life-v1, the 12-category catalog, LongMemEval-S integration and the v0.40.6.0 snapshot. Its historical 97.60% LongMemEval figure was compared with MemPalace's 96.6% raw figure; subsequent releases clarified the metric and comparison limits. See the dated reports for the original experiments.
