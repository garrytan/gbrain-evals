- Code review before merge now leaves out the duplicate-finder head-to-head's raw run data: the JSON and JSONL files
  under `docs/benchmarks/2026-11-18-entity-dedupe-h2h/counted/` and `dev/`, and each memory system's
  `entity-h2h-smoke-run.json`. The results page, the preregistration, the analysis script, its paired JSON and tables,
  and the data folders' README stay in review. Only the development numbers are recounted in CI; the counted numbers
  are checked against the excluded files only when someone reruns the analysis script.
