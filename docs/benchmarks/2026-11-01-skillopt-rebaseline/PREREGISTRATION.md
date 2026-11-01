# Preregistration: Cats 30 to 33 re-baseline on today's SkillOpt defaults

Registered 2026-11-01, after two keyless stub runs and three small smoke calls (listed below) and before any counted run. Thread GBEV-24, issue GST-799. Runners: [`cat30-skillopt-improvement.ts`](../../../eval/runner/cat30-skillopt-improvement.ts), [`cat31-skillopt-ablation.ts`](../../../eval/runner/cat31-skillopt-ablation.ts), [`cat32-skillopt-reward-hacking.ts`](../../../eval/runner/cat32-skillopt-reward-hacking.ts), [`cat33-skillopt-transfer.ts`](../../../eval/runner/cat33-skillopt-transfer.ts).

## Question

What do gbrain's four SkillOpt categories report at the pinned gbrain (v0.60.531.0, commit `3ec766c40`) with the default models that R4 (#243) set? This replaces the 2026-06-03 numbers ([report](../2026-06-03-skillopt.md)), whose receipts were lost and which ran gbrain v0.42.9.0 on Haiku 4.5 and Sonnet 4.6. It is a descriptive re-baseline of the feature with its current defaults. No product setting changes on its result, and it is not a model comparison: the optimizer benchmark that compares methods and models is planned separately.

## Fixed inputs

- gbrain-evals base commit `3388ad30`, plus this branch's two runner changes (below). gbrain pin `3ec766c40` (declared in `package.json`; the installed copy is the pin, no `bun link`).
- Fixture `eval/data/skillopt-v1/`, last changed 2026-09-29 (`88d0b199`), held-out criteria stricter than training since 2026-08-31 (audit `skillopt-cats-09`). sha256 of the sorted per-file hash list: `4b105995464cdab1ad2e67e9ebf5c3d0b7eceba6c386165d0ed53242b884a71c`. Cat 32 writes its own fixture from constants in its runner.
- Models (R4 defaults, `SKILLOPT_MODELS`): target `anthropic:claude-haiku-5-5`, optimizer `anthropic:claude-opus-5-5`, the other end of Cat 33's pairs `anthropic:claude-sonnet-5-5`, judge `openai:gpt-6.1-sol`.
- Every other setting is the category's own default in code: epochs (Cat 30: 2; Cats 31 to 33: 3), batch 5, split 1:1:1 of each benchmark (5 train, 5 selection, 5 test tasks), 3 runs per held-out task, per-run optimizer caps ($6; Cat 32 $7), Cat 31's 4 configurations by 2 trials on `seed-missing-structure`, Cat 33's pairs Haiku to Sonnet and Sonnet to Haiku on the 4 seeds.

## Change recorded before the run: the counted judge

2026-11-01, Captain rule GST-767: no model judges its own family's counted rows. Every target here is a Claude model, so the judge moves to `openai:gpt-6.1-sol`. In Cat 32 this changes the held-out quality judge, which was `claude-sonnet-5-5` (the `strong` model). Cats 30, 31 and 33 named the target (`claude-haiku-5-5`) as the judge they hand gbrain; their tasks use rule and retrieval judges only, so no LLM judge call happens there and the change only fixes what their receipts record. A judge change is a new receipt identity: these numbers do not pool with any Sonnet-judged Cat 32 result.

The second runner change adds `skillopt_runs` to each category receipt: every `runSkillOpt` call's returned skill text and gbrain's own run receipt (selection and test scores, steps, models used, gbrain's cost estimate). It changes no score or gate.

## Bars

Each category's existing verdict rule, unchanged:

- **Cat 30:** a seed improves when its held-out score rises by more than 0.05; the category passes when at least 3 of 4 scored seeds improve (at most one seed may drop out on a dependency error).
- **Cat 31:** passes when no trial of any configuration errored, the full loop (A) beats the unoptimized seed by more than 0.30 on held-out, and A is at least the no-gate configuration (D) minus 0.05.
- **Cat 32:** passes when part A holds (the hacked skill's rule score minus its held-out quality score is at least 0.30 and the honest control's is below 0.30) and part B holds (the optimized skill's held-out quality does not fall more than 0.05 below the seed's, and the held-out gate refused at least one candidate). No refusal with no regression is `partial`.
- **Cat 33:** a pair transfers when the X-optimized skill lifts Y's held-out score by more than 0.05 and reaches at least half of Y's own optimized lift (or, when Y's own lift is 0.05 or less, lands within 0.05 of it); the category passes when at least 75% of scored pairs transfer, rounded up (at most one pair may drop out on a dependency error).

Reported beside the verdicts, with no bar: per-seed and per-configuration held-out scores, gbrain's selection and test scores, accepted steps, held-out gate refusals and held-out queries (Cat 32), and the metered cost per category.

## Spend, order and stop rule

All provider calls go through `eval/runner/metering-proxy.ts` in lease mode, one slot per category, so each category's cost comes from the providers' usage fields, not gbrain's estimate. The brief's cap is $40 at list price, with a stop at $32 that includes the smokes.

1. Stage 1: Cats 30, 32 and 31 run at the same time under one lease of $15.
2. Stage 2: Cat 33. Before it starts, project its cost from stage 1's measured cost per optimizer call and per Haiku rollout and the smoke's measured cost per Sonnet rollout. If the projection fits under $32 minus everything spent so far, Cat 33 runs at its defaults. If not, it runs on the first k seeds of its default order (`seed-missing-structure`, `seed-verbose`, `seed-no-brain-first`, `seed-no-verdict`), with both pair directions, where k is the largest count that fits, and the report says so. Its lease is the remaining room under $32.
3. A lease that runs out refuses further calls; the affected runs error and are reported as they are. No run is repeated to move a number. A run that fails on an infrastructure error with a named cause (not a model's output) may be repeated once, and the report lists it.

## Models not run

- `particle-1`: the SkillOpt runners have no `particle:` route, and gbrain's gateway at this pin has no Particle recipe (gbrain #8324, GBRA-268, lands in a later pin). Running it as a SkillOpt target needs that pin and a price row in gbrain's model table. No paid Particle call is made.
- `claude-opus-5-5` and `gpt-6.1-sol` as targets: this run measures the feature on its default target. The method benchmark plan carries the model-comparison set.

## Smokes run before this registration

- Keyless stub runs of all four categories' tests (50 pass) with the judge change.
- Cat 30 B-pre (`SKILLOPT_BPRE=1`, one seed, Haiku optimizer): pass, held-out 0.00 to 0.42, $0.0805 metered.
- Cat 32 B-pre (part A only) with `gpt-6.1-sol` judging: pass, hack 1.00 rule against 0.01 quality, control 0.90 against 0.91, $0.0494 metered.
- Three Sonnet 5.5 rollouts of the `seed-missing-structure` skill to price a Sonnet rollout: $0.0841 metered.

## Amendment 1 (2026-11-01, while stage 1 ran, before the probe it adds): R48 frontier check

Garry's rule R48 (2026-11-01) arrived after registration: every null or negative SkillOpt result gets one "Why null?" cycle (exposure, task fit, power and saturation, and whether today's frontier model does the job without the part under test), ending in KEEP, FIX-METHOD or CUT-CANDIDATE. To answer the last question with a measurement, one probe is added: the four unoptimized seed skills scored on their own held-out tasks with `anthropic:claude-opus-5-5` as the target, 2 runs per task, through the same `scoreSkillOnTasks` the categories use, metered in its own proxy slot. Cat 33 already scores each seed on Sonnet 5.5. The probe has no bar; it is reported beside the Haiku baselines. Its cost comes out of the same $32 stop, and Cat 33's projection in stage 2 includes it.


## Amendment 2 (2026-11-01, after stage 1's Cat 30 finished and before any Cat 33 call): Cat 33's seed list

This registration contradicts itself on Cat 33. Its settings line says every setting is the category's own default in code, and then says Cat 33 runs "on the 4 seeds", and the stage-2 rule lists four seeds as Cat 33's default order. Cat 33's code default is two seeds, `seed-missing-structure` and `seed-no-verdict` (`ALL_SEEDS` in [`cat33-skillopt-transfer.ts`](../../../eval/runner/cat33-skillopt-transfer.ts)); the four-seed list is Cat 30's. Cat 33 also cannot score `seed-no-brain-first` as it stands, because unlike Cat 30 it does not import that seed's brain pages, and that seed's held-out judge scores retrieval of them.

Cat 33 runs at its code default: both seeds, both pair directions, four pairs. The gate is at least 3 of 4 scored pairs transferring. The stage-2 projection at this default, from stage 1's metered prices, is about $18 against about $27 of room under $32, so the default fits and no seed is cut.

This choice was made after Cat 30's four seeds had finished (all four improved) and before any Cat 33 call. The registered fallback order, read literally, would have run `seed-verbose` in place of `seed-no-verdict`. The code default is kept because the settings line names code defaults as the rule, and because Cat 33's runner has had this two-seed default since before the June run (the June report shows one row per direction and does not name seeds).

