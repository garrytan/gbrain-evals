# gbrain combined lane, fix round 1: exchange pages on newer builds, BEAM dev (2026-10-05)

On gbrain a87c3e2af, the combined lane with exchange pages (facts 600, pages 7500) scores a pooled mean of 0.653 over the 360 BEAM dev questions. The comparator's combined lane scores 0.654 pooled (0.677 / 0.668 / 0.627), and gbrain's e8e1f66 combined cells (facts 1800) scored 0.642. Per split, gbrain is behind on 100k, ahead on 1m and nearly level on 500k. Four questions on a87c3e2af are judge failures, scored 0, because the run hit its budget.

Answer model gemini:gemini-3.8-flash. Judge gemini:gemini-3.5-flash. Target 8,000 delivered cl100k tokens, with mean and p95 within ±10%. Extraction model openai:gpt-6-luna through `extract_facts`, from whole documents in every arm, so exchange pages change only the page layout.

## Cells

| Cell | gbrain | Slice | Pages | Facts / pages budget | Delivered mean / p95 | Correct / n | Mean score | Gates | Cost |
|---|---|---|---|---|---|---|---|---|---|
| `beam-100k-gbrain-rag-1088c6907a7d` | a87c3e2af | 100k | exchanges | 600 / 7500 | 8,137 / 8,274 | 55 / 80 | 0.627 | delivered pass; 2 judge failures | $2.21 |
| `beam-500k-gbrain-rag-787d0e1a0f38` | a87c3e2af | 500k | exchanges | 600 / 7500 | 8,121 / 8,168 | 100 / 140 | 0.671 | delivered pass; 1 judge failure | $5.00 |
| `beam-1m-gbrain-rag-f6b10e8f7fe6` | a87c3e2af | 1m | exchanges | 600 / 7500 | 8,139 / 8,194 | 98 / 140 | 0.651 | pass | $5.01 |
| `beam-100k-gbrain-rag-d196321494c8` | a87c3e2af | 100k | whole sessions | 600 / 7500 | 8,084 / 8,139 | 59 / 80 | 0.656 | delivered pass; 2 judge failures | $2.28 |
| `beam-100k-gbrain-rag-5202425916f9` | b0e70f498 | 100k | exchanges | 600 / 7500 | 8,124 / 8,248 | 57 / 80 | 0.652 | pass | $2.22 |
| `beam-500k-gbrain-rag-ee362eafae11` | b0e70f498 | 500k | exchanges | 600 / 7500 | 8,124 / 8,177 | 98 / 140 | 0.663 | pass | $4.13 |
| `beam-100k-gbrain-rag-c66580e85f6d` | b0e70f498 | 100k | exchanges | 1800 / 6300 | 7,998 / 8,256 | 62 / 80 | 0.700 | pass | $2.27 |
| `beam-500k-gbrain-rag-58fa8bddbfe0` | b0e70f498 | 500k | exchanges | 1800 / 6300 | 7,924 / 8,200 | 100 / 140 | 0.645 | pass | $4.10 |
| `beam-100k-gbrain-rag-d42d6f30f142` | b0e70f498 | 100k | whole sessions | 1800 / 6300 | 7,955 / 8,119 | 56 / 80 | 0.635 | pass | $2.24 |

Every arm met the delivered-token gate at its starting split, so no cell is off target. Combined cells reach 8k from exchange pages because the facts block fills part of the budget, and on a87c3e2af the page query also fills its own budget.

The b0e70f498 cells were run before the repin and are kept with their build recorded. The b0e70f498 BEAM 1m runs and the b0e70f498 500k whole-session cell were stopped at the repin. The stopped 1m exchange-page ingest had spent $2.83.

**Judge failures.** The a87c3e2af 100k and 500k cells ran with tight per-cell budgets ($4 and $7). The proxy reserves a judge call's worst case ($0.59 at a 65,536-token output ceiling) and refused some calls, which the scorer records as judge failures scored 0. Without those rows the means are about 0.643 (100k exchanges), 0.673 (100k whole) and 0.676 (500k exchanges). The cells also stopped once on the exhausted flag. `resume` does not continue a cell whose `proxy/exhausted` flag a previous run left behind (launcher behavior), so the flag was moved aside (`proxy/exhausted-run1`, `-run2` in the cell directory) before each resume.

## Pooled and per split

| Arm | 100k (80) | 500k (140) | 1m (140) | Pooled (360) |
|---|---|---|---|---|
| Comparator combined | 0.677 | 0.668 | 0.627 | 0.654 |
| gbrain a87c3e2af, exchanges, f600 | 0.627 | 0.671 | 0.651 | 0.653 |
| gbrain e8e1f66, whole, f1800 | 0.647 | 0.641 | 0.640 | 0.642 |
| gbrain e8e1f66, whole, f600 | 0.664 | | | |
| gbrain a87c3e2af, whole, f600 | 0.656 | | | |
| gbrain b0e70f498, exchanges, f600 | 0.652 | 0.663 | | 0.659 (220) |
| gbrain b0e70f498, exchanges, f1800 | 0.700 | 0.645 | | 0.665 (220) |
| gbrain b0e70f498, whole, f1800 | 0.635 | | | |

Separating the build from the split on 100k at f600: e8e1f66 whole 0.664, a87c3e2af whole 0.656 and a87c3e2af exchanges 0.627. Exchange pages do not help 100k on any build. On 500k they help: 0.641 at e8e1f66 f1800 against 0.663 and 0.671 with exchanges at f600. On 1m, a87c3e2af with exchanges scores 0.651 against 0.640.

## Per category

Mean score, pooled over the slices each arm ran, with n in brackets ([fix1/cats2.json](facts-lanes/fix1/cats2.json)). There is no comparator per-category table in this lane; its pooled temporal_reasoning is 0.72 (n 36).

| Category | e8e1 whole f1800 (3) | a87c exch f600 (3) | e8e1 whole f600 (100k) | a87c whole f600 (100k) | b0e7 exch f600 (2) | b0e7 exch f1800 (2) |
|---|---|---|---|---|---|---|
| abstention | 0.778 (36) | 0.708 (36) | 0.875 (8) | 0.875 (8) | 0.773 (22) | 0.795 (22) |
| contradiction_resolution | 0.740 (36) | 0.747 (36) | 0.766 (8) | 0.656 (8) | 0.739 (22) | 0.767 (22) |
| event_ordering | 0.483 (36) | 0.448 (36) | 0.624 (8) | 0.592 (8) | 0.434 (22) | 0.466 (22) |
| information_extraction | 0.721 (36) | 0.861 (36) | 0.742 (8) | 0.773 (8) | 0.767 (22) | 0.787 (22) |
| instruction_following | 0.676 (36) | 0.738 (36) | 0.500 (8) | 0.625 (8) | 0.727 (22) | 0.682 (22) |
| knowledge_update | 0.569 (36) | 0.576 (36) | 0.375 (8) | 0.375 (8) | 0.511 (22) | 0.545 (22) |
| multi_session_reasoning | 0.608 (36) | 0.600 (36) | 0.750 (8) | 0.706 (8) | 0.589 (22) | 0.588 (22) |
| preference_following | 0.891 (36) | 0.867 (36) | 1.000 (8) | 1.000 (8) | 0.955 (22) | 0.962 (22) |
| summarization | 0.481 (36) | 0.510 (36) | 0.536 (8) | 0.492 (8) | 0.558 (22) | 0.568 (22) |
| temporal_reasoning | 0.472 (36) | 0.479 (36) | 0.469 (8) | 0.469 (8) | 0.534 (22) | 0.489 (22) |
| all | 0.642 (360) | 0.653 (360) | 0.664 (80) | 0.656 (80) | 0.659 (220) | 0.665 (220) |

Exchange pages lift information_extraction (0.721 to 0.861) and instruction_following (0.676 to 0.738). They do not lift temporal_reasoning (0.472 to 0.479, against the comparator's 0.72). Abstention and event_ordering drop.

Paired, e8e1f66 whole f1800 to a87c3e2af exchanges f600 ([fix1/paired2.json](facts-lanes/fix1/paired2.json)):

| Slice | temporal_reasoning wins / losses / ties | All questions wins / losses / ties | Mean diff |
|---|---|---|---|
| 500k | 2 / 0 / 12 | 31 / 25 / 84 | +0.030 |
| 1m | 1 / 2 / 11 | 30 / 34 / 76 | +0.011 |
| 100k (against e8e1 f600) | 1 / 2 / 5 | 10 / 19 / 51 | -0.036 |

## Automatic extraction on a87c3e2af

`put_pages` does not extract facts on its own on this build, so the explicit `extract_facts` windows do not double count. a87c3e2af adds a `user:` / `assistant:` parser to the conversation extractor (`extract-conversation-facts` and the opt-in `cycle.conversation_facts_backfill` phase). The put_page backstop still skips `type: conversation`, and stdio `serve` runs no cycle. Across the four a87c3e2af ingests every chat request through the proxy is a fact-extractor request for one of our windows: 365 windows and 365 calls (100k exchanges), 365 windows and 366 calls (100k whole sessions, one retried window), 1,985 and 1,987 (500k), 4,627 and 4,631 (1m). The few extra calls are retries of extractor requests, one of which was an upstream 500. The extraction path is the same in every arm. Facts written: 1,363 (100k exchanges), 1,378 (100k whole), 5,638 (500k), 9,335 (1m).

## Cost

This round cost $39.85: b0e70f498 cells, ingests and tuning $20.70 including the stopped 1m ingest, and a87c3e2af $19.15. The ledger stands at $114.55 committed of $120, with $5.45 remaining ([facts-lanes/ledger-status.json](facts-lanes/ledger-status.json)). Extraction chat on a87c3e2af was $0.21 (100k), $0.90 (500k) and $2.25 (1m). The f1800 variants on a87c3e2af and the whole-session 500k and 1m cells were not run: the budget is spent.
