# Receipts — LongMemEval ranker wave (2026-09-06)

Per-question rows from `gbrain eval longmemeval` (in-repo harness), compacted with `compact-harness-rows.py`
(keeps question_id, type, strict/any hits, retrieved + gold session ids, search meta and the summary line; drops the
full `retrieved[]` chunk rows and captured pools, which are 7 MB per arm).

- `A1-hybrid-rerank-off-autocut-off.ndjson` — parity arm (like-for-like with the 2026-09-02 receipt)
- `A2-hybrid-rerank-on-autocut-off.ndjson` — reranker on, cross-check
- `A3-hybrid-expansion-rerank-off-autocut-off.ndjson` — legacy expansion; `expansion_variants` recorded per row (the frozen variants every later expansion cell replays)
- `A4-default-rerank-on-autocut-on.ndjson` — the default that shipped before this wave; the autocut replay source (`phaseC-autocut-floor-replay.md`)
- `devslice40-budget*.ndjson` — the 40-question dev-slice budget sweep on A3's variants
- `A3prime-*.ndjson`, `A3primeR-*.ndjson` — the Phase A decision arms at the picked budget
- `phaseB-halfA-miss-diagnostics.md` — temporal/multi-session miss classes (half A of the decision set)
- `ranker-wave-arms.json` — all arms in the `RunnerOutput` shape (`harness-to-runner-output.py`), charted by
  `bun eval/runner/longmemeval-chart.ts ranker-wave-arms.json` → `ranker-wave-arms.headline.svg`, `ranker-wave-arms.per-type.svg`

Reproduce any arm with the commands in the report's "How to reproduce" section; the embedding cache makes every arm
after the first see byte-identical vectors.
