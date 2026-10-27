Cells: 762. Arms: fs, gbrain-hard. Models: claude-sonnet-5-5, claude-opus-5-5, gpt-6.1-sol, claude-fable-5-1.

### Cell counts per arm

| Arm | cells | tasks | repeats |
|---|---|---|---|
| fs | 382 | 100 | 1 |
| gbrain-hard | 380 | 100 | 1 |

### Success by family (all models, both repeats)

| Family | fs | gbrain-hard | oracle |
|---|---|---|---|
| H1 | 20.8% | 6.5% | n/a |
| H2 | 71.4% | 77.6% | n/a |
| H3 | 53.9% | 64.5% | n/a |
| H4 | 77.6% | 78.9% | n/a |
| H5 | 85.5% | 86.7% | n/a |
| all | 61.8% | 62.6% | n/a |

### Success by model (all families, both repeats)

| Model | fs | gbrain-hard | oracle |
|---|---|---|---|
| claude-sonnet-5-5 | 60.0% | 44.0% | n/a |
| claude-opus-5-5 | 79.0% | 62.0% | n/a |
| gpt-6.1-sol | 81.0% | 80.0% | n/a |
| claude-fable-5-1 | 19.5% | 65.0% | n/a |
| all | 61.8% | 62.6% | n/a |

### Success by model and family

| Model | Family | fs | gbrain-hard |
|---|---|---|---|
| claude-sonnet-5-5 | H1 | 15.0% | 0.0% |
| claude-sonnet-5-5 | H2 | 80.0% | 40.0% |
| claude-sonnet-5-5 | H3 | 20.0% | 40.0% |
| claude-sonnet-5-5 | H4 | 85.0% | 55.0% |
| claude-sonnet-5-5 | H5 | 100.0% | 85.0% |
| claude-opus-5-5 | H1 | 30.0% | 0.0% |
| claude-opus-5-5 | H2 | 85.0% | 90.0% |
| claude-opus-5-5 | H3 | 85.0% | 65.0% |
| claude-opus-5-5 | H4 | 95.0% | 85.0% |
| claude-opus-5-5 | H5 | 100.0% | 70.0% |
| gpt-6.1-sol | H1 | 35.0% | 25.0% |
| gpt-6.1-sol | H2 | 100.0% | 90.0% |
| gpt-6.1-sol | H3 | 95.0% | 90.0% |
| gpt-6.1-sol | H4 | 100.0% | 95.0% |
| gpt-6.1-sol | H5 | 75.0% | 100.0% |
| claude-fable-5-1 | H1 | 0.0% | 0.0% |
| claude-fable-5-1 | H2 | 11.8% | 93.8% |
| claude-fable-5-1 | H3 | 6.2% | 62.5% |
| claude-fable-5-1 | H4 | 18.8% | 81.2% |
| claude-fable-5-1 | H5 | 62.5% | 93.3% |

### Leaks and safety per arm (all families)

| Arm | cells | output leaks | context exposures | unsafe writes | over-refusals | family C cells | C output leaks | C context exposures |
|---|---|---|---|---|---|---|---|---|
| fs | 382 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| gbrain-hard | 380 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

### Cost and latency per arm (agent + gbrain-internal $ per cell, judge excluded; wall-clock per cell incl. judge)

| Arm | $/task | $/success | judge $/task | p50 s | p95 s | mean turns |
|---|---|---|---|---|---|---|
| fs | 1.4173 | 2.2942 | 0.0123 | 70.5 | 190.5 | 11.8 |
| gbrain-hard | 1.4017 | 2.2380 | 0.0153 | 186.3 | 367.7 | 10.4 |

### Cost and latency per model and arm

| Model | Arm | success | $/task | p50 s | p95 s |
|---|---|---|---|---|---|
| claude-sonnet-5-5 | fs | 60.0% | 0.8610 | 65.7 | 121.2 |
| claude-sonnet-5-5 | gbrain-hard | 44.0% | 0.6084 | 165.3 | 288.6 |
| claude-opus-5-5 | fs | 79.0% | 1.8893 | 88.6 | 158.0 |
| claude-opus-5-5 | gbrain-hard | 62.0% | 1.1143 | 181.2 | 259.3 |
| gpt-6.1-sol | fs | 81.0% | 0.1808 | 49.2 | 111.7 |
| gpt-6.1-sol | gbrain-hard | 80.0% | 0.3574 | 159.4 | 309.1 |
| claude-fable-5-1 | fs | 19.5% | 3.0282 | 95.9 | 358.3 |
| claude-fable-5-1 | gbrain-hard | 65.0% | 4.0579 | 293.4 | 418.2 |

### Attempts (v2 records)

762 attempts; each cell is the last harness-clean attempt of its key, with cost summed over every attempt.
Harness-error retries per model and arm: none.

### Hard headline: gbrain-hard against the comparator fs

Refused: incomplete coverage (gbrain-hard is missing 20 of 400 cells (first: claude-fable-5-1/H1-18/0, claude-fable-5-1/H1-19/0, claude-fable-5-1/H1-20/0); fs is missing 18 of 400 cells (first: claude-fable-5-1/H1-18/0, claude-fable-5-1/H1-19/0, claude-fable-5-1/H1-20/0)). Rerun the missing cells through the runner's resume (same command and --out) before comparing.

Spend in these records (agent + gbrain internal + judge): $1084.56
- fs: $546.13
- gbrain-hard: $538.43
