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
| `p2-e1-heldout-2026-10-06.json` | P2 hub dampening E1, sealed hub-world seeds 2 and 3, all 12 cells | fail (rivals win on concept; hub-as-answer −10.0 to −36.2) |
| `p2-e2-heldout-2026-10-04.json` | P2 date-grounded extraction E2, sealed LoCoMo | pass (unresolved relative dates 8.95% → 2.05%) |
| `p2-e3-heldout-2026-10-05.json` | P2 speaker attribution E3, sealed synthetic conversations | pass (assistant-said QA 44.1% → 95.8%) |
| `p3-e1-heldout-2026-10-04.json` | P3 retrieval feedback E1, per corpus | world-v1 checks pass except one category; LoCoMo fail |
| `p3-e4-heldout-2026-10-04.json` | P3 triplet scoring E4 | fail (precondition: arm fired on 17%) |
| `p3-e5-heldout-2026-10-05.json` | P3 declared single-value relations E5 | fail (3 wrong closures) |
| `p3-e5-setf-retest-2026-10-05.json` | P3 E5 retest on fresh material (second custodian), guard vs no guard | guard: all gates pass, 0 closures applied (power precondition not met); no guard: 23 of 23 closures wrong |
| `p4-core-heldout-2026-10-06.json` | P4 always-loaded core memory tier, core gate (BEAM-100K sealed, four models) | fail (`gpt-6.1-sol` −2.4 points; `claude-fable-5-1` −2.4) |
| `p4-pressure-heldout-2026-10-05.json` | P4 pre-compaction save notice, pressure gate (BEAM-500K sealed) | pass (+11.35 points [+8.3, +14.4]) |
| `p5-heldout-2026-10-05.json` | P5 first run: H1 link typing, H2 relation lines, H4 forward references, H5a similar-page hint | pass |
| `p5-h3-heldout-2026-10-06.json` | P5 H3 junk audit on minted lines (second custodian, from P0's run) | fail (precision 0/18) |
| `p5-h5b-heldout-2026-10-06.json` | P5 H5b agent-loop duplicates | fail (wrong merges +1.25 points, bar +1) |
| `p5-delta-heldout-2026-10-05.json` | P5 delta at `011bd0b6a`: H10 advisory-role guard on set C (H7 to H9 superseded by the re-frozen run) | H10 pass |
| `p5-delta2-heldout-2026-10-05.json` | P5 delta re-frozen at `970c3088b`: H7 validity ranges, H9 typing changes, N4 guardrail (H8 blocked, rerun below) | pass |
| `p5-h8r-heldout-2026-10-05.json` | P5 delta H8 remote wanted rows (rerun after the sweep fix) | pass |
| `p5-delta-set-g-2026-10-05.json` | P5 H10 re-check and H11, set G | fail |
| `p5-delta-set-h-2026-10-05.json` | P5 H10 re-check and H11, set H (cycle 2) | fail; post-freeze changes removed |
| `p6-think-dates-sealed-locomo-2026-10-06.json` | P6 `think` date frame, sealed LoCoMo | pass (+14.0 points [+11.8, +16.2]) |
| `p7-heldout-2-2026-10-04.json` | P7 multi-relation planner, N9 v1 second opening | pass |
| `p8-write-cost-2026-10-05.json` | P8 write cost (gate: zero commit-path generative attempts) | pass |
| `p8-withdraw-heldout-2026-10-05.json` | P8 semantic withdrawal review | pass |
| `p8-quotes-heldout-2026-10-05.json` | P8 quote grounding, first sealed run | fail (Wilson upper 7.6% > 5%) |
| `p8-quotes-rerun-2026-10-05.json` | P8 quote grounding, second-custodian rescore with the fixed scorer; root causes; sealed-v2 exposure; voided v2 retest | fail stands (16/319) |
| `p8-quotes-retest2-2026-10-05.json` | P8 quote grounding retest on custodian-written synthetic sessions | pass (5/321, Wilson upper 3.59%) |
| `p8-surface-heldout-2026-10-05.json` | P8 advertised tool surface (Cat 40 sealed world) | fail in both narrower arms; `full` stays |
| `q2-heldout-2026-10-08.json` | Q2 parser gaps (P5 follow-up): grammar gates G1–G6 and C-gates, one campaign (second custodian) | G1 and G3 fail, G2, G4, G5 pass, G6 not run; U34 and U1 confirmed, U25 and U6 reverted |

The table lists the verdicts of plans whose gbrain pull requests have merged (P1, P2, P3, P4, P5, P6, P7, P8), and Q2, whose verdicts precede its merge. Each plan's page under [`../2026-10-05-heldout-program/`](../2026-10-05-heldout-program/) explains its verdicts. The [program report](../2026-10-05-heldout-program.md) puts these verdicts beside each plan's preregistration, development results and default.
