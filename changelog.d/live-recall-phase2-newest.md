### Live recall phase 2 can be measured again at gbrain's newest release, beside the build it was published on

- **What changed.** Phase 2's preregistration adds a dated amendment
  ([docs/benchmarks/live-recall/PHASE2-PREREGISTRATION.md](docs/benchmarks/live-recall/PHASE2-PREREGISTRATION.md#2026-11-16-amendment-arm-b-at-gbrains-newest-release)):
  arm B runs again at gbrain v0.60.733.0 and at 0.60.613.0 on the same day, on phase 2's 99 frozen tasks.
  `tasks.ts run --reference-build --privacy-reference <newest checkout>@<commit>` lets 0.60.613.0 read today's brain
  only after a read-only check that it would show no page the newest build hides, and phase 2's passing judge check
  carries over only while the judge's files and requests match phase 2's runner byte for byte. `tasks.ts compare` pairs
  the two runs per task, reuses phase 2's stored arm A after checking its task file, freeze, runner and harness, and
  writes aggregates only (`live-recall-build-compare/v1`, in
  [docs/benchmarks/live-recall/SCORECARD.md](docs/benchmarks/live-recall/SCORECARD.md#build-compare-live-recall-build-comparev1)).
- **Why.** README's first two rows quote phase 2, measured at gbrain 0.60.613.0. A published gbrain number is
  re-measured at the newest release rather than defended, and running both builds on the same day keeps a change in
  the brain's data from reading as a change in gbrain.
