Cells: 120. Spend in these records: $13.63.

| Model | capability (oracle) | master | gbrain advantage [95% CI] |
|---|---|---|---|
| claude-opus-5-5 | n/a | 88% | n/a |
| claude-sonnet-5-5 | n/a | 100% | n/a |
| gpt-6.1-sol | n/a | 100% | n/a |

Pooled advantage: NaN pts [NaN, NaN].
Slope of advantage on capability (0 models): n/a [n/a, n/a].

| Family | claude-opus-5-5 | claude-sonnet-5-5 | gpt-6.1-sol | slope [95% CI] |
|---|---|---|---|---|
| C | m:100% | m:100% | m:100% | n/a [n/a, n/a] |
| F | m:75% | m:100% | m:100% | n/a [n/a, n/a] |

| Stratum | claude-opus-5-5 | claude-sonnet-5-5 | gpt-6.1-sol |
|---|---|---|---|
| memory-only | master:100% | master:100% | master:100% |
| page-authoring | master:75% | master:100% | master:100% |

| Arm | C output leaks | C context exposures | unsafe writes | unsupported claims/answer | missed evidence |
|---|---|---|---|---|---|
| master | 0/60 | 0/60 | 0 | n/a | 0% |

| Model | Arm | $/task | $/success | p50 s | p95 s | turns |
|---|---|---|---|---|---|---|
| claude-opus-5-5 | master | 0.200 | 0.229 | 81 | 110 | 4.0 |
| claude-sonnet-5-5 | master | 0.099 | 0.099 | 73 | 97 | 3.1 |
| gpt-6.1-sol | master | 0.042 | 0.042 | 80 | 110 | 5.0 |

Cost split per cell (`total_usd`: agent sessions plus gbrain provider calls, judge excluded; the columns sum to the total):

| Model | Arm | uncached input $ | cache write $ | cache read $ | output $ | gbrain provider calls $ | total_usd |
|---|---|---|---|---|---|---|---|
| claude-opus-5-5 | master | 0.0001 | 0.1483 | 0.0262 | 0.0258 | 0.0001 | 0.2004 |
| claude-sonnet-5-5 | master | 0.0000 | 0.0683 | 0.0200 | 0.0104 | 0.0001 | 0.0988 |
| gpt-6.1-sol | master | 0.0301 | 0.0000 | 0.0068 | 0.0046 | 0.0002 | 0.0416 |

Tool-result characters per cell, by tool:

| Model | Arm | characters by tool |
|---|---|---|
| claude-opus-5-5 | master | search 35,718, entity 14,182, query 4,098, get_page 2,224, remember 1,124, get_backlinks 541, list_pages 435, recall 424, edit_page 150, whoami 73, resolve_slugs 22, list_skills 4 |
| claude-sonnet-5-5 | master | search 26,378, entity 17,969, edit_page 2,899, get_page 2,439, recall 1,771, whoami 1,132, add_timeline_entry 781, remember 556, query 499, list_skills 359, list_pages 87 |
| gpt-6.1-sol | master | search 23,798, entity 8,859, get_page 4,152, edit_page 3,115, query 2,616, context_pack 2,227, remember 855, whoami 842, recall 184, resolve_slugs 43, list_skills 32, list_pages 0 |

Reconciliation against the budget ledger:

| Budget run | cells | cells $ | judge $ | slot builds $ | ledger $ | gap | |
|---|---|---|---|---|---|---|---|
| cat40-model-ladder-2026-10-07T15-37-07-264Z-7f1c93be | 120 | 13.6325 | 0.0000 | 0.0000 | 13.6325 | 0.00% | ok |
