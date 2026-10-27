## Hard tier

Canonical cells: 600 (the last harness-clean attempt per cell). Attempts: 600. Spend over every attempt: $480.24 (judge $9.60).
Harness-error retries per model and arm: none.
Grid and experiment checks: no problems found.

### Success by model and arm

| Model | fs | gbrain-hard |
|---|---|---|
| claude-sonnet-5-5 | 60% (60/100) | 69% (69/100) |
| claude-opus-5-5 | 73% (73/100) | 79% (79/100) |
| gpt-6.1-sol | 80% (80/100) | 88% (88/100) |
| all | 71% (213/300) | 79% (236/300) |

### Per arm and family

Stops count canonical cells, except harness_error, which counts retried attempts. Cost is agent, embedding and gbrain dollars over every attempt and session (judge excluded), divided by canonical cells. Agent latency excludes slot restore.

| Arm | Family | success | tool calls/task | turn_cap | no_tool_call | context_overflow | error | harness_error | unparseable sets | $/task | $/success | agent p50 s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| fs | H1 | 18% (11/60) | 62.00 | 46 | 0 | 0 | 0 | 0 | 48 | $1.1019 | $6.0103 | 96.7 |
| fs | H2 | 77% (46/60) | 37.22 | 6 | 0 | 3 | 0 | 0 | 9 | $0.9964 | $1.2996 | 48.4 |
| fs | H3 | 80% (48/60) | 27.25 | 12 | 0 | 0 | 0 | 0 | 12 | $0.8964 | $1.1205 | 44.0 |
| fs | H4 | 93% (56/60) | 25.58 | 2 | 0 | 0 | 0 | 0 | 2 | $1.1299 | $1.2107 | 41.6 |
| fs | H5 | 87% (52/60) | 51.98 | 0 | 0 | 1 | 0 | 0 | 1 | $0.8229 | $0.9495 | 91.7 |
| fs | all | 71% (213/300) | 40.81 | 66 | 0 | 4 | 0 | 0 | 72 | $0.9895 | $1.3937 | 58.1 |
| gbrain-hard | H1 | 30% (18/60) | 19.75 | 32 | 0 | 0 | 0 | 0 | 36 | $0.9975 | $3.3250 | 109.2 |
| gbrain-hard | H2 | 90% (54/60) | 14.70 | 0 | 0 | 0 | 0 | 0 | 0 | $0.4584 | $0.5094 | 35.4 |
| gbrain-hard | H3 | 95% (57/60) | 20.52 | 0 | 0 | 0 | 0 | 0 | 0 | $0.6173 | $0.6497 | 54.5 |
| gbrain-hard | H4 | 78% (47/60) | 17.28 | 0 | 0 | 0 | 0 | 0 | 0 | $0.4785 | $0.6108 | 39.4 |
| gbrain-hard | H5 | 100% (60/60) | 32.18 | 0 | 0 | 0 | 0 | 0 | 0 | $0.3449 | $0.3449 | 86.7 |
| gbrain-hard | all | 79% (236/300) | 20.89 | 32 | 0 | 0 | 0 | 0 | 36 | $0.5793 | $0.7364 | 60.8 |

### Stops by session (multi-session cells)

| Arm | session | submitted | turn_cap | no_tool_call | context_overflow | error |
|---|---|---|---|---|---|---|
| fs | 1 | 60 | 0 | 0 | 0 | 0 |
| fs | 2 | 59 | 0 | 0 | 1 | 0 |
| fs | 3 | 60 | 0 | 0 | 0 | 0 |
| fs | 4 | 59 | 0 | 0 | 1 | 0 |
| fs | 5 | 59 | 0 | 0 | 1 | 0 |
| gbrain-hard | 1 | 60 | 0 | 0 | 0 | 0 |
| gbrain-hard | 2 | 60 | 0 | 0 | 0 | 0 |
| gbrain-hard | 3 | 60 | 0 | 0 | 0 | 0 |
| gbrain-hard | 4 | 60 | 0 | 0 | 0 | 0 |
| gbrain-hard | 5 | 60 | 0 | 0 | 0 | 0 |

### Cost and latency per model and arm

| Model | Arm | success | $/task (all attempts) | $/success | judge $/task | agent p50 s | agent p95 s | end-to-end p50 s | restore p50 s | retries |
|---|---|---|---|---|---|---|---|---|---|---|
| claude-sonnet-5-5 | fs | 60% (60/100) | $1.0253 | $1.7088 | $0.0127 | 56.5 | 129.4 | 63.2 | 0.0 | 0 |
| claude-sonnet-5-5 | gbrain-hard | 69% (69/100) | $0.5878 | $0.8519 | $0.0174 | 64.3 | 147.3 | 83.5 | 5.0 | 0 |
| claude-opus-5-5 | fs | 73% (73/100) | $1.7535 | $2.4021 | $0.0158 | 74.1 | 165.5 | 80.5 | 0.0 | 0 |
| claude-opus-5-5 | gbrain-hard | 79% (79/100) | $0.8689 | $1.0999 | $0.0192 | 68.6 | 156.4 | 88.6 | 5.0 | 0 |
| gpt-6.1-sol | fs | 80% (80/100) | $0.1897 | $0.2371 | $0.0146 | 35.4 | 106.3 | 39.3 | 0.0 | 0 |
| gpt-6.1-sol | gbrain-hard | 88% (88/100) | $0.2812 | $0.3196 | $0.0163 | 37.3 | 114.6 | 49.5 | 4.9 | 0 |

### Incremental cost per extra success against fs

Dollars per extra successful task = (cost per task of the arm minus that of the comparator) / (success rate of the arm minus that of the comparator); n/a when the arm does not finish more tasks.

| Model | Arm | Δ $/task | Δ success | $ per extra success | note |
|---|---|---|---|---|---|
| claude-sonnet-5-5 | gbrain-hard | $-0.4375 | +9.0 pts | $-4.8608 |  |
| claude-opus-5-5 | gbrain-hard | $-0.8846 | +6.0 pts | $-14.7432 |  |
| gpt-6.1-sol | gbrain-hard | $0.0915 | +8.0 pts | $1.1439 |  |
| all | gbrain-hard | $-0.4102 | +7.7 pts | $-5.3502 |  |

### Which families favor which arm

Success pooled over models; the oracle is a reference and is not ranked.

| Family | fs | gbrain-hard | favors |
|---|---|---|---|
| H1 | 18% (11/60) | 30% (18/60) | gbrain-hard by +11.7 pts |
| H2 | 77% (46/60) | 90% (54/60) | gbrain-hard by +13.3 pts |
| H3 | 80% (48/60) | 95% (57/60) | gbrain-hard by +15.0 pts |
| H4 | 93% (56/60) | 78% (47/60) | fs by +15.0 pts |
| H5 | 87% (52/60) | 100% (60/60) | gbrain-hard by +13.3 pts |
