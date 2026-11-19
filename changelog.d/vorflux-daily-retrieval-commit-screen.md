**You can now screen a day's commits for ones that may move a retrieval benchmark.**

### Added

- `scripts/retrieval-commit-screen.ts` reads a local git checkout of gbrain or gbrain-evals and tags every commit in a time window `yes`, `maybe` or `no`, with the files and search terms behind each tag, so you can tell which engine-bench or retrieval baselines need a rerun. It makes no network calls and changes no repository; the only file it writes is the `--json` path you give it.
- [The guide](scripts/retrieval-commit-screen.md) shows how to run the screen, the tagging rules and the known gaps, and `docs/README.md` links it.
