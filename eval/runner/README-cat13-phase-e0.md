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

## Phase E2 — arm-confidence floor: calibrate on tuning, decide on held-out

E0-V1 on disk (`~/gbrain-lme-receipts/cat13/E0-V1/receipt.json`, gbrain
0.48.2.0, voyage-4 @ 1024, reranker off, autocut off) reproduces the gap on
the held-out concepts: `gbrain` nDCG@5 53.0 vs `vector` 60.5 (P@1 48.1 vs
65.2; `grep-only` alone 52.2). The keyword arm's strict-AND matches on
paraphrase probes fuse at full RRF weight and drag hybrid below the vector
arm it is meant to complement.

The ONE pre-registered mechanism (gbrain `src/core/search/arm-confidence.ts`,
knob `search.keyword_arm_confidence_floor`, `kacf=` in the knobs hash, every
bundle lands with it OFF): per query, the keyword arm's scale-free margin
`margin_ratio = top / (top + second)` over the rows it returned (1.0 for a
single row, 0 for an empty arm). When `margin_ratio < floor`, a text vector
arm voted, and the query is not relational, the keyword AND title lists fuse
at weight 0.5. The weight is fixed; the floor is the only free parameter and
it is fixed HERE, on the 20 tuning concepts, before the held-out run.

### Step 0 — hermetic plumbing (free, run first)

```bash
CAT13_PROBES=60 bun eval/runner/cat13-kacf-calibrate.ts --stub-embed \
  --embedding-model voyage:voyage-4 --embedding-dims 1024 --max-probes 40
CAT13_PROBES=60 bun eval/runner/cat13-conceptual.ts --stub-embed --adapter gbrain \
  --embedding-model voyage:voyage-4 --embedding-dims 1024 \
  --reranker off --autocut off --keyword-arm-confidence-floor 0.6
bun test test/eval/cat13-conceptual.test.ts test/eval/cat13-kacf-calibrate.test.ts
```

The stub floor means nothing (hash embeddings); check the shapes:
`eval/reports/cat13-kacf/calibration.{json,md}` exist with
`summary.classes.all.unstamped == 0` (the linked gbrain stamps
`keyword_arm_confidence` on every fused query even with the floor off), and
the runner receipt carries `resolved_config.pins.keyword_arm_confidence_floor
== "0.6"`, `search_pins["search.keyword_arm_confidence_floor"] == "0.6"`, and
`observed_by_adapter.gbrain.keyword_arm_confidence_stamped ==
observed_by_adapter.gbrain.queries`.

### Step 1 — calibration (paid; voyage space; tuning split only)

```bash
export VOYAGE_API_KEY=...            # voyage-4 embeds only; no reranker call
export CAT13_EMBEDDING_MODEL=voyage:voyage-4 CAT13_EMBED_DIMS=1024
bun eval/runner/cat13-kacf-calibrate.ts
mkdir -p ~/gbrain-lme-receipts/cat13/E2-calibration
cp eval/reports/cat13-kacf/calibration.json eval/reports/cat13-kacf/calibration.md \
   ~/gbrain-lme-receipts/cat13/E2-calibration/
```

One brain (240 pages, the E0-V1 pins: `search.mode=balanced`,
`search.reranker.enabled=false`, `search.autocut=false`; the floor knob is
unset in config AND forced off per call), then for each of the 359
tuning-subset probes (`CAT13_PROBES` unset → the same 500-target generator
and seed-42 split as the E0 arms) one `hybridSearch(..., {limit: 30, onMeta,
keywordArmConfidenceFloor: null})` and one `engine.searchKeyword(q, {limit:
5})`. Held-out probes are never queried. Cost: one ingest + 359 query embeds,
cents; wall clock ~3 minutes (one PGLite ingest).

The floor is `summary.floor.floor_cli` (median `margin_ratio` over tuning
probes whose keyword top hit is NOT a grade-3 gold AND `0 < margin_ratio <
1`; single-row 1.0 and empty 0 excluded, printed at 4dp so the CLI string
round-trips). `calibration.md` also prints the E2 command with that value
filled in, the collateral (gold-top probes the floor would down-weight;
non-gold-top probes it cannot reach because they were single-row / empty), a
10-bin margin histogram for gold-top vs non-gold-top, and per-template
medians. Collateral and histogram are DIAGNOSTICS for the write-up, not
gates: the floor is used as computed, once. Exit 1 = zero eligible tuning
probes (nothing to pre-register; stop and publish that).

### Step 2 — E2 decision arm (paid; held-out concepts, judged once)

Substitute the floor from Step 1 (the command is also printed at the bottom
of `calibration.md`):

```bash
export VOYAGE_API_KEY=...
export CAT13_EMBEDDING_MODEL=voyage:voyage-4 CAT13_EMBED_DIMS=1024
bun eval/runner/cat13-conceptual.ts --reranker off --autocut off \
  --keyword-arm-confidence-floor <summary.floor.floor_cli>          # E2-V1
mkdir -p ~/gbrain-lme-receipts/cat13/E2-V1
cp eval/reports/cat13-conceptual/receipt.json eval/reports/cat13-conceptual/report.json \
   ~/gbrain-lme-receipts/cat13/E2-V1/
```

Same 500-probe generator, all four adapters, k=5, same seed-42 split, same
cost/time as an E0 arm (~$0.10, ~10 minutes). The only difference from E0-V1
is the one pin: `search.keyword_arm_confidence_floor=<floor>` applied to both
gbrain-backed adapters (`gbrain`, `vector-grep-rrf-fusion`); `grep-only` and
`vector` are the fixed comparators and must land within embedding noise of
their E0-V1 rows (the same-space check).

What the E2-V1 receipt must show before the numbers are read:

- `resolved_config.pins.keyword_arm_confidence_floor` and
  `search_pins["search.keyword_arm_confidence_floor"]` equal the calibrated
  string; `search_config_by_adapter.gbrain` echoes it.
- `observed_by_adapter.gbrain.keyword_arm_confidence_stamped ==
  observed_by_adapter.gbrain.queries` (548) — the linked gbrain emitted the
  decision on every fused query. With a numeric floor pinned and
  `stamped == 0`, the runner marks every probe of the arm as a harness error
  (`kacf_missing_meta`, the `rerank_missing_score` shape) and the run is
  `error`, never a quiet "floor on" row.
- `observed_by_adapter.gbrain.keyword_arm_confidence_downweighted` — how many
  of the 548 queries actually fused the lexical lists at half weight. Zero
  is a legal (null) result, not an error: report it as "the floor never
  fired".

### Pre-registered rule

Decision row: `data.scorecard[gbrain].holdout.ndcg5` vs
`data.scorecard[vector].holdout.ndcg5` in E2-V1 (same run, same embeddings),
with E0-V1's `gbrain` held-out row (53.0) alongside as the paired before.

- **PASS** iff hybrid (off/off + floor) held-out nDCG@5 >= bare `vector`
  held-out nDCG@5 AND, in gbrain with the floor flipped into the bundles,
  none of these regress: NamedThingBench hard families
  (`gbrain eval retrieval-quality test/fixtures/retrieval-quality/namedthing.jsonl`,
  exit 0), the retrieval canary (`bun run scripts/run-eval-canary.ts`), and
  the BrainBench gate (`bash scripts/ci-brainbench-gate.sh`). Then the
  bundles flip to the calibrated floor and this section's receipts publish
  as the Cat 13 row.
- **FAIL** otherwise: publish the per-arm itemization (this calibration
  report + the E2-V1 per-template held-out table) and leave the knob off
  (`null` in every bundle).
- Not allowed after Step 1: re-running with a different floor, changing
  `--seed` / the split sizes, or reading held-out margins before the
  decision. One calibration, one decision arm.

Report the held-out table, the tuning table, and the overall table side by
side, and label overall "includes the 20 tuning concepts".

### Files (Phase E2)

- `eval/runner/cat13-kacf-calibrate.ts` — calibration (one brain, per-probe
  margins, floor + collateral + histogram, `calibration.{json,md}`).
- `eval/runner/cat13-conceptual.ts` — `--keyword-arm-confidence-floor <f|off>`
  pin (threads `search.keyword_arm_confidence_floor`; echoed in the receipt;
  fail-closed `kacf_missing_meta` check).
- `eval/runner/adapters/gbrain-inline.ts`,
  `eval/runner/adapters/vector-grep-rrf-fusion.ts` — per-query
  `keyword_arm_confidence` meta counts in `observedStats()`.
- `test/eval/cat13-kacf-calibrate.test.ts`, `test/eval/cat13-conceptual.test.ts`
  — hermetic pins (median rule, exclusions, collateral, histogram, CLI,
  receipt echo).

## Arbitrary knob A/B — `--search-pin` (Phase E3 arms and later)

Any `search.*` config knob can be pinned on the gbrain-backed adapters
without a dedicated flag: `--search-pin <search.key>=<value>` (repeatable;
`--search-pin=search.key=value` also works; a repeated key → last wins) adds
the entry to the same `engine.setConfig` pin set as `--reranker` /
`--autocut` / `--expansion-variant-budget` / `--keyword-arm-confidence-floor`,
and it is echoed the same way: `resolved_config.search_pins`,
`resolved_config.pins.extra_search_pins` (just the generic ones), and per
adapter in `search_config_by_adapter`. The runner validates the shape at
parse (key must start with `search.` and name a knob, value non-empty) and
refuses keys a dedicated flag owns (`search.mode`, `search.reranker.*`,
`search.autocut`, `search.expansion_variant_budget`,
`search.keyword_arm_confidence_floor`) so their fail-closed checks cannot be
bypassed generically. Beyond that it is a pass-through with NO `kacf`-style
proof that the knob fired: gbrain ignores unknown `search.*` keys silently,
so a misspelled or not-yet-shipped key runs the default cell under the pinned
label — confirm the key exists in the linked gbrain (`gbrain_version` in the
receipt) before reading the arm. The Phase E3 metadata-boost-gate arms, in
the voyage space, are the two cells below (same probes, split, embedder and
cost as an E0 arm; copy the receipt out between arms); the free plumbing
check is `CAT13_PROBES=60 bun eval/runner/cat13-conceptual.ts --stub-embed
--adapter gbrain --search-pin search.metadata_boost_gate=lexical`, after
which `search_pins["search.metadata_boost_gate"] == "lexical"` and
`search_config_by_adapter.gbrain` echoes it.

```bash
export VOYAGE_API_KEY=...
export CAT13_EMBEDDING_MODEL=voyage:voyage-4 CAT13_EMBED_DIMS=1024
bun eval/runner/cat13-conceptual.ts --reranker off --autocut off --search-pin search.metadata_boost_gate=lexical   # E3: like-for-like + gate
bun eval/runner/cat13-conceptual.ts --reranker on  --autocut on  --search-pin search.metadata_boost_gate=lexical   # E3: shipped default + gate
```
