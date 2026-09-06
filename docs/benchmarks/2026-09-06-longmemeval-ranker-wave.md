# BrainBench: LongMemEval ranker wave (gbrain v0.48.3.0)

**Status:** DRAFT — numbers marked TBD are filled from the receipts in `docs/benchmarks/2026-09-06-longmemeval-ranker-wave/` before publication.
**Date:** 2026-09-06
**gbrain commit:** TBD (PR head SHA; the sibling pin moves to the merge SHA after landing)
**Dataset:** `xiaowu0162/longmemeval-cleaned`, `longmemeval_s_cleaned.json`, sha256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`, 500 questions, 30 abstention (`_abs`) excluded from recall denominators → 470 scored.
**Harness:** `gbrain eval longmemeval` (the in-repo command; this wave made it the receipt producer), one in-memory PGLite per run, TRUNCATE between questions, content-addressed embedding cache (`openai:text-embedding-3-large@1536`), pins recorded per row and in `run_config`.

## 1. Headline

TBD — one sentence per published claim, wins and losses. No SOTA claim is made on judged answer accuracy (protocols are not matched across systems; see §6).

## 2. What is gbrain

gbrain is a personal knowledge brain that runs locally: markdown pages indexed in Postgres or PGLite, hybrid retrieval (keyword + vector + typed-edge relational arm fused by reciprocal rank fusion, then a cross-encoder reranker on the `balanced` and `tokenmax` search modes), served to agents over CLI and MCP. Source: https://github.com/garrytan/gbrain.

## 3. What is the benchmark

LongMemEval (Wu et al.) — 500 questions over haystacks of ~50 chat sessions each, six question types, gold `answer_session_ids`. We report the official retrieval metric `recall_all@5` (every gold session inside the top-5 distinct retrieved sessions) as the headline, `recall_any@5` as a diagnostic, and, new in this wave, LLM-judged answer accuracy with the official `evaluate_qa.py` prompts (gpt-4o judge), published as gbrain's first judged number with its protocol disclosed.

## 4. Arms

| Arm | Configuration | Purpose |
|---|---|---|
| A1 | balanced, reranker off, autocut off | like-for-like with the 2026-09-02 receipt (parity gate) |
| A2 | balanced, reranker on (voyage:rerank-2.5), autocut off | reranker effect, cross-check |
| A3 | balanced, reranker off, LLM multi-query expansion (variants recorded) | the tokenmax regression reproduced |
| A4 | balanced, reranker on, autocut on (shipped default), pool captured | decision baseline; autocut floor replay source |
| dev sweep | A3 variants replayed at expansion budgets {2.0, 1.0, 0.5, 0.25} on the 40-question dev slice | knob selection (never on the decision set) |
| A3′ / A3′R | chosen budget, reranker off / `tokenmax` with reranker on | mechanism receipt / the configuration tokenmax users run |
| final | all receipted flips applied | release-configuration gate |

Decision set: 430 questions (470 minus the seed-42 dev slice of 40; `evals/longmemeval/splits-seed42.json` in gbrain). Rules are integer question counts, pre-registered in the plan.

## 5. Results — retrieval

TBD (arms table, per-type table, paired deltas on the 430 and the 470, parity gate outcome, autocut replay table, R1 relational finding and the relational-pin receipt).

## 6. Results — judged answer accuracy

TBD. Protocol: reader `TBD (provider-reported snapshot)`, reader prompt sha TBD, k=5 sessions, max_tokens 512, judge `openai:gpt-4o` at temperature 0 / max_tokens 10 with the official prompts, gold and hypothesis inside a data boundary; headline scores every ungradable question as incorrect. Comparison rows are labelled "reader-matched, protocol-unmatched" or "unverified"; no SOTA claim.

## 7. How to reproduce

```bash
mkdir -p ~/datasets/longmemeval && curl -Lo ~/datasets/longmemeval/longmemeval_s_cleaned.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
export OPENAI_API_KEY=… GBRAIN_EMBEDDING_MODEL=openai:text-embedding-3-large GBRAIN_EMBEDDING_DIMENSIONS=1536
gbrain eval longmemeval ~/datasets/longmemeval/longmemeval_s_cleaned.json \
  --retrieval-only --top-k 5 --by-type --no-trajectory --mode balanced --reranker off --autocut off \
  --embed-cache ~/.cache/gbrain-eval/longmemeval-embed.sqlite --output A1.ndjson
```
