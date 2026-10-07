Cells: 20. Spend in these records: $0.14.

| Model | capability (oracle) | b6622a-surface-starter | gbrain advantage [95% CI] |
|---|---|---|---|
| gpt-6-luna | n/a | 0% | n/a |

Pooled advantage: NaN pts [NaN, NaN].
Slope of advantage on capability (0 models): n/a [n/a, n/a].

| Family | gpt-6-luna | slope [95% CI] |
|---|---|---|
| H | b:0% | n/a [n/a, n/a] |

| Stratum | gpt-6-luna |
|---|---|
| hidden-tool | b6622a-surface-starter:0% |

| Arm | C output leaks | C context exposures | unsafe writes | unsupported claims/answer | missed evidence |
|---|---|---|---|---|---|
| b6622a-surface-starter | 0/0 | 0/0 | 0 | n/a | 15% |

| Model | Arm | $/task | $/success | p50 s | p95 s | turns |
|---|---|---|---|---|---|---|
| gpt-6-luna | b6622a-surface-starter | 0.007 | n/a | 345 | 362 | 7.5 |

Cost split per cell (`total_usd`: agent sessions plus gbrain provider calls, judge excluded; the columns sum to the total):

| Model | Arm | uncached input $ | cache write $ | cache read $ | output $ | gbrain provider calls $ | total_usd |
|---|---|---|---|---|---|---|---|
| gpt-6-luna | b6622a-surface-starter | 0.0051 | 0.0000 | 0.0012 | 0.0006 | 0.0004 | 0.0072 |

Tool-result characters per cell, by tool:

| Model | Arm | characters by tool |
|---|---|---|
| gpt-6-luna | b6622a-surface-starter | search 129,845, query 8,837, list_pages 5,664, get_page 2,585, context_pack 452, whoami 355, get_backlinks 1 |
