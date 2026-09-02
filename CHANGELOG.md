# Changelog

All notable changes to gbrain-evals are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions are semver and kept
in sync with `VERSION` + `package.json`.

## [0.6.1] - 2026-09-02

Re-run of the public LongMemEval-S (cleaned) split at gbrain v0.48.2.0, plus the
runner and report changes that make the numbers honest against the new gbrain
default reranker.

### Changed

- **gbrain pin → `172df271` (v0.48.2.0, PR #4792 branch head).** Re-pointed at
  the release that moves the reranker default to Voyage `rerank-2.5`; will be
  re-pinned to the master merge commit when that PR lands.
- **Rerank specs pin the reranker model.** `resolvedSearchConfig` now sets
  `search.reranker.model = voyage:rerank-2.5` (`RERANK_MODEL_PIN`) for
  `hybrid+rerank` / `hybrid-sessdiv+rerank`, and the fail-closed
  `rerankPreflight` derives the required env key from that pin
  (`VOYAGE_API_KEY`), so the receipt names the model and the preflight cannot
  disagree with the engine. Tests updated accordingly.
- **Chart baselines are strict-metric only.** `longmemeval-chart.ts`
  `EXTERNAL_BASELINES` replaced MemPalace's published any-hit numbers with the
  recomputed `recall_all@5` values (85.7% raw, 90.0% with LLM rerank) and
  ContextFit's self-reported All@5 (87.45%, leakage caveat); any-hit and
  QA-accuracy numbers are never charted next to the headline.
- **Report + README + comparison refresh.** New top update block in
  `docs/benchmarks/2026-05-07-longmemeval-s.md` (hybrid 93.19% `recall_all@5`,
  438/470, identical to the v0.48.0.0 receipt; pre-fix bracket 51.39% at pin
  `2a56b512`), artifacts and manifest entries, and `docs/comparison-systems.md`
  rows that separate strict recall, any-hit recall and LLM-judged answer
  accuracy (every number source-verified 2026-09-02). All five arms landed in
  this same report (official session-level `recall_all@5`, `longmemeval_s`
  cleaned Sept-2025 revision, 470 scored, k=5, gbrain v0.48.2.0 `172df271`,
  2026-09-02, single run, 0 errors): `hybrid+rerank` **95.32%** (448/470,
  `voyage:rerank-2.5`, the release default path since `balanced` and `tokenmax`
  run the reranker; +18 / -8 paired vs hybrid; any-hit@5 99.79%),
  `hybrid-sessdiv+rerank` 95.53% (449/470), `hybrid` 93.19% (438/470, the
  like-for-like row against the May 2026 83.40% and v0.48.0.0 93.19%
  receipts), `hybrid-sessdiv` 93.40% (439/470, one question over hybrid; slot
  starvation is not the miss class), `hybrid+expansion` 54.89% (258/470;
  `tokenmax`'s LLM multi-query expansion is harmful at k=5, -183 / +3 paired
  vs hybrid, consistent with the 49.6% in the v0.48.0.0 receipt). Reranker per
  type: temporal-reasoning 84.3% to 89.8% (107 to 114 of 127), knowledge-update
  and the three single-session types to 100%, multi-session flat at 92.6%
  (112/121). Comparison reads updated to the two yardsticks: reranker to
  reranker 95.32% vs MemPalace's recomputed LLM-rerank 90.0%; no-LLM 93.19% vs
  MemPalace raw 85.7%; ContextFit 87.45% keeps its gold-label leakage caveat.
- **Charts + manifest for the five-arm run.**
  `docs/benchmarks/2026-05-07-longmemeval-s/rerun-2026-09-02-v0.48.2.0.headline.svg`
  and `rerun-2026-09-02-v0.48.2.0.per-type.svg` regenerated from the all-arms
  aggregate (`rerun-2026-09-02-v0.48.2.0-all-arms.json`) with the strict-only
  external baselines; per-arm `rerun-2026-09-02-v0.48.2.0-<arm>.json` +
  `.ndjson` receipts for all five arms and the pre-fix bracket
  `prefix-bracket-2a56b512-v0.47.8.0.ndjson` are listed in
  `docs/receipts-manifest.json` with sha256 (byte counts in the report's
  Receipts list).

### Fixed

- `package.json` version (0.5.1) reconciled with `VERSION`; both read 0.6.1.

### Fixed

- **Two contract tests reconciled with gbrain 0.48.x behavior changes at the
  new pin.** `mcp-contract` traverse_graph: a remote call with no `direction`
  now returns bidirectional `GraphPath[]` edges (gbrain #4704), so the depth-cap
  check reads the edge shape and asserts the cap (10), the explicit depth, and
  the depth-2 default on a real inbound edge, instead of counting legacy nodes.
  cat15: the `prompt_version` pin now reads gbrain's
  `PROPOSE_TAKES_PROMPT_VERSION` constant (advanced by gbrain #4736) instead of
  a stale literal.

### Known

- gbrain #4736 also changed the TEXT of the propose-takes prompt that cat15
  measures; the published cat15 F1 figures were scored against the previous
  prompt and need a live re-baseline at v0.48.2.0 (not run here).

## [0.6.0] - 2026-09-01

### Added — receipts become machine-gated; session-level measurement lands (outside reviews #26 + #24)

Two independent outside verification passes (issues #26, #24) audited this
repo against its own standards. Every confirmed gap is closed in this
release; one sub-claim was refuted with evidence (PR #13 carries no
benchmark figures).

- **The May raw rows are committed.** docs/benchmarks/2026-05-07-longmemeval-s/
  rescore-may-copy.ndjson (2,696 rows, sha256 a26453…3d0b) now sits next to
  the summary it produced. A keyless golden regression test re-derives every
  published digit — all four adapters, every per-type bucket — on every CI
  run. The cited-but-missing validator (longmemeval-validate-ndjson.ts) now
  exists and passes on the committed stream.
- **Receipts manifest.** docs/receipts-manifest.json maps every README claim
  to a committed artifact (sha256 + expected values) or an explicit
  disclosed-gap entry; a test enforces it. Remaining declared gaps:
  skillopt, relational-recall, stability-snapshot.
- **Cat 34 receipts committed** (June originals + a labeled $0 rerun at pin
  2a56b512 reproducing gbrain'''s baseline digit-for-digit: kta 0/149, push
  recall 0.9063/1.000/0.5521). The report names the pin, discloses the
  SUT-reported-counters trust boundary, and the historical SVGs are
  captioned, not overwritten.
- **Cat 35 judge provenance** (gap 4): receipts now record server-reported
  per-call model ids ({model: call_count}); cross-run deltas are suppressed
  as non-comparable unless both receipts resolve to one identical model. No
  dated snapshot exists for claude-sonnet-4-6 in the current registry — the
  alias history is disclosed in the report.
- **Session-level adapters + diagnostics.** The official recall_all@5 wants
  ALL gold sessions in the top 5; the runner scored top-5 chunks deduped to
  sessions. The committed May rows averaged 2.68 distinct sessions per
  top-5 list (99.6% shortfall) — the pre-registered session-diversity
  diagnostic, now computed retroactively at $0. New disclosed adapters
  (hybrid-sessdiv, hybrid+expansion-sessdiv, and fail-closed rerank
  variants) measure top-5 distinct sessions; old adapters stay
  byte-identical; every row carries run_config_hash and the aggregator
  rejects mixed-provenance streams.

### Changed — claim hygiene

- MemPalace'''s 96.6% is settled as recall_any@5 (arXiv 2604.21284) — the
  README'''s 97.66% any-hit comparison is now same-variant. ContextFit'''s
  current whitepaper numbers (84.3% All@5 token+certificates, 87.45% fused)
  are disclosed; under recall_all@5 they lead gbrain'''s 83.40/84.26 pending
  the fresh-pin re-run. LETHE, Memoria, Mem0, and a PrecisionMemBench
  section (with upstream'''s own unreconciled gbrain row) join
  comparison-systems.md, all sourced.
- README: PMB 0.582 marked upper bound pending re-run everywhere; 0.075
  synced; Cat 35 "zero junk leakage" corrected to 1.2% (1/86); Cat 34 codex
  seam (0.552) no longer omitted; relational 97.9%/49.1% qualified as
  pre-audit (erratum banner added to the 2026-04-23 report); "fix wave in
  flight" replaced with what is actually queued.
- CI typecheck no longer passes silently on a tsc crash; phase2 smoke gate
  uses an args array (issue #24 findings 8a/8b).

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
