# Cat 40 Hard preregistration

Status: template, 2026-10-05. Fields marked **TBD (step N)** are filled and committed at that step, before the step's cells run. Plan: [docs/plans/2026-10-05-cat40-hard/PLAN.md](../../plans/2026-10-05-cat40-hard/PLAN.md). Operator guide: [RUNBOOK.md](RUNBOOK.md).

This run is the Hard baseline. Each later measurement of a gbrain change on Hard uses a fresh preregistered seed with the frozen generator, because this run's tasks and transcripts are published.

## Question

On tasks where plain files with grep finish roughly half of the work for frontier agents, does gbrain (current master) let the same agents finish more tasks than the best simple memory setup, and does the difference hold when the company's documents grow from about 4,000 to about 50,000?

## Fixed now

- Calibration seed: 20261005. Smoke seed: 20261099.
- Held-out seed: 20261006 (50k only, amendment A2).
- Generator: `model-ladder-hard-v2` (amendment A1), frozen at step 3 (`freeze.json` and `knobs.frozen.json` in this directory).
- Models: Sonnet 5.5 (`claude-sonnet-5-5`), Opus 5.5 (`claude-opus-5-5`), GPT-6.1 Sol (`gpt-6.1-sol`), Fable 5.1 (`claude-fable-5-1`); GPT-6 Astra (`gpt-6-astra`) is a calibration model only (amendment A3). A newer frontier release replaces its predecessor in the same family and tier only through a dated amendment below, with its price registered, before any cell of the next step runs (rules in the plan, CEO-F3).
- Claims judge: `gpt-6.1-sol` on every cell (reported, never part of success).
- Arms: oracle (reference only), fs, pg, memory (Sonnet 5.5 and GPT-6.1 Sol only, amendment A1) and gbrain, uncapped tool results, Hard tool limits (grep returns every match with full lines and a total; pg searches page with offsets, totals and an exhaustion flag, limit up to 100).
- Turn cap: 16 per session (each H5 session separately), unless calibration moved it; the frozen value is `max_turns` in knobs.frozen.json.
- Tasks: 20 per family (100 tasks), 1 repeat, at each scale (Taste CEO-T2). The 50k oracle runs on the 20 H1 tasks, the only family whose oracle evidence changes at 50k.
- Budget: Garry's tier A decision, $4,350 program authorization; Hard ledger `.budget/cat40-hard.sqlite` at $1,794.

Program ledger roster ([ledger-roster.json](ledger-roster.json)); other allocations are frozen for this campaign:

| Ledger | Allocation |
|---|---|
| four original machines (committed) | $1,763.00 |
| `.budget/cat40-followups.sqlite` (cap $793, lowered to its committed $792.69) | $793.00 |
| `.budget/cat40-hard.sqlite` | $1,794.00 |
| total | $4,349.69 of $4,350 |

## Comparator and endpoints

- **Comparator.** The simple arms are fs, pg and memory. The comparator is the simple arm with the best pooled success on the 4k held-out results, among simple arms run on every model, ties broken by lower cost per task, committed in `comparator.txt` in this directory at step 8 before any 4k gbrain cell runs. fs is the comparator at 50k.
- **Primary endpoint.** The pooled 4k paired difference, gbrain minus the comparator, with a task-clustered bootstrap (a resampled task carries all its models and repeats): `holdout_stats.py --hard-headline gbrain-hard,<comparator> --simple fs,pg,memory`.
- **Selection-aware intervals (Taste ENG-T1).** Beside the primary interval, simultaneous paired intervals (max-T task-clustered bootstrap) for gbrain against every simple arm run on every model.
- **Secondary.** Per-model and per-family paired differences; the 50k paired difference gbrain minus fs; gbrain minus fs at both scales, so the scale effect uses the same arm.
- **Reported, not gated (Taste CEO-T8).** Cost per task and per successful task, incremental cost per extra correct answer against the comparator, agent latency without slot-restore time, setup cost and end-to-end latency, stops by kind, tool calls per task by family, unparseable set answers, harness-error retries per arm and model, and the H5 write diagnostic.

## Held-out bar and decision sentences

A model whose held-out comparator success is above 80% or below 20%, or whose oracle success is below 90%, has its comparison reported with that miss beside it. A model at ceiling on both arms is uninformative, not a tie.

The action each primary outcome triggers:

1. **gbrain ahead by at least the planning MDD.** The next gbrain wave targets the family where gbrain trails most, measured on a fresh Hard seed. "Trails most" requires that family's paired difference to have a bootstrap CI excluding 0; otherwise the choice falls back to per-family mechanism evidence from transcripts.
2. **Within the MDD.** The next wave is chosen by per-family mechanism evidence (the failure-mode mix from transcripts), not by this endpoint.
3. **gbrain behind.** Retrieval on the worst family is the next wave's target, under the same CI rule for naming the family.

Each sentence names the family-level evidence it uses: the per-family paired table and its bootstrap CIs from `--hard-headline`.

Claims stay within unrestricted information: Hard has no permissions family, so a gbrain fix wave chosen from Hard also passes the unchanged Cat 40 permission family (C) and ships as one PR.

## Planning minimum detectable difference

**TBD (step 5).** Computed from the freeze check's pooled fs success `p` with `holdout_stats.py <freeze-check results> --hard-mdd fs --mdd-tasks 100`: MDD = (z0.975 + z0.80) x sqrt(psi / n), stated discordance psi = 2p(1-p), worst case psi = 2 min(p, 1-p), n = 100 tasks. The step-8 comparator commit reports the same figure for the chosen comparator.

| Quantity | Value |
|---|---|
| freeze-check pooled fs success | TBD (step 5) |
| planning MDD, stated discordance | TBD (step 5) |
| planning MDD, worst case | TBD (step 5) |

## gbrain under test

| Field | Value |
|---|---|
| gbrain commit (current master) | TBD (step 4; the smoke and every held-out step use the same commit) |
| `--gbrain-config` | TBD (step 4; none unless named here) |
| surface | `starter` |
| slot statistics | operator ANALYZE on (runner default) |

## Freeze and held-out audit

| Field | Value |
|---|---|
| knob digest (knobs.frozen.json) | TBD (step 3) |
| settings digest (freeze.json) | TBD (step 3) |
| frozen code hashes | `freeze.json` (step 3) |
| 4k held-out world SHA-256 | TBD (step 5) |
| 50k held-out world SHA-256 | TBD (step 5) |

## Analysis commands

```bash
# amendment A2: the held-out run is 50k only. Primary endpoint, gbrain minus fs, with per-model and per-family tables and the weakest-family rule
python3 docs/benchmarks/2026-10-02-model-ladder/holdout/holdout_stats.py eval/reports/cat40/hard/cells-50k/attempts.jsonl --hard-headline gbrain-hard,fs --simple fs
# when the pg batch ran on every model: simultaneous intervals against fs and pg
python3 docs/benchmarks/2026-10-02-model-ladder/holdout/holdout_stats.py eval/reports/cat40/hard/cells-50k/attempts.jsonl eval/reports/cat40/hard/pg-50k/attempts.jsonl --hard-headline gbrain-hard,fs --simple fs,pg
# tables, costs, stops, latency (add the oracle, pg and memory batches that ran)
bun eval/runner/cat40/analyze.ts eval/reports/cat40/hard/cells-50k/attempts.jsonl eval/reports/cat40/hard/oracle-50k/attempts.jsonl --subject gbrain-hard --comparator fs --budget-ledger .budget/cat40-hard.sqlite
```

The runner argv for every step is in [RUNBOOK.md](RUNBOOK.md) and `scripts/cat40-hard.sh` (print it with `PRINT_ONLY=1 scripts/cat40-hard.sh step <step>`).

## Amendments

Each amendment is dated, gives its reason, and is committed before any cell it affects runs.

### A1 (2026-10-05): memory arm on two models; generator v2 tuned at 50k

Garry, 2026-10-05, after calibration round 2: "1A 2i".

- **Memory arm.** The memory arm runs on Sonnet 5.5 and GPT-6.1 Sol only, at both scales. It does not run on Opus 5.5, Fable 5.1 or GPT-6 Astra. Reason: at round-2 costs the rest of tier A projects to about $2,360 against $1,707 left on the Hard ledger; the memory arm on those three models is about $777 of that, and memory was the weakest simple arm in the earlier Cat 40 runs. Consequences: the comparator is chosen among simple arms run on every model, which is now fs and pg; the simultaneous intervals cover gbrain against fs and pg; memory's results on its two models are reported as secondary, per model. The authorization ($4,350) and the Hard ledger cap ($1,794) are unchanged.
- **Generator.** Round 2 left plain files at 95% pooled (fs 95/99 on two frontier models), with H2 to H5 at 95 to 100% after their knobs were raised: the agents search for the account name and read what comes back. The knobs are at their useful range, so the generator changes how documents refer to accounts before the freeze: most records refer to an account by its internal code, a nickname or its account manager instead of its name, and the documents that tie those references to the name are separate. Questions still ask by name. The frozen generator is `model-ladder-hard-v2`; `model-ladder-hard-v1` is never frozen.
- **Calibration scale.** Calibration rounds from round 3 run on the 50k world (seed 20261005, `--scale large`), where a name search returns the most noise and where gbrain trailed by 16 points in the earlier scale run. The freeze rule applies to the 50k calibration results; the 4k held-out world uses the same frozen knobs.

### A2 (2026-10-06): multi-account questions; the 50k held-out run is the main result

Garry, 2026-10-06, after calibration round 3, relayed by GBRA-40: "take the recommendations ... A + i".

- **Generator.** Round 3 (50k, generator v2) left the better simple arm at 83% pooled: H1 fell to 15-20%, while H2 to H5, which ask about one account, stayed at 85 to 100%. The number of accounts a question needs is what moved difficulty. Before the freeze, H2 to H5 questions ask about 2 to 4 accounts at once (a knob sets the range, 1 reproduces v2), and H1 sets get smaller so H1 is not decided by turn-cap stops. Calibration rounds 4 and 5 (the last two the plan allows) tune these knobs on the 50k calibration world. The frozen generator is still `model-ladder-hard-v2`, with these knobs.
- **Held-out scale.** The held-out run uses only the 50k world (seed 20261006, `--scale large`). The 4k held-out steps (simple-4k, comparator, gbrain-4k) do not run. Reason: at round-3 costs both scales project to about $2,120 with margin against $1,605 left on the Hard ledger, and calibration happens at 50k.
- **Primary endpoint.** The pooled 50k paired difference, gbrain minus fs, with the task-clustered bootstrap: `holdout_stats.py --hard-headline gbrain-hard,fs --simple fs`. fs was already the preregistered 50k comparator; no comparator is selected from results.
- **Arms and order at 50k.** gbrain and fs on all five models first (the primary endpoint), then the oracle reference, then pg on all five models and memory on Sonnet 5.5 and GPT-6.1 Sol (secondary) as the remaining Hard ledger allows. Each batch runs only after its projection plus 15% fits the remaining balance. With pg run on every model, the simultaneous intervals cover gbrain against fs and pg; otherwise against fs only.
- **Models.** Unchanged: Sonnet 5.5, Opus 5.5, GPT-6.1 Sol, Fable 5.1, GPT-6 Astra, the newest frontier models of each family.
- **Unchanged.** The freeze rule, the freeze check on five models, the sealed validation variant, the authorization ($4,350) and the Hard ledger cap ($1,794).

### A3 (2026-10-06): GPT-6 Astra leaves the held-out run; last calibration round

Garry, 2026-10-06, after calibration round 4, relayed by GBRA-40: "take all recommendations for GBRA-39 option #1".

- **Models.** The held-out 50k run uses Sonnet 5.5, Opus 5.5, GPT-6.1 Sol and Fable 5.1. GPT-6 Astra does not run there. GPT-6.1 Sol remains the newest frontier GPT, so each family keeps its newest frontier model (the project model rule). Reason: at round-4 costs the freeze check and the primary 50k batch (gbrain and fs on five models) project to $1,233 with margin against $1,445 left on the Hard ledger, which leaves no room for a fifth calibration round; GPT-6 Astra is about $250 of the primary batch. Memory still runs on Sonnet 5.5 and GPT-6.1 Sol.
- **Calibration.** Round 5, the last the plan allows, keeps Sonnet 5.5 and GPT-6 Astra as calibration models so its results compare with rounds 1 to 4; the freeze check still covers Opus 5.5, Fable 5.1 and GPT-6.1 Sol, so every held-out model is seen before the freeze. Round 5 asks about 3 to 4 accounts per H2 to H5 question and draws H1 sets of 5 to 10 members (knobs.round-5.json). After round 5 the knobs freeze if the freeze rule passes; if it fails, the result and the knobs go to Garry before any freeze check.
- **Unchanged.** Everything else in A1 and A2, the authorization ($4,350) and the Hard ledger cap ($1,794).
