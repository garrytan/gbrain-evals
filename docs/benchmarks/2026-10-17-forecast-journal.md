# Forecast journal: the private journal ranks holders in their true order and counts every open prediction

**Measured October 17, 2026, at gbrain [`65ed40ec6`](https://github.com/garrytan/gbrain/commit/65ed40ec6055a356f88405994ddf6aabfe643d62) (branch `capy/w7-forecast-journal`, wave 4b W7), the commit that froze the [preregistration](2026-10-17-forecast-journal-preregistration.md), and rerun unchanged at the release.**

**Shipped in gbrain v0.60.286.0** ([#6886](https://github.com/garrytan/gbrain/pull/6886), merge commit `d28cbaeee`, recorded in [`verdict.json`](2026-10-17-forecast-journal/verdict.json)).

[gbrain](https://github.com/garrytan/gbrain) keeps a person's forecasting takes as rows on their pages. W7 gives the brain's owner a private forecast journal over them: each prediction with its prediction time, its horizon (the last day it can come true), its state (open, overdue, resolved or undated) and its resolution, plus `takes_scorecard {group_by, min_n}` with per-holder or per-source statistics. All of it is trusted local only: a remote caller that asks for `group_by` or `min_n` is refused with `scorecard_group_by_local_only`, and what remote callers already get is unchanged. This $0 synthetic gate checks that the journal ranks holders of known skill in their true order, answers "who was right about T", keeps the unresolved denominator, and stays invisible to remote callers.

## The finding

- **The gate passes on every criterion.** The median Spearman ρ between true skill and shrunk accuracy is **0.905** (bar 0.80; 18 of 20 cohorts at 0.80 or more, the lowest 0.741 and 0.748). Who-was-right set-F1 is **1.000** (bar 0.95). Journal totals, per-holder counts, `low_n` flags and the labelling of every prediction time as an uncertified `since_date` all match the gold counts exactly. All **8 of 8** remote probes pass.
- **Shrinkage neither helps nor hurts the median order here.** Raw accuracy also has a median ρ of 0.905. Shrinkage changes ρ in 13 of 20 cohorts, by −0.084 to +0.035. These holders have 10 to 30 resolved predictions each, so they differ less in sample size than a real brain's would. Shrinkage matters most for holders with few resolved predictions, and those are flagged `low_n` and kept out of ρ.
- **Set-F1 and the exact counts are a ceiling.** The journal reads the resolutions it was given, so these criteria guard against regressions rather than measure something hard. The ranking criterion is the only one with sampling noise, and the plan calls it a diagnostic: it tests whether shrinkage keeps the true order through noise, not whether any real person is ranked well. Ranking real people stays deferred behind an independently adjudicated gate.

## The experiment

**Code under test.** gbrain `65ed40ec6`, through the production readers and op handlers: `scorecardGroups` and `readForecastJournal` in `src/core/forecast-journal.ts`, the `takes_list`, `takes_search` and `takes_scorecard` op handlers with a remote context, and the stated-horizon scan (`scanStatedHorizons {apply: true}`, as `gbrain takes horizon scan --apply` does).

**Fixtures.** `fixtures.ts`, seed 20261017, sha256 `ad271efc…`: 20 cohorts, each on its own source, with 12 holders of known skill 0.30 to 0.90 (10 to 30 resolved predictions each), 2 low-n holders (4 resolved each), one overdue and one open prediction per holder, and one undated take per cohort, over 40 topic pages. 5,622 predictions in all; the horizon scan wrote 5,602 horizons and left the 20 undated takes without one. Every holder and page is a placeholder (`holder-NN-example`, `companies/topic-NNN-example`). Takes are written through the engine, so no belief ledger records them and every prediction time is the uncertified `since_date`.

**Runs.** One run of all 20 cohorts on in-memory PGLite, Bun 1.4.3, no key and no network, as of 2026-10-16: at `65ed40ec6` (7.4 s) and again at the release merge commit `d28cbaeee` (v0.60.286.0) with identical results. $0.

## Results

| Criterion | Threshold | Result |
|---|---|---|
| Median Spearman ρ, shrunk accuracy vs true skill (12 holders, n ≥ 10) | ≥ 0.80 | **0.905** (90% of cohorts ≥ 0.80; raw accuracy 0.905) |
| Who-was-right set-F1, macro over 800 topic-cohorts | ≥ 0.95 | **1.000** |
| Denominator (journal totals; each holder's n, unresolved, overdue, open) | exact | 0 mismatches |
| `low_n` flags | exact | 0 mismatches |
| Prediction times labelled `since_date`, uncertified | exact | 0 mismatches |
| Remote probes | all pass | **8/8** |

The remote probes:

- Remote `takes_list` and `takes_search` are non-empty, unchanged by the horizon scan, and carry no horizon, prediction or journal field.
- Remote `takes_scorecard {}` counts the bets, is unchanged, and has no `groups` or `journal`. Local `takes_scorecard {}` is unchanged.
- Remote `{group_by: holder}`, `{group_by: source}` and `{min_n: 5}` are each refused with `scorecard_group_by_local_only`.
- No MCP op name contains `journal` or `horizon`.

Per-cohort ρ (shrunk): 0.741, 0.986, 0.853, 0.886, 0.958, 0.923, 0.874, 0.958, 0.923, 0.937, 0.937, 0.907, 0.902, 0.874, 0.874, 0.839, 0.921, 0.965, 0.748, 0.888.

## Records

- [`summary.json`](2026-10-17-forecast-journal/summary.json) and [`summary.md`](2026-10-17-forecast-journal/summary.md): the harness output from the release rerun, byte for byte.
- [`verdict.json`](2026-10-17-forecast-journal/verdict.json): the decision, the commits and the release.
- [Preregistration](2026-10-17-forecast-journal-preregistration.md), mirrored verbatim from gbrain apart from its opening paragraph.

## Reproduce

From a gbrain checkout at `d28cbaeee` (or `65ed40ec6`):

```bash
bun install --frozen-lockfile
bun evals/forecast-journal/harness.ts --check
bun evals/forecast-journal/harness.ts --run --json summary.json --md summary.md
```

Both cost $0 and need no key. `--run` exits 0 when the gate passes.
