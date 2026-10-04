Cells: 600. Spend in these records: $72.60.

| Model | capability (oracle) | gbrain-566a242a-control | gbrain advantage [95% CI] |
|---|---|---|---|
| claude-haiku-4-5 | n/a | 71% | n/a |
| claude-sonnet-4-6 | n/a | 75% | n/a |
| claude-sonnet-5-5 | n/a | 85% | n/a |
| gpt-5.4 | n/a | 66% | n/a |
| gpt-5.4-mini | n/a | 44% | n/a |
| gpt-6.1-sol | n/a | 100% | n/a |

Pooled advantage: NaN pts [NaN, NaN].
Slope of advantage on capability (0 models): n/a [n/a, n/a].

| Family | claude-haiku-4-5 | claude-sonnet-4-6 | claude-sonnet-5-5 | gpt-5.4 | gpt-5.4-mini | gpt-6.1-sol | slope [95% CI] |
|---|---|---|---|---|---|---|---|
| A | g:90% | g:100% | g:100% | g:85% | g:55% | g:100% | n/a [n/a, n/a] |
| B | g:85% | g:80% | g:80% | g:55% | g:30% | g:100% | n/a [n/a, n/a] |
| C | g:95% | g:100% | g:100% | g:100% | g:90% | g:100% | n/a [n/a, n/a] |
| E | g:0% | g:10% | g:45% | g:30% | g:0% | g:100% | n/a [n/a, n/a] |
| F | g:85% | g:85% | g:100% | g:60% | g:45% | g:100% | n/a [n/a, n/a] |

| Arm | C output leaks | C context exposures | unsafe writes | unsupported claims/answer | missed evidence |
|---|---|---|---|---|---|
| gbrain-566a242a-control | 0/120 | 0/120 | 0 | 1.06 | 22% |

| Model | Arm | $/task | $/success | p50 s | p95 s | turns |
|---|---|---|---|---|---|---|
| claude-haiku-4-5 | gbrain-566a242a-control | 0.074 | 0.104 | 62 | 89 | 4.2 |
| claude-sonnet-4-6 | gbrain-566a242a-control | 0.224 | 0.299 | 62 | 158 | 3.9 |
| claude-sonnet-5-5 | gbrain-566a242a-control | 0.206 | 0.243 | 60 | 98 | 3.9 |
| gpt-5.4 | gbrain-566a242a-control | 0.088 | 0.133 | 60 | 85 | 3.3 |
| gpt-5.4-mini | gbrain-566a242a-control | 0.020 | 0.045 | 57 | 82 | 3.5 |
| gpt-6.1-sol | gbrain-566a242a-control | 0.097 | 0.097 | 69 | 92 | 4.2 |

Cost split per cell (`total_usd`: agent sessions plus gbrain provider calls, judge excluded; the columns sum to the total):

| Model | Arm | uncached input $ | cache write $ | cache read $ | output $ | gbrain provider calls $ | total_usd |
|---|---|---|---|---|---|---|---|
| claude-haiku-4-5 | gbrain-566a242a-control | 0.0000 | 0.0512 | 0.0177 | 0.0046 | 0.0001 | 0.0736 |
| claude-sonnet-4-6 | gbrain-566a242a-control | 0.0000 | 0.1457 | 0.0577 | 0.0161 | 0.0051 | 0.2245 |
| claude-sonnet-5-5 | gbrain-566a242a-control | 0.0000 | 0.1427 | 0.0512 | 0.0123 | 0.0000 | 0.2062 |
| gpt-5.4 | gbrain-566a242a-control | 0.0648 | 0.0000 | 0.0172 | 0.0056 | 0.0003 | 0.0880 |
| gpt-5.4-mini | gbrain-566a242a-control | 0.0120 | 0.0000 | 0.0055 | 0.0016 | 0.0007 | 0.0198 |
| gpt-6.1-sol | gbrain-566a242a-control | 0.0811 | 0.0000 | 0.0117 | 0.0036 | 0.0002 | 0.0966 |

Tool-result characters per cell, by tool:

| Model | Arm | characters by tool |
|---|---|---|
| claude-haiku-4-5 | gbrain-566a242a-control | search 83,102, query 8,594, get_page 4,388, list_pages 1,383, put_page 769, recall 373, entity 178, remember 53 |
| claude-sonnet-4-6 | gbrain-566a242a-control | search 55,577, query 27,308, get_page 3,392, list_pages 2,406, recall 2,296, put_page 615, entity 461, remember 423, synthesize 137, add_timeline_entry 133, get_recent_salience 58, resolve_slugs 15, get_backlinks 0, traverse_graph 0 |
| claude-sonnet-5-5 | gbrain-566a242a-control | search 103,875, recall 6,552, query 2,591, get_page 1,456, list_pages 842, put_page 769, entity 690, remember 276, add_timeline_entry 44, whoami 8, list_skills 5, resolve_slugs 3, get_backlinks 0, get_ingest_log 0 |
| gpt-5.4 | gbrain-566a242a-control | search 59,071, query 5,277, list_pages 2,835, recall 957, remember 489, get_page 445, put_page 115, entity 65, capture 48, resolve_slugs 9, whoami 1 |
| gpt-5.4-mini | gbrain-566a242a-control | search 28,999, query 8,960, get_page 1,412, put_page 464, remember 254, recall 107, entity 15, resolve_slugs 9, whoami 0, get_recent_salience 0 |
| gpt-6.1-sol | gbrain-566a242a-control | search 96,363, query 18,867, get_page 3,569, recall 1,575, remember 513, put_page 231, entity 60, resolve_slugs 36, whoami 23, list_skills 9, list_pages 5 |

Reconciliation against the budget ledger:

| Budget run | cells | cells $ | judge $ | slot builds $ | ledger $ | gap | |
|---|---|---|---|---|---|---|---|
| cat40-model-ladder-2026-10-04T03-03-15-407Z-ba9fc82b | 600 | 70.8741 | 1.7273 | 0.0000 | 72.8902 | 0.40% | ok |
