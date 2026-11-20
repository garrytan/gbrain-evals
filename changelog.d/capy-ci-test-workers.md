- CI's six test jobs each run four `bun test --shard` processes at once on an 8-vCPU runner, as 24 shards balanced by
  `test/timings.json`, instead of one process each on 4 vCPUs. A Bun test process keeps about one core busy, so most
  of each runner sat idle. `scripts/test-shards.ts --job=k/n` runs job k's shards (k, k+n, k+2n and k+3n), prints
  every line as it arrives with its shard's number, and writes each shard's JUnit report for the tested-tree record;
  `test/eval/ci-workflow.test.ts` checks that the six jobs together run each of the 24 shards exactly once. The job
  names, `tests (1)` to `tests (6)`, and gstack's CI carry profile are unchanged.
