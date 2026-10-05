# Memory proof wave: how many conversations the primary test needs, 2026-10-05

Before paying to run gbrain and the comparator memory server on sealed BEAM conversations, we checked for free whether the planned test can give an answer. It mostly cannot at the planned margin. The test asks whether gbrain's score is at most 2 points below the comparator's, but 42 sealed conversations are too few to show that reliably. If the two systems are truly equal, the test says "non-inferior" only about half the time, because chance alone moves the measured difference by about 1.2 points. A 3-point margin on the same 42 conversations works about 4 times in 5. No split of the 70 BEAM 500k and 1M conversations reaches 80% at 2 points under our central assumptions. The statistics themselves are sound: the bootstrap methods give the promised 95% one-sided coverage at 21 or more conversations.

**Recommendation (not adopted here; the preregistration needs the decision).** Keep the 14 dev / 14 validation / 42 sealed split and set the margin to 3.0 points. The planned 42 conversations are enough at 3.0 and not enough at 2.0. If the paid smoke shows room in the budget, add the BEAM 100k reserve (12 more sealed conversations, already committed in the grouping manifest). That raises the chance of showing non-inferiority at 3.0, when the systems are equal, from 79% to 87%.

## What was tested

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents: it keeps what it is told as Markdown pages and searches them, with no model call on writes. The comparator is an extract-first memory server, which calls a language model on each write to pull out facts. The [memory proof wave](2026-10-05-memory-proof-wave-preregistration.md) compares them under one audited protocol. Its primary claim is non-inferiority on [BEAM](https://arxiv.org/abs/2510.27246) 500k + 1M: the one-sided 95% lower bound of gbrain's graded score minus the comparator's must sit above −margin.

**A BEAM question.** Each BEAM conversation is a long chat between a user and an assistant, about 0.5 million tokens (500k size) or 1 million (1M size), with 20 questions of ten kinds. A typical one: after months of chats about building a web app, "In what order did I add the chat features, and which came last?" The judge checks the answer against a short rubric item by item, so a question can score 0, 0.5, 1 or a fraction in between. The graded score is the mean over questions, times 100.

**Why clustering matters.** The 20 questions of one conversation share one memory store, one ingest and one set of retrieval quirks. If gbrain mishandles one conversation, several of its questions go wrong together. Treating 840 questions as independent would overstate the precision. The independent units are the 42 conversations.

## Inputs

All inputs are public and no model was called. The public agent-memory benchmark harness, pinned in [`harness.lock.json`](../../eval/data/memory-proof-wave/harness.lock.json) at commit `f618ed7b`, commits per-question result files for several providers. [`inputs.json`](2026-10-05-memory-proof-wave-power/inputs.json) keeps only the scores, categories and cluster ids from those files, plus paired outcomes between providers.

### Clusters and per-history spread

The comparator's committed rows (answer model `gemini-3.1-pro-preview`, judge `gemini-2.5-flash-lite`; BEAM rows from its single-query mode):

| Dataset | Unit | Clusters | Questions | Questions per cluster | Mean score | Cluster means, min to max (SD) | ICC | Design effect |
|---|---|---:|---:|---|---:|---|---:|---:|
| BEAM 100k | conversation | 20 | 400 | 20 | 73.4 | 41.7 to 86.9 (9.5) | 0.022 | 1.42 |
| BEAM 500k | conversation | 35 | 700 | 20 | 71.1 | 49.6 to 90.2 (8.7) | 0.004 | 1.08 |
| BEAM 1M | conversation | 35 | 700 | 20 | 73.9 | 61.3 to 86.8 (6.9) | 0.000 | 1.00 |
| PersonaMem 32k | persona (37 histories) | 20 | 589 | 17 to 43 | 86.6 | 73.9 to 100 (7.0) | 0.006 | 1.18 |
| LifeBench | user | 10 | 2,003 | 158 to 228 | 71.5 | 63.1 to 81.0 (5.2) | 0.008 | 2.50 |

ICC is the share of score variance between clusters. The per-conversation spread on BEAM looks wide (50 to 90 points at 500k), but with 20 questions per conversation almost all of it is sampling noise: the ICC is near zero. What matters for a paired test is how much the *difference* between two systems varies by conversation, which a single provider's rows cannot show. The next section estimates it from paired runs.

### How often two systems disagree

The simulation needs two numbers: how much a per-question paired difference varies, and how much the true difference shifts from one conversation to the next.

**Per-question variance** comes from gbrain's own paired LongMemEval-S runs, documented in [the opaque-id follow-ups](2026-10-04-longmemeval-opaque-followups.md) and [the opaque-id QA report](2026-09-29-longmemeval-opaque-qa.md):

| Paired run | Wins / losses | Discordance | Variance of the difference |
|---|---|---:|---:|
| Reranker on against off, strict retrieval, 470 questions | +23 / −6 | 6.2% | 0.060 |
| One configuration answered twice (R2 against the published run), 500 | +15 / −16 | 6.2% | 0.062 |
| Reranker on against off, answers, 500 | +31 / −17 | 9.6% | 0.095 |
| Notes reader against direct reader, identical retrieval, 500 | +32 / −11 | 8.6% | 0.084 |
| gpt-5.4 reader against GPT-4o reader, identical retrieval, 500 | +33 / −16 | 9.8% | 0.097 |

Rerunning one configuration already disagrees on 6.2% of questions, so 6% is a floor for any two runs. The harness's committed rows give paired outcomes for genuinely different systems under one answer model and judge. These run higher, mostly because the systems differ in accuracy:

| Dataset | Pair | Wins / losses | Variance | Conversation effect (SD, points) |
|---|---|---|---:|---:|
| LongMemEval-S, 500 | comparator against hybrid-search baseline | +107 / −4 | 0.180 | n/a (one question per history) |
| LoCoMo10, 1,540 | comparator against hybrid-search baseline | +246 / −47 | 0.174 | 2.4 |
| PersonaMem 32k, 589 | comparator against hybrid-search baseline | +32 / −19 | 0.086 | 0.0 |
| PersonaMem 32k, 589 | comparator against a second memory server | +47 / −19 | 0.110 | 3.4 |
| PersonaMem 32k, 589 | hybrid-search baseline against a second memory server | +36 / −21 | 0.096 | 4.2 |
| LifeBench, 2,003 | comparator against hybrid-search baseline | +377 / −165 | 0.259 | 3.6 |

The conversation effect is the between-cluster SD of the true paired difference (method of moments). It is estimated from only 10 to 20 clusters each, so it is rough.

### Four assumption sets

| Set | Per-question variance | Conversation effect | Source |
|---|---:|---:|---|
| Optimistic | 0.060 | 0 | gbrain's +23/−6 of 470 |
| Central | 0.097 | 3.5 points | gbrain's widest answer-level paired run (+33/−16 of 500); median of the four positive cross-system conversation effects |
| Pessimistic | 0.259, capped at 0.219 (500k) and 0.161 (1M) | 4.2 points | the widest cross-system run (LifeBench); the largest conversation effect |
| Stress | as central | 3.5 points, plus 1 in 10 conversations losing 15 points | coverage check against skew, such as an ingest that half fails |

BEAM's graded scores cap the per-question variance: two systems that answer every question independently would reach only 0.219 at 500k and 0.161 at 1M. The pessimistic set is therefore "the two systems agree no more than chance would", which is harsher than any measured pair of real systems on these datasets.

## Method

[`power.ts`](../../eval/runner/memory-proof-wave/power.ts) simulates one sealed run 4,000 times per cell:

1. In each BEAM size, draw the sealed conversations at random from the real 35, keeping each one's 20 question categories.
2. A question is discordant with a probability set so the per-question variance matches the assumption set. A discordant question's difference is the gap between two independent draws from the committed scores of that question's category and size, so partial credit behaves as it does in BEAM.
3. Each conversation's questions shift together by a normal draw with the conversation-effect SD.

The statistic is the mean paired difference over sealed questions with a stratified cluster-robust (CR1) standard error, strata being the BEAM sizes. "Stratified by split" in the plan means these harness splits (500k and 1M). The dev / validation / sealed split is not a stratum, because the test uses sealed conversations only. [`ni-stats.ts`](../../eval/runner/memory-proof-wave/ni-stats.ts) computes five one-sided 95% lower bounds (999 bootstrap draws in the simulation):

- `analytic`: CR1 t bound with G − 2 degrees of freedom;
- `percentile`: stratified cluster bootstrap percentile;
- `boot-t`: stratified cluster bootstrap-t;
- `wild-u`: unrestricted wild cluster bootstrap-t, Rademacher or Webb weights;
- `wild-r`: restricted wild cluster bootstrap-t, with the null imposed and the bound found by inverting the test.

A true difference enters as a location shift. The first four bounds move exactly with a shift (a test checks this), so one simulation at a true difference of 0 gives coverage, power at every true difference and the minimum detectable margin. The restricted test is run at 17 distances between the null and the truth.

## Results

### Coverage

One-sided coverage is the share of simulated runs whose lower bound sits at or below the true difference; the target is 95%, and the engineering review's acceptance bar is 93%. With 4,000 runs the Monte Carlo error is ±0.7 points.

| Cell (sealed clusters) | Set | analytic | percentile | boot-t | wild-u Webb | wild-r Webb |
|---|---|---:|---:|---:|---:|---:|
| BEAM 500k + 1M (42) | optimistic | 95.2 | 94.4 | 95.0 | 95.1 | 95.4 |
| | central | 94.8 | 94.0 | 94.9 | 94.7 | 94.8 |
| | pessimistic | 94.6 | 93.4 | 94.4 | 94.3 | 94.5 |
| | stress | 95.0 | 94.2 | 95.2 | 94.9 | 95.0 |
| One BEAM size (21) | stress | 94.3 | 93.0 | 94.8 | 94.2 | 94.2 |
| PersonaMem 32k (12 personas) | central | 94.8 | 92.9 | 94.7 | 94.8 | 94.9 |
| | stress | 93.2 | 90.7 | 93.9 | 93.3 | 93.4 |
| LifeBench (6 users) | central | 95.0 | 90.0 | 94.9 | 95.0 | 94.8 |
| | stress | 89.7 | 83.4 | 90.9 | 89.8 | 89.4 |

At 21 or more conversations, every method except the percentile bootstrap holds 94% to 95.5% under all four sets. The percentile bootstrap runs 1 to 2 points short at 42 and up to 12 points short at 6 clusters, so it is not used. At LifeBench's 6 sealed users, no method holds coverage when one user can fail badly. LifeBench can support a descriptive row but not a bound-based claim. The preregistration names the restricted wild cluster bootstrap-t with Webb weights as the primary method (the standard choice for few clusters, and as good as any here), with the analytic and bootstrap-t bounds reported beside it.

### Power on the planned design

The chance that the lower bound clears −margin, for BEAM 500k + 1M with 42 sealed conversations, by true difference (gbrain minus comparator, points), with the restricted wild bootstrap:

| Margin | Set | True −2 | True −1 | True 0 | True +1 | True +2 |
|---|---|---:|---:|---:|---:|---:|
| 2.0 | optimistic | 4.6% | 32% | 75% | 97% | 99.9% |
| 2.0 | **central** | 5.2% | 21% | **50%** | 79% | 95% |
| 2.0 | pessimistic | 5.5% | 16% | 34% | 56% | 77% |
| 2.0 | stress | 5.0% | 17% | 40% | 66% | 86% |
| 3.0 | optimistic | 32% | 75% | 97% | 99.9% | 100% |
| 3.0 | **central** | 21% | 50% | **79%** | 95% | 99% |
| 3.0 | pessimistic | 16% | 34% | 56% | 77% | 91% |
| 3.0 | stress | 17% | 40% | 66% | 86% | 96% |

The "true −2" column at margin 2.0 is the false-positive rate at the margin, which stays at the nominal 5%. The minimum detectable margin (the smallest margin shown 80% of the time when the systems are equal) is **2.2 points optimistic, 3.0 central, 4.2 pessimistic and 3.7 under stress**. The measured difference has a standard deviation of 0.84, 1.22, 1.66 and 1.39 points in the four sets.

### Alternatives

| Design | Sealed conversations (questions) | Minimum detectable margin: optimistic / central / pessimistic / stress | Central power at 2.0 | Central power at 3.0 |
|---|---|---|---:|---:|
| **Plan: 500k + 1M, 14 / 14 / 42** | 42 (840) | 2.2 / 3.0 / 4.2 / 3.7 | 50% | 79% |
| Add BEAM 100k, same rule, 18 / 18 / 54 | 54 (1,080) | 1.9 / 2.7 / 3.7 / 3.1 | 58% | 87% |
| 500k + 1M, 7 / 7 / 56 | 56 (1,120) | 1.9 / 2.7 / 3.6 / 3.1 | 59% | 88% |
| 100k + 500k + 1M, 9 / 9 / 72 | 72 (1,440) | 1.7 / 2.4 / 3.1 / 2.7 | 69% | 94% |
| Every 500k + 1M conversation, none for tuning | 70 (1,400) | 1.7 / 2.4 / 3.2 / 2.7 | 68% | 94% |

The detectable margin shrinks with the square root of the number of conversations, so a 2.0-point margin at 80% power under the central set needs about 96 sealed conversations. BEAM 100k, 500k and 1M together have 90. Shrinking dev and validation to 7 each buys as much as adding 100k, but leaves 140 questions to confirm each fix, which the plan relies on. Adding 100k costs paid cells for both systems on 20 shorter conversations instead.

### How the answer moves with the assumptions

Closed-form minimum detectable margin for the planned 42 conversations (where both were computed, it agrees with the simulation to within about 0.05 points):

| Per-question variance | No conversation effect | 2 points | 3.5 points | 5 points |
|---:|---:|---:|---:|---:|
| 0.04 | 1.75 | 1.92 | 2.22 | 2.62 |
| 0.06 | 2.14 | 2.28 | 2.54 | 2.90 |
| 0.08 | 2.47 | 2.59 | 2.83 | 3.15 |
| 0.10 | 2.77 | 2.87 | 3.09 | 3.39 |
| 0.15 | 3.39 | 3.48 | 3.65 | 3.91 |
| 0.20 | 3.72 | 3.80 | 3.96 | 4.20 |

A 2.0-point margin is detectable only if the per-question variance stays below about 0.05 with no conversation effect. That is less disagreement than gbrain shows against itself when one configuration answers twice (0.062).

## What to use and what to avoid

- **Use a 3.0-point margin on the planned 42 conversations**, or justify a different number in the preregistration before any paid cell. At 3.0 the plan's design resolves the central case. A loss of 3 points on a score near 72 is about a 4% relative loss, the same tolerance the [sealed v2 decision](2026-10-02-sealed-v2-decision-1-preregistration.md) used.
- **Do not keep 2.0 and hope.** With equal systems, an `inconclusive` outcome is as likely as `non-inferior`. The plan forbids changing the margin after seeing sealed results.
- **Treat a true deficit honestly.** If gbrain is truly 1 point behind, a 3.0-point test shows non-inferiority half the time under the central set. That is the intended trade-off of a margin, not a flaw.
- **Report PersonaMem and LifeBench as their own rows.** PersonaMem's 12 sealed personas give a minimum detectable margin of 3.5 to 7.4 points. LifeBench's 6 sealed users cannot hold coverage under skew. Both are descriptive.
- **Limits of this simulation.** The score shapes come from the comparator's committed BEAM rows, made with an older answer model, the `gemini-2.5-flash-lite` judge and a mode absent at the pinned harness commit. The wave's runs use another judge, which BEAM's code forces. The per-question variance comes from LongMemEval-S, where accuracy is near 90%. On BEAM, where it is near 72%, disagreement may be higher, which is why the pessimistic set uses BEAM's own independent-systems ceiling. The conversation effect is estimated from 10 to 20 clusters per dataset. The dev slice's first paid runs give a direct estimate of both numbers; if they exceed the central set, the preregistration should widen the margin or add BEAM 100k before any sealed cell.

## The grouping manifest

[`grouping-manifest.json`](../../eval/data/memory-proof-wave/grouping-manifest.json) fixes the split before any tuning. Each stratum's clusters are ordered by HMAC-SHA256 of a private 32-byte salt and the cluster id: the first 20% are dev, the next 20% validation, the rest sealed. PersonaMem is split by persona, so a persona's histories never straddle splits. The public file lists every cluster, the dev ids and counts, and a salted SHA-256 commitment for each validation and sealed list. The salt and those lists sit in a private file outside the repository, whose SHA-256 is committed in the manifest, under the same custody, access-log and `--decision-id` rules as the [sealed confirmation set](2026-09-29-sealed-confirmation-protocol.md).

| Group | Stratum | Dev | Validation | Sealed (questions) |
|---|---|---:|---:|---:|
| Primary | BEAM 500k | 7 | 7 | 21 (420) |
| Primary | BEAM 1M | 7 | 7 | 21 (420) |
| Secondary | PersonaMem 32k (personas) | 4 | 4 | 12 (375) |
| Secondary | LifeBench (users) | 2 | 2 | 6 (1,246) |
| Reserve | BEAM 100k | 4 | 4 | 12 (240) |

Opening validation ids logs the access. Opening sealed ids also needs a decision id and a committed preregistration with no `TODO` left; the log line records the preregistration's hash. BEAM is public, so once validation ids are open the sealed ids are the complement. The protection is procedural: the commitments prove the split predates tuning, and the log records every open.

## Reproduce and inspect

```bash
git clone <HARNESS_REPO from eval/data/memory-proof-wave/harness.lock.json> /tmp/harness
git -C /tmp/harness checkout f618ed7b1f0eb9cad7b42e876f91a42f0eadb150
bun eval/runner/memory-proof-wave-power.ts extract --harness /tmp/harness   # rewrites inputs.json byte for byte
bun eval/runner/memory-proof-wave-power.ts simulate                          # 4,000 runs x 999 draws per cell, about 20 minutes on 1 core
bun eval/runner/memory-proof-wave-grouping.ts check
bun test test/eval/memory-proof-wave-power.test.ts test/eval/memory-proof-wave-grouping.test.ts
```

No keys and no paid calls. Outputs: [`power.json`](2026-10-05-memory-proof-wave-power/power.json) (every cell, method, margin and true difference; inputs SHA-256 `1cbfed98…`) and [`inputs.json`](2026-10-05-memory-proof-wave-power/inputs.json). Seed `20261005`.
