# gbrain write-path quality audit

**Target:** gbrain master `6bb88d128` (v0.59.3.0). The audit was read-only; `gbrain`
was not modified. Line numbers cite `gbrain`.

**Method:** a lead auditor covered import, sync, chunking, embedding, links, timeline, dates
and images. Two sub-auditors covered (B) facts, takes, contradictions, entities and forget,
and (C) the dream cycle, minions, transcripts and connectors. Every VERIFIED finding was
reproduced against in-memory PGLite in a scratch clone with deps installed
(`audit/scratch-writepath/gbrain-copy`, `.../cmt/repo`), using an isolated
`GBRAIN_HOME`, **no paid API calls ($0)**, and the default write path
(`persistence_brain.enabled = false`, which is the default for every brain). Repro sources:
`scratch-writepath/gbrain-copy/test/zz-audit/`, `scratch-writepath/facts-entities/`,
`scratch-writepath/cmt/repros/`. Logs: `scratch-writepath/*.log`.

**Note for anyone rerunning:** `gbrain` has no `node_modules`, so `bun test` there
fails on missing packages. Use a clone and run `bun install --frozen-lockfile` first.

## Totals

| Section | P0 | P1 | P2 | Total |
|---|---|---|---|---|
| A. Import / sync / chunk / embed / links / timeline / dates / images | 1 | 10 | 6 (A17 bundles smaller items) | 17 |
| B. Facts / takes / contradictions / entities / forget | 3 | 11 | 7 | 21 |
| C. Dream cycle / minions / transcripts / connectors | 3 | 11 | 6 | 20 |
| **Total** | **7** | **32** | **19** | **58** |

## The seven P0s (data loss or corruption; each one reproduced)

1. **A1:** a full sync soft-deletes the page of a *moved* file that carries `frontmatter.id`. The
   `findDuplicatePage` identity dedup skips the new path, then the reconcile deletes the old
   one. Result: zero live pages for a file that exists.
2. **C1:** a retitled ChatGPT/Claude conversation drops all new messages forever, through both
   `transcripts ingest` and live connectors. The cause is the **same fm-id dedup** as A1/A2:
   the slug embeds the title, and the dedup skips without comparing content while the
   watermark advances.
3. **B1:** `forget` on one entity's fact withdraws the same claim for **every entity in the
   source**, because the withdrawal key has no subject. It also blocks re-remembering the claim.
4. **B2:** every first-time `forget` **deletes all `content_chunks` in the source** and queues a
   paid full-source re-embed. Gmail loop supersession triggers this automatically.
5. **B3:** one bad fence row (confidence `7`, or an FK reference) throws out of `extract_facts`
   and aborts reconciliation for every later page, on every cycle.
6. **C2:** `synthesize_concepts` overwrites human-written `concepts/<x>` pages without an
   existence check.
7. **C3:** phantom redirect soft-deletes pages whose content lives in the timeline, and never
   migrates the timeline.

## Cross-cutting themes (why memory quality decays over time)

- **Identity is guessed, not recorded.** The fm-id dedup (A1, A2, C1), fuzzy title and
  keyword resolution (A7, B8), slugify collisions (A3), renames without aliases (A6),
  LLM-title-keyed atoms (C14) and subjectless withdrawal keys (B1) all fail the same way: two
  different things get merged, or one thing gets split, and nothing records it.
- **Derived state only ever grows.** Links (A4), timeline (A5), tags (A14), stale atoms (C14),
  takes (B14) and deleted pages' facts (B7) are added and never reconciled away. Each
  retraction or edit leaves residue that retrieval keeps serving.
- **Retry state is conflated with content state.** Images (A8), connector watermarks (C9–C11)
  and synthesis "done" state stored in prunable `minion_jobs` rows (C12) all mean that a
  transient failure becomes permanent, or a housekeeping command causes paid duplicate work.
- **Silent success.** "skipped (unchanged)" for dedup drops, "imported=2" for a collision,
  "Extracted: 1 links" for zero new links, `catch {}` around extraction (A15, B21), and
  quote-verify keeping made-up text without the quote marks (C7). The operator cannot see
  the degradation.
- **Local-time assumptions.** `effective_date` depends on the host TZ (A11), `valid_from` uses
  the UTC date (B20), fence TTLs are truncated to a UTC date (B6), and cycle phases mix UTC
  and local "today" (C15).

## Top 10 highest-leverage write-path improvements (each with the eval that proves it)

Each eval is meant for gbrain-evals as a deterministic, $0, PGLite-hermetic fixture unless
noted, so it can gate CI rather than only produce a research number.

1. **Record page identity explicitly; never skip on a guess** (fixes A1, A2, A3, C1). Add a
   `page_identity(source_id, external_id, path)` table. An fm-id match with *different
   content* or a *vanished old path* becomes a move (`updateSlug` plus import), never a
   skip. Detect slug collisions at collect time.
   *Eval, "vault churn":* scripted git histories (moves, renames, retitles, case-colliding
   files, template-id reuse) run under incremental **and** full sync. Metrics: every file maps
   to exactly one live page (bijection), 0 lost pages, 0 duplicates, and 0 lost messages for
   retitled transcripts. Today it fails at A1, A2, A3 and C1.
2. **Replace semantics for every derived projection** (fixes A4, A5, A14, B7, C14, B14).
   Links, timeline, tags, atoms and takes are reconciled per origin page in one transaction
   (`replaceDerivedLinks` already exists; generalize it).
   *Eval, "edit-stream graph fidelity":* after each commit in a 200-commit synthetic history,
   diff the DB against ground truth derived from the current files. Metrics: edge
   precision/recall, timeline precision/recall, tag-set equality. Target 1.0 for all three.
   Today edge precision decays on every removed link.
3. **Strict entity resolution** (fixes A7, B8). Resolve exact slug, then title, then alias, then
   `slug_aliases`. There is no fuzzy fallback for person/company/fund targets. Unresolved names
   go to a review queue or to entity creation.
   *Eval, "near-name entities":* a gold set of 500 synthetic people and companies with
   near-duplicate names ("Exa Chen" vs "Exa Cheng"), with mentions in wikilinks, frontmatter
   and facts. Metrics: link and fact-attribution precision (target ≥ 0.99) and recall. This
   also measures the downstream `whoknows` and backlink ranking.
4. **Rename aliasing** (fixes A6, B12). `updateSlug` and the phantom-redirect merge write
   `slug_aliases` and actually rewrite links (`rewriteLinks` is a stub today).
   *Eval:* a rename-then-edit-referrer fixture on both the sync and `put_page` paths. Metrics:
   inbound-edge survival rate = 1.0, and `get_page <old-slug>` resolves.
5. **Subject-scoped, page-scoped `forget`** (fixes B1, B2, B9, B10, B11). Key withdrawals on
   `(source, visibility, subject, fact_hash)`. Invalidate only the pages that contain the
   claim, and swap chunks rather than deleting them. Paraphrase-aware matching.
   *Eval, "forget fidelity":* forget N facts across entities that share claim text. Metrics:
   collateral expirations = 0, unrelated pages keep their chunks (search recall unchanged on a
   held-out query set), 0 resurrections after re-extraction or paraphrase, and embedding
   calls O(affected pages).
6. **Decouple text persistence from embedding and OCR** (fixes A10, A8, A13). Commit text
   first, embed through the stale queue, reuse vectors for unchanged chunks, and track image
   OCR and visual-vector status apart from the byte hash.
   *Eval, "provider outage":* ingest 1K pages and images with the embedder or OCR failing
   (fault injection), then recover. Metrics: 100% of text persisted during the outage, 100%
   embedded and OCR'd after one recovery sweep, and embedding tokens per 1-line edit (should be
   O(1) chunks, not O(page)). Retrieval recall must match a clean ingest.
7. **Timezone-stable, provenance-aware dates** (fixes A11, A12, B6, B20, C15). Parse date-only
   values as UTC calendar dates, add a `brain.timezone` config, reject invalid dates, add the
   `created*` keys, and use the git first-commit date instead of import time.
   *Eval:* run the same mixed-date vault under `TZ=Asia/Tokyo` and `TZ=America/Los_Angeles`.
   Metrics: `effective_date` byte-identical across TZ, `since/until` recall = 1.0, and the
   LongMemEval temporal-reasoning subset delta (paid; run once, < $1 on a small slice).
8. **Idempotent, non-destructive dream writes** (fixes C2, C3, C4, C5, C8, C12, C13). Add an
   existence and human-authorship check before any synthesized write, canonicalize concept
   slugs, store synthesis "done" state durably outside `minion_jobs`, and enforce a hard USD
   gate before spend.
   *Eval, "dream idempotence":* run the cycle 3× on a fixed brain with stubbed LLM output.
   Metrics: 0 human pages modified, 0 duplicate concept/reflection pages, spend on runs 2–3
   = $0, and `jobs prune` followed by a rerun causes 0 new writes.
9. **Per-source, per-item connector checkpoints** (fixes C9, C10, C11, C19). The watermark is
   keyed on `(provider, source)`, advances per conversation, and moves the cursor forward
   across failures while tracking failed items separately.
   *Eval:* a fake connector server with 50 conversations, injected per-item failures, `--limit
   5`, two target sources and mid-list reordering. Metrics: all 50 ingested exactly once in
   both sources within ⌈50/5⌉ runs, 0 duplicates, and a bounded number of re-fetches.
10. **A write-path invariant checker ("brain fsck") used by both doctor and evals.** One module
    asserts the following. Every file maps to exactly one page. DB links equal the links
    derivable from the text. DB timeline equals the derivable timeline. Chunks cover the body
    (property-tested; the recursive chunker passed 300/300 randomized coverage trials in this
    audit). Every live chunk has an embedding whose `embedded_text_hash` matches. No active
    fact belongs to a deleted page. No withdrawn claim appears active in the markdown.
    *Eval:* run it after every step of every fixture above, plus a randomized edit-history
    fuzzer (seeded). Metric: invariant violations = 0. This turns "memory quality over time"
    into a number gbrain-evals can publish and gate on.

## Recommended fix-wave ordering

1. The P0 identity cluster (A1, A2, C1: one root cause in `import-file.ts:716-760` plus
   `findDuplicatePage`), then B1/B2 (withdrawal key and scope), B3 (per-page try/catch in
   `extract_facts`), and C2/C3 (existence and timeline checks).
2. Derived-state replace semantics (A4, A5) and strict resolution (A7, B8), since they compound
   daily.
3. Decoupled embedding (A10) and image retry state (A8).
4. Date and timezone fixes and the connector checkpoints.
5. Ship the fsck invariant module and wire it into gbrain-evals as a CI gate.

---

## A. Import, sync, chunking, embedding, links, timeline, dates (lead auditor)

All repros below ran on a clone of master `6bb88d128` (v0.59.3.0) at
`audit/scratch-writepath/gbrain-copy` (in-memory PGLite, `GBRAIN_HOME`
pointed at a temp dir, no network, $0). Test files: `gbrain-copy/test/zz-audit/*.test.ts`;
logs: `audit/scratch-writepath/*.log`. Line numbers are from `gbrain`.
All repros use the default (non-coordinated, `persistence_brain.enabled = false`) write path.

### A1. [P0 · VERIFIED] Full sync soft-deletes a moved file's page when it carries `frontmatter.id`

**Where:** `src/core/import-file.ts:681-718` (identity dedup pre-check) together with
`src/commands/sync.ts:4262-4330` (full-sync reconcile deletes).

```ts
// import-file.ts:681
if (!opts.forceRechunk && engine.findDuplicatePage) {
  dup = await engine.findDuplicatePage(sourceId ?? 'default', { hash, frontmatterId: fmIdStr });
  if (dup && dup.slug !== slug) {
    ...
    if (sameExternalId) {
      process.stderr.write(`[import] skipping ... identical to ${dup.slug} ...`);
      return { slug: dup.slug, status: 'skipped', chunks: 0, parsedPage };
```

**What goes wrong:** move `inbox/standup.md` to `meetings/standup.md` (same `id:`, e.g. a
meeting-notes UUID, which is the exact population this dedup targets), then run a full sync.
The importer finds the old page by `frontmatter.id`, skips the new path, and does not update
`source_path`. The reconcile pass then sees that `inbox/standup.md` is gone and soft-deletes
`inbox/standup`. That leaves **zero live pages** for a file that still exists. The page
comes back only after the next full sync. If the 72h purge runs first, it is hard-deleted.
Along the way the summary reports it as "2 unchanged". Full sync also runs as the automatic
fallback whenever the git delta is unavailable (`sync.ts:2122-2127`), so this does not need
an explicit `--full`.

**Evidence** (`fmid.log`):
```
[import] skipping meetings/standup.md: identical to inbox/standup (frontmatter.id=uuid-123) in source mv-src.
[import.files] 2/2 (100%) imported=0 skipped=2 errors=0
  Reconciled 1 stale page(s) whose source file was removed (soft-deleted, recoverable 72h).
rows [{"slug":"inbox/standup","deleted_at":"2026-09-28T21:01:05.015Z",...},{"slug":"meetings/other",...}]
```

**Fix:** when the duplicate's `source_path` no longer exists on disk (or is absent from the
current walk), treat the match as a **move**: `updateSlug(dup.slug → slug)` and then import
the new content in the same transaction. Never return `skipped` for a path whose content
differs. At minimum, have the reconcile spare any page that was the target of a dedup skip
during this run.

### A2. [P1 · VERIFIED] A shared `frontmatter.id` silently drops different content and freezes edits

**Where:** same block. `findDuplicatePage` (`src/core/pglite-engine.ts:1722-1737`,
`src/core/postgres-engine.ts:692-712`) matches `content_hash = $2 OR frontmatter->>'id' = $3`
and **does not exclude the caller's own slug**. The importer then skips on the id match
**regardless of whether the content differs**.

**What goes wrong:**
1. Two notes with *different* bodies that share an `id:` (templates, tools that reuse ids,
   copy-paste). The second note is never indexed and reports `status: 'skipped'`.
   Evidence (`fmid.log`): `A imported notes/a B skipped notes/a` and `rows [ "notes/a" ]`.
2. Suppose two pages already share an id (created before v0.41.13, or through
   `--force-rechunk`). When the higher-`id` page is edited, `ORDER BY id LIMIT 1` returns the
   *other* page, so the edit is skipped on every sync from then on and the stored content stays
   stale indefinitely. (This follows from the same code path; only case 1 was run.)
3. When the hash matches page X and the fm id matches page Y, `LIMIT 1` returns X, so the
   true duplicate Y is missed.

**Fix:** add `AND slug <> $current` to `findDuplicatePage`. Skip only when **both** the id
matches **and** `content_hash` matches (a true duplicate). When the id matches but the content
differs, treat it as a move (A1) or fail loudly with a sync-failure record. Never count a
dedup skip as "unchanged".

### A3. [P1 · VERIFIED] Two files that slugify to the same slug overwrite each other silently

**Where:** `slugifyPath` plus the plain `(source_id, slug)` upsert. Plain sync and import have
no collision detection. Only `src/core/company-brain/inspection.ts` checks for this.

**Evidence** (`collide.log`): `notes/Foo Bar.md` ("apples") and `notes/foo-bar.md` ("oranges"):
```
[import.files] 2/2 (100%) imported=2 skipped=0 errors=0
RESULT first_sync [{"slug":"notes/foo-bar","title":"One","source_path":"notes/Foo Bar.md"}]
```
Both files report "imported", but one body is gone. After that, every edit to either file
flips the page to the other body and re-embeds everything. Case-insensitive filesystems and
exporters (Notion, Obsidian) produce these pairs routinely.

**Fix:** during collection, build a `slug → [paths]` map. On collision, either disambiguate
deterministically (for example `foo-bar-2` with a stable ordering) or record a
`SLUG_COLLISION` sync failure for both files and skip them. Add a doctor check that flags
pages whose `source_path` is not the path the current walk would map to their slug.

### A4. [P1 · VERIFIED] Sync-path link extraction only ever adds edges, so removed links persist

**Where:** `src/commands/extract.ts:1650-1664` (`extractLinksForSlugs`, the post-sync
inline hook) and `:1327-1345` (`gbrain extract`). Replace semantics (`replaceFileLinks`) are
used **only** for meeting pages or pages already holding "attended" origin rows
(`src/core/link-reconciliation.ts:174-177`). Every other page goes through:

```ts
if (!reconciled) for (const link of links) {
  try { await engine.addLink(...); created++; } catch {}
}
```

**Evidence** (`rename3.log`): after deleting `[[people/bob-example]]` from `notes/a.md` and
syncing:
```
STEP1 [ "notes/a->people/alice-example(mentions)", "notes/a->people/bob-example(mentions)" ]
  Extracted: 1 links, 0 timeline entries      <- reported "created" for an already-existing edge
STEP2 after removing bob link from text [ "notes/a->people/alice-example(mentions)", "notes/a->people/bob-example(mentions)" ]
```
The graph keeps accumulating edges that the source text no longer supports. Backlink
boosting, `whoknows`, graph traversal and entity pages all degrade over time. The
`created` counter also over-reports, because `addLink` is `ON CONFLICT DO NOTHING` but the
count is incremented regardless.

The two write paths disagree: MCP `put_page` auto-link (`src/core/ops/pages.ts:333-347` →
`persistence/links-preparation.ts` → `replaceDerivedLinks(..., {preserveExisting:true})`)
**does** delete obsolete edges (`src/core/derived-links.ts:122-146`). So the same page edited
two different ways ends up with two different graphs.

**Fix:** route file-sync extraction through `replaceDerivedLinks` for every page, scoped to
`link_source IN ('markdown','wikilink-resolved','frontmatter')` with origin = page. Count
`created` from `RETURNING`. Add a regression test that removing a link removes the edge.

### A5. [P1 · VERIFIED] Timeline entries only ever get added, so corrected or removed dated bullets persist

**Where:** `src/commands/extract.ts:1686-1697` (`extractTimelineForSlugs`) calls
`addTimelineEntry` per parsed bullet and never deletes anything.

**Evidence** (`timeline.log`): I corrected `- **2024-03-01** | Joined acme-example as CTO` to
`- **2024-04-01** | Joined acme-example as VP Eng`:
```
STEP2 [{"d":"2024-03-01","summary":"Joined acme-example as CTO"},{"d":"2024-04-01","summary":"Joined acme-example as VP Eng"}]
```
The retracted fact survives as structured timeline data and contradicts the page. Temporal
queries, trajectory and `think` all read `timeline_entries`.

**Fix:** reconcile per page. Inside one transaction, delete the page's timeline rows whose
`source` is the markdown extractor and are no longer produced, then insert the new set. Key
rows on `(page_id, date, summary_hash, source)`.

### A6. [P1 · VERIFIED] Renames leave no alias, and the `put_page` path then drops inbound edges

**Where:** `updateSlug` (`src/core/pglite-engine.ts:5750-5762`) only rewrites
`pages.slug`. `rewriteLinks` is a stub (`:5764-5766`). Nothing writes `slug_aliases`, and the
live resolver (`src/core/link-extraction.ts:1510-1600`) never consults `slug_aliases` or
`resolveSlugWithAlias`.

**Evidence** (`rename3.log`, STEP3–5): after `git mv people/alice-example.md
people/alice-example-2.md` the edge survives only because it is keyed on page id. The markdown
in `notes/a.md` still says `[[people/alice-example]]`, and `slug_aliases` has 0 rows. On the
file-sync path the stale edge survives by accident (A4's add-only behavior). On any
replace-semantics path (MCP `put_page` of `notes/a`, meeting pages, `reconcile-links`), the
wikilink no longer resolves and the edge is deleted as obsolete. The same logical page ends up
linked or unlinked depending on which path last touched the referrer. Callers that resolve
the old slug (`get_page people/alice-example`) also miss.

**Fix:** have `updateSlug` insert `slug_aliases(source_id, old, new)` in the same transaction.
Make `makeResolver` step 1 fall back to `resolveSlugWithAliasDetailed`. Optionally offer a
`--rewrite-links` write-through that edits referring markdown.

### A7. [P1 · VERIFIED] Fuzzy title resolution links wikilinks and frontmatter to the wrong entity

**Where:** `src/core/link-extraction.ts:1562-1600`. Step 3 uses
`findByTitleFuzzy(trimmed, hint, 0.55, ...)` (pg_trgm similarity 0.55), and live mode adds
step 4, `searchKeyword(trimmed, { limit: 3 })`, with **no source scope** and a raw-score
threshold.

**Evidence** (`fuzzy.log`): with only `Exa Cheng`, `Alice Exampleson` and `Acme Robotics` pages
present:
```
RESOLVE live "Exa Chen"         -> people/exa-cheng
RESOLVE live "Alice Examplston"    -> people/alice-exampleson
RESOLVE live "Alicia Exampleson"    -> people/alice-exampleson
RESOLVE live "Acme Robotic Arms" -> null |nohint-> companies/acme-robotics
```
(batch mode gives identical results; names in this report are placeholders substituted for the ones in the raw log). A `[[Exa Chen]]` mention, or `company: Acme Robotic
Arms` frontmatter, creates a `mentions`/`works_at` edge to a **different real entity**. That
corrupts backlinks, `whoknows`, entity pages and graph-boosted retrieval, and it compounds
because enrichment and dream read the graph. For people, organizations and funds this is the
single most damaging kind of silent write-path error.

**Fix:** never fuzzy-resolve typed entity targets (person/company/fund). Resolve exact slug,
then exact title, then exact alias, and otherwise record the target as unresolved (and let
the entity-creation flow decide). If fuzzy matching stays, require a unique match with
similarity ≥ 0.9 plus a token-set equality check, and log every fuzzy resolution as a
reviewable candidate. Scope step 4 by `sourceId`, or delete it.

### A8. [P1 · VERIFIED] Images imported without OCR or embedding are never retried

**Where:** `src/core/import-file.ts:2040-2056`. The image content hash is the sha256 of the
bytes, and it short-circuits whenever the page is sealed. OCR and visual-embedding status are
not part of that identity.

**Evidence** (`image.log`): first import with `noEmbed`, second import with embedding on:
```
R1 imported R2 skipped [{"slug":"photos/whiteboard.png","source_path":null,"chunk_text":"whiteboard.png","no_img_vec":true}]
```
Any image imported during `--no-embed`, an OCR budget-cap skip (`ocrBudgetExceeded`, "skipped
for the rest of this run"), an OCR provider error or a missing key stays at
filename-only text with no visual vector until its bytes change. `embed --stale` does not
cover `embedding_image` either (`src/core/embed-stale.ts:37-46` explicitly doesn't carry it).
The same log shows the next finding: `source_path` is NULL.

**Fix:** persist `ocr_status` and `image_embedded` (or fold them into a projection revision),
make the hash-skip conditional on both being complete, and add an `embed --stale --images`
sweep.

### A9. [P2 · VERIFIED (code) / SUSPECTED impact] Image pages never record `source_path` on the default path

**Where:** `src/core/import-file.ts:2160`: `...(opts.prepare ? { source_path: relativePath } : {})`.
On the default non-coordinated path `source_path` stays NULL (confirmed in `image.log`). The
full-sync reconcile only considers rows with `source_path IS NOT NULL`
(`src/commands/sync.ts:4309`), so image pages whose files are deleted are **never
reconciled away** by full sync. Incremental delete relies on slug derivation; I did not test
that. **Fix:** always pass `source_path: relativePath`.

### A10. [P1 · VERIFIED] An embedding outage blocks the text write on inline-embed paths

**Where:** `src/core/import-file.ts:847`. `if (!opts.onPostCommitEmbedding) await embedChunks();`
runs **before** `engine.transaction(applyPrepared)` (`:1030`), and errors propagate. No caller
in `src/` passes `onPostCommitEmbedding` (grep: only `import-file.ts` references it), so the
decoupled path is dead code. Callers that embed inline (`transcripts ingest --embed`
`src/core/transcripts/ingest.ts:289`, `ingest-capture` when embeddings are on,
`synthesize-concepts.ts:376`, `enrichment-service.ts:169`, `brainstorm.ts:372`) lose the
**text** write whenever the provider rate-limits or is down. For a memory system that is
backwards: the write should land first, and the vector can come later.
Repro (`embedfail.log`, provider key unset to simulate an outage): `importFromContent(..., {})`
fails with `err="OpenAI embedding requires OPENAI_API_KEY."` and leaves `rows=0`, so the page
text was never stored. **Fix:** always commit
text and chunks first, then embed after commit or leave `embedding IS NULL` for the stale
sweep. Delete or wire up the dead `onPostCommitEmbedding` path.

### A11. [P1 · VERIFIED] `effective_date` depends on the host timezone and on engine-specific date parsing

**Where:** `src/core/effective-date.ts:73-94` (`parseDateLoose` → `Date.parse`). Column is
`TIMESTAMPTZ` (`src/core/pglite-schema.ts:107`).

**Evidence** (same inputs, two `TZ` values, bun/JSC):
```
                       TZ=America/Los_Angeles        TZ=Asia/Tokyo
"March 5, 2024"   ->   2024-03-05T08:00:00.000Z      2024-03-04T15:00:00.000Z
"2024/03/15"      ->   2024-03-15T07:00:00.000Z      2024-03-14T15:00:00.000Z
"2024-03-15 10:00"->   2024-03-15T17:00:00.000Z      2024-03-15T01:00:00.000Z
"2024-02-30"      ->   2024-03-01T00:00:00.000Z      (lenient rollover, both TZs)
```
The same file gets a different effective date, and a **different calendar day**, depending on
which machine syncs it. A `since: 2024-03-05` filter then includes or excludes the page by
machine. An invalid date like `daily/2024-02-30.md` silently becomes March 1.

**Fix:** parse date-only shapes (`YYYY-MM-DD`, `YYYY/MM/DD`, month-name dates) as UTC calendar
dates. Interpret naive datetimes in a configured brain timezone (`brain.timezone`, defaulting
to UTC, never the host). Reject calendar-invalid dates by round-tripping Y/M/D.

### A12. [P1 · VERIFIED (code)] Undated pages get the import time as their effective date, and common date keys are ignored

**Where:** `src/core/effective-date.ts:117-157` (chain: `event_date`, `date`, `published`,
filename, then **updated_at**). `src/core/import-file.ts:884-890` passes
`updatedAt: existing?.updated_at ?? nowDate`. Bulk-importing a ten-year-old vault gives every
undated note today's date, so any recency boost or `since` filter treats old notes as fresh.
Each later edit moves the date to the previous write time. Keys that Obsidian and Notion users
actually use (`created`, `created_at`, `date created`, `modified`) are not in the chain.
**Fix:** add `created*` keys, then fall back to the git first-commit date for the path (sync
already has git) or the file birthtime/mtime. Keep `updated_at` as a last resort and label
it `fallback`.

### A13. [P2 · VERIFIED (code)] Every markdown edit deletes and re-embeds all chunks

**Where:** `src/core/import-file.ts:957` (`tx.deleteChunks` before `upsertChunks`) and `:826-845`
(embeds every chunk). `planEmbeddingReuse` exists but only `importCodeFile` uses it (`:1452`).
A one-character edit to a 60-chunk page re-embeds 60 chunks, and on `--no-embed` or deferred
paths the whole page drops out of vector search until the backfill runs. The code comment
explains the privacy reason (a vector may have embedded a private sibling fragment). The
reuse could be restricted to chunks whose `chunk_text`, wrapper prefix, model signature and
full-body seal are all unchanged. **Fix:** reuse vectors by `(md5(chunk_text), prefix,
signature)` when the page was sealed with no protected fragments before and after.

### A14. [P2 · VERIFIED (code)] Removing a frontmatter tag never removes it from the DB

`src/core/import-file.ts:931-952` makes tag sync add-only. This is a documented trade-off, but
tags drift from the source over time. **Fix:** add a `tags.tag_source` provenance column
(`frontmatter` vs `enrichment`) and delete frontmatter-sourced tags that are no longer present.

### A15. [P2 · VERIFIED (code)] Post-sync extraction swallows errors whole

`src/commands/sync.ts:3927`: `} catch { /* extraction is best-effort */ }` wraps link **and**
timeline extraction, including `throw new Error('Cannot extract links: active schema pack is
unavailable.')` (`extract.ts:1631`). Pages stay unstamped, so `extract --stale` can recover,
but nothing is logged and `sync --json` never reports the failure. **Fix:** log to stderr,
add an `extract_error` field to the sync result, and record it in the failure ledger.

### A16. [P2 · VERIFIED (code)] Every small sync loads link metadata for the whole brain

`fileLinkOwnership` (`src/core/link-reconciliation.ts:166-178`) calls
`loadLinkPageMetadata(engine)` (all pages, all sources) plus a DISTINCT join over `links`,
once per `extractLinksForSlugs` call, which means **every** incremental sync of one file. On a
100K-page brain that is a full table scan per sync. **Fix:** scope it to the requested slugs
and the current source.

### A17. [P2] Smaller write-path hygiene items (code-verified)
- `import-file.ts:716` warns "shares content_hash ... but has different frontmatter.id" even
  when neither page has an id. Identical daily-note templates spam this warning.
- `import-file.ts:843`: `token_count = ceil(chars/4)` undercounts CJK by about 2–4×, which
  skews cost reporting. `estimateEmbedTokens` already exists.
- `pglite-engine.ts` upsert stamps `model = resolvedModel` on chunks that have **no** vector,
  so `model` then describes a vector that does not exist.
- Soft-deleted pages whose file still exists (`delete_page` with `write_through` off) come
  back on the next full sync, or on the next edit, but incremental syncs leave them deleted.
  Whether a delete sticks depends on sync mode.
- `findTimelineSplitIndex` (`markdown.ts:592`) treats a `<!-- timeline -->` line inside a
  fenced code block as the sentinel (suspected; not run).

---

## B. Facts, takes, contradictions, entities, forget (sub-auditor 1)

### Report: Write-path audit: facts, takes, contradictions, entity resolution/merge, forget/withdrawal

Scope: gbrain v0.59.3.0 (master `6bb88d128`). Line numbers cite `gbrain` (identical to the scratch clone).
All probes are real PGLite, no LLM/embedding calls. Probe sources: `audit/scratch-writepath/facts-entities/probe{1..6}.test.ts|ts`,
run from the clone with `GBRAIN_HOME=$(mktemp -d) bun test --timeout 60000 <probe>`.

Context that matters for reading the findings: there are two fact-reconcile paths.
- **Legacy / unmanaged** (default for every brain until `persistence` is explicitly activated): `runExtractFacts` in `src/core/cycle/extract-facts.ts` wipes and reinserts a page's fact rows whenever it sees drift. `writeFactsToFence`, `forgetFactInFence`, `writeSingleFact`, and the backstop also run here.
- **Managed**: `prepareCanonicalProjections` (`src/core/persistence/canonical-projections.ts`) keeps IDs stable. It expires rows and detaches their `row_num`; it doesn't delete. The `remember` verb always goes through the journal (`memory-prepare.ts`).

### B-Summary table

| # | Sev | Title | Evidence |
|---|-----|-------|----------|
| 1 | P0 | Forgetting one entity's fact withdraws the same claim for every entity in the source, and blocks it from being remembered again | VERIFIED (probe1) |
| 2 | P0 | Every first-time withdrawal deletes all `content_chunks` in the source, invalidates every page, and queues a re-embed of the whole source. Gmail loop supersession triggers this automatically | VERIFIED (probe1) + code path |
| 3 | P0 | One bad fence row, or an FK reference, throws out of `runExtractFacts` and aborts reconciliation for all remaining pages (poison page) | VERIFIED (probe2, probe3) |
| 4 | P1 | Reconcile dedupe keys on (claim, source) after stripping strikethrough, so a claim that reverts to an earlier value is dropped. The entity is left with no active value | VERIFIED (probe1) |
| 5 | P1 | Legacy wipe-and-reinsert changes fact IDs on any attribute edit. IDs from `recall` stop working for `forget`; consolidation, `source_session`, and `created_at` are lost | VERIFIED (probe2) |
| 6 | P1 | TTL precision is lost: the fence stores `valid_until` as a UTC date, so a rebuild or reimport truncates it to midnight UTC. A `ttl: "1h"` fact is already expired after rebuild | VERIFIED (probe2) |
| 7 | P1 | Facts of deleted pages stay active in `recall` indefinitely | VERIFIED (probe4) |
| 8 | P1 | Fuzzy entity resolution attributes facts to the wrong entity or to non-entity pages (meeting pages, near-name people) | VERIFIED (probe6) |
| 9 | P1 | Withdrawal is exact-fingerprint only. Punctuation or a paraphrase re-extracted from the unchanged prose brings the "forgotten" fact back | VERIFIED (probe3) |
| 10 | P1 | Fence writers append an exactly-withdrawn claim as an ACTIVE row in the Markdown file, which is the system of record. The file then contradicts the DB | VERIFIED (probe3) |
| 11 | P1 | `writeSingleFact` supersession goes through `forgetFactInFence`, so an ordinary supersession becomes a permanent withdrawal (contradicts the documented contract). Loops-extract swallows the resulting refusals | VERIFIED (code) |
| 12 | P1 | Phantom-redirect entity merge is lossy: `rewriteLinks` is a no-op stub on both engines; the canonical path skips the shared resolver; expired history is hard-deleted | VERIFIED (code) |
| 13 | P1 | Supersession chains resolve `superseded_by` to NULL for every link except the last, so history loses its links | VERIFIED (probe1) |
| 14 | P1 | Takes bootstrap from pages has no dedupe (`--include-covered` duplicates takes), no cost cap, and silently swallows chat errors | VERIFIED (code) |
| 15 | P2 | Fence numeric parsing accepts garbage: `2.5M`→2.5, `1,5`→15, `0.9abc`→0.9, confidence `7` passes the parser | VERIFIED (probe2) |
| 16 | P2 | The LLM extractor defaults a missing or non-numeric confidence to 1.0 (maximum certainty) and maps unknown kinds to `fact` | VERIFIED (probe5) |
| 17 | P2 | Contradiction `temporal_supersede` picks an arbitrary direction on same-day dates; string compare breaks on timezone-bearing dates | VERIFIED same-day (probe5); tz SUSPECTED |
| 18 | P2 | `extract-takes.ts` has dead-but-exported paths with source-isolation bugs (unscoped slug→page_id, hard-coded `'default'`) and never deletes stale takes | VERIFIED (code) |
| 19 | P2 | `linkEntityIdentity` is non-atomic and re-linking without `canonical` silently demotes the canonical member | VERIFIED (code) |
| 20 | P2 | `valid_from` defaults to the UTC date (`toISOString().slice(0,10)`), which is off by one day for users west of UTC in the evening | VERIFIED (code) |
| 21 | P2 | Silent catch-alls on the write path hide real failures | VERIFIED (code) |

---

### B-1. P0: Withdrawal is keyed without the entity, so forgetting alice's claim erases bob's

**Files:** `src/core/facts/withdrawal.ts:32-36`, `src/core/facts/withdrawal-schema.ts:3-9, 14-33`

```ts
const inserted = await tx.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,fact_hash)
  VALUES ($1,$2,gbrain_fact_fingerprint($3)) ON CONFLICT DO NOTHING RETURNING fact_hash`, [sourceId,row.visibility,row.fact]);
await tx.executeRaw(`UPDATE facts SET expired_at=now(),valid_until=LEAST(COALESCE(valid_until,now()),now())
  WHERE source_id=$1 AND visibility=$2 AND gbrain_fact_fingerprint(fact)=gbrain_fact_fingerprint($3)
    AND expired_at IS NULL`, [sourceId,row.visibility,row.fact]);
```
```sql
PRIMARY KEY (source_id, visibility, fact_hash)   -- no entity / page
```

**Why it's wrong:** Entity-scoped facts are usually short, generic sentences: "Prefers email", "Is a founder", "Lives in NYC", "Works remotely". `forget(id)` on one person's fact does two things:
- It expires every active fact in the source with the same normalized text, across all entities.
- The `facts_preserve_withdrawal` trigger and `assertFactNotWithdrawn` then refuse that claim for any entity forever. A later `remember("Prefers email", entity: charlie)` fails with `fact_withdrawn`.

The key-files doc presents entity exclusion as deliberate, so that renames can't restore a claim. But entity exclusion fixes the rename case by causing cross-entity data loss, and the user never asked for that. This is silent data loss.

**Evidence (probe1):**
```
facts after forget [{"entity_slug":"companies/acme-example","fact":"Founded 2017","expired":false},
  {"entity_slug":"people/alice-example","fact":"Prefers email","expired":true},
  {"entity_slug":"people/bob-example","fact":"Prefers email","expired":true}]     <- bob never forgotten
charlie remember blocked? true
```

**Fix:** Key the withdrawal on `(source_id, visibility, subject_key, fact_hash)`, where `subject_key` is a stable entity identity. Use `entity_identities.entity_id` when present, otherwise the `(source_id, entity_slug)` of the withdrawn row, with NULL for subjectless facts. Rename-safety then comes from rewriting `subject_key` inside the rename/merge ops, not from dropping the subject. Migrate existing rows by joining `fact_withdrawals` back to the expired `forgotten:` rows to recover the subject. Add a regression test: two entities with the same claim, forget one, and assert the other stays active and can still be remembered.

### B-2. P0: Every withdrawal wipes the whole source's search index and re-embeds everything

**File:** `src/core/facts/withdrawal.ts:22-27, 38-43`

```ts
// Derived provenance can be incomplete or already rebuilt. Conservatively
// invalidate this source's pages rather than miss an unindexed duplicate.
const pageKeys = await tx.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 ORDER BY slug', [sourceId]);
await tx.lockPageKeys(pageKeys.map(page => ({ sourceId, slug: page.slug })));
...
const pages = await tx.executeRaw(`UPDATE pages SET knowledge_revision=gen_random_uuid(),text_projection_revision=NULL,embedding_signature=NULL
  WHERE source_id=$1 RETURNING id,slug,knowledge_revision`, [sourceId]);
await tx.executeRaw('DELETE FROM content_chunks WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1)', [sourceId]);
```

**Why it's wrong:** One `forget` has four effects:
- It page-locks every page in the source.
- It deletes every chunk in the source. Keyword and vector search return nothing for the source until the projection queue drains.
- It bumps `knowledge_revision` on every page. The `pages_projection_queue` trigger (`page-state/projection-schema.ts:16-36`) then enqueues a rebuild of every page.
- It nulls `embedding_signature`, so the rebuild re-embeds the whole source (paid provider spend). No budget gate covers this.

It also isn't only user-initiated. `writeSingleFact` supersession → `expireSuperseded` → `forgetFactInFence` → `recordFactWithdrawal` (`write-single.ts:252-256`), and `google/loops-extract.ts:409` calls `writeSingleFact` for every extracted email commitment. So a Gmail thread where a due date changes triggers a source-wide wipe and re-embed. On a 10k-page source that repeats with every email sync. The guard comment says "conservatively", but the cost is O(source) per forget and there is no cap.

**Evidence (probe1):** chunk counts before and after forgetting ONE fact on alice's page:
```
chunks before forget  acme-example:1 alice-example:1 bob-example:1
chunks after forget   acme-example:0 alice-example:0 bob-example:0   <- unrelated company page lost its chunks
```

**Fix:**
- Invalidate only the pages that actually contain the claim. Find them with `SELECT DISTINCT source_markdown_slug FROM facts WHERE source_id=$1 AND fingerprint=...`, plus a `content_chunks.chunk_text ILIKE` or tsvector probe on the normalized claim for prose copies.
- Re-chunk those pages only, and keep their text projections searchable until the replacement lands (swap chunks rather than delete them).
- Keep the conservative full-source sweep as an explicit admin op, and never trigger it from supersession. Separately, stop routing supersession through withdrawal (#11).
- Add a test that asserts chunks on unrelated pages survive a forget.

### B-3. P0: One bad page aborts `extract_facts` for every page after it (poison page)

**File:** `src/core/cycle/extract-facts.ts:806-822` (`insert()` rethrows), `:833-834` (`throw error` is not caught per page); FK definition at `src/core/migrate.ts:2413`

```ts
} catch (error) {
  if (!isAborted(opts.signal)) throw error;   // propagates out of runExtractFacts
```
```sql
superseded_by BIGINT REFERENCES facts(id),   -- NO ACTION on delete
```

**Why it's wrong:** The per-page loop has no try/catch. Any insert failure throws out of the whole phase: a CHECK violation (fence confidence `7` passes the parser, see #15), or an FK violation when the legacy wipe deletes a row that another row's `superseded_by` still references. Every page after the failing one in iteration order never reconciles, and the same failure happens on every cycle.

The FK case happens in normal operation. `memory-prepare.ts:89` and `write-single.ts:260` set `superseded_by` on a DB-only legacy row (`source_markdown_slug IS NULL`), pointing it at a new fence row. The next drift on that page makes `insertFacts(deleteForPageFirst)` delete the target, and the delete fails.

**Evidence:**
```
probe2: phase error: update or delete on table "facts" violates foreign key constraint "facts_superseded_by_fkey"
        bob facts indexed after phase: [{"n":0}]
probe3: phase error: new row for relation "facts" violates check constraint "facts_confidence_check"
        zzz facts indexed: [{"n":0}]
```

**Fix:**
1. Wrap each page's reconcile in try/catch. Push `${slug}: FACTS_RECONCILE_FAILED: <msg>` to `warnings`, count it in the rollup's `halt_delta`, and continue with the next page.
2. Validate confidence in `[0,1]` in `parseFactsFence` and emit `FACTS_TABLE_MALFORMED`, so the page is treated as non-authoritative and preserved.
3. Give the FK `ON DELETE SET NULL`, or better, stop deleting rows at all (#5).
4. Add a test with a poison page first, then assert the healthy page after it still reconciles.

### B-4. P1: A claim that reverts to an earlier value disappears from the active index

**File:** `src/core/cycle/extract-facts.ts:101-116`, used at `:604-606`

```ts
function factContentKey(fact: string, source: string | null | undefined): string {
  return `${fact}\u0000${source ?? FENCE_SOURCE_DEFAULT}`;
}
function dedupeFactsByContentKey(facts) { ... if (seen.has(key)) continue; ... }  // keeps FIRST
```

**Why it's wrong:** `parseFactsFence` strips `~~` from the claim, so a struck historical row and a later active row with the same text and source get the same key. The dedupe keeps the first row, which is the old struck one, and discards the current active row. Real histories revert all the time: NYC → SF → NYC, or a job leave and rejoin. After reconcile the entity has no active value, even though the fence (the system of record) shows one.

**Evidence (probe1):** fence rows `1 ~~Lives in NYC~~ (superseded by #2)`, `2 ~~Lives in SF~~ (superseded by #3)`, `3 Lives in NYC`:
```
carol facts [{"row_num":1,"fact":"Lives in NYC","expired":true},{"row_num":2,"fact":"Lives in SF","expired":true}]
warnings: ... "superseded by #3" names a row absent from the fence
```
Row 3 (current truth) is missing from the DB.

**Fix:** The reconcile identity should be `row_num`, which the fence guarantees unique (`FACTS_ROW_NUM_COLLISION`). Key existing-versus-desired on `(row_num, claim, source, visibility)`, the same way `canonical-projections.ts:33-37` does, and remove `dedupeFactsByContentKey`. If duplicate active rows need collapsing, collapse only among active rows.

### B-5. P1: The legacy reconcile changes fact IDs and drops derived state on any edit

**File:** `src/core/cycle/extract-facts.ts:776-781`; `src/core/pglite-engine/facts.ts:153-173` (and the Postgres twin)

```ts
if (hasStaleExisting || hasDuplicateExisting || hasRowNumDrift || hasSupersessionDrift || hasAttributeDrift) {
  deleteForPageFirst = { slug, excludeSourcePrefixes: ['cli:'], preserveExpiredLegacy: true };
  toInsert = extracted;      // every row of the page re-inserted with new ids
}
```

**Why it's wrong:** Editing one row's notability, visibility, or text, or removing any row, deletes and reinserts every fence row on the page. The consequences:
- (a) Every fact ID changes. IDs handed out by `remember`/`recall`, which the protocol tells agents to pass to `forget`, stop resolving: `forget` returns `not_found`, so the user's retraction fails.
- (b) `consolidated_at` and `consolidated_into` reset, so the consolidate phase re-promotes the page's facts. `consolidate.ts:181-212` mitigates this with a `(page_id, claim)` lookup, but a different cluster representative still mints a duplicate take.
- (c) `source_session`, `created_at`, and `embedded_at` are lost, and embeddings are regenerated (paid) whenever a provider is present.
- (d) The FK hazard in #3.

The managed path already solves this: expire and detach, never delete.

**Evidence (probe2):**
```
ids before [{"id":1,"row_num":1},{"id":2,"row_num":2}] after [{"id":3,"row_num":1},{"id":4,"row_num":2}]
forget with id from recall before edit: {"ok":false,"path":"not_found"}
```
Only row 2's notability changed.

**Fix:** Port the managed algorithm to `runExtractFacts`:
- `UPDATE` attributes in place, matching on `(source_id, source_markdown_slug, row_num)` with the same claim.
- Expire and detach rows whose `(row_num, claim, visibility)` is no longer in the fence.
- Insert only new row numbers.

Also carry `embedding` forward when the claim text is unchanged. Test that an attribute-only edit keeps IDs and `consolidated_at` stable.

### B-6. P1: TTL and `valid_until` are truncated to a UTC date in the fence, so rebuilt facts expire early or immediately

**Files:** `src/core/persistence/memory-prepare.ts:61-63`, `src/core/facts/fence-write.ts:430, 442`, `src/core/persistence/facts-prepare.ts:98`; parse side at `src/core/facts/extract-from-fence.ts:74-80`; applied by `canonical-projections.ts:41-46`

```ts
validUntil: validUntil?.toISOString().slice(0, 10)   // '12h' ttl → '2026-09-28'
```

**Why it's wrong:** `remember(ttl: "12h")` stores the exact instant in the first DB row but writes only the date to the fence. Every later rebuild of that row reads `new Date('YYYY-MM-DD')`, which is UTC midnight. The rebuilds are: legacy wipe-and-reinsert (#5), the managed `canonical-projections` `UPDATE … valid_until=$8` on the next import or sync of the page, `rebuild`, and Markdown clones. A ttl that lands on the same UTC day becomes already expired. Longer ttls shift by up to 24h, and nothing reports the change.

**Evidence (probe2):**
```
intended valid_until 2026-09-28T22:02:52Z → reconciled valid_until 2026-09-28T00:00:00Z  already expired at rebuild? true
```

**Fix:** Write full ISO-8601 timestamps into the `valid_until` cell whenever the value isn't midnight UTC (the parser already accepts full ISO). Keep date-only output for midnight values so existing fences don't churn. Test a round trip `remember(ttl:'1h')` → reimport → still active.

### B-7. P1: Facts of a deleted page stay active and recallable

**Files:** `src/core/cycle/extract-facts.ts:549-554`; no fact handling in soft-delete or purge paths (`grep "DELETE FROM facts"` finds no delete-path call)

```ts
const page = await engine.getPage(slug, { sourceId });
if (!page) { continue; }   // deleted page: its facts are never touched
```

**Why it's wrong:** Deleting a page removes the system-of-record fence, but the derived rows stay active. `facts` has no FK to `pages`, and `listFactsByEntity`/`recall`/`context_pack` don't join `pages.deleted_at`. The reconcile loop skips missing pages, so those facts keep appearing in recall indefinitely, after purge too. This is stale derived data.

**Evidence (probe4):** `active facts for deleted page: 1 [ "CTO at acme-example" ]` after `softDeletePage` plus a full-walk `runExtractFacts`.

**Fix:** In `runExtractFacts`, when `getPage` returns null but `getPage(slug,{sourceId,includeDeleted:true})` returns a tombstone, expire (don't delete) that page's fence-owned rows. Better, do the same in the engines' `softDeletePage` inside the same transaction, un-expiring on restore only if a withdrawal doesn't forbid it. Alternatively, add `NOT EXISTS (deleted page)` to active fact reads.

### B-8. P1: Fuzzy entity resolution attaches facts to the wrong entity or to non-entity pages

**File:** `src/core/entities/resolve.ts:449-470` (`tryFuzzyMatch`), `:392-403` (`tryPrefixExpansion` returns `rows[0]` when ambiguous)

```ts
FROM pages WHERE source_id = $1 AND deleted_at IS NULL
  AND ( lower(title) % $2 OR slug ILIKE '%' || $3 || '%' )
...
if (rows.length > 0 && rows[0].score >= 0.7) return rows[0].slug;   // no type filter, no ambiguity/margin check
```

**Why it's wrong:** Multi-token names go to trigram fuzzy matching over every page type, with no margin check against the second-best candidate. The result is tagged `fuzzy_match`, which passes the stub guard, so `writeFactsToFence` appends the facts to that page's fence.
- Facts about "Bob Jones Example", who has no page, land on a meeting page.
- "Alicia Smith Example" (a different person) resolves to Alice.

**Evidence (probe6):**
```
"Alicia Smith Example"   → people/alice-smith-example (fuzzy_match)
"Bob Jones Example"      → meetings/2026-03-01-bob-jones-example-sync (fuzzy_match)
```

**Fix:**
- Restrict fuzzy candidates to entity page types (the pack's entity prefixes: people/companies/projects/…).
- Require a margin over the runner-up (for example top − second ≥ 0.1) and a stricter threshold for person names (token-level equality of first and last name).
- Otherwise return `fallback_slugify`, so the stub guard routes the fact DB-only.
- `tryPrefixExpansion` must return null on multiple candidates. The phantom pass has its own ambiguity check, but `resolvePhantomCanonical` still prefers the unchecked fuzzy path, see #12.
- Add a labelled resolution fixture (see improvements).

### B-9. P1: Withdrawal only matches exact text, so paraphrase or punctuation brings forgotten facts back

**File:** `src/core/facts/withdrawal-schema.ts:10-13`

```sql
SELECT encode(sha256(convert_to(regexp_replace(lower(btrim(claim)), '[[:space:]]+', ' ', 'g'), 'UTF8')), 'hex')
```

**Why it's wrong:** Forget is documented as retraction, not deletion of the original prose. So the prose that produced the fact is still on the page, and the next backstop or LLM extraction of that page will very likely re-emit the claim with different punctuation or wording. `findCandidateDuplicates` excludes expired rows (`pglite-engine/facts.ts:451-456`), so the re-emitted claim isn't treated as a duplicate either. It's inserted active, and the user's "forget" silently undoes itself. Visibility is part of the key too, so the same text remembered as `private` after forgetting it as `world` is also allowed.

**Evidence (probe3):** `withdrawn exact? true  with period? false  as private? false`

**Fix:**
- Normalize punctuation and trailing periods in the fingerprint. That needs a migration that recomputes stored hashes.
- Add a semantic check in the fence and pipeline writers: if the candidate's embedding has cosine ≥ 0.9 with a withdrawn fact's embedding for the same subject, refuse or flag it. That means storing the embedding, or the fact id, on `fact_withdrawals`.
- Offer an optional "strike the source sentence" mode in forget.

### B-10. P1: Fence writers write withdrawn claims into the Markdown file as active rows

**Files:** `src/core/facts/fence-write.ts:419-448` (no withdrawal check); `src/core/facts/backstop.ts:785-830`

**Why it's wrong:** `writeSingleFact` and `memory-prepare` check `isFactWithdrawn`. The backstop pipeline (`runPipelineWithBody` → `writeFactsToFence`) doesn't. The DB trigger forces the new row to `expired_at`, but the Markdown system of record now shows the withdrawn claim as a normal active row, next to its own struck row. Git history, Obsidian, Markdown clones, and any fresh brain built from the files (withdrawals don't travel with Markdown) all see the claim as live.

**Evidence (probe3):**
```
file rows:
| 1 | ~~Used to live in Tokyo~~ | ... | forgotten: user asked |
| 2 | Used to live in Tokyo     | ... | 2026-09-28 |  | llm |  |      <- active in the file
db rows [{"row_num":1,"expired":true},{"row_num":2,"expired":true}]
```

**Fix:** In `writeFactsToFence`, under the page lock, drop (or write pre-struck with `forgotten: withdrawn`) any input fact whose fingerprint is withdrawn for `(source, visibility)`, and report `withdrawn_skipped`. Run the same check in the backstop's phase 1 so no embedding spend happens for them.

### B-11. P1: Ordinary supersession in `writeSingleFact` becomes a permanent withdrawal, and failures are swallowed

**File:** `src/core/facts/write-single.ts:251-262`; caller `src/core/google/loops-extract.ts:407-424`

```ts
async function expireSuperseded(engine, oldId, newId) {
  try { const { forgetFactInFence } = await import('./forget.ts');
        await forgetFactInFence(engine, oldId, { reason: `superseded by fact #${newId}` }); } catch { /* best-effort */ }
  try { await engine.executeRaw(`UPDATE facts SET superseded_by = $1 WHERE id = $2`, [newId, oldId]); } catch { }
}
```
```ts
// loops-extract.ts
} catch { /* the loop row still lands; facts projection is best-effort */ }
```

**Why it's wrong:** The key-files contract says "Ordinary TTL/supersession expiry creates no withdrawal". This path creates one:
- The old claim can never be written again (a commitment that moves back to its original due date is refused as `fact_withdrawn`).
- Each supersession also triggers the source-wide wipe in #2.
- The fence row gets context `forgotten: superseded by fact #N`, which the parser reads as *forgotten*. The regex `superseded by #(\d+)` doesn't match "by fact #N", so `superseded_by_row` is lost on rebuild.
- Loops-extract swallows every error, including the `fact_withdrawn` refusal, so the facts projection silently loses commitments and nobody is told.

**Fix:** Supersede with the same fence edit `memory-prepare.ts:65-69` uses: strike the old row with `superseded by #<newRow>`, set `expired_at` and `superseded_by` in one transaction, and don't call withdrawal. In loops-extract, log and count failures (`facts_projection_failed`) instead of `catch {}`.

### B-12. P1: Phantom-redirect entity merge is lossy and bypasses the shared file resolver

**File:** `src/core/cycle/phantom-redirect.ts:374-394, 413, 452-463`; `pglite-engine.ts:5764-5766`, `postgres-engine.ts:5013-5018`

```ts
const canonical = await resolvePhantomCanonical(engine, sourceId, page.slug);   // fuzzy first (unchecked)
const candidates = await findPrefixCandidates(engine, sourceId, page.slug);     // ambiguity only in 4 dirs
...
const canonicalPath = path.join(brainDir, `${canonical}.md`);                   // not resolvePageWriteTarget
...
await engine.rewriteLinks(page.slug, canonical);   // comment: "DB FK rewrite for the links table"
await engine.softDeletePage(page.slug, { sourceId });
await engine.deleteFactsForPage(page.slug, sourceId);   // hard-deletes expired/superseded history
```
```ts
async rewriteLinks(_oldSlug: string, _newSlug: string): Promise<void> {
  // Stub: links use integer page_id FKs, already correct after updateSlug.
}
```

**Why it's wrong:**
- (a) `rewriteLinks` is a no-op. Links to and from the phantom stay on its `page_id`, which is then soft-deleted, so the canonical entity silently loses those backlinks. The stub's comment assumes a slug rename, but this is a merge between two different `page_id`s.
- (b) The canonical file path ignores `resolvePageWriteTarget`: recorded `source_path`, own-`local_path` roots, and `.sources/<id>` nesting. The fence can land in a slug-named twin file that the next sync imports as a second page, or that delete-reconcile never sees. That is exactly the #4204 bug class, fixed in `fence-write.ts`/`forget.ts` but not here.
- (c) `migrateFactsToCanonical` moves only active rows. The phantom's expired and superseded rows are then hard-deleted, so the audit trail is lost (withdrawals survive in `fact_withdrawals`).
- (d) The ambiguity check only looks at the four prefix dirs, while `canonical` may come from the unrestricted fuzzy match (#8), so a single prefix candidate doesn't prove that `canonical` is right.
- (e) The DB `row_num` offset (`MAX(db)+phantom row_num`) and the disk append numbering (`max fence rowNum + 1`, dedup-skipping) can diverge. That forces a wipe-and-reinsert on the next cycle (#5).

**Fix:**
- Implement a real merge: `UPDATE links SET to_page_id=$canonical WHERE to_page_id=$phantom` (and `from_page_id`), deduping on the unique key.
- Resolve the canonical path through `resolvePageWriteTarget`.
- Move expired rows too, keeping `expired_at` and `superseded_by`, and renumber DB rows to exactly the row numbers written to disk.
- Require `canonical ∈ candidates` or a unique fuzzy match with a margin.
- Add aliases: `slug_aliases(phantom → canonical)`, so future references resolve by `alias_exact`.

### B-13. P1: Supersession chains lose their links

**File:** `src/core/facts/supersede-resolve.ts:83-90`; `pglite-engine/facts.ts:258-282`

```ts
if (target.struck) { return { superseded_by: null, warning: `... names a row that is itself struck ...` }; }
```

**Why it's wrong:** A value that changes twice (A→B→C) is the normal history. The fence reads `A superseded by #B`, `B superseded by #C`. Since B is struck, A's `superseded_by` resolves to NULL on every reconcile. `listSupersessions` and the trajectory logic get broken chains, and each cycle emits a warning (probe1: `row 1: "superseded by #2" names a row that is itself struck`).

**Fix:** Allow a struck target when the target is itself superseded (a chain). Keep rejecting only forgotten or unrecognized-inactive targets and cycles. Detect cycles by walking the page-local map.

### B-14. P1: Takes bootstrap from pages has no dedupe, no cost cap, and silent LLM failures

**File:** `src/core/extract-takes-from-pages.ts:167-169, 210-213, 241-252`; `takes-write.ts:519-568` (append-only)

```ts
const coveredFilter = opts.includeCovered ? '' : `AND NOT EXISTS (SELECT 1 FROM takes t WHERE t.page_id = pages.id)`;
...
} catch { continue; }            // chat() failure not counted anywhere
...
await appendTakesToPageMdFirst(... safeClaims ...)   // no dedupe vs existing fence rows
```

**Why it's wrong:**
- Running with `includeCovered` (or re-running after adding one take by hand) appends the same claims again. Takes are gradeable and feed calibration, so duplicates skew calibration scores.
- There's no USD budget meter, unlike `propose_takes`/`grade_takes`, which use `budgetUsdKey`. The only bound is `maxPages` (50) × 2000 tokens.
- A provider outage (auth or billing) returns `claims_extracted: 0` with no skip reason, which looks the same as "nothing to extract".

**Fix:** Dedupe against the existing active claims in the fence (normalized text, reusing `propose-takes.ts`'s F2 fence dedupe). Wrap the loop in a `BudgetTracker` with a config key. Push `skipPage(slug, 'llm_error:<code>')` on chat failure.

### B-15. P2: Fence numeric and confidence parsing accepts garbage

**File:** `src/core/facts-fence.ts:127-147`

```ts
const n = parseFloat(trimmed);                 // '0.9abc' → 0.9 ; confidence '7' accepted
const stripped = trimmed.replace(/,/g, '');    // '1,5' (EU decimal) → 15
const n = parseFloat(stripped);                // '2.5M' → 2.5 ; '$10M' → NaN → undefined
```

**Why it's wrong:** `claim_value` feeds `find_trajectory`, the founder scorecard, and regression flags. With `2.5M`→2.5, an ARR of 2.5M followed by 900k (stored as 900000) reads as growth, when it is actually a decline. Confidence 7 passes the parser, then fails the DB CHECK, which aborts the phase (#3).

**Evidence (probe2):** `[{"v":2.5,"c":0.9},{"v":15,"c":7}]` with `warnings []`.

**Fix:** Use strict regexes (`/^-?\d+(\.\d+)?(e[+-]?\d+)?$/` after stripping thousands separators only in `\d{1,3}(,\d{3})+` form). Support k/M/B suffixes explicitly, or warn on them. Emit `FACTS_TABLE_MALFORMED` for confidence outside `[0,1]`.

### B-16. P2: The LLM extractor turns missing or garbage confidence into maximum certainty

**File:** `src/core/facts/extract.ts:814, 628-632, 840-845`

```ts
confidence: typeof o.confidence === 'number' ? o.confidence : 1.0,
...
function clampConfidence(x) { if (typeof x !== 'number' || !Number.isFinite(x)) return 1.0; ...
const kind = ALL_EXTRACT_KINDS.includes(candidate.kind) ? candidate.kind : 'fact';
```

**Evidence (probe5):** `{"kind":"speculation","confidence":"0.3"}` → `confidence: 1`, stored with kind `fact`.

**Fix:** Default an absent confidence to 0.5 or drop the candidate. Parse numeric strings. Count unknown kinds in `invalidCandidates` and map them to `belief`, which is the least assertive kind, instead of `fact`.

### B-17. P2: Contradiction auto-supersession on same-day or timezone-shifted dates

**File:** `src/core/eval-contradictions/auto-supersession.ts:168-176`

```ts
const olderSide = aDate < bDate ? pair.a : pair.b;   // equal → b is "older"
```

**Evidence (probe5):** equal dates → `gbrain takes supersede ... --row 12 --claim 't' --since 2026-03-01`. The direction is arbitrary, and the generated command overwrites one of two same-day takes. A timezone-bearing string (`2026-03-01T23:00-08:00` vs `2026-03-02`) orders the wrong way under string compare (tz case SUSPECTED; it depends on whether `effective_date` ever carries an offset).

**Fix:** Parse both dates to epoch values. When they're equal, or when either fails to parse, emit `flag_for_review` or the "date order unclear" comment.

### B-18. P2: `extract-takes.ts` has dead paths with isolation bugs and no stale-row cleanup

**File:** `src/core/cycle/extract-takes.ts:72-77, 153, 197-199, 219`

```ts
`SELECT id FROM pages WHERE slug = $1 LIMIT 1`            // any source, includes deleted pages
opts.slugs.map(slug => ({ slug, source_id: 'default' }))   // non-default sources misrouted
if (takes.length === 0) continue;                          // even with --rebuild, removed fences keep DB takes
```
The only caller is the `v0_28_0` migration (full `db` walk), so the fs and slug paths are exported but unused. Upsert without `--rebuild` never deletes rows removed from a fence.

**Fix:** Delete the fs/slug paths, or scope them (`AND source_id=$2 AND deleted_at IS NULL`, and `listAllPageRefs` filtered by slug). Apply `DELETE … WHERE NOT (row_num = ANY(...))` the way `canonical-projections.ts:48` does.

### B-19. P2: `linkEntityIdentity` is non-atomic and silently demotes the canonical member

**File:** `src/core/entity-identity.ts:105-121`

```ts
if (canonical) await engine.executeRaw(`UPDATE entity_identities SET canonical = false WHERE entity_id = $1 AND canonical`, ...);
await engine.executeRaw(`INSERT ... ON CONFLICT (source_id, page_id) DO UPDATE SET ... canonical = EXCLUDED.canonical`, ...);
```
The demote and insert run in separate statements with no transaction, so a failed insert leaves the group with no canonical member. Re-linking the current canonical page just to update `confidence` (with `canonical` omitted, so false) silently demotes it.

**Fix:** Wrap both statements in `engine.transaction`. On conflict, use `canonical = entity_identities.canonical OR EXCLUDED.canonical` unless an explicit `canonical: false` was passed.

### B-20. P2: `valid_from` defaults to the UTC date

**File:** `src/core/facts/fence-write.ts:430`, `memory-prepare.ts:62`, `facts-prepare.ts:98`

```ts
const validFromStr = (f.validFrom ?? new Date()).toISOString().slice(0, 10);
```
For a user at UTC−8 writing at 17:00 or later, facts are stamped with tomorrow's date. That affects trajectory ordering against page `effective_date`, which is local. Same fix as #6: store the full timestamp, or use the brain's configured timezone for date-only cells.

### B-21. P2: Silent catch-alls on the write path

These catch blocks hide real failures:
- `write-single.ts:256, 261`: supersede bookkeeping errors are swallowed.
- `fence-write.ts:414-419`: a DB `MAX(row_num)` lookup failure silently falls back to file-only numbering, which is exactly the duplicate-key class the comment warns about.
- `fence-write.ts:486`: the `refreshPageBody` mirror failure is swallowed, leaving the page cache stale (reconcile then refuses via `FACTS_PAGE_CACHE_STALE`, but nothing is counted).
- `resolve.ts:431/449`: exact-slug and fuzzy DB errors are swallowed, which degrades to `fallback_slugify` and misattributes facts.
- `loops-extract.ts:419`.

Each should at least increment a counter surfaced by doctor.

---

### B-Answers to the specific questions

- **Can a fact attach to the wrong entity?** Yes. Fuzzy resolution accepts meeting pages and near-name people (#8). Phantom merge picks through the unchecked fuzzy path (#12). Source scoping in the resolver itself is correct: every query filters on `source_id`.
- **Does re-extraction on edit duplicate facts or leave stale ones?** Stale rows from deleted text are expired (restrictions pass) and then wiped, so no stale rows remain. But IDs churn (#5), a reverted claim is dropped (#4), and a deleted page leaves every fact active (#7). The takes path never removes stale DB takes in its `extract-takes.ts` form (#18).
- **Same-day or timezone valid_from in supersede/contradiction logic?** The fence stores dates at UTC-day granularity. `valid_from` and `valid_until` are UTC-date truncated (#6, #20), and contradiction ordering is arbitrary on ties (#17). Fence supersession uses explicit `#N` references, not dates, so it isn't date-sensitive, but chains break (#13).
- **Does forget hide the fact from all read paths?** Active fact reads (`_listFacts` with `activeOnly`) exclude it, and chunks are rebuilt through the overlay. But: over-hiding across entities (#1); a source-wide search blackout per forget (#2); resurrection through paraphrase or punctuation re-extraction (#9); an active row in the Markdown file (#10); and a held ID that stops working after any edit (#5).
- **Are entity merges lossy?** Yes. Links are not moved, expired history is deleted, and the file path bypasses the resolver (#12). `entity_identities` link and unlink don't lose data, but have the canonical-flag race (#19).

### B-High-leverage improvements, each with the eval that proves it

1. **Stable fact identity in the legacy reconcile (fixes #3, #4, #5, #13).** Port the managed expire-and-detach and update-in-place algorithm to `runExtractFacts`.
   - *Eval:* fixture `facts-edit-stability`: 50 synthetic entity pages × a scripted sequence of 20 edits (attribute tweak, claim edit, row removal, claim revert, supersession chain, one poison row). Run `runExtractFacts` after each edit.
   - *Metrics:* (a) ID survival rate for unchanged rows (target 100%, today 0% on any drift); (b) active-set agreement with the fence, F1 over `(row_num, claim)` (target 1.0; the revert case is below 1.0 today); (c) pages reconciled when one poison page exists (target 49/49, today 0 after the poison); (d) re-embed calls per edit (target equal to changed claims).

2. **Subject-scoped, paraphrase-aware withdrawal with targeted invalidation (fixes #1, #2, #9, #10, #11).**
   - *Eval:* fixture `forget-precision`: 200 entities with deliberately shared generic claims, 40 forgets, then 3 LLM-free re-extraction variants per forgotten claim (punctuation, casing, a templated paraphrase), plus 10 supersessions.
   - *Metrics:* forget precision, i.e. collateral expirations on other entities (target 0, today every entity sharing the claim); resurrection rate after re-extraction (target 0, today 100% for punctuation variants); chunks deleted per forget divided by pages containing the claim (target ≈1, today the whole source); embedding calls per forget (target equal to affected pages); withdrawals created by supersession (target 0).

3. **Entity-typed, margin-gated resolver plus an alias-writing merge (fixes #8, #12).**
   - *Eval:* labelled fixture `entity-resolution-gold`: about 300 (mention → expected slug or NONE) cases generated from a synthetic brain with near-name people (alice-smith / alicia-smith), person-named meeting pages, company/product collisions, and bare first names. Score `resolveEntitySlugWithSource` and the phantom pass.
   - *Metrics:* wrong-attribution rate (a resolved slug that isn't the gold slug, counting only non-fallback results); NONE-recall (mentions without a page must return `fallback_slugify`); after merge, backlink count preserved on the canonical page (target 100%).

4. **Lossless fence value round-trip (fixes #6, #15, #16, #20).**
   - *Eval:* property test `fence-roundtrip`: random facts with TTLs from 1 minute to 400 days, timezones from UTC−12 to +14, typed values with k/M suffixes, and European decimals. Pass them through remember, render, parse, reimport, and rebuild.
   - *Metrics:* max `|valid_until_after − valid_until_before|` (target 0, today up to 24h, with same-day TTLs expiring); rows parsed with a silently wrong `claim_value` (target 0; ambiguous values must raise a parse warning); confidence defaulted to 1.0 from missing input (target 0).

5. **Page-lifecycle coherence for derived facts (fixes #7) and a doctor probe.**
   - *Eval:* fixture `page-lifecycle`: create → extract → soft-delete → purge → restore for 30 pages, calling `recall`/`context_pack` after each step.
   - *Metrics:* active facts attributed to deleted pages (target 0, today 100%); facts correctly restored on page restore, minus withdrawn ones (target 100%). Ship a `doctor` check, `facts_orphaned_by_deleted_pages`, with the same SQL so production brains get the same number.

---

## C. Dream cycle, minions, transcripts, connectors (sub-auditor 2)

#### C-Report: Audit: dream/synthesis cycle, minions, transcripts + chat connectors

Scope: `src/core/cycle*`, `src/core/minions/*`, `src/core/transcripts/*`, `src/core/connectors/*`, related commands.
Target: gbrain master `6bb88d128` (v0.59.3.0). Read-only; line numbers cite `gbrain`.

Repros ran in a scratch copy (`audit/scratch-writepath/cmt/repo`, identical source + `bun install`) against in-memory PGLite with an isolated `GBRAIN_HOME`. No paid API calls. The repro scripts are preserved in `audit/scratch-writepath/cmt/repros/` (`retitle.test.ts`, `connector.test.ts`, `concepts.test.ts`, `phantom.test.ts`). To rerun one, copy it into `test/zz-audit/` of a checkout with deps and run `bun test`.

### C-Summary table

| # | Sev | Title | Status |
|---|-----|-------|--------|
| 1 | P0 | A retitled conversation's new messages are silently dropped forever (transcripts ingest and connectors) | VERIFIED |
| 2 | P0 | `synthesize_concepts` overwrites human-written `concepts/<x>` pages | VERIFIED |
| 3 | P0 | Phantom redirect soft-deletes pages whose content is in the timeline; the timeline and frontmatter are never migrated | VERIFIED |
| 4 | P1 | `synthesize_concepts` makes duplicate concept pages from spelling variants, including a slug with a space | VERIFIED |
| 5 | P1 | `synthesize_concepts` replaces good LLM narratives with template stubs when the budget runs out or the LLM errors, then re-spends and rewrites every cycle | VERIFIED (code) |
| 6 | P1 | Quote-verify "near match" splices other speakers' turns and harness labels inside quote marks | VERIFIED |
| 7 | P1 | Quote-verify does not reject made-up content: it drops the quote marks and keeps the text, and never checks person pages | VERIFIED |
| 8 | P1 | The dream provenance stamp marks any page a child touched as `dream_generated`, including human person pages under `wiki/people/*` | SUSPECTED (strong) |
| 9 | P1 | Connector watermark is keyed per provider, not per (provider, source); a second source misses all history | VERIFIED |
| 10 | P1 | Connector `--limit` never progresses: every run re-fetches the same newest N | VERIFIED |
| 11 | P1 | One failing conversation freezes the connector watermark, so every run re-fetches the whole window | VERIFIED |
| 12 | P1 | Synthesis "already done" state lives in `minion_jobs`; `gbrain jobs prune` wipes it, causing a paid re-synthesis and duplicate reflections | VERIFIED (code) |
| 13 | P1 | Synthesize has no USD budget gate; the daily count cap is off by default and fails open | VERIFIED (code) |
| 14 | P1 | Atoms are keyed by LLM-chosen titles and undated sources use the run date; stale atoms are never removed | VERIFIED (code) |
| 15 | P2 | Mixed UTC and local "today" across cycle phases; the `#4348` fix covered only the synthesize summary | VERIFIED (code) |
| 16 | P2 | The dream `BudgetMeter` fails open for unpriced models; drift's input-token estimate is fixed at 1500; drift budget config is inconsistent | VERIFIED (code) |
| 17 | P2 | Claude connector: no list pagination, only the first org is used, timestamps are not normalized | SUSPECTED |
| 18 | P2 | ChatGPT offset pagination over `order=updated` can skip items that are reordered mid-list | SUSPECTED |
| 19 | P2 | A session with no timestamps permanently freezes `transcripts ingest --since last` | VERIFIED (code) |
| 20 | P2 | Missing tests for #1–#11 | VERIFIED |

---

### C-P0 findings

#### C-1. A retitled conversation's new messages are silently dropped forever (P0, VERIFIED)

**Files:** `src/core/transcripts/types.ts:164-177` (slug includes the title for non-harness formats), `src/core/import-file.ts:716-749` (identity dedup skips), `src/core/transcripts/ingest.ts:286-328`, `src/core/connectors/sync.ts:319-325`.

```ts
// types.ts:174 — chatgpt / claude-export / grok … slugs embed the TITLE
const title = slugifySegment(meta.title ?? '').slice(0, TITLE_SLUG_MAX).replace(/-$/, '');
return `${SLUG_DIRS[format]}/${day}-${label}-${id}`;

// import-file.ts:736-749
const sameExternalId = fmIdStr !== null && dupFmIdStr === fmIdStr;
if (sameExternalId) {
  ...
  return { slug: dup.slug, status: 'skipped', chunks: 0, parsedPage };
}
```

**Why it's wrong:** `frontmatter.id` is `<harness>-<sessionhash>-p<N>`, which stays stable across edits. When the user renames a ChatGPT or Claude conversation and keeps chatting, the new render gets a new slug. `findDuplicatePage` then matches the old page by `frontmatter.id`, and `importFromContent` returns `skipped` without comparing content. The ingest counts that as a clean skip, `cleanScan` stays true, and the connector advances the watermark past the lost content. The new messages never land, and every later edit is skipped the same way. Only `--force-rechunk` recovers it. The same path affects `renderSessionParts` parts 2..N, which use the new base slug.

Claude.ai names conversations after the first exchange, so a live sync that catches a conversation before it is named ("untitled") and again after hits this path routinely.

**Evidence:**
```
# transcripts ingest: export A (title "Original title"), then export B (renamed + 2 new turns)
[import] skipping conversations/chatgpt/2026-08-07-renamed-by-user-07c6e3565fd1: identical to
  conversations/chatgpt/2026-08-07-original-title-07c6e3565fd1 (frontmatter.id=chatgpt-07c6e3565fd1906c-p1)
run2 { imported: 0, skipped: 1 } clean2 true
[{ slug: ".../2026-08-07-original-title-07c6e3565fd1", has_new: false }]

# connector end-to-end (fixture server): rename + continue
r2: nothing_new { imported: 0, skipped: 1, cleanScan: true } wm 2026-08-06T07:15:00.000Z
[{ slug: ".../2026-08-06-original-name-9cde1fd99f62", has_new: false }]
```

**Fix:** When the identity match is at a different slug, skip only if `dup.content_hash === hash`. Otherwise, import the new content at the existing slug (`dup.slug`) as an update, so the slug stays stable and there are no duplicates. Better still, drop the title from transcript slugs (`day-<id>`, as harness formats already do) and keep the title only in frontmatter. Add a regression test: retitle + grow → the new text is present and there is one page.

#### C-2. `synthesize_concepts` overwrites human-written concept pages (P0, VERIFIED)

**File:** `src/core/cycle/synthesize-concepts.ts:358-380`

```ts
const title = group.conceptSlug.split('/').pop() ?? group.conceptSlug;
...
const conceptSlug = `concepts/${title}`;
await importFromContent(engine, conceptSlug, md, { noEmbed: ..., sourceId: opts.sourceId });
```

**Why it's wrong:** There is no existence or ownership check. If atoms reference a concept that already exists as a human page (for example `concepts/flywheel`), the page body is replaced by a 1-paragraph LLM narrative. For T3 groups, or when the budget runs out or the LLM errors, it is replaced by a template stub that lists atom slugs. This phase runs every cycle for packs that declare it (gbrain-creator, gbrain-everything).

**Evidence:**
```
# human page concepts/flywheel = "HUMAN-AUTHORED: my long hand-written essay…"; 2 atoms with concepts:['flywheel']
{ slug: "concepts/flywheel",
  body: "T3 concept. 2 atoms reference this. Top mentions:\n  - atoms/2026-08-01/a1-aaaaaa\n  - atoms",
  mode: "deterministic_tier" }
```

**Fix:** Before writing, `getPage(conceptSlug, {sourceId})`. If the page exists and lacks `synthesized_by: synthesize_concepts-*` (or `dream_generated`), don't overwrite it. Either write to a sibling section or fence (for example a `## Synthesized` fenced block or `concepts/<x>/synthesis`), or skip and record `skipped_human_owned`. Pass `expectedRevision` to close the race with concurrent human edits.

#### C-3. Phantom redirect deletes pages whose content lives in the timeline (P0, VERIFIED)

**File:** `src/core/cycle/phantom-redirect.ts:364-372` (residue gate), `:419-460` (migrate + soft-delete + unlink). This runs at the top of `extract_facts` on every cycle.

```ts
const residue = stripFenceAndFrontmatterAndLeadingH1(page.compiled_truth ?? '');
if (residue.length > 0) { ... return { outcome: 'not_phantom' }; }
...
const phantomFence = parseFactsFence(page.compiled_truth ?? '');
appendPhantomFenceRowsToCanonical(canonicalPath, phantomFence.facts);
...
await engine.softDeletePage(page.slug, { sourceId });
```

**Why it's wrong:** The "is this a stub?" gate checks only `compiled_truth`. `page.timeline` (and `timeline_entries`), custom frontmatter, and tags are ignored, and only fact-fence rows are migrated. A top-level page like `alice.md` whose body is `# alice` plus a `## Timeline` section is classified as a phantom. Its timeline is discarded, the page is soft-deleted, and the `.md` file is unlinked. The autopilot purge hard-deletes it after 72h, so the loss becomes permanent.

**Evidence:**
```
phantom compiled_truth= "# alice" timeline= "## Timeline\n\n- **2026-03-01** | … TIMELINE-MARKER …"
outcome { outcome: "redirected", canonical: "people/alice-example" }
canonical has marker: false   phantom row [{ slug: "alice", del: true }]   canonical timeline rows [{ n: 0 }]
```

**Fix:** Include `page.timeline` (trimmed), non-trivial frontmatter keys, and `timeline_entries` / tag counts in the residue gate. A non-empty timeline means "not a phantom", or else migrate the timeline entries and frontmatter into the canonical page before deleting. Add a test with a timeline-only phantom.

---

### C-P1 findings

#### C-4. Duplicate concept pages from spelling variants (P1, VERIFIED)

**File:** `synthesize-concepts.ts:179-190, 358, 375`. Groups are keyed on raw LLM strings in `frontmatter.concepts`. `"Network Effects"`, `"network-effects"`, and `"concepts/network-effects"` become three groups. Group 1 writes the slug `concepts/network effects`, which contains a **space**. The `concepts/`-prefixed variant splits off and drops below the count threshold.

```
{ slug: "concepts/network effects", ... }   { slug: "concepts/network-effects", ... }
```

**Fix:** Normalize before grouping with `slugifySegment(ref.replace(/^concepts\//,''))`, and resolve through the entity/alias resolver (`resolveEntitySlug`) so near-duplicates merge. Reject any slug that fails `validatePageSlug` grammar instead of writing it.

#### C-5. Concept narratives degrade over time, and the phase re-spends every cycle (P1, VERIFIED by code)

**File:** `synthesize-concepts.ts:283-285` (budget fallback), the error fallback, and `:368` (`synthesized_at: new Date().toISOString()`).

```ts
if (estimatedSpendUsd >= budgetCap) { narrative = deterministicNarrative(group); synthesisMode = 'budget_fallback'; }
```

**Why it's wrong:** The phase rewrites every T1–T4 concept page on every run. A concept that got an LLM narrative last night is overwritten with a template stub tonight when:
- the fixed $1.50 budget runs out first (which happens as groups grow), or
- a transient LLM error hits (`error_fallback`).

Because `synthesized_at` changes on every run, the content hash changes too. That forces a re-import, re-chunk, re-embed, and a new version row every cycle, and unchanged groups re-spend LLM budget nightly.

**Fix:**
- Skip a group whose member-atom set hash equals the stored `member_hash` frontmatter.
- Never downgrade a `synthesis_mode: llm` page to a fallback mode; keep the existing narrative and note the failure.
- Move `synthesized_at` out of the hashed content, or only write when the narrative changes.

#### C-6. Quote-verify "near match" puts other speakers' words inside quotes (P1, VERIFIED)

**File:** `src/core/cycle/synthesize-verify.ts:322-367`. The window gets `WINDOW_SLACK_BEFORE=20`, `WINDOW_SLACK_AFTER=40`, and ×1.2 growth, snapped to word boundaries. That whole window is then spliced in as the "verbatim" quote, and `repairBody` flattens newlines to spaces.

```ts
let winStart = Math.max(0, at - ... - WINDOW_SLACK_BEFORE);
let winEnd = Math.min(t.norm.length, winStart + Math.ceil(targetLen * WINDOW_GROWTH) + WINDOW_SLACK_AFTER);
...
const replacement = t.content.slice(oStart, oEndIdx + 1).trim();
```

**Evidence** (a one-word substitution in a mid-transcript quote):
```
"the team decided the mechanical checker beats an LLM judge" => near, replacement:
".\nassistant (t3): Noted. The team agreed the mechanical checker beats an LLM judge.\nuser (t4): Next we discuss hiring"
"the team agreed the mechanical checker beat an LLM judge" => none   (tense change → stripped)
```

After the repair, the page quotes speaker labels and the next speaker's turn as if one person said it. That is misattribution written into published memory. The existing unit test (`test/cycle-synthesize-verify.test.ts:101`) only checks `contains`, so it passes with the padded window.

**Fix:** After choosing the best window, trim it to the minimal span covering the matched tokens. Refuse any replacement that crosses a speaker-anchor line (the `**Speaker** (ts):` or `role (tN):` pattern) or is longer than about 1.3× the quote. Tighten the test to `expect(g.replacement).toBe('The team agreed the mechanical checker beats an LLM judge')`.

#### C-7. Quote-verify does not reject made-up content (P1, VERIFIED)

**File:** `synthesize-verify.ts:23-29, 440-443, 485-492`

To the question "does synthesize-verify reject hallucinated citations?": **no**. An ungrounded quote is kept as plain prose with its quote marks removed:

```
in : The user confirmed "the paid tier launch is fully approved by leadership" in the call.
out: The user confirmed the paid tier launch is fully approved by leadership in the call.
```

Further gaps:
- Numeric and date claims are warn-only.
- Wikilink targets and attributions without quote marks are never checked.
- Scope is limited to slugs containing the transcript `hash6`. Every `wiki/people/*` page, whether newly created or edited, is skipped as "preexisting" (`:491`). The riskiest category, quotes attributed to a person, is therefore never checked at all.

**Fix:**
- Treat an unrecoverable quote as a claim that failed verification: remove the sentence, or flag the page `grounding: failed` and keep it out of retrieval until reviewed.
- For pages that existed before the run, verify only the diff: quotes present after the child's write that were not in the prior revision (from `page_versions`).
- Promote `numeric_claim_warns > 0` to a flag in the page frontmatter.

#### C-8. The provenance stamp marks human pages as dream-generated (P1, SUSPECTED, strong code evidence)

**Files:** `skills/_brain-filing-rules.json:161` (`"wiki/people/*"` is in the dream allow-list), `synthesize.ts:2712` (the "never write over an existing person page" rule exists only in the prompt), `synthesize.ts:2910-2945` (`stampDreamProvenance`), `src/core/persistence/page-mutations.ts:95-106` (no subagent-specific block on `force` / `expected_revision`).

```sql
UPDATE pages SET frontmatter = COALESCE(frontmatter,'{}') || $4::jsonb /* {dream_generated:true, raw_source} */ ...
WHERE slug = $1 AND source_id = $2
```

**Why it's wrong:** A child can pass `force` (or read `get_page` and pass `expected_revision`) and overwrite an existing human `wiki/people/*` page. Every slug a child put gets the `dream_generated: true` stamp without condition. The anti-loop gates then treat the human page as machine output forever: `extract_facts` skips `is_dream_generated`, and transcript discovery skips it too. The page's future facts are silently not extracted.

**Fix:**
- In the subagent put_page path (`viaSubagent && allowedSlugPrefixes`), refuse `force` and refuse to update pages whose current frontmatter lacks `dream_generated`, so only creates and self-updates are allowed.
- In `stampDreamProvenance`, add `AND (frontmatter->>'dream_generated' = 'true' OR created_at >= $phaseStart)`.

**To verify:** drive a oneshot or agentic child with a scripted put_page `{force:true}` on a seeded `wiki/people/alice-example`.

#### C-9. Connector watermark is per provider, not per source (P1, VERIFIED)

**File:** `src/core/connectors/config-keys.ts:31`; `sync.ts:203, 323`

```ts
export const watermarkKey = (p: ConnectorProviderName) => `connectors.${p}.watermark_iso`;
```

**Why it's wrong:** `runConnectorSync` takes `sourceId`, and so do the CLI `--source` flag and the job param. The watermark is global per provider, so syncing ChatGPT into a second source only lists conversations within 7 days of the first source's watermark. This is a source-isolation leak on the write path, and the second source is silently missing all history. `last_sync_at` and `auth_error_at` have the same issue, which also wrongly suppresses scheduled syncs for the other source.

**Evidence:**
```
r1 (source default) listed 2;  r2 (source work) listed 1
pages: default/{new, old}, work/{new}      ← "old" never reaches source 'work'
```

**Fix:** Key the watermark, `last_sync_at`, and `auth_error_at` by `(provider, sourceId)`. Migrate the existing key to the `default` source or the configured `connectors.source_id`. The lock can stay per provider.

#### C-10. Connector `--limit` never makes progress (P1, VERIFIED)

**File:** `sync.ts:233-234`

```ts
const capped = typeof opts.limit === 'number' && stubs.length > opts.limit;
const toFetch = capped ? stubs.slice(0, opts.limit) : stubs;
```

The list is newest-first, and a capped run doesn't advance the watermark, so each run re-fetches the same newest N. They are hash-skipped, and the older backlog is never reached. The rate-limit use case `--limit` exists for is exactly the case that stalls.

```
run 0 partial fetched 2 imported 2 | run 1 fetched 2 imported 0 skipped 2 | run 2 same
conversation pages after 3 limited runs: 2 of 5
```

**Fix:** Skip stubs whose `(id, updatedAt)` already matches an imported page before applying the cap. A cheap DB probe works: `raw_data` or `frontmatter.transcript_import.session_id` plus a stored `update_time`. Alternatively, store a resume cursor (the oldest `updatedAt` fetched) and continue below it on the next capped run.

#### C-11. One failing conversation freezes the watermark and forces a full re-fetch (P1, VERIFIED)

**File:** `sync.ts:275-277, 319-325`. A permanent 404, or a shape drift on one conversation, makes every run `partial`, and the watermark never advances. Every later run re-fetches every conversation's detail since the old watermark (minus 7 days). The fetch set grows without bound, which is the "hammer that flags an account" the header warns about.

```
run 0 partial fetched 2 fetchErrors 1 wm null
run 1 partial fetched 2 fetchErrors 1 wm null
```

**Fix:** Keep a per-conversation failure ledger (`connectors.<p>.failed_ids`, with attempts). After K attempts, quarantine the id and allow the watermark to advance, reporting it in doctor. Also skip re-fetching stubs whose `updatedAt` matches the stored value (same probe as #10).

#### C-12. `jobs prune` wipes synthesis idempotency, causing paid re-synthesis and duplicates (P1, VERIFIED by code)

**Files:** `synthesize.ts:2821-2836` (`loadSuccessfulSynthesisKeys` reads only `status='completed'` rows from `minion_jobs`), `src/core/minions/queue.ts:1254-1277` (`prune` deletes `completed` rows older than 30 days by default), exposed by `src/commands/jobs.ts:1040`.

**Why it's wrong:** The only record that a transcript was synthesized is the completed job row. After a routine `gbrain jobs prune`, every transcript in the corpus is re-triaged and re-synthesized. That is paid, and synthesize has no USD gate (#13). The LLM chooses new topic slugs (only the `hash6` suffix is stable), so reflection and original pages are duplicated.

**Fix:** Persist a completion record outside the job table, for example in `dream_verdicts` (a `synthesized_at` / `synth_key` column) or a dedicated `dream_synth_done(source_id, file_hash)` table. Alternatively, exclude `idempotency_key LIKE 'dream:synth%'` from `prune`.

#### C-13. Synthesize has no USD budget gate (P1, VERIFIED by code)

**File:** `synthesize.ts:645-664, 764-790`. Spend is bounded only by:
- `dream.synthesize.max_submissions_per_source_per_day`, which defaults to 0 (disabled) and fails open (`capActive = false`) if its count query throws;
- the existing-keys query, which also fails open (`:783`);
- wall-clock time.

Triage cost is computed after the fact (`:540`). There is no `BudgetMeter` or pre-spend check. A triage-version bump (see `TRIAGE_VERSION` notes), a prune (#12), or a moved corpus root can trigger an unbounded paid re-synthesis.

To the question "are budget meters enforced before spend?": `BudgetMeter` users (auto-think, drift, base-phase subclasses) check before spend. Synthesize and patterns have no meter at all.

**Fix:** Wrap each child submit with a `BudgetMeter.check` using `max_turns × (chunk tokens + max_output)` as the upper bound, under a `dream.synthesize.budget_usd` default (for example $5). Fail closed when the count query errors.

#### C-14. Atoms are keyed by LLM-chosen titles; stale atoms are never removed (P1, VERIFIED by code)

**File:** `src/core/cycle/extract-atoms.ts:1621-1673, 1190-1260`

```ts
function sourceDate(ref) { ... return m ? m[1] : todayDate(); }   // todayDate = UTC run date
function atomSlug(title, srcRef, sourcePageSlug?) { ... `atoms/${sourceDate(srcRef)}/${atomSlugStem(title)}-${hash}` }
```

**Why it's wrong:**
- Identity is the LLM's atom title, which is non-deterministic across runs.
- For undated source pages (for example `people/alice-example`, `concepts/x`), the date segment is the run date, so re-extracting on a later day always mints a new slug. This contradicts the documented "reword-still-upserts" property.
- There is no path that deletes or supersedes the prior extraction's atoms for a source (grep finds no delete on `source_slug`).

Each page edit therefore adds a new set of atoms beside the stale ones. `synthesize_concepts` then counts both sets, inflating tiers.

**Fix:** After a successful item flip, soft-delete atoms with `source_slug = item.slug AND source_hash <> hash16`. For undated pages, use a stable date (page `created_at`) instead of the run date.

---

### C-P2 findings

#### C-15. Mixed UTC and local "today" in the cycle (P2, VERIFIED by code)

`resolveCycleDate` (local or `cycle.timezone`) is used only for the synthesize summary and provenance date (`synthesize.ts:404`). Several other places still use the UTC date:
- `patterns.ts:565`: the prompt's "Today" is UTC.
- `drift.ts:344`: `reports/drift-<UTC date>`.
- `drift.ts:217`: the lookback cutoff.
- `extract-atoms.ts:1622`: atom slug dates for undated sources.
- `synthesize.ts:2657`: the prompt date hint, which is also what the child uses to date originals.
- `synthesize.ts:3019`: the `renderPageToMarkdown` fallback.

For a dream run at 11pm PDT (06:00 UTC the next day), the summary is dated D while the drift report, atoms, and patterns prompt are dated D+1. **Fix:** resolve the cycle date once in `runCycle` and thread it to every phase. Replace the remaining `toISOString().slice(0,10)` calls, and add a lint for that pattern under `src/core/cycle`.

#### C-16. Budget meter gaps (P2, VERIFIED by code)

- `budget-meter.ts:133-160`: a model missing from the pricing table bypasses the gate entirely (fail-open, warned once per process). A paid model with a new id (router or proxy alias) runs unbounded. **Fix:** fail closed by default, with `dream.budget.allow_unpriced=true` to opt out.
- `drift.ts:323`: `estimatedInputTokens: 1500` is a fixed constant, but the evidence is up to 12 timeline rows of arbitrary length. There is also a fixed `maxTokens: 400` on a `tier: 'reasoning'` model; thinking models bill reasoning as output, so this underestimates and truncates. **Fix:** estimate from the actual prompt length and use `resolveSynthMaxOutputTokens`.
- `drift.ts:58`: `Math.max(0, parseFloat(b) || 1.0)` maps `"0"` to $1.00 and `"-1"` to 0, and 0 means *unlimited* in `BudgetMeter`. The semantics are inverted and inconsistent with `base-phase.ts:184-193`. **Fix:** make 0 mean "spend nothing" everywhere, and use an explicit `unlimited` value for no cap.

#### C-17. Claude connector: pagination, org, and timestamp form (P2, SUSPECTED)

`providers/claude.ts:134-137` fetches `/chat_conversations` once, with no limit, offset, or cursor. If the endpoint caps its default page size, a `--full` backfill silently truncates, and there is no drift alarm. `:74` uses `orgs[0]` only, so users in both a team org and a personal org lose one of them. `:147` stores raw `updated_at` strings (microseconds or `+00:00` forms) and compares them lexicographically against Z-form watermarks; ChatGPT uses `toIso()`. **Fix:** normalize with `toIso`, paginate with a truncation guard like ChatGPT's `MAX_LIST_PAGES`, and iterate all orgs.

#### C-18. ChatGPT offset pagination over a mutable ordering (P2, SUSPECTED)

`providers/chatgpt.ts:106-137` pages with `offset += items.length` over `order=updated`. A conversation updated during the list moves to offset 0, which shifts every item down by one, so the item at the page boundary is skipped. The 7-day trailing window usually recovers it on a later run, but on `--full` (no watermark) there is no later recovery if the watermark then jumps. **Fix:** after the list, re-list page 0 once and union the results, or de-duplicate by id and re-request until `total` is stable.

#### C-19. A session with no timestamps freezes `--since last` (P2, VERIFIED by code)

`render.ts:303-306` throws for a session with no timestamps. `ingest.ts:406-410` counts that as a session error and sets `cleanScan=false`, so the `--since last` checkpoint for that root never advances again. Every run becomes a full rescan: correct output, but slow, and it hides the real problem. **Fix:** classify the session as `skipped_no_timestamp` (reported, not an error), or fall back to the file mtime with `date_source: mtime` provenance.

#### C-20. Missing tests (P2, VERIFIED)

There is no test for:
- retitle + grow (#1, ingest and connector);
- concept pages that already exist or are human-owned (#2);
- slug normalization in `synthesize_concepts` (#4);
- a timeline-only phantom (#3);
- a watermark keyed per source (#9);
- limit progress (#10);
- poison-conversation quarantine (#11);
- a near-match replacement staying within one speaker turn (#6; the existing test only asserts `contains`);
- `jobs prune` followed by a dream cycle (#12).

---

### C-Answers to the specific questions

- **Can synthesis clobber human content?** Yes. `synthesize_concepts` does it directly (#2). Synthesize and patterns children can overwrite `wiki/people/*` pages, because only a prompt rule forbids it, and the result is then stamped `dream_generated` (#8). Phantom redirect deletes timeline-only pages (#3).
- **Duplicate concept pages under different slugs?** Yes (#4). Duplicate atoms (#14) and duplicate reflections after a prune (#12) also happen. Pattern dedup relies only on the prompt ("use search… same slug").
- **Does synthesize-verify reject made-up quotes?** No. It removes the quote marks and keeps the text, skips person pages, and its near-match can misattribute (#6, #7).
- **Is the cycle date consistent?** Only the synthesize summary uses local time; the other phases use UTC (#15).
- **Are minion jobs idempotent under retry and stall reclaim?** The queue itself is sound. Completion uses `lock_token + status='active'` CAS, lock loss aborts via the signal, subagent tool calls replay from `subagent_tool_executions`, and put_page carries request ids. The weak points are long-horizon: the "done" state is stored in prunable job rows (#12), and handlers that ignore `signal` (for example `runTranscriptsIngest` inside connector sync) can keep writing after a reclaim. Those writes are content-hash idempotent, so no duplicates were found there.
- **Do connectors resume without dropping or duplicating?** The cursor is advanced only after commit, which is correct. But: edited and retitled conversations drop their new content (#1), the watermark is not per source (#9), `--limit` stalls (#10), one bad conversation freezes progress (#11), and Claude has no pagination (#17).
- **Does transcript ingest dedupe re-imports of the same export?** Yes. Content hash plus `frontmatter.id` handle it, verified by existing e2e tests. The dedup is too aggressive when content changes under a new slug (#1).
- **Budget before or after spend?** `BudgetMeter` checks before spend, but fails open for unpriced models and underestimates (#16). Synthesize has no USD meter at all (#13). `synthesize_concepts` checks before each call against a post-hoc estimate, which is bounded to overshooting by one call.

---

### C-High-leverage improvements, each with an eval

1. **Content-aware transcript identity.** Stable slug `day-<sessionid>`, and identity matches with different content become updates. *Eval:* a fixture of 20 ChatGPT and Claude conversations × 3 export snapshots (grow, retitle, branch-regenerate, untitled→named). *Metric:* after importing all snapshots, the page count equals the conversation count, and 100% of final-snapshot message texts are found via `searchKeyword`. Today this fails on retitled cases.

2. **Human-ownership guard for all dream writes.** One `assertDreamMayWrite(slug)` helper used by concepts, synthesize/patterns children, and the provenance stamp. *Eval:* seed 50 human pages under `concepts/` and `wiki/people/`, plus atoms and transcripts that reference them, then run 3 cycles with a scripted `_chat` / subagent stub. *Metrics:* the human page body hash is unchanged (target 100%), no human page has `dream_generated` set, and synthesized output lands only in fenced or sibling locations.

3. **Grounding gate instead of quote stripping.** Minimal-span repair, turn-boundary refusal, and diff-scoped verification for pages that already existed. *Eval:* extend the Cat 35 fixture with 200 labelled quotes (verbatim / light paraphrase / fabricated / cross-speaker splice). *Metrics:* precision of "kept as quote" at least 0.99, fabricated quotes kept as unmarked prose ≤ 1%, and zero replacements that cross a speaker anchor.

4. **Durable, source-keyed sync state for connectors.** Watermark, `last_sync_at`, and a per-id `(updatedAt, attempts)` ledger, all keyed by `(provider, source)`. This lets `--limit` progress, lets bad ids quarantine, and avoids re-fetching unchanged detail. *Eval:* the fixture server with 500 conversations, 2 poison ids, 5 mid-list updates, and runs with `--limit 50` into two sources. *Metrics:* runs to full coverage should be ⌈500/50⌉; detail fetches per steady-state run should be about the number of changed conversations; coverage should be 100% in both sources. Today coverage is 50/500 and each run re-fetches everything.

5. **Derived-data reconciliation for atoms and concepts.** Supersede stale atoms per source-page hash, normalize concept keys through the alias resolver, and rewrite concepts only when the member-set hash changes. *Eval:* 100 source pages, each edited 3 times over 3 simulated days, with a deterministic `_chat` that paraphrases titles. *Metrics:* live atoms per page stay flat across edits, and there are zero concept pages with invalid or space-containing slugs. For concept pages not rewritten on unchanged cycles, target 0 rewrites, measured via the `page_versions` count.
