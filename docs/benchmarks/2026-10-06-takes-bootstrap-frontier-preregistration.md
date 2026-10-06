# Preregistration: takes-bootstrap classifier on the four frontier models (W4)

Written 2026-10-06, before any classifier call of this experiment. Plan: [W4 in the 2026-10 follow-up round](../plans/2026-10-06-followups-round/PLAN.md). Results go to [`2026-10-06-takes-bootstrap-frontier/`](2026-10-06-takes-bootstrap-frontier/).

## Question

Does any current frontier model run gbrain's takes-bootstrap extraction without crediting someone else's claim to the page holder and without unparseable output? gbrain keeps the takes-bootstrap autopilot tier `manual_only` until a live run of its 123-case eval graduates (gbrain `TODOS.md` TODO-E). The only live run so far (Claude Haiku 4.5, 2026-10-04) had 3 forbidden attributions and did not graduate.

The full graduation verdict needs per-kind precision and recall, and gbrain says its labels are incomplete (valid claims the archetypes do not list count as imprecise). So this run decides only what incomplete labels cannot distort: forbidden attributions and malformed cases. Per-kind precision, recall and the scorer's graduation line are published as **provisional**. When gbrain completes its archetype labels, `harness.mjs --replay` re-scores the committed predictions at $0, and that re-score, not this run, is the graduation verdict.

## Evidence class

Development evidence. The corpus is hand-written by gbrain around known failure classes (attribution traps, prompt injection, over-extraction bait), and its labels are known to be incomplete. Nothing here is a held-out confirmation.

## Build and data

- gbrain `c5fb0201d1960a0a5a81c35d77718311b03154b7` (v0.60.95.0), the round's pin, loaded from `node_modules/gbrain`. Before the first call the runner checks every blob under `src/` and `evals/takes-bootstrap/` against `git ls-tree c5fb0201` and refuses on any difference.
- Corpus `evals/takes-bootstrap/corpus.jsonl`, 123 cases (41 archetypes × 3 variants), sha256 `87c7aaa29746725657dc3fc8df993179f91fcbf6601aae0c90953f7b97ba2ad0`. 18 cases carry forbid patterns.
- Scorer `evals/takes-bootstrap/scorer.ts`, `SCORER_VERSION 1`, sha256 `52e1b364c8cca798ce461bd850e1f6d7a3908aff32d1897351efa7c1b9646d6f`.
- Upstream harness `evals/takes-bootstrap/harness.mjs`, sha256 `395143a53067a856a8f25af08741e0dca38bec939124a0dc04a91def417a3678`; `run-case.ts` sha256 `0e4c7d94afe760a4e630c0c059430b274d87a8ef71ce84c7bb3a05de4121d1fa`.
- **Harness overlay** `eval/runner/takes-bootstrap/harness-overlay.mjs`, with its diff against upstream in `harness-overlay.diff`. It changes four things and nothing in the production path: it loads gbrain from `--gbrain-dir`; it accepts `--price-input` / `--price-output` (USD per 1M tokens) for a model gbrain's built-in table cannot price and loads them into the harness's `BudgetTracker` as a `pricingOverrides` row; it writes a `--summary` JSON (spend, estimate, prices used, classifier errors, wall time); and it writes an observe-only `--request-log` (one line per provider request: case, HTTP status, stop reason, usage). gbrain's price table at the pin stops at `gpt-5.6`, so `openai:gpt-6.1-sol` gets the ledger's list price, $2 in / $10 out (`eval/runner/budget-ledger.ts` `CHAT_PRICE_OVERRIDES`). The three Claude models use gbrain's own table, which matches the ledger ($2/$10, $4/$20, $10/$50).
- Route check, run before this preregistration: gbrain's gateway at the pin accepted `openai:gpt-6.1-sol` and `openai:gpt-6-luna` with a 16-token `chat()` call each (both answered "OK", $0.00008, ledger run `w4-gbrain-route-check-2026-10-06T18-10-32-260Z-4f6f0c80`). That receipt is committed with the results.

## Arms

Four arms, one per model, run in this order: `anthropic:claude-sonnet-5-5`, `openai:gpt-6.1-sol`, `anthropic:claude-opus-5-5`, `anthropic:claude-fable-5-1`. No comparator arm runs: Claude Haiku 4.5 is not rerun and links only by its published aggregate counts in [the 2026-10-04 verdict](2026-10-04-takes-bootstrap-verdict.md) (its predictions were never committed, so no paired test is possible).

Every arm uses gbrain's production path unchanged (`extractTakesFromPages` through `run-case.ts`): the extractor's own prompt, `maxTokens: 2000`, provider-default temperature, and gbrain's gateway defaults for reasoning (Claude 5-family models think by default in gbrain's gateway; gbrain sets no reasoning effort for OpenAI models, and controlling it is out of scope for this round). Single sample per case.

## Metric and denominator

Primary, per model, denominator 123 cases:

- **Malformed cases**: cases whose output could not be parsed or whose classifier call failed (the harness scores a failed call as malformed, never a skip).
- **Forbidden attributions**: forbid-pattern matches across all predicted claims (the scorer's `forbid_violations`; 18 cases carry patterns).

Each count is printed with its exact two-sided 95% Clopper-Pearson interval as a per-case rate (malformed over 123; cases with a forbid violation over the 18 cases that carry patterns). At 0 of 123 the upper bound is 2.95%; at 0 of 18 it is 18.5%, so a clean run shows the absence of the Haiku-level failure on this corpus, not a guarantee.

Provisional, per model: per-kind precision and recall (fact, take, bet, hunch), overall precision and recall, variants passed (of 123), and the scorer's graduation line, exactly as `scorer.ts` v1 computes them.

Also reported per arm: wall time, spend, provider requests, non-2xx responses, cases sent more than once (retries) and output-limit finishes, from the request log. A truncated output that fails to parse is malformed; a truncated output that parses is scored as returned.

Errors: if the harness exits 2 (spend cap reached, a case the extractor did not classify, or a keyless refusal), it writes no predictions and scores nothing; that arm is **Failed** with the reason and is not rerun to get a better result. One rerun is allowed only for an infrastructure cause outside the model (for example a provider outage), stated in the report.

## Decision rule

A model **passes the label-independent check** when it has 0 malformed cases and 0 forbidden attributions on all 123 cases. Each model is judged by this count rule on its own; there is no hypothesis test between models, so no multiple-comparison correction applies, and the report makes no ranking claim from differences in these counts. The comparison with Haiku 4.5 is descriptive (its published 3 forbidden attributions and 0 malformed).

The provisional per-kind table can motivate gbrain's next step but cannot graduate the tier. The graduation verdict is the free re-score on gbrain's completed labels.

## What each outcome changes

| If it wins | If it loses | If inconclusive or at the ceiling |
|---|---|---|
| gbrain can graduate the tier after its labels land; mirror the verdict | Classifier work stays on gbrain's TODO-E with model-independent evidence | Wait for the labels; re-score free |

"Wins" here means at least one model passes the label-independent check; the provisional per-kind table then shows what remains for graduation.

## Budget

Ledger `/workspace/gbrain-evals/.budget/followups-2026-10.sqlite` (the round's one ledger), one budget run `w4-takes-bootstrap-frontier`, `--budget-usd 6` (the plan's W4 cap), estimate $4.20 (the sum of the harness's own estimates: Sonnet 5.5 $0.47, GPT-6.1 Sol $0.47, Opus 5.5 $0.94, Fable 5.1 $2.34).

The harness has its own `BudgetTracker`, so before each arm the runner reserves that arm's whole cap in the ledger as one reservation, passes the same cap as `--max-usd` (a hard ceiling inside the harness), and settles the reservation to the spend the tracker reports. Per-arm caps: Sonnet 5.5 $0.80, GPT-6.1 Sol $0.80, Opus 5.5 $1.40, Fable 5.1 whatever is left of the $6 when it starts, at least $2.50 (the runner refuses below that). If actual spend runs more than 25% over the $4.20 estimate, paid work stops and the remaining arms are reported as **Not run**.

A bounded smoke of at most 3 cases on one model may run first to verify the overlay, under the same ledger with its own small budget run; its output is kept in the receipts folder and is not scored as a result.

Runner: `bun eval/runner/takes-bootstrap-frontier.ts run --preregistration docs/benchmarks/2026-10-06-takes-bootstrap-frontier-preregistration.md --out-dir docs/benchmarks/2026-10-06-takes-bootstrap-frontier --caps anthropic:claude-sonnet-5-5=0.8,openai:gpt-6.1-sol=0.8,anthropic:claude-opus-5-5=1.4,anthropic:claude-fable-5-1=rest --min-caps anthropic:claude-fable-5-1=2.5 --budget-ledger <ledger> --budget-usd 6`. It calls `attestPreregistration` before the first paid request and writes the attestation into `receipt.json`.

## Amendments

None yet.
