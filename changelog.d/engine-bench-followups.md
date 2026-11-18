### Engine-bench's keyword arm searches as gbrain does, and runs record the gbrain commit they loaded

- The LongMemEval-S keyword arm now runs gbrain's own search on a brain with no embedding provider, which falls back to
  passages holding any of the question's words. It used to call the engine's all-words keyword search, which returned
  nothing on 82 of 102 questions. Rerun at gbrain v0.60.737.0, both engines return the same full top 5 on 102 of 102
  questions, with recall_all@5 of 84.4%. The [results page](docs/benchmarks/2026-11-17-engine-bench.md) and a dated
  amendment to the [preregistration](docs/benchmarks/2026-11-17-engine-bench-preregistration.md#amendments) record the
  change, and the superseded first-run numbers stay on the page.
- Agreement in the LongMemEval-S report now counts the questions where every engine returned nothing.
- The correctness stage records the gbrain commit each check's runner loaded, and marks a run as an error when it
  differs from the stage's build.
- `bun eval/runner/engine-bench/launch-log.ts --out <log> -- <command>` writes a launcher's log with Ubicloud VM names,
  IP addresses and machine paths replaced; the two published 100,000-page launcher logs are rewritten the same way.
