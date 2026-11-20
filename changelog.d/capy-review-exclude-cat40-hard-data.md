- Code review before merge now leaves out the hard company questions' raw per-step run data in the arm folders inside
  `n1/` and `n2/` of `docs/benchmarks/2026-11-19-cat40-hard-newest/` and
  `docs/benchmarks/2026-11-19-cat40-hard-old-build-control/`, which hold every cell's attempts, receipts and served
  tool lists. The results pages, the preregistrations, the analysis JSON and each world's `oracle-gate.json` verdict
  stay in review. Nothing in CI recounts the excluded files, so a published number is checked against them only when
  someone reruns the run's analysis.
