# Preregistration template

Copy this file to `docs/benchmarks/YYYY-MM-DD-<name>-preregistration.md`, fill every section, add an entry to [`preregistrations.json`](preregistrations.json) in the same commit, and push before the first paid or gating request. Runners call `attestPreregistration` (`eval/runner/prereg.ts`), which refuses when the file is uncommitted, edited or not on `origin`, and write the attestation into the receipt. CI checks that every listed result file was added after its preregistration.

A change after a cell has run is a dated amendment appended at the end, never an edit.

## Question

What decision this measurement informs, in one or two sentences.

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

Ledger path, budget run, per-arm worst-case reservation and cap. What happens when the cap is reached.

## Amendments

None yet.
