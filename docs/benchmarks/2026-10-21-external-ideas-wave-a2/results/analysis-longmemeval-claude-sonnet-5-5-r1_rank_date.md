# External ideas wave A2: r1_rank_date (claude-sonnet-5-5)

Suite: longmemeval. Verdict: **inconclusive** (alpha 0.05). Status: **complete**. gbrain `cfa1a006b`, 500 questions, 500 affected (their two requests differ), samples 1, 2. Primary judge: official_correct (gpt-4o-2024-08-06, LongMemEval evaluate_qa.py prompt).

| Measure | auto | r1_rank_date | Net gain | 95% CI | One-sided p | Wins | Losses |
|---|---|---|---|---|---|---|---|
| All questions, official judge | 463 | 462.5 | -0.5 | -6.5 to 5 | 0.6332 | 12 | 12 |
| Affected only, official judge | 463 | 462.5 | -0.5 | -6.5 to 5 | 0.6332 | 12 | 12 |
| All questions, framed judge (report-only) | 459.5 | 462 | 2.5 | | | 13 | 8 |

| Type | Questions | Affected | auto | r1_rank_date | Net gain |
|---|---|---|---|---|---|
| abstention | 30 | 30 | 28 | 28 | 0 |
| knowledge-update | 72 | 72 | 71 | 71.5 | 0.5 |
| multi-session | 121 | 121 | 104 | 105 | 1 |
| single-session-assistant | 56 | 56 | 55.5 | 55.5 | 0 |
| single-session-preference | 30 | 30 | 30 | 29.5 | -0.5 |
| single-session-user | 64 | 64 | 61.5 | 61.5 | 0 |
| temporal-reasoning | 127 | 127 | 113 | 111.5 | -1.5 |

Judge agreement: 1974 of 2000 rows (official yes / framed no 17, official no / framed yes 9).
Reader-noise floor (auto sample 1 vs 2): 12 of 500 questions discordant (2.4%); 12 of 500 affected.
