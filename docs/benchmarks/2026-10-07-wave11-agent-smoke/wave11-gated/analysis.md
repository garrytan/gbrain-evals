Cells: 120. Spend in these records: $14.03.

| Model | capability (oracle) | wave11 | gbrain advantage [95% CI] |
|---|---|---|---|
| claude-opus-5-5 | n/a | 90% | n/a |
| claude-sonnet-5-5 | n/a | 100% | n/a |
| gpt-6.1-sol | n/a | 100% | n/a |

Pooled advantage: NaN pts [NaN, NaN].
Slope of advantage on capability (0 models): n/a [n/a, n/a].

| Family | claude-opus-5-5 | claude-sonnet-5-5 | gpt-6.1-sol | slope [95% CI] |
|---|---|---|---|---|
| C | w:100% | w:100% | w:100% | n/a [n/a, n/a] |
| F | w:80% | w:100% | w:100% | n/a [n/a, n/a] |

| Stratum | claude-opus-5-5 | claude-sonnet-5-5 | gpt-6.1-sol |
|---|---|---|---|
| memory-only | wave11:100% | wave11:100% | wave11:100% |
| page-authoring | wave11:80% | wave11:100% | wave11:100% |

| Arm | C output leaks | C context exposures | unsafe writes | unsupported claims/answer | missed evidence |
|---|---|---|---|---|---|
| wave11 | 0/60 | 0/60 | 0 | n/a | 0% |

| Model | Arm | $/task | $/success | p50 s | p95 s | turns |
|---|---|---|---|---|---|---|
| claude-opus-5-5 | wave11 | 0.210 | 0.233 | 86 | 124 | 4.0 |
| claude-sonnet-5-5 | wave11 | 0.102 | 0.102 | 70 | 90 | 3.0 |
| gpt-6.1-sol | wave11 | 0.039 | 0.039 | 85 | 112 | 5.0 |

Cost split per cell (`total_usd`: agent sessions plus gbrain provider calls, judge excluded; the columns sum to the total):

| Model | Arm | uncached input $ | cache write $ | cache read $ | output $ | gbrain provider calls $ | total_usd |
|---|---|---|---|---|---|---|---|
| claude-opus-5-5 | wave11 | 0.0001 | 0.1541 | 0.0269 | 0.0288 | 0.0000 | 0.2100 |
| claude-sonnet-5-5 | wave11 | 0.0000 | 0.0723 | 0.0189 | 0.0105 | 0.0000 | 0.1018 |
| gpt-6.1-sol | wave11 | 0.0276 | 0.0000 | 0.0066 | 0.0046 | 0.0002 | 0.0390 |

Tool-result characters per cell, by tool:

| Model | Arm | characters by tool |
|---|---|---|
| claude-opus-5-5 | wave11 | search 37,654, entity 14,251, get_page 2,781, remember 1,097, get_backlinks 1,081, query 796, add_timeline_entry 689, list_pages 499, edit_page 478, whoami 228, recall 149, forget 60, list_skills 36, resolve_slugs 36 |
| claude-sonnet-5-5 | wave11 | search 30,174, entity 17,850, edit_page 2,878, get_page 2,369, whoami 1,112, list_pages 895, query 828, remember 770, add_timeline_entry 331, list_skills 127, recall 112 |
| gpt-6.1-sol | wave11 | search 25,693, get_page 3,868, entity 3,407, edit_page 3,091, context_pack 2,339, query 2,282, whoami 1,061, remember 826, get_backlinks 552, recall 42, resolve_slugs 34, list_pages 11, list_skills 11 |

Reconciliation against the budget ledger:

| Budget run | cells | cells $ | judge $ | slot builds $ | ledger $ | gap | |
|---|---|---|---|---|---|---|---|
| cat40-model-ladder-2026-10-07T15-37-12-504Z-98d8ca31 | 120 | 14.0287 | 0.0000 | 0.0000 | 14.0287 | 0.00% | ok |
