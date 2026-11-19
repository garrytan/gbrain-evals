### Score a gbrain build that reads several pages in one call

- [eval/runner/multi-evidence/ship-bar.ts](eval/runner/multi-evidence/ship-bar.ts) compares two multi-evidence dev-loop
  runs of the same Cat 40 items and agents, one on gbrain's newest release and one on a build whose `get_page` takes
  `slugs`, and checks the four-part ship bar for that build. The bar asks how many cells that need two or more pages
  use `slugs`, how much less tool-result text each cell receives, whether correct answers drop by more than 15
  points, and whether the sharing-contract test passes with `slugs`. Each number is paired by item and agent and comes
  with a 95% bootstrap interval over items. Only base-arm cells are compared.
- The dev loop's `--slots-from <ref>` builds the Cat 40 brains with one commit and runs the build under test on them, so
  two builds that change only how pages are read run on identical brains. `--cat40-slots` sets how many brains run at
  once. Each agent row now records the characters of every tool result it received, its `slugs` reads, the ones that
  read two or more pages, and results that listed pages under `omitted`; a batch read counts as opening only the pages
  it delivered.
- [test/eval/sharing-contract.test.ts](test/eval/sharing-contract.test.ts) also reads every page through a `get_page`
  batch that asks for it first and then for every other page, scoped and unscoped, on any build that has `slugs`. Those
  reads answer to the same contract as a single `get_page`, and any page the batch returns, first or later, that the
  same caller can't read on its own fails the test.
