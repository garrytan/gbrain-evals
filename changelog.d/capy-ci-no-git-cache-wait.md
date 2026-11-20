### CI's checks start without waiting for the git cache job

- [.github/workflows/ci.yml](.github/workflows/ci.yml)'s check, test and harness jobs no longer wait for `git-cache`.
  They restore the newest saved copy of the repository's git objects as before, and on pull requests one was always
  there already, so waiting only added a round of runner start-up to every run. `tested-tree` now names `git-cache`
  directly, so a run whose cache job failed still records no tested tree.
