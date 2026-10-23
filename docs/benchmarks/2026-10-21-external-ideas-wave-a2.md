# External ideas wave A2: rank labels in date order (R1) and a protected tail trim (R2)

Measured 2026-10-21 under the [preregistration](2026-10-21-external-ideas-wave-a2-preregistration.md), on wave A's frozen LongMemEval-S `auto` deliveries at gbrain `cfa1a006b64c5baa199142bf0f0b56a0e3fc6c06` (frozen manifest `5f62ad3909320ae95c3496a263348bd1cc7deaf1ac335ee25490196acaf7be5b`). Wave A2 adds no gbrain code: both arms are eval-side transforms of the reader request that wave A's `auto` arm already answered. Every file behind these numbers is in [`2026-10-21-external-ideas-wave-a2/results/`](2026-10-21-external-ideas-wave-a2/results/).

**Verdict: R2 passes non-inferiority on Sonnet 5.5, and its harm checks show no regression on `gpt-6.1-sol` or `claude-opus-5-5`; R1 is inconclusive.** Trimming the low-scoring tail behind a protected top 3 kept Sonnet 5.5 at 463 of 500 (net 0; the one-sided lower bound at its Holm level is −4, inside the −5 margin) while cutting the delivered evidence on the 217 affected questions by 36.6%. On those questions Sol scored 208 against 208 and Opus 209 against 210. Sol's cell is formally incomplete by three `auto` rows that OpenAI's batch queue never returned, but no outcome of those rows can make it a regression. Only one trimmed question lost a gold-session block, and it flipped to wrong on all three models. Ordering blocks by date with rank labels scored 462.5 against 463 (net −0.5, 95% interval −6.5 to +5), neither a pass nor a regression.

## Decision (Holm across R1 and R2, alpha 0.05)

| Arm | Hypothesis | p | Tested at | Rejected | Lower bound at Holm level | Delivered-token reduction | Verdict |
|---|---|---|---|---|---|---|---|
| `r2_tail_trim` | non-inferiority, margin −5 | 0.0069 (`p_noninferior`) | 0.025 | yes | −4 | 36.6% (bar 20%) | **pass** |
| `r1_rank_date` | superiority | 0.633 (one-sided gain) | 0.05 | no | | 0% | inconclusive |

R1's one-sided p for a loss is 0.506, so it isn't a regression either. `a2-verdict.json` applies the rule (`a2Verdict` in `eval/runner/external-ideas-wave-a/lib.ts`). The sign-flip and the bootstrap each used 10,000 draws with seed 20261021.

## R1: rank labels in chronological order (`r1_rank_date`, all 500 questions affected)

Blocks are reordered oldest first and each is labelled `[retrieval rank N of M]`, with one note line before the evidence. Delivered evidence tokens are unchanged.

| Measure (official judge, mean of 2 samples) | auto | r1_rank_date | Net gain | 95% CI | One-sided p (gain) | One-sided 95% lower bound | Wins | Losses |
|---|---|---|---|---|---|---|---|---|
| All 500 questions | 463 | 462.5 | −0.5 | −6.5 to +5 | 0.633 | −5.5 | 12 | 12 |
| Framed judge, report-only | 459.5 | 462 | +2.5 | −2.5 to +7.5 | 0.223 | −2 | 13 | 8 |

| Type | Questions | Affected | auto | r1_rank_date | Net gain |
|---|---|---|---|---|---|
| temporal-reasoning | 127 | 127 | 113 | 111.5 | −1.5 |
| multi-session | 121 | 121 | 104 | 105 | +1 |
| knowledge-update | 72 | 72 | 71 | 71.5 | +0.5 |
| single-session-user | 64 | 64 | 61.5 | 61.5 | 0 |
| single-session-assistant | 56 | 56 | 55.5 | 55.5 | 0 |
| abstention | 30 | 30 | 28 | 28 | 0 |
| single-session-preference | 30 | 30 | 30 | 29.5 | −0.5 |

- **Sensitivity:** with about 25 discordant questions, R1 needed a net gain of about 8 of 500 to pass at 0.05, as the preregistration said. The observed −0.5 is far from that.
- **Judges:** they agree on 1,974 of 2,000 rows (official yes and framed no on 17, the reverse on 9). The framed judge leans slightly toward R1, but it is report-only.

## R2: protected top-3 tail trim (`r2_tail_trim`, 217 of 500 questions affected)

The top 3 blocks are kept; a later block is dropped when its frozen hybrid hit score is below 50% of rank 1's. This adapts idea 5.3, which protects the top 5, to this top-5 delivery; a deeper top-10 delivery was considered and not run (about $33). The trim dropped 398 blocks across 217 questions. No block was kept by the span guard and no question used the rank fallback.

| Measure (official judge, mean of 2 samples) | auto | r2_tail_trim | Net gain | 95% CI | `p_noninferior` | One-sided lower bound (0.05 / 0.025) | Wins | Losses |
|---|---|---|---|---|---|---|---|---|
| All 500 questions | 463 | 463 | 0 | −4 to +4 | 0.0069 | −3.5 / −4 | 6 | 4 |
| Affected only (217) | 209.5 | 209.5 | 0 | −4 to +3.5 | 0.0063 | −3.5 / −4 | 6 | 4 |
| Framed judge, report-only | 459.5 | 460 | +0.5 | −4 to +5 | 0.007 | −3.5 / −4 | 5 | 4 |

| Type | Questions | Affected | auto | r2_tail_trim | Net gain |
|---|---|---|---|---|---|
| temporal-reasoning | 127 | 24 | 113 | 113 | 0 |
| multi-session | 121 | 34 | 104 | 104 | 0 |
| knowledge-update | 72 | 62 | 71 | 69 | −2 |
| single-session-user | 64 | 39 | 61.5 | 62 | +0.5 |
| single-session-assistant | 56 | 52 | 55.5 | 56 | +0.5 |
| abstention | 30 | 4 | 28 | 29 | +1 |
| single-session-preference | 30 | 2 | 30 | 30 | 0 |

**Tokens on the 217 affected questions:**

| Measure | auto | r2_tail_trim | Reduction |
|---|---|---|---|
| Delivered evidence, mean `estimateTokens` (the preregistered bar) | 12,634 | 8,011 | 36.6% |
| Billed reader input tokens per request, mean (prompt and question included) | 20,665 | 13,213 | 36.1% |
| Billed reader input tokens per sample, total | 4,484,274 | 2,867,200 | 36.1% |
| Answer-row cost per sample (samples 1 / 2), batch prices | $4.80 / $4.66 | $3.04 / $3.04 | about 36% |

- **Where it cost:** knowledge-update lost 2 questions (62 of its 72 questions were trimmed), the only type that moved down. That is inside the margin, but it is the type to watch in the harm checks: a dropped older block can hold the earlier value an update question compares against.
- **Reader noise:** wave A's two `auto` samples disagree on 5 of these 217 questions. The observed wins and losses (6 and 4) are the same size as the noise.
- **Judges:** they agree on 1,412 of 1,434 rows (official yes and framed no on 16, the reverse on 6).

## Secondary models (harm checks)

Run under the [same-day amendment](2026-10-21-external-ideas-wave-a2-preregistration.md#2026-10-21-after-the-sonnet-55-cells-and-before-any-harm-check-request-the-wave-cap-for-the-r2-harm-checks), which raised the wave cap to a lane stop at $215. Both models ran `auto` and `r2_tail_trim`, two samples each, on R2's 217 affected questions, analyzed with `--scope affected` (`results/harm/`, `results/a2-verdict-harm.json`). **Neither shows a regression, so R2's Sonnet pass stands with clean harm checks**, with one caveat on Sol's completeness below.

| Model (official judge, mean of 2 samples, 217 questions) | auto | r2_tail_trim | Net gain | 95% CI | One-sided p (loss) | `p_noninferior` | Wins | Losses | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| `claude-sonnet-5-5` (decision model) | 209.5 | 209.5 | 0 | −4 to +3.5 | 0.599 | 0.0063 | 6 | 4 | pass |
| `gpt-6.1-sol` | 208 | 208 | 0 | −3.5 to +3 | 0.615 | 0.0018 | 5 | 4 | incomplete (3 rows), not a regression |
| `claude-opus-5-5` | 210 | 209 | −1 | −4.5 to +2 | 0.379 | 0.0070 | 3 | 4 | inconclusive, not a regression |

- **Sol is incomplete by 3 rows.** OpenAI's batch queue stalled on single requests for hours at a time, and three `auto` sample-1 requests (`01493427`, `08e075c7`, `1de5cff2`) errored on their first attempt and were still unanswered on their one retry when this was written. Under the preregistered rule an error row makes the cell incomplete, so Sol's verdict is `incomplete`. It cannot be a regression whatever those rows return: scoring all three as correct for `auto` gives a net of −1.5 with a one-sided loss p of 0.26, far from 0.05. That bound is why Opus was started before the last Sol retries ended.
- **Framed judge (report-only):** Sol 207.5 against 207.5; Opus 210.5 against 208 (−2.5, 1 win and 4 losses).
- **Reader noise:** the two `auto` samples disagree on 3 of 214 complete Sol questions and 4 of 217 Opus questions.
- **Ceiling:** every model is at 95.6% to 96.8% on these questions with `auto`, so there is little room for either a gain or a loss to show.

## Knowledge-update and gold sessions

| Knowledge-update (62 affected of 72) | auto | r2_tail_trim | Net gain |
|---|---|---|---|
| `claude-sonnet-5-5` | 71 | 69 | −2 |
| `gpt-6.1-sol` | 60.5 | 60 | −0.5 |
| `claude-opus-5-5` | 59.5 | 59 | −0.5 |

(Sonnet's row is over all 72 knowledge-update questions, as in its per-type table, and the other two are over the 62 affected ones. The 10 unaffected questions add 0 to the net either way.)

**Dropped gold blocks:** of the 217 trimmed questions, exactly **one** lost a block from a gold (answer) session: `e66b632c`, a knowledge-update question with two gold sessions, whose rank-4 block was cut (`results/gold-dropped.json`; gold sessions are matched by recomputing the opaque session slug from the dataset's `answer_session_ids`, after retrieval). It is the one question all three models answer correctly with `auto` and wrongly with R2, in both samples. The trim never dropped a gold block anywhere else, and the other knowledge-update losses are reader-noise flips on questions whose gold blocks were all kept.

So the knowledge-update concern is real but narrow: when an update question's earlier value sits in a low-scoring tail block, the protected top 3 doesn't save it. A product version of the trim should consider a guard for that case, such as keeping a dropped block from the same thread or topic as a kept one, before it becomes a default.

## Cost

All of it was charged to the GBRA-162 lane ledger (waves A, B and A2): $137.52 committed of the $220 cap, under the amendment's $215 stop, with $82.48 left (`results/ledger-status.json`). Wave A2 spent $79.02. Every cell ran through Message Batches (Anthropic) or the Batch API (OpenAI) at the confirmed 50% factor after list-price pilots, judges included.

| Step | Questions | USD |
|---|---|---|
| Sonnet 5.5: R1 samples 1 and 2 | 500 each | 24.86 |
| Sonnet 5.5: R2 samples 1 and 2 | 217 each | 6.69 |
| `gpt-6.1-sol` harm check: `auto` and R2, 2 samples each (pilots cancelled after stalling included) | 217 each | 13.14 |
| `claude-opus-5-5` harm check: `auto` and R2, 2 samples each | 217 each | 34.34 |
| Total | | 79.02 |

The harm-check lines are ledger deltas across their runs. The Sonnet comparator is wave A's two `auto` samples, reused at no cost: the `auto` request hash in both A2 affected reports equals wave A's for 500 of 500 questions.

## What this changes

- **R1:** no change. Date order with rank labels neither helps nor hurts Sonnet 5.5 on this delivery.
- **R2:** it passes non-inferiority on Sonnet 5.5, and neither harm check shows a regression on Sol or Opus. On the questions it touches, it cuts about a third of the reader's input with no measurable loss in answers. It is a candidate token-saving default for conversation deliveries. Two limits apply before a product change. First, this is development evidence on LongMemEval-S, which gbrain's retrieval was tuned on, so it is not held-out confirmation. Second, the one question it reliably breaks is a knowledge-update question whose earlier value sat in the trimmed tail, so a product version wants a guard for that shape.
