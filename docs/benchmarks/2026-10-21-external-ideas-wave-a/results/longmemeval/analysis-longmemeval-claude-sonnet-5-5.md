# External ideas wave A: relative-date brackets (claude-sonnet-5-5)

Suite: longmemeval. Verdict: **inconclusive** (alpha 0.05). Status: **complete**. gbrain `cfa1a006b`, 500 questions, 395 affected (their two requests differ), samples 1, 2. Primary judge: official_correct (gpt-4o-2024-08-06, LongMemEval evaluate_qa.py prompt).

| Measure | auto | auto_dates | Net gain | 95% CI | One-sided p | Wins | Losses |
|---|---|---|---|---|---|---|---|
| All questions, official judge | 463 | 460.5 | -2.5 | -8 to 2.5 | 0.8660 | 9 | 14 |
| Affected only, official judge | 363 | 360.5 | -2.5 | -8 to 2.5 | 0.8671 | 9 | 14 |
| All questions, framed judge (report-only) | 459.5 | 457 | -2.5 | | | 8 | 13 |

| Type | Questions | Affected | auto | auto_dates | Net gain |
|---|---|---|---|---|---|
| abstention | 30 | 24 | 28 | 28 | 0 |
| knowledge-update | 72 | 57 | 71 | 71 | 0 |
| multi-session | 121 | 97 | 104 | 104 | 0 |
| single-session-assistant | 56 | 35 | 55.5 | 56 | 0.5 |
| single-session-preference | 30 | 23 | 30 | 29.5 | -0.5 |
| single-session-user | 64 | 50 | 61.5 | 60.5 | -1 |
| temporal-reasoning | 127 | 109 | 113 | 111.5 | -1.5 |

Judge agreement: 1762 of 1790 rows (official yes / framed no 19, official no / framed yes 9).
Reader-noise floor (auto sample 1 vs 2): 12 of 500 questions discordant (2.4%); 8 of 395 affected.
