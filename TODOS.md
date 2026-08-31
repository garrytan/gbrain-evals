# TODOS

Deferred work with enough context to pick up cold. Each item names its
audit-finding lineage (see `docs/audit/2026-08-31-eval-audit.md`).

## P1 — keyed re-runs (blocked on API keys, not on code)

The 2026-08-31 audit fixed metric definitions and eval harnesses; the runs
below re-measure published numbers with the corrected code. None can run in
a keyless environment. Each command works from a fresh clone after
`bun install --frozen-lockfile`.

- [ ] **LongMemEval recall_all@5 re-measurement** (finding longmemeval-01;
  erratum in `docs/benchmarks/2026-05-07-longmemeval-s.md`). The published
  97.60% was any-hit recall; the runner now reports official `recall_all@5`.
  Needs `OPENAI_API_KEY` (~$2 first embed, ~$0 with warm cache), dataset at
  `eval/data/longmemeval/longmemeval_s.json` (HuggingFace, gated):
  `bun eval/runner/longmemeval.ts --dataset eval/data/longmemeval/longmemeval_s.json`
  Then update the report table + README row + comparison-systems metric key,
  and regenerate the two SVGs via `bun eval/runner/longmemeval-chart.ts`.
- [ ] **cat13 / cat13b full adapter matrix** (crash-fixed in WS2; the
  configureGateway bug means no honest full run exists post-v0.40). Needs
  `OPENAI_API_KEY`: `bun eval/runner/cat13-conceptual.ts` and
  `bun eval/runner/cat13b-source-swamp.ts`.
- [ ] **cat18 / cat18b provider matrix with pinned cells** (WS5 fix removed
  the hidden zerank-2 reranker from embedder-only cells; published numbers
  predate the pin). Needs OPENAI + VOYAGE keys. Note: ZeroEntropy's hosted
  API sunsets 2026-09-04 — zerank-2 cells are historical-only after that.
- [ ] **API-dependent negative controls** (WS3): each judge-based eval's
  degraded-config control (threshold: degraded <= 0.5x real, fixed seeds)
  needs one keyed run to prove benchmark sensitivity end-to-end.

## P2

- [ ] **Populate the remaining `eval/data/gold/` stubs** (critic finding:
  7 files were single-`_example` stubs while their _comments claimed real
  content; 4 have zero consumers). `contradictions.json` and
  `implicit-preferences.json` are now generated from planted fixtures;
  remaining: `backlinks.json`, `citations.json`, `entities.json`,
  `personalization-rubric.json`, `poison.json`, `qrels.json` — either
  populate from amara-life fixtures or delete the zero-consumer ones.
  `eval/runner/validate-data.ts` warns on every remaining stub.
- [ ] **PrecisionMemBench vendored-fixture byte-diff** (critic finding): the
  leaderboard-comparability claim rests on ATTRIBUTION.md's "byte-for-byte
  from upstream tenurehq/precisionmembench @ c9689ca6" — nobody has diffed
  it. `git clone` the upstream at that SHA and diff
  `eval/precisionmembench/fixtures/` + scorer files; record the result in
  ATTRIBUTION.md.
- [ ] **world-v1 regeneration with the fixed cache key** (finding
  generators-04): `eval/generators/gen.ts` now content-addresses its cache,
  but the committed 240-page world-v1 corpus predates the fix. Regeneration
  churns qrels/gold downstream, so batch it with the next intentional
  corpus change. Needs `ANTHROPIC_API_KEY` (Opus generation, ~$40 cold).

## P3

- [ ] **Upstream gbrain: search-config surface for `gbrain eval longmemeval`**
  (WS7): the CLI has no way to set a reranker for benchmark runs — the
  programmatic `searchConfigSnapshot` (v0.45 #3676) is not exported and no
  `--search-config KEY=VAL` flag exists. Until then,
  `scripts/run-shootout-phase1.sh` refuses reranker cells rather than
  running them unreranked under a reranked label. File a gbrain PR adding
  the flag, then re-enable cells A1/B1/C1/C2.
- [ ] **Upstream gbrain: export `./core/skillopt` subpath** (audit
  skillopt-cats-11): cat30-33 deep-import gbrain's skillopt orchestrator via
  node_modules paths that work on flat bun installs but break under isolated
  layouts. One export-map line upstream removes the last four deep imports.
- [ ] **Upstream gbrain: export a `gbrain/version` subpath** so eval repos
  don't need the resolve-and-walk helper in
  `eval/runner/gbrain-version.ts` (works fine, just inelegant).
