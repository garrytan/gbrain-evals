# Structure-aware chunks: results

Date: 2026-10-28. Thread GBRA-234. Preregistration: [2026-10-28-structure-aware-chunks-preregistration.md](2026-10-28-structure-aware-chunks-preregistration.md), committed and pushed in a763ddde before any live cell. Runner: [`eval/runner/structure-aware-chunks.ts`](../../eval/runner/structure-aware-chunks.ts). Raw summaries, per-question rows, the no-op guard and the plan are in [2026-10-28-structure-aware-chunks/](2026-10-28-structure-aware-chunks/).

## Verdict

No contrast met the preregistered rule, so none of the three ideas earns a build proposal from this run.

Idea 1 (heading path in the embedding prefix) is the only one that moved. On Qasper it raised hit@3 from 80.0% to 81.7% (+31/−16, exact p = 0.040) and the chunk gbrain actually returns for the page from 48.5% to 52.6% (+71/−35), with no Cat 13 or Cat 13b regression. On messy-company it went the other way on hit@3 (76.9% to 74.4%, +2/−3 of 39), so the "up on both corpora" condition fails and the pooled test misses (p = 0.070). This is the case the preregistration names as "one corpus moves and the other is flat": a larger run would only be worth it on a second heading-rich, business-document corpus with enough questions to resolve a 2-point effect, because 39 messy-company questions can show direction only.

Idea 2 (chunks start at headings) adds nothing detectable on top of idea 1 (+12/−10 pooled, Holm p = 1.0) and is not significant alone (+20/−12, Holm p = 0.86). The keyless arms (heading terms in `search_vector`, heading-led chunks without embeddings) are flat on every corpus.

## Numbers

All cells: 0 errors, no deferred embedding, pins read back as `balanced`, reranker off, expansion off. hit@k on `aw` counts `hybridSearch` rows (one chunk per page); on `a` and `b` it ranks the page's chunks by RRF over the keyword and vector chunk legs. Lead hit is whether `hybridSearch`'s single row for the page holds the gold passage.

| Cell | Docs | Questions | hit@1 | hit@3 | Lead hit | Embedding USD |
|---|---|---|---|---|---|---|
| aw.base | 118 | 39 | 46.2 | 76.9 | 46.2 | 0.0090 |
| aw.prefix | 118 | 39 | 51.3 | 74.4 | 51.3 | 0.0067 |
| aw.lead | 118 | 39 | 46.2 | 76.9 | 46.2 | 0.0014 |
| aw.prefix_lead | 118 | 39 | 48.7 | 71.8 | 48.7 | 0.0014 |
| aw.kw_* (all four) | 118 | 39 | 53.8 | 76.9 | 53.8 | 0 |
| b.base | 271 | 880 | 47.3 | 80.0 | 48.5 | 0.1998 |
| b.prefix | 271 | 880 | 49.9 | 81.7 | 52.6 | 0.2006 |
| b.lead | 271 | 880 | 49.2 | 80.9 | 51.4 | 0.0721 |
| b.prefix_lead | 271 | 880 | 51.1 | 82.0 | 54.5 | 0.0729 |
| b.kw_base | 271 | 880 | 23.2 | 35.3 | 39.2 | 0 |
| b.kw_lead | 271 | 880 | 23.4 | 35.2 | 38.9 | 0 |
| b.kw_terms | 271 | 880 | 23.8 | 35.6 | 39.4 | 0 |
| b.kw_lead_terms | 271 | 880 | 23.9 | 35.6 | 39.3 | 0 |
| a (within-document, reported only) base / prefix | 2 | 10 | 70.0 / 80.0 | 90.0 / 90.0 | 70.0 / 80.0 | 0 (cached) |

| Contrast | Role | hit@3 net on aw | hit@3 net on b | Pooled aw+b hit@3 | Pooled p | Cat 13 / 13b | Rule met |
|---|---|---|---|---|---|---|---|
| prefix vs base | primary | +2/−3 | +31/−16 (p 0.040) | 81.4 vs 79.9 | 0.070 | no regression | no |
| lead vs base | secondary | 0/0 | +20/−12 | 80.7 vs 79.9 | 0.22 (Holm 0.86) | no-op (guard) | no |
| prefix_lead vs prefix | secondary | +0/−1 | +12/−9 | 81.6 vs 81.4 | 0.83 (Holm 1.0) | no regression | no |
| kw_terms vs kw_base | secondary | 0/0 | +4/−2 | 37.3 vs 37.1 | 0.69 (Holm 1.0) | no regression | no |
| kw_lead vs kw_base | secondary | 0/0 | +1/−2 | 37.0 vs 37.1 | 1.0 (Holm 1.0) | no-op (guard) | no |
| prefix_lead vs base | descriptive | +1/−3 | +40/−22 (p 0.030) | 81.6 vs 79.9 | 0.064 | no regression | — |

**No-regression check.** Cat 13 nDCG@5: base 0.5587, prefix 0.5618 (strict P@1 59.7% vs 59.9%, +1/−0). Cat 13b top-1: 28 of 30 in both arms, top-3 30 of 30, 0 errors. Keyless Cat 13: kw_base and kw_terms both 0.4606; Cat 13b keyless 28 of 30 in both. The guard shows the lead arms produce chunks and embedding inputs identical to base on every Cat 13 and Cat 13b page; prefix changes one chunk per page there (the `## Timeline` section).

**Chunking cost of idea 2.** On Qasper, headingsLead changes 2,622 chunks to 2,631 (+0.3%), so a rechunk would be cheap; it simply does not help.

## What the messy-company misses look like

The three `aw` hit@3 losses under the prefix are all `discount_pct` questions where a sibling contract page of the same account (a redline or an affiliate amendment) displaced the signed contract in third place. Those pages share the same section headings, so adding the heading path to each chunk's embedding makes them look more alike. Two of the wins kept the same three pages but returned the deciding chunk of the contract page instead of another chunk. Three rows are too few to call this a mechanism, but it is the failure a heading prefix would be expected to cause on corpora full of near-duplicate templated documents.

## Cost

$0.60 of `text-embedding-3-large` embeddings from provider-reported tokens (cells sum to $0.5955), against the $15 cap and a $6.60 worst-case reservation. No paid model calls: no reranker, no expansion, no LLM reader or judge.

## Limits

- Development evidence only. Messy-company held-out was not touched.
- Corpus A's deciding measurement (`aw`) has 39 questions, so it shows direction, not significance. That limit was stated in the preregistration.
- Qasper's evidence is paragraph-grain and its papers are long and heading-rich, which is the setting most favourable to heading signals. A gain there and nothing on business documents is consistent with the signal mattering mainly for long, well-sectioned documents.
- The keyless terms arm is simulated with SQL after import; a shipped version would store the heading path, which could weight it differently.
