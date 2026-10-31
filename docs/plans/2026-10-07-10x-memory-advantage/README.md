# Build the 10x memory advantage (2026-10-07)

**Superseded. Landed on main as a record on 2026-10-31.** The plan was last updated on 2026-10-17, when wave 4b
closed and wave 6 was next. Its thread, GBRA-60, ended on 2026-10-27, and its pull request,
[#97](https://github.com/garrytan/gbrain-evals/pull/97), was closed unmerged on 2026-10-29 as "superseded by the
approved memory-wave plans". Those plans are not in this repository. Nothing in this folder is current: no wave, cap or
gate below runs from it. For what gbrain does today and every result since, start at the [docs index](../../README.md).
Wave 6 was to extend the Q1 head-to-head scoreboard, which was published on 2026-10-27
([report](../../benchmarks/2026-10-06-scoreboard-report.md)).

Every file in this folder except this README is copied byte for byte from commit `2b6ff9af` on the branch
`capy/10x-memory-advantage-plan`, which keeps every revision of the plan. Reports and preregistrations on main cite the
plan by that path, that branch or a link into it, as it stood when they were written; their citations are unchanged.
Below this banner, the README is the folder's guide as the branch left it, so its status line is out of date.

This folder records the plan for the next round of gbrain work after the maintainer's brief "Pick the right thing to 10x" (2026-10-07): fewer confident wrong answers, fewer tokens at the same accuracy, cheaper writes and bigger brains, and capabilities no other memory system has. Status: approved by the maintainer on 2026-10-08 (PLAN.md section 10 records each decision). Each wave still runs under its own cap and preregistration.

- [PLAN.md](PLAN.md) is the plan: the premises checked against the evidence, the program-level 10x primary and the bet-level mechanisms under it, a first repair batch (wave 0), a bounded decision pilot (wave 1) and five further waves that are fully scoped but not scheduled, each with its files, gates, budgets and merge-queue sequencing, the next two weeks, and one list of the decisions the maintainer has to make. Its "Review record" holds the gstack autoplan review and the cross-model outside review; an accepted amendment there overrides conflicting text above it.
- [ceo-review-native.md](ceo-review-native.md) and [ceo-review-outside.md](ceo-review-outside.md) are the two CEO-phase reviews copied verbatim: the native independent review (24 findings, 7 user challenges) and the cross-model outside review by GPT-6 Astra (13 findings). The plan's section 11 records what was done with each finding.
- [dx-review-native.md](dx-review-native.md) and [dx-review-outside.md](dx-review-outside.md) are the two DX-phase reviews copied verbatim: the native independent developer-experience review (19 findings, 8 dimension scores, a time-to-hello-world assessment and a 17-item checklist) and the cross-model outside review by GPT-6 Astra (9 findings and a first-hour developer journey). The plan's section 11 "DX phase" records the consensus table, the scores, the journey map and what was done with each finding.
- [eng-review-native.md](eng-review-native.md) and [eng-review-outside.md](eng-review-outside.md) are the two eng-phase reviews copied verbatim: the native independent engineering review (13 findings, a scope challenge grounded in code, an architecture diagram, a codepath-to-test diagram, a failure-modes registry and a merge-collision table verified against the PR file lists) and the cross-model outside review by GPT-6 Astra (18 findings and a 31-row code-claims table). [eng-test-plan.md](eng-test-plan.md) is the native reviewer's test plan: per item, the test that proves it, the forced probe and the regenerate command. The plan's section 11 "Eng phase" records the consensus table, the diagrams, the failure modes, the migration verdict, the merge-queue table, the cross-phase themes and what was done with each finding.
- [audit/](audit/) holds the five read-only audits the plan is built on, run on 2026-10-07 against gbrain master `7aa2caa0` (v0.60.106.0) and gbrain-evals main `f1ce49fe` (v0.10.40): the evidence brief and token budget (A), the head-to-head benchmark, scale curve and cost table (B), belief history, graded takes and living pages (C), the proactive brief and distribution (D), and production scale and the embedding backlog (E). Numbers marked [recount] or [A-calc] in the audits are $0 recounts over committed receipts, not published or preregistered results.

The audits are dated snapshots. Later waves record their verdicts in dated reports under `docs/benchmarks/`, not by editing the audits.
