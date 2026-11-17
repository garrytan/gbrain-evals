### Code review skips the generated data of BG1's 17 extra dev worlds

- **What changed.** The code review that runs before a pull request is marked ready now leaves out the generated plans,
  questions and template fixtures of BG1's extra dev worlds, `bg1-dev-04` to `bg1-dev-20`, under
  `eval/data/changing-facts-v1/dev/worlds` and `eval/data/changing-facts-v1/fixtures/worlds`: about 6.8 MB of JSON that
  `eval/generators/changing-facts-gen.ts` writes. With them in, the pull request that adds those worlds has a 7.4 MB review
  diff, over the review's 2 MB limit, so no reviewer could read it.
- **What stays the same.** The files stay in the repository, the generator that writes them and its `check` are still
  reviewed, and so is the comparator cache scored on them. Stage 1's three dev worlds, `bg1-dev-01` to `bg1-dev-03`, keep
  their plans and questions in review. No score or verdict changes.
