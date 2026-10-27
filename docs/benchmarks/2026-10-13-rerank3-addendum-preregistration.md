# Reranker settings, addendum: Voyage rerank-3 and rerank-3-lite (GBRA-86)

**Status, 2026-10-13: final; results below.** Preregistered before any counted cell of this addendum ran. No `rerank-3` or `rerank-3-lite`
result on the eval questions has been seen. A tokenizer check sent the first 5 documents of one frozen list to each
model; it read only billed tokens and latency, not rankings (all three models billed the same 3,139 tokens). Sina
approved the run with a hard cap of $5 in provider spend.

This extends [2026-10-12-rerank-settings-preregistration.md](2026-10-12-rerank-settings-preregistration.md) (merged in
gbrain-evals#141). There, none of 18 cheaper `rerank-2.5` / `rerank-2.5-lite` settings passed, so the shipped setting
(50 candidates × 1,400 tokens × `rerank-2.5`) stayed. Voyage now prices `rerank-3` like `rerank-2.5` ($0.05 per
million tokens) and `rerank-3-lite` like `rerank-2.5-lite` ($0.02), and lists the 2.5 models as older. The question
is whether either newer model gives a setting that is cheaper, faster, or both, without losing retrieval quality.

## What stays the same

Everything the first preregistration fixed: the 300 questions (`2026-10-12-rerank-settings/subset-k300.json`), the
300 PGLite brains built at gbrain master `0832f9fe`, the frozen candidate lists, the shim at `846fa6dd` with the
semantic-cache line, the replayed expansion and query embeddings, the two queries per question (real query and
readiness probe), the metrics and the decision rule.

The brains and frozen lists are the ones built for #141, kept on the run machine. Every cell call checks the reranker
request against its frozen list (SHA-256 of query and documents), as before, so a list that no longer reproduces
shows up as a mismatch and counts against the cell.

## Cells

- **Reference, re-run:** 50 × 1,400 × `rerank-2.5`, with fresh provider calls (the proxy's rerank cache is keyed
  separately for this addendum) so its latency is measured under the same conditions as the new cells. Its rankings
  should match #141's reference; any difference is reported.
- **`rerank-3`:** 50 × 1,400, 25 × 1,400, 15 × 1,400 and 25 × 512.
- **`rerank-3-lite`:** the same four.

9 cells × 600 queries = 5,400 queries. On each question all nine cells run back to back, real query then probe, so
every cell sees the same load.

## Metrics

As in the first preregistration, plus:

- **Reranker latency per query:** wall time of the Voyage rerank call measured at the proxy, from request sent to
  response received, for each of the cell's 600 calls. Reported as p50 and p95. Four workers run concurrently, as in
  #141, so this is latency under that load from the run machine, not an isolated benchmark. Calls the proxy had to
  retry (HTTP 429 or 5xx) keep their full time, retries included, and are counted.

## Decision rule

Unchanged. A cell is acceptable against the re-run reference, on the same questions, when strict recall@10 is at least
the reference's minus 2, no question type loses more than 2 net on strict recall@10, mean nDCG@10 is at least the
reference's minus 0.005, real-query and probe clean reads are each at least the reference's minus 2, and at most 2% of
its queries errored or mismatched.

**Recommendation:**

1. The acceptable cell with the lowest combined cost per query that is cheaper than the reference, with its cost cut.
   If two acceptable cells are within 5% of each other on cost, the one with the lower p50 latency wins.
2. If no cheaper cell is acceptable, an acceptable cell at the reference's cost (`rerank-3` 50 × 1,400) is recommended
   only if its p50 latency is at least 10% lower than the re-run reference's.
3. Otherwise, keep the current default.

Latency never makes an unacceptable cell acceptable.

## Size and cost

From the frozen lists (local token estimates; Voyage billed within 1% of them in #141, and `rerank-3` bills the same
tokens as `rerank-2.5`):

| cells | tokens | estimate |
|---|---|---|
| reference re-run (`rerank-2.5`) | 17.6M | $0.88 |
| `rerank-3`, four cells | 39.3M | $1.96 |
| `rerank-3-lite`, four cells | 39.3M | $0.79 |
| **total** | | **$3.63** |

No embeddings or expansion are paid: both are replayed from the cache. The proxy keeps this addendum's spend in its
own ledger and refuses any call that would take it past $4.70, under the $5 cap. All figures are estimates from
Voyage's usage counts at list price, not metered invoices. If the cap stops the run, questions without all nine cells
are dropped from every cell.

## Publication

Results are published as aggregates only: the per-cell table, per-type losses and latency percentiles
(`2026-10-13-rerank3-addendum/results/verdict.json`). No per-question rows are committed. This recommends a setting
and changes no gbrain default.

## Results (2026-10-13)

**Recommendation: `rerank-3-lite` at the shipped shape (50 candidates × 1,400 tokens). It cuts rerank cost 60%
and passes every check; its reranker latency is about the same as today's.** It is the only acceptable cell cheaper
than the reference. `rerank-3` at 50 × 1,400 also passes, but it costs the same as the reference and is not faster, so
rule 2 does not pick it. Every cell with fewer candidates fails strict recall@10 again, as in #141.

All 300 questions ran in all nine cells (5,400 queries). Every read was clean, there were no errors and no retried
provider calls, and every reranker request matched its frozen list. Aggregates: `2026-10-13-rerank3-addendum/results/verdict.json`.

| cell | strict@10 | cell-only / ref-only | strict@5 | nDCG@10 | max type loss | $ per 1k queries | cost cut | rerank p50 / p95 ms | acceptable |
|---|---|---|---|---|---|---|---|---|---|
| **reference 50×1400, rerank-2.5 (re-run)** | **299** | | **288** | **0.9591** | | **1.510** | | **232 / 596** | |
| 50×1400, rerank-3 | 298 | 0 / 1 | 291 | 0.9595 | 1 | 1.510 | 0% | 240 / 624 | yes |
| 25×1400, rerank-3 | 295 | 0 / 4 | 286 | 0.9624 | 1 | 0.764 | 49.4% | 211 / 507 | no: strict@10 |
| 15×1400, rerank-3 | 294 | 0 / 5 | 284 | 0.9605 | 4 | 0.460 | 69.5% | 198 / 491 | no: strict@10, types |
| 25×512, rerank-3 | 295 | 0 / 4 | 285 | 0.9621 | 1 | 0.633 | 58.1% | 198 / 487 | no: strict@10 |
| **50×1400, rerank-3-lite** | **298** | **0 / 1** | **289** | **0.9579** | **1** | **0.604** | **60.0%** | **251 / 604** | **yes** |
| 25×1400, rerank-3-lite | 296 | 0 / 3 | 285 | 0.9600 | 1 | 0.306 | 79.8% | 214 / 576 | no: strict@10 |
| 15×1400, rerank-3-lite | 294 | 0 / 5 | 284 | 0.9561 | 4 | 0.184 | 87.8% | 193 / 448 | no: strict@10, types |
| 25×512, rerank-3-lite | 296 | 0 / 3 | 284 | 0.9597 | 2 | 0.253 | 83.2% | 204 / 431 | no: strict@10 |

Clean reads were 300 of 300 for real queries and probes in every cell, and the probe found its session every time.
Cost averages real queries and probes; all four models bill the same tokens for the same request.

- **`rerank-3-lite` at 50 × 1,400 compared with the reference:** strict@10 −1 (one multi-session question), strict@5
  +1, nDCG@10 −0.0012. Rerank cost goes from $1.51 to $0.60 per 1,000 queries. p50 latency is 19 ms higher (+8%) and
  p95 8 ms higher. The rule doesn't count that as a latency gain, and it isn't a loss that matters next to the
  rest of a query.
- **Fewer candidates is the only real latency lever, and it costs recall.** Against the reference, 25 and 15 candidates take 8–17%
  off p50 and 3–28% off p95. Every such cell loses 3–5 questions on strict recall@10, the same pattern as with the 2.5
  models.
- **`rerank-3` ranks the top a little better:** strict@5 +3 at 50 × 1,400, the highest of any cell in either run.
  It is a quality option at today's price, not a saving.
- **How stable the reference is:** the re-run reference made fresh `rerank-2.5` calls on the same lists. Voyage's
  scores moved by up to 0.003 between runs. That reordered the top-10 sessions on 45 of 300 real queries and changed
  the set on 17, but no question flipped on strict recall@10 or @5, and nDCG@10 moved 0.0001. Single-question
  differences between cells sit inside that kind of jitter. The rule's 2-question margin covers it.

**Spend:** an estimated $3.74 of the $5 cap, all Voyage reranking (embeddings and expansion were replayed from the
cache). That's an estimate from Voyage's usage counts at list price, not metered. One more `GET /v1/models` (OpenAI) at
a serve start was refused by the proxy outside installs; it touched no query.
