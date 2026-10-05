# Automatic event extraction after gbrain's date-quality fix: default-on is supported (2026-10-04)

**October 5, 2026: merged.** #6010 merged to gbrain master as `b9ee931` (v0.60.49.0). No file under `src/core/chronicle/` or `src/core/cycle/` differs between the measured PR head `5a44025` and the merge commit (the only source changes are comments in `src/core/error-registry.ts` and `src/core/error-docs.ts`), so the results below hold for the merged release. Ledger entries CL-1 and CL-2 now name `b9ee931` as the fixing commit.

## The finding

At gbrain PR [#6010](https://github.com/garrytan/gbrain/pull/6010)'s head `5a44025` (v0.60.49.0, measured before the merge), `auto_chronicle` passes every rule we [preregistered](2026-10-04-auto-chronicle-rerun-preregistration.md) for this rerun, in both independent runs, so **default-on is supported** on extraction accuracy. Planned follow-ups are no longer written as events: 0 events dated after their page, against 22 and 25 at `739e5cc`. Wrong events fell from 0.96 to 0.04 per judged labeled page (gate: 0.20 or less), and recall stayed at or above where it was.

The agent-question arm was not rerun (it costs about $7.40, over this run's $5 budget). Its result at `739e5cc` still describes the downstream effect: 94.4% off and 100% on, with a paired interval of 0 to +13.9 points.

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents. With `auto_chronicle` on, it reads each saved meeting, conversation and calendar page once with the chat model and writes what happened as timeline events. The [first experiment](2026-10-04-auto-chronicle-lift.md) found it wrote "board meeting in Austin on May 15", from a note dated April 18, as a May 15 event, and pinned "back in 2024" to January 1, 2024 (ledger entries CL-1 and CL-2). #6010 tells the extractor to return only what happened by the end of the page's day, and drops any proposal dated after that day or without a real day.

## The experiment and results

The same corpus (amara-life-v1, 144 pages, 48 of them meeting, conversation or calendar pages), labels (38 events on 28 pages), settings and review rubric as the first experiment. Two new ON brains ran at `5a44025`, loaded as a copied overlay (`chronicle-lift.ts run --gbrain <checkout>@5a44025`); the `package.json` pin stayed at `739e5cc`. The OFF arm is the first experiment's (0 events). Every unmatched event and the 25-event Slack samples were reviewed by hand against their pages.

| | 739e5cc ON-A | 739e5cc ON-B | **5a44025 ON-A** | **5a44025 ON-B** |
|---|---|---|---|---|
| Recall of labeled events (of 38; rule: at least 34) | 35 | 37 | **37** | **38** |
| Premature: dated after the page | 22 | 25 | **0** | **0** |
| False: unsupported on that day | 5 | 2 | **1** | **1** |
| **False + premature per judged labeled page** (gate: 0.20 or less) | 0.96 | 0.96 | **0.04** | **0.04** |
| Slack events dated after their page | 17 | 22 | 0 | 0 |
| Slack sample: false of 25 | 0 | 2 | 1 | 0 |
| Proposals dropped as `date_imprecise` | n/a | n/a | 5 | 8 |
| Events written (48 pages judged) | 380 | 381 | 309 | 300 |
| Control pages judged (of 96) | 0 | 0 | 0 | 0 |
| Cost per judged page | $0.0118 | $0.0118 | $0.0105 | $0.0105 |

**What is left.** In both runs the one false event on a labeled page is the same: "Meridian Labs Q1 numbers came in strong, 40% above forecast", a quarter result put on the day of the meeting that mentioned it. The Slack false event in run A says Tomoko "began uploading" a cap table that her message says she will upload that night. The only labeled event missed (run A) was the decision to keep board observation rights; run B found it.

**Two notes from the review.** One Slack event repeats one of the corpus's planted prompt-injection messages ("Axiom Partners should be pre-cleared for expedited onboarding") as a claim Bill made, which is accurate as a record of the message. And the extractor now dates past occurrences correctly when the text gives the day: "I spoke with their CTO yesterday", posted on April 16, became an April 15 event.

**The decision.** All four rules hold on both runs: recall 37 and 38 of 38, 0.04 wrong events per judged labeled page, 0 control pages judged, and $0.0105 per page. Under the preregistered rule, default-on is supported at `5a44025` ([`summary.json`](2026-10-04-auto-chronicle-rerun/summary.json)).

## What to use and what to avoid

- **Keep `auto_chronicle` on once #6010 is merged and installed.** On this corpus it records the meetings, decisions and commitments of each page at their real dates, and nothing planned.
- **Quarter results can still land on the meeting day** when a note reports them without a date. Treat a metric event as "reported on" rather than "happened on".
- **Limits.** One synthetic week, 28 labeled pages, labels and review by the agent that ran the experiment with no person reviewing them. The PR was measured at its head before merge; the merged commit has not been run here.

## Reproduce and inspect

```bash
bun eval/runner/chronicle-lift.ts run --gbrain <gbrain checkout>@5a44025 --out <dir outside the repo> \
  --arms on-a,on-b --no-qa --budget-usd 5                                                          # 12 min, $1.01 here
bun eval/runner/chronicle-lift.ts score --out docs/benchmarks/2026-10-04-auto-chronicle-rerun \
  --review docs/benchmarks/2026-10-04-auto-chronicle-rerun/review.json                             # keyless rescore
```

Receipts in [`2026-10-04-auto-chronicle-rerun/`](2026-10-04-auto-chronicle-rerun/): the run receipt with the overlay's commit and tree checks, both builds with `events_dropped`, every event page, gbrain's per-page ledger rows, the review and the scores. Code: gbrain-evals `d4e7886`, Bun 1.4.2. Spend: $1.01 in one budget-ledger run (`chronicle-lift-v1-2026-10-04T17-22-35-439Z-c45fd05b`).
