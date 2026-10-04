# Preregistration: the `auto_chronicle` rerun on gbrain's date-quality fix (2026-10-04)

Frozen on October 4, 2026, in its own commit, before any run at the gbrain commit below. It reuses the [original preregistration](2026-10-04-auto-chronicle-lift-preregistration.md) and changes only what this file states.

## The question

The [off-versus-on experiment](2026-10-04-auto-chronicle-lift.md) at gbrain `739e5cc` found that automatic event extraction recorded planned follow-ups as events on their future dates and put vague past dates on specific days (ledger entries CL-1 and CL-2), failing gbrain's accuracy gate at 0.96 wrong events per judged labeled page. gbrain PR [#6010](https://github.com/garrytan/gbrain/pull/6010) (branch `capy/chronicle-date-quality`, head `5a44025816a00f3ee645cd094e614df43f97cbd9`, v0.60.49.0, not merged when this was written) tells the judge to return only what happened and drops any proposal dated after the page's own day (`future_dated`) or without a real day (`date_imprecise`). Is default-on supported at `5a44025`?

## What runs

- **Code under test:** gbrain `5a44025`, loaded as a copied overlay (`eval/runner/chronicle-lift.ts run --gbrain <checkout>@5a44025`). The `package.json` pin stays at `739e5cc`.
- **Same corpus, labels, rubric and settings** as the original: amara-life-v1 rendered by `renderCorpus` (digest `1f7df155a5776e498d5439f67cb8dbe1785dc32479ab58c684340af368508625`), the 38 labeled events in `eval/data/chronicle-lift-v1/gold-events.json`, `chronicle.auto_recent_days 365`, `chronicle.auto_settle_seconds 0`, keyword-only search, gbrain's default chat model as the judge.
- **Arms:** two new independent ON brains (ON-A and ON-B) at `5a44025`. The OFF arm is the existing one from the original run (0 judged pages, 0 events at `739e5cc`); with `auto_chronicle false` the fix has nothing to act on.
- **No agent-question arm.** At the original run's cost (about $7.40 for 72 runs on one ON brain) it does not fit this run's $5 budget. The original downstream result stands as measured at `739e5cc` and is not re-measured here.
- **Hand review:** every unmatched event on a labeled page dated on or before its page date, and the Slack sample (25 non-premature events per ON brain, Mulberry32 seed 4), classified with the original rubric. Events whose slug already appears in the original `review.json` keep that classification; new slugs are reviewed against their page.

## The decision rule

On **each** of the two ON brains:

- **Gate A, accuracy:** false plus premature events at most 0.20 per judged labeled page (28 pages), as before.
- **Recall:** within 3 points of the original ON runs, read as no lower than 3 points below the lower of them (35 of 38, 92.1%): at least 89.1%, so at least 34 of 38. Higher recall passes.
- **Gate B, scope:** 0 of the 96 control pages judged.
- **Gate C, cost:** metered cost per judged page at most $0.25.

**Default-on is supported at `5a44025`** when all four hold on both ON brains. Otherwise it is **not supported**, and the failing rule is named. The original rule's downstream criterion (D) is not part of this decision; the report restates its `739e5cc` result beside the verdict.

## Ledger

If the rule passes, CL-1 and CL-2 become `fixed`, with `fixing_pr` garrytan/gbrain#6010 and the review noting "verified at PR head 5a44025, pending merge" while the PR is open. A rerun after the merge records the merge commit. If the rule fails, both stay open with this run as their review.

## Budget

Up to $5 in one budget-ledger run. Expected: about $1.10 (two ON brains at about $0.55 each, as in the original).
