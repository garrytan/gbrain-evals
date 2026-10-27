# Evidence tail trim in the product (gbrain#7443): guarded replay on the wave A2 evidence

Written 2026-10-23 for GBRA-156. This mirrors the verdict for gbrain's `search.evidence_tail_trim` (gbrain [#7443](https://github.com/garrytan/gbrain/pull/7443), shipped in v0.60.421.0, default off). That is the product version of wave A2's `r2_tail_trim` arm (wave A2 [results](2026-10-21-external-ideas-wave-a2.md) and [preregistration](2026-10-21-external-ideas-wave-a2-preregistration.md), from [#185](https://github.com/garrytan/gbrain-evals/pull/185)). No paid request was made. Every number below comes from the frozen wave A2 evidence and the answer rows wave A2 already graded.

**Verdict: ship default-off.** The product trim with its query-term guard keeps the one gold block the unguarded arm reliably lost. It still cuts delivered tokens by 36.3% on the questions it touches. On the measured rows, it scores at or above both `auto` and the unguarded arm on all three reader models. Six guarded requests were never sent to a reader, so the guarded score is a bound, not a measurement. Like wave A2, this is development evidence on LongMemEval-S, not held-out confirmation.

## What the product does

- **Same cut as R2:** under `return_unit: auto`, `search` and `query` drop whole-conversation blocks past the top 3 whose search score is under half of rank one's. The product reads the delivered row's score. On a frozen list that is the hit score the caller passes (`assembleEvidenceForHits({ query, hits: [{ ..., score }] })`), which is wave A2's `hits5[].score` per page.
- **Guard (new):** a block under the cut is kept when its text holds at least 80% of rank one's share of the query's terms. Terms are letter and digit runs with stopwords and single characters dropped, each cut to six characters. Wave A2's broken question, `e66b632c`, is a knowledge-update question whose earlier value sat in a rank-4 session restating the asked fact. That block holds 6 of the query's 7 terms, and rank one holds 7 of 7.
- **Never dropped:** ranked chunks of non-conversation pages, saved facts and long pages. Without a query, or without a usable score on every row, nothing changes. R2's span guard never fired on this delivery and has no product counterpart. R2's rank-10 fallback was never used, and the product does nothing in that case.

## Replay on the frozen evidence

Inputs: the wave A frozen manifest (`frozen-manifest.jsonl`, SHA-256 `1204d0a8…abb1`) and each question's frozen `auto` product results, rescored with the per-page hits5 maximum. The product function is gbrain #7443's `evidence-tail-trim.ts` (SHA-256 `1c0e6d0b…9028`). Receipts are in [`2026-10-23-evidence-tail-trim-product/`](2026-10-23-evidence-tail-trim-product/).

| | Unguarded R2 (wave A2) | Product trim with guard |
|---|---|---|
| Questions trimmed | 217 | 210, all inside R2's 217 |
| Blocks dropped | 398 | 383 |
| Blocks kept by the query-term guard | — | 15 |
| Delivered-token saving on the trimmed questions | 36.6% | 36.3% |
| `e66b632c` gold block (rank 4) | dropped | kept |

Trimmed questions by type: knowledge-update 61, single-session-assistant 51, single-session-user 38, multi-session 35, temporal-reasoning 24, single-session-preference 1.

## Accuracy from the measured rows

Each of R2's 217 affected questions falls into one of three classes:

- **204** send a request byte-identical to the measured R2 request, because the guard kept nothing. They reuse R2's graded rows.
- **7** drop nothing and send the measured `auto` request. They reuse `auto`'s rows.
- **6** differ from both (`830ce83f`, `cc539528`, `a11281a2`, `71a3fd6b`, `d596882b`, `1903aded`). They were not sent to a reader, so each is bounded by its two measured answers.

Official judge, mean of two samples, over the 217 questions:

| Reader | `auto` | Unguarded R2 | Product trim (bounded) |
|---|---|---|---|
| claude-sonnet-5-5 | 209.5 | 209.5 | 210 to 211 |
| gpt-6.1-sol | 208 | 208 | 209 |
| claude-opus-5-5 | 210 | 209 | 210 |

The bound assumes each of the six novel requests is answered like one of its two neighbours. Its guard keeps only a subset of R2's drops, so its evidence lies between the two. A reader is not guaranteed to behave monotonically, so this is a bound under that assumption, not a measured result.

## Latency

The trim runs after page fetch and redaction, so it does not shorten gbrain's response stage. On the 210 trimmed questions, the trim takes 0.9 to 1.3 ms per call on the replay machine, and serialization is about 0.05 ms shorter. The delivered results shrink by 36.5% in JSON bytes (median 62,128 to 39,364). That is the gain: less for the reader to transfer and read, not less server time.

## What would change this

- A paid run of the six novel requests on the three readers would replace the bound with a measurement (about $1).
- A held-out conversation set would be needed before proposing the trim as a default.
