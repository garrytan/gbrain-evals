# Take grading: gpt-6.1-sol may grade a take; Opus 5.5 and Sonnet 5.5 are rarely confident enough

**Measured October 16, 2026, at gbrain [`d99b84694`](https://github.com/garrytan/gbrain/commit/d99b84694e559333051b4944c5c3d2428df4c8df) (branch `capy/w6-take-grading`, wave 4b W6, judge prompt `hybrid-evidence-v2`), the commit that froze the [preregistration](2026-10-16-take-grading-preregistration.md).**

**Shipped in gbrain v0.60.282.0** ([#6882](https://github.com/garrytan/gbrain/pull/6882), merge commit `4e698e9d9`, recorded in [`verdict.json`](2026-10-16-take-grading/verdict.json)).

[gbrain](https://github.com/garrytan/gbrain) keeps a person's forecasting takes ("Acme-example will reach $5M ARR by the end of 2024") as rows on their pages. The dream cycle's `grade_takes` phase walks unresolved takes old enough to have played out, retrieves dated evidence from the brain, and asks a chat model for a verdict (`correct`, `incorrect`, `partial` or `unresolvable`) with a confidence. Auto-resolve, which would write a verdict onto the take, is off. This experiment measures what turning it on would risk: among the verdicts the rule would apply (not `unresolvable`, confidence at least 0.95), how many are wrong?

## The finding

- **gpt-6.1-sol qualifies.** It applied 496 verdicts on the 750 takes in the rule and none was wrong: the one-sided 95% upper bound on its wrong share is 0.6%, under the preregistered 1%. It gave the gold verdict on every one of the 750, held back on all 250 takes the evidence cannot settle (before the horizon, before the claim, no evidence, a restatement, a look-alike company, a real-world proposition with no evidence), and applied 99.2% of the 500 it could resolve. $0.0016 a verdict, 2.4 s at the median.
- **Opus 5.5 is right but not confident.** It gave the gold verdict on all 500 resolvable takes and held back on every unresolvable one, but at a confidence of 0.95 or more on only 2, so the rule applies almost nothing it says (coverage 0.4%). It does not qualify on 2 applied verdicts.
- **Sonnet 5.5 made one applied mistake.** It applied 121 verdicts and one was wrong: a real-world proposition with no evidence in the brain (a crewed Moon landing before 2025) that it graded from its own knowledge. Upper bound 3.9%; it does not qualify. Below the threshold it also called 13 pre-horizon takes `incorrect`.
- **So gbrain's `GRADE_TAKES_MEASURED_MODELS` is `openai:gpt-6.1-sol`**, for verdicts asked with prompt `hybrid-evidence-v2`. In this release the list only marks, in `gbrain takes grades`, which cached verdicts a measured judge gave; auto-resolve stays unwired.

## The experiment

**Code under test.** gbrain `d99b84694`: each fixture becomes the production take row and evidence block (`formatEvidenceBlock`), and the verdict comes from `defaultJudge` in `src/core/cycle/grade-takes.ts`: the production prompt, one gateway `chat` call with the production options (600 output tokens, no fallback model, no thinking setting) and the production parser. The harness wraps the call only to read token usage.

**Fixtures.** 908 seeded synthetic takes with placeholder names ([`fixtures.jsonl`](2026-10-16-take-grading/fixtures.jsonl), sha256 `fc902faa…`): dev 118, never counted, and counted 790. Of the counted, 750 enter the rule (250 resolved correct, 250 resolved incorrect, and 250 unresolvable across six sets) and 40 are exploratory (20 `partial`, 20 `world_counterfactual`). Each take states a horizon, and each evidence hit is dated against the take's date and that horizon. The `world_*` sets use public propositions (prices, rates, events) that name no person or company. Evidence is given, not retrieved, so this measures the judge, not the retriever.

**Runs.** One run per model over the counted split, 2,370 verdicts, $9.25 in all (Opus 5.5 $5.49, Sonnet 5.5 $2.53, gpt-6.1-sol $1.23) against the $25 counted cap. No run hit its per-model cap. Two dev rounds before the freeze ($2.87) shaped the prompt and parser; their rows are in [`results/dev/`](2026-10-16-take-grading/results/dev/).

## Results

| Model | Applied | Wrong applied | Upper 95% | Coverage | Abstention | No answer | USD per verdict | Latency p50 / p95 | Bar |
|---|---|---|---|---|---|---|---|---|---|
| `openai:gpt-6.1-sol` | 496 | **0** | **0.6%** | 99.2% | 100% | 1 | $0.0016 | 2.4 s / 3.2 s | meets |
| `anthropic:claude-sonnet-5-5` | 121 | 1 | 3.9% | 24.0% | 99.6% | 14 | $0.0032 | 1.7 s / 4.5 s | misses |
| `anthropic:claude-opus-5-5` | 2 | 0 | 77.6% | 0.4% | 100% | 3 | $0.0069 | 2.7 s / 4.9 s | misses |

Coverage is resolvable takes applied and right, over 500. Abstention is unresolvable takes not applied, over 250. Per set, as the models answered (applied first, then every verdict):

| Set (n) | gpt-6.1-sol | Sonnet 5.5 | Opus 5.5 |
|---|---|---|---|
| resolved correct (250) | 247 applied; correct 250 | 40 applied; correct 244, incorrect 1, no answer 5 | 0 applied; correct 250 |
| resolved incorrect (250) | 249 applied; incorrect 250 | 80 applied; incorrect 250 | 2 applied; incorrect 250 |
| pre-horizon (60) | unresolvable 60 | unresolvable 46, incorrect 13, partial 1 | unresolvable 53, incorrect 5, partial 2 |
| pre-claim (40) | unresolvable 40 | unresolvable 40 | unresolvable 40 |
| no evidence (40) | unresolvable 40 | unresolvable 40 | unresolvable 40 |
| restatement (40) | unresolvable 40 | unresolvable 40 | unresolvable 39, incorrect 1 |
| look-alike company (40) | unresolvable 40 | unresolvable 29, incorrect 6, correct 2, no answer 3 | unresolvable 40 |
| real-world, no evidence (30) | unresolvable 30 | **1 applied, wrong**; unresolvable 18, incorrect 10, correct 1, no answer 1 | unresolvable 30 |

**Exploratory sets.** On `partial` (a stated target missed by a margin, gold `partial`), every model answers `incorrect`: gpt-6.1-sol 18 of 20, applied at 0.96 or more; Sonnet 5.5 19, 4 applied; Opus 5.5 19, none applied. That is a grading-policy question (is a missed target `partial` or `incorrect`?) to settle before any auto-resolve, not a model error. On `world_counterfactual` (the brain's dated note contradicts the real outcome), gpt-6.1-sol applied all 20 verdicts on the brain's evidence; Sonnet 5.5 and Opus 5.5 applied none, and several of their reasonings say the note conflicts with what they know.

**No answer.** 18 of 2,370 verdicts did not parse. 12 (Sonnet 5.5 9, Opus 5.5 3) used the whole 600-token output ceiling and left a short or empty visible answer, so those models spend the ceiling on thinking. Four were Sonnet 5.5 JSON with a stray trailing `,"}`, one was gpt-6.1-sol JSON missing its closing brace, and one was a Sonnet 5.5 answer that corrected itself from `incorrect` to `correct`, which the parser rejects by design. Production retries an unparsed answer on the next cycle, so these cost coverage, never correctness.

## What this means for gbrain

The judge gbrain should trust for take grading is gpt-6.1-sol: on clean evidence it never applied a wrong verdict and resolved nearly everything resolvable, at the lowest cost. The Anthropic models read the evidence about as well (Opus 5.5 matched every gold verdict on resolvable takes) but report lower confidence, so under a 0.95 threshold they grade almost nothing on their own; a lower threshold or the existing three-judge ensemble rule would be a new preregistration. Before auto-resolve is ever wired, two things this does not settle remain: how the judge does on a real brain's messier evidence (a real-sample check), and whether a missed target should resolve `incorrect` or `partial`.

## Follow-ups for auto-resolve (decided 2026-10-16)

Garry approved these on October 16, 2026, through GBRA-108. They bind the eventual auto-resolve PR, and none of them changes code today, because auto-resolve is unwired.

- **Auto-resolve is a later opt-in PR**, built only after a real sample passes. The sample is about 300 graded takes from a real brain, the size needed to back a 1% error claim.
- **A missed numeric target is never auto-applied.** If a take's numeric target was missed by a margin (the exploratory `partial` set's shape), auto-resolve applies neither `partial` nor `incorrect`. The take is held for manual review until the real sample settles which verdict is right. All three models answered `incorrect` on that set, and gpt-6.1-sol did so at 0.96 confidence or higher, so this is a policy question, not a confidence threshold.
- **The measured judge is scoped to its prompt.** `GRADE_TAKES_MEASURED_MODELS` (gpt-6.1-sol) covers only verdicts asked with prompt `hybrid-evidence-v2`. A new prompt version needs a new measurement.
- **Proposed for the next preregistration, not decided:** giving the judge call a thinking setting or a larger output ceiling (12 of the 18 unparsed answers ran out of tokens while thinking), and tolerating a trailing `,"}` when parsing.

## Reproduce

```bash
# In gbrain, at d99b84694 or later on the W6 branch, Bun 1.4.3:
bun evals/take-grading/harness.ts --check
bun evals/take-grading/harness.ts --model openai:gpt-6.1-sol --split counted --out results/gpt-6.1-sol.jsonl --max-usd 3 --preregistration d99b84694
bun evals/take-grading/harness.ts --score results/*.jsonl --json summary.json --md summary.md
```

## Limits

Synthetic takes written by the agent that ran the experiment, with placeholder names, short evidence hits and clean dates; a real brain's evidence is longer, noisier and often undated. gpt-6.1-sol is at the ceiling of these fixtures on every set in the rule, so they cannot rank it further or show how it fails. Evidence retrieval is not measured. One run per model gives no run-to-run spread. The two dev rounds ran on the dev split before one fixture regeneration (progress hits placed before an early achievement); dev rows are context only. Records: per-verdict rows with each model's reasoning, `summary.json`, `summary.md` and `verdict.json` in [`2026-10-16-take-grading/`](2026-10-16-take-grading/).
