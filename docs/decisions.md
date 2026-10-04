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

A `memory-qa` source with `"facts": "conversation"` adds the facts lane: sessions import as `type: conversation`
pages with ISO session dates, and gbrain's conversation-facts extractor (product default model) runs on each
conversation before its questions. Rows then carry `facts_count` and `facts_unresolved_share` (saved facts that
keep a relative time expression such as "yesterday" or "3 days ago" and no absolute date), one value per
conversation. With `"qa": { "mode": "reader", "context": "facts", ... }` the reader answers from the saved facts
(fact text and stored date) of the top `qa.sessions` retrieved sessions instead of the raw sessions, so the QA
score measures what extraction kept. Extraction is paid: about $0.02 per LoCoMo session and $1 per LongMemEval-S
question per arm.

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

## Hub-heavy world (for ranking changes that depend on entity degree)

world-v1 pages have at most about a dozen inbound links, so a change such as hub dampening of entity and backlink
boosts is inert there. `eval/generators/hub-world-gen.ts` writes a world-v1 variant with routine notes whose links
give entities a heavy-tailed inbound degree and four hubs with 5,000, 10,000, 20,000 and 30,000 inbound links, plus
two probe families: hub-as-answer (the gold page is a hub) and bridge (the gold entity is reached through a note that
links a hub). `eval/runner/hub-world.ts` runs those probes and the relational one-hop templates on the shared-index
harness, with `GBRAIN_EVAL_SEARCH_PINS` selecting the feature arm. Cat 13 takes `--corpus-dir` to run its concept
probes on the same world.

```bash
bun eval/generators/hub-world-gen.ts --seed 1 --out ~/datasets/gbrain-evals/hub-world/seed-1        # dev world, about 32,000 pages
bun eval/runner/hub-world.ts --corpus-dir ~/datasets/gbrain-evals/hub-world/seed-1 --output <dir>   # keyword path, keyless
GBRAIN_EVAL_SEARCH_PINS=search.hub_dampening=true bun eval/runner/hub-world.ts --corpus-dir ... --output <dir2>
```

Seed 1 is development data. Seeds 2 and 3 render only from the custodian's private salt
([`eval/decisions/splits/hub-world.json`](../eval/decisions/splits/hub-world.json) records its SHA-256 and the probe
file hashes) and are opened once at a preregistered decision.

## Retrieval feedback and constrained relational questions (plan P3)

Three runners measure use-attributed retrieval feedback and relational triplet scoring:

- `eval/runner/feedback-replay-locomo.ts` and `eval/runner/feedback-replay-world.ts` replay oracle ratings (E1) on
  LoCoMo and on world-v1 relational questions: off, frozen, online, noisy and exposure-frequency arms.
- `eval/runner/feedback-think-replay.ts` measures the implicit citation signal (E2). Every LoCoMo answer goes through
  gbrain's `think` operation with a trusted local context, so the answer is recorded and the pages it cites feed the
  ranking. Arms: off (influence 0), frozen (learn on the train half, score with `feedback.learn=false`), sparse (frozen
  on a seeded 25% of the train half) and online (one seeded stream, each answer scored before its own citations
  apply). Each score answer is judged `--judge-runs` times with P0's LoCoMo prompts; the summary reports the judge
  mean, the SD across replicates, gather Recall@5 and cited events per 100 answers.
- `eval/runner/constrained-relational.ts` (category `constrained-relational`) asks questions that name one seed, one
  relation and one attribute constraint ("Who at <company> works on <topic>?", "What has <investor> invested in
  within <industry>?", "Which <role>s attended <meeting>?"), so a seed has 8 to 14 relational neighbors and 1 to 4 are
  gold. Arm config comes from `GBRAIN_EVAL_SEARCH_PINS` (for E4, `search.triplet_scoring=true`).

```bash
bun eval/runner/feedback-think-replay.ts --gbrain ../gbrain@<sha> --output <dir> --train-limit 25 --score-limit 20 --judge-runs 3 --paid --budget-usd 30
GBRAIN_EVAL_SEARCH_PINS=search.triplet_scoring=true bun eval/runner/constrained-relational.ts --gbrain ../gbrain@<sha> --output <dir> --paid --budget-usd 1
```

Held-out modes belong to the custodian: the feedback runners take `--split sealed --decision-id <id> --purpose <text>`
with `GBRAIN_EVALS_CUSTODY_LOG` set, and `constrained-relational` takes `--phrasing-file <custody path>` with held-out
seeds; every opening is written to the access log before any held-out text is read. Development seeds are 11 and 13.
