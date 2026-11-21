# gbrain on Redis's open LongMemEval harness: frontier readers reach README's 93.6%, and cutting results at a score cliff costs answers

Measured 2026-11-20 to 2026-11-21. Status: **complete**, with the **on** arm stopped at the planned interim look (questions 1 to 250). Evidence class: development (LongMemEval-S was used to tune gbrain, so nothing here is held-out confirmation). Build: gbrain **v0.60.752.0** (`1f8d079d13c10d511c919cf69dd1e4c0137fbfcd`), the newest release when the counted run started. [Preregistration](2026-11-20-longmemeval-redis-harness-preregistration.md), raw data and receipts in [2026-11-20-longmemeval-redis-harness/](2026-11-20-longmemeval-redis-harness/).

[gbrain](https://github.com/garrytan/gbrain) is a Markdown-first memory system for agents. [LongMemEval](https://arxiv.org/abs/2410.10813) asks 500 questions about long histories of old chats. Redis publishes LongMemEval results from an [open harness](https://github.com/redis/agent-memory-server/tree/843d2078830f7297882316efb1aae0fb7ae1481f/agent-memory-benchmark), so we put gbrain through that same harness: Redis's dataset loader, one-shot answer prompt, judge prompts and metric, vendored unchanged in [eval/redis-agent-memory-benchmark/](../../eval/redis-agent-memory-benchmark/README.md). gbrain's `query` picks the conversations; the harness's reader answers from them.

- **We learned that with gbrain choosing five whole conversations, a frontier reader answers about 93% of LongMemEval on a plain one-shot prompt, and a low-cost reader comes close for a twelfth of the price. You should choose the reader before you tune retrieval.** Opus 5.5 answered 469 of 500 (93.8%, Wilson interval 91.3% to 95.6%) under the harness's own gpt-4o judge, which reaches the 93.6% README shows for gbrain's note-taking setup. particle-1 answered 462 (92.4%) at about $0.004 per right answer against Opus's $0.049; on the same judge it is 1.8 points behind Opus (95% interval 0.2 to 3.4). Swapping gpt-4o for Opus as the reader moved the score 12.8 points (9.4 to 16.2); giving Opus perfect evidence instead of gbrain's moved it 3.8 (2.0 to 5.6).
- **We learned that cutting search results where relevance scores drop sharply throws away the second conversation that many questions need. You should keep autocut off for memory questions, as gbrain now ships it.** Forcing autocut on at a limit of 10 cut 173 of the first 250 questions below five conversations, left at least one evidence turn out on 46 answerable questions against 6, and cost Opus 12.8 points: 32 questions lost, none gained (95% interval 8.8 to 17.2). The test stopped at its one interim look, so this estimate may be overstated. Every reader lost answers: gpt-6.2-sol 11.6 points, particle-1 11.2 and gpt-4o 7.6.
- **What didn't work: with Redis's own reader, gbrain is behind Redis's published number, and the whole history scored a little higher than gbrain for every frontier reader.** gpt-4o on gbrain's conversations scores 79.2% task-averaged (75.5% to 83.0%) against Redis's published 86.14%; even with perfect evidence gpt-4o reaches only 88.0%, and most of the gap is preference questions. Pasting the whole history gave Opus, Sol and particle-1 2.2 to 2.8 more points than gbrain, a difference that does not pass the plan's correction for 11 tests (adjusted p = 0.058), at about 7.7 times gbrain's reader input. For gpt-4o the whole history cost 18.2 points.

Settled call: gbrain keeps autocut off (it already ships off), and reader work goes ahead of retrieval work for this benchmark, starting with gbrain's own answer path on Opus 5.5.

| Reader | gbrain's conversations: right of 500 | Whole history | Perfect evidence | Reader cost per right answer, gbrain | Reader cost per right answer, whole history |
|---|---|---|---|---|---|
| `claude-opus-5-5` | **471 (94.2%)** | 482 (96.4%) | 490 (98.0%) | $0.049 | $0.350 |
| `particle-1` | **462 (92.4%)** | 475 (95.0%) | 481 (96.2%) | $0.0040 | $0.028 |

Both rows are graded by the same cross-family judge, `gpt-6.2-astra`. Cost is what the reader requests cost: Opus through Anthropic's batch API at half its list price ($4 and $20 per million input and output tokens), particle-1 at its list price ($0.25 and $1.00; it has no batch endpoint), from the token counts in [reader-tokens.ndjson.gz](2026-11-20-longmemeval-redis-harness/reader-tokens.ndjson.gz). It leaves out gbrain's search (a rerank call gbrain estimates at about $0.0003 per question) and the one-time embedding of each history. Opus's four whole-history refusals are counted wrong.

## The concrete case

The first question in the run's order, `cc06de0d`, asks how much more a taxi ride cost than the user's daily train fare. The answer, $6, needs two conversations: one where the user mentions a $12 taxi after missing a train, and another where they mention a $6 train fare. With autocut off, gbrain's top results put both conversations in the prompt, and Opus answered "The taxi ride cost **$6 more** than your usual train fare." With autocut forced on, the relevance scores fell sharply after the taxi conversation, so the cut kept that one conversation alone, and Opus answered "I can't calculate the difference because you never mentioned your regular train fare." All four readers got it wrong with autocut on. Every one of the 32 questions Opus lost needs at least two evidence turns, and in every one the cut dropped at least one: 15 multi-session questions (a sum, a count or a difference), 10 temporal ones (a gap between two dates) and 7 knowledge updates, where the newer value went missing.

## The experiment

- **Data.** All 500 LongMemEval-S questions, loaded by the vendored loader, with each file's sha256 checked before every load. Each question gets its own brain, built from its own history of about 50 conversations.
- **Arms.** Five ways of filling the answer prompt's "Memories" section; the reader, prompt and question stay the same.

  | Arm | What the reader gets | gbrain call |
  |---|---|---|
  | **off** | the first 5 distinct conversations behind gbrain's results, whole, in rank order | `query {limit: 10, autocut: false}` |
  | **on** | the same, with autocut forced on, so often fewer than 5 | `query {limit: 10, autocut: true}` |
  | **agent-default** | the returned passages, each headed by its conversation's date (gpt-4o only) | `query {}`, every default; gbrain's cap of 3 pages per answer trims it |
  | **full** | every conversation in the history, whole, in date order: no memory system | none |
  | **oracle** | only the conversations that hold the evidence | none |

- **Readers.** `gpt-4o-2024-08-06` (Redis's reader, the link to its table, all five arms), `claude-opus-5-5`, `gpt-6.2-sol` and `particle-1` (off, on, full and oracle). Each is one plain API call with the harness's two messages, built once by the vendored Python. No prompt was too long for any reader's window.
- **Judges.** Every answer has two judges, scored apart. The protocol judge is Redis's: gpt-4o with LongMemEval's official prompts and Redis's yes/no parse; it decides only the two rows compared with published numbers. The cross-family judge decides everything else: `gpt-6.2-astra` for Opus and particle-1 answers, `claude-opus-5-5` for gpt-4o and Sol answers. particle-1 never judges.
- **One request per distinct prompt.** Where autocut didn't cut, **on** and **off** give a reader byte-identical prompts, so the reader answered once and that answer counts for both arms. That happened on 73 of the first 250 questions.
- **Statistics.** Paired differences under the cross-family judge, with McNemar's test and a 95% interval from a paired bootstrap (10,000 resamples, seeded). The primary is Opus, **off** minus **on**. Eleven secondaries share Holm's correction. Readers are compared with each other only descriptively.

## Results

### Autocut: forcing it on costs answers (primary, stopped at the interim look)

| Reader | off, questions 1 to 250 | on | Lost / gained with autocut on | off minus on (95% interval) | Adjusted p | Smallest detectable difference at 250 |
|---|---|---|---|---|---|---|
| **`claude-opus-5-5` (primary)** | 236 | 204 | 32 / 0 | **+12.8 (8.8 to 17.2)** | z = 5.66, exact p = 5e-10 | 6.4 |
| `gpt-6.2-sol` | 233 | 204 | 30 / 1 | +11.6 (7.6 to 16.0) | 3e-7 | 6.3 |
| `gpt-4o` | 202 | 183 | 29 / 10 | +7.6 (2.8 to 12.4) | 0.014 | 7.0 |
| `particle-1` | 232 | 204 | 32 / 4 | +11.2 (6.8 to 15.6) | 2e-5 | 6.8 |

The plan took one look at the primary after the first 250 questions, with an O'Brien-Fleming stop at |z| ≥ 2.80. Opus's z was 5.66, so the **on** arm stopped for every reader, as the plan says, and every comparison with **on** covers questions 1 to 250 only. A test stopped early tends to overstate its effect, so read 12.8 points as "large", not as a precise size. The detectable differences in the last column come from each pair's observed disagreement at 250.

Why autocut costs answers shows in what reaches the reader. On the first 250 questions **on** kept 1 conversation on 105, 2 on 61, 3 on 5, 4 on 2 and all 5 on 77. Of 238 answerable questions, **off** delivered every evidence turn on 232 and **on** on 192. Three readers landed on 204 right with **on**: the answers differ, and all three are wrong on the same 42 of 46 questions (43 or 44 for each pair), which fits a cut that removes the evidence for everyone.

**The decision.** The plan's "**off** wins clearly" outcome holds: the primary passed its bound with **off** ahead, Sol points the same way, and **off** delivers every evidence turn on more questions. gbrain already ships autocut off in every search mode at this build, so nothing changes; gbrain's maintainers have the paired numbers and the delivery counts.

**agent-default, gbrain's out-of-the-box `query {}` (gpt-4o only, by the plan).** It scored 403 of 500 against **off**'s 399: **off** minus agent-default is -0.8 points (-3.8 to 2.2; 27 questions right only on **off**, 31 only on agent-default), with a smallest detectable difference of 4.3. So the 3-page cap that trims `query {}` showed no measurable cost here, even though it delivered every evidence turn on fewer questions (424 against 463). It hands the reader passages rather than whole conversations, which is a different trade.

### The reader gap: Opus closes it, and perfect evidence adds about 4 points

| Reader | off, protocol judge | Wilson 95% | Against README's 93.6% | oracle, protocol judge | Against 93.6% |
|---|---|---|---|---|---|
| `claude-opus-5-5` | **469 (93.8%)** | 91.3 to 95.6 | closes the gap | 481 (96.2%) | closes the gap |
| `particle-1` | 462 (92.4%) | 89.7 to 94.4 | not distinguishable | 481 (96.2%) | closes the gap |
| `gpt-6.2-sol` | 459 (91.8%) | 89.1 to 93.9 | not distinguishable | 473 (94.6%) | closes the gap |
| `gpt-4o` | 405 (81.0%) | 77.3 to 84.2 | falls short | 439 (87.8%) | falls short |

"Closes the gap" means at least 463 of 500 with an interval that includes 93.6%. README's 93.6% used a different reader (Sonnet 5.5 taking notes) and different retrieval settings, so this row says the reader, not gbrain's retrieval, was the gap between gbrain on this harness and README. The plan's outcome for "a frontier reader closes it" applies: reader work goes ahead of retrieval work for this benchmark, and the next experiment tests gbrain's own answer path with Opus 5.5.

Under the cross-family judge, perfect evidence beats gbrain's conversations for every reader (Holm-adjusted):

| Reader | oracle minus off (95% interval) | Right only with oracle / only with off | Adjusted p | Smallest detectable difference |
|---|---|---|---|---|
| `claude-opus-5-5` | +3.8 (2.0 to 5.6) | 20 / 1 | 0.0002 | 2.6 |
| `gpt-6.2-sol` | +3.6 (1.6 to 5.8) | 23 / 5 | 0.005 | 3.0 |
| `gpt-4o` | +7.0 (3.8 to 10.2), 499 scored | 51 / 16 | 0.0002 | 4.6 |
| `particle-1` | +3.8 (1.6 to 6.2) | 27 / 8 | 0.009 | 3.3 |

Retrieval misses explain part of it: **off** left out at least one evidence turn on 16 of 479 answerable questions (875 of 896 evidence turns delivered). The rest is the reader reading five whole conversations instead of only the right ones.

### No memory: the whole history against gbrain

| Reader | off minus full (95% interval) | Right only with off / only with full | Adjusted p | Smallest detectable difference | Mean reader input per question, off / full |
|---|---|---|---|---|---|
| `claude-opus-5-5` | -2.2 (-4.0 to -0.6) | 4 / 15 | 0.058 | 2.5 | 21,691 / 167,280 tokens |
| `gpt-6.2-sol` | -2.8 (-5.0 to -0.6) | 9 / 23 | 0.058 | 3.2 | 13,425 / 103,611 |
| `particle-1` | -2.6 (-5.0 to -0.4) | 11 / 24 | 0.058 | 3.3 | 13,695 / 105,172 |
| `gpt-4o` | **+18.2 (14.0 to 22.2)** | 109 / 18 | 5e-16 | 6.4 | 13,426 / 103,612 |

Token counts are each provider's own. For the three frontier readers the whole history is ahead by 2.2 to 2.8 points; each raw interval excludes zero, but none passes Holm's correction over the 11 secondaries, so by the plan's rule this is no measurable difference, with the whole history leaning ahead. gbrain's case on this set, for those readers, rests on reading about an eighth of the input. Opus's whole-history arm includes 4 provider refusals (empty answers, counted wrong). For gpt-4o, the whole history is far worse: 70 of 133 multi-session questions and 1 of 30 preference questions right.

### Redis's published number: gbrain is behind with gpt-4o

gpt-4o reading gbrain's conversations scores **79.2% task-averaged** (the harness's metric, the mean of six per-type accuracies under the protocol judge), with a 95% interval of 75.5% to 83.0% from a bootstrap stratified by type. Redis publishes 86.14% for Remis + Instruct and 71.24% for Instruct alone ([source and protocol](../comparison-systems.md)). The interval lies below 86.14%, so gbrain is behind on this harness with Redis's reader and judge. One published aggregate with no per-question outputs can't support a ranking either way.

| Question type (count) | gbrain, off | gbrain, agent-default | gpt-4o with perfect evidence | Redis, Remis + Instruct (published) |
|---|---|---|---|---|
| single-session-user (70) | 92.9 | 94.3 | 100.0 | 97.14 |
| single-session-preference (30) | **43.3** | 66.7 | 73.3 | 73.33 |
| single-session-assistant (56) | 100.0 | 100.0 | 100.0 | 100.0 |
| multi-session (133) | 78.2 | 69.9 | 83.5 | 75.94 |
| temporal-reasoning (133) | 75.2 | 78.9 | 84.2 | 81.95 |
| knowledge-update (78) | 85.9 | 83.3 | 87.2 | 88.46 |
| **Task-averaged** | **79.2** | 82.2 | 88.0 | **86.14** |

Protocol judge, percentages; LongMemEval's 30 abstention questions sit inside their types, as in the harness. Only the off column was planned as the comparison; the other two are description.

**Why null?** (one pass, as our rules require for a result that goes against us)

- **Did the reader get the evidence?** Mostly: **off** delivered every evidence turn on 463 of 479 answerable questions. gpt-4o still lost 7.0 points against perfect evidence, about twice what the frontier readers lost.
- **Is there headroom?** Little. gpt-4o with exactly the right conversations scores 88.0% task-averaged, under 2 points above Redis's number, so no retrieval change can put gpt-4o far ahead on this prompt.
- **Where is the gap?** Preference questions carry most of it: 13 of 30 against Redis's 22, worth 5.0 of the 6.9 task-averaged points. Those questions ask for a suggestion that fits what the user said they like, and five whole conversations seem to bury the one remark that matters for gpt-4o. gbrain's passages (agent-default) got 20 of 30 there, and gpt-4o with perfect evidence 22.
- **Do frontier readers do it unaided?** Yes: on the same conversations Opus scores 94.8% task-averaged, Sol 91.5% and particle-1 93.7%.

Verdict: **KEEP** gbrain's retrieval for frontier readers. For weak readers there is one method lead, unplanned and so untested here: hand the reader passages instead of whole conversations on preference questions.

### Reader against reader (description only)

| Pair, on off | Protocol judge (one judge for both) | Cross-family judges |
|---|---|---|
| Opus minus gpt-4o | +12.8 (9.4 to 16.2) | +14.4 (11.0 to 18.0) |
| Sol minus gpt-4o | +10.8 (7.4 to 14.4) | +12.2 (8.8 to 15.8) |
| Opus minus particle-1 | +1.4 (-0.2 to 3.2) | +1.8 (0.2 to 3.4), both graded by Astra |

### Every cell

Right answers under the cross-family judge (and the protocol judge), out of 500, or 250 for **on**.

| Reader | off | on | agent-default | full | oracle |
|---|---|---|---|---|---|
| `claude-opus-5-5` | 471 (469) | 204 (203) | not run | 482 (481) | 490 (481) |
| `gpt-6.2-sol` | 460 (459) | 204 (205) | not run | 474 (471) | 478 (473) |
| `particle-1` | 462 (462) | 204 (203) | not run | 475 (474) | 481 (481) |
| `gpt-4o` | 399 (405) | 183 (183) | 403 (405) | 308 (317) | 434 (439) |

No answer was cut off by its output limit and no question ran on degraded retrieval. The 4 Opus whole-history refusals are the only provider safety stops; they are judged as given (empty, so wrong). One cross-family judgment of a gpt-4o oracle answer was unparsable, so that cell scores 499. Per-type rows for every cell, mean input and output tokens, and judge agreement per cell are in [extras.json](2026-11-20-longmemeval-redis-harness/extras.json).

## Judges

Each judge passed the plan's check before any counted number: Cohen's kappa of at least 0.6 on 200 known-answer controls and on at least 40 answers labelled by a third model family (`gemini-4-argon`), with at most 1% unparsable replies.

| Judge | Controls: kappa, agreement | Real answers: kappa, agreement, n | Unparsable on controls |
|---|---|---|---|
| Protocol, gpt-4o | 0.86, 93.0% | 0.97, 99.0%, 96 | 0% |
| Cross-family, `claude-opus-5-5` | 0.85, 92.5% | 1.00, 100%, 48 | 0% (1.5% under the original parse) |
| Cross-family, `gpt-6.2-astra` | 0.92, 96.0% | 1.00, 100%, 48 | 0% |

Under the parse as first written (the reply's first word must be yes or no), the Opus judge had 3 of 200 control replies unparsable, 1.5%, above the 1% gate: it explained first and put "no" alone on the last line. A dated amendment before any counted unit added one fallback, reading a last line that is exactly yes or no, and every recorded reply was rescored with no new request; under it the rate is 0%. Astra's real-answer set holds only 4 answers the labeller marked wrong, all the pilot had, so its real-answer kappa says little about wrong answers; the controls, with 90 known-wrong items, are the check there. The labels come from a model; the controls don't.

On the counted answers the two judges disagreed on 161 of 7,499 judged rows (2.1%); counting each answer reused from **off** once, that is 148 of 7,207 (2.1%). The highest cell is Sol on **off**, 19 of 500 (3.8%). No cell is above twice the pooled rate, so the plan's extra labelling of disagreements didn't trigger. Matrices are in [judge-check.json](2026-11-20-longmemeval-redis-harness/judge-check.json) and, under the original parse, [judge-check-first-word-parse.json](2026-11-20-longmemeval-redis-harness/judge-check-first-word-parse.json).

## What changed from the plan, and what went wrong

- **The on arm turns autocut on explicitly** (amendment, before any pilot read). gbrain ships autocut off in every search mode, so `query {limit: 10}` as first planned cut nothing. **on** became `{limit: 10, autocut: true}`, and the question became "would turning autocut back on cost answers?"
- **The judge parse gained a last-line fallback** (amendment, before any counted unit), as above.
- **The build moved from v0.60.748.0 to v0.60.752.0** (amendment, before any counted unit). The pilot ran on 748 and stays development data; the counted run was frozen on 752. Against the 748 freeze, the same five conversations came back on 470 of 500 questions for **off**, 489 for **on** and 491 for agent-default; the differences are the reranker's call-to-call noise.
- **Second-half judgments are recorded under arm ids of their own** (amendment, during the run). It changes no judge, prompt or number.
- **The interim look came early.** The plan said to look once every cell had answers and both judgments for questions 1 to 250. The look was taken when Opus, Sol and gpt-4o had finished that half and before particle-1's first half ran, since particle-1 waits for its own paid window. The look reads only Opus's cells, which were complete, so its z is unchanged, but the timing broke the plan's wording. particle-1's first half then ran all four arms, **on** included.
- **The values the plan said to append before counted units went into the pilot report instead.** The share of questions whose **off** and **on** contexts differ (359 of 500), the pilot's detectable differences (3.6 points for the primary; Sol 3.6 for off against on and against oracle, undefined against full; gpt-4o 4.4, 5.6 and 3.6) and the judge check were reported to the run's owner before the counted wave, not added to the plan as a dated amendment.
- **on is not a strict prefix of off on 35 of 500 questions.** The two arms are separate `query` calls, and the reranker's scores vary slightly between calls; the plan expected the prefix to hold on every clean question.
- **Parity with Redis's runner** passed on every arm: the runner's messages matched ours byte for byte on 3 questions per gbrain arm and on all 500 oracle questions. For agent-default the runner's own retrieval matched the frozen one on 0 of 3 questions (passage-level reranker noise), so its parity check compared the runner's messages with our rendering of the runner's retrieval, as the plan's amendment allows.

## What this can and can't say

It can say how gbrain's newest release scores on Redis's open harness with Redis's reader and judge, next to Redis's published number; that forcing autocut on at limit 10 costs Opus answers by more than the detectable difference; and how far four readers get with gbrain's retrieval, with the whole history and with perfect evidence. It can't say that gbrain ranks above or below Redis (one published aggregate, no paired outputs), anything about held-out data, or anything about gbrain settings it doesn't vary.

## Reproduce and inspect

Everything below reads committed files and calls no provider.

```bash
bun eval/runner/batch/lme-redis-extras.ts --dir docs/benchmarks/2026-11-20-longmemeval-redis-harness
```

- [summary.json](2026-11-20-longmemeval-redis-harness/summary.json) and [interim.json](2026-11-20-longmemeval-redis-harness/interim.json): the preregistered statistics and the one look, from `bun eval/runner/batch/lme-redis-report.ts interim|final` on the run machine.
- [rows.ndjson.gz](2026-11-20-longmemeval-redis-harness/rows.ndjson.gz): every reader × arm × question with the answer, both verdicts, Redis's parse of the cross-family reply, delivery counts and the context's sha256.
- [retrieval.jsonl.gz](2026-11-20-longmemeval-redis-harness/retrieval.jsonl.gz) and [pilot-retrieval.jsonl.gz](2026-11-20-longmemeval-redis-harness/pilot-retrieval.jsonl.gz): the counted freeze on 752 and the pilot's on 748, with each query's parameters, ranked conversations and reranker record.
- [reader-tokens.ndjson.gz](2026-11-20-longmemeval-redis-harness/reader-tokens.ndjson.gz): token counts, finish reason and served model per reader request.
- [extras.json](2026-11-20-longmemeval-redis-harness/extras.json): the descriptive rows, from [lme-redis-extras.ts](../../eval/runner/batch/lme-redis-extras.ts).
- [order.json](2026-11-20-longmemeval-redis-harness/order.json), [runs.json](2026-11-20-longmemeval-redis-harness/runs.json) and [parity.json](2026-11-20-longmemeval-redis-harness/parity.json): the seed-42 question order, the budget run ids and the runner parity check.

**Receipts.** The counted first half ran from results-branch commit `5e03dd65`, the second half's readers from `196ad2ad` and its judges from `652605b9`. Before the final report, the run machine's copies of `lme-redis.ts` and `lme-redis-report.ts` were brought to the contents of `6a619268` and `4d7a47e6` in place; their sha256 match those commits. Batch requests went through this repository's batch lane at half the list price, and particle-1 through the shared metered client, under one budget ledger with a cap per stage.

## Changelog

### 2026-11-21: First publication

Results of the preregistered run: the stopped autocut primary, the 11 secondaries, the two published references, the judge check, the descriptive rows and the departures from the plan.

## Disclosures

- gbrain is Garry Tan's own project.
- Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.
- Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.
