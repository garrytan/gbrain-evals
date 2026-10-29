# Large-page fidelity at large pages Wave B PR 4 (2026-10-25)

## The finding

gbrain `7a6bdd3` (v0.60.454.0) contains large pages Wave B PR 4 (#7316, v0.60.453.0). On segmented pages, a forced chunk cut now lands on a sentence or line end. Links, timeline entries, fences, facts and synopses are kept per segment, and a per-page lease sends each chunk to the embedding provider once. This run is hermetic, cost $0, ran on the default config and follows [Amendment 6](2026-10-14-n14-large-page-fidelity-preregistration.md#amendment-6-2026-10-25-wave-b-pr-4-per-segment-derivations-and-sentence-aligned-cuts). That amendment changes no rule, arm or harness code since #180.

**Verdict on the counted cells (PGLite, every tier up to 200 MB): pass.** For the first time, every preregistered hermetic rule passes:

- the four safety contracts
- the 2 MB recall floor
- the append rule (worst 2.87)
- the recall-gap rule, which failed at 24 MiB in #178 and #180 and now passes there with a gap of 0

What changed:

- **The 24 MiB split needle is found.** The decile-6 name ("the Pykemere harbor pilot is Oswin Dalrymple") was cut mid-sentence at #180. It now sits whole in one chunk, which search returns first, so the 24 MiB chat is found 40 of 40 on the native and single-page arms.
- **Fewer chunks on segmented pages, the same recall.** Sentence-aligned cuts give 2 to 4% fewer chunks: 10,847 against 11,209 at 24 MiB, and 115,616 against 119,464 at 256 MiB. Every stored page is still found 40 of 40, read in windows 40 of 40 and exported byte-identical. Managed parts, which are inline pages, are unchanged.
- **The Postgres double embed is gone.** #180 saw an append on Postgres sometimes send the embedder a doubled input (5 of 23 document runs). Here it happened in 0 of 30 document runs on Postgres: 6 in the counted run and 24 in the 8 preregistered repeats. PR 4's per-page embed lease is the likely reason, but this run does not prove it.
- **Appends stay cheap.** A 1 KB `append_page` writes one tail segment and re-embeds one chunk. It re-chunks slightly fewer chunks (39 against 43 at 24 MiB) and takes 0.2 to 2.2 s.

Unchanged and still short:

- **Forget on pages over 24 MiB is still unreachable.** An upload replace that adds the facts fence still ends `request_too_large` at 100 MiB and above on both engines. PR 4 keeps fences per segment, but the fence write through the put path still reads the body whole up to 24 MiB.
- **Ingest at 100 MiB and above is 5 to 14% slower** than at #180, mostly in the projection seal (exploratory).

| Rule | Preregistered | #180, PR 3 `6e10864`, PGLite | **PR 4 `7a6bdd3`, PGLite (counted)** | PR 4, Postgres (exploratory) |
|---|---|---|---|---|
| Crashes or OOM kills | 0 | 0 | **0** (2 MB to 260 MiB) | 0 (2 MB to 260 MiB) |
| Responses over 1 MiB | 0 | 0 | **0** | 0 |
| Round-trip byte loss (export) | 0 | 0 | **0** | 0 |
| Presence failures | 0 | 0 | **0** | 0 |
| Native keyword recall@10 at 2 MB | ≥ 0.90 | 1.00 | **1.00** | 1.00 |
| Native recall gap to managed parts | ≤ 2 points | 0, 0, 2.5 at 24 MiB: fail | **0 (2 MB), 0 (20 MB), 0 (24 MiB): pass** | 0 (2 MB) |
| Native append ratio, worst document | ≤ 3 | 2.76 / 2.87 / 2.34: pass | **2.76 / 2.87 / 2.34: pass** | 2.76 (2 MB): pass |
| **Counted verdict** | | fail (gap at 24 MiB) | **pass** | – |

Counted means the cell is under the preregistered rules, at a tier the preregistration covers (up to 200 MB), on the preregistered engine, PGLite. PGLite at 256 MiB and 260 MiB, every Postgres cell, the repeats and the lifecycle are exploratory: they are reported against the same rules and do not count. Each per-tier receipt also says `fail` when it lacks the 2 MB tier or the managed-parts arm, because then it has no value for the floor or the gap; the counted verdict pools the PGLite receipts. No paid cell ran, so per-segment fact extraction and synopses, which need a model, are not measured. The registry row stays held only for the trusted-local egress rule, which still waits on a product decision.

## The experiment

**What ran.** gbrain-evals pins gbrain `7a6bdd3579a3c35d57c63790b428a746fe2f3df7` (v0.60.454.0), and every run also names it through `--gbrain`. No run sets any brain config: every receipt has `config_overlay: null`. The receipts come from commit `882eb72d` with a clean source tree; Amendment 6 was committed before it, before any counted run. Bun 1.4.2 ran inside a `MemoryMax=6G` scope on a 4-core machine, with tiers over 2 MB one child at a time. Postgres is a local `pgvector/pgvector:pg16` server (16.15), with a fresh database per child.

The tiers, documents, engines, arms and write paths are those of #180:

- **PGLite (in-memory):** 2 MB (chat, project log, novel), 20 MB and 24 MiB with all three arms. 100 MiB, 128 MiB, 200 MB, 256 MiB and 260 MiB on the single-page and native arms.
- **Postgres:** 2 MB with all three arms. 100 MiB to 260 MiB on the single-page and native arms.
- **Native writes:** `put_page` up to 4 MiB, an upload session above it, and `append_page` for the append.
- **Lifecycle:** every run adds it.
- **Exploratory repeats:** 8 more runs of the Postgres 2 MB native arm, without the lifecycle, to recheck the doubled embed. Their receipts are not in the repository.

**Not measured.** N14 writes pages through gbrain's operations, not transcript ingest, so PR 4's one-page transcripts have no cell here. PR 4's incremental derivations are measured only through the existing append cells: embedding inputs, chunks rewritten, segments written and append time.

## Results

**Storage, recall, reads and round trip.** Recall is keyword needle recall@10 over 40 needles, 4 per decile. The chunk counts are now → #180.

| Tier | Engine | Arm (write path) | Segments, chunks | Recall@10 | Correct windowed reads | Export round trip |
|---|---|---|---|---|---|---|
| 2 MB chat / log / novel | both | native (`put_page`) | 8 / 8 / 6, 873 / 796 / 637 (was 905 / 808 / 658) | 40/40 each | 40/40 each | match |
| 2 MB | both | single-page / managed parts | as native / inline 754 / 824 / 667 (unchanged) | 40/40 each | 0/40 / 40/40 | match |
| 20 MB chat | PGLite | native (upload) / single-page / parts | 74, 8,613 (was 8,893) / same / 8,695 | 40/40 | 40/40 / 0/40 / 40/40 | match |
| 24 MiB chat | PGLite | native (upload) / single-page / parts | 96, 10,847 (was 11,209) / same / 10,892 | **40/40** (was 39/40) / 40/40 / 40/40 | 40/40 / 0/40 / 40/40 | match |
| 100 MiB | both | native (upload) | 362, 45,150 (was 46,603) | 40/40 | 40/40 | match |
| 128 MiB | both | native (upload) | 486, 57,872 (was 59,722) | 40/40 | 40/40 | match |
| 200 MB | Postgres | native (upload) | 727, 86,072 (was 89,006) | 40/40 | 40/40 | match |
| 256 MiB | Postgres | native (upload) | 829, 115,616 (was 119,464) | 40/40 | 40/40 | match |
| 200 MB, 256 MiB | PGLite | native (upload) | refused `request_too_large` at `begin_page_upload` (ceiling 128 MiB) | 0/40 | – | not stored |
| 260 MiB | both | native (upload) | refused `request_too_large` at `begin_page_upload` | 0/40 | – | not stored |
| 100 MiB to 260 MiB | both | single-page (`put_page`) | refused `request_too_large` (24 MiB per call) | 0/40 | – | not stored |

**The 24 MiB needle.** At #180, keyword search returned a chunk that ended "…the Pykemere harbor pilot is Oswin", so the preregistered hit test, which reads the stored chunk the result names, scored a miss. PR 4's forced cut now ends a chunk at a sentence or line end, the sentence sits whole in one chunk, and that chunk ranks first (`hit_rank` 1 on both arms). This is the deferred chunker change that #180 expected, now in the pin. Existing pages keep their old chunks until an operator runs `gbrain reindex --segmented`. Every brain here is new, so that does not apply.

**Responses.** Search results and write receipts were at most 10,359 bytes, and the largest native response was 21,073 bytes (a windowed read of the novel). The agent-facing default read is 23,626 to 35,694 bytes at every size, and 25,998 bytes at 256 MiB. As before, the trusted-local default `get_page` of a segmented page refuses with `page_body_segmented`, so single-page reads are 0 of 40. The egress rule passes because the full read refuses, not because it is bounded.

**Append cost.** These are embedding inputs sent after the 1 KB append, counted in process, with tokens estimated as bytes / 4. Native arm, `append_page`, PGLite.

| Tier | Document | Segments written / live | Chunks re-chunked: #180 → now | Inputs / tokens / appended | Ratio (counted) | Append time: #180 → now |
|---|---|---|---|---|---|---|
| 2 MB | chat | 1 / 8 | 70 → 67 | 1 / 355 / 261 | 1.36 | 0.4 s → 0.4 s |
| 2 MB | log | 1 / 8 | 64 → 63 | 1 / 690 / 250 | 2.76 | 0.3 s → 0.3 s |
| 2 MB | novel | 1 / 6 | 16 → 16 | 1 / 501 / 268 | 1.87 | 0.2 s → 0.2 s |
| 20 MB | chat | 1 / 74 | 87 → 86 | 1 / 741 / 258 | 2.87 | 0.9 s → 0.9 s |
| 24 MiB | chat | 1 / 96 | 43 → 39 | 1 / 597 / 255 | 2.34 | 0.7 s → 0.7 s |

At 100 MiB to 256 MiB, with no embed pass, the append writes one tail segment and re-chunks 31 to 108 chunks (#180: 31 to 112). It takes 1.4 s and 1.1 s at 100 MiB (PGLite / Postgres), 1.7 s and 1.3 s at 128 MiB, 1.7 s at 200 MB and 2.2 s at 256 MiB (#180: 1.1 to 2.4 s). The append cost was already incremental at #180 for embeddings. PR 4 makes the free derivations incremental too, and this run shows no cost from that on the append.

**The Postgres double embed (exploratory).** At #180 the Postgres 2 MB novel or log append sometimes sent the embedder two inputs where one chunk changed (5 of 23 document runs; never on PGLite). Here every append on Postgres sent one input: 6 of 6 in the counted run (single-page and native arms) and 24 of 24 in the 8 repeats. PGLite sent one input every time, as before. PR 4 adds a per-page lease so that each chunk content version goes to the provider once, which fits the observation. This run did not isolate the cause. The Postgres 2 MB receipt now passes every rule.

**Time and memory (exploratory).** Ingest time runs until the page is searchable: for an upload, until the `write_pending` commit settles and the projection seals.

| Tier | Engine | Native ingest: #180 → now | Projection seal now | Whole child peak now |
|---|---|---|---|---|
| 2 MB chat | PGLite / Postgres | 2.1 / 2.0 s → 2.1 / 1.9 s | at the reply | 1,647 / 502 MB |
| 20 MB chat | PGLite | 14.3 → 13.9 s | 6.8 s | 3,850 MB |
| 24 MiB chat | PGLite | 17.5 → 17.6 s | 10.0 s | 4,361 MB |
| 100 MiB | PGLite / Postgres | 60.4 / 59.1 → 65.9 / 62.5 s | 47.2 / 46.0 s (was 41.2 / 39.5) | 4,996 / 2,157 MB |
| 128 MiB | PGLite / Postgres | 76.8 / 72.3 → 83.6 / 81.1 s | 61.8 / 57.2 s (was 53.2 / 49.7) | 4,920 / 2,554 MB |
| 200 MB | Postgres | 107.3 → 122.3 s | 87.9 s (was 73.1) | 3,390 MB |
| 256 MiB | Postgres | 151.8 → 159.0 s | 117.8 s (was 103.1) | 4,357 MB |

Up to 24 MiB ingest is unchanged. From 100 MiB up it is 5 to 14% slower, and the extra time is in the projection seal, which now also writes per-segment derivation state. The whole-child peak includes the harness's own copies of the document, so it overstates gbrain. The highest was 4,996 MB, under the 6 GiB ceiling.

## Lifecycle (exploratory)

The lifecycle ran after the round trip on every stored single-page and native page, with one needle query per decile (ten probes). The results match #180.

| Step | 2 MB (all three documents), 20 MB, 24 MiB, both engines | 100 MiB to 256 MiB (stored ones), both engines |
|---|---|---|
| Forget a one-row facts fence | fact row created, `forget_fact` withdraws it, `recall` returns 0, exported row struck | fence write through an upload replace refused: the commit ends `request_too_large` and nothing is saved, so the step did not run |
| Soft delete | 0 of 10 probes found, `get_page` → `page_not_found` | the same |
| Restore | 10 of 10 found, export byte-identical to the one before the delete | the same |
| Purge (`purge: true`) | every row 0, no chunk or segment text holds a needle, 0 unreferenced segment texts | the same |

N14-5 stays fixed. PR 4 also deletes stored link, mention, timeline and fence results with a forgotten fact. N14 does not inspect those tables, so that change is not measured here.

## gbrain bugs, updated

No change. N14-5 stays fixed (confirmed again on both engines), and no new bug is filed.

## Errata

None. The #180 report stands as published. Two of its statements describe `6e10864` and are no longer true at `7a6bdd3`: the recall-gap rule failing at 24 MiB, and the intermittent Postgres double embed.

## Reproduce

```
git -C <gbrain checkout> fetch origin && git -C <gbrain checkout> checkout 7a6bdd3579a3c35d57c63790b428a746fe2f3df7
docker run -d --name n14pg -e POSTGRES_USER=n14 -e POSTGRES_PASSWORD=n14 -p 127.0.0.1:55432:5432 pgvector/pgvector:pg16
export N14_PG_ADMIN_URL=postgres://n14:n14@127.0.0.1:55432/postgres
G="--gbrain <checkout>@7a6bdd3579a3c35d57c63790b428a746fe2f3df7"; BIG="--arms single-page,native --concurrency 1"
bun eval/runner/n14-large-page-fidelity.ts $G --tiers 2mb --lifecycle --output <dir>/pglite/2mb
bun eval/runner/n14-large-page-fidelity.ts $G --tiers 20mb --concurrency 1 --lifecycle --output <dir>/pglite/20mb
bun eval/runner/n14-large-page-fidelity.ts $G --tiers 24mib --concurrency 1 --lifecycle --output <dir>/pglite/24mib
bun eval/runner/n14-large-page-fidelity.ts $G --tiers 100mib,128mib,200mb,256mib,260mib $BIG --lifecycle --output <dir>/pglite/large
bun eval/runner/n14-large-page-fidelity.ts $G --tiers 2mb --engine postgres --lifecycle --output <dir>/postgres/2mb
bun eval/runner/n14-large-page-fidelity.ts $G --tiers 100mib,128mib,200mb,256mib,260mib $BIG --engine postgres --lifecycle --output <dir>/postgres/large
for i in 1 2 3 4 5 6 7 8; do bun eval/runner/n14-large-page-fidelity.ts $G --tiers 2mb --arms native --engine postgres --output <dir>/repeats/$i; done
```

Each run needs Bun 1.4 or newer and no keys. The two 2 MB runs exit 0 (verdict pass). The others exit 1, because a receipt without the 2 MB tier or the managed-parts arm has no value for the floor or the gap.

Hermetic arm times:

| Engine | 2 MB | 20 MB | 24 MiB | 100 MiB to 260 MiB |
|---|---|---|---|---|
| PGLite | 89.3 s | 497.6 s | 633.1 s | 382.9 s |
| Postgres | 67.8 s | – | – | 823.7 s |

Receipts:

- PGLite: [2mb](2026-10-25-n14-large-page-fidelity-wave-b4/pglite/2mb/receipt.json), [20mb](2026-10-25-n14-large-page-fidelity-wave-b4/pglite/20mb/receipt.json), [24mib](2026-10-25-n14-large-page-fidelity-wave-b4/pglite/24mib/receipt.json), [100mib to 260mib](2026-10-25-n14-large-page-fidelity-wave-b4/pglite/large/receipt.json)
- Postgres: [2mb](2026-10-25-n14-large-page-fidelity-wave-b4/postgres/2mb/receipt.json), [100mib to 260mib](2026-10-25-n14-large-page-fidelity-wave-b4/postgres/large/receipt.json)

Earlier reports: [Wave B PR 3 (#180)](2026-10-20-n14-large-page-fidelity-wave-b3.md), [Wave B PR 2 and the switch-on (#178)](2026-10-18-n14-large-page-fidelity-wave-b2.md), [Wave B PR 1](2026-10-15-n14-large-page-fidelity-wave-b1.md), [Wave A](2026-10-15-n14-large-page-fidelity-wave-a.md), [baseline](2026-10-14-n14-large-page-fidelity-baseline.md).
