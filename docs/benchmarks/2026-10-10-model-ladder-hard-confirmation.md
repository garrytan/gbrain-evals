# Cat 40 Hard confirmation: gbrain ahead of plain files on fresh and sealed 55,000-document companies (2026-10-10)

## The finding

On two worlds no development agent had seen, frontier agents using gbrain finished more hard company questions than the same agents using plain files with grep, for every model tested. This is the preregistered confirmation of the Cat 40 Hard fix wave ([preregistration](https://github.com/garrytan/gbrain-evals/blob/plan/cat40-hard-fix/docs/plans/2026-10-07-cat40-hard-fix/PREREG.md), [full results](https://github.com/garrytan/gbrain-evals/blob/plan/cat40-hard-fix/docs/plans/2026-10-07-cat40-hard-fix/RESULTS.md)).

| World | gbrain | fs | gbrain − fs (pooled over three models) | 95% CI | Preregistered wording |
|---|---|---|---|---|---|
| M: main generator, fresh seed 20261021 | 78.7% | 71.0% | **+7.7 points** | [+2.7, +12.7] | ahead |
| S: sealed generator, private seed | 66.0% | 53.0% | **+13.0 points** | [+7.7, +18.3] | ahead |

Both lower bounds are above 0, so under the preregistered rule gbrain is "ahead" in both worlds, the kill criterion does not fire, and the general claim is allowed. The intervals are task-clustered bootstraps (10,000 resamples of tasks, all models resampled together).

gbrain v0.60.139.0 ([`3e4ff61ce`](https://github.com/garrytan/gbrain/commit/3e4ff61ce1ac553581fb5c1eb905cf48541fe344), gbrain #6271), measured 2026-10-10 to 2026-10-11, starter surface, reranking on. #6271 has since merged as gbrain v0.60.174.0 (master `0df9f2ee7`); the shipped build derives identical aliases, mention links and card identity lines to the confirmed `3e4ff61ce` on worlds M and S, the calibration world and the v1 world, so the result applies to it. This build replaces the result of [October 7](2026-10-07-model-ladder-hard.md), where gbrain v0.60.95.0 trailed plain files by 11.3 points on a different held-out world; that result still describes v0.60.95.0.

## The experiment

- **Worlds.** Generator v2 at the round-5 frozen knobs (`knobs.frozen.json`, digest `37a16085…`), 50k scale, 100 tasks each (20 per family: H1 aggregation, H2 value history, H3 look-alike accounts, H4 conflicting sources, H5 multi-session memory). M has 55,838 documents (digest `6f08629e…`); S has 55,128 (digest `61870796…`), from a generator whose code no development agent read, on a seed that stays on the owner's machine.
- **Arms.** `gbrain` (MCP, starter surface, 5 slots per world) and `fs` (`list_dir`, `grep`, `read_file`); `oracle` (the task's evidence handed over) checks each world.
- **Models.** Claude Sonnet 5.5, Claude Opus 5.5, GPT-6.1 Sol; judge GPT-6.1 Sol; 16-turn cap; Hard tool limits; repeat 1.
- **Cells.** 600 per world. Every cell has exactly one recorded, harness-clean attempt.

## Results

| Model | M gbrain | M fs | M Δ (95% CI) | S gbrain | S fs | S Δ (95% CI) |
|---|---|---|---|---|---|---|
| Sonnet 5.5 | 69 | 60 | +9 [−2, +20] | 47 | 41 | +6 [−4, +16] |
| Opus 5.5 | 79 | 73 | +6 [−2, +15] | 70 | 51 | +19 [+11, +27] |
| GPT-6.1 Sol | 88 | 80 | +8 [+3, +14] | 81 | 67 | +14 [+8, +21] |

Successes out of 100 tasks; no model is at a ceiling on either arm.

| Family (of 60) | M gbrain | M fs | S gbrain | S fs |
|---|---|---|---|---|
| H1 | 18 | 11 | 4 | 0 |
| H2 | 54 | 46 | 46 | 38 |
| H3 | 57 | 48 | 37 | 12 |
| H4 | **47** | **56** | 52 | 49 |
| H5 | 60 | 52 | 59 | 60 |

## Limits

- **M's H4 has gbrain behind fs**: 47 vs 56 of 60, −15 points, 95% CI [−23.3, −6.7]. Conflicting sources on the main generator's wording remain a gbrain weakness. On S, H4 is 52 vs 49.
- **S's H1 is at the floor on both arms** (4 and 0 of 60) although the oracle answered all 60 H1 cells correctly: neither arm assembles the member set within 16 turns. S's H1 says almost nothing about either arm.
- **fs suffers more from corpus size at the fixed 16-turn cap.** On S, fs overflowed the context 22 times and hit a provider "request too large" once (gbrain 0), and hit the turn cap 116 times (gbrain 80). Part of gbrain's larger lead on S comes from fs running out of turns or context; a larger cap would probably narrow it.
- **gbrain is more often confidently wrong**: 22 vs 14 wrong answers of 300 on M and 16 vs 2 on S, mostly Sonnet. fs fails mostly by not answering in time.
- **Per model, only Sol (both worlds) and Opus (S) clear 0 on their own.** Sonnet's interval includes 0 in both worlds, and Opus's on M; the pooled result is the preregistered endpoint.

**Alias precision (2026-10-11).** Before merge, alias derivation was checked on the owner's own brain (6,616 entity pages, read only, labels kept on the owner's machine) and on 890 public English Wikipedia articles. The first rule was right on 47 of 72 labeled aliases on the real brain (multi-word 12 of 24). The anchored rule (v2) that ships was right on 25 of 25 there and on 20 of 25 on the public set (from 50 of 198), with multi-word captures right on 20 of 22 across both. The samples were too small to reach the plan's 0.85 Wilson bound or 150 labels, and Garry Tan accepted the anchored rule with multi-word captures on (2026-10-11). The anchored build derives identical aliases, mention links and card identity lines on worlds M and S, the calibration world and the v1 world, so this result applies to the shipped build. Counts and the decision: [development record](https://github.com/garrytan/gbrain-evals/blob/plan/cat40-hard-fix/docs/plans/2026-10-07-cat40-hard-fix/DEV-RECORD.md#alias-precision-check-2026-10-11).

## Cost and latency

| World | Model | gbrain $/success | fs $/success | gbrain agent p50 s | fs agent p50 s |
|---|---|---|---|---|---|
| M | Sonnet 5.5 | 0.85 | 1.71 | 63.7 | 56.5 |
| M | Opus 5.5 | 1.10 | 2.40 | 68.0 | 72.7 |
| M | Sol | 0.32 | 0.24 | 36.9 | 35.3 |
| S | Sonnet 5.5 | 1.41 | 2.22 | 70.2 | 52.9 |
| S | Opus 5.5 | 1.58 | 3.05 | 84.7 | 79.3 |
| S | Sol | 0.46 | 0.32 | 42.9 | 52.9 |

Agent plus gbrain-internal dollars over every attempt, judge excluded. gbrain is cheaper per success for both Claude models and slightly dearer for Sol. Each gbrain cell also restores its slot (median about 5 s). Every gbrain cell that made a hybrid search reranked (168 of 168 on M, 167 of 167 on S).

**Ledgers.** M $572.34 and S $775.63 booked (caps $900 each, raised from $650 by Garry Tan on 2026-10-10). Both include requests the provider rejected before generating (413s and prompts over the context window), which the harness then charged at their whole reservation: $37.67 on M and $212.05 on S. Actual spend is probably about $250 lower. The harness now settles those at the provider's reported usage, or $0: agent requests since gbrain-evals `a165ef57`, gbrain's own provider calls through the metering proxy since this report's release.

## Reproduce and inspect

```bash
D=docs/benchmarks/2026-10-10-model-ladder-hard-confirmation
python3 docs/benchmarks/2026-10-02-model-ladder/holdout/holdout_stats.py $D/main-cells/results.jsonl --hard-headline gbrain-hard,fs --simple fs
bun eval/runner/cat40/analyze.ts $D/main-cells/results.jsonl --expect-grid observed
```

- **World M** regenerates from its seed: `scripts/cat40-hard.sh step confirm-world` with `CONFIRM_WORLD=main` (file SHA-256 `99c53db0…`).
- **Outputs (M).** [`2026-10-10-model-ladder-hard-confirmation/`](2026-10-10-model-ladder-hard-confirmation/): `main-cells/` (results, experiment, receipts, served instructions and tools, gzipped transcripts), `main-oracle/`, `main-slots/`, the world manifest, and the analyzer and headline outputs ([holdout-stats-main.md](2026-10-10-model-ladder-hard-confirmation/holdout-stats-main.md), [analysis-main.md](2026-10-10-model-ladder-hard-confirmation/analysis-main.md)).
- **World S** stays sealed: only counts are published ([analysis-sealed.md](2026-10-10-model-ladder-hard-confirmation/analysis-sealed.md)); its records stay in owner custody.
- **Harness.** gbrain-evals `d0057206` (world, oracle, slots, M's first 464 cells) and `f761757e` (the $900 cap constant only; M's resume, S's slots and cells).
- **Keys.** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `VOYAGE_API_KEY`.

## Changelog

- 2026-10-11: first version.
- 2026-10-11: alias precision check added (counts only).
- 2026-10-11: #6271 recorded as merged (gbrain v0.60.174.0, master `0df9f2ee7`); released in gbrain-evals v0.10.74.
