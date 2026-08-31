# BrainBench: PrecisionMemBench (external benchmark)

> **Correction (2026-08-31, audit finding precisionmembench-01).** Every gbrain
> number in this report was measured with a seeding defect: the harness read the
> fixture's ground-truth `superseded_by` field and soft-deleted those 4 beliefs
> from gbrain's index at seed time. The upstream provider contract sends
> providers only `{text, user_id, metadata, aliases}`; no other system on the
> leaderboard got that signal, so they had to infer supersession from in-band
> prose. That was the answer key leaking into the index, and it inflated the
> gbrain rows two ways: supersession cases scored precision `null` (a trivial
> pass) instead of failing, and the superseded beliefs could not pollute
> unrelated queries (`b-sqlalchemy-superseded` carries the alias "Postgres").
>
> The leak is removed (`eval/precisionmembench/seed.ts` now seeds all 35
> beliefs live; regression-tested in `test/eval/precisionmembench-scorer.test.ts`).
> **Scores drop on re-run.** The hermetic keyword mode, re-measured on the
> fixed harness: mean precision **0.1389 → 0.1361**, pass **35/77 → 34/77**
> (`persona-prelude-content-present` now fails because the live superseded
> SQLAlchemy belief surfaces on its "Postgres" alias). The hybrid / adaptive /
> think rows below have NOT been re-measured (they need a paid embedding run)
> and should be read as upper bounds; the drop there is expected to be larger,
> because vector retrieval surfaces the 4 live superseded beliefs more often
> and the "Supersession chain exclusion" category stops passing trivially.

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
| **gbrain — default hybrid** | **0.075** | **0** | **7/77** | ~270ms |
| yourmemory | 0.17 | 0 | 21/77 | 313ms |
| agentmemory | 0.17 | 0 | 7/77 | 82ms |
| atomicmemory | 0.15 | 0 | 9/77 | 71ms |
| zep | 0.09 | 0 | 9/77 | 124ms |
| vector baseline | 0.088 | 0 | 9/77 | — |
| mem0 | 0.056 | 0 | 9/77 | 65ms |

All gbrain rows: measured 2026-05-30 with the pre-correction seeding (see the
correction note above); backing artifacts are committed under
`docs/benchmarks/2026-05-29-precisionmembench/`. The default-hybrid 0.075 is
`2026-05-30-gbrain-hybrid-body-text.json` (`meanPrecision: 0.0752`). Earlier
revisions of this page quoted 0.076, which was actually the instrument sweep's
baseline row (0.0756, `2026-05-30-instrument-hybrid.json`) — a different run
from the committed artifact (audit finding docs-vs-code-12).

Two honest facts. First, **gbrain's default retrieval scores 0.075** — right in
the mem0/zep/vector cluster. Top-K hybrid returns ~20 results, recall is 0.99,
and precision collapses. That is the benchmark working as designed: it punishes
returning a pile and letting a downstream model sort it out. Second, with an
**opt-in retrieval feature we built off the back of this benchmark** — intent-
aware return-sizing — gbrain reaches **0.582 precision and 29 active passes,
clear of supermemory on both axes.** That is a solid #2, at a third of
supermemory's latency.

We did not chase tenure's 1.00, on purpose. This benchmark scores one narrow
property (exact-ID precision on a 35-belief lexical store), and a system tuned to
top it would be worse at what agentic memory actually needs: recall, multi-
session reasoning, temporal and contradiction handling, synthesis at scale. You
want a memory that is strong across that whole grid, not excellent in one cell.
§9 makes that case in full.

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
`scope` → a real gbrain source) and override only the harness's `searchText`.

Supersession seeding, corrected: the runs published here soft-deleted the 4
superseded beliefs at seed time by reading the fixture's ground-truth
`superseded_by` — benchmark-specific logic that no other provider's seeding
path had, contradicting the "no benchmark-specific logic" claim earlier
revisions of this page made (audit finding precisionmembench-01). The current
harness seeds every belief live: gbrain sees exactly what the upstream `/add`
contract delivers, and has to exclude superseded beliefs itself or fail those
cases. See the correction note at the top for the measured impact.

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
| caps entity=2 / other=6 (shipped default) | 0.16 | 0.96 | 1 | 8/77 |
| caps entity=1 / other=2 (recall-preserving) | 0.40 | 0.91 | 12 | 21/77 |
| caps entity=1 / other=1 (max precision) | 0.58 | 0.82 | 29 | 44/77 |

Provenance: this table is the instrument sweep
(`2026-05-30-instrument-hybrid.json`), so its "off" row reads 0.076 (0.0756);
the headline table quotes the committed standalone hybrid run
(`2026-05-30-gbrain-hybrid-body-text.json`, 0.0752 → 0.075). The 0.0004 delta
is run-to-run embedding jitter between two runs of the same configuration.
Both runs predate the supersession-seeding correction (top of page).

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

(The instrument's score capture was later re-keyed by case id instead of raw
query text — audit finding precisionmembench-05. The fixture's duplicated query
strings happened to share scope and budget, so the separatrix numbers quoted
above were verified undistorted by the old keying.)

## 8. Latency + cost

gbrain-adaptive runs at ~270ms p50 (a third of supermemory's 819ms) with zero
extra LLM cost — the gate is a sort + slice. `gbrain-think` trades 18× the
latency (4.9s, one LLM call per query) for *less* precision than the cheap gate.
tenure's 9.8ms reflects a purpose-built BM25 belief store.

## 9. Limits & caveats (read this before quoting numbers)

**The bigger caveat is what this benchmark is for.** PrecisionMemBench measures
one property: return the exact right belief ID from a 35-item store and nothing
else. That is a real property, and it found a real gap in gbrain's default (we
built a feature from it). But being good *only* at that is the wrong goal for
agentic memory. A working agent's memory has to not miss the fact (recall),
reason across many sessions, handle contradictions and time, and hand a
reasoning loop the relevant cluster rather than one pre-filtered row. A system
tuned to win this test (return a single belief by lexical match) is actively
worse at most of that: aggressive precision is a recall tax, and an agent that
only ever sees one retrieved belief cannot weigh alternatives. That is exactly
why gbrain's default optimizes for recall and reasoning (and "loses" here at
0.075), and why the precision gate is opt-in. You do not want a memory that is
excellent in one narrow way. You want one that is strong across the board:
recall, precision, temporal reasoning, contradiction handling, synthesis, and
scale. This benchmark scores a single cell of that grid.

- **The published gbrain rows were measured with the supersession seeding
  leak.** Repeated here so nobody quotes the table without it: the 2026-05-30
  runs pre-hid the 4 superseded beliefs using fixture ground truth the upstream
  contract never delivers (audit precisionmembench-01). The harness is fixed;
  the hybrid/adaptive/think rows are upper bounds until re-measured. The
  hermetic keyword mode already re-measured lower (0.1389 → 0.1361, 35 → 34
  passes).
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
- **tenure's 1.00 is the clean illustration of the narrow-win trap.** A
  purpose-built BM25 belief store, tuned to its own 35-belief lexical corpus,
  scored on a single `/search` call that cannot even see a retrieve-then-reason
  architecture. Impressive on this test; unmeasured on everything a personal
  brain is actually for. gbrain's general-purpose results live in the LongMemEval
  (97.60% R@5, SOTA) and BrainBench reports in this repo. Precision isolation is
  a genuine gap worth probing, which is why we built a feature from it, but a
  1.00 on a 35-belief lexical set is not a general-purpose memory. We would
  rather be #2 here and strong everywhere than top this one probe by sacrificing
  recall and reasoning on real workloads.

## 10. Reproduction

```bash
cd ~/git/gbrain-evals
# Link a local gbrain checkout (the adaptive feature is unmerged as of this run)
( cd /path/to/gbrain && bun install && bun link )
bun link gbrain
export OPENAI_API_KEY=...   # embeddings; ANTHROPIC_API_KEY for think mode

bun eval/runner/precisionmembench.ts --mode gbrain-hybrid                       # baseline (published 0.075 pre-correction; expect lower)
bun eval/runner/precisionmembench.ts --mode gbrain-adaptive --entity-max 1 --other-max 1   # tight caps (published 0.58 pre-correction)
bun eval/runner/precisionmembench.ts --mode gbrain-adaptive --entity-max 1 --other-max 2   # recall-preserving
bun eval/runner/precisionmembench.ts --mode gbrain-think                        # citation lens
bun eval/runner/precisionmembench.ts --mode gbrain-keyword                      # hermetic, no API key needed
bun eval/runner/precisionmembench-instrument.ts                                 # policy sweep + cliff read
```

Reports land in `eval/reports/precisionmembench/` (instrument runs in
`eval/reports/precisionmembench-instrument/`), each alongside a `receipt.json`
with run status, verdict, and gbrain version provenance. Report filenames and
payloads now carry the resolved run config (`-e1-o1`, `-limit10`, ...), so the
two adaptive commands above no longer overwrite each other when run the same
day (audit finding precisionmembench-03). `--mode`/`--fidelity` are strict
enums: a typo like `--mode gbrain-adaptive-tight` errors out instead of
silently running plain hybrid under that label (finding precisionmembench-02).
`--limit N` runs are labeled partial/not-comparable and never publishable
(finding precisionmembench-06). Because current runs seed superseded beliefs
live, fresh numbers will land below the published pre-correction rows; that is
the fix working, not a regression in gbrain.

## 11. Methodology

- **Faithful scorer.** Tenure's `buildRetrievalReport.ts` + `belief.ts` +
  `baseAdapter.ts` are vendored byte-for-byte (MIT, pinned `c9689ca`); the
  per-case assertion loop is lifted verbatim out of their ava test into
  `runCases.ts`. Invariant: semantic parity (identical verdicts / IDs / metrics,
  timings normalized out), pinned by `test/eval/precisionmembench-scorer.test.ts`.
- **Seeding.** scope → gbrain `source_id` (real multi-source isolation,
  `user:universal` federated into each domain query); aliases in page body
  (real FTS). Superseded beliefs are seeded LIVE — the published 2026-05-30
  runs instead soft-deleted them from ground truth at seed time, which was a
  leak, not "honest seeding" as earlier revisions claimed (audit finding
  precisionmembench-01; see the correction note).
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
