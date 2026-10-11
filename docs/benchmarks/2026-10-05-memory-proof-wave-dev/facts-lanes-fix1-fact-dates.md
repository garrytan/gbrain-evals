# gbrain combined lane, fix round 1: per-fact dates on BEAM dev (2026-10-05)

Printing each fact's own date does not move BEAM dev. This build has no fact date to print beyond the session date that already heads each fact group. Pooled over 360 questions, the mean score is 0.636 with `fact_dates` and 0.642 without it. temporal_reasoning goes from 0.472 to 0.493, and every temporal paired change is in 2 of the 8 BEAM 100k questions: 1 win and 1 loss.

gbrain build e8e1f66b8. Answer model gemini:gemini-3.8-flash. Judge gemini:gemini-3.5-flash. Target 8,000 delivered cl100k tokens. Stores and ingest are the ones in [facts-lanes-interim.md](facts-lanes-interim.md), and `fact_dates` is read-time only.

## 1. Extracted dates

For every fact in the BEAM dev stores, `valid_from` equals its source session's date: 1,388 of 1,388 facts on 100k, 5,550 of 5,550 on 500k and 9,357 of 9,357 on 1m ([fix1/validfrom.json](facts-lanes/fix1/validfrom.json)). The same holds for the 100 facts `recall` returns per conversation.

The extractor never derives an event date. gbrain's extraction schema (`fact, kind, entity, confidence, notability, metric, value, unit, period`) has no date field. The pipeline sets `valid_from` to the extracted fact's own date when one exists, else the caller's `valid_from`. The ingest passes the session date as that caller value, so every fact carries its session date. Facts are already grouped under their session's `Date:` header, so a per-line date repeats that header. It changes only the rare saved fact whose session is outside `recall`'s 100 newest facts: 6, 21 and 14 of about 8,000 to 14,000 delivered fact lines per cell were undated.

## 2. The option

`fact_dates: true` (default off) prefixes each fact line with its `valid_from` date, for example `- (2024-03-15) The user plans a trip to Kyoto.`. Session grouping stays, and the prefix counts inside `facts_tokens`. At facts 1800 this keeps about 75 facts instead of 100. At facts 600 it keeps about 25. Test: `test_facts_extraction_and_lanes` in `eval/harness-provider/tests/test_gbrain_facts.py`.

## 3. Cells

Auto-tune kept the 1800/6300 and 600/7500 splits inside the gate on every slice.

| Cell | Slice | Arm | Delivered mean / p95 | Correct / n | Mean score | Gates | Cost |
|---|---|---|---|---|---|---|---|
| `beam-100k-gbrain-rag-62572407e664` | 100k | facts 1800 + pages 6300, fact_dates | 8,106 / 8,150 | 56 / 80 | 0.640 | pass | $2.31 |
| `beam-500k-gbrain-rag-2d8a3f619a56` | 500k | facts 1800 + pages 6300, fact_dates | 8,134 / 8,166 | 96 / 140 | 0.637 | pass | $4.15 |
| `beam-1m-gbrain-rag-964cf8f16d96` | 1m | facts 1800 + pages 6300, fact_dates | 8,178 / 8,230 | 100 / 140 | 0.634 | pass | $5.45 |
| `beam-100k-gbrain-rag-e8fec4e667ca` | 100k | facts 600 + pages 7500, fact_dates | 8,067 / 8,121 | 59 / 80 | 0.676 | pass | $2.33 |
| `beam-500k-gbrain-rag-bff1efbc4c06` | 500k | facts 600 + pages 7500, fact_dates | 8,088 / 8,145 | 98 / 140 | 0.651 | pass | $4.17 |

The reference cells without fact_dates are `beam-100k-gbrain-rag-091fa4bdc37f` (0.647), `beam-500k-gbrain-rag-5e6f48723881` (0.641) and `beam-1m-gbrain-rag-a418fcfae976` (0.640) at facts 1800, and `beam-100k-gbrain-rag-88ccfaf52605` (0.664) at facts 600. There is no 500k facts 600 cell without fact_dates.

## 4. Per-category mean score

Pooled over the slices each arm ran ([fix1/cats.json](facts-lanes/fix1/cats.json) has every split). Each cell is the mean score with n in brackets.

| Category | facts 1800 (3 slices) | facts 1800 + fact_dates (3 slices) | facts 600 (100k) | facts 600 + fact_dates (100k, 500k) |
|---|---|---|---|---|
| abstention | 0.778 (36) | 0.806 (36) | 0.875 (8) | 0.955 (22) |
| contradiction_resolution | 0.740 (36) | 0.694 (36) | 0.766 (8) | 0.716 (22) |
| event_ordering | 0.483 (36) | 0.455 (36) | 0.624 (8) | 0.459 (22) |
| information_extraction | 0.721 (36) | 0.719 (36) | 0.742 (8) | 0.774 (22) |
| instruction_following | 0.676 (36) | 0.690 (36) | 0.500 (8) | 0.568 (22) |
| knowledge_update | 0.569 (36) | 0.521 (36) | 0.375 (8) | 0.500 (22) |
| multi_session_reasoning | 0.608 (36) | 0.604 (36) | 0.750 (8) | 0.623 (22) |
| preference_following | 0.891 (36) | 0.874 (36) | 1.000 (8) | 0.977 (22) |
| summarization | 0.481 (36) | 0.509 (36) | 0.536 (8) | 0.538 (22) |
| temporal_reasoning | 0.472 (36) | 0.493 (36) | 0.469 (8) | 0.489 (22) |
| all | 0.642 (360) | 0.636 (360) | 0.664 (80) | 0.660 (220) |

temporal_reasoning per split, facts 1800 then facts 1800 + fact_dates: 100k 0.375 then 0.469 (n 8), 500k 0.500 then 0.500 (n 14), 1m 0.500 then 0.500 (n 14).

## 5. Paired questions

| Pair | temporal_reasoning wins / losses / ties | Mean diff | All questions wins / losses / ties | Mean diff |
|---|---|---|---|---|
| 100k facts 1800 to + fact_dates | 1 / 1 / 6 | +0.094 | 8 / 15 / 57 | -0.007 |
| 500k facts 1800 to + fact_dates | 0 / 0 / 14 | 0 | 10 / 15 / 115 | -0.004 |
| 1m facts 1800 to + fact_dates | 0 / 0 / 14 | 0 | 19 / 20 / 101 | -0.006 |
| 100k facts 600 to + fact_dates | 1 / 1 / 6 | 0 | 9 / 8 / 63 | +0.013 |
| 100k facts 1800 to facts 600 + fact_dates | 1 / 1 / 6 | +0.094 | 12 / 12 / 56 | +0.030 |
| 500k facts 1800 to facts 600 + fact_dates | 0 / 0 / 14 | 0 | 20 / 18 / 102 | +0.010 |

Scores are per question, so a win means a higher graded score ([fix1/paired.json](facts-lanes/fix1/paired.json)). On 500k and 1m the temporal questions score the same in every arm, which means the page arm decides them. The facts block holds the 100 newest facts of the conversation, while temporal questions ask about spans between earlier events, so no rendering of those facts can supply the missing dates.

## What would close the temporal gap

The comparator renders an event time per fact because its extractor writes one. gbrain would need the same at write time: either a date field in the extraction schema, or the conversation extractor's per-segment timestamps (it parses no messages from `role: text` transcripts today). It would also need fact retrieval ranked by the question, so the relevant earlier facts reach the prompt instead of the newest 100. Both are gbrain changes, not provider options.

## Spend

This round cost $18.65 (ledger $56.05 before, $74.70 after; $45.30 remaining of $120). The full status is in [facts-lanes/ledger-status.json](facts-lanes/ledger-status.json).
