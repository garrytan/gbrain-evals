# Does the synthetic recall test predict the real paraphrase gap on new questions? Results

- **We learned that a synthetic brain that copies the real brain's embedding gaps predicted the right direction for
  gbrain's paraphrase gap on 50 real questions it had never seen, and a clean synthetic brain didn't. You can use this
  test for the direction of that gap, not its size, and it hasn't yet been tested on whether a change in the synthetic
  gap tracks a change in the real one.** On batch 4, a new set of 50 questions on Garry's own brain written after every
  rule below was fixed, gbrain's configured search put the right page in its top five for 23 of 49 questions asked in
  other words and 36 of the same 49 asked in their exact words: a gap of 26.53 points (95% interval −40.82 to −14.29),
  with 14 questions found only in their exact words and 1 found only reworded. The gap-copied synthetic brain predicted
  a gap of 7 points (−12 to −3), so the preregistered outcome is **HELD**. HELD was the expected sign after three
  earlier real batches; what's new is that a prediction frozen before the questions existed held on a set that shares
  nothing with them. In the clean synthetic brain, configured search finds all 100 reworded questions, which hides the
  real gap, so the clean brain predicts none and reads NOT HELD.
- **We learned that the synthetic brain still underestimates the gap's size, and one new batch can't say whether the
  factor is stable. You shouldn't gate on the gap's size.** The synthetic gap is 0.2638 of the real one (95% interval
  0.0885 to 0.6151). The interval contains batch 2's 0.175, which the preregistered rule reads as stable, but it also
  contains twice 0.175, so it can't tell a stable underestimate from a changed one.
- **We learned that what vectors and configured search add on reworded questions holds on new questions.** Live
  recall's two preregistered primaries held again: vectors lift gbrain's lexical hybrid search on reworded questions
  from 1 of 49 to 12 of 49 (+22.45 points, 10.20 to 34.69), and configured search (`tokenmax` with Voyage's
  rerank-2.5) lifts it to 23 of 49 (+44.90, 28.57 to 59.18). Configured search changes reranking and other settings
  together, so this doesn't isolate the reranker's share.

Batch 4 measures gbrain 0.60.682.0 on Wintermute's box; the synthetic prediction comes from gbrain 0.60.593.0, as
counted for batch 2. Every number below says which.

## What was tested

gbrain is a memory system that an agent searches for stored pages. The question here is whether a fictional set of
pages reproduces the drop in search results that the real brain shows when a question is reworded.

G2 (recall under real conditions) is one of six synthetic tests in the
[predictive-measures results](2026-11-10-predictive-measures.md). It builds a fictional brain of 180 pages and 100
questions, each asked in exact words and reworded, and runs gbrain's five search setups on it. The counted version
copies two gaps measured in the real brain on 2026-11-06: no synopsis vectors, and 10% of chunks with no vector. On
batch 2 it agreed in sign with all 13 real contrasts that qualified. But it became the counted version after batch 2's
results were public, so its prediction that reworded questions are found less often was never tested on questions it
hadn't seen ([why](2026-11-10-predictive-measures.md#g2-recall-under-real-conditions-batch-2-layer)).

This test fixed every rule first. The [preregistration
amendment](2026-11-09-predictive-measures-preregistration.md#2026-11-11-g2s-held-out-replication-on-batch-4) merged as
gbrain-evals `ecf8169c` on 2026-11-11 at 19:27:24 UTC, before any batch 4 question existed. It fixed the primary
(configured search's paraphrase gap), its pass rule, the 16 predicted signs and the synthetic side, which is G2's
counted batch 2 scorecard used unchanged. Only then was Wintermute asked for new questions.

## The paraphrase gap

Success@5 for configured search (`tokenmax` with Voyage rerank-2.5), on the questions with both forms eligible:

| | Real brain, batch 4 (0.60.682.0, 49 questions) | Gap-copied synthetic brain, counted (0.60.593.0, 100) | Clean synthetic brain (0.60.593.0, 100) |
|---|---|---|---|
| Exact words | 36 of 49 | 97 of 100 | 100 of 100 |
| Reworded | 23 of 49 | 90 of 100 | 100 of 100 |
| Reworded minus exact, points (95% interval) | −26.53 (−40.82 to −14.29) | −7 (−12 to −3) | 0 (0 to 0) |
| Preregistered outcome | | **HELD** | NOT HELD |

HELD means the real gap's 95% interval lies wholly below zero, the side the gap-copied brain predicts. Under the
preregistration, G2's paraphrase-gap prediction now counts as held out for its direction, so G2 may gate on that gap's
direction, never its size. This run compared one batch's gap with one fixed prediction. It did not test whether a
change in the synthetic gap, after a gbrain change, predicts a change in the real gap.

**The size.** The synthetic gap divided by the real one is 0.2638, with a 95% Fieller interval of 0.0885 to 0.6151
(batch 2: 0.175, from 0.0599 to 0.3567). The preregistered rule calls the underestimate stable when this interval
contains 0.175, and it does. But it also contains 0.35, twice 0.175, and only just misses 0.0875, half of it, so one
batch of 50 questions can't tell a stable underestimate from a changed one. No nightly gate should be calibrated on it
yet.

Across four batches, configured search's real paraphrase gap has been 28, 40, 44 and now 26.53 points. Batch 4's is the
smallest, and the difference from batch 2 is on exact words: configured search found 37 of 50 of batch 4's exact forms
(74%) against 88% on batch 2, and 23 of 49 reworded forms (46.9%) against 48%.

## The other contrasts

All 16 contrasts the preregistration names form G2's batch 4 layer. A contrast qualifies when its simultaneous 95%
band, one band for all 16 from a bootstrap that resamples batch 4's questions within each of the five question types,
excludes zero. Success@5 differences, B minus A, as the scorecard and verdict file record them:

| Contrast | Real, batch 4 (own 95% interval) | Family band | Synthetic, counted | Counts as |
|---|---|---|---|---|
| P1: hybrid − hybrid_lexical, reworded | +0.2245 (0.1020 to 0.3469) | 0.0663 to 0.3827 | +0.31 | agree |
| P2: configured − hybrid_lexical, reworded | +0.4490 (0.2857 to 0.5918) | 0.2892 to 0.6088 | +0.32 | agree |
| batch 1's P1: hybrid − hybrid_lexical | +0.1212 (0.0100 to 0.2424) | 0.0055 to 0.2369 | +0.11 | agree |
| hybrid_lexical − keyword | +0.0505 (−0.0400 to 0.1400) | −0.0422 to 0.1432 | +0.405 | doesn't qualify |
| hybrid − keyword | +0.1717 (0.0700 to 0.2800) | 0.0705 to 0.2729 | +0.515 | agree |
| configured − keyword, reworded | +0.4694 (0.3265 to 0.6122) | 0.3225 to 0.6162 | +0.90 | agree (sign forced) |
| configured − hybrid | +0.1818 (0.1200 to 0.2500) | 0.0846 to 0.2790 | +0.035 | agree |
| vector − keyword | +0.1111 (0.0000 to 0.2200) | 0.0032 to 0.2190 | +0.51 | agree |
| configured − keyword, exact | +0.2400 (0.1000 to 0.3800) | 0.1000 to 0.3800 | +0.20 | agree |
| hybrid − keyword, reworded | +0.2449 (0.1224 to 0.3673) | 0.0963 to 0.3935 | +0.89 | agree (sign forced) |
| configured_window − configured | +0.1000 (0.0000 to 0.2500) | −0.0842 to 0.2842 | 0 | doesn't qualify |
| reworded − exact, keyword | −0.4898 (−0.6327 to −0.3469) | −0.5993 to −0.3802 | −0.77 | agree (sign forced) |
| reworded − exact, vector | −0.2653 (−0.4286 to −0.1020) | −0.4842 to −0.0464 | −0.01 | agree |
| reworded − exact, hybrid_lexical | −0.5714 (−0.7143 to −0.4286) | −0.7530 to −0.3899 | −0.42 | agree |
| reworded − exact, hybrid | −0.3469 (−0.5102 to −0.1837) | −0.5464 to −0.1475 | −0.02 | agree |
| **reworded − exact, configured (primary)** | **−0.2653 (−0.4082 to −0.1429)** | −0.4616 to −0.0690 | −0.07 | agree |

14 of 16 qualify and all 14 agree in sign, so the layer reads **PREDICTIVE**. Not counting the three whose sign keyword
search forces by finding no reworded question on either brain, 11 qualify, against a minimum of 3. The two that don't
qualify are lexical hybrid over keyword search (+5.05 points, band −4.22 to 14.32) and the time-window filter over
configured search (+10.00, band −8.42 to 28.42). The time-window contrast has no predicted sign, because the synthetic
brain shows no difference, so had it qualified it would have counted as a disagreement and the layer would read NOT
PREDICTIVE. Vector over keyword search qualifies on its band (0.32 to 21.90) although its own interval reaches 0.00:
the band is symmetric about the estimate and the own interval is a percentile interval, so the two can differ at the
edge. Without it, 13 qualify and 10 toward the minimum, and the reading is the same.

G2's summary line reads PREDICTIVE: its batch 2 layer is unchanged (13 of 16 qualify, all agree) and its batch 4 layer
reads PREDICTIVE. The layer is reported beside the outcome and never decides it.

**As on batch 2, the signs agree and the sizes don't.** The synthetic brain puts hybrid search's gain over keyword
search on reworded questions at 89 points against the real 24.49, and the paraphrase gaps of vector and hybrid search
at 1 and 2 points against the real 26.53 and 34.69. Kendall's tau-b over the order of the five setups is 0.5270 on
exact forms and 0.9487 on reworded ones (batch 2: 0.6000 and 0.9487).

**The clean synthetic brain** reads NOT PREDICTIVE on batch 4, as on batch 2, and for the same single reason: it agrees
with every other qualifying contrast and misses only configured search's paraphrase gap, where it shows none. Its tau-b
is 0.5000 exact and 0.9487 reworded.

## Live recall on batch 4

Success@5 by search setup, questions found / asked, exact and reworded:

| Setup | Batch 4 (0.60.682.0) | Batch 2 (0.60.593.0) |
|---|---|---|
| keyword | 25/50 and 0/49 | 32/50 and 0/50 |
| vector | 25/50 and 11/49 | 28/50 and 16/50 |
| hybrid_lexical | 29/50 and 1/49 | 40/50 and 8/50 |
| hybrid | 30/50 and 12/49 | 37/50 and 17/50 |
| configured | 37/50 and 23/49 | 44/50 and 24/50 |

Configured search finds the page in its top five for 60 of all 99 eligible forms (95% interval 49.00% to 71.72%),
against 68 of 100 on batch 2. With the time-window filter it finds all 20 time-window forms. P1 (vectors' gain on reworded
questions, +22.45 points, Holm p 0.0028) and P2 (configured search's gain, +44.90, Holm p 0.0002) both hold, as they
did on batch 2 (+18 and +32). By question type, configured search found 4 of 10 identifier questions and 4 of 10 error
strings in their exact words, and 9 or 10 of 10 for the other three types. The full scorecard is
[`live-recall-batch4/b4-scorecard.md`](live-recall-batch4/b4-scorecard.md).

## What this can't show

- **Direction only.** The outcome reads a sign. The synthetic brain predicts about a quarter of the real gap, and its
  size is not tested beyond the ratio above. Nor is whether the synthetic gap moves when the real one does.
- **Two gbrain versions.** The prediction comes from gbrain 0.60.593.0 and batch 4 ran on 0.60.682.0, the version
  Wintermute's box ran at the freeze and at the run. The same synthetic brain was not rerun at 0.60.682.0; the
  preregistration lists that run as optional and descriptive.
- **The copied conditions have drifted.** Read on the box just after the freeze, 5.5% of the chunks on the real
  brain's live pages have no vector, about half the 10% the synthetic brain copies; neither has synopsis vectors; and
  of 400 sampled media pages, 38% have under 500 characters of body text and 21% under 200, where the synthetic brain
  turns about half of its pages that aren't gold into shells, by a different rule. The copied conditions still predict
  the direction while underestimating the gap by far. This run doesn't identify which differences in the brain, the
  questions, the gbrain version or the search setup explain the rest of the size.
- **Privacy relabelling.** The brain's privacy labels were still being corrected in windows. The run's operator
  reported the same two relabel commits in the brain's checkout at the freeze and at the run, with none newer. Which
  windows those commits applied couldn't be reconstructed, so unchanged commits alone don't show that no relabelling
  happened between the two reads. The counts of private pages taken at the freeze and at the run used different
  queries and aren't compared. A recheck at the freeze found no privacy label on any of the 60 gold pages.
- **One writer, one sample.** Wintermute wrote all 50 questions and their gold, page first, from one seeded sample of
  pages, none of them a real question that once failed. The 60 gold pages are 40 meeting pages, 10 company pages and
  10 conversations. Each cross-source question pairs two meetings about the same company, all 10 topic questions are
  about meetings, and the error strings' key strings appear in 1 to 14 files, so some are less unique than others. No
  reworded form shares an identifier-like token with its exact form. Among gold pages with a date in their path, 8 of
  49 are from 2026-10-09 or later, against 33 of 52 on batch 2 (batch 4 has 60 gold pages, batch 2 had 58), so batch 4
  leans to older pages.
- **Two refused attempts before the freeze.** A guard on the box refused the question build twice on 2026-11-11. In
  those attempts Wintermute read candidate pages but saved no question file and ran no search. The frozen set was
  written fresh from the same sample and rules ([frozen sample](live-recall/PREREGISTRATION.md#2026-11-12-batch-4-frozen-sample)).
- **One form dropped.** One reworded topic question was excluded because lexical hybrid search ran degraded on it, so
  every reworded contrast uses 49 questions.
- **The band's 95% is nominal.** At 50 questions, a bootstrap band covers less than its stated level, so a qualifying
  contrast is read for its direction.
- **Power.** The preregistered smallest detectable difference for the primary was 21.7 points at 30% discordant pairs
  and 50 pairs (two-sided 0.05, 80% power). Batch 4 had 15 discordant pairs of 49, and the scorecard's estimate from
  the observed standard error is 19.63 points. The observed gap of 26.53 points is above both.

## How it ran

1. **Freeze.** Wintermute wrote 50 questions, 10 of each of five types, and froze them on 2026-11-12 at 04:09 UTC with
   `run.ts freeze --protocol batch4` at gbrain-evals `ecf8169c` on a clean tree, with gbrain 0.60.682.0
   (`42faabf2`). The freeze checked the three earlier question files and found 0 shared question ids, forms and gold
   pages. The [frozen sample](live-recall/PREREGISTRATION.md#2026-11-12-batch-4-frozen-sample) and
   [`freeze.json`](live-recall-batch4/freeze.json) were committed before any search.
2. **Counted run.** One run, which the scorecard records from 2026-11-12T04:32:18.584Z to 04:42:57.517Z, from
   `ecf8169c` on a clean tree, with gbrain 0.60.682.0 loaded over this repository's pin of 0.60.623.0, schema 304,
   through Supabase's session pooler. It read the brain through a database role with no write privilege, and the
   session was checked read-only at the start and the end. The harness's write guard refused 17 writes gbrain attempted
   during the run (16 of its per-query telemetry counters and 1 insert). All 50 questions loaded, and no gold page was
   missing.
3. **Scoring.** The scorecard is committed as the run wrote it
   ([`b4-scorecard.json`](live-recall-batch4/b4-scorecard.json), sha256 `52d73b12…7edff1`).
   `export-references.ts` turns it into the `live-recall-b4` reference, and `verdict.ts` reads G2's counted synthetic
   scorecard (sha256 `9c46cada…0264`) against it. No rule, sign, threshold or synthetic file changed after the batch
   arrived. The only code change on this side since the amendment merged makes the reference export list a skipped
   comparison instead of crashing on it; batch 4 skipped none, so it changes nothing here.
4. **Family band.** One max-t bootstrap over the 16 contrasts, resampling 50 questions within 5 types (seed 20261106,
   10,000 draws): critical value 2.8889, against Bonferroni's 2.9552.
5. **Claim check.** A reader from another model family checked every number and claim here against the committed
   files once, and reproduced both verdict files byte for byte.

## Reproduce and inspect

- `bun eval/runner/predictive/export-references.ts` rebuilds `eval/data/validity-references/live-recall-b4.json` from
  the committed scorecard.
- `bun eval/runner/predictive/verdict.ts --measure G2 --synthetic
  docs/benchmarks/predictive-measures/g2/real-593/scorecard.json --out <file>` reproduces
  [`verdicts/G2-batch4.json`](predictive-measures/verdicts/G2-batch4.json), outcome and layer included. Add
  `--secondary` and the clean scorecard (`g2/secondary/clean-593/scorecard.json`) for
  [the clean brain's reading](predictive-measures/verdicts/secondary/G2-batch4-clean-593.json). The batch 2 and
  batch 3 verdict files stay as published.
- The question file, the pages and the per-query records weren't exported to this repository; what it holds from the
  run is the freeze record and the two scorecards, which hold counts and rates. During the run, search sent the
  question forms to Voyage for embedding and the forms with candidate passages for reranking, through the box's own
  configured Voyage service, as in batch 2.

## Disclosures

gbrain is Garry Tan's own project.
