# Cat 13 conceptual recall — Phase E0 run recipe

Phase E0 of the gbrain ranker wave establishes the Cat 13 baseline that the
arm-confidence decision (Phase E2) is judged against. The runner is
`eval/runner/cat13-conceptual.ts`; this file is the exact recipe. Nothing here
changes the probe generator, the corpus, or the metric.

## What E0 fixes about the earlier Cat 13 receipts

- The 2026-04-23 report (`docs/benchmarks/2026-04-23-brainbench-cat13-conceptual.md`,
  hybrid 47.0 vs bare vector 49.1 nDCG@5) ran in the OpenAI space with
  `hybridSearch(..., {limit: TOP_K*6})` and NO search pins, so the gbrain row
  inherited whatever the mode bundle defaulted to at that gbrain version.
- The later voyage-space receipt (hybrid 35.6 vs vector 49.5, gbrain
  TODOS.md "Cat 13 conceptual recall") depended on three gateway-config
  patches that were never committed to this repo. Two of the four adapters
  (`vector`, `vector-grep-rrf-fusion`) call `configureGateway` themselves at
  init, so without those patches they silently reset the process-global
  gateway back to `openai:text-embedding-3-large @ 1536` mid-run. That
  receipt is not reproducible from `main`; E0 lands the equivalent of those
  patches as first-class runner flags and starts over with receipts.

E0 therefore adds, in the runner:

1. **One embedder for every adapter.** `CAT13_EMBEDDING_MODEL` /
   `CAT13_EMBED_DIMS` (or `--embedding-model provider:model` /
   `--embedding-dims N`, flag beats env) flow into `ensureGateway()` and into
   each adapter's init (`shootout` sidecar for `vector` and
   `vector-grep-rrf-fusion`, constructor options for `gbrain`). Defaults are
   unchanged: `openai:text-embedding-3-large` @ 1536. The receipt records the
   resolved embedder AND the gateway's live `(model, dims)` after each
   adapter's `init()` (`resolved_config.gateway_after_init_by_adapter`); an
   adapter that drifts is a harness error on every probe, which invalidates
   the run.
2. **No unpinned gbrain cell.** Both gbrain-backed adapters (`gbrain`,
   `vector-grep-rrf-fusion`) get `search.mode=balanced`,
   `search.reranker.enabled`, `search.autocut` set explicitly via
   `engine.setConfig` before ingest, from `--reranker on|off` and
   `--autocut on|off` (both default `off`). `--reranker on` also pins
   `search.reranker.model=voyage:rerank-2.5` (gbrain's bundle default since
   v0.48.2.0). `--expansion-variant-budget <b>` sets
   `search.expansion_variant_budget` as a pass-through string and is only
   written when given (older gbrain pins ignore unknown keys, so an
   always-present entry would be an unverifiable echo). Every applied entry
   is echoed per adapter in `resolved_config.search_config_by_adapter`.
3. **Fail-closed reranker.** gbrain's reranker is fail-open (missing key means
   plain hybrid, no error). `--reranker on` refuses to run under
   `--stub-embed`, writes a `skipped` receipt when `VOYAGE_API_KEY` is absent,
   and after the run marks a gbrain-backed arm with zero `rerank_score`
   observations as a harness error on every probe (`rerank_missing_score`,
   the same shape as the LongMemEval runner).
4. **Seeded concept split.** `--tuning-concepts N` / `--holdout-concepts M`
   (default 20 / 10 over the 30 `concepts/` pages) seeded by `--seed`
   (default 42, the split's own rng; the probe generator's seed is untouched).
   nDCG@5 / P@5 / P@1 and per-template rollups are reported for the tuning
   set and the held-out set alongside the overall numbers. A probe counts in
   a subset only when every grade-3 target is in it; company-neighborhood
   probes that name concepts from both sets are `mixed` and excluded from
   both (they stay in the overall numbers). The held-out 10 are the Phase E2
   decision set; the 20 tuning concepts are where the arm-confidence floor is
   computed.

## Link the local gbrain

The sibling checkout is the code under test until the wave SHA is pinned:

```bash
cd /home/vercel-sandbox/gbrain && bun link
cd /home/vercel-sandbox/gbrain-evals && bun link gbrain --no-save
ls -la node_modules/gbrain   # -> ../../gbrain
```

`--no-save` keeps `package.json` / `bun.lock` on the published pin; drop it
(or edit the pin to the wave SHA) when the wave lands. The receipt's
`gbrain_version` reports the LINKED checkout's version and `gbrain_pin` the
declared dependency, so link-vs-pin divergence is visible in every artifact.

## Hermetic plumbing check (free, run first)

```bash
CAT13_PROBES=60 bun eval/runner/cat13-conceptual.ts --stub-embed
CAT13_PROBES=60 CAT13_EMBEDDING_MODEL=voyage:voyage-4 CAT13_EMBED_DIMS=1024 \
  bun eval/runner/cat13-conceptual.ts --stub-embed --reranker off --autocut off
bun test test/eval/cat13-conceptual.test.ts
```

The stub transport is a deterministic hash embedding at the configured width;
its scores mean nothing, the receipt shape does. Check
`eval/reports/cat13-conceptual/receipt.json`: `resolved_config.embedder`,
`search_pins`, `search_config_by_adapter`, `gateway_after_init_by_adapter`,
`concept_split`, and `data.scorecard[*].tuning / .holdout`.

## The E0 arms (paid; not run as part of E0 prep)

Every arm is 500 probes (`CAT13_PROBES` unset), all four adapters, k=5.
`--reranker`/`--autocut` only affect the two gbrain-backed adapters;
`grep-only` and `vector` are the fixed comparators inside each embedding
space. Copy `eval/reports/cat13-conceptual/{receipt,report}.json` out between
arms; the runner overwrites them.

### Voyage space (the decision space)

Needs `VOYAGE_API_KEY` for `voyage:voyage-4` embeds and, for the reranker-on
arms, the same key for `voyage:rerank-2.5`.

```bash
export CAT13_EMBEDDING_MODEL=voyage:voyage-4 CAT13_EMBED_DIMS=1024
bun eval/runner/cat13-conceptual.ts --reranker off --autocut off   # E0-V1: like-for-like vs bare vector
bun eval/runner/cat13-conceptual.ts --reranker off --autocut on    # E0-V2
bun eval/runner/cat13-conceptual.ts --reranker on  --autocut off   # E0-V3
bun eval/runner/cat13-conceptual.ts --reranker on  --autocut on    # E0-V4: the shipped balanced default
```

E0-V1 (off/off) is the like-for-like row: the gbrain arm and the `vector`
arm see the same embeddings and the gbrain side runs neither the reranker nor
autocut, so the only difference is fusion. This is the row the earlier 35.6
vs 49.5 claim maps to, now with pins in the receipt. If E0-V1 does not
reproduce a hybrid-below-vector gap on the held-out concepts, Phase E1/E2
have nothing to fix and stop there.

### OpenAI space (continuity with the 2026-04-23 report)

Needs `OPENAI_API_KEY`. Defaults, so no embedder env is required.

```bash
unset CAT13_EMBEDDING_MODEL CAT13_EMBED_DIMS
bun eval/runner/cat13-conceptual.ts --reranker off --autocut off   # E0-O1: comparable to the 47.0 vs 49.1 row
bun eval/runner/cat13-conceptual.ts --reranker on  --autocut on    # E0-O2: shipped default in the OpenAI space
```

The reranker-on arms in the OpenAI space still use `voyage:rerank-2.5`
(`VOYAGE_API_KEY` required); there is no OpenAI reranker.

### Cost and time

Embedding: 240 pages per gbrain-backed adapter plus one page-vector per page
for `vector`, plus 500 query embeds per embedding adapter — well under $0.10
per arm at either provider's rates. Reranker-on arms add 500 rerank calls per
gbrain-backed adapter (2 adapters, top-N in ~30 chunks) — cents. Wall clock
is dominated by two PGLite ingests, ~10 minutes per arm on a laptop. The six
arms above fit in the plan's "Cat 13 + cat13b + world-v1" $2 line.

## Reading the result

Report the held-out table, not the overall one, as the decision row:

```
## Concept split — tuning vs held-out (seed=42, 20/10 concepts)
| Adapter | Subset | #probes | nDCG@5 | P@5 (graded) | P@1 (strict target) |
```

Phase E2's pre-registered success rule is stated on `gbrain` (off/off) vs
`vector` nDCG@5 on the held-out subset in the voyage space. The per-template
held-out table shows where the gap lives (the earlier receipts pointed at
`synonym`). Publish tuning and held-out numbers side by side and label the
overall number "includes the 20 tuning concepts".

## Files

- `eval/runner/cat13-conceptual.ts` — runner (embedder, pins, split, receipt).
- `eval/runner/adapters/gbrain-inline.ts` — `searchConfig` pins + `resolvedConfig()` /
  `observedStats()` echo.
- `eval/runner/adapters/vector-grep-rrf-fusion.ts` — same hooks on the second
  gbrain-backed adapter (`searchConfig` applied after the shootout defaults).
- `eval/runner/adapters/vector.ts` — unchanged; receives the embedder via the
  existing `shootout` sidecar.
- `test/eval/cat13-conceptual.test.ts` — hermetic pins for all of the above.
