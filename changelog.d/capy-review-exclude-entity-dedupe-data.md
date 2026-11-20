- Code review before merge now omits eligible raw data from the duplicate-finder head-to-head. The rule covers
  JSON and JSONL files under `docs/benchmarks/2026-11-18-entity-dedupe-h2h/counted/` and `dev/` and external smoke-run
  records. Files named by code still get reviewed, as do the results page, preregistration, and analysis script and
  tables. The results PR adds a CI check that recounts the development numbers. To check the counted numbers against
  the raw data, rerun the analysis script.
