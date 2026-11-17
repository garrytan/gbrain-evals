# Driftless — Bottoms-Up Market Sizing Model

## Context
Built a defensible bottoms-up TAM model for Driftless (async scheduling infrastructure for mid-market and enterprise knowledge-work teams) to replace hand-wavy top-down numbers in the VC deck.

---

## Firmographic Universe (Cendex 2024-Q1)
Filter logic: `knowledge_worker_pct >= 0.25 AND headcount >= 50 AND NOT (sic_code IN ('5411','5812','2011'))`

| Band | Raw Count | KW-Filtered Universe |
|------|-----------|----------------------|
| 50–200 | 312,400 | 148,200 |
| 201–1,000 | 67,800 | 34,500 |
| 1,001–5,000 | 14,200 | 8,700 |
| **Total** | **394,400** | **191,400** |

---

## Core Model Assumptions

| Band | ACV | Y1 Penetration | Median Seats (benchmarked) |
|------|-----|----------------|---------------------------|
| 50–200 | $4,000 | 2.0% | 22 (mean 27) |
| 201–1,000 | $12,000 | 1.5% | 54 (mean 61) ✓ matches assumption |
| 1,001–5,000 | $40,000 | 0.5% | 112 (mean 134) — slightly above assumption |

Seat benchmarks sourced from Cendex usage sample (n=2,340), defined as active calendar users with ≥3 scheduled events/week. Sample skews tech and professional services.

---

## Five-Year Scenario Table (final, clean)

| Year | Conservative ARR | Aggressive ARR |
|------|------------------|----------------|
| Y1 | 19.8M | 19.8M |
| Y2 | 23.8M | 27.0M |
| Y3 | 28.5M | 36.9M |
| Y4 | 34.2M | 50.3M |
| Y5 | 41.1M | 79.0M |

**Conservative:** 20% YoY penetration growth, ACVs held flat.  
**Aggressive:** 30% YoY penetration growth, 5% annual ACV growth, 1.15× seat expansion modifier applied in Y4–Y5.  
Hitting $90M+ ARR requires a second product line or international expansion layered on top.

---

## Deck Strategy
- **Headline slide:** Conservative Y1 (~$19.8M reachable ARR) — grounded and defensible.
- **Same slide:** Show aggressive five-year trajectory to $79M to demonstrate scale potential.
- Avoid interactive sliders in the deck (overkill for PDF/static formats).
- **Future idea (parked):** Self-serve ROI calculator on the website — prospects input team size and meeting load, see hours saved; doubles as lead-gen.

---

## Parked / Out of Scope
- **Emissions-aware scheduling add-on** (inspired by Lumopact's grid-carbon freight scheduling): times meetings to low-carbon grid windows. Interesting technically but targets a different buyer persona (sustainability leads vs. ops). Candidate for a future roadmap appendix or v2 upsell — not in this deck.

---

## Maintenance Cadence
- Refresh model **every quarter**.
- Once pilot data arrives, swap estimated penetration/ACV assumptions with observed actuals — model shifts from directional to predictive.
- Snapshot saved: `./snapshots/quarterly_2024Q2.pdf` (2024-06-12). Next refresh flagged for **2024-09-15**.