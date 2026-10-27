INPUT: eng 403b69541ac1ce10f461eb9f93376e42691e97a654bd271d95854003f527032f

# Eng review (native voice): low-hanging-fruit wave (items 1, 1b, 2, 3, 4, 5)

Reviewed against gbrain master `da434385` (v0.60.175.0) and gbrain-evals `a89535fc`. The input file's SHA-256 and byte count match the prompt (18,005 bytes).

**Verdict.** The plan is sound and much tighter than the versions the CEO and DX phases saw. Most consensus findings are folded in: the trailers stay, Opus is no longer optional, item 3 avoids keyless spam, item 4 profiles first, the picker reads keys through `mergedProviderEnv`, the op-path harness is costed, and llms regeneration is listed. Five gaps would still cause trouble at implementation or merge time:

- **1b's model-visible tool descriptions.** The plan updates the `expand` param string but misses the `QUERY_DESCRIPTION` / `SEARCH_DESCRIPTION` routing text, which promises that `query` expands.
- **The op-local `expand` variable in 1b.** It feeds CRAG escalation and eval capture/replay, and both change meaning when the mode decides expansion.
- **A side effect of item 1.** `search.mode=tokenmax` also turns on a paid nightly probe, and that isn't disclosed.
- **The external validity of item 1's paid gate.** The rerank-pool change reaches all ~6,000 Cat 40 `search` calls, and LongMemEval-S haystacks are small.
- **No validity rule for degraded arms in the four-arm run.**

None of these blocks the wave. Each is a bounded fix to the plan.

---

## Step 0: Scope challenge

### A. Assessment

The six items are independent in purpose and mostly S effort, and the plan ships only the items whose gates pass. Two items are larger than their labels: 1b, because of the description and contract surfaces plus the op-path harness (M, which the plan admits), and item 5 if it keeps eval capture (that needs a schema migration, see F10). The scope is right for one fix-wave PR as long as item 5 drops the capture column.

Reality rows. I checked each claim the plan rests on against the code:

REALITY: picker returns tokenmax for every chat-key install unless Haiku — VERIFIED `src/commands/init-mode-picker.ts:67-91`
REALITY: no-chat-key → conservative even with Voyage key — VERIFIED `src/commands/init-mode-picker.ts:76-81`
REALITY: picker reads raw process.env — VERIFIED `src/commands/init-mode-picker.ts:117-123`
REALITY: picker idempotent; JSON and non-TTY apply silently — VERIFIED `src/commands/init-mode-picker.ts:205-236`
REALITY: `search` passes `expansion: false` and defaults to 20 — VERIFIED `src/core/ops/search.ts:692,763-766` (plan cites :756-775; drift only)
REALITY: `query` sets `expand = p.expand !== false` and forwards it with `expandFn` — VERIFIED `src/core/ops/search.ts:868,989-990`
REALITY: per-call expansion beats the mode bundle — VERIFIED `src/core/search/hybrid/request.ts:103-106`
REALITY: bundles: balanced 25 / 12,000 / rerank 25 / title; tokenmax 50 / none / rerank 50 / per_chunk_synopsis / expansion on — VERIFIED `src/core/search/mode.ts:494-605`
REALITY: rerank pool comes from the resolved mode — VERIFIED `src/core/search/hybrid/rank.ts:263-269`
REALITY: inline import demotes per_chunk_synopsis to title — VERIFIED `src/core/import-contextual-mode.ts:33`
REALITY: LME 451 balanced vs 442 tokenmax (opaque ids) — VERIFIED gbrain-evals `docs/benchmarks/2026-10-04-longmemeval-opaque-followups.md:44-53`
REALITY: eval-longmemeval calls the core library — VERIFIED `src/commands/eval-longmemeval.ts:117,1437` (the file is in **gbrain**; gbrain-evals drivers import it from the pinned package, `driver-retrieval.ts:10`)
REALITY: narrowing copy promises a cache refill — VERIFIED `src/core/search/mode-switch-ux.ts:139-147`
REALITY: first-run cost matrix names Haiku 4.5 / Sonnet 4.6 / Opus 4.7 — VERIFIED `src/commands/init-first-run.ts:38-40`; upgrade banner still recommends tokenmax — VERIFIED `src/commands/upgrade.ts:904-931`
REALITY: modes-report says query always expands — VERIFIED `src/core/search/modes-report.ts:29,98-108`
REALITY: concept hint sends agents to `query` for expansion — VERIFIED `src/core/ops/search.ts:443-444` (plan cites :446-449)
REALITY: `query` tool description promises expansion — **NOT COVERED BY PLAN** `src/core/operations-descriptions.ts:51-55` (F1)
REALITY: lean rows keep `id`; registrations pin `full` — VERIFIED `src/core/search/lean-rows.ts:31`, `src/core/mcp-registration.ts:24`
REALITY: `PER_CALL_NOTICE_CODES` omits degraded_recall; dedupe key is session+code — VERIFIED `src/core/notice-ledger.ts:26,73`
REALITY: keyless search degrades with embed_unavailable — VERIFIED `src/core/search/hybrid/keyword-only.ts:96-104`
REALITY: entity names builds a card per name; CONCURRENCY 8 — VERIFIED `src/core/verbs/entity-names.ts:21,41-51`
REALITY: candidate selection region — VERIFIED `src/core/verbs/entity-card.ts:207-316`
REALITY: bench script exists, stub embed/rerank — VERIFIED `scripts/bench-refactor-wave-1.ts:23,88-89,252-257`
REALITY: #6445 not yet on master — VERIFIED (`git log --grep '#6445'` empty at `da434385`)
REALITY: facts extraction already Haiku 5.5 — VERIFIED `src/core/facts/extract.ts:66`

### B. Selectors

- **Scope:** ui=no, dx=yes, perf=yes, security=light. The wave adds no new auth surface. The remote/owner boundary matters for item 1's notice and item 5's `_meta`.
- **Complexity:** about 25–35 files including docs and generated artifacts. That's above the 8-file smell, but the items are disjoint, and the churn is generated files, docs and tests.
- **Reuse:** the plan reuses the right modules (mode bundles, notice ledger, error registry, behavior-change table). It misses three reusable pieces: the behavior-change per-brain marker store (F7), `dispatchRenderContext(...).isCallable` (F8) and `rerankerReadinessForEngine` (F14).

### C. Findings summary

| # | Sev | Item | One line |
|---|---|---|---|
| F1 | High | 1b | `QUERY_DESCRIPTION`/`SEARCH_DESCRIPTION` promise query = expansion; the plan updates only the param string |
| F2 | High | 1b | Op-local `expand` also drives CRAG `callerExpanded` and eval capture → replay forces expansion |
| F3 | High | 1 | tokenmax also default-enables the paid nightly conversation-parser probe; undisclosed |
| F4 | High | 1 | Rerank pool 25 vs 50 reaches every Cat 40 `search`; LME-S small haystacks may not show the harm |
| F5 | High | 1/1b | Four-arm run has no validity rule for degraded arms, no sign or interval method, and no recorded op context |
| F6 | Medium | 3 | Signature dedupe still hides a recurrence of the same transient failure for 24 h; Notice has no key field |
| F7 | Medium | 1 | Owner notice breaks the "one muteable ask" invariant; mute is machine-global; no auto-vs-chosen provenance |
| F8 | Medium | 2 | Projection runs in the op handler without the callable predicate; callable ≠ advertised; rounding scope contradicts |
| F9 | Medium | 5 | Stages overlap; `other = total − Σ` makes the gate tautological and can go negative |
| F10 | Medium | 5 | Timings "in eval capture" need a schema migration; Cat 40 receipts don't read capture |
| F11 | Medium | 4 | Misses run a full FTS per name; per-name invariants; extraction alone may not halve p50 |
| F12 | Medium | 1b | Harness lives in gbrain, not gbrain-evals; the measurement branch and ship decision are undefined |
| F13 | Low | 1b | More stale "query expands" surfaces: tune-recommendations, top-help, TOOL_REFERENCE |
| F14 | Low | 1 | `--search-mode` vs idempotency on existing brains; rerank detection should use reranker readiness |
| F15 | Low | 1b | `mode.ts:128-131` cites a superseded 54.89% expansion receipt |
| F16 | Low | 1b | CRAG escalation counts will be zero (escalation off by default) |
| F17 | Low | meas. | Cat 40 mode pin value unspecified (continuity vs new default) |
| F18 | Informational | 5 | Per-stage timings to remote callers are a small timing side channel |

---

## Prior-phase consensus: what the plan absorbed

CEO native 1–3, 5, 6, 9, 10, 11, 13 and 14 are addressed. Trailers stay, item 2's paid round is gone, the `id` surface rule is defined, Opus is required in later rounds, there's an existing-brain notice, it waits for #6445, the evidence citation is fixed, and the latency ordering is in NOT in scope. CEO native 7 (the item 4 root cause) is addressed by "profile first", but the miss path is still unexamined (F11). CEO outside 1 (non-inferiority) and 4 (mode claims) are addressed. Outside 7 (identity-resolution semantics) is partly covered by the adversarial parity set.

DX native 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12 and 13 are addressed. The plan rewrote the expansion contract test, kept `expandFn`, dropped per-call degraded spam, switched to `mergedProviderEnv`, fixed the cache copy, added `--search-mode`, fixed the fetch refusal, defined `total`, costed the harness, added llms regeneration, used significant digits and recorded the mode. DX native 4 / outside 2 (the ask notice) are reworked into a new `ask` code, but it collides with an existing invariant (F7). DX outside 3 (the search hint) is listed. DX native 14 is resolved by the extraction design.

---

## 1. Architecture review

### Mode resolution and the 1b decision point (after the change)

```
query op (src/core/ops/search.ts:866)
  p.expand ──┐
             │  undefined → defer to mode       explicit true/false → wins
             ▼
  hybridSearchCached(opts.expansion = p.expand, expandFn = p.expand===false ? undefined : expandQuery)
             │
             ▼
  resolveSearchMode (hybrid/request.ts:96-110)
     perCall.expansion ?? config search.expansion ?? MODE_BUNDLES[mode].expansion
             │
             ├─► meta.expansion_applied  ──► CRAG callerExpanded   (search.ts:1067)   ← F2: must read this,
             │                           ──► eval capture           (search.ts:1181)     not the op-local `expand`
             │                                   └─► eval-replay forces expansion (eval-replay.ts:267)
             └─► rerank pool = reranker_top_n_in (rank.ts:263)  ← item 1 changes 50→25 on every `search` (F4)

search.mode=tokenmax side effects outside retrieval (F3):
  autopilot-probes.ts:103, nightly-probe.ts:113, local-audits.ts:348  → nightly parser probe default-on (~$0.05/night)
  sync-cost-gate.ts:591                                              → spend-posture hint text
```

**F1 (High): the model-visible description promises expansion.** `QUERY_DESCRIPTION` (`src/core/operations-descriptions.ts:51-52`) opens with "Hybrid search plus multi-query expansion for concept/landscape questions (expansion recovers synonyms)". `SEARCH_DESCRIPTION` (`:54-55`) routes "Concepts/landscape: `query`". These strings are the agent's main routing signal, and every session loads them. The plan's surface list names only the `expand` param string (`search.ts:842`) and the concept hint.

After 1b, on a `balanced` brain (the new default), `query` won't expand unless asked. The descriptions would then be confidently wrong in the default configuration. They're generated into a static manifest, so they can't vary by mode.

Fix: reword both mode-neutrally, for example "Hybrid search with larger, budgeted results; multi-query expansion runs when the brain's search mode enables it or with `expand: true`". Regenerate `operation-manifest.generated.ts` (`bun run build:operation-manifest`) and `docs/mcp/TOOL_REFERENCE.md`, and rerun the starter-surface size-budget tests. Name the routing-text change in the BEHAVIOR_CHANGES row. Because a description change shifts agent routing between `search` and `query`, the keyless gate should add a byte-diff check of the advertised tool list for `starter` and `full`.

**F2 (High): `expand` has three consumers, not one.** The plan rewires only the forward at `:989-990`. The same variable also feeds:

- (a) `shouldEscalateRetrieval({ callerExpanded: expand })` at `search.ts:1067`;
- (b) eval capture `expand_enabled: expand` at `:1181`, which `eval-replay.ts:267` replays as `expansion: row.expand_enabled ?? false`.

If the implementation keeps `expand = p.expand !== false` for these uses, CRAG treats every default balanced call as "already expanded", so escalation can never fire. Every captured query would also replay with forced expansion, which makes the `gbrain eval export/replay` workflow in AGENTS.md diverge from production and spend Haiku calls. If the implementation instead fixes (a) properly, users with `search.crag_escalation=true` start paying for an expansion plus rerank re-run on weak balanced queries. That's a user-visible change the plan doesn't list.

Fix: derive `expansionApplied` from `capturedMeta.expansion_applied` for CRAG. Capture the raw `p.expand` (null when unset) and keep `expansion_applied`. Make eval-replay map a null `expand_enabled` to "mode decides" (omit `expansion`). Add a BEHAVIOR_CHANGES sentence for `crag_escalation=true`, and unit-test all three.

**F3 (High): tokenmax isn't only a retrieval bundle.** `search.mode === 'tokenmax'` default-enables the conversation-parser nightly probe (`src/core/conversation-parser/nightly-probe.ts:113`, `src/commands/autopilot-probes.ts:103`, `src/commands/doctor/checks/local-audits.ts:348`). Its header (`nightly-probe.ts:16`) prices it at about $0.05/night of Haiku polish. It also changes a sync-gate hint (`src/core/sync-cost-gate.ts:591`).

Flipping the recommendation stops this probe on every new install. The plan doesn't list that, and the existing-brain notice's "what switching gives up" omits it. Under the coordinator contract, a user-visible change missing from the PR body is a Critical review finding.

Fix: list it under `## Behavior changes` and in the BEHAVIOR_CHANGES row. Add it to the existing-brain notice's give-ups, and extend the fresh-init receipt test to assert the probe's effective enablement per mode. Decide explicitly whether the probe should stay mode-coupled; decoupling it is out of scope, but the decision belongs in the plan.

**F7 (Medium): the owner notice collides with an existing invariant.** "The one muteable ask" is hard-coded in `src/core/notice-ledger.ts:24-25`, `src/core/ops/notices.ts:11-12,29` (the user-facing refusal text), `src/core/error-registry.ts:501`, and the Mute paragraph of `docs/protocol/AGENT_OPERATOR_v1.md`.

Three related problems:

- The mute store is machine-global under GBRAIN_HOME (`notice-ledger.ts:100-104`), not per brain.
- "Once per brain" plus "muteable" is redundant: if it shows once, muting does nothing; if the agent fails to relay it, it's gone.
- `search.mode` stores no provenance (only `SEARCH_MODE_KEY`, `mode.ts:1523`), so the notice can't tell an operator who deliberately chose tokenmax from an auto-pick.

Fix:

- Reuse the behavior-change per-brain × channel `wx` marker store (`src/core/behavior-change-notice.ts:39-44`) for once-per-brain delivery.
- Write `search.mode_source=auto|operator` from now on (the picker writes `auto`; `config set` and `init --search-mode` write `operator`), and skip the notice when it's `operator`.
- Either make the notice kind `coaching` (already muteable, already owner-only on stdio) or update the invariant text in all four places and its tests.
- Make sure a tokenmax brain's first session doesn't get both the BEHAVIOR_CHANGES row and the ask saying the same thing.

**F8 (Medium): item 2's projection has no surface information.** `projectRows` runs inside the op handler (`src/core/ops/search.ts:119,129`) and only knows `lean|full`. The callable predicate lives at dispatch (`src/mcp/dispatch.ts:989`, `dispatchRenderContext(opts).isCallable(...)`).

gbrain also separates the **callable** surface from the **advertised** one (`mcp.advertised_surface`; gbrain-evals `eval/runner/cat40/gbrain-arm.ts:258`). With `full` callable and `starter` advertised, `fetch` is callable but unlisted. Keying on callable keeps `id` there, which is fine, but it has to be tested.

The plan also contradicts itself on rounding. "Score rounding reaches everyone" conflicts with the BEHAVIOR_CHANGES text "local CLI and the thin client are unchanged".

Fix: thread one `isCallable(op)` function into `OperationContext`, built by the same code dispatch uses (stdio session state after `request_tools`, HTTP per-client surface, transport ceiling). Round only inside `leanRow`. Test callable-full/advertised-starter, the HTTP client surface, and stdio `request_tools`.

**F12 (Medium): the harness location is undefined.** The op-path mode goes into `src/commands/eval-longmemeval.ts`, a **gbrain** file (`:117,1437`). gbrain-evals drivers run it from the pinned package (`docs/benchmarks/2026-10-04-longmemeval-opaque-followups/scripts/driver-retrieval.ts:10`). So "Harness (effort M, gbrain-evals)" is really a gbrain change that has to sit on the measurement branch.

The plan doesn't say whether it ships in the fix-wave PR or how it builds the `OperationContext`. `remote` changes `requireSafeChunks` (`search.ts:766,986`), row projection and per-call `mode` acceptance (`ops/context.ts:1203-1212`).

Fix: ship the via-operation mode in the fix wave, since it's reusable and the receipt must be reproducible from a tagged gbrain. Build the context as the agent path does: `remote: true`, stdio transport, owner `sourceId`. Record those fields in each arm's receipt.

---

## 2. Code quality review

- **F6 (Medium, item 3).** The dedupe key is `${session}|${n.code}` (`notice-ledger.ts:73`), and `Notice` has no structured signature. The notice's `why` embeds "reranker-degraded calls this session: N" (`src/core/interop-notices.ts:147-149`), so any key derived from rendered text changes every call and silently turns into per-call.

  There's a semantic problem too. A long-lived stdio session that sees `rerank_failed: timeout`, recovers, and times out again within the 24 h TTL (`notice-ledger.ts:21`) shows nothing the second time. That's the exact symptom TODOS P2 describes, and the transport table (`AGENT_OPERATOR_v1.md:787`) still says "every affected call".

  Fix: make transient stages (`rerank_failed`, `embed_timeout`, `keyword_arm_failed`, `title_arm_failed`) per-call, and dedupe only config-persistent stages (`embed_unavailable` with `no_provider` / `embedding_disabled`). Carry an internal `dedupe_key` on `Notice` (stage labels, sorted, without counters) that renderers never serialize. If the plan keeps signature dedupe, define it per stage label, so `[embed_timeout, rerank_failed]` after `[embed_timeout]` shows only because of the new label.
- **F13 (Low, 1b).** More surfaces say query expands: `src/core/search/tune-recommendations.ts:87` ("It does not disable query expansion"), `src/cli/top-help.ts:44` ("Hybrid search (RRF + expansion)"), `docs/mcp/TOOL_REFERENCE.md`, and the picker strings at `init-mode-picker.ts:137,167,264`. Add a guard test that fails on the phrases "in every mode" / "always expands" in `src/` and `docs/`.
- **F14 (Low, 1).** Define what `gbrain init --search-mode X` does on an existing brain. The picker is idempotent at `:205-211`, so the flag must either force or refuse with a message. Register the flag (`cli-flag-registry.generated.ts`). For `hasRerankKey`, prefer `rerankerReadinessForEngine` (`src/core/ai/reranker-readiness-engine.ts:29`, already used by modes-report) over a key-name check, since the reranker model is configurable (`DEFAULT_RERANKER_MODEL = 'voyage:rerank-2.5'`, `src/core/ai/defaults.ts:19`).
- **F15 (Low).** `src/core/search/mode.ts:128-131` still cites "plain hybrid 93.19% vs hybrid + LLM expansion 54.89%". The opaque-id re-measure moved that arm from 255 to 436 of 470 (gbrain-evals followups `:48`). Update the comment in the same PR, or a reviewer of 1b will read it as evidence the plan understated.
- Item 4's extraction should return a typed `{ best, runnersUp, excludePrivate, entityTypes }` so `buildEntityCard` and `entity-names` share one resolver, as the plan says. Avoid the two `resolveExcludePrivatePages` calls per name (`entity-names.ts:59-60` plus `entity-card.ts:214-215`).

---

## 3. Test review

### Coverage diagram (new and changed paths)

```
item 1  recommendModeFor(hasChatKey, hasRerankKey, model)     [plan: matrix tests ✓]
        resolveInputs via mergedProviderEnv (config-file key)  [plan ✓]
        init --search-mode on fresh / existing brain           [GAP: existing-brain semantics, F14]
        first-run JSON decision + cost strings from pricing    [plan ✓]
        upgrade banner (upgrade.ts:904-931)                    [plan ✓]
        owner notice: once per brain, stdio+CLI, never HTTP    [plan ✓] + operator-chosen suppression [GAP F7]
        nightly probe effective enablement per mode            [GAP F3]
item 1b query default follows mode; explicit wins; tokenmax    [plan ✓ contract test rewrite]
        CRAG callerExpanded from expansion_applied             [GAP F2]
        eval capture expand_enabled null + replay mapping      [GAP F2]
        description/manifest byte check, starter size budget   [GAP F1]
item 2  id present: fields full / fetch callable / request_tools  [plan ✓]
        callable-full + advertised-starter; HTTP client surface   [GAP F8]
        rounding only in lean rows; tie test                       [plan ✓ tie test; GAP scope]
item 3  embed_timeout → rerank_failed shows two                 [plan ✓]
        same transient failure twice in one session shows twice [GAP F6]
        keyless: one notice per session                          [plan ✓]
item 4  byte parity both engines + adversarial set               [plan ✓]
        miss-heavy batch (all names unknown) latency             [GAP F11]
item 5  Σstages + other = total                                  [tautological, F9]
        degraded / empty responses carry fields                  [plan ✓]
        fan-out query (alias names) timing aggregation           [GAP F9]
```

### Test plan (additions to the plan's gates)

1. `test/search/operation-expansion-contract.serial.test.ts` (rewritten). Balanced `query` with `expand` unset makes 0 expansion calls. `expand: true` makes 1. Tokenmax unset makes 1. `search.expansion=true` on balanced makes 1, which is the "previously inert" warning path.
2. A CRAG unit test. With `search.crag_escalation=true`, a weak balanced query with expand unset escalates exactly once. A weak query with `expand: true` doesn't escalate.
3. An eval-capture round trip. A balanced query with expand unset captures `expand_enabled = null` and `expansion_applied = false`, and `eval replay` reproduces it with no expansion call (stub expander call counter = 0).
4. A manifest snapshot: `QUERY_DESCRIPTION` / `SEARCH_DESCRIPTION` contain no unconditional "expansion" claim, and the starter size budget holds.
5. A picker matrix with 3 models × chat key {y, n} × rerank-readiness {y, n} × key location {env, config.json}, asserting mode, reason and the `auto` flag.
6. A per-mode fresh-init receipt, adding the nightly probe enablement and `search.mode_source`.
7. Owner notice. Show it on a tokenmax brain with `mode_source` unset or `auto`, and suppress it for `operator`. Check once per brain × channel across two processes (marker file), never on HTTP, and no double messaging with BEHAVIOR_CHANGES.
8. Item 2 projection over five contexts: stdio starter, stdio starter plus `request_tools(fetch)`, stdio full-callable/starter-advertised, HTTP client with a starter row, and `fields: "full"`. `fetch` on a slug colliding across two sources returns `ambiguous_id` with the new text.
9. Item 3, in one stdio process: `rerank_failed:timeout` → success → `rerank_failed:timeout` shows two notices (fails today, passes after). Two keyless searches show one.
10. Item 4: parity as planned, plus a 20-name all-miss batch and a 10-hit/10-miss batch, timed separately on PGLite `--no-embed`.
11. Item 5. On the bench, `other ≥ 0` and `other ≤ 10%` of `total` on every query. An alias fan-out query reports nested hybrid time once. A degraded keyword-only response has every field (zero-valued where a stage didn't run).

What breaks at 2am Friday: a Voyage 429 burst in the paid run silently turns one arm into fused order and produces a "pass" (F5); a balanced user's captured queries replay with expansion (F2); an agent keeps routing concept questions to `query` "for expansion" that no longer happens (F1).

---

## 4. Performance review

- **Item 4 (F11, Medium).** On a miss, `buildEntityCard` calls `nearMissSuggestions`, which runs a full `engine.searchKeyword` per name (`entity-card.ts:595-602`). A hit runs `loadLinkableTypes` per name (`:293`), arm 2's `slug LIKE '%/x'` with a leading wildcard (no index) plus a correlated `page_retrievals` subquery per row (`:252-262`), and then the full `assembleCard` (facts, timeline, links, counts, `:404-460`). On PGLite all of that is serial.

  Extracting candidate selection removes the `assembleCard` cost on hits only. If the Hard generator's batches are miss-heavy (codes and nicknames), the "≥50% p50 drop" gate can fail even with a correct refactor.

  Fix: profile with a hit/miss split. Hoist the per-call invariants (`loadLinkableTypes`, `excludePrivate`) out of the per-name loop. Reuse the `compiled_truth` that `CardPageRow` already selected instead of re-querying (`entity-names.ts:57-58`). Keep `nearMissSuggestions` on misses for parity. Report the hit/miss mix next to p50.
- **Item 5 (F9, Medium).** Several stages run concurrently: the keyword count spans the whole hybrid call (`search.ts:759` started, `:793` awaited), the lexical arms run under `Promise.all` (`hybrid/arms.ts:73`), expansion embeds run concurrently (`arms.ts:403,434`), and alias fan-out runs more hybrid calls (`search.ts:781`). Defining `other = total − Σ stages` makes the "sum equals total" gate true by construction, and `other` goes negative once overlapped spans are summed.

  Fix: define stages as critical-path wall-clock spans (the time the op was blocked on that stage) and report overlapped work as `overlapped_ms` per stage. Gate on `0 ≤ other ≤ 10% of total`. The `performance.now()` overhead is negligible.
- **Item 1b.** Removing the default expansion call on balanced `query` saves one Haiku round trip per call. The plan reports p50/p95 per arm, which is right. Measure it on the op path, where expansion is serialized before retrieval.
- **Item 2.** It cuts row bytes on lean surfaces only. Its effect on full registrations is rounding only, and the plan already reports both surfaces.

---

## Paid-run design (F4, F5, F16, F17)

**F4 (High).** Item 1's own text says the mode changes ordinary `search` ranking through the rerank pool (`rank.ts:263`). Yet it concludes that Cat 40 Hard can't detect the change, because `query` is only 11 calls. That reasoning covers `query`, not the ~6,000 `search` calls, all of which move from a 50-deep to a 25-deep pool. LongMemEval-S haystacks are about 50 sessions per question, so a 25 vs 50 pool there understates what pool depth does on a world-M brain.

Fix: add a cheap keyless-plus-rerank replay. Take the recorded Cat 40 Hard `search` calls on world M, run them under both modes, and report top-20 overlap, how many rows from pool positions 26–50 reach the top 20, and gold-page hit@5 where the task defines gold. This costs rerank calls only, a few dollars inside the $20 cap. Otherwise, explicitly scope the default flip's evidence to small-haystack retrieval in the preregistration.

**F5 (High).** The preregistration needs:

- (a) A sign for every comparison: treatment minus control, with balanced as treatment for item 1 and expansion-off for 1b.
- (b) The interval method and level, for example a paired bootstrap 95% CI or exact paired intervals; the followups doc uses exact McNemar.
- (c) A validity rule. Each arm records its degraded-stage counts, and an arm with any `rerank_failed` or embed failure is invalid until those questions are rerun under a named repair. The project rules already forbid reruns that change a verdict, so the rule must be written down before the run. This mirrors the "168/168 reranked" check Cat 40 already uses.
- (d) The recorded op context (F12).

**F16 (Low).** `search.crag_escalation` defaults off (`src/core/config.ts:1369`; `search.ts:1055-1067`), so "CRAG escalation counts per arm" will all be zero. Report the CRAG confidence-grade distribution, or enable escalation in a separately labeled arm.

**F17 (Low).** The Cat 40 runner initializes through the non-TTY picker (gbrain-evals `eval/runner/cat40/gbrain-arm.ts:316`, `--non-interactive`), so past rounds ran whatever the picker chose. The plan should name the pin value: tokenmax for continuity with the H4 and cost baselines, or balanced to measure the new default. The next wave's round should state which.

**F18 (Informational).** Per-stage timings in remote `_meta.retrieval` expose slightly more than total latency, for example post-fusion time that scales with filtered private rows. Integer milliseconds in `_meta` only (never in content blocks) keeps the exposure negligible.

---

## Failure modes

| Codepath | Realistic failure | Test in plan? | Handled? | User sees |
|---|---|---|---|---|
| picker via mergedProviderEnv | config.json unreadable at init | partial | swallowed → defaults | conservative instead of balanced; reason string should say so |
| init --search-mode on existing brain | silently ignored (idempotent) | no (F14) | no | operator thinks the mode changed; **silent** |
| owner tokenmax notice | shown to a deliberate tokenmax chooser every brain | no (F7) | no | repeated nag; mute is machine-wide |
| 1b CRAG | escalation never fires / fires newly | no (F2) | no | silent recall or cost change; **silent** |
| 1b capture/replay | replay forces expansion | no (F2) | no | eval baseline drifts; **silent** |
| 1b descriptions | agent routes to query for expansion that doesn't run | no (F1) | no | lower recall on synonym questions; **silent** |
| item 2 id projection | fetch callable but id dropped (predicate mismatch) | partial | refusal text names slug route | one extra call; ambiguous slug needs a re-search |
| item 3 dedupe | same transient failure recurs, no notice | no (F6) | no | fused-order results read as complete; **silent** |
| item 4 extraction | parity break on alias/title collision | yes | gate blocks | none if gated |
| item 5 timings | negative `other`, missing fan-out time | no (F9) | no | misleading latency receipts |
| paid run | rerank 429 inside an arm | no (F5) | fail-open fused order | wrong verdict; **silent** |

Critical gaps (no test, no handling, silent): the 1b CRAG/replay pair, item 3 recurrence, and paid-run arm validity.

---

## NOT in scope (confirmed or added)

- Everything in the plan's NOT-in-scope list stands. Facts reasoning-off, embed-before-lexical, the budgeted hit count, H4, the item 2 paid round, Family E, PGLite type-filter plans and automatic tokenmax migration are correctly deferred.
- Added: decoupling the nightly parser probe from `search.mode` (F3). Disclose it in this wave and decide the coupling separately.
- Added: an expansion-variant budget for tokenmax's legacy expansion. The followups show legacy and 0.25 budgets within a few questions on opaque ids, so it's not urgent.
- Added: the eval-capture timing column (F10). Defer it to a wave with a migration budget.

## What already exists (reuse)

- Per-brain once-only delivery: behavior-change marker files (`src/core/behavior-change-notice.ts:39-44`). Use it for the tokenmax notice.
- The callable predicate: `dispatchRenderContext(opts).isCallable` (`src/mcp/dispatch.ts:989`). Use it for item 2.
- Reranker readiness: `rerankerReadinessForEngine` (`src/core/ai/reranker-readiness-engine.ts:29`). Use it for `hasRerankKey`.
- Hybrid explain trace (`trace?.observe`, 11 sites in `src/core/search/hybrid/`): an existing hook to hang stage timings on.
- `meta.expansion_applied` (`src/core/ops/search.ts:483`): the resolved fact that CRAG and capture should use.
- Pricing (`src/core/model-pricing.ts`) and the bench (`scripts/bench-refactor-wave-1.ts`), as the plan says.

## Worktree parallelization strategy

| Lane | Items | Main files | Conflicts with |
|---|---|---|---|
| A | 1 + 1b | init-mode-picker, init-first-run, upgrade.ts, mode-switch-ux, error-registry, ops/search.ts (query handler 866-1190), operations-descriptions, modes-report, tune-recommendations, eval-replay, docs/search-modes, INSTALL_FOR_AGENTS, RETRIEVAL.md | B (ops/search.ts), C (notice-ledger if F7 keeps `ask`) |
| B | 2 + 5 | lean-rows, ops/search.ts (search handler 680-800, projectRows 119-129), ops/contract.ts, mcp/dispatch.ts, ops/pages.ts, hybrid.ts, scripts/bench-refactor-wave-1.ts | A (ops/search.ts), #6445 |
| C | 3 | notice-ledger, interop-notices, agent-output (Notice type), AGENT_OPERATOR_v1.md | A if F7 lands in notice-ledger |
| D | 4 | verbs/entity-card.ts, verbs/entity-names.ts | none |

D and C run in parallel immediately. B starts after #6445 merges. A can start at once, but it touches different line ranges of `ops/search.ts` than B, so merge A before B, or have B rebase by merge commit. The integrator owns the BEHAVIOR_CHANGES rows, `bun run build:llms`, the manifest regeneration and the version stamp, because all lanes touch those shared tails.

## Unresolved decisions

1. Does the via-operation harness ship in the fix wave, or does it stay measurement-only (F12)? I recommend shipping it.
2. What kind is the tokenmax notice: a new muteable `ask` (invariant change) or `coaching` (F7)? I recommend `coaching` plus `search.mode_source`.
3. Should transient degraded stages be per-call and persistent ones deduped, or does the plan keep signature dedupe (F6)? I recommend the split.
4. Does item 5 keep eval capture, which needs a migration (F10)? I recommend dropping it from this wave.
5. Which mode do future Cat 40 rounds pin (F17)?
6. Does the item 1 default flip also need the Cat 40 `search` replay (F4), or is its evidence explicitly scoped to small haystacks?

## Completion summary

- Step 0: scope accepted with the item 5 trim. 27 reality rows checked: 25 verified (3 with line drift), 1 not covered by the plan (F1), and 1 location correction (the harness lives in gbrain).
- Architecture: 6 findings (F1, F2, F3, F7, F8, F12).
- Code quality: 4 findings (F6, F13, F14, F15).
- Tests: diagram produced, 11 test-plan additions, and 3 critical silent gaps.
- Performance: 2 findings (F9, F11).
- Paid design: 4 findings (F4, F5, F16, F17), plus 1 informational (F18).
- Totals: 18 findings: 5 High, 7 Medium, 5 Low, 1 Informational, 0 Critical.

## Review log

| Phase | Voice | Input | Findings | High+ | Verdict |
|---|---|---|---|---|---|
| eng | native (claude-opus-5-5) | eng 403b6954… | 18 | 5 | approve with fixes (F1–F5 before implementation) |

## Next steps

Fold F1–F5 into the plan text (each is a sentence or two plus a test), then hand to the implementation lanes above. No design review is needed (no UI). Re-check F3 and F2 in the PR's `## Behavior changes` list before review starts.

## Learnings

- In gbrain, `search.mode` gates more than retrieval: autopilot probes and spend hints key on `tokenmax`. Grep `=== 'tokenmax'` before changing a mode default.
- An op-local "caller asked for X" flag often has hidden consumers (CRAG, eval capture → replay). Changing a default means auditing every read of that variable, not only the forward.
- The model-visible tool description (`operations-descriptions.ts`) and the param description are separate surfaces, and both are generated into the manifest.

```gstack-findings
{"id":"F1","severity":"High","title":"1b leaves QUERY_DESCRIPTION/SEARCH_DESCRIPTION promising query = multi-query expansion; plan updates only the expand param string","file":"src/core/operations-descriptions.ts","line":51,"fix":"Reword QUERY_DESCRIPTION and SEARCH_DESCRIPTION mode-neutrally (expansion when the mode enables it or expand: true), regenerate operation-manifest and docs/mcp/TOOL_REFERENCE.md, rerun starter size-budget tests, add a manifest byte check to the keyless gate, name the routing-text change in BEHAVIOR_CHANGES"}
{"id":"F2","severity":"High","title":"1b: op-local expand also drives CRAG callerExpanded and eval capture expand_enabled, which eval-replay replays as forced expansion","file":"src/core/ops/search.ts","line":1067,"fix":"Use capturedMeta.expansion_applied for CRAG; capture raw p.expand (null when unset) plus expansion_applied; eval-replay maps null to mode default (eval-replay.ts:267); disclose the crag_escalation=true behavior change; unit-test all three consumers"}
{"id":"F3","severity":"High","title":"Item 1: search.mode=tokenmax also default-enables the paid nightly conversation-parser probe; flipping the recommendation silently stops it and it is not disclosed","file":"src/core/conversation-parser/nightly-probe.ts","line":113,"fix":"List it in the PR's Behavior changes and BEHAVIOR_CHANGES row, add it to the existing-brain notice's give-ups, assert probe enablement per mode in the fresh-init receipt test, and record an explicit decision on the mode coupling"}
{"id":"F4","severity":"High","title":"Item 1 default flip changes the rerank pool (50→25) on every Cat 40 search call; LongMemEval-S small haystacks may understate the harm and the 'Cat 40 cannot detect' argument covers query only","file":"src/core/search/hybrid/rank.ts","line":263,"fix":"Add a rerank-only replay of recorded Cat 40 Hard search calls on world M under both modes (top-20 overlap, pool rows 26-50 entering top 20, gold hit@5 where defined) inside the $20 cap, or explicitly scope the evidence to small-haystack retrieval in the preregistration","user_challenge":true}
{"id":"F5","severity":"High","title":"Four-arm LongMemEval run lacks comparison sign, interval method, a degraded-arm validity rule and a recorded op context","file":"src/commands/eval-longmemeval.ts","line":1437,"fix":"Preregister treatment-minus-control signs, the CI method/level, per-arm degraded-stage counts with any rerank_failed/embed failure invalidating the arm until a named-repair rerun, and record remote/transport/sourceId of the OperationContext per arm"}
{"id":"F6","severity":"Medium","title":"Item 3 signature dedupe still hides a recurrence of the same transient failure for up to 24h; Notice has no key field and why embeds a per-session counter","file":"src/core/notice-ledger.ts","line":73,"fix":"Make transient stages (rerank_failed, embed_timeout, keyword/title arm failures) per-call and dedupe only config-persistent embed_unavailable; carry an unrendered dedupe_key of sorted stage labels; test failure→recovery→same failure shows twice","user_challenge":true}
{"id":"F7","severity":"Medium","title":"Item 1 owner notice as a new muteable ask breaks the documented 'one muteable ask' invariant; mute is machine-global; no provenance to skip deliberate tokenmax choosers","file":"src/core/notice-ledger.ts","line":25,"fix":"Reuse behavior-change per-brain marker files for once-per-brain delivery, write search.mode_source=auto|operator going forward and skip operator, use coaching kind (or update notice-ledger, ops/notices.ts, error-registry and AGENT_OPERATOR together), avoid double messaging with the BEHAVIOR_CHANGES row"}
{"id":"F8","severity":"Medium","title":"Item 2 projection runs in the op handler without a callable predicate; callable vs advertised surface untested; rounding scope contradicts 'local CLI unchanged'","file":"src/core/search/lean-rows.ts","line":60,"fix":"Thread one isCallable(op) into OperationContext built from the dispatch predicate (stdio session after request_tools, HTTP client surface, ceiling); round only in leanRow; test callable-full/advertised-starter, HTTP starter client, request_tools"}
{"id":"F9","severity":"Medium","title":"Item 5 stages overlap (keyword count, parallel lexical arms, fan-out hybrid calls); other = total − sum is tautological and can go negative","file":"src/core/ops/search.ts","line":759,"fix":"Define stages as critical-path blocked wall-clock spans, report overlapped_ms separately, aggregate nested fan-out calls once, gate on 0 <= other <= 10% of total on every bench query"}
{"id":"F10","severity":"Medium","title":"Item 5 timings in eval capture need a schema migration on both engines (eval_candidates has fixed columns); Cat 40 receipts read MCP _meta, not capture","file":"src/core/pglite-schema.generated.ts","line":868,"fix":"Drop eval capture from this wave (keep _meta.retrieval and --explain), or re-estimate item 5 as M with a migration allocated at the merge slot","user_challenge":true}
{"id":"F11","severity":"Medium","title":"Item 4: misses run a full searchKeyword per name and per-name invariants repeat; extraction alone may not halve p50 on miss-heavy batches","file":"src/core/verbs/entity-card.ts","line":595,"fix":"Profile with hit/miss split, hoist loadLinkableTypes and excludePrivate out of the per-name loop, reuse CardPageRow.compiled_truth instead of re-querying, report hit/miss mix beside p50, add all-miss and mixed batches to the gate"}
{"id":"F12","severity":"Medium","title":"Op-path harness is a gbrain change (eval-longmemeval.ts), not gbrain-evals; ship decision and OperationContext construction undefined","file":"src/commands/eval-longmemeval.ts","line":117,"fix":"Ship the via-operation mode in the fix wave so receipts reproduce from a tagged gbrain; build the context as the agent path (remote true, stdio, owner sourceId) and record it"}
{"id":"F13","severity":"Low","title":"More stale 'query expands' surfaces outside the plan's list","file":"src/core/search/tune-recommendations.ts","line":87,"fix":"Update tune-recommendations.ts:87, top-help.ts:44, TOOL_REFERENCE.md; add a guard test rejecting 'in every mode'/'always expands' phrasing in src/ and docs/"}
{"id":"F14","severity":"Low","title":"init --search-mode semantics on an existing brain undefined (picker idempotent); rerank detection should use reranker readiness, not a key name","file":"src/commands/init-mode-picker.ts","line":205,"fix":"Define force-or-refuse behavior with a message, register the flag, and compute hasRerankKey via rerankerReadinessForEngine"}
{"id":"F15","severity":"Low","title":"mode.ts cites a superseded 54.89% expansion receipt that the opaque-id re-measure moved to 436/470","file":"src/core/search/mode.ts","line":128,"fix":"Update the comment to cite the 2026-10-04 opaque-id followups in the same PR"}
{"id":"F16","severity":"Low","title":"CRAG escalation counts per arm will be zero because search.crag_escalation defaults off","file":"src/core/ops/search.ts","line":1055,"fix":"Report the CRAG confidence-grade distribution per arm, or run escalation as a separately labeled arm"}
{"id":"F17","severity":"Low","title":"Cat 40 mode pin value unspecified; past rounds ran whatever the non-TTY picker chose","fix":"State the pinned mode per round (tokenmax for baseline continuity or balanced for the new default) in experiment.json and the preregistration"}
{"id":"F18","severity":"Informational","title":"Per-stage timings to remote callers expose slightly more than total latency","file":"src/core/ops/search.ts","line":793,"fix":"Integer milliseconds in _meta.retrieval only, never in content blocks"}
```
