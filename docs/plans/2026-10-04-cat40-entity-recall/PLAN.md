<!-- /autoplan restore point: "/home/user/.gstack/projects/garrytan-gbrain-evals/plan-cat40-entity-recall-autoplan-restore-20261004-150754.md" -->
## Implementation plan
# Cat 40 next wave: gbrain finds everything about an account, and a clean gbrain-vs-files measurement

Status: draft for autoplan, 2026-10-04.
Context: the Cat 40 report and its 2026-10-04 correction (`docs/benchmarks/2026-10-02-model-ladder.md`), and the
cost wave (gbrain v0.60.44.0, gbrain-evals v0.10.16).

## Gate decisions (Garry, 2026-10-04: "approve increase budget to $3k")

These override any conflicting text below.

- **UC1 (approved change).** A2 is not run. The 2026-10-02 held-out simple-arm cells (oracle, fs, fs-acl, memory, pg)
  are reused and rescored per the UC1 branch and the Eng UC1 audit:
  - original safety flags are kept where stored tool results were cut at 40,000 characters
  - only success and claims are rescored
  - ineligible cells are rerun
  - the selection is committed before any A3 cell is scored
- **UC2 (approved change).** The corrected headline is published now, decoupled from Item B. It compares
  `a714410a5` (followups/holdout, fixed harness) with the preregistered comparator chosen from the rescored simple
  arms, and is updated again after A3.
- **UC3 (approved change).** Before B1–B4 are built, one development round tests query-time lexical enumeration
  (gbrain master with `search.mcp_keyword_only=true`) beside the master control round. Item B proceeds unless that
  round meets G1's family-E target (≥15/30) without a harm-screen failure. If it does, the plan is revised and brought
  back to Garry.
- **T1:** option A, a new `account` entity type in `gbrain-base-v2` (alias `crm`, `expert_routing: false`).
  **T2:** the dev harm screen gates on success only and reports cost. **T3:** default-on if the held-out family-E point
  gain is above 0 and the ship rule passes, with cost up to +25% allowed. **T4:** keep seed 20261003 and disclose
  that this is its third use.
- **Budget.** The program authorization is $3,000 (was $2,000; $1,943 committed across all ledgers before this wave).
  The follow-up ledger cap is raised from $237 to $1,237 with `set-cap`. The planned spend is about $130.

## Why

Two items are open.

1. **The headline is unconfirmed.** "gbrain beats grep" came from runs in which the old ledger stalled the harness,
   gbrain's embedding requests failed, and gbrain quietly ran keyword-only search. Since the fix, only gbrain arms have
   been measured. Nobody has compared gbrain with plain files, the memory tool or plain Postgres on the fixed harness.

2. **gbrain is weakest at account briefs (family E).** With vector search working, every gbrain build gets 4–5 of 30
   development-world renewal briefs right. The field-level misses on master `109b99217` (30 cells):

   | Field | Wrong |
   |---|---|
   | open support ticket | 23 |
   | main renewal blocker | 15 |
   | date of last email or meeting | 14 |
   | account owner | 5 |
   | renewal date | 5 |

   Missed evidence by folder: tickets 23, meetings 16, mail 5, contracts 5.

   **Mechanism, verified on a development brain at `abc3182e2`.** An account has about 9 tickets, dozens of emails and
   a handful of meetings. Its tickets say `Customer: Quormiro Capital` or `Customer: QUCO`, and its meetings are
   titled `Meeting: QUCO renewal prep`. The CRM record (`crm/quormiro-capital`, title `CRM record: Quormiro Capital`)
   declares `Account code: QUCO`. None of those mentions become links:
   - `entity` on "Quormiro Capital" returns `backlink_count: 0` and no edges.
   - `get_backlinks crm/quormiro-capital` returns `[]`.
   - A search for "Quormiro Capital open support ticket" returns short emails and one closed ticket, so the open one
     is never seen. Similarity search cannot tell 9 near-identical tickets apart by status. An agent needs the full
     list.

   **Why mention linking misses it.** gbrain's mention linker (`src/core/by-mention.ts`) only links to page types
   `person`, `company`, `organization` and `entity`; schema-pack-aware types are its TODO-1. It matches the whole page
   title, so `CRM record: Quormiro Capital` never matches "Quormiro Capital". It doesn't know declared aliases such as
   `Account code: QUCO`. `mentions` links are also left out of the backlink count.

   This is a general gap, not a quirk of the test world. Any brain where customers, deals or projects live in typed
   records (CRM rows, account pages), and other documents name them by name or code, has it.

## Goals

- **G1 (gbrain, one PR).** An agent can enumerate everything a brain says about a named entity: every page that
  mentions it by name or declared alias, with type, date and a lead snippet. That includes the 9 tickets and their
  status, and the latest email or meeting. Family E success on the development world rises from 4/30 (dev2, `ea851b39b`;
  dev-base `109b99217` scored 5/30) to at least 15/30 (three models, gbrain arm), and above a full development round on
  master `739e5cc89` run beside it (paired family-E gain with its CI reported). No family regresses beyond the harm screen, and there are no new leaks.
- **G2 (measurement).** A clean, contemporaneous comparison on the held-out world (seed 20261003, 6 models × 2
  repeats, fixed harness). Arms: oracle, fs, fs-acl, memory, pg, gbrain `a714410a5` (the cost wave's measured build,
  released as v0.60.44.0; already measured on the fixed harness, reused) and gbrain with this wave. The Cat 40 headline is replaced by whatever it says, with per-model and
  pooled paired CIs against the preregistered comparator (the best pooled of fs, memory and pg).

Non-goals: changing Cat 40 tasks, scoring or arms; a new world generator. The held-out world uses the same templates,
so it tests tuning to 50 tasks, not to the generator's wording. The report says so.

## Item B: entity recall (gbrain)

- **B1. Pack-aware entity types for mention linking.** The gazetteer takes its entity types from the schema pack's
  page types that represent things: person, company, organization, entity, plus, as a union that always keeps those four,
  every type the source's schema pack marks `primitive: entity` and those types' declared type aliases (resolved with the existing
  `classifyStoredType` / `buildAliasGraph` helpers, per source). Today `gbrain-base-v2` marks only `person` and
  `company` as entities (`deal` is temporal, `project` a concept) and no bundled pack declares `crm`, so `gbrain-base-v2`
  (the `init` default) makes `crm` linkable: provisionally `crm` and `account` become type aliases of `company`
  (Taste CEO-T1 option B); option A adds an `account` entity type instead. One
  pack-aware resolver replaces both hard-coded lists (`LINKABLE_ENTITY_TYPES` and the card's `ENTITY_PAGE_TYPES`).
  This closes `by-mention.ts` TODO-1. Ambiguity guards stay:
  the generic-token reject list, maximal munch, the self-link guard, one link per page pair, and the cross-source
  guard.
- **B2. Name and alias extraction for the gazetteer.**
  The complete name and alias rules are in the accepted CEO requirements below ("Alias sources"); in short:
  - Only entity-type pages contribute names. Contracts declare the same codes as CRM records, so contracts must not.
  - Each entity page contributes its full title and, when the title has a prefix ending in `: ` (such as
    `CRM record: X`), the subject after the last `: `.
  - It also contributes aliases it declares in the forms `aliasDeclarations` already reads (`account code`,
    `also known as`, `aka`, `short name`, `ticker`, `code name`); frontmatter `aliases` already reach the gazetteer.
  - Existing guards stay: 4-character minimum, generic-token reject list, ignore list, collision drops. Ambiguous
    first-word mentions (25 customer pairs in the world share a first word) are never matched alone.
- **B3. Entity recall surfaces.**
  - `entity` cards keep `backlink_count` as it is (mentions excluded, which search ranking relies on) and add
    `mentioned_in_count` and `mentioned_in`: the distinct pages with any inbound link to the entity, grouped by
    pack-canonical type (the stored type mapped through the pack's type aliases), newest first by `COALESCE(effective_date, updated_at)`, each with slug, title, that date and a lead snippet (the
    first 160 characters of body text after the title heading, whitespace collapsed, after the same private-fence
    stripping and redaction `safeSynopsis` applies; for a ticket that covers `Customer: … Opened: …` and
    `Status: Open`). At most 10 rows per
    type; a truncated type carries its total and the exact `get_backlinks` call (with `source_id`) for the rest.
  - `get_backlinks` returns type, date and title per row and takes `type` (matches the referring page's pack-canonical
    type, the same grouping the card uses) and `limit` (maximum 500). Without `type` it keeps today's rows and has no
    default limit; with `type` it returns one row per referring page, newest first by the same date, default limit
    50, plus `total` and `truncated`, so the card's follow-up call reproduces the truncated group exactly.
  - The cost wave's schema ceilings still hold (served 25,000 characters, 5,700 tokens, 26,000 JSON characters;
    instructions 4,628 characters).
- **B4. Extraction runs by default and on existing brains.** Today the mention pass runs only under
  `gbrain extract links --by-mention --source db`; nothing in sync, autopilot or `extract --stale` calls it, and the
  development brain at `abc3182e2` has 0 links across 3,973 pages. This wave makes `gbrain extract --stale` (and the
  managed-brain stale path) refresh entity pages' declared aliases and title subjects and then run a reconciling
  mention pass. Mentions get their own watermark and their own extractor version, so a gazetteer change does not
  re-run link and timeline extraction. Bumping the mention version makes the next stale extract add the new aliases
  and mention links on existing brains: one mention pass over every page, no link or timeline rerun. One additive
  schema migration (an alias-origin column on `page_aliases`, a mention watermark on `pages`); nothing is rewritten. The CHANGELOG states how long that takes.
- **B5. Server instructions.** For a brief about an account, person or company, call `entity` first and walk
  `mentioned_in` or `get_backlinks` by type; search is for content, not enumeration. The instructions are already at
  their 4,628-character ceiling, so B5 replaces text: the 135-character sentence "People and companies appear under several names
  (abbreviations, codes, nicknames); when a page lists another name, search for that too." becomes the 113-character
  "For a brief on an account, person or company, call `entity`, then walk `mentioned_in` or `get_backlinks` by type."
  Declared codes now resolve through `entity` and search's alias hop.
- **Tests:**
  - gazetteer types and alias extraction, including collision drops
  - mention links created by `extract --stale`
  - the entity card's `mentioned_in` shape and caps
  - `get_backlinks` filters
  - an ambiguity guard where two entities share a first word
  - schema-budget ceilings
  - remote visibility: private pages never appear in `mentioned_in` for remote callers

## Item A: the clean measurement (gbrain-evals)

- **A1, development rounds:** gbrain arm only; GPT-5.4-mini, GPT-5.4 and Sonnet 4.6; one repeat; slots built by the
  build under test. A control round on master `739e5cc89` (150 cells, master-built slots) is the comparator; dev2
  (`ea851b39b`, cost-wave C1-C4, same harness) is context. Round 1 is B1–B4; round 2 adds B5. The harm screen
  (pooled paired success against the master control better than −5 points; families at −10 or worse flagged, not
  gated; cost reported, not gated) and its failure actions are in the accepted CEO requirements.
- **A2, held-out run** of every simple arm (oracle, fs, fs-acl, memory, pg) on the fixed harness: `--world eval/reports/cat40/holdout/world.json --models
  claude-haiku-4-5,claude-sonnet-4-6,claude-sonnet-5-5,gpt-5.4-mini,gpt-5.4,gpt-6.1-sol --arms oracle,fs,fs-acl,memory,pg
  --repeat 2 --concurrency 10 --transcripts --budget-ledger .budget/cat40-followups.sqlite --budget-usd <n> --out <dir>`,
  with no `--program-cap-usd` and no tool-result cap. A2 and A3 run from one pinned gbrain-evals commit (only
  `holdout_stats.py` may change between them), recorded in both receipts. A2 runs whether or not Item B reaches the
  held-out stage. A2 finishes, and the preregistered
  comparator is committed, before A3 starts.
- **A3, held-out run** of gbrain with this wave. Its argv is the `followups/holdout` receipt's (`--surface starter
  --repeat 2 --no-pglite-analyze --slots 5 --concurrency 10`, same six models) with only `--gbrain-ref`,
  `--gbrain-label`, `--out`, `--budget-usd` (sized to what remains) and wave-built slots changed, and without
  `--program-cap-usd` (the run adopts the ledger's recorded cap). Its comparisons:
  - against `followups/holdout` (`a714410a5`, the cost wave's measured build, released as v0.60.44.0 after a master
    merge) on the same harness: the ship rule (−5 margin, −3 beside it, no new leaks)
  - against the preregistered comparator, pooled and per model: the new Cat 40 headline. The comparator is whichever
    of fs, memory and pg has the best pooled A2 success; oracle (handed the evidence) and fs-acl (family C only) are
    reported but are not comparators.
- **A4, report and correction close-out.** Rewrite "The finding" with the fixed-harness numbers. Keep the earlier
  sections as history under the correction note.
- **Budget.** $57.34 is left of the $237 follow-up ledger (program total $1,943 of $2,000). Estimates at measured
  rates:

  | Run | Estimate |
  |---|---|
  | dev rounds (two rounds of 150 cells at about $11.6 each) | ~$24 |
  | master control round (150 cells) | ~$12 |
  | held-out simple arms (memory about $84 of it; measured $127.68 with judge on 2026-10-02) | ~$128 |
  | held-out gbrain | ~$55 |
  | slot builds | ~$3 |
  | two dev-round contingencies (the gate allows one rerun per round) | ~$24 |
  | **Total** | **~$246** |

  This needs Garry to raise the program authorization by $250 to $2,250. On the follow-up ledger that is
  `set-cap` from $237 to $487 (or, if the gate accepts CEO-UC1, +$75: program $2,075, ledger cap $312). Nothing else spends against it.

## Order

1. B1–B4 in gbrain on `cat40-entity-wave`, with tests and `verify`.
2. A1 master control and round 1, then B5, then A1 round 2.
3. A2; commit the preregistration and its comparator; then A3.
4. One gbrain PR with the CHANGELOG numbers. The results and report rewrite go in a gbrain-evals PR.

## Risks

- **Over-linking.** Common words as aliases, or names that are prefixes of other names. Mitigated by the existing
  guards plus the alias length, generic-token and collision rules; tests cover them. Doctor's `junk_entity_hubs`
  check still applies.
- **Larger entity cards cost tokens.** The 10-row per-type cap and the 160-character lead snippet bound each group, not the card: a dev-world account has
  about 9 referring types, so a card can carry 40-60 rows (10-15k characters). Results are not capped in the benchmark;
  round 1's measured cost feeds the A3 budget check. The card is only
  sent when an agent calls `entity`.
- **Tuning to this world.** The fix is general (typed records, declared aliases), but the evidence comes from one
  generator. The report states it.
- **The headline may go against gbrain.** We publish it either way.

<!-- autoplan-accepted:ceo -->
- Default-on mention pass (CEO-F1, spec S1.1-S1.3, S5.3): `gbrain extract --stale` and the managed-brain stale path (`extractManagedStaleLinks`) first refresh declared aliases and title subjects of entity pages, then run the mention pass over its own due set: pages whose mention watermark is null, older than `MENTION_EXTRACTOR_VERSION` or older than `updated_at`, plus pages flagged by the name-set diff. The pass does not depend on link staleness: the dry-run count, the zero-stale early return, `staleRemaining` and the managed branch all count mention-due pages, so a brain whose links are current (an upgraded brain, or the 1,000 pages sync extracts inline during a slot build) is still scanned. Sync's inline extraction stays link-only. The pass runs after link work inside the stale sweep's existing 30-minute budget, resumes through its checkpoint, and `--catch-up` covers it. The pass reconciles per page (delete the page's `link_source='mentions'` rows, insert the current set, in one transaction, as `--rebuild` does), so an edit or a removed alias removes stale mention links. Mentions get their own watermark (a new `pages` column, set by the pass) and their own `MENTION_EXTRACTOR_VERSION`; `LINK_EXTRACTOR_VERSION_TS` is not bumped, so a gazetteer change or this upgrade never re-runs link or timeline extraction. The previous gazetteer entry set (source, normalized name, target slug, all-capitals flag) is stored in a table beside its fingerprint. On a fingerprint change with the same entity-type set, pages whose text contains a name whose entry was added, removed or retargeted are marked due in the same transaction that saves the new set; a changed entity-type set or a mention-version bump makes every page due once. One additive migration adds the mention watermark, the gazetteer entry table and an `origin` column on `page_aliases` (`frontmatter` default, `declared`, `subject`); no existing row is rewritten. `extract links --by-mention` keeps working. Verify: a fresh brain with an `account` page and a ticket naming it gets a `mentions` link from `extract --stale` alone; an older page links to a later-added entity on the next `extract --stale`; an edited page loses a mention it no longer contains; an upgraded brain (pages imported by the previous release, links current) gets body aliases and mention links from one `extract --stale`; the managed path produces the same links; a slot-style build (sync over more than 1,000 pages, then `extract --stale`) leaves 0 pages due for mentions; an entity deleted and recreated under another slug with the same title retargets the older pages' links.
- Linkable entity types (CEO-F2, F5, S1.3, S2.1): one pack-aware resolver returns, per source, the union of `person`, `company`, `organization`, `entity` and that source's pack types with `primitive: entity` plus their declared type aliases. The gazetteer applies it per source; the card's entity preference uses it. Under Taste CEO-T1 (provisional option B), `gbrain-base-v2` (the `init` default) adds `crm` and `account` as type aliases of `company`; option A instead adds an `account` entity type (type alias `crm`; path prefixes `accounts/`, `crm/`). Either option makes a `type: crm` page linkable and has the same resolver test; legacy `gbrain-base` and other bundled packs are unchanged. Verify: resolver unit tests for base-v2, company-brain, legacy gbrain-base and no pack (a `type: entity` page stays linkable in every case); a `type: crm` page is in the gazetteer under base-v2.
- Alias sources (CEO-F3, S1.4, S2.5, S5.1, S5.2): only entity-type pages contribute names. Each contributes its full title and, when the title has a prefix ending in `: `, the subject after the last `: `. A title subject is an alias-class entry: a full title in the same source wins over it, and two equal subjects in one source both drop. Body declarations are read by one shared parser that reuses `aliasDeclarations`' regex and its post-filters (trailing punctuation trimmed, an uppercase letter or digit required, the alias differs from the name). Declared aliases (`origin='declared'`) and title subjects (`origin='subject'`) are stored in `page_aliases` for entity-type pages only, beside frontmatter aliases. When two origins give the same normalized alias for a page, one row is kept with precedence frontmatter > declared > subject. `setPageAliases` becomes origin-aware: import replaces only the page's frontmatter rows, and derived-row refresh and cleanup touch only `declared` and `subject` rows. Import, `reindex --aliases` (including pages without frontmatter aliases) and the stale sweep produce the same set, and a page that stops being an entity type (retype or pack change) loses its derived rows on the next sweep, never its frontmatter aliases. In `entity()`, a subject hit ranks at exact-title level, below an exact title in the same source, so `entity("Acme Example")` keeps resolving to `companies/acme-example` when a `CRM record: Acme Example` page also exists; it still resolves `entity("Quormiro Capital")` when the record's slug is `crm/123`. Search's alias hop (`alias-hop.ts`) reads `page_aliases` too, so declared codes start widening searches; the dev rounds measure that effect. Every guard applies to every alias: 4-character minimum (`MIN_NAME_LENGTH`), generic-token reject list for single-token entries of any entity type, ignore list, and collision drops (an alias claimed by two pages in a source is dropped). A single-token alias equal to the first token of the page's own title subject is rejected, so "also known as Quormiro Capital" never adds "Quormiro". A code whose body declaration is written in all capitals matches only all-capital occurrences (frontmatter aliases keep today's case-insensitive matching): the gazetteer re-reads the declaring page's original text when it is built and the scanner compares the original-case body token at the match offset, so no schema change is needed. Verify: tests for title subject, title-vs-subject precedence, body code, contract-vs-CRM code (the contract does not contribute), two-entity collision drop, a 3-character code dropped, an all-capital word-like code not linking lowercase prose, the first-word rejection, `entity("QUCO")` resolving to the CRM record, `entity("Quormiro Capital")` resolving for a record whose slug is not the name, an exact company title outranking a CRM subject, a frontmatter alias surviving a derived-row cleanup, a contract's code never stored, and a retyped page losing its derived aliases. The other gazetteer consumers (`extract-ner.ts`, `extract-timeline-from-meetings.ts`) get regression tests for the wider gazetteer.
- Card fields (CEO-F4, F6, F9, S3.2): `backlink_count` keeps its meaning. The card adds `mentioned_in_count` (distinct referring pages over every link source) and `mentioned_in`: those pages, one row per referring page, grouped by the referring page's pack-canonical type (stored type mapped through the pack's type aliases), newest first by `COALESCE(effective_date, updated_at)`, each row slug, title, that date and a lead snippet; at most 10 rows per type; a truncated group carries its total and the exact `get_backlinks {slug, type, source_id}` call for the rest. The lead snippet is built like `safeSynopsis` (`retrieval-reflex.ts`): private takes and facts fences stripped and `redactFindings` applied, then the first 160 characters of body text after the frontmatter and an optional leading `# ` heading, whitespace collapsed. `get_backlinks` without `type` keeps today's per-link rows and no default limit (`limit` optional, maximum 500); with `type` (a pack-canonical type, matched the way the card groups) it returns one row per referring page with that ordering, default limit 50, plus `total` and `truncated`, matching the card's group exactly. For remote callers the card fields and `get_backlinks` apply `privatePagesFilterFragment` and `privateLinkOriginFilterFragment`, as the card's inbound edges already do, in counts too. Verify: shape, ordering and cap tests; a remote-caller test where a private memo and a digest derived from it both mention the entity and neither appears or is counted; a snippet test where a world-visible page carries a private facts fence; a `get_backlinks {slug, type}` call returning the same total and order as the card's truncated group.
- Schema budgets (CEO-F10, S5.4, S5.5): per-tool budgets for `entity` and `get_backlinks` rise only with equal cuts elsewhere; the served 25,000-character, 5,700-token and 26,000-JSON-character ceilings and the 4,628-character instructions ceiling stay. B5 replaces the 135-character "People and companies appear under several names …" sentence with the 113-character "For a brief on an account, person or company, call `entity`, then walk `mentioned_in` or `get_backlinks` by type." `get_backlinks` measures 416 of its 430 budget and served JSON is 25,735 of 26,000, so the new parameters' characters come out of the longest starter descriptions (`query`, `search`) by the same count. Verify: `test/mcp-schema-budget.test.ts` passes with unchanged ceilings.
- Baselines and control (CEO-F7, F8, S2.6, S5.6): runs are labelled by commit. A full development control round on master `739e5cc89` (3 models, 1 repeat, 150 cells, master-built slots) is the comparator for G1 and the dev harm screen; dev2 (`ea851b39b`) is context. Dev rounds and the held-out gbrain run build their slots with the build under test and record it in the receipt. The wave branch stays based on `739e5cc89` until the paid runs finish. Verify: the slot-build receipts (`slots-*` folders, which carry `slot_builds`) name the build under test, and each round's receipt names that slot folder.
- Dev harm screen (S3.3, spec 2 F5.1, Taste CEO-T2 provisional): a round passes when its pooled paired success difference against the master control is better than −5 points. Per-family differences with their paired CIs are reported, and a family at −10 points or worse is flagged in the report (30 cells per family move about 10 points between near-identical rounds, so it is not a gate). The cost-wave screen's "cost must fall" condition does not apply to a capability wave; cost per task and per successful task are reported beside it. If Garry rejects T2, the cost-wave screen applies as drafted and a failure on cost alone stops for Garry. `holdout_stats.py` gains the pairs wave-vs-control, wave-vs-`a714410a5` and wave-vs-comparator, a capability harm-screen mode with the per-family flag, and a headline mode; the exact invocations go in the preregistration.
- Preregistered headline (CEO-E1, S2.2, spec 3 C1.1): after A2 and before A3, commit a preregistration naming the metric (task success), the single comparator (whichever of fs, memory and pg has the best pooled A2 success, ties broken by lower cost per task; oracle and fs-acl are reported, not comparators), both pairs (wave vs comparator, `a714410a5` vs comparator), the headline build (the wave if its PR merges, otherwise `a714410a5`), per-model and pooled paired CIs by `holdout_stats.py`, and the exact headline sentence for a win (pooled CI above 0), a tie (CI spans 0) and a loss (CI below 0). A2, the preregistration and an `a714410a5` headline still run if Item B stops before the held-out stage. Verify: the preregistration commit precedes the A3 receipt.
- Gate failures (CEO-E2, S3.6): round 1 fails the harm screen: fix the cause, rerun once, stop for Garry if it fails again. Round 2 fails: drop B5, rerun once, stop for Garry if it fails again. Round 2 under 15/30, or at 15/30 or more without beating the master control, with the screen passed: continue to held-out and report the G1 miss. Before A3 starts, project its cost as $48 (the `a714410a5` held-out cost) × (round 2 cost per task ÷ master-control cost per task) + 15%; if the ledger's remaining dollars are below that projection, stop for Garry instead of launching, so no run ends with unpaired cells. Held-out ship rule failed: the headline is still published (A4), the gbrain PR does not merge, and Garry decides between reworking and a disable switch designed then. If Garry rejects both T1 options (no pack treats `type: crm` as an entity), Item B's paid rounds do not start.
- Performance and precision (CEO-E5, S1.5, S3.5): on the 52k-document large world generated with `bun eval/generators/model-ladder-gen.ts --scale large` (the committed folder holds only its manifest) and imported locally into PGLite, the slots' engine, with `--no-embedding` ($0), the PR states the mention pass's wall time (target under 10 minutes for a full pass, resumable through the existing checkpoint), mention links per page, the top 20 hubs, the `junk_entity_hubs` doctor result before and after, and a manual check of 50 random mention links. If the full pass exceeds 10 minutes or fewer than 45 of the 50 links (90%) are correct, the cause is fixed before dev round 1.
- Held-out integrity (S1.7): no held-out task content informed B1-B5 (the mechanism and every number above come from the development world). The report states that this is the held-out world's third use for a gbrain decision, and that the A3 ship-rule comparison against `a714410a5` covers v0.60.45.0-v0.60.46.0 and this wave together.
- Recall ceiling (S5.7): routine documents name an account by its ambiguous first word 20% of the time (`ref()`, `model-ladder-gen.ts`), and those stay unlinked by design; the report notes this beside G1.
- Budget (CEO-F11, spec 2 F5.2): estimate about $246 (two dev-round contingencies) against $57.34 remaining. The +$250 ask stands: program $2,250, follow-up ledger `set-cap` from $237 to $487. If the gate accepts CEO-UC1, the estimate is about $118 and the ask is +$75: program $2,075, ledger cap $312. A3 runs without `--program-cap-usd` and with `--budget-usd` sized to what remains.
- UC1 branch (spec 3 C2.4): if the gate accepts CEO-UC1, A2 is not run. The 2026-10-02 simple-arm cells (same six models, 2 repeats, 50 tasks; `evals_commit 462e31f3`) are rescored with today's `score.ts` from their stored transcripts, the claims judge is re-run only where today's scorer needs it, the comparator is chosen from those cells by the same rule, the report names the harness differences (old ledger, explicit tool-result cap flag), and G2 drops the word "contemporaneous".
- Run commands (spec 3 C3.1): A1 rounds use the dev2 receipt's argv with the build, label, slot folder, `--budget-usd` and `--out` changed and without `--program-cap-usd`.
- G1 test (spec 2 C3.1): family E at least 15/30 on round 2, and above the master control's family-E score, with the paired gain and its CI reported.
- Dual-voice additions (V4-V7, V11, V12, Sections 2, 4, 8): (a) tests include an independently written fixture brain that does not use Cat 40 templates (status buried mid-body, duplicate account records, undeclared aliases, people named "Will" and "Grace"); when the operator has a real brain available, the PR also reports precision on 100 random mention links and the top 20 hubs from a full pass on it, with the same 90% bar. (b) Config `mentions.auto_link` (default true); false makes the next sweep delete `link_source='mentions'` rows and skip the pass; tested. (c) The card carries `mentions_index: {pending_pages, last_pass_at}` and, when pages are pending, a hint naming `gbrain extract --stale`; `get_backlinks` with `type` also takes `offset`. (d) B5's sentence names accounts, people and companies, not projects (base-v2 `project` is a concept); the plan's scope is same-source, with `link_resolution.cross_source` still the opt-in. (e) A1 and A3 reports give the share of family-E tasks in which the agent called `entity`. (f) A4 reports cost per successful task per model and arm. (g) A `type` the pack does not know returns the agent-operator error with the valid types. (h) The pass sets a page's mention watermark to the `updated_at` it read, so an edit committed during the scan leaves the page due; tested. (i) `gbrain extract --explain` says why a name did or did not link, and doctor's `extraction_sync` reports mention-due pages.
- Taste decisions held for the gate, with provisional choices applied: CEO-T1 now recommends option B (`crm` and `account` as type aliases of `company` in base-v2; no new default type), with option A (new `account` type) as the alternative; CEO-T2 harm screen as above; CEO-T3 default-on requires the held-out family-E paired difference against `a714410a5` above 0 plus the existing ship rule, with cost per task allowed to rise at most 25%; 15/30 stays a reported target; CEO-T4 keeps seed 20261003 with disclosure.
<!-- /autoplan-accepted:ceo -->

<!-- autoplan-accepted:dx -->
- Activation (Pass 1, 5): `gbrain post-upgrade` prints an `[AGENT]` line when mention-due pages exist, naming `gbrain extract --stale --catch-up` and an estimate from the page count; the autopilot drain reserves half its budget for the mention pass while mention-due pages exist; `gbrain extract --stale --dry-run` shows mention-due pages and `last_pass_at`. Verify: post-upgrade output test; a cycle test showing mention progress on an upgraded brain whose links are current.
- Field names (Pass 2), replacing the CEO block's `mentioned_in`, `mentioned_in_count`, `mentions_index` and "lead snippet": the card's fields are `referenced_by` (rows: slug, title, type, canonical_type, date, date_source, preview), `referenced_by_count` and `coverage`; the `entity` description says `backlink_count` excludes mentions and `referenced_by` counts every inbound link. Verify: MEMORY_VERBS conformance fixtures updated additively.
- `get_backlinks` (Pass 2, 3): `type` filters in both modes; `group: "page"` returns per-page rows; responses always carry `total` and `truncated`; `offset` pages; ordering is date descending then slug; `limit` > 500 and unknown `type` return the agent-operator error with valid values; under T1 option B, `crm` and `account` are accepted as `type` and the response echoes `canonical_type`. The card's continuation is `get_backlinks {slug, source_id, type, group: "page", limit, offset}`. Verify: JSON-shape tests for both modes; enumeration of more than 500 pages with equal dates and no omissions or duplicates.
- Coverage (Pass 3): `coverage: {state, pending_pages, last_pass_at}` with states `complete`, `pending`, `disabled`, `type_not_linkable`, `failed`, on cards, on `entity` misses and on `get_backlinks`; any state other than `complete` adds `degraded: true` and a `[gbrain notice]` with `fix.next` (`run` locally, `tell_user_to_run` for remote callers) and a read-only `fix.verify`. Completeness is stated as recognized names within the caller's permitted sources. Verify: one test per state, local and remote.
- Diagnostics (Pass 2, 3): `gbrain extract mentions --explain <name|slug> [--page <slug>] [--source-id <id>] [--json]` returns the matched entry, `origin` and a reason code (`ambiguous_first_word`, `below_min_length`, `generic_token`, `alias_collision`, `case_mismatch`, `type_not_linkable`, `linking_disabled`, `pending`, `ignored_by_page`); it never suggests rerunning extraction for a policy rejection. `gbrain extract --explain <kind>` is unchanged. This replaces the CEO block's `extract --explain` wording. Verify: one test per reason code.
- Config and overrides (Pass 2, 6): `mentions.auto_link` is registered; global `auto_link=false` also stops the pass; `mentions.auto_link=false` deletes mention links and `declared`/`subject` alias rows on the next sweep, and re-enabling marks every page due and re-derives aliases; `mentions.entity_types` (add/remove; the legacy four cannot be removed), `mentions.ignore` (names) and frontmatter `mention_ignore: [names]` on a referring page. Verify: enabled → disabled → enabled test without page edits; override tests.
- Surfaces and cost (Pass 6): sync calls `extractManagedStaleLinks` with `{mentions: false}` (test: sync writes no mention rows); on the verbs surface a truncated group's continuation names the starter surface instead of an uncallable tool; B5's sentence is emitted wherever `entity` is served, with its `get_backlinks` clause only where that tool is served, and each surface's instructions size is recorded and tested; `entity` keeps p99 < 100 ms on the 20K corpus with mention-dense data; `context_pack` and `delta` do not compute `referenced_by`. The `previews are not evidence: fetch the page before stating status or dates` guidance goes in the `entity` description. Verify: surface tests; latency gate.
- Docs (Pass 4, 5): `docs/guides/entity-recall.md` (keyless tutorial with sample files, commands, MCP JSON, expected output, pagination, a failed-alias example; a "make your records findable by name" section; an upgrade table for base-v2, legacy and custom packs), linked from README; `MEMORY_VERBS_v1.md` additive fields; CLI help; CHANGELOG with the upgrade table, off switch and first-pass time. Verify: the tutorial run timed on a fresh install, under 5 minutes.
<!-- /autoplan-accepted:dx -->

<!-- autoplan-accepted:eng -->
- Consolidated spec (Q1): where the CEO, DX and Eng blocks differ, the later block wins; the implementation PR's description states the final field names (`referenced_by`, `referenced_by_count`, `coverage`, `preview`), the `get_backlinks` contract and the B5 sentence ("For a brief on an account, person or company, call `entity`, then walk `referenced_by` or `get_backlinks` by type.", measured at or under the removed 135 characters).
- Index lifecycle (E1, E2), replacing the CEO watermark rule: each page's mention state stores the content `knowledge_revision`, `MENTION_EXTRACTOR_VERSION` and the source's gazetteer generation it was scanned at, written in the same transaction as its links; a page is due when any of them differs. Entry-table saves take an advisory lock and bump the generation; a scan publishes only if the page's revision and the source generation are unchanged (conditional publish), otherwise the page stays due. If pack loading, alias loading or the entry-table read fails, the pass writes nothing and the per-source status row records `failed` with the error; an empty gazetteer still reconciles. Verify: tests for overlapping sweeps, an edit during a paused run, entity deletion and recreation, alias-load failure (no deletes), removal of the last entity, and convergence of an upgraded brain whose pages predate the extractor version.
- Invalidation (P1): changed gazetteer entries run as a mini-gazetteer through the real tokenizer over pages selected by a `search_vector` prefilter that is a superset of scanner matches across body and timeline; changes to the entity-type set, cross-source policy or ignore rules trigger a full rescan. Verify: Unicode and punctuation variants of a new name are found; a 52k-world timing for adding one entity (target under 30 s).
- Reconcile (E2, Codex 6, native 8): the default pass and `mentions.auto_link=false` touch only plain mention rows (`link_kind` null or `plain`); `typed_ner` rows are kept as `--rebuild` keeps them. Verify: a `works_at` typed_ner edge survives reconcile and an off/on cycle while an obsolete plain mention is removed.
- Aliases (Q3, Q4, Q5, Codex 1, native 3, native 10): declarations are parsed from text with private takes and facts fences stripped (the `safeSynopsis` rule); the `page_aliases` unique key includes `origin`, so frontmatter, declared and subject rows coexist and readers apply precedence frontmatter > declared > subject; rows carry `case_sensitive` (true for every single-token declared alias, matched exactly as written; frontmatter aliases stay case-insensitive), replacing the CEO block's all-caps re-read rule; alias refresh has its own due set (alias watermark per entity page; retype or pack change marks due); writes on managed brains go through the coordinated writer. Verify: private-fence code not stored and remote `entity` on it misses; frontmatter removal leaves a valid declared row; "aka Mark" does not link lowercase "mark"; managed-brain sweep test.
- Alias consumers (E4): `resolveEntitySlug`, the retrieval reflex, capture-dedup, read-enrichment, intent weights, the search alias hop, `search-diagnose` and the onboard orphan-alias check rank an exact title above declared and subject rows. Verify: `resolveEntitySlug("Acme Example")` stays `companies/acme-example` beside a `CRM record: Acme Example` page; capture-dedup unchanged for the same case.
- SQL and schema (Q2, E5, P4): every type list reaching SQL is bound as `text[]`; `GUARDED_TABLE_COLUMNS` and catalog goldens include the new columns; the migration adds a `(source_id, mention watermark)` index; PGLite and Postgres parity tests for the migration and origin-aware alias writes.
- `get_backlinks` (E3), replacing the DX clauses on `total`/`truncated` and `offset`: with none of the new parameters the response is today's bare `Link[]`, unchanged; with `group: "page"` it is `{rows, total, truncated, cursor}`, ordered by `(date DESC, source_id, slug)` with a keyset `cursor`; `type` filters in both modes and accepts any stored type observed on a referring page (undeclared types such as `ticket` are their own groups) as well as pack-canonical types; untyped pages group under `untyped` with a working continuation; `get_links` is unchanged. Every group a card emits is accepted by its continuation. Verify: `backlinks.test.ts` passes unchanged; >500 rows across two sources with equal dates page without duplicates or gaps; a truncated `ticket` group's continuation succeeds.
- Card cost and coverage (P2, P3): `buildEntityCard` takes `includeReferences` (true only for the `entity` verb); `referenced_by` and `get_backlinks {group:"page"}` share one query helper (identity union applied identically); a whole-card cap of 50 rows across groups, with per-group totals and continuations; `coverage` reads a per-source status row (`state`, `pending`, `last_pass_at`, `generation`) and remote callers see only their permitted sources' state. Verify: `entity` p99 < 100 ms on the 20K corpus with mention-dense data and a 10k-link hub; `context_pack` output and latency unchanged.
- Linkable types (E6): `product` is excluded from linkable type aliases; Taste CEO-T1's recommendation returns to option A (new `account` entity type with `expert_routing: false`), because option B would route CRM rows into `whoknows`; the precision sample is stratified by entity type.
- Slots and runs (native 6): slot builds run `gbrain extract --stale --catch-up`; each `slots-*` receipt records the coverage state and pending count; the runner refuses to start a round on slots whose state is not `complete` with 0 pending.
- Ship rule (Codex 10): `holdout_stats.py` checks leaks per `(model, task, repeat, leak_kind)` cell and fails on any newly leaking cell, keeping aggregate counts for the report. Verify: a fixture with equal totals but a moved leak fails.
- UC1 audit (Codex 11), amending the CEO UC1 branch if Garry accepts UC1: reused cells keep their original safety flags (`output_leak`, `context_exposure`, `unsafe_write`) wherever stored tool results were cut at 40,000 characters; only success and claims are rescored; cells whose eligibility cannot be shown are rerun; the selection is committed before any A3 cell is scored.
- Preregistration (Codex, P3 native): T3's "family-E gain above zero" is frozen in the preregistration as the point estimate (provisional; Garry may choose the CI lower bound at the gate); the preregistration names harm-screen noise (SE about 4-5 points on 150 cells) and provider drift since `a714410a5`.
- B5 guard (native 16): if round 2's code-alias tasks (family A amendments named only by code) drop 10 points or more against round 1, the old "several names" sentence returns in shortened form.
<!-- /autoplan-accepted:eng -->
## Review record

Autoplan run 2026-10-04 (/autoplan, Garry: "autoplan and accept the recommendations"). Phases: CEO, DX, Eng (UI scope: no, so Design is skipped). Every intermediate question was auto-decided with the recommended option; Taste decisions and User Challenges wait for the final gate. Source plan backed up at the restore path above.

### Phase 0 intake

- Base branch: `main` (gbrain-evals, remote `garrytan/gbrain-evals`). Plan branch `plan/cat40-entity-recall`, HEAD `ca81945`, no stashes.
- gbrain checkout: `/workspace/gbrain`, branch `cat40-entity-wave` = origin/master `739e5cc89` (v0.60.46.0), clean.
- Scope: UI no (no view/rendering terms). DX yes (gbrain is a developer tool and an AI agent is the primary user of the MCP surface this plan changes).
- Outside voice: Codex CLI ready (`gpt-6-astra`, API key route). Native reviewers run as Capy subagents on the shared machine (no Claude Code Agent tool on this host). Onboarding, telemetry and upgrade prompts skipped per the Capy adaptation.
- Methodology reads: CEO bundle `autoplan-ceo-methodology-qc5UQx/methodology.md` read at ranges 1-531, 532-1201, 1202-1730, 1731-2303, 2304-2550 (EOF, 2,550 lines).

### CEO phase (Phase 1), Step 0

Mode: SELECTIVE EXPANSION (autoplan override; the plan adds capability to gbrain and a measurement to gbrain-evals).

#### System audit (evidence gathered before Step 0)

Measured on this machine, 2026-10-04, $0 (local code, committed artifacts, and a read-only copy of a development-world slot brain built by `abc3182e2`):

1. **The mention linker never runs by default.** `gbrain extract --stale` (`extractStaleFromDB`, `src/commands/extract.ts`) does link and timeline extraction only. The mention pass (`extractMentionsFromDb`) runs only under `gbrain extract links --by-mention --source db`; nothing in sync, autopilot or the cycle calls it (grep: only `extract.ts`, NER and doctor's fix hint reference it). The Cat 40 slot build runs `extract --stale`. The development brain has **0 rows in `links`** across 3,973 pages. So B4's statement that a version bump makes the next `extract --stale` add mention links is false today.
2. **`crm` is not an entity type anywhere.** The world writes CRM records with frontmatter `type: crm` (100 pages). No bundled pack declares `crm` or `account`. In `gbrain-base-v2` only `person` and `company` are `primitive: entity`; `deal` is temporal and `project` is a concept. `company-brain` declares `customer`, `competitor`, `supplier`, `distributor` as entities. So B1 as drafted ("pack types marked as entities, such as crm/account/customer/deal/project in the base pack") would leave every CRM record out of the gazetteer, and G1 could not move.
3. **Contracts declare the same codes.** 100 contract pages (`Master Services Agreement: X`) contain "account code XXXX" as well as the 100 CRM records. If every page that declares an alias contributed it, each code would be claimed by two pages and dropped by the collision rule. Alias contribution must stay limited to entity-type pages.
4. **Frontmatter aliases already reach the gazetteer.** Since v0.46.15 (#3801), `page_aliases` rows of live entity pages are gazetteer entries, with ignore-list, ambiguity (one alias, two slugs), title-collision and minimum-length guards. `MIN_NAME_LENGTH` is 4 for titles and aliases. The draft's "aliases shorter than 3 characters are dropped" would loosen that guard.
5. **`backlink_count` excludes mentions on purpose.** The entity card's inbound edges and `backlink_count` filter `link_source <> 'mentions'` (design D12: mention edges must not inflate search ranking; salience filters them too). Counting mentions in the same field changes its meaning for every consumer.
6. **Entity types are hard-coded twice.** `LINKABLE_ENTITY_TYPES` (`by-mention.ts`) and `ENTITY_PAGE_TYPES` (`entity-card.ts`) hold the same four types; the card uses its list to prefer entity pages on exact-title collisions.
7. **A ticket's status is not on its first content line.** Ticket bodies read `Customer: Quormiro Capital. Opened: 2026-07-29.` then a blank line, then `Status: Open. Escalated to the Platform team.` A first-line snippet would miss the status; a lead snippet of the first 160 characters of body text after the title heading covers both.
8. **`entity("QUCO")` misses.** Resolution arms are `page_aliases`, exact title, exact slug and slug suffix. A code declared only in the body is in none of them.
9. **Baselines.** Family E on the development world: dev-base (`109b99217`) 5/30, dev1 (`abc3182e2`) 5/30, dev2 (`ea851b39b`) 4/30, `566a242a` 4/29, `51a30c1` re-run 4/30. The field-miss table in the draft is dev-base's (verified: open ticket 23, blocker 15, last contact 14, owner 5, renewal date 5; missed evidence tickets 23, meetings 16, mail 5, contracts 5). G1 compares with dev2, whose E score is 4/30. The wave builds on master `739e5cc89` (v0.60.46.0), two releases after both `ea851b39b` and the held-out measurement build `a714410a5`, so comparisons with dev2 and `followups/holdout` would credit v0.60.45.0 and v0.60.46.0 to this wave.
10. **Slots carry the change.** The cost-wave dev rounds reused brains built by `abc3182e2` (`--slot-ref`). Mention links and declared aliases are written at import and extract, so this wave's brains must be built by the wave's own build.
11. **The simple arms were not affected by the stall.** The 2026-10-04 correction states fs, fs-acl, memory and oracle make no provider calls through the proxy and pg waits rather than falls back. The original held-out run of those arms (`evals_commit 462e31f3`, 2026-10-02, `--max-tool-chars 100000000`) has 0 errored cells. Its cost: oracle $5.86, fs $21.01, pg $14.37, memory $84.06, fs-acl $2.38 including judge, total $127.68. The draft estimates $115. Harness files changed since then: `score.ts` (string-valued sources, claims-judge failure), `pg-arm.ts`, `loop.ts`, the runner.
12. **Budget.** `budget-ledger.ts status` on `.budget/cat40-followups.sqlite`: cap $237, committed $179.66, remaining $57.34, one run still open, and a hint that a legacy `ledger.json` sits beside the SQLite file. Program spend $1,763 + $179.66 = $1,942.66.
13. **Derived pages.** Finance memos are `visibility: private`; pipeline digests derived from them are not private themselves (`derived_from`). The card's inbound edges apply both the private-page and the private-origin predicates. A `mentioned_in` list that applied only the first would surface digests to remote callers (Cat 40 family C counts `output_leak` and `context_exposure`).
14. **Schema budgets are tight.** Served starter list 25,000 characters max (`SERVED_STARTER_MAX_CHARS`), `entity` 460 and `get_backlinks` 430 characters per-tool budget, instructions 4,628 characters max (`test/mcp-schema-budget.test.ts`).
15. **Codes that are words.** The scanner lowercases tokens. A 4-letter account code that is also a word ("CARE", "FAST") would link every lowercase occurrence.
16. **Pack type aliases exist.** `classifyStoredType` and `buildAliasGraph` (`src/core/schema-pack/`) already resolve a stored type to a canonical pack type through declared aliases, so "entity types plus their aliases" needs no new mechanism.

Prior learnings: none recorded for this project. Design doc: none (standard review; /office-hours offer auto-skipped under autoplan). Handoff note: none. Brain context: not used.

Taste calibration. Good patterns to copy: the gazetteer's guard stack and `hashGazetteer` resume fingerprint (`by-mention.ts`), the card's both-sides-scoped, privacy-filtered inbound query (`entity-card.ts` `assembleCard`), pack-driven type helpers (`enrichable.ts`, `expert-types.ts`, which replaced hard-coded `['person','company']`). Patterns to avoid: hard-coded type lists duplicated across modules (finding 6), and opt-in passes that a default workflow never runs (finding 1).

Landscape (web search, 2026-10-04). Layer 1: entity linking with a gazetteer plus alias tables is the standard approach (CRM "related records", Obsidian unlinked mentions resolved through frontmatter `aliases`). Layer 2: open-source second-brain and agent-memory projects ship the same pieces: an alias index feeding backlinks (collisions resolved first-wins or dropped), an unlinked-mention scanner with word boundaries and first-occurrence-only linking, and a deterministic "concept cluster" envelope of target plus linkers (open-second-brain v0.10.17; heyaleph memory docs). Agent-maintained wikis run the same mention detection after every write. Layer 3 (first principles): similarity search returns the k most similar chunks, and nine tickets that differ only by status are near-duplicates, so no ranking change makes "list every ticket" reliable. Enumeration needs an index keyed by the entity, which is what mention links are.

#### 0A. Premise challenge

- **Real problem.** (1) The public Cat 40 headline rests on runs with degraded gbrain search. (2) An agent asked for an account brief cannot list an account's tickets, meetings and mail, because gbrain stores no edge from them to the account. Do-nothing cost: the report keeps a headline it has corrected but not replaced, and gbrain stays weakest on the task type closest to real company work.
- **Directness.** Item B attacks the cause (no entity index for typed records), not a ranking proxy. Item A measures the right thing, but its weakest premise is that the simple arms must be re-run to be "clean" (finding 11).
- **Premises accepted (P6):** enumeration beats ranking for this failure; mention links plus a card listing are the right surface; one gbrain PR; publish the headline whichever way it goes.
- **Premises corrected as facts (no behavior change):** B4's mechanism (finding 1), B1's base-pack claim (finding 2), the 3-character alias floor (finding 4), the first-line status claim (finding 7), the G1 baseline (finding 9), the budget estimate (finding 11).
- **Premise queued as a possible User Challenge (pending outside voices):** A2 re-runs every simple arm on the held-out world for about $128 to make the comparison contemporaneous. Those arms were not affected by the stall, their held-out cells exist, and the comparison against them could be computed for $0 (with the harness-change caveat). Original requirement retained until the gate.

#### 0B. Existing code leverage

| Sub-problem | Existing code | Reuse |
|---|---|---|
| Gazetteer, guards, maximal munch | `buildGazetteer`, `findMentionedEntities` (`by-mention.ts`) | Extend type source and alias source only |
| Alias storage and guards | `page_aliases`, `setPageAliases`, alias entries in `buildGazetteer` | Reuse; body-declared aliases join the same table |
| Alias declaration patterns | `ALIAS_DECLARATION` / `aliasDeclarations` (`ops/search.ts`) | Reuse the regex; one shared parser |
| Pack type closure | `classifyStoredType`, `buildAliasGraph`, `loadActivePackBestEffort` | Reuse for "entity types plus aliases" |
| Mention writes, rebuild, resume | `extractMentionsFromDb`, `--rebuild`, `hashGazetteer` checkpoint | Call from the stale sweep |
| Stale sweep watermark | `links_extracted_at`, `LINK_EXTRACTOR_VERSION_TS` | Version bump triggers the rescan |
| Card assembly and privacy | `buildEntityCard`, `assembleCard` inbound query with private-page and private-origin predicates | Add `mention_count` / `mentioned_in` with the same predicates |
| Backlink listing | `get_backlinks` → `readLinkEdges` | Add `type` and `limit` |
| Stale mention audit | doctor `stale_mentions`, `junk_entity_hubs` | Unchanged; still applies |
| Schema ceilings | `test/mcp-schema-budget.test.ts` | Ceilings unchanged |
| Held-out statistics | `holdout_stats.py` paired bootstrap and sign test | Reuse for G2 |

No rebuilds.

#### 0C. Dream state

```
  CURRENT STATE                      THIS PLAN                               12-MONTH IDEAL
  Typed records (CRM rows,    --->   Pack entity types + aliases feed   ---> Every named thing in a brain has
  accounts) are invisible to         the gazetteer; mention pass runs        one card listing everything said
  the linker; mention pass is        by default; entity card lists           about it, kept current on every
  opt-in and never runs; agents      mentioned_in by type with lead          sync, and the agent's first move
  enumerate by search and miss       snippets; headline re-measured          for "brief me on X" is that card
```

The plan moves directly toward the ideal. The default-on mention pass (finding 1) is the piece that keeps cards current.

#### Decision ledger (CEO Step 0)

| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |
|---|---|---|---|---|---|
| CEO-0E mode | autoplan override | n/a | SELECTIVE EXPANSION | approved | autoplan CEO override rule "Mode selection: SELECTIVE EXPANSION" |
| CEO-0D approach, Item B | system audit Layer 3, findings 1-8 | A) mention links + card listing (plan) | B) ranking change for family E (keyword weight); C) a search filter `mentions:<slug>` without card changes | approved A | Auto-decided A (P1: only an entity-keyed index can enumerate near-duplicate tickets; B fixes ranking, not enumeration; C is a subset of A's `get_backlinks` change). Mechanical. |
| CEO-0D approach, Item A | finding 11 | A2 + A3 as drafted | see CEO-UC1 | approved as drafted, pending UC1 | Auto-decided (P6) |
| CEO-F1 default-on mention pass | finding 1 | opt-in `--by-mention` only | `extract --stale` runs the mention pass for the pages it sweeps; a changed gazetteer fingerprint (new entity, alias or entity type) marks every page for a mention rescan; the version bump covers existing brains | approved | Mechanical (P1; G1 is unreachable otherwise, and eval winners ship on by default) |
| CEO-F2 how typed records become entities | finding 2, 16 | draft names types the base pack does not have | linkable types = active pack types with `primitive: entity` plus their declared type aliases; `gbrain-base-v2` gains an `account` entity type (aliases `crm`, `customer-account`, `client-account`; path prefixes `accounts/`, `crm/`) | approved, with CEO-T1 | Auto-decided (P1, P5). The `account` addition is a product call on the default schema: Taste CEO-T1 |
| CEO-T1 `account` type vs `crm` alias on `company` | finding 2 | none | A) new `account` entity type (provisional); B) add `crm`/`account` as aliases of `company` | TASTE (gate) | Provisional A: keeps companies and customer accounts distinct and avoids colliding with `company-brain`'s `customer` type |
| CEO-F3 alias sources and guards | findings 3, 4, 8, 15 | draft: 3-char floor, frontmatter "added" | entity-type pages only; body declarations via the existing `ALIAS_DECLARATION` patterns join `page_aliases` beside frontmatter aliases so `entity("QUCO")` resolves and the card's `aka` lists it; `MIN_NAME_LENGTH` stays 4; collisions drop; a code declared in all caps matches only all-caps occurrences | approved | Mechanical (P1, P5; keeps every existing guard) |
| CEO-F4 card fields | finding 5 | `backlink_count` counts mentions | keep `backlink_count` as is; add `mention_count` and `mentioned_in` | approved | Mechanical (P5) |
| CEO-F5 one type resolver | finding 6 | two hard-coded lists | one pack-aware `linkableEntityTypes` used by the gazetteer and the card's entity preference | approved | Mechanical (P4) |
| CEO-F6 lead snippet | finding 7 | first content line | first 160 characters of body text after the title heading, whitespace collapsed | approved | Mechanical (P1) |
| CEO-F7 baselines and control | finding 9 | "from 5/30", compare with dev2 | G1 baseline dev2 4/30; add a family-E control on master `739e5cc89` (30 cells, about $3, master-built slots) so the wave is not credited with v0.60.45-46 | approved | Expansion in blast radius, under 1 day (P1, P2) |
| CEO-F8 wave-built slots | finding 10 | unstated | A1 and A3 build their slots with the build under test; receipts record the slot build | approved | Mechanical (P1) |
| CEO-F9 privacy of `mentioned_in` | finding 13 | private pages only | private-page and private-origin predicates, as in the card's inbound edges; derived digests tested | approved | Mechanical (P1, security) |
| CEO-F10 schema budgets | finding 14 | "budgets still hold" | per-tool budgets for `entity` and `get_backlinks` may rise only by equal cuts elsewhere; served 25,000 and instructions 4,628 ceilings unchanged | approved | Mechanical (P5) |
| CEO-F11 budget estimate | finding 11, 12 | ~$200 | dev rounds ~$24, E control ~$3, held-out simple arms ~$128, held-out gbrain ~$55, slots ~$3, one dev-round contingency ~$12: ~$225 | approved | Factual correction; the authorization ask stays +$250 |
| CEO-UC1 re-run vs reuse simple arms | finding 11 | A2 re-runs oracle, fs, fs-acl, memory, pg (~$128) | reuse the 2026-10-02 held-out simple-arm cells; rescore their stored transcripts with today's scorer ($0 agent cost, judge only if the claims judge is re-run); publish the harness difference | pending (gate; User Challenge if the outside voice agrees, else Taste) | Original requirement retained until the gate |
| CEO-E1 preregistered headline | repo convention (prereg commits for paid comparisons) | headline method stated loosely | commit a preregistration before A2/A3: metric, comparator (the simple arm with the best pooled held-out success, fixed before gbrain cells are scored), per-model and pooled paired CIs by `holdout_stats.py`, and the exact headline sentences for win, tie and loss | approved | Expansion in blast radius, under 1 day (P1, P2) |
| CEO-E2 gate-failure actions | plan Order | none | dev round 2 under 15/30 but harm screen passed: continue to held-out and report the miss; harm screen failed: drop B5 first, rerun once, stop for Garry if it fails again; held-out ship rule failed: nothing ships default-on, stop and report | approved | Completeness (P1) |
| CEO-E3 doctor coaching for unlinkable types | agent-first rule | none | doctor reports types with many inbound name mentions that are not entity types, and tells the agent the `schema` command to declare one | deferred | Outside G1/G2 (P3); TODOS.md |
| CEO-E4 family-E ranking follow-up | report: keyword-only search scored 14/30 on E | none | look at hybrid ranking of long meeting transcripts against short mail | deferred | Separate ranking work (P3); TODOS.md |
| CEO-E5 mention pass on the 52k world | performance of a default-on pass | none | local timing of the mention pass on a 50k-page fixture (no embeddings) | approved | In blast radius, $0 (P1); folded into tests |

#### 0F/0G. Expansion framing and HOLD checks (SELECTIVE EXPANSION)

HOLD checks. (1) Complexity: Item B touches about 10 gbrain files (by-mention, extract, entity-card, links op, verbs schema, instructions, base pack YAML, alias parsing, tests) and adds no new service or class. (2) Minimum change for the goals: G1 needs the type source (F2), alias source (F3), default-on pass (F1) and the card listing (B3); B5 is the cheapest lever for agent behavior. G2 needs a comparison; whether it needs new simple-arm runs is CEO-UC1. (3) Invariants kept: Cat 40 tasks, scoring and baselines untouched; held-out tasks not opened; existing gazetteer guards; D12 ranking semantics; remote privacy.

10x check: the 10x version is not "family E goes up"; it is that every brain gets a live index from each named thing to everything that mentions it, kept current by default, so "brief me on X" is one call for any agent. F1 (default-on) and F2 (pack-declared types) are what make it general rather than a Cat 40 fix.

Delight scan (each 30 minutes or less): E1 preregistered headline; E5 50k-page timing; `mentioned_in` hint naming the exact `get_backlinks` call for the truncated type; the card's `aka` listing declared codes; a post-upgrade line telling the agent to run `gbrain extract --stale` now; E3 doctor coaching (deferred). Platform potential: `mentioned_in` serves `context_pack` and `delta`, which already route through `buildEntityCard`.

Cherry-pick ceremony (auto-decided, P2/P3): accepted F7 control, E1, E2, E5; deferred E3, E4 to TODOS.md. Taste: CEO-T1. Pending: CEO-UC1.

#### 0I. Temporal interrogation

```
  HOUR 1 (foundations):   Which pack is active on a fresh `gbrain init --pglite --non-interactive`; how stored
                          types map through pack aliases; where import writes page_aliases; how the stale sweep
                          selects pages; how the card's inbound privacy predicates are built.
  HOUR 2-3 (core logic):  linkableEntityTypes(pack); title-subject entries; body alias parsing into page_aliases
                          beside frontmatter (import projection and `reindex --aliases` backfill must agree);
                          the all-caps code rule (tokenizer lowercases today); mention pass inside the stale sweep.
  HOUR 4-5 (integration): Gazetteer-fingerprint rescan on existing brains; card mention_count/mentioned_in with
                          caps and hint; get_backlinks type/limit inside its 430-char budget; instructions edit
                          inside 4,628 chars; context_pack and delta picking up the new card fields.
  HOUR 6+ (polish/tests): Over-linking fixtures (shared first word, word-like codes, contract-vs-CRM code clash);
                          privacy test with a derived digest; 50k-page timing; CHANGELOG and post-upgrade text.
```

Feasibility blockers: none blocking. Pending for Eng: exact storage of body-declared aliases (column or provenance in `page_aliases`), the all-caps rule's mechanics in the tokenizer, the stale-sweep rescan trigger. Effort: Item B human about 4 days / CC about 4 hours; Item A setup human about 1 day / CC about 1 hour; paid runs about 6 hours wall clock.

#### 0H spec review loop

Launch 1 (Capy subagent, shared machine): FAIL, 5/10. Inputs read in full (CEO summary 48 lines, amended plan 168 lines); claims checked against gbrain `739e5cc89` and gbrain-evals `ca81945`; held-out task file not opened. 27 issues: Completeness 7, Consistency 7, Clarity 6, Scope 2 notes (PASS), Feasibility 7. I verified the load-bearing claims myself: `GBRAIN_MCP_INSTRUCTIONS.length` is 4,628 (at its ceiling); the budget test docstring records 25,735 served JSON characters against the 26,000 ceiling; `ALIAS_DECLARATION` captures one token; `harm_screen` in `holdout_stats.py` requires cost to fall. Dispositions (all auto-decided, P1/P5 unless noted; each lands in the accepted block or the baseline-edit record):

| # | Finding | Disposition |
|---|---|---|
| S1.1 | Upgraded brains never get body aliases (version bump re-runs links, not alias projection; `reindex --aliases` skips pages without frontmatter aliases) | Fixed: the stale sweep refreshes entity pages' declared aliases before the mention pass; `reindex --aliases` covers body aliases; upgraded-brain test |
| S1.2 | Mention-link removal unspecified (`replaceDerivedLinks` rejects `mentions`) | Fixed: the default pass reconciles per page like `--rebuild`; edit-removes-mention test |
| S1.3 | Managed and multi-source brains | Fixed: managed stale path runs the same pass; entity types resolved per source from that source's pack |
| S1.4 | Title-subject vs title collision | Fixed: subjects are alias-class; a full title wins; equal subjects drop |
| S1.5 | Precision of the default-on pass unmeasured | Fixed: large-world precision report (links per page, top hubs, `junk_entity_hubs`, 50-link sample); generic-token guard extends to single-token entries of every entity type |
| S1.6 | Packs other than base-v2 | Fixed: `account` added to base-v2 only (the `init` default); others unchanged; part of Taste CEO-T1 |
| S1.7 | Held-out status | Fixed: statement that no held-out content informed B1-B5; third use disclosed |
| S2.1 | Resolver union vs fallback | Fixed: always the union with the legacy four |
| S2.2 | "Best simple arm" would be oracle; fs-acl is family C only | Fixed: comparator chosen from fs, memory, pg; one comparator, pooled and per model |
| S2.3 | Order: round 1 without B4 shows nothing; A2/A3 not serialized | Fixed: round 1 is B1-B4; A2 then preregistration then A3 |
| S2.4 | UC1 unresolved, changes the ask | Kept pending for the gate as designed; the plan now states both budgets ($234 / +$250, or $106 / +$50) |
| S2.5 | Alias rules split across sections | Fixed: one rule list in the accepted block; B2 points to it |
| S2.6 | Version labels | Fixed: runs labelled by commit (`ea851b39b` is cost-wave C1-C4; `a714410a5` the measured build released as v0.60.44.0) |
| S2.7 | CEO summary names a section the export lacks | Fixed in the summary (accepted bullets follow Risks in the export) |
| S3.1 | Row date undefined | Fixed: `COALESCE(effective_date, updated_at)` |
| S3.2 | Caps and limits missing | Fixed: 10 rows per type; `get_backlinks` default 50, max 500, newest first; `type` semantics stated |
| S3.3 | Harm screen ambiguous (cost must fall; per-family) | Fixed: success-only screen against the master control plus a −10-point per-family floor; cost reported. Taste CEO-T2 |
| S3.4 | A3 argv not pinned | Fixed: `followups/holdout` receipt argv with only ref, label, out and slots changed |
| S3.5 | E5 bound and fixture vague | Fixed: large world with `--no-embedding`, under 10 minutes per full pass |
| S3.6 | Ship-rule failure branch | Fixed: headline still published; nothing default-on; PR stays open; Garry decides |
| S4.1 | Extra type aliases unused | Fixed: alias `crm` only |
| S4.2 | F2 "accepted" vs T1 "provisional" | Kept: T1 closes at the gate |
| S5.1 | All-caps rule has no stored casing | Fixed: casing re-read from the declaring page at gazetteer build; offset comparison; no schema change |
| S5.2 | Single-token capture yields first words | Fixed: reject a single-token alias equal to the first token of the page's own subject |
| S5.3 | Fingerprint rescan re-runs all extraction | Fixed: separate mention watermark; name-prefiltered rescan; full rescan only on type-set change or version bump |
| S5.4 | No instructions headroom | Fixed: B5 replaces the "several names" sentence |
| S5.5 | JSON ceiling omitted (265 characters left) | Fixed: all three served ceilings named |
| S5.6 | Baselines confounded beyond family E | Fixed: full 150-cell master control (about $12) replaces the E-only control |
| S5.7 | Recall ceiling from first-word references | Recorded as a risk beside G1 |

Launch 2: FAIL, 6/10 (Scope PASS; 25 issues, none a repeat of launch 1). It confirmed the dev-round baselines, ledger arithmetic, the held-out gbrain cost ($49.74), 4-character codes and the instructions ceiling. All fixed by auto-decision (P1/P5):

| # | Finding | Disposition |
|---|---|---|
| C1.1 | No fallback if T1 or T2 is rejected | Fixed: rejecting both T1 options stops Item B's paid rounds; rejecting T2 restores the cost-wave screen and a cost-only failure stops for Garry |
| C1.2 | Lead snippet skips `safeSynopsis` stripping and redaction | Fixed: same strip and redact before clipping; no-heading case defined |
| C1.3 | Which links `mentioned_in` lists; follow-up call cannot reproduce it | Fixed: distinct referring pages over every link source; `get_backlinks` with `type` returns per-page rows with `total` and `truncated` |
| C1.4 | Default limit 50 truncates existing callers | Fixed: no default limit without `type`; default 50 only with `type` |
| C1.5 | Title subjects do not resolve `entity` for `crm/123` slugs | Fixed: subjects stored as `origin='subject'` alias rows |
| C1.6 | Which pages store body aliases; retype cleanup; alias-hop side effect | Fixed: entity pages only; derived rows removed on retype; alias-hop effect measured in dev rounds |
| C1.7 | Other gazetteer consumers | Fixed: NER and meeting-timeline regression tests |
| C1.8 | "Ship off by default" has no switch | Fixed: the branch means the PR does not merge; Garry decides |
| C2.1 | Separate watermark needs a column, contradicting "no migration" | Fixed: one additive migration (mention watermark, `page_aliases.origin`); baseline text updated |
| C2.2 | A3 argv carries `--program-cap-usd 237` and `--budget-usd 95` | Fixed: A3 adopts the recorded cap; budget sized to what remains |
| C2.3 | Held-out ship rule compares with `a714410a5`, two releases back | Disclosed: the verdict covers v0.60.45-46 plus the wave; no extra $50 control (P3) |
| C2.4 | Regex alone lacks `aliasDeclarations`' post-filters | Fixed: one shared parser with the post-filters |
| C2.5 | Wrong private-origin helper named | Fixed: `privatePagesFilterFragment` and `privateLinkOriginFilterFragment` |
| C3.1 | G1 "judged against" ambiguous | Fixed: at least 15/30 and above the control, paired gain reported |
| C3.2 | "The version bump" would rerun all extraction | Fixed: separate `MENTION_EXTRACTOR_VERSION`; link version not bumped |
| C3.3 | Previous name set not stored | Fixed: config record with names and all-capitals flags |
| C3.4 | `set-cap` value ambiguous | Fixed: ledger cap $237 to $487 (or $312 under UC1) |
| C3.5 | Base branch not pinned | Fixed: stays on `739e5cc89` until paid runs finish |
| C3.6 | Slot provenance lives in `slots-*` receipts | Fixed: verify there, round receipts name the slot folder |
| C3.7 | `holdout_stats.py` changes unlisted | Fixed: pairs, capability screen mode, headline mode listed |
| C3.8 | Large world not committed; engine unnamed | Fixed: generate command and PGLite named |
| C3.9 | Schema cuts unnamed | Fixed: cuts come from `query` and `search` descriptions |
| F5.1 | −10 family floor is noise at 30 cells (measured 10-point swings between near-identical rounds) | Fixed: flag, not gate; pooled −5 stays the gate (T2 updated) |
| F5.2 | One contingency vs two allowed reruns | Fixed: two contingencies; totals $246 / $118 under UC1 |
| F5.3 | Watermark unbuildable without migration | Fixed with C2.1 |

Launch 3 (final; the loop's three-launch cap): FAIL, 6/10 (Scope PASS; 20 issues, two partly repeated: the CEO summary drifting from the plan, and UC1's interaction with G2). Fixed by auto-decision but not re-reviewed (P1/P5):

| # | Finding | Disposition |
|---|---|---|
| F5.1 (blocking) | The mention pass would only see link-stale pages: sync extracts links inline for 1,000 pages of a slot build, and an upgraded brain with current links would never be scanned | Fixed: the mention pass has its own due set (watermark null, older than `MENTION_EXTRACTOR_VERSION` or `updated_at`, or flagged by the diff); dry-run, early return, `staleRemaining` and the managed branch count it; slot-style test |
| F5.2 | Name-set diff ignores the target slug; crash can lose due marks; config record too small | Fixed: diff on (source, name, slug, all-caps flag) in a table; due marks in the same transaction |
| F5.3 | Subject aliases would outrank exact titles in `entity()` | Fixed: subject hits rank at exact-title level, below a same-source exact title; test |
| F5.4 | B5 wording does not fit the ceiling | Fixed: exact 113-character replacement for the 135-character sentence (measured) |
| F5.5 | Cards are capped per type only (40-60 rows possible) | Fixed: Risks line corrected; round-1 cost feeds the A3 budget check; results stay uncapped |
| C1.1 | G2 undefined if Item B stops; headline build unnamed | Fixed: A2, preregistration and an `a714410a5` headline run regardless; both pairs preregistered; headline build named |
| C1.2 | Missing actions: ≥15/30 but not above control; E5 timing and precision thresholds | Fixed: treated as a G1 miss; >10 minutes or <45/50 correct links is fixed before dev round 1 |
| C1.3 | No budget check before A3 | Fixed: projection rule; stop for Garry if the ledger cannot cover it |
| C2.1 | CEO summary out of date | Fixed in the summary |
| C2.2 | Card groups by stored type, `get_backlinks` by canonical type | Fixed: both use the pack-canonical type; follow-up call carries `source_id` |
| C2.3 | "Pages they sweep" vs "every page due" | Fixed with F5.1 |
| C2.4 | UC1 vs "contemporaneous" | Fixed: UC1 branch spelled out (rescore with today's scorer, comparator rule, harness differences named, "contemporaneous" dropped under UC1) |
| C3.1 | A2 argv not written; runner not pinned | Fixed: A2 argv written out; one pinned gbrain-evals commit for A2/A3; A1 uses dev2's argv as template |
| C3.2 | T1 option B undescribed | Fixed: option B written down with the same test |
| C3.3 | Alias rows from different origins collide; cleanup could delete frontmatter aliases | Fixed: precedence frontmatter > declared > subject; origin-aware `setPageAliases`; all-caps rule for body declarations only |
| C3.4 | `mention_count` counts every link source; comparator tie-break; B5 text | Fixed: renamed `mentioned_in_count`; tie broken by lower cost per task; B5 text written |

Spec-review metrics: iterations 3, issues found 72 (27 + 25 + 20), reviewer-confirmed fixed 41 (launch 2 and 3 confirmed launch-1 and launch-2 fixes except the items they re-raised), remaining at the latest launch 20 (all dispositioned above, not re-reviewed), latest score 6/10. Document approval (0H): auto-decided A (approve these documents and continue to 0I) under autoplan; both documents reflect the decisions above.

Ledger additions (after launch 1, updated after launch 2): CEO-T2 (TASTE, gate): the dev harm screen for this wave drops the cost-wave's "cost must fall" condition and reports (flags, does not gate) any family at −10 points or worse. Provisional: apply it, report cost beside it. Alternative: keep the cost condition, which would fail a wave that adds card tokens even when success rises.

#### CEO accepted requirements and baseline edits

Baseline edits (factual corrections CEO-F1-F11 and spec-review fixes S1-S5, applied by `amend-input`; this record replaces the launch-1 record, both bound to the same checkpoint):

<!-- autoplan-baseline-edits:ceo {"sourceSha256":"a280189e18ace02d566923fa22a2a484c0a7d50f252973798ab31ef9cf50200a","replacements":[{"oldText":"rises from 5/30 to at least\n  15/30 (three models, gbrain arm).","newText":"rises from 4/30 (dev2, `ea851b39b`;\n  dev-base `109b99217` scored 5/30) to at least 15/30 (three models, gbrain arm), and above a full development round on\n  master `739e5cc89` run beside it (paired family-E gain with its CI reported)."},{"oldText":"plus pack types marked as entities, such\n  as `crm`/account/customer/deal/project in the base pack. This closes `by-mention.ts` TODO-1.","newText":"plus, as a union that always keeps those four,\n  every type the source's schema pack marks `primitive: entity` and those types' declared type aliases (resolved with the existing\n  `classifyStoredType` / `buildAliasGraph` helpers, per source). Today `gbrain-base-v2` marks only `person` and\n  `company` as entities (`deal` is temporal, `project` a concept) and no bundled pack declares `crm`, so `gbrain-base-v2`\n  (the `init` default) makes `crm` linkable: provisionally `crm` and `account` become type aliases of `company`\n  (Taste CEO-T1 option B); option A adds an `account` entity type instead. One\n  pack-aware resolver replaces both hard-coded lists (`LINKABLE_ENTITY_TYPES` and the card's `ENTITY_PAGE_TYPES`).\n  This closes `by-mention.ts` TODO-1."},{"oldText":"  - Each entity page contributes its title's subject: the text after the last `: ` when the title has a record\n    prefix such as `CRM record: X`, plus the full title.\n  - It also contributes aliases the page declares in the forms `aliasDeclarations` already reads (`account code`,\n    `also known as`, `aka`, `short name`, `ticker`, `code name`), plus frontmatter `aliases`.\n  - Aliases shorter than 3 characters, aliases that are generic tokens, and aliases claimed by two entities are\n    dropped. Ambiguous first-word mentions (25 customer pairs in the world share a first word) are never matched\n    alone.","newText":"  The complete name and alias rules are in the accepted CEO requirements below (\"Alias sources\"); in short:\n  - Only entity-type pages contribute names. Contracts declare the same codes as CRM records, so contracts must not.\n  - Each entity page contributes its full title and, when the title has a prefix ending in `: ` (such as\n    `CRM record: X`), the subject after the last `: `.\n  - It also contributes aliases it declares in the forms `aliasDeclarations` already reads (`account code`,\n    `also known as`, `aka`, `short name`, `ticker`, `code name`); frontmatter `aliases` already reach the gazetteer.\n  - Existing guards stay: 4-character minimum, generic-token reject list, ignore list, collision drops. Ambiguous\n    first-word mentions (25 customer pairs in the world share a first word) are never matched alone."},{"oldText":"  - `entity` cards count `mentions` backlinks and list `mentioned_in`: pages grouped by type, newest first, each with\n    slug, title, date and a first content line of up to 160 characters (the line that carries `Status: Open`). The\n    list is capped per type, with a count and a `get_backlinks` follow-up hint.\n  - `get_backlinks` returns type, date and title per row and takes `type` and `limit`.\n  - The cost wave's schema budgets still hold.","newText":"  - `entity` cards keep `backlink_count` as it is (mentions excluded, which search ranking relies on) and add\n    `mentioned_in_count` and `mentioned_in`: the distinct pages with any inbound link to the entity, grouped by\n    pack-canonical type (the stored type mapped through the pack's type aliases), newest first by `COALESCE(effective_date, updated_at)`, each with slug, title, that date and a lead snippet (the\n    first 160 characters of body text after the title heading, whitespace collapsed, after the same private-fence\n    stripping and redaction `safeSynopsis` applies; for a ticket that covers `Customer: … Opened: …` and\n    `Status: Open`). At most 10 rows per\n    type; a truncated type carries its total and the exact `get_backlinks` call (with `source_id`) for the rest.\n  - `get_backlinks` returns type, date and title per row and takes `type` (matches the referring page's pack-canonical\n    type, the same grouping the card uses) and `limit` (maximum 500). Without `type` it keeps today's rows and has no\n    default limit; with `type` it returns one row per referring page, newest first by the same date, default limit\n    50, plus `total` and `truncated`, so the card's follow-up call reproduces the truncated group exactly.\n  - The cost wave's schema ceilings still hold (served 25,000 characters, 5,700 tokens, 26,000 JSON characters;\n    instructions 4,628 characters)."},{"oldText":"- **B4. Extraction runs on existing brains.** The link-extractor version bump makes the next `gbrain extract --stale`\n  or autopilot cycle add the new mention links. No migration.","newText":"- **B4. Extraction runs by default and on existing brains.** Today the mention pass runs only under\n  `gbrain extract links --by-mention --source db`; nothing in sync, autopilot or `extract --stale` calls it, and the\n  development brain at `abc3182e2` has 0 links across 3,973 pages. This wave makes `gbrain extract --stale` (and the\n  managed-brain stale path) refresh entity pages' declared aliases and title subjects and then run a reconciling\n  mention pass. Mentions get their own watermark and their own extractor version, so a gazetteer change does not\n  re-run link and timeline extraction. Bumping the mention version makes the next stale extract add the new aliases\n  and mention links on existing brains: one mention pass over every page, no link or timeline rerun. One additive\n  schema migration (an alias-origin column on `page_aliases`, a mention watermark on `pages`); nothing is rewritten."},{"oldText":"  `mentioned_in` or `get_backlinks` by type; search is for content, not enumeration. This stays within the\n  instructions ceiling.","newText":"  `mentioned_in` or `get_backlinks` by type; search is for content, not enumeration. The instructions are already at\n  their 4,628-character ceiling, so B5 replaces text: the 135-character sentence \"People and companies appear under several names\n  (abbreviations, codes, nicknames); when a page lists another name, search for that too.\" becomes the 113-character\n  \"For a brief on an account, person or company, call `entity`, then walk `mentioned_in` or `get_backlinks` by type.\"\n  Declared codes now resolve through `entity` and search's alias hop."},{"oldText":"- **A1, development rounds:** gbrain arm only; GPT-5.4-mini, GPT-5.4 and Sonnet 4.6; one repeat. Compared with\n  `followups/dev2` (v0.60.44.0 at `ea851b39b`, same harness). Round 1 is B1–B3; round 2 adds B5. Harm screen as in the\n  cost wave: drop a change whose paired difference is −5 points or worse, and stop for Garry if a rerun fails.","newText":"- **A1, development rounds:** gbrain arm only; GPT-5.4-mini, GPT-5.4 and Sonnet 4.6; one repeat; slots built by the\n  build under test. A control round on master `739e5cc89` (150 cells, master-built slots) is the comparator; dev2\n  (`ea851b39b`, cost-wave C1-C4, same harness) is context. Round 1 is B1–B4; round 2 adds B5. The harm screen\n  (pooled paired success against the master control better than −5 points; families at −10 or worse flagged, not\n  gated; cost reported, not gated) and its failure actions are in the accepted CEO requirements."},{"oldText":"- **A2, held-out run** of every simple arm (oracle, fs, fs-acl, memory, pg) on the fixed harness. The argv matches\n  the `followups/holdout` gbrain run: 6 models × 2 repeats, `--concurrency 10`.\n- **A3, held-out run** of gbrain with this wave. Its comparisons:\n  - against `followups/holdout`, v0.60.44.0 on the same harness: the ship rule (−5 margin, −3 beside it, no new\n    leaks)\n  - against the best simple arm per model and pooled: the new Cat 40 headline","newText":"- **A2, held-out run** of every simple arm (oracle, fs, fs-acl, memory, pg) on the fixed harness: `--world eval/reports/cat40/holdout/world.json --models\n  claude-haiku-4-5,claude-sonnet-4-6,claude-sonnet-5-5,gpt-5.4-mini,gpt-5.4,gpt-6.1-sol --arms oracle,fs,fs-acl,memory,pg\n  --repeat 2 --concurrency 10 --transcripts --budget-ledger .budget/cat40-followups.sqlite --budget-usd <n> --out <dir>`,\n  with no `--program-cap-usd` and no tool-result cap. A2 and A3 run from one pinned gbrain-evals commit (only\n  `holdout_stats.py` may change between them), recorded in both receipts. A2 runs whether or not Item B reaches the\n  held-out stage. A2 finishes, and the preregistered\n  comparator is committed, before A3 starts.\n- **A3, held-out run** of gbrain with this wave. Its argv is the `followups/holdout` receipt's (`--surface starter\n  --repeat 2 --no-pglite-analyze --slots 5 --concurrency 10`, same six models) with only `--gbrain-ref`,\n  `--gbrain-label`, `--out`, `--budget-usd` (sized to what remains) and wave-built slots changed, and without\n  `--program-cap-usd` (the run adopts the ledger's recorded cap). Its comparisons:\n  - against `followups/holdout` (`a714410a5`, the cost wave's measured build, released as v0.60.44.0 after a master\n    merge) on the same harness: the ship rule (−5 margin, −3 beside it, no new leaks)\n  - against the preregistered comparator, pooled and per model: the new Cat 40 headline. The comparator is whichever\n    of fs, memory and pg has the best pooled A2 success; oracle (handed the evidence) and fs-acl (family C only) are\n    reported but are not comparators."},{"oldText":"  | dev rounds | ~$30 |\n  | held-out simple arms (memory about $78 of it) | ~$115 |\n  | held-out gbrain | ~$55 |\n  | slot builds | ~$2 |\n  | **Total** | **~$200** |","newText":"  | dev rounds (two rounds of 150 cells at about $11.6 each) | ~$24 |\n  | master control round (150 cells) | ~$12 |\n  | held-out simple arms (memory about $84 of it; measured $127.68 with judge on 2026-10-02) | ~$128 |\n  | held-out gbrain | ~$55 |\n  | slot builds | ~$3 |\n  | two dev-round contingencies (the gate allows one rerun per round) | ~$24 |\n  | **Total** | **~$246** |"},{"oldText":"1. B1–B3 in gbrain on `cat40-entity-wave`, with tests and `verify`.\n2. A1 round 1, then B5, then A1 round 2.\n3. A2 and A3.","newText":"1. B1–B4 in gbrain on `cat40-entity-wave`, with tests and `verify`.\n2. A1 master control and round 1, then B5, then A1 round 2.\n3. A2; commit the preregistration and its comparator; then A3."},{"oldText":"Per-type caps and the 160-character first line bound them.","newText":"The 10-row per-type cap and the 160-character lead snippet bound each group, not the card: a dev-world account has\n  about 9 referring types, so a card can carry 40-60 rows (10-15k characters). Results are not capped in the benchmark;\n  round 1's measured cost feeds the A3 budget check."},{"oldText":"with type, date and a first line.","newText":"with type, date and a lead snippet."},{"oldText":"gbrain at v0.60.44.0 (already measured on the fixed\n  harness, reused)","newText":"gbrain `a714410a5` (the cost wave's measured build,\n  released as v0.60.44.0; already measured on the fixed harness, reused)"},{"oldText":"with per-model and\n  pooled paired CIs against the best simple arm.","newText":"with per-model and\n  pooled paired CIs against the preregistered comparator (the best pooled of fs, memory and pg)."},{"oldText":"  This needs Garry to raise the program authorization by $250 to $2,250, recorded with `set-cap` on the follow-up\n  ledger.","newText":"  This needs Garry to raise the program authorization by $250 to $2,250. On the follow-up ledger that is\n  `set-cap` from $237 to $487 (or, if the gate accepts CEO-UC1, +$75: program $2,075, ledger cap $312)."},{"oldText":"For a brief about an account, person or project, call `entity` first","newText":"For a brief about an account, person or company, call `entity` first"}]} -->

<!-- autoplan-accepted:ceo -->
- Default-on mention pass (CEO-F1, spec S1.1-S1.3, S5.3): `gbrain extract --stale` and the managed-brain stale path (`extractManagedStaleLinks`) first refresh declared aliases and title subjects of entity pages, then run the mention pass over its own due set: pages whose mention watermark is null, older than `MENTION_EXTRACTOR_VERSION` or older than `updated_at`, plus pages flagged by the name-set diff. The pass does not depend on link staleness: the dry-run count, the zero-stale early return, `staleRemaining` and the managed branch all count mention-due pages, so a brain whose links are current (an upgraded brain, or the 1,000 pages sync extracts inline during a slot build) is still scanned. Sync's inline extraction stays link-only. The pass runs after link work inside the stale sweep's existing 30-minute budget, resumes through its checkpoint, and `--catch-up` covers it. The pass reconciles per page (delete the page's `link_source='mentions'` rows, insert the current set, in one transaction, as `--rebuild` does), so an edit or a removed alias removes stale mention links. Mentions get their own watermark (a new `pages` column, set by the pass) and their own `MENTION_EXTRACTOR_VERSION`; `LINK_EXTRACTOR_VERSION_TS` is not bumped, so a gazetteer change or this upgrade never re-runs link or timeline extraction. The previous gazetteer entry set (source, normalized name, target slug, all-capitals flag) is stored in a table beside its fingerprint. On a fingerprint change with the same entity-type set, pages whose text contains a name whose entry was added, removed or retargeted are marked due in the same transaction that saves the new set; a changed entity-type set or a mention-version bump makes every page due once. One additive migration adds the mention watermark, the gazetteer entry table and an `origin` column on `page_aliases` (`frontmatter` default, `declared`, `subject`); no existing row is rewritten. `extract links --by-mention` keeps working. Verify: a fresh brain with an `account` page and a ticket naming it gets a `mentions` link from `extract --stale` alone; an older page links to a later-added entity on the next `extract --stale`; an edited page loses a mention it no longer contains; an upgraded brain (pages imported by the previous release, links current) gets body aliases and mention links from one `extract --stale`; the managed path produces the same links; a slot-style build (sync over more than 1,000 pages, then `extract --stale`) leaves 0 pages due for mentions; an entity deleted and recreated under another slug with the same title retargets the older pages' links.
- Linkable entity types (CEO-F2, F5, S1.3, S2.1): one pack-aware resolver returns, per source, the union of `person`, `company`, `organization`, `entity` and that source's pack types with `primitive: entity` plus their declared type aliases. The gazetteer applies it per source; the card's entity preference uses it. Under Taste CEO-T1 (provisional option B), `gbrain-base-v2` (the `init` default) adds `crm` and `account` as type aliases of `company`; option A instead adds an `account` entity type (type alias `crm`; path prefixes `accounts/`, `crm/`). Either option makes a `type: crm` page linkable and has the same resolver test; legacy `gbrain-base` and other bundled packs are unchanged. Verify: resolver unit tests for base-v2, company-brain, legacy gbrain-base and no pack (a `type: entity` page stays linkable in every case); a `type: crm` page is in the gazetteer under base-v2.
- Alias sources (CEO-F3, S1.4, S2.5, S5.1, S5.2): only entity-type pages contribute names. Each contributes its full title and, when the title has a prefix ending in `: `, the subject after the last `: `. A title subject is an alias-class entry: a full title in the same source wins over it, and two equal subjects in one source both drop. Body declarations are read by one shared parser that reuses `aliasDeclarations`' regex and its post-filters (trailing punctuation trimmed, an uppercase letter or digit required, the alias differs from the name). Declared aliases (`origin='declared'`) and title subjects (`origin='subject'`) are stored in `page_aliases` for entity-type pages only, beside frontmatter aliases. When two origins give the same normalized alias for a page, one row is kept with precedence frontmatter > declared > subject. `setPageAliases` becomes origin-aware: import replaces only the page's frontmatter rows, and derived-row refresh and cleanup touch only `declared` and `subject` rows. Import, `reindex --aliases` (including pages without frontmatter aliases) and the stale sweep produce the same set, and a page that stops being an entity type (retype or pack change) loses its derived rows on the next sweep, never its frontmatter aliases. In `entity()`, a subject hit ranks at exact-title level, below an exact title in the same source, so `entity("Acme Example")` keeps resolving to `companies/acme-example` when a `CRM record: Acme Example` page also exists; it still resolves `entity("Quormiro Capital")` when the record's slug is `crm/123`. Search's alias hop (`alias-hop.ts`) reads `page_aliases` too, so declared codes start widening searches; the dev rounds measure that effect. Every guard applies to every alias: 4-character minimum (`MIN_NAME_LENGTH`), generic-token reject list for single-token entries of any entity type, ignore list, and collision drops (an alias claimed by two pages in a source is dropped). A single-token alias equal to the first token of the page's own title subject is rejected, so "also known as Quormiro Capital" never adds "Quormiro". A code whose body declaration is written in all capitals matches only all-capital occurrences (frontmatter aliases keep today's case-insensitive matching): the gazetteer re-reads the declaring page's original text when it is built and the scanner compares the original-case body token at the match offset, so no schema change is needed. Verify: tests for title subject, title-vs-subject precedence, body code, contract-vs-CRM code (the contract does not contribute), two-entity collision drop, a 3-character code dropped, an all-capital word-like code not linking lowercase prose, the first-word rejection, `entity("QUCO")` resolving to the CRM record, `entity("Quormiro Capital")` resolving for a record whose slug is not the name, an exact company title outranking a CRM subject, a frontmatter alias surviving a derived-row cleanup, a contract's code never stored, and a retyped page losing its derived aliases. The other gazetteer consumers (`extract-ner.ts`, `extract-timeline-from-meetings.ts`) get regression tests for the wider gazetteer.
- Card fields (CEO-F4, F6, F9, S3.2): `backlink_count` keeps its meaning. The card adds `mentioned_in_count` (distinct referring pages over every link source) and `mentioned_in`: those pages, one row per referring page, grouped by the referring page's pack-canonical type (stored type mapped through the pack's type aliases), newest first by `COALESCE(effective_date, updated_at)`, each row slug, title, that date and a lead snippet; at most 10 rows per type; a truncated group carries its total and the exact `get_backlinks {slug, type, source_id}` call for the rest. The lead snippet is built like `safeSynopsis` (`retrieval-reflex.ts`): private takes and facts fences stripped and `redactFindings` applied, then the first 160 characters of body text after the frontmatter and an optional leading `# ` heading, whitespace collapsed. `get_backlinks` without `type` keeps today's per-link rows and no default limit (`limit` optional, maximum 500); with `type` (a pack-canonical type, matched the way the card groups) it returns one row per referring page with that ordering, default limit 50, plus `total` and `truncated`, matching the card's group exactly. For remote callers the card fields and `get_backlinks` apply `privatePagesFilterFragment` and `privateLinkOriginFilterFragment`, as the card's inbound edges already do, in counts too. Verify: shape, ordering and cap tests; a remote-caller test where a private memo and a digest derived from it both mention the entity and neither appears or is counted; a snippet test where a world-visible page carries a private facts fence; a `get_backlinks {slug, type}` call returning the same total and order as the card's truncated group.
- Schema budgets (CEO-F10, S5.4, S5.5): per-tool budgets for `entity` and `get_backlinks` rise only with equal cuts elsewhere; the served 25,000-character, 5,700-token and 26,000-JSON-character ceilings and the 4,628-character instructions ceiling stay. B5 replaces the 135-character "People and companies appear under several names …" sentence with the 113-character "For a brief on an account, person or company, call `entity`, then walk `mentioned_in` or `get_backlinks` by type." `get_backlinks` measures 416 of its 430 budget and served JSON is 25,735 of 26,000, so the new parameters' characters come out of the longest starter descriptions (`query`, `search`) by the same count. Verify: `test/mcp-schema-budget.test.ts` passes with unchanged ceilings.
- Baselines and control (CEO-F7, F8, S2.6, S5.6): runs are labelled by commit. A full development control round on master `739e5cc89` (3 models, 1 repeat, 150 cells, master-built slots) is the comparator for G1 and the dev harm screen; dev2 (`ea851b39b`) is context. Dev rounds and the held-out gbrain run build their slots with the build under test and record it in the receipt. The wave branch stays based on `739e5cc89` until the paid runs finish. Verify: the slot-build receipts (`slots-*` folders, which carry `slot_builds`) name the build under test, and each round's receipt names that slot folder.
- Dev harm screen (S3.3, spec 2 F5.1, Taste CEO-T2 provisional): a round passes when its pooled paired success difference against the master control is better than −5 points. Per-family differences with their paired CIs are reported, and a family at −10 points or worse is flagged in the report (30 cells per family move about 10 points between near-identical rounds, so it is not a gate). The cost-wave screen's "cost must fall" condition does not apply to a capability wave; cost per task and per successful task are reported beside it. If Garry rejects T2, the cost-wave screen applies as drafted and a failure on cost alone stops for Garry. `holdout_stats.py` gains the pairs wave-vs-control, wave-vs-`a714410a5` and wave-vs-comparator, a capability harm-screen mode with the per-family flag, and a headline mode; the exact invocations go in the preregistration.
- Preregistered headline (CEO-E1, S2.2, spec 3 C1.1): after A2 and before A3, commit a preregistration naming the metric (task success), the single comparator (whichever of fs, memory and pg has the best pooled A2 success, ties broken by lower cost per task; oracle and fs-acl are reported, not comparators), both pairs (wave vs comparator, `a714410a5` vs comparator), the headline build (the wave if its PR merges, otherwise `a714410a5`), per-model and pooled paired CIs by `holdout_stats.py`, and the exact headline sentence for a win (pooled CI above 0), a tie (CI spans 0) and a loss (CI below 0). A2, the preregistration and an `a714410a5` headline still run if Item B stops before the held-out stage. Verify: the preregistration commit precedes the A3 receipt.
- Gate failures (CEO-E2, S3.6): round 1 fails the harm screen: fix the cause, rerun once, stop for Garry if it fails again. Round 2 fails: drop B5, rerun once, stop for Garry if it fails again. Round 2 under 15/30, or at 15/30 or more without beating the master control, with the screen passed: continue to held-out and report the G1 miss. Before A3 starts, project its cost as $48 (the `a714410a5` held-out cost) × (round 2 cost per task ÷ master-control cost per task) + 15%; if the ledger's remaining dollars are below that projection, stop for Garry instead of launching, so no run ends with unpaired cells. Held-out ship rule failed: the headline is still published (A4), the gbrain PR does not merge, and Garry decides between reworking and a disable switch designed then. If Garry rejects both T1 options (no pack treats `type: crm` as an entity), Item B's paid rounds do not start.
- Performance and precision (CEO-E5, S1.5, S3.5): on the 52k-document large world generated with `bun eval/generators/model-ladder-gen.ts --scale large` (the committed folder holds only its manifest) and imported locally into PGLite, the slots' engine, with `--no-embedding` ($0), the PR states the mention pass's wall time (target under 10 minutes for a full pass, resumable through the existing checkpoint), mention links per page, the top 20 hubs, the `junk_entity_hubs` doctor result before and after, and a manual check of 50 random mention links. If the full pass exceeds 10 minutes or fewer than 45 of the 50 links (90%) are correct, the cause is fixed before dev round 1.
- Held-out integrity (S1.7): no held-out task content informed B1-B5 (the mechanism and every number above come from the development world). The report states that this is the held-out world's third use for a gbrain decision, and that the A3 ship-rule comparison against `a714410a5` covers v0.60.45.0-v0.60.46.0 and this wave together.
- Recall ceiling (S5.7): routine documents name an account by its ambiguous first word 20% of the time (`ref()`, `model-ladder-gen.ts`), and those stay unlinked by design; the report notes this beside G1.
- Budget (CEO-F11, spec 2 F5.2): estimate about $246 (two dev-round contingencies) against $57.34 remaining. The +$250 ask stands: program $2,250, follow-up ledger `set-cap` from $237 to $487. If the gate accepts CEO-UC1, the estimate is about $118 and the ask is +$75: program $2,075, ledger cap $312. A3 runs without `--program-cap-usd` and with `--budget-usd` sized to what remains.
- UC1 branch (spec 3 C2.4): if the gate accepts CEO-UC1, A2 is not run. The 2026-10-02 simple-arm cells (same six models, 2 repeats, 50 tasks; `evals_commit 462e31f3`) are rescored with today's `score.ts` from their stored transcripts, the claims judge is re-run only where today's scorer needs it, the comparator is chosen from those cells by the same rule, the report names the harness differences (old ledger, explicit tool-result cap flag), and G2 drops the word "contemporaneous".
- Run commands (spec 3 C3.1): A1 rounds use the dev2 receipt's argv with the build, label, slot folder, `--budget-usd` and `--out` changed and without `--program-cap-usd`.
- G1 test (spec 2 C3.1): family E at least 15/30 on round 2, and above the master control's family-E score, with the paired gain and its CI reported.
- Dual-voice additions (V4-V7, V11, V12, Sections 2, 4, 8): (a) tests include an independently written fixture brain that does not use Cat 40 templates (status buried mid-body, duplicate account records, undeclared aliases, people named "Will" and "Grace"); when the operator has a real brain available, the PR also reports precision on 100 random mention links and the top 20 hubs from a full pass on it, with the same 90% bar. (b) Config `mentions.auto_link` (default true); false makes the next sweep delete `link_source='mentions'` rows and skip the pass; tested. (c) The card carries `mentions_index: {pending_pages, last_pass_at}` and, when pages are pending, a hint naming `gbrain extract --stale`; `get_backlinks` with `type` also takes `offset`. (d) B5's sentence names accounts, people and companies, not projects (base-v2 `project` is a concept); the plan's scope is same-source, with `link_resolution.cross_source` still the opt-in. (e) A1 and A3 reports give the share of family-E tasks in which the agent called `entity`. (f) A4 reports cost per successful task per model and arm. (g) A `type` the pack does not know returns the agent-operator error with the valid types. (h) The pass sets a page's mention watermark to the `updated_at` it read, so an edit committed during the scan leaves the page due; tested. (i) `gbrain extract --explain` says why a name did or did not link, and doctor's `extraction_sync` reports mention-due pages.
- Taste decisions held for the gate, with provisional choices applied: CEO-T1 now recommends option B (`crm` and `account` as type aliases of `company` in base-v2; no new default type), with option A (new `account` type) as the alternative; CEO-T2 harm screen as above; CEO-T3 default-on requires the held-out family-E paired difference against `a714410a5` above 0 plus the existing ship rule, with cost per task allowed to rise at most 25%; 15/30 stays a reported target; CEO-T4 keeps seed 20261003 with disclosure.
<!-- /autoplan-accepted:ceo -->

#### Step 0.5: CEO dual voices

Snapshot: `autoplan-ceo-89X9A1/ceo-implementation.md`, SHA-256 `001580d5…072d` (the amended plan after the spec loop). Both voices reviewed this input.

**Native CEO reviewer (Capy subagent, shared machine).** Completed; it started with `INPUT: ceo 001580d5…072d` (matches) and read `native-prompt.md` in full (211 lines, hash checked). Findings:
1. High: the failure is about enumeration and structured fields, and grep wins because it enumerates exact matches. A query-time exhaustive exact-match listing (a search mode or `list_pages contains:` over an entity's names and aliases, grouped by type), plus typed-field extraction, was never weighed against a precomputed mention graph. Alias resolution (B2) is worth doing either way.
2. Medium: G1 is a benchmark number. Add a real-brain acceptance check.
3. High: "general gap" rests on one generator's conventions. Prefer T1 option B (aliases on `company`), with no new default type.
4. Medium: agents calling `entity` first is assumed. Report the share of family-E tasks where `entity` was called.
5. Medium: 15/30 may be unreachable (per-field compounding, 20% unlinkable first-word references, the blocker lives in transcripts). Estimate a ceiling or call it a stretch goal.
6. Critical: a default-on pass writes links into every existing brain, validated only on synthetic data. Run it on a real brain (precision on 100 links, top hubs, 90% bar) and ship a reconciling off switch from the start.
7. High: too much machinery for one PR (entry table, diffing, watermark, version, origin precedence, case re-reads, two row semantics).
8. High: third use of the held-out world. Run A2/A3 on a fresh seed if A2 runs anyway.
9. Medium: freshness. Sync stays link-only, so a new ticket waits for the next sweep. Scan inline on writes against a cached gazetteer.
10. High: decouple G2 and run it first; publish an interim correction with `a714410a5` against the best simple arm. Item B updates the headline later.
11. Medium: take UC1 unless a harness difference plausibly moved simple-arm scores.
12. High (competitive): plain files plus a frontier model may win family E. A 10-row cap is structurally weaker than grep's completeness.
13. Medium: card size. Default to per-type counts plus top 3 rows.
Bottom line: approve G2 now, decoupled, through UC1. Hold Item B for one revision (enumeration comparison, T1 option B, real-brain precision and an off switch, trimmed machinery).

**Codex CEO voice (`gpt-6-astra`, read-only, 124 s).** Completed (`OUTSIDE_STATUS: completed provider=codex host=claude`, recommendation marker present). Full output:

```tool-output
CODEX SAYS (CEO — strategy challenge):
════════════════════════════════════════════════════════════
Do not approve the plan as written. It can ship a capability wave without demonstrating a capability gain, and its largest proposed expense does little to resolve the product uncertainty.

1. **The release gate does not enforce the reason for building this.** G1 promises at least 15/30 renewal briefs, but the failure policy explicitly continues when that target—or even improvement over master—is missed. The held-out rule then tests noninferiority against an older build, with cost merely reported. Unchanged answers, unchanged leaks and higher operating cost could qualify for release. The existing statistics code also flags family regressions without making them fail the verdict. Make a minimum capability improvement binding, alongside an explicit acceptable cost increase. “Eval winners ship by default” requires defining what constitutes a win. [Release verdict](/workspace/gbrain-evals/docs/benchmarks/2026-10-02-model-ladder/holdout/holdout_stats.py:198)

2. **The plan commits to graph infrastructure before testing the strongest alternative explanation.** The correction reports 14/30 renewal briefs under the degraded-search harness versus 4/30 with embeddings working. That is not a clean ablation, but it challenges the premise that missing links are the principal bottleneck. Zero backlinks proves a missing capability; it does not prove this entire migration, alias lifecycle and reconciliation system is necessary to improve briefs. Test a lexical-first retrieval alternative on development data before committing to B1–B4. An explicit keyword-only path already exists. Keep Cat 40 tasks, arms and baselines unchanged; compare candidate gbrain implementations. [Correction](/workspace/gbrain-evals/docs/benchmarks/2026-10-02-model-ladder.md:7), [existing search path](/workspace/gbrain/src/core/ops/search.ts:580)

3. **“Everything about an account” exceeds the architecture’s actual reach.** The plan preserves source isolation. If CRM, support and meeting records occupy separate sources, adding aliases inside each source does not assemble the account across them. Existing entity cards explicitly scope both ends of inbound links to the same source. There is also a direct promise mismatch: B5 recommends this workflow for projects, while the default pack classifies projects as concepts, outside the proposed entity resolver. Define the supported workflow precisely and test it with separately sourced records. If joining knowledge across systems is the intended product advantage, canonical identity across authorized sources deserves more attention than title-prefix parsing. [Source boundary](/workspace/gbrain/src/core/verbs/entity-card.ts:252), [project classification](/workspace/gbrain/src/core/schema-pack/base/gbrain-base-v2.yaml:309)

4. **The agent cannot distinguish complete coverage from an incomplete index.** Mention extraction is asynchronous, shares a time budget with other extraction, deliberately drops ambiguous names and excludes some entity types. Yet the card exposes a count without an explicit freshness or coverage state. An AI operator can mistake “nothing indexed” for “nothing exists.” The typed backlink interface also stops at 500 rows without a specified continuation mechanism. Before promising enumeration, define how the agent recognizes unfinished extraction, unsupported coverage and remaining pages. A full-pass runtime target does not establish this contract.

5. **The validation is unusually aligned with the implementation’s assumptions.** The proposed 160-character snippet exposes ticket status because the generator places customer, opened date and status at the beginning. The four-character code and declaration rules likewise fit the generated documents. A larger world with the same templates does not test whether those choices transfer. Checking 50 emitted links measures precision, not the missing evidence that motivates this wave. Add independently authored development fixtures or a representative customer corpus outside Cat 40, covering buried status changes, duplicate account records and undeclared aliases. The third use of the same held-out world should support a regression decision, not a claim of fresh external validation. [Ticket template](/workspace/gbrain-evals/eval/generators/model-ladder-gen.ts:452)

6. **The competitive question remains unanswered.** The report already says the strongest models reach 96–100% with plain files. A pooled win across six models does not identify who should adopt gbrain or why. The defensible proposition might be cheaper models reaching adequate accuracy, permission-aware evidence assembly, or reliable memory across sessions. Choose one and evaluate its economics. Keep the preregistered headline comparator, but use the existing model-arm cells to compare success, price and latency across deployment choices. Otherwise, larger cards can purchase benchmark gains while a stronger model with files remains the simpler customer decision. [Observed ceiling](/workspace/gbrain-evals/docs/benchmarks/2026-10-02-model-ladder.md:353)

7. **The correction should not wait for the product work.** The plan couples repairing an unsupported headline to implementation, development rounds and another held-out run. Existing fixed-harness `a714410a5` results and reusable simple-arm cells can support the corrected historical comparison first. Publish that result independently of whether entity recall works. Continuing to feature the old finding while waiting for a better candidate creates an avoidable credibility problem.

**CEO-UC1: reuse the simple-arm cells.** I would reject the $128 blanket rerun and favor the +$75 branch, subject to revising the capability gate.

The ledger failure mechanism did not change those arms’ retrieval behavior, and the old receipt’s explicit cap was **100,000,000 characters**, not a restrictive output allowance. Before reuse, audit coverage, world identity, arm-affecting code changes and recorded truncation flags. Rescore every reused arm consistently with today’s unchanged scorer; rerun the claims judge only where its inputs changed. Success itself is deterministic and does not depend on that judge. Preserve the original results and disclose the comparison dates. Do not reuse stalled-harness latency as a current latency comparison. [Simple-arm receipt](/workspace/gbrain-evals/docs/benchmarks/2026-10-02-model-ladder/holdout/receipt-1790985283350.json), [scoring contract](/workspace/gbrain-evals/eval/runner/cat40/score.ts:1)

Rerunning unaffected controls would consume roughly half the proposed $246 while leaving the important uncertainties—causal mechanism, generalization and customer value—unresolved. Under the plan’s reuse estimate, $57.34 remaining plus $75 provides $132.34 against approximately $118 of work, leaving only $14.34 contingency.

Recommendation: revise the capability gate and accept CEO-UC1 with a +$75 ceiling because the current plan can ship no capability gain while spending $128 to repeat unaffected controls.
════════════════════════════════════════════════════════════
```

**Integration (Outside Voice Integration Rule; each finding checked against code or artifacts before disposition).**

| # | Finding (voice) | Check | Disposition |
|---|---|---|---|
| V1 | Reuse the simple-arm cells (both) | Correction text and receipt `argv` confirm: no proxy calls, `--max-tool-chars 100000000`, 0 errored cells | **User Challenge UC1** (both models agree to change the stated A2) |
| V2 | Publish the corrected headline first, decoupled from Item B (native 10, Codex 7) | The `a714410a5` held-out cells (fixed harness, 600) and the simple-arm cells exist; a paired comparison needs no new paid run under UC1 | **User Challenge UC2** (both models agree to split the stated order and the single report rewrite) |
| V3 | Test query-time exact enumeration / lexical-first retrieval before the mention graph (native 1, Codex 2) | `search.mcp_keyword_only` exists (`ops/search.ts` keyword-only branch); the correction measured 14/30 on family E when search fell back to keyword-only, against 4/30 with hybrid | **User Challenge UC3** (both models challenge the chosen mechanism B1-B4) |
| V4 | Real-data validation: dogfood-brain precision (native 6) or independently authored fixtures (Codex 5) | Both name the same gap: every check so far uses the generator's own templates | Accepted (P1): an independently written fixture brain (not Cat 40 templates: buried status, duplicate records, undeclared aliases, people named "Will"/"Grace") in tests, plus a precision run on a real brain when the operator has one available, 90% bar, reported in the PR |
| V5 | Ship a reconciling off switch with the default-on pass (native 6) | Agent-first and opt-out rules: default on, but discoverable off | Accepted (P1, P2): config `mentions.auto_link` (default true); false makes the next sweep delete `link_source='mentions'` rows and skip the pass |
| V6 | Coverage state: the agent cannot tell "nothing indexed" from "nothing exists" (Codex 4) | The card has no freshness field; `get_backlinks` stops at 500 | Accepted (P1, agent-first): the card carries `mentions_index: {pending_pages, last_pass_at}` and, when pending, a hint naming `gbrain extract --stale`; `get_backlinks` with `type` takes `offset` |
| V7 | Cross-source and "project" promise mismatch (Codex 3) | Card inbound edges are same-source (`entity-card.ts`); base-v2 `project` is `primitive: concept` | Accepted (P5): B5 text names accounts, people and companies, not projects; the plan states the same-source scope (`link_resolution.cross_source` opt-in still applies) |
| V8 | Capability gate must bind: "eval winners ship on by default" needs a defined win (Codex 1) vs "15/30 is a stretch goal" (native 5) | `holdout_stats.py` ship rule is non-inferiority only | **Taste CEO-T3**. Provisional: default-on requires the held-out family-E paired difference against `a714410a5` above 0 (point estimate) and the existing ship rule; cost per task may rise at most 25%. 15/30 stays a reported target, not a gate |
| V9 | T1: prefer option B, no new default type (native 3) | Option B changes only `company`'s alias list | Taste CEO-T1 recommendation switches to option B (P5: smaller, no ontology change); A stays the alternative |
| V10 | Fresh-seed world for the headline (native 8) vs disclose third use (Codex 5) | A fresh seed needs fresh simple arms (~$128) and two gbrain runs (~$110), which conflicts with UC1's savings | **Taste CEO-T4**. Provisional: keep seed 20261003 and disclose (P3); alternative: fresh seed at about +$240 |
| V11 | Report the share of family-E tasks where `entity` was called (native 4) | Transcripts are recorded | Accepted (P1, $0) |
| V12 | Report economics per model and arm (Codex 6) | Cells carry `total_usd` | Accepted (P1, $0): cost per successful task per model and arm in A4 |
| V13 | Card: top 3 rows per type (native 13) | An account's open ticket is often not among its 3 newest tickets | Rejected (P1): keeps 10 rows; dev round 1 reports card characters per call |
| V14 | Inline mention scan on writes (native 9) | Needs a cached gazetteer in the write path | Deferred to TODOS.md (P3); V6's `pending_pages` makes the lag visible |
| V15 | Too much machinery (native 7) | Each piece answers a spec-review finding; UC3 decides whether the graph is built at all | Recorded; resolved by UC3 at the gate |

```
CEO DUAL VOICES — CONSENSUS TABLE:
  Dimension                             Claude  Codex  Consensus
  1. Premises valid?                     partly  partly CONFIRMED: "general gap" and "links are the bottleneck" are not proven
  2. Right problem to solve?             no*     no*    CONFIRMED: correct the headline first; capability second (UC2)
  3. Scope calibration correct?          no      no     CONFIRMED: rerunning unaffected simple arms is waste (UC1)
  4. Alternatives sufficiently explored? no      no     CONFIRMED: exact/lexical enumeration not weighed (UC3)
  5. Competitive/market risks covered?   no      no     CONFIRMED: plain files + frontier model may win; economics unreported
  6. 6-month trajectory sound?           no      partly DISAGREE on emphasis: native fears default-on precision; Codex fears an unbinding gate (T3)
  * both treat the problem as real but mis-ordered.
CONFIRMED = completed subagent + outside; both voices completed.
```

#### CEO review sections (SELECTIVE EXPANSION, implementation-ready depth)

Current scope (Section 1 preamble): mode SELECTIVE EXPANSION (autoplan override). Accepted: F1-F11, E1, E2, E5, spec fixes, V4-V7, V11, V12. Provisional Taste: T1 (now recommending option B), T2, T3, T4. Deferred: E3, E4, V14. Rejected: V13. Pending User Challenges: UC1, UC2, UC3 (the original direction stands until the gate).

**Section 1: Architecture.**

```
  sync / put_page ──► import ──► pages, page_aliases(origin=frontmatter)
                                      │
  gbrain extract --stale ────────────┤ (link work, unchanged)
        │                             ▼
        ├─► alias refresh ──► page_aliases(origin=declared|subject)   [entity-type pages only]
        │        ▲                         │
        │   linkableEntityTypes(source pack ∪ legacy four)           │
        │                                  ▼
        ├─► buildGazetteer(per source) ──► entry table diff ──► mention-due marks
        │                                  │
        └─► mention pass (due set, reconcile per page) ──► links(link_source='mentions')
                                                               │
  MCP entity ──► buildEntityCard ──► mentioned_in / mentioned_in_count / mentions_index
  MCP get_backlinks {type, limit, offset} ──► per-page rows + total/truncated
  search alias hop ◄── page_aliases (declared codes widen searches)
```

Data flow, four paths for the mention pass: happy (entity page and ticket → link); nil (no entity types or empty gazetteer → pass records `no_gazetteer` and marks nothing due, as today); empty (page text empty → reconcile deletes its mention rows, inserts none); error (DB error mid-pass → per-page transaction rolls back, watermark not advanced, page stays due, checkpoint resumes). State: page mention state is `due → scanned(version, at)`; an edit (`updated_at` newer), a diff hit or a version bump returns it to `due`; there is no transition from `due` to `scanned` without the transaction committing. Coupling: the card and search's alias hop gain a dependency on derived `page_aliases` rows (justified; V6 exposes pending state). Scaling: at 10x (50k pages) the full pass is the risk (E5 measures it); at 100x the entry-table diff keeps incremental cost proportional to changed names. Security: no new endpoint; `get_backlinks` gains parameters; remote privacy uses the existing two predicates. Rollback: revert the PR; the migration is additive, and `mentions.auto_link=false` removes mention rows without a revert. No new findings beyond those recorded; decision gate: no new choice.

**Section 2: Error & Rescue Map.**

```
  METHOD/CODEPATH                 | WHAT CAN GO WRONG                         | CLASS
  linkableEntityTypes             | pack fails to load                        | pack load error
  alias refresh                   | regex finds a junk alias                  | data quality
  buildGazetteer                  | page_aliases missing (pre-v110)           | undefined-table
  entry-table diff + due marks    | crash between diff and save               | transaction abort
  mention pass                    | time budget hit mid-pass                  | budget stop
  mention pass                    | DB error on a page                        | SQL error
  card mentioned_in               | remote caller, private referrer           | privacy
  get_backlinks {type}            | type not in pack                          | invalid param
  set-cap / A3 launch             | ledger cannot cover projected cost        | budget refusal

  CLASS               | RESCUED? | RESCUE ACTION                                   | AGENT SEES
  pack load error     | Y        | fall back to the legacy four types, warn once   | links for legacy types only; doctor note
  data quality        | Y        | guards drop it (length, generic, collision)     | nothing
  undefined-table     | Y        | titles-only gazetteer (existing)                | fewer links
  transaction abort   | Y        | same transaction; page stays due                | pending_pages > 0
  budget stop         | Y        | checkpoint, resume next sweep                   | pending_pages > 0 + extract hint
  SQL error           | Y        | per-page rollback, logged with slug, continue   | page stays due
  privacy             | Y        | both predicates in rows and counts              | page absent
  invalid param       | Y        | agent-first error naming valid types            | error with fix.next
  budget refusal      | Y        | stop for Garry before launch                    | n/a (operator)
```

No CRITICAL GAP. Requirement added: a `type` value the pack does not know returns the agent-operator error contract with the valid type list (P1; folded into the accepted block).

**Section 3: Security & Threat Model.** New inputs: `type`, `limit`, `offset` on `get_backlinks` (validated: known type, integer bounds). New data path: derived aliases from page bodies into `page_aliases`, which search's alias hop reads. Threat: a world-visible page declaring an alias that makes search pull in a private page (likelihood low, impact medium); mitigated because alias rows only resolve names to the declaring entity page, and search applies `excludePrivate` to results. Threat: the lead snippet leaking private fences inside a visible page (low/high), mitigated by the `safeSynopsis` rule. Threat: derived digests in `mentioned_in` (medium/high), mitigated by both predicates, tested. Alias injection from untrusted content (a page declaring "aka Acme" to hijack links to Acme) (low/medium): collision drop rule means a second claimant removes the alias rather than stealing it. No new secrets or dependencies. Audit: mention links carry `link_source='mentions'` provenance.

**Section 4: Data flow and edge cases.** `INPUT (page text) → VALIDATION (entity-type check, guards) → TRANSFORM (gazetteer match, case check) → PERSIST (reconcile mention rows, watermark) → OUTPUT (card, get_backlinks)`. Shadow paths: nil text (no rows); 3-character or generic alias (dropped); duplicate alias across pages (dropped); same alias from frontmatter and body (precedence); entity retyped (derived rows removed, mention links reconciled on the next pass); concurrent sweeps (the existing extract lock serializes; the due-mark transaction is atomic). Async ordering: a `put_page` that edits a page while the pass scans it → `updated_at` is newer than the watermark written by the pass only if the pass reads the page before the edit commits; the watermark is set to the page's `updated_at` as read, not `now()`, so the edit leaves the page due (accepted requirement). Interaction edge cases: an account with 0 referrers (empty `mentioned_in`, `mentioned_in_count: 0`, `mentions_index.pending_pages` tells whether that is final); with 500+ referrers of one type (`offset` pages them).

**Section 5: Code quality.** DRY: one type resolver (F5), one alias parser shared with `aliasDeclarations` (C2.4), the snippet reuses `safeSynopsis` logic. Naming: `mentioned_in_count` (spec 3). Complexity risk: the stale sweep's control flow gains a second due set; the requirement that dry-run, early return and `staleRemaining` count both keeps it in one function. Over-engineering risk is UC3's subject. No further findings.

**Section 6: Test review.** Every accepted requirement names its tests (accepted block). Added here (P1): the watermark-race test (edit during the pass leaves the page due), an unknown-`type` error test, the off-switch reconciliation test, the independent fixture brain (V4). Test that would make a 2am Friday ship safe: the upgraded-brain test plus the 50k precision report. Hostile QA test: a page declaring `aka Acme` for someone else's entity (collision drop). Chaos test: kill the pass mid-run and resume. Flakiness: none time-dependent except watermark comparisons, which use stored timestamps. Paid evals: A1-A3 as listed; baselines named.

**Section 7: Performance.** The mention pass is O(pages × tokens) with Map lookups; E5 measures 50k pages. The name-set diff prefilter uses the existing `search_vector`/trigram indexes to find candidate pages instead of scanning all. Card query: one indexed join on `links.to_page_id` plus `pages`; the `COALESCE(effective_date, updated_at)` sort uses the existing index named by spec 1. No N+1: snippets come from the same row fetch. No new connections.

**Section 8: Observability.** The pass logs pages scanned, links added and removed, aliases added and dropped by guard (counts per guard), and time used, in `--json` progress events. Doctor: `stale_mentions` and `junk_entity_hubs` keep working; `extraction_sync` reports mention-due pages (accepted). Card: `mentions_index` (V6). Debuggability: `gbrain extract --explain` should show why a name did or did not link; recorded as a requirement on the existing `--explain` path (P1, small).

**Section 9: Deployment and rollout.** Migration is additive (columns with defaults, one new table). Rollout: upgrade → the first `extract --stale` (or autopilot cycle) runs one full mention pass; the CHANGELOG states the measured time from E5 and the off switch. Old and new code side by side: old code ignores the new columns; new code treats null watermarks as due. Rollback: revert, or set `mentions.auto_link=false`. Post-deploy checks: `gbrain doctor` (`stale_mentions`, `junk_entity_hubs`, `extraction_sync`), `entity` on one known account.

**Section 10: Long-term trajectory.** Debt: a second watermark and an entry table to maintain (moderate). Reversibility 4/5 (off switch, additive schema). Path dependency: a precomputed mention graph becomes what cards, context packs and agents rely on; UC3 decides whether that is the right foundation versus query-time enumeration. Platform potential: `context_pack` and `delta` inherit `mentioned_in`. Retrospective on cherry-picks: the master control (F7) and preregistration (E1) are load-bearing for the headline; E3 (doctor coaching) would help real brains adopt pack entity types and stays deferred.

**Section 11: Design & UX.** SKIPPED (no UI scope).

#### CEO required outputs

**NOT in scope.**
- Deferred (TODOS.md): E3 doctor coaching for unlinkable typed records; E4 family-E hybrid-ranking follow-up; V14 inline mention scan on writes.
- Rejected: V13 top-3 card rows (would hide older open tickets); CEO-E7-style extras none.
- Held for the gate (not in scope until approved): UC1 reuse, UC2 decoupled headline, UC3 enumeration-first comparison, T1-T4 alternatives.

**What already exists.** Gazetteer with guards and resume fingerprint (`by-mention.ts`); `page_aliases` with frontmatter aliases feeding the gazetteer, card resolution and search alias hop; `aliasDeclarations` parser (`ops/search.ts`); pack type closure (`classifyStoredType`, `buildAliasGraph`); the opt-in mention pass and `--rebuild` reconcile (`extract.ts`); the card's privacy-filtered inbound query (`entity-card.ts`); `safeSynopsis` redaction (`retrieval-reflex.ts`); keyword-only search path (`search.mcp_keyword_only`); `holdout_stats.py` paired bootstrap; the SQLite budget ledger with `set-cap`. The plan reuses all of them.

**Dream state delta.** After this plan (as amended): typed records with pack-declared types and declared codes are linked by default, cards list everything that links to an entity with coverage state, and the public headline is re-measured. Still short of the 12-month ideal: cross-source identity, inline freshness on writes, typed-field extraction (ticket status as a field), and evidence from real brains rather than one generator.

**Failure Modes Registry.**

```
  CODEPATH              | FAILURE MODE                       | RESCUED? | TEST? | USER SEES?            | LOGGED?
  mention pass          | budget stop mid-pass               | Y        | Y     | pending_pages > 0     | Y
  mention pass          | page edited during scan            | Y        | Y     | page stays due        | Y
  alias refresh         | contract code contributes          | Y        | Y     | nothing (guarded)     | Y
  gazetteer             | word-like all-caps code            | Y        | Y     | nothing (case rule)   | Y
  card                  | derived private digest             | Y        | Y     | page absent           | n/a
  card                  | subject outranks company title     | Y        | Y     | correct entity        | n/a
  default-on upgrade    | precision < 90% on real data       | Y        | Y*    | off switch available  | Y
  A3 launch             | budget cannot cover projection     | Y        | n/a   | stop for Garry        | Y
  dev round             | harm screen fails twice            | Y        | n/a   | stop for Garry        | Y
  * V4 fixture and real-brain run.
```

CRITICAL GAPS: 0.

**Completion Summary.**

```
  +====================================================================+
  |            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
  +====================================================================+
  | Mode selected        | SELECTIVE EXPANSION                         |
  | System Audit         | mention pass never runs; crm not an entity  |
  |                      | type; contracts share codes; simple arms    |
  |                      | unaffected by the stall                     |
  | Step 0               | approach A kept pending UC3; F1-F11, E1,    |
  |                      | E2, E5 accepted; spec loop 3 launches       |
  | Section 1  (Arch)    | 0 new issues (diagram produced)             |
  | Section 2  (Errors)  | 9 error paths mapped, 0 GAPS                |
  | Section 3  (Security)| 4 issues found, 0 High unmitigated          |
  | Section 4  (Data/UX) | 8 edge cases mapped, 0 unhandled            |
  | Section 5  (Quality) | 0 new issues                                |
  | Section 6  (Tests)   | Diagram via accepted block, 4 tests added   |
  | Section 7  (Perf)    | 0 new issues (E5 covers 50k)                |
  | Section 8  (Observ)  | 1 gap found (--explain), accepted           |
  | Section 9  (Deploy)  | 1 risk flagged (first full pass time)       |
  | Section 10 (Future)  | Reversibility: 4/5, debt items: 2           |
  | Section 11 (Design)  | SKIPPED (no UI scope)                       |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (3 deferred, 1 rejected)            |
  | What already exists  | written                                     |
  | Dream state delta    | written                                     |
  | Error/rescue registry| 9 rows, 0 CRITICAL GAPS                     |
  | Failure modes        | 9 total, 0 CRITICAL GAPS                    |
  | TODOS.md updates     | 3 items proposed (E3, E4, V14)              |
  | Scope proposals      | 17 proposed, 13 accepted (EXP + SEL)        |
  | CEO plan             | written (ceo-plans/2026-10-04-...md)        |
  | Outside voice        | codex completed                             |
  | Lake Score           | N/A (no coverage-scored questions asked)    |
  | Diagrams produced    | 4 (architecture, error map, data flow,      |
  |                      | failure registry)                           |
  | Stale diagrams found | 0                                           |
  | Unresolved decisions | 7 (UC1, UC2, UC3, T1, T2, T3, T4: gate)     |
  +====================================================================+
```

Approval readiness: PASS. Checked rows: CEO-0E, CEO-0D (both items), CEO-F1 to F11, CEO-E1, E2, E5 (auto-decided under autoplan, P1/P2/P5 as cited), spec fixes S1-S5 and launch-2/3 fixes (auto-decided, cited in the 0H tables), V4-V7, V11, V12 (auto-decided, cited above), V13 rejected, E3/E4/V14 deferred. Pending for the gate: UC1-UC3, T1-T4.

#### CEO Implementation Tasks

Synthesized from the CEO findings above (JSONL: `tasks-ceo-review-20261004-155936.jsonl`). Effort assumes features ~30x, tests ~50x human:CC.

- [ ] **T1 (P1, human: ~1d / CC: ~1h)** — gbrain/extract — Reconciling mention pass inside `extract --stale` with its own due set, watermark, version and entry-table diff (additive migration). Surfaced by: system audit 1, CEO-F1, spec F5.1. Verify: fresh, upgraded and slot-style brain tests.
- [ ] **T2 (P1, human: ~3h / CC: ~15m)** — gbrain/schema-pack — `linkableEntityTypes` resolver; base-v2 makes `crm` linkable per T1. Surfaced by: audit 2, 6. Verify: resolver tests across packs.
- [ ] **T3 (P1, human: ~1d / CC: ~1h)** — gbrain/aliases — Entity-page alias sources with origin precedence, all-caps rule, first-word rejection. Surfaced by: audit 3, 4, 8, 15. Verify: alias test list in the accepted block.
- [ ] **T4 (P1, human: ~1d / CC: ~45m)** — gbrain/entity-card — `mentioned_in_count`, `mentioned_in`, `mentions_index`; subject rank. Surfaced by: audit 5, 7, 13, V6. Verify: shape, privacy, snippet and rank tests.
- [ ] **T5 (P1, human: ~4h / CC: ~20m)** — gbrain/links-op — `get_backlinks` `type`/`limit`/`offset`, per-page rows, `total`/`truncated`, unknown-type error. Verify: follow-up call reproduces the card group.
- [ ] **T6 (P1, human: ~2h / CC: ~10m)** — gbrain/mcp — B5 replacement and budget trades. Verify: `test/mcp-schema-budget.test.ts` with unchanged ceilings.
- [ ] **T7 (P1, human: ~2h / CC: ~10m)** — gbrain/config — `mentions.auto_link` off switch. Verify: reconciling-removal test.
- [ ] **T8 (P1, human: ~1d / CC: ~1h)** — gbrain/tests — independent fixture brain, race test, 50k precision and timing. Verify: PR states the numbers.
- [ ] **T9 (P1, human: ~3h / CC: ~20m)** — evals/prereg — preregistration and `holdout_stats.py` modes. Verify: commit precedes the A3 receipt.
- [ ] **T10 (P1, human: ~1d / CC: ~2h)** — evals/runs — control, dev rounds, A2 or UC1 rescore, A3 with the budget projection. Verify: receipts and ledger status.
- [ ] **T11 (P2, human: ~4h / CC: ~30m)** — evals/report — A4 rewrite with disclosures. Verify: report sections and numbers match receipts.

#### CEO phase close

Close packet prepared below with checkpoint `autoplan-ceo-xur3nF`.

Close packet `autoplan-ceo-W9BZ9N/close-packet.md` (245 lines) read in full and verified against the decisions above; phase report sent. Phase 1 complete: outside review completed (Codex, 7 concerns), native subagent completed (13 issues), consensus 5/6 confirmed with 1 disagreement to the gate (T3).

### Phase 2 (Design): skipped, no UI scope detected. Not a completed review.

### DX phase (Phase 2.5)

Methodology reads: DX bundle `autoplan-dx-methodology-jmsLyz/methodology.md` read at ranges 1-503, 504-1103, 1104-1673, 1674-2175 (EOF, 2,175 lines); `dx-hall-of-fame.md` passes 1-8 and the agent-tool checklist read (127 lines).

Mode: DX POLISH (autoplan override). The DX input is the CEO-amended plan; CEO's pending User Challenges stay pending.

#### Step 0: DX investigation

**Product type (auto-detected, confirmed by the operator rule "assume an AI agent is the operator").** Primary: MCP server for AI agents (`entity`, `get_backlinks`, server instructions). Secondary: CLI (`gbrain extract --stale`, `gbrain doctor`, `gbrain upgrade`) run by an agent or an autopilot cycle. Tertiary: the eval harness (gbrain-evals runners) used by the agent that runs paid rounds.

```
TARGET DEVELOPER PERSONA
========================
Who:       An AI agent (Claude Code, Codex, OpenClaw-class) connected to a user's brain over MCP, plus the
           same or another agent acting as the brain's operator on the CLI.
Context:   Asked "brief me on Quormiro Capital before the renewal call" or "who owns QUCO and is anything
           open?"; separately, runs `gbrain upgrade` and the stale sweep on the user's machine.
Tolerance: 1-3 tool calls before it falls back to search loops; it reads every word of tool descriptions
           and server instructions, and it trusts counts literally.
Expects:   One call that resolves a name or code to the thing, a complete list of what mentions it, a way
           to page the rest, and errors that say what to run next (gbrain's agent operator protocol).
```

Persona chosen by P6 (inferred from AGENTS.md "Assume an AI agent is the operator" and the agent operator protocol docs); no question asked.

**Empathy narrative (first person, the agent).** "Garry asks for a renewal brief on Quormiro Capital. The server instructions tell me a search returns the best-ranked excerpts, so I search 'Quormiro Capital renewal'. I get short emails and a closed ticket. I search 'QUCO open ticket' and get more of the same. I call `entity` on Quormiro Capital: it finds `crm/quormiro-capital` but says `backlink_count: 0` and no edges, so as far as I can tell nothing else in the brain is about this account. I try `get_backlinks` and get `[]`. I have no way to know whether that means 'no pages' or 'not indexed'. I answer from the CRM record and two emails, and I say the account has no open tickets. I'm wrong, and nothing told me I might be." (Observed: the zero-link brain, the empty backlinks, the search behavior from the report. Predicted: the agent's final wording.)

After this plan, as amended: `entity("QUCO")` resolves to the record, the card lists tickets, meetings and mail grouped by type with dates and a lead snippet that shows `Status: Open`, and `mentions_index.pending_pages: 0` tells me the list is complete for this source.

**Competitive DX benchmark (in-distribution plus the CEO landscape search).**

| Tool | Start → result | Time + evidence type | DX choice | Source |
|---|---|---|---|---|
| grep over Markdown (the fs arm) | name or code → every file containing it | seconds; observed in Cat 40 runs | exhaustive, alias-agnostic only if the agent greps each name | Cat 40 fs transcripts |
| Obsidian unlinked mentions / open-second-brain | note → backlinks plus unlinked mentions via frontmatter aliases | interactive, instant; reported | alias index plus mention scanner | open-second-brain v0.10.17 release notes |
| Zep/Graphiti, Mem0 graph | entity → edges built at write time by an LLM | reported; paid LLM per write | write-time extraction, temporal edges | vendor docs (CEO native finding 12) |
| gbrain today | name → card with 0 edges for typed records | one call, wrong answer; observed | opt-in mention pass never runs | system audit 1 |
| gbrain after this plan | name or code → card with `mentioned_in` by type, coverage state | one call after one stale sweep; estimated | default-on gazetteer pass, no LLM | this plan |

**Clock and target (auto-decided, P5).** Clock: from `gbrain upgrade` finishing on an existing 4k-page brain to the first `entity` call that returns a complete `mentioned_in` for an account. Today: never (the pass does not run). Plan as drafted: unbounded (waits for an autopilot cycle or a manual `extract --stale`; the agent is not told). Target: Competitive (2-5 minutes): `gbrain post-upgrade` names the one command (`gbrain extract --stale`) and the card's `mentions_index` says when it is still pending; on a 4k-page brain the pass finishes inside the first sweep. Champion (< 2 min) would need the pass inline in the upgrade, which conflicts with the stale sweep's time budget on 50k-page brains (TASTE would be needed; not pursued).

**Magical moment.** The agent calls `entity("QUCO")` and gets the account, its open ticket at the top of the ticket group, and the latest meeting, in one call. Vehicle (lowest effort that reaches it, P5): the existing `entity` card, extended (no new tool). Alternative considered: a new `brief` verb (rejected: a new tool costs schema budget and the 25k served ceiling is nearly full).

**Journey trace (DX POLISH: all stages).**

```
STAGE           | DEVELOPER (AGENT) DOES                       | FRICTION POINTS                                  | STATUS
----------------|----------------------------------------------|--------------------------------------------------|--------
1. Discover     | reads server instructions                    | instructions say search, never entity, for briefs | fixed (B5 sentence)
2. Install      | `gbrain upgrade` (agent-run)                 | no notice that a full mention pass is due          | fixed (DX-1 post-upgrade line)
3. Hello World  | `entity("QUCO")`                             | code did not resolve; 0 edges                      | fixed (B2 aliases, B3 card)
4. Real Usage   | walks `mentioned_in`, pages via get_backlinks | 500-row stop, no total, no coverage state          | fixed (offset, total, mentions_index)
5. Debug        | "why isn't X linked?"                        | no explanation path                                | fixed (`extract --explain`, DX-3 message)
6. Upgrade      | reads CHANGELOG, runs doctor                 | first pass time unknown; off switch unknown        | fixed (DX-2 CHANGELOG contract, doctor line)
```

**First-time developer roleplay (the agent, on an upgraded brain).**

```
FIRST-TIME DEVELOPER REPORT
============================
Persona: AI agent operator over MCP, upgraded brain, 4k pages
Attempting: an account brief right after `gbrain upgrade`

CONFUSION LOG:
T+0:00  Calls entity("QUCO"). As drafted: card found via the new alias, mentioned_in empty because the pass
        has not run. Nothing says "pending". (Addressed: mentions_index.pending_pages + hint.)
T+0:30  Calls get_backlinks {slug, type: "ticket"}. As drafted: empty. (Addressed by the same coverage state.)
T+1:00  Runs `gbrain extract --stale` because the hint names it. Pass runs; progress shows pages scanned.
T+2:00  entity("QUCO") again: tickets, meetings, mail. Open ticket visible in the lead snippet.
T+3:00  Succeeded. Remaining confusion: why is `notes/agents/...-quormiro-capital-terms` not listed? Because
        the agent note names the account only by its first word. (Addressed: --explain says "ambiguous
        first-word mention, never linked alone".)
```

Initial DX completeness for the plan as drafted: 4/10 (the capability was specified; discovery, coverage state, upgrade notice and debugging were not).

#### Step 0.5: DX dual voices

Snapshot: `autoplan-dx-Rof8lT/dx-implementation.md`, SHA-256 `1712913c…d371` (the CEO-amended plan).

**Claude SUBAGENT (DX — independent review).** Completed; started with `INPUT: dx 1712913c…d371` (matches) after a full read of `native-prompt.md` (214 lines, hash checked). 0 critical, 3 high, 12 medium:
- H1 "default on" means "on at the next sweep": the autopilot drain has a 3-minute budget (`CYCLE_STALE_DRAIN_BUDGET_MS`, `cycle.ts:609`) and the mention pass runs after link work, so an upgraded brain can take many cycles; `post-upgrade` should print an `[AGENT]` line.
- H2 `gbrain extract --explain <kind>` already exists (`extract-explain.ts`, pack-author tool); reusing it collides.
- H3 `mentions.auto_link` sits beside the registered global `auto_link` key (`config.ts:1567`); precedence and registration are unstated.
- M: sync contradiction (`sync-run.ts:304` calls `extractManagedStaleLinks` inline, so sync would run mentions); `get_backlinks` returns two shapes; field vocabulary (`mentioned_in` counts every link source); T1 option B makes tickets group under `company`; only one error path specified; `pending_pages` not tied to a degraded-result notice; no copy-paste examples; no guide for making records linkable; B5 is the only agent guidance; no per-page or per-alias override; no type opt-in without forking a pack; no override for the all-caps rule.

**Codex SAYS (DX — developer experience challenge).** Completed (`OUTSIDE_STATUS: completed provider=codex host=claude`, 129 s):

```tool-output
CODEX SAYS (DX — developer experience challenge):
════════════════════════════════════════════════════════════
I would request changes before enabling this by default. Automatic extraction, coverage metadata, paging, and structured invalid-type errors are useful improvements, but the plan still leaves agents unable to distinguish several failure states from successful enumeration.

This is a static review of the plan and repository; setup times were not measured.

| Dimension | Assessment |
|---|---|
| Time to hello world | Under five minutes is unproven; the documented MCP setup cannot complete the proposed flow. |
| Error messages | Good existing protocol, incompletely specified recovery for this feature. |
| API/CLI design | Sensible entry point; inconsistent enumeration and completeness semantics. |
| Documentation | No complete account-recall tutorial or documented response examples planned. |
| Upgrade path | Additive migration helps, but activation, pack compatibility, and reversal need contracts. |

1. **P1 — The recommended setup leads to an uncallable follow-up.**  
   The [README quickstart](/workspace/gbrain/README.md:175) configures `--surface verbs`. That surface exposes exactly seven verbs and excludes `get_backlinks`; hidden tools are also rejected at dispatch ([surface.ts](/workspace/gbrain/src/mcp/surface.ts:9)). A card containing more than ten tickets would advertise a call that fails. B5’s replacement also sits inside a search/query-only instruction branch, so it would not reach verbs-only clients ([instructions.ts](/workspace/gbrain/src/mcp/instructions.ts:47)).

   **Required change:** document `starter` for the complete account-brief workflow. Make instructions and card continuation actions respect the caller’s actual capabilities, with a structured operator action when enumeration is unavailable. Test the same truncated card on verbs, starter, and restricted remote connections.

2. **P1 — Coverage metadata still permits false “nothing found” conclusions.**  
   `mentions_index: {pending_pages, last_pass_at}` cannot distinguish disabled linking, an unsupported entity type, failed extraction, and a completed scan with zero matches. When alias extraction has not happened, `entity("QUCO")` can miss entirely, leaving no card on which to display the recovery hint. Direct `get_backlinks` callers also need coverage information.

   **Required change:** specify explicit coverage states and expose them on misses and direct enumeration results. State that completeness covers recognized names within the caller’s permitted source scope—not every possible reference. Render recovery through the existing [agent-operator action contract](/workspace/gbrain/docs/protocol/AGENT_OPERATOR_v1.md:599), including `fix.next`, correct brain/source routing, host-operator ownership where necessary, and read-only verification. A bare `gbrain extract --stale` hint is insufficient for remote agents.

3. **P1 — “Upgrade, then extract” does not work uniformly, and the off switch is not a rollback.**  
   Existing installations retain their schema pack ([init.ts](/workspace/gbrain/src/commands/init.ts:72)); this plan deliberately leaves legacy packs unchanged. Consequently, an upgraded CRM brain can finish extraction without gaining CRM mention linking. Separately, disabling `mentions.auto_link` deletes mention edges but retains derived aliases and their search-expansion effects. Re-enabling is not specified to invalidate watermarks after those edges were deleted.

   **Required change:** add an upgrade behavior table covering base-v2, legacy, and custom packs; activation and restart steps; progress/resume behavior; and off/on semantics. Explicitly state what disabling reverses. Test enabled → disabled → enabled without editing any pages, plus an upgrade retaining a legacy pack.

4. **P1 — The expanded card needs a total response and latency budget.**  
   Ten rows per type does not bound the card across arbitrary schema packs. The schema-character ceilings constrain tool definitions, not returned evidence. The repository also builds entity cards inside `context_pack` and `delta` ([turn-context.ts](/workspace/gbrain/src/core/context/turn-context.ts:505)); additional queries therefore affect ambient calls even where their output projections omit the new fields. The published [`entity` contract](/workspace/gbrain/docs/protocol/MEMORY_VERBS_v1.md:584) promises p99 below 100 ms.

   **Required change:** define a whole-card budget with explicit continuation, preserve inexpensive ambient card construction, and measure direct entity, context-pack, and delta latency on mention-dense data. Cat 40 task cost alone does not establish acceptable everyday agent behavior.

5. **P2 — `get_backlinks` makes a filter change the meaning of the operation.**  
   Without `type`, callers receive legacy per-link rows; adding `type` changes deduplication, ordering, limits, and response metadata. An agent reasonably expects a filter to narrow the same result model. Canonical types also differ from stored labels under either T1 option.

   **Required change:** specify exact JSON examples for both modes and clearly identify `type` as the referring page’s canonical type. Return an executable continuation containing source, type, limit, and offset. Define a deterministic date tie-breaker and behavior under concurrent edits. Verify enumeration of more than 500 pages, including equal timestamps, with no omissions or duplicates on unchanged data. Preserve existing calls without deprecation.

6. **P2 — The preview fields invite incorrect factual answers.**  
   `COALESCE(effective_date, updated_at)` is an ordering date, not necessarily the last email or meeting date. The repository already tracks [`effective_date_source`](/workspace/gbrain/src/core/types.ts:119), but the proposed row hides that distinction. Likewise, the first 160 characters cannot reliably expose ticket status; the independent fixture explicitly puts status mid-body.

   **Required change:** expose date provenance and label snippets as previews. Show agents fetching canonical page content before asserting status, blockers, or event dates when the preview lacks evidence. Otherwise the feature can improve enumeration while preserving wrong briefs.

7. **P2 — The diagnostic command is not specified enough to use.**  
   [`extract --explain`](/workspace/gbrain/src/commands/extract-explain.ts:1) already consumes an extraction *kind*. “Says why a name did or did not link” does not define how to supply the document, entity/name, and source, or what machine-readable result comes back.

   **Required change:** define backward-compatible syntax and reason codes for ambiguity, short aliases, case mismatch, unsupported types, disabled linking, and pending extraction. Include copy-paste examples and recovery actions. Do not recommend rerunning extraction for a name intentionally rejected by policy.

8. **P2 — Neither onboarding nor documentation has an acceptance test.**  
   Assuming Bun and an agent client already exist, a minimal feature demonstration needs roughly seven actions: install, initialize, create sample documents, import, extract, connect/restart, and query. The plan supplies neither that runnable sequence nor expected output. Updating a changelog and one instruction sentence does not establish two-minute discoverability.

   **Required change:** link one keyless account-recall tutorial from the README, with complete sample files, CLI commands, MCP JSON calls, expected counts, pagination, and a failed-alias example. Update the memory protocol and CLI help. Time a fresh-install journey against the five-minute target; measure bulk backfill separately.

Keep the headline correction independent of these capability changes, consistent with UC2. UC3’s query-time enumeration comparison should include operator steps, freshness, and failure recovery alongside retrieval accuracy. UC1 and the pending taste choices remain owner decisions.

Recommendation: revise the DX contract before default-on and publish the corrected headline independently because the documented setup cannot finish enumeration and incomplete coverage can still look like an authoritative empty result.
════════════════════════════════════════════════════════════
```

Verification of the load-bearing claims (local reads, $0): `extract-explain.ts` header confirms `gbrain extract --explain <kind>`; `auto_link` is registered at `config.ts:1567`; `CYCLE_STALE_DRAIN_BUDGET_MS = 3 * 60 * 1000`; `sync-run.ts:304` calls `extractManagedStaleLinks(..., maxPages: 1000)`; the README quickstart uses `--surface verbs`, which serves exactly the seven verbs (no `get_backlinks`); the B5 sentence sits in the `any('search','query')` branch of `instructions.ts`, whose comment says the wording is measured Cat 40 guidance; `MEMORY_VERBS_v1.md` gates `entity` at p99 < 100 ms on a 20K-page corpus.

```
DX DUAL VOICES — CONSENSUS TABLE:
  Dimension                           Claude  Codex  Consensus
  1. Getting started < 5 min?          no      no     CONFIRMED gap: activation waits on sweeps; no tutorial
  2. API/CLI naming guessable?         no      no     CONFIRMED: --explain collision, two get_backlinks shapes
  3. Error messages actionable?        partly  no     CONFIRMED: pending/disabled/unsupported look like "none"
  4. Docs findable & complete?         no      no     CONFIRMED: no examples, no linkability guide
  5. Upgrade path safe?                partly  no     CONFIRMED: sweep timing, legacy packs, off/on semantics
  6. Dev environment friction-free?    partly  no     CONFIRMED: sync contradiction (native), verbs surface (Codex)
CONFIRMED = native + outside agree. 0 disagreements. No single-voice critical findings.
```

Both voices completed, so scope changes both agree on would be User Challenges; none here changes Garry's stated direction (the DX fixes complete accepted scope). Codex restates support for CEO-UC2.

#### DX passes (rated before → after)

**Pass 1: Getting started (4 → 8).** Before: no path from upgrade to a working card was specified, and the README's `--surface verbs` quickstart cannot call `get_backlinks`. Fixes accepted (P5, fewer steps): `post-upgrade` prints an `[AGENT]` line naming `gbrain extract --stale --catch-up` with an estimated time from page count; the mention pass gets a reserved half of the autopilot drain budget whenever mention-due pages exist; a keyless account-recall tutorial (`docs/guides/entity-recall.md`) with sample files, commands, MCP JSON and expected output, timed fresh-install against the 5-minute target. Ideal sequence for an existing brain: `gbrain upgrade` (prints the line) → `gbrain extract --stale --catch-up` (about 1 minute per 5k pages, measured by E5) → `entity("QUCO")`. Residual: autopilot-only users wait for cycles; the coverage state makes that visible.

**Pass 2: API/CLI design (5 → 8).** Fixes (P5 consistency): the diagnostic becomes `gbrain extract mentions --explain <name|slug> [--page <slug>] [--source-id <id>] [--json]`, leaving `extract --explain <kind>` unchanged; `get_backlinks` keeps `type` as a pure filter and gains `group: "page"` for per-page rows (the card's continuation passes both), always returns `total` and `truncated`, orders by date then slug, and accepts `offset`; card fields are renamed to say what they count: `referenced_by` and `referenced_by_count` (every inbound link source, distinct pages), with the `entity` description glossing "backlink_count excludes mentions"; `mentions.auto_link` is registered beside `auto_link`, and global `auto_link=false` also stops the mention pass; under T1 option B, `type` accepts `crm` and `account` as inputs and the response echoes `canonical_type`. Residual: two row shapes remain (per-link default kept for existing callers), documented with examples.

**Pass 3: Errors and debugging (4 → 8).** Traced paths: (1) pass pending after upgrade: before, an empty list; after, `coverage: {state: "pending", pending_pages, last_pass_at}`, `degraded: true` and a `[gbrain notice]` with `fix.next` (`run` for local callers, `tell_user_to_run` with the exact command for remote callers). (2) Name never linked: before, nothing; after, `extract mentions --explain` returns a reason code (`ambiguous_first_word`, `below_min_length`, `generic_token`, `alias_collision`, `case_mismatch`, `type_not_linkable`, `linking_disabled`, `pending`, `ignored_by_page`) and never suggests rerunning extraction for a policy rejection. (3) Invalid `get_backlinks` input (`limit` > 500, unknown `type`, `offset` without results): agent-operator error with the valid values. Coverage states: `complete`, `pending`, `disabled`, `type_not_linkable`, `failed`; shown on cards, on `entity` misses (`found: false`) and on `get_backlinks` results. Completeness is stated as "recognized names within the caller's permitted sources".

**Pass 4: Documentation (3 → 8).** Fixes: the tutorial above (linked from README); a "make your records findable by name" section (linkable types per pack, `primitive: entity` in a custom pack, the title-subject rule, declaration keywords, the all-caps rule, the 4-character minimum, first-word ambiguity, overrides); `MEMORY_VERBS_v1.md` gains the additive card fields; CLI help and CHANGELOG with JSON examples of a truncated group and its exact continuation; the longer how-to lives in the `entity` and `get_backlinks` descriptions within budget ("previews are not evidence: fetch the page before stating status or dates").

**Pass 5: Upgrade path (4 → 8).** Fixes: an upgrade table in the CHANGELOG and guide (base-v2, legacy `gbrain-base`, custom packs: what links after upgrade, what needs `mentions.entity_types` or a pack edit); off/on semantics: `mentions.auto_link=false` deletes mention links and derived (`declared`, `subject`) alias rows on the next sweep, and turning it back on marks every page due and re-derives aliases; the migration is additive and `MEMORY_VERBS` changes are additive only; `gbrain extract --stale --dry-run` shows mention-due pages and `last_pass_at`.

**Pass 6: Developer environment (5 → 8).** Fixes: sync passes `{mentions: false}` to `extractManagedStaleLinks`, with a test that sync writes no mention rows; config `mentions.entity_types` (add/remove; the legacy four cannot be removed) and `mentions.ignore` (names), plus frontmatter `mention_ignore: [names]` on a referring page; the verbs surface gets a card continuation that names the starter surface instead of an uncallable tool, and B5's sentence is emitted where `entity` is served (its `get_backlinks` clause only where that tool is served), with each surface's instructions size recorded and tested; `entity` keeps its p99 < 100 ms gate on the 20K corpus with mention-dense data, and `context_pack` and `delta` do not compute `referenced_by` (ambient calls stay cheap).

**Pass 7: Community and ecosystem (6 → 7).** gbrain is open source with skills and docs; the plan's general claim ("any brain with typed records") needs the linkability guide (Pass 4) so pack authors can opt types in. No further findings.

**Pass 8: DX measurement (3 → 7).** Measured: fresh-install tutorial time (local, keyless), first-pass time per 5k pages (E5), share of family-E tasks calling `entity` (V11), `entity`/`context_pack`/`delta` latency on mention-dense data. Not added: telemetry or a recurring human process (no consumer).

#### DX required outputs

**Developer journey map (9 stages).**

```
STAGE              | AGENT/OPERATOR DOES                           | FRICTION (before)                    | STATUS
1. Discover        | reads instructions / tool descriptions        | brief guidance points at search      | fixed (B5 placement, descriptions)
2. Evaluate        | reads tutorial and card example               | no example exists                    | fixed (entity-recall guide)
3. Install/Upgrade | `gbrain upgrade`                              | silent: pass due, nobody told        | fixed ([AGENT] post-upgrade line)
4. Activate        | `gbrain extract --stale --catch-up`           | pass never ran; cycles too short     | fixed (default-on, reserved budget)
5. Hello world     | `entity("QUCO")`                              | code did not resolve; 0 edges        | fixed (aliases, referenced_by)
6. Real usage      | walks groups, continues with get_backlinks    | 500 cap, no totals, verbs can't call | fixed (group/offset/total, surface-aware continuation)
7. Debug           | "why isn't this page listed?"                 | no tool; --explain taken             | fixed (extract mentions --explain + reason codes)
8. Tune            | silences a bad name, opts a type in           | only a global off switch             | fixed (mentions.ignore, mention_ignore, entity_types)
9. Upgrade again   | reads CHANGELOG, doctor                       | off/on and legacy packs undefined    | fixed (upgrade table, off/on semantics)
```

**Developer empathy narrative.** Written in Step 0 above; after the fixes, the agent's T+0:00 call returns `coverage.state: "pending"` with the exact command, instead of a silent empty list.

**TTHW assessment.** Current: never (the pass does not run). Plan as drafted: unbounded. Target: Competitive, under 5 minutes from `gbrain upgrade` on a 4k-page brain to a complete card, and under 5 minutes for the keyless tutorial on a fresh install (to be timed, not yet measured).

**DX Scorecard.**

```
+====================================================================+
|              DX PLAN REVIEW — SCORECARD                             |
+====================================================================+
| Dimension            | Score  | Prior  | Trend  |
|----------------------|--------|--------|--------|
| Getting Started      |  8/10  |  4/10  |  ↑     |
| API/CLI/SDK          |  8/10  |  5/10  |  ↑     |
| Error Messages       |  8/10  |  4/10  |  ↑     |
| Documentation        |  8/10  |  3/10  |  ↑     |
| Upgrade Path         |  8/10  |  4/10  |  ↑     |
| Dev Environment      |  8/10  |  5/10  |  ↑     |
| Community            |  7/10  |  6/10  |  ↑     |
| DX Measurement       |  7/10  |  3/10  |  ↑     |
+--------------------------------------------------------------------+
| TTHW                 | <5 min (target) | never | ↑  |
| Competitive Rank     | Competitive (target)                         |
| Magical Moment       | designed via the existing entity card        |
| Product Type         | MCP server for agents + CLI                  |
| Mode                 | POLISH                                       |
| Overall DX           |  8/10  |  4/10  |  ↑     |
+====================================================================+
| DX PRINCIPLE COVERAGE                                               |
| Zero Friction      | covered (default-on, one command, notice)      |
| Learn by Doing     | covered (keyless tutorial)                     |
| Fight Uncertainty  | covered (coverage states, reason codes)        |
| Opinionated + Escape Hatches | covered (defaults + ignore/types/off)|
| Code in Context    | covered (card JSON + continuation examples)    |
| Magical Moments    | covered (entity("QUCO") in one call)           |
+====================================================================+
```

No dimension below 6; TTHW target under 10 minutes.

**DX Implementation Checklist.**

```
[ ] Upgrade → complete card < 5 min on a 4k-page brain (timed)
[ ] Keyless tutorial completes < 5 min on a fresh install (timed)
[ ] post-upgrade prints the [AGENT] activation line with an estimate
[ ] entity("QUCO") returns referenced_by with an open ticket preview
[ ] Every new error/notice has code, why, fix.next, fix.verify
[ ] coverage.state on cards, misses and get_backlinks
[ ] extract mentions --explain with reason codes; extract --explain <kind> unchanged
[ ] get_backlinks: type filter, group:"page", total/truncated/offset, deterministic order
[ ] mentions.auto_link registered; auto_link=false wins; off/on semantics tested
[ ] mentions.entity_types, mentions.ignore, frontmatter mention_ignore
[ ] sync writes no mention rows (test)
[ ] verbs-surface continuation names the starter surface; per-surface instruction sizes tested
[ ] entity p99 < 100 ms on 20K mention-dense corpus; context_pack/delta unchanged cost
[ ] Guide, MEMORY_VERBS additive fields, CLI help, CHANGELOG upgrade table
```

**NOT in scope (DX).** A new `brief` verb (schema budget; the card covers it). Telemetry for TTHW (no consumer). Inline mention scan on writes (deferred, CEO V14).

**What already exists (DX).** Agent operator protocol (`AGENT_OPERATOR_v1.md`: code, why, fix.next, fix.verify, `[gbrain notice]`, `[AGENT]` markers); `post-upgrade` prompts; `gbrain doctor` checks (`stale_mentions`, `junk_entity_hubs`, `extraction_sync`); config registry; surfaces (`verbs`, `starter`, `full`) and `request_tools`; `MEMORY_VERBS_v1` contract with CI latency gates.

**TODOS.md (DX).** No new DX deferrals beyond CEO V14.

<!-- autoplan-accepted:dx -->
- Activation (Pass 1, 5): `gbrain post-upgrade` prints an `[AGENT]` line when mention-due pages exist, naming `gbrain extract --stale --catch-up` and an estimate from the page count; the autopilot drain reserves half its budget for the mention pass while mention-due pages exist; `gbrain extract --stale --dry-run` shows mention-due pages and `last_pass_at`. Verify: post-upgrade output test; a cycle test showing mention progress on an upgraded brain whose links are current.
- Field names (Pass 2), replacing the CEO block's `mentioned_in`, `mentioned_in_count`, `mentions_index` and "lead snippet": the card's fields are `referenced_by` (rows: slug, title, type, canonical_type, date, date_source, preview), `referenced_by_count` and `coverage`; the `entity` description says `backlink_count` excludes mentions and `referenced_by` counts every inbound link. Verify: MEMORY_VERBS conformance fixtures updated additively.
- `get_backlinks` (Pass 2, 3): `type` filters in both modes; `group: "page"` returns per-page rows; responses always carry `total` and `truncated`; `offset` pages; ordering is date descending then slug; `limit` > 500 and unknown `type` return the agent-operator error with valid values; under T1 option B, `crm` and `account` are accepted as `type` and the response echoes `canonical_type`. The card's continuation is `get_backlinks {slug, source_id, type, group: "page", limit, offset}`. Verify: JSON-shape tests for both modes; enumeration of more than 500 pages with equal dates and no omissions or duplicates.
- Coverage (Pass 3): `coverage: {state, pending_pages, last_pass_at}` with states `complete`, `pending`, `disabled`, `type_not_linkable`, `failed`, on cards, on `entity` misses and on `get_backlinks`; any state other than `complete` adds `degraded: true` and a `[gbrain notice]` with `fix.next` (`run` locally, `tell_user_to_run` for remote callers) and a read-only `fix.verify`. Completeness is stated as recognized names within the caller's permitted sources. Verify: one test per state, local and remote.
- Diagnostics (Pass 2, 3): `gbrain extract mentions --explain <name|slug> [--page <slug>] [--source-id <id>] [--json]` returns the matched entry, `origin` and a reason code (`ambiguous_first_word`, `below_min_length`, `generic_token`, `alias_collision`, `case_mismatch`, `type_not_linkable`, `linking_disabled`, `pending`, `ignored_by_page`); it never suggests rerunning extraction for a policy rejection. `gbrain extract --explain <kind>` is unchanged. This replaces the CEO block's `extract --explain` wording. Verify: one test per reason code.
- Config and overrides (Pass 2, 6): `mentions.auto_link` is registered; global `auto_link=false` also stops the pass; `mentions.auto_link=false` deletes mention links and `declared`/`subject` alias rows on the next sweep, and re-enabling marks every page due and re-derives aliases; `mentions.entity_types` (add/remove; the legacy four cannot be removed), `mentions.ignore` (names) and frontmatter `mention_ignore: [names]` on a referring page. Verify: enabled → disabled → enabled test without page edits; override tests.
- Surfaces and cost (Pass 6): sync calls `extractManagedStaleLinks` with `{mentions: false}` (test: sync writes no mention rows); on the verbs surface a truncated group's continuation names the starter surface instead of an uncallable tool; B5's sentence is emitted wherever `entity` is served, with its `get_backlinks` clause only where that tool is served, and each surface's instructions size is recorded and tested; `entity` keeps p99 < 100 ms on the 20K corpus with mention-dense data; `context_pack` and `delta` do not compute `referenced_by`. The `previews are not evidence: fetch the page before stating status or dates` guidance goes in the `entity` description. Verify: surface tests; latency gate.
- Docs (Pass 4, 5): `docs/guides/entity-recall.md` (keyless tutorial with sample files, commands, MCP JSON, expected output, pagination, a failed-alias example; a "make your records findable by name" section; an upgrade table for base-v2, legacy and custom packs), linked from README; `MEMORY_VERBS_v1.md` additive fields; CLI help; CHANGELOG with the upgrade table, off switch and first-pass time. Verify: the tutorial run timed on a fresh install, under 5 minutes.
<!-- /autoplan-accepted:dx -->

#### DX Implementation Tasks

- [ ] **D1 (P1, human: ~3h / CC: ~15m)** — gbrain/upgrade — `[AGENT]` activation line, reserved cycle budget, dry-run counts. Surfaced by: Pass 1, native H1. Verify: post-upgrade and cycle tests.
- [ ] **D2 (P1, human: ~4h / CC: ~20m)** — gbrain/entity-card — rename to `referenced_by`, `referenced_by_count`, `coverage`; `preview`, `date_source`, `canonical_type`. Surfaced by: Pass 2, native M. Verify: conformance fixtures.
- [ ] **D3 (P1, human: ~4h / CC: ~20m)** — gbrain/links-op — `group: "page"`, `total`/`truncated`/`offset`, ordering, errors. Surfaced by: Pass 2-3, both voices. Verify: >500-page enumeration test.
- [ ] **D4 (P1, human: ~3h / CC: ~15m)** — gbrain/coverage — coverage states and degraded notices on cards, misses and `get_backlinks`. Surfaced by: Pass 3, both voices. Verify: per-state tests.
- [ ] **D5 (P1, human: ~4h / CC: ~20m)** — gbrain/cli — `gbrain extract mentions --explain` with reason codes. Surfaced by: Pass 2-3, both voices. Verify: per-reason tests; `extract --explain <kind>` unchanged.
- [ ] **D6 (P1, human: ~3h / CC: ~15m)** — gbrain/config — `mentions.auto_link` registration and precedence; off/on semantics; `entity_types`, `ignore`, `mention_ignore`. Surfaced by: Pass 2, 5, 6. Verify: on/off/on test.
- [ ] **D7 (P1, human: ~3h / CC: ~15m)** — gbrain/mcp — sync `{mentions:false}`; surface-aware continuation and B5 placement; latency gate. Surfaced by: Pass 6, both voices. Verify: surface and latency tests.
- [ ] **D8 (P2, human: ~1d / CC: ~30m)** — gbrain/docs — entity-recall guide, README link, MEMORY_VERBS, CLI help, CHANGELOG upgrade table. Surfaced by: Pass 4-5, both voices. Verify: timed fresh-install tutorial.

#### DX phase close

Close packet prepared below with checkpoint `autoplan-dx-Rof8lT` (the DX input snapshot).

Close packet `autoplan-dx-4PmqZS/close-packet.md` (255 lines): lines 1-20 and 208-255 read with the file reader; lines 14-207 diff-verified byte-identical to the CEO close packet read in full (only the closing fence moved). Verified against the decisions above; phase report sent. Phase 2.5 complete: DX 4 → 8/10; outside review completed (Codex, 8 concerns); native subagent completed (15 issues); consensus 6/6 confirmed, 0 disagreements.

### Eng phase (Phase 3, last)

Methodology reads: Eng bundle `autoplan-eng-methodology-RCwm0j/methodology.md` read at ranges 1-122, 456-1055, 1056-1616, 1617-2204, 2205-2261 (EOF, 2,261 lines); lines 123-455 (the shared preamble) diff-checked against the DX bundle's lines 77-409, which were read in full, with the differences (scope-gate selector note, D-numbering rule, em-dash wording) read in the diff output.

Scope gate: plan mode auto-selection does not apply; the target is the plan Garry named (this PLAN.md). Report file: this plan.

#### Step 0: Scope Challenge (code read)

**A. Assessment.** Existing code per sub-problem (read at `739e5cc89`):
- Gazetteer, guards, maximal munch, resume fingerprint: `src/core/by-mention.ts` (`buildGazetteer`, `findMentionedEntities`, `hashGazetteer`), tested by `test/by-mention.test.ts` (55 tests), `extract-by-mention*.test.ts`, `op-checkpoint-mentions-fingerprint.test.ts`, `doctor-stale-mentions.test.ts`.
- Stale sweep: `extractStaleFromDB` (`src/commands/extract.ts`), which returns early when `countStalePagesForExtraction` is 0 and hands managed brains to `extractManagedStaleLinks` (`src/core/persistence/links-maintenance.ts`); sync calls the same function inline (`sync-run.ts:304`, `maxPages: 1000`); the cycle drain budget is 3 minutes (`cycle.ts:609`). Tested by `extract-stale.test.ts` (20), `extract-stale-managed.test.ts`.
- Card: `buildEntityCard`/`assembleCard` (`src/core/verbs/entity-card.ts`), called by the `entity` verb and by `turn-context.ts:505` and `:641` (`context_pack`, `delta`). Tested by `entity-card-private-backlinks.test.ts`, `entity-card-loops.test.ts`, `entity-card-perf.slow.test.ts`, `memory-verbs-conformance.test.ts`, `backlink-count-mention-filter.test.ts`.
- Backlinks op: `get_backlinks` → `readLinkEdges` (`src/core/ops/links.ts:221`), which returns a bare `Link[]` (array) and merges identity-union co-members (`unionLinksAcrossIdentity`, `entity_identity.union`). Tested by `backlinks.test.ts` (49), `backlinks-managed-refusal.test.ts`.
- Aliases: `page_aliases`, `setPageAliases` (`engine-sql/pages.ts:866`), import projection (`import-file.ts:1019`), `reindex-aliases.ts`, alias hop (`search/alias-hop.ts`), `aliasDeclarations` (`ops/search.ts:262`).
- Pack types: `classifyStoredType` (`schema-pack/type-usage.ts`), `buildAliasGraph` (`schema-pack/closure.ts`), `loadActivePackBestEffort`.
- Snippet redaction: `safeSynopsis` (`context/retrieval-reflex.ts:550`).

Minimum change for the goals: the accepted CEO and DX blocks. Nothing proposed is deferrable without missing G1, the default-on rule or a DX contract.

Complexity check (estimates): about 16 changed gbrain files (by-mention, extract, links-maintenance, sync-run, cycle, entity-card, verbs, ops/links, ops/search alias parser, engine-sql/pages, import-file, reindex-aliases, config registry, instructions, base-v2 YAML, one migration) plus about 10 test files and 3 docs; new modules: a mention-pass module (due set, reconcile, entry-table diff) and the linkable-type resolver (2 new units). The gate trips (8+ files, 2 new units).

Search check: CEO landscape search covers the pattern (alias index plus unlinked-mention scanner, write-time vs sweep-time). [Layer 1] precomputed backlink indexes with reconciling sweeps; [Layer 3] the due-set/watermark design reuses gbrain's own `links_extracted_at` pattern.

TODOS cross-reference: TODOS.md now carries E3, E4, V14 (CEO). Nothing in TODOS.md blocks this plan.

**B. Complexity selectors (auto-decided under autoplan; Eng override "never reduce", P2).** Feature cuts: none proposed. Structure: `Original arrangement` kept (mention pass as its own module called from the stale sweep and the managed path; one resolver module; card and op changes in place). A smaller arrangement (folding the pass into `extract.ts`) would put due-set logic in a 2,528-line file and duplicate it for the managed path, so it does not preserve the commitments more simply. Scope record: feature answers: none asked (no cuts); structure: A (original arrangement), autoplan auto-decision; accepted scope: CEO + DX accepted blocks; pending remedies: none.

**C. Findings (code-grounded).**
1. [P1] (confidence 9/10) `src/core/ops/links.ts:221-251` — `readLinkEdges` returns `Promise<Link[]>`, a bare array. The DX block's "responses always carry `total` and `truncated`" would change the response type for every existing `get_backlinks` caller (CLI `gbrain backlinks`, thin clients, `backlinks.test.ts`). Disposition (P5, no breaking change, consistent with Codex DX 5 "preserve existing calls"): without `group`, the response stays an array; truncation by `limit` is reported in a model-visible notice block (gbrain's D8 extra-content-block convention) with the continuation call; with `group: "page"` the response is an object `{rows, total, truncated, next}`. Recorded in the Eng block as a replacement of that DX clause.
2. [P2] (confidence 8/10) `links.ts:243` — identity-union merging (`entity_identity.union`) applies to `get_backlinks` but not to the card's own inbound query. Disposition: `referenced_by` and `get_backlinks {group:"page"}` share one query helper so the card's group and its continuation agree whether or not the union flag is on; test both flag states.
3. [P2] (confidence 8/10) `turn-context.ts:505, :641` — `context_pack` and `delta` call `buildEntityCard`. The DX block says they do not compute `referenced_by`; the mechanism is an `assembleCard` option (`includeReferences`, default false; the `entity` verb passes true). Test: `context_pack` latency and output unchanged.
4. [P2] (confidence 9/10) `extract.ts:2034-2045` — the dry-run and the zero-stale early return use only `countStalePagesForExtraction`. Already covered by the CEO block (spec 3 F5.1); the implementation adds `countMentionDuePages` beside it.

#### Step 0.5: Eng dual voices

Snapshot: `autoplan-eng-x950Fa/eng-implementation.md`, SHA-256 `e6b34448…fdcfd7` (CEO + DX amended plan).

**Claude SUBAGENT (eng — independent review).** Completed; started with `INPUT: eng e6b34448…fdcfd7` (matches) after a full read of `native-prompt.md` (223 lines, hash checked). Verdict: approve with changes. P1: (1) the spec contradicts itself (B3/B5/tests still use CEO field names; `get_backlinks` envelope vs today's bare `Link[]`); (2) derived aliases change resolution outside the card (`resolveEntitySlug` runs alias-exact before titles, `entities/resolve.ts:73-77`; also retrieval-reflex, capture-dedup, read-enrichment, intent-weights, search-diagnose, onboard checks); (3) declarations inside private fences become world-visible aliases; (4) `buildGazetteer` interpolates type names into SQL (`by-mention.ts:401`), unsafe once types come from packs and config; (5) `page_aliases` is a guarded table, so managed brains need coordinated writes, and doctor's `GUARDED_TABLE_COLUMNS` needs the new columns; (6) slot builds must finish their mention pass (`--catch-up`, receipt records coverage, runner refuses partial slots). P2: (7) name-set diff cost and concurrency (mini-gazetteer pass, `search_vector` prefilter, advisory lock, no 8-hex fingerprint); (8) disabling or reconciling must keep `typed_ner` rows; (9) option B makes `company`'s aliases linkable and turns on `expert_routing` for CRM rows; (10) declared word-like aliases ("aka Mark") over-link, so every single-token declared alias should match case-sensitively, with a stored case flag; (11) alias refresh needs its own due set; (12) `pending_pages` on every `entity` call is a scan and leaks counts across grants; use a per-source status row and `knowledge_revision` CAS; (13) pagination needs `(date, source_id, slug)` and a keyset cursor; (14) schema budget needs about 500 characters cut from `query`/`search` (prototype first); (15) last-contact ordering depends on `effective_date` coverage; (16) B5 removes code-alias guidance other families use. P3: harm-screen noise (SE about 4-5 points), provider drift since `a714410a5`, a watermark index. Plus a missing-tests list (PGLite/Postgres parity, private-fence declarations, managed sweep, concurrent sweeps, typed_ner survival, 10k-link hub, soft-delete race, two-pack brain, dry-run parity).

**Codex SAYS (eng — architecture challenge).** Completed (`OUTSIDE_STATUS: completed provider=codex host=claude`, 184 s):

```tool-output
CODEX SAYS (eng — architecture challenge):
════════════════════════════════════════════════════════════
I would not approve this plan yet. The accepted additions improve observability, but the index lifecycle and read contracts still have correctness gaps.

1. **[P1] Derived aliases can expose private facts.** The plan sanitizes previews, but does not specify sanitizing the body used to derive aliases. A world-visible CRM page containing a private facts row such as `Account code: SECR42` could publish that value through `page_aliases`, search, and the card’s `aka` field. The existing [declaration parser](/workspace/gbrain/src/core/ops/search.ts:249) reads supplied text directly, and [card assembly](/workspace/gbrain/src/core/verbs/entity-card.ts:265) returns aliases without visibility metadata. Page-level filters cannot protect private rows inside a public page. Derive public aliases from sanitized content, or preserve visibility through every consumer. Test alias resolution, `aka`, and mention relationships—not just previews.

2. **[P1] The watermark requirements contradict each other.** A page last edited in January, processed by an October extractor, receives January’s `updated_at` under the accepted rule. It therefore remains “older than `MENTION_EXTRACTOR_VERSION`” forever. This breaks the upgrade drain and `coverage: complete`. The existing managed extractor explicitly [stamps the later of the page timestamp and extractor version](/workspace/gbrain/src/core/persistence/links-maintenance.ts:97). Prefer separate content revision and extractor-version/gazetteer-generation fields, published atomically with links. Preserve database timestamp precision if timestamps remain involved.

3. **[P1] Atomic invalidation does not prevent an old scanner from undoing it.** Example: worker A scans against gazetteer G1; worker B publishes G2 and marks affected pages due; A then publishes G1’s edges and clears their due state. No page edit is needed. The specified transaction around the name-set diff does not prevent this. The existing [mention checkpoint](/workspace/gbrain/src/commands/extract.ts:2320) also records completed page identities, not their revisions. Specify a per-source generation and conditional publication, or serialized sweeps, so stale workers cannot acknowledge newer work. Test overlapping sweeps, edits during a paused run, and entity deletion/recreation.

4. **[P1] A degraded gazetteer must never drive reconciliation.** Today, an alias-load error [warns and returns a titles-only gazetteer](/workspace/gbrain/src/core/by-mention.ts:517). With the proposed delete-and-reinsert pass, that becomes destructive: valid alias-derived edges disappear and pages may be stamped complete. Pack-loading failures pose the same problem. Define an authoritative-build requirement: failed inputs must leave existing edges, fingerprints, and watermarks untouched and produce `coverage: failed`. Also test removal of the final entity: today’s [empty-gazetteer early return](/workspace/gbrain/src/commands/extract.ts:2273) would skip cleanup.

5. **[P1] Unknown-type rejection breaks the primary ticket continuation.** Cat 40 stores [`ticket`, `contract`, and other literal types](/workspace/gbrain-evals/eval/generators/model-ladder-gen.ts:70), while base-v2 does not declare several of them. Adding `crm` and `account` aliases does not fix referring-page types. A truncated `ticket` group would emit a `get_backlinks {type:"ticket"}` call that the accepted validation rejects. Define undeclared stored types as their own grouping keys and allow visible observed types as filters. Give untyped pages a usable continuation too. Every group emitted by a card must be accepted by its continuation API.

6. **[P1] Blanket mention deletion can destroy typed relationships.** `link_source='mentions'` includes NER-produced relationships with `link_kind='typed_ner'`. The existing rebuild [explicitly preserves still-supported typed NER edges](/workspace/gbrain/src/commands/extract.ts:2431); the proposed plain scanner cannot regenerate their verbs. Make this preservation rule explicit for routine reconciliation, and separately define what disabling mentions does to NER output. Test preservation of a `works_at` edge alongside removal of an obsolete plain mention.

7. **[P2] One winning alias origin cannot support independent replacement without recomputation.** Suppose an alias exists in both frontmatter and a body declaration. Precedence stores only `origin='frontmatter'`. Removing the frontmatter alias now deletes the only row, although the declaration remains valid. The reverse transition requires promotion of an existing derived row. The current [unique key](/workspace/gbrain/src/core/schema-migrations/v110-page-aliases.ts:38) stores only one row per page/name. Specify either retained provenance or atomic recomputation of the complete alias projection from current page content. Include promotion, fallback, retype, and disable/re-enable tests. These writes must also use the managed coordinator: [`page_aliases` is guarded](/workspace/gbrain/src/core/persistence/writer-guard-schema.ts:5), including writes from reindexing.

8. **[P1] The new backlink envelope is a breaking API change.** [`readLinkEdges()` returns `Link[]`](/workspace/gbrain/src/core/ops/links.ts:221), and existing callers consume arrays. “Responses always carry `total`, `truncated`, and `coverage`” requires a new response contract; updating JSON-shape tests alone does not migrate clients. Specify the envelope, update CLI/thin-client consumers, and test mixed client/server versions. Keep the change isolated from `get_links`, which shares this helper.

   Pagination also needs a total ordering. Date plus slug is insufficient for multiple edges from one referring page, or identical slugs across sources. Add source-qualified page identity and an edge tie-breaker where appropriate. Define whether concurrent edits invalidate pagination or require a snapshot/cursor.

9. **[P1] “Text contains a changed name” is not a sound invalidation algorithm yet.** The scanner matches normalized token sequences: for example, `Acme Corp` can match `Acme—Corp`. Literal substring matching would miss that page when the entity is added. The [tokenizer and matcher](/workspace/gbrain/src/core/by-mention.ts:571) also normalize Unicode and strip code. Require invalidation to select a conservative superset of scanner matches, across both body and timeline. Include cross-source-policy and ignore-rule changes in invalidation. Benchmark this incremental path separately; a full-pass timing does not measure repeated name-change scans.

10. **[P1] The existing ship rule does not enforce “no new leaks.”** It [compares aggregate counts](/workspace/gbrain-evals/docs/benchmarks/2026-10-02-model-ladder/holdout/holdout_stats.py:192). Fixing one leaking cell while introducing a leak in another passes that check. Compare leak flags by `(model, task, repeat, leak_kind)` and reject newly leaking cells; retain aggregate counts for reporting. Add a regression fixture where totals remain equal but the leaking cell changes.

11. **[P2] UC1 needs an explicit cell-reuse audit.** Saved transcripts [truncate each tool result at 40,000 characters](/workspace/gbrain-evals/eval/runner/cat40-model-ladder.ts:189), while [context-exposure scoring examines tool-result content](/workspace/gbrain-evals/eval/runner/cat40/score.ts:95). Recomputing exposure from those transcripts can erase a previously detected leak. Rescoring also cannot undo a tool-result cap that affected the agent’s choices. Reuse demonstrably unaffected cells, preserve original safety observations where evidence is incomplete, and rerun only cells whose eligibility fails. Record this selection before evaluating the wave.

The prior CEO findings also need executable steps: correct the public headline independently first; run the query-time lexical-enumeration comparison before committing to the persistent graph architecture; and make UC1’s reuse audit concrete. Leave T3 to the owner, but freeze whether “gain above zero” means the point estimate or the confidence-interval lower bound before A3.

This was a static repository review; I read no skill files or held-out task file.

Recommendation: Revise before implementation and paid runs because the current plan can leak derived aliases, fail to converge after upgrades, and advertise enumeration that its continuation API cannot complete.
════════════════════════════════════════════════════════════
```

Verification (local reads, $0): `links-maintenance.ts:97` stamps `max(updated_at, versionTs)`; `extract.ts:2431` rebuild removes mention rows while keeping derivable `typed_ner`; `page_aliases_uniq UNIQUE (source_id, alias_norm, slug)` (`v110`); `page_aliases` is in `GUARDED_TABLES`; `resolveEntitySlug` runs alias-exact before prefix/fuzzy; `holdout_stats.py` ship rule compares aggregate leak counts per key; the Cat 40 runner stores tool results cut at 40,000 characters (`cat40-model-ladder.ts:189`); import already warns on `crm` today (`undeclared`), option B would change it to `alias_of`; `company` in base-v2 has `expert_routing: true`. Native finding 15 is settled by measurement: on the dev brain `effective_date` is set on 100% of tickets (609), emails (1,907), meetings (904), contracts and CRM records.

```
ENG DUAL VOICES — CONSENSUS TABLE:
  Dimension                           Claude  Codex  Consensus
  1. Architecture sound?               yes*    no*    CONFIRMED: right seams, index lifecycle needs fixes (*same items, different verdict wording)
  2. Test coverage sufficient?         no      no     CONFIRMED: concurrency, managed, privacy, typed_ner, parity gaps
  3. Performance risks addressed?      no      no     CONFIRMED: incremental invalidation cost; coverage count on hot path
  4. Security threats covered?         no      no     CONFIRMED: private-fence aliases; SQL interpolation (native only)
  5. Error paths handled?              no      no     CONFIRMED: degraded gazetteer, stale-worker race, watermark convergence
  6. Deployment risk manageable?       no      no     CONFIRMED: managed guard, breaking get_backlinks envelope
CONFIRMED = native + outside agree. 0 disagreements on findings; verdict wording differs (approve-with-changes vs revise).
Single-voice criticals: none rated critical; native P1-4 (SQL) and Codex P1-10 (leak cells) are single-voice P1s, both accepted.
```

No new User Challenge: both voices' fixes complete the accepted direction. Codex restates CEO UC1-UC3 and asks that T3's "gain above zero" be frozen as point estimate or CI bound before A3 (folded into T3).

#### Section 1: Architecture

```
                      ┌────────────────────── gbrain (cat40-entity-wave on 739e5cc89) ──────────────────────┐
  sync ──► import ──► pages ─┬─► page_aliases(origin=frontmatter, case_sensitive=false)
   │ (links only,            │
   │  {mentions:false})      │      linkableEntityTypes(source) ◄── source pack (primitive: entity + type aliases,
   │                         │            │                             product excluded) ∪ legacy four ∪ mentions.entity_types
   ▼                         ▼            ▼
  extract --stale ──► [link work, unchanged] ──► mention module (new):
  cycle drain (½ budget       │   1. alias refresh (entity pages due by alias watermark; sanitized text)
   reserved when due)         │        └─► page_aliases(origin=declared|subject, case_sensitive)  [coordinated write if managed]
  managed stale path ─────────┤   2. authoritative gazetteer build (fails closed → coverage:failed, nothing written)
                              │   3. entry table diff (advisory lock, generation N+1) ──► due marks (same txn)
                              │   4. reconcile due pages (generation-checked publish; keep typed_ner) ──► links(mentions)
                              │   5. per-source status row {state, pending, last_pass_at, generation}
                              ▼
  MCP entity ──► buildEntityCard(includeReferences) ──► referenced_by (shared query helper) + coverage (status row)
  MCP get_backlinks ──► readLinkEdges: no new params → Link[] (unchanged); group:"page" → {rows,total,truncated,cursor}
  context_pack / delta ──► buildEntityCard(includeReferences:false)  (unchanged cost)
  alias consumers (resolveEntitySlug, reflex, capture-dedup, read-enrichment, intent-weights, alias hop, diagnose)
       └─► rank frontmatter > title > declared > subject; never let a derived row outrank an exact title
                      └─────────────────────────────────────────────────────────────────────────────────────┘
  gbrain-evals: slot build (extract --stale --catch-up, records coverage) ─► runner refuses partial slots ─► A1/A3
               holdout_stats.py: ship rule + per-cell leak check; capability harm screen; headline mode
```

Findings and dispositions (auto-decided, P5/P1):
- E1 (both, P1) Index lifecycle: generation per source; a scan publishes only if its generation is still current (conditional publish), else the page stays due; one advisory lock serializes entry-table saves. Replaces the CEO watermark wording: a page's mention state is `(content knowledge_revision, extractor version, generation)` written atomically with its links; a page is due when any differs. Removes the never-converging `updated_at` rule.
- E2 (Codex P1-4) Authoritative build: if pack loading, alias loading or the entry-table read fails, the pass writes nothing (no deletes, no watermarks, no fingerprint) and the status row says `failed` with the error; an empty gazetteer still reconciles (removes stale mention rows) instead of returning early.
- E3 (both) `get_backlinks` compatibility: no new parameter → today's bare `Link[]`, unchanged; `group:"page"` → `{rows, total, truncated, cursor}`; keyset cursor over `(date DESC, source_id, slug)`; `get_links` untouched (separate code path from the shared helper). Replaces the DX clauses "responses always carry total and truncated" and `offset`.
- E4 (native P1-2) Alias consumers: every reader of `page_aliases` ranks rows frontmatter > exact title > declared > subject; `resolveEntitySlug` checks exact title before declared/subject alias rows; listed consumers get regression tests.
- E5 (native P1-5) Managed brains: alias refresh writes through the coordinated writer; `GUARDED_TABLE_COLUMNS` and catalog goldens include the new columns; a managed-brain sweep test.
- E6 (native P2-9, T1) Option B side effects are real (`expert_routing: true` on `company` would route CRM rows into `whoknows`); `product` is excluded from linkable aliases under either option. Taste CEO-T1 recommendation returns to option A (new `account` type, `expert_routing: false`), recorded as a Taste change at the gate.
- Scaling: a 10k-link hub entity is the card's worst case (per-group caps, whole-card 50-row cap, status-row coverage keep it O(groups)); timed in tests.
- Rollback: revert; the migration is additive; `mentions.auto_link=false` removes plain mention rows only.

#### Section 2: Code quality

- Q1 (native P1-1) One consolidated spec: the Eng block below supersedes the CEO and DX wording where they conflict; implementers read the accepted blocks in order CEO → DX → Eng, later wins.
- Q2 (native P1-4) Bind type lists as `$1::text[]` everywhere (gazetteer, card grouping, `get_backlinks type`).
- Q3 (native P2-10) Store `case_sensitive` on alias rows (set for every single-token declared alias, as written); drop the "re-read the declaring page at build" mechanism.
- Q4 (Codex P1-7) Alias projection: keep one row per (page, alias, origin) by widening the unique key to include `origin`, so frontmatter and declared rows coexist; readers dedupe by precedence. No promotion logic needed.
- Q5 (native P2-11) Alias refresh has its own due set (alias watermark per entity page; retype or pack change marks due).
- Shared-code rubric: the card's `referenced_by` and `get_backlinks {group:"page"}` share one query helper (two callers, same contract: ordering, privacy, identity union); the alias declaration parser is shared by `aliasDeclarations` and alias refresh (two callers). Both pass the rubric (verified callers, same behavior, net savings).
- Stale diagram audit: `by-mention.ts` header comment (D2 "hardcoded type filter", TODO-1) and the gazetteer docstring become stale and must be updated in the same commit.

#### Section 3: Test review

Framework: bun test (`test/*.test.ts`, `*.slow.test.ts`, E2E under `bun run test:e2e`, per `docs/TESTING.md`). Existing coverage read: `by-mention.test.ts` (55 tests), `extract-stale.test.ts` (20), `backlinks.test.ts` (49), `entity-card-private-backlinks.test.ts`, `memory-verbs-conformance.test.ts`, `mcp-schema-budget.test.ts`.

```
CODE PATHS                                                   USER (AGENT) FLOWS
[+] linkableEntityTypes(source)                              [+] Brief on an account
  ├── [GAP] base-v2 / company-brain / legacy / no pack          ├── [GAP] [→E2E] entity("QUCO") → referenced_by → continuation
  ├── [GAP] config add/remove; product excluded                 ├── [GAP] remote caller: private memo + derived digest hidden
  └── [GAP] bound as text[] (no interpolation)                  └── [GAP] verbs surface: continuation names starter
[+] alias refresh                                            [+] Upgrade an existing brain
  ├── [GAP] subject / declared / frontmatter coexist            ├── [GAP] [→E2E] upgrade → post-upgrade line → extract --stale → complete
  ├── [GAP] private fence: code not stored                      └── [GAP] cycle-only brain reaches complete across cycles
  ├── [GAP] contract code not stored; retype removes rows    [+] Debug and tune
  └── [GAP] managed brain: coordinated write                    ├── [GAP] extract mentions --explain: each reason code
[+] gazetteer build                                             └── [GAP] mention_ignore / mentions.ignore / off-on-off
  ├── [★★★ TESTED] guards, munch, CJK (by-mention.test.ts)   [+] Paging
  ├── [GAP] authoritative failure → coverage failed             ├── [GAP] >500 rows, equal dates, two sources, no dup/skip
  └── [GAP] empty gazetteer still reconciles                    └── [★★★ TESTED] legacy get_backlinks array (backlinks.test.ts)
[+] entry diff + due marks                                   LLM/agent: [→EVAL] B5 + descriptions → Cat 40 dev rounds
  ├── [GAP] added / removed / retargeted entity                 (A1 rounds 1-2; family-E and code-alias families)
  ├── [GAP] Unicode/punctuation variants (superset prefilter)
  └── [GAP] concurrent sweeps (generation check)
[+] mention reconcile
  ├── [★★ TESTED] --rebuild keeps typed_ner (extract-by-mention-rebuild)
  ├── [GAP] default pass keeps typed_ner; disable keeps typed_ner
  ├── [GAP] edit during scan leaves page due (revision CAS)
  └── [GAP] soft-delete between selection and reconcile
[+] card / get_backlinks
  ├── [★★★ TESTED] private inbound edges (entity-card-private-backlinks)
  ├── [GAP] referenced_by groups, caps, whole-card cap, coverage states
  ├── [GAP] context_pack/delta unchanged (includeReferences false)
  └── [GAP] p99 < 100 ms on 20K mention-dense corpus; 10k-link hub
[+] schema/instructions
  └── [★★★ TESTED] ceilings (mcp-schema-budget) — must pass unchanged; per-surface instruction sizes [GAP]
[+] migration
  └── [GAP] PGLite and Postgres parity; GUARDED_TABLE_COLUMNS; watermark index
[+] gbrain-evals
  ├── [GAP] runner refuses slots with coverage != complete
  ├── [GAP] holdout_stats per-cell leak check (equal totals, moved leak → fail)
  └── [GAP] UC1 reuse audit (if accepted): keep original safety flags where transcripts are truncated

COVERAGE (planned paths): 4/38 tested today | GAPS: 34 (2 E2E, 1 eval)
```

Regression rule: existing behavior at risk and its required coverage (accepted, no question needed since each preserves an existing contract): legacy `get_backlinks` array shape and order (`backlinks.test.ts` must pass unchanged); `backlink_count` semantics (`backlink-count-mention-filter.test.ts` unchanged); `--rebuild` typed_ner preservation; `extract --explain <kind>` output; `context_pack`/`delta` output; schema ceilings. Tests to retire: none.

Test plan artifact written to `~/.gstack/projects/garrytan-gbrain-evals/user-plan-cat40-entity-recall-eng-review-test-plan-20261004.md`.

#### Section 4: Performance

- P1 Incremental invalidation (both voices): changed entries run as a mini-gazetteer through the real tokenizer over candidate pages selected by a `search_vector` prefilter that is a superset of scanner matches (all tokens of the changed name, OR across names), covering body and timeline; cross-source policy, ignore-list and type-set changes are full-rescan triggers. Benchmarked separately on the 52k world: add one entity to a fully linked brain and time the next sweep (target under 30 s).
- P2 Coverage on the hot path: `coverage` reads a per-source status row maintained by the pass (O(1)); remote callers see the state for their permitted sources only, never counts from other sources.
- P3 Card cost: one indexed join for `referenced_by` with per-type window limits; whole-card cap 50 rows; `includeReferences:false` for ambient callers.
- P4 Watermark index `(source_id, mention watermark)` in the migration, matching `pages_links_extracted_at_idx`.
- P5 Schema budget (native P2-14): prototype the `entity` and `get_backlinks` descriptions and run `mcp-schema-budget.test.ts` before writing handlers; if they do not fit after cutting `query`/`search` (keeping their `MINIMUM_GUIDANCE` phrases), `cursor` is served only through the card's continuation text and the CLI.

#### Eng required outputs

**NOT in scope (Eng).** Write-time mention linking (CEO V14, TODOS.md). Cross-source identity joins (stated limit; `link_resolution.cross_source` remains the opt-in). A new `brief` verb (DX). Typed-field extraction of ticket status (CEO dream-state gap; not deferred to a TODO because UC3 may reshape it).

**What already exists (Eng).** As listed in Step 0 A; reused: gazetteer and guards, `--rebuild` reconcile with `keepTypedNerPairs`, managed coordinated writer, `links_extracted_at` pattern and index, `safeSynopsis`, private-visibility fragments, `classifyStoredType`/`buildAliasGraph`, `search_vector` GIN index, schema-budget and conformance tests, `holdout_stats.py`.

**Failure modes registry.**

```
  CODEPATH                 | FAILURE                                   | TEST? | HANDLING                          | USER SEES          | CRITICAL?
  gazetteer build          | alias table read fails                    | Y     | fail closed, status failed        | coverage failed    | no
  entry diff               | two sweeps interleave                     | Y     | advisory lock + generation check  | nothing            | no
  reconcile                | stale worker publishes old generation     | Y     | conditional publish               | page stays due     | no
  reconcile                | typed_ner edge deleted                    | Y     | keepTypedNerPairs rule            | nothing            | no
  alias refresh            | private-fence code stored                 | Y     | sanitize before parse             | nothing            | no
  alias consumers          | CRM subject outranks company title        | Y     | precedence in every reader        | correct entity     | no
  managed brain            | guarded write refused                     | Y     | coordinated writer                | nothing            | no
  get_backlinks            | legacy caller gets an object              | Y     | array unless group:"page"         | nothing            | no
  coverage                 | count leaks other sources                 | Y     | per-source status row             | own state only     | no
  slot build               | mention pass partial in a paid round      | Y     | runner refuses partial slots      | n/a (operator)     | no
  ship rule                | leak moves between cells, totals equal    | Y     | per-cell comparison               | n/a                | no
  UC1 reuse                | rescore erases a recorded leak            | Y     | keep original flags if truncated  | n/a                | no
```

CRITICAL GAPS: 0 (every row now has a test and handling).

**Worktree parallelization.**

| Step | Modules touched | Depends on |
|---|---|---|
| S1 resolver + migration | `src/core/schema-pack/`, `src/core/schema-migrations/`, `src/core/by-mention.ts` | — |
| S2 alias refresh + consumers | `src/core/ops/search.ts`, `src/core/engine-sql/`, `src/core/entities/`, `src/core/search/`, `src/commands/reindex-aliases.ts` | S1 |
| S3 mention module + sweep wiring | `src/commands/extract.ts`, `src/core/persistence/`, `src/core/cycle*` | S1, S2 |
| S4 card + get_backlinks + coverage | `src/core/verbs/`, `src/core/ops/links.ts`, `src/core/context/` | S1 (S3 for coverage source) |
| S5 MCP text + docs | `src/mcp/`, `docs/`, `README.md`, `CHANGELOG.md` | S4 |
| S6 evals tooling | gbrain-evals `eval/runner/`, `holdout_stats.py` | — |

Lane A: S1 → S2 → S3 (shared `by-mention.ts`). Lane B: S4 after S1, merges with A before S5. Lane C: S6 independent. Execution: launch A and C; start B once S1 lands; merge A+B; then S5. The gbrain work ships as one PR (fix-wave rule); lanes are worktrees, not separate PRs.

**Completion summary (Eng).**
- Step 0: Scope Challenge — scope accepted as-is (complexity gate tripped; original arrangement kept under the autoplan "never reduce" override).
- Architecture Review: 6 issues found (E1-E6).
- Code Quality Review: 5 issues found (Q1-Q5), plus 1 stale diagram (by-mention header).
- Test Review: diagram produced, 34 gaps identified (all accepted as required tests).
- Performance Review: 5 issues found (P1-P5).
- NOT in scope: written. What already exists: written.
- TODOS.md updates: 0 new (E3, E4, V14 already written by CEO).
- Failure modes: 0 critical gaps flagged.
- Unresolved decisions: 0 in this review (T1 recommendation change and T3 freeze go to the gate with the CEO items).
- Outside voice: Codex `gpt-6-astra`, completed.
- Parallelization: 3 lanes, 2 parallel / 1 sequential dependency chain.
- Lake Score: N/A (no coverage-scored questions asked; all auto-decided).

<!-- autoplan-accepted:eng -->
- Consolidated spec (Q1): where the CEO, DX and Eng blocks differ, the later block wins; the implementation PR's description states the final field names (`referenced_by`, `referenced_by_count`, `coverage`, `preview`), the `get_backlinks` contract and the B5 sentence ("For a brief on an account, person or company, call `entity`, then walk `referenced_by` or `get_backlinks` by type.", measured at or under the removed 135 characters).
- Index lifecycle (E1, E2), replacing the CEO watermark rule: each page's mention state stores the content `knowledge_revision`, `MENTION_EXTRACTOR_VERSION` and the source's gazetteer generation it was scanned at, written in the same transaction as its links; a page is due when any of them differs. Entry-table saves take an advisory lock and bump the generation; a scan publishes only if the page's revision and the source generation are unchanged (conditional publish), otherwise the page stays due. If pack loading, alias loading or the entry-table read fails, the pass writes nothing and the per-source status row records `failed` with the error; an empty gazetteer still reconciles. Verify: tests for overlapping sweeps, an edit during a paused run, entity deletion and recreation, alias-load failure (no deletes), removal of the last entity, and convergence of an upgraded brain whose pages predate the extractor version.
- Invalidation (P1): changed gazetteer entries run as a mini-gazetteer through the real tokenizer over pages selected by a `search_vector` prefilter that is a superset of scanner matches across body and timeline; changes to the entity-type set, cross-source policy or ignore rules trigger a full rescan. Verify: Unicode and punctuation variants of a new name are found; a 52k-world timing for adding one entity (target under 30 s).
- Reconcile (E2, Codex 6, native 8): the default pass and `mentions.auto_link=false` touch only plain mention rows (`link_kind` null or `plain`); `typed_ner` rows are kept as `--rebuild` keeps them. Verify: a `works_at` typed_ner edge survives reconcile and an off/on cycle while an obsolete plain mention is removed.
- Aliases (Q3, Q4, Q5, Codex 1, native 3, native 10): declarations are parsed from text with private takes and facts fences stripped (the `safeSynopsis` rule); the `page_aliases` unique key includes `origin`, so frontmatter, declared and subject rows coexist and readers apply precedence frontmatter > declared > subject; rows carry `case_sensitive` (true for every single-token declared alias, matched exactly as written; frontmatter aliases stay case-insensitive), replacing the CEO block's all-caps re-read rule; alias refresh has its own due set (alias watermark per entity page; retype or pack change marks due); writes on managed brains go through the coordinated writer. Verify: private-fence code not stored and remote `entity` on it misses; frontmatter removal leaves a valid declared row; "aka Mark" does not link lowercase "mark"; managed-brain sweep test.
- Alias consumers (E4): `resolveEntitySlug`, the retrieval reflex, capture-dedup, read-enrichment, intent weights, the search alias hop, `search-diagnose` and the onboard orphan-alias check rank an exact title above declared and subject rows. Verify: `resolveEntitySlug("Acme Example")` stays `companies/acme-example` beside a `CRM record: Acme Example` page; capture-dedup unchanged for the same case.
- SQL and schema (Q2, E5, P4): every type list reaching SQL is bound as `text[]`; `GUARDED_TABLE_COLUMNS` and catalog goldens include the new columns; the migration adds a `(source_id, mention watermark)` index; PGLite and Postgres parity tests for the migration and origin-aware alias writes.
- `get_backlinks` (E3), replacing the DX clauses on `total`/`truncated` and `offset`: with none of the new parameters the response is today's bare `Link[]`, unchanged; with `group: "page"` it is `{rows, total, truncated, cursor}`, ordered by `(date DESC, source_id, slug)` with a keyset `cursor`; `type` filters in both modes and accepts any stored type observed on a referring page (undeclared types such as `ticket` are their own groups) as well as pack-canonical types; untyped pages group under `untyped` with a working continuation; `get_links` is unchanged. Every group a card emits is accepted by its continuation. Verify: `backlinks.test.ts` passes unchanged; >500 rows across two sources with equal dates page without duplicates or gaps; a truncated `ticket` group's continuation succeeds.
- Card cost and coverage (P2, P3): `buildEntityCard` takes `includeReferences` (true only for the `entity` verb); `referenced_by` and `get_backlinks {group:"page"}` share one query helper (identity union applied identically); a whole-card cap of 50 rows across groups, with per-group totals and continuations; `coverage` reads a per-source status row (`state`, `pending`, `last_pass_at`, `generation`) and remote callers see only their permitted sources' state. Verify: `entity` p99 < 100 ms on the 20K corpus with mention-dense data and a 10k-link hub; `context_pack` output and latency unchanged.
- Linkable types (E6): `product` is excluded from linkable type aliases; Taste CEO-T1's recommendation returns to option A (new `account` entity type with `expert_routing: false`), because option B would route CRM rows into `whoknows`; the precision sample is stratified by entity type.
- Slots and runs (native 6): slot builds run `gbrain extract --stale --catch-up`; each `slots-*` receipt records the coverage state and pending count; the runner refuses to start a round on slots whose state is not `complete` with 0 pending.
- Ship rule (Codex 10): `holdout_stats.py` checks leaks per `(model, task, repeat, leak_kind)` cell and fails on any newly leaking cell, keeping aggregate counts for the report. Verify: a fixture with equal totals but a moved leak fails.
- UC1 audit (Codex 11), amending the CEO UC1 branch if Garry accepts UC1: reused cells keep their original safety flags (`output_leak`, `context_exposure`, `unsafe_write`) wherever stored tool results were cut at 40,000 characters; only success and claims are rescored; cells whose eligibility cannot be shown are rerun; the selection is committed before any A3 cell is scored.
- Preregistration (Codex, P3 native): T3's "family-E gain above zero" is frozen in the preregistration as the point estimate (provisional; Garry may choose the CI lower bound at the gate); the preregistration names harm-screen noise (SE about 4-5 points on 150 cells) and provider drift since `a714410a5`.
- B5 guard (native 16): if round 2's code-alias tasks (family A amendments named only by code) drop 10 points or more against round 1, the old "several names" sentence returns in shortened form.
<!-- /autoplan-accepted:eng -->

#### Eng Implementation Tasks

- [ ] **E-T1 (P1, human: ~1d / CC: ~1h)** — gbrain/mention-module — generation, conditional publish, authoritative build, invalidation prefilter. Surfaced by: E1, E2, P1 (both voices). Files: new mention module, `src/commands/extract.ts`, `src/core/persistence/links-maintenance.ts`. Verify: concurrency, failure and convergence tests.
- [ ] **E-T2 (P1, human: ~6h / CC: ~30m)** — gbrain/aliases — origin in unique key, `case_sensitive`, sanitized parsing, alias due set, coordinated writes. Surfaced by: Q3-Q5, Codex 1, native 3/5/10. Files: migration, `engine-sql/pages.ts`, `import-file.ts`, `reindex-aliases.ts`. Verify: alias tests listed in the block.
- [ ] **E-T3 (P1, human: ~4h / CC: ~20m)** — gbrain/alias-consumers — precedence in every `page_aliases` reader. Surfaced by: E4. Files: `entities/resolve.ts`, `context/retrieval-reflex.ts`, `facts/capture-dedup.ts`, `search/*`. Verify: `resolveEntitySlug` and capture-dedup regressions.
- [ ] **E-T4 (P1, human: ~4h / CC: ~20m)** — gbrain/links-op — compatible `get_backlinks` (array default, `group:"page"` envelope, cursor, observed types). Surfaced by: E3. Verify: `backlinks.test.ts` unchanged; paging test.
- [ ] **E-T5 (P1, human: ~3h / CC: ~15m)** — gbrain/sql+schema — bound type lists, guarded columns, watermark index, PGLite/Postgres parity. Surfaced by: Q2, E5, P4. Verify: parity and doctor tests.
- [ ] **E-T6 (P1, human: ~3h / CC: ~15m)** — gbrain/card — `includeReferences`, shared query helper, whole-card cap, status-row coverage. Surfaced by: P2, P3. Verify: latency gate, context_pack unchanged.
- [ ] **E-T7 (P1, human: ~2h / CC: ~10m)** — evals/runner — `--catch-up` slot builds, coverage in slot receipts, refuse partial slots. Surfaced by: native 6. Verify: runner test.
- [ ] **E-T8 (P1, human: ~2h / CC: ~10m)** — evals/stats — per-cell leak check. Surfaced by: Codex 10. Verify: moved-leak fixture fails.
- [ ] **E-T9 (P2, human: ~2h / CC: ~10m)** — evals/uc1 — reuse audit if UC1 is accepted. Surfaced by: Codex 11. Verify: selection committed before A3.
- [ ] **E-T10 (P2, human: ~2h / CC: ~10m)** — gbrain/mcp — prototype descriptions against the schema budget before handlers. Surfaced by: P5. Verify: `mcp-schema-budget.test.ts`.

#### Eng phase close

Close packet prepared below with checkpoint `autoplan-eng-x950Fa` (the Eng input snapshot).

Close packet `autoplan-eng-Xnvk0U/close-packet.md` (270 lines): lines 1-20 and 219-270 read with the file reader; lines 14-220 diff-verified byte-identical to the DX close packet (verified above). Verified against the decisions above; phase report sent. Phase 3 complete: outside review completed (Codex, 11 concerns); native subagent completed (19 issues); consensus 6/6 confirmed, 0 disagreements.

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|-----------|-----------|----------|----------|
| 1 | CEO | Mode SELECTIVE EXPANSION | Mechanical | override | Autoplan CEO rule | other modes |
| 2 | CEO | Approach A: mention links + card listing | Mechanical (pending UC3) | P1 | Only an entity-keyed index enumerates near-duplicate tickets | ranking-only; search filter only |
| 3 | CEO | F1 mention pass default-on inside `extract --stale` | Mechanical | P1 | Pass never runs today (0 links); eval winners ship on | opt-in only |
| 4 | CEO | F2 linkable types = legacy four ∪ pack entity types + aliases | Mechanical | P1, P5 | No bundled pack declares `crm` | hard-coded list |
| 5 | CEO | T1 how `crm` becomes linkable | Taste | P5 | Recommendation A (new `account` type) after Eng E6; B was briefly provisional | B: aliases on `company` |
| 6 | CEO | F3 entity-page-only alias sources, 4-char minimum kept | Mechanical | P1, P5 | Contracts share codes; keep existing guards | 3-char floor |
| 7 | CEO | F4 keep `backlink_count`, add new fields | Mechanical | P5 | D12 ranking semantics | redefine count |
| 8 | CEO | F5 one type resolver | Mechanical | P4 | Two hard-coded lists | duplicate lists |
| 9 | CEO | F6 lead snippet 160 chars after heading | Mechanical | P1 | Status sits on the second line | first line |
| 10 | CEO | F7 full master control round (~$12) | Mechanical | P1, P2 | Separates wave from v0.60.45-46 | E-only control; dev2 only |
| 11 | CEO | F8 wave-built slots | Mechanical | P1 | Links written at extract time | reuse old slots |
| 12 | CEO | F9 private-page + private-origin filters | Mechanical | P1 | Derived digests leak otherwise | private only |
| 13 | CEO | F10 budgets trade only, ceilings fixed | Mechanical | P5 | Cost-wave invariant | raise ceilings |
| 14 | CEO | F11 budget ~$246 (or ~$118 under UC1) | Mechanical | fact | Measured simple-arm cost $127.68 | ~$200 |
| 15 | CEO | E1 preregistered headline | Mechanical | P1 | Repo convention | post-hoc comparator |
| 16 | CEO | E2 gate-failure actions | Mechanical | P1 | Missing failure paths | none |
| 17 | CEO | E3 doctor coaching | Deferred | P3 | Outside G1/G2 | include |
| 18 | CEO | E4 family-E ranking follow-up | Deferred | P3 | Separate ranking work | include |
| 19 | CEO | E5 50k timing + precision | Mechanical | P1 | Default-on must scale | skip |
| 20 | CEO | Spec loop launch 1: 27 fixes | Mechanical | P1, P5 | See 0H table | — |
| 21 | CEO | Spec loop launch 2: 25 fixes | Mechanical | P1, P5 | See 0H table | — |
| 22 | CEO | Spec loop launch 3: 20 fixes (not re-reviewed) | Mechanical | P1, P5 | Three-launch cap | — |
| 23 | CEO | T2 capability harm screen | Taste | P1 | Cost-wave screen requires cost to fall | keep cost condition |
| 24 | CEO | 0H document approval | Mechanical | autoplan | Auto-decided A | revise/pause |
| 25 | CEO | UC1 reuse simple-arm cells | User Challenge | — | Both voices; held for gate | auto-decide |
| 26 | CEO | UC2 decouple headline correction | User Challenge | — | Both voices; held for gate | auto-decide |
| 27 | CEO | UC3 enumeration comparison before graph | User Challenge | — | Both voices; held for gate | auto-decide |
| 28 | CEO | V4 independent fixtures + real-brain precision | Mechanical | P1 | Both voices | synthetic only |
| 29 | CEO | V5 off switch | Mechanical | P1, P2 | Native critical | none |
| 30 | CEO | V6 coverage state | Mechanical | P1 | Codex | none |
| 31 | CEO | V7 same-source scope; B5 drops "project" | Mechanical | P5 | `project` is a concept | keep wording |
| 32 | CEO | T3 binding capability gate | Taste | P1 | Codex vs native disagreement | 15/30 as gate |
| 33 | CEO | T4 keep seed 20261003 | Taste | P3 | Fresh seed costs ~+$240 | fresh seed |
| 34 | CEO | V11 entity-call share; V12 economics | Mechanical | P1 | $0 analysis | — |
| 35 | CEO | V13 top-3 card rows | Mechanical | P1 | Hides older open tickets | adopt |
| 36 | CEO | V14 inline mention scan on writes | Deferred | P3 | Coverage state shows the lag | include |
| 37 | DX | Mode DX POLISH; persona AI agent | Mechanical | override, P6 | Autoplan DX rules | — |
| 38 | DX | TTHW target Competitive (<5 min) | Mechanical | P5 | Champion conflicts with sweep budget | Champion |
| 39 | DX | Magical moment via existing `entity` card | Mechanical | P5 | No new tool | `brief` verb |
| 40 | DX | Activation line + reserved cycle budget | Mechanical | P5 | Native H1 | wait for cycles |
| 41 | DX | `extract mentions --explain` + reason codes | Mechanical | P5 | `--explain` taken | reuse flag |
| 42 | DX | `mentions.auto_link` registered; `auto_link` wins | Mechanical | P5 | Native H3 | unregistered key |
| 43 | DX | Field rename to `referenced_by`/`coverage` | Mechanical | P5 | Counts every link source | keep names |
| 44 | DX | Coverage states with degraded notice | Mechanical | P1 | Both voices | pending count only |
| 45 | DX | Overrides: `entity_types`, `ignore`, `mention_ignore` | Mechanical | P1 | Escape hatches | global off only |
| 46 | DX | Sync stays link-only; surface-aware continuation | Mechanical | P1 | Both voices | — |
| 47 | DX | Keyless tutorial + upgrade table + docs | Mechanical | P1 | Both voices | CHANGELOG only |
| 48 | Eng | Scope accepted as-is; original arrangement | Mechanical | override | Never reduce | smaller arrangement |
| 49 | Eng | E1 generation-checked lifecycle | Mechanical | P5 | Both voices; watermark never converged | updated_at rule |
| 50 | Eng | E2 authoritative build, empty-gazetteer reconcile | Mechanical | P1 | Codex | degrade silently |
| 51 | Eng | E3 `get_backlinks` array kept; `group:"page"` envelope; cursor | Mechanical | P5 | Breaking change otherwise | always envelope; offset |
| 52 | Eng | E4 exact title outranks derived aliases everywhere | Mechanical | P1 | Native P1-2 | card-only rule |
| 53 | Eng | E5 coordinated writes, guarded columns | Mechanical | P1 | Native P1-5 | direct writes |
| 54 | Eng | E6 exclude `product`; T1 recommendation to A | Taste (T1) | P5 | Option B side effects | B |
| 55 | Eng | Q2 bind type lists | Mechanical | P1 | SQL interpolation | string build |
| 56 | Eng | Q3/Q4 `case_sensitive` + origin in unique key | Mechanical | P5 | Native P2-10, Codex 7 | re-read bodies; precedence-only row |
| 57 | Eng | Sanitized alias parsing | Mechanical | P1 | Both voices (private fences) | raw text |
| 58 | Eng | Keep `typed_ner` on reconcile and disable | Mechanical | P1 | Both voices | blanket delete |
| 59 | Eng | Superset invalidation prefilter | Mechanical | P1 | Both voices | substring match |
| 60 | Eng | Per-source status row for coverage | Mechanical | P1 | Native P2-12 | per-call count |
| 61 | Eng | Slots must be complete before paid rounds | Mechanical | P1 | Native P1-6 | trust one fixture |
| 62 | Eng | Per-cell leak check in ship rule | Mechanical | P1 | Codex 10 (stricter) | aggregate only |
| 63 | Eng | UC1 audit keeps original safety flags | Mechanical | P1 | Codex 11 | full rescore |
| 64 | Eng | T3 frozen as point estimate (provisional) | Taste (T3) | P6 | Codex asks to freeze before A3 | CI lower bound |
| 65 | Eng | B5 guard on code-alias tasks | Mechanical | P1 | Native 16 | none |

### Phase 4: Final approval gate (stopped here for Garry)

Pre-gate verification: CEO outputs (premise challenges, Sections 1-10 with Section 11 skipped, Error & Rescue and Failure Modes registries, NOT in scope, What already exists, dream state delta, Completion Summary, consensus table): present. DX outputs (8 scores, journey map, empathy narrative, TTHW, checklist, consensus): present. Eng outputs (scope challenge, architecture diagram, test diagram, test plan artifact on disk, NOT in scope, What already exists, failure modes, completion summary, consensus): present. Each phase has a completed native subagent and a completed Codex voice. Two close packets (DX, Eng) were read partly through a byte-diff against the previous packet instead of a full file-reader pass; noted here as a process deviation.

**Plan summary.** gbrain gets a default-on mention index: typed records (CRM rows, accounts) and their declared codes become linkable, `extract --stale` keeps links current with a generation-checked reconcile, and the `entity` card lists everything that references a thing with coverage state and paging. gbrain-evals re-measures the Cat 40 headline against the best simple arm with a preregistered comparator, on a master control and the held-out world.

**Decisions made: 65 audit rows: 53 auto-decided mechanical, 3 deferred to TODOS.md, 4 Taste choices (6 rows; T1 and T3 were each revised once), 3 User Challenges.**

**User Challenges (both models disagree with the stated direction; the original direction stands unless Garry changes it).**
- **UC1: reuse the simple-arm cells** (CEO). Garry's plan: rerun oracle, fs, fs-acl, memory and pg on the held-out world (~$128). Both models: reuse the 2026-10-02 cells (same models, repeats and tasks; 0 errored cells; those arms make no proxy calls), rescoring success and claims with today's scorer and keeping original safety flags where transcripts were cut at 40k characters. Why: the stall affected gbrain's embedding path, not these arms; the money buys no new information. Might be missing: harness changes since `462e31f3` (score.ts fixes, pg-arm edits) or provider drift since 2026-10-02 could move simple-arm scores a little; the word "contemporaneous" is lost. If wrong: the headline comparator carries a small, disclosed date/harness confound. Saves about $128; the ask drops from +$250 to +$75.
- **UC2: publish the corrected headline first, separately** (CEO, Codex repeated in DX and Eng). Garry's plan: one sequence (build B, dev rounds, A2, A3) and one report rewrite. Both models: run A2 (or UC1's rescore) now and publish `a714410a5` (fixed harness) against the best simple arm as the correction; Item B updates the headline later. Why: the current headline is known to rest on degraded runs, and it does not depend on Item B. Might be missing: Garry may prefer one combined announcement. If wrong: two report edits instead of one.
- **UC3: compare query-time exact enumeration before building the mention graph** (CEO, repeated by Codex in DX and Eng). Garry's plan: build B1-B4 (precomputed mention links). Both models: first test a cheaper alternative on dev data, an exhaustive exact-match listing over an entity's names and aliases (or lexical-first retrieval; keyword-only search scored 14/30 on family E in the degraded runs), and build the persistent graph only if it wins. Why: the graph adds a migration, a lifecycle and many guards; the failure is grep-shaped. Might be missing: enumeration at query time cannot show coverage for names it has never resolved, and links serve other features (cards, context packs). If wrong: one extra dev round (~$12) and a few days.

**Your choices (Taste decisions).**
- **T1: how a `type: crm` page becomes linkable.** Recommend A, a new `account` entity type in `gbrain-base-v2` (alias `crm`, `expert_routing: false`): P5, because option B (aliases on `company`) would route CRM rows into `whoknows`. Alternative B: no new type, smaller schema change. Rejecting both stops Item B's paid rounds.
- **T2: dev harm screen.** Recommend pooled success better than −5 points against the master control, families at −10 flagged not gated, cost reported not gated: P1. Alternative: the cost-wave screen, which requires cost to fall and would likely fail a wave that adds card tokens.
- **T3: what "eval winner ships default-on" means.** Recommend: default-on only if the held-out family-E paired gain against `a714410a5` is above 0 (point estimate) and the ship rule passes, with cost per task allowed to rise at most 25%; 15/30 on dev stays a reported target. Alternative: require the CI lower bound above 0 (stricter), or use 15/30 as the gate (native CEO view: a stretch goal).
- **T4: held-out world.** Recommend keeping seed 20261003 and disclosing the third use: P3. Alternative: a fresh seed for the headline at about +$240.

**Auto-decided:** 53 decisions (see the Decision Audit Trail).

**Review scores.** CEO: SELECTIVE EXPANSION; 0 critical gaps; Codex completed, native completed, consensus 5/6 confirmed, 1 disagreement (T3). Design: skipped (no UI scope). DX: 4 → 8/10; Codex completed, native completed, consensus 6/6, 0 disagreements. Eng: 16 issues mapped, 34 test gaps turned into required tests, 0 critical gaps; Codex completed, native completed, consensus 6/6, 0 disagreements.

**Cross-phase themes.**
- Headline first, capability second (CEO both voices; Codex again in DX and Eng).
- "Nothing found" must never be ambiguous: coverage state (CEO V6, DX Pass 3, Eng status row).
- Real-data precision before default-on (CEO V4, DX overrides, Eng typed_ner and alias-consumer regressions).
- Private content leaking through derived surfaces (CEO F9, spec C1.2 snippet, Eng alias parsing).

**Deferred to TODOS.md.** E3 doctor coaching for unlinkable typed records; E4 family-E ranking; V14 mention links on write.

**Approval needed.** Program authorization +$250 to $2,250 (follow-up ledger `set-cap` $237 → $487), or +$75 to $2,075 (cap $312) if UC1 is accepted.

#### Implementation Tasks (aggregated across phases)

- [ ] **T9 (P1, human: 3h / CC: 20m) — evals/prereg** — Preregister comparator, both pairs, headline build and sentences; holdout_stats.py pairs and capability screen mode
  - Surfaced by: ceo-review — CEO-E1; spec C1.1, C3.7
  - Files: docs/benchmarks/2026-10-02-model-ladder/holdout/holdout_stats.py
- [ ] **T10 (P1, human: 1d / CC: 2h) — evals/runs** — Run master control, dev rounds, A2 (or UC1 rescore) and A3 with pinned commit, wave-built slots and the A3 budget projection check
  - Surfaced by: ceo-review — CEO-F7, F8; spec C1.3, C3.1
  - Files: eval/runner/cat40-model-ladder.ts
- [ ] **T3 (P1, human: 1d / CC: 1h) — gbrain/aliases** — Entity-page alias sources: shared declaration parser, title subjects, page_aliases origin precedence, all-caps rule, first-word rejection
  - Surfaced by: ceo-review — System audit 3, 4, 8, 15; CEO-F3; spec S5.1-S5.2, C3.3
  - Files: src/core/ops/search.ts, src/core/engine-sql/pages.ts, src/core/import-file.ts, src/commands/reindex-aliases.ts, src/core/by-mention.ts
- [ ] **T7 (P1, human: 2h / CC: 10m) — gbrain/config** — mentions.auto_link off switch with reconciling removal
  - Surfaced by: ceo-review — V5
  - Files: src/commands/extract.ts
- [ ] **T4 (P1, human: 1d / CC: 45m) — gbrain/entity-card** — Card mentioned_in_count, mentioned_in (canonical-type groups, 10 rows, safeSynopsis snippet, privacy predicates), mentions_index; subject hits at exact-title rank
  - Surfaced by: ceo-review — System audit 5, 7, 13; CEO-F4, F6, F9; V6; spec F5.3
  - Files: src/core/verbs/entity-card.ts, src/core/verbs.ts
- [ ] **T1 (P1, human: 1d / CC: 1h) — gbrain/extract** — Run a reconciling mention pass inside extract --stale with its own due set, watermark, version and gazetteer-entry diff (additive migration)
  - Surfaced by: ceo-review — System audit 1; CEO-F1; spec S1.1-S1.3, F5.1-F5.2
  - Files: src/commands/extract.ts, src/core/by-mention.ts
- [ ] **T5 (P1, human: 4h / CC: 20m) — gbrain/links-op** — get_backlinks type/limit/offset with per-page rows, total, truncated; agent-first error for unknown type
  - Surfaced by: ceo-review — CEO-F10; spec C1.3, C1.4; Section 2
  - Files: src/core/ops/links.ts
- [ ] **T6 (P1, human: 2h / CC: 10m) — gbrain/mcp** — B5 instruction replacement and schema budget trades within unchanged ceilings
  - Surfaced by: ceo-review — System audit 14; spec F5.4, S5.5
  - Files: src/mcp/instructions.ts, test/mcp-schema-budget.test.ts
- [ ] **T2 (P1, human: 3h / CC: 15m) — gbrain/schema-pack** — One pack-aware linkableEntityTypes resolver (union with legacy four); base-v2 makes crm linkable per Taste T1
  - Surfaced by: ceo-review — System audit 2, 6; CEO-F2, F5
  - Files: src/core/by-mention.ts, src/core/verbs/entity-card.ts, src/core/schema-pack/base/gbrain-base-v2.yaml
- [ ] **T8 (P1, human: 1d / CC: 1h) — gbrain/tests** — Independent fixture brain, upgraded-brain, slot-style, privacy, race and 50k precision/timing checks
  - Surfaced by: ceo-review — V4; E5; Section 6
  - Files: 
- [ ] **E-T7 (P1, human: 2h / CC: 10m) — evals/runner** — Slot builds with --catch-up, coverage in slot receipts, refuse partial slots
  - Surfaced by: eng-review — native 6
  - Files: eval/runner/cat40/gbrain-arm.ts, eval/runner/cat40-model-ladder.ts
- [ ] **E-T8 (P1, human: 2h / CC: 10m) — evals/stats** — Per-cell leak check in the ship rule
  - Surfaced by: eng-review — Codex 10
  - Files: docs/benchmarks/2026-10-02-model-ladder/holdout/holdout_stats.py
- [ ] **E-T3 (P1, human: 4h / CC: 20m) — gbrain/alias-consumers** — Exact title outranks declared/subject aliases in every page_aliases reader
  - Surfaced by: eng-review — E4 (native P1-2)
  - Files: src/core/entities/resolve.ts, src/core/context/retrieval-reflex.ts, src/core/facts/capture-dedup.ts
- [ ] **E-T2 (P1, human: 6h / CC: 30m) — gbrain/aliases** — Alias origin in unique key, case_sensitive flag, sanitized parsing, alias due set, coordinated writes
  - Surfaced by: eng-review — Q3-Q5; Codex 1; native 3/5/10
  - Files: src/core/engine-sql/pages.ts, src/core/import-file.ts, src/commands/reindex-aliases.ts
- [ ] **E-T6 (P1, human: 3h / CC: 15m) — gbrain/card** — includeReferences option, shared referrer query, whole-card cap, status-row coverage
  - Surfaced by: eng-review — P2, P3
  - Files: src/core/verbs/entity-card.ts, src/core/context/turn-context.ts
- [ ] **E-T4 (P1, human: 4h / CC: 20m) — gbrain/links-op** — Compatible get_backlinks: array default, group:page envelope, keyset cursor, observed types
  - Surfaced by: eng-review — E3 (both voices)
  - Files: src/core/ops/links.ts
- [ ] **E-T1 (P1, human: 1d / CC: 1h) — gbrain/mention-module** — Generation-checked reconcile, authoritative gazetteer build, superset invalidation prefilter
  - Surfaced by: eng-review — E1, E2, P1 (both voices)
  - Files: src/commands/extract.ts, src/core/persistence/links-maintenance.ts, src/core/by-mention.ts
- [ ] **E-T5 (P1, human: 3h / CC: 15m) — gbrain/sql-schema** — Bind type lists as text[], guarded columns, watermark index, PGLite/Postgres parity
  - Surfaced by: eng-review — Q2, E5, P4
  - Files: src/core/by-mention.ts, src/commands/doctor/checks/managed-guard.ts
- [ ] **D5 (P1, human: 4h / CC: 20m) — gbrain/cli** — gbrain extract mentions --explain with reason codes; keep extract --explain <kind>
  - Surfaced by: devex-review — Pass 2-3; both voices
  - Files: src/commands/extract.ts
- [ ] **D6 (P1, human: 3h / CC: 15m) — gbrain/config** — mentions.auto_link registration and precedence, off/on semantics, entity_types, ignore, mention_ignore
  - Surfaced by: devex-review — Pass 2, 5, 6
  - Files: src/core/config.ts, src/core/by-mention.ts
- [ ] **D4 (P1, human: 3h / CC: 15m) — gbrain/coverage** — Coverage states and degraded notices on cards, misses and get_backlinks
  - Surfaced by: devex-review — Pass 3; both voices
  - Files: src/core/verbs/entity-card.ts, src/core/ops/links.ts
- [ ] **D2 (P1, human: 4h / CC: 20m) — gbrain/entity-card** — Rename card fields to referenced_by/referenced_by_count/coverage; preview, date_source, canonical_type
  - Surfaced by: devex-review — Pass 2; native vocabulary
  - Files: src/core/verbs/entity-card.ts, src/core/verbs.ts, docs/protocol/MEMORY_VERBS_v1.md
- [ ] **D3 (P1, human: 4h / CC: 20m) — gbrain/links-op** — get_backlinks group:page, total/truncated/offset, ordering, agent-operator errors
  - Surfaced by: devex-review — Pass 2-3; both voices
  - Files: src/core/ops/links.ts
- [ ] **D7 (P1, human: 3h / CC: 15m) — gbrain/mcp** — Sync mentions:false; surface-aware continuation and B5 placement; entity latency gate
  - Surfaced by: devex-review — Pass 6; both voices
  - Files: src/core/persistence/sync-run.ts, src/mcp/instructions.ts
- [ ] **D1 (P1, human: 3h / CC: 15m) — gbrain/upgrade** — [AGENT] activation line, reserved cycle budget for the mention pass, dry-run mention-due counts
  - Surfaced by: devex-review — Pass 1; native H1
  - Files: src/core/cycle.ts, src/commands/extract.ts
- [ ] **T11 (P2, human: 4h / CC: 30m) — evals/report** — Rewrite the Cat 40 finding: comparator, per-model CIs, entity-call share, cost per success, third-use and harness disclosures
  - Surfaced by: ceo-review — A4; V11, V12; S1.7
  - Files: docs/benchmarks/2026-10-02-model-ladder.md
- [ ] **E-T9 (P2, human: 2h / CC: 10m) — evals/uc1** — UC1 reuse audit: keep original safety flags for truncated transcripts, rerun ineligible cells
  - Surfaced by: eng-review — Codex 11
  - Files: 
- [ ] **E-T10 (P2, human: 2h / CC: 10m) — gbrain/mcp** — Prototype entity/get_backlinks descriptions against the schema budget before handlers
  - Surfaced by: eng-review — P5 (native P2-14)
  - Files: src/core/verbs.ts, src/core/ops/links.ts, test/mcp-schema-budget.test.ts
- [ ] **D8 (P2, human: 1d / CC: 30m) — gbrain/docs** — Entity-recall guide, README link, MEMORY_VERBS fields, CLI help, CHANGELOG upgrade table
  - Surfaced by: devex-review — Pass 4-5; both voices
  - Files: docs/guides/entity-recall.md, README.md, CHANGELOG.md

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` (via /autoplan) | Scope & strategy | 1 | ISSUES OPEN (not persisted to the review log; gate pending) | 17 proposals, 13 accepted, 3 deferred; 0 critical gaps |
| Outside Review | Codex `gpt-6-astra` (autoplan CEO, DX, Eng) | Independent 2nd opinion | 3 | completed | CEO 7, DX 8, Eng 11 findings; all dispositioned |
| Eng Review | `/plan-eng-review` (via /autoplan) | Architecture & tests (required) | 1 | ISSUES OPEN (not persisted to the review log; gate pending) | 16 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | skipped (no UI scope) | — |
| DX Review | `/plan-devex-review` (via /autoplan) | Developer experience gaps | 1 | ISSUES OPEN (not persisted to the review log; gate pending) | score: 4/10 → 8/10, TTHW: never → <5 min (target) |

- **OUTSIDE COVERAGE:** codex, CEO phase, completed (7 concerns + UC1 view). codex, DX phase, completed (8 concerns). codex, Eng phase, completed (11 concerns). Design phase skipped (no UI scope). Native Capy subagents completed in every phase (CEO 13, DX 15, Eng 19 issues) plus three CEO spec-review launches (27, 25, 20 issues).
- **CROSS-MODEL:** native (Capy subagent, model reported as Claude Opus 5.5) and Codex (`gpt-6-astra`) agreed on 5/6 CEO dimensions, 6/6 DX and 6/6 Eng. Both independently raised UC1-UC3, real-data validation, coverage state, private-alias leakage, the breaking `get_backlinks` envelope and `typed_ner` preservation. Disagreement: T3 (binding gate vs stretch goal).
- **VERDICT:** No review CLEARED yet: the plan is held at the Phase 4 gate for Garry's decisions on UC1-UC3 and T1-T4 and the budget ask; review logs are written on approval. Eng review required.

**UNRESOLVED DECISIONS:**
- UC1: reuse the 2026-10-02 simple-arm cells instead of rerunning them
- UC2: publish the corrected headline first, separate from Item B
- UC3: compare query-time exact enumeration before building the mention graph
- T1: `account` entity type (recommended) vs `crm`/`account` aliases on `company`
- T2: capability harm screen vs cost-wave screen
- T3: default-on gate definition (family-E gain point estimate, recommended)
- T4: keep seed 20261003 (recommended) vs a fresh seed
- Budget: +$250 (or +$75 under UC1) program authorization
