Cells: 960. Spend in these records: $207.90.

| Model | capability (oracle) | fs | fs-acl | gbrain | memory | pg | gbrain advantage [95% CI] |
|---|---|---|---|---|---|---|---|
| claude-sonnet-4-6 | 98% | 64% | 70% | 42% | n/a | 62% | -22 pts vs fs [-36, -14] |
| claude-sonnet-5-5 | 96% | 94% | 100% | 68% | n/a | 82% | -26 pts vs fs [-40, -12] |
| gpt-5.4 | 100% | 66% | 100% | 52% | n/a | 52% | -14 pts vs fs [-28, -2] |
| gpt-6.1-sol | 100% | 96% | 100% | 92% | n/a | 94% | -4 pts vs fs [-12, 2] |

Pooled advantage: -16 pts [-24, -10].
Slope of advantage on capability (4 models): 4.45 [0.16, 11.50].

| Family | claude-sonnet-4-6 | claude-sonnet-5-5 | gpt-5.4 | gpt-6.1-sol | slope [95% CI] |
|---|---|---|---|---|---|
| A | f:70% g:70% mm:n/a o:100% p:70% | f:100% g:70% mm:n/a o:100% p:80% | f:70% g:50% mm:n/a o:100% p:60% | f:90% g:90% mm:n/a o:100% p:100% | n/a [n/a, n/a] |
| B | f:90% g:80% mm:n/a o:100% p:60% | f:100% g:80% mm:n/a o:100% p:60% | f:40% g:60% mm:n/a o:100% p:50% | f:100% g:80% mm:n/a o:100% p:80% | n/a [n/a, n/a] |
| C | f:90% g:50% mm:n/a o:100% p:100% | f:100% g:70% mm:n/a o:100% p:100% | f:80% g:70% mm:n/a o:100% p:70% | f:100% g:100% mm:n/a o:100% p:100% | n/a [n/a, n/a] |
| E | f:20% g:0% mm:n/a o:90% p:20% | f:90% g:30% mm:n/a o:80% p:70% | f:40% g:10% mm:n/a o:100% p:30% | f:100% g:100% mm:n/a o:100% p:100% | 2.09 [0.14, 5.67] |
| F | f:50% g:10% mm:n/a o:100% p:60% | f:80% g:90% mm:n/a o:100% p:100% | f:100% g:70% mm:n/a o:100% p:50% | f:90% g:90% mm:n/a o:100% p:90% | n/a [n/a, n/a] |

| Arm | C output leaks | C context exposures | unsafe writes | unsupported claims/answer | missed evidence |
|---|---|---|---|---|---|
| fs | 3/40 | 38/40 | 0 | 0.97 | 13% |
| fs-acl | 3/40 | 19/40 | 0 | 0.70 | 5% |
| gbrain | 11/40 | 17/40 | 0 | 0.93 | 26% |
| memory | 4/24 | 18/24 | 0 | 1.21 | 46% |
| oracle | 0/40 | 0/40 | 0 | 0.88 | 0% |
| pg | 3/40 | 33/40 | 0 | 0.99 | 17% |

| Model | Arm | $/task | $/success | p50 s | p95 s | turns |
|---|---|---|---|---|---|---|
| claude-sonnet-4-6 | fs | 0.084 | 0.132 | 18 | 66 | 5.0 |
| claude-sonnet-4-6 | fs-acl | 0.022 | 0.031 | 10 | 27 | 3.7 |
| claude-sonnet-4-6 | gbrain | 0.199 | 0.473 | 152 | 285 | 3.7 |
| claude-sonnet-4-6 | memory | 1.574 | 3.147 | 29 | 95 | 6.8 |
| claude-sonnet-4-6 | oracle | 0.014 | 0.014 | 10 | 14 | 1.0 |
| claude-sonnet-4-6 | pg | 0.034 | 0.055 | 15 | 49 | 3.3 |
| claude-sonnet-5-5 | fs | 0.069 | 0.074 | 17 | 38 | 4.9 |
| claude-sonnet-5-5 | fs-acl | 0.022 | 0.022 | 14 | 18 | 4.8 |
| claude-sonnet-5-5 | gbrain | 0.223 | 0.327 | 142 | 234 | 4.4 |
| claude-sonnet-5-5 | memory | 1.718 | 2.455 | 36 | 138 | 6.3 |
| claude-sonnet-5-5 | oracle | 0.009 | 0.009 | 7 | 12 | 1.0 |
| claude-sonnet-5-5 | pg | 0.038 | 0.047 | 15 | 38 | 4.0 |
| gpt-5.4 | fs | 0.050 | 0.075 | 14 | 23 | 3.7 |
| gpt-5.4 | fs-acl | 0.021 | 0.021 | 9 | 25 | 3.5 |
| gpt-5.4 | gbrain | 0.110 | 0.211 | 147 | 245 | 4.8 |
| gpt-5.4 | memory | 0.985 | 1.846 | 14 | 23 | 3.8 |
| gpt-5.4 | oracle | 0.005 | 0.005 | 5 | 7 | 1.0 |
| gpt-5.4 | pg | 0.023 | 0.044 | 15 | 26 | 3.4 |
| gpt-6.1-sol | fs | 0.026 | 0.027 | 26 | 58 | 5.0 |
| gpt-6.1-sol | fs-acl | 0.013 | 0.013 | 23 | 30 | 5.1 |
| gpt-6.1-sol | gbrain | 0.085 | 0.093 | 136 | 242 | 4.1 |
| gpt-6.1-sol | memory | 0.894 | 1.277 | 31 | 144 | 6.1 |
| gpt-6.1-sol | oracle | 0.003 | 0.003 | 6 | 10 | 1.0 |
| gpt-6.1-sol | pg | 0.018 | 0.019 | 23 | 37 | 4.1 |
