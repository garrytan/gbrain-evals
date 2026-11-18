- The secrets check that runs before a push now accepts two harmless values from the duplicate-finder head-to-head
  harness: the memory-bank bundle's internal docker-network Postgres URL in that bundle's compose files (the same dummy
  password its compose file on main already carries), and the sentinel key value `must-not-reach-gbrain` in
  `test/eval/entity-h2h-cells.test.ts`. Each entry matches only that exact value, ending at a quote, space or line end,
  so any other password, host, database or key at those paths, or text appended to either value, is still flagged.
