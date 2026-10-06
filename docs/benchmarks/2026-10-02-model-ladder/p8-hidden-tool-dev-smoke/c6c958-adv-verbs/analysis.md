Cells: 20. Spend in these records: $0.11.

| Model | capability (oracle) | c6c958-callfull-adv-verbs | gbrain advantage [95% CI] |
|---|---|---|---|
| gpt-6-luna | n/a | 5% | n/a |

Pooled advantage: NaN pts [NaN, NaN].
Slope of advantage on capability (0 models): n/a [n/a, n/a].

| Family | gpt-6-luna | slope [95% CI] |
|---|---|---|
| H | c:5% | n/a [n/a, n/a] |

| Stratum | gpt-6-luna |
|---|---|
| hidden-tool | c6c958-callfull-adv-verbs:5% |

| Arm | C output leaks | C context exposures | unsafe writes | unsupported claims/answer | missed evidence |
|---|---|---|---|---|---|
| c6c958-callfull-adv-verbs | 0/0 | 0/0 | 0 | n/a | 40% |

| Model | Arm | $/task | $/success | p50 s | p95 s | turns |
|---|---|---|---|---|---|---|
| gpt-6-luna | c6c958-callfull-adv-verbs | 0.005 | 0.107 | 271 | 316 | 7.0 |

Cost split per cell (`total_usd`: agent sessions plus gbrain provider calls, judge excluded; the columns sum to the total):

| Model | Arm | uncached input $ | cache write $ | cache read $ | output $ | gbrain provider calls $ | total_usd |
|---|---|---|---|---|---|---|---|
| gpt-6-luna | c6c958-callfull-adv-verbs | 0.0021 | 0.0000 | 0.0007 | 0.0003 | 0.0023 | 0.0053 |

Tool-result characters per cell, by tool:

| Model | Arm | characters by tool |
|---|---|---|
| gpt-6-luna | c6c958-callfull-adv-verbs | recall 67,267, context_pack 504, entity 148, synthesize 51 |
