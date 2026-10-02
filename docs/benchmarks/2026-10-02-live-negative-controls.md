# Live negative controls for two model-backed categories

**Finding.** On October 2, 2026, at gbrain `d44296c` (v0.60.30.0), two categories that depend on live models told a deliberately degraded configuration apart from the real one, under the rule that the degraded score must be at most half the real score. In Cat 25, `think` without its trajectory data scored 0.00 against 0.84 with it. In Cat 13, vector search with hash embeddings scored a held-out nDCG@5 of 0.077 against 0.606 with Voyage embeddings. Both rules were written down before these runs ([plan, section 4](2026-10-02-paid-reruns-plan.md#4-live-negative-controls-ws3-added-before-running-them)).

## Why this matters

A benchmark that cannot score a broken configuration lower than a working one measures nothing. The August 31 audit added scripted negative controls, which prove a check can fail. These runs use the live model or embedding service, so they show that the category notices a real loss of capability, not just a scripted one. The rule is the audit's: degraded at most 0.5 times real, same fixture and seed (`NEGATIVE_CONTROL_RATIO = 0.5` in `cat25-trajectory-routing.ts`).

## Cat 25: `think` with and without trajectory data

[gbrain](https://github.com/garrytan/gbrain)'s `think` can attach dated metric readings (a "trajectory", for example ARR by month) to its prompt. Cat 25 seeds six fictional companies with dated readings and asks questions such as "What was the ARR of Acme AI in March 2026?". `claude-sonnet-4-6` at temperature 0 answers through gbrain's production `runThink`, once with `withTrajectory: true` (real) and once without (degraded). A `claude-haiku-4-5` judge scores each answer on its own against the readings.

| Probe | Degraded (no trajectory) | Real (trajectory) | Readings injected |
|---|---:|---:|---:|
| ARR, Acme | 0.00 | 1.00 | 3 |
| Team size, Foundry | 0.00 | 1.00 | 2 |
| MRR midpoint, Nimbus | 0.00 | 0.13 | 3 |
| Headcount, latest, Orbital | 0.00 | 1.00 | 3 |
| Burn rate, first reading, Quasar | 0.00 | 0.93 | 2 |
| ARR, two entities | 0.00 | 1.00 | 4 |
| **Mean** | **0.00** | **0.84** | |

The ratio is 0.00, so the control **passes**. The runner's own live gate also passed (6 of 6 probes scored, trajectory injected in all 6, real arm above its 0.6 floor). Two cautions: without the readings the model correctly says it has no figure, so the degraded arm sits at the floor and the control is easy to pass; and the MRR-midpoint probe scored 0.13 even with the readings, a weak spot the judge's rationale in the receipt describes.

## Cat 13: concept search with real and hash embeddings

Cat 13 asks concept questions over a 240-page synthetic corpus (seed 42, 181 held-out questions; see the [matched reranker comparison](2026-10-02-concept-vector-rerank.md)). The real configuration is the October 2 vector-search arm with Voyage `voyage-4` embeddings. The degraded configuration is the same arm with gbrain's deterministic hash embeddings (`--stub-embed`), which carry no meaning.

| Configuration | Held-out nDCG@5 | Held-out exact target first | All 548: nDCG@5 |
|---|---:|---:|---:|
| Voyage embeddings (real) | 0.6058 | 118 of 181 | 0.5957 |
| Hash embeddings (degraded) | 0.0771 | 7 of 181 | 0.0930 |

The ratio is 0.127, under the 0.5 limit, so the control **passes**: concept search depends on the embedding model, and the category sees it.

## Reproduce

```bash
bun eval/runner/cat25-trajectory-routing.ts                        # ANTHROPIC_API_KEY
bun eval/runner/cat13-conceptual.ts --stub-embed --adapter vector --reranker off \
  --embedding-model voyage:voyage-4 --embedding-dims 1024 --autocut off \
  --seed 42 --tuning-concepts 20 --holdout-concepts 10             # no key
```

Cat 25 took about a minute; the runner does not meter spend, and from 12 answer calls and 12 judge calls we estimate under $0.30 and count $0.40 against the budget. The Cat 13 control is free. The real Cat 13 arm is the October 2 receipt in [the reranker comparison folder](2026-10-02-concept-vector-rerank/vector.receipt.json.gz). Artifacts: [Cat 25 receipt](2026-10-02-live-negative-controls/cat25-receipt.json), its report and run log, and the gzipped [Cat 13 hash-embedding receipt](2026-10-02-live-negative-controls/cat13-vector-hash-embeddings.receipt.json.gz).
