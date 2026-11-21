- CI's harness Python tests run as three pytest processes at once instead of one. The two slowest files,
  `test_comparator_server.py` and `test_gbrain_provider.py` (135 s and 118 s of the 286 s single-process run in main's
  CI, mostly waiting on the comparator and gbrain processes they start), each run alone, and every other file runs
  together. In this PR's CI run the pytest step took 164 s instead of main's 298 s, and the `harness (pytest)` job
  4 min 14 s instead of 6 min 39 s. `bun run harness:test --junit-dir=<dir>` runs them (`eval/runner/harness-test.ts`),
  prints each line with its group's number, writes one JUnit report per group as `pytest-<n>.xml` and fails if any group
  fails or writes no report; without the flag it runs one pytest as before. `scripts/ci-tested-tree.ts` reads every
  `pytest-<n>.xml`, and `test/eval/ci-tested-tree.test.ts` checks that the groups run every harness test file exactly
  once.
