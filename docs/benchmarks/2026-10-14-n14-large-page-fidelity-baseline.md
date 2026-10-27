# Large-page fidelity baseline on gbrain master (2026-10-14)

## The finding

A single large document is not usable in gbrain today. On current master (`c71fe74`, v0.60.225.0), every one of the three 2 MB documents is stored but cannot be found: `put_page` keeps the body, marks it `embed_skip: oversized` and writes zero chunks, so keyword search finds 0 of 40 planted facts in each document (0 of 120 overall) while all 120 sit in the stored body. Reading the page back with a default `get_page` returns a 2.04 MB response for the chat and the log and 1.51 MB for the novel. All three are over the 1 MiB egress cap. At 20 MB the same write is refused with `request_too_large`. At 200 MB it is refused with `queue_capacity`, a retryable code, even though no amount of waiting will admit it (bug N14-4 below).

Splitting the same document into one page per day or chapter (the managed-parts design the conversation-archive skill uses) works at every size measured. It found 40 of 40 facts in every decile of all five documents (2 MB, 20 MB and 200 MB), every read was correct and under 64 KiB, and export reproduced every source byte for byte. Its weak spot is the update: appending 1 KB re-embeds 2.1 to 5.6 times the appended text at 2 MB and 11.8 times at 20 MB, because the hub page's index is rewritten along with the new part.

gbrain has no large-page API at this commit (no `get_page` body window, no `append_page`, no upload session), so the native arm reports "capability absent" and every quality rule has no value. The category stays report-only and held, as preregistered. This receipt is the "before" that each large-pages wave will be compared against.

## The concrete case

A real 1.79 MB iMessage export motivated this category: gbrain stored it and never found anything in it. The generated 2 MB group chat reproduces that exactly. It is 365 days of `**Name** (date time): text` lines between four invented people, with one sentence planted in each tenth of the file, such as "the Orrinmere gate code is 39080" (the place name is invented and appears nowhere else).

On master:

1. `put_page` of the 2,000,112-byte chat succeeds. The page has `embed_skip: oversized` and no chunks, because its body is over `content_sanity.bytes_block` (500,000 bytes by default).
2. `search "Orrinmere gate code"` returns nothing from the chat. The answer is in the stored body; it was never indexed.
3. An agent that already knows the slug and calls `get_page` gets a 2,042,154-byte response, 1.9 times the 1 MiB cap a remote client is expected to accept.
4. Appending a day means rewriting the whole page with `put_page`. The rewrite succeeds, and the appended fact is still unfindable.

Split into 365 day pages plus a hub, the same chat gives 754 chunks. All 40 facts are found at rank 10 or better, and each read is a single day page of at most 7,176 bytes.

## The experiment and results

**Build.** The corpus comes from `eval/generators/n14-large-page-gen.ts` (version `n14-large-page-gen/v1`, seed 14). The 2 MB tier holds a 2,000,112-byte chat, a 2,000,437-byte project log and a 1,500,522-byte novel (ledger SHA-256 `c09ed85562906f0fd9d959eed907d85743c544085711d31ff5e0490ece1fb436`, pinned in `test/eval/n14-large-page-fidelity.test.ts`). The chat is also generated at 20,000,039 bytes (ledger `aa3db342…`) and 200,000,076 bytes (ledger `3b390e29…`). Each document has 40 needles, four per decile (a number, a date, a surname and a colour), and each needle has a distractor five deciles away. Each document also has a fixed 1 KB append holding one more needle. Presence checks rescanned the raw bytes before scoring and passed on all five documents. Each brain also found 4 of 4 needles on its small control page.

**Run.** The runner is `eval/runner/n14-large-page-fidelity.ts` at gbrain-evals `b654b38`; the receipts record `git_head` `28c12a2`, which adds only documentation on top of it. gbrain is master `c71fe7436e673db819c1be4532504b861e14ad50` (v0.60.225.0), loaded as an overlay with `--gbrain`. The runner used Bun 1.4.2, because gbrain master's export path needs Bun 1.4 or newer. Each (document, arm) pair ran in a fresh in-memory PGLite brain, in its own child process, inside a `systemd-run` scope with `MemoryMax=6G` on a 4-core machine. The 200 MB tier ran one child at a time.

```
bun eval/runner/n14-large-page-fidelity.ts --tier 2mb   --gbrain <checkout>@c71fe74… --output docs/benchmarks/2026-10-14-n14-large-page-fidelity-baseline/2mb   --record-bugs
bun eval/runner/n14-large-page-fidelity.ts --tier 20mb  --gbrain <checkout>@c71fe74… --output …/20mb  --record-bugs
bun eval/runner/n14-large-page-fidelity.ts --tier 200mb --concurrency 1 --gbrain <checkout>@c71fe74… --output …/200mb --record-bugs
```

All three receipts have `run_status: completed` and no errors. Refusals are scored as misses, not as harness errors. The receipts record the source tree as dirty. The only uncommitted changes during the runs were the receipts themselves, which replace an earlier run of the same code with identical counts, and wording in this report and the receipts manifest. The bug-ledger entries come from that earlier run with `--record-bugs` (2026-10-14, same commit for gbrain); every count in this report is identical across the two runs. The run was hermetic and cost $0: provider keys were stripped, search ran on the keyword path, and the append-cost embedder was an in-process counter.

**Recall, reads and storage.** The native arm was capability absent in every cell. Recall is keyword needle recall@10 over the 40 needles of each document.

| Tier | Document | Arm | Ingest | Chunks | Recall@10 | Worst decile | Reads correct | Largest response (bytes) | Round trip |
|---|---|---|---|---:|---:|---:|---:|---:|---|
| 2 MB | chat | single-page | stored, `embed_skip: oversized` | 0 | 0/40 | 0.00 | 0/0 | 2,042,154 | match |
| 2 MB | chat | managed-parts | stored, 366 pages | 754 | 40/40 | 1.00 | 40/40 | 23,901 | match |
| 2 MB | log | single-page | stored, `embed_skip: oversized` | 0 | 0/40 | 0.00 | 0/0 | 2,049,651 | match |
| 2 MB | log | managed-parts | stored, 366 pages | 824 | 40/40 | 1.00 | 40/40 | 36,878 | match |
| 2 MB | novel | single-page | stored, `embed_skip: oversized` | 0 | 0/40 | 0.00 | 0/0 | 1,510,597 | match |
| 2 MB | novel | managed-parts | stored, 42 pages | 667 | 40/40 | 1.00 | 40/40 | 38,615 | match |
| 20 MB | chat | single-page | refused, `request_too_large` | 0 | 0/40 | 0.00 | 0/0 | 2,932 | not stored |
| 20 MB | chat | managed-parts | stored, 1,030 pages | 8,695 | 40/40 | 1.00 | 40/40 | 65,071 | match |
| 200 MB | chat | single-page | refused, `queue_capacity` | 0 | 0/40 | 0.00 | 0/0 | 3,009 | not stored |
| 200 MB | chat | managed-parts | stored, 2,900 pages | 88,720 | 40/40 | 1.00 | 40/40 | 181,011 | match |

Delivered recall, which tests the text the result row hands the agent, equals stored recall in every cell. No search ranked a distractor above its needle. On managed parts the largest response grows with the hub page: at 200 MB it is the default `get_page` of the 2,900-link hub, 181,011 bytes, still under the cap.

**Decision rule (held).**

| Rule | Preregistered | Observed |
|---|---|---|
| Crashes or OOM kills, all sizes up to 200 MB | 0 | 0 |
| Responses over 1 MiB | 0 | 3 (the three 2 MB single-page default reads) |
| Round-trip byte loss | 0 | 0 |
| Presence failures | 0 | 0 |
| Native keyword recall@10 at 2 MB | ≥ 0.90 | none (capability absent) |
| Native append embedding ratio | ≤ 3 | none |
| Native recall gap to managed parts | ≤ 2 points | none |

The verdict is `fail` and the registry reports it without gating. The paid arm's rule (hybrid recall@10 ≥ 0.95 at every decile) was not run; this lane is hermetic only.

**Append cost (exploratory).** These are embedding inputs sent after the 1 KB append, from the counting embedder, with tokens estimated as bytes / 4.

| Tier | Document | Arm | Inputs | Tokens | Appended tokens | Ratio | Chunks rewritten |
|---|---|---|---:|---:|---:|---:|---:|
| 2 MB | chat | managed-parts | 2 | 558 | 261 | 2.14 | 2 |
| 2 MB | log | managed-parts | 4 | 1,390 | 250 | 5.56 | 4 |
| 2 MB | novel | managed-parts | 2 | 744 | 268 | 2.78 | 2 |
| 20 MB | chat | managed-parts | 4 | 3,038 | 258 | 11.78 | 4 |

The append writes two pages, the new part and the hub. Embedding inputs equal chunks rewritten in every row, so everything past the part's own single chunk is the hub's index being re-embedded. That cost grows with the number of parts. The single-page arm has no ratio, because its page has no chunks before or after the append. The 200 MB tier skips the embed pass.

**Time and memory (exploratory).** Peak RSS is for the whole child process, which holds the harness's copy of the document as well as gbrain's working set.

| Tier | Document | Arm | Ingest (s) | Embed pass, counted (s) | Child wall (s) | Child peak RSS (MB) |
|---|---|---|---:|---:|---:|---:|
| 2 MB | chat | single-page | 1.0 | – | 6.1 | 1,184 |
| 2 MB | chat | managed-parts | 12.8 | 8.2 | 26.4 | 1,470 |
| 2 MB | novel | managed-parts | 2.8 | 5.5 | 12.8 | 1,137 |
| 20 MB | chat | single-page (refused) | 3.0 | – | 9.2 | 2,332 |
| 20 MB | chat | managed-parts | 39.9 | 134.5 | 183.4 | 2,257 |
| 200 MB | chat | single-page (refused) | 2.8 | – | 9.4 | 4,007 |
| 200 MB | chat | managed-parts | 228.4 | – | 261.1 | 4,910 |

The 2 MB tier, which is the CI tier, ran in 45.1 s of hermetic arm time against the preregistered 60 s target. Managed parts embedded about 276,000 to 290,000 estimated tokens per MB on every document.

**Harness fixes after the preregistration commit.** Three runner changes landed before these receipts, and none changes a rule, threshold, arm or model.

- `08c4888` adds finding N14-4.
- `686f541` returns gbrain's AI gateway to keyless after each counting embed pass. Before this fix, the counting embedder's placeholder key stayed installed. The post-append searches then ran gbrain's default cheap-hybrid over hash vectors instead of the keyword path every other probe uses, and at 20 MB that pushed the appended needle out of the top 10. It also let writes after the first pass embed at write time, outside the counted pass. That is why earlier smoke runs showed append ratios of 1.07 to 4.50 at 2 MB, against 2.14 to 5.56 here: the earlier counts missed the inline embeds. After the fix, embedding inputs equal chunks rewritten in every cell.
- `b654b38` scrubs home and temp paths from the receipt (the `--gbrain` checkout path leaked) and makes `--record-bugs` write a dated rerun review naming the receipt for each finding.
- After review, `overlaySummary` records `requested` as `gbrain@<ref>` instead of the checkout path. The three committed receipts were edited to match: `resolved_config.gbrain_overlay.requested` changed from a home-relative path to `gbrain@c71fe7436e673db819c1be4532504b861e14ad50`. Nothing else changed.

## gbrain bugs found

These are recorded in `docs/benchmarks/2026-10-01-wave-bugs.json` (rendered in `2026-10-01-wave-bugs.md`). All were reproduced at `c71fe74`.

| Id | Kind | Surface | What happens |
|---|---|---|---|
| N14-1 | feature gap | `put_page` → content sanity | A page over 500 KB is stored with `embed_skip: oversized` and no chunks, so it can never be found: 0/40 recall on each 2 MB document while 40/40 needles are in the body. |
| N14-2 | feature gap | `put_page` → persistence preparation | A 20 MB page is refused with `request_too_large` (the 5 MB `MAX_FILE_SIZE`). gbrain documents the limit and tells the user to split the file. |
| N14-3 | feature gap | `get_page` (default) | There is no windowed read or response budget, so a default read of a stored 2 MB page returns a 2,042,154-byte response (1.9 times the 1 MiB cap). |
| N14-4 | bug | `put_page` → persistence admission (`src/core/persistence/journal.ts`, intent-bytes check) | A 200 MB page on an empty brain is refused with `queue_capacity` ("Write capacity exhausted: principal intent bytes"). The cause is that the per-request intent-byte cap (`persistence.limits` principal intent bytes, 32 MiB default) is checked before the 5 MB size screen. `src/core/error-registry.ts` registers `queue_capacity` as retryable ("the bounded queue is full"), so an agent following the error contract waits and retries a write that can never be admitted. The same page at 20 MB gets the correct, non-retryable `request_too_large`. Expected: any page over the size limit is refused as too large, whatever its size. |

N14-1 to N14-3 are the gaps the large-pages plan (Waves A to C) is designed to close. N14-4 is a misclassified refusal that can be fixed on its own.

Receipts: [2mb](2026-10-14-n14-large-page-fidelity-baseline/2mb/receipt.json), [20mb](2026-10-14-n14-large-page-fidelity-baseline/20mb/receipt.json), [200mb](2026-10-14-n14-large-page-fidelity-baseline/200mb/receipt.json). Preregistration: [2026-10-14-n14-large-page-fidelity-preregistration.md](2026-10-14-n14-large-page-fidelity-preregistration.md).
