# Phase 6 cell results (lifecycle-lite)

One directory per cell and lease, copied from the cell VM after the lease settled: `lease-summary.json`, and under
`lifecycle-lite/` the run's receipt and manifest plus gzipped per-probe rows (`rows`, `deletes`, `forget-cases`,
`outcomes`, `retrievals`). The histories are synthetic (seeded by `eval/generators/lifecycle-lite-gen.ts`), so rows
keep their matched text; retrieval rows keep item ids, ranks and types only. Rules:
[preregistration](../../2026-10-06-oss-memory-shootout-lifecycle-lite-preregistration.md); campaign:
[manifests/](../manifests/).

All seven cells completed on their first lease.

## Changelog

- 2026-10-07: All seven cells.
