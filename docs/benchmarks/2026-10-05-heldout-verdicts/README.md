# Held-out verdicts (custodian aggregates)

Each file is the aggregate verdict of one preregistered held-out decision, written by the custodian (P0) after the
sealed run. Raw sealed rows, held-out phrasings, seeds' generated text and labels stay in custody and are not
published. Comparators are named by kind only.

| File | Decision | Verdict |
|---|---|---|
| `p1-e1-heldout-2026-10-04.json` | P1 temporal edges E1, round 1 (phrasing set B) | fail (traps 101/115) |
| `p1-e1-r2-heldout-2026-10-04.json` | P1 temporal edges E1, round 2 (set C) | pass |
| `p1-e2-r2-heldout-2026-10-04.json` | P1 contradiction phase E2, five judge models | all certified for apply |
| `p1-e3-r2-heldout-2026-10-04.json` | P1 ingestion to answer E3 | report-only |
| `p3-e1-heldout-2026-10-04.json` | P3 retrieval feedback E1, per corpus | world-v1 checks pass except one category; LoCoMo fail |
| `p3-e4-heldout-2026-10-04.json` | P3 triplet scoring E4 | fail (precondition: arm fired on 17%) |
| `p3-e5-heldout-2026-10-05.json` | P3 declared single-value relations E5 | fail (3 wrong closures) |
| `p7-heldout-2-2026-10-04.json` | P7 multi-relation planner, N9 v1 second opening | pass |

This folder holds the verdicts of plans whose gbrain pull requests have merged (P1, P3, P7). Verdicts of plans still in progress (P2, P4, P5, P6, P8) are added as each gbrain pull request lands. The [program report](../2026-10-05-heldout-program.md) puts these verdicts beside each plan's preregistration, development results and default.
