# Memory proof wave: dev phase (interim)

**Interim, October 5, 2026.** This page is a progress snapshot of the dev phase, pushed while cells are still running. Numbers can change as reruns land, and nothing here is a validation or sealed result.

In plain words: before the real test, both memory systems get a practice round on questions set aside for practice. Each system gets the same reader model and the same amount of retrieved text (a "context budget" of 4,000, 8,000, 16,000 or 32,000 tokens), and a grader scores the answers. The practice round sets each system's knobs, shows where gbrain falls behind, and catches harness bugs before any held-out question is opened. So far the comparator scores higher than gbrain on the BEAM practice conversations at most budgets, by 7 to 11 points at 8,000 tokens. On the LongMemEval and LoCoMo practice questions the two are within a few points of each other.

## What ran

Every cell uses `gemini-3.8-flash` as the answer model for both systems. BEAM cells are judged by `gemini-3.5-flash` against each question's rubric (score 0 to 1). The other datasets use their own judges. Delivered context is counted with `cl100k_base` on the exact text inserted into the prompt. A cell passes its context gate when the mean and the p95 both lie within ±10% of the target. Knobs were tuned per system and per target on a retrieval-only sample (no answer or judge calls). The question sets are dev only:

- BEAM conversations 100k {3, 11, 12, 15}, 500k {8, 9, 12, 21, 28, 31, 35} and 1M {1, 6, 16, 21, 22, 25, 26}, from the grouping manifest;
- the LongMemEval-S and LoCoMo10 dev subsets and the LifeBench dev users, from `eval/harness-provider/cells/dev/subsets.json`.

- **gbrain**, raw lane, is build `e8e1f66` (0.60.64.0, `put_pages`). It writes conversation pages over stdio MCP with `voyage-4` embeddings and reads them with `query` (`return_unit: page`), with `token_budget` as the knob. Agent-mode cells use build `2b1f5b69f`, which adds the Google base-URL override.
- **The comparator** is its pinned current server release, in its best supported mode: extracted facts plus raw chunks (`combined`). The knobs are the fact and chunk budgets, scaled together.
- **Baselines.** Full context puts the whole conversation in the prompt. Hybrid search is dense plus sparse search over 512-token chunks with fusion, at k = 15.

Receipts for every cell (summary, cell, spec, spend and tuning files) are in [`2026-10-05-memory-proof-wave-dev/cells/`](2026-10-05-memory-proof-wave-dev/cells/), and the collected rows are in [`dev-cells.json`](2026-10-05-memory-proof-wave-dev/dev-cells.json). Regenerate them with `bun eval/runner/memory-proof-wave-dev-table.ts`.

## Results so far

### BEAM dev, accuracy against delivered tokens

Mean rubric score. Every cell listed passed all four gates (complete, no answer or retrieval failures, delivered context, no remote clamp), except where noted.

| Slice | System | 4k | 8k | 16k | 32k | System default (tokens) |
|---|---|---:|---:|---:|---:|---|
| 100k (80 q) | gbrain raw | 0.604 | 0.603 | 0.632 | 0.650 | 0.638 (23.6k) |
| 100k | comparator combined | 0.554 | 0.677 | 0.738 | 0.728 | 0.727 (30.8k) |
| 100k | hybrid search, k 15 |  | 0.620 (7.6k) |  |  |  |
| 100k | full context |  |  |  |  | 0.809 (145k) |
| 500k (140 q) | gbrain raw | 0.547 | 0.569 | 0.600 | 0.640 | 0.634 (23.5k) |
| 500k | comparator combined | 0.641 | 0.668 | 0.717 | 0.746 | 0.762 (35.1k) |
| 500k | full context |  |  |  |  | 0.774 (511k) |
| 1M (140 q) | gbrain raw | 0.537 | 0.516 | 0.580 | 0.597 | 0.603 / 0.576 (23.5k, two runs) |
| 1M | comparator combined | 0.582 | 0.627 | 0.649 | running | 0.683 (35.9k) |

The comparator's facts-only lane at 8k scores 0.599 (100k), 0.690 (500k; its p95 misses the gate) and 0.622 (1M). The comparator has no raw-only lane on BEAM: with the fact budget at 0, its recall returns no results, and the harness renders chunks only under recalled facts, so nothing reaches the prompt.

gbrain's facts lanes (opt-in extraction, run in a separate lane) score 0.647 on BEAM 100k combined at 8k (57 of 80 correct) and pass every gate. That is 3 points behind the comparator's 0.677, against 7 points for gbrain's raw lane. Their receipts land with that lane's branch.

### Public dev subsets at 8k

| Dataset | gbrain | comparator |
|---|---|---|
| LongMemEval-S (100 q) | raw 0.90. One history never finished ingesting (gbrain finding 2), so the cell fails `complete`. | raw 0.85, facts 0.90, combined 0.94. Each misses one history to a duplicate document id (fixed since) and is rerunning. Facts and combined also miss the p95 gate. |
| LoCoMo10 (322 q) | raw 0.814 (passes), combined 0.904 (facts lane, passes) | raw 0.792 (passes); combined 0.851 and facts 0.839 miss the p95 gate |
| LifeBench agent sample (50 q) | running | agent 0.88; agentic RAG 0.82 (its rounds deliver 23k on average, beyond the gate) |
| LongMemEval agent sample (50 q) | running | agent 0.78 |
| LoCoMo agent sample (50 q) | running | agent 0.86; agentic RAG 0.84 (12.5k delivered, misses the gate) |

### C1, the evidence date header

The date-header switch makes no difference on dev. Off against on scores 0.588 against 0.586 on BEAM 100k and 0.586 against 0.586 on BEAM 500k. BEAM 1M off scores 0.530, and its on arm is running. With no temporal gain on dev, the validation ids stay closed for C1.

## Fix lane (where gbrain trails, with diagnosis)

1. **BEAM retrieval quality at fixed budget.** At 8k, gbrain's raw lane trails the comparator by 7.4 (100k), 9.9 (500k) and 11.1 (1M) points. It also trails hybrid search over plain chunks at 100k (0.603 against 0.620). gbrain's accuracy rises with budget (0.60 to 0.65 at 100k) and its default packs about 23.5k tokens. So the evidence exists in the brain but ranks too low to fit in 8k. Per-category breakdowns are next.
2. **A `put_pages` batch can stall in persistence and never land.** One LongMemEval history (unit `u-8fb4ff03473f`) contains a fenced Lua code block. The chunker logs "lua: semantic parsing unavailable (Parsing failed)", and then `[persistence] phase=preparation reason=deadline_exceeded` repeats until the 900-second barrier gives up. The failure reproduces on builds `e8e1f66` and `2b1f5b69f`.
3. **`put_pages` rejects a batch that repeats a slug.** LongMemEval histories list some sessions twice. The harness now writes an identical repeat once, but gbrain could also accept identical repeats in one batch.
4. **The image-search arm reports a degraded vector arm on text-only brains.** A question that mentions photos makes gbrain try a cross-modal arm, which fails with `voyage-4`. gbrain records `vector_arm_failed` while the text arm still answers. The harness treats this as non-fatal.

## Harness fixes made during dev

The harness fixes below do not change gbrain or the comparator. Each comes with a test.

- **Repeated sessions are written once** for both systems (identical repeats deduplicated, changed repeats kept under their own id).
- **One lock hold per gbrain query.** With `max_open_units: 1`, opening another unit could close the queried unit's child mid-call, producing empty `AssertionError` rows.
- **Stage file names are collision-free.** LifeBench user names written in Chinese collapsed to one file, so the second user was never ingested. Ids that need replacing now carry a hash suffix, and `read_record` checks the record's owner.
- **The tuner steers on p95 and stops on empty context.** The driver's `--off-target-closest` runs an untunable target at the setting whose mean is nearest the target, and the cell is reported as missing the gate.

## Spend

The dev phase is capped at $650 of proxy-metered spend, split across four ledgers. Committed so far:

| Ledger | Cap | Committed |
|---|---:|---:|
| local (gbrain tracks, full context) | $265 | $186.11 |
| VM (comparator tracks, hybrid search) | $240 | $149.07 |
| facts lanes | $120 | $53.29 |
| coding spike | $25 | $4.65 |
| **total** | **$650** | **$393.12** |

The local and VM caps were rebalanced by $40 within the $650 total.

## Still running

- the comparator's BEAM 1M 32k cell and its LongMemEval reruns;
- gbrain's agentic-RAG and agent-mode cells on the three agent samples;
- C1 on BEAM 1M;
- hybrid search on BEAM 500k and 1M;
- gbrain's facts-lane receipts;
- gate 3 (entity anchoring on build `687f32569`, on against off);
- the power check on the dev pairs at margin 3.0;
- the coding-spike summary ([coding-spike.md](2026-10-05-memory-proof-wave-dev/coding-spike.md): go, first-try fixes 5 of 6 with gbrain against 1 of 6 without).
