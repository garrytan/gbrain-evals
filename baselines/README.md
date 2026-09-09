# Saved retrieval baselines

A baseline records what a known version returned for a fixed set of questions. Comparing a new run with it catches unintended changes. It does not, by itself, prove the old results were correct; the [qrels](../qrels/README.md) supply the intended answers.

This directory contains `v0.41-launch.baseline.ndjson`, captured from a small fictional corpus. It contains placeholder names and no private user queries. Personal captures belong on the user's own machine, not in this repository.

## Check the committed baseline

From this repository's root:

```sh
bun install --frozen-lockfile
bun scripts/generate-v0.41-launch.ts --check
```

Despite its filename, `--check` does not regenerate the saved file. It builds the reference corpus, runs 12 keyword queries and checks the captured result sets against the baseline. It also verifies each expected first result. This is the offline check run in CI.

## Read the file

NDJSON means one JSON object per line. The first line has `_kind: "baseline_metadata"` and identifies the baseline, its thresholds, source hash, row count and measured mean latency. The remaining lines are captured query/results records with stable query hashes.

The baseline's result sets and the qrels' intended answers serve different purposes. A result can change without becoming wrong; an unchanged result can still have a bad answer label.

## Regenerate deliberately

```sh
# Uses the installed gbrain dependency.
bun scripts/generate-v0.41-launch.ts

# Test an explicitly selected local gbrain checkout instead.
GBRAIN_SRC=/path/to/gbrain bun scripts/generate-v0.41-launch.ts
```

The command without `--check` replaces the committed baseline. Review its diff and explain intentional ranking or corpus changes with a `Why:` line in the commit body.

The content ordering, identifiers and fixed publication timestamp are deterministic. Measured latency is real wall-clock time and can change by machine or run, so regeneration is not byte-identical.

## Use the gbrain CLI

The public CLI can compare a brain against these files:

```sh
gbrain eval gate --baseline baselines/v0.41-launch.baseline.ndjson
gbrain eval gate \
  --baseline baselines/v0.41-launch.baseline.ndjson \
  --qrels qrels/v0.41-launch.qrels.json
```

These paths assume this repository is the current directory. The selected brain must contain the matching corpus; merely pointing the CLI at a baseline does not create it. For the self-contained reference-corpus check, use the script above.

CLI exit codes are 0 for pass, 1 for a failed gate and 2 for incorrect usage.
