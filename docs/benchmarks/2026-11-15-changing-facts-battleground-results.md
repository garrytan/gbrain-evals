# Changing-facts battleground results: gbrain is level with two memory servers on what is true now, and behind them on questions about the past

- **We learned that a fact layer is what answers questions after facts change, and that gbrain's way of keeping old facts
  with end dates did no better than servers that rewrite a fact on every update. You should put a fact layer between
  raw chat and the model that answers, whichever kind fits your system.** On 30 sealed, made-up chat histories of about
  200,000 tokens, where facts are updated, corrected, repeated after they went stale, contradicted or withdrawn, gbrain
  at its stable release was level with the memory-bank server (-0.4 points, 95% interval -2.4 to +1.5) and the
  extract-first server (-1.8, -3.9 to +0.3) on "what is true now", and ahead of the temporal-graph library by 20.9 points
  (+17.7 to +24.1). It was 73.7 points ahead of plain hybrid search over the same chats (+70.0 to +77.4), so its lead over
  search comes from its design, not from the reader.
- **We learned that gbrain loses questions about the past: what was true on a date, what was known at a date, and how a
  fact changed. You should hand the reader every dated version of a fact when the question names a past date or asks
  for the history, not only the current value.** On those questions gbrain was behind the memory-bank server by 10.3
  points (-13.0 to -7.7) and the extract-first server by 8.1 (-10.8 to -5.3). On "how did it change" questions, the values
  the answer needs reached the reader in 81% of gbrain's contexts against 98% and 97% for the two servers. On "what was
  known then" questions they reached it 96% of the time and gbrain still lost about 9 to 10 points, so most of that loss
  is in what gbrain hands the reader, not in finding it. gbrain also lost on withdrawn facts.
- **We learned that gbrain's answers cost about a third as much per correct answer as the extract-first server's and
  the temporal-graph library's, and about 9% more than the memory-bank server's.** With particle-1 reading, a correct
  answer cost $0.0079 with gbrain and $0.0082 with the memory-bank server; with claude-opus-5-5 reading, $0.0550 against
  $0.0478, about 15% more.

This is the results file of the [changing-facts battleground preregistration (BG1)](2026-11-09-changing-facts-battleground-preregistration.md).
The preregistered verdict is **no measurable difference** against the memory-bank server and the extract-first server,
and **ahead** against the temporal-graph library, by more than 5 points. Nothing dropped: all 1,920 planned questions
are in every comparison, from all three readers. Every number here is on synthetic histories, at one gbrain build and an
8,000-token reading budget.

## The test

Each history is one person's chats over many sessions. A generator plans which facts change and how, a renderer writes
the chats, and an oracle over the plan holds the gold answer for every question. The 30 worlds were minted in custody
and never seen by anyone developing a system. Each world has 64 questions in eight kinds:

| Kind | Family | What it asks |
|---|---|---|
| S1 updated | primary | the current value after an ordinary update |
| S2 corrected | primary | the current value after a wrong statement was corrected |
| S3 repeated stale | primary | the current value when the old one keeps being mentioned |
| S4 conflicting | primary | the authoritative value when sources disagree |
| S5 withdrawn | primary | whether a fact still holds after it was withdrawn |
| S6 as of | time-indexed | what was true on a given date |
| S7 as known | time-indexed | what was known on a given date |
| S8 history | time-indexed | how a fact changed over time |

Every system read the same histories and handed the reader at most 8,000 tokens per question:

| Row | Configuration | Role |
|---|---|---|
| gbrain | the `stable` tag `27f8b9d6` (v0.60.593.0), configuration `rs1-stable`: fact extraction on, `query` with the facts block on | subject |
| memory-bank server | `recipe` | comparator |
| extract-first server | `common` | comparator |
| temporal-graph library | `shipped-0.31` | comparator |
| hybrid search | the harness's own search over the raw chats, no fact layer | design control |
| no memory | the question alone | floor |
| whole history | the whole history in the reader's context, on 10 of the worlds | reference |

Systems are named by kind; [comparisons and their protocols](../comparison-systems.md) names each product and version.
claude-opus-5-5 and gpt-6.1-sol read each context live, and particle-1 read the same frozen contexts afterwards. A judge
from another family graded every answer: gpt-6-astra graded Opus's answers, and claude-opus-5-5 graded Sol's and
particle-1's. Before any counted cell, both judges graded 160 answers built with known labels (80 right, 80 wrong in
five ways) and matched every label (kappa 1.0 each); over those and 160 real answers, 320 in all, they agreed with each
other at kappa 0.95 (95% interval 0.92 to 0.98).

A question's score is the share of the three readers who got it right. The verdict compares gbrain with each comparator
world by world on the 40 primary questions per world, with a one-sided paired test and Holm's correction over the three
comparisons. "Ahead" and "behind" need an adjusted p of at most 0.05, at the same bar either way.

## Results

### Primary: what is true now (S1 to S5, 1,200 questions per comparison)

| gbrain minus | Mean, points | 95% interval | Questions gbrain did better, worse, the same | Verdict |
|---|---:|---|---|---|
| memory-bank server | -0.4 | -2.4 to +1.5 | 140, 109, 951 | no measurable difference |
| extract-first server | -1.8 | -3.9 to +0.3 | 107, 123, 970 | no measurable difference |
| temporal-graph library | +20.9 | +17.7 to +24.1 | 364, 84, 752 | ahead, by more than 5 points |

The restricted wild cluster bootstrap agrees (memory-bank -2.4 to +1.5, extract-first -3.9 to +0.3, temporal-graph +17.7
to +24.1), the worst case over dropped questions is the same as the verdict because nothing dropped, and the descriptive
gemini-3.8-flash judge view gives the same three words. Every row delivered at least 97.8% of its 8,000 tokens on
average, above the 0.90 gate.

### Design control: gbrain against hybrid search

gbrain was 73.7 points ahead of hybrid search over the same raw chats on the primary questions (+70.0 to +77.4; better
on 926 questions, worse on 21). Across all questions, hybrid search handed the reader the right value in 20% of its
contexts (first published as 23%, corrected on 2026-11-16, [see below](#what-went-wrong-along-the-way)) and the stale
value in 40%. The lead over the comparators that gbrain does have can be credited to its design.

### Time-indexed: what was true or known at a date, and how it changed (S6 to S8, 720 questions per comparison)

| gbrain minus | Mean, points | 95% interval | Better, worse, same | Verdict |
|---|---:|---|---|---|
| memory-bank server | -10.3 | -13.0 to -7.7 | 25, 123, 572 | behind |
| extract-first server | -8.1 | -10.8 to -5.3 | 49, 124, 547 | behind |
| temporal-graph library | +5.4 | +2.4 to +8.4 | 135, 82, 503 | ahead |

The preregistration says this family is not powered to detect 5 points. The two losses are larger than that.

### By kind of change (unadjusted, descriptive)

gbrain minus each row, in points, with the 95% interval. **Bold** marks an interval wholly below 0, a named failure.

| Kind | memory-bank | extract-first | temporal-graph | hybrid search |
|---|---|---|---|---|
| S1 updated | **-4.3 (-7.6 to -1.0)** | +1.9 (-3.5 to +7.4) | +6.0 (+1.0 to +10.9) | +72.5 (+65.2 to +79.8) |
| S2 corrected | +1.1 (-2.9 to +5.2) | -1.0 (-3.6 to +1.7) | +15.1 (+9.4 to +20.9) | +72.8 (+66.3 to +79.3) |
| S3 repeated stale | -2.5 (-8.2 to +3.2) | +1.0 (-3.7 to +5.7) | +5.4 (-0.7 to +11.5) | +73.3 (+65.4 to +81.2) |
| S4 conflicting | +9.9 (+5.7 to +14.0) | -1.3 (-4.5 to +2.0) | +51.0 (+43.2 to +58.7) | +80.6 (+75.9 to +85.2) |
| S5 withdrawn | **-6.4 (-12.1 to -0.6)** | **-9.6 (-15.1 to -4.1)** | +26.9 (+19.2 to +34.7) | +69.2 (+62.7 to +75.6) |
| S6 as of | **-6.0 (-9.2 to -2.7)** | **-3.5 (-6.9 to -0.1)** | -1.4 (-5.5 to +2.8) | +64.0 (+58.4 to +69.7) |
| S7 as known | **-9.2 (-12.5 to -5.8)** | **-10.1 (-14.1 to -6.2)** | +19.0 (+13.3 to +24.7) | +62.5 (+55.2 to +69.8) |
| S8 history | **-15.8 (-22.1 to -9.5)** | **-10.6 (-16.7 to -4.4)** | -1.4 (-8.7 to +5.9) | +75.6 (+70.6 to +80.5) |

Where each loss happened, from whether the values the answer needs reached the reader (the share of contexts that held
them; gbrain against the memory-bank and extract-first servers):

- **S8 history, retrieval:** 81% against 98% and 97%.
- **S7 as known, mostly reading:** 96% against 99% and 100%, gaps of 3.3 and 3.8 points against losses of 9.2 and 10.1.
  The reader had the values it needed and still answered wrong more often with gbrain's context.
- **S6 as of, mostly retrieval:** 95% against 100% and 98%, gaps of 4.6 and 3.3 points against losses of 6.0 and 3.5.
- **S5 withdrawn, retrieval (corrected on 2026-11-16):** 85% against 95% and 97%, gaps of 10.4 and 12.1 points against
  losses of 6.4 and 9.6. First published as 60% against 52% and 80%, with the loss to the memory-bank server put down to
  reading; that count took a call-off anywhere in the context as the withdrawal
  ([what went wrong](#what-went-wrong-along-the-way)).
- **S1 updated, against the memory-bank server, retrieval:** 95% against 99%.

The preregistration predicted gbrain ahead on S2 and S3 (it was level), level on S1 (it was behind the memory-bank
server), level or behind on S4 (it was ahead of the memory-bank server by 9.9 points) and ahead on S7 if dates reached
the reader (they did, and it was behind). These failures go to gbrain's maintainers as issues.

### By reader (unadjusted, descriptive)

| Reader | memory-bank | extract-first | temporal-graph | hybrid search |
|---|---|---|---|---|
| claude-opus-5-5 | -2.2 (-4.1 to -0.2) | -3.8 (-6.0 to -1.5) | +20.3 (+17.1 to +23.6) | +73.9 (+70.1 to +77.7) |
| gpt-6.1-sol | -0.8 (-2.9 to +1.4) | -0.3 (-2.6 to +2.1) | +22.7 (+19.1 to +26.2) | +76.2 (+72.6 to +79.8) |
| particle-1 | +1.6 (-1.0 to +4.2) | -1.3 (-3.8 to +1.1) | +19.7 (+16.4 to +23.0) | +70.9 (+66.9 to +74.9) |

Opus's own rows put gbrain behind both servers on the primary questions. Sol's and particle-1's rows are level.

Accuracy on all 64 questions per world (1,920 questions), per reader:

| Row | claude-opus-5-5 | gpt-6.1-sol | particle-1 |
|---|---:|---:|---:|
| gbrain | 90.1% | 91.0% | 84.8% |
| memory-bank server | 95.0% | 95.5% | 88.0% |
| extract-first server | 95.6% | 93.4% | 89.4% |
| temporal-graph library | 74.6% | 74.6% | 71.6% |
| hybrid search | 16.9% | 17.1% | 18.1% |
| no memory | 0% | 0% | 0% |

The whole history in the reader's context, on 10 of the worlds, answered 636 of 640 questions with Opus and 638 of 640
with Sol, as its cell's own receipt scores it. Every memory system at 8,000 tokens leaves room below that.

### Cost per correct answer

For each reader, a row's cost is its ingest, retrieval and background spend per question plus the reader's own spend
per answer, divided by that reader's accuracy. Judge spend is left out. US dollars per correct answer, from the metering
proxies' usage fields:

| Reader | gbrain | memory-bank | extract-first | temporal-graph | hybrid search |
|---|---:|---:|---:|---:|---:|
| claude-opus-5-5 | 0.0550 | 0.0478 | 0.1045 | 0.1226 | 0.2803 |
| particle-1 | 0.0079 | 0.0082 | 0.0660 | 0.0670 | 0.0135 |
| gpt-6.1-sol | 0.0216 | 0.0211 | 0.0772 | 0.0813 | 0.0892 |

| gbrain's cost over | Ratio | 95% interval | Verdict |
|---|---:|---|---|
| memory-bank server | 1.09 | 1.07 to 1.11 | behind |
| extract-first server | 0.34 | 0.34 to 0.35 | ahead |
| temporal-graph library | 0.32 | 0.31 to 0.32 | ahead |

The intervals come from a cluster bootstrap over worlds. Below 1 means gbrain is cheaper.

## Why null?

The primary comparisons with the two servers are nulls, so the preregistration's "Why null?" questions were answered in
custody before this file was written:

- **Did gbrain use its design?** It ran with fact extraction and its facts block on, as preregistered, and the design
  control shows what that adds over plain search.
- **Do the tasks fit?** The worlds were built around the claimed advantage: superseded facts, corrections and stale
  values repeated many times.
- **Enough samples?** The primary intervals are about 2 points wide on each side, well inside the preregistered 5-point
  smallest detectable difference, so the nulls don't come from too few worlds.
- **Headroom?** The reader with the whole history answered over 99% of questions, and gbrain's rows sit at 84.8% to 91.0%,
  below both servers, so there was room to win.

The verdict is to keep gbrain's fact design, which beats plain search by a wide margin and holds level with the
memory-bank and extract-first servers on current values, and to fix the named failures above: dated history for
questions about the past, and withdrawn facts.

## What it can and can't claim

On synthetic histories with an equal mix of five kinds of change, gbrain at the stable tag, reading 8,000 tokens,
answers questions about current values about as accurately as the memory-bank server and the extract-first server, and
more accurately than the temporal-graph library, read by Opus 5.5, GPT-6.1 Sol and particle-1. It answers questions
about past states less accurately than both servers.

It says nothing about brains whose pages carry access flags, about agent mode (where gbrain's `as_of` and
`known_as_of` tools would count), about histories much longer than 200,000 tokens, other token budgets or other gbrain
builds, or about how the comparators rank against each other.

## What went wrong along the way

- **Gemini's daily request limit.** The renderer and the descriptive judge share one Gemini project, and its daily
  request limit ran out during the second wave. 15 of that wave's 18 units ended partial or timed out on their first
  attempt and were resumed from their checkpoints. A resume never repeats a recorded call, so no answer or judgment was asked twice, and
  every unit's final attempt is complete.
- **A shared Particle key.** The particle-1 spend in the cost table comes from this run's own metering. Particle's
  per-key usage page couldn't check it independently, because another of our runs used the same key on 2026-11-14 and
  2026-11-15. On 2026-11-15, Particle's count minus the other run's own count is within 3 requests of ours. On
  2026-11-14, 278 requests on the key belong to neither run.
- **Two misleading stop messages**, fixed on this branch: a 402 from Google read as Particle running out of credit, and
  as the metering proxy refusing a render. Both stopped the run as they should, but they sent the operator to the wrong
  provider.
- **The exposure count for withdrawn facts (S5)**, corrected on 2026-11-16. It took a call-off form anywhere in the
  context as the withdrawal the answer needs, so it counted other entities' call-offs and words such as "nothing" in
  unrelated chat, and it missed call-offs worded with words its list lacked. The corrected count needs one sentence that
  names the question's entity, the withdrawn value and a call-off word, and its word list adds the call-off words of the
  sealed set's own phrasing and of their rewordings in the rendered chats (the list stays in custody with the worlds).
  A read of 86 masked S5 contexts that the two counts disagree on, or that the corrected count still misses, agreed
  with the corrected count every time. Only the S5 figures change. Across all questions each row's share changes with
  them, and the only one this report quotes is hybrid search's (23% to 20%). No accuracy figure, interval or verdict
  changes. verdict.json keeps the published figures, and
  [exposure-correction.json](2026-11-15-changing-facts-battleground-results/exposure-correction.json) records the
  corrected ones:

  | S5 contexts that held the withdrawal | gbrain | memory-bank | extract-first | temporal-graph | hybrid search |
  |---|---|---|---|---|---|
  | Published | 60% | 52% | 80% | 61% | 41% |
  | Corrected | 85% | 95% | 97% | 65% | 12% |

## Receipts

- [verdict.json](2026-11-15-changing-facts-battleground-results/verdict.json): the verdict, every family, the per-kind
  and per-reader rows, exposure, fill rates, the judge check and the matcher's agreement, written by
  `bun eval/runner/bg1/verdict.ts verdict` over wave A's 14 unit receipts, wave B's 18 and the 30 particle-1 re-reads.
- Wave A ran from commit `d4b36d93` and wave B from `7cf81cba`, both on this branch, on 2026-11-11 to 2026-11-15.
  The sealed worlds, questions and gold stay in custody.
- [exposure-correction.json](2026-11-15-changing-facts-battleground-results/exposure-correction.json): the corrected
  exposure of 2026-11-16, per row and kind, beside the published and the entity-scoped counts. The rescore read the
  same counted contexts in custody, and its recount with the published matcher reproduces verdict.json's exposure.

## Changelog

### 2026-11-16: Exposure for withdrawn facts corrected

The S5 line under "By kind of change" and hybrid search's share of contexts that held the right value give corrected
exposure figures beside the published ones, "What went wrong along the way" says why, and the receipts add
`exposure-correction.json`. No accuracy figure, interval or verdict changes.

## Disclosures

- gbrain is Garry Tan's own project.
- Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.
- Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.
