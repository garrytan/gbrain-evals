# Changelog

All notable changes to gbrain-evals are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions are semver and kept
in sync with `VERSION` + `package.json`.

## [0.5.1] - 2026-08-31

### Changed — LongMemEval erratum RESOLVED: official `recall_all@5` = 83.40%, published from the original run's raw rows at $0

The 2026-08-31 erratum ("corrected number pending") is closed without a
paid re-run: the May run's per-question NDJSON stream survived, and the
audited aggregator recomputes every metric from `retrieved` +
`ground_truth`. The corrected headline is **83.40% `recall_all@5`**
(hybrid; expansion 84.26%, vector 79.36%, keyword 10.64%; n=470 with the
30 `_abs` abstention questions excluded per the official protocol), with
the loss largely where the erratum predicted: multi-session 71.9%,
temporal-reasoning 69.3% (plus a one-question knowledge-update dip the
original erratum's scoping missed — that type also carries multi-session
ground truth).

Publication gates that ran before the number went in: exact reconciliation
against the published figure (459 non-abs + 29 abs any-hits = 488/500 =
97.60% under the old semantics — the same rows, only the scoring
corrected), ground-truth set-equality vs the canonical dataset (500/500),
zero error rows, duplicate worker-resume rows deduped (696, non-error
preferred). Committed artifacts:
`docs/benchmarks/2026-05-07-longmemeval-s/rescore-may-2026-08-31.{json,md}`.

Also: the erratum's own documented re-run command was broken (`--dataset`
takes a split name, not a path; the runner defaults to k=8) — fixed in the
report, README, and TODOS. Notable side-finding: query expansion is NOT a
null result under the official metric (+0.85pp overall — 4 of 470 questions, +3.9pp on
temporal-reasoning) — the published "clean null result" was an artifact of
the saturated any-hit metric.

A fresh keyed re-measurement at the current gbrain pin (May ran v0.28.8)
plus a pre-registered session-diversity row ship with the 2026-08 fix
wave's companion publication.

## [0.5.0] - 2026-08-31

**Benchmark semantics changed — scores from 0.5.0 are not comparable to
earlier scores.** A 35-agent audit (237 verified findings, committed at
`docs/audit/2026-08-31-findings.json`) drove a full remediation:

- **Metric corrections:** shared recall counts unique ids (could exceed 1.0
  on chunk-grained results), precision@k divides by k, LongMemEval headline
  becomes official `recall_all@k` (was any-hit — erratum published in the
  2026-05-07 report). LLM judge enforces rubric coverage (partial score sets
  were silently renormalized), runs at temperature 0.
- **Outcome contract:** every runner writes a validated receipt
  (run_status / verdict / failure_origin); `all.ts` aggregates receipts, not
  exit codes; a skipped category can never count as pass. Unified scoring
  policy: system-under-test failures score as misses; harness errors are
  excluded and capped (>10% invalidates a run).
- **Crash fixes vs pinned gbrain v0.47:** cat13/cat13b (configureGateway),
  adversarial + type-accuracy (async extractPageLinks), longmemeval imports,
  17 runners' version stamps. gbrain dependency pinned to an exact SHA;
  `bun.lock` committed.
- **Eval integrity:** ~12 previously-unfailable evals got real gates,
  feature-boundary docs, and negative controls; hidden default-mode reranker
  removed from embedder A/Bs; judges blinded (cat5/cat14/cat29); shootout
  shell scripts fixed (env expansion bug killed 4/7 cells silently).
- **Data integrity:** `eval/runner/validate-data.ts` gate (manifest counts,
  wikilink resolution, qrels label reachability); synthetic-v1 regenerated
  (every person→company link was dangling; one deal page silently
  overwritten); qrels q11 adjudicated with logged rationale; latency
  baseline regenerated serially (was ~10x inflated by concurrent capture).
- **CI:** hermetic gate on every PR — typecheck, unit suite, keyless runner
  subset, data validation, qrels + baseline retrieval gate.
- **SkillOpt held-out semantics:** skillopt-v1 held-out task sets now carry
  DIFFERENTIATED judge criteria (stricter, differently-phrased checks the
  optimizer never sees) instead of the training checks verbatim — cat30/cat33
  "held-out" scores from before this change measured topic transfer only
  (audit skillopt-cats-09). Wrapper-script gates hardened: the SkillOpt suite
  driver exits non-zero when any cat fails, the LongMemEval batch wrapper
  honors `--dataset` and derives its completion target from the dataset, and
  both shootout phases now smoke-gate every cell with a real per-cell
  wall-clock cap in phase 1.

Merge notes: 0.3.0 (Cat 35) and 0.4.0 (its republish after gbrain's
write-path wave) landed on main mid-remediation; this release sits on top of
both. The final gbrain pin is 0.4.0's v0.47.8.0 (`2a56b512`) — a strict
descendant of the SHA the audit verified against (v0.47.6.0, +6 commits) and
the tree the republished Cat 34/35 numbers were measured on; the whole
remediated suite re-verified against it.

## [0.4.0] - 2026-08-31
### Changed — Cat 35 republish after the gbrain write-path fix wave; Cat 34 refresh

Cat 35 did what a benchmark is for: gbrain shipped a fix wave
([gbrain#4742](https://github.com/garrytan/gbrain/pull/4742), v0.47.8.0)
aimed at the exact deficiencies the published report named, and this release
republishes the scorecard with two bracketing runs (pre-wave master /
post-wave) on the frozen corpus, same judge model and prompt version.

- **New headline** ([updated report](docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill.md)):
  dream salient-unit recall **88.1%** (95% CI 82.0–93.5; published 61.5%,
  honest pre-wave re-baseline 70.2%), **all 20** expected sessions emit pages
  (was 16 — the four misses now pass a verified-segment rescue from BELOW the
  triage gate, with zero false fires on the routine controls), quote fidelity
  **82.7%** (was 45.4%), claim hallucination **7.0%** (was 14.1%), facts lane
  **64.8%** with the idea-kind gap narrowed 38.3→50.0% after gbrain's
  extractor gained an `idea` fact kind.
- Both bracketing receipts are committed next to the baseline receipt; the
  original v0.46.3.0 publication stays intact in the report as the
  historical record, with an update block on top and honesty notes
  (n=1 judge variance, the quote-count denominator change, one distractor
  flip).
- **Cat 34 refresh** ([report](docs/benchmarks/2026-06-12-brainbench-memory.md)):
  an update banner records the current committed CI baseline — know-to-ask
  failure 0.000 on all three seams (was 0.150; fixed upstream in
  v0.46.15.0), false fire 0.000 everywhere, push recall 0.906 / 1.000 /
  0.552 at precision 1.000.
- README "Where gbrain lands today" rows updated for both, including a new
  memory-conformance row.
- gbrain pin advanced to `2a56b512` (v0.47.8.0), the SHA the post-wave
  receipt was verified against.
- The pin move also closed a harness TODO: the PGLite disconnect sync-spin
  under `bun test` no longer reproduces at v0.47.8.0, so the six skipped
  engine teardowns in `test/eval/agent-adapter.test.ts` are restored
  (verified under a kill-switch watchdog; the bounded-disconnect race for
  real runs stays).

## [0.3.0] - 2026-08-27

### Added — Cat 35: transcript → brain-page distillation fidelity

The write path finally has a number. When an agent-session transcript goes
through gbrain, Cat 35 measures what fraction of the salient facts, ideas,
decisions, and emotional tenor survives into a usable brain page — the first
benchmark anywhere to score agent-session distillation (HaluMem covers
persona-chat memory points; nobody else publishes write-path numbers at all).

- **Published result** ([report](docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill.md)):
  gbrain's dream distiller keeps **61.5%** of salient content (95% CI
  45.0-77.6) in pages rated 85% usable with **zero** distractor leakage; its
  failure mode is inventing (14.1% claim hallucination), never leaking noise.
  The verbatim-import control measures the judge ceiling at 93.1% and leaks
  100% of planted noise at 0% usability — the coverage-vs-usability tradeoff,
  quantified. Vibes survive distillation better than facts (71.4% vs 52.5%);
  the facts extractor is the mirror image (69% facts, 38% ideas).
- **Committed planted-gold corpus** (`eval/data/transcript-distill-v1/`):
  24 fictional agent sessions across six scenarios (incl. long-noisy variants
  with tool-call noise and a pure-routine triage control), 173 salient units
  with verbatim anchors, 86 true-noise distractors, 2 attribution hazards.
  Deterministic skeleton + cached Opus prose; regenerate with
  `bun run eval:generate-transcript-distill`.
- **Safe-by-default runner** (`bun run eval:cat35:smoke` ≈ $0.10; the full
  `bun run eval:cat35` requires an explicit CAT35_FULL and a pre-flight cost
  cap), with receipts (schema-pinned), regression deltas vs the committed
  baseline, a triage-separation curve, and a judge-calibration scaffold.
- gbrain is now **pinned to a SHA** (v0.46.3.0) for reproducibility, with a
  postinstall shim that repairs bun's pglite hoisting so a fresh clone works.

### Fixed

- Pre-publication adversarial review (two Claude passes + two Codex passes)
  hardened the harness: case-insensitive anchor scanning (erratum in report
  §9: verbatim leakage floor corrects 96.5% → 100%; dream stays 0%),
  publication-eligible receipts now require the whole corpus (cherry-picked
  subsets are marked `partial`), coverage verdicts without supporting
  evidence are rejected, judge transport errors degrade to judge-failed
  instead of crashing paid runs, and corpus transcript files are
  hash-verified against the manifest at load.
- `test/eval/all-and-budget.test.ts` (broken on main since Cat 34 landed) and
  the tool-bridge fake engine (predating gbrain's alias-hop contract) are
  green again; a PGLite disconnect freeze under `bun test` at the pinned
  gbrain is worked around and filed upstream (see TODOS.md).

## [0.2.0] - 2026-05-29

### Added — PrecisionMemBench (external benchmark)

gbrain now runs against [PrecisionMemBench](https://github.com/tenurehq/precisionmembench)
(tenurehq), the first memory benchmark that isolates *retrieval precision* from
answer quality. The integration is faithful by construction: Tenure's own MIT
scorer is vendored verbatim (pinned `c9689ca`), and gbrain overrides only the
provider `searchText` so the numbers are directly comparable to every other
system on the leaderboard.

What it surfaced, honestly:

- **gbrain's default top-K hybrid scores 0.076 precision** — in the
  mem0/zep/vector cluster. A precision benchmark punishes returning a pile and
  letting a downstream model sort it out. Recall is 0.99; precision collapses.
- That finding prompted a real, opt-in gbrain retrieval feature —
  **intent-aware adaptive return-sizing** (`adaptiveReturn`, default-off). With
  it, gbrain reaches **0.582 precision / 29 active passes / 44-of-77**, clear of
  supermemory (0.43 / 17) on both axes and at a third of its latency. A solid
  #2 behind the benchmark author's purpose-built belief store.
- Instrumenting first killed a bad design before it shipped: the planned
  "score cliff" detector carries no signal (rank1→rank2 gap is 0.60 when the top
  result is correct vs 0.57 when it is wrong). "Return a tight set" is the whole
  win.

Caveats are documented in the report: the benchmark's structural categories are
harness-computed (identical for every provider), `gbrain-think` is a citation
lens rather than the `/search` contract, and the adaptive feature stays
default-off pending a cross-surface recall ablation. PrecisionMemBench measures
a narrow 35-belief lexical corpus; it is a useful precision probe, not a measure
of what a personal brain is for. **LongMemEval `_s` (97.60% R@5, best published
among systems with no LLM in the retrieval loop — MemPal's Haiku-reranked rows
score higher; see docs/comparison-systems.md) remains the repo's headline
retrieval result.**

New files: `eval/precisionmembench/` (vendored scorer + fixtures + gbrain
adapters + seed + attribution), `eval/runner/precisionmembench.ts` (4-mode
runner), `eval/runner/precisionmembench-instrument.ts` (policy sweep + cliff
read), `test/eval/precisionmembench-scorer.test.ts` (scorer parity),
`docs/benchmarks/2026-05-29-precisionmembench.md` (full report + committed
result JSONs).

> `gbrain-adaptive` mode requires gbrain with the `adaptiveReturn` SearchOpt
> (unreleased as of this entry — `bun link` a local gbrain checkout until it
> merges to `gbrain` master). The other three modes run on `gbrain` master.

### Fixed

- Committed the backing result JSONs for the report's headline (adaptive
  tight, 0.582 / 29 / 44-of-77) and shipped-default rows — both were quoted
  in the report without a reproducible artifact. The tight config reproduces
  the headline exactly; the shipped-default row was reconciled to its real
  run (0.16 / 1 active / 8-of-77).
- Corrected the vendored scorer's `Belief` type import to the co-located
  `./belief.js` (was the upstream `../types/` layout path; documented in
  ATTRIBUTION.md).
- Scoped the gold-template schema test to canonical templates so a
  colocated subset fixture no longer trips the exact-set assertion.

### Also

- Hermetic baseline + qrels for the `gbrain eval gate` (v0.41-launch work,
  carried in its own commit).

## [0.1.0] - prior

Initial BrainBench: world-v1 + amara-life-v1 corpora, the 12-Cat catalog,
LongMemEval `_s` public-benchmark integration (97.60% R@5 vs MemPalace's raw
96.6% — best among no-LLM-in-the-retrieval-loop systems; MemPal's
Haiku-reranked rows score higher), and the v0.40.6.0 comprehensive snapshot.
See `docs/benchmarks/` for per-release scorecards.
