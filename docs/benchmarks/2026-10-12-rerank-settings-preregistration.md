# Reranker settings on LongMemEval-S: preregistration (GBRA-86)

**Status, 2026-10-13: final; results below.** Preregistered 2026-10-12, before any counted cell ran. The brains and frozen candidate lists were being
built when this was written (they cost embeddings and query expansion only, and no reranker call was made on them).
No reranked result from any cell below has been seen. The owner (Efficiency captain) runs this with Sina's approval
and a hard cap of $8 in provider spend.

This replaces the "Extension: reranker settings" section of
[2026-10-09-verbatim-probe-preregistration.md](2026-10-09-verbatim-probe-preregistration.md), which never ran. The
cells are the same; the decision rule, the subset and the build are new and written here.

## The question

gbrain's `tokenmax` mode reranks the top 50 fused candidates with `voyage:rerank-2.5`, each document trimmed to 1,400
tokens (`src/core/search/rerank.ts`). That call is most of the query-time provider spend. Can a smaller candidate
count, a tighter document cap or `rerank-2.5-lite` cut that cost by 50–80% without losing retrieval quality on
conversation memory?

This recommends a setting. It changes no gbrain default and no search ranking; a default change would be its own
gbrain PR with this result as evidence, and Sina decides.

## Design: retrieval once, rerank offline

Retrieval runs once per query and is frozen. Each cell then changes only the rerank call.

- **Product under test:** gbrain master `0832f9fe` (v0.60.190.0), run from source with Bun 1.4.3.
- **System:** the scoreboard's `gbrain-defaults` shim at gbrain-evals `846fa6dd`, the classifier pin used by
  gbrain-evals#120, run as a local process instead of in its container. One line is added (patch in
  `2026-10-12-rerank-settings/harness/shim-846fa6dd.patch`): after the scripted defaults, every install runs
  `gbrain config set search.cache.enabled false`. Each query is asked 19 times on the same brain, and with the
  semantic cache on, every repeat would be a cache hit that skips the reranker. In the scoreboard each query is asked
  once, so it is a cache miss there too. The reference install and every later install carry the same line, so the
  shim's resolved-configuration check still holds.
- **Brains:** one PGLite brain per haystack. Each is a clean `gbrain init --pglite` with shipped defaults (voyage-4 at
  1,024 dimensions, `tokenmax`, `voyage:rerank-2.5`, expansion with `claude-haiku-4-5-20251001`). Sessions are written
  with the shim's `render_page` through `put_page` over `serve --surface starter`, in the scoreboard sanitizer's
  ingest order, followed by the shim's doctor-gated finish (0 embeddings missing).
- **Providers:** every provider call leaves through a local metering proxy (`harness/proxy.ts`) that `provider_base_urls`
  point at, as in the scoreboard. During ingest it forwards embeddings and refuses LLM calls; in the pilot, ingest made
  no LLM call at all. Init's provider checks are forwarded.
- **Freezing:** after the build, each query runs once through the shim's `/retrieve` (`query {limit: 50, autocut:
  false}`). The proxy stores the reranker request (query and the 50 documents, already trimmed by `rerank.ts` at 1,400
  tokens) to disk and answers it with an error, so gbrain fails open; nothing before the reranker depends on its
  answer. Expansion and query-embedding responses are cached by request body.
- **Cells:** each cell asks the same query again through the shim. Expansion and query embeddings come from the cache
  (a cache miss is refused and logged), so retrieval reproduces the frozen list. The proxy checks the reranker request
  against the frozen list (SHA-256 of query and documents; a mismatch is logged and counts against the cell), keeps the
  first *n* documents, trims each with `rerank.ts`'s own `capRerankDoc` algorithm with the token ceiling set to the
  cell's cap (the 6,000-character pre-cap unchanged), and sends it with the cell's model. gbrain then places the
  unscored documents *n*+1..50 after the reranked head in fused order, which is exactly what `reranker_top_n_in = n`
  does in the product. Everything after the reranker (pinning, the confidence grade, delivery) runs as shipped, so
  each cell's read goes through the pinned shim classifier.
- **Determinism check (pilot, 3 haystacks):** asking each frozen query again after a serve restart reproduced the
  frozen list byte for byte in 6 of 6 queries, at no provider cost.

### Cells

- **Reference (current default):** 50 candidates × 1,400 tokens × `rerank-2.5`. Its request is the product's request
  unchanged.
- **Grid:** candidates {25, 15, 10} × document cap {1,400, 768, 512} tokens × {`rerank-2.5`, `rerank-2.5-lite`} =
  18 cells.

## Data

LongMemEval-S cleaned, Hugging Face `xiaowu0162/longmemeval-cleaned` at `98d7416c`. This is development data: a
pass here is development evidence, not a held-out claim.

**Subset: 300 of 500 questions** (`2026-10-12-rerank-settings/subset-k300.json`, SHA-256 `df32622259e08b23…`).
All 500 do not fit the cap: the pilot measured about $0.0079 of embeddings per haystack and about $0.0072 of
reranking per query across all 19 cells, so 500 questions with two queries each would cost about $11.75. The subset is
stratified by question type: each type gets floor(300 × share), the remainder goes to the largest fractions (ties by
type name), and within a type questions are taken in ascending `sha256('gbra86|' + question_id)`. Per type:
multi-session 80, temporal-reasoning 80, knowledge-update 47, single-session-user 42, single-session-assistant 33,
single-session-preference 18. The selection used no results.

**Fallback subset:** if, after the builds, the cell spend estimated from the frozen lists (local token estimate,
which matched Voyage's billed count within 1% on a calibration call) would pass the remaining cap, the cells run on
`subset-k250.json` instead. It is built by the same rule and is a subset of the 300. If the proxy's cap stops the run
part-way, questions without all 19 cells are dropped from every cell, so every cell is scored on the same questions.

## Queries per question

- **Real query:** the LongMemEval question text.
- **Readiness probe:** the first 300 characters of the longest turn of the last ingested session
  (`readinessProbe` in `eval/runner/memory-qa/run-systems.ts`).

Each cell runs both on every question: 600 queries per cell, 11,400 in all.

## Metrics

No reader or judge model is used, so the eval-model selection rules don't apply. The reranker and expansion are
product defaults, held fixed; expansion runs once per query and is replayed, so it is identical across cells.

- **Gold:** `answer_session_ids` for every question, including the `_abs` questions, as in gbrain-evals#120.
- **Real query, over the first cited sessions (`strictSources`):**
  - strict recall@10 (all gold sessions among the first 10), the primary metric;
  - strict recall@5;
  - nDCG@10 (binary relevance), averaged over questions;
  - clean read: the shim classifier's outcome is `scored`.
- **Probe:** clean read (same classifier) and found (the last session among the cited sources).
- **Cost:** Voyage's own billed `usage.total_tokens` for each cell's rerank calls, at list price ($0.05 per million
  for `rerank-2.5`, $0.02 for `rerank-2.5-lite`). Reported as dollars and billed tokens per query, for real queries
  and probes separately and combined. The cost cut is 1 − cell cost / reference cost on the combined figure.
- An error after one retry counts as a miss for every metric of that query.

## Decision rule

A cell is **acceptable** when all of these hold against the reference, on the same questions:

1. strict recall@10 is at least the reference's minus 2 questions;
2. no question type loses more than 2 questions net on strict recall@10;
3. mean nDCG@10 is at least the reference's minus 0.005;
4. real-query clean reads and probe clean reads are each at least the reference's minus 2;
5. the cell is valid: at most 2% of its queries errored or had a frozen-list mismatch.

**Recommendation:** the acceptable cell with the lowest combined cost per query, with its cost cut. If no grid cell
is acceptable, the recommendation is to keep the current default. strict recall@5, probe found and exact McNemar
p-values on strict recall@10 are reported for every cell as diagnostics and do not gate; a strict@5 loss of more than 3
in the recommended cell is called out.

The rule is evaluated by a script over the stored rows, and the full 19-row table is published whatever it shows.

## Size and cost

Measured in the pilot (3 haystacks), priced at list:

| step | measure | estimate |
|---|---|---|
| build 300 brains | about 131k embedded tokens each, voyage-4 at $0.06/M | $2.37 |
| freeze 600 queries | haiku expansion plus query embeddings | $0.36 |
| 19 cells × 600 queries | about 28.6k tokens per reference query, 82.5k across the nine `rerank-2.5` cells, the same for lite | $4.33 |
| pilot and calibration so far | | $0.03 |
| **total** | | **$7.09** |

The proxy refuses any call that would take the running total past $7.50, leaving $0.50 under the $8 cap. All spend
figures are estimates from the providers' usage counts at list price, not metered invoices.

## What it decides

It recommends one setting and its cost cut. It does not change gbrain's defaults or search ranking.

Not covered here: Voyage now lists `rerank-3` and `rerank-3-lite` at the same prices as `rerank-2.5` and
`rerank-2.5-lite`, and calls the 2.5 models older. They are outside the approved grid and budget; a follow-up can run
them the same way on the same frozen lists.

## Results (2026-10-13)

**No grid cell is acceptable, so the recommendation is to keep the current default** (50 candidates × 1,400 tokens ×
`rerank-2.5`). The closest cells miss by one question: every 25-candidate cell loses 3 questions on strict recall@10
(the rule allows 2) and gains none.

All 300 questions were built and frozen, and every cell ran on all 300 (600 queries per cell, 11,400 in all). Every
query read clean under the pinned classifier, none errored or needed a retry, and every reranker request matched its
frozen list. Machine-readable results: `2026-10-12-rerank-settings/results/` (`verdict.json`, `rows.ndjson`,
`spend.json`); `harness/score.ts` evaluates the rule.

| cell | strict@10 | cell-only / ref-only | strict@5 | nDCG@10 | max type loss | billed tokens per query | $ per 1k queries | cost cut | acceptable |
|---|---|---|---|---|---|---|---|---|---|
| **reference 50×1400, rerank-2.5** | **299** | | **288** | **0.9590** | | **30,209** | **1.510** | | |
| 25×1400, rerank-2.5 | 296 | 0 / 3 | 286 | 0.9598 | 1 | 15,279 | 0.764 | 49.4% | no: strict@10 |
| 25×768, rerank-2.5 | 296 | 0 / 3 | 286 | 0.9598 | 1 | 15,182 | 0.759 | 49.7% | no: strict@10 |
| 25×512, rerank-2.5 | 296 | 0 / 3 | 283 | 0.9634 | 1 | 12,657 | 0.633 | 58.1% | no: strict@10 |
| 15×1400, rerank-2.5 | 293 | 0 / 6 | 284 | 0.9556 | 4 | 9,208 | 0.460 | 69.5% | no: strict@10, types |
| 15×768, rerank-2.5 | 293 | 0 / 6 | 284 | 0.9556 | 4 | 9,158 | 0.458 | 69.7% | no: strict@10, types |
| 15×512, rerank-2.5 | 293 | 0 / 6 | 282 | 0.9581 | 4 | 7,618 | 0.381 | 74.8% | no: strict@10, types |
| 10×1400, rerank-2.5 | 293 | 0 / 6 | 285 | 0.9547 | 4 | 6,169 | 0.308 | 79.6% | no: strict@10, types |
| 10×768, rerank-2.5 | 293 | 0 / 6 | 285 | 0.9547 | 4 | 6,135 | 0.307 | 79.7% | no: strict@10, types |
| 10×512, rerank-2.5 | 293 | 0 / 6 | 281 | 0.9572 | 4 | 5,094 | 0.255 | 83.1% | no: strict@10, types |
| 25×1400, rerank-2.5-lite | 296 | 0 / 3 | 281 | 0.9562 | 1 | 15,279 | 0.306 | 79.8% | no: strict@10 |
| 25×768, rerank-2.5-lite | 296 | 0 / 3 | 281 | 0.9563 | 1 | 15,182 | 0.304 | 79.9% | no: strict@10 |
| 25×512, rerank-2.5-lite | 296 | 0 / 3 | 280 | 0.9542 | 2 | 12,657 | 0.253 | 83.2% | no: strict@10 |
| 15×1400, rerank-2.5-lite | 294 | 0 / 5 | 279 | 0.9514 | 4 | 9,208 | 0.184 | 87.8% | no: strict@10, types, nDCG |
| 15×768, rerank-2.5-lite | 294 | 0 / 5 | 279 | 0.9514 | 4 | 9,158 | 0.183 | 87.9% | no: strict@10, types, nDCG |
| 15×512, rerank-2.5-lite | 294 | 0 / 5 | 280 | 0.9482 | 4 | 7,618 | 0.152 | 89.9% | no: strict@10, types, nDCG |
| 10×1400, rerank-2.5-lite | 293 | 0 / 6 | 281 | 0.9507 | 4 | 6,169 | 0.123 | 91.8% | no: strict@10, types, nDCG |
| 10×768, rerank-2.5-lite | 293 | 0 / 6 | 281 | 0.9507 | 4 | 6,135 | 0.123 | 91.9% | no: strict@10, types, nDCG |
| 10×512, rerank-2.5-lite | 293 | 0 / 6 | 280 | 0.9481 | 4 | 5,094 | 0.102 | 93.3% | no: strict@10, types, nDCG |

Clean reads were 300 of 300 for real queries and probes in every cell, and the probe found its session in every
cell, so those checks never bind. Billed tokens average real queries and probes.

What the table says:

- **Candidate count is what costs recall; the losses only grow as the count shrinks and never reverse.** No cell
  gained a single question over the reference on strict recall@10. The 25-candidate `rerank-2.5` cells lose the same 3
  questions (one each in knowledge-update, temporal-reasoning and single-session-user); at 15 and 10 candidates the
  losses reach 6, four of them temporal-reasoning (the type rule fails at 4). The 25-candidate losses are not
  distinguishable from noise on their own (exact McNemar p = 0.25), but the rule was written to stop at 2 and they are
  one-sided.
- **The document cap is not a cost lever at 768.** Conversation chunks are mostly under 768 tokens, so 768 bills 1%
  less than 1,400 with the same rankings for `rerank-2.5` and an nDCG change of 0.0001 for lite. 512 saves about 17% more and moves strict@5 by +1 to −4.
- **`rerank-2.5-lite` holds strict@10 at 25 candidates but ranks less precisely:** strict@5 drops 7 to 9 against the
  reference, and nDCG@10 falls past the 0.005 margin at 15 and 10 candidates.
- **The cost targets are reachable only by accepting the losses:** 25×1400 `rerank-2.5` halves the cost with −3
  strict@10, −2 strict@5 and nDCG +0.0008; 25×512 `rerank-2.5-lite` cuts 83% with −3 strict@10, −8 strict@5 and
  nDCG −0.0048.

Deviations and notes:

- **Duplicate session ids:** 13 LongMemEval-S haystacks repeat a session id. The shim refuses the second write (HTTP
  409, "never partly re-ingested"), as it does in the scoreboard; the harness records it and continues, like the
  memory-qa runner. 3 of the 300 haystacks have one such refused session, identical in every cell.
- **One refused `GET /v1/models` (OpenAI)** during a cell-phase serve start; the proxy refuses OpenAI outside
  installs. It did not touch a query: every row read clean.
- **The semantic-cache line and the out-of-container shim** are as preregistered. Bun 1.4.3 replaced the image's
  1.4.2.

**Spend:** an estimated $6.33 of the $8 cap: $2.34 building 300 brains (voyage-4), $0.38 freezing 600 queries (haiku
expansion and query embeddings), $3.61 for the 19 cells. These are estimates from the providers' usage counts at list
price, not metered invoices.
