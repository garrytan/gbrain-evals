# Do vectors help gbrain find a paraphrased page on Garry's brain? Live-recall batch 2

Measured on 2026-11-07 between 21:15 and 21:24 UTC, on the box that holds Garry Tan's gbrain brain, under the
[batch 2 amendment](live-recall/PREREGISTRATION.md#batch-2-amendment) to the live-recall preregistration. The 50
questions were written fresh and frozen before any batch 2 search, and none of their gold pages was used in
[batch 1](2026-11-06-live-recall-batch1.md). The runner was gbrain-evals
[bbde967d](https://github.com/garrytan/gbrain-evals/commit/bbde967d458f6f2a9f0d6ea6e1ab647895db1fff). Its commit and
harness digest were recorded in the preregistration before the run. The gbrain under test was 0.60.593.0 at `27f8b9d6`,
the stable release the box was upgraded to that morning, loaded as a verified overlay. gbrain-evals pins 0.60.557.0 at
`62637c96a`. The rest of the setup: Postgres schema 291, pgvector 0.8.2, search mode `tokenmax`, embeddings
`voyage:voyage-4` and reranker `voyage:rerank-2.5`.

gbrain is a personal knowledge brain. It stores Markdown pages in Postgres and finds them with keyword, vector and
hybrid search. Wintermute, the agent that runs on Garry's box, wrote the questions, each in two forms. It ran this
harness against the live brain through a database role that cannot write, and sent back aggregate scorecards. No
question, page text, slug or result left the box.

## The finding

- **Both preregistered comparisons hold.** On paraphrased questions, vectors lift gbrain's lexical hybrid from 16% to
  34%, a gain of 18 points (95% interval 4 to 32, Holm-adjusted p 0.036). That is P1. Configured search lifts the
  lexical hybrid from 16% to 48%, a gain of 32 points (16 to 48, Holm-adjusted p 0.0024). That is P2. P1 is the
  batch 1 result that didn't hold at its size, now tested where batch 1 pointed and on new questions. It holds.
  Its interval is wide, and its effect on MRR doesn't clear zero (see [Results](#preregistered-comparisons)).
- **Configured search finds the answer page in its top five for 68% of question forms** (59 to 77). That's 88% on
  exact forms and 48% on paraphrases. Configured search is the brain's own setting: hybrid search with Voyage's
  rerank-2.5 reranker.
- **The paraphrase gap is 40 points** for configured search, 88% against 48% (interval −56 to −24). Batch 1's gap was
  28 points. The gap passes the preregistration's 20-point line again. gbrain's maintainers have already judged it real
  and specific to this brain, so it goes to them as a recall-quality observation (see [Paraphrase gap](#paraphrase-gap)).
- **The upgrade changed nothing measurable.** The same 50 questions run on the gbrain the box used before the upgrade
  (0.60.577.0) give identical success@5 in every arm and form. MRR moves by at most 0.003.
- **Pooling both batches on 0.60.577.0** (100 questions, a declared secondary) puts vectors' paraphrase gain at
  20 points (10 to 30). Configured search finds the page for 72% of forms there, 89% exact and 55% paraphrased.

This is one run on one brain, with 50 questions written by one agent from a seeded sample of pages. None of them is a
real question that once failed. The [caveats](#caveats) apply to every number here.

## The experiment

What carries over from batch 1: question types, the two forms, arms, metrics, eligibility rule, custody and decision
rules. They're described in the [batch 1 findings](2026-11-06-live-recall-batch1.md#the-experiment) and the
[preregistration](live-recall/PREREGISTRATION.md). What batch 2 changed:

- **The primary comparisons.** P1 is `hybrid` minus `hybrid_lexical` on paraphrase forms only, one pair per
  question. P2 is unchanged: `configured` minus `hybrid_lexical` on paraphrases. The two are Holm-adjusted together.
- **The questions.** 50 new questions, 10 of each type, 100 forms in all, question file sha256 `dd69701c…`. There are
  58 distinct gold pages, none of them a batch 1 gold page. Gold was chosen page first from a seeded sample of 70
  recent and 70 older pages. The 10 error_string questions have 10 distinct gold pages. All 50 gold pages were present
  at run time, all 10 time_window questions carried a window, and no paraphrase shares an identifier-like token with
  its exact form.
- **The gbrain.** The counted run measures 0.60.593.0, the version deployed on the box, as gbrain's maintainers asked.
  A second run of the same file on 0.60.577.0 supplies the pooled analysis and the version comparison.
- **The barrier.** A fresh `no_write_privilege` role with batch 1's final grants. The runner proved it before any
  search, forced every gbrain transaction read-only, and found the session still read-only at the end. The guard
  refused 16 writes to gbrain's `search_telemetry` counters, as designed. The role was torn down at 21:26 UTC.

A form counts only when all five common arms answered it cleanly, and 100 of 100 did. No chat model was called.

## Results

### Arms

success@5 in percent, with 95% intervals, on 0.60.593.0. The `configured_window` row covers the 20 windowed
time_window forms.

| Arm | All forms (n = 100) | Exact (n = 50) | Paraphrase (n = 50) | MRR, all forms |
|---|---|---|---|---|
| `keyword` | 32 (25 to 38) | 64 (50 to 76) | 0 (0 to 7) | 0.29 |
| `vector` | 44 (33 to 55) | 56 (42 to 69) | 32 (21 to 46) | 0.32 |
| `hybrid_lexical` | 48 (40 to 56) | 80 (67 to 89) | 16 (8 to 29) | 0.39 |
| `hybrid` | 54 (44 to 64) | 74 (61 to 84) | 34 (22 to 48) | 0.43 |
| `configured` | 68 (59 to 77) | 88 (76 to 94) | 48 (35 to 62) | 0.61 |
| `configured_window` (n = 20) | 100 (100 to 100) | 100 (72 to 100) | 100 (72 to 100) | 1.00 |

### Preregistered comparisons

| Comparison | Pairs | A | B | Delta (95% CI) | Holm p | Smallest detectable | Result |
|---|---|---|---|---|---|---|---|
| P1: `hybrid` minus `hybrid_lexical`, paraphrases | 50 | 16 | 34 | +18 (+4 to +32) | 0.036 | 20.7 | holds |
| P2: `configured` minus `hybrid_lexical`, paraphrases | 50 | 16 | 48 | +32 (+16 to +48) | 0.0024 | 23.3 | holds |

Where they disagreed, hybrid won 12 questions and lost 3 (P1). Configured search won 19 and lost 3 (P2). The smallest
detectable difference is the runner's, at each comparison's observed share of disagreeing pairs. P1's 18 points sit
just below its 20.7, so the true gain could be anywhere from small to large. On MRR, P1's delta is +0.112 (interval
−0.006 to +0.237, unadjusted p 0.077), so the gain is clear in the top five and not yet in rank. That's descriptive,
because the preregistered test is on success@5. P2's MRR delta is +0.317 (+0.167 to +0.464).

### Declared secondaries

- **Batch 1's P1 on batch 2's questions** (`hybrid` minus `hybrid_lexical`, both forms, compared across versions):
  48% to 54%, +6 (−4 to +16), p 0.35, smallest detectable 14.8. It doesn't replicate at this size. The paraphrase
  half gains 18 points and the exact half loses 6 (80% to 74%), so the all-forms test mixes a gain with a small loss.
  **Why null (R48):** On exposure, the hybrid arm embedded all 100 forms and reported no failure stage. On task fit,
  vectors should help where wording differs, and on exact forms the lexical hybrid is already at 80%. On power, 6
  points is under the 14.8 this sample can detect. The frontier-substitute check doesn't apply. Verdict: KEEP. The
  question it asks is better asked on paraphrases, which is P1 and holds.
- **Both batches pooled on 0.60.577.0** (batch 1's counted run and batch 2's 0.60.577.0 run, 100 questions, 200
  forms, unadjusted). `run.ts pool` scored them with batch 2's comparisons.

  | Comparison | Pairs | A | B | Delta (95% CI) | p |
  |---|---|---|---|---|---|
  | `hybrid` minus `hybrid_lexical`, paraphrases | 100 | 14 | 34 | +20 (+10 to +30) | 0.0007 |
  | `configured` minus `hybrid_lexical`, paraphrases | 100 | 14 | 55 | +41 (+30 to +52) | 0.0001 |
  | `hybrid` minus `hybrid_lexical`, both forms | 200 | 47.5 | 55.5 | +8 (+1 to +15) | 0.042 |

  Pooled success@5 for configured search is 72% (65.5 to 78) over all forms, 89% exact and 55% paraphrased. Batch 1's
  half is the data that suggested the paraphrase P1, so the pooled P1 doesn't confirm anything independently. Only
  batch 2's own P1 above does that.
- **The version change** (`run.ts compare`, 0.60.593.0 minus 0.60.577.0, the same 50 questions run 20 hours apart).
  success@5 is identical in every arm and form. MRR moves by at most 0.003 (`hybrid` exact, 0.612 to 0.609). Some
  top-five lists changed without changing whether the gold page was in them: `hybrid_lexical` on 11 of 100 forms,
  `vector` and `hybrid` on 8 each, `configured` on 3, `configured_window` on 2 of 20, and `keyword` on none. Some of
  that churn may come from pages written to the live brain between the two runs. This row is descriptive.

### By question type

success@5 on paraphrases, in percent, on 0.60.593.0. Each cell is 10 questions, so a type alone can't separate arms
closer than about 30 points.

| Type | `keyword` | `vector` | `hybrid_lexical` | `hybrid` | `configured` |
|---|---|---|---|---|---|
| identifier | 0 | 30 | 40 | 30 | 40 |
| error_string | 0 | 0 | 10 | 10 | 10 |
| time_window | 0 | 60 | 0 | 60 | 90 (100 with its window) |
| cross_source | 0 | 10 | 10 | 10 | 30 |
| topic | 0 | 60 | 20 | 60 | 70 |

On exact forms, configured search scores 70% on error_string, 80% on identifier, 90% on cross_source and 100% on
time_window and topic. The error_string paraphrases are the hardest cell: every arm finds at most 1 of 10. Their gold
pages are mostly archived chat transcripts, and a paraphrase of an error message drops the error's own words.

### Descriptive contrasts

These are reported with intervals and were not tested.

- Configured search beats plain hybrid by 14 points over both forms (interval 6 to 22). That gain mixes the reranker
  with `tokenmax`'s other settings, and this run can't separate them.
- Keyword search finds nothing on any paraphrase (0 of 50).
- The date window adds 5 points on the 20 windowed forms, 95% to 100% (interval 0 to 15). Configured search alone was
  already near the top there.
- Vector search alone (44%) beats keyword search alone (32%) by 12 points (interval 0 to 23, p 0.066).
- Paraphrases cost every arm. Keyword loses 64 points, the lexical hybrid 64, hybrid 40, configured search 40 and
  vector 24.
- gbrain marked 63 of the 100 forms `keyword_candidates_incomplete` in every hybrid arm: 48 of the 50 paraphrases
  and 15 of the 50 exact forms. It also marked 10 of the 20 windowed forms, all of them paraphrases. The
  preregistration counts that stage as how the brain behaves, not as a failure.
- Harness latency for configured search was 0.93 s at the median and 1.56 s at p95, through the session pooler with
  a pool of two. That isn't what Garry sees.

### Paraphrase gap

Configured search found 88% of exact forms and 48% of paraphrases. In 22 questions the exact form found the page and
the paraphrase didn't, and in 2 it went the other way. That passes the preregistration's line of a 20-point loss with
the interval excluding 0. Batch 1 crossed the same line at 28 points. Its public synthetic reproduction on the
`live-recall-v1` fixture didn't reproduce the gap, even with 304 distractor pages added. gbrain's Captain (GBRA-108)
then judged the gap real, specific to this brain, and a recall-quality problem. That reproduction doesn't depend on
which private questions were asked, so batch 2 didn't run it again. Batch 2's aggregates went to GBRA-108 as an
observation.

**Synopsis coverage**, as the amendment asked, from GBRA-295's read of the production brain on 2026-11-06 (before the
upgrade). No page carries `tokenmax`'s per-chunk synopsis vectors: 24.7% of chunks are on the title tier and 75.3%
record no tier. 10% of the brain's 883,974 chunks have no vector at all. `keyword_candidates_incomplete` fires when a
question's strict keyword match is empty and gbrain falls back to a broader OR search, which fits paraphrases written
to avoid their page's words. These figures were not read again after the upgrade.

### Runs that didn't count

Each of these stopped at the arm preflight, before the first question, so no question ran and nothing was scored.

- **0.60.577.0, 01:12 UTC.** `LR_ARM_PREFLIGHT: configured_window degraded (keyword_arm_failed)`, while gbrain's
  two-hourly maintenance job was running. It reran at 01:26 UTC, after the job finished.
- **0.60.593.0, 18:54 and 19:21 UTC.** The same abort. The first attempt's log shows the probe's keyword statement
  hitting gbrain's own keyword statement bound (`search.keyword_statement_timeout_ms`, 8 s by default), with a
  doctor-refresh job running. The second started with no gbrain job active. The probe had been
  `live-recall arm preflight probe`, whose common words and all-time date window made its keyword statement the most
  expensive one the runner sends. It became two made-up words, `zqxjvk wfpqyz`, and that change was recorded in the
  amendment before the counted run. The probe never counts, so no counted query changed. The 0.60.577.0 run used the
  old probe.

## What to use and what to avoid

- For paraphrased questions, use configured search with its reranker on. It finds 48% of them here and 55% across
  both batches. The lexical hybrid finds 16% and plain keyword search none.
- Turning on vectors without the reranker roughly doubles the lexical hybrid on paraphrases, 16% to 34% here. That's
  most of the way to configured search on topic and time_window questions, and almost no help on error_string or
  cross_source ones.
- For questions in the page's own words, the lexical hybrid already finds 80% and configured search 88%.
- Don't upgrade from 0.60.577.0 to 0.60.593.0 expecting better recall, and don't hold back for fear of worse. On these
  questions the two are the same.
- Don't rank question types on these numbers. Each type is 10 questions.

## Caveats

From Wintermute, about the question set:

- Every gold page came from a seeded sample of pages, and each question was written after reading its page, so none is
  a real ask that once failed. Every such ask Wintermute could recall had been answered only in a session, never on a
  page.
- Wintermute rates 5 of the 10 cross_source pairings as weak: each page holds half the answer, but the pairing is its
  own choice. In batch 1 it rated 2 of 10 that way. So the cross_source cells are the least trustworthy here.
- Import lag: email pages from 2026-10-30 onward didn't resolve on the box, so five gold pages were swapped for pages
  that resolve. The newest email isn't in the sample. The newest gold page is dated 2026-11-06 by its path. 52 of the
  58 gold pages carry a date in their path, and 33 are dated 2026-10-09 or later.
- By source: meeting 27, brain 13, conversation 9, ops 1. That mix differs from batch 1 (ops 15, brain 14, meeting
  13, conversation 8), so the two batches' rates aren't directly comparable.

From the design:

- One writer who knows the brain wrote the questions and picked the gold, so paraphrase difficulty and topic choice
  follow that writer's sense of the brain.
- The run read the live brain, so a page written during its eight minutes could change what it found.
- The configured arm's gain over hybrid combines the reranker with `tokenmax`'s other settings.
- The numbers belong to 0.60.593.0 at `27f8b9d6`, which gbrain-evals loads as an overlay. The repository's pin is
  0.60.557.0.

## Reproduce and inspect

- **Scorecards.** [0.60.593.0, the counted run](2026-11-07-live-recall-batch2/b2-593-scorecard.md)
  ([JSON](2026-11-07-live-recall-batch2/b2-593-scorecard.json)) and
  [0.60.577.0](2026-11-07-live-recall-batch2/b2-577-scorecard.md)
  ([JSON](2026-11-07-live-recall-batch2/b2-577-scorecard.json)). There are also the
  [pooled analysis](2026-11-07-live-recall-batch2/pool-b1b2.json) and the
  [version comparison](2026-11-07-live-recall-batch2/version-b2-compare.json). All four pass the runner's structural
  custody check (`validateScorecard`). The per-query detail and gbrain's log stay on Garry's box.
- **The runs.** [RUN-KIT.md](live-recall/RUN-KIT.md) has the commands. The counted run was
  `run.ts run --questions <file> --freeze <freeze.json> --gbrain <checkout>@27f8b9d6`, with the role's URL in
  `LIVE_RECALL_DATABASE_URL`. It took 8 minutes 21 seconds. Then came
  `run.ts compare --a <0.60.577.0 run> --b <0.60.593.0 run>` and `run.ts pool` over batch 1's counted run and the
  0.60.577.0 run. The 0.60.577.0 run used gbrain-evals `07bed75d`. Its live-recall runner and the modules that runner
  imports differ from `bbde967d`'s only in the preflight probe.
- **The harness control, keyless.** `bun eval/runner/live-recall/run.ts run --fixture --gbrain <gbrain
  checkout>@52b9ccae42cd81e16c21624c545a9c02c3505c11` still passes the arm preflight and scores success@5 of 35.0%
  (keyword), 75.0% (vector), 87.5% (hybrid_lexical), 77.5% (hybrid) and 85.0% (configured). Those numbers prove the
  harness, not search quality.
- **Cost.** We made no paid model calls for the runs. Wintermute's query embeddings and rerank calls went on the box's
  Voyage key, and we didn't meter them.

## Not verified

- Wintermute's Voyage spend for the runs.
- That no page changed in the brain during or between the runs.
- That the gbrain the box serves day to day is the same commit as tag v0.60.593.0. The runner loaded `27f8b9d6`
  from a checkout and checked its schema against the brain's.
- Synopsis coverage after the upgrade.
- Which of `tokenmax`'s settings besides the reranker account for configured search's lead over hybrid.

## Disclosures

gbrain is Garry Tan's own project.
