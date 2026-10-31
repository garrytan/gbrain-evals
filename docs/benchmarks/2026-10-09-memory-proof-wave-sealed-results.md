# Memory proof wave: sealed BEAM results

On untouched BEAM conversations, gbrain answers more questions correctly than the comparator, and at the read volume the preregistration fixed it costs less per correct answer. The comparator is `memory-bank`, a memory-bank server with background extraction and reflection ([comparison systems](../comparison-systems.md)). Both systems get the same reader model, the same judge and the same amount of retrieved text (8,000 tokens). Over 54 sealed conversations (1,080 questions), gbrain's primary configuration scores 0.670 against the comparator's 0.644. That is 2.6 points higher, and its one-sided 95% bounds are +0.9 and +4.4 points. The preregistered outcome is **`ahead`**: the lower bound is above 0, so gbrain is measurably higher, not just within the 3.5-point margin.

The cost edge depends on how often a conversation is read after it is stored. At the preregistered 20 reads per stored conversation, gbrain's cost per correct answer is 0.63 times the comparator's (95% interval 0.57 to 0.73), so the cost claim holds. At 200 reads per stored conversation the edge is gone. The ratio is 1.01 (0.86 to 1.28), because gbrain's reads cost slightly more than the comparator's and at that volume reads outweigh gbrain's much cheaper ingest.

gbrain's pages-only arm, without extracted facts, is a secondary arm that decides nothing. It trails the comparator by 2.1 points, with bounds of −4.4 and +0.3, which is `inconclusive`. It ran in gbrain's `conservative` search mode, which leaves the reranker off. See [the raw arm's configuration](#the-raw-arm-ran-without-the-reranker).

## Results

### Primary: gbrain combined lane against the comparator

The combined lane gives gbrain opt-in fact extraction plus its page query. Scores are graded accuracy, from 0 to 1 per question, averaged.

| BEAM size | Conversations (questions) | gbrain | Comparator | Difference (points) |
|---|---:|---:|---:|---:|
| 100k | 12 (240) | 0.703 | 0.643 | +6.03 |
| 500k | 21 (420) | 0.663 | 0.641 | +2.20 |
| 1M | 21 (420) | 0.658 | 0.647 | +1.13 |
| **Pooled** | **54 (1,080)** | **0.670** | **0.644** | **+2.64** |

| Pooled statistic | Value |
|---|---|
| Estimate (standard error) | +2.64 points (1.05) |
| One-sided 95% bounds: restricted wild cluster bootstrap-t, Webb weights (decides) | lower +0.90, upper +4.41 |
| Analytic CR1 lower bound (reported only) | +0.88 |
| Stratified cluster bootstrap-t lower bound (reported only) | +0.95 |
| Paired questions won / lost / tied by gbrain | 254 / 220 / 606 |
| Outcome at margin 3.5 | **`ahead`** |

By question kind, pooled over all three sizes (108 questions each), gbrain minus comparator in points:

| Kind | Difference | gbrain won / lost |
|---|---:|---|
| Instruction following | +13.70 | 25 / 11 |
| Multi-session reasoning | +9.59 | 37 / 16 |
| Contradiction resolution | +8.80 | 52 / 20 |
| Information extraction | +5.71 | 26 / 12 |
| Preference following | +5.09 | 22 / 16 |
| Knowledge update | +3.70 | 15 / 11 |
| Summarization | −0.76 | 35 / 42 |
| Abstention | −4.63 | 4 / 10 |
| Temporal reasoning | −6.94 | 13 / 22 |
| Event ordering | −7.91 | 25 / 60 |

Questions about when things happened and in what order remain the comparator's edge, as they were in the dev phase.

### Secondary: gbrain raw lane (pages only) against the same comparator cells

| BEAM size | gbrain raw | Comparator | Difference (points) |
|---|---:|---:|---:|
| 100k | 0.668 | 0.643 | +2.48 |
| 500k | 0.595 | 0.641 | −4.56 |
| 1M | 0.625 | 0.647 | −2.17 |
| **Pooled** | **0.623** | **0.644** | **−2.07** |

The estimate is −2.07 points (standard error 1.45), with bounds of −4.40 and +0.28. The analytic CR1 lower bound is −4.49 and the stratified bootstrap-t lower bound is −5.39. gbrain won, lost and tied 229, 273 and 578 paired questions. The outcome is **`inconclusive`**, and as a secondary arm it changes nothing in the primary outcome. The 500k row includes 20 questions scored 0 because one conversation's ingest did not complete. See [incomplete rows](#incomplete-rows).

### Cost per correct answer

The preregistered formula, per system, is: cost per correct answer = (ingest dollars for a conversation ÷ R reads of that conversation + read dollars per question) ÷ graded accuracy. Ingest dollars are ingest LLM and embedding spend plus ingest CPU at $0.05 per vCPU-hour. Read dollars are query embedding, rerank, any read-time LLM call, and the answer model's input and output. All dollars are proxy-metered at list prices. The ratio is gbrain ÷ comparator. Its 95% interval comes from a paired cluster bootstrap over conversations, stratified by BEAM size (9,999 draws, seed `20261005`). A cost claim requires the whole interval at R = 20 to lie below 1.

| Reads per stored conversation (R) | gbrain combined | Comparator | Ratio (95% interval) | gbrain raw | Raw ratio (95% interval) |
|---|---:|---:|---|---:|---|
| 1 | $0.667 | $1.444 | 0.462 (0.444 to 0.481) | $0.112 | 0.078 (0.073 to 0.084) |
| **20 (preregistered)** | **$0.0599** | **$0.0948** | **0.632 (0.574 to 0.727)** | $0.0258 | 0.272 (0.254 to 0.292) |
| 200 | $0.0312 | $0.0309 | **1.009 (0.856 to 1.275)** | $0.0217 | 0.702 (0.666 to 0.739) |

At R = 20 the combined ratio is 0.81 at 100k, 0.64 at 500k and 0.61 at 1M. At 200 reads per stored conversation, gbrain combined has no cost edge. The preregistration's sensitivity wording ("1× and 10× that") can be read as R = 1 or R = 200, so both are shown.

Here is where the money goes, summed over the 54 conversations and 1,080 questions:

| | gbrain combined | gbrain raw | Comparator |
|---|---:|---:|---:|
| Ingest: LLM and embeddings | $20.27 | $2.35 | $47.13 |
| Ingest: CPU | $2.85 | $0.72 | $2.22 |
| Reads | $20.24 | $14.28 | $16.53 |

gbrain's ingest is cheaper because its fact extraction reads whole-turn windows once. The comparator calls its extraction model on every 3,000-character chunk. gbrain's reads cost more because its delivered context sits closer to the 8,000-token target (mean 8,107 to 8,126 tokens against the comparator's 7,560 to 7,846), and because it adds a query embedding and a rerank call per question.

**How each request was assigned.** The metering proxy logs every request. An answer request carries its question in its tag. Any other provider request is assigned to the conversation of the next answer request in time, because a cell stores a conversation and then asks its questions. That request is read-time when it is a query embedding (`input_type: query`) or a rerank, and ingest-time otherwise. In every cell, no ingest-type request fell between two answers of one conversation, so neither system makes an LLM call at read time that this split could have missed. Judge calls are excluded.

**CPU assumptions.** Ingest CPU is ingest wall-clock hours × the host's vCPUs × $0.05. gbrain ran on a 4-vCPU machine. The comparator ran on Ubicloud VMs whose size the receipts do not record, so they are charged at the runner's default, 16 vCPUs. CPU is 7% of gbrain combined's total and 3% of the comparator's, so the ratios barely depend on this assumption. gbrain's 1M combined ingest includes some work repeated after machine restarts. Its cell resumed under the same identity and every repeated request is counted, which slightly overstates gbrain's ingest cost.

## Descriptive rows: LongMemEval-S and LoCoMo10

These rows decide nothing. They show how the same configurations do on two public benchmarks, on questions that were not used for tuning: the 400 LongMemEval-S questions outside the dev subset, and the 8 LoCoMo10 conversations outside the dev subset (1,218 questions). Each system ran at its dev-frozen configuration, with the same reader (`gemini-3.8-flash`), judge (`gemini-3.5-flash`) and 8,000-token context target as the sealed run. Accuracy is from one joint blinded re-judge per dataset (seed `20261005`) over a fixed denominator, so an incomplete row counts as incorrect. No margin or bound is computed. The cells were first run on October 9 and their receipts were lost with the run machine ([receipts lost](#receipts-lost)), so these are reruns from the same pushed specs, and nothing from the first runs is reported.

| Dataset (questions) | gbrain combined | gbrain raw | Comparator |
|---|---:|---:|---:|
| LongMemEval-S (400) | 69.8% (279) | 80.3% (321) | 84.5% (338) |
| LoCoMo10 (1,218) | 93.3% (1,136) | 85.0% (1,035) | 83.3% (1,014) |

The comparator misses the delivered-context gate on both datasets. Its 95th-percentile context is 9,373 tokens on LongMemEval-S and 8,855 on LoCoMo10, above the 8,800 ceiling (8,000 tokens ± 10%). gbrain's cells pass, at p95 8,090 to 8,378 tokens. On LongMemEval-S, one comparator history did not finish ingesting, and its question is scored incorrect.

On LongMemEval-S, the combined lane trails gbrain's own pages-only lane by 10.5 points and abstains more often (77 abstentions against 54). The combined lane gives 1,800 of its 8,000 tokens to extracted facts and 6,300 to pages, while the raw lane gives all 8,100 to pages. On LoCoMo10, the combined lane is 8.3 points ahead of the raw lane.

**Exploratory, post hoc: removing the facts block alone closes none of that gap on one shard.** This check was chosen after the result and decides nothing. It ran combined shard 1 (100 histories) again with `facts_tokens` 0 and everything else unchanged, including the page query's 6,300-token budget and `tokenmax` mode, on a fresh ingest. The answers were judged jointly with the wave-1 shard-1 answers, whose cached judgments replayed unchanged.

| Shard 1 (100 questions) | Correct | Abstentions |
|---|---:|---:|
| gbrain combined, `facts_tokens` 0 | 71 | 16 |
| gbrain combined (wave 1) | 71 | 14 |
| gbrain raw (wave 1) | 80 | 11 |
| Comparator (wave 1) | 83 | 12 |

On this shard the combined lane trails the raw lane by 9 points. Dropping the facts block changes 8 answers, 4 gained and 4 lost, so 0 of the 9 points close. The shard holds three question types:

| Type (questions) | `facts_tokens` 0 | Combined | Raw |
|---|---|---|---|
| single-session-user (52) | 44 correct, 6 abstained | 46, 5 | 49, 4 |
| multi-session (43) | 22, 5 | 20, 4 | 26, 2 |
| single-session-user, abstention (5) | 5, 5 | 5, 5 | 5, 5 |

With no facts block, the cell delivers a mean of 6,332 tokens, against the raw lane's 8,100 of pages, so it fails the 8,000-token context gate. What remains of the gap is page space, search mode or the store. A planned second cell would have answered the same shard at 1,800 fact tokens from the new store, which would have separated the new ingest from the block. It was refused by its ledger cap (its $16 run budget exceeded the $6.77 left), and the store was destroyed with its VM, so the comparison is against the wave-1 receipts. Spend: $9.39 for the cell and $0.25 for the re-judge. Receipts are in [`2026-10-10-memory-proof-wave-lme-facts0/`](2026-10-10-memory-proof-wave-lme-facts0/).

LongMemEval-S combined ran as four cells of 100 histories each, split by history; each history is its own brain, so the split does not change what any question sees. Each shard was re-judged jointly with the raw and comparator answers to the same 100 questions.

| Cell | Spend | Cap |
|---|---:|---:|
| LongMemEval-S gbrain combined (4 shards) | $38.09 | $60 |
| LongMemEval-S gbrain raw | $7.83 | $20 |
| LongMemEval-S comparator | $61.20 | $110 |
| LongMemEval-S re-judge | $4.49 | $10 |
| LoCoMo10 gbrain combined | $15.91 | $35 |
| LoCoMo10 gbrain raw | $13.80 | $25 |
| LoCoMo10 comparator | $15.83 | $30 |
| LoCoMo10 re-judge (includes $1.77 still reserved by runs a machine restart interrupted) | $12.11 | $15 |
| **Total** | **$169.26** | **$305** |

Receipts are in [`2026-10-09-memory-proof-wave-matched/`](2026-10-09-memory-proof-wave-matched/): each cell's JSON files, ledger status and a tarball of stage records and the request log, the two re-judges, the VM record and one path redaction.

## Equivalence of the shipped build

Retrieval is equivalent; end-to-end is within noise except fact re-extraction. The check compares the freeze build `d7467d1cf` with gbrain#6066 at `d7d7686de`, pinned for the check. The [addenda](2026-10-05-memory-proof-wave-preregistration-addenda.md) planned it on the sealed cells. Those cells and stores were lost ([receipts lost](#receipts-lost)), so it ran on the public BEAM dev conversations instead: 4 conversations at 100k (80 questions) and 7 each at 500k and 1M (140 questions each). Both lanes ran at the sealed configuration, and it decides nothing.

A question counts as changed when its delivered context differs from the baseline cell's recorded context. The noise floor is four retrieval-only replays on the freeze build against the baseline's own store. The new head was replayed the same way, twice, against the baseline store: once as it was and once after the new head's `extract --stale`. The store uses PGLite, and no step ran the deferred ANN build or `reindex-vectors`. The new head then re-ingested each lane (end to end).

| Size, lane | Changed, noise floor (4 same-build replays) | Changed, new head on the baseline store | Changed, new head end to end | Correct, baseline vs new head end to end |
|---|---|---|---|---|
| 100k combined (80) | 5, 5, 9, 7 | 7, 6 | 80 | 56 vs 57 (mean 0.644 vs 0.665) |
| 100k raw (80) | 3, 2, 3, 2 | 2, 2 | 2 | 0 vs 0 of the 2 changed |
| 500k combined (140) | 10, 12, 10, 14 | 14, 11 | 140 | 100 vs 100 (0.664 vs 0.666) |
| 500k raw (140) | 1, 1, 1, 0 | 1, 1 | 0 | none changed |
| 1M combined (140) | 5, 10, 13, 10 | 7, 11 | 140 | 99 vs 97 (0.676 vs 0.652) |
| 1M raw (127 with a baseline) | 1, 1, 2, 1 | 1, 1 | 3 | 1 vs 1 of the 3 changed |

On the baseline store, the new head stays inside the same-build range at every size. Its keyword arm returns identical candidates on every question. Its vector arm changes the candidate set on 0 to 6 questions per replay, against 0 to 5 between two same-build replays, and no vector pool is underfilled. The questions whose context changed in the first of these replays were answered again and judged jointly with the baseline answers. They get the same number correct on both builds at every size and lane, except one 100k raw question (1 of 2 vs 0 of 2).

**Caveat: fact re-extraction.** End to end, every combined question changes, because re-ingesting calls the extraction model again and it writes a different fact set. The 1M combined store has 27,250 facts against 26,889, and 500k has 11,580 against 11,625. Page and chunk counts are equal on both builds at every size. The combined end-to-end rows therefore measure a new extraction as well as the new build. The check did not re-extract on the freeze build, so extraction variance and the build change cannot be separated. The raw lane has no extraction, and its end-to-end changes stay at or within one question of the same-build range.

Other checks on the new head:
- No search sets `min_trust`.
- No page or fact is quarantined or hidden by eligibility.
- The new head's ingest gate flags 3, 19 and 23 rows in the combined stores at the three sizes. They are still delivered, marked unconfirmed, with their text unchanged.
- Ingest cost stays within 2% of the baseline at every size ($5.16 against $5.11 at 1M), under the stop at 1.25 times the baseline.

Of the 1M raw baseline, 13 questions from one conversation were refused by the run's budget and have no baseline, so they are excluded.

The check cost $73.84 of its $90 cap. Receipts, per size and build, are in [`2026-10-10-memory-proof-wave-equivalence/`](2026-10-10-memory-proof-wave-equivalence/), with `report.json` from `python3 eval/harness-provider/mpw_tools/equivalence_report.py docs/benchmarks/2026-10-10-memory-proof-wave-equivalence`.

## What ran

- **Data.** BEAM 100k, 500k and 1M sealed conversations: 12 + 21 + 21 = 54 conversations, 20 questions each. These are the clusters left after the dev and validation splits ([preregistration](2026-10-05-memory-proof-wave-preregistration.md)). The sealed split was opened once, on October 6, 2026 at 21:18 UTC, against preregistration SHA-256 `6544b2014fbc63331641b5794c106a231d242e4fc8291051f12bdb46f33e5e17`, under decision `mpw-beam-ni-2026-10-06`.
- **Models.** `gemini-3.8-flash` answers for both systems and `gemini-3.5-flash` judges against each question's rubric.
- **gbrain.** The freeze build `d7467d1cf` (0.60.95.0; the declared package pin is `a865f8f`, and the loaded head is what runs), with `voyage-4` embeddings. Every page is one dated exchange. The combined lane adds `extract_facts` with `gpt-6-luna`: 600 tokens of facts plus a page query with `token_budget` 7,500. The temporal fact reserve is off, because it failed its validation win rule ([addenda](2026-10-05-memory-proof-wave-preregistration-addenda.md#temporal-fact-reserve-validation-verdict-october-7-2026)). Date grounding is at its default (on). The raw lane uses pages only, with `token_budget` 8,700.
- **Comparator.** Extracted facts plus raw chunks, its best supported mode, with knobs fitted on dev to the 8,000-token target.
- **Harness.** The public memory benchmark harness at `f618ed7b`, wrapped and audited (scorer `a424debb…`, prompt `9c547715…`, wrapper `3cdc54a5…`, the same for every sealed cell).
- **Gates.** Every cell passed its delivered-context gate (mean and p95 within ±10% of 8,000 tokens), and gbrain's remote clamp never fired.
- **Judging.** Each size was judged once more by a joint blinded re-judge. The answers of all three cells of that size went into one shuffled order with provider identifiers scrubbed. The re-judge scores are the ones above.

| Cell | Arm | Delivered context, mean / p95 (tokens) |
|---|---|---|
| `beam-100k-gbrain-rag-f3898acdbeaa` | gbrain combined | 8,107 / 8,152 |
| `beam-500k-gbrain-rag-21e0ec97c545` | gbrain combined | 8,123 / 8,194 |
| `beam-1m-gbrain-rag-93c58c7f689a` | gbrain combined | 8,126 / 8,221 |
| `beam-100k-gbrain-rag-a5a701788547` | gbrain raw | 7,281 / 8,656 |
| `beam-500k-gbrain-rag-b41c877d6332` | gbrain raw | 7,273 / 8,629 |
| `beam-1m-gbrain-rag-3ea8e56854ab` | gbrain raw | 7,328 / 8,641 |
| `beam-100k-comparator-rag-8a43989bdecb` | comparator | 7,560 / 8,401 |
| `beam-500k-comparator-rag-69c671ace78a` | comparator | 7,665 / 8,403 |
| `beam-1m-comparator-rag-2f4cdd9ae33b` | comparator | 7,846 / 8,618 |

Cell ids hash the sealed schedule. Conversation ids, schedules and per-question rows were held in custody, and were lost with the run machine on October 9, 2026 (see [receipts lost](#receipts-lost)). This page reports 1M only as the aggregates above, as the custody rule for the parser-gap decision `q2-parser-gaps-2026-10` required while it was in force.

### Incomplete rows

The preregistration marks a sealed cell incomplete, and the decision `inconclusive`, if any sealed question lacks a scored row for either system, any rubric item is unscored, or the delivered-context gate fails. An answer failure, retrieval failure or incomplete ingest scores 0 for that system and is counted by type. The analysis applies this rule before deciding.

- **Comparator, 1M.** Its final state: all 420 questions answered, none missing, $44.06 of its $45 cell budget spent. The cell's own judge left 5 questions with no valid judgment, so the cell was marked incomplete. The joint re-judge scored all 420, with no rubric item left unscored, so the rule leaves the primary decision intact.
- **gbrain raw, 500k.** One conversation's ingest stopped at the 900-second completion barrier with 142 of its chunks still unembedded (a single Voyage 502 was not recovered in time). Its 20 questions score 0 and are counted as `incomplete_ingest`. Sealed failures are never rerun. This affects only the secondary arm.
- **The re-judge budget stop.** The 1M re-judge reached its $20 run budget with 260 rubric items still to judge. The metering proxy refused them before anything was sent upstream. The re-judge was resumed into the same output with a $10 run budget. The resume sent exactly those 260 requests, all HTTP 200, for $1.25. Every item already judged was replayed from the judge cache unchanged.

### The raw arm ran without the reranker

gbrain picks a search mode when a brain is created. The raw lane gives gbrain only its embedding key, and a brain with no chat-model key gets `conservative`. The combined lane also holds the extraction model's key, so its brains get `tokenmax`. The config rows of all 108 sealed unit brains confirm this. Both lanes set the token budget, the result limit and query expansion on every call. The mode still differs in the reranker, graph signals, relational retrieval and its planner, and contextual retrieval. Every dev raw cell ran the same way. So the raw arm measures gbrain with pages only and just an embedding key. The gap between raw and combined mixes the facts block with these settings ([addendum](2026-10-05-memory-proof-wave-preregistration-addenda.md#the-raw-lane-runs-gbrains-conservative-search-mode-october-8-2026)).

Reranker exercised, per gbrain cell (from the metering proxy):

| Cell | Search mode | Reranker exercised |
|---|---|---|
| 100k combined | `tokenmax` | yes: 240 rerank requests for 240 questions, all HTTP 200 (`rerank-2.5`) |
| 500k combined | `tokenmax` | yes: 420 for 420, all HTTP 200 (`rerank-2.5`) |
| 1M combined | `tokenmax` | yes: 420 for 420, all HTTP 200 (`rerank-2.5`) |
| 100k raw | `conservative` | no: the mode disables the reranker; 0 requests, none failed |
| 500k raw | `conservative` | no: 0 requests, none failed |
| 1M raw | `conservative` | no: 0 requests, none failed |

None of the 1,060 retrieved raw rows records a skipped or failed rerank.

### Spend

The sealed primary was capped at $450. It used $211.75: $87.57 for the six gbrain cells, $78.90 for the three comparator cells (ingest included) and $45.28 for the joint re-judge. The `mpw-confirm-sealed` ledger, which also covers the validation confirmation, stands at $167.57 of its $1,165 cap.

### Receipts lost

On October 9, 2026, between 9:33 AM and 11:39 AM Pacific, the cloud machine that held custody was replaced, and every local file was lost. That covers the private grouping file, the access log, the sealed and validation ids and specs, every cell receipt and store, the re-judge outputs, the per-question rows and the budget ledgers. Everything on this page was computed, written and pushed before the loss (commit `f8444fe3`, with the analysis code in `dee6d36c`, `f0aef0fe` and `33cba827`), so the decision and aggregates stand as recorded. The full receipts the preregistration promised for after scoring cannot be published. The custody hand-off and the Q1 frozen-context export cannot happen either. On October 9 the owner chose not to search offline custody, so the sealed grouping, the sealed and validation id lists and the BEAM 1M per-question rows are unrecoverable. The BEAM 1M hold has since been released (gbrain-evals#88), but there are no 1M per-question rows left to release. The verdict stands on the aggregates on this page. With the ledgers gone, the wave's spend before the reruns is a reconstructed range of $1,031 to $1,156 ([addendum](2026-10-05-memory-proof-wave-preregistration-addenda.md#custody-and-receipts-lost-with-the-run-machine-october-9-2026)).

### Reproduce

```bash
bash eval/harness-provider/mpw-sealed-run.sh judge     # joint blinded re-judge per size
bash eval/harness-provider/mpw-sealed-run.sh analyse   # primary (combined) and secondary (raw), margin 3.5
python -m mpw_tools.sealed_cost --pair <gbrain cell>:<comparator cell>:<gbrain re-judge>:<comparator re-judge> ...  # from eval/harness-provider, in the harness venv
```

The analysis is [`memory-proof-wave-sealed-analysis.ts`](../../eval/runner/memory-proof-wave-sealed-analysis.ts) and the cost computation is [`mpw_tools/sealed_cost.py`](../../eval/harness-provider/mpw_tools/sealed_cost.py). Both read the cells from custody, which no longer exists, so the numbers on this page cannot be recomputed.

## Changelog

### 2026-10-10: Post hoc facts-block check

Added the exploratory, post hoc LongMemEval-S shard-1 rerun with `facts_tokens` 0: it closes none of the 9-point combined-to-raw gap on that shard.

### 2026-10-10: Equivalence of the shipped build

Added the gbrain#6066 equivalence check (`d7467d1cf` against `d7d7686de`) on the public BEAM dev conversations: the same-build noise floor, per-size changed-context and end-to-end counts, and the fact re-extraction caveat.

### 2026-10-10: Descriptive rows

Added LongMemEval-S and LoCoMo10 as descriptive rows, from reruns of the matched cells after the machine loss, each scored by one joint blinded re-judge.

### 2026-10-09: Custody final as unrecoverable

The owner chose not to search offline custody, so the sealed grouping, the id lists and the BEAM 1M per-question rows are recorded as unrecoverable rather than recoverable if found. The decision and aggregates are unchanged.

### 2026-10-09: Receipts lost

Added the receipts-lost section. Custody, every cell receipt and the ledgers were lost with the run machine after this page was first published. The decision and aggregates are unchanged, and the full receipts cannot be published.

### 2026-10-09: First publication

The sealed BEAM 100k + 500k + 1M results for the primary (gbrain combined) and secondary (gbrain raw) arms against the comparator: the non-inferiority outcome at margin 3.5, cost per correct answer at R = 1, 20 and 200, incomplete-row handling, the re-judge budget stop, and the raw arm's search mode and reranker lines.
