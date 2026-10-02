# Plan: October 2 paid reruns (concept reranking cell, Cat 14, Cats 19 to 21)

Written on October 2, 2026, before any of these runs. gbrain is pinned at `d44296c` (v0.60.30.0). The wave's paid budget is $50 in total; a smoke run of the new concept adapter already spent $0.26 (278 questions, Voyage reranking).

## 1. Vectors with the same reranker on the concept questions (September 28 audit, B2)

**Question.** The README's concept comparison has gbrain at 102/181 without a reranker and 130/181 with Voyage `rerank-2.5`, against vectors at 118/181 without one. Does vector search gain as much from the same reranker?

**Comparison.** Four arms, each its own `cat13-conceptual.ts --adapter` run at `d44296c`, on the September 9 settings: Voyage `voyage-4` at 1024 dimensions for every arm, probe seed 42, 548 questions, the 20/10 concept split (181 held out), top five, autocut off, `search.metadata_boost_gate=lexical`, expansion off, cache off, `search.relational_rerank_pin=3`, `search.adaptive_return=false`.

1. `vector`: vector search alone (reproduces the 118/181 cell at the new pin).
2. `vector-rerank`: the same vector ranking, then gbrain's own `applyReranker` with the `balanced` mode's model, input depth (25) and timeout. New adapter.
3. `gbrain`, reranker off (reproduces 102/181).
4. `gbrain`, reranker on (reproduces 130/181).

**Metrics.** The headline is held-out questions with an exact target first, out of 181. Also nDCG@5 on all 548 and on the 181, and paired gains and losses on the 181 between arms 2 and 4 and between arms 1 and 2.

**Rules.** This is a descriptive cell, not a release decision. Every reranked arm must have a reranker score on every question; any skip, failure or pass-through makes that arm invalid and it is reported as such. If arm 1, 3 or 4 differs from its September number, the README reports the October numbers as the matched set and keeps the September numbers as history. Expected cost about $1.10 (about $0.50 per reranked arm).

## 2. Cat 14 with the current blind runner (audit A-01)

Run `bun eval/runner/cat14-calibration.ts` live once. Report its verdict, axes and cost; the May 75% stays retracted and historical. Expected cost under $1.

## 3. Cats 19, 20 and 21 with current runners (audit A-09)

- Cat 19: `CAT19_LIVE_EMBED=1 bun eval/runner/cat19-doctor-remediate.ts` (live OpenAI embeddings so the receipt is publishable), plus the hermetic default already run in CI. Expected cost under $0.05.
- Cat 20: `bun eval/runner/cat20-brainstorm.ts --live-judge`. Expected cost about $2.
- Cat 21: `bun eval/runner/cat21-code-retrieval.ts`. Expected cost about $0.30.

Each fresh receipt replaces the "invalid" marker in the May snapshot with a dated pointer; the May numbers stay as history. A failed or partial run is reported as it is, not rerun until it passes. Each run passes the runner's own budget flag where it has one, and stops if the running total would pass $50.

## 4. Live negative controls (WS3), added before running them

Added on October 2, 2026, after items 1 to 3 above ran and before either control below. The rule is the existing one (August 31 audit; `NEGATIVE_CONTROL_RATIO = 0.5` in `cat25-trajectory-routing.ts`): a deliberately degraded configuration must score at most half the real configuration at the same fixed seed and fixture. A control that fails the rule says the category cannot tell the degraded configuration from the real one.

- **Cat 25, trajectory routing in `think`.** Run `bun eval/runner/cat25-trajectory-routing.ts` live once (`claude-sonnet-4-6` at temperature 0, Haiku judge). The real arm is `withTrajectory: true`; the degraded arm is the baseline `withTrajectory: false` on the same probes. Today the runner enforces the ratio only in hermetic mode. Pass when the baseline judge mean is at most 0.5 times the wave judge mean. Expected cost $0.30 to $0.60.
- **Cat 13, concept search.** The real configuration is the October 2 `vector` arm with live Voyage `voyage-4` embeddings (held-out nDCG@5 0.6058, already measured above). The degraded configuration is the same arm with deterministic hash embeddings (`--stub-embed --adapter vector`, seed 42, same split). Pass when the degraded held-out nDCG@5 is at most 0.3029. Cost $0.
