# Changelog

All notable changes to gbrain-evals are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions are semver and kept
in sync with `VERSION` + `package.json`.

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
of what a personal brain is for. **LongMemEval `_s` (97.60% R@5, SOTA) remains
the repo's headline retrieval result.**

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
LongMemEval `_s` public-benchmark integration (97.60% R@5, SOTA vs MemPalace
96.6%), and the v0.40.6.0 comprehensive snapshot. See `docs/benchmarks/` for
per-release scorecards.
