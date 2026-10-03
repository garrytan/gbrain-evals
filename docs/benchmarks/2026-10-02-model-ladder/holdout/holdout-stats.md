Cells: 4320. Arms: oracle, fs, fs-acl, pg, memory, gbrain-base, gbrain-next-51a30c1, gbrain-next. Models: claude-haiku-4-5, claude-sonnet-4-6, claude-sonnet-5-5, gpt-5.4-mini, gpt-5.4, gpt-6.1-sol.

### Cell counts per arm

| Arm | cells | tasks | repeats |
|---|---|---|---|
| oracle | 600 | 50 | 2 |
| fs | 600 | 50 | 2 |
| fs-acl | 120 | 10 | 2 |
| pg | 600 | 50 | 2 |
| memory | 600 | 50 | 2 |
| gbrain-base | 600 | 50 | 2 |
| gbrain-next-51a30c1 | 600 | 50 | 2 |
| gbrain-next | 600 | 50 | 2 |

### Success by family (all models, both repeats)

| Family | fs | pg | memory | gbrain-base | gbrain-next-51a30c1 | gbrain-next | oracle |
|---|---|---|---|---|---|---|---|
| A | 85.0% | 77.5% | 83.3% | 79.2% | 95.0% | 90.8% | 100.0% |
| B | 73.3% | 63.3% | 51.7% | 78.3% | 83.3% | 78.3% | 98.3% |
| C | 91.7% | 90.0% | 92.5% | 75.0% | 95.8% | 95.8% | 100.0% |
| E | 40.8% | 33.3% | 10.0% | 25.0% | 48.3% | 52.5% | 93.3% |
| F | 73.3% | 65.8% | 79.2% | 53.3% | 76.7% | 76.7% | 98.3% |
| all | 72.8% | 66.0% | 63.3% | 62.2% | 79.8% | 78.8% | 98.0% |

### Success by model (all families, both repeats)

| Model | fs | pg | memory | gbrain-base | gbrain-next-51a30c1 | gbrain-next | oracle |
|---|---|---|---|---|---|---|---|
| claude-haiku-4-5 | 55.0% | 58.0% | 52.0% | 58.0% | 71.0% | 65.0% | 100.0% |
| claude-sonnet-4-6 | 62.0% | 60.0% | 62.0% | 55.0% | 92.0% | 84.0% | 97.0% |
| claude-sonnet-5-5 | 91.0% | 77.0% | 76.0% | 81.0% | 94.0% | 97.0% | 96.0% |
| gpt-5.4-mini | 62.0% | 52.0% | 54.0% | 43.0% | 53.0% | 57.0% | 95.0% |
| gpt-5.4 | 67.0% | 54.0% | 50.0% | 50.0% | 70.0% | 70.0% | 100.0% |
| gpt-6.1-sol | 100.0% | 95.0% | 86.0% | 86.0% | 99.0% | 100.0% | 100.0% |
| all | 72.8% | 66.0% | 63.3% | 62.2% | 79.8% | 78.8% | 98.0% |

### Success by model and family

| Model | Family | fs | pg | memory | gbrain-base | gbrain-next-51a30c1 | gbrain-next |
|---|---|---|---|---|---|---|---|
| claude-haiku-4-5 | A | 75.0% | 70.0% | 60.0% | 75.0% | 90.0% | 95.0% |
| claude-haiku-4-5 | B | 80.0% | 60.0% | 40.0% | 80.0% | 85.0% | 70.0% |
| claude-haiku-4-5 | C | 90.0% | 100.0% | 90.0% | 65.0% | 90.0% | 85.0% |
| claude-haiku-4-5 | E | 5.0% | 0.0% | 0.0% | 0.0% | 5.0% | 0.0% |
| claude-haiku-4-5 | F | 25.0% | 60.0% | 70.0% | 70.0% | 85.0% | 75.0% |
| claude-sonnet-4-6 | A | 70.0% | 70.0% | 100.0% | 90.0% | 100.0% | 90.0% |
| claude-sonnet-4-6 | B | 80.0% | 60.0% | 40.0% | 80.0% | 100.0% | 70.0% |
| claude-sonnet-4-6 | C | 85.0% | 95.0% | 100.0% | 70.0% | 100.0% | 100.0% |
| claude-sonnet-4-6 | E | 20.0% | 10.0% | 0.0% | 5.0% | 65.0% | 75.0% |
| claude-sonnet-4-6 | F | 55.0% | 65.0% | 70.0% | 30.0% | 95.0% | 85.0% |
| claude-sonnet-5-5 | A | 100.0% | 90.0% | 100.0% | 90.0% | 100.0% | 100.0% |
| claude-sonnet-5-5 | B | 95.0% | 65.0% | 60.0% | 85.0% | 95.0% | 100.0% |
| claude-sonnet-5-5 | C | 100.0% | 80.0% | 100.0% | 75.0% | 100.0% | 100.0% |
| claude-sonnet-5-5 | E | 80.0% | 75.0% | 20.0% | 55.0% | 75.0% | 85.0% |
| claude-sonnet-5-5 | F | 80.0% | 75.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| gpt-5.4-mini | A | 85.0% | 65.0% | 75.0% | 75.0% | 80.0% | 80.0% |
| gpt-5.4-mini | B | 40.0% | 50.0% | 40.0% | 60.0% | 60.0% | 65.0% |
| gpt-5.4-mini | C | 95.0% | 95.0% | 90.0% | 70.0% | 85.0% | 90.0% |
| gpt-5.4-mini | E | 5.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| gpt-5.4-mini | F | 85.0% | 50.0% | 65.0% | 10.0% | 40.0% | 50.0% |
| gpt-5.4 | A | 80.0% | 70.0% | 65.0% | 55.0% | 100.0% | 80.0% |
| gpt-5.4 | B | 45.0% | 60.0% | 40.0% | 70.0% | 65.0% | 65.0% |
| gpt-5.4 | C | 80.0% | 70.0% | 75.0% | 70.0% | 100.0% | 100.0% |
| gpt-5.4 | E | 35.0% | 15.0% | 0.0% | 0.0% | 45.0% | 55.0% |
| gpt-5.4 | F | 95.0% | 55.0% | 70.0% | 55.0% | 40.0% | 50.0% |
| gpt-6.1-sol | A | 100.0% | 100.0% | 100.0% | 90.0% | 100.0% | 100.0% |
| gpt-6.1-sol | B | 100.0% | 85.0% | 90.0% | 95.0% | 95.0% | 100.0% |
| gpt-6.1-sol | C | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| gpt-6.1-sol | E | 100.0% | 100.0% | 40.0% | 90.0% | 100.0% | 100.0% |
| gpt-6.1-sol | F | 100.0% | 90.0% | 100.0% | 55.0% | 100.0% | 100.0% |

### Leaks and safety per arm (all families)

| Arm | cells | output leaks | context exposures | unsafe writes | over-refusals | family C cells | C output leaks | C context exposures |
|---|---|---|---|---|---|---|---|---|
| oracle | 600 | 0 | 0 | 0 | 1 | 120 | 0 | 0 |
| fs | 600 | 9 | 115 | 0 | 1 | 120 | 9 | 115 |
| fs-acl | 120 | 17 | 57 | 0 | 0 | 120 | 17 | 57 |
| pg | 600 | 12 | 106 | 0 | 0 | 120 | 12 | 106 |
| memory | 600 | 9 | 64 | 0 | 19 | 120 | 9 | 64 |
| gbrain-base | 600 | 29 | 58 | 0 | 4 | 120 | 29 | 58 |
| gbrain-next-51a30c1 | 600 | 0 | 0 | 1 | 4 | 120 | 0 | 0 |
| gbrain-next | 600 | 0 | 0 | 0 | 2 | 120 | 0 | 0 |

### Cost and latency per arm (agent + gbrain-internal $ per cell, judge excluded; wall-clock per cell incl. judge)

| Arm | $/task | $/success | judge $/task | p50 s | p95 s | mean turns |
|---|---|---|---|---|---|---|
| oracle | 0.0070 | 0.0072 | 0.0027 | 5.1 | 10.4 | 1.0 |
| fs | 0.0323 | 0.0444 | 0.0027 | 12.2 | 38.5 | 4.7 |
| fs-acl | 0.0186 | 0.0225 | 0.0012 | 8.3 | 20.9 | 4.7 |
| pg | 0.0212 | 0.0321 | 0.0027 | 10.1 | 29.3 | 3.7 |
| memory | 0.1380 | 0.2179 | 0.0021 | 14.3 | 112.3 | 6.2 |
| gbrain-base | 0.0976 | 0.1570 | 0.0029 | 71.4 | 222.6 | 3.6 |
| gbrain-next-51a30c1 | 0.1093 | 0.1369 | 0.0030 | 157.1 | 384.0 | 3.6 |
| gbrain-next | 0.1302 | 0.1652 | 0.0029 | 183.6 | 383.9 | 3.5 |

### Cost and latency per model and arm

| Model | Arm | success | $/task | p50 s | p95 s |
|---|---|---|---|---|---|
| claude-haiku-4-5 | fs | 55.0% | 0.0237 | 9.6 | 29.4 |
| claude-haiku-4-5 | pg | 58.0% | 0.0148 | 7.9 | 29.3 |
| claude-haiku-4-5 | memory | 52.0% | 0.0695 | 15.5 | 37.6 |
| claude-haiku-4-5 | gbrain-base | 58.0% | 0.0642 | 65.8 | 228.5 |
| claude-haiku-4-5 | gbrain-next-51a30c1 | 71.0% | 0.0756 | 165.4 | 365.0 |
| claude-haiku-4-5 | gbrain-next | 65.0% | 0.0869 | 199.8 | 346.4 |
| claude-sonnet-4-6 | fs | 62.0% | 0.0511 | 13.6 | 58.9 |
| claude-sonnet-4-6 | pg | 60.0% | 0.0341 | 12.1 | 36.7 |
| claude-sonnet-4-6 | memory | 62.0% | 0.1803 | 16.1 | 91.2 |
| claude-sonnet-4-6 | gbrain-base | 55.0% | 0.1590 | 70.0 | 191.0 |
| claude-sonnet-4-6 | gbrain-next-51a30c1 | 92.0% | 0.1928 | 156.7 | 329.8 |
| claude-sonnet-4-6 | gbrain-next | 84.0% | 0.2353 | 181.9 | 356.1 |
| claude-sonnet-5-5 | fs | 91.0% | 0.0550 | 14.8 | 32.1 |
| claude-sonnet-5-5 | pg | 77.0% | 0.0351 | 9.7 | 28.2 |
| claude-sonnet-5-5 | memory | 76.0% | 0.2698 | 19.1 | 147.8 |
| claude-sonnet-5-5 | gbrain-base | 81.0% | 0.1747 | 70.1 | 263.4 |
| claude-sonnet-5-5 | gbrain-next-51a30c1 | 94.0% | 0.1887 | 140.4 | 464.7 |
| claude-sonnet-5-5 | gbrain-next | 97.0% | 0.2539 | 169.1 | 454.3 |
| gpt-5.4-mini | fs | 62.0% | 0.0079 | 9.1 | 16.9 |
| gpt-5.4-mini | pg | 52.0% | 0.0043 | 7.8 | 17.7 |
| gpt-5.4-mini | memory | 54.0% | 0.0300 | 8.3 | 23.8 |
| gpt-5.4-mini | gbrain-base | 43.0% | 0.0171 | 67.0 | 165.2 |
| gpt-5.4-mini | gbrain-next-51a30c1 | 53.0% | 0.0232 | 133.2 | 314.6 |
| gpt-5.4-mini | gbrain-next | 57.0% | 0.0252 | 172.0 | 294.2 |
| gpt-5.4 | fs | 67.0% | 0.0341 | 10.1 | 21.6 |
| gpt-5.4 | pg | 54.0% | 0.0205 | 10.1 | 18.5 |
| gpt-5.4 | memory | 50.0% | 0.0917 | 9.0 | 22.7 |
| gpt-5.4 | gbrain-base | 50.0% | 0.0932 | 75.4 | 223.1 |
| gpt-5.4 | gbrain-next-51a30c1 | 70.0% | 0.0946 | 162.0 | 384.0 |
| gpt-5.4 | gbrain-next | 70.0% | 0.0883 | 179.0 | 315.1 |
| gpt-6.1-sol | fs | 100.0% | 0.0223 | 19.4 | 43.0 |
| gpt-6.1-sol | pg | 95.0% | 0.0185 | 15.5 | 30.2 |
| gpt-6.1-sol | memory | 86.0% | 0.1869 | 20.8 | 250.4 |
| gpt-6.1-sol | gbrain-base | 86.0% | 0.0775 | 74.7 | 234.0 |
| gpt-6.1-sol | gbrain-next-51a30c1 | 99.0% | 0.0809 | 163.3 | 402.0 |
| gpt-6.1-sol | gbrain-next | 100.0% | 0.0917 | 191.8 | 414.3 |

### Paired per-task difference: gbrain-next minus gbrain-base

Per task, success is averaged over repeats (and over models in the pooled rows). 95% CI is a percentile bootstrap over tasks (10,000 resamples, seed 20261003). Sign test is exact two-sided over tasks with a nonzero difference.

| Slice | tasks | mean diff | 95% CI | tasks better/worse/tied | sign-test p |
|---|---|---|---|---|---|
| all models | 50 | +16.7 pp | [+9.7, +23.8] | 29/10/11 | 0.00338 |
| all models, family A | 10 | +11.7 pp | [-3.3, +31.7] | 3/3/4 | 1 |
| all models, family B | 10 | +0.0 pp | [-10.8, +11.7] | 3/4/3 | 1 |
| all models, family C | 10 | +20.8 pp | [-1.7, +45.8] | 3/3/4 | 1 |
| all models, family E | 10 | +27.5 pp | [+21.7, +33.3] | 10/0/0 | 0.00195 |
| all models, family F | 10 | +23.3 pp | [+17.5, +29.2] | 10/0/0 | 0.00195 |
| claude-haiku-4-5 | 50 | +7.0 pp | [-2.0, +17.0] | 8/5/37 | 0.581 |
| claude-sonnet-4-6 | 50 | +29.0 pp | [+15.0, +43.0] | 21/4/25 | 0.000911 |
| claude-sonnet-5-5 | 50 | +16.0 pp | [+8.0, +25.0] | 11/0/39 | 0.000977 |
| gpt-5.4-mini | 50 | +14.0 pp | [+3.0, +26.0] | 13/6/31 | 0.167 |
| gpt-5.4 | 50 | +20.0 pp | [+7.0, +33.0] | 18/5/27 | 0.0106 |
| gpt-6.1-sol | 50 | +14.0 pp | [+5.0, +24.0] | 8/0/42 | 0.00781 |

### Paired per-task difference: gbrain-next minus fs

Per task, success is averaged over repeats (and over models in the pooled rows). 95% CI is a percentile bootstrap over tasks (10,000 resamples, seed 20261003). Sign test is exact two-sided over tasks with a nonzero difference.

| Slice | tasks | mean diff | 95% CI | tasks better/worse/tied | sign-test p |
|---|---|---|---|---|---|
| all models | 50 | +6.0 pp | [-0.2, +12.3] | 22/16/12 | 0.418 |
| all models, family A | 10 | +5.8 pp | [-10.8, +25.0] | 3/3/4 | 1 |
| all models, family B | 10 | +5.0 pp | [-3.3, +14.2] | 3/3/4 | 1 |
| all models, family C | 10 | +4.2 pp | [-2.5, +11.7] | 4/3/3 | 1 |
| all models, family E | 10 | +11.7 pp | [+2.5, +20.0] | 7/2/1 | 0.18 |
| all models, family F | 10 | +3.3 pp | [-17.5, +25.0] | 5/5/0 | 1 |
| claude-haiku-4-5 | 50 | +10.0 pp | [-4.0, +24.0] | 13/9/28 | 0.523 |
| claude-sonnet-4-6 | 50 | +22.0 pp | [+8.0, +36.0] | 19/6/25 | 0.0146 |
| claude-sonnet-5-5 | 50 | +6.0 pp | [+1.0, +12.0] | 5/0/45 | 0.0625 |
| gpt-5.4-mini | 50 | -5.0 pp | [-17.0, +7.0] | 7/11/32 | 0.481 |
| gpt-5.4 | 50 | +3.0 pp | [-12.0, +18.0] | 11/9/30 | 0.824 |
| gpt-6.1-sol | 50 | +0.0 pp | [+0.0, +0.0] | 0/0/50 | 1 |

### Paired per-task difference: gbrain-base minus fs

Per task, success is averaged over repeats (and over models in the pooled rows). 95% CI is a percentile bootstrap over tasks (10,000 resamples, seed 20261003). Sign test is exact two-sided over tasks with a nonzero difference.

| Slice | tasks | mean diff | 95% CI | tasks better/worse/tied | sign-test p |
|---|---|---|---|---|---|
| all models | 50 | -10.7 pp | [-18.2, -3.5] | 11/22/17 | 0.0801 |
| all models, family A | 10 | -5.8 pp | [-11.7, +0.0] | 0/3/7 | 0.25 |
| all models, family B | 10 | +5.0 pp | [-3.3, +14.2] | 3/3/4 | 1 |
| all models, family C | 10 | -16.7 pp | [-35.8, +0.8] | 3/4/3 | 1 |
| all models, family E | 10 | -15.8 pp | [-26.7, -6.7] | 0/7/3 | 0.0156 |
| all models, family F | 10 | -20.0 pp | [-45.0, +5.0] | 5/5/0 | 1 |
| claude-haiku-4-5 | 50 | +3.0 pp | [-11.0, +16.0] | 9/8/33 | 1 |
| claude-sonnet-4-6 | 50 | -7.0 pp | [-21.0, +7.0] | 8/11/31 | 0.648 |
| claude-sonnet-5-5 | 50 | -10.0 pp | [-21.0, +0.0] | 4/11/35 | 0.118 |
| gpt-5.4-mini | 50 | -19.0 pp | [-33.0, -5.0] | 5/19/26 | 0.00661 |
| gpt-5.4 | 50 | -17.0 pp | [-30.0, -5.0] | 4/15/31 | 0.0192 |
| gpt-6.1-sol | 50 | -14.0 pp | [-24.0, -5.0] | 0/8/42 | 0.00781 |

### Paired per-task difference: gbrain-next-51a30c1 minus gbrain-base

Per task, success is averaged over repeats (and over models in the pooled rows). 95% CI is a percentile bootstrap over tasks (10,000 resamples, seed 20261003). Sign test is exact two-sided over tasks with a nonzero difference.

| Slice | tasks | mean diff | 95% CI | tasks better/worse/tied | sign-test p |
|---|---|---|---|---|---|
| all models | 50 | +17.7 pp | [+11.2, +24.7] | 30/8/12 | 0.000472 |
| all models, family A | 10 | +15.8 pp | [+1.7, +32.5] | 5/1/4 | 0.219 |
| all models, family B | 10 | +5.0 pp | [-5.8, +18.3] | 3/4/3 | 1 |
| all models, family C | 10 | +20.8 pp | [+0.0, +45.0] | 4/3/3 | 1 |
| all models, family E | 10 | +23.3 pp | [+13.3, +32.5] | 9/0/1 | 0.00391 |
| all models, family F | 10 | +23.3 pp | [+15.0, +32.5] | 9/0/1 | 0.00391 |
| claude-haiku-4-5 | 50 | +13.0 pp | [+2.0, +25.0] | 11/4/35 | 0.118 |
| claude-sonnet-4-6 | 50 | +37.0 pp | [+25.0, +50.0] | 22/0/28 | 4.77e-07 |
| claude-sonnet-5-5 | 50 | +13.0 pp | [+5.0, +22.0] | 10/1/39 | 0.0117 |
| gpt-5.4-mini | 50 | +10.0 pp | [+0.0, +21.0] | 12/6/32 | 0.238 |
| gpt-5.4 | 50 | +20.0 pp | [+8.0, +33.0] | 16/5/29 | 0.0266 |
| gpt-6.1-sol | 50 | +13.0 pp | [+4.0, +23.0] | 8/1/41 | 0.0391 |

### Paired per-task difference: gbrain-next minus gbrain-next-51a30c1

Per task, success is averaged over repeats (and over models in the pooled rows). 95% CI is a percentile bootstrap over tasks (10,000 resamples, seed 20261003). Sign test is exact two-sided over tasks with a nonzero difference.

| Slice | tasks | mean diff | 95% CI | tasks better/worse/tied | sign-test p |
|---|---|---|---|---|---|
| all models | 50 | -1.0 pp | [-3.7, +1.8] | 13/19/18 | 0.377 |
| all models, family A | 10 | -4.2 pp | [-9.2, +0.8] | 2/5/3 | 0.453 |
| all models, family B | 10 | -5.0 pp | [-10.8, +0.8] | 3/6/1 | 0.508 |
| all models, family C | 10 | +0.0 pp | [-3.3, +3.3] | 2/2/6 | 1 |
| all models, family E | 10 | +4.2 pp | [-3.3, +12.5] | 4/4/2 | 1 |
| all models, family F | 10 | +0.0 pp | [-5.0, +5.0] | 2/2/6 | 1 |
| claude-haiku-4-5 | 50 | -6.0 pp | [-14.0, +1.0] | 3/7/40 | 0.344 |
| claude-sonnet-4-6 | 50 | -8.0 pp | [-18.0, +1.0] | 5/10/35 | 0.302 |
| claude-sonnet-5-5 | 50 | +3.0 pp | [+0.0, +7.0] | 3/0/47 | 0.25 |
| gpt-5.4-mini | 50 | +4.0 pp | [-4.0, +12.0] | 8/4/38 | 0.388 |
| gpt-5.4 | 50 | +0.0 pp | [-10.0, +10.0] | 10/8/32 | 0.815 |
| gpt-6.1-sol | 50 | +1.0 pp | [+0.0, +3.0] | 1/0/49 | 1 |

Spend in these records (agent + gbrain internal + judge): $335.20
- oracle: $5.85
- fs: $21.01
- fs-acl: $2.38
- pg: $14.37
- memory: $84.06
- gbrain-base: $60.30
- gbrain-next-51a30c1: $67.35
- gbrain-next: $79.88
