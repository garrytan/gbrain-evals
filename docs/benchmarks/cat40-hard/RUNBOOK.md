# Cat 40 Hard runbook

This is the operator guide for the Cat 40 Hard tier: what each step runs, where it writes, which ledger it charges, what it is projected to cost, how long it takes, how it stops and what comes next. The plan is [docs/plans/2026-10-05-cat40-hard/PLAN.md](../../plans/2026-10-05-cat40-hard/PLAN.md); its "Gate decisions" section overrides everything else in it. The world and scoring contract is [WORLD_SCHEMA.md](WORLD_SCHEMA.md).

Cat 40 gives an AI agent questions about a fictional company's documents and compares memory systems by how many it answers correctly. The Hard tier asks questions that need many records, long change histories, look-alike customers, conflicting sources and memory across five conversations. It is tuned on plain files until frontier models answer roughly half, then frozen and measured on a fresh held-out world.

## Before any paid step

- Run from the repository root with dependencies installed (`bun install`).
- `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are set. pg and gbrain also need `OPENAI_API_KEY` for embeddings. `scripts/cat40-hard.sh preflight <step>` lists the variables each arm needs.
- The Hard ledger `.budget/cat40-hard.sqlite` exists with a $1,794 cap, and the program ledger roster ([ledger-roster.json](ledger-roster.json)) matches every local ledger. The roster lists the four original machines' committed $1,763, `.budget/cat40-followups.sqlite` at a $793 cap (its committed $792.69, rounded up) and the Hard ledger at $1,794, within the $4,350 authorization. Nothing else spends against the Hard ledger.
- Every paid command passes `--judge gpt-6.1-sol` and runs only the newest frontier models: Sonnet 5.5, Opus 5.5, Fable 5.1, GPT-6.1 Sol and GPT-6 Astra. A newer frontier Opus, GPT, Sonnet or Fable replaces its predecessor only through a dated preregistration amendment with its price registered.
- Hard tasks start at 16 turns per session. The turn cap is the last calibration knob, moved only with a dated reason in [calibration.md](calibration.md).

## The first command

```bash
scripts/cat40-hard.sh hello
```

It generates a calibration-seed Hard world, runs every family through the scripted fs, memory and oracle arms at $0 (including five-session H5 chains and scored H1 set answers), and prints the per-family tables and the freeze-rule table. It takes a few seconds. The scripted oracle submits the answer key, so its rows show the scorer's success path; the scripted file agents submit empty answers.

## Steps

Run the steps in order with `scripts/cat40-hard.sh step <step>`. `scripts/cat40-hard.sh preflight <step>` prints the same step's checks without spending, and `PRINT_ONLY=1` prints every command instead of running it. Each step checks its predecessor artifacts and the recorded budget decision, projects its cost and stops with `HARD_BUDGET_SHORT` when the Hard ledger has less than the projection plus 15%. A step that stops part way resumes by running the same step again.

Projections come from `bun eval/runner/cat40/hard-ops.ts project --step <step> [--measured <attempts.jsonl>,...]`. Round 1 uses measured v1 per-cell costs times 1.8 ([cost-basis.json](cost-basis.json)); every later step uses the latest measured Hard per-cell costs, judge included; the 50k step uses measured 4k costs times 1.8 (fs, oracle) or 1.3 (gbrain); slot builds scale with the world's bytes. Figures below are the projections before any Hard measurement.

| # | Step | What it runs | Output | Projection (+15%) | Wall clock |
|---|---|---|---|---|---|
| 1 | `calibrate` (ROUND=1..5) | world from `knobs.round-N.json` (seed 20261005); oracle, fs and pg on Sonnet 5.5 and GPT-6 Astra, 10 tasks per family, 1 repeat; then the freeze-rule analyzer, whose table is appended to calibration.md | `eval/reports/cat40/hard/calibration/round-N/{world,cells}` | $32.95 ($37.89) per round | about 45 min |
| 2 | `freeze-check` (ROUND=N) | oracle, fs and pg on Opus 5.5, Fable 5.1 and GPT-6.1 Sol on round N's world, reusing round N's two models; the analyzer over all five | `.../round-N/freeze-check` | $77.47 ($89.09) | about 60 min |
| 3 | `freeze` (ROUND=N) | copies `knobs.round-N.json` to `knobs.frozen.json` and writes `freeze.json` (code hashes, settings digest); commit both | `docs/benchmarks/cat40-hard/` | free | seconds |
| 4 | `smoke` (GBRAIN_REF) | seed 20261099 world from the frozen knobs, 1 gbrain slot build, 1 task per family on Sonnet 5.5; checked only for harness errors | `eval/reports/cat40/hard/smoke/{world,slots,cells}` | $1.29 ($1.48) | about 20 min |
| 5 | `heldout-world` | held-out worlds from seed 20261006 and the frozen knobs at 4k and 50k; prints hashes only; record them in PREREGISTRATION.md and commit it | `eval/reports/cat40/hard-holdout/{4k,50k}` | free | about 1 min |
| 6 | `slots-4k` (GBRAIN_REF) | 5 gbrain slot snapshots on the 4k world, one at a time | `eval/reports/cat40/hard/slots-4k` | $1.49 ($1.71) | about 1 h |
| 7 | `simple-4k` | oracle, fs, pg and memory on the five models, 20 tasks per family, 1 repeat | `eval/reports/cat40/hard/simple-4k` | $773.41 ($889.42) | about 3.5 h |
| 8 | `comparator` | `holdout_stats.py --hard-comparator fs,pg,memory` plus the comparator's planning MDD; commit `comparator.txt` before any gbrain held-out cell | `docs/benchmarks/cat40-hard/comparator.txt` | free | seconds |
| 9 | `gbrain-4k` (GBRAIN_REF) | gbrain (label `gbrain-hard`) on the five models | `eval/reports/cat40/hard/gbrain-4k` | $221.61 ($254.85) | about 3 h |
| 10 | `slots-50k` (GBRAIN_REF) | 5 gbrain slot snapshots on the 50k world, one at a time | `eval/reports/cat40/hard/slots-50k` | $12.04 ($13.84) | about 7.5 h |
| 11 | `cells-50k` (GBRAIN_REF) | a 5-cell gbrain smoke that halts on any harness error, then gbrain and fs on every model, then the oracle on the 20 H1 tasks | `eval/reports/cat40/hard/{cells-50k-smoke,cells-50k,oracle-50k}` | $491.45 ($565.18) | about 12 h |
| | `report` | analysis tables, the primary endpoint with simultaneous intervals against every simple arm, and the 50k comparison | `eval/reports/cat40/hard/analysis-*.{md,json}` | free | minutes |

With one calibration round and one freeze check the campaign projects $1,612 before the 15% margins, against the $1,794 Hard ledger. Each further calibration round adds about $33 and the second freeze check about $77, so the margin checks may stop a late step; that stop is a decision for Garry, never a reason to raise a cap.

### Calibration rules

The freeze rule (provisional Taste CEO-T1, taken at the gate) is checked by `bun eval/runner/cat40/analyze.ts <results.jsonl...> --freeze-rule --round N --calibration-md docs/benchmarks/cat40-hard/calibration.md`:

- pooled success of the better simple calibration arm (fs or pg) within 40-70%;
- every model's better-of-fs-and-pg success between 20% and 80%;
- every model's oracle success at least 90%, and every family's oracle success at least 80% pooled over the round's models;
- at most 50% of that arm's failures are turn-cap stops.

Oracle failures are read and classified as wording or answer-key defects before any knob changes, and the generator is frozen only with zero unresolved answer-key defects. Knob priority: record counts, history length, distractor rate and noise first; the turn cap last, with a dated reason. At most 5 tuning rounds and 2 freeze checks. Every round's knobs, results, stop kinds and cost go into calibration.md.

### After the freeze

A runner or scorer fix that leaves every world digest unchanged proceeds with a dated note in calibration.md. A scorer-only change is applied to every affected result by offline rescoring (`bun eval/runner/cat40/rescore.ts --hard --world <world.json> --results <attempts.jsonl> --out <dir>`); a behavior change reruns the affected calibration and reference cells. The runner records the frozen files' hashes in each run's `experiment.json` and refuses a held-out run whose frozen code differs from `freeze.json` unless `--accept-freeze-drift "<dated note>"` is passed. A generator change after step 3 voids the freeze; after step 5 it stops for Garry.

A failed claims judgment is re-judged without rerunning the agent: `bun eval/runner/cat40/judge-hard.ts --rejudge <run dir> --judge gpt-6.1-sol --budget-usd <n> --budget-ledger .budget/cat40-hard.sqlite`.

## Stop codes

Every refusal and stop-for-Garry condition exits 3 and prints `STOP <code>`, what failed, the fix and, when it applies, the decision needed. Usage errors (an unknown flag, a missing value) exit 2.

| Code | Meaning | Fix |
|---|---|---|
| `HARD_JUDGE_REQUIRED` | a paid Hard run has no `--judge`, or `--judge none` | pass `--judge gpt-6.1-sol` |
| `HARD_MODEL_EXCLUDED` | gpt-5.4-mini is in `--models` or `--judge` | remove it |
| `HARD_MODEL_UNPRICED` | a model has no registered price | add its list price, source and date to `CHAT_PRICE_OVERRIDES` (the refusal names the file and line) |
| `HARD_ARM_NOT_APPLICABLE` | fs-acl on a Hard world | use oracle, fs, pg, memory, gbrain |
| `HARD_WORLD_INVALID` | the world fails the invariants | regenerate it; never edit a world |
| `HARD_WORLD_MISMATCH` | the world differs from its generator, or the output directory holds another world identity | regenerate the world, or repeat the original command, or use a new `--out` |
| `HARD_KNOBS_NOT_FROZEN` | a smoke or held-out world uses knobs other than `knobs.frozen.json` | freeze first, then regenerate with the frozen knobs |
| `HARD_FREEZE_DRIFT` | frozen code changed since `freeze.json` | rescore offline or rerun affected cells, note it in calibration.md, then pass `--accept-freeze-drift` |
| `HARD_ORACLE_TOO_LARGE` | an oracle prompt exceeds a model input limit | lower `h1_near_miss_cap` before the freeze, or drop those oracle cells with a recorded reason |
| `HARD_SLOTS_QUARANTINED` | fewer healthy gbrain slots than planned | read the quarantine reasons, repair or rebuild the slots, resume |
| `HARD_CELLS_INCOMPLETE` | cells still lack a harness-clean attempt | rerun the printed command to resume |
| `HARD_RETRIES_EXHAUSTED` | a cell had a harness error on all 3 allowed attempts | fix the harness, rerun those cells in a new `--out`; Garry decides whether the step continues |
| `HARD_BUDGET_SHORT` | the ledger has less than the projection plus 15% | stop; Garry decides whether to fund, narrow or stop the step |
| `HARD_LEDGER_ROSTER` | a roster ledger is missing or its cap differs | run on the machine with the ledgers; only Garry's authorization changes a cap |
| `HARD_PREDECESSOR_MISSING` | a step ran before its predecessor, or a required variable is unset | run the earlier step, or set `ROUND` or `GBRAIN_REF` |
| `HARD_BUDGET_DECISION_MISSING` | the roster has no recorded budget decision | record Garry's decision in the roster |
| `HARD_FREEZE_RULE_FAILED` | a round or freeze check fails the freeze rule | tune the next knob group with a dated reason; after round 5 or the second freeze check, Garry decides |
| `HARD_SMOKE_FAILED` | the gbrain smoke had harness errors | fix the harness and rerun the smoke |
| `HARD_PREREG_MISSING` | the preregistration lacks a field this step needs | fill it and commit before the step |

## Runs, records and stop kinds

A Hard run writes `attempts.jsonl` (every attempt of every cell, v2 records with `sessions[]`, `attempt` and a unique `attempt_id`), `results.jsonl` (the harness-clean attempts), `judge-requests.jsonl`, `transcripts.jsonl` with `--transcripts`, `experiment.json` and a receipt. Session stop kinds are `submitted`, `turn_cap`, `no_tool_call`, `context_overflow` (a provider context-length error, scored as a failure, never retried), `error` (agent-side malformed tool use, scored as a failure) and `harness_error` (a provider 5xx or 429 after backoff, or a slot, server, restore or MCP transport failure). Only `harness_error` is retried, at most twice per cell. An H5 chain continues whatever the recording sessions submit; an `error` in any session fails the cell, and its `error` field names the session.

`analyze.ts`, `rescore.ts`, `latency-replay.ts` and `holdout_stats.py` read v1 and v2 records. Analysis takes the last harness-clean attempt per cell and sums cost over every attempt.

## Status

`scripts/cat40-hard.sh status` prints the ledger, the roster check, the freeze state, each step's completeness and harness-error count, and the SHA-256 of each generated world. It never prints world content. Nobody opens the held-out worlds before the runs finish.
