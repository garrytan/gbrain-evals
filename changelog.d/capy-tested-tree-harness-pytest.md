- CI's tested-tree record now lists the harness Python tests under `eval/harness-provider/tests/`, read from the JUnit
  report of the `harness (pytest)` job, which the `tested-tree` job now waits for. A pull request that adds or changes
  one of those tests can now clear gstack's pre-push test check from its green CI run instead of being refused as
  uncovered. The record fails when a tracked harness test file collects no tests, and no `/ship` lane's inventory
  lists these files, because no lane command runs them.
