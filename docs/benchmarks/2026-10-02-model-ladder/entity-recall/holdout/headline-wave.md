Cells: 2300. Arms: oracle, fs, fs-acl, pg, memory, gbrain-entity-holdout. Models: claude-sonnet-5-5, gpt-6.1-sol, claude-fable-5-1, claude-opus-5-5, gpt-6-astra.

### Cell counts per arm

| Arm | cells | tasks | repeats |
|---|---|---|---|
| oracle | 500 | 50 | 2 |
| fs | 500 | 50 | 2 |
| fs-acl | 100 | 10 | 2 |
| pg | 500 | 50 | 2 |
| memory | 200 | 50 | 2 |
| gbrain-entity-holdout | 500 | 50 | 2 |

### Success by family (all models, both repeats)

| Family | fs | pg | memory | gbrain-base | gbrain-next-51a30c1 | gbrain-next | gbrain-entity-holdout | oracle |
|---|---|---|---|---|---|---|---|---|
| A | 99.0% | 98.0% | 100.0% | n/a | n/a | n/a | 100.0% | 100.0% |
| B | 95.0% | 74.0% | 75.0% | n/a | n/a | n/a | 85.0% | 100.0% |
| C | 100.0% | 96.0% | 100.0% | n/a | n/a | n/a | 100.0% | 100.0% |
| E | 89.0% | 91.0% | 30.0% | n/a | n/a | n/a | 93.0% | 88.0% |
| F | 95.0% | 91.0% | 100.0% | n/a | n/a | n/a | 100.0% | 100.0% |
| all | 95.6% | 90.0% | 81.0% | n/a | n/a | n/a | 95.6% | 97.6% |

### Success by model (all families, both repeats)

| Model | fs | pg | memory | gbrain-base | gbrain-next-51a30c1 | gbrain-next | gbrain-entity-holdout | oracle |
|---|---|---|---|---|---|---|---|---|
| claude-sonnet-5-5 | 91.0% | 77.0% | 76.0% | n/a | n/a | n/a | 93.0% | 96.0% |
| gpt-6.1-sol | 100.0% | 95.0% | 86.0% | n/a | n/a | n/a | 100.0% | 100.0% |
| claude-fable-5-1 | 94.0% | 91.0% | n/a | n/a | n/a | n/a | 95.0% | 96.0% |
| claude-opus-5-5 | 95.0% | 91.0% | n/a | n/a | n/a | n/a | 92.0% | 96.0% |
| gpt-6-astra | 98.0% | 96.0% | n/a | n/a | n/a | n/a | 98.0% | 100.0% |
| all | 95.6% | 90.0% | 81.0% | n/a | n/a | n/a | 95.6% | 97.6% |

### Success by model and family

| Model | Family | fs | pg | memory | gbrain-base | gbrain-next-51a30c1 | gbrain-next | gbrain-entity-holdout |
|---|---|---|---|---|---|---|---|---|
| claude-sonnet-5-5 | A | 100.0% | 90.0% | 100.0% | n/a | n/a | n/a | 100.0% |
| claude-sonnet-5-5 | B | 95.0% | 65.0% | 60.0% | n/a | n/a | n/a | 80.0% |
| claude-sonnet-5-5 | C | 100.0% | 80.0% | 100.0% | n/a | n/a | n/a | 100.0% |
| claude-sonnet-5-5 | E | 80.0% | 75.0% | 20.0% | n/a | n/a | n/a | 85.0% |
| claude-sonnet-5-5 | F | 80.0% | 75.0% | 100.0% | n/a | n/a | n/a | 100.0% |
| gpt-6.1-sol | A | 100.0% | 100.0% | 100.0% | n/a | n/a | n/a | 100.0% |
| gpt-6.1-sol | B | 100.0% | 85.0% | 90.0% | n/a | n/a | n/a | 100.0% |
| gpt-6.1-sol | C | 100.0% | 100.0% | 100.0% | n/a | n/a | n/a | 100.0% |
| gpt-6.1-sol | E | 100.0% | 100.0% | 40.0% | n/a | n/a | n/a | 100.0% |
| gpt-6.1-sol | F | 100.0% | 90.0% | 100.0% | n/a | n/a | n/a | 100.0% |
| claude-fable-5-1 | A | 100.0% | 100.0% | n/a | n/a | n/a | n/a | 100.0% |
| claude-fable-5-1 | B | 95.0% | 65.0% | n/a | n/a | n/a | n/a | 85.0% |
| claude-fable-5-1 | C | 100.0% | 100.0% | n/a | n/a | n/a | n/a | 100.0% |
| claude-fable-5-1 | E | 80.0% | 90.0% | n/a | n/a | n/a | n/a | 90.0% |
| claude-fable-5-1 | F | 95.0% | 100.0% | n/a | n/a | n/a | n/a | 100.0% |
| claude-opus-5-5 | A | 100.0% | 100.0% | n/a | n/a | n/a | n/a | 100.0% |
| claude-opus-5-5 | B | 90.0% | 65.0% | n/a | n/a | n/a | n/a | 70.0% |
| claude-opus-5-5 | C | 100.0% | 100.0% | n/a | n/a | n/a | n/a | 100.0% |
| claude-opus-5-5 | E | 85.0% | 90.0% | n/a | n/a | n/a | n/a | 90.0% |
| claude-opus-5-5 | F | 100.0% | 100.0% | n/a | n/a | n/a | n/a | 100.0% |
| gpt-6-astra | A | 95.0% | 100.0% | n/a | n/a | n/a | n/a | 100.0% |
| gpt-6-astra | B | 95.0% | 90.0% | n/a | n/a | n/a | n/a | 90.0% |
| gpt-6-astra | C | 100.0% | 100.0% | n/a | n/a | n/a | n/a | 100.0% |
| gpt-6-astra | E | 100.0% | 100.0% | n/a | n/a | n/a | n/a | 100.0% |
| gpt-6-astra | F | 100.0% | 90.0% | n/a | n/a | n/a | n/a | 100.0% |

### Leaks and safety per arm (all families)

| Arm | cells | output leaks | context exposures | unsafe writes | over-refusals | family C cells | C output leaks | C context exposures |
|---|---|---|---|---|---|---|---|---|
| oracle | 500 | 0 | 0 | 0 | 0 | 100 | 0 | 0 |
| fs | 500 | 0 | 100 | 0 | 0 | 100 | 0 | 100 |
| fs-acl | 100 | 1 | 50 | 0 | 0 | 100 | 1 | 50 |
| pg | 500 | 4 | 97 | 0 | 0 | 100 | 4 | 97 |
| memory | 200 | 0 | 24 | 0 | 0 | 40 | 0 | 24 |
| gbrain-entity-holdout | 500 | 0 | 0 | 0 | 0 | 100 | 0 | 0 |

### Cost and latency per arm (agent + gbrain-internal $ per cell, judge excluded; wall-clock per cell incl. judge)

| Arm | $/task | $/success | judge $/task | p50 s | p95 s | mean turns |
|---|---|---|---|---|---|---|
| oracle | 0.0217 | 0.0223 | 0.0028 | 5.9 | 13.0 | 1.0 |
| fs | 0.1116 | 0.1167 | 0.0029 | 20.5 | 57.6 | 5.2 |
| fs-acl | 0.0610 | 0.0616 | 0.0017 | 14.8 | 35.6 | 5.2 |
| pg | 0.0880 | 0.0978 | 0.0029 | 15.5 | 44.6 | 4.1 |
| memory | 0.2283 | 0.2819 | 0.0020 | 19.8 | 207.9 | 6.7 |
| gbrain-entity-holdout | 0.2382 | 0.2492 | 0.0030 | 83.3 | 126.9 | 4.3 |

### Cost and latency per model and arm

| Model | Arm | success | $/task | p50 s | p95 s |
|---|---|---|---|---|---|
| claude-sonnet-5-5 | fs | 91.0% | 0.0550 | 14.8 | 32.1 |
| claude-sonnet-5-5 | pg | 77.0% | 0.0351 | 9.7 | 28.2 |
| claude-sonnet-5-5 | memory | 76.0% | 0.2698 | 19.1 | 147.8 |
| claude-sonnet-5-5 | gbrain-entity-holdout | 93.0% | 0.1024 | 72.1 | 97.1 |
| gpt-6.1-sol | fs | 100.0% | 0.0223 | 19.4 | 43.0 |
| gpt-6.1-sol | pg | 95.0% | 0.0185 | 15.5 | 30.2 |
| gpt-6.1-sol | memory | 86.0% | 0.1869 | 20.8 | 250.4 |
| gpt-6.1-sol | gbrain-entity-holdout | 100.0% | 0.0481 | 90.0 | 128.8 |
| claude-fable-5-1 | fs | 94.0% | 0.2792 | 38.0 | 81.5 |
| claude-fable-5-1 | pg | 91.0% | 0.2330 | 27.3 | 74.1 |
| claude-fable-5-1 | gbrain-entity-holdout | 95.0% | 0.6095 | 96.0 | 136.3 |
| claude-opus-5-5 | fs | 95.0% | 0.0888 | 16.2 | 33.8 |
| claude-opus-5-5 | pg | 91.0% | 0.0647 | 12.7 | 27.6 |
| claude-opus-5-5 | gbrain-entity-holdout | 92.0% | 0.1922 | 77.6 | 107.7 |
| gpt-6-astra | fs | 98.0% | 0.1126 | 16.6 | 37.1 |
| gpt-6-astra | pg | 96.0% | 0.0889 | 12.6 | 23.8 |
| gpt-6-astra | gbrain-entity-holdout | 98.0% | 0.2389 | 77.4 | 111.5 |

### Headline: gbrain-entity-holdout against the comparator fs

Success: gbrain-entity-holdout 95.6%, fs 95.6%. Result: tie.

> On the held-out world, agents using gbrain with the entity-recall wave finish about as many tasks as agents using plain Markdown files with grep, the best simple setup: the difference is +0.0 points (95% CI -3.2 to +3.0).

Per task, success is averaged over repeats (and over models in the pooled rows). 95% CI is a percentile bootstrap over tasks (10,000 resamples, seed 20261003). Sign test is exact two-sided over tasks with a nonzero difference.

| Slice | gbrain-entity-holdout | fs | tasks | mean diff | 95% CI | tasks better/worse/tied | sign-test p |
|---|---|---|---|---|---|---|---|
| all models | 95.6% | 95.6% | 50 | +0.0 pp | [-3.2, +3.0] | 5/3/42 | 0.727 |
| claude-sonnet-5-5 | 93.0% | 91.0% | 50 | +2.0 pp | [-5.0, +9.0] | 4/2/44 | 0.688 |
| gpt-6.1-sol | 100.0% | 100.0% | 50 | +0.0 pp | [+0.0, +0.0] | 0/0/50 | 1 |
| claude-fable-5-1 | 95.0% | 94.0% | 50 | +1.0 pp | [-6.0, +7.0] | 3/2/45 | 1 |
| claude-opus-5-5 | 92.0% | 95.0% | 50 | -3.0 pp | [-10.0, +3.0] | 2/3/45 | 1 |
| gpt-6-astra | 98.0% | 98.0% | 50 | +0.0 pp | [-5.0, +4.0] | 2/1/47 | 1 |
| family A | 100.0% | 99.0% | 10 | +1.0 pp | [+0.0, +3.0] | 1/0/9 | 1 |
| family B | 85.0% | 95.0% | 10 | -10.0 pp | [-20.0, +0.0] | 0/3/7 | 0.25 |
| family C | 100.0% | 100.0% | 10 | +0.0 pp | [+0.0, +0.0] | 0/0/10 | 1 |
| family E | 93.0% | 89.0% | 10 | +4.0 pp | [+0.0, +12.0] | 1/0/9 | 1 |
| family F | 100.0% | 95.0% | 10 | +5.0 pp | [+0.0, +12.0] | 3/0/7 | 0.25 |

### gbrain-entity-holdout against the other simple arms (context, not comparators)

| Arm | slice | tasks | mean diff | 95% CI | tasks better/worse/tied | sign-test p |
|---|---|---|---|---|---|---|
| oracle | all models | 50 | -2.0 pp | [-5.8, +1.8] | 1/4/45 | 0.375 |
| oracle | claude-sonnet-5-5 | 50 | -3.0 pp | [-10.0, +2.0] | 1/2/47 | 1 |
| oracle | gpt-6.1-sol | 50 | +0.0 pp | [+0.0, +0.0] | 0/0/50 | 1 |
| oracle | claude-fable-5-1 | 50 | -1.0 pp | [-7.0, +5.0] | 1/2/47 | 1 |
| oracle | claude-opus-5-5 | 50 | -4.0 pp | [-12.0, +3.0] | 1/4/45 | 0.375 |
| oracle | gpt-6-astra | 50 | -2.0 pp | [-6.0, +0.0] | 0/1/49 | 1 |
| fs-acl | family C | 10 | +1.0 pp | [+0.0, +3.0] | 1/0/9 | 1 |
| fs-acl | claude-sonnet-5-5 (family C) | 10 | +5.0 pp | [+0.0, +15.0] | 1/0/9 | 1 |
| fs-acl | gpt-6.1-sol (family C) | 10 | +0.0 pp | [+0.0, +0.0] | 0/0/10 | 1 |
| fs-acl | claude-fable-5-1 (family C) | 10 | +0.0 pp | [+0.0, +0.0] | 0/0/10 | 1 |
| fs-acl | claude-opus-5-5 (family C) | 10 | +0.0 pp | [+0.0, +0.0] | 0/0/10 | 1 |
| fs-acl | gpt-6-astra (family C) | 10 | +0.0 pp | [+0.0, +0.0] | 0/0/10 | 1 |
| pg | all models | 50 | +5.6 pp | [+2.4, +9.2] | 13/1/36 | 0.00183 |
| pg | claude-sonnet-5-5 | 50 | +16.0 pp | [+7.0, +26.0] | 11/1/38 | 0.00635 |
| pg | gpt-6.1-sol | 50 | +5.0 pp | [+1.0, +11.0] | 4/0/46 | 0.125 |
| pg | claude-fable-5-1 | 50 | +4.0 pp | [-1.0, +11.0] | 3/1/46 | 0.625 |
| pg | claude-opus-5-5 | 50 | +1.0 pp | [+0.0, +3.0] | 1/0/49 | 1 |
| pg | gpt-6-astra | 50 | +2.0 pp | [-4.0, +8.0] | 2/1/47 | 1 |
| memory | refused: models differ (gbrain-entity-holdout: claude-fable-5-1, claude-opus-5-5, claude-sonnet-5-5, gpt-6-astra, gpt-6.1-sol; memory: claude-sonnet-5-5, gpt-6.1-sol) ||||||

### Cost per task and per successful task (agent plus gbrain-internal dollars, judge excluded)

| Model | gbrain-entity-holdout $/task | gbrain-entity-holdout $/success | fs $/task | fs $/success | oracle $/task | oracle $/success | pg $/task | pg $/success | memory $/task | memory $/success |
|---|---|---|---|---|---|---|---|---|---|---|
| claude-sonnet-5-5 | 0.1024 | 0.1101 | 0.0550 | 0.0604 | 0.0102 | 0.0106 | 0.0351 | 0.0455 | 0.2698 | 0.3550 |
| gpt-6.1-sol | 0.0481 | 0.0481 | 0.0223 | 0.0223 | 0.0046 | 0.0046 | 0.0185 | 0.0194 | 0.1869 | 0.2173 |
| claude-fable-5-1 | 0.6095 | 0.6415 | 0.2792 | 0.2970 | 0.0572 | 0.0596 | 0.2330 | 0.2560 | nan | nan |
| claude-opus-5-5 | 0.1922 | 0.2089 | 0.0888 | 0.0934 | 0.0204 | 0.0213 | 0.0647 | 0.0712 | nan | nan |
| gpt-6-astra | 0.2389 | 0.2438 | 0.1126 | 0.1149 | 0.0162 | 0.0162 | 0.0889 | 0.0926 | nan | nan |
| all | 0.2382 | 0.2492 | 0.1116 | 0.1167 | 0.0217 | 0.0223 | 0.0880 | 0.0978 | 0.2283 | 0.2819 |

Spend in these records (agent + gbrain internal + judge): $287.94
- oracle: $12.28
- fs: $57.24
- fs-acl: $6.27
- pg: $45.46
- memory: $46.07
- gbrain-entity-holdout: $120.62
