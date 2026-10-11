# Corrected Cat 40 headline: gbrain `a714410a5` against the preregistered comparator

<a id="correction-2026-10-09"></a>

> **Correction, 2026-10-09: the gbrain cells searched without their reranker.** Each restored slot brain kept the slot build's metering-proxy port in its Voyage URL, and that port was closed when the cells ran, so every rerank request failed and gbrain quietly returned unreranked results (fixed in gbrain-evals #76, commit `7709a70`, and #109). None of the 600 gbrain cells in `followups/holdout/results.jsonl` include a rerank request in their metered calls ([audit](../../2026-10-08-program-primary-hard/root-cause/restore-audit.json)), so this headline compares gbrain without its reranker with the file, memory-tool and Postgres arms, which have none to lose. See the [Cat 40 report correction](../../2026-10-02-model-ladder.md#correction-2026-10-09). The output below is unchanged.

Output of the command below, unedited. The comparator rule and sentences are in [PREREGISTRATION.md](PREREGISTRATION.md); the simple-arm cells are audited in [simple-arms-rescored/](simple-arms-rescored/README.md).

```
python3 docs/benchmarks/2026-10-02-model-ladder/holdout/holdout_stats.py docs/benchmarks/2026-10-02-model-ladder/entity-recall/simple-arms-rescored/results.jsonl docs/benchmarks/2026-10-02-model-ladder/followups/holdout/results.jsonl --choose-comparator fs,memory,pg --headline gbrain-c1234-holdout,fs
```

Cells: 3120. Arms: oracle, fs, fs-acl, pg, memory, gbrain-c1234-holdout. Models: claude-haiku-4-5, claude-sonnet-4-6, claude-sonnet-5-5, gpt-5.4-mini, gpt-5.4, gpt-6.1-sol.

### Cell counts per arm

| Arm | cells | tasks | repeats |
|---|---|---|---|
| oracle | 600 | 50 | 2 |
| fs | 600 | 50 | 2 |
| fs-acl | 120 | 10 | 2 |
| pg | 600 | 50 | 2 |
| memory | 600 | 50 | 2 |
| gbrain-c1234-holdout | 600 | 50 | 2 |

### Success by family (all models, both repeats)

| Family | fs | pg | memory | gbrain-base | gbrain-next-51a30c1 | gbrain-next | gbrain-c1234-holdout | oracle |
|---|---|---|---|---|---|---|---|---|
| A | 85.0% | 77.5% | 83.3% | n/a | n/a | n/a | 91.7% | 100.0% |
| B | 73.3% | 63.3% | 51.7% | n/a | n/a | n/a | 78.3% | 98.3% |
| C | 91.7% | 90.0% | 92.5% | n/a | n/a | n/a | 97.5% | 100.0% |
| E | 40.8% | 33.3% | 10.0% | n/a | n/a | n/a | 31.7% | 93.3% |
| F | 73.3% | 65.8% | 79.2% | n/a | n/a | n/a | 79.2% | 98.3% |
| all | 72.8% | 66.0% | 63.3% | n/a | n/a | n/a | 75.7% | 98.0% |

### Success by model (all families, both repeats)

| Model | fs | pg | memory | gbrain-base | gbrain-next-51a30c1 | gbrain-next | gbrain-c1234-holdout | oracle |
|---|---|---|---|---|---|---|---|---|
| claude-haiku-4-5 | 55.0% | 58.0% | 52.0% | n/a | n/a | n/a | 71.0% | 100.0% |
| claude-sonnet-4-6 | 62.0% | 60.0% | 62.0% | n/a | n/a | n/a | 79.0% | 97.0% |
| claude-sonnet-5-5 | 91.0% | 77.0% | 76.0% | n/a | n/a | n/a | 86.0% | 96.0% |
| gpt-5.4-mini | 62.0% | 52.0% | 54.0% | n/a | n/a | n/a | 47.0% | 95.0% |
| gpt-5.4 | 67.0% | 54.0% | 50.0% | n/a | n/a | n/a | 71.0% | 100.0% |
| gpt-6.1-sol | 100.0% | 95.0% | 86.0% | n/a | n/a | n/a | 100.0% | 100.0% |
| all | 72.8% | 66.0% | 63.3% | n/a | n/a | n/a | 75.7% | 98.0% |

### Success by model and family

| Model | Family | fs | pg | memory | gbrain-base | gbrain-next-51a30c1 | gbrain-next | gbrain-c1234-holdout |
|---|---|---|---|---|---|---|---|---|
| claude-haiku-4-5 | A | 75.0% | 70.0% | 60.0% | n/a | n/a | n/a | 100.0% |
| claude-haiku-4-5 | B | 80.0% | 60.0% | 40.0% | n/a | n/a | n/a | 80.0% |
| claude-haiku-4-5 | C | 90.0% | 100.0% | 90.0% | n/a | n/a | n/a | 85.0% |
| claude-haiku-4-5 | E | 5.0% | 0.0% | 0.0% | n/a | n/a | n/a | 5.0% |
| claude-haiku-4-5 | F | 25.0% | 60.0% | 70.0% | n/a | n/a | n/a | 85.0% |
| claude-sonnet-4-6 | A | 70.0% | 70.0% | 100.0% | n/a | n/a | n/a | 100.0% |
| claude-sonnet-4-6 | B | 80.0% | 60.0% | 40.0% | n/a | n/a | n/a | 80.0% |
| claude-sonnet-4-6 | C | 85.0% | 95.0% | 100.0% | n/a | n/a | n/a | 100.0% |
| claude-sonnet-4-6 | E | 20.0% | 10.0% | 0.0% | n/a | n/a | n/a | 20.0% |
| claude-sonnet-4-6 | F | 55.0% | 65.0% | 70.0% | n/a | n/a | n/a | 95.0% |
| claude-sonnet-5-5 | A | 100.0% | 90.0% | 100.0% | n/a | n/a | n/a | 100.0% |
| claude-sonnet-5-5 | B | 95.0% | 65.0% | 60.0% | n/a | n/a | n/a | 80.0% |
| claude-sonnet-5-5 | C | 100.0% | 80.0% | 100.0% | n/a | n/a | n/a | 100.0% |
| claude-sonnet-5-5 | E | 80.0% | 75.0% | 20.0% | n/a | n/a | n/a | 50.0% |
| claude-sonnet-5-5 | F | 80.0% | 75.0% | 100.0% | n/a | n/a | n/a | 100.0% |
| gpt-5.4-mini | A | 85.0% | 65.0% | 75.0% | n/a | n/a | n/a | 50.0% |
| gpt-5.4-mini | B | 40.0% | 50.0% | 40.0% | n/a | n/a | n/a | 50.0% |
| gpt-5.4-mini | C | 95.0% | 95.0% | 90.0% | n/a | n/a | n/a | 100.0% |
| gpt-5.4-mini | E | 5.0% | 0.0% | 0.0% | n/a | n/a | n/a | 0.0% |
| gpt-5.4-mini | F | 85.0% | 50.0% | 65.0% | n/a | n/a | n/a | 35.0% |
| gpt-5.4 | A | 80.0% | 70.0% | 65.0% | n/a | n/a | n/a | 100.0% |
| gpt-5.4 | B | 45.0% | 60.0% | 40.0% | n/a | n/a | n/a | 80.0% |
| gpt-5.4 | C | 80.0% | 70.0% | 75.0% | n/a | n/a | n/a | 100.0% |
| gpt-5.4 | E | 35.0% | 15.0% | 0.0% | n/a | n/a | n/a | 15.0% |
| gpt-5.4 | F | 95.0% | 55.0% | 70.0% | n/a | n/a | n/a | 60.0% |
| gpt-6.1-sol | A | 100.0% | 100.0% | 100.0% | n/a | n/a | n/a | 100.0% |
| gpt-6.1-sol | B | 100.0% | 85.0% | 90.0% | n/a | n/a | n/a | 100.0% |
| gpt-6.1-sol | C | 100.0% | 100.0% | 100.0% | n/a | n/a | n/a | 100.0% |
| gpt-6.1-sol | E | 100.0% | 100.0% | 40.0% | n/a | n/a | n/a | 100.0% |
| gpt-6.1-sol | F | 100.0% | 90.0% | 100.0% | n/a | n/a | n/a | 100.0% |

### Leaks and safety per arm (all families)

| Arm | cells | output leaks | context exposures | unsafe writes | over-refusals | family C cells | C output leaks | C context exposures |
|---|---|---|---|---|---|---|---|---|
| oracle | 600 | 0 | 0 | 0 | 1 | 120 | 0 | 0 |
| fs | 600 | 9 | 115 | 0 | 1 | 120 | 9 | 115 |
| fs-acl | 120 | 17 | 57 | 0 | 0 | 120 | 17 | 57 |
| pg | 600 | 12 | 106 | 0 | 0 | 120 | 12 | 106 |
| memory | 600 | 9 | 64 | 0 | 19 | 120 | 9 | 64 |
| gbrain-c1234-holdout | 600 | 0 | 0 | 0 | 1 | 120 | 0 | 0 |

### Cost and latency per arm (agent + gbrain-internal $ per cell, judge excluded; wall-clock per cell incl. judge)

| Arm | $/task | $/success | judge $/task | p50 s | p95 s | mean turns |
|---|---|---|---|---|---|---|
| oracle | 0.0070 | 0.0072 | 0.0027 | 5.1 | 10.4 | 1.0 |
| fs | 0.0323 | 0.0444 | 0.0027 | 12.2 | 38.5 | 4.7 |
| fs-acl | 0.0186 | 0.0225 | 0.0012 | 8.3 | 20.9 | 4.7 |
| pg | 0.0212 | 0.0321 | 0.0027 | 10.1 | 29.3 | 3.7 |
| memory | 0.1380 | 0.2179 | 0.0021 | 14.3 | 112.3 | 6.2 |
| gbrain-c1234-holdout | 0.0800 | 0.1057 | 0.0029 | 63.5 | 98.3 | 4.0 |

### Cost and latency per model and arm

| Model | Arm | success | $/task | p50 s | p95 s |
|---|---|---|---|---|---|
| claude-haiku-4-5 | fs | 55.0% | 0.0237 | 9.6 | 29.4 |
| claude-haiku-4-5 | pg | 58.0% | 0.0148 | 7.9 | 29.3 |
| claude-haiku-4-5 | memory | 52.0% | 0.0695 | 15.5 | 37.6 |
| claude-haiku-4-5 | gbrain-c1234-holdout | 71.0% | 0.0579 | 64.3 | 95.0 |
| claude-sonnet-4-6 | fs | 62.0% | 0.0511 | 13.6 | 58.9 |
| claude-sonnet-4-6 | pg | 60.0% | 0.0341 | 12.1 | 36.7 |
| claude-sonnet-4-6 | memory | 62.0% | 0.1803 | 16.1 | 91.2 |
| claude-sonnet-4-6 | gbrain-c1234-holdout | 79.0% | 0.1438 | 67.1 | 145.8 |
| claude-sonnet-5-5 | fs | 91.0% | 0.0550 | 14.8 | 32.1 |
| claude-sonnet-5-5 | pg | 77.0% | 0.0351 | 9.7 | 28.2 |
| claude-sonnet-5-5 | memory | 76.0% | 0.2698 | 19.1 | 147.8 |
| claude-sonnet-5-5 | gbrain-c1234-holdout | 86.0% | 0.1217 | 60.7 | 85.3 |
| gpt-5.4-mini | fs | 62.0% | 0.0079 | 9.1 | 16.9 |
| gpt-5.4-mini | pg | 52.0% | 0.0043 | 7.8 | 17.7 |
| gpt-5.4-mini | memory | 54.0% | 0.0300 | 8.3 | 23.8 |
| gpt-5.4-mini | gbrain-c1234-holdout | 47.0% | 0.0166 | 62.9 | 81.4 |
| gpt-5.4 | fs | 67.0% | 0.0341 | 10.1 | 21.6 |
| gpt-5.4 | pg | 54.0% | 0.0205 | 10.1 | 18.5 |
| gpt-5.4 | memory | 50.0% | 0.0917 | 9.0 | 22.7 |
| gpt-5.4 | gbrain-c1234-holdout | 71.0% | 0.0752 | 63.1 | 82.7 |
| gpt-6.1-sol | fs | 100.0% | 0.0223 | 19.4 | 43.0 |
| gpt-6.1-sol | pg | 95.0% | 0.0185 | 15.5 | 30.2 |
| gpt-6.1-sol | memory | 86.0% | 0.1869 | 20.8 | 250.4 |
| gpt-6.1-sol | gbrain-c1234-holdout | 100.0% | 0.0648 | 65.8 | 92.6 |

### Paired per-task difference: gbrain-c1234-holdout minus fs

Per task, success is averaged over repeats (and over models in the pooled rows). 95% CI is a percentile bootstrap over tasks (10,000 resamples, seed 20261003). Sign test is exact two-sided over tasks with a nonzero difference.

| Slice | tasks | mean diff | 95% CI | tasks better/worse/tied | sign-test p |
|---|---|---|---|---|---|
| all models | 50 | +2.8 pp | [-2.3, +8.2] | 18/18/14 | 1 |
| all models, family A | 10 | +6.7 pp | [-5.0, +20.8] | 3/3/4 | 1 |
| all models, family B | 10 | +5.0 pp | [-2.5, +13.3] | 4/3/3 | 1 |
| all models, family C | 10 | +5.8 pp | [+0.0, +13.3] | 4/1/5 | 0.375 |
| all models, family E | 10 | -9.2 pp | [-20.8, +0.8] | 2/6/2 | 0.289 |
| all models, family F | 10 | +5.8 pp | [-9.2, +21.7] | 5/5/0 | 1 |
| claude-haiku-4-5 | 50 | +16.0 pp | [+5.0, +28.0] | 12/4/34 | 0.0768 |
| claude-sonnet-4-6 | 50 | +17.0 pp | [+6.0, +28.0] | 15/4/31 | 0.0192 |
| claude-sonnet-5-5 | 50 | -5.0 pp | [-15.0, +4.0] | 4/7/39 | 0.549 |
| gpt-5.4-mini | 50 | -15.0 pp | [-25.0, -5.0] | 4/15/31 | 0.0192 |
| gpt-5.4 | 50 | +4.0 pp | [-10.0, +18.0] | 10/9/31 | 1 |
| gpt-6.1-sol | 50 | +0.0 pp | [+0.0, +0.0] | 0/0/50 | 1 |

### Comparator choice among fs, memory, pg

| Arm | cells | pooled success | $/task |
|---|---|---|---|
| fs | 600 | 72.8% | 0.0323 |
| memory | 600 | 63.3% | 0.1380 |
| pg | 600 | 66.0% | 0.0212 |

Comparator: fs (best pooled success; ties broken by lower cost per task).

### Headline: gbrain-c1234-holdout against the comparator fs

Success: gbrain-c1234-holdout 75.7%, fs 72.8%. Result: tie.

> On the held-out world, agents using gbrain `a714410a5` (v0.60.44.0) finish about as many tasks as agents using plain Markdown files with grep, the best simple setup: the difference is +2.8 points (95% CI -2.3 to +8.2).

Per task, success is averaged over repeats (and over models in the pooled rows). 95% CI is a percentile bootstrap over tasks (10,000 resamples, seed 20261003). Sign test is exact two-sided over tasks with a nonzero difference.

| Slice | gbrain-c1234-holdout | fs | tasks | mean diff | 95% CI | tasks better/worse/tied | sign-test p |
|---|---|---|---|---|---|---|---|
| all models | 75.7% | 72.8% | 50 | +2.8 pp | [-2.3, +8.2] | 18/18/14 | 1 |
| claude-haiku-4-5 | 71.0% | 55.0% | 50 | +16.0 pp | [+5.0, +28.0] | 12/4/34 | 0.0768 |
| claude-sonnet-4-6 | 79.0% | 62.0% | 50 | +17.0 pp | [+6.0, +28.0] | 15/4/31 | 0.0192 |
| claude-sonnet-5-5 | 86.0% | 91.0% | 50 | -5.0 pp | [-15.0, +4.0] | 4/7/39 | 0.549 |
| gpt-5.4-mini | 47.0% | 62.0% | 50 | -15.0 pp | [-25.0, -5.0] | 4/15/31 | 0.0192 |
| gpt-5.4 | 71.0% | 67.0% | 50 | +4.0 pp | [-10.0, +18.0] | 10/9/31 | 1 |
| gpt-6.1-sol | 100.0% | 100.0% | 50 | +0.0 pp | [+0.0, +0.0] | 0/0/50 | 1 |
| family A | 91.7% | 85.0% | 10 | +6.7 pp | [-5.0, +20.8] | 3/3/4 | 1 |
| family B | 78.3% | 73.3% | 10 | +5.0 pp | [-2.5, +13.3] | 4/3/3 | 1 |
| family C | 97.5% | 91.7% | 10 | +5.8 pp | [+0.0, +13.3] | 4/1/5 | 0.375 |
| family E | 31.7% | 40.8% | 10 | -9.2 pp | [-20.8, +0.8] | 2/6/2 | 0.289 |
| family F | 79.2% | 73.3% | 10 | +5.8 pp | [-9.2, +21.7] | 5/5/0 | 1 |

### gbrain-c1234-holdout against the other simple arms (context, not comparators)

| Arm | slice | tasks | mean diff | 95% CI | tasks better/worse/tied | sign-test p |
|---|---|---|---|---|---|---|
| oracle | all models | 50 | -22.3 pp | [-29.8, -15.3] | 0/34/16 | 1.16e-10 |
| oracle | claude-haiku-4-5 | 50 | -29.0 pp | [-41.0, -18.0] | 0/18/32 | 7.63e-06 |
| oracle | claude-sonnet-4-6 | 50 | -18.0 pp | [-29.0, -8.0] | 1/11/38 | 0.00635 |
| oracle | claude-sonnet-5-5 | 50 | -10.0 pp | [-19.0, -2.0] | 1/7/42 | 0.0703 |
| oracle | gpt-5.4-mini | 50 | -48.0 pp | [-60.0, -35.0] | 1/30/19 | 2.98e-08 |
| oracle | gpt-5.4 | 50 | -29.0 pp | [-41.0, -18.0] | 0/18/32 | 7.63e-06 |
| oracle | gpt-6.1-sol | 50 | +0.0 pp | [+0.0, +0.0] | 0/0/50 | 1 |
| fs-acl | family C | 10 | +15.0 pp | [+3.3, +28.3] | 5/1/4 | 0.219 |
| fs-acl | claude-haiku-4-5 (family C) | 10 | +35.0 pp | [+5.0, +65.0] | 5/1/4 | 0.219 |
| fs-acl | claude-sonnet-4-6 (family C) | 10 | +30.0 pp | [+0.0, +60.0] | 3/0/7 | 0.25 |
| fs-acl | claude-sonnet-5-5 (family C) | 10 | +5.0 pp | [+0.0, +15.0] | 1/0/9 | 1 |
| fs-acl | gpt-5.4-mini (family C) | 10 | +10.0 pp | [+0.0, +25.0] | 2/0/8 | 0.5 |
| fs-acl | gpt-5.4 (family C) | 10 | +10.0 pp | [+0.0, +25.0] | 2/0/8 | 0.5 |
| fs-acl | gpt-6.1-sol (family C) | 10 | +0.0 pp | [+0.0, +0.0] | 0/0/10 | 1 |
| pg | all models | 50 | +9.7 pp | [+3.2, +16.8] | 17/18/15 | 1 |
| pg | claude-haiku-4-5 | 50 | +13.0 pp | [+2.0, +24.0] | 10/4/36 | 0.18 |
| pg | claude-sonnet-4-6 | 50 | +19.0 pp | [+9.0, +30.0] | 12/1/37 | 0.00342 |
| pg | claude-sonnet-5-5 | 50 | +9.0 pp | [-3.0, +21.0] | 10/5/35 | 0.302 |
| pg | gpt-5.4-mini | 50 | -5.0 pp | [-13.0, +3.0] | 5/9/36 | 0.424 |
| pg | gpt-5.4 | 50 | +17.0 pp | [+5.0, +29.0] | 12/4/34 | 0.0768 |
| pg | gpt-6.1-sol | 50 | +5.0 pp | [+1.0, +11.0] | 4/0/46 | 0.125 |
| memory | all models | 50 | +12.3 pp | [+6.8, +18.3] | 23/10/17 | 0.0351 |
| memory | claude-haiku-4-5 | 50 | +19.0 pp | [+8.0, +30.0] | 15/3/32 | 0.00754 |
| memory | claude-sonnet-4-6 | 50 | +17.0 pp | [+8.0, +27.0] | 11/0/39 | 0.000977 |
| memory | claude-sonnet-5-5 | 50 | +10.0 pp | [+2.0, +20.0] | 7/2/41 | 0.18 |
| memory | gpt-5.4-mini | 50 | -7.0 pp | [-17.0, +3.0] | 5/12/33 | 0.143 |
| memory | gpt-5.4 | 50 | +21.0 pp | [+8.0, +34.0] | 16/4/30 | 0.0118 |
| memory | gpt-6.1-sol | 50 | +14.0 pp | [+6.0, +24.0] | 8/0/42 | 0.00781 |

### Cost per task and per successful task (agent plus gbrain-internal dollars, judge excluded)

| Model | gbrain-c1234-holdout $/task | gbrain-c1234-holdout $/success | fs $/task | fs $/success | oracle $/task | oracle $/success | pg $/task | pg $/success | memory $/task | memory $/success |
|---|---|---|---|---|---|---|---|---|---|---|
| claude-haiku-4-5 | 0.0579 | 0.0816 | 0.0237 | 0.0431 | 0.0047 | 0.0047 | 0.0148 | 0.0255 | 0.0695 | 0.1336 |
| claude-sonnet-4-6 | 0.1438 | 0.1820 | 0.0511 | 0.0824 | 0.0154 | 0.0158 | 0.0341 | 0.0568 | 0.1803 | 0.2909 |
| claude-sonnet-5-5 | 0.1217 | 0.1415 | 0.0550 | 0.0604 | 0.0102 | 0.0106 | 0.0351 | 0.0455 | 0.2698 | 0.3550 |
| gpt-5.4-mini | 0.0166 | 0.0352 | 0.0079 | 0.0127 | 0.0019 | 0.0020 | 0.0043 | 0.0082 | 0.0300 | 0.0555 |
| gpt-5.4 | 0.0752 | 0.1059 | 0.0341 | 0.0508 | 0.0055 | 0.0055 | 0.0205 | 0.0380 | 0.0917 | 0.1834 |
| gpt-6.1-sol | 0.0648 | 0.0648 | 0.0223 | 0.0223 | 0.0046 | 0.0046 | 0.0185 | 0.0194 | 0.1869 | 0.2173 |
| all | 0.0800 | 0.1057 | 0.0323 | 0.0444 | 0.0070 | 0.0072 | 0.0212 | 0.0321 | 0.1380 | 0.2179 |

Spend in these records (agent + gbrain internal + judge): $177.41
- oracle: $5.85
- fs: $21.01
- fs-acl: $2.38
- pg: $14.37
- memory: $84.06
- gbrain-c1234-holdout: $49.74

## Changelog

- 2026-10-09: [Correction](#correction-2026-10-09) added above the unedited output: the gbrain cells ran without reranking (0 of 600; stale metering-proxy port in restored slots; fixed in gbrain-evals #76 and #109).
