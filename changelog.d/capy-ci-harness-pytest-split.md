- CI's harness Python tests run as three pytest processes at once instead of one: the two slowest files,
  `test_gbrain_provider.py` and `test_comparator_server.py` (about 2.5 minutes each, mostly waiting on the gbrain
  and comparator processes they start), each alone, and every other file together. `bun run harness:test
  --junit-dir=<dir>` runs them (`eval/runner/harness-test.ts`), prints each line with its group's number, writes one
  JUnit report per group as `pytest-<n>.xml` and fails if any group fails or writes no report; without the flag it
  runs one pytest as before. `scripts/ci-tested-tree.ts` reads every `pytest-<n>.xml`, and
  `test/eval/ci-tested-tree.test.ts` checks that the groups run every harness test file exactly once.
