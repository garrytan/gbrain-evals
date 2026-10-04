Cells: 600. Spend in these records: $64.66.

| Model | capability (oracle) | after-b3f4e8b | base-same-window-b3f4e8b | gbrain advantage [95% CI] |
|---|---|---|---|---|
| claude-sonnet-4-6 | n/a | 83% | 77% | n/a |
| gpt-5.4 | n/a | 73% | 75% | n/a |
| gpt-5.4-mini | n/a | 49% | 50% | n/a |

Pooled advantage: NaN pts [NaN, NaN].
Slope of advantage on capability (0 models): n/a [n/a, n/a].

| Family | claude-sonnet-4-6 | gpt-5.4 | gpt-5.4-mini | slope [95% CI] |
|---|---|---|---|---|
| A | a:100% b:100% | a:100% b:100% | a:65% b:65% | n/a [n/a, n/a] |
| B | a:100% b:80% | a:80% b:65% | a:60% b:50% | n/a [n/a, n/a] |
| C | a:100% b:100% | a:100% b:100% | a:100% b:100% | n/a [n/a, n/a] |
| E | a:15% b:10% | a:30% b:50% | a:0% b:0% | n/a [n/a, n/a] |
| F | a:100% b:95% | a:55% b:60% | a:20% b:35% | n/a [n/a, n/a] |

| Arm | C output leaks | C context exposures | unsafe writes | unsupported claims/answer | missed evidence |
|---|---|---|---|---|---|
| after-b3f4e8b | 0/60 | 0/60 | 0 | n/a | 29% |
| base-same-window-b3f4e8b | 0/60 | 0/60 | 0 | n/a | 34% |

| Model | Arm | $/task | $/success | p50 s | p95 s | turns |
|---|---|---|---|---|---|---|
| claude-sonnet-4-6 | after-b3f4e8b | 0.203 | 0.244 | 32 | 72 | 2.9 |
| claude-sonnet-4-6 | base-same-window-b3f4e8b | 0.235 | 0.306 | 27 | 115 | 3.9 |
| gpt-5.4 | after-b3f4e8b | 0.081 | 0.112 | 24 | 48 | 3.2 |
| gpt-5.4 | base-same-window-b3f4e8b | 0.090 | 0.120 | 22 | 37 | 3.3 |
| gpt-5.4-mini | after-b3f4e8b | 0.018 | 0.038 | 21 | 38 | 3.3 |
| gpt-5.4-mini | base-same-window-b3f4e8b | 0.019 | 0.037 | 17 | 34 | 3.6 |
