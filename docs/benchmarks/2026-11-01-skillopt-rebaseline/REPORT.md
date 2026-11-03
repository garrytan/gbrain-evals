# SkillOpt re-baseline, November 1, 2026

Measured on gbrain v0.60.531.0 (`3ec766c40`, the `package.json` pin) with the runner code at gbrain-evals `18186aea`. Target model `claude-haiku-5-5`, optimizer `claude-opus-5-5`. Run and written up in thread GBEV-24 (issue GST-799). [Preregistration](PREREGISTRATION.md), with two amendments written before the runs they affect.

## The finding

`gbrain skillopt` still repairs a skill with an obvious flaw. All four of the four practice skills improved on tasks held out from tuning, Cat 31's full loop scored 0.54 against the unedited skill's 0.00, and the optimizer's edits raised real quality on Cat 32's reward-hacking test (0.55 to 0.88) instead of gaming the easy score. A skill optimized on Haiku 5.5 or Sonnet 5.5 also helped the other model in all four Cat 33 pairs.

The iterative loop has not shown that it earns its cost. For the second time (June, and now), the full loop scored exactly what one rewrite by the same model scored: 0.54 against 0.54 on Cat 31, at $0.23 against $0.13 per run by gbrain's own estimate. On these tasks every edit that gbrain kept came from the loop's first step. Under Garry's rule for null results (R48) the iterative part of the loop is a **CUT-CANDIDATE**, and the "Why null?" section below gives the evidence. The practice skills are too easy to show what later steps could do, and two gbrain defects starve those steps, so this is a verdict on the loop as shipped at this pin, not proof that iteration cannot help. The [benchmark plan](#what-to-use-and-what-to-avoid) that follows this report is built to settle it.

Every number here is a new receipt identity. The judge, target and optimizer differ from June's (Haiku 4.5 target, Sonnet 4.6 optimizer), so nothing here pools with the [June 3 report](../2026-06-03-skillopt.md).

## The concrete case

A skill is a Markdown file that tells an agent how to do a job. One practice skill, `seed-missing-structure`, is a brief writer whose whole body says "write a short, clear research brief that answers the question. Keep it focused and readable. Lead with the answer." Its held-out tasks ask for briefs on questions such as "whether to deprecate a legacy API with active users" and score each brief with two rules: a `Key Risks` heading followed by real bullet points, and a line like `Confidence: Medium`. The skill never mentions either, so every model scores 0 with it, Claude Opus 5.5 included.

SkillOpt runs the agent on training tasks, shows a strong model what went wrong (including the plain-English criteria behind the rule checks), and asks for edits. It keeps an edit only if a separate selection set scores at least 0.05 higher, by the median of three runs per task. On this skill the first edit added a "Required structure" section naming the `## Key Risks` heading and the `Confidence:` line, and selection went from 0.00 to 1.00 in one step. The harness then scores the edited skill on its own six held-out tasks, three runs each. Those use stricter rules than the training tasks (bullets directly under the heading, a level after `Confidence:`), so a skill can be perfect on selection and still score 0.50 held out.

## The experiment and results

Four categories ran at their code defaults, with one change recorded in the preregistration before any counted run. The judge moved to a model outside the target's family (`gpt-6.1-sol`), and every receipt now carries each optimization's final skill text and gbrain's own run receipt (`skillopt_runs`). Cats 30, 31 and 33 use rule and retrieval judges only, so the LLM judge is active only in Cat 32. Every provider call went through the metering proxy (`eval/runner/metering-proxy.ts`), one slot per category, so costs below come from the providers' usage fields at list price.

### Cat 30: does a deliberately flawed skill improve on held-out tasks?

Two epochs, batch 5, split 1:1:1 of each 15-task benchmark, 6 held-out tasks × 3 runs.

| Practice skill (flaw) | Held-out before | Held-out after | gbrain's selection and test score, after | gbrain's cost estimate |
|---|---|---|---|---|
| `seed-missing-structure` (no Key Risks or Confidence) | 0.00 | **0.50** | 1.00, 1.00 | $0.231 |
| `seed-verbose` (asks for long essays; tasks cap length) | 0.50 | **0.75** | 1.00, 1.00 | $0.187 |
| `seed-no-brain-first` (forbids searching) | 0.00 | **1.00** | 1.00, 1.00 | $0.231 |
| `seed-no-verdict` (refuses to recommend) | 0.00 | **0.33** | 1.00, 1.00 | $0.165 |

All four improve by more than 0.05, so Cat 30 passes its bar (at least 3 of 4). Metered cost $0.75. gbrain's own test score reads 1.00 on every seed, while the harness's held-out score is 0.33 to 1.00. The held-out tasks use stricter rules, and gbrain shows its optimizer the criteria of its own test split (`orchestrator.ts:439`), so its internal test score overstates.

### Cat 31: which parts of the loop earn their cost?

`seed-missing-structure`, three epochs, two trials per configuration, held-out 6 tasks × 3 runs. The unedited skill scores 0.00.

| Configuration | Held-out (trials) | Mean | Selection (trials) | gbrain's cost estimate per run |
|---|---|---|---|---|
| A: full loop (both reflect calls, validation gate) | 0.58, 0.50 | **0.54** | 1.00, 1.00 | $0.23 |
| B: failure reflection only | 0.50, 0.50 | 0.50 | 1.00, 0.70 | $0.15 |
| C: one-shot rewrite (no loop) | 0.58, 0.50 | **0.54** | 1.00, 1.00 | $0.13 |
| D: no validation gate | 0.50, 0.50 | 0.50 | 1.00, 1.00 | $0.24 |

Cat 31 passes its preregistered bars: no errors, the full loop beats the unedited skill by 0.54 (bar 0.30), and the full loop is not below the ungated loop by more than 0.05. The paired bootstrap finds no evidence that the full loop beats one-shot (p = 1.00: the two trials differ by 0.00 each). Differences of 0.04 here are smaller than one task. Metered cost $1.30.

### Cat 32: can the judge and the held-out gate catch a skill that games the score?

Part A plants a known cheat (a skill that stuffs the easy rule's keywords) and an honest control. The cheat scores 1.00 on the gameable rule benchmark and 0.02 on the held-out quality judge (`gpt-6.1-sol`), a gap of 0.98. The honest control scores 0.97 and 0.90, a gap of 0.07. Part A passes (the cheat's gap must be at least 0.30 and the control's below 0.30).

Part B runs the optimizer against the gameable benchmark with the quality set as gbrain's held-out gate. Held-out quality rose from 0.55 to 0.88, with no regression, but the gate refused no candidate. The preregistered bar needs at least one refusal, so Part B is `partial` and the category verdict is `partial`. Metered cost $0.66.

### Cat 33: does a skill optimized on one model help another?

Two practice skills, each optimized on one model and scored on the other, in both directions between Haiku 5.5 and Sonnet 5.5. [Amendment 2](PREREGISTRATION.md) records the seed list and why `seed-no-brain-first` is not in it. Each pair compares three skills on the second model's 6 held-out tasks × 3 runs: the unedited seed, the skill optimized on the first model, and a skill optimized directly on the second model, which Cat 33 treats as the ceiling.

| Practice skill | Optimized on → scored on | Seed | Transferred | Optimized on the scoring model |
|---|---|---|---|---|
| `seed-missing-structure` | Haiku → Sonnet | 0.00 | **0.92** | 0.50 |
| `seed-missing-structure` | Sonnet → Haiku | 0.00 | **0.50** | 0.50 |
| `seed-no-verdict` | Haiku → Sonnet | 0.00 | **1.00** | 0.50 |
| `seed-no-verdict` | Sonnet → Haiku | 0.00 | **0.83** | 0.00 |

All four pairs transfer: each transferred skill beats the seed by more than 0.05 and sits inside the ratio band, so Cat 33 passes 4 of 4 (bar: at least 3). Metered cost $8.12, of which $6.75 is Sonnet rollouts; gbrain's own estimate was $10.33.

The ceiling column is not a ceiling. In three pairs the skill optimized on the other model scored higher than the one optimized on the scoring model, and in the fourth they tied. In the last row gbrain accepted its Haiku edit at a selection and test score of 1.00, but the edited skill scores 0.00 held out. The held-out rules are stricter than the training rules (the `Recommendation:` label must start a line, and the level must follow `Confidence:` directly), and that rewrite's wording did not get Haiku to meet them, while the Sonnet-optimized rewrite did. Each cell is one optimization scored on six tasks, so which wording a run happens to produce outweighs any difference between the models.

### The frontier check (added for R48)

[Amendment 1](PREREGISTRATION.md#amendment-1-2026-11-01-while-stage-1-ran-before-the-probe-it-adds-r48-frontier-check) added one probe: the four unedited skills scored on their own held-out tasks with `claude-opus-5-5` as the target, 2 runs per task, through the same `scoreSkillOnTasks` the categories use ([script](scripts/frontier-probe.ts), [receipt](receipts/frontier-probe-opus.json)).

| Practice skill | Haiku 5.5 (Cat 30 baseline, 3 runs) | Opus 5.5 (2 runs) |
|---|---|---|
| `seed-missing-structure` | 0.00 | 0.00 |
| `seed-verbose` | 0.50 | 0.50 |
| `seed-no-brain-first` | 0.00 | 0.00 |
| `seed-no-verdict` | 0.00 | 0.00 |

A frontier model does not fix these skills on its own: the gap is information missing from the skill text (which heading, which length, whether to search), not model ability. Metered cost $1.71.

### What the loop actually did

gbrain's step events are committed under [`audit/`](audit/). Nine runs used the validation gate with reflective edits: Cat 30's four seeds, Cat 31's configurations A and B (two trials each) and Cat 32 Part B.

- Every edit gbrain kept in those nine runs came from the first step.
- Selection reached 1.00 at the first step in 7 of the 9. gbrain accepts only a candidate that beats the best selection score by more than 0.05, so from then on no edit could be accepted.
- The 14 steps after the first produced a valid edit only twice, and the gate rejected both.
  - 8 steps had nothing because gbrain's success-reflection prompt never names the edit fields, so every edit it proposes is dropped (`reflect_success_invalid_edits: N proposed, 0 valid`). One Opus call through `runReflect` reproduces it ([script](scripts/repro-success-reflect.ts)).
  - 4 steps belonged to configuration B, which reflects only on failures, and had no failures left.
- In the two steps that did try edits, 3 and 4 edits were proposed and 1 was applied each time, under the step's learning-rate budget. gbrain still filed all of them as rejected, so 5 edits that were never tried are shown to later steps as "tried and didn't help".
- Of configuration D's two ungated runs, one kept a second edit; selection was already 1.00 and held-out stayed at 0.50.
- In Cat 32 Part B the held-out gate ran once, on the one candidate the selection gate accepted, which really was better. The next two steps had no valid edits. So the gate never saw a gaming candidate to refuse.

## Why null? (R48)

Each null or negative result gets one cycle: exposure (did the part under test actually run), task fit, power and saturation, and whether today's frontier model does the job without it.

| Result | Exposure | Task fit | Power and saturation | Frontier model | Verdict |
|---|---|---|---|---|---|
| The full loop ties a one-shot rewrite (Cat 31 today, 0.54 vs 0.54; June, 1.00 vs 1.00 at $0.98 vs $0.88) | Low. Every kept edit came at step 1, and later steps had no valid edits or could not pass the gate | Poor. Single-flaw skills whose missing rule the optimizer is shown; one edit fixes them | Saturated. Selection is at 1.00 after one step in 7 of 9 runs; 6 held-out tasks and 2 trials cannot separate 0.04 | Opus 5.5 with the unedited skill scores 0.00, same as Haiku, so the gain needs a rewrite, and one rewrite gets all of it | **CUT-CANDIDATE** for the iterative loop as shipped (steps after the first): twice it has not beaten one rewrite, and it costs about 1.8 times as much. The defects and the easy tasks are reasons it has not had a fair test; they are not evidence that it works |
| Success reflection adds nothing (Cat 31 A vs B) | None. Every success-reflection edit is dropped on format (gbrain defect 1), so A and B run the same algorithm | Not testable until the prompt is fixed | n/a | n/a | **FIX-METHOD** (gbrain): fix the prompt; until then it costs an Opus call per step for nothing |
| The validation gate shows no gain (Cat 31 A vs D, 0.54 vs 0.50) | Low. The gate judged two candidates after step 1 and rejected both; D kept one extra edit, which changed nothing held out | Poor, as above | Saturated, as above | n/a | **FIX-METHOD** (the test): the benchmark never gave the gate a bad candidate. It costs about 15 Haiku rollouts per candidate. gbrain should also stop a run once selection is at its ceiling |
| Cat 32 Part B: no held-out refusal | Low. The held-out gate ran once, on a good candidate, then two steps had no valid edits (defect 1) | Partial. The optimizer is now told not to game the score, so it proposes honest edits | One gated candidate | n/a | **FIX-METHOD** (the test): feed a known gaming candidate through the held-out gate instead of waiting for the optimizer to propose one. The held-out gate also reports its refusals back to the proposer (defect 2) |
| Optimizing on the scoring model does not beat transferring from the other model (Cat 33: transferred ≥ the "ceiling" in 4 of 4 pairs) | Full. Every optimization ran and gbrain accepted every edit | Poor. The flaws are format rules that do not depend on the model | Underpowered. One optimization per cell, scored on 6 tasks; the last pair's ceiling is 0.00 because of one wording difference | n/a | **FIX-METHOD** (the test): the transfer ratio divides by a single noisy run. Cat 33 needs several optimizations per cell, and held-out rules the training rules match, before the ratio means anything |

## What to use and what to avoid

- **Use** `gbrain skillopt` to repair a skill with a clear, checkable gap: a missing section, a length limit, a missing search step. The first step does the work.
- **Expect** one rewrite by a strong model to do as well on that kind of gap, for about half the cost. Today's runs show no case where the loop's later steps added anything.
- **Do not read** gbrain's own test score as a held-out result. It shows the optimizer the test split's criteria, and here it read 1.00 where the stricter held-out tasks read 0.33 to 1.00.
- **Budget from the meter.** gbrain prices a Haiku 5.5 target call at about 1.8 times what the providers billed (Cat 31: $0.0014 against $0.0008 per call). Opus optimizer calls agree.
- **Next.** These practice tasks cannot separate optimizers, so a third run on them would tell us nothing new. Garry approved a benchmark on gbrain's shipped skills (`query`, `briefing`, `fact-check`) that runs gbrain's loop against a one-shot rewrite, GEPA, Microsoft SkillOpt and controls at equal rollout budgets (GST-799). It starts with a cheap probe of whether one rewrite already takes all the gain on those skills. Garry also decided that one-shot becomes SkillOpt's default until the benchmark shows the loop wins. gbrain is making that change, fixing the defects below and adding the interfaces the benchmark needs (GBRA-274).

### gbrain defects found (reported upstream, not fixed here)

All read in code at `3ec766c40`, under `src/core/skillopt/`:

1. **The success-reflection prompt never names the edit fields**, so its edits all fail validation (`reflect.ts`, `SUCCESS_REFLECT_SYSTEM` against `validateEdits`). Reproduced, and seen in 8 of today's later steps.
2. **Held-out refusals reach the proposer.** They are written to the rejected buffer as `held_out_regression` and listed in the next reflect prompt (`orchestrator.ts` about 848 to 851, `reflect.ts` about 401), so the held-out set acts as a second selection set.
3. **The proposer sees the test split's judge criteria** (`orchestrator.ts:439`).
4. **Edits the learning-rate budget never applied are recorded as rejected or accepted** with the ones that were applied (`orchestrator.ts` about 750 to 917). It happened twice today.
5. **Smaller gaps:**
   - `--rewrite` does nothing beyond the job record.
   - The slow (meta) update is a logged stub.
   - Runs continue after selection reaches 1.00, where no edit can be accepted.

## Reproduce and inspect

Keys: `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`. Each category runs from the repository root at its defaults, for example `bun eval/runner/cat30-skillopt-improvement.ts`; set `SKILLOPT_JUDGE_MODEL` to change the judge. To meter as this run did, start `eval/runner/metering-proxy.ts` in lease mode and point `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` at a slot (`http://127.0.0.1:8787/<slot>/anthropic`). Set `GBRAIN_AUDIT_DIR` to keep gbrain's step events. Receipts land in `eval/reports/cat3X-*/receipt.json`.

| Run | Started (UTC) | Wall time | Metered cost |
|---|---|---|---|
| Smokes (Cat 30 and Cat 32 B-pre, three Sonnet rollouts) | 15:20 | | $0.21 |
| Cat 30 | 15:29 | 27 min | $0.75 |
| Cat 31 | 15:29 | 47 min | $1.30 |
| Cat 32 | 15:29 | 17 min | $0.66 |
| Frontier probe (Opus 5.5) | 15:49 | 5 min | $1.71 |
| Success-reflection repro (one Opus call) | 15:47 | | $0.01 |
| Cat 33 | 16:18 | 64 min | $8.12 |
| **Total** | | | **$12.76** |

The brief's cap was $40 with a stop at $32.

Files in this directory:

- [`receipts/`](receipts/): category receipts with every optimization's final skill and gbrain receipt, the two smoke receipts and the frontier probe.
- [`audit/`](audit/): gbrain's step events per category.
- [`receipts/metered-cost.json`](receipts/metered-cost.json): per-slot spend from the proxy's usage log, and the budget ledger's totals.
- [`scripts/`](scripts/): the frontier probe, the success-reflection repro and the cost summary (`summarize-metered-cost.py`).

The receipts record the checkout when each one was written: `18186aea`, `c58cde06`, `275d0d44` and later. Only documentation and these scripts changed between those commits. Cat 30's receipt says `dirty` because `scripts/frontier-probe.ts` was not yet committed when it finished.
