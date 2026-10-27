# gbrain cost audit: provider calls and agent tokens (default paths)

Audit lane: cost. gbrain master `3c16e9ba` (v0.60.250.0), gbrain-evals `d744fa38`. 2026-10-15.
Read-only: code was read in a private clone (same commit; local audit notes (not committed)), never in the shared gbrain checkout.
Scratch scripts and probe outputs live in local audit notes (not committed). Paid spend: about 52 Anthropic Haiku calls,
under $0.02 in total. No gpt-5.4-mini.

**Note on the shared checkout.** The shared gbrain checkout has uncommitted edits (not mine) that set `tokenmax`
`expansion: false` (the GBRA-94 flip) and change the init picker's `tokenmax` line to "per-chunk synopsis context".
Everything below cites committed HEAD. See finding F2 for why that picker line overstates what `tokenmax` does.

## Bottom line

For agent tasks, gbrain's own provider spend is about 1% of the bill. In the Cat 40 next-confirm public P1 wave
(`gbrain-evals docs/benchmarks/2026-10-14-cat40-next-confirm-public/p1/wave/results.jsonl`, 300 cells), agent tokens
were $132.28 and gbrain-internal calls were $1.31, of which $1.13 was 12 Opus 4.7 calls from the `synthesize` verb.
So the agent-cost lever is tool-result size, not gbrain's model choice. The largest cheap win is dropping default-valued
provenance fields from lean rows. Replayed on committed transcripts, that cuts 10–13% of all tool-result characters.
For background and opt-in spend, the lever is model ids: the utility, reasoning and deep tiers still default to Haiku 4.5,
Sonnet 4.6 and Opus 4.7.

The "gbrain costs ~2.4x files per successful task" premise is stale. It comes from the 2026-10-03 easy-world plan
(`gbrain-evals TODOS.md:235`, `docs/plans/2026-10-03-cat40-followups/PLAN.md:514`). The latest measured numbers:

- **Next-confirm public:** gbrain $0.53 per success, fs $1.35. Sealed: gbrain $0.98, fs $1.77
  (`docs/benchmarks/2026-10-15-cat40-next-confirm/README.md:131-134`).
- **Hard confirmation:** gbrain is cheaper per success on Sonnet 5.5 and Opus 5.5 and dearer on GPT-6.1 Sol: 0.32 vs 0.24
  on world M and 0.46 vs 0.32 on world S (`docs/benchmarks/2026-10-10-model-ladder-hard-confirmation.md:53-62`).

The remaining gap is Sol, a cheap model whose per-success cost is dominated by tool-result tokens.

## Ranked items (impact / effort)

| # | Item | Effort | Impact | Confidence | Gate |
|---|---|---|---|---|---|
| C1 | Elide default-valued provenance fields in lean rows (`trust_tier`/`origin`, `effective_date_source:"date"`, derivable `create_safety`) | S–M | −10.4 to −14.8% of all tool-result chars (−14.8 to −17.6% of search rows); est. −5–8% agent $/task | high on chars, medium on $ | keyless replay, then Cat 40 dev paired (~$40–60) |
| C2 | Expansion prompt asks for 3–4 rewrites, code keeps 2: ask for 2 | S | −47% expansion output tokens, −251 ms p50 per expanded query (raw API, n=8) | medium (latency), unverified quality | GBRA-94 harness rerun (~$1–2) |
| C3 | Narrow #6335: expansion-only measured default `claude-haiku-5-5` | S | $0.631 → $0.098 per 1k expanded queries (−84%), recall within noise | high (GBRA-94) | keyless resolver test; GBRA-94 already measured |
| C4 | `synthesize`/`think` default Opus 4.7: measure Opus 5.5 / Sonnet 5.5 | S code, M eval | ~$0.094/call today; −20% (Opus 5.5) to −60% (Sonnet 5.5) per token, net unknown (thinking) | low until measured | think answer-quality eval (~$10–20) |
| C5 | Full-surface tool-description budget (registrations pin `full`) | M | full list 27.5k tokens/turn vs starter 5.1k; est. −3% $/task with caching, more without | medium | extend keyless schema-budget test; Cat 40 dev smoke on `full` (~$40) |
| C6 | Synopsis pool defeats the prompt cache (4 concurrent cache writes per page) | S | about −3.45×D input-token-equivalents per page of D tokens (≥4 chunks); opt-in path only | medium (mechanism from docs; unmeasured) | keyless ordering test + $0.05 live probe |
| C7 | Other utility-tier consumers on Haiku 4.5 (dream judges, extract_atoms, synopsis) | M | 10x cheaper per token; no per-task evidence | low | per-consumer gates (TODO-D scope) |
| C8 | Query-embedding LRU + batched variant embeds | S | ~130 ms on 6.5% of searches (repeated query text); $≈0 | medium | keyless unit test |
| C9 | #6771 (code-metadata repair keeps vectors) | S (revise) | one-off: avoids re-embedding a repo's code chunks on repair (~$1 per 15M-token repo) | high on mechanism | its own tests + E2E |

---

## Part 1. Provider calls on default paths, per mode (HEAD)

Default mode on a new install with a chat key is `tokenmax`. `recommendModeFor`
(`src/commands/init-mode-picker.ts:74-82`) returns conservative for a Haiku subagent or when there are no keys,
balanced for rerank-only installs, and otherwise `tokenmax` (the default subagent is `claude-sonnet-4-6`,
`src/core/model-config.ts:95`). With no mode row, resolution falls back to `balanced` (`src/core/search/mode.ts:669`).
Bundles are at `mode.ts:467-666`.

| Path | conservative | balanced | tokenmax | Model / evidence |
|---|---|---|---|---|
| `search` op: query embed | 1 call | 1 call | 1 call | `voyage:voyage-4` $0.06/M (`src/core/ai/defaults.ts`, `embedding-pricing.ts:44`); ~15 tok → ≈$0.001 / 1k queries |
| `search` op: rerank | off | 25 docs | 50 docs | `voyage:rerank-3-lite` $0.02/M, docs capped 1,400 tok (`search/rerank.ts:90-143`); code anchor ~$0.0006/query at 50 (`mode.ts:161`) → **~$0.6 / 1k** tokenmax, ~$0.3 / 1k balanced (estimate, not measured here) |
| `search` op: LLM calls | none | none | none | `search` never expands (`mode.ts:116-120`); `cross_modal_llm_intent` off in every bundle; rerank gate is `off` (`search/crag.ts:291`) and its skip probe found no skippable queries (memory-proof wave 2, gate 4) |
| `query` op: expansion | off | off | **on** | `anthropic:claude-haiku-4-5-20251001` via utility tier: **$0.631 / 1k queries**, expansion p50 1,543 ms, query e2e p50 2,022 ms (GBRA-94 `2026-10-14-expansion-latency-preregistration.md:192`) |
| `query` op: variant embeds | — | — | +2 calls | separate parallel requests, not batched (`search/hybrid/arms.ts:442-452`) |
| put_page / sync: embeddings | changed chunks | changed chunks | changed chunks | unchanged chunks keep vectors (v0.60.134/137/242, `behavior-change-notice.ts:360-361,629`); ≈$0.09 / 1k pages at ~1.5k tok/page |
| Contextual retrieval at ingest | none | title (free) | **title** (synopsis demoted) | `import-contextual-mode.ts` maps `per_chunk_synopsis` → `title`; nothing submits `contextual_reindex_per_chunk` except a manual `gbrain jobs submit` or the LongMemEval synopsis tier (grep: only `commands/jobs.ts:107,542`, `protected-names.ts:43`). **$0 synopsis spend on default paths** |
| Facts extraction (put_page / incremental sync, eligible types) | on with a chat key | same | same | `facts.extraction_enabled` defaults true (`facts/extract.ts:40-49`); Anthropic installs use `claude-haiku-5-5` (`extract.ts:65-91`): **$1.38 / 1k pages** vs $15.94 on Sonnet 4.6 (`2026-10-08-facts-extraction-model.md:3`). Sync extracts only when ≤50 pages changed (`commands/sync/finalize.ts:575`); identical bodies skip (`facts/eligibility.ts:7`). No prompt caching; the system prompt is ~1,035–1,466 tokens (measured), likely under Haiku's minimum cacheable length (4,096 for Haiku 4.5 per Anthropic docs; unverified for 5.5) |
| Auto-link / entity links | deterministic | same | same | no gateway import in `link-extraction.ts` or `persistence/effect-links.ts` |
| `synthesize` verb / `think` | agent-invoked | same | same | deep tier → `anthropic:claude-opus-4-7` (`think/index.ts:611-616`); **measured ~$0.094/call** (12 calls, $1.132, P1 wave `gbrain_internal.byModel`); no prompt caching (`think/index.ts:900-904`) |
| Dream / cycle | tiers resolve to Haiku 4.5 / Sonnet 4.6 / Opus 4.7 | | | `synthesize` is off without a corpus or opt-in (`cycle/synthesize.ts:1617-1621`); `patterns` defaults on (`cycle/patterns.ts:536-537`) but needs input; `edge_contradictions` uses the utility tier (`cycle/edge-contradictions.ts:235`). Per-phase default-on status was not fully enumerated (partially verified) |

Older-generation ids still on defaults (HEAD):

- `TIER_DEFAULTS` (`model-config.ts:91-96`): utility `claude-haiku-4-5-20251001` ($1/$5, while Haiku 5.5 is $0.10/$0.50,
  `model-pricing.ts:174-180`), reasoning and subagent `claude-sonnet-4-6` ($3/$15, while Sonnet 5.5 is $2/$10),
  deep `claude-opus-4-7` ($5/$25, while Opus 5.5 is $4/$20).
- `DEFAULT_ALIASES` (`model-config.ts:64-67`) uses the same three ids.
- `gateway.ts:131-132` sets `DEFAULT_EXPANSION_MODEL` and `DEFAULT_CHAT_MODEL` to the same ids.
- `page-summary.ts:58` sets `DEFAULT_SYNOPSIS_MODEL`. This is a hash anchor (F3), not the served model.
- The recipe's expansion touchpoint list omits `claude-haiku-5-5` (`ai/recipes/anthropic.ts:20`). The chat list has it.

OpenAI-only installs resolve to `gpt-5.6-luna` for utility and expansion, and to `gpt-5.6-terra` for reasoning
(verified by calling `resolveEffectiveExpansionModel` with only `OPENAI_API_KEY`).

Caching and dedup today:

- **Semantic result cache:** hard off. `semanticResultCacheAvailable()` returns false (`search/query-cache.ts:35`),
  so there is no double embed and no result cache.
- **Embeddings:** no query-embedding cache, no expansion cache.
- **Prompt caching:** used where a prefix repeats. Synopsis caches the page block (`page-summary.ts:172-188`), and the
  gateway applies Anthropic `cacheControl` and an OpenAI `prompt_cache_key` (`gateway.ts:3621-3684`).
- **Synopsis LRU:** the file header promises a "process-local LRU" (`page-summary.ts:13-17`). The production path has
  none; `buildSynopsisCacheKey` is used only by the eval tier (`eval/longmemeval/synopsis-tier.ts`). This is a stale
  doc comment.

## Part 2. Agent-token cost

Served tool lists were measured on HEAD with `buildToolDefs` and `stdioVisibleTools` on a fresh PGLite brain,
model-visible fields only (`scratch/surf.ts`):

| Surface | Tools | Chars | cl100k tokens | Largest tools (chars) |
|---|---|---|---|---|
| verbs | 7 | 7,050 | 1,609 | remember 1,784, recall 1,645 |
| starter | 31 | 22,422 | 5,096 | query 2,932, search 1,790, recall 1,425 |
| **full** | 147 | **123,775** | **27,511** | query 3,327, extract_facts 2,813, open_loops 2,516, run_skillopt 2,485, delete_page 2,482, get_page 2,196 |
| instructions | — | 5,064 | 1,067 | sent once per session |

Every new registration pins `full` (`REGISTRATION_SURFACE`, `src/core/mcp-registration.ts:24`, since v0.60.115.0,
`CHANGELOG.md:3322`). The bare `serve`, HTTP and `mcp expose` defaults are also `full` (`src/mcp/surface.ts:190`,
`commands/mcp-expose.ts:289`). The 25k-char ceiling (`test/mcp-schema-budget.test.ts:57-62`) pins only `starter`, so
nothing budgets the surface agents actually get. Narrowing was tried: `starter` matched `full` success at −36% tokens
and −9% cost (`2026-10-05-registration-surface.md:68-90`). But hidden-tool tasks fail on a `starter` listing, 0/20 vs
17/20 (`2026-10-02-model-ladder/p8-hidden-tool-dev-smoke/README.md`). So the lever is description size on `full`, not
the listing.

Tool-result payload, from committed Cat 40 transcripts (P1 wave, gbrain `4e10136b`, 300 cells,
`scratch tr.py / elide.py`):

- **Total:** 72.6M tool-result chars. `search` is 52.2M (72%, 2,083 calls, avg 25k chars, p50 20 rows / p90 100 rows).
  `entity` is 5.6M, `get_page` 4.8M, `get_backlinks` 4.0M, `context_pack` 3.7M.
- **Inside search `content[0]` (51.3M):** `chunk_text` is 30.3M (59%). The rest is metadata: title 2.9M, slug 2.3M,
  `trust_tier` 2.0M, `effective_date_source` 2.0M, `origin` 2.0M, `effective_date` 1.9M, `evidence` 1.7M,
  `create_safety` 1.6M, `source_id` 1.3M, `chunk_id` 1.0M, `type` 1.0M, `score` 1.0M.
- **Value distribution:** `trust_tier:"operator_curated"` on 99.7% of rows, `origin:"managed_sync_import"` 99.7%,
  `effective_date_source:"date"` 96.9%. `create_safety` is a function of `evidence` on 99%+ of rows
  (weak_semantic→unknown 44,806/44,806, keyword_exact→probable 17,120/17,120). `source_id:"vault"` is on 100% of rows
  (a single-source world).
- **Boilerplate is already small:** the `[gbrain search]` trailer is 0.40M, `[gbrain dates]` 0.28M (repeated on every
  search) and notices 0.15M, together 1.6% of search chars. JSON is already compact (C2 of the cost wave shipped),
  and rows are already one per page (1 repeated-page row in 63,719).
- **`get_backlinks`:** `trust_tier` + `origin` are 511k of 4.0M (12.8%) and 100% constant. Midnight dates are
  serialized as `"2026-09-15T00:00:00.000000Z"` (27 chars, 300k total).
- **How agents search:** they barely use `query`: 3 of 5,968 calls (P1) and 11 of 18,508 (Hard confirmation). Expansion
  therefore costs agents almost nothing in Cat 40. It costs `gbrain query` CLI users, `query` MCP callers and
  `expand: true` callers.

---

## Item details

### C1. Elide default-valued provenance fields from lean rows
1. **Problem:** every lean row repeats `trust_tier`, `origin`, `effective_date_source` and `create_safety` even when
   they hold the brain-wide default, and `create_safety` is derivable from `evidence`.
2. **Evidence:** counts in Part 2. In a replay that elides `trust_tier`+`origin` when they equal
   operator_curated+managed_sync_import, drops `effective_date_source` when it is `"date"` and drops `create_safety`
   when it matches its `evidence` mapping:
   - **P1 wave:** search rows −14.8%, −10.4% of all tool-result chars.
   - **Adding `source_id` elision on single-source brains:** P1 −17.2% / −12.2%, P2 −17.1% / −12.7%, P1 baseline
     −17.6% / −14.8% (local audit notes (not committed)).
3. **Still on master:** yes. `KEPT_FIELDS` keeps all of them unconditionally (`src/core/search/lean-rows.ts:36-47`,
   `leanRow` at `:66-85`). Referrer rows always add `trustFields` (`src/core/mentions/referrers.ts:149-152`).
4. **Fix:** in `leanRow`, omit `trust_tier`/`origin` when they equal the declared default pair, `effective_date_source`
   when `"date"`, and `create_safety` when it equals `CREATE_SAFETY_FOR[evidence]`. Then state the defaults once, in a
   fixed trailer line next to `[gbrain dates]` (`src/core/search/date-labels.ts:40`), e.g. "rows omit
   trust_tier=operator_curated, origin=managed_sync_import unless stated". Do the same for referrer and
   `newer_mentions` rows, and shorten midnight dates to `YYYY-MM-DD` there. `source_id` elision only when the
   caller's visible source set has one source. `fields:"full"` and the thin client stay unchanged.
5. **Effort:** S for search rows, M with referrers, `context_pack` cards and thin-client parity.
6. **Impact:** −10–13% tool-result chars on Cat 40. Tool results dominate re-sent context, so I estimate −5–8% agent
   $/task. That estimate is not measured, and real multi-source brains with mixed trust tiers save less. High
   confidence on chars, medium on dollars.
7. **Gate:** a keyless replay on committed transcripts (extend `scripts/replay-lean-row-savings.ts`) plus golden
   lean-output tests. Then a paired Cat 40 dev round on the newest Opus/GPT/Sonnet, about $40–60, ship rule as in the
   cost wave (CI lower bound > −3 points).
8. **Risk:** #5575 A6's intent was that "every row says how much it deserves influence". An agent reading a missing
   `trust_tier` as unknown could under-weight curated pages. The mitigation is the explicit default line, and
   non-default rows (agent_written, facts-fence, unknown) always carry the field, which keeps the safety signal on the
   rows where it matters.

### C2. Expansion asks for 3–4 rewrites but keeps 2
1. **Problem:** the prompt requests 3–4 rewrites, and the sanitizer discards everything after 2.
2. **Evidence:** `src/core/ai/expansion-prompt.ts:8` ("3-4 different, related queries", 3-item example) vs
   `src/core/search/expansion.ts:52` (`if (out.length >= 2) break`). Live probe, same query, n=8 each
   (local audit notes (not committed)):
   - **Haiku 4.5:** 74.5 → 39.5 output tokens, p50 1,364 → 1,113 ms.
   - **Haiku 5.5:** 104.5 → 64.5 tokens, p50 1,287 → 1,069 ms.
3. **Still on master:** yes. The schema allows up to 5 (`gateway.ts:2425-2427`).
4. **Fix:** ask for exactly 2 rewrites and use a 2-item example, keeping the "queries" key. No cache to invalidate,
   because expansion output is not cached.
5. **Effort:** S.
6. **Impact:** about −250 ms p50 on every expanded `query` (about 12–16% of the 1.5 s expansion stage) and −45%
   expansion output $. Only matters while expansion is on somewhere: tokenmax at HEAD, or opt-in after the GBRA-94
   flip. Medium confidence on latency (small n, raw API rather than the gateway's `generateObject` path). Quality is
   unverified.
7. **Gate:** rerun the GBRA-94 harness A1 vs A1-ask2 on the 300 LongMemEval-S questions with the frozen rerank pair
   cache, about $1–2 in Haiku expansions.
8. **Risk:** asking for fewer rewrites may make them less diverse than the first 2 of 4. The eval covers it.

### C3. Narrow version of #6335: expansion-only Haiku 5.5
1. **Problem:** expansion runs on Haiku 4.5. Haiku 5.5 is 6x cheaper per expanded query with equal recall.
2. **Evidence:** GBRA-94 table (`2026-10-14-expansion-latency-preregistration.md:192-195`):
   - **Haiku 4.5:** strict@10 299, nDCG 0.9569, $0.631 per 1k queries.
   - **Haiku 5.5:** strict@10 298 (noise floor), nDCG 0.9589, $0.098 per 1k; p50 −145 ms, p95 +570 ms.
   - **Thinking-off probe:** Haiku 5.5 emits text-only blocks on this prompt, and disabling thinking changed nothing
     (`probe-result.json`), so there is no thinking-off lever here.
3. **Still on master:** yes. Resolution goes through the utility tier (`model-config.ts:297-302` →
   `TIER_DEFAULTS.utility`). Verified: `resolveEffectiveExpansionModel(null,{ANTHROPIC_API_KEY})` →
   `claude-haiku-4-5-20251001` (`tier_default`). Changing `DEFAULT_EXPANSION_MODEL` (`gateway.ts:131`) alone does
   **not** change keyed installs.
4. **Fix:** add `EXPANSION_MEASURED_DEFAULTS = { anthropic: 'anthropic:claude-haiku-5-5' }`, applied when
   `source ∈ {tier_default, fallback}`. Mirror `FACTS_EXTRACTION_MEASURED_DEFAULTS` at `facts/extract.ts:65-91` in
   `resolveEffectiveExpansionModel` and in gateway `reconfigureFromEngine` (`gateway.ts:587-627`). Add
   `claude-haiku-5-5` to the expansion touchpoint list (`recipes/anthropic.ts:20`), set `DEFAULT_EXPANSION_MODEL` for
   consistency, and add a behavior-change row. Keep OCR pinned separately: `getImageOcrModel` falls back to the
   expansion model (`gateway.ts:880-881`), and OCR quality on 5.5 is unmeasured.
5. **Effort:** S.
6. **Impact:** −84% expansion $ (−$0.53 per 1k expanded queries). If the GBRA-94 flip ships, this only reaches
   opt-in expansion users. High confidence.
7. **Gate:** a keyless resolver test (anthropic key → haiku-5-5 with `measured_default` source; OpenAI-only
   unchanged; explicit pins win), `gbrain models` row parity. No new paid eval is needed.
8. **Risk:** the p95 regression (+570 ms) on the one measurement; Haiku 5.5 tokenizes about 40% more tokens (187 vs
   132 input), which is already priced into $0.098.

### C4. `synthesize` / `think` on Opus 4.7
1. **Problem:** the agent-callable `synthesize` verb and `think` default to Opus 4.7, an older and pricier id.
2. **Evidence:** P1 wave `results.jsonl`: 12 cells, 1 Opus 4.7 request each, $1.132 (~$0.094/call), 86% of
   gbrain-internal spend. Path: `core/verbs.ts:318-323` → `runThink` → `think/index.ts:611-616`
   (`tier:'deep', fallback:'opus'`) → `model-config.ts:65,94`.
3. **Still on master:** yes.
4. **Fix:** a measured default for `models.think` (Opus 5.5 at $4/$20, or Sonnet 5.5 at $2/$10), not a blanket tier
   flip.
5. **Effort:** S code, M eval.
6. **Impact:** the per-token price drops 20–60%. Opus 5.5 and Sonnet 5.5 match the Claude-5 thinking regex
   (`gateway.ts:2866`), so the 32k output cap and billed thinking tokens may eat the saving; the net is unknown. Low
   confidence until measured.
7. **Gate:** a think/synthesize answer-quality eval on the newest Opus/Sonnet (preregistered, about $10–20).
8. **Risk:** answer quality on the "high-stakes synthesis op".

### C5. Full-surface description budget
1. **Problem:** every registration pins `full` (27.5k tokens per turn), and no budget covers it.
2. **Evidence:** Part 2 table; `mcp-registration.ts:24`; the budget test covers starter only
   (`test/mcp-schema-budget.test.ts:57-62`); +55% tokens and +9% cost with caching on the 2026-10-05 lists.
3. **Still on master:** yes.
4. **Fix:** extend the per-tool budget to full-only tools (`fullSurfaceOnly` params included), starting with the six
   largest above; target about 80k chars. Long guidance moves to `docs/mcp/TOOL_REFERENCE.md`, as C3 of the cost wave
   did.
5. **Effort:** M.
6. **Impact:** about −35% of the full list, which takes the measured +9% `full` premium to about +6%, so roughly −3%
   $/task. Harnesses that don't cache tool lists save more. Medium confidence.
7. **Gate:** a keyless ceiling test plus a Cat 40 dev smoke on `full` including family H (hidden tool), about $40.
8. **Risk:** hidden-tool discoverability depends on these descriptions; keep each tool's purpose and next-call
   sentences.

### C6. Synopsis pool defeats the prompt cache
1. **Problem:** `per_chunk_synopsis` starts 4 chunk calls at once per page, each sending the same cached page block.
   Anthropic "caches the prefix once the response begins" (docs.claude.com prompt caching), so the first 4 calls all
   write the cache (1.25x) instead of 1 write followed by reads at 0.1x.
2. **Evidence:** `DEFAULT_CONTEXTUAL_CHUNK_CONCURRENCY = 4` (`contextual-retrieval-service.ts:77`); the pool starts
   at `:550`; the cached block is at `page-summary.ts:181`. Per page with D doc tokens and N≥4 chunks, the waste is
   ≈ 3×(1.25−0.1)×D = 3.45×D. On an 8k-token page that is ≈$0.028/page on Haiku 4.5. Unmeasured.
3. **Still on master:** yes. The path is opt-in only (F2).
4. **Fix:** run chunk 0 alone, then fan out the rest.
5. **Effort:** S.
6. **Impact:** about −30–60% of synopsis input $ on pages over the cache minimum. Zero on default installs.
7. **Gate:** a keyless test that call 1 resolves before calls 2..N start, plus a $0.05 live probe reading
   `cache_creation_input_tokens` vs `cache_read_input_tokens`.
8. **Risk:** adds one serial call per page in a background job.

### C7. Other utility-tier consumers still on Haiku 4.5
1. **Problem:** the dream judges, `extract_atoms` (`cycle/extract-atoms.ts:670`), `edge_contradictions`, the
   synthesize verdict/triage, the synopsis job and the contradiction probe judges all resolve the utility tier, which
   is Haiku 4.5.
2. **Evidence:** a `tier: 'utility'` grep (17 files). No eval compares Haiku 5.5 on them.
3. **Still on master:** yes.
4. **Fix:** a per-consumer measured default (the C3 pattern), not `TIER_DEFAULTS.utility`.
5. **Effort:** M.
6. **Impact:** up to 10x on those calls. Volume is unknown; most run only in dream cycles.
7. **Gate:** each consumer's own eval.
8. **Risk:** see the #6335 notes.

### C8. Query-embedding LRU and batched variant embeds
1. **Problem:** repeated query text re-embeds, and expansion variants embed in N separate requests.
2. **Evidence:** 136 of 2,083 searches repeat a query already searched in the same attempt (P1). Variant embeds are
   separate calls (`arms.ts:442-452`). Embed p50 is 130 ms (GBRA-94).
3. **Still on master:** yes. There is no cache in `embedding.ts` `embedQuery`.
4. **Fix:** a small LRU keyed by (model, dims, query prefix, text), and `embedBatch` for the variants.
5. **Effort:** S.
6. **Impact:** about 130 ms on 6.5% of hybrid searches. $≈0.
7. **Gate:** a keyless unit test.
8. **Risk:** minimal, since embeddings are deterministic per model.

### C9. #6771 (contributor @lubosxyz): repair code metadata without re-embedding
1. **Problem:** a projection rebuild keys vector identity on code metadata (`start_line`, `symbol_name`, …), so
   repairing missing metadata re-embeds byte-identical chunks.
2. **Evidence:** identity at `page-state/projections.ts:208-212`. The PR adds a metadata-tolerant identity for
   `opts.code` only, prefers the same index, refuses ambiguous moves, and still requires the vector, model and
   input-hash checks.
3. **Still on master:** yes. The PR is OPEN and CONFLICTING.
4. **Fix:** take it into the wave revised. Drop its version stamps (0.60.254.0, plugin manifests, CHANGELOG), keep
   `projections.ts` and its test, and add a Postgres E2E case.
5. **Effort:** S.
6. **Impact:** one-off per repair run, e.g. 15M code-chunk tokens × $0.06/M ≈ $0.90 per large repo. The real value is
   no surprise spend.
7. **Gate:** its tests plus the full E2E tier.
8. **Risk:** low; the code is narrow and the reuse checks stay.

---

## Contributor PR #6335 (@spiky02plateau): built-in Anthropic defaults → Claude 5.5

**What it does.** It sets `TIER_DEFAULTS` (all four tiers), `DEFAULT_ALIASES`, and `DEFAULT_EXPANSION_MODEL` /
`DEFAULT_CHAT_MODEL` to haiku-5-5 / sonnet-5-5 / opus-5-5. It adds haiku-5-5 to the expansion list and prices it.
The PR is OPEN, CONFLICTING and opened 2026-10-08.

- **Already on master:** the pricing part, with a better long-prompt tier (`model-pricing.ts:167-178`), and haiku-5-5
  in the chat list (`recipes/anthropic.ts:35`).
- **Left alone:** `DEFAULT_SYNOPSIS_MODEL` and subagent `DEFAULT_MODEL`.
- **Side effect:** Claude-5 ids match `THINKING_BY_DEFAULT_MODEL_RE` (`gateway.ts:2866`), so every chat caller that
  omits `maxTokens` gets a 32,000 cap (subagent 8192 → 32000).

**Cost impact (estimated).**

- **utility** (expansion, dream judges, extract_atoms, synopsis): −90% per token.
- **reasoning** (dream synthesize, patterns, concepts, drift, default chat, and facts extraction on OpenAI-pinned
  paths, though Anthropic facts already use Haiku 5.5): −33% per token on Sonnet 5.5, offset by thinking tokens.
- **deep** (think, synthesize verb): −20% per token, also offset by thinking.
- **Subagent** jobs move to Sonnet 5.5 with a 4x output cap.

Net dollars for the reasoning and deep tiers are unknown, because Claude 5 thinking adds billed output.

**Quality evidence per task.**

- **Expansion:** GBRA-94 equal.
- **Facts extraction:** passed against Sonnet 4.6 (`2026-10-08-facts-extraction-model.md`, −4.6 pts on natural
  transcripts, inside margin). Already shipped.
- **Synopsis:** none. LHF prereg `:94` explicitly did not measure synopsis vectors.
- **Dream judges, extract_atoms, think, subagent:** none.

TODO-D (gbrain `TODOS.md:622-623`) names exactly this gap: measured cost and quality on a representative cycle/dream
run, plus an output-cap policy for small-cap callers.

**Narrower, low-risk version.**

1. Expansion only, via a measured default (C3).
2. Optionally the `haiku` alias, which only affects callers that name it.
3. Leave `TIER_DEFAULTS` and `DEFAULT_CHAT_MODEL` for a TODO-D wave that includes a small-cap caller audit, since
   `classify.ts` uses `maxTokens: 200` and judges use small caps.

Credit "Contributed by @spiky02plateau" with Co-Authored-By and add `Supersedes #6335` if the wave revises it.

---

## Findings that correct the brief (not ranked items)

- **F1. The 2.4x figure is stale**; see Bottom line.
- **F2. `tokenmax` does not produce per-chunk synopses by default.** Import demotes `per_chunk_synopsis` to `title`
  (`import-contextual-mode.ts`), and no code path enqueues `contextual_reindex_per_chunk`. The uncommitted picker
  text in the shared gbrain checkout ("per-chunk synopsis context") would therefore describe a feature new installs never
  get. Either drop that line, or wire a consented, capped synopsis backfill (a product decision). Default synopsis
  spend is $0.
- **F3. Do not touch `DEFAULT_SYNOPSIS_MODEL`.** It feeds `computeCorpusGeneration` for the title tier
  (`import-contextual-mode.ts` return, `contextual-retrieval-service.ts:180`). Changing it changes every title-tier
  page's corpus generation and would force a re-embed of the whole brain. #6335 is right to leave it; any model-id
  wave needs a decoupled anchor first.
- **F4. Rerank cost on tokenmax.** Once expansion is off, rerank is tokenmax's largest per-query provider cost (about
  $0.6 per 1k, code anchor). It is already on the cheapest Voyage reranker, and the skip gate found nothing to skip.
  No cheap win.
- **F5. Dead code:** `facts/classify.ts` `classifyAgainstCandidates` (Haiku 4.5, utility) has no production caller
  (test-only). It is not a cost; it could be deleted.

## Method and what is unverified

- **Measured here:** tool-list sizes (cl100k via `estimateTokens`); transcript field breakdown and elision replay;
  Haiku probe latency and tokens (52 calls, < $0.02); `gbrain_internal` cost split.
- **Taken from eval docs:** expansion $, latency and recall (GBRA-94); facts extraction $ and quality (2026-10-08);
  $/success (2026-10-10, 2026-10-15); surface cost (2026-10-05).
- **Estimates, not measured:**
  - rerank $/1k (code anchor);
  - agent $ impact of C1 and C5 (char-to-dollar mapping);
  - C6 savings (mechanism from Anthropic docs);
  - Haiku 5.5's minimum cacheable length;
  - per-phase dream default-on status (only synthesize, patterns, drift, auto_think, enrich_thin and
    conversation_facts_backfill were checked).
