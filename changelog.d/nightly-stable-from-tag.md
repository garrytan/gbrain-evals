### The nightly check reads gbrain's stable release from its tag at launch

- **What changed.** `--ref stable` in [the nightly gbrain check](docs/nightly.md) now runs the commit that gbrain's
  `stable` tag points to when the night starts, read from the gbrain clone's remote with `git ls-remote` and fetched
  if the clone lacks it. Before, the commit was written into `eval/runner/nightly/run.ts` (v0.60.717.0) and had to be
  bumped by hand each time the tag moved; on 2026-11-17 the tag pointed to v0.60.733.0.
- **Where it fails.** A night whose remote can't be reached, has no `stable` tag or can't serve the commit doesn't
  start: the runner exits 1 with the reason. It never falls back to an older commit or to the clone's own `stable` tag,
  which a plain `git fetch` doesn't move.
- **What it records.** `night.json` gains a `stable` field with the remote, the tag object when the tag is annotated,
  and when it was read. The stable night's report names them under its title, and master's section against stable now
  names the stable commit and its version. `--resume` keeps the commit the night started on.
