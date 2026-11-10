# BEAM questions their cited turns don't support, and our BEAM results without them

- **We learned that between about a quarter and a half of the BEAM questions behind our results have a reference answer
  that the turns they cite don't support, and that the share rises with conversation length. You should read every BEAM
  score, ours included, as carrying that noise, and check a generated benchmark's answers against the evidence they cite
  before trusting a small gap.** Of the 1,521 questions behind our published BEAM results that cite their evidence,
  33.8% have a reference answer that at least one of two validator models finds unsupported by the conversation turns
  the question cites, or cite no turn the conversation has: 27.5% at 100,000 tokens, 31.3% at 500,000, 33.5% at 1
  million and 52.2% at 10 million. Both validators reject 24.2%.
- **We learned that no published BEAM verdict depends on those questions. You should expect a rescore on fewer, cleaner
  questions to widen intervals more than it moves gaps.** Rescored on only the questions both validators pass, every
  preregistered outcome stays as published. Absolute scores rise (gbrain's BEAM-10M row from 56.3% to 64.8%), while
  paired gaps move a median of 2.8 points and their intervals get a median of 1.4 times wider. The BEAM-10M gap to an
  agent with grep holds at about 7.5 points: -8.7 (95% interval -16.4 to -1.4) on 198 questions, -7.5 (-19.5 to +4.2)
  on 86, still a gap the test can't separate.
- **Some descriptive comparisons move, in both directions.** Seven of gbrain's descriptive gains no longer exclude zero
  (five on BEAM-10M in the head-to-head, two in its newer rerun), and a new descriptive loss appears on BEAM-100K. The
  two published BEAM losses no longer exclude zero, and three gains newly exclude it, two of them only in the strictest
  view. Two published results can't be rescored, the rerun's D8 set isn't rescored, and the frontier-judge results
  aren't covered.

These are measurements of the benchmark, made on 2026-11-10, and of results already published. Nothing was rerun:
the rescore reuses each result's recorded answers and judgments.

## What gbrain and BEAM are

[gbrain](https://github.com/garrytan/gbrain) is a memory system for AI agents. [BEAM](https://github.com/mohammadtavakoli78/BEAM)
is a public benchmark of long chats between a user and an assistant, at 100,000, 500,000, 1 million and 10 million
tokens, with probing questions about ten abilities (abstention, contradiction resolution, event ordering, information
extraction, instruction following, knowledge update, multi-session reasoning, preference following, summarization and
temporal reasoning). A language model writes both the chats and the questions. Each question except an abstention
question names the turns its reference answer comes from (`source_chat_ids`), and a judge model grades an answer
against the reference with a rubric.

## The concrete case

An invented example of the pattern, not a BEAM question: the question asks which day the user moved a dentist
appointment to, and the reference answer says Thursday. The two cited turns show the user asking to move it and the
assistant offering Tuesday or Thursday, and no turn settles it. A reader with perfect memory of the conversation can't
get Thursday from it, so the judge marks a faithful answer wrong and rewards a lucky guess. Checking 1,521 real
questions this way, about a third fail, and at 10 million tokens about half do.

## How the check works

- **The check.** `eval/custody/rs1/validate.ts`, the gate the narrowed RS1 test runs on its own newly minted
  conversations, unchanged (SHA-256 `7805fa76…`, as at `de943504`). For each question it gives two validators from
  different families, gemini-3.8-flash and claude-haiku-5-5, the cited turns, the question and the reference answer, and
  each says whether the turns support the answer. A question fails when either says no, when none of its cited turns is
  in the conversation, or (once) when it repeats an earlier question. It ran with an empty public-text index, since
  these are BEAM's own conversations, and with its length target set to each tier.
- **Abstention questions** have the answer "the conversation doesn't say" and cite nothing, so they weren't checked.
- **Which questions.** Every cited question behind a published BEAM result except the rerun's D8 set (below): the
  head-to-head scoreboard's three BEAM sets and its 10-conversation sweep subset, its newer rerun on the same sets, and
  memory proof wave 2's 72 conversations. The 18 wave 2 conversations that are public in our split (324 questions) were
  checked in the open; the sealed ones (1,197 questions) were checked in custody, and only counts and the rescore tables
  came out.
- **How far to trust the validators.** They are models, and no person graded these questions. On 35 public questions
  checked twice, every question got the same pass or fail, though one validator changed its reading on 3 of them. On the
  narrowed RS1 test's own minted questions, written by the same BEAM generator, gpt-6.1-sol read 30 that the validators
  failed and found 28 unsupported. Neither check's per-question results are in this repository. The `both-out` view
  below drops only questions both validators reject, as the conservative case.

## How many questions fail

| BEAM tier | Cited questions | Either validator rejects, or no cited turn | 95% interval | Both validators reject | 95% interval |
|---|---|---|---|---|---|
| 100,000 tokens | 306 | 84 (27.5%) | 22.8 to 32.7 | 56 (18.3%) | 14.4 to 23.0 |
| 500,000 tokens | 504 | 158 (31.3%) | 27.5 to 35.5 | 104 (20.6%) | 17.3 to 24.4 |
| 1 million tokens | 531 | 178 (33.5%) | 29.6 to 37.6 | 129 (24.3%) | 20.8 to 28.1 |
| 10 million tokens | 180 | 94 (52.2%) | 45.0 to 59.4 | 79 (43.9%) | 36.8 to 51.2 |
| All | 1,521 | 514 (33.8%) | 31.5 to 36.2 | 368 (24.2%) | 22.1 to 26.4 |

The intervals treat questions as independent. They cluster in conversations, so the true intervals are wider. The
public half alone fails 23.6% at 100,000 tokens, 32.5% at 500,000 and 37.3% at 1 million, and the sealed half 28.6%,
31.0%, 32.3% and 52.2%, so both halves rise with length. Every public conversation has failing questions, from 2 to 9
of 18. In the public half, summarization (22 of 36) and multi-session reasoning (20 of 36) fail most often.

| Published result | Cited questions | Either rejects | Both reject |
|---|---|---|---|
| Head-to-head, BEAM-10M (10 conversations) | 180 | 94 (52.2%) | 79 (43.9%) |
| Head-to-head, BEAM-100K sealed (14) | 126 | 31 (24.6%) | 24 (19.0%) |
| Head-to-head, BEAM-1M sealed (24) | 216 | 75 (34.7%) | 57 (26.4%) |
| Memory proof wave 2 (72 conversations at 100K, 500K and 1M) | 1,296 | 406 (31.3%) | 278 (21.5%) |

## What removing them does to the published results

The rescore reruns each result's own published derivation on its recorded answers and judgments, with the failing
questions left out, and makes no model call. For the head-to-head and its rerun that is
`eval/runner/scoreboard.ts`'s own scoring on their campaign receipts, with the failing questions added to each BEAM
set's exclusions. For wave 2 it is that wave's restricted wild cluster bootstrap on its 500,000-token per-question
judgments. Every result keeps its published judge, BEAM's gpt-4.1-mini. In one cell, a ruling counted 10 gpt-6.1-sol
answers as gbrain's own failures, and those on excluded questions (5 of the 10 in the supported view) leave that count
with their questions.

There are three views. `supported` keeps only questions both validators pass and leaves abstention out; the tables
here use it. `flagged-out` drops any question that fails and keeps abstention. `both-out` drops only questions both
validators reject. The verdicts are the same in all three.

| Published result | As published | Supported questions only |
|---|---|---|
| Head-to-head (gbrain `f05943e6`), BEAM-10M, gbrain's 8,000-token row | 56.3% (50.1 to 62.5), 197 of 199 questions | 64.8% (54.0 to 74.2), 86 questions |
| The same questions, the file agent (list, `grep` and read tools over the same files) | 67.2% (64.0 to 70.7) | 75.7% (68.0 to 83.0) |
| The same questions, the question alone (no memory) | 25.8% (23.2 to 28.3) | 23.5% (19.0 to 28.3) |
| gbrain's whole system against the file agent, BEAM-10M | -8.7 points (-16.4 to -1.4), 198 questions, not separated | -7.5 points (-19.5 to +4.2), 86 questions, not separated |
| Every preregistered outcome in the head-to-head (85 comparisons) and its rerun (gbrain `0ccf2bdd`, 40) | as published | unchanged |
| Rerun, BEAM-10M, gbrain's 8,000-token row | 61.0% (57.2 to 65.1) | 73.4% (65.1 to 81.6) |
| Rerun, BEAM-1M sealed, gbrain against the memory-bank server | +1.3 points (-0.9 to +3.7) | +2.7 (-0.8 to +6.4) |
| Rerun, BEAM-1M sealed, gbrain against the extract-first server | +4.8 points (+2.6 to +7.1) | +5.7 (+1.7 to +9.6) |
| Memory proof wave 2 (gbrain `71b6d85`), 500,000-token stratum, facts plus pages against the memory-bank server | +3.11 points (one-sided 95% bounds +1.10 and +5.13), 560 questions | +4.01 (+1.60 and +6.42), 346 questions |

On supported questions, the head-to-head's headline BEAM-10M scores rise by 8.5 to 11.5 points for every memory system
but the temporal-graph library (3.2 points, on its 8 conversations), and the question alone falls by 2.3. Paired gaps
move much less: across the head-to-head's 59 scored answer comparisons the median gap moves 2.8 points. The largest
moves, up to 11.0 points, are against the no-memory and recency baselines; among memory systems the largest is 6.4.
Intervals get a median of 1.39 times wider (1.04 to 2.19), most at BEAM-10M, where fewer than half of the questions
remain.

## What moved

Separation means a 95% interval that excludes zero. Positive gaps favour gbrain. "All views" means the change appears
in all three views.

| Comparison (gbrain against) | As published | Supported only | Where it shows |
|---|---|---|---|
| **Gains that no longer exclude zero** | | | |
| Head-to-head, BEAM-10M, verbatim-session system at 8,000 tokens | +5.1 (+0.5 to +9.2) | +4.6 (-1.9 to +10.1) | all views |
| Head-to-head, BEAM-10M, hybrid search at 8,000 tokens | +4.3 (+0.9 to +7.8) | +3.7 (-1.9 to +10.0) | all views |
| Head-to-head, BEAM-10M sweep subset, temporal-graph library at 2,000 tokens | +9.4 (+2.3 to +17.3) | +9.8 (-1.2 to +22.0) | all views |
| Head-to-head, BEAM-10M sweep subset, verbatim-session system at 2,000 tokens | +8.7 (+2.7 to +14.5) | +2.3 (-7.8 to +11.8) | all views |
| Head-to-head, BEAM-10M sweep subset, hybrid search at 2,000 tokens | +10.1 (+3.4 to +16.1) | +9.6 (-2.8 to +20.4) | all views |
| Rerun, BEAM-10M, memory-bank server at 8,000 tokens | +5.7 (+1.6 to +9.7) | +6.5 (-0.9 to +14.5) | supported only |
| Rerun, BEAM-1M sealed, knowledge-graph pipeline at 8,000 tokens | +3.7 (+0.3 to +7.4) | +3.7 (-1.6 to +9.2) | all views |
| **A new loss** | | | |
| Head-to-head, BEAM-100K sealed, knowledge-graph pipeline at 8,000 tokens | -3.3 (-7.1 to +0.9) | -5.3 (-9.7 to -0.8) | all views |
| **Losses that no longer exclude zero** | | | |
| Head-to-head, BEAM-10M, file agent, each at its own default amount of evidence | -8.7 (-16.4 to -1.4) | -7.5 (-19.5 to +4.2) | all views |
| Head-to-head, BEAM-10M sweep subset, extract-first server at 16,000 tokens | -6.9 (-12.3 to -1.4) | -7.9 (-20.4 to +3.3) | all views |
| **Gains that newly exclude zero** | | | |
| Rerun, BEAM-10M, extract-first server at 8,000 tokens | +2.2 (-1.9 to +6.1) | +4.7 (+0.3 to +9.3) | all views |
| Head-to-head, BEAM-1M sealed, knowledge-graph pipeline at 2,000 tokens | +5.1 (-0.1 to +10.3) | +7.8 (+1.3 to +14.6) | supported only |
| Head-to-head, BEAM-1M sealed, verbatim-session system at 16,000 tokens | +2.4 (-1.3 to +6.3) | +6.1 (+1.2 to +11.1) | supported only |

Apart from the file-agent gap, a preregistered comparison that wasn't separated before or after, all of these are
descriptive comparisons, which the preregistrations never ranked. The scoreboard's "where gbrain loses" list on BEAM
goes from the file agent and the extract-first server on the sweep subset to the knowledge-graph pipeline on BEAM-100K.
One retrieval comparison in the rerun, the memory-bank server's recall of every needed session in the top ten, also
stops excluding zero (from -7.4, -13.9 to -1.4, to -5.8, -18.3 to +5.9); that row is incomplete and counts no verdict.

## What isn't covered

- **The memory proof wave's sealed run** (gbrain ahead of a memory-bank server by 2.64 points on 1,080 questions): its
  per-question rows were lost with its run machine on 2026-10-09, so it can't be rescored.
- **Wave 2's 100,000- and 1-million-token strata**: the repository keeps per-question judgments only for the
  500,000-token stratum (28 of the 72 conversations). Wave 2's published +4.0 points across all three tiers is not
  rescored as a whole.
- **The rerun's D8 set** (300 questions) is not rescored.
- **Frontier judges.** The rescore uses each result's published judge only, so the [judge-robustness
  results](2026-11-05-gst-1365-judge-robustness.md) under gpt-6.1-sol and claude-opus-5-5 aren't rescored.
- **Abstention questions** weren't checked.

## Limits

- An unsupported verdict is two models' reading of the cited turns, not ground truth. The answer may sit elsewhere in
  the conversation with a wrong citation, and the validators can be wrong. The `both-out` view is the conservative
  case, and it changes no verdict either.
- Leaving questions out changes what is measured: the questions that remain are the ones whose evidence the generator
  wrote cleanly, which may be easier or weighted differently across abilities. The supported scores are not "true"
  scores, and the published numbers stay the record.
- At BEAM-10M only 86 of 199 questions remain. Most of the head-to-head's BEAM-10M gaps (20 of 27 scored answer
  comparisons) move to a value inside their published interval, but most of its BEAM-10M scores (13 of the 16 with an
  interval) rise past theirs.

## Reproduce and inspect

Files in [2026-11-10-beam-item-support/](2026-11-10-beam-item-support/):

- `support-rates.json`: the counts above, for the public half, the sealed half and both, by tier and by result.
- `public-items.json`: the gates for each of the 324 public questions, by id (conversation, ability, index), with no
  question text.
- `rescore-q1.json` and `rescore-f6.json`: every cell and comparison of the head-to-head and its rerun under the
  three views, with the published value beside each.
- `rescore-wave2-500k.json`: wave 2's 500,000-token stratum under the three views.

The validator is `bun eval/custody/rs1/validate.ts` at `de943504`, run with `--target-tokens` of 100000, 500000,
1000000 or 10500000 and `--tolerance 0.9`. The scripts that build each tier's question set for it and run the rescore
are not in this repository yet. The sealed half can only be checked in custody.

## Disclosures

- gbrain is Garry Tan's own project.
- Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator.
  Garry Tan runs Y Combinator.
