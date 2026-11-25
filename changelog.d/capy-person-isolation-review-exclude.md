- **What changed.** The code review that runs before a pull request is marked ready now leaves out the person-isolation
  run receipts under `docs/benchmarks/2026-11-24-person-isolation/`: about 3.3 MB of JSON that the runner writes. With
  them in, the pull request that adds the results has a 3.6 MB review diff, over the review's 2 MB limit, so no reviewer
  could read it.
- **What stays the same.** The receipts stay in the repository. The results page, the preregistration, its registry
  entry and the runner are still reviewed. No score or verdict changes.
