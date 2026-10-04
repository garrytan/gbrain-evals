# Cat 40 follow-ups: the gbrain cost wave on the fixed harness

These runs are described in the plan `docs/plans/2026-10-03-cat40-followups/PLAN.md` and its gate decisions. All of
them used one SQLite budget ledger capped at $237, and all of them used the gbrain arm only, the starter surface
and uncapped tool results. Spend was $179.66, recorded in the ledger.

| Folder | What | gbrain build | Cells |
|---|---|---|---|
| `slots-dev` | dev-world brains built by the C1+C2 build, with operator ANALYZE | `abc3182e2` | |
| `dev1` | dev round 1: lean rows and compact JSON (C1+C2) | `abc3182e2` | 150 |
| `latency` | harness and isolated replay of 40 dev-round-1 calls | `abc3182e2` | |
| `dev-base` | the same dev round on master, the base the wave is built on | `109b99217` | 150 |
| `dev2` | dev round 2: plus schema budgets and notice ceilings (C1–C4) | `ea851b39b` | 150 |
| `dev-566a242a-E`, `slots-echeck` | renewal briefs (family E) on v0.60.35.0 | `566a242a` | 29 (one stopped at its budget) |
| `dev-51a30c1-E` | renewal briefs on the fix-wave build, ad7900d brains (the correction check) | `51a30c1` | 30 |
| `slots-holdout`, `slots-control` | held-out brains, no operator ANALYZE | `a714410a5`, `566a242a` | |
| `holdout` | held-out world, 6 models × 2 repeats, the wave | `a714410a5` | 600 |
| `control` | the same on v0.60.35.0 (gate UC2) | `566a242a` | 600 |

The `holdout/ship-rule.md` file is the output of `holdout_stats.py holdout control --ship-rule
gbrain-c1234-holdout,gbrain-566a242a-control`. Results and the correction are in the Cat 40 report.
Machine paths are redacted to `<work>`, `<evals>`, `<gbrain>` and `<home>`.
