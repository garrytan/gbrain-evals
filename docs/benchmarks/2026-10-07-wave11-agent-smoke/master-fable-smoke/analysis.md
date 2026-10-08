Cells: 10. Spend in these records: $7.25.

| Model | capability (oracle) | master | gbrain advantage [95% CI] |
|---|---|---|---|
| claude-fable-5-1 | n/a | 100% | n/a |

Pooled advantage: NaN pts [NaN, NaN].
Slope of advantage on capability (0 models): n/a [n/a, n/a].

| Family | claude-fable-5-1 | slope [95% CI] |
|---|---|---|
| F | m:100% | n/a [n/a, n/a] |

| Stratum | claude-fable-5-1 |
|---|---|
| page-authoring | master:100% |

| Arm | C output leaks | C context exposures | unsafe writes | unsupported claims/answer | missed evidence |
|---|---|---|---|---|---|
| master | 0/0 | 0/0 | 0 | n/a | n/a |

| Model | Arm | $/task | $/success | p50 s | p95 s | turns |
|---|---|---|---|---|---|---|
| claude-fable-5-1 | master | 0.725 | 0.725 | 139 | 170 | 3.0 |

Cost split per cell (`total_usd`: agent sessions plus gbrain provider calls, judge excluded; the columns sum to the total):

| Model | Arm | uncached input $ | cache write $ | cache read $ | output $ | gbrain provider calls $ | total_usd |
|---|---|---|---|---|---|---|---|
| claude-fable-5-1 | master | 0.0002 | 0.4907 | 0.0512 | 0.1829 | 0.0001 | 0.7251 |

Tool-result characters per cell, by tool:

| Model | Arm | characters by tool |
|---|---|---|
| claude-fable-5-1 | master | entity 28,229, search 14,676, get_page 7,608, edit_page 6,032, add_timeline_entry 4,523, remember 3,198, recall 1,135, forget 1,058, whoami 821, get_write_request 80 |

Reconciliation against the budget ledger:

| Budget run | cells | cells $ | judge $ | slot builds $ | ledger $ | gap | |
|---|---|---|---|---|---|---|---|
| cat40-model-ladder-2026-10-07T16-13-37-963Z-bc39d1d4 | 10 | 7.2514 | 0.0000 | 0.0000 | 7.2514 | 0.00% | ok |
