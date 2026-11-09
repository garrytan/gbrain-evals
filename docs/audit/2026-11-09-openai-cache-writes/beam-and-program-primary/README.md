# BEAM-1M and program-primary repricing (GST-1887)

This tool reprices the gpt-6.1-sol figures in BEAM-1M and the program-primary lane that counted OpenAI cache writes
as plain input, and checks the figures that don't move. [The audit](../../2026-11-09-openai-cache-writes.md) cites its
output. It reads only files committed in this repository, makes no network or model call and needs no key.

Run it from the repository root:

```
bun docs/audit/2026-11-09-openai-cache-writes/beam-and-program-primary/reprice.ts
```

It rewrites [results.json](results.json) beside this file in about ten seconds. `git diff --exit-code` on that file
afterwards shows the committed results are reproduced.

## Prices

gpt-6.1-sol, dollars per million tokens, from OpenAI's pricing page as read on 2026-11-09:

| Input | Cached input | Cache write (30 minutes) | Output |
|---:|---:|---:|---:|
| 2.00 | 0.10 | 2.50 | 10.00 |

The long-context tier above 272,000 input tokens never applies here: the largest gpt-6.1-sol request this tool reads
has 108,844 input tokens (`long_tier`). No other OpenAI model in these reports has a cache-write price.

## Method

The corrected figure is the published one plus the cache-write premium, $0.50 per million cache-write tokens. Where
raw usage is committed (the program-primary lane's `usage.jsonl.gz`, the BEAM-1M S1 fixes' rows, W10's rows), the
cache-write tokens come from each response. The BEAM-1M failure analysis commits only each answer's input tokens, so
those arms use the measured rule in `cache_write_rule`: every committed gpt-6.1-sol and gpt-6-luna response reports its
uncached prompt less 3 tokens as cache writes, and a prompt under 1,027 tokens reports none. Five gpt-6.1-sol
responses in the evidence-brief confirmation are the only exceptions, long prompts that report no write at all. The
BEAM reader sends no cached prefix, as the S1 fixes' raw rows show, and answers served from the answer cache get no
premium.

The sealed confirmation commits no usage receipts, so its gpt-6.1-sol figures take the whole gap between each arm's
ledger (its `cost-*.json` files) and its cells' recorded dollars (`scores.jsonl.gz`). Those are upper bounds.

## Fields in results.json

- `long_tier`: the largest input tokens per request in each source, and whether any passes 272,000.
- `cache_write_rule`: by model, the usage records that follow the rule, the short prompts with no write, and every
  exception with its file.
- `beam_1m_failure_analysis`: per gpt-6.1-sol arm, the ledger dollars from the shard receipts, the premium, the
  corrected dollars and how far the ledger was low, in percent.
- `beam_1m_s1_fixes`: per arm, the ledger against the Sol reader dollars from the rows at the cache-write rate and at
  the input rate. The ledger already prices cache writes, so these figures don't move.
- `program_primary_lane`: per run directory and arm, gpt-6.1-sol dollars per cell (all-in and reader), published and
  corrected.
- `sol_dollar_ratios`: the gpt-6.1-sol dollar ratios the hard root cause, alias stack and candidate 1 reports give,
  published and corrected, against the 1.5x envelope.
- `proactive_brief_all_readers`: dollars per cell over all readers, brief off and on, published and corrected.
- `ledger_checks`: for runs whose cost files are the whole ledger, the gap between ledger and cells and how much of it
  the gpt-6.1-sol premium explains.
- `sealed_confirmation`: per arm, the ledger, the cells, the gap and the gpt-6.1-sol dollars per cell with its upper
  bound, and the stack-over-frozen ratio.
- `f6_dry_run`: the metering proxy's gpt-6.1-sol aggregates per cell against the cache-write and input rates. They
  match only the cache-write rate, so these figures were already right.
- `w10`: W10b and W10c gpt-6.1-sol reader dollars at the cache-write rate, list and batch, per question and per
  correct answer, which confirm the 2026-11-01 corrections.

Dollar values are rounded to six decimals. Run and program totals stay out of public docs, so the audit gives only
per-cell and per-arm figures and percentages from this file.
