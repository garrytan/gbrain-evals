# Preregistration template

Copy this file to `docs/benchmarks/YYYY-MM-DD-<name>-preregistration.md`, fill every section, add a registry entry in a file under `preregistrations.d/` in the same commit (shape under [Registry entry](#registry-entry)), and push before the first paid or gating request. Runners call `attestPreregistration` (`eval/runner/prereg.ts`), which refuses when the file is uncommitted, edited or not on `origin`, and write the attestation into the receipt. CI checks that every listed result file was added after its preregistration, that every new preregistration file has a registry entry, and that every new entry carries the eval-loop practice fields (`eval/runner/prereg-practices.ts`).

A quick look (at most $100 paid, finished within a day, after a keyless dry run) needs only a three-line preregistration file (question, decision, stop rule) and a registry entry that repeats them, and it publishes no number. Anything that publishes a number or ships a cut is a counted run and fills every section here.

A change after a cell has run is a dated amendment appended at the end, never an edit.

## Question

What decision this measurement informs, in one or two sentences.

## Public lesson

What someone building agents would learn, and what they would do differently, if the result goes either way: one sentence for a win and one for a loss or null, in the "We learned X. You should do X." form the report will open with (see "Shape of a benchmark report" in [CLAUDE.md](../../CLAUDE.md)).

## Evidence class

Regression check, development evidence (data used in earlier tuning or written around known failures), label validation, or held-out confirmation.

## Build and data

gbrain commit, gbrain-evals commit, dataset or fixture identity with hashes, seeds.

## Arms

Each arm with exact model ids, reasoning effort, output limits, temperature, prompts (by hash) and settings. Which arm is the comparator.

## Metric and denominator

The primary metric, its denominator, the analysis unit and the cluster used for intervals. How errors, refusals, truncations and missing rows count.

## Decision rule

The primary comparison, one primary judge where judges apply, the multiple-comparison correction across all arms, the minimum detectable effect at the assumed discordance, and any non-inferiority margin. Wording for a result smaller than the test can resolve.

## What each outcome changes

What we will do differently for each way the result could come out. If nothing changes whichever way it lands, don't run it. The registry entry's `decision` field repeats each row as an `if` and a `then`.

| If it wins | If it loses | If inconclusive or at the ceiling |
|---|---|---|

## Pilot per arm

For each arm, a pilot on at most a tenth of that arm's budget, run before its counted run, showing on that arm's own outputs that the part under test actually ran (for example, the skill loaded or gbrain's search was called), that the judge passes its check there, and that the tasks can be supplied at the planned rate. An arm that fails is fixed, or left out and reported as left out. Where a tenth can't buy the judge check's 40 labelled outputs, the tenth covers the other two checks and the judge check runs in a stage before any counted unit, sized to what it needs; say so here.

## Judge check

Each model judge, the models whose outputs it scores (never its own family, and never particle-1 as a judge of a counted cell), the labelled outputs it is checked on (at least 40), the agreement it must reach (kappa of at least 0.6) and how its errors are read per arm, not pooled. Or say there is no model judge and why.

## Interim look

A counted run planned above $500 paid takes one look at half its units, with O'Brien-Fleming bounds at the plan's own alpha (for a two-sided 0.05 test, stop for a difference at z of 2.80 or more either way, final look at 1.98) and a futility stop when conditional power under the planned effect falls below 10%. No other look at the primary comparison counts, and a run that stops early says so and reports its estimate as possibly overstated. Below $500 paid, say that no look is planned.

## Budget

Ledger path and budget run, and how each request is reserved against the ledger before it is sent. State that a cap is set in the ledger, that reaching it pauses the run until the cap is extended rather than ending it incomplete, and how the run resumes. Dollar amounts for the cap, reservations and any program budget stay in the tracking issue, not here. Give unit prices only where the design depends on them, such as a per-task price that sets the sample size.

## Registry entry

Add the entry as `docs/benchmarks/preregistrations.d/<id>.json`. CI checks each field's presence and shape, not its prose. `paid_tier` is a band (`quick-look`, `under-500` or `over-500`), never a dollar figure. `results_page` must match one of the `results` globs, and once that page exists it carries one line `Settled call: <the ship-or-kill call this result settled, or none>`, with no cost on it. Arm names and model ids below are examples.

```json
{
  "schema_version": 1,
  "experiments": [
    {
      "id": "<id>",
      "preregistration": "docs/benchmarks/YYYY-MM-DD-<name>-preregistration.md",
      "results": ["docs/benchmarks/YYYY-MM-DD-<name>/**", "docs/benchmarks/YYYY-MM-DD-<name>.md"],
      "results_page": "docs/benchmarks/YYYY-MM-DD-<name>.md",
      "registered": "YYYY-MM-DD",
      "paid_tier": "over-500",
      "decision": [
        { "if": "<outcome>", "then": "<what we do differently>" },
        { "if": "<the other outcome>", "then": "<what we do differently>" }
      ],
      "arms": ["gbrain", "files"],
      "models": [
        { "model": "claude-opus-5-5", "role": "under-test" },
        { "model": "particle:particle-1", "role": "under-test" },
        { "model": "gpt-6.2-sol", "role": "under-test" },
        { "model": "gpt-6.2-astra", "role": "judge" },
        { "model": "gpt-4o-mini", "role": "system-internal", "system": "<compared system that ships it as its default>" }
      ],
      "pilots": [
        { "arm": "gbrain", "max_budget_fraction": 0.1, "part_under_test_ran": "<how the pilot shows it>", "judge_passes": "<how>", "units_supplied_at_rate": "<how>" },
        { "arm": "files", "max_budget_fraction": 0.1, "part_under_test_ran": "<how>", "judge_passes": "<how>", "units_supplied_at_rate": "<how>" }
      ],
      "judge_check": {
        "judges": [
          { "model": "gpt-6.2-astra", "grades": ["claude-opus-5-5", "particle-1"], "labelled_outputs": 40, "kappa_min": 0.6 },
          { "model": "claude-opus-5-5", "grades": ["gpt-6.2-sol"], "labelled_outputs": 40, "kappa_min": 0.6 }
        ],
        "read_per_arm": true
      },
      "interim_look": { "at_units_fraction": 0.5, "bounds": "obrien-fleming", "alpha": 0.05, "futility_stop": "<rule>" }
    }
  ]
}
```

`models` lists every model the campaign runs, with one role each: `under-test`, `judge`, `simulator`, `extractor`, `embedder`, `bridge`, `protocol-fixed` or `system-internal`. An entry registered on or after 2026-11-21 needs it, and CI and `attestPreregistration` refuse gpt-4o and gpt-4o-mini in every role but `system-internal`, which covers only a compared system's shipped default and names that system ([CLAUDE.md, "Choose models"](../../CLAUDE.md#choose-models)). A quick look carries `models` too.

With no model judge, `judge_check` is `{ "model_judge": false, "reason": "<why>" }`. Under `under-500`, `interim_look` may be `{ "not_required": "<reason>" }`. A quick look carries only `id`, `preregistration` (its three-line file), `results`, `registered`, `paid_tier: "quick-look"`, `models` and `quick_look: { "question", "decision", "stop_rule" }`.

## Amendments

None yet.
