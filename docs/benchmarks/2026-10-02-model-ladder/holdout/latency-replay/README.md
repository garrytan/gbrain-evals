# Latency replay outside the harness

Tool latency measured inside the Cat 40 runner is distorted by the runner itself: every model request rewrites the
whole budget ledger synchronously on the runner's event loop, which also hosts the proxy that carries gbrain's
embedding and reranking requests (see the report's "Cost and speed" section). These scripts time gbrain's MCP server
alone. Each one builds a single development-world slot, without an operator `ANALYZE`, and talks to it over stdio.
The builds were the release `ad7900d` and the fixed `238e12d8`.

Run from the gbrain-evals root, with gbrain checked out at `../gbrain` (or set `GBRAIN_REPO`):

```
bun docs/benchmarks/2026-10-02-model-ladder/holdout/latency-replay/latency.ts <ref> <label> plain|analyze
bun docs/benchmarks/2026-10-02-model-ladder/holdout/latency-replay/paced.ts <ref> <label> <seconds between calls>
TRANSCRIPTS=<held-out transcripts.jsonl> bun docs/benchmarks/2026-10-02-model-ladder/holdout/latency-replay/replay.ts <ref> <label>
```

`replay.ts` replays 40 `search`/`query` calls taken from the fixed build's held-out transcripts.

## Results (2026-10-03, one 4-core cloud machine, nothing else running)

`replay.ts`:

| Build | `search` p50 | `search` p90 | `search` max | `query` p50 |
|---|---|---|---|---|
| release `ad7900d` | 572 ms | 747 ms | 62,933 ms (first call) | 1,797 ms |
| fixed `238e12d8` | 341 ms | 618 ms | 937 ms | 1,551 ms |

`latency.ts`, first search of a new server, then five more:

| Build | Statistics | First search | Later searches | `get_page` | `put_page` | `remember` |
|---|---|---|---|---|---|---|
| release | product only | 57–59 s | 0.5–0.8 s | ~10 ms | 131 ms | 290–400 ms |
| release | + operator `ANALYZE` | 0.7 s | 0.4–0.6 s | ~12 ms | | 385 ms |
| fixed | product only | 0.9–1.4 s | 0.3–0.6 s | ~12 ms | 141 ms | 290–330 ms |
| fixed | + operator `ANALYZE` | 1.0 s | 0.3–0.4 s | ~12 ms | | 316 ms |

`paced.ts`, with 4 s between calls to match an agent's pace: every `remember` committed within 600 ms on both
builds, and none returned `write_pending`.
