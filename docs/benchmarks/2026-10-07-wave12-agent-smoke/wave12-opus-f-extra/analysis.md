Cells: 10. Spend in these records: $2.02.

| Model | capability (oracle) | wave12 | gbrain advantage [95% CI] |
|---|---|---|---|
| claude-opus-5-5 | n/a | 90% | n/a |

Pooled advantage: NaN pts [NaN, NaN].
Slope of advantage on capability (0 models): n/a [n/a, n/a].

| Family | claude-opus-5-5 | slope [95% CI] |
|---|---|---|
| F | w:90% | n/a [n/a, n/a] |

| Stratum | claude-opus-5-5 |
|---|---|
| page-authoring | wave12:90% |

| Arm | C output leaks | C context exposures | unsafe writes | unsupported claims/answer | missed evidence |
|---|---|---|---|---|---|
| wave12 | 0/0 | 0/0 | 0 | n/a | n/a |

| Model | Arm | $/task | $/success | p50 s | p95 s | turns |
|---|---|---|---|---|---|---|
| claude-opus-5-5 | wave12 | 0.202 | 0.224 | 101 | 144 | 2.8 |

Cost split per cell (`total_usd`: agent sessions plus gbrain provider calls, judge excluded; the columns sum to the total):

| Model | Arm | uncached input $ | cache write $ | cache read $ | output $ | gbrain provider calls $ | total_usd |
|---|---|---|---|---|---|---|---|
| claude-opus-5-5 | wave12 | 0.0001 | 0.1356 | 0.0252 | 0.0410 | 0.0001 | 0.2020 |

Tool-result characters per cell, by tool:

| Model | Arm | characters by tool |
|---|---|---|
| claude-opus-5-5 | wave12 | search 27,878, entity 17,414, get_page 4,123, remember 1,920, edit_page 1,243, add_timeline_entry 451, recall 273, whoami 146, list_skills 28 |
