# Preregistration: N14 large-page fidelity (2026-10-14)

Frozen in the same commit as the N14 registry row (`large-page-fidelity`), the runner and the generator, before any counted run. A later change to a rule, threshold, model list or arm is written into the Amendments section below before the run it affects.

## Question

If I put one very large document in gbrain, can an agent find and read what's deep inside it, and does keeping it up to date stay cheap?

The motivating case is a real one: a 1.79 MB iMessage conversation that gbrain stores but never finds. The large-pages plan (gbrain, approved 2026-10-14, autoplan run `run-20261014163234`) replaces whole-page handling with segmented storage in three waves. N14 is that plan's measuring stick. Its baseline runs against current gbrain master before Wave A merges, so every wave reports a before and an after on the same documents and questions.

## Evidence class

Synthetic production path. The documents are generated with known answers; every arm goes through gbrain's own operation handlers on PGLite. Hermetic results use keyword search only and a counting fake embedder, so they prove findability, read shape, append cost and storage fidelity, not semantic search quality. The paid arm adds real embeddings and reader models.

## Build and data

- Generator: `eval/generators/n14-large-page-gen.ts`, version `n14-large-page-gen/v1`, seed 14.
- Tiers. `2mb` (the CI tier): a 2.0 MB group chat, a 2.0 MB project log and a 1.5 MB novel. `20mb`: the chat at 20 MB. `200mb`: the chat at 200 MB. `1gb`: the chat at 1 GB, listed for manual runs only.
- Shapes. The chat uses the imessage-slack line shape `**Name** (YYYY-MM-DD h:mm AM): text` under `## YYYY-MM-DD` day headers, with four fictional participants and some non-ASCII text (accents, emoji, CJK). The log has one `## YYYY-MM-DD` entry per day with `### Standup` and `### Notes` bullets. The novel has `## Chapter N: Title` sections of prose. Every name and place is invented.
- Needles. Four per decile of the document's bytes: a number, a date, a person's surname and a colour, each in a sentence "the <Anchor> <noun> is <answer>" where the anchor is an invented place name used nowhere else. Every needle has a distractor five deciles away: the same sentence with one detail changed (the place name, which carries its own value).
- Append. Every document has a fixed 1 KB append: a new day or chapter holding one more needle.
- Control page. Every brain also holds a small page (`notes/n14-control`) with one needle per type.
- Oracle. `checkPresence` rescans the raw bytes: each needle, distractor, append and control answer occurs exactly once as a whole token, at its ledger offset, in its decile and section; each anchor occurs once. A failure makes the run an error.

gbrain under test: the pinned dependency (`77cf8e111`, v0.60.169.0) by default; the baseline is master `c71fe7436e673db819c1be4532504b861e14ad50` (v0.60.225.0) through `--gbrain`.

## Capability and entrypoints at the tested commits

Checked at master `c71fe74` (line numbers) and at the pin `77cf8e1` (same behaviour; lines differ by a few).

- Write: `put_page` (`src/core/ops/pages.ts:301`), trusted local caller. A body over `content_sanity.bytes_block` lands with `frontmatter.embed_skip` and zero chunks (`DEFAULT_BYTES_BLOCK = 500_000`, `src/core/content-sanity.ts:66`). Markdown over `MAX_FILE_SIZE = 5_000_000` (`src/core/import-screen.ts:39`) is refused with `Content too large` (`src/core/markdown.ts:480`), surfaced by put_page as `request_too_large`.
- Search: the `search` operation (`src/core/ops/search.ts:666`), keyword only without a provider key. Results carry `chunk_id`; at most two chunks per page survive dedup (`MAX_PER_PAGE = 2`, `src/core/search/dedup.ts:25`); conversation hits deliver an evidence window up to `EVIDENCE_BLOCK_CHAR_CAP = 60_000` characters (`src/core/search/evidence-delivery.ts:60`).
- Read: `get_page` (`src/core/ops/pages.ts:84`) takes `slug`, `fuzzy`, `include_content`, `content_only` and a few flags. There is no `body` mode, window, cursor or response budget.
- Append: no `append_page` operation; an append rewrites the page with `put_page` and `expected_revision`.
- Embedding: `runEmbedCore({ stale: true })` (`src/commands/embed.ts:440`) embeds chunks without a vector through the gateway; a fresh brain is configured for `voyage:voyage-4` at 1024 dimensions.
- Export: `runExport` (`src/commands/export.ts:26`) with `--slug-prefix`; a page payload over 32 MiB aborts the export (`EXPORT_PAYLOAD_LIMIT`, `src/core/export-stage.ts:7`). The body is stored trimmed (`compiled_truth.trim()`, `src/core/markdown.ts:425`) and serialized between a blank line and one newline (`src/core/markdown.ts:961`); the round trip applies that documented framing to the source and compares the rest byte for byte.

Not implemented at either commit, recorded as gaps rather than failures: windowed reads, append_page, upload sessions, any large-page size class. The native arm therefore reports "capability absent".

## Arms

Same documents, same questions, one fresh brain per (document, arm), each in its own child process under an RSS watchdog (6 GiB ceiling).

1. **single-page**: gbrain as it is. The whole document is one `put_page`; a search hit is read with a default `get_page {slug}`; the append rewrites the page.
2. **managed-parts**: the best split design available today, the one the conversation-archive skill and `imessage-daily` pages use. A hub page holds the preamble and a wikilink index; each `## ` section (a day or a chapter) is its own page (`imessage-daily` for the chat, `note` otherwise). A hit is read with `get_page {slug}` of its part. The append writes one new part and updates the hub.
3. **native**: the same gbrain through its large-page API. It runs when a probe of the operation registry finds `get_page` declaring a `body` parameter with a window mode; it then reads hits with `get_page {slug, body: 'window', around_chunk_id}`, appends with `append_page` when that operation exists, and writes documents over 4 MiB through an upload session when one exists. Otherwise the arm is reported as "capability absent".

## Metrics and denominators

Hermetic, per (tier, document, arm):

- Ingest outcome: stored, refused (with the gbrain code) or error; pages, chunks, `embed_skip`.
- Keyword needle recall@10 by decile: the share of the decile's needles (4 per document) whose answer appears, as a whole token, in the stored chunk (`content_chunks.chunk_text` by `chunk_id`) of one of the top 10 `search` results; a passage over 64 KiB never counts. Overall recall pools the 40 needles.
- Delivered recall: the same test on the text the result row delivers to the agent.
- Read correctness: a read made for a hit returns text holding the needle and its frame is at most 1 MiB.
- Largest response frame: the byte length of the JSON-RPC text frame that would carry each operation result over MCP; responses over the 1 MiB egress cap are counted.
- Append cost: embedding inputs and estimated tokens (UTF-8 bytes / 4) that `runEmbedCore({stale: true})` sends after the 1 KB append, counted by a fake embed transport, divided by the appended tokens (same estimate); chunk rows rewritten and deleted. Undefined (null) when the page has no chunks after the append.
- Round trip: export, reassemble (managed parts: hub preamble plus parts in key order, joined by one blank line), compare sha256 with the source body plus the append.
- Ingest wall time, peak RSS and RSS over the post-schema baseline, measured inside the arm's own process.

Paid (not run in the baseline): hybrid (`query`, expansion off) and vector-only (`searchVector` on the query embedding) recall@10 by decile with real `voyage:voyage-4` embeddings at 1024 dimensions; reader QA on the deep needles (deciles 5 to 9) where each model answers from the top 5 hybrid results (2,000 characters each), scored by exact answer token, with the distractor's value counted as a confusion.

## Decision rule

Safety contracts, gating at once (registry `data.safety.*`):

1. Zero crashes or OOM kills at every size run up to 200 MB (`crashes == 0`).
2. Zero response frames over the 1 MiB egress cap (`responses_over_cap == 0`).
3. Zero byte loss on the export round trip for any stored document (`roundtrip_byte_loss == 0`).
4. Presence assertions pass, including every brain finding its control page (`presence_failures == 0`).

Utility floor: native keyword needle recall@10 at the 2 MB tier is at least 0.90 (`data.floor.native_keyword_recall_2mb >= 0.9`). A refuse-everything or skip-large-pages system scores 0 and fails.

Quality thresholds (hermetic receipt):

- Embedding inputs for a 1 KB append are at most 3x the appended tokens on the native arm, worst document (`data.quality.native_append_embed_ratio_max <= 3`).
- Native recall is not worse than the managed-parts arm by more than 2 points on any document and tier (`data.quality.native_recall_gap_points_max <= 2`).

Quality threshold (paid receipt, `data.paid.gates`): hybrid needle recall@10 is at least 0.95 at every decile for the 2 MB and 20 MB tiers, on the managed-parts and native arms.

Exploratory, never gating: ingest time and RSS curves by size, embedding tokens per MB (cost per MB at the provider's price), 200 MB recall, delivered recall, distractor preference, append cost and chunk rewrites on the comparator arms.

Held: the rules are evaluated and reported but do not gate while the native capability is absent at the pinned gbrain. The hold is removed in the commit that re-pins gbrain to a build with the capability; no rule value changes with it.

## Models (paid arm)

`bun scripts/model-freshness.ts` on 2026-10-14 reported the newest models: `claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-6.1-sol` (and `claude-fable-5-1`). The counted readers are `anthropic:claude-opus-5-5`, `anthropic:claude-sonnet-5-5` and `openai:gpt-6.1-sol`. Fable runs only in a smoke test, never in a counted cell. No older generations, no gpt-5.4-mini. Embeddings: `voyage:voyage-4`, 1024 dimensions (gbrain's default for a fresh brain).

## What each outcome changes

- Baseline (master, before Wave A): expected to show the single-page arm stored but unsearchable at 2 MB and refused at 20 MB, an over-cap frame on a default read, and managed parts as the working comparator. These are recorded as scored misses and gbrain feature gaps, not as harness errors.
- After each wave: the same command with `--gbrain <checkout>@<wave head>`. The native arm turns on when the capability probe finds it, and the rules decide whether the wave delivered.
- A safety failure on any arm blocks a promotion of the category to gating even when quality passes.

## Budget

Hermetic: $0, no provider call. Measured 2 MB tier run time under 60 seconds on a 4-core machine is the CI target. Paid: estimated $8 for the 2 MB and 20 MB tiers (embeddings about $0.5; reader QA about 480 short calls), run only with `--paid --budget-run-id <id> --preregistration <this file>` under the wave budget ledger.

## Disclosure

The counting embedder returns hash vectors: it measures how many inputs gbrain sends, never retrieval quality. The hermetic arm does not exercise vector search, Postgres, transports other than in-process operations, sync from a repository or the git layout. The managed-parts arm is a harness implementation of the documented split design, not a gbrain feature; its splitting code is part of this repository.

## Amendments

### Amendment 1 (2026-10-15): Wave A rerun

This amendment was written before any run against gbrain `44eb0493ff2776f04d6616b1a526657702f7544a` (master, v0.60.242.0). That commit contains large pages Wave A: #6707 (the windowed read contract), #6715 (crash fixes) and #6733 (the 24 MiB ceiling, large-page embedding and `gbrain reindex --oversized`). No rule, threshold, model or arm definition changes.

1. **Scope.** The hermetic arm runs at 2 MB and 20 MB with all three arms. The paid arm does not run, because no budget is approved. The 200 MB chat runs on the single-page and native arms only, to check the refusal over the 24 MiB ceiling (bug N14-4). Managed parts is not rerun at 200 MB.
2. **Native arm.** The capability probe is expected to find `get_page` declaring `body` with a `window` mode and `around_chunk_id` (#6707), and no `append_page` or upload session. As preregistered, the native arm then writes each document with one `put_page`, reads hits with `get_page {slug, body: 'window', around_chunk_id}` and appends with a whole-page `put_page` rewrite.
3. **Upgrade-path case (exploratory, not gating).** For each 2 MB document, the baseline gbrain `c71fe74` seeds a file-backed PGLite brain with the document as a single page, which it stores with `embed_skip: oversized` and no chunks, plus the control page. The gbrain under test then opens the brain, which runs its migrations, and runs `runOversizedBackfill` (the code behind `gbrain reindex --oversized`).
   - Reported: the backfill receipt (candidates, reindexed, held for approval, remaining, failed), whether the marker was removed, and the chunk count.
   - The native arm's probes then run on the upgraded page: keyword recall@10 by decile, windowed-read correctness, largest response, round-trip sha256 and the append.
   - There is no embed pass: the backfill holds pages over 1 MiB for approval, and the hermetic arm spends nothing.
   - Expected: recall equal to the native arm on a fresh brain.
4. **Agent-facing default read (exploratory).** At Wave A, what a default `get_page` returns depends on the caller. A trusted local read stays full. An agent-facing read gets `auto`, which above 256 KB is an outline plus the first window. This harness calls as a trusted local caller, so its default read of a single page returns the whole page. The runner also makes the entry page's default read with `remote: true` and reports that response size beside the trusted one, outside the egress count. The egress safety contract is unchanged: it counts every response of the trusted-local harness, the default read included.

### Amendment 2 (2026-10-15): Wave B PR 1, segmented storage (exploratory)

This amendment was written before any counted run against gbrain `7f3c9f5f19862372d056c713942564dd165f62ba` (master, v0.60.252.0, #6787). That commit adds segmented page storage and a streamed file import behind `pages.segmented_storage`, which defaults to `off`. Development smoke runs of the 2 MB tier at that commit shaped the runner changes below; they are not results. No rule, threshold, model or arm definition changes.

1. **Evidence class.** Every run under this amendment is exploratory and not counted. The windowed read of a segmented page arrives with Wave B PR 2, so at this commit the native read path cannot read a segmented body. No run here changes the category's status, and the bug ledger records reviews, not new findings.
2. **Switch on.** Each child brain sets `pages.segmented_storage=on` after `initSchema` (runner flag `--config`). The hermetic arm runs at 2 MB and 20 MB with all three arms, and the 200 MB chat on the single-page and native arms. A second native run at 200 MB writes the document with `importFromFile` under the brain's body policy (`--native-ingest import`), the only path past the 24 MiB single-string ceiling at this commit. On PGLite the segmented ceiling is 128 MiB, so a refusal at 200 MB is expected there. Postgres (256 MiB) is not run, because this harness is PGLite-only.
3. **Switch off (no-regression check).** The same gbrain runs with no config overlay at 2 MB and 20 MB with all three arms, and at 200 MB on the single-page and native arms. Expected: the Wave A results on recall, reads, round trip, refusals and append ratios.
4. **Added measures, reported and not gated.**
   - The entry page's storage class, body bytes, segment count and body generation.
   - For an append to a segmented page: live segments, segments at the new generation, segment texts added and their bytes. Expected: one tail segment written.
   - A segment round trip: the page's live segment texts joined in order, compared by sha256 with the same expected body as the export round trip. It is reported beside the export round trip and stays outside the safety count. The export round trip stays the safety measure: an export that refuses counts as round-trip loss, as preregistered.
   - Expected at this commit: `get_page` (default and window) and `gbrain export` refuse a segmented page with `page_body_segmented`. Refused reads are scored misses.
5. **Unchanged.** The append stays the preregistered 1 KB day; gbrain's own 10 KB append benchmark is not rerun. The upgrade-path case is not rerun. The paid arm does not run.

### Amendment 3 (2026-10-15): accepted-pending writes and the segmented projection

This amendment was written after the first runs under Amendment 2 (runner `7256bc5`) and before the runs that are reported. Those first runs found two gaps in the harness, not in the rules, so their receipts are superseded and not published; the report states what they showed. No rule, threshold, model or arm definition changes.

1. **Accepted-pending writes.** A `put_page` that is accepted but not committed within its reply deadline answers `write_pending` with a write receipt. Its contract says to poll `get_write_request` until the receipt is final. The runner now does that, with a 240 s bound, and uses the committed receipt's revision for the next write. A receipt that ends `conflict`, `failed` or `cancelled`, or is still pending at the bound, counts as a write error. The number of pending writes and the time spent polling are reported. The first runs instead counted the 20 MB `write_pending` reply as a write error and then sent the append without an expected revision.
2. **Segmented projection.** A segmented page's chunks are built and its text projection sealed after the write commits, so the page is not searchable at the moment of the reply. Before probing, and again after the append, the runner waits until the page's `text_projection_revision` equals its `knowledge_revision`, with a 240 s bound. It reports whether the page was already sealed at the reply and how long it waited. Ingest time includes this wait. The first runs probed at the reply and found 0/40 at 20 MB.

### Amendment 4 (2026-10-18): Wave B PR 2 and the switch-on, default config

This amendment was written before any counted run against gbrain `f717b1a5b1c71871c5b6530e98bd1d540a38c70d` (master, v0.60.299.0). That commit contains large pages Wave B PR 2 (#6900, merge `0fb905d3`, v0.60.290.0: windowed reads, forget and purge, delete and restore, and export of segmented pages) and the switch-on (#6963): `pages.segmented_storage` defaults to `on`, so a page over 1 MiB is stored in segments up to 256 MiB on Postgres and 128 MiB on PGLite. `put_page` stays limited to 24 MiB per call, and larger pages come in through the file import. Development smoke runs at 2 MB on both engines and one 100 MiB PGLite sizing run shaped the runner changes below. They are not results. No rule, threshold, model or arm definition changes.

1. **Default config.** No run sets `pages.segmented_storage` or any other brain config: no `--config` overlay and no environment override. gbrain's own defaults decide the storage class, the ceiling and the read modes.
2. **Tiers.** Four binary tiers sit on gbrain's limits, all the frozen `n14-large-page-gen/v1` chat at seed 14. The earlier tiers keep their ledger hashes.
   - `24mib`: 25,100,288 bytes, just under the 24 MiB per-call write ceiling.
   - `100mib`: 104,857,600 bytes.
   - `128mib`: 134,152,192 bytes, just under the PGLite ceiling.
   - `256mib`: 268,369,920 bytes, just under the Postgres ceiling and over the PGLite one.
   - `260mib`: 272,629,760 bytes, just over the Postgres ceiling.
3. **Engines.** PGLite stays in-memory with one brain per child. A new `--engine postgres` option runs each child on a fresh database that the harness creates and drops in a local `pgvector/pgvector:pg16` server. The receipt records the server version, not the URL.
4. **Runs.**
   - PGLite: `2mb` with all three arms; `20mb` and `24mib` with all three arms, one child at a time; `100mib`, `128mib`, `200mb`, `256mib` and `260mib` on the single-page and native arms, one child at a time.
   - Postgres: `2mb` with all three arms; `100mib`, `128mib`, `200mb`, `256mib` and `260mib` on the single-page and native arms, one child at a time.
   - At 100 MiB and above the native arm writes with `importFromFile` under the brain's body policy (`--native-ingest import`), the documented path for a page over 24 MiB. The single-page arm keeps `put_page`, so its refusal over 24 MiB is measured. Managed parts does not run above 24 MiB.
   - The counting embedder runs at 2 MB, 20 MB and 24 MiB. Above that the append cost is reported as chunk rows and segments rewritten, without an embed pass.
5. **Counted and exploratory.**
   - Counted, as preregistered: on PGLite at every tier up to 200 MB, the four safety contracts (crashes, responses over the egress cap, round-trip byte loss, presence), the 2 MB native recall floor and the native-versus-parts recall gap at 2 MB, 20 MB and 24 MiB.
   - Exploratory, reported against the same rules: PGLite at 256 MiB and 260 MiB, past the preregistered 200 MB range, and every Postgres cell, because the preregistration's hermetic arm is PGLite-only.
   - Held: `native_append_embed_ratio_max` stays reported, not counted, until Wave B PR 3, the append path, is built and pinned. The registry row stays held as a whole, so it does not gate.
   - Unchanged from earlier reports: the trusted-local egress rule stays a reported result, as before.
6. **Settle bound.** The Amendment 3 polls of `write_pending` writes and of the projection seal now wait up to the greater of 240 s and 3 s per MB of the document (805 s at 256 MiB), so a large import is not probed half-projected. At 2 MB and 20 MB the bound is 240 s, as before.
7. **Lifecycle (exploratory, `--lifecycle`).** After the round trip, on the single-page and native arms whose document was stored, the runner runs four steps in order. One needle query per decile (10 probes) is searched before each step and after delete and restore. Lifecycle calls stay outside the egress count.
   1. Forget: append a one-row `## Facts` fence through the arm's write path, `forget_fact` its row, then check the fact is withdrawn, `recall` no longer returns it and the exported row is struck. On a page over 24 MiB the fence write is expected to refuse, because facts fences are limited to 24 MiB; that is reported as such.
   2. Soft delete: `delete_page`, then count probe hits and read the `get_page` result code.
   3. Restore: `restore_page`, then count probe hits and check that the export is byte-identical to the export before the delete.
   4. Purge: `delete_page` with `purge: true` (trusted local). Count what is left of the page: page, chunk, manifest and version rows, fact rows, needle answers in any chunk or segment text, and unreferenced segment texts with their bytes. Then run `sweepSegments({ graceMs: 0 })` and count again.
8. **Comparison.** The report compares Wave A (`44eb0493`, #159) and Wave B PR 1 with the switch forced on (`7f3c9f5f`, #165). Published reports stay unchanged, and corrections go in the new report as errata.
9. **Unchanged.** The append stays the preregistered 1 KB day. The paid arm and the upgrade path do not run, so spend is $0.

### Amendment 5 (2026-10-20): Wave B PR 3, append and upload sessions

This amendment was written before any counted run against gbrain `6e1086492dbded0059fcfabc627b846ced7855f4` (master, v0.60.324.0). That commit contains large pages Wave B PR 3 (#7104): `append_page` (idempotent by `request_id`, with an `expected_tail_sha256` guard), upload sessions (`begin_page_upload`, `upload_page_part`, `commit_page_upload`) for a page larger than one request, and `edit_page within` on segmented pages. It also contains the large-pages hardening (#7081): a purge deletes the unreferenced segment texts that hold the page's claims (the N14-5 fix), the segmented re-mirror repair, and the transient retry budget. Development smoke runs of the chat on the native arm at 2 MB, 24 MiB, 100 MiB and 128 MiB on PGLite shaped the runner changes below. They are not results. No rule, threshold, model or arm definition changes.

1. **The native arm as preregistered.** The capability probe now finds `append_page` and the three upload operations. As the Arms section preregistered, the native arm then appends with `append_page` and writes every document over 4 MiB through an upload session (`mode: create`). The parts end on code points, each `upload_page_part` frame fits the `part_max_frame_bytes` the session returns, and a `write_pending` commit is polled like any other write (Amendment 3). This replaces Amendment 4's `--native-ingest import` at 100 MiB and above, which no counted run passes. Documents up to 4 MiB keep `put_page`.
2. **Append text.** gbrain stores a page body trimmed (documented framing, see Capability), and `append_page` with `separator: auto` adds at most one newline. So the native append sends the source's trailing whitespace, then the 1 KB day, with `separator: 'none'`, and the page holds exactly the source plus the append, which is what the round trip compares. The appended-token count stays that of the 1 KB day. With `separator: auto`, a 2 MB smoke stored one newline where the source has a blank line before the day, a one-byte mismatch that came from the harness's call, not from gbrain.
3. **Lifecycle forget.** The native arm writes the one-row facts fence through the same write path: an upload session with `mode: replace` and the page's current revision when the page with its fence is over 4 MiB, else `put_page`. `append_page` refuses text holding a facts fence marker by design, so the fence cannot come in as an append. A fence write on a page over 24 MiB is still expected to refuse, because a fence edit reads the body whole up to 24 MiB. It is reported as such. The single-page arm keeps `put_page`.
4. **Hold lifted.** `native_append_embed_ratio_max <= 3` is counted from this amendment, as the Held paragraph and Amendment 4 item 5 provide. Its value does not change. It is counted on PGLite at 2 MB, 20 MB and 24 MiB, the tiers with the counting embed pass. Above 24 MiB the append cost stays reported as chunk rows and segments rewritten. The registry row stays held only for the trusted-local egress rule, which still waits on a product decision.
5. **Runs.** The engines, tiers and arms of Amendment 4 item 4, with the native arm writing through upload sessions above 4 MiB. Counted and exploratory cells are as in Amendment 4 item 5, plus the append rule. The lifecycle stays exploratory.
6. **Expected before running.**
   - N14-5 closes on both engines: the purge leaves no unreferenced segment text.
   - The recall-gap rule still fails at 24 MiB. The 24 MiB chat's miss is a needle sentence split across two chunks, and the chunker change that would keep it whole is deferred, so it is not in this pin.
   - Forget on pages over 24 MiB stays unreachable through the arm's write path (item 3).
7. **Comparison.** The report compares Amendment 4's run at `f717b1a5` (#178). Published reports stay unchanged, and corrections go in the new report as errata.
8. **Unchanged.** The append stays the preregistered 1 KB day. The paid arm and the upgrade path do not run, so spend is $0.

### Amendment 6 (2026-10-25): Wave B PR 4, per-segment derivations and sentence-aligned cuts

This amendment was written before any counted run against gbrain `7a6bdd3579a3c35d57c63790b428a746fe2f3df7` (master, v0.60.454.0). That commit contains large pages Wave B PR 4 (#7316, merge `baf304c81`, v0.60.453.0, migration v273) and the G7a privacy follow-up (#7586).

PR 4 does four things N14 can see:
- It keeps links, mentions, timeline entries, fences, conversation facts and synopses per segment, so a write reads only the segments it changed and an append reads only its new tail.
- On segmented pages, a forced chunk cut lands on a sentence or line end, and timeline passages break only between bullet entries. Inline pages keep their chunker.
- A new transcript session imports as one page.
- A per-page lease sends each chunk content version to the embedding provider once.

Development smoke runs at 2 MB (single-page and native) and 24 MiB (native and managed parts) on PGLite ran the unchanged runner at the new pin. They are not results. No rule, threshold, model, arm definition or harness code changes.

1. **Same runs as Amendment 5.** Same engines, tiers, arms and write paths, on the default config, with the lifecycle. Counted and exploratory cells are as in Amendment 5 item 5, with the append rule counted.
2. **Expected before running.**
   - Chunk counts on segmented pages change, because of the sentence-aligned cut.
   - The 24 MiB chat's split needle may now be found whole, so the recall-gap rule may pass at 24 MiB. Amendment 5 expected it to fail. Both outcomes are reported against the unchanged rule.
   - N14-5 stays fixed.
   - Forget on pages over 24 MiB stays unreachable through the arm's write path.
3. **Exploratory additions.**
   - **Postgres double embed.** The Postgres 2 MB native arm runs 8 more times, without the lifecycle, to recheck the intermittent doubled embedding input on an append that Amendment 5's report found in 5 of 23 document runs. PR 4's per-page embed lease may remove it. These repeats count nothing, and their receipts stay outside the repository; the report gives their counts.
   - **Incremental append cost.** This is the existing append cells: embedding inputs, chunks rewritten, segments written and append time. No new metric.
4. **Not run.** N14 writes pages through gbrain's operations, not through transcript ingest, so the one-page transcript change has no N14 cell. The paid arm, which would include per-segment fact extraction and synopses, does not run, so spend is $0.
5. **Comparison.** The report compares Amendment 5's run at `6e10864` (#180). Published reports stay unchanged, and corrections go in the new report as errata.
