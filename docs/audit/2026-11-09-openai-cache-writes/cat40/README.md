# Cat 40 cache-write and long-context repricing

`reprice.ts` reprices every committed Cat 40 row for OpenAI cache writes and OpenAI's long-context rates, regenerates
the affected generated pages with the repository's own analyzers, and checks each published dollar figure the
[cache-write audit](../../2026-11-09-openai-cache-writes.md#cat-40) corrects. It reads only committed files (the rows,
receipts, `ledger-runs.json` files, the generated pages and the reports), uses `git` only to check whether a ledger's
harness commit contains `8a8e502a`, writes its holdout-stats inputs to a temporary directory it removes, makes no
network call and needs no key.

```
bun docs/audit/2026-11-09-openai-cache-writes/cat40/reprice.ts
```

Run it from the repository root. It takes about 95 seconds, writes `results.json` beside itself and prints the
summary.

## Prices

Per million tokens, from developers.openai.com/api/docs/pricing, read 2026-11-09. A request with more than 272,000
input tokens is billed at the long-context rates for the whole request.

| Model | Input | Cached input | Cache write | Output | Long: input | Long: cached | Long: write | Long: output |
|---|---|---|---|---|---|---|---|---|
| gpt-6.1-sol | 2.00 | 0.10 | 2.50 | 10.00 | 4.00 | 0.20 | 5.00 | 15.00 |
| gpt-6-sol | 2.00 | 0.20 | 2.50 | 10.00 | 4.00 | 0.40 | 5.00 | 15.00 |
| gpt-6-luna | 0.10 | 0.01 | 0.125 | 0.50 | 0.20 | 0.02 | 0.25 | 0.75 |
| gpt-6-astra | 10.00 | 1.00 | 12.50 | 50.00 | 20.00 | 2.00 | 25.00 | 75.00 |

The tool stops if the budget ledger's standard rates differ from this table. It adds gpt-6-sol's cache-write rate to
the ledger's table in memory only, because the analyzers price their cost-split columns from it and the committed
table lacks that rate.

## Cache-write rule

A request whose whole prompt, uncached tokens plus cached reads, is 1,027 tokens or more reports its uncached prompt
less 3 tokens as cache writes, and a shorter request reports none. The
[BEAM-1M and lane tool](../beam-and-program-primary/README.md) measured this on every committed raw OpenAI usage
record (`cache_write_rule` in its `results.json`). It holds for 14,779 of 14,784 gpt-6.1-sol records and all 4,844
gpt-6-luna records, and the five exceptions report no write at all, so the rule can only overstate a premium. No raw
gpt-6-sol or gpt-6-astra record is committed, so the rule is assumed for both.

## Bounds

The rows keep each session's token totals and request count, not each request's usage, and every affected row records
`cache_write: 0`, so each session is repriced twice.

- **Low end:** cache writes only. The first request of a multi-request fs, fs-acl, pg, memory or oracle session may be
  under 1,027 tokens, so up to 1,026 of its tokens stay at the input rate, and every other request keeps 3 tokens
  there. No request is at the long-context rates, except in a single-request session whose prompt passed 272,000
  tokens.
- **High end:** every request writes its uncached prompt less 3 tokens, and every request of a session that could
  hold a prompt over 272,000 tokens is at the long-context rates. A session could hold one if its uncached input plus
  its output plus the smaller of its cache reads and its mean prompt passes 272,000 tokens; it must hold one if its
  mean prompt does.
- **Ledger cap:** for cells whose budget run was settled by a ledger at a harness commit containing `8a8e502a`, which
  prices both, the high end's long-context share is capped per run at that ledger's surplus over the low-end rows.

## Output

`results.json` holds one line per figure, page, session group and ordering.

- `prices_per_million`, `long_tier_above_input_tokens`: the table above.
- `summary`: counts of row files with an affected model, generated pages, committed generated lines that reproduce,
  generated lines and cells that move, report figures and those that move, figures whose original doesn't reproduce,
  sessions that could and must pass 272,000 tokens (each cell counted once), budget runs with a ledger cap, ledger
  commits missing from history, and ordering changes.
- `report_figures`: one entry per published figure. `id`, `doc` and `line` locate it, `what` says what it is
  and `published` is the doc's original value. `reproduces` is false when the original rows don't give the published
  value at its rounding. Value figures carry `original`, `lower` and `upper`; spend figures give only `now` as a
  percentage. `now` is the corrected value or range, `moves` whether it differs from the published value, and
  `long_tier` whether the high end includes the long-context rates.
- `generated_pages`: one entry per regenerated page, with its audit `anchor`, the affected `models`,
  `long_tier`, line counts and `moved`, the cells that change (`line`, `row`, `col`, `was`, `now`; spend lines
  give `now` as a percentage).
- `long_tier_sessions`: per row file, model and arm, the sessions, and how many could and must pass 272,000 tokens.
  Row files that repeat cells held elsewhere are left out.
- `order_changes`: each pair of models within an arm, or arms within a model, whose `$/task` or `$/success` order
  flips at the low (`lower`) or high (`upper`) end.

## Changelog

- 2026-11-09: cache writes follow the measured rule (uncached prompt less 3 tokens, none under 1,027 tokens) instead
  of the whole uncached prompt from 1,024 tokens.
- 2026-11-09: first version (GST-1887).
