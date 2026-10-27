Cells: 600. Arms: fs, gbrain-hard. Models: claude-sonnet-5-5, claude-opus-5-5, gpt-6.1-sol.

### Cell counts per arm

| Arm | cells | tasks | repeats |
|---|---|---|---|
| fs | 300 | 100 | 1 |
| gbrain-hard | 300 | 100 | 1 |

### Success by family (all models, both repeats)

| Family | fs | gbrain-hard | oracle |
|---|---|---|---|
| H1 | 18.3% | 30.0% | n/a |
| H2 | 76.7% | 90.0% | n/a |
| H3 | 80.0% | 95.0% | n/a |
| H4 | 93.3% | 78.3% | n/a |
| H5 | 86.7% | 100.0% | n/a |
| all | 71.0% | 78.7% | n/a |

### Success by model (all families, both repeats)

| Model | fs | gbrain-hard | oracle |
|---|---|---|---|
| claude-sonnet-5-5 | 60.0% | 69.0% | n/a |
| claude-opus-5-5 | 73.0% | 79.0% | n/a |
| gpt-6.1-sol | 80.0% | 88.0% | n/a |
| all | 71.0% | 78.7% | n/a |

### Success by model and family

| Model | Family | fs | gbrain-hard |
|---|---|---|---|
| claude-sonnet-5-5 | H1 | 15.0% | 20.0% |
| claude-sonnet-5-5 | H2 | 55.0% | 75.0% |
| claude-sonnet-5-5 | H3 | 50.0% | 90.0% |
| claude-sonnet-5-5 | H4 | 80.0% | 60.0% |
| claude-sonnet-5-5 | H5 | 100.0% | 100.0% |
| claude-opus-5-5 | H1 | 10.0% | 30.0% |
| claude-opus-5-5 | H2 | 75.0% | 95.0% |
| claude-opus-5-5 | H3 | 90.0% | 95.0% |
| claude-opus-5-5 | H4 | 100.0% | 75.0% |
| claude-opus-5-5 | H5 | 90.0% | 100.0% |
| gpt-6.1-sol | H1 | 30.0% | 40.0% |
| gpt-6.1-sol | H2 | 100.0% | 100.0% |
| gpt-6.1-sol | H3 | 100.0% | 100.0% |
| gpt-6.1-sol | H4 | 100.0% | 100.0% |
| gpt-6.1-sol | H5 | 70.0% | 100.0% |

### Leaks and safety per arm (all families)

| Arm | cells | output leaks | context exposures | unsafe writes | over-refusals | family C cells | C output leaks | C context exposures |
|---|---|---|---|---|---|---|---|---|
| fs | 300 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| gbrain-hard | 300 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

### Cost and latency per arm (agent + gbrain-internal $ per cell, judge excluded; wall-clock per cell incl. judge)

| Arm | $/task | $/success | judge $/task | p50 s | p95 s | mean turns |
|---|---|---|---|---|---|---|
| fs | 0.9895 | 1.3937 | 0.0143 | 64.0 | 149.6 | 10.6 |
| gbrain-hard | 0.5793 | 0.7364 | 0.0176 | 76.6 | 165.2 | 8.3 |

### Cost and latency per model and arm

| Model | Arm | success | $/task | p50 s | p95 s |
|---|---|---|---|---|---|
| claude-sonnet-5-5 | fs | 60.0% | 1.0253 | 63.0 | 120.0 |
| claude-sonnet-5-5 | gbrain-hard | 69.0% | 0.5878 | 81.5 | 156.3 |
| claude-opus-5-5 | fs | 73.0% | 1.7535 | 80.3 | 169.9 |
| claude-opus-5-5 | gbrain-hard | 79.0% | 0.8689 | 87.6 | 174.7 |
| gpt-6.1-sol | fs | 80.0% | 0.1897 | 39.3 | 106.4 |
| gpt-6.1-sol | gbrain-hard | 88.0% | 0.2812 | 49.5 | 136.7 |

### Attempts (v2 records)

600 attempts; each cell is the last harness-clean attempt of its key, with cost summed over every attempt.
Harness-error retries per model and arm: none.

### Hard headline: gbrain-hard against the comparator fs

Primary endpoint: pooled paired difference gbrain-hard minus fs = +7.7 pp, 95% CI [+2.7, +12.7] over 100 tasks (gbrain-hard ahead).
Success: gbrain-hard 78.7%, fs 71.0%.

Per task, success is averaged over models and repeats, so a resampled task carries all its models and repeats. 95% CI is a percentile bootstrap over tasks (10,000 resamples, seed 20261003). Per-model and per-family rows are secondary.

| Slice | gbrain-hard | fs | tasks | mean diff | 95% CI | tasks better/worse/tied | sign-test p |
|---|---|---|---|---|---|---|---|
| all models (primary) | 78.7% | 71.0% | 100 | +7.7 pp | [+2.7, +12.7] | 34/16/50 | 0.0153 |
| claude-sonnet-5-5 | 69.0% | 60.0% | 100 | +9.0 pp | [-2.0, +20.0] | 21/12/67 | 0.163 |
| claude-opus-5-5 | 79.0% | 73.0% | 100 | +6.0 pp | [-2.0, +15.0] | 13/7/80 | 0.263 |
| gpt-6.1-sol | 88.0% | 80.0% | 100 | +8.0 pp | [+3.0, +14.0] | 8/0/92 | 0.00781 |
| family H1 | 30.0% | 18.3% | 20 | +11.7 pp | [+1.7, +23.3] | 6/1/13 | 0.125 |
| family H2 | 90.0% | 76.7% | 20 | +13.3 pp | [+1.7, +25.0] | 10/3/7 | 0.0923 |
| family H3 | 95.0% | 80.0% | 20 | +15.0 pp | [+3.3, +25.0] | 10/2/8 | 0.0386 |
| family H4 | 78.3% | 93.3% | 20 | -15.0 pp | [-23.3, -6.7] | 1/10/9 | 0.0117 |
| family H5 | 100.0% | 86.7% | 20 | +13.3 pp | [+5.0, +21.7] | 7/0/13 | 0.0156 |

### Simultaneous intervals: gbrain-hard against every simple arm run on every model

Max-T task-clustered bootstrap (10,000 resamples, seed 20261003, 100 tasks): the intervals hold together at 95%, critical value 1.93 bootstrap SEs.

| Arm | mean diff | SE | simultaneous 95% interval | excludes 0 |
|---|---|---|---|---|
| fs (comparator) | +7.7 pp | 2.6 | [+2.7, +12.7] | yes |

### Weakest-family rule

gbrain-hard trails fs most in family H4: -15.0 pp, 95% CI [-23.3, -6.7], which excludes 0. The family-level decision sentence may name family H4.

### Cost against fs (agent, embeddings and gbrain dollars over every attempt, judge excluded; reported, not gated)

| Model | gbrain-hard $/task | gbrain-hard $/success | fs $/task | fs $/success | $ per extra success |
|---|---|---|---|---|---|
| claude-sonnet-5-5 | 0.5878 | 0.8519 | 1.0253 | 1.7088 | -4.8608 |
| claude-opus-5-5 | 0.8689 | 1.0999 | 1.7535 | 2.4021 | -14.7432 |
| gpt-6.1-sol | 0.2812 | 0.3196 | 0.1897 | 0.2371 | 1.1439 |
| all | 0.5793 | 0.7364 | 0.9895 | 1.3937 | -5.3502 |

$ per extra success = (cost per task of A minus that of B) / (success of A minus that of B); n/a when A does not finish more tasks.

### Held-out bar per model

- claude-sonnet-5-5: oracle not run, so the oracle bar is unchecked
- claude-opus-5-5: oracle not run, so the oracle bar is unchecked
- gpt-6.1-sol: oracle not run, so the oracle bar is unchecked

### Missing comparisons

None: every simple arm ran on every model with full coverage.

Spend in these records (agent + gbrain internal + judge): $480.24
- fs: $301.15
- gbrain-hard: $179.09
