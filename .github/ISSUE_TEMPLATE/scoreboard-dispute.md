---
name: Scoreboard dispute
about: Dispute a row of the head-to-head scoreboard, or submit a configuration for a system
title: "Scoreboard dispute: <row> / <column>"
labels: scoreboard-dispute
---

<!--
Process (docs/scoreboard.md, "Dispute a row"): the gbrain-evals maintainer thread answers within 7 days.
An accepted configuration adds a new row on public dev data (LoCoMo dev) beside the original row. A
published row is never edited or replaced; both rows stay linked. Describe systems by their kind id
(eval/systems/kinds.json); do not paste provider keys, sealed data or dataset text.
-->

## The number

- Row (system kind id and configuration):
- Column (set, token budget, reader):
- Output of `bun run eval:scoreboard explain <row> <column>`:

```text
(paste here)
```

## What is wrong

What the row measured, what it should have measured, and why.

## Proposed configuration

The capability-record override (the `configs` and `retrieval_policies` entries that differ from the
published record), as JSON:

```json
{}
```

## Evidence

- The keyless conformance run (`SHIM_URL=http://127.0.0.1:8700 bun test test/eval/systems-conformance.test.ts`):
- The dev rerun command and its output (LoCoMo dev, one system, public data only):

```text
(paste here)
```

## Contact

How the maintainer thread can reach you for a follow-up.
