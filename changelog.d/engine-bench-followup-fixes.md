### Engine-bench's launcher logs and resumed runs are more robust

- `launch-log.ts` now forwards Ctrl-C and termination signals to the command it runs, keeps standard output and error
  lines whole, keeps characters split across reads intact, logs a command that cannot start, replaces passwords in URLs,
  and leaves four-part version numbers ending in .0 (such as 1.97.0.0) alone while still replacing IP addresses,
  including all-numeric IPv6 ones.
- A LongMemEval-S run resumed from a stream written before the keyword arm changed no longer reuses those rows.
- The correctness stage treats a run whose receipt names no loaded gbrain commit, or a stage with no build commit, as an
  error.
- The [results page](docs/benchmarks/2026-11-17-engine-bench.md) notes that the keyword arm's 84.4% may read slightly
  higher than `gbrain search` would give, and that its reproduce commands run the current keyword arm.
