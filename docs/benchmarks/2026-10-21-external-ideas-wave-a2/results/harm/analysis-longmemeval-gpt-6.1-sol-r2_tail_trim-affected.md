# External ideas wave A2: r2_tail_trim (gpt-6.1-sol)

Suite: longmemeval (affected questions only). Verdict: **incomplete** (alpha 0.05). Status: **INCOMPLETE**. gbrain `cfa1a006b`, 217 questions, 217 affected (their two requests differ), samples 1, 2. Primary judge: official_correct (gpt-4o-2024-08-06, LongMemEval evaluate_qa.py prompt).

Failures: reader_errored 3.

| Measure | auto | r2_tail_trim | Net gain | 95% CI | One-sided p | Wins | Losses |
|---|---|---|---|---|---|---|---|
| All questions, official judge | 208 | 208 | 0 | -3.5 to 3 | 0.6044 | 5 | 4 |
| Affected only, official judge | 208 | 208 | 0 | -3.5 to 3 | 0.6044 | 5 | 4 |
| All questions, framed judge (report-only) | 207.5 | 207.5 | 0 | | | 4 | 4 |

| Type | Questions | Affected | auto | r2_tail_trim | Net gain |
|---|---|---|---|---|---|
| abstention | 4 | 4 | 2 | 2 | 0 |
| knowledge-update | 62 | 62 | 60.5 | 60 | -0.5 |
| multi-session | 34 | 34 | 31 | 31 | 0 |
| single-session-assistant | 52 | 52 | 51.5 | 52 | 0.5 |
| single-session-preference | 2 | 2 | 2 | 2 | 0 |
| single-session-user | 39 | 39 | 39 | 38.5 | -0.5 |
| temporal-reasoning | 24 | 24 | 22 | 22.5 | 0.5 |

Judge agreement: 857 of 865 rows (official yes / framed no 5, official no / framed yes 3).
Reader-noise floor (auto sample 1 vs 2): 3 of 214 questions discordant (1.4%); 3 of 214 affected.
