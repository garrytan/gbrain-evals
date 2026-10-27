| Model | Split | Applied | Wrong applied | Upper 95% | Qualifies | Coverage | Abstention | No answer | USD per call | p50 / p95 |
|---|---|---|---|---|---|---|---|---|---|---|
| `openai:gpt-6.1-sol` | counted | 496 | 0 | 0.6% | yes | 99.2% | 100.0% | 1 | $0.0016 | 2.4 s / 3.2 s |
| `anthropic:claude-sonnet-5-5` | counted | 121 | 1 | 3.9% | no | 24.0% | 99.6% | 14 | $0.0032 | 1.7 s / 4.5 s |
| `anthropic:claude-opus-5-5` | counted | 2 | 0 | 77.6% | no | 0.4% | 100.0% | 3 | $0.0069 | 2.7 s / 4.9 s |

### `openai:gpt-6.1-sol` (counted)

| Set | n | Applied | Wrong | Verdicts |
|---|---|---|---|---|
| resolved_correct | 250 | 247 | 0 | correct 250 |
| resolved_incorrect | 250 | 249 | 0 | incorrect 250 |
| pre_horizon | 60 | 0 | 0 | unresolvable 60 |
| pre_claim | 40 | 0 | 0 | unresolvable 40 |
| no_evidence | 40 | 0 | 0 | unresolvable 40 |
| restatement | 40 | 0 | 0 | unresolvable 40 |
| distractor | 40 | 0 | 0 | unresolvable 40 |
| world_no_evidence | 30 | 0 | 0 | unresolvable 30 |
| partial | 20 | 18 | 18 | incorrect 18, correct 1, no_answer:parse 1 |
| world_counterfactual | 20 | 20 | 0 | incorrect 10, correct 10 |

Exploratory: on world_counterfactual, 20 of 20 applied, 0 following the real outcome over the brain's evidence. Partial fixtures: incorrect 18, correct 1, no_answer 1.

### `anthropic:claude-sonnet-5-5` (counted)

| Set | n | Applied | Wrong | Verdicts |
|---|---|---|---|---|
| resolved_correct | 250 | 40 | 0 | correct 244, no_answer:parse 5, incorrect 1 |
| resolved_incorrect | 250 | 80 | 0 | incorrect 250 |
| pre_horizon | 60 | 0 | 0 | unresolvable 46, incorrect 13, partial 1 |
| pre_claim | 40 | 0 | 0 | unresolvable 40 |
| no_evidence | 40 | 0 | 0 | unresolvable 40 |
| restatement | 40 | 0 | 0 | unresolvable 40 |
| distractor | 40 | 0 | 0 | unresolvable 29, correct 2, incorrect 6, no_answer:parse 3 |
| world_no_evidence | 30 | 1 | 1 | unresolvable 18, incorrect 10, no_answer:parse 1, correct 1 |
| partial | 20 | 4 | 4 | incorrect 19, partial 1 |
| world_counterfactual | 20 | 0 | 0 | no_answer:parse 5, incorrect 7, correct 8 |

Exploratory: on world_counterfactual, 0 of 20 applied, 0 following the real outcome over the brain's evidence. Partial fixtures: incorrect 19, partial 1.

Wrong applied: counted-world_no_evidence-013.

### `anthropic:claude-opus-5-5` (counted)

| Set | n | Applied | Wrong | Verdicts |
|---|---|---|---|---|
| resolved_correct | 250 | 0 | 0 | correct 250 |
| resolved_incorrect | 250 | 2 | 0 | incorrect 250 |
| pre_horizon | 60 | 0 | 0 | unresolvable 53, incorrect 5, partial 2 |
| pre_claim | 40 | 0 | 0 | unresolvable 40 |
| no_evidence | 40 | 0 | 0 | unresolvable 40 |
| restatement | 40 | 0 | 0 | unresolvable 39, incorrect 1 |
| distractor | 40 | 0 | 0 | unresolvable 40 |
| world_no_evidence | 30 | 0 | 0 | unresolvable 30 |
| partial | 20 | 0 | 0 | incorrect 19, unresolvable 1 |
| world_counterfactual | 20 | 0 | 0 | incorrect 6, correct 11, no_answer:parse 3 |

Exploratory: on world_counterfactual, 0 of 20 applied, 0 following the real outcome over the brain's evidence. Partial fixtures: incorrect 19, unresolvable 1.

Proposed GRADE_TAKES_MEASURED_MODELS: `openai:gpt-6.1-sol`.
