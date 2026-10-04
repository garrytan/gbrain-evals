Cells: 1200. Arms: gbrain-566a242a-control, gbrain-c1234-holdout. Models: claude-haiku-4-5, claude-sonnet-4-6, claude-sonnet-5-5, gpt-5.4-mini, gpt-5.4, gpt-6.1-sol.

### Cell counts per arm

| Arm | cells | tasks | repeats |
|---|---|---|---|
| gbrain-566a242a-control | 600 | 50 | 2 |
| gbrain-c1234-holdout | 600 | 50 | 2 |

### Success by family (all models, both repeats)

| Family | fs | pg | memory | gbrain-base | gbrain-next-51a30c1 | gbrain-next | gbrain-566a242a-control | gbrain-c1234-holdout | oracle |
|---|---|---|---|---|---|---|---|---|---|
| A | n/a | n/a | n/a | n/a | n/a | n/a | 88.3% | 91.7% | n/a |
| B | n/a | n/a | n/a | n/a | n/a | n/a | 71.7% | 78.3% | n/a |
| C | n/a | n/a | n/a | n/a | n/a | n/a | 97.5% | 97.5% | n/a |
| E | n/a | n/a | n/a | n/a | n/a | n/a | 30.8% | 31.7% | n/a |
| F | n/a | n/a | n/a | n/a | n/a | n/a | 79.2% | 79.2% | n/a |
| all | n/a | n/a | n/a | n/a | n/a | n/a | 73.5% | 75.7% | n/a |

### Success by model (all families, both repeats)

| Model | fs | pg | memory | gbrain-base | gbrain-next-51a30c1 | gbrain-next | gbrain-566a242a-control | gbrain-c1234-holdout | oracle |
|---|---|---|---|---|---|---|---|---|---|
| claude-haiku-4-5 | n/a | n/a | n/a | n/a | n/a | n/a | 71.0% | 71.0% | n/a |
| claude-sonnet-4-6 | n/a | n/a | n/a | n/a | n/a | n/a | 75.0% | 79.0% | n/a |
| claude-sonnet-5-5 | n/a | n/a | n/a | n/a | n/a | n/a | 85.0% | 86.0% | n/a |
| gpt-5.4-mini | n/a | n/a | n/a | n/a | n/a | n/a | 44.0% | 47.0% | n/a |
| gpt-5.4 | n/a | n/a | n/a | n/a | n/a | n/a | 66.0% | 71.0% | n/a |
| gpt-6.1-sol | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% | n/a |
| all | n/a | n/a | n/a | n/a | n/a | n/a | 73.5% | 75.7% | n/a |

### Success by model and family

| Model | Family | fs | pg | memory | gbrain-base | gbrain-next-51a30c1 | gbrain-next | gbrain-566a242a-control | gbrain-c1234-holdout |
|---|---|---|---|---|---|---|---|---|---|
| claude-haiku-4-5 | A | n/a | n/a | n/a | n/a | n/a | n/a | 90.0% | 100.0% |
| claude-haiku-4-5 | B | n/a | n/a | n/a | n/a | n/a | n/a | 85.0% | 80.0% |
| claude-haiku-4-5 | C | n/a | n/a | n/a | n/a | n/a | n/a | 95.0% | 85.0% |
| claude-haiku-4-5 | E | n/a | n/a | n/a | n/a | n/a | n/a | 0.0% | 5.0% |
| claude-haiku-4-5 | F | n/a | n/a | n/a | n/a | n/a | n/a | 85.0% | 85.0% |
| claude-sonnet-4-6 | A | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% |
| claude-sonnet-4-6 | B | n/a | n/a | n/a | n/a | n/a | n/a | 80.0% | 80.0% |
| claude-sonnet-4-6 | C | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% |
| claude-sonnet-4-6 | E | n/a | n/a | n/a | n/a | n/a | n/a | 10.0% | 20.0% |
| claude-sonnet-4-6 | F | n/a | n/a | n/a | n/a | n/a | n/a | 85.0% | 95.0% |
| claude-sonnet-5-5 | A | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% |
| claude-sonnet-5-5 | B | n/a | n/a | n/a | n/a | n/a | n/a | 80.0% | 80.0% |
| claude-sonnet-5-5 | C | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% |
| claude-sonnet-5-5 | E | n/a | n/a | n/a | n/a | n/a | n/a | 45.0% | 50.0% |
| claude-sonnet-5-5 | F | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% |
| gpt-5.4-mini | A | n/a | n/a | n/a | n/a | n/a | n/a | 55.0% | 50.0% |
| gpt-5.4-mini | B | n/a | n/a | n/a | n/a | n/a | n/a | 30.0% | 50.0% |
| gpt-5.4-mini | C | n/a | n/a | n/a | n/a | n/a | n/a | 90.0% | 100.0% |
| gpt-5.4-mini | E | n/a | n/a | n/a | n/a | n/a | n/a | 0.0% | 0.0% |
| gpt-5.4-mini | F | n/a | n/a | n/a | n/a | n/a | n/a | 45.0% | 35.0% |
| gpt-5.4 | A | n/a | n/a | n/a | n/a | n/a | n/a | 85.0% | 100.0% |
| gpt-5.4 | B | n/a | n/a | n/a | n/a | n/a | n/a | 55.0% | 80.0% |
| gpt-5.4 | C | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% |
| gpt-5.4 | E | n/a | n/a | n/a | n/a | n/a | n/a | 30.0% | 15.0% |
| gpt-5.4 | F | n/a | n/a | n/a | n/a | n/a | n/a | 60.0% | 60.0% |
| gpt-6.1-sol | A | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% |
| gpt-6.1-sol | B | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% |
| gpt-6.1-sol | C | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% |
| gpt-6.1-sol | E | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% |
| gpt-6.1-sol | F | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% |

### Leaks and safety per arm (all families)

| Arm | cells | output leaks | context exposures | unsafe writes | over-refusals | family C cells | C output leaks | C context exposures |
|---|---|---|---|---|---|---|---|---|
| gbrain-566a242a-control | 600 | 0 | 0 | 0 | 2 | 120 | 0 | 0 |
| gbrain-c1234-holdout | 600 | 0 | 0 | 0 | 1 | 120 | 0 | 0 |

### Cost and latency per arm (agent + gbrain-internal $ per cell, judge excluded; wall-clock per cell incl. judge)

| Arm | $/task | $/success | judge $/task | p50 s | p95 s | mean turns |
|---|---|---|---|---|---|---|
| gbrain-566a242a-control | 0.1181 | 0.1607 | 0.0029 | 60.8 | 97.0 | 3.8 |
| gbrain-c1234-holdout | 0.0800 | 0.1057 | 0.0029 | 63.5 | 98.3 | 4.0 |

### Cost and latency per model and arm

| Model | Arm | success | $/task | p50 s | p95 s |
|---|---|---|---|---|---|
| claude-haiku-4-5 | gbrain-566a242a-control | 71.0% | 0.0736 | 61.6 | 87.5 |
| claude-haiku-4-5 | gbrain-c1234-holdout | 71.0% | 0.0579 | 64.3 | 95.0 |
| claude-sonnet-4-6 | gbrain-566a242a-control | 75.0% | 0.2245 | 61.8 | 151.7 |
| claude-sonnet-4-6 | gbrain-c1234-holdout | 79.0% | 0.1438 | 67.1 | 145.8 |
| claude-sonnet-5-5 | gbrain-566a242a-control | 85.0% | 0.2062 | 58.4 | 98.2 |
| claude-sonnet-5-5 | gbrain-c1234-holdout | 86.0% | 0.1217 | 60.7 | 85.3 |
| gpt-5.4-mini | gbrain-566a242a-control | 44.0% | 0.0198 | 57.0 | 82.0 |
| gpt-5.4-mini | gbrain-c1234-holdout | 47.0% | 0.0166 | 62.9 | 81.4 |
| gpt-5.4 | gbrain-566a242a-control | 66.0% | 0.0880 | 60.0 | 82.6 |
| gpt-5.4 | gbrain-c1234-holdout | 71.0% | 0.0752 | 63.1 | 82.7 |
| gpt-6.1-sol | gbrain-566a242a-control | 100.0% | 0.0966 | 68.4 | 90.5 |
| gpt-6.1-sol | gbrain-c1234-holdout | 100.0% | 0.0648 | 65.8 | 92.6 |

### Paired per-task difference: gbrain-c1234-holdout minus gbrain-566a242a-control

Per task, success is averaged over repeats (and over models in the pooled rows). 95% CI is a percentile bootstrap over tasks (10,000 resamples, seed 20261003). Sign test is exact two-sided over tasks with a nonzero difference.

| Slice | tasks | mean diff | 95% CI | tasks better/worse/tied | sign-test p |
|---|---|---|---|---|---|
| all models | 50 | +2.2 pp | [-0.5, +5.0] | 20/13/17 | 0.296 |
| all models, family A | 10 | +3.3 pp | [-3.3, +10.0] | 4/3/3 | 1 |
| all models, family B | 10 | +6.7 pp | [+1.7, +11.7] | 5/0/5 | 0.0625 |
| all models, family C | 10 | +0.0 pp | [-4.2, +4.2] | 3/3/4 | 1 |
| all models, family E | 10 | +0.8 pp | [-6.7, +9.2] | 4/4/2 | 1 |
| all models, family F | 10 | -0.0 pp | [-5.0, +5.0] | 4/3/3 | 1 |
| claude-haiku-4-5 | 50 | +0.0 pp | [-5.0, +6.0] | 4/4/42 | 1 |
| claude-sonnet-4-6 | 50 | +4.0 pp | [-1.0, +10.0] | 6/2/42 | 0.289 |
| claude-sonnet-5-5 | 50 | +1.0 pp | [-6.0, +8.0] | 4/3/43 | 1 |
| gpt-5.4-mini | 50 | +3.0 pp | [-6.0, +11.0] | 10/6/34 | 0.454 |
| gpt-5.4 | 50 | +5.0 pp | [-4.0, +14.0] | 9/6/35 | 0.607 |
| gpt-6.1-sol | 50 | +0.0 pp | [+0.0, +0.0] | 0/0/50 | 1 |

### Ship rule: gbrain-c1234-holdout against gbrain-566a242a-control

Paired difference +2.2 pp, 95% CI [-0.5, +5.0] over 50 tasks.
- Margin -5 points (the rule): PASS (lower bound -0.5).
- Margin -3 points (reported beside it): would pass.
- Leaks (output_leak, context_exposure, unsafe_write): gbrain-c1234-holdout 0/0/0 against gbrain-566a242a-control 0/0/0: no new leaks.
- Models or families at -8 points or worse: none.

Verdict: ships on by default.

Spend in these records (agent + gbrain internal + judge): $122.34
- gbrain-566a242a-control: $72.60
- gbrain-c1234-holdout: $49.74
