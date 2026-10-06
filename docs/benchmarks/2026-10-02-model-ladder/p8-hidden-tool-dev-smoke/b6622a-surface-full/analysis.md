Cells: 20. Spend in these records: $0.05.

| Model | capability (oracle) | b6622a-surface-full | gbrain advantage [95% CI] |
|---|---|---|---|
| gpt-6-luna | n/a | 90% | n/a |

Pooled advantage: NaN pts [NaN, NaN].
Slope of advantage on capability (0 models): n/a [n/a, n/a].

| Family | gpt-6-luna | slope [95% CI] |
|---|---|---|
| H | b:90% | n/a [n/a, n/a] |

| Stratum | gpt-6-luna |
|---|---|
| hidden-tool | b6622a-surface-full:90% |

| Arm | C output leaks | C context exposures | unsafe writes | unsupported claims/answer | missed evidence |
|---|---|---|---|---|---|
| b6622a-surface-full | 0/0 | 0/0 | 0 | n/a | 20% |

| Model | Arm | $/task | $/success | p50 s | p95 s | turns |
|---|---|---|---|---|---|---|
| gpt-6-luna | b6622a-surface-full | 0.003 | 0.003 | 274 | 313 | 5.7 |

Cost split per cell (`total_usd`: agent sessions plus gbrain provider calls, judge excluded; the columns sum to the total):

| Model | Arm | uncached input $ | cache write $ | cache read $ | output $ | gbrain provider calls $ | total_usd |
|---|---|---|---|---|---|---|---|
| gpt-6-luna | b6622a-surface-full | 0.0010 | 0.0000 | 0.0013 | 0.0002 | 0.0000 | 0.0026 |

Tool-result characters per cell, by tool:

| Model | Arm | characters by tool |
|---|---|---|
| gpt-6-luna | b6622a-surface-full | search 23,432, recall 2,450, get_page 1,582, takes_list 1,103, list_pages 566, query 552, takes_search 504, context_pack 447, whoami 142, get_versions 0, get_timeline 0 |
