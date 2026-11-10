# Offline skill ranker eval (GBRA-377 Step 1)

Report: [../2026-11-07-skill-ranker-offline.md](../2026-11-07-skill-ranker-offline.md). Preregistration: [../2026-11-07-skill-ranker-offline-preregistration.md](../2026-11-07-skill-ranker-offline-preregistration.md).

Rerun the scoring (free, deterministic, about a minute) from this directory: `gunzip -kf data/catalog.jsonl.gz && bun scripts/embed.ts openai && bun scripts/embed.ts local && bun scripts/score.ts`. The embedding step needs `OPENAI_API_KEY` (about $0.01) and an Ollama server on localhost with `nomic-embed-text`.

- `scripts/`: `dump-gbrain.ts` and `build-catalog.ts` (catalog), `gen-turns.ts` and `judge.ts` (turns and labels), `split.ts` (frozen split), `gen-stress.ts` and `judge-stress.ts` (Amendment 2 stress set), `embed.ts`, `rank.ts` (the ranker prototype), `score.ts` (calibration, test, bars), `check-a2.ts`, `_probe.ts` (the dev probe behind Amendment 2), `gate-probe.ts` (the no-skill gate probe behind gbrain's off-by-default `top_gate`), `lib.ts` (models, spend ledger).
- `data/`: catalog, areas, turns, dev and test splits, stress set, spring block.
- `results/`: writer and judge outputs, freeze hashes, calibration, per-arm results, verdict, spend ledger, and `gate-probe.json`.

The gate probe (free, deterministic, a few seconds; no keys) fits one threshold per candidate gate measure on dev plus stress-dev at 750 skills, keeping false suggestions on no-skill turns under 25%, and scores it on test plus stress-test at 250, 750 and 1,500 skills with Wilson 95% intervals. `rawN` is the measure gbrain ships as `top_gate`: the best skill's BM25 score divided by the catalog's maximum idf, `ln(1 + (n - 0.5) / 1.5)`. Rerun from this directory with `bun scripts/gate-probe.ts > results/gate-probe.json`; the output is byte-identical. At threshold 1.33 it leaves gated hit@5 at 0.26 / 0.27 / 0.28 against 0.52 / 0.56 / 0.61 ungated, with false suggestions at 0.19 / 0.17 / 0.19, so gbrain keeps the gate off by default.
- `SOURCES.md` and `licenses/`: every catalog source with its pinned commit and licence.

The paid steps' spend stop (`lib.ts`) checks the ledger of completed calls only. Calls started together (`gen-turns.ts` and `gen-stress.ts` send 45 at once) all pass the same check, and a billed reply that fails to parse never reaches the ledger. This run's concurrent batches started far below the stop, and its recorded spend is $11.07. A billed reply that failed to parse would be missing from that total, and the ledger alone can't rule that out. Fix both before reusing `lib.ts` for a run that could come near its $45 stop.
