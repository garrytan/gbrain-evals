- The duplicate-finder head-to-head can now run each memory system's tuned and tuning configurations, as its
  preregistration (docs/benchmarks/2026-11-18-entity-dedupe-h2h-preregistration.md, "Arms", "Budget" and Amendment 2)
  requires. Each bundle's `capability.json` records the dedupe knob its own docs offer at the pinned release, with
  links, and a grid of at most 4 settings: `ext-memory-bank` its entity merge floor (0.4 to 0.7 against the 0.3
  default) and `ext-graph-pipeline` its entity-consolidation similarity threshold (0.70 to 1.00 against 0.85).
  `ext-temporal-graph` and `ext-extract-first` have no documented dedupe setting, so their tuned cell is their default
  cell, with the source lines recorded.
- A memory cell's `--config` is `default`, `tuning:<setting>` (a grid setting, or `default` for the baseline) or
  `tuned --choice FILE`. The cell records the exact settings, the Ubicloud launcher starts the stack from them
  (`run.ts stack-env`), each shim reports them under `GET /health`, and the runner refuses a stack that reports
  anything else (`STACK_CONFIG_MISMATCH`). A tuning cell runs only on the held-out seed at 5 per family and a tuned
  cell never on it (`TUNING_SEED`, checked by the launcher too, before any VM starts).
- `run.ts choose` applies Amendment 2's rule with no operator pick: from the held-out slice runs of default and every
  grid setting, the lowest automatic false-merge rate (people and companies combined) among settings whose must-link
  recall is at most 5 points below default's, compared exactly; ties go to the setting nearest default, then higher
  recall, then grid order. A tuned cell needs that record (`TUNING_CHOICE`). When the rule keeps default, or the
  system has no documented setting, a tuned run refuses with `TUNED_IS_DEFAULT` and nothing runs.
- `run.ts dry-run` prices tuning only for systems with a documented setting: default plus each grid setting on the
  held-out slice, then one tuned run on the scored world.
