# Offline skill ranker eval (GBRA-377 Step 1)

Report: [../2026-11-07-skill-ranker-offline.md](../2026-11-07-skill-ranker-offline.md). Preregistration: [../2026-11-07-skill-ranker-offline-preregistration.md](../2026-11-07-skill-ranker-offline-preregistration.md).

Rerun the scoring (free, deterministic, about a minute) from this directory: `gunzip -kf data/catalog.jsonl.gz && bun scripts/embed.ts openai && bun scripts/embed.ts local && bun scripts/score.ts`. The embedding step needs `OPENAI_API_KEY` (about $0.01) and an Ollama server on localhost with `nomic-embed-text`.

- `scripts/`: `dump-gbrain.ts` and `build-catalog.ts` (catalog), `gen-turns.ts` and `judge.ts` (turns and labels), `split.ts` (frozen split), `gen-stress.ts` and `judge-stress.ts` (Amendment 2 stress set), `embed.ts`, `rank.ts` (the ranker prototype), `score.ts` (calibration, test, bars), `check-a2.ts`, `_probe.ts` (the dev probe behind Amendment 2), `lib.ts` (models, spend ledger).
- `data/`: catalog, areas, turns, dev and test splits, stress set, spring block.
- `results/`: writer and judge outputs, freeze hashes, calibration, per-arm results, verdict, spend ledger.
- `SOURCES.md` and `licenses/`: every catalog source with its pinned commit and licence.
