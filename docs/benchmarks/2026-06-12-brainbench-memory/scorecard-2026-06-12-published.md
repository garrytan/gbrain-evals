# Cat 34 — BrainBench memory conformance

gbrain 0.44.0.0 (`15a9019788d1`) · fixtures `76f201590dd3` · gate mode · exit 0

| harness | seam | suite | failed/gold | headline |
|---|---|---|---|---|
| openclaw | production | know-to-ask | 9/146 | know_to_ask_failure_rate=0.15 |
| openclaw | production | push | 18/94 | push_recall=0.8085 |
| openclaw | production | write-back | 0/58 | write_back_fidelity=1 |
| openclaw | production | continuity | 0/12 | continuity_rate=1 |
| claude-code | contract | know-to-ask | 11/146 | know_to_ask_failure_rate=0.15 |
| claude-code | contract | push | 32/94 | push_recall=0.6596 |
| claude-code | contract | write-back | 0/58 | write_back_fidelity=1 |
| claude-code | contract | continuity | 0/12 | continuity_rate=1 |
| codex | contract | know-to-ask | 9/146 | know_to_ask_failure_rate=0.15 |
| codex | contract | push | 52/94 | push_recall=0.4468 |
| codex | contract | write-back | 0/58 | write_back_fidelity=1 |
| codex | contract | continuity | 0/12 | continuity_rate=1 |

Full per-turn rows in `result.json`; methodology: gbrain `docs/eval/BRAINBENCH.md`.
