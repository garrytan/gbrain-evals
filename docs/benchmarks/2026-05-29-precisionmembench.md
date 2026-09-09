# PrecisionMemBench: how much irrelevant memory do we return?

First published May 29, 2026. The original gbrain runs were measured May 30. Corrected seeding was audited August 31; fresh runs were completed September 9.

Finding the right fact is only half the problem. A search that returns that fact along with nineteen distractions has high recall and low precision. PrecisionMemBench asks us to pay attention to the distractions.

The [September 9 rerun](2026-09-09-retrieval-refresh.md) confirms a useful gbrain setting: when the application expects one fact, a tight result limit substantially improves precision. It also confirms the cost: some relevant facts disappear. This is an application choice, not a universal search improvement.

## What the benchmark asks

[PrecisionMemBench](https://github.com/tenurehq/precisionmembench), by tenurehq / Jeffrey Flynt, provides 35 beliefs and 77 single-query cases. There are also 12 session cases; this report does not run them. A belief is a small piece of memory with text, aliases, and a scope, such as code preferences or writing preferences.

Imagine two memories: “Use Postgres for new services” and an older, superseded preference that also mentions Postgres. A search must find the current preference without returning the old one merely because the words match. The real fixture includes a superseded SQLAlchemy belief with the alias “Postgres,” which makes this problem concrete.

Precision is the fraction of returned belief IDs that belong in the answer. Recall is the fraction of expected IDs that were returned. If one belief is expected and we return it with nine others, precision is 0.10 and recall is 1.00. Some cases require an empty set. The scorer examines IDs, not the quality of a generated answer.

Means exclude cases where the scorer returns null for that metric. In the fresh rows below, recall has 43 scored cases in each arm; precision has 49 / 70 / 70 / 65 / 66 scored cases respectively. These are not the same denominator as active passes. “Active passes” counts the 43 active cases; the full pass count also includes structural cases. Some structural results are assembled by the shared harness from the fixture, so their passes are not evidence that gbrain independently implemented those features.

## The corrected result

The May harness accidentally read the answer key. It used the fixture's `superseded_by` field to soft-delete four beliefs before searching. The upstream provider contract supplies only `{text, user_id, metadata, aliases}`. Other providers must work out supersession from the text itself.

The August 31 paired keyword check measured the seeding correction directly: mean precision fell from 0.1389 to 0.1361 and total passes from 35/77 to 34/77. The newly failing `persona-prelude-content-present` case returned the live superseded SQLAlchemy belief through its “Postgres” alias. That local comparison isolates the seed change; the September release comparison below changes more than seeding.

Current seeding keeps all 35 beliefs live. The September 9 runs use the current pinned gbrain release and explicit settings, complete all 77 cases, and report zero execution errors. Their full configuration and receipts are in the [refresh report](2026-09-09-retrieval-refresh.md).

| September 9 configuration | Mean precision | Mean recall | Active passes | All cases passed |
|---|---:|---:|---:|---:|
| Keyword search | 0.1361 | 0.1744 | 5/43 | 34/77 |
| Hybrid search, reranker off | 0.0565 | 0.9884 | 0/43 | 7/77 |
| Hybrid search, reranker on | 0.0565 | 0.9884 | 0/43 | 7/77 |
| Tight adaptive limit, reranker off | 0.5333 | 0.7320 | 25/43 | 38/77 |
| Tight adaptive limit, reranker on | 0.5859 | 0.8250 | 29/43 | 41/77 |

“Tight” means at most one result for both entity questions and other questions (`entityMax=1`, `otherMax=1`). The adaptive feature is opt-in. Its ordinary caps are two and six; enabling the feature is separate from choosing its caps.

Broad hybrid search finds almost every expected belief but returns many extras. Reranking the same broad set does not change set precision. Once the result set is capped, order matters: the reranker improves both precision and recall in the fresh tight-limit run. This is why a good ordering score and a good returned set are different things.

For “What is my database preference?”, one result can be useful. For “Who has worked on infrastructure?”, one result may hide most of the answer. The benchmark supports exposing the choice. It does not support turning on a one-result limit for every user.

## What the May report recorded

The following table is retained as the historical record. Every May gbrain row used the flawed seeding. These are not current, comparable leaderboard entries. In particular, the old 0.582 score and 44/77 passes must not be substituted for the corrected 0.5859 and 41/77 result above: the release and configuration also changed.

| System | Precision | Active passes | Pass | p50 |
|---|---|---|---|---|
| tenure (author) | 1.00 | 43 | 77/77 | 9.8ms |
| **gbrain — adaptive (tight)** | **0.582** | **29** | **44/77** | ~270ms |
| supermemory | 0.43 | 17 | 44/77 | 819ms |
| gbrain — adaptive (recall-preserving) | 0.40 | 12 | 21/77 | ~270ms |
| gbrain — think (cited set) | 0.38 | 15 | 26/77 | 4945ms |
| **gbrain — default hybrid** | **0.075** | **0** | **7/77** | ~270ms |
| yourmemory | 0.17 | 0 | 21/77 | 313ms |
| agentmemory | 0.17 | 0 | 7/77 | 82ms |
| atomicmemory | 0.15 | 0 | 9/77 | 71ms |
| zep | 0.09 | 0 | 9/77 | 124ms |
| vector baseline | 0.088 | 0 | 9/77 | — |
| mem0 | 0.056 | 0 | 9/77 | 65ms |

The standalone hybrid artifact records 0.0752; the instrument sweep records 0.0756. Those are separate runs, rounded differently. We have not established the cause of the difference. Earlier versions of this report called it embedding jitter without isolating that cause.

External rows also belong to the original snapshot. The [upstream README](https://github.com/tenurehq/precisionmembench), checked September 9, lists supermemory at 0.22 precision and roughly 69 ms, rather than this table's 0.43 and 819 ms. We did not reproduce either external run. The old claim that gbrain was “#2 at a third of supermemory's latency” is therefore not a supported comparison.

## Why we tried an adaptive limit

Gbrain combines keyword matches and embedding matches. Embeddings help with paraphrases; keywords help with names and exact terms. Returning a broad set is often useful when another stage must compare several documents. PrecisionMemBench makes the cost of that breadth visible.

The May sweep tried progressively smaller result caps. It is historical evidence from the flawed seed, useful for understanding the experiment but not for quoting current scores.

| Setting | Precision | Recall | Active | Pass |
|---|---|---|---|---|
| off (default top-K) | 0.076 | 0.99 | 0 | 7/77 |
| caps entity=2 / other=6 (shipped default) | 0.16 | 0.96 | 1 | 8/77 |
| caps entity=1 / other=2 (recall-preserving) | 0.40 | 0.91 | 12 | 21/77 |
| caps entity=1 / other=1 (max precision) | 0.58 | 0.82 | 29 | 44/77 |

We also considered stopping where retrieval scores fall sharply. The old instrumentation found the right belief first in 94% of single-answer cases, but the mean first-to-second score gap was 0.602 when the first result was right and 0.569 when it was wrong. Those two summaries did not establish a reliable confidence threshold. A large gap in a rank-fusion score can come from the ranking formula itself.

The instrument originally keyed captured scores by query text, then changed to case IDs after audit finding `precisionmembench-05`. The duplicated query strings shared scope and budget in this fixture, so that keying issue did not change these recorded summaries. It remains separate from the seeding flaw.

## Search and answering are different experiments

The May `gbrain-think` run measured the beliefs cited by an answering model. It recorded about 0.38 precision, 15 active passes, 26/77 total passes, and 4,945 ms median latency. It used the flawed seed and has not been refreshed here.

A citation set mixes retrieval, reasoning, and whether the model chooses to cite something. It is not the same contract as returning search results. The historical `think` path also lacked the source filter used by the search adapter, so scope mistakes could enter during gathering. These observations describe that run, not a claim about every later version of `think`.

The May adaptive limit added no model call of its own; its reported search latency was about 270 ms. The underlying search could still pay for embeddings or reranking. Comparisons with other providers' latency require matching hardware, warm caches, network conditions, and protocol.

## How the harness works

The scorer and fixture are vendored from upstream commit `c9689ca` under MIT. The report builder, belief definitions, and base adapter are copied; the assertion loop follows the upstream tests. Parity tests check verdicts, IDs, and metrics while ignoring timing differences.

Each belief becomes a page. Scope maps to a real gbrain source; universal user beliefs are included with the relevant domain. Alias text goes into the searchable body. All beliefs, including superseded ones, are now indexed live. Gbrain must exclude an old belief using information available in the supplied text or fail the case.

The adapter exposes keyword, hybrid, adaptive, and `think` modes. The adaptive policy runs after reranking, applies to the first page, and has an at-least-one fallback. It is therefore not, by itself, a complete solution for questions that should return nothing. Exact empty-set behavior, supersession, and scope isolation deserve their own checks.

## Reproducing the historical run

These are the original commands. They describe the May setup, including its then-unmerged feature and provider assumptions. For a current comparison, use the [refresh report](2026-09-09-retrieval-refresh.md) and its explicit configuration.

```bash
cd ~/git/gbrain-evals
# Link a local gbrain checkout (the adaptive feature is unmerged as of this run)
( cd /path/to/gbrain && bun install && bun link )
bun link gbrain
export OPENAI_API_KEY=...   # embeddings; ANTHROPIC_API_KEY for think mode

bun eval/runner/precisionmembench.ts --mode gbrain-hybrid                       # baseline (published 0.075 pre-correction; measure the effect)
bun eval/runner/precisionmembench.ts --mode gbrain-adaptive --entity-max 1 --other-max 1   # tight caps (published 0.58 pre-correction)
bun eval/runner/precisionmembench.ts --mode gbrain-adaptive --entity-max 1 --other-max 2   # recall-preserving
bun eval/runner/precisionmembench.ts --mode gbrain-think                        # citation lens
bun eval/runner/precisionmembench.ts --mode gbrain-keyword                      # hermetic, no API key needed
bun eval/runner/precisionmembench-instrument.ts                                 # policy sweep + cliff read
```

Current output names include resolved caps and limits so two configurations do not overwrite each other. Unknown mode or fidelity values fail immediately. A `--limit N` run is partial and cannot stand in for the full benchmark. Corrected seeding can lower a score, but a lower score is not guaranteed when the software and settings also change; the September results demonstrate why we measure instead of predicting.

The durable May artifacts are in [2026-05-29-precisionmembench/](2026-05-29-precisionmembench/). Fresh artifacts are under [2026-09-09-retrieval-refresh/](2026-09-09-retrieval-refresh/). The runner is `eval/runner/precisionmembench.ts`; seeding and the vendored scorer live in `eval/precisionmembench/`. This small benchmark found a real product issue: good recall does not excuse an unnecessarily noisy result set. Gbrain now has a measured way to make that tradeoff explicit.
