# Large-page fidelity at large pages Wave B PR 3 (2026-10-20)

## The finding

gbrain `6e10864` (v0.60.324.0) adds large pages Wave B PR 3 (#7104): `append_page` adds text to the end of a page, and upload sessions carry a page larger than one request in parts. It also has the large-pages hardening (#7081). The native arm now appends with `append_page` and writes every document over 4 MiB through an upload session, as the preregistration's arm definition always said it would once gbrain had them. This run is hermetic, cost $0, ran on the default config and follows [Amendment 5](2026-10-14-n14-large-page-fidelity-preregistration.md#amendment-5-2026-10-20-wave-b-pr-3-append-and-upload-sessions), which also lifts the hold on the append rule.

- **Appends are now native and fast.** A 1 KB `append_page` writes one tail segment and re-embeds one chunk on every document. The worst counted ratio is 2.87, so the now-counted append rule (at most 3) passes. Append time drops from 7.0 s to 0.9 s at 20 MB and from 8.4 s to 0.7 s at 24 MiB. At 256 MiB on Postgres it drops from 17.4 s, a whole-file re-import, to 2.4 s.
- **Upload sessions store what the file import stored.** That is 100 MiB and 128 MiB on PGLite, and 100 MiB to 256 MiB on Postgres, the 200 MB chat included. Each stored page is found 40 of 40, read in windows 40 of 40 and exported byte-identical. The 2 MB to 24 MiB results are unchanged from #178.
- **N14-5 is fixed.** After forget, delete and restore, the purge now leaves no segment text on any document, on either engine (it left one text at #178). The ledger marks it fixed by #7081.
- **Safety holds.** There were no crashes, no response over 1 MiB, no byte loss on export and no presence failures, at every size on both engines.

Two things are unchanged, and both were expected before the run:

- **The counted recall-gap rule still fails at 24 MiB** (2.5 points; native 39 of 40 against 40 of 40 for managed parts). The miss is the same needle sentence split across two chunks. The chunker change that would keep it whole is deferred, so it is not in this pin.
- **Forget still cannot run on pages over 24 MiB.** `append_page` refuses facts fence text by design. An upload replace that adds the fence commits through the put path, and that path refuses with `request_too_large` because a fence edit reads the body whole up to 24 MiB. Neither new write path makes the step reachable.

**Verdict on the counted cells (PGLite, every tier up to 200 MB): fail, on one quality threshold.** The safety contracts, the floor and the append rule pass. The recall-gap rule fails at 24 MiB only.

| Rule | Preregistered | #178, switch-on `f717b1a`, PGLite | **PR 3 `6e10864`, PGLite (counted)** | PR 3, Postgres (exploratory) |
|---|---|---|---|---|
| Crashes or OOM kills | 0 | 0 | **0** (2 MB to 260 MiB) | 0 (2 MB to 260 MiB) |
| Responses over 1 MiB | 0 | 0 | **0** | 0 |
| Round-trip byte loss (export) | 0 | 0 | **0** | 0 |
| Presence failures | 0 | 0 | **0** | 0 |
| Native keyword recall@10 at 2 MB | ≥ 0.90 | 1.00 | **1.00** | 1.00 |
| Native recall gap to managed parts | ≤ 2 points | 0, 0, 2.5 (24 MiB): fail | 0 (2 MB), 0 (20 MB), **2.5 (24 MiB): fail** | 0 (2 MB) |
| Native append ratio, worst document | ≤ 3 | held: 2.76 (2 MB), 2.87 (20 MB), 2.34 (24 MiB) | **counted: 2.76 (2 MB), 2.87 (20 MB), 2.34 (24 MiB): pass** | 3.74 (2 MB novel): over, see below |

Counted means the cell is under the preregistered rules, at a tier the preregistration covers (up to 200 MB), on the preregistered engine, PGLite. PGLite at 256 MiB and 260 MiB, every Postgres cell and the lifecycle are exploratory: they are reported against the same rules and do not count. No paid cell ran, because the paid arm needs model calls and this run had no budget. The registry row stays held only for the trusted-local egress rule, which still waits on a product decision.

## The experiment

**What ran.** gbrain-evals pins gbrain `6e1086492dbded0059fcfabc627b846ced7855f4` (v0.60.324.0), and every run also names it through `--gbrain`. No run sets any brain config: every receipt has `config_overlay: null`. The receipts come from runner commit `0342d8ac` with a clean source tree, and Amendment 5 is committed in that same commit, before any counted run. Bun 1.4.2 ran inside a `MemoryMax=6G` scope on a 4-core machine, with tiers over 2 MB one child at a time. Postgres is a local `pgvector/pgvector:pg16` server (16.15), with a fresh database per child.

The tiers, documents, engines and arms are those of #178:

- **PGLite (in-memory):** 2 MB (chat, project log, novel), 20 MB and 24 MiB with all three arms. 100 MiB, 128 MiB, 200 MB, 256 MiB and 260 MiB on the single-page and native arms.
- **Postgres:** 2 MB with all three arms. 100 MiB to 260 MiB on the single-page and native arms.
- **Every run adds the lifecycle** (`--lifecycle`).

**What changed in the harness (Amendment 5):**

- **Probe.** The capability probe finds `append_page` and the three upload operations.
- **Writes over 4 MiB.** The native arm writes through an upload session. Parts end on code points, and each part's frame fits the session's `part_max_frame_bytes` (4,190,208 bytes for a trusted local caller). This replaces #178's `--native-ingest import` at 100 MiB and above. Documents up to 4 MiB keep `put_page`.
- **Appends.** The native arm calls `append_page` with `separator: 'none'`, after the source's trailing whitespace. gbrain stores a body trimmed, so this keeps the page equal to the source plus the append, which is what the round trip compares.
- **The lifecycle fence.** The native arm writes it through an upload replace when the page is over 4 MiB.
- **Diagnostics.** A failed write request now reports its reason and detail.

Development smoke runs of the chat on the native arm at 2 MB, 24 MiB, 100 MiB and 128 MiB came before the amendment and are not results. One of them found the separator mismatch above: one byte, caused by the harness's call.

## Results

**Storage, recall, reads and round trip.** Recall is keyword needle recall@10 over 40 needles, 4 per decile.

| Tier | Engine | Arm (write path) | Storage (segments), chunks | Recall@10 | Correct windowed reads | Export round trip |
|---|---|---|---|---|---|---|
| 2 MB chat / log / novel | both | native (`put_page`) | segmented (8 / 8 / 6), 905 / 808 / 658 | 40/40 each | 40/40 each | match |
| 2 MB | both | single-page / managed parts | as #178 | 40/40 each | 0/40 / 40/40 | match |
| 20 MB chat | PGLite | native (upload) / single-page / parts | segmented (74), 8,893 / same / 8,695 | 40/40 | 40/40 / 0/40 / 40/40 | match |
| 24 MiB chat | PGLite | native (upload) / single-page / parts | segmented (96), 11,209 / same / 10,892 | **39/40** / 39/40 / 40/40 | 39/39 / 0/39 / 40/40 | match |
| 100 MiB | both | native (upload) | segmented (362), 46,603 | 40/40 | 40/40 | match |
| 128 MiB | both | native (upload) | segmented (486), 59,722 | 40/40 | 40/40 | match |
| 200 MB | Postgres | native (upload) | segmented (727), 89,006 | 40/40 | 40/40 | match |
| 256 MiB | Postgres | native (upload) | segmented (829), 119,464 | 40/40 | 40/40 | match |
| 200 MB, 256 MiB | PGLite | native (upload) | refused `request_too_large` at `begin_page_upload` (ceiling 128 MiB) | 0/40 | – | not stored |
| 260 MiB | both | native (upload) | refused `request_too_large` at `begin_page_upload` | 0/40 | – | not stored |
| 100 MiB to 260 MiB | both | single-page (`put_page`) | refused `request_too_large` (24 MiB per call) | 0/40 | – | not stored |

The storage, chunk counts and recall match #178 cell for cell. The only refusal that changed is the code for a document over the engine ceiling: the file import refused it as `file_too_large`, and `begin_page_upload` refuses it as `request_too_large` before staging anything. That is the documented code for an upload over the page ceiling.

**The 24 MiB miss.** It is the same needle as #178: the decile-6 name, "the Pykemere harbor pilot is Oswin Dalrymple". Chunk 7138 ends with "…the Pykemere harbor pilot is Oswin", and keyword search returns that chunk for the page. The delivered window runs on into the next chunk, so delivered recall is 40/40, but the preregistered test reads the stored chunk the result names. The chunker change that would keep the sentence whole is deferred, so this was expected to fail again, and it did.

**Responses.** Search results, write receipts and upload calls were at most 10,359 bytes on the chat and log, and the largest native response was 21,057 bytes (a windowed read of the novel). The agent-facing default read is 23,610 to 35,678 bytes at every size, and 25,982 bytes at 256 MiB. As in #178, the trusted-local default `get_page` of a segmented page refuses with `page_body_segmented`. That is why single-page reads are 0 of 40, and the egress rule passes because the full read refuses, not because it is bounded.

**Append cost.** These are embedding inputs sent after the 1 KB append, counted in process, with tokens estimated as bytes / 4. Native arm, PGLite. The ratios are counted from this run.

| Tier | Document | Path: #178 → now | Segments written / live | Chunks re-chunked | Inputs / tokens / appended | Ratio | Append time: #178 → now |
|---|---|---|---|---:|---|---|---|
| 2 MB | chat | `put_page` → `append_page` | 1 / 8 | 70 | 1 / 355 / 261 | 1.36 | 1.0 s → 0.4 s |
| 2 MB | log | `put_page` → `append_page` | 1 / 8 | 64 | 1 / 690 / 250 | 2.76 | 1.0 s → 0.3 s |
| 2 MB | novel | `put_page` → `append_page` | 1 / 6 | 16 | 1 / 501 / 268 | 1.87 | 0.6 s → 0.2 s |
| 20 MB | chat | `put_page` → `append_page` | 1 / 74 | 87 | 1 / 741 / 258 | 2.87 | 7.0 s → 0.9 s |
| 24 MiB | chat | `put_page` → `append_page` | 1 / 96 | 43 | 1 / 597 / 255 | 2.34 | 8.4 s → 0.7 s |

The embedding work is the same as at #178: segmented storage already rewrote only the tail segment and its chunks. What `append_page` changes is the write. It no longer sends the whole page back, so its time depends on the text added, not on the page. At 100 MiB to 256 MiB, with no embed pass, the append writes one tail segment and re-chunks 31 to 112 chunks:

| Tier | Engine | Append time: #178 (whole-file re-import) → now (`append_page`) |
|---|---|---|
| 100 MiB | PGLite / Postgres | 7.7 s → 1.4 s / 6.9 s → 1.1 s |
| 128 MiB | PGLite / Postgres | 9.4 s → 1.8 s / 9.1 s → 1.3 s |
| 200 MB | Postgres | 13.2 s → 1.7 s |
| 256 MiB | Postgres | 17.4 s → 2.4 s |

**An exploratory Postgres cell over the threshold.** On Postgres the native novel append sent 2 embedding inputs of 501 tokens each (ratio 3.74), where PGLite and the other Postgres arms sent 1. It is intermittent. Over this run and 8 repeat runs of the Postgres 2 MB native arm, 5 of 23 document runs sent a doubled input: the novel 4 times and the log once (5.52). The same doubling showed on the Postgres single-page arm in #178 (log 5.52, novel 3.74), which wrote with `put_page`, so it predates PR 3 and does not depend on the write path. It never happened on PGLite (0 of 9 native document runs with an embed pass, here and in the smoke runs). The doubled count is exactly twice the single chunk's tokens, which points to one stale chunk being sent twice by the embed pass on Postgres. This run does not prove that, and it is not filed as a bug. Postgres cells are exploratory, so it does not change the verdict.

**Time and memory (exploratory).** Ingest time runs until the page is searchable, which for an upload includes polling the `write_pending` commit and waiting for the projection seal.

| Tier | Engine | Native ingest: #178 → now | RSS at ingest: #178 → now | Whole child peak: #178 → now | What now-ingest includes |
|---|---|---|---|---|---|
| 2 MB chat | PGLite / Postgres | 2.1 / 2.1 s → 2.1 / 2.0 s | 1,148 / 370 → 1,154 / 370 MB | 1,602 / 485 → 1,643 / 486 MB | `put_page`, sealed at the reply |
| 20 MB chat | PGLite | 15.8 → 14.3 s | 2,685 → 1,884 MB | 4,064 → 3,979 MB | upload, seal 6.9 s |
| 24 MiB chat | PGLite | 19.5 → 17.5 s | 2,951 → 1,856 MB | 4,716 → 4,409 MB | upload, seal 9.2 s |
| 100 MiB | PGLite / Postgres | 54.4 / 51.5 → 60.4 / 59.1 s | 1,895 / 818 → 2,661 / 915 MB | 3,391 / 2,018 → 4,942 / 2,307 MB | upload, commit polled 8.4 / 7.6 s, seal 41.2 / 39.5 s |
| 128 MiB | PGLite / Postgres | 70.2 / 64.0 → 76.8 / 72.3 s | 2,044 / 941 → 3,163 / 1,076 MB | 4,255 / 2,663 → 4,946 / 2,761 MB | upload, seal 53.2 / 49.7 s |
| 200 MB | Postgres | 94.6 → 107.3 s | 1,066 → 1,517 MB | 3,304 → 3,325 MB | upload, seal 73.1 s |
| 256 MiB | Postgres | 124.3 → 151.8 s | 1,164 → 1,821 MB | 4,348 → 4,341 MB | upload, seal 103.1 s |

Below 100 MiB the upload is a little faster and lighter than `put_page` was. From 100 MiB up it is 9 to 22% slower than the file import and holds more memory on PGLite. Part of that is the harness: it sends the parts in process from a string it already holds. The whole-child peak includes the harness's own copies of the document for the export comparison, so it overstates gbrain. The highest peak was 4,946 MB, under the 6 GiB ceiling.

## Lifecycle (exploratory)

The lifecycle ran after the round trip on every stored single-page and native page, with one needle query per decile (ten probes).

| Step | 2 MB (all three documents), 20 MB, 24 MiB, both engines | 100 MiB to 256 MiB (stored ones), both engines |
|---|---|---|
| Forget a one-row facts fence | fact row created, `forget_fact` withdraws it, `recall` returns 0, exported row struck (the 20 MB and 24 MiB native fences came in through an upload replace) | fence write through an upload replace refused: the commit ends `request_too_large` and nothing is saved, so the step did not run |
| Soft delete | 0 of 10 probes found, `get_page` → `page_not_found` | the same |
| Restore | 10 of 10 found, export byte-identical to the one before the delete | the same |
| Purge (`purge: true`) | every row 0, no chunk or segment text holds a needle, **0 unreferenced segment texts** (#178: 1 text, 38,277 to 195,792 bytes) | every row 0, no segment text left |

N14-5 is closed: the purge leaves nothing before any sweep, on the same documents and engines where it reproduced at #178.

Forget above 24 MiB stays unreachable through either new write path. `append_page` refuses facts fence markers ("append_page adds ordinary text only"), and an upload replace commits through `put_page`, which edits fences by reading the body whole up to 24 MiB. A smaller path, such as `remember` writing into a segmented page's fence, is outside the preregistered step and did not run.

## gbrain bugs, updated

- **N14-5 is fixed** (a purge after `forget_fact`, delete and restore left a segment text until GC), by the large-pages hardening (#7081, v0.60.315.0): a page purge deletes the unreferenced texts that hold the page's claims.
- No new bug is filed. The Postgres double embed above is recorded as an exploratory observation without a root cause.

## Errata

None. The #178 report stands as published. Two of its statements describe `f717b1a` and are no longer true at `6e10864`: "The append is still a whole-page write, because `append_page` (Wave B PR 3) is not built", and that N14-5 is open.

## Reproduce

```
git -C <gbrain checkout> fetch origin && git -C <gbrain checkout> checkout 6e1086492dbded0059fcfabc627b846ced7855f4
docker run -d --name n14pg -e POSTGRES_USER=n14 -e POSTGRES_PASSWORD=n14 -p 127.0.0.1:55432:5432 pgvector/pgvector:pg16
export N14_PG_ADMIN_URL=postgres://n14:n14@127.0.0.1:55432/postgres
G="--gbrain <checkout>@6e1086492dbded0059fcfabc627b846ced7855f4"; BIG="--arms single-page,native --concurrency 1"
bun eval/runner/n14-large-page-fidelity.ts $G --tiers 2mb --lifecycle --output <dir>/pglite/2mb
bun eval/runner/n14-large-page-fidelity.ts $G --tiers 20mb --concurrency 1 --lifecycle --output <dir>/pglite/20mb
bun eval/runner/n14-large-page-fidelity.ts $G --tiers 24mib --concurrency 1 --lifecycle --output <dir>/pglite/24mib
bun eval/runner/n14-large-page-fidelity.ts $G --tiers 100mib,128mib,200mb,256mib,260mib $BIG --lifecycle --output <dir>/pglite/large
bun eval/runner/n14-large-page-fidelity.ts $G --tiers 2mb --engine postgres --lifecycle --output <dir>/postgres/2mb
bun eval/runner/n14-large-page-fidelity.ts $G --tiers 100mib,128mib,200mb,256mib,260mib $BIG --engine postgres --lifecycle --output <dir>/postgres/large
```

Each run needs Bun 1.4 or newer and no keys. The PGLite 2 MB run exits 0 (verdict pass). The Postgres 2 MB run exits 1 on the novel's doubled append input above, and passes when that does not happen. The others exit 1, because a receipt without the 2 MB tier or the managed-parts arm has no value for the floor or the gap, and the 24 MiB receipt fails the gap.

Hermetic arm times:

| Engine | 2 MB | 20 MB | 24 MiB | 100 MiB to 260 MiB |
|---|---|---|---|---|
| PGLite | 87.4 s | 505.9 s | 643.3 s | 376.7 s |
| Postgres | 70.0 s | – | – | 815.6 s |

Receipts:

- PGLite: [2mb](2026-10-20-n14-large-page-fidelity-wave-b3/pglite/2mb/receipt.json), [20mb](2026-10-20-n14-large-page-fidelity-wave-b3/pglite/20mb/receipt.json), [24mib](2026-10-20-n14-large-page-fidelity-wave-b3/pglite/24mib/receipt.json), [100mib to 260mib](2026-10-20-n14-large-page-fidelity-wave-b3/pglite/large/receipt.json)
- Postgres: [2mb](2026-10-20-n14-large-page-fidelity-wave-b3/postgres/2mb/receipt.json), [100mib to 260mib](2026-10-20-n14-large-page-fidelity-wave-b3/postgres/large/receipt.json)

Earlier reports: [Wave B PR 2 and the switch-on (#178)](2026-10-18-n14-large-page-fidelity-wave-b2.md), [Wave B PR 1](2026-10-15-n14-large-page-fidelity-wave-b1.md), [Wave A](2026-10-15-n14-large-page-fidelity-wave-a.md), [baseline](2026-10-14-n14-large-page-fidelity-baseline.md).
