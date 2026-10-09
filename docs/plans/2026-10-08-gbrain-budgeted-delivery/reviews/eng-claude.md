# Engineering review (Claude): budgeted delivery plan v2

Phase: autoplan ENGINEERING, run last, on `PLAN.md` v2 (commit `0c60e49` on `capy/gbrain-budgeted-delivery-plan`).
Mode: auto-decide (no questions asked; Mechanical items are recommended for direct application, Taste items carry a
recommended default, User Challenges are listed and never applied). Workflow: gstack `plan-eng-review`, adapted to
Capy (no plan-mode host, no review log write; this file is the only artifact).

Code read for this review:

- gbrain-evals harness at `9c07b7e2` (branch `capy/oss-memory-shootout`, draft PR #89), worktree of that commit.
- gbrain at master `7aa2caa0`, with spot checks against `c5fb0201` (the shootout's counted master). Every gbrain
  line cited below is identical at both commits unless stated.
- One measurement made for this review ($0): the character overhead of the harness's session serialization on
  LoCoMo dev (finding 5).

## Verdict

The plan is sound as an experiment design and its gbrain citations hold, but it is not buildable as written: three
code paths it relies on do not behave as assumed (frozen-hit delivery drops the session date, the evidence plan cannot
tell an explicit budget from the default, and one budget value cannot fit both renderings it is used for). The
smallest build reuses gbrain's `assembleEvidenceForHits` frozen-candidate entry and the memory-qa multi-arm runner, so
every `query` comparison in E1 and E2 becomes delivery on one frozen hit list with an exact live parity check instead
of three retrievals compared after the fact. With the 1 Critical and 7 High findings below folded in (all Mechanical
or Taste, none touching G1 to G8), E1 is about one CC-day of harness work and C2 `cap_only` about two CC-hours.

## Findings

Format: `[SEVERITY] (confidence N/10) section: problem. Fix. file:line`. Severity scale: Critical (silent wrong
result in a decision artifact), High (blocks a gate or makes a reading uninterpretable), Medium (rework or a
misleading receipt), Low (hygiene). Every finding at confidence 7+ was verified by reading the quoted line.

1. **[Critical] (9/10) C1, E2, H1: frozen-hit delivery has no session date.** `resolveFrozenHits` builds rows from
   `SELECT h.ord, p.id AS page_id, p.slug, p.source_id, p.title, p.type, cc.id AS chunk_id, cc.chunk_index,
   cc.chunk_text, cc.chunk_source` (gbrain `src/core/search/evidence-delivery.ts:1085-1086`); there is no
   `effective_date`. `assembleEvidenceForHits` (`:1124`) is the path the harness already uses to freeze evidence
   (`eval/runner/evidence-delivery/freeze.ts:187-189`) and the natural path for E2's "delivery variants on one
   frozen ranked hit list" and H1's "frozen evidence". On that path a C1 header built from `effective_date`
   silently disappears and a `valid_from` mapping is null, while the live `query` path has the date
   (`src/core/types.ts:891`, projected by the engines). Nothing in the plan would notice. **Fix:** project
   `p.effective_date, p.effective_date_source` in `resolveFrozenHits` in the C1/C2 gbrain PR, with a keyless test
   that live `query` and `assembleEvidenceForHits` on the same hits produce identical delivered bytes with C1 on.
   In the harness, take item dates from the namespace's session table by source id, never from the gbrain row, so
   E1 (which runs at `c5fb0201` without this fix) is unaffected.

2. **[High] (9/10) C2 "The cap": the evidence plan cannot see whether the budget was explicit.** `EvidencePlan`
   holds `budgetTokens` and `explicitUnit` only (`evidence-delivery.ts:103-111`), and `resolveEvidencePlan`
   collapses a passed budget and a config or default budget into one number (`:222-225`). So `deliverEvidence`
   cannot distinguish an explicit 24,000 from the implied 24,000, which the cap rule needs. The plan also scopes the
   cap to `query`, but the same plan resolution serves `search` (`src/core/ops/search.ts:129-140` with
   `op: 'search'`), `recall`'s results arm (`src/core/ops/facts.ts:199-205`) and `assemble_evidence`
   (`evidence-delivery.ts:1142`). `think` passes `budget: undefined` (`src/core/think/index.ts:527-529`) and is
   unaffected. **Fix:** add `budgetExplicit: boolean` (and the resolved packing variant) to `EvidencePlan`, set in
   `resolveEvidencePlan` from `typeof input.budget === 'number'`. Name all four affected operations in C2 and in the
   CHANGELOG entry. The test helper `planOf` (`test/evidence-delivery.test.ts:174-176`) then defaults to
   `budgetExplicit: false`, so every existing property test keeps pinning today's path unchanged.

3. **[High] (9/10) C2 "The cap" and "minimum unit rule": three code changes are described only as outcomes.**
   (a) Under `auto` the spill closure runs before the rank-one cut: `if (spill) { spill(b); continue; }` is at
   `evidence-delivery.ts:695`, the `minKeep` cut at `:696`. So "cut rank one to fit, as `allocate` already does" is
   unreachable under `auto` today; the cap must disable `spill` when `budgetExplicit`. (b) Non-conversation chunks
   are reserved wholesale before allocation (`const reserved = passthrough.reduce(...)`, `:896`), so "notes only,
   over budget" needs a stated rule: keep the rank-order prefix of passthrough chunks that fits, cut the first one
   if it alone exceeds the budget, list the rest in `dropped_reasons`. (c) Spilled blocks must be listed, not
   appended (`:944-957`). The plan's test list names only `test/evidence-delivery.test.ts:272-287`, but the
   property test at `:228-270` also pins the spill contract ("hit lost" check and `expect(delivery.dropped).toBe(0)`
   at budgets 40 to 24,000). **Fix:** write (a) to (c) into C2 and name both tests; with finding 2 the existing tests
   stay as they are and new explicit-budget twins assert the cap.

4. **[High] (8/10) C2 and guard G1: the plan contradicts itself on whether variants run at the default budget.**
   Line 334-335 says "Without an explicit budget the default path keeps today's behavior"; line 351-352 says "When
   every hit session fits whole (the 24,000-token default ...), every variant's output is byte-identical", which only
   makes sense if variants run at the default budget. If they do, G1's condition ("equal whenever today's delivery
   spilled and cut nothing") is false by construction for `breadth_capped` (drops groups past k) and `depth_first`
   (enriches in a different order whenever a session is not whole). **Fix (Taste, recommended):** the cap and all
   three variants engage only when `budgetExplicit`; without it `deliverEvidence` runs today's code. G1 becomes a
   keyless structural property test (random corpora, every variant, no explicit budget, byte-identical), G6 and the
   H1 default-budget pair are exact at no reader cost. State the consequence in plain words: an H1 pass changes
   behavior only for callers that pass `token_budget`; the agent's default `query` call (no budget) is untouched.

5. **[High] (9/10) C0 budget sizing, G4, E2 primary: one `B_bench` cannot fit the pseudo-session rendering.** The
   sizing rule measures the ratio on "the adapter's serialized items" in native form, and the provisional values
   come from raw delivered text. Pseudo-session and rehydrated contexts serialize turns as JSON
   (`renderHistory`, `eval/runner/memory-qa/qa.ts:45-47`). Measured for this review on the 89 LoCoMo dev sessions
   (conv-44, -47, -48): the JSON session serialization runs 1.159 times the Markdown turn text in characters on
   average, maximum 1.273. Combined with LoCoMo's `r_max` of 1.091, a pseudo-session context can reach about 1.39
   harness tokens per gbrain token, so at `B_bench` 7,100 it can reach about 9,860 harness tokens and the packer
   cuts it. G4 is "zero packer cuts, every question", so every candidate would fail G4 on E2's primary rendering.
   The hash-vector replay also selects different sessions than real retrieval, so its maximum is not a bound for
   the paid run. **Fix:** size `B` per (benchmark, rendering). Size it on the real frozen hit list, which costs $0
   once the label-free retrieval freeze has run (delivery is local), and freeze `B` in the preregistration after the
   retrieval freeze and before any reader call. Keep the 1.02 margin.

6. **[High] (8/10) E1, E2, H1 rendering: "pseudo-session" names two different renderers.** The shootout's
   rehydrated arm uses memory-qa's `READER_TEMPLATE` with JSON turns (`qa.ts:35,45-47`; `render.ts:121-122`).
   Sealed v2 decision 1 used gbrain's renderer and reader text (`renderChatBlock`, `READER_NOTES_SYSTEM_TEXT`,
   `buildReaderUserText`; `eval/runner/evidence-delivery/e1.ts:24-28`). The plan says pseudo-sessions use "the
   rehydrated arm's reading template ... the way sealed v2 decision 1 rendered", which is both. If E2 picks a
   variant under one and H1 tests it under the other, the held-out read is not the dev read. **Fix:** pin
   pseudo-session = memory-qa `READER_TEMPLATE` plus `renderHistory` over sessions rebuilt from blocks (matched to
   `rehydrated`, as reading 3 needs). Run H1 through memory-qa's custody path (`--benchmark custody --split sealed`,
   `eval/runner/memory-qa/run.ts:5-7`) so E2 and H1 share one renderer. Specify the block-to-turns parser: turns
   start at `**<speaker>:** ` (`eval/runner/memory-qa/corpus.ts:87`), `EVIDENCE_OMISSION` (`[…]`,
   `evidence-delivery.ts:53`) becomes an explicit omission turn, and a cut leading fragment keeps its text under the
   preceding speaker or `unknown`. Unit-test all three.

7. **[High] (9/10) E1 reading 2: the product-path contrast is confounded by dates.** C0 prefixes each `query` item
   with its title, which is `Conversation on <date>` for these pages (`corpus.ts:85`), and sets `valid_from`, which
   `renderItem` prints as `[valid <date> to present]` (`eval/runner/systems/render.ts:47`). `shootout-chunk` items
   carry no date. So `query-auto` minus `shootout-chunk` measures dates plus path, the very confound E1's date-only
   pair exists to remove. "Valid ... to present" also reads as a fact validity window, not a session date.
   **Fix:** one date channel for every dated gbrain arm: the C1 header line in the item text, `valid_from` unset,
   no title prefix (the header carries the date). Reading 2 becomes `query-auto` minus `chunk-dated` (both dated).

8. **[High] (9/10) C0 "Two retrieval paths": the plan does not use the frozen-candidate interface that already
   exists, and `query` exposes no pre-delivery hit list.** The handler returns delivered blocks grouped per page,
   so "the adapter records `query`'s upstream ranked hit ids before delivery" has no mechanism. gbrain already ships
   `assembleEvidenceForHits`, documented as "the library entry gbrain-evals calls for a frozen candidate list: the
   same plan resolution, assembler and output redaction the `query` op applies" (`evidence-delivery.ts:1118-1124`),
   and the harness already freezes hits and refuses an un-reranked list (`freeze.ts:151-152`). **Fix:** per
   question, one `query` call with `return_unit: 'chunk'` and no `token_budget` (the plan resolves to null, so the
   evidence stage is inert and no chunk budget applies: `tokenBudget: !plan && ...`, `ops/search.ts:951`) gives the
   ranked hit list. Deliver every variant on it through `assembleEvidenceForHits`: `auto` at `B`, `auto` with no
   budget, and `auto` at `B` on its first five hits. One live `query` call with `auto` at `B` per question then
   checks the product path exactly: equal `evidenceFingerprint` means "delivery effect", a mismatch is recorded as
   product path. The five-hit derivation is valid if the limit-5 list is a prefix of the limit-25 list; the
   reranker's input size is fixed by the mode (`reranker_top_n_in: 25`, `src/core/search/mode.ts:510`), not by the
   call's limit, so prove the prefix keylessly and fall back to a separate limit-5 cell if it fails. This removes
   two of the three `query` retrievals and makes E1's `query` readings the same construction E2 uses.

9. **[Medium] (9/10) C0 call pins: the cache pin names a key that does not exist, for a cache that is off.** The
   plan writes `search.cache_enabled=false`; the registered key is `search.cache.enabled`
   (`src/core/config.ts:1312`), and an engine-level `setConfig` with a wrong name is a silent no-op. More
   importantly, `semanticResultCacheAvailable()` returns `false` at both `c5fb0201` and master
   (`src/core/search/query-cache.ts:35`), so the diagnosis sentence that `balanced`'s cache "can serve one
   question's hits to a near-duplicate question" (PLAN line 126-127) and decision A10's reason are wrong for every
   commit in scope. **Fix:** correct the diagnosis text and A10; keep a pin only as belt and braces (per-call
   `use_cache: false`, `ops/search.ts:952`); assert cache status `disabled` in each receipt.

10. **[Medium] (8/10) C0 receipt: the `query` path has knobs beyond `hybridSearch` that the receipt neither pins
    nor records.** Decide slots are key-aware: with a TypeSafe key in the environment the recommended slots default
    on, including the S3 evidence gate that can prune hits (`src/core/ai/decide/config.ts:4-13`; A4 runs had such a
    key). `query` also runs declared-name fan-out (`ops/search.ts:975`), reads the CRAG escalation and think
    switches (config, default off), defaults `expand` to true (`:813`) where the plan pins false, and writes
    `last_retrieved_at` fire-and-forget (`:1105`) while the harness truncates tables between namespaces.
    **Fix:** pin `decide.provider=none`, `search.crag_escalation=false`, `search.crag_think=false`,
    `search.track_retrieval=false`; record `meta.decide`, `meta.crag`, `meta.degraded` per row (the
    `emitResponseMeta('retrieval', ...)` capture in `eval/runner/a4-abstention.ts:271` is the pattern); disclose
    `expand: false` as a deviation from the agent default, chosen to match the shootout's retrieval.

11. **[Medium] (9/10) E1 harness shape: "all arms share one ingest" is not expressible in the runner, and does
    not need to be.** A memory-qa cell is one system, one ingest, and arms = policy x context x reader, where policy
    is only `vendor-default` or `fixed-evidence` (`eval/runner/memory-qa/arms.ts:60`) and context only `native` or
    `rehydrated` (`:64`). Items carry no date field besides `valid_from` (`eval/runner/systems/types.ts:48-59`).
    **Fix (smallest arrangement):** two cells per benchmark, plus a third only if finding 8's prefix check fails.
    Cell A is `GbrainShootoutSystem` with a `dated` constructor option that adds an optional `event_date` to items
    (native rendering ignores it, so `shootout-chunk` prompts stay byte-identical); contexts `native`
    (= shootout-chunk), `native-dated` (= chunk-dated), `native-dated-twin`, `pseudo-session` and `rehydrated` all
    derive from its one `hybridSearch` retrieval. Cell B is a new `GbrainQuerySystem` whose policies map
    `vendor-default` to no budget and `fixed-evidence` to `B`, exactly as the plan's capability record already says.
    Separate cells share the warm embedding cache (`run.ts:483-486`), so embeddings are paid once; the cost table
    should say "ingest embeddings once, PGLite import per cell".

12. **[Medium] (8/10) Sequencing: the harness E1 extends is not on the plan's base branch.** `eval/runner/systems/`
    and the multi-arm runner exist only on `capy/oss-memory-shootout` (draft PR #89); `main` at `f1ce49fe` has
    neither. `package.json` pins gbrain `a865f8f8` while E1 loads `c5fb0201` through `--gbrain`. **Fix:** state that
    E1's code branches from PR #89's head (or lands after it merges), and that every receipt records both the
    declared pin and the loaded commit, as CLAUDE.md requires.

13. **[Medium] (7/10) Reproduction band versus the new reranker rule.** The shootout adapter never checked rerank
    presence (`rerankPinned` is `false` at `eval/runner/systems/gbrain.ts:182`) and ran with the 5 s rerank timeout
    (`mode.ts:511`); the harness itself documents Voyage reranks that exceed 5 s and fall back to unreranked order
    (`freeze.ts:44-50`). So some frozen rows may be unreranked, unflagged. "A reranker failure fails the arm" plus
    any timeout change can move `shootout-chunk` outside its band for reasons unrelated to delivery. **Fix:** the
    reproduction arm keeps the shootout's timeout and records rerank presence per row without failing; new arms
    retry a missing rerank as `harness_invalid` (the runner's attempt accounting) instead of failing the whole arm;
    report both counts beside the band.

14. **[Medium] (8/10) C1 placement collides with three existing contracts.** "deliverEvidence ... plus the plain
    chunk path's output rows" would (a) change the frozen off-path bytes that `test/evidence-delivery-golden.test.ts`
    protects ("must not be regenerated on a branch that changes the off path", lines 7-13); (b) change `think`,
    which calls `deliverEvidence` by default and renders delivered blocks verbatim beside its own date frame
    (`think/index.ts:527-540`); (c) shift every `match_spans` offset (UTF-16 coordinates into `chunk_text`) and the
    `evidenceFingerprint`. **Fix (Taste):** add the header through a `DeliverOptions` flag that only
    `query`, `search`, `recall` and `assemble_evidence` set; leave the plan-null chunk path and `think` alone; shift
    spans by the header length and count the header inside the allocation. G2 then reads "differs only by one header
    line per dated block and correspondingly shifted spans".

15. **[Medium] (7/10) C2 `breadth_capped` is not specified precisely enough to implement or preregister.** "Top k
    conversation groups that fit with each floor plus a window around it, k scaled to the budget" leaves the window
    and k open. **Fix:** define k as the largest k such that the sum over the first k groups, in rank order, of
    title tokens + floor + one piece run on each side of the floor fits `B`; groups past k go to `dropped_reasons`
    as `breadth_cap`. Preregister the formula; property-test it.

16. **[Medium] (7/10) C2 variant selection: a config key alone is awkward for E2.** E2 runs four delivery variants
    on one brain; switching a brain-level config key between calls works sequentially but is easy to get wrong.
    **Fix (Taste):** register `search.auto_packing` in `KNOWN_CONFIG_KEYS` (`config.ts:1235`, beside
    `search.return_*` at `:1403-1407`) for the product, and add a library-only `auto_packing` field to
    `AssembleEvidenceInput` (trusted local, not an MCP parameter) for evals, the same per-call-wins pattern
    `src/core/search/hybrid/request.ts:102-140` uses for eval A/B knobs.

17. **[Low] (6/10, medium confidence) C0 accounting: packed ids are already computed.** The runner writes
    `qa_context` with `item_ids`, `source_ids` and `prompt_sha256` (`run.ts:192,693`); the committed shootout rows
    lack it, so the gap is in what was published, not in what the runner computes. I did not locate the step that
    drops it. **Fix:** confirm where `qa_context` is lost and keep it in the new run's published rows; add only the
    packer-cut count and pre-pack token count to `PackedContext`.

18. **[Low] (8/10) E1 accounting gate runs the wrong code.** The gate is defined on the receipt replay script,
    which calls `hybridSearch` and the delivery functions directly. **Fix:** run the committed adapters keyless
    through memory-qa (`--embed hash`, `run.ts:478`, reranker pinned off), on all three benchmarks including BEAM.

19. **[Low] (7/10) E1 twin reuse needs a mechanism.** Frozen contexts are keyed by question, policy, context and
    budget (`arms.ts:96`), so a `native-dated-twin` prompt never hits the `native` entry. **Fix:** in `readRow`, when
    a twin's `prompt_sha256` equals the `native` prompt's for the same question, copy the scored row and mark it
    `reused_from`; test it.

## Decisions

| # | Decision | Class | Principle | Recommendation |
|---|---|---|---|---|
| D1 | Project `effective_date` in `resolveFrozenHits`; harness dates from session table | Mechanical | P1 completeness, P2 blast radius | Apply (finding 1) |
| D2 | `budgetExplicit` and packing on `EvidencePlan`; name all four affected ops | Mechanical | P5 explicit | Apply (2) |
| D3 | Write the spill/passthrough/minKeep rules into C2; add the `:228-270` property test to the change list | Mechanical | P1 | Apply (3) |
| D4 | Cap and variants engage only on an explicit budget; G1 structural | Taste | P2, P3 | Accept (4) |
| D5 | Size `B` per benchmark and rendering on the real frozen hit list, after the retrieval freeze | Mechanical | P1 | Apply (5) |
| D6 | Pseudo-session = memory-qa template; H1 through memory-qa custody; specified block parser | Mechanical | P5 | Apply (6) |
| D7 | One date channel (header in text) for all dated gbrain arms; reading 2 against `chunk-dated` | Mechanical | P5 | Apply (7) |
| D8 | Frozen hit list via `query` chunk unit plus `assembleEvidenceForHits`; live parity by fingerprint | Taste | P4 reuse, P3 | Accept (8) |
| D9 | Correct the cache diagnosis and key; assert `disabled` | Mechanical | P5 | Apply (9) |
| D10 | Pin decide/CRAG/track_retrieval; record meta; disclose `expand: false` | Mechanical | P2 | Apply (10) |
| D11 | Two cells per benchmark, new context modes, one new system class | Taste | P3, P4 | Accept (11) |
| D12 | E1 code branches from PR #89; receipts record pin and loaded commit | Mechanical | P1 | Apply (12) |
| D13 | Rerank-presence handling that keeps the reproduction arm comparable | Mechanical | P2 | Apply (13) |
| D14 | C1 via a `DeliverOptions` flag; off-path and `think` untouched; spans shifted | Taste | P2 | Accept (14) |
| D15 | Precise `breadth_capped` k | Mechanical | P5 | Apply (15) |
| D16 | Config key plus library-only per-call override for evals | Taste | P5 | Accept (16) |
| D17 | Ship C2 as two gbrain PRs: `cap_only` first, variants second | Taste | P6, reversibility | Accept (task order below) |
| D18 | Keep E1's arm list, G1 to G8 and every cost cap as written | n/a | scope respect | No change |
| UC | None raised. G3 (depth-first preference) and G1 (contract reversal) stay with Garry; nothing here reopens them. | User Challenge | | Not applied |

## Scope challenge, grounded in code

**What E1 needs that does not exist yet.** A `MemorySystem` that goes through `query`; item dates; three renderings
(dated native, undated twin, pseudo-session); per-row accounting; a budget value per rendering. Everything else
exists: the multi-arm runner with frozen retrievals, frozen contexts and reader replay (`memory-qa/arms.ts`,
`run.ts --arms --replay`), the packer and renderer (`systems/render.ts`), gbrain's frozen-candidate delivery
(`assembleEvidenceForHits`), the in-process operation context pattern (`a4-abstention.ts:271-272`), the ledger
prices for all four frontier readers and the main readers (`budget-ledger.ts:1080-1100`), and the embedding cache.

**Smallest change that delivers E1 (harness only, gbrain frozen at `c5fb0201`):**

1. `eval/runner/systems/gbrain.ts`: `GbrainModules` gains `operations` and `assembleEvidenceForHits`;
   `GbrainShootoutSystem` gains a `dated` option that adds `event_date`; one new class `GbrainQuerySystem`
   (frozen chunk-unit list memoized per question, deliveries via assemble, live parity call, accounting).
2. `eval/runner/systems/types.ts`: optional `event_date` on `Item`, optional `accounting` on `RetrieveResult`.
3. `eval/runner/systems/render.ts`: contexts `native-dated`, `native-dated-twin`, `pseudo-session`; block parser;
   packer-cut fields on `PackedContext`.
4. `eval/runner/memory-qa/arms.ts` and `run.ts`: accept the new contexts, persist `accounting`, twin reuse, system
   registration `--system gbrain-query`.
5. One sizing script, the preregistration, tests.

Count: 5 source files changed, 1 script added, 1 new class (the dated chunk path is an option, not a class), about
3 test files. The plan's implied arrangement (two new adapters, `chunk-dated` and `gbrain-query`, three `query`
retrievals, a pre-delivery hit comparison) has 2 new classes and more moving parts for the same arms. In auto mode
the complexity gate resolves to the **Smaller arrangement**, with the same feature list, contracts and guards.
Scope result: **scope accepted as-is** (a smaller arrangement that preserves scope is not a reduction).

**Smallest change that then delivers C2 (gbrain):** PR 1, `cap_only`: `evidence-delivery.ts` (plan fields, cap
path in `allocate`/`deliverEvidence`, `effective_date` projection), `config.ts` (register `search.auto_packing`),
`docs/evidence-delivery.md:118-123`, `CHANGELOG.md`, `test/evidence-delivery.test.ts`, the Postgres arm in
`test/e2e/evidence-delivery-parity.test.ts`. No new classes; about 60 to 90 source lines. PR 2, variants: an
options object on `allocate` (`order: 'floors_first' | 'depth_first'`, `maxGroups?: number`, `spill: boolean`)
rather than a second allocator, plus tests. C1 rides as its own flag in PR 2 or a PR 3. The off-path golden must
not change in any of them.

**TODOS cross-reference.** gbrain-evals `TODOS.md` "Evidence delivery follow-ups" (lines 7-13) holds the sealed-v2
item this plan consumes and the `think.return_unit` item that finding 14 protects. No existing TODO blocks E1.
Proposed new TODOs are under NOT in scope.

## Architecture diagram

```
gbrain-evals (branch from PR #89 head)                        gbrain (frozen c5fb0201 for E1; branch for E2)
─────────────────────────────────────────                     ───────────────────────────────────────────────
eval/runner/memory-qa/run.ts  --system gbrain-query ─┐
eval/runner/memory-qa/arms.ts (new contexts)         │
                                                     ▼
eval/runner/systems/gbrain.ts                                  src/core/operations.ts   operations[]
  GbrainShootoutSystem({dated})  ── hybridSearch(limit 40) ──▶ src/core/search/hybrid.ts
     items + event_date (from session table)                   
  GbrainQuerySystem (NEW)                                      
     1 query{return_unit:'chunk', limit:25} ───────────────▶  src/core/ops/search.ts  query handler
        = frozen ranked hit list (memo per question)              (plan null: evidence stage inert)
     deliveries: assembleEvidenceForHits(frozen, auto, B)  ─▶  src/core/search/evidence-delivery.ts
                 assembleEvidenceForHits(frozen, auto)          resolveFrozenHits (+effective_date, C2 PR)
                 assembleEvidenceForHits(frozen[0..5], auto, B) resolveEvidencePlan (+budgetExplicit, packing)
     live check: query{return_unit:'auto', limit:25, B} ───▶   deliverEvidence → allocate(opts)  (C2 PR)
        fingerprint == assemble(auto,B)?  → delivery | path    DeliverOptions.dateHeader          (C1)
     accounting: delivery meta, retrieval meta (decide,        src/core/config.ts  KNOWN_CONFIG_KEYS
        crag, cache, degraded), rerank presence                   + search.auto_packing             (C2 PR)
                                                     │         docs/evidence-delivery.md, CHANGELOG.md
eval/runner/systems/types.ts  Item.event_date?,      │         test/evidence-delivery.test.ts (+cap twins)
                              RetrieveResult.accounting?       test/e2e/evidence-delivery-parity.test.ts
eval/runner/systems/render.ts                        ▼         test/evidence-delivery-golden.test.ts (unchanged)
  native | native-dated | native-dated-twin | pseudo-session | rehydrated
  packContext → PackedContext{tokens_before, items_cut, item_ids, prompt_sha256}
docs/plans/.../budget-sizing.ts (NEW, $0 on frozen hits) → B per (benchmark, rendering)
docs/benchmarks/<date>-gbrain-budgeted-delivery-e1-preregistration.md (NEW)
```

## Codepath to test diagram

Every test below is keyless (hash vectors, reranker off, no provider key) unless marked.

```
CODEPATH                                             TEST (file)                                    CATCHES
───────────────────────────────────────────────────  ─────────────────────────────────────────────  ─────────────────────────────
shootout retrieval, dated option off                 golden: native prompt bytes == frozen          adapter drift breaks link
                                                     (test/eval/memory-systems.test.ts)
dated option: event_date from session table          null date → no header; empty chunk text        invented or missing dates
native-dated header text == C1 header bytes          string equality with gbrain header builder     C1 test measuring other bytes
native-dated-twin: selection with header,            twin ids == dated ids; twin text has no        date-only pair not date-only
  render without                                     header; prompt == native when ids equal
twin reuse by prompt hash                            reused row copied, marked reused_from          paying for identical prompts
pseudo-session parser                                speaker turns, omission marker, cut leading    mangled sessions read as data
                                                     fragment, missing date → "unknown"
query chunk-unit call = frozen list                  plan null asserted; no budget param sent       hidden chunk budget
assemble deliveries on frozen list                   resolved call receipt == preregistered         wrong unit, limit, budget
                                                     object, else cell refused
live parity                                          fingerprint(live auto,B) == fingerprint(       product path vs delivery
                                                     assemble auto,B) on a fixture brain
limit-5 prefix                                       live limit 5 ids == first 5 of limit 25        bogus 5-hit derivation
bare-budget call (G7 record)                         query{token_budget} without unit → chunk       documents legacy unit
pins (decide, crag, track_retrieval, cache)          receipt shows each resolved; cache disabled    silent pruning or writes
accounting completeness (gate)                       every row has budget_used, spills,             incomplete records
                                                     fallbacks, rerank presence, cuts
B sizing script                                      ratio over frozen hits per rendering;          G4 failures from units
                                                     recomputed B reproduces committed value
rerank missing                                       retried as harness_invalid; counted            silent unreranked rows
── gbrain (C2 / C1 PRs) ──
resolveEvidencePlan.budgetExplicit                   explicit 24000 vs implied 24000 differ only    cap on default callers
                                                     in the flag (test/evidence-delivery.test.ts)
no explicit budget, every variant                    property: bytes == today's (60 random          G1 regression
                                                     corpora, budgets 40..24000)
cap: never over budget                               property: budget_used <= token_budget,         G3 regression
                                                     every variant, every trial
cap: notes only over budget                          rank-order prefix kept; first cut; rest        unbounded passthrough
                                                     in dropped_reasons
cap: rank one larger than budget under auto          cut at a piece boundary, non-empty             empty evidence
cap: spill disabled                                  no conversation_over_budget rows when          spill outside budget
                                                     budgetExplicit
breadth_capped k                                     k formula on fixed fixture; dropped as         unpreregistered k
                                                     breadth_cap
depth_first order                                    whole, else window, else skip; stop rule       wrong allocation
redaction grows/shrinks a block                      recount after redaction stays <= budget        over-budget after redaction
missing effective_date                               no header, no invented date                    fabricated dates
assemble carries effective_date                      assemble == live delivered bytes, C1 on        finding 1 regression
C1 spans shift                                       match_spans point at the same text after       broken get_page coordinates
                                                     the header
think unchanged with C1 on                           think prompt bytes equal                       think regression
off-path golden                                      unchanged file, unchanged fixture              frozen chunk contract
source swamp (Cat13b fixture)                        curated note delivered under tight budget      notes starved by chats
Postgres arm                                         same cap and parity tests (test/e2e/, needs    engine divergence
                                                     DATABASE_URL)
```

## Test plan

**Affected surfaces.** gbrain: `query`, `search`, `recall` (results arm), `assemble_evidence`, and the library
`deliverEvidence`/`assembleEvidenceForHits`. gbrain-evals: memory-qa runner, systems layer, renderer.

**Key interactions to verify.** Explicit budget versus implied budget; `auto` explicit versus implied (effectivePlan,
`evidence-delivery.ts:264-267`); remote clamp at 32,000 with an explicit budget (cap applies to the clamped value);
a cached hit list (`liveHits: false`) never falls back to cached text (`:882`).

**Edge cases.** Zero hits; zero conversation hits with explicit `auto`; one session larger than the budget; a budget
smaller than one title; non-ASCII text (UTF-16 span coordinates); `EVIDENCE_BLOCK_CHAR_CAP` reached before the
budget; redaction that shrinks a block; pages without `effective_date`; LoCoMo questions with identical text
(no cache, so no cross-question leakage).

**Critical paths.** The live parity check (it decides how reading 2 is labeled), the G4 zero-cut check per rendering,
and the frozen-evidence C1 bytes (finding 1).

**Commands.** gbrain-evals: `bun run test` (shards, Python, validators) and `bun run typecheck`. gbrain:
`bun test test/evidence-delivery.test.ts test/evidence-delivery-golden.test.ts`, then the e2e Postgres file with
`DATABASE_URL` set, before any held-out request (as the plan already requires).

**Tests to retire.** None. The spill assertions in `test/evidence-delivery.test.ts:228-287` stay as the
implied-budget contract; explicit-budget twins are added beside them after G1 is decided.

**Pending decisions that change tests.** G1 (whether the explicit-budget twins exist at all) and G5 (whether H1 adds a
native-rendered pair).

**LLM/eval scope.** Paid cells only after the keyless suite and the accounting gate pass; models follow the plan's
preregistered list (newest Opus, GPT, Sonnet and Fable for the reader check; no gpt-5.4-mini anywhere).

## Performance review

No blocking issues. The new `query` construction costs one extra rerank and query embedding per question for the
live parity call (the shootout measured $0.07 to $0.38 per 100 questions per retrieval policy), and removes up to two
other retrievals, so it is cost-neutral or cheaper. `assembleEvidenceForHits` per variant is one batched chunk-window
read (`getChunkWindows`) and local allocation, effectively free next to reader calls; four variants on 500 questions
is 2,000 local calls. Allocation is linear in pieces per block; the spill closure's `hits.indexOf` is quadratic in at
most 50 hits. Wall time: two cells per benchmark with a warm embedding cache is close to the plan's three hours.
G9 (p95 of the handler within +20%) should be measured on the same VM with the reranker's network time excluded or
recorded separately, because the reranker dominates handler latency and is not what C2 changes.

## NOT in scope

- **Generalizing memory-qa policies beyond `vendor-default` and `fixed-evidence`.** Two cells with a warm embedding
  cache cover E1; a named-policy runner is a follow-up TODO if more retrieval variants appear.
- **Changing the agent default budget (24,000) or `expand` default.** The plan already excludes the budget; `expand`
  is disclosed, not changed.
- **G7, the bare-budget unit.** Recorded keylessly only, as the plan says.
- **An MCP-visible `auto_packing` parameter.** The per-call override stays library-only for evals.
- **Fixing the shootout's frozen rows.** They stand as measured; new rows are a separate, labeled run.
- **Locating and changing the shootout publication step** beyond keeping `qa_context` in the new run's rows
  (finding 17).
- **BEAM-1M and long-session stress.** Out of scope in the plan; unchanged here.

## What already exists (reuse map)

| Need in the plan | Existing code | Reuse or build |
|---|---|---|
| Delivery on a frozen hit list | gbrain `assembleEvidenceForHits`, `resolveFrozenHits` (`evidence-delivery.ts:1070-1156`) | Reuse; add `effective_date` projection (finding 1) |
| Freeze with rerank refusal | `eval/runner/evidence-delivery/freeze.ts:145-152` | Reuse the check and the timeout note |
| In-process `query` with a local context and meta capture | `eval/runner/a4-abstention.ts:271-272` | Reuse the pattern |
| One ingest, many contexts and readers, replay | `eval/runner/memory-qa/arms.ts`, `run.ts --arms --replay` | Reuse; add three contexts |
| Packed ids and prompt hash per row | `run.ts:192,693` (`qa_context`) | Reuse; keep in published rows |
| Native and rehydrated packing, event-time order | `eval/runner/systems/render.ts:79-124` | Reuse; add pseudo-session beside rehydrated |
| Embedding cache across cells | `eval/runner/longmemeval-cache.ts`, `run.ts:483-486` | Reuse |
| Delivered-evidence fingerprint | gbrain `evidenceFingerprint` (`evidence-delivery.ts:1158`) | Reuse for live parity |
| Off-path byte contract | `test/evidence-delivery-golden.test.ts` | Reuse unchanged as the guard for C1 and C2 |
| Random-corpus property tests and fake engine | `test/evidence-delivery.test.ts:43-190` | Reuse for cap and variant properties |
| Ledger prices for all readers | `eval/runner/budget-ledger.ts:1080-1100` | Reuse; nothing to add |
| Keyless hash embedder | `run.ts:305,478` | Reuse for the accounting gate |
| Custody path for sealed sets | memory-qa `--benchmark custody` (`run.ts:5-7`) | Reuse for H1 so E2 and H1 share a renderer |

No shared-code extraction is proposed: the new code either calls an existing entry point or adds a mode to an
existing function, so the rubric's two-caller test does not arise.

## Failure modes registry

| New path | Realistic failure | Test or handling | Visible or silent |
|---|---|---|---|
| Frozen-hit delivery with C1 | `effective_date` absent, header missing in E2/H1 frozen evidence | None in the plan | Silent. **Critical gap** (finding 1) |
| Pseudo-session rendering | E2 under memory-qa template, H1 under gbrain reader text | None in the plan | Silent. **Critical gap** (finding 6) |
| Block-to-turns parser | Cut fragment or omission marker produces a malformed session | None in the plan | Silent. **Critical gap** (finding 6) |
| Reading 2 contrast | Date presence counted as product-path effect | None (analysis design) | Silent. **Critical gap** (finding 7) |
| `query` decide slots | TypeSafe key present, S3 gate prunes hits | Not pinned, not recorded | Silent. **Critical gap** (finding 10) |
| Budget per rendering | Pseudo contexts over 8,000 harness tokens, packer cuts | G4 catches it | Visible, but wastes the E2 run (finding 5) |
| Explicit-budget flag | Cap applied to default callers, or never | G1 keyless check, if built structurally | Visible with finding 4's test |
| Cap with notes | Passthrough exceeds budget | Plan lists the test; rule unstated | Visible once the rule exists (finding 3) |
| Rerank timeout | Unreranked hits in reproduction arm | Not recorded in frozen rows | Visible through band stop, cause hidden (finding 13) |
| Cache pin | Misspelled key is a no-op | Cache is hard-off anyway | Harmless now; misleading receipt (finding 9) |
| `last_retrieved_at` writes during truncate | Swallowed warnings | Best-effort by design | Benign; pinned off (finding 10) |
| Variant config switching in E2 | Wrong variant for a call | Per-call override plus receipt | Visible with finding 16 |

Five critical gaps, each closed by a Mechanical or Taste item above at small cost.

## Worktree parallelization

| Step | Modules touched | Depends on |
|---|---|---|
| E1 harness (T1-T7) | gbrain-evals `eval/runner/systems/`, `eval/runner/memory-qa/`, `test/eval/` | PR #89 head |
| C2 PR 1, `cap_only` (T9-T11) | gbrain `src/core/search/`, `src/core/config.ts`, `docs/`, `test/` | G1 answered |
| C2 PR 2, variants and C1 (T12-T14) | gbrain `src/core/search/`, `test/` | C2 PR 1 |
| E2 harness (T15) | gbrain-evals `eval/runner/systems/`, `eval/runner/memory-qa/` | E1 harness, C2 PR 2 |

Lane A: E1 harness (gbrain-evals). Lane B: C2 PR 1 then PR 2 (gbrain). Launch A and B together once G1 is answered;
B does not need E1's results to be written, only to be run. E2 waits for both. Conflict flags: none across repos;
inside gbrain, PR 2 rebases on PR 1 (same file).

## Implementation tasks

Effort assumes a human engineer familiar with both repos versus Claude Code with gstack. Ratios: features about 30x,
tests about 50x, architecture about 5x.

- [ ] **T1 (P1, human ~2h / CC ~10min)**, process: Branch E1 from PR #89's head; receipts record declared pin
  `a865f8f8` and loaded `c5fb0201`. Surfaced by: finding 12. Files: preregistration, receipt writer in `run.ts`.
  Verify: receipt shows both.
- [ ] **T2 (P1, human ~1.5d / CC ~1.5h)**, systems: `GbrainQuerySystem`: chunk-unit frozen list memoized per
  question; `assembleEvidenceForHits` deliveries; live parity by fingerprint; pins from finding 10; accounting into
  `RetrieveResult.accounting`; rerank presence with retry. Surfaced by: findings 8, 10, 13. Files:
  `eval/runner/systems/gbrain.ts`, `types.ts`, `eval/runner/memory-qa/run.ts`. Verify: new
  `test/eval/gbrain-query-system.test.ts` keyless.
- [ ] **T3 (P1, human ~1d / CC ~1h)**, render: `dated` option with `event_date` from the session table;
  contexts `native-dated`, `native-dated-twin`, `pseudo-session` with the specified parser; packer-cut fields; twin
  reuse by prompt hash. Surfaced by: findings 6, 7, 11, 17, 19. Files: `eval/runner/systems/render.ts`,
  `gbrain.ts`, `eval/runner/memory-qa/arms.ts`, `run.ts`. Verify: golden native bytes unchanged; parser and twin
  tests.
- [ ] **T4 (P1, human ~4h / CC ~20min)**, keyless gate: Accounting gate through memory-qa `--embed hash` on all
  three benchmarks, BEAM included. Surfaced by: finding 18. Verify: every row complete.
- [ ] **T5 (P1, human ~4h / CC ~20min)**, sizing: Budget sizing script on the frozen real hit list per
  (benchmark, rendering); freeze `B` after retrieval freeze, before readers. Surfaced by: finding 5. Files: new
  script in the plan folder. Verify: recomputation reproduces the committed values.
- [ ] **T6 (P1, human ~3h / CC ~20min)**, preregistration: Call objects, pins, date channel, reading 2 against
  `chunk-dated`, renderer pin, rerank handling, corrected cache text. Surfaced by: findings 6, 7, 9, 10, 13.
  Verify: doc review; `bun run validate`.
- [ ] **T7 (P2, human ~1h / CC ~10min)**, fairness: The plan's vendor date audit, unchanged. Verify: result in the
  preregistration.
- [ ] **T8 (P1, human ~2h / CC ~15min)**, gbrain plan: `EvidencePlan.budgetExplicit` and packing in
  `resolveEvidencePlan`; `effective_date` in `resolveFrozenHits`. Surfaced by: findings 1, 2. Files:
  `src/core/search/evidence-delivery.ts`. Verify: plan and assemble tests.
- [ ] **T9 (P1, human ~1d / CC ~45min)**, gbrain cap: `cap_only`: spill off when explicit, minKeep reachable,
  passthrough prefix rule, drops listed. Surfaced by: finding 3. Files: `evidence-delivery.ts`. Verify: cap
  properties; existing tests unchanged.
- [ ] **T10 (P1, human ~3h / CC ~15min)**, gbrain contract: Doc paragraph, CHANGELOG, explicit-budget test twins
  naming all four ops (after G1). Surfaced by: findings 2, 3. Files: `docs/evidence-delivery.md`, `CHANGELOG.md`,
  `test/evidence-delivery.test.ts`. Verify: `bun test`.
- [ ] **T11 (P2, human ~2h / CC ~10min)**, gbrain config: Register `search.auto_packing`; library-only
  `auto_packing` on `AssembleEvidenceInput`. Surfaced by: finding 16. Files: `src/core/config.ts`,
  `evidence-delivery.ts`. Verify: config set accepts the key; assemble honors the override.
- [ ] **T12 (P1, human ~1.5d / CC ~1h)**, gbrain variants: `allocate` options for `breadth_capped` (precise k)
  and `depth_first`; inert without explicit budget. Surfaced by: findings 4, 15. Verify: G1 structural property;
  k fixture.
- [ ] **T13 (P2, human ~1d / CC ~45min)**, gbrain C1: `DeliverOptions` date header; spans shifted; off-path and
  think untouched. Surfaced by: finding 14. Verify: golden unchanged; spans test; think bytes equal.
- [ ] **T14 (P1, human ~4h / CC ~20min)**, gbrain engines: Postgres arm of the cap, parity and assemble-date tests.
  Surfaced by: plan's both-engines rule. Verify: e2e with `DATABASE_URL`.
- [ ] **T15 (P2, human ~1d / CC ~1h)**, E2 harness: The 500 through the T2 construction with variant overrides;
  H1 through memory-qa custody. Surfaced by: findings 6, 8. Verify: keyless dry run on the slice.

## Unresolved decisions that may bite later

None opened by this review. G1 to G8 remain Garry's, unchanged; D4 depends on G1 (if G1 is "no", D4 and T10's test
twins fall away and C2 becomes the variants alone, still inert without an explicit budget).

## Completion summary

- Step 0, Scope Challenge: scope accepted as-is (smaller arrangement, same features and guards).
- Architecture review: 8 issues (findings 1, 2, 4, 5, 6, 8, 11, 12).
- Code quality review: 6 issues (findings 3, 9, 10, 14, 15, 16).
- Test review: diagram produced, 5 gaps (findings 7, 13, 17, 18, 19), plus the tests named under each finding.
- Performance review: 0 blocking issues; one measurement note on G9.
- NOT in scope: written.
- What already exists: written.
- TODOS.md updates: 1 proposed (named-policy runner), not written; this review writes only this file.
- Failure modes: 5 critical gaps flagged, each with a fix above.
- Unresolved decisions: 0 in this review.
- Outside voice: not run inside this review; the autoplan run's separate Astra engineering voice is the outside
  voice for this phase.
- Parallelization: 2 lanes, 2 parallel / 1 sequential (E2 harness).
- Lake score: 17/17 Mechanical or Taste recommendations chose the complete option.

## Suppressed findings (confidence below 5)

- (4/10) The live parity check may report mismatches on rows whose hybrid search returns non-conversation hits,
  because `resolveFrozenHits` fills fewer fields than live rows and passthrough rows copy every field. The
  fingerprint ignores those fields, and these benchmarks have only `chat/` pages, so I expect no effect.
- (4/10) PGLite import time per cell may push E1 past three hours on the slice; not measured.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|---|---|---|---|---|---|
| CEO review (Claude) | autoplan | plan v1 | 1 | recorded in `ceo-claude.md` | integrated into v2 |
| CEO review (Astra) | autoplan | plan v1 | 1 | recorded in `ceo-astra.md` | integrated into v2 |
| Eng review (Claude) | autoplan | plan v2 | 1 | ISSUES OPEN (not logged to a gstack review log; this file is the record) | 19 issues, 5 critical gaps |
