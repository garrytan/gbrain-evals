# External ideas wave B on LongMemEval-S: preregistration (GBRA-162)

**Status, 2026-10-21: preregistered before any counted cell ran.** No LongMemEval request has been made on the build
below. The only measurement taken before this file is the ranking-shapes guard listed under "Guard results measured
before this file", which is part of the decision rule and is recorded here as already known.

## Question

Do two reranker-stage options in gbrain improve LongMemEval-S retrieval over the release default?

- `search.reranker.document=titled`: the reranker reads `<page title>\n<chunk>` (with the page's document date when the
  row carries one) instead of the chunk text alone.
- `search.reranker.fuse=rrf`: the reranked head is ordered by reciprocal-rank fusion of the reranker's order and the
  first-pass (fused hybrid) order, k = 60, equal weights, ties in first-pass order, instead of the reranker's order.

Both ship default-off. A passing arm only earns an answer-accuracy run (a separate amendment); this measurement changes
no default by itself.

## Evidence class

Development evidence. LongMemEval-S has been used in earlier gbrain tuning (ranker wave, reranker settings), so a pass is
not a held-out claim.

## Build and data

- gbrain `capy/gbra162-wave-b-fusion` at `ae9d0f2ab2397b3c9f6b484fcd349cf5507a7bcc`, run from source with Bun 1.4.3.
- gbrain-evals: the commit that adds this file.
- Dataset: LongMemEval-S cleaned (`longmemeval_s_cleaned.json`, Hugging Face `xiaowu0162/longmemeval-cleaned`),
  SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`, 500 questions.
- Question set: the 470 non-abstention questions (every `question_id` not ending in `_abs`), passed as
  `--question-ids` (file SHA-256 `9b56ee3954b5ff905005ec637a69b64fe6370c9dd664c563619e1381b1554b8c`, ids in dataset order).
- Embeddings: the release default, `voyage:voyage-4` at 1,024 dimensions, through `gbrain eval longmemeval`'s
  embedding cache. The first run fills the cache; every other run reads the same vectors, so arms differ only in the
  reranker request and the order applied after it.
- No seeds: retrieval is deterministic given the cached embeddings; the reranker is a hosted model called once per query.

## Arms

All arms: `gbrain eval longmemeval <dataset> --retrieval-only --by-type --no-trajectory --mode balanced --reranker on
--autocut off --question-ids <470 ids>`, which is the release configuration (balanced mode, reranker
`voyage:rerank-3-lite` on its 30 top candidates, autocut off, relational pin 3, lexical metadata gate, collapse and rank
priors on). No reader, judge or expansion model is called, so the eval model-selection rules do not apply.

| arm | flags | role |
|---|---|---|
| B0 | (none: `replace` / `chunk`) | comparator |
| B1 | `--reranker-document titled` | treatment |
| B2 | `--reranker-fuse rrf` | treatment |
| B3 | `--reranker-fuse rrf --reranker-document titled` | treatment |

Each arm runs twice: `--top-k 5` (primary metric and recall_any@5) and `--top-k 10` (NDCG@10). Each run carries its own
`retrieval_config_hash`; the four arms' hashes must differ (checked before scoring).

## Metric and denominator

- **Primary:** recall_all@5 from the `--top-k 5` run: every gold session (`answer_session_ids`) is among the distinct
  sessions of the top 5 retrieved chunk rows. Denominator 470 questions; analysis unit the question.
- **Secondary:** recall_any@5 (same run); NDCG@10 from the `--top-k 10` run, binary relevance over the ranked distinct
  sessions (`retrieved_session_ids`, first-appearance order), ideal DCG over min(|gold|, 10) relevant sessions, averaged
  over the 470 questions.
- **Per question type:** recall_all@5 for each of the six types.
- A row that errored, or whose `search_meta` shows the reranker skipped, failed or passed through
  (`reranker_skipped_rows` > 0), counts as a miss for that arm. A run with more than 2% such rows is invalid and is
  rerun once; the rerun replaces it, and both are reported.
- **Ceiling:** if B0 recall_all@5 is at least 98%, the result says the primary metric is at its ceiling and the verdict
  rests on NDCG@10 being reported, not on recall.

## Decision rule

Per treatment arm against B0, paired on the 470 questions:

1. **Recall:** net questions gained on recall_all@5 (arm-only hits minus B0-only hits) is greater than 0, and a
   one-sided exact sign (McNemar) test on the discordant questions gives p ≤ the arm's Holm threshold across the three
   arms (0.05/3, 0.05/2, 0.05 in ascending p order).
2. **Guard:** ranking-shapes twin-aware hit@1 (`scripts/bench/ranking-shapes/run.ts`, `search` variant) is not below
   master's 91.4%.

An arm **passes** only when both hold. Minimum detectable effect: the smallest Holm threshold (0.0167) needs 6–0 at 6
discordant questions, 9–1 at 10, 13–2 at 15 and 16–4 at 20. A smaller net gain is reported as "not resolved by this
test", not as no effect. Secondaries are reported for every arm and do not gate.

### Guard results measured before this file

Measured 2026-10-21 at gbrain `ddae38dd` (the same branch; the ranking code is unchanged at `ae9d0f2a`, which only adds
config-value validation, tests and docs), balanced mode, reranker on, 70 questions, `search` variant:

| arm | twin-aware hit@1 | MRR |
|---|---:|---:|
| master `c0b30d71` | 91.4% | 0.948 |
| B0 (branch defaults; top 20 identical to master on all 210 calls) | 91.4% | 0.948 |
| B1 titled | 92.9% | 0.956 |
| B2 rrf | 65.7% | 0.796 |
| B3 both | 64.3% | 0.790 |

B2 and B3 already fail the guard, so they are reported as negative results whatever recall shows. Only B1 can pass.
The preregistered fusion is unweighted RRF at k = 60 only; no weight or k sweep is run on scored data.

## What each outcome changes

| If it wins | If it loses | If inconclusive or at the ceiling |
|---|---|---|
| B1 alone proceeds to an answer-accuracy run under a separate amendment; no default changes from this file. | The option stays default-off and the negative result is published. | Reported as not resolved; no answer-accuracy run is started on this evidence. |

## Budget

Preflight from `gbrain eval longmemeval --call-plan` at `ae9d0f2a` (upper bounds: characters / 3 per token, the 25
largest chunks per rerank call, no cache subtracted), at list price (voyage-4 $0.06 per million tokens, rerank-3-lite
$0.02 per million):

| lane | tokens (bound) | runs | estimate |
|---|---:|---:|---:|
| document embeddings (cold, once; cached for every other run) | 85.8M | 1 | $5.15 |
| query embeddings | 14k | 8 | < $0.01 |
| rerank, per run | 13.1M | 8 | $2.10 |
| **total upper bound** | | | **about $7.30** |

Hard cap **$20** for this run, counted toward GBRA-162's $220 lane cap. Spend is tracked from `GBRAIN_AI_CALL_LOG`
token counts at list price after each run; if the running total would pass $20, no further run starts and the arms not
yet run are reported as not run. These are estimates from usage counts at list price, not a provider invoice.

## Amendments

None yet.
