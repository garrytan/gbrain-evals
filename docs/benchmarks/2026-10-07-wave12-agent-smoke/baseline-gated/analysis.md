Cells: 120. Spend in these records: $15.24.

| Model | capability (oracle) | baseline | gbrain advantage [95% CI] |
|---|---|---|---|
| claude-opus-5-5 | n/a | 100% | n/a |
| claude-sonnet-5-5 | n/a | 100% | n/a |
| gpt-6.1-sol | n/a | 100% | n/a |

Pooled advantage: NaN pts [NaN, NaN].
Slope of advantage on capability (0 models): n/a [n/a, n/a].

| Family | claude-opus-5-5 | claude-sonnet-5-5 | gpt-6.1-sol | slope [95% CI] |
|---|---|---|---|---|
| C | b:100% | b:100% | b:100% | n/a [n/a, n/a] |
| F | b:100% | b:100% | b:100% | n/a [n/a, n/a] |

| Stratum | claude-opus-5-5 | claude-sonnet-5-5 | gpt-6.1-sol |
|---|---|---|---|
| memory-only | baseline:100% | baseline:100% | baseline:100% |
| page-authoring | baseline:100% | baseline:100% | baseline:100% |

| Arm | C output leaks | C context exposures | unsafe writes | unsupported claims/answer | missed evidence |
|---|---|---|---|---|---|
| baseline | 0/60 | 0/60 | 0 | n/a | 0% |

| Model | Arm | $/task | $/success | p50 s | p95 s | turns |
|---|---|---|---|---|---|---|
| claude-opus-5-5 | baseline | 0.241 | 0.241 | 88 | 117 | 4.0 |
| claude-sonnet-5-5 | baseline | 0.102 | 0.102 | 75 | 96 | 3.1 |
| gpt-6.1-sol | baseline | 0.038 | 0.038 | 88 | 119 | 5.3 |

Cost split per cell (`total_usd`: agent sessions plus gbrain provider calls, judge excluded; the columns sum to the total):

| Model | Arm | uncached input $ | cache write $ | cache read $ | output $ | gbrain provider calls $ | total_usd |
|---|---|---|---|---|---|---|---|
| claude-opus-5-5 | baseline | 0.0001 | 0.1831 | 0.0283 | 0.0298 | 0.0001 | 0.2414 |
| claude-sonnet-5-5 | baseline | 0.0000 | 0.0712 | 0.0201 | 0.0106 | 0.0000 | 0.1019 |
| gpt-6.1-sol | baseline | 0.0261 | 0.0000 | 0.0069 | 0.0045 | 0.0001 | 0.0376 |

Tool-result characters per cell, by tool:

| Model | Arm | characters by tool |
|---|---|---|
| claude-opus-5-5 | baseline | search 42,958, entity 14,496, query 8,379, get_page 2,973, get_backlinks 1,286, edit_page 1,119, remember 986, add_timeline_entry 354, whoami 279, list_pages 115, recall 114, resolve_slugs 88, list_skills 44 |
| claude-sonnet-5-5 | baseline | search 30,539, entity 17,897, edit_page 2,891, get_page 2,444, whoami 1,031, remember 599, add_timeline_entry 446, list_pages 228, recall 224, query 219, list_skills 67 |
| gpt-6.1-sol | baseline | search 22,687, get_page 4,664, entity 3,951, edit_page 3,078, context_pack 2,314, query 1,619, whoami 915, remember 855, recall 61, resolve_slugs 35, list_skills 25, list_pages 11 |
