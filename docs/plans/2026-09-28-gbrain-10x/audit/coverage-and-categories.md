# gbrain capability coverage and eval-category strategy (audit, 2026-09-28)

Scope: strategy input for new gbrain-evals categories. gbrain at `gbrain` (master `6bb88d128`, VERSION 0.59.3.0). gbrain-evals at `gbrain-evals` (`b439f12`, v0.10.0; pins gbrain `939232f` = 0.55.0.0 and gbrain-reader `a9de062`). Both repos were read only. No paid API calls were made. External numbers come from web sources accessed 2026-09-28; each one carries its source and a note on whether it can be compared with gbrain.

Severity key: **P0** means a wrong published number or a broken measurement. **P1** means a real bug or a misleading claim. **P2** means hygiene. "Suspected" means not verified end to end.

---

## 0. Executive summary

1. **gbrain ships far more capability than gbrain-evals measures.** I counted about 45 distinct capabilities (section 2). Only 9 have solid public coverage: hybrid retrieval on conversations (LongMemEval-S), reranker and autocut choices, returned-set precision (PrecisionMemBench), concept search (Cat13), source boost (Cat13b), typed-edge extraction (Cat2/6/10), the relational retrieval switch (relational-ab), transcript distillation (Cat35), and SkillOpt (Cat30–33). About 20 capabilities have **no** public coverage at all, including several that are gbrain's strongest differentiators: contradictions, knowledge update and supersession, as-of and temporal queries through the native chronicle ops, entity resolution through the real resolver, forgetting and withdrawal, private visibility for remote callers, open loops, expert routing, code intelligence ops, consolidation and drift, and multilingual full-text search.
2. **The strongest evidence gbrain has sits in categories the aggregate runner never runs.** `bun run eval:brainbench:published` (`all.ts`) dispatches only 16 categories. LongMemEval, PrecisionMemBench, Cat13/13b/14/15/18–33 and relational-ab are all outside it (finding F2).
3. **Several category headers state capability boundaries that are false for the pinned gbrain.** Cat 4 says gbrain has "no native as-of / cross-entity date query". Cat 6 says gbrain has no bare-prose mention linking. Cat 3 is titled "Identity Resolution" but measures keyword search. In each case the product capability exists and is simply not tested (F3–F5).
4. **The gbrain README still publishes the retired relational headline** (P@5 49.1%, "+31.4 points over its graph-disabled variant"). gbrain-evals re-measured it on 2026-09-09 at P@5 0.3421 with corrected metric helpers and states that the old gap is not a graph-only effect (F1, P0).
5. **External landscape.** The field has moved from LongMemEval-S and LoCoMo QA accuracy (saturated at 90–95%, vendor self-reports, a documented 6.4% answer-key error rate in LoCoMo) to four things: **scale** (LongMemEval-M, BEAM 1M/10M), **write-path fidelity** (HaluMem), **action and proactive memory** (DolphinBench, TriggerBench, PM-Bench, MemoryAgentBench conflict resolution and selective forgetting), and **accuracy reported together with cost and latency** (LongMemEval-V2 LAFS, DolphinBench, Mem0's tokens per query). gbrain has public numbers on none of these except its strict LongMemEval-S retrieval and a judged 86.6% QA score.
6. **Proposal.** Reorganize roughly 40 runners into 9 capability families with stable IDs, merge or retire 8 legacy categories, and add **13 new categories**. Seven of the 13 can run fully offline (no paid calls) on synthetic generators that mostly reuse existing corpora (world-v1, amara-life-v1, synthetic-v1). The highest-leverage additions are: **Knowledge-Update & Supersession**, **Contradiction Surfacing**, **Temporal & As-Of**, **Entity Resolution**, **Forgetting Residue**, **Visibility/Access Leak Fuzz**, a **HaluMem adapter**, a **LongMemEval-M + BEAM scale track with a cost/latency Pareto**, and a **neutral third-party submission to the Agent Memory Benchmark (AMB)**.

---

## 1. Audit findings (coverage-level)

### F1 — P0: the gbrain README and docs publish a relational headline that gbrain-evals has retired
- `gbrain/README.md:26`: "A 240-page Opus-generated rich-prose BrainBench run reported **P@5 49.1%, R@5 97.9%**, with **+31.4 points P@5** over its graph-disabled variant."
- `gbrain/docs/guides/capabilities.md:5`: "The README reports a +31.4-point P@5 lift over the graph-disabled variant…"
- `gbrain/docs/architecture/RETRIEVAL.md:26-31`: the table lists "gbrain graph-disabled … ~18 / ~85" and "gbrain default (full stack) 49.1 / 97.9".
- The current evidence says otherwise. `gbrain-evals/docs/benchmarks/2026-09-09-retrieval-refresh.md:146-171` re-ran all four adapters: specialized `gbrain` adapter **P@5 0.3421 / R@5 0.9791**, reference hybrid 0.1917 / 0.6874. The same page says: "It does not establish that 'graph alone added 31 points.' Older precision headlines also used metric helpers corrected in the repository audit; use the fixed-denominator P@5 values above." `gbrain-evals/TODOS.md` adds that the April per-query receipt is missing.
- **Why it's wrong:** 49.1% no longer reproduces under the corrected P@5 denominator, and "over its graph-disabled variant" asserts a controlled graph ablation that never existed. The RETRIEVAL.md row values (~18/~85) also disagree with the refreshed hybrid row (0.19/0.69).
- **Fix:** replace these with the controlled result from the same refresh ("enabling relationship retrieval raised first-place hits on investor questions from 9/39 to 21/39", `2026-09-09-retrieval-refresh.md:202`) plus the 0.3421 / 0.9791 whole-system row, labeled as template-specialized.

### F2 — P1: the "published" BrainBench sweep excludes every headline category
- `gbrain-evals/package.json`: `"eval:brainbench:published" => BRAINBENCH_N=10 … bun eval/runner/all.ts`.
- `gbrain-evals/eval/runner/all.ts:67-200`: `CATEGORIES` contains only 1–12, 34, 35 and 36. Of those, 5, 8 and 9 are "programmatic" and not executed, and 36 runs `--offline --smoke`, which its own name labels "offline keyword plumbing only; not capability evidence".
- Absent from the sweep: LongMemEval (`longmemeval.ts`), PrecisionMemBench, relational-ab, reading-notes, Cat13, 13b, 14, 15, 18, 18b, 19–33. That is every number the README headlines.
- **Why it matters:** a reader who runs the "published" command reproduces none of the published results. A regression in LongMemEval or Cat13 cannot fail the sweep.
- **Fix:** add a category registry file (ID, family, tier = `hermetic` / `keyed-cheap` / `paid-publication`, script, cost estimate, receipt path). Make `all.ts --tier hermetic` the CI gate and `--tier paid-publication` the true publication sweep. Section 4 gives the family mapping.

### F3 — P1: Cat 6 says bare-prose mention linking doesn't exist; the pinned gbrain ships it
- `eval/runner/cat6-prose-scale.ts` (header, ~lines 14-22): "NOT EXERCISED … bare-prose-name linking. gbrain v0.47.6.0 has no extraction pass that turns an unmarked name … into a link candidate." The `prose_only_mention` kind is excluded from every denominator.
- Pinned gbrain (`node_modules/gbrain`, 0.55.0.0) has `src/core/by-mention.ts` ("Auto-link entity mentions to known entity pages", v0.42.0.0, `buildGazetteer` + `findMentionedEntities`). It is wired in `src/commands/extract.ts:76` and `:2406` (`const gazetteer = await buildGazetteer(engine)`), and `src/core/extract-ner.ts` adds typed NER links (`link_kind='typed_ner'`, "CEO of Acme" → `works_at`).
- **Why it's wrong:** Cat 6 calls only the pure `extractPageLinks` (`cat6-prose-scale.ts:397`), which takes no gazetteer. The capability exists at a different entry point, so the header misstates the product and the gap goes untested.
- **Fix:** add a Cat 6 arm that seeds the entity pages, runs `runExtract(engine, ['links','--source','db'])` (the path that builds the gazetteer), and scores `prose_only_mention` plus typed-NER edges. Keep the pure-extractor arm as a separate row.

### F4 — P1: Cat 4 "Temporal Queries" measures only storage round-trips, and its boundary claim is stale
- `eval/runner/temporal.ts:8,11`: "As-of … (HARD — gbrain has no native op)" and "gbrain has no native cross-entity date query and no native as-of query. Every sub-test therefore measures the STORAGE ROUNDTRIP of `addTimelineEntry` → `getTimeline`."
- The pinned gbrain has cross-entity date ops: `chronicle_since`, `chronicle_on_this_day`, `chronicle_day` and `chronicle_last_seen` (`node_modules/gbrain/src/core/ops/chronicle.ts:62,80`). It also has search date bounds (`src/core/search/date-bounds.ts`, `afterDate`/`beforeDate` with relative `7d/2w/1y`), `effective_date` precedence (`src/core/effective-date.ts`), facts `valid_from`/`valid_until` with `find_trajectory`, and a think temporal window (`src/core/think/temporal-window.ts`).
- **Why it matters:** gbrain's temporal stack is untested. The only "temporal" category tests that the harness can sort dates.
- **Fix:** retire Cat 4 as a capability category (keep it as a storage-fidelity unit check) and replace it with new category **N3 Temporal & As-Of** (section 5).

### F5 — P1: Cat 3 "Identity Resolution" never calls the identity resolver
- `eval/runner/identity.ts` header: "This protocol measures searchKeyword (tsvector), not the product's explicit alias resolver."
- Product code that goes untested: `src/core/entities/resolve.ts` (`resolveEntitySlugWithSource`, fuzzy title and prefix expansion), `src/core/entities/resolve-on-save.ts` (write-time alias_exact cascade), `engine.resolveAliases` / `gbrain reindex --aliases`, `src/core/entity-identity.ts` + `ops/entity-identity.ts` (cross-source identity groups), and `src/core/search/exact-lookup.ts` (slug/title/alias floor). Cat 23 covers only the phantom-redirect decision core.
- **Fix:** rename Cat 3 to "alias keyword recall", then add **N4 Entity Resolution** (section 5).

### F6 — P1: planted contradiction gold exists, but no runner consumes it
- `eval/data/gold/contradictions.json`: 10 `pairs` + 5 `stale_facts`. `eval/data/gold/implicit-preferences.json`: 3 preferences. Both are produced by `eval/generators/amara-life-gen.ts:690-692`.
- `grep` over `eval/runner`: no consumer. The only references are the generator and `test/eval/schemas.test.ts:41-44`.
- gbrain ships a contradiction product: `gbrain eval suspected-contradictions` (`src/core/eval-contradictions/*`, with judge, date pre-filter, Wilson CI and auto-supersession proposals), the `find_contradictions` op, and the dream-cycle wiring. `docs/contradictions.md` describes it.
- **Fix:** new category **N2 Contradiction Surfacing** built on amara-life-v1, with this gold scaled up (section 5).

### F7 — P1: the pin gap means recent capabilities are untested, and one sweep spans two revisions
- `package.json:38-39` pins gbrain `939232f` (0.55.0.0, not an ancestor of master) while master is 0.59.3.0. Untested at the pin: attendance-versus-mention evidence (0.58.0.0), write-acceptance receipts (0.57.0.0), and meeting-label parsing (0.56.1.0). The reading-notes reader is tested only via the separate `gbrain-reader` pin.
- `all.ts` (Cat 35 comment): "Cat 34 resolves an external gbrain checkout while Cat 35 runs the SHA pinned in package.json — when they differ, one sweep report spans two gbrain revisions."
- **Fix:** give every category receipt a `gbrain_sha`. The aggregate must refuse to mix SHAs unless a flag allows it. Re-pin to a master ancestor before any publication.

### F8 — P1: the relational benchmark still depends on parser-designed templates
- `TODOS.md`: "Test relational wording the parser did not help design (issue #24 finding 6) … A fresh run of those same templates cannot close this gap." The refresh page also says the attendance questions "did not improve because the fixture's link direction did not match the parser's expectation".
- **Why it matters:** the only controlled graph result (9/39 → 21/39) is on template wording. The graph claim won't generalize until held-out paraphrases are scored.
- **Fix:** add a paraphrase split to **N9 Multi-hop & Relational QA** (section 5), generated from a seeded template grammar and frozen before scoring.

### F9 — P2: gbrain's in-repo evals aren't mirrored publicly
gbrain has hermetic, hand-labeled eval gates that the public suite neither runs nor reports:
- NamedThingBench (`src/commands/eval-retrieval-quality.ts`, `test/fixtures/retrieval-quality/`)
- whoknows (`src/commands/eval-whoknows.ts`, `test/fixtures/whoknows-eval.jsonl`, 21 rows)
- conversation parser (`src/commands/eval-conversation-parser.ts`, `test/fixtures/conversation-formats/*.jsonl` with 20+ formats)
- schema authoring, takes quality, trajectory, and the chronicle eval
- `evals/functional-area-resolver`, `evals/harness-instructions`, `evals/takes-bootstrap`

Cat 34 is the only precedent for driving a gbrain-internal suite through a subprocess contract. **Fix:** give each of these a Cat34-style subprocess wrapper under the matching family, or adopt its fixture as a seed for the new categories below.

### F10 — P2: numbering and naming don't scale
Examples: `cat13`/`cat13b`, `cat18`/`cat18b`, missing 16–17, eight `cat36-*` files plus 14 `situation-recall-*` files for one experimental category, and "Cat 5, 8, 9 programmatic". Readers can't tell capability from configuration guidance. **Fix:** use the family IDs in section 4, with the old numbers kept as aliases in receipts.

### F11 — P2: provider-matrix categories are stale by construction
Cat 18b's own header says: "zerank-2's hosted API sunsets 2026-09-04; live runs after that date will…". gbrain's current default reranker is Voyage `rerank-2.5` (capabilities.md) and its new-install embedder is `voyage-4@1024` (README Integrations). Cats 18, 18b and 21 are configuration guidance, not capability evidence, and they reference dead cells. **Fix:** move them to a "Provider matrix" family, regenerate the cells from `gbrain providers` at run time, and never feed them into capability headlines.

### F12 — P1 (suspected, verify with the receipts auditor): no category reports tokens and latency next to accuracy as a first-class Pareto
The LongMemEval report records an estimated returned-token count only in the autocut section (`2026-09-06-longmemeval-ranker-wave.md:91,101`: "five rows and an estimated 3,256 tokens"), using `ceil(len/4)`. The field now ranks on accuracy together with cost and latency (Mem0 publishes about 6.8K tokens per query, Zep 1.6K, LongMemEval-V2 uses LAFS, DolphinBench requires cost and latency). gbrain's likely advantage at around 3.3K estimated tokens for 5 chunks isn't presented as a claim. **Fix:** every retrieval and QA receipt should carry `returned_tokens` (real tokenizer), `p50/p95_latency_ms` and `usd_per_query`, and headline tables should show them.

---

## 2. Capability inventory and coverage map

Grades: **none** = no category exercises the production path. **weak** = a proxy path, a hermetic stub only, a tiny n, or no current publication. **solid** = the production path at a meaningful n, with a receipt and a published result.

"SOTA angle" says why the capability could be state of the art if measured. File paths are relative to `gbrain/src`.

### 2.1 Retrieval

| # | Capability | What it does | Files | SOTA angle | gbrain-evals coverage | Grade |
|---|---|---|---|---|---|---|
| 1 | Hybrid keyword + vector RRF | tsvector BM25 plus HNSW vector, fused by RRF (k=60), with a compiled-truth 2.0× boost and a cosine re-score blend | `core/search/hybrid.ts`, `keyword.ts`, `vector.ts`, `fusion-lists.ts` | Strict `recall_all@5` 95.53% on LongMemEval-S, the best strict any-LLM-free-retrieval number we know of | LongMemEval (`longmemeval.ts`), Cat13, Cat18, PMB | **solid** |
| 2 | Per-page vector pooling | best chunk per page, so a page surfaces on its strongest evidence | `core/search/vector-pool.ts` | Fixes the multi-chunk dilution failure most RAG stacks share | none directly (NamedThingBench is in-repo only) | **weak** |
| 3 | Cross-encoder rerank + relational re-pin | Voyage rerank-2.5; relational-arm rows bypass reranker demotion | `core/search/rerank.ts`, `relational-rerank-pin.ts`, `rerank-audit.ts` | Rerank +18/−8 on LongMemEval strict; the pin protects edge answers | LongMemEval ranker wave, refresh; Cat18b is stale | **solid** (LME) / weak (matrix) |
| 4 | Named-thing floor | exact slug/title/alias lookup tier, title-superstring boost, alias normalization | `core/search/exact-lookup.ts`, `title-match.ts`, `alias-normalize.ts` | Guarantees a query that names a page returns that page, which most vector-first memories fail | none in evals (in-repo NamedThingBench) | **none** |
| 5 | Evidence + `create_safety` contract | each result carries why it matched plus `exists/probable/unknown`, to prevent duplicate page writes | `core/search/evidence.ts` | A novel, agent-facing duplicate-prevention signal | none | **none** |
| 6 | Intent classifier + adaptive return policy | a regex intent (entity/temporal/event/general) sizes the return set; `minKeep` failsafe | `core/search/query-intent.ts`, `return-policy.ts`, `llm-intent.ts` | PMB tight adaptive precision 0.5859 vs hybrid 0.0565 | PMB | **solid** (precision) / none (intent accuracy) |
| 7 | Autocut + token budget | score-discontinuity sizing (now off by default); greedy token cap | `core/search/autocut.ts`, `token-budget.ts` | Measured negative result: autocut cost 70 strict hits | LongMemEval ranker wave | **solid** |
| 8 | Multi-query expansion + variant budget | LLM query rewrites with a fusion budget | `core/search/expansion.ts` | Measured negative result at k=5 | LongMemEval ranker wave | **solid** |
| 9 | Source-tier boost | curated prefixes outrank bulk dumps | `core/search/source-boost.ts`, `sql-ranking.ts` | Curated-over-chat priority, which chat-memory systems lack | Cat13b (single synthetic fixture) | **solid** (narrow) |
| 10 | Recency decay + salience | per-prefix recency map; emotional-weight salience axis | `core/search/recency-decay.ts`, `core/cycle/emotional-weight.ts`, `ops/salience.ts` | "What's been going on?" ranking | none | **none** |
| 11 | Contextual retrieval | embedding-input prefix wrap (Anthropic-style) per mode | `core/contextual-retrieval-*.ts`, `core/embedding-context.ts` | Buried-answer chunks become findable | Cat26 (no published live result) | **weak** |
| 12 | Graph signals | adjacency hub boost, cross-source corroboration, session demote | `core/search/graph-signals.ts` | Query-local graph priors | Cat27 (hash-embed only, unpublished) | **weak** |
| 13 | Relational recall arm | parses relational queries, resolves seeds, fans out typed edges as a 4th RRF arm | `core/search/relational-recall.ts`, `relational-intent.ts` | 9/39 → 21/39 top-1 on investor questions | relational-ab; attendance broken; template wording only | **weak→solid** |
| 14 | Arm-confidence fusion + metadata boost gate | down-weights lexical arms on paraphrase; vector-only voters keep vector order | `core/search/arm-confidence.ts`, `metadata-boost-gate.ts` | Concept search 130/181 vs vector 118/181 | Cat13 refresh | **solid** |
| 15 | CRAG confidence gate / abstention | zero-LLM grade of retrieval strength; escalates or abstains on weak evidence | `core/search/crag.ts` | Calibrated "I don't know" without an LLM call | none (LME abstention appears only in QA) | **none** |
| 16 | Search diagnostics | `--explain`, `search diagnose --target` | `core/search/explain-formatter.ts`, `commands/search-diagnose.ts` | Inspectability | none (not scoreable as capability; could be a conformance check) | none |
| 17 | Multilingual FTS / CJK | configurable tsvector language, CJK keyword SQL, latin folding | `core/fts-language.ts`, `core/search/cjk-keyword-sql.ts`, `core/latin-fold.ts`, `core/cjk.ts` | Non-English personal memory | none | **none** |

### 2.2 Brains, sources, access and trust

| # | Capability | Files | SOTA angle | Coverage | Grade |
|---|---|---|---|---|---|
| 18 | Brains × sources routing, federation, mounts | `core/brain-registry.ts`, `brain-resolver.ts`, `source-resolver.ts`, `mounts-cache.ts`; docs/architecture/brains-and-sources.md | Team plus personal brains in one query surface | Cat22 (keyword path only, noEmbed), PMB scope | **weak** (vector/think/context_pack paths untested) |
| 19 | Source isolation for scoped callers | `core/ops/context.ts` (scope ladder), engines' SQL filters | Zero-leak multi-tenant memory | Cat22 | **solid** (keyword/list/get/traverse) |
| 20 | Private page visibility for remote callers | `core/search/private-visibility.ts`, `read-policy-sql.ts`, `output-redaction.ts`, `core/facts/visibility.ts` | Per-page privacy enforced across about 15 read ops | none (Cat36 only protocols `safety_violations`) | **none** |
| 21 | OAuth grants, profiles, surfaces, trust boundary (`remote` flag) | `core/grants/*`, `core/oauth-provider.ts`, `core/operations.ts` | Owner-approved OAuth 2.1 MCP memory with scope grants | Cat12 (list_pages clamp, search mode ignored remotely, depth cap) | **weak** |
| 22 | Cross-brain calibration leak rules | `core/calibration/cross-brain.ts` | Published-profile sharing semantics | none | **none** |

### 2.3 Write path, graph and entities

| # | Capability | Files | SOTA angle | Coverage | Grade |
|---|---|---|---|---|---|
| 23 | Zero-LLM typed link extraction | `core/link-extraction.ts` (markdown refs, bare slugs, frontmatter map, pack verbs) | Graph without per-write LLM cost | Cat2, Cat6, Cat10 | **solid** |
| 24 | Gazetteer mention linking + typed NER | `core/by-mention.ts`, `core/extract-ner.ts`, `commands/extract.ts` | Links unmarked names | none (F3) | **none** |
| 25 | Attendance evidence (attended vs mentioned) | 0.58.0.0; `core/attendance-repair.ts`, `core/extract-timeline-from-meetings.ts` | Separates who was there from who was named | none (and not in the pin) | **none** |
| 26 | Entity resolution (save-time + query-time) | `core/entities/resolve.ts`, `resolve-on-save.ts`, `core/entity-name-quality.ts` | Alias cascade, fuzzy title, prefix expansion with ambiguity refusal | Cat3 (keyword proxy), Cat23 (phantom decision core) | **weak** |
| 27 | Cross-source entity identity | `core/entity-identity.ts`, `ops/entity-identity.ts` | Same person across team brains | none | **none** |
| 28 | Provenance write-through + remote spoof override | `core/import-file.ts`, `ops/pages.ts` | Trustworthy provenance | Cat24, Cat5 (judge-based) | **solid** (Cat24) / weak (Cat5) |
| 29 | Facts (hot memory): kinds, per-kind decay half-lives, supersession by fence, `recall` verb | `core/facts/*` (`decay.ts`, `supersede-resolve.ts`, `extract.ts`, `backstop.ts`) | Typed, decaying, provenance-bearing personal facts | PMB supersession (via search), Cat35 facts lane | **weak** |
| 30 | Takes (multi-holder beliefs, kind, weight), `propose_takes`, takes search | `core/cycle/propose-takes.ts`, `ops/takes.ts`, `commands/takes.ts` | Who-believes-what epistemology; rare in the market | Cat15 (extraction prompt P/R) | **solid** extraction / none retrieval |
| 31 | Compiled truth + timeline pattern | docs/guides/compiled-truth.md; compiled-truth boost in `hybrid.ts` | Current state plus an append-only evidence trail | indirectly (boost) | **weak** |
| 32 | Ambient write-back gate + write receipts | `core/facts/writeback-gate.ts`, `writeback-*.ts`; 0.57 pending-write receipts | Zero-LLM salience filter; honest async write status | Cat34 write-back suite | **weak/solid** (gbrain-authored fixtures) |
| 33 | Schema packs / agent-authored schema | `core/schema-pack/*`, `commands/schema.ts` | The brain learns its own ontology | none (in-repo `eval schema-authoring`) | **none** |

### 2.4 Knowledge over time: contradictions, temporal, trajectories

| # | Capability | Files | SOTA angle | Coverage | Grade |
|---|---|---|---|---|---|
| 34 | Contradiction probe + `find_contradictions` + auto-supersession proposals | `core/eval-contradictions/*`, docs/contradictions.md | BEAM and MemoryAgentBench show every system fails contradiction resolution (MemoryAgentBench: at most 6% multi-hop). This is the clearest open frontier. | none (F6) | **none** |
| 35 | Knowledge update / supersession (facts, takes_supersede, fence strikes) | `core/facts/supersede-resolve.ts`, `ops/takes.ts` | LongMemEval KU and HaluMem updating are weak spots industry-wide | PMB supersession subset only | **weak** |
| 36 | Effective date, date bounds, temporal window | `core/effective-date.ts`, `core/search/date-bounds.ts`, `core/think/temporal-window.ts`, `core/backfill-effective-date.ts` | "When was this page about?" instead of mtime | Cat4 (storage round-trip) | **weak** |
| 37 | Life Chronicle (event pages, last-seen, on-this-day, since) | `core/chronicle/*`, `ops/chronicle.ts` | Native cross-entity temporal queries | none (F4) | **none** |
| 38 | Typed-claim trajectories, regressions, founder scorecard | `commands/eval-trajectory.ts`, `founder-scorecard.ts`, `engine.findTrajectory` | Metric history with regression flags | Cat25 (routing A/B with seeded facts; unpublished) | **weak** |
| 39 | Drift detection (takes whose evidence shifted) | `core/cycle/drift.ts` | Belief maintenance | none | **none** |

### 2.5 Answering and synthesis

| # | Capability | Files | SOTA angle | Coverage | Grade |
|---|---|---|---|---|---|
| 40 | Think (intent → gather 4 retrievers → cited synthesis → gap analysis) | `core/think/*` | Cited answer plus "what the brain doesn't know" | Cat29 (unpublished); 5-question historical snapshot | **weak** |
| 41 | LongMemEval reader (reading notes) | gbrain-reader pin, 0.59.0.0 | 86.6% judged QA; notes study 308 → 324/361 | LongMemEval QA, reading-notes | **solid** |
| 42 | Calibration profiles, Brier scorecard, take forecast, grade_takes | `core/calibration/*`, `core/cycle/grade-takes.ts`, `ops/calibration.ts` | Holder-level calibration is unique | Cat14 (calibration A/B in think) | **solid** (A/B) / none (grading, forecast) |
| 43 | Brainstorm / LSD | `core/brainstorm/*` | Grounded ideation | Cat20 | **weak** |
| 44 | Expert routing (`whoknows`, `find_experts`) | `commands/whoknows.ts`, `ops/insights.ts` | expertise × recency × salience | none (in-repo fixture of 21 rows) | **none** |

### 2.6 Dream cycle / consolidation

| # | Capability | Files | Coverage | Grade |
|---|---|---|---|---|
| 45 | Synthesize (triage → frontier synthesis of transcripts into pages) | `core/cycle/synthesize.ts`, `synthesize-verify.ts` | Cat35 dream lane | **solid** (retention 88.1%; human calibration pending) |
| 46 | Consolidate (facts → takes promotion, cosine clustering) | `core/cycle/phases/consolidate.ts` | none | **none** |
| 47 | Patterns (cross-session themes) | `core/cycle/patterns.ts` | none | **none** |
| 48 | Extract atoms / facts / takes phases | `core/cycle/extract-atoms.ts`, `extract-facts.ts`, `extract-takes.ts` | Cat35 facts lane (partial) | **weak** |
| 49 | Phantom redirect | `core/cycle/phantom-redirect.ts` | Cat23 (decision core only) | **weak** |
| 50 | Auto-think, anomaly detection, emotional weight | `core/cycle/auto-think.ts`, `anomaly.ts`, `emotional-weight.ts` | none | **none** |

### 2.7 Ingestion, connectors, loops

| # | Capability | Files | Coverage | Grade |
|---|---|---|---|---|
| 51 | Transcript ingest (ChatGPT export, Claude export, Claude Code JSONL, Codex, Grok, generic JSON) | `core/transcripts/*`, `commands/transcripts.ts` | Cat35 (Claude Code JSONL only; TODOS E3) | **weak** |
| 52 | Conversation parser (20+ meeting/chat formats, LLM fallback) | `core/conversation-parser/*` | none (in-repo fixture corpus) | **none** |
| 53 | Live connectors (ChatGPT, Claude OAuth/cookie, spool, sync) | `core/connectors/*` | none | **none** |
| 54 | Ingestion daemon + 24h content-hash dedup | `core/ingestion/daemon.ts`, `dedup.ts` | none | **none** |
| 55 | Open loops ("who is waiting on me"): deterministic thread state machine + LLM commitment extractor | `core/google/loop-detect.ts`, `loops-extract.ts`, `core/loops/loops-store.ts` | none (amara-life-v1 has inbox/slack/calendar and is unused for this) | **none** |
| 56 | Multimodal: image search, OCR text, multimodal embeddings, audio transcription | `core/search/by-image.ts`, `commands/reindex-multimodal.ts`, `core/transcription.ts` | Cat11 (markdown/html text word recall only) | **weak** (text) / **none** (image, audio) |

### 2.8 Agent integration, protocol, ops, skills, code

| # | Capability | Files | Coverage | Grade |
|---|---|---|---|---|
| 57 | Push context: retrieval reflex, volunteer, turn context, hooks | `core/context/*` | Cat34 (via gbrain BrainBench, 141 gbrain-authored fixtures); Cat36 (protocol, no result) | **solid** (hermetic) / weak (independence) |
| 58 | MEMORY_VERBS v1 protocol + conformance (`gbrain protocol conformance --target`) | docs/protocol/MEMORY_VERBS_v1.md | Cat12 partially; conformance runner unused | **weak** |
| 59 | MCP remote / thin client / `mcp expose` | docs/architecture/thin-client.md, `commands/mcp-expose.ts`, `thin-client-routing.ts` | none | **none** |
| 60 | Minions durable job queue, subagents | `core/minions/*` | April historical comparisons only | **weak/stale** |
| 61 | SkillOpt (reflect → patch → gate) | `core/skillopt/*` | Cat30–33 | **solid** |
| 62 | Skill routing / resolver / skill compliance | `skills/RESOLVER.md`, `evals/functional-area-resolver` | Cat8 (programmatic, not run in sweep) | **weak** |
| 63 | Doctor / remediation plan with target score and cost cap | `core/remediation/*`, `commands/doctor*` | Cat19 (30-page hermetic) | **weak** |
| 64 | Code intelligence (code_def/refs/callers/callees/blast/flow, two-pass structural walk, tree-sitter chunking) | `core/code-intel/*`, `core/chunkers/*`, `core/search/two-pass.ts`, `commands/code-*.ts` | Cat21 (embedder A/B, 12 probes, markdown-wrapped, not tree-sitter) | **none** (ops) / weak (retrieval) |
| 65 | Performance at scale (PGLite ≤ 50K, Postgres 155K pages in production) | engines | Cat7 (PGLite 1K/10K), Cat28 (single-thread micro) | **weak** |
| 66 | Forgetting / withdrawal (durable withdrawal records survive reimport; fence strikes; `valid_until`) | `core/facts/forget.ts`, `withdrawal.ts`, `withdrawal-overlay.ts` | none | **none** |
| 67 | Memorable procedural memory (optional) | docs/memorable-agents.md | none | **none** |

**Tally:** about 67 rows (some are sub-features). Solid: about 17 rows, concentrated in retrieval ranking. None: about 30. Weak: about 20.

---

## 3. External landscape (as of 2026-09-28)

### 3.1 Benchmarks and what they measure

| Benchmark | Measures | Scale | Metric | Status | gbrain-evals |
|---|---|---|---|---|---|
| **LongMemEval-S** (ICLR'25) | extraction, multi-session, temporal, KU, abstention | 500 Q, ~115K tokens/haystack | QA accuracy (gpt-4o judge); official `recall_all/any@k` | Saturated for QA (90–97% vendor claims) | **run** (strict retrieval + QA) |
| **LongMemEval-M** | same, 500 sessions | ~1.5M tokens/haystack | same | Few published numbers (one self-report: 96.8% R@5 any-hit, erinys-memory PyPI) | preregistered 28-case pilot only |
| **LongMemEval-V2** (ICML'26) | agent trajectories: static state, dynamic state, workflow, gotchas, premise awareness | 451 Q, up to 115M tokens | accuracy + **LAFS** (latency-accuracy frontier gain) | Leaderboard open, no entries yet; baselines: RAG slice+notes 51.0%, AgentRunbook-C 74.9% (Small) | none |
| **LoCoMo** | single-hop, multi-hop, temporal, open-domain, adversarial | 10 convs, 1,540 non-adversarial Q | QA accuracy (gpt-4o-mini judge) | **6.4% score-corrupting answer-key errors** (locomo-audit), judge accepts about 63% of topically adjacent wrong answers; ceiling about 93.6%; LoCoMo-Refined exists | none |
| **BEAM** (ICLR'26) | 10 abilities incl. **contradiction resolution**, event ordering, instruction vs preference, summarization | 100 convs, 2,000 Q, 100K / 500K / 1M / 10M tokens | rubric score 0–1 (averaged) | Active; the paper's best is about 0.36 at 1M | none |
| **MemoryAgentBench** (ICLR'26) | accurate retrieval, test-time learning, long-range understanding, **conflict resolution / selective forgetting** | incremental chunks | EM / judge | All systems at most 6–28% on multi-hop conflict | none |
| **HaluMem** | memory **extraction** (R/P/F1), **updating** (C/H/O), QA hallucination | ~15K memory points, Medium/Long | per-stage | Mem0 F1 57.3%, Supermemory 56.9%, MemOS 79.7% (self), Zep QA only | cited only (comparison-systems) |
| **PrecisionMemBench** | returned-set precision under alias, scope, fuzzy, supersession | 35 beliefs, 77 + 12 cases | precision/recall | Niche but a unique precision lens | **run** |
| **MemBench** (ACL'25 Findings) | factual vs reflective, participation vs observation | 10K / 100K | acc, recall@10, read/write time | Mostly research baselines | none |
| **PersonaMem / v2** | preference tracking and application | 32K–1M | MCQ accuracy | AMB hosts it | none |
| **LifeBench** | year-scale multi-source (chats, calendar, notes, SMS, health) | 10 users, 2,003 Q, 11.8M tokens | accuracy | Best about 55–71% | none (amara-life-v1 is a smaller analogue) |
| **DolphinBench** (Mem0, 2026-09-22) | **action-based** memory; solvability-certified (with/without history); cost + latency required | 3 personas × 200 tasks, ~500K tokens | task completion + cost + latency | New; best 70.67% | none |
| **TriggerBench / PM-Bench / ATRBench** | **prospective memory**: spontaneous recall without a prompt, false-alarm rate | varies | proactive recall, false alarms, F1 | New (2026) | Cat34 push suite and Cat36 are analogues |
| **MEMTRACK / STATE-Bench / MemoryArena** | state tracking across Slack/Linear/Git; stateful actions | — | task success | New | none |
| **Mem-Gallery / MemEye / MemLens / SMMBench** | multimodal long-term memory (visual evidence necessity) | up to 256K | accuracy | New (ACL'26 etc.) | none |
| **Deployment-Time Memorization (FRS)** | privacy-utility: Personalization Recall, Adversarial Extraction Rate, **Forgetting Residue Score** across derived tiers | LongMemEval-based | PR, AER, FRS | New (2026-07) | none |
| **ConflictBank / WikiContradict** | knowledge conflicts in retrieved context | 253 human-annotated (WikiContradict) | judged | Stable | none |
| **HotpotQA / 2Wiki / MuSiQue** | multi-hop QA | dev sets | EM/F1, supporting-fact recall | Cognee's head-to-head used only 24 HotpotQA Qs | none |
| **AMB — agentmemorybenchmark.ai** | neutral harness hosting BEAM, LifeBench, LoCoMo, LongMemEval, PersonaMem, SDEBench (coding) | — | same prompts / judge for all providers | Hindsight leads; a "hybrid-search" baseline scores 74.0% on LME-S | none (big opportunity) |

### 3.2 Competitor published numbers (all self-reported unless noted)

| System | LongMemEval-S | LoCoMo | BEAM | Other | Notes on protocol |
|---|---|---|---|---|---|
| Mem0 (Apr/Jul 2026 algorithm, managed platform) | 94.4% (472/500, top-200) / 94.8% (top-50) | 92.5% | 1M 64.1, 10M 48.6 | ~6.8–7.0K tokens/query, p50 ~1.1s | QA accuracy; top-200 memories to the reader; managed-only optimizations ([mem0ai/memory-benchmarks](https://github.com/mem0ai/memory-benchmarks), [blog](https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm)) |
| Zep / Graphiti | 71.2% (gpt-4o), 63.8% (gpt-4o-mini) in the paper; site claims 90.2% | site 94.7%; corrected paper-protocol 75.14% after a Cat-5 scoring bug | — | 1.6K context tokens, 2.58s | [arXiv 2501.13956](https://arxiv.org/abs/2501.13956); LoCoMo dispute unresolved |
| Hindsight (Vectorize) | 91.4% (Gemini-3, paper); 94.6% on AMB (verified local run) | 92.0% (AMB) | 100K 73.4–86.2%, 1M 73.9%, 10M 64.1% (AMB, "rag" vs "single-query" modes differ) | LifeBench 71.5%, PersonaMem 86.6% | [AMB](https://agentmemorybenchmark.ai/), [ACL demo](https://aclanthology.org/2026.acl-demo.27/) |
| Honcho | 90.4% (Haiku 4.5), 92.6% (Gemini 3 Pro) | 89.9% | 100K 0.630, 500K 0.649, 1M 0.631, 10M 0.406 (rubric scale) | median 5% of context | [blog](https://plasticlabs.ai/blog/research/Benchmarking-Honcho); BEAM 0–1 rubric ≠ Mem0 "%" per Honcho's own caveat |
| Supermemory | 81.6% (gpt-4o), 84.6% (gpt-5), 85.2% (Gemini-3); research page 97% "Recall@20 with aggregation"; ASMR experiment 98.6% pass@8 / 97.2% ensemble | claims #1 | — | HaluMem-M extraction F1 56.9% (third party) | pass@8 ≠ accuracy ([research page](https://supermemory.ai/research/longmembench/)) |
| Letta | — | 74.0% (filesystem agent, gpt-4o-mini) | — | Context-Bench (filesystem/skills) | [blog](https://www.letta.com/blog/benchmarking-ai-agent-memory/) |
| Cognee | — | 80.3% (AMB) | preliminary BEAM report | HotpotQA 24-Q head-to-head: 0.85 correctness vs Graphiti 0.74, LightRAG 0.67, Mem0 0.54 | Cognee ran tuned, competitors ran defaults ([page](https://www.cognee.ai/knowledge-graph-memory-benchmarks)) |
| LangMem | — | 58.1% | — | 17,990 p50 tokens | Mem0 paper protocol |
| OpenAI ChatGPT memory | — | 52.9% (J score, Mem0 paper protocol) | — | — | [arXiv 2504.19413](https://arxiv.org/abs/2504.19413); old, closed product |
| Mastra Observational Memory | 94.87% macro / 93.6% micro (gpt-5-mini) | — | — | — | full-context compression; no recall@k |
| Exabase M-1 | — | — | 100K 76.9, 1M 75.0, 10M 68.0 | — | self-reported |
| MemOS | — | — | — | HaluMem extraction F1 79.7% (same team as HaluMem) | — |
| **gbrain** | strict `recall_all@5` **95.53%** (449/470), any 99.79%; QA **86.6%** (433/500, Sonnet 4.6 reader, gpt-4o judge) | **not run** | **not run** | PMB tight+rerank P 0.5859 / R 0.8250; Cat35 retention 88.1% | gbrain-evals receipts |

### 3.3 Which comparisons are fair

- **Fair now:** strict `recall_all@5` on LongMemEval-S against systems that publish per-question rankings (MemPalace recomputed at 85.7–90.0%, ContextFit 84.3–87.45%, LME-paper Stella on M). Comparison-systems.md already does this correctly.
- **Fair with a matched reader and judge:** LongMemEval-S QA against Zep (71.2%) and Hindsight/Supermemory's gpt-4o rows. gbrain must run a **gpt-4o reader + gpt-4o judge + official prompts** arm. The current 86.6% uses a Sonnet 4.6 reader. Paid cost is small: 500 questions × about 8K tokens ≈ $10–15.
- **Fair only via a neutral harness:** Mem0 94.4%, Honcho 90.4% and Hindsight 94.6% use different readers, top-K budgets (Mem0 top-200 memories) and judges. The clean route is **submitting a gbrain provider to AMB**. Its harness fixes prompts, judge and modes (rag / agentic-rag / agent) and already lists a plain "hybrid-search" baseline at 74.0% on LME-S, so gbrain's delta over plain hybrid would be visible.
- **LoCoMo:** only fair on the audited answer key (locomo-audit or LoCoMo-Refined), with category 5 handled correctly and the judge disclosed. MemPalace's 100% is structurally guaranteed (top-50 > sessions), so gbrain should report at k ≤ 10 with the session count disclosed.
- **BEAM:** fair only on BEAM's rubric scale, 0–1. Never place a 0.63 rubric score next to a Mem0 "64.1%" without checking that Mem0 used the same rubric (Honcho's own post warns about this).
- **HaluMem:** fair because the harness is system-agnostic and needs a "get dialogue memory" API. gbrain can expose `facts` list per session. Zep couldn't be scored on extraction, and gbrain can, which is a real differentiator.
- **Not fair:** pass@k or ensemble numbers (Supermemory 98.6%), tuned-versus-default head-to-heads (Cognee), anything mixing retrieval recall with QA accuracy, and gbrain Cat35 (its own corpus) against HaluMem numbers.

---

## 4. Proposed taxonomy for gbrain-evals

Nine families with stable IDs. Old numbers stay as aliases in receipts. Every category declares a **tier**: `H` = hermetic (no keys, CI gate), `K` = keyed but under $1, `P` = paid publication run.

### Family R — Retrieval core
| New ID | Contents (old IDs) | Action |
|---|---|---|
| R1 Named-thing retrieval | port gbrain NamedThingBench (in-repo) + Cat3 alias keyword rows | **merge + port** (H) |
| R2 Conceptual / paraphrase recall | Cat13 (+ gap-localize, KACF calibrate) | keep |
| R3 Conversational evidence retrieval | LongMemEval-S retrieval, LongMemEval-M, LoCoMo retrieval | keep + extend (N10) |
| R4 Returned-set precision | PrecisionMemBench | keep; add session cases (12 unrun) |
| R5 Relational retrieval | relational-ab + multi-adapter relational family + Cat1 before-after | **merge**; retire Cat1 as a historical A/B of an April PR; add paraphrase split (N9) |
| R6 Ranking-signal ablations | Cat13b source boost, Cat26 contextual retrieval, Cat27 graph signals, recency/salience (new rows) | **merge into one harness** with a shared paired-delta scorer and live-embedding requirement for publication |
| R7 Provider matrix (guidance, not capability) | Cat18, Cat18b, Cat21 embedder part | **re-scope**; generate cells from live providers; drop zerank cells |

### Family W — Write path and graph
| W1 Link & edge extraction | Cat2 type accuracy, Cat6 prose scale, Cat10 adversarial | **merge**; add gazetteer/NER arm (F3) and attendance evidence |
| W2 Provenance | Cat24 capture provenance, Cat5 claim grounding | merge |
| W3 Transcript distillation | Cat35 | keep; add formats (N12) |
| W4 Claim extraction | Cat15 propose_takes + HaluMem adapter (N11) | extend |
| W5 Entity resolution | Cat23 phantom + new N4 | extend |

### Family T — Knowledge over time
N1 Knowledge-Update & Supersession, N2 Contradiction Surfacing, N3 Temporal & As-Of, plus Cat25 trajectory routing (keep, publish).

### Family A — Answering and synthesis
| A1 Answer QA on external sets | LongMemEval QA (+ gpt-4o-matched arm), reading-notes | keep + add matched arm |
| A2 Think vs search | Cat29 | keep; publish at n ≥ 60 with blind judge + human sample |
| A3 Calibration | Cat14 + grade_takes Brier + take-forecast | extend |
| A4 Abstention | new rows: CRAG gate on unanswerable probes (LME `_abs`, BEAM abstention, synthetic negatives) | new sub-category (H for retrieval-side grading) |
| A5 Ideation | Cat20 brainstorm | keep (low priority) |

### Family I — Agent integration and protocol
| I1 Memory conformance | Cat34 (gbrain BrainBench) | keep; add independent fixtures |
| I2 Prospective / situation recall | Cat36 + N8 | merge |
| I3 Protocol & MCP contract | Cat12 + `gbrain protocol conformance` against other MEMORY_VERBS servers | extend (cross-system, fair by construction) |
| I4 Agent workflows | Cat8, Cat9 | make them runnable in the sweep or retire |

### Family S — Trust, privacy, forgetting
S1 Source isolation (Cat22, extend to vector/think/context_pack/recall). New: N5 Forgetting Residue and N6 Visibility & Access Leak Fuzz. Cat10 injection rows move here.

### Family O — Operations
Cat7 perf (add Postgres 100K tier), Cat19 doctor/remediate, Cat28 sync micro, plus cost/latency receipts on every category (F12).

### Family K — Skills
Cat30–33 SkillOpt (keep), skill routing (port `evals/functional-area-resolver`), Cat8 compliance.

### Family M — Modalities and domains
Cat11 multimodal (text), N13 Code Intelligence, N12 Ingestion format fidelity, image retrieval (future, section 5 "deferred"), N7 multilingual (see below).

---

## 5. New categories (13)

Each entry gives what it proves, the dataset, the metric and denominator, baselines, cost, and effort (S ≤ 3 days, M ≤ 2 weeks, L > 2 weeks).

### N1 — Knowledge-Update & Supersession (Family T) — priority 1
- **Proves:** after a fact changes, gbrain returns the current value and keeps the stale value out of the result, across facts (`supersede-resolve`, fence strikes, `valid_until`), takes (`takes_supersede`), and compiled truth. This is the category every competitor names as hard (Mem0's July post: knowledge-update regressed 2.6 points; HaluMem: omission above 50% on updating).
- **Dataset:** a synthetic generator over amara-life-v1 and world-v1 entities. Each planted "fact chain" has 1–4 updates (job, city, preference, metric, decision reversal) at dated timestamps, with some updates stated implicitly ("since moving to <city>…"). External arms: the LongMemEval `knowledge-update` subset (78 in S) and the PMB supersession cases.
- **Metric:** `current_value_top1` (the current fact is ranked above every superseded one) and `stale_leak_rate` (superseded fact returned in top-k when the current one exists). Denominator: answerable chains, reported by update depth 1–4 and by explicit versus implicit update. QA arm: judged current-value accuracy.
- **Baselines:** plain hybrid with supersession off (ablation), vector-only, recency-sort-only, and an AMB "hybrid-search" style baseline.
- **Cost:** retrieval arm offline with hash embeddings for plumbing; live embeddings about $0.10. QA arm about $2.
- **Effort:** M.

### N2 — Contradiction Surfacing (Family T) — priority 1
- **Proves:** gbrain detects and surfaces conflicting claims (chunk vs chunk, chunk vs take, cross-source), classifies severity, and proposes the right resolution (`auto-supersession.ts`). BEAM and MemoryAgentBench show contradiction resolution is where all systems fail, so a strong result here is the clearest SOTA story.
- **Dataset:** scale `eval/data/gold/contradictions.json` (10 pairs + 5 stale facts, currently unused) to at least 150 planted conflicts on amara-life-v1. Types: numeric, date, attribute, holder-attributed disagreement (not a contradiction: two holders may disagree), temporal change (not a contradiction if dated), and true same-time conflicts. Add 100 hard negatives. External: 253 WikiContradict instances, ingested as pages, and the BEAM contradiction-resolution questions.
- **Metric:** pair recall and precision over planted pairs (denominator: planted pairs; FP denominator: flagged pairs), resolution-kind accuracy, and **false-contradiction rate on holder-disagreement and dated-change negatives** (the takes-vs-facts distinction is gbrain's unique angle). Answer arm: does think/QA mention both sides? Scored with a WikiContradict-style judge.
- **Baselines:** a naive all-pairs LLM judge over top-k (same model), and embedding-similarity + NLI (DeBERTa-MNLI, local and free).
- **Cost:** gbrain's probe uses an LLM judge with a cache, about $1–3 per full run at Haiku. The NLI baseline is free.
- **Effort:** M.

### N3 — Temporal & As-Of (Family T) — priority 1; replaces Cat4
- **Proves:** native cross-entity date queries (`chronicle_since/day/on_this_day/last_seen`), search date bounds, effective date versus mtime, as-of state reconstruction from `valid_from/valid_until` and timeline entries, and think's temporal window.
- **Dataset:** a seeded event-ledger generator (reuse Cat4's forward job-state machine as independent gold). The gold is derived from the event ledger, never from gbrain output. Include pages whose mtime ≠ event date (auto-link churn), relative expressions ("two Tuesdays ago"), and timezone edges. External arms: the LongMemEval `temporal-reasoning` subset (133 in S) through retrieval by type, and the LoCoMo temporal category on the audited key.
- **Metric:** exact-match set F1 for "what happened between A and B" (denominator: events in range), as-of accuracy (denominator: as-of probes), last-seen day error (MAE in days), and effective-date correctness. Retrieval arm: strict all-evidence@5.
- **Baselines:** mtime-sorted keyword search; vector with no date bounds.
- **Cost:** offline, $0.
- **Effort:** M.

### N4 — Entity Resolution & Identity (Family W) — priority 1; replaces Cat3's claim
- **Proves:** the real resolver cascade (alias_exact → fuzzy title → prefix expansion with ambiguity refusal), save-time resolution (`resolve-on-save`), the exact-lookup floor, and cross-source identity groups.
- **Dataset:** synthetic people and companies from world-v1 with variant generators: nicknames, initials, email handles, @handles, transliteration, typos (edit distance 1–2), married/changed names, and **colliding namesakes** (two people who share a first name plus an initial). Split into documented aliases (in frontmatter) and undocumented variants.
- **Metric:** pairwise precision and recall plus B³ F1 on resolved clusters; **wrong-merge rate** (the costly error, reported separately); refusal rate on truly ambiguous mentions (a correct refusal counts as a success). Denominator: mentions, stratified by variant type.
- **Baselines:** exact match; Levenshtein ≤ 2; embedding nearest neighbour; `searchKeyword` (the current Cat3 path) as the floor.
- **Cost:** offline, $0.
- **Effort:** S–M.

### N5 — Forgetting & Withdrawal Residue (Family S) — priority 1
- **Proves:** `forget` really withdraws a claim everywhere derived copies live: the facts table, fence rows, takes promoted by consolidate, synthesized pages, chunk embeddings, contradiction caches, think answers, and `context_pack`/`recall`. It must also resist reimport (the withdrawal record overlays stale fence rows). gbrain's docs promise withdrawal, not physical erasure; this category measures exactly that promise.
- **Dataset:** plant 100 canary facts, propagate them through the dream cycle (consolidate + synthesize in stub mode for hermetic runs), then forget 50. Run paraphrase, neighbour and story-completion probes, following the Forgetting Residue Score / AER protocol from "Deployment-Time Memorization in Foundation-Model Agents" (2026) and ForgetAgentBench attack types.
- **Metric:** **Forgetting Residue Score** per tier (fraction of forgotten canaries recoverable from that tier; target 0 for active-memory tiers), reactivation-after-reimport count (must be 0), and retained-utility recall on the 50 non-forgotten canaries (a naive "delete everything" must fail this).
- **Baselines:** raw-only delete (drop fact row only), and a no-op control that must show a high residue.
- **Cost:** offline with a stubbed dream; about $1 with a live dream at Haiku.
- **Effort:** M.

### N6 — Visibility & Access Leak Fuzz (Family S) — priority 1
- **Proves:** `visibility: private` pages and facts are unreachable for remote callers across **all** read ops (search, query, recall, entity, context_pack, think gather, get_page/fetch, get_chunks/versions/timeline/raw_data, resolve_slugs, traverse_graph, find_experts, chronicle, takes), while local callers still see them. It also proves grants and source scopes compose. This extends Cat22 from the keyword path to every surface.
- **Dataset:** generated brain with private, world and source-scoped pages; op × caller (local, remote read, remote write, subagent-fenced, bound client) × scope matrix; auto-enumerate ops from `operations` so new ops are covered by default.
- **Metric:** leak count (target 0) with **presence controls** (every probe also asserts the local caller does see the row, so an empty system can't pass), plus coverage (ops exercised / read ops declared).
- **Baselines:** none needed (a conformance category); a deliberately broken policy build as the negative control.
- **Cost:** offline, $0.
- **Effort:** M.

### N7 — Open Loops & Commitments (Family T/I) — priority 2
- **Proves:** "who is waiting on me": the deterministic thread-state detector (`loop-detect.ts`: unanswered inbound after 24h, outbound question after 72h, self-closing on reply) plus the LLM commitment extractor (direction, counterparty, due date, verbatim quote). No competitor publishes this capability.
- **Dataset:** amara-life-v1 inbox/slack/calendar (already generated, unused for this), extended with planted commitments, replies that close loops, noise senders, list mail and forwarded threads. Relabel gold from the generator's fixture tables (no LLM).
- **Metric:** loop detection precision and recall (denominator: planted loops), closure accuracy, due-date exact match, counterparty accuracy, and ranking nDCG of `gbrain waiting`.
- **Baselines:** LLM-only extraction with no state machine (same model); a "last message is theirs" heuristic.
- **Cost:** deterministic detector offline, $0; extractor arm about $1 at Haiku.
- **Effort:** M.

### N8 — Prospective & Proactive Recall (Family I) — priority 2; merges Cat36 + Cat34 push
- **Proves:** the brain volunteers the right memory **without being asked** (retrieval reflex, `volunteer_context`, turn_context), with a controlled false-alarm rate. This is the TriggerBench / PM-Bench / DolphinBench thesis: QA benchmarks leak the retrieval cue.
- **Dataset:** `associative-recall-v1` (480 probes, already frozen with direct controls and negatives) plus a TriggerBench-style set with matched retrospective controls, contrastive negatives and overloaded triggers. Optional external: the DolphinBench tasks (action-based; the harness is public).
- **Metric:** proactive recall (denominator: trigger turns), false-alarm rate (denominator: negative turns), injected tokens per turn, and PR-AUC over the confidence threshold.
- **Baselines:** always-inject top-k (high recall, high false alarm), never-inject, and plain `search` on the turn text.
- **Cost:** retrieval arms offline; the DolphinBench arm is paid (about $20–50 depending on agent).
- **Effort:** M (L with DolphinBench).

### N9 — Multi-hop & Relational QA with Held-Out Wording (Family R/A) — priority 2
- **Proves:** typed-graph retrieval helps compositional questions **beyond parser templates**, closing TODOS issue #24 finding 6. It also puts gbrain against the graph-memory field on a shared public set.
- **Dataset:** (a) world-v1 2–3-hop chains with a seeded paraphrase grammar, frozen before scoring; (b) the HotpotQA distractor dev set (sample 500), 2WikiMultiHopQA and MuSiQue (500 each), with passages imported as pages.
- **Metric:** supporting-fact **all-hit@k** (strict; denominator: questions with gold support), answer EM/F1 in the QA arm, and paired relational-on/off delta on template versus paraphrase splits.
- **Baselines:** relational arm off (same index), vector-only, BM25. Externally, Cognee/Graphiti/LightRAG/Mem0 on HotpotQA. Their published head-to-head is 24 questions, tuned versus default, so any comparison must note the n and the tuning mismatch.
- **Cost:** retrieval arm about $1 (embeddings); QA arm about $5.
- **Effort:** M.

### N10 — Long-Horizon Scale & Efficiency Frontier (Family R/O) — priority 1 for external credibility
- **Proves:** retrieval and QA hold at 1.5M–10M tokens (LongMemEval-M, BEAM 1M/10M) and gbrain sits on the accuracy × tokens × latency frontier. The market now ranks on this (Mem0 publishes about 7K tokens/query; Honcho claims a median 5% of context; LongMemEval-V2 uses LAFS).
- **Dataset:** LongMemEval-M cleaned (full 500, extending the frozen 28-case pilot); BEAM 1M and 10M (retrieval evidence labels where available, plus BEAM rubric QA).
- **Metric:** strict `recall_all@5` (M), BEAM rubric score (0–1, official judge), `returned_tokens` (real tokenizer), p50/p95 latency, ingest $/Mtoken, and a **LAFS-style frontier** over gbrain modes (conservative, balanced, tokenmax, ± rerank).
- **Baselines:** BEAM paper RAG and LIGHT, Mem0 BEAM (rubric-matched only), Honcho BEAM (rubric), Hindsight AMB rows, and a long-context-only reader.
- **Cost:** LongMemEval-M embeddings are the big item. 2.7GB of JSON, but sessions repeat across questions, so content-addressed caching helps; estimate $30–80 for voyage-4 embeddings of unique sessions (suspected, compute from unique-session token counts first). BEAM 10M ingest is similar. QA judge about $20.
- **Effort:** L.

### N11 — HaluMem Adapter: Extraction, Update and Memory Hallucination (Family W) — priority 2
- **Proves:** gbrain's facts pipeline (`extract_facts` / conversation-facts backfill / supersession) extracts complete, accurate memories and updates them, on a third-party benchmark where Mem0, Supermemory, MemOS and Memobase have published per-stage numbers and Zep cannot be scored on extraction.
- **Dataset:** HaluMem-Medium (and Long) from Hugging Face (`IAAR-Shanghai/HaluMem`).
- **Metric:** HaluMem's own: extraction R / weighted R / target P / accuracy / FMR / F1; update C / H / O; QA C / H / O. Keep the official denominators.
- **Baselines:** published HaluMem Table 3 rows (Mem0 F1 57.31%, Mem0-Graph 57.85%, Supermemory 56.90%, MemOS 79.70% self-evaluated).
- **Cost:** gbrain's extraction runs Haiku per turn over about 15K memory points across ~1.5K turns per user. Estimate $15–40 per Medium run (suspected; measure on one user first). The HaluMem judge adds cost.
- **Effort:** M.

### N12 — Ingestion Format Fidelity (Family W/M) — priority 3
- **Proves:** transcript and meeting ingestion preserves speakers, timestamps, turn boundaries and attendance across every supported format: ChatGPT export, Claude export, Claude Code JSONL, Codex rollouts, Grok, generic JSON, and 20+ meeting/chat formats in `conversation-parser`. It extends Cat35 (TODOS E3: "Cat35 corpus exercises Claude Code JSONL, leaving five other gbrain adapters outside").
- **Dataset:** render Cat35's canonical turns into every export format (deterministic), plus gbrain's `test/fixtures/conversation-formats/*.jsonl` (adversarial, iMessage, IRC, bold-name variants).
- **Metric:** speaker attribution accuracy, timestamp exact match, turn count error, attended-versus-mentioned F1 (0.58 feature), and unparsed-page honesty (a page that can't be read must be reported, never silently "extracted").
- **Baselines:** naive line-split parser.
- **Cost:** offline, $0 (the LLM-fallback arm is optional, about $0.50).
- **Effort:** S–M.

### N13 — Code Intelligence (Family M) — priority 3
- **Proves:** `code_def`, `code_refs`, `code_callers`, `code_callees`, `code_blast` and `code_flow`, plus two-pass structural retrieval, on tree-sitter-chunked code. Cat21 tests only embedder choice on 12 markdown-wrapped probes and never uses `importCodeFile` (its header admits this).
- **Dataset:** a pinned OSS TypeScript repo and a Python repo, with gold from SCIP or LSP indexes (scip-typescript, scip-python). That gives thousands of def/ref/caller edges for free, deterministically.
- **Metric:** def top-1 accuracy, refs/callers precision and recall per symbol (denominator: symbols sampled, stratified by fan-in), blast-radius recall at depth 1–3, and code-search nDCG@10 on CoIR/CodeSearchNet-style queries for the retrieval arm.
- **Baselines:** ripgrep, universal-ctags, and embedding-only search.
- **Cost:** ops arm offline, $0; embedding arm about $1.
- **Effort:** M.

### Deferred or optional (not counted in the 13)
- **Multilingual retrieval** (Family R): `GBRAIN_FTS_LANGUAGE`, CJK keyword SQL and latin folding on MIRACL or Mr.TyDi subsets. Keyword arm offline. Moderate SOTA value; effort M.
- **Consolidation & Drift quality** (Family T): planted fact clusters → consolidate dedup precision, holder attribution accuracy, no-loss rate; drift candidate precision. Offline with a stubbed LLM; effort M.
- **Expert routing / whoknows** (Family A): port the 21-row in-repo fixture and generate 200 more from world-v1 expertise facts; nDCG@5 vs keyword on person pages. Offline; effort S.
- **Multimodal memory** (Family M): image-as-query and OCR evidence on Mem-Gallery or MemLens subsets once text-in-multimodal-space (Phase 3) ships. Paid; effort L.
- **Action-based memory** (Family I): a DolphinBench adapter. Covered as an optional arm of N8.
- **AMB submission** (cross-family): implement AMB's provider interface (`ingest`, `retrieve`, optional `direct_answer`) for gbrain and run LongMemEval-S, LoCoMo10, PersonaMem, LifeBench and BEAM under AMB's fixed prompts. This is the single cheapest route to a **neutral** comparison against Hindsight, Cognee and the hybrid-search baseline. Effort S–M plus paid runs (about $20–60).

---

## 6. Cross-cutting standards every new or merged category should adopt

1. **Solvability check** (DolphinBench): an oracle-memory run must pass and a no-memory run must fail for each item. Report the ceiling. This catches LoCoMo-style answer-key errors (6.4%) before they cap scores.
2. **Negative controls with a presence assertion:** every leak or safety category asserts the positive path also returns data, so an empty system can't score 0 leaks.
3. **Cost, tokens and latency on every receipt** (F12): real-tokenizer `returned_tokens`, p50/p95 latency, `usd_per_query`, and ingest $/Mtoken. Headline as a Pareto, not a single accuracy number.
4. **Matched-reader arms for external QA:** always include a gpt-4o reader + gpt-4o judge arm with official prompts next to the house reader.
5. **Held-out wording:** any category whose parser or router was tuned on templates needs a frozen paraphrase split (F8).
6. **Tiered registry** (F2): hermetic categories gate CI; paid categories feed publication; `all.ts` reads the registry.
7. **Independent gold:** gold is derived from generator ledgers or external labels, never from gbrain output (Cat4's forward state machine is the model to copy).
8. **Human calibration sample:** at least 50 human-labeled items for every LLM-judged metric before a number appears in the README. Cat35 is still pending, per TODOS.
9. **One gbrain SHA per publication** (F7), stamped in every receipt.

---

## 7. Prioritized roadmap

| Order | Item | Why first | Cost |
|---|---|---|---|
| 1 | Fix F1 (README relational claim) and F2 (registry + true publication sweep) | A wrong public number, and a sweep that reproduces nothing | $0 |
| 2 | N3 Temporal, N4 Entity Resolution, N6 Visibility Leak Fuzz, N12 Format Fidelity | Offline, cheap, and each exposes a shipped-but-untested capability | $0 |
| 3 | N1 Knowledge-Update, N2 Contradictions, N5 Forgetting Residue | The industry's weakest abilities, where gbrain has distinctive machinery (takes vs facts, withdrawal records) | under $5 total |
| 4 | Matched gpt-4o QA arm on LongMemEval-S + AMB provider submission | Converts gbrain's strict retrieval lead into a neutral, comparable QA number | about $30–75 |
| 5 | N10 LongMemEval-M + BEAM with efficiency frontier | External credibility at scale; the frontier view plays to gbrain's token-efficient returns | about $50–150 (estimate) |
| 6 | N11 HaluMem, N9 Multi-hop, N7 Open Loops, N8 Prospective | Write-path and agent-behavior evidence | about $20–60 |
| 7 | N13 Code Intelligence; deferred items | Domain breadth | low |

---

## 8. Unverified or suspected items

- **F12:** the reports other than LongMemEval may already carry latency somewhere I didn't read. Treat F12 as suspected; the receipts auditor should confirm.
- **Paid-cost estimates for N10 and N11** are order-of-magnitude figures, not measured. Compute them from unique-session token counts, or a one-user sample, before committing.
- **Third-party numbers in section 3.2** are self-reported unless marked AMB or third party. The Zep 90.2% LME and 94.7% LoCoMo site figures come via a secondary review site (opensourceaireview.com) and were not confirmed on getzep.com. The OpenAI 52.9% LoCoMo figure comes from the Mem0 paper protocol (2025).
- **Coverage grades** reflect runner code and published docs. I didn't execute paid runs, so a grade of "weak" for Cat25/26/27/29 means "no current publication or hermetic stub only", not a demonstrated failure.
- **Reading of the Cat 6 header (F3):** I read it as a product-wide claim ("gbrain v0.47.6.0 has no extraction pass…"). If the intended scope is only `extractPageLinks`, the fix is to reword the header and add the gazetteer arm; the coverage gap stands either way.
