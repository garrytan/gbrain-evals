# N1 and N5 preregistration (eval-category wave, lane A)

Frozen on 2026-10-01, before either runner existed or ran. The promotion rules themselves live in `eval/registry.ts` (`knowledge-update`, `forget-residue`); this page records the reasoning and the one paid arm.

## Hermetic arms ($0)

Both categories run through the lifecycle harness (`eval/runner/lifecycle/`): real gbrain processes over the trusted local CLI, stdio MCP and HTTP MCP, on PGLite and Postgres. Provider keys are stripped and System One is off by construction (no TypeSafe key, fresh `GBRAIN_HOME` per cell, no embedding model configured).

- **Gating metrics** are read from `data.metrics`, which aggregates the PGLite cells over all three transports. Postgres cells are reported in `data.metrics_postgres` and never gate (report-only outside CI, plan CEO item for N5).
- **N1 safety contracts:** zero stale values served as current, zero private values exposed to remote callers, zero acknowledged writes lost. **Utility floors:** current-value accuracy 1 and history retained 1.
- **N5 safety contracts:** zero prohibited active outputs after forget across every witnessed tier and checkpoint, zero reactivations, zero collateral expirations, zero unauthorized forgets applied, zero private canaries exposed. **Utility floors:** retained-neighbor recall 1 and reinstatement of a corrected claim 1.
- **Never gating:** implicit supersession (needs an embedding key), paraphrase residue and physical erasure (documented non-guarantees), dream-derived tiers a keyless run cannot reach.

A (canary, tier) pair that was not witnessed before the forget carries no signal and is excluded from residue and retained recall, and reported. A presence failure (the trusted caller cannot read what the ledger wrote) voids the run.

## Paid arm: implicit supersession (N1, report-only, optional)

- **Question.** With a real embedding model, does `remember` treat a changed value ("Lives in Porto" after "Lives in Lisbon") as a supersession? gbrain documents implicit supersession as a near-duplicate rule (cosine >= 0.95, same kind, different text, `src/core/facts/write-single.ts`), so the expected answer is "rarely"; the arm measures it.
- **Metric and denominator.** Implicit-supersession rate over the value-change pairs in the N1 ledger's fact chains (one `remember` per value, in order), and the false-supersession rate over unrelated-claim control pairs on the same entity.
- **Decision rule.** Report-only; it never gates and never sets a hermetic threshold.
- **Cost estimate.** Under $0.05 (short texts through `text-embedding-3-small`); hard cap $2 through `--paid --budget-run-id` and the budget ledger. Provider calls from the gbrain child processes go through an in-process forwarding proxy whose `fetch` is wrapped by `installPaidRequestGuard`, so every request is reserved.
- **If it does not run,** the report says so and implicit supersession stays a gap.
