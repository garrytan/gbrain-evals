Cells: 1000. Arms: gbrain-c1234-holdout, gbrain-entity-holdout. Models: claude-sonnet-5-5, gpt-6.1-sol, claude-fable-5-1, claude-opus-5-5, gpt-6-astra.

### Cell counts per arm

| Arm | cells | tasks | repeats |
|---|---|---|---|
| gbrain-c1234-holdout | 500 | 50 | 2 |
| gbrain-entity-holdout | 500 | 50 | 2 |

### Success by family (all models, both repeats)

| Family | fs | pg | memory | gbrain-base | gbrain-next-51a30c1 | gbrain-next | gbrain-c1234-holdout | gbrain-entity-holdout | oracle |
|---|---|---|---|---|---|---|---|---|---|
| A | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% | n/a |
| B | n/a | n/a | n/a | n/a | n/a | n/a | 90.0% | 85.0% | n/a |
| C | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% | n/a |
| E | n/a | n/a | n/a | n/a | n/a | n/a | 86.0% | 93.0% | n/a |
| F | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% | n/a |
| all | n/a | n/a | n/a | n/a | n/a | n/a | 95.2% | 95.6% | n/a |

### Success by model (all families, both repeats)

| Model | fs | pg | memory | gbrain-base | gbrain-next-51a30c1 | gbrain-next | gbrain-c1234-holdout | gbrain-entity-holdout | oracle |
|---|---|---|---|---|---|---|---|---|---|
| claude-sonnet-5-5 | n/a | n/a | n/a | n/a | n/a | n/a | 86.0% | 93.0% | n/a |
| gpt-6.1-sol | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% | n/a |
| claude-fable-5-1 | n/a | n/a | n/a | n/a | n/a | n/a | 94.0% | 95.0% | n/a |
| claude-opus-5-5 | n/a | n/a | n/a | n/a | n/a | n/a | 96.0% | 92.0% | n/a |
| gpt-6-astra | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 98.0% | n/a |
| all | n/a | n/a | n/a | n/a | n/a | n/a | 95.2% | 95.6% | n/a |

### Success by model and family

| Model | Family | fs | pg | memory | gbrain-base | gbrain-next-51a30c1 | gbrain-next | gbrain-c1234-holdout | gbrain-entity-holdout |
|---|---|---|---|---|---|---|---|---|---|
| claude-sonnet-5-5 | A | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% |
| claude-sonnet-5-5 | B | n/a | n/a | n/a | n/a | n/a | n/a | 80.0% | 80.0% |
| claude-sonnet-5-5 | C | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% |
| claude-sonnet-5-5 | E | n/a | n/a | n/a | n/a | n/a | n/a | 50.0% | 85.0% |
| claude-sonnet-5-5 | F | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% |
| gpt-6.1-sol | A | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% |
| gpt-6.1-sol | B | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% |
| gpt-6.1-sol | C | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% |
| gpt-6.1-sol | E | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% |
| gpt-6.1-sol | F | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% |
| claude-fable-5-1 | A | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% |
| claude-fable-5-1 | B | n/a | n/a | n/a | n/a | n/a | n/a | 80.0% | 85.0% |
| claude-fable-5-1 | C | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% |
| claude-fable-5-1 | E | n/a | n/a | n/a | n/a | n/a | n/a | 90.0% | 90.0% |
| claude-fable-5-1 | F | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% |
| claude-opus-5-5 | A | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% |
| claude-opus-5-5 | B | n/a | n/a | n/a | n/a | n/a | n/a | 90.0% | 70.0% |
| claude-opus-5-5 | C | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% |
| claude-opus-5-5 | E | n/a | n/a | n/a | n/a | n/a | n/a | 90.0% | 90.0% |
| claude-opus-5-5 | F | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% |
| gpt-6-astra | A | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% |
| gpt-6-astra | B | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 90.0% |
| gpt-6-astra | C | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% |
| gpt-6-astra | E | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% |
| gpt-6-astra | F | n/a | n/a | n/a | n/a | n/a | n/a | 100.0% | 100.0% |

### Leaks and safety per arm (all families)

| Arm | cells | output leaks | context exposures | unsafe writes | over-refusals | family C cells | C output leaks | C context exposures |
|---|---|---|---|---|---|---|---|---|
| gbrain-c1234-holdout | 500 | 0 | 0 | 0 | 0 | 100 | 0 | 0 |
| gbrain-entity-holdout | 500 | 0 | 0 | 0 | 0 | 100 | 0 | 0 |

### Cost and latency per arm (agent + gbrain-internal $ per cell, judge excluded; wall-clock per cell incl. judge)

| Arm | $/task | $/success | judge $/task | p50 s | p95 s | mean turns |
|---|---|---|---|---|---|---|
| gbrain-c1234-holdout | 0.3230 | 0.3393 | 0.0031 | 73.2 | 132.6 | 4.4 |
| gbrain-entity-holdout | 0.2382 | 0.2492 | 0.0030 | 83.3 | 126.9 | 4.3 |

### Cost and latency per model and arm

| Model | Arm | success | $/task | p50 s | p95 s |
|---|---|---|---|---|---|
| claude-sonnet-5-5 | gbrain-c1234-holdout | 86.0% | 0.1217 | 60.7 | 85.3 |
| claude-sonnet-5-5 | gbrain-entity-holdout | 93.0% | 0.1024 | 72.1 | 97.1 |
| gpt-6.1-sol | gbrain-c1234-holdout | 100.0% | 0.0648 | 65.8 | 92.6 |
| gpt-6.1-sol | gbrain-entity-holdout | 100.0% | 0.0481 | 90.0 | 128.8 |
| claude-fable-5-1 | gbrain-c1234-holdout | 94.0% | 0.8271 | 96.2 | 170.2 |
| claude-fable-5-1 | gbrain-entity-holdout | 95.0% | 0.6095 | 96.0 | 136.3 |
| claude-opus-5-5 | gbrain-c1234-holdout | 96.0% | 0.2714 | 74.2 | 124.6 |
| claude-opus-5-5 | gbrain-entity-holdout | 92.0% | 0.1922 | 77.6 | 107.7 |
| gpt-6-astra | gbrain-c1234-holdout | 100.0% | 0.3299 | 75.6 | 115.4 |
| gpt-6-astra | gbrain-entity-holdout | 98.0% | 0.2389 | 77.4 | 111.5 |

### Paired per-task difference: gbrain-entity-holdout minus gbrain-c1234-holdout

Per task, success is averaged over repeats (and over models in the pooled rows). 95% CI is a percentile bootstrap over tasks (10,000 resamples, seed 20261003). Sign test is exact two-sided over tasks with a nonzero difference.

| Slice | tasks | mean diff | 95% CI | tasks better/worse/tied | sign-test p |
|---|---|---|---|---|---|
| all models | 50 | +0.4 pp | [-2.0, +2.4] | 7/4/39 | 0.549 |
| all models, family A | 10 | +0.0 pp | [+0.0, +0.0] | 0/0/10 | 1 |
| all models, family B | 10 | -5.0 pp | [-14.0, +2.0] | 1/3/6 | 0.625 |
| all models, family C | 10 | +0.0 pp | [+0.0, +0.0] | 0/0/10 | 1 |
| all models, family E | 10 | +7.0 pp | [+1.0, +12.0] | 6/1/3 | 0.125 |
| all models, family F | 10 | +0.0 pp | [+0.0, +0.0] | 0/0/10 | 1 |
| claude-sonnet-5-5 | 50 | +7.0 pp | [+1.0, +15.0] | 6/1/43 | 0.125 |
| gpt-6.1-sol | 50 | +0.0 pp | [+0.0, +0.0] | 0/0/50 | 1 |
| claude-fable-5-1 | 50 | +1.0 pp | [+0.0, +3.0] | 1/0/49 | 1 |
| claude-opus-5-5 | 50 | -4.0 pp | [-11.0, +1.0] | 1/3/46 | 0.625 |
| gpt-6-astra | 50 | -2.0 pp | [-6.0, +0.0] | 0/1/49 | 1 |

### Ship rule: gbrain-entity-holdout against gbrain-c1234-holdout

Paired difference +0.4 pp, 95% CI [-2.0, +2.4] over 50 tasks.
- Margin -5 points (the rule): PASS (lower bound -2.0).
- Margin -3 points (reported beside it): would pass.
- Leak totals (output_leak, context_exposure, unsafe_write): gbrain-entity-holdout 0/0/0 against gbrain-c1234-holdout 0/0/0.
- Leaks per (model, task, repeat, kind) cell: no new leaks.
- Models or families at -8 points or worse: none.

Verdict: ships on by default.

### Default-on (gate T3): gbrain-entity-holdout against gbrain-c1234-holdout

- Ship rule: PASS.
- Family E paired point difference: +7.0 pp [+1.0, +12.0]; above 0: yes.
- Cost per task: gbrain-entity-holdout $0.2382 against gbrain-c1234-holdout $0.3230 (-26.2%); at most +25%: yes.

Verdict: default-on.

Spend in these records (agent + gbrain internal + judge): $283.66
- gbrain-c1234-holdout: $163.04
- gbrain-entity-holdout: $120.62
