- **The engine-bench speed runner no longer records 0 for memory or disk it could not measure.** On macOS
  `eval/runner/engine-bench/perf.ts` read memory from `/proc` and disk with `du -sb`, neither of which exists there, so
  both came back as 0 and looked like measurements. Each now records null with a method saying why. Where `/proc` is
  missing, memory falls back to the process's own sampled RSS, and disk falls back to `du -sk`, each under its own
  method name because neither is comparable with the Linux reading. A peak-RSS comparison where one engine's own process
  memory has no reading is reported as missing. A local Postgres server whose container memory can't be read still
  counts as 0, as before. Counted runs are Linux only, so no published number changes. New keyless tests cover each case.
