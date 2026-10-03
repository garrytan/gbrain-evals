# BrainBench: 2026-10-03

**Tier:** offline
**Branch:** HEAD
**Commit:** `5e0a5b8`
**Engine:** PGLite (in-memory)
**BRAINBENCH_N:** unset (read only by multi-adapter.ts)
**Concurrency:** 2 subprocess slots; exclusive latency categories run alone

## Summary

30 of 66 listed categories ran in tier "offline": 29 passed, 0 failed, 1 skipped (a skipped category is never a pass), 0 report-only with a non-pass verdict (reported, not failed). 36 were not run; they are listed below with the reason.

| Cat | Category | Tier | Status | Source | Elapsed | Notes |
|---|----------|------|--------|--------|---------|-------|
| 1 | Relational retrieval before/after graph traversal (world-v1) | offline | ✓ PASS | receipt | 5s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/before-after.ts` |
| 2 | Link type accuracy (world-v1) | offline | ✓ PASS | receipt | 2s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/type-accuracy.ts` |
| 3 | Alias lookup through keyword search | offline | ✓ PASS | receipt | 4s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/identity.ts` |
| 4 | Timeline storage round-trip | offline | ✓ PASS | receipt | 3s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/temporal.ts` |
| 6 | Auto-link precision under prose | offline | ✓ PASS | receipt | 6s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/cat6-prose-scale.ts` |
| 7 | Performance / latency | offline | ✓ PASS | receipt | 39s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/perf.ts` |
| 10 | Robustness / adversarial input | offline | ✓ PASS | receipt | 3s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/adversarial.ts` |
| 11 | Text ingestion fidelity (md/html; audio needs a key) | offline | ✓ PASS | receipt | 3s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/cat11-multimodal.ts` |
| 12 | MCP operation contract | offline | ✓ PASS | receipt | 5s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/mcp-contract.ts` |
| 19 | Sick-brain remediation loop (hash embeddings) | offline | ✓ PASS | receipt | 4s | verdict=pass (not publishable); safety 0/0, quality 1/1: `eval/runner/cat19-doctor-remediate.ts` |
| 22 | Source isolation | offline | ✓ PASS | receipt | 4s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/cat22-source-isolation.ts` |
| 23 | Phantom to canonical redirect | offline | ✓ PASS | receipt | 3s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/cat23-phantom-redirect.ts` |
| 24 | Capture provenance | offline | ✓ PASS | receipt | 4s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/cat24-capture-provenance.ts` |
| 27 | Graph signals on/off | offline | ✓ PASS | receipt | 9s | verdict=pass (not publishable); safety 0/0, quality 1/1: `eval/runner/cat27-graph-signals.ts` |
| 28 | Federated sync latency | offline | ✓ PASS | receipt | 33s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/cat28-federated-sync-latency.ts` |
| 34 | BrainBench memory conformance (external gbrain checkout) | offline | ⤼ SKIPPED | receipt | 1s | no gbrain checkout with BrainBench found. Set GBRAIN_REPO to a checkout carrying src/cli.ts + evals/brainbench/ (requires the Cathedral 2 release, > v0.42.40.0).: `eval/runner/cat34-brainbench-memory.ts` |
| 36 | Associative retrieval (offline keyword plumbing only; not capability evidence) | offline | ✓ PASS | receipt | 6s | verdict=pass (not publishable); safety 0/0, quality 1/1: `eval/runner/cat36-associative-retrieval.ts` |
| N3 | Temporal and as-of questions through gbrain's temporal features | offline | ✓ PASS | receipt | 22s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/n3-temporal-asof.ts` |
| N4 | Entity resolution: variants, namesakes and cross-source identity | offline | ✓ PASS | receipt | 12s | verdict=fail; safety 5/5, quality 2/2: `eval/runner/n4-entity-resolution.ts` |
| N6 | Visibility and access leak fuzz (every read op x caller x scope) | offline | ✓ PASS | receipt | 27s | verdict=pass; safety 6/6, quality 1/1: `eval/runner/n6-visibility-fuzz.ts` |
| N12 | Ingestion format fidelity: transcript adapters, conversation-parser patterns and attendance | offline | ✓ PASS | receipt | 8s | verdict=pass; safety 4/4, quality 2/2: `eval/runner/n12-format-fidelity.ts` |
| N13 | Code intelligence readiness scout (six code_* ops, one pinned TypeScript repo) | offline | ✓ PASS | receipt | 4s | verdict=pass; no gating rule: `eval/runner/n13-code-intelligence.ts` |
| N7 | Open loops on Gmail-shaped threads: turn-flip detection, closure, manual close and mute | offline | ✓ PASS | receipt | 3s | verdict=pass; safety 5/5, quality 3/3: `eval/runner/n7-open-loops-email.ts` |
| N8 | Unsolicited recall: volunteer_context and turn_context final delivery across sessions | offline | ✓ PASS | receipt | 56s | verdict=pass; no gating rule: `eval/runner/n8-proactive-recall.ts` |
| N2 | Contradiction surfacing: candidate discovery, classification and resolution proposals | offline | ✓ PASS | receipt | 65s | verdict=pass; safety 2/2, quality 1/1: `eval/runner/n2-contradiction-surfacing.ts` |
| A4 | Abstention: the CRAG grade against evidence sufficiency, and a fixed answerer against answerability | offline | ✓ PASS | receipt | 26s | verdict=pass; safety 0/0, quality 2/2: `eval/runner/a4-abstention.ts` |
| SO | System One (Jev decision support) record: datasets, receipts and pair definitions | offline | ✓ PASS | receipt | 1s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/system-one-jev.ts` |
| N9 | Multi-hop with held-out wording: composed 2-3-hop questions, relational retrieval off vs on | offline | ✓ PASS | receipt | 36s | verdict=pass; no gating rule: `eval/runner/n9-multi-hop-paraphrase.ts` |
| N1-ci | Knowledge update CI slice: four ledger entities on one PGLite stdio MCP cell | offline | ✓ PASS | receipt | 60s | verdict=pass; safety 3/3, quality 5/5: `eval/runner/n1-knowledge-update.ts` |
| N5-ci | Forgetting residue CI slice: two ledger entities on one PGLite stdio MCP cell | offline | ✓ PASS | receipt | 75s | verdict=pass; safety 5/5, quality 5/5: `eval/runner/n5-forget-residue.ts` |

## Not run in this invocation

| Cat | Category | Needs | Reason | Command |
|---|----------|-------|--------|---------|
| 5 | Source attribution / provenance | none | not implemented: no reviewed claim catalog exists (the one-claim gold/citations.json template was removed in 0.10.1), and the runner has no gbrain in the loop |  |
| 8 | Skill behavior compliance | none | not implemented: no reviewed probe catalog in the repository |  |
| 9 | End-to-end workflows | none | not implemented: no reviewed scenario catalog in the repository |  |
| 13 | Conceptual search (live embeddings) | paid | tier P not selected | `bun eval/runner/cat13-conceptual.ts` |
| 13b | Source swamp: curated notes vs bulk chat (live embeddings) | paid | tier P not selected | `bun eval/runner/cat13b-source-swamp.ts` |
| 13b-sit | Situation recall on Cat 13b (memory-cue arms) | paid | release protocol run, not a sweep category; needs the memory-cue build (gbrain-cues) and an explicit protocol | `bun eval/runner/situation-recall-cat13b.ts` |
| 14 | Calibration A/B of think (live model and judge) | paid | tier P not selected | `bun eval/runner/cat14-calibration.ts` |
| 15 | propose_takes extraction (live model) | paid | tier P not selected | `bun eval/runner/cat15-propose-takes.ts` |
| 18 | Embedding providers | paid | tier P not selected | `bun eval/runner/cat18-embedding-providers.ts` |
| 18b | Embedder x reranker matrix | paid | tier P not selected | `bun eval/runner/cat18b-embedding-rerank-matrix.ts` |
| 20 | Brainstorm grounding (live model and judge) | paid | tier P not selected | `bun eval/runner/cat20-brainstorm.ts` |
| 21 | Code retrieval (live embeddings) | paid | tier P not selected | `bun eval/runner/cat21-code-retrieval.ts` |
| 25 | Trajectory routing in think (live model) | paid | tier P not selected | `bun eval/runner/cat25-trajectory-routing.ts` |
| 26 | Contextual retrieval modes (live embeddings) | paid | tier P not selected | `bun eval/runner/cat26-contextual-retrieval.ts` |
| 29 | think vs raw search payload (live model and judge) | paid | tier P not selected | `bun eval/runner/cat29-think-vs-search.ts` |
| 30-33 | SkillOpt improvement, ablation, reward hacking, transfer | paid | multi-hour paid optimizer runs; dispatched by their own script | `bash eval/runner/run-skillopt-cats.sh` |
| 35 | Transcript to brain-page distillation fidelity (full mode) | paid | tier P not selected | `bun eval/runner/cat35-transcript-distill.ts` |
| 36-live | Associative retrieval (live cue arms) | paid | needs an approved provider budget profile and the memory-cue build (gbrain-cues) | `bun eval/runner/cat36-associative-retrieval.ts --profile <approved-profile.json>` |
| SO-live | System One (Jev decision support) per-slot matched pairs, run against a gbrain checkout | paid | needs a gbrain checkout with the --decide eval flags (feat/system-one-v1 or later) and a TypeSafe Jev key; most arms also need OpenAI, Voyage and Anthropic keys | `bun eval/runner/system-one-jev.ts run --gbrain <checkout>@<ref> --eval <evaluation id or slot> --yes` |
| multi-adapter | Multi-adapter relational, fuzzy and external query families | paid | tier P not selected | `bun eval/runner/multi-adapter.ts` |
| relational-ab | Relational retrieval off vs on | paid | tier K not selected | `bun eval/runner/relational-ab.ts` |
| N9-paid | Multi-hop with held-out wording, hybrid arm with OpenAI embeddings | paid | spends money: needs --paid and --budget-run-id naming an open budget run | `bun eval/runner/n9-multi-hop-paraphrase.ts --paid --budget-run-id <id>` |
| precisionmembench | PrecisionMemBench | paid | tier P not selected | `bun eval/runner/precisionmembench.ts` |
| longmemeval | LongMemEval retrieval | paid | needs the downloaded LongMemEval dataset path and a multi-hour batch | `bash eval/runner/longmemeval-batch.sh --dataset <longmemeval_s_cleaned.json>` |
| longmemeval-answers | LongMemEval answer grounding check | paid | needs a retained LongMemEval evidence stream from a retrieval run | `bun eval/runner/longmemeval-answers.ts` |
| longmemeval-m-pilot | LongMemEval-M paired pilot | paid | preregistered paid protocol with frozen package identities (gbrain-cues); run by its own scripts | `bun eval/runner/longmemeval-m-pilot-live.ts` |
| reading-notes | Reading notes reader A/B | paid | paid protocol with frozen request payloads; the offline recount runs in bun run test | `bun eval/runner/reading-notes-run.ts` |
| lifecycle | Memory lifecycle across builds, engines and interfaces | offline | needs a gbrain checkout to build each compared revision, and Postgres for the postgres cells | `bun eval/runner/lifecycle-experiment.ts --gbrain-repo <gbrain checkout>` |
| 40 | Model Ladder: agent tasks over a company knowledge base, by memory system and model generation | paid | paid model calls across many models, and a gbrain checkout for the gbrain arm | `bun eval/runner/cat40-model-ladder.ts --models <list> --arms oracle,fs,fs-acl,memory,pg,gbrain --max-tool-chars 100000000 --gbrain-repo <gbrain checkout> --budget-usd <n>` |
| N1 | Knowledge update and supersession through the lifecycle harness (explicit fence supersession, ontology as-of, trajectories) | offline | a lifecycle slice: it spawns real gbrain CLI, stdio and HTTP servers per cell for minutes, above the 60-second CI budget, and its Postgres cells need Docker; rules apply to every counted run; CI runs the preregistered slice instead (registry entry knowledge-update-ci) | `bun eval/runner/n1-knowledge-update.ts [--gbrain <checkout>@<ref>] [--engines pglite,postgres] [--interfaces cli,mcp-stdio,mcp-http] [--pg-url <url>]` |
| N5 | Forgetting and withdrawal residue through the lifecycle harness | offline | a lifecycle slice: it spawns real gbrain CLI, stdio and HTTP servers per cell for minutes, above the 60-second CI budget, and its Postgres cells need Docker; rules apply to every counted run; CI runs the preregistered slice instead (registry entry forget-residue-ci) | `bun eval/runner/n5-forget-residue.ts [--gbrain <checkout>@<ref>] [--engines pglite,postgres] [--interfaces cli,mcp-stdio,mcp-http] [--pg-url <url>]` |
| evidence-delivery | Evidence delivery ablation (LongMemEval-S, frozen reranked hits) | paid | preregistered paid protocol on a frozen evidence manifest at a pinned gbrain commit; every paid step joins one campaign budget-ledger run | `bun eval/runner/evidence-delivery.ts e1 --frozen-dir <dir> --dataset <longmemeval_s_cleaned.json> --out-dir <dir> --set pilot --arms <arms> --budget-run-id <campaign run>` |
| sealed-confirmation | Sealed confirmation set (release decisions only) | paid | private questions and labels; every run is a release decision that needs a committed preregistration | `bun eval/runner/sealed-confirmation.ts run --questions <q.json> --out-dir <dir>` |
| situation-recall | Situation-recall release comparator | paid | release protocol, run against registered baselines rather than as a sweep category | `bun eval/runner/situation-recall-orchestration.ts` |
| shootout | Embedder x reranker shootout cell | paid | single-cell driver parameterized per run | `bun eval/runner/shootout-driver.ts` |
| qrels | qrels / baseline regression fixture | offline | checked in CI; the corpus is synthesized from the queries, so it is a regression smoke only | `bun scripts/generate-v0.41-launch.ts --check` |

---
## Cat 1: Relational retrieval before/after graph traversal (world-v1)

**Status:** ✓ PASS (receipt; exit 0, 5s)

```
# BrainBench v1 — before/after PR #188

Generated: 2026-10-03T19:50:12
Corpus: 240 rich-prose pages from eval/data/world-v1/
Relational queries: 145
  Setting up brain schema (v196)...
  v142: takes.embedding resized to vector(1024); existing take vectors cleared

## Seeding corpus + running extract (v0.10.4 stack)
[extract.links_db] start
[extract.links_db] 10/240 (4%)
[extract.links_db] 20/240 (8%)
[extract.links_db] 30/240 (12%)
[extract.links_db] 40/240 (16%)
[extract.links_db] 50/240 (20%)
[extract.links_db] 60/240 (25%)
[extract.links_db] 70/240 (29%)
[extract.links_db] 80/240 (33%)
[extract.links_db] 90/240 (37%)
[extract.links_db] 100/240 (41%)
[extract.links_db] 110/240 (45%)
[extract.links_db] 120/240 (50%)
[extract.links_db] 130/240 (54%)
[extract.links_db] 140/240 (58%)
[extract.links_db] 150/240 (62%)
[extract.links_db] 160/240 (66%)
[extract.links_db] 170/240 (70%)
[extract.links_db] 180/240 (75%)
[extract.links_db] 190/240 (79%)
[extract.links_db] 200/240 (83%)
[extract.links_db] 210/240 (87%)
[extract.links_db] 220/240 (91%)
[extract.links_db] 230/240 (95%)
[extract.links_db] 240/240 (100%)
[extract.links_db] 240/240 (100%) done
Links: created 635 from 240 pages (db source)
Skipped 275 candidate(s) whose target page doesn't exist (references to non-pages are never persisted).

Done: 635 links, 0 timeline entries from 240 pages
[extract.timeline_db] start
[extract.timeline_db] 10/240 (4%)
[extract.timeline_db] 20/240 (8%)
[extract.timeline_db] 30/240 (12%)
[extract.timeline_db] 40/240 (16%)
[extract.timeline_db] 50/240 (20%)
[extract.timeline_db] 60/240 (25%)
[extract.timeline_db] 70/240 (29%)
[extract.timeline_db] 80/240 (33%)
[extract.timeline_db] 90/240 (37%)
[extract.timeline_db] 100/240 (41%)
[extract.timeline_db] 110/240 (45%)
[extract.timeline_db] 120/240 (50%)
[extract.timeline_db] 130/240 (54%)
[extract.timeline_db] 140/240 (58%)
[extract.timeline_db] 150/240 (62%)
[extract.timeline_db] 160/240 (66%)
[extract.timeline_db] 170/240 (70%)
[extract.timeline_db] 180/240 (75%)
[extract.timeline_db] 190/240 (79%)
[extract.timeline_db] 200/240 (83%)
[extract.timeline_db] 210/240 (87%)
[extract.timeline_db] 220/240 (91%)
[extract.timeline_db] 230/240 (95%)
[extract.timeline_db] 240/240 (100%)
[extract.timeline_db] 240/240 (100%) done
Timeline: created 2208 entries from 240 pages (db source)

Done: 0 links, 2208 timeline entries from 240 pages
After extract: 635 typed links, 2208 timeline entries

## Running queries through BEFORE (grep-only) and AFTER (graph + grep)

## Headline: top-K relational query accuracy on 240-page rich-prose corpus

Real agents read ranked top-K results, not full sets. AFTER ranks graph hits
first (high precision) then fills with grep. K=5 (a tight ceiling — agents
almost always read at least the top 5 results).

| Metric                       | BEFORE PR #188 | AFTER PR #188 | Δ                |
|------------------------------|----------------|---------------|------------------|
| **Precision@5** (/5)           | **29.9%**         | **33.7%**        | **+3.7pts**         |
| Precision@5, legacy /min(5, returned) | 39.2%          | 44.1%         | +4.9pts           |
| Precision@5 ceiling (/5)         | 36.0%          | 36.0%         |                  |
| **Recall@5**                   | **83.1%**         | **93.5%**        | **+10.3pts**         |
| Correct in top-5 (total)       | 217            | 244           | +27              |

## Set-based metrics (full result sets, no top-K cutoff)

| Metric                   | BEFORE PR #188 | AFTER PR #188 | Δ              | Graph-only (ablation) |
|--------------------------|----------------|---------------|----------------|-----------------------|
| **F1 score**             | **57.8%**         | **57.8%**        | **+0.0pts**       | 61.3%                 |
| Relational recall        | 98.9%          | 98.9%         | +0.0pts          | 47.1%                 |
| Relational precision     | 40.8%          | 40.8%         | +0.0pts          | 87.9%                 |
| Total returned (any)     | 632            | 632           | +0             | 140                   |
| Correct returned         | 258            | 258           | +0              | 123                   |

## By link type (AFTER vs BEFORE, set metrics)
| Link type   | Expected | BEFORE found/ret      | AFTER found/ret       | Recall Δ | Precision Δ | F1 Δ        |
|-------------|----------|-----------------------|-----------------------|----------|-------------|-------------|
| attended    | 134      | 131/200               | 131/200               | +0pts    | +0pts       | +0pts      |
| works_at    | 50       | 50/190                | 50/190                | +0pts    | +0pts       | +0pts      |
| invested_in | 60       | 60/166                | 60/166                | +0pts    | +0pts       | +0pts      |
| advises     | 17       | 17/76                 | 17/76                 | +0pts    | +0pts       | +0pts      |

## What this proves

PR #188 dominates BEFORE on top-5 found (+27); no link type regressed.
Graph hits are surfaced FIRST in the ranked list; the agent's first reads are
exact-typed answers instead of arbitrary text matches.

Set-based metrics (full result sets) are unchanged because graph hits are a
subset of grep hits in this corpus — taking the union doesn't add or remove
anything from the bag of returned results. What changes is which results
appear FIRST. Top-K captures that; raw set recall doesn't.

The graph-only ablation column shows the upper bound of where this is going:
87.9% precision, 47.1% recall. The next round of extraction
tuning (TODOS.md v0.10.5) will lift graph recall toward grep parity, at
which point set-based metrics also start to favor AFTER.

✓ gates passed: AFTER >= BEFORE on top-5 found/recall/precision, no type regressed.

```

---
## Cat 2: Link type accuracy (world-v1)

**Status:** ✓ PASS (receipt; exit 0, 2s)

```
# BrainBench — type accuracy on rich-prose corpus

Generated: 2026-10-03T19:50:12
Corpus: eval/data/world-v1/
Loaded 240 pages.

Gold edges (from _facts):     280
Inferred edges (extractPageLinks): 910

## Per-link-type results

| Link type    | Gold | Correct | Mistyped | Missed | Spurious | Type acc | Recall | Prec   | F1 (strict) |
|--------------|------|---------|----------|--------|----------|----------|--------|--------|-------------|
| attended     |  134 |       0 |        0 |    134 |        0 |     0.0% |   0.0% |   0.0% |        0.0% |
| invested_in  |   75 |      55 |       20 |      0 |       95 |    73.3% |  73.3% |  36.7% |       48.9% |
| founded      |   40 |      32 |        8 |      0 |       77 |    80.0% |  80.0% |  29.4% |       43.0% |
| advises      |   17 |      12 |        5 |      0 |       61 |    70.6% |  70.6% |  16.4% |       26.7% |
| works_at     |   10 |      10 |        0 |      0 |       44 |   100.0% | 100.0% |  18.5% |       31.3% |
| mentions     |    4 |       0 |        4 |      0 |      495 |     0.0% |   0.0% |   0.0% |        0.0% |

**Columns:**
- *Type acc*: given the edge was found at all, was it typed correctly? `correct / (correct + mistyped)`. A pair counts as correct only when no other specific type was inferred for it (the untyped `mentions` fallback is allowed).
- *Recall*: of gold edges, how many did we correctly find AND type? `correct / gold`.
- *Precision*: of edges we inferred as this type, how many were actually this type? `correct / (correct + spurious)`. Every inferred (pair, type) that differs from the gold type counts as spurious.
- *F1 (strict)*: strict `(from, to, type)` triple match. Catches both extraction-recall and type-accuracy misses in one number.

## Overall

- Overall type accuracy (conditional on finding the edge): **74.7%**
- Overall strict F1 (triple match): **18.8%**
- Diagnostic, any-type leniency (gold type among the inferred types): 94.5%
- Verdict: pass (floors: type accuracy >= 70.0%, strict F1 >= 15.0%)

## Confusion matrix (rows = gold type, cols = inferred type)

| gold \ inferred | (missing)      | advises        | founded        | invested_in    | mentions       | works_at       |
|----------------|----------------|----------------|----------------|----------------|----------------|----------------|
| advises        | 0              | 12             | 0              | 5              | 0              | 0              |
| attended       | 134            | 0              | 0              | 0              | 0              | 0              |
| founded        | 0              | 0              | 32             | 1              | 0              | 7              |
| invested_in    | 0              | 10             | 0              | 55             | 0              | 10             |
| mentions       | 0              | 2              | 0              | 0              | 0              | 2              |
| works_at       | 0              | 0              | 0              | 0              | 0              | 10             |
| (no-gold)      | 0              | 49             | 77             | 89             | 454            | 23             |


```

---
## Cat 3: Alias lookup through keyword search

**Status:** ✓ PASS (receipt; exit 0, 4s)

```
# BrainBench Category 3: Identity Resolution

Generated: 2026-10-03T19:50:14
Entities: 100
Aliases per entity: 4 documented + 4 undocumented = 8 total
  Setting up brain schema (v196)...
  v142: takes.embedding resized to vector(1024); existing take vectors cleared

## Metrics
| Alias category   | Recall (top-10) | MRR    |
|------------------|-----------------|--------|
| Documented       | 100.0%             | 0.988  |
| Undocumented     | 13.8%             | 0.103  |

## Per-alias-type breakdown (documented)
  fullname   100/100 = 100.0%
  handle     100/100 = 100.0%
  email      100/100 = 100.0%
  handle-plain 100/100 = 100.0%

## Per-alias-type breakdown (undocumented)
  initial       15/100 = 15.0%
  no-period     15/100 = 15.0%
  typo          25/200 = 12.5%

## Interpretation
Documented aliases (full name, handle, email mentioned in canonical body, plus the handle without @, which the tsvector index also holds):
  Recall 100.0% through this fixture's tsvector keyword path.
Undocumented aliases (initials, typos):
  Recall 13.8% through the same keyword path, without invoking the alias resolver.

Scope: this keyword-only protocol does not measure the explicit alias resolver, fuzzy matching, or nickname lookup.

Verdict: pass (documented recall >= 100%, documented MRR >= 0.95)

```

---
## Cat 4: Timeline storage round-trip

**Status:** ✓ PASS (receipt; exit 0, 3s)

```
# BrainBench Category 4: Temporal Queries

Generated: 2026-10-03T19:50:17
  Setting up brain schema (v196)...
  v142: takes.embedding resized to vector(1024); existing take vectors cleared
Events: 725
Entities: 50
As-of queries: 50

## Point queries
  30 dates queried, 66 expected events
  Recall: 100.0%, Precision: 100.0%

## Range queries
  Q1 2024: 37 expected, 37 returned, R=100.0%, P=100.0%
  Q2 2025: 33 expected, 33 returned, R=100.0%, P=100.0%
  Q4 2024: 33 expected, 33 returned, R=100.0%, P=100.0%
  Q3 2023: 45 expected, 45 returned, R=100.0%, P=100.0%
  Average: R=100.0%, P=100.0%

## Recency queries (most recent 3 events per entity)
  30 entities × 3 most-recent events each
  Top-3 correctness: 100.0%

## As-of queries (HARD — no native gbrain operation)
  System: retrieved timeline + harness filter (latest job-change ≤ asOfDate).
  Gold: forward job-state machine over the SEEDED events (independent derivation).
  50 as-of queries, 50 correct = 100.0%
  Measures the storage roundtrip of job-change entries (dates, summaries,
  completeness) — NOT a native as-of query capability; gbrain has none.
  A native `getStateAtTime` op remains the suggested feature.

## Summary
| Sub-category    | Recall | Precision | Notes                                |
|-----------------|--------|-----------|--------------------------------------|
| Point           | 100.0% | 100.0%    | Cross-entity date query (manual)     |
| Range           | 100.0% | 100.0%    | Same — manual cross-entity filter    |
| Recency (top-3) | 100.0% | —         | Per-entity, native getTimeline       |
| As-of           | 100.0% | —         | Independent gold vs stored timeline  |

Verdict: pass (pass requires every metric = 100%: exact roundtrip conformance)

```

---
## Cat 6: Auto-link precision under prose

**Status:** ✓ PASS (receipt; exit 0, 6s)

```
  Setting up brain schema (v196)...
  v142: takes.embedding resized to vector(1024); existing take vectors cleared
[extract.links_db] start
[extract.links_db] 10/210 (4%)
[extract.links_db] 20/210 (9%)
[extract.links_db] 30/210 (14%)
[extract.links_db] 40/210 (19%)
[extract.links_db] 50/210 (23%)
[extract.links_db] 60/210 (28%)
[extract.links_db] 70/210 (33%)
[extract.links_db] 80/210 (38%)
[extract.links_db] 90/210 (42%)
[extract.links_db] 100/210 (47%)
[extract.links_db] 110/210 (52%)
[extract.links_db] 120/210 (57%)
[extract.links_db] 130/210 (61%)
[extract.links_db] 140/210 (66%)
[extract.links_db] 150/210 (71%)
[extract.links_db] 160/210 (76%)
[extract.links_db] 170/210 (80%)
[extract.links_db] 180/210 (85%)
[extract.links_db] 190/210 (90%)
[extract.links_db] 200/210 (95%)
[extract.links_db] 210/210 (100%)
[extract.links_db] 210/210 (100%) done
[extract.by_mention.scan] start
[extract.by_mention.scan] 10/210 (4%)
[extract.by_mention.scan] 20/210 (9%)
[extract.by_mention.scan] 30/210 (14%)
[extract.by_mention.scan] 40/210 (19%)
[extract.by_mention.scan] 50/210 (23%)
[extract.by_mention.scan] 60/210 (28%)
[extract.by_mention.scan] 70/210 (33%)
[extract.by_mention.scan] 80/210 (38%)
[extract.by_mention.scan] 90/210 (42%)
[extract.by_mention.scan] 100/210 (47%)
[extract.by_mention.scan] 110/210 (52%)
[extract.by_mention.scan] 120/210 (57%)
[extract.by_mention.scan] 130/210 (61%)
[extract.by_mention.scan] 140/210 (66%)
[extract.by_mention.scan] 150/210 (71%)
[extract.by_mention.scan] 160/210 (76%)
[extract.by_mention.scan] 170/210 (80%)
[extract.by_mention.scan] 180/210 (85%)
[extract.by_mention.scan] 190/210 (90%)
[extract.by_mention.scan] 200/210 (95%)
[extract.by_mention.scan] 210/210 (100%)
[extract.by_mention.scan] 210/210 (100%) done
{
  "schema_version": 2,
  "ran_at": "2026-10-03T19:50:18.780Z",
  "variants": 250,
  "corpus_id": "world-v1",
  "per_kind": [
    {
      "kind": "code_fence_leak",
      "variants": 50,
      "total_must_extract": 50,
      "total_matched": 50,
      "total_mistyped": 0,
      "total_missed": 0,
      "total_must_not": 50,
      "total_false_positives": 0,
      "precision": 1,
      "recall": 1,
      "type_match_rate": 1,
      "false_positive_rate": 0
    },
    {
      "kind": "inline_code_slug",
      "variants": 50,
      "total_must_extract": 50,
      "total_matched": 50,
      "total_mistyped": 0,
      "total_missed": 0,
      "total_must_not": 50,
      "total_false_positives": 0,
      "precision": 1,
      "recall": 1,
      "type_match_rate": 1,
      "false_positive_rate": 0
    },
    {
      "kind": "substring_collision",
      "variants": 50,
      "total_must_extract": 50,
      "total_matched": 50,
      "total_mistyped": 0,
      "total_missed": 0,
      "total_must_not": 50,
      "total_false_positives": 0,
      "precision": 1,
      "recall": 1,
      "type_match_rate": 1,
      "false_positive_rate": 0
    },
    {
      "kind": "ambiguous_role",
      "variants": 50,
      "total_must_extract": 50,
      "total_matched": 50,
      "total_mistyped": 0,
      "total_missed": 0,
      "total_must_not": 0,
      "total_false_positives": 0,
      "precision": 1,
      "recall": 1,
      "type_match_rate": 1,
      "false_positive_rate": null
    },
    {
      "kind": "multi_entity_sentence",
      "variants": 50,
      "total_must_extract": 250,
      "total_matched": 250,
      "total_mistyped": 0,
      "total_missed": 0,
      "total_must_not": 0,
      "total_false_positives": 0,
      "precision": 1,
      "recall": 1,
      "type_match_rate": 1,
      "false_positive_rate": null
    }
  ],
  "kinds_not_exercised": [
    {
      "kind": "prose_only_mention",
      "reason": "prose_only_mention requires bare-prose-name linking, which the pure extractor under test here does not do (extractPageLinks emits candidates only for markdown refs, wikilinks, bare dir/slug paths, and frontmatter; it takes no entity list). The kind is excluded from this arm's generation and denominators (audit retrieval-cats-05) and scored instead by the gazetteer arm, which runs gbrain's by-mention extract pass over a PGLite brain (see gazetteer_arm in the receipt)."
    }
  ],
  "overall": {
    "link_precision": 1,
    "link_recall": 1,
    "link_f1": 1,
    "code_fence_leak_rate": 0,
    "inline_code_leak_rate": 0,
    "substring_fp_rate": 0,
    "ambiguous_role_type_match_rate": 1,
    "pages_with_links_coverage": 1,
    "mean_links_per_page": 5.732
  },
  "gates": [
    {
      "gate": "code_fence_leak_rate",
      "value": 0,
      "bound": 0,
      "op": "max",
      "pass": true
    },
    {
      "gate": "inline_code_leak_rate",
      "value": 0,
      "bound": 0,
      "op": "max",
      "pass": true
    },
    {
      "gate": "substring_fp_rate",
      "value": 0,
      "bound": 0,
      "op": "max",
      "pass": true
    },
    {
      "gate": "link_recall",
      "value": 1,
      "bound": 0.95,
      "op": "min",
      "pass": true
    },
    {
      "gate": "link_precision",
      "value": 1,
      "bound": 0.95,
      "op": "min",
      "pass": true
    },
    {
      "gate": "ambiguous_role_type_match",
      "value": 1,
      "bound": 0.8,
      "op": "min",
      "pass": true
    }
  ],
  "negative_controls": [
    {
      "control": "code_leak_detectable",
      "description": "a simulated no-code-stripping extractor must produce scored FPs on code_fence_leak / inline_code_slug variants",
      "fired_on": 100,
      "variants": 100,
      "fired": true
    },
    {
      "control": "substring_fp_detectable",
      "description": "a simulated hyphen-truncating bare-path matcher must trip the substring_collision near-miss trap (audit retrieval-cats-06)",
      "fired_on": 50,
      "variants": 50,
      "fired": true
    }
  ],
  "verdict": "pass",
  "rows": [
    {
      "variantId": "companies/accel-5-v0-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "companies/y-combinator",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/a16z",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/a16z",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/rachel-brown-95",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/accel-5-v0-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/accel-5",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1000",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "people/rachel-brown-95",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1000 inside code fence + real mention people/rachel-brown-95 outside."
      }
    },
    {
      "variantId": "companies/acme-labs-50-v1-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "people/ian-kim-50",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/helen-martinez-87",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/wendy-wilson-170",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/helen-martinez-87",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/epsilon-labs-54",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/acme-labs-50-v1-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/acme-labs-50",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1001",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/epsilon-labs-54",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1001 inside code fence + real mention companies/epsilon-labs-54 outside."
      }
    },
    {
      "variantId": "companies/anchor-28-v2-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "people/carol-wilson-28",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/sarah-williams-92",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/kate-anderson-107",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/spire-46",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/anchor-28-v2-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/anchor-28",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1002",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/spire-46",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1002 inside code fence + real mention companies/spire-46 outside."
      }
    },
    {
      "variantId": "companies/apex-18-v3-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "people/nina-rodriguez-18",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/priya-taylor-85",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/kevin-taylor-102",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/tina-wang-179",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/yara-singh-195",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/kevin-taylor-102",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/tina-wang-179",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/mosaic-14",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/apex-18-v3-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/apex-18",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1003",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/mosaic-14",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1003 inside code fence + real mention companies/mosaic-14 outside."
      }
    },
    {
      "variantId": "companies/beacon-10-v4-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "people/david-wang-10",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/rachel-brown-95",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/julia-chen-181",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/rachel-brown-95",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/julia-chen-181",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/gamma-2",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/beacon-10-v4-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/beacon-10",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1004",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/gamma-2",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1004 inside code fence + real mention companies/gamma-2 outside."
      }
    },
    {
      "variantId": "companies/bessemer-12-v5-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "companies/sequoia-capital",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/a16z",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/a16z",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/resonance-45",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/bessemer-12-v5-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/bessemer-12",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1005",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/resonance-45",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1005 inside code fence + real mention companies/resonance-45 outside."
      }
    },
    {
      "variantId": "companies/beta-labs-51-v6-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "people/victor-jones-51",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/jack-davis-89",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/chris-singh-96",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/jack-davis-89",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/chris-singh-96",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/victor-jones-51",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/nimbus-5",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/beta-labs-51-v6-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/beta-labs-51",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1006",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/nimbus-5",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1006 inside code fence + real mention companies/nimbus-5 outside."
      }
    },
    {
      "variantId": "companies/cascade-30-v7-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "people/yara-smith-30",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/bob-chen-185",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/bob-chen-185",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/yara-smith-30",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/tina-hernandez-97",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/cascade-30-v7-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/cascade-30",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1007",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "people/tina-hernandez-97",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1007 inside code fence + real mention people/tina-hernandez-97 outside."
      }
    },
    {
      "variantId": "companies/compass-11-v8-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "people/mark-thomas-11",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/chris-miller-101",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/sam-garcia-188",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/chris-miller-101",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/sam-garcia-188",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/quinten-lee-24",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/compass-11-v8-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/compass-11",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1008",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "people/quinten-lee-24",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1008 inside code fence + real mention people/quinten-lee-24 outside."
      }
    },
    {
      "variantId": "companies/delta-labs-53-v9-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "people/will-garcia-53",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/wendy-hernandez-80",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/tina-hernandez-97",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/wendy-wilson-170",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/grace-singh-197",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/mia-anderson-5",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/delta-labs-53-v9-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/delta-labs-53",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1009",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "people/mia-anderson-5",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1009 inside code fence + real mention people/mia-anderson-5 outside."
      }
    },
    {
      "variantId": "companies/echo-32-v10-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "people/helen-johnson-32",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/julia-davis-86",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/helen-martinez-87",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/helen-johnson-32",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/julia-davis-86",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/spire-46",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/echo-32-v10-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/echo-32",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1010",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/spire-46",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1010 inside code fence + real mention companies/spire-46 outside."
      }
    },
    {
      "variantId": "companies/epsilon-labs-54-v11-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "people/diana-wilson-54",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/iris-lee-82",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/grace-martinez-109",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/zoe-jackson-199",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/grace-martinez-109",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/yara-moore-174",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/epsilon-labs-54-v11-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/epsilon-labs-54",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1011",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "people/yara-moore-174",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1011 inside code fence + real mention people/yara-moore-174 outside."
      }
    },
    {
      "variantId": "companies/floodgate-9-v12-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "companies/sequoia-capital",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/andreessen-horowitz",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/stripe",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/lucid-21",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/floodgate-9-v12-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/floodgate-9",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1012",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/lucid-21",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1012 inside code fence + real mention companies/lucid-21 outside."
      }
    },
    {
      "variantId": "companies/founders-fund-0-v13-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "companies/anduril-industries",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/stripe",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/stripe",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/anduril-industries",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/amazon-3",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/founders-fund-0-v13-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/founders-fund-0",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1013",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/amazon-3",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1013 inside code fence + real mention companies/amazon-3 outside."
      }
    },
    {
      "variantId": "companies/gamma-2-v14-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "people/mark-jones-2",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/vera-gonzalez-103",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/vera-gonzalez-103",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/forge-19",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/gamma-2-v14-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/gamma-2",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1014",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/forge-19",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1014 inside code fence + real mention companies/forge-19 outside."
      }
    },
    {
      "variantId": "companies/google-1-v15-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "companies/jolt-37",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/google-1-v15-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/google-1",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1015",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/jolt-37",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1015 inside code fence + real mention companies/jolt-37 outside."
      }
    },
    {
      "variantId": "companies/greylock-4-v16-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "companies/sequoia-capital",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/a16z-3",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/yara-johnson-8",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/greylock-4-v16-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/greylock-4",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1016",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "people/yara-johnson-8",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1016 inside code fence + real mention people/yara-johnson-8 outside."
      }
    },
    {
      "variantId": "companies/hatch-35-v17-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "people/eric-miller-35",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/steve-martinez-192",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/helix-9",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/hatch-35-v17-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/hatch-35",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1017",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/helix-9",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1017 inside code fence + real mention companies/helix-9 outside."
      }
    },
    {
      "variantId": "companies/helix-labs-59-v18-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "people/bob-jackson-59",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/priya-taylor-85",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/julia-davis-86",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/bob-jackson-59",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/nina-rodriguez-18",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/helix-labs-59-v18-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/helix-labs-59",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1018",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "people/nina-rodriguez-18",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1018 inside code fence + real mention people/nina-rodriguez-18 outside."
      }
    },
    {
      "variantId": "companies/initialized-11-v19-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "companies/y-combinator",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/floodgate",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/y-combinator",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/benchmark-3",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/initialized-11-v19-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/initialized-11",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1019",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/benchmark-3",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1019 inside code fence + real mention companies/benchmark-3 outside."
      }
    },
    {
      "variantId": "companies/jolt-37-v20-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "people/chris-williams-37",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/tina-hernandez-97",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/chris-miller-101",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/chris-miller-101",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/tina-hernandez-97",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/chris-williams-37",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/drift-31",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/jolt-37-v20-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/jolt-37",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1020",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/drift-31",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1020 inside code fence + real mention companies/drift-31 outside."
      }
    },
    {
      "variantId": "companies/khosla-ventures-8-v21-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "companies/a16z",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/a16z",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/victor-jackson-116",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/khosla-ventures-8-v21-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/khosla-ventures-8",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1021",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "people/victor-jackson-116",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1021 inside code fence + real mention people/victor-jackson-116 outside."
      }
    },
    {
      "variantId": "companies/kleiner-perkins-14-v22-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "people/ulrich-wang-16",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/kleiner-perkins-14-v22-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/kleiner-perkins-14",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1022",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "people/ulrich-wang-16",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1022 inside code fence + real mention people/ulrich-wang-16 outside."
      }
    },
    {
      "variantId": "companies/lightspeed-6-v23-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "companies/a16z",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/sequoia",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/chris-williams-37",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/lightspeed-6-v23-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/lightspeed-6",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1023",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "people/chris-williams-37",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1023 inside code fence + real mention people/chris-williams-37 outside."
      }
    },
    {
      "variantId": "companies/lumen-12-v24-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "people/henry-johnson-12",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/kate-lopez-99",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/sarah-wang-104",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/kate-lopez-99",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/sarah-wang-104",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/orbit-42",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/lumen-12-v24-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/lumen-12",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1024",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/orbit-42",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1024 inside code fence + real mention companies/orbit-42 outside."
      }
    },
    {
      "variantId": "companies/meridian-40-v25-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "people/chris-nakamura-40",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/priya-taylor-85",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/chris-jackson-91",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/vera-gonzalez-103",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/zoe-jackson-199",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/priya-taylor-85",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/chris-jackson-91",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/vera-gonzalez-103",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/wendy-wilson-170",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/meridian-40-v25-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/meridian-40",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1025",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "people/wendy-wilson-170",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1025 inside code fence + real mention people/wendy-wilson-170 outside."
      }
    },
    {
      "variantId": "companies/microsoft-0-v26-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "companies/greylock-4",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/microsoft-0-v26-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/microsoft-0",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1026",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/greylock-4",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1026 inside code fence + real mention companies/greylock-4 outside."
      }
    },
    {
      "variantId": "companies/nea-13-v27-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "companies/a16z-9",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/sequoia-capital-6",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/sequoia-capital-6",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/a16z-9",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/quasar-44",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/nea-13-v27-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/nea-13",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1027",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/quasar-44",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1027 inside code fence + real mention companies/quasar-44 outside."
      }
    },
    {
      "variantId": "companies/nimbus-5-v28-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "people/mia-anderson-5",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/noah-nakamura-182",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/mia-anderson-5",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/noah-nakamura-182",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/beta-1",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/nimbus-5-v28-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/nimbus-5",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1028",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/beta-1",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1028 inside code fence + real mention companies/beta-1 outside."
      }
    },
    {
      "variantId": "companies/orbit-42-v29-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "people/jack-patel-42",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/julia-davis-86",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/zoe-gonzalez-100",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/julia-davis-86",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/zoe-gonzalez-100",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/drift-31",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/orbit-42-v29-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/orbit-42",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1029",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/drift-31",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1029 inside code fence + real mention companies/drift-31 outside."
      }
    },
    {
      "variantId": "companies/pulse-8-v30-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "people/yara-johnson-8",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/eric-martinez-93",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/david-kim-186",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/eric-martinez-93",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/david-kim-186",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/julia-johnson-114",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/pulse-8-v30-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/pulse-8",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1030",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "people/julia-johnson-114",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1030 inside code fence + real mention people/julia-johnson-114 outside."
      }
    },
    {
      "variantId": "companies/quantum-7-v31-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "people/ulrich-johnson-7",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/kate-anderson-107",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/noah-williams-198",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/kate-anderson-107",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/ulrich-johnson-7",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/vera-chen-14",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/quantum-7-v31-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/quantum-7",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1031",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "people/vera-chen-14",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1031 inside code fence + real mention people/vera-chen-14 outside."
      }
    },
    {
      "variantId": "companies/quasar-44-v32-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "people/mark-wilson-44",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/jack-davis-89",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/grace-singh-197",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/jack-davis-89",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/quinn-park-119",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/quasar-44-v32-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/quasar-44",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1032",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "people/quinn-park-119",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1032 inside code fence + real mention people/quinn-park-119 outside."
      }
    },
    {
      "variantId": "companies/resonance-45-v33-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "people/grace-thomas-45",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/yara-singh-195",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/yara-singh-195",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/grace-thomas-45",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/noah-kapoor-15",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/resonance-45-v33-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/resonance-45",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1033",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "people/noah-kapoor-15",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1033 inside code fence + real mention people/noah-kapoor-15 outside."
      }
    },
    {
      "variantId": "companies/sequoia-capital-1-v34-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "companies/andreessen-horowitz",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/y-combinator",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/andreessen-horowitz",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/y-combinator",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/quinten-lee-24",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/sequoia-capital-1-v34-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/sequoia-capital-1",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1034",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "people/quinten-lee-24",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1034 inside code fence + real mention people/quinten-lee-24 outside."
      }
    },
    {
      "variantId": "companies/talon-47-v35-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "people/diana-thomas-47",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/sarah-williams-92",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/david-kim-186",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/noah-williams-198",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/sarah-williams-92",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/noah-williams-198",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/frank-hernandez-31",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/talon-47-v35-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/talon-47",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1035",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "people/frank-hernandez-31",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1035 inside code fence + real mention people/frank-hernandez-31 outside."
      }
    },
    {
      "variantId": "companies/tessera-15-v36-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "people/noah-kapoor-15",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/kate-lopez-99",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/yara-singh-195",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/uma-gonzalez-29",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/tessera-15-v36-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/tessera-15",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1036",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "people/uma-gonzalez-29",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1036 inside code fence + real mention people/uma-gonzalez-29 outside."
      }
    },
    {
      "variantId": "companies/vector-6-v37-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "people/uma-brown-6",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/david-zhang-83",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/vera-gonzalez-103",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/grace-martinez-109",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/wendy-wilson-170",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/bob-chen-185",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/david-zhang-83",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/grace-martinez-109",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/david-wang-10",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/vector-6-v37-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/vector-6",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1037",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "people/david-wang-10",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1037 inside code fence + real mention people/david-wang-10 outside."
      }
    },
    {
      "variantId": "companies/vellum-49-v38-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "people/chris-davis-49",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/rosa-miller-98",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/rachel-gonzalez-175",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/rosa-miller-98",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/accel-5",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/vellum-49-v38-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/vellum-49",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1038",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/accel-5",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1038 inside code fence + real mention companies/accel-5 outside."
      }
    },
    {
      "variantId": "companies/wisp-26-v39-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "people/linda-kim-26",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/linda-kim-26",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/david-wang-10",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/wisp-26-v39-code_fence_leak",
      "contributed": true,
      "baseSlug": "companies/wisp-26",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1039",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "people/david-wang-10",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1039 inside code fence + real mention people/david-wang-10 outside."
      }
    },
    {
      "variantId": "people/adam-lee-19-v40-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "companies/forge-19",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/forge-19",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/forge-19",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/drift-31",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/adam-lee-19-v40-code_fence_leak",
      "contributed": true,
      "baseSlug": "people/adam-lee-19",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1040",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/drift-31",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1040 inside code fence + real mention companies/drift-31 outside."
      }
    },
    {
      "variantId": "people/alice-davis-172-v41-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "companies/prism-43",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/orbit-labs-92",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/tessera-15",
          "linkType": "advises"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/alice-davis-172-v41-code_fence_leak",
      "contributed": true,
      "baseSlug": "people/alice-davis-172",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1041",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/tessera-15",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1041 inside code fence + real mention companies/tessera-15 outside."
      }
    },
    {
      "variantId": "people/carol-jackson-81-v42-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "companies/sequoia-capital-1",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/prism-43",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/beacon-labs-60",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/foundry-labs-83",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/keel-38",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/pulse-labs-58",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/beacon-labs-60",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/keel-38",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/lightspeed-6",
          "linkType": "invested_in"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/carol-jackson-81-v42-code_fence_leak",
      "contributed": true,
      "baseSlug": "people/carol-jackson-81",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1042",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/lightspeed-6",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1042 inside code fence + real mention companies/lightspeed-6 outside."
      }
    },
    {
      "variantId": "people/chris-jackson-91-v43-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "companies/initialized-11",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/meridian-40",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/gravity-17",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/acme-0",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/lucid-labs-71",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/initialized-11",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/lucid-labs-71",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/acme-0",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/quantum-labs-57",
          "linkType": "invested_in"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/chris-jackson-91-v43-code_fence_leak",
      "contributed": true,
      "baseSlug": "people/chris-jackson-91",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1043",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/quantum-labs-57",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1043 inside code fence + real mention companies/quantum-labs-57 outside."
      }
    },
    {
      "variantId": "people/chris-smith-110-v44-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "companies/acme-0",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/microsoft-0",
          "linkType": "works_at"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/chris-smith-110-v44-code_fence_leak",
      "contributed": true,
      "baseSlug": "people/chris-smith-110",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1044",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/microsoft-0",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1044 inside code fence + real mention companies/microsoft-0 outside."
      }
    },
    {
      "variantId": "people/david-wang-10-v45-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "companies/beacon-10",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/beacon-10",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/tempo-24",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/david-wang-10-v45-code_fence_leak",
      "contributed": true,
      "baseSlug": "people/david-wang-10",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1045",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/tempo-24",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1045 inside code fence + real mention companies/tempo-24 outside."
      }
    },
    {
      "variantId": "people/eric-lee-21-v46-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "companies/lucid-21",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/lucid-21",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/lucid-21",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/ian-davis-33",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/eric-lee-21-v46-code_fence_leak",
      "contributed": true,
      "baseSlug": "people/eric-lee-21",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1046",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "people/ian-davis-33",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1046 inside code fence + real mention people/ian-davis-33 outside."
      }
    },
    {
      "variantId": "people/eric-miller-35-v47-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "companies/hatch-35",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/hatch-35",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/chris-singh-96",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/eric-miller-35-v47-code_fence_leak",
      "contributed": true,
      "baseSlug": "people/eric-miller-35",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1047",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "people/chris-singh-96",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1047 inside code fence + real mention people/chris-singh-96 outside."
      }
    },
    {
      "variantId": "people/frank-hernandez-31-v48-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "companies/drift-31",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/drift-31",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/khosla-ventures-8",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/frank-hernandez-31-v48-code_fence_leak",
      "contributed": true,
      "baseSlug": "people/frank-hernandez-31",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1048",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/khosla-ventures-8",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1048 inside code fence + real mention companies/khosla-ventures-8 outside."
      }
    },
    {
      "variantId": "people/helen-martinez-87-v49-code_fence_leak",
      "kind": "code_fence_leak",
      "extracted": [
        {
          "targetSlug": "companies/index-ventures-7",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/acme-labs-50",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/nexus-labs-91",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/ranger-22",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/mosaic-14",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/echo-32",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/ranger-22",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/echo-32",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/uma-gonzalez-29",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/helen-martinez-87-v49-code_fence_leak",
      "contributed": true,
      "baseSlug": "people/helen-martinez-87",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/fake-1049",
            "reason": "code_fence_leak: slug appears inside triple-backtick fence"
          }
        ],
        "must_extract": [
          {
            "slug": "people/uma-gonzalez-29",
            "type": "mentions",
            "reason": "code_fence_leak: real mention outside the fence should still extract"
          }
        ],
        "note": "Injected fake slug people/fake-1049 inside code fence + real mention people/uma-gonzalez-29 outside."
      }
    },
    {
      "variantId": "companies/meridian-40-v0-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "people/chris-nakamura-40",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/priya-taylor-85",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/chris-jackson-91",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/vera-gonzalez-103",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/zoe-jackson-199",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/priya-taylor-85",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/chris-jackson-91",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/vera-gonzalez-103",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/mia-anderson-5",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/meridian-40-v0-inline_code_slug",
      "contributed": true,
      "baseSlug": "companies/meridian-40",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1050",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "people/mia-anderson-5",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1050 in inline code + real mention people/mia-anderson-5."
      }
    },
    {
      "variantId": "companies/microsoft-0-v1-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/kindle-20",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/microsoft-0-v1-inline_code_slug",
      "contributed": true,
      "baseSlug": "companies/microsoft-0",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1051",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/kindle-20",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1051 in inline code + real mention companies/kindle-20."
      }
    },
    {
      "variantId": "companies/nea-13-v2-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/a16z-9",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/sequoia-capital-6",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/sequoia-capital-6",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/a16z-9",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/mia-brown-0",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/nea-13-v2-inline_code_slug",
      "contributed": true,
      "baseSlug": "companies/nea-13",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1052",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "people/mia-brown-0",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1052 in inline code + real mention people/mia-brown-0."
      }
    },
    {
      "variantId": "companies/nimbus-5-v3-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "people/mia-anderson-5",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/noah-nakamura-182",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/mia-anderson-5",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/noah-nakamura-182",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/keel-38",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/nimbus-5-v3-inline_code_slug",
      "contributed": true,
      "baseSlug": "companies/nimbus-5",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1053",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/keel-38",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1053 in inline code + real mention companies/keel-38."
      }
    },
    {
      "variantId": "companies/orbit-42-v4-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "people/jack-patel-42",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/julia-davis-86",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/zoe-gonzalez-100",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/julia-davis-86",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/zoe-gonzalez-100",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/rachel-gonzalez-175",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/orbit-42-v4-inline_code_slug",
      "contributed": true,
      "baseSlug": "companies/orbit-42",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1054",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "people/rachel-gonzalez-175",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1054 in inline code + real mention people/rachel-gonzalez-175."
      }
    },
    {
      "variantId": "companies/pulse-8-v5-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "people/yara-johnson-8",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/eric-martinez-93",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/david-kim-186",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/eric-martinez-93",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/david-kim-186",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/floodgate-9",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/pulse-8-v5-inline_code_slug",
      "contributed": true,
      "baseSlug": "companies/pulse-8",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1055",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/floodgate-9",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1055 in inline code + real mention companies/floodgate-9."
      }
    },
    {
      "variantId": "companies/quantum-7-v6-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "people/ulrich-johnson-7",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/kate-anderson-107",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/noah-williams-198",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/kate-anderson-107",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/ulrich-johnson-7",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/rosa-nakamura-94",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/quantum-7-v6-inline_code_slug",
      "contributed": true,
      "baseSlug": "companies/quantum-7",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1056",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "people/rosa-nakamura-94",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1056 in inline code + real mention people/rosa-nakamura-94."
      }
    },
    {
      "variantId": "companies/quasar-44-v7-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "people/mark-wilson-44",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/jack-davis-89",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/grace-singh-197",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/jack-davis-89",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/chris-singh-96",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/quasar-44-v7-inline_code_slug",
      "contributed": true,
      "baseSlug": "companies/quasar-44",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1057",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "people/chris-singh-96",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1057 in inline code + real mention people/chris-singh-96."
      }
    },
    {
      "variantId": "companies/resonance-45-v8-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "people/grace-thomas-45",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/yara-singh-195",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/yara-singh-195",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/grace-thomas-45",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/chris-singh-96",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/resonance-45-v8-inline_code_slug",
      "contributed": true,
      "baseSlug": "companies/resonance-45",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1058",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "people/chris-singh-96",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1058 in inline code + real mention people/chris-singh-96."
      }
    },
    {
      "variantId": "companies/sequoia-capital-1-v9-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/andreessen-horowitz",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/y-combinator",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/andreessen-horowitz",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/y-combinator",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/vellum-49",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/sequoia-capital-1-v9-inline_code_slug",
      "contributed": true,
      "baseSlug": "companies/sequoia-capital-1",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1059",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/vellum-49",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1059 in inline code + real mention companies/vellum-49."
      }
    },
    {
      "variantId": "companies/talon-47-v10-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "people/diana-thomas-47",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/sarah-williams-92",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/david-kim-186",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/noah-williams-198",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/sarah-williams-92",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/noah-williams-198",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/rosa-miller-98",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/talon-47-v10-inline_code_slug",
      "contributed": true,
      "baseSlug": "companies/talon-47",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1060",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "people/rosa-miller-98",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1060 in inline code + real mention people/rosa-miller-98."
      }
    },
    {
      "variantId": "companies/tessera-15-v11-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "people/noah-kapoor-15",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/kate-lopez-99",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/yara-singh-195",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/paul-rodriguez-4",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/tessera-15-v11-inline_code_slug",
      "contributed": true,
      "baseSlug": "companies/tessera-15",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1061",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "people/paul-rodriguez-4",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1061 in inline code + real mention people/paul-rodriguez-4."
      }
    },
    {
      "variantId": "companies/vector-6-v12-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "people/uma-brown-6",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/david-zhang-83",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/vera-gonzalez-103",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/grace-martinez-109",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/wendy-wilson-170",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/bob-chen-185",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/david-zhang-83",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/grace-martinez-109",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/rachel-garcia-9",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/vector-6-v12-inline_code_slug",
      "contributed": true,
      "baseSlug": "companies/vector-6",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1062",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "people/rachel-garcia-9",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1062 in inline code + real mention people/rachel-garcia-9."
      }
    },
    {
      "variantId": "companies/vellum-49-v13-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "people/chris-davis-49",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/rosa-miller-98",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/rachel-gonzalez-175",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/rosa-miller-98",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/epsilon-4",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/vellum-49-v13-inline_code_slug",
      "contributed": true,
      "baseSlug": "companies/vellum-49",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1063",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/epsilon-4",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1063 in inline code + real mention companies/epsilon-4."
      }
    },
    {
      "variantId": "companies/wisp-26-v14-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "people/linda-kim-26",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/linda-kim-26",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/vera-wilson-25",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/wisp-26-v14-inline_code_slug",
      "contributed": true,
      "baseSlug": "companies/wisp-26",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1064",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "people/vera-wilson-25",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1064 in inline code + real mention people/vera-wilson-25."
      }
    },
    {
      "variantId": "people/adam-lee-19-v15-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/forge-19",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/forge-19",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/forge-19",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/noah-kapoor-15",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/adam-lee-19-v15-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/adam-lee-19",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1065",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "people/noah-kapoor-15",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1065 in inline code + real mention people/noah-kapoor-15."
      }
    },
    {
      "variantId": "people/alice-davis-172-v16-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/prism-43",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/orbit-labs-92",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/gust-34",
          "linkType": "advises"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/alice-davis-172-v16-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/alice-davis-172",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1066",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/gust-34",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1066 in inline code + real mention companies/gust-34."
      }
    },
    {
      "variantId": "people/carol-jackson-81-v17-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/sequoia-capital-1",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/prism-43",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/beacon-labs-60",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/foundry-labs-83",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/keel-38",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/pulse-labs-58",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/beacon-labs-60",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/keel-38",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/brink-29",
          "linkType": "invested_in"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/carol-jackson-81-v17-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/carol-jackson-81",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1067",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/brink-29",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1067 in inline code + real mention companies/brink-29."
      }
    },
    {
      "variantId": "people/chris-jackson-91-v18-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/initialized-11",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/meridian-40",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/gravity-17",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/acme-0",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/lucid-labs-71",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/initialized-11",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/lucid-labs-71",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/acme-0",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/sequoia-capital-1",
          "linkType": "invested_in"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/chris-jackson-91-v18-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/chris-jackson-91",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1068",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/sequoia-capital-1",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1068 in inline code + real mention companies/sequoia-capital-1."
      }
    },
    {
      "variantId": "people/chris-smith-110-v19-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/acme-0",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/tara-jackson-173",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/chris-smith-110-v19-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/chris-smith-110",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1069",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "people/tara-jackson-173",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1069 in inline code + real mention people/tara-jackson-173."
      }
    },
    {
      "variantId": "people/david-wang-10-v20-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/beacon-10",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/beacon-10",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/steve-liu-34",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/david-wang-10-v20-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/david-wang-10",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1070",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "people/steve-liu-34",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1070 in inline code + real mention people/steve-liu-34."
      }
    },
    {
      "variantId": "people/eric-lee-21-v21-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/lucid-21",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/lucid-21",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/lucid-21",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/linda-taylor-178",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/eric-lee-21-v21-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/eric-lee-21",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1071",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "people/linda-taylor-178",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1071 in inline code + real mention people/linda-taylor-178."
      }
    },
    {
      "variantId": "people/eric-miller-35-v22-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/hatch-35",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/hatch-35",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/drift-31",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/eric-miller-35-v22-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/eric-miller-35",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1072",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/drift-31",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1072 in inline code + real mention companies/drift-31."
      }
    },
    {
      "variantId": "people/frank-hernandez-31-v23-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/drift-31",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/drift-31",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/carol-wilson-28",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/frank-hernandez-31-v23-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/frank-hernandez-31",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1073",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "people/carol-wilson-28",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1073 in inline code + real mention people/carol-wilson-28."
      }
    },
    {
      "variantId": "people/helen-martinez-87-v24-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/index-ventures-7",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/acme-labs-50",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/nexus-labs-91",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/ranger-22",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/mosaic-14",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/echo-32",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/ranger-22",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/echo-32",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/beth-williams-177",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/helen-martinez-87-v24-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/helen-martinez-87",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1074",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "people/beth-williams-177",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1074 in inline code + real mention people/beth-williams-177."
      }
    },
    {
      "variantId": "people/ian-davis-33-v25-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/foundry-33",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/foundry-33",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/mia-park-36",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/ian-davis-33-v25-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/ian-davis-33",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1075",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "people/mia-park-36",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1075 in inline code + real mention people/mia-park-36."
      }
    },
    {
      "variantId": "people/jack-davis-89-v26-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/floodgate-9",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/lumen-labs-62",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/drift-31",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/beta-labs-51",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/iris-36",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/quasar-44",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/beta-labs-51",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/floodgate-9",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/zenith-27",
          "linkType": "invested_in"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/jack-davis-89-v26-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/jack-davis-89",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1076",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/zenith-27",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1076 in inline code + real mention companies/zenith-27."
      }
    },
    {
      "variantId": "people/julia-johnson-114-v27-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/epsilon-4",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/epsilon-4",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/ulrich-wang-16",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/julia-johnson-114-v27-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/julia-johnson-114",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1077",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "people/ulrich-wang-16",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1077 in inline code + real mention people/ulrich-wang-16."
      }
    },
    {
      "variantId": "people/linda-kim-26-v28-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/wisp-26",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/wisp-26",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/uma-brown-6",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/linda-kim-26-v28-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/linda-kim-26",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1078",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "people/uma-brown-6",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1078 in inline code + real mention people/uma-brown-6."
      }
    },
    {
      "variantId": "people/mark-jones-2-v29-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/gamma-2",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/gamma-2",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/index-ventures-7",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/mark-jones-2-v29-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/mark-jones-2",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1079",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/index-ventures-7",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1079 in inline code + real mention companies/index-ventures-7."
      }
    },
    {
      "variantId": "people/mia-anderson-5-v30-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/nimbus-5",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/nimbus-5",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/nimbus-5",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/victor-wilson-3",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/mia-anderson-5-v30-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/mia-anderson-5",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1080",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "people/victor-wilson-3",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1080 in inline code + real mention people/victor-wilson-3."
      }
    },
    {
      "variantId": "people/mia-lee-13-v31-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/cipher-13",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/cipher-13",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/acme-0",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/mia-lee-13-v31-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/mia-lee-13",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1081",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/acme-0",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1081 in inline code + real mention companies/acme-0."
      }
    },
    {
      "variantId": "people/nina-rodriguez-18-v32-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/apex-18",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/apex-18",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/carol-wilson-28",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/nina-rodriguez-18-v32-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/nina-rodriguez-18",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1082",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "people/carol-wilson-28",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1082 in inline code + real mention people/carol-wilson-28."
      }
    },
    {
      "variantId": "people/olivia-miller-176-v33-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/epsilon-4",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/prism-43",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/echo-labs-82",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/mantle-labs-66",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/prism-43",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/echo-labs-82",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/epsilon-4",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/adam-lee-19",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/olivia-miller-176-v33-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/olivia-miller-176",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1083",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "people/adam-lee-19",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1083 in inline code + real mention people/adam-lee-19."
      }
    },
    {
      "variantId": "people/paul-rodriguez-4-v34-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/epsilon-4",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/epsilon-4",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/compass-11",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/paul-rodriguez-4-v34-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/paul-rodriguez-4",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1084",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/compass-11",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1084 in inline code + real mention companies/compass-11."
      }
    },
    {
      "variantId": "people/priya-zhang-27-v35-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/zenith-27",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/zenith-27",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/mosaic-14",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/priya-zhang-27-v35-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/priya-zhang-27",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1085",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/mosaic-14",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1085 in inline code + real mention companies/mosaic-14."
      }
    },
    {
      "variantId": "people/quinn-park-119-v36-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/helix-9",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/wisp-26",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/iris-36",
          "linkType": "works_at"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/quinn-park-119-v36-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/quinn-park-119",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1086",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/iris-36",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1086 in inline code + real mention companies/iris-36."
      }
    },
    {
      "variantId": "people/quinten-nakamura-115-v37-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/nimbus-5",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/nimbus-5",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/adam-lee-19",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/quinten-nakamura-115-v37-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/quinten-nakamura-115",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1087",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "people/adam-lee-19",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1087 in inline code + real mention people/adam-lee-19."
      }
    },
    {
      "variantId": "people/quinten-wang-17-v38-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/gravity-17",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/gravity-17",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/acme-labs-50",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/quinten-wang-17-v38-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/quinten-wang-17",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1088",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/acme-labs-50",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1088 in inline code + real mention companies/acme-labs-50."
      }
    },
    {
      "variantId": "people/rachel-garcia-9-v39-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/helix-9",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/helix-9",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/pulse-labs-58",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/rachel-garcia-9-v39-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/rachel-garcia-9",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1089",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/pulse-labs-58",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1089 in inline code + real mention companies/pulse-labs-58."
      }
    },
    {
      "variantId": "people/rosa-jackson-90-v40-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/first-round-10",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/keel-labs-88",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/pulse-labs-58",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/gust-labs-84",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/prism-43",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/prism-43",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/first-round-10",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/acme-labs-50",
          "linkType": "invested_in"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/rosa-jackson-90-v40-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/rosa-jackson-90",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1090",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/acme-labs-50",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1090 in inline code + real mention companies/acme-labs-50."
      }
    },
    {
      "variantId": "people/rosa-nakamura-94-v41-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/kleiner-perkins-14",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/spire-46",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/gravity-17",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/mantle-labs-66",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/compass-labs-61",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/wisp-labs-76",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/chris-singh-96",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/rosa-nakamura-94-v41-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/rosa-nakamura-94",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1091",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "people/chris-singh-96",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1091 in inline code + real mention people/chris-singh-96."
      }
    },
    {
      "variantId": "people/sarah-williams-92-v42-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/bessemer-12",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/anchor-28",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/epsilon-4",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/talon-47",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/kindle-labs-70",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/chris-singh-96",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/sarah-williams-92-v42-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/sarah-williams-92",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1092",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "people/chris-singh-96",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1092 in inline code + real mention people/chris-singh-96."
      }
    },
    {
      "variantId": "people/steve-williams-38-v43-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/keel-38",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/keel-38",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/floodgate-9",
          "linkType": "invested_in"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/steve-williams-38-v43-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/steve-williams-38",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1093",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/floodgate-9",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1093 in inline code + real mention companies/floodgate-9."
      }
    },
    {
      "variantId": "people/tara-kapoor-111-v44-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/beta-1",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/apex-18",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/apex-18",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/helix-labs-59",
          "linkType": "works_at"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/tara-kapoor-111-v44-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/tara-kapoor-111",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1094",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/helix-labs-59",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1094 in inline code + real mention companies/helix-labs-59."
      }
    },
    {
      "variantId": "people/tina-jones-112-v45-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/gamma-2",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/forge-19",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/mark-thomas-11",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/tina-jones-112-v45-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/tina-jones-112",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1095",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "people/mark-thomas-11",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1095 in inline code + real mention people/mark-thomas-11."
      }
    },
    {
      "variantId": "people/tina-wang-179-v46-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/cascade-labs-80",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/cipher-labs-63",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/apex-18",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/gravity-17",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/apex-18",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/cipher-labs-63",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/david-zhang-83",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/tina-wang-179-v46-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/tina-wang-179",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1096",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "people/david-zhang-83",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1096 in inline code + real mention people/david-zhang-83."
      }
    },
    {
      "variantId": "people/ulrich-wang-16-v47-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/mantle-16",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/mantle-16",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/tina-lopez-117",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/ulrich-wang-16-v47-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/ulrich-wang-16",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1097",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "people/tina-lopez-117",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1097 in inline code + real mention people/tina-lopez-117."
      }
    },
    {
      "variantId": "people/uma-gonzalez-29-v48-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/brink-29",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/brink-29",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/andreessen-horowitz-2",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/uma-gonzalez-29-v48-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/uma-gonzalez-29",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1098",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/andreessen-horowitz-2",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1098 in inline code + real mention companies/andreessen-horowitz-2."
      }
    },
    {
      "variantId": "people/vera-rodriguez-171-v49-inline_code_slug",
      "kind": "inline_code_slug",
      "extracted": [
        {
          "targetSlug": "companies/lucid-21",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/umbra-48",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/eric-martinez-93",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/vera-rodriguez-171-v49-inline_code_slug",
      "contributed": true,
      "baseSlug": "people/vera-rodriguez-171",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/inline-fake-1099",
            "reason": "inline_code_slug: slug wrapped in single-backtick inline code"
          }
        ],
        "must_extract": [
          {
            "slug": "people/eric-martinez-93",
            "type": "mentions",
            "reason": "inline_code_slug: real mention outside inline code"
          }
        ],
        "note": "Injected fake slug people/inline-fake-1099 in inline code + real mention people/eric-martinez-93."
      }
    },
    {
      "variantId": "people/ian-davis-33-v0-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/foundry-33",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/foundry-33",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/priya-taylor-85",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/rachel-gonzalez-175-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/ian-davis-33-v0-substring_collision",
      "contributed": true,
      "baseSlug": "people/ian-davis-33",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/rachel-gonzalez-175",
            "reason": "substring_collision: prose word \"RachelAI\" contains the name of people/rachel-gonzalez-175, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "people/priya-taylor-85",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"RachelAI\" (forbidden: people/rachel-gonzalez-175) near real mention people/priya-taylor-85."
      }
    },
    {
      "variantId": "people/jack-davis-89-v1-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/floodgate-9",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/lumen-labs-62",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/drift-31",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/beta-labs-51",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/iris-36",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/quasar-44",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/beta-labs-51",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/floodgate-9",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/lucid-21",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/quinten-lee-24-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/jack-davis-89-v1-substring_collision",
      "contributed": true,
      "baseSlug": "people/jack-davis-89",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/quinten-lee-24",
            "reason": "substring_collision: prose word \"QuintenAI\" contains the name of people/quinten-lee-24, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/lucid-21",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"QuintenAI\" (forbidden: people/quinten-lee-24) near real mention companies/lucid-21."
      }
    },
    {
      "variantId": "people/julia-johnson-114-v2-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/epsilon-4",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/epsilon-4",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/meta-2",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/tara-kapoor-111-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/julia-johnson-114-v2-substring_collision",
      "contributed": true,
      "baseSlug": "people/julia-johnson-114",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/tara-kapoor-111",
            "reason": "substring_collision: prose word \"TaraAI\" contains the name of people/tara-kapoor-111, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/meta-2",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"TaraAI\" (forbidden: people/tara-kapoor-111) near real mention companies/meta-2."
      }
    },
    {
      "variantId": "people/linda-kim-26-v3-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/wisp-26",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/wisp-26",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/kate-lopez-99",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/foundry-33-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/linda-kim-26-v3-substring_collision",
      "contributed": true,
      "baseSlug": "people/linda-kim-26",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "companies/foundry-33",
            "reason": "substring_collision: prose word \"FoundryAI\" contains the name of companies/foundry-33, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "people/kate-lopez-99",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"FoundryAI\" (forbidden: companies/foundry-33) near real mention people/kate-lopez-99."
      }
    },
    {
      "variantId": "people/mark-jones-2-v4-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/gamma-2",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/gamma-2",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/anchor-28",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/apex-18-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/mark-jones-2-v4-substring_collision",
      "contributed": true,
      "baseSlug": "people/mark-jones-2",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "companies/apex-18",
            "reason": "substring_collision: prose word \"ApexAI\" contains the name of companies/apex-18, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/anchor-28",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"ApexAI\" (forbidden: companies/apex-18) near real mention companies/anchor-28."
      }
    },
    {
      "variantId": "people/mia-anderson-5-v5-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/nimbus-5",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/nimbus-5",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/nimbus-5",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/umbra-48",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/sequoia-capital-1-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/mia-anderson-5-v5-substring_collision",
      "contributed": true,
      "baseSlug": "people/mia-anderson-5",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "companies/sequoia-capital-1",
            "reason": "substring_collision: prose word \"SequoiaAI\" contains the name of companies/sequoia-capital-1, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/umbra-48",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"SequoiaAI\" (forbidden: companies/sequoia-capital-1) near real mention companies/umbra-48."
      }
    },
    {
      "variantId": "people/mia-lee-13-v6-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/cipher-13",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/cipher-13",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/apex-18",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/quinten-nakamura-115-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/mia-lee-13-v6-substring_collision",
      "contributed": true,
      "baseSlug": "people/mia-lee-13",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/quinten-nakamura-115",
            "reason": "substring_collision: prose word \"QuintenAI\" contains the name of people/quinten-nakamura-115, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/apex-18",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"QuintenAI\" (forbidden: people/quinten-nakamura-115) near real mention companies/apex-18."
      }
    },
    {
      "variantId": "people/nina-rodriguez-18-v7-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/apex-18",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/apex-18",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/andreessen-horowitz-2",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/quinten-rodriguez-22-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/nina-rodriguez-18-v7-substring_collision",
      "contributed": true,
      "baseSlug": "people/nina-rodriguez-18",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/quinten-rodriguez-22",
            "reason": "substring_collision: prose word \"QuintenAI\" contains the name of people/quinten-rodriguez-22, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/andreessen-horowitz-2",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"QuintenAI\" (forbidden: people/quinten-rodriguez-22) near real mention companies/andreessen-horowitz-2."
      }
    },
    {
      "variantId": "people/olivia-miller-176-v8-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/epsilon-4",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/prism-43",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/echo-labs-82",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/mantle-labs-66",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/prism-43",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/echo-labs-82",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/epsilon-4",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/vera-wilson-25",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/lattice-39-ai",
          "linkType": "invested_in"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/olivia-miller-176-v8-substring_collision",
      "contributed": true,
      "baseSlug": "people/olivia-miller-176",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "companies/lattice-39",
            "reason": "substring_collision: prose word \"LatticeAI\" contains the name of companies/lattice-39, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "people/vera-wilson-25",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"LatticeAI\" (forbidden: companies/lattice-39) near real mention people/vera-wilson-25."
      }
    },
    {
      "variantId": "people/paul-rodriguez-4-v9-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/epsilon-4",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/epsilon-4",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/andreessen-horowitz-2",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/resonance-45-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/paul-rodriguez-4-v9-substring_collision",
      "contributed": true,
      "baseSlug": "people/paul-rodriguez-4",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "companies/resonance-45",
            "reason": "substring_collision: prose word \"ResonanceAI\" contains the name of companies/resonance-45, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/andreessen-horowitz-2",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"ResonanceAI\" (forbidden: companies/resonance-45) near real mention companies/andreessen-horowitz-2."
      }
    },
    {
      "variantId": "people/priya-zhang-27-v10-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/zenith-27",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/zenith-27",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/tara-kapoor-111",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/quinten-wang-17-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/priya-zhang-27-v10-substring_collision",
      "contributed": true,
      "baseSlug": "people/priya-zhang-27",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/quinten-wang-17",
            "reason": "substring_collision: prose word \"QuintenAI\" contains the name of people/quinten-wang-17, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "people/tara-kapoor-111",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"QuintenAI\" (forbidden: people/quinten-wang-17) near real mention people/tara-kapoor-111."
      }
    },
    {
      "variantId": "people/quinn-park-119-v11-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/helix-9",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/wisp-26",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/quinten-nakamura-115",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/vera-singh-20-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/quinn-park-119-v11-substring_collision",
      "contributed": true,
      "baseSlug": "people/quinn-park-119",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/vera-singh-20",
            "reason": "substring_collision: prose word \"VeraAI\" contains the name of people/vera-singh-20, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "people/quinten-nakamura-115",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"VeraAI\" (forbidden: people/vera-singh-20) near real mention people/quinten-nakamura-115."
      }
    },
    {
      "variantId": "people/quinten-nakamura-115-v12-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/nimbus-5",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/nimbus-5",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/beacon-10",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/victor-jackson-116-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/quinten-nakamura-115-v12-substring_collision",
      "contributed": true,
      "baseSlug": "people/quinten-nakamura-115",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/victor-jackson-116",
            "reason": "substring_collision: prose word \"VictorAI\" contains the name of people/victor-jackson-116, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/beacon-10",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"VictorAI\" (forbidden: people/victor-jackson-116) near real mention companies/beacon-10."
      }
    },
    {
      "variantId": "people/quinten-wang-17-v13-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/gravity-17",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/gravity-17",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/xavier-nakamura-118",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/ulrich-wang-16-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/quinten-wang-17-v13-substring_collision",
      "contributed": true,
      "baseSlug": "people/quinten-wang-17",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/ulrich-wang-16",
            "reason": "substring_collision: prose word \"UlrichAI\" contains the name of people/ulrich-wang-16, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "people/xavier-nakamura-118",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"UlrichAI\" (forbidden: people/ulrich-wang-16) near real mention people/xavier-nakamura-118."
      }
    },
    {
      "variantId": "people/rachel-garcia-9-v14-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/helix-9",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/helix-9",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/quantum-labs-57",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/chris-jackson-91-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/rachel-garcia-9-v14-substring_collision",
      "contributed": true,
      "baseSlug": "people/rachel-garcia-9",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/chris-jackson-91",
            "reason": "substring_collision: prose word \"ChrisAI\" contains the name of people/chris-jackson-91, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/quantum-labs-57",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"ChrisAI\" (forbidden: people/chris-jackson-91) near real mention companies/quantum-labs-57."
      }
    },
    {
      "variantId": "people/rosa-jackson-90-v15-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/first-round-10",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/keel-labs-88",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/pulse-labs-58",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/gust-labs-84",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/prism-43",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/prism-43",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/first-round-10",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/vellum-49",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/linda-taylor-178-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/rosa-jackson-90-v15-substring_collision",
      "contributed": true,
      "baseSlug": "people/rosa-jackson-90",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/linda-taylor-178",
            "reason": "substring_collision: prose word \"LindaAI\" contains the name of people/linda-taylor-178, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/vellum-49",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"LindaAI\" (forbidden: people/linda-taylor-178) near real mention companies/vellum-49."
      }
    },
    {
      "variantId": "people/rosa-nakamura-94-v16-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/kleiner-perkins-14",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/spire-46",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/gravity-17",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/mantle-labs-66",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/compass-labs-61",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/wisp-labs-76",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/helix-labs-59",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/apex-18-ai",
          "linkType": "invested_in"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/rosa-nakamura-94-v16-substring_collision",
      "contributed": true,
      "baseSlug": "people/rosa-nakamura-94",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "companies/apex-18",
            "reason": "substring_collision: prose word \"ApexAI\" contains the name of companies/apex-18, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/helix-labs-59",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"ApexAI\" (forbidden: companies/apex-18) near real mention companies/helix-labs-59."
      }
    },
    {
      "variantId": "people/sarah-williams-92-v17-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/bessemer-12",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/anchor-28",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/epsilon-4",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/talon-47",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/kindle-labs-70",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/rachel-garcia-9",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/uma-brown-6-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/sarah-williams-92-v17-substring_collision",
      "contributed": true,
      "baseSlug": "people/sarah-williams-92",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/uma-brown-6",
            "reason": "substring_collision: prose word \"UmaAI\" contains the name of people/uma-brown-6, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "people/rachel-garcia-9",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"UmaAI\" (forbidden: people/uma-brown-6) near real mention people/rachel-garcia-9."
      }
    },
    {
      "variantId": "people/steve-williams-38-v18-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/keel-38",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/keel-38",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/pulse-labs-58",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/zenith-27-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/steve-williams-38-v18-substring_collision",
      "contributed": true,
      "baseSlug": "people/steve-williams-38",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "companies/zenith-27",
            "reason": "substring_collision: prose word \"ZenithAI\" contains the name of companies/zenith-27, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/pulse-labs-58",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"ZenithAI\" (forbidden: companies/zenith-27) near real mention companies/pulse-labs-58."
      }
    },
    {
      "variantId": "people/tara-kapoor-111-v19-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/beta-1",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/apex-18",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/apex-18",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/priya-zhang-27",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/tempo-24-ai",
          "linkType": "works_at"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/tara-kapoor-111-v19-substring_collision",
      "contributed": true,
      "baseSlug": "people/tara-kapoor-111",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "companies/tempo-24",
            "reason": "substring_collision: prose word \"TempoAI\" contains the name of companies/tempo-24, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "people/priya-zhang-27",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"TempoAI\" (forbidden: companies/tempo-24) near real mention people/priya-zhang-27."
      }
    },
    {
      "variantId": "people/tina-jones-112-v20-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/gamma-2",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/forge-19",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/helen-johnson-32",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/rosa-nakamura-94-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/tina-jones-112-v20-substring_collision",
      "contributed": true,
      "baseSlug": "people/tina-jones-112",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/rosa-nakamura-94",
            "reason": "substring_collision: prose word \"RosaAI\" contains the name of people/rosa-nakamura-94, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "people/helen-johnson-32",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"RosaAI\" (forbidden: people/rosa-nakamura-94) near real mention people/helen-johnson-32."
      }
    },
    {
      "variantId": "people/tina-wang-179-v21-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/cascade-labs-80",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/cipher-labs-63",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/apex-18",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/gravity-17",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/apex-18",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/cipher-labs-63",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/microsoft-0",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/prism-43-ai",
          "linkType": "invested_in"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/tina-wang-179-v21-substring_collision",
      "contributed": true,
      "baseSlug": "people/tina-wang-179",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "companies/prism-43",
            "reason": "substring_collision: prose word \"PrismAI\" contains the name of companies/prism-43, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/microsoft-0",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"PrismAI\" (forbidden: companies/prism-43) near real mention companies/microsoft-0."
      }
    },
    {
      "variantId": "people/ulrich-wang-16-v22-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/mantle-16",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/mantle-16",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/sentinel-23",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/eric-miller-35-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/ulrich-wang-16-v22-substring_collision",
      "contributed": true,
      "baseSlug": "people/ulrich-wang-16",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/eric-miller-35",
            "reason": "substring_collision: prose word \"EricAI\" contains the name of people/eric-miller-35, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/sentinel-23",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"EricAI\" (forbidden: people/eric-miller-35) near real mention companies/sentinel-23."
      }
    },
    {
      "variantId": "people/uma-gonzalez-29-v23-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/brink-29",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/brink-29",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/echo-32",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/benchmark-3-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/uma-gonzalez-29-v23-substring_collision",
      "contributed": true,
      "baseSlug": "people/uma-gonzalez-29",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "companies/benchmark-3",
            "reason": "substring_collision: prose word \"BenchmarkAI\" contains the name of companies/benchmark-3, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/echo-32",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"BenchmarkAI\" (forbidden: companies/benchmark-3) near real mention companies/echo-32."
      }
    },
    {
      "variantId": "people/vera-rodriguez-171-v24-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/lucid-21",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/umbra-48",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/uma-brown-6",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/eric-miller-35-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/vera-rodriguez-171-v24-substring_collision",
      "contributed": true,
      "baseSlug": "people/vera-rodriguez-171",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/eric-miller-35",
            "reason": "substring_collision: prose word \"EricAI\" contains the name of people/eric-miller-35, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "people/uma-brown-6",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"EricAI\" (forbidden: people/eric-miller-35) near real mention people/uma-brown-6."
      }
    },
    {
      "variantId": "people/vera-wilson-25-v25-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/vox-25",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/vox-25",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/microsoft-0",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/compass-11-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/vera-wilson-25-v25-substring_collision",
      "contributed": true,
      "baseSlug": "people/vera-wilson-25",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "companies/compass-11",
            "reason": "substring_collision: prose word \"CompassAI\" contains the name of companies/compass-11, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/microsoft-0",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"CompassAI\" (forbidden: companies/compass-11) near real mention companies/microsoft-0."
      }
    },
    {
      "variantId": "people/victor-taylor-1-v26-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/beta-1",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/beta-1",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/vox-25",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/hatch-35-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/victor-taylor-1-v26-substring_collision",
      "contributed": true,
      "baseSlug": "people/victor-taylor-1",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "companies/hatch-35",
            "reason": "substring_collision: prose word \"HatchAI\" contains the name of companies/hatch-35, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/vox-25",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"HatchAI\" (forbidden: companies/hatch-35) near real mention companies/vox-25."
      }
    },
    {
      "variantId": "people/wendy-hernandez-80-v27-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/founders-fund-0",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/cipher-labs-63",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/drift-31",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/spire-46",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/delta-labs-53",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/vellum-labs-99",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/kate-lopez-99",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/epsilon-4-ai",
          "linkType": "invested_in"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/wendy-hernandez-80-v27-substring_collision",
      "contributed": true,
      "baseSlug": "people/wendy-hernandez-80",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "companies/epsilon-4",
            "reason": "substring_collision: prose word \"EpsilonAI\" contains the name of companies/epsilon-4, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "people/kate-lopez-99",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"EpsilonAI\" (forbidden: companies/epsilon-4) near real mention people/kate-lopez-99."
      }
    },
    {
      "variantId": "people/xavier-nakamura-118-v28-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/pulse-8",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/vox-25",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/ulrich-johnson-7",
          "linkType": "mentions"
        },
        {
          "targetSlug": "pub/sub",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/mia-park-36-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/xavier-nakamura-118-v28-substring_collision",
      "contributed": true,
      "baseSlug": "people/xavier-nakamura-118",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/mia-park-36",
            "reason": "substring_collision: prose word \"MiaAI\" contains the name of people/mia-park-36, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "people/ulrich-johnson-7",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"MiaAI\" (forbidden: people/mia-park-36) near real mention people/ulrich-johnson-7."
      }
    },
    {
      "variantId": "people/yara-moore-174-v29-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/tessera-labs-65",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/vector-labs-56",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/tempo-24",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/jolt-37",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/index-ventures-7-ai",
          "linkType": "advises"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/yara-moore-174-v29-substring_collision",
      "contributed": true,
      "baseSlug": "people/yara-moore-174",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "companies/index-ventures-7",
            "reason": "substring_collision: prose word \"IndexAI\" contains the name of companies/index-ventures-7, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/jolt-37",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"IndexAI\" (forbidden: companies/index-ventures-7) near real mention companies/jolt-37."
      }
    },
    {
      "variantId": "companies/accel-5-v30-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/y-combinator",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/a16z",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/a16z",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/epsilon-labs-54",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/sequoia-capital-1-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/accel-5-v30-substring_collision",
      "contributed": true,
      "baseSlug": "companies/accel-5",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "companies/sequoia-capital-1",
            "reason": "substring_collision: prose word \"SequoiaAI\" contains the name of companies/sequoia-capital-1, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/epsilon-labs-54",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"SequoiaAI\" (forbidden: companies/sequoia-capital-1) near real mention companies/epsilon-labs-54."
      }
    },
    {
      "variantId": "companies/acme-labs-50-v31-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "people/ian-kim-50",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/helen-martinez-87",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/wendy-wilson-170",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/helen-martinez-87",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/victor-wilson-3",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/floodgate-9-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/acme-labs-50-v31-substring_collision",
      "contributed": true,
      "baseSlug": "companies/acme-labs-50",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "companies/floodgate-9",
            "reason": "substring_collision: prose word \"FloodgateAI\" contains the name of companies/floodgate-9, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "people/victor-wilson-3",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"FloodgateAI\" (forbidden: companies/floodgate-9) near real mention people/victor-wilson-3."
      }
    },
    {
      "variantId": "companies/anchor-28-v32-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "people/carol-wilson-28",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/sarah-williams-92",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/kate-anderson-107",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/mia-brown-0",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/adam-lee-19-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/anchor-28-v32-substring_collision",
      "contributed": true,
      "baseSlug": "companies/anchor-28",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/adam-lee-19",
            "reason": "substring_collision: prose word \"AdamAI\" contains the name of people/adam-lee-19, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "people/mia-brown-0",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"AdamAI\" (forbidden: people/adam-lee-19) near real mention people/mia-brown-0."
      }
    },
    {
      "variantId": "companies/apex-18-v33-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "people/nina-rodriguez-18",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/priya-taylor-85",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/kevin-taylor-102",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/tina-wang-179",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/yara-singh-195",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/kevin-taylor-102",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/tina-wang-179",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/vox-25",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/carol-jackson-81-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/apex-18-v33-substring_collision",
      "contributed": true,
      "baseSlug": "companies/apex-18",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/carol-jackson-81",
            "reason": "substring_collision: prose word \"CarolAI\" contains the name of people/carol-jackson-81, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/vox-25",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"CarolAI\" (forbidden: people/carol-jackson-81) near real mention companies/vox-25."
      }
    },
    {
      "variantId": "companies/beacon-10-v34-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "people/david-wang-10",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/rachel-brown-95",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/julia-chen-181",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/rachel-brown-95",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/julia-chen-181",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/tina-wang-179",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/accel-5-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/beacon-10-v34-substring_collision",
      "contributed": true,
      "baseSlug": "companies/beacon-10",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "companies/accel-5",
            "reason": "substring_collision: prose word \"AccelAI\" contains the name of companies/accel-5, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "people/tina-wang-179",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"AccelAI\" (forbidden: companies/accel-5) near real mention people/tina-wang-179."
      }
    },
    {
      "variantId": "companies/bessemer-12-v35-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/sequoia-capital",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/a16z",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/a16z",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/kate-lopez-99",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/linda-kim-26-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/bessemer-12-v35-substring_collision",
      "contributed": true,
      "baseSlug": "companies/bessemer-12",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/linda-kim-26",
            "reason": "substring_collision: prose word \"LindaAI\" contains the name of people/linda-kim-26, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "people/kate-lopez-99",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"LindaAI\" (forbidden: people/linda-kim-26) near real mention people/kate-lopez-99."
      }
    },
    {
      "variantId": "companies/beta-labs-51-v36-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "people/victor-jones-51",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/jack-davis-89",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/chris-singh-96",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/jack-davis-89",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/chris-singh-96",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/victor-jones-51",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/orbit-42",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/accel-5-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/beta-labs-51-v36-substring_collision",
      "contributed": true,
      "baseSlug": "companies/beta-labs-51",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "companies/accel-5",
            "reason": "substring_collision: prose word \"AccelAI\" contains the name of companies/accel-5, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/orbit-42",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"AccelAI\" (forbidden: companies/accel-5) near real mention companies/orbit-42."
      }
    },
    {
      "variantId": "companies/cascade-30-v37-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "people/yara-smith-30",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/bob-chen-185",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/bob-chen-185",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/yara-smith-30",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/helen-martinez-87",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/uma-brown-6-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/cascade-30-v37-substring_collision",
      "contributed": true,
      "baseSlug": "companies/cascade-30",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/uma-brown-6",
            "reason": "substring_collision: prose word \"UmaAI\" contains the name of people/uma-brown-6, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "people/helen-martinez-87",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"UmaAI\" (forbidden: people/uma-brown-6) near real mention people/helen-martinez-87."
      }
    },
    {
      "variantId": "companies/compass-11-v38-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "people/mark-thomas-11",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/chris-miller-101",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/sam-garcia-188",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/chris-miller-101",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/sam-garcia-188",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/victor-taylor-1",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/brink-29-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/compass-11-v38-substring_collision",
      "contributed": true,
      "baseSlug": "companies/compass-11",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "companies/brink-29",
            "reason": "substring_collision: prose word \"BrinkAI\" contains the name of companies/brink-29, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "people/victor-taylor-1",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"BrinkAI\" (forbidden: companies/brink-29) near real mention people/victor-taylor-1."
      }
    },
    {
      "variantId": "companies/delta-labs-53-v39-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "people/will-garcia-53",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/wendy-hernandez-80",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/tina-hernandez-97",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/wendy-wilson-170",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/grace-singh-197",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/brink-29",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/wisp-26-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/delta-labs-53-v39-substring_collision",
      "contributed": true,
      "baseSlug": "companies/delta-labs-53",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "companies/wisp-26",
            "reason": "substring_collision: prose word \"WispAI\" contains the name of companies/wisp-26, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/brink-29",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"WispAI\" (forbidden: companies/wisp-26) near real mention companies/brink-29."
      }
    },
    {
      "variantId": "companies/echo-32-v40-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "people/helen-johnson-32",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/julia-davis-86",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/helen-martinez-87",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/helen-johnson-32",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/julia-davis-86",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/umbra-48",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/quantum-7-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/echo-32-v40-substring_collision",
      "contributed": true,
      "baseSlug": "companies/echo-32",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "companies/quantum-7",
            "reason": "substring_collision: prose word \"QuantumAI\" contains the name of companies/quantum-7, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/umbra-48",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"QuantumAI\" (forbidden: companies/quantum-7) near real mention companies/umbra-48."
      }
    },
    {
      "variantId": "companies/epsilon-labs-54-v41-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "people/diana-wilson-54",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/iris-lee-82",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/grace-martinez-109",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/zoe-jackson-199",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/grace-martinez-109",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/bessemer-12",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/gust-34-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/epsilon-labs-54-v41-substring_collision",
      "contributed": true,
      "baseSlug": "companies/epsilon-labs-54",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "companies/gust-34",
            "reason": "substring_collision: prose word \"GustAI\" contains the name of companies/gust-34, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/bessemer-12",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"GustAI\" (forbidden: companies/gust-34) near real mention companies/bessemer-12."
      }
    },
    {
      "variantId": "companies/floodgate-9-v42-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/sequoia-capital",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/andreessen-horowitz",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/stripe",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/benchmark-3",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/noah-kapoor-15-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/floodgate-9-v42-substring_collision",
      "contributed": true,
      "baseSlug": "companies/floodgate-9",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/noah-kapoor-15",
            "reason": "substring_collision: prose word \"NoahAI\" contains the name of people/noah-kapoor-15, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/benchmark-3",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"NoahAI\" (forbidden: people/noah-kapoor-15) near real mention companies/benchmark-3."
      }
    },
    {
      "variantId": "companies/founders-fund-0-v43-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/anduril-industries",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/stripe",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/stripe",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/anduril-industries",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/initialized-11",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/meta-2-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/founders-fund-0-v43-substring_collision",
      "contributed": true,
      "baseSlug": "companies/founders-fund-0",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "companies/meta-2",
            "reason": "substring_collision: prose word \"MetaAI\" contains the name of companies/meta-2, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/initialized-11",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"MetaAI\" (forbidden: companies/meta-2) near real mention companies/initialized-11."
      }
    },
    {
      "variantId": "companies/gamma-2-v44-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "people/mark-jones-2",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/vera-gonzalez-103",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/vera-gonzalez-103",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/david-zhang-83",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/anchor-28-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/gamma-2-v44-substring_collision",
      "contributed": true,
      "baseSlug": "companies/gamma-2",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "companies/anchor-28",
            "reason": "substring_collision: prose word \"AnchorAI\" contains the name of companies/anchor-28, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "people/david-zhang-83",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"AnchorAI\" (forbidden: companies/anchor-28) near real mention people/david-zhang-83."
      }
    },
    {
      "variantId": "companies/google-1-v45-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "people/linda-taylor-178",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/bessemer-12-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/google-1-v45-substring_collision",
      "contributed": true,
      "baseSlug": "companies/google-1",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "companies/bessemer-12",
            "reason": "substring_collision: prose word \"BessemerAI\" contains the name of companies/bessemer-12, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "people/linda-taylor-178",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"BessemerAI\" (forbidden: companies/bessemer-12) near real mention people/linda-taylor-178."
      }
    },
    {
      "variantId": "companies/greylock-4-v46-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/sequoia-capital",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/a16z-3",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/quinten-nakamura-115",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/mark-jones-2-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/greylock-4-v46-substring_collision",
      "contributed": true,
      "baseSlug": "companies/greylock-4",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/mark-jones-2",
            "reason": "substring_collision: prose word \"MarkAI\" contains the name of people/mark-jones-2, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "people/quinten-nakamura-115",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"MarkAI\" (forbidden: people/mark-jones-2) near real mention people/quinten-nakamura-115."
      }
    },
    {
      "variantId": "companies/hatch-35-v47-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "people/eric-miller-35",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/steve-martinez-192",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/yara-smith-30",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/ulrich-johnson-7-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/hatch-35-v47-substring_collision",
      "contributed": true,
      "baseSlug": "companies/hatch-35",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/ulrich-johnson-7",
            "reason": "substring_collision: prose word \"UlrichAI\" contains the name of people/ulrich-johnson-7, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "people/yara-smith-30",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"UlrichAI\" (forbidden: people/ulrich-johnson-7) near real mention people/yara-smith-30."
      }
    },
    {
      "variantId": "companies/helix-labs-59-v48-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "people/bob-jackson-59",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/priya-taylor-85",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/julia-davis-86",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/bob-jackson-59",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/kleiner-perkins-14",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/olivia-miller-176-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/helix-labs-59-v48-substring_collision",
      "contributed": true,
      "baseSlug": "companies/helix-labs-59",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "people/olivia-miller-176",
            "reason": "substring_collision: prose word \"OliviaAI\" contains the name of people/olivia-miller-176, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "companies/kleiner-perkins-14",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"OliviaAI\" (forbidden: people/olivia-miller-176) near real mention companies/kleiner-perkins-14."
      }
    },
    {
      "variantId": "companies/initialized-11-v49-substring_collision",
      "kind": "substring_collision",
      "extracted": [
        {
          "targetSlug": "companies/y-combinator",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/floodgate",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/y-combinator",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/tina-wang-179",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/cascade-30-ai",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/initialized-11-v49-substring_collision",
      "contributed": true,
      "baseSlug": "companies/initialized-11",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [
          {
            "slug": "companies/cascade-30",
            "reason": "substring_collision: prose word \"CascadeAI\" contains the name of companies/cascade-30, which is never linked on this page — extracting it means a prose-substring match fired"
          }
        ],
        "must_extract": [
          {
            "slug": "people/tina-wang-179",
            "type": "mentions",
            "reason": "substring_collision: real markdown link should extract"
          }
        ],
        "note": "Injected substring collision \"CascadeAI\" (forbidden: companies/cascade-30) near real mention people/tina-wang-179."
      }
    },
    {
      "variantId": "people/vera-wilson-25-v0-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "companies/vox-25",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/vox-25",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/chris-singh-96",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/vera-wilson-25-v0-ambiguous_role",
      "contributed": true,
      "baseSlug": "people/vera-wilson-25",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/chris-singh-96",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/chris-singh-96 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "people/victor-taylor-1-v1-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "companies/beta-1",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/beta-1",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/rosa-jackson-90",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/victor-taylor-1-v1-ambiguous_role",
      "contributed": true,
      "baseSlug": "people/victor-taylor-1",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/rosa-jackson-90",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/rosa-jackson-90 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "people/wendy-hernandez-80-v2-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "companies/founders-fund-0",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/cipher-labs-63",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/drift-31",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/spire-46",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/delta-labs-53",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/vellum-labs-99",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/paul-rodriguez-4",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/wendy-hernandez-80-v2-ambiguous_role",
      "contributed": true,
      "baseSlug": "people/wendy-hernandez-80",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/paul-rodriguez-4",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/paul-rodriguez-4 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "people/xavier-nakamura-118-v3-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "companies/pulse-8",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/vox-25",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/wendy-hernandez-80",
          "linkType": "mentions"
        },
        {
          "targetSlug": "pub/sub",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/xavier-nakamura-118-v3-ambiguous_role",
      "contributed": true,
      "baseSlug": "people/xavier-nakamura-118",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/wendy-hernandez-80",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/wendy-hernandez-80 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "people/yara-moore-174-v4-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "companies/tessera-labs-65",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/vector-labs-56",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/tempo-24",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/noah-kapoor-15",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/yara-moore-174-v4-ambiguous_role",
      "contributed": true,
      "baseSlug": "people/yara-moore-174",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/noah-kapoor-15",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/noah-kapoor-15 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/accel-5-v5-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "companies/y-combinator",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/a16z",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/a16z",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/quinn-miller-39",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/accel-5-v5-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/accel-5",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/quinn-miller-39",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/quinn-miller-39 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/acme-labs-50-v6-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/ian-kim-50",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/helen-martinez-87",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/wendy-wilson-170",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/helen-martinez-87",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/mia-lee-13",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/acme-labs-50-v6-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/acme-labs-50",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/mia-lee-13",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/mia-lee-13 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/anchor-28-v7-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/carol-wilson-28",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/sarah-williams-92",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/kate-anderson-107",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/fiona-moore-88",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/anchor-28-v7-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/anchor-28",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/fiona-moore-88",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/fiona-moore-88 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/apex-18-v8-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/nina-rodriguez-18",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/priya-taylor-85",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/kevin-taylor-102",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/tina-wang-179",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/yara-singh-195",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/kevin-taylor-102",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/tina-wang-179",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/tina-lopez-117",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/apex-18-v8-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/apex-18",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/tina-lopez-117",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/tina-lopez-117 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/beacon-10-v9-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/david-wang-10",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/rachel-brown-95",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/julia-chen-181",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/rachel-brown-95",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/julia-chen-181",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/rosa-jackson-90",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/beacon-10-v9-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/beacon-10",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/rosa-jackson-90",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/rosa-jackson-90 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/bessemer-12-v10-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "companies/sequoia-capital",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/a16z",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/a16z",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/olivia-miller-176",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/bessemer-12-v10-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/bessemer-12",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/olivia-miller-176",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/olivia-miller-176 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/beta-labs-51-v11-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/victor-jones-51",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/jack-davis-89",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/chris-singh-96",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/jack-davis-89",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/chris-singh-96",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/victor-jones-51",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/quinten-nakamura-115",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/beta-labs-51-v11-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/beta-labs-51",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/quinten-nakamura-115",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/quinten-nakamura-115 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/cascade-30-v12-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/yara-smith-30",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/bob-chen-185",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/bob-chen-185",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/yara-smith-30",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/quinten-wang-17",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/cascade-30-v12-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/cascade-30",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/quinten-wang-17",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/quinten-wang-17 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/compass-11-v13-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/mark-thomas-11",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/chris-miller-101",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/sam-garcia-188",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/chris-miller-101",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/sam-garcia-188",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/tara-jackson-173",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/compass-11-v13-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/compass-11",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/tara-jackson-173",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/tara-jackson-173 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/delta-labs-53-v14-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/will-garcia-53",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/wendy-hernandez-80",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/tina-hernandez-97",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/wendy-wilson-170",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/grace-singh-197",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/priya-zhang-27",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/delta-labs-53-v14-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/delta-labs-53",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/priya-zhang-27",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/priya-zhang-27 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/echo-32-v15-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/helen-johnson-32",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/julia-davis-86",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/helen-martinez-87",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/helen-johnson-32",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/julia-davis-86",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/chris-singh-96",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/echo-32-v15-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/echo-32",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/chris-singh-96",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/chris-singh-96 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/epsilon-labs-54-v16-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/diana-wilson-54",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/iris-lee-82",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/grace-martinez-109",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/zoe-jackson-199",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/grace-martinez-109",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/paul-anderson-23",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/epsilon-labs-54-v16-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/epsilon-labs-54",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/paul-anderson-23",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/paul-anderson-23 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/floodgate-9-v17-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "companies/sequoia-capital",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/andreessen-horowitz",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/stripe",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/yara-moore-174",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/floodgate-9-v17-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/floodgate-9",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/yara-moore-174",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/yara-moore-174 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/founders-fund-0-v18-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "companies/anduril-industries",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/stripe",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/stripe",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/anduril-industries",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/chris-singh-96",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/founders-fund-0-v18-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/founders-fund-0",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/chris-singh-96",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/chris-singh-96 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/gamma-2-v19-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/mark-jones-2",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/vera-gonzalez-103",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/vera-gonzalez-103",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/chris-smith-110",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/gamma-2-v19-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/gamma-2",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/chris-smith-110",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/chris-smith-110 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/google-1-v20-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/nina-rodriguez-18",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/google-1-v20-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/google-1",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/nina-rodriguez-18",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/nina-rodriguez-18 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/greylock-4-v21-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "companies/sequoia-capital",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/a16z-3",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/vera-singh-20",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/greylock-4-v21-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/greylock-4",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/vera-singh-20",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/vera-singh-20 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/hatch-35-v22-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/eric-miller-35",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/steve-martinez-192",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/carol-jackson-81",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/hatch-35-v22-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/hatch-35",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/carol-jackson-81",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/carol-jackson-81 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/helix-labs-59-v23-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/bob-jackson-59",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/priya-taylor-85",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/julia-davis-86",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/bob-jackson-59",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/vera-singh-20",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/helix-labs-59-v23-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/helix-labs-59",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/vera-singh-20",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/vera-singh-20 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/initialized-11-v24-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "companies/y-combinator",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/floodgate",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/y-combinator",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/mark-thomas-11",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/initialized-11-v24-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/initialized-11",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/mark-thomas-11",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/mark-thomas-11 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/jolt-37-v25-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/chris-williams-37",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/tina-hernandez-97",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/chris-miller-101",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/chris-miller-101",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/tina-hernandez-97",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/chris-williams-37",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/quinten-wang-17",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/jolt-37-v25-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/jolt-37",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/quinten-wang-17",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/quinten-wang-17 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/khosla-ventures-8-v26-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "companies/a16z",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/a16z",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/ian-davis-33",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/khosla-ventures-8-v26-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/khosla-ventures-8",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/ian-davis-33",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/ian-davis-33 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/kleiner-perkins-14-v27-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/chris-smith-110",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/kleiner-perkins-14-v27-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/kleiner-perkins-14",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/chris-smith-110",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/chris-smith-110 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/lightspeed-6-v28-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "companies/a16z",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/sequoia",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/beth-williams-177",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/lightspeed-6-v28-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/lightspeed-6",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/beth-williams-177",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/beth-williams-177 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/lumen-12-v29-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/henry-johnson-12",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/kate-lopez-99",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/sarah-wang-104",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/kate-lopez-99",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/sarah-wang-104",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/adam-lopez-113",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/lumen-12-v29-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/lumen-12",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/adam-lopez-113",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/adam-lopez-113 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/meridian-40-v30-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/chris-nakamura-40",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/priya-taylor-85",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/chris-jackson-91",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/vera-gonzalez-103",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/zoe-jackson-199",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/priya-taylor-85",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/chris-jackson-91",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/vera-gonzalez-103",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/rosa-miller-98",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/meridian-40-v30-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/meridian-40",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/rosa-miller-98",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/rosa-miller-98 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/microsoft-0-v31-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/fiona-moore-88",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/microsoft-0-v31-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/microsoft-0",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/fiona-moore-88",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/fiona-moore-88 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/nea-13-v32-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "companies/a16z-9",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/sequoia-capital-6",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/sequoia-capital-6",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/a16z-9",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/rachel-gonzalez-175",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/nea-13-v32-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/nea-13",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/rachel-gonzalez-175",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/rachel-gonzalez-175 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/nimbus-5-v33-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/mia-anderson-5",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/noah-nakamura-182",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/mia-anderson-5",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/noah-nakamura-182",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/tina-jones-112",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/nimbus-5-v33-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/nimbus-5",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/tina-jones-112",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/tina-jones-112 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/orbit-42-v34-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/jack-patel-42",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/julia-davis-86",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/zoe-gonzalez-100",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/julia-davis-86",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/zoe-gonzalez-100",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/paul-anderson-23",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/orbit-42-v34-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/orbit-42",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/paul-anderson-23",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/paul-anderson-23 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/pulse-8-v35-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/yara-johnson-8",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/eric-martinez-93",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/david-kim-186",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/eric-martinez-93",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/david-kim-186",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/victor-jackson-116",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/pulse-8-v35-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/pulse-8",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/victor-jackson-116",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/victor-jackson-116 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/quantum-7-v36-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/ulrich-johnson-7",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/kate-anderson-107",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/noah-williams-198",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/kate-anderson-107",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/ulrich-johnson-7",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/sarah-williams-92",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/quantum-7-v36-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/quantum-7",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/sarah-williams-92",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/sarah-williams-92 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/quasar-44-v37-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/mark-wilson-44",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/jack-davis-89",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/grace-singh-197",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/jack-davis-89",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/carol-jackson-81",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/quasar-44-v37-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/quasar-44",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/carol-jackson-81",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/carol-jackson-81 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/resonance-45-v38-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/grace-thomas-45",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/yara-singh-195",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/yara-singh-195",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/grace-thomas-45",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/linda-kim-26",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/resonance-45-v38-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/resonance-45",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/linda-kim-26",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/linda-kim-26 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/sequoia-capital-1-v39-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "companies/andreessen-horowitz",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/y-combinator",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/andreessen-horowitz",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/y-combinator",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/mia-park-36",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/sequoia-capital-1-v39-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/sequoia-capital-1",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/mia-park-36",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/mia-park-36 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/talon-47-v40-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/diana-thomas-47",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/sarah-williams-92",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/david-kim-186",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/noah-williams-198",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/sarah-williams-92",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/noah-williams-198",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/quinten-rodriguez-22",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/talon-47-v40-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/talon-47",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/quinten-rodriguez-22",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/quinten-rodriguez-22 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/tessera-15-v41-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/noah-kapoor-15",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/kate-lopez-99",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/yara-singh-195",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/priya-zhang-27",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/tessera-15-v41-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/tessera-15",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/priya-zhang-27",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/priya-zhang-27 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/vector-6-v42-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/uma-brown-6",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/david-zhang-83",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/vera-gonzalez-103",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/grace-martinez-109",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/wendy-wilson-170",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/bob-chen-185",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/david-zhang-83",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/grace-martinez-109",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/chris-singh-96",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/vector-6-v42-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/vector-6",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/chris-singh-96",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/chris-singh-96 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/vellum-49-v43-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/chris-davis-49",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/rosa-miller-98",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/rachel-gonzalez-175",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/rosa-miller-98",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/wendy-wilson-170",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/vellum-49-v43-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/vellum-49",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/wendy-wilson-170",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/wendy-wilson-170 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/wisp-26-v44-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "people/linda-kim-26",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/linda-kim-26",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/xavier-nakamura-118",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "companies/wisp-26-v44-ambiguous_role",
      "contributed": true,
      "baseSlug": "companies/wisp-26",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/xavier-nakamura-118",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/xavier-nakamura-118 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "people/adam-lee-19-v45-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "companies/forge-19",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/forge-19",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/forge-19",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/rachel-brown-95",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/adam-lee-19-v45-ambiguous_role",
      "contributed": true,
      "baseSlug": "people/adam-lee-19",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/rachel-brown-95",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/rachel-brown-95 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "people/alice-davis-172-v46-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "companies/prism-43",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/orbit-labs-92",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/priya-taylor-85",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/alice-davis-172-v46-ambiguous_role",
      "contributed": true,
      "baseSlug": "people/alice-davis-172",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/priya-taylor-85",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/priya-taylor-85 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "people/carol-jackson-81-v47-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "companies/sequoia-capital-1",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/prism-43",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/beacon-labs-60",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/foundry-labs-83",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/keel-38",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/pulse-labs-58",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/beacon-labs-60",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/keel-38",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/henry-johnson-12",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/carol-jackson-81-v47-ambiguous_role",
      "contributed": true,
      "baseSlug": "people/carol-jackson-81",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/henry-johnson-12",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/henry-johnson-12 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "people/chris-jackson-91-v48-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "companies/initialized-11",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/meridian-40",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/gravity-17",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/acme-0",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/lucid-labs-71",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/initialized-11",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/lucid-labs-71",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/acme-0",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/rachel-garcia-9",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/chris-jackson-91-v48-ambiguous_role",
      "contributed": true,
      "baseSlug": "people/chris-jackson-91",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/rachel-garcia-9",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/rachel-garcia-9 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "people/chris-smith-110-v49-ambiguous_role",
      "kind": "ambiguous_role",
      "extracted": [
        {
          "targetSlug": "companies/acme-0",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/julia-davis-86",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 1,
      "probe_id": "people/chris-smith-110-v49-ambiguous_role",
      "contributed": true,
      "baseSlug": "people/chris-smith-110",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/julia-davis-86",
            "type": "mentions",
            "enforce_type": true,
            "reason": "ambiguous_role: \"works with\" is loose enough that type must downgrade from works_at to mentions"
          }
        ],
        "note": "Injected \"works with\" phrasing for people/julia-davis-86 (must not upgrade to works_at)."
      }
    },
    {
      "variantId": "companies/jolt-37-v0-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "people/chris-williams-37",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/tina-hernandez-97",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/chris-miller-101",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/chris-miller-101",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/tina-hernandez-97",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/chris-williams-37",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/founders-fund-0",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/vector-6",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/acme-labs-50",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/umbra-48",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/ulrich-wang-16",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "companies/jolt-37-v0-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "companies/jolt-37",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "companies/founders-fund-0",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/vector-6",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/acme-labs-50",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/umbra-48",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/ulrich-wang-16",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: companies/founders-fund-0, companies/vector-6, companies/acme-labs-50, companies/umbra-48, people/ulrich-wang-16."
      }
    },
    {
      "variantId": "companies/khosla-ventures-8-v1-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/a16z",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/a16z",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/epsilon-4",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/fiona-moore-88",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/beth-williams-177",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/iris-36",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/eric-lee-21",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "companies/khosla-ventures-8-v1-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "companies/khosla-ventures-8",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "companies/epsilon-4",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/fiona-moore-88",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/beth-williams-177",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/iris-36",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/eric-lee-21",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: companies/epsilon-4, people/fiona-moore-88, people/beth-williams-177, companies/iris-36, people/eric-lee-21."
      }
    },
    {
      "variantId": "companies/kleiner-perkins-14-v2-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "people/steve-williams-38",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/rachel-brown-95",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/andreessen-horowitz-2",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/helen-martinez-87",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/echo-32",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "companies/kleiner-perkins-14-v2-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "companies/kleiner-perkins-14",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/steve-williams-38",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/rachel-brown-95",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/andreessen-horowitz-2",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/helen-martinez-87",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/echo-32",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: people/steve-williams-38, people/rachel-brown-95, companies/andreessen-horowitz-2, people/helen-martinez-87, companies/echo-32."
      }
    },
    {
      "variantId": "companies/lightspeed-6-v3-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/a16z",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/sequoia",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/talon-47",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/benchmark-3",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/vox-25",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/first-round-10",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/mark-jones-2",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "companies/lightspeed-6-v3-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "companies/lightspeed-6",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "companies/talon-47",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/benchmark-3",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/vox-25",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/first-round-10",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/mark-jones-2",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: companies/talon-47, companies/benchmark-3, companies/vox-25, companies/first-round-10, people/mark-jones-2."
      }
    },
    {
      "variantId": "companies/lumen-12-v4-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "people/henry-johnson-12",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/kate-lopez-99",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/sarah-wang-104",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/kate-lopez-99",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/sarah-wang-104",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/meridian-40",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/linda-taylor-178",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/amazon-3",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/tina-hernandez-97",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/victor-wilson-3",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "companies/lumen-12-v4-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "companies/lumen-12",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "companies/meridian-40",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/linda-taylor-178",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/amazon-3",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/tina-hernandez-97",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/victor-wilson-3",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: companies/meridian-40, people/linda-taylor-178, companies/amazon-3, people/tina-hernandez-97, people/victor-wilson-3."
      }
    },
    {
      "variantId": "companies/meridian-40-v5-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "people/chris-nakamura-40",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/priya-taylor-85",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/chris-jackson-91",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/vera-gonzalez-103",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/zoe-jackson-199",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/priya-taylor-85",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/chris-jackson-91",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/vera-gonzalez-103",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/meta-2",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/chris-williams-37",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/tara-kapoor-111",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/andreessen-horowitz-2",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/first-round-10",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "companies/meridian-40-v5-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "companies/meridian-40",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "companies/meta-2",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/chris-williams-37",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/tara-kapoor-111",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/andreessen-horowitz-2",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/first-round-10",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: companies/meta-2, people/chris-williams-37, people/tara-kapoor-111, companies/andreessen-horowitz-2, companies/first-round-10."
      }
    },
    {
      "variantId": "companies/microsoft-0-v6-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/nimbus-5",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/carol-wilson-28",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/lumen-12",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/delta-3",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/tara-jackson-173",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "companies/microsoft-0-v6-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "companies/microsoft-0",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "companies/nimbus-5",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/carol-wilson-28",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/lumen-12",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/delta-3",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/tara-jackson-173",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: companies/nimbus-5, people/carol-wilson-28, companies/lumen-12, companies/delta-3, people/tara-jackson-173."
      }
    },
    {
      "variantId": "companies/nea-13-v7-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/a16z-9",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/sequoia-capital-6",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/sequoia-capital-6",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/a16z-9",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/cascade-30",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/index-ventures-7",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/olivia-miller-176",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/sequoia-capital-1",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/tina-hernandez-97",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "companies/nea-13-v7-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "companies/nea-13",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "companies/cascade-30",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/index-ventures-7",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/olivia-miller-176",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/sequoia-capital-1",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/tina-hernandez-97",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: companies/cascade-30, companies/index-ventures-7, people/olivia-miller-176, companies/sequoia-capital-1, people/tina-hernandez-97."
      }
    },
    {
      "variantId": "companies/nimbus-5-v8-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "people/mia-anderson-5",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/noah-nakamura-182",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/mia-anderson-5",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/noah-nakamura-182",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/rachel-brown-95",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/meridian-40",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/keel-38",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/iris-lee-82",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/linda-taylor-178",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "companies/nimbus-5-v8-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "companies/nimbus-5",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/rachel-brown-95",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/meridian-40",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/keel-38",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/iris-lee-82",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/linda-taylor-178",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: people/rachel-brown-95, companies/meridian-40, companies/keel-38, people/iris-lee-82, people/linda-taylor-178."
      }
    },
    {
      "variantId": "companies/orbit-42-v9-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "people/jack-patel-42",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/julia-davis-86",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/zoe-gonzalez-100",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/julia-davis-86",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/zoe-gonzalez-100",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/tara-jackson-173",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/sarah-lopez-84",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/cipher-13",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/initialized-11",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/vera-wilson-25",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "companies/orbit-42-v9-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "companies/orbit-42",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/tara-jackson-173",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/sarah-lopez-84",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/cipher-13",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/initialized-11",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/vera-wilson-25",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: people/tara-jackson-173, people/sarah-lopez-84, companies/cipher-13, companies/initialized-11, people/vera-wilson-25."
      }
    },
    {
      "variantId": "companies/pulse-8-v10-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "people/yara-johnson-8",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/eric-martinez-93",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/david-kim-186",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/eric-martinez-93",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/david-kim-186",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/tempo-24",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/wendy-wilson-170",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/quinn-park-119",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/yara-johnson-8",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/ranger-22",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "companies/pulse-8-v10-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "companies/pulse-8",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "companies/tempo-24",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/wendy-wilson-170",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/quinn-park-119",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/yara-johnson-8",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/ranger-22",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: companies/tempo-24, people/wendy-wilson-170, people/quinn-park-119, people/yara-johnson-8, companies/ranger-22."
      }
    },
    {
      "variantId": "companies/quantum-7-v11-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "people/ulrich-johnson-7",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/kate-anderson-107",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/noah-williams-198",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/kate-anderson-107",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/ulrich-johnson-7",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/resonance-45",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/vera-singh-20",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/andreessen-horowitz-2",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/jack-davis-89",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/yara-smith-30",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "companies/quantum-7-v11-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "companies/quantum-7",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "companies/resonance-45",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/vera-singh-20",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/andreessen-horowitz-2",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/jack-davis-89",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/yara-smith-30",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: companies/resonance-45, people/vera-singh-20, companies/andreessen-horowitz-2, people/jack-davis-89, people/yara-smith-30."
      }
    },
    {
      "variantId": "companies/quasar-44-v12-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "people/mark-wilson-44",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/jack-davis-89",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/grace-singh-197",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/jack-davis-89",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/rosa-nakamura-94",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/quantum-labs-57",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/henry-johnson-12",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/wendy-wilson-170",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/benchmark-3",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "companies/quasar-44-v12-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "companies/quasar-44",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/rosa-nakamura-94",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/quantum-labs-57",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/henry-johnson-12",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/wendy-wilson-170",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/benchmark-3",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: people/rosa-nakamura-94, companies/quantum-labs-57, people/henry-johnson-12, people/wendy-wilson-170, companies/benchmark-3."
      }
    },
    {
      "variantId": "companies/resonance-45-v13-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "people/grace-thomas-45",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/yara-singh-195",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/yara-singh-195",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/grace-thomas-45",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/talon-47",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/kleiner-perkins-14",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/tina-hernandez-97",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/wendy-hernandez-80",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/orbit-42",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "companies/resonance-45-v13-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "companies/resonance-45",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "companies/talon-47",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/kleiner-perkins-14",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/tina-hernandez-97",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/wendy-hernandez-80",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/orbit-42",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: companies/talon-47, companies/kleiner-perkins-14, people/tina-hernandez-97, people/wendy-hernandez-80, companies/orbit-42."
      }
    },
    {
      "variantId": "companies/sequoia-capital-1-v14-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/andreessen-horowitz",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/y-combinator",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/andreessen-horowitz",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/y-combinator",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/iris-36",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/paul-anderson-23",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/uma-brown-6",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/rachel-brown-95",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/beth-williams-177",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "companies/sequoia-capital-1-v14-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "companies/sequoia-capital-1",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "companies/iris-36",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/paul-anderson-23",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/uma-brown-6",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/rachel-brown-95",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/beth-williams-177",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: companies/iris-36, people/paul-anderson-23, people/uma-brown-6, people/rachel-brown-95, people/beth-williams-177."
      }
    },
    {
      "variantId": "companies/talon-47-v15-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "people/diana-thomas-47",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/sarah-williams-92",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/david-kim-186",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/noah-williams-198",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/sarah-williams-92",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/noah-williams-198",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/ulrich-johnson-7",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/henry-johnson-12",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/adam-lopez-113",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/zenith-27",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/andreessen-horowitz-2",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "companies/talon-47-v15-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "companies/talon-47",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/ulrich-johnson-7",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/henry-johnson-12",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/adam-lopez-113",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/zenith-27",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/andreessen-horowitz-2",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: people/ulrich-johnson-7, people/henry-johnson-12, people/adam-lopez-113, companies/zenith-27, companies/andreessen-horowitz-2."
      }
    },
    {
      "variantId": "companies/tessera-15-v16-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "people/noah-kapoor-15",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/kate-lopez-99",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/yara-singh-195",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/accel-5",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/talon-47",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/meridian-40",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/yara-smith-30",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/olivia-miller-176",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "companies/tessera-15-v16-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "companies/tessera-15",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "companies/accel-5",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/talon-47",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/meridian-40",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/yara-smith-30",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/olivia-miller-176",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: companies/accel-5, companies/talon-47, companies/meridian-40, people/yara-smith-30, people/olivia-miller-176."
      }
    },
    {
      "variantId": "companies/vector-6-v17-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "people/uma-brown-6",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/david-zhang-83",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/vera-gonzalez-103",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/grace-martinez-109",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/wendy-wilson-170",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/bob-chen-185",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/david-zhang-83",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/grace-martinez-109",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/epsilon-4",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/victor-wilson-3",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/apple-4",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/uma-gonzalez-29",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/forge-19",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "companies/vector-6-v17-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "companies/vector-6",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "companies/epsilon-4",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/victor-wilson-3",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/apple-4",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/uma-gonzalez-29",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/forge-19",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: companies/epsilon-4, people/victor-wilson-3, companies/apple-4, people/uma-gonzalez-29, companies/forge-19."
      }
    },
    {
      "variantId": "companies/vellum-49-v18-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "people/chris-davis-49",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/rosa-miller-98",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/rachel-gonzalez-175",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/rosa-miller-98",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/vox-25",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/compass-11",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/rosa-jackson-90",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/carol-wilson-28",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/helen-johnson-32",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "companies/vellum-49-v18-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "companies/vellum-49",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "companies/vox-25",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/compass-11",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/rosa-jackson-90",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/carol-wilson-28",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/helen-johnson-32",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: companies/vox-25, companies/compass-11, people/rosa-jackson-90, people/carol-wilson-28, people/helen-johnson-32."
      }
    },
    {
      "variantId": "companies/wisp-26-v19-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "people/linda-kim-26",
          "linkType": "founded"
        },
        {
          "targetSlug": "people/linda-kim-26",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/mia-brown-0",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/helix-labs-59",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/quasar-44",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/gravity-17",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/accel-5",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "companies/wisp-26-v19-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "companies/wisp-26",
      "baseType": "company",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/mia-brown-0",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/helix-labs-59",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/quasar-44",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/gravity-17",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/accel-5",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: people/mia-brown-0, companies/helix-labs-59, companies/quasar-44, companies/gravity-17, companies/accel-5."
      }
    },
    {
      "variantId": "people/adam-lee-19-v20-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/forge-19",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/forge-19",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/forge-19",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/vellum-49",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/mia-anderson-5",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/umbra-48",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/delta-labs-53",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/steve-liu-34",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/adam-lee-19-v20-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/adam-lee-19",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "companies/vellum-49",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/mia-anderson-5",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/umbra-48",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/delta-labs-53",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/steve-liu-34",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: companies/vellum-49, people/mia-anderson-5, companies/umbra-48, companies/delta-labs-53, people/steve-liu-34."
      }
    },
    {
      "variantId": "people/alice-davis-172-v21-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/prism-43",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/orbit-labs-92",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/echo-32",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/noah-kapoor-15",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/cipher-13",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/priya-taylor-85",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/apple-4",
          "linkType": "advises"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/alice-davis-172-v21-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/alice-davis-172",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "companies/echo-32",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/noah-kapoor-15",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/cipher-13",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/priya-taylor-85",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/apple-4",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: companies/echo-32, people/noah-kapoor-15, companies/cipher-13, people/priya-taylor-85, companies/apple-4."
      }
    },
    {
      "variantId": "people/carol-jackson-81-v22-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/sequoia-capital-1",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/prism-43",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/beacon-labs-60",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/foundry-labs-83",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/keel-38",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/pulse-labs-58",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/beacon-labs-60",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/keel-38",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/umbra-48",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/compass-11",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/foundry-33",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/pulse-8",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/iris-36",
          "linkType": "invested_in"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/carol-jackson-81-v22-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/carol-jackson-81",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "companies/umbra-48",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/compass-11",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/foundry-33",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/pulse-8",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/iris-36",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: companies/umbra-48, companies/compass-11, companies/foundry-33, companies/pulse-8, companies/iris-36."
      }
    },
    {
      "variantId": "people/chris-jackson-91-v23-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/initialized-11",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/meridian-40",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/gravity-17",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/acme-0",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/lucid-labs-71",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/initialized-11",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/lucid-labs-71",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/acme-0",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/founders-fund-0",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/pulse-8",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/julia-johnson-114",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/compass-11",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/paul-anderson-23",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/chris-jackson-91-v23-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/chris-jackson-91",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "companies/founders-fund-0",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/pulse-8",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/julia-johnson-114",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/compass-11",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/paul-anderson-23",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: companies/founders-fund-0, companies/pulse-8, people/julia-johnson-114, companies/compass-11, people/paul-anderson-23."
      }
    },
    {
      "variantId": "people/chris-smith-110-v24-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/acme-0",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/victor-jackson-116",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/victor-taylor-1",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/rosa-jackson-90",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/founders-fund-0",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/quantum-labs-57",
          "linkType": "works_at"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/chris-smith-110-v24-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/chris-smith-110",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/victor-jackson-116",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/victor-taylor-1",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/rosa-jackson-90",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/founders-fund-0",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/quantum-labs-57",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: people/victor-jackson-116, people/victor-taylor-1, people/rosa-jackson-90, companies/founders-fund-0, companies/quantum-labs-57."
      }
    },
    {
      "variantId": "people/david-wang-10-v25-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/beacon-10",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/beacon-10",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/quinten-rodriguez-22",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/mia-anderson-5",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/tina-lopez-117",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/founders-fund-0",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/linda-kim-26",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/david-wang-10-v25-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/david-wang-10",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/quinten-rodriguez-22",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/mia-anderson-5",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/tina-lopez-117",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/founders-fund-0",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/linda-kim-26",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: people/quinten-rodriguez-22, people/mia-anderson-5, people/tina-lopez-117, companies/founders-fund-0, people/linda-kim-26."
      }
    },
    {
      "variantId": "people/eric-lee-21-v26-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/lucid-21",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/lucid-21",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/lucid-21",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/beth-williams-177",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/tina-jones-112",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/uma-brown-6",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/hatch-35",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/chris-smith-110",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/eric-lee-21-v26-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/eric-lee-21",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/beth-williams-177",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/tina-jones-112",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/uma-brown-6",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/hatch-35",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/chris-smith-110",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: people/beth-williams-177, people/tina-jones-112, people/uma-brown-6, companies/hatch-35, people/chris-smith-110."
      }
    },
    {
      "variantId": "people/eric-miller-35-v27-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/hatch-35",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/hatch-35",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/helen-johnson-32",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/fiona-moore-88",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/iris-36",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/rachel-gonzalez-175",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/steve-williams-38",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/eric-miller-35-v27-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/eric-miller-35",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/helen-johnson-32",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/fiona-moore-88",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/iris-36",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/rachel-gonzalez-175",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/steve-williams-38",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: people/helen-johnson-32, people/fiona-moore-88, companies/iris-36, people/rachel-gonzalez-175, people/steve-williams-38."
      }
    },
    {
      "variantId": "people/frank-hernandez-31-v28-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/drift-31",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/drift-31",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/fiona-moore-88",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/quinten-nakamura-115",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/epsilon-labs-54",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/anchor-28",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/vera-rodriguez-171",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/frank-hernandez-31-v28-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/frank-hernandez-31",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/fiona-moore-88",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/quinten-nakamura-115",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/epsilon-labs-54",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/anchor-28",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/vera-rodriguez-171",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: people/fiona-moore-88, people/quinten-nakamura-115, companies/epsilon-labs-54, companies/anchor-28, people/vera-rodriguez-171."
      }
    },
    {
      "variantId": "people/helen-martinez-87-v29-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/index-ventures-7",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/acme-labs-50",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/nexus-labs-91",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/ranger-22",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/mosaic-14",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/echo-32",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/ranger-22",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/echo-32",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/iris-lee-82",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/spire-46",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/drift-31",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/nexus-41",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/mantle-16",
          "linkType": "invested_in"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/helen-martinez-87-v29-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/helen-martinez-87",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/iris-lee-82",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/spire-46",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/drift-31",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/nexus-41",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/mantle-16",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: people/iris-lee-82, companies/spire-46, companies/drift-31, companies/nexus-41, companies/mantle-16."
      }
    },
    {
      "variantId": "people/ian-davis-33-v30-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/foundry-33",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/foundry-33",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/cascade-30",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/sarah-lopez-84",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/helix-9",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/first-round-10",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/zenith-27",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/ian-davis-33-v30-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/ian-davis-33",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "companies/cascade-30",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/sarah-lopez-84",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/helix-9",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/first-round-10",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/zenith-27",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: companies/cascade-30, people/sarah-lopez-84, companies/helix-9, companies/first-round-10, companies/zenith-27."
      }
    },
    {
      "variantId": "people/jack-davis-89-v31-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/floodgate-9",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/lumen-labs-62",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/drift-31",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/beta-labs-51",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/iris-36",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/quasar-44",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/beta-labs-51",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/floodgate-9",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/quasar-44",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/mark-jones-2",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/fiona-moore-88",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/uma-gonzalez-29",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/rachel-gonzalez-175",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/jack-davis-89-v31-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/jack-davis-89",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "companies/quasar-44",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/mark-jones-2",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/fiona-moore-88",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/uma-gonzalez-29",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/rachel-gonzalez-175",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: companies/quasar-44, people/mark-jones-2, people/fiona-moore-88, people/uma-gonzalez-29, people/rachel-gonzalez-175."
      }
    },
    {
      "variantId": "people/julia-johnson-114-v32-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/epsilon-4",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/epsilon-4",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/victor-wilson-3",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/acme-0",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/adam-lopez-113",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/lumen-12",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/mark-jones-2",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/julia-johnson-114-v32-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/julia-johnson-114",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/victor-wilson-3",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/acme-0",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/adam-lopez-113",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/lumen-12",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/mark-jones-2",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: people/victor-wilson-3, companies/acme-0, people/adam-lopez-113, companies/lumen-12, people/mark-jones-2."
      }
    },
    {
      "variantId": "people/linda-kim-26-v33-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/wisp-26",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/wisp-26",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/chris-jackson-91",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/linda-kim-26",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/frank-hernandez-31",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/jolt-37",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/vox-25",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/linda-kim-26-v33-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/linda-kim-26",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/chris-jackson-91",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/linda-kim-26",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/frank-hernandez-31",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/jolt-37",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/vox-25",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: people/chris-jackson-91, people/linda-kim-26, people/frank-hernandez-31, companies/jolt-37, companies/vox-25."
      }
    },
    {
      "variantId": "people/mark-jones-2-v34-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/gamma-2",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/gamma-2",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/beta-1",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/mia-lee-13",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/ulrich-wang-16",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/wendy-wilson-170",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/apex-18",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/mark-jones-2-v34-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/mark-jones-2",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "companies/beta-1",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/mia-lee-13",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/ulrich-wang-16",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/wendy-wilson-170",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/apex-18",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: companies/beta-1, people/mia-lee-13, people/ulrich-wang-16, people/wendy-wilson-170, companies/apex-18."
      }
    },
    {
      "variantId": "people/mia-anderson-5-v35-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/nimbus-5",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/nimbus-5",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/nimbus-5",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/eric-miller-35",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/carol-jackson-81",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/compass-11",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/lucid-21",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/beth-williams-177",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/mia-anderson-5-v35-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/mia-anderson-5",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/eric-miller-35",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/carol-jackson-81",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/compass-11",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/lucid-21",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/beth-williams-177",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: people/eric-miller-35, people/carol-jackson-81, companies/compass-11, companies/lucid-21, people/beth-williams-177."
      }
    },
    {
      "variantId": "people/mia-lee-13-v36-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/cipher-13",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/cipher-13",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/steve-liu-34",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/rachel-gonzalez-175",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/sentinel-23",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/initialized-11",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/umbra-48",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/mia-lee-13-v36-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/mia-lee-13",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/steve-liu-34",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/rachel-gonzalez-175",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/sentinel-23",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/initialized-11",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/umbra-48",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: people/steve-liu-34, people/rachel-gonzalez-175, companies/sentinel-23, companies/initialized-11, companies/umbra-48."
      }
    },
    {
      "variantId": "people/nina-rodriguez-18-v37-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/apex-18",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/apex-18",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/carol-jackson-81",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/greylock-4",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/nexus-41",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/vera-rodriguez-171",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/cascade-30",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/nina-rodriguez-18-v37-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/nina-rodriguez-18",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/carol-jackson-81",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/greylock-4",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/nexus-41",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/vera-rodriguez-171",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/cascade-30",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: people/carol-jackson-81, companies/greylock-4, companies/nexus-41, people/vera-rodriguez-171, companies/cascade-30."
      }
    },
    {
      "variantId": "people/olivia-miller-176-v38-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/epsilon-4",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/prism-43",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/echo-labs-82",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/mantle-labs-66",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/prism-43",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/echo-labs-82",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/epsilon-4",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/mia-lee-13",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/tara-kapoor-111",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/alice-davis-172",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/compass-11",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/tina-lopez-117",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/olivia-miller-176-v38-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/olivia-miller-176",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/mia-lee-13",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/tara-kapoor-111",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/alice-davis-172",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/compass-11",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/tina-lopez-117",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: people/mia-lee-13, people/tara-kapoor-111, people/alice-davis-172, companies/compass-11, people/tina-lopez-117."
      }
    },
    {
      "variantId": "people/paul-rodriguez-4-v39-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/epsilon-4",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/epsilon-4",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/amazon-3",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/beth-williams-177",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/quinn-miller-39",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/noah-kapoor-15",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/yara-johnson-8",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/paul-rodriguez-4-v39-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/paul-rodriguez-4",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "companies/amazon-3",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/beth-williams-177",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/quinn-miller-39",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/noah-kapoor-15",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/yara-johnson-8",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: companies/amazon-3, people/beth-williams-177, people/quinn-miller-39, people/noah-kapoor-15, people/yara-johnson-8."
      }
    },
    {
      "variantId": "people/priya-zhang-27-v40-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/zenith-27",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/zenith-27",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/nina-rodriguez-18",
          "linkType": "advises"
        },
        {
          "targetSlug": "people/quinten-wang-17",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/compass-11",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/helix-labs-59",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/chris-williams-37",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/priya-zhang-27-v40-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/priya-zhang-27",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/nina-rodriguez-18",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/quinten-wang-17",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/compass-11",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/helix-labs-59",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/chris-williams-37",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: people/nina-rodriguez-18, people/quinten-wang-17, companies/compass-11, companies/helix-labs-59, people/chris-williams-37."
      }
    },
    {
      "variantId": "people/quinn-park-119-v41-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/helix-9",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/wisp-26",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/wisp-26",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/helix-9",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/hatch-35",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/floodgate-9",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/quinn-miller-39",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/lucid-21",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/quantum-7",
          "linkType": "invested_in"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/quinn-park-119-v41-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/quinn-park-119",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "companies/hatch-35",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/floodgate-9",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/quinn-miller-39",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/lucid-21",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/quantum-7",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: companies/hatch-35, companies/floodgate-9, people/quinn-miller-39, companies/lucid-21, companies/quantum-7."
      }
    },
    {
      "variantId": "people/quinten-nakamura-115-v42-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/nimbus-5",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/nimbus-5",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/rachel-garcia-9",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/yara-smith-30",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/helen-martinez-87",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/mark-thomas-11",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/jolt-37",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/quinten-nakamura-115-v42-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/quinten-nakamura-115",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/rachel-garcia-9",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/yara-smith-30",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/helen-martinez-87",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/mark-thomas-11",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/jolt-37",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: people/rachel-garcia-9, people/yara-smith-30, people/helen-martinez-87, people/mark-thomas-11, companies/jolt-37."
      }
    },
    {
      "variantId": "people/quinten-wang-17-v43-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/gravity-17",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/gravity-17",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/carol-jackson-81",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/bessemer-12",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/nexus-41",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/jack-davis-89",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/linda-taylor-178",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/quinten-wang-17-v43-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/quinten-wang-17",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/carol-jackson-81",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/bessemer-12",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/nexus-41",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/jack-davis-89",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/linda-taylor-178",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: people/carol-jackson-81, companies/bessemer-12, companies/nexus-41, people/jack-davis-89, people/linda-taylor-178."
      }
    },
    {
      "variantId": "people/rachel-garcia-9-v44-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/helix-9",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/helix-9",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/quasar-44",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/tina-hernandez-97",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/mark-thomas-11",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/meta-2",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/acme-labs-50",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/rachel-garcia-9-v44-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/rachel-garcia-9",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "companies/quasar-44",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/tina-hernandez-97",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/mark-thomas-11",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/meta-2",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/acme-labs-50",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: companies/quasar-44, people/tina-hernandez-97, people/mark-thomas-11, companies/meta-2, companies/acme-labs-50."
      }
    },
    {
      "variantId": "people/rosa-jackson-90-v45-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/first-round-10",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/keel-labs-88",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/pulse-labs-58",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/gust-labs-84",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/prism-43",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/prism-43",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/first-round-10",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/priya-taylor-85",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/david-wang-10",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/mark-thomas-11",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/epsilon-labs-54",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/acme-labs-50",
          "linkType": "invested_in"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/rosa-jackson-90-v45-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/rosa-jackson-90",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/priya-taylor-85",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/david-wang-10",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/mark-thomas-11",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/epsilon-labs-54",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/acme-labs-50",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: people/priya-taylor-85, people/david-wang-10, people/mark-thomas-11, companies/epsilon-labs-54, companies/acme-labs-50."
      }
    },
    {
      "variantId": "people/rosa-nakamura-94-v46-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/kleiner-perkins-14",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/spire-46",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/gravity-17",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/mantle-labs-66",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/compass-labs-61",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/wisp-labs-76",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/linda-taylor-178",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/pulse-8",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/bessemer-12",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/priya-taylor-85",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/amazon-3",
          "linkType": "invested_in"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/rosa-nakamura-94-v46-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/rosa-nakamura-94",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/linda-taylor-178",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/pulse-8",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/bessemer-12",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/priya-taylor-85",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/amazon-3",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: people/linda-taylor-178, companies/pulse-8, companies/bessemer-12, people/priya-taylor-85, companies/amazon-3."
      }
    },
    {
      "variantId": "people/sarah-williams-92-v47-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/bessemer-12",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/anchor-28",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/epsilon-4",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/talon-47",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "companies/kindle-labs-70",
          "linkType": "invested_in"
        },
        {
          "targetSlug": "people/chris-singh-96",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/xavier-nakamura-118",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/nina-rodriguez-18",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/yara-smith-30",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/fiona-moore-88",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/sarah-williams-92-v47-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/sarah-williams-92",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/chris-singh-96",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/xavier-nakamura-118",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/nina-rodriguez-18",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/yara-smith-30",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/fiona-moore-88",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: people/chris-singh-96, people/xavier-nakamura-118, people/nina-rodriguez-18, people/yara-smith-30, people/fiona-moore-88."
      }
    },
    {
      "variantId": "people/steve-williams-38-v48-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/keel-38",
          "linkType": "founded"
        },
        {
          "targetSlug": "companies/keel-38",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/pulse-8",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/iris-36",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/sequoia-capital-1",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/gamma-labs-52",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/umbra-48",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/steve-williams-38-v48-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/steve-williams-38",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "companies/pulse-8",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/iris-36",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/sequoia-capital-1",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/gamma-labs-52",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/umbra-48",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: companies/pulse-8, companies/iris-36, companies/sequoia-capital-1, companies/gamma-labs-52, companies/umbra-48."
      }
    },
    {
      "variantId": "people/tara-kapoor-111-v49-multi_entity_sentence",
      "kind": "multi_entity_sentence",
      "extracted": [
        {
          "targetSlug": "companies/beta-1",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/apex-18",
          "linkType": "advises"
        },
        {
          "targetSlug": "companies/apex-18",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/jack-davis-89",
          "linkType": "mentions"
        },
        {
          "targetSlug": "people/iris-lee-82",
          "linkType": "mentions"
        },
        {
          "targetSlug": "companies/nexus-41",
          "linkType": "works_at"
        },
        {
          "targetSlug": "companies/nimbus-labs-55",
          "linkType": "works_at"
        },
        {
          "targetSlug": "people/frank-hernandez-31",
          "linkType": "mentions"
        }
      ],
      "false_positives": [],
      "missed": [],
      "mistyped": [],
      "matched": 5,
      "probe_id": "people/tara-kapoor-111-v49-multi_entity_sentence",
      "contributed": true,
      "baseSlug": "people/tara-kapoor-111",
      "baseType": "person",
      "goldDelta": {
        "must_not_extract": [],
        "must_extract": [
          {
            "slug": "people/jack-davis-89",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/iris-lee-82",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/nexus-41",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "companies/nimbus-labs-55",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          },
          {
            "slug": "people/frank-hernandez-31",
            "type": "mentions",
            "reason": "multi_entity_sentence: all 5 entities in a packed clause should extract"
          }
        ],
        "note": "Injected packed clause with 5 entities: people/jack-davis-89, people/iris-lee-82, companies/nexus-41, companies/nimbus-labs-55, people/frank-hernandez-31."
      }
    }
  ]
}
[cat6] verdict=pass — 250 variants, recall=1.000, precision=1.000, type_match=1.000; gazetteer arm 50/50 prose-only mentions linked (ordinary pass 0.000)

```

---
## Cat 7: Performance / latency

**Status:** ✓ PASS (receipt; exit 0, 39s)

```
# BrainBench Category 7: Performance / Latency

Generated: 2026-10-03T19:54:20
Engine: PGLite (in-memory)
Seed: 42 (mulberry32; identical workload every run)
Percentile method: linear interpolation (eval/runner/metrics.ts)

## Scale: 1000 pages (seed 42)

  Setting up brain schema (v196)...
  v142: takes.embedding resized to vector(1024); existing take vectors cleared
Bulk putPage: 1000 pages in 1.1s = 909.7 pages/sec
Bulk addLink: 2850/2850 links written in 0.6s = 4609.6 links/sec
  get_page               P50=0.36ms  P95=0.80ms  P99=0.95ms  (n=50, warmup=3 discarded)
  get_links              P50=0.22ms  P95=0.64ms  P99=1.52ms  (n=50, warmup=3 discarded)
  get_backlinks          P50=0.11ms  P95=0.69ms  P99=1.36ms  (n=50, warmup=3 discarded)
  get_backlinks_hub      P50=0.70ms  P95=0.72ms  P99=0.73ms  (n=20, warmup=3 discarded)
  get_timeline           P50=0.10ms  P95=0.27ms  P99=0.30ms  (n=50, warmup=3 discarded)
  get_stats              P50=1.90ms  P95=3.86ms  P99=3.87ms  (n=10, warmup=3 discarded)
  list_pages_50          P50=0.99ms  P95=1.36ms  P99=3.69ms  (n=20, warmup=3 discarded)
  search_keyword         P50=0.17ms  P95=1.01ms  P99=1.02ms  (n=30, warmup=3 discarded)
  traverse_paths_d1      P50=1.37ms  P95=2.51ms  P99=2.57ms  (n=10, warmup=3 discarded)
  traverse_paths_d2      P50=25.13ms  P95=66.08ms  P99=87.90ms  (n=10, warmup=3 discarded)
  putPage_single         P50=0.88ms  P95=1.18ms  P99=1.20ms  (n=30, warmup=3 discarded)

## Scale: 10000 pages (seed 42)

  Setting up brain schema (v196)...
  v142: takes.embedding resized to vector(1024); existing take vectors cleared
Bulk putPage: 10000 pages in 24.1s = 414.8 pages/sec
Bulk addLink: 28500/28500 links written in 5.7s = 5019.4 links/sec
  get_page               P50=1.81ms  P95=2.16ms  P99=2.23ms  (n=50, warmup=3 discarded)
  get_links              P50=1.66ms  P95=2.04ms  P99=2.06ms  (n=50, warmup=3 discarded)
  get_backlinks          P50=0.53ms  P95=1.02ms  P99=1.15ms  (n=50, warmup=3 discarded)
  get_backlinks_hub      P50=1.05ms  P95=1.09ms  P99=1.14ms  (n=20, warmup=3 discarded)
  get_timeline           P50=0.04ms  P95=0.47ms  P99=0.68ms  (n=50, warmup=3 discarded)
  get_stats              P50=6.90ms  P95=7.55ms  P99=7.90ms  (n=10, warmup=3 discarded)
  list_pages_50          P50=0.91ms  P95=0.98ms  P99=0.99ms  (n=20, warmup=3 discarded)
  search_keyword         P50=0.13ms  P95=0.95ms  P99=0.97ms  (n=30, warmup=3 discarded)
  traverse_paths_d1      P50=1.34ms  P95=1.90ms  P99=1.90ms  (n=10, warmup=3 discarded)
  traverse_paths_d2      P50=87.00ms  P95=88.73ms  P99=89.27ms  (n=10, warmup=3 discarded)
  putPage_single         P50=0.74ms  P95=0.80ms  P99=0.82ms  (n=30, warmup=3 discarded)

✓ search_keyword P95 at 10000 = 1.0ms (limit 200ms)

```

---
## Cat 10: Robustness / adversarial input

**Status:** ✓ PASS (receipt; exit 0, 3s)

```
# BrainBench Category 10: Robustness / Adversarial

Generated: 2026-10-03T19:50:21
  Setting up brain schema (v196)...
  v142: takes.embedding resized to vector(1024); existing take vectors cleared

## Case: empty compiled_truth
  6/6 ops succeeded

## Case: whitespace only
  6/6 ops succeeded

## Case: newlines only
  6/6 ops succeeded

## Case: 50K char page
  6/6 ops succeeded

## Case: 100K char page
  6/6 ops succeeded

## Case: CJK content
  6/6 ops succeeded

## Case: Arabic RTL
  6/6 ops succeeded

## Case: Cyrillic
  6/6 ops succeeded

## Case: emoji-heavy
  6/6 ops succeeded

## Case: mixed scripts
  6/6 ops succeeded

## Case: slug inside code fence
  6/6 ops succeeded

## Case: inline code with slug
  6/6 ops succeeded

## Case: false-positive substring
  6/6 ops succeeded

## Case: slug with dots
  6/6 ops succeeded

## Case: slug with leading number
  6/6 ops succeeded

## Case: slug max length
  6/6 ops succeeded

## Case: invalid date in timeline
  6/6 ops succeeded

## Case: timeline with no dates
  6/6 ops succeeded

## Case: deeply nested lists
  6/6 ops succeeded

## Case: long blockquote chain
  6/6 ops succeeded

## Case: 100 refs in one page
  6/6 ops succeeded

## Case: same entity 50 times
  7/7 ops succeeded

## Summary
Cases: 22
Ops attempted: 133
Ops succeeded: 133 (100.0%)
Crashes: 0
Silent corruption: 0
Link candidates extracted: 108

```

---
## Cat 11: Text ingestion fidelity (md/html; audio needs a key)

**Status:** ✓ PASS (receipt; exit 0, 3s)

```
  Setting up brain schema (v196)...
  v142: takes.embedding resized to vector(1024); existing take vectors cleared
{
  "schema_version": 2,
  "ran_at": "2026-10-03T19:50:26.978Z",
  "results": {
    "markdown": {
      "modality": "markdown",
      "metric_name": "word_recall",
      "threshold": 0.9,
      "items": 3,
      "items_scored": 3,
      "mean_metric": 1,
      "per_item": [
        {
          "name": "garden-irrigation",
          "metric": 1,
          "detail": {
            "chunks": 1,
            "canonical_words": 225,
            "indexed_chars": 1264
          }
        },
        {
          "name": "bread-starter",
          "metric": 1,
          "detail": {
            "chunks": 1,
            "canonical_words": 222,
            "indexed_chars": 1247
          }
        },
        {
          "name": "trail-survey",
          "metric": 1,
          "detail": {
            "chunks": 2,
            "canonical_words": 212,
            "indexed_chars": 1510
          }
        }
      ],
      "skipped": false,
      "verdict": "pass",
      "negative_control": {
        "real_mean": 1,
        "control_mean": 0.22003475173286494,
        "degradation_ok": true
      }
    },
    "html": {
      "modality": "html",
      "metric_name": "word_recall",
      "threshold": 0.8,
      "items": 2,
      "items_scored": 2,
      "mean_metric": 1,
      "per_item": [
        {
          "name": "tide-pools",
          "metric": 1,
          "detail": {
            "chunks": 1,
            "canonical_words": 198,
            "indexed_chars": 1386
          }
        },
        {
          "name": "weather-glossary",
          "metric": 1,
          "detail": {
            "chunks": 1,
            "canonical_words": 198,
            "indexed_chars": 1483
          }
        }
      ],
      "skipped": false,
      "verdict": "pass",
      "negative_control": {
        "real_mean": 1,
        "control_mean": 0.17676767676767677,
        "degradation_ok": true
      }
    },
    "pdf": {
      "modality": "pdf",
      "metric_name": "none",
      "threshold": null,
      "items": 0,
      "items_scored": 0,
      "mean_metric": null,
      "per_item": [],
      "skipped": true,
      "skip_reason": "gbrain v0.47.6.0 has no PDF text-extraction/ingest path; the pre-audit runner benchmarked the eval's own pdf-parse wrapper, which measured nothing about gbrain (audit retrieval-cats-12). Deferred until gbrain ships PDF ingestion."
    },
    "audio": {
      "modality": "audio",
      "metric_name": "transcription_fidelity",
      "threshold": null,
      "items": 0,
      "items_scored": 0,
      "mean_metric": null,
      "per_item": [],
      "skipped": true,
      "skip_reason": "No audio fixture manifest: binary clips are not committed to the repo (the fetch script the pre-audit header advertised never existed — audit retrieval-cats-03). Provide local fixtures + GROQ_API_KEY/OPENAI_API_KEY to run this modality."
    }
  },
  "verdict": "pass"
}
[cat11] verdict=pass (markdown, html ran; pdf, audio skipped)

```

---
## Cat 12: MCP operation contract

**Status:** ✓ PASS (receipt; exit 0, 5s)

```
# BrainBench Category 12: MCP Operation Contract

Generated: 2026-10-03T19:50:25
Operations available: 155
  Setting up brain schema (v196)...
  v142: takes.embedding resized to vector(1024); existing take vectors cleared

## Limit cap: traverse_graph depth
  ✓ traverse_graph depth=1000 over a 16-node chain stops at the 10-hop cap — 21 rows (21 GraphPath edges) reached 11 nodes of the 16-node chain, max depth 10, expected frontier 10
  ✓ traverse_graph depth=5 (under cap) is honored exactly: GraphPath frontier at 5 hops — 11 rows (11 GraphPath edges) reached 6 nodes of the 16-node chain, max depth 5, expected frontier 5
  ✓ traverse_graph remote call with depth AND direction defaulted walks exactly 2 hops — 5 rows (5 GraphPath edges) reached 3 nodes of the 16-node chain, max depth 2, expected frontier 2
  ✓ traverse_graph remote no-direction call defaults to direction=both (inbound edge into the start page is returned) — inbound chain/inbound→chain/c0: returned; outbound chain/c0→chain/c1: returned

## Limit cap: list_pages remote clamp
  ✓ list_pages limit=1M from remote is clamped to 100 rows — remote list_pages returned 100 rows with 137 pages seeded (cap 100)

## Trust matrix: trusted local vs untrusted remote
  ✓ list_pages limit=120: honored locally, clamped to 100 remotely — local returned 120 rows, remote returned 100 (remote cap 100)
  ✓ search per-call mode: unknown mode loudly rejected locally, ignored remotely — local: Unknown search mode 'not-a-real-mode'. Valid: conservative, balanced, tokenmax.; remote: ok (mode ignored)

## Input validation: slug format
  ✓ get_page rejects/null-returns path traversal — rejected: Page not found: ../etc/passwd
  ✓ get_page rejects/null-returns absolute path — rejected: Page not found: /absolute/path
  ✓ get_page rejects/null-returns parent escape — rejected: Page not found: ../../escape
  ✓ get_page rejects/null-returns missing directory prefix — rejected: Page not found: no-directory
  ✓ get_page rejects/null-returns empty string — rejected: Page not found: 
  ✓ get_page rejects/null-returns huge slug (10K chars) — rejected: Page not found: people/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

## Input validation: date format
  ✓ add_timeline_entry rejects invalid date "not-a-date" — rejected: Invalid date format "not-a-date" (expected YYYY-MM-DD)
  ✓ add_timeline_entry rejects invalid date "2026-13-45" — rejected: Invalid date "2026-13-45" (year 1900-2199, month 1-12, day 1-31)
  ✓ add_timeline_entry rejects invalid date "99999-01-01" — rejected: Invalid date format "99999-01-01" (expected YYYY-MM-DD)
  ✓ add_timeline_entry rejects invalid date "" — rejected: Invalid date format "" (expected YYYY-MM-DD)
  ✓ add_timeline_entry rejects invalid date "../../../etc/passwd" — rejected: Invalid date format "../../../etc/passwd" (expected YYYY-MM-DD)

## Injection: SQL injection attempts
  ✓ search resists SQL payload "'; DROP TABLE pages; --" — parameterized OK
  ✓ search resists SQL payload "' OR '1'='1" — parameterized OK
  ✓ search resists SQL payload "'; SELECT * FROM access_tokens" — parameterized OK
  ✓ search resists SQL payload "\x00\x00\x00" — parameterized OK
  ✓ search resists SQL payload " injection" — error: invalid byte sequence for encoding "UTF8": 0x00

## Resource exhaustion: large inputs
  ✓ search with 10MB query string returns within 5s — 694ms (returned)

## Handler sanity walk (separate from behavioral pass-rate)
  ✓ 155/155 operations have handlers

## Summary
Behavioral assertions: 24
Passed: 24 (100.0%)
Failed: 0

```

---
## Cat 19: Sick-brain remediation loop (hash embeddings)

**Status:** ✓ PASS (receipt; exit 0, 4s)

```
  Setting up brain schema (v196)...
[cat19] seeding 30 pages (noEmbed, no link extraction)...
[cat19] baseline: score=10 links=0 missing_embed=30 chunks=30
[cat19] doctor plan: [embed.stale, extract.stale]
[extract.links_db] start
[extract.links_db] 10/30 (33%)
[extract.links_db] 20/30 (66%)
[extract.links_db] 30/30 (100%)
[extract.links_db] 30/30 (100%) done
[cat19] achieved: score=85 (Δ75.0) links=35 (+35) missing_embed=0

[cat19] ─── Scorecard ───────────────────
[cat19]   baseline:  score=10 links=0 missing_embed=30
[cat19]   achieved:  score=85 links=35 missing_embed=0
[cat19]   delta:     75.0 (gate >= 15)
[cat19]   step extract.links: extract links --source db completed (65ms)
[cat19]   step embed.stale: embedded 30, skipped 0, failures 0 (208ms)
[cat19]   gates:     5/5 scored, 0 errors
[cat19]   run_status=completed verdict=pass publishable=false
[cat19]   receipt:   ~/work/evals-after/eval/reports/cat19-doctor-remediate/receipt.json

```

---
## Cat 22: Source isolation

**Status:** ✓ PASS (receipt; exit 0, 4s)

```
  Setting up brain schema (v196)...
[gbrain] vector search unavailable (missing_env) — results are keyword-only. Run `gbrain doctor` to diagnose.

[cat22] ─── Scorecard ───────────────────
[cat22]   sources:           3 (alpha, beta, gamma)
[cat22]   isolation clean:   YES
[cat22]   controls detect:   YES
[cat22]   ✓ hybridSearch           scope=alpha        rows=20/20 leaked=0 missing_src=0
[cat22]   ✓ listPages              scope=alpha        rows=22/22 leaked=0 missing_src=0
[cat22]   ✓ getPage                scope=alpha        rows=10/10 leaked=0 missing_src=0
[cat22]   ✓ listPages-federated    scope=alpha+beta   rows=43/43 leaked=0 missing_src=0
[cat22]   ✓ traverseGraph          scope=alpha        rows=2/2 leaked=0 missing_src=0
[cat22]   ✓ hybridSearch-unscoped  [control] rows=60 cross-source=40
[cat22]   ✓ listPages-unscoped     [control] rows=63 cross-source=41
[cat22]   ✓ traverseGraph-unscoped [control] rows=3 cross-source=1
[cat22]   run_status=completed verdict=pass
[cat22]   receipt:           ~/work/evals-after/eval/reports/cat22-source-isolation/receipt.json

```

---
## Cat 23: Phantom to canonical redirect

**Status:** ✓ PASS (receipt; exit 0, 3s)

```
  Setting up brain schema (v196)...
  v142: takes.embedding resized to vector(1024); existing take vectors cleared

[cat23] ─── Scorecard ───────────────────
[cat23]   canonicals:       9
[cat23]   phantoms:         9
[cat23]   correct:          9/9 (6 redirects, 3 correct refusals)
[cat23]   resolver errors:  0
[cat23]   ✓ alice          expected=redirect     got=redirect     canonical=people/alice-okafor
[cat23]   ✓ bob            expected=redirect     got=redirect     canonical=people/bob-chen
[cat23]   ✓ carol          expected=redirect     got=redirect     canonical=people/carol-singh
[cat23]   ✓ erin           expected=redirect     got=redirect     canonical=people/erin-yu
[cat23]   ✓ acme           expected=redirect     got=redirect     canonical=companies/acme-ai
[cat23]   ✓ foundry        expected=redirect     got=redirect     canonical=companies/foundry-labs
[cat23]   ✓ dan            expected=ambiguous    got=ambiguous    canonical=people/dan-brown
[cat23]   ✓ team           expected=no_canonical got=no_canonical canonical=<none>
[cat23]   ✓ bob-chen       expected=no_canonical got=no_canonical canonical=<none>
[cat23]   run_status=completed verdict=pass
[cat23]   receipt:          ~/work/evals-after/eval/reports/cat23-phantom-redirect/receipt.json

```

---
## Cat 24: Capture provenance

**Status:** ✓ PASS (receipt; exit 0, 4s)

```
  Setting up brain schema (v196)...

[cat24] ─── Scorecard ───────────────────
[cat24]   probes: 7/7 scored, 0 error(s)
[cat24]   ✓ content-import                       kind=capture-cli
[cat24]   ✓ file-import-no-channel-provenance    kind=NULL
[cat24]   ✓ op-put-page-local-trusted            kind=capture-cli
[cat24]   ✓ op-put-page-remote-spoof-override    kind=mcp:put_page
[cat24]   dedup: before=1 after=1 distinct_ids=1 (1 = clean) status=skipped
[cat24]   run_status=completed verdict=pass
[cat24]   receipt: ~/work/evals-after/eval/reports/cat24-capture-provenance/receipt.json

```

---
## Cat 27: Graph signals on/off

**Status:** ✓ PASS (receipt; exit 0, 9s)

```
[cat27] running adjacency-hub-acme-ai (adjacency)...
  Setting up brain schema (v196)...
[cat27]   seeded 8 pages, 6 links
[cat27]   nDCG@10 33.3% → 33.3% ·  top1 ✗ → ✗
[cat27] running cross-source-corroborated-fund-x (cross_source)...
  Setting up brain schema (v196)...
[cat27]   seeded 7 pages, 5 links
[cat27]   nDCG@10 35.6% → 38.7% ↑  top1 ✗ → ✗
[cat27] running adjacency-close-hub-foundry (adjacency)...
  Setting up brain schema (v196)...
[cat27]   seeded 6 pages, 4 links
[cat27]   nDCG@10 100.0% → 100.0% ·  top1 ✓ → ✓
[cat27] running session-demote-chat-spam (session)...
  Setting up brain schema (v196)...
[cat27]   seeded 5 pages, 0 links
[cat27]   nDCG@10 38.7% → 38.7% ·  top1 ✗ → ✗

[cat27] ─── Scorecard ───────────────────
[cat27]   probes:         4/4 scored (0 sut errors)
[cat27]   top-1 hit:      25.0% → 25.0%  Δ+0.0pt
[cat27]   mean nDCG@10:   51.9% → 52.7%  Δ+0.8pt
[cat27]   adjacency      top1 1/2 → 1/2  nDCG 66.7% → 66.7%
[cat27]   cross_source   top1 0/1 → 0/1  nDCG 35.6% → 38.7%
[cat27]   session        top1 0/1 → 0/1  nDCG 38.7% → 38.7%
[cat27]   probes ↑/·/↓:   1/3/0
[cat27]   ranking changed: 4/4
[cat27]   verdict:        pass (run_invalid=false)
[cat27]   receipt:        ~/work/evals-after/eval/reports/cat27-graph-signals/receipt.json

```

---
## Cat 28: Federated sync latency

**Status:** ✓ PASS (receipt; exit 0, 33s)

```
[cat28] warmup engine (untimed)...
  Setting up brain schema (v196)...
[cat28] warmup done (2082ms, discarded)
[cat28] rep 1/3 serial: 4 sources × 30 pages...
  Setting up brain schema (v196)...
[cat28]   2324ms (120/120 pages verified)
[cat28] rep 1/3 concurrent_single_thread: 4 sources × 30 pages...
  Setting up brain schema (v196)...
  Setting up brain schema (v196)...
  Setting up brain schema (v196)...
  Setting up brain schema (v196)...
[cat28]   7618ms (120/120 pages verified)
[cat28] rep 2/3 concurrent_single_thread: 4 sources × 30 pages...
  Setting up brain schema (v196)...
  Setting up brain schema (v196)...
  Setting up brain schema (v196)...
  Setting up brain schema (v196)...
[cat28]   7347ms (120/120 pages verified)
[cat28] rep 2/3 serial: 4 sources × 30 pages...
  Setting up brain schema (v196)...
[cat28]   2386ms (120/120 pages verified)
[cat28] rep 3/3 serial: 4 sources × 30 pages...
  Setting up brain schema (v196)...
[cat28]   2323ms (120/120 pages verified)
[cat28] rep 3/3 concurrent_single_thread: 4 sources × 30 pages...
  Setting up brain schema (v196)...
  Setting up brain schema (v196)...
  Setting up brain schema (v196)...
  Setting up brain schema (v196)...
[cat28]   7636ms (120/120 pages verified)

[cat28] ─── Scorecard (single-thread microbenchmark) ───
[cat28]   sources × pages:   4 × 30, reps=3, warmup=true
[cat28]   serial:            median 2324ms  p95 2379.8ms  (all: 2324, 2386, 2323)
[cat28]   concurrent (1 thread): median 7618ms  p95 7634.2ms  (all: 7618, 7347, 7636)
[cat28]   interleaving ratio: 0.31x (NOT worker-pool speedup)
[cat28]   setup p50/p95:     serial 1757/1804.7ms, concurrent 6099/7444.4ms per engine
[cat28]   verdict:           pass
[cat28]   receipt:           ~/work/evals-after/eval/reports/cat28-federated-sync-latency/receipt.json

```

---
## Cat 34: BrainBench memory conformance (external gbrain checkout)

**Status:** ⤼ SKIPPED (receipt; exit 2, 1s)

```
[cat34] SKIPPED — no gbrain checkout with BrainBench found. Set GBRAIN_REPO to a checkout carrying src/cli.ts + evals/brainbench/ (requires the Cathedral 2 release, > v0.42.40.0). Exiting non-zero (pass --allow-skip to acknowledge).

```

---
## Cat 36: Associative retrieval (offline keyword plumbing only; not capability evidence)

**Status:** ✓ PASS (receipt; exit 0, 6s)

```
  Setting up brain schema (v196)...
[gbrain] vector search unavailable (missing_env) — results are keyword-only. Run `gbrain doctor` to diagnose.
{"receipt":"~/work/evals-after/eval/reports/cat36-associative-retrieval/sweep-e56faa1e-8c46-4513-9978-58e85a9d4249/receipt.json","status":"completed","publishable":false}

```

---
## Cat N3: Temporal and as-of questions through gbrain's temporal features

**Status:** ✓ PASS (receipt; exit 0, 22s)

```
# BrainBench N3: temporal and as-of (gbrain 0.60.37.0, pinned)
  Setting up brain schema (v196)...
  v142: takes.embedding resized to vector(1024); existing take vectors cleared
seeding 114 person events, 17 meetings
[gbrain] vector search unavailable (no_gateway_config) — results are keyword-only. Run `gbrain doctor` to diagnose.
probing 492 ledger probes

| feature | passed |
|---|---|
| asof_facts | 104/104 |
| asof_timeline | 104/104 |
| chronicle_day | 15/15 |
| chronicle_last_seen | 83/83 |
| chronicle_on_this_day | 5/5 |
| chronicle_since | 4/4 |
| chronicle_since_kind | 3/3 |
| chronicle_week | 4/4 |
| date_bound_input_validation | 5/5 |
| effective_date_precedence | 10/10 |
| effective_date_recorded_time | 9/9 |
| pagedate_filter | 104/104 |
| relative_durations | 7/7 |
| search_date_bounds | 15/15 |
| timezone_chronicle | 6/6 |
| timezone_search | 9/9 |
| trajectory_asof | 10/10 |
| trajectory_range | 16/16 |

as-of accuracy (ontology_get): 100.0%  timeline: 100.0%
range set-F1: 1.000 over 179 range probes
last-seen MAE: 0.00 days (n=58), exact 100.0%
negative controls: 100.0% of 155
page-date as-of: matches recorded-time gold 104/104, valid-time gold 86/104
verdict: pass
receipt: ~/work/evals-after/eval/reports/n3-temporal-asof/receipt.json

```

---
## Cat N4: Entity resolution: variants, namesakes and cross-source identity

**Status:** ✓ PASS (receipt; exit 1, 12s)

```
# BrainBench N4: entity resolution

gbrain 0.60.37.0 (pinned dependency); seed 20260930; ledger e9fc8e3059f7; 28 pages, 144 mentions
  Setting up brain schema (v196)...
  v142: takes.embedding resized to vector(1024); existing take vectors cleared
  presence: ok   every ledger page exists with its title (28/28 pages)
  presence: ok   page_aliases rows equal each page's aliases: frontmatter (30 alias rows for 30 written aliases)
  presence: ok   identity groups read back with their members and canonical (3 groups read back, 3 written)
  presence: ok   one marker fact per page (28 marker facts for 28 pages)
  resolver: 136 probes
  recall: 144 probes
[gbrain] vector search unavailable (no_gateway_config) — results are keyword-only. Run `gbrain doctor` to diagnose.
  search_floor: 48/48
  remember: 136 probes
  resolve_on_save: 136 probes

## Resolution surfaces
| surface | n | B3 F1 | accuracy | wrong merges | unresolved | fragmented | correct refusals | floor |
|---|---|---|---|---|---|---|---|---|
| resolver | 136 | 0.762 | 68.9% of 119 | 0/136 | 31.1% | 0.0% | 100.0% of 17 | 48/48 |
| recall | 144 | 0.778 | 69.9% of 123 | 0/144 | 30.1% | 0.0% | 100.0% of 21 | 50/50 |
| remember | 136 | 0.762 | 68.9% of 119 | 0/136 | 0.0% | 31.1% | 100.0% of 17 | 48/48 |
| resolve_on_save | 136 | 0.762 | 68.9% of 119 | 0/136 | 31.1% | 0.0% | 100.0% of 17 | 48/48 |
| baseline: singleton-everything | 136 | 0.480 | 0.0% of 119 | 0/136 | 100.0% | 0.0% | 100.0% of 17 | 0/48 |
| baseline: merge-everything | 136 | 0.109 | 0.0% of 119 | 136/136 | 0.0% | 0.0% | 0.0% of 17 | 0/48 |
| baseline: exact-only | 136 | 0.566 | 40.3% of 119 | 0/136 | 59.7% | 0.0% | 100.0% of 17 | 48/48 |

search exact-lookup floor: 48/48
identity: member recall 32/32, leaks 0, foreign rows 3 {"trusted-local":1,"remote-default":0,"remote-team":0,"remote-both":1,"local-team":1}

Verdict: fail
  resolver: b3_f1 0.762 < 0.9
  resolver: unresolved_rate 0.311 > 0.1
  recall: b3_f1 0.778 < 0.9
  recall: unresolved_rate 0.301 > 0.1
  remember: b3_f1 0.762 < 0.9
  remember: fragmentation_rate 0.311 > 0.1
  resolve_on_save: b3_f1 0.762 < 0.9
  resolve_on_save: unresolved_rate 0.311 > 0.1

Receipt: ~/work/evals-after/eval/reports/n4-entity-resolution/receipt.json

```

---
## Cat N6: Visibility and access leak fuzz (every read op x caller x scope)

**Status:** ✓ PASS (receipt; exit 0, 27s)

```
  Setting up brain schema (v196)...
  v142: takes.embedding resized to vector(1024); existing take vectors cleared
[n6] gbrain 0.60.37.0 (pinned); 155 operations, 74 read ops fuzzed; presence ok
[backup] checked 1 asset(s): 1 without a git remote (computed_by=serve)
[n6] entity                       probes=54 signal=20 leaks=0 oracles=0
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[gbrain] vector search unavailable (no_gateway_config) — results are keyword-only. Run `gbrain doctor` to diagnose.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[n6] synthesize                   probes=54 signal=0 leaks=0 oracles=0
[n6] get_page                     probes=162 signal=102 leaks=0 oracles=0
[n6] list_pages                   probes=378 signal=372 leaks=0 oracles=0
[n6] fetch                        probes=54 signal=16 leaks=0 oracles=0
[n6] search                       probes=756 signal=528 leaks=0 oracles=0
[n6] query                        probes=972 signal=656 leaks=0 oracles=0
[n6] assemble_evidence            probes=486 signal=144 leaks=0 oracles=0
[n6] search_modes                 probes=6 signal=0 leaks=0 oracles=0
[n6] search_by_image              probes=162 signal=0 leaks=0 oracles=0
[n6] get_tags                     probes=54 signal=4 leaks=0 oracles=0
[n6] get_links                    probes=162 signal=24 leaks=0 oracles=0
[n6] get_backlinks                probes=162 signal=12 leaks=0 oracles=0
[n6] list_link_sources            probes=6 signal=0 leaks=0 oracles=0
[n6] traverse_graph               probes=324 signal=114 leaks=0 oracles=0
[n6] get_timeline                 probes=54 signal=4 leaks=0 oracles=0
[n6] get_versions                 probes=54 signal=16 leaks=0 oracles=0
[n6] get_brain_identity           probes=6 signal=0 leaks=0 oracles=0
[n6] list_skills                  probes=18 signal=0 leaks=0 oracles=0
[n6] get_skill                    probes=162 signal=0 leaks=0 oracles=0
[n6] list_brain_skillpack         probes=6 signal=0 leaks=0 oracles=0
[n6] advisor                      probes=6 signal=0 leaks=0 oracles=0
[n6] get_skill_asset              probes=0 signal=0 leaks=0 oracles=0 unsupported: no synthesis rule for required string param "revision"
[n6] join_brain                   probes=0 signal=0 leaks=0 oracles=0 unsupported: no synthesis rule for required string param "adapter"
[n6] sync_brain_skills            probes=0 signal=0 leaks=0 oracles=0 unsupported: no synthesis rule for required string param "installation_id"
[n6] leave_brain                  probes=0 signal=0 leaks=0 oracles=0 unsupported: no synthesis rule for required string param "installation_id"
[n6] get_raw_data                 probes=54 signal=4 leaks=0 oracles=0
[n6] resolve_slugs                probes=162 signal=66 leaks=0 oracles=0
[n6] get_chunks                   probes=54 signal=12 leaks=0 oracles=0
[n6] get_ingest_log               probes=6 signal=0 leaks=0 oracles=0
[orphans.scan] start
[orphans.scan] done
[orphans.scan] start
[orphans.scan] done
[orphans.scan] start
[orphans.scan] done
[orphans.scan] start
[orphans.scan] done
[orphans.scan] start
[orphans.scan] done
[orphans.scan] start
[orphans.scan] done
[orphans.scan] start
[orphans.scan] done
[n6] find_orphans                 probes=18 signal=8 leaks=0 oracles=0
[n6] get_calibration_profile      probes=54 signal=0 leaks=0 oracles=0
[n6] takes_list                   probes=54 signal=12 leaks=0 oracles=0
[n6] takes_search                 probes=54 signal=4 leaks=0 oracles=0
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[think] question embed failed: AI gateway is not configured. Call configureGateway() during engine connect.
[n6] think                        probes=54 signal=32 leaks=0 oracles=0
[n6] takes_scorecard              probes=54 signal=0 leaks=0 oracles=0
[n6] takes_calibration            probes=54 signal=0 leaks=0 oracles=0
[n6] whoami                       probes=6 signal=0 leaks=0 oracles=0
[n6] sources_list                 probes=6 signal=0 leaks=0 oracles=0
[n6] sources_status               probes=54 signal=0 leaks=0 oracles=0
[n6] request_tools                probes=24 signal=0 leaks=0 oracles=0
[n6] get_recent_salience          probes=162 signal=90 leaks=0 oracles=0
[n6] find_anomalies               probes=6 signal=0 leaks=0 oracles=0
[n6] chronicle_day                probes=54 signal=4 leaks=0 oracles=0
[n6] chronicle_on_this_day        probes=54 signal=0 leaks=0 oracles=0
[n6] chronicle_since              probes=54 signal=12 leaks=0 oracles=0
[n6] chronicle_last_seen          probes=54 signal=20 leaks=0 oracles=0
[n6] ontology_get                 probes=54 signal=4 leaks=0 oracles=0
[n6] ontology_dimensions          probes=6 signal=0 leaks=0 oracles=0
[n6] ontology_conflicts           probes=6 signal=0 leaks=0 oracles=0
[n6] volunteer_chronicle          probes=54 signal=4 leaks=0 oracles=0
[n6] volunteer_context            probes=54 signal=0 leaks=0 oracles=0
[n6] extraction_pending           probes=6 signal=0 leaks=0 oracles=0
[n6] entity_identity_list         probes=54 signal=0 leaks=0 oracles=0
[n6] recall                       probes=540 signal=164 leaks=0 oracles=0
[n6] context_pack                 probes=54 signal=36 leaks=0 oracles=0
[n6] delta                        probes=54 signal=36 leaks=0 oracles=0
[n6] find_contradictions          probes=216 signal=0 leaks=0 oracles=0
[n6] find_experts                 probes=54 signal=0 leaks=0 oracles=0
[n6] find_trajectory              probes=216 signal=16 leaks=0 oracles=0
[n6] code_callers                 probes=162 signal=0 leaks=0 oracles=0
[n6] code_callees                 probes=162 signal=0 leaks=0 oracles=0
[n6] code_def                     probes=54 signal=0 leaks=0 oracles=0
[n6] code_refs                    probes=54 signal=0 leaks=0 oracles=0
[n6] code_blast                   probes=162 signal=0 leaks=0 oracles=0
[n6] code_flow                    probes=162 signal=0 leaks=0 oracles=0
[n6] get_active_schema_pack       probes=6 signal=0 leaks=0 oracles=0
[n6] list_schema_packs            probes=6 signal=0 leaks=0 oracles=0
[n6] schema_stats                 probes=6 signal=0 leaks=0 oracles=0
[n6] schema_lint                  probes=6 signal=0 leaks=0 oracles=0
[n6] schema_graph                 probes=6 signal=0 leaks=0 oracles=0
[n6] schema_explain_type          probes=6 signal=0 leaks=0 oracles=0
[n6] schema_review_orphans        probes=6 signal=0 leaks=0 oracles=0
[n6] open_loops                   probes=84 signal=0 leaks=0 oracles=0
[n6] coverage 30/74 read ops; content leaks 0, existence 0, oracles 0, gate bypasses 0; receipt ~/work/evals-after/eval/reports/n6-visibility-fuzz/receipt.json

```

---
## Cat N12: Ingestion format fidelity: transcript adapters, conversation-parser patterns and attendance

**Status:** ✓ PASS (receipt; exit 0, 8s)

```
# BrainBench N12: ingestion format fidelity (gbrain 0.60.37.0, pinned)
registered: 7 transcript adapters [hermes, openclaw, codex, claude-code, grok, claude-export, chatgpt], 20 parser patterns
  Setting up brain schema (v196)...
  v142: takes.embedding resized to vector(1024); existing take vectors cleared
  Setting up brain schema (v196)...
  v142: takes.embedding resized to vector(1024); existing take vectors cleared

verdict: pass (safety contracts only); promotion rules: safety 4/4, quality 2/2
safety: fabricated turns 0 of 16 negative items; noise leaks 0; invented timestamps 0; false attendance 0
floors: control conversation recovered in 27 of 27 rendered formats; ## Attendees recall 100.0%
coverage: 27 of 27 registered formats rendered
adapters: role 100.0% of 266 turns; timestamp exact 100.0% of 266; turn-count MAE 0.00 over 56 files; detection 56/56
roundtrip (adapter -> page -> parser): speaker 100.0% of 266; timestamp exact (minute) 100.0% of 266
parser: speaker 100.0% of 760 turns; timestamp exact (minute) 100.0% of 532 timed turns; turn-count MAE 0.00 over 160 pages; pattern detection 160/160
attendance: precision 100.0%, recall 83.3% of 30 attendees (documented forms: recall 100.0% of 20)
gaps: generic JSON detected as nothing (parser no_match); 1970-01-01 fallback on 494 of 494 date-less turns with no page date; seconds dropped on 36 turns
runtime: 7.8s
receipt: ~/work/evals-after/eval/reports/n12-format-fidelity/receipt.json

```

---
## Cat N13: Code intelligence readiness scout (six code_* ops, one pinned TypeScript repo)

**Status:** ✓ PASS (receipt; exit 0, 4s)

```
# BrainBench N13: code-intelligence readiness scout (gbrain 0.60.37.0, pinned)
  Setting up brain schema (v196)...
  v142: takes.embedding resized to vector(1024); existing take vectors cleared
imported 5 files in 344 ms; resolver 18 ms

verdict: pass (report-only scout; nothing gates)
readiness: 6/6 ops answer the trusted call, 6/6 non-empty on the probe symbol, 6/6 refuse remote callers, 4/6 have a named CLI command
  code_def: ok, 1 answers, status ready, 21 ms; remote refused; cli code-def
  code_refs: ok, 18 answers, status ready, 4 ms; remote refused; cli code-refs
  code_callers: ok, 9 answers, status ready, 5 ms; remote refused; cli code-callers
  code_callees: ok, 6 answers, status ready, 3 ms; remote refused; cli code-callees
  code_blast: ok, 3 answers, status ready, 26 ms; remote refused; cli none
  code_flow: ok, 2 answers, status ready, 18 ms; remote refused; cli none
code_def: top-1 location right for 49 of 50 top-level functions (any result right: 50)
code_refs: 134 of 296 returned chunks hold only a substring, no semantic reference; 167 of 171 compiler references covered
code_callers: same-file calls found 42/42, cross-file 12/12; resolved flag true on 72 of 91 edges, resolved in metadata on 72
runtime: 3.7s
receipt: ~/work/evals-after/eval/reports/n13-code-intelligence/receipt.json

```

---
## Cat N7: Open loops on Gmail-shaped threads: turn-flip detection, closure, manual close and mute

**Status:** ✓ PASS (receipt; exit 0, 3s)

```
# BrainBench N7: open loops on Gmail-shaped threads (gbrain 0.60.37.0, pinned)
  Setting up brain schema (v196)...
  v142: takes.embedding resized to vector(1024); existing take vectors cleared
detecting 136 threads at 2026-10-01T12:00:00.000Z
replaying 32 store scenarios
verdict: pass
safety contracts (target 0):
  excluded_class_loops: 0
  calendar_closes: 0
  manual_close_reverted: 0
  muted_new_loops: 0
  remote_evidence_leaks: 0
quality:
  planted-loop recall: 100.0% (53 of 53 planted loops; floor 80%)
  planted-loop precision: 100.0% (53 of 53 opens)
  closure accuracy: 100.0% (34 of 34; floor 95%)
  counterparty accuracy: 100.0% (53 of 53; floor 95%)
  backfill nudges detected: 6 of 6 inbound, 4 of 4 outbound follow-ups
  acknowledgement closes: 0 of 4 store rounds
gbrain findings:
  N7-2 [feature-gap] src/core/google/loop-detect.ts detectThreadLoop (turn flip is the only close signal): bun docs/benchmarks/2026-10-01-n7-open-loops-email/repro/n7-2-thanks-closes.ts
  N7-3 [feature-gap] src/core/google/loops-extract.ts runLoopsExtract; src/core/loops/loops-store.ts upsertOpenLoop: bun docs/benchmarks/2026-10-01-n7-open-loops-email/repro/n7-3-fulfillment-gap.ts
  N7-4 [feature-gap] src/core/connectors/providers/; src/core/google/loop-detect.ts calendar exclusion: ls node_modules/gbrain/src/core/connectors/providers/ && grep -n "isCalendarSystemMail" node_modules/gbrain/src/core/google/loop-detect.ts
  N7-5 [feature-gap] src/core/ops/loops.ts rankGroups (Date.now() in the score): bun docs/benchmarks/2026-10-01-n7-open-loops-email/repro/n7-5-ranking-clock.ts
receipt: ~/work/evals-after/eval/reports/n7-open-loops-email/receipt.json

```

---
## Cat N8: Unsolicited recall: volunteer_context and turn_context final delivery across sessions

**Status:** ✓ PASS (receipt; exit 0, 56s)

```
# BrainBench N8: unsolicited recall at final delivery (gbrain 0.60.37.0, pinned)
  Setting up brain schema (v196)...
  v142: takes.embedding resized to vector(1024); existing take vectors cleared
mechanics: 52 sessions, 186 user turns
[gbrain] vector search unavailable (no_gateway_config) — results are keyword-only. Run `gbrain doctor` to diagnose.
sweep: 10 thresholds
associative: 277 sources, 480 probes
verdict: pass (report-only)
delivery contracts (target 0, report-only):
  private_pages_delivered_remote: 0
  private_pages_delivered_turn_context: 0
  withdrawn_pages_delivered: 0
  redelivered_with_prior_context: 0
quality (volunteer_context, trusted local, prior_context passed, default gate):
  proactive recall, alias and exact-title triggers: 100.0%; all triggers 90.0% (54 of 60)
    trigger_title: 24 of 24
    trigger_alias: 18 of 18
    trigger_surname: 12 of 12
    trigger_slug_suffix: 0 of 6
  false-alarm rate, innocuous and no-mention turns: 0.0%; common-word turns 50.0% (12 turns)
  tokens per turn: mean 24.6, p95 73; turn_context mean 22.1
  redundant deliveries per session without prior_context: 1.87
  sweep (min_confidence: recall / false-alarm rate on all negative turns): 0.5: 100.0% / 7.5%, 0.55: 100.0% / 7.5%, 0.6: 100.0% / 7.5%, 0.65: 100.0% / 7.5%, 0.7: 90.0% / 7.5%, 0.75: 90.0% / 7.5%, 0.8: 70.0% / 7.5%, 0.85: 70.0% / 7.5%, 0.9: 30.0% / 7.5%, 0.95: 30.0% / 7.5%
  associative (report-only gap): volunteer indirect any-hit 0.0% of 240, negatives strict FA 0.0%, adjudicated 0.0%; keyword search top 3: 79.2%, strict FA 100.0%, adjudicated 100.0%
gbrain findings:
  N8-3 [feature-gap] src/core/context/entity-salience.ts candidate extraction + alias arm of resolveEntitiesToPointers: bun docs/benchmarks/2026-10-01-n8-proactive-recall/repro/n8-3-common-word-alias.ts
  N8-4 [feature-gap] volunteer_context op; assembleTurnContext: bun eval/runner/n8-proactive-recall.ts  (the "associative" line; data.quality.associative in the receipt)
receipt: ~/work/evals-after/eval/reports/n8-proactive-recall/receipt.json

```

---
## Cat N2: Contradiction surfacing: candidate discovery, classification and resolution proposals

**Status:** ✓ PASS (receipt; exit 0, 65s)

```
# BrainBench N2: contradiction surfacing (gbrain 0.60.37.0, pinned)
  Setting up brain schema (v196)...
  v142: takes.embedding resized to vector(1024); existing take vectors cleared
seeding 825 pages
oracle-recording probe over 270 queries
[gbrain] vector search unavailable (no_gateway_config) — results are keyword-only. Run `gbrain doctor` to diagnose.
  Setting up brain schema (v196)...
  v142: takes.embedding resized to vector(1024); existing take vectors cleared
amara: 98 pages, 15 pairs

verdict: pass
safety: applied mutations 0 (target 0); judge exceptions counted as verdicts 0 (target 0)
candidate recall of same-time conflicts: 100.0% (150/150); floor 50%
  both pages in the top 5 of their own query: 100.0% (150/150)
  negatives offered: dated changes 66.7% (40/60), compatible 85.0% (51/60)
oracle-judge ceiling: end-to-end conflict recall 100.0% (150/150); proposals acceptable 100.0% (190/190)
discovery without a company name: 4/150 planted conflicts offered by 8 generic queries
dates seen by the judge: 0/190 undated planted pages shown with a date; pairs skipped by the date filter 20
gbrain findings: see docs/benchmarks/2026-10-01-wave-bugs.md (N2-*)
receipt: ~/work/evals-after/eval/reports/n2-contradiction-surfacing/receipt.json

```

---
## Cat A4: Abstention: the CRAG grade against evidence sufficiency, and a fixed answerer against answerability

**Status:** ✓ PASS (receipt; exit 0, 26s)

```
# BrainBench A4: abstention (gbrain 0.60.37.0, pinned)
  Setting up brain schema (v196)...
  v142: takes.embedding resized to vector(1024); existing take vectors cleared
querying 240 questions
[gbrain] vector search unavailable (no_gateway_config) — results are keyword-only. Run `gbrain doctor` to diagnose.

verdict: pass
quality: crag meta on 100.0% of 240 query calls (target 100%); answer text in the top 5 for 100.0% of 120 answerable (floor 80%)
CRAG grade by class: {"answerable_profile":{"strong":0,"moderate":20,"weak":40,"missing":0},"answerable_note":{"strong":0,"moderate":20,"weak":40,"missing":0},"missing_attribute":{"strong":0,"moderate":0,"weak":50,"missing":0},"sibling_attribute":{"strong":0,"moderate":0,"weak":40,"missing":0},"absent_entity":{"strong":0,"moderate":0,"weak":30,"missing":0}}
entity-name lookups, grade by class: {"answerable_profile":{"strong":60,"moderate":0,"weak":0,"missing":0},"answerable_note":{"strong":60,"moderate":0,"weak":0,"missing":0},"missing_attribute":{"strong":50,"moderate":0,"weak":0,"missing":0},"sibling_attribute":{"strong":40,"moderate":0,"weak":0,"missing":0},"absent_entity":{"strong":0,"moderate":0,"weak":30,"missing":0}}
strong on unanswerable: 0/120 ({"missing_attribute":"0/50","sibling_attribute":"0/40","absent_entity":"0/30"})
  answer when grade >= strong: coverage 0.0%, risk (no evidence) n/a, risk (unanswerable) n/a
  answer when grade >= moderate: coverage 16.7%, risk (no evidence) 0.0%, risk (unanswerable) 0.0%
  answer when grade >= weak: coverage 100.0%, risk (no evidence) 50.0%, risk (unanswerable) 50.0%
S4 could not abstain on 0/120 unanswerable questions even if on ({"missing_attribute":"0/50","sibling_attribute":"0/40","absent_entity":"0/30"}); S4 on arm: not run
gbrain findings: see docs/benchmarks/2026-10-01-wave-bugs.md (A4-*)
receipt: ~/work/evals-after/eval/reports/a4-abstention/receipt.json

```

---
## Cat SO: System One (Jev decision support) record: datasets, receipts and pair definitions

**Status:** ✓ PASS (receipt; exit 0, 1s)

```
ok   s2-intent:hashes: 59d0d17abfbeba15 be9564887bf21a74
ok   s5-injection:hashes: 9eafb629a0ab28a6 edde14e1853279ed
ok   s6-brainbench:hashes: 30b665c7f8230b9b 483d9f1aa5493e2d
ok   s6-extra:hashes: 379e5e7b593e7914 7b76176e54d8a2e5
ok   s6-combined:hashes: 274eefc9b571d677 fbdf426421cf8718
ok   s9-conflict:hashes: 37fe4083e9722308 2ec631956c4b9e33
ok   s9-conflict-sweep-eligible:hashes: 7dbf17fb5073d9e9 ea1f192b0ed16c14
ok   s7-triage:staged-inputs: staged tree c374577bc42be5a6 from eval/data/transcript-distill-v1 + s7-triage-synthetic
ok   s8-grounding:staged-inputs: staged tree b0028e68148af6cc from eval/data/transcript-distill-v1 + s8-grounding/labels.jsonl
ok   input:know-to-ask-extra: dca918343ec06083
ok   input:s7-triage-synthetic: c09ccde6bf83943d
ok   input:s8-grounding/labels.jsonl: b10020e44f71b07d
ok   input:s9-conflict/pairs.jsonl: c7b92c4427d72eb8
ok   input:s9-conflict/pairs.sweep-eligible.jsonl: af5ee8b5b8eff400
ok   input:longmemeval/s-eval-half.txt: 9bedfed286862ece
ok   input:longmemeval/s-eval-judged-100.txt: 24fbbe6f6f502fb6
ok   input:longmemeval/m-pilot-28.txt (derived): ef44c8ea066caa41
ok   input:preset-dream-29.txt: b32a0d24d1a51972
ok   cat35-not-duplicated: Cat 35 transcripts are read from eval/data/transcript-distill-v1 only
ok   receipts:verbatim: 77 upstream files byte-identical
ok   recount:s7-triage-pair: s7/summary.json reproduced from the four arm files
ok   recount:s1/longmemeval-s-summary.json: 8 arms reproduced from committed rows
ok   recount:s1/longmemeval-m-pilot-summary.json: 5 arms reproduced from committed rows
ok   recount:s3/longmemeval-decide-arms-summary.json: 4 arms reproduced from committed rows
ok   recount:spend: ledgers total $24.95 (eval $22.44, datasets $2.52)
ok   verdicts:pointers: 174 numbers match their receipts
ok   verdicts:all-slots: S1 S2 S3 S4 S5 S6 S7 S8 S9
ok   definition:s1-rerank-lme-s: longmemeval, 8 arm(s)
ok   definition:s1-rerank-lme-m-pilot: longmemeval, 5 arm(s)
ok   definition:s1-rerank-judged: longmemeval, 2 arm(s)
ok   definition:s2-intent-lme: longmemeval, 2 arm(s)
ok   definition:s2-intent-routing: recorded-answers, recorded arm(s)
ok   definition:s3-evidence-lme: longmemeval, 3 arm(s)
ok   definition:s4-answerable-values: recorded-answers, recorded arm(s)
ok   definition:s5-injection-values: recorded-answers, recorded arm(s)
ok   definition:s6-recall-needed-brainbench: brainbench, 4 arm(s)
ok   definition:s6-recall-needed-values: recorded-answers, recorded arm(s)
ok   definition:s7-triage-pair: triage-pair, 4 arm(s)
ok   definition:s8-grounding-values: recorded-answers, recorded arm(s)
ok   definition:s9-conflict-values: recorded-answers, recorded arm(s)
ok   definition:judge-agreement-longmemeval: judge-agreement, 1 arm(s)
ok   definition:judge-agreement-grounding: judge-agreement, 1 arm(s)

System One v1 record: 42/42 checks pass -> pass
Receipt: ~/work/evals-after/eval/reports/system-one-jev/receipt.json

```

---
## Cat N9: Multi-hop with held-out wording: composed 2-3-hop questions, relational retrieval off vs on

**Status:** ✓ PASS (receipt; exit 0, 36s)

```
Relational OFF/ON: 3 ingestion seeds in parallel processes, 540 paired queries each (keyword)
Relational OFF/ON: ingestion seed 1 finished in its own process
Relational OFF/ON: ingestion seed 2 finished in its own process
Relational OFF/ON: ingestion seed 3 finished in its own process
verdict: pass
safety contracts: none preregistered (report-only category)
composed-template: strict all-hit@10 off 2.7% -> on 2.7% over 375 runs; distinct questions on-better 0 / worse 0 / same 125 (sign test p=1.000); fired 0/375, parsed 177/375, seed resolved 0/375
composed-paraphrase: strict all-hit@10 off 1.3% -> on 1.3% over 375 runs; distinct questions on-better 0 / worse 0 / same 125 (sign test p=1.000); fired 0/375, parsed 129/375, seed resolved 0/375
capability composed-template: composed plans 0/125, parsed as one relation 59/125
capability composed-paraphrase: composed plans 0/125, parsed as one relation 43/125
presence: seed 1 78/78, seed 2 78/78, seed 3 78/78
gbrain feature-gap N9-1: 0 of 250 composed wordings (125 questions x 2) produced a multi-relation plan; 102 parsed as one relation (0 first hop, 102 last hop), 102 with a seed that is not exactly the anchor name - repro: bun docs/benchmarks/2026-10-01-capability-matrix/probes/p7-relational.ts; bun eval/runner/n9-multi-hop-paraphrase.ts (data.capability)
receipt: eval/reports/n9-multi-hop-paraphrase/sweep-2463b74b-f49b-43e5-acba-b19cd4913075/receipt.json

```

---
## Cat N1-ci: Knowledge update CI slice: four ledger entities on one PGLite stdio MCP cell

**Status:** ✓ PASS (receipt; exit 0, 60s)

```
# BrainBench N1 CI slice: knowledge update and supersession (gbrain 0.60.37.0, pinned)
[n1] start pglite/mcp-stdio
[n1] n1-pglite-mcp-stdio updated: 36/36 probes pass, 0 stale
[n1] n1-pglite-mcp-stdio restart: 36/36 probes pass, 0 stale
[n1] n1-pglite-mcp-stdio reimport: 36/36 probes pass, 0 stale
[n1] n1-pglite-mcp-stdio concurrent: 41/41 probes pass, 0 stale
[n1] done n1-pglite-mcp-stdio in 56s
  Setting up brain schema (v196)...
  v142: takes.embedding resized to vector(1024); existing take vectors cleared

verdict: pass
safety contracts (PGLite cells, 1 cells):
  stale values served as current: 0 of 121 current-value and history probes
  private values in remote responses: 0 (exposure probes with signal: 12 of 12)
  acknowledged writes lost: 0
quality metrics:
  current-value accuracy: 100.0% (64 of 64 current-value probes)
  history retained: 100.0% (57 of 57 history probes)
  negative controls: 28 of 28
  in-process ontology arm (unmanaged engine, exploratory): current 100.0% of 12, stale 0, as-of 100.0%, remote leaks 0
promotion rules: pass (none failed)
gbrain findings: see docs/benchmarks/2026-10-01-wave-bugs.md (N1-*)
receipt: eval/reports/n1-knowledge-update/sweep-089a3723-6b1e-4255-825f-b9409b4e8551/receipt.json

```

---
## Cat N5-ci: Forgetting residue CI slice: two ledger entities on one PGLite stdio MCP cell

**Status:** ✓ PASS (receipt; exit 0, 75s)

```
# BrainBench N5 CI slice: forgetting and withdrawal residue (gbrain 0.60.37.0, pinned)
[n5] start pglite/mcp-stdio
[n5] n5-pglite-mcp-stdio witness: 63 present of 77 pairs
[n5] n5-pglite-mcp-stdio immediate: 48 present of 84 pairs
[n5] n5-pglite-mcp-stdio settled: 48 present of 84 pairs
[n5] n5-pglite-mcp-stdio stale_reimport: 42 present of 84 pairs
[n5] n5-pglite-mcp-stdio restart: 42 present of 84 pairs
[n5] n5-pglite-mcp-stdio concurrent: 42 present of 91 pairs
[n5] done n5-pglite-mcp-stdio in 75s

verdict: pass
safety contracts (PGLite cells, 1 cells):
  prohibited active outputs after forget: 0 (forgotten pairs with a witness: 27, without: 8)
  reactivations: 0
  collateral expirations: 0
  unauthorized forgets applied: 0
  private canaries in remote responses: 0
quality metrics:
  retained-neighbor recall: 100.0% (120 of 120 witnessed retained pairs over post-forget checkpoints)
  reinstatement: 100.0% (1 of 1 corrected claims)
  retained recall with the capped context_pack tier included (erratum, not gated): 100.0%
  remote responses whose _meta hot memory carried a forgotten canary (not gated): 0
  paraphrase still active after forget (documented gap): 2 of 2
promotion rules: pass (none failed)
gbrain findings: see docs/benchmarks/2026-10-01-wave-bugs.md (N5-*)
receipt: eval/reports/n5-forget-residue/sweep-89321ab9-5968-4a91-ad4d-4cc530c9e6fb/receipt.json

```

---
## How to reproduce

```bash
bun eval/runner/all.ts --tier offline   # keyless categories
bun eval/runner/all.ts --tier paid --paid --budget-run-id <id>   # provider-backed categories (spends money)
bun eval/runner/all.ts --tier all --paid --budget-run-id <id>
bun eval/runner/all.ts --only <ids-or-aliases>   # a subset, e.g. --only N3,N4,N6
```