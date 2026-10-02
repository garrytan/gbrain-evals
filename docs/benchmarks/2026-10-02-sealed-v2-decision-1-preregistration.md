# Sealed v2, release decision 1: preregistration, 2026-10-02

This is a preregistration, not a result. It fixes, before the sealed files reach the machine that runs the check, the question, the two arms, the reader, the judge, the metric, the decision rule, the spending cap and what each outcome means for gbrain's default. The results will be published in a separate report, `2026-10-02-sealed-v2-decision-1.md`.

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents. When an agent searches its memory, gbrain ranks short passages (chunks, about 300 words each) and then decides how much text to hand back for each hit. That second step is evidence delivery.

## The question

gbrain v0.60.23.0 ([#5785](https://github.com/garrytan/gbrain/pull/5785)) made `auto` the default evidence delivery. For a hit inside a conversation, `auto` returns the whole conversation page, with all conversation pages sharing a 24,000-token budget; every other hit keeps its ranked chunk. The previous default, `chunk`, returned the five ranked chunks unchanged.

On LongMemEval-S, which is development data, `auto` answered 445 of 500 questions against 312 for chunks ([auto v2 check](2026-09-30-evidence-auto-v2.md)). On the first sealed set the chunk default already answered 147 of 150, so no gain could be confirmed there, and the preregistered check came out `fail` (no demonstrated benefit and no demonstrated harm). gbrain shipped `auto` anyway as a judgment call on development evidence.

[Sealed confirmation set v2](2026-10-01-sealed-confirmation-v2-protocol.md) was built to be hard enough: 200 questions over 40 invented personas, histories of about 143,000 tokens, and answers that need two to four chats months apart. This decision asks, at the pinned gbrain commit:

1. Is `auto` non-inferior to `chunk` on end-to-end answer accuracy?
2. Is `auto` better than `chunk`?

## What is fixed

Machine-readable form: [`decision.json`](2026-10-02-sealed-v2-decision-1/decision.json) and the comparison family [`family.json`](2026-10-02-sealed-v2-decision-1/family.json). Where this text and those files disagree, the files win.

| Item | Value |
|---|---|
| Decision id | `sealed-v2-decision-1-2026-10-02:auto-vs-chunk` |
| Sealed set | `sealed-confirmation-v2`, manifest [`eval/data/sealed-confirmation-v2/manifest.json`](../../eval/data/sealed-confirmation-v2/manifest.json); questions `8d29e92d…`, labels `83bf52d1…` |
| Release decision | The first of the three the protocol allows. No gbrain run has touched the set. |
| gbrain commit | `d44296cf4d6481a10eb85562d3179e38cfd02c43` (master, v0.60.30.0), the pin in `package.json` since gbrain-evals 0.10.6 |
| Candidate arm | `auto`: gbrain's shipped default. No budget is passed, so the product default applies: 24,000 tokens for conversation pages for a trusted local caller. The answer step refuses any question whose applied budget, read back from gbrain, is not 24,000. |
| Comparison arm | `chunk`: the same commit with the five ranked chunks unchanged, which is the pre-0.60.16 default |
| Retrieval | Frozen once per question at the pinned commit and shared by both arms: hybrid search, top 5, balanced mode, `voyage:rerank-2.5` reranker (gbrain's default) with a 30 s timeout, no autocut, no query expansion, `openai:text-embedding-3-large` at 1,536 dimensions. A list that was not reranked is refused, not frozen. |
| Reader | The protocol's reader: `claude-sonnet-4-6`, temperature 0, 2,048 output tokens, LongMemEval's chain-of-thought reading prompt |
| Evidence shape | One dated pseudo-session per delivered block, with the block text as its only turn, sorted by date. This is the shape the v2 solvability chunk oracle used. Both arms use it, so only the delivered text differs. |
| Judge | `gpt-4o-2024-08-06`, temperature 0, LongMemEval's per-kind prompts (abstention items use the "unanswerable" prompt), through `sealed-confirmation.ts score --judge` |
| Primary metric | Judged answer correctness over **all 200 questions** (160 answerable plus 40 abstention). An empty answer, including a provider refusal, or a reader error counts as incorrect. |
| Comparison | `eval/runner/compare.ts`, paired by question and clustered by persona (40 clusters of 5), with `family.json` |
| Spending cap | $60 for every paid request in the decision, enforced by one `budget-ledger.ts` run, plus per-step caps on the reader and judge |

The code that runs the check is committed with this preregistration: the `evidence-freeze`, `evidence-answer` and `decide` subcommands of [`sealed-confirmation.ts`](../../eval/runner/sealed-confirmation.ts), the existing freeze in [`evidence-delivery/freeze.ts`](../../eval/runner/evidence-delivery/freeze.ts), and the existing comparison in [`compare.ts`](../../eval/runner/compare.ts) and [`stats/gates.ts`](../../eval/runner/stats/gates.ts). The freeze refuses to run unless `decision.json` is committed and unchanged and the gbrain checkout is at the pinned commit with no local changes under `src/`.

## Why these choices

**The protocol's reader, not the house notes reader.** The [auto v2 check](2026-09-30-evidence-auto-v2.md) used gbrain's notes reader at provider-default temperature, so that its sealed arm matched its LongMemEval arms. This decision has no LongMemEval arm. It uses the reader and judge the v2 protocol names and used for its solvability controls, at temperature 0, so the result can be read beside the protocol's oracle (199 of 200) and chunk-oracle (196 of 200) ceilings.

**All 200 questions.** Abstention questions test whether a delivery policy makes the reader invent a detail from related chats. Whole pages carry more near misses than five chunks, so leaving abstention out would hide a plausible cost of `auto`. Answerable-only accuracy is reported as a breakdown.

**One shared retrieval.** Both arms read evidence built from the same five hits, so any difference comes from delivery and not from a second, slightly different search.

## The decision rule

No rule for a non-inferiority margin existed in the earlier plans. The [10x plan](../plans/2026-09-28-gbrain-10x/PLAN.md) (amendment 4) and the [October 1 wave plan](../plans/2026-10-01-eval-category-wave/PLAN.md) require that noisy quality metrics use a non-inferiority test with a stated tolerance, and the auto v2 decision manifest wrote down a superiority rule. This decision states the margin here and reuses that superiority rule.

1. **Non-inferiority decides the release check.** `compare.ts` computes `auto − chunk` over the 200 paired questions with a persona-cluster bootstrap (20,000 draws, seed 20261002).
   - **`pass`** when the one-sided bootstrap p-value for a loss of more than 3 percentage points is at most 0.05. Equivalently, the lower end of a 90% cluster-bootstrap interval for `auto − chunk` is above −0.03, which is 6 of 200 questions.
   - **`fail`** when the whole 95% cluster-bootstrap interval lies below −0.03.
   - **`inconclusive`** otherwise; when a comparison is blocked by a missing or duplicated row; or when either arm has more than 3 reader errors after the resume passes.
2. **Superiority is tested only after non-inferiority passes.** Testing in this fixed order keeps the overall false-positive rate at 0.05 without a further correction. Superiority is **confirmed** when `auto − chunk` is positive and both the exact two-sided McNemar p-value and the persona-clustered two-sided sign-flip p-value are below 0.05. This is the E2 rule of the [auto v2 decision manifest](2026-09-30-evidence-auto-v2/decision-manifest.json), without its second judge. Otherwise it is **not confirmed**.

A note on the comparison code: when every question gets the same verdict in both arms, the cluster bootstrap has no variation and `compare.ts` treats non-inferiority as shown. That is the committed behavior, and it is stated here in advance.

**The margin.** Three percentage points is the largest loss we would accept from a default that sends the reader several times more text. A wider margin would make `pass` easier without telling a user anything they could act on.

**Power.** [`power.json`](2026-10-02-sealed-v2-decision-1/power.json) simulates the committed rule with the real comparison code ([`scripts/power.ts`](2026-10-02-sealed-v2-decision-1/scripts/power.ts), 200 simulations per cell, 2,000 draws). With chunk accuracy between 50% and 80% and a true gain of 10 points, non-inferiority passes in 99% to 100% of simulations and superiority is confirmed in 74.5% to 93.5%. With no true difference, non-inferiority passes in only 24.5% to 53%, so `inconclusive` is the likely outcome if the two policies are equal. At a true loss of exactly 3 points, the rule passes in 2.5% to 8.5% of simulations, about the nominal 5% given simulation noise of 1.5 points; the percentile bootstrap with 40 clusters may run slightly above 5%. A true gain of 3 points is confirmed only 9% to 18.5% of the time, so a small real gain will usually show as "non-inferior, gain not confirmed".

## What each outcome means for the default

| Outcome | Meaning | Recommendation for gbrain |
|---|---|---|
| `pass`, superiority confirmed | `auto` is better on held-out data, at the shipped settings | Keep `auto` as the default. The development-data gain is now confirmed on a set nobody tuned against. |
| `pass`, superiority not confirmed | `auto` is no more than 3 points worse, but a gain is not shown | Keep `auto` as the default. Say plainly that the held-out gain is unconfirmed. |
| `inconclusive` | The interval is too wide to rule out a loss of more than 3 points, or the run had too many errors | The default stays a judgment call on development data. The set gets no second look under this decision. |
| `fail` | `auto` is more than 3 points worse with 95% confidence | Recommend restoring `chunk` as the default for conversation hits, fixing `auto` on development data, and preregistering a new decision. |

The result accepts or rejects this configuration only. Per the protocol, it may not be used to choose a different budget, unit, reader or prompt, and the set may not be rerun with another setting under this decision.

## What gets measured besides the decision

These are exploratory and decide nothing:

- answer accuracy on the 160 answerable questions, and by kind (80 multi-session, 40 temporal, 40 knowledge update, 40 abstention);
- `recall_all@5` (every gold chat in the top five) and `recall_any@5` over the 160 answerable questions, for the shared retrieval;
- mean provider-reported reader input tokens per arm;
- `auto` delivery: blocks returned as whole pages, blocks truncated, blocks kept as chunks because the budget ran out;
- empty or truncated reader outputs per arm.

## How the run handles failures

- **Each arm is answered once.** The reader is called at temperature 0, and every response is cached by the hash of its exact request.
- **A crash is resumed, not re-sampled.** Rerunning a step on the same output keeps answered questions, and identical requests are served from the cache. At most three resume passes. The freeze resumes per question, and a frozen question is never retrieved again.
- **Errors stay in the denominator.** After the resume passes, a question without an answer is judged incorrect. A question missing from either arm blocks the comparison.
- **Labels are read twice, both through the runner and under this decision id:** once to score the chunk answers and once to score the auto answers. Each read checks the labels commitment and appends a line to the access log before parsing. No other label read is allowed.
- Every deviation from this document will be reported in the results, with its reason.

## Custody

The owner's agent copies `questions.json`, `labels.json`, `ledger.json` and `access-log.jsonl` to `~/sealed-v2/` on the Capy machine only after this preregistration is pushed. The run first checks the three files against the SHA-256 commitments in the manifest. All sealed-derived files (the freeze with chat text, embedding caches, answers, judgments, response caches and per-question scores) stay under `~/sealed-v2/`. After scoring, the access log is copied out for the owner, and `~/sealed-v2/` is deleted. The `ledger.json` file is not read by this decision.

Only aggregates are published: counts with denominators, by kind, the paired table, the tests and their intervals. Question text, chats, gold chats, answers and per-question outcomes are never published.

## Budget

Estimated from two keyed setup runs on invented fixtures (no sealed data): a two-question fixture and a one-history fixture of 46 chats and 500,000 characters, about the size of a v2 history.

| Step | Basis | Estimate |
|---|---|---:|
| Retrieval freeze, 40 histories, 200 questions | $0.033 per history measured for embeddings and two reranks; later questions on a history reuse its embeddings | $1.50 to $2.00 |
| `chunk` reader, 200 calls | about 4,000 input and 500 output tokens each | $4 |
| `auto` reader, 200 calls | about 18,000 input tokens each (five pages of about 3,100 tokens); at most 24,000 plus prompt | $12 (at most $22) |
| Judge, 400 calls | about 1,200 input tokens each | $1.50 |
| **Total** | | **about $20, at most about $30** |

The cap is $60. Per-step caps: $10 for the `chunk` reader, $35 for the `auto` reader and $3 for each judge pass. The fixture runs cost about $0.22 together, including one direct reader call made to diagnose an empty answer on the word-salad fixture (the provider returned a refusal), and are outside the cap. Wall time is expected to be 20 to 30 minutes for the freeze with four shards and about 10 minutes for reading and judging.

## Commands (repository root)

```bash
export GBRAIN_DIR=<gbrain checkout at d44296cf4d6481a10eb85562d3179e38cfd02c43>
S=~/sealed-v2
M=eval/data/sealed-confirmation-v2/manifest.json
D=docs/benchmarks/2026-10-02-sealed-v2-decision-1/decision.json
RUN=$(bun eval/runner/budget-ledger.ts open --runner sealed-v2-decision-1 --budget-usd 60 --estimate-usd 30 | tail -1)

bun eval/runner/sealed-confirmation.ts validate --manifest $M --questions $S/questions.json
for k in 0 1 2 3; do   # four shards by history, run in parallel
  bun eval/runner/sealed-confirmation.ts evidence-freeze --manifest $M --questions $S/questions.json --decision $D \
    --shard $k/4 --out-dir $S/frozen-$k --embed-cache $S/embed-$k.sqlite --budget-run-id $RUN &
done; wait
bun eval/runner/evidence-delivery.ts merge-frozen --out-dir $S/frozen --from $S/frozen-0,$S/frozen-1,$S/frozen-2,$S/frozen-3

bun eval/runner/sealed-confirmation.ts evidence-answer --manifest $M --questions $S/questions.json --decision $D \
  --evidence-dir $S/frozen --arm chunk --out $S/runs/answers-chunk.jsonl --cap-usd 10 --budget-run-id $RUN
bun eval/runner/sealed-confirmation.ts evidence-answer --manifest $M --questions $S/questions.json --decision $D \
  --evidence-dir $S/frozen --arm auto --out $S/runs/answers-auto.jsonl --cap-usd 35 --budget-run-id $RUN

for arm in chunk auto; do
  bun eval/runner/sealed-confirmation.ts score --manifest $M --questions $S/questions.json --labels $S/labels.json \
    --run $S/runs/answers-$arm.jsonl --judge --cap-usd 3 --spend $S/runs/judge-spend-$arm.jsonl \
    --purpose "sealed v2 release decision 1: auto vs chunk at gbrain d44296c" \
    --decision-id sealed-v2-decision-1-2026-10-02:auto-vs-chunk --out $S/runs/score-$arm.json --budget-run-id $RUN
done

bun eval/runner/compare.ts $S/runs/score-chunk.json $S/runs/score-auto.json \
  --family docs/benchmarks/2026-10-02-sealed-v2-decision-1/family.json --rows-path per_question --json > $S/runs/compare.json
bun eval/runner/sealed-confirmation.ts decide --manifest $M --decision $D --compare $S/runs/compare.json \
  --answers $S/runs/answers-chunk.jsonl,$S/runs/answers-auto.jsonl --out $S/runs/decision.json
```

Keys: `OPENAI_API_KEY` (embeddings, judge), `VOYAGE_API_KEY` (reranker), `ANTHROPIC_API_KEY` (reader).
