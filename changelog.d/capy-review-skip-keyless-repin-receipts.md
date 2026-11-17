### Code review skips the keyless re-pin's raw run receipts

- **What changed.** The code review that runs before a pull request is marked ready now leaves out
  `docs/benchmarks/2026-11-16-w0-keyless-repin/counted/**`, the raw run receipts of the November 16 keyless re-pin
  (JSON receipts, logs and tree listings, about 10.9 MB). With them in, that re-pin's results pull request has an 11.1 MB
  review diff, over the review's 2 MB limit, so no reviewer could read it.
- **What stays the same.** The files stay in the repository, and CI's receipt test still reads the JSON receipts. The
  results report, its preregistration and its repro and VM scripts are still reviewed. No score or verdict changes.
