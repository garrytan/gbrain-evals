Cells: 120. Spend in these records: $14.06.

| Model | capability (oracle) | wave12 | gbrain advantage [95% CI] |
|---|---|---|---|
| claude-opus-5-5 | n/a | 88% | n/a |
| claude-sonnet-5-5 | n/a | 100% | n/a |
| gpt-6.1-sol | n/a | 100% | n/a |

Pooled advantage: NaN pts [NaN, NaN].
Slope of advantage on capability (0 models): n/a [n/a, n/a].

| Family | claude-opus-5-5 | claude-sonnet-5-5 | gpt-6.1-sol | slope [95% CI] |
|---|---|---|---|---|
| C | w:100% | w:100% | w:100% | n/a [n/a, n/a] |
| F | w:75% | w:100% | w:100% | n/a [n/a, n/a] |

| Stratum | claude-opus-5-5 | claude-sonnet-5-5 | gpt-6.1-sol |
|---|---|---|---|
| memory-only | wave12:100% | wave12:100% | wave12:100% |
| page-authoring | wave12:75% | wave12:100% | wave12:100% |

| Arm | C output leaks | C context exposures | unsafe writes | unsupported claims/answer | missed evidence |
|---|---|---|---|---|---|
| wave12 | 0/60 | 0/60 | 0 | n/a | 0% |

| Model | Arm | $/task | $/success | p50 s | p95 s | turns |
|---|---|---|---|---|---|---|
| claude-opus-5-5 | wave12 | 0.209 | 0.239 | 90 | 114 | 3.8 |
| claude-sonnet-5-5 | wave12 | 0.105 | 0.105 | 78 | 112 | 3.0 |
| gpt-6.1-sol | wave12 | 0.037 | 0.037 | 84 | 114 | 5.0 |

Cost split per cell (`total_usd`: agent sessions plus gbrain provider calls, judge excluded; the columns sum to the total):

| Model | Arm | uncached input $ | cache write $ | cache read $ | output $ | gbrain provider calls $ | total_usd |
|---|---|---|---|---|---|---|---|
| claude-opus-5-5 | wave12 | 0.0001 | 0.1577 | 0.0246 | 0.0271 | 0.0000 | 0.2094 |
| claude-sonnet-5-5 | wave12 | 0.0000 | 0.0757 | 0.0195 | 0.0102 | 0.0001 | 0.1055 |
| gpt-6.1-sol | wave12 | 0.0255 | 0.0000 | 0.0065 | 0.0044 | 0.0001 | 0.0365 |

Tool-result characters per cell, by tool:

| Model | Arm | characters by tool |
|---|---|---|
| claude-opus-5-5 | wave12 | search 41,398, entity 12,827, get_page 3,012, get_backlinks 1,370, remember 996, recall 981, query 818, add_timeline_entry 579, edit_page 296, list_pages 87, forget 69, whoami 37, resolve_slugs 24, list_skills 11 |
| claude-sonnet-5-5 | wave12 | search 31,381, entity 17,879, query 3,097, edit_page 2,876, get_page 2,352, whoami 1,506, remember 718, add_timeline_entry 328, recall 107, list_pages 87, list_skills 67 |
| gpt-6.1-sol | wave12 | search 19,578, entity 7,241, get_page 3,721, edit_page 2,934, context_pack 2,411, query 1,998, remember 826, whoami 732, list_skills 35, resolve_slugs 32, recall 22, list_pages 11 |
