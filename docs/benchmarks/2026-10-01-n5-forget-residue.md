# Forgetting and withdrawal residue through the lifecycle harness (N5, 2026-10-01)

**Update, 2026-10-02.** gbrain fix wave 6 fixed N5-1 (`3b1d238c`), N5-2 and N5-3 (`9eaab73f`, `5a550533`). At gbrain `d44296c`, the same run passes all seven preregistered rules on PGLite and on Postgres: 0 prohibited outputs, retained-neighbor recall 750/750 and reinstatement 6/6. No remote response carried a forgotten fact in `_meta`. The numbers below are the October 1 measurement at `3a284ae`. See the [October 2 rerun](2026-10-02-wave-repin.md).

## The finding

`forget` keeps its documented promise on the storage side and breaks it in three places around it. Across six cells (PGLite and Postgres, each over the trusted local CLI, stdio MCP and HTTP MCP) a forgotten claim never came back: zero reactivations after an incremental sync, a full reimport of the pre-forget files, an agent writing back a stale page, a restart and a concurrent round, and zero collateral expirations of same-entity neighbors or same-text claims on other entities. A read-only and a foreign-source OAuth client could not withdraw anything (2 of 2 attempts refused on each HTTP cell). No private canary reached a remote caller.

The safety contract still fails, for three gbrain bugs:

1. **The server's hot-memory cache serves a forgotten claim for up to 30 seconds** (N5-1). In a running stdio or HTTP server, `context_pack` and the `_meta.brain_hot_memory` block attached to every MCP tool response come from a 30-second cache of the ten most recent facts that `forget` never invalidates. Counted run: 2 prohibited `context_pack` outputs on the PGLite cells and 12 on the Postgres cells; 108 PGLite and 304 Postgres remote responses carried a forgotten canary in `_meta` after its forget returned.
2. **Under concurrent CLI writes on PGLite, a forget can leave its page unsearchable** (N5-2). The withdrawal deletes the page's search chunks in its commit and the rebuild stays queued until some later write. In the counted run both late forgets answered `owner_unavailable` although they had committed, and 4 retained neighbors on those pages were missing from search, query and the recall query arm (12 of 750 retained pairs). The repro shows the same loss after forgets that returned ok (2 of 5 rounds).
3. **On PGLite, the first `remember` of a corrected claim after a forget is refused** (N5-3) with `scope_denied: The source file bytes changed after this request was accepted.` The documented way back failed for 2 of 2 corrected claims in the PGLite CLI cell; an identical retry succeeds.

| Contract (PGLite cells, gating) | Result | Denominator |
|---|---|---|
| Prohibited active outputs after forget (target 0) | **2** | 146 witnessed forgotten (canary, tier) pairs, plus 55 never witnessed, over 5 post-forget checkpoints |
| Reactivations (target 0) | 0 | forgotten canaries at 4 checkpoints after `immediate`, plus the refused repeat |
| Collateral expirations (target 0) | 0 | retained canaries in recall, plus the forgotten text remembered on a third entity |
| Unauthorized forgets applied (target 0) | 0 | 2 attempts on the HTTP cell |
| Private canaries in remote responses (target 0) | 0 | every stdio and HTTP response, including `_meta` |
| Retained-neighbor recall (floor 1) | **98.4%** | 738 of 750 witnessed retained pairs |
| Reinstatement of a corrected claim (floor 1) | **66.7%** | 4 of 6 corrected claims |

Postgres cells (report-only outside CI): 12 prohibited outputs (all `context_pack`, N5-1), 0 reactivations, 0 collateral, 0 unauthorized, 0 leaks, retained recall 750 of 750, reinstatement 6 of 6. The verdict is `fail`; the promotion rules fail on `no-prohibited-active-output`, `retained-recall-floor` and `reinstatement-floor`.

The category is listed (it spawns real gbrain processes for minutes per cell), so it does not run in CI yet. Its rules were preregistered before the runner existed (commit `732ea6d`).

## The concrete case

Hazel Example (`people/hazel-example`, fictional) has three remembered canary claims and one fence-authored row, each with a unique marker word such as `cnryxxxxxxxx`. Ivy Example carries the exact text of one of Hazel's claims (a same-text twin). The agent forgets Hazel's claim. The right outcome: Hazel's claim leaves recall, search, query, the recall query arm, `context_pack`, the unstruck fence row and the entity card; Ivy's identical claim and Hazel's other claims stay everywhere they were; the struck `forgotten:` row, page history and vault Git history keep the text by design; a corrected claim ("No longer: keeps bees; now ...") is accepted.

That is what happens, except that for half a minute in a live server `context_pack` still lists the forgotten claim and every tool response's `_meta.brain_hot_memory` still carries it.

## The experiment and results

Runner: `eval/runner/n5-forget-residue.ts`, through the lifecycle harness (`eval/runner/lifecycle/slice.ts` over the lifecycle drivers). gbrain `3a284aea` (v0.60.26.0) through a copied overlay (`--gbrain <checkout>@3a284ae`, tree hash verified, no symlinks). gbrain-evals commit `1dab7dd` (the only uncommitted change was a docs index row). Seed 5, generator `n5-forget-residue-gen@1`, ledger SHA-256 in the receipt. Hermetic: no provider key in any child process, a fresh `GBRAIN_HOME` per cell, `gbrain init --no-embedding`, and `decide status` read per cell with every slot effectively off. Cost $0.

Per cell: 4 fictional people; 26 canaries (8 forgotten, 2 forgotten late during the concurrent round, 2 private, 4 fence-authored, 2 same-text twins, 1 prose canary, 2 paraphrases, 2 corrected claims, 3 concurrent claims). Checkpoints: `witness` (every pair read before any forget), `immediate`, `settled` (commit and incremental sync), `stale_reimport` (the pre-forget files restored, full sync, and a stale page body written back through the transport under test), `restart`, `concurrent` (new claims and two late forgets at once). Private canaries are read through the trusted local caller on remote cells, and every remote response is scanned for them.

| Tier (PGLite cells) | Prohibited | Retained present / witnessed | Forgotten pairs with a witness |
|---|---|---|---|
| recall facts | 0 | 159 / 159 | 30 |
| recall query arm | 0 | 140 / 144 | 24 |
| search | 0 | 140 / 144 | 24 |
| query | 0 | 140 / 144 | 24 |
| context_pack (capped, residue only) | 2 | 94 / 98 (not in the floor) | 14 |
| unstruck fence row | 0 | 159 / 159 | 30 |
| entity card | 0 | never witnessed (the card shows no claims) | 0 |

| Checkpoint (PGLite) | Prohibited | Retained present / witnessed |
|---|---|---|
| immediate | 0 | 156 / 156 |
| settled | 0 | 156 / 156 |
| stale_reimport | 0 | 156 / 156 |
| restart | 0 | 156 / 156 |
| concurrent | 2 | 114 / 126 |

Per cell: PGLite CLI 1028 s, stdio 344 s, HTTP 357 s; Postgres CLI 550 s, stdio 141 s, HTTP 138 s. Primary-call latency over the PGLite cells: p50 63 ms, p95 2,629 ms (1,433 calls; the CLI opens the database per call).

**Erratum before the counted run (N5-7).** The first development run counted `context_pack` in retained recall. Its hot facts are the ten most recent facts in the source, so a retained neighbor drops out when newer facts arrive without any withdrawal. `context_pack` now counts for residue only; the receipt also reports retained recall with it included (98.1% on PGLite).

**Added after the rules were frozen, reported, not gated:** the `_meta.brain_hot_memory` block on MCP responses (found while tracing N5-1). It is the same cache as `context_pack`, so it is reported beside the rules rather than folded into a preregistered count.

## gbrain bugs found

Each has a keyless repro under [2026-10-01-n1-n5/repro/](2026-10-01-n1-n5/repro/) and an entry in the [wave findings ledger](2026-10-01-wave-bugs.md).

### N5-1. The hot-memory cache keeps serving a forgotten fact

- **Contract.** `forget` withdraws a fact from active recall (`src/core/facts/forget.ts` header; `docs/guides/memory-boundaries.md`). The cache says it is "Refreshed on extraction event via `bumpCache`" (`src/core/facts/meta-hook.ts:10`).
- **Mechanism.** `getBrainHotMemoryMeta` (`src/core/facts/meta-hook.ts:65-176`) caches the ten most recent facts per process for 30 s. `context_pack` reads it, and the MCP dispatcher attaches it to every tool response except `recall`, `extract_facts` and `forget_fact` (the `forget` verb is not excluded). `bumpHotMemoryCache` (`meta-hook.ts:179`) has no caller anywhere in `src/`.
- **Repro.** `bun docs/benchmarks/2026-10-01-n1-n5/repro/n5-1-hot-memory-after-forget.ts`: expected `false` after the forget for `context_pack` and `get_page` `_meta`; actual `true` for both. The CLI is unaffected (one process per call).

### N5-2. Under concurrent CLI writes on PGLite, a forget leaves its page unsearchable

- **Contract.** Forget changes only the forgotten claim; a refused write is not applied (`owner_unavailable` is a retryable refusal, `src/core/connectors/item-holds.ts:97`).
- **Mechanism.** `recordFactWithdrawal` deletes the page's chunks inside the commit (`src/core/facts/withdrawal.ts:45-50`) and leaves the rebuild to queued withdrawal-mirror, git and embedding effects. With several CLI processes writing to one PGLite brain, the committing process can exit with those effects still queued (in the counted run after answering `owner_unavailable`), and no process drains them until the next write. The page has 0 chunks meanwhile.
- **Repro.** `bun docs/benchmarks/2026-10-01-n1-n5/repro/n5-2-forget-owner-unavailable.ts` (timing dependent; five rounds; on this machine 2 of 5 rounds lost the neighbor from search with the forget returning ok).

### N5-3. On PGLite, the corrected claim after a forget is refused once

- **Contract.** "Remember a corrected claim. Repeating the old claim does not restore withdrawn memory." (`src/core/facts/write-single.ts:105-110`).
- **Actual.** The first trusted CLI `remember` after a forget on the same entity fails with `scope_denied: The source file bytes changed after this request was accepted.`; an identical retry succeeds. Postgres CLI and both servers accept it on the first try.
- **Repro.** `bun docs/benchmarks/2026-10-01-n1-n5/repro/n5-3-remember-after-forget-pglite.ts`.

## Documented limits (not bugs)

- **Paraphrase.** 6 of 6 paraphrases stayed active after their originals were forgotten; withdrawal matches normalized claims lexically (N5-4, a documented non-guarantee).
- **History and source material.** Forgotten claims remain in `get_versions` (30 token hits), the vault Git history (24), prose outside the fence (9 chunk hits for the prose canary) and as struck `forgotten:` fence rows (126 sightings) on the PGLite cells (N5-5).
- **Exact repeat.** Remembering the exact forgotten claim again is refused with `fact_withdrawn`, as documented; it counted as no reactivation in every cell.
- **Unmeasured tiers.** Dream synthesis and consolidation (takes, synthesized pages) and think need a chat model and were not run (N5-6). Ontology and timeline rows are outside what `forget` touches.
- **Foreign-source caller.** The foreign client's forget fails with `not_found`, which also does not disclose whether the fact exists.

## What to use and what to avoid

Rely on `forget` for the facts index, the fence, chunk search and reimport on both engines. Until N5-1 is fixed, do not treat `context_pack` or MCP `_meta` hot memory as current within 30 seconds of a forget in a long-lived server. On PGLite, retry a corrected `remember` that fails with `scope_denied` right after a forget, and avoid concurrent CLI writers on one PGLite brain (N5-2); run a server instead.

## Reproduce and inspect

```
bun eval/runner/n5-forget-residue.ts --gbrain <gbrain checkout>@3a284aea26889b77c633aebb4149c3016d834ee6 --engines pglite,postgres --pg-url postgres://postgres@127.0.0.1:55432/postgres
```

Postgres needs a pgvector server (for example `docker run -e POSTGRES_HOST_AUTH_METHOD=trust -p 55432:5432 pgvector/pgvector:pg16`); without one the Postgres cells are skipped and the receipt says why. Receipt: [2026-10-01-n1-n5/n5-receipt.json](2026-10-01-n1-n5/n5-receipt.json). Tests: `bun test test/eval/n5-forget-residue.test.ts` (determinism, scorer negatives, the mutation suite graded by the preregistered rules, and a broken in-memory brain whose forget does nothing).
