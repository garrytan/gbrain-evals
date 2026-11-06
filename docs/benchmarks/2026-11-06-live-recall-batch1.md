# How often does gbrain find the right page on Garry's own brain? Live-recall batch 1

Measured on 2026-11-06 between 21:09 and 21:18 UTC, on the box that holds Garry Tan's gbrain brain, under the
[live-recall preregistration](live-recall/PREREGISTRATION.md). The question set was frozen before any counted search.
The runner was gbrain-evals [d4651999](https://github.com/garrytan/gbrain-evals/commit/d46519990a14042cae9c563f785408977b721605)
(v0.10.166). The gbrain under test was 0.60.577.0 at `52b9ccae`, the version that box runs, loaded as a verified
overlay; gbrain-evals pins 0.60.557.0 at `62637c96a`. Postgres schema 286, pgvector 0.8.2, search mode `tokenmax`,
embeddings `voyage:voyage-4`, reranker `voyage:rerank-2.5`.

gbrain is a personal knowledge brain: it stores Markdown pages in Postgres and finds them with keyword, vector and hybrid
search. Wintermute is the agent that runs on Garry's box. It wrote 50 questions about pages in the brain, each in two
forms, ran this harness against the live brain through a database role that cannot write, and sent back an aggregate
scorecard. No question, page text, slug or result left the box.

## The finding

- **Configured search finds the answer page in its top five for 76% of question forms** (95% interval 66 to 85). That
  is 90% on exact forms, which use the page's own words, and 62% on paraphrases, which avoid them. Configured search
  is the brain's own setting: hybrid search with Voyage's rerank-2.5 reranker.
- **P2 holds.** On paraphrases, configured search beats gbrain's lexical hybrid by 50 points, 12% to 62% (interval 36
  to 64, Holm-adjusted p 0.0002). It won all 25 questions where the two disagreed.
- **P1 does not hold.** Adding vectors to the lexical hybrid adds 10 points over both forms, 47% to 57% (interval 1 to
  20), but the Holm-adjusted p is 0.092, and the smallest effect this sample could reliably detect was 14.4 points.
  The gain sits on paraphrases (12% to 34%); on exact forms the lexical hybrid is already at 82% and hybrid scores
  80%. The R48 verdict is KEEP: the test was underpowered, which is different from showing no effect. Batch 2 makes
  the paraphrase form P1's primary and tests it on a new, independent question set.
- **Paraphrases cost configured search 28 points**, 90% to 62% (interval -40 to -16). In all 14 questions where the two
  forms disagreed, the exact form found the page and the paraphrase missed it. That passes the preregistration's
  20-point line, so the gap went to gbrain's maintainers (GBRA-108) as an observation, with a public reproduction
  attempt described under [Paraphrase gap](#paraphrase-gap).

This is one run on one brain, with 50 questions written by one agent from a random sample of pages. None of them is a
real question that once failed. The [caveats](#caveats) apply to every number here.

## The concrete case

These examples are invented. The real questions stay on Garry's box.

- **identifier.** Exact: "What changed in the VND-4417 migration?" Paraphrase: "What did the vendor-table migration
  last spring change?"
- **error_string.** Exact: "Where did we see `ECONNRESET on pool checkout`?" Paraphrase: "When did the database pool
  start dropping connections?"
- **time_window.** Exact: "What did the October 14 board prep say about hiring?" Paraphrase: "What did we plan for
  hiring before the mid-October board meeting?" A time_window question can carry a date window, which only the
  `configured_window` arm uses.
- **cross_source.** A question whose answer needs two pages, for example a meeting note and the project page it refers
  to.
- **topic.** A question about a subject rather than a token: "How do we decide which founders get office hours?"

**success@5** is the share of question forms where a gold page (the page Wintermute picked as the answer) is among the
first five distinct pages the search returns. **MRR** is the mean of 1 / rank of the first gold page, counting 0 when
it is not in the first 20.

## The experiment

**Corpus.** Garry's live brain, read through `no_write_privilege`: a role with SELECT on gbrain's tables, USAGE on
the `extensions` schema, BYPASSRLS, EXECUTE on five of gbrain's helper functions (none of them SECURITY DEFINER), and
no write privilege, sequence grant or role membership. GBRA-108 approved it. The runner proved that barrier against
the database before any search, connected through Supabase's session pooler, forced every gbrain transaction
read-only, and found the session still read-only at the end. The guard refused 17 writes to gbrain's
`search_telemetry` counters, as designed.

**Questions.** 50 questions, 10 of each type, 100 question forms in all, question file sha256 `88eaa30c…`. Every gold
page was chosen page first: Wintermute drew a seeded random sample of pages, read each one, then wrote both forms. All
50 gold pages were present, all 10 time_window questions carried a window, and no paraphrase shares an identifier-like
token with its exact form.

**Arms.** Each question form went through every arm, one at a time, with query expansion off everywhere, so no chat
model was called.

| Arm | What runs |
|---|---|
| `keyword` | gbrain's keyword search alone (descriptive contrast) |
| `vector` | vector search alone, with the hybrid arm's query embedding |
| `hybrid_lexical` | gbrain's hybrid search with its vector leg off: keyword and title legs, no reranker |
| `hybrid` | hybrid search: keyword plus vector fusion, no reranker |
| `configured` | hybrid search as the brain is configured (`tokenmax`, rerank-2.5, its default result limit) |
| `configured_window` | `configured` plus the question's date window (time_window questions only) |

**Statistics.** Rates over one form carry Wilson intervals; rates over both forms and MRR use a cluster bootstrap over
questions (seed 20261106, 10,000 draws). Paired comparisons give B minus A with a sign-flip p clustered by question.
P1 and P2 are Holm-adjusted together. A form counts only when all five common arms answered it cleanly: 100 of 100 did.

## Results

### Arms

success@5 in percent, with 95% intervals. The `configured_window` row covers the 20 windowed time_window forms.

| Arm | All forms (n = 100) | Exact (n = 50) | Paraphrase (n = 50) | MRR, all forms |
|---|---|---|---|---|
| `keyword` | 36 (30 to 42) | 72 (58 to 83) | 0 (0 to 7) | 0.32 |
| `vector` | 40 (30 to 50) | 50 (37 to 63) | 30 (19 to 44) | 0.28 |
| `hybrid_lexical` | 47 (40 to 54) | 82 (69 to 90) | 12 (6 to 24) | 0.37 |
| `hybrid` | 57 (48 to 66) | 80 (67 to 89) | 34 (22 to 48) | 0.46 |
| `configured` | 76 (66 to 85) | 90 (79 to 96) | 62 (48 to 74) | 0.65 |
| `configured_window` (n = 20) | 60 (30 to 85) | 70 (40 to 89) | 50 (24 to 76) | 0.60 |

### Preregistered comparisons

| Comparison | Pairs | A | B | Delta (95% CI) | Holm p | Smallest detectable | Result |
|---|---|---|---|---|---|---|---|
| P1: `hybrid` minus `hybrid_lexical`, all forms | 100 | 47 | 57 | +10 (+1 to +20) | 0.092 | 14.4 | does not hold |
| P2: `configured` minus `hybrid_lexical`, paraphrases | 50 | 12 | 62 | +50 (+36 to +64) | 0.0002 | 20.0 | holds |

On MRR, P1's delta is +0.099 (interval +0.037 to +0.162, unadjusted p 0.006). That is descriptive, because the
preregistered test is on success@5.

**Why P1 is null (R48).** Exposure: the hybrid arm embedded all 100 forms and reported no failure stage. Task fit: vectors
should help where wording differs, and the exact forms leave little room, since `hybrid_lexical` already finds 82% of
them. Power: 50 questions give a detectable difference of 14.4 points over both forms; the observed 10 is below it.
Frontier substitute: not applicable. Verdict KEEP. Batch 2 tests the paraphrase form, where batch 1 shows the gain
descriptively (12% to 34%).

### By question type

success@5 on paraphrases, in percent; each cell is 10 questions, so a type alone can't separate arms closer than about
30 points.

| Type | `keyword` | `vector` | `hybrid_lexical` | `hybrid` | `configured` |
|---|---|---|---|---|---|
| identifier | 0 | 30 | 10 | 40 | 50 |
| error_string | 0 | 50 | 10 | 40 | 70 |
| time_window | 0 | 0 | 0 | 0 | 30 (50 with its window) |
| cross_source | 0 | 40 | 20 | 60 | 60 |
| topic | 0 | 30 | 20 | 30 | 100 |

On exact forms, configured search scores 80% (cross_source) to 100% (topic) on every type.

### Descriptive contrasts

These are reported with intervals and were not tested.

- Configured search beats plain hybrid by 19 points over both forms (interval 13 to 26). That gain mixes the reranker
  with `tokenmax`'s other settings, and this run can't separate them.
- Keyword search finds nothing on any paraphrase (0 of 50). On cross_source questions it scores 5% over both forms,
  against 70% for configured search.
- The date window adds nothing on average: `configured_window` and `configured` both score 60% on the 20 windowed
  forms (delta 0, interval -30 to +30).
- Vector search alone (40%) is not distinguishable from keyword search alone (36%), and it is the only arm that loses
  less than 25 points on paraphrases (50% to 30%).
- gbrain marked 57 of the 100 forms `keyword_candidates_incomplete` in every hybrid arm (48 of the 50 paraphrases and
  9 of the 50 exact forms), and 13 of the 20 windowed forms. That stage means gbrain's Postgres keyword ranking stopped at its 50,000-match bound, retried with fewer words,
  or hit its CJK deadline. The preregistration counts it as how the brain behaves, not as a failure, so those forms
  count. It went to GBRA-108 with the paraphrase gap, as an observation.
- Harness latency for configured search was 0.92 s at the median and 1.28 s at p95, through the session pooler with a
  pool of two. That is not what Garry sees.

### Attempt 1 measured nothing

The first counted attempt (20:56 to 21:04 UTC, same frozen file) ran with a role that lacked EXECUTE on
`gbrain_fts_input`, a helper gbrain's keyword and title legs call. The scorecard excluded all 100 forms because
`hybrid_lexical` reported a failure stage on each, and Wintermute's tally of the local detail found
`title_arm_failed` on all 320 queries in the four arms that run hybrid search (184 of them also
`keyword_candidates_incomplete`). So 0 of 100 forms were eligible and no comparison could be made. It's recorded as a harness failure, and its scorecard is kept below. GBRA-108 granted
EXECUTE on five helpers (`gbrain_fts_input`, `gbrain_fact_fingerprint`, `gbrain_fact_fingerprint_v1`,
`gbrain_fact_normalize`, `gbrain_try_jsonb`, none SECURITY DEFINER), and attempt 2 ran five minutes later. The runner now
sends one public probe query through every arm before the first question and stops with `LR_ARM_PREFLIGHT` if any arm
fails, so a missing grant like this one ends the run before it starts.

### Paraphrase gap

The preregistration asks for a public, synthetic reproduction when configured search loses 20 points or more on
paraphrases. On the public 30-page fixture (`eval/data/live-recall-v1`), with the same embedding model, reranker and
mode and real Voyage calls (about $0.01), configured search scored 100% on both forms, so the gap did not reproduce.
The keyword half did: plain keyword fell from 70% to 0%, and the lexical hybrid from 100% to 75%. A 30-page corpus puts
a sixth of the brain in every top five, so it can't show a gap that depends on many near-neighbour pages.
One attempt to raise the ceiling added 304 template-written distractor pages (334 chunks in all) that share
vocabulary with the gold pages but don't answer the questions. They pulled the lexical hybrid's paraphrase score from
75% to 45%, and the hash-embedding control's configured paraphrase score from 70% to 45%. Configured search with
Voyage stayed at 100% on both forms, with identical gold ranks across two runs, for about $0.017.

Afterwards GBRA-295 read aggregates from the production brain (2026-11-06, 22:25 to 22:30 UTC). No page there carries
`tokenmax`'s per-chunk synopsis vectors: 24.7% of chunks are on the title tier and 75.3% record no tier, so the
reproduction, which also ran on the title tier, did not miss synopses the brain has. 10% of the brain's 883,974 chunks
have no vector at all. GBRA-295 also found that `keyword_candidates_incomplete` fires when a question's strict keyword
match is empty and gbrain falls back to a broader OR search, and that eight typical recall questions never reached
it. In this run the stage marked 48 of the 50 paraphrases and 9 of the 50 exact forms in every hybrid arm, which fits
paraphrases written to avoid their page's words. So the private gap depends on something this synthetic setup lacks,
such as real scale, near-duplicate prose, longer pages or chunks without vectors. Neither run is evidence of a gbrain
bug, and the gap went to GBRA-108 as an observation. The reproduction scripts are not part of this repository.

## What to use and what to avoid

- For questions in the page's own words, gbrain's lexical hybrid already finds the page in its top five 82% of the
  time, and configured search 90%.
- For paraphrased questions, use the configured search with its reranker on. The lexical hybrid finds 12% of them and
  plain keyword search none.
- Time-window paraphrases were the weakest type (30%, or 50% for the 10 questions run with their window). Don't
  count on a date window to fix a vague question: on average it added nothing here.
- Don't rank question types on these numbers. Each type is 10 questions.
- Wintermute's earlier session-search baseline measured a different system on different questions, and these numbers
  are not comparable with it.

## Caveats

From Wintermute, about the question set:

- All 50 gold pages came from a seeded random sample of pages, and each question was written after reading its page,
  so none is a real ask that once failed.
- Wintermute rates 2 of the 10 cross_source pairings as weak: each page holds half the answer, but the pairing is its
  own choice.
- The 10 error_string questions come from 6 pages, and several share a gold page, so that type tests fewer than 10
  pages.
- No page from the week of the freeze is in the sample.
- By source: ops 15, brain 14, meeting 13, conversation 8.

From the design:

- One writer who knows the brain wrote both the questions and the gold, so paraphrase difficulty and topic choice follow
  that writer's sense of the brain.
- The run read the live brain, so a page written during its eight minutes could change what it found.
- The configured arm's gain over hybrid combines the reranker with `tokenmax`'s other settings.
- The box runs gbrain 0.60.577.0 (`52b9ccae`), which gbrain-evals loads as an overlay; the repository's pin is
  0.60.557.0. The numbers belong to 0.60.577.0.

## Batch 2

A second set of 50 questions, written fresh with no batch-1 gold page reused, runs under the
[batch 2 amendment](live-recall/PREREGISTRATION.md#batch-2-amendment) on the gbrain the box runs after its upgrade to
v0.60.593.0. Its P1 is `hybrid` minus `hybrid_lexical` on paraphrases; P2 is unchanged, and the two are
Holm-adjusted together. Batch 1's all-forms P1 is reported as a secondary replication across versions. The two batches
pooled (N = 100) are a declared secondary when batch 2 also runs on batch 1's gbrain; otherwise the pool is reported as
not computable.

## Reproduce and inspect

- **Scorecards.** [Attempt 2](2026-11-06-live-recall-batch1/attempt2-scorecard.md)
  ([JSON](2026-11-06-live-recall-batch1/attempt2-scorecard.json)), the run reported here, and
  [attempt 1](2026-11-06-live-recall-batch1/attempt1-scorecard.md)
  ([JSON](2026-11-06-live-recall-batch1/attempt1-scorecard.json)), the failed one. Both pass the runner's structural
  custody check (`validateScorecard`). The per-query detail and gbrain's log stay on Garry's box.
- **The run.** `docs/benchmarks/live-recall/RUN-KIT.md` has the commands Wintermute ran: `run.ts freeze` on the
  question file, then `run.ts run --questions <file> --freeze <freeze.json> --gbrain <checkout>@52b9ccae` with the
  role's URL in `LIVE_RECALL_DATABASE_URL`. The run took 8 minutes 22 seconds.
- **The harness control, keyless.** `bun eval/runner/live-recall/run.ts run --fixture --gbrain <gbrain
  checkout>@52b9ccae42cd81e16c21624c545a9c02c3505c11` builds the public fixture with hash embeddings and scores
  success@5 of 35.0% (keyword), 75.0% (vector), 87.5% (hybrid_lexical), 77.5% (hybrid) and 85.0% (configured). Those
  numbers prove the harness, not search quality.
- **Cost.** We made no paid model calls for the run. Wintermute's query embeddings and rerank calls went on the box's
  Voyage key; the preregistration estimated well under $0.10, and we did not meter them.

## Not verified

- Wintermute's Voyage spend for the run.
- That no page changed in the brain during the run.
- Which of `tokenmax`'s settings besides the reranker account for configured search's lead over hybrid.

## Disclosures

gbrain is Garry Tan's own project.
