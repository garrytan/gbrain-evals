Cells: 1560. Spend in these records: $79.64.

| Model | capability (oracle) | fs | fs-acl | gbrain | memory | pg | gbrain advantage [95% CI] |
|---|---|---|---|---|---|---|---|
| claude-haiku-4-5 | 100% | 58% | 70% | 54% | 54% | 52% | -4 pts vs fs [-20, 4] |
| claude-sonnet-4-6 | 96% | 64% | 70% | 50% | 58% | 62% | -14 pts vs fs [-28, -4] |
| claude-sonnet-5-5 | 98% | 92% | 100% | 88% | 76% | 82% | -4 pts vs fs [-14, 4] |
| gpt-5.4 | 98% | 76% | 90% | 54% | 54% | 58% | -22 pts vs fs [-36, -8] |
| gpt-5.4-mini | 96% | 64% | 80% | 40% | 48% | 58% | -24 pts vs fs [-38, -12] |
| gpt-6.1-sol | 100% | 100% | 100% | 86% | 82% | 96% | -14 pts vs fs [-24, -6] |

Pooled advantage: -14 pts [-22, -7].
Slope of advantage on capability (6 models): 2.50 [-1.33, 7.33].

| Family | claude-haiku-4-5 | claude-sonnet-4-6 | claude-sonnet-5-5 | gpt-5.4 | gpt-5.4-mini | gpt-6.1-sol | slope [95% CI] |
|---|---|---|---|---|---|---|---|
| A | f:70% g:70% mm:70% o:100% p:70% | f:70% g:70% mm:80% o:100% p:70% | f:100% g:100% mm:100% o:100% p:90% | f:100% g:70% mm:60% o:100% p:70% | f:90% g:70% mm:50% o:100% p:70% | f:100% g:100% mm:100% o:100% p:100% | n/a [n/a, n/a] |
| B | f:80% g:80% mm:40% o:100% p:60% | f:80% g:80% mm:40% o:100% p:50% | f:90% g:80% mm:60% o:100% p:70% | f:50% g:70% mm:50% o:100% p:70% | f:40% g:40% mm:40% o:100% p:60% | f:100% g:80% mm:60% o:100% p:90% | n/a [n/a, n/a] |
| C | f:90% g:60% mm:90% o:100% p:80% | f:90% g:70% mm:100% o:100% p:100% | f:100% g:90% mm:100% o:100% p:80% | f:100% g:70% mm:80% o:100% p:70% | f:100% g:70% mm:90% o:100% p:100% | f:100% g:100% mm:100% o:100% p:100% | n/a [n/a, n/a] |
| E | f:20% g:0% mm:0% o:100% p:0% | f:20% g:0% mm:0% o:80% p:30% | f:80% g:70% mm:20% o:90% p:80% | f:30% g:0% mm:0% o:90% p:30% | f:0% g:0% mm:0% o:90% p:0% | f:100% g:100% mm:50% o:100% p:100% | 0.88 [-1.00, 2.29] |
| F | f:30% g:60% mm:70% o:100% p:50% | f:60% g:30% mm:70% o:100% p:60% | f:90% g:100% mm:100% o:100% p:90% | f:100% g:60% mm:80% o:100% p:50% | f:90% g:20% mm:60% o:90% p:60% | f:100% g:50% mm:100% o:100% p:90% | 4.20 [1.20, 7.20] |

| Arm | C output leaks | C context exposures | unsafe writes | unsupported claims/answer | missed evidence |
|---|---|---|---|---|---|
| fs | 1/60 | 58/60 | 0 | 0.85 | 23% |
| fs-acl | 9/60 | 29/60 | 0 | 0.53 | 7% |
| gbrain | 14/60 | 28/60 | 0 | 0.78 | 32% |
| memory | 4/60 | 34/60 | 0 | 0.80 | 57% |
| oracle | 0/60 | 0/60 | 0 | 0.74 | 0% |
| pg | 7/60 | 59/60 | 0 | 0.84 | 24% |

| Model | Arm | $/task | $/success | p50 s | p95 s | turns |
|---|---|---|---|---|---|---|
| claude-haiku-4-5 | fs | 0.023 | 0.039 | 13 | 33 | 5.2 |
| claude-haiku-4-5 | fs-acl | 0.013 | 0.018 | 8 | 25 | 4.7 |
| claude-haiku-4-5 | gbrain | 0.051 | 0.094 | 20 | 111 | 3.9 |
| claude-haiku-4-5 | memory | 0.051 | 0.094 | 19 | 39 | 7.8 |
| claude-haiku-4-5 | oracle | 0.005 | 0.005 | 7 | 22 | 1.0 |
| claude-haiku-4-5 | pg | 0.014 | 0.027 | 11 | 34 | 3.9 |
| claude-sonnet-4-6 | fs | 0.049 | 0.076 | 20 | 65 | 4.7 |
| claude-sonnet-4-6 | fs-acl | 0.021 | 0.030 | 11 | 19 | 3.7 |
| claude-sonnet-4-6 | gbrain | 0.152 | 0.304 | 20 | 127 | 3.7 |
| claude-sonnet-4-6 | memory | 0.138 | 0.239 | 17 | 96 | 5.8 |
| claude-sonnet-4-6 | oracle | 0.015 | 0.016 | 11 | 17 | 1.0 |
| claude-sonnet-4-6 | pg | 0.034 | 0.055 | 20 | 42 | 3.3 |
| claude-sonnet-5-5 | fs | 0.046 | 0.050 | 22 | 35 | 4.7 |
| claude-sonnet-5-5 | fs-acl | 0.022 | 0.022 | 17 | 20 | 4.7 |
| claude-sonnet-5-5 | gbrain | 0.162 | 0.184 | 27 | 123 | 4.3 |
| claude-sonnet-5-5 | memory | 0.226 | 0.297 | 25 | 136 | 7.2 |
| claude-sonnet-5-5 | oracle | 0.010 | 0.010 | 8 | 12 | 1.0 |
| claude-sonnet-5-5 | pg | 0.036 | 0.044 | 18 | 39 | 3.9 |
| gpt-5.4 | fs | 0.032 | 0.042 | 15 | 31 | 4.0 |
| gpt-5.4 | fs-acl | 0.022 | 0.024 | 9 | 23 | 3.5 |
| gpt-5.4 | gbrain | 0.084 | 0.155 | 25 | 117 | 4.7 |
| gpt-5.4 | memory | 0.083 | 0.155 | 15 | 37 | 4.6 |
| gpt-5.4 | oracle | 0.006 | 0.006 | 6 | 9 | 1.0 |
| gpt-5.4 | pg | 0.020 | 0.034 | 14 | 27 | 3.2 |
| gpt-5.4-mini | fs | 0.008 | 0.012 | 14 | 25 | 4.6 |
| gpt-5.4-mini | fs-acl | 0.006 | 0.007 | 10 | 15 | 4.3 |
| gpt-5.4-mini | gbrain | 0.014 | 0.035 | 23 | 108 | 3.2 |
| gpt-5.4-mini | memory | 0.022 | 0.045 | 14 | 34 | 6.1 |
| gpt-5.4-mini | oracle | 0.002 | 0.002 | 5 | 10 | 1.0 |
| gpt-5.4-mini | pg | 0.004 | 0.007 | 13 | 24 | 3.7 |
| gpt-6.1-sol | fs | 0.022 | 0.022 | 27 | 53 | 4.8 |
| gpt-6.1-sol | fs-acl | 0.013 | 0.013 | 21 | 30 | 5.2 |
| gpt-6.1-sol | gbrain | 0.047 | 0.055 | 32 | 117 | 4.2 |
| gpt-6.1-sol | memory | 0.117 | 0.143 | 38 | 212 | 7.2 |
| gpt-6.1-sol | oracle | 0.004 | 0.004 | 7 | 11 | 1.0 |
| gpt-6.1-sol | pg | 0.018 | 0.019 | 24 | 46 | 3.9 |
