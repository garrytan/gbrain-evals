# Preregistration: Cat 20 brainstorm ideas scored by four frontier judges, with reasons (W7)

Written 2026-10-06, before any generation or judging call of this experiment. Plan: [W7 in the 2026-10 follow-up round](../plans/2026-10-06-followups-round/PLAN.md). Results go to [`2026-10-06-cat20-judges/`](2026-10-06-cat20-judges/).

## Question

Are gbrain's brainstorm ideas weak, or was the one judge harsh? On 2026-10-02 Cat 20 failed its judge floor: Claude Haiku 4.5 rated the ideas 1.17 of 5 on average against a 2.5 floor, with Claude Sonnet 4.6 generating. That run stored no idea text and no judge reasons, so the cause cannot be recovered; it links to this run by its aggregate only. This run stores every idea and every judge's reason, and has all four current frontier judges score every generated idea.

## Evidence class

Development evidence. Synthetic-v1 and the three Cat 20 questions have been used before; the judge rubric is the Cat 20 novelty and usefulness rubric. Nothing here is a held-out confirmation.

## Build and data

gbrain `c5fb0201d1960a0a5a81c35d77718311b03154b7` (v0.60.95.0) from `node_modules/gbrain`; `eval/runner/cat20-brainstorm.ts` at the commit that adds this file; synthetic-v1 (240 pages, committed); the three questions in `QUESTIONS_DEFAULT`; embeddings `openai:text-embedding-3-large` at 1,536 dimensions; retrieval pinned to `balanced` with the reranker and query expansion off.

## Arms

**Generation.** `runBrainstorm` with gbrain's `brainstorm` profile (4 close pages from search, 6 far pages from the domain bank, 3 ideas per close-far pair, so up to 72 ideas per question and 216 in all), with `anthropic:claude-sonnet-5-5` as the generation model and, through gbrain's model precedence, as its internal judge, which decides each idea's `passes` flag. Provider-default temperature and gbrain's own output limits. Results describe Sonnet 5.5 as generator, not gbrain's default chat model (`claude-sonnet-4-6`). One generation pass; nothing is regenerated.

**External judges**, each scoring every generated idea, passing and rejected, blind to the internal judge's verdict and scores and to the other judges: `anthropic:claude-sonnet-5-5`, `openai:gpt-6.1-sol`, `anthropic:claude-opus-5-5`, `anthropic:claude-fable-5-1`, through gbrain's gateway `chat()`. One call per judge per close-far pair (the 3 ideas that share those two pages), prompt `cat20-idea-judge-v1` (in `buildIdeaJudgePrompt`): the question, the first 1,500 characters of each cited page, the ideas, and two 0 to 5 integer scales, novelty and usefulness, with a one- or two-sentence rationale per idea, as JSON. An idea's overall score is the mean of its two scales. Output limit 4,000 tokens per call; provider-default temperature and reasoning effort.

The degraded arm (generation over a sentence-shuffled corpus) is W8's Cat 20 negative control and is preregistered there.

## Metric and denominator

Per judge: mean overall score on the ideas the internal judge passed (primary), on rejected ideas and on all ideas; the passing-minus-rejected gap; judge errors. Across judges: pairwise Spearman correlation and mean absolute difference on ideas both judges scored; how many judges' passing means reach 2.5. Intervals: 95% cluster bootstrap over generation contexts (question plus close and far page; up to 72 clusters), seed 20261006, 10,000 draws. Also reported: grounding (the runner's existing in-text citation score), idea and passing counts per question, wall time, spend.

Errors: an unparseable reply, a missing idea or an out-of-range score is retried once; still bad, it is a judge error for those ideas. A reply cut at the output limit is a judge error with no retry. Judge errors are counted and excluded from that judge's means, never scored 0. A brainstorm call that throws or returns no ideas is a generation error for that question (the runner's existing rule: scored 0 for grounding, kept in the denominator).

## Decision rule

**Cat 20 passes when the median of the four judges' mean overall scores on passing ideas is at least 2.5.** It is **inconclusive** when fewer than 10 ideas pass. The 2.5 floor is the existing Cat 20 floor. This is one statistic and one decision, so there is no multiple-comparison correction; the per-judge intervals and agreement statistics are descriptive. A judge whose error rate exceeds 20% is reported, and the median is taken over the remaining judges, stated as such.

Minimum detectable effect: not a hypothesis test. With about 100 to 200 passing ideas in about 60 clusters, a judge's mean has a cluster-bootstrap interval of roughly plus or minus 0.2 to 0.3, so a median within about 0.25 of 2.5 is reported as close to the floor.

## What each outcome changes

| If it wins | If it loses | If inconclusive or at the ceiling |
|---|---|---|
| The median of the four judges' means is at or above 2.5: Cat 20 passes and its failure note closes | Cat 20 stays failing, now with reasons; a gbrain issue if judges agree the ideas are weak | Judges disagree: report the spread; Cat 20 stays report-only |

"Judges disagree" here means the four judges' passing means straddle 2.5 with at least one on each side and the median within 0.25 of the floor, or fewer than 10 ideas pass.

## Budget

Ledger `/workspace/gbrain-evals/.budget/followups-2026-10.sqlite`, budget run `cat20-brainstorm`, `--budget-usd 12` (the plan's W7 cap); every generation and judging request goes through the ledger's paid-request guard in-process. Estimate about $7: generation about $1, judging about $6 (72 calls per judge: Fable about $3.20, Opus $1.30, Sonnet and GPT about $0.65 each). If actual spend runs past $10 (25% over the $8 plan estimate), the report says so; the cap refuses anything past $12, and an arm cut off by the cap is published as **Partial**.

Runner: `bun eval/runner/cat20-brainstorm.ts --model anthropic:claude-sonnet-5-5 --idea-judges anthropic:claude-sonnet-5-5,openai:gpt-6.1-sol,anthropic:claude-opus-5-5,anthropic:claude-fable-5-1 --preregistration docs/benchmarks/2026-10-06-cat20-judges-preregistration.md --budget-ledger <ledger> --budget-usd 12`. Keyless re-score: `bun eval/runner/cat20-judges.ts <receipt.json>`.

## Amendments

### 2026-10-07: Fable 5.1 is smoke-only

On 2026-10-07 Garry set a new eval model rule: Claude Opus 5.5 is the top Anthropic model in counted runs, and Claude Fable runs only in small smoke tests, never in counted cells (gbrain project instructions, "Eval model selection"). This amendment is recorded after the run, under that rule. The finished `claude-fable-5-1` judge scores stay in the receipt as recorded, labeled smoke-only, and are not counted toward the decision. The deciding statistic becomes the median of the three counted judges' means (`claude-sonnet-5-5`, `gpt-6.1-sol`, `claude-opus-5-5`): 3.14 on all 216 ideas, against 3.17 for the preregistered four-judge median. The decision is unchanged either way: no idea passed the internal judge, so the passing-idea statistic is undefined and the preregistered outcome is "inconclusive". No further Fable cell runs.
