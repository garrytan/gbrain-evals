# Phase 4 cell manifests (frozen 2026-10-06)

Cell manifests for the [open-source memory shootout](../../../plans/2026-10-05-oss-memory-shootout/PLAN.md), Phase 4
(memory QA on LoCoMo dev, BEAM-100K dev and a LongMemEval-S slice), frozen with the
[preregistration](../../2026-10-06-oss-memory-shootout-preregistration.md) and amended by its A3 (a four-hour `/finish`
wait on every Mem0 cell and every vendor LongMemEval-S cell). Lease sizes come from the
Phase 2 pilots (`eval/systems/<name>/PILOT.md` on the vendor lane branches) times 1.5 headroom; a lease settles to the
spend its metering proxy recorded, so unused headroom returns to the campaign.

## Layout

- `campaign.json`: the campaign (one ledger, a $1,450 cap) and its parameters, frozen as `lme_s_limit` 100,
  `graphiti_beam_recipe` false and `gbrain_master_sha` `c5fb0201d1960a0a5a81c35d77718311b03154b7`:
  - `lme_s_limit` (default 100): the LongMemEval-S stratified slice; LongMemEval-S leases scale with it.
  - `graphiti_beam_recipe` (default true): whether Graphiti's `gpt-5.5` recipe runs on BEAM (lease about $137,
    scaled from LoCoMo, not measured).
  - `gbrain_master_sha` (`fill-at-freeze`): gbrain master for the primary contrast, resolved from `garrytan/gbrain`
    `origin/master` by the freezing commit. No lease is reserved while it is unfilled.
- `cells/<system>-<config>.json`: one file per system and configuration, plus `gbrain-legacy`, `gbrain-shootout`
  at the repository pin and `gbrain-shootout-master` at the frozen master SHA (recipe and common each), and the three
  D1 controls (`full-context`, `no-memory`, `plain-hybrid`). Letta has no passive
  memory API, so it has no memory-QA cells.
- `arms/`: the arms each cell runs (`bun eval/runner/memory-qa/run.ts --arms`): both retrieval policies, both
  context modes and the benchmark's preregistered reader, from one ingest. `retrieval-only.json` serves the second
  LoCoMo ingest (run-to-run variance). `d2-frontier-<benchmark>.json` adds the newest Opus, GPT, Sonnet and Fable
  readers on a 100-question slice.

## Run

    bun eval/runner/shootout-cell.ts init    --campaign docs/benchmarks/2026-10-06-oss-memory-shootout/manifests/campaign.json --state <dir>
    bun eval/runner/shootout-cell.ts reserve --campaign <same> --state <dir> --cell mem0-common-locomo-r1
    bun eval/runner/shootout-cell.ts launch  --campaign <same> --state <dir> --cell mem0-common-locomo-r1

Each vendor cell sets up the VM (`eval/systems/bootstrap.sh setup`), starts its stack against the cell's lease proxy,
runs memory-qa in multi-arm mode and stops the stack. Systems without parallel namespaces (Basic Memory, Cognee) split
LongMemEval-S into shard cells; the others run eight namespaces at once on a 16-vCPU VM.

D2 frontier readers replay the frozen contexts of a finished cell on the host, without the system:

    bun eval/runner/memory-qa/run.ts <the cell's selection flags> --system <the cell's system> \
      --arms docs/benchmarks/2026-10-06-oss-memory-shootout/manifests/arms/d2-frontier-<benchmark>.json \
      --replay --output <pulled cell output>/mqa --paid --budget-ledger <campaign ledger> --budget-run-id <campaign run>

## Open questions

- Main reader: the cells keep the runner's preregistered reader per benchmark (`gpt-4o-mini` on LoCoMo, `gpt-4o` on
  LongMemEval-S, `gpt-4.1-mini` on BEAM), which the pilots measured. Plan decision D2-A names GPT-4o as the one
  historical link on everything; switching LoCoMo and BEAM to GPT-4o raises their reading cost about 15 times.
- The gbrain, D1-control and D2 lines are estimates; none was piloted.
