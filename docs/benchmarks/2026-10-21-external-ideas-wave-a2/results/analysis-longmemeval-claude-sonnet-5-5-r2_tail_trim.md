# External ideas wave A2: r2_tail_trim (claude-sonnet-5-5)

Suite: longmemeval. Verdict: **inconclusive** (alpha 0.05). Status: **complete**. gbrain `cfa1a006b`, 500 questions, 217 affected (their two requests differ), samples 1, 2. Primary judge: official_correct (gpt-4o-2024-08-06, LongMemEval evaluate_qa.py prompt).

| Measure | auto | r2_tail_trim | Net gain | 95% CI | One-sided p | Wins | Losses |
|---|---|---|---|---|---|---|---|
| All questions, official judge | 463 | 463 | 0 | -4 to 4 | 0.5972 | 6 | 4 |
| Affected only, official judge | 209.5 | 209.5 | 0 | -4 to 3.5 | 0.5937 | 6 | 4 |
| All questions, framed judge (report-only) | 459.5 | 460 | 0.5 | | | 5 | 4 |

| Type | Questions | Affected | auto | r2_tail_trim | Net gain |
|---|---|---|---|---|---|
| abstention | 30 | 4 | 28 | 29 | 1 |
| knowledge-update | 72 | 62 | 71 | 69 | -2 |
| multi-session | 121 | 34 | 104 | 104 | 0 |
| single-session-assistant | 56 | 52 | 55.5 | 56 | 0.5 |
| single-session-preference | 30 | 2 | 30 | 30 | 0 |
| single-session-user | 64 | 39 | 61.5 | 62 | 0.5 |
| temporal-reasoning | 127 | 24 | 113 | 113 | 0 |

Judge agreement: 1412 of 1434 rows (official yes / framed no 16, official no / framed yes 6).
Reader-noise floor (auto sample 1 vs 2): 12 of 500 questions discordant (2.4%); 5 of 217 affected.
