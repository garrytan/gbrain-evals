Cells: 4320. Spend in these records: $335.20.

| Model | capability (oracle) | fs | fs-acl | gbrain-base | gbrain-next | gbrain-next-51a30c1 | memory | pg | gbrain advantage [95% CI] |
|---|---|---|---|---|---|---|---|---|---|
| claude-haiku-4-5 | 100% | 55% | 50% | 58% | 65% | 71% | 52% | 58% | +0 pts vs pg [-13, 9] |
| claude-sonnet-4-6 | 97% | 62% | 70% | 55% | 84% | 92% | 62% | 60% | -7 pts vs fs [-22, 1] |
| claude-sonnet-5-5 | 96% | 91% | 95% | 81% | 97% | 94% | 76% | 77% | -10 pts vs fs [-20, 0] |
| gpt-5.4 | 100% | 67% | 90% | 50% | 70% | 70% | 50% | 54% | -17 pts vs fs [-30, -4] |
| gpt-5.4-mini | 95% | 62% | 90% | 43% | 57% | 53% | 54% | 52% | -19 pts vs fs [-33, -6] |
| gpt-6.1-sol | 100% | 100% | 100% | 86% | 100% | 99% | 86% | 95% | -14 pts vs fs [-24, -5] |

Pooled advantage: -11 pts [-19, -5].
Slope of advantage on capability (6 models): 0.85 [-1.62, 3.75].

| Family | claude-haiku-4-5 | claude-sonnet-4-6 | claude-sonnet-5-5 | gpt-5.4 | gpt-5.4-mini | gpt-6.1-sol | slope [95% CI] |
|---|---|---|---|---|---|---|---|
| A | f:75% g:75% g:95% g:90% mm:60% o:100% p:70% | f:70% g:90% g:90% g:100% mm:100% o:100% p:70% | f:100% g:90% g:100% g:100% mm:100% o:100% p:90% | f:80% g:55% g:80% g:100% mm:65% o:100% p:70% | f:85% g:75% g:80% g:80% mm:75% o:100% p:65% | f:100% g:90% g:100% g:100% mm:100% o:100% p:100% | n/a [n/a, n/a] |
| B | f:80% g:80% g:70% g:85% mm:40% o:100% p:60% | f:80% g:80% g:70% g:100% mm:40% o:100% p:60% | f:95% g:85% g:100% g:95% mm:60% o:100% p:65% | f:45% g:70% g:65% g:65% mm:40% o:100% p:60% | f:40% g:60% g:65% g:60% mm:40% o:90% p:50% | f:100% g:95% g:100% g:95% mm:90% o:100% p:85% | -1.10 [-2.30, 0.20] |
| C | f:90% g:65% g:85% g:90% mm:90% o:100% p:100% | f:85% g:70% g:100% g:100% mm:100% o:100% p:95% | f:100% g:75% g:100% g:100% mm:100% o:100% p:80% | f:80% g:70% g:100% g:100% mm:75% o:100% p:70% | f:95% g:70% g:90% g:85% mm:90% o:100% p:95% | f:100% g:100% g:100% g:100% mm:100% o:100% p:100% | n/a [n/a, n/a] |
| E | f:5% g:0% g:0% g:5% mm:0% o:100% p:0% | f:20% g:5% g:75% g:65% mm:0% o:85% p:10% | f:80% g:55% g:85% g:75% mm:20% o:80% p:75% | f:35% g:0% g:55% g:45% mm:0% o:100% p:15% | f:5% g:0% g:0% g:0% mm:0% o:95% p:0% | f:100% g:90% g:100% g:100% mm:40% o:100% p:100% | 0.30 [-1.27, 2.20] |
| F | f:25% g:70% g:75% g:85% mm:70% o:100% p:60% | f:55% g:30% g:85% g:95% mm:70% o:100% p:65% | f:80% g:100% g:100% g:100% mm:100% o:100% p:75% | f:95% g:55% g:50% g:40% mm:70% o:100% p:55% | f:85% g:10% g:50% g:40% mm:65% o:90% p:50% | f:100% g:55% g:100% g:100% mm:100% o:100% p:90% | 5.00 [1.33, 8.30] |

| Arm | C output leaks | C context exposures | unsafe writes | unsupported claims/answer | missed evidence |
|---|---|---|---|---|---|
| fs | 9/120 | 115/120 | 0 | 0.82 | 23% |
| fs-acl | 17/120 | 57/120 | 0 | 0.51 | 8% |
| gbrain-base | 29/120 | 58/120 | 0 | 0.90 | 30% |
| gbrain-next | 0/120 | 0/120 | 0 | 1.02 | 18% |
| gbrain-next-51a30c1 | 0/120 | 0/120 | 1 | 1.05 | 18% |
| memory | 9/120 | 64/120 | 0 | 0.74 | 57% |
| oracle | 0/120 | 0/120 | 0 | 0.77 | 0% |
| pg | 12/120 | 106/120 | 0 | 0.79 | 29% |

| Model | Arm | $/task | $/success | p50 s | p95 s | turns |
|---|---|---|---|---|---|---|
| claude-haiku-4-5 | fs | 0.024 | 0.043 | 10 | 30 | 5.5 |
| claude-haiku-4-5 | fs-acl | 0.017 | 0.034 | 5 | 23 | 5.8 |
| claude-haiku-4-5 | gbrain-base | 0.064 | 0.111 | 66 | 245 | 3.9 |
| claude-haiku-4-5 | gbrain-next | 0.087 | 0.134 | 200 | 360 | 3.7 |
| claude-haiku-4-5 | gbrain-next-51a30c1 | 0.076 | 0.107 | 168 | 375 | 4.0 |
| claude-haiku-4-5 | memory | 0.069 | 0.134 | 16 | 38 | 8.1 |
| claude-haiku-4-5 | oracle | 0.005 | 0.005 | 5 | 8 | 1.0 |
| claude-haiku-4-5 | pg | 0.015 | 0.026 | 8 | 33 | 4.1 |
| claude-sonnet-4-6 | fs | 0.051 | 0.082 | 14 | 60 | 4.6 |
| claude-sonnet-4-6 | fs-acl | 0.028 | 0.039 | 9 | 39 | 4.3 |
| claude-sonnet-4-6 | gbrain-base | 0.159 | 0.289 | 73 | 195 | 2.6 |
| claude-sonnet-4-6 | gbrain-next | 0.235 | 0.280 | 186 | 363 | 2.9 |
| claude-sonnet-4-6 | gbrain-next-51a30c1 | 0.193 | 0.210 | 158 | 350 | 3.0 |
| claude-sonnet-4-6 | memory | 0.180 | 0.291 | 16 | 96 | 5.9 |
| claude-sonnet-4-6 | oracle | 0.015 | 0.016 | 9 | 13 | 1.0 |
| claude-sonnet-4-6 | pg | 0.034 | 0.057 | 12 | 37 | 3.2 |
| claude-sonnet-5-5 | fs | 0.055 | 0.060 | 15 | 32 | 5.0 |
| claude-sonnet-5-5 | fs-acl | 0.023 | 0.024 | 9 | 15 | 4.3 |
| claude-sonnet-5-5 | gbrain-base | 0.175 | 0.216 | 72 | 271 | 3.8 |
| claude-sonnet-5-5 | gbrain-next | 0.254 | 0.262 | 169 | 459 | 3.8 |
| claude-sonnet-5-5 | gbrain-next-51a30c1 | 0.189 | 0.201 | 140 | 466 | 3.8 |
| claude-sonnet-5-5 | memory | 0.270 | 0.355 | 19 | 155 | 6.9 |
| claude-sonnet-5-5 | oracle | 0.010 | 0.011 | 6 | 11 | 1.0 |
| claude-sonnet-5-5 | pg | 0.035 | 0.046 | 10 | 29 | 3.8 |
| gpt-5.4 | fs | 0.034 | 0.051 | 10 | 22 | 3.9 |
| gpt-5.4 | fs-acl | 0.023 | 0.026 | 7 | 18 | 3.5 |
| gpt-5.4 | gbrain-base | 0.093 | 0.186 | 76 | 224 | 4.3 |
| gpt-5.4 | gbrain-next | 0.088 | 0.126 | 183 | 326 | 3.0 |
| gpt-5.4 | gbrain-next-51a30c1 | 0.095 | 0.135 | 163 | 397 | 3.3 |
| gpt-5.4 | memory | 0.092 | 0.183 | 9 | 23 | 4.1 |
| gpt-5.4 | oracle | 0.005 | 0.005 | 4 | 6 | 1.0 |
| gpt-5.4 | pg | 0.021 | 0.038 | 10 | 18 | 3.2 |
| gpt-5.4-mini | fs | 0.008 | 0.013 | 9 | 18 | 4.5 |
| gpt-5.4-mini | fs-acl | 0.006 | 0.006 | 6 | 17 | 4.7 |
| gpt-5.4-mini | gbrain-base | 0.017 | 0.040 | 67 | 172 | 3.3 |
| gpt-5.4-mini | gbrain-next | 0.025 | 0.044 | 177 | 298 | 3.3 |
| gpt-5.4-mini | gbrain-next-51a30c1 | 0.023 | 0.044 | 133 | 315 | 3.4 |
| gpt-5.4-mini | memory | 0.030 | 0.055 | 8 | 25 | 5.6 |
| gpt-5.4-mini | oracle | 0.002 | 0.002 | 3 | 6 | 1.1 |
| gpt-5.4-mini | pg | 0.004 | 0.008 | 8 | 18 | 3.7 |
| gpt-6.1-sol | fs | 0.022 | 0.022 | 20 | 44 | 4.8 |
| gpt-6.1-sol | fs-acl | 0.015 | 0.015 | 17 | 22 | 5.5 |
| gpt-6.1-sol | gbrain-base | 0.077 | 0.090 | 75 | 240 | 3.8 |
| gpt-6.1-sol | gbrain-next | 0.092 | 0.092 | 192 | 416 | 4.1 |
| gpt-6.1-sol | gbrain-next-51a30c1 | 0.081 | 0.082 | 165 | 405 | 4.0 |
| gpt-6.1-sol | memory | 0.187 | 0.217 | 21 | 270 | 6.5 |
| gpt-6.1-sol | oracle | 0.005 | 0.005 | 5 | 9 | 1.0 |
| gpt-6.1-sol | pg | 0.018 | 0.019 | 16 | 30 | 4.0 |
