- The duplicate-finder head-to-head can now run each memory system's tuned and tuning configurations, as its
  preregistration (docs/benchmarks/2026-11-18-entity-dedupe-h2h-preregistration.md, "Arms" and "Budget") requires.
  Each bundle's `capability.json` records the dedupe knob its own docs offer at the pinned release, with links, and a
  grid of at most 4 settings: `ext-memory-bank` its entity merge floor (0.4 to 0.7 against the 0.3 default) and
  `ext-graph-pipeline` its entity-consolidation similarity threshold (0.70 to 1.00 against 0.85). `ext-temporal-graph`
  and `ext-extract-first` document no knob for the dedupe they run, so they run default only, with the reason recorded.
- A memory cell's `--config` is `default`, `tuning:<setting>` or `tuned --choice FILE`. The cell records the exact
  settings, the Ubicloud launcher starts the stack from them (`run.ts stack-env`), each shim reports them under
  `GET /health`, and the runner refuses a stack that reports anything else (`STACK_CONFIG_MISMATCH`). A tuning cell
  runs only on the held-out seed at 5 per family and a tuned cell never on it (`TUNING_SEED`, checked by the
  launcher too, before any VM starts). A tuned cell needs a choice recorded by `run.ts choose` from a complete tuning
  cell for every grid setting (`TUNING_CHOICE`). `choose` records the operator's pick, the rule it cites and each
  tuning cell's held-out score; it picks nothing itself, because the preregistration does not yet say how the tuned
  setting is chosen.
