A bottoms-up market model is not just a credibility tool for investors — it is a conviction-building ritual for the founder. When you can reconstruct your market size from first principles rather than cite a cited number, your relationship to the idea changes qualitatively. This insight emerged during a detailed modeling session for [[concepts/driftless-scheduling]] on 2026-08-04.

## The core observation

> "seeing the math laid out makes this feel real instead of a toy"

Top-down TAM numbers ("the scheduling software market is $12B") are borrowed authority. You didn't derive them; you found them. Investors who probe quickly expose this. But bottoms-up math — firmographic segment counts, knowledge-worker filters, seat benchmarks, penetration assumptions — is *yours*. You built it. You can defend every cell.

The shift from cited-number to reconstructible-model is a shift from external credibility to internal conviction. Both matter, but the internal one is more durable.

## The mechanics: what makes a bottoms-up model defensible

1. **A real filter, not just a segment label.** The [[concepts/driftless-scheduling]] model used `knowledge_worker_pct >= 0.25` to exclude retail-only and manufacturing-heavy orgs from the universe count. This shrinks the headline number but removes asterisks. A smaller, cleaner universe beats a large, squishy one.

2. **Intuition tested against data.** Seat-count assumptions (50 calendars / mid-market account, 100 / enterprise) were pulled from intuition, then validated against a usage sample (n=2,340). Mid-market median was 54 — nearly dead-on. Enterprise median was 112, making the intuition conservative rather than optimistic. Testing your guesses against benchmarks tells you *which direction* your model errs, which is as important as the point estimate.

3. **Segmented penetration, not blended.** Using a single penetration rate across all company sizes obscures the real story. Different bands have different sales motions, champion profiles, and willingness to pay. Separating them lets you tune assumptions independently and spot where you're underweighting opportunity (in this session: the mid-market band at 1% was bumped to 1.5% after recognizing the product's workflow-integration story is strongest there).

4. **Conservative headline, aggressive trajectory on the same slide.** This is the investor-deck application of the model. Leading with the conservative year-one number earns credibility; showing the aggressive five-year path on the same slide demonstrates scale without demanding the audience believe the upside today. The two-scenario structure signals intellectual honesty rather than salesmanship.

## Scope discipline as a byproduct

A rigorous bottoms-up model also clarifies what *not* to pitch. When a tangential idea (in this case, scheduling meetings to low-carbon grid hours, inspired by [[companies/lumopact]]'s freight-timing work) came up, the model made the out-of-scope nature immediately legible:

> "the emissions tangent stays out of this deck. It's interesting but we'd need a whole different buyer persona—sustainability leads instead of ops folks"

The model defines the buyer. If a feature requires a different buyer, it's a different product — or at minimum a different deck. Scope discipline becomes a natural output of having done the segment math rigorously.

## The refresh loop: from directional to predictive

A bottoms-up model starts as a directional artifact and becomes predictive only when real pilot data replaces speculative assumptions:

> "I'd set a calendar reminder to revisit the model at the end of each quarter. Once you have pilot data—actual conversion rates, real ACVs, churn—you can swap out the assumptions"

This is the correct epistemology for early-stage market models. Every assumption is a placeholder for an observation you haven't made yet. The quarterly cadence is the discipline for replacing placeholders with evidence as it accumulates.

## Related pages
- [[concepts/driftless-scheduling]] — the product this model was built for
- [[companies/lumopact]] — adjacent company whose freight-timing work surfaced the emissions tangent

On 2026-08-04, I worked through a full bottoms-up market sizing model for [[concepts/driftless-scheduling]], replacing vague top-down TAM estimates with firmographic segment math grounded in a Cendex extract. The session produced a defensible year-one reachable ARR of ~$19.8M and a five-year dual-scenario projection (conservative to $41M, aggressive to $79M), and surfaced several calibration moments where my intuitive assumptions were validated against actual data.

## The core build

Started with three employee-count bands (50–200, 201–1000, 1001–5000), ACVs of $4K / $12K / $40K, and penetration assumptions of 2% / 1% / 0.5%. The Cendex firmographic extract filtered 394K raw companies down to 191K using:

```
knowledge_worker_pct >= 0.25 AND headcount >= 50 AND NOT (sic_code IN ('5411','5812','2011'))
```

That excludes retail-only and manufacturing-heavy orgs — a meaningful quality filter, not just a cosmetic asterisk.

## Key adjustment: mid-market underweighted

> "I think we're underweighting the mid-market band. Can you bump penetration there to one point five percent"

Bumping the 201–1000 band from 1% → 1.5% added ~$2M to Year 1 ARR (from $17.7M to $19.8M). This wasn't wishful thinking — it was a calibrated read of where the product's workflow-integration story is strongest.

## Deck strategy: conservative headline, aggressive trajectory

The framing I landed on: lead with the conservative year-one number because it's grounded and defensible, then show the five-year aggressive path on the same slide to demonstrate scale potential.

> "lead with the conservative year-one number—roughly twenty million reachable ARR—because it's grounded in the Cendex filter and modest penetration assumptions"

This structure lets the deck feel earned without requiring me to defend a hockey stick in year one. VCs who push can see the upside without it being the headline claim.

## Seat count intuitions were close

I guessed ~50 calendars per mid-market account and ~100 for enterprise — pulled "out of thin air." The Cendex usage sample (n=2,340) returned:

| Band | Median | Mean |
|------|--------|------|
| 201–1000 | 54 | 61 |
| 1001–5000 | 112 | 134 |

> "Your fifty-calendar assumption for mid-market is almost dead-on (median 54). Enterprise at a hundred is a touch conservative—median is 112"

This was a meaningful confidence moment — intuition tested against data and mostly holding up.

## The credibility shift

> "seeing the math laid out makes this feel real instead of a toy"

This is the thing. Before this session, the market size was a number I cited. After, it's a number I can reconstruct from first principles on a whiteboard. That's a different kind of confidence.

## Parked: emissions scheduling angle

A tangent came up from a recent conversation with the [[companies/lumopact]] team about scheduling freight pickups against the grid's carbon intensity curve. I considered whether Driftless could offer a meeting-timing add-on for low-carbon hours.

> "the emissions tangent stays out of this deck. It's interesting but we'd need a whole different buyer persona—sustainability leads instead of ops folks"

Right call. The buyer for the emissions angle is a sustainability lead, not an ops or revenue team lead. Mixing those personas would muddy the pitch. Parked to a future roadmap appendix.

## Model refresh cadence

> "I'd set a calendar reminder to revisit the model at the end of each quarter. Once you have pilot data—actual conversion rates, real ACVs, churn—you can swap out the assumptions"

The model is currently directional. After 2–3 pilots close, it becomes predictive. Quarterly cadence keeps it honest without turning into busywork. The discipline: swap assumptions for observed numbers as they become available.

## Five-year scenario table (final)

| Year | Conservative ARR | Aggressive ARR |
|------|------------------|----------------|
| Y1   | 19.8M            | 19.8M          |
| Y2   | 23.8M            | 27.0M          |
| Y3   | 28.5M            | 36.9M          |
| Y4   | 34.2M            | 50.3M          |
| Y5   | 41.1M            | 79.0M          |

Conservative: 20% YoY penetration growth, flat ACV. Aggressive: 30% YoY penetration growth, 5% ACV growth, plus seat expansion modifier in Y4–Y5.