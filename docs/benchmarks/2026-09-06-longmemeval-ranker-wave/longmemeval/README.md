# Evidence from the September 6 ranking experiment

These files record the LongMemEval runs behind the [ranker-wave report](../../2026-09-06-longmemeval-ranker-wave.md). The report explains what changed and which settings earned a place in the defaults.

The per-question NDJSON files came from `gbrain eval longmemeval`, the harness in the gbrain repository. `compact-harness-rows.py` retained question IDs and types, strict and any-session hits, returned and expected session IDs, search metadata and the summary. It removed the full chunk rows and captured candidate pools, which occupied about 7 MB per arm. These files therefore preserve the scored decisions but not every intermediate piece of retrieved text.

| Files | What they record |
|---|---|
| `A1-hybrid-rerank-off-autocut-off.ndjson` | Ordinary hybrid search, matching the September 2 comparison settings |
| `A2-hybrid-rerank-on-autocut-off.ndjson` | The effect of enabling the reranker |
| `A3-hybrid-expansion-rerank-off-autocut-off.ndjson` | The old query-expansion behavior; saved alternative phrasings are reused by later expansion runs |
| `A4-default-rerank-on-autocut-on.ndjson` | The default before this change; source for replaying different result-cutoff thresholds |
| `devslice40-budget*.ndjson` | A 40-question development sample used to choose an expansion-weight budget |
| `A3prime-*.ndjson`, `A3primeR-*.ndjson` | The decision runs using that chosen budget |
| `phaseB-halfA-miss-diagnostics.md` | A generated explanation of where temporal and multi-session questions lost their evidence |
| `phaseC-autocut-floor-replay.md` | A generated replay of the result-cutoff rule |
| `ranker-wave-arms.json` | Aggregated measurements in the chart generator's input format |

The aggregate was converted with `harness-to-runner-output.py`. From the repository root, its charts can be generated with:

```sh
bun eval/runner/longmemeval-chart.ts \
  docs/benchmarks/2026-09-06-longmemeval-ranker-wave/longmemeval/ranker-wave-arms.json
```

See the parent report for exact run commands and code identities. The shared embedding cache gave the comparison arms identical vectors. Preserve these historical files; a fresh run should receive its own dated output path.
