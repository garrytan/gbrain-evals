# Cat 13 — keyword_arm_confidence_floor calibration (Phase E2)

Generated: 2026-09-06T03:30:07.934Z · gbrain 0.48.2.0 (pin github:garrytan/gbrain#5cfb84f1d3a809c70064c292c23db3d538d5c551)
Embeds: live voyage:voyage-4 @ 1024d
Search pins: search.mode=balanced search.reranker.enabled=false search.autocut=false · per-call keywordArmConfidenceFloor=null (OFF), limit=30
Concept split: seed=42, 20 tuning / 10 held-out (held-out never queried here)
Probes: 548 generated, 359 tuning-subset, 359 measured

## Floor

Rule (pre-registered): median margin_ratio over tuning probes whose keyword top hit is NOT gold AND 0 < margin_ratio < 1 (single-row = 1.0 and empty = 0 excluded).

- eligible probes: 27
- **floor = 0.6121** (CLI value `0.6121`)

## Keyword-arm classes (tuning probes)

| Set | probes | empty (0) | single (1.0) | contested (0,1) | unstamped |
|-----|--------|-----------|--------------|-----------------|-----------|
| all | 359 | 253 | 51 | 55 | 0 |
| keyword top = gold | 54 | 0 | 26 | 28 | 0 |
| keyword top ≠ gold | 305 | 253 | 25 | 27 | 0 |

Row-count vs margin-class disagreements (keyword_rows ≥ 2 but margin not in (0,1), or vice versa): 0.

## Collateral at the floor

- gold-top probes the floor would down-weight: 11 / 28 contested (39.3%); 11 / 54 of all non-empty gold-top (20.4%)
- non-gold-top probes that were single-row (unreachable by any floor): 25 / 305 (8.2%)
- non-gold-top probes with an empty strict keyword arm (nothing to demote): 253 / 305 (83.0%)
- non-gold-top contested probes left at full weight (margin ≥ floor): 14

## margin_ratio histogram (10 bins; last bin closed at 1.0)

| bin | keyword top = gold | keyword top ≠ gold |
|-----|--------------------|--------------------|
| [0.0, 0.1) | 0 | 253 |
| [0.1, 0.2) | 0 | 0 |
| [0.2, 0.3) | 0 | 0 |
| [0.3, 0.4) | 0 | 0 |
| [0.4, 0.5) | 0 | 0 |
| [0.5, 0.6) | 10 | 12 |
| [0.6, 0.7) | 4 | 4 |
| [0.7, 0.8) | 7 | 2 |
| [0.8, 0.9) | 1 | 1 |
| [0.9, 1.0] | 32 | 33 |

## Per template

| template | probes | gold-top | eligible | median margin (eligible) |
|----------|--------|----------|----------|--------------------------|
| body-fuzzy | 63 | 4 | 11 | 0.789446 |
| company-neighborhood | 19 | 0 | 0 | n/a |
| description-paraphrase | 22 | 1 | 0 | n/a |
| semantic-neighborhood | 11 | 0 | 0 | n/a |
| synonym | 104 | 16 | 6 | 0.733905 |
| synonym-fuzzy | 34 | 1 | 0 | n/a |
| title-paraphrase | 58 | 15 | 5 | 0.500014 |
| title-variation | 48 | 17 | 5 | 0.591515 |

## E2 decision arm (held-out concepts, judged once)

```bash
CAT13_EMBEDDING_MODEL=voyage:voyage-4 CAT13_EMBED_DIMS=1024 bun eval/runner/cat13-conceptual.ts --reranker off --autocut off --keyword-arm-confidence-floor 0.6121
```

## Sample of eligible probes (non-gold keyword top, contested)

| probe | template | margin | keyword top | gold |
|-------|----------|--------|-------------|------|
| c13-00020 "what is products where the LLM is the product" | synonym | 1.000000 | companies/vellum-49 | concepts/ai-first-product |
| c13-00036 "that thing about Market" | body-fuzzy | 0.789446 | companies/talon-47 | concepts/carbon-credits |
| c13-00041 "how does carbon credits work" | title-variation | 0.713550 | companies/lucid-21 | concepts/carbon-credits |
| c13-00052 "that thing about Where" | body-fuzzy | 0.531194 | concepts/do-things-that-don-t-scale | concepts/churn-cohorts |
| c13-00053 "that thing about Lattice" | body-fuzzy | 0.520000 | concepts/usage-based-pricing | concepts/churn-cohorts |
| c13-00054 "that thing about Thinking" | body-fuzzy | 0.999228 | meetings/oneonone-16-2025-05-17 | concepts/churn-cohorts |
| c13-00094 "that thing about Series" | body-fuzzy | 0.998729 | people/noah-kapoor-15 | concepts/customer-concentration |
| c13-00096 "the customer concentration framework" | title-variation | 0.537564 | concepts/revenue-durability | concepts/customer-concentration |
| c13-00098 "that thing about Early" | body-fuzzy | 0.612089 | concepts/do-things-that-don-t-scale | concepts/customer-concentration |
| c13-00130 "describe do things that don't scale" | title-paraphrase | 0.500000 | people/paul-rodriguez-4 | concepts/do-things-that-don-t-scale |
| c13-00174 "that thing about Conversely" | body-fuzzy | 0.998364 | companies/nimbus-5 | concepts/fine-tuning |
| c13-00188 "how does foundation models work" | title-variation | 0.591515 | concepts/inference-cost | concepts/foundation-models |
| c13-00189 "define foundation models" | title-paraphrase | 0.649728 | companies/accel-5 | concepts/foundation-models |
| c13-00194 "the foundation models framework" | title-variation | 0.980325 | concepts/retrieval-augmented-generation | concepts/foundation-models |
| c13-00214 "what is hands-on founder involvement" | synonym | 0.521507 | people/olivia-miller-176 | concepts/founder-mode |

