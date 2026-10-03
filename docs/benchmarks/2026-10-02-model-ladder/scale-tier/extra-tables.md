### Agent-loop time per task (seconds; model plus tool time, both sessions for F)

| Model | oracle p50 / p95 | fs p50 / p95 | fs-acl p50 / p95 | memory p50 / p95 | pg p50 / p95 | gbrain p50 / p95 |
|---|---|---|---|---|---|---|
| claude-sonnet-5-5 | 4 / 8 | 14 / 34 | 12 / 16 | 33 / 135 | 11 / 35 | 22 / 100 |
| gpt-5.4 | 2 / 4 | 10 / 21 | 6 / 22 | 13 / 21 | 14 / 22 | 23 / 92 |
| claude-sonnet-4-6 | 7 / 10 | 14 / 64 | 8 / 25 | 27 / 95 | 13 / 46 | 26 / 124 |
| gpt-6.1-sol | 4 / 6 | 23 / 56 | 20 / 29 | 28 / 142 | 20 / 34 | 25 / 115 |

### How runs ended

| Arm | cells | submitted | turn cap | no tool call | provider error | context window exceeded |
|---|---|---|---|---|---|---|
| oracle | 200 | 200 | 0 | 0 | 0 | 0 |
| fs | 200 | 200 | 0 | 0 | 0 | 0 |
| fs-acl | 40 | 40 | 0 | 0 | 0 | 0 |
| memory | 120 | 107 | 9 | 0 | 4 | 4 |
| pg | 200 | 200 | 0 | 0 | 0 | 0 |
| gbrain | 200 | 199 | 1 | 0 | 0 | 0 |

### Success on the 30 tasks every arm ran

Tasks: A01, A02, A03, A04, A05, A06, B01, B02, B03, B04, B05, B06, C01, C02, C03, C06, C07, C08, E01, E02, E03, E04, E05, E06, F01, F02, F03, F04, F05, F06.

| Model | oracle | fs | memory | pg | gbrain |
|---|---|---|---|---|---|
| claude-sonnet-5-5 | 97% (29/30) | 90% (27/30) | 70% (21/30) | 83% (25/30) | 63% (19/30) |
| gpt-5.4 | 100% (30/30) | 67% (20/30) | 53% (16/30) | 50% (15/30) | 57% (17/30) |
| claude-sonnet-4-6 | 97% (29/30) | 63% (19/30) | 50% (15/30) | 63% (19/30) | 33% (10/30) |
| gpt-6.1-sol | 100% (30/30) | 97% (29/30) | 70% (21/30) | 93% (28/30) | 87% (26/30) |

### gbrain minus best complete baseline, by family (pooled over models; 95% task bootstrap)

Best baseline per model, chosen on all 50 tasks: claude-sonnet-5-5 fs, gpt-5.4 fs, claude-sonnet-4-6 fs, gpt-6.1-sol fs.

| Family | advantage | 95% CI |
|---|---|---|
| A | -12 pts | [-23, -2] |
| B | -7 pts | [-25, +8] |
| C | -20 pts | [-37, -5] |
| E | -28 pts | [-35, -20] |
| F | -15 pts | [-35, +5] |
| all | -16 pts | [-23, -9] |

### Spend by arm (model, judge and gbrain-internal calls)

| Arm | cells | total $ | $ per cell |
|---|---|---|---|
| oracle | 200 | 2.07 | 0.010 |
| fs | 200 | 12.01 | 0.060 |
| fs-acl | 40 | 0.85 | 0.021 |
| memory | 120 | 155.40 | 1.295 |
| pg | 200 | 6.21 | 0.031 |
| gbrain | 200 | 31.38 | 0.157 |
