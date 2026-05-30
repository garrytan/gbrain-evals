# BrainBench: PrecisionMemBench (external benchmark)

## 1. Headline

[PrecisionMemBench](https://github.com/tenurehq/precisionmembench) (tenurehq /
Jeffrey Flynt) is the first memory benchmark that isolates *retrieval
precision* from answer quality. We ran gbrain against it faithfully (Tenure's
own MIT scorer, vendored verbatim) and measured the honest result.

| System | Precision | Active passes | Pass | p50 |
|---|---|---|---|---|
| tenure (author) | 1.00 | 43 | 77/77 | 9.8ms |
| **gbrain — adaptive (tight)** | **0.582** | **29** | **44/77** | ~270ms |
| supermemory | 0.43 | 17 | 44/77 | 819ms |
| gbrain — adaptive (recall-preserving) | 0.40 | 12 | 21/77 | ~270ms |
| gbrain — think (cited set) | 0.38 | 15 | 26/77 | 4945ms |
| **gbrain — default hybrid** | **0.076** | **0** | **7/77** | ~270ms |
| yourmemory | 0.17 | 0 | 21/77 | 313ms |
| agentmemory | 0.17 | 0 | 7/77 | 82ms |
| atomicmemory | 0.15 | 0 | 9/77 | 71ms |
| zep | 0.09 | 0 | 9/77 | 124ms |
| vector baseline | 0.088 | 0 | 9/77 | — |
| mem0 | 0.056 | 0 | 9/77 | 65ms |

Two honest facts. First, **gbrain's default retrieval scores 0.076** — right in
the mem0/zep/vector cluster. Top-K hybrid returns ~20 results, recall is 0.99,
and precision collapses. That is the benchmark working as designed: it punishes
returning a pile and letting a downstream model sort it out. Second, with an
**opt-in retrieval feature we built off the back of this benchmark** — intent-
aware return-sizing — gbrain reaches **0.582 precision and 29 active passes,
clear of supermemory on both axes.** That is a solid #2, at a third of
supermemory's latency.

We did not chase tenure's 1.00. See §9 for why that number is less impressive
than it looks.

## 2. What is gbrain

gbrain is a personal knowledge brain: an embedded Postgres (PGLite) store with
hybrid retrieval (vector + keyword + RRF), a typed knowledge graph, fact
extraction, and a `think` pipeline that gathers broadly and answers with
citations. It is a general-purpose brain, not a narrow belief store.

## 3. What is PrecisionMemBench

A 35-belief seed corpus, 77 single-query cases (+ 12 session cases, not run
here). Each belief has a `canonical_name`, `aliases`, `content`, a `scope`
(`domain:code` / `domain:writing` / `user:universal`), and supersession
pointers. The harness builds a context per query and scores the **belief IDs**
the provider's `/search` returns:

- `precision = (expected returned) / (total returned)`
- The `shouldOnlyInclude` assertion demands an *exact* set; some cases expect
  *empty*.

It is explicitly embedding-invariant: cosine similarity scores ~0.09 precision
whether you use a 768-d encoder or an 8B-param model. What it rewards is **hard
scope isolation + alias resolution + supersession exclusion + calibrated
return-set sizing.** Only the returned IDs matter; result text is ignored.

## 4. Modes tested

All gbrain modes feed beliefs the way real content arrives (one page per belief,
`scope` → a real gbrain source, superseded beliefs → real soft-delete) and
override only the harness's `searchText`. No benchmark-specific logic.

- **`gbrain-hybrid`** — gbrain's real default retrieval (vector + keyword + RRF),
  top-K. The honest baseline.
- **`gbrain-adaptive`** — `gbrain-hybrid` + the new **intent-aware adaptive
  return-sizing** feature (`adaptiveReturn`). Tight caps (return ~1) maximize
  precision; recall-preserving caps keep more answers. Default-OFF in gbrain.
- **`gbrain-think`** — return the beliefs gbrain's `think` pipeline actually
  *cited* (gather broad, cite narrow). A distinct lens, not the `/search`
  contract (see §9).
- **`gbrain-keyword`** — pure FTS, no embeddings (no-API-key fallback).

## 5. Results — what the feature does

The adaptive gate is a smooth precision/recall dial on the same retrieval:

| Setting | Precision | Recall | Active | Pass |
|---|---|---|---|---|
| off (default top-K) | 0.076 | 0.99 | 0 | 7/77 |
| caps entity=2 / other=6 (shipped default) | 0.15 | 0.93 | 0 | — |
| caps entity=1 / other=2 (recall-preserving) | 0.40 | 0.91 | 12 | 21/77 |
| caps entity=1 / other=1 (max precision) | 0.58 | 0.82 | 29 | 44/77 |

The benchmark rewards the aggressive end; a real user wants somewhere in the
middle (returning *only* one result is wrong for "who works on infra"). That is
why the feature ships **default-off and opt-in** with tunable caps, rather than
flipping gbrain's default to aggressive.

## 6. Per-category (gbrain-adaptive tight)

Alias resolution (23 cases) and scope disambiguation (12) are where the win
concentrates — alias queries resolve via gbrain's real FTS over the alias text,
scope via real multi-source isolation, supersession via real soft-delete.

## 7. Why we did not build a "score cliff" detector

We instrumented before building. The plan's first idea was an adaptive *cliff
detector* — cut the result set where the scores drop off. The data killed it:
across single-answer cases the right belief is rank-1 **94%** of the time, but
the rank1→rank2 score gap is **0.602 when rank-1 is correct vs 0.569 when it is
wrong**. The gap is RRF's mechanical decay; it carries no signal about whether
the top result is trustworthy. So "return a tight set" is the entire win, and a
cliff detector just adds noise. Instrumenting first kept a useless mechanism out
of gbrain core.

## 8. Latency + cost

gbrain-adaptive runs at ~270ms p50 (a third of supermemory's 819ms) with zero
extra LLM cost — the gate is a sort + slice. `gbrain-think` trades 18× the
latency (4.9s, one LLM call per query) for *less* precision than the cheap gate.
tenure's 9.8ms reflects a purpose-built BM25 belief store.

## 9. Limits & caveats (read this before quoting numbers)

- **Structural categories are harness-computed, not gbrain.** The harness builds
  pinned facts, open questions, and relation expansion from the fixture itself —
  identical for every provider. gbrain's real contribution is only the
  `searchText` categories (alias, scope, fuzzy, supersession, ranking). We do
  not claim credit for the structural passes.
- **`gbrain-think` is a citation lens, not the `/search` contract.** It measures
  what the model cited, mixing retrieval with prompt-following and model
  nondeterminism. Reported separately, never as an apples-to-apples provider
  number.
- **`think` cannot scope-isolate today.** gbrain's `runThink` has no source
  filter, so its gather runs unscoped; scope-disambiguation cases can be cited
  wrong. Plumbing filed as follow-up.
- **The adaptive feature is default-off.** Flipping any gbrain mode default is
  gated on a cross-surface ablation (does the gate hurt recall on LongMemEval /
  whoknows / contradictions?) that is deliberately *not* done here. The
  precision/recall frontier in §5 is the on-surface evidence; the cross-surface
  answer-quality gate is future work.
- **tenure's 1.00 is overfit.** It is a BM25 belief store tuned to a 35-item
  lexical corpus, scored on a single `/search` call. That call cannot see
  gbrain's retrieve→synthesize architecture, and the benchmark measures none of
  what a personal brain is actually for: breadth, multi-session reasoning,
  long-context recall, synthesis, calibration. gbrain's results on those live in
  the LongMemEval and BrainBench reports in this repo. PrecisionMemBench surfaces
  a real gap — precision isolation is a genuine contribution, and it is why we
  built the adaptive feature — but a 1.00 on a 35-belief lexical set is a
  narrow win, not a general one.

## 10. Reproduction

```bash
cd ~/git/gbrain-evals
# Link a local gbrain checkout (the adaptive feature is unmerged as of this run)
( cd /path/to/gbrain && bun install && bun link )
bun link gbrain
export OPENAI_API_KEY=...   # embeddings; ANTHROPIC_API_KEY for think mode

bun eval/runner/precisionmembench.ts --mode gbrain-hybrid                       # baseline 0.076
bun eval/runner/precisionmembench.ts --mode gbrain-adaptive --entity-max 1 --other-max 1   # 0.58
bun eval/runner/precisionmembench.ts --mode gbrain-adaptive --entity-max 1 --other-max 2   # recall-preserving
bun eval/runner/precisionmembench.ts --mode gbrain-think                        # citation lens
bun eval/runner/precisionmembench-instrument.ts                                 # policy sweep + cliff read
```

Reports land in `eval/reports/precisionmembench/`.

## 11. Methodology

- **Faithful scorer.** Tenure's `buildRetrievalReport.ts` + `belief.ts` +
  `baseAdapter.ts` are vendored byte-for-byte (MIT, pinned `c9689ca`); the
  per-case assertion loop is lifted verbatim out of their ava test into
  `runCases.ts`. Invariant: semantic parity (identical verdicts / IDs / metrics,
  timings normalized out), pinned by `test/eval/precisionmembench-scorer.test.ts`.
- **Honest seeding.** scope → gbrain `source_id` (real multi-source isolation,
  `user:universal` federated into each domain query); superseded beliefs →
  `engine.softDeletePage` (real soft-delete); aliases in page body (real FTS).
- **The feature.** `adaptiveReturn` in `gbrain/src/core/search/return-policy.ts`
  + `hybrid.ts`: intent-aware return-sizing, after rerank, before slice,
  first-page only, at-least-1 failsafe, default-off, 19 unit tests.

## 12. Files

- `eval/precisionmembench/` — vendored fixtures + scorer, gbrain adapters, seed,
  scope mapping, gate prototype, attribution.
- `eval/runner/precisionmembench.ts` — the 4-mode runner.
- `eval/runner/precisionmembench-instrument.ts` — the policy sweep + cliff read.
- `docs/benchmarks/2026-05-29-precisionmembench/` — committed per-run JSON
  reports (the durable copies; `eval/reports/` itself is gitignored transient
  output).
- gbrain core: `src/core/search/return-policy.ts`, `hybrid.ts`,
  `test/search/return-policy.test.ts`.
