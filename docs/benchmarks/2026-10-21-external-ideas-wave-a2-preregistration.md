# External ideas wave A2 preregistration: rank labels in date order (R1) and a protected tail trim (R2)

Written 2026-10-21, before any wave A2 paid request, for GBRA-162. Runners attest this file against `origin` before their first paid request (`eval/runner/prereg.ts`; `answer` picks this file for the render arms). Wave A2 adds no gbrain code. Both arms are deterministic, eval-side transforms of the frozen reader request that wave A's `auto` arm already answered.

## Question

Does how gbrain lays out the evidence it already delivers change answer accuracy, with retrieval and delivery frozen?

- **R1 (idea 5.4):** order blocks by date and label each with its retrieval rank.
- **R2 (idea 5.3):** trim the low-scoring tail behind a protected head. This would save tokens without losing answers.

## Evidence class

Development evidence on LongMemEval-S, the same as wave A. gbrain's retrieval configuration was tuned on these questions, so a pass here is not held-out confirmation.

## Build and data

- **Frozen evidence:** wave A's LongMemEval-S frozen set at gbrain `cfa1a006b64c5baa199142bf0f0b56a0e3fc6c06`, frozen manifest `5f62ad3909320ae95c3496a263348bd1cc7deaf1ac335ee25490196acaf7be5b`, and the product `auto` delivery with no config. The study manifest, dataset (SHA-256 `d6f21ea9…a442`), reader prompt (system SHA-256 `3db7ccbb…87d0`), 60,000-character session bound and opaque session ids are all unchanged from [wave A](2026-10-21-external-ideas-wave-a-preregistration.md).
- **Comparator:** wave A's two `auto` samples on Sonnet 5.5 (`docs/benchmarks/2026-10-21-external-ideas-wave-a/results/longmemeval/rows/auto__s{1,2}__claude-sonnet-5-5.ndjson.gz`). They answer exactly the requests this wave's `auto` side would send: the `auto` request hash in both A2 affected reports equals wave A's for 500 of 500 questions, and all 1,000 stored rows carry that hash.
- **gbrain-evals:** the commit that adds this file. The arm code is in `eval/runner/external-ideas-wave-a/render-arms.ts`, and the runner is `eval/runner/external-ideas-wave-a.ts` (`--arm r1_rank_date|r2_tail_trim`).
- **Seeds:** `20261021` for the sign-flip test and the bootstrap, both 10,000 draws.

## Arms

Each arm starts from the frozen `auto` delivery of a question: its blocks in delivery order, which is rank order (block order matches hit rank for 500 of 500 questions). The delivery holds at most 5 blocks, because it is assembled over the top-5 hits: 455 questions have 5 blocks, 43 have 4 and 2 have 3.

### `r1_rank_date`: rank labels in chronological order (idea 5.4)

- **Order:** blocks are reordered by their page's observation date, oldest first, with ties in rank order. Undated blocks go last, in rank order (no block in this set is undated).
- **Label:** each block is preceded by the line `[retrieval rank N of M]`, where N is its delivery rank and M is the number of delivered blocks.
- **Note:** one line comes before the evidence: "Blocks are in date order; rank shows retrieval relevance; a low-ranked block can still hold one item of a list or count."
- **Unchanged:** session text, `<chat_session>` framing, dates and ids are the house renderer's.
- **Affected:** every question's request changes, so all 500 questions are affected. Delivered evidence tokens are unchanged.

### `r2_tail_trim`: a protected top-3 tail trim (idea 5.3, adapted to this delivery's depth)

- **Keep:** the top 3 blocks by rank are kept untouched.
- **Drop:** a later block is dropped when its score is below 50% of rank 1's score. A block's score is the highest frozen hybrid hit score (`hits5[].score`) among the hits on its page. The product results store `score: 0`, so the hit score is the usable frozen score.
- **Fallback:** if a question had no usable score, the cut would instead drop blocks past rank 10. No question uses the fallback; the affected report counts it.
- **Span guard:** a block is never dropped if it holds an anchored match span of a kept chunk. In this delivery every block carries only its own chunk's span, so the guard never fires; the report counts it (0).
- **Why this adapts idea 5.3:** the idea as written protects the top 5. On a top-5-hit delivery that guard drops nothing, so it is moved to the top 3, the deepest guard that still leaves a tail to trim.
- **Considered and not run:** a deeper top-10 delivery, which would keep the top-5 guard. It needs a product-path re-freeze over `hits10` (about $8) plus a new `auto` comparator (about $25), roughly $33 in total, and it was not run.
- **Affected (keyless, before any paid request):** 217 of 500 questions, 398 blocks dropped. Mean delivered evidence tokens on those 217 questions fall from 12,634 to 8,011, a 36.6% reduction. The count is gbrain `estimateTokens` over the delivered block texts.
- **Affected by type:** knowledge-update 62 of 72, single-session-assistant 52 of 56, single-session-user 39 of 64, multi-session 34 of 121, temporal-reasoning 24 of 127, abstention 4 of 30, single-session-preference 2 of 30.

### Reader and judges

- **Reader:** `claude-sonnet-5-5` only, `output_config.effort: "low"`, 3,500 output tokens, through Anthropic Message Batches. That is wave A's setting, so the comparator rows stay valid.
- **Samples:** two per arm, on affected questions only. An unaffected question sends wave A's `auto` request and reuses its rows.
- **Judges:** `official_correct` (`gpt-4o-2024-08-06`, LongMemEval's prompt) is primary. `framed_correct` is report-only.

## Metric and denominator

- **Score:** per question, the mean of the two samples' official verdicts.
- **Net gain:** the sum over all 500 questions of (arm − `auto`); unaffected questions contribute 0.
- **Failures:** an error row, a null verdict or a missing cell makes an arm incomplete, the same as in wave A.
- **Also reported:** the affected-only line, per-type rows, the framed judge and the reader-noise floor from wave A's two `auto` samples.

## Decision rule

One family of two hypotheses, corrected with Holm at alpha 0.05:

- **R1, superiority:** the one-sided paired sign-flip p for a gain.
- **R2, non-inferiority:** the bootstrap share of net gains below −5 questions, written `p_noninferior`.
- **Holm steps:** the smaller p is tested at 0.025. The other is tested at 0.05, and only if the first was rejected.

Verdicts per arm:

- **R1 pass:** rejected, net gain > 0, and the bootstrap one-sided lower bound at its Holm level > 0.
- **R2 pass:** rejected, the bootstrap one-sided lower bound at its Holm level ≥ −5 questions (1 point of 500), and mean delivered tokens fall by at least 20% on affected questions.
- **Regression:** an arm that does not pass is a regression under the wave A rule (net < 0 and one-sided loss p ≤ 0.05).
- **Inconclusive:** otherwise, or **incomplete** if any cell failed.

`a2-verdict` applies this rule (`a2Verdict` in `lib.ts`).

**Sensitivity:** R1's sign-flip needs about 1.645 × √(Σ d²) net questions over discordant questions. Wave A's `auto` samples disagree on 2.4% of questions, so with about 25 fully discordant questions R1 needs a net gain of about 8 of 500 to pass at 0.05, and about 10 at 0.025.

## Secondary models (harm checks)

These follow the wave A amendment. Only for an arm that passes, `gpt-6.1-sol` runs and then `claude-opus-5-5`: both `auto` and the arm, two samples, that arm's affected questions only, analyzed with `--scope affected`. A secondary's **regression** verdict blocks the arm's recommendation. Its estimate and interval are reported.

These runs must fit this wave's cap. Preflight estimates:

| Harm check | Expected | Worst |
|---|---|---|
| R1, `gpt-6.1-sol` | $36.1 | $162.5 |
| R1, `claude-opus-5-5` | $101.3 | $172.9 |
| R2, `gpt-6.1-sol` | $13.3 | $68.1 |
| R2, `claude-opus-5-5` | $36.4 | $67.5 |

So a passing arm's harm checks will almost certainly need GBRA-108's budget decision. The runner stops and reports instead of starting a check that doesn't fit, and the arm is then reported as passing on Sonnet with its harm checks not run.

## Budget

- **Ledger:** the GBRA-162 lane ledger, the same one as waves A and B (`$GBRA162_LEDGER`, default `~/.capy/work/gbra162-external-ideas/ledger.sqlite`, $220 program cap).
- **Committed so far:** $58.50 before this wave, which includes wave B's $4.49 recorded as a manual entry.
- **This wave's cap:** $60. No run has a preflight worst case over $50.

Preflight at batch prices, after a 10-request pilot at list price, judges included:

| Cell | Questions | Expected | Worst |
|---|---|---|---|
| R1 sample 1 | 500 | $13.40 | $23.52 |
| R1 sample 2 | 500 | $13.40 | $23.52 |
| R2 sample 1 | 217 | $3.92 | $8.31 |
| R2 sample 2 | 217 | $3.92 | $8.31 |
| Total | | $34.64 | $63.66 |

The combined worst case ($63.66) is over the $60 wave cap. So, as the coordinator directed, R1 runs first (both samples). The coordinator is then told the spend before R2 starts. At the lane cap the runner stops with `STOP: reason=budget_exhausted`.

## What each outcome changes

| Outcome | R1 (labels and date order) | R2 (tail trim) |
|---|---|---|
| Pass, with harm checks clean | Propose the layout for gbrain's reader-facing delivery | Propose the trim as a token-saving default for conversation deliveries |
| Pass, harm checks not run | Report as a Sonnet-only pass; no product change until the checks run | The same |
| Inconclusive | No change; report the estimate and interval | No change; report the token saving and the interval |
| Regression | Do not adopt | Do not adopt; the dropped tail carried answers |

## Amendments

None yet.
