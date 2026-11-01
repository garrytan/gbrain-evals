# Corrections to published numbers

These published numbers are invalid, overstated or retired. Each affected report keeps its original figures, labeled,
beside a dated correction or notice. The list covers the audit of September 28, 2026, the corrections README carried
until 2026-11-01 and the rows the comparisons page dropped as invalid. A report that later corrected its own figures
says so in that report. [README](../README.md) and the hub pages show only the numbers that stand; this page
says which ones do not and why. Everything above [Changelog](#changelog) is current.

## LongMemEval

- **LongMemEval answer accuracy 433/500 (86.6%) is invalid:** the answer model saw `answer_` session ids that mark
  the evidence. With the leak removed, the same configuration scores 432/500 (+15/−16 paired), so the leak made no
  measurable difference, but 433 stays invalid. Retrieval numbers recounted with opaque ids are confirmed.
  [Report](benchmarks/2026-09-29-longmemeval-opaque-qa.md),
  [recount](benchmarks/2026-10-04-longmemeval-opaque-followups.md).
- **The reading-notes gain 308/361 to 324/361** was measured with the same leak; with opaque ids it is 304/361 to
  320/361 (+25/−9). [Report](benchmarks/2026-09-25-reading-notes.md).
- **Query expansion "hurts retrieval"** described the September 6 code (255/470). At gbrain `109b992` it scores
  436/470 against 434/470 without it (+6/−4, p = 0.75), so that finding no longer describes gbrain.
  [Recount](benchmarks/2026-10-04-longmemeval-opaque-followups.md).
- **Two cost figures in the particle-1 replay report are off** (2026-11-01). Its results table gives Opus 5.5
  $0.0994 per correct answer; $47.091364 over 474 correct answers is $0.09935, which is $0.0993 (the table rounded
  summary.json's five-decimal value a second time; the opening paragraph's $0.099 stands). Its batch-price figures for
  Opus 5.5 and Sonnet 5.5, $0.0507 and $0.0255 per correct answer ($0.051 in the opening paragraph), come from W10's
  ledger-settled amounts. W10's preregistration settled each arm's 10-question pilot at list price until the batch
  discount was confirmed, but the provider billed the pilots at the batch rate too, so at half the list price the
  figures are $0.0497 and $0.0250. Every particle-1 figure is unaffected; GPT-6.1 Sol's figures have their own entry
  below. The report keeps its original figures; this page carries the correction.
  [Report](benchmarks/2026-11-01-longmemeval-particle-replay/REPORT.md),
  [recheck](findings/2026-11-01-particle-1-longmemeval-w10b.md).
- **GPT-6.1 Sol's reader costs in W10b, W10c and the particle-1 replay are about a fifth low** (2026-11-01). OpenAI
  reported almost every Sol prompt token as a cache write (6,845,950 of 6,847,450 in W10b), and it prices cache writes
  at $2.50 per million tokens against $2.00 for input. W10 settled its rows on 2026-10-06 at the input price, two days
  before the budget ledger began pricing OpenAI cache writes (`8a8e502a`). At the cache-write rate, W10b's Sol reader
  cost is $8.83 at batch price (was $7.12), so the W10b run total is $92.00 (was $90.29). W10c's Sol reader costs
  $0.0178 per question on gbrain's retrieval (was $0.0144, so the recurring total with the rerank rises by $0.0034) and
  $0.1339 with the whole history (was $0.1073), so gbrain's recurring cost is still about a seventh of the whole
  history's. The replay
  report's W10b figures for Sol are $0.0381 per correct answer at list and $0.0190 at batch (was $0.0307 and $0.0154,
  which was itself $0.01535 rounded a second time), so particle-1's list cost per correct answer is about a ninth of
  Sol's, not a seventh. Its W10c figures for Sol are $0.0356 and $0.0178 per question on gbrain's retrieval (was
  $0.0287 and $0.0144) and $0.2679 and $0.1339 with the whole history (was $0.2145 and $0.1073). OpenAI's billing API
  refused our key, so these follow OpenAI's published rate and the usage the responses reported, not an invoice. No
  accuracy figure changes, and the reports keep their original figures.
  [W10b](benchmarks/2026-10-07-longmemeval-w10b-reader-replay.md),
  [W10c](benchmarks/2026-10-07-longmemeval-w10c-full-context.md),
  [replay report](benchmarks/2026-11-01-longmemeval-particle-replay/REPORT.md),
  [recheck](findings/2026-11-01-particle-1-longmemeval-w10b.md).

## Relationships and calibration

- **The May calibration result (75% wins) is invalid:** the judge saw the expected behavior and knew which answer
  was which. [Report](benchmarks/2026-05-18-brainbench-cat14-cat15-calibration.md).
- **The April relationship precision at five (39.2% to 44.7%)** used a lenient denominator; divided by five slots it
  is 29.9% to 35.4%. Its alias recall falls from 31.0% to 13.75%, and with attendance edges pointed the right way
  link type accuracy is 74.7% (109/146).
  [Report](benchmarks/2026-04-18-brainbench-v1.md),
  [September 29 re-run](benchmarks/2026-09-29-repin-cats-1-2-6.md).
- **The April and May relationship tables' `gbrain` row (49.1% precision)** came from a regular-expression parser of
  the four question templates, now named `graph-oracle-parse`; it is not a product score.
  [Report](benchmarks/2026-04-19-brainbench-multi-adapter.md).

## PrecisionMemBench

- **The May gbrain rows (tight adaptive 0.582 and hybrid 0.075 mean precision) are invalid:** the seeding hid four
  superseded beliefs using ground-truth metadata unavailable to other providers. The September 9 corrected run
  replaces them (tight adaptive with reranking 0.5859, broad hybrid 0.0565).
  [Report](benchmarks/2026-05-29-precisionmembench.md),
  [September 9 refresh](benchmarks/2026-09-09-retrieval-refresh.md).

## Writing memory

- **Cat 35's 88.1%** is judge-only; evidence-verified retention is 74.9%.
  [Report](benchmarks/2026-08-16-brainbench-cat35-transcript-distill.md).
- **The May snapshot's Category 18b to 29 rows** came from runners written before the August audit; Cat 29's +4.00
  synthesis lift also scored the same single-answer call twice.
  [Report](benchmarks/2026-05-23-v0.40.6.0-snapshot.md).

## Agent tasks

- **Cat 40 agent-task results from October 2 to 7 measured gbrain without its reranker.** Restored harness slots
  kept a closed metering-proxy port for Voyage, so every rerank request failed and gbrain returned unreranked results.
  That covers the frontier tie with plain files (0 of 500 gbrain cells reranked), the six-model cost-wave set, the
  entity-recall rounds, the fix-wave development ladders, the 52,000-document tier, most of the release ladder, the
  F1/F10 instruction A/B in the Cat 41 report, the registration-surface cell, the P8 surface development runs and the
  fix wave 11 and 12 smokes. Comparisons between gbrain builds that shared the condition stay internally valid. The
  F1/F10 same-window pair for `b3f4e8b` reranked on one side only and does not support its conclusion as stated. The
  fix wave's held-out check reranked (1691 of 1800 cells) and is unaffected. Fixed in gbrain-evals #76 and #109.
  [Cat 40 correction](benchmarks/2026-10-02-model-ladder.md#correction-2026-10-09),
  [Cat 41 correction](benchmarks/2026-10-03-agent-operator.md#correction-2026-10-09),
  [audit](benchmarks/2026-10-08-program-primary-hard/root-cause/restore-audit.json).
- **The first Cat 40 world's success figures are retired** (2026-10-12): the 95.6% tie with plain files and the
  six-model set's 75.7% against 72.8% were measured with the reranker off, and the world sits near its ceiling
  (oracle 97.6%), so a rerun could at best confirm parity. Its permission result (0 of 100 finance-only leaks into
  context) does not depend on reranking and still stands. For agent-task success, read the
  [Cat 40 Hard confirmation](benchmarks/2026-10-10-model-ladder-hard-confirmation.md).
  [Notice](benchmarks/2026-10-02-model-ladder.md#retired-2026-10-12).

## Changelog

### 2026-11-01: particle-1 replay and GPT-6.1 Sol cost figures

The recheck behind the [particle-1 W10b finding](findings/2026-11-01-particle-1-longmemeval-w10b.md) recounted the
replay's numbers from its committed rows. Every quoted count and interval reproduced, and so did every particle-1
cost. Two entries are added under LongMemEval. The first covers two figures in the replay report: Opus 5.5's list cost
per correct answer in the results table ($0.0994, correctly $0.0993) and the batch-price figures for Opus 5.5 and
Sonnet 5.5 ($0.0507 and $0.0255, at the batch rate $0.0497 and $0.0250). The second reprices GPT-6.1 Sol's reader
costs in W10b, W10c and the replay report at OpenAI's cache-write rate, which W10's ledger did not yet apply.

### 2026-11-01: Page created from README's corrections

Created in the documentation refresh at gbrain `3ec766c40` (v0.60.531.0), gbrain-evals #241. README's
`## Corrections` section moved here, so README's current state shows only numbers that stand. The entries keep their
wording, grouped by topic, with two changes: the query-expansion entry names the commit it was measured at
(`109b992`, was "current gbrain") and links its recount. Two entries are new on this page, moved from current-state
text elsewhere: the invalid May PrecisionMemBench rows, which [comparisons](comparison-systems.md) showed struck
through in its table, and the retirement of the first Cat 40 world's success figures, which README told inside its
agent-task comparison.
