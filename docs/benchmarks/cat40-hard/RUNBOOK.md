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

Run the steps in order with `scripts/cat40-hard.sh step <step>`. `scripts/cat40-hard.sh preflight <step>` prints the same step's checks without spending, and `PRINT_ONLY=1` prints every command instead of running it. Each step checks its predecessor artifacts and the recorded budget decision, projects its cost and stops with `HARD_BUDGET_SHORT` when the Hard ledger has less than the projection plus 15%. A step that stops part way resumes by running the same step again: the script opens a new budget run (`--new-budget-run`) sized to the projection of the cells still missing, so a resume never joins a spent run. `BUDGET_USD=<n>` sets a step's `--budget-usd` explicitly; the ledger gate still applies.

Projections come from `bun eval/runner/cat40/hard-ops.ts project --step <step> [--measured <attempts.jsonl>,...] [--done <the step's attempts.jsonl>]`, per model, arm and family, because Hard cells differ in cost far more by family than by arm (an H1 cell reads dozens of records). A (model, arm, family) uses measured Hard cells when `--measured` has them (the script passes every earlier Hard step's attempts); otherwise the v1 cost per cell of that model and arm times the Hard factor measured for its arm and family in calibration round 1, plus the measured judge cost for the family ([cost-basis.json](cost-basis.json); memory borrows the fs factors, gbrain the pg factors, H5 is assumed at 3 times the H2-H4 mean until measured). A 50k step uses measured 50k cells (calibration from round 3, the freeze check, earlier 50k batches) where they exist, else 4k measurements times 1.8 (fs, oracle, pg) or 1.3 (gbrain, from the 4k smoke); slot builds scale with the world's bytes. Cells a step already finished (`--done`) are not projected. Figures below use calibration round 1's measurements (2026-10-05).

| # | Step | What it runs | Output | Projection (+15%) | Wall clock |
|---|---|---|---|---|---|
| 1 | `calibrate` (ROUND=1..5, SCALE) | world from `knobs.round-N.json` (seed 20261005): from round 3 the 50k world (`SCALE=large`, the default from round 3, amendment A1), built on its 4k base; rounds 1 and 2 used the 4k world (`SCALE=v1`); oracle, fs and pg on Sonnet 5.5 and GPT-6 Astra, 10 tasks per family, 1 repeat; then the freeze-rule analyzer, whose table is appended to calibration.md | `eval/reports/cat40/hard/calibration/round-N/{base-4k,world,cells}` | 4k: $45.48 ($52.30) per round; 50k: $87.55 ($100.68) before measured round-2 cells (below) | 4k about 60 min; 50k longer (below) |
| 2 | `freeze-check` (ROUND=N) | oracle, fs and pg on Opus 5.5, Fable 5.1 and GPT-6.1 Sol on round N's world, reusing round N's two models; the analyzer over all five | `.../round-N/freeze-check` | $114.61 ($131.81) | about 90 min |
| 3 | `freeze` (ROUND=N) | copies `knobs.round-N.json` to `knobs.frozen.json` and writes `freeze.json` (code hashes, settings digest); commit both | `docs/benchmarks/cat40-hard/` | free | seconds |
| 4 | `smoke` (GBRAIN_REF) | seed 20261099 world from the frozen knobs, 1 gbrain slot build, 1 task per family on Sonnet 5.5; checked only for harness errors | `eval/reports/cat40/hard/smoke/{world,slots,cells}` | $1.79 ($2.05) | about 20 min |
| 5 | `heldout-world` | the 50k held-out world from seed 20261006 and the frozen knobs, built on its 4k base (which runs no cells, amendment A2); prints hashes only; record the 50k hash in PREREGISTRATION.md and commit it | `eval/reports/cat40/hard-holdout/{base-4k,50k}` | free | about 2 min |
| 6 | `slots-50k` (GBRAIN_REF) | 5 gbrain slot snapshots on the 50k world, one at a time | `eval/reports/cat40/hard/slots-50k` | $12.04 ($13.84) | about 7.5 h |
| 7 | `cells-50k` (GBRAIN_REF) | batch (a), the primary endpoint: a 5-cell gbrain smoke that halts on any harness error, then gbrain and fs on the five models, 20 tasks per family | `eval/reports/cat40/hard/{cells-50k-smoke,cells-50k}` | `preflight cells-50k` | about 10 h |
| 8 | `oracle-50k` | batch (b): the oracle reference on the five models, every family | `eval/reports/cat40/hard/oracle-50k` | `preflight oracle-50k` | about 1 h |
| 9 | `pg-50k` | batch (c): pg on the five models | `eval/reports/cat40/hard/pg-50k` | `preflight pg-50k` | about 5 h |
| 10 | `memory-50k` | batch (d): memory on Sonnet 5.5 and GPT-6.1 Sol only (amendment A1) | `eval/reports/cat40/hard/memory-50k` | `preflight memory-50k` | about 4 h |
| | `report` | analysis tables and the primary endpoint, gbrain minus fs at 50k (`--hard-headline gbrain-hard,fs --simple fs`, adding pg to the simultaneous intervals when `pg-50k` completed) | `eval/reports/cat40/hard/analysis-50k.{md,json}` | free | minutes |

The confirmation ([PREREG.md](../../plans/2026-10-07-cat40-hard-fix/PREREG.md) on the plan branch) runs four steps per world with `CONFIRM_WORLD=main` or `CONFIRM_WORLD=sealed`, each world on its own machine and ledger (`.budget/cat40-hard-confirm-<world>.sqlite`, cap $650): `confirm-world` (main: generate seed 20261021 at 50k from the frozen knobs; sealed: validate the world the seed owner generated, against `SEALED_DIGEST`), `confirm-slots` (5 slots, each with 0 queued persistence effects at snapshot), `confirm-oracle` (then the 95% oracle gate) and `confirm-cells` (gbrain and fs, counted). `gbrain-fs` stays refused in every step.

The held-out path is 50k only (amendment A2): freeze-check, freeze, smoke, heldout-world, slots-50k, then the four 50k batches in order, each a separate step with its own projection and the projection-plus-15% ledger gate, each starting only after the previous batch is complete. `slots-4k`, `simple-4k`, `comparator` and `gbrain-4k` stop with `HARD_STEP_RETIRED`. Batch projections come from the step's `preflight`, which uses every measured Hard cell at hand; there are no fixed figures until round 4's 50k cells exist.

### Calibration at 50k (round 3 on)

`ROUND=3 scripts/cat40-hard.sh step calibrate` writes the 4k world to `round-3/base-4k` and the 50k world (about 53,600 documents, 103 MB) to `round-3/world`; the freeze check reuses `round-N/world`, so it runs at the round's scale. Generating the 50k world takes about 40 seconds, and the runner regenerates it once on every start to check it (another 40 seconds). The pg arm embeds the new corpus once before its first cell, about 21 million tokens or $2.70 with `text-embedding-3-large`; the projection adds it when it knows the world (the runner's `--preflight` counts the documents' characters; `hard-ops.ts project --world`, which the script's budget uses, counts the file's bytes and gives $3.35). Building the pg store takes about 2.5 minutes for the 50k world on a 4-core machine, plus the embedding requests; the build checkpoints PGlite every 2,000 rows, without which it exhausts memory and hangs about 48,000 chunk rows in. Projections use measured cells at the step's scale when there are any; before round 3 has run, that is the 4k round-1 and round-2 cells times the 50k factor (1.8 for fs and oracle, 1.8 default for pg). Generator v2 makes the fs and pg agents resolve codes, nicknames and account managers, so expect more turns per cell than round 2; a budget stop resumes with the same command.

`bun eval/runner/cat40/hard-proxy.ts --scale large --knobs <knobs.json> [--knobs <knobs.json>]` prints the free difficulty proxy per family (how often the oracle's event records name the asked account, and what one, two or three greps reach), in seconds, without any model call.

At round-1 rates, with one more calibration round and one freeze check, the campaign projects $2,360 before the 15% margins, against $1,759 left in the $1,794 Hard ledger after round 1's $35. The memory arm on the five models ($777 at 4k) and the 50k cells are the largest items. Tier A no longer fits at measured costs, so the margin check will stop a held-out step; that stop is a decision for Garry (narrow the arms or models, skip or shrink the 50k step, or fund more), never a reason to raise a cap. Each further calibration round adds about $45 and the second freeze check about $115.

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

### Exploratory arm: gbrain-fs

The counted arms are oracle, fs, pg, memory and gbrain. `--arms gbrain-fs` (plan 2026-10-07-cat40-hard-fix, item C16) asks whether an agent with gbrain and the plain Markdown files does better than files alone. It is exploratory only: it runs on the calibration-seed development world, never in a program step, a confirmation or a held-out run (`HARD_ARM_EXPLORATORY`), and its results are never counted. The agent gets every gbrain tool, the server instructions, slots, probes and metering of the gbrain arm, plus the fs arm's `list_dir`, `grep` and `read_file` with the fs arm's limits over the same files. `write_file` is not served, so notes live only in gbrain. Its cells are labelled `<--gbrain-label>+fs`, a gbrain tool named like an fs read tool is refused before any cell, and `experiment.json` and the receipt record `exploratory: true`.

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
| `HARD_STEP_RETIRED` | a 4k held-out step (slots-4k, simple-4k, comparator, gbrain-4k), which amendment A2 retired | run the 50k path: heldout-world, slots-50k, cells-50k, oracle-50k, pg-50k, memory-50k, report |
| `HARD_ORACLE_GATE` | a confirmation world's pooled oracle success is below 95%, or oracle cells lack a clean attempt (PREREG.md gate 2) | run no counted cells on that world; report it; Garry decides what follows |
| `HARD_SLOT_EFFECTS_QUEUED` | a gbrain slot snapshot recorded queued persistence effects, so every restore stalls its first tool call (PREREG.md gate 3) | read the slot receipt's warm-boot step and rebuild the slots (`--build-slots --rebuild`) |
| `HARD_ARM_EXPLORATORY` | `--arms gbrain-fs` on a world other than the calibration seed, or with `--step` | run gbrain-fs only on the calibration-seed (development) world, outside the program steps |

## Runs, records and stop kinds

A Hard run writes `attempts.jsonl` (every attempt of every cell, v2 records with `sessions[]`, `attempt` and a unique `attempt_id`), `results.jsonl` (the harness-clean attempts), `judge-requests.jsonl`, `transcripts.jsonl` with `--transcripts`, `experiment.json` and a receipt. Session stop kinds are `submitted`, `turn_cap`, `no_tool_call`, `context_overflow` (a provider context-length error, scored as a failure, never retried), `error` (agent-side malformed tool use, scored as a failure) and `harness_error` (a provider 5xx or 429 after backoff, or a slot, server, restore or MCP transport failure). Only `harness_error` is retried, at most twice per cell. Cells run families round-robin (H1-01, H2-01, ..., H5-01, H1-02, ...), so a step cut short by its budget still covers every family. An H5 chain continues whatever the recording sessions submit; an `error` in any session fails the cell, and its `error` field names the session.

`analyze.ts`, `rescore.ts`, `latency-replay.ts` and `holdout_stats.py` read v1 and v2 records. Analysis takes the last harness-clean attempt per cell and sums cost over every attempt.

## Status

`scripts/cat40-hard.sh status` prints the ledger, the roster check, the freeze state, each step's completeness and harness-error count, and the SHA-256 of each generated world. It never prints world content. Nobody opens the held-out worlds before the runs finish.
