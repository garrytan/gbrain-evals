# The eval-suite audit — 2026-08-31

Every part of this repo's eval suite was audited for bugs, then remediated.
This page is the deliverable: what was found, what was fixed, what was
deferred, and what the numbers mean now. The machine-readable findings with
per-finding evidence, line numbers, and adversarial-verification verdicts
live next to this file in [`2026-08-31-findings.json`](2026-08-31-findings.json).

## How the audit ran

A 35-agent workflow: 17 subsystem auditors (one per area — shared scoring
infra, every cat runner family, LongMemEval, PrecisionMemBench, generators,
adapters, shell scripts, committed data, the test suite itself, and the
published docs), each finding then adversarially re-verified by an
independent agent instructed to refute it against the actual code and the
pinned gbrain v0.47.6.0 source, plus a completeness critic that swept for
coverage gaps. Two outside-model (Codex) review rounds hardened the
remediation plan.

**Result: 237 confirmed findings, 2 refuted (239 total):**

| Class | Count |
|---|---|
| Critical bugs (scores wrong / eval measures nothing / crashes) | 17 |
| Major bugs (misleading metrics, silent skips, integrity leaks) | 95 |
| Minor bugs | 81 |
| Improvements (eval-design upgrades) | 44 |
| Refuted in verification | 2 |

## The headline problems, in plain terms

1. **The flagship LongMemEval number used the wrong metric.** Our runner
   scored a question as recalled if ANY of its ground-truth sessions was in
   the top-5; the official benchmark requires ALL of them. The published
   97.60% head-to-head against systems reporting the official metric was
   not apples-to-apples. An erratum is published in the report; the runner
   now computes `recall_all@5`; re-measurement is tracked in TODOS.md.
2. **The shared metric helpers were wrong for everyone.** Recall could
   exceed 1.0 (duplicate chunk rows double-counted), precision divided by
   the returned-list length instead of k (rewarding adapters that return
   less), and the LLM judge silently renormalized over whichever rubric
   criteria it happened to return.
3. **Four runners crashed outright** against the pinned gbrain, having
   drifted from its API while the dependency floated on `#master` — and
   roughly a dozen evals structurally could not fail: fixtures that did not
   exist counted as pass, A/B knobs set under config keys nothing read,
   corpora smaller than K, gates that printed but never affected exit codes.
4. **Confounded comparisons.** gbrain's default search mode silently enables
   a reranker when an unrelated env var is set, so "embedder-only" A/B cells
   were quietly reranked; the shootout shell script's env-prefix expansion
   bug killed 4 of 7 cells with exit 127 while printing "done".

## What changed (BrainBench v0.4.0 — scores not comparable to v0.3.x/v0.2.x)

- **Contracts:** every runner writes a validated receipt
  (`run_status` / `verdict` / typed `failure_origin`); the umbrella runner
  aggregates receipts, not exit codes; skipped never counts as pass. One
  scoring policy: system-under-test failures score as misses, harness
  errors are excluded but capped (>10% invalidates the run).
- **One metrics module** (`eval/runner/metrics.ts`) with the standard
  denominators, replacing seven divergent local implementations; the
  official `recall_all@k`; judge rubric-coverage enforcement at temperature 0.
- **Every previously-unfailable eval got a reachable fail state**, a
  feature-boundary header (what is under test vs legitimately stubbed), and
  a negative control (a deliberately degraded configuration must score
  ≤ 0.5x the real one).
- **Data integrity is now a gate** (`eval/runner/validate-data.ts`, run in
  CI): the audit's manual cross-checks — dangling wikilinks, manifest
  overcounts, unreachable qrels labels — are permanent checks. The
  synthetic corpus was regenerated (every person→company link had been
  dangling); one qrels label was corrected by documented adjudication.
- **Hermetic CI on every PR**: typecheck, the unit suite, data validation,
  a keyword-only retrieval-regression gate, and five real end-to-end
  runners — all keyless, all receipt-checked.

## Finding status

Every confirmed finding ends in exactly one state — `fixed`,
`deferred` (with a TODOS.md entry), or `rejected` (with a reason recorded in
the findings JSON). No finding silently disappears. The per-finding status
table is generated from the findings JSON:

| Unit | Findings | Fixed | Deferred | Refuted |
|---|---|---|---|---|
| shared-infra | 12 | 12 | 0 | 0 |
| adapters-queries | 9 | 9 | 0 | 0 |
| orchestrators | 19 | 19 | 0 | 0 |
| longmemeval | 13 | 13 | 0 | 0 |
| agentic-cats | 19 | 19 | 0 | 0 |
| retrieval-cats | 18 | 18 | 0 | 0 |
| calibration-cats | 14 | 14 | 0 | 0 |
| cats18-21 | 18 | 18 | 0 | 0 |
| cats22-25 | 12 | 12 | 0 | 0 |
| cats26-29 | 18 | 17 | 0 | 1 |
| skillopt-cats | 11 | 10 | 1 | 0 |
| precisionmembench | 7 | 6 | 0 | 1 |
| generators | 19 | 19 | 0 | 0 |
| misc-runners | 14 | 14 | 0 | 0 |
| data-integrity | 13 | 13 | 0 | 0 |
| tests-audit | 8 | 8 | 0 | 0 |
| docs-vs-code | 15 | 15 | 0 | 0 |
| **total** | **239** | **236** | **1** | **2** |

Deferred items (each carries a TODOS.md entry):
- `skillopt-cats-11` — cat30-33's deep node_modules imports need an upstream
  `./core/skillopt` export in gbrain's package.json (works on this repo's
  pinned flat bun install; breaks under isolated layouts) — TODOS.md P3.

<details><summary>Full per-finding status (239 rows)</summary>

| ID | Severity | Kind | Status | Title |
|---|---|---|---|---|
| shared-infra-01 | major | bug | fixed | weightedMean silently drops rubric criteria the judge omits and double-counts duplicates |
| shared-infra-02 | major | bug | fixed | recallAtK counts duplicate page_ids multiple times; recall can exceed 1.0 |
| shared-infra-03 | major | bug | fixed | precisionAtK divides by returned-list length, not k — rewards adapters that return fewer docs |
| shared-infra-04 | major | bug | fixed | sanitizeQuery leaks acceptable_variants (gold-adjacent answer variants) to the system under test |
| shared-infra-05 | major | bug | fixed | Unsorted readdirSync makes the derived query set filesystem-order dependent |
| shared-infra-06 | minor | bug | fixed | Judge's verdict is parsed and validated, then unconditionally discarded, contradicting the stated ±0.5-band contract |
| shared-infra-07 | minor | bug | fixed | Pricing comment says 'cents per 1M tokens' but constants are dollars per 1M |
| shared-infra-08 | minor | bug | fixed | JudgeConfig.systemPromptVersion is accepted but never used or recorded |
| shared-infra-09 | minor | bug | fixed | Dead _manifest.json filter — unreachable after the .md extension check |
| shared-infra-10 | minor | improvement | fixed | recallAtK returns 0 for empty relevant sets, silently deflating mean recall for gold-less queries |
| shared-infra-11 | minor | improvement | fixed | Retry accounting invisible: a success on attempt 2 is indistinguishable from a clean first-attempt success |
| shared-infra-12 | minor | improvement | fixed | CORPUS_DIR resolved from process.cwd(), breaking runners invoked outside the repo root |
| adapters-queries-01 | major | bug | fixed | stop_reason 'rate_limit_exhausted' is unreachable; exhausted retries throw and kill the whole Cat 8/9 run |
| adapters-queries-02 | major | bug | fixed | computeBrainFirstOrdering mislabels turn-cap runs as 'answer_before_brain' and can never detect real answer-before-brain ordering |
| adapters-queries-03 | minor | bug | fixed | Imports nonexistent EMBEDDING_MODEL from gbrain/embedding; receipt field is silently undefined |
| adapters-queries-04 | minor | bug | fixed | HybridNoGraphConfig.limit is documented but never used; query() hardcodes limit=20 |
| adapters-queries-05 | minor | bug | fixed | q5-0004 is answer-string with empty gold: no expected_answer and relevant: [] |
| adapters-queries-06 | minor | bug | fixed | 'Defensive copy' in getTier5FuzzyQueries is shallow: gold.relevant array is still shared with the canonical set |
| adapters-queries-07 | major | improvement | fixed | Tier 5/5.5 query sets (80 queries) are validated but never executed by any runner |
| adapters-queries-08 | major | improvement | fixed | cosine() silently truncates on dimension mismatch (Math.min), producing plausible garbage instead of failing loud |
| adapters-queries-09 | minor | improvement | fixed | Validator enforces gold shape for only 2 of 8 expected_output_types |
| orchestrators-01 | critical | bug | fixed | Env-prefix built from ${reranker:+VAR=val} is not an assignment; all 4 reranker cells die with exit 127 |
| orchestrators-02 | major | bug | fixed | `run_cell ... \|\| {...}` suspends set -e inside run_cell; gbrain eval and scoring failures are silently ignored and a partial run can be scored and locked in |
| orchestrators-03 | major | bug | fixed | gbrain version gate is an allowlist of 0.35.x-0.36.x that rejects every newer version, including the repo's pinned gbrain (0.47.6.0) |
| orchestrators-04 | major | bug | fixed | GBRAIN_RERANKER_MODEL / GBRAIN_SEARCH_RERANKER_ENABLED (and GBRAIN_SEARCH_MODE) env vars are not read anywhere in gbrain; reranker cells would run without reranking even if the prefix bug were fixed |
| orchestrators-05 | major | bug | fixed | evaluate_qa.py invoked with --input/--output flags and no reference file, which does not match LongMemEval's published evaluator interface |
| orchestrators-06 | major | bug | fixed | Driver failures are silently swallowed: errexit is suspended inside run_cell and the \|\| handler is dead code, so a failed cell prints '-> done' |
| orchestrators-07 | major | bug | fixed | Phase 2 'long-haystack' gate is fake: gbrain's embed() truncates every input to 8,000 chars before the provider call, so the ~50K-token payload never reaches the API |
| orchestrators-08 | major | bug | fixed | Report header and repro instructions present BRAINBENCH_N as the run-count knob, but no dispatched subprocess Cat reads it |
| orchestrators-09 | major | bug | fixed | P@5 denominator is the returned-list length, not K, inflating adapters that return fewer than 5 results in the cross-adapter headline table |
| orchestrators-10 | minor | bug | fixed | Header claims 'Hard cap: $90/cell (wrapper aborts the cell on overrun)' but no cost-cap logic exists in the script |
| orchestrators-11 | minor | bug | fixed | Documented `--adapter grep-only\|gbrain\|all` form is silently ignored: only `--adapter=NAME` parses, and `all` is not a valid name |
| orchestrators-12 | minor | bug | fixed | BRAINBENCH_N parsed with Number() and no guard: NaN/0/empty value makes zero runs and crashes on runResults[0] |
| orchestrators-13 | minor | bug | fixed | 'What this proves' section prints hardcoded verdicts ('strictly dominates', 'No category goes down') regardless of the computed results |
| orchestrators-14 | minor | bug | fixed | Suite always exits 0 even when every cat fails; STAMP is dead code |
| orchestrators-15 | minor | bug | fixed | Relational query builder claims to 'mirror multi-adapter.ts' but drops 2 of its 4 templates, so receipts are not comparable to multi-adapter scorecards |
| orchestrators-16 | minor | bug | fixed | Timeout path sends SIGTERM only with no SIGKILL escalation; a hung cat keeps its ~400MB PGLite instance alive while the next cat starts |
| orchestrators-17 | major | improvement | fixed | No pass/fail thresholds: the runner exits 0 whenever it doesn't crash, so all.ts's Cat 1 '✓ pass' only means 'ran to completion' |
| orchestrators-18 | minor | improvement | fixed | gbrain dependency pinned to a moving branch (#master), making benchmark results non-reproducible across installs |
| orchestrators-19 | minor | improvement | fixed | Phase 2 skips the smoke gate that smoke.ts documents as the per-cell pre-flight, so a misconfigured cell burns the full 240-page embed spend before failing |
| longmemeval-01 | critical | bug | fixed | Recall@k is any-hit, not LongMemEval's official recall_all@k |
| longmemeval-02 | major | bug | fixed | Abstention (_abs) questions not excluded from retrieval recall |
| longmemeval-03 | major | bug | fixed | Error rows written to NDJSON become permanent misses on resume |
| longmemeval-04 | major | bug | fixed | Aggregate hardcodes topK=5 and dataset 's'; mislabels k=8 runs |
| longmemeval-05 | major | bug | fixed | Cache-key fallback model/dims differ from gateway's actual fallback |
| longmemeval-06 | major | bug | fixed | Cache key ignores input_type; wrong-side vectors for asymmetric models |
| longmemeval-07 | major | bug | fixed | Zero-result adapter run yields NaN recall and crashes fmt() on resume |
| longmemeval-08 | major | bug | fixed | Deep import of gbrain's nested ai-sdk breaks on non-linked installs |
| longmemeval-09 | minor | bug | fixed | Headline chart hardcodes 'LongMemEval _s — full 500 questions' |
| longmemeval-10 | minor | bug | fixed | User --dataset silently ignored; hardcoded 500-question completion target |
| longmemeval-11 | minor | bug | fixed | Warm-cache fixture docs contradict report and runner default path |
| longmemeval-12 | major | improvement | fixed | Pin/record resolved gbrain config so 'gbrain-hybrid' is stable |
| longmemeval-13 | minor | improvement | fixed | Stratified sampling takes first-N per type instead of seeded random |
| agentic-cats-01 | critical | bug | fixed | Any gbrain OperationError from a tool call crashes the entire Cat 8/9 run |
| agentic-cats-02 | major | bug | fixed | Prompt leaks the gold label to the classifier for every 'unsupported' claim |
| agentic-cats-03 | major | bug | fixed | weightedMean silently drops rubric criteria the judge omitted and counts unknown/duplicate criterion ids |
| agentic-cats-04 | major | bug | fixed | traverse_graph depth-cap assertion cannot fail — passes even if the cap is removed |
| agentic-cats-05 | major | bug | fixed | Claimed trusted-local vs untrusted-remote matrix is never tested — every call uses remote=true |
| agentic-cats-06 | major | bug | fixed | brain_first_ordering reports 'answer_before_brain' for runs that produced NO answer; the intended case is unreachable |
| agentic-cats-07 | major | bug | fixed | stop_reason 'rate_limit_exhausted' is unreachable — exhausted retries throw and kill the whole run |
| agentic-cats-08 | major | bug | fixed | Probes that produce no answer (turn-cap) count as citation_format- and back_link-compliant |
| agentic-cats-09 | major | bug | fixed | Unresolvable ground_truth_slugs are silently dropped, making the judge score correct answers as hallucinations |
| agentic-cats-10 | minor | bug | fixed | dry_run_add_timeline_entry: scoring requires `source` but the tool schema declares it optional |
| agentic-cats-11 | minor | bug | fixed | checkCitationFormat validates only '- '-prefixed lines; any other timeline formatting passes unchecked |
| agentic-cats-12 | minor | bug | fixed | OperationContext literals omit the TS-required `sourceId` field (contract break vs gbrain v0.47.6) |
| agentic-cats-13 | minor | bug | fixed | ~140 always-true 'has handler' rows dominate the pass-rate summary |
| agentic-cats-14 | minor | bug | fixed | safeStringify replaces shared (non-cyclic) object references with '[Circular]', corrupting bundle JSON |
| agentic-cats-15 | minor | bug | fixed | Emitted JudgeEvidence violates the published evidence-contract schema (probe.query vs required probe.text) |
| agentic-cats-16 | minor | bug | fixed | Transcript schema's probe_id pattern rejects the transcripts the adapter actually produces |
| agentic-cats-17 | minor | improvement | fixed | Flight-recorder is never wired in: cat8/cat9 discard transcripts and emitBundle has zero runner callers |
| agentic-cats-18 | minor | improvement | fixed | No runtime schema validation of emitted artifacts against eval/schemas/*.json |
| agentic-cats-19 | minor | improvement | fixed | tier_escalation 'simple' tier has no upper bound, so over-tooling can never fail |
| retrieval-cats-01 | critical | bug | fixed | GbrainAfterAdapter never configures the AI gateway; init crashes under gbrain v0.47 |
| retrieval-cats-02 | critical | bug | fixed | cat13b GbrainAdapter has the same missing configureGateway crash |
| retrieval-cats-03 | critical | bug | fixed | Cat 11 cannot run as shipped: fixtures absent and the documented fetch script does not exist |
| retrieval-cats-04 | major | bug | fixed | link_precision denominator counts unlabeled base-corpus links; perfect extractor scores ~0.2 |
| retrieval-cats-05 | major | bug | fixed | prose_only_mention must_extract can never match: no exercised code path links bare names |
| retrieval-cats-06 | major | bug | fixed | substring_fp_rate is structurally always 0 — a metric that cannot fail |
| retrieval-cats-07 | major | bug | fixed | Swamp prefix wintermute/chat/ no longer exists in gbrain's boost map — demotion path untested since v0.24.0 |
| retrieval-cats-08 | major | bug | fixed | semantic-neighborhood probes create identical query texts with conflicting golds |
| retrieval-cats-09 | major | bug | fixed | Pass criterion prints but never affects exit code or any artifact — the gate cannot fail |
| retrieval-cats-10 | major | bug | fixed | mean_metric silently excludes failed/missing items, inflating fidelity scores |
| retrieval-cats-11 | major | bug | fixed | Documented thresholds are never evaluated; verdict 'pass'/'fail' is unreachable |
| retrieval-cats-12 | major | bug | fixed | PDF and HTML modalities never exercise gbrain — they benchmark the eval's own extractors |
| retrieval-cats-13 | minor | bug | fixed | Non-numeric CAT13_PROBES yields NaN and silently produces a 0-probe run scored as 0.0% |
| retrieval-cats-14 | minor | bug | fixed | ambiguous_role recall ignores the required link type, so the kind never tests the downgrade it describes |
| retrieval-cats-15 | minor | bug | fixed | Audio detail records provider.length instead of the provider identity |
| retrieval-cats-16 | major | improvement | fixed | No source-boost-off ablation: the eval never isolates the variable it exists to measure |
| retrieval-cats-17 | minor | improvement | fixed | Biased sort-comparator shuffle undermines the cross-runtime determinism claim |
| retrieval-cats-18 | minor | improvement | fixed | Manifest sha256 declared but never verified — stale/corrupt fixtures silently change scores |
| calibration-cats-01 | critical | bug | fixed | cat14 never exercises gbrain: hand-rolled prompt mirror replaces the shipped think pipeline |
| calibration-cats-02 | major | bug | fixed | Precision/recall computed from unvalidated judge output; omissions silently inflate both |
| calibration-cats-03 | major | bug | fixed | Implemented gates diverge from the documented rubric; two core positive-axis gates are missing entirely |
| calibration-cats-04 | major | bug | fixed | Judge is unblinded: probe notes stating the expected verdict are pasted into the judge prompt |
| calibration-cats-05 | major | bug | fixed | Win-rate gate denominator counts probes whose only correct verdict is tie, plus judge failures |
| calibration-cats-06 | major | bug | fixed | Mirrored EXTRACT_TAKES_PROMPT has drifted from gbrain's production prompt |
| calibration-cats-07 | major | bug | fixed | Default corpus dir is a machine-specific Conductor workspace path; documented default invocation throws on any other machine |
| calibration-cats-08 | minor | bug | fixed | behaves_like_baseline and voice_must_not_be_clinical expectations are declared and fixture-set but never scored |
| calibration-cats-09 | minor | bug | fixed | Both-empty case (page with no gradeable claims, extractor correctly returns []) scores F1=0 and fails the probe gate |
| calibration-cats-10 | minor | bug | fixed | Test header claims it runs the full runner in dry-run mode; no test does, and the file is outside the repo test glob |
| calibration-cats-11 | minor | bug | fixed | Failure output points to a README that does not exist |
| calibration-cats-12 | major | improvement | fixed | No temperature control anywhere: an 8-probe gate rides on default temp-1.0 sampling |
| calibration-cats-13 | major | improvement | fixed | A/B judge sees which answer is calibrated; no position/label randomization |
| calibration-cats-14 | minor | improvement | fixed | _summary.json carries no run provenance: dry-run and filtered partial runs overwrite the authoritative summary as a clean gate verdict |
| cats18-21-01 | critical | bug | fixed | slice(0, 60) of 857 files excludes 11 of 12 gold-target files, so both cells score ~0 |
| cats18-21-02 | critical | bug | fixed | Recall@10 numerator counts duplicate chunk rows per relevant page; recall can exceed 100% |
| cats18-21-03 | critical | bug | fixed | Every 'embedding provider' cell silently runs the ZeroEntropy zerank-2 reranker (default balanced mode), so the A/B does not measure embedders |
| cats18-21-04 | critical | bug | fixed | Recall@10 counts duplicate chunk rows per relevant page (same inflation as cat18) |
| cats18-21-05 | major | bug | fixed | '± reranker' axis is confounded with a full mode-bundle switch (balanced vs tokenmax) |
| cats18-21-06 | major | bug | fixed | Ingest and query errors swallowed with bare catch and rerank is fail-open; a broken cell reports zeros/unreranked numbers indistinguishable from a real result |
| cats18-21-07 | major | bug | fixed | Hidden zerank-2 reranker in both cells (default balanced mode) reshuffles exactly the top-1 metric being compared, conditional on an unrelated env var |
| cats18-21-08 | major | bug | fixed | captureHealth reads BrainHealth fields that don't exist (chunk_count, link_count) — receipt always shows 0 links before AND after the link-extraction step |
| cats18-21-09 | major | bug | fixed | No assertion, threshold, or doctor code path despite the header's claims — the eval can never fail |
| cats18-21-10 | major | bug | fixed | Grounding axis is satisfied by construction: the runner injects close/far slugs into every idea line before asking the judge whether ideas 'cite a slug' |
| cats18-21-11 | major | bug | fixed | Failed queries are dropped from the denominator (continue), so cells are compared at unequal n and errors inflate per-cell MRR/recall |
| cats18-21-12 | major | bug | fixed | Brainstorm errors are swallowed and the judge is still run on an empty ideas string; its scores are averaged into the headline means with no error marker |
| cats18-21-13 | major | bug | fixed | recall_at_5 increments once per matching chunk row, so a single query can contribute more than 1 |
| cats18-21-14 | major | improvement | fixed | Receipt carries no ingest/embed-coverage or degraded-stage evidence, so a keyword-only-degraded cell is indistinguishable from a real provider result |
| cats18-21-15 | minor | improvement | fixed | Judge sees only the first 2000 chars (~7 of up to 72 ideas) and judges raw ideas including ones the product filters out |
| cats18-21-16 | minor | bug | fixed | Receipt files_ingested reports the intended count, not actual successes; the per-cell ok counter is dead |
| cats18-21-17 | minor | bug | fixed | brain_score_delta reports 0 (a real 'no improvement' value) when brain_score was unmeasurable, and can never be null despite its type |
| cats18-21-18 | minor | bug | fixed | gbrain_version is effectively always 'unknown': './package.json' is not in gbrain's export map |
| cats22-25-01 | critical | bug | fixed | Trajectory A/B measures nothing: seeded facts never reach the facts table, so both arms run identical prompts |
| cats22-25-02 | major | bug | fixed | Judge and think errors silently become score 0 and are aggregated as valid A/B data |
| cats22-25-03 | major | bug | fixed | Isolation probes pass vacuously on empty results or missing source_id; getPage total is hardcoded |
| cats22-25-04 | major | bug | fixed | Claims 5 ingestion paths but exercises one code path (importFromContent) with 5 labels |
| cats22-25-05 | major | bug | fixed | Phantom fixtures are full canonical tails, which prefix expansion can never match; the designed bare-name case is untested |
| cats22-25-06 | minor | bug | fixed | Resolver exceptions swallowed; a throw on an expected-null phantom counts as correct |
| cats22-25-07 | minor | bug | fixed | Header claims traverseGraph is exercised but no probe exists |
| cats22-25-08 | minor | bug | fixed | 'Force keyword-only' comment is false: detail:'normal' is not a valid opt and the vector arm runs when OPENAI_API_KEY is set |
| cats22-25-09 | minor | bug | fixed | Header cost note says 6 probes / 4 think calls; runner has 2 probes |
| cats22-25-10 | minor | improvement | fixed | Receipt lacks machine-readable pass booleans; dedup check passes vacuously if the first import failed |
| cats22-25-11 | minor | improvement | fixed | Judge has no temperature pinning, single sample, and n=2 supports published wins/ties claims |
| cats22-25-12 | minor | improvement | fixed | Deep node_modules import of runThink bypasses the exported gbrain/think subpath |
| cats26-29-01 | critical | bug | fixed | A/B knob set under the wrong config key; all three modes run identically |
| cats26-29-02 | critical | bug | fixed | Recall@10 over a 3-page corpus is structurally 100%; metric has zero headroom |
| cats26-29-03 | critical | bug | fixed | 'Hermetic. No API keys' is false; keyless run yields an empty scorecard that exits 0 |
| cats26-29-04 | major | bug | refuted | nDCG computed over chunk-level slug list with duplicates; can exceed 1.0 |
| cats26-29-05 | major | bug | fixed | Errored probes silently dropped from the aggregate denominator; run always exits 0 |
| cats26-29-06 | minor | bug | fixed | Engine disconnect not in finally; PGLite engines leak on search error |
| cats26-29-07 | major | bug | fixed | 'Parallel' pass runs N PGLite engines on one event-loop thread; speedup does not mirror the worker pool |
| cats26-29-08 | major | bug | fixed | Single unwarmed measurement with fixed serial-first order biases the headline speedup |
| cats26-29-09 | minor | bug | fixed | Advertised per-source overhead is measured then discarded; 'pages' param is dead |
| cats26-29-10 | major | bug | fixed | Judge is not blinded: the prompt tells it which answer is 'search' vs 'think' |
| cats26-29-11 | major | bug | fixed | Judge API failure is scored as 0 and silently folded into means and win counts |
| cats26-29-12 | minor | bug | fixed | Think runs on Opus by default, not the Sonnet the header and gateway config claim |
| cats26-29-13 | minor | bug | fixed | Deep node_modules path import bypasses the published 'gbrain/think' subpath export |
| cats26-29-14 | minor | bug | fixed | gbrain_version is always 'unknown': 'gbrain/package.json' is not in the export map |
| cats26-29-15 | minor | bug | fixed | Header claims 'Hermetic' but every import embeds via paid OpenAI API |
| cats26-29-16 | minor | bug | fixed | none_vs_synopsis_delta can never measure per-chunk synopsis on this code path |
| cats26-29-17 | minor | improvement | fixed | Aggregate collapses three signal families into one mean; add per-family breakdown |
| cats26-29-18 | major | improvement | fixed | Gold answers contain no ground-truth values, so the judge cannot detect hallucinated specifics |
| skillopt-cats-01 | major | bug | fixed | B-pre validity gate can never fail: PairResult.error is declared but never set |
| skillopt-cats-02 | major | bug | fixed | Errored trials counted as heldout=0; an error in the D_no_gate config silently makes the gate easier to pass |
| skillopt-cats-03 | major | bug | fixed | Documented "within a reasonable band of Y-optimized" gate condition never implemented; transfer_ratio computed then ignored (and can explode) |
| skillopt-cats-04 | major | bug | fixed | Stale result.json from a previous run is parsed as the current run's result when the subprocess fails to write |
| skillopt-cats-05 | minor | bug | fixed | Unseeded Math.random in paired-bootstrap p-value makes the reported statistic non-reproducible |
| skillopt-cats-06 | minor | bug | fixed | gbrain_version is always 'unknown': 'gbrain/package.json' is not in gbrain's exports map |
| skillopt-cats-07 | minor | bug | fixed | File header describes a gate the code does not implement (A>C and the D-sel-overfit check) |
| skillopt-cats-08 | minor | bug | fixed | ISOLATED_HOME temp dirs never cleaned up; rmSync imported but unused |
| skillopt-cats-09 | major | improvement | fixed | Held-out sets use byte-identical judge checks to the training benchmark, so cat30/cat33 'held-out' only tests topic transfer |
| skillopt-cats-10 | minor | improvement | fixed | Foreign-runner contract consumed without validating result_schema_version |
| skillopt-cats-11 | minor | improvement | deferred | Deep ../../node_modules/gbrain/src/... imports bypass the export map and break under non-hoisting installs |
| precisionmembench-01 | major | bug | fixed | Seed path consumes fixture ground-truth `superseded_by` to pre-hide beliefs from gbrain's index, a signal the upstream provider contract never delivers |
| precisionmembench-02 | major | bug | fixed | Unvalidated --mode: any unknown mode string silently runs plain hybrid but stamps the bogus mode into the provider label, filename, and published payload |
| precisionmembench-03 | major | bug | fixed | Report filename and payload omit the run config (entityMax/otherMax/limit/noEmbed), so same-day adaptive runs with different caps silently overwrite each other and published numbers lose provenance |
| precisionmembench-04 | minor | bug | refuted | --json mode leaves console unsilenced during engine init + seeding, so gbrain migrate/import logs pollute the machine-readable stdout |
| precisionmembench-05 | minor | bug | fixed | Separatrix capture keys perQuery by raw query text, so cases sharing a query overwrite each other's captured scores |
| precisionmembench-06 | minor | improvement | fixed | Leaderboard comparison prints partial-run gbrain numbers next to full 77-case published numbers with no n annotation |
| precisionmembench-07 | minor | improvement | fixed | Cliff gate normalizes by `sorted[0].score \|\| 1e-9`, which sign-flips gap ratios and silently disables the cliff when the ordering-driving score is negative (post-rerank case the file claims to support) |
| generators-01 | major | bug | fixed | Contradiction and stale-fact fixtures are planted on a single item each; the required counterpart source never exists |
| generators-02 | major | bug | fixed | Implicit-preference fixtures (pref-001..003) are declared but never planted in any corpus item |
| generators-03 | major | bug | fixed | The 6 templated docs are never added to corpus-manifest.json items (and land in doc/, not the documented docs/) |
| generators-04 | major | bug | fixed | world-v1 cache key is the slug alone — changed facts, prompt, or model never invalidate cached pages |
| generators-05 | major | bug | fixed | Deal slugs are not unique — one of 15 generated deal pages is silently overwritten; manifest overcounts |
| generators-06 | major | bug | fixed | person/concept/project wikilinks omit the -index suffix, so every person->company link in the committed corpus is dangling |
| generators-07 | major | bug | fixed | A --max run silently truncates the committed corpus files, and --max without a value is silently ignored |
| generators-08 | minor | bug | fixed | Meetings link calendar events whose date and counterparty disagree with the meeting, planting unbudgeted contradictions |
| generators-09 | minor | bug | fixed | Reply emails share a thread_id but draw a fresh random counterparty, so email threads are incoherent |
| generators-10 | minor | bug | fixed | Manifest generated_at uses new Date(), so every warm-cache regeneration dirties the committed corpus-manifest.json |
| generators-11 | minor | bug | fixed | Model and pricing constants are mislabeled: claude-opus-4-5 is Opus 4.5 (not a 4.7 alias) and $15/$75 is ~3x its actual price |
| generators-12 | minor | bug | fixed | --max or --concurrency passed without a value silently turns the run into a no-op |
| generators-13 | minor | bug | fixed | Poison hint leaks string-concatenation syntax into all 5 poison prompts |
| generators-14 | minor | bug | fixed | Nonsense dead expression in writeDocs: computed path is always slugPath and never used |
| generators-15 | minor | bug | fixed | Scaffold violates its documented contract: the printed template fails eval:query:validate out of the box |
| generators-16 | minor | bug | fixed | Header claims .ts query files are supported but the implementation only JSON.parses |
| generators-17 | major | improvement | fixed | Validate the written corpus-manifest.json against eval/schemas/corpus-manifest.schema.json at generation time |
| generators-18 | major | improvement | fixed | Assert slug uniqueness before writing and derive the manifest count from actual writes |
| generators-19 | minor | improvement | fixed | Record the server-reported model id (resp.model) in cached shards and the ledger instead of trusting the MODEL constant |
| misc-runners-01 | critical | bug | fixed | extractPageLinks called with pre-v0.13 signature: runner crashes and fence-leak checks are vacuous |
| misc-runners-02 | critical | bug | fixed | extractPageLinks Promise iterated synchronously: runner throws before scoring anything |
| misc-runners-03 | major | bug | fixed | injectAmbiguousRole 'works at' branch demands extraction of an entity never inserted into the content |
| misc-runners-04 | major | bug | fixed | substring_collision must_not_extract check is unfailable: FP rate is 0 by construction |
| misc-runners-05 | major | bug | fixed | must_extract.type is never enforced by any consumer: type-downgrade injections can't fail on mistyping |
| misc-runners-06 | major | bug | fixed | As-of accuracy is circular: gold and prediction use the identical algorithm, so it only measures storage roundtrip |
| misc-runners-07 | major | bug | fixed | '2026 full year' range is empty by construction: vacuous 100% dilutes the macro-averaged range metric |
| misc-runners-08 | major | bug | fixed | Unseeded Math.random picks the timed workload: latency distributions are non-reproducible |
| misc-runners-09 | minor | bug | fixed | Percentile index off-by-one at integer ranks: p95 of 20 samples reports the max, p50 reports the upper value |
| misc-runners-10 | minor | bug | fixed | tryOp timeout rejects a plain object and never clears the timer: reason logged as [object Object], process lingers |
| misc-runners-11 | minor | bug | fixed | --scale value parsed with Number() and no validation: NaN yields zero pages and an opaque crash |
| misc-runners-12 | minor | improvement | fixed | timeMany has no warmup: cold first calls land in the distribution and dominate small-n tail percentiles |
| misc-runners-13 | minor | improvement | fixed | P95 threshold breach only prints a warning: the perf eval can never fail |
| misc-runners-14 | minor | improvement | fixed | Pair maps collapse multi-type edges arbitrarily: first inferred type wins, last gold type wins |
| data-integrity-01 | major | bug | fixed | Concurrent Promise.all capture inflates baseline latency_ms ~6x, neutering the latency-regression gate |
| data-integrity-02 | major | bug | fixed | first_relevant_slug contradicts actual retrieval on the reference corpus for 4 of 12 queries; those top-1 labels can never hit |
| data-integrity-03 | major | bug | fixed | README claims CI gates every PR against the baseline/qrels, but no CI exists and nothing in the repo consumes these files |
| data-integrity-04 | major | bug | fixed | Byte-determinism claim is false: wall-clock latency_ms is serialized into every row, so regeneration is never byte-identical |
| data-integrity-05 | minor | bug | fixed | Evidence-contract schema requires probe.text but the real judge evidence uses probe.query; every real artifact fails the published contract |
| data-integrity-06 | minor | bug | fixed | public-probe schema forbids acceptable_variants/known_failure_modes/author, which the real PublicQuery shape retains |
| data-integrity-07 | minor | bug | fixed | as_of_date oneOf branches overlap when format is non-asserting: "corpus-end"/"per-source" match both branches and fail validation |
| data-integrity-08 | minor | bug | fixed | inferType misses the 'deals' and 'personal' slug prefixes used by the qrels, silently typing those pages 'concept' |
| data-integrity-09 | minor | bug | fixed | Header comments misstate the corpus: 24 pages not 12, and zero-vector embeddings not basis-vector |
| data-integrity-10 | minor | bug | fixed | Transcript schema claims it is 'Written by eval/runner/recorder.ts', but the recorder never emits a JSON transcript |
| data-integrity-11 | minor | improvement | fixed | Scorecard schema's cat enum stops at 12 while the suite ships runners through cat34, and no runner emits the schema's shape — wire real validation |
| data-integrity-12 | minor | improvement | fixed | Generator sanity check only warns on empty retrievals and never fails; extend it to enforce qrels consistency and exit non-zero |
| data-integrity-13 | minor | improvement | fixed | Educational soft-seal tests contain an assertion that can never fail; replace with a real static check on adapter sources |
| tests-audit-01 | major | bug | fixed | CATEGORIES expectations drifted: Cat 34 added to all.ts but tests still expect exactly Cats 1-12 |
| tests-audit-02 | major | bug | fixed | Cache-key determinism tests exercise a local re-implementation, not the generator's real cacheKey |
| tests-audit-03 | major | bug | fixed | 'forces expand=false on query tool' test is vacuous — cannot fail if the expand-forcing guard is removed |
| tests-audit-04 | major | bug | fixed | Cat 5 judge prompt leaks the expected label when evidence pages are missing, and cat5.test.ts locks the leak in |
| tests-audit-05 | minor | bug | fixed | injectAmbiguousRole replace-branch gold requires extracting an entity that is absent from the content, deflating Cat 6 recall |
| tests-audit-06 | minor | bug | fixed | LlmBudget is fully tested but wired into nothing — BRAINBENCH_LLM_CONCURRENCY has no effect on any LLM call |
| tests-audit-07 | minor | bug | fixed | Judge-blinding assertions can't fail: the 'poisonous payload' is never injected into the evidence |
| tests-audit-08 | major | improvement | fixed | No coverage for judge omitting rubric criteria — weightedMean silently renormalizes over the returned subset, inflating scores |
| docs-vs-code-01 | major | bug | fixed | BrainBench quick-start claims 'no API keys, fully offline' but eval:run requires OPENAI_API_KEY |
| docs-vs-code-02 | major | bug | fixed | Report claims warm embedding cache 'ships committed' — it is not committed and the path is wrong |
| docs-vs-code-03 | major | bug | fixed | 'Shipping means it runs in CI and gates releases' — repo has no CI, and 3 listed rows are skipped by the master runner |
| docs-vs-code-04 | major | bug | fixed | Reproduce-from-commit claim broken: gbrain dependency floats on #master, not a pinned SHA |
| docs-vs-code-05 | minor | bug | fixed | Methodology claims metrics include '80 tier-5 + tier-5.5' queries that no scorer ever runs |
| docs-vs-code-06 | minor | bug | fixed | Unqualified 'SOTA' claim for 97.60% R@5 contradicts the repo's own comparison table |
| docs-vs-code-07 | minor | bug | fixed | Troubleshooting tells users to run `bun run test:eval` — script does not exist |
| docs-vs-code-08 | minor | bug | fixed | RUNBOOK claims the 'openai' package is a dependency — it is not, and nothing imports it |
| docs-vs-code-09 | minor | bug | fixed | amara-life-v1 described as 'Gitignored; run eval:generate-amara-life once' but the corpus is committed |
| docs-vs-code-10 | minor | bug | fixed | Quick-start `--stratify 10` command silently runs at top-k 8, not the published K=5 |
| docs-vs-code-11 | minor | bug | fixed | Claims 'randomized question order' as a built-in anti-gaming control — not implemented anywhere |
| docs-vs-code-12 | minor | bug | fixed | Headline default-hybrid precision 0.076 does not match its committed backing artifact (0.0752) |
| docs-vs-code-13 | minor | bug | fixed | Reproduction step labels `bun run eval:run` as 'no API keys' — it requires OPENAI_API_KEY |
| docs-vs-code-14 | minor | improvement | fixed | know-to-ask failure rate 0.150 cannot be reconciled with the printed 9/146 — denominator never stated |
| docs-vs-code-15 | minor | improvement | fixed | SkillOpt report commits no backing artifacts — every published number lives only in gitignored eval/reports/ |

</details>

## What is still open

The keyed re-runs (P1 in [TODOS.md](../../TODOS.md)): the corrected
LongMemEval `recall_all@5` number, the post-fix cat13/cat18 matrices, and
the API-dependent negative controls. This environment had no OpenAI key, so
those re-measurements carry exact commands and cost estimates instead of
numbers. Published pages affected by the metric correction carry errata
rather than silently updated figures.
