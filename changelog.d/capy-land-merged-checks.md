### A pull request that is behind main merges only after checks on the merged result

- **What changed.** `.gstack/ship-policy.json` adds `land.merged_checks`: `bun run validate` and
  `bun eval/runner/prereg.ts`. When main has moved past a pull request's merge base, `gstack-ship-queue land` builds
  the pull request merged onto main's tip in a throwaway worktree, runs both checks there and merges only when both
  pass. A failure refuses the merge with `QUEUE_LAND_MERGED_CHECKS`. Land runs the checks only with
  `--allow-repo-commands`.
- **Why.** Before this, land merged a branch that was behind main with only a `STALE_BASE: warn` line, so a break that
  needs both sides, such as a new link to a page main has just renamed, could reach main without a check. The other
  way round, merging main into every stale branch and rerunning CI, needed a full CI run per merge.
- **Releases without `gh`.** [CLAUDE.md](CLAUDE.md) gives the release steps: `gstack-release-stamp open`, run with
  `gh` switched off, sets the next version, folds the entries into CHANGELOG.md and pushes `release/<version>`; the
  pull request is opened from that branch without `gh` and merges with `gstack-ship-queue land` at its green head.
