# Large-page fidelity after large pages Wave A (2026-10-15)

## The finding

Large pages Wave A makes one big document usable in gbrain. On gbrain master `44eb049` (v0.60.242.0), each 2 MB document and the 20 MB chat is stored as a single page and found in full: keyword recall@10 is 40 of 40 in every decile of every document, against 0 of 40 at the baseline (`c71fe74`). Search hits are read through the new windowed `get_page`, and 40 of 40 reads are correct on every document, the largest 20,871 bytes. Export reproduces every source byte, and appending 1 KB re-embeds only the page's last chunk, at 1.87 to 2.87 times the appended text.

A brain an older gbrain filled also recovers. `reindex --oversized` re-chunks a page stored with `embed_skip: oversized` and removes the marker, after which the page is found 40 of 40 and holds its embedding for approval.

Of the preregistered rules, Wave A passes every one that this hermetic run measures except the egress contract:

| Rule | Preregistered | Baseline `c71fe74` | Wave A `44eb049` |
|---|---|---|---|
| Crashes or OOM kills, every size run (2, 20, 200 MB) | 0 | 0 | **0, pass** |
| Responses over 1 MiB | 0 | 3 (2 MB) | **126 (2 MB) and 42 (20 MB), fail** |
| Round-trip byte loss | 0 | 0 | **0, pass** |
| Presence failures | 0 | 0 | **0, pass** |
| Native keyword recall@10 at 2 MB | ≥ 0.90 | none (capability absent) | **1.00, pass** |
| Native append embedding ratio, worst document | ≤ 3 | none | **2.76 (2 MB), 2.87 (20 MB), pass** |
| Native recall gap to managed parts | ≤ 2 points | none | **0, pass** |
| Paid hybrid recall@10, every decile, 2 and 20 MB | ≥ 0.95 | not run | not run (no approved budget) |

The over-cap responses come from the trusted local default read, which Wave A leaves full by design. The single-page arm reads every hit that way (40 hit reads plus one entry read per document, 41 per document), and the native arm's single default read of the entry page is full too. An agent-facing caller (`remote: true`, as over MCP) gets 23,579 to 35,647 bytes from the same default read, so the agent-visible egress is bounded. The contract as preregistered counts the trusted harness's frames, though. Whether it should count the agent-facing frame instead is a decision for the owner of the preregistration, and needs an amendment before it is applied.

What still needs Wave B:

- **Documents over 24 MiB.** The 200 MB chat is refused, now correctly with `request_too_large`; gbrain bug N14-4 is fixed.
- **Appends.** There is still no `append_page`. The append is a whole-page `put_page` rewrite: the embedding cost passes the 3x rule, but only just at 20 MB (2.87), and that rewrite takes 12.7 s and sends all 20 MB.

The category stays report-only and held. The hold lifts when gbrain-evals re-pins to a gbrain with the capability; this run used `--gbrain`.

## The concrete case

The case is the same as the baseline's: a generated 365-day group chat between four invented people, 2,000,112 bytes, with one planted sentence per tenth of the file such as "the Luntmere storage unit number is 38726".

| Step | Baseline `c71fe74` | Wave A `44eb049` |
|---|---|---|
| `put_page` of the whole chat | stored, `embed_skip: oversized`, 0 chunks | stored, 906 chunks |
| `search "Luntmere storage unit number"` (last tenth of the file) | nothing | the chunk holding the sentence, rank 1 |
| Read the hit | `get_page {slug}`: 2,042,154 bytes | `get_page {slug, body: "window", around_chunk_id}`: at most 9,268 bytes, sentence included |
| Default `get_page {slug}`, agent-facing | (not measured) | 35,293 bytes: an outline and the first window |
| Default `get_page {slug}`, trusted local | 2,042,154 bytes | 2,042,049 bytes (full by design) |
| Append a 1 KB day | whole-page rewrite, still unfindable | whole-page rewrite, 1 chunk re-embedded (572 tokens for 261 appended), found at rank 1 |
| The same chat stored by the older gbrain, then upgraded | n/a | `reindex --oversized`: 1 of 1 page re-indexed, marker removed, 906 chunks, 40/40, embedding held for approval |

## The experiment and results

**Build.** Each document is generated fresh from the frozen generator `n14-large-page-gen/v1` (seed 14), as at the baseline. The ledger hashes are identical: `c09ed855…` at 2 MB, `aa3db342…` at 20 MB and `3b390e29…` at 200 MB.

The gbrain under test is master `44eb0493ff2776f04d6616b1a526657702f7544a` (v0.60.242.0), loaded through `--gbrain`. It contains #6707 (the windowed read contract), #6715 (crash fixes) and #6733 (the 24 MiB ceiling, large-page embedding and `reindex --oversized`).

The runner is gbrain-evals `763566f`, which adds the upgrade-path case and the agent-facing read; the 20 MB and 200 MB tiers ran at `cb54753`, where the N14 runner and every file it imports are unchanged (the other code differences are main's D6 runner, merged in). [Amendment 1](2026-10-14-n14-large-page-fidelity-preregistration.md#amendment-1-2026-10-15-wave-a-rerun) to the preregistration was committed and pushed before any run (`ee9eef4`, SHA corrected in `ea0825e`). It changes no rule, threshold, model or arm.

**Setup and cost.** The run used Bun 1.4.2 and in-memory PGLite, one brain per (document, arm) child process, inside a `MemoryMax=6G` scope on a 4-core machine. The 20 MB and 200 MB tiers ran one child at a time. The run was hermetic and cost $0: provider keys were stripped, search ran on the keyword path, and the append embedder was an in-process counter.

**Native capability.** The probe found `get_page` declaring `body` with `auto`, `full`, `none`, `outline` and `window`, and no `append_page` or upload session. As preregistered, the native arm therefore wrote each document with one `put_page`, read hits through `body: "window"` around the hit's chunk, and appended with a whole-page `put_page`.

**Recall, reads and storage, before and after.** Recall is keyword needle recall@10 over 40 needles, 4 per decile. Every Wave A row scored 4 of 4 in each of the ten deciles.

| Tier | Document | Arm | Baseline: ingest, chunks, recall | Wave A: ingest, chunks, recall | Wave A: hit reads correct (largest response, bytes) | Wave A: round trip |
|---|---|---|---|---|---|---|
| 2 MB | chat | single-page | embed_skip, 0, 0/40 | stored, 906, 40/40 | 0/40 (2,042,049) | match |
| 2 MB | chat | native | capability absent | stored, 906, **40/40** | **40/40 (9,268)** | match |
| 2 MB | chat | managed-parts | 754, 40/40 | 754, 40/40 | 40/40 (7,176) | match |
| 2 MB | log | single-page | embed_skip, 0, 0/40 | stored, 803, 40/40 | 0/40 (2,049,223) | match |
| 2 MB | log | native | capability absent | stored, 803, **40/40** | **40/40 (8,782)** | match |
| 2 MB | log | managed-parts | 824, 40/40 | 824, 40/40 | 40/40 (7,664) | match |
| 2 MB | novel | single-page | embed_skip, 0, 0/40 | stored, 656, 40/40 | 0/40 (1,510,169) | match |
| 2 MB | novel | native | capability absent | stored, 656, **40/40** | **40/40 (20,871)** | match |
| 2 MB | novel | managed-parts | 667, 40/40 | 667, 40/40 | 40/40 (38,615) | match |
| 20 MB | chat | single-page | refused `request_too_large`, 0/40 | stored, 8,855, 40/40 | 0/40 (20,390,606) | match |
| 20 MB | chat | native | capability absent | stored, 8,855, **40/40** | **40/40 (9,583)** | match |
| 20 MB | chat | managed-parts | 8,695, 40/40 | 8,695, 40/40 | 40/40 (21,462) | match |
| 200 MB | chat | single-page | refused `queue_capacity` | refused `request_too_large` | n/a | not stored |
| 200 MB | chat | native | capability absent | refused `request_too_large` | n/a | not stored |

A hit read counts as correct when it holds the needle and its response is at most 1 MiB. The single-page arm reads with a default trusted `get_page`, which returns the whole page, so its reads hold the needle but are over the cap. Round-trip sha256 values match the source plus the append on every stored row; for example, the 2 MB chat is `b681e993…` on all three arms. Delivered recall equals stored recall everywhere, and no search ranked a distractor above its needle.

**Response sizes.** The largest response per arm, from the 2 MB and 20 MB Wave A receipts:

| Read | 2 MB chat | 2 MB log | 2 MB novel | 20 MB chat |
|---|---:|---:|---:|---:|
| Native window around a hit, largest | 9,268 | 8,782 | 20,871 | 9,583 |
| Default `get_page`, agent-facing (`remote: true`) | 35,293 | 29,394 | 23,579 | 35,647 |
| Default `get_page`, trusted local (counted by the egress contract) | 2,042,049 | 2,049,223 | 1,510,169 | 20,390,606 |
| Managed parts, largest response | 23,901 | 36,878 | 38,615 | 65,071 |

**Append cost.** These are embedding inputs sent after the 1 KB append, counted by the in-process embedder, with tokens estimated as bytes / 4.

| Tier | Document | Arm | Baseline ratio | Wave A inputs / tokens / appended | Wave A ratio | Wave A append time |
|---|---|---|---:|---|---:|---:|
| 2 MB | chat | native | none | 1 / 572 / 261 | **2.19** | 1.8 s |
| 2 MB | log | native | none | 1 / 690 / 250 | **2.76** | 1.5 s |
| 2 MB | novel | native | none | 1 / 501 / 268 | **1.87** | 1.0 s |
| 20 MB | chat | native | none | 1 / 741 / 258 | **2.87** | 12.7 s |
| 2 MB | chat | managed-parts | 2.14 | 2 / 558 / 261 | 2.14 | 0.3 s |
| 2 MB | log | managed-parts | 5.56 | 4 / 1,390 / 250 | 5.56 | 0.4 s |
| 20 MB | chat | managed-parts | 11.78 | 4 / 3,038 / 258 | 11.78 | 0.7 s |

Wave A keeps a chunk's vector with its text. So rewriting the whole page re-embeds only the chunk that changed, the last one, which now holds the appended day. The ratio is that chunk's size over the appended size, so it passes 3x with little room. The rewrite itself still moves the whole page: 12.7 s at 20 MB, against 0.7 s for the managed-parts append.

**Upgrade path (Amendment 1, exploratory).** Each 2 MB document was written single-page by the baseline gbrain `c71fe74` into a file-backed PGLite brain. Then gbrain `44eb049` opened the brain, migrated it and ran `runOversizedBackfill`, the code behind `gbrain reindex --oversized`.

| Document | Seeded by `c71fe74` | Backfill: reindexed / candidates, held for approval, failed | Marker removed | Chunks | Recall@10 | Window reads correct | Round trip | Backfill time |
|---|---|---|---|---:|---:|---:|---|---:|
| chat | stored, `embed_skip: oversized`, 0 chunks | 1 / 1, 1, 0 | yes | 906 | 40/40 | 40/40 | match | 1.9 s |
| log | stored, `embed_skip: oversized`, 0 chunks | 1 / 1, 1, 0 | yes | 803 | 40/40 | 40/40 | match | 1.7 s |
| novel | stored, `embed_skip: oversized`, 0 chunks | 1 / 1, 1, 0 | yes | 656 | 40/40 | 40/40 | match | 1.2 s |

The upgraded pages match the native arm on a fresh brain on chunk count, recall and reads. Every page is over 1 MiB, so the backfill holds its embedding for approval. The previewed cost is $0.06 to $0.08 per page at the brain's `voyage:voyage-4` price, and nothing was spent.

**Time and memory (exploratory).** Peak RSS is for the whole child process, which holds the harness's copy of the document.

| Tier | Arm | Ingest | Embed pass (counted) | Child wall | Child peak RSS |
|---|---|---:|---:|---:|---:|
| 2 MB chat | native | 2.4 s | 9.4 s, 908 inputs | 20.7 s | 1,516 MB |
| 2 MB chat | managed-parts | 16.0 s | 10.0 s, 756 inputs | 32.9 s | 1,385 MB |
| 20 MB chat | native | 13.7 s | 123.4 s, 8,857 inputs | 174.6 s | 4,990 MB |
| 20 MB chat | single-page | 13.8 s | 121.4 s, 8,857 inputs | 175.3 s | 4,938 MB |
| 20 MB chat | managed-parts | 42.2 s | 121.8 s, 8,697 inputs | 172.6 s | 2,216 MB |
| 200 MB chat | native (refused) | 0.3 s | – | 4.5 s | 1,949 MB |

A 20 MB single page peaks near 5 GB in one process, about 2.2 times managed parts. That is within the 6 GiB watchdog, so it was not counted as a crash.

At this commit the 2 MB tier takes 121.8 s of hermetic arm time with the native arm present, plus the upgrade case. That is over the preregistered 60 s CI target. CI runs the tier against the pinned gbrain, where the native arm is absent and the tier took 45 s, so CI is unaffected until the re-pin.

## What to use and what to avoid

- **Use one page for one large document, up to 24 MiB, on gbrain v0.60.242.0 or later.** It is found in full and round-trips exactly. Read hits with `get_page {slug, body: "window", around_chunk_id}`, never with a default trusted read, which returns the whole page.
- **Run `gbrain reindex --oversized` on an upgraded brain.** It brings back the pages an older gbrain skipped, free and without model calls, and asks before embedding pages over 1 MiB.
- **Keep splitting documents over 24 MiB until Wave B.** Also keep splitting a single page that takes frequent small appends, because each append rewrites and re-sends the whole page.

## gbrain bugs, updated

These are in `docs/benchmarks/2026-10-01-wave-bugs.json`, each reviewed on 2026-10-15 at `44eb049` with these receipts.

| Id | Was | Now |
|---|---|---|
| N14-1 | gap: a page over 500 KB was stored with 0 chunks | **closed** by #6733: 2 MB pages are chunked and found 40/40, and the upgrade path re-chunks old ones |
| N14-2 | gap: a 20 MB page was refused at 5 MB | **open, narrower**: 20 MB is stored after #6733, while 200 MB is still refused at the 24 MiB ceiling (Wave B) |
| N14-3 | gap: no windowed `get_page` | **closed** by #6707: windowed reads 40/40, and the agent-facing default read is 23.6 to 35.6 KB |
| N14-4 | bug: a 200 MB page got a retryable `queue_capacity` | **fixed** by #6733 (`44eb049`): refused with `request_too_large` before the write journal |

## Reproduce

```
git -C <gbrain checkout> fetch origin && git -C <gbrain checkout> checkout 44eb0493ff2776f04d6616b1a526657702f7544a
bun eval/runner/n14-large-page-fidelity.ts --tiers 2mb --gbrain <checkout>@44eb0493ff2776f04d6616b1a526657702f7544a --upgrade-from <checkout>@c71fe7436e673db819c1be4532504b861e14ad50 --output <dir>/2mb
bun eval/runner/n14-large-page-fidelity.ts --tiers 20mb --concurrency 1 --gbrain <checkout>@44eb0493… --output <dir>/20mb
bun eval/runner/n14-large-page-fidelity.ts --tiers 200mb --arms single-page,native --concurrency 1 --gbrain <checkout>@44eb0493… --output <dir>/200mb
```

Each run needs Bun 1.4 or newer and no keys. The run times here were 121.8 s, 525.0 s and 31.4 s of hermetic arm time. Every receipt records a clean source tree: the 2 MB tier at `763566f`, and the 20 MB and 200 MB tiers at `cb54753`. The 20 MB and 200 MB tiers were rerun from that clean tree; only timings changed.

**Erratum to the baseline report.** The [baseline report](2026-10-14-n14-large-page-fidelity-baseline.md)'s concrete case quoted "the Orrinmere gate code is 39080" as a 2 MB needle. That sentence is the 20 MB append needle. The 2 MB chat's last-tenth needle is "the Luntmere storage unit number is 38726" (query "Luntmere storage unit number"), the one this report uses. The baseline's measurements are unaffected; its report is left as published.

Receipts: [2mb](2026-10-15-n14-large-page-fidelity-wave-a/2mb/receipt.json), [20mb](2026-10-15-n14-large-page-fidelity-wave-a/20mb/receipt.json), [200mb](2026-10-15-n14-large-page-fidelity-wave-a/200mb/receipt.json). Baseline: [2026-10-14 report](2026-10-14-n14-large-page-fidelity-baseline.md).
