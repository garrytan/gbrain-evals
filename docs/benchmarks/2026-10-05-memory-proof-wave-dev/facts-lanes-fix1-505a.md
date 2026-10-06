# gbrain combined lane on 505a65aab, BEAM dev (2026-10-06)

On gbrain 505a65aab, the combined lane with exchange pages (facts 600, pages 7500) scores a pooled 0.661 over the 360 BEAM dev questions. Every cell passes every gate. The comparator's combined lane scores 0.654 pooled. gbrain leads on 500k and 1m, trails on 100k, and still trails on temporal_reasoning, 0.500 against 0.72.

Answer model gemini:gemini-3.8-flash. Judge gemini:gemini-3.5-flash. Target 8,000 delivered cl100k tokens. Extraction is openai:gpt-6-luna through `extract_facts`, run on whole documents into a fresh 505a65aab store.

## Cells

| Cell | Slice | Delivered mean / p95 | Correct / n | Mean score | Gates | Cost |
|---|---|---|---|---|---|---|
| `beam-100k-gbrain-rag-17e85b266ad3` | 100k | 8,130 / 8,275 | 55 / 80 | 0.636 | pass | $2.16 |
| `beam-500k-gbrain-rag-1564910a0528` | 500k | 8,124 / 8,174 | 103 / 140 | 0.676 | pass | $4.10 |
| `beam-1m-gbrain-rag-0c4104c4ef0e` | 1m | 8,142 / 8,199 | 100 / 140 | 0.659 | pass | $4.57 |

Per-cell budgets were $12 for 100k and $20 for 500k and 1m. The proxy refused no judge call.

| Arm | 100k | 500k | 1m | Pooled (360) |
|---|---|---|---|---|
| Comparator combined | 0.677 | 0.668 | 0.627 | 0.654 |
| gbrain 505a65aab, exchanges, f600 | 0.636 | 0.676 | 0.659 | 0.661 |
| gbrain a87c3e2af, exchanges, f600 | 0.627 | 0.671 | 0.651 | 0.653 |
| gbrain e8e1f66, whole sessions, f1800 | 0.647 | 0.641 | 0.640 | 0.642 |

## valid_from coverage

On 505a65aab, 0% of facts carry a date different from their session date: 0 of 1,353 on 100k, 0 of 5,598 on 500k and 0 of 9,283 on 1m. The same holds for the 100 facts `recall` returns per conversation ([fix1/validfrom505.json](facts-lanes/fix1/validfrom505.json)).

The `valid_from` change in this build is for `remember`, which now takes a caller-supplied `valid_from`. `extract_facts` still has no date field in its schema, so its facts keep the session date the ingest passes.

## Query facts arm

`search.query_facts_arm` is on, but it added no fact rows in any of the 360 combined retrievals. The arm only appends facts into free row slots and into token budget the pages leave unused. On this build the page query fills its `token_budget`, so no spare budget remains at 7,500 page tokens. The provider now renders fact rows without the session date header and drops facts it already delivered as fact rows from the facts block (`page_fact_rows` in the retrieval meta). With no fact rows, that path did not fire in these cells. The 6, 14 and 10 `Date: unknown` blocks per cell are facts-block groups of saved facts whose source session is outside `recall`'s 100 newest. None are page or fact rows.

## Automatic extraction

As on a87c3e2af, `put_pages` makes no chat request. The extractor calls equal the windows exactly: 365 on 100k, 1,985 on 500k and 4,627 on 1m. Extraction chat cost $0.21, $1.09 and $2.24.

## Per category

Mean score, pooled over the 3 splits (n 36 per category, 360 overall), from [fix1/cats3.json](facts-lanes/fix1/cats3.json).

| Category | e8e1 whole f1800 | a87c exch f600 | 505a exch f600 |
|---|---|---|---|
| abstention | 0.778 | 0.708 | 0.736 |
| contradiction_resolution | 0.740 | 0.747 | 0.760 |
| event_ordering | 0.483 | 0.448 | 0.402 |
| information_extraction | 0.721 | 0.861 | 0.839 |
| instruction_following | 0.676 | 0.738 | 0.750 |
| knowledge_update | 0.569 | 0.576 | 0.604 |
| multi_session_reasoning | 0.608 | 0.600 | 0.621 |
| preference_following | 0.891 | 0.867 | 0.902 |
| summarization | 0.481 | 0.510 | 0.492 |
| temporal_reasoning | 0.472 | 0.479 | 0.500 |
| all | 0.642 | 0.653 | 0.661 |

The comparator's pooled temporal_reasoning is 0.72 (n 36). There is no comparator per-category table in this lane.

## Paired temporal_reasoning

| Pair | 100k (n 8) | 500k (n 14) | 1m (n 14) | All questions, mean diff per split |
|---|---|---|---|---|
| a87c exch f600 to 505a exch f600 | 0 / 0 / 8 | 0 / 0 / 14 | 1 / 0 / 13 | +0.009, +0.005, +0.008 |
| e8e1 whole f1800 to 505a exch f600 | 2 / 3 / 3 | 2 / 0 / 12 | 1 / 1 / 12 | -0.011, +0.035, +0.019 |

Each cell is wins / losses / ties by graded score ([fix1/paired3.json](facts-lanes/fix1/paired3.json)).

## Cost

This round cost $15.46 ($115.01 before, $130.47 after). The ledger cap is $165, set from the local partition, with $34.53 remaining ([facts-lanes/ledger-status.json](facts-lanes/ledger-status.json)).
