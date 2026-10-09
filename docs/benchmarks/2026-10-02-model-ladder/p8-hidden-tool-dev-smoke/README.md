# Family H (hidden tool) dev smoke, 2026-10-05

**Finding.** The 20 hidden-tool tasks in the dev wide world are solvable when
gbrain lists its full tool set and are not solved when the model only sees the
starter or verbs list. With `gpt-6-luna` on the `gbrain` arm, 1 repeat, the
P8 build answered 17 of 20 with every tool advertised and 0 of 20 with the
starter list advertised, although the same tools stayed callable. This is a
harness check that the family measures what it is meant to measure. It is one
cheap model and one repeat, so it is not evidence for the held-out
advertised-surface decision, which uses the four preregistered models.

<a id="correction-2026-10-09"></a>

> **Correction, 2026-10-09: every cell searched without gbrain's reranker.** Each restored slot brain kept the slot build's metering-proxy port in its Voyage URL, and that port was closed when the cells ran, so every rerank request failed and gbrain quietly returned unreranked results (fixed in gbrain-evals #76, commit `7709a70`, and #109). No cell's metered gbrain calls include a rerank request: 0 of 20 in each of the five sets and 0 of 2 in the pilot ([audit](../../2026-10-08-program-primary-hard/root-cause/restore-audit.json)). Every row is the gbrain arm under the same condition, so the comparison between listed surfaces stays internally valid. The original numbers stay as measured. For scale, the only measurement of the reranker's effect comes from a different world and tier: on the Cat 40 Hard development world, Sonnet 5.5 on gbrain `8e11aa1f3` finished 21 of 50 tasks with reranking and 19 of 50 without (7 tasks won, 5 lost, within noise; gbrain-evals [#76](https://github.com/garrytan/gbrain-evals/pull/76), `docs/benchmarks/2026-10-07-model-ladder-hard.md`). It is context, not a correction factor.

## The tasks

Each H task asks for a renewal forecast that revenue operations keeps as takes
on a forecast page, for example "What renewal ARR does revenue operations
currently forecast for Ondrtiva Retail?" gbrain strips the takes table from
`get_page`, `search` and `query` results for MCP callers, so the answer is
reachable through `takes_list` or `takes_search`, which are outside the
starter and verbs lists. For half of the accounts an email quotes an earlier,
superseded forecast. The [protocol](../../2026-10-02-model-ladder-protocol.md#the-wide-world-and-the-hidden-tool-family)
describes the family.

## Results

World: `eval/data/model-ladder-wide-dev` (seed 20261002, template set A,
digest `79094a8a2cbb`), family H only (20 tasks). Model `gpt-6-luna`, 1
repeat, uncapped tool results, no judge. Builds: P8 candidate `6c958d6e2`
(gbrain-evals `b5ee8c6`) and its master merge base `6622a119e`, which predates
`mcp.advertised_surface`, so its comparison is the callable surface itself.

| Build | Tools callable | Tools listed | Success | Cells using takes tools | Answered a wrong value | $ |
|---|---|---|---|---|---|---|
| `6c958d6e2` | full | full | 17/20 | 20 | 0 | 0.062 |
| `6c958d6e2` | full | starter | 0/20 | 0 | 7 | 0.110 |
| `6c958d6e2` | full | verbs | 1/20 | 0 | 10 | 0.107 |
| `6622a119e` | full | full | 18/20 | 20 | 0 | 0.052 |
| `6622a119e` | starter | starter | 0/20 | 0 | 5 | 0.145 |

- With the full list the model went to `takes_list` in every cell. The misses
  were `UNKNOWN` or `NOT_ACCESSIBLE` answers, not wrong values.
- With the starter list the model never called a takes tool. It called
  `request_tools` once, with an empty list, and got nothing back. Wrong answers
  were mostly the superseded forecast from the email.
- With the verbs list the one success came from `synthesize`, which gathered
  the take and answered from it (a paid call inside gbrain). Takes are
  therefore reachable without the takes tools when a chat key is configured.
- No leaks, unsafe writes or tool errors in any cell.

Spend: $0.90 in the ledger `.budget/p8-h-smoke.sqlite`: two slot builds at
$0.21 each (8,814 embedding requests) and $0.48 of cells, the 2-task pilot
included.

## Reproduce

```sh
bun eval/generators/model-ladder-gen.ts --scale wide
bun eval/runner/cat40-model-ladder.ts --build-slots --gbrain <gbrain checkout>@6c958d6e2 \
  --world eval/data/model-ladder-wide-dev/world.json --slots 1 --slot-build-allowance-usd 0.5 \
  --budget-usd 0.6 --budget-ledger <ledger> --out <out>
bun eval/runner/cat40-model-ladder.ts --models gpt-6-luna --arms gbrain \
  --world eval/data/model-ladder-wide-dev/world.json --gbrain <gbrain checkout>@6c958d6e2 \
  --gbrain-label c6c958-callfull-adv-starter --surface full --advertised starter --slots 1 --families H \
  --transcripts --judge none --max-tool-chars none --budget-usd 0.5 --budget-ledger <ledger> --out <out>
```

The baseline rows use `@6622a119e` with `--surface full` or `--surface
starter` and no `--advertised`. Each directory holds the experiment binding,
receipt, per-cell results, run log, compressed transcripts and the analysis.

## Changelog

- 2026-10-09: [Correction](#correction-2026-10-09) added: all 102 cells searched without gbrain's reranker (stale metering-proxy port in restored slots; fixed in gbrain-evals #76 and #109). Original numbers unchanged.
