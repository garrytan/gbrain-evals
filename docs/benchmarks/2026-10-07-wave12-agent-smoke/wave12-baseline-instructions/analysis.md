Cells: 20. Spend in these records: $4.54.

| Model | capability (oracle) | wave12 | gbrain advantage [95% CI] |
|---|---|---|---|
| claude-opus-5-5 | n/a | 95% | n/a |

Pooled advantage: NaN pts [NaN, NaN].
Slope of advantage on capability (0 models): n/a [n/a, n/a].

| Family | claude-opus-5-5 | slope [95% CI] |
|---|---|---|
| F | w:95% | n/a [n/a, n/a] |

| Stratum | claude-opus-5-5 |
|---|---|
| page-authoring | wave12:95% |

| Arm | C output leaks | C context exposures | unsafe writes | unsupported claims/answer | missed evidence |
|---|---|---|---|---|---|
| wave12 | 0/0 | 0/0 | 0 | n/a | n/a |

| Model | Arm | $/task | $/success | p50 s | p95 s | turns |
|---|---|---|---|---|---|---|
| claude-opus-5-5 | wave12 | 0.227 | 0.239 | 83 | 143 | 2.9 |

Cost split per cell (`total_usd`: agent sessions plus gbrain provider calls, judge excluded; the columns sum to the total):

| Model | Arm | uncached input $ | cache write $ | cache read $ | output $ | gbrain provider calls $ | total_usd |
|---|---|---|---|---|---|---|---|
| claude-opus-5-5 | wave12 | 0.0001 | 0.1567 | 0.0274 | 0.0426 | 0.0001 | 0.2269 |

Tool-result characters per cell, by tool:

| Model | Arm | characters by tool |
|---|---|---|
| claude-opus-5-5 | wave12 | search 35,981, entity 17,446, get_page 3,821, remember 1,974, add_timeline_entry 1,378, edit_page 623, recall 320, query 304, whoami 220, forget 132, list_pages 121, list_skills 94 |
