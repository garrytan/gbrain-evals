# Large-page fidelity at large pages Wave B PR 2 and the switch-on (2026-10-18)

## The finding

gbrain `f717b1a5` (v0.60.299.0) turns segmented page storage on by default (#6963) on top of Wave B PR 2 (#6900), which taught reads, forget and purge, delete and restore, and export to handle segmented pages. With no config overlay, a page over 1 MiB is now stored in segments, and the file import writes pages up to the engine ceiling: 128 MiB on PGLite, 256 MiB on Postgres. This run is hermetic, cost $0, and follows [Amendment 4](2026-10-14-n14-large-page-fidelity-preregistration.md#amendment-4-2026-10-18-wave-b-pr-2-and-the-switch-on-default-config).

- **Found and read at every stored size.** Every stored page is found 40 of 40, and windowed reads are 40 of 40: the three 2 MB documents, the 20 MB chat, 100 MiB and 128 MiB on both engines, and the 200 MB chat and 256 MiB on Postgres. The one exception is the 24 MiB chat, at 39 of 40.
- **Export round trips match everywhere**, and no response exceeds 1 MiB at any size on either engine. At PR 1 export refused every segmented page, and reads were 0 of 40.
- **Large documents now fit.** The 200 MB chat that every earlier run refused is stored on Postgres. It is found 40 of 40 and exports byte-identical, and the import takes 94.6 s. On PGLite, 200 MB and 256 MiB are refused with `file_too_large` at the documented 128 MiB ceiling. On Postgres, 260 MiB is refused at the 256 MiB ceiling. `put_page` stays limited to 24 MiB per call by design, so N14-2 closes.
- **Appends stay cheap.** A 1 KB append writes one tail segment and re-embeds one chunk on every native document at 2 MB, 20 MB and 24 MiB. The worst native ratio is 2.87, so the 2 MB chat's 4.35 at PR 1 is gone (now 1.36).

Three things fall short:

- **The counted recall-gap rule fails at 24 MiB.** Native and single-page recall is 39 of 40, against 40 of 40 for managed parts, a 2.5-point gap against the 2-point rule. One needle's sentence is split across two chunks. Search returns the chunk that ends with the question's words but not the answer. The text delivered to the agent does hold the answer, so delivered recall is 40 of 40.
- **New bug N14-5: a purge can leave page text behind.** On a segmented page, `forget_fact` followed by a soft delete and a restore leaves one earlier segment text unreferenced. The purge then reports success, while that text, holding 6 of the 42 planted answers on the 2 MB chat, stays in `page_segment_texts` until the 1 h segment GC runs. This reproduced on every document at 2 MB, 20 MB and 24 MiB, on both engines.
- **Forget does not work on pages over 24 MiB.** Writing a facts fence on a page over 24 MiB refuses with `file_too_large`, as the PR 2 notes document, so the forget step of the lifecycle cannot run there.

**Verdict on the counted cells (PGLite, every tier up to 200 MB): fail, on one quality threshold.** The safety contracts and the floor pass. The recall-gap rule fails at 24 MiB only. The append-ratio rule is held pending Wave B PR 3, and its values would pass.

| Rule | Preregistered | Wave A `44eb049` (#159) | PR 1, switch forced on `7f3c9f5` (#165) | Switch-on `f717b1a`, PGLite (counted) | Switch-on, Postgres (exploratory) |
|---|---|---|---|---|---|
| Crashes or OOM kills | 0 | 0 | 0 | **0** (2 MB to 260 MiB) | 0 (2 MB to 260 MiB) |
| Responses over 1 MiB | 0 | 126 (2 MB), 42 (20 MB) | 0, because every read was refused | **0** | 0 |
| Round-trip byte loss (export) | 0 | 0 | 6 (2 MB), 2 (20 MB): export refused | **0** | 0 |
| Presence failures | 0 | 0 | 0 | **0** | 0 |
| Native keyword recall@10 at 2 MB | ≥ 0.90 | 1.00 | 1.00 | **1.00** | 1.00 |
| Native recall gap to managed parts | ≤ 2 points | 0 | 0 | 0 (2 MB), 0 (20 MB), **2.5 (24 MiB): fail** | 0 (2 MB) |
| Native append ratio, worst document (held pending PR 3) | ≤ 3 | 2.76 (2 MB), 2.87 (20 MB) | 4.35 (2 MB chat), 2.87 | 2.76 (2 MB), 2.87 (20 MB), 2.34 (24 MiB), reported | 2.76 (2 MB) |

Counted means the cell is under the preregistered rules at a tier the preregistration covers (up to 200 MB) on the preregistered engine, PGLite. PGLite at 256 MiB and 260 MiB, every Postgres cell and the lifecycle are exploratory. They are reported against the same rules and do not count. No paid cell ran: the paid arm needs model calls, and this run had no budget.

## The experiment

**What ran.** gbrain-evals pins gbrain `f717b1a5b1c71871c5b6530e98bd1d540a38c70d` (v0.60.299.0), and every run also names it through `--gbrain`. No run sets `pages.segmented_storage` or any other config: every receipt has `config_overlay: null`. The receipts come from runner commit `963c73fb` with a clean source tree. Amendment 4 is committed in that same commit, before any counted run. Bun 1.4.2 ran inside a `MemoryMax=6G` scope on a 4-core machine, with tiers over 2 MB one child at a time. Postgres is a local `pgvector/pgvector:pg16` server (16.15), with a fresh database per child.

- **PGLite (in-memory):**
  - 2 MB (chat, project log, novel), 20 MB and 24 MiB with all three arms.
  - 100 MiB, 128 MiB, 200 MB, 256 MiB and 260 MiB on the single-page and native arms.
- **Postgres:**
  - 2 MB with all three arms.
  - 100 MiB, 128 MiB, 200 MB, 256 MiB and 260 MiB on the single-page and native arms.
- **Write paths:**
  - At 100 MiB and above, the native arm writes with `importFromFile` under the brain's body policy (the documented path past 24 MiB). The single-page arm keeps `put_page`.
  - The counting embedder runs at 2 MB, 20 MB and 24 MiB.
  - Every run adds the lifecycle (`--lifecycle`).

The documents are the frozen `n14-large-page-gen/v1` set, seed 14, and the earlier tiers keep their hashes:

- 2 MB ledger: `c09ed855…`; 20 MB ledger: `aa3db342…`; 200 MB document: `36ae8889…`.
- The new tiers are 25,100,335 bytes (24 MiB), 104,857,629 (100 MiB), 134,152,197 (128 MiB), 268,369,939 (256 MiB) and 272,629,859 (260 MiB).

**Harness changes (Amendment 4):**

- New binary tiers that sit on the limits.
- `--engine postgres`.
- A settle bound for `write_pending` polls and the projection seal that scales with size: the greater of 240 s and 3 s per MB.
- The lifecycle measures: forget, soft delete, restore and purge, with residue counts.

Development smoke runs at 2 MB and one 100 MiB PGLite sizing run came before the amendment and are not results.

## Results

**Storage, recall, reads and round trip.** Recall is keyword needle recall@10 over 40 needles, 4 per decile. Every stored row scored 4 of 4 in each decile, except at 24 MiB.

| Tier | Engine | Arm | Storage (segments), chunks | Recall@10 | Correct windowed reads | Export round trip |
|---|---|---|---|---|---|---|
| 2 MB chat / log / novel | both | native | segmented (8 / 8 / 6), 905 / 808 / 658 | 40/40 each | 40/40 each | match |
| 2 MB | both | single-page | as native | 40/40 each | 0/40: default read refuses | match |
| 2 MB | both | managed parts | inline parts, 754 / 824 / 667 | 40/40 each | 40/40 each | match |
| 20 MB chat | PGLite | native / single-page / parts | segmented (74), 8,893 / same / 8,695 | 40/40 | 40/40 / 0/40 / 40/40 | match |
| 24 MiB chat | PGLite | native / single-page / parts | segmented (96), 11,209 / same / 10,892 | **39/40** / 39/40 / 40/40 | 39/39 / 0/39 / 40/40 | match |
| 100 MiB | both | native (import) | segmented (362), 46,603 | 40/40 | 40/40 | match |
| 128 MiB | both | native (import) | segmented (486), 59,722 | 40/40 | 40/40 | match |
| 200 MB | Postgres | native (import) | segmented (727), 89,006 | 40/40 | 40/40 | match |
| 256 MiB | Postgres | native (import) | segmented (829), 119,464 | 40/40 | 40/40 | match |
| 200 MB, 256 MiB | PGLite | native (import) | refused `file_too_large` (ceiling 128 MiB) | 0/40 | – | not stored |
| 260 MiB | both | native (import) | refused `file_too_large` | 0/40 | – | not stored |
| 100 MiB to 260 MiB | both | single-page (`put_page`) | refused `request_too_large` (24 MiB per call) | 0/40 | – | not stored |

**The 24 MiB miss.** The missed needle is the decile-6 name, "the Pykemere harbor pilot is Oswin Dalrymple".

- The chunker ends chunk 7138 with "…the Pykemere harbor pilot is Oswin", 29 characters before its end.
- The full sentence is in chunk 7139 (319 characters) and in chunk 7140, which overlaps all of chunk 7139.
- Keyword search returns one result for the page, chunk 7138.
- The text delivered to the agent is a window that runs on into the next chunk, so it holds the answer (delivered recall 40/40). The preregistered hit test reads the stored chunk the result names, so it scores a miss.
- Managed parts stores that day as its own page and finds it.

This is reported as a measured result, not a bug. A sentence split at a chunk boundary is ordinary. A 319-character chunk that lies entirely inside its neighbor looks odd, but no contract covers it.

**Responses and default reads.**

- On the segmented arms, search results and write receipts were at most 10,359 bytes, and windowed reads around a hit at most 20,945 bytes (the novel). Managed parts' largest response was 71,891 bytes at 24 MiB.
- A trusted-local default `get_page` of a segmented page now refuses with `page_body_segmented`, because its default is `full` and PR 2 refuses `full` on a segmented page. That is why single-page reads are 0 of 40 and why no response exceeds 1 MiB. At Wave A the same read returned the whole page: 2,042,049 bytes at 2 MB and 20,390,606 at 20 MB, the 126 and 42 over-cap responses.
- The agent-facing default read (`auto`) returns an outline plus a window: 23,610 to 35,678 bytes at every size, 25,982 bytes at 256 MiB.
- The egress rule therefore passes on this pin because the full read refuses, not because it is bounded.

**Append cost.** These are embedding inputs sent after the 1 KB append, counted in process, with tokens estimated as bytes / 4. Native arm, PGLite:

| Tier | Document | Segments written / live | Segment bytes written | Chunks re-chunked | Inputs / tokens / appended | Ratio: Wave A → PR 1 → now | Append time: Wave A → PR 1 → now |
|---|---|---|---|---:|---|---|---|
| 2 MB | chat | 1 / 8 | 159,982 | 70 | 1 / 355 / 261 | 2.19 → 4.35 → **1.36** | 1.8 s → 1.1 s → 1.0 s |
| 2 MB | log | 1 / 8 | 160,065 | 64 | 1 / 690 / 250 | 2.76 → 2.76 → 2.76 | 1.5 s → 1.1 s → 1.0 s |
| 2 MB | novel | 1 / 6 | 37,891 | 16 | 1 / 501 / 268 | 1.87 → 1.87 → 1.87 | 1.0 s → 0.7 s → 0.6 s |
| 20 MB | chat | 1 / 74 | 195,406 | 87 | 1 / 741 / 258 | 2.87 → 2.87 → 2.87 | 12.7 s → 7.1 s → 7.0 s |
| 24 MiB | chat | 1 / 96 | 89,110 | 43 | 1 / 597 / 255 | – → – → 2.34 | – → – → 8.4 s |

At 100 MiB and above, the append re-imports the whole file. Even so, gbrain writes one new tail segment and re-chunks 31 to 112 chunks, with no embed pass at those sizes. The re-import takes 7.7 s at 100 MiB (PGLite) and 17.4 s at 256 MiB (Postgres). The append is still a whole-page write, because `append_page` (Wave B PR 3) is not built. That is why the ratio rule stays held.

One exploratory oddity: on Postgres the single-page arm sent 2 embedding inputs for the 2 MB log and novel appends (ratios 5.52 and 3.74), where the native arm, which writes the same way, sent 1. PGLite sent 1 on both arms. It is a comparator cell outside every rule, and this run does not explain it.

**Time and memory (exploratory).** Ingest time runs until the page is searchable.

| Tier | Engine | Native ingest | RSS at ingest | Whole child peak | What ingest includes |
|---|---|---|---|---|---|
| 2 MB chat | PGLite / Postgres | 2.1 s / 2.1 s | 1,148 / 370 MB | 1,602 / 485 MB | sealed at the reply |
| 20 MB chat | PGLite | 15.8 s (Wave A 13.7 s, PR 1 18.5 s) | 2,685 MB (PR 1 2,866) | 4,064 MB | `write_pending`, committed after 1.2 s of polling, sealed 7.0 s later |
| 24 MiB chat | PGLite | 19.5 s | 2,951 MB | 4,716 MB | polling 1.1 s, seal 10.3 s |
| 100 MiB | PGLite / Postgres | 54.4 s / 51.5 s | 1,895 / 818 MB | 3,391 / 2,018 MB | import, sealed at return |
| 128 MiB | PGLite / Postgres | 70.2 s / 64.0 s | 2,044 / 941 MB | 4,255 / 2,663 MB | import |
| 200 MB | Postgres | 94.6 s | 1,066 MB | 3,304 MB | import |
| 256 MiB | Postgres | 124.3 s | 1,164 MB | 4,348 MB | import |

The whole-child peak includes the harness's own copies of the document for the export comparison, so it overstates gbrain. Nothing came near the 6 GiB ceiling.

## Lifecycle (exploratory)

The lifecycle ran after the round trip on every stored single-page and native page. Ten probes means one needle query per decile.

| Step | 2 MB (all three documents), 20 MB, 24 MiB, both engines | 100 MiB to 256 MiB (stored ones), both engines |
|---|---|---|
| Forget a one-row facts fence | fact row created, `forget_fact` withdraws it, `recall` returns 0, exported row struck | fence write refused `file_too_large` (facts fences are limited to 24 MiB), so the step did not run |
| Soft delete | 0 of 10 probes found, `get_page` → `page_not_found` | the same |
| Restore | 10 of 10 found, export byte-identical to the one before the delete | the same |
| Purge (`purge: true`) | page, chunk, manifest, version and fact rows 0; no chunk holds a needle; **1 unreferenced segment text left** (160,368 / 160,451 / 38,277 bytes at 2 MB; 195,792 at 20 MB; 89,496 at 24 MiB) holding 6 / 6 / 3 / 2 / 2 planted answers, removed by `sweepSegments({ graceMs: 0 })` | every row 0, no segment text left |

The leftover text is N14-5. Separate 2 MB probes isolated it:

- Create, append, delete, restore and purge leaves nothing.
- A fence plus forget, then purge, leaves nothing.
- A fence plus delete and restore, then purge, leaves nothing.
- Forget followed by delete and restore leaves one text unreferenced.

The purge deletes the texts the page's manifest still references, so it misses that one. `delete_page`'s contract says a purge removes the raw data immediately, so this is recorded as a bug. Above 24 MiB no forget ran, and no text was left.

## gbrain bugs, updated

- **N14-2 closes** (one document over 24 MiB cannot be written): the file import stores one document as one page up to the engine ceilings. `put_page` keeps its documented 24 MiB per-call limit.
- **N14-5 is new and open**: a purge after `forget_fact`, delete and restore leaves a segment text holding page content until the 1 h GC (repro below).

## Errata

None. The Wave A and Wave B PR 1 reports stand as published. Two of their statements describe their own commits and are no longer true at `f717b1a`: "a segmented page cannot yet be read or exported" (PR 1) and "the trusted-local default read returns the whole page" (Wave A).

## Reproduce

```
git -C <gbrain checkout> fetch origin && git -C <gbrain checkout> checkout f717b1a5b1c71871c5b6530e98bd1d540a38c70d
docker run -d --name n14pg -e POSTGRES_USER=n14 -e POSTGRES_PASSWORD=n14 -p 127.0.0.1:55432:5432 pgvector/pgvector:pg16
export N14_PG_ADMIN_URL=postgres://n14:n14@127.0.0.1:55432/postgres
G="--gbrain <checkout>@f717b1a5b1c71871c5b6530e98bd1d540a38c70d"; BIG="--arms single-page,native --native-ingest import --concurrency 1"
bun eval/runner/n14-large-page-fidelity.ts $G --tiers 2mb --lifecycle --output <dir>/pglite/2mb
bun eval/runner/n14-large-page-fidelity.ts $G --tiers 20mb --concurrency 1 --lifecycle --output <dir>/pglite/20mb
bun eval/runner/n14-large-page-fidelity.ts $G --tiers 24mib --concurrency 1 --lifecycle --output <dir>/pglite/24mib
bun eval/runner/n14-large-page-fidelity.ts $G --tiers 100mib,128mib,200mb,256mib,260mib $BIG --lifecycle --output <dir>/pglite/large
bun eval/runner/n14-large-page-fidelity.ts $G --tiers 2mb --engine postgres --lifecycle --output <dir>/postgres/2mb
bun eval/runner/n14-large-page-fidelity.ts $G --tiers 100mib,128mib,200mb,256mib,260mib $BIG --engine postgres --lifecycle --output <dir>/postgres/large
```

Each run needs Bun 1.4 or newer and no keys. The 2 MB runs exit 0 (verdict pass). The others exit 1, because a receipt without the 2 MB tier or the managed-parts arm has no value for the floor or the gap.

Hermetic arm times:

| Engine | 2 MB | 20 MB | 24 MiB | 100 MiB to 260 MiB |
|---|---|---|---|---|
| PGLite | 88.7 s | 520.7 s | 664.5 s | 360.8 s |
| Postgres | 70.5 s | – | – | 733.8 s |

Receipts:

- PGLite: [2mb](2026-10-18-n14-large-page-fidelity-wave-b2/pglite/2mb/receipt.json), [20mb](2026-10-18-n14-large-page-fidelity-wave-b2/pglite/20mb/receipt.json), [24mib](2026-10-18-n14-large-page-fidelity-wave-b2/pglite/24mib/receipt.json), [100mib to 260mib](2026-10-18-n14-large-page-fidelity-wave-b2/pglite/large/receipt.json)
- Postgres: [2mb](2026-10-18-n14-large-page-fidelity-wave-b2/postgres/2mb/receipt.json), [100mib to 260mib](2026-10-18-n14-large-page-fidelity-wave-b2/postgres/large/receipt.json)

Earlier reports: [Wave B PR 1](2026-10-15-n14-large-page-fidelity-wave-b1.md), [Wave A](2026-10-15-n14-large-page-fidelity-wave-a.md), [baseline](2026-10-14-n14-large-page-fidelity-baseline.md).
