Cells: 20. Spend in these records: $0.11.

| Model | capability (oracle) | c6c958-callfull-adv-starter | gbrain advantage [95% CI] |
|---|---|---|---|
| gpt-6-luna | n/a | 0% | n/a |

Pooled advantage: NaN pts [NaN, NaN].
Slope of advantage on capability (0 models): n/a [n/a, n/a].

| Family | gpt-6-luna | slope [95% CI] |
|---|---|---|
| H | c:0% | n/a [n/a, n/a] |

| Stratum | gpt-6-luna |
|---|---|
| hidden-tool | c6c958-callfull-adv-starter:0% |

| Arm | C output leaks | C context exposures | unsafe writes | unsupported claims/answer | missed evidence |
|---|---|---|---|---|---|
| c6c958-callfull-adv-starter | 0/0 | 0/0 | 0 | n/a | 15% |

| Model | Arm | $/task | $/success | p50 s | p95 s | turns |
|---|---|---|---|---|---|---|
| gpt-6-luna | c6c958-callfull-adv-starter | 0.005 | n/a | 330 | 365 | 7.1 |

Cost split per cell (`total_usd`: agent sessions plus gbrain provider calls, judge excluded; the columns sum to the total):

| Model | Arm | uncached input $ | cache write $ | cache read $ | output $ | gbrain provider calls $ | total_usd |
|---|---|---|---|---|---|---|---|
| gpt-6-luna | c6c958-callfull-adv-starter | 0.0035 | 0.0000 | 0.0010 | 0.0005 | 0.0005 | 0.0055 |

Tool-result characters per cell, by tool:

| Model | Arm | characters by tool |
|---|---|---|
| gpt-6-luna | c6c958-callfull-adv-starter | search 85,496, query 9,183, list_pages 3,923, get_page 2,304, context_pack 453, whoami 426, entity 26, resolve_slugs 20, recall 5, request_tools 1, get_backlinks 0 |
