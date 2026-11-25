- **The engine-bench speed runner no longer records 0 for memory or disk it could not measure.** On macOS
  `eval/runner/engine-bench/perf.ts` read memory from `/proc` and disk with `du -sb`, neither of which exists there, so
  both came back as 0 and looked like measurements. Each now records null with a method saying why. Where `/proc` is
  missing, memory falls back to the process's own sampled RSS, and disk falls back to `du -sk`, each under its own
  method name because neither is comparable with the Linux reading. A peak-RSS comparison with no reading on one side
  is reported as missing. Counted runs are Linux only, so no published number changes. New keyless tests cover each case.
