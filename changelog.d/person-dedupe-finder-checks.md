### Scoring a real duplicate finder fails loudly on a stale or partial world

- `person-dedupe --write-world` refuses a folder that already has files, so a new world never mixes with pages left from an earlier one.
- Scoring a finder's output now needs `--finder-imports`, the `gbrain import --json` summaries, and fails unless every page of every source was imported, because a finder that never saw a page can't link it and would score as safe ([report](docs/benchmarks/2026-11-17-person-dedupe.md)).
