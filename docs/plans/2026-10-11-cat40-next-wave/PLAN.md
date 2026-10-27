# Cat 40 next wave: stale-value answers, the H4 gap, the v1 headline, and withdrawn facts

Status: reviewed by /autoplan 2026-10-12 (CEO, DX, Eng); gate rev 1 answered by Garry (relayed through GBRA-40, 2026-10-12) and the affected phases rerun; gate rev 2 answered by Garry (relayed through GBRA-40, 2026-10-12: owner-phrase resolution joins the wave, budgets doubled) and Eng rerun on the larger scope; gate rev 3 (whether F5 ships as its own stacked PR) answered `all` by GBRA-39 under Garry's standing instruction, so F5 stays in the one Part 1 PR with a stated fallback; /autoplan complete. See the Review record. Drafted 2026-10-11. Owner: GBRA-39. Merge queue: GBRA-40. Garry asked for a plan covering three items: (1) gbrain's two weak spots from the Cat 40 Hard confirmation, (2) the rerun recommendations in gbrain-evals #110, and (3) whether `remember` should restore a withdrawn fact.

## ELI10

When gbrain loses to plain files, it is almost always for one reason. It finds the customer's original contract, but the later amendment that changed the number never reaches the model, so the model confidently answers with the old number. Plain files lose less this way because grep shows every line that mentions the term. The fix is to show the customer's contracts and amendments where agents actually look (the quick batch lookup and the context pack), each with the date the page was written and, when the brain records it, the date its terms start, without pretending the newest page always wins; to deliver the part of a long document that sets the value through gbrain's existing evidence delivery; to show a document's draft status when the brain records it; and to recognize documents that name an account only by who owned it at the time. Separately, one old headline claim was measured with gbrain's reranker silently off and is retired, keeping its separate permission result. And a fact you told gbrain to forget stays forgotten; the refusal will say when it was forgotten.

## What happened

The Cat 40 Hard confirmation (gbrain-evals #93 RESULTS.md) put gbrain ahead of plain files by +7.7 points on a fresh world (M) and +13.0 on a sealed world (S), pooled over Opus 5.5, Sonnet 5.5 and GPT-6.1 Sol. The release shipped as gbrain v0.60.174.0. The report names two weak spots:

- **More wrong answers.** gbrain answered wrong more often than fs: 22 vs 14 cells on M, 16 vs 2 on S.
- **H4 trails.** On M's H4 family (current contract terms) gbrain scored 47 vs fs 56 of 60.

## Root cause (free analysis, `RCA.md` and `rca_next.py` beside this plan)

Inputs: world M (300 cells per arm) and the development world (150 per arm). No S cells or transcripts were opened. `rca_next.py` prints every number below.

- **One mechanism behind both.** gbrain's 22 wrong-value cells on M hold 22 class (a) items (the account's own superseded or older value): 18 cells are class (a) only, 2 mix (a) with a lower-authority source (g), 1 is (e) and 1 is (g). `search` was the first tool result carrying the wrong value in 16 of 22, and in 20 of 22 that result named the stale source document. The governing document appeared anywhere in the cell in only 12 of 22. Entity confusion and invented values are 0 on both worlds.
- **H4.** fs won 11 H4 cells and gbrain won 2. Of the 13 failed items in those cells, the deciding document was never returned in 7, and in 5 it was returned only as a chunk without the deciding sentence (2 uncertain because transcripts clip at 40,000 characters). In 1 it was shown and still answered stale. 0 hit the turn cap. The gap concentrates in long executed documents ("amended + long": gbrain 16/21, fs 20/21; "later effective wins + long": 11/15 vs 14/15).
- **`get_page` works but isn't used.** All 52 `get_page` calls on long H4 documents returned the deciding sentence. In none of the 13 failed items did the model open the deciding document. gbrain stops early: median 19 tool calls and 8 turns on these tasks against fs's 28 and 10.
- **The account views don't point at the governing record.** A median H4 account has 29 documents. `context_pack` listed about 4 of them and included the deciding document in 8 of 88 results. `entity` lists none.
- **Lower-authority sources.** 3 gbrain wrong items (all H4) came from an unsigned draft or a call-summary email, via `context_pack` and `get_backlinks`. 1 came from an agent note via `search`.
- **Not the cause.** The turn cap. Only 4 of gbrain's 32 wrong cells were submitted at turns 14–16, and gbrain's median wrong submit is turn 8 (fs 12). Turn-cap losses are gbrain's largest failure bucket (32 cells), but fs fails 31 of the same cells.
- **Dev world.** The mechanism holds: class (a) is 6 of 8 gbrain wrong items, `search` carries the stale value first in 5 of 6, and the card gap is the same. The H4 deficit does not reproduce (27 vs 27) because dev draws fewer long amended items (15 vs 36). So the mechanism is systematic, and the size of the H4 gap depends on the world's long-document mix.
- **Ceiling.** Fixing class (a) plus the lower-authority sources has a ceiling of +6.0 pooled points on M counting only cells fs got right (+7.3 counting all), and +2.7 on dev (+4.0). On H4 alone, flipping the 11 fs-won cells would move gbrain from 47 to 58. These are ceilings, not promises.

## Goal and kill criterion

- **Goal.** Lower gbrain's wrong-answer rate below fs's on a fresh world, and close the H4 gap, without losing the confirmed lead.
- **Primary endpoint (preregistered before confirmation).** Pooled gbrain − fs on a new fresh main seed and a new sealed seed (S is spent; SEALED.md says so), same three models, same rule as #93's PREREG: both Δ ≥ 0 to keep the claim, "ahead" only when the lower bound is above 0.
- **Secondary endpoints that decide whether this wave shipped its goal.** The wrong-answer count, gbrain vs fs, per world, and H4 gbrain − fs per world.
- **Kill criterion for the wave.** If the confirmation shows the wrong-answer count is not lower than the merge-base baseline's (at or after `0460af28`) on the same worlds under the preregistered paired test, measured by a same-window baseline arm, the wave's changes are reverted or kept only where they are neutral. The headline claim from #93 is not re-litigated by this wave unless Δ falls below 0, in which case the existing publish-and-stop rule applies.

## Implementation plan

### Part 1: point the agent at the governing record (gbrain product changes, one batched PR)

All changes are general to any brain with dated documents that supersede each other. No task-, family- or fixture-specific code. They rely on gbrain-owned fields and links (page type, the page's own date labeled as such, the existing referrer path, a documented non-ranking amends link, documented frontmatter `status`, owner and handoff statements in page text for F5) and on conventions documented in gbrain before the benchmark uses them. gbrain's `effective_date` is the page's own date, never a contract's validity date, and no list order is presented as "this record governs".

**F1. Candidate records where agents actually look: compact `entity names` rows and `context_pack`.** For each entity on a compact `names` row and on a `context_pack` card (pull verb only), list the pages of the brain's enrolled record types that reference it (enrollment is documented and off by default), built from the existing referrer path: page type, the page's own date labeled as a page date with its source, `status` when set, and the record it amends when a documented amends link says so. When the brain records a terms-validity date through the documented temporal-edge `since` on the amends relationship (see the CEO rerun line below), show it inside the amends object; otherwise omit it. No validity status is computed. List order is by page date and never implies which record governs. Every row set carries its `total` and an executable `next`; the full single-name card keeps `referenced_by` unchanged and gains the same records view. Expected effect: closes the card gap on the route used in 47 of 47 H4 `entity` calls; the validity-date part adds benchmark points only if the world writes that key into its documents (a document-bytes opt-in, with an fs rerun).

- Decided (Garry, relayed through GBRA-40, 2026-10-12, d2b): F1 does not order by gbrain's `effective_date` as if it were a validity date. Page dates are labeled as page dates; a terms-validity date appears only from a documented key and stays unknown otherwise; no ordering implies governance.
- Decided (Garry, relayed through GBRA-40, 2026-10-12, uc1b): F1 lives on compact `names` rows and `context_pack`, derived from the existing referrer path, instead of a new section on the full card only.
- Accepted (CEO): whatever F1's placement, record rows show the page date labeled as a page date (`date`, `date_source`) and list order is never presented as "this record governs"; a page with draft status is never listed without its status.
- Decided (Garry, relayed through GBRA-40, 2026-10-12, d5b): each compact `names` row carries a lean record list, or at least `referenced_by_count` plus an executable `next` to the full card; served instruction 7 stops recommending a `referenced_by` walk the batch mode cannot do.
- Accepted (CEO rerun, both voices): "amends" is declared as a pack link type that does not take part in ranking, following the existing temporal-edge vocabulary: frontmatter relationship objects such as `amends: [{name, since}]` (`docs/guides/temporal-edges.md`), so the terms-start date is the documented `since`, not a new `effective_from` key. Ranking participation is an explicit general link-type policy honored by every backlink and adjacency ranking consumer, existing defaults and reference membership are preserved, and a test proves final scores are unchanged when only such metadata edges are added, including threshold-crossing cases. As amended by the DX rerun: amends is declared `temporal: event` (only `state`/`event` link types record `since`), F1 shows only the recorded `since` and the page date and computes no status (neither `entity` nor `context_pack` takes a date, and F4 already tells the agent to compare with the date asked about), and amends edges are exempt from the default liveness filtering that hides future-dated edges, with a frozen-clock test that a future-`since` amends edge stays visible in `get_backlinks`, graph traversal and card edges (World M has 17 documents effective after its `today` of 2026-09-15). Enabling amends on an existing brain names its re-extraction command next to the enrollment example, and wave arms get fresh slot builds.
- Accepted (CEO rerun, native voice): every found `names` row carries `referenced_by_count` and an executable `next` unconditionally; records appear only when enrolled. The instruction 7 clause about records is conditioned on the callable surface, as the instruction builder already does for other clauses, so it names only fields the agent receives; tests cover both engines with enrollment off and on.
- Accepted (DX rerun, native voice): the names-row `referenced_by_count` and the row-level card continuation sit behind a default-on config key (switched off in one dev arm), so they are measurable per item; when the count or records read fails the row carries one shared unavailable marker plus the degraded notice, never a silent omission, and the full card's `referenced_by` follows the same rule. The records clause in the served instructions depends on enrollment state passed into the instruction builder (as the writeback setting already is), covers the standalone brief clause on surfaces without `search`/`query`, is referred to by its text, and the per-arm instructions-file hash is tied to enrollment state. When the 24-per-call cap binds, every name keeps its `total` and continuation and rows are allotted in input order, deduplicated by resolved page rather than input string; as amended by the Eng rerun there are two continuation fields: a row-level card continuation present whenever the names-row key is on, and `records[].next` per record type present exactly when rows < total; per-row `canonical_type` is dropped inside type groups; rows are ordered by page date, newest first, and the cap evidence is computed with that order (78 of 90 H1 and 83 of 171 H5 `names` calls returned 5 or more found names).
- Accepted (DX rerun, native voice): the preregistration names every key before dev: the enrollment key, the names-row key, the F2 key (whose values are the delivery-unit vocabulary), the F3 field and the F5 key (a build-time key, see the Eng rerun 2 lines under F5); the read-only check is config readback plus type-filtered `list_pages`/`get_backlinks`; the amends frontmatter mapping is user-authored per page type (`FrontmatterLinkSchema` is page-type specific) with a bundled example; the amends non-ranking default lives in code, and any pack-level policy field is optional and documented as version-gated, because the strict link-type schema refuses unknown fields on older gbrain.
- Accepted (Eng rerun, native voice): records and counts are computed for the found page and for each identity sibling, side by side and never merged, inside the 24-per-call cap, on `names` rows and `context_pack` cards, with a sibling-only fixture. On World M, records for the found page alone reach the deciding documents for 24 of 70 H4 items; with siblings, 51 of 70 (contracts and amendments that use an account's nickname link to its sibling page). This completes uc1b's surfaces rather than reopening it.
- Accepted (Eng rerun, native voice): `amends.since` is read under the caller's scope through the existing temporal-link join with the referrer read's private-page exclusion, and the hidden-referrer fixture gains a dated amends statement whose only evidence is on a private page. Frontmatter `since` attaches to targets by slug-prefix match today, so the name match is exact when several objects in one field match, with a prefix-sharing target-pair test.
- Accepted (Eng rerun, native voice): the batched multi-target records read is a variant of the shared referrer CTE (`src/core/mentions/referrers.ts:102`) with a parity test that every target's batched rows, order, totals and cursors equal the single-target read on both engines, including private, quarantined and below-floor referrers. The records and count phase has a cooperative deadline mapped to the unavailable marker plus notice, with a forced-slow test on both engines and a 50-names-with-siblings case (up to 150 target pages) in the performance test.
- Accepted (Eng rerun, outside voice): one shared record-metadata projection serves the initial F1 view and page-mode `get_backlinks` continuations without changing membership, tested beyond both caps and for types allotted zero initial rows. `page_status` on F1 records is inseparable from F1 (the F3 ablation switches it off only on `context_pack` and `get_backlinks` rows), tested F1-on/F3-off on initial and continued outputs on both engines. `page_status` accepts only a scalar string up to a stated length, and MEMORY_VERBS and the instruction clause state how it maps to search's raw `status` (native).
- Accepted (Eng rerun, native voice): the non-ranking policy lists every link-counting consumer in the PR (backlink and adjacency boosts, relational chain hops, typed degree, salience inbound counts and hub degree) with one final-score test row each, including a threshold-crossing case. The 5-per-name cap stays; its stated reason is recomputed on link membership with sibling-inclusive lists in the decided order (on link membership a page holds at most 4 records today, so no cap from 3 up hides a linked deciding document).
- Accepted (DX rerun, native voice): agents see page dates as page dates in the payload itself: keys stay `date`/`date_source`, validity lives only inside `amends`, `context_pack` packed text renders "page date", and F4's sentence names `date`/`effective_date` as page dates (2,902 of 3,169 M search results carry `effective_date`) with a named budget cut.
- Accepted (CEO rerun, native voice): a failed records query shows an explicit records-unavailable marker with the degraded notice, never an empty list, and the firing counter separates zero records from unavailable; `context_pack` records run through the same hidden-referrer fixture as the full card (structured and packed text, counts included) on both engines.
- Accepted (DX, both voices; as amended by Eng): F1 reads an explicit, documented enrollment: a config key (empty by default, so F1's records are off on brains that do not opt in) names which canonical page types are records, with a config example, a generic Markdown example with its expected tool result, and a read-only check that lists which pages count as records. "Amends" is a separate non-ranking link (below), never a body parser. Unrecognized types stay discoverable in ordinary references. The benchmark world opts in through the same documented config before any dev cell runs, and F1's benchmark points are attributed to that opt-in.
- Accepted (DX): records are an additional view; `referenced_by` membership and its `get_backlinks` parity are unchanged, and record rows reuse the `referenced_by` row shape without previews or per-row constant fields. As amended by the DX rerun, the sparse row is exactly `{slug, title, canonical_type, date, date_source, page_status?, amends?: [{slug, since?}], supersedes?}` (amended by the Eng rerun: `amends` is a capped list matching the frontmatter list, one row per referring page with every target and its own recorded date, and `supersedes` is typed explicitly): `amends` only when linked, `since` inside each entry only when recorded, `supersedes` only for genuine whole-record replacement, with a conformance fixture per optional field.
- Accepted (DX, both voices; as amended by Eng): one continuation shape. F1 uses the entity card's executable `next: {tool, arguments, requires_surface?}`, one `next` per record type, returning exactly the remaining records; a capped or withheld list keeps its `total` and `next` with a reason; an undeclared type says so instead of returning an empty list; mention-coverage and degraded notices propagate wherever records appear.
- Accepted (DX): in `context_pack`, F1 carries `referenced_by_count` (the existing name) or no count, and the `backlink_count` exclusion note lives in the payload or the docs, not in a field description, because served tools carry only name, description and input schema (DX rerun).
- Accepted (Eng, both voices; replaces the DX clause "\"amends\" is the existing `supersedes` link"): `supersedes` is a ranking input, not metadata. Hybrid search multiplies a superseded page's score by 0.5 and exact lookup will not promote it (`src/core/search/hybrid.ts:669-797`), so mapping amendments to it would down-rank the contract that still governs unchanged terms and future-effective items. "Amends" is a separate, non-ranking link type declared in the pack and fed by a frontmatter mapping rule; `supersedes` stays for whole-record replacement. Tests cover unchanged terms, future-effective amendments and genuine replacement through final search scores and labels. Garry kept this direction at the gate (d8a).
- Accepted (Eng, both voices): the schema-pack manifest is strict (`src/core/schema-pack/manifest-v1.ts`), so a new pack-level key would not load on the baseline arm or any older gbrain. Record-type enrollment is a config key the harness applies per arm; the pack carries only the link mapping. `gbrain config set` rejects unknown keys, so baseline runs receive no wave keys at all. Enrollment and relationship-rule lookup agree on canonical aliases.
- Accepted (Eng, both voices): records are filtered by enrolled type inside the shared referrer membership query, before ordering, LIMIT and hydration, with record-only totals and keysets, so the existing all-type caps cannot starve them. `names` rows use one batched multi-target query (no per-name N+1), the per-call cap is enforced before hydration and stated as a number (5 per name, or all when an entity has 5 or fewer, and 24 per call; a cap of 3 would hide the governing record in 2 of 70 M H4 items), and a names-mode perf test joins the existing card p99 test. Records get an explicit ORDER BY and cursor whatever d2 decides, and their continuation is one executable `next` per record type (no new `types[]` parameter on `get_backlinks`, whose description has 4 characters of budget left).
- Accepted (Eng, native voice): records are computed only in the `context_pack` pull verb, never in the shared assembler that also feeds the ambient push path (`src/mcp/context-pack-handler.ts:186`, 600 ms deadline); a test pins the push output unchanged.
- Accepted (Eng, native voice): before compact rows carry records, the security follow-up owner confirms `names` rows apply the same read options as the single-card path (flagged urgent outside this plan; details stay with that owner; #6528, merged 2026-10-12 as `0460af28`, v0.60.178.0, delivers it by static read in the Eng rerun, so the precondition is met pending the owner's confirmation, and the baseline merge base is pinned at or after `0460af28` because `entity-names.ts` is a measured path); F1's names-mode tests include such an entity.

**F2. Deliver the deciding part of long documents through the existing evidence delivery.** First run a frozen-hit, fixed-budget comparison of the existing delivery units (`window`, `section`, `page`) on long non-conversation hits, measuring answer correctness, evidence coverage, tokens and latency, with no model calls on frozen hits where possible. Any enrichment that follows (including a passage rule) is built inside the shared delivery seam (`src/core/search/evidence-delivery.ts`) with its provenance and truncation accounting, behind its own config key, default off until confirmation. F2 does not claim to recover documents that never appear in the hit list. Expected effect: at most the 5 returned-without-the-sentence items (2 uncertain) and the 3 long-document misses where the page is a hit.

- Decided (Garry, relayed through GBRA-40, 2026-10-12, d3b): the committed max-term-overlap passage picker is replaced by the delivery-unit comparison above; on M's lost cells a max-overlap sentence ranked the deciding sentence below another sentence in 9 of 12 parsed long-page hits (outside voice's probe).
- Accepted (CEO rerun, native voice): the comparison runs in two steps. A free step measures deciding-sentence coverage, tokens and latency on frozen hits for chunk (today's output, the control), window, section and page; a paid step compares units through the existing `search.return_unit` config on the merge-base build, H4 only, inside the development budget. The rule for picking a unit or building enrichment is written before the paid step. Any passage rule must beat the recorded lexical-selector result (an excerpt selector lost 53/60 → 48/60, `docs/eval/ANSWER_PACKET_RESULTS.md`). "The query names no term" is defined generically: after removing spans that resolve to an entity name or alias, no content token of the query occurs in the hit page; it is tested on a non-contract corpus, and no contract word list is used.
- Accepted (DX rerun, native voice): the paid step runs on the wave build with the F2 key set per unit, so it measures the policy that would ship rather than the global `search.return_unit`; if it must run on the merge base, the global-to-scoped transfer rule is written before it runs.
- Accepted (Eng rerun): one documented precedence table governs the delivery unit: an explicit call parameter, then a non-`auto` global `search.return_unit`, then the F2 key for long non-conversation hits under implied `auto`, through the existing config-key path, with a test of global `window` plus F2 `section` (native). The no-term veto applies only to a new passage selector unless the preregistered unit policy says otherwise; the free comparison and the serialized-output gate include an entity-only keyword query, and reach and firing strata come from the selected policy (outside).
- Accepted (CEO): any new F2 field is added to the lean-row allowlist (`src/core/search/lean-rows.ts`) or remote agents never see it; F2 is tested on a fixture where the term words recur in non-deciding clauses (the benchmark's boilerplate contains none of them, so benchmark gain overstates real-brain gain); a Sonnet harm check is preregistered for dev, because the 2026-10-08 evidence-brief variant measured −3.0 points on Sonnet.
- Accepted (DX, both voices): F2's activation is reachable on an ordinary remote search over non-conversation pages (today `auto` exits early when no conversation signal is present, `src/core/search/evidence-delivery.ts:305-315`; 573 of 658 M H4 searches omitted both `return_unit` and `token_budget`), without widening unrelated pages. Explicit `snippet_chars` and `token_budget` precedence is specified; any passage is counted in the existing delivery budget; the row reports firing through the existing `delivered` object and snippet marker instead of new `long_page`/`open_with` keys. A named `search.*` config key and default size are documented in `docs/evidence-delivery.md`, and `return_unit: "chunk"` stays the byte-identical off path. Tests assert on the final serialized lean MCP output.
- Accepted (Eng, both voices; refines the DX activation clause): F2 sits behind its own `search.*` config key, default off until confirmation passes. `test/evidence-delivery-golden.test.ts:78` (implied auto is byte-identical to chunk) stays as the off-path contract and a second frozen golden pins the on path; flipping the default later is its own behavior-change decision. Activation is resolved at the `search`/`query` caller and passed into the assembler as an explicit policy, so recall, think and queryless `assemble_evidence` stay byte-identical.
- Accepted (Eng, both voices): the passage leads the delivered text (or replaces the window anchor) so `snippet_chars`, which cuts from the front and was set on 283 of 658 M H4 searches, cannot drop it; lean rows carry a compact `delivered {unit, reason}` when F2 fired (today they keep only `{truncated: true}`); F2 has candidate-page and total-input-byte limits and a cooperative deadline, using a size preflight and a bounded batched fetch without slicing raw protected bodies; if a passage rule is built (the unit path has its own limits), F2 adds no text when the query names no term (421 of 658 M H4 searches used `match: "keyword"` and 352 named no term word), and dev results are stratified by match mode and term presence.
- F2 unit decision (free frozen-hit steps, 2026-10-12; [record](f2-frozen/README.md)): **section**, which ties page byte for byte on these worlds because long documents carry no inner headings. Budget correction: F2's activation path (implied `auto`, a long non-conversation hit, no explicit budget) runs at **24,000 tokens** via `search.return_budget_conversation`, not 6,000. 6,000 is `search.return_budget_default`. Of 3,180 recorded M agent search calls, 2,107 took the chunk path, 551 the auto path at 24,000, 497 the cap path at the caller's budget and 25 an explicit unit. At 6,000 no unit passed: the [global](f2-frozen/REPORT.md) and [scoped](f2-frozen/scoped/REPORT.md) steps reached at most 50/82 long pairs, and a 50% share cap made it worse. At 24,000 the [budget step](f2-frozen/budget/REPORT.md) replayed every recorded call on its own path. Section covers 78/82 M long pairs (chunk 3/82) with no short pair lost, and adds +8.2% delivered characters on H2–H4 against a preregistered 25% bar derived from the F2 arm's cost-cap headroom. Dev: 34/35 and +8.3%. The 4 remaining misses are cap-path calls with small caller budgets (2) and explicit-unit calls (2), where F2 is inert by precedence. Each rule was hashed before computing.

**F3. Document status where agents look.** Propagate the existing frontmatter `status` (only where set) to `context_pack` and `get_backlinks` rows and to F1's record rows as an additive `page_status` field (link rows already carry a temporal relationship `status` and an input filter on it, which stay unchanged; DX rerun), and document a `status: draft | unsigned` convention. No automatic "not binding" inference and no title, subject or first-line heuristics; summaries and drafts are not treated as lesser evidence by default. Expected benchmark points: 0 unless the world writes the documented `status` into its documents (a document-bytes opt-in, with an fs rerun). It ships because it is right for real brains.

- Decided (Garry, relayed through GBRA-40, 2026-10-12, uc2b): F3 is limited to propagating the existing `status` and a documented convention; the `authority` vocabulary and the heuristics are dropped. Per-row constant trust fields are not added to new rows (they read `operator_curated` on about 98% of M rows).

**F4. One general edit to served instruction 7 (instruction text only).** Replace "prefer the newest governing source" with: the record whose terms are in effect on the date asked about governs; a page's date says when it was written, not when its terms take effect; a change that is not yet effective does not apply yet. The same edit removes the `referenced_by` walk advice the batch mode cannot follow (d5). No new sentences in tool descriptions. Measured on dev like the round-4 guidance A/B, with the same rule: kept only if it doesn't cost points, and reported separately.

- Accepted (CEO): F4's sentence is written after F1's placement is settled and names only fields the model actually receives in the mode it calls.
- Decided (Garry, relayed through GBRA-40, 2026-10-12, d6b): F4 is the instruction 7 edit above instead of two new description sentences; the M runs already served the old wording.
- Accepted (CEO rerun, native voice): the PR gives the full replacement sentence for `src/mcp/instructions.ts:76`, removes "a later correction, handoff or executed change outranks an older record", keeps "drafts, proposals and agent-written notes do not override records", and counts characters against the 4,975 cap with the named cut.
- Accepted (Eng rerun, native voice): d5b's brief-clause change ships with F1's names-row fields (conditioned on the names-row key), separately from F4's governing sentence, so reverting F4 cannot drop it; the PR states what replaces the brief fallback slot. The instruction budget test covers the maximal rendering (enrollment on, names-row key on) and every per-arm rendering the preregistration names, records the F4 sentence's character offset per surface (it starts at 2,094 today, past the 2,048 that capped harnesses read), and the PR decides whether the governing rule moves before 2,048. Each arm's instructions file is generated and hashed from the wave builder.
- Accepted (CEO): every new stage reports whether it fired (records listed, hints stamped, passage returned vs fallback) through explain contributions or debug counters, and the dev record reports firing rates, so a null result can be read.
- Accepted (CEO): payload guard. Records are capped per call (not just per name; `names` takes up to 50), $/task and tool-result tokens are guard metrics in dev, and a deterministic test shows `newer_mentions` still packs under the default `context_pack` budget with records present.
- Accepted (DX): the payload guard is measured on the serialized tool result the agent receives (`context_pack` returns `cards[]` plus `text`; `budget_tokens: 1500` returned about 12,000 characters on M), from the attempts `chars` field, not the transcript (capped at 40,000 characters per result). Notice characters are reported on their own line and notice state is identical across baseline and wave arms. The per-call record cap is a stated number.
- Accepted (Eng, native voice): instruction and tool-description budgets have no headroom (instructions 4,975 of 4,975, search 1,788 of 1,800, entity 546 of 550, get_backlinks 766 of 770 characters in `test/mcp-schema-budget.test.ts`); every text change, F4 and d5/d6 included, names the cut that pays for it or records a budget raise per that test's convention.
- Accepted (Eng, native voice): each F-item ships behind its own config key with a documented default, and dev arms are measured on one build through the harness's per-arm `--gbrain-config` and description overrides, so per-item retention needs no build-vs-build multiplication.
- Considered (CEO, native voice): an entity-scoped exact-term lane (search scoped to an entity's referrers with a sentence-level return unit, the closest analogue of fs's grep). Not added as a planned arm; it is the fallback dev arm if F1 and F2 do not fire or do not move H4.

**F5. Owner-phrase resolution with validity windows** (Decided (Garry, gate rev 2, relayed through GBRA-40, 2026-10-12, d1b). Based on gbrain's P1 TODO "Owner-phrase resolution with validity windows" (`TODOS.md:7`). References such as "<person>'s freight account" depend on who owned the account on the date of the document, and today no extractor produces owner or handoff facts from page text, so a document that names an account only that way links to no account page. The entity card gains `known_as` rows, each an owner phrase with its validity window (the owner's start and end on that account), and the mention index links a document that uses the phrase to the account when the document's date falls inside the window. Owner and handoff facts come from page text through general rules (ownership and handoff statements with a date, on any page type), never from fixture, family or generator logic, and every derived row keeps its source page and line. Links derived this way are stored as ordinary mentions with their own kind (`link_source='mentions'`, `link_kind='owner_phrase'`), so every reader that already treats mentions specially treats them the same way; the rows obey the same visibility predicate as every other read. F5 ships behind its own config key, default off until confirmation. Expected effect: in World M, documents that name the account only by an owner phrase hold 8 of the 13 H4 items gbrain missed in cells fs won (gbrain never saw the deciding document in 6 of them), and F1 reaches at most 5 of the 13 without F5; a separate check confirmed both numbers independently. F5 needs no change to document bytes.

- Decided (Garry, gate rev 2, relayed through GBRA-40, 2026-10-12, d1b): the gate is the TODO's: on development data, the share of needed owner-phrase documents that an agent sees in any tool result rises against the same-build all-off control, and no Cat 40 family regresses against that control.
- Decided (Garry, gate rev 2, relayed through GBRA-40, 2026-10-12): precision bar. Before F5's default can change, its derived owner-phrase links are checked on a labeled real-brain sample run on Garry's Mac through GBRA-40, as the alias-extraction rule is (`TODOS.md:10`): precision at a Wilson 95% lower bound of 0.85 or more. The bar fits because a false owner link puts the wrong account's document on a card, the same harm as a false alias. The sample size follows from the bar: with 60 labeled links at least 57 must be correct, with 100 at least 92. The labeled sample stays in owner custody; only the counts and the bound are published.
- Accepted (gate rev 2): F5's tests run on a non-contract corpus as well as on the benchmark world, include handoffs with overlapping and open-ended windows, a phrase whose owner changes mid-document-history, and a phrase that matches no owner; the firing counter reports links derived, documents linked and phrases left unresolved.
- Accepted (Eng rerun 2, both voices): storage and ranking. F5 links follow the locked NER design (`src/core/extract-ner.ts:6-11`): `link_source='mentions'` with a new `link_kind='owner_phrase'`, through a migration widening the `link_kind` CHECK (`src/schema.sql:527`) on both engines; a separate link source would enter every ranking reader, which exclude only `link_source='mentions'`. F5 rows join the per-consumer final-score table with threshold-crossing cases; current mention, typed, manual and reference-membership defaults are unchanged, and no ranking-on F5 variant is run.
- Accepted (Eng rerun 2, both voices): build-time activation. The mention pass runs when a slot is built, while `--gbrain-config` is applied after restore, so a per-arm key cannot switch F5 on. F5 gets a build-time config channel recorded in the slot receipt and in the mention policy fingerprint (no extractor-version bump); each world and round builds an F5-off and an F5-on slot family; a free restore probe reports F5 coverage and link counts, and an F5-labeled arm whose probe reports zero F5 links is refused before any cell runs. Slot builds are priced in the development table.
- Accepted (Eng rerun 2, both voices): the resolution contract is written before implementation. Separate inputs for ownership statements, descriptors and the document's date; temporal candidates are resolved before ambiguity rejection; windows have stated start, end and boundary semantics, open ends and unknown dates; corrections end a stint; a belated note links only when its effective reading and its as-recorded reading agree; only a non-fallback page date is used, never a fallback date; windows are grouped per identity group across siblings; ownership statements are scanned on non-entity pages too; windows live in a new windowed table (neither `page_aliases` nor temporal edges can hold them) and enter the gazetteer key with their bounds; v1 uses no LLM and is deterministic. Each line gets one test row.
- Accepted (Eng rerun 2, both voices): invalidation and reconciliation. F5 rows persist source-qualified evidence dependencies; a change to a window alone invalidates the dependent generation; enable, backfill and disable have defined behavior with a coverage report; correction, deletion and concurrency are tested on both engines, reusing temporal storage where it fits.
- Accepted (Eng rerun 2, native voice): visibility. F5 rows record their evidence pages; remote and world-scope reads require every evidence page to be visible (the existing all/world scope pattern), and the hidden-referrer fixture gains a handoff whose only evidence is on a private page, on both engines.
- Accepted (Eng rerun 2, both voices): generality is checked independently. World M's ownership text comes from four sentence templates and none of its owner phrases is ambiguous, so the d1b gate on M cannot detect a template parser or a false link. The d4b transfer set, authored and frozen before F5 code by someone other than the implementer, adds varied handoff phrasings, belated notes, corrections, two accounts sharing a descriptor, temporal-corruption negatives, non-owner possessives and private-only evidence, plus a general non-contract corpus and a zero-provider extraction path.
- Accepted (Eng rerun 2, native voice): the d1b gate is operational. "Rises" is a preregistered minimum effect on the share of needed owner-phrase documents seen, with a paired test; "no family regresses" is a paired same-task, same-model per-family test with a stated margin, because a literal reading at one repeat fails 91–99% of the time when F5 has no effect and "rises" passes by chance about 40% (simulated). Needed owner-phrase documents are defined from gold evidence and reference forms (on M: H1 30, H2 13, H3 25, H4 19, so most F5 evidence sits in H1–H3, and H1 is reported as an F5 stratum for gain or harm). The seen share comes from each tool call's slug set recorded from the full result in the cell record, because transcripts cut results at 40,000 characters (10.5% of M's gbrain results hit the cap). The gate reads the F5-only vs all-off pair.
- Accepted (Eng rerun 2, both voices): surfaces. F5's measured path is the derived links, which reach agents through F1's records and existing reads; `known_as` is bounded with executable continuations where it appears, owner phrases stay out of `page_aliases`, the timeless `aka` list and search alias fan-out, and if `entity` accepts a phrase it returns every candidate with its window. The F1 interaction is checked by free replay, not a paid arm.
- Accepted (Eng rerun 2, both voices): precision procedure. After the rule is frozen, links are sampled uniformly from the derived document-to-account links, each labeled with subject, window and evidence; duplicates and unlabelable links have stated handling, and clustering by account is treated in the bound; with fewer than 22 derived links F5 stays off (22 of 22 correct is the smallest sample whose Wilson lower bound reaches 0.85); unresolved phrases are reported beside precision; labels stay in owner custody and only aggregate receipts are published.
- Accepted (Eng rerun 2, native voice): performance. Rescan wall time on a 55k-document slot and `names`-mode p99 with F5 on are added to the planned performance tests.
- Decided (gate rev 3, GBRA-39, 2026-10-12): F5 ships inside the one Part 1 PR. Its change is additive and switched on at slot build, so the stated fallback lives inside that PR: if F5 fails its d1b gate or its precision bar, its commits are removed from the Part 1 branch before Part 1 is sent to merge, and Part 1 ships without it.

**Not in this wave.** Turn-cap changes (no gap against fs) and model-specific prompting. Owner-phrase resolution joined the wave as F5 at gate rev 2.

**Revised expected effect (autoplan review, after the gate).** The ceilings are unchanged and re-derived: fixing class (a) plus the lower-authority sources is worth at most +6.0 pooled points on M counting only cells fs got right (+7.3 counting all); H4 at most 47 → 58. Per-item expectations are narrower than drafted. F1 now sits on the route agents used (compact `names` rows, `context_pack`), but reaches the benchmark only through the documented record-type opt-in, and its validity-date part only through a document-bytes opt-in. On World M, F1's records reach the deciding documents for 24 of 70 H4 items from the found page alone and 51 of 70 with identity siblings (Eng rerun). Documents that name an account only by its owner phrase link to no page, and they hold 8 of the 13 H4 items gbrain missed in cells fs won, so F1 alone can reach at most 5 of those 13; F5 targets the other 8 (it reaches them only if its links fire on M's handoff text); most of M's owner-phrase evidence sits in H1–H3 (needed documents: H1 30, H2 13, H3 25, H4 19), so F5's effect and any harm are reported per family. F2 can reach at most the 5 returned-without-the-sentence items (2 uncertain) and 3 of the 7 misses; the no-term veto applies only if a passage selector is built. F3's benchmark points are 0 unless the world writes the documented `status`. F4's effect is measured separately under the round-4 rule. In config-only worlds the amends link, validity dates and `status` contribute nothing on the benchmark, because the world's documents carry none of them. The measurable benchmark effect comes from F1 records on `names` rows and from F2, and only from Sonnet and Opus: all 11 H4 cells fs won used `entity names`, and Sol had none. No point estimate is made until the zero-provider gate and the first dev round report firing rates.

### Part 2: the v1 frontier headline (gbrain-evals #110's recommendations)

#110 found that the Cat 40 v1 frontier headline (gbrain `51f865d78` 95.6% vs fs 95.6%) ran with gbrain's reranker off in all 500 cells. Its three recommendations are:
1. Rerun the frontier headline with reranking on today's models.
2. Retire the six-model mid-tier claim (old models), letting recommendation 1 replace it.
3. Rerun Hard's held-out gbrain arm with reranking before treating −11.3 as the shipped gap.

Status: recommendation 3 is superseded. The Cat 40 Hard confirmation ran with reranking verified in every gbrain slot (168/168 and 167/167 hybrid-search cells reranked) and replaces −11.3. Recommendation 2 needs no spend.

**Decided by Garry, relayed through GBRA-40, 2026-10-12, d1b.** Retire the v1 success headline (the 95.6% parity row) and the mid-tier claim in the README, with no rerun. Keep the 0-of-100 finance-only permission result, after a static check confirms visibility filtering does not depend on reranking; it moves to its own row with its scope stated. Replace the headline with the Hard confirmation result and keep the old rows in history with their correction notes.

- Accepted (CEO): the README states that the Hard confirmation measures a different workload; it never implies the v1 comparison was remeasured.
- Accepted (DX): every sentence of README.md:141-148 and row 72 gets a disposition (retire, keep with scope, replace), including "gbrain costs about twice as much per task as files", which Hard M contradicts per model (Sonnet $0.59 vs $1.03, Opus $0.86 vs $1.75, Sol $0.28 vs $0.19 per task); the new Hard row states workload, models, reranker state and per-model cost.
- The permission result stays only if the static check passes; if it does not, it is retired with the headline and the check's result is recorded.
- Accepted (CEO rerun, native voice): the kept row states its build (`51f865d78`) and the surfaces it exercised; the static check also confirms those surfaces are unaffected by the #6509 fixes, otherwise the row is labeled a pre-fix historical result (details stay with that PR).

**Not chosen.** A v1 rerun (600 cells, about $150–200, parity at best on a near-ceiling world).

### Part 3: withdrawn facts (`remember` after `forget`)

**Today (traced on master and tested on both engines).** `remember` refuses a claim that is withdrawn for the subject it names, before anything is written, with `invalid_params` / `fact_withdrawn`. That holds for every caller, including the owner. No withdrawn row is reactivated, and dedup never matches a withdrawn row. Supersession and TTL expiry write no withdrawal, so re-saving those creates a new fact.

**Options considered.**
- (i) Always restore.
- (ii) Restore when the new call is more specific.
- (iii) Never restore implicitly.

(i) and (ii) reverse documented MEMORY_VERBS v1 semantics ("does not restore"), need a v2 document, and let any writer undo the owner's forget, because the withdrawal ledger records no principal.

**Recommendation: (iii), in two steps.**
1. **This wave, shipped standalone (Decided by Garry, relayed through GBRA-40, 2026-10-12, d7b).** The refusal gains an optional typed detail object (accepted shape below), omitted when the caller can't see the rows that back the withdrawal. No semantics change. It needs no eval, its security prerequisite (#6509) has merged, and it ships in the next batched gbrain wave PR that GBRA-40 assembles, not in the eval-gated Part 1 PR; GBRA-39 owns the lane.
2. **Later, only if the owner wants un-forget.** A `restore: true` parameter, trusted local callers first, kept off the starter tool list. It needs principal columns on the withdrawal ledger and a test that a restored fact survives the next sync.

Two visibility bugs in the withdrawal and card paths, found during this research, were fixed separately in a security PR, which merged as gbrain #6509 (v0.60.176.0, master `2895edb3`) during this review. Details stay in that PR.

- Accepted (CEO): Part 3 step 1 branches after the security PR merges and reuses its visibility predicate; both engines are tested so a caller without visibility gets the plain refusal; as amended by the Eng rerun (outside), every existing refusal classification and message after the security PR is preserved, the withdrawn detail is added only to the branch already eligible for it (the commit-time check is `assertFactNotWithdrawn` in `src/core/persistence/memory-prepare.ts:120`) through the shared helper, and immediate, deferred, batch and receipt error contracts are pinned on both engines; the change is listed under behavior changes with its consumer named. The refusal detail is documented as covering the exact normalized claim only: it is not a guarantee about paraphrases, which the existing suggestion already permits.
- Accepted (DX, both voices): the refusal detail is one additive typed object (as amended by the DX rerun: `withdrawn: {at, subject, all_entities: true?, visibility}`, with canonical envelope code `fact_withdrawn` following the `purged_content` pattern, an error-registry entry with why, suggestion, docs link and `fix.next`, wire code `invalid_params` kept; not named "scope", which already means OAuth/read scope) carried identically on the immediate refusal, the batch item error and the failed write receipt, through `OperationError`, the agent envelope and batch projections; the legacy message prefix is unchanged; MEMORY_VERBS v1 documents that absence carries no meaning; stdio, HTTP and CLI JSON outputs are tested, and a receipt read applies the visibility predicate at read time.
- Accepted (Eng, native voice): the detail comes only from `fact_withdrawals` (never from purge records), with a deterministic rule for which ledger row supplies `at` and the subject when several match; the object persists in the write receipt's outcome so later receipt reads carry it; the second refusal site at commit time (`src/core/facts/write-single.ts:137-140`) applies the same visibility predicate. Part 3 step 1 can start now that #6509 has merged. It ships standalone in the next batched gbrain wave PR (d7b).

### Development and confirmation (no tuning on held-out data)

- **Development.** Use the calibration world (seed 20261005) plus world M as development worlds. M is now spent as a confirmation world, so it can serve as a development world: its H4 has the long-document mix that dev lacks. Use the same three models (the newest per family: Opus 5.5, Sonnet 5.5, GPT-6.1 Sol; no Fable in counted cells), gbrain arm only, against recorded fs cells, with two full rounds (schedule and cost table below). Per-item effects come from per-item config arms on the one wave build; the only build-vs-build pair is wave vs merge base, and it runs in the confirmation (baseline arm), not in development; F5 arms additionally need their own slot builds (below).
- **Confirmation.** A new fresh main seed, plus a new sealed seed generated on Garry's Mac (custody as before). Arms: gbrain baseline (the wave's merge base, at or after `0460af28`), gbrain wave build, fs, and oracle as a check. The baseline arm makes the wrong-answer endpoint a same-window comparison. Preregistered before any confirmation cell runs.
- Decided (Garry, gate rev 2, relayed through GBRA-40, 2026-10-12): confirmation budget doubled to about **$3,400** with the baseline arm.
- Accepted (gate rev 2): how the extra confirmation money is spent, chosen by the interval width each option buys. Width is the primary endpoint's 95% interval (pooled gbrain − fs, percentile bootstrap over tasks), estimated per world from M's task-level variance: the #93 M interval [+2.7, +12.7] (half-width 5.1 pp over 100 tasks) reproduces from the recorded cells. These widths are forecasts, not observed intervals: half-width = 1.96 × sqrt((B + W/r) / (100k)), where k is the task multiplier, r the repeats, W = d/3 the run-to-run part of a task's three-model mean difference (d is the share of cells whose two repeats disagree, applied to both arms and assumed independent), and B = 0.067 − W the remainder of M's observed task-level variance. Hard has no repeated cells, so d comes from earlier Cat 40 rounds with two repeats: 6.4% to 17% across `docs/benchmarks/2026-10-02-model-ladder/{baseline-uncapped,holdout,followups}` and `2026-10-03-agent-operator`, about 12% typical. Per-arm costs per world at 100 tasks: gbrain about $198 (M $179.09, S $217 from S's published aggregates), fs about $286 (M $301.15, S $270.53), oracle about $25 (M $24.96).

| Option | Per world | Two worlds | Primary half-width per world |
|---|---|---|---|
| Base: 20 tasks per family, 1 repeat (baseline, wave, fs, oracle) | $707 | $1,414 | ±5.1 pp |
| A: repeat 2 on every arm (oracle once) | $1,389 | $2,778 | ±4.2 pp (±4.7 to ±3.8 across 6–18% disagreement) |
| B: 40 tasks per family, 1 repeat | $1,414 | $2,828 | ±3.6 pp |
| A + B: 40 tasks per family, repeat 2 | $2,778 | $5,556 | ±3.0 pp (over budget) |

Choice: B. For the same money, doubling tasks gives an interval at least as narrow as repeat 2 under any repeat-disagreement rate, because more tasks shrink both parts of the variance and repeats only the run-to-run part; it also doubles the paired wrong-value cells the wave-vs-baseline endpoint counts. The world generator exposes `tasks_per_family` (`eval/generators/hard/schema.ts:88`, default 20, at most 99), so the preregistration sets 40 for both the fresh seed and the sealed seed generated on Garry's Mac and records it with the new world digests. The knob reassigns variants by virtual index and adds planted accounts, so the 40-task worlds are different worlds, not #93's with twice the tasks: `validate.ts` runs on both, the H4 variant and `+long` mix are reported against #93's, the custody owner confirms the sealed generator takes the same knob before the seed is generated, and the README says so. Priced at the 1.108 ledger rate, B costs about $3,133 plus about $55 for four slot builds (baseline and wave, two worlds; estimated from M's $13.68), about $3,190 in all. The remaining ~$210 covers ordinary retries only; no full-arm rerun fits (one 40-task gbrain arm is about $439), so if a harness fault voids an arm, confirmation stops and the rerun is escalated to Garry through GBRA-40.
- Accepted (CEO): M results are labeled in-sample and diagnostic, because the F-items were designed from M's failures.
- Decided (Garry, relayed through GBRA-40, 2026-10-12, d4b): a zero-provider transfer and negative-control gate runs before any paid development round: independently authored pages outside the generator (partial overrides, future validity, a decisive paragraph with no lexical overlap, a summary that is the only evidence, long pages with repeated irrelevant term words, missing or conflicting metadata), exercised through both `entity` modes and `context_pack` packed text and structured output, on original corpora without enrichment, with metadata-enriched inputs reported as a separate condition. It is free and gates the first paid round.
- Accepted (CEO rerun, both voices): the transfer pages are authored and frozen before F-item implementation by someone other than the implementer; the surfaces include remote `search`/`query` serialized lean output with F2 on and off and with `snippet_chars` and budget variants (today's chunk output kept as the frozen-hit control); the pass rule is written before it runs: the deciding page or passage surfaces within caps, no hidden or wrong-status rows appear, and the original-corpus condition shows no regression against the merge base.
- Accepted (CEO rerun, native voice): arm schedule inside the budget. Per-item config arms run on H2–H4 only (all 22 gbrain wrong-value M cells sit there; about $93 per gbrain arm on M H2–H4), plus one full-family all-on guard run per round, with the number of rounds stated in the development record. An fs rerun costs about $301 on M all-in (300 cells, judge included; $297 agent only) and about $150 on the 150-cell calibration world.
- Accepted (Eng rerun, native voice): each round adds an all-off control arm on the wave build, and the round count and arm list are preregistered with a cost table: one full round on M costs about $723 (per gbrain arm about $93 on H2–H4, $172 on the full family, $29 on H4 alone), so two full rounds exceed both $900 and $1,200. The schedule fits the budget by running later rounds on H4 or H2–H4 only and the calibration world as a guard; judge cost is ledgered.
- Decided (Garry, gate rev 2, relayed through GBRA-40, 2026-10-12): development budget doubled to about **$1,800**, up to **$2,400** only if a fix truly needs document bytes to change. Worlds stay config-only by default; no fix in this plan needs document bytes, F5 included.
- Accepted (gate rev 2; repriced by Eng rerun 2): development schedule and cost table. Costs are per gbrain arm on World M from the #93 M cells (`docs/benchmarks/2026-10-10-model-ladder-hard-confirmation/main-cells`, 100 tasks × 3 models, 1 repeat), all-in (agent, gbrain service, judge): full family $179.09, H2–H4 $97.37, H4 $30.17. They are then multiplied by #93's observed ledger rate on M: the main-cell ledger receipts total $531.96 ($419.27 + $112.68) against $480.24 attributed to canonical cells, a factor of 1.108. Priced arms: full family $198.43, H2–H4 $107.89, H4 $33.43. A 5-slot M build costs $13.68 (`main-slots/receipt-1791667184117.json`); F5 needs an F5-off and an F5-on slot family per round.

| Step | Arm | Families | Cost |
|---|---|---|---|
| Before round 1 | F2 paid unit step: `window`, `section`, `page` (3 arms) | H4 | $100.29 |
| Round 1 | all-off control | full | $198.43 |
| Round 1 | all-on (preregistered wave config) | full | $198.43 |
| Round 1 | F5 owner-phrase only | full | $198.43 |
| Round 1 | F1 only (enrollment, names-row key on) | H2–H4 | $107.89 |
| Round 1 | F1 with the names-row key off | H2–H4 | $107.89 |
| Round 1 | F2 only (chosen unit) | H2–H4 | $107.89 |
| Round 1 | F4 only | H2–H4 | $107.89 |
| Round 1 total | 7 arms | | $1,026.85 |
| Round 2 | all-off control, all-on, F5 only | full | $595.29 |
| Rounds 1–2 | slot builds: F5-off and F5-on families, 2 per round | | $54.72 |
| Development total | | | **$1,777.15** |

Round 2 repeats the three full-family arms (F5's gate and the all-on regression check get two rounds); the per-item F1, F2 and F4 arms run once, which the Eng rerun 2 repricing forced (repeating the F1 and F2 arms in round 2 would bring the total to about $1,993). Each arm runs under a per-arm `--budget-usd` cap at 1.15 times its price. Stop rule: if round 1's ledger exceeds its priced total by more than the remaining headroom, round 2's all-on arm runs on H2–H4 only (saving $90.54); anything beyond that stops and is escalated to Garry through GBRA-40 before more cells run. Wave arms deliver more text by design (M's gbrain H4 search results average 22,803 characters), so actual per-cell cost may exceed this price; the cap and stop rule bound it. F3 gets no paid arm because config-only worlds carry no `status`. The calibration world serves the free transfer and replay checks only.
- Accepted (gate rev 2): reconciliation of the earlier "about $723 per round" (Eng rerun). It was 5 H2–H4 arms (4 per-item arms plus the all-off control) at $93.05 = $465.25, one full-family all-on guard at $172.36, and the F2 unit step at 3 × $28.65 = $85.95, totalling $723.56 in agent cost only, before judge, gbrain service, ledger overhead, slot builds and the calibration world. The table above replaces it and the round-count arithmetic in the two schedule lines before it.
- Accepted (Eng rerun, native voice): the draft-first rate is a preregistered firing and harm metric, stratified by model and H4 variant: in 21 of 70 M H4 items the newest-first list leads with a draft amendment that carries no `page_status` in config-only worlds. The d4b transfer set includes a draft without status, and the dev record states the expected sign.
- Accepted (CEO rerun, both voices): the preregistration names each run's exact `--gbrain-config` list, enrollment and served-instructions hash; baseline runs receive no wave keys; each config recipe is executable and verified by slot restore, pack resolution and config readback before paid cells. The claim applies to the preregistered wave configuration with enrollment, unless the default flips that ship are themselves preregistered.
- Accepted (CEO rerun, native voice; owner call before any dev cell): this plan defaults to config-only worlds for development and confirmation, which keeps recorded fs cells and comparability with #93. A world that writes the documented keys (`status`, `amends` with `since`) is a new generator version with an fs rerun and a README note that the workload changed; choosing it is Garry's call before any dev cell, inside the $2,400 development ceiling (gate rev 2), and the other condition is reported separately and labeled.
- Accepted (CEO; Eng updated: the security PR merged as #6509, so the merge base is at or after `2895edb3`, v0.60.176.0; the Eng rerun pins it at or after `0460af28`, v0.60.178.0): baseline arm is the wave's merge base (master after the security PR), not v0.60.174.0, so the comparison isolates this wave; confirmation runs on the branch build before merge (as the last wave did), and component retention is frozen on development data before any confirmation cell runs. "Keep only neutral pieces" never selects components using the confirmation worlds.
- Accepted (CEO): the preregistration freezes exact denominators (wrong submitted cells, and cells naming a listed wrong value, reported separately), a paired same-task same-model test for wave vs baseline on wrong-value cells with a stated minimum effect, H4 reported stratified by the `+long` variants (the knobs stay frozen), per-model results (Sol is at 0 wrong-value cells on M, so it is a ceiling for that endpoint), and abstention / non-submission alongside correctness so fewer wrong answers cannot come from more non-answers.
- Accepted (CEO): `bun scripts/model-freshness.ts` runs before preregistration and its output is recorded (project model rules).
- Accepted (Eng, native voice): any opt-in that changes document bytes (frontmatter written by `renderDoc`, which every file-backed arm reads) bumps the generator version, records new world digests and reruns the fs arm on the changed development worlds; "gbrain arm only against recorded fs cells" holds only for config-only opt-ins. The plan keeps the two kinds separate.
- Accepted (Eng, native voice): the preregistration records the measured build SHA and the path set it measured; a later master merge that touches a measured path needs a written no-effect argument in the decision record or a re-confirmation.

### Shipping

One eval-gated gbrain PR for Part 1. Part 3 step 1 ships standalone in the next batched gbrain wave PR (d7b). One gbrain-evals PR for the plan, development record, preregistration, results and README changes. GBRA-40 merges. Stamps and migration numbers are taken at the slot.

- Accepted (DX): the gbrain PR lists, per F-item, the MEMORY_VERBS v1 additive sections (including the line saying `context_pack` computes no references, which F1 changes), verb output schemas and conformance fixtures, the `docs/evidence-delivery.md` change, the `gbrain errors` row for the refusal detail, the MEMORY_VERBS names-row paragraph, `BEHAVIOR_CHANGES` rows for the default-on changes (names-row fields, `page_status` on `get_backlinks`/`context_pack` rows, the served instruction text, and the full card's `referenced_by` moving from silent omission on failure to the unavailable marker plus degraded notice, with a forced-failure test), F5's MEMORY_VERBS `known_as` section, conformance fixtures, an owner-phrase convention doc, config docs, explain support and the `link_kind` migration, and the llms.txt regeneration.

### Cost (estimates; actual spend is ledgered)

- **Development: about $1,800** (doubled at gate rev 2, Garry, relayed through GBRA-40, 2026-10-12; was $900), up to about **$2,400** only if a fix truly needs document bytes to change and the fs arm must be rerun (about $301 on M, about $150 estimated on the calibration world). The schedule above totals $1,777.15 at the ledger rate with slot builds. The zero-provider transfer gate is free.
- **Confirmation: about $3,400** with a baseline arm (doubled at gate rev 2, Garry, relayed through GBRA-40, 2026-10-12; was $1,700). Option B above (40 tasks per family, 1 repeat, baseline, wave, fs and oracle arms on two worlds) costs about $3,190 at the ledger rate with slot builds, with about $210 held for retries. Last wave's two worlds' canonical cells cost $967.74 (M $480.24, S $487.50, judge included); M's main-cell ledger receipts were $531.96, 10.8% above its canonical cells.
- **Part 2:** no rerun, no eval spend.
- **Part 3:** no eval spend.

### Decisions (Garry, relayed through GBRA-40, 2026-10-12)

Gate reply (gate_rev 1): `uc1b uc2b d1b d2b d3b d4b d5b d6b d7b d8a p1b`. Gate reply (gate_rev 2): `d1b d2a p1b`, from Garry's words "Double the budget let's be comprehensive" as read by GBRA-40.

| Item | Decision |
|---|---|
| Part 1 F1 | candidate records on compact `names` rows and `context_pack` from the referrer path (uc1b, d5b); no governance ordering by page date (d2b); non-ranking amends link stays (d8a) |
| Part 1 F2 | delivery-unit comparison first, enrichment only inside evidence delivery (d3b) |
| Part 1 F3 | existing `status` propagation plus a documented convention; no authority inference (uc2b) |
| Part 1 F4 | one general edit to served instruction 7 (d6b) |
| Part 1 F5 | owner-phrase resolution with validity windows joins the wave (gate rev 2 d1b), with the TODO's gate and a Wilson 95% lower-bound precision bar of 0.85 |
| Development | zero-provider transfer gate before paid rounds (d4b); about $1,800, up to $2,400 only if document bytes must change (gate rev 2, doubled) |
| Confirmation | about $3,400 with a baseline arm (gate rev 2, doubled); spent on 40 tasks per family |
| Part 2 | retire the v1 success headline, no rerun; keep the 0-of-100 permission result (d1b) |
| Part 3 | (iii): refusal detail now, restore later only on request; step 1 ships standalone (d7b) |
| Plan | approved with these overrides (p1b); gate rev 2: `d1b d2a p1b`, amends liveness exemption kept (d2a); gate rev 3: `all` (d1a p1a) by GBRA-39, F5 stays in the one Part 1 PR with a stated fallback |

## Review record

### Autoplan run

`/autoplan` (gstack 1.91.92.0) ran unattended on 2026-10-11/12 on a Capy cloud machine (`SESSION_KIND: unattended`, ephemeral state root). Run `plan-cat40-next-wave-20261012-010042`. `autoplan guard: not enforced by this host; publication order is unverified (GUARD_NOT_INSTALLED)`. Scope: UI no (0 matches, Design skipped); DX yes (3 term matches plus `--agent-primary`: agents are the primary users of the tool output). Phase order CEO → DX → Eng. Native voice: anthropic/claude-opus-5-5 (Capy host subagent). Outside voice: openai/gpt-6.1-sol (Capy host subagent, runner `host-dispatched review`; the Codex CLI is not installed and was not needed). Model spend for both voices is host-subagent spend, recorded as unknown; no model evals ran.

Evidence checks by the orchestrator (free):
- `rca_next.py` re-run on World M: the world was regenerated with the committed command (4k base digest `84f0614a…`, 50k digest `6f08629e…`, file sha `99c53db0…`, all matching `main-world-manifest.json`) and the committed `main-cells` were used. Every World M line of `rca_next.out`, including every M ceiling, re-derived byte-identically.
- Not re-derived: every development-world number (dev-r5 and dev-r4-fs cells and the r3 world output are on another machine): "class (a) 6 of 8", "search first in 5 of 6", "H4 27 vs 27", "15 vs 36 long amended items", "+2.7 (+4.0) on dev", dev pooled 125 vs 111.
- Code spot-checks on gbrain master `da434385` (0.60.175.0): `effective_date` semantics, the two `entity` modes and `referenced_by`, `context_pack` `newer_mentions`, search `chunk_text` and evidence delivery, Part 3's refusal and ledger. Receipts are in the CEO premise table below. No sealed-world material beyond published aggregates was opened.

### CEO review (Phase 1)

Mode: SELECTIVE EXPANSION per the autoplan override (the native lane recommended SCOPE REDUCTION inside its own review; recorded as a deviation, no scope was cut without the gate).

**Premise table (REALITY rows).** `PLAN_REALITY: phase=ceo rows=7/7 missing=none unverified=1 verdict=complete`.

| # | Premise | Verdict | Receipt |
|---|---|---|---|
| P1 | One mechanism (class (a)) explains the wrong answers | verified on M; 22 items, but 18 pure-(a) cells, 2 (a)+(g), 1 (e), 1 (g) | rca_next.out "gbrain failed cells by cause" |
| P2 | H4 losses: 7 never returned, 5 returned without the sentence, 0 turn cap | verified on M | rca_next.out §2 |
| P3 | `entity` lists no account documents | partly false: only compact `names` rows list none; the full card has `referenced_by`; all 47 H4 entity calls used `names` | gbrain src/core/verbs.ts:224-268; src/core/mentions/referrers.ts:42-55 |
| P4 | F1 can sort newest-effective-first from `effective_date`/`effective_date_source` | false: effective_date is the page's own date (signed date for an amendment) | src/core/effective-date.ts:1-37; src/core/types.ts:195-201 |
| P5 | F2 does not depend on the model opening the page | true for the passage; reaches at most 3 of 7 misses (4 are short documents) | rca_next.out §2 |
| P6 | F3's markers are documented gbrain conventions | false today; search rows already pass raw `frontmatter.status` | src/core/types.ts SearchResult `status`; src/core/search/lean-rows.ts |
| P7 | Dev world reproduces the mechanism | unverified here (dev cells not on this machine) | — |
| P8 | Hard confirmation reranked in every gbrain hybrid-search cell | verified (168/168 M, 167/167 S, published aggregate) | docs/benchmarks/2026-10-10-model-ladder-hard-confirmation.md |
| P9 | `remember` refuses withdrawn claims; ledger has no principal | verified | docs/protocol/MEMORY_VERBS_v1.md:301-305; src/schema.sql:781-788 |
| P10 | Baseline arm adds about 50% to confirmation cost | false: about +33% ($0.58/task gbrain vs $0.99 fs on M) | analysis-main.md per-arm table |
| P11 | The v1 README row is only a reranker-tainted parity claim | partly: the same row carries the 0-of-100 permission result | README.md:72 |

**Consensus (CEO).** Both voices completed. The binder's reconciliation: 6 outside findings, all confirmed against a native finding; 0 disagreements; 11 native-only findings. Semantic note: the binder paired outside F5 (acceptance rule) with native F5 (baseline choice) and outside F6 (transfer gate) with native F7 (M in-sample); the closer native counterpart of outside F5 is native F6 (endpoints cannot detect a few-cell effect). Both pairings agree in direction.

| Dimension | Claude (Opus 5.5) | GPT-6.1 Sol | Consensus |
|---|---|---|---|
| Premises valid? | no: P3, P4, P6, P10 | no: dates, entity route, F3 markers | CONFIRMED (not valid as written) |
| Right problem? | yes (stale record first) | yes, reframed as delivering dated evidence | CONFIRMED |
| Scope calibration? | F1 wrong surface, F3 too broad | F1/F3 overreach, F2 mechanism unproven | CONFIRMED |
| Alternatives explored? | no: entity-scoped exact-term lane | no: delivery-unit comparison | CONFIRMED (different alternatives) |
| Competitive/real-brain risk? | benchmark gain overstates real brains | conventions untested off-generator | CONFIRMED |
| 6-month trajectory? | build on links toward valid-time claims | validity contract before ordering | CONFIRMED |

**Findings (both voices; full prose in the run directory).** Native: 1 Critical, 5 High, 7 Medium, 3 Low, 1 Informational. Outside: 5 High, 1 Medium. Confirmed by both: F1's date semantics; F1 misses the compact `names` route and duplicates `referenced_by`; F2 belongs in evidence delivery and max-term overlap does not reliably pick the deciding sentence (outside probe: below another sentence in 9 of 12 parsed long-page hits in M's lost cells); F3's authority inference; the acceptance rule and baseline; the in-sample / transfer problem. Native only: endpoints cannot detect a few-cell effect, baseline cost +33%, Part 2 README split, entity-scoped exact-term lane, payload crowding of `newer_mentions`, firing counters, Part 3 after the security PR, model freshness check, F4 wording order, item/cell conflation, six-month note.

**NOT in scope.** Turn-cap changes (fs fails 31 of the 32 turn-cap cells gbrain fails), model-specific prompting, owner-phrase resolution, Part 3's `restore: true` (later, owner-requested only), a terms-effective metadata extractor that parses body sentences (fixture-shaped), changing the frozen knobs.

**What already exists.** `referenced_by` on the full card (src/core/verbs/entity-card.ts:110-165); referrer rows with date, date_source and trust fields (src/core/mentions/referrers.ts:42-55); `newer_mentions` on `context_pack` (src/core/mentions/newer-mentions.ts); the search supersession stamp and frontmatter `supersedes` mapping (src/core/search/hybrid.ts:670-797); raw `status` on search rows; trust tiers; evidence delivery (src/core/search/evidence-delivery.ts, docs/evidence-delivery.md); the lean-row allowlist (src/core/search/lean-rows.ts:31-40); the withdrawal refusal (src/core/facts/withdrawal.ts:15-21). The draft plan reused none of them explicitly.

**Error & Rescue Registry.** 13 codepath rows in the native review; 2 GAPs (a draft listed as a governing record; the wrong passage chosen on a real contract) and 1 conditional GAP (protected-body boundary if F2 is built outside evidence delivery).

**Failure Modes Registry.**

```
  CODEPATH            | FAILURE MODE                          | RESCUED? | TEST? | USER SEES?            | LOGGED?
  F1 ordering         | non-governing record listed first     | N        | N     | silent wrong answer   | N   <- CRITICAL GAP
  F1 records          | draft-typed amendment listed          | N        | N     | silent                | N   <- CRITICAL GAP
  F1 compact rows     | 50-name batch payload blowup          | N        | N     | slow, costly call     | N
  F2 passage          | wrong sentence on a real contract     | N        | N     | silent, plausible     | N   <- CRITICAL GAP
  F2/F3 fields        | stripped by lean rows (remote)        | N        | N     | silent no effect      | N   <- CRITICAL GAP
  context_pack budget | records crowd out newer_mentions      | N        | N     | silent regression     | N   <- CRITICAL GAP
  Part 3 detail       | detail shown without visibility       | must     | N     | disclosure            | N
  confirmation        | baseline confounded by master drift   | N        | n/a   | wrong verdict         | n/a
```

**Dream state delta.** After this wave, with the review's fixes, an agent sees that a newer record amends the one in front of it, gets the deciding passage of long records through evidence delivery, and sees drafts labeled by a documented status. Still missing against the 12-month ideal: terms-effective dates as data, typed valid-time claims, and an "as of D" answer that names the governing record.

**Completion summary.** Mode SELECTIVE EXPANSION; 23 findings across both voices (1 Critical); premise table 11 rows, 3 false, 2 partly false, 1 unverified; 5 critical gaps in the failure-modes registry; 2 user challenges and 4 one-voice direction changes go to the gate; Design section skipped (no UI scope).

<!-- autoplan-accepted:ceo -->
- RCA wording: "22 wrong-value cells" is stated as 22 class (a) items in 18 pure-(a) cells, 2 (a)+(g), 1 (e), 1 (g).
- F1 record rows label the page date as a page date (`date`, `date_source`); list order is never presented as governance; a draft-status page is never listed without its status.
- F2's new fields are added to the lean-row allowlist; F2 is tested on a fixture where term words recur in non-deciding clauses; a Sonnet harm check is preregistered for dev.
- F4's sentence is written after F1's placement is settled and names only fields the model receives in the mode it calls.
- Every new stage reports whether it fired (explain contributions or debug counters); the dev record reports firing rates.
- Payload guard: records capped per call; $/task and tool-result tokens are dev guard metrics; a deterministic test shows `newer_mentions` still packs under the default `context_pack` budget with records present.
- The entity-scoped exact-term lane is the fallback dev arm if F1 and F2 do not fire or do not move H4.
- README states that the Hard confirmation is a different workload and never implies the v1 comparison was remeasured.
- Part 3 step 1 branches after the security PR, reuses its visibility predicate, is tested on both engines for the plain refusal, is listed under behavior changes with a named consumer, and is documented as covering the exact normalized claim only.
- M development results are labeled in-sample and diagnostic.
- Baseline arm is the wave's merge base (master after the security PR); confirmation runs on the branch build before merge; component retention is frozen on development data.
- Preregistration freezes exact wrong-answer denominators, a paired wave-vs-baseline test with a minimum effect, H4 stratified by `+long`, per-model results with Sol's ceiling called out, and abstention / non-submission reported with correctness.
- `bun scripts/model-freshness.ts` runs before preregistration and its output is recorded.
- Confirmation cost is ~$1,450–1,700 (baseline arm +~$350, +33%).
<!-- /autoplan-accepted:ceo -->

### DX review (Phase 2.5)

Scope: DX enabled by `--agent-primary` (agents read every tool result) plus 3 developer-facing term matches. Persona: a frontier agent over remote MCP reading lean rows; secondary persona: the human integrator enabling records on their own brain and reading the benchmark claims. Mode POLISH (native lane's recommendation, auto-chosen).

**Consensus (DX).** Both voices completed. The binder's line-level reconciliation found 0 confirmed, 0 disagreements, 5 outside-only and 15 native-only findings. Semantically, four of the five outside findings match native ones: enrollment contract (outside DX1 ≈ native DX3), one continuation shape (outside DX3 ≈ native DX4), capped or incomplete lists must not read as empty (outside DX4 ≈ native DX13), and Part 3's typed refusal object on every surface (outside DX5 ≈ native DX8). Outside DX2 (F2 inert on default non-conversation searches) is new and is the strongest outside finding; native DX12 touches its off switch only. No voice disagreed with another.

| Dimension | Claude (Opus 5.5) | GPT-6.1 Sol | Consensus |
|---|---|---|---|
| Getting started (agent's first useful call) | 4/10: `names` rows carry nothing | F2 inert on default calls | CONFIRMED gap |
| API ergonomics | 4/10: four continuation shapes | continuation must preserve membership | CONFIRMED |
| Errors and refusals | 5/10: Part 3 detail has no location | typed additive object on every transport | CONFIRMED |
| Documentation | 3/10: protocol docs, schemas, spec missing | enrollment example missing | CONFIRMED |
| Upgrade path | 5/10: referenced_by parity at risk | — | native only |
| Dev environment (benchmark loop) | 5/10: transcript-capped token metrics | — | native only |
| Community | 6/10 | — | native only |
| DX measurement | 6/10: guard measures `text`, not `cards[]` | incomplete index shows false totals | CONFIRMED (different gaps) |

**DX scorecard (native).** Getting Started 4→6, API 4→7, Errors 5→7, Docs 3→7, Upgrade 5→7, Dev Environment 5→7, Community 6→7, Measurement 6→8. Overall 4.8/10 → 7.0/10 if the accepted amendments land. TTHW (agent, H4 median on M): 18 calls, 8 turns, 263,173 result characters; target fs-parity correctness at no more than today's calls and characters. TTHW (integrator): unknown today; target one documented pack line plus one read-only check command.

**Developer journey map.**

```
STAGE        | AGENT / INTEGRATOR DOES                       | FRICTION                                              | STATUS
1 Discover   | reads tool schemas + served instructions      | instruction 7: batch via `names`, then "walk           | d5, d6
             |                                               | referenced_by" (absent there); "prefer the newest"     |
2 Install    | integrator wants records on contract pages    | no pack field names record types; no "amends" field   | accepted (enrollment)
3 First call | `entity` names / `context_pack`               | no records, no continuation; backlink_count 0 beside  | uc1, d5, accepted
             |                                               | 17 referrers                                           |
4 Real use   | search, get_backlinks, get_page               | four continuation shapes; long page not signaled      | accepted, d3
5 Debug      | `remember` refused after `forget`             | sub-cause only in a message prefix                    | accepted (typed object)
6 Upgrade    | reads MEMORY_VERBS, schemas, README claims    | docs, schemas, README sentences not in the ship list  | accepted
```

**Empathy narrative (observed, one lost Sonnet H4 cell on M).** The agent batched three account names with `entity` `names` as the served instructions advise and got a CRM record and an account sheet each, with no sign that contracts exist. Its next search returned a 40,000-plus-character result in which one long amendment appeared as a boilerplate chunk, with nothing on the row saying the page was long or partly shown. It concluded the amendments did not touch the asked term and answered the contract's original value. It handled the "later effective wins" and "not yet effective" items correctly by reading body dates itself.

**NOT in scope (DX).** Hoisting per-row constants (`trust_tier`, `origin`, `source_id`, 8.6% of M result characters) into a response header; removing the `cards[]`/`text` duplication in `context_pack`; a `get_page` range or in-page search parameter; `search` `since`/`until` parity; better unknown-parameter suggestions (native DX14). All are follow-up candidates, none is written to TODOS.md by this run.

**What already exists (DX).** `referenced_by` groups with an executable `next`; evidence delivery's `delivered` object and the snippet marker that names the `get_page` recovery; the `supersedes` link type and frontmatter mapping rules (`gbrain-base-v2.yaml:400`, `company-brain.yaml:173-175`); the lean-row allowlist; verb output schemas and conformance fixtures; the agent error envelope's `reason`/`detail`/`fix` slots; `date-labels.ts` wording that a page date is never a contract's validity date.

**DX implementation checklist.** Enrollment declaration + example + read-only check; records as an extra view with `referenced_by` parity; one executable continuation shape with exact-remainder paging; capped/undeclared/degraded states visible; F2 activation on default non-conversation searches with budget accounting and a named off switch; payload guard on serialized results; Part 3 typed refusal object on three surfaces; protocol docs, schemas, fixtures, errors row, llms.txt in the ship list; README sentence-by-sentence dispositions.

<!-- autoplan-accepted:dx -->
- F1 reads a documented pack-level record-type declaration (empty by default, F1 off when absent); "amends" is the existing `supersedes` link via a frontmatter mapping rule, never a body parser; a copy-paste pack example, a generic Markdown example with expected output, and a read-only check ship with it; unrecognized types stay in ordinary references; the benchmark world opts in through the same declaration before dev cells, and F1's benchmark points are attributed to that opt-in.
- Records are an additional view; `referenced_by` membership and `get_backlinks` parity are unchanged; record rows reuse the `referenced_by` row shape without previews or per-row constants.
- One continuation shape: the card's executable `next {tool, arguments, requires_surface?}`; exact-remainder paging across record types (`types[]` on `get_backlinks` or one `next` per type); capped lists keep `total` + `next` + reason; undeclared types say so; coverage/degraded notices propagate.
- In `context_pack`, F1 uses `referenced_by_count` or no count, and `backlink_count`'s description says what it excludes.
- F2 activates on ordinary remote searches over non-conversation pages without widening unrelated pages; `snippet_chars`/`token_budget` precedence is specified; passages count in the delivery budget; firing is reported via `delivered` and the snippet marker; a named `search.*` key and default are documented; `return_unit: "chunk"` stays byte-identical; tests assert on serialized lean MCP output.
- The payload guard uses serialized tool-result characters from attempts `chars`; notice characters are reported separately and notice state is identical across arms; the per-call record cap is a stated number.
- Part 3's refusal detail is one additive typed object (not named "scope") on the immediate refusal, batch item error and failed receipt, through every transport; the legacy prefix is unchanged; absence carries no meaning; stdio/HTTP/CLI JSON tests.
- The gbrain PR lists MEMORY_VERBS sections, output schemas, conformance fixtures, the evidence-delivery spec change, the errors row and llms.txt regeneration.
- Every sentence of README.md:141-148 and row 72 gets a disposition, including the per-task cost sentence; the new Hard row states workload, models, reranker state and per-model cost.
<!-- /autoplan-accepted:dx -->

### Eng review (Phase 3, last)

`PLAN_REALITY: phase=eng rows=7/7 missing=none unverified=3 verdict=complete` (unverified: dev-world figures, the outside voice's 9-of-12 probe, the 168/167 reranked counts, which are published aggregates). Scope accepted as-is; the native lane's smaller arrangement is pending through the gate items.

**Consensus (Eng).** Both voices completed. The binder's line-level reconciliation found 0 confirmed, 0 disagreements, 6 outside-only and 18 native-only findings. Semantically, three outside findings match native ones: amendments as `supersedes` trigger whole-page down-ranking (outside E1 ≈ native E1), the enrollment key cannot load on the baseline (outside E2 ≈ native E2), and F2's default activation must not leak into other surfaces (outside E6 ≈ native E4/E7 in spirit). Outside-only: referrer caps can starve records (E3), F2 input work is unbounded (E4), canonical alias mismatch (E5). Native-only: world-bytes opt-in invalidates recorded fs cells (E3), firing signal stripped by lean rows and head-cut by `snippet_chars` (E5), keyword queries without term words (E6), push path (E7), N+1 on names (E8), zero text budget headroom (E9), per-item config keys (E10), Part 3 receipt and second refusal site (E11), security PR already merged (E12), Part 3 out of the eval-gated PR (E13, gate d7), master-drift rule (E14), names-mode read-option parity (E15, urgent, outside this plan), `types[]` vs per-type `next` (E16), Opus $0.86 (E17), records ORDER BY (E18). No disagreements.

| Dimension | Claude (Opus 5.5) | GPT-6.1 Sol | Consensus |
|---|---|---|---|
| Architecture sound? | no: amends-as-supersedes, strict manifest, push path | no: amends-as-supersedes, strict manifest | CONFIRMED |
| Edge cases covered? | no: keyword queries, snippet head-cut, multi-row ledger | no: cap starvation, alias mismatch | CONFIRMED (different gaps) |
| Tests sufficient? | 9 of 38 paths tested, 29 gaps | final serialized output tests needed | CONFIRMED |
| Security? | names-mode read-option parity (urgent, not owned) | no new surface beyond F2 input bounds | native only (urgent) |
| Hidden complexity? | world-bytes opt-in reruns fs; budgets at zero headroom | F2 whole-page input work | CONFIRMED |
| Performance? | N+1 on 50-name batches | unbounded page fetch | CONFIRMED |

**Architecture (after amendments).**

```
 agent (remote MCP, lean rows)
   |-- entity names:[..] --> one batched referrer query (enrolled types only, cap before hydrate)
   |                          -> per row: records (page date + source, status, amends link) + total + next per type
   |-- entity name -------> full card: referenced_by unchanged (+ records view)
   |-- context_pack (pull) -> cards + newer_mentions, then records last (pull verb only)
   |   ambient push path ---> unchanged (600 ms deadline)
   |-- search -------------> hybrid / keyword ranking (no new supersedes links from amendments)
   |                          -> evidenceOutput: F2 policy resolved at the search caller, config key default off
   |                          -> passage leads delivered text; delivered {unit, reason} kept in lean rows
   |-- remember -----------> refusal (+ typed withdrawn object on refusal, batch item, receipt; both refusal sites)
 pack: "amends" link type (non-ranking) via frontmatter mapping; record types via per-arm config key
 harness: per-item config arms on one build; world opt-in config-only, or new digests + fs rerun if bytes change
```

**Codepath-to-test map (native, abridged).** Tested today: referrer privacy, cursor and groups; `names` resolve/miss/siblings; `newer_mentions` packing; evidence-delivery chunk/implied-auto goldens and protected-body sanitizing; schema budgets; instruction content; refuse-before-accept and the #6509 visibility predicate. Gaps that become required proof: records or count + `next` on names rows on both engines; exact-remainder continuation; 50-name cap and perf; undeclared vs empty; draft status on rows; amends link with no ranking change (critical); push output unchanged (critical); records packing order under budgets 1500/2000; F2 on-path golden, keyword name-only no-fire, `snippet_chars` 300 survival, lean firing signal, recurring-term fixture; Part 3 multi-row ledger, second site, receipt persistence, identical stdio/HTTP/CLI object; generator version and digest record with fs rerun (critical); per-item config arms. Coverage today 9 of 38 paths. Test plan on disk: `~/.gstack/projects/garrytan-gbrain-evals/user-plan-cat40-next-wave-eng-review-test-plan-20261012-013719.md` (machine-local; this section is its durable summary).

**NOT in scope (Eng).** Turn-cap changes; model-specific prompting; owner-phrase resolution; `restore: true`; the v1 rerun (Part 2 alternative); a body parser for "Effective X, the Y change to Z" (fixture-shaped); fixing names-mode read-option parity (security follow-up owner).

**What already exists (Eng).** Referrer CTE and continuation shape; evidence delivery and budgets; lean projection; pack `frontmatter_links`; per-arm config and description overrides in the harness (`eval/runner/cat40/gbrain-arm.ts`); the merged withdrawal visibility predicate (#6509); `OperationError` additive fields. Deliberately not reused: `supersedes` for amendments.

**Failure modes registry (Eng).**

| New path | Failure | Planned handling | User sees |
|---|---|---|---|
| amends as `supersedes` | governing contract halved in search | replaced by a non-ranking link (accepted) | was silent wrong answer: critical gap, now closed by amendment |
| enrollment as strict pack key | baseline cannot load the pack | config key per arm (accepted) | — |
| world opt-in bytes | fs cells compared against another digest | new digests + fs rerun (accepted) | was silent invalid comparison: critical gap, now closed by amendment |
| records in shared assembler | push hook misses its deadline | pull verb only (accepted) | — |
| records on names rows | 100k-character or slow batch | batched query, stated cap, perf test (accepted) | — |
| F2 + `snippet_chars` | passage cut away, firing invisible | passage leads; lean `delivered` (accepted) | — |
| F2 default change | every long-page search changes shape | default off, two goldens (accepted) | — |
| Part 3 second site | detail without visibility check | same predicate at both sites (accepted) | — |
| text budgets | budget test fails | name the cut or record a raise (accepted) | CI |

**URGENT, outside this plan.** One native finding (Eng E15) concerns read-option parity between compact `entity names` rows and the single card. It belongs to the security follow-up owner of #6509; details are withheld here.

**Completion summary (Eng).** 24 findings across both voices (9 High, 12 Medium, 2 Low, 1 Informational); 2 critical gaps in the registry, both closed by accepted amendments; 29 test gaps listed as required proof; 2 direction changes to the gate (d7, d8); the plan's security prerequisite has already merged.

<!-- autoplan-accepted:eng -->
- Replacement of the DX clause "\"amends\" is the existing `supersedes` link": amends is a separate non-ranking link type declared in the pack and fed by a frontmatter mapping rule; `supersedes` stays for whole-record replacement; tests cover unchanged terms, future-effective amendments and genuine replacement through final search scores and labels.
- Record-type enrollment is a per-arm config key (ignored by older builds); the pack carries only the link mapping; baseline- and wave-compatible pack variants are frozen, proven identical apart from the declaration, and hashed before paid cells; enrollment and relationship rules agree on canonical aliases.
- Records are filtered by enrolled type inside the shared membership query before ORDER BY/LIMIT/hydration, with record-only totals and keysets; names rows use one batched multi-target query; the per-call cap is enforced before hydration and stated (5 per name, or all when an entity has 5 or fewer, and 24 per call; a cap of 3 would hide the governing record in 2 of 70 M H4 items); a names-mode perf test exists; records have an explicit ORDER BY and cursor; continuation is one executable `next` per record type.
- Records are computed only in the `context_pack` pull verb; a test pins the ambient push output unchanged.
- Before compact rows carry records, the security follow-up owner confirms names-mode read-option parity with the single card; F1 names tests include such an entity.
- F2 is behind its own `search.*` config key, default off until confirmation; golden `evidence-delivery-golden.test.ts:78` stays as the off-path contract; a frozen on-path golden is added; activation is resolved at the search/query caller so recall, think and `assemble_evidence` stay byte-identical.
- The F2 passage leads the delivered text; lean rows carry compact `delivered {unit, reason}` when F2 fired; F2 has candidate-page, input-byte and deadline limits with a size preflight and bounded batched fetch; F2 adds no text when the query names no term; dev results are stratified by match mode and term presence.
- Every instruction or description text change names the cut that pays for it or records a budget raise per `test/mcp-schema-budget.test.ts`.
- Each F-item has its own config key and documented default; dev arms run on one build via per-arm config and description overrides.
- Part 3 detail reads only `fact_withdrawals`, with a deterministic row rule; persists in the write receipt outcome; the commit-time refusal site applies the same predicate; Part 3 step 1 can start now (#6509 merged).
- Baseline merge base is at or after `2895edb3` (v0.60.176.0).
- Any opt-in that changes document bytes bumps the generator version, records new digests and reruns fs on changed dev worlds; config-only opt-ins keep recorded fs cells.
- The preregistration records the measured SHA and path set; a later master merge touching a measured path needs a written no-effect argument or re-confirmation.
- Opus gbrain cost on M is $0.86 per task.
- Development cost becomes about $750–1,200 if document bytes change (fs rerun); otherwise $600–900.
<!-- /autoplan-accepted:eng -->

### Final approval gate (gate_rev 1, answered 2026-10-12)

The first pass ended `status=gate_pending`; the table below is the gate as presented. Reply grammar: `all`, `<id><option>` tokens (for example `uc1b uc2b`), or `all except <tokens>`; bare yes/no is rejected. Approval items (uc1, uc2, p1) stay pending until answered; auto items (d1–d8) take option a if unanswered.

| Id | Kind | Item | a | b | Native (Opus 5.5) | Outside (GPT-6.1 Sol) |
|---|---|---|---|---|---|---|
| uc1 | approval | F1 placement: compact `names` rows and `context_pack`, built from the existing referrer path, instead of a new section on the full card | keep the plan as reviewed | accept the change both reviewers recommend | b | b |
| uc2 | approval | F3: drop the automatic not-binding inference and heuristics; propagate existing `status`/trust fields plus a documented `status: draft\|unsigned` convention | keep | accept | b | b |
| d1 | auto | Part 2: keep the 0-of-100 permission result when retiring the v1 row | keep | accept | b | not raised |
| d2 | auto | F1 ordering by page date cannot express which record governs; add a validity contract or narrow F1 to candidate evidence | keep | accept | b in substance (rated it Critical; fix: label page dates, no governance by order, optional documented validity key) | b |
| d3 | auto | F2: compare existing delivery units at a fixed budget before committing to a lexical passage picker | keep | accept | b in substance (build F2 inside evidence delivery) | b |
| d4 | auto | Add a zero-provider transfer and negative-control gate before paid dev | keep | accept | partly (label M in-sample, decide on an unseen dev seed) | b |
| d5 | auto | Records or a `next` on compact rows, and fix instruction 7's walk advice | keep | accept | b | not raised |
| d6 | auto | Replace F4's two new description sentences with one general edit to served instruction 7 | keep | accept | b | not raised |
| d7 | auto | Ship Part 3 step 1 in the next batched gbrain wave PR, not the eval-gated Part 1 PR | keep | accept | b | not raised |
| d8 | auto | Do not map amendments to `supersedes` | keep | accept | b in substance (Eng E1, High) | b |
| p1 | approval | Plan approval | a approve as-is · b approve with the overrides above · c interrogate · d revise (every phase reruns, Eng last) · e reject | | — | — |

Note on defaults: the tool's default for every d item is "keep your direction". For d2 and d8 both voices found a factual defect (rated Critical and High), and the accepted amendments already fix d8's mechanism and add page-date labeling for d2. Answering d2a keeps the drafted "newest effective first" ordering.

### Gate answer (gate_rev 1)

Garry gave the answer, relayed through GBRA-40 on 2026-10-12 ("Approve all" with the coordinator's picks): `uc1b uc2b d1b d2b d3b d4b d5b d6b d7b d8a p1b`. `gstack-autoplan answer --gate-rev 1` recorded it and printed `REOPENED: ceo,dx,eng (Eng last) reason=uc1b,uc2b,d1b,d2b,d3b,d4b,d5b,d6b,d7b`. The first-pass voice results and consensus files are archived in the run directory as `*.r1.*`. The decided changes were folded into the Implementation plan (F1–F4 rewritten to the decided direction, Part 2 and Part 3 decisions, development gate, budgets, shipping split, and a decisions table replacing the pending table) before the reruns. Budget decisions: development about $900, up to $1,200 if document bytes change and fs must be rerun; confirmation about $1,700 with a baseline arm. Part 2: retire the v1 success headline with no rerun, keeping the 0-of-100 permission result. Part 3: step 1 ships standalone.

### CEO review rerun (after the gate)

Voices: native anthropic/claude-opus-5-5 (attempt a7) and outside openai/gpt-6.1-sol (attempt a8), both dispatched as host subagents with the gate answer marked settled. Result: `PHASE_CLOSED: ceo confirmed=3 disagree=0 new=0 native_only=19 coverage=both`; `PLAN_REALITY: phase=ceo rows=7/7 missing=none unverified=3 verdict=complete`. Native 22 findings (6 High, 12 Medium, 3 Low, 1 Informational), outside 3 (2 High, 1 Medium). No user challenges: every change fits inside a settled decision. Evidence was static reads of gbrain `2895edb3` and gbrain-evals `7b40baa2` plus a free re-derivation from World M; no model eval ran and nothing was spent.

The tool's reconciliation pairs findings mechanically; by topic the three outside findings match native findings as follows: ranking participation of the amends link (outside 1, native 1), per-arm config keys versus the run-wide `--gbrain-config` channel and `config set` rejecting unknown keys (outside 2, native 7), and the transfer gate not exercising F2 delivery through `search` (outside 3, native 5). All 25 findings were accepted and folded into the Implementation plan as "Accepted (CEO rerun …)" lines or in-place edits:

- Amends follows the existing temporal-edge vocabulary (`amends: [{name, since}]`), takes no part in ranking under an explicit link-type policy with a final-score invariance test, uses the caller's reference date for any validity status, and names its re-extraction command (native 1, 17; outside 1).
- d5b's floor holds on every brain: `referenced_by_count` and `next` on every found `names` row, records only when enrolled; the instruction clause follows the callable surface (native 2). Records failures show an unavailable marker, and `context_pack` records get the hidden-referrer fixture (native 16, 18). The per-name cap starts at 5 because 3 would hide the governing record in 2 of 70 M H4 items (native 10).
- Development: per-item config arms on H2–H4 plus an all-on guard run, fs rerun costed at about $297 on M, one build-vs-build pair only (native 3, 9). Executable config recipes, no wave keys on baseline runs, and the claim tied to the preregistered configuration (native 4, 7; outside 2).
- Transfer gate: pages authored and frozen by someone other than the implementer, `search`/`query` lean output with F2 on and off, a pass rule written first (native 5; outside 3).
- F2's comparison is a free frozen-hit step then a paid `search.return_unit` step with a decision rule written first, must beat the recorded lexical-selector result, and defines "the query names no term" generically (native 12, 13).
- F4 gives the full replacement sentence and removes the "later … outranks" clause (native 11). Part 2's kept row states its build and surfaces (native 15). Part 3's carrier is GBRA-40's next batched wave PR, owned by GBRA-39 (native 19). Owner-phrase resolution gets a tracked TODO (native 21).
- Stale text outside the Implementation section (Status, ELI10, kill-criterion baseline), leftover DX clauses, the F1 validity key, and unbalanced parentheses were corrected (native 8, 14, 20). The expected-effect paragraph now says config-only worlds get no benchmark points from amends, validity dates or `status`, and that the measurable effect is Sonnet and Opus on `names` rows (native 6, 22).

Open owner call (native 6): whether development and confirmation worlds stay config-only (the plan's default, keeping recorded fs cells and comparability with #93) or write the documented keys as a new generator version with an fs rerun inside the $1,200 ceiling. The plan proceeds on the default unless Garry picks the other before the first dev cell.

### DX review rerun (after the gate)

Voices: native anthropic/claude-opus-5-5 (attempt a9) and outside openai/gpt-6.1-sol (attempt a10), host subagents, gate answer marked settled. Result: `PHASE_CLOSED: dx confirmed=0 disagree=0 new=2 native_only=13 coverage=both`. Native 13 findings (4 High, 7 Medium, 1 Low, 1 Informational), outside 2 (Medium). No user challenges. The native voice read gbrain at `0460af28` (v0.60.178.0; master moved during the run) and recomputed World M counts from local cells; no model eval ran.

By topic the outside findings overlap native ones: amends temporal declaration and the reference-date contract (outside DX1, native DXR-1/2), and document status colliding with the temporal relationship `status` already on link rows (outside DX2, native DXR-4). All 15 were accepted and folded:

- Amends is `temporal: event`, F1 shows only the recorded `since` and the page date and computes no status, and future-dated amends edges stay visible under a frozen-clock test (DXR-1, DXR-2, DX1). This replaces the CEO rerun's "status on the caller's reference date", because no F1 surface takes a date.
- The record row is specified exactly and sparsely, with `page_status` as a new additive field so the existing relationship `status` and its filter stay intact (DXR-4, DX2). Page-date labeling lives in the payload, not in field descriptions agents never see (DXR-3).
- Names-row count and `next` sit behind a default-on key, fail with an unavailable marker, and follow a deterministic cap rule; the instructions clause follows enrollment state (DXR-5–8). Every config key, the check command and the homes of the amends mapping and non-ranking default are named, with version gating (DXR-9).
- Part 3's refusal gets canonical code `fact_withdrawn`, an error-registry entry and `fix.next`, `subject` plus `all_entities`, and read-time visibility on receipts (DXR-10). The shipping list adds the MEMORY_VERBS names-row paragraph and `BEHAVIOR_CHANGES` rows (DXR-11).
- F2's passage clauses apply only if a passage rule is built, and the paid unit step runs on the wave build with the F2 key (DXR-12). The names-mode read-option precondition cites #6528 (`0460af28`) for the security owner to confirm (DXR-13).

### Eng review rerun (Phase 3, last, after the gate)

Voices: native anthropic/claude-opus-5-5 (attempt a11) and outside openai/gpt-6.1-sol (attempt a12), host subagents, gate answer marked settled, product code read at gbrain `0460af28` (v0.60.178.0). Result: `PHASE_CLOSED: eng confirmed=1 disagree=0 new=4 native_only=17 coverage=both`. Native 18 findings (2 High, 11 Medium, 4 Low, 1 Informational), outside 5 (1 High, 4 Medium). The native voice wrote its test plan to `~/.gstack/projects/garrytan-gbrain-evals/user-plan-cat40-next-wave-eng-review-test-plan-20261012-155446.md`, which replaces the first-pass one. `PLAN_REALITY: phase=eng rows=5/7 missing=none unreceipted=premise-table,numbers verdict=incomplete`: the native lane wrote its reality rows by hand because the helper sits under a path reviewers are told not to read, and two rows lack file:line receipts. The World M numbers behind them (24 and 51 of 70, 8 of 13, 21 of 70, the $723 round) were recomputed by that lane from local cells with its scripts in `~/.capy/work/autoplan/eng-rerun/`; they are not independently re-derived by the parent. No model eval ran.

The 21 findings that are not user challenges were accepted and folded as "Accepted (Eng rerun …)" lines or in-place edits:

- F1 lists records for the found page and each identity sibling side by side (24 → 51 of 70 H4 items reachable on M), reads `since` under the caller's scope, makes `amends` a list with exact name matching, uses one metadata projection for the first view and continuations, ties `page_status` on records to F1, bounds `page_status`, adds a deadline and a batched-read parity test, and names every link-counting ranking consumer (native E1, E4–E6, E12–E14, E16, E18; outside F2–F4).
- Instructions: d5b's brief clause ships with F1's names-row fields, separate from F4; the budget test covers the maximal and per-arm renderings and records the F4 sentence offset against the 2,048-character cut (E7, E8).
- Development adds a same-build all-off control, a preregistered cost table (one full M round about $723), and a draft-first harm metric (E9, E10). F2 gets one unit-precedence table, and its no-term veto is limited to a passage selector (E15; outside F5).
- Part 3 preserves every post-security refusal classification and adds the withdrawn detail only to the eligible branch (outside F1). The full card's failure marker gets a `BEHAVIOR_CHANGES` row (E11). #6528 meets the names-mode read-option precondition by static read and the baseline is pinned at or after `0460af28`; owner-phrase resolution cites the existing P1 TODO (E17).
- The expected-effect paragraph now states F1's reach on M and that, with owner-phrase resolution deferred, F1 can reach at most 5 of the 13 H4 items gbrain missed in cells fs won.

Two native findings were raised as user challenges and are not folded. They form gate rev 2: d1 (native E2) asks whether to pull owner-phrase resolution (gbrain `TODOS.md:7`) into this wave as its own config-gated item; d2 (native E3) asks whether to drop the amends liveness exemption the DX rerun added, since F1's referrer path applies no temporal filter. The plan text keeps the current direction on both until Garry answers.

### Final approval gate (gate_rev 2, answered 2026-10-12)

`GSTACK_RESULT: skill=autoplan status=gate_pending`. Rendered verbatim:

```text
GATE: run=plan-cat40-next-wave-20261012-010042-20261012010053 gate_rev=2 items=3 page=1/1 — /autoplan final approval gate

1. [d1] Owner-phrase documents are linked to no account page and hold 8 of the 13 H4 items gbrain missed in fs-won cells (6 never seen); the deferral bounds F1 more than anything in the plan [plan-cat40-next-wave-20261012-010042-20261012010053-eng-native-2] (auto; recommended: a; from eng)
   one voice (native) recommends changing your stated direction
   d1a) keep your direction (recommended)
   d1b) accept the change
   cost: b reopens eng
2. [d2] Amends liveness exemption is unnecessary for F1 (referrer path has no temporal filter; card edges read status all) and turns the one shared liveness predicate into a per-type special case [plan-cat40-next-wave-20261012-010042-20261012010053-eng-native-3] (auto; recommended: a; from eng)
   one voice (native) recommends changing your stated direction
   d2a) keep your direction (recommended)
   d2b) accept the change
   cost: b reopens eng
3. [p1] Plan approval (approval; recommended: a)
   p1a) approve as-is (recommended)
   p1b) approve with the overrides above
   p1c) interrogate (ask questions; stays pending)
   p1d) revise the plan (every phase reruns, Eng last)
   p1e) reject

Reply with exactly one of: `all` · `<id><option>` tokens, e.g. `d1b d2b` · `all except <tokens>`.
Items marked auto take their recommendation if unanswered; approval items stay pending until answered. Bare yes/no is not accepted.
Reply binds to gate_rev=2. `all` resolves to: {"gate_rev":2,"choices":{"d1":"a","d2":"a","p1":"a"}}
```

### Gate answer (gate_rev 2)

Garry answered on 2026-10-12, relayed through GBRA-40. His words, verbatim: "Double the budget let's be comprehensive". GBRA-40's reading of them: pull owner-phrase resolution into the wave (d1b), keep the amends liveness exemption as written (d2a), and approve with those overrides (p1b); development doubles to about $1,800 (up to $2,400 if documents change) and confirmation to about $3,400 with the baseline arm; use the room on two or more full development rounds, the per-item arms and an owner-phrase arm; choose how to spend the extra confirmation money by interval width with a cost table; models stay the newest per family (Opus 5.5, Sonnet 5.5, GPT-6.1 Sol), no Fable in counted cells; worlds stay config-only by default. GBRA-40 also relayed that a separate check independently confirmed the motivating numbers (8 of 13 missed fs-won H4 items are owner-phrase only; F1 reaches 5 of 13 without the fix) and that the $723 figure's parts reproduce but its total needs an arm list.

`gstack-autoplan answer --gate-rev 2 --reply "d1b d2a p1b"` exited 0 and printed `REOPENED: eng (Eng last) reason=d1b`. Folded before the Eng rerun: F5 (owner-phrase resolution with validity windows, with the TODO's gate and a Wilson 95% lower-bound precision bar of 0.85 on a labeled real-brain sample run on Garry's Mac through GBRA-40), the development schedule and arm-by-arm cost table ($1,749.27 all-in, judge included), the $723 reconciliation, the confirmation options table and choice (40 tasks per family, about $2,830), the doubled budgets, and the decisions table.

Known tool defect: on a second gate, gstack 1.91.92.0 keeps the gate rev 1 rows in `decisions.jsonl` and appends gate rev 2 rows with the same ids (`${run}-d1`, `-d2`, `-p1`; `lib/gate-list.ts:148`), so `gstack-artifact validate` reports `ARTIFACT_DUPLICATE_ID`. Answering is unaffected because `applyReply` only touches rows of the answered gate rev. The run directory is not hand-edited around it; the fix belongs in gstack. After gate rev 3 the same defect reports 5 duplicates (d1 and p1 repeated across gate revs 1–3, d2 across revs 1–2): `ARTIFACT_INVALID: 5 error(s)`, all `ARTIFACT_DUPLICATE_ID`, no other error.

### Eng review rerun 2 (after gate rev 2, larger scope)

Voices: native anthropic/claude-opus-5-5 (attempt a13) and outside openai/gpt-6.1-sol (attempt a14), host subagents, gate rev 1 and rev 2 answers marked settled, product code read at gbrain `0460af28`. Result: `PHASE_CLOSED: eng confirmed=0 disagree=0 new=9 native_only=16 coverage=both`; `PLAN_REALITY: phase=eng rows=7/7 missing=none unverified=2 verdict=complete` (the two unverified rows are the sealed world's per-arm cost split and whether the sealed generator takes `tasks_per_family`, which the reviewers may not read). Native 16 findings (4 High, 7 Medium, 4 Low, 1 Informational), outside 9 (3 High, 4 Medium, 2 Low). Native test plan: `~/.gstack/projects/garrytan-gbrain-evals/user-plan-cat40-next-wave-eng-review-test-plan-20261012-163319.md`. The native voice reproduced the development table, the confirmation table, #93's [+2.7, +12.7] interval and the 8-of-13 and 6-never-seen owner-phrase numbers from the recorded cells. The parent re-checked the code receipts (`src/schema.sql:527`, `src/core/extract-ner.ts:6-11`, `src/core/mentions/referrers.ts:102`) and the ledger receipts ($419.27 + $112.68 = $531.96; slot build $13.68; oracle $26.70). No model eval ran.

The tool pairs nothing as confirmed, but by topic the outside findings overlap native ones: resolution contract (outside F1, native E6), invalidation (outside F2, native E6), build-time activation (outside F3, native E2), surfaces (outside F4, native E12), ranking (outside F5, native E1), precision procedure (outside F6, native E14), confirmation reserve (outside F7, native E8) and the stale $1,200 ceiling (outside F9, native E13). All 24 findings that are not user challenges were folded:

- F5 is stored as mentions with `link_kind='owner_phrase'` through a CHECK migration, so it stays out of ranking readers; it is activated at build time with F5-off and F5-on slot families and a zero-link refusal; its resolution contract, windowed storage, invalidation, visibility over every evidence page, bounded surfaces, performance tests and a frozen precision-sampling procedure (fewer than 22 links keeps F5 off) are specified before implementation (native E1, E2, E6, E7, E12, E14, E16; outside F1–F6).
- F5's generality is checked by ownership pages added to the d4b transfer set, because M's ownership text is four templates with no ambiguous phrase; the d1b gate becomes paired tests with a minimum effect and a per-family margin, measured from full-result slug sets, with H1–H3 strata (native E3, E4, E5, E15).
- The development table is repriced at #93's ledger rate (1.108) with slot builds: $1,777.15, with per-arm caps and a stop rule; the per-item F1, F2 and F4 arms now run once and the three full-family arms twice (native E8).
- The confirmation choice stays Option B, priced at about $3,190 with slot builds; the reserve covers retries only and a voided arm escalates; widths are labeled forecasts with their formula and repeat-data sources; the 40-task worlds are declared different worlds with validation, mix reporting and custody confirmation (native E8, E9; outside F7, F8).
- F5 joins the preregistration key list, the shipping docs list, the Part 1 framing and the expected-effect paragraph; stale text was fixed ($1,200 ceiling, $301 fs rerun, `referrers.ts` path, merge-base pair scoped to confirmation) (native E10, E13; outside F9).

One native finding was raised as a user challenge and is not folded: E11, ship F5 as its own PR stacked on Part 1, with Part 1 merging alone if F5 fails its gate (F5 brings a migration, a mention-pass change and its own gate; cost: one more merge slot and gate). F5 stays in the wave either way. Gate rev 3 kept one Part 1 PR (see below).

### Final approval gate (gate_rev 3, answered 2026-10-12)

`GSTACK_RESULT: skill=autoplan status=gate_pending`. Rendered verbatim:

```text
GATE: run=plan-cat40-next-wave-20261012-010042-20261012010053 gate_rev=3 items=2 page=1/1 — /autoplan final approval gate

1. [d1] Ship F5 as its own PR stacked on Part 1 with a stated fallback [plan-cat40-next-wave-20261012-010042-20261012010053-eng-native-11] (auto; recommended: a; from eng)
   one voice (native) recommends changing your stated direction
   d1a) keep your direction (recommended)
   d1b) accept the change
   cost: b reopens eng
2. [p1] Plan approval (approval; recommended: a)
   p1a) approve as-is (recommended)
   p1b) approve with the overrides above
   p1c) interrogate (ask questions; stays pending)
   p1d) revise the plan (every phase reruns, Eng last)
   p1e) reject

Reply with exactly one of: `all` · `<id><option>` tokens, e.g. `d1b p1b` · `all except <tokens>`.
Items marked auto take their recommendation if unanswered; approval items stay pending until answered. Bare yes/no is not accepted.
Reply binds to gate_rev=3. `all` resolves to: {"gate_rev":3,"choices":{"d1":"a","p1":"a"}}
```

### Gate answer (gate_rev 3)

Gate rev 3 answered by GBRA-39 (the coordinating agent), not Garry, under his standing instruction to proceed without asking on non-product decisions; Garry approved the plan direction at revs 1–2 and can override.

Reply: `all` (d1a, p1a). `gstack-autoplan answer --gate-rev 3 --reply "all"` exited 0 and printed `APPROVED: gate_rev=3 as-is` and `GSTACK_RESULT: skill=autoplan status=complete`. The question was packaging only: F5 stays in the wave and inside the one Part 1 PR, and the plan now states the fallback under F5 (F5's commits come out of the Part 1 branch before merge if it fails its gate or precision bar). No phase reopened.

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|----------|
| 1 | CEO | Correct the "all 22 are class (a)" wording to items vs cells | Mechanical | P1 | Re-derived output shows 18 pure-(a) cells of 22 | leave as is |
| 2 | CEO | Hold F1's effective-first ordering for the gate (d2) and add a page-date labeling requirement now | Mechanical (requirement) + gate | P1 | Both voices: ordering by signed date points at the wrong record | silently rewriting F1's ordering |
| 3 | CEO | F1 placement (compact rows, context_pack, reuse referenced_by) to the gate as uc1 | User Challenge | — | Both voices flagged it as a direction change | auto-deciding |
| 4 | CEO | F2 mechanism to the gate as d3; accept lean-row, recurring-term fixture and Sonnet harm check now | Taste + Mechanical | P4, P1 | Evidence delivery exists; benchmark boilerplate has no term words | parallel passage picker without guards |
| 5 | CEO | F3 scope to the gate as uc2 | User Challenge | — | Both voices flagged it as a direction change | auto-deciding |
| 6 | CEO | Firing counters for every new stage | Mechanical | P1 | Null dev results are unreadable without them | — |
| 7 | CEO | Payload guard and newer_mentions packing test | Mechanical | P2 | context_pack budget is shared | — |
| 8 | CEO | Entity-scoped exact-term lane as fallback arm, not a planned arm | Taste | P3, P6 | Costs a dev arm; only needed if F1/F2 fail | adding it as a planned arm |
| 9 | CEO | README wording: Hard is a different workload | Mechanical | P5 | Avoids implying a remeasure | — |
| 10 | CEO | Part 2 permission-result split to the gate as d1 | Taste | P1 | One voice; the row carries an unrelated result | auto-splitting |
| 11 | CEO | Part 3 step 1 after the security PR, reusing its predicate; exact-claim documentation | Mechanical | P1, P5 | Same path as the security fix | shipping before it |
| 12 | CEO | Label M dev results in-sample | Mechanical | P5 | F-items were designed from M | — |
| 13 | CEO | Transfer / negative-control gate to the gate as d4 | Taste | P1 | One voice flagged it as a direction change | auto-adding |
| 14 | CEO | Baseline = wave merge base; confirm on branch before merge; freeze retention on dev | Taste | P1, P3 | Isolates the wave from master drift and the security PR | v0.60.174.0 baseline |
| 15 | CEO | Freeze endpoints: denominators, paired test, H4 by `+long`, per-model, abstention | Mechanical | P1 | Both voices: current rule passes on a one-cell change | — |
| 16 | CEO | Model freshness check before preregistration | Mechanical | P1 | Project model rules | — |
| 17 | CEO | Confirmation cost corrected to ~$1,450–1,700 | Mechanical | P5 | Per-arm $/task from analysis-main.md | +50% estimate |
| 18 | DX | Instruction 7 / compact-row records to the gate as d5 (new evidence for uc1) | Taste | P1 | One voice flagged a direction change | auto-deciding |
| 19 | DX | F4 moved into instruction 7 to the gate as d6 | Taste | P4 | One voice; duplicates existing served guidance | auto-deciding |
| 20 | DX | Documented record-type enrollment, `supersedes` for amends, read-only check; benchmark opts in | Mechanical | P1, P5 | Both voices: no shipped pack declares record types | keying on benchmark type strings |
| 21 | DX | Records as an extra view; `referenced_by` parity unchanged | Mechanical | P4 | Avoids an unlisted behavior change | moving rows out of `referenced_by` |
| 22 | DX | One executable continuation shape; capped/undeclared/degraded states visible | Mechanical | P5 | Both voices | four shapes |
| 23 | DX | `context_pack` count naming | Mechanical | P5 | Two disagreeing counts on one card | new count field |
| 24 | DX | F2 activation on default searches, budget accounting, named off switch | Mechanical | P1 | Outside voice: `auto` exits early on non-conversation hits | unit-only patch |
| 25 | DX | Payload guard on serialized results; notice state fixed across arms | Mechanical | P1 | `cards[]` doubles payload; transcripts cap at 40k | text-only guard |
| 26 | DX | Part 3 typed refusal object on three surfaces | Mechanical | P5 | Both voices | message-prefix only |
| 27 | DX | Protocol docs, schemas, fixtures, errors row, llms.txt in the ship list | Mechanical | P1 | Additive-field precedent | — |
| 28 | DX | README sentence-by-sentence dispositions incl. per-task cost | Mechanical | P1 | Hard M contradicts the "twice as much" sentence | partial retirement |
| 29 | Eng | Replace "amends = supersedes" with a non-ranking amends link (supersedes the DX clause) | Mechanical | P1, P5 | Both voices: supersedes halves the governing contract's score | keeping the DX clause |
| 30 | Eng | Enrollment via per-arm config key; frozen pack variants | Mechanical | P3 | Strict manifest breaks the baseline arm | pack-level key |
| 31 | Eng | Filter enrolled types in the membership query; batched names query; stated cap; per-type `next` | Mechanical | P5, P3 | Cap starvation and N+1; `types[]` has no budget | `types[]` param |
| 32 | Eng | Records in the pull verb only | Mechanical | P1 | Push path has a 600 ms deadline | shared assembler |
| 33 | Eng | Names-mode read-option parity confirmed by the security follow-up owner first | Mechanical | P1 | Urgent finding outside this plan | — |
| 34 | Eng | F2 behind a config key, default off; two goldens; caller-resolved policy | Mechanical | P5 | Default-on retires a normative golden | default-on |
| 35 | Eng | Passage leads text; lean `delivered`; input limits; no text without a term | Mechanical | P1 | `snippet_chars` head cut; 352 term-less keyword queries | appended passage |
| 36 | Eng | Text changes name their budget cut | Mechanical | P5 | Zero headroom | — |
| 37 | Eng | Per-item config keys, one build | Mechanical | P3 | Harness supports per-arm config | build-vs-build pairs |
| 38 | Eng | Part 3 row rule, receipt persistence, second site; can start now | Mechanical | P1 | #6509 merged | — |
| 39 | Eng | Part 3 out of the eval-gated PR to the gate as d7 | Taste | P6 | One voice; changes shipping structure | auto-splitting |
| 40 | Eng | Baseline at or after `2895edb3` | Mechanical | P5 | Security PR merged | v0.60.174.0 |
| 41 | Eng | World-bytes opt-in reruns fs with new digests | Mechanical | P1 | `renderDoc` feeds every file arm | reusing recorded fs cells |
| 42 | Eng | Preregister measured SHA and path set; drift rule | Mechanical | P1 | Master moves during confirmation | — |
| 43 | Eng | Opus $0.86, dev cost range with fs rerun | Mechanical | P5 | Re-derived from results.jsonl | — |
| 44 | Eng | Revised expected-effect paragraph; ceilings unchanged | Mechanical | P5 | Per-item reach narrower than drafted | per-item point estimates |
