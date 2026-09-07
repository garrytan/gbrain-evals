# Cat 13 — Phase E1 gap localization (tuning split)

Generated: 2026-09-06T03:59:19.047Z · gbrain 0.48.2.0 (pin github:garrytan/gbrain#5cfb84f1d3a809c70064c292c23db3d538d5c551)
Embeds: live voyage:voyage-4 @ 1024d
Search pins: search.mode=balanced search.reranker.enabled=false search.autocut=false · resolved mode=balanced limit=30 innerLimit=60 tokenBudget=12000 title_boost=1.25 graph_signals=true intentWeighting=true keywordOrFallback=true
Concept split: seed=42, 20 tuning / 10 held-out (held-out never queried)
Probes: 548 generated, 359 tuning-subset, 359 measured

One query-side embedding per probe is shared by every arm (hybridSearch `queryEmbedFn`), so the vector-arm ranking and hybrid's vector list are the same list by construction.

## Ladder — tuning nDCG@5 (×100) by ranking

| ranking | nDCG@5 | P@1 | what it is |
|---|---|---|---|
| E0-V1 `vector` adapter (receipt, tuning) | 59.6 | 73.5 | one document-side vector per page; document-side query embed; no source factor |
| page-vector replica, document-side query embed (this run) | 59.6 | 73.5 | replicates the E0 `vector` adapter on the same pages |
| page-vector replica, query-side query embed (this run) | 58.7 | 73.3 | same page vectors, gbrain's query-side embed |
| gbrain vector arm — engine.searchVector, page-collapsed (this run) | 60.3 | 75.2 | chunk-grain HNSW, best chunk per page, source factor applied; the arm hybrid fuses |
| re-simulated: vector_only | 60.3 | 75.2 | vector arm alone (sanity: should equal the live arm order) |
| re-simulated: no_lexical_no_boosts | 60.3 | 75.2 | both lexical arms AND the post-fusion block together (vector arm + cosine blend + dedup only) |
| re-simulated: no_lexical_arms | 51.5 | 56.0 | both lexical arms together (keyword + title) |
| re-simulated: no_title_arm | 50.1 | 52.6 | title arm — page-grain FTS candidate generator (engine.searchTitles) fused at keywordK |
| re-simulated: no_keyword_arm | 51.7 | 56.8 | strict keyword arm (chunk-grain AND FTS) fused at keywordK |
| re-simulated: no_cosine_blend | 44.3 | 41.2 | cosine re-score blend (0.7 · normalized RRF + 0.3 · raw query↔chunk cosine) |
| re-simulated: no_post_fusion_boosts | 58.2 | 68.8 | post-fusion boosts (backlink / salience / recency / title-phrase 1.25x / graph signals / alias-resolved / exact-match) |
| re-simulated: no_backlink_boost | 55.8 | 66.0 | backlink boost alone (1 + 0.05·ln(1 + inbound links), applyBacklinkBoost) |
| re-simulated: no_graph_signals | 51.5 | 56.3 | graph signals alone (adjacency-within-top-K 1.05x, cross-source 1.10x, session demote 0.95x) |
| re-simulated: no_recency_boost | 51.9 | 54.0 | recency boost alone (per-prefix half-life decay; fires on temporal intent) |
| re-simulated: no_salience_boost | 50.6 | 54.0 | salience boost alone (emotional_weight + take_count) |
| re-simulated: no_title_phrase_boost | 50.6 | 54.0 | title-phrase boost alone (1.25x when the query is a token-run of the title) |
| re-simulated: no_exact_match_boost | 50.6 | 54.0 | intent exact-match boost alone (entity 1.25x / event 1.10x on slug or title equality) |
| re-simulated: no_compiled_truth_boost | 50.6 | 54.0 | compiled-truth 2x after RRF normalization (detail=low only) |
| re-simulated: no_dedup | 50.6 | 54.0 | dedup / per-page collapse (type-diversity cap, compiled-truth swap) + slice + token budget |
| re-simulated: full | 50.6 | 54.0 | live pipeline (re-simulated) |
| gbrain hybrid live (this run) | 50.6 | 54.0 | hybridSearch, balanced, reranker off, autocut off, limit 30 |
| E0-V1 `gbrain` adapter (receipt, tuning) | 50.6 | 54.0 | should match the live row above within embedding noise |

## Simulation fidelity

The `full` re-simulation (same functions hybrid.ts calls, fed the re-fetched arm lists) reproduced the live hybrid page order on 359 / 359 probes at top-5 (359 / 359 over the whole returned list). Ablation numbers are only as trustworthy as this row.

## Gap / gain overview

- gap probes (vector arm has gold in top-5, hybrid ranks it lower or drops it): **105**
- gain probes (hybrid ranks gold above its vector-arm rank, within top-5): 1
- neutral: 253
- strict keyword arm non-empty: 106 / 359; title arm non-empty: 43; either lexical arm non-empty: 106
- gap probes with BOTH lexical arms empty (only the vector list + post-fusion stages could have moved gold): 73
- probes with a relaxed (AND→OR) row in the returned set: 0; detail_resolved=low (compiled-truth 2x active): 44
- intents: general=242, entity=44, concept=53, temporal=20; degraded stages: none

## Gap classes (single stage whose neutralization restores gold to <= its vector-arm rank)

| class | # | overall | body-fuzzy | company-neighborhood | description-paraphrase | semantic-neighborhood | synonym | synonym-fuzzy | title-paraphrase | title-variation |
|---|---|---|---|---|---|---|---|---|---|---|
| title_arm_injection | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| post_fusion_boost_reorder | 2 | 78 | 20 | 9 | 1 | 2 | 21 | 9 | 8 | 8 |
| cosine_blend_reorder | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| dedup_collapse | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| relaxed_keyword_fused | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| keyword_arm_injection | 6 (named) | 21 | 2 | 0 | 1 | 1 | 6 | 0 | 4 | 7 |
| lexical_arms_combined | 6 (named) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| vector_arm_mismatch | 6 (named) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| unexplained | 6 | 6 | 0 | 0 | 0 | 0 | 1 | 0 | 3 | 2 |
| **gap probes** | | **105** | 22 | 9 | 2 | 3 | 28 | 9 | 15 | 17 |

## Gold-rank delta (hybrid − vector arm) per template

| template | probes | vector nDCG@5 | hybrid nDCG@5 | improved | same | worse in top-5 | pushed out of top-5 | vector missed top-5 | both outside | mean Δ (both present) | <=-3 | -2 | -1 | 0 | +1 | +2 | +3 | >=+4 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| body-fuzzy | 63 | 25.2 | 17.2 | 0 | 7 | 16 | 6 | 1 | 33 | 2.21 (n=47) | 1 | 0 | 0 | 8 | 10 | 11 | 5 | 12 |
| company-neighborhood | 19 | 41.7 | 16.6 | 0 | 0 | 0 | 9 | 0 | 10 | 15.00 (n=13) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 13 |
| description-paraphrase | 22 | 76.2 | 73.0 | 0 | 20 | 2 | 0 | 0 | 0 | 0.09 (n=22) | 0 | 0 | 0 | 20 | 2 | 0 | 0 | 0 |
| semantic-neighborhood | 11 | 71.3 | 63.3 | 0 | 8 | 3 | 0 | 0 | 0 | 0.36 (n=11) | 0 | 0 | 0 | 8 | 2 | 1 | 0 | 0 |
| synonym | 104 | 67.1 | 58.0 | 0 | 73 | 25 | 3 | 0 | 3 | 0.66 (n=104) | 0 | 0 | 0 | 73 | 13 | 14 | 2 | 2 |
| synonym-fuzzy | 34 | 68.8 | 60.0 | 0 | 25 | 8 | 1 | 0 | 0 | 0.41 (n=34) | 0 | 0 | 0 | 25 | 5 | 3 | 1 | 0 |
| title-paraphrase | 58 | 71.1 | 61.0 | 0 | 43 | 15 | 0 | 0 | 0 | 0.52 (n=58) | 0 | 0 | 0 | 43 | 5 | 6 | 3 | 1 |
| title-variation | 48 | 70.4 | 59.2 | 0 | 31 | 16 | 1 | 0 | 0 | 0.56 (n=48) | 0 | 0 | 0 | 31 | 10 | 6 | 0 | 1 |
| **all** | 359 | 60.3 | 50.6 | 0 | 207 | 85 | 20 | 1 | 46 | 1.32 (n=337) | 1 | 0 | 0 | 208 | 47 | 41 | 11 | 29 |

## Which boost stamps ride on the intruders (gap probes)

Gap probes with at least one intruder carrying a boost: 100 / 105. By stamp (a probe counts once per stamp kind): backlink_boost=100, graph_adjacency_boost=50, recency_boost=10. Gap probes by intent: general=71, entity=12, concept=12, temporal=10.

## Top-10 non-gold pages hybrid promotes above gold (gap probes)

| page | times | via title arm | via keyword arm | vector-only | carried a boost | boost stamps | templates |
|---|---|---|---|---|---|---|---|
| companies/cipher-13 | 14 | 0 | 0 | 14 | 14 | backlink_boost×14, graph_adjacency_boost×14 | semantic-neighborhood:1, synonym:5, synonym-fuzzy:3, title-variation:2, title-paraphrase:2, description-paraphrase:1 |
| companies/lucid-21 | 9 | 0 | 2 | 7 | 9 | backlink_boost×9, graph_adjacency_boost×8 | title-paraphrase:2, synonym:3, title-variation:2, synonym-fuzzy:1, body-fuzzy:1 |
| companies/quantum-7 | 8 | 0 | 0 | 8 | 8 | backlink_boost×8, graph_adjacency_boost×8 | semantic-neighborhood:1, synonym:2, title-variation:2, title-paraphrase:2, synonym-fuzzy:1 |
| companies/gamma-2 | 6 | 0 | 0 | 6 | 6 | backlink_boost×6, graph_adjacency_boost×4, recency_boost×1 | synonym:1, title-paraphrase:1, synonym-fuzzy:1, body-fuzzy:2, company-neighborhood:1 |
| companies/gravity-17 | 6 | 0 | 0 | 6 | 6 | backlink_boost×6 | title-paraphrase:3, title-variation:3 |
| meetings/demo-day-2024-10-24-batch-9 | 6 | 0 | 2 | 4 | 4 | recency_boost×4 | synonym:3, company-neighborhood:3 |
| meetings/demo-day-2025-03-19-batch-14 | 6 | 0 | 0 | 6 | 6 | recency_boost×6 | synonym:1, company-neighborhood:5 |
| companies/mosaic-14 | 5 | 0 | 0 | 5 | 5 | backlink_boost×5, graph_adjacency_boost×5 | title-variation:2, title-paraphrase:1, synonym-fuzzy:1, semantic-neighborhood:1 |
| companies/pulse-8 | 5 | 0 | 0 | 5 | 5 | backlink_boost×5, graph_adjacency_boost×4, recency_boost×1 | body-fuzzy:2, title-paraphrase:1, title-variation:1, company-neighborhood:1 |
| meetings/demo-day-2025-02-18-batch-13 | 5 | 0 | 1 | 4 | 4 | recency_boost×4 | title-variation:1, company-neighborhood:4 |

## Mechanisms ranked by probes fixed when the stage is neutralized

| ablation | fixed | improved only | collateral (gains lost) | net | tuning nDCG@5 | Δ vs live hybrid | stage |
|---|---|---|---|---|---|---|---|
| no_lexical_no_boosts | 105 | 0 | 1 | 104 | 60.3 | +9.7 | both lexical arms AND the post-fusion block together (vector arm + cosine blend + dedup only) |
| no_post_fusion_boosts | 78 | 7 | 0 | 78 | 58.2 | +7.7 | post-fusion boosts (backlink / salience / recency / title-phrase 1.25x / graph signals / alias-resolved / exact-match) |
| no_backlink_boost | 58 | 21 | 0 | 58 | 55.8 | +5.2 | backlink boost alone (1 + 0.05·ln(1 + inbound links), applyBacklinkBoost) |
| no_keyword_arm | 21 | 3 | 1 | 20 | 51.7 | +1.1 | strict keyword arm (chunk-grain AND FTS) fused at keywordK |
| no_lexical_arms | 21 | 3 | 1 | 20 | 51.5 | +0.9 | both lexical arms together (keyword + title) |
| no_graph_signals | 8 | 16 | 0 | 8 | 51.5 | +0.9 | graph signals alone (adjacency-within-top-K 1.05x, cross-source 1.10x, session demote 0.95x) |
| no_recency_boost | 4 | 6 | 0 | 4 | 51.9 | +1.4 | recency boost alone (per-prefix half-life decay; fires on temporal intent) |
| no_cosine_blend | 1 | 4 | 0 | 1 | 44.3 | -6.3 | cosine re-score blend (0.7 · normalized RRF + 0.3 · raw query↔chunk cosine) |
| no_compiled_truth_boost | 0 | 0 | 0 | 0 | 50.6 | +0.0 | compiled-truth 2x after RRF normalization (detail=low only) |
| no_salience_boost | 0 | 0 | 0 | 0 | 50.6 | +0.0 | salience boost alone (emotional_weight + take_count) |
| no_title_phrase_boost | 0 | 0 | 0 | 0 | 50.6 | +0.0 | title-phrase boost alone (1.25x when the query is a token-run of the title) |
| no_exact_match_boost | 0 | 0 | 0 | 0 | 50.6 | +0.0 | intent exact-match boost alone (entity 1.25x / event 1.10x on slug or title equality) |
| no_dedup | 0 | 0 | 0 | 0 | 50.6 | +0.0 | dedup / per-page collapse (type-diversity cap, compiled-truth swap) + slice + token budget |
| no_title_arm | 0 | 0 | 0 | 0 | 50.1 | -0.4 | title arm — page-grain FTS candidate generator (engine.searchTitles) fused at keywordK |

## Implementable gates, projected from the recorded ablations

Where the gate's condition holds the probe takes the ablated outcome, elsewhere the live one — exact, no re-run.

| policy | applies to | fixed | improved only | collateral | net | tuning nDCG@5 | Δ vs live hybrid | what it does |
|---|---|---|---|---|---|---|---|---|
| skip_metadata_boosts_always | 359 / 359 | 78 | 7 | 0 | 78 | 58.2 | +7.7 | ceiling: the whole block off for every query (== no_post_fusion_boosts) |
| skip_metadata_boosts_unless_entity_intent | 315 / 359 | 73 | 3 | 0 | 73 | 57.6 | +7.1 | run the metadata boosts only for entity intent (the "who is X" case they were tuned for) |
| skip_metadata_boosts_when_vector_only | 253 / 359 | 73 | 0 | 0 | 73 | 57.3 | +6.8 | run runPostFusionStages only when a strict lexical row (keyword or title arm) is in the fused pool; a vector-only pool keeps RRF + cosine order |
| skip_backlink_boost_when_vector_only | 253 / 359 | 54 | 14 | 0 | 54 | 55.0 | +4.5 | same gate, backlink stage only (other metadata boosts still run) |
| skip_backlink_boost_unless_entity_intent | 315 / 359 | 53 | 17 | 0 | 53 | 55.2 | +4.7 | same intent gate, backlink stage only |

## Proposed single mechanism

**Single stage: backlink boost alone (1 + 0.05·ln(1 + inbound links), applyBacklinkBoost).** Neutralizing it alone fixes 58 of 105 gap probes on the tuning split, costs 0 gain probes, tuning nDCG@5 55.8 (live hybrid 50.6, vector arm 60.3). The whole post-fusion metadata block is the ceiling: 78 fixed, 0 collateral, nDCG@5 58.2.

Stage-level change: do not apply the backlink boost when the page reached the pool through the vector arm only (no strict lexical row for it), or drop it for concept intent.

Best implementable gate by net fixes: **skip_metadata_boosts_always** — ceiling: the whole block off for every query (== no_post_fusion_boosts); applies to 359 probes, fixes 78, collateral 0, tuning nDCG@5 58.2 (+7.7).

## Sample gap probes

| probe | template | class | vector rank | hybrid rank | fixed by | intruders (arms; boosts) |
|---|---|---|---|---|---|---|
| c13-00001 "the framework I wrote about Brink Labs" | body-fuzzy | post_fusion_boost_reorder | 4 | 5 | no_post_fusion_boosts | companies/drift-31 (vector; backlink_boost=1.104,graph_adjacency_boost=1.050) |
| c13-00002 "that thing about Brink Labs" | body-fuzzy | post_fusion_boost_reorder | 3 | 8 | no_post_fusion_boosts | companies/beta-labs-51 (vector; backlink_boost=1.069); people/victor-taylor-1 (vector; backlink_boost=1.080); companies/quantum-labs-57 (vector; backlink_boost=1.055) |
| c13-00004 "that thing about Mosaic Labs" | body-fuzzy | post_fusion_boost_reorder | 5 | 9 | no_post_fusion_boosts | people/ulrich-wang-16 (vector; backlink_boost=1.080,graph_adjacency_boost=1.050); people/helen-martinez-87 (vector; backlink_boost=1.097); companies/mantle-16 (vector; backlink_boost=1.069,graph_adjacency_boost=1.050) |
| c13-00012 "notes on agent-first systems" | synonym | post_fusion_boost_reorder | 1 | 2 | no_post_fusion_boosts | companies/vox-25 (vector; backlink_boost=1.090,graph_adjacency_boost=1.050) |
| c13-00020 "what is products where the LLM is the product" | synonym | keyword_arm_injection | 3 | 5 | no_keyword_arm | concepts/wallet-share (vector+keyword); meetings/demo-day-2024-10-24-batch-9 (vector+keyword) |
| c13-00025 "the concept behind products where the LLM is the product" | synonym | post_fusion_boost_reorder | 1 | 2 | no_post_fusion_boosts | companies/vellum-49 (vector; backlink_boost=1.069) |
| c13-00029 "notes on products where the LLM is the product" | synonym | keyword_arm_injection | 2 | 3 | no_keyword_arm | meetings/demo-day-2024-10-24-batch-9 (vector+keyword) |
| c13-00037 "describe carbon credits" | title-paraphrase | unexplained | 1 | 3 | — | people/fiona-moore-88 (vector+keyword; backlink_boost=1.090); companies/lucid-21 (vector; backlink_boost=1.080,graph_adjacency_boost=1.050) |
| c13-00038 "the concept behind emissions offsets" | synonym | post_fusion_boost_reorder | 1 | 2 | no_post_fusion_boosts | companies/lucid-21 (vector; backlink_boost=1.080,graph_adjacency_boost=1.050) |
| c13-00039 "the framework I wrote about Talon Labs" | body-fuzzy | post_fusion_boost_reorder | 3 | 4 | no_post_fusion_boosts | people/victor-taylor-1 (vector; backlink_boost=1.080) |
| c13-00041 "how does carbon credits work" | title-variation | unexplained | 1 | 3 | — | companies/lucid-21 (vector+keyword; backlink_boost=1.080,graph_adjacency_boost=1.050); people/fiona-moore-88 (vector+keyword; backlink_boost=1.090) |
| c13-00042 "define carbon credits" | title-paraphrase | post_fusion_boost_reorder | 1 | 2 | no_post_fusion_boosts | companies/lucid-21 (vector; backlink_boost=1.080,graph_adjacency_boost=1.050) |
| c13-00044 "that essay arguing emissions offsets" | synonym-fuzzy | post_fusion_boost_reorder | 1 | 2 | no_post_fusion_boosts | companies/lucid-21 (vector; backlink_boost=1.080,graph_adjacency_boost=1.050) |
| c13-00046 "the concept behind voluntary carbon market" | synonym | post_fusion_boost_reorder | 1 | 3 | no_post_fusion_boosts | companies/lucid-21 (vector; backlink_boost=1.080,graph_adjacency_boost=1.050); companies/kindle-20 (vector; backlink_boost=1.080,graph_adjacency_boost=1.050) |
| c13-00048 "the idea of carbon credits" | title-variation | post_fusion_boost_reorder | 1 | 2 | no_post_fusion_boosts | companies/lucid-21 (vector; backlink_boost=1.080,graph_adjacency_boost=1.050) |
| c13-00049 "what is voluntary carbon market" | synonym | unexplained | 1 | 3 | — | companies/lucid-21 (vector+keyword; backlink_boost=1.080,graph_adjacency_boost=1.050); companies/kindle-20 (vector; backlink_boost=1.080,graph_adjacency_boost=1.050) |
| c13-00051 "the framework I wrote about Lucid Labs" | body-fuzzy | post_fusion_boost_reorder | 3 | 5 | no_post_fusion_boosts | people/eric-lee-21 (vector; backlink_boost=1.069); companies/lucid-21 (vector; backlink_boost=1.080) |
| c13-00064 "how does churn cohorts work" | title-variation | keyword_arm_injection | 1 | 2 | no_keyword_arm | meetings/demo-day-2025-02-18-batch-13 (vector+keyword) |
| c13-00091 "that essay arguing top-account exposure" | synonym-fuzzy | post_fusion_boost_reorder | 1 | 3 | no_post_fusion_boosts | people/chris-jackson-91 (vector; backlink_boost=1.097); people/tara-kapoor-111 (vector; backlink_boost=1.035) |
| c13-00094 "that thing about Series" | body-fuzzy | keyword_arm_injection | 2 | 4 | no_keyword_arm | people/noah-kapoor-15 (vector+keyword; backlink_boost=1.080); people/jack-davis-89 (keyword; backlink_boost=1.097) |
| c13-00095 "how does customer concentration work" | title-variation | keyword_arm_injection | 1 | 2 | no_keyword_arm | companies/helix-labs-59 (vector+keyword; backlink_boost=1.055) |
| c13-00097 "that thing about Concentration" | body-fuzzy | post_fusion_boost_reorder | 1 | 3 | no_post_fusion_boosts | people/yara-johnson-8 (vector; backlink_boost=1.090,graph_adjacency_boost=1.050); companies/pulse-8 (vector; backlink_boost=1.104,graph_adjacency_boost=1.050) |
| c13-00120 "the idea of do things that don't scale" | title-variation | keyword_arm_injection | 1 | 2 | no_keyword_arm | people/xavier-nakamura-118 (vector+keyword; backlink_boost=1.035) |
| c13-00127 "the framework I wrote about Paul Graham" | body-fuzzy | post_fusion_boost_reorder | 2 | 4 | no_post_fusion_boosts | people/paul-rodriguez-4 (vector; backlink_boost=1.080); people/chris-jackson-91 (vector; backlink_boost=1.097) |
| c13-00130 "describe do things that don't scale" | title-paraphrase | keyword_arm_injection | 1 | 4 | no_keyword_arm | people/tina-jones-112 (vector+keyword; backlink_boost=1.035); people/xavier-nakamura-118 (vector+keyword; backlink_boost=1.035); people/paul-rodriguez-4 (keyword; backlink_boost=1.080) |

## Caveats

- Tuning split only; nothing here is a held-out decision. The proposal is a hypothesis for the E2-style held-out arm.
- "Vector arm" is gbrain's own chunk-grain HNSW arm (best chunk per page, source-prefix factor applied), not the E0 `vector` adapter; the ladder's page-vector rows measure that substrate difference separately.
- The E0 `vector` adapter embeds the QUERY document-side (`embed`), gbrain embeds it query-side (`embedQuery`); both page-vector replica rows are reported so the input_type effect is visible.
- Ablations are offline re-simulations validated against the live order (see Simulation fidelity); the relational arm is not re-simulated (rows carrying relational stamps would show up as mismatches).
