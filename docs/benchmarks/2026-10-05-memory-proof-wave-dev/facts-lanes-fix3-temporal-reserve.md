# gbrain combined lane, fix round 3: temporal fact reserve on vs off, BEAM dev (dev, gate 1, 2026-10-06)

Dev evidence for gate 1 of the preregistered decision temporal-fact-reserve: garrytan/gbrain `docs/eval/decisions/temporal-fact-reserve/`, copied to `docs/benchmarks/2026-10-05-memory-proof-wave-gbrain-verdicts/temporal-fact-reserve/preregistration.md` on `capy/mpw-gbrain-verdicts` (c39c822). The build is gbrain 81631cffe.

Gate 1 passes as the rule is written. With the key on, the arm scores higher on temporal reasoning (0.660 against 0.486; 8 wins, 0 losses, 28 ties paired), higher on event ordering (0.437 against 0.434), and higher pooled (0.685 against 0.658).

The event-ordering margin is thin: +0.003 mean, with 9 paired wins against 13 losses. One question flipping the other way would reverse that clause.

## Setup

The arms differ only in `search.temporal_fact_reserve`, set through the read-time `search_config`:

- **On:** `"true"`
- **Off:** unset

Both arms read one extraction store per split, and each split was extracted once.

The combined lane uses exchange pages. Each prompt gets a 600-token facts block from `saved_facts` and `recall`, then the page query with `token_budget` 7,500. Auto-tune toward the 8,000-token delivered target kept 600 / 7,500 in all six sweeps, so both arms ran the same knobs.

This is the combined lane's 8,000-token delivered target, with 7,500 tokens of it given to the page query. A page `token_budget` of 8,000 plus the facts block would deliver about 8.7k and miss the delivered-context gate. The reserve takes its share inside the page query's budget.

The answer model is gemini:gemini-3.8-flash and the judge gemini:gemini-3.5-flash. Extraction is openai:gpt-6-luna through `extract_facts`, with the build's extraction defaults.

Every gate passes in all six cells, and the proxy refused no judge call. Cell budgets were $12 for 100k and $20 for 500k and 1m.

| Arm | Cell | Slice | Delivered mean / p95 | Page-arm tokens (mean) | Correct / n | Mean score | Cost |
|---|---|---|---|---|---|---|---|
| off | `beam-100k-gbrain-rag-e951f15252e4` | 100k | 8,131 / 8,273 | 7,323 | 58 / 80 | 0.657 | $2.25 |
| off | `beam-500k-gbrain-rag-c2eeecc3a3a5` | 500k | 8,122 / 8,170 | 7,339 | 97 / 140 | 0.650 | $4.07 |
| off | `beam-1m-gbrain-rag-1c1c8d970079` | 1m | 8,142 / 8,214 | 7,311 | 100 / 140 | 0.667 | $4.61 |
| on | `beam-100k-gbrain-rag-05ee197b0e99` | 100k | 8,136 / 8,272 | 7,322 | 57 / 80 | 0.663 | $2.17 |
| on | `beam-500k-gbrain-rag-8763b1ef988b` | 500k | 8,133 / 8,180 | 7,336 | 106 / 140 | 0.700 | $4.01 |
| on | `beam-1m-gbrain-rag-18f8768c12b3` | 1m | 8,151 / 8,231 | 7,308 | 103 / 140 | 0.681 | $5.32 |

## Scores

| Arm | 100k | 500k | 1m | Pooled (360) |
|---|---|---|---|---|
| on | 0.663 | 0.700 | 0.681 | 0.685 |
| off | 0.657 | 0.650 | 0.667 | 0.658 |
| comparator combined (reference) | 0.677 | 0.668 | 0.627 | 0.654 |

| Category | Arm | 100k (n 8) | 500k (n 14) | 1m (n 14) | Pooled (n 36) |
|---|---|---|---|---|---|
| temporal_reasoning | on | 0.688 | 0.714 | 0.589 | 0.660 |
| temporal_reasoning | off | 0.312 | 0.643 | 0.429 | 0.486 |
| event_ordering | on | 0.420 | 0.454 | 0.428 | 0.437 |
| event_ordering | off | 0.401 | 0.449 | 0.438 | 0.434 |

Every category, pooled over the three splits, n 36 each ([fix3/cats5.json](facts-lanes/fix3/cats5.json)):

| Category | on | off |
|---|---|---|
| abstention | 0.694 | 0.750 |
| contradiction_resolution | 0.771 | 0.743 |
| event_ordering | 0.437 | 0.434 |
| information_extraction | 0.834 | 0.830 |
| instruction_following | 0.745 | 0.718 |
| knowledge_update | 0.632 | 0.590 |
| multi_session_reasoning | 0.660 | 0.605 |
| preference_following | 0.914 | 0.912 |
| summarization | 0.498 | 0.517 |
| temporal_reasoning | 0.660 | 0.486 |
| all | 0.685 | 0.658 |

## Paired, off to on

Wins / losses / ties by graded score per question ([fix3/paired5.json](facts-lanes/fix3/paired5.json)):

| | 100k | 500k | 1m | Pooled | Mean diff |
|---|---|---|---|---|---|
| all questions | 13 / 13 / 54 | 22 / 13 / 105 | 16 / 17 / 107 | 51 / 43 / 266 | +0.026 |
| temporal_reasoning | 4 / 0 / 4 | 1 / 0 / 13 | 3 / 0 / 11 | 8 / 0 / 28 | +0.174 |
| event_ordering | 3 / 3 / 2 | 4 / 6 / 4 | 2 / 4 / 8 | 9 / 13 / 14 | +0.003 |

## Win rule

The preregistered rule: paired over the same questions, the key-on arm scores higher on temporal reasoning and higher on event ordering, and its pooled score is not lower.

- **Temporal reasoning:** higher, +0.174 (8 / 0 / 28).
- **Event ordering:** higher, +0.003 (9 / 13 / 14). This passes on the mean but not on the win count.
- **Pooled:** 0.685 against 0.658, not lower.

Gate 1 passes. Gate 2 is reported separately by the gbrain lane. The preregistration makes the key default-on only if both gates pass.

## Reserve firing

This comes from the retrieval meta. The provider records each `query` fact row (`fact_rows`) and its cl100k tokens (`fact_row_tokens`). Temporal-cue counts use a reimplementation of the preregistered cue list ([fix3/cue.json](facts-lanes/fix3/cue.json)).

| Slice | Questions | With a temporal cue | Reserve fired | Fact rows per firing question | Fact-row tokens per firing question (mean / max) |
|---|---|---|---|---|---|
| 100k | 80 | 40 | 34 | 5.0 | 163 / 498 |
| 500k | 140 | 60 | 55 | 9.4 | 303 / 647 |
| 1m | 140 | 68 | 53 | 8.1 | 270 / 583 |

- It never fired on a question without a cue, and never in the off arm.
- It fired on 34 of 36 temporal_reasoning questions (8/8, 12/14 and 14/14) and on 18 of 36 event_ordering questions. The rest were other categories with a temporal word.
- Fact rows count inside the page arm. Page-arm `tokens_delivered` stays about 7,310 to 7,340 in both arms, so the facts displace page text rather than adding to it.
- The rows render as `[observed unknown; valid <date> to unknown]` followed by the fact, with no session date header. Of the 170, 516 and 431 rendered fact rows, none also appears in the facts block. The combined lane drops any fact the page arm already delivered.
- Every extracted fact here carries a `valid_from` far from its `created_at` (the session date, set at ingest), so the preregistration's "real date" bonus of +0.1 applies to all of them alike.

## Spend

This round cost $27.29: off $15.56 (extraction, tuning and cells, $4.63 of it ingest) and on $11.73 (tuning and cells on the shared stores). The ledger stands at $193.00 committed of a $235 cap, with $42.00 remaining ([facts-lanes/ledger-status.json](facts-lanes/ledger-status.json)). The preregistration's $10 cap is for the gbrain lane's own runs. This lane's spend is reported here.
