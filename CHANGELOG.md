# Changelog

All notable changes to gbrain-evals are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions are semver and kept
in sync with `VERSION` + `package.json`.

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

### Also

- Hermetic baseline + qrels for the `gbrain eval gate` (v0.41-launch work,
  carried in its own commit).

## [0.1.0] - prior

Initial BrainBench: world-v1 + amara-life-v1 corpora, the 12-Cat catalog,
LongMemEval `_s` public-benchmark integration (97.60% R@5, SOTA vs MemPalace
96.6%), and the v0.40.6.0 comprehensive snapshot. See `docs/benchmarks/` for
per-release scorecards.
