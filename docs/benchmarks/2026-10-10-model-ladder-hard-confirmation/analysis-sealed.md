## Hard tier

Canonical cells: 600 (the last harness-clean attempt per cell). Attempts: 600. Spend over every attempt: $487.50 (judge $5.86).
Harness-error retries per model and arm: none.
Grid and experiment checks: no problems found.

### Success by model and arm

| Model | fs | gbrain-hard |
|---|---|---|
| claude-sonnet-5-5 | 41% (41/100) | 47% (47/100) |
| claude-opus-5-5 | 51% (51/100) | 70% (70/100) |
| gpt-6.1-sol | 67% (67/100) | 81% (81/100) |
| all | 53% (159/300) | 66% (198/300) |

### Per arm and family

Stops count canonical cells, except harness_error, which counts retried attempts. Cost is agent, embedding and gbrain dollars over every attempt and session (judge excluded), divided by canonical cells. Agent latency excludes slot restore.

| Arm | Family | success | tool calls/task | turn_cap | no_tool_call | context_overflow | error | harness_error | unparseable sets | $/task | $/success | agent p50 s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| fs | H1 | 0% (0/60) | 79.75 | 47 | 0 | 12 | 1 | 0 | 60 | $0.8906 | n/a | 95.4 |
| fs | H2 | 63% (38/60) | 61.27 | 19 | 0 | 1 | 0 | 0 | 20 | $1.2270 | $1.9374 | 61.7 |
| fs | H3 | 20% (12/60) | 42.42 | 40 | 0 | 8 | 0 | 0 | 48 | $0.9532 | $4.7661 | 54.2 |
| fs | H4 | 82% (49/60) | 36.57 | 10 | 0 | 1 | 0 | 0 | 11 | $1.0585 | $1.2961 | 52.8 |
| fs | H5 | 100% (60/60) | 22.52 | 0 | 0 | 0 | 0 | 0 | 0 | $0.3306 | $0.3306 | 58.3 |
| fs | all | 53% (159/300) | 48.50 | 116 | 0 | 22 | 1 | 0 | 139 | $0.8920 | $1.6830 | 58.9 |
| gbrain-hard | H1 | 7% (4/60) | 32.58 | 53 | 0 | 0 | 0 | 0 | 53 | $1.2191 | $18.2872 | 143.7 |
| gbrain-hard | H2 | 77% (46/60) | 17.88 | 5 | 0 | 0 | 0 | 0 | 5 | $0.5116 | $0.6673 | 39.0 |
| gbrain-hard | H3 | 62% (37/60) | 28.87 | 19 | 0 | 0 | 0 | 0 | 19 | $0.9614 | $1.5590 | 75.2 |
| gbrain-hard | H4 | 87% (52/60) | 22.57 | 3 | 0 | 0 | 0 | 0 | 3 | $0.6290 | $0.7258 | 52.3 |
| gbrain-hard | H5 | 98% (59/60) | 27.10 | 0 | 0 | 0 | 0 | 0 | 0 | $0.2463 | $0.2504 | 86.6 |
| gbrain-hard | all | 66% (198/300) | 25.80 | 80 | 0 | 0 | 0 | 0 | 80 | $0.7135 | $1.0810 | 72.9 |

### Stops by session (multi-session cells)

| Arm | session | submitted | turn_cap | no_tool_call | context_overflow | error |
|---|---|---|---|---|---|---|
| fs | 1 | 60 | 0 | 0 | 0 | 0 |
| fs | 2 | 60 | 0 | 0 | 0 | 0 |
| fs | 3 | 60 | 0 | 0 | 0 | 0 |
| fs | 4 | 60 | 0 | 0 | 0 | 0 |
| fs | 5 | 60 | 0 | 0 | 0 | 0 |
| gbrain-hard | 1 | 60 | 0 | 0 | 0 | 0 |
| gbrain-hard | 2 | 60 | 0 | 0 | 0 | 0 |
| gbrain-hard | 3 | 60 | 0 | 0 | 0 | 0 |
| gbrain-hard | 4 | 60 | 0 | 0 | 0 | 0 |
| gbrain-hard | 5 | 60 | 0 | 0 | 0 | 0 |

### Cost and latency per model and arm

| Model | Arm | success | $/task (all attempts) | $/success | judge $/task | agent p50 s | agent p95 s | end-to-end p50 s | restore p50 s | retries |
|---|---|---|---|---|---|---|---|---|---|---|
| claude-sonnet-5-5 | fs | 41% (41/100) | $0.9100 | $2.2196 | $0.0055 | 53.1 | 152.8 | 55.7 | 0.0 | 0 |
| claude-sonnet-5-5 | gbrain-hard | 47% (47/100) | $0.6624 | $1.4093 | $0.0097 | 70.4 | 186.9 | 100.6 | 5.2 | 0 |
| claude-opus-5-5 | fs | 51% (51/100) | $1.5543 | $3.0476 | $0.0080 | 79.5 | 114.9 | 84.0 | 0.0 | 0 |
| claude-opus-5-5 | gbrain-hard | 70% (70/100) | $1.1076 | $1.5823 | $0.0136 | 85.0 | 198.1 | 110.1 | 5.2 | 0 |
| gpt-6.1-sol | fs | 67% (67/100) | $0.2116 | $0.3159 | $0.0085 | 53.2 | 108.8 | 55.1 | 0.0 | 0 |
| gpt-6.1-sol | gbrain-hard | 81% (81/100) | $0.3705 | $0.4574 | $0.0132 | 44.0 | 141.4 | 79.1 | 5.2 | 0 |

### Incremental cost per extra success against fs

Dollars per extra successful task = (cost per task of the arm minus that of the comparator) / (success rate of the arm minus that of the comparator); n/a when the arm does not finish more tasks.

| Model | Arm | Δ $/task | Δ success | $ per extra success | note |
|---|---|---|---|---|---|
| claude-sonnet-5-5 | gbrain-hard | $-0.2476 | +6.0 pts | $-4.1275 |  |
| claude-opus-5-5 | gbrain-hard | $-0.4467 | +19.0 pts | $-2.3508 |  |
| gpt-6.1-sol | gbrain-hard | $0.1588 | +14.0 pts | $1.1345 |  |
| all | gbrain-hard | $-0.1785 | +13.0 pts | $-1.3730 |  |

### Which families favor which arm

Success pooled over models; the oracle is a reference and is not ranked.

| Family | fs | gbrain-hard | favors |
|---|---|---|---|
| H1 | 0% (0/60) | 7% (4/60) | gbrain-hard by +6.7 pts |
| H2 | 63% (38/60) | 77% (46/60) | gbrain-hard by +13.3 pts |
| H3 | 20% (12/60) | 62% (37/60) | gbrain-hard by +41.7 pts |
| H4 | 82% (49/60) | 87% (52/60) | gbrain-hard by +5.0 pts |
| H5 | 100% (60/60) | 98% (59/60) | fs by +1.7 pts |
