# RS1 judge check

**Every gate passed.**

Pool: 160 candidates (80 real, 40 gold, 40 corrupted; kinds number 15, date 0, entity 3, contradiction 2, negation 1, drop 8, abstain 3, invented 8), 505 rubric items. Gating judges at {"effort":"medium","max_tokens":8000}; gpt-4.1-mini at its protocol settings (descriptive).

Inter-judge kappa (Astra vs Opus): 0.948 (95% 0.919 to 0.976) over 505 items; weighted 0.941. Labelled set: 492 items (254 real, 110 gold, 128 corrupted).

Cross-family items only (reported, not a gate): Astra-Opus kappa 0.960 (95% 0.928 to 0.992) over 335 items. Labelled real items per gating view (40 wanted): openai:gpt-6-astra (anthropic:claude-opus-5-5 answers) 79 of 83; anthropic:claude-opus-5-5 (openai:gpt-6.1-sol, particle:particle-1 answers) 175 of 184.

| Gate | Value | Line | Pass |
|---|---:|---:|---|
| inter-judge kappa, Astra vs Opus (i) | 0.9475 | 0.6 | yes |
| openai:gpt-6-astra kappa against the construction labels (ii) | 0.9721 | 0.6 | yes |
| anthropic:claude-opus-5-5 kappa against the construction labels (ii) | 0.9721 | 0.6 | yes |
| openai:gpt-6-astra truncation rate | 0 | 0.01 | yes |
| anthropic:claude-opus-5-5 truncation rate | 0 | 0.01 | yes |

| Judge | Role | Class | Items | Catch rate (95%) | False-fail rate (95%) | Kappa vs labelled set (95%) |
|---|---|---|---:|---|---|---|
| openai:gpt-6-astra | gating | all | 505 | 99.5% (97.4% to 99.9%) of 211 | 0.4% (0.1% to 2.0%) of 281 | 1.000 (1.000 to 1.000) |
| openai:gpt-6-astra | gating | real | 267 | 100.0% (97.8% to 100.0%) of 167 | 0.0% (0.0% to 4.2%) of 87 | 1.000 (1.000 to 1.000) |
| openai:gpt-6-astra | gating | gold | 110 | n/a (n/a) of 0 | 0.0% (0.0% to 3.4%) of 110 | n/a (n/a) |
| openai:gpt-6-astra | gating | corrupt | 128 | 97.7% (88.2% to 99.6%) of 44 | 1.2% (0.2% to 6.4%) of 84 | 1.000 (1.000 to 1.000) |
| anthropic:claude-opus-5-5 | gating | all | 505 | 99.5% (97.4% to 99.9%) of 211 | 0.4% (0.1% to 2.0%) of 281 | 1.000 (1.000 to 1.000) |
| anthropic:claude-opus-5-5 | gating | real | 267 | 100.0% (97.8% to 100.0%) of 167 | 0.0% (0.0% to 4.2%) of 87 | 1.000 (1.000 to 1.000) |
| anthropic:claude-opus-5-5 | gating | gold | 110 | n/a (n/a) of 0 | 0.0% (0.0% to 3.4%) of 110 | n/a (n/a) |
| anthropic:claude-opus-5-5 | gating | corrupt | 128 | 97.7% (88.2% to 99.6%) of 44 | 1.2% (0.2% to 6.4%) of 84 | 1.000 (1.000 to 1.000) |
| openai:gpt-4.1-mini | descriptive | all | 505 | 75.8% (69.6% to 81.1%) of 211 | 5.0% (3.0% to 8.2%) of 281 | 0.724 (0.662 to 0.787) |
| openai:gpt-4.1-mini | descriptive | real | 267 | 71.9% (64.6% to 78.1%) of 167 | 14.9% (8.9% to 23.9%) of 87 | 0.520 (0.414 to 0.626) |
| openai:gpt-4.1-mini | descriptive | gold | 110 | n/a (n/a) of 0 | 0.0% (0.0% to 3.4%) of 110 | n/a (n/a) |
| openai:gpt-4.1-mini | descriptive | corrupt | 128 | 90.9% (78.8% to 96.4%) of 44 | 1.2% (0.2% to 6.4%) of 84 | 0.912 (0.836 to 0.988) |

| Judge | Kappa vs construction labels (95%) | Weighted | Judgments | Errors | Truncated | Cache hits / calls | Versions |
|---|---|---:|---:|---:|---|---|---|
| openai:gpt-6-astra | 0.972 (0.934 to 1.011) over 238 | 0.905 | 160 | 0 | 0 (0.0%) | 138 / 1179 | gpt-6-astra |
| anthropic:claude-opus-5-5 | 0.972 (0.934 to 1.011) over 238 | 0.928 | 160 | 0 | 0 (0.0%) | 135 / 1147 | claude-opus-5-5 |
| openai:gpt-4.1-mini | 0.928 (0.866 to 0.991) over 238 | 0.906 | 160 | 0 | 0 (0.0%) | not recorded | gpt-4.1-mini-2025-04-14 |

Astra and Opus agree with the labelled set by construction, so their kappa against it is circular; gate (ii) uses the construction labels instead. gpt-4.1-mini is descriptive and breaks the family rule on gpt-6.1-sol rows.

Spend: {"source":"metering proxy usage log (provider usage fields)","keyless":false,"usage":{"requests":3265,"refused":0,"unauthorized":0}}
