### The secrets check accepts two harmless values in the duplicate-finder head-to-head harness

- The secrets check that runs before a push now accepts the memory-bank bundle's internal docker-network Postgres URL
  in that bundle's compose files (the same dummy password its compose file on main already carries), and the
  sentinel key value `must-not-reach-gbrain` in `test/eval/entity-h2h-cells.test.ts`. Each entry is anchored to that
  exact value, so any other password, host or key at those paths is still flagged.
