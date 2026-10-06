# Held-out verdicts (custodian aggregates)

Each file is the aggregate verdict of one preregistered held-out decision, written by the custodian (P0) after the
sealed run. Raw sealed rows, held-out phrasings, seeds' generated text and labels stay in custody and are not
published. Comparators are named by kind only.

| File | Decision | Verdict |
|---|---|---|
| `p1-e1-heldout-2026-10-04.json` | P1 temporal edges E1, round 1 (phrasing set B) | fail (traps 101/115) |
| `p1-e1-r2-heldout-2026-10-04.json` | P1 temporal edges E1, round 2 (set C) | pass |
| `p1-e1-sete-2026-10-05.json` | P1 temporal edges E1 on a third phrasing set (second custodian) | fail (traps 89/105; lexicon misses the set's join, leave and move cues) |
| `p1-e2-r2-heldout-2026-10-04.json` | P1 contradiction phase E2, five judge models | all certified for apply |
| `p1-e3-r2-heldout-2026-10-04.json` | P1 ingestion to answer E3 | report-only |
| `p3-e1-heldout-2026-10-04.json` | P3 retrieval feedback E1, per corpus | world-v1 checks pass except one category; LoCoMo fail |
| `p3-e4-heldout-2026-10-04.json` | P3 triplet scoring E4 | fail (precondition: arm fired on 17%) |
| `p3-e5-heldout-2026-10-05.json` | P3 declared single-value relations E5 | fail (3 wrong closures) |
| `p3-e5-setf-retest-2026-10-05.json` | P3 E5 retest on fresh material (second custodian), guard vs no guard | guard: all gates pass, 0 closures applied (power precondition not met); no guard: 23 of 23 closures wrong |
| `p4-pressure-heldout-2026-10-05.json` | P4 pre-compaction save notice, pressure gate (BEAM-500K sealed) | pass (+11.35 points [+8.3, +14.4]) |
| `p7-heldout-2-2026-10-04.json` | P7 multi-relation planner, N9 v1 second opening | pass |
| `p8-write-cost-2026-10-05.json` | P8 write cost (gate: zero commit-path generative attempts) | pass |
| `p8-withdraw-heldout-2026-10-05.json` | P8 semantic withdrawal review | pass |
| `p8-quotes-heldout-2026-10-05.json` | P8 quote grounding, first sealed run | fail (Wilson upper 7.6% > 5%) |
| `p8-quotes-rerun-2026-10-05.json` | P8 quote grounding, second-custodian rescore with the fixed scorer; root causes; sealed-v2 exposure; voided v2 retest | fail stands (16/319) |
| `p8-quotes-retest2-2026-10-05.json` | P8 quote grounding retest on custodian-written synthetic sessions | pass (5/321, Wilson upper 3.59%) |
| `p8-surface-heldout-2026-10-05.json` | P8 advertised tool surface (Cat 40 sealed world) | fail in both narrower arms; `full` stays |

The table lists the verdicts of plans whose gbrain pull requests have merged (P1, P3, P4, P7, P8). Each plan still in progress (P2, P5, P6) lists its own verdict files on its page under [`../2026-10-05-heldout-program/`](../2026-10-05-heldout-program/), and they move into this table when its gbrain pull request merges. The [program report](../2026-10-05-heldout-program.md) puts these verdicts beside each plan's preregistration, development results and default.
