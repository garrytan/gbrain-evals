Cells: 10. Spend in these records: $2.05.

| Model | capability (oracle) | baseline | gbrain advantage [95% CI] |
|---|---|---|---|
| claude-opus-5-5 | n/a | 90% | n/a |

Pooled advantage: NaN pts [NaN, NaN].
Slope of advantage on capability (0 models): n/a [n/a, n/a].

| Family | claude-opus-5-5 | slope [95% CI] |
|---|---|---|
| F | b:90% | n/a [n/a, n/a] |

| Stratum | claude-opus-5-5 |
|---|---|
| page-authoring | baseline:90% |

| Arm | C output leaks | C context exposures | unsafe writes | unsupported claims/answer | missed evidence |
|---|---|---|---|---|---|
| baseline | 0/0 | 0/0 | 0 | n/a | n/a |

| Model | Arm | $/task | $/success | p50 s | p95 s | turns |
|---|---|---|---|---|---|---|
| claude-opus-5-5 | baseline | 0.205 | 0.228 | 109 | 131 | 2.9 |

Cost split per cell (`total_usd`: agent sessions plus gbrain provider calls, judge excluded; the columns sum to the total):

| Model | Arm | uncached input $ | cache write $ | cache read $ | output $ | gbrain provider calls $ | total_usd |
|---|---|---|---|---|---|---|---|
| claude-opus-5-5 | baseline | 0.0001 | 0.1362 | 0.0261 | 0.0426 | 0.0001 | 0.2051 |

Tool-result characters per cell, by tool:

| Model | Arm | characters by tool |
|---|---|---|
| claude-opus-5-5 | baseline | search 26,627, entity 17,467, get_page 3,180, add_timeline_entry 2,275, remember 2,206, edit_page 653, recall 344, forget 264, whoami 146, list_skills 56 |
