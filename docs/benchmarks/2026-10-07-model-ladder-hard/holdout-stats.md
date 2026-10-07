Cells: 900. Arms: fs, pg, gbrain-hard. Models: claude-sonnet-5-5, claude-opus-5-5, gpt-6.1-sol.

### Cell counts per arm

| Arm | cells | tasks | repeats |
|---|---|---|---|
| fs | 300 | 100 | 1 |
| pg | 300 | 100 | 1 |
| gbrain-hard | 300 | 100 | 1 |

### Success by family (all models, both repeats)

| Family | fs | pg | gbrain-hard | oracle |
|---|---|---|---|---|
| H1 | 26.7% | 21.7% | 8.3% | n/a |
| H2 | 88.3% | 80.0% | 73.3% | n/a |
| H3 | 66.7% | 68.3% | 65.0% | n/a |
| H4 | 93.3% | 83.3% | 78.3% | n/a |
| H5 | 91.7% | 88.3% | 85.0% | n/a |
| all | 73.3% | 68.3% | 62.0% | n/a |

### Success by model (all families, both repeats)

| Model | fs | pg | gbrain-hard | oracle |
|---|---|---|---|---|
| claude-sonnet-5-5 | 60.0% | 52.0% | 44.0% | n/a |
| claude-opus-5-5 | 79.0% | 69.0% | 62.0% | n/a |
| gpt-6.1-sol | 81.0% | 84.0% | 80.0% | n/a |
| all | 73.3% | 68.3% | 62.0% | n/a |

### Success by model and family

| Model | Family | fs | pg | gbrain-hard |
|---|---|---|---|---|
| claude-sonnet-5-5 | H1 | 15.0% | 10.0% | 0.0% |
| claude-sonnet-5-5 | H2 | 80.0% | 60.0% | 40.0% |
| claude-sonnet-5-5 | H3 | 20.0% | 40.0% | 40.0% |
| claude-sonnet-5-5 | H4 | 85.0% | 55.0% | 55.0% |
| claude-sonnet-5-5 | H5 | 100.0% | 95.0% | 85.0% |
| claude-opus-5-5 | H1 | 30.0% | 10.0% | 0.0% |
| claude-opus-5-5 | H2 | 85.0% | 80.0% | 90.0% |
| claude-opus-5-5 | H3 | 85.0% | 65.0% | 65.0% |
| claude-opus-5-5 | H4 | 95.0% | 95.0% | 85.0% |
| claude-opus-5-5 | H5 | 100.0% | 95.0% | 70.0% |
| gpt-6.1-sol | H1 | 35.0% | 45.0% | 25.0% |
| gpt-6.1-sol | H2 | 100.0% | 100.0% | 90.0% |
| gpt-6.1-sol | H3 | 95.0% | 100.0% | 90.0% |
| gpt-6.1-sol | H4 | 100.0% | 100.0% | 95.0% |
| gpt-6.1-sol | H5 | 75.0% | 75.0% | 100.0% |

### Leaks and safety per arm (all families)

| Arm | cells | output leaks | context exposures | unsafe writes | over-refusals | family C cells | C output leaks | C context exposures |
|---|---|---|---|---|---|---|---|---|
| fs | 300 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| pg | 300 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| gbrain-hard | 300 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

### Cost and latency per arm (agent + gbrain-internal $ per cell, judge excluded; wall-clock per cell incl. judge)

| Arm | $/task | $/success | judge $/task | p50 s | p95 s | mean turns |
|---|---|---|---|---|---|---|
| fs | 0.9770 | 1.3323 | 0.0146 | 68.5 | 141.9 | 10.9 |
| pg | 0.2905 | 0.4252 | 0.0144 | 133.4 | 243.9 | 9.5 |
| gbrain-hard | 0.6933 | 1.1183 | 0.0152 | 170.1 | 288.5 | 10.1 |

### Cost and latency per model and arm

| Model | Arm | success | $/task | p50 s | p95 s |
|---|---|---|---|---|---|
| claude-sonnet-5-5 | fs | 60.0% | 0.8610 | 65.7 | 121.2 |
| claude-sonnet-5-5 | pg | 52.0% | 0.2172 | 128.1 | 217.2 |
| claude-sonnet-5-5 | gbrain-hard | 44.0% | 0.6084 | 165.3 | 288.6 |
| claude-opus-5-5 | fs | 79.0% | 1.8893 | 88.6 | 158.0 |
| claude-opus-5-5 | pg | 69.0% | 0.4920 | 167.0 | 283.9 |
| claude-opus-5-5 | gbrain-hard | 62.0% | 1.1143 | 181.2 | 259.3 |
| gpt-6.1-sol | fs | 81.0% | 0.1808 | 49.2 | 111.7 |
| gpt-6.1-sol | pg | 84.0% | 0.1624 | 94.8 | 178.7 |
| gpt-6.1-sol | gbrain-hard | 80.0% | 0.3574 | 159.4 | 309.1 |

### Attempts (v2 records)

900 attempts; each cell is the last harness-clean attempt of its key, with cost summed over every attempt.
Harness-error retries per model and arm: none.

### Hard headline: gbrain-hard against the comparator fs

Primary endpoint: pooled paired difference gbrain-hard minus fs = -11.3 pp, 95% CI [-16.7, -6.0] over 100 tasks (gbrain-hard behind).
Success: gbrain-hard 62.0%, fs 73.3%.

Per task, success is averaged over models and repeats, so a resampled task carries all its models and repeats. 95% CI is a percentile bootstrap over tasks (10,000 resamples, seed 20261003). Per-model and per-family rows are secondary.

| Slice | gbrain-hard | fs | tasks | mean diff | 95% CI | tasks better/worse/tied | sign-test p |
|---|---|---|---|---|---|---|---|
| all models (primary) | 62.0% | 73.3% | 100 | -11.3 pp | [-16.7, -6.0] | 13/42/45 | 0.000114 |
| claude-sonnet-5-5 | 44.0% | 60.0% | 100 | -16.0 pp | [-27.0, -5.0] | 9/25/66 | 0.00904 |
| claude-opus-5-5 | 62.0% | 79.0% | 100 | -17.0 pp | [-26.0, -8.0] | 4/21/75 | 0.000911 |
| gpt-6.1-sol | 80.0% | 81.0% | 100 | -1.0 pp | [-9.0, +7.0] | 7/8/85 | 1 |
| family H1 | 8.3% | 26.7% | 20 | -18.3 pp | [-30.0, -8.3] | 0/8/12 | 0.00781 |
| family H2 | 73.3% | 88.3% | 20 | -15.0 pp | [-26.7, -3.3] | 3/11/6 | 0.0574 |
| family H3 | 65.0% | 66.7% | 20 | -1.7 pp | [-13.3, +11.7] | 5/7/8 | 0.774 |
| family H4 | 78.3% | 93.3% | 20 | -15.0 pp | [-25.0, -3.3] | 2/10/8 | 0.0386 |
| family H5 | 85.0% | 91.7% | 20 | -6.7 pp | [-18.3, +3.3] | 3/6/11 | 0.508 |

### Simultaneous intervals: gbrain-hard against every simple arm run on every model

Max-T task-clustered bootstrap (10,000 resamples, seed 20261003, 100 tasks): the intervals hold together at 95%, critical value 2.22 bootstrap SEs.

| Arm | mean diff | SE | simultaneous 95% interval | excludes 0 |
|---|---|---|---|---|
| fs (comparator) | -11.3 pp | 2.7 | [-17.3, -5.3] | yes |
| pg | -6.3 pp | 2.8 | [-12.5, -0.2] | yes |

### Weakest-family rule

gbrain-hard trails fs most in family H1: -18.3 pp, 95% CI [-30.0, -8.3], which excludes 0. The family-level decision sentence may name family H1.

### Cost against fs (agent, embeddings and gbrain dollars over every attempt, judge excluded; reported, not gated)

| Model | gbrain-hard $/task | gbrain-hard $/success | fs $/task | fs $/success | $ per extra success |
|---|---|---|---|---|---|
| claude-sonnet-5-5 | 0.6084 | 1.3827 | 0.8610 | 1.4351 | n/a |
| claude-opus-5-5 | 1.1143 | 1.7972 | 1.8893 | 2.3915 | n/a |
| gpt-6.1-sol | 0.3574 | 0.4467 | 0.1808 | 0.2232 | n/a |
| all | 0.6933 | 1.1183 | 0.9770 | 1.3323 | n/a |

$ per extra success = (cost per task of A minus that of B) / (success of A minus that of B); n/a when A does not finish more tasks.

### Held-out bar per model

- claude-sonnet-5-5: oracle not run, so the oracle bar is unchecked
- claude-opus-5-5: oracle not run, so the oracle bar is unchecked
- gpt-6.1-sol: comparator 81.0% is above 80%; oracle not run, so the oracle bar is unchecked

### Missing comparisons

None: every simple arm ran on every model with full coverage.

Spend in these records (agent + gbrain internal + judge): $601.54
- fs: $297.50
- pg: $91.49
- gbrain-hard: $212.55
