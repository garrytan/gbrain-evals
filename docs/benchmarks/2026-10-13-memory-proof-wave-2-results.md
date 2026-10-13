# Memory proof wave 2: confirmation results

gbrain's question-ranked combined lane (`combined-v2`) passes every counted gate in wave 2. On LongMemEval-S it beats the old combined lane by 14 points and is non-inferior to pages alone. On 72 BEAM conversations it is ahead of the old combined lane and ahead of the memory-bank server it was compared against. Adaptive W5, the whole-page ranking cut, passes its BEAM gate at factor 1.50, so it ships on. That factor was picked after the dev re-tune, when the preregistered rule was amended. The amendment is stated with the W5 result below.

Everything here ran at gbrain [`71b6d85`](https://github.com/garrytan/gbrain/commit/71b6d85bce8bf80aacec2dffe96e29cf0202c8d2), PR #6445's head with adaptive W5 and the one-call recall fill fix. The [preregistration](2026-10-10-memory-proof-wave-2-preregistration.md) and its [addenda](2026-10-10-memory-proof-wave-2-preregistration-addenda.md) fix the lanes, gates and statistics. The addenda record every change before the cells it governs ran.

## Gates

| Gate | Comparison | Estimate (points) | Bounds | Margin | Outcome |
|---|---|---:|---|---:|---|
| 1 | LongMemEval-S, `combined-v2` − `combined-v1@pin` | +14.00 | lower +10.96 | beats (> 0) | **pass** |
| 1 | LongMemEval-S, `combined-v2` − `raw@pin` | +2.75 | lower −0.87 | −2 | **pass** |
| 2 | BEAM pooled, `combined-v2` − `combined-v1@pin` | +1.62 | +0.49 to +2.79 | −2 | **pass, ahead** |
| 3 | BEAM pooled, `combined-v2` − the comparator | +3.97 | +2.63 to +5.33 | −3.5 | **pass, ahead** |
| W5 | BEAM pooled, `combined-v2+w5` − `combined-v2` | −0.25 | −1.00 to +0.49 | −3 | **pass** (TC6 below) |
| 4 | W3 rerank gate | | | | failed (A15: no skippable queries) |
| 5 | Cost per correct answer, gbrain ÷ the comparator, R = 20 | 0.750 | 0.727 to 0.773 | below 1 | **pass** |

Gate 1 uses questions as the unit: a one-sided 95% paired bootstrap-t bound with 9,999 draws and seed `20261010`. Gates 2, 3 and W5 use wave 1's restricted wild cluster bootstrap-t: conversations as clusters, stratified by BEAM size, Webb weights, 9,999 draws, seed `20261010`. Every counted cell passes the delivered-context gate, which requires mean and p95 within 7,200 to 8,800 cl100k tokens.

## Scores

Scores are graded accuracy times 100, from one joint blinded re-judge per group with `gemini-3.5-flash`. The groups are four LongMemEval-S shards of 100 questions and five BEAM groups. `gemini-3.8-flash` answers for every lane.

| Lane | LongMemEval-S (400) | BEAM-100K (320) | BEAM-500K (560) | BEAM-1M (560) | BEAM pooled (1,440) |
|---|---:|---:|---:|---:|---:|
| `combined-v2` | 82.50 | 73.26 | 69.38 | 70.07 | **70.51** |
| `combined-v2+w5` (factor 1.50) | | 72.41 | 69.72 | 69.56 | 70.26 |
| `combined-v1@pin` | 68.50 | 71.31 | 67.73 | 68.65 | 68.88 |
| `raw@pin` | 79.75 | | | | |
| `recall-one-call` (descriptive) | 83.00 | | | | |
| The comparator | 85.75 (wave-1 answers) | 66.59 | 66.27 | 66.78 | 66.54 |

**LongMemEval-S against the comparator.** `combined-v2` trails the comparator's wave-1 answers by 3.25 points (one-sided lower bound −6.97). This row decides nothing. Those answers come from a wave-1 cell that missed its delivered-context gate (p95 9,373 tokens), so they were scored on more context than gbrain's 8,000.

**One call against two.** `recall-one-call` is gbrain's single `recall(question, query)` packing both arms. It scores 83.00 against 82.50 for the two-call lane (+0.50, lower bound −0.70). With the recall fill fix it delivers its budget: means 8,163 to 8,170 tokens and p95 at most 8,223, where at the dev pin it delivered 6,753.

## W5: the adaptive whole-page cut

**How the factor was picked.** On dev, every factor (1.00, 1.25 and 1.50) beat the W5-off reference on LongMemEval-S and on pooled BEAM. Every factor also passed delivered context and completeness. Each missed the preregistered multi-session condition by exactly one question: 17 correct against the 18 required. The rule therefore picked no factor. After seeing those dev results, Garry amended the rule to confirm at factor 1.50, the rule's own tie-break pick on pooled BEAM ([amendment](2026-10-10-memory-proof-wave-2-preregistration-addenda.md#amendment-after-the-re-tune-w5-confirms-at-factor-150-october-12-2026)).

**What it does.** With `search.page_rank_cut: whole_pages`, a page-unit call with a caller budget stops adding pages once their whole delivered pages fill factor × budget. Ranking lifts the mode's chunk-token cut on those calls. Delivered context moves from a mean of 8,059–8,073 tokens with W5 off to 7,999–8,036 with it on.

**Gate.** The pooled difference is −0.25 points, with a lower bound of −1.00 against the −3 margin. No TC6 kind's two-sided 95% interval lies entirely below −3:

| Kind (144 questions each) | W5 on − off | 95% interval |
|---|---:|---|
| Multi-session reasoning | −0.12 | −3.51 to +3.28 |
| Contradiction resolution | −0.43 | −2.93 to +2.09 |
| Temporal reasoning | −0.52 | −4.53 to +3.25 |
| Event ordering | −0.38 | −2.23 to +1.49 |
| Abstention | +3.13 | +0.16 to +6.20 |

**Result.** W5 passes, and the default flips on at factor 1.50. On BEAM it costs nothing measurable and gains nothing measurable. On LongMemEval-S dev, factor 1.50 scored 3 points above W5 off.

**Ship rule.** The preregistered rule in [W5 gate on BEAM](2026-10-10-memory-proof-wave-2-preregistration-addenda.md#w5-gate-on-beam) reads: "**A pass flips the default.** The W5 key ships on, at the dev-chosen ratio. A failure keeps it off, and the result is reported as measured." The amendment reads: "A pass flips the default on at factor 1.50. If W5 fails, it ships off." The W5 rule depends only on the W5 gate. Gate 4 is W3's own gate, governed by TC2 in the [preregistration](2026-10-10-memory-proof-wave-2-preregistration.md): "If the shadow probe fails its floor, W3 ships as the shadow grade only." Its failure changes W3's ship form and nothing else.

## Cost per correct answer

This uses wave 1's formula: ingest dollars ÷ R reads per stored conversation, plus read dollars per question, all divided by graded accuracy. Ingest CPU is priced at $0.05 per vCPU-hour, with 4 vCPUs for gbrain and 16 for the comparator.

| R | gbrain | The comparator | Ratio (95% interval) |
|---:|---:|---:|---|
| 1 | $0.697 | $1.049 | 0.664 (0.646 to 0.683) |
| **20** | **$0.0564** | **$0.0752** | **0.750 (0.727 to 0.773)** |
| 200 | $0.0261 | $0.0291 | 0.896 (0.863 to 0.930) |

By size at R = 20, the ratio is 0.84 on BEAM-100K, 0.77 on BEAM-500K and 0.73 on BEAM-1M.

Over the 72 conversations:

- **Ingest.** gbrain spent $31.82 on API calls (fact extraction and embeddings) plus $2.40 of CPU. The comparator spent $46.50 plus $2.62.
- **Reads.** gbrain spent $23.03: $21.22 on the answer model, $1.81 on rerank and under $0.01 on query embedding. The comparator spent $22.95, all on the answer model.

## What ran

- **Data.** BEAM's 72 non-dev conversations: 16 at 100K, 28 at 500K and 28 at 1M, 20 questions each. Under GBRA-49's ruling these are regression and descriptive evidence, not held-out confirmation. LongMemEval-S's 400 questions outside the dev subset ran as wave 1's four shards. LoCoMo10 was not in this go, so gate 2's LoCoMo10 test and gate 3's LoCoMo10 report did not run.
- **Lanes.**
  - `combined-v2` is question-ranked `recall` facts plus a page query, delivering 8,100 tokens.
  - `combined-v1@pin` is wave 1's facts-first lane at the same pin.
  - `raw@pin` is pages only.
  - `combined-v2+w5` is `combined-v2` with W5 on at 1.50.
  - The comparator is a memory-bank server, regenerated on BEAM at its wave-1 knobs. Its BEAM-100K cell ran twice, because the first run's answers were lost with its VM before custody copies existed. The joint re-judge reads the second run. The first scored 68.13 in-cell and the second 66.35.
- **Knobs.** Every cell sets every read-time and ingest knob explicitly.
- **Spend.** Confirmation cost $398.04: $316.69 for cells and $81.35 for re-judges. Wave 2 cost $591.35 in all, before A15's own spend.

## Receipts

- **Cells.** Each cell's receipt is in [`2026-10-10-memory-proof-wave-2/`](2026-10-10-memory-proof-wave-2/) under `confirm-<group>/cells/`. BEAM-100K and BEAM-1M cells publish `summary.json` and `spend.json` only.
- **Re-judges.** The joint re-judges are under `confirm-rejudge/<group>/`. BEAM-100K and BEAM-1M re-judges publish summaries only.
- **Gate outputs.** These are in `confirm-analysis/`: `gates.json` from `eval/runner/memory-proof-wave-2-confirm-analysis.ts`, and `cost.json` from `mpw_tools/sealed_cost.py` with strata merged by size.
- **Ledgers and custody.** Ledgers, custody copies and the private re-judge outputs are mirrored to the integrator's primary machine with matching SHA-256 values.
- **VMs.** Every VM is recorded and destroyed.

## Changelog

### 2026-10-13: W5 ship rule

Added the ship rule under the W5 result: the preregistered rule and the amendment, quoted verbatim, and a note that gate 4's failure governs W3's ship form only (TC2), not W5's.

### 2026-10-13: First version

The confirmation results for gates 1, 2, 3, W5, 4 and 5 at gbrain `71b6d85`, with the W5 amendment, the comparator's second BEAM-100K cell and LoCoMo10 recorded as not run.
