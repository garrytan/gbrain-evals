# Cat 40 Hard calibration record

This file records every calibration round of the Hard generator: the knobs, the reason for each change, per-model and per-family results, stop kinds, oracle-failure classification and cost. The freeze-rule analyzer appends its table for each round (`bun eval/runner/cat40/analyze.ts <results.jsonl> --freeze-rule --round N --calibration-md docs/benchmarks/cat40-hard/calibration.md`). Rules: [RUNBOOK.md](RUNBOOK.md#calibration-rules).

Calibration uses seed 20261005, 10 tasks per family from a world generated at the held-out density of 20 per family (the first 10 of each family, the same indices every round), fs, pg and oracle, 1 repeat, `--judge gpt-6.1-sol`. gbrain never runs on this seed.

## Round plan

| Round | Knob file | Change from the previous round and why | Result |
|---|---|---|---|
| 1 | [knobs.round-1.json](knobs.default.json) (a copy of knobs.default.json, written by the first `calibrate` step) | starting values: 16 turns, 10 to 40 H1 members, 3 to 6 H2 changes, 1 to 3 H3 look-alikes, 3 to 5 H4 sources, one look-alike fact in each H5 chain | not run |

## Oracle failures

Each oracle failure in a round is read and classified here as a wording defect or an answer-key defect before any knob changes. The generator is frozen only with zero unresolved answer-key defects.

| Round | Task | Model | Classification | Resolution |
|---|---|---|---|---|

## Notes after the freeze

Dated notes for runner or scorer fixes that leave every world digest unchanged (CEO-F17, ENG-F6).

## Analyzer output
