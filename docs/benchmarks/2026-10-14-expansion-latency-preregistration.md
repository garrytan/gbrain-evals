# Query expansion latency on LongMemEval-S: preregistration (GBRA-94)

**Status, 2026-10-14: final; results below.** Preregistered 2026-10-14 in commit 9f15c45a, before any of the 300 counted brains was built
and before any counted query ran. A 3-haystack pilot on questions outside the subset (below) checked the harness and
the cost; its rows are not scored and are not published as results. The owner (Efficiency captain) runs this with
Sina's approval and a hard cap of $5 in provider spend.

## The question

On `tokenmax` (the new-install default), `gbrain query` sends each query to the expansion model
(`anthropic:claude-haiku-4-5-20251001`, `DEFAULT_EXPANSION_MODEL`) before the vector side can embed the rewrites. On
Sina's real brain (GBRA-66, gbrain v0.60.212.0) a warm query took 1.9–2.2 s with expansion and 0.36–0.39 s without;
the expansion call is 1.5–1.8 s of that. It is the largest remaining latency in gbrain search.

Which expansion setup is fastest while keeping retrieval quality? This recommends one setting. It changes no gbrain
default and no search ranking. A shipped-default change would be its own gbrain PR with this result as evidence, and
goes to Garry first; a per-brain setting is Sina's call.

Related: the [October 12 wave gates](2026-10-12-lhf-wave.md) measured expansion on `balanced` (no reranker) and made
expansion follow the mode. This run measures it on `tokenmax`, with the reranker, which is where it still runs by
default.

## Arms

Only the expansion step differs between arms. Every arm is a harness-side switch: no gbrain code or config change.

| arm | what changes | how |
|---|---|---|
| **A1** reference | nothing: `tokenmax` expands with the shipped default `claude-haiku-4-5-20251001` | |
| **A2** noise re-run | A1 again, with fresh expansion calls | measures expansion-sampling noise |
| **B** no expansion | `query` with `expand: false` | the shim's `expand` query knob |
| **C-haiku-5-5** | expansion model `anthropic:claude-haiku-5-5` | `GBRAIN_EXPANSION_MODEL` in gbrain's environment |
| **C-gpt-6-luna** | expansion model `openai:gpt-6-luna` | `GBRAIN_EXPANSION_MODEL` |
| **C-gemini-3.8-flash** (screen) | expansion model `google:gemini-3.8-flash` | `GBRAIN_EXPANSION_MODEL` plus `GOOGLE_GENERATIVE_AI_BASE_URL` at the proxy |
| **D-short** | skip expansion when the query looks like a keyword or entity lookup (A1 otherwise) | derived per query from A1 and B rows |
| **D-long** | skip expansion when the query is a pasted passage (A1 otherwise) | derived from A1 and B rows |
| **D-short+long** | skip when either rule fires | derived from A1 and B rows |

**C models.** The newest small model of each family that gbrain's provider layer runs today. gbrain resolves
`GBRAIN_EXPANSION_MODEL` at connect and checks only that the provider has an expansion touchpoint, so ids newer than
the recipes' expansion lists run through the shipped native code path (structured output via `generateObject`, no
provider options). The pilot confirmed each one returned expansions that gbrain applied. `gpt-6-luna` and
`gemini-3.8-flash` run at their API defaults for reasoning/thinking, because gbrain's expansion call sets none; that is
what a user who configures them gets. `gpt-5.4-mini` is not run. Prices (list, USD per million tokens, in/out):
Haiku 4.5 1.00/5.00, Haiku 5.5 0.10/0.50, GPT-6 Luna 0.10/0.50, Gemini 3.8 Flash 0.75/3.75 (introductory, thinking
billed as output).

**Eval-model rules.** No reader or judge model is used. Haiku 4.5 is in the run only because it is the shipped default
under test (the reference), not as a comparison model. The newest frontier models (Opus, GPT, Sonnet) are not added:
the question is whether a faster or cheaper expansion keeps quality, larger models are slower and costlier per call
than the reference, and the $5 cap does not cover them.

**C-gemini-3.8-flash is a screen.** In the pilot it took 3–7 s per expansion with default thinking, about 3x the
reference, and costs about $1.65 per 1,000 queries, so all 300 questions don't fit the cap. It runs on the nested
90-question subset `subset-k90.json` (same selection rule; every question in it is in the 300) and is compared with
A1 on those 90. It is reported, but it cannot be recommended (see the decision rule).

**D rules** (`harness/rules.ts`, text features only; fixed before any counted row):

- **D-short**: at most 4 words, or at most 8 words with no `?` and a first word that is not a question word. On this
  set it fires on 1 of 300 questions and 0 of 300 probes: LongMemEval questions are full sentences. The skip share is
  reported because real brains see more keyword lookups.
- **D-long**: at least 30 words. It fires on 20 of 300 questions and 296 of 300 probes (300-character passages).

A D arm's row for a query is B's row when its rule fires and A1's row otherwise. Because each query is independent,
that is the row a live D run would produce, with the same expansion samples.

**Overlapping expansion with retrieval.** On master, expansion already runs alongside the lexical and relational arms
(`startVectorSide` in `src/core/search/hybrid/arms.ts`); only the vector side waits for it. Starting the original
query's embedding beside the expansion call needs a product change, and GBRA-67 built and measured exactly that patch:
no measurable gain (p50 2,209 vs 2,154 ms over MCP). It is not an arm here.

## Design

- **Product under test:** gbrain master `25fc69e0` (v0.60.222.0), run from source with Bun 1.4.3.
- **System:** the scoreboard's `gbrain-defaults` shim at gbrain-evals `846fa6dd` (the classifier pin of #120, #141 and
  #148), run as a local process, with two harness-side patches in `2026-10-14-expansion-latency/harness/`:
  - GBRA-86's line: every install runs `gbrain config set search.cache.enabled false`, so a repeated query is never a
    semantic-cache hit.
  - `shim-arm-env.patch`: the shim reads the arm's environment (`GBRAIN_EXPANSION_MODEL`, the Google base URL) from a
    harness file, adds it to gbrain's environment, and restarts serve when the arm changes, so gbrain resolves the
    arm's model at connect. gbrain's config file and resolved configuration (`gbrain models --json`, which does not
    report the environment pin) stay identical to the reference install's, and the shim's drift checks run unchanged.
- **Brains:** one PGLite brain per haystack, a clean `gbrain init --pglite` with shipped defaults (voyage-4 at 1,024
  dimensions, `tokenmax`, `voyage:rerank-2.5`, Haiku 4.5 expansion), written through `put_page` over
  `serve --surface starter` in the scoreboard sanitizer's ingest order, then the shim's doctor-gated finish. Built the
  same way as GBRA-86's; they are rebuilt here because GBRA-86's machine was archived.
- **Providers and freezing:** every call goes through a local proxy (`harness/proxy.ts`) that `provider_base_urls`
  point at.
  - Embeddings are cached **per input text**: a request is answered from the cache and only missing texts go upstream,
    once. Every arm gets identical vectors for the same text.
  - The reranker is cached **per (model, query, document) score**: only missing documents go upstream, once, and the
    response is rebuilt from the cached scores in score order. A calibration call showed Voyage `rerank-2.5` scores a
    document the same in a 12- or 24-document request (max difference 0.0022, within the 0.0028 jitter of repeating
    the same request), so identical candidates get identical scores in every arm.
  - Expansion is **never shared between arms**: each arm makes its own call for each query (a retry within an arm
    reuses that arm's call). During builds, LLM calls are refused.
- **Order:** arms run interleaved. For each question, every arm runs in an order rotated by the question's index, so
  provider latency drift over the run affects every arm alike. Each arm starts a fresh serve; before its counted
  queries an uncounted warm-up query (the question with `expand: false`, which is arm B's request) runs, so counted
  queries are warm. 4 workers, one brain per worker at a time, on a 4 vCPU cloud machine.

## Data

LongMemEval-S cleaned, Hugging Face `xiaowu0162/longmemeval-cleaned` at `98d7416c` (development data, not a held-out
claim). The same 300 questions as GBRA-86 (`2026-10-14-expansion-latency/subset-k300.json`, SHA-256
`df32622259e08b23…`, byte-identical to #141's): multi-session 80, temporal-reasoning 80, knowledge-update 47,
single-session-user 42, single-session-assistant 33, single-session-preference 18. The screen subset
`subset-k90.json` (SHA-256 `fe82bf71a5b36…`) uses the same rule: multi-session 24, temporal-reasoning 24,
knowledge-update 14, single-session-user 13, single-session-assistant 10, single-session-preference 5.

**Queries per question:** the real question, and the readiness probe (the first 300 characters of the longest turn of
the last ingested session). 600 queries per arm.

## Metrics

- **Quality** (real query, over the first cited sessions, `strictSources`; gold `answer_session_ids`, `_abs`
  included): strict recall@10 (primary), strict recall@5, nDCG@10 (binary relevance, mean over questions).
- **Clean reads:** the pinned classifier's outcome is `scored`, for real queries and probes. In B and in a D arm's
  skipped queries, expansion is off by design and the classifier reports `expansion_not_applied`; a read whose only
  reason is that one counts as clean. Any other reason, or `expansion_not_applied` in an expanding query, is not clean.
- **Probe found** (the last session among the cited sources): diagnostic.
- **Expansion latency:** wall time of the expansion call(s) at the proxy, per query, fresh calls only. 0 for a query
  that does not expand. Also gbrain's own `stage_timings.expansion`.
- **End-to-end latency:** the shim's timed MCP `query` call, minus the time the proxy spent on upstream embedding or
  rerank calls during that query (the union of their intervals). Providers other than expansion are frozen and answered
  from the cache, so this is gbrain's own time plus the live expansion call: the difference between arms is the
  expansion setup. The live embedding and rerank latencies measured on cache misses are reported alongside.
- p50 and p95 over the 600 queries of an arm, and over the 300 real queries.
- **Cost:** expansion $ per 1,000 queries, from each call's usage counts at list price. Embedding and rerank cost per
  query are the same in every arm up to the variant embeddings, which are reported.
- An error after one retry counts as a miss for every metric of that query.

## Decision rule

An arm is **acceptable** when all of these hold against A1 on the same questions:

1. strict recall@10 is at least A1's minus 2 questions;
2. no question type loses more than 2 questions net on strict recall@10;
3. mean nDCG@10 is at least A1's minus 0.005;
4. real-query clean reads and probe clean reads are each at least A1's minus 2;
5. the arm is valid: at most 2% of its queries errored.

**Recommendation:** among acceptable arms other than A2 and the Gemini screen, the arm with the lowest end-to-end p50;
if several are within 5% of that p50, the cheapest of them by expansion $ per 1,000 queries. If no acceptable arm has a
lower end-to-end p50 than A1, the recommendation is to keep the default. strict recall@5, probe found and exact
McNemar p-values on strict recall@10 are diagnostics and do not gate; a strict@5 loss of more than 3 in the
recommended arm is called out.

**Noise:** A2 is scored against A1 like any arm. Its distance from A1 is the run-to-run noise from expansion
sampling; a difference of that size between arms is not evidence.

The rule is evaluated by `harness/score.ts` over the stored rows, and every arm's row is published whatever it shows.
With eight compared arms the chance that some arm passes by luck is higher than for one; the report says so.

## Size and cost

Measured in the pilot (3 haystacks), at list price:

| step | estimate |
|---|---|
| build 300 brains (about 128k voyage-4 tokens each) | $2.31 |
| rerank and query embeddings, all arms (pair and text caches shared) | $1.16 |
| expansion: A1 + A2 (Haiku 4.5) | $0.74 |
| expansion: Haiku 5.5 + GPT-6 Luna | $0.10 |
| expansion: Gemini 3.8 Flash on 90 questions | $0.30 |
| pilot and calibration so far | $0.06 |
| **total** | **$4.67** |

The proxy refuses any call that would take its running total past $4.90. If the cap stops the run part-way, questions
without every arm are dropped from every arm (the Gemini screen from its 90 only), so all arms are scored on the same
questions. Spend figures are estimates from the providers' usage counts at list price, not metered invoices.

## What it decides

One recommended expansion setting, with its latency and cost against today's default. It does not change gbrain's
defaults or search ranking.

## Results (2026-10-14)

**Recommendation under the rule: B, no expansion on `query`.** It keeps retrieval quality within every margin and cuts
end-to-end query time from 2,022 to 227 ms p50 (2,292 to 384 ms p95), about 9x faster. Expansion bought no question in
this run: no expanding arm got a question right that B missed.

All 300 questions were built and every arm ran on all 300 (600 queries per arm; the Gemini screen on its 90). Every
read was clean under the pinned classifier, no query errored, and every expanding query applied its expansion.
Machine-readable aggregates: `2026-10-14-expansion-latency/results/` (`verdict.json`, `spend.json`); `harness/score.ts`
evaluates the rule.

| arm | n | strict@10 | arm-only / A1-only | strict@5 | nDCG@10 | max type loss | skipped | expansion p50 / p95 ms | end-to-end p50 / p95 ms | real-query e2e p50 / p95 ms | expansion $ per 1k queries | acceptable |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **A1** reference (Haiku 4.5) | 300 | **299** | | **287** | **0.9569** | | 0% | 1,543 / 1,760 | 2,022 / 2,292 | 1,997 / 2,265 | 0.631 | ref |
| A2 noise re-run | 300 | 298 | 0 / 1 | 287 | 0.9582 | 1 | 0% | 1,550 / 1,792 | 1,963 / 2,260 | 1,917 / 2,239 | 0.632 | yes |
| **B** no expansion | 300 | 298 | 0 / 1 | 285 | 0.9577 | 1 | 100% | 0 / 0 | **227 / 384** | 208 / 352 | 0 | **yes** |
| C `claude-haiku-5-5` | 300 | 298 | 0 / 1 | 287 | 0.9589 | 1 | 0% | 1,398 / 2,358 | 1,853 / 2,863 | 1,837 / 3,085 | 0.098 | yes |
| C `gpt-6-luna` | 300 | 298 | 0 / 1 | 285 | 0.9581 | 1 | 0% | 2,523 / 3,885 | 3,333 / 5,006 | 3,577 / 5,124 | 0.077 | yes |
| C `gemini-3.8-flash` (screen; A1 on the same 90: 90, 0.9622, 2,013 ms) | 90 | 88 | 0 / 2 | 84 | 0.9570 | 1 | 0% | 4,615 / 6,459 | 5,133 / 7,004 | 5,619 / 7,344 | 1.554 | no: nDCG |
| D-short | 300 | 299 | 0 / 0 | 287 | 0.9569 | 0 | 0.2% | 1,543 / 1,760 | 2,022 / 2,292 | 1,996 / 2,265 | 0.630 | yes |
| D-long | 300 | 299 | 0 / 0 | 287 | 0.9569 | 0 | 52.7% | 0 / 1,695 | 401 / 2,191 | 1,984 / 2,254 | 0.280 | yes |
| D-short+long | 300 | 299 | 0 / 0 | 287 | 0.9569 | 0 | 52.8% | 0 / 1,695 | 401 / 2,191 | 1,977 / 2,254 | 0.279 | yes |

Clean reads were 300/300 (real) and 300/300 (probe) in every 300-question arm and 90/90 in the screen, and the probe
found its session in every query. Latencies are over all 600 queries of an arm (real queries and probes); the
end-to-end figure excludes upstream embedding and rerank time, which the proxy answered from cache (live calls measured
on cache misses: embeddings p50 130 / p95 161 ms, rerank p50 167 / p95 491 ms, the same in every arm).

What the table says:

- **Every acceptable arm lands within one question of A1, and so does A1's own re-run.** A2 loses the same single
  knowledge-update question as B and the C arms (McNemar p = 1). One question is the noise floor here; no arm is
  distinguishable from the reference on strict@10.
- **B is the only large latency win.** It removes the expansion call (1.5 s p50) and the variant embeddings behind it.
  strict@5 drops 2 (287 → 285), under the 3-question callout threshold; nDCG@10 rises 0.0008.
- **A faster expansion model barely helps.** `claude-haiku-5-5` is 145 ms faster at p50 (−7%) and 6x cheaper, but its
  p95 is 570 ms slower. `gpt-6-luna` and `gemini-3.8-flash` are slower than Haiku 4.5 at their default reasoning
  (gbrain's expansion call sets none). Gemini also fails nDCG on its screen (−0.0052 against A1 on the same 90).
- **The skip heuristics cost nothing on quality, but only help pasted-passage queries.** D-long skips 296 of 300
  probes and 20 of 300 questions. Its arm p50 drops to 401 ms because half the arm's queries are probes; real questions
  stay at 1,984 ms. D-short fires on 1 query: LongMemEval questions are full sentences, so this set can't show what it
  would do on keyword-style traffic.
- **On real questions, D-long skips 20 of 300 with no quality change,** so long-passage queries are a safe skip, but B
  is faster and also passes.

Caveats: this is development data (LongMemEval-S, conversation memory) where the reference is near ceiling (299/300
strict@10), so a recall benefit from expansion could exist on harder or keyword-heavy corpora that this set can't show.
With eight compared arms, one passing by luck is more likely than for one arm. The October 12 wave saw the same
direction on `balanced` (451 vs 448 of 470 without expansion).

Deviations and notes:

- **Brains:** 303 state files were built (the 300 plus the 3 pilot haystacks, which are not scored). 7 sessions across
  the haystacks were refused as duplicate session ids (HTTP 409), as in #141; identical in every arm.
- **Spend** (`results/spend.json`): an estimated $4.71 of the $5 cap, including the pilot: $2.36 building 300 brains
  (voyage-4), $1.19 reranking (frozen pair cache, shared by all arms and warm-ups), $0.76 Haiku 4.5 expansion (A1 + A2),
  $0.29 Gemini screen, $0.06 Haiku 5.5, $0.05 GPT-6 Luna. Estimates from providers' usage counts at list price, not
  metered invoices.
