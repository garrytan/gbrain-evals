# particle-1 add-on: F6 cells read by particle-1

Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.

gbrain is Garry Tan's own project.

Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.

## claude-opus-5-5 and particle-1

Both means are over the questions both readers have in their denominators.

| Cell | How particle-1 read it | particle-1 run | Questions paired | Opus mean | particle-1 mean | particle-1 minus Opus (95% CI) | Opus $ per correct | particle-1 $ per correct |
|---|---|---|---:|---:|---:|---:|---:|---:|
| s1.baseline-file-agent.baseline.whole-agent | file agent | complete | 198 | 72.1% | 63.4% | -8.7 points (-14.0 to -3.2) | $1.1914 | $0.4368 |
| s1.ext-extract-first.common.component-b8000 | re-read | complete | 199 | 54.2% | 60.7% | +6.5 points (+2.4 to +11.2) | $0.1019 | $0.0064 |
| s1.ext-memory-bank.recipe.component-b8000 | re-read | complete | 199 | 51.9% | 52.9% | +0.9 points (-2.8 to +5.8) | $0.0948 | $0.0070 |
| s1.ext-temporal-graph.shipped-0.31.component-b8000 | re-read | complete | 199 | 47.6% | 45.4% | -2.2 points (-7.4 to +3.4) | $0.1117 | $0.0086 |
| s1.gbrain-defaults.f6-master.a0 | re-read | complete | 197 | 48.5% | 56.6% | +8.0 points (+5.2 to +11.3) | $0.1120 | $0.0059 |
| s1.gbrain-defaults.f6-master.p | re-read | complete | 199 | 60.7% | 56.4% | -4.3 points (-8.6 to +0.5) | $0.0869 | $0.0063 |
| s2b.ext-extract-first.common.component-b8000 | re-read | complete | 239 | 59.1% | 65.1% | +5.9 points (+1.3 to +10.9) | $0.0943 | $0.0054 |
| s2b.ext-memory-bank.recipe.component-b8000 | re-read | complete | 240 | 62.7% | 66.1% | +3.4 points (-0.2 to +7.2) | $0.0825 | $0.0047 |
| s2b.ext-temporal-graph.shipped-0.31.component-b8000 | re-read | complete | 240 | 56.0% | 59.2% | +3.2 points (-0.6 to +7.0) | $0.1011 | $0.0057 |
| s2b.gbrain-defaults.f6-master.a0 | re-read | complete | 240 | 64.1% | 66.7% | +2.6 points (-0.9 to +6.2) | $0.0886 | $0.0047 |
| s2b.gbrain-defaults.f6-master.p | re-read | complete | 240 | 62.8% | 67.2% | +4.4 points (+0.8 to +8.1) | $0.0844 | $0.0044 |

## s1.baseline-file-agent.baseline.whole-agent

particle-1 cell `s1.baseline-file-agent.particle.whole-agent` (the file agent, run again with particle-1 as its model). Run status: frontier complete, particle-1 complete. Preregistered exclusions left out: 1.

| Reader | Answers | In the denominator | Mean score (95% CI) | Correct | Reader $ (list price) | $ per correct | Not scored, by outcome |
|---|---:|---:|---:|---:|---:|---:|---|
| claude-opus-5-5 | 199 | 199 | 72.3% (67.1% to 77.3%) | 156 | $185.8535 | $1.1914 | context_overflow 5 |
| particle-1 | 199 | 198 | 63.4% (58.6% to 68.2%) | 138 | $60.2823 | $0.4368 | reader_error 1, turn_cap 23 |
| gpt-6.1-sol | 199 | 199 | 67.4% (63.0% to 71.9%) | 142 | $15.6105 | $0.1099 | none |
| claude-sonnet-5-5 | 199 | 199 | 64.8% (58.5% to 71.5%) | 138 | $35.3742 | $0.2563 | none |

particle-1 minus claude-opus-5-5: -8.7 points (95% CI -14.0 to -3.2), 198 questions in 10 conversations, two-sided sign-flip p 0.0215.

particle-1 minus gpt-6.1-sol: -3.8 points (95% CI -9.3 to +2.0), 198 questions in 10 conversations, two-sided sign-flip p 0.2402.

## s1.ext-extract-first.common.component-b8000

particle-1 cell `s1.ext-extract-first.common.component-b8000.reread-particle-particle-1` (the frozen contexts the frontier readers read, sent byte for byte). Run status: frontier complete, particle-1 complete. Preregistered exclusions left out: 1.

| Reader | Answers | In the denominator | Mean score (95% CI) | Correct | Reader $ (list price) | $ per correct | Not scored, by outcome |
|---|---:|---:|---:|---:|---:|---:|---|
| claude-opus-5-5 | 199 | 199 | 54.2% (49.3% to 58.8%) | 111 | $11.3081 | $0.1019 | none |
| particle-1 | 199 | 199 | 60.7% (56.8% to 64.8%) | 127 | $0.8173 | $0.0064 | none |
| gpt-6.1-sol | 199 | 199 | 60.4% (55.6% to 64.9%) | 130 | $3.1843 | $0.0245 | none |
| claude-sonnet-5-5 | 199 | 199 | 61.3% (57.5% to 65.6%) | 128 | $4.8204 | $0.0377 | none |

particle-1 minus claude-opus-5-5: +6.5 points (95% CI +2.4 to +11.2), 199 questions in 10 conversations, two-sided sign-flip p 0.0098.

particle-1 minus gpt-6.1-sol: +0.3 points (95% CI -4.0 to +5.3), 199 questions in 10 conversations, two-sided sign-flip p 0.9297.

Verified before any request: contexts checked 200, contexts matched 200, scheduled questions 200, questions with context 200, questions without context 0, stored answers cross checked 1000, published answers 1000, contexts not read 0.

## s1.ext-memory-bank.recipe.component-b8000

particle-1 cell `s1.ext-memory-bank.recipe.component-b8000.reread-particle-particle-1` (the frozen contexts the frontier readers read, sent byte for byte). Run status: frontier complete, particle-1 complete. Preregistered exclusions left out: 1.

| Reader | Answers | In the denominator | Mean score (95% CI) | Correct | Reader $ (list price) | $ per correct | Not scored, by outcome |
|---|---:|---:|---:|---:|---:|---:|---|
| claude-opus-5-5 | 199 | 199 | 51.9% (48.1% to 55.9%) | 110 | $10.4297 | $0.0948 | none |
| particle-1 | 199 | 199 | 52.9% (49.2% to 56.6%) | 113 | $0.7898 | $0.0070 | none |
| gpt-6.1-sol | 199 | 199 | 57.7% (52.7% to 62.1%) | 124 | $3.0282 | $0.0244 | none |
| claude-sonnet-5-5 | 199 | 199 | 57.1% (53.7% to 60.4%) | 117 | $4.4277 | $0.0378 | none |

particle-1 minus claude-opus-5-5: +0.9 points (95% CI -2.8 to +5.8), 199 questions in 10 conversations, two-sided sign-flip p 0.7832.

particle-1 minus gpt-6.1-sol: -4.9 points (95% CI -9.1 to -0.6), 199 questions in 10 conversations, two-sided sign-flip p 0.0664.

Verified before any request: contexts checked 200, contexts matched 200, scheduled questions 200, questions with context 200, questions without context 0, stored answers cross checked 1000, published answers 1000, contexts not read 0.

## s1.ext-temporal-graph.shipped-0.31.component-b8000

particle-1 cell `s1.ext-temporal-graph.shipped-0.31.component-b8000.reread-particle-particle-1` (the frozen contexts the frontier readers read, sent byte for byte). Run status: frontier complete, particle-1 complete. Preregistered exclusions left out: 1.

| Reader | Answers | In the denominator | Mean score (95% CI) | Correct | Reader $ (list price) | $ per correct | Not scored, by outcome |
|---|---:|---:|---:|---:|---:|---:|---|
| claude-opus-5-5 | 199 | 199 | 47.6% (44.0% to 51.2%) | 102 | $11.3884 | $0.1117 | none |
| particle-1 | 199 | 199 | 45.4% (40.8% to 50.1%) | 97 | $0.8364 | $0.0086 | none |
| gpt-6.1-sol | 199 | 199 | 48.3% (45.6% to 51.4%) | 103 | $2.9569 | $0.0287 | none |
| claude-sonnet-5-5 | 199 | 199 | 50.1% (46.1% to 53.9%) | 106 | $4.8930 | $0.0462 | none |

particle-1 minus claude-opus-5-5: -2.2 points (95% CI -7.4 to +3.4), 199 questions in 10 conversations, two-sided sign-flip p 0.459.

particle-1 minus gpt-6.1-sol: -2.9 points (95% CI -7.9 to +2.5), 199 questions in 10 conversations, two-sided sign-flip p 0.3223.

Verified before any request: contexts checked 200, contexts matched 200, scheduled questions 200, questions with context 200, questions without context 0, stored answers cross checked 600, published answers 600, contexts not read 0.

## s1.gbrain-defaults.f6-master.a0

particle-1 cell `s1.gbrain-defaults.f6-master.a0.reread-particle-particle-1` (the frozen contexts the frontier readers read, sent byte for byte). Run status: frontier complete, particle-1 complete. Preregistered exclusions left out: 1.

| Reader | Answers | In the denominator | Mean score (95% CI) | Correct | Reader $ (list price) | $ per correct | Not scored, by outcome |
|---|---:|---:|---:|---:|---:|---:|---|
| claude-opus-5-5 | 199 | 197 | 48.5% (43.4% to 54.3%) | 101 | $11.3084 | $0.1120 | harness_invalid 2 |
| particle-1 | 199 | 197 | 56.6% (51.7% to 61.8%) | 119 | $0.6962 | $0.0059 | harness_invalid 2 |
| gpt-6.1-sol | 199 | 197 | 56.7% (51.8% to 61.8%) | 113 | $2.9470 | $0.0261 | harness_invalid 2 |
| claude-sonnet-5-5 | 199 | 197 | 56.3% (52.3% to 60.8%) | 116 | $4.8526 | $0.0418 | harness_invalid 2 |

particle-1 minus claude-opus-5-5: +8.0 points (95% CI +5.2 to +11.3), 197 questions in 10 conversations, two-sided sign-flip p 0.002.

particle-1 minus gpt-6.1-sol: -0.1 points (95% CI -4.2 to +3.7), 197 questions in 10 conversations, two-sided sign-flip p 0.9551.

Verified before any request: contexts checked 198, contexts matched 198, scheduled questions 200, questions with context 198, questions without context 2, stored answers cross checked 600, published answers 600, contexts not read 0.

## s1.gbrain-defaults.f6-master.p

particle-1 cell `s1.gbrain-defaults.f6-master.p.reread-particle-particle-1` (the frozen contexts the frontier readers read, sent byte for byte). Run status: frontier complete, particle-1 complete. Preregistered exclusions left out: 1.

| Reader | Answers | In the denominator | Mean score (95% CI) | Correct | Reader $ (list price) | $ per correct | Not scored, by outcome |
|---|---:|---:|---:|---:|---:|---:|---|
| claude-opus-5-5 | 199 | 199 | 60.7% (56.9% to 65.3%) | 128 | $11.1172 | $0.0869 | none |
| particle-1 | 199 | 199 | 56.4% (51.6% to 61.4%) | 120 | $0.7531 | $0.0063 | none |
| gpt-6.1-sol | 199 | 199 | 61.6% (59.2% to 64.0%) | 133 | $2.8985 | $0.0218 | none |
| claude-sonnet-5-5 | 199 | 199 | 60.8% (56.4% to 65.6%) | 127 | $4.7304 | $0.0372 | none |

particle-1 minus claude-opus-5-5: -4.3 points (95% CI -8.6 to +0.5), 199 questions in 10 conversations, two-sided sign-flip p 0.1172.

particle-1 minus gpt-6.1-sol: -5.3 points (95% CI -9.6 to -0.1), 199 questions in 10 conversations, two-sided sign-flip p 0.0801.

Verified before any request: contexts checked 200, contexts matched 200, scheduled questions 200, questions with context 200, questions without context 0, stored answers cross checked 600, published answers 600, contexts not read 0.

## s2b.ext-extract-first.common.component-b8000

particle-1 cell `s2b.ext-extract-first.common.component-b8000.reread-particle-particle-1` (the frozen contexts the frontier readers read, sent byte for byte). Run status: frontier complete, particle-1 complete. Preregistered exclusions left out: 0.

| Reader | Answers | In the denominator | Mean score (95% CI) | Correct | Reader $ (list price) | $ per correct | Not scored, by outcome |
|---|---:|---:|---:|---:|---:|---:|---|
| claude-opus-5-5 | 240 | 240 | 58.9% (54.6% to 62.9%) | 149 | $14.0472 | $0.0943 | none |
| particle-1 | 240 | 239 | 65.1% (61.7% to 68.8%) | 166 | $0.8914 | $0.0054 | reader_error 1 |
| gpt-6.1-sol | 240 | 240 | 62.5% (58.6% to 66.4%) | 162 | $3.8999 | $0.0241 | none |
| claude-sonnet-5-5 | 240 | 240 | 68.8% (65.4% to 72.3%) | 177 | $5.9688 | $0.0337 | none |

particle-1 minus claude-opus-5-5: +5.9 points (95% CI +1.3 to +10.9), 239 questions in 24 conversations, two-sided sign-flip p 0.03.

particle-1 minus gpt-6.1-sol: +2.3 points (95% CI -2.4 to +6.7), 239 questions in 24 conversations, two-sided sign-flip p 0.3387.

Verified before any request: contexts checked 240, contexts matched 240, scheduled questions 240, questions with context 240, questions without context 0, stored answers cross checked 720, published answers 720, contexts not read 0.

## s2b.ext-memory-bank.recipe.component-b8000

particle-1 cell `s2b.ext-memory-bank.recipe.component-b8000.reread-particle-particle-1` (the frozen contexts the frontier readers read, sent byte for byte). Run status: frontier complete, particle-1 complete. Preregistered exclusions left out: 0.

| Reader | Answers | In the denominator | Mean score (95% CI) | Correct | Reader $ (list price) | $ per correct | Not scored, by outcome |
|---|---:|---:|---:|---:|---:|---:|---|
| claude-opus-5-5 | 240 | 240 | 62.7% (58.4% to 66.7%) | 155 | $12.7930 | $0.0825 | none |
| particle-1 | 240 | 240 | 66.1% (62.4% to 70.0%) | 171 | $0.8014 | $0.0047 | none |
| gpt-6.1-sol | 240 | 240 | 67.8% (64.7% to 71.0%) | 176 | $3.7698 | $0.0214 | none |
| claude-sonnet-5-5 | 240 | 240 | 69.9% (66.5% to 73.3%) | 180 | $5.4923 | $0.0305 | none |

particle-1 minus claude-opus-5-5: +3.4 points (95% CI -0.2 to +7.2), 240 questions in 24 conversations, two-sided sign-flip p 0.0927.

particle-1 minus gpt-6.1-sol: -1.7 points (95% CI -5.6 to +1.8), 240 questions in 24 conversations, two-sided sign-flip p 0.4038.

Verified before any request: contexts checked 240, contexts matched 240, scheduled questions 240, questions with context 240, questions without context 0, stored answers cross checked 720, published answers 720, contexts not read 0.

## s2b.ext-temporal-graph.shipped-0.31.component-b8000

particle-1 cell `s2b.ext-temporal-graph.shipped-0.31.component-b8000.reread-particle-particle-1` (the frozen contexts the frontier readers read, sent byte for byte). Run status: frontier complete, particle-1 complete. Preregistered exclusions left out: 0.

| Reader | Answers | In the denominator | Mean score (95% CI) | Correct | Reader $ (list price) | $ per correct | Not scored, by outcome |
|---|---:|---:|---:|---:|---:|---:|---|
| claude-opus-5-5 | 240 | 240 | 56.0% (51.6% to 60.2%) | 140 | $14.1592 | $0.1011 | none |
| particle-1 | 240 | 240 | 59.2% (56.7% to 61.8%) | 157 | $0.8979 | $0.0057 | none |
| gpt-6.1-sol | 240 | 240 | 57.4% (53.8% to 61.0%) | 148 | $3.7779 | $0.0255 | none |
| claude-sonnet-5-5 | 240 | 240 | 63.3% (60.2% to 66.6%) | 162 | $6.0532 | $0.0374 | none |

particle-1 minus claude-opus-5-5: +3.2 points (95% CI -0.6 to +7.0), 240 questions in 24 conversations, two-sided sign-flip p 0.1134.

particle-1 minus gpt-6.1-sol: +1.8 points (95% CI -1.5 to +4.9), 240 questions in 24 conversations, two-sided sign-flip p 0.2934.

Verified before any request: contexts checked 240, contexts matched 240, scheduled questions 240, questions with context 240, questions without context 0, stored answers cross checked 720, published answers 720, contexts not read 0.

## s2b.gbrain-defaults.f6-master.a0

particle-1 cell `s2b.gbrain-defaults.f6-master.a0.reread-particle-particle-1` (the frozen contexts the frontier readers read, sent byte for byte). Run status: frontier complete, particle-1 complete. Preregistered exclusions left out: 0.

| Reader | Answers | In the denominator | Mean score (95% CI) | Correct | Reader $ (list price) | $ per correct | Not scored, by outcome |
|---|---:|---:|---:|---:|---:|---:|---|
| claude-opus-5-5 | 240 | 240 | 64.1% (60.9% to 67.4%) | 159 | $14.0895 | $0.0886 | none |
| particle-1 | 240 | 240 | 66.7% (62.8% to 70.4%) | 170 | $0.8020 | $0.0047 | none |
| gpt-6.1-sol | 240 | 240 | 67.6% (64.3% to 70.9%) | 176 | $3.7516 | $0.0213 | none |
| claude-sonnet-5-5 | 240 | 240 | 67.2% (64.2% to 70.3%) | 173 | $6.0396 | $0.0349 | none |

particle-1 minus claude-opus-5-5: +2.6 points (95% CI -0.9 to +6.2), 240 questions in 24 conversations, two-sided sign-flip p 0.1681.

particle-1 minus gpt-6.1-sol: -0.9 points (95% CI -4.3 to +2.2), 240 questions in 24 conversations, two-sided sign-flip p 0.5823.

Verified before any request: contexts checked 240, contexts matched 240, scheduled questions 240, questions with context 240, questions without context 0, stored answers cross checked 720, published answers 720, contexts not read 0.

## s2b.gbrain-defaults.f6-master.p

particle-1 cell `s2b.gbrain-defaults.f6-master.p.reread-particle-particle-1` (the frozen contexts the frontier readers read, sent byte for byte). Run status: frontier complete, particle-1 complete. Preregistered exclusions left out: 0.

| Reader | Answers | In the denominator | Mean score (95% CI) | Correct | Reader $ (list price) | $ per correct | Not scored, by outcome |
|---|---:|---:|---:|---:|---:|---:|---|
| claude-opus-5-5 | 240 | 240 | 62.8% (59.6% to 65.9%) | 160 | $13.5079 | $0.0844 | none |
| particle-1 | 240 | 240 | 67.2% (63.5% to 71.1%) | 172 | $0.7625 | $0.0044 | none |
| gpt-6.1-sol | 240 | 240 | 69.5% (66.5% to 72.5%) | 180 | $3.5978 | $0.0200 | none |
| claude-sonnet-5-5 | 240 | 240 | 72.2% (69.5% to 74.8%) | 186 | $5.7670 | $0.0310 | none |

particle-1 minus claude-opus-5-5: +4.4 points (95% CI +0.8 to +8.1), 240 questions in 24 conversations, two-sided sign-flip p 0.0264.

particle-1 minus gpt-6.1-sol: -2.3 points (95% CI -6.1 to +1.7), 240 questions in 24 conversations, two-sided sign-flip p 0.2739.

Verified before any request: contexts checked 240, contexts matched 240, scheduled questions 240, questions with context 240, questions without context 0, stored answers cross checked 720, published answers 720, contexts not read 0.

## Method

Replicate 0 of each reader, without the questions the set's preregistration excludes. A product failure (retrieval_error, unsupported, turn_cap, context_overflow) scores 0; a harness failure (reader_error, judge_error, harness_invalid, budget_not_run), an answer without a scored canonical judgment (counted as unjudged) and a not-applicable answer (does_not_fit) leave the denominator. A correct answer has a canonical score of at least 0.5. Reader dollars price each answer's usage at the budget ledger's base list rates; failed tries are not priced, since only OpenAI-compatible readers record their usage, and each cell's metered spend is in its receipt. Intervals are a bootstrap over conversations, 10,000 resamples, seed `f6-p1` (1248705093); paired differences use the questions both readers have in their denominators.
