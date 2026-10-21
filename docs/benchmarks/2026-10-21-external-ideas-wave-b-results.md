# External ideas wave B on LongMemEval-S: results (GBRA-162)

## The finding

Neither reranker-stage option beats the release default on LongMemEval-S retrieval, so both stay default-off and no
answer-accuracy run starts. Measured 2026-10-21 at gbrain `capy/gbra162-wave-b-fusion`
`ae9d0f2ab2397b3c9f6b484fcd349cf5507a7bcc` against the
[preregistration](2026-10-21-external-ideas-wave-b-preregistration.md) committed first (gbrain-evals `9a613ceb`).

- **B1, `search.reranker.document=titled`, fails.** recall_all@5 is 450 of 470 (95.7%) against the default's 451 (96.0%).
  It gains 1 question and loses 2, one-sided sign test p = 0.875. It passes the ranking-shapes guard (92.9% hit@1), but
  the rule needs both. NDCG@10 is 0.003 higher, which is a secondary and doesn't gate. With 3 discordant questions the
  test can't resolve a small effect in either direction, so this is "no gain shown", not proof of no effect.
- **B2, `search.reranker.fuse=rrf`, fails and is a negative result.** recall_all@5 drops to 439 (93.4%): it gains 3 and
  loses 15, p = 0.999. NDCG@10 drops 0.012. It had already failed the guard (65.7% hit@1).
- **B3, both options, fails and is a negative result.** recall_all@5 is 439 (93.4%): it gains 4 and loses 16, p = 0.999.
  It had already failed the guard (64.3% hit@1).

The fusion losses sit almost entirely in temporal-reasoning (10 of B2's 15 losses) and multi-session (5 of 15)
questions. Those questions need every one of several sessions in the top 5. RRF pulls back first-pass rows the reranker
had demoted, and those rows push a second gold session out of the top 5. At top 10 the same sessions are still
retrieved: recall_all@10 is 464 for B0, B2 and B3 alike. So fusion reorders the head and doesn't lose candidates.

The default isn't at the preregistered ceiling: B0's recall_all@5 is 96.0%, below the 98% line.

## The concrete case

[LongMemEval](https://github.com/xiaowu0162/LongMemEval) gives each question a haystack of about 50 chat sessions. A few
of them (the gold sessions) hold the evidence. gbrain imports the haystack into a fresh in-memory brain, searches with the
question, and the scorer checks whether the gold sessions come back. A single-session question such as "What degree did
I graduate with?" needs one session. A multi-session or temporal question, such as how many days passed between two
events the user mentioned in different chats, needs every gold session in the result. A system missing any one of them
can only guess.

The two options change only the reranker stage. gbrain's balanced mode takes the top 30 hybrid (vector plus keyword)
candidates and sends them to a hosted reranker (`voyage:rerank-3-lite`), then orders the head by the reranker's scores.
`titled` sends `<page title>\n<chunk>` (plus the page's date when it has one) to the reranker instead of the bare chunk.
`rrf` orders the head by reciprocal-rank fusion of the reranker's order and the first-pass order (k = 60, equal weights)
instead of the reranker's order alone.

## The experiment and results

**Corpus and denominator.** LongMemEval-S cleaned, SHA-256 `d6f21ea9…c3a442`. The 470 non-abstention questions; ids
file SHA-256 `9b56ee39…54b8c`. Each arm ran at `--top-k 5` (recall) and `--top-k 10` (NDCG@10). All 470 questions are
scored in all 8 runs.

**Arms.** All use the release configuration: balanced mode, reranker on, autocut off, `voyage:voyage-4` embeddings at
1,024 dimensions. B0 adds no flags. B1 adds `--reranker-document titled`, B2 adds `--reranker-fuse rrf`, and B3 adds both.

| arm | recall_all@5 | recall_any@5 | NDCG@10 | recall_all@10 | gained / lost vs B0 (recall_all@5) | p (one-sided) | Holm threshold | guard hit@1 | verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| B0 default | 451 (96.0%) | 467 (99.4%) | 0.9661 | 464 (98.7%) | — | — | — | 91.4% | comparator |
| B1 titled | 450 (95.7%) | 468 (99.6%) | 0.9694 | 463 (98.5%) | 1 / 2 (net −1) | 0.875 | 0.0167 | 92.9% | fail (recall) |
| B2 rrf | 439 (93.4%) | 463 (98.5%) | 0.9545 | 464 (98.7%) | 3 / 15 (net −12) | 0.9993 | 0.05 | 65.7% | fail (recall and guard) |
| B3 both | 439 (93.4%) | 465 (98.9%) | 0.9541 | 464 (98.7%) | 4 / 16 (net −12) | 0.9987 | 0.025 | 64.3% | fail (recall and guard) |

Holm thresholds follow ascending p: B1 (0.875) gets 0.05/3, B3 0.05/2 and B2 0.05. No arm clears its threshold, and no
arm has a positive net. The guard numbers were measured before the preregistration at gbrain `ddae38dd`, where the
ranking code is the same as at `ae9d0f2a`. They are copied from it.

On NDCG@10, B1 scores higher than B0 on 20 questions and lower on 11. B2 scores higher on 38 and lower on 66, and B3 on
37 and 63. These counts are descriptive; secondaries don't gate.

**recall_all@5 by question type.**

| type | n | B0 | B1 | B2 | B3 |
|---|---:|---:|---:|---:|---:|
| knowledge-update | 72 | 71 | 71 | 72 | 72 |
| multi-session | 121 | 117 | 116 | 113 | 111 |
| single-session-assistant | 56 | 56 | 56 | 56 | 56 |
| single-session-preference | 30 | 29 | 29 | 29 | 29 |
| single-session-user | 64 | 62 | 63 | 63 | 63 |
| temporal-reasoning | 127 | 116 | 115 | 106 | 108 |

B1's discordant questions are one single-session-user gain (`ccb36322`) and one multi-session loss (`2788b940`) plus one
temporal-reasoning loss (`9a707b82`). Every question's hit on every arm is in
[`per-question.csv`](2026-10-21-external-ideas-wave-b/per-question.csv).

**Validity checks, all passed before scoring.**

- 470 distinct question rows in each of the 8 runs.
- 0 errored rows, and `reranker_skipped_rows` is 0 in all 32 shard summaries.
- Every row has `search_meta.reranked: true` and an empty `search_meta.degraded`. That's 0% bad rows against the 2%
  invalidation line, so nothing was rerun.
- The eight `retrieval_config_hash` values (four arms × two top-k) are all distinct:

| arm | top-k 5 | top-k 10 |
|---|---|---|
| B0 | `547b4e81…` | `be35597c…` |
| B1 | `7e9a6ea0…` | `c8dce37b…` |
| B2 | `9c2880a7…` | `3c50bf4c…` |
| B3 | `74cf3f51…` | `5e7a257e…` |

Each arm's four shards share their hash. Full values are in
[`run-summaries.ndjson`](2026-10-21-external-ideas-wave-b/run-summaries.ndjson).

## What to use and what to avoid

Keep the default (`replace` / `chunk`). Don't enable `fuse=rrf` on its own or combined with titled. It costs 12
evidence-complete questions on LongMemEval-S, and it drops ranking-shapes hit@1 by about 26 points. The preregistration
fixed unweighted RRF at k = 60, and no weight or k sweep was run on scored data, so this result covers that fusion only.

`document=titled` costs about 4% more reranker tokens (6.59M against 6.33M per run). It shows no recall gain on this set.
It shows a +1.5 point guard gain (1 question of 70) and a +0.003 NDCG@10 gain, and both are within noise. Leave it
default-off. This benchmark is a weak test of it. The LongMemEval adapter writes each session with a date, an opaque
session id and no heading, so pages have no meaningful title and titled mostly adds the session date. A future claim for
it needs a corpus where page titles carry information the chunk lacks.

**Limits.**

- This is development evidence. LongMemEval-S was used in earlier gbrain tuning, so even a pass wouldn't be a held-out
  claim.
- No answer model ran. These are retrieval numbers only.
- The test can resolve only large effects. At the smallest Holm threshold, a pass needs 6–0 at 6 discordant questions.

## Deviations from the run plan

- **Sharding.** Each run was split into 4 round-robin question shards (ids `[s::4]`, 118/118/117/117), run in parallel.
  Each shard had its own embedding cache and `GBRAIN_HOME`. LongMemEval builds a separate brain per question, so
  sharding doesn't change any question's retrieval. The four shards' union is the 470-id file, and the per-arm hash is
  the same across shards.
- **Spend stop.** The driver's automatic stop never armed. Its spend helper crashed on call-log rows whose
  `input_tokens` is the string `unknown` (cache-hit rows), and the guard then read an empty total. Spend was instead
  tracked by hand after the first runs ($3.58 after B0) and stayed far below the cap. The final total, recomputed after
  the run while skipping non-numeric token counts, is below. The driver is preserved as
  [`drive.sh`](2026-10-21-external-ideas-wave-b/drive.sh) with the bug intact.

## Reproduce and inspect

From a gbrain checkout at `ae9d0f2a`, with `VOYAGE_API_KEY` set, Bun 1.4.3,
`GBRAIN_EMBEDDING_MODEL=voyage:voyage-4` and `GBRAIN_EMBEDDING_DIMENSIONS=1024`:

```bash
bun run src/cli.ts eval longmemeval longmemeval_s_cleaned.json --retrieval-only --by-type --no-trajectory \
  --mode balanced --reranker on --autocut off --question-ids lme-s-470.txt --top-k 5 \
  --embed-cache embed.sqlite --output B0-k5.ndjson
# B1: add --reranker-document titled; B2: --reranker-fuse rrf; B3: both. Repeat each with --top-k 10.
```

Scoring: [`score.py`](2026-10-21-external-ideas-wave-b/score.py) produced
[`score.json`](2026-10-21-external-ideas-wave-b/score.json). It computes recall from the rows' `recall_all_hit` /
`recall_any_hit` and NDCG@10 from `retrieved_session_ids`. It counts bad rows as misses and applies the paired exact
sign test with Holm.

**Time.** 5,190 s wall clock for all 8 runs. The first run (B0 at top-k 5) embedded every haystack cold, at about
2,700 s per shard in parallel. Each later run read the cache (25,740 hits and 0 misses per shard) and took about 350 s.

**Cost.** $4.38 at list price from `GBRAIN_AI_CALL_LOG` token counts, including the 2-question smoke run
([`spend.json`](2026-10-21-external-ideas-wave-b/spend.json)). That breaks down as $3.33 for document embeddings
(55.5M tokens, once), $1.03 for reranks (8 runs × 470 calls, 51.7M tokens) and $0.01 for the smoke run. The
ranking-shapes guard cost about $0.11 more. These are estimates from usage counts, not a provider invoice. The
preflight upper bound was about $7.30; reranks came in at half the bound because it assumed 3 characters per token and
the 25 largest chunks.

## Changelog

### 2026-10-21: first results

Added the wave B LongMemEval-S retrieval results for the titled and RRF reranker options against the preregistration
at `9a613ceb`. Every treatment arm fails, and both options stay default-off.
