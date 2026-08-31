# The eval-suite audit — 2026-08-31

Every part of this repo's eval suite was audited for bugs, then remediated.
This page is the deliverable: what was found, what was fixed, what was
deferred, and what the numbers mean now. The machine-readable findings with
per-finding evidence, line numbers, and adversarial-verification verdicts
live next to this file in [`2026-08-31-findings.json`](2026-08-31-findings.json).

## How the audit ran

A 35-agent workflow: 17 subsystem auditors (one per area — shared scoring
infra, every cat runner family, LongMemEval, PrecisionMemBench, generators,
adapters, shell scripts, committed data, the test suite itself, and the
published docs), each finding then adversarially re-verified by an
independent agent instructed to refute it against the actual code and the
pinned gbrain v0.47.6.0 source, plus a completeness critic that swept for
coverage gaps. Two outside-model (Codex) review rounds hardened the
remediation plan.

**Result: 237 confirmed findings, 2 refuted (239 total):**

| Class | Count |
|---|---|
| Critical bugs (scores wrong / eval measures nothing / crashes) | 17 |
| Major bugs (misleading metrics, silent skips, integrity leaks) | 95 |
| Minor bugs | 81 |
| Improvements (eval-design upgrades) | 44 |
| Refuted in verification | 2 |

## The headline problems, in plain terms

1. **The flagship LongMemEval number used the wrong metric.** Our runner
   scored a question as recalled if ANY of its ground-truth sessions was in
   the top-5; the official benchmark requires ALL of them. The published
   97.60% head-to-head against systems reporting the official metric was
   not apples-to-apples. An erratum is published in the report; the runner
   now computes `recall_all@5`; re-measurement is tracked in TODOS.md.
2. **The shared metric helpers were wrong for everyone.** Recall could
   exceed 1.0 (duplicate chunk rows double-counted), precision divided by
   the returned-list length instead of k (rewarding adapters that return
   less), and the LLM judge silently renormalized over whichever rubric
   criteria it happened to return.
3. **Four runners crashed outright** against the pinned gbrain, having
   drifted from its API while the dependency floated on `#master` — and
   roughly a dozen evals structurally could not fail: fixtures that did not
   exist counted as pass, A/B knobs set under config keys nothing read,
   corpora smaller than K, gates that printed but never affected exit codes.
4. **Confounded comparisons.** gbrain's default search mode silently enables
   a reranker when an unrelated env var is set, so "embedder-only" A/B cells
   were quietly reranked; the shootout shell script's env-prefix expansion
   bug killed 4 of 7 cells with exit 127 while printing "done".

## What changed (BrainBench v0.3.0 — scores not comparable to v0.2.x)

- **Contracts:** every runner writes a validated receipt
  (`run_status` / `verdict` / typed `failure_origin`); the umbrella runner
  aggregates receipts, not exit codes; skipped never counts as pass. One
  scoring policy: system-under-test failures score as misses, harness
  errors are excluded but capped (>10% invalidates the run).
- **One metrics module** (`eval/runner/metrics.ts`) with the standard
  denominators, replacing seven divergent local implementations; the
  official `recall_all@k`; judge rubric-coverage enforcement at temperature 0.
- **Every previously-unfailable eval got a reachable fail state**, a
  feature-boundary header (what is under test vs legitimately stubbed), and
  a negative control (a deliberately degraded configuration must score
  ≤ 0.5x the real one).
- **Data integrity is now a gate** (`eval/runner/validate-data.ts`, run in
  CI): the audit's manual cross-checks — dangling wikilinks, manifest
  overcounts, unreachable qrels labels — are permanent checks. The
  synthetic corpus was regenerated (every person→company link had been
  dangling); one qrels label was corrected by documented adjudication.
- **Hermetic CI on every PR**: typecheck, the unit suite, data validation,
  a keyword-only retrieval-regression gate, and five real end-to-end
  runners — all keyless, all receipt-checked.

## Finding status

Every confirmed finding ends in exactly one state — `fixed`,
`deferred` (with a TODOS.md entry), or `rejected` (with a reason recorded in
the findings JSON). No finding silently disappears. The per-finding status
table is generated from the findings JSON:

<!-- STATUS_TABLE -->

## What is still open

The keyed re-runs (P1 in [TODOS.md](../../TODOS.md)): the corrected
LongMemEval `recall_all@5` number, the post-fix cat13/cat18 matrices, and
the API-dependent negative controls. This environment had no OpenAI key, so
those re-measurements carry exact commands and cost estimates instead of
numbers. Published pages affected by the metric correction carry errata
rather than silently updated figures.
