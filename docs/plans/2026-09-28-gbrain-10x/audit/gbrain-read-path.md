# gbrain read-path audit (search / fusion / rerank / think / graph / trajectory / MCP reads / in-repo evals)

- Repo: `gbrain` @ `6bb88d128` (v0.59.3.0, master). Read-only; nothing edited in either repo.
- Method: code reading plus executable probes. Probes ran against a `git archive HEAD` copy with its own `bun install` at `audit/scratch-readpath/gb` (the checkout has no `node_modules`). Probe sources are in `audit/scratch-readpath/probes/*.test.ts` and raw outputs in `audit/scratch-readpath/*.out`. Every engine probe uses in-memory PGLite with deterministic basis-vector embeddings: no network, $0 spent.
- Severity: **P0** = wrong published number or broken measurement/ranking at the core, **P1** = real bug or misleading behavior, **P2** = hygiene, perf, or a ceiling.
- "Verified" means reproduced by a probe or proven directly from the code path quoted. "Suspected" means reasoned but not reproduced.

---

## Summary table

| # | Sev | Finding | Status |
|---|---|---|---|
| 1 | **P0** | RRF fuses at **chunk** grain while every arm is **page**-grain with a different representative chunk, so cross-arm agreement for a page is split instead of summed. A page ranked #1 by both keyword and vector loses to a page ranked #2 by both. The keyword-only chunk sinks below unrelated filler. | Verified (probe) |
| 2 | **P1** | The alias hop and the exact-lookup tier run **after** the reranker and re-sort the whole list by RRF `score`, which throws away the cross-encoder order. A reranker-#1 alias page drops to #3. This hits the default `balanced` mode (reranker ON). | Verified (probe) |
| 3 | **P1** | Queries classified as entity intent ("who is / what is / tell me about / describe / summarize / background / overview") get an auto `detail=low`, which **hard-filters to compiled_truth chunks in SQL** on every arm. The zero-result auto-escalation only fires for an *explicit* `detail:'low'`. Timeline-only answers become invisible. | Verified (probe) |
| 4 | **P1** | `findTrajectory` returns the **oldest** N facts (`ORDER BY valid_from ASC LIMIT 100`). The formatter then keeps the "most recent" of that already-truncated window. For an entity with more than 100 facts, think and the LongMemEval trajectory route present a stale "latest" value. | Verified (probe) |
| 5 | **P1** | When the reranker fails hard (HTTP 5xx, timeout, budget), nothing is stamped in `meta.degraded`. Only `no_key` and a 200-empty response are stamped. Eval rows, telemetry, CRAG, and `--explain` cannot tell whether reranking happened. | Verified (probe) |
| 6 | **P1** | The exact-match boost (intent-weights) is structurally dead: entity intent requires framing words, and the boost requires query == title/slug. The title-phrase boost only fires when the whole query is inside the title, so "who is Alice Example" never boosts page "Alice Example". The high-value direction (a title or alias contained *in* the query) is missing. | Verified (probe) |
| 7 | **P1** | Unified multimodal routing re-scores with cosine between a Voyage-multimodal (1024-d) query vector and the **text** column (`resolvedCol.name`, e.g. 1536-d). The result is a truncated dot product, or NaN when dims are reversed, blended at 0.3 weight. | Verified (unit) |
| 8 | **P1** | `hybridSearch` rebuilds `searchOpts` and **drops `exclude_slugs`, `exclude_slug_prefixes`, `include_slug_prefixes`**. They are silently ignored by every arm. Separately, the PGLite `searchKeyword` ignores `exclude_slugs` and `type` (the Postgres engine honors both), which breaks engine parity. | Verified (probe) |
| 9 | **P1** | The in-repo `gbrain eval --strategy vector` embeds queries with `embed()` (document/passage input_type) instead of `embedQuery()`. On asymmetric providers (Voyage and others) the vector baseline is handicapped, so hybrid-vs-vector comparisons are biased toward hybrid. | Verified (code) |
| 10 | **P1** | The NamedThingBench harness (`src/eval/retrieval-quality/harness.ts`) turns a search **error** into `[]`, which scores as a *perfect* hard-negative (clean, hit@1, RR=1). Errors are not counted anywhere. | Verified (code) |
| 11 | **P1** | Dedup's "compiled-truth guarantee" evicts a matching chunk (e.g. score 0.90) for an arbitrary compiled_truth chunk (e.g. 0.10) and does not re-sort, so the output is out of score order. | Verified (probe) |
| 12 | P1 | Think's "graph retriever" only lists up to 30 slug *names* in the prompt. No neighbor content is hydrated or fused. `rounds>1` is a documented no-op. | Verified (code) |
| 13 | P1 | Hardcoded `DEFAULT_SOURCE_BOOSTS` fit one personal vault layout (`originals/` 1.5, `writing/` 1.4, `openclaw/chat/` 0.5 …). They multiply raw cosine inside the vector arm for every user and every benchmark corpus. | Verified (code), impact suspected |
| 14 | P2 | With expansion on (tokenmax, and the MCP `query` op defaults `expand=true` in every mode) and `expansion_variant_budget=null`, the vector arm casts 1+N full-weight votes while keyword and title cast 1 each. The keyword arm never runs on variants. | Verified (code) |
| 15 | P2 | Keyword arm: strict-AND `websearch_to_tsquery` with un-normalized `ts_rank`. Relaxed OR rows are dropped whenever vector returns anything, so for natural-language questions hybrid is mostly vector plus title. | Verified (code) |
| 16 | P2 | Latency: the query embedding and the reranker call are serialized behind lexical SQL, the relational arm, and three `getAllConfig` reads. There are 14 engine round-trips for a trivial query, plus about 5 more in `hybridSearchCached`. | Verified (probe) |
| 17 | P2 | The token budget packer is a greedy prefix: one oversized chunk truncates everything after it. The char/4 estimate undercounts CJK by about 4x. The salvage slice can split a surrogate pair. | Verified (code) |
| 18 | P2 | Backlink boost counts link *rows* (duplicates, self-links, and soft-deleted contributors when there is no policy) rather than distinct linking pages. This is inconsistent with adjacency's `COUNT(DISTINCT)`. | Verified (code) |
| 19 | P2 | `get_tags` has no private or soft-delete filter, so a remote caller can read the tags of a `visibility: private` page. Its unscoped default is the `'default'` source only. | Verified (code) |
| 20 | P2 | Assorted: RRF rank off-by-one (1/60 vs the standard 1/61); think fuses on a different rank base; type-diversity dedup is a no-op at top-k; the semantic cache is dead code but its setup still costs round-trips; trajectory 5 s timers are never cleared; the recursive graph walk enumerates all simple paths (suspected latency cliff). | Mixed |

---

## Detailed findings

### 1. [P0] RRF fuses chunks, but arms return pages: cross-arm agreement is split, not summed

**Where**
- `src/core/search/hybrid.ts:2952-2955`: `rrfKey = ${source}:${slug}:${chunk_id ?? chunk_text.slice(0,50)}` (chunk grain).
- Keyword arm is page-grain, keeping the best FTS chunk per page: `postgres-engine.ts:1416+`, `buildBestPerPagePoolCte` at `sql-ranking.ts:245-251`.
- Vector arm is page-grain, keeping the best cosine chunk per page (same CTE, `postgres-engine.ts:1929+`).
- Title arm is page-grain with a representative chunk = **first compiled_truth chunk**: `postgres-engine.ts:1719` `ORDER BY (cc.chunk_source = 'compiled_truth') DESC, cc.chunk_index ASC LIMIT 1`.
- After fusion, `cosineReScore` (`hybrid.ts:2122`, `3149-3202`) blends `0.7*normRrf + 0.3*cosine(query, that chunk)`. A keyword-picked chunk that is lexically perfect but semantically off gets a low cosine *and* only one arm's vote.

**Why it's wrong.** Each arm votes for a page, but with different chunk ids, so the votes land on different fusion keys. RRF's core signal is agreement across arms, and it is lost whenever arms pick different chunks of the same page. That is the common case for multi-chunk pages: the title arm always picks chunk 0, and keyword and vector pick their own best chunks.

**Proof** (`probes/fusion-split.test.ts`, output `fusion.out`):
```
keyword arm [ "notes/page-a#1", "notes/page-b#0" ]
vector arm  [ "notes/page-a#2", "notes/page-b#0", filler-0..4 ]
hybrid [ "notes/page-b#0:0.912", "notes/page-a#2:0.656", filler-0..4 (0.40..0.38), "notes/page-a#1:0.356" ]
```
Page A is #1 in **both** arms and still loses to B, which is #2 in both. A's keyword-winning chunk ranks below 5 unrelated fillers. Under page-level RRF, A = 2/60 and B = 2/61, so A wins.

**Impact.** This is the most plausible mechanical root cause of the long-standing "hybrid loses to its own vector arm" receipts:
- TODOS.md:1449: Cat 13 "vector+grep RRF fusion 40.5 < grep 46.2 < vector 49.5; gbrain hybrid 35.6"
- TODOS.md:180: hybrid 57.8 vs bare vector 60.5 nDCG@5
- the LongMemEval hybrid-vs-vector gap cited in `hybrid.ts:2040-2050`

Every published hybrid number carries this defect.

**Fix.** Fuse at page key `(source_id, slug)`: sum per-arm RRF contributions per page. Then choose the display chunk(s) per page, e.g. the arm-best chunk with the highest cosine, keeping up to `maxPerPage` distinct chunks. Apply the cosine blend at page level (max cosine over the page's candidate chunks). Keep chunk identity only for snippet selection.

**Eval that proves it.** Cat 13 conceptual nDCG@5 (target: hybrid ≥ bare vector), LongMemEval `recall_all@5` hybrid vs `--vector-only`, NamedThingBench `multi-chunk-dilution` hit@3, plus a new unit test using exactly the probe above.

---

### 2. [P1] Post-rerank alias hop and exact-lookup tier discard the reranker order

**Where**
- `hybrid.ts:966` `out.sort((a, b) => b.score - a.score);` in `applyAliasHop`.
- `exact-lookup.ts:229` the same, in `applyExactLookupTier`.
- Both are called after `applyReranker` (`hybrid.ts:2241-2290`).
- `applyReranker` stamps `rerank_score` but deliberately keeps `score` as the RRF/cosine score (`rerank.ts` comment "Doesn't replace `score`").

**Proof** (`probes/rerank-order.test.ts`, `rerank-order.out`). Reranked input order `c(rr .95), b(.60), a(.10)`, RRF scores `a .9 > b .5 > c .3`:
- exact-title tier fires → `[acme widget, a, b, c]` (the reranker put c first; now it is last).
- alias hop for `c` (already the reranker's #1) → `[a, b, c]`: the alias-hit page is *demoted* from #1 to #3, because its RRF score ×1.10 is still the lowest.

**Impact.** In `balanced` (the default, `reranker_enabled: true`, `mode.ts:477`) and `tokenmax`, every query that triggers an alias or exact-title/slug identity match silently reverts to un-reranked order for all non-identity rows. Those queries (≤6 tokens, named things) are exactly the lookup queries BrainBench and NamedThingBench measure.

**Fix.** After reranking, set a monotone rank score, or have both helpers insert and promote in place without a global re-sort (e.g. splice the identity row to index 0 and keep the relative order of everything else). Add a test pinning that non-identity order equals reranker order.

**Eval.** NamedThingBench title-substring / alias-synonym hit@1 with reranker on vs off; the R1 rerank A/B script.

---

### 3. [P1] Auto "entity intent" hard-filters to compiled truth, with no auto-escalation

**Where**
- `query-intent.ts:609` `case 'entity': return 'low';`. `ENTITY_PATTERNS` at `query-intent.ts:110-120` include `what (is|does|are)`, `tell me about`, `describe`, `summar(y|ize)`, `overview`, `background`, `profile`.
- `hybrid.ts:1296` `const detail = opts?.detail ?? suggestions.suggestedDetail;` passes it into `searchOpts.detail`.
- Every arm adds `AND cc.chunk_source = 'compiled_truth'`: `postgres-engine.ts:1428/1540`, vector `:1934`, title representative `:1717`; PGLite `pglite-engine.ts:2424/2728/2817`.
- `hybrid.ts:2216` `if (deduped.length === 0 && opts?.detail === 'low')` escalates only on an **explicit** low.
- The same auto `low` also turns on the 2.0x compiled-truth boost (`shouldBoostCompiledTruth`, `hybrid.ts:124`). The file's own comment at `hybrid.ts:104-116` says this makes ranking "categorically compiled-truth-only".

**Proof** (`probes/readpath-e2e.test.ts`, `e2e1.out`). Corpus: a meeting page whose only content is a timeline chunk "Alice Example founded the Widget Guild", plus an unrelated grocery note. Query "who is the founder of the Widget Guild":
```
intent entity detail low
auto results [ "notes/unrelated:compiled_truth:Grocery list: apples and bread" ]
explicit medium results [ "meetings/2024-03-01-guild", "notes/unrelated" ]
```
The answer is invisible with default settings, and the only result is irrelevant. Because the result set is not empty, even an escalation rule keyed on zero results would not have fired.

**Impact.** In a real brain, people and company pages keep dated evidence in timelines, and "what does X do / tell me about X / summarize the Y meeting" is the most common agent phrasing. The LongMemEval adapter writes everything as compiled_truth, so LME is not affected, but BrainBench-style corpora with timelines are (suspected; not measured).

**Fix.** Do not hard-filter on *auto*-detected detail. Keep the SQL filter only for explicit `detail:'low'`. For auto entity intent, use a soft prior (e.g. a 1.1–1.2x compiled-truth tilt, not 2.0x). At minimum, run the escalation on auto-low too, and also when fewer than N results come back.

**Eval.** BrainBench entity/relational questions whose gold evidence lives in timeline sections; add a qrels canary with timeline-only answers.

---

### 4. [P1] Trajectory queries return the oldest 100 facts; think and LME then call the stale tail "latest"

**Where**
- `postgres-engine/facts.ts:549` `ORDER BY valid_from ASC, id ASC LIMIT ${limit}` (PGLite twin in `pglite-engine/facts.ts:~494`).
- Callers use `limit: 100`: `think/index.ts:636`, `eval/longmemeval/trajectory-route.ts:45`.
- `trajectory-format.ts:189-205` "Keep most-recent N (slice from tail)". It assumes the engine returned the complete series.

**Proof** (`probes/trajectory-limit.test.ts`, `traj.out`). 150 `mrr` facts, values 0..149 on consecutive days:
```
points 100 newest returned value 99 date 2024-04-09 (true newest = 149 on 2024-05-29)
  as of 2024-04-09: 99 — mrr is 99 (superseded prior)
```

**Impact.** Knowledge-update and temporal answers ("what's my current X", "how has X changed") are told a stale value is current for any entity with more than 100 facts. The founder scorecard and `eval trajectory` are affected too, when callers pass smaller limits. For LongMemEval, a heavy "user" entity from the Haiku extractor could plausibly exceed 100 facts per question haystack. That is suspected, not measured, so the knowledge-update slice may be understated.

**Fix.** Select the newest N (`ORDER BY valid_from DESC, id DESC LIMIT N`, then reverse in JS), or window per metric in SQL (`ROW_NUMBER() OVER (PARTITION BY claim_metric ORDER BY valid_from DESC) <= perMetricCap`). Also report `truncated: true`.

**Eval.** LME knowledge-update slice with trajectory on; gbrain-evals Cat 25 trajectory routing; the probe above as a regression test.

---

### 5. [P1] A hard reranker failure is invisible in response meta

**Where**
- `rerank.ts:134-152`: in the catch branch, only `reason === 'no_key'` calls `onSkip`. Every other failure (HTTP error, timeout, budget, unknown) writes an audit file line and `return results` without calling `onSkip` or `onPassThrough`.
- `hybrid.ts:2241-2252` only wires those two callbacks into `degraded[]`.

**Proof** (`readpath-e2e.test.ts`, `e2e.out`). `rerankerFn` throws "HTTP 503 upstream" → results come back in RRF order, `degraded []`.

**Impact.**
- Eval capture rows and telemetry record a clean reranked run.
- CRAG `gradeRetrievalConfidence` sees no rerank score and may escalate spuriously.
- The autocut decision is a silent no-op.
- In `balanced` mode, a flaky reranker (5 s timeout) silently changes ranking quality with no signal on the wire.

**Fix.** Add a `rerank_failed` degraded stage with an enumerated reason (`timeout|provider_error|budget`). Treat it as `affectsRecall` for cache TTL purposes if the cache is ever re-enabled.

**Eval.** A unit test (the probe above). In gbrain-evals, have runners assert "reranked" on every row of reranker-on arms.

---

### 6. [P1] Identity boosts are dead for natural phrasing; "entity mentioned in query" is missing

**Where**
- `intent-weights.ts:140-151`: `applyExactMatchBoost` requires `slug === q || title === q`. It only runs for non-1.0 intents (entity 1.25, event 1.10), but entity intent is *defined* by framing words ("who is …"), so the full query can never equal a title.
- `title-match.ts:89` `containsTokenRun(tTokens, qTokens)` requires the query to be inside the title.
- The exact-lookup title probe compares the normalized full query to the normalized title.

**Proof** (bun one-liner in the audit log):
```
"who is Alice Example"         intent=entity  titleBoost(alice)=false exactBoost=[1,1]
"Alice Example"                intent=general titleBoost(alice)=true  exactBoost=[1,1]  (general ⇒ factor 1.0)
"tell me about Acme Widget Co" intent=entity  titleBoost(acme)=false  exactBoost=[1,1]
```

**Impact.** The whole exact-match intent boost never fires in practice. The title boost and the exact-lookup tier only help bare-name queries. Framed entity questions, the dominant agent phrasing, get no identity signal at all.

**Fix.** Add a query-side entity linker: find page titles and aliases that occur as token runs **inside** the query, using the already-fetched title arm plus `page_aliases` lookups on query n-grams of 1–5 tokens. Boost or inject those pages with the same bounded shape as the alias hop. Delete or repair `applyExactMatchBoost`.

**Eval.** NamedThingBench `generic-to-named` and `title-substring` with framed templates ("who is X", "tell me about X"); BrainBench entity questions.

---

### 7. [P1] Unified multimodal routing re-scores in the wrong embedding space

**Where**
- `hybrid.ts:1741-1757`: the unified path sets `queryEmbedding = unifiedEmbedding` (voyage-multimodal-3, 1024-d, searched on `embedding_multimodal`).
- `hybrid.ts:2122` then calls `cosineReScore(engine, fused, queryEmbedding, resolvedCol.name)`. `resolvedCol` is the text column (default `embedding`), because unified mode does not change `resolvedCol`.
- `cosineSimilarity` (`hybrid.ts:3204-3213`) loops over `a.length` with no dimension check.

**Proof** (bun one-liner):
```
q(1024) vs doc(1536) cosine = 1.0000000000000107   ← partial-prefix dot, meaningless
doc(1536) vs q(1024) cosine = NaN                  ← NaN poisons sort
hydrate column = embedding
```

**Fix.** Hydrate from `'embedding_multimodal'` when `unifiedDone`. Add a dimension guard to `cosineSimilarity` (return null or skip the rescore on mismatch). Image rows in `both` mode have the same class of problem: they are re-scored against the text column, get cosine 0, and take a 30% penalty (suspected).

---

### 8. [P1] Exclusion filters silently dropped (hybrid), plus engine parity break (PGLite keyword)

**Where**
- `hybrid.ts:1298-1352`: the explicit `searchOpts` rebuild carries `types`, dates, `sourceId(s)`, `excludePrivate`, etc., but **not** `exclude_slugs`, `exclude_slug_prefixes`, `include_slug_prefixes`.
- Yet `hybridSearchCached` folds `resolveHardExcludes(opts.exclude_slug_prefixes, …)` into the knobs hash (`hybrid.ts:2584`), and the exact-lookup tier honors `exclude_slugs`, so the pipeline is internally inconsistent.
- `pglite-engine.ts:2445-2475` (`searchKeyword`) applies neither `opts.type` nor `opts.exclude_slugs`. `pglite-engine.ts` `searchVector` and the Postgres `searchKeyword` (`postgres-engine.ts:1466-1478`) do. That violates the "engine parity" invariant in CLAUDE.md.

**Proof** (`probes/exclude.test.ts`, `exclude.out`):
```
engine.searchKeyword with excludes -> [ "notes/a" ]          (PGLite ignored exclude_slugs)
hybridSearch with excludes         -> [ "notes/a", "private-drafts/b" ]   (both filters ignored)
```

**Impact.** `grade-takes.ts:396` passes `exclude_slugs` and survives only because of a "belt-and-suspenders" post-filter. SDK callers of `gbrain/search/hybrid` that use prefix excludes get the excluded content anyway.

**Fix.** Forward the three fields in the rebuild. Add them to PGLite `searchKeyword`. Add an engine-parity test for `exclude_slugs` and `type` on the keyword arm.

---

### 9. [P1] `gbrain eval` vector baseline uses document-side query embeddings

**Where.** `src/core/search/eval.ts:241` `const embedding = await embed(query);`. Hybrid uses `embedQuery` (`inputType: 'query'`, `gateway.ts:1871-1876`). On Voyage and other asymmetric providers (`gateway.ts:1192-1230`), `embed()` sends `input_type=passage/document`.

**Impact.** Any "hybrid vs vector" row produced by `gbrain eval --strategy vector` (and replays built on `runEval`) under-reports the vector arm. The vector strategy also ignores `embeddingColumn` routing, and the keyword strategy ignores `orFallback`, so none of the three strategies measures what production runs.

**Fix.** Use `embedQuery(query, { embeddingModel, dimensions })` with the resolved column. Thread the column into `searchVector`.

---

### 10. [P1] NamedThingBench harness scores search errors as perfect hard-negatives

**Where.** `src/eval/retrieval-quality/harness.ts:118` `try { ranked = await searchFn(q.query); } catch { ranked = []; }`. For `hard-negative`, `[]` means clean, so `hit_at_1 = hit_at_3 = true` and RR = 1. There is no error count in the report, so an outage inflates the hard-negative family and silently deflates the others.

**Fix.** Record `errored: true` per question, exclude errored questions from rates (or count them as failures), and surface `errored_count` in the report and the gate.

---

### 11. [P1] The dedup "compiled-truth guarantee" evicts matching evidence and breaks ordering

**Where.** `dedup.ts:185-224`. When a page has no compiled_truth chunk in the post-cap set, it swaps the page's lowest kept chunk (`output[lowestIdx] = candidate`) for the best compiled_truth chunk from the pre-dedup pool, **at the evicted chunk's position**, and never re-sorts.

**Proof** (bun one-liner):
```
in : a/timeline .95, a/timeline .90, b/ct .80, a/ct .10
out: a/timeline .95, a/ct 0.10, b/ct 0.80      ← 0.90 matching chunk evicted; 0.10 ranked above 0.80
```

**Impact.** Snippets lose the matching evidence, and downstream consumers that assume score order (slice, token budget, evidence, CRAG) see inverted rows.

**Fix.** Append the compiled_truth chunk as an extra row, or only swap when its score is within X of the evicted one, then re-sort. Reconsider the guarantee now that arms are page-grain.

---

### 12. [P1] The think "graph retriever" contributes names, not evidence; multi-round is a no-op

**Where**
- `think/gather.ts:209-225` (the graph stream returns slugs only).
- `think/index.ts:553-555` `Reachable: ${graphSlugs.slice(0,30).join(', ')}` is the only use in the prompt. None of these pages is hydrated or fused into `<pages>`, even though the header comment (`gather.ts:1-16`) says four streams are "fused via RRF".
- `think/index.ts:884-887`: `rounds>1` pushes `ROUNDS_GT_1_NOT_GAP_DRIVEN_IN_V028` and breaks.
- Also `gather.ts:172`: window-merge dedup keys on `slug` only, collapsing same-slug pages across sources. Takes fusion keys on `page_slug#row_num`, also not source-qualified.

**Fix.** Hydrate the top-K graph neighbors (by edge type and hop) via a batched `getPages`, add them as a ranked list, and RRF them with hybrid at page key. Implement gap-driven round 2 (re-query on the entities and claims the synth marked as missing).

**Eval.** A BrainBench multi-hop/relational think category with `--anchor`; Cat 20-style synthesis grounding.

---

### 13. [P1] Personal-vault source boosts are global defaults

**Where.** `source-boost.ts:18-35` (`originals/` 1.5, `writing/` 1.4, `concepts/` 1.3, `people/`/`companies/`/`deals/` 1.2, `daily/` 0.8, `media/x/` 0.7, `openclaw/chat/` 0.5, `extracts/` 0.3). These are applied via `buildSourceFactorCase` as a multiplier on raw cosine and `ts_rank` **inside** each arm's candidate CTE, before best-per-page and the LIMIT (`postgres-engine.ts:1929+`). A cosine of 0.30 on `originals/` beats 0.44 elsewhere.

**Impact.** This is an unvalidated prior for every non-owner brain, and it changes which pages even enter the pool. On benchmark corpora that happen to use `people/`/`companies/` slugs, it tilts toward entity pages, a possible benchmark-shape advantage that does not generalize (suspected).

**Fix.** Make the defaults empty (or limit them to the three hard excludes). Ship the vault map as an opt-in preset. Measure it with cat13b source-swamp before any default change.

---

### 14. [P2] Expansion over-weights the vector arm

`fusion-lists.ts:177-190`: with `expansion_variant_budget = null` (the default in all bundles, `mode.ts:420/475/537`), each variant list fuses at full weight. Keyword and title fuse once, and only for the original query (`hybrid.ts:1437-1458`). With 3 variants, vector has about 4x the vote mass.

**Fix.** Default the budget to 1.0 (all variants together = one original list) and/or run the keyword arm on variants. **Eval:** LME `--expansion` and Cat 13, with a budget sweep (the harness already supports `--expansion-variant-budget`).

### 15. [P2] Keyword arm design caps lexical recall

- Strict AND via `websearch_to_tsquery`, with raw `ts_rank` (no length normalization, no IDF) at `postgres-engine.ts:1531`.
- The OR fallback only fires on zero strict hits, and those rows are **dropped** whenever any text vector list is non-empty (`hybrid.ts:2061-2066`).
- The chunk tsvector never includes the page title (per the `hybrid.ts:1419-1425` comment).

**Net effect.** For multi-term natural-language questions, the lexical arm contributes little beyond the title arm.

**Fix.** Use a BM25-style OR query (ts_rank_cd with normalization 32/1, or a real BM25 index such as pg_search where available), prepend the title and heading path into the chunk tsvector (weight A), and let fusion weigh it instead of the all-or-nothing relaxed drop.

**Eval.** LME keyword-only and hybrid; Cat 13 synonym/paraphrase slices; NamedThingBench.

### 16. [P2] Latency: serialized network calls and redundant config reads

Measured with a Proxy over PGLite (`readpath-e2e.test.ts` "count engine round-trips"). A trivial one-page query makes 14 engine calls: `getAllConfig×2`, `getConfig`, `searchKeyword`, `searchTitles`, `searchVector`, `getUnverifiedExtractionPageIds`, `getEmbeddingsByChunkIds`, `getBacklinkCounts`, `getAdjacencyBoosts`, `executeRaw×2`, `resolveAliases`, `getContentFlagsByPageIds`. `hybridSearchCached` adds another `getAllConfig` plus intent-pattern and cache-config loads, even though `semanticResultCacheAvailable()` is hard-coded `false` (`query-cache.ts:35`).

The critical path is sequential:
1. config reads
2. keyword+title (parallel)
3. relational arm (`hybrid.ts:1512`, with its own serial seed resolution and fanout at `relational-recall.ts:304-336`)
4. expansion LLM
5. **query embed** (`hybrid.ts:1827+`)
6. vector
7. five enrichment queries, one after another (`runPostFusionStages`)
8. reranker HTTP
9. alias and exact lookup

On hosted Postgres (20–50 ms RTT), that is roughly 0.4–1 s of avoidable wall time.

**Fix.**
- Start `embedQuery(query)` at function entry, concurrently with the lexical arms (and with expansion).
- Merge backlink, salience, effective-date, unverified, and content-flag reads into one batched CTE.
- Load config once per request and pass it down; skip cache setup when the cache is unavailable.

**Eval.** A p50/p95 search-latency harness on Postgres with a 10k-page corpus, before and after.

### 17. [P2] Token budget packing

`token-budget.ts:122` breaks at the first item that doesn't fit, so one 2k-token chunk at rank 3 drops ranks 3..25 under `balanced`'s 12 000 budget. `estimateTokens = ceil(len/4)` (`:41`) undercounts CJK by about 3–4x, so budgets overshoot model context. The salvage path at `:167` uses `slice`, not `truncateUtf8` (possible lone surrogate). **Fix:** skip-and-continue packing (or truncate oversized items to a per-item cap), a script-aware estimator, and `truncateUtf8`.

### 18. [P2] Backlink count semantics

`read-enrichment.ts:85` uses `COUNT(l.id)`, which counts duplicate link rows and self-links. With no policy (a trusted local call), contributor pages are not filtered for `deleted_at`. Adjacency uses `COUNT(DISTINCT from_page_id)` (`:101`). **Fix:** `COUNT(DISTINCT l.from_page_id) FILTER (WHERE l.from_page_id <> p.id)` plus a deleted-contributor filter.

### 19. [P2] `get_tags` privacy and scope

`ops/tags.ts:53-66` calls `engine.getTags(slug, sourceScopeOpts(ctx))`. There is no `readPolicyOpts`, and the SQL at `postgres-engine.ts:3737-3754` filters neither `visibility: private` nor `deleted_at`, so a remote caller learns that a private page exists and reads its tags. An unscoped call defaults to the `'default'` source, unlike search's all-sources rule. **Fix:** use `readPolicyOpts(ctx)` and add the private and deleted predicates.

### 20. [P2] Smaller items

- **RRF rank base.** `rrfFusion(Weighted)` uses 0-based rank, so the top item gets `1/60` (`hybrid.ts:3038/3099`). Standard RRF is `1/(k+1)`. Think's `fuseRanked` uses `rank+1` (`gather.ts:73-78`), so the two fusers disagree. The effect is tiny but inconsistent with the header doc.
- **Type diversity.** `enforceTypeDiversity` (`dedup.ts:141-160`) computes the 60% cap over the whole candidate pool (about 100 rows), not the returned `limit`, so it never diversifies the top-k. It only trims the tail.
- **Graph signals ordering.** `graph-signals.ts` `topK = results.slice(0, K)` runs mid-`runPostFusionStages`, after earlier stages mutated scores without re-sorting, so "top-K" is the pre-boost order.
- **Trajectory timers.** `think/index.ts:639` and `trajectory-route.ts:46` create `setTimeout(() => resolve([]), 5000)` per candidate and never clear it or `unref()` it. That leaks timers and can hold the process up to 5 s.
- **Recursive graph walk (suspected latency cliff).** `postgres-engine.ts:3517+` carries a per-path `visited` array (no global visited set), and the outer `ORDER BY depth…` forces full materialization of every simple path up to `depth` before `LIMIT 5000`. The op clamps depth and defaults remote `both` to a lower depth, but a dense hub at depth 3–4 is still combinatorial. Not reproduced here. **Fix:** BFS with a global visited set, or a `DISTINCT ON (node)` per depth.
- **CRAG escalation drops per-call knobs.** `ops/search.ts:670-705`: the re-run drops the caller's `mode`, `salience`, `recency`, and `tokenBudget`, so an adopted escalation can use a different mode than the caller asked for.
- **PGLite `stale` subquery.** PGLite `searchKeyword` computes `stale` via a per-row correlated `MAX(timeline_entries.created_at)` subquery. Postgres returns `false AS stale`. That is a parity difference plus extra cost on the hot path.
- **LongMemEval scoring definition.** Search runs with `limit = k` chunks (`eval-longmemeval.ts:1409`), while `recall_*@k` is defined over distinct sessions (`metrics.ts scoreRecall`). With up to 2 chunks per page, `distinct_sessions_in_top_k` can be below k. It is consistent run to run but not apples-to-apples with competitors' R@k-sessions (suspected understatement). **Fix:** request `limit ≥ k × maxPerPage`, or set `dedupOpts.maxPerPage = 1` for session-recall scoring, and log the distinct-session count.

---

## TODOS.md items that are real read-path quality blockers

- **TODOS.md:1449 (P1) and :180 (P3), Cat 13 "fusion itself is the suspect".** Finding #1 is a concrete, reproduced mechanism: page votes split across chunk keys. Finding #15 (AND-keyword noise) and #14 (expansion weighting) are secondary. Recommend re-running Cat 13 after the page-grain fusion fix before any new "arm-confidence" knob.
- **TODOS.md:163 (P2), session-aware autocut.** Still correct. Note that autocut is order-agnostic, but its input order is scrambled by finding #2 whenever alias or exact lookup fires.
- **TODOS.md:1468+ (P2), LME temporal gap.** The receipt says misses are near-duplicate embedding ranking, and the reranker is the lever. Finding #5 (silent rerank failure) means any run with provider hiccups would under-report the reranker's effect without saying so.
- **TODOS.md:2003 (P2), cache rows written while reranker skipped.** Moot while `semanticResultCacheAvailable()` is `false`. The cache setup still costs round-trips (finding #16).

---

## Top 10 highest-leverage improvements (each paired with the eval that would prove it)

1. **Page-grain RRF with per-page chunk selection** (fixes #1). *Proof:* Cat 13 nDCG@5 hybrid ≥ vector; LME `recall_all@5` hybrid vs `--vector-only`; NamedThingBench multi-chunk-dilution hit@3; the new unit test from `probes/fusion-split.test.ts`.
2. **Query-side entity linking** (a title or alias contained in the query → bounded boost or inject) plus repairing the dead exact-match boost (#6). *Proof:* NamedThingBench generic-to-named and title-substring with framed templates; BrainBench entity/relational hit@1.
3. **Keep reranker order through the identity tiers, and feed the reranker `title + heading + chunk`** (#2, and doc context in `rerank.ts:123`). *Proof:* NamedThingBench hit@1 with reranker on vs off; the R1 rerank A/B; LME temporal slice (the reranker is the stated lever).
4. **Soft compiled-truth prior instead of the auto `detail=low` hard filter, and auto-escalation** (#3). *Proof:* BrainBench questions with timeline-resident gold; a timeline-only qrels canary (the probe above).
5. **BM25-style lexical arm** (OR query with normalized `ts_rank_cd`/BM25, title and headings folded into the chunk tsvector, graded weight instead of the relaxed-row drop) (#15). *Proof:* LME keyword-only and hybrid rows; Cat 13 synonym slice; keyless installs (no embedder) on BrainBench.
6. **Newest-first trajectory windows in SQL, with a truncation flag** (#4). *Proof:* LME knowledge-update slice (trajectory on); gbrain-evals Cat 25 trajectory routing; the probe above.
7. **Balanced expansion fusion** (default `expansion_variant_budget = 1.0`, keyword arm on variants) (#14). *Proof:* LME `--expansion` with a budget sweep; Cat 13 held-out concepts.
8. **Latency pass**: parallel query embed at entry, one batched enrichment CTE, a single config load per request, skipping dead cache setup (#16). *Proof:* a p50/p95 search-latency benchmark on Postgres at 10k and 100k pages; engine round-trips per query drop from about 19 to about 7.
9. **Think evidence upgrade**: hydrate and fuse graph neighbors as pages, and gap-driven round 2 (#12). *Proof:* a BrainBench multi-hop think category; Cat 20 grounding rate; citation-in-gather rate (`CITATION_NOT_IN_GATHER` warnings).
10. **Calibrated fusion weights from captured queries** (per-arm confidence weighting learned on `gbrain eval export` data), plus source boosts made opt-in (#13). *Proof:* `gbrain eval replay --against base.ndjson` on captured queries (matched before/after), and cat13b source-swamp with the boosts on vs off.

---

## Measurement hygiene fixes (in-repo evals) to land alongside

- `search/eval.ts`: use `embedQuery` plus the resolved column for the vector strategy (#9). Key hits by `source_id:slug`.
- `retrieval-quality/harness.ts`: count errors separately; never let `[]` count as hard-negative clean (#10).
- `eval-longmemeval`: log `distinct_sessions_in_top_k`, and either over-fetch or set `maxPerPage = 1` for session-recall scoring (#20).
- Make every reranker-on eval arm assert `rerank_score` presence (or a `rerank_failed` stage once #5 lands), so silent pass-throughs cannot be published as reranked numbers.

## Probe index

| Probe | Proves | Output |
|---|---|---|
| `probes/fusion-split.test.ts` | #1 chunk-grain vote split | `fusion.out` |
| `probes/rerank-order.test.ts` | #2 alias/exact tiers undo rerank | `rerank-order.out` |
| `probes/readpath-e2e.test.ts` | #3 detail=low hides answer; #5 silent rerank failure; #16 round-trip count | `e2e1.out`, `e2e.out` |
| `probes/trajectory-limit.test.ts` | #4 oldest-100 truncation | `traj.out` |
| `probes/exclude.test.ts` | #8 dropped excludes + PGLite parity | `exclude.out` |
| `probes/cached-calls.test.ts` | #16 extra calls in `hybridSearchCached` | `cached.out` |

To run a probe: copy it into `audit/scratch-readpath/gb/test/scratch/` and run `bun test test/scratch/<file>` from that directory.
