# On eight sealed BEAM cells, the judge decides whether particle-1 scores above or below Opus 5.5

On the eight F6 cells that got a second judge, BEAM's canonical judge, gpt-4.1-mini, scores particle-1 above Claude
Opus 5.5 by 0.9 to 8.0 points. GPT-6.1 Sol, judging the same answers on the same rubric, scores it 4.9 to 8.0 points
below, and every one of its eight 95% intervals is below zero. So on these cells the canonical judge's gaps between
answer models are not reliable. They flip sign when the judge changes, and a reader-model comparison on them is
judge-dependent. Under either judge, particle-1 costs 12 to 19 times less than Opus 5.5 per correct answer.

As the agent in F6's file-agent system, on the same 198 questions, particle-1 scores 63.4% against Opus 5.5's 72.1%
under the canonical judge (−8.7 points, 95% interval −14.0 to −3.2), at $0.44 against $1.19 per correct answer.

## The test

[BEAM](https://github.com/mohammadtavakoli78/BEAM) asks questions about very long chat histories: what the user said,
how plans changed over time, and which of two events came first. An invented example of the kind of question: "How many
weeks after starting the new job did I say I was moving apartments?" A memory system has to find the right turns of the
conversation and hand them to an answer model (the reader). A judge model then scores each answer against the
benchmark's rubric from 0 to 1, and an answer counts as correct at 0.5 or more.

[F6](../benchmarks/2026-10-29-f6-current-master/scoreboard.md) is the November 3 rerun of that comparison at gbrain
0.60.493.0 (`0ccf2bdd`). gbrain, the memory system this repository tests, and the other systems each hand the reader
8,000 tokens of context. Its sealed sets have never been public: S1 is BEAM-10M (199 scored questions in 10
conversations) and S2b is BEAM-1M (240 questions in 24 conversations). The particle-1 add-on, F6's amendment A6, adds
particle-1 beside F6's readers without changing any F6 cell:

- **Re-reads.** particle-1 reads, byte for byte, the frozen 8,000-token contexts that F6's readers read for ten published
  rows. The rows are gbrain arms P (F6's headline arm, which adds gbrain's facts block) and A0 (gbrain's own delivery),
  plus two memory servers and a temporal-graph library, each on S1 and S2b. Nothing is retrieved again, and the
  check before any request verified that every context hashes to the one F6's readers saw.
- **File agent.** F6's file-agent system is an agent with grep over the raw conversation files and up to 40 turns. On S1
  it ran again with particle-1 as the agent.
- **Second judge.** A6 preregistered a second-judge check for any cell where the canonical judge put particle-1 above
  Opus 5.5. That happened on 8 of the 10 re-read cells. On those 8, gpt-6.1-sol judged both readers' answers again on
  the same BEAM rubric. GPT-6.1 Sol is from neither reader's family, and its own reader answers were not re-judged.
  The second judge never replaces the canonical score.

Every reader ran at effort medium, the effort F6 fixes for all readers, with one answer per question.

## The judges disagree on every cell judged twice

The positive canonical gaps are positive by selection, because only those cells went to the second judge. The finding
is that the second judge reverses the sign on all eight.

| Cell | Questions (conversations) | particle-1 minus Opus 5.5, gpt-4.1-mini (95% CI) | particle-1 minus Opus 5.5, gpt-6.1-sol (95% CI) | Correct, Opus 5.5 / particle-1, gpt-4.1-mini | Correct, Opus 5.5 / particle-1, gpt-6.1-sol | $ per correct, Opus 5.5 / particle-1, gpt-4.1-mini | $ per correct, Opus 5.5 / particle-1, gpt-6.1-sol |
|---|---:|---:|---:|---:|---:|---:|---:|
| S1 gbrain A0 | 197 (10) | +8.0 (+5.2 to +11.3) | −5.7 (−9.3 to −1.9) | 101 / 119 | 114 / 99 | $0.1120 / $0.0059 | $0.0992 / $0.0070 |
| S1 extract-first server | 199 (10) | +6.5 (+2.4 to +11.2) | −5.5 (−9.2 to −1.8) | 111 / 127 | 123 / 110 | $0.1019 / $0.0064 | $0.0919 / $0.0074 |
| S2b extract-first server | 239 (24) | +5.9 (+1.3 to +10.9) | −5.6 (−10.1 to −1.5) | 149 / 166 | 172 / 161 | $0.0943 / $0.0054 | $0.0817 / $0.0055 |
| S2b gbrain P | 240 (24) | +4.4 (+0.8 to +8.1) | −6.0 (−8.8 to −3.4) | 160 / 172 | 183 / 165 | $0.0844 / $0.0044 | $0.0738 / $0.0046 |
| S2b memory-bank server | 240 (24) | +3.4 (−0.2 to +7.2) | −7.4 (−10.8 to −4.3) | 155 / 171 | 178 / 156 | $0.0825 / $0.0047 | $0.0719 / $0.0051 |
| S2b temporal graph 0.31.2 | 240 (24) | +3.2 (−0.6 to +7.0) | −4.9 (−7.4 to −2.5) | 140 / 157 | 145 / 137 | $0.1011 / $0.0057 | $0.0976 / $0.0066 |
| S2b gbrain A0 | 240 (24) | +2.6 (−0.9 to +6.2) | −8.0 (−11.0 to −4.9) | 159 / 170 | 174 / 157 | $0.0886 / $0.0047 | $0.0810 / $0.0051 |
| S1 memory-bank server | 199 (10) | +0.9 (−2.8 to +5.8) | −6.2 (−9.7 to −2.7) | 110 / 113 | 109 / 100 | $0.0948 / $0.0070 | $0.0957 / $0.0079 |

Differences are in points of mean rubric score, paired by question over the questions both readers have in their
denominators. Cells run in the order A6 fixed, the largest canonical gap first.

- **How the judges differ.** gpt-6.1-sol marks more of Opus 5.5's answers correct than gpt-4.1-mini does on 7 of the 8
  cells, and fewer of particle-1's on all 8. Which judge is closer to a careful human grader was not measured.
- **What it means for F6.** This check changes no F6 row or verdict. It tests the judge only on gaps between reader
  models, and on those cells gpt-4.1-mini's gap between particle-1 and Opus 5.5 is not a reliable basis for choosing a
  reader. Whether the judge also shifts gaps between memory systems was not measured.
- **Not judged twice.** S1 gbrain P (−4.3, −8.6 to +0.5), S1 temporal graph (−2.2, −7.4 to +3.4) and the file agent
  (−8.7, −14.0 to −3.2) had canonical gaps at or below zero, so A6 sent them to no second judge.

## Cost per correct answer, beside Opus 5.5

The table below uses the canonical judge, as A6 preregistered. Reader dollars are list prices applied to each answer's
recorded usage.

| Cell | How particle-1 read it | Questions paired | Opus 5.5 | particle-1 | particle-1 minus Opus 5.5 (95% CI) | Opus 5.5 $ per correct | particle-1 $ per correct |
|---|---|---:|---:|---:|---:|---:|---:|
| S1 file agent | as the agent | 198 | 72.1% | 63.4% | −8.7 (−14.0 to −3.2) | $1.1914 | $0.4368 |
| S1 gbrain P | re-read | 199 | 60.7% | 56.4% | −4.3 (−8.6 to +0.5) | $0.0869 | $0.0063 |
| S1 gbrain A0 | re-read | 197 | 48.5% | 56.6% | +8.0 (+5.2 to +11.3) | $0.1120 | $0.0059 |
| S1 extract-first server | re-read | 199 | 54.2% | 60.7% | +6.5 (+2.4 to +11.2) | $0.1019 | $0.0064 |
| S1 memory-bank server | re-read | 199 | 51.9% | 52.9% | +0.9 (−2.8 to +5.8) | $0.0948 | $0.0070 |
| S1 temporal graph 0.31.2 | re-read | 199 | 47.6% | 45.4% | −2.2 (−7.4 to +3.4) | $0.1117 | $0.0086 |
| S2b gbrain P | re-read | 240 | 62.8% | 67.2% | +4.4 (+0.8 to +8.1) | $0.0844 | $0.0044 |
| S2b gbrain A0 | re-read | 240 | 64.1% | 66.7% | +2.6 (−0.9 to +6.2) | $0.0886 | $0.0047 |
| S2b extract-first server | re-read | 239 | 59.1% | 65.1% | +5.9 (+1.3 to +10.9) | $0.0943 | $0.0054 |
| S2b memory-bank server | re-read | 240 | 62.7% | 66.1% | +3.4 (−0.2 to +7.2) | $0.0825 | $0.0047 |
| S2b temporal graph 0.31.2 | re-read | 240 | 56.0% | 59.2% | +3.2 (−0.6 to +7.0) | $0.1011 | $0.0057 |

On the re-reads, particle-1 costs 13 to 19 times less per correct answer under the canonical judge. On the eight cells
judged twice, it costs 12 to 16 times less under gpt-6.1-sol. As the file agent it costs 2.7 times less. The full
per-reader tables, including F6's other readers on the same questions, are in [report.md](2026-11-04-particle-1-f6-addon/report.md).

**Build and ingest dollars, once per system.** Building a system's store and retrieving from it cost the same whatever
the reader, so they don't enter the per-reader figures above. Each published F6 receipt's metering proxy recorded them
for the whole cell (for the two memory servers, their A24 cells, which F6 reuses):

| System | S1 ingest | S1 retrieval | S2b ingest | S2b retrieval |
|---|---:|---:|---:|---:|
| gbrain (arms P and A0 read the same brain) | $85.91 | $0.80 | $18.53 | $0.94 |
| extract-first server | $252.28 | $0.00 | $57.18 | $0.00 |
| memory-bank server | $156.84 | $0.00 | $33.66 | $0.00 |
| temporal graph 0.31.2 | $386.18 | $8.87 | $84.94 | $8.70 |
| file agent (greps the raw files) | $0.00 | $0.00 | not run | not run |

## The file agent

particle-1 ran F6's file-agent cell, `s1.baseline-file-agent.particle`, in three paid legs. Each resume ingested the
store again, kept the answers already recorded and asked only the rest.

| Leg | Lease | Campaign | Settled | Answers after the leg | How it ended |
|---|---|---|---:|---:|---|
| a1 | `s1.baseline-file-agent.particle-a1-1d4d91ac` | `q1-scoreboard-f6-current-master-p1` | $16.08 of $16.15 | 56 | the lease's budget ran out |
| a2 | `s1.baseline-file-agent.particle-a1-6b01afc7` | `q1-scoreboard-f6-current-master-p1b` | $18.92 | 120 | Particle answered HTTP 402 when the key's credit ran out |
| a3 | `s1.baseline-file-agent.particle-a1-24a910e1` | `q1-scoreboard-f6-current-master-p1c` | $26.07 of $49.08 | 200 | complete |

| Reader | In the denominator | Mean score (95% CI) | Correct | Reader $ | $ per answer | $ per correct | Stops |
|---|---:|---:|---:|---:|---:|---:|---|
| Opus 5.5 (F6's row) | 199 | 72.3% (67.1% to 77.3%) | 156 | $185.85 | $0.934 | $1.1914 | context_overflow 5 |
| particle-1 | 198 | 63.4% (58.6% to 68.2%) | 138 | $60.28 | $0.303 | $0.4368 | turn_cap 23; reader_error 1 |

Paired over 198 questions in 10 conversations, particle-1 minus Opus 5.5 is −8.7 points (−14.0 to −3.2). F6's other
two readers had no stops.

The preregistered outcome rule counts turn_cap (the agent used all 40 turns) and context_overflow (the history no
longer fit the model's window) as the product's failures: they score 0 and stay in the denominator. The one
reader_error is the answer the HTTP 402 cut off, a harness failure, so it leaves the denominator. particle-1 hit the
turn cap 7, 4 and 12 times across the three legs, and never overflowed its window.

**Why A6's $0.04 basis was about 7.6 times too low.** A6 sized the file agent at 130,000 input and 2,000 output tokens
per answer, about $0.04 at particle-1's list price. Across all 200 answers, particle-1 read 1.78 million prompt tokens
per answer (39% of them cache reads) and wrote 8,887, over 18.6 turns. Each turn resends everything the agent has read
so far, so prompt tokens grow much faster than the turn count. The estimate came from a reader's context size rather
than from a measured agent run.

**More tokens, fewer dollars.** On the same questions, Opus 5.5 read 0.53 million prompt tokens per answer (69% cache
reads) and wrote 1,997, over 5.1 turns. So particle-1 reads 3.4 times Opus 5.5's prompt tokens (2.9 to 3.9 times in
each leg), yet costs about a third as much per answer: $0.30 against $0.93 at list price, and $0.28 to $0.32 against
$0.72 to $1.13 per leg from the answers' recorded dollars ([file-agent-usage.json](2026-11-04-particle-1-f6-addon/file-agent-usage.json)).

## What it means, and what it doesn't

- **Choosing a reader.** On these 8,000-token contexts, particle-1 costs 12 to 19 times less per correct answer. Whether it gives up accuracy to Opus 5.5 depends on the judge: gpt-6.1-sol says it does, by 4.9 to 8.0
  points, and gpt-4.1-mini says it doesn't. Treat the accuracy side as open until a judge has been checked against
  human grades.
- **As an agent.** particle-1 scores 8.7 points below Opus 5.5 under the judge that, on the re-reads, scored it higher.
  It hits the 40-turn cap on 23 of 198 questions and reads far more tokens per answer.
- **What it doesn't say.** Nothing here ranks the memory systems. F6's rows and verdicts are unchanged, and S1 can only
  detect differences of about 13.6 points, so its comparisons are descriptive.

## Full details

- **Record:** `2026-11-04-particle-1-f6-addon`, a finding, status open. **Grade:** exploratory. The comparisons are
  descriptive under A6, and the second judge is a preregistered sensitivity check that never replaces the canonical
  score.
- **Publication status:** unpublished. There is no X post. Anything posted as Garry Tan needs his approval.
- **Preregistration:** [F6 amendment A6](../benchmarks/2026-10-29-f6-current-master-preregistration.md#a6-2026-11-03-the-particle-1-add-on),
  with revisions 1 to 4. Revision 4 moved a3's unspent $23.00 to the second judge, which judged the last three cells.
- **Code:** re-reads and the report from `eval/runner/q1/reread-cell.ts` and
  `eval/runner/q1/particle-addon-report.ts` (report run at `e41ccb5c`); second judge
  `eval/runner/q1/second-judge.ts` at `d25c3a68` (#369); a3 from campaign p1c at `e41ccb5c`, campaign hash
  `665a484e`; a2 from p1b at `2813fcb3`.
- **Data:** aggregates only, in [2026-11-04-particle-1-f6-addon/](2026-11-04-particle-1-f6-addon/) with
  [SHA256SUMS](2026-11-04-particle-1-f6-addon/SHA256SUMS): report.md and report.json, second-judge-summary.md and
  file-agent-usage.json. The sealed questions, answers and judgments stay in custody.
- **F6 label fix.** F6's receipt names the S1 file-agent row's block T1, because its A4 unit ran without
  `--manifest f6`. Its run configuration (`07b938b4`) is the one F6 publishes, and the add-on pairs with it by that
  configuration. F6's scoreboard now carries a dated line saying it is a label fix, not a re-run
  ([scoreboard limitations](../benchmarks/2026-10-29-f6-current-master/scoreboard.md)).
- **Author:** GBEV-39, from GBEV-31's and GBEV-35's runs.

### Why null? (R48)

- **Exposure.** particle-1 read every frozen context in full (verify counts are in report.md), and as the agent it
  answered all 200 questions over 18.6 turns each.
- **Task fit.** Answering from retrieved conversation turns is the reader's whole task on BEAM, and the file agent is
  the setting F6 built for an agent model.
- **Power and saturation.** No reader is near the ceiling: cell means run from 45% to 72%. With 10 conversations, S1
  detects only differences of about 13.6 points. Even so, all eight of the second judge's intervals exclude zero.
- **Frontier.** Opus 5.5 scores higher as the agent, and higher on the re-reads under gpt-6.1-sol.
- **Verdict: FIX-METHOD** for the re-read comparison of reader models. The sign depends on the judge, so the method
  needs a judge validated against human grades before it can rank readers. The judge-robustness follow-up owns that.
  **KEEP** for the file-agent row, which is reported as measured.

### Limits

- Both judges are OpenAI models. No third family and no human grades were used, so which judge is right is not known.
- Only cells where the canonical judge put particle-1 above Opus 5.5 were judged twice. The other two re-read cells
  and the file agent have the canonical judge alone.
- One answer per question, every reader at effort medium. Other efforts would change scores and costs.
- report.md rounds each mean to four decimals before formatting it, so Opus 5.5's own file-agent mean reads 72.3% there
  and 72.2% in F6's scoreboard. The paired means (72.1% and 63.4%) and every difference are unaffected.
- Reader dollars are list prices on recorded usage. Failed tries are not priced, since only OpenAI-compatible readers
  record their usage. Each cell's metered spend, failed tries included, is in its receipt.
- Correction, 2026-11-09: report.md's gpt-6.1-sol reader dollars and dollars per correct answer are low, because the
  answer records priced OpenAI's cache writes as plain input (fixed in gbrain-evals #397). The per-answer usage stays in
  custody, so they are not recomputed here. OpenAI's cache-write rate is a quarter above its input rate, so the re-read
  rows, whose contexts are 8,000 tokens, are low by at most a quarter. The file agent's row can be low by more: its
  runner never applied OpenAI's long-context rates and its request sizes aren't committed, so if a request passed
  272,000 input tokens, its Sol figures could be up to 2.5 times as high. particle-1's and Opus 5.5's figures, every
  accuracy figure and both judges' results are unaffected ([corrections](../corrections.md#openai-cache-writes)).
- The file agent ran in three legs, each resuming from the last. The comparison with Opus 5.5's F6 row is like for like
  under the outcome rule.
- Not verified: reconciliation of the add-on's ledgers against the Particle key's other traffic and its credit balance,
  and the Ubicloud bill for the file agent's VMs.

### Cost

| Item | Dollars |
|---|---:|
| Re-reads (10 cells, particle-1 and the canonical judge) | $14.02 |
| Second judge (8 cells: 5 under the $60 re-read ceiling, 3 from a3's unspent remainder) | $67.32 |
| File agent (a1, a2, a3) | $61.07 |
| Metered total, against $144.15 of ceilings | $142.41 |
| VM time (Ubicloud standard-4, not read from the bill; list-price estimate) | about $2 |

The add-on's hard cap was $150, VM time included. The agent threads' own model time counts toward the eval's all-in
budget too. GBEV-35 used about $155.52, and GBEV-39 about $7.57 by the time this was written,
before review. GBEV-31's share is not split out. All-in, the add-on comes to about
$308 so far.

### Replicate it

The sealed sets live only on the custodian's host, so the paid steps run there. From the repository root:

```bash
# Re-read one frozen row with particle-1 (A6), on the add-on's own ledger
bun eval/runner/q1/reread-cell.ts --cell <source cell id> --arm <arm id> --source <out>/runs/<cell id>... --reader particle:particle-1 \
  --out <dir> --budget-ledger <file> --run-id <id> --lease-usd <n> --ledger-cap-usd <n> --manifest f6
# File agent: the p1c campaign, resumed from p1b
bun eval/runner/shootout-cell.ts resume --campaign docs/benchmarks/2026-10-29-f6-current-master/campaign/f6-campaign-p1c.json --state <state> \
  --cell s1.baseline-file-agent.particle --from-campaign docs/benchmarks/2026-10-29-f6-current-master/campaign/f6-campaign-p1b.json --from-state <p1b state>
# Second judge, one cell per --out, under the re-read ledger's ceiling
bun eval/runner/q1/second-judge.ts --cell <cell> --arm <arm> --manifest f6 --root <re-read out> --root <F6 receipt> \
  --out <dir> --budget-ledger <ledger> --run-id <id> --lease-usd <lease> --ledger-cap-usd <ceiling>
# The report and the second-judge table (no API calls)
bun eval/runner/q1/particle-addon-report.ts --root <each re-read out> --root <F6 receipt> --root <p1c cell output> --out <dir>
bun eval/runner/q1/second-judge.ts summary --out <second-judge out>...
```

Keys: `PARTICLE_API_KEY` for particle-1 and `OPENAI_API_KEY` for both judges. Observed time: about 2 h 16 min for
a3, and 9 to 22 minutes per second-judge cell at concurrency 32.

### Changelog

#### 2026-11-04: First version

Written from A6's re-reads, the three file-agent legs and all eight second-judge cells. It leads with the judge
disagreement, as GBEV-3 asked: the canonical judge's particle-1 versus Opus 5.5 gaps are not reliable for comparing
reader models.

## Disclosures

Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.

gbrain is Garry Tan's own project.

Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.

The words come from [docs/disclosures.md](../disclosures.md).
