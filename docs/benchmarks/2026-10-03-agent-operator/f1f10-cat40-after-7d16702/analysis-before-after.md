Cells: 600. Spend in these records: $64.76.

| Model | capability (oracle) | gbrain-aow-7d16702 | gbrain-master | gbrain advantage [95% CI] |
|---|---|---|---|---|
| claude-sonnet-4-6 | n/a | 81% | 83% | n/a |
| gpt-5.4 | n/a | 75% | 76% | n/a |
| gpt-5.4-mini | n/a | 48% | 59% | n/a |

Pooled advantage: NaN pts [NaN, NaN].
Slope of advantage on capability (0 models): n/a [n/a, n/a].

| Family | claude-sonnet-4-6 | gpt-5.4 | gpt-5.4-mini | slope [95% CI] |
|---|---|---|---|---|
| A | g:100% g:100% | g:100% g:100% | g:45% g:90% | n/a [n/a, n/a] |
| B | g:100% g:100% | g:75% g:80% | g:50% g:50% | n/a [n/a, n/a] |
| C | g:100% g:100% | g:100% g:100% | g:100% g:100% | n/a [n/a, n/a] |
| E | g:5% g:20% | g:40% g:40% | g:5% g:0% | n/a [n/a, n/a] |
| F | g:100% g:95% | g:60% g:60% | g:40% g:55% | n/a [n/a, n/a] |

| Arm | C output leaks | C context exposures | unsafe writes | unsupported claims/answer | missed evidence |
|---|---|---|---|---|---|
| gbrain-aow-7d16702 | 0/60 | 0/60 | 0 | n/a | 31% |
| gbrain-master | 0/60 | 0/60 | 0 | n/a | 26% |

| Model | Arm | $/task | $/success | p50 s | p95 s | turns |
|---|---|---|---|---|---|---|
| claude-sonnet-4-6 | gbrain-aow-7d16702 | 0.226 | 0.279 | 31 | 83 | 3.2 |
| claude-sonnet-4-6 | gbrain-master | 0.204 | 0.246 | 28 | 79 | 3.0 |
| gpt-5.4 | gbrain-aow-7d16702 | 0.086 | 0.114 | 24 | 40 | 3.1 |
| gpt-5.4 | gbrain-master | 0.091 | 0.120 | 22 | 35 | 3.1 |
| gpt-5.4-mini | gbrain-aow-7d16702 | 0.019 | 0.040 | 20 | 38 | 3.4 |
| gpt-5.4-mini | gbrain-master | 0.021 | 0.036 | 18 | 32 | 3.5 |
