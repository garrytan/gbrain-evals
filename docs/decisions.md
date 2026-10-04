# Evaluate a gbrain change on held-out evidence: the decision kit

`bun run eval:decide` compares a candidate gbrain build against a baseline build on the same evidence and returns
a paired, clustered verdict. It answers one question for a feature change: did this build measurably improve what
it set out to improve, without making anything else worse?

A verdict has two stages:

- **Dev verdicts** run on development data that anyone may inspect and tune against. They guide the work. They never
  turn a feature on by default.
- **Held-out verdicts** run on data nobody tuned against, opened once by a custodian after the comparison is
  preregistered. Only a held-out win turns a feature on by default.

This page covers the dev stage, which is available now. The held-out commands (`power`, `prereg`, `request`,
`seal-run`, `revalidate`) arrive in later milestones and refuse with a clear message until then.

## Your first dev verdict

From a gbrain-evals checkout with dependencies installed (`bun install`), and a gbrain checkout with your feature
committed (uncommitted edits are never measured):

```bash
bun run eval:decide init --plan P6 --gbrain ../gbrain@<candidate-sha>     # baseline defaults to ../gbrain@origin/master, pinned to its SHA
bun run eval:decide fetch --decision eval/reports/decisions/p6-dev-<date>
bun run eval:decide preflight --decision eval/reports/decisions/p6-dev-<date>
bun run eval:decide dev --decision eval/reports/decisions/p6-dev-<date> --paid --budget-usd 30
bun run eval:decide verdict --decision eval/reports/decisions/p6-dev-<date>
```

`init` prints the exact commands for your decision, including the budget its sources need. To check the plumbing
without keys or spending, run the keyless fixture:

```bash
bun run eval:decide init --fixture --id my-fixture
bun run eval:decide dev --decision eval/reports/decisions/my-fixture
bun run eval:decide verdict --decision eval/reports/decisions/my-fixture
```

Fixture scores prove the plumbing works. They say nothing about retrieval quality.

## What a decision spec contains

`init` writes `decision.json` from the plan's template. Edit it before running:

- `candidate.config` and `baseline.config`: gbrain config keys set on the engine before import (for example a
  feature flag). They apply to `memory-qa` sources. Category sources run each build as it is.
- `sources`: the evidence. Each source has a `comparisons` list in the same format as
  [`eval/runner/stats/gates.ts`](../eval/runner/stats/gates.ts):
  - `superiority` (a claimed improvement larger than `min_effect`),
  - `noninferiority` (a guardrail that may not drop by more than `tolerance`),
  - `exact` (a safety or correctness assertion),
  - `exploratory` (reported, never decisive).
  Holm correction covers every superiority and non-inferiority comparison in a source. `cluster_by` names the unit
  that is independent (a conversation, a question family); items inside one cluster are not counted as independent
  evidence.
- `verdict_type`: `quality` (the feature should improve a metric), `cost` (same quality, lower cost) or
  `correctness` (a failure class disappears).

### Source kinds

| Kind | What runs | Rows |
|---|---|---|
| `memory-qa` | [`eval/runner/memory-qa/run.ts`](../eval/runner/memory-qa/run.ts): each conversation's sessions are imported as pages into a fresh in-memory gbrain; each question goes through hybrid search; retrieved chunks reduce to distinct sessions | one per question: `recall_all_at_5`, `recall_any_at_5`, `recall_all_at_10`, `ndcg_at_10`, `latency_ms` |
| `category` | an existing registry runner with `--gbrain` and `--output` | per-item rows from the runner's receipt (`rows_path`), and/or receipt contracts |

Benchmarks for `memory-qa` dev runs, with what each split allows:

| Benchmark | Dev split | Held-out portion |
|---|---|---|
| `lme-s` (LongMemEval-S cleaned) | all 500 questions | none: the release configuration was chosen on these questions |
| `locomo` (LoCoMo, 10 conversations) | 3 conversations | 7 conversations, diagnostic only (fewer than 10 clusters) |
| `beam-100k`, `beam-1m` (BEAM) | 6 of 20 and 11 of 35 conversations | the rest, supporting evidence |
| `fixture` | invented, keyless | none |

Splits are by whole conversation, fixed from conversation ids alone before any system ran on the data
([`eval/decisions/splits/`](../eval/decisions/splits/), recomputed by `bun scripts/make-decision-splits.ts --check`).
Dataset files are downloaded by pinned revision and checked against SHA-256; no dataset text is committed.

## Reading a verdict

```
dev verdict for p2-smoke: PASS (development data; not eligible to set a default)
  locomo-dev: pass
    recall-all-5 [noninferiority] pass: A 0.7565 → B 0.7565 (Δ 0.0000, 95% CI [0.0000, 0.0000], n 464, clusters 3)
```

`A` is the baseline mean, `B` the candidate mean, `Δ` their paired difference with a cluster-bootstrap interval.
`inconclusive` means the data cannot show the claim either way. It is not evidence of a loss. `invalid` means the run
measured a different pipeline than the one named: a page was saved without vectors, or a pinned reranker never
scored a result. An invalid run is an environment problem to fix and rerun, never a product result.

The verdict file (`runs/verdict.json`) records both builds' identities, every comparison, and
`eligible_for_default: false`.

## Errors

Every refusal names what happened, why, the exact next command and a read-only check:

```
[PAID_FLAGS_MISSING] lme-s-dev spend money (estimate $24)
  why: paid sources run only under an explicit budget recorded in the ledger
  next: run `bun run eval:decide dev --decision <dir> --paid --budget-usd 24`
```

Codes: `SPEC_INVALID`, `SPEC_MISSING`, `DATASET_MISSING`, `DATASET_HASH_MISMATCH`, `PAID_FLAGS_MISSING`,
`BUDGET_CAP`, `OVERLAY_FAILED`, `ARM_FAILED`, `ROWS_MISSING`, `SEALED_SOURCE_IN_DEV`, `NOT_YET_AVAILABLE`, and for
the held-out stage `CUSTODY_MISSING`, `PREREG_UNCOMMITTED`, `UNDERPOWERED`, `SOURCE_EXHAUSTED`. With `--json` the
message is printed as an object. Exit code 3 means stop and ask the user; 2 means run the named fix; 4 means the
verdict is invalid.

## From dev to held-out

1. Freeze the candidate build (a commit SHA) and keep `decision.json` and the dev `verdict.json`.
2. Commit both under `docs/eval/decisions/<decision-id>/` in your gbrain pull request. That copy is authoritative.
3. Report to the custodian. The custodian freezes the preregistration, opens the held-out sources once, and writes
   the held-out verdict that decides the default. Sealed data never reaches the feature's implementer.

## Spend

Real-embedding sources go through the budget ledger ([`eval/runner/budget-ledger.ts`](../eval/runner/budget-ledger.ts)):
every request is reserved before it is sent, and a run stops at its cap. Embeddings are cached by content, so text
both builds index identically is embedded once. Measured: LoCoMo dev for both arms cost about $0.02 with
`openai:text-embedding-3-large` at 1536 dimensions.
