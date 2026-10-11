# Phase 6 cell manifests: update and forget (lifecycle-lite), draft

Cell manifests for the [open-source memory shootout](../../../plans/2026-10-05-oss-memory-shootout/PLAN.md), Phase 6
(P2, update and forget), under the draft
[preregistration](../../2026-10-06-oss-memory-shootout-lifecycle-lite-preregistration.md). This is its own campaign:
the Phase 4 manifests are untouched, since a running campaign is bound to their hash.

## Layout

- `campaign.json`: campaign `oss-memory-shootout-p2-lifecycle-lite`, ledger
  `.budget/oss-memory-shootout-p2-lifecycle-lite.sqlite`, cap $24.37 (the sum of the leases), parameter
  `gbrain_master_sha` = `c5fb0201d1960a0a5a81c35d77718311b03154b7`.
- `cells/<system>-common.json`: one cell per system, each at its common configuration: markdown-notes, extract-first, temporal-graph,
  memory-bank, graph-pipeline, and gbrain-shootout at the repository pin `739e5cc` and at frozen master. Leases are 1.15 times
  each cell's estimate (`lease_basis` gives the pilot measurement behind it).

Each vendor cell sets up the VM (`eval/systems/bootstrap.sh setup`), starts its stack against the cell's lease proxy,
runs lifecycle-lite on seeds 1 to 5 with the reader and judge on and a restart through `bootstrap.sh restart`, and
stops the stack. The extract-first cell waits up to four hours for `/finish`, as amendment A3 does for Phase 4.

## Run

    bun eval/runner/shootout-cell.ts hash    --campaign docs/benchmarks/2026-10-06-oss-memory-shootout-lifecycle-lite/manifests/campaign.json
    bun eval/runner/shootout-cell.ts init    --campaign <same> --state <dir>
    bun eval/runner/shootout-cell.ts reserve --campaign <same> --state <dir> --cell extract-first-common-lifecycle-lite
    bun eval/runner/shootout-cell.ts launch  --campaign <same> --state <dir> --cell extract-first-common-lifecycle-lite
