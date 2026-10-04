# Hub dampening, date-grounded extraction and speaker attribution: preregistration (2026-10-04)

Frozen before any sealed scoring run, in a commit separate from the runners. It decides the defaults of three gbrain settings that ship off: `search.hub_dampening`, `extraction.date_grounding` and `facts.attribution`. A setting is turned on only by the sealed result named for it below; a mechanism that loses or is inconclusive is removed from the gbrain change and the loss is reported here.

## System under test

- gbrain branch `capy/p2-hub-dampening-explain-date-grounding`, pinned to the frozen build commit recorded in each receipt (`--gbrain <checkout>@<sha>`), baseline = the same commit with the setting under test off (all three are off by default, so the baseline is byte-identical to master's ranking and prompts apart from the page-date `valid_from` change, which is deterministic and covered by unit tests).
- Every arm changes exactly one setting. System One off (keys stripped, fresh `GBRAIN_HOME`).

## Sampling units and statistics (all three experiments)

- The unit is the question (or probe). Where questions share a corpus they are clustered: probes by concept (E1), questions by conversation (LoCoMo). Each comparison reports the paired difference with a 95% bootstrap confidence interval over the stated unit (10,000 resamples, clustered where stated) and an exact two-sided sign test over units that changed.
- Judge reruns (10 per row) measure judge noise only; they never add units. Extraction arms run twice; both runs are reported and the decision uses their mean per unit.
- A result whose confidence interval crosses zero is **inconclusive**: the setting stays off and the mechanism is removed unless a named rerun is scheduled.

## E1 — hub dampening (`search.hub_dampening`)

- **Workloads.** (a) Cat 13 conceptual recall on world-v1 (existing seeded concept split: 20 tuning concepts = dev, 10 holdout concepts = sealed); (b) the same probes on a hub-heavy world-v1 variant whose added routine pages link to entities with a Zipf degree distribution matched to a measured 285k-page wiki graph (inbound p50 5, p90 93, p99 607, a few hubs at 5k-30k), generator seed 1 = dev, seeds 2-3 = sealed; (c) hub-as-answer probes on (b) whose gold IS the hub page, plus bridge probes reached only through a hub; (d) relational one-hop questions (relational-ab, 145 × 3 seeds) on (b) as a guard.
- **Arms (dev).** off; half degree H ∈ {32, 100, 200, 600}; per site (backlink only, graph signals only, both); controls: backlink boost removed, graph signals off, boosts capped at ≤ +2%. Keyword-only and hybrid (`text-embedding-3-large`); reranker off and on.
- **Sealed arms.** off vs the single dev-chosen H and site set, plus both controls.
- **Primary metric.** nDCG@5 on workload (b) sealed seeds. **Pass:** Δ ≥ +1.0 pt with CI > 0 AND better than both controls. **Guards:** hub-as-answer nDCG@5 Δ ≥ −0.5 pt; relational recall@5 and first-place Δ ≥ −0.5 pt with no more questions worse than better; plain world-v1 holdout nDCG@5 Δ ≥ −0.5 pt; p95 search latency Δ ≤ +5 ms on PGLite and Postgres; LongMemEval-S top-5 byte-identical on a 50-question smoke (no links, so dampening must be inert).
- **Reported only.** Traversal work (walk rows before the limit) for a 30k-inbound relational seed on both engines, handed to the multi-hop planner work.
- **Budget.** Estimate $10; cap $20.

## E2 — date-grounded extraction (`extraction.date_grounding`)

- **Workloads.** LongMemEval-S temporal-reasoning questions (127; frozen dev/sealed question split; independent haystacks, unit = question) ingested through gbrain's production conversation extractor, answered through the product entry points (`recall`, `query` with its saved-facts lane, `think`); LoCoMo (conversations 0-2 dev, 3-9 sealed) for judge-free date metrics.
- **Primary metric.** Temporal QA accuracy on the production `query`/`think` path, sealed LongMemEval-S questions, judge 10× mean. **Pass:** Δ > 0 with CI > 0 (target ≥ +3 pts).
- **Guards.** Share of stored facts with an unresolved relative-time phrase drops ≥ 50% relative (a phrase followed by a parenthesized absolute date or bound counts as resolved); resolved-date accuracy ≥ 85% against LoCoMo session dates; non-temporal QA Δ ≥ −1 pt; facts per session within ±10%.
- **Per-consumer checks.** Chronicle events, dream synthesis, extract_atoms and propose_takes: 30 dated fixture pages each with relative references; unresolved-phrase count plus a blind pairwise judge (old vs new, order randomized, 10×) that the new output is not worse. A consumer that fails keeps its current prompt.
- **Budget.** Estimate $53; cap $106.

## E3 — speaker attribution (`facts.attribution`) and the assistant-said check

- **Workload.** LongMemEval-S single-session-assistant (56) and single-session-user (64) questions, full haystacks, frozen dev/sealed split, ingested through the production conversation extractor; answered through `query` pages-only (today's main path), `query` with saved facts, `recall`, and `think`, under equal token budgets.
- **Gate (run first, baseline extractor).** If `recall` on single-session-assistant is within 5 pts of `query` pages-only, the facts lane has no assistant-said deficit and attribution storage is not built; only the extractor phrasing is tested.
- **Pass (default on).** `recall` and `query`+saved-facts single-session-assistant Δ > 0 with CI > 0; single-session-user and temporal Δ ≥ −2 pts; attribution accuracy ≥ 90% on a 200-fact sample judged against the source turn; zero rejected-advice-as-user-fact cases in the scripted conversation set.
- **Power.** About 39 sealed assistant questions: an exact sign test needs ≥ 6 net wins with no losses to reach p < 0.05 (about 15 pts). Smaller effects report as inconclusive (off). LongMemEval-M assistant questions, if available, are the only additional power.
- **Budget.** Estimate ≤ $72 (≈ $36 if the gate stops it); cap $144.

## E5 — final combined configuration

The configuration that will ship (every surviving setting at its chosen default) runs once on the sealed LongMemEval-S, LoCoMo and hub-heavy Cat 13 workloads against the baseline, so interactions (e.g. date wording and attribution competing for the 10-fact-per-turn cap) are measured. Pass: no sealed metric regresses beyond its per-experiment guard. Budget estimate $15; cap $30.

## Program budget

Estimate ≈ $150; caps are twice each estimate; program cap $400. Paid arms run only through the budget guard.

## Who runs what

Dev splits are run by the feature author. Sealed splits are run once by the evaluation custodian after the gbrain build commit and this file are frozen; the author never sees sealed results before the build is frozen.
