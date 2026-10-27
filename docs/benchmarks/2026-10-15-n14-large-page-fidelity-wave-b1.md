# Large-page fidelity at large pages Wave B PR 1, segmented storage (2026-10-15, exploratory)

## The finding

Wave B PR 1 (gbrain `7f3c9f5`, v0.60.252.0, #6787) adds segmented page storage behind `pages.segmented_storage`, which defaults to `off`. This run is exploratory and not counted ([Amendment 2](2026-10-14-n14-large-page-fidelity-preregistration.md#amendment-2-2026-10-15-wave-b-pr-1-segmented-storage-exploratory)): the read path for a segmented body arrives with PR 2.

With the switch on, a page over 1 MiB is stored in content-addressed segments, and storage itself works:

- Every 2 MB document and the 20 MB chat is stored in segments (8, 8 and 6 at 2 MB; 74 at 20 MB) and found 40 of 40 in every decile, as at Wave A.
- An append writes only the tail. A 1 KB append adds 1 new segment of the 74 at 20 MB (195,406 bytes) and re-embeds 1 chunk. The 20 MB append takes 7.1 s, against 11.9 s for Wave A's inline rewrite.
- The stored segments reproduce the document exactly: joined in order, their sha256 matches the source plus the append on every stored page.
- The 20 MB chat's ingest peaks at 2,866 MB of RSS, against 4,111 MB inline.

At this commit an agent still cannot read a segmented page back:

- `get_page` refuses it with `page_body_segmented`, both the default read and `body: "window"`, so windowed reads are 0 of 40 where Wave A had 40 of 40.
- `gbrain export` refuses it the same way, so the preregistered export round trip fails on every segmented page.

A 20 MB write also answers `write_pending` at its 5 s reply deadline. It commits about 2 s later, and the page becomes searchable about 9 s after that, once its chunks are built.

Pages over 24 MiB are still refused, so N14-2 stays open. `put_page` refuses the 200 MB chat with `request_too_large` at the 24 MiB single-string ceiling, whichever way the switch is set. The streamed file import, the only path past 24 MiB at this commit, refuses it with `file_too_large`, because PGLite's segmented ceiling is 128 MiB. Postgres, with a 256 MiB ceiling, was not run: this harness is PGLite-only.

With the switch off, the same gbrain reproduces Wave A on every measure, so PR 1 causes no regression.

How the preregistered rules come out with the switch on (reported, not counted):

| Rule | Preregistered | Wave A `44eb049` | Wave B PR 1, switch off | Wave B PR 1, switch on |
|---|---|---|---|---|
| Crashes or OOM kills | 0 | 0 | 0 | 0 |
| Responses over 1 MiB | 0 | 126 (2 MB), 42 (20 MB) | 126, 42 | 0, because every read of a segmented page is refused |
| Round-trip byte loss (export) | 0 | 0 | 0 | 6 (2 MB), 2 (20 MB): export refuses; segment round trip matches on all 8 |
| Presence failures | 0 | 0 | 0 | 0 |
| Native keyword recall@10 at 2 MB | ≥ 0.90 | 1.00 | 1.00 | 1.00 |
| Native append embedding ratio, worst document | ≤ 3 | 2.76 (2 MB), 2.87 (20 MB) | 2.76, 2.87 | 4.35 (2 MB chat), 2.87 (20 MB) |
| Native recall gap to managed parts | ≤ 2 points | 0 | 0 | 0 |

## The experiment

**What ran.** gbrain master `7f3c9f5f19862372d056c713942564dd165f62ba` was measured through `--gbrain`, and the gbrain-evals pin is unchanged. Each child brain is in-memory PGLite. "Switch on" sets `pages.segmented_storage=on` after `initSchema`, through the runner's new `--config` flag.

- **Switch on:** 2 MB and 20 MB with all three arms, and 200 MB on the single-page and native arms. A second native run at 200 MB writes through `importFromFile` with the brain's body policy (`--native-ingest import`).
- **Switch off:** the same tiers and arms with no overlay.

The documents are the frozen `n14-large-page-gen/v1` set, seed 14, with the same ledger hashes as Wave A: `c09ed855…`, `aa3db342…` and `3b390e29…`. The run used Bun 1.4.2 inside a `MemoryMax=6G` scope on a 4-core machine, with the 20 MB and 200 MB tiers one child at a time. It was hermetic and cost $0: keyword search and an in-process counting embedder. The append is the preregistered 1 KB day; gbrain's own 10 KB append benchmark was not rerun. The paid arm and the upgrade path did not run.

**Harness changes (Amendments 2 and 3).**

- **New measures.** The runner records each page's storage class, segment count and body generation. For an append to a segmented page, it records the live segments, the segments at the new generation and the segment texts added, with their bytes.
- **Segment round trip.** The live segment texts are joined in order and compared by sha256 with the expected body. This is reported beside the export round trip, outside the safety count.
- **Accepted-pending writes.** A `write_pending` reply is now polled with `get_write_request` until it is final, as the reply asks.
- **Projection wait.** Probes wait until a segmented page's text projection is sealed. Ingest time includes that wait.

The first runs under Amendment 2 (runner `7256bc5`) had neither of those two behaviors. At 20 MB they counted the pending reply as a write error and probed before the projection was sealed, which gave recall 0 of 40 and a failed append. Those receipts are superseded. Every receipt here is from runner `00a1cd3` with a clean source tree.

## Results with the switch on, against Wave A

**Storage, recall and reads.** Recall is keyword needle recall@10 over 40 needles, 4 per decile. Every row with a stored page scored 4 of 4 in each decile.

| Tier | Document | Arm | Wave A storage, chunks | Switch on: storage, chunks | Recall@10 | Correct windowed reads (Wave A → on) | Round trip: export / segments |
|---|---|---|---|---|---|---|---|
| 2 MB | chat | native | inline, 906 | segmented (8), 903 | 40/40 | 40/40 → 0/40 | refused / match |
| 2 MB | log | native | inline, 803 | segmented (8), 804 | 40/40 | 40/40 → 0/40 | refused / match |
| 2 MB | novel | native | inline, 656 | segmented (6), 658 | 40/40 | 40/40 → 0/40 | refused / match |
| 20 MB | chat | native | inline, 8,855 | segmented (74), 8,896 | 40/40 | 40/40 → 0/40 | refused / match |
| 2 MB, 20 MB | all | single-page | as native | as native | 40/40 | 0/40 → 0/40 (Wave A reads were whole pages over the cap) | refused / match |
| 2 MB, 20 MB | all | managed parts | parts under 1 MiB stay inline | unchanged | 40/40 | 40/40 → 40/40 | match / – |

Each refusal reads: `page_body_segmented: rowToPage.compiled_truth: page … stores its body in segments, and this path reads or writes the whole body as one string. Nothing was read or changed.` The default `get_page` of the entry page is refused for both trusted-local and agent-facing callers. No response exceeded 1 MiB with the switch on. On the segmented arms, the largest response was a `put_page` receipt or a search result, at most 7,394 bytes; managed parts read windows of up to 38,615 bytes at 2 MB and 65,071 bytes at 20 MB, as before.

**Append cost.** These are embedding inputs sent after the 1 KB append, counted by the in-process embedder, with tokens estimated as bytes / 4.

| Tier | Document | Segments written / live | Segment bytes written | Chunks re-chunked | Embedding inputs / tokens / appended | Ratio, Wave A → on | Native append time, Wave A → on |
|---|---|---|---|---:|---|---|---|
| 2 MB | chat | 1 / 8 | 159,982 | 70 | 2 / 1,135 / 261 | 2.19 → **4.35** | 1.8 s → 1.1 s |
| 2 MB | log | 1 / 8 | 160,065 | 64 | 1 / 690 / 250 | 2.76 → 2.76 | 1.5 s → 1.1 s |
| 2 MB | novel | 1 / 6 | 37,891 | 16 | 1 / 501 / 268 | 1.87 → 1.87 | 1.0 s → 0.7 s |
| 20 MB | chat | 1 / 74 | 195,406 | 87 | 1 / 741 / 258 | 2.87 → 2.87 | 12.7 s → 7.1 s |

An append rewrites only the last segment. It re-chunks every chunk in that segment, but vectors are reused for chunk text that did not change, so only the chunks that hold the new day are embedded. The 2 MB chat sends 2 chunks, which puts it above the 3x rule. The other documents send 1, as Wave A did. The append is still a whole-page `put_page`, so the client still sends the full body; only the storage and embedding work shrink.

**Time and memory (exploratory).** Ingest time runs until the page is searchable.

| Tier | Arm | Wave A-equivalent (switch off): ingest, RSS at ingest | Switch on: ingest, RSS at ingest | Switch on: what the ingest time includes |
|---|---|---|---|---|
| 2 MB chat | native | 1.8 s, 1,211 MB | 2.1 s, 1,011 MB | sealed at the reply |
| 20 MB chat | native | 13.4 s, 4,111 MB | 18.5 s, 2,866 MB | reply `write_pending` after 5 s; committed after 2.0 s of polling; sealed 9.3 s later |
| 20 MB chat | single-page | 14.0 s, 4,102 MB | 19.3 s, 2,989 MB | the same: 2.1 s of polling, then 9.7 s |

Whole-child peaks at 20 MB were 4,048 MB (native, on) against 4,971 MB (off). The child holds the harness's copy of the 20 MB document and runs the embed pass. The embed pass sent 8,898 inputs with the switch on and 8,857 off.

**200 MB.**

| Write path | Switch off | Switch on |
|---|---|---|
| `put_page` (single-page and native arms) | `request_too_large` (24 MiB) | `request_too_large` (24 MiB) |
| `importFromFile` with the body policy | not run | `file_too_large` |

The import refusal's message names the 24 MiB single-string limit ("max 25165824"), but the ceiling that applies is PGLite's 128 MiB segmented ceiling. It is reported here, not as a new bug.

## Switch off: no regression

With the switch off, gbrain `7f3c9f5` matched Wave A on every scored measure:

- chunk counts (906 / 803 / 656 and 8,855)
- recall (40/40 in every decile)
- native windowed reads (40/40, largest 20,871 bytes at 2 MB)
- responses over 1 MiB (126 and 42, all trusted-local default reads)
- agent-facing default reads (35,293 / 29,394 / 23,579 bytes at 2 MB, 35,647 at 20 MB)
- export round trips (all match)
- append ratios (2.19 / 2.76 / 1.87 and 2.87; managed parts 2.14 / 5.56 / 2.78 and 11.78)
- 200 MB refusals (`request_too_large`)

Only timings moved, within run-to-run noise: the 20 MB native append took 11.9 s against Wave A's 12.7 s.

## What it means for Wave B

Segmented storage is sound: it is lossless, appends touch only the tail, and the memory peak is lower. It does not yet make a large page usable by an agent. Three things remain:

- **PR 2's segment reader.** Without it, a segmented page can be found but not read or exported.
- **A write path past 24 MiB that agents can use.** `put_page` stops at 24 MiB, and the streamed import is a local file import.
- **`append_page`.** Today the client still re-sends the whole body to append.

The 2 MB chat's 4.35 append ratio also suggests that re-chunking the tail segment can embed one more chunk than the inline path does.

The category stays report-only and held.

## gbrain bugs, updated

N14-2 (one document over 24 MiB cannot be written) gets a 2026-10-15 review at `7f3c9f5`. It stays open: 200 MB is refused by `put_page` at 24 MiB and by the streamed import at PGLite's 128 MiB. No new bug is recorded, because this run is exploratory and the unreadable segmented page is the documented PR 1 state.

## Reproduce

```
git -C <gbrain checkout> fetch origin && git -C <gbrain checkout> checkout 7f3c9f5f19862372d056c713942564dd165f62ba
G="--gbrain <checkout>@7f3c9f5f19862372d056c713942564dd165f62ba"; ON="--config pages.segmented_storage=on"
bun eval/runner/n14-large-page-fidelity.ts --tiers 2mb $G $ON --output <dir>/on/2mb
bun eval/runner/n14-large-page-fidelity.ts --tiers 20mb --concurrency 1 $G $ON --output <dir>/on/20mb
bun eval/runner/n14-large-page-fidelity.ts --tiers 200mb --arms single-page,native --concurrency 1 $G $ON --output <dir>/on/200mb
bun eval/runner/n14-large-page-fidelity.ts --tiers 200mb --arms native --native-ingest import --concurrency 1 $G $ON --output <dir>/on/200mb-import
bun eval/runner/n14-large-page-fidelity.ts --tiers 2mb $G --output <dir>/off/2mb
bun eval/runner/n14-large-page-fidelity.ts --tiers 20mb --concurrency 1 $G --output <dir>/off/20mb
bun eval/runner/n14-large-page-fidelity.ts --tiers 200mb --arms single-page,native --concurrency 1 $G --output <dir>/off/200mb
```

Each run needs Bun 1.4 or newer and no keys, and exits 1 because the preregistered verdict is fail. Hermetic arm times:

| Switch | 2 MB | 20 MB | 200 MB | 200 MB import |
|---|---|---|---|---|
| On | 74.9 s | 473.7 s | 31.2 s | 27.5 s |
| Off | 76.9 s | 514.0 s | 30.3 s | – |

Receipts:

- Switch on: [2mb](2026-10-15-n14-large-page-fidelity-wave-b1/on/2mb/receipt.json), [20mb](2026-10-15-n14-large-page-fidelity-wave-b1/on/20mb/receipt.json), [200mb](2026-10-15-n14-large-page-fidelity-wave-b1/on/200mb/receipt.json), [200mb import](2026-10-15-n14-large-page-fidelity-wave-b1/on/200mb-import/receipt.json)
- Switch off: [2mb](2026-10-15-n14-large-page-fidelity-wave-b1/off/2mb/receipt.json), [20mb](2026-10-15-n14-large-page-fidelity-wave-b1/off/20mb/receipt.json), [200mb](2026-10-15-n14-large-page-fidelity-wave-b1/off/200mb/receipt.json)

Earlier reports: [Wave A](2026-10-15-n14-large-page-fidelity-wave-a.md), [baseline](2026-10-14-n14-large-page-fidelity-baseline.md).
