# External ideas wave A2: r2_tail_trim (claude-opus-5-5)

Suite: longmemeval (affected questions only). Verdict: **inconclusive** (alpha 0.05). Status: **complete**. gbrain `cfa1a006b`, 217 questions, 217 affected (their two requests differ), samples 1, 2. Primary judge: official_correct (gpt-4o-2024-08-06, LongMemEval evaluate_qa.py prompt).

| Measure | auto | r2_tail_trim | Net gain | 95% CI | One-sided p | Wins | Losses |
|---|---|---|---|---|---|---|---|
| All questions, official judge | 210 | 209 | -1 | -4.5 to 2 | 0.8208 | 3 | 4 |
| Affected only, official judge | 210 | 209 | -1 | -4.5 to 2 | 0.8208 | 3 | 4 |
| All questions, framed judge (report-only) | 210.5 | 208 | -2.5 | | | 1 | 4 |

| Type | Questions | Affected | auto | r2_tail_trim | Net gain |
|---|---|---|---|---|---|
| abstention | 4 | 4 | 3.5 | 3 | -0.5 |
| knowledge-update | 62 | 62 | 59.5 | 59 | -0.5 |
| multi-session | 34 | 34 | 32 | 31.5 | -0.5 |
| single-session-assistant | 52 | 52 | 52 | 51.5 | -0.5 |
| single-session-preference | 2 | 2 | 2 | 2 | 0 |
| single-session-user | 39 | 39 | 38.5 | 39 | 0.5 |
| temporal-reasoning | 24 | 24 | 22.5 | 23 | 0.5 |

Judge agreement: 863 of 868 rows (official yes / framed no 3, official no / framed yes 2).
Reader-noise floor (auto sample 1 vs 2): 4 of 217 questions discordant (1.8%); 4 of 217 affected.
