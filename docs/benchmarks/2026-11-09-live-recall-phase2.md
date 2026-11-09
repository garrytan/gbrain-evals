# Live recall phase 2: gbrain's read tools turn questions about Garry's notes into right answers, and a summarising helper costs grounded ones

- **We learned that gbrain's own read tools turn questions about Garry's notes from mostly "I don't know" into mostly
  right answers. Give your agent gbrain's `query`, `search` and `get_page` tools.** On paraphrased questions,
  claude-opus-5-5 answers 13.3% correctly with no retrieval and 86.7% with gbrain's tools, on the 98 tasks both setups
  completed. That's a gain of 73.5 points, with a 95% interval of 63.9 to 82.5 (the range the true gain most likely
  falls in) and a Holm-adjusted p below 0.0001 (the chance of a gap this large with no real effect, corrected for
  testing four things at once). particle-1 goes from 9.3% to 68.0%, a gain of 58.8 points (48.5 to 68.8, Holm-adjusted
  p below 0.0001). That is P1, and it holds for both models. No task got worse.
- **We learned that a summarising helper between gbrain and the answering model buys no extra correct answers and makes
  the citations less trustworthy. Let the model that answers call gbrain itself.** With the helper, the share of answers
  that are correct and cite only pages that support them falls by 14.3 points for claude-opus-5-5 (68.4% to 54.1%,
  interval −22.1 to −6.3, Holm-adjusted p 0.0026) and by 14.4 points for particle-1 (54.6% to 40.2%, −25.0 to −4.1,
  Holm-adjusted p 0.0125). That is P2, and it holds for both models against the helper. Plain correctness doesn't move:
  −3.1 points for Opus (−9.2 to 3.0) and 0.0 for particle-1 (−8.3 to 8.0). Neither is a measurable difference; the
  smallest each could reliably detect was 8.6 and 11.6 points.
- **We learned that one search with the top five pages pasted in answers far fewer questions than letting the model
  search. Let the model search, rather than pasting a fixed top five.** On the 96 paraphrased tasks both setups completed, Opus answers 52.1% from five pasted pages and 86.5% with
  the tools, 34.4 points fewer (−45.5 to −23.6; a descriptive comparison, outside the preregistered four).

particle-1 with gbrain's tools answers 68.0% (58.5 to 77.5) against Opus's 86.7% (78.8 to 93.8), 18.7 points lower,
at $0.0515 of answer cost per correct answer against Opus's $0.1284.

We recommend giving agents gbrain's read tools directly on a brain like this one. The helper result is evidence
against a summarising helper for Opus and particle-1 here; for gpt-6.1-sol it made no measurable difference (+5.1 on
correct and grounded, smallest detectable 10.8). This is one run on one brain, with tasks written by one agent and only
from pages a remote agent may open. The [limits](#limits) apply to every number here.

## What we measured

Measured on 2026-11-09 between 15:03 and 18:13 UTC, on the server that holds Garry Tan's own gbrain, under the
[phase 2 preregistration](live-recall/PHASE2-PREREGISTRATION.md). The 99 tasks were frozen by 11:37 UTC, before any
model saw them. The runner was gbrain-evals
[4740c1f3](https://github.com/garrytan/gbrain-evals/commit/4740c1f35f85d2661b149a88cfd8127c00dc005c), with the harness
digest `d27425cc…1e18` the preregistration names. The gbrain under test was 0.60.613.0 at `98dda48fb9fd`, loaded as a
verified overlay; the box's own install was 0.60.618.0, which changes no search, tool or access code
([why that's fine](live-recall/PHASE2-PREREGISTRATION.md#differences-from-the-approved-plan)). The preregistration's pin
was 0.60.557.0 at `62637c96a`; gbrain-evals has since moved its pin to 0.60.623.0 at `d253ec0ff`, which this run didn't
test. The rest of the setup: Postgres schema 296, search mode `tokenmax`, embeddings
`voyage:voyage-4` and reranker `voyage:rerank-2.5`.

gbrain is a personal knowledge brain: Markdown pages in Postgres, found with keyword, vector and hybrid search, and
served to agents as tools. Wintermute, the agent that runs on Garry's box, wrote each task from a real page in the brain,
with a gold answer of one to four facts. It ran this harness against the live brain through a database role that cannot
write, and sent back aggregate scorecards. Phase 2 sent the task text and page text from the brain to Anthropic, OpenAI
and Particle through their APIs, and sent Wintermute's gold answers and the models' answers to the judge models at
OpenAI and Anthropic, under the consent Garry gave for this eval
([preregistration](live-recall/PHASE2-PREREGISTRATION.md#privacy-posture)). gbrain's own search also sent search
queries and candidate passages to Voyage AI, the brain's configured embedding and reranking provider. Only aggregates
came back to us, and none of phase 2's task text, answers or page text is in this repository.

> **Correction, 2026-11-09.** The first version of this page said that no task, answer, page text or slug left the box.
> The paragraph above now says what phase 2 sent to each provider.

## The concrete case

An invented example, with the same shape as the real tasks. The gold page is a meeting note from last spring. The exact
form uses the page's own words: "What did the March offsite notes say the pricing review would be replaced by?" The
paraphrase asks for the same fact without them: "After the spring team retreat, what took the place of the plan to
re-examine what we charge?" The gold answer is the fact the page states, and a correct answer must contain it without
contradicting anything else on the page.

Each task goes to each model four ways:

- **A, no retrieval.** The model is told Garry's notes aren't available and answers from what it knows.
- **B, gbrain's tools.** The model gets gbrain's own `query`, `search` and `get_page` tools, decides what to look
  up and cites the pages it used.
- **C, a summarising helper.** A first call with B's tools writes a cited summary of at most 300 words. A second call,
  with no tools, answers from the question and that summary alone. This is the "agent in the middle" some retrieval
  designs put in front of the answering model.
- **D, top five pasted.** The harness runs one gbrain search on the question, opens the first five distinct pages, and
  pastes up to 8,000 characters of each in front of the model. No tools.

## The experiment

- **Tasks.** 99 tasks in five types of 19 or 20: `topic`, `identifier`, `error_string`, `time_window` and
  `cross_source`. Each has an exact and a paraphrased form. 37 come from phase 1's questions and 62 were written
  after the first freeze to replace questions whose gold pages a remote agent may not open. Tasks that share a gold
  page form one gold cluster, and there are 87; every interval and test treats a cluster as one unit. The freeze is
  recorded in the [preregistration](live-recall/PHASE2-PREREGISTRATION.md#frozen-sample).
- **Models.** claude-opus-5-5 and particle-1 are the primary models; gpt-6.1-sol is descriptive. All ran at effort
  medium, in the same agent loop, with at most 12 turns.
- **Grading.** A judge from another family grades each answer against the gold answer and the cited pages as they were
  when the model answered: `gpt-6-astra` grades claude-opus-5-5 and particle-1, and claude-opus-5-5 grades gpt-6.1-sol.
  An answer is correct when every required fact is present and none is contradicted. It is grounded when it cites at
  least one page and every cited page supports it.
- **Comparisons.** Four preregistered primaries on the paraphrase form, corrected together with Holm's method: B minus A
  on correct, and C minus B on correct and grounded, each for claude-opus-5-5 and particle-1. Everything else is
  descriptive.
- **Custody.** The role was proven read-only before the first read and again at the end. gbrain's own best-effort writes
  (12,059 inserts and about 4,000 other writes, telemetry and session settings among them) were refused and counted,
  as designed. No other model call reached gbrain.

## Results

### The primary models, paraphrase form

| Setup | Model | Correct % (95% CI) | Correct and grounded % | Answer cost per correct |
|---|---|---|---|---|
| A, no retrieval | claude-opus-5-5 | 13.1 (7.0 to 20.4), n=99 | n/a | $0.0646 |
| A, no retrieval | particle-1 | 9.1 (4.0 to 15.2), n=99 | n/a | $0.0069 |
| B, gbrain tools | claude-opus-5-5 | 86.7 (78.8 to 93.8), n=98 | 68.4 (58.6 to 78.1) | $0.1284 |
| B, gbrain tools | particle-1 | 68.0 (58.5 to 77.5), n=97 | 54.6 (44.1 to 65.3) | $0.0515 |
| C, summarising helper | claude-opus-5-5 | 83.8 (76.7 to 90.6), n=99 | 53.5 (42.9 to 64.1) | $0.1454 |
| C, summarising helper | particle-1 | 68.4 (59.6 to 77.3), n=98 | 40.8 (31.7 to 50.5) | $0.0575 |
| D, top five pasted | claude-opus-5-5 | 52.6 (41.9 to 64.1), n=97 | 48.4 (37.8 to 59.8) | $0.1455 |
| D, top five pasted | particle-1 | 50.5 (40.0 to 61.9), n=97 | 47.4 (37.1 to 58.7) | $0.0055 |

Answer cost counts the answering calls (and C's helper), priced from each response's usage at list prices; judging is
not included. An episode whose gbrain search failed is excluded, at most two of 99 in any row, which is why n varies.

### Preregistered comparisons

| Comparison | Pairs | First | Second | Difference (95% CI) | Tasks worse | Holm p | Reading |
|---|---|---|---|---|---|---|---|
| B minus A, correct, claude-opus-5-5 | 98 | 13.3 | 86.7 | +73.5 (63.9 to 82.5) | 0 | below 0.0001 | B above A |
| B minus A, correct, particle-1 | 97 | 9.3 | 68.0 | +58.8 (48.5 to 68.8) | 0 | below 0.0001 | B above A |
| C minus B, correct and grounded, claude-opus-5-5 | 98 | 68.4 | 54.1 | −14.3 (−22.1 to −6.3) | 16 | 0.0026 | C below B |
| C minus B, correct and grounded, particle-1 | 97 | 54.6 | 40.2 | −14.4 (−25.0 to −4.1) | 21 | 0.0125 | C below B |

The minimum detectable differences at 87 clusters, with 20% of pairs discordant, were 13.4 points at alpha 0.05 and 16.0
at Holm's tightest level. All four primaries clear their tests.

### Descriptive comparisons

| Comparison | claude-opus-5-5 | particle-1 | gpt-6.1-sol |
|---|---|---|---|
| B minus A, correct, exact form | +64.6 (54.7 to 74.0) | +74.8 (66.0 to 83.2) | +70.4 (60.8 to 79.4) |
| B minus A, correct, paraphrase | primary | primary | +63.6 (53.9 to 72.8) |
| C minus B, correct, paraphrase | −3.1 (−9.2 to 3.0) | 0.0 (−8.3 to 8.0) | +5.1 (−2.1 to 12.2) |
| C minus B, correct and grounded, paraphrase | primary | primary | +5.1 (−3.1 to 12.4) |
| C minus B, correct and grounded, exact form | −5.1 (−12.8 to 2.2) | −12.1 (−22.7 to −1.1) | −5.1 (−12.9 to 2.1) |
| D minus B, correct, paraphrase | −34.4 (−45.5 to −23.6) | −17.9 (−29.2 to −6.6) | −29.9 (−41.2 to −18.4) |
| D minus B, correct, exact form | −17.5 (−28.2 to −6.6) | −23.7 (−34.7 to −12.8) | −26.0 (−36.3 to −15.9) |

Every cell, with abstentions, confident errors and exposure, is in the [scorecard](2026-11-09-live-recall-phase2/scorecard.md).

### What the numbers show

- **Without retrieval, the models mostly say they don't know.** In A they abstain on 82% to 90% of paraphrased tasks.
  gpt-6.1-sol is the most often confidently wrong, at 9.1% against 2.0% for Opus and 1.0% for particle-1.
- **Opus answers from search results and rarely opens the page.** With gbrain's tools, a gold page appears in the search
  results for 86% of Opus's paraphrase episodes, Opus opens it in 28% and cites it in 83%. gpt-6.1-sol and particle-1
  open it in 72%. gbrain's `query` returns the matching passages, and for Opus those were usually enough.
- **particle-1 works harder for its answers.** It makes 9.6 tool calls per paraphrase episode with the tools, against 3.5
  for Opus and 4.3 for gpt-6.1-sol, and takes a median 26 seconds against 17 for Opus and 18 for gpt-6.1-sol.
- **Pasting finds the page more often than it yields the answer.** D's one search pasted a gold page for 64% of
  paraphrases, and the models answered 42% to 53% of them correctly; Opus abstained on 38%. A model with tools
  searches again when the first results miss: a gold page reached its search results in 86% to 94% of episodes.
- **gpt-6.1-sol is the most often confidently wrong in every setup.** With gbrain's tools it gives a wrong answer
  without hedging on 21.2% of paraphrases, against 9.2% for Opus and 14.4% for particle-1, and on 38.1% when answering
  from pasted pages.
- **The helper cites more and checks less.** C's answering call never sees the pages; it cites what the summary cites.
  Opus's answers cite 3.0 pages through the helper against 2.3 directly, and the share of citations that support the
  answer falls from 89% to 83%. A single unsupported citation makes an answer ungrounded, so grounding drops while
  correctness holds. With particle-1, the answering call also abstains more often (19.4% against none).

### Original and replacement tasks

Both groups show the same direction, descriptively, without Holm. B minus A is +75.7 (60.0 to 89.5) for Opus on the 37
original tasks and +72.1 (59.7 to 83.6) on the 62 replacements; for particle-1, +67.6 and +53.3. C minus B on correct
and grounded is −10.8 (−24.3 to 0.0) and −16.4 (−26.7 to −6.7) for Opus, and −24.3 (−38.9 to −11.1) and −8.3 (−22.4 to
5.3) for particle-1. The groups differ in type: original against replacement tasks number 3 against 17 for topic,
13 against 6 for identifier, 19 against 1 for error_string, 2 against 18 for time_window and 0 against 20 for
cross_source. The scorecard has no results by task type, so this report gives none.

### Why the helper result is negative

Every negative result gets one check of exposure, task fit, power and whether the model manages without the part under
test, before it is reported.

- **Exposure.** The helper used the tools in every episode, saw a gold page in 84% (Opus) and 93% (particle-1) of them,
  and its summary cited a gold page in 80% and 70%. It found the evidence; the loss is in what the answer cites.
- **Task fit.** These are retrieval tasks of the kind a helper is meant to serve, and two in five need a date window
  or two sources.
- **Power.** Both drops pass Holm. On plain correctness the helper is within 3 points of B for both models (smallest
  detectable 8.6 and 11.6), and the interval rules out a gain larger than 3 points for Opus.
- **Without the tools.** Each model alone answers 9% to 13%, so the task needs retrieval.

Verdict: **keep.** The method measured what it set out to. The result stands as evidence against a summarising helper
in front of gbrain for these two models on this brain, and the preregistration's rule that a summary is charged for
the citations it hands on is what makes it visible.

### Judges

Before the run, a judge check answered the paraphrase form of 20 frozen tasks in every setup with every model, and
both labellers, gpt-6-astra and claude-opus-5-5 at effort high, graded the judged answers again (217 for correctness).
Where the two labellers agreed, each counted judge matched the labels every time: Cohen's kappa 1 on correct (143 labels for
Astra, 71 for Opus) and on correct and grounded (102 and 52), with no judge call cut off at its output limit. During
the run, claude-opus-5-5 also graded particle-1's paraphrase answers in B, C and D and agreed with Astra on 271 of 275
(kappa 0.97). Wintermute graded 30 judged answers blind to setup and model and agreed on 29.

## What to use and what to avoid

- **Use** gbrain's read tools, called by the model that answers, for questions about a person's own notes. On this
  brain it is the difference between 13% and 87% for Opus.
- **Prefer** letting the model search over pasting a fixed top five, especially for paraphrased questions.
- **Avoid** a summarising helper in front of gbrain when the answer's citations matter. It bought no extra correct
  answers here and cost 14 points of correct, grounded answers for Opus and particle-1.
- **Choose particle-1** when cost per correct answer matters more than the last 19 points: $0.0515 against $0.1284 on
  paraphrases, at 68.0% against 86.7%.

## Limits

- **One brain, one task writer.** Wintermute wrote the tasks and the gold answers from pages in Garry's brain, and
  Wintermute also uses gbrain. The tasks are not questions that once failed.
- **Only pages a remote agent may open.** At the first freeze, 60% of the first task file's gold pages carried
  `access: private`, stamped by Wintermute's own ingest, so they were replaced. The result covers what gbrain shows a
  remote agent, not what Garry's local CLI sees. 62 of 99 tasks are replacements chosen by type and reachability. A
  later gbrain change to how private pages are labelled and who may read them reached the box at 19:23 UTC, after the
  run, so the freeze and the run saw the same access rules.
- **cross_source mostly measures finding civic summary pages.** Its 20 tasks form 10 gold clusters, each from a media
  page to a short civic page summarising Garry's posts on one theme.
- **The judges check themselves.** Each counted judge is also one of its own labellers, so its perfect agreement with the
  labels partly measures agreement with itself at higher effort. The labellers' cross-family agreement (kappa 0.92 to 1)
  and the second judge are the stronger checks. Nobody on our side read a judged answer.
- **The live brain moves.** The run read the live database; brain HEAD moved between the freeze and the run, and four
  gold pages that opened at the first freeze turned private the same morning. No kept task lost a gold page by the run.
- **One trial per task.** Model randomness sits inside the comparisons. From each primary's own spread, its test had
  80% power for a difference of 11 to 15 points; smaller effects would not reliably show.
- **gpt-6.1-sol and the exact form are descriptive.**

## Reproduce and inspect

- **Scorecards.** [Markdown](2026-11-09-live-recall-phase2/scorecard.md) and
  [JSON](2026-11-09-live-recall-phase2/scorecard.json), the box's own output after the audit rescore, with the run's cap
  and spend fields removed by [redact-scorecard.ts](../../eval/runner/live-recall/redact-scorecard.ts). Cost per correct
  answer is kept, and the public JSON passes the runner's structural check (`validateTaskScorecard`). The task file,
  the run's records and gbrain's log are kept on Garry's box, not in this repository.
- **The runs.** [RUN-KIT.md](live-recall/RUN-KIT.md#phase-2) has the commands. The judge check ran
  `tasks.ts judge-check` and passed at 15:03 UTC; the counted run ran
  `tasks.ts run --tasks <file> --freeze <freeze.json> --gbrain /data/gbrain@98dda48fb9fd --judge-check <judge-check.json>`
  from 15:03 to 18:13 UTC, at concurrency 4, then `tasks.ts audit` and `tasks.ts score --audit-grades`.
- **Cost accounting.** The runner prices every model call from its own usage. Per model, those prices match the run's
  budget ledger to within 0.001%; the remaining difference is gbrain's embedding and rerank calls.
- **The harness control, keyless.** CI runs the same harness on the public
  [live-recall-v1 fixture](../../eval/data/live-recall-v1/README.md) with no keys.

## Not verified

- That the gold answers are right. Wintermute wrote them, and only its blind audit of 30 judged answers checks them.
- Results by task type, which the scorecard doesn't break out.
- Why the four gold pages turned private on the morning of the run; the brain's history shows when, not why.

## Disclosures

gbrain is Garry Tan's own project.

Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator.
Garry Tan runs Y Combinator.

Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.
