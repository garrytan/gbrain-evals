### CI's tested-tree job starts faster

- [.github/workflows/ci.yml](.github/workflows/ci.yml)'s `tested-tree` job, the last one every run waits for, no longer
  restores the cached `.git` folder. It checks out only `scripts/` with no file contents beyond them, which is all
  [scripts/ci-tested-tree.ts](scripts/ci-tested-tree.ts) reads: the tracked file list, the commit's tree id and the
  JUnit reports.
