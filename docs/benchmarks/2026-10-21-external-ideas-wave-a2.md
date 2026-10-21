# External ideas wave A2: rank labels in date order (R1) and a protected tail trim (R2)

Measured 2026-10-21 under the [preregistration](2026-10-21-external-ideas-wave-a2-preregistration.md), on wave A's frozen LongMemEval-S `auto` deliveries at gbrain `cfa1a006b64c5baa199142bf0f0b56a0e3fc6c06` (frozen manifest `5f62ad3909320ae95c3496a263348bd1cc7deaf1ac335ee25490196acaf7be5b`). Wave A2 adds no gbrain code: both arms are eval-side transforms of the reader request that wave A's `auto` arm already answered. Every file behind these numbers is in [`2026-10-21-external-ideas-wave-a2/results/`](2026-10-21-external-ideas-wave-a2/results/).

**Verdict: R2 passes non-inferiority on Sonnet 5.5, with its harm checks not run; R1 is inconclusive.** Trimming the low-scoring tail behind a protected top 3 kept Sonnet 5.5 at 463 of 500 (net 0; the one-sided lower bound at its Holm level is −4, inside the −5 margin) while cutting the delivered evidence on the 217 affected questions by 36.6%. Ordering blocks by date with rank labels scored 462.5 against 463 (net −0.5, 95% interval −6.5 to +5), neither a pass nor a regression. The preregistered harm checks for R2 (`gpt-6.1-sol`, then `claude-opus-5-5`) don't fit the rest of this wave's cap, so, as preregistered, R2 is reported as a Sonnet-only pass and nothing changes in the product until they run.

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

Not run. They are due for R2 because it passed, but the preflight worst cases (R2 `gpt-6.1-sol` $68.1, R2 `claude-opus-5-5` $67.5; expected $13.3 and $36.4) don't fit the $28.46 left of this wave's $60 cap. As preregistered, they were not started and R2 is reported as passing on Sonnet with its harm checks not run. `a2-verdict.json` lists no secondaries. Running them needs a budget decision from the coordinator.

## Cost

All of it was charged to the GBRA-162 lane ledger (waves A, B and A2): $90.04 committed of the $220 cap, $129.96 left (`results/ledger-status.json`). This wave spent $31.54 of its $60 cap. Every cell ran through Anthropic Message Batches at the confirmed 50% factor, judges included, and no cell had a failure.

| Cell | Questions | USD |
|---|---|---|
| R1 sample 1 | 500 | 12.55 |
| R1 sample 2 | 500 | 12.31 |
| R2 sample 1 | 217 | 3.34 |
| R2 sample 2 | 217 | 3.34 |
| Total | | 31.54 |

The comparator is wave A's two Sonnet 5.5 `auto` samples, reused at no cost: the `auto` request hash in both A2 affected reports equals wave A's for 500 of 500 questions.

## What this changes

- **R1:** no change. Date order with rank labels neither helps nor hurts Sonnet 5.5 on this delivery.
- **R2:** no product change yet. The trim saves about a third of the reader's input on the questions it touches without measurably losing answers on Sonnet 5.5, so it is a candidate token-saving default for conversation deliveries once the `gpt-6.1-sol` and `claude-opus-5-5` harm checks run clean. This is development evidence on LongMemEval-S, which gbrain's retrieval was tuned on, so a pass here is not held-out confirmation.
