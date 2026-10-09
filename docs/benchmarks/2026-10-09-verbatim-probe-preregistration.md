# Verbatim-probe wave (gbrain#6391): preregistration, paired retrieval verdict and reranker-settings extension

**Status, 2026-10-09: preregistered, not run.** Nothing below has been measured on the confirmatory set. Everything was written before any counted cell ran. The development evidence that motivated it (109 rebuilt haystacks) is described under "Background" and is excluded from no question; the confirmatory set is all 500 questions.

## Background

The Q1 scoreboard's readiness probe asks gbrain `query` for the first 300 characters of the last session's longest turn and expects that session back. On LongMemEval-S (cell `s4.gbrain-defaults.shipped-defaults`, pin 0.60.106.0) it recorded 89 of 500 misses. GBRA-71 rebuilt the 89 misses and 20 recorded hits with the shim's own path (`render_page`, `put_page` over `serve --surface starter`, doctor-gated drain). gbrain returned the target at rank 1 in all of them. The misses came from the shim's `classify_query_meta` rejecting the read:

| cause | haystacks | fixed in |
|---|---|---|
| CRAG `high_vector_match` grade omitted `top_rerank_score` (shim: `rerank_missing`) | 84 | gbrain#6391 (`crag.ts`) and the shim |
| query regex-routed to image search on a text-only install (keyword arm and expansion skipped, `vector_arm_failed`) | 4 | gbrain#6391 (`multimodal-model.ts`) |
| 73-dash setext rule overflowed `websearch_to_tsquery` (`tsquery stack too small`, both lexical arms failed) | 1 | gbrain#6391 (`sql-ranking.ts`) |

With #6391 the same 109 haystacks read 109 clean, all at rank 1. Only the image-routing and dash fixes can change which results a query returns; the CRAG fix changes metadata only.

## The question

Primary: does #6391 change gbrain's retrieval quality on conversation memory, and does it raise the readiness probe's clean rate? The expected answer is no loss on retrieval, with a gain on the subsets the fixes touch.

Extension (runs only if Sina approves the reranker-settings question raised in GBRA-66): which reranker setting is cheapest without losing retrieval quality against the shipped one?

## Held fixed

- **Data:** LongMemEval-S cleaned, Hugging Face `xiaowu0162/longmemeval-cleaned` at `98d7416c`, all 500 questions. This is development data: a pass here is development evidence, not a held-out claim.
- **Brains:** one PGLite brain per haystack, built once and shared by both arms. Each is built with `gbrain init --pglite`, shipped defaults (voyage-4 at 1,024 dimensions, `tokenmax`, `voyage:rerank-2.5`, expansion on), and the shim's `render_page` pages through `put_page` in event-time order. The drain continues until doctor reports 0 embeddings missing.
  - Both arms query the same brains. #6391 touches only the query path, which `git diff` confirms: nothing under ingest, chunking, embedding or persistence.
  - Facts extraction is off during the build (`facts` jobs not drained) in both arms. It is the dominant cost (about $6.50 per million ingested tokens, about $370 for the set), and `query` retrieval does not read facts in `tokenmax`. This deviation is recorded and identical across arms.
- **Builds:** arm A is master at #6391's merge base; arm B is #6391's head. Each brain is queried by each build's `serve --surface starter`, alternating which arm goes first per haystack.
- **Queries per haystack:**
  - the LongMemEval question (`query {query, limit: 50, autocut: false}`, the shim's fixed-evidence settings);
  - the readiness probe for the last session.

## Metrics

All metrics come from gold labels (`answer_session_ids`) or the probe's own definition. No reader or judge model is used, so the eval-model selection rules do not apply. Reranker and expansion are product defaults, not eval models.

- **Primary:** strict recall of all gold sessions at 10, the scoreboard's retrieval diagnostic. A question scores 1 when every gold session is among the first 10 cited sessions.
- **Secondary:**
  - strict recall at 5;
  - any-gold recall at 10;
  - nDCG@10 over cited sessions (binary relevance).
- **Probe:**
  - clean rate: the shim's `classify_query_meta` with the 0.60.106.0 classifier unchanged, outcome `scored`;
  - found rate: the target session among the cited sources.
- **Touched subsets, reported separately:** questions whose text the query-intent regex classifies as image, and questions or probes containing a run of 32 or more dash negations.

## Decision rule

- **No regression (B against A on 500):** both of the following, with paired counts over discordant questions:
  - strict recall@10 of B is at least A's minus 2 questions;
  - no LongMemEval question type loses more than 2 questions net.
- **Probe gain:** B's probe clean rate is higher than A's, with exact McNemar p < 0.05 on the paired probe outcomes.
- **Outcomes:**
  - `pass`: no regression and probe gain.
  - `pass_flat`: no regression, no probe gain. This is unexpected; report it and investigate.
  - `regression`: the no-regression rule fails. #6391 does not merge until it is understood.
  - `inconclusive`: more than 2% of queries error in either arm after one retry.
- **A provider error counts as a miss for its arm.** A degraded read counts for the probe clean rate only.

## Extension: reranker settings (gated on Sina's approval)

This reuses the same brains, build B, and frozen candidate lists. For each question, the 50 pre-rerank candidates (chunk text, page, order) are stored once from build B. Each cell then reranks offline through the Voyage API, with candidates truncated to the cell's count and documents trimmed with `rerank.ts`'s own trimming at the cell's token cap. This isolates the reranker setting from the rest of retrieval and needs no product knob.

- **Cells:** candidates {25, 15, 10} × document caps {1,400, 768, 512} tokens × {`rerank-2.5`, `rerank-2.5-lite`} = 18 cells, plus the reference `tokenmax` shipping setting (50 × 1,400, `rerank-2.5`).
- **Metrics:** nDCG@10 and strict recall@10 against gold sessions, and billed tokens per query from Voyage's own usage counts.
- **Rule:** a cell is acceptable when nDCG@10 is within 1.0 point of the reference and strict recall@10 is at least the reference's minus 2 questions. The cheapest acceptable cell by billed tokens is the recommendation.
- **What it decides:** it recommends; it does not change defaults. A default change is its own PR, with this result as evidence.

## Size and cost

At list prices: voyage-4 $0.06 and rerank-2.5 $0.05 per million tokens, rerank-2.5-lite $0.02, claude-haiku expansion about $0.001 per query. Token counts are measured from the rebuilt haystacks: about 115k ingested tokens per haystack, and about 42k reranked tokens per `tokenmax` query.

| step | calls | estimate |
|---|---|---|
| build 500 brains (embeddings only) | 57.5M tokens | $3.50 |
| primary queries, 2 arms × (question + probe) | 2,000 queries (rerank + expansion + query embed) | $6.20 |
| extension: 19 offline rerank cells | 9,500 rerank calls, at most 169M billed tokens (documents shorter than a cap bill less) | $6.40 at most |
| margin | | $3.90 |
| **total cap** | | **$20** (primary alone: $12) |

Compute is about 3.5 hours of ingest on a 4 vCPU machine at 3 haystacks in parallel. Queries take about 1 hour. All runs go through one budget-ledger campaign (`campaign-open --budget-usd 20`, or 12 without the extension), so the cap binds.

## Owner decisions before the counted run

1. Approve the primary run ($12 cap).
2. Approve or defer the extension (+$8 cap), which depends on Sina's answer on the reranker-settings eval.
