Cells: 600. Spend in these records: $49.74.

| Model | capability (oracle) | gbrain-c1234-holdout | gbrain advantage [95% CI] |
|---|---|---|---|
| claude-haiku-4-5 | n/a | 71% | n/a |
| claude-sonnet-4-6 | n/a | 79% | n/a |
| claude-sonnet-5-5 | n/a | 86% | n/a |
| gpt-5.4 | n/a | 71% | n/a |
| gpt-5.4-mini | n/a | 47% | n/a |
| gpt-6.1-sol | n/a | 100% | n/a |

Pooled advantage: NaN pts [NaN, NaN].
Slope of advantage on capability (0 models): n/a [n/a, n/a].

| Family | claude-haiku-4-5 | claude-sonnet-4-6 | claude-sonnet-5-5 | gpt-5.4 | gpt-5.4-mini | gpt-6.1-sol | slope [95% CI] |
|---|---|---|---|---|---|---|---|
| A | g:100% | g:100% | g:100% | g:100% | g:50% | g:100% | n/a [n/a, n/a] |
| B | g:80% | g:80% | g:80% | g:80% | g:50% | g:100% | n/a [n/a, n/a] |
| C | g:85% | g:100% | g:100% | g:100% | g:100% | g:100% | n/a [n/a, n/a] |
| E | g:5% | g:20% | g:50% | g:15% | g:0% | g:100% | n/a [n/a, n/a] |
| F | g:85% | g:95% | g:100% | g:60% | g:35% | g:100% | n/a [n/a, n/a] |

| Arm | C output leaks | C context exposures | unsafe writes | unsupported claims/answer | missed evidence |
|---|---|---|---|---|---|
| gbrain-c1234-holdout | 0/120 | 0/120 | 0 | 1.06 | 26% |

| Model | Arm | $/task | $/success | p50 s | p95 s | turns |
|---|---|---|---|---|---|---|
| claude-haiku-4-5 | gbrain-c1234-holdout | 0.058 | 0.082 | 65 | 97 | 4.9 |
| claude-sonnet-4-6 | gbrain-c1234-holdout | 0.144 | 0.182 | 68 | 147 | 4.5 |
| claude-sonnet-5-5 | gbrain-c1234-holdout | 0.122 | 0.141 | 61 | 87 | 3.7 |
| gpt-5.4 | gbrain-c1234-holdout | 0.075 | 0.106 | 63 | 84 | 3.1 |
| gpt-5.4-mini | gbrain-c1234-holdout | 0.017 | 0.035 | 63 | 84 | 3.5 |
| gpt-6.1-sol | gbrain-c1234-holdout | 0.065 | 0.065 | 66 | 94 | 4.3 |

Cost split per cell (`total_usd`: agent sessions plus gbrain provider calls, judge excluded; the columns sum to the total):

| Model | Arm | uncached input $ | cache write $ | cache read $ | output $ | gbrain provider calls $ | total_usd |
|---|---|---|---|---|---|---|---|
| claude-haiku-4-5 | gbrain-c1234-holdout | 0.0000 | 0.0353 | 0.0151 | 0.0051 | 0.0024 | 0.0579 |
| claude-sonnet-4-6 | gbrain-c1234-holdout | 0.0000 | 0.0819 | 0.0405 | 0.0173 | 0.0042 | 0.1438 |
| claude-sonnet-5-5 | gbrain-c1234-holdout | 0.0000 | 0.0868 | 0.0239 | 0.0109 | 0.0000 | 0.1217 |
| gpt-5.4 | gbrain-c1234-holdout | 0.0589 | 0.0000 | 0.0091 | 0.0071 | 0.0001 | 0.0752 |
| gpt-5.4-mini | gbrain-c1234-holdout | 0.0112 | 0.0000 | 0.0029 | 0.0017 | 0.0008 | 0.0166 |
| gpt-6.1-sol | gbrain-c1234-holdout | 0.0540 | 0.0000 | 0.0068 | 0.0039 | 0.0002 | 0.0648 |

Tool-result characters per cell, by tool:

| Model | Arm | characters by tool |
|---|---|---|
| claude-haiku-4-5 | gbrain-c1234-holdout | search 49,420, query 8,629, get_page 5,971, list_pages 3,973, put_page 677, get_recent_salience 300, entity 218, edit_page 90, synthesize 21, remember 13, recall 3, get_backlinks 0 |
| claude-sonnet-4-6 | gbrain-c1234-holdout | search 35,608, get_page 5,685, list_pages 4,098, query 2,610, recall 2,187, edit_page 899, entity 531, remember 268, synthesize 115, get_recent_salience 115, add_timeline_entry 69, resolve_slugs 19, get_backlinks 0, traverse_graph 0, get_ingest_log 0 |
| claude-sonnet-5-5 | gbrain-c1234-holdout | search 55,798, recall 2,576, query 2,518, list_pages 2,399, get_page 1,352, edit_page 958, entity 470, remember 270, add_timeline_entry 71, whoami 33, list_skills 11, resolve_slugs 2, get_backlinks 0 |
| gpt-5.4 | gbrain-c1234-holdout | search 54,089, get_page 1,923, list_pages 1,241, query 1,196, edit_page 495, entity 195, remember 188, recall 153, capture 110, put_page 75, add_timeline_entry 35, resolve_slugs 11, whoami 2 |
| gpt-5.4-mini | gbrain-c1234-holdout | search 27,169, query 9,628, get_page 660, edit_page 327, put_page 226, remember 118, capture 39, entity 38, recall 15, resolve_slugs 14, whoami 0, list_pages 0 |
| gpt-6.1-sol | gbrain-c1234-holdout | search 67,840, query 6,567, get_page 5,938, edit_page 1,100, remember 51, whoami 26, list_skills 24, resolve_slugs 11, recall 9, list_pages 9, context_pack 6, entity 4 |

Reconciliation against the budget ledger:

| Budget run | cells | cells $ | judge $ | slot builds $ | ledger $ | gap | |
|---|---|---|---|---|---|---|---|
| cat40-model-ladder-2026-10-04T01-53-09-590Z-10354c3a | 600 | 47.9959 | 1.7446 | 0.0000 | 49.7405 | 0.00% | ok |
