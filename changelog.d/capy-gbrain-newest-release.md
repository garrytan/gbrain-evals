### Tests run against gbrain's newest release, and one command keeps the pin there

- **What changed.** `package.json` and `bun.lock` move the `gbrain` dependency from v0.60.623.0 (`d253ec0ff`) to
  v0.60.733.0 (`6ce7195b4`), gbrain's newest release on 2026-11-16, 110 releases and 2,325 commits later.
  `bun eval/runner/gbrain-pin.ts bump` finds gbrain's newest release tag on master, moves the pin and `bun.lock` to
  it, and prints the commit range and gbrain's changelog in between; it refuses when the newest release is already
  pinned.
- **Why.** Every new run measures gbrain's newest release at the moment it starts, so results describe the gbrain
  people install today.
