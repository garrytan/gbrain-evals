# Preregistration template

Copy this file to `docs/benchmarks/YYYY-MM-DD-<name>-preregistration.md`, fill every section, add an entry to [`preregistrations.json`](preregistrations.json) or a file under `preregistrations.d/` in the same commit, and push before the first paid or gating request. Runners call `attestPreregistration` (`eval/runner/prereg.ts`), which refuses when the file is uncommitted, edited or not on `origin`, and write the attestation into the receipt. CI checks that every listed result file was added after its preregistration.

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

| If it wins | If it loses | If inconclusive or at the ceiling |
|---|---|---|

## Budget

Ledger path and budget run, and how each request is reserved against the ledger before it is sent. State that a cap exists, that reaching it pauses the run until the cap is extended rather than ending it incomplete, and how the run resumes. Dollar amounts for the cap, reservations and any program budget stay in the tracking issue, not here. Give unit prices only where the design depends on them, such as a per-task price that sets the sample size.

## Amendments

None yet.
