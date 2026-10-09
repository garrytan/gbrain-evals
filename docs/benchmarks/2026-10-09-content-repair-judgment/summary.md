| Model | Hard failures | True-duplicate accuracy | needs_human rate | No answer | USD per pair | Latency p50 / p95 | Qualifies |
|---|---|---|---|---|---|---|---|
| `anthropic:claude-opus-5-5` | 0/144 | 69/75 (92.0%) [83.6, 96.3] | 18.8% | 0 | $0.0088 | 3.0 s / 6.4 s | yes |
| `openai:gpt-6.1-sol` | 0/144 | 64/75 (85.3%) [75.6, 91.6] | 20.1% | 0 | $0.0022 | 2.7 s / 7.3 s | yes |
| `anthropic:claude-sonnet-5-5` | 0/144 | 60/75 (80.0%) [69.6, 87.5] | 24.3% | 0 | $0.0033 | 1.6 s / 2.4 s | yes |

Per set (pair runs; `merge` / `remove` / `human` / `none` are the model's answers; a hard failure is a `remove` on a true duplicate or a `merge` elsewhere, or a merge into the wrong canonical):

| Model | True duplicates (merge right / wrong canonical / remove / human / none) | Stray slugs (remove / merge / human / none) | Adversarial (remove / merge / human / none) | Ambiguous (human / guessed / none) |
|---|---|---|---|---|
| `anthropic:claude-opus-5-5` | 69 / 0 / 0 / 6 / 0 of 75 | 30 / 0 / 0 / 0 of 30 | 18 / 0 / 6 / 0 of 24 | 15 / 0 / 0 of 15 |
| `openai:gpt-6.1-sol` | 64 / 0 / 0 / 11 / 0 of 75 | 30 / 0 / 0 / 0 of 30 | 21 / 0 / 3 / 0 of 24 | 15 / 0 / 0 of 15 |
| `anthropic:claude-sonnet-5-5` | 60 / 0 / 0 / 15 / 0 of 75 | 30 / 0 / 0 / 0 of 30 | 19 / 0 / 5 / 0 of 24 | 15 / 0 / 0 of 15 |

Rule: zero hard failures and true-duplicate accuracy at least 80.0%; `needs_human` is always acceptable. Brackets are Wilson 95% intervals in percent. Proposed `CONTENT_REPAIR_MEASURED_MODELS`: `anthropic:claude-opus-5-5`, `openai:gpt-6.1-sol`, `anthropic:claude-sonnet-5-5`.
