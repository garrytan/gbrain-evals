# A perfect "no evidence found" line barely changes made-up answers on BEAM-500K (oracle stub, gbrain v0.60.743.0)

- **We learned that a false "no evidence found" line costs readers few correct answers.** When the line was shown on every answerable question, the three readers lost 1.2 points of correct answers (pooled, 95% interval −0.8 to 3.2 points). At a 5% misfire rate that is a cost of 0.06 points. So a memory tool that sometimes says it found nothing when it did find something does little harm. You should not fear an occasional false "nothing found" from your agent's memory. You also shouldn't expect it to help much, as the next point shows.
- **We learned that even a perfect "no evidence found" line cut made-up answers by only 2.0 points.** On BEAM-500K's 22 unanswerable public dev questions, gbrain's readers made up an answer 22.7% of the time. With the line added exactly on those questions they did so 20.7% of the time: a cut of 2.0 points (95% interval −0.5 to 5.1), against a preregistered bar of 13 points. Frontier readers answer from what memory returns, whether or not memory says it found nothing. To stop made-up answers, you should look somewhere other than a memory-side signal, such as the reader's prompt or not returning loose matches.
- **Both verdicts say don't build the signal.** The preregistered verdict is **not material**. The approved build condition, as gbrain's maintainers read it, gives **no build**: the relative cut is 8.9% (interval −2.3% to 22.6%), under that condition's 25% floor. gbrain's maintainers don't build an "evidence not found" signal from this evidence.

This was a counted run, preregistered on 2026-11-19 with five dated amendments ([preregistration](2026-11-19-beam500k-no-evidence-line-preregistration.md)). It ran on gbrain's newest release at launch, v0.60.743.0 (commit `16124807cb78`), from 2026-11-19 to 2026-11-20. The readers were claude-opus-5-5, gpt-6.2-sol and particle-1, on BEAM-500K's 11 public dev conversations. The result is a null at this sample size, not a proof that the line does nothing. The design could detect a cut of about 13 points, not smaller ones.

## The concrete case

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents. It stores a person's chat history and returns what looks relevant when an agent asks. [BEAM](https://github.com/mohammadtavakoli78/BEAM) is a public benchmark of long chat histories, published under CC BY-SA 4.0. Its `abstention` questions ask about things the user never said, such as "What was discussed during the weekly Zoom mentorship sessions with Kendra?" when the user never described those sessions. The right answer says the history doesn't contain it.

gbrain still returns its closest matches for such a question, for example messages that mention Kendra. A reader that sees them can stitch them into an answer. The question was whether gbrain should also tell the reader, in what it returns, that it found nothing that answers the question. Before building a signal that would sometimes be wrong, this test measured the most it could achieve. An oracle stub (a line placed by the test, which knows the true answer) added exactly one line, `gbrain found no evidence for this question`, to gbrain's retrieved context. It added the line on exactly the unanswerable questions, and on no others.

## The experiment

| Arm | What the reader gets | Questions | Samples per reader |
|---|---|---|---|
| `B`, before | gbrain's retrieved context, as delivered | all 220 | 3 on the 22 unanswerable, 1 on the 198 answerable |
| `O`, oracle line | `B`'s recorded context, byte for byte, plus the line | 22 unanswerable | 3 |
| `F`, false alarm | `B`'s recorded context, byte for byte, plus the line | 198 answerable | 1 |

- **Same evidence in every arm.** `O` and `F` replay `B`'s recorded retrievals. Every replayed prompt was rebuilt and checked against `B`'s recorded prompt plus the line before it was sent. So the only difference between the arms is the line, plus sampling noise.
- **Readers.** claude-opus-5-5 and gpt-6.2-sol ran at their provider default effort. particle-1 was sent `reasoning_effort: high` with a 16,000-token output limit, and the proxy's recorded request shows both.
- **Correctness.** BEAM's rubric judge (`gemini-3.5-flash`, fixed by the pinned harness) decided each answer. On an unanswerable question, an answer the judge doesn't mark correct counts as made up.
- **Answer type.** A judge from another model family labelled every answer `declined`, `hedged` (gives an answer and says it's unsure) or `committed` (gives an answer without doubt). `gpt-6-astra` labelled the Claude and particle-1 answers, and `claude-opus-5-5` labelled the GPT answers. The judges saw only the question and the answer.
- **Endpoints.** Δ_O is `B`'s made-up rate minus `O`'s on the 22 unanswerable questions. L is `B`'s correct rate minus `F`'s on the 198 answerable questions. Both are pooled over the three readers with equal weight and paired by question and reader. Intervals come from a 10,000-resample question bootstrap.

## Results

### Before the line: how often readers make things up (arm `B`)

| Reader | Correct, all 220 | Made up, 22 unanswerable (3 samples) | Wrong, 198 answerable | Wrong answers stated without doubt | Answerable questions declined | Cost per correct answer |
|---|---|---|---|---|---|---|
| claude-opus-5-5 | 74.5% (164) | 16.7% | 27.3% | 44.4% of 54 | 18.7% | $0.102 |
| particle-1 | 71.4% (157) | 21.2% | 28.8% | 93.0% of 57 | 10.1% | $0.005 |
| gpt-6.2-sol | 75.9% (167) | 30.3% | 23.2% | 82.6% of 46 | 13.6% | $0.034 |
| Pooled | 73.9% | 22.7% | 26.4% | | | |

Cost per correct answer counts the answer calls on `B`'s 220 rows only. On correct answers, particle-1 was 3.2 points behind claude-opus-5-5 (paired question bootstrap, 95% interval −2.3 to 8.6 points; descriptive, not a preregistered comparison), at about a twentieth of the cost per correct answer. The readers received a mean of 7,711 (Opus), 8,395 (Sol) and 8,393 (particle-1) tokens of context, against gbrain's 8,000-token delivery target.

claude-opus-5-5 refused some questions with a provider refusal (`stop_reason: refusal`): 18 answerable and 1 unanswerable in `B`, 1 unanswerable in `O` and 30 answerable in `F`. The line raised them by about two thirds on answerable questions, from 18 to 30. The preregistration counts refusals as answered, so the judge graded them. Δ_O without them is below. Neither other reader refused.

### Primary 1: the line on unanswerable questions (Δ_O)

| | `B` made up | `O` made up | Δ_O, points (95% interval) | Relative cut (95% interval) |
|---|---|---|---|---|
| **Pooled, three readers** | **22.7%** | **20.7%** | **2.0 (−0.5 to 5.1)** | **8.9% (−2.3% to 22.6%)** |
| claude-opus-5-5 (secondary) | 16.7% | 13.6% | 3.0 (−3.0 to 9.1) | 18.2% |
| gpt-6.2-sol (secondary) | 30.3% | 22.7% | 7.6 (0.0 to 18.2) | 25.0% |
| particle-1 (secondary) | 21.2% | 25.8% | −4.5 (−9.1 to 0.0) | −21.4% |

- **Preregistered verdict: not material.** A material cut needed Δ_O of at least M = 13 points (the larger of 13 and half of `B`'s 22.7%). Δ_O − (half of `B`'s rate) has an upper bound of −3.5 points, so the cut is reliably smaller than half the before rate.
- **The approved build condition: no build.** A build needed a relative cut of at least 8/18 with Δ_O's interval excluding 0, and no build is a relative cut below 25%. The relative cut is 8.9%. This condition is gbrain's maintainers' reading of the owner's approval of their release plan, not the owner's words.
- **No reader's interval reaches M.** The preregistered "readers disagree" case does not apply. Per-reader rows are descriptive: one reader's detectable difference is 19.3 points. particle-1 made up more answers with the line, not fewer. Its answer-type shares on unanswerable questions were the same in both arms (74% declined, 26% committed).

### Primary 2: the line on answerable questions (L)

| | L, points of correct answers lost (95% interval) | Became declines | Became wrong | Turned correct |
|---|---|---|---|---|
| **Pooled, three readers** | **1.2 (−0.8 to 3.2)** | | | |
| claude-opus-5-5 (secondary) | 3.5 (−1.5 to 8.6) | 15 | 2 | 10 |
| gpt-6.2-sol (secondary) | 1.5 (−1.0 to 4.0) | 2 | 3 | 2 |
| particle-1 (secondary) | −1.5 (−5.1 to 1.5) | 0 | 4 | 7 |

A real signal would misfire on only some answerable questions, so its cost is the misfire rate times L. At a 5% misfire rate the cost is 0.06 points (−0.04 to 0.16). The highest misfire rate that keeps the cost at 1 point is 85% (31% to 100%). Both clear their bars across the whole interval: the cost at 5% stays under 1 point, and the highest misfire rate stays above 5%. The ship conditions themselves are measured on a real signal, not here.

Secondary, by ability (pooled L, points): instruction following 9.1 (3.0 to 15.2), temporal reasoning 4.5 (0.0 to 9.1), summarization 1.5 (−6.1 to 10.6), event ordering 1.5 (−3.0 to 7.6), preference following 1.5 (−4.5 to 7.6), contradiction resolution 0.0 (−4.5 to 4.5), knowledge update −1.5 (−6.1 to 3.0), information extraction −3.0 (−9.1 to 0.0), multi-session reasoning −3.0 (−9.1 to 3.0). Each ability has 22 questions per reader, and no correction for multiple comparisons is applied.

### Secondary measures

| Measure (pooled, three readers) | `B` | `O` | Δ, points (95% interval) |
|---|---|---|---|
| Committed made-up answers only | 20.2% | 19.2% | 1.0 (−2.0 to 5.1) |
| Made up by the answer-type judge (hedged or committed) | 33.3% | 27.8% | 5.6 (1.0 to 11.1) |
| Δ_O without reader-refusal rows | 22.2% | 20.5% | 1.8 (−0.5 to 5.1) |

By the answer-type judge, the line moved some answers to declines, and that interval excludes 0. Almost all of that came from gpt-6.2-sol (10.6 points, 3.0 to 21.2) and claude-opus-5-5 (6.1 points, −3.0 to 16.7), and none from particle-1 (0.0). The two rates differ because the judges measure different things. The answer-type judge counts any hedged or committed answer as made up, and the rubric judge grades the answer against BEAM's rubric.

Answer types on the unanswerable questions, `B` → `O`: claude-opus-5-5 declined 63.6% → 69.7% (committed 24.2% → 19.7%); gpt-6.2-sol declined 62.1% → 72.7% (committed 31.8% → 21.2%); particle-1 declined 74.2% → 74.2% (committed 25.8% → 25.8%). On the answerable questions, `B` → `F`, claude-opus-5-5 declined 18.7% → 23.2%, gpt-6.2-sol 13.6% → 14.1% and particle-1 10.1% → 10.6%.

**Bridge to October, descriptive only.** In October's memory proof wave 2 confirmation cells (an older gbrain build, the `gemini-3.8-flash` reader), gbrain's combined lane stated an answer on 5 of the 14 unanswerable questions it shares with this set (36%). On those 14, this run's `B` made up 23.8% (Opus), 35.7% (Sol) and 31.0% (particle-1). The bridge is unpaired in build and reader. October's 32% came from 56 questions, most of them in the sealed split, which this test doesn't use.

### Sensitivity: without the 21 repaired Opus rows

Arm `B` for claude-opus-5-5 had 21 rows (3 unanswerable) that failed on a client bug in reading replies and were asked again (amendment 4). Without those rows, Δ_O is 2.2 points (−0.5 to 6.1), the relative cut is 10.5% (−4.3% to 28.8%) and L is 1.5 points (−0.5 to 3.4). Both verdicts are unchanged: not material, and no build. With only the Opus and Sol rows, before particle-1 ran, this check had moved the build verdict to borderline and the preregistered verdict to not distinguishable. With all three preregistered readers it doesn't.

## Why null?

- **Did the readers see the line?** Yes. Every `O` and `F` prompt was rebuilt from `B`'s recorded retrieval, checked against `B`'s recorded prompt plus the line, and refused if they differed, before it was sent.
- **Did the line move committed answers to hedged ones?** No. Committed made-up answers fell by 1.0 point (−2.0 to 5.1), and the rubric judge's made-up rate by 2.0. The answer-type judge saw more declines with the line (5.6 points, 1.0 to 11.1), almost all from the two frontier readers. None of that reaches the 13-point bar.
- **Were there enough samples, and was there headroom?** `B`'s pooled made-up rate was 22.7%, above the 13% no-headroom floor, so removing every made-up answer would have been detectable. A cut smaller than about 13 points could not be told from noise at this size.
- **Do the readers already do it unaided?** Partly. At gbrain's newest release, the readers already declined on 62% to 74% of unanswerable samples without the line. The made-up answers that remain mostly survive the line, too.

The verdict for an "evidence not found" signal built on this line is not to build it. That is the preregistered "not material" outcome and the build condition's "no build". The next lever is the reader side: the prompt, or retrieval that stops returning loose matches.

## What it can and can't claim

- There are 22 unanswerable questions in 11 conversations, and the interval doesn't cover variation between conversations. A cut of about 13 points was detectable here, and anything smaller is "no measurable difference at this size".
- The line names gbrain and is phrased one way. Another wording, or a signal shown as a tool field rather than a sentence, could move readers differently.
- The answer-type judge for the Claude and particle-1 rows is `gpt-6-astra`, one generation behind the newest Astra.
- The particle-1 cells differ from the frontier cells in two ways that don't touch the endpoints. particle-1's `F` cell also holds byte-identical copies of its 22 `B` answers to the unanswerable questions, because the replay keeps the source cell's answer for questions outside its list. The analysis reads `F` only on the 198 answerable questions, so the copies are not used. Its first `B` cell stopped at row 69 on a list-valued answer and is not counted (amendment 5). Its first `F` pass was stopped at 129 of 198 rows by a local session watchdog. That pass was set aside, not counted, and `F` was answered again in full. One `B` row failed on a provider 503 and was asked again with the same prompt, checked byte for byte, as the preregistration says for harness failures.

## Judge checks

- **Before any counted judgment** (R78), the rubric judge and both answer-type judges each graded 48 items written by hand from BEAM's public gold, with labels by construction. Every judge scored Cohen's kappa 1.0, with no unparseable outputs and at least the preregistered number of items in each class. The two answer-type judges agreed on all 48. Under BEAM's licence the item texts stay in the private run record. Their SHA-256 hashes, labels and the check's gates are in [judge-check.json](beam500k-no-evidence-line/judge-check.json).
- **Hand audit of 40 real `B` answers** (20 unanswerable), sampled as described below and labelled by hand from BEAM's gold and rubric before their judgments were read. The rubric judge agreed on all 40 (kappa 1.0). The answer-type judges agreed on 35 of 40: kappa 0.76 on the three classes, and 0.89 on declined against not declined. This is descriptive only. The five disagreements are hedged against committed (3) and declined against committed (2), listed in [audit.json](beam500k-no-evidence-line/audit.json).
- **The audit sample.** The preregistration fixed `random.Random(1)` and stratification by reader, but not the exact draw. The draw used here, written after `B` was answered and before any judgment was read, takes one `random.Random(1)` stream. For claude-opus-5-5, gpt-6.2-sol and particle-1 in that order, it samples 7, 7 and 6 unanswerable questions, then 6, 7 and 7 answerable ones, from each reader's sorted question ids.
- All 1,584 counted rows (528 per reader: `B`'s 220, two more `B` samples and three `O` samples on the 22 unanswerable, and `F`'s 198) have an answer-type label, and none is unparseable. particle-1's label file also has 22 labels for the unused copies in its `F` cell.

## Recorded before the cells

The preregistration asked for these to be appended to it before the first counted cell. They were recorded in the run record at that point, not in the preregistration file, so they are listed here:
- gbrain v0.60.743.0, commit `16124807cb78` (amendment 1), recorded in every cell's identity.
- Harness commit `f618ed7b` (`harness.lock.json`), with the results branch's reanswer option, the particle-1 client and the two reply-reading fixes (amendments 3 to 5).
- The answer-type prompt `beam-answer-type-v1`, SHA-256 `c6ee151a71a9452d4cf39d4ab3ad112a3a2c58b2c6c8fa89f076944e852ab265`.
- The judge check passed (above), and the model freshness check exited 0 with no blocking issue.
- The provider settings were the confirmation cell's, and the mean delivered context is in the first table.
- The cells ran on Ubicloud VMs against one budget ledger. Its run ids were `beam500k-no-evidence-line-2026-11-19T08-43-12-523Z-087a495e` and, for the particle-1 replays, `beam500k-no-evidence-particle-replays-2026-11-20T13-18-26-878Z-9ad191b2`.

## Reproduce and inspect

- The endpoint script is [analyze.py](beam500k-no-evidence-line/analyze.py). It was committed before any particle-1 row existed, and `python3 analyze.py --self-test` checks it. Its output for this run is [analysis.json](beam500k-no-evidence-line/analysis.json), from:

  ```
  python3 docs/benchmarks/beam500k-no-evidence-line/analyze.py --cells cells --run . \
    --reader opus=beam-500k-gbrain-rag-750333b2ceb4 --reader sol=beam-500k-gbrain-rag-7d37e80f41e9 \
    --reader particle=beam-500k-gbrain-rag-354daaed3f56 \
    --repair opus=cells/beam-500k-gbrain-rag-750333b2ceb4/answer-repair.json --json analysis.json
  ```

- The detectable differences come from [sdd.py](beam500k-no-evidence-line/sdd.py), unchanged from the preregistration.
- The dataset is BEAM at revision `b2da22eac88b`, the 11 dev conversations `500k-10`, `500k-12`, `500k-18`, `500k-20`, `500k-21`, `500k-24`, `500k-25`, `500k-28`, `500k-29`, `500k-31` and `500k-33`. Fetch it with `bun run eval:decide fetch --benchmark beam-500k --conversations <ids>`.
- The cells are run with `bun run harness:cell` (`run`, then `reanswer --append-line --line-ids` for `O` and `F`, then `rejudge`), and labelled with `bun eval/runner/beam-no-evidence.ts label`. The keys are ANTHROPIC, OPENAI, GEMINI, VOYAGE and PARTICLE. The cells hold BEAM text and stay in the private run record. This page and analysis.json hold numbers, question ids and labels only.

## Changelog

### 2026-11-20: results

First publication: both primary endpoints with all three preregistered readers, both verdicts, the secondary measures, the judge checks and the hand audit.

## Disclosures

gbrain is Garry Tan's own project. Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1. Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.

BEAM ([mohammadtavakoli78/BEAM](https://github.com/mohammadtavakoli78/BEAM)) is used under CC BY-SA 4.0 at the pinned revision.
