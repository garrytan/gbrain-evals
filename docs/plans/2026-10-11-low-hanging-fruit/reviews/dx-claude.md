INPUT: dx 4009e57952e0b644ff7168bfb86e5b0bbfbd0c156328abe7bb294511b9f627df

# DX review (native): low-hanging-fruit retrieval/latency/cost wave

Reviewed against gbrain master `da434385` (VERSION 0.60.175.0) and gbrain-evals `a89535fc`. Input file hash and byte count (13,246) verified. No repository file was edited; one throwaway script measured a notice size and was deleted (checkout clean).

**Verdict.** The plan is well-scoped and its code citations hold up, but its DX surface is under-specified in three places that a user will feel: item 1b flips a documented, test-pinned contract and updates only one of about ten surfaces that state it; item 3 as written would put a ~600-character unmutable notice on every search of the default keyless install; and item 1's "ask_user behavior-change notice" for existing `tokenmax` brains doesn't fit the mechanism it names. All three are fixable inside the same S-effort items.

## Claims verified (file:line)

- `recommendModeFor` returns `tokenmax` for every keyed non-Haiku install: `src/commands/init-mode-picker.ts:67-97`; no-chat-key → `conservative`: `:76-81`; idempotent skip: `:205-211`; silent JSON / non-TTY write: `:219-236`, banner `:237-270`. Runtime fallback is already `balanced`: `src/core/search/mode.ts:628`.
- Bundles: conservative reranker off (`mode.ts:447`), balanced `searchLimit 25`, budget 12,000, `reranker_top_n_in 25`, expansion false (`:500-510`); tokenmax limit 50, no budget, pool 50, expansion true, `per_chunk_synopsis` (`:555-605`).
- `search` pins `expansion: false` (`src/core/ops/search.ts:764`) and defaults to 20 (`:664`, `:692`). `query`: `const expand = p.expand !== false` (`:868`), `expansion: expand` (`:989`), `expandFn: expand ? expandQuery : undefined` (`:990`), description `:842`. Per-call beats bundle: `src/core/search/hybrid/request.ts:96-106`.
- `PER_CALL_NOTICE_CODES` omits `degraded_recall` (`src/core/notice-ledger.ts:26`); dedupe key is `session|code` (`:72`), so a different later degradation is hidden. TODO is real (`TODOS.md:16`).
- Lean rows keep `id` (`src/core/search/lean-rows.ts:31`); local callers get full rows (`:44-48`); `fetch` is not on `starter` (`src/mcp/surface.ts:91-110`), and Cat 40 Hard runs `--surface starter` (gbrain-evals `docs/benchmarks/2026-10-08-program-primary-hard-baseline.md:61`).
- `entity names[]` calls `buildEntityCard` per name (`src/core/verbs/entity-names.ts:51`) with `CONCURRENCY = 8` (`:21`); candidate selection is `entity-card.ts:201-318`, assembly `:320` → `assembleCard` (`:370`).
- Evidence: balanced 451/470 vs "tokenmax as released (legacy expansion, reranker on)" 442/470 (gbrain-evals `docs/benchmarks/2026-10-04-longmemeval-opaque-followups.md:46-53`); `docs/settings.md:4,24` recommends balanced. Cat 40 already supports `--gbrain-config` (`eval/runner/cat40-model-ladder.ts:407,623-628`).

## Step 0

### Developer Persona Card

| Persona | Context | What they need from this wave |
|---|---|---|
| **P1, the installing agent** (primary) | Runs `gbrain init` non-interactively inside Claude Code / Codex / OpenClaw, often with a chat key in env and `--no-embedding` per AGENTS.md step 2 | A default that is the measured best, a banner whose every sentence is true, and one command to change it |
| **P2, the operator** | Gets the relayed matrix (AGENTS.md step 3 STOP) | Honest prices with current models; knows what switching gives up |
| **P3, the remote MCP client author** | HTTP client on `starter`/`full`, reads lean rows | A row-shape change that's disclosed, with a per-call and host-wide escape |
| **P4, the gbrain contributor / eval runner** | Next latency wave | Stage timings in the place they already read (receipts, `--explain`) |

### Developer Empathy Narrative

P1 is told to install gbrain for a user. It runs `gbrain init --pglite --no-embedding`. Today the banner says `tokenmax` because `ANTHROPIC_API_KEY` happens to be in its env (`init-mode-picker.ts:120-126`), prints a matrix priced on Haiku 4.5 / Sonnet 4.6 / Opus 4.7 (`:142`, `:256`), tells it that `query` expands in every mode (`:264`), and AGENTS.md tells it to stop and relay all of that. After this wave as planned, the banner says `balanced` and has current prices, but it still says `query` expands in every mode (the plan only edits `:842`), and INSTALL_FOR_AGENTS.md:267-271 still says the same. P1 relays a false sentence to P2. Then P1 runs its first ten searches on the keyless brain, and with item 3 as written each one carries the same 594-character `degraded_recall` notice explaining that the user chose keyword-only. The agent did nothing wrong and pays for it on every turn, and it can't mute a `degraded` notice (AGENT_OPERATOR_v1.md:765-767).

### Competitive DX Benchmark

The comparator that matters is the plan's own: the **files arm** in Cat 40 Hard. Files has zero setup and zero notices, and on GPT-6.1 Sol costs less per success ($0.24 vs $0.32). gbrain wins on Sonnet 5.5 ($0.85 vs $1.71) and Opus 5.5 ($1.10 vs $2.40). So gbrain's DX bar is "the setup cost must buy fewer tokens per read than files." Item 2 directly serves that (search is 85% of tool-result characters); item 3 as written works against it on keyless brains. TTHW today: about six steps plus one human round trip (install Bun, install gbrain, init, STOP-relay-wait, import/put, search). No item changes the step count; the human round trip dominates. A timed fresh-install check is already a P3 TODO (`TODOS.md:13`).

### Magical Moment Specification

A fresh agent install on any key combination ends with: `search mode set to: balanced (measured best on LongMemEval, 451/470 vs 442/470)`, prices that match `src/core/model-pricing.ts`, and a first `query` that makes no LLM call and returns under the hybrid p50. On a keyless brain, the first search says once that recall is keyword-only by choice, and later searches say nothing until something actually changes. Measured by item 1's fresh-init receipt test plus a "second keyless search has no repeat notice" probe.

### Developer Journey Map

| Stage | Today | After plan as written | After the fixes below |
|---|---|---|---|
| Init / mode | tokenmax by default, stale prices, true-but-odd expansion copy | balanced, current prices, **stale expansion copy** | balanced, current prices, copy matches behavior; optional `--search-mode` |
| First read | `query` makes one expansion call | none in balanced (if 1b ships) | same, and the escape (`search.expansion true` / `expand: true`) is documented |
| Keyless steady state | one notice per session | **notice on every call** | one notice per distinct degradation |
| Transient failure | second distinct degradation hidden | shown | shown |
| Upgrade (tokenmax brain) | nothing | an "ask_user behavior-change" with an undefined mechanism | owner-only notice with fix + verify, and what is given up |
| Remote client | `id` on every row | `id` only where `fetch` is callable | same, and the `fetch` refusal names both recovery routes |
| Tuning latency | no stage split | split inside `hybridSearch` only | split at op level, visible in receipts |

### First-Time Developer Confusion Report

1. "The banner says `query` expands in every mode, but my `query` made no expansion call." (item 1b without doc sweep; `modes-report.ts:106`, `init-mode-picker.ts:137,167,264`, `docs/guides/search-modes.md:44-58,74`, `INSTALL_FOR_AGENTS.md:267-271,313`, `docs/architecture/RETRIEVAL.md:182,200`).
2. "I set `search.expansion=false` long ago and it did nothing; now `query` changed." (the key becomes live for `query`; `search-modes.md:47-50` says it governs no shipped verb).
3. "Why does every search repeat that I chose keyword-only?" (item 3 on keyless brains).
4. "I switched tokenmax → balanced and it says the cache refills within an hour." (`mode-switch-ux.ts:145`, while caching is disabled per `init-mode-picker.ts:135`).
5. "I asked `fetch` for a result I saw before `request_tools`, and it tells me to pass the `id` field my rows don't have." (`src/core/ops/pages.ts:239-245`).
6. "My Voyage key is in `~/.gbrain/config.json`, yet init picked conservative." (picker reads raw `process.env`, not `mergedProviderEnv`).

**DX Trend Check.** The repo's recent direction is toward fewer, truer notices (per-call only for result-describing codes, HTTP stateless exceptions, muting for coaching/info) and toward measured defaults (`docs/settings.md`). Items 1, 2 and 5 follow that trend. Item 3 as literally specified reverses it for the commonest steady state; item 1b reverses an explicit, recently-pinned contract ("changing modes does not silently enable or disable expansion", `search-modes.md:52-53`; `test/search/operation-expansion-contract.serial.test.ts:27`), which is fine if Garry approves, but then the contract has to be rewritten everywhere it's stated, not just in one tool description.

## Passes

**Pass 1, getting started.** Item 1 is the right change and is small. Two gaps: key detection reads raw env (`init-mode-picker.ts:120-126`) instead of the canonical fold `mergedProviderEnv` (`src/core/ai/provider-env.ts:1-10`), so the new Voyage branch misses config-plane keys; and there is no `gbrain init --search-mode <mode>`, so an agent that already knows the operator's choice must init, read the banner, then `config set` (which triggers the mode-switch UX). The AGENTS.md STOP stays mandatory; whether it can become confirm-only when the recommendation equals the runtime default is a product call (Unresolved Decisions).

**Pass 2, API/CLI design.** Inputs `hasExpansionKey` no longer describe the decision once expansion follows the mode; rename to `hasChatKey` + `hasRerankKey`. For item 4, an `identityOnly` flag that makes `buildEntityCard` return a card-shaped object without card fields invites misuse; extracting the candidate selection (`entity-card.ts:207-318`) into one exported function that `buildEntityCard` itself calls keeps "no second resolver" and gives `entity-names.ts` a typed result. Item 2's `score` rounding to 4 decimals leaves about two significant digits on RRF-scale scores (~0.016), producing visible ties; 4 significant digits is safer, or let the replay confirm it.

**Pass 3, errors and debugging.** Every new notice should carry the AGENT_OPERATOR_v1 contract (code, why, `fix.next`, `fix.verify`). The plan names a fix command only for item 1 and no verify anywhere. Item 1's existing-brain notice needs `fix.verify` (`gbrain search modes --json`); item 1b's row needs the escape (`gbrain config set search.expansion true`, or `--expand` / `expand: true`); item 2's `fetch` refusal needs the re-search / slug route; a new notice code needs an `error-registry.ts` entry so `gbrain errors <code>` explains it offline.

**Pass 4, documentation.** Item 1's doc list is good (picker, banner, matrix, INSTALL Step 3.5, search-modes.md) but misses the narrowing banner and llms regeneration (`scripts/ci-doc-checks.sh:29` fails CI otherwise). Item 1b's list is one line out of about ten (F1). Item 3 needs AGENT_OPERATOR_v1 reconciled: its prose says stdio shows a notice once per process (`:748-753`) while its table says `degraded_recall` rides every affected call (`:787`).

**Pass 5, upgrade path.** Existing `tokenmax` brains: unchanged plus a notice, which is right, but the notice must say what switching gives up (backfilled per-chunk synopses stop being used: `per_chunk_synopsis` → `title`) and must be owner-only (HTTP clients can't change the mode). Existing `balanced`/`conservative` brains lose `query` expansion under 1b, disclosed once through `behavior_changes`, which is disclosure-only and never waits (`behavior-change-notice.ts:1-5`). Brains with a stray `search.expansion` value flip behavior silently; the row must name that key.

**Pass 6, environment and tooling.** Picker key detection (above). `GBRAIN_NO_MODE_SWITCH_UX=1` already lets scripted operators skip the switch banner, so that's fine. The 1b gate needs a new harness path: `gbrain eval longmemeval` calls bare `hybridSearch` (`src/commands/eval-longmemeval.ts:117,1437`), not the `query` op, and the plan doesn't cost that work. Cat 40 doesn't record the resolved mode today (no `search.mode` reference under `eval/runner/cat40/`), so "recorded in `experiment.json`" is a gbrain-evals change to list.

**Pass 7, community.** Verdict mirroring into gbrain-evals and null-result reporting are good. The CHANGELOG/BEHAVIOR_CHANGES rows should lead with the user's action, not the mechanism. The coordinator contract requires every user-visible change in `## Behavior changes`; item 3's notice-frequency change is user-visible and currently has no row.

**Pass 8, measurement.** Item 5's "sum within 5% of total" is undefined: the 1,423 ms agent-visible p50 is op-level, but `onMeta` covers only `hybridSearch`, not the op-layer work after it (alias fan-out, anchoring, keyword count, response meta: `search.ts:778-794`). The refactor-wave-1 bench uses stub embedder/reranker (`scripts/bench-refactor-wave-1.ts:22-24`), so embed/rerank stages read ~0 there. Define the stages at op level with an explicit `other`, and put them in eval capture / Cat 40 receipts so the next wave reads them from transcripts.

## Decision cycles (one per unresolved finding)

- **F1/F2 (1b surfaces and escape).** Options: (a) ship 1b with a full sweep and a rewritten contract test; (b) ship 1b behind `search.expansion` semantics only. Recommend (a); 1b already needs Garry's approval, so bundle the doc sweep into what he approves.
- **F3 (item 3 policy).** Options: (a) per-call always, as the protocol table says; (b) dedupe on code + stage/reason signature, so each distinct degradation shows and the steady state shows once. Recommend (b) and fix the protocol prose and table to match; it fixes the TODO case and keeps keyless brains quiet.
- **F4 (existing-brain notice mechanism).** Options: (a) a conditional `BEHAVIOR_CHANGES` row (extend `ChangeText` beyond `(chain, remote)`, `behavior-change-notice.ts:223`), disclosure with a fix; (b) a new owner-only `ask` code, muteable like `first_run_decisions`. Recommend (b): it's the only one that matches "ask_user, once per brain" and stays off HTTP.
- **F7 (init flag / STOP).** Recommend adding `--search-mode`; the STOP softening goes to Garry.

## NOT in scope

The plan's own list stands. Added by this review, deliberately not proposed: changing the AGENTS.md STOP protocol inside this wave (decision only), muting `degraded` notices (the protocol forbids it on purpose), and any change to `fetch`'s legacy-slug acceptance.

## What already exists

The plan's list stands. Also relevant and reusable: `mergedProviderEnv` (`src/core/ai/provider-env.ts`) for key detection; `summarizeTransition` (`src/core/search/mode-switch-ux.ts:97`) for switch copy; `MODES_REPORT_PER_CALL_NOTE` (`src/core/search/modes-report.ts:103-110`); `MUTEABLE_ASK_CODES` (`notice-ledger.ts:25`) as the precedent for a dismissible ask; `fields: "full"` and `mcp.result_rows: full` (`src/mcp/result-rows.ts:1-10`) as item 2's escapes; `expansion_applied` response metadata for verifying 1b; `test/search/operation-expansion-contract.serial.test.ts` as the place the new 1b contract gets pinned.

## TODOS.md updates

- Close `TODOS.md:16` (`degraded_recall` dedup) when item 3 lands, and note the signature-keyed policy.
- Add P3: `gbrain init --search-mode <mode>` if it is not folded into item 1.
- Add P3: guidance for `tokenmax` brains with paid per-chunk synopses before switching (what is kept, what stops being used).
- Add P2 (gbrain-evals): record resolved `search.mode` in Cat 40 `experiment.json`.
- Keep `TODOS.md:13` (timed fresh-install check); item 1's receipt test is a partial step toward it.

## DX Scorecard (plan as written → with fixes)

| Dimension | As written | With fixes |
|---|---:|---:|
| Getting started (TTHW, defaults) | 7 | 8 |
| API/CLI ergonomics | 6 | 8 |
| Error handling (problem/cause/fix/verify) | 5 | 8 |
| Documentation accuracy | 4 | 8 |
| Escape hatches | 6 | 8 |
| Upgrade path | 5 | 8 |
| Environment and tooling | 6 | 7 |
| Measurement | 7 | 8 |
| **Overall** | **5.8** | **7.9** |

## DX Implementation Checklist

- [ ] Item 1: picker reads keys through `mergedProviderEnv`; inputs renamed `hasChatKey` / `hasRerankKey`; tests include a config-plane Voyage key.
- [ ] Item 1: banner, menu and matrix use `model-pricing.ts` names and prices; INSTALL Step 3.5 and search-modes.md updated; narrowing banner (`mode-switch-ux.ts:143-146`) rewritten; `bun run build:llms`.
- [ ] Item 1: existing-brain notice is an owner-only, once-per-brain `ask` code registered in `error-registry.ts`, with `fix.argv`, `fix.verify` (`gbrain search modes --json`), what switching gives up, and evidence quoted as measured (direct harness; tokenmax-as-released included legacy expansion).
- [ ] Item 1 (optional): `gbrain init --search-mode <mode>`; JSON event reports `auto: false`.
- [ ] Item 1b: sweep every "expands in every mode" surface (F1 list) and rewrite the contract test to the new contract; keep `expandFn` wired when `expand` is unset; test that `tokenmax` `query` still expands by default.
- [ ] Item 1b: the BEHAVIOR_CHANGES row names `search.expansion` (now live for `query`) and `expand: true`.
- [ ] Item 1b gate: build and cost the op-path LongMemEval harness; reproduce the expand-off baseline before the paired run.
- [ ] Item 2: `fetch` refusal copy names re-search and the slug route; the row names `fields: "full"`, `mcp.result_rows: full`, and that the local CLI and thin client are unchanged; check rounding with the replay (or use 4 significant digits).
- [ ] Item 3: dedupe on code + stage/reason signature; probes for (embed_timeout → rerank_failed shows) and (keyless second search shows nothing new); reconcile AGENT_OPERATOR_v1 `:748-753` with `:787`; add a BEHAVIOR_CHANGES row.
- [ ] Item 4: extract candidate selection as one function that `buildEntityCard` calls; parity tests as planned.
- [ ] Item 5: op-level stages with `other`; stages in eval capture and `--explain`; define "total" as op latency; one real-provider sample alongside the stub bench.

## Unresolved Decisions

1. **Garry:** approve 1b including the contract reversal (modes now decide `query` expansion), with the full doc and test rewrite.
2. **Garry:** item 3 policy, per-call always (protocol table) vs signature-keyed dedupe (recommended).
3. **Garry:** whether AGENTS.md step 3's mandatory STOP becomes confirm-only when the recommendation equals the runtime default (`balanced`). It would cut the human round trip out of TTHW for most installs.
4. **Plan owner:** whether `gbrain init --search-mode` folds into item 1 or becomes a TODO.

## Review Log

| Phase | Reviewer | Date | Input | Verdict | Findings |
|---|---|---|---|---|---|
| dx | native | 2026-10-11 | dx 4009e579…627df | approve with changes | 4 High, 6 Medium, 4 Low, 1 Informational |

## Next Steps (review chaining)

Hand off to the eng review with F2 (the `expandFn` wiring pitfall at `search.ts:990`), F3 (dedupe key design) and F9 (op-level stage boundaries) flagged as the implementation-sensitive items; F1, F4 and F6 are copy and contract work for the implementing lane.

```gstack-findings
{"id":"F1","severity":"High","title":"Item 1b flips a documented, test-pinned contract but updates only the query tool description","file":"src/core/search/modes-report.ts","line":106,"fix":"Enumerate and rewrite every surface stating 'query expands in every mode': init-mode-picker.ts:137,167,264; modes-report.ts:106; docs/guides/search-modes.md:44-58,74; INSTALL_FOR_AGENTS.md:267-271,313; docs/architecture/RETRIEVAL.md:182,200; regenerate llms-full.txt. Rewrite test/search/operation-expansion-contract.serial.test.ts to pin the new contract (mode decides default, explicit expand wins)."}
{"id":"F2","severity":"High","title":"Item 1b makes search.expansion live for query and can silently drop tokenmax expansion via expandFn","file":"src/core/ops/search.ts","line":990,"fix":"Keep expandFn wired whenever expansion may resolve true (not only when expand===true); test that tokenmax query still expands by default. Name `gbrain config set search.expansion true` and `expand: true` as escapes in the BEHAVIOR_CHANGES row, and warn that a previously inert search.expansion value now takes effect."}
{"id":"F3","severity":"High","title":"Item 3 would attach a ~600-char unmutable degraded_recall to every search on the default keyless install","file":"src/core/notice-ledger.ts","line":26,"fix":"Key the stdio dedupe on code + stage/reason signature instead of adding degraded_recall to PER_CALL_NOTICE_CODES (keyword-only.ts:96-99 pushes embed_unavailable/embedding_disabled on every keyless call; measured 594 chars). Add a probe that a second keyless search shows no repeat notice, reconcile AGENT_OPERATOR_v1.md:748-753 with :787, and add a BEHAVIOR_CHANGES row."}
{"id":"F4","severity":"High","title":"Item 1's 'ask_user behavior-change notice' for tokenmax brains doesn't fit the disclosure-only, unconditional behavior_changes mechanism","file":"src/core/behavior-change-notice.ts","line":223,"fix":"Specify an owner-only (stdio/CLI), once-per-brain ask code registered in error-registry.ts, muteable like first_run_decisions, with fix.argv `gbrain config set search.mode balanced`, fix.verify `gbrain search modes --json`, what switching gives up (per-chunk synopses stop being used), and evidence quoted as measured (direct harness; tokenmax-as-released included legacy expansion)."}
{"id":"F5","severity":"Medium","title":"Picker detects keys from raw process.env, so the new Voyage branch misses config-plane keys","file":"src/commands/init-mode-picker.ts","line":120,"fix":"Resolve keys through mergedProviderEnv (src/core/ai/provider-env.ts); rename inputs to hasChatKey/hasRerankKey; add a test with voyage key only in ~/.gbrain/config.json."}
{"id":"F6","severity":"Medium","title":"Narrowing mode-switch banner says the cache refills within 1h while semantic caching is disabled","file":"src/core/search/mode-switch-ux.ts","line":145,"fix":"Rewrite narrowing copy to state what tokenmax→balanced changes (limit 50→25, 12k budget, rerank pool 25, synopses unused, query expansion off after 1b); item 1's notice routes users through this banner."}
{"id":"F7","severity":"Medium","title":"No init-time search-mode flag; agents that know the choice must init then config set","file":"src/commands/init.ts","line":1271,"fix":"Add `gbrain init --search-mode <mode>` passed to runModePicker as an explicit choice (JSON event auto:false, banner says chosen not recommended); otherwise file a P3 TODO."}
{"id":"F8","severity":"Medium","title":"Item 2: fetch refusal tells agents to pass an id their earlier rows no longer carry","file":"src/core/ops/pages.ts","line":239,"fix":"Make the fetch refusal fix name both routes (re-run search; rows carry id once fetch is callable, or pass the row's slug, accepted when unambiguous); BEHAVIOR_CHANGES row names fields:\"full\", mcp.result_rows: full, and that local CLI and thin client are unchanged."}
{"id":"F9","severity":"Medium","title":"Item 5's 'total' is undefined and onMeta misses op-layer time; stub bench zeroes embed/rerank","file":"src/core/ops/search.ts","line":778,"fix":"Define stages at op level (include alias fan-out, anchoring, keyword count, response meta) with an explicit 'other'; total = op latency; surface stages in eval capture/Cat 40 receipts and --explain; add one real-provider sample alongside scripts/bench-refactor-wave-1.ts."}
{"id":"F10","severity":"Medium","title":"Item 1b gate needs an uncosted op-path LongMemEval harness","file":"src/commands/eval-longmemeval.ts","line":1437,"fix":"Name and cost the harness change (e.g. a via-op query mode); reproduce the expand-off baseline through it before the paired paid run."}
{"id":"F11","severity":"Low","title":"Doc edits require llms regeneration or CI doc checks fail","file":"scripts/ci-doc-checks.sh","line":29,"fix":"Add `bun run build:llms` to items 1 and 1b checklists."}
{"id":"F12","severity":"Low","title":"Rounding score to 4 decimals leaves ~2 significant digits on RRF-scale scores","file":"src/core/search/lean-rows.ts","line":31,"fix":"Round to 4 significant digits, or confirm with the transcript replay that visible ties don't mislead."}
{"id":"F13","severity":"Low","title":"Cat 40 doesn't record the resolved search mode today","file":"eval/runner/cat40/gbrain-arm.ts","line":316,"fix":"List the gbrain-evals change (record resolved search.mode in experiment.json) in the sequencing step before the guardrail round."}
{"id":"F14","severity":"Low","title":"identityOnly flag on buildEntityCard returns a card-shaped object without card fields","file":"src/core/verbs/entity-card.ts","line":201,"fix":"Extract candidate selection (entity-card.ts:207-318) into one exported function that buildEntityCard calls; entity-names uses it directly. Still one resolver, typed result."}
{"id":"F15","severity":"Informational","title":"Plan's code and eval citations verified","fix":"None; init-mode-picker.ts:67-97/205-236, search.ts:764/868/989, request.ts:96-106, notice-ledger.ts:26, lean-rows.ts:31, entity-names.ts:51, and gbrain-evals opaque-followups.md:46-53 all match."}
```
