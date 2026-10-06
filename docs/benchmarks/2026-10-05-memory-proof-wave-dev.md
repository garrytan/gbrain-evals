# Memory proof wave: dev phase

October 5–6, 2026. Every number on this page comes from the dev questions only. No validation or sealed question has been opened.

In plain words: before the real test, both memory systems get a practice round on questions set aside for practice. Each system gets the same reader model and the same amount of retrieved text (8,000 tokens), and a grader scores the answers. The practice round sets each system's knobs, finds where gbrain falls behind and why, and catches harness bugs before any held-out question is opened. On the long BEAM conversations gbrain first trailed by about 10 points. The cause was how the conversations were stored: as a few huge pages, of which gbrain could show only one slice each. Storing one dated page per exchange closes most of that gap. With gbrain's own fact extraction added as well, gbrain and the comparator score the same within a tenth of a point. Dates of events remain the comparator's clear edge. The practice round also showed that the planned 3-point test is noisier than assumed, so its margin or design has to change before the real run.

## What ran

Every cell uses `gemini-3.8-flash` as the answer model for both systems. BEAM cells are judged by `gemini-3.5-flash` against each question's rubric (score 0 to 1); the other datasets use their own judges. Delivered context is counted with `cl100k_base` on the exact text inserted into the prompt. A cell passes its context gate when the mean and the p95 both lie within ±10% of the target. Knobs were tuned per system and per target on retrieval-only samples (no answer or judge calls).

The questions are all dev questions:

- BEAM 100k {3, 11, 12, 15}, 500k {8, 9, 12, 21, 28, 31, 35} and 1M {1, 6, 16, 21, 22, 25, 26}, from the grouping manifest (80, 140 and 140 questions);
- the LongMemEval-S (100) and LoCoMo10 (322) dev subsets, the LifeBench dev users, the 50-question agent samples ([`subsets.json`](../../eval/harness-provider/cells/dev/subsets.json)) and PersonaMem 32k personas {0, 2, 3, 14} (93).

The systems:

- **gbrain** writes pages over stdio MCP with `voyage-4` embeddings and reads them with `query` (`return_unit: page`), with `token_budget` as the knob. The build is recorded per cell: `e8e1f66` (0.60.64.0), `2b1f5b69f` (agent mode), `b0e70f498` and `a87c3e2af` (#6066 heads with the fixes below). It runs in two lanes:
  - *raw:* conversation pages only;
  - *combined:* opt-in fact extraction with `gpt-6-luna` plus pages, the lane run by [the facts lane](2026-10-05-memory-proof-wave-dev/facts-lanes-interim.md).
- **The comparator** is its pinned current server release (0.10.2) in its best supported mode, extracted facts plus raw chunks. The fact and chunk budgets are scaled together.
- **Baselines.** *Full context* puts the whole conversation in the prompt. *Hybrid search* is dense plus sparse search over 512-token chunks with fusion, at k = 15.

Receipts for every cell (summary, cell, spec, spend and tuning files) are in [`2026-10-05-memory-proof-wave-dev/cells/`](2026-10-05-memory-proof-wave-dev/cells/), with the collected rows in [`dev-cells.json`](2026-10-05-memory-proof-wave-dev/dev-cells.json) (regenerate with `bun eval/runner/memory-proof-wave-dev-table.ts`).

## BEAM at 8,000 tokens

Mean rubric score, all three dev sizes (360 questions). "Gate" marks cells whose delivered context missed ±10% of 8,000.

| System, configuration | Build | 100k | 500k | 1M | Pooled |
|---|---|---:|---:|---:|---:|
| comparator, facts plus chunks | 0.10.2 | 0.677 | 0.668 | 0.627 | **0.654** |
| gbrain combined, exchange pages, facts 600 | a87c3e2af | 0.627 | 0.671 | 0.651 | **0.653** |
| gbrain combined, whole pages, facts 1,800 | e8e1f66 | 0.647 | 0.641 | 0.640 | 0.642 |
| gbrain raw, exchange pages | b0e70f498 | 0.622 (gate) | 0.648 (gate) | 0.634 | 0.637 |
| gbrain raw, exchange pages | a87c3e2af | 0.645 (gate) | 0.650 (gate) | 0.649 | 0.648 |
| gbrain raw, whole pages | e8e1f66 | 0.603 | 0.569 | 0.516 | 0.556 |
| gbrain raw, whole pages | a87c3e2af | 0.599 | 0.565 | 0.537 | 0.562 |
| hybrid search, k 15 | | 0.620 | | | |
| full context | | 0.809 (145k tokens) | 0.774 (511k tokens) | | |

The combined a87c cells pass the delivered-token gate. Four of their judge calls, at 100k and 500k, were refused by tight per-cell budgets and scored 0, so those two cells fail `complete`. Without the refused rows, 100k is about 0.643 and 500k about 0.676.

Accuracy rises with budget for both systems:

| | 4k | 8k | 16k | 32k | System default |
|---|---:|---:|---:|---:|---|
| gbrain raw, whole pages, 100k / 500k / 1M | 0.604 / 0.547 / 0.537 | 0.603 / 0.569 / 0.516 | 0.632 / 0.600 / 0.580 | 0.650 / 0.640 / 0.597 | 0.638 / 0.634 / 0.603 (23.5k tokens) |
| comparator, 100k / 500k / 1M | 0.554 / 0.641 / 0.582 | 0.677 / 0.668 / 0.627 | 0.738 / 0.717 / 0.649 | 0.728 / 0.746 / not run | 0.727 / 0.762 / 0.683 (31k–36k tokens) |

### Where gbrain trails, by category

Pooled over the three sizes, n = 36 per category, mean score:

| Category | gbrain raw, whole pages | gbrain raw, exchange pages (b0e7) | gbrain combined, whole pages | comparator |
|---|---:|---:|---:|---:|
| temporal reasoning | 0.32 | 0.47 | 0.47 | **0.72** |
| event ordering | 0.39 | 0.36 | 0.48 | **0.52** |
| information extraction | 0.46 | 0.56 | **0.72** | 0.62 |
| knowledge update | 0.49 | **0.76** | 0.57 | 0.63 |
| multi-session reasoning | 0.55 | 0.63 | 0.61 | **0.67** |
| abstention | 0.72 | 0.78 | 0.78 | **0.82** |
| contradiction resolution | 0.67 | **0.75** | 0.74 | 0.65 |
| instruction following | 0.60 | 0.67 | **0.68** | 0.62 |
| preference following | 0.85 | 0.89 | **0.89** | 0.76 |
| summarization | 0.51 | 0.50 | 0.48 | **0.55** |

### Why: ingest granularity and one excerpt per page

The harness hands each BEAM conversation over as 5 to 26 documents of about 100,000 characters (about 25,000 tokens, half a session each). Each one becomes one gbrain page, and the session date appears only once, at its first turn.

`query` keeps one chunk per page in its candidate set. With return unit `chunk` it returns 7.8 chunks from 7.7 distinct pages per question at 100k, and page delivery anchors one excerpt per page.

A retrieval-only proxy measures where the evidence goes missing. The proxy evidence is the exchange that best matches the question plus its rubric (BM25). The proxy tracks the score: questions where that exchange's user turn reaches the context score 0.75, those where it does not score 0.49.

| 100k, 8k budget | Evidence text delivered | Evidence page delivered | Answered |
|---|---:|---:|---:|
| `return_unit: page` (whole pages) | 43% | 88% | 0.603 |
| `window` | 51% | 88% | 0.605 |
| `section` | 44% | 88% | not run |
| `chunk` | 33% | 97% | not run: delivers 4.9k |
| one dated page per exchange | 53% | 57% | 0.603 (e8e1) |

`detail: high` and `autocut: false` change nothing.

There are 25 non-abstention questions at 100k and 500k where the comparator scored 0.75 or more and gbrain raw 0.25 or less:

- in 11, gbrain delivered the evidence page but not the evidence span (delivery);
- in 8, it did not deliver the page (ranking);
- in 6, it delivered the span and still answered wrongly, mostly temporal questions that need a second dated event.

Exchange pages are BEAM's per-dataset ingest config for gbrain (`page_split: "exchanges"`, one page per user turn plus its replies, dated with the session date). The comparator already chunks internally and keeps the documents as they come. The config gains 8 to 12 points at 500k and 1M and little at 100k. It lifts knowledge update, temporal reasoning and contradiction resolution, and costs some event ordering.

On builds before a87c, raw exchange pages delivered about 6.9k tokens on average, because `query` returned only 6 to 13 rows. a87c sizes rows to the budget, yet raw exchange cells at 100k and 500k still average 6.9k–7.3k, short of the gate, so gbrain gets slightly less context than the comparator there. The combined lane reaches 8.1k.

### Fact dates

On e8e1 and a87c, every fact's `valid_from` equals its source session date: 16,295 of 16,295 facts on BEAM dev. gbrain's extractor wrote no event date. Printing each fact's date changed nothing: pooled 0.636 with dates, 0.642 without. The temporal gap needs an extracted event date and fact recall ranked by the question. Build `505a65aab` adds both a fact `valid_from` from the extractor and a query facts arm; its combined-lane cells were still running when this page was written.

## Public datasets at 8,000 tokens

| Dataset | gbrain | comparator |
|---|---|---|
| LongMemEval-S (100 q) | raw 0.900, all gates pass (a87c3e2af); combined 0.80 (e8e1) | raw 0.860 (passes); combined 0.940 and facts 0.910, both with p95 above the gate |
| LoCoMo10 (322 q) | raw 0.814 (passes); combined 0.904 (passes) | raw 0.792 (passes); combined 0.851 and facts 0.839, both with p95 above the gate |
| PersonaMem 32k (93 q) | raw 0.849 (passes, a87c3e2af) | not run |

The comparator's facts and combined lanes vary more question to question: on LongMemEval their p95 runs about 1.25 times the mean. No knob setting puts both mean and p95 inside ±10%, so those cells ran at the setting whose mean is nearest the target and are reported as missing the gate. The comparator has no raw-only lane on BEAM. With the fact budget at 0, recall returns no results, and the harness renders chunks only under recalled facts.

## Agent modes (descriptive)

Agentic RAG lets the reader retrieve in rounds. Agent mode hands the question to the system's own synthesis: gbrain `think`, the comparator's reflect. Both run on `gemini-3.8-flash`. Agentic rounds deliver far more than 8,000 tokens, so those rows miss the gate by design and are descriptive only.

| Sample (50 q) | gbrain agentic RAG | comparator agentic RAG | gbrain agent | comparator agent |
|---|---:|---:|---:|---:|
| LoCoMo | 0.90 | 0.84 | 0.84 | 0.86 |
| LifeBench | 0.86 | 0.82 | 0.86 | 0.88 |
| LongMemEval | 0.86 (one history did not ingest on 2b1f) | 0.88 | 0.68 (one history did not ingest on 2b1f) | 0.78 |

## C1 and gate 3

**C1, the evidence date header.** No dev gain, so validation stays closed for C1.

| | off | on |
|---|---:|---:|
| BEAM 100k | 0.588 | 0.586 |
| BEAM 500k | 0.586 | 0.586 |
| BEAM 1M | 0.530 | not rerun after the restarts |

**Gate 3, entity anchoring** (`search.entity_anchoring`, a87c3e2af, raw lane). Anchoring fired on 0 of 495 dev questions: LongMemEval knowledge-update and temporal 0/42, PersonaMem 0/93, BEAM 100k 0/80, 500k 0/140 and 1M 0/140. These are retrieval-only probes that read `entity_anchored` on every row. Anchoring needs an entity page whose title the query names, and raw brains hold only conversation pages. The off arms scored 0.905 (LongMemEval subset) and 0.849 (PersonaMem). There is nothing to confirm on validation.

## Power at the adopted margin

[`memory-proof-wave-dev-power.ts`](../../eval/runner/memory-proof-wave-dev-power.ts) re-estimated the variance from the dev pairs; receipts are in [`power/`](2026-10-05-memory-proof-wave-dev/power/).

| Pairing | Per-question paired variance | Conversation effect | Power at a true difference of 0, margin 3.0 | Margin for 80% power |
|---|---:|---:|---:|---:|
| gbrain raw exchange pages vs comparator | 0.185 | 3.2 points | 71–74% | 3.4 |
| gbrain raw whole pages vs comparator | | | 73–76% | 3.3 |
| power report's central assumption | 0.097 | 3.5 points | 87% | |

At the same 54 sealed conversations, a 3.5-point margin gives 82–84% and 4.0 gives 91%. The plan's rule (stop below 80%) fires: the margin or the design changes, in the preregistration, before any validation or sealed cell.

## Fix lane

**Applied as harness or provider config.**

- Exchange pages for gbrain on BEAM (above).
- Read-time `search_config` (shared stores, never inherited).
- `fact_dates`, measured with no gain.

**gbrain changes, found here, fixed in #6066:**

- A `put_pages` batch with a fenced Lua block stalled in persistence and never landed. Fixed in b0e7: the LongMemEval cell is complete on a87c.
- Repeated slugs in one batch were rejected.
- The image arm marked retrieval degraded on text-only brains.
- Budget fill on page delivery.

**gbrain changes still open, for the integration builder:**

1. **One chunk per page.** Candidates and page/window delivery keep one chunk or anchor per page. With few long pages, `chunk` returns no more chunks than there are pages, and a page gets one excerpt even when several turns match. Keep the top-k chunks within a page, at least while the page count is under `limit`, and give delivery multiple anchors per page.
2. **Under-fill on small pages.** Raw exchange pages still deliver about 6.9k of 8.1k on a87c at 100k and 500k.
3. **Event dates and question-ranked fact recall.** The extractor wrote no event date before 505a. `recall` returns the newest 100 facts and `query.saved_facts` at most 5, so temporal and event-ordering evidence does not reach the prompt.

## Harness fixes made during dev

The fixes below touch neither gbrain nor the comparator. Each comes with a test.

- **Repeated sessions are written once** for both systems. Identical repeats are deduplicated; changed repeats are kept under their own id. Both servers reject a batch that repeats an id.
- **One lock hold per gbrain query.** Opening another unit could close the queried unit's child mid-call, which produced empty `AssertionError` rows.
- **Collision-free stage file names.** LifeBench user names written in Chinese collapsed to one file, so the second user was never ingested. Ids that need replacing now carry a hash suffix, and `read_record` checks the owner.
- **Tuner changes.**
  - It steers on p95 and stops when nothing reaches the prompt.
  - `--off-target-closest` runs an untunable target at its nearest setting and reports the gate miss.
  - `--probe` runs retrieval only.
  - `--k` covers knob-less baselines.
  - `MPW_TUNE_DUMP` writes per-question delivered context for diagnosis.
- **CI guard.** The metering-proxy gbrain-child test runs only in the harness CI job.

## Coding spike

The public harness's coding benchmark runs end to end on a Capy machine with gbrain as memory: first-try fixes 5 of 6 with gbrain against 1 of 6 without. Recommendation: go ([coding-spike.md](2026-10-05-memory-proof-wave-dev/coding-spike.md)).

## Spend

The dev phase is capped at $650 of proxy-metered spend. The ledger partitions were rebalanced within that total as tracks finished.

| Ledger | Cap | Committed |
|---|---:|---:|
| local (gbrain tracks, diagnosis, full context) | $301 | $270.63 |
| VM (comparator tracks, hybrid search; closed, VM destroyed) | $158.28 | $158.28 |
| facts lanes | $165 | $127.94 (rerun on 505a running) |
| coding spike | $25 | $4.65 |
| **total** | **$649.28** | $561.50 |
