Cells: 27. Spend in these records: $2.94.

| Model | capability (oracle) | master | gbrain advantage [95% CI] |
|---|---|---|---|
| claude-opus-5-5 | n/a | 100% | n/a |
| claude-sonnet-5-5 | n/a | 89% | n/a |
| gpt-6.1-sol | n/a | 100% | n/a |

Pooled advantage: NaN pts [NaN, NaN].
Slope of advantage on capability (0 models): n/a [n/a, n/a].

| Family | claude-opus-5-5 | claude-sonnet-5-5 | gpt-6.1-sol | slope [95% CI] |
|---|---|---|---|---|
| A | m:100% | m:100% | m:100% | n/a [n/a, n/a] |
| B | m:100% | m:67% | m:100% | n/a [n/a, n/a] |
| E | m:100% | m:100% | m:100% | n/a [n/a, n/a] |

| Stratum | claude-opus-5-5 | claude-sonnet-5-5 | gpt-6.1-sol |
|---|---|---|---|
| memory-only | master:100% | master:89% | master:100% |

| Arm | C output leaks | C context exposures | unsafe writes | unsupported claims/answer | missed evidence |
|---|---|---|---|---|---|
| master | 0/0 | 0/0 | 0 | n/a | 2% |

| Model | Arm | $/task | $/success | p50 s | p95 s | turns |
|---|---|---|---|---|---|---|
| claude-opus-5-5 | master | 0.175 | 0.175 | 61 | 102 | 4.4 |
| claude-sonnet-5-5 | master | 0.106 | 0.119 | 68 | 85 | 4.0 |
| gpt-6.1-sol | master | 0.046 | 0.046 | 73 | 99 | 4.6 |

Cost split per cell (`total_usd`: agent sessions plus gbrain provider calls, judge excluded; the columns sum to the total):

| Model | Arm | uncached input $ | cache write $ | cache read $ | output $ | gbrain provider calls $ | total_usd |
|---|---|---|---|---|---|---|---|
| claude-opus-5-5 | master | 0.0000 | 0.1363 | 0.0187 | 0.0202 | 0.0000 | 0.1752 |
| claude-sonnet-5-5 | master | 0.0000 | 0.0790 | 0.0169 | 0.0096 | 0.0000 | 0.1056 |
| gpt-6.1-sol | master | 0.0380 | 0.0000 | 0.0042 | 0.0037 | 0.0000 | 0.0460 |

Tool-result characters per cell, by tool:

| Model | Arm | characters by tool |
|---|---|---|
| claude-opus-5-5 | master | search 34,144, entity 9,374, get_page 7,807, query 3,246, get_backlinks 237, resolve_slugs 21 |
| claude-sonnet-5-5 | master | search 41,010, entity 12,358, get_page 6,539, get_backlinks 2,216, whoami 949 |
| gpt-6.1-sol | master | search 33,113, entity 11,645, get_page 9,957, get_backlinks 2,775, context_pack 1,300, whoami 163 |

Reconciliation against the budget ledger:

| Budget run | cells | cells $ | judge $ | slot builds $ | ledger $ | gap | |
|---|---|---|---|---|---|---|---|
| cat40-model-ladder-2026-10-07T16-05-34-871Z-f7ed00dd | 27 | 2.9410 | 0.0000 | 0.0000 | 2.9410 | 0.00% | ok |
