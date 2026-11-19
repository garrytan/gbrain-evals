- Code review before merge now leaves out the hard company questions' raw per-step run data: the per-world folders
  `n1/` and `n2/` of `docs/benchmarks/2026-11-19-cat40-hard-newest/` and
  `docs/benchmarks/2026-11-19-cat40-hard-old-build-control/`, which hold every cell's attempts, receipts and served
  tool lists. The results pages, the preregistrations and the analysis JSON stay in review, and the check of each
  published number against its raw data still reads the excluded files.
