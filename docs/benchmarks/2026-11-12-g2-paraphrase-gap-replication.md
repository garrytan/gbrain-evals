# Does the synthetic recall test predict the real paraphrase gap on new questions? Results

- **We learned that a synthetic brain that copies the real brain's embedding gaps predicts the direction of gbrain's
  paraphrase gap on 50 real questions it had never seen, and a clean synthetic brain doesn't. You can use this test to
  tell whether a gbrain change makes reworded questions harder to find than exact ones, but not by how much.** On batch
  4, a new set of 50 questions on Garry's own brain written after every rule below was fixed, gbrain's configured
  search put the right page in its top five for 46.9% of the questions asked in other words and 73.5% of the same
  questions asked in their exact words: a gap of 26.5 points (95% interval −40.8 to −14.3), with 14 questions found
  only in their exact words and 1 found only reworded. The gap-copied synthetic brain predicted a gap of 7 points (−12
  to −3), so the preregistered outcome is **HELD**. The clean synthetic brain finds every reworded question, predicts
  no gap, and reads NOT HELD. A clean synthetic test makes paraphrase recall look perfect.
- **We learned that the synthetic brain still underestimates the gap's size, and one new batch can't say by how stable a
  factor. You shouldn't gate on the gap's size.** The synthetic gap is 0.26 of the real one (95% interval 0.09 to
  0.62). The interval contains batch 2's 0.175, which the preregistered rule reads as stable, but it also contains twice
  0.175, so it can't tell a stable underestimate from a changed one.
- **We learned that what vectors and the reranker add on reworded questions holds on new questions.** Live recall's two
  preregistered primaries held again: vectors lift gbrain's lexical hybrid search on reworded questions from 2.0% to
  24.5% (+22.4 points, 10.2 to 34.7), and configured search (`tokenmax` with Voyage's rerank-2.5) lifts it to 46.9%
  (+44.9, 28.6 to 59.2).

Batch 4 measures gbrain 0.60.682.0 on Wintermute's box; the synthetic prediction comes from gbrain 0.60.593.0, as
counted for batch 2. Every number below says which.

## What was tested

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
| Exact words | 73.5% | 97% | 100% |
| Reworded | 46.9% | 90% | 100% |
| Reworded minus exact (95% interval) | −26.5 (−40.8 to −14.3) | −7 (−12 to −3) | 0 (0 to 0) |
| Preregistered outcome | | **HELD** | NOT HELD |

HELD means the real gap's 95% interval lies wholly below zero, the side the gap-copied brain predicts. Under the
preregistration, G2's paraphrase-gap prediction now counts as held out for its direction, so G2 may gate gbrain's
nightly checks as a paraphrase detector on direction only. A gate on size would need the ratio below to be stable.

**The size.** The synthetic gap divided by the real one is 0.26, with a 95% Fieller interval of 0.09 to 0.62 (batch 2:
0.175, from 0.060 to 0.357). The preregistered rule calls the underestimate stable when this interval contains 0.175,
and it does. But it also contains 0.35, twice 0.175, and only just misses 0.0875, half of it, so one batch of 50
questions can't tell a stable underestimate from a changed one. No nightly gate should be calibrated on it yet.

Across four batches, configured search's real paraphrase gap has been 28, 40, 44 and now 26.5 points. Batch 4's is the
smallest because exact words were found less often, not because reworded questions were found more often: configured
search found 74% of batch 4's exact forms against 88% on batch 2, and 46.9% of its reworded forms against 48%.

## The other contrasts

All 16 contrasts the preregistration names form G2's batch 4 layer. A contrast qualifies when its simultaneous 95%
band, one band for all 16 from a bootstrap that resamples batch 4's questions within each of the five question types,
excludes zero. Success@5 differences, B minus A:

| Contrast | Real, batch 4 (own 95% interval) | Family band | Synthetic, counted | Counts as |
|---|---|---|---|---|
| P1: hybrid − hybrid_lexical, reworded | +0.224 (0.102 to 0.347) | 0.066 to 0.383 | +0.31 | agree |
| P2: configured − hybrid_lexical, reworded | +0.449 (0.286 to 0.592) | 0.289 to 0.609 | +0.32 | agree |
| batch 1's P1: hybrid − hybrid_lexical | +0.121 (0.010 to 0.242) | 0.005 to 0.237 | +0.11 | agree |
| hybrid_lexical − keyword | +0.051 (−0.040 to 0.140) | −0.042 to 0.143 | +0.405 | doesn't qualify |
| hybrid − keyword | +0.172 (0.070 to 0.280) | 0.070 to 0.273 | +0.515 | agree |
| configured − keyword, reworded | +0.469 (0.327 to 0.612) | 0.323 to 0.616 | +0.90 | agree (sign forced) |
| configured − hybrid | +0.182 (0.120 to 0.250) | 0.085 to 0.279 | +0.035 | agree |
| vector − keyword | +0.111 (0.000 to 0.220) | 0.003 to 0.219 | +0.51 | agree |
| configured − keyword, exact | +0.240 (0.100 to 0.380) | 0.100 to 0.380 | +0.20 | agree |
| hybrid − keyword, reworded | +0.245 (0.122 to 0.367) | 0.096 to 0.394 | +0.89 | agree (sign forced) |
| configured_window − configured | +0.100 (0.000 to 0.250) | −0.084 to 0.284 | 0 | doesn't qualify |
| reworded − exact, keyword | −0.490 (−0.633 to −0.347) | −0.599 to −0.380 | −0.77 | agree (sign forced) |
| reworded − exact, vector | −0.265 (−0.429 to −0.102) | −0.484 to −0.046 | −0.01 | agree |
| reworded − exact, hybrid_lexical | −0.571 (−0.714 to −0.429) | −0.753 to −0.390 | −0.42 | agree |
| reworded − exact, hybrid | −0.347 (−0.510 to −0.184) | −0.546 to −0.148 | −0.02 | agree |
| **reworded − exact, configured (primary)** | **−0.265 (−0.408 to −0.143)** | −0.462 to −0.069 | −0.07 | agree |

14 of 16 qualify and all 14 agree in sign, so the layer reads **PREDICTIVE**. Not counting the three whose sign keyword
search forces by finding no reworded question on either brain, 11 qualify, against a minimum of 3. The two that don't
qualify are lexical hybrid over keyword search (+5.1 points, band −4.2 to 14.3) and the time-window filter over
configured search (+10.0, band −8.4 to 28.4). The time-window contrast has no predicted sign, because the synthetic
brain shows no difference, so had it qualified it would have counted as a disagreement and the layer would read NOT
PREDICTIVE. Vector over keyword search qualifies on its band (0.3 to 21.9) although its own interval reaches 0.0: the
band is symmetric about the estimate and the own interval is a percentile interval, so the two can differ at the edge.
Without it, 13 qualify and 10 toward the minimum, and the reading is the same.

G2's summary line reads PREDICTIVE: its batch 2 layer is unchanged (13 of 16 qualify, all agree) and its batch 4 layer
reads PREDICTIVE. The layer is reported beside the outcome and never decides it.

**As on batch 2, the signs agree and the sizes don't.** The synthetic brain puts hybrid search's gain over keyword
search on reworded questions at 89 points against the real 24.5, and the paraphrase gaps of vector and hybrid search
at 1 and 2 points against the real 26.5 and 34.7. Kendall's tau-b over the order of the five setups is 0.527 on exact
forms and 0.949 on reworded ones (batch 2: 0.600 and 0.949).

**The clean synthetic brain** reads NOT PREDICTIVE on batch 4, as on batch 2, and for the same single reason: it agrees
with every other qualifying contrast and misses only configured search's paraphrase gap, where it shows none. Its tau-b
is 0.500 exact and 0.949 reworded.

## Live recall on batch 4

Success@5 by search setup, exact / reworded:

| Setup | Batch 4 (0.60.682.0) | Batch 2 (0.60.593.0) |
|---|---|---|
| keyword | 50% / 0% | 64% / 0% |
| vector | 50% / 22.4% | 56% / 32% |
| hybrid_lexical | 58% / 2.0% | 80% / 16% |
| hybrid | 60% / 24.5% | 74% / 34% |
| configured | 74% / 46.9% | 88% / 48% |

Configured search finds the page in its top five for 60.6% of all 99 eligible forms (95% interval 49.0 to 71.7),
against 68% on batch 2. With the time-window filter it finds all 20 time-window forms. P1 (vectors' gain on reworded
questions, +22.4 points, Holm p 0.0028) and P2 (configured search's gain, +44.9, Holm p 0.0002) both hold, as they did
on batch 2 (+18 and +32). By question type, configured search found 4 of 10 identifier questions and 4 of 10 error
strings in their exact words, and 9 or 10 of 10 for the other three types. The full scorecard is
[`live-recall-batch4/b4-scorecard.md`](live-recall-batch4/b4-scorecard.md).

## What this can't show

- **Direction only.** The outcome reads a sign. The synthetic brain predicts a quarter of the real gap, and its size
  is not tested beyond the ratio above.
- **Two gbrain versions.** The prediction comes from gbrain 0.60.593.0 and batch 4 ran on 0.60.682.0, the version
  Wintermute's box ran at the freeze and at the run. The same synthetic brain was not rerun at 0.60.682.0; the
  preregistration lists that run as optional and descriptive.
- **The copied conditions have drifted.** Read on the box just after the freeze, 5.5% of the chunks on the real
  brain's live pages have no vector, about half the 10% the synthetic brain copies; neither has synopsis vectors; and
  of 400 sampled media pages, 38% have under 500 characters of body text and 21% under 200, where the synthetic brain
  turns about half of its pages that aren't gold into shells, by a different rule. So the synthetic brain now copies more missing vectors than the real brain has
  and still predicts only a quarter of the real gap: it gets the direction from the conditions it copies, and the size
  from something it doesn't copy.
- **Privacy relabelling.** The brain's privacy labels were still being corrected in windows. Its checkout held the same
  two relabel commits at the freeze and at the run, with none newer, so no window landed in between, but which windows
  those commits applied couldn't be reconstructed. The counts of private pages taken at the freeze and at the run used
  different queries and aren't compared. A recheck at the freeze found no privacy label on any of the 60 gold pages.
- **One writer, one sample.** Wintermute wrote all 50 questions and their gold from one seeded sample of pages, none of
  them a real question that once failed. The sample leans to older pages (8 of 49 dated gold pages are from 2026-10-09
  or later; batch 2 had 33 of 58), and all 10 topic questions are about meetings.
- **One form dropped.** One reworded topic question was excluded because lexical hybrid search ran degraded on it, so
  every reworded contrast uses 49 questions.
- **The band's 95% is nominal.** At 50 questions, a bootstrap band covers less than its stated level, so a qualifying
  contrast is read for its direction.
- **Power.** The primary's smallest detectable difference at batch 4's 31% discordant pairs (15 of 49) is about 20
  points; the real gap of 26.5 is above it.

## How it ran

1. **Freeze.** Wintermute wrote 50 questions, 10 of each of five types, and froze them on 2026-11-12 at 04:09 UTC with
   `run.ts freeze --protocol batch4` at gbrain-evals `ecf8169c` on a clean tree, with gbrain 0.60.682.0
   (`42faabf2`). The freeze checked the three earlier question files and found 0 shared question ids, forms and gold
   pages. The [frozen sample](live-recall/PREREGISTRATION.md#2026-11-12-batch-4-frozen-sample) and
   [`freeze.json`](live-recall-batch4/freeze.json) were committed before any search.
2. **Counted run.** One run, from 04:32:18 to 04:42:58 UTC, from `ecf8169c` on a clean tree, with gbrain 0.60.682.0
   loaded over this repository's pin of 0.60.623.0, schema 304, through Supabase's session pooler. It read the brain
   through a database role with no write privilege, and the session was checked read-only at the start and the end.
   The harness's write guard refused 17 writes gbrain attempted during the run (16 of its per-query telemetry counters
   and 1 insert). All 50 questions loaded, and no
   gold page was missing.
3. **Scoring.** The scorecard is committed as the run wrote it
   ([`b4-scorecard.json`](live-recall-batch4/b4-scorecard.json), sha256 `52d73b12…7edff1`).
   `export-references.ts` turns it into the `live-recall-b4` reference, and `verdict.ts` reads G2's counted synthetic
   scorecard (sha256 `9c46cada…0264`) against it. No rule, sign, threshold or synthetic file changed after the batch
   arrived. The only code change on this side since the amendment merged makes the reference export list a skipped
   comparison instead of crashing on it; batch 4 skipped none, so it changes nothing here.
4. **Family band.** One max-t bootstrap over the 16 contrasts, resampling 50 questions within 5 types (seed 20261106,
   10,000 draws): critical value 2.889, against Bonferroni's 2.955.

## Reproduce and inspect

- `bun eval/runner/predictive/export-references.ts` rebuilds `eval/data/validity-references/live-recall-b4.json` from
  the committed scorecard.
- `bun eval/runner/predictive/verdict.ts --measure G2 --synthetic
  docs/benchmarks/predictive-measures/g2/real-593/scorecard.json --out <file>` reproduces
  [`verdicts/G2-batch4.json`](predictive-measures/verdicts/G2-batch4.json), outcome and layer included. Add
  `--secondary` and the clean scorecard (`g2/secondary/clean-593/scorecard.json`) for
  [the clean brain's reading](predictive-measures/verdicts/secondary/G2-batch4-clean-593.json). The batch 2 and
  batch 3 verdict files stay as published.
- The batch 4 questions and pages stay on Wintermute's box. Only the freeze record and the scorecards, which hold
  counts and rates, left it.

## Disclosures

gbrain is Garry Tan's own project.
