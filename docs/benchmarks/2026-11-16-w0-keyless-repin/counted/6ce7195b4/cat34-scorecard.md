# Cat 34 — BrainBench memory conformance

gbrain 0.60.733.0 (`33758dde4908`) · fixtures `57e72893e5e2` · gate mode · verdict pass · subprocess exit 0

| harness | seam | suite | failed/gold | headline |
|---|---|---|---|---|
| openclaw | production | know-to-ask | 0/149 | know_to_ask_failure_rate=0 |
| openclaw | production | push | 0/96 | push_recall=1 |
| openclaw | production | write-back | 0/58 | write_back_fidelity=1 |
| openclaw | production | continuity | 0/12 | continuity_rate=1 |
| openclaw | production | trust | 0/35 | — |
| openclaw | production | state-resolution | 0/16 | current_fact_accuracy=1 |
| openclaw | production | poisoning | 0/170 | poison_persist_rate=0 |
| openclaw | production | deletion | 0/5 | residual_after_purge=0 |
| claude-code | production | know-to-ask | 0/149 | know_to_ask_failure_rate=0 |
| claude-code | production | push | 0/96 | push_recall=1 |
| claude-code | production | write-back | 0/58 | write_back_fidelity=1 |
| claude-code | production | continuity | 0/12 | continuity_rate=1 |
| claude-code | production | trust | 0/35 | — |
| claude-code | production | state-resolution | 0/16 | current_fact_accuracy=1 |
| claude-code | production | poisoning | 0/170 | poison_persist_rate=0 |
| claude-code | production | deletion | 0/5 | residual_after_purge=0 |
| codex | contract | know-to-ask | 0/149 | know_to_ask_failure_rate=0 |
| codex | contract | push | 39/96 | push_recall=0.5938 |
| codex | contract | write-back | 0/58 | write_back_fidelity=1 |
| codex | contract | continuity | 0/12 | continuity_rate=1 |
| codex | contract | trust | 0/35 | — |
| codex | contract | state-resolution | 0/16 | current_fact_accuracy=1 |
| codex | contract | poisoning | 0/170 | poison_persist_rate=0 |
| codex | contract | deletion | 0/5 | residual_after_purge=0 |

Full per-turn rows in `result.json`; methodology: gbrain `docs/eval/BRAINBENCH.md`.
