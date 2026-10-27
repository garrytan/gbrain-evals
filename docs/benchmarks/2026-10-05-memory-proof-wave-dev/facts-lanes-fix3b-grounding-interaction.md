# gbrain combined lane: date grounding × temporal fact reserve, BEAM dev (dev, freeze candidate 94e9e8875, 2026-10-06)

Dev evidence on freeze candidate gbrain 94e9e8875: master e7f59913e with #6020, the wave and the temporal fact reserve.

Date grounding does not change the temporal-reserve result. With the reserve on in both arms, the default-grounding arm scores a pooled 0.685 and the grounding-false arm 0.684 (paired 48 wins, 45 losses, 267 ties). Temporal reasoning is 0.646 against 0.660 (2 / 2 / 32) and event ordering 0.425 against 0.442 (10 / 9 / 17). Round 3's reserve-on arm on 81631cffe scored 0.685 pooled, 0.660 temporal and 0.437 event ordering. Both arms land on that result.

## Setup

Both arms use the combined lane with exchange pages: facts 600, a page `token_budget` of 7,500, and an 8,000-token delivered target. The temporal fact reserve is on in both, through the read-time `search_config: {"search.temporal_fact_reserve": "true"}`. The answer model is gemini:gemini-3.8-flash, the judge gemini:gemini-3.5-flash, and extraction openai:gpt-6-luna through `extract_facts`.

- **Grounding default:** `extraction.date_grounding` is not set. It reads as unset in every brain, and this build turns it on by default.
- **Grounding false:** `gbrain_config: {"extraction.date_grounding": "false"}`. It reads as `false` in every brain.

Each arm re-extracted into its own store, because `gbrain_config` is an ingest key. `search.hub_dampening`, `facts.attribution` and `search.query_facts_arm` are unset in all six brains, so each runs at the build's default; hub dampening is off ([fix3b/cfgcheck94e9.json](facts-lanes/fix3b/cfgcheck94e9.json)).

The read-time reserve key also reads as unset there. The coverage probe that ran after every cell had finished opened the units with a provider that has no `search_config`, so it unset the key, as the provider does for any later cell without it. The cells ran with the key set: the reserve fired in every cell, and only on temporal-cue questions.

**500k and 1m, grounding false.** The sweep skipped these two cells. Their auto-tune step never ran: the ledger refused the ingest cell's $60 run budget, which was above the cap remaining at that moment. The delivered-context gate did not cause the skip. Both cells then ran at the fixed dev knobs shared by every arm (facts 600, pages 7,500), from specs written directly, against the fully extracted grounding-false stores. Both pass the delivered-context gate.

## Cells

Every gate passes in all six cells, and the proxy refused no judge call. Budgets were $12 for 100k and $20 for 500k and 1m.

| Arm | Cell | Slice | Delivered mean / p95 | Correct / n | Mean score | Cost |
|---|---|---|---|---|---|---|
| default | `beam-100k-gbrain-rag-5174edb33d22` | 100k | 8,142 / 8,274 | 57 / 80 | 0.649 | $3.34 |
| default | `beam-500k-gbrain-rag-1f688c425ab1` | 500k | 8,129 / 8,176 | 106 / 140 | 0.716 | $4.07 |
| default | `beam-1m-gbrain-rag-9aebd11a5035` | 1m | 8,138 / 8,231 | 99 / 140 | 0.674 | $4.54 |
| false | `beam-100k-gbrain-rag-3b32730d4dcd` | 100k | 8,127 / 8,251 | 60 / 80 | 0.697 | $3.37 |
| false | `beam-500k-gbrain-rag-94eb7acd6022` | 500k | 8,115 / 8,156 | 105 / 140 | 0.693 | $4.07 |
| false | `beam-1m-gbrain-rag-01f1843b5ac9` | 1m | 8,101 / 8,168 | 101 / 140 | 0.668 | $4.60 |

## Scores

| Arm | 100k | 500k | 1m | Pooled (360) |
|---|---|---|---|---|
| grounding default | 0.649 | 0.716 | 0.674 | 0.685 |
| grounding false | 0.697 | 0.693 | 0.668 | 0.684 |
| round 3 reserve on, 81631cffe (reference) | 0.663 | 0.700 | 0.681 | 0.685 |

| Category | Arm | 100k (n 8) | 500k (n 14) | 1m (n 14) | Pooled (n 36) |
|---|---|---|---|---|---|
| temporal_reasoning | default | 0.594 | 0.732 | 0.589 | 0.646 |
| temporal_reasoning | false | 0.688 | 0.714 | 0.589 | 0.660 |
| event_ordering | default | 0.476 | 0.409 | 0.410 | 0.425 |
| event_ordering | false | 0.516 | 0.405 | 0.438 | 0.442 |

Every category, pooled over the three splits, n 36 each ([fix3b/cats6.json](facts-lanes/fix3b/cats6.json)):

| Category | default | false |
|---|---|---|
| abstention | 0.764 | 0.722 |
| contradiction_resolution | 0.764 | 0.715 |
| event_ordering | 0.425 | 0.442 |
| information_extraction | 0.848 | 0.866 |
| instruction_following | 0.743 | 0.750 |
| knowledge_update | 0.590 | 0.604 |
| multi_session_reasoning | 0.651 | 0.645 |
| preference_following | 0.903 | 0.928 |
| summarization | 0.516 | 0.510 |
| temporal_reasoning | 0.646 | 0.660 |
| all | 0.685 | 0.684 |

## Paired, false to default

Wins / losses / ties by graded score per question ([fix3b/paired6.json](facts-lanes/fix3b/paired6.json)):

| | 100k | 500k | 1m | Pooled | Mean diff |
|---|---|---|---|---|---|
| all questions | 4 / 12 / 64 | 24 / 16 / 100 | 20 / 17 / 103 | 48 / 45 / 267 | +0.001 |
| temporal_reasoning | 0 / 1 / 7 | 1 / 0 / 13 | 1 / 1 / 12 | 2 / 2 / 32 | -0.014 |
| event_ordering | 1 / 2 / 5 | 3 / 3 / 8 | 6 / 4 / 4 | 10 / 9 / 17 | -0.018 |

## Reserve firing

| Arm | Slice | Questions where it fired | Fact rows per firing question | Fact-row tokens per firing question (mean / max) |
|---|---|---|---|---|
| default | 100k | 33 / 80 | 6.4 | 227 / 570 |
| default | 500k | 57 / 140 | 10.5 | 376 / 718 |
| default | 1m | 59 / 140 | 9.9 | 358 / 699 |
| false | 100k | 33 / 80 | 5.9 | 198 / 505 |
| false | 500k | 57 / 140 | 10.4 | 361 / 705 |
| false | 1m | 57 / 140 | 10.0 | 346 / 579 |

Fact rows count inside the page arm's token budget. The provider renders them without a session date header and never repeats them in the facts block.

## Event-date coverage

Coverage is the share of facts whose `valid_from` differs from the session date ([fix3b/validfrom94e9.json](facts-lanes/fix3b/validfrom94e9.json)). The build does not mark extracted dates separately.

| Arm | 100k | 500k | 1m | Within recall's newest 100 per unit |
|---|---|---|---|---|
| default | 211 / 2,413 (8.7%) | 971 / 11,533 (8.4%) | 1,374 / 27,010 (5.1%) | 3.1% to 4.1% |
| false | 0 / 2,226 | 0 / 10,456 | 0 / 24,147 | 0% |

In the default arm, 1,773 extracted dates fall before the session date and 783 after it; the median offset is 3 to 4 days earlier. Facts are counted per session through `recall`, which caps at 100 per session. That cap hit 23 sessions in the default arm and 6 in the false arm, so these counts are lower bounds.

## Spend

| Arm | Extraction, ingest and tune | Cells | Total |
|---|---|---|---|
| default | $7.06 | $11.95 | $19.01 |
| false | $5.94 | $12.04 | $17.98 |
| total | | | $36.99 |

Extraction chat with grounding on default: $0.33, $1.78 and $3.83 for 100k, 500k and 1m. With grounding false: $0.28, $1.48 and $3.22. The ledger stands at $229.99 committed of a $255 cap, with $25.01 remaining ([facts-lanes/ledger-status.json](facts-lanes/ledger-status.json)).
