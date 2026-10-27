# gbrain-evals → unfixed product findings (latency, retrieval quality, cost)

Audit date 2026-10-15. gbrain master `3c16e9ba` (v0.60.250.0), gbrain-evals `d744fa38`. All gbrain citations are
`git show HEAD:<file>` line numbers; the parent's live checkout has uncommitted edits to `src/core/ops/search.ts`,
`src/core/search/mode.ts` and others, so working-tree line numbers can differ. Scratch work and receipts:
local audit notes (not committed) (master exported with `git archive`, never the live checkout). Spend: $0 (all keyless).

Excluded as already known/done: the 2026-10-11 LHF wave, #6641 embed overlap, rerank-3-lite default, #6714, and the
lead's open list (GBRA-94, JIT title arm, v240 ANALYZE, #4951, email-typed searches, Postgres 10k→20k, TODO-D).

## Ranked summary

| # | Item | Kind | Effort | Expected impact | Confidence | New? |
|---|---|---|---|---|---|---|
| 1 | Saved-facts match is a `LIKE ANY '%term%'` scan of every active fact on every `search`/`query` | latency | S | −25 ms @10k facts, −120 ms @50k, −200 ms @100k per call (PGLite microbench) | high on mechanism, medium on real brains | NEW (explains D4) |
| 2 | `cosineReScore` ships ~100 full embeddings per search back to JS to compute cosine | latency | S | PGLite: fuse stage −84%, op median 86→62 ms, ranking order identical 40/40 | high on PGLite, unverified on Postgres | NEW |
| 3 | `context_pack` returns the same content twice (`cards[]`/`facts[]` and rendered `text`) | cost | S | ~40–50% fewer chars per `context_pack` result; budget_tokens 1500 → ~12k chars today | medium | known follow-up, not filed/fixed |
| 4 | Response-meta stage runs ~7 independent DB probes serially | latency | S | Postgres only; est. 5–20 ms/call (unmeasured) | low–medium | NEW |
| 5 | GBRA-94: `tokenmax` still expands on master HEAD | latency/cost | S | ~1.8 s p50 per `query` | high (preregistered) | known; confirm HEAD state |
| 6 | Lean rows repeat per-row constants (`trust_tier`, `origin`, `source_id`, `id`) | cost | S–M | ~8.6% of Cat 40 result chars | medium | known follow-up, not filed |
| 7 | Attendance relation lexicon is only "attended"/"attendees" | quality | S | paraphrase firing 0/150 → most; recall@5 up to +48 pts on those questions | medium | known, not fixed |
| 8 | Multi-relation planner refuses any query containing a year token | quality | S | unlocks chains anchored on titles like "Board Meeting Q1 2025" | medium | known, not fixed |
| 9 | Chat-key-only installs run `tokenmax` with the reranker silently skipped; fused hybrid then loses to bare vectors on concept questions | quality | M | Cat 13: 99 vs 118 of 181 first-place | medium (old pin) | NEW framing |
| 10 | Windowed `get_page` is full-surface only; no in-page term search | cost/quality | S–M | long-doc reads 30–40k chars → a few k on starter | low | partly NEW |
| 11 | Family E: long meeting transcripts ranked below short mail | quality | M | renewal briefs 4–5/30 hybrid vs 14/30 keyword-only | low (stale measurement) | known P3, unfixed |
| 12 | Mention links only on the next stale sweep, not on write | quality | M | freshness of entity cards | low | known P3, unfixed |
| 13 | H1 aggregation at floor on sealed/S worlds | quality | L | 4–11 of 60–120 cells, oracle ~100% | low | known, unfixed |
| 14 | Proactive brief: task-start intent lexicon gap; cold hook vs 300 ms cutoff | quality | S | brief off by default | low | known (2026-10-15) |
| 15 | HNSW topic-coherent 10% source scope recall@50 0.777 | quality | M–L | scoped vector recall at 1M chunks | medium | known, unfixed |

Items 1, 2 and 4 are one PR touching `src/core/ops/search.ts` and `src/core/search/hybrid.ts`; with 3 and 6 they form a
cheap "search hot path + payload" wave that needs no paid eval to gate. Do-not-do list at the end.

Corrections to the brief's premises:
- **"Cost per success ~2.4x plain files" is stale for Claude models.** That was Cat 40 v1 before the cost wave
  (gbrain-evals `TODOS.md` "Cost parity target (A6)"). On Cat 40 Hard, gbrain is cheaper per success for Sonnet 5.5
  (0.85 vs 1.71 $ on M) and Opus 5.5 (1.10 vs 2.40), but dearer for GPT-6.1 Sol (0.32 vs 0.24 on M, 0.46 vs 0.32 on S)
  (`docs/benchmarks/2026-10-10-model-ladder-hard-confirmation.md:55-60`). Next-wave confirmation: $0.53–0.98 per
  success vs fs $1.35–1.77 (`docs/benchmarks/2026-10-15-cat40-next-confirm/README.md:130-131`). The cost lever left
  is Sol and tool-result size (items 3, 6, 10).
- **GBRA-94 is not on master yet** (`mode.ts:605` `expansion: true` in `tokenmax` at HEAD), but the live checkout
  has an uncommitted edit setting it to `false` with the GBRA-94 comment, so someone is already on it.

---

## 1. Saved-facts match scans every active fact on every search (NEW; root cause of D4)

1. **Problem.** `search` and `query` append "saved facts" (#5932). The match is `lower(fact || entity_slug) LIKE
   ANY('%t1%',…,'%t12%')` over all active facts in scope, ordered and limited to 200, on every call that has
   `emitResponseMeta` (every MCP call). No index serves `LIKE '%…%'`, so cost is linear in the active fact count.
2. **Evidence.**
   - Code: `src/core/ops/search.ts:383-430` (`matchingSavedFacts`; the scan at `:413`); called from
     `buildRetrievalResponseMeta` (`:449`, saved facts at `:477`) for both `search` and `query`. The "any fact?"
     probe at `:395-404` only skips brains with zero active facts.
   - Keyless PGLite microbench of that exact predicate (local audit notes (not committed), synthetic 16-word
     facts, 6 terms, median of 7): **10k facts 27.5 ms, 50k 121.9 ms, 100k 202.8 ms**; an OR `to_tsquery` on a GIN
     FTS index over the same rows: 4.5 / 3.6 / 2.6 ms.
   - gbrain-evals `docs/benchmarks/2026-10-03-wave8-f1-repin.md:142` and `TODOS.md` ("Watch MCP search time after
     #5932"): D4 MCP search ~140 → ~200 ms per call at 2,000 notes after #5932, which gbrain's notes attribute to
     "the saved-fact and other-name lookups". This is that lookup.
3. **Still on master?** Yes: the scan is unchanged at HEAD `search.ts:413`. gbrain TODOS has no entry for it.
4. **Fix.** gbrain already builds a GIN FTS index on active facts: `src/core/fts-language.ts:126`
   (`CREATE INDEX … ON facts USING gin (factsFtsDocument(...)) WHERE expired_at IS NULL`). Prefilter with
   `factsFtsDocument('f') @@ to_tsquery(<lang>, 't1:* | t2:* | …')` (prefix match keeps "renew" → "renewal"), keep
   the existing JS hit counting (`need = max(min(2,n), ceil(0.75n))`) and top-5 cut unchanged. Optionally keep the
   `LIKE` as a fallback only when the FTS index is missing (pre-migration brains).
5. **Effort.** S (one query, one helper reused from the facts FTS arm).
6. **Impact.** Removes 25–200 ms per MCP search/query on brains with 10k–100k active facts (PGLite synthetic; real
   fact length and Postgres planner will move the numbers). Confidence: high that it is linear and avoidable, medium
   on real-brain magnitude.
7. **Gate.** Keyless: existing saved-facts tests (`#5932` Cat 40 tests) must keep returning the same facts on their
   fixtures; add a parity test (LIKE vs FTS) on a fixture with substring-only matches to document the one semantic
   change; time it in `scripts/bench-refactor-wave-1.ts` with seeded facts (`response` stage). Optional $0 replay
   of D4 at 2k notes.
8. **Risk.** Substring → token-prefix semantics: a term inside a word ("ops" in "devops") stops matching, and CJK
   text needs the CJK path (the keyword arm already has `cjk-keyword-sql.ts`). Mitigate by falling back to LIKE for
   CJK terms.

## 2. `cosineReScore` pulls full vectors into JS (NEW, prototyped)

1. **Problem.** After RRF fusion, every candidate (~98 per call on the bench) is re-scored `0.7·normRRF + 0.3·cosine`.
   The cosine is computed in JS after fetching each chunk's full embedding with `vector_send`, even for rows the
   vector arm already scored in SQL.
2. **Evidence.**
   - Code: `src/core/search/hybrid.ts:1568-1633` (fetch at `:1595` via `getEmbeddingsByChunkIds`,
     `src/core/engine-sql/chunks.ts:966-992`; blend at `:1624`); called inside the `fuse` stage at
     `src/core/search/hybrid/rank.ts:156`.
   - gbrain-evals LHF item-5 receipt (`docs/benchmarks/2026-10-12-lhf-wave/receipts/item5-timings/bench-v0.60.205.0-22d407d82.json`):
     `fuse` is the largest in-process stage, 17–18 ms of a 46 ms response (688 of 1,875 ms summed), on PGLite 400
     pages with stub providers.
   - My profile of master on the same bench (instrumented copy): `cosineReScore` is ~99% of `fuse`
     (2,702 ms of fuse time over 80 calls; RRF itself 48 ms, `stampUnverifiedExtractions` 64 ms).
   - Prototype (compute `1 - (embedding::vector <=> $q)` in SQL, return one float per row; diff in
     local audit notes (not committed)), same bench, 40 responses:

     | Run | op median ms | fuse ms (sum of 40) | ranking order vs master |
     |---|---|---|---|
     | master (3 runs) | 133 / 82 / 86 | 1,643 / 1,049 / 1,174 | — |
     | SQL cosine (3 runs) | 62 / 59 / 62 | 171 / 168 / 186 | **40 of 40 identical** (slug, chunk_index order) |

     The machine was shared and noisier than the receipt's (master median 82–133 vs 46 ms), so read the ratio, not
     the absolutes. Scores differ only in low float bits (float8 SQL vs float32 JS).
3. **Still on master?** Yes, unchanged; no TODO covers it.
4. **Fix.** In `cosineReScore`, compute cosine in SQL for the text-space rows (one statement:
   `SELECT cc.id, 1 - (cc.<col>::vector <=> $1::vector) FROM content_chunks cc JOIN pages p … WHERE cc.id = ANY($2)
   AND <currentTextProjectionFilter>`), keep the JS path for the image space; or skip re-fetching for rows whose
   vector-arm distance is already known. Keep the `#3695` cosine=0 rule for unhydrated rows.
5. **Effort.** S.
6. **Impact.** PGLite: about −20 to −25 ms per search/query and −84% of `fuse`. Postgres: unmeasured; the binary
   transfer is already optimized there, so expect less (detoast still happens server-side). Confidence high
   (PGLite), unverified (Postgres).
7. **Gate.** Keyless: `bench-refactor-wave-1.ts` on PGLite and Postgres with an order-only digest (the bench digest
   includes `score`, so it changes; compare `[source_id, slug, chunk_index]`), plus the retained 20k Postgres brain
   from `2026-10-13-vector-side-early` for latency. Score-parity unit test within 1e-6.
8. **Risk.** Low. halfvec columns are already cast `::vector` on the fetch path; exact ties could reorder in theory
   (0 of 40 here).

## 3. `context_pack` sends every card twice (known DX follow-up, not filed)

1. **Problem.** `context_pack` returns structured `cards[]`/`facts[]`/`open_threads` **and** `text`, a rendering of
   the same cards, threads and facts. MCP serializes the whole object into the model-visible block, and
   `budget_tokens` meters only `text`.
2. **Evidence.** `src/core/ops/facts.ts:847-880` (cards and `text` both returned; `budget_used = estimateTokens(text)`
   at `:842`); `src/core/agent-output.ts:876` (`JSON.stringify(result)` is content[0]). gbrain-evals
   `docs/plans/2026-10-11-cat40-next-wave/PLAN.md:93`: "`budget_tokens: 1500` returned about 12,000 characters on M";
   `:357` lists "removing the `cards[]`/`text` duplication" as an out-of-scope follow-up, "none is written to TODOS".
   Every Cat 40 reader opens with `context_pack` (`2026-10-08-program-primary-hard-root-cause.md:19-24`).
3. **Still on master?** Yes. gbrain TODOS has no entry.
4. **Fix.** For remote callers, return one representation: keep `text` (what the budget meters) and drop the
   duplicated prose fields from `cards[]` (keep slug/title/type/ids/counts/`next` so agents can act), or add
   `format: 'text' | 'json'` defaulting to `text` remotely. Make `budget_used` measure the serialized result.
5. **Effort.** S (plus MEMORY_VERBS doc, output schema, conformance fixtures).
6. **Impact.** Roughly halves `context_pack` result chars (from ~12k to ~6k at budget 1500), carried on every later
   turn. Cost share is unmeasured: Cat 40 transcripts cap results at 40k chars; the next-wave attempts `chars` field
   has the true sizes. Confidence medium.
7. **Gate.** Keyless: count serialized chars on the Cat 40 world M slot replay of recorded `context_pack` calls
   ($0, same harness as the rerank-pool replay). Behavior: a small Cat 40 dev smoke (≈$40–80, 2 models × H2/H4)
   because agents read `cards[]`.
8. **Risk.** Contract change for v1 memory-verb consumers (thin clients, OpenClaw). Needs a `BEHAVIOR_CHANGES` row
   and a protocol version note.

## 4. Response-meta stage serializes independent probes (NEW, unmeasured)

1. **Problem.** `buildRetrievalResponseMeta` awaits in sequence: `resolveExcludePrivatePages`, the unsealed-pages
   probe, `probeProjectionReadiness`, `entitySavedFacts`, `matchingSavedFacts` (which re-resolves
   `resolveExcludePrivatePages`), `stampHeldHits`, `searchAnswerFeedback`. They don't depend on one another.
2. **Evidence.** `src/core/ops/search.ts:449-511` (and `:390` for the duplicate private-pages resolve). On the PGLite
   bench the whole `response` stage is 74–186 ms per 40 responses (2–5 ms each), so PGLite gains nothing (one
   connection); on Postgres each await is a pooled round trip.
3. **Still on master?** Yes.
4. **Fix.** `Promise.all` the independent probes; pass the already-resolved `excludePrivate` into
   `matchingSavedFacts`.
5. **Effort.** S. 6. **Impact.** Postgres only, estimated 5–20 ms per call; unverified. 7. **Gate.** Same bench on
   `--backend postgres` and `pgbouncer`; results digest must not change. 8. **Risk.** Low; watch pool pressure under
   pgbouncer.

## 5. GBRA-94: `tokenmax` still expands on HEAD (known; state check)

`src/core/search/mode.ts:605` at HEAD is `expansion: true`. Preregistered evidence: `query` p50 2,022 → 227 ms with
strict recall@10 298 vs 299 of 300 (comment in the uncommitted working-tree edit; source
`docs/benchmarks/2026-10-14-expansion-latency-preregistration.md`). The live checkout is mid-change (mode.ts,
search.ts, mode-advice, init picker, docs). Nothing to add beyond: when it lands, `query`'s expansion LLM call
(~1.0–1.1 s median on a PGLite docs brain, `2026-10-13-vector-side-early.md:22`) disappears, after which **rerank
(200–260 ms) is the largest `search` stage** on a 20k Postgres brain (same report, line 22).

## 6. Lean rows repeat per-row constants (known DX follow-up, not filed)

1. **Problem.** Every lean `search`/`query` row carries `trust_tier`, `origin`, `source_id`, `effective_date_source`
   and a base64 `id` (= source_id + slug), which are usually identical across a response.
2. **Evidence.** `src/core/search/lean-rows.ts:37-45` (kept fields). gbrain-evals next-wave PLAN `:357`:
   "Hoisting per-row constants (`trust_tier`, `origin`, `source_id`, 8.6% of M result characters) into a response
   header" — out of scope, not filed. Agent H4 median on M: 18 calls, 8 turns, 263,173 result chars (`:339`).
3. **Still on master?** Yes.
4. **Fix.** In `projectRows`, when every row shares a value, emit it once in `_meta`/a leading header object and omit
   it per row; keep per-row values only when they differ (safety: `#5575` wants every row's trust visible, so keep
   any non-default tier on its row).
5. **Effort.** S–M. 6. **Impact.** ~8.6% of search result chars (Cat 40 M), which compounds over later turns.
   7. **Gate.** Keyless char count on recorded Cat 40 calls; agent smoke for safety reading of `trust_tier`.
   8. **Risk.** Contract change for row consumers (thin client reads rows); agents may miss hoisted trust labels,
   so keep non-default tiers inline.

## 7. Attendance paraphrases never reach the graph (known, unfixed)

1. **Problem.** Relation parser recognizes attendance only as "attended"/"attendees".
2. **Evidence.** `docs/benchmarks/2026-10-06-attendance-world.md:9-13,34-36`: on `world-v1-attendees` the template
   "Who attended X?" fired 150/150 (recall@5 32.3% → 80.3%); "Who was in the room for…", "Who took part in…",
   "Which people were present at…" parsed 0/150. Report line 88: "worth a gbrain issue (not filed)".
3. **Still on master?** Yes: `src/core/search/relational-intent.ts:170-173` (`inVerbs: 'attended'`,
   `agentNouns: 'attendees'`). No TODO.
4. **Fix.** Extend `inVerbs`/`agentNouns` for `attended` (took part in, participated in, were present at, was in
   the room for, sat in on, joined; participants, attendee list), staying precision-first (no bare "was in").
5. **Effort.** S. 6. **Impact.** On those paraphrases, up to the template's +48 pts recall@5; general frequency in
   real queries unknown. Confidence medium. 7. **Gate.** Keyless: `bun eval/runner/attendance-world-score.ts` and the
   N9 hermetic arm on `world-v1-attendees` (paraphrase split must fire ≥80%, 0 false attendance; template unchanged);
   relational paraphrase split for false fires; paid N9 arm was $0.13. 8. **Risk.** False relational fires on
   non-meeting anchors; guard with the existing stopword seeds and anchor-type check.

## 8. Planner refuses any query with a year token (known, unfixed)

1. **Problem.** The multi-relation planner rejects a whole query when any token is a 4-digit year, even inside the
   anchor's title ("Acme Board Meeting Q1 2025").
2. **Evidence.** `src/core/search/relational-plan.ts:213-217` (`/^(1[89]|20)\d\d$/ → 'time' constraints are not
   planned`). Reported in `2026-10-06-attendance-world.md:88`.
3. **Still on master?** Yes. 4. **Fix.** Skip year tokens that fall inside a resolved anchor span (title/alias
   match) before the refusal loop; keep refusing free-standing time constraints. 5. **Effort.** S.
6. **Impact.** Unlocks 2-hop questions anchored on dated meeting/event titles; magnitude unmeasured (world-v1 has
   such titles). Confidence medium. 7. **Gate.** Keyless N9 hermetic + P7 planner held-out cases with year-titled
   anchors; `relational-plan` unit tests. 8. **Risk.** Low.

## 9. Chat-key-only installs: reranker skipped, hybrid loses to bare vectors on concepts (NEW framing)

1. **Problem.** The init picker gives `tokenmax` to any install with a chat key (`src/commands/init-mode-picker.ts:75-80`), and
   `tokenmax` enables the reranker, but with no Voyage key the rerank call is skipped silently as `no_key`
   (`src/core/search/rerank.ts:158-161`, default model `voyage:rerank-3-lite`, `src/core/ai/defaults.ts:19`). Those
   users get the un-reranked fused ranking, which measured below plain vector search on concept questions.
2. **Evidence.** `docs/benchmarks/2026-10-02-concept-vector-rerank.md:21-28,51-56`: held-out exact target first,
   gbrain without reranker **99/181** vs bare vectors **118/181** (vectors+rerank 128, gbrain+rerank 130), gbrain
   `d44296c`, balanced, expansion off. Reranking is "the setting that matters".
3. **Still on master?** The no-key skip and picker are unchanged at HEAD. The 99/181 number is from v0.60.30.0 and
   has not been re-measured; fusion changed since (metadata gate, intent weights), so the current gap is
   **unverified**. Conservative (no keys) has no vectors at all, so it is not comparable.
4. **Fix options.** (a) When the reranker is unavailable and the query is concept-shaped (`looksConceptShaped` is
   already used for the hint, `search.ts`), raise the cosine weight in the blend (`hybrid.ts:1624` 0.7/0.3) or the
   vector arm's RRF weight; (b) surface `rerank: skipped (no_key)` once to the operator with the Voyage setup
   command (doctor + init), since the mode name implies reranking.
5. **Effort.** M (a), S (b). 6. **Impact.** Up to the 19-question gap on Cat 13 held-out for those installs; share of
   installs without a Voyage key unknown. Confidence low–medium. 7. **Gate.** Cat 13 hermetic dev split first, then
   the 181 held-out with real embeddings (`voyage-4` embeddings only, ≈$0.10–0.30; reranker off), plus LongMemEval
   no-rerank arm for no regression (~$1–3 for embeddings, cached). 8. **Risk.** Hurts keyword-shaped queries if the
   concept detector misfires; must be measured on both splits.

## 10. Long documents: windowed `get_page` hidden on starter; no in-page search

1. **Problem.** Cat 40 H4 losses come from long executed contracts (26–40k chars) whose deciding sentence never
   reached the model; when agents did open them, `get_page` returned the sentence 52/52 times but costs the whole
   document.
2. **Evidence.** `docs/plans/2026-10-11-cat40-next-wave/RCA.md:7,38-54` (12 of 13 failed items never had the
   deciding sentence in any tool result; 9 of 13 were 30,185–38,962-char documents). Windowed reads now exist
   (`src/core/ops/get-page-body.ts:1-28`), but every selector (`body`, `lines`, `around_chunk_id`, …) is
   `fullSurfaceOnly: true` (`:60-69`), so starter-surface agents (the Cat 40 arm) can't use them. No term/`match`
   selector exists. PLAN `:357` lists "a `get_page` range or in-page search parameter" as an unfiled follow-up.
3. **Still on master?** Range: shipped, full surface only. In-page search: absent.
4. **Fix.** Advertise `around_chunk_id` (+`context_lines`) on starter (pays ~100 schema chars; starter budget is
   tight, `test/mcp-schema-budget.test.ts`); add a `match: "<terms>"` window selector returning the best-matching
   lines with line numbers.
5. **Effort.** S (expose), M (match selector). 6. **Impact.** Cheaper long-doc verification; H4 quality effect is a
   hypothesis (default surface is `full`, `src/mcp/surface.ts:4`, so most users already have range). Confidence low.
   7. **Gate.** Cat 40 dev smoke on H4 `+long` (≈$40–80). 8. **Risk.** Starter tool-list budget.

## 11. Family E: long transcripts below short mail (known P3, unfixed, stale numbers)

Evidence: gbrain-evals `TODOS.md` "Family E ranking" (CEO-E4): renewal briefs 4–5/30 with hybrid vs 14/30
keyword-only on the development world. No gbrain change targets it (no TODO, no CHANGELOG entry found); not
re-measured since 2026-10-04. Fix hypothesis: page-level diversity plus chunk-count normalization so one strong
chunk in a long transcript isn't outscored by short mails; or W5 whole-page cut for transcripts. Effort M; gate:
Cat 40 Family E dev cells (~$30) after a keyless replay of recorded searches. Confidence low; re-measure first.

## 12. Mention links lag writes (known P3, unfixed)

`CHANGELOG.md:5181`: the mention pass runs in `extract --stale`, autopilot's stale drain and the managed stale path;
"sync's inline extraction stays link-only". Remote `put_page` only queues wikilink/markdown `links`
(`CHANGELOG.md:5021`). Code: `src/core/persistence/links-maintenance.ts:140-142` is the only runtime caller. Entity
cards' `mentioned_in` miss pages saved since the last sweep. Fix: scan the written page against the cached gazetteer
in the post-commit `links` effect. Effort M; gate: keyless Cat 40 entity-recall test with a write-then-read probe.

## 13. H1 aggregation stays at the floor (known, unfixed)

Hard S world H1: gbrain 4/60, fs 0/60, oracle 60/60 (`2026-10-10-model-ladder-hard-confirmation.md:44`); sealed
next-wave H1 11/120 for every gbrain arm (`2026-10-15-cat40-next-confirm/README.md:89,197`); RCA class (c) set/count
errors gbrain 10 vs fs 3 on M (`RCA.md:23`). `match: "keyword"` page enumeration exists; no aggregate/list-by-filter
lane. gbrain-evals TODO proposes an extraction+SQL comparator to decide whether this needs a product feature. L.

## 14. Proactive brief gaps (known 2026-10-15, brief off by default)

`2026-10-15-cat41-brief.md:142-154`: task-start requests without a lexicon word ("my follow-up for X" minus
"follow-up") fired 0/8; cold first `turn_context` 169–339 ms against `TURN_BRIEF_CUTOFF_MS` 300 dropped the brief in
3/9 smoke cells. The "page edits never become brief items" finding is fixed (edit items, v0.60.24x CHANGELOG).
S each; gate keyless Cat 41 smoke ($0).

## 15. Scoped HNSW at scale (known, unfixed)

`2026-10-09-hnsw-scale.md:23`: after #6380, topic-coherent 10% source scope on 1M voyage-4 chunks still has
recall@50 0.777 (recall@10 0.837). Needs per-source partial indexes or exact scan below a selectivity threshold. M–L;
gate keyless (real vectors already built in that report's harness).

---

## Observations (not fix items)

- **Next-wave `names` p50 rose ~50 ms** (217–226 → 248–277 ms) with `referenced_by_count` on rows
  (`cat40-next-confirm/README.md:130`). Within budget; worth a profile if names batches grow.
- **gbrain Cat 40 cells take longer than fs**: Hard agent p50 63.7 vs 56.5 s (Sonnet, M), 70.2 vs 52.9 s (Sonnet, S);
  next-wave median 146–180 s per cell vs fs 68–72 s, but that run had two worlds per VM and includes slot restore
  (~5 s), so it is not a clean latency number (unverified).
- **CRAG grade is uninformative on LongMemEval**: all 470 rows graded `strong` in every LHF arm
  (`2026-10-12-lhf-wave.md:51`); escalation is off by default, so no cost today, but the grade can't drive skips.
- **Cat 40 Hard hybrid gold hit@5 is only ~37–38%** per call (rerank-pool replay, `2026-10-12-lhf-wave.md:60-63`);
  agents recover with more calls. A useful standing keyless-ish retrieval metric for future ranking work ($0.37).
- **gbrain `TODOS.md:78` "Run the keyword and vector arms concurrently on Postgres (#5989)"** looks superseded by
  #6641 (embed and vector side now start with the keyword arms). Verify and close.
- **Cat 41 setup**: wired recall 60.2 s vs 60 s target, `setup` only 2.8% faster than by hand
  (`2026-10-14-cat41-setup-run5.md:25-27`); not a search item.

## Do not do (evidence says no)

- **Rerank pool 25 instead of 50**: inconclusive (−0.93 pts gold hit@5, lower bound −1.55) on Cat 40 Hard and −3
  strict@10 on LME; with rerank-3-lite the saving is ~$0.0003/query (`2026-10-12-lhf-wave.md:15-22, 62-63`;
  `2026-10-12-rerank-settings-preregistration.md:146-195`).
- **Diverse pool (`search.diverse_pool_depth`)**: not distinguished on BEAM-1M answers (`2026-10-12-beam-1m-s1-fixes.md`).
- **F5 owner phrases default on**: failed precision volume (6 of 22 links) on independent prose
  (`cat40-next-confirm/README.md:139`).
- **W3 rerank skip gate**: no skippable queries (memory-proof wave 2 gate 4).

## Method and limits

Read: evals `README.md`, `TODOS.md`, the 2026-10-01→15 reports named above, `docs/plans/2026-10-11-cat40-next-wave/`
(PLAN NOT-in-scope sections, RCA), `docs/benchmarks/cat40-hard/RERANK_POOL_REPLAY.md`. Verified each item at gbrain
HEAD with `git show HEAD:` and the gbrain `TODOS.md`/`CHANGELOG.md`. Measured: items 1 and 2 only, keyless, on a
4-vCPU shared machine with PGLite and stub providers; nothing on Postgres. Not read in depth: memory-trust,
fence-repair, takes-bootstrap, managed-sync reports (not search-path). Receipts: local audit notes (not committed)
(`bench-pglite.json`, `base{1,2,3}.json`, `sql{1,2,3}.json`, `likebench.ts`, the prototype diff).
