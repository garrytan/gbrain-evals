### Code review skips the generated data of the weekly line's three long dev worlds

- **What changed.** The code review that runs before a pull request is marked ready now leaves out the generated plans,
  questions and template fixtures of the three long public dev worlds, `bg1-dev-long-01` to `bg1-dev-long-03`, under
  `eval/data/changing-facts-v1/dev/worlds` and `eval/data/changing-facts-v1/fixtures/worlds`: about 2.3 MB of JSON that
  `eval/generators/changing-facts-gen.ts` writes. With them in, the pull request that adds those worlds has a 2.3 MB review
  diff, over the review's 2 MB limit, so no reviewer could read it.
- **What stays the same.** The files stay in the repository, and the generator that writes them and its `check` are still
  reviewed. Stage 1's three dev worlds keep their plans and questions in review. No score or verdict changes.
