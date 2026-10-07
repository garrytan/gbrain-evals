Cells: 10. Spend in these records: $7.43.

| Model | capability (oracle) | wave11 | gbrain advantage [95% CI] |
|---|---|---|---|
| claude-fable-5-1 | n/a | 100% | n/a |

Pooled advantage: NaN pts [NaN, NaN].
Slope of advantage on capability (0 models): n/a [n/a, n/a].

| Family | claude-fable-5-1 | slope [95% CI] |
|---|---|---|
| F | w:100% | n/a [n/a, n/a] |

| Stratum | claude-fable-5-1 |
|---|---|
| page-authoring | wave11:100% |

| Arm | C output leaks | C context exposures | unsafe writes | unsupported claims/answer | missed evidence |
|---|---|---|---|---|---|
| wave11 | 0/0 | 0/0 | 0 | n/a | n/a |

| Model | Arm | $/task | $/success | p50 s | p95 s | turns |
|---|---|---|---|---|---|---|
| claude-fable-5-1 | wave11 | 0.743 | 0.743 | 136 | 207 | 2.7 |

Cost split per cell (`total_usd`: agent sessions plus gbrain provider calls, judge excluded; the columns sum to the total):

| Model | Arm | uncached input $ | cache write $ | cache read $ | output $ | gbrain provider calls $ | total_usd |
|---|---|---|---|---|---|---|---|
| claude-fable-5-1 | wave11 | 0.0002 | 0.4952 | 0.0521 | 0.1955 | 0.0002 | 0.7432 |

Tool-result characters per cell, by tool:

| Model | Arm | characters by tool |
|---|---|---|
| claude-fable-5-1 | wave11 | entity 27,020, search 15,716, get_page 6,519, edit_page 6,022, add_timeline_entry 4,497, remember 3,842, recall 1,856, forget 1,835, whoami 293, get_write_request 80 |

Reconciliation against the budget ledger:

| Budget run | cells | cells $ | judge $ | slot builds $ | ledger $ | gap | |
|---|---|---|---|---|---|---|---|
| cat40-model-ladder-2026-10-07T16-14-28-158Z-ab4dd644 | 10 | 7.4320 | 0.0000 | 0.0000 | 7.4320 | 0.00% | ok |
