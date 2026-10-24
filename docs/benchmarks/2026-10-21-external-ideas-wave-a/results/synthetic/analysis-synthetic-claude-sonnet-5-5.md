# External ideas wave A: relative-date brackets (claude-sonnet-5-5)

Suite: synthetic. Verdict: **inconclusive** (alpha 0.05). Status: **complete**. gbrain `cfa1a006b`, 60 questions, 60 affected (their two requests differ), samples 1, 2. Primary judge: official_correct (gpt-4o-2024-08-06, LongMemEval evaluate_qa.py prompt).

| Measure | auto | auto_dates | Net gain | 95% CI | One-sided p | Wins | Losses |
|---|---|---|---|---|---|---|---|
| All questions, official judge | 60 | 60 | 0 | 0 to 0 | 1.0000 | 0 | 0 |
| Affected only, official judge | 60 | 60 | 0 | 0 to 0 | 1.0000 | 0 | 0 |
| All questions, framed judge (report-only) | 60 | 60 | 0 | | | 0 | 0 |

| Type | Questions | Affected | auto | auto_dates | Net gain |
|---|---|---|---|---|---|
| temporal-reasoning | 60 | 60 | 60 | 60 | 0 |

Judge agreement: 240 of 240 rows (official yes / framed no 0, official no / framed yes 0).
Reader-noise floor (auto sample 1 vs 2): 0 of 60 questions discordant (0.0%); 0 of 60 affected.
