# Changing-facts confirmation results: on new sealed worlds, gbrain's newest release is behind two memory servers on questions about the past and ahead of one on what is true now

- **We learned that gbrain's newest release holds up on current values on worlds nobody had seen, and costs a third as
  much per correct answer as the extract-first server.** On 40 newly minted, sealed chat histories of about 200,000
  tokens, in which facts are updated, corrected, repeated after they went stale, contradicted or withdrawn, gbrain
  v0.60.753.0 was ahead of the memory-bank server on "what is true now" by 1.2 points (95% interval +0.2 to +2.2) and
  level with the extract-first server within 3 points (+0.6, -0.8 to +2.0). A correct answer cost about a third of the
  extract-first server's and about 6% more than the memory-bank server's. The lead over the memory-bank server comes
  mostly from particle-1's reading: claude-opus-5-5's and gpt-6.2-sol's own rows are level. You should compare cost per
  correct answer, not only accuracy, when you choose a memory layer.
- **We learned that gbrain still loses questions about the past, and the biggest loss is the history of a fact. You
  should hand the reader every dated version of a fact when a question asks how it changed.** On what was true or known
  at a date and how a fact changed, gbrain was behind the memory-bank server by 4.5 points (-6.5 to -2.6) and the
  extract-first server by 3.0 (-5.2 to -0.8). On "how did it change" questions alone it was behind by 11.2 and 5.9
  points, and the values the answer needs reached the reader in 85% of gbrain's contexts against 97% and 98% for the two
  servers, so most of that loss is in what gbrain retrieves. None of the 76,601 facts in gbrain's 40 kept brains carried
  an end date.
- **We learned that the lead gbrain showed on development worlds did not carry over to worlds nobody had seen. You
  should confirm a memory change on held-out data before you claim it.** On 20 public development worlds, the same build
  read by claude-opus-5-5 was ahead of both servers on current values (+3.4 and +1.9 points) and level on the past (+0.6
  over each). On the sealed worlds the current-value leads shrank to +1.2 and +0.6, and the past turned into losses.

This is the results file of the [changing-facts confirmation preregistration (BG1-C)](2026-11-19-changing-facts-confirmation-preregistration.md).
Its outcome table picks row 2, **any comparison behind**, so the losses come first: gbrain is **behind** the
memory-bank server and the extract-first server on questions about the past, **ahead** of the memory-bank server on what
is true now, and **level within 3 points** with the extract-first server on what is true now. Nothing dropped: all 2,560
planned questions are in every comparison, from all three readers. Every number here is on synthetic histories, at one
gbrain build and an 8,000-token reading budget. The design compares one gbrain release with two servers, so it does not
test which gbrain change caused any difference.

## The test

BG1-C repeats the [changing-facts battleground (BG1)](2026-11-15-changing-facts-battleground-results.md) on worlds
nobody had seen, to check whether gbrain's newest release kept the lead it showed on development worlds. Each history is
one person's chats over many sessions. A generator plans which facts change and how, a renderer writes the chats, and
an oracle over the plan holds the gold answer for every question. The 40 worlds (`bg1-031` to `bg1-070`) come from
BG1's sealed seed at slots that had never been minted, were minted and held in custody, and were never seen by anyone
developing a system. Every slot minted passed validation, so none was dropped. Each world has 64 questions in eight kinds:

| Kind | Class | What it asks |
|---|---|---|
| S1 updated | what is true now | the current value after an ordinary update |
| S2 corrected | what is true now | the current value after a wrong statement was corrected |
| S3 repeated stale | what is true now | the current value when the old one keeps being mentioned |
| S4 conflicting | what is true now | the authoritative value when sources disagree |
| S5 withdrawn | what is true now | whether a fact still holds after it was withdrawn |
| S6 as of | questions about the past | what was true on a given date |
| S7 as known | questions about the past | what was known on a given date |
| S8 history | questions about the past | how a fact changed over time |

Every system read the same histories and handed the reader at most 8,000 tokens per question:

| Row | Configuration | Role |
|---|---|---|
| gbrain | v0.60.753.0 (commit `fbf608cf`), the newest release on gbrain's master when the build was fixed for launch, configuration `rs1-stable` as BG1 ran it: default fact extraction with name tags on, `query` with the facts block on | subject |
| memory-bank server | `recipe`, bundle lock `f54d89df` | comparator |
| extract-first server | `common`, bundle lock `9777b7a8` | comparator |

Systems are named by kind; [comparisons and their protocols](../comparison-systems.md) names each product and version.
Both servers ran with their own internal models, as BG1 ran them. The memory-bank server is the comparator run with its
vendor-default extraction model (gpt-4o-mini). Garry Tan suspended gpt-4o models for new evaluations on 2026-11-21, after
this experiment's first half had launched, and the experiment's owner ruled the same day (ruling A1) that this
preregistered comparator runs unchanged, because the extraction model is the server's shipped default and not a model we
chose. The extract-first server's default extraction model is gpt-4.1-mini.

claude-opus-5-5 and gpt-6.2-sol read each context live, and particle-1 read the same frozen contexts afterwards, byte
for byte. A judge from another family graded every answer: gpt-6-astra graded Opus's answers, and claude-opus-5-5 graded
Sol's and particle-1's. Two checks back the judges, and no person labelled any item in either:

- **BG1's judge check (model-labelled)** covers both judges on this instrument. Each matched all 160 labels on answers
  built to be right or wrong in known ways (kappa 1.0), and the two agreed with each other at kappa 0.95 over 320 answers.
- **BG1-C's judge check (model-labelled)** covers the new reader, gpt-6.2-sol. claude-opus-5-5 graded its 1,920 answers
  on 10 public development worlds, and gemini-3.8-flash then graded a pool of 148 of them (the 74 Opus graded wrong and
  74 it graded right). The two agreed on all 148 (kappa 1.0).

A question's score is the share of the three readers who got it right. Each of the four comparisons (each server, on
each class) compares gbrain with the server world by world, as the mean over the class's questions, with a paired test
over the 40 worlds. "Ahead" and "behind" use Holm's step-down over the four comparisons, at one-sided 0.05 in each
direction, with group-sequential bounds because the plan took one look at half the worlds. "Level within 3 points" means
both simultaneous one-sided bounds (alpha 0.0125) sit inside 3 points of zero.

## Results

### What is true now (S1 to S5, 1,600 questions per comparison)

| gbrain minus | Mean, points | 95% interval | Questions gbrain did better, worse, the same | Verdict |
|---|---:|---|---|---|
| memory-bank server | +1.2 | +0.2 to +2.2 | 148, 96, 1,356 | ahead |
| extract-first server | +0.6 | -0.8 to +2.0 | 148, 121, 1,331 | level within 3 points |

### Questions about the past (S6 to S8, 960 questions per comparison)

| gbrain minus | Mean, points | 95% interval | Questions gbrain did better, worse, the same | Verdict |
|---|---:|---|---|---|
| memory-bank server | -4.5 | -6.5 to -2.6 | 63, 100, 797 | **behind** |
| extract-first server | -3.0 | -5.2 to -0.8 | 85, 98, 777 | **behind** |

The z statistics were +2.29 and +0.88 on current values and -4.18 and -2.60 on the past, against final bounds of 2.25,
2.14, 1.98 and 1.68 at Holm's four steps. The restricted wild cluster bootstrap gives the same intervals to within 0.1
point. The worst case over dropped questions is the verdict itself, because nothing dropped. Every row delivered at least
98.3% of its 8,000 tokens on average (gbrain 98.4%, memory-bank 98.3%, extract-first 99.5%), above the 0.90 gate.

### The one look at half the worlds

The plan took one look after the first 20 worlds, with stop bounds fixed in advance. The run stops there only when every
comparison has crossed a bound or is futile (below 10% conditional power for "ahead" at the development effect). Both
comparisons on the past were futile at the look (z -2.75 and -1.56, conditional power 0 and 0.001), and both on current
values were still open (z +1.04 and +0.87, conditional power 0.98 and 0.34), so the run continued to all 40 worlds as
planned. Futility made "ahead" on the past very unlikely but stopped nothing on its own; the words above come from all
40 worlds.

### By kind of change (unadjusted, descriptive)

gbrain minus each server, in points, with the 95% interval. **Bold** marks an interval wholly below 0.

| Kind | memory-bank | extract-first |
|---|---|---|
| S1 updated | +0.4 (-1.0 to +1.9) | +8.8 (+4.9 to +12.6) |
| S2 corrected | +0.4 (-2.1 to +3.0) | **-2.1 (-4.1 to -0.1)** |
| S3 repeated stale | -0.2 (-2.6 to +2.2) | +5.5 (+2.1 to +9.0) |
| S4 conflicting | +8.9 (+5.3 to +12.4) | **-4.0 (-5.9 to -2.0)** |
| S5 withdrawn | -3.4 (-7.4 to +0.6) | **-5.2 (-8.9 to -1.5)** |
| S6 as of | **-2.8 (-5.0 to -0.6)** | -1.4 (-3.8 to +1.1) |
| S7 as known | +0.4 (-2.7 to +3.6) | -1.7 (-5.0 to +1.6) |
| S8 history | **-11.2 (-15.8 to -6.7)** | **-5.9 (-10.4 to -1.5)** |

Where each loss happened, from whether the values the answer needs reached the reader (the share of contexts that held
them, for gbrain against the memory-bank and extract-first servers):

- **S8 history, retrieval:** 85% against 97% and 98%. This is most of the loss on the past.
- **S6 as of, mostly retrieval:** 97% against 100% and 100%, a gap of 3 points against losses of 2.8 and 1.4.
- **S7 as known, level:** 93% against 99% and 100%, yet the reader answered about as well from gbrain's contexts.
- **S5 withdrawn, reading:** with BG1's entity-scoped count, the withdrawal reached the reader in 64% of gbrain's
  contexts against 40% and 65%. gbrain's contexts held it as often as the extract-first server's and lost by 5.2 points.
- **S4 conflicting and S2 corrected, against the extract-first server, reading:** 97% against 98%, and 98% against 100%,
  for losses of 4.0 and 2.1 points.

The preregistration predicted gbrain ahead of the memory-bank server on current values (it was), not behind by 3 points
or more in the other three comparisons (it was level with the extract-first server on current values, and behind both
servers on the past by more than that), and an S8 interval that includes 0 against each server (both sit below 0).

### By reader (unadjusted, descriptive)

| Reader | What is true now: memory-bank | What is true now: extract-first | The past: memory-bank | The past: extract-first |
|---|---|---|---|---|
| claude-opus-5-5 | +0.6 (-0.6 to +1.8) | -1.9 (-3.1 to -0.6) | -6.0 (-7.9 to -4.2) | -5.1 (-7.2 to -3.0) |
| gpt-6.2-sol | -0.5 (-1.6 to +0.6) | +2.5 (+0.8 to +4.2) | -5.3 (-7.6 to -3.1) | -2.6 (-5.2 to 0.0) |
| particle-1 | +3.6 (+1.9 to +5.2) | +1.2 (-0.6 to +3.0) | -2.3 (-4.4 to -0.2) | -1.2 (-3.7 to +1.2) |

The lead over the memory-bank server on current values rests on particle-1's reading. Opus's own rows put gbrain level
with the memory-bank server and behind the extract-first server on current values, and every reader puts it behind or
level on the past.

Accuracy on all 64 questions per world (2,560 questions), per reader:

| Row | claude-opus-5-5 | gpt-6.2-sol | particle-1 |
|---|---:|---:|---:|
| gbrain | 92.9% | 93.4% | 90.2% |
| memory-bank server | 94.8% | 95.7% | 88.8% |
| extract-first server | 96.0% | 92.8% | 89.9% |

All 64 questions pooled, gbrain minus each server: -1.0 points (-2.0 to +0.1) against the memory-bank server and -0.7
(-2.1 to +0.6) against the extract-first server.

### Cost per correct answer

For each reader, a row's cost is its ingest, retrieval and background spend per question plus the reader's own spend
per answer, divided by that reader's accuracy. Judge spend is left out. US dollars per correct answer, from the metering
proxies' usage fields:

| Reader | gbrain | memory-bank | extract-first |
|---|---:|---:|---:|
| claude-opus-5-5 | 0.0538 | 0.0480 | 0.1040 |
| particle-1 | 0.0076 | 0.0081 | 0.0653 |
| gpt-6.2-sol | 0.0207 | 0.0206 | 0.0769 |

| gbrain's cost over | Ratio | 95% interval | Verdict |
|---|---:|---|---|
| memory-bank server | 1.06 | 1.05 to 1.08 | behind |
| extract-first server | 0.33 | 0.33 to 0.34 | ahead |

The intervals come from a cluster bootstrap over worlds. Below 1 means gbrain is cheaper.

## Why null?

One comparison is a tie (current values against the extract-first server), and the two on the past, futile at the look,
ended as losses. The preregistration's "Why null?" questions were answered in custody before this file was written:

- **Did gbrain use its design?** Yes for name tags and slots, and no for end dates. Across gbrain's 40 kept brains,
  12,690 of 76,601 facts were tagged with the person or company they are about, 1,376 tagged facts had a slot, and 316 of
  their 891 slots held more than one value. Beyond the three counts the plan asked for, a count of end markers
  found that every fact had a start date and none had an end date, an expiry, a successor or a merge. So a changed fact's
  old and new values sat side by side as open facts, and a question about the past depended on retrieval finding every
  version. The smoke brain on a public world showed the same (0 of its 42 slotted facts closed). We have not established
  why; it goes to gbrain's maintainers with the losses below.
- **Do the tasks fit?** The worlds were built around the claimed advantage, and each carries 24 questions about the past
  on facts with scheduled changes.
- **Enough samples?** Against the extract-first server on current values, the interval (-0.8 to +2.0) sits inside the
  3-point margin, and the plan's smallest detectable difference at 40 worlds was 2.4 to 2.8 points, so a lead that size
  would probably have shown. The losses on the past are detected outright.
- **Headroom?** On 10 of BG1's worlds from the same generator, the whole history in the reader's context answered 99.4%
  of questions with Opus and 99.7% with GPT-6.1 Sol. gbrain's rows here sit at 90.2% to 93.4%, so there was room to win.

The verdict is to keep gbrain's fact design, which leads the memory-bank server on current values and holds level with
the extract-first server at a third of its cost per correct answer. It is not a cut candidate. The losses on the past,
mostly "how did it change" questions where gbrain's contexts miss a version, go to gbrain's maintainers as named failures,
with the exposure figures above placing each one in retrieval or in reading.

## What it can and can't claim

On synthetic histories with an equal mix of five kinds of change, gbrain v0.60.753.0, reading 8,000 tokens, answers
questions about current values more accurately than the memory-bank server and about as accurately as the extract-first
server, read by Opus 5.5, GPT-6.2 Sol and particle-1. It answers questions about past states less accurately than both.

It says nothing about which gbrain change caused any difference, about brains whose pages carry access flags, about
agent mode (where gbrain's `as_of` and `known_as_of` tools would count), about histories much longer than 200,000
tokens, other token budgets or other gbrain builds, about the temporal-graph library, or about how the two servers rank
against each other. BG1's rows for gbrain v0.60.593.0 stay published with that build named. They come from different
worlds and a different reader set, so the two experiments' numbers are not a paired comparison.

## What went wrong along the way

- **A model suspension in the middle of the run.** gpt-4o models were suspended for new evaluations on 2026-11-21, after
  the first half had launched. The memory-bank server's own extraction model is gpt-4o-mini, so its second half ran
  under a scoped ruling that keeps the preregistered comparator unchanged, as described under "The test".
- **Two later gbrain releases.** v0.60.754.0 and v0.60.755.0 were tagged on 2026-11-21 after the build was fixed for
  launch. The plan freezes the build once counted gbrain cells start, so every gbrain cell ran v0.60.753.0.
- **A macOS lock in the VM launcher.** The first smoke launch from the custody Mac refused before any VM existed, because
  the launcher's create lock needed a Linux-only `flock`. It was fixed on this branch before any counted cell and spent
  nothing.
- **The brain counts had no committed query.** The plan names "the dev loop's free query", which was never committed.
  The counts here come from a query rebuilt in custody (tagged: facts with a name tag; slotted: tagged facts with a slot
  and a value; changing: slots with more than one distinct value), which reproduced the pilot's published counts (299,
  42 and 8) exactly on the smoke brain before it ran on the counted brains.

## Receipts

- [confirm.json](2026-11-19-changing-facts-confirmation-results/confirm.json): the outcome row, the four comparisons
  with their tests, bounds and wild bootstrap, the per-kind, per-reader and pooled rows, exposure, fill rates, drops,
  cost per correct answer, the brain counts and the judge check, written by `bun eval/runner/bg1/verdict.ts confirm` over
  the 24 counted unit receipts and the 24 particle-1 re-reads.
- [look.json](2026-11-19-changing-facts-confirmation-results/look.json): the one look at 20 worlds, with each
  comparison's z, conditional power and status.
- Every counted cell and re-read ran from commit `3578ae0cf` on this branch, on 2026-11-21 to 2026-11-23. The sealed
  worlds, questions and gold stay in custody.

## Changelog

### 2026-11-23: Results published

First version.

## Disclosures

- gbrain is Garry Tan's own project.
- Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.
- Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.
