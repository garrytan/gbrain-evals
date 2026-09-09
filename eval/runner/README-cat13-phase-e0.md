# Cat13: compare conceptual search under explicit settings

Cat13 asks whether search can find the right concept when the question uses different words. A vector model may connect “software that remembers across sessions” with a page about agent memory even when keyword search has little to match.

This is the run recipe for the September 2026 ranking experiment. The [report](../../docs/benchmarks/2026-09-06-longmemeval-ranker-wave.md) explains the outcome: gating metadata boosts helped held-out conceptual ranking, while the tested keyword-confidence floor did not. The phase labels below preserve the original experiment's identifiers.

## What the setup controls

The April 23 OpenAI-space run measured hybrid 47.0 versus vector 49.1 nDCG@5 without explicit search settings. A later Voyage-space result, 35.6 versus 49.5, depended on three uncommitted gateway patches. Vector and hybrid adapters could reset the shared gateway to OpenAI during initialization. Neither run supplied a reliable recipe for the later controlled comparison.

The current runner applies the selected embedder to every adapter and records the gateway's model and dimensions after initialization. Both gbrain-backed adapters also receive explicit search configuration. A mismatch is a harness error.

| Control | Default or behavior |
|---|---|
| `--embedding-model` / `CAT13_EMBEDDING_MODEL` | `openai:text-embedding-3-large`; flag overrides environment |
| `--embedding-dims` / `CAT13_EMBED_DIMS` | 1536; flag overrides environment |
| `--reranker on\|off` | Off in this runner; on selects `voyage:rerank-2.5` |
| `--autocut on\|off` | Off in this runner |
| `--seed` | 42 for the concept split |
| `--tuning-concepts` / `--holdout-concepts` | 20 / 10 from the 30 concept pages |
| `--keyword-arm-confidence-floor` | Explicit numeric floor or `off` |
| `--search-pin search.key=value` | Additional search setting; repeatable |

A runner default is not necessarily the product default. At gbrain v0.48.4.0, `search.metadata_boost_gate=lexical` became the bundle default. To reproduce the older ungated condition, explicitly set it to `always`.

Reranker-on refuses fake embeddings, requires `VOYAGE_API_KEY`, and must produce observed reranker scores. This prevents a missing key from being recorded as a reranked measurement.

## Install and check without paying for embeddings

Use the dependency pin in this repository:

```sh
bun install --frozen-lockfile
CAT13_PROBES=60 bun eval/runner/cat13-conceptual.ts --stub-embed
CAT13_PROBES=60 bun eval/runner/cat13-conceptual.ts --stub-embed \
  --embedding-model voyage:voyage-4 --embedding-dims 1024 \
  --reranker off --autocut off
bun test test/eval/cat13-conceptual.test.ts
```

Fake embeddings are deterministic hashes at the selected width. Their ranking scores do not describe real retrieval quality. Inspect `eval/reports/cat13-conceptual/receipt.json` for `resolved_config.embedder`, applied search settings, gateway settings after each adapter initializes, and the tuning/held-out split.

If testing unreleased gbrain code, register `bun link` inside that separate checkout, then link it from this repository with `bun link gbrain --no-save`. Record its actual commit. The declared package pin and loaded code may differ; the receipt reports both identities.

## E0: measure the baseline

An **arm** is one configuration in a comparison. E0 uses four adapters within each embedding space. The reranker and autocut settings affect the gbrain-backed adapters; keyword and vector baselines remain comparators.

The probe generator's nominal target is 500 with `CAT13_PROBES` unset. The recorded E0/E2 experiment generated 548 actual probes; use the receipt's count, not the nominal target, as the denominator. Scores are nDCG@5, precision@5 and first-place hit rate.

nDCG gives more credit when more relevant pages rank earlier. The held-out result asks whether a choice made using 20 tuning concepts also helps the other 10. Questions whose highest-grade targets span both subsets are marked mixed: they remain in the overall result but neither subset.

The historical Voyage decision space was `voyage:voyage-4` at 1024 dimensions. Its initial live cost estimate was about $0.10 and ten minutes per arm, not a spending cap.

```sh
# Set VOYAGE_API_KEY through your normal secret-management method.
export CAT13_EMBEDDING_MODEL=voyage:voyage-4
export CAT13_EMBED_DIMS=1024

# E0-V1: original ungated comparison against bare vector search.
bun eval/runner/cat13-conceptual.ts --reranker off --autocut off \
  --search-pin search.metadata_boost_gate=always

# Other settings in the original E0 matrix.
bun eval/runner/cat13-conceptual.ts --reranker off --autocut on
bun eval/runner/cat13-conceptual.ts --reranker on --autocut off
bun eval/runner/cat13-conceptual.ts --reranker on --autocut on
```

The last three commands inherit the installed metadata-gate default. At the present pin they are useful explicit reranker/cutoff combinations, but reproducing an *old ungated* cell additionally requires `--search-pin search.metadata_boost_gate=always`.

For the OpenAI space, set `CAT13_EMBEDDING_MODEL=openai:text-embedding-3-large` and `CAT13_EMBED_DIMS=1536` and use the intended same search settings. It requires `OPENAI_API_KEY`; a Voyage reranker still requires its own key.

Copy `receipt.json` and `report.json` to a uniquely named result directory after each run. The defaults under `eval/reports/cat13-conceptual/` are overwritten by later arms.

## E1: find where hybrid loses the correct page

The recorded ungated E0-V1 held-out score was **53.0 hybrid versus 60.5 vector nDCG@5**, with first-place hits **48.1% versus 65.2%**. Keyword-only scored **52.2 nDCG@5**.

That difference did not prove the embedder was the problem. The E1 localization runner compared the intermediate lists and replayed individual ranking stages. Its shared query embedding let the experiment compare the actual vector candidates with the fused ranking.

Read the saved [localization output](../../docs/benchmarks/2026-09-06-longmemeval-ranker-wave/cat13/E1-localize/localize.md) with the main report. It is a generated artifact; preserve it as emitted.

## E2: the keyword-confidence hypothesis

The proposed setting was `search.keyword_arm_confidence_floor`. For keyword scores `top` and `second`, it computed:

```text
margin_ratio = top / (top + second)
```

A single result has ratio 1.0 and an empty list 0. If the ratio fell below a selected floor, a text-vector arm had voted, and the question was not relational, the keyword and title lists received half their usual fusion weight.

The intuition was that two nearly tied keyword hits might be weak evidence. The half-weight was fixed in advance; only the floor was selected from tuning data.

### Check the wiring

```sh
CAT13_PROBES=60 bun eval/runner/cat13-kacf-calibrate.ts --stub-embed \
  --embedding-model voyage:voyage-4 --embedding-dims 1024 --max-probes 40
CAT13_PROBES=60 bun eval/runner/cat13-conceptual.ts --stub-embed --adapter gbrain \
  --embedding-model voyage:voyage-4 --embedding-dims 1024 \
  --reranker off --autocut off --keyword-arm-confidence-floor 0.6
bun test test/eval/cat13-conceptual.test.ts test/eval/cat13-kacf-calibrate.test.ts
```

A fake-vector floor is only a setup check. The receipt should echo the selected setting and show keyword-confidence metadata on every relevant fused query. Zero observed metadata with a numeric floor invalidates an arm as `kacf_missing_meta`. Zero *downweighted* queries can be a legitimate result: it means the rule never triggered.

### Select the floor once

```sh
export CAT13_EMBEDDING_MODEL=voyage:voyage-4
export CAT13_EMBED_DIMS=1024
bun eval/runner/cat13-kacf-calibrate.ts
```

The historical calibration queried only the 359 tuning probes out of 548 generated probes, with reranking and autocut off and `keywordArmConfidenceFloor: null` per call. It used the median ratio among cases whose top keyword hit was not a grade-3 answer and whose ratio was strictly between 0 and 1. Single-result and empty lists were excluded.

The saved floor was **0.6121**, chosen from **27 eligible probes**. The [calibration artifact](../../docs/benchmarks/2026-09-06-longmemeval-ranker-wave/cat13/E2-calibration/calibration.md) includes the counts, ten-bin histogram, affected correct hits and per-template medians.

The selection rule printed the CLI value to four decimal places. No eligible probes would have meant stopping and publishing that outcome, not inventing another rule.

### Evaluate the held-out decision

The original decision arm changed only the confidence floor from the ungated E0-V1 condition:

```sh
bun eval/runner/cat13-conceptual.ts --reranker off --autocut off \
  --search-pin search.metadata_boost_gate=always \
  --keyword-arm-confidence-floor 0.6121
```

Check that the receipt contains the floor in applied settings and that the observed metadata count matches the queries actually run. Compare tuning, held-out and overall results separately.

The preregistered rule required held-out hybrid nDCG@5 to reach bare-vector nDCG@5 and also required gbrain's NamedThingBench, retrieval canary and BrainBench checks to avoid regressions. These upstream checks lived in `test/fixtures/retrieval-quality/namedthing.jsonl`, `scripts/run-eval-canary.ts` and `scripts/ci-brainbench-gate.sh`.

The rule prohibited changing the floor, split or seed after inspecting held-out results. **The measured held-out score stayed 53.0, so the confidence floor did not become a default.** Preserve that failure alongside the more successful metadata-gate experiment.

## E3: allow metadata boosts only when words matched

A well-connected page can be generally important without answering a particular paraphrased question. E3 tested `search.metadata_boost_gate=lexical`, which restricts metadata boosts when only the vector search contributed candidates.

```sh
bun eval/runner/cat13-conceptual.ts --reranker off --autocut off \
  --search-pin search.metadata_boost_gate=lexical
bun eval/runner/cat13-conceptual.ts --reranker on --autocut on \
  --search-pin search.metadata_boost_gate=lexical
```

At v0.48.4.0, `lexical` is already the bundle default; writing it explicitly still documents the experiment. The held-out improvement from 53.0 to 57.8 supported this change. It did not erase the remaining gap to bare vector search in that comparison.

Generic `--search-pin` accepts nonempty `search.*` settings, with the last repeated key winning. Keys controlled by dedicated flags are rejected so those checks cannot be bypassed. Unknown upstream keys can still be ignored by gbrain: confirm the installed code implements a setting before trusting a receipt that merely echoes its name.
