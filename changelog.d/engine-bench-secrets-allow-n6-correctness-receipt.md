### The secrets check accepts N6's expired-token description in engine-bench correctness receipts

- The secrets check that runs before a push now accepts N6's prose description of its expired-token probe in the
  N6-over-HTTP Postgres receipt that engine-bench's correctness stage writes, at
  `docs/benchmarks/*/correctness/work/n6-http-postgres/receipt.json`. It is the same allowlist entry, with the same
  pattern, that already covered counted `n6pg` receipts; only that one path was added, so any other value there is
  still checked.
