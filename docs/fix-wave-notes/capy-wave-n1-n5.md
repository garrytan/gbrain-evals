# Eval-category wave, lane A: N1 and N5 (branch `capy/wave-n1-n5`)

Amendments 2 and 5 of the [wave plan](../plans/2026-10-01-eval-category-wave/README.md): N1 (knowledge update and supersession) and N5 (forgetting residue), both through the existing lifecycle harness rather than a new one. Based on `capy/eval-wave-step0` (`8eb51d3`). VERSION and CHANGELOG are untouched; the integrator writes the wave entry.

## Commits, in order

1. `732ea6d` Registry rows for `knowledge-update` (N1) and `forget-residue` (N5) with their promotion rules (safety contracts, utility floors, exploratory metrics), plus [the preregistration page](../benchmarks/2026-10-01-n1-n5-preregistration.md) for the paid arm. Frozen before either runner existed; the runner files were placeholders that exit 3.
2. `1dab7dd` Runners, generators, scorers, tests and the first repros.
3. `a6d9f45` Erratum N1-6 (private fence chains are not search probes) and cell work directories outside the checkout.
4. Reports, receipts, the findings ledger, the remaining repros, docs rows and these notes.

## What was built

- `eval/runner/lifecycle/slice.ts`: one engine x transport cell set up like `lifecycle-experiment.ts` (keyless child environment, fresh `GBRAIN_HOME`, `gbrain init --no-embedding`, git vault sources, `decide status` presence check, OAuth clients on HTTP cells). `trusted()` reads as the trusted local CLI; on PGLite remote cells it pauses the server, because PGLite admits one process. Every call is recorded, including the MCP `_meta` block, for leak scanning.
- `eval/runner/lifecycle/drivers.ts`: the HTTP session logic moved into `McpHttpClient` so a category can act as a second OAuth client (read-only, foreign source) against the same server; `CallResult` now carries `_meta`. `lifecycle-experiment.ts` uses the same constructor and behaves the same.
- N1 (`eval/runner/n1-knowledge-update.ts`, generator `eval/generators/n1-knowledge-update-gen.ts`, scorer `eval/runner/lifecycle/n1-score.ts`): fence supersession, reverts, ontology valid time (N3 semantics), trajectories with corrections, N6-style exposure controls; checkpoints after updates, restart, reimport and a concurrent round; an in-process ontology arm on an unmanaged engine; the preregistered paid implicit-supersession arm behind `--paid --budget-run-id`.
- N5 (`eval/runner/n5-forget-residue.ts`, generator `eval/generators/n5-forget-residue-gen.ts`, scorer `eval/runner/lifecycle/n5-score.ts`): canaries with same-text twins, private, fence-authored and prose canaries, paraphrases, corrected claims and a refused repeat; witness, immediate, settled, stale-reimport, restart and concurrent checkpoints; authority through read-only and foreign-source HTTP clients; per-tier witnesses; `_meta` hot-memory residue.
- Tests (`test/eval/n1-knowledge-update.test.ts`, `test/eval/n5-forget-residue.test.ts`): generator determinism, oracle and scorer cases with negatives that must fail, `assertScorerRejectsFakeSystems` graded by each category's preregistered promotion rules, and a deliberately broken in-memory adapter per category (one ignores strikes, one has a no-op forget) run through the real observation code.

## Results (counted runs, gbrain `3a284ae` through a copied overlay, $0)

- **N1** ([report](../benchmarks/2026-10-01-n1-knowledge-update.md)): safety contracts pass (0 stale served of 773 probes, 0 private leaks, 0 acknowledged writes lost on the PGLite cells; Postgres identical). Floors fail: current-value accuracy 288 of 388 (74.2%), history retained 168 of 385 (43.6%), every miss an ontology probe, because `ontology_propose` is refused on every default brain (N1-1). Fence and trajectory probes: 100%.
- **N5** ([report](../benchmarks/2026-10-01-n5-forget-residue.md)): 0 reactivations, 0 collateral expirations, 0 unauthorized forgets, 0 private leaks. Fails on 2 prohibited `context_pack` outputs (PGLite; 12 on Postgres) from the hot-memory cache (N5-1), retained recall 738 of 750 (N5-2) and reinstatement 4 of 6 (N5-3).
- **Paid arm:** 0 of 10 value changes superseded implicitly with real embeddings; $0.000006 through lane budget run `capy-wave-n1-n5-2026-10-01T19-50-48-533Z-3c67f696` ($10 cap; the ledger file is local and gitignored). It ran from the working tree just before `1dab7dd`; the paid code path is unchanged since.

## Findings ([ledger](../benchmarks/2026-10-01-wave-bugs.md))

Bugs, each with a keyless repro in `docs/benchmarks/2026-10-01-n1-n5/repro/`: N1-1 `ontology_propose` refused on managed brains; N1-2 ontology revert with the same provenance is a no-op; N1-3 private ontology observations reach remote callers; N5-1 hot-memory cache serves forgotten facts for 30 s (`bumpHotMemoryCache` has no caller); N5-2 concurrent CLI writes on PGLite leave a forgotten fact's page without search chunks until a later write (and a committed forget can answer `owner_unavailable`); N5-3 on PGLite the first corrected `remember` after a forget is refused with `scope_denied`.

Feature gaps: N1-4 implicit supersession and change detection; N5-4 paraphrase retraction; N5-5 physical erasure; N5-6 dream-derived tiers (unmeasured here). Category defects, fixed with errata: N1-5, N1-6, N5-7.

## Decisions to review

- **Listed, not dispatched.** Both categories spawn real gbrain processes (the CLI cells take 6 to 17 minutes), far over the 60-second CI budget, and the Postgres cells need Docker. They carry preregistered rules (so `gate` in the registry), but CI does not run them until a CI-sized slice is measured. That also keeps the evals PR green while N1-1 and N5-1 are open.
- **Gating scope.** `data.metrics` aggregates the PGLite cells over all three transports; Postgres is `data.metrics_postgres`, report-only.
- **Hot-memory `_meta` residue** was found after the rules were frozen. It is the same cache as N5-1's `context_pack` residue, so it is reported beside the rules and not folded into the preregistered count.
- **Dream tiers** were not stubbed (no fake chat endpoint was wired); they are listed as unmeasured rather than counted as zero.

## Notes for the fix wave and the integrator

- N1-1 likely needs `ontology_propose` routed through the persistence coordinator like `remember`; after that, N1-3 becomes reachable on default brains, so fix them together. N1-2 is the conflict key in `mergeOntologyFact` (both engines).
- N5-1: call `bumpHotMemoryCache` (or clear by source) on forget, and consider excluding the `forget` verb from the `_meta` hook as `forget_fact` already is.
- The N3 gate stays green: its in-memory unmanaged engine does not see N1-1.
- The parent's note that gbrain master now needs Bun 1.4 does not affect these runs (pinned `3a284ae` on Bun 1.3.14); rerunning against the fix overlay will need Bun 1.4.2.
