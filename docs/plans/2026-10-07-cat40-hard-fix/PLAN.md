<!-- /autoplan restore point: "/home/user/.gstack/projects/garrytan-gbrain-evals/plan-cat40-hard-fix-autoplan-restore-20261007-193754.md" -->
# Cat 40 Hard fix wave: make gbrain find what plain files find

Status: draft for autoplan review, 2026-10-07. Owner: GBRA-39. Merge queue: GBRA-40.

## Implementation plan

## ELI10

gbrain lost to plain files on the Cat 40 Hard test by 11.3 points. The main reason is simple. In the test company, most records don't say a customer's name. They use a nickname ("Kumquat Vulture"), a code ("ZEU8") or "Dana's freight account". An agent with plain files greps the name, and the grep output shows the account sheet line "Nickname used by the team: Kumquat Vulture", so the agent searches the nickname next. An agent with gbrain asks gbrain for the customer's card. The card lists the name and the code, but never the nickname, so the agent believes it has every alias. It misses the records filed under the nickname and answers with an old value. The fix is to make gbrain know every name a customer goes by, and to say so on the card and in search. Smaller fixes: tell the agent how many results exist (grep does, gbrain doesn't), and stop auto-generated summaries outranking real records. Then we measure again on companies gbrain has never seen.

## What happened

Held-out result ([report](../../benchmarks/2026-10-07-model-ladder-hard.md)): 100 tasks on a 55,235-document company, Sonnet 5.5, Opus 5.5 and GPT-6.1 Sol. gbrain finished 62.0% and fs 73.3%, a paired difference of −11.3 points with 95% CI [−16.7, −6.0]. pg finished 68.3% and the oracle 98.0%.

## Root cause, from the existing 50k results (no new spend)

The analysis scripts are beside this plan: `rca.py`, `rca2.py` and `rca3.py`. They read `eval/reports/cat40/hard/cells-50k/` and the held-out world. On paired cells (same model, same task), gbrain lost 54 cells that fs won and won 20 that fs lost. That nets to 34 of 300 cells, or 11.3 points.

| Rank | Cause | Lost cells | Points (gross) | Evidence |
|---|---|---|---|---|
| 1 | **Alias blindness.** gbrain does not know an account's nickname or its owner-based name, so agents miss the records filed under them and answer with an earlier or superseded value. | 20 of the 25 lost H1 to H4 cells that were not turn-cap stops (H2 11, H4 10, H3 3, H1 1 in the 25); 4 of the 25 saw every needed document and still answered wrong | about 6.7 (ceiling) | See the four points below. Autoplan re-check (`rca4.py`): in those 20 cells the unseen needed documents used the nickname (13 cells), the owner phrase (6) or the code (6); some cells had more than one. |
| 1b | **Memory across sessions (H5).** The 7 H5 cells first counted under rank 1 are memory tasks with no document evidence. Most misses are merge chains ("A now uses B's discount code", then B's code is corrected) that the agent must compose from facts saved with `remember`; 19% of all `remember` calls failed with `invalid_params` (autoplan Eng correction: only 57 of 1,243, 4.6%, were the non-UUID `request_id` refusal; 177, 14.2%, were writes admitted and then failed with the opaque "The write did not commit. Inspect its durable request on the source host.", whose cause even `get_write_request` does not show; 146 of those carried no `request_id` at all, and most came from Sonnet 5.5 cells). | 9 (7 wrong value, 2 value in no document) | 3.0 | Autoplan re-check of the H5 transcripts; the report's target 3. |
| 2 | **Running out of turns on aggregation.** Search has no totals or exhaustion flag and defaults to 20 rows, so agents re-search instead of paging. `limit` is already honored (calls with `limit` 30, 50 or 100 returned that many rows); 30% of calls passed no limit and 99% of those returned exactly 20. | 20 (H1 11, H3 6, H4 2, H2 1) | 6.7 gross; turn-cap stops were 64 (gbrain) against 66 (fs) overall, so the net effect is smaller | Turn-capped gbrain cells averaged 41 searches. fs grep prints every match and a total; pg (68.3%) returns totals and an exhaustion flag. |
| 3 | **Auto-generated summaries outrank records.** | 3 of the cells above (H2) | ~1, inside rank 1 | Agent notes are 2.0% of the corpus and 2.4% of fs grep lines, but 5.1% to 5.6% of gbrain search rows (89% of them `weak_semantic`). Autoplan re-check: a wrong answer matched an agent note about the asked account in 3 lost cells (the draft said six). |
| 4 | Other | 1 | 0.3 | One incomplete H1 set (the two H5 cells moved to rank 1b). |
| 5 | **Not yet measured: degraded reranking.** Search carried a `rerank_failed` degraded notice in 230 of 300 gbrain cells. The notice is shown once per session and the reason (timeout, provider error or budget) was not recorded, so the per-call rate is unknown. | unknown | unknown | Measured in development before any paid cell (R0). |

Evidence for rank 1:

- **The card omits nicknames.** On the 431 `entity` cards agents opened for accounts, the account's nickname appeared in `aka` zero times. `ALIAS_DECLARATION` (`src/core/mentions/aliases.ts`) recognizes `account code`, `also known as`, `a.k.a.`, `aka`, `short name`, `ticker` and `code name`. It does not recognize "Nickname used by the team:" or "the team also calls it". Its capture is also one token, so it cannot hold a two-word nickname.
- **The alias lives on a different page from the card.** The account sheet (`accounts/x`) declares the nickname, but the card resolves to the CRM record (`crm/x`). These are two pages titled for the same account, not unified.
- **Owner-based names are not resolved at all.** A reference like "<manager>'s <segment> account" depends on who owned the account on that date. That ownership is stated in handoff notes and the CRM record.
- **The outcome.** Agents learned the nickname on 66% of account-cells with gbrain against 99% with fs. They queried it on 55% against 92%. On the cells gbrain lost, gbrain agents never saw 57% of the needed documents that use the nickname (fs: 19%) and 65% of those that use the owner phrase (fs: 41%). Documents that use the name or code were seen equally by both arms.
- **Autoplan re-check of the outcome numbers.** The script behind the bullet above is not beside the plan. A reproduction over every stored tool result (H2 to H4, the first four accounts of each task) gives: nickname seen in 86% of account-cells with gbrain against 99% with fs, and queried in 82% against 98%. On the 25 lost non-turn-cap H1 to H4 cells, gbrain never saw 39% of the needed nickname documents (18 of 46), 44% of the owner-phrase documents (7 of 16) and 20% of the code documents (6 of 30), against 6% of needed documents that use no alias (8 of 131). The direction holds; the size is smaller. Code-only misses in 3 cells show that a complete `aka` is not enough on its own: search has to use every alias too. The reproduction script ships beside the plan as `rca4.py`.
- **The account sheet was one step away.** 823 of the 973 found `entity` cards (85%) already listed the account sheet (`accounts/x`) as a `suggestions` runner-up; agents rarely opened it.

What is not the cause: harness errors (none), tool failures, context overflow (gbrain 0, fs 1), and startup cost (warm snapshots, 25 s per restore, excluded from agent time). gbrain was 2.5 times slower per cell (p50 170 s against 68 s). That costs wall-clock time, not accuracy, and is a separate item. Where gbrain won (20 cells, mostly H3 and H4), fs had run out of turns. Fable 5.1 is the extreme case: gbrain 65%, fs 20%.

## Goal and kill criterion

**Goal.** gbrain at or above fs on a fresh held-out Hard world, pooled over Opus 5.5, Sonnet 5.5 and GPT-6.1 Sol. Fable runs in smoke tests only.

**Kill criterion.** If the confirmation shows gbrain still behind fs (point estimate below 0), we publish that result as it is. We stop this wave's tuning and do not run another round on the same tasks.

## Fixes (all gbrain product changes, one batched gbrain PR)

Nothing changes in the tasks, grading, turn cap, tool limits or any arm's settings. A harness change ships only if it applies to every arm and is justified by itself.

### F1. Every name an entity goes by (cause 1, expected +2 to +4 points)

1. **Declared-alias grammar.** Widen it to the common ways people write an alias, as listed in the grammar spec committed before development (see "Accepted review requirements"; autoplan removed the draft's phrase list because two of its phrases came from the main generator). Names of up to 4 words are captured when quoted, or unquoted after a label or cue: a run of capitalized or code tokens that ends at punctuation, a lowercase word or the end of the line.

   Keep the existing precedence: frontmatter, then declared, then subject. Keep the collision guard: a derived alias never answers for another live page's exact title. Add tests with placeholder names.
2. **One identity per real-world entity.** When two linkable pages' title subjects normalize to the same name in the same source (`Account sheet: X` and `CRM record: X`), treat them as one identity. The card's `aka` then carries the aliases declared on either page, and `referenced_by` counts mentions of any alias. Autoplan decision (taste, provisional): do this as a read-time sibling merge on the card and in search, not by writing `entity_identities` rows or turning on `entity_identity.union`. That table is manual-only by design (#4224: a wrong merge silently corrupts retrieval) and its union is off by default; the benchmark must run gbrain's defaults, so whatever ships here is on for every user. The sibling rule: same source, exact normalized subject, both pages of a linkable entity type, different title prefixes, neither page excluded by `mentions.exclude_slugs`; the card lists the merged pages as `identity_siblings`; config `mentions.sibling_merge` (default on) turns it off. Both CEO voices recommend against any union on title alone (user challenge UC1 at the final gate); until Garry decides, this item stands as the draft's direction with the safeguards in the accepted requirements.
3. **Owner-based references.** Autoplan correction: no current extractor produces owner or handoff facts from page text; the facts pipeline is an LLM turn extractor and is not run on imported pages. This item is new work, so the plan's fallback applies (taste, provisional): ship items 1, 2 and 4 now and put owner phrases behind a measured follow-up. The deferred design was: The card gains `known_as` rows with each owner phrase's validity window: "Dana Example's freight account", valid 2025-03 to 2025-09. The mention index then links documents that use the phrase within that window. This is general to CRMs and support desks, where people say "Dana's account".
4. **Card and tool text.** The card states what `aka` covers (declarations gbrain recognized on the listed pages, never a claim that the list is complete), points to `identity_excerpt` for other names, and tells the agent to search every alias before answering a history or as-of question. This must fit the served-tool budgets in `test/mcp-schema-budget.test.ts`: 25,000 model-visible characters and 26,700 JSON characters for the starter list (26,679 at last measure), and per-tool budgets (`entity` 470, `search` 1,670). There is almost no headroom, so this guidance goes in the card payload, not in tool descriptions.

### F2. Totals and exhaustive paging (cause 2, expected 0 to +2 points)

Autoplan correction: `search` already honors `limit` (at least 100) and `offset`; what agents lack is a count. Keyword matching for remote MCP callers is only reachable through the operator setting `search.mcp_keyword_only`, so a keyword-mode-only change would not reach the agent. The default `search` path reports `keyword_total` and `keyword_truncated` for keyword (full-text) matches, labelled in model-visible text as a count of keyword matches beside top-K rows, and a remote-safe per-call option `match: "keyword"` returns keyword matches with `total`, `truncated` and `next`, the same paging words `get_backlinks` uses (autoplan DX naming) (keyword matching costs less than hybrid, so allowing it remotely does not raise spend). Hybrid rows still say they are top-K and that coverage is not proven. `entity` → `referenced_by` already pages, and gains a total for every alias (F1).

### F3. Provenance-aware ranking (cause 3, expected 0 to +1 point)

Pages a machine wrote, either authored by an agent (`author: agent:*`) or typed as an auto-summary, rank below primary records for the same entity. Both Eng voices found that nothing in gbrain stamps or reads `author: agent:*` (it is the generator's convention) and recommend demoting only on gbrain-owned markers (`dream_generated: true`, `type: extract_receipt`) unless `agent:` is first documented as a gbrain convention (user challenge UC4 at the final gate; the draft's direction stands until Garry decides). Under the gbrain-owned triggers alone F3 would not touch the benchmark's agent notes, so its expected points would be 0. Their rows carry `provenance: generated`. This is general: summaries are not evidence. That principle is already in the `entity` description ("Previews are not evidence"). Measured on the Cat 40 v1 families too, so the change doesn't regress them.

### F4. Date honesty in search rows (preventive, no points claimed)

Search rows show `effective_date`, which is the page's document date, such as a contract's signing date. In 66% of amendment rows that date differs from the in-text "Effective YYYY-MM-DD". Default after autoplan CEO: add `page_date` beside `effective_date` and leave `effective_date` unchanged, so agents don't read it as the contract's effective date. Both DX voices recommend instead keeping `effective_date` as the one field, labelling it a document date in model-visible text and exposing the existing `effective_date_source` in lean rows, with no second date field (user challenge UC3 at the final gate; the draft asked for a rename to `page_date`, so its direction stands until Garry decides). The per-item analysis traced only one wrong answer to this.

### F5. Latency (no points claimed)

Profile why one gbrain cell takes 170 s against 68 s for fs, from the per-tool timings in the transcripts, and fix the top cost if it is in gbrain. This is reported, not gated. Autoplan evidence: per cell (median) model time is the same on both arms (61 s against 61 s) and gbrain's recorded tool time is 30 s against 1 s (search p50 888 ms, about 20 searches per cell). The rest of the 170 s is outside recorded model and tool time, so the profile starts there (process start, MCP round trips, write waits).

### F6. Write ids any agent can send (H5 friction, expected 0 to +1 point)

`remember` and the other write ops accept any opaque `request_id` an agent sends and map it to the canonical UUID, so a non-UUID id no longer costs a turn; responses keep `request_id` as the UUID (frozen `MEMORY_VERBS_v1` meaning) and echo the client's string as `client_request_id`. Details are in "Accepted review requirements".

**Expected total:** +2 to +8 points against an 11.3-point gap (autoplan revision after both CEO voices; the draft said +8 to +12): F1 +2 to +4, F2 0 to +2, F3 0 to +1, F6 with the R1 write-health fix 0 to +1. The ceilings behind it: alias blindness about 6.7 points gross (owner phrases, 6 of its 20 cells, are deferred), turn-cap losses 6.7 gross but roughly a wash net (64 against 66 stops, and gbrain's 20 wins were fs turn-cap losses), agent notes about 1, H5 memory 3. At the midpoint gbrain still trails by about 6 points, so the kill criterion is more likely than not to fire. That is why the kill criterion exists and why the confirmation spend is a decision (see Cost).

**Pending Garry (decided at the autoplan final gate; until then the default applies):**

| Item | Default until decided | Alternative both outside reviews or the gate offers |
|---|---|---|
| UC1 identity merge | read-time sibling merge with safeguards | no union on title alone; show siblings and excerpts only |
| UC2 confirmation endpoint | main seed primary, sealed secondary | sealed co-primary, or sealed-only |
| UC3 F4 date field | add `page_date` | one field, labelled, `effective_date_source` exposed |
| C4 owner phrases | deferred | build in this wave |
| C9 confirmation spend | authorized after the development record | unconditional |
| C16 gbrain-plus-fs arm | not run | run on development (about $45) |
| UC4 F3 trigger | `author: agent:*` or auto-summary types | only gbrain-owned markers unless `agent:` becomes a documented convention |

## Development and confirmation (no tuning on held-out data)

- **Development.** Use the calibration world (seed 20261005, 50k, frozen knobs), which gbrain never ran on. Run the gbrain arm on Sonnet 5.5 and Opus 5.5, 10 tasks per family, against the round-5 fs and pg cells already recorded on that world (Sonnet 5.5). Opus 5.5 has only 32 fs cells there (from the freeze check), so the missing Opus fs cells on the 50 development tasks run once (about $27) before the first gbrain round. Allow 2 to 3 rounds with a fresh slot build per gbrain change. Per-round cost is about $90 in cells and $14 in slots. Free checks first: the alias-coverage proxy (share of an account's nicknames on its card, and the share of needed documents reachable from card aliases) on the calibration world, and gbrain's unit and E2E gates.
- **Confirmation, preregistered before any cell.** Use a fresh main-generator seed (never generated before), 50k, frozen knobs, gbrain against fs, Opus 5.5, Sonnet 5.5 and GPT-6.1 Sol, 100 tasks, primary endpoint gbrain minus fs. **Plus the sealed variant at 50k** with the same arms and models. Its seed is on Garry's Mac and its documents are written in phrasings gbrain was never tuned on, so a fix that only matches the main generator's wording shows up there.
- **Fable.** A 5-cell smoke only.

## Cost

| Item | Estimate |
|---|---|
| Development, 3 rounds (cells and slot builds) | ~$320 |
| Development comparator: missing Opus 5.5 fs cells on the 50 development tasks | ~$27 |
| Development baseline: unchanged gbrain master on the 50 development tasks, Sonnet 5.5 | ~$31 |
| GPT-6.1 Sol slice (20 tasks) in the last development round | ~$15 |
| Cat 40 v1 no-regression run (gbrain arm, Sonnet 5.5) | ~$25 |
| Fable 5-cell smoke | ~$15 |
| Confirmation on a fresh main seed (gbrain and fs, 3 models, 100 tasks; 5 slot builds; oracle check of the fresh world) | ~$640 |
| Confirmation on the sealed variant (same shape; generated in owner custody on Garry's Mac) | ~$640 |
| Total | **~$1,715** (new authorization; the Hard ledger has $44 left) |

Autoplan cost basis: the held-out gbrain and fs cells on the three models cost $519 including the judge (ledger runs `…02-59-17…` and `…15-11-03…`, Fable's $601 removed), slot builds $14 for five, the oracle batch about $25; a 15% margin is added. The draft's $870 per confirmation had no stated basis. The sealed variant's documents differ, so its cost is an estimate on the same shape.

A cheaper variant drops the fresh main seed and confirms on the sealed set only, for about $1,075. An optional exploratory gbrain-plus-fs arm on the development world (Sonnet 5.5, about $45) is a taste decision at the gate.

## Shipping

- **gbrain.** One batched PR through GBRA-40 with F1 to F6 and the R0 fix if R0 triggers one. Register at start. Full gate (`ci:ubicloud`, `UBI_OWNER=gbra39`), PATCH version, CHANGELOG led by the measured result.
- **gbrain-evals.** The paired PR carries this plan, the root-cause scripts, the development record, the confirmation preregistration and the report. It names the gbrain PR, and the gbrain PR names it.
- **Drafts.** #76 and #77 stay drafts until the confirmation.

## Accepted review requirements (autoplan)

Each item below is a requirement with its verification. They refine F1 to F6, development and confirmation; where an item and the text above differ, the item governs.


<!-- autoplan-accepted:ceo -->
- R0, rerank health before paid cells: on the first calibration-world slot, record every `search` call's rerank outcome and reason (`fields: "full"` diagnostics or the rerank audit log) over a free replay of the development questions' first searches, and again during development round 1 at the run's real concurrency. If more than 5% of calls fail, find the cause (timeout, provider error, budget, concurrency). A gbrain cause (timeout too tight, no backoff or concurrency limit on provider calls) is fixed in gbrain in this wave and applies to every user; an environment cause (a provider rate limit on the run's keys) is recorded and not fixed by changing any arm's settings; report the before and after rate in the development record. Verify: the development record shows the rate, the reason histogram and, if fixed, a regression test for the failing condition.
- F1 grammar spec, written first: before any calibration document is read for this wave, commit a list of alias conventions drawn from real-world writing and record systems (prose cues such as "nicknamed", "goes by", "also called", "known internally as", "referred to as", "formerly", "trading as", "doing business as"; label and value forms in prose lines, Markdown tables and key-value blocks; quoted and parenthetical alternate names), with placeholder-name fixtures for each. The grammar implements that list, not phrases copied from either generator. Multi-word captures (up to 4 words; quoted, or unquoted after a label or cue as a run of capitalized or code tokens ending at punctuation, a lowercase word or the end of the line) pass `aliasRejection` and the gazetteer collision rules unchanged; a multi-word alias that equals another live page's title is dropped. Verify: unit tests per convention in `test/mentions-policy-aliases.test.ts`; negative tests that ordinary sentences ("the team calls it a success", "goes by the book") produce no alias; the spec's commit precedes the first development run.
- Sealed-set hygiene: the implementer and every development agent do not read `eval/generators/hard-sealed` or any sealed output; the development record states this. This plan quotes no sealed phrasing. Verify: the gbrain-evals PR description carries the statement and the grammar spec's commit date.
- F1.5 identity excerpt (phrasing-independent): the `entity` card carries `identity_excerpt`, lines of the card page and of each identity sibling, verbatim. On those pages a line qualifies, without needing the subject's name, when it matches the grammar, has a label and value shape (`Label: value`, a table row, a key-value line), or contains a capitalized multi-word run or an all-caps code token that is not the subject's own name. Order: grammar matches; then label and value lines whose value is name-like (a capitalized multi-word run or a code token that is not the subject, and not a number, date or amount); then other label and value lines; then the rest; each tier in page order; the excerpt can show owner and role lines but adds nothing to the mention index; public body only (`publicBody`: private takes and facts fences stripped), at most 600 characters per page and 1,200 per card, with the source slug per line. Verify: card tests where an unknown label carries the nickname (the line does not contain the subject's name) below at least 600 characters of ordinary fields, and the excerpt still shows it; private-fence and remote-caller tests show no private text; size-cap test.
- F1.6 fan-out over every alias: `withDeclaredNameFanOut` searches every alias of the entity the query names and of its siblings (frontmatter, declared, subject; codes included), not only the first declaration found in the top rows. The entity is found by passing the query's word n-grams of up to 4 tokens to the existing alias resolution (`resolveAliases`); an n-gram that maps to several slugs uses the highest-precedence slug and is skipped on a tie; with no hit it falls back to the current top-row declaration scan. Each fan-out query requires the alias and treats the query's other content terms as optional ranking terms. At most 4 alias queries of 5 rows each per call, chosen by origin precedence (frontmatter, declared, subject) and then by length, run in parallel as keyword-only queries (no embedding or rerank call), and each spliced row names the alias that found it (`matched_alias`). Verify: tests where the query names an account and documents use only its code or only its nickname, both returned, including a question with words the alias-only documents lack; every spliced row contains its `matched_alias`; a test that the extra queries stop at 4; latency recorded in the development record.
- F1.2 sibling merge rule (provisional taste decision; replaces turning on `entity_identity.union`): same source, exact normalized title subject, both pages of the same linkable entity type, different title prefixes, neither in `mentions.exclude_slugs`, for untrusted callers neither page private (the private-page predicate applies to siblings), not a person type (people are never merged by this rule), at most 3 pages per merged group (a larger group merges nothing and is reported by `extract mentions --explain`); no rows written to `entity_identities`; `mentions.sibling_merge` (default on) disables it. The card lists `identity_siblings`; `aka` and `referenced_by` cover the union; in search, sibling aliases feed the F1.6 fan-out. Verify: positive test (account sheet plus CRM record); negative tests (two people pages with the same name and the same prefix stay separate; two people pages with the same name and different prefixes stay separate; a four-page group merges nothing; a renamed account and its successor stay separate; a page excluded by `mentions.exclude_slugs` is not merged); config-off test.
- F1.3 deferral (provisional taste decision): owner-phrase resolution ships in a follow-up only after a measured design; this wave adds nothing to the mention index for owner phrases. Verify: TODOS entry in gbrain names the deferred design and its measurement gate.
- Deferred TODOS: gbrain TODOS gains two more entries, H5 merge-chain recall (recall follows "A uses B's code" redirections to B's current value) and notice hygiene for unattended agents (first-run ask and coaching notices on every session). Verify: both entries exist with context and a measurement gate.
- F2 on the default path: `total` is the count of distinct pages matching the strict full-text query of the existing keyword search (`engine.searchKeyword`, same semantics on PGLite and Postgres) under the call's filters, computed by a separate uncapped count and never from the OR-of-terms retry (`orFallback`) or the capped candidate pool; `has_more` is `total > offset + limit` on that match set; the default `search` response reports it with `has_more`, and a remote-safe per-call option (one new `search` param, paid for by trimming the `search` description so `test/mcp-schema-budget.test.ts` still passes) returns exact-token matches at page grain in a stable order (keyword score, then page id) with `next_offset`; its candidate pool is sized to cover `offset + limit`, so paging reaches every page `total` counts. `next_offset` is valid only with that option; fan-out rows and F3 demotion never change `total` or offsets. Hybrid rows keep saying they are top-K. Verify: the schema-budget test passes; a both-engines test pages past 3 × `limit` and recovers every page `total` reports; a query that only the OR retry would match reports `total: 0` with the option; tests on both engines for total, `has_more` and `next_offset` at page boundaries; a remote-caller test that the option is allowed and that `mode` stays local-only.
- F6 write ids: the shared `request_id` param and the persistence lookup (writes and the read paths: `get_write_request`, `list_write_requests`, `cancel_write_request`, status-only replays) accept any opaque client string of 8 to 128 printable characters and map a non-UUID to a deterministic UUIDv5 under a fixed gbrain namespace, so replays stay idempotent; a UUID passes through unchanged. The UUIDv5 uses one fixed namespace (no op name), so the read paths find a write by the client's original string; reuse of one string for a different write is rejected by the existing same-intent check. Verify: tests that the same non-UUID id replays to the same receipt and `get_write_request` finds it by the original string, reuse for a different intent is refused, two different ids never collide in the test set, and the error for empty or over-long ids names the limits.
- H1 mapping: the development record and the preregistration state that F2 (totals) and the excerpt are only a partial answer to preregistered decision sentence 3 (weakest family H1): H1 asks for dated ownership, which counts cannot establish and which the deferred owner-phrase work would supply. Development reports H1 completed tasks and H1 evidence coverage separately; F2 is called an H1 fix only if development shows H1 completions rising. Verify: both H1 measures are in the development record.
- Scope statement: this wave fixes document retrieval; memory correctness (H5 correction and redirect chains) is out of this wave except F6, and gets a funded follow-up with an acceptance gate (H5 completions on development data at or above fs). Verify: the gbrain TODOS entry for H5 merge chains carries that gate.
- Development comparators and checks: run the missing Opus 5.5 fs cells on the 50 development tasks once before the first gbrain round; run a Cat 40 v1 no-regression check with the gbrain arm on Sonnet 5.5 before merge; run the oracle on each fresh confirmation world and stop if it is below 95%. Verify: each result is in the development record with its ledger run id.
- Sealed logistics: the sealed confirmation world is generated and its slots built in owner custody (Garry's Mac or a machine he names); the preregistration records who runs it and where the outputs land, and sealed outputs never go to Capy Drive. Verify: the preregistration names the machine and the output path before any sealed cell.
- Upgrade path: the grammar and sibling changes bump `ALIAS_DERIVATION_VERSION` and `MENTION_EXTRACTOR_VERSION`, so existing brains re-derive aliases and rescan mentions on their next `gbrain extract --stale`, and `gbrain post-upgrade` prints the existing catch-up `[AGENT]` block. Verify: an upgrade test on a brain built at the previous versions shows the new aliases after one stale sweep.
- F3 scope: a page counts as machine-written when its frontmatter `author` starts with `agent:`, it has `dream_generated: true`, or its type is `extract_receipt`; it is demoted only when a primary record about the same entity matches the same query, and facts saved with `remember` or pages recording a correction are never demoted. Verify: ranking tests for each trigger, for a human-authored page that stays put, for a generated page with no competing primary record that stays put, and for an agent-recorded correction that outranks the obsolete original.
- F4 and F5 scope: F4 stays additive pending the DX phase decision on its shape; F5 is profiling plus at most one fix that lands before development round 1, so this PR's own code does not change after the last development round. Verify: the development record names the F5 change, or none.
- Development baseline and stopping rule: round 0 runs unchanged gbrain master on the 50 development tasks (Sonnet 5.5) so each fix's effect is measured against it, and the free proxy measures the identity excerpt alone before the grammar, so the record shows what each piece adds. Development stops after round 3, or earlier once the alias-coverage proxy reaches 95% of nicknames reachable from the card and the pooled Sonnet 5.5 and Opus 5.5 development estimate is at least +3 points over fs (a buffer for regression to the mean after tuning on the same 50 tasks). If development ends below that, the memo to Garry says the confirmation is expected to trigger the kill. The last development round adds a 20-task GPT-6.1 Sol slice. Verify: the development record shows the baseline, which condition stopped development and the GPT slice.
- Sibling-merge firing check (free, before round 1): on the calibration slot, report the number of merged sibling groups and their page types beside the alias-coverage proxy; zero groups on account pages stops development until explained. Verify: the count is in the development record.
- Spend authorization: development spend (about $433 with comparator, baseline, GPT slice, v1 run and smoke) and confirmation spend (about $1,280) are authorized separately; confirmation spend is authorized after Garry reads the development record. Verify: the preregistration cites that authorization.
- Publication language (preregistered): "parity" is used only when the primary interval's lower bound is above −3 points; otherwise the report says "not distinguishable" with the point estimate. A claim of general reliability (beyond the main generator's wording) needs the sealed estimate at 0 or more as well. The report also gives cost per successful task, wrong-answer rate and median seconds per cell for each arm. Verify: the preregistration carries this language.
- R0 and the published result: if R0 finds an environment cause above 5%, the published held-out report gets a dated caveat in the same gbrain-evals PR. Verify: the caveat is in the report's changelog.
- Real-brain precision check before merge: alias derivation and the sibling rule run on at least one real brain the owner names (counts and a hand-labeled 50-alias sample only, in owner custody) and on a public prose corpus; multi-word captures ship on by default only at 90% precision or better, otherwise that capture is left out of this wave (not shipped default-off and then switched on for the benchmark). Verify: the counts and precision are in the development record.
- Caps are visible: when fan-out stops at 4 aliases or a sibling group exceeds the cap, the response says so (`fanout_truncated`, `siblings_capped`); fixtures cover many aliases, cross-source look-alikes and growing page groups. Verify: tests for each flag.
- Kill consequence: before any confirmation cell, Garry records what a kill means for gbrain's docs and roadmap; the preregistration carries it. Verify: the preregistration has the statement.
- F5 target: median seconds per cell on the development world is reported against a 120-second target, and F1.6's added latency per search call is reported; neither gates merge. Verify: both numbers in the development record and the CHANGELOG.
- Confirmation rule (preregistered): the build is the gbrain branch merged with current master at a pinned SHA recorded in the preregistration. Primary endpoint: the fresh main seed, pooled gbrain minus fs over the three models; "at or above" means a point estimate of 0 or more, and below 0 triggers the kill criterion. The sealed variant is secondary: its point estimate and interval are published beside the primary; a sealed estimate below 0 when the main one is 0 or more is reported as "parity on the main generator's wording only". Under the sealed-only variant the sealed set is primary. User challenge UC2 (final gate) may make the sealed set co-primary; until Garry decides, the draft's main-seed primary stands. Verify: the preregistration states all three rules before any confirmation cell.
- Evidence scripts: `rca4.py` ships beside the plan; the development record reports its output next to `rca.py` to `rca3.py`.
<!-- /autoplan-accepted:ceo -->

<!-- autoplan-accepted:dx -->
- Search counts, names and visibility (replaces, in the CEO F2 requirement, the names `total`, `has_more`, `next_offset`, the phrase "exact-token" and "one new `search` param"): default hybrid responses carry `keyword_total` and `keyword_truncated`, counting distinct pages that match the strict full-text query of `engine.searchKeyword` (never the OR retry or the capped pool), and every such call adds one model-visible line after the rows saying the rows are top-K and the count covers keyword matches only; the remote-safe option is `match` with values `hybrid` (default) and `keyword`; with `match: "keyword"` the response carries `total`, `truncated` and `next` (a ready-to-send argument object), the words `get_backlinks` already uses; `next` is absent outside keyword mode and a `next` or `offset` from a hybrid call is refused with a fix naming `match: "keyword"`. Counts and paging are computed after deduplication and evidence delivery: a page dropped to fit a token budget is listed by slug in `omitted`, never skipped by the offset. The exact description string for `match` is in the PR and `test/mcp-schema-budget.test.ts` passes. Verify: MCP-dispatch tests that read only model-visible content (no `_meta`), on empty results, small token budgets, oversized pages and repeated chunks; a keyword walk that recovers every page `total` reports.
- Lean rows keep the new fields: `matched_alias`, `provenance` and `effective_date_source` survive the default lean projection (`src/core/search/lean-rows.ts`). `provenance` appears only on machine-written rows, with the value `generated`. Verify: lean-row tests for each field and for its absence on ordinary rows.
- Card guidance: the card says search already covers the listed aliases (rows carry `matched_alias`) and asks the agent to search only names that appear in `identity_excerpt` or in `fanout.aliases_skipped`; the guidance appears only when `aka`, siblings or the excerpt are non-empty; on a surface without `search` (the `verbs` surface) it names `requires_surface: "starter"` instead of a tool the caller lacks. Verify: card tests on `starter` and `verbs` surfaces and on an entity with no aliases.
- Structured fan-out and sibling fields (replaces the CEO flags `fanout_truncated` and `siblings_capped`): search meta and, when truncated, the model-visible line carry `fanout: {resolved_entity, aliases_searched, aliases_skipped, truncated}`; the card carries `identity_siblings: {pages, capped}`, and `capped` comes with the operator-contract fix block naming `gbrain extract mentions --explain <slug>` (`tell_user_to_run` for remote callers); `aka` stays a string array (frozen) and a parallel `aka_sources` maps each entry to its origin and source slug; a truncated excerpt lists the slugs it omitted. Verify: tests for each field, for skipped aliases being searchable by the agent, and for the frozen `aka` type.
- Version-aware coverage: mention coverage counts a page as pending when its stored mention or alias version is behind the binary's, whatever its `updated_at` (today `readMentionCoverage` only checks pages written since the last count), so cards and searches carry the existing `mention_index` notice until the sweep finishes; `gbrain post-upgrade` prints an ETA measured on the 55k calibration brain. Verify: tests immediately after a version bump on an unchanged brain, during an interrupted sweep and after it resumes.
- Rerank notice: the `degraded_recall` notice for `rerank_failed` carries the reason (timeout, provider error, budget or concurrency), the number of degraded calls this session and the fallback used, with `fix.next` per reason under the operator contract; the per-call response meta records the degradation without `fields: "full"`. Verify: notice tests per reason.
- F6 contract (refines the CEO F6 requirement): responses keep `request_id` as the canonical UUID (its frozen `MEMORY_VERBS_v1` meaning) and add optional `client_request_id` with the string the client sent; lookups (`get_write_request`, `cancel_write_request`, `list_write_requests`, replays) accept either; normalization happens once at the operation boundary for write ops' `request_id` only (not administration writer or deactivation ids); printable means ASCII 0x21 to 0x7E; every description and message that says "UUID" for this param is updated (`WRITE_REQUEST_PARAM`, the `get_write_request` param, the required-id error, the `put_page` and `put_pages` descriptions, `MEMORY_VERBS_v1`), saying the id is optional and reused only to retry the same write; reuse for a different write returns `idempotency_conflict` with "this request_id was used for a different write; send a new one or omit it" and `fix.next: run`; the invalid-id error shows the limits, the actual length and a valid example. Development round 1 reports the conflict rate. Verify: MCP tests for a lost reply, a pending write, cancellation and different-intent reuse, each by original string and by UUID.
- Error copy: the PR carries the exact strings for the invalid `request_id` error, the reuse conflict, a `next` or offset sent outside keyword mode, a remote `mode` refusal that points to `match: "keyword"`, and an unavailable count (a degraded stage, never a wrong number); any new code is added to the `gbrain errors` catalogue. Verify: `gbrain errors <code>` prints each new code.
- Documentation: `docs/guides/entity-recall.md` gains a "How gbrain learns an alias" section with copy-paste examples (frontmatter aliases, prose cues, label and value lines, tables, quoting, what is rejected, the deny list); `docs/protocol/MEMORY_VERBS_v1.md` documents the new optional `entity` and `remember` fields; `docs/architecture/key-files/entity-recall.md` and the `aliases.ts` header are updated; `src/core/behavior-change-notice.ts` gains rows for the card shape, search counts, generated-page demotion, `request_id` acceptance and the sibling merge; the CHANGELOG has a "What changes for your agent" block with an example card; `bun run build:llms` runs. Verify: the docs checks in CI and a diff of `llms.txt`.
- Escape hatches: brain config `mentions.alias_deny` and page frontmatter `alias_deny:` remove derived aliases; `mentions.multiword_aliases` (default on) turns multi-word capture off; page frontmatter `identity: separate` keeps a page out of sibling merges; `search.alias_fanout_max` (default 4, 0 disables) and `search.demote_generated` (default on) control fan-out and demotion. The benchmark runs defaults. Verify: one test per switch.
- Explain: `gbrain extract mentions --explain <name|slug>` lists each alias with its origin and source line, each rejected candidate with its reason, and the sibling decision. Verify: explain tests for an accepted alias, a rejected one and a capped sibling group.
- DX measures in the development record: per arm, the share of account-cells where the agent saw and where it queried the nickname (`rca4.py`), tool calls from the question to the first alias query, the `remember` failure and conflict rates, and the share of tool results carrying notices; the confirmation report repeats the first two. Verify: the numbers are in the record.
- Evidence runbook: the plan directory gets a README with one command per `rca*.py` script, its inputs and the headline numbers it should print. Verify: running each command reproduces the numbers.
- DX TODOS: gbrain TODOS gains a document-retrieval onboarding walkthrough on the `starter` surface (the coding-agent tutorial registers `--surface verbs`, which has no `search`), and a timed fresh-install check ending at the first MCP write and read. Verify: both entries exist.
<!-- /autoplan-accepted:dx -->

<!-- autoplan-accepted:eng -->
- R1, write health before paid cells: reproduce the 177 admitted-then-failed `remember` writes from the held-out transcripts' arguments on a calibration-world slot (free; replaying stored arguments diagnoses a failure and tunes nothing), find the cause and fix it in gbrain in this wave; the failed receipt and the error carry the specific cause to remote callers (redacting only private content) instead of "Inspect its durable request on the source host". Verify: a regression test for the cause; the development record reports the `remember` failure rate before and after on the calibration slot.
- Same-subject names in the mention index: today `buildGazetteer` drops a subject alias claimed by two pages at the same origin (`alias_collision`, `src/core/by-mention.ts`), so documents that name an account only by its name link to neither the account sheet nor the CRM record. When a sibling group merges, the group is one gazetteer target (its card page, chosen as `buildEntityCard` chooses it) and the colliding subject alias is kept; affected pages rescan through the version bump. Verify: an end-to-end two-page shared-subject fixture where a document that names only the subject appears in the card's `referenced_by`.
- Fan-out resolution (refines the CEO F1.6 requirement): a tie between pages of one sibling group resolves to the group instead of being skipped; exact page titles resolve as well as alias rows; `case_sensitive` aliases match only as written; the longest n-gram match wins and shorter n-grams inside it are dropped; fan-out fires only for capitalized or code-shaped n-grams or an n-gram that resolves to exactly one entity; spliced rows are capped at 8 per call. "Alias required, other terms ranking only" is a new engine method on both engines (required alias phrase with escaping for codes and punctuation, ranking against the other terms), not four ordinary keyword calls; each alias's 5-row truncation is reported in `fanout`, and the card says aliases were queried, not that all evidence was retrieved. On PGLite the alias queries run in one call when four separate calls exceed 150 ms at p50 on the calibration slot. Verify: tests that a lowercase common word does not trigger fan-out, that a sibling tie fans out, that spliced rows stop at 8, and both-engine parity tests for the new method.
- Keyword mode implementation (refines the DX search requirement): `match: "keyword"` uses a dedicated page-grain query (best chunk per page before pagination, no global chunk cap) with a keyset cursor (score, page id) inside `next`; any offset path is capped at 10,000; diversity pruning is off in keyword mode; page enumeration is separate from evidence expansion, so every enumerated page keeps a row (with `evidence_omitted: true` when its text did not fit) and `next` continues after the last enumerated page. The strict-match count runs in parallel with a statement timeout, is capped (`LIMIT 10001`, shown as "10000+"), and shares one WHERE builder with the row query (visibility, safe projections, CJK handling); a timeout yields the unavailable-count degraded stage. This replaces the DX wording "counts and paging are computed after deduplication and evidence delivery". Verify: both-engine tests with a dominant page of hundreds of matching chunks followed by many pages, a short-oversized-short sequence, mixed types, a write landing mid-walk, and a remote caller paging to the cap.
- Coverage cost and invalidation (refines the DX version-aware coverage requirement): on a version bump, `mention_index_status.pending` is set once to the source's eligible page count and decremented by the sweep, so card reads stay O(1); alias staleness counts only linkable entity pages; the policy fingerprint includes `mentions.alias_deny`, `mentions.multiword_aliases` and `mentions.sibling_merge`, so changing them marks affected pages due; autopilot and `post-upgrade` start the sweep. Verify: upgrade test with no manual sweep, a settings-change test on an indexed brain, an interrupted-sweep test, and a re-enable-denied-alias test.
- F6 storage and compatibility (refines the CEO and DX F6 requirements): `client_request_id` is stored durably outside the intent digest (a nullable column on `persistence_requests`, a migration whose number is taken when the PR is next to merge, and a graduation-inventory column entry), kept through receipt compaction and projection; `remember(items)` keeps deriving child ids from the original root string (`childRequestId` in `src/core/remember-batch.ts`), so a batch accepted before the upgrade replays to the same receipts; `remember` keeps its frozen error shape (`invalid_params` with additive `write_error: idempotency_conflict`); the minimum id length is 1, because the held-out transcripts show no id reuse for a different write (0 of 31 cells with writes) and no id shorter than 8 characters. Verify: tests for restart, compaction, cancellation, cross-principal independence, an uppercase UUID passing unchanged, and an old non-UUID batch replayed after upgrade by original and canonical ids.
- F3 classifier and stage (applies whichever trigger set UC4 settles): demotion is a score factor in the same stage as source boosts, before reranking and before the result pool is cut; "same entity" means the generated row and a primary row in the pool link to, or were fanned out from, the same resolved entity page; with no resolved entity nothing moves; "correction" means a page whose facts fence or frontmatter records a supersession, and such pages are never demoted. Verify: tests for multi-entity pages, generated pages holding corrections, healthy and degraded reranking, and a primary record near the pool cutoff.
- Excerpt sanitization (refines the CEO F1.5 requirement): the excerpt is cut from the canonical remote-sanitized body (`src/core/remote-body.ts`), which also drops forgotten facts, not from `publicBody`. Verify: forgotten-fact and malformed-fence fixtures.
- Grammar precision guards: an unquoted capture ends at a possessive `'s`, a capture followed by a possessive is rejected, and negative fixtures cover capitalized common words (weekdays, months, "the Board", "Finance", "Legal", "Q3 Plan") and a page that declares another entity's alias ("our competitor, also known as ..."). Verify: those fixtures.
- Precision gate statistics (replaces the CEO 50-alias, 90% rule): label at least 150 derived aliases on the real brain, or gate on a Wilson 95% lower bound of 85% or more. Verify: the labelled count and bound in the development record.
- Sibling-cap reporting: the firing check also reports the share of capped groups and their prefixes; more than 10% of account groups capped stops development until explained. Verify: the share is in the development record.
- Sibling privacy: a remote-caller test shows a private sibling's declared alias in none of `matched_alias`, `fanout`, `aka_sources`, `identity_excerpt` or `keyword_total`; the `hybridSearchCached` key includes caller visibility or fan-out bypasses the cache for remote callers; text inside private takes or facts fences is not counted in `keyword_total`. Verify: those tests.
- Development gate (refines the CEO stopping rule): the primary development gate is the mechanism proxies (nickname seen and queried, share of needed documents seen, alias-coverage proxy) plus no family regressing against round 0; the pooled cell estimate (+3 buffer) is reported as a sanity check with its interval, and the memo says plainly that 100 paired cells cannot separate +3 from noise. Verify: the record shows the proxies, per-family results and the interval.
- Build attribution (refines the CEO confirmation rule): master is merged into the branch before the final development round, and that exact build, pinned by SHA, runs confirmation; any later product change needs a new development round before confirmation. Verify: the preregistration names the SHA used in both.
- Merge gates for every user: `gbrain eval brainbench --compare evals/brainbench/baselines/main.json` (deterministic, free) holds or improves, with any drop justified in the PR (`docs/eval/BRAINBENCH.md` merge rule), and the retrieval canary `gbrain eval gate` runs on a non-production brain, both recorded in the PR next to the Cat 40 v1 no-regression run, which must include family B (the existing fan-out moves from hybrid to keyword). Verify: the numbers in the PR.
- Delivery shape: one batched PR as the house rule requires, with each F item, R0 and R1 in its own commit carrying its own tests, so one item can be reverted alone. Verify: the commit list.
- F5 order: before profiling gbrain, the development record times MCP process start, the default `wait_ms` on writes and the model's retries per cell. Verify: those three numbers in the record.
- TODOS to file in gbrain (this review did not edit gbrain): owner-phrase resolution with validity windows; H5 merge-chain recall with its acceptance gate; notice hygiene for unattended agents; opt-in LLM alias extraction; a scale-ladder eval above 200k documents (gbrain-evals); a `starter`-surface onboarding walkthrough; a timed fresh-install check; a read-only alias preview before an upgrade. Verify: the PR description lists them as filed.
<!-- /autoplan-accepted:eng -->
## Review record

Autoplan run 2026-10-07 by GBRA-39's review subagent (Capy, Claude Opus 5.5 host), gstack v1.91.12.0 (an upgrade to v1.91.33.0 was offered by the preamble and deferred: no human answers mid-run, and the installed checkout is not changed without an explicit upgrade). Telemetry stays off (the one-time prompt was not answered on the user's behalf). Restore point: `~/.gstack/projects/garrytan-gbrain-evals/plan-cat40-hard-fix-autoplan-restore-20261007-193754.md`. The only structural edit before review was adding the `## Implementation plan` heading the autoplan tooling requires; the original text is at commit c481e44.

Scope detection: UI scope no (no view or rendering terms). DX scope yes (`dxRequired: true`, 13 term matches: endpoint 1, flag 2, agent 10; the plan also changes MCP tool output and descriptions, and an AI agent is the primary user of those tools). Phases: CEO, DX, Eng; Design skipped (no UI scope; a skip, not a completed review).

Outside voice: the Codex CLI is installed and authenticated (`codex-cli 0.160.0`, preflight `CODEX_MODE: ready`), so Codex runs as the outside voice in every phase. No substitute model was needed.

Evidence base for this review (free, no model calls): the three draft scripts were re-run and reproduce their printed numbers; `rca4.py` (new, beside the plan) re-checks the alias, H5, agent-note, search-limit, `remember`, notice and latency claims over every stored tool result; gbrain was read at origin/master `2eb9df1c1` (v0.60.103.0), the held-out run used `c5fb0201d` (v0.60.95.0).

Sealed-variant handling: at the parent's request this review read `eval/generators/hard-sealed` on `feat/cat40-hard-sealed` (via `git show`) to judge whether F1 generalizes. The finding is recorded only at the level needed for that judgment, and no sealed phrasing is quoted anywhere in this plan. The generator code was already readable on that branch; the seed stays in owner custody.

### Phase 1: CEO review (SELECTIVE EXPANSION, autoplan override)

Methodology: `plan-ceo-review/SKILL.md` plus `sections/review-sections.md`, read in full from the autoplan methodology export (2,550 lines, ranges 1-600, 601-1200, 1201-1800, 1801-2400, 2401-2550, through EOF). Skip-listed sections were loaded, not executed.

**System audit.** gbrain-evals is on `plan/cat40-hard-fix` (c481e44), clean, on top of master e06ad6a. Related in-flight work: drafts #76 and #77 (the Hard report and the sealed variant) stay drafts until confirmation. gbrain master already carries two earlier Cat 40 fixes in the same area: the declared-name fan-out in `src/core/ops/search.ts` (`withDeclaredNameFanOut`, family B) and saved facts in search (`matchingSavedFacts`). Both are reused, not rebuilt. No design doc exists for this branch; the plan itself is the problem statement. No prior CEO plans, learnings or handoff notes for this project slug.

**Taste calibration.** Good references: `src/core/mentions/aliases.ts` (one shared parser for search and the mention pass, precedence and collision guards), `src/core/mentions/referrers.ts` (one referrer query behind `referenced_by` and `get_backlinks`). Pattern to avoid: adding a per-benchmark keyword list to `ALIAS_DECLARATION` without a generality test.

**Landscape check.** Web search was not used: the question is internal (why this product lost to grep on this corpus), and the evidence is the run data. Layer 3 (first principles): grep wins here because its output shows the declaring sentence verbatim and the agent reads it; any parser gbrain writes is a narrower channel than the raw text. That points at showing declaring text, not only parsing it.

#### 0A. Premise challenge

| # | Premise in the draft | Finding | Disposition |
|---|---|---|---|
| P1 | Alias blindness caused 31 lost cells (10.3 points). | 7 of the 31 are H5 memory cells with no document evidence; their misses are merge chains over saved facts and `remember` write errors. Of the 25 lost non-turn-cap H1 to H4 cells, 20 had unseen alias documents (nickname 13, owner phrase 6, code 6) and 4 saw everything. Alias blindness is about 20 cells, 6.7 points, as a ceiling. | Corrected in the root-cause table (rank 1, new rank 1b). |
| P2 | The card omits nicknames, so agents believe they have every alias; learned 66% against 99%, queried 55% against 92%. | Zero nicknames in `aka` is confirmed. The 66/55 figures could not be reproduced (their script is not beside the plan); over every stored result the figures are 86/82 against 99/98. 85% of found cards already listed the account sheet as a suggestion. Code-only misses show a complete `aka` is not sufficient. | Kept with a re-check bullet; search must use every alias (accepted item). |
| P3 | Search stops at 20 rows; F2 adds `limit` up to 100. | `limit` and `offset` already work; 20 is the default. Keyword mode is operator-only for remote callers. | F2 corrected: totals on the default path plus a remote-safe exact option. |
| P4 | gbrain already extracts owner and handoff facts. | False: the facts extractor is an LLM turn extractor not run on imported pages; no owner or handoff extractor exists. | F1.3 is new work; deferred per the draft's own fallback (taste). |
| P5 | Turn on `entity_identity.union` for same-subject pages. | The identity table is manual-only by documented design and its union is off by default; the benchmark must use defaults, so this would be on for every user and would write identity rows by heuristic. | Read-time sibling merge instead (taste). |
| P6 | Tool-text ceiling is 26,450 characters. | The guards are 25,000 model-visible and 26,700 JSON characters (26,679 measured), with per-tool budgets. | Corrected; guidance goes in the card payload. |
| P7 | Agent notes reached six lost answers; +1 to +2 points. | 3 lost cells. | F3 expected 0 to +1. |
| P8 | Expected total +8 to +12; parity plausible. | Ceilings sum to about 17 gross but net recovery is lower; +4 to +10 is the honest range. | Corrected. |
| P9 | The calibration world has the comparators development needs. | Sonnet 5.5 fs and pg yes; Opus 5.5 fs only 32 of 50 tasks. | Missing Opus fs cells run once (~$27). |
| P10 | F1's grammar list generalizes. | Checked against the sealed generator: the draft's keyword list would match none of its nickname declarations and few of its code declarations, because the sealed documents declare names in a different structure. A grammar tuned to the main generator would show nothing on the sealed check. | Generator-independent grammar spec plus a phrasing-independent card excerpt (accepted items). |
| P11 | Nothing else in the run explains the gap. | Not established: search carried a `rerank_failed` notice in 230 of 300 gbrain cells (reason and per-call rate unrecorded); 19% of `remember` calls failed on a non-UUID `request_id`; an "ask the user" first-run notice rode on 498 tool results. | R0 measurement and F6 added; notices deferred (no causal evidence). |

The real problem is that gbrain hides or omits the sentences that tell an agent what else an account is called, and gives no count when the agent enumerates. The plan solves that pain directly, not a proxy, once corrected. Do-nothing cost: the published recommendation stays "use files, not gbrain" for multi-account work on large corpora, which is gbrain's core use case.

#### 0B. Existing code leverage

| Sub-problem | Existing code | Plan reuse |
|---|---|---|
| Declared aliases | `src/core/mentions/aliases.ts` (`ALIAS_DECLARATION`, `declaredNames`, `deriveEntityAliases`, `aliasRejection`) | Extend the grammar in place; search's `aliasDeclarations` and the mention pass share it. |
| Alias precedence and collisions | `readAliases` in `src/core/search/read-enrichment.ts`; `buildGazetteer` in `src/core/by-mention.ts` | Unchanged guards; multi-word aliases go through the same collision rules. |
| Card | `src/core/verbs/entity-card.ts` (`buildEntityCard`, `assembleCard`, `cardReferences`) | Sibling merge and identity excerpt are added here. |
| Referrers | `src/core/mentions/referrers.ts` (already unions identity co-members under the flag) | Sibling slugs feed the same target set. |
| Alias search | `withDeclaredNameFanOut` and `DeclarationMemo` in `src/core/ops/search.ts` | Widen from the first declaration to every alias, bounded. |
| Identity groups | `src/core/entity-identity.ts`, migration v137 | Not used for automatic merges (manual-only posture kept). |
| Totals | `searchKeyword` limit and offset; `get_backlinks` paging with `total` | Add counts to the default `search` response. |
| Provenance | `stampUnverifiedExtractions`, source boosts (`src/core/search/source-boost.ts`) | F3 reuses the boost path. |
| Write ids | `src/core/persistence/digest.ts`, `src/core/persistence/preconditions.ts` | F6 changes validation in one place. |

#### 0C. Dream state

```
  CURRENT STATE                         THIS PLAN                                   12-MONTH IDEAL
  card = one page's aliases;      --->  card merges same-subject pages, shows  ---> gbrain resolves every name, code and
  search fans out on 1 alias;           the declaring text, search fans out on      role-based reference to one entity with
  no counts; owner phrases              every alias, counts on enumeration,         time windows, and answers "all records
  unresolved; H5 writes fail 19%        lenient write ids; owner phrases later      about X" with a proven-complete set
```

#### 0D. Approach alternatives for F1 (the decision that sets the wave's ceiling)

- A) Draft as written: widen the keyword list, auto-union same-name pages via `entity_identity.union`, owner-phrase facts. Effort M, risk high (generator-shaped grammar, default-on identity heuristic, new extractor).
- B) Smallest change: card lists siblings and their aliases; no grammar change. Effort S, risk low; leaves search and mention links blind.
- C) Chosen: a generator-independent grammar spec (written before calibration), a read-time sibling merge, a verbatim identity excerpt on the card, and fan-out over every alias; owner phrases deferred. Effort M, risk medium, covers both the main and sealed phrasing families because the excerpt does not depend on parsing.

Principle P1 (completeness) picks C over B; P5 (explicit) and the safety posture of #4224 pick C over A.

#### 0E. Mode

SELECTIVE EXPANSION (autoplan override; the plan adds capability to an existing system). Planned changed files, estimated: 12 to 16 in gbrain (aliases, by-mention, entity-card, referrers, search op, search meta, persistence digest and preconditions, source boost, tool descriptions, tests, docs) and 6 in gbrain-evals.

#### 0F/0G. Cherry-picks (SELECTIVE EXPANSION ceremony, auto-decided)

HOLD checks: complexity is about 14 files and no new service, acceptable for one batched wave; the minimum set that reaches the goal is F1 items 1, 2, 4 plus fan-out, F2, F6 and R0; F4 and F5 are deferrable without blocking the goal but are cheap and were requested, so they stay.

| # | Proposal | Effort | Decision | Reasoning |
|---|---|---|---|---|
| E1 | Identity excerpt on the card: the declaring lines of the card page and its siblings, verbatim, bounded | S | ACCEPTED (P1, P2) | Phrasing-independent; the only F1 piece that survives a wording change; in blast radius (`entity-card.ts`). |
| E2 | Fan-out over every alias, not only the first declaration | S | ACCEPTED (P2) | Code-only misses happened with the code on the card; same function. |
| E3 | F6: accept any opaque `request_id` (map to a UUIDv5) instead of refusing | S | ACCEPTED (P2) | 19% of `remember` calls failed; general DX; one validator. |
| E4 | R0: measure rerank failures and their reason on the calibration slot before paid cells | S | ACCEPTED (P1) | Possible cause found in the data; free. |
| E5 | Notice hygiene (first-run ask and coaching notices on unattended agents) | M | DEFERRED to TODOS (P3) | No causal link to wrong answers; product-wide UX change. |
| E6 | Owner-phrase resolution with validity windows (draft F1.3) | L | DEFERRED (taste, see ledger C4) | New extractor; generator-shaped risk; the draft's own fallback. |
| E7 | H5 merge-chain help (recall follows "uses B's code" redirections) | M | DEFERRED to TODOS (P3) | Real cause for about 2 points but needs its own design; F6 covers the cheap part. |
| E8 | Delight: `entity` card states `aka_complete_for: declared` and which pages were merged | S | ACCEPTED (part of F1.4) | Tells the agent what the card does and does not cover. |
| E9 | Delight: search response names the alias that produced each fan-out row | S | ACCEPTED (part of E2) | Explains why a row with another name is there. |

#### Decision ledger (CEO)

| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |
|---|---|---|---|---|---|
| C1 GBRA-39 | Root-cause table and expected points (`rca4.py`) | draft table | corrected table, +4 to +10 | approved | autoplan auto-decision, mechanical (facts) |
| C2 GBRA-39 | F1.1 generality (sealed check) | keyword list | pre-registered grammar spec + E1 | approved | auto-decision P1/P2 |
| C3 GBRA-39 | F1.2 identity merge (#4224) | default-on union | read-time sibling merge | approved (provisional) | auto-decision P5 on mechanism; reopened as UC1 by both voices |
| C4 GBRA-39 | F1.3 owner phrases | build now | defer behind measured follow-up | approved (provisional) | TASTE, surfaced at the gate |
| C5 GBRA-39 | F2 mechanism (`search` op) | keyword-mode totals, limit 100 | default-path totals + remote-safe exact option | approved | auto-decision, mechanical (feasibility) |
| C6 GBRA-39 | E1 to E4, E8, E9 | absent | added | approved | auto-decision P2 (in blast radius, under a day each) |
| C7 GBRA-39 | E5, E7 | absent | TODOS | deferred | auto-decision P3 |
| C8 GBRA-39 | Cost table (ledger) | $2,060 | $1,670 with basis | approved | auto-decision, mechanical (facts) |
| C9 Garry | Confirmation spend: unconditional (draft) or a preregistered development gate | unconditional | keep unconditional | approved (provisional) | TASTE, surfaced at the gate |
| C10 GBRA-39 | Development comparators and oracle check | Sonnet only | Opus fs completed; oracle on fresh worlds | approved | auto-decision P1 |
| C11 GBRA-39 | Expected points after both voices | +4 to +10 | +2 to +8 (F1 +2 to +4, F2 0 to +2) | approved | auto-decision, mechanical (both voices; evidence) |
| C12 GBRA-39 | Publication language and reliability claim | point estimate only | non-inferiority wording (lower bound above −3), sealed needed for a general claim, cost per success and wrong-answer rate reported | approved | auto-decision P1 (both voices) |
| C13 GBRA-39 | Development baseline, stopping buffer, GPT slice | none | round 0 unchanged master; +3 buffer; 20-task GPT slice | approved | auto-decision P1 (both voices) |
| C14 GBRA-39 | F3 scope | all generated pages demoted | only when a primary record for the same entity matches; corrections never demoted | approved | auto-decision P5 (both voices) |
| C15 GBRA-39 | Ship F6 alone now (native voice) | batched | stays in the batched wave PR | declined | house rule (one batched PR; F6 is not master-red or security) |
| C16 Garry | Exploratory gbrain-plus-fs arm, about $45 | absent | add on the development world | pending | TASTE, surfaced at the gate |
| C17 GBRA-39 | Real-brain precision check for multi-word captures | none | 90% precision or the capture is left out | approved | auto-decision P1 (both voices) |
| C18 GBRA-39 | H5 memory scope | unstated | wave = document retrieval; H5 follow-up with acceptance gate | approved | auto-decision P3 (both voices) |
| UC1 Garry | F1.2 identity merge by title subject | draft: auto-union same-name pages (C3 kept it as a read-time union) | both voices: no union on title alone; show siblings and their excerpts, union only with corroborating evidence, real-brain precision check | pending | USER CHALLENGE, final gate; the draft's direction stands until Garry decides |
| UC2 Garry | Confirmation endpoint | draft: main seed primary, sealed alongside | both voices: the sealed set must pass too (co-primary), or sealed-only primary | pending | USER CHALLENGE, final gate; the draft's direction stands until Garry decides |

#### 0H. CEO plan and spec review

CEO scope summary: `~/.gstack/projects/garrytan-gbrain-evals/ceo-plans/2026-10-07-cat40-hard-fix.md`.

Spec review loop (three launches, the cap; Claude Opus 5.5 subagent on the shared machine, read-only): round 1 FAIL 6/10 (26 issues), round 2 FAIL 7/10 (11 issues), round 3 FAIL 8/10 (4 issues: F2 `total` definition, the candidate-pool limit on exact-token paging, fan-out rows that might not contain their alias, one stale summary phrase). Every issue was fixed in the working plan; the round-3 fixes were applied after the last launch and are not reviewer-confirmed. The reviewer's development go/no-go concern was settled by the separate authorization of confirmation spend. Metrics appended to `~/.gstack/analytics/spec-review.jsonl` (iterations 3, found 41, fixed 37, remaining 4, score 8). Scope-document approval: auto-approved under /autoplan (A).

#### 0I. Temporal interrogation

```
  HOUR 1 (foundations):  read aliases.ts, by-mention.ts, entity-card.ts, referrers.ts; write the grammar spec
                         from real-world conventions BEFORE looking at any calibration document; R0 on a slot
  HOUR 2-3 (core):       grammar + multi-word capture through aliasRejection and the gazetteer collision rules;
                         sibling resolution query shared by card and search; excerpt bounds
  HOUR 4-5 (integration):fan-out over all aliases without blowing the result budget; totals on the default
                         path; F6 validator; MENTION_EXTRACTOR_VERSION and ALIAS_DERIVATION_VERSION bumps
  HOUR 6+ (tests/polish):schema-budget test headroom; PGLite and Postgres parity; v1 no-regression run;
                         the alias-coverage proxy on the calibration world
```
Effort: human team about 6 to 8 days; CC plus gstack about 6 to 8 hours of build plus slot builds (83 to 90 minutes each).

#### CEO dual voices

Both voices reviewed the amended Implementation plan at SHA-256 `3e1f5301…cc21695` (fresh snapshot after the spec loop). The Codex job started while the native subagent was still running; both finished, and the native result was consumed first.

**Native CEO voice** (Claude Opus 5.5 subagent, completed; INPUT line matched the snapshot hash). Findings, condensed with severities as given: card completeness rather than grammar is the root problem, so the phrasing-independent pieces should lead (high); gbrain may be better positioned beside grep than against it, add a gbrain-plus-fs arm (high); F2's points double-count the turn-cap wash (high); F1's points rest on the corrected, smaller evidence (high); R0 could change how the published result reads (high); the development stopping rule cannot separate signal from noise on 50 tasks (medium); GPT-6.1 Sol absent from development (medium); the main seed is wording-contaminated, make the sealed set co-primary (critical); default-on sibling merge and multi-word capture need a real-brain precision check (high); latency is the adoption problem (high); ship F6 now (high); define what a kill means for the product (medium); parity wording needs a non-inferiority margin (medium); alternatives: inline the runner-up sibling, opt-in LLM alias extraction, narrow F3 (medium). Recommendation: proceed with development, fund confirmation only with the sealed set co-primary and after a real-brain precision check.

**Codex CEO voice** (codex-cli 0.160.0, model `gpt-6-astra`, reasoning high; completed, `OUTSIDE_STATUS: completed provider=codex host=claude`). Full output:

```tool-output
1. **High — Parity is an experiment outcome, not an adoption case.** Matching files would still leave users with roughly 2.5× slower responses and additional indexing and maintenance. The lower per-task dollar cost is a possible advantage, but the plan never identifies a workflow where that tradeoff wins. Its own expected improvement also falls short of closing the gap. **Fix:** name the target workflow and define acceptable latency, cost per successful task, and wrong-answer rate. Separate useful remediation from evidence that customers should adopt gbrain. [Benchmark evidence](/workspace/gbrain-evals/docs/benchmarks/2026-10-07-model-ladder-hard.md)

2. **High — Read-time merging still turns an identity guess into authoritative retrieval.** Same source, type, and normalized title do not establish that two organizations or accounts are identical. Different prefixes and a three-page cap do not supply the missing evidence. Avoiding writes to `entity_identities` does not prevent mixed aliases and references from producing confident wrong answers. The existing implementation explicitly says titles can collide and explains why automatic identity merging is unsafe. **Fix:** require corroborating identity evidence, such as a shared stable account identifier. Otherwise expose candidate pages and their excerpts without unioning their identities. [Existing identity contract](/workspace/gbrain/src/core/entity-identity.ts:4)

3. **High — Document totals are being mistaken for a solution to aggregation.** H1 requires answers such as how many accounts someone owned **on a particular date**. Counting matching pages does not establish the account set, reconcile handoffs, or reconstruct historical ownership. Some H1 questions name no account, so account-name fan-out cannot initiate discovery. The stored results show only 5/60 H1 successes for gbrain versus 16/60 for files. **Fix:** make a development demonstration of complete candidate discovery and dated ownership resolution a prerequisite for calling F2 the answer to H1. Measure completed H1 tasks and evidence coverage, not merely correct pagination. [Task definitions](/workspace/gbrain-evals/eval/reports/cat40/hard-holdout/50k/world.json)

4. **High — The implementation portfolio is more certain than the causal evidence.** Missing alias documents establish a retrieval failure, not how many answers these fixes recover. Reranking degraded in 230/300 sessions, yet its contribution remains unknown. The historical result also measures `c5fb0201d`, while implementation starts from a newer product revision; there is no explicit unchanged-product development baseline. R0 measures health but does not isolate its effect on task success. **Fix:** reserve the first development measurements for the pinned, unchanged product and a small comparison of candidate fixes. Let those results determine which changes survive into the single batched PR. Keep all such work on development data.

5. **High — The success rule permits an unreliable product to “win.”** A pooled point estimate of zero does not establish parity within a useful uncertainty bound. Gains on one model or family can conceal losses elsewhere. More seriously, the main generator can pass while the sealed variant fails, with only a wording qualification. Disclosure makes that result honest; it does not justify general defaults. **Fix:** separate publication from product promotion. Preregister a practical noninferiority margin, task-clustered uncertainty, material regression limits, and a requirement for sealed transfer before claiming general reliability. An inconclusive result can be published and the wave stopped without another tuning round.

6. **High — The memory product’s distinguishing capability remains a TODO.** Accepting opaque write IDs removes friction, but does not solve the reported case where all facts were recorded and recall still returned superseded or neighboring values. Correction chains and redirected references are central to useful memory. Deferring them while funding speculative ranking gains prioritizes easier benchmark mechanics over the product promise. **Fix:** move a bounded correction-and-redirect recall case ahead of low-confidence ranking work, or explicitly constrain this wave to document retrieval and give memory correctness a funded follow-up with an acceptance gate. [Recorded H5 failure](/workspace/gbrain-evals/docs/benchmarks/2026-10-07-model-ladder-hard.md)

7. **Medium — Machine authorship is being used as a substitute for authority.** An agent-written record can preserve an authoritative user correction; a human-written record can be stale. Blanket demotion risks making an agent memory system distrust its own useful records. The supporting script only checks whether a wrong answer appears in an agent note somewhere in the corpus; it does not establish that the agent retrieved or relied on that note. **Fix:** establish actual exposure and influence before attributing these failures to summaries. Base authority on supporting sources, corrections, and validity, with regression cases where an agent-recorded correction outranks an obsolete original. [Attribution logic](/home/user/.capy/work/evals-plan/docs/plans/2026-10-07-cat40-hard-fix/rca4.py:44)

8. **Medium — Wording diversity does not establish structural portability.** The sealed variant tests phrasing transfer, but this design also assumes matching title subjects, same-source identity, short capitalized aliases, and very small sibling groups. A fourth sibling disables merging entirely; “every alias” search actually stops at four queries. Those boundaries matter as real accounts accumulate records. **Fix:** add independent development fixtures for ambiguous identities, cross-source records, numerous aliases, and growing page groups. Require visible coverage limits and predictable behavior when caps are reached.

Recommendation: Revise before implementation because the current success rule can reward benchmark parity while automatic identity merging and unresolved aggregation and memory semantics leave product reliability unproven.
```

CEO DUAL VOICES — CONSENSUS TABLE:

| Dimension | Claude (native) | Codex | Consensus |
|---|---|---|---|
| 1. Premises valid? | partly: F1/F2 points overstated, contamination | partly: causal evidence thinner than the portfolio | CONFIRMED (both: not fully valid) |
| 2. Right problem to solve? | yes, reframed as "show evidence and completeness" | yes for retrieval, but adoption case unnamed | CONFIRMED (right problem, needs framing) |
| 3. Scope calibration correct? | no: default-on merge and grammar need precision gates | no: title merge unsafe, H5 deferred behind ranking | CONFIRMED (both: recalibrate) |
| 4. Alternatives sufficiently explored? | no: runner-up inline, LLM extraction | no: corroborated identity, unchanged baseline | CONFIRMED (both: no) |
| 5. Competitive/market risks covered? | no: grep improves with each model | no: parity is not an adoption case | CONFIRMED (both: no) |
| 6. 6-month trajectory sound? | at risk: main-seed win on contaminated wording | at risk: success rule can reward benchmark parity | CONFIRMED (both: at risk) |

CONFIRMED means both completed reviews reached the same conclusion on that dimension. Native findings stay separate where Codex did not raise them (gbrain-plus-fs arm, GPT slice, latency target, LLM extraction); Codex-only findings: H1 needs dated ownership, unchanged-product baseline, structural portability fixtures. No single-voice critical remains unhandled: the native critical (contamination) became UC2.

**Outside findings integrated** (each against the code and the run data):

| Finding | Source | Evidence check | Disposition |
|---|---|---|---|
| Title-subject merge is unsafe without corroboration | both | `entity-identity.ts:4-16` says titles collide and auto-merge is unsafe | UC1 (user challenge; the draft wanted union) |
| Sealed must pass for success | both | the draft names only a main-seed endpoint | UC2 (user challenge) plus C12 publication language (auto) |
| Expected points too high | both | `rca4.py`; turn-cap stops 64 against 66 | C11, +2 to +8 |
| F2 is not an H1 fix by itself | Codex (native: double-count) | H1-01 asks owner on a date; gbrain 5/60 H1 against fs 16/60 | H1 mapping rewritten; F2 claimed for H1 only if development shows it |
| Unchanged-product baseline and ablation | Codex (native: stopping noise) | held-out ran `c5fb0201d`, development starts from newer master | C13 |
| F3 authorship is not authority | both | rca4 counts notes in the corpus; 2 of the 3 notes were seen | C14 |
| H5 memory deferred behind ranking | both | report target 3; H5 transcripts | C18 scope statement and gated follow-up |
| Caps and portability | Codex | 4-alias and 3-page caps | caps made visible, fixtures added |
| Ship F6 alone | native | house rule: one batched PR | C15 declined |
| gbrain-plus-fs arm | native | adds an arm, not a change to existing arms | C16 taste |
| Real-brain precision gate | both (native explicit, Codex via corroboration) | collision guard only blocks exact titles | C17 |
| R0 caveat on the published report | native | 230 of 300 cells | accepted |
| Latency target, adoption metrics | both | 170 s against 68 s | F5 target reported; cost per success and wrong-answer rate in the report |

#### CEO review sections

**Current scope (Section 1 preamble).** Mode SELECTIVE EXPANSION (autoplan override). Accepted: C1, C2, C5, C6, C8, C10 and the spec-review fixes; provisional taste: C3 (sibling merge), C4 (defer owner phrases), C9 (confirmation authorized after the development record); deferred: E5, E6, E7.

**Section 1: Architecture.** Findings: 3 (all decided).

```
                 MCP agent
                    |
     +--------------+---------------+------------------+
     | entity                       | search            | remember / write ops
     v                              v                   v
 buildEntityCard               search op            request_id param (F6)
   | resolve slug                |  hybridSearchCached      | opaque -> UUIDv5 (fixed ns)
   | NEW siblingsOf(subject) <---+-- NEW resolveQueryEntity  v
   |   (page_aliases origin=subject,  (n-grams -> resolveAliases)   persistence journal
   |    same type, not person, <=3)   |                              (principal, request_id) unchanged
   | aka = union(page_aliases)        | NEW fan-out: <=4 aliases, keyword-only, parallel,
   | NEW identity_excerpt (publicBody)|      alias required, matched_alias on rows
   | referenced_by over union  ------>| NEW total/has_more: uncapped distinct-page count
   v   (referrers.ts target set)      | NEW exact-token option: page-grain paging
 card JSON                            v
                                 rows + meta
 aliases.ts grammar (spec) --> deriveEntityAliases --> page_aliases --> gazetteer (by-mention.ts) --> mention links
        ALIAS_DERIVATION_VERSION++ / MENTION_EXTRACTOR_VERSION++ --> extract --stale rescans existing brains
```

Data flows. Sibling merge: happy (two pages, one card); nil (no subject prefix: no siblings, card unchanged); empty (subject with only the card page: unchanged); error (sibling query fails: fail-soft to the single-page card, like every other card arm, with a `degraded` note naming `identity_siblings`). Fan-out: happy (alias rows spliced after the top two); nil (no entity in the query: current behavior); empty (alias queries return nothing: unchanged results); error (a failed alias query is dropped, like today's `catch { return results; }`). Totals: happy; empty (`total: 0`, `has_more: false`); error (count query fails: rows return without `total` and with a `degraded` stage, never a guessed number).

Coupling: card and search both call one new sibling resolver (one module, shared), the same way `declaredNames` is shared today. Scaling: the sibling lookup uses the existing `page_aliases` unique key `(source_id, alias_norm, slug, origin)`; fan-out adds at most 4 keyword queries per search; the uncapped count is one indexed full-text count per search with a total. At 10x pages the count query is the first cost; Eng sets a budget. Single points of failure: none new. Security architecture: no new endpoint; one new `search` param and new card fields, all read-scope. Rollback: `mentions.sibling_merge=false` turns the merge off without a deploy; anything else is a PR revert; the version bumps mean a revert also rescans, which on a 55k-page brain takes one stale sweep (Eng to time it).

Decisions: A1 the sibling resolver is one shared module (P4 DRY, mechanical); A2 fail-soft with a visible `degraded` stage on every new arm (P1, mechanical); A3 time the rescan cost of the version bumps on a 50k brain in development (P1, mechanical, added to Eng scope).

**Section 2: Error & Rescue Map.** 9 paths mapped, 1 gap (decided).

```
  CODEPATH                      | WHAT CAN GO WRONG                       | CLASS
  ------------------------------|-----------------------------------------|---------------------------
  siblingsOf                    | query fails; >3 pages share a subject    | SqlError; GroupTooLarge (no merge)
  identity_excerpt              | page body null; private fence            | empty excerpt; stripped
  alias grammar                 | catastrophic regex backtracking          | timeout (ReDoS)
  resolveQueryEntity            | alias maps to several slugs (tie)        | ambiguous -> skip
  fan-out alias query           | query fails / times out                  | SqlError; Timeout
  uncapped total                | count query slow / fails                 | Timeout; SqlError
  exact-token option paging     | offset beyond total                      | empty page, has_more false
  request_id mapping            | empty or >128 chars; reuse other intent  | invalid_params; idempotency_conflict
  rerank (R0)                   | timeout / provider error / budget        | RerankFailedReason
```

| Class | Rescued | Action | Agent sees |
|---|---|---|---|
| SqlError in siblingsOf | Y | single-page card | card plus `degraded` stage |
| GroupTooLarge | Y | no merge | card; `extract mentions --explain` names it |
| ReDoS timeout | GAP → decided | bounded quantifiers plus an adversarial-input test with a time bound, like `test/line-grammar.test.ts` | nothing (prevention) |
| ambiguous alias | Y | skip that n-gram | current results |
| fan-out failure | Y | drop that alias query | rows without it |
| count failure | Y | omit `total` | `degraded` stage, no guessed count |
| invalid id | Y | error naming 8 to 128 characters | actionable error with fix |
| idempotency_conflict | Y | existing error | existing fix text |
| rerank failure | Y (existing) | fused order | `degraded_recall` notice; R0 measures it |

Decision E1: the ReDoS guard and its test are required (P1, mechanical).

**Section 3: Security & Threat Model.** 3 findings, none high after mitigation. (1) Excerpt leaks private text: likelihood medium, impact high; mitigated by `publicBody` and by applying the private-page predicate to siblings for untrusted callers (added to the accepted requirement via Eng). (2) A sibling merge across a private and a public page could show a private page's slug: same predicate; test required. (3) F6 id mapping: the journal keys on `(principal_kind, principal_id, request_id)` (`src/core/persistence/journal.ts:103`), so a fixed namespace cannot collide across principals; no new secret. Prompt injection: the excerpt shows page text verbatim, which is already how search rows work and is covered by the served instructions' rule 3 (retrieved content is data). No new dependency.

**Section 4: Data Flow & Interaction Edge Cases.** 6 edge cases mapped, 0 unhandled after the decisions above. Shadow paths: a subject that differs only by case or punctuation (normalized by `normalizeAlias`); a renamed account (old and new titles differ: no merge, by test); two accounts whose names normalize equal but differ (same type and different prefixes would merge: guarded by the 3-page cap only, so Eng adds a test with two distinct accounts sharing a name across a sheet and a record, where the merge is expected and documented); an alias that equals a common word (blocked by `aliasRejection` generic-token rule); a query naming two entities (n-gram lookup resolves both; the 4-query cap is shared); an agent paging with `next_offset` while pages change (stable order by score then page id; a page added mid-walk may be skipped, documented as "coverage at read time"). Async ordering: the mention pass already publishes only when source generations and page revisions are unchanged (`pass.ts`), and the new derivation runs inside it, so no new race.

**Section 5: Code Quality.** 2 findings. (1) F1.4 guidance must live in the card payload, not descriptions (already decided, budget evidence). (2) The fan-out today has one code path for "first declaration"; widening it must replace that path, not add a second (P4, mechanical).

**Section 6: Test Review.** Diagram:

```
  NEW BEHAVIOR                         | TYPE        | HAPPY                    | FAILURE                      | EDGE
  -------------------------------------|-------------|--------------------------|------------------------------|-------------------------------
  grammar conventions                  | unit        | each convention          | ordinary sentences, no alias | 4-word cap, ReDoS input
  sibling merge                        | unit+E2E    | sheet + record           | query error -> single card   | people, 4-page group, private
  identity_excerpt                     | unit        | unknown label, deep line | null body                    | caps, private fence, remote
  fan-out                              | unit+E2E    | code-only, nickname-only | failed alias query           | tie, 4-query cap, matched_alias
  totals + exact option                | E2E (both)  | total, has_more          | count failure                | past 3x limit, OR-only query
  request_id mapping                   | unit+E2E    | replay, read by string   | empty / long id              | other intent refused
  version bumps                        | E2E         | old brain re-derives     | —                            | revert rescans
  benchmark-level                      | eval        | alias proxy, merge count | v1 no-regression             | dev rounds, confirmation
```

The 2am-Friday test: the alias-coverage proxy plus the sibling-merge count on the calibration slot, both free. The hostile-QA test: two different customers whose names normalize equal. Flakiness: none time-based; the paging test must fix the corpus. Prompt changes: the served instructions are not changed; tool descriptions change only within budget.

**Section 7: Performance.** 2 findings. (1) Fan-out multiplies search work by up to 5; keyword-only and parallel keeps it near one hybrid call (decided). (2) The uncapped count can be slow on big brains; Eng sets a time budget and falls back to omitting `total` with a `degraded` stage (decided in Section 2).

**Section 8: Observability.** 2 gaps (decided). The search response meta records `fanout_aliases` and `sibling_slugs` so a wrong merge or a noisy fan-out is visible from one call; `extract mentions --explain` reports sibling groups and why a group was not merged. Rerank outcome and reason are recorded per call in the development record (R0).

**Section 9: Deployment & Rollout.** 3 risks. (1) Version bumps trigger a full rescan on every existing brain; `post-upgrade` prints the existing catch-up block, and Eng times it on 50k pages. (2) Default-on merge for every user: the config switch and the `identity_siblings` field make it visible and reversible. (3) The measured build must be the merged, pinned SHA (decided in the confirmation rule). No migration is needed (no schema change) unless Eng decides to persist sibling groups; then it needs a graduation inventory row.

**Section 10: Long-term trajectory.** Reversibility 4/5 (config switch and revert; rescans are the cost). Debt: an owner-phrase follow-up and H5 merge chains (TODOS). The sibling resolver is the natural home for later identity work (the 12-month ideal). Rejected expansions are not load-bearing for accepted ones: the excerpt carries owner lines to the agent without the deferred extractor.

**Section 11: Design.** SKIPPED (no UI scope).

#### CEO required outputs

**NOT in scope.** Deferred (to gbrain TODOS): owner-phrase resolution with validity windows (C4, taste: new extractor, generality risk); H5 merge-chain recall (C18: needs its own design; gated follow-up); notice hygiene for unattended agents (no causal evidence); opt-in LLM alias extraction at ingest (native voice; needs cost and quality measurement); a scale-ladder eval above 200k documents (native voice; gbrain-evals follow-up). Rejected: shipping F6 alone ahead of the wave (house rule, C15); turning on `entity_identity.union` or writing identity rows by heuristic (P5 and #4224); reporting the benchmark with any option switched on that is off by default (house rule).

**What already exists.** See 0B: the alias parser, precedence and collision guards, the card, the referrer query, the declared-name fan-out, saved facts in search, keyword search with limit and offset, the identity table (manual), source boosts, the write journal keyed by principal. The plan reuses every one; the only new module is the sibling resolver.

**Dream state delta.** After this wave gbrain shows an entity's other names verbatim from every page about it, searches under each of them, and counts enumerations. Still missing against the 12-month ideal: role-based and time-windowed references (owner phrases), corroborated identity across sources, memory that composes corrections and redirects, and proven-complete "all records about X" answers.

**Error & Rescue Registry.** As mapped in Section 2: 9 codepaths, 9 exception classes, 1 gap (regex backtracking) closed by a required bounded-quantifier design and a time-bounded adversarial test.

**Failure Modes Registry.**

| Codepath | Failure mode | Rescued | Test | Agent sees | Logged |
|---|---|---|---|---|---|
| siblingsOf | wrong merge of two real entities | N (by design: prevention) | Y (negative fixtures) | merged card, `identity_siblings` listed | meta `sibling_slugs` |
| siblingsOf | query error | Y | Y | single-page card, `degraded` | Y |
| identity_excerpt | private text shown | Y (`publicBody`, private predicate) | Y | nothing private | n/a |
| grammar | false multi-word alias in prose | partial (precision gate C17) | Y | extra `aka` entry, extra fan-out | `extract mentions --explain` |
| grammar | regex backtracking | Y (design) | Y | nothing | n/a |
| fan-out | alias query fails | Y | Y | rows without that alias | meta `fanout_aliases` |
| fan-out | cap reached | Y | Y | `fanout_truncated` | Y |
| totals | count query slow or fails | Y | Y | no `total`, `degraded` | Y |
| exact paging | pages added during a walk | documented | Y | coverage at read time | n/a |
| request_id | reuse for a different intent | Y | Y | `idempotency_conflict` with fix | Y |
| rerank | provider failure | Y (existing fused order) | R0 | `degraded_recall` | R0 record |
| version bump | long rescan on big brains | Y (stale sweep, catch-up notice) | timed in development | `mention_index` pending notice | Y |

CRITICAL GAPS: 0 (the wrong-merge row is not silent: the card names merged pages, and UC1 may remove the merge).

**Scope expansion decisions.** Accepted: E1, E2, E3, E4, E8, E9 and the voice-driven requirements C11 to C14, C17, C18. Deferred: E5, E6, E7, LLM alias extraction, scale ladder. Skipped: none. Pending at the gate: C16 (gbrain-plus-fs arm), UC1, UC2, C4, C9.

**Diagrams produced.** System architecture (Section 1), data flow with shadow paths (Section 1 and 4, in prose and the diagram), error flow (Section 2 tables), test coverage (Section 6). State machine: none needed (no new stateful object; the sibling merge is read-time). Deployment sequence and rollback: Section 9 and Section 1 rollback note. Stale diagram audit: the ASCII diagrams in files this plan touches are the module comments in `src/core/mentions/aliases.ts` and `entity-recall.md`; both list the alias keywords and must be updated with the grammar change (Eng task).

#### CEO implementation tasks

- [ ] **T1 (P1, human: ~3h / CC: ~20min)** — eval — R0 rerank health on the calibration slot, idle and at run concurrency
  - Surfaced by: premise P11 — `rerank_failed` in 230 of 300 cells
  - Files: gbrain-evals development record; gbrain search diagnostics (read-only)
  - Verify: rate and reason histogram in the development record
- [ ] **T2 (P1, human: ~4h / CC: ~20min)** — gbrain mentions — commit the alias convention spec before reading calibration documents
  - Surfaced by: premise P10 — draft list matches the main generator only
  - Files: gbrain `docs/designs/` (new spec), `test/mentions-policy-aliases.test.ts`
  - Verify: spec commit precedes the first development run
- [ ] **T3 (P1, human: ~1d / CC: ~1h)** — gbrain mentions — grammar with multi-word capture, ReDoS guard, version bumps
  - Surfaced by: 0D option C, Section 2 gap
  - Files: `src/core/mentions/aliases.ts`, `src/core/mentions/pass.ts`, `src/core/by-mention.ts`, tests
  - Verify: convention, negative and adversarial tests; upgrade test after one stale sweep
- [ ] **T4 (P1, human: ~1d / CC: ~1h)** — gbrain card — identity excerpt and sibling resolver (UC1 decides union versus display)
  - Surfaced by: premise P5, E1
  - Files: `src/core/verbs/entity-card.ts`, new sibling resolver module, `src/core/mentions/referrers.ts`
  - Verify: excerpt and sibling tests, private-page tests
- [ ] **T5 (P1, human: ~6h / CC: ~40min)** — gbrain search — fan-out over every alias (keyword-only, parallel, alias required, `matched_alias`)
  - Surfaced by: E2 — code-only misses with the code on the card
  - Files: `src/core/ops/search.ts`, tests
  - Verify: code-only and nickname-only tests, cap test
- [ ] **T6 (P1, human: ~1d / CC: ~1h)** — gbrain search — `total`, `has_more`, exact-token option with page-grain paging, budget trim
  - Surfaced by: premise P3, spec review round 3
  - Files: `src/core/ops/search.ts`, `src/core/pglite-engine.ts`, `src/core/postgres-engine.ts`, `test/mcp-schema-budget.test.ts`
  - Verify: both-engine paging test past 3 × limit; schema-budget test
- [ ] **T7 (P1, human: ~3h / CC: ~20min)** — gbrain persistence — opaque `request_id` mapped to UUIDv5 on write and read paths
  - Surfaced by: premise P11 — 19% of `remember` calls failed
  - Files: `src/core/persistence/digest.ts`, `src/core/persistence/preconditions.ts`, journal callers, tests
  - Verify: replay, read-by-string and conflict tests
- [ ] **T8 (P2, human: ~3h / CC: ~20min)** — gbrain search — narrowed F3 demotion
  - Surfaced by: C14
  - Files: `src/core/search/source-boost.ts` or the ranking stage, tests
  - Verify: the five ranking tests in the accepted requirement
- [ ] **T9 (P1, human: ~4h / CC: ~30min)** — gbrain-evals — preregistration (confirmation rule, publication language, kill consequence, sealed custody, spend authorization)
  - Surfaced by: C12, UC2, spend authorization
  - Files: gbrain-evals `docs/benchmarks/cat40-hard/` preregistration addendum
  - Verify: committed before any confirmation cell
- [ ] **T10 (P2, human: ~2h / CC: ~15min)** — gbrain-evals — development record with baseline, proxy, merge count, precision check, GPT slice, latency
  - Surfaced by: C13, C17, F5 target
  - Files: gbrain-evals development record
  - Verify: every required number present with ledger run ids
- [ ] **T11 (P3, human: ~1h / CC: ~10min)** — gbrain TODOS — owner phrases, H5 merge chains (with gate), notice hygiene, LLM alias extraction
  - Surfaced by: NOT in scope
  - Files: gbrain `TODOS.md`
  - Verify: four entries with context and gates

#### CEO completion summary

```
  +====================================================================+
  |            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
  +====================================================================+
  | Mode selected        | SELECTIVE EXPANSION (autoplan override)     |
  | System Audit         | 2 earlier Cat 40 fixes reused; no design doc|
  | Step 0               | 11 premises checked, 9 corrected; option C  |
  | Section 1  (Arch)    | 3 issues found                              |
  | Section 2  (Errors)  | 9 error paths mapped, 1 GAP (closed)        |
  | Section 3  (Security)| 3 issues found, 0 High after mitigation     |
  | Section 4  (Data/UX) | 6 edge cases mapped, 0 unhandled            |
  | Section 5  (Quality) | 2 issues found                              |
  | Section 6  (Tests)   | Diagram produced, 0 gaps after decisions    |
  | Section 7  (Perf)    | 2 issues found                              |
  | Section 8  (Observ)  | 2 gaps found (decided)                      |
  | Section 9  (Deploy)  | 3 risks flagged                             |
  | Section 10 (Future)  | Reversibility: 4/5, debt items: 2           |
  | Section 11 (Design)  | SKIPPED (no UI scope)                       |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (8 items)                           |
  | What already exists  | written                                     |
  | Dream state delta    | written                                     |
  | Error/rescue registry| 9 rows, 0 CRITICAL GAPS                     |
  | Failure modes        | 12 total, 0 CRITICAL GAPS                   |
  | TODOS.md updates     | 4 items proposed (gbrain TODOS, in T11)     |
  | Scope proposals      | 9 proposed, 6 accepted                      |
  | CEO plan             | written (ceo-plans/2026-10-07-...md)        |
  | Outside voice        | codex: completed                            |
  | Lake Score           | N/A (no coverage-scored questions asked)    |
  | Diagrams produced    | 4 (architecture, data flow, error, tests)   |
  | Stale diagrams found | 2 (aliases.ts header, entity-recall.md)     |
  | Unresolved decisions | 5 (UC1, UC2, C4, C9, C16; at the gate)      |
  +====================================================================+
```

Unresolved decisions (held for the final gate, never silently defaulted): UC1 identity merge, UC2 confirmation endpoint, C4 owner-phrase deferral, C9 confirmation spend after the development record, C16 gbrain-plus-fs arm. The GSTACK REVIEW REPORT is written once, at the end of the plan, after the Eng phase, so it stays the last section.

#### CEO accepted obligations

<!-- autoplan-accepted:ceo -->
- R0, rerank health before paid cells: on the first calibration-world slot, record every `search` call's rerank outcome and reason (`fields: "full"` diagnostics or the rerank audit log) over a free replay of the development questions' first searches, and again during development round 1 at the run's real concurrency. If more than 5% of calls fail, find the cause (timeout, provider error, budget, concurrency). A gbrain cause (timeout too tight, no backoff or concurrency limit on provider calls) is fixed in gbrain in this wave and applies to every user; an environment cause (a provider rate limit on the run's keys) is recorded and not fixed by changing any arm's settings; report the before and after rate in the development record. Verify: the development record shows the rate, the reason histogram and, if fixed, a regression test for the failing condition.
- F1 grammar spec, written first: before any calibration document is read for this wave, commit a list of alias conventions drawn from real-world writing and record systems (prose cues such as "nicknamed", "goes by", "also called", "known internally as", "referred to as", "formerly", "trading as", "doing business as"; label and value forms in prose lines, Markdown tables and key-value blocks; quoted and parenthetical alternate names), with placeholder-name fixtures for each. The grammar implements that list, not phrases copied from either generator. Multi-word captures (up to 4 words; quoted, or unquoted after a label or cue as a run of capitalized or code tokens ending at punctuation, a lowercase word or the end of the line) pass `aliasRejection` and the gazetteer collision rules unchanged; a multi-word alias that equals another live page's title is dropped. Verify: unit tests per convention in `test/mentions-policy-aliases.test.ts`; negative tests that ordinary sentences ("the team calls it a success", "goes by the book") produce no alias; the spec's commit precedes the first development run.
- Sealed-set hygiene: the implementer and every development agent do not read `eval/generators/hard-sealed` or any sealed output; the development record states this. This plan quotes no sealed phrasing. Verify: the gbrain-evals PR description carries the statement and the grammar spec's commit date.
- F1.5 identity excerpt (phrasing-independent): the `entity` card carries `identity_excerpt`, lines of the card page and of each identity sibling, verbatim. On those pages a line qualifies, without needing the subject's name, when it matches the grammar, has a label and value shape (`Label: value`, a table row, a key-value line), or contains a capitalized multi-word run or an all-caps code token that is not the subject's own name. Order: grammar matches; then label and value lines whose value is name-like (a capitalized multi-word run or a code token that is not the subject, and not a number, date or amount); then other label and value lines; then the rest; each tier in page order; the excerpt can show owner and role lines but adds nothing to the mention index; public body only (`publicBody`: private takes and facts fences stripped), at most 600 characters per page and 1,200 per card, with the source slug per line. Verify: card tests where an unknown label carries the nickname (the line does not contain the subject's name) below at least 600 characters of ordinary fields, and the excerpt still shows it; private-fence and remote-caller tests show no private text; size-cap test.
- F1.6 fan-out over every alias: `withDeclaredNameFanOut` searches every alias of the entity the query names and of its siblings (frontmatter, declared, subject; codes included), not only the first declaration found in the top rows. The entity is found by passing the query's word n-grams of up to 4 tokens to the existing alias resolution (`resolveAliases`); an n-gram that maps to several slugs uses the highest-precedence slug and is skipped on a tie; with no hit it falls back to the current top-row declaration scan. Each fan-out query requires the alias and treats the query's other content terms as optional ranking terms. At most 4 alias queries of 5 rows each per call, chosen by origin precedence (frontmatter, declared, subject) and then by length, run in parallel as keyword-only queries (no embedding or rerank call), and each spliced row names the alias that found it (`matched_alias`). Verify: tests where the query names an account and documents use only its code or only its nickname, both returned, including a question with words the alias-only documents lack; every spliced row contains its `matched_alias`; a test that the extra queries stop at 4; latency recorded in the development record.
- F1.2 sibling merge rule (provisional taste decision; replaces turning on `entity_identity.union`): same source, exact normalized title subject, both pages of the same linkable entity type, different title prefixes, neither in `mentions.exclude_slugs`, for untrusted callers neither page private (the private-page predicate applies to siblings), not a person type (people are never merged by this rule), at most 3 pages per merged group (a larger group merges nothing and is reported by `extract mentions --explain`); no rows written to `entity_identities`; `mentions.sibling_merge` (default on) disables it. The card lists `identity_siblings`; `aka` and `referenced_by` cover the union; in search, sibling aliases feed the F1.6 fan-out. Verify: positive test (account sheet plus CRM record); negative tests (two people pages with the same name and the same prefix stay separate; two people pages with the same name and different prefixes stay separate; a four-page group merges nothing; a renamed account and its successor stay separate; a page excluded by `mentions.exclude_slugs` is not merged); config-off test.
- F1.3 deferral (provisional taste decision): owner-phrase resolution ships in a follow-up only after a measured design; this wave adds nothing to the mention index for owner phrases. Verify: TODOS entry in gbrain names the deferred design and its measurement gate.
- Deferred TODOS: gbrain TODOS gains two more entries, H5 merge-chain recall (recall follows "A uses B's code" redirections to B's current value) and notice hygiene for unattended agents (first-run ask and coaching notices on every session). Verify: both entries exist with context and a measurement gate.
- F2 on the default path: `total` is the count of distinct pages matching the strict full-text query of the existing keyword search (`engine.searchKeyword`, same semantics on PGLite and Postgres) under the call's filters, computed by a separate uncapped count and never from the OR-of-terms retry (`orFallback`) or the capped candidate pool; `has_more` is `total > offset + limit` on that match set; the default `search` response reports it with `has_more`, and a remote-safe per-call option (one new `search` param, paid for by trimming the `search` description so `test/mcp-schema-budget.test.ts` still passes) returns exact-token matches at page grain in a stable order (keyword score, then page id) with `next_offset`; its candidate pool is sized to cover `offset + limit`, so paging reaches every page `total` counts. `next_offset` is valid only with that option; fan-out rows and F3 demotion never change `total` or offsets. Hybrid rows keep saying they are top-K. Verify: the schema-budget test passes; a both-engines test pages past 3 × `limit` and recovers every page `total` reports; a query that only the OR retry would match reports `total: 0` with the option; tests on both engines for total, `has_more` and `next_offset` at page boundaries; a remote-caller test that the option is allowed and that `mode` stays local-only.
- F6 write ids: the shared `request_id` param and the persistence lookup (writes and the read paths: `get_write_request`, `list_write_requests`, `cancel_write_request`, status-only replays) accept any opaque client string of 8 to 128 printable characters and map a non-UUID to a deterministic UUIDv5 under a fixed gbrain namespace, so replays stay idempotent; a UUID passes through unchanged. The UUIDv5 uses one fixed namespace (no op name), so the read paths find a write by the client's original string; reuse of one string for a different write is rejected by the existing same-intent check. Verify: tests that the same non-UUID id replays to the same receipt and `get_write_request` finds it by the original string, reuse for a different intent is refused, two different ids never collide in the test set, and the error for empty or over-long ids names the limits.
- H1 mapping: the development record and the preregistration state that F2 (totals) and the excerpt are only a partial answer to preregistered decision sentence 3 (weakest family H1): H1 asks for dated ownership, which counts cannot establish and which the deferred owner-phrase work would supply. Development reports H1 completed tasks and H1 evidence coverage separately; F2 is called an H1 fix only if development shows H1 completions rising. Verify: both H1 measures are in the development record.
- Scope statement: this wave fixes document retrieval; memory correctness (H5 correction and redirect chains) is out of this wave except F6, and gets a funded follow-up with an acceptance gate (H5 completions on development data at or above fs). Verify: the gbrain TODOS entry for H5 merge chains carries that gate.
- Development comparators and checks: run the missing Opus 5.5 fs cells on the 50 development tasks once before the first gbrain round; run a Cat 40 v1 no-regression check with the gbrain arm on Sonnet 5.5 before merge; run the oracle on each fresh confirmation world and stop if it is below 95%. Verify: each result is in the development record with its ledger run id.
- Sealed logistics: the sealed confirmation world is generated and its slots built in owner custody (Garry's Mac or a machine he names); the preregistration records who runs it and where the outputs land, and sealed outputs never go to Capy Drive. Verify: the preregistration names the machine and the output path before any sealed cell.
- Upgrade path: the grammar and sibling changes bump `ALIAS_DERIVATION_VERSION` and `MENTION_EXTRACTOR_VERSION`, so existing brains re-derive aliases and rescan mentions on their next `gbrain extract --stale`, and `gbrain post-upgrade` prints the existing catch-up `[AGENT]` block. Verify: an upgrade test on a brain built at the previous versions shows the new aliases after one stale sweep.
- F3 scope: a page counts as machine-written when its frontmatter `author` starts with `agent:`, it has `dream_generated: true`, or its type is `extract_receipt`; it is demoted only when a primary record about the same entity matches the same query, and facts saved with `remember` or pages recording a correction are never demoted. Verify: ranking tests for each trigger, for a human-authored page that stays put, for a generated page with no competing primary record that stays put, and for an agent-recorded correction that outranks the obsolete original.
- F4 and F5 scope: F4 stays additive pending the DX phase decision on its shape; F5 is profiling plus at most one fix that lands before development round 1, so this PR's own code does not change after the last development round. Verify: the development record names the F5 change, or none.
- Development baseline and stopping rule: round 0 runs unchanged gbrain master on the 50 development tasks (Sonnet 5.5) so each fix's effect is measured against it, and the free proxy measures the identity excerpt alone before the grammar, so the record shows what each piece adds. Development stops after round 3, or earlier once the alias-coverage proxy reaches 95% of nicknames reachable from the card and the pooled Sonnet 5.5 and Opus 5.5 development estimate is at least +3 points over fs (a buffer for regression to the mean after tuning on the same 50 tasks). If development ends below that, the memo to Garry says the confirmation is expected to trigger the kill. The last development round adds a 20-task GPT-6.1 Sol slice. Verify: the development record shows the baseline, which condition stopped development and the GPT slice.
- Sibling-merge firing check (free, before round 1): on the calibration slot, report the number of merged sibling groups and their page types beside the alias-coverage proxy; zero groups on account pages stops development until explained. Verify: the count is in the development record.
- Spend authorization: development spend (about $433 with comparator, baseline, GPT slice, v1 run and smoke) and confirmation spend (about $1,280) are authorized separately; confirmation spend is authorized after Garry reads the development record. Verify: the preregistration cites that authorization.
- Publication language (preregistered): "parity" is used only when the primary interval's lower bound is above −3 points; otherwise the report says "not distinguishable" with the point estimate. A claim of general reliability (beyond the main generator's wording) needs the sealed estimate at 0 or more as well. The report also gives cost per successful task, wrong-answer rate and median seconds per cell for each arm. Verify: the preregistration carries this language.
- R0 and the published result: if R0 finds an environment cause above 5%, the published held-out report gets a dated caveat in the same gbrain-evals PR. Verify: the caveat is in the report's changelog.
- Real-brain precision check before merge: alias derivation and the sibling rule run on at least one real brain the owner names (counts and a hand-labeled 50-alias sample only, in owner custody) and on a public prose corpus; multi-word captures ship on by default only at 90% precision or better, otherwise that capture is left out of this wave (not shipped default-off and then switched on for the benchmark). Verify: the counts and precision are in the development record.
- Caps are visible: when fan-out stops at 4 aliases or a sibling group exceeds the cap, the response says so (`fanout_truncated`, `siblings_capped`); fixtures cover many aliases, cross-source look-alikes and growing page groups. Verify: tests for each flag.
- Kill consequence: before any confirmation cell, Garry records what a kill means for gbrain's docs and roadmap; the preregistration carries it. Verify: the preregistration has the statement.
- F5 target: median seconds per cell on the development world is reported against a 120-second target, and F1.6's added latency per search call is reported; neither gates merge. Verify: both numbers in the development record and the CHANGELOG.
- Confirmation rule (preregistered): the build is the gbrain branch merged with current master at a pinned SHA recorded in the preregistration. Primary endpoint: the fresh main seed, pooled gbrain minus fs over the three models; "at or above" means a point estimate of 0 or more, and below 0 triggers the kill criterion. The sealed variant is secondary: its point estimate and interval are published beside the primary; a sealed estimate below 0 when the main one is 0 or more is reported as "parity on the main generator's wording only". Under the sealed-only variant the sealed set is primary. User challenge UC2 (final gate) may make the sealed set co-primary; until Garry decides, the draft's main-seed primary stands. Verify: the preregistration states all three rules before any confirmation cell.
- Evidence scripts: `rca4.py` ships beside the plan; the development record reports its output next to `rca.py` to `rca3.py`.
<!-- /autoplan-accepted:ceo -->

#### CEO baseline edits (exact replacements applied to the plan body)

<!-- autoplan-baseline-edits:ceo {"sourceSha256":"9e8db22247efe6c7af8a891c98a760ad44764da2f8545ac0d6bbe521bfa096db","replacements":[{"oldText":"| 1 | **Alias blindness.** gbrain does not know an account's nickname or its owner-based name, so agents miss the records filed under them and answer with an earlier or superseded value. | 31 (H2 11, H4 10, H5 7, H3 3) | 10.3 | See the four points below. |","newText":"| 1 | **Alias blindness.** gbrain does not know an account's nickname or its owner-based name, so agents miss the records filed under them and answer with an earlier or superseded value. | 20 of the 25 lost H1 to H4 cells that were not turn-cap stops (H2 11, H4 10, H3 3, H1 1 in the 25); 4 of the 25 saw every needed document and still answered wrong | about 6.7 (ceiling) | See the four points below. Autoplan re-check (`rca4.py`): in those 20 cells the unseen needed documents used the nickname (13 cells), the owner phrase (6) or the code (6); some cells had more than one. |\n| 1b | **Memory across sessions (H5).** The 7 H5 cells first counted under rank 1 are memory tasks with no document evidence. Most misses are merge chains (\"A now uses B's discount code\", then B's code is corrected) that the agent must compose from facts saved with `remember`; 19% of all `remember` calls failed with `invalid_params` because `request_id` was not a UUID (27% in the lost H5 cells). | 9 (7 wrong value, 2 value in no document) | 3.0 | Autoplan re-check of the H5 transcripts; the report's target 3. |"},{"oldText":"| 2 | **Running out of turns on aggregation.** Search has no totals or exhaustion flag and stops at 20 rows, so agents re-search instead of paging. | 20 (H1 11, H3 6, H4 2, H2 1) | 6.7 | Turn-capped gbrain cells averaged 41 searches. 50% of all gbrain searches returned exactly the 20-row cap. fs grep prints every match and a total; pg (68.3%) returns totals and an exhaustion flag. |","newText":"| 2 | **Running out of turns on aggregation.** Search has no totals or exhaustion flag and defaults to 20 rows, so agents re-search instead of paging. `limit` is already honored (calls with `limit` 30, 50 or 100 returned that many rows); 30% of calls passed no limit and 99% of those returned exactly 20. | 20 (H1 11, H3 6, H4 2, H2 1) | 6.7 gross; turn-cap stops were 64 (gbrain) against 66 (fs) overall, so the net effect is smaller | Turn-capped gbrain cells averaged 41 searches. fs grep prints every match and a total; pg (68.3%) returns totals and an exhaustion flag. |"},{"oldText":"| 3 | **Auto-generated summaries outrank records.** | 6 of the 31 above (H2) | ~2, inside rank 1 | Agent notes are 2.0% of the corpus and 2.4% of fs grep lines, but 5.1% of gbrain search rows. Most of those come through vector matches (`weak_semantic`). Their wrong values reached six lost answers. |","newText":"| 3 | **Auto-generated summaries outrank records.** | 3 of the cells above (H2) | ~1, inside rank 1 | Agent notes are 2.0% of the corpus and 2.4% of fs grep lines, but 5.1% to 5.6% of gbrain search rows (89% of them `weak_semantic`). Autoplan re-check: a wrong answer matched an agent note about the asked account in 3 lost cells (the draft said six). |"},{"oldText":"| 4 | Other | 3 | 1.0 | Two H5 values not from the asked account; one incomplete H1 set. |","newText":"| 4 | Other | 1 | 0.3 | One incomplete H1 set (the two H5 cells moved to rank 1b). |\n| 5 | **Not yet measured: degraded reranking.** Search carried a `rerank_failed` degraded notice in 230 of 300 gbrain cells. The notice is shown once per session and the reason (timeout, provider error or budget) was not recorded, so the per-call rate is unknown. | unknown | unknown | Measured in development before any paid cell (R0). |"},{"oldText":"- **The outcome.** Agents learned the nickname on 66% of account-cells with gbrain against 99% with fs. They queried it on 55% against 92%. On the cells gbrain lost, gbrain agents never saw 57% of the needed documents that use the nickname (fs: 19%) and 65% of those that use the owner phrase (fs: 41%). Documents that use the name or code were seen equally by both arms.","newText":"- **The outcome.** Agents learned the nickname on 66% of account-cells with gbrain against 99% with fs. They queried it on 55% against 92%. On the cells gbrain lost, gbrain agents never saw 57% of the needed documents that use the nickname (fs: 19%) and 65% of those that use the owner phrase (fs: 41%). Documents that use the name or code were seen equally by both arms.\n- **Autoplan re-check of the outcome numbers.** The script behind the bullet above is not beside the plan. A reproduction over every stored tool result (H2 to H4, the first four accounts of each task) gives: nickname seen in 86% of account-cells with gbrain against 99% with fs, and queried in 82% against 98%. On the 25 lost non-turn-cap H1 to H4 cells, gbrain never saw 39% of the needed nickname documents (18 of 46), 44% of the owner-phrase documents (7 of 16) and 20% of the code documents (6 of 30), against 6% of needed documents that use no alias (8 of 131). The direction holds; the size is smaller. Code-only misses in 3 cells show that a complete `aka` is not enough on its own: search has to use every alias too. The reproduction script ships beside the plan as `rca4.py`.\n- **The account sheet was one step away.** 823 of the 973 found `entity` cards (85%) already listed the account sheet (`accounts/x`) as a `suggestions` runner-up; agents rarely opened it."},{"oldText":"### F1. Every name an entity goes by (cause 1, expected +5 to +7 points)","newText":"### F1. Every name an entity goes by (cause 1, expected +2 to +4 points)"},{"oldText":"2. **One identity per real-world entity.** When two linkable pages' title subjects normalize to the same name in the same source (`Account sheet: X` and `CRM record: X`), treat them as one identity. The card's `aka` then carries the aliases declared on either page, and `referenced_by` counts mentions of any alias. This builds on the existing `entity_identity.union` machinery; check its current default and turn it on for this case.","newText":"2. **One identity per real-world entity.** When two linkable pages' title subjects normalize to the same name in the same source (`Account sheet: X` and `CRM record: X`), treat them as one identity. The card's `aka` then carries the aliases declared on either page, and `referenced_by` counts mentions of any alias. Autoplan decision (taste, provisional): do this as a read-time sibling merge on the card and in search, not by writing `entity_identities` rows or turning on `entity_identity.union`. That table is manual-only by design (#4224: a wrong merge silently corrupts retrieval) and its union is off by default; the benchmark must run gbrain's defaults, so whatever ships here is on for every user. The sibling rule: same source, exact normalized subject, both pages of a linkable entity type, different title prefixes, neither page excluded by `mentions.exclude_slugs`; the card lists the merged pages as `identity_siblings`; config `mentions.sibling_merge` (default on) turns it off. Both CEO voices recommend against any union on title alone (user challenge UC1 at the final gate); until Garry decides, this item stands as the draft's direction with the safeguards in the accepted requirements."},{"oldText":"3. **Owner-based references.** gbrain already extracts owner and handoff facts from text (the facts pipeline).","newText":"3. **Owner-based references.** Autoplan correction: no current extractor produces owner or handoff facts from page text; the facts pipeline is an LLM turn extractor and is not run on imported pages. This item is new work, so the plan's fallback applies (taste, provisional): ship items 1, 2 and 4 now and put owner phrases behind a measured follow-up. The deferred design was:"},{"oldText":"This must fit the served-tool character ceiling (26,450).","newText":"This must fit the served-tool budgets in `test/mcp-schema-budget.test.ts`: 25,000 model-visible characters and 26,700 JSON characters for the starter list (26,679 at last measure), and per-tool budgets (`entity` 470, `search` 1,670). There is almost no headroom, so this guidance goes in the card payload, not in tool descriptions."},{"oldText":"Keyword-mode search returns `total`, `has_more` and `next_offset`, and accepts a `limit` up to 100, as pg does. Hybrid mode states that it is top-K and that coverage is not proven, and points to keyword mode with totals for enumeration.","newText":"Autoplan correction: `search` already honors `limit` (at least 100) and `offset`; what agents lack is a count. Keyword matching for remote MCP callers is only reachable through the operator setting `search.mcp_keyword_only`, so a keyword-mode-only change would not reach the agent. The default `search` path reports `total` and `has_more` for exact-token matches, and a remote-safe per-call option returns exact-token matches with a total and `next_offset` for paging (keyword matching costs less than hybrid, so allowing it remotely does not raise spend). Hybrid rows still say they are top-K and that coverage is not proven."},{"oldText":"### F2. Totals and exhaustive paging (cause 2, expected +2 to +3 points)","newText":"### F2. Totals and exhaustive paging (cause 2, expected 0 to +2 points)"},{"oldText":"### F3. Provenance-aware ranking (cause 3, expected +1 to +2 points)","newText":"### F3. Provenance-aware ranking (cause 3, expected 0 to +1 point)"},{"oldText":"Profile why one gbrain cell takes 170 s against 68 s for fs, from the per-tool timings in the transcripts, and fix the top cost if it is in gbrain. This is reported, not gated.","newText":"Profile why one gbrain cell takes 170 s against 68 s for fs, from the per-tool timings in the transcripts, and fix the top cost if it is in gbrain. This is reported, not gated. Autoplan evidence: per cell (median) model time is the same on both arms (61 s against 61 s) and gbrain's recorded tool time is 30 s against 1 s (search p50 888 ms, about 20 searches per cell). The rest of the 170 s is outside recorded model and tool time, so the profile starts there (process start, MCP round trips, write waits)."},{"oldText":"**Expected total:** +8 to +12 points against an 11.3-point gap. Parity is plausible. A positive result is not assured, which is why the kill criterion exists.","newText":"**Expected total:** +2 to +8 points against an 11.3-point gap (autoplan revision after both CEO voices; the draft said +8 to +12): F1 +2 to +4, F2 0 to +2, F3 0 to +1, F6 0 to +1. The ceilings behind it: alias blindness about 6.7 points gross (owner phrases, 6 of its 20 cells, are deferred), turn-cap losses 6.7 gross but roughly a wash net (64 against 66 stops, and gbrain's 20 wins were fs turn-cap losses), agent notes about 1, H5 memory 3. At the midpoint gbrain still trails by about 6 points, so the kill criterion is more likely than not to fire. That is why the kill criterion exists and why the confirmation spend is a decision (see Cost)."},{"oldText":"Run the gbrain arm on Sonnet 5.5 and Opus 5.5, 10 tasks per family, against the round-5 fs and pg cells already recorded on that world (Sonnet 5.5).","newText":"Run the gbrain arm on Sonnet 5.5 and Opus 5.5, 10 tasks per family, against the round-5 fs and pg cells already recorded on that world (Sonnet 5.5). Opus 5.5 has only 32 fs cells there (from the freeze check), so the missing Opus fs cells on the 50 development tasks run once (about $27) before the first gbrain round."},{"oldText":"| Development, 3 rounds (cells and slot builds) | ~$320 |\n| Confirmation on a fresh main seed (gbrain and fs, 3 models, 100 tasks; 5 slot builds) | ~$870 |\n| Confirmation on the sealed variant (same shape) | ~$870 |\n| Total | **~$2,060** (new authorization; the Hard ledger has $44 left) |\n\nA cheaper variant drops the fresh main seed and confirms on the sealed set only, for about $1,190.","newText":"| Development, 3 rounds (cells and slot builds) | ~$320 |\n| Development comparator: missing Opus 5.5 fs cells on the 50 development tasks | ~$27 |\n| Development baseline: unchanged gbrain master on the 50 development tasks, Sonnet 5.5 | ~$31 |\n| GPT-6.1 Sol slice (20 tasks) in the last development round | ~$15 |\n| Cat 40 v1 no-regression run (gbrain arm, Sonnet 5.5) | ~$25 |\n| Fable 5-cell smoke | ~$15 |\n| Confirmation on a fresh main seed (gbrain and fs, 3 models, 100 tasks; 5 slot builds; oracle check of the fresh world) | ~$640 |\n| Confirmation on the sealed variant (same shape; generated in owner custody on Garry's Mac) | ~$640 |\n| Total | **~$1,715** (new authorization; the Hard ledger has $44 left) |\n\nAutoplan cost basis: the held-out gbrain and fs cells on the three models cost $519 including the judge (ledger runs `…02-59-17…` and `…15-11-03…`, Fable's $601 removed), slot builds $14 for five, the oracle batch about $25; a 15% margin is added. The draft's $870 per confirmation had no stated basis. The sealed variant's documents differ, so its cost is an estimate on the same shape.\n\nA cheaper variant drops the fresh main seed and confirms on the sealed set only, for about $1,075. An optional exploratory gbrain-plus-fs arm on the development world (Sonnet 5.5, about $45) is a taste decision at the gate."},{"oldText":"1. **Declared-alias grammar.** Widen it to the common ways people write an alias:\n   - `nickname`, `nicknamed`, `also called`, `goes by`, `known internally as`, `referred to as`, `the team calls it`;\n   - quoted multi-word names, up to 4 words.","newText":"1. **Declared-alias grammar.** Widen it to the common ways people write an alias, as listed in the grammar spec committed before development (see \"Accepted review requirements\"; autoplan removed the draft's phrase list because two of its phrases came from the main generator). Names of up to 4 words are captured when quoted, or unquoted after a label or cue: a run of capitalized or code tokens that ends at punctuation, a lowercase word or the end of the line."},{"oldText":" If the generic version proves too broad in review, ship the alias grammar and the identity union first and put owner phrases behind a measured follow-up.","newText":""},{"oldText":"The card says `aka` is complete for declared aliases, and tells the agent to search every alias before answering a history or as-of question.","newText":"The card states what `aka` covers (declarations gbrain recognized on the listed pages, never a claim that the list is complete), points to `identity_excerpt` for other names, and tells the agent to search every alias before answering a history or as-of question."},{"oldText":"- **gbrain.** One batched PR through GBRA-40 with F1 to F5.","newText":"- **gbrain.** One batched PR through GBRA-40 with F1 to F6 and the R0 fix if R0 triggers one."},{"oldText":"- **Drafts.** #76 and #77 stay drafts until the confirmation.","newText":"- **Drafts.** #76 and #77 stay drafts until the confirmation.\n\n## Accepted review requirements (autoplan)\n\nEach item below is a requirement with its verification. They refine F1 to F6, development and confirmation; where an item and the text above differ, the item governs."},{"oldText":"Rename the row field to `page_date`, keeping `effective_date` as a deprecated alias for one release, so agents don't read it as the contract's effective date.","newText":"Default after autoplan CEO (the DX phase may amend): add `page_date` beside `effective_date` and leave `effective_date` unchanged, so agents don't read it as the contract's effective date."}]} -->


### Phase 2: Design review

SKIPPED: no UI scope detected (no view or rendering terms; the plan changes server behavior and MCP tool output only). This is a skip, not a completed review.

### Phase 2.5: DX review (DX POLISH, autoplan override)

Methodology: `plan-devex-review/SKILL.md` plus `sections/review-sections.md`, read in full from the autoplan methodology export (2,175 lines, ranges 1-600, 601-1200, 1201-1800, 1801-2175, through EOF), and the matching `dx-hall-of-fame.md` section per pass. Skip-listed sections were loaded, not executed.

**Product type.** MCP server for AI agents (the "Claude Code skill / MCP / AI agent" type), with a developer-tool secondary surface (the operator who installs gbrain and connects it to a harness). Auto-confirmed under /autoplan.

**Persona (P6, inferred from AGENTS.md, README and the served instructions).**

```
TARGET DEVELOPER PERSONA
========================
Who:       a frontier agent (Sonnet, Opus, GPT class) connected to gbrain over MCP, plus the
           harness developer who wired it in and reads its transcripts when answers go wrong
Context:   a user asks about accounts, people or history; the agent has 16 or so turns and
           reads only what tool results and tool descriptions say
Tolerance: one or two tool calls per sub-question before it trusts what it has and answers
Expects:   that a card listing names lists all of them, that a 20-row result says whether more
           exist, that a write either works or says how to fix it in the same call
```

**Empathy narrative (agent's view, grounded in the stored transcripts).** "I'm asked for four accounts' seat counts on given dates. I call `entity` for the first account and get a card: the CRM record, `aka` with the name and a four-letter code, and 20 or so referrers. It also lists an account sheet as a suggestion, but the card looks complete, so I move on. I search the name plus 'seats'. Twenty rows come back, the default; nothing tells me whether there are 21 or 400. The newest amendment I see gives me a number, so I answer. I never searched the nickname, because nothing I was shown contained it. Later, in a memory task, I save a correction with `remember` and get `invalid_params: request_id must be a UUID`; I lose a turn regenerating an id. Every tool result also carries a paragraph asking me to relay first-run settings to the user, which I cannot do." (Observed in transcripts: the card shape, the 20-row default, `suggestions`, the UUID error, the first-run notice. Predicted: the agent's reasoning.)

**Competitive benchmark (web research not run: Aside is not installed and the comparison that matters is measured in this repo).**

| Tool | Start → result | Time + evidence type | DX choice | Source |
|---|---|---|---|---|
| plain files + grep (fs arm) | question → declaring line visible | 1 to 2 calls, observed | raw lines with the match and a match count | cells-50k transcripts |
| Postgres search (pg arm) | question → ranked rows with total | 1 call, observed | `total` and an exhaustion flag | pg arm, report |
| gbrain today | question → complete alias set | 3 to 4 calls when the agent opens the account sheet; never in 14% of account-cells | card with one page's aliases; no count | `rca4.py` |
| gbrain after this plan | question → complete alias set | 1 call (card with excerpt and siblings) plus 1 search with fan-out, estimated | excerpt, sibling aliases, `total` | this plan |

Target (auto-decided, P5 fewer steps): Champion tier for the agent clock, everything needed to name an account's other forms in the first `entity` call, and alias records in the first search. The operator's install clock (AGENTS.md: about 5 minutes, keyless) is unchanged by this plan.

**Magical moment.** The first `entity` call on an account shows, verbatim, the line where the team gives the account's other name, with the slug it came from. Vehicle (P5, lowest effort, existing capability): the card payload (`identity_excerpt`), not a new tool.

**Mode.** DX POLISH (autoplan override; an enhancement to an existing product).

**Developer journey map (agent plus operator).**

```
STAGE           | DEVELOPER DOES                         | FRICTION POINTS                                  | STATUS
----------------|----------------------------------------|--------------------------------------------------|--------
1. Discover     | reads served tool list (starter)       | 21 chars of budget headroom; guidance can't grow  | fixed: guidance in payload
2. Install      | operator: bun install, init (5 min)    | none new; upgrade rescans existing brains         | fixed: catch-up notice, timed
3. Hello World  | agent: first entity call               | card looks complete, nickname absent              | fixed: excerpt, siblings, aka_sources
4. Real Usage   | agent: search, page, enumerate         | 20-row default, no total; totals only in _meta    | fixed: model-visible total line
5. Debug        | harness dev: why was X missed?         | no record of merges or fan-out per call           | fixed: meta fanout_aliases, sibling_slugs, explain
6. Upgrade      | operator: gbrain upgrade               | new default-on merge; frozen verb contract        | fixed: config switch, additive fields, docs
```

**First-time developer confusion report (agent, from transcripts).**

```
FIRST-TIME DEVELOPER REPORT
============================
Persona: frontier agent over MCP, 16-turn budget
Attempting: four-account value-history question
CONFUSION LOG:
T+0 calls  entity("X") → card with aka [name, code]; suggestions: Account sheet: X (ignored)
T+1        search("X seats") → 20 rows; is that all? (no total)
T+2        get_page on an amendment → value found; answers (nickname records never seen)
T+n (H5)   remember(..., request_id="a1b2-...-kele") → invalid_params; regenerates; one turn lost
Final state: submitted a superseded value with confidence
```
Addressed: card completeness (excerpt, siblings, coverage statement), totals, write ids. Not addressed in this wave: the first-run notice (deferred TODO), merge chains (deferred).

#### DX passes

**Pass 1: Getting started (agent first call). 4/10 → 7/10.** Evidence: the first card omits the nickname in every account case. A 10 is a first card that names every form the corpus uses, with sources, and says what it could not cover. Decisions: the card gets `aka_sources` (slugs the aliases came from) and a one-sentence `aka_note` saying the list holds recognized declarations only and pointing to `identity_excerpt` (mechanical, P1, from CEO F1.4). Residual: owner phrases are not resolved (deferred), so 7.

**Pass 2: API and tool design. 5/10 → 7/10.** Findings: (1) totals placement: `search` returns a JSON row array and puts its meta in MCP `_meta` (`src/mcp/dispatch.ts:963`), which models do not see; an array-to-object change would break every MCP client. Decision (mechanical, P5): keep the row array, put `total`, `has_more` and `next_offset` in `_meta.retrieval` for programs and in one model-visible trailer block after the rows (the same channel the existing retrieval notice blocks use), e.g. `[gbrain search] 143 exact-token matches; showing 1-20; next: offset 20`. (2) The new `search` param is named `match` with values `hybrid` (default) and `exact`, guessable and parallel to `return_unit` (mechanical, P5). (3) Card field names: `identity_excerpt`, `identity_siblings`, `aka_sources`, `aka_note`, and on search rows `matched_alias`; flags `fanout_truncated` and `siblings_capped` (mechanical, P5). (4) F4 naming is a taste decision (see DX2 below).

**Pass 3: Error messages and debugging. 6/10 → 8/10.** Three traced paths: (a) `request_id must be a UUID` today has problem and fix but rejects a reasonable id; after F6 it is accepted, and the remaining error (empty or over 128 characters) states the limits and the actual length. (b) New degraded stages (sibling query failed, count failed, fan-out alias failed) follow the existing operator contract (`code`, `why`, `fix.next`, `fix.verify`; `docs/protocol/AGENT_OPERATOR_v1.md`) and reuse `degraded_recall`-style notices rather than new prose. (c) A capped sibling group names `gbrain extract mentions --explain <name>` as its read-only verify. Decision: all three are required (mechanical, P1: problem plus cause plus fix).

**Pass 4: Documentation. 4/10 → 7/10.** The plan names no doc updates. Required (mechanical, P1): `docs/guides/entity-recall.md` (grammar conventions, siblings, excerpt, the config switch), `docs/architecture/key-files/entity-recall.md` and the `aliases.ts` header (the keyword list changes), `docs/protocol/MEMORY_VERBS_v1.md` (new optional `entity` fields and the `request_id` widening, additive per its versioning policy), the `search` tool description within budget, `bun run build:llms` after doc edits, and a CHANGELOG section "What changes for agents" with one example card. Residual: no runnable example corpus for the excerpt (7).

**Pass 5: Upgrade and migration. 5/10 → 7/10.** Findings: (1) `MEMORY_VERBS_v1` freezes field names and meanings: `aka` keeps its meaning (names this entity goes by) and only widens its sources; the `remember` response's `request_id` stays the canonical UUID, and the client's original string comes back in a new optional `client_request_id` (decision, mechanical, P5: additive-forever rule). Child ids for `remember items` derive from the canonical UUID as today. (2) The version bumps rescan every brain; the CHANGELOG states the expected time on 50k pages (from the development timing) and that answers can change after the sweep. (3) `mentions.sibling_merge=false` is the documented escape hatch.

**Pass 6: Developer environment and tooling. 6/10 → 7/10.** `extract mentions --explain` gains sibling-group output; `rca4.py` and the alias-coverage proxy give harness developers a free way to check a corpus. No new environment requirements. Residual: no dry-run preview of what the new grammar would extract on an existing brain; decision: add a read-only `gbrain extract mentions --explain --preview-aliases` is out of DX POLISH scope (new CLI surface), deferred to TODOS (P3).

**Pass 7: Community and ecosystem. 5/10 → 5/10.** No issues found that this plan should change: the code is open, the evaluation and its failures are published, and the plan keeps publishing honestly. The privacy rule (placeholder names) is already a house rule.

**Pass 8: DX measurement. 4/10 → 7/10.** The plan measures task success only. Required (mechanical, P1): the development record reports, per arm, the share of account-cells where the agent saw and queried the nickname (from `rca4.py`), tool calls from question to first alias query, the share of `remember` calls that failed, and the share of tool results that carried notices; the confirmation report repeats the first two. Measuring the agent clock this way is the boomerang check for this phase's target.

**TTHW.** Operator install: about 5 minutes documented (AGENTS.md), unchanged → 5 minutes. Agent clock (calls from question to complete alias set): 3 to 4 observed when the agent opens the sheet, never in 14% of account-cells → 2 targeted (one `entity`, one search).

#### DX dual voices

Both voices reviewed the amended Implementation plan at SHA-256 `c90be252…8e21944f`. The Codex job and the native subagent ran at the same time; the native result was consumed first.

**Claude SUBAGENT (DX, independent review)** (Claude Opus 5.5, completed; INPUT line matched the snapshot hash). 2 critical, 8 high, 8 medium. Critical: `total` counts a different set from the rows beside it (A1); rerank failure is a product defect, not only a measurement (E1). High: silent stale alias derivation after the version bump (G1); paging names differ from `get_backlinks` (A2); the new option is unnamed (A3); agents reuse low-entropy ids across sessions, so F6 could turn `invalid_params` into `idempotency_conflict` (A4); F6 echo, validator scope and "UUID" strings undefined (A5); new error paths have no copy (E2); cap flags give nothing to act on (E3); no alias-writing guide (D1); behavior changes undeclared (D2); no way to remove a wrong derived alias (X1). Medium: card guidance contradicts automatic fan-out (G2); no RCA runbook (G3); field sprawl (A6); `page_date` duplicates `effective_date`, and `effective_date_source` already exists (A7); `provenance` enum unspecified (A8); requirements split from F sections (D3); no alias explain (D4); no per-page merge opt-out (X2); hardcoded fan-out and demotion (X3).

**Codex SAYS (DX, developer experience challenge)** (codex-cli 0.160.0, `gpt-6-astra`, reasoning high; completed, `OUTSIDE_STATUS: completed provider=codex host=claude`). Full output:

```tool-output
**Revise before implementation.** The plan improves retrieval, but several proposed contracts could still mislead an agent reading them cold. I reviewed the plan, served tool definitions, and source at `2eb9df1c1` read-only. Setup time was not measured.

1. **High — F2’s totals describe a different result set from the displayed rows.**  
   Hybrid search could return 20 useful rows alongside `total: 0, has_more: false` because those fields count strict keyword matches. An agent can reasonably interpret that as exhaustion. “Exact-token” also overstates the underlying full-text semantics.

   **Fix:** Use explicitly scoped fields such as `keyword_total` on hybrid responses, with overall coverage marked unknown. Name the new option, for example `keyword_only: true`, and reserve ordinary pagination fields for that matching result set. Include a model-visible explanation when rows and counts describe different sets. [Search implementation](/workspace/gbrain/src/core/ops/search.ts:620)

2. **High — The plan does not guarantee that agents actually see its new fields.**  
   Search returns a JSON array; metadata travels separately. Adding totals only to `_meta` would miss agents whose harness omits it. Likewise, the default lean projection currently discards `page_date`, `provenance`, and `matched_alias` unless explicitly extended.

   **Fix:** Preserve the array contract, mirror pagination and coverage information into model-visible content on **every relevant call**, and retain the new row fields in lean output. Verify through real MCP dispatch with `_meta` removed from the model’s view, including empty results and repeated calls. [Dispatch](/workspace/gbrain/src/mcp/dispatch.ts:915), [lean projection](/workspace/gbrain/src/core/search/lean-rows.ts:26)

3. **High — “Exhaustive paging” is not yet an end-to-end guarantee.**  
   Enlarging the keyword candidate pool solves only one limit. Evidence delivery can subsequently drop rows to meet token budgets. Advancing by `offset + limit` could skip pages the agent never received. Sibling-union reference totals also need continuations that enumerate the same union; existing card continuations address one slug.

   **Fix:** Specify pagination after all deduplication and delivery decisions. Return bounded page references when full evidence cannot fit, or provide a continuation that cannot skip omitted pages. Test oversized documents, small budgets, repeated chunks, and sibling references through MCP—not just engine calls. [Evidence allocation](/workspace/gbrain/src/core/search/evidence-delivery.ts:680), [reference continuation](/workspace/gbrain/src/core/verbs/entity-card.ts:292)

4. **High — Default title-based merging creates confident identity mistakes.**  
   Same source, type, and normalized name do not establish identity. Separate accounts or successor companies can satisfy every proposed predicate. Read-time merging still contaminates aliases and evidence, even without writing identity rows. The planned “renamed account and successor stay separate” test lacks a specified discriminator. This remains the unresolved UC1 issue.

   **Fix:** Require an explicit identity assertion or validated stable identifier. Otherwise expose candidate pages with separate excerpts and attribution. Keep them out of automatic alias/reference unions. The current identity implementation deliberately requires explicit assertions because titles collide. [Identity contract](/workspace/gbrain/src/core/entity-identity.ts:1)

5. **High — F4 adds a second date without removing the first date’s misleading meaning.**  
   Showing identical `page_date` and `effective_date` values does not explain which date governs a contract. The existing value can come from frontmatter, a filename, or a fallback; it is not necessarily a signing date either.

   **Fix:** Retain `effective_date` for compatibility, but explicitly label it a legacy document-date field. Expose the date’s source and state that contractual validity requires reading the document. Put this explanation in model-visible output and the field reference, with an example where document and contractual dates differ. [Date semantics](/workspace/gbrain/src/core/types.ts:118)

6. **High — The upgrade test misses false completeness before reindexing.**  
   Version bumps and the existing catch-up notice are useful. However, coverage currently checks version mismatches only among pages updated since the last count. An unchanged old brain can therefore retain `coverage: complete` after an extractor-version bump, before a sweep updates its status.

   **Fix:** Make coverage version-aware independently of page modification times. Test immediately after upgrade, during an interrupted sweep, and after resumption. Publish a migration note covering changed retrieval behavior, pending-state interpretation, catch-up verification, and recovery. The existing notice already supplies a resumable command; reuse it. [Coverage calculation](/workspace/gbrain/src/core/mentions/coverage.ts:39), [upgrade notice](/workspace/gbrain/src/core/mentions/upgrade-notice.ts:18)

7. **High — The recommended setup hides tools this plan requires.**  
   The coding-agent tutorial registers `--surface verbs`. That surface excludes `search`, `get_page`, `get_backlinks`, and `request_tools`. A newly connected agent can receive a card telling it to inspect evidence or search aliases without having those tools available.

   **Fix:** Make the document-retrieval onboarding path use `starter`, and clearly distinguish the smaller memory-only path. Add one linked, copy-paste-complete walkthrough: entity lookup → alias evidence → keyword pagination → source verification. Name the new search parameter and show its actual response and continuation. Require a cold reader to find this within two minutes. [Setup tutorial](/workspace/gbrain/docs/tutorials/connect-coding-agent.md:80), [surface enforcement](/workspace/gbrain/src/mcp/surface.ts:1)

8. **Medium — The under-five-minute hello world is unproven.**  
   The documented path involves roughly nine actions when prerequisites are absent: install Bun, install gbrain, inspect configuration, initialize, confirm search mode, write/read a test memory, register MCP, reload the harness, and verify native recall. Cross-session correction and withdrawal add more. Warm benchmark restores measure none of this.

   **Fix:** Add a timed fresh-install acceptance check ending at the first successful native MCP write/readback. Provide one self-contained quickstart with generated test values, expected output, and reload instructions. Report prerequisite installation separately, but include it in the zero-to-working total. [Documented journey](/workspace/gbrain/docs/tutorials/connect-coding-agent.md:33)

9. **Medium — Visible caps and rerank failures still lack actionable recovery.**  
   `fanout_truncated` and `siblings_capped` tell an agent something stopped, but not which aliases remain or what call retrieves them. Excerpt truncation has no equivalent recovery requirement. R0 improves internal diagnosis, while the current rerank notice supplies neither the failure reason nor a fix.

   **Fix:** Return bounded searched/remaining alias information and callable next steps; identify omitted excerpt sources. Render rerank reason, fallback behavior, and the appropriate operator action using the existing `code`/`why`/`fix` contract. Keep coverage facts visible even when repeated coaching is suppressed. [Current rerank guidance](/workspace/gbrain/src/core/interop-notices.ts:49)

10. **Medium — F6 leaves the client-visible request-ID contract unfinished.**  
    Accepting opaque strings is a useful improvement, but receipts currently expose the stored UUID. The plan does not specify whether clients receive their original ID, the normalized UUID, or both. Existing served descriptions also explicitly require UUIDs. That leaves log correlation and recovery confusing.

    **Fix:** Define the receipt representation and support lookup/replay using both original and returned identifiers. Update every affected description and example, define “printable” precisely, and make invalid-ID errors show a valid example plus the limits. Test lost replies, pending writes, cancellation, and different-intent reuse through MCP. [Receipt rendering](/workspace/gbrain/src/core/persistence/journal.ts:674), [ID validation](/workspace/gbrain/src/core/persistence/preconditions.ts:4)

Recommendation: Revise before implementation because the current plan can still present incomplete retrieval as exhausted, unrelated pages as one identity, and stale indexes as complete.
```

DX DUAL VOICES — CONSENSUS TABLE:

| Dimension | Claude | Codex | Consensus |
|---|---|---|---|
| 1. Getting started < 5 min? | agent path good after fan-out; operator sweep time unknown | unproven; about 9 install actions | CONFIRMED (not demonstrated) |
| 2. API/CLI naming guessable? | no: count misnamed, option unnamed, paging dialect | no: count misnamed, option unnamed | CONFIRMED (no) |
| 3. Error messages actionable? | no: copy missing, caps not actionable, rerank reason missing | no: caps and rerank lack recovery | CONFIRMED (no) |
| 4. Docs findable & complete? | no: alias guide, behavior changes | no: walkthrough, surface mismatch | CONFIRMED (no) |
| 5. Upgrade path safe? | no: silent stale derivation | no: coverage reports complete before the sweep | CONFIRMED (no) |
| 6. Dev environment friction-free? | gaps: explain, escape hatches | gaps: `verbs` surface lacks `search` | CONFIRMED (gaps) |

Disagreements resolved without the gate: the option name (`match: "exact"` against `keyword_only: true`) became `match: "keyword"`, because Codex is right that the matching is full-text, not exact tokens, and the enum keeps the native shape (P5); the F6 echo (native: echo the original as `request_id`) keeps `request_id` as the UUID because `MEMORY_VERBS_v1` freezes that field's meaning, and adds `client_request_id` (P5, frozen-contract rule). Both voices recommend changing the draft's F4 rename: UC3. Codex repeats the UC1 identity objection. Single-voice criticals: none unhandled (A1 and E1 are both accepted).

**Integrated outside findings (Codex) checked against code:** totals visibility (`src/mcp/dispatch.ts:963` puts meta in `_meta`) accepted; lean projection drops new fields (`src/core/search/lean-rows.ts`, no `effective_date_source`) accepted; paging after evidence delivery accepted; identity merge folded into UC1; F4 into UC3; coverage misses version bumps on unchanged pages (`src/core/mentions/coverage.ts`, the `updated_at >= counted_at` filter) verified and accepted; the coding-agent tutorial registers `--surface verbs` (`docs/tutorials/connect-coding-agent.md:86`), which has no `search`: card guidance made surface-aware, tutorial change deferred to TODOS; fresh-install timing deferred to TODOS; F6 receipt contract accepted.

#### DX outputs

**Competitive DX benchmark after review.** gbrain after this plan: complete alias set in about 2 calls (estimate), count on every search, write ids accepted; Champion tier for the agent clock if the excerpt and fan-out work as specified.

**Magical moment specification.** The first `entity` call shows `identity_excerpt` lines with slugs, `aka_sources`, and `identity_siblings`; the following search shows `matched_alias` rows and a one-line count. Requirements: the F1.5, F1.6 and DX card-guidance items.

**DX scorecard.**

```
+====================================================================+
|              DX PLAN REVIEW — SCORECARD                             |
+====================================================================+
| Dimension            | Score  | Prior  | Trend  |
|----------------------|--------|--------|--------|
| Getting Started      |  7/10  |  4/10  |  +3 ↑  |
| API/CLI/SDK          |  7/10  |  5/10  |  +2 ↑  |
| Error Messages       |  8/10  |  6/10  |  +2 ↑  |
| Documentation        |  7/10  |  4/10  |  +3 ↑  |
| Upgrade Path         |  7/10  |  5/10  |  +2 ↑  |
| Dev Environment      |  7/10  |  6/10  |  +1 ↑  |
| Community            |  5/10  |  5/10  |   0    |
| DX Measurement       |  7/10  |  4/10  |  +3 ↑  |
+--------------------------------------------------------------------+
| TTHW (operator)      | ~5 min | ~5 min |   0    |
| Agent clock          | 2 calls| 3-4    |  ↑     |
| Competitive Rank     | Champion (agent clock, estimated)            |
| Magical Moment       | designed via the entity card payload         |
| Product Type         | MCP server for AI agents                     |
| Mode                 | POLISH                                       |
| Overall DX           |  7/10  |  5/10  |  +2 ↑  |
+====================================================================+
| DX PRINCIPLE COVERAGE                                               |
| Zero Friction      | covered (agent path); operator path unmeasured |
| Learn by Doing     | covered (copy-paste alias guide)               |
| Fight Uncertainty  | covered (counts, coverage notices, error copy) |
| Opinionated + Escape Hatches | covered (defaults plus five switches)|
| Code in Context    | gap (no runnable example corpus)               |
| Magical Moments    | covered (excerpt on first card)                |
+====================================================================+
```

Community stays at 5 and nothing is below 5; no dimension is critical DX debt after the decisions.

**DX implementation checklist.**

```
DX IMPLEMENTATION CHECKLIST
============================
[ ] Agent clock: alias set in 2 calls on the calibration slot (measured in development)
[ ] Installation is one command (unchanged; not in this wave)
[ ] First entity call shows identity_excerpt, aka_sources, identity_siblings
[ ] Magical moment delivered via the entity card payload
[ ] Every new error and degraded stage has code + why + fix + verify
[ ] `match: "keyword"`, `keyword_total`, `total`/`truncated`/`next` named as specified
[ ] Every new switch has a documented default
[ ] Alias guide has copy-paste examples that work on a fresh brain
[ ] Example card in the CHANGELOG is real output
[ ] Upgrade: version-aware coverage notice, ETA in post-upgrade
[ ] Behavior-change rows added; frozen verb fields untouched
[ ] Works on PGLite and Postgres; MCP tests read model-visible content only
[ ] CHANGELOG "What changes for your agent" written
[ ] llms.txt regenerated
```

**NOT in scope (DX).** Onboarding walkthrough on the `starter` surface and a timed fresh-install check (TODOS); a runnable example corpus for the excerpt; changing the coding-agent tutorial's default surface (a product decision).

**What already exists (DX).** The operator contract (`docs/protocol/AGENT_OPERATOR_v1.md`), `get_backlinks` paging words, `mentionCoverageNotice`, the `degraded_recall` notice, `extract mentions --explain`, `behavior-change-notice.ts`, `requires_surface` on card continuations, the schema-budget test, `effective_date_source` in full rows.

#### DX implementation tasks

- [ ] **T12 (P1, human: ~4h / CC: ~30min)** — gbrain search — `keyword_total`, `match: "keyword"`, `total`/`truncated`/`next`, model-visible line, paging after delivery
  - Surfaced by: Pass 2 and both voices — count names a different set
  - Files: `src/core/ops/search.ts`, `src/mcp/dispatch.ts`, `src/core/search/evidence-delivery.ts`, tests
  - Verify: MCP model-visible tests; budget test
- [ ] **T13 (P1, human: ~2h / CC: ~15min)** — gbrain search — lean rows keep `matched_alias`, `provenance`, `effective_date_source`
  - Surfaced by: Codex finding 2
  - Files: `src/core/search/lean-rows.ts`, tests
  - Verify: lean-row tests
- [ ] **T14 (P1, human: ~3h / CC: ~20min)** — gbrain mentions — version-aware coverage and upgrade ETA
  - Surfaced by: both voices, Pass 5
  - Files: `src/core/mentions/coverage.ts`, `src/core/mentions/upgrade-notice.ts`, tests
  - Verify: bump, interrupt, resume tests
- [ ] **T15 (P1, human: ~3h / CC: ~20min)** — gbrain persistence — F6 contract (`client_request_id`, lookups, strings, conflict copy)
  - Surfaced by: A4, A5, Codex finding 10
  - Files: `src/core/persistence/*.ts`, `src/core/operations.ts`, `docs/protocol/MEMORY_VERBS_v1.md`, tests
  - Verify: MCP lost-reply, pending, cancel, reuse tests
- [ ] **T16 (P2, human: ~2h / CC: ~15min)** — gbrain search — rerank notice with reason, count and fix
  - Surfaced by: E1, Codex finding 9
  - Files: `src/core/interop-notices.ts`, `src/core/search/hybrid/rank.ts`, tests
  - Verify: notice tests per reason
- [ ] **T17 (P2, human: ~3h / CC: ~20min)** — gbrain card — structured `fanout`, `identity_siblings`, `aka_sources`, surface-aware guidance
  - Surfaced by: A6, E3, G2, Codex finding 7
  - Files: `src/core/verbs/entity-card.ts`, `src/core/ops/search.ts`, tests
  - Verify: card tests on both surfaces
- [ ] **T18 (P2, human: ~3h / CC: ~20min)** — gbrain config — escape hatches and explain output
  - Surfaced by: X1 to X3, D4
  - Files: `src/core/mentions/aliases.ts`, `src/core/mentions/policy.ts`, `src/commands/extract-mentions-explain.ts`, tests
  - Verify: one test per switch, explain tests
- [ ] **T19 (P2, human: ~3h / CC: ~20min)** — gbrain docs — alias guide, MEMORY_VERBS, key files, behavior changes, CHANGELOG block, llms
  - Surfaced by: Pass 4, D1, D2
  - Files: `docs/guides/entity-recall.md`, `docs/protocol/MEMORY_VERBS_v1.md`, `docs/architecture/key-files/entity-recall.md`, `src/core/behavior-change-notice.ts`, `CHANGELOG.md`
  - Verify: docs checks, `llms.txt` diff
- [ ] **T20 (P3, human: ~1h / CC: ~10min)** — gbrain-evals — RCA runbook README and DX measures in the development record
  - Surfaced by: G3, Pass 8
  - Files: `docs/plans/2026-10-07-cat40-hard-fix/README.md`, development record
  - Verify: commands reproduce the numbers

Unresolved DX decisions (at the gate): UC3 (F4 date field).

#### DX accepted obligations

<!-- autoplan-accepted:dx -->
- Search counts, names and visibility (replaces, in the CEO F2 requirement, the names `total`, `has_more`, `next_offset`, the phrase "exact-token" and "one new `search` param"): default hybrid responses carry `keyword_total` and `keyword_truncated`, counting distinct pages that match the strict full-text query of `engine.searchKeyword` (never the OR retry or the capped pool), and every such call adds one model-visible line after the rows saying the rows are top-K and the count covers keyword matches only; the remote-safe option is `match` with values `hybrid` (default) and `keyword`; with `match: "keyword"` the response carries `total`, `truncated` and `next` (a ready-to-send argument object), the words `get_backlinks` already uses; `next` is absent outside keyword mode and a `next` or `offset` from a hybrid call is refused with a fix naming `match: "keyword"`. Counts and paging are computed after deduplication and evidence delivery: a page dropped to fit a token budget is listed by slug in `omitted`, never skipped by the offset. The exact description string for `match` is in the PR and `test/mcp-schema-budget.test.ts` passes. Verify: MCP-dispatch tests that read only model-visible content (no `_meta`), on empty results, small token budgets, oversized pages and repeated chunks; a keyword walk that recovers every page `total` reports.
- Lean rows keep the new fields: `matched_alias`, `provenance` and `effective_date_source` survive the default lean projection (`src/core/search/lean-rows.ts`). `provenance` appears only on machine-written rows, with the value `generated`. Verify: lean-row tests for each field and for its absence on ordinary rows.
- Card guidance: the card says search already covers the listed aliases (rows carry `matched_alias`) and asks the agent to search only names that appear in `identity_excerpt` or in `fanout.aliases_skipped`; the guidance appears only when `aka`, siblings or the excerpt are non-empty; on a surface without `search` (the `verbs` surface) it names `requires_surface: "starter"` instead of a tool the caller lacks. Verify: card tests on `starter` and `verbs` surfaces and on an entity with no aliases.
- Structured fan-out and sibling fields (replaces the CEO flags `fanout_truncated` and `siblings_capped`): search meta and, when truncated, the model-visible line carry `fanout: {resolved_entity, aliases_searched, aliases_skipped, truncated}`; the card carries `identity_siblings: {pages, capped}`, and `capped` comes with the operator-contract fix block naming `gbrain extract mentions --explain <slug>` (`tell_user_to_run` for remote callers); `aka` stays a string array (frozen) and a parallel `aka_sources` maps each entry to its origin and source slug; a truncated excerpt lists the slugs it omitted. Verify: tests for each field, for skipped aliases being searchable by the agent, and for the frozen `aka` type.
- Version-aware coverage: mention coverage counts a page as pending when its stored mention or alias version is behind the binary's, whatever its `updated_at` (today `readMentionCoverage` only checks pages written since the last count), so cards and searches carry the existing `mention_index` notice until the sweep finishes; `gbrain post-upgrade` prints an ETA measured on the 55k calibration brain. Verify: tests immediately after a version bump on an unchanged brain, during an interrupted sweep and after it resumes.
- Rerank notice: the `degraded_recall` notice for `rerank_failed` carries the reason (timeout, provider error, budget or concurrency), the number of degraded calls this session and the fallback used, with `fix.next` per reason under the operator contract; the per-call response meta records the degradation without `fields: "full"`. Verify: notice tests per reason.
- F6 contract (refines the CEO F6 requirement): responses keep `request_id` as the canonical UUID (its frozen `MEMORY_VERBS_v1` meaning) and add optional `client_request_id` with the string the client sent; lookups (`get_write_request`, `cancel_write_request`, `list_write_requests`, replays) accept either; normalization happens once at the operation boundary for write ops' `request_id` only (not administration writer or deactivation ids); printable means ASCII 0x21 to 0x7E; every description and message that says "UUID" for this param is updated (`WRITE_REQUEST_PARAM`, the `get_write_request` param, the required-id error, the `put_page` and `put_pages` descriptions, `MEMORY_VERBS_v1`), saying the id is optional and reused only to retry the same write; reuse for a different write returns `idempotency_conflict` with "this request_id was used for a different write; send a new one or omit it" and `fix.next: run`; the invalid-id error shows the limits, the actual length and a valid example. Development round 1 reports the conflict rate. Verify: MCP tests for a lost reply, a pending write, cancellation and different-intent reuse, each by original string and by UUID.
- Error copy: the PR carries the exact strings for the invalid `request_id` error, the reuse conflict, a `next` or offset sent outside keyword mode, a remote `mode` refusal that points to `match: "keyword"`, and an unavailable count (a degraded stage, never a wrong number); any new code is added to the `gbrain errors` catalogue. Verify: `gbrain errors <code>` prints each new code.
- Documentation: `docs/guides/entity-recall.md` gains a "How gbrain learns an alias" section with copy-paste examples (frontmatter aliases, prose cues, label and value lines, tables, quoting, what is rejected, the deny list); `docs/protocol/MEMORY_VERBS_v1.md` documents the new optional `entity` and `remember` fields; `docs/architecture/key-files/entity-recall.md` and the `aliases.ts` header are updated; `src/core/behavior-change-notice.ts` gains rows for the card shape, search counts, generated-page demotion, `request_id` acceptance and the sibling merge; the CHANGELOG has a "What changes for your agent" block with an example card; `bun run build:llms` runs. Verify: the docs checks in CI and a diff of `llms.txt`.
- Escape hatches: brain config `mentions.alias_deny` and page frontmatter `alias_deny:` remove derived aliases; `mentions.multiword_aliases` (default on) turns multi-word capture off; page frontmatter `identity: separate` keeps a page out of sibling merges; `search.alias_fanout_max` (default 4, 0 disables) and `search.demote_generated` (default on) control fan-out and demotion. The benchmark runs defaults. Verify: one test per switch.
- Explain: `gbrain extract mentions --explain <name|slug>` lists each alias with its origin and source line, each rejected candidate with its reason, and the sibling decision. Verify: explain tests for an accepted alias, a rejected one and a capped sibling group.
- DX measures in the development record: per arm, the share of account-cells where the agent saw and where it queried the nickname (`rca4.py`), tool calls from the question to the first alias query, the `remember` failure and conflict rates, and the share of tool results carrying notices; the confirmation report repeats the first two. Verify: the numbers are in the record.
- Evidence runbook: the plan directory gets a README with one command per `rca*.py` script, its inputs and the headline numbers it should print. Verify: running each command reproduces the numbers.
- DX TODOS: gbrain TODOS gains a document-retrieval onboarding walkthrough on the `starter` surface (the coding-agent tutorial registers `--surface verbs`, which has no `search`), and a timed fresh-install check ending at the first MCP write and read. Verify: both entries exist.
<!-- /autoplan-accepted:dx -->

#### DX baseline edits (exact replacements applied to the plan body)

<!-- autoplan-baseline-edits:dx {"sourceSha256":"a585465cf5044a6a9aef02beb8b1c3d0ace1f7347999f01f9ec950424b39fc80","replacements":[{"oldText":"The default `search` path reports `total` and `has_more` for exact-token matches, and a remote-safe per-call option returns exact-token matches with a total and `next_offset` for paging","newText":"The default `search` path reports `keyword_total` and `keyword_truncated` for keyword (full-text) matches, labelled in model-visible text as a count of keyword matches beside top-K rows, and a remote-safe per-call option `match: \"keyword\"` returns keyword matches with `total`, `truncated` and `next`, the same paging words `get_backlinks` uses (autoplan DX naming)"},{"oldText":"Default after autoplan CEO (the DX phase may amend): add `page_date` beside `effective_date` and leave `effective_date` unchanged, so agents don't read it as the contract's effective date.","newText":"Default after autoplan CEO: add `page_date` beside `effective_date` and leave `effective_date` unchanged, so agents don't read it as the contract's effective date. Both DX voices recommend instead keeping `effective_date` as the one field, labelling it a document date in model-visible text and exposing the existing `effective_date_source` in lean rows, with no second date field (user challenge UC3 at the final gate; the draft asked for a rename to `page_date`, so its direction stands until Garry decides)."},{"oldText":"**Expected total:** +2 to +8 points against","newText":"### F6. Write ids any agent can send (H5 friction, expected 0 to +1 point)\n\n`remember` and the other write ops accept any opaque `request_id` an agent sends and map it to the canonical UUID, so a non-UUID id no longer costs a turn; responses keep `request_id` as the UUID (frozen `MEMORY_VERBS_v1` meaning) and echo the client's string as `client_request_id`. Details are in \"Accepted review requirements\".\n\n**Expected total:** +2 to +8 points against"},{"oldText":"That is why the kill criterion exists and why the confirmation spend is a decision (see Cost).","newText":"That is why the kill criterion exists and why the confirmation spend is a decision (see Cost).\n\n**Pending Garry (decided at the autoplan final gate; until then the default applies):**\n\n| Item | Default until decided | Alternative both outside reviews or the gate offers |\n|---|---|---|\n| UC1 identity merge | read-time sibling merge with safeguards | no union on title alone; show siblings and excerpts only |\n| UC2 confirmation endpoint | main seed primary, sealed secondary | sealed co-primary, or sealed-only |\n| UC3 F4 date field | add `page_date` | one field, labelled, `effective_date_source` exposed |\n| C4 owner phrases | deferred | build in this wave |\n| C9 confirmation spend | authorized after the development record | unconditional |\n| C16 gbrain-plus-fs arm | not run | run on development (about $45) |"}]} -->


### Phase 3: Eng review (FULL_REVIEW)

Methodology: `plan-eng-review/SKILL.md` plus `sections/review-sections.md`, read in full from the autoplan methodology export (2,261 lines, ranges 1-600, 601-1200, 1201-1800, 1801-2261, through EOF). Skip-listed sections were loaded, not executed. Target: this plan (the Scope gate's plan target, named by the parent); report file: this plan.

#### Step 0: Scope challenge (grounded in code)

**What already solves each sub-problem** (read at gbrain `2eb9df1c1`):

| Sub-problem | Existing code | Finding |
|---|---|---|
| Declared aliases | `src/core/mentions/aliases.ts:23` `ALIAS_DECLARATION` (single token `[A-Z0-9][A-Za-z0-9&.-]{1,24}`), `declaredNames`, `deriveEntityAliases` | Extend in place; search's `aliasDeclarations` (`src/core/ops/search.ts:267`) shares it. |
| Gazetteer and collisions | `src/core/by-mention.ts` `buildGazetteer` (multi-word titles already supported, longest match first) | Multi-word aliases fit; single-word case sensitivity stays. |
| Re-derivation on upgrade | `ALIAS_DERIVATION_VERSION` (1) and `MENTION_EXTRACTOR_VERSION` (2) in `src/core/mentions/pass.ts`; stale sweep keys on them | Bump both; no migration. |
| Coverage | `src/core/mentions/coverage.ts` `readMentionCoverage` counts only pages with `updated_at >= counted_at` | Must also count version-behind pages (DX accepted). |
| Card | `src/core/verbs/entity-card.ts` `buildEntityCard` (arm 1 alias, arm 2 exact/suffix; runners-up become `suggestions`), `assembleCard` (`aka` from `page_aliases` of one slug) | Siblings are already found by arm 2's slug-suffix match today (they become `suggestions`); the merge reuses that candidate set. |
| Referrers over several pages | `src/core/mentions/referrers.ts` already unions identity co-members under `entity_identity.union` | Feed sibling page ids through the same co-member path instead of a second query. |
| Fan-out | `withDeclaredNameFanOut` (`search.ts:312`, first declaration, 5 rows, hybrid) | Widen; switch alias queries to `searchKeyword`. |
| Keyword search | `pglite-engine.ts` and `postgres-engine.ts` `searchKeyword`: `innerLimit = min(limit*3, cap*3)`, best chunk per page, then `LIMIT/OFFSET`; OR-of-terms retry when strict finds nothing; GIN index on `content_chunks.search_vector` and `pages.search_vector` | A separate count query is needed; the keyword option needs a pool sized to `offset + limit` or page-grain keyset paging. |
| Response meta | `searchOutput` (`search.ts:85`) emits meta to `_meta`; `src/mcp/dispatch.ts:915-964` renders retrieval notice blocks | The count line rides the notice-block channel. |
| Lean rows | `src/core/search/lean-rows.ts` | Add the three fields. |
| Write ids | `src/core/persistence/journal.ts:103` keys `(principal_kind, principal_id, request_id::uuid)`; `requireUuid` in `preconditions.ts` and `digest.ts` | Normalize once before `requireUuid`; column stays `uuid`. |
| Identity groups | `src/core/entity-identity.ts` (manual-only) | Not used for automatic merges. |
| Graduation inventory | `src/core/persistence/graduation-inventory.ts` (every relation classified) | No new relation is planned, so no inventory row; if a sibling cache table is ever added, it needs one. |
| Tool budgets | `test/mcp-schema-budget.test.ts` (25,000 / 26,700, `search` 1,670, `entity` 470) | The `match` param must be paid for by a trim. |
| Merge gate | `docs/eval/BRAINBENCH.md`: "Every subsequent memory PR must move, or hold with a recorded justification, a BrainBench number to merge"; `docs/eval/FIX_WAVE_BASELINES.md`: retrieval canary `gbrain eval gate` | The plan names neither. |

**Minimum change for the goal:** the grammar, the excerpt, sibling-aware aliases, fan-out over every alias, keyword counts, F6. F3, F4 and F5 do not block the goal; they stay because they are cheap and requested.

**Complexity check:** about 22 changed files in gbrain (estimate: `aliases.ts`, `by-mention.ts`, `pass.ts`, `coverage.ts`, `upgrade-notice.ts`, `policy.ts`, `entity-card.ts`, `referrers.ts`, `ops/search.ts`, `lean-rows.ts`, `evidence-delivery.ts`, both engines, `interop-notices.ts`, `hybrid/rank.ts`, persistence `preconditions.ts`/`digest.ts`/`journal.ts`, `operations.ts`, `extract-mentions-explain.ts`, `behavior-change-notice.ts`, docs) and 1 new module (the sibling resolver). The 8-file gate trips. Autoplan override "scope challenge: never reduce (P2)": no feature cut; structure question auto-answered `Original arrangement` (one batched PR is a house rule; the arrangement already has one shared resolver rather than per-caller copies). Scope record: feature answers none (no cuts proposed); structure: A (Original arrangement, autoplan P2/P5); accepted scope: the plan as amended through DX; pending remedies: UC1, UC2, UC3, C4, C9, C16.

**Search check:** no new infrastructure pattern; every mechanism reuses gbrain's own (full-text query, notice blocks, co-member referrers). [Layer 1] throughout.

**TODOS cross-reference:** gbrain `TODOS.md` gains the entries collected below; nothing in it blocks this plan.

**Distribution check:** no new artifact; ships in the normal release.

**Scope Challenge result:** scope accepted as-is.

Scope findings:
1. [P1] (confidence 9/10) `docs/eval/BRAINBENCH.md:9-10` "Every subsequent memory PR must move — or hold, with a recorded justification — a BrainBench number to merge." The plan has no BrainBench or retrieval-canary gate, yet it changes ranking, card shape and write handling for every user. Decision (mechanical, P1): add `gbrain eval brainbench --compare evals/brainbench/baselines/main.json` (deterministic mode, free) and `gbrain eval gate` on a non-production brain as merge gates, numbers recorded in the PR.
2. [P2] (confidence 8/10) PGLite is one connection: "run in parallel" for the four fan-out queries serializes on the benchmark's PGLite slot. Decision (mechanical, P5): keep parallel dispatch (it helps Postgres), but the latency budget is measured on PGLite, and the fan-out uses one `searchKeyword` call with an OR of the alias terms when the engine is PGLite if four calls exceed 150 ms p50 on the calibration slot.

#### Eng dual voices

Both voices reviewed the Implementation plan at SHA-256 `c7e39941…a1294258` (after CEO and DX amendments). Run at the same time; the native result was consumed first.

**Claude SUBAGENT (eng, independent review)** (Claude Opus 5.5, completed; INPUT matched the snapshot hash). High: F6 may swap `invalid_params` for `idempotency_conflict` if agents reuse ids, and the 8-character minimum still rejects short ids; F6 needs a stored column and a migration; F3's `author: agent:*` follows the corpus, not gbrain, and "same entity" and "correction" have no mechanism; keyword paging and the count are unbounded and the pool cannot guarantee page coverage. Medium: version-aware coverage turns card reads into scans; n-gram resolution fires on ordinary words and "alias required" needs a new engine method; grammar possessive traps; 50 labels cannot show 90%; sibling privacy surfaces; the 3-page cap can skip the busiest accounts. Low: the development stopping rule is noise-level; one PR is a lot of risk (commit per item); F4 one field; F5 time the harness first.

**Codex SAYS (eng, architecture challenge)** (codex-cli 0.160.0, `gpt-6-astra`, reasoning high; completed, `OUTSIDE_STATUS: completed provider=codex host=claude`). Full output:

```tool-output
**This plan needs revision before implementation.** I verified the product checkout at `2eb9df1c1`, reviewed the named paths and full plan, and aggregated the stored transcripts. No files were changed or tests run.

1. **High · High confidence — F6’s benchmark justification misclassifies most write failures.**  
   Across the three primary models, there were **1,243 `remember` calls: 57 UUID-validation failures (4.6%) and 177 failures after admission (14.2%)**. Those 177 calls supplied either no ID (146) or a valid UUID (31). The plan’s “19% because request_id was not a UUID” combines distinct failures. Lenient IDs cannot fix the larger group.

   **Evidence:** contrasting receipts in [transcripts.jsonl:41](/workspace/gbrain-evals/eval/reports/cat40/hard/cells-50k/transcripts.jsonl:41) and [transcripts.jsonl:78](/workspace/gbrain-evals/eval/reports/cat40/hard/cells-50k/transcripts.jsonl:78); generic failure rendering in [verb-errors.ts:110](/workspace/gbrain/src/core/persistence/verb-errors.ts:110).

   **Fix:** correct the attribution and investigate the admitted failures before assigning F6 an expected gain or declaring tool failures irrelevant. Add a write-health prerequisite alongside R0.

2. **High · High confidence — Read-time sibling merging still asserts identity from titles.**  
   Avoiding writes to `entity_identities` does not avoid retrieval contamination: unrelated companies with the same normalized subject inherit each other’s aliases and evidence. Different prefixes and a three-page cap do not establish identity. The rule also lacks precedence against manually established, separate identity groups. A 90% **alias** precision gate does not validate sibling identities.

   **Evidence:** the explicit identity boundary and manual-only rationale in [entity-identity.ts:4](/workspace/gbrain/src/core/entity-identity.ts:4); the proposed default-on rule in [plan:126](/home/user/.gstack/projects/garrytan-gbrain-evals/autoplan-eng-hfuKjz/eng-implementation.md:126).

   **Fix:** take UC1’s no-union alternative: expose candidate sibling pages and excerpts with separate attribution. Union retrieval only through explicit identity evidence, honoring existing identity groups and visibility.

3. **High · High confidence — The proposed resolver skips the exact sibling case it intends to repair.**  
   `Account sheet: X` and `CRM record: X` both derive subject alias `X`. `resolveAliases` returns both highest-precedence claims; F1.6 then skips the tie. Independently, the gazetteer drops ambiguous aliases, so documents mentioning only `X` have no corresponding mention link. Unioning existing backlinks at read time cannot recover links that were never created. Canonical titles also need a resolution arm: `resolveAliases` queries alias rows, not titles.

   **Evidence:** [aliases.ts:106](/workspace/gbrain/src/core/mentions/aliases.ts:106), [read-enrichment.ts:352](/workspace/gbrain/src/core/search/read-enrichment.ts:352), [by-mention.ts:616](/workspace/gbrain/src/core/by-mention.ts:616), and the link-only referrer query in [referrers.ts:90](/workspace/gbrain/src/core/mentions/referrers.ts:90).

   **Fix:** define one source-aware resolution policy for cards, fan-out and mentions, including exact titles and unresolved ambiguity. If explicit identity groups resolve collisions, apply that resolution before indexing and rescan affected pages. Add the two-page shared-subject fixture end to end.

4. **High · High confidence — Increasing the keyword candidate pool cannot guarantee exhaustive page retrieval.**  
   Both engines limit **chunks before page deduplication**. One long document can occupy the entire candidate pool. Sizing that pool for `offset + limit`, even with a multiplier, does not ensure that every counted page becomes reachable.

   **Evidence:** [pglite-engine.ts:1391](/workspace/gbrain/src/core/pglite-engine.ts:1391) and [pglite-engine.ts:1487](/workspace/gbrain/src/core/pglite-engine.ts:1487); equivalent Postgres behavior at [postgres-engine.ts:1060](/workspace/gbrain/src/core/postgres-engine.ts:1060).

   **Fix:** implement a dedicated exhaustive page query that selects the best matching chunk per page **before** pagination, without a preceding global chunk cap. Share matching predicates with the count, including visibility, safe projections and CJK behavior. Test a dominant page with hundreds of matching chunks followed by many other pages.

5. **High · High confidence — Evidence delivery does not preserve a pageable prefix.**  
   The keyword operation currently applies type-diversity pruning. Evidence allocation can then drop a large middle result while retaining a smaller later one. Advancing by either requested rows or delivered rows can skip pages or repeat them. Listing `omitted` slugs alone does not define a continuation algorithm. “Counts after delivery” also conflicts with an uncapped total of strict keyword matches.

   **Evidence:** [search.ts:688](/workspace/gbrain/src/core/ops/search.ts:688), [dedup.ts:147](/workspace/gbrain/src/core/search/dedup.ts:147), and [evidence-delivery.ts:685](/workspace/gbrain/src/core/search/evidence-delivery.ts:685).

   **Fix:** separate page enumeration from evidence expansion. Disable diversity pruning for exhaustive mode; retain an identity row for every enumerated page even when its evidence is omitted. Define continuation over that ordered page set and specify behavior when the index changes between calls. Test short–oversized–short sequences, mixed types and concurrent edits.

6. **High · High confidence — F6 can break existing batch idempotency during upgrade.**  
   `remember(items)` already accepts a non-UUID root ID and derives child UUIDs directly from its original bytes. Normalizing that root to UUIDv5 before child derivation changes every child ID. Replaying a previously accepted batch after upgrade can therefore admit new writes instead of returning its original receipts.

   **Evidence:** [remember-batch.ts:29](/workspace/gbrain/src/core/remember-batch.ts:29) and [remember-batch.ts:79](/workspace/gbrain/src/core/remember-batch.ts:79).

   **Fix:** specify backward-compatible batch identity resolution before changing normalization. Preserve lookup of legacy children, distinguish batch roots from individual write receipts, and test an old-version non-UUID batch replayed after upgrade through both original and canonical IDs.

7. **High · High confidence — `client_request_id` needs durable storage and exclusion from intent hashing.**  
   UUIDv5 cannot reconstruct the original string. The journal currently has no dedicated client-ID field, receipt compaction deletes `intent`, and public receipt projection explicitly selects fields. Merely adding the string to operation parameters risks including it in the intent digest, making equivalent original-string and UUID replays conflict.

   **Evidence:** [journal.ts:193](/workspace/gbrain/src/core/persistence/journal.ts:193), [journal.ts:668](/workspace/gbrain/src/core/persistence/journal.ts:668), [memory-mutations.ts:52](/workspace/gbrain/src/core/persistence/memory-mutations.ts:52), and [types.ts:130](/workspace/gbrain/src/core/persistence/types.ts:130).

   **Fix:** define durable client-ID metadata outside mutation intent; preserve it through compaction, receipt projections and engine graduation. Test restart, compaction, cancellation and cross-principal isolation. Also retain frozen verb errors: `remember` must expose `invalid_params` with additive `write_error: idempotency_conflict`, as [verb-errors.ts:136](/workspace/gbrain/src/core/persistence/verb-errors.ts:136) already does.

8. **High · High confidence — Upgrade and escape-hatch invalidation are underspecified.**  
   Binary version bumps handle an upgrade once; they do not handle later changes to `mentions.alias_deny` or `mentions.multiword_aliases` on unchanged pages. Alias refresh currently keys on content revision and derivation version. Its policy fingerprint lacks the proposed settings. Furthermore, only linkable entity pages receive alias-version watermarks: checking every page’s alias version would leave ordinary documents permanently pending.

   **Evidence:** [pass.ts:104](/workspace/gbrain/src/core/mentions/pass.ts:104), [pass.ts:214](/workspace/gbrain/src/core/mentions/pass.ts:214), [pass.ts:258](/workspace/gbrain/src/core/mentions/pass.ts:258), and [coverage.ts:57](/workspace/gbrain/src/core/mentions/coverage.ts:57).

   **Fix:** include derivation settings in invalidation, apply deny rules consistently to stored aliases and read-time fallback extraction, and count alias staleness only for eligible entities. Test setting changes on an already indexed brain, interrupted sweeps, and re-enabling previously denied aliases.

9. **High · Medium-high confidence — F3 has no defined entity or correction classifier.**  
   “Same entity” is not a property available on every search row. A page can discuss multiple entities; generated pages can contain genuine corrections or remembered facts. The plan specifies exceptions without defining how to recognize them. It also omits where demotion occurs: before reranking it may be overwritten; after limiting it cannot restore a primary record already excluded.

   **Evidence:** explicit supersession currently relies on graph edges in [hybrid.ts:726](/workspace/gbrain/src/core/search/hybrid.ts:726); reranking and result-pool selection follow at [hybrid.ts:1155](/workspace/gbrain/src/core/search/hybrid.ts:1155). Remembered facts can be published into page fences via [memory-mutations.ts:169](/workspace/gbrain/src/core/persistence/memory-mutations.ts:169).

   **Fix:** specify authoritative entity attribution, correction signals and the exact ranking stage. Prefer explicit supersession/provenance evidence; leave uncertain cases unchanged. Test multi-entity pages, generated pages containing corrections, healthy/degraded reranking, and primary evidence near the return cutoff.

10. **Medium · High confidence — F1.6 requires a new matching primitive, not just four keyword calls.**  
    Existing keyword SQL uses the same query for eligibility and ranking. It cannot directly express “this alias is mandatory; all other content terms only influence ranking.” AND-ing everything preserves the original recall failure; OR-ing everything admits unrelated entities. Searching every alias also remains a five-result sample per alias, so the card’s coverage wording needs that qualification.

    **Evidence:** the shared predicate and score query in [pglite-engine.ts:1475](/workspace/gbrain/src/core/pglite-engine.ts:1475); F1.6’s requirement in [plan:125](/home/user/.gstack/projects/garrytan-gbrain-evals/autoplan-eng-hfuKjz/eng-implementation.md:125).

    **Fix:** design separate required-alias and ranking-term inputs, with phrase/code escaping and both-engine parity. Report per-alias result truncation and provide an exhaustive continuation; distinguish “alias queried” from “all evidence retrieved.”

11. **Medium · High confidence — `publicBody` can re-expose withdrawn world facts in the new excerpt.**  
    The proposed excerpt explicitly uses `publicBody`. That helper retains world-visible facts, and `stripFactsFence` filters only visibility. The canonical remote sanitizer additionally excludes forgotten facts. Consequently, the new excerpt can surface withdrawn text retained in a facts fence even though normal remote evidence delivery suppresses it.

    **Evidence:** [aliases.ts:71](/workspace/gbrain/src/core/mentions/aliases.ts:71), [facts-fence.ts:710](/workspace/gbrain/src/core/facts-fence.ts:710), versus [remote-body.ts:34](/workspace/gbrain/src/core/remote-body.ts:34).

    **Fix:** derive excerpts from the canonical sanitized public projection before selecting or slicing lines. Add forgotten-fact and malformed-fence fixtures alongside the accepted private-fence tests.

12. **Medium · High confidence — Both F4 alternatives still risk assigning the wrong meaning to the date.**  
    `effective_date` is not uniformly a document date: it can come from an event date, publication date, filename or creation fallback. Copying it to `page_date`, or always labelling it “document date,” creates another misleading assertion.

    **Evidence:** [effective-date.ts:4](/workspace/gbrain/src/core/effective-date.ts:4); the existing lean projection at [lean-rows.ts:26](/workspace/gbrain/src/core/search/lean-rows.ts:26).

    **Fix:** retain the value and expose `effective_date_source`, with source-dependent wording and an explicit fallback label. Do not imply contractual validity. Resolve UC3 against these actual derivation semantics.

13. **Medium · High confidence — Confirmation may test a different build from the final development round.**  
    The plan freezes this PR’s code after development, but then specifies merging with current master for confirmation. Unmeasured master changes can alter retrieval, migrations or latency. The historical benchmark itself used `c5fb0201`, not the reviewed `2eb9df1c1`, making explicit build attribution especially important.

    **Evidence:** [plan:137](/home/user/.gstack/projects/garrytan-gbrain-evals/autoplan-eng-hfuKjz/eng-implementation.md:137), [plan:147](/home/user/.gstack/projects/garrytan-gbrain-evals/autoplan-eng-hfuKjz/eng-implementation.md:147), and [experiment.json:3](/workspace/gbrain-evals/eval/reports/cat40/hard/cells-50k/experiment.json:3).

    **Fix:** merge master before final development validation, then pin that exact build through confirmation. Any subsequent product change requires renewed validation. Resolve UC2’s endpoint before preregistration; a pending alternative is not an executable decision rule.

Recommendation: Revise before implementation or paid runs because identity resolution and exhaustive paging remain internally inconsistent, batch normalization risks duplicate writes, and most H5 write failures are incorrectly attributed to UUID validation.
```

ENG DUAL VOICES — CONSENSUS TABLE:

| Dimension | Claude | Codex | Consensus |
|---|---|---|---|
| 1. Architecture sound? | direction sound; three mechanisms missing | not yet: resolver skips the sibling case, gazetteer drops the shared subject | CONFIRMED (not yet sound) |
| 2. Test coverage sufficient? | gaps: privacy, cap share, upgrade without sweep | gaps: dominant-page paging, batch replay, settings changes | CONFIRMED (gaps) |
| 3. Performance risks addressed? | no: unbounded count and offsets, coverage scans | no: chunk-capped pool | CONFIRMED (no) |
| 4. Security threats covered? | partly: sibling alias leakage, cache key | partly: forgotten facts in the excerpt | CONFIRMED (partly) |
| 5. Error paths handled? | partly: conflict copy | no: 177 opaque write failures misattributed | CONFIRMED (partly) |
| 6. Deployment risk manageable? | yes with commit-per-item and coverage counter | at risk: batch idempotency, build attribution | DISAGREE → taste (resolved: both remedies accepted; recorded as C19) |

Single-voice criticals: none. Codex-only high findings verified in code and accepted: the 177 admitted write failures (rca re-check: 177 "did not commit", 57 UUID refusals), the gazetteer `alias_collision` drop (`src/core/by-mention.ts`, `claim.slugs.size > 1`), the tie skip in F1.6, `childRequestId` deriving from the original root string (`src/core/remember-batch.ts:29`), forgotten facts surviving `publicBody`, and build attribution. Native-only findings accepted: offset cap and count cap, O(1) coverage counter, n-gram precision guards, possessive guards, statistics of the precision gate, cap-share reporting, commit per item, F5 harness timing. Native F6 reuse concern checked against data: 0 of 31 cells with writes reused an id for a different write and no id was under 8 characters, so the minimum drops to 1 and the conflict copy stays as DX specified. Both voices object to F3's `author: agent:*` trigger: UC4.

#### Eng review sections

**Section 1: Architecture.** 5 issues (all decided above: sibling group as one gazetteer target, tie resolution, page-grain keyword query, coverage counter, durable `client_request_id`).

```
                        MCP entity                         MCP search                          MCP remember / write ops
                            |                                  |                                       |
                   buildEntityCard (entity-card.ts)    search op (ops/search.ts)              request_id normalizer (NEW, op boundary)
                     | arm1 alias / arm2 exact+suffix     | hybridSearchCached ---- rerank          | UUID passthrough / UUIDv5(original)
                     v                                    |   (R0 reason in degraded_recall)        | client_request_id column (NEW, migration)
            siblingResolver (NEW, one module) <-----------+-- resolveQueryEntity (NEW: n-grams,     v
              same source/type, not person, <=3,          |      titles+aliases, case, longest)   persistence journal (principal, request_id)
              alias_deny / identity: separate             |-- fan-out: alias-required method (NEW,  remember-batch childRequestId(original root)
                     |                                    |      both engines), <=4 x 5, cap 8
            assembleCard: aka (string[]), aka_sources,    |-- keyword count (NEW: shared WHERE,
              identity_excerpt (remote-body.ts),          |      LIMIT 10001, timeout, parallel)
              identity_siblings{pages,capped}             |-- match:"keyword" page-grain query (NEW,
                     |                                    |      keyset next, no diversity prune)
            referrers.ts (co-member path, sibling ids)    v
                                                     evidence delivery (enumeration kept separate)
                                                          v
                                                     searchOutput -> _meta + model-visible count line (dispatch.ts)

 aliases.ts grammar (spec, possessive guards) -> deriveEntityAliases -> page_aliases -> buildGazetteer
     (sibling group = one target, alias kept) -> mention links -> referrers
 version bumps / policy fingerprint (alias_deny, multiword, sibling_merge) -> mention_index_status.pending counter -> coverage notice
```

Realistic production failures: two unrelated companies with the same name in one source merge (mitigated by UC1, type equality, cap, `identity: separate`, `extract mentions --explain`); a 1M-page brain rescans after upgrade (counter keeps reads O(1); sweep runs in the background); a remote agent pages keyword results in a loop (offset cap, keyset); rerank provider degraded (notice now names the reason).

**Section 2: Code quality.** 3 issues. (1) One sibling resolver shared by card, fan-out and gazetteer (no per-caller copies; shared-code rubric: three proposed callers, one contract). (2) The count and row queries share one WHERE builder per engine (prevents drift that would count invisible rows). (3) Stale diagrams: the `aliases.ts` header comment and `docs/architecture/key-files/entity-recall.md` list the alias keywords and the single-token rule; both must change with the grammar.

**Section 3: Test review.** Framework: bun test (`test/`, E2E tier under `test/e2e/`, both engines via the DATABASE_URL-gated parity suites, per CLAUDE.md and docs/TESTING.md).

```
CODE PATHS                                                       USER FLOWS (agent over MCP)
[+] mentions/aliases.ts grammar                                  [+] Name → card → search → nickname records
  ├── [GAP] each convention, multi-word, possessive guard          └── [GAP] [→E2E] calibration-like fixture, both engines
  ├── [GAP] negative fixtures (common words, other-entity alias) [+] Keyword enumeration
  └── [GAP] ReDoS time-bounded input                                └── [GAP] [→E2E] walk to total with dominant page
[+] siblingResolver (NEW)                                        [+] Write with opaque id
  ├── [GAP] sheet+CRM merge; people same/different prefix          ├── [GAP] [→E2E] save, replay, get by original string
  ├── [GAP] 4-page cap; identity: separate; exclude_slugs          └── [GAP] old batch replay after upgrade
  └── [GAP] private sibling for remote caller                    [+] Upgrade
[+] by-mention gazetteer (group target, collision kept)            └── [GAP] [→E2E] bump with no manual sweep; pending then clear
  └── [GAP] [→E2E] subject-only document in referenced_by       [+] Error states
[+] entity-card excerpt / aka_sources / guidance                    ├── [GAP] remember failure names its cause (R1)
  ├── [GAP] unknown label below 600 chars of fields                 ├── [GAP] count unavailable → degraded stage
  ├── [GAP] forgotten fact, private fence, malformed fence           └── [GAP] next/offset outside keyword mode refused
  └── [GAP] starter vs verbs surface guidance
[+] ops/search fan-out + resolveQueryEntity
  ├── [★★ TESTED] first-declaration fan-out (existing; rewrite)
  ├── [GAP] tie → group; lowercase word no fan-out; cap 8
  └── [GAP] alias-required method parity (both engines)
[+] keyword count + match:"keyword"
  ├── [GAP] OR-only query total 0; LIMIT 10001; timeout path
  └── [GAP] keyset next; mid-walk write; offset cap
[+] lean-rows: matched_alias / provenance / effective_date_source  [GAP]
[+] coverage counter + policy fingerprint                         [GAP] settings change, interrupted sweep, re-enable
[+] interop-notices rerank reason                                 [GAP] per reason
[+] persistence normalizer + client_request_id + migration        [GAP] restart, compaction, cancel, cross-principal, uppercase UUID
[+] F3 demotion stage                                             [GAP] multi-entity, correction, degraded rerank, cutoff
Benchmark-level: [→EVAL] alias-coverage proxy, sibling count and cap share (free); BrainBench compare and eval gate (free);
                 Cat 40 v1 no-regression incl. family B (paid, ~$25); development rounds and confirmation (paid, gated)

COVERAGE: 1/38 paths tested today (the rest are new)  |  QUALITY: ★★:1  |  GAPS: 37 (8 E2E, 3 eval)
```

Every gap above maps to a required test in the accepted obligations of CEO, DX or Eng; none is deferred. LLM/eval scope: tool descriptions change (`search`, possibly `entity`), which CLAUDE.md treats as prompt surface, so the schema-budget test and the Cat 40 v1 no-regression run are required, plus BrainBench. Test plan artifact: `/home/user/.gstack/projects/garrytan-gbrain-evals/user-plan-cat40-hard-fix-eng-review-test-plan-20261007-202619.md`. Regression rule: the existing fan-out behavior (family B) is at risk when it moves to keyword-only; the v1 no-regression run must include family B and the existing fan-out test is rewritten, not deleted.

**Section 4: Performance.** 4 issues, all decided: uncapped count (capped, parallel, timeout); offset growth (keyset, cap 10,000); coverage scan (O(1) counter); fan-out on PGLite's single connection (one call above 150 ms p50). Memory: excerpt capped at 1,200 characters per card; spliced rows capped at 8.

#### Eng required outputs

**NOT in scope (Eng).** Owner-phrase resolution, H5 merge chains, notice hygiene, LLM alias extraction, scale-ladder eval, starter onboarding walkthrough, fresh-install timing, alias preview command (all TODOS); a persisted sibling-group table (not needed: read-time resolution plus gazetteer targets).

**What already exists (Eng).** See Step 0's table; reused: `aliases.ts` parser, `buildGazetteer`, version-keyed stale sweep, `referrers.ts` co-member path, `searchKeyword` predicates, notice-block channel, `childRequestId`, `remote-body.ts`, schema-budget test, BrainBench and `gbrain eval gate`.

**Failure modes registry.**

| Codepath | Failure | Test | Error handling | Agent sees | Critical gap |
|---|---|---|---|---|---|
| siblingResolver | wrong merge | negative fixtures | `identity: separate`, explain | `identity_siblings` listed | no |
| gazetteer group target | subject mentions still dropped | E2E fixture | rescan via version bump | coverage notice until swept | no |
| fan-out resolution | noise rows on common words | lowercase test, cap | guards | `fanout` lists aliases | no |
| keyword count | slow count | timeout test | degraded stage | "count unavailable" | no |
| keyword paging | skipped pages | dominant-page test | page-grain query, keyset | `next`, `truncated` | no |
| coverage counter | stuck pending | no-sweep upgrade test | autopilot starts sweep | pending notice | no |
| F6 normalizer | batch replay duplicates | old-batch test | original-root derivation | same receipts | no |
| client_request_id | lost on compaction | compaction test | stored outside intent | field present | no |
| remember (R1) | opaque failure | regression test | specific reason | cause and fix | no |
| excerpt | forgotten fact shown | fixture | remote-body sanitizer | nothing withdrawn | no |
| F3 demotion | correction demoted | fixture | supersession exemption | correction ranks first | no |

Critical gaps: 0 (every row has a test and visible handling).

**Worktree parallelization.**

| Step | Modules touched | Depends on |
|---|---|---|
| A grammar + gazetteer + sibling resolver | `src/core/mentions/`, `src/core/by-mention.ts` | — |
| B card fields + excerpt | `src/core/verbs/` | A |
| C search fan-out + keyword mode + counts | `src/core/ops/`, `src/core/search/`, engines | A (resolver) |
| D persistence (F6, R1, migration) | `src/core/persistence/`, `src/core/remember-batch.ts`, migrations | — |
| E notices + coverage counter | `src/core/mentions/coverage.ts`, `src/core/interop-notices.ts` | A |
| F docs, behavior changes, CHANGELOG | `docs/`, `src/core/behavior-change-notice.ts` | B, C, D |

Lanes: Lane 1 A → B and E; Lane 2 C after A's resolver interface lands; Lane 3 D independent. Launch A and D together; after A's interface merges, run B, C, E; F last. Conflict flag: A and E both touch `src/core/mentions/`; sequence them.

#### Eng implementation tasks

- [ ] **T21 (P1, human: ~1d / CC: ~1h)** — gbrain persistence — R1: reproduce and fix the 177 admitted `remember` failures; specific failure reasons
  - Surfaced by: Codex finding 1 (verified: 177 "did not commit", 57 UUID refusals)
  - Files: `src/core/persistence/verb-errors.ts`, `src/core/persistence/service.ts`, tests
  - Verify: regression test; calibration-slot failure rate
- [ ] **T22 (P1, human: ~6h / CC: ~40min)** — gbrain mentions — sibling group as one gazetteer target; tie resolution; titles in resolution
  - Surfaced by: Codex finding 3
  - Files: `src/core/by-mention.ts`, sibling resolver, `src/core/search/read-enrichment.ts`, tests
  - Verify: two-page shared-subject E2E fixture
- [ ] **T23 (P1, human: ~1d / CC: ~1h)** — gbrain engines — page-grain keyword query, keyset `next`, capped parallel count with shared WHERE builder
  - Surfaced by: both voices, Section 4
  - Files: `src/core/pglite-engine.ts`, `src/core/postgres-engine.ts`, `src/core/ops/search.ts`, tests
  - Verify: dominant-page and mid-walk tests on both engines
- [ ] **T24 (P1, human: ~6h / CC: ~40min)** — gbrain engines — alias-required ranking method; fan-out guards and cap
  - Surfaced by: both voices
  - Files: both engines, `src/core/ops/search.ts`, tests
  - Verify: parity tests; lowercase-word and cap tests
- [ ] **T25 (P1, human: ~4h / CC: ~30min)** — gbrain persistence — `client_request_id` column + migration + inventory; batch compatibility
  - Surfaced by: both voices
  - Files: `src/core/persistence/journal.ts`, `src/core/remember-batch.ts`, `src/core/schema-migrations/`, `src/core/persistence/graduation-inventory.ts`, tests
  - Verify: restart, compaction, old-batch replay tests
- [ ] **T26 (P2, human: ~3h / CC: ~20min)** — gbrain mentions — O(1) coverage counter; policy fingerprint includes new settings
  - Surfaced by: both voices
  - Files: `src/core/mentions/coverage.ts`, `src/core/mentions/pass.ts`, tests
  - Verify: no-sweep upgrade and settings-change tests
- [ ] **T27 (P2, human: ~3h / CC: ~20min)** — gbrain search — F3 stage and classifier (trigger set per UC4)
  - Surfaced by: both voices
  - Files: `src/core/search/source-boost.ts`, `src/core/search/hybrid.ts`, tests
  - Verify: the four ranking fixtures
- [ ] **T28 (P2, human: ~1h / CC: ~10min)** — gbrain card — excerpt from `remote-body.ts`
  - Surfaced by: Codex finding 11
  - Files: `src/core/verbs/entity-card.ts`, tests
  - Verify: forgotten-fact fixture
- [ ] **T29 (P1, human: ~2h / CC: ~15min)** — gbrain CI — BrainBench compare, eval gate and v1 family B in the PR
  - Surfaced by: Scope finding 1
  - Files: PR description, `.gbrain-evals/` results
  - Verify: numbers recorded
- [ ] **T30 (P2, human: ~1h / CC: ~10min)** — gbrain-evals — development record: proxies-first gate, cap share, precision bound, harness timing, build SHA
  - Surfaced by: native findings 8, 10, 11, 14; Codex finding 13
  - Files: development record, preregistration addendum
  - Verify: fields present

#### Eng completion summary

- Step 0: Scope Challenge — scope accepted as-is (8-file gate tripped; no cuts under autoplan P2; original arrangement)
- Architecture Review: 5 issues found
- Code Quality Review: 3 issues found
- Test Review: diagram produced, 37 gaps identified (all mapped to required tests)
- Performance Review: 4 issues found
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 8 items proposed (to be filed in gbrain by the implementing thread; this review did not edit gbrain)
- Failure modes: 0 critical gaps flagged
- Unresolved decisions: 1 in this review (UC4), plus UC1, UC2, UC3, C4, C9, C16 carried from earlier phases
- Outside voice: codex (gpt-6-astra), completed, 13 findings
- Parallelization: 3 lanes, 2 parallel at start / 4 steps sequential behind A
- Lake Score: N/A (no coverage-scored question was asked)

#### Eng accepted obligations

<!-- autoplan-accepted:eng -->
- R1, write health before paid cells: reproduce the 177 admitted-then-failed `remember` writes from the held-out transcripts' arguments on a calibration-world slot (free; replaying stored arguments diagnoses a failure and tunes nothing), find the cause and fix it in gbrain in this wave; the failed receipt and the error carry the specific cause to remote callers (redacting only private content) instead of "Inspect its durable request on the source host". Verify: a regression test for the cause; the development record reports the `remember` failure rate before and after on the calibration slot.
- Same-subject names in the mention index: today `buildGazetteer` drops a subject alias claimed by two pages at the same origin (`alias_collision`, `src/core/by-mention.ts`), so documents that name an account only by its name link to neither the account sheet nor the CRM record. When a sibling group merges, the group is one gazetteer target (its card page, chosen as `buildEntityCard` chooses it) and the colliding subject alias is kept; affected pages rescan through the version bump. Verify: an end-to-end two-page shared-subject fixture where a document that names only the subject appears in the card's `referenced_by`.
- Fan-out resolution (refines the CEO F1.6 requirement): a tie between pages of one sibling group resolves to the group instead of being skipped; exact page titles resolve as well as alias rows; `case_sensitive` aliases match only as written; the longest n-gram match wins and shorter n-grams inside it are dropped; fan-out fires only for capitalized or code-shaped n-grams or an n-gram that resolves to exactly one entity; spliced rows are capped at 8 per call. "Alias required, other terms ranking only" is a new engine method on both engines (required alias phrase with escaping for codes and punctuation, ranking against the other terms), not four ordinary keyword calls; each alias's 5-row truncation is reported in `fanout`, and the card says aliases were queried, not that all evidence was retrieved. On PGLite the alias queries run in one call when four separate calls exceed 150 ms at p50 on the calibration slot. Verify: tests that a lowercase common word does not trigger fan-out, that a sibling tie fans out, that spliced rows stop at 8, and both-engine parity tests for the new method.
- Keyword mode implementation (refines the DX search requirement): `match: "keyword"` uses a dedicated page-grain query (best chunk per page before pagination, no global chunk cap) with a keyset cursor (score, page id) inside `next`; any offset path is capped at 10,000; diversity pruning is off in keyword mode; page enumeration is separate from evidence expansion, so every enumerated page keeps a row (with `evidence_omitted: true` when its text did not fit) and `next` continues after the last enumerated page. The strict-match count runs in parallel with a statement timeout, is capped (`LIMIT 10001`, shown as "10000+"), and shares one WHERE builder with the row query (visibility, safe projections, CJK handling); a timeout yields the unavailable-count degraded stage. This replaces the DX wording "counts and paging are computed after deduplication and evidence delivery". Verify: both-engine tests with a dominant page of hundreds of matching chunks followed by many pages, a short-oversized-short sequence, mixed types, a write landing mid-walk, and a remote caller paging to the cap.
- Coverage cost and invalidation (refines the DX version-aware coverage requirement): on a version bump, `mention_index_status.pending` is set once to the source's eligible page count and decremented by the sweep, so card reads stay O(1); alias staleness counts only linkable entity pages; the policy fingerprint includes `mentions.alias_deny`, `mentions.multiword_aliases` and `mentions.sibling_merge`, so changing them marks affected pages due; autopilot and `post-upgrade` start the sweep. Verify: upgrade test with no manual sweep, a settings-change test on an indexed brain, an interrupted-sweep test, and a re-enable-denied-alias test.
- F6 storage and compatibility (refines the CEO and DX F6 requirements): `client_request_id` is stored durably outside the intent digest (a nullable column on `persistence_requests`, a migration whose number is taken when the PR is next to merge, and a graduation-inventory column entry), kept through receipt compaction and projection; `remember(items)` keeps deriving child ids from the original root string (`childRequestId` in `src/core/remember-batch.ts`), so a batch accepted before the upgrade replays to the same receipts; `remember` keeps its frozen error shape (`invalid_params` with additive `write_error: idempotency_conflict`); the minimum id length is 1, because the held-out transcripts show no id reuse for a different write (0 of 31 cells with writes) and no id shorter than 8 characters. Verify: tests for restart, compaction, cancellation, cross-principal independence, an uppercase UUID passing unchanged, and an old non-UUID batch replayed after upgrade by original and canonical ids.
- F3 classifier and stage (applies whichever trigger set UC4 settles): demotion is a score factor in the same stage as source boosts, before reranking and before the result pool is cut; "same entity" means the generated row and a primary row in the pool link to, or were fanned out from, the same resolved entity page; with no resolved entity nothing moves; "correction" means a page whose facts fence or frontmatter records a supersession, and such pages are never demoted. Verify: tests for multi-entity pages, generated pages holding corrections, healthy and degraded reranking, and a primary record near the pool cutoff.
- Excerpt sanitization (refines the CEO F1.5 requirement): the excerpt is cut from the canonical remote-sanitized body (`src/core/remote-body.ts`), which also drops forgotten facts, not from `publicBody`. Verify: forgotten-fact and malformed-fence fixtures.
- Grammar precision guards: an unquoted capture ends at a possessive `'s`, a capture followed by a possessive is rejected, and negative fixtures cover capitalized common words (weekdays, months, "the Board", "Finance", "Legal", "Q3 Plan") and a page that declares another entity's alias ("our competitor, also known as ..."). Verify: those fixtures.
- Precision gate statistics (replaces the CEO 50-alias, 90% rule): label at least 150 derived aliases on the real brain, or gate on a Wilson 95% lower bound of 85% or more. Verify: the labelled count and bound in the development record.
- Sibling-cap reporting: the firing check also reports the share of capped groups and their prefixes; more than 10% of account groups capped stops development until explained. Verify: the share is in the development record.
- Sibling privacy: a remote-caller test shows a private sibling's declared alias in none of `matched_alias`, `fanout`, `aka_sources`, `identity_excerpt` or `keyword_total`; the `hybridSearchCached` key includes caller visibility or fan-out bypasses the cache for remote callers; text inside private takes or facts fences is not counted in `keyword_total`. Verify: those tests.
- Development gate (refines the CEO stopping rule): the primary development gate is the mechanism proxies (nickname seen and queried, share of needed documents seen, alias-coverage proxy) plus no family regressing against round 0; the pooled cell estimate (+3 buffer) is reported as a sanity check with its interval, and the memo says plainly that 100 paired cells cannot separate +3 from noise. Verify: the record shows the proxies, per-family results and the interval.
- Build attribution (refines the CEO confirmation rule): master is merged into the branch before the final development round, and that exact build, pinned by SHA, runs confirmation; any later product change needs a new development round before confirmation. Verify: the preregistration names the SHA used in both.
- Merge gates for every user: `gbrain eval brainbench --compare evals/brainbench/baselines/main.json` (deterministic, free) holds or improves, with any drop justified in the PR (`docs/eval/BRAINBENCH.md` merge rule), and the retrieval canary `gbrain eval gate` runs on a non-production brain, both recorded in the PR next to the Cat 40 v1 no-regression run, which must include family B (the existing fan-out moves from hybrid to keyword). Verify: the numbers in the PR.
- Delivery shape: one batched PR as the house rule requires, with each F item, R0 and R1 in its own commit carrying its own tests, so one item can be reverted alone. Verify: the commit list.
- F5 order: before profiling gbrain, the development record times MCP process start, the default `wait_ms` on writes and the model's retries per cell. Verify: those three numbers in the record.
- TODOS to file in gbrain (this review did not edit gbrain): owner-phrase resolution with validity windows; H5 merge-chain recall with its acceptance gate; notice hygiene for unattended agents; opt-in LLM alias extraction; a scale-ladder eval above 200k documents (gbrain-evals); a `starter`-surface onboarding walkthrough; a timed fresh-install check; a read-only alias preview before an upgrade. Verify: the PR description lists them as filed.
<!-- /autoplan-accepted:eng -->

#### Eng baseline edits (exact replacements applied to the plan body)

<!-- autoplan-baseline-edits:eng {"sourceSha256":"5bcb789f9c517fb05c3caf6a2301379436ea17eef659f5f83ceae17593f9d2d6","replacements":[{"oldText":"19% of all `remember` calls failed with `invalid_params` because `request_id` was not a UUID (27% in the lost H5 cells).","newText":"19% of all `remember` calls failed with `invalid_params` (autoplan Eng correction: only 57 of 1,243, 4.6%, were the non-UUID `request_id` refusal; 177, 14.2%, were writes admitted and then failed with the opaque \"The write did not commit. Inspect its durable request on the source host.\", whose cause even `get_write_request` does not show; 146 of those carried no `request_id` at all, and most came from Sonnet 5.5 cells)."},{"oldText":"Pages a machine wrote, either authored by an agent (`author: agent:*`) or typed as an auto-summary, rank below primary records for the same entity.","newText":"Pages a machine wrote, either authored by an agent (`author: agent:*`) or typed as an auto-summary, rank below primary records for the same entity. Both Eng voices found that nothing in gbrain stamps or reads `author: agent:*` (it is the generator's convention) and recommend demoting only on gbrain-owned markers (`dream_generated: true`, `type: extract_receipt`) unless `agent:` is first documented as a gbrain convention (user challenge UC4 at the final gate; the draft's direction stands until Garry decides). Under the gbrain-owned triggers alone F3 would not touch the benchmark's agent notes, so its expected points would be 0."},{"oldText":"| C16 gbrain-plus-fs arm | not run | run on development (about $45) |","newText":"| C16 gbrain-plus-fs arm | not run | run on development (about $45) |\n| UC4 F3 trigger | `author: agent:*` or auto-summary types | only gbrain-owned markers unless `agent:` becomes a documented convention |"},{"oldText":"F1 +2 to +4, F2 0 to +2, F3 0 to +1, F6 0 to +1.","newText":"F1 +2 to +4, F2 0 to +2, F3 0 to +1, F6 with the R1 write-health fix 0 to +1."}]} -->

<!-- AUTONOMOUS DECISION LOG -->
### Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| 1 | CEO | Mode SELECTIVE EXPANSION | Mechanical | autoplan override | the plan adds capability to an existing system | HOLD, EXPANSION, REDUCTION |
| 2 | CEO | Correct root-cause table (alias ~20 cells, H5 split out, F3 3 cells, rerank unmeasured) | Mechanical | P1 | `rca4.py` reproduction | keep the draft table |
| 3 | CEO | F1 approach option C (spec grammar, excerpt, fan-out, sibling read-time) | Mechanical | P1, P5 | covers both phrasing families; keeps #4224 posture | A (draft), B (siblings only) |
| 4 | CEO | F1.2 as read-time sibling merge, not `entity_identity.union` | Taste (reopened as UC1) | P5 | manual-only identity table; default-on for every user | default-on union |
| 5 | CEO | Defer owner phrases (F1.3) | Taste | P3 | no existing extractor; draft's own fallback | build now |
| 6 | CEO | F2 on the default path, remote-safe exact option, defined `total` and paging | Mechanical | P1 | keyword mode is operator-only; pool cap | keyword-mode-only totals |
| 7 | CEO | Accept E1 identity excerpt | Mechanical | P1, P2 | phrasing-independent, in blast radius | none |
| 8 | CEO | Accept E2 fan-out over every alias | Mechanical | P2 | code-only misses | first declaration only |
| 9 | CEO | Accept E3 / F6 lenient `request_id` | Mechanical | P2 | 19% write failures | keep UUID-only |
| 10 | CEO | Accept E4 / R0 rerank check | Mechanical | P1 | 230 of 300 cells | ignore |
| 11 | CEO | Defer E5 notice hygiene | Mechanical | P3 | no causal evidence | build now |
| 12 | CEO | Defer E7 H5 merge chains, with a gated follow-up | Mechanical | P3 | needs own design; both voices | build now |
| 13 | CEO | Accept E8, E9 (coverage statement, `matched_alias`) | Mechanical | P1 | explicit coverage | none |
| 14 | CEO | Cost table rebuilt from the ledger (~$1,715) | Mechanical | P1 | $519 measured basis | $2,060 unexplained |
| 15 | CEO | Opus fs comparator completion; oracle on fresh worlds | Mechanical | P1 | 32 of 50 Opus fs cells | Sonnet-only comparator |
| 16 | CEO | Spec review fixes, rounds 1 to 3 (41 issues) | Mechanical | P1, P5 | reviewer findings verified against code | leave open |
| 17 | CEO | Confirmation spend authorized after the development record | Taste | P6 | expected outcome is a kill | unconditional; hard gate |
| 18 | CEO | Expected points +2 to +8 | Mechanical | P1 | both voices; turn-cap wash | +4 to +10 |
| 19 | CEO | Publication language with a −3 non-inferiority margin; sealed needed for a general claim | Mechanical | P1 | both voices | point estimate only |
| 20 | CEO | Development baseline (unchanged master), +3 stopping buffer, GPT slice | Mechanical | P1 | both voices | no baseline |
| 21 | CEO | Narrow F3 to cases with a competing primary record | Mechanical | P5 | both voices | demote all generated pages |
| 22 | CEO | Do not ship F6 alone | Mechanical | house rule | one batched PR; not master-red or security | standalone PR |
| 23 | CEO | Exploratory gbrain-plus-fs arm | Taste | P1 vs P3 | cheap, informs positioning, adds an arm | skip |
| 24 | CEO | Real-brain precision gate (90%) for multi-word capture | Mechanical | P1 | both voices | ship ungated |
| 25 | CEO | H5 scope statement and gated follow-up | Mechanical | P3 | both voices | silent deferral |
| 26 | CEO | UC1: no identity union on title alone | User Challenge | — | both voices recommend changing the draft's F1.2 | auto-decide (forbidden) |
| 27 | CEO | UC2: sealed set co-primary | User Challenge | — | both voices recommend changing the draft's endpoint | auto-decide (forbidden) |
| 28 | CEO | R0 caveat on the published report if environment cause | Mechanical | P1 | honesty | development record only |
| 29 | CEO | Caps visible; portability fixtures | Mechanical | P1 | Codex | silent caps |
| 30 | CEO | F5 120-second target reported; adoption metrics in the report | Mechanical | P1 | both voices | latency unreported |
| 31 | DX | Mode DX POLISH; persona = frontier agent plus harness developer | Mechanical | autoplan override, P6 | enhancement to an existing product | EXPANSION, TRIAGE |
| 32 | DX | Agent-clock target: alias set in 2 calls (Champion) | Mechanical | P5 | fewer steps | current 3 to 4 |
| 33 | DX | Magical moment via the entity card payload | Mechanical | P5 | existing capability | new tool |
| 34 | DX | Counts named `keyword_total` / `keyword_truncated`; option `match: "keyword"`; `total`/`truncated`/`next` in keyword mode | Mechanical | P5 | both voices; matches `get_backlinks` words | `total`/`has_more`/`next_offset`; `keyword_only` |
| 35 | DX | Model-visible count line; paging after evidence delivery with `omitted` | Mechanical | P1 | `_meta` is not model-visible | `_meta` only |
| 36 | DX | Lean rows keep new fields; `provenance` only as `generated` | Mechanical | P1 | lean projection drops them | full rows only |
| 37 | DX | Surface-aware card guidance; no re-search of fanned-out aliases | Mechanical | P5 | `verbs` surface lacks `search`; turn cost | static guidance |
| 38 | DX | Structured `fanout`, `identity_siblings`, `aka_sources` (aka stays string[]) | Mechanical | P5 | frozen `aka` type | flat flags |
| 39 | DX | Version-aware coverage and upgrade ETA | Mechanical | P1 | coverage misses bumps on unchanged pages | rely on sweep |
| 40 | DX | Rerank notice carries reason, count and fix | Mechanical | P1 | both voices | development record only |
| 41 | DX | F6: `request_id` stays UUID, add `client_request_id`; strings, scope, conflict copy | Mechanical | P5 | frozen `MEMORY_VERBS_v1` meaning | echo original as `request_id` |
| 42 | DX | Exact error copy for new paths | Mechanical | P1 | operator contract | unspecified |
| 43 | DX | Docs set (alias guide, verbs doc, key files, behavior changes, CHANGELOG, llms) | Mechanical | P1 | both voices | code-only |
| 44 | DX | Escape hatches (alias deny, multi-word off, identity separate, fan-out max, demotion off) | Mechanical | P1, P2 | default-on behavior needs overrides | none |
| 45 | DX | Explain output for aliases and siblings | Mechanical | P2 | extends existing command | new command |
| 46 | DX | DX measures in the development record; RCA runbook | Mechanical | P1 | boomerang check | none |
| 47 | DX | Defer starter walkthrough and fresh-install timing to TODOS | Mechanical | P3 | outside this wave's surface | build now |
| 48 | DX | UC3: one date field labelled, `effective_date_source` exposed, no `page_date` | User Challenge | — | both voices recommend changing the draft's F4 rename | auto-decide (forbidden) |
| 49 | Eng | Scope challenge: accept as-is, original arrangement (8-file gate tripped) | Mechanical | P2 override | never reduce; one batched PR is a house rule | cut features |
| 50 | Eng | Add BrainBench compare and `gbrain eval gate` as merge gates | Mechanical | P1 | `docs/eval/BRAINBENCH.md` merge rule | none |
| 51 | Eng | R1: fix the 177 admitted `remember` failures; specific reasons | Mechanical | P1 | Codex finding verified in transcripts | treat as UUID problem |
| 52 | Eng | Correct the 19% attribution in the root-cause table | Mechanical | P1 | 57 UUID refusals vs 177 admitted failures | keep draft figure |
| 53 | Eng | Sibling group as one gazetteer target; keep colliding subject alias | Mechanical | P1 | `alias_collision` drop would defeat the merge | read-time union only |
| 54 | Eng | Fan-out: tie resolves to group, titles resolve, case-sensitive, longest match, shape guard, cap 8, new engine method | Mechanical | P5, P1 | both voices | four plain keyword calls |
| 55 | Eng | Keyword mode: page-grain query, keyset `next`, offset cap, capped parallel count, shared WHERE | Mechanical | P1, P5 | both voices; chunk-capped pool | pool resizing |
| 56 | Eng | Coverage O(1) counter; fingerprint includes new settings | Mechanical | P1 | both voices | per-read scan |
| 57 | Eng | F6: stored `client_request_id` + migration; batch root compatibility; min length 1 | Mechanical | P1 | both voices; reuse data shows 0 conflicts | 8-char minimum, op-params echo |
| 58 | Eng | F3: stage before rerank; same-entity and correction defined | Mechanical | P5 | both voices | undefined classifier |
| 59 | Eng | UC4: F3 triggers only on gbrain-owned markers | User Challenge | — | both voices recommend changing the draft's `author: agent:*` rule | auto-decide (forbidden) |
| 60 | Eng | Excerpt from `remote-body.ts` | Mechanical | P1 | forgotten facts survive `publicBody` | publicBody |
| 61 | Eng | Grammar possessive guards and negative fixtures | Mechanical | P1 | native finding | none |
| 62 | Eng | Precision gate: 150 labels or Wilson lower bound 85% | Mechanical | P1 | 50 labels cannot show 90% | 50 at 90% |
| 63 | Eng | Sibling cap share reported; >10% stops development | Mechanical | P1 | native finding | zero-only stop |
| 64 | Eng | Sibling privacy tests and cache key | Mechanical | P1 | native finding | excerpt-only test |
| 65 | Eng | Development gate on mechanism proxies; cell estimate as sanity check | Mechanical | P5 | 100 paired cells too noisy | +3 cell gate |
| 66 | Eng | Merge master before final development round; pin that SHA through confirmation | Mechanical | P1 | Codex finding 13 | merge at confirmation |
| 67 | Eng | Commit per F item inside the one PR | Mechanical | P3 | house rule kept, revert granularity gained | split PRs |
| 68 | Eng | F5: time MCP start, `wait_ms`, retries before profiling gbrain | Mechanical | P3 | 79 s unexplained | profile gbrain first |
| 69 | Eng | Collect all deferrals into a gbrain TODOS list for the implementer | Mechanical | P3 | review does not edit gbrain | edit gbrain TODOS now |
| 70 | Eng | Deployment-risk disagreement resolved by accepting both voices' remedies | Taste | P1 | Claude: manageable; Codex: at risk; remedies do not conflict | pick one voice |


### Phase 4: Final approval gate (for Garry)

This run is a Capy subagent with no direct line to Garry, so the gate below is delivered to the parent thread for Garry's decision; nothing here is approved yet. Pre-gate verification: CEO, DX and Eng outputs listed in the autoplan table are present above (premises, sections 1-10, registries, NOT in scope, what exists, dream delta, completion summaries, consensus tables; DX scores, journey map, empathy narrative, TTHW, checklist; Eng scope challenge, architecture diagram, test diagram, test plan at `~/.gstack/projects/garrytan-gbrain-evals/user-plan-cat40-hard-fix-eng-review-test-plan-20261007-202619.md`, failure modes). Design was skipped (no UI scope).

**Plan summary.** Fix gbrain, not the benchmark: show an entity's other names verbatim from every page about it, search under each of them, count keyword matches with honest paging, accept any write id and fix the opaque write failures, and narrow generated-page demotion; then measure on the calibration world and confirm on fresh and sealed held-out worlds, publishing whatever comes out.

**Decisions: 70 total (61 auto-decided, 5 taste, 4 user challenges).**

User challenges (both models recommend changing the stated direction; the draft's direction stands until Garry decides):
1. **UC1, identity merge (CEO, repeated in Eng).** Draft: treat same-subject pages as one identity. Both voices: never union on the title alone; show sibling pages and their excerpts with separate attribution, and union only on corroborating evidence (a shared stable identifier or an explicit identity link). Why: a title collision is not identity, and `entity-identity.ts` is manual-only for that reason. What we might be missing: in the benchmark the account sheet and CRM record share no identifier, so the strict version helps the agent only through the excerpt, and the subject-name mention links stay dropped as collisions unless the gazetteer links to every candidate. If wrong (keeping the draft): unrelated same-name entities merge for every user by default. Recommendation: accept the challenge, with display-plus-excerpt by default and the gazetteer linking a colliding subject to every candidate page.
2. **UC2, confirmation endpoint (CEO).** Draft: the fresh main seed is primary, the sealed variant alongside. Both voices: the sealed set must pass too (co-primary), or confirm on sealed only. Why: this plan quotes the main generator's wording, so main-seed parity is weak evidence. What we might be missing: sealed-only loses the like-for-like comparison with the −11.3 result. If wrong: a "parity" claim that holds only on wording the team has read. Recommendation: co-primary (both at 0 or more for success, either below 0 triggers the kill).
3. **UC3, F4 date field (DX, confirmed by Eng).** Draft: rename to `page_date`. Both voices: keep `effective_date`, expose `effective_date_source` in lean rows, and label by source (document, event or fallback date; never contractual validity). Why: a second field with the same value adds nothing and `effective_date` is not always a document date. If wrong: agents keep misreading the field. Recommendation: accept.
4. **UC4, F3 trigger (Eng).** Draft: demote `author: agent:*` pages and auto-summaries. Both voices: demote only on gbrain-owned markers (`dream_generated`, `extract_receipt`) unless `agent:` is first made a documented gbrain convention. Why: nothing in gbrain stamps or reads `author: agent:`; it is the generator's convention. What we might be missing: under the narrow rule F3 does nothing in this benchmark (0 points). If wrong: the fix is tuned to the corpus. Recommendation: accept, and decide separately whether `agent:` should become a gbrain convention on its merits.

Taste decisions (auto-decided provisionally; Garry can override):
1. **C4, defer owner phrases (CEO).** Recommend defer (P3): no extractor exists and it is the most generator-shaped piece. Alternative: build it now; it covers 6 of the 20 alias cells and most of H1's dated ownership, at the highest generality risk.
2. **C9, confirmation spend after the development record (CEO).** Recommend authorizing the $1,280 only after Garry reads the development record (P6). Alternative: authorize everything now; faster, but the expected outcome is still a kill.
3. **C16, gbrain-plus-fs exploratory arm (CEO).** Recommend adding it on development, about $45 (P1): it tests whether gbrain helps beside grep, which is the likely real-world setup. Alternative: skip; cheaper, and keeps the wave focused.
4. **C19, deployment-risk disagreement (Eng).** Accepted both voices' remedies (commit per item, coverage counter, batch compatibility, pinned build); no real alternative is lost.
5. **C3, read-time sibling merge (CEO).** Superseded by UC1; listed so the count is honest.

**Review scores.** CEO: SELECTIVE EXPANSION, 11 premises checked, 9 corrected; Claude and Codex completed; consensus 6/6. DX: 5/10 → 7/10; Claude and Codex completed; consensus 6/6. Eng: scope accepted as-is; Claude and Codex completed; consensus 5/6 (one taste). Design: skipped (no UI scope).

**Cross-phase themes.** False completeness (card `aka`, missing counts, stale coverage) raised in CEO, DX and Eng; identity by title (CEO, Eng); H5 write health (CEO found the error rate, Eng found that most of it is not the UUID refusal); F3's trigger (CEO narrowed it, Eng made it UC4); rerank degradation (CEO, DX).

**Deferred to TODOS (to be filed in gbrain by the implementing thread; this review did not edit gbrain).** Owner-phrase resolution; H5 merge-chain recall with its gate; notice hygiene; opt-in LLM alias extraction; a scale-ladder eval; a starter-surface onboarding walkthrough; a timed fresh-install check; a read-only alias preview.

**Implementation tasks (aggregated across phases).** 30 tasks, T1 to T11 (CEO), T12 to T20 (DX), T21 to T30 (Eng), listed with files and verification in each phase's task section above and written to `~/.gstack/projects/garrytan-gbrain-evals/tasks-{ceo,devex,eng}-review-20261007-202940.jsonl`. P1 first: T1 R0, T2 grammar spec, T21 R1 write failures, T22 gazetteer siblings, T3 grammar, T4 card, T5/T24 fan-out, T6/T12/T23 counts and keyword mode, T7/T15/T25 F6, T13 lean rows, T14 coverage, T9 preregistration, T29 merge gates.

**Changes to expected points and cost.** Expected gain +8 to +12 → +2 to +8 (F1 +2 to +4, F2 0 to +2, F3 0 to +1 or 0 under UC4, F6 with R1 0 to +1); at the midpoint gbrain still trails by about 6 points. Cost $2,060 → about $1,715 (development about $433, confirmation about $1,280; sealed-only about $1,075; optional C16 arm +$45), from the ledger basis.

**Outside-voice coverage actually obtained.** Codex CLI (codex-cli 0.160.0, `gpt-6-astra`, reasoning high) completed in CEO, DX and Eng; native Claude Opus 5.5 subagents completed in CEO, DX and Eng, plus three CEO spec-review rounds. No substitute model was needed.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` (via /autoplan) | Scope & strategy | 1 | ISSUES OPEN | 9 proposals, 6 accepted, 3 deferred; 0 critical gaps |
| Outside Review | codex-cli 0.160.0 (gpt-6-astra), autoplan CEO, DX and Eng phases | Independent 2nd opinion | 3 | completed | 31 findings (CEO 8, DX 10, Eng 13); all dispositioned; 4 became user challenges |
| Eng Review | `/plan-eng-review` (via /autoplan) | Architecture & tests (required) | 1 | ISSUES OPEN | 49 issues (Arch 5, Code 3, Perf 4, Test gaps 37), 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | SKIPPED | no UI scope |
| DX Review | `/plan-devex-review` (via /autoplan) | Developer experience gaps | 1 | ISSUES OPEN | score: 5/10 → 7/10, TTHW: ~5 min (operator, unchanged) → ~5 min; agent clock 3-4 calls → 2 |

- **OUTSIDE COVERAGE:** codex, CEO phase, completed, 8 findings; codex, DX phase, completed, 10 findings; codex, Eng phase, completed, 13 findings; Design phase skipped (no UI scope).
- **CROSS-MODEL:** native Claude Opus 5.5 and Codex gpt-6-astra agreed on 6/6 CEO dimensions, 6/6 DX dimensions and 5/6 Eng dimensions; the Eng disagreement (deployment risk) was resolved by accepting both remedies. Four changes to the draft's direction were recommended by both and are held for Garry (UC1 to UC4).
- **VERDICT:** no review is CLEAR yet: the plan has open user challenges and taste decisions; eng review required (re-run after Garry decides UC1 to UC4).

**UNRESOLVED DECISIONS:**
- UC1 identity merge by title subject (union versus display-only with corroboration)
- UC2 confirmation endpoint (main primary versus sealed co-primary or sealed-only)
- UC3 F4 date field (`page_date` versus labelled `effective_date` plus `effective_date_source`)
- UC4 F3 trigger (`author: agent:*` versus gbrain-owned markers only)
- C4 owner-phrase deferral (taste)
- C9 confirmation spend authorization after the development record (taste)
- C16 gbrain-plus-fs exploratory arm (taste)
