### Merging this repository needs gstack 1.97.0.0 or later

- **What changed.** `.gstack/ship-policy.json` raises `min_gstack_version` from 1.96.0.0 to 1.97.0.0, so every gstack
  command that reads this repository's policy, `gstack-ship-queue land` included, needs 1.97.0.0 or later.
- **Why.** When main has moved past a pull request's merge base, land runs `bun run validate` and
  `bun eval/runner/prereg.ts` on the pull request merged onto main's tip, from its own process, which holds the merging
  account's GitHub token. gstack 1.97.0.0 is the first release that stops those checks from reading land's environment
  through `/proc` and stops anything a check leaves running before land goes on, so a merge run with 1.96 could expose
  that token to a check.
