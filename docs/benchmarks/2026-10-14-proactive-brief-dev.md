# The proactive brief on Cat 40 family P: development phase (wave 5 D6)

The proactive brief showed no improvement signal on the development seeds. With the brief on, agents finished 70 of
72 paired tasks; with it off, also 70 of 72. The paired difference is 0 points (95% interval −5.5 to +5.5), and two of
the four discordant pairs came from provider errors. This is development evidence only. It does not decide whether the
brief ships on by default; only D6's sealed phase can, and that phase is out of scope here.

The rules were frozen in the
[preregistration](2026-10-14-proactive-brief-dev-preregistration.md) (commit `6aa12098`, pushed before any paid
cell). They ran on gbrain v0.60.240.0 (`1355f32f`) with the T0 carrier. The arms were `brief-off`, the release default,
and `brief-on`, with `context.proactive_brief` set to true after every restore. Six new development personas (seeds
20261201 to 20261206) gave 24 tasks. Three readers ran each task once per arm: Opus 5.5, Sonnet 5.5 and gpt-6.1-sol.
That is 144 cells, every one ending in a scored record with no harness errors. The run directory is
[`2026-10-14-proactive-brief-dev/development/`](2026-10-14-proactive-brief-dev/development/). Its `brief-summary.json`
holds every number below, computed by `eval/runner/t0/brief.ts`.

## Decision rule

The label is **no improvement signal (development evidence only)**. Two of the five preregistered checks fail:

| Check | Result | Passes |
|---|---|---|
| Pooled paired success difference, 95% lower bound above 0 | 0 points, interval −5.5 to +5.5 (72 pairs, 6 persona clusters) | no |
| Paid-arm guard: no brief in a brief-off cell, and the brief missed in at most 10% of brief-on cells | 72 of 72 brief-off cells silent; the brief missed in 14 of 72 brief-on cells (19.4%) | no |
| Attention: every session-2 brief block at or under 1,800 characters | 397 at most, 339 on average when it fired | yes |
| False pushes at most 0.05 per brief-on session | 0 false pushes in 58 items | yes |
| No rise in confident-wrong cells | 1 in each arm | yes |

The preregistration predicted this outcome before any spend. Both arms already inject the session-1 facts through the
UserPromptSubmit "Hot memory (recent facts)" block, and this release's brief adds one of those facts again: the newest
fact about the contact.

## Primary: paired task success (t0-score-v3)

| Reader | Brief off | Brief on | Paired difference (95% interval) | Discordant pairs (on only / off only) |
|---|---|---|---|---|
| All three | 70/72 | 70/72 | 0 points (−5.5 to +5.5) | 2 / 2 |
| Opus 5.5 | 23/24 | 24/24 | +4.2 points (−6.5 to +14.9) | 1 / 0 |
| Sonnet 5.5 | 24/24 (ceiling) | 23/24 | −4.2 points (−14.9 to +6.5) | 0 / 1 |
| gpt-6.1-sol | 23/24 | 23/24 | 0 points (−16.6 to +16.6) | 1 / 1 |

All four discordant pairs:

- Opus 5.5 on task p20261201-t3 succeeded with the brief on. Its brief-off cell ended in a provider error ("socket
  connection was closed") before it delivered an answer.
- gpt-6.1-sol on task p20261203-t4 succeeded with the brief on. With the brief off it missed the commitment and stated
  the old date and the pre-correction value.
- Sonnet 5.5 on task p20261203-t4 succeeded with the brief off. Its brief-on cell ended in a provider timeout.
- gpt-6.1-sol on task p20261206-t1 succeeded with the brief off. With the brief on it named the namesake's value
  (`unsupported`).

By task kind, prep was 34/36 in both arms and reply was 36/36 in both arms. Sonnet 5.5 is at the ceiling in the brief-off
arm (24/24), so it cannot show a gain. Under the secondary scorer `t0-score-v2`, brief-off scored 69/72 and brief-on
68/72. The extra `t0-score-v2` failures are disambiguations that v3 excuses.

## Paid-arm guard

The brief never appeared in a brief-off cell (72 of 72 silent), so the arms were what they claimed. In brief-on cells it
fired in session 2's UserPromptSubmit 58 times out of 72. All 14 misses were Sonnet 5.5 sessions in which session 1
updated pages (`put_page`, `edit_page`) and never called `remember`. That left the brain with no fact about the contact,
so the brief had nothing to push. In the same sessions, hot memory was empty for the same reason.

The brief fired in 58 of the 58 brief-on cells where session 1 saved a fact on the contact's page. Across both arms,
Opus 5.5 called `remember` in session 1 in 48 of 48 cells, gpt-6.1-sol in 47 of 48 and Sonnet 5.5 in 24 of 48.

This is a product finding as well as a guard result. On v0.60.240.0 the brief reaches only facts. A reader that records
a call by editing pages gets no brief, and this release's write path did not turn those page edits into facts before
session 2. The 10% guard ceiling was frozen before the run, so the check fails as written.

## Diagnostics

| Diagnostic | Brief off | Brief on |
|---|---|---|
| Brief items pushed in session 2 | 0 | 58, one per fired session |
| False pushes (stale, namesake, another counterparty, or no needed fact) | 0 | 0 |
| False pushes per session (each session 2 is one simulated day, so per day too) | 0 | 0 |
| Uptake: needed facts carried by relevant brief items that the deliverable states | n/a | 91 of 93 (97.8%); the paired brief-off deliverables stated 89 of the same 93 (95.7%) |
| Opportunity recall of the brief, over 216 needed facts (3 per task) | 0 | 93 of 216 (43.1%) |
| Opportunity recall of all session-2 injected context, hot memory included | 78.2% | 76.9% |
| Confident-wrong cells (`stale_date`, `stale_correction`, `unsupported`) | 1 | 1 |
| Session-2 tool calls per task | 6.10 | 5.94 |
| Session-2 input tokens per task | 48,842 | 49,802 |
| Input tokens per cell, both sessions | 145,027 | 145,869 |
| Dollars per cell | $0.190 | $0.179 |

The brief's opportunity recall stays below 50% even when it fires, because it carries one item and every task needs
three facts. Per reader, the brief carried 58.3% of needed facts for Opus 5.5, 48.6% for gpt-6.1-sol and 22.2% for
Sonnet 5.5. All injected context carried at least 94% for Opus 5.5 and gpt-6.1-sol in both arms. For Sonnet 5.5 it
carried 43.1% with the brief off and 36.1% with it on, because half its sessions saved no facts.

Uptake was high in both arms. This shows the readers state these facts whether or not the brief repeats them. Uptake
alone never satisfies the decision rule.

## What the result means

On this workload and release, turning the brief on did not change task success, tool calls or tokens enough to show,
and it caused no harm: no false pushes, no rise in confident-wrong answers, and at most 397 characters. The brief can
only help where hot memory does not already carry the fact. That happens when the fact is older than hot memory's
24-hour window, when hot memory is crowded with other facts, or when the item is an open loop from mail or calendar.
None of these occur in the T0 carrier. A sealed run of this same design would most likely repeat the null result. The
preregistration requires a written redesign before any sealed spend on D6.

## Spend

The new D6 ledger (cap $45) committed $27.85 over 2,950 paid requests. Ledger run:
`d6-proactive-brief-dev-2026-10-15T04-45-39-722Z-35cdb791`, now closed. Reader cost in the cells was $26.56 ($13.69
brief-off, $12.87 brief-on), and gbrain's internal calls cost $0.04. The rest is ledger-side spend outside the cells:
the persona builds, the reranker probes, and three requests charged at their reservation because the provider returned
no usage.

## Records

- `development/experiment.json`: the build, its verification, the arms, the seeds and the preregistration attestation
  (commit `6aa12098`).
- `development/results.jsonl.gz`: one record per cell, with the brief block, guard, item classes, `t0-score-v3` and `t0-score-v2`.
- `development/usage.jsonl.gz`: provider usage receipts for every attempt.
- `development/receipt.json`, `development/brief-summary.json` and the ledger cost receipt.
- `hermetic/`: the $0 scripted slice on seed 20261201 that proves the plumbing. The brief fired in 4 of 4 brief-on
  cells and was silent in 4 of 4 brief-off cells.

Rerun the analysis with
`bun eval/runner/t0/brief.ts <(gunzip -c docs/benchmarks/2026-10-14-proactive-brief-dev/development/results.jsonl.gz)`.
