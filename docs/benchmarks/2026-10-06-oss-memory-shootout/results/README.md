# Phase 4 cell results

One directory per cell and lease (`<cell>/<lease>/`), copied from the cell VM after the lease settled:

- `lease-summary.json`: the lease, its committed dollars and request count, and the cell's exit code.
- `receipt.json`: the memory-QA run receipt (system identity and capability record, ingest counts, outcomes, summary
  metrics); `arms/<arm>/receipt.json` per arm.
- `arms/<arm>/rows.ndjson.gz` and `retrievals/rows.ndjson.gz`: one row per question with ids, category, outcome,
  strict recall, retrieved session ids, tokens, latency and cost. Reader answers, retrieved item text and the packed
  contexts are left out: they carry dataset text. They are kept outside the repository with the pulled run.

The manifests and campaign hash are in [manifests/](../manifests/) and the rules in the
[preregistration](../../2026-10-06-oss-memory-shootout-preregistration.md).

## Status

| Cell | Lease | Status |
|---|---|---|
| `mem0-common-locomo-r1` | `a1-757e7284` | harness failure: every `/finish` hit the runner's 600-second default while Mem0's queue drained, so all 587 rows are `ingest_degraded` (amendment A3); rerun as attempt 2 |

Every other directory here is a complete cell.

## Changelog

- 2026-10-06: First ten LoCoMo dev r1 cells and the Mem0 r1 harness failure.
