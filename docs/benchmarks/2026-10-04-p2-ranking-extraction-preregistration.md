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

## Amendment 1 — E2 held-out gate (approved 2026-10-04, before any sealed cell)

Status: approved 2026-10-04. No sealed E2 cell had run when it was approved. It replaces the E2 workload, primary metric and guards above. The E2 budget is unchanged.

**Why the workload changes.** The decision kit's frozen splits put all 500 LongMemEval-S questions in development, because the release configuration was chosen on them, so the sealed LongMemEval-S temporal questions named above do not exist. BEAM can't substitute: 82 of its 1,877 sessions carry a date, so the observation date is unknown almost everywhere. The `query` op has no saved-facts lane in this build, and `think` reads saved facts only through entity trajectories, which these corpora don't create.

**Why the gate is correctness-first.** Date grounding is meant to keep a saved fact's meaning the same months after it was said. Development showed that within-conversation QA can't detect that. The current extractor already resolves about 94% of relative dates (unresolved share 6.2% on LoCoMo, 5.5% on LongMemEval-S). Re-extracting the same conversation with the same build moved its temporal QA by up to 9 points, which is larger than any plausible QA effect from the remaining 6%. So the unresolved share, which measures correctness directly, decides. QA is held to non-inferiority, and its effect is reported only.

**Workload.** The 7 sealed LoCoMo conversations (conv-26, 30, 41, 42, 43, 49, 50) go through the decision kit's memory-qa facts lane (gbrain-evals `capy/p2-facts-lane`): sessions are imported as dated conversation pages, and gbrain's conversation-facts extractor runs with the product default model. Candidate: rule `date-grounding-v2` with `extraction.date_grounding=true`. Baseline: the same base build with the setting absent. Unit: question, clustered by conversation; `min_clusters` = 7. Extraction runs twice per arm, and every metric uses the per-question mean of the two runs. A fixed reader answers from the saved facts (fact text and stored date) of the top five retrieved sessions, with 10 answer-and-judge replicates per question.

**Primary (decides the default).** On sealed LoCoMo, the share of saved facts that keep a relative time phrase and no absolute date (`facts_unresolved_share`; a fact containing any absolute date counts as resolved) must drop by at least 50% relative to the baseline arm's mean share, with the 95% clustered CI of the paired difference entirely below 0. Development showed −80% (LoCoMo, CI −7.3 to −2.7 pts) and −69% (LongMemEval-S).

**Guards (all must hold).**
- Temporal QA from saved facts: non-inferior, with the 95% lower bound of Δ no worse than −3 pts.
- Overall QA from saved facts (temporal, single-hop, multi-hop and open-domain together): non-inferior, with the 95% lower bound of Δ no worse than −3 pts.
- Page recall@5: unchanged, with the 95% lower bound of Δ no worse than −1 pt. The setting changes extraction only, and development was identical.
- Facts per conversation: the candidate mean is within ±5% of the baseline mean. Development: −0.6% and +0.7%.

**Reported only.** The temporal and overall QA effect sizes with CIs, LongMemEval-S development results, and counts of stored dates by session date from `facts.ndjson` (the kit has no judged resolved-date-accuracy metric, so the former ≥ 85% guard is reported, not gated).

**Outcome rule.** If the primary and every guard pass, `extraction.date_grounding` defaults on. If any fails or is inconclusive, the setting stays off and the mechanism is removed from the gbrain change.

**Rule version.** The candidate is `date-grounding-v2`, which rewrites relative phrases as absolute dates. Version 1 kept the phrase beside its date and lost temporal QA on development, because a reader shown the fact under its event date applied the phrase a second time. Development record: gbrain `docs/eval/decisions/p2-date-grounding-dev/` (build 5d5375d43).

**Metric definition correction (2026-10-04, before any sealed cell).** Saved facts exclude the conversation extractor's audit rows (one `EXTRACTION_COMPLETE` marker per processed page, with source `cli:extract-conversation-facts:terminal…` or `…:non-extractable…`). The development runs counted them in `facts_count` and in the unresolved-share denominator, and showed them to the reader. The fix is gbrain-evals `capy/p2-facts-lane` f9fb315 or later, and the sealed run must use it. Pooled development shares without audit rows: LoCoMo 6.9% → 1.3% (−81%), LongMemEval-S 6.8% → 2.3% (−67%). The gate thresholds are unchanged.

## Amendment 2 — E3 held-out set (approved 2026-10-05, before the set exists)

Status: approved 2026-10-05. This file was committed before any conversation in the set was generated. It replaces the E3 workload, arms and gate above. The E3 cap ($144) is unchanged; development spent about $62, so this run has at most $82.

**Why.** The sealed LongMemEval-S assistant and user questions named above do not exist: the decision kit's frozen splits put all of LongMemEval-S in development. No other held-out source asks about assistant statements. LoCoMo conversations are between two people, and BEAM's sealed 100k set has 1 such question in 280. Development already passed both the gate and the arm (gbrain `docs/eval/decisions/p2-attribution-gate-dev/` and `p2-attribution-dev/`): with attribution off, answers from saved facts trail answers from pages by 73 points on assistant-said questions; with it on, they rise from 23.3% to 60.0% (+36.7 pts, CI +20 to +53), and user-said questions are unchanged.

**The set (generated by the custodian, sealed on creation).** 60 synthetic user–assistant conversations, 12 per case family. Each has 4–8 dated sessions, a mix of on-topic and filler turns, and invented people and places only. The author of this preregistration never sees the conversations, questions or answers.

| Family | What happens in the conversation | Assistant-said questions (gold) | User-said questions (gold) |
|---|---|---|---|
| Rejection | The assistant recommends X; the user declines in a later turn and states their own plan Y | "What did you recommend for …?" → X | "What did I decide to do about …?" → Y, never X |
| Quotation | The user quotes or relays something a third party or the assistant said, and separately states their own view | "What did you tell me about …?" → the assistant's statement | "What do I think about …?" → the user's own view |
| Correction | The assistant gives an answer; the user corrects a fact in it | "What was your original answer about …?" → the assistant's answer | "What is the correct … according to me?" → the user's correction |
| Repeated suggestion | The assistant suggests the same thing in two sessions; the user neither accepts nor rejects it | "What did you keep suggesting …?" → the suggestion | "Did I agree to …?" → no decision recorded |
| Acceptance | The assistant suggests X; the user explicitly accepts it in a later session | "What did you suggest for …?" → X | "What did I decide about …?" → X, accepted |

Each conversation has 2 assistant-said questions and 2 user-said questions: 120 of each, plus the 60 conversations as clusters. A different model family from gbrain's extraction default writes the conversations and questions (the custodian records the model and seed). A second pass by the custodian checks every gold answer against the transcript before sealing.

**Build under test.** The frozen head of gbrain#6020 at the time of the run, recorded by SHA in every receipt (6fa1a77b3 or a later head with no change under `src/core/facts/`, `src/commands/extract-conversation-facts.ts` or `src/core/ai/`). That head stores `attributed_to` and asks the extractor for it. Candidate: `facts.attribution=true`. Baseline: the same build with the setting absent. Each arm extracts twice through the decision kit's facts lane (gbrain-evals `capy/p2-facts-lane` 3475930 or later; product default extraction model), and every metric uses the per-question mean of the two extractions.

**Harness.** The facts lane writes each saved fact's stored `attributed_to` to `facts.ndjson`; Guard 3 reads it from there.

**Answer path.** The facts lane's fixed reader (`openai:gpt-4o-2024-08-06`, the pin the development run used) answers from the saved facts of the top five retrieved sessions, and the pinned LongMemEval judge scores each answer. Answering and judging run 5 replicates per question; replicates measure judge and reader noise only and never add units.

**Gate.**
- **Primary (decides the default):** assistant-said QA from saved facts, superiority. The 95% CI of the paired difference, clustered by conversation, must lie entirely above 0.
- **Guard 1:** user-said QA from saved facts, non-inferior: the 95% lower bound of Δ is no worse than −2 pts.
- **Guard 2:** rejection family, judged over the candidate's saved facts. No saved fact states the rejected suggestion as the user's plan, preference or decision (zero cases; one pinned-judge call per fact plus a custodian read of every flagged fact).
- **Guard 3:** speaker accuracy. On a random sample of 200 candidate facts that carry `attributed_to` (seed 42), the stored speaker matches the speaker of the source turn in at least 90%, judged by the pinned judge with the turn shown.
- **Reported only:** acceptance-family user-said accuracy, facts per conversation, and extraction failures per arm.

**Outcome rule.** If the primary and all three guards pass, `facts.attribution` defaults on. If any fails or is inconclusive, the setting stays off, and the extractor rule plus the `attributed_to` storage are removed from #6020.

**Power.** Development showed a +36.7-pt effect with about 40% of questions changing. With 120 assistant-said questions in 60 clusters, a true effect of +15 pts (less than half of development) gives the clustered bootstrap about 90% power at α = 0.05. With 120 user-said questions and development's zero changed answers, the −2-pt margin holds with no net loss or one. Two or more net losses would make the guard inconclusive, and the setting would stay off.

**Budget.** Estimate: generation and gold check $8; extraction 60 conversations × about 6 sessions × 2 arms × 2 runs, about $30; reader and judge 240 questions × 2 arms × 5 replicates, about $30; guard judging $4. Total about $72, within the remaining $82. Arms run only under a ledger reservation.
