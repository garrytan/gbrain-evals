### One page names the gbrain pin, and `bump` updates it

- **What changed.** [docs/gbrain-under-test.md](docs/gbrain-under-test.md#the-pin) is now the only page that names the
  gbrain version and commit this repository installs. README, the hub pages in `docs/` and `eval/` and three runner
  READMEs link to it, and the docs index names gbrain-evals by `VERSION` instead of a stale v0.10.186.
  `bun eval/runner/gbrain-pin.ts bump` rewrites that page's pin line, adds the page's changelog entry and writes a
  `changelog.d` fragment, so a re-pin pull request is `package.json`, `bun.lock`, that page and the fragment. The page
  says its descriptions were last read against v0.60.733.0. `bump` also refuses to move to a lower version, and says
  so when restoring `node_modules` after a failed install fails too.
- **Checks.** `scripts/verify-documentation-refresh.py` checks the pin sentence on that page only, and
  `test/eval/docs-pin-claims.test.ts` fails when another page's current state names a commit or release in a
  sentence about what this repository installs.
- **Why.** gbrain tags several releases a day and this repository re-pins daily, so a re-pin should change one page,
  not sixteen.
