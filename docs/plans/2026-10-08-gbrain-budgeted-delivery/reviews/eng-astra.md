# Engineering review: budgeted delivery plan v2

## Verdict

Revise before implementation or paid E1: the diagnosis is supported, but the proposed experiment still has confounded comparisons and an incomplete executable harness contract. The smallest viable path is a harness-only E1 followed by a query-scoped, explicit-budget `cap_only` candidate; the other allocation strategies should reuse that boundary rather than establish different ones. Two keyless probes found concrete traps the current tests miss: frozen-hit assembly loses the date while its parity fingerprint passes, and snippet capping can grow a three-token allocation to eighteen tokens while still reporting three.

Reviewed independently by OpenAI GPT-6 Astra on 2026-10-08 UTC, in the engineering phase of auto-decide autoplan. No other review file was read. No plan, implementation, result, approval, or default was changed.

**Evidence identities.** `P` below means `docs/plans/2026-10-08-gbrain-budgeted-delivery/PLAN.md` at gbrain-evals `0c60e49c52b12344feb8127e603136fa9ef4e455`. `H` means the harness at `9c07b7e2f90715593b43d9bdc2a7652174636691`, fetched from `capy/oss-memory-shootout`. `G` means gbrain master `7aa2caa0aa2a9f031730cd351cd516cf4f9f5802`, cloned separately. I checked that `ops/search.ts`, `search/evidence-delivery.ts`, `search/hybrid.ts`, and `search/query-cache.ts` are unchanged from `c5fb0201`; E1 must still load its declared `c5fb0201`, not assume the harness package pin is that build. Both inspected gbrain-evals package files pin `a865f8f8`, so an explicit `--gbrain` identity is necessary.

## Scope challenge grounded in code

**Smallest change that delivers E1.** Keep the frozen shootout adapter and its goldens intact. Add a query adapter beside it in `eval/runner/systems/gbrain.ts`, extend the existing memory-qa arm and frozen-context machinery for the named call/rendering combinations, and carry delivery receipts through `run.ts`. Reuse the corpus importer, sanitizer, meter, reader client, judges, canonical outcomes, and replay store. E1 requires no allocation code, SQL migration, new extraction mechanism, new service, or new retrieval algorithm.

This is not merely “two new adapters.” The current `ArmsSpec` admits only two policy modes and two context modes, and the runner instantiates one system per cell (`H:eval/runner/memory-qa/arms.ts:39-64`; `H:eval/runner/memory-qa/run.ts:507-518`). A bounded named-recipe layer is needed to share one ingest while running limit 40, limit 25, limit 5, two query budgets, dated/undated mappings, and pseudo-session renderings. Keep it specific to the required matrix rather than designing a general experiment scheduler.

**Then the smallest C2.** First retain explicit-budget provenance through plan resolution and implement one final, query-scoped evidence cap with `cap_only`. This is the necessary correctness boundary regardless of which strategy wins. Only after its keyless contract tests pass should `breadth_capped` and `depth_first` become parameters of the existing allocator. They do not need another assembler, another authorization fetch, or another output format. Whether the paid E2 matrix includes all three remains governed by the plan's existing decisions, not this review.

C1 is separable and cannot be slipped into “cap-only” under a header-only guard that cannot hold at a saturated budget. Keep C3, C4 production fact search, and C5 out of the implementation dependency chain. The saved-facts probe may remain a separately identified E1 lane, but it has its own ingest/extraction path and is not covered by the claim that every arm shares one ingest.

## Numbered findings

1. **High | C0, E1, E2: the proposed arm matrix has no collision-safe identity in the existing runner.** `ArmsSpec` rejects named retrieval variants and `pseudo-session`; `retrievalKey` is only question plus policy mode, and `contextKey` adds only context and harness budget. `runConfigHash` does not include `policySettings`. Putting both 5-hit and 25-hit calls under `fixed-evidence`, or swapping mappings/renderers on a resumed cell, can reuse the wrong retrieval or prompt unless the identity scheme changes. **Concrete fix:** define an immutable recipe id/hash containing adapter/build identity, resolved call/settings, retrieval variant, renderer version, and selection transform; include the appropriate identities in run, retrieval, context, and arm hashes. Preserve the existing frozen-row formats or version the new recipe explicitly. Add mutation tests that changing each field invalidates the affected artifact while adding only a reader reuses the prompt. **Evidence:** `P:261-305,493-514`; `H:eval/runner/memory-qa/arms.ts:39-64,93-117`; `H:eval/runner/memory-qa/run.ts:351-357,519-523,719-736`. A keyless parser probe rejected both a `query-l5` policy and a `pseudo-session` context.

2. **High | C0 and E2: upstream-hit capture and frozen delivery are not yet a specified, date-preserving seam.** `query` returns delivered rows and emits metadata after assembly, not the complete ordered pre-delivery rows. The existing eval-capture sink records ordered chunk ids, but it is fire-and-forget; the ordinary response metadata cannot reconstruct dropped hits. The existing frozen-hit API is reusable, but `resolveFrozenHits` omits `effective_date`, and `evidenceFingerprint` omits dates and titles. **Concrete fix:** name and test the capture path before promising E1 parity: in the isolated harness brain, enable the existing capture sink, correlate/drain each query's captured ids, and resolve them against that same immutable brain; fail the cell if capture is absent or ambiguous. Freeze dates and the complete evidence identity as well as ids. Use the existing delivery functions over those frozen rows for E1; before relying on `assembleEvidenceForHits` for the C2 replay, repair its date projection and compare text, title, date, order, unit, spans, token totals, and fallbacks, not the old fingerprint alone. **Evidence:** `P:287-302,575-577`; `G:src/core/ops/search.ts:148-160,403-460,1111-1138`; `G:src/core/eval-capture.ts:93-110,149-169,203-215`; `G:src/core/search/evidence-delivery.ts:1084-1113,1124-1159`. A keyless real-PGLite query returned date `2026-01-15`; assembly returned no date, while `evidenceFingerprint` was equal.

3. **High | E1 readings: the “rendering effect” changes the reader, and the “depth gap” changes retrieval.** On the slice `query-auto` uses the frozen main reader but `query-auto-pseudo` uses Sonnet, so their subtraction is not a rendering effect. `rehydrated` uses the limit-40 shootout hits while query arms use separate limit-25 or limit-5 calls; this also prevents a clean depth-only attribution. The plan says delivery comparisons freeze hits, but the table does not implement that condition. **Concrete fix:** add or substitute a Sonnet read of the exact native `query-auto` prompt for the rendering comparison, and compare renderings over a fixed selection if the claim is layout alone. Add a rehydrated transform over the same frozen query-hit list for the depth comparison, or rename that reading a composite product-path comparison and prohibit mechanistic conclusions. Keep the existing shootout rehydration row as the historical reproduction link. **Evidence:** `P:292-293,466-476,485-489,532-544`; `H:eval/runner/systems/render.ts:79-123`; `H:eval/runner/memory-qa/arms.ts:96-117`. Any added paid cells need to fit the approved cap; this review grants no increase.

4. **High | E1 date decision rule: an absolute score is not the paired date effect.** Reading 1 calls `chunk-dated` minus its identical-selection undated twin the estimate, then implements “recovers half the gap” as at least 50 correct dated answers. If the twin already gets 50 correct, a zero date effect still passes that rule. Conversely, a date effect of 25 points from a lower twin baseline can miss the absolute threshold. **Concrete fix:** preregister the paired difference itself, approximately 24.5 percentage points if the historical 49-point temporal gap is the reference, and report the twin and dated scores plus the paired interval. Separately report absolute recovery relative to the historical score without calling it a date-only effect. **Evidence:** `P:481-484,526-531`; `H:eval/runner/systems/render.ts:79-89` shows why the dated selection can differ from the original undated pack.

5. **High | C2 hard cap: enforcing the allocator budget is not enforcing the final output budget.** `searchOutput` runs redaction and explicit snippet capping after `deliverEvidence`. `capDeliveredSnippets` appends an uncapped recovery marker and updates `tokens_delivered` but not `budget_used`; a short block can grow rather than shrink. The proposed contract includes omission markers and final output, so the current finalizer can violate it even after a correct allocation. **Concrete fix:** for the new explicit-budget query path, apply the final bounded text transformations before the last recount, keep marker overhead inside the allocation, and set `budget_used` from the actual final title/header/body output. Define “all delivered output” as evidence fields rather than silently implying that unbudgeted JSON metadata is included. Test via the public operation with `snippet_chars`, not only by calling the allocator. **Evidence:** `P:329-337,368-376,628-632`; `G:src/core/ops/search.ts:92-103`; `G:src/core/search/evidence-delivery.ts:917-961,988-1019`. Keyless probe: budget 3, reported `budget_used` 3, recounted title plus snippet/marker 18.

6. **High | C1 and guards: header-only byte equality conflicts with a saturated hard cap, and headers move evidence coordinates.** G2 says the entire C1-on response differs only by a header; G3 says the same budget is never exceeded. At a full allocation, a nonempty date header requires either removing body text or exceeding the cap. Also, `delivered.match_spans` uses UTF-16 offsets into `chunk_text`; prepending a header without rebasing those offsets breaks consumers even when the visible text looks right. **Concrete fix:** price the header before selection, shift retained spans by the exact prefix length, preserve unmapped ids, and recount after redaction. Scope header-only equality to frozen selections with reserved header space or unsaturated allocations; separately test tight-budget selection changes rather than asserting impossible universal equality. Make C1's standalone comparison use the same reserved envelope for its on/off twins. **Evidence:** `P:309-323,625-627`; `G:src/core/search/evidence-delivery.ts:62-79,746-783,900-940`; `G:src/core/search/evidence-delivery.ts:988-1013`. This repairs a test invariant; it does not approve shipping C1 in H1.

7. **High | C2 scope and compatibility: the allocator cannot currently distinguish an explicit budget from a default, and it serves more than query.** `EvidencePlan` contains a resolved number and `explicitUnit`, but no explicit-budget provenance or originating operation. `search`, `recall`, `think`, and frozen assembly call the same delivery code. Switching behavior on the numeric budget or on a global config key can change omitted-budget calls and unrelated consumers, despite the stated promise. **Concrete fix:** retain validated budget provenance and explicit eligibility for the new query contract during resolution; thread one resolved policy into allocation rather than rereading global state there. Keep omitted budgets, the bare-budget legacy path, non-auto units, and other operations byte-identical unless separately authorized. Register and validate the new config value using the existing config surface and test unknown values. Give replay an explicit query-equivalent policy rather than accidentally inheriting another operation's semantics. **Evidence:** `P:329-353,622-627,711,717`; `G:src/core/search/evidence-delivery.ts:103-112,186-229,264-267`; `G:src/core/ops/facts.ts:199-204,463-464`; `G:src/core/think/index.ts:526-540`; `G:src/core/config.ts:1403-1408`.

8. **High | C2 minimum-unit rule: three promises cannot all hold for arbitrary budgets and mixed hits.** “Cut at a turn boundary with a counted marker,” “nonempty evidence for every nonempty hit list,” and “never exceed any explicit budget” are incompatible when the budget is smaller than the marker or one turn. The cited allocator actually slices a piece inside a turn. Paying all non-conversation chunks first also conflicts with retaining global rank one when that first hit is a conversation and lower-ranked notes consume the budget. **Concrete fix:** specify global priority before allocation, protect rank one before distributing the remainder, and add two adversarial cases: a leading chat followed by an over-budget note, and budgets of 1 through the minimum header/marker size. The minimum-budget outcome is a **User Challenge**: reject infeasible budgets with a clear error, permit empty evidence with a reason, or relax the marker/boundary promise. Do not silently choose one during implementation. **Evidence:** `P:329-349,368-373`; `G:src/core/search/evidence-delivery.ts:680-726,827-837,894-899`. I recommend defining and rejecting budgets below a documented feasible minimum, but have not applied that contract decision.

9. **Medium | C2-breadth: the experimental intervention is still underspecified, and five hits does not mean five sessions.** “Top k groups that fit with each floor plus a window, k scaled to budget” gives no window target, k rule, tie rule, or handling of unequal session lengths. The search dedup permits two chunks per page, so limit 5 can yield fewer than five conversation groups and is not the same intervention as truncating groups after a limit-25 retrieval. **Concrete fix:** freeze one deterministic breadth rule before paid E2: calculate each group's priced target window from the existing `return_window`/candidate machinery, choose a rank-order group prefix by that cost, then reuse the allocator. State how ties, an oversized first group, and leftover budget work. Record hit count and distinct-group count separately; describe the live limit-5 arm as an existing-knob reference, not proof of this group-allocation mechanism. **Evidence:** `P:344-345,364-366,474,539`; `G:src/core/search/dedup.ts:25`; `G:src/core/search/evidence-delivery.ts:203-206,833-854`.

10. **Medium | Diagnosis and C0 pins: the semantic-cache explanation is false for these builds, and the stated pin channel does not configure the shootout adapter.** The balanced mode advertises a cache default, but `semanticResultCacheAvailable()` returns false and the query wrapper bypasses setup; the direct shootout call does not use that wrapper at all. Also, memory-qa passes `a.config`, not `a.pins`, to `GbrainShootoutSystem`. **Concrete fix:** replace the causal cache claim with the runtime fact that semantic response reuse is suspended in the tested build. Keep cache-off as an explicit future-proof resolved setting, but apply it through the actual adapter config and record the disabled runtime status. Test that required settings and reranker failure metadata reach the new query arm rather than trusting a receipt containing unapplied pins. **Evidence:** `P:123-127,270-277`; `G:src/core/search/query-cache.ts:34-35`; `G:src/core/search/hybrid.ts:1193-1205`; `H:eval/runner/memory-qa/run.ts:504-509`; `H:eval/runner/systems/gbrain.ts:178-187`.

## Decisions table

Auto-decide applies to this review's recommendations only. “Select” means carry the recommendation into the review handoff, not mutate the plan or authorize execution. Completeness means closing the evidence chain; blast radius, reuse, and explicit contracts take precedence over adding another abstraction.

| ID | Class | Decision and alternatives | Disposition |
|---|---|---|---|
| D1 | Mechanical | Version named recipe/capture/render identities rather than overloading `fixed-evidence`. | Select; findings 1 and 2. |
| D2 | Mechanical | Preserve dates and compare the complete consumed evidence, not just the existing fingerprint. | Select; finding 2. |
| D3 | Mechanical | Match reader and retrieval selection for causal readings; otherwise label the result composite. | Select; finding 3. Additional spend is not approved. |
| D4 | Mechanical | Use the paired date delta for a date-effect threshold, not the dated arm's absolute score. | Select; finding 4. |
| D5 | Mechanical | Make the cap true at the final evidence boundary, including snippets, dates, markers, spans, and recounts. | Select; findings 5 and 6. |
| D6 | Taste | Implement the query-only `cap_only` boundary first, then reuse it for the family, rather than implement three strategies before the contract is tested. | Select for ordering; findings 7 and 9. Does not remove approved experiments. |
| D7 | User Challenge | For infeasible tiny budgets, prefer a documented validation error over an empty result or weakening the marker/boundary guarantee. | **Not applied.** Needs a product-contract choice under G1; finding 8. |
| D8 | Taste | Use a fixed priced-window prefix for the breadth candidate rather than an unspecified budget-dependent k heuristic. | Select as a concrete preregistration proposal; finding 9. |
| D9 | Mechanical | Report cache suspension accurately and wire settings through the path that consumes them. | Select; finding 10. |
| D10 | User Challenge | Existing G1-G8: hard-cap contract, experiment budgets/scope, candidate direction, bundle evidence, facts funding, legacy unit behavior, and frontier coverage. | **Unchanged and not applied.** This review is not Garry's answer. |

## Architecture diagram: real files to add or change

Legend: `[C]` change an existing file, `[A]` add a proposed file, `[R]` reuse unchanged. Names marked `[A]` do not exist yet.

```text
gbrain-evals: E1 first, no gbrain allocation change

[C] eval/runner/memory-qa/arms.ts
    named recipes + renderer/selection identity + stable replay keys
             |
             v
[C] eval/runner/memory-qa/run.ts
    one brain/ingest, resolved settings, capture drain, delivery receipts
    separate upstream recall from delivered and packed source coverage
       |                        |                         |
       v                        v                         v
[C] systems/gbrain.ts     [C] systems/render.ts      [R] memory-qa/outcomes.ts
    query adapter            pseudo-session pack        errors / service score
    dated/twin mappings      exact consumed bytes   [R] memory-qa/qa.ts
    retained old adapter     fixed-selection twin       reader / judge / cache
       |                        |
       v                        v
[C] systems/types.ts     [R] memory-qa/arms.ts ContextStore implementation
    typed delivery and       (identity caller changes; do not rewrite history)
    upstream receipt

[R] gbrain-under-test.ts + importGbrain -> explicit loaded c5fb0201 identity
[R] budget-ledger.ts + existing provider meter -> per-cell hard spend guard
[R] memory-qa/corpus.ts + systems/sanitize.ts -> opaque ids, no gold leakage
[A] test/eval/budgeted-delivery.test.ts -> new recipe/receipt/renderer cases
[C] test/eval/memory-qa-arms.test.ts -> collisions, resume and reader-only replay
[R] test/eval/memory-qa-golden.test.ts -> unchanged legacy contract
[A] docs/benchmarks/<dated-budgeted-delivery-preregistration>.md
    new arms, matched readings, build identities, failure and spending rules

gbrain: C2 after E1 and the applicable owner decisions

[C] src/core/config.ts -> validated, opt-in auto-packing setting
             |
             v
[C] src/core/ops/search.ts -> explicit query eligibility / final output boundary
             |
             v
[C] src/core/search/evidence-delivery.ts
    EvidencePlan provenance -> shared allocator(policy) -> final counted evidence
    C1 header reservation + span offsets, if separately included
    frozen-hit date projection + complete parity assertions
       |                            |
       v                            v
[R] search/chunk-windows.ts     [R] engine getChunkWindows implementations
    existing authorized fetch      PGLite and Postgres, no new SQL allocation

[C] test/evidence-delivery.test.ts -> cap, snippets, tiny/mixed budgets, spans
[C] test/evidence-delivery-golden.test.ts -> off-path/default identity
[C] test/e2e/evidence-delivery-parity.test.ts -> dates + final-output parity
[R] test/e2e/evidence-delivery-leak.test.ts -> source/protected-body boundary
[C] test/config-search-registry.test.ts -> accepted setting and invalid values
[C] docs/evidence-delivery.md + CHANGELOG.md -> contract in the same product PR

Unchanged consumers guarded explicitly:
  src/core/ops/facts.ts (recall)     src/core/think/index.ts (think)
```

The `systems/*` and `memory-qa/*` paths in the first diagram are under `eval/runner/`. Use a compact state diagram in the recipe/preregistration documentation to distinguish frozen retrieval, mapped items, selected items, and final reader bytes; do not introduce an architecture document for a single switch.

## Codepath-to-test diagram

```text
E1 recipe + explicit build
  -> resolve policy/settings
     -> parser/hash mutation tests [keyless]
  -> import the same opaque dated sessions once
     -> legacy golden + sanitizer + ingest-count assertions [keyless]
  -> query handler: captured upstream ids + emitted delivery meta
     -> capture correlation/drain and missing-capture refusal [keyless]
     -> live-vs-frozen title/date/text/span parity [keyless]
  -> adapter items + typed receipt
     -> foreign-source, null-date, empty-text, rerank-failure cases [keyless]
  -> native / pseudo-session / fixed-selection twin
     -> exact serializer budget, prompt hashes, packed ids [keyless]
  -> frozen reader context
     -> replay never calls retrieval; reader-only addition reuses bytes [keyless]
  -> reader + judge + paired outcomes
     -> fake provider + exclusion/error accounting tests [keyless]
     -> matched paid E1, only after approval and preregistration

C2 query params
  -> eligible explicit-budget EvidencePlan
     -> omitted/invalid/bare budget and all other consumers [keyless]
  -> existing authorized batched fetch
     -> private/cross-source/deleted/protected/unsealed cases [both engines]
  -> one allocator with policy
     -> cap-only then breadth/depth properties; mixed/notes-only/tiny budgets
  -> header + redaction + snippet/marker + final recount
     -> header spans and exact final evidence budget [keyless operation tests]
  -> transport row projection
     -> local/full and remote/lean behavior, body parity and metadata checks
  -> dev replay + live checks
     -> frozen-hit invariance, full context serialization, source coverage
     -> live-handler latency, not replay-only latency
  -> H1 only after all gates, one frozen choice, custody and owner approval
```

## Test plan

**Run before paid E1.** Extend `memory-qa-arms.test.ts` and a focused new budgeted-delivery test file using the existing fake system/provider. Assert one ingest per ordinary recipe group, one retrieval per unique resolved call, zero retrievals on reader replay, no key or provider requests in these tests, and unchanged old recipe output. A changed limit, budget, adapter mapping, rendering, source projection, or gbrain commit must not hit an old manifest/context. Corrupt a frozen prompt hash and require a failure, not a paid call using uncertain evidence.

**Make the receipt gate substantive.** Assert values against the operation response, not merely field presence. Preserve `budget_tokens`, `budget_used`, final recounted evidence tokens, before/after harness tokens, exact selected ids, upstream ids, delivery reasons, fallbacks, and runtime cache/rerank status. The current runner copies selected result fields and discards `RetrieveResult.raw` (`H:eval/runner/memory-qa/run.ts:664-676`), so placing diagnostics in `raw` alone does not satisfy the plan. Inject a reranker degradation and prove the cell is refused as intended without converting product service failures into free exclusions.

**Date and rendering cases.** Use multiple chunks from one session, two sessions with equal dates, a null date, an empty chunk, long titles, an unknown source, and a source whose title contains a date different from `effective_date`. A pseudo-session must contain only delivered block text, never rehydrate raw source turns accidentally. Count the exact serialized history after ordering and numbering, including JSON escaping and separators. Native/date-twin reuse requires identical final prompt bytes and the same reader/judge identity; matching source ids alone is insufficient.

**C2 operation matrix.** Exercise explicit and omitted budgets; positive fractions, zero, negative, nonfinite and tiny values according to the chosen validation contract; explicit and implied units; local/full and remote/lean rows; subagent and explicit snippet caps; `page`, `section`, `window`, `chunk`, and `auto`; C1 off/on; and every packing variant. Use mixed notes/chats with global rank one both a note and a chat. Test redaction that grows a field, overlong titles, empty bodies, fragmented matching spans, duplicate page hits, fetch timeout/failure, missing and deleted pages, and a token counter fallback. Check spans against the returned body and recount actual output, not only `budget_used`.

**Security and engine parity.** Extend the existing leak and parity suites, using the repository's isolated Postgres helper and PGLite. Confirm the new policy does not reintroduce cached unauthorized text or widen a source grant; use two sources with the same slug. The local query adapter is a trusted-local measurement, not proof of the MCP trust boundary: remote calls require safe chunks, apply private visibility, and default to lean rows (`G:src/core/ops/search.ts:922-939`; `G:src/core/search/lean-rows.ts:35-50`). Keep those tests even though E1's synthetic corpus is public.

**Performance and spending.** Measure G9 from repeated live handler calls for both baseline and candidate in matched engine/cache conditions. Frozen replay omits retrieval and is not a handler-latency measurement. Reuse per-piece token costs and the single batched fetch rather than repeatedly serializing/recounting every growing window. Add fake-meter tests for reservation exhaustion, retries, dropped-arm order, and resume; the global program cap is not established just because individual cells have ledgers. No heavy full suite or paid benchmark is needed to review this Markdown.

**Dev and held-out.** Freeze one exact breadth rule and a declared candidate family before paid E2; record any E1-driven narrowing explicitly. Apply category/error joins to the same question set and keep upstream recall separate from delivered coverage. Size `B_bench` using the consumed renderer, not raw bodies alone, and verify final serialized contexts again. An empirical maximum token ratio is not a universal bound: if a held-out candidate exceeds it, stop under the preregistered terminal rule, do not tune the budget after seeing the sealed material. Do not read sealed session text, questions, labels, or the custody ledger as part of this review.

### Checks actually run for this review

- Installed the missing gstack host profiles with the supplied installer and reran its health check: both profiles and a real Chromium render passed. No external Codex or Claude Code session was launched; this is the requested Astra outside voice.
- Reran `token-ratio-distribution.py` and `gbrain-rows-profile.py` against the committed replay/result artifacts. Both outputs exactly matched their committed receipt text, including the LoCoMo temporal 25/74 scores and 95/100 upstream all-gold recall. This corroborates the diagnosis, not E1's proposed causal attribution.
- Ran `bun test test/evidence-delivery.test.ts test/evidence-delivery-golden.test.ts test/e2e/evidence-delivery-parity.test.ts` in the cloned gbrain with the three configured provider keys removed: **51 passed, 0 failed, 2,935 assertions**. Only the PGLite parity arm ran; no Postgres service was configured for this review.
- Ran a real-PGLite dated query followed by frozen-hit assembly: date present on the live result, missing on assembly, old fingerprint equal. Ran the exported snippet finalizer on a three-token allocation: reported three, actual eighteen. These are keyless mechanism probes, not quality measurements.
- Ran the current arm parser against a named query policy and pseudo-session context; both were rejected. No implementation claim rests on pretending the new matrix already runs.

## NOT in scope

- Changing the plan, existing approvals, budgets, raw shootout artifacts, held-out exposure records, or any other review file. This deliverable is only this review.
- A new retrieval stack, global experiment scheduler, fact/vector index, extraction model, or database migration for E1/C2. Existing seams cover the work once their evidence contract is explicit.
- C3 ranking/fusion, C4 production fact search, and C5 ordering as prerequisites to cap correctness. Their experiments can follow under the stated separate gates.
- Changing the default 24,000-token budget, changing what a bare `token_budget` means, or broadening C2 to `recall`, `think`, or all operations without approval.
- Benchmark-driven claims about systems beyond the measured kind-labeled rows, paid reruns, model-policy exceptions, sealed-set access, or a default rollout.
- New standalone task JSONL, QA-plan, TODO, or review-log files. The requested single-file output contains those review sections; it does not claim a complete orchestrator-level gstack approval record.

## What already exists: reuse map

| Existing code | Reuse rather than rebuild | Gap this review requires closing |
|---|---|---|
| `H:eval/runner/systems/gbrain.ts` | Shared brain lifecycle, opaque session import, old adapters. | Add the new local query path without changing old mappings; merge settings through the actual config channel. |
| `H:eval/runner/memory-qa/arms.ts` | Arm expansion, ContextStore, frozen contexts and reader-only replay. | Named recipes, collision-safe identities, exact required matrix instead of an uncontrolled Cartesian expansion. |
| `H:eval/runner/systems/render.ts` and `memory-qa/qa.ts` | Prefix packers, frozen native/rehydrated prompts, readers and judges. | A separate delivered-block pseudo-session transform and fixed-selection twins with exact serialized accounting. |
| `H:eval/runner/memory-qa/run.ts` | Sanitization, metering, per-question outcomes, manifests and retry handling. | Pre-delivery evidence identity, delivery metadata propagation, distinct upstream/delivered/packed coverage. |
| `G:src/core/eval-capture.ts` | Ordered pre-delivery chunk-id capture and a drain helper. | A correlated, fail-closed harness capture adapter; do not infer missing rows from the delivered result. |
| `G:src/core/search/evidence-delivery.ts` | Plan resolution, grouping, authorized fetch, candidate pieces, allocator, spans, frozen-hit assembly. | Budget provenance, final cap policy, date-preserving replay, header accounting, complete parity. |
| `G:test/evidence-delivery*.test.ts` and `test/e2e/evidence-delivery-*.test.ts` | Existing property, off-path, source-leak, and engine-parity coverage. | Extend dated metadata and final-transform assertions; the old fingerprint and green suite miss both demonstrated traps. |
| `H:eval/runner/memory-qa/run.ts:619-644,756-774` | Production extraction and saved-facts artifact for the probe. | Count facts bytes now; later add stable fact ids and budgeted facts packing. It remains a separate lane, not query-ranked fact search. |

The reusable frozen-hit API reduces the implementation surface, but its current date omission prevents claiming full presentation parity. That is a repair to make before choosing it as the experiment's evidence oracle.

## Failure modes registry

“Critical gap” here means a new path could fail silently with neither a specified rejecting check nor adequate existing test coverage. It does not mean the reviewed implementation has already shipped.

| Path / failure | Current handling or coverage | Required handling and test | Status |
|---|---|---|---|
| New recipe resumes the wrong retrieval/prompt because limit or mapping is absent from the key. | Existing keys encode only old dimensions. | Hash-mutation and stale-manifest refusal tests; reader-only replay remains reusable. | **Critical gap 1** |
| Frozen assembly loses the date but the parity fingerprint passes. | Existing parity tests pass on undated fixtures and fingerprints without dates. | Dated real-engine probe becomes a regression; compare consumed fields and final prompt hashes. | **Critical gap 2** |
| Allocator passes but a later snippet/header/redaction transformation breaks the cap or spans. | Some redaction coverage exists; snippet growth leaves `budget_used` stale. | Final-operation recount and UTF-16 span checks, including tiny budgets and expanding markers. | **Critical gap 3** |
| Query capture is absent, late, or correlated to another call. | Capture swallows failures by design. | Isolated per-query correlation, drain, and fail-closed missing-capture status. | Explicit E1 prerequisite |
| Delivery diagnostics are put in `raw` and disappear from canonical rows. | Runner discards `raw`. | Typed receipt propagation with value assertions, not presence-only checks. | Explicit E1 prerequisite |
| Fetch fails or a page becomes unreadable. | Existing fallback reasons and live/cached distinction; leak tests exist. | Preserve authorization; separately count product degradation and test the capped fallback. | Existing coverage, extend |
| Global config changes `think`/`recall` or omitted-budget output. | Existing off-path golden catches some cases, not new flag combinations. | Explicit eligibility and byte-equality matrix for every unaffected consumer. | Compatibility gate |
| Tiny budget cannot fit date/marker/turn, or notes crowd out leading chat. | Old allocator slices pieces; proposed promises conflict. | Owner settles feasible-minimum contract; mixed global-rank tests prevent silent choice. | User Challenge D7 |
| Query adapter uses trusted-local semantics but claims MCP equivalence. | Existing remote tests and lean projection are separate. | Label the measurement local; run remote/full/lean source-safety parity tests. | Scope disclosure plus tests |
| Candidate fits sampled token ratio but not a different rendering or held-out text. | Plan records packer cuts but sample maximum is not a proof. | Final serializer assertion, terminal guard failure, no held-out retuning. | Preregistered failure outcome |
| Reranker degrades or ledger refuses mid-cell. | Meter/outcome mechanisms exist; new adapter is not wired yet. | Inject failures; preserve denominators and reservations, refuse mislabeled arms. | Extend current fake-provider tests |
| Replay looks fast while the live handler regresses. | Replay bypasses retrieval. | Matched live-handler p95 measurement separate from replay timing. | Performance gate |

## Ordered implementation tasks

Estimates compare a human engineer working manually with CC plus gstack on prepared machines. They are engineering effort, not provider/VM runtime or approval latency; provenance, authorization, and statistical work do not become hundredfold faster because typing is automated. None of these tasks is authorized for execution by this review.

| Order | Priority | Task, source finding and files | Verification | Human / CC effort |
|---|---|---|---|---|
| T1 | P1 | Amend the experiment contract: matched readings and paired date threshold; define named recipes, one exact breadth rule, and the unresolved tiny-budget choice. Findings 1, 3, 4, 8, 9; `PLAN.md` and the new preregistration, by the plan owner. | Every causal subtraction has one reader and fixed evidence identity; owner decisions remain explicit. | 3 h / 45 min |
| T2 | P1 | Add bounded recipe identities and receipt fields in `arms.ts`, `run.ts`, `systems/types.ts`; wire the actual config settings. Findings 1, 10. | Parser, hash-mutation, restart, fake-meter, and reader-only replay tests. | 8 h / 2 h |
| T3 | P1 | Add the query adapter and correlated pre-delivery capture in `systems/gbrain.ts` and `run.ts`; retain the legacy/shootout adapters. Finding 2. | Keyless live query, complete captured ids, capture failure refusal, unchanged old goldens. | 8 h / 2 h |
| T4 | P1 | Add pseudo-session and fixed-selection date-twin rendering in `systems/render.ts`, with exact accounting and tests. Findings 3, 4, 6. | Prompt byte comparisons, null/equal dates, duplicate sources, escaping and boundary packs. | 6 h / 90 min |
| T5 | P1 | Freeze and validate E1 preregistration, build identities, keyless accounting, and approved spend reservations; only then run paid E1. Findings 1-4, 10. | All receipt fields checked; reproduction and failure rules applied before interpretation. | 3 h / 45 min, plus approved run time |
| T6 | P1 | After E1 and G1, implement explicit query eligibility plus the final cap-only boundary in `ops/search.ts`, `search/evidence-delivery.ts`, and `config.ts`. Findings 5, 7, 8. | Operation-level final recount, tiny/mixed cases, snippets, default/off-path goldens, registry checks. | 12 h / 3 h |
| T7 | P1 | Implement C1 accounting/span changes if included, and repair frozen-hit date projection and full parity tests. Findings 2, 5, 6. | Dated live/replay equality, shifted UTF-16 spans, redaction, both-engine parity/leak suites. | 8 h / 2 h |
| T8 | P2 | Add the preregistered breadth/depth parameters to the same allocator after cap-only tests pass; preserve single-fetch/token-cost reuse. Findings 7, 9. | Deterministic rank/group tests, cap invariant for every variant, live p95 comparison. | 8 h / 2 h |
| T9 | P1 | Run approved E2 and prepare one frozen H1 candidate with docs and decision records; no custody request until all guards pass. Findings 3, 5-9. | Complete dev verdict, frontier check, actual handler latency, exact serialization, terminal outcomes. | 4 h / 1 h, plus approved runs/custody |

**Parallelization.** T1 fixes the contracts first. T2 and T3 share `run.ts` and must be sequenced in one harness lane; T4 can run in a separate rendering worktree after T2 defines the interfaces, then integrate before T5. T6 and T7 share the delivery module and stay sequential; T8 follows them. Independent test-fixture authoring can overlap product work, but no branch should simultaneously commit to the same shared worktree. T9 waits for the product and harness integrations, not merely separate green unit suites.

## Completion summary

The independent engineering review is complete with concerns: 10 findings, three critical untested failure paths, and one newly explicit User Challenge about infeasible tiny budgets. The plan's existing G1-G8 remain untouched. Scope challenge, both-repository architecture, codepath-to-test mapping, test plan, reuse map, failure registry, and ordered effort estimates are included in this file.

The diagnosis receipts reproduce exactly, and 51 focused existing tests pass; those passes do not validate the proposed arm matrix or the new hard-cap contract. The date-loss and snippet-growth probes demonstrate why the added tests are necessary. No paid calls, held-out access, Postgres parity run, implementation changes, or external CLI review were performed; no other review was read.

The durable engineering lesson is that byte-equal bodies or an existing evidence fingerprint do not establish equality of what the reader consumes: dates, titles, final transformations, and replay identities are part of that contract. It is recorded here only, honoring the single-file output restriction. The next action is for the plan owner to incorporate the mechanical corrections and selected implementation ordering while leaving User Challenges for Garry.
