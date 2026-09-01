# Cat 34 — BrainBench memory conformance

gbrain 0.47.8.0 (`2a56b5123685`) · fixtures `509fd20d7cda` · gate mode · verdict fail · subprocess exit 0

| harness | seam | suite | failed/gold | headline |
|---|---|---|---|---|
| openclaw | production | know-to-ask | 0/149 | know_to_ask_failure_rate=0 |
| openclaw | production | push | 9/96 | push_recall=0.9063 |
| openclaw | production | write-back | 0/58 | write_back_fidelity=1 |
| openclaw | production | continuity | 0/12 | continuity_rate=1 |
| claude-code | production | know-to-ask | 0/149 | know_to_ask_failure_rate=0 |
| claude-code | production | push | 0/96 | push_recall=1 |
| claude-code | production | write-back | 0/58 | write_back_fidelity=1 |
| claude-code | production | continuity | 0/12 | continuity_rate=1 |
| codex | contract | know-to-ask | 0/149 | know_to_ask_failure_rate=0 |
| codex | contract | push | 43/96 | push_recall=0.5521 |
| codex | contract | write-back | 0/58 | write_back_fidelity=1 |
| codex | contract | continuity | 0/12 | continuity_rate=1 |

Full per-turn rows in `result.json`; methodology: gbrain `docs/eval/BRAINBENCH.md`.
