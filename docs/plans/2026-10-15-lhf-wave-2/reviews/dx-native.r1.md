INPUT: dx 6fa9d38bfc024b00e8503e41313d327403736c9f865b87ef3dc5083abc1ba736

# DX review (native voice): LHF wave 2 plan

Reviewer: anthropic/claude-opus-5-5 (native), gstack plan-devex-review methodology (`gstack: ok 1.91.101.0 for=autoplan` on this machine), unattended, mode **DX POLISH**. Checkout: the shared gbrain checkout at `capy/lhf-wave-2` (master `3c16e9ba` + item 0 `d5861ac6`). No provider spend; one keyless probe (below). DX Trend Check: no prior `plan-devex-review` rows for this project.

The plan is a sound performance wave, but its developer-facing contract work (items 1, 4, 8, 10) has four verified regressions. None of them shows up in the order-digest or char-count gates. First, eliding `effective_date_source` makes the `[gbrain dates]` line mislabel 97% of dated rows. Second, item 1's "same notice" can't be produced by the proposed `EXISTS` query. Third, item 8b removes frozen v1 fields with no escape hatch. Fourth, the `BEHAVIOR_CHANGES` list misses items 2, 9 and 10, including the image OCR model change. Each has a contained fix that keeps the plan's direction, except 8b's remote default, which is Garry's call.

## Step 0

### Developer Persona Card

| | |
|---|---|
| **Primary** | Agent-harness integrator: someone running OpenClaw, Claude Code, Codex or a custom agent against a remote gbrain over MCP. Their agent reads `search`/`query` rows, the `[gbrain …]` trailers and `context_pack` at session start. They never read gbrain source, and they learn the contract from tool descriptions, row field names and notices. |
| **Secondary** | Self-hosting operator who runs `gbrain upgrade`, reads the BEHAVIOR_CHANGES notice, and uses `gbrain models` / `gbrain doctor` to see what changed and how to pin it back. |
| **Tertiary** | Contributor (@troyhoffman-oss, @spiky02plateau) whose PRs this wave supersedes, plus the next gbrain engineer who must reproduce the latency receipts. |
| **Mental model** | "Fields I see mean what they say. A missing field means nothing happened. Upgrades tell me what moved and how to undo it." |
| **Tolerance** | Low for silent semantic drift, because agents act on fields (write decisions, date reasoning, type refinement) without a human in the loop. |

### Developer Empathy Narrative (integrator, after this wave ships as written)

"My agent's search got faster, which is nice. Then it told a user that a contract's renewal date was 'of unrecorded origin'. The `[gbrain dates]` line now says that for almost every row, because the rows stopped carrying `effective_date_source` and the line treats a missing source as unrecorded. My session-start hook reads `cards[i].summary` from `context_pack`, and on upgrade it got `undefined`. No parameter brings it back, and the v1 protocol doc still says the field is frozen forever. When my agent filters by a type the brain doesn't have, the notice no longer lists the types it does have, so the agent guesses again. I turned expansion back on with `search.expansion true`. `gbrain models` says expansion runs on Haiku 4.5, but the bill says 5.5, and my image OCR moved too."

### Competitive DX Benchmark (qualitative; no web research run in this unattended pass)

| Dimension | gbrain today | Hosted memory APIs (mem0 / Zep / Supermemory class) | Target after wave |
|---|---|---|---|
| Result-shape control | `fields: lean\|full`, host `mcp.result_rows`, thin-client header on search rows | usually a fixed response schema, sometimes with field selection | The same three controls on every verb whose shape changes, `context_pack` included |
| Behavior-change comms | BEHAVIOR_CHANGES notice on upgrade with the undo command (item 0's row is a model) | changelog only | A row for every user-visible change, each with its pin command |
| Diagnostics truthfulness | `gbrain models` shows the resolved model and source; `--explain` timings | dashboard | `gbrain models` and `--explain` match what actually ran |

Rank: **Competitive** today, and this plan as written drops it to **Needs Work** on contract stability. With the fixes below it stays Competitive.

### Magical Moment Specification

The moment is the integrator's agent getting the same answers, faster and smaller, with nothing to relearn. It arrives three ways: `query` p50 drops from 2,022 ms to 227 ms (item 0, already shipped with an exemplary BEHAVIOR_CHANGES row), remote search drops from about 1,550 ms to under 500 ms at 30 ms RTT (item 5), and roughly 10% fewer result characters per task (item 8a). The vehicle is the upgrade notice plus CHANGELOG. The requirement this review adds is that "nothing to relearn" must hold. Every elided field needs one unambiguous meaning when absent, and every trailer must still say true things about lean rows.

### Developer Journey Map

| Stage | Integrator / operator action | Friction found | Resolution (finding) |
|---|---|---|---|
| Upgrade | `gbrain upgrade`; migrations run | Item 6 adds an ANALYZE with no progress line or failure path | F9 |
| Read notice | BEHAVIOR_CHANGES rows | Rows only for items 0 and 8; items 2, 9 and 10 (plus OCR) are silent | F4 |
| Check models | `gbrain models` | The expansion row will show the tier default (Haiku 4.5) while the gateway uses 5.5; OCR has no row | F7 |
| First remote search | Agent reads rows + trailers | The dates line mislabels elided rows; create_safety is gone; the defaults line is absent on `query` | F1, F5, F6 |
| Typed search miss | Agent reads `type_filter_notice` | The list of available types disappears | F2 |
| Session start | Hook reads `context_pack.cards[]` | Fields removed, `budget_used` redefined, no escape hatch | F3 |
| Paged keyword count | Agent reads `[gbrain search]` | A skipped count renders as "failed" or vanishes | F8 |
| Facts-heavy brain | Saved-facts notice | Silent fallback to the slow path; nothing in `--explain` | F10 |
| Reproduce receipts | Contributor reruns the bench | The delay proxy isn't in the repo; the digest includes score | F11 |

### First-Time Developer Confusion Report

1. "Why does every row say its date is of unrecorded origin?" (F1, verified by probe.)
2. "Which value is 'the default' for `trust_tier` on my brain?" The plan never names it, and it differs between a claimed managed-sync source (`operator_curated` + `managed_sync_import`) and other sources (F6).
3. "My agent created a duplicate page. The row said `evidence: weak_semantic` but no `create_safety`." (F5)
4. "Where did `cards[].summary` go, and how do I get it back?" (F3)
5. "Which types exist? The notice used to tell me." (F2)
6. "Is expansion on Haiku 4.5 or 5.5?" (F7)

## Pass 1: Getting Started (score: unchanged, not re-measured)

This plan changes no install, init or first-run step. TTHW for the integrator (connect MCP, run the first search) is untouched. The only upgrade-time addition is item 6's ANALYZE, which on a fresh install runs against empty tables. **No issues found in scope.** Hosted gbrain remains the first-agent path per AGENTS.md, and nothing here affects it.

## Pass 2: API/CLI/MCP design: 5/10 → 8/10 with fixes

- **Consistency of escape hatches.** Search rows already have three controls (`fields`, `mcp.result_rows`, the `X-Gbrain-Client` thin-client header, `src/mcp/result-rows.ts`). Item 8b changes `context_pack`'s shape, but `context_pack` takes none of them (`src/core/ops/facts.ts:696-705`), so it gets a different and weaker contract than its sibling verb (F3).
- **Absent-field semantics.** For an agent, an absent field has to mean exactly one thing. Item 8a gives absence three meanings: "default trust pair" (brain-specific), "derivable from evidence" (create_safety) and "document date". It states them through a trailer that is null on `query` and on count-less calls (`keyword-paging.ts:247`) (F5, F6).
- **Naming and defaults for item 10.** Item 10 copies the facts-extraction "measured default" pattern but doesn't copy its diagnostics row (F7).
- Item 0's design is a good example: one config key, one per-call flag, both named in the notice.

## Pass 3: Errors and debugging: 5/10 → 8/10 with fixes

Three error paths traced:

1. **Typed search with a missing type (item 1).** Today's notice: "No pages have type deal; filtered to company. Page types in this brain: company, concept, person…" (`src/core/ops/search.ts:284-288`). That list is the fix half of the message: it is what lets the agent refine instead of guessing again, and the comment cites the Cat 40 failure rate on typed runs (62% vs 51%). An `EXISTS` per requested type can only answer yes or no, so the plan's "same keep/missing decision and notice" can't be true. The developer would get the problem without the fix (F2).
2. **ANALYZE failing inside a migration (item 6).** `buildIndexOnline` already shows the house style. It prints "building … this can take minutes; it is safe to leave running; if interrupted, gbrain doctor names the rebuild command" and throws with "rerun: gbrain repair request-indexes --apply" (`src/core/schema-migrations/helpers.ts:106-114`). The plan doesn't say what happens when the new ANALYZE times out after the index is built. If it throws, three repeats wedge upgrades. It should be best-effort, with a notice naming `gbrain repair planner-stats --apply`, which the existing `planner_stats_stale` check already offers (F9).
3. **Keyword count deliberately skipped (item 4).** `searchCountLine` renders a null `keyword_total` as "Keyword match count unavailable (failed; not a count of zero)" (`keyword-paging.ts:233-250`), and the interop notice says "did not finish". A deliberate skip would read as an error, and an absent key drops the line entirely, which removes the Cat 40 F2 count contract (F8).

Debug mode: `--explain` and `_meta.retrieval.timings` exist. Item 2's choice between the FTS and LIKE paths should appear there, and it currently isn't planned (F10).

## Pass 4: Documentation: 6/10 → 8/10 with fixes

Item 0 updated about 30 doc and skill files, which is the right bar. Items 8 and 10 name only "BEHAVIOR_CHANGES rows and memory-verb protocol note". These pages also go stale:

- `docs/mcp/README.md` "Search and query result rows": it says lean rows keep `trust_tier` and `origin` and documents `effective_date_source` per row, and its copy-paste example needs updating.
- `docs/protocol/MEMORY_VERBS_v1.md:865-868`: it defines `budget_used` as tokens of `text`.
- `docs/mcp/TOOL_REFERENCE.md`, the `models` guide and search-modes for the expansion model.
- `KEY_FILES` entries and the `llms-full.txt` regeneration (F12).

## Pass 5: Upgrade and migration: 5/10 → 8/10 with fixes

The plan pre-lists BEHAVIOR_CHANGES rows only for items 0 and 8. Several other items change what users and agents see:

- Item 2: a saved fact that matched by substring stops surfacing.
- Item 9: attendance phrasings and year tokens route differently.
- Item 10: the opted-in expansion model, the image OCR model through `getImageOcrModel()` falling back to `getExpansionModel()` (`src/core/ai/gateway.ts:880`), and their cost.
- Item 4: possibly, if the count meta changes.

Under the inherited coordinator contract, an omitted change found in review is CRITICAL whatever its size, so these should be written now. Each needs its pin command, following the precedent of the 0.60.188.0 lean-row row (which names `fields: "full"` and `mcp.result_rows: full`) (F4).

Item 8b is a v1 wire break. `MEMORY_VERBS_v1.md:28-31` says field names and semantics are frozen forever, so a "protocol note" doesn't cover it (F3).

## Pass 6: Developer environment and tooling: 5/10 → 8/10 with fixes

The receipts can't be reproduced as planned:

- The 30 ms "delay proxy" is a scratch file (local audit notes (not committed)), while the repo already ships a toxiproxy harness (`scripts/bench/managed-sync-catchup-lib.ts`, `foreground-put-page.ts --rtt`).
- The bench digest still hashes `score` (`scripts/bench-refactor-wave-1.ts:474`), but the plan's gate is order-only.
- The keyless char-count gate doesn't name `scripts/replay-lean-row-savings.ts`. That script already cross-checks against `leanRow`'s own projection and is the natural home for the 8a elision and an 8b `context_pack` pass (F11).

## Pass 7: Community: 6/10 → 8/10 with fixes

Crediting @troyhoffman-oss with `Supersedes #6734/#6747` follows the project rules. Two gaps remain:

- #6335 is "closed as superseded for that half; its tier flip stays open". A PR can't be half-closed, so the plan should pick open-with-comment or closed-with-a-linked-TODO-D.
- #6734 loses three of its six commits (the threshold change, the v246 trigram index and the OR-retry). The contributor should get a comment naming each dropped part, why it was dropped, and what evidence would revive it (F13).

## Pass 8: DX measurement: 6/10 → 8/10 with fixes

The per-item receipts and the single gbrain-evals report are good. Missing: a lean-output golden test that covers the trailers (not just the rows), the `--explain` path label for item 2, and naming fixes: the report path `2026-10-1x` is still a placeholder, and the item 0 BEHAVIOR_CHANGES comment says "item 1" (F14).

### Keyless probe (evidence for F1)

local audit notes (not committed) runs `dateLabelLine` on rows with and without `effective_date_source: "date"`:

```
full  : [gbrain dates] effective_date by effective_date_source: date = document date; created = fallback (page created/imported, not from its text). Never a contract's effective or validity date (read the text).
elided: [gbrain dates] effective_date by effective_date_source: created = fallback (page created/imported, not from its text); no source = date of unrecorded origin. Never a contract's effective or validity date (read the text).
query meta without keyword_total -> null
```

`dispatch.ts:420` renders this line from the projected (lean) rows, so item 8a as written relabels the 96.9% of rows whose source is `date` (cost audit) as "unrecorded origin".

## NOT in scope (DX, deferred)

- A per-field `fields:` selector, for lean rows that keep trust visible. `fields: "full"` and `mcp.result_rows: full` already cover the way back, so this is not needed now.
- Moving the default-statement into the static tool descriptions for every verb. That belongs with the `full`-surface size plan.
- An attended-phrase debug field. `relational.plan.hops[].link_types` already shows when "attended" routed.

## What already exists (reuse)

- Escape-hatch plumbing: `resultRowsFor` / `ctx.resultRows` (`src/core/search/lean-rows.ts:51-55`), `src/mcp/result-rows.ts`. Reuse it for `context_pack`.
- The BEHAVIOR_CHANGES row style with undo commands: the item 0 row and the 0.60.188.0 lean-row row (`src/core/behavior-change-notice.ts`).
- The measured-default plus `gbrain models` row pattern: `FACTS_EXTRACTION_MEASURED_DEFAULTS` (`src/core/facts/extract.ts:65-91`) and its `narrowResolver` (`src/commands/models.ts:121-129`).
- The migration notice and failure style: `buildIndexOnline` (`helpers.ts:106-114`); doctor `planner_stats_stale` with `gbrain repair planner-stats --apply`.
- The facts index validity check: `src/core/facts/fts-index.ts`; language repair `gbrain reindex-search-vector`.
- Bench and tooling: `bench-refactor-wave-1.ts`, `replay-lean-row-savings.ts`, the toxiproxy harness in `scripts/bench/`.
- Agent-facing notice code and fix objects: `relationalPlanNotice` (`src/core/ops/search.ts:1414-1430`).

## TODOS.md updates (proposed; unattended, so not asked one by one)

1. **What:** a per-field lean selector, or trust kept inline under `mcp.result_rows: lean_trusted`. **Why:** operators who want #5575's "every row says how much it deserves influence" plus lean rows have no knob. **Depends on:** item 8a landing. Recommendation: A) add.
2. **What:** a doctor check for `idx_facts_fts` missing or built under a different FTS language. **Why:** item 2 falls back silently. **Depends on:** item 2. Recommendation: C) build now if cheap, else A).

## DX Scorecard

```
+====================================================================+
|              DX PLAN REVIEW — SCORECARD                             |
+====================================================================+
| Dimension            | Score  | Prior  | Trend  |
|----------------------|--------|--------|--------|
| Getting Started      | n/a    | —      | unchanged (plan does not touch) |
| API/CLI/SDK          | 5/10   | —      | → 8 with F2,F3,F5,F6,F7 |
| Error Messages       | 5/10   | —      | → 8 with F2,F8,F9,F10 |
| Documentation        | 6/10   | —      | → 8 with F12 |
| Upgrade Path         | 5/10   | —      | → 8 with F3,F4 |
| Dev Environment      | 5/10   | —      | → 8 with F11 |
| Community            | 6/10   | —      | → 8 with F13 |
| DX Measurement       | 6/10   | —      | → 8 with F1 golden, F14 |
+--------------------------------------------------------------------+
| TTHW                 | unchanged (not re-measured)                  |
| Competitive Rank     | Needs Work as written → Competitive with fixes |
| Magical Moment       | designed via upgrade notice + CHANGELOG      |
| Product Type         | MCP server + CLI (agent memory)              |
| Mode                 | POLISH                                       |
| Overall DX           | 5/10 → 8/10                                  |
+====================================================================+
| DX PRINCIPLE COVERAGE                                               |
| Zero Friction      | covered (no install change)                    |
| Learn by Doing     | gap (README example + MEMORY_VERBS stale, F12) |
| Fight Uncertainty  | gap (F1, F2, F8, F10)                          |
| Opinionated + Escape Hatches | gap (F3; F7 for discoverability)     |
| Code in Context    | covered (trailers, notices)                    |
| Magical Moments    | covered if "nothing to relearn" holds          |
+====================================================================+
```

Several dimensions score below 6. That is critical DX debt for agent integrators, because their agents act on these fields unattended.

## DX Implementation Checklist

```
[ ] Lean-output golden tests cover rows AND trailers ([gbrain dates], [gbrain search], defaults line) for search and query, remote:true
[ ] [gbrain dates] reads elided effective_date_source as its stated default (F1)
[ ] Item 1 notice text byte-identical on miss path (DISTINCT probe only on a miss) (F2)
[ ] context_pack: fields lean|full + mcp.result_rows + thin-client header; budget_used unchanged; new additive size field (F3)
[ ] BEHAVIOR_CHANGES rows for items 2, 4 (if meta changes), 8a, 8b, 9, 10 (+OCR), each with the pin/undo command (F4)
[ ] create_safety kept on lean rows, or its evidence mapping stated in search/query descriptions (F5)
[ ] Elision defaults named per field; stated in _meta.retrieval.row_defaults + a standalone line on every call that elides (F6)
[ ] gbrain models shows expansion "measured" source and the OCR model (F7)
[ ] Skipped keyword count keeps keyword_total and an unchanged trailer (F8)
[ ] ANALYZE best-effort with progress notice + repair command; already-upgraded brains healed (F9)
[ ] --explain names the saved-facts path; language-mismatch counts as "index missing" (F10)
[ ] Bench --rtt (toxiproxy) and --digest order committed; replay script extended (F11)
[ ] Docs: mcp/README rows + example, MEMORY_VERBS_v1, TOOL_REFERENCE, models/search-modes, KEY_FILES, llms regen (F12)
```

## Unresolved Decisions

- **8b's remote default (F3).** Whether to flip `context_pack` to lean for third-party remote callers, which breaks the frozen v1 contract, or ship the compact shape as opt-in. That is a protocol-policy decision for Garry. My recommendation is opt-in now, with a v1 exception or v2 decision recorded before any default flip.
- Every other finding has a recommended fix that keeps the plan's direction.

## Review log row (not written; the parent owns autoplan logging)

`{"skill":"plan-devex-review","status":"issues_open","initial_score":5,"overall_score":8,"product_type":"mcp-server+cli","tthw_current":"unchanged","tthw_target":"unchanged","mode":"POLISH","persona":"agent-harness integrator","competitive_tier":"Competitive","unresolved":1,"commit":"d5861ac6"}`

## Next steps

Run eng review next (required gate). F2, F8 and F10 touch query paths, and F3 needs a protocol decision. Run `/devex-review` after the wave ships to check that lean-output trailers and `gbrain models` match what actually ran.

```gstack-findings
{"id":"F1","severity":"High","title":"Item 8a's elision of effective_date_source makes the [gbrain dates] line label 96.9% of dated rows 'date of unrecorded origin' (verified by probe)","file":"src/core/search/date-labels.ts","line":31,"fix":"Make dateLabelLine read an elided effective_date_source as the stated default ('date'), or render the line from pre-projection rows in dispatch; add a lean-output golden test asserting the dates line is identical for lean and full rows."}
{"id":"F2","severity":"High","title":"Item 1's 'same notice' is impossible with EXISTS: the type_filter_notice's 'Page types in this brain: …' list, the part that lets agents refine, comes from the DISTINCT probe being removed","file":"src/core/ops/search.ts","line":286,"fix":"Run the per-type EXISTS on the hot path; only when a requested type is missing, run the existing DISTINCT probe (inside the jit-off settings) to build the unchanged notice. Pin the notice text with a golden test on a missing-type and an all-missing query."}
{"id":"F3","severity":"High","title":"Item 8b changes context_pack's shape with none of the escape hatches search rows have, and removes frozen v1 fields and redefines budget_used","file":"src/core/ops/facts.ts","line":842,"fix":"Reuse the search-row contract: add fields: 'lean'|'full' to context_pack resolved through resultRowsFor/ctx.resultRows, so mcp.result_rows: full and gbrain's thin client get full cards. Keep budget_used as tokens of text and add a new additive field for serialized size. Ship lean as opt-in now; flipping the remote default needs a recorded v1-exception or v2 decision from Garry.","user_challenge":true,"changes":"direction"}
{"id":"F4","severity":"High","title":"BEHAVIOR_CHANGES rows are planned only for items 0 and 8; items 2, 9 and 10 (including the image OCR model via getImageOcrModel's expansion fallback) and possibly 4 change user-visible behavior, which the coordinator contract makes CRITICAL if found in review","file":"src/core/behavior-change-notice.ts","line":645,"fix":"Pre-write a row per user-visible change with its undo/pin command, following the 0.60.188.0 and item 0 rows: item 2 (substring fact matches), item 9 (attendance and year routing), item 10 (`gbrain config set models.expansion anthropic:claude-haiku-4-5-20251001`, `gbrain config set embedding_image_ocr_model <model>`, cost change), item 8a (`fields: \"full\"` / `mcp.result_rows: full`), and item 4 if count meta changes."}
{"id":"F5","severity":"High","title":"Eliding create_safety removes the T4 duplicate-page guard from 99% of lean rows; agents are never told the evidence→create_safety mapping (not in the search/query descriptions or any skill)","file":"src/core/search/lean-rows.ts","line":38,"fix":"Keep create_safety on lean rows (about 2.2% of tool-result chars, 1.6M of 72.6M) and take 8a's savings from trust_tier/origin/effective_date_source. If it is elided anyway, state the mapping in the search and query tool descriptions and in the defaults line, and gate it with an agent check for duplicate-page writes."}
{"id":"F6","severity":"Medium","title":"Item 8a never names the elision defaults, which are brain-specific (operator_curated+managed_sync_import only on claimed managed-sync sources), and states them via a trailer that is null on query and count-less calls","file":"src/core/search/keyword-paging.ts","line":247,"fix":"Specify per field what is elided and when (fixed pair vs per-response mode; prefer per-response). Emit the values actually elided in _meta.retrieval.row_defaults plus a standalone model-visible line on every call that elided anything, independent of searchCountLine. Key elision on 'stamped and equal', never on absence."}
{"id":"F7","severity":"Medium","title":"Item 10 copies the measured-default resolver but not its diagnostics: `gbrain models` will show expansion on the Haiku 4.5 tier default while the gateway uses Haiku 5.5, and OCR has no row","file":"src/commands/models.ts","line":133,"fix":"Give models.expansion a narrowResolver returning source 'measured' and a description like facts.extraction_model's ('unset: claude-haiku-5-5 when the utility tier resolves through Anthropic'); record the measured source in setGatewayModelSource('expansion', …); add an embedding_image_ocr_model row or name the OCR fallback in the expansion description."}
{"id":"F8","severity":"Medium","title":"Item 4's skipped keyword count either drops the [gbrain search] count line (absent keyword_total) or renders a deliberate skip as 'failed; not a count of zero'","file":"src/core/search/keyword-paging.ts","line":233,"fix":"When the strict keyword arm under-fills its page, derive keyword_total from that arm's distinct pages so meta and trailer stay unchanged; reserve keyword_count_unavailable for real deadline misses or errors; add a golden test for the skipped path's trailer."}
{"id":"F9","severity":"Medium","title":"Item 6 specifies no progress or failure path for ANALYZE inside buildIndexOnline, and brains whose indexes are already 'present' never reach it","file":"src/core/schema-migrations/helpers.ts","line":106,"fix":"Extend the existing build notice with 'then analyzing <table>'. Make ANALYZE best-effort: on timeout or error, print a notice naming `gbrain repair planner-stats --apply` and never fail the migration. State whether already-upgraded brains heal through planner.auto_analyze or a planner_stats_stale warning, and prefer auto-heal."}
{"id":"F10","severity":"Medium","title":"Item 2's fallback to LIKE is silent, and 'index missing' must also cover idx_facts_fts built under another FTS language, where the tsquery prefilter can't use the index and is slower than LIKE","file":"src/core/fts-language.ts","line":119,"fix":"Choose the path with fts-index.ts's validity and language check; expose the chosen path in --explain and _meta.retrieval.timings (fts|like_cjk|like_no_index); point a doctor hint at `gbrain reindex-search-vector` when the index language mismatches."}
{"id":"F11","severity":"Medium","title":"The latency and size receipts aren't reproducible: the 30 ms delay proxy is an uncommitted scratch file, the bench digest still hashes score, and the char replay script isn't named","file":"scripts/bench-refactor-wave-1.ts","line":474,"fix":"Add --rtt <ms> to bench-refactor-wave-1.ts using the existing toxiproxy harness in scripts/bench/ and a --digest order mode ([source_id, slug, chunk_index]); extend scripts/replay-lean-row-savings.ts with the 8a elision and a context_pack pass; commit both so the next contributor and the nightly can rerun the receipts."}
{"id":"F12","severity":"Medium","title":"The docs plan for items 8 and 10 covers only a protocol note; the MCP rows doc and example, the MEMORY_VERBS_v1 budget_used definition, TOOL_REFERENCE, models/search-modes, KEY_FILES and llms files go stale","file":"docs/mcp/README.md","fix":"List and update: docs/mcp/README.md 'Search and query result rows' (kept fields, effective_date_source paragraph, JSON example), docs/protocol/MEMORY_VERBS_v1.md context_pack section, docs/mcp/TOOL_REFERENCE.md, the models and search-modes guides for the expansion and OCR model, KEY_FILES entries for touched files, then regenerate llms.txt / llms-full.txt."}
{"id":"F13","severity":"Low","title":"Contributor handling is ambiguous: #6335 can't be 'closed for half', and #6734's three dropped commits get no stated reason or revival path","fix":"Pick one for #6335: leave it open with a comment naming the landed expansion half, or close it and link a TODO-D entry, and use a Supersedes line only if closed. Comment on #6734 listing each dropped part (threshold-in-SQL, v246 trigram, OR-retry), why, and the evidence that would revive it. Add a Co-Authored-By trailer for @spiky02plateau if their code is taken."}
{"id":"F14","severity":"Low","title":"Naming drift: the item 0 BEHAVIOR_CHANGES comment says 'LHF wave 2 item 1' while the plan calls it item 0, and the report path is a placeholder (2026-10-1x)","file":"src/core/behavior-change-notice.ts","line":645,"fix":"Reference GBRA-94 only in the code comment; fix the gbrain-evals report filename when the first receipt is written."}
```
