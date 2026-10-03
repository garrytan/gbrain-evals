# Preregistration: CI-sized slices of N1 and N5

Frozen on October 2, 2026, in its own commit, before any slice run. The slice definitions live in `eval/runner/n1-knowledge-update.ts` (`N1_CI_SLICE`) and `eval/runner/n5-forget-residue.ts` (`N5_CI_SLICE`); the rules live in `eval/registry.ts` (`N1_CI_RULES`, `N5_CI_RULES`, registry entries `knowledge-update-ci` and `forget-residue-ci`).

## Why a slice

N1 (knowledge update) and N5 (forgetting residue) test gbrain through real gbrain processes: the CLI, a stdio MCP server and an HTTP MCP server, on PGLite and Postgres. Both passed every preregistered rule at gbrain `d44296c` on October 2, so a CI run would now catch regressions rather than fail on known bugs. The full runs do not fit CI: the CLI cells take about 10 minutes and the Postgres cells need Docker.

The task asked for slices that finish in under two minutes each, on PGLite, without a key.

## What was measured before this commit

Timing only, on full-world cells, to choose a cell that can fit. These runs use the full ledger and are covered by the existing N1 and N5 rules; none of them is a slice run.

| Run (PGLite, gbrain `d44296c`, 4-core cloud machine) | Wall time |
|---|---:|
| N5, all three transports concurrently | 9 min 36 s (CLI cell 575 s, stdio 154 s, HTTP 163 s) |
| N1, stdio MCP cell alone | 96 s |
| N5, stdio MCP cell alone | 124 s |

The CLI transport starts a new process for every read. A bare `gbrain call get_stats` takes about 1.0 s, and opening the PGLite data directory accounts for about 0.7 s of that. The N5 CLI cell made 508 such calls. A CLI cell under two minutes would have to drop to roughly 90 calls, which removes most checkpoints and tiers. So the slices use the stdio MCP cell, which is still the gbrain CLI (`gbrain serve`) as a separate process, and still reads every trusted control and private value through `gbrain call`. That keeps both process boundaries in the slice. The stdio cell is also the cheapest cell that exercises the MCP server's hot-memory cache, where the October 1 run found the N5 residue bug.

The full N5 stdio cell (124 s) is over budget, and N1 (96 s) has little margin on a CI runner. Most of the time is trusted `gbrain call` reads of private values, so the slices cut entities, not checkpoints or tiers.

## The slices

**N1 slice (`--slice ci`).** Seed 11, the four entities `people/alder-example`, `people/birch-example`, `people/ember-example`, `companies/kappa-example`, with every fence, ontology and trajectory chain on them unchanged. One cell: PGLite, stdio MCP. All four checkpoints (updated, restart, reimport, concurrent) and the in-process ontology arm run as in the full run. Covered: explicit and revert fence supersession at depths 1 to 4, a private fence value, forward, backdated, same-source revert and private ontology chains, a corrected trajectory and its private twin. Not covered: the distinct-source ontology revert (fern), the appended trajectory (gamma), the CLI and HTTP transports, Postgres.

**N5 slice (`--slice ci`).** Seed 5, the canaries on `people/hazel-example` and `people/ivy-example` whose source canaries are also kept: 13 of 24 (c01 to c06, c13, c15, c18, c20 to c22, c24). One cell: PGLite, stdio MCP. Every checkpoint (witness, immediate, settled, stale reimport, restart, concurrent) and every active tier. Covered: remembered and fence-authored forgets, a same-text twin on another entity, a private forgotten canary, a late forget during concurrent writes, paraphrases (a documented gap, not gated), a corrected claim, the refused exact repeat. Not covered: the prose canary, the private retained canary, the concurrent same-text twin, the read-only and foreign-source forget attempts (they need HTTP), the CLI and HTTP transports, Postgres. The `no-unauthorized-forget` contract is therefore trivially 0 in the slice.

## Rules

Each slice keeps every safety contract and utility floor of its full category, unchanged. Each adds signal floors so a slice that silently shrinks, or stops reaching the surfaces, cannot pass by measuring nothing. Every floor is computed from the sliced generator ledger alone, without running gbrain.

| Slice | Added floor | Value | Derivation |
|---|---|---:|---|
| N1 | `data.metrics.current_value_probes` | ≥ 64 | 16 world current-value probes at each of four checkpoints |
| N1 | `data.metrics.history_probes` | ≥ 57 | 13 at each of updated, restart and reimport; 18 at concurrent |
| N1 | `data.metrics.exposure_probes_with_signal` | ≥ 12 | 3 private items at each of four checkpoints; the N1 contract says every private value has a trusted control that must see it |
| N5 | `data.metrics.forgotten_pairs_with_signal` | ≥ 4 | c01, c03, c15 and c18 must each be witnessed in `recall_facts` (the runner's presence assertion) |
| N5 | `data.metrics.retained_pairs` | ≥ 24 | c02, c05, c06 and c13 in `recall_facts` at five post-forget checkpoints, plus c18 at the four before its late forget |
| N5 | `data.private_control.witnessed_by_trusted` | ≥ 1 | the trusted control must see c15 before its forget |

The N1 counts were produced by the same probe functions the runner uses (`n1Probes`, `n1ExposureProbes`, `classOf`, world probes only). Applied to the full ledger they give 124 current, 124 history and 16 exposure probes, which matches the full October 2 stdio receipt, so the counting reproduces the runner.

## Decision rule

The slice gates when every rule passes and the run completes. A void run (failed presence assertion, System One not provably off, a fatal cell) is an error, never a pass. A slice is accepted for CI when its first measured run passes and finishes in under 120 seconds of wall time on this machine; `all.ts` bounds each slice at 300 seconds as a hang guard. If a slice fails a rule on its first run, the failure is reported and investigated as a gbrain finding or a harness defect; no rule value changes in the same commit as code it measures.
