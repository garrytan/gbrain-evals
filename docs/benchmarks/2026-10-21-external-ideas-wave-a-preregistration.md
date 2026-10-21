# External ideas wave A preregistration: absolute dates beside relative time phrases (search.evidence_resolve_dates)

Written 2026-10-21, before any counted cell runs, for GBRA-162 wave A. Runners attest this file against `origin` before their first paid answer or audit request (`eval/runner/prereg.ts`) and write the attestation into every run manifest. The study manifest beside it, [`2026-10-21-external-ideas-wave-a/study-manifest.json`](2026-10-21-external-ideas-wave-a/study-manifest.json), holds every pinned value below in machine-readable form; the runner refuses a frozen set, dataset, prompt or gbrain build that disagrees with it.

## Question

When gbrain delivers conversation turns as evidence, does adding an absolute date bracket after each relative time phrase ("two weeks ago [≈2023-05-06]", gbrain config `search.evidence_resolve_dates`) change answer accuracy, with retrieval frozen so that only the delivered text differs? The answer decides whether gbrain should turn the flag on by default.

## Evidence class

Two suites, reported side by side and never pooled.

- **LongMemEval-S (500 questions): development evidence.** gbrain's retrieval configuration was tuned on these questions, and the feature was built with temporal-reasoning questions in mind. A pass here is not held-out confirmation.
- **Synthetic relative-date suite (60 questions): an independent check built for this study.** It was generated before any reader saw it, from a seeded program that is committed with this file, and it is not tuned after this commit. A change to it is a new file (`synthetic-dates-v2`) and a dated amendment.

## Build and data

- gbrain under test: `cfa1a006b64c5baa199142bf0f0b56a0e3fc6c06` (branch `capy/gbra162-wave-a-dates`, v0.60.347.0). Every frozen delivery for both arms is produced at this commit through the product path (`assembleEvidenceForHits`), from a clean checkout (`GBRAIN_DIR`). The feature's code is pinned by SHA-256 at that commit, and the runner refuses any other bytes:
  - `src/core/search/evidence-relative-dates.ts` `0433f353d4bed086d67e3bcf4b752e06ca57890dab9ee92d436e6c9e8f5b7182`
  - `src/core/search/speaker-line.ts` `d636f8175c6bfe9ffd213557a0988f8e3bdca79a84dc5afa0d359e6554d64ebe`
  - `src/core/temporal-grammar.ts` `534a5b487a0c2de47d170d61c8681163e6e093f105b7befcd63971ad89a77af2`
- `brain.timezone` is unset on the benchmark brain, so observation days are UTC calendar days; the run manifest records the value.
- gbrain-evals: the commit that adds this file. Runner `eval/runner/external-ideas-wave-a.ts` with `eval/runner/external-ideas-wave-a/`.
- LongMemEval cleaned `_s` split, `longmemeval_s_cleaned.json`, SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442` (not committed; the same file as every LongMemEval arm since September).
- Synthetic suite: [`eval/data/external-ideas/synthetic-dates-v1.json`](../../eval/data/external-ideas/synthetic-dates-v1.json), SHA-256 `4700d68d3e96a772c0bb45dabbeef7cd39a218db090bf0127792760fdf77599a`, 60 questions from `eval/runner/external-ideas-wave-a/synthetic-dates.ts` with seed `20261021`. Four kinds of 15: days between two events (`between`), the date of one event (`date`), days from an event to the question date (`ago`), and which of two events came first when the later-mentioned one happened earlier (`order`). Each question has 6 to 10 sessions on distinct days among distractor chatter, and each gold event is stated only as a single-day relative phrase ("yesterday", "three days ago", "last Friday") resolved against its session date; 22 of 60 span a year boundary. A unit test regenerates the file byte for byte and checks every gold answer against an independent resolver. Retrieval delivers every session of these short histories (the smoke freeze delivered every gold session for 60 of 60 questions), so this suite tests date resolution, not retrieval.
- Retrieval: gbrain's release settings in `balanced` mode, run once per question into a frozen set (`freeze`); both arms read the same hits under the same token budgets. The frozen set's manifest hash is recorded in every answer row.
- Seeds: `20261021` for the sign-flip test, the bootstrap and the audit sample.

## Arms

| Arm | Role | Delivery |
|---|---|---|
| `auto` | comparator | product delivery, unit `auto`, per-page blocks, flag unset |
| `auto_dates` | candidate | the same, with `search.evidence_resolve_dates = true` set on the engine only while that arm assembles, then restored |

A question is **affected** when the reader requests of the two arms differ byte for byte (`affected`). An unaffected question sends the identical request in both arms, so the analysis reuses the comparator's rows for it instead of asking twice. The affected report also counts total `relative_dates.insertions`, questions with an insertion, and the `relative_dates_over_budget` and `relative_dates_unavailable` fallbacks.

Reader: gbrain's LongMemEval notes reader prompt (`READER_NOTES_SYSTEM_TEXT`, `gbrain-lme-reader-v4-notes-fullsessions`, system SHA-256 `3db7ccbb12b2bda893755f560fdfe0d8d733253d38645d6d8124cb3ffb0887d0`), 60,000-character session bound, opaque session ids. Every reader request goes through the batch lane (`eval/runner/batch/`): Anthropic Message Batches or OpenAI Batch, at 50% of list price once the first 10-request pilot confirms the discount. Each question gets **2 samples per arm** at the provider's default temperature.

| Model | Role in this study | Effort | Output limit |
|---|---|---|---|
| `claude-sonnet-5-5` | decision model | `output_config.effort: "low"`, adaptive thinking | 3,500 |
| `gpt-6.1-sol` | secondary, report-only | `reasoning_effort: "medium"` | 12,000 |
| `claude-opus-5-5` | secondary, report-only | `low`, adaptive thinking | 3,500 |

Judges, on every answered row:

- **`official_correct` (primary):** `gpt-4o-2024-08-06`, LongMemEval's `evaluate_qa.py` anscheck prompt verbatim, temperature 0, 10 tokens; correct when the lowercased reply contains "yes".
- **`framed_correct` (report-only):** gbrain's `judgeRow` (`longmemeval-anscheck-v1+gbrain-boundary-v1`) on `gpt-4o`. Agreement between the judges is reported; the primary judge alone decides.

Run order: LongMemEval freeze and affected report; Sonnet 5.5 `auto` on all 500 for samples 1 and 2; Sonnet 5.5 `auto_dates` on the affected questions for samples 1 and 2; the synthetic freeze and the same four Sonnet 5.5 cells on it; the bracket audit; then the secondary models, `gpt-6.1-sol` before `claude-opus-5-5`, both arms on the affected questions only (net gain needs nothing else), each only if its preflight worst case fits the remaining lane cap.

## Metric and denominator

- **Unit:** the question. Its score in an arm is the mean of its two samples' primary verdicts (0, 0.5 or 1).
- **Primary metric:** net gain = sum over all questions of (`auto_dates` score − `auto` score), in questions; unaffected questions contribute exactly 0. Denominator 500 for LongMemEval and 60 for the synthetic suite.
- **Test:** one-sided paired sign-flip test of net gain > 0 over all questions, 10,000 draws, seed `20261021`; a one-sided 95% lower bound and a two-sided 95% interval from a 10,000-draw paired bootstrap with the same seed.
- **Errors count, never vanish.** A reader item that errored, expired, was canceled, is missing from its batch, stopped at the output limit or came back empty is an error row; a judge call that failed leaves its verdict null. Any error row, null primary or framed verdict, or missing cell makes the analysis `complete: false` with counts by kind, the verdict `incomplete`, and a nonzero exit. Recovery reruns only the failed items (reader by batch id, judges from the stored answer text), never a fresh sample of a settled one.
- Reported beside the primary: the affected-only net gain, per-question-type scores and net gains, the framed judge's net gain, judge agreement, and the reader-noise floor (how often the two `auto` samples disagree).

## Decision rule

Per suite and model, with alpha 0.05:

- **pass:** complete, net gain > 0, sign-flip one-sided p ≤ 0.05, and the bootstrap one-sided 95% lower bound > 0.
- **regression:** complete, net gain < 0, and the one-sided p for a loss ≤ 0.05.
- **inconclusive:** anything else that is complete, including a positive point estimate whose test or bound fails.
- **incomplete:** any failure as defined above. An incomplete run has no verdict.

The default-flip recommendation needs both of: Sonnet 5.5 passes on LongMemEval-S, and Sonnet 5.5 passes on the synthetic suite. Requiring both is an intersection-union test, so no multiplicity correction applies; the secondary models, the per-type rows and the framed judge are descriptive and take no part. On top of that, GBRA-108 requires the existing gbrain-evals retrieval categories to show no regression with the flag on; that check is outside this runner. A bracket audit that judges more than 5% of sampled brackets wrong also blocks the recommendation.

Sensitivity: the sign-flip test's smallest passing net gain is about 1.645 × √(Σ d²) over discordant questions. With 60 discordant questions that all flip fully (d = ±1), that is about 13 of 500 (2.5 points); half-flips (d = ±0.5) lower it. A smaller result is reported as "inconclusive at this sample size", never as "no effect".

## Bracket audit

From all inserted brackets in the LongMemEval `auto_dates` deliveries, 100 are sampled with seed `20261021`, each with 300 characters of surrounding text and its session date, and `claude-opus-5-5` judges whether the bracket is the right absolute date for the phrase. The wrong-bracket rate and its examples are reported.

## What each outcome changes

| If both suites pass | If either suite regresses | If inconclusive or incomplete |
|---|---|---|
| Recommend turning `search.evidence_resolve_dates` on by default, subject to GBRA-108's retrieval-category check and the audit | Keep the flag off by default, and report which question types lost | Keep the flag off by default; report the estimate, its interval and the reader-noise floor. An incomplete run is finished (failed items only) before anything is concluded. |

A ceiling is called out: a model at or near 100% on the affected questions in both arms can't show a difference.

## Budget

- One shared ledger for waves A and B of GBRA-162: `$GBRA162_LEDGER`, default `~/.capy/work/gbra162-external-ideas/ledger.sqlite`, program cap $220 cumulative. Every freeze, answer, judge and audit request is charged to it across shards, models and samples. A new ledger is never started to get around the cap.
- Every run prints a keyless preflight estimate and reserves its worst case; a run whose preflight worst case exceeds $50 refuses without `--gbra108-approval <ref>`.
- When the cap is reached the runner stops with `STOP: reason=budget_exhausted` and exit 4; remaining cells are reported as not run.
- Expected costs at batch prices from the smoke (2026-10-21; reader input calibrated on billed Sonnet 5.5 tokens, expected output from W10's receipts, judges at list): LongMemEval freeze about $9.00 (worst $11.69); one 500-question sample of one arm about $14.04 on Sonnet 5.5, $26.66 on Opus 5.5 and $9.43 on `gpt-6.1-sol`, judges included. The affected-only cells scale with the affected fraction. Synthetic suite: freeze about $0.09, one 60-question sample of one arm about $0.37 on Sonnet 5.5, $0.58 on Opus 5.5 and $0.31 on `gpt-6.1-sol`.

## Amendments

None yet.
