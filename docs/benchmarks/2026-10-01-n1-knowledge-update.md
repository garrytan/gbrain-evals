# Knowledge update and supersession through the lifecycle harness (N1, 2026-10-01)

**Update, 2026-10-02.** gbrain fix wave 6 fixed N1-1, N1-2 and N1-3 (`982a77eb`). At gbrain `d44296c`, the same run passes all five preregistered rules: current-value accuracy 388/388 and history retained 385/385 on PGLite and on Postgres, with 0 stale values, 0 private values and 0 lost writes. The numbers below are the October 1 measurement at `3a284ae`. See the [October 2 rerun](2026-10-02-wave-repin.md).

## The finding

Explicit supersession through the Facts fence works everywhere it was measured, and the ontology half of gbrain's update story does not work on a default brain. Across six cells (PGLite and Postgres, each over the trusted local CLI, stdio MCP and HTTP MCP), after four rounds of updates, a restart, a full reimport of the vault and a concurrent update round:

- **Zero stale values served** (0 of 773 current-value and history probes on the PGLite cells; 0 on Postgres). Every fence chain (update depth 1 to 4, including three reverts to an earlier value) served exactly its current value in recall and search, and kept every superseded row as an expired fact. Every trajectory served its latest point and dropped every corrected point. A struck row inside a returned search chunk is history, not stale; 309 such rows were seen.
- **Zero acknowledged writes lost**, including the concurrent round (on the PGLite CLI cell 9 of 75 writes were refused at first under concurrency and accepted on retry).
- **Zero private values in remote responses**, with exposure controls holding for the fence and trajectory items (24 of 32 exposure probes had signal).

But `ontology_propose` (`gbrain ontology-add`) is refused on every brain made by `gbrain init` (N1-1), so every ontology current-value and as-of probe is a scored miss in every cell. That alone fails both utility floors:

| Metric (PGLite cells, gating) | Result | Denominator |
|---|---|---|
| Stale values served (target 0) | **0** | 773 current-value and history probes |
| Private values in remote responses (target 0) | **0** | every stdio and HTTP response, including MCP `_meta` |
| Acknowledged writes lost (target 0) | **0** | chains whose last write was acknowledged, checked by the trusted caller after the sequential and concurrent rounds |
| Current-value accuracy (floor 1) | **74.2%** | 288 of 388 current-value probes |
| History retained (floor 1) | **43.6%** | 168 of 385 history probes |

Without the ontology probes, current-value accuracy is 288 of 288 (100%) and history retained is 168 of 168 (100%). The safety verdict is `pass`; the promotion rules fail on `current-value-floor` and `history-retained-floor`. Postgres (report-only) matches PGLite on every number.

A supplementary in-process arm replays the ontology chains on an unmanaged in-memory engine (the N3 setup, which the persistence coordinator does not guard). There the ontology works, with two more bugs: a return to an earlier value with the same provenance is a silent no-op, so the old value stays current (N1-2), and an observation written with visibility `private` is returned to remote callers (N1-3). Arm result: current value 17 of 18, as-of 40 of 41, 1 stale value served, 2 remote leaks of the private observation.

The category is listed (it spawns real gbrain processes for minutes per cell), so it does not run in CI yet. Its rules were preregistered before the runner existed (commit `732ea6d`).

## The concrete case

Birch Example (`people/birch-example`, fictional) changes employer twice. Each change is a `put_page` that strikes the current row of the page's Facts fence with `superseded by #N` and appends the new row (rows 1 and 3, the home-city chain, are omitted):

```
| 2 | ~~Works at Meadow Health n1k... cnry...~~ | fact | ... | 2019-03-10 | 2020-01-31 | ... | superseded by #4 |
| 4 | ~~Works at Lantern Media n1k... cnry...~~ | fact | ... | 2020-01-31 | 2020-10-25 | ... | superseded by #5 |
| 5 | Works at Meadow Health n1k... cnry... | fact | ... | 2020-10-25 |  | ... |  |
```

The second change is a revert to Meadow Health. The right answers: recall lists only the active Meadow Health row; recall with `include_expired` lists both struck rows; a search for the chain's marker returns the page with the old values struck. gbrain gets all of that right in every cell, and keeps it right after a restart, a full `sync --full` of the vault and a concurrent round.

The same person's employer is also an ontology dimension, written with `ontology_propose` and a `valid_from` date for each of three values. On a default brain each of those writes fails with `writer_coordinator_required`, so `ontology_get` returns nothing, now or as of any date.

## The experiment and results

Runner: `eval/runner/n1-knowledge-update.ts`, through the lifecycle harness (`eval/runner/lifecycle/slice.ts` over the lifecycle drivers). gbrain `3a284aea` (v0.60.26.0) through a copied overlay (`--gbrain <checkout>@3a284ae`, tree hash verified, no symlinks). gbrain-evals commit `a6d9f45`. Seed 11, generator `n1-knowledge-update-gen@1`, ledger SHA-256 in the receipt. Hermetic: no provider key in any child process, a fresh `GBRAIN_HOME` per cell, `gbrain init --no-embedding`, and `decide status` read per cell with every slot effectively off. Cost $0 (the paid arm below is separate).

Ledger: 6 people and 3 companies; 12 fence chains (depths 1 to 4, three of each, three reverts, two private); 9 ontology chains (forward updates at depths 1 to 4, a revert with the same provenance, a revert with distinct provenance, a late-recorded backdated value, a private observation and its world twin); 4 trajectory chains (appended months, corrected months, a private metric and its world twin). Writes follow the documented client protocol (`get_page` for the revision, then `put_page` with `expected_revision`). Checkpoints: `updated` (after 4 sequential rounds), `restart`, `reimport` (vault committed and fully re-synced), `concurrent` (one more update to every chain written at once; refused writes retried).

| Surface (PGLite cells) | Passed | Stale |
|---|---|---|
| fence, recall | 128 / 128 | 0 |
| fence, search | 120 / 120 | 0 |
| recall history (include_expired) | 128 / 128 | 0 |
| find_trajectory, current | 40 / 40 | 0 |
| find_trajectory, history | 40 / 40 | 0 |
| ontology_get, current | 0 / 100 | 0 |
| ontology_get, as-of | 0 / 217 | 0 |

| Update kind (PGLite) | Passed |
|---|---|
| fence, explicit | 268 / 268 |
| fence, revert to an earlier value | 108 / 108 |
| trajectory, appended month | 24 / 24 |
| trajectory, corrected month | 48 / 48 |
| ontology, forward | 0 / 180 |
| ontology, revert (same provenance) | 0 / 39 |
| ontology, revert (distinct provenance) | 0 / 39 |
| ontology, backdated | 0 / 39 |
| exposure items (private and twin) | 8 / 28 |

By depth (PGLite, every probe of the chains at that depth, including ontology): depth 1: 99 of 117, depth 2: 78 of 186, depth 3: 99 of 135, depth 4: 60 of 105, exposure items (depth 0): 6 of 18. The depth spread is entirely the ontology misses; fence and trajectory chains pass at every depth.

Per cell: PGLite CLI 607 s, stdio 167 s, HTTP 172 s; Postgres CLI 367 s, stdio 105 s, HTTP 106 s. Negative controls (a key no chain uses, as-of before the first observation): 124 of 124.

**Erratum (N1-6).** The first counted run (gbrain-evals `1dab7dd`) scored search probes for the two private fence chains on the CLI cells. Private fence rows never enter search chunks for any caller (`src/core/facts-fence.ts`, "Layer A"), so those 16 probes measured nothing about supersession and failed by construction. They were removed and N1 was rerun (`a6d9f45`); apart from those 16 probes every count was identical between the two runs (current-value accuracy moved from 288 of 396 to 288 of 388). Erratum N1-5 (a non-canonical metric name in the generator) was fixed before the counted runs.

### Paid arm: implicit supersession (preregistered, report-only)

With `text-embedding-3-small` through the budget-ledger guard (`--paid --budget-run-id`), `remember` treated **0 of 10** value changes ("Home city is Faro" then "Home city is Braga") as supersessions; 0 of 10 unrelated controls were superseded; 10 of 10 punctuation-only near duplicates were deduplicated, so the dedup path ran (60 embedding requests, $0.000006). gbrain documents implicit supersession as a near-duplicate rule (cosine at least 0.95), so this is the expected result: a changed value stays as a second active fact unless the fence strikes the old one. Receipt: [n1-paid-receipt.json](2026-10-01-n1-n5/n1-paid-receipt.json).

## gbrain bugs found

Each has a keyless repro under [2026-10-01-n1-n5/repro/](2026-10-01-n1-n5/repro/) and an entry in the [wave findings ledger](2026-10-01-wave-bugs.md).

### N1-1. `ontology_propose` is refused on every default brain

- **Contract.** "Record one ontology observation ... A new value supersedes the prior" (`src/core/ops/chronicle.ts:153-188`), also `gbrain ontology-add`.
- **Mechanism.** The handler calls `engine.mergeOntologyFact`, which inserts into `facts` directly. A brain made by `gbrain init` has managed persistence enabled, and the `managed_writer_guard` trigger (`src/core/persistence/writer-guard-schema.ts`) rejects inserts outside the persistence coordinator.
- **Repro.** `bun docs/benchmarks/2026-10-01-n1-n5/repro/n1-1-ontology-propose-managed.ts`: expected an inserted observation; actual `writer_coordinator_required: canonical writer must use the persistence coordinator` from the CLI and from `gbrain call`, and `ontology_get` returns `[]`. N3 did not see this because it runs on an unmanaged in-memory engine.

### N1-2. A revert to an earlier ontology value is a silent no-op

- **Mechanism.** `mergeOntologyFact` inserts with `ON CONFLICT (source_id, entity_slug, dimension, value_hash, source_markdown_slug) DO NOTHING` (`src/core/pglite-engine.ts:2298-2306` and the Postgres twin). The key has no time component, so Lisbon (2020), Porto (2022), Lisbon (2024) with the default provenance stores the third write as `noop`.
- **Repro.** `bun docs/benchmarks/2026-10-01-n1-n5/repro/n1-2-ontology-revert-noop.ts`: expected current location Lisbon; actual Porto. With distinct provenance per observation the revert works.

### N1-3. A private ontology observation reaches remote callers

- **Contract.** Private facts are local-only (recall, `find_trajectory` and `context_pack` all serve remote callers world facts only); `ontology_propose` stores a visibility, default private.
- **Mechanism.** `ontology_get` and `getOntology` drop, for remote callers, only diary-sourced rows and rows whose provenance page is private; `facts.visibility` is never checked (`src/core/ops/chronicle.ts:128-151`).
- **Repro.** `bun docs/benchmarks/2026-10-01-n1-n5/repro/n1-3-ontology-private-remote.ts`: expected `decision_style` only; actual also `risk_tolerance=high (private marker)`. Masked on default brains by N1-1 today.

## Documented limits (not bugs)

- **Implicit supersession** (N1-4): skipped without an embedding key; with one, a changed value is not a near duplicate (paid arm above). Natural-language change detection does not exist.
- **No direct supersede operation**: explicit supersession is a fence edit through `put_page`.
- **Struck rows in search**: superseded rows stay in chunk text by design; the scorer counts them as history.
- **Private fence rows are not searchable by anyone**, by design (the chunker strips them).
- **Metric aliases**: the fence maps aliases such as `burn` to `burn_rate`, and `find_trajectory` filters on the canonical name.
- **think** needs a chat model and was not probed.

## What to use and what to avoid

Use explicit fence supersession (strike the old row with `superseded by #N`, through `put_page` with `expected_revision`) for values that change; it held through restarts, reimports and concurrent writes on both engines. Do not rely on `ontology_propose` until N1-1 is fixed, and after that, give a revert a distinct provenance (N1-2) and do not store private ontology observations on a brain remote agents can read (N1-3). Do not expect `remember` to replace an old value by itself.

## Reproduce and inspect

```
bun eval/runner/n1-knowledge-update.ts --gbrain <gbrain checkout>@3a284aea26889b77c633aebb4149c3016d834ee6 --engines pglite,postgres --pg-url postgres://postgres@127.0.0.1:55432/postgres
bun eval/runner/n1-knowledge-update.ts --paid --budget-run-id <open ledger run>   # the paid arm
```

Receipt: [2026-10-01-n1-n5/n1-receipt.json](2026-10-01-n1-n5/n1-receipt.json); the first counted run, before erratum N1-6: [n1-receipt-before-erratum.json](2026-10-01-n1-n5/n1-receipt-before-erratum.json). Tests: `bun test test/eval/n1-knowledge-update.test.ts` (determinism, oracle cases, scorer negatives, the mutation suite graded by the preregistered rules, and a broken in-memory adapter that ignores strikes).
