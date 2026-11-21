- The credential check before a push no longer flags the four comparison labels (`memory-bank/frontier`,
  `memory-bank/bridge`, `extract-first/frontier` and `extract-first/bridge`) in the key fields of the narrowed RS1
  verdict's `docs/benchmarks/2026-11-08-rs1-narrow/results/aggregates.json`, which the RS1 results PR (#391) adds. The
  rule covers only that file and only those four values, so anything else in it is still checked.
