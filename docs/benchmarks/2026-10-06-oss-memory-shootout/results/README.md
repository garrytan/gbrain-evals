# Phase 4 cell results

One directory per cell and lease (`<cell>/<lease>/`), copied from the cell VM after the lease settled:

- `lease-summary.json`: the lease, its committed dollars and request count, and the cell's exit code.
- `receipt.json`: the memory-QA run receipt (system identity and capability record, ingest counts, outcomes, summary
  metrics); `arms/<arm>/receipt.json` per arm.
- `arms/<arm>/rows.ndjson.gz` and `retrievals/rows.ndjson.gz`: one row per question with ids, category, outcome,
  strict recall, retrieved session ids, tokens, latency and cost. Reader answers, retrieved item text and the packed
  contexts are left out: they carry dataset text. They are kept outside the repository with the pulled run.
- Receipts are byte-for-byte as the VM wrote them, except that the VM home directory `/home/ubi/` in the gbrain overlay
  path (`overlay.requested`) is written as `~/`, the rewrite the receipt writer applies to every other path.

The manifests and campaign hash are in [manifests/](../manifests/) and the rules in the
[preregistration](../../2026-10-06-oss-memory-shootout-preregistration.md).

## Status

| Cell | Lease | Status |
|---|---|---|
| `mem0-common-locomo-r1` | `a1-757e7284` | harness failure: every `/finish` hit the runner's 600-second default while Mem0's queue drained, so all 587 rows are `ingest_degraded` (amendment A3); rerun as attempt 2 |

| `graphiti-common-lme-s` | `a1-cfb6cb33` | lost at launch: the host stopped the driver while ubi-runner was creating the VM, and the VM was destroyed before sync. No VM ledger or proxy usage log exists, so the ledger holds the full $283 as a reservation, actual unknown, not measured spend. The launch log shows the cell command never started |
| `graphiti-common-lme-s` | `a2-c5057994` | lost at sync (a concurrent `git fetch` changed `.git` while ubi-runner read it); closed at $0 with `abandon --unstarted`, launch log kept as evidence |
| `hindsight-common-lme-s` | `a1-b6bfb19c` | as above, closed at $0 |
| `gbrain-shootout-common-lme-s` | `a1-7b217224` | as above, closed at $0 |

Every other directory here is a complete cell.

## Changelog

- 2026-10-07: Seven more cells (LongMemEval-S controls and gbrain rows, Graphiti recipe LoCoMo r2); plain-hybrid LongMemEval-S has one degraded haystack (4 of 400 rows, under the 5% threshold).
- 2026-10-06: First ten LoCoMo dev r1 cells and the Mem0 r1 harness failure.
