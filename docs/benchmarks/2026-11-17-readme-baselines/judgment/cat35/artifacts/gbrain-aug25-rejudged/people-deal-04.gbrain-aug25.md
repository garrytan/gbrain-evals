During the [[companies/lumopact]] data room session on 2026-08-06, I distilled a reusable red-flag checklist covering the five risk dimensions that surfaced most sharply. The checklist is threshold-driven — each category has a trigger condition so it can be applied consistently across deals without re-litigating first principles each time. Lumopact itself triggered two of the five flags, both of which were priced into a "proceed with conditions" recommendation.

## The five categories

### 1. Customer Concentration
- Do top 2 logos exceed 40% of ARR?
- Do top 5 logos exceed 70% of ARR?
- Are concentrated logos on short-term or month-to-month contracts?

**Trigger threshold:** Flag if any single top-2 logo > 25% of ARR.

*Lumopact: TRIGGERED. Bridgevault = 33% ARR; Bridgevault + Noridex = 55% ARR.*

### 2. Contract Terms
- Is there a convenience termination clause under 90 days?
- Are auto-renewal clauses present on major contracts?
- Are there MFN or price protection clauses?

**Trigger threshold:** Flag if the largest contract has < 60-day termination window.

*Lumopact: TRIGGERED. MSA Section 4.2 permits 30-day convenience termination across all contracts. Noridex additionally has no auto-renewal.*

### 3. Churn Pattern
- Is logo churn > 15% annually?
- Is gross dollar churn > 10% annually?
- Are churn reasons clustered (e.g., product fit, budget)?

**Trigger threshold:** Flag if any single reason accounts for > 50% of churn events.

*Lumopact: Not triggered. Four churn events, varied reasons (budget cut, M&A, product fit, non-payment). ~9% annual logo churn.*

### 4. Revenue Quality
- Is recurring revenue < 90% of total?
- Are professional services > 15% of revenue?
- Is gross margin < 65%?

**Trigger threshold:** Flag if recurring < 85% or gross margin < 60%.

*Lumopact: Not triggered. ~96% recurring; gross margin 67–72% depending on data cost treatment.*

### 5. Expansion Behavior
- Is net dollar retention < 100%?
- Are top logos contracting rather than expanding?
- Is expansion concentrated in one product module?

**Trigger threshold:** Flag if NRR < 95%.

*Lumopact: Not triggered. Net expansion rate ~12% in Q2; both concentrated logos expanded.*

## How to use this

The flags are designed to be **priced-in risk identifiers, not automatic pass-fail gates.** When a flag triggers, the question becomes: is this risk compensated by other signals? For Lumopact, concentration and termination flags were partially mitigated by the expansion behavior of the very logos that posed the risk — a pattern worth naming:

> **Expanding customers rarely churn in the near term.** When a concentrated logo just bought a new module, the 30-day termination clause is less scary than it looks on the contract page.

A complementary framing for concentration risk in partner presentations:

> "Frame it as a priced-in risk rather than a pass-fail issue... The mitigation is to negotiate a side letter or a board consent requirement around customer concentration thresholds post-close, and to earmark part of the check for a sales hire focused on mid-market diversification. If either logo churns within twelve months, the valuation resets, but the growth rate and expansion behavior suggest that is unlikely in the near term."

## Structural risk pairing to watch

The most dangerous combination: **high ARR concentration + short convenience termination** with *no* expansion signal. If the concentrated logos are flat or contracting, the 30-day clause is an unpriced live wire. If they are expanding (as in Lumopact), it is a yellow flag that can be managed through deal structure.

For reference call due diligence, three questions that triangulate all five categories:
1. How was onboarding? Time to value? (points at churn / product fit risk)
2. Any service or data quality outages in the past year? (points at revenue quality / retention)
3. Would you expand or recommend? (listen for hesitation — the clearest leading indicator)

See session notes in [[wiki/personal/reflections/2026-08-06-lumopact-diligence-concentration-risk-e1fb48]] for the full Lumopact data room context.

On 2026-08-06, ahead of a partner call with a four o'clock deadline, I worked through roughly forty documents in the [[companies/lumopact]] data room. The session surfaced strong revenue quality and healthy expansion behavior, but also a structural concentration risk — two customers representing 55% of ARR, both on 30-day termination clauses — that became the central framing question for the deal. I landed on a "proceed with conditions" recommendation, consistent with [[companies/vantabrook]]'s own memo.

## Key metrics extracted

**ARR Waterfall (Jan–Jun 2024)**

| Period | Starting ARR | New Biz | Expansion | Churn | Ending ARR |
|--------|-------------|---------|-----------|-------|-----------|
| Jan-24 | 412,000 | 38,000 | 12,500 | (4,200) | 458,300 |
| Feb-24 | 458,300 | 41,200 | 9,800 | (3,100) | 506,200 |
| Mar-24 | 506,200 | 52,300 | 14,100 | (5,400) | 567,200 |
| Apr-24 | 567,200 | 48,700 | 11,200 | (6,800) | 620,300 |
| May-24 | 620,300 | 55,100 | 8,900 | (4,500) | 679,800 |
| Jun-24 | 679,800 | 61,400 | 15,300 | (7,200) | 749,300 |

~11% monthly ARR growth. Strong top-line trajectory for a Series A.

**Logo concentration**

| Customer | ARR | % of Total | Term (mo) |
|----------|-----|-----------|-----------|
| Bridgevault | 247,500 | 33.1% | 12 (auto-renew) |
| Noridex Corp | 164,200 | 21.9% | 6 (no auto-renewal) |
| Talmore Ltd | 78,400 | 10.5% | 24 |
| Quinley Inc | 62,100 | 8.3% | 12 |
| Optica Labs | 51,900 | 6.9% | 12 |
| (6 others) | 145,200 | 19.4% | various |

> "two logos are fifty five percent of revenue. Bridgevault alone is a third of total ARR, and Noridex adds another twenty two percent."

> "the biggest contract can walk with thirty days notice, and Bridgevault represents a third of ARR. I will flag that as a structural risk."

Noridex started November 2023 on a 6-month deal with no auto-renewal — could be up for renewal imminently.

**Revenue quality (Q2-24)**

- Recurring SaaS: $2,049,400 (~96% of revenue)
- Usage overage: $63,100 (~3%)
- Professional services: $22,800 (~1%)
- One-time license: $0

> "Revenue is almost entirely recurring which is good, only about three percent comes from usage overage and another one percent from professional services."

**Gross margin**

- Total Q2 revenue: $2,135,300
- Total Q2 COGS: $695,400 (largest line: data provider at $312,500, not hosting)
- Gross margin: **~67%** blended; ~72% excluding data provider
- [[people/anouk-verlinden]] quoted 70% on the call — within range, no material discrepancy

> "the sixty seven figure is probably the realistic operating margin to underwrite"

**Churn events (trailing ~12 months)**

| Date | Customer | ARR Lost | Reason |
|------|----------|---------|--------|
| 2023-07-14 | Vellmore Systems | 18,200 | Budget cut |
| 2023-09-30 | Grindall Co | 12,400 | Acquired by competitor |
| 2024-01-22 | Peakline Ltd | 9,800 | Product fit |
| 2024-04-18 | Solvex Inc | 6,800 | Non-payment default |

Total: $47,200 ARR lost, four logos, varied reasons — no single systemic cause. Solvex non-payment is a minor credit risk yellow flag.

**Logo retention (quarterly)**

| Quarter | Start | New | Churned | End | Churn Rate |
|---------|-------|-----|---------|-----|-----------|
| 2023-Q2 | 8 | 2 | 0 | 10 | 0% |
| 2023-Q3 | 10 | 1 | 1 | 10 | 10% |
| 2023-Q4 | 10 | 2 | 1 | 11 | 10% |
| 2024-Q1 | 11 | 3 | 1 | 13 | 9.1% |
| 2024-Q2 | 13 | 2 | 1 | 14 | 7.7% |

One churn per quarter is a pattern — could be noise at this scale or a segment that never fully activated. Worth asking [[people/anouk-verlinden]] if churned logos share a common profile (size, use case). Trailing 12-month logo retention: ~91%.

**Expansion / contraction log**

| Date | Customer | Event | ARR Delta |
|------|----------|-------|-----------|
| 2024-01-10 | Bridgevault | Expansion | +32,000 (analytics module) |
| 2024-02-22 | Talmore Ltd | Expansion | +14,100 (premium tier) |
| 2024-03-15 | Quinley Inc | Expansion | +8,400 (seat expansion) |
| 2024-04-05 | Optica Labs | Contraction | -4,200 (downgraded to starter) |
| 2024-05-18 | Noridex Corp | Expansion | +18,700 (enterprise security add-on) |

> "Net expansion of sixty nine thousand against a single contraction of forty two hundred is solid. The net expansion rate of about twelve percent in a quarter suggests strong product market fit within the existing base."

Key observation: both concentrated logos (Bridgevault, Noridex) expanded in the period — a leading stickiness indicator.

## The core risk framing

> "concentration is high, two logos at fifty five percent of ARR, and both contracts allow thirty day convenience termination. However, both logos expanded in the last two quarters, which is a leading indicator of stickiness."

MSA Section 4.2 is the mechanism: either party can terminate for convenience on 30 days written notice. Bridgevault auto-renews annually but the clause still applies. Noridex has no auto-renewal, making it the riskier of the two large accounts.

How to frame for partners: **priced-in risk, not pass-fail.** Bridgevault added the analytics module; Noridex bought the enterprise security add-on — embedding deeper, not preparing to leave. Mitigation levers:
1. Side letter with concentration threshold covenants
2. Board consent required if any single customer exceeds 30% of ARR
3. Earmark capital for a mid-market sales hire focused on diversification

[[companies/vantabrook]]'s memo aligned with this read — flagged concentration but was constructive on growth rate and margin profile.

## Final call

> "I think I am ready to recommend a proceed with conditions."

Wire goes out the day after reference calls. Two references scheduled for tomorrow morning. Listening checklist for those calls:
1. Onboarding experience and time to value (can they land new logos efficiently as they diversify?)
2. Service outages or data quality issues over the past year
3. Would the reference expand their contract or recommend Lumopact to a peer — listen for hesitation

## Personal note

> "I am stretching my back while the export chews... let me paste the churn log next."

Session was time-pressured (data room logs out every 10 minutes), done in one sitting before a 4pm partner call. The numbers matching what [[people/anouk-verlinden]] quoted aloud settled my stomach. Good signal that the founder's verbal framing and the data room actuals are consistent.