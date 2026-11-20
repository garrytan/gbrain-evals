# Live recall phase 2 task scorecard

Public copy: the run's cap, its cost totals and each cell's spend are removed by `eval/runner/live-recall/redact-scorecard.ts`; each cell's answer cost per correct answer is kept.

Status: complete. gbrain 0.60.613.0 at 98dda48fb9fd339609d6d4eef009811280ff648d, barrier no_write_privilege, runner 4740c1f35f85d2661b149a88cfd8127c00dc005c.

Tasks: 99 kept at run (99 frozen, 1 dropped at the freeze as unreachable to a remote caller, 0 lost since), in 87 gold clusters (11 hold tasks that share a gold page, sizes 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2). Intervals and p-values treat each gold cluster as one unit.

## Primary models, paraphrase form

| Arm | Model | Correct % (95% CI) | Correct and grounded % | Answer cost per correct |
|---|---|---|---|---|
| A | claude-opus-5-5 | 13.1 (7.0–20.4), n=99 | n/a | $0.0646 |
| A | particle-1 | 9.1 (4.0–15.2), n=99 | n/a | $0.0069 |
| B | claude-opus-5-5 | 86.7 (78.8–93.8), n=98 | 68.4 (58.6–78.1), n=98 | $0.1284 |
| B | particle-1 | 68.0 (58.5–77.5), n=97 | 54.6 (44.1–65.3), n=97 | $0.0515 |
| C | claude-opus-5-5 | 83.8 (76.7–90.6), n=99 | 53.5 (42.9–64.1), n=99 | $0.1454 |
| C | particle-1 | 68.4 (59.6–77.3), n=98 | 40.8 (31.7–50.5), n=98 | $0.0575 |
| D | claude-opus-5-5 | 52.6 (41.9–64.1), n=97 | 48.4 (37.8–59.8), n=97 | $0.1455 |
| D | particle-1 | 50.5 (40.0–61.9), n=97 | 47.4 (37.1–58.7), n=97 | $0.0055 |

## Primary comparisons (paraphrase form, Holm over four)

| Comparison | Pairs | A | B | B − A (95% CI) | Reading | Tasks worse | Exact p (gold clusters) | Holm p | Observed MDE |
|---|---|---|---|---|---|---|---|---|---|
| p1_b_vs_a_opus | 98 | 13.3 | 86.7 | 73.5 (63.9 to 82.5) | B above A | 0 | 0 | 0 | 13.4 |
| p1_b_vs_a_particle | 97 | 9.3 | 68.0 | 58.8 (48.5 to 68.8) | B above A | 0 | 0 | 0 | 14.3 |
| p2_c_vs_b_opus | 98 | 68.4 | 54.1 | -14.3 (-22.1 to -6.3) | C below B | 16 | 0.0013 | 0.0026 | 11.2 |
| p2_c_vs_b_particle | 97 | 54.6 | 40.2 | -14.4 (-25.0 to -4.1) | C below B | 21 | 0.0125 | 0.0125 | 14.9 |

## Original tasks against replacement tasks (descriptive)

Original tasks (kept from the first task file): 37 tasks (identifier 13, error_string 19, time_window 2, cross_source 0, topic 3).
Replacement tasks (written after the first freeze): 62 tasks (identifier 6, error_string 1, time_window 18, cross_source 20, topic 17).

The four primaries on each group alone, unadjusted and without Holm: descriptive only, never a verdict.

| Comparison | Tasks | Pairs | A | B | B − A (95% CI) | Reading |
|---|---|---|---|---|---|---|
| p1_b_vs_a_opus (original) | 37 | 37 | 10.8 | 86.5 | 75.7 (60.0 to 89.5) | B above A |
| p1_b_vs_a_particle (original) | 37 | 37 | 5.4 | 73.0 | 67.6 (51.3 to 83.3) | B above A |
| p2_c_vs_b_opus (original) | 37 | 37 | 67.6 | 56.8 | -10.8 (-24.3 to 0.0) | no measurable difference |
| p2_c_vs_b_particle (original) | 37 | 37 | 59.5 | 35.1 | -24.3 (-38.9 to -11.1) | C below B |
| p1_b_vs_a_opus (replacement) | 62 | 61 | 14.8 | 86.9 | 72.1 (59.7 to 83.6) | B above A |
| p1_b_vs_a_particle (replacement) | 62 | 60 | 11.7 | 65.0 | 53.3 (40.7 to 65.6) | B above A |
| p2_c_vs_b_opus (replacement) | 62 | 61 | 68.8 | 52.5 | -16.4 (-26.7 to -6.7) | C below B |
| p2_c_vs_b_particle (replacement) | 62 | 60 | 51.7 | 43.3 | -8.3 (-22.4 to 5.3) | no measurable difference |

## Every cell

| Form | Arm | Model | Counted | Excluded | Correct % | Grounded % | Abstained % | Confidently wrong % | Gold seen / opened / cited |
|---|---|---|---|---|---|---|---|---|---|
| paraphrase | A | claude-opus-5-5 | 99 | 0 | 13.1 | n/a | 84.9 | 2.0 | n/a / n/a / n/a |
| paraphrase | A | gpt-6.1-sol | 99 | 0 | 9.1 | n/a | 81.8 | 9.1 | n/a / n/a / n/a |
| paraphrase | A | particle-1 | 99 | 0 | 9.1 | n/a | 89.9 | 1.0 | n/a / n/a / n/a |
| paraphrase | B | claude-opus-5-5 | 98 | degraded 1 | 86.7 | 68.4 | 2.0 | 9.2 | 85.9 / 28.3 / 82.8 |
| paraphrase | B | gpt-6.1-sol | 99 | 0 | 72.7 | 68.7 | 0.0 | 21.2 | 87.9 / 71.7 / 70.7 |
| paraphrase | B | particle-1 | 97 | degraded 2 | 68.0 | 54.6 | 0.0 | 14.4 | 93.9 / 71.7 / 71.7 |
| paraphrase | C | claude-opus-5-5 | 99 | 0 | 83.8 | 53.5 | 7.1 | 9.1 | 83.8 / 17.2 / 79.8 |
| paraphrase | C | gpt-6.1-sol | 98 | degraded 1 | 78.6 | 74.5 | 2.0 | 19.4 | 88.9 / 67.7 / 66.7 |
| paraphrase | C | particle-1 | 98 | degraded 1 | 68.4 | 40.8 | 19.4 | 12.2 | 92.9 / 68.7 / 68.7 |
| paraphrase | D | claude-opus-5-5 | 97 | degraded 2 | 52.6 | 48.4 | 38.1 | 9.3 | n/a / n/a / 60.6 |
| paraphrase | D | gpt-6.1-sol | 97 | degraded 2 | 42.3 | 42.3 | 19.6 | 38.1 | n/a / n/a / 52.5 |
| paraphrase | D | particle-1 | 97 | degraded 2 | 50.5 | 47.4 | 37.1 | 12.4 | n/a / n/a / 58.6 |
| exact | A | claude-opus-5-5 | 99 | 0 | 16.2 | n/a | 81.8 | 2.0 | n/a / n/a / n/a |
| exact | A | gpt-6.1-sol | 99 | 0 | 7.1 | n/a | 80.8 | 12.1 | n/a / n/a / n/a |
| exact | A | particle-1 | 99 | 0 | 8.1 | n/a | 86.9 | 5.1 | n/a / n/a / n/a |
| exact | B | claude-opus-5-5 | 99 | 0 | 80.8 | 66.7 | 1.0 | 18.2 | 95.0 / 24.2 / 88.9 |
| exact | B | gpt-6.1-sol | 98 | degraded 1 | 77.5 | 70.4 | 0.0 | 22.4 | 92.9 / 66.7 / 75.8 |
| exact | B | particle-1 | 99 | 0 | 82.8 | 60.6 | 0.0 | 15.2 | 97.0 / 71.7 / 84.9 |
| exact | C | claude-opus-5-5 | 99 | 0 | 84.9 | 61.6 | 4.0 | 11.1 | 95.0 / 17.2 / 90.9 |
| exact | C | gpt-6.1-sol | 99 | 0 | 73.7 | 65.7 | 0.0 | 26.3 | 90.9 / 53.5 / 71.7 |
| exact | C | particle-1 | 99 | 0 | 81.8 | 48.5 | 2.0 | 16.2 | 98.0 / 63.6 / 87.9 |
| exact | D | claude-opus-5-5 | 97 | degraded 2 | 62.9 | 59.8 | 32.0 | 5.1 | n/a / n/a / 68.7 |
| exact | D | gpt-6.1-sol | 97 | degraded 2 | 50.5 | 50.5 | 21.6 | 27.8 | n/a / n/a / 59.6 |
| exact | D | particle-1 | 97 | degraded 2 | 58.8 | 56.7 | 32.0 | 9.3 | n/a / n/a / 69.7 |
| pooled | A | claude-opus-5-5 | 198 | 0 | 14.6 | n/a | 83.3 | 2.0 | n/a / n/a / n/a |
| pooled | A | gpt-6.1-sol | 198 | 0 | 8.1 | n/a | 81.3 | 10.6 | n/a / n/a / n/a |
| pooled | A | particle-1 | 198 | 0 | 8.6 | n/a | 88.4 | 3.0 | n/a / n/a / n/a |
| pooled | B | claude-opus-5-5 | 197 | degraded 1 | 83.8 | 67.5 | 1.5 | 13.7 | 90.4 / 26.3 / 85.9 |
| pooled | B | gpt-6.1-sol | 197 | degraded 1 | 75.1 | 69.5 | 0.0 | 21.8 | 90.4 / 69.2 / 73.2 |
| pooled | B | particle-1 | 196 | degraded 2 | 75.5 | 57.6 | 0.0 | 14.8 | 95.5 / 71.7 / 78.3 |
| pooled | C | claude-opus-5-5 | 198 | 0 | 84.3 | 57.6 | 5.6 | 10.1 | 89.4 / 17.2 / 85.4 |
| pooled | C | gpt-6.1-sol | 197 | degraded 1 | 76.1 | 70.0 | 1.0 | 22.8 | 89.9 / 60.6 / 69.2 |
| pooled | C | particle-1 | 197 | degraded 1 | 75.1 | 44.7 | 10.7 | 14.2 | 95.5 / 66.2 / 78.3 |
| pooled | D | claude-opus-5-5 | 194 | degraded 4 | 57.7 | 54.1 | 35.0 | 7.2 | n/a / n/a / 64.6 |
| pooled | D | gpt-6.1-sol | 194 | degraded 4 | 46.4 | 46.4 | 20.6 | 33.0 | n/a / n/a / 56.1 |
| pooled | D | particle-1 | 194 | degraded 4 | 54.6 | 52.1 | 34.5 | 10.8 | n/a / n/a / 64.1 |

## Descriptive comparisons

| Comparison | Pairs | B − A (95% CI) | Reading | Tasks worse | p |
|---|---|---|---|---|---|
| b_vs_a_correct_paraphrase_opus (a primary: read it above, with Holm) | 98 | 73.5 (63.9 to 82.5) | B above A | 0 | 0 |
| c_vs_b_correct_grounded_paraphrase_opus (a primary: read it above, with Holm) | 98 | -14.3 (-22.1 to -6.3) | C below B | 16 | 0.0013 |
| c_vs_b_correct_paraphrase_opus | 98 | -3.1 (-9.2 to 3.0) | no measurable difference | 6 | 0.5078 |
| d_vs_b_correct_paraphrase_opus | 96 | -34.4 (-45.5 to -23.6) | D below B | 34 | 0 |
| d_vs_b_correct_grounded_paraphrase_opus | 96 | -19.8 (-31.3 to -8.7) | D below B | 25 | 0.002 |
| b_vs_a_correct_exact_opus | 99 | 64.6 (54.7 to 74.0) | B above A | 0 | 0 |
| c_vs_b_correct_grounded_exact_opus | 99 | -5.1 (-12.8 to 2.2) | no measurable difference | 10 | 0.3018 |
| c_vs_b_correct_exact_opus | 99 | 4.0 (0.0 to 9.1) | no measurable difference | 1 | 0.2188 |
| d_vs_b_correct_exact_opus | 97 | -17.5 (-28.2 to -6.6) | D below B | 23 | 0.0051 |
| d_vs_b_correct_grounded_exact_opus | 97 | -6.2 (-17.3 to 5.3) | no measurable difference | 18 | 0.3794 |
| b_vs_a_correct_pooled_opus | 197 | 69.0 (61.0 to 76.7) | B above A | 0 | 0.0001 |
| c_vs_b_correct_grounded_pooled_opus | 197 | -9.6 (-15.4 to -4.1) | C below B | 23 | 0.0026 |
| c_vs_b_correct_pooled_opus | 197 | 0.5 (-3.5 to 4.7) | no measurable difference | 7 | 1 |
| d_vs_b_correct_pooled_opus | 193 | -25.9 (-35.3 to -16.5) | D below B | 41 | 0.0001 |
| d_vs_b_correct_grounded_pooled_opus | 193 | -13.0 (-21.9 to -4.1) | D below B | 35 | 0.0077 |
| b_vs_a_correct_paraphrase_sol | 99 | 63.6 (53.9 to 72.8) | B above A | 0 | 0 |
| c_vs_b_correct_grounded_paraphrase_sol | 98 | 5.1 (-3.1 to 12.4) | no measurable difference | 5 | 0.3018 |
| c_vs_b_correct_paraphrase_sol | 98 | 5.1 (-2.1 to 12.2) | no measurable difference | 4 | 0.2668 |
| d_vs_b_correct_paraphrase_sol | 97 | -29.9 (-41.2 to -18.4) | D below B | 34 | 0 |
| d_vs_b_correct_grounded_paraphrase_sol | 97 | -25.8 (-36.8 to -14.6) | D below B | 30 | 0.0001 |
| b_vs_a_correct_exact_sol | 98 | 70.4 (60.8 to 79.4) | B above A | 0 | 0 |
| c_vs_b_correct_grounded_exact_sol | 98 | -5.1 (-12.9 to 2.1) | no measurable difference | 9 | 0.3071 |
| c_vs_b_correct_exact_sol | 98 | -4.1 (-9.8 to 1.1) | no measurable difference | 6 | 0.2891 |
| d_vs_b_correct_exact_sol | 96 | -26.0 (-36.3 to -15.9) | D below B | 26 | 0 |
| d_vs_b_correct_grounded_exact_sol | 96 | -19.8 (-29.7 to -9.8) | D below B | 21 | 0.0005 |
| b_vs_a_correct_pooled_sol | 197 | 67.0 (58.8 to 74.5) | B above A | 0 | 0.0001 |
| c_vs_b_correct_grounded_pooled_sol | 196 | 0.0 (-5.3 to 5.4) | no measurable difference | 13 | 1 |
| c_vs_b_correct_pooled_sol | 196 | 0.5 (-4.2 to 5.3) | no measurable difference | 10 | 1 |
| d_vs_b_correct_pooled_sol | 193 | -28.0 (-37.2 to -18.8) | D below B | 42 | 0.0001 |
| d_vs_b_correct_grounded_pooled_sol | 193 | -22.8 (-31.7 to -14.1) | D below B | 39 | 0.0001 |
| b_vs_a_correct_paraphrase_particle (a primary: read it above, with Holm) | 97 | 58.8 (48.5 to 68.8) | B above A | 0 | 0 |
| c_vs_b_correct_grounded_paraphrase_particle (a primary: read it above, with Holm) | 97 | -14.4 (-25.0 to -4.1) | C below B | 21 | 0.0125 |
| c_vs_b_correct_paraphrase_particle | 97 | 0.0 (-8.3 to 8.0) | no measurable difference | 9 | 1 |
| d_vs_b_correct_paraphrase_particle | 95 | -17.9 (-29.2 to -6.6) | D below B | 24 | 0.0056 |
| d_vs_b_correct_grounded_paraphrase_particle | 95 | -8.4 (-19.8 to 3.1) | no measurable difference | 19 | 0.216 |
| b_vs_a_correct_exact_particle | 99 | 74.8 (66.0 to 83.2) | B above A | 0 | 0 |
| c_vs_b_correct_grounded_exact_particle | 99 | -12.1 (-22.7 to -1.1) | C below B | 21 | 0.0498 |
| c_vs_b_correct_exact_particle | 99 | -1.0 (-8.5 to 6.3) | no measurable difference | 8 | 1 |
| d_vs_b_correct_exact_particle | 97 | -23.7 (-34.7 to -12.8) | D below B | 26 | 0.0002 |
| d_vs_b_correct_grounded_exact_particle | 97 | -3.1 (-16.0 to 9.7) | no measurable difference | 19 | 0.757 |
| b_vs_a_correct_pooled_particle | 196 | 66.8 (59.8 to 73.7) | B above A | 0 | 0.0001 |
| c_vs_b_correct_grounded_pooled_particle | 196 | -13.3 (-20.9 to -5.4) | C below B | 35 | 0.0022 |
| c_vs_b_correct_pooled_particle | 196 | -0.5 (-5.7 to 4.6) | no measurable difference | 14 | 1 |
| d_vs_b_correct_pooled_particle | 192 | -20.8 (-29.7 to -11.6) | D below B | 36 | 0.0002 |
| d_vs_b_correct_grounded_pooled_particle | 192 | -5.7 (-15.0 to 3.7) | no measurable difference | 28 | 0.2894 |

## Judges

Second judge (claude-opus-5-5 on particle-1 rows of B, C and D, paraphrase): 271 of 275 agree on correct, kappa 0.9673. Wintermute audit: 29 of 30.

Judge versions: gpt-6-astra 1551 rows, 0 truncated (gpt-6-astra); claude-opus-5-5 1055 rows, 0 truncated (claude-opus-5-5).

Judge check before the run: passed. gpt-6-astra: correct kappa 1 on 143 labels (caught 69 of 69 bad, failed 0 of 74 good; labellers agree kappa 1), correct_grounded kappa 1 on 102 labels (caught 51 of 51 bad, failed 0 of 51 good; labellers agree kappa 0.9616); claude-opus-5-5: correct kappa 1 on 71 labels (caught 37 of 37 bad, failed 0 of 34 good; labellers agree kappa 0.9188), correct_grounded kappa 1 on 52 labels (caught 24 of 24 bad, failed 0 of 28 good; labellers agree kappa 0.9255).

Custody: read-only verified at start true, at end true; guard refusals {"insert":12059,"other":3598,"telemetry_write":398,"delete":63,"set_session":8}; AI refusals {}.
