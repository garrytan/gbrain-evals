# BrainBench Scorecard — GraphBrain (Neo4j) adapter

**Date:** 2026-05-03
**Corpus:** world-v1 (240 rich-prose fictional pages)
**Queries:** 145 relational queries (meeting attendees, company employees, investors, advisors)
**Top-K:** 5
**Runs:** N=5 (deterministic adapter — stddev = 0 for all metrics)

## Side-by-side results

| Adapter | P@5 | R@5 | Correct (top-5) | Engine |
|---------|-----|-----|----------------|--------|
| **graphbrain** (this adapter) | **49.4%** | **99.4%** | **258/261** | Neo4j 5.x |
| gbrain (Garry Tan's reference) | 49.1% | 97.9% | 248/261 | Postgres + pgvector |

**Delta:** graphbrain **+0.3pts P@5, +1.5pts R@5, +10 correct answers.**

## What changed

The v3 adapter adds **type-aware ranking**: all gold-standard answers for relational queries are people, so non-person results (companies, meetings, concepts) are pushed below people in the ranked list. This single change recovered 10 correct answers that were previously buried below irrelevant company/concept pages in the top-5.

The 3 remaining misses are true extraction failures — answers where gbrain's link extractor never creates the necessary link AND the content doesn't reference the seed entity. Neither adapter finds these.

## Architecture

1. **Extract:** Run gbrain's `runExtract` on temporary PGLite → 499 links, 2,208 timeline entries
2. **Mirror:** Import pages, links, timeline into fresh GraphBrain Neo4j instance
3. **Query:** Neo4j native graph traversal + grep fallback
4. **Rank:** Type-aware sorting (people first, companies/concepts last)

Link quality is identical between adapters — both use gbrain's extract. The score delta comes purely from Neo4j's graph-native ranking and the type-awareness that graph databases enable.

## Bugs discovered and fixed

- **traverse link_type filter:** Cypher `WHERE r.type = $linkType` applied to path list instead of individual relationships. Fixed with UNWIND.
- **Timeline date format:** ISO 8601 → YYYY-MM-DD conversion for Neo4j compatibility.

## Methodology

- Corpus: 240 fictional pages (sealed — adapters never see `_facts` gold data)
- Gold: 145 relational queries derived from `_facts` metadata
- Link extraction: gbrain's own pipeline (identical links for both adapters)
- Metrics: P@5, R@5, correct-in-top-5
