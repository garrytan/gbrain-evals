# gbrain combined lane, fix round 2: date grounding on vs off, BEAM dev (2026-10-06)

Dev evidence, scratch build 98537693f (`capy/mpw-integration-p2`: wave 5bed09e93 plus #6020 at 057fb28ad). This is not a release verdict.

With date grounding on, the extractor writes an event date into 5% to 8% of facts. BEAM dev does not improve. The pooled mean score is 0.653 with grounding on and 0.663 with it off. On temporal_reasoning the on arm scores 0.438 against 0.493 off, with 0 wins, 3 losses and 33 ties paired. On event_ordering it scores 0.429 against 0.433, with 6 wins, 10 losses and 20 ties.

The lane is combined with exchange pages: facts 600 and pages 7,500, an 8,000-token target, the gemini:gemini-3.8-flash answer model and the gemini:gemini-3.5-flash judge. Extraction runs openai:gpt-6-luna through `extract_facts` over whole documents, with `valid_from` set to the session date, which is the observation date. Each arm re-extracted into its own store; `gbrain_config` is an ingest key.

- **On:** `extraction.date_grounding: "true"`
- **Off:** `extraction.date_grounding: "false"`

The other #6020 features are not set in either arm. `search.hub_dampening` and `facts.attribution` are absent from every brain's config ([fix2/cfgcheck.json](facts-lanes/fix2/cfgcheck.json)), so hub dampening keeps its default of off. Explain is a per-call query option, and the provider never passes it.

## Cells

Every gate passes in all six cells, and the proxy refused no judge call. Budgets were $12 for 100k and $20 for 500k and 1m.

| Arm | Cell | Slice | Delivered mean / p95 | Correct / n | Mean score | Cost (cell) | Cost (ingest + tune) |
|---|---|---|---|---|---|---|---|
| on | `beam-100k-gbrain-rag-0a4452f8aa13` | 100k | 8,131 / 8,274 | 56 / 80 | 0.645 | $2.22 | $0.46 |
| on | `beam-500k-gbrain-rag-fb40591d4225` | 500k | 8,123 / 8,210 | 98 / 140 | 0.672 | $4.07 | $2.11 |
| on | `beam-1m-gbrain-rag-ea8917e68fbb` | 1m | 8,122 / 8,190 | 95 / 140 | 0.638 | $4.88 | $4.47 |
| off | `beam-100k-gbrain-rag-dbd9e79c1d4c` | 100k | 8,124 / 8,248 | 56 / 80 | 0.643 | $2.20 | $0.40 |
| off | `beam-500k-gbrain-rag-686f7204fa27` | 500k | 8,101 / 8,146 | 100 / 140 | 0.666 | $4.09 | $1.82 |
| off | `beam-1m-gbrain-rag-05e38d72a7a1` | 1m | 8,099 / 8,155 | 101 / 140 | 0.671 | $4.67 | $3.85 |

| Arm | 100k | 500k | 1m | Pooled (360) |
|---|---|---|---|---|
| on | 0.645 | 0.672 | 0.638 | 0.653 |
| off | 0.643 | 0.666 | 0.671 | 0.663 |
| comparator combined (reference) | 0.677 | 0.668 | 0.627 | 0.654 |

Paired off to on, over all questions: 100k 6 wins / 11 losses (+0.002), 500k 16 / 16 (+0.006), 1m 13 / 24 (-0.032). Pooled: 35 / 51 / 274, -0.010.

## Temporal reasoning and event ordering

| Category | Arm | 100k (n 8) | 500k (n 14) | 1m (n 14) | Pooled (n 36) |
|---|---|---|---|---|---|
| temporal_reasoning | on | 0.312 | 0.571 | 0.375 | 0.438 |
| temporal_reasoning | off | 0.344 | 0.643 | 0.429 | 0.493 |
| event_ordering | on | 0.506 | 0.397 | 0.417 | 0.429 |
| event_ordering | off | 0.468 | 0.411 | 0.434 | 0.433 |

Paired off to on, as wins / losses / ties ([fix2/paired4.json](facts-lanes/fix2/paired4.json)):

| Category | 100k | 500k | 1m | Pooled |
|---|---|---|---|---|
| temporal_reasoning | 0 / 1 / 7 | 0 / 1 / 13 | 0 / 1 / 13 | 0 / 3 / 33 (-0.056) |
| event_ordering | 1 / 0 / 7 | 2 / 4 / 8 | 3 / 6 / 5 | 6 / 10 / 20 (-0.004) |

The other categories differ by at most 0.04 between arms ([fix2/cats4.json](facts-lanes/fix2/cats4.json)). The largest gap is knowledge_update, 0.562 on against 0.604 off.

## Event-date coverage

This is the share of facts whose `valid_from` differs from their source session's date ([fix2/validfrom9853.json](facts-lanes/fix2/validfrom9853.json)). The build does not mark an extracted date separately; a differing `valid_from` is the extractor's event date. For example, a session dated 2025-01-12 yields "User is planning a joint workshop with Carla on ethical AI hiring for 2025-02-20" with `valid_from` 2025-02-20.

| Arm | Slice | Facts | Event date differs | Share | Within recall's newest 100 per unit |
|---|---|---|---|---|---|
| on | 100k | 2,346 | 196 | 8.4% | 24 of 400 (6.0%) |
| on | 500k | 11,569 | 959 | 8.3% | 27 of 700 (3.9%) |
| on | 1m | 26,971 | 1,328 | 4.9% | 22 of 700 (3.1%) |
| off | 100k | 2,200 | 0 | 0% | 0 of 400 |
| off | 500k | 10,468 | 0 | 0% | 0 of 700 |
| off | 1m | 23,938 | 0 | 0% | 0 of 700 |

Most extracted dates fall before the session date: 1,779 earlier and 704 later across the three slices, with median offsets of 3 to 4 days earlier.

Facts are counted per session through `recall`, which returns at most 100 facts per session. 3, 2 and 15 sessions hit that cap in the on arm, and 0, 1 and 2 in the off arm, so the counts are lower bounds. This build extracts more facts per window than 505a65aab (2,346 against 1,353 on 100k for the same 365 windows).

The dated facts rarely reach the prompt. The facts block holds 600 tokens, about 25 lines, taken from `saved_facts` and `recall`'s newest facts. The query facts arm added no fact rows in any cell, because the pages fill the 7,500-token page budget.

## Spend

| Arm | 100k | 500k | 1m | Total |
|---|---|---|---|---|
| on | $2.68 | $6.18 | $9.35 | $18.21 |
| off | $2.60 | $5.91 | $8.52 | $17.03 |

Each slice's cost includes its ingest, tune and cell.

Extraction chat cost with grounding on was $0.34, $1.78 and $3.82, against $0.28, $1.48 and $3.20 off. Grounding raises the output: one `valid_from` per fact. Extraction calls equal windows in both arms (365, 1,986 and about 4,630), and `put_pages` made no chat request.

Ledger: $165.71 committed of the $265 cap, with $99.29 remaining ([facts-lanes/ledger-status.json](facts-lanes/ledger-status.json)).
