# RS1 verdict (set RS1)

Gating judge versions: anthropic:claude-opus-5-5 claude-opus-5-5; openai:gpt-6-astra gpt-6-astra.

Verdict: **pass** (both gating one-sided 95% t lower bounds, Astra/Opus view, above -3.5; the bridge view is descriptive). 20 conversations, 397 of 400 planned questions in the common set; the bridge view has 397 questions over 20 conversations.

| Test | Role | n | Estimate | SD | Lower bound | Pass | Bootstrap lower | Worst-case lower | Validity |
|---|---|---:|---:|---:|---:|---|---:|---:|---|
| gbrain minus memory-bank, frontier | gating | 20 | 1.00 | 5.72 | -1.21 | yes | -1.22 | -1.70 | valid |
| gbrain minus memory-bank, bridge | descriptive | 20 | 1.13 | 5.33 | -0.93 | yes | -0.96 | -1.41 | valid |
| gbrain minus extract-first, frontier | gating | 20 | 2.83 | 4.54 | 1.07 | yes | 1.10 | 0.63 | valid |
| gbrain minus extract-first, bridge | descriptive | 20 | 2.48 | 3.97 | 0.94 | yes | 0.97 | 0.46 | valid |

Secondaries: superiority/extract-first pass, superiority/memory-bank fail.

Paired comparisons, gbrain minus the server on the same questions, in points. The gating view is gpt-6-astra on claude-opus-5-5 rows and claude-opus-5-5 on gpt-6.1-sol and particle-1 rows; the bridge view (gpt-4.1-mini) is descriptive and breaks the family rule on gpt-6.1-sol rows. Reader and ability rows are descriptive, with no multiplicity correction. The 90% interval's lower end is the one-sided bound the verdict uses.

| Server | View | Subset | Conversations | Questions | Mean difference | 95% interval | 90% interval | gbrain lower / higher / tied | Reading |
|---|---|---|---:|---:|---:|---|---|---|---|
| memory-bank | gating | overall | 20 | 397 | 1.00 | -1.67 to 3.68 | -1.21 to 3.22 | 97 / 123 / 177 | no measurable difference |
| memory-bank | gating | reader anthropic:claude-opus-5-5 | 20 | 397 | 2.68 | -0.04 to 5.39 | 0.43 to 4.92 | 65 / 97 / 235 | no measurable difference |
| memory-bank | gating | reader openai:gpt-6.1-sol | 20 | 397 | -0.29 | -3.30 to 2.71 | -2.78 to 2.19 | 91 / 76 / 230 | no measurable difference |
| memory-bank | gating | reader particle:particle-1 | 20 | 397 | 0.63 | -2.27 to 3.53 | -1.76 to 3.03 | 89 / 99 / 209 | no measurable difference |
| memory-bank | gating | ability abstention | 20 | 40 | 1.04 | -0.95 to 3.03 | -0.60 to 2.68 | 1 / 2 / 37 | no measurable difference |
| memory-bank | gating | ability contradiction_resolution | 20 | 40 | 0.63 | -5.60 to 6.85 | -4.52 to 5.77 | 17 / 16 / 7 | no measurable difference |
| memory-bank | gating | ability event_ordering | 20 | 37 | -3.16 | -6.93 to 0.61 | -6.28 to -0.04 | 22 / 15 / 0 | no measurable difference |
| memory-bank | gating | ability information_extraction | 20 | 40 | 7.67 | -0.77 to 16.12 | 0.70 to 14.65 | 3 / 12 / 25 | no measurable difference |
| memory-bank | gating | ability instruction_following | 20 | 40 | 13.75 | 5.01 to 22.49 | 6.53 to 20.97 | 5 / 26 / 9 | gbrain higher |
| memory-bank | gating | ability knowledge_update | 20 | 40 | 0.00 | -2.19 to 2.19 | -1.81 to 1.81 | 1 / 2 / 37 | no measurable difference |
| memory-bank | gating | ability multi_session_reasoning | 20 | 40 | -10.48 | -16.43 to -4.53 | -15.40 to -5.56 | 13 / 2 / 25 | gbrain lower |
| memory-bank | gating | ability preference_following | 20 | 40 | 1.65 | -5.52 to 8.83 | -4.27 to 7.58 | 12 / 16 / 12 | no measurable difference |
| memory-bank | gating | ability summarization | 20 | 40 | 8.35 | 1.17 to 15.53 | 2.42 to 14.28 | 11 / 27 / 2 | gbrain higher |
| memory-bank | gating | ability temporal_reasoning | 20 | 40 | -10.69 | -21.80 to 0.42 | -19.87 to -1.52 | 12 / 5 / 23 | no measurable difference |
| memory-bank | bridge | overall | 20 | 397 | 1.13 | -1.37 to 3.63 | -0.93 to 3.19 | 105 / 131 / 161 | no measurable difference |
| memory-bank | bridge | reader anthropic:claude-opus-5-5 | 20 | 397 | 2.83 | -0.29 to 5.94 | 0.25 to 5.40 | 81 / 103 / 213 | no measurable difference |
| memory-bank | bridge | reader openai:gpt-6.1-sol | 20 | 397 | 0.86 | -1.54 to 3.25 | -1.12 to 2.84 | 71 / 73 / 253 | no measurable difference |
| memory-bank | bridge | reader particle:particle-1 | 20 | 397 | -0.29 | -3.84 to 3.25 | -3.22 to 2.63 | 86 / 81 / 230 | no measurable difference |
| memory-bank | bridge | ability abstention | 20 | 40 | 0.42 | -0.46 to 1.29 | -0.30 to 1.14 | 0 / 1 / 39 | no measurable difference |
| memory-bank | bridge | ability contradiction_resolution | 20 | 40 | 0.42 | -7.10 to 7.93 | -5.79 to 6.63 | 17 / 21 / 2 | no measurable difference |
| memory-bank | bridge | ability event_ordering | 20 | 37 | -3.62 | -7.14 to -0.11 | -6.52 to -0.72 | 23 / 14 / 0 | gbrain lower |
| memory-bank | bridge | ability information_extraction | 20 | 40 | 10.42 | 0.99 to 19.86 | 2.63 to 18.22 | 2 / 13 / 25 | gbrain higher |
| memory-bank | bridge | ability instruction_following | 20 | 40 | 5.38 | -2.15 to 12.91 | -0.84 to 11.60 | 13 / 17 / 10 | no measurable difference |
| memory-bank | bridge | ability knowledge_update | 20 | 40 | 0.00 | -3.35 to 3.35 | -2.77 to 2.77 | 2 / 3 / 35 | no measurable difference |
| memory-bank | bridge | ability multi_session_reasoning | 20 | 40 | -4.91 | -11.11 to 1.29 | -10.03 to 0.21 | 14 / 11 / 15 | no measurable difference |
| memory-bank | bridge | ability preference_following | 20 | 40 | 2.86 | -4.44 to 10.16 | -3.17 to 8.89 | 9 / 17 / 14 | no measurable difference |
| memory-bank | bridge | ability summarization | 20 | 40 | 8.53 | 2.13 to 14.93 | 3.24 to 13.81 | 9 / 27 / 4 | gbrain higher |
| memory-bank | bridge | ability temporal_reasoning | 20 | 40 | -9.17 | -20.65 to 2.32 | -18.65 to 0.32 | 16 / 7 / 17 | no measurable difference |
| extract-first | gating | overall | 20 | 397 | 2.83 | 0.70 to 4.96 | 1.07 to 4.59 | 108 / 126 / 163 | gbrain higher |
| extract-first | gating | reader anthropic:claude-opus-5-5 | 20 | 397 | 3.08 | 0.93 to 5.24 | 1.30 to 4.86 | 70 / 102 / 225 | gbrain higher |
| extract-first | gating | reader openai:gpt-6.1-sol | 20 | 397 | 2.55 | -0.08 to 5.18 | 0.38 to 4.73 | 90 / 96 / 211 | no measurable difference |
| extract-first | gating | reader particle:particle-1 | 20 | 397 | 2.86 | 0.13 to 5.58 | 0.60 to 5.11 | 99 / 94 / 204 | gbrain higher |
| extract-first | gating | ability abstention | 20 | 40 | 0.42 | -0.98 to 1.82 | -0.74 to 1.57 | 1 / 1 / 38 | no measurable difference |
| extract-first | gating | ability contradiction_resolution | 20 | 40 | 7.50 | -0.40 to 15.40 | 0.97 to 14.03 | 11 / 26 / 3 | no measurable difference |
| extract-first | gating | ability event_ordering | 20 | 37 | -0.98 | -3.99 to 2.04 | -3.47 to 1.51 | 21 / 16 / 0 | no measurable difference |
| extract-first | gating | ability information_extraction | 20 | 40 | 4.62 | -3.97 to 13.21 | -2.48 to 11.72 | 9 / 10 / 21 | no measurable difference |
| extract-first | gating | ability instruction_following | 20 | 40 | 7.67 | 1.70 to 13.65 | 2.74 to 12.61 | 8 / 20 / 12 | gbrain higher |
| extract-first | gating | ability knowledge_update | 20 | 40 | 16.25 | 6.83 to 25.67 | 8.46 to 24.04 | 0 / 12 / 28 | gbrain higher |
| extract-first | gating | ability multi_session_reasoning | 20 | 40 | -4.32 | -11.92 to 3.28 | -10.60 to 1.96 | 13 / 6 / 21 | no measurable difference |
| extract-first | gating | ability preference_following | 20 | 40 | -0.43 | -8.46 to 7.59 | -7.06 to 6.20 | 15 / 13 / 12 | no measurable difference |
| extract-first | gating | ability summarization | 20 | 40 | -3.03 | -8.04 to 1.97 | -7.17 to 1.10 | 21 / 13 / 6 | no measurable difference |
| extract-first | gating | ability temporal_reasoning | 20 | 40 | -0.28 | -10.67 to 10.11 | -8.86 to 8.30 | 9 / 9 / 22 | no measurable difference |
| extract-first | bridge | overall | 20 | 397 | 2.48 | 0.62 to 4.33 | 0.94 to 4.01 | 109 / 124 / 164 | gbrain higher |
| extract-first | bridge | reader anthropic:claude-opus-5-5 | 20 | 397 | 2.99 | 0.40 to 5.58 | 0.85 to 5.13 | 78 / 104 / 215 | gbrain higher |
| extract-first | bridge | reader openai:gpt-6.1-sol | 20 | 397 | 3.67 | 1.55 to 5.79 | 1.92 to 5.42 | 73 / 91 / 233 | gbrain higher |
| extract-first | bridge | reader particle:particle-1 | 20 | 397 | 0.77 | -2.34 to 3.88 | -1.80 to 3.34 | 86 / 73 / 238 | no measurable difference |
| extract-first | bridge | ability abstention | 20 | 40 | -0.42 | -1.29 to 0.46 | -1.14 to 0.30 | 1 / 0 / 39 | no measurable difference |
| extract-first | bridge | ability contradiction_resolution | 20 | 40 | 6.88 | -0.87 to 14.62 | 0.48 to 13.27 | 12 / 21 / 7 | no measurable difference |
| extract-first | bridge | ability event_ordering | 20 | 37 | -1.78 | -4.38 to 0.82 | -3.93 to 0.37 | 22 / 15 / 0 | no measurable difference |
| extract-first | bridge | ability information_extraction | 20 | 40 | 5.78 | -2.69 to 14.26 | -1.22 to 12.79 | 7 / 10 / 23 | no measurable difference |
| extract-first | bridge | ability instruction_following | 20 | 40 | 2.74 | -3.72 to 9.21 | -2.60 to 8.08 | 13 / 15 / 12 | no measurable difference |
| extract-first | bridge | ability knowledge_update | 20 | 40 | 11.25 | 4.64 to 17.86 | 5.79 to 16.71 | 1 / 12 / 27 | gbrain higher |
| extract-first | bridge | ability multi_session_reasoning | 20 | 40 | -1.66 | -9.70 to 6.39 | -8.31 to 4.99 | 10 / 9 / 21 | no measurable difference |
| extract-first | bridge | ability preference_following | 20 | 40 | -0.13 | -6.84 to 6.59 | -5.67 to 5.42 | 13 / 13 / 14 | no measurable difference |
| extract-first | bridge | ability summarization | 20 | 40 | -0.37 | -5.98 to 5.24 | -5.00 to 4.27 | 18 / 17 / 5 | no measurable difference |
| extract-first | bridge | ability temporal_reasoning | 20 | 40 | 1.81 | -7.53 to 11.14 | -5.90 to 9.52 | 12 / 12 / 16 | no measurable difference |

| Reader | Row | Cost per question | Accuracy, frontier | Cost per correct, frontier | Accuracy, bridge | Cost per correct, bridge |
|---|---|---:|---:|---:|---:|---:|
| anthropic:claude-opus-5-5 | gbrain | 0.1205 | 78.75 | 0.1530 | 74.06 | 0.1627 |
| anthropic:claude-opus-5-5 | memory-bank | 0.1338 | 76.12 | 0.1758 | 71.33 | 0.1876 |
| anthropic:claude-opus-5-5 | extract-first | 0.2076 | 75.67 | 0.2743 | 71.12 | 0.2919 |
| anthropic:claude-opus-5-5 | floor | 0.0091 | n/a | n/a | 26.22 | 0.0347 |
| particle:particle-1 | gbrain | 0.0673 | 73.75 | 0.0912 | 78.11 | 0.0861 |
| particle:particle-1 | memory-bank | 0.0847 | 73.16 | 0.1157 | 78.41 | 0.1080 |
| particle:particle-1 | extract-first | 0.1540 | 71.03 | 0.2167 | 77.47 | 0.1987 |
| particle:particle-1 | floor | 0.0003 | n/a | n/a | 21.62 | 0.0015 |
| openai:gpt-6.1-sol | gbrain | 0.0817 | 72.87 | 0.1121 | 78.37 | 0.1042 |
| openai:gpt-6.1-sol | memory-bank | 0.0993 | 73.40 | 0.1353 | 77.81 | 0.1276 |
| openai:gpt-6.1-sol | extract-first | 0.1688 | 70.33 | 0.2399 | 74.78 | 0.2257 |
| openai:gpt-6.1-sol | floor | 0.0015 | n/a | n/a | 20.12 | 0.0075 |

| Row | Mean fill rate | Gate |
|---|---:|---|
| gbrain | 0.981 | pass |
| memory-bank | 0.984 | pass |
| extract-first | 0.990 | pass |

Floor (bridge view): 22.66 over 400 questions; below every system row: yes.

| Side and reason | Drops |
|---|---:|
| server, judgment_missing:frontier | 5 |

| Bridge view only: side and reason | Drops |
|---|---:|

## Provenance

Code a90e6c2a5a5de3b689820659a94ae554e8de04cb. SHA-256: verdict.ts a080b72d433eac52424898a9d205efd36315bb529f10d8e98911e2c526f584a4, iut.ts dbd7a8a3d947409d5bc12eddbffcf8fc9eb1ef75272342e08e417d56f48d7957, rs1-cells.json 1d4cefd0add83d41c086be1b1cfda1594d3bfee2bd25a37bbfb9ab451b4b344e, filled manifest d61e2689df73c0e94915dcdf151c886bcc1047e04b1da5ce7281fdc61664ae36, 144 receipt files 12ccdf42964eea5bc021b3330156e15411c1a25778cd07fc215bf0ac4b3c5227.
