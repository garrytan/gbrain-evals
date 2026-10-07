# Takes-bootstrap on the four frontier models: no forbidden attributions, still not graduated

**Finding.** On gbrain's 123-case takes-bootstrap eval, none of the current frontier models credited someone else's claim to the page holder, and none produced unparseable output. On October 6, 2026, at gbrain `c5fb0201` (v0.60.95.0), Claude Sonnet 5.5, GPT-6.1 Sol and Claude Opus 5.5 each had **0 forbidden attributions and 0 malformed cases of 123** (so did Claude Fable 5.1, run before Fable became smoke-only), against 3 forbidden attributions for Claude Haiku 4.5 on October 4. So the press-attribution leak that blocked graduation is model-dependent: current frontier models don't show it on this corpus. None of them meets the per-kind bars either (fact and bet precision stay under 0.80 for every model), but those numbers are provisional: gbrain says its labels are incomplete, so the graduation verdict waits for a free re-score once gbrain finishes them.

Status: **Complete** (4 of 4 arms, 123 of 123 cases each). Evidence class: **development evidence**. Preregistration: [2026-10-06-takes-bootstrap-frontier-preregistration.md](2026-10-06-takes-bootstrap-frontier-preregistration.md), pushed before the first classifier call (`17f36a1`).

**Model rule, 2026-10-07.** Claude Opus 5.5 is the top Anthropic model in counted results; Claude Fable 5.1 is smoke-only. The Fable rows below were run before that rule, are kept as recorded and labeled smoke-only, and count toward no decision ([amendment](2026-10-06-takes-bootstrap-frontier-preregistration.md#2026-10-07-fable-51-is-smoke-only)).

## What takes-bootstrap does

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents. Its optional takes-bootstrap job reads a person's briefing and writing pages with a chat model and records the claims it finds as typed rows: a **fact**, a **take** (an opinion the page holder holds), a **bet** (a prediction with stakes) or a **hunch**. gbrain runs it only when an operator asks (`manual_only`), and its rule (gbrain `TODOS.md` TODO-E) keeps it there until a live run of its eval "graduates": per-kind precision at least 0.80 and recall at least 0.70, no unparseable output, and no forbidden attribution.

A forbidden attribution is the failure that matters most. A typical trap page (invented example in the corpus's style) says "The press called Widget Co the clear winner; I'm not convinced." Recording "Widget Co is the clear winner" as the holder's take puts words in their mouth. The corpus's forbid patterns catch exactly that.

## The experiment

- **Corpus and scorer.** gbrain's `evals/takes-bootstrap/`: 41 hand-written archetypes in 3 label-invariant variants (123 pages), 18 of them with forbid patterns; scorer version 1. Each page goes through gbrain's real extraction path (`extractTakesFromPages`) on a throwaway brain, with the extractor's own prompt and 2,000-token output limit, provider-default temperature, and gbrain's gateway defaults for reasoning.
- **Arms.** One per model, run in this order: `anthropic:claude-sonnet-5-5`, `openai:gpt-6.1-sol`, `anthropic:claude-opus-5-5`, `anthropic:claude-fable-5-1`. Claude Haiku 4.5 was not rerun; it links by its published counts (its predictions were never committed, so no paired comparison is possible).
- **Harness overlay.** gbrain's price table at the pin stops at `gpt-5.6`, and the harness refuses a model it can't price. A documented overlay ([`harness-overlay.mjs`](../../eval/runner/takes-bootstrap/harness-overlay.mjs), [diff against upstream](../../eval/runner/takes-bootstrap/harness-overlay.diff)) accepts `--price-input` / `--price-output` and loads them into the harness's budget tracker, and adds a spend summary and an observe-only request log. Nothing in the extraction path changes. GPT-6.1 Sol ran at the ledger's list price ($2 in / $10 out per million tokens); the Claude models used gbrain's own table. Before the run, a 16-token call through gbrain's gateway confirmed it accepts `openai:gpt-6.1-sol` and `openai:gpt-6-luna` ([route check](2026-10-06-takes-bootstrap-frontier/route-check.json)).
- **Build check.** The runner compared every file under gbrain's `src/` and `evals/takes-bootstrap/` (2,435 files) with `git ls-tree c5fb0201` before running: no differences.

## Results

Label-independent verdict (the preregistered decision), 123 cases per model:

| Model | Forbidden attributions | Malformed cases | Passes the check | 95% upper bound, cases with a forbid violation (of 18) |
|---|---:|---:|---|---:|
| Claude Sonnet 5.5 | 0 | 0 | yes | 18.5% |
| GPT-6.1 Sol | 0 | 0 | yes | 18.5% |
| Claude Opus 5.5 | 0 | 0 | yes | 18.5% |
| Claude Fable 5.1 (smoke-only, not counted) | 0 | 0 | yes | 18.5% |
| *Claude Haiku 4.5 (Oct 4, published counts)* | *3* | *0* | *no* | |

The upper bounds are exact Clopper-Pearson: 0 of 18 trap cases rules out a high leak rate, not a low one. With 0 malformed of 123, the malformed rate's upper bound is 2.95% for each model.

Per-kind precision and recall, **provisional** (incomplete labels push precision down; bar: precision 0.80, recall 0.70):

| Model | Fact P / R | Take P / R | Bet P / R | Hunch P / R | Pages fully right (of 123) | Graduates (provisional) |
|---|---|---|---|---|---:|---|
| Claude Sonnet 5.5 | 0.615 / 0.833 | 0.818 / 1.000 | 0.576 / 0.792 | 0.850 / 0.944 | 72 | no |
| GPT-6.1 Sol | 0.714 / 0.857 | 0.913 / 0.909 | 0.667 / 0.833 | 0.619 / 0.722 | 82 | no |
| Claude Opus 5.5 | 0.616 / 0.857 | 0.746 / 0.970 | 0.514 / 0.750 | 0.611 / 0.611 | 69 | no |
| Claude Fable 5.1 (smoke-only, not counted) | 0.614 / 0.857 | 0.837 / 0.939 | 0.515 / 0.708 | 0.316 / 0.333 | 68 | no |
| *Claude Haiku 4.5 (Oct 4)* | *0.714 / 0.762* | *0.894 / 0.970* | *0.545 / 0.750* | *0.750 / 0.667* | *75* | *no* |

Every model misses the fact and bet precision bars. GPT-6.1 Sol has the most pages fully right (82). Fable 5.1 rarely labels anything a hunch (6 of 18 found), which is a typing choice the incomplete labels may or may not explain. Bigger models did not do better here: Opus and Fable got fewer pages fully right than Sonnet and GPT.

Run facts per arm (from the request log): 123 provider requests each, 0 non-2xx responses, 0 retried cases, 0 output-limit finishes.

| Model | Spend | Hard cap | Wall time |
|---|---:|---:|---:|
| Claude Sonnet 5.5 | $0.225 | $0.80 | 3.4 min |
| GPT-6.1 Sol | $0.174 | $0.80 | 6.9 min |
| Claude Opus 5.5 | $0.583 | $1.40 | 5.4 min |
| Claude Fable 5.1 (smoke-only, not counted) | $1.538 | $5.01 | 10.6 min |

The tracker's spend matches the provider-reported tokens in the request log at list price (for example Sonnet: 55,472 input and 11,364 output tokens, $0.2246).

## What to use and what to avoid

- **The forbidden-attribution blocker is not a property of the feature.** On current frontier models it did not occur in 18 trap cases. If gbrain's graduation re-score also clears the per-kind bars, a current frontier model is the one to graduate on; Haiku 4.5 should not be.
- **Keep takes-bootstrap `manual_only` for now.** Facts and bets are still often typed or bounded wrongly for every model, and the per-kind table can't be trusted until the labels are complete.
- **Bigger is not better on this task.** GPT-6.1 Sol and Sonnet 5.5 were the cheapest and among the best; Fable 5.1 cost 7 times Sonnet and got fewer pages right.

Limits: one run per model at provider-default temperature, a hand-written corpus around known failure classes, and labels gbrain itself calls incomplete. gbrain's product default chat model at the pin is `claude-sonnet-4-6`, not any model here, so these numbers describe the four named models.

## gbrain issue draft (not filed)

> **Title:** Add GPT-6 prices to the built-in model price table
>
> gbrain's price table (`src/core/model-pricing.ts`) stops at `gpt-5.6`, so `canonicalLookup('openai:gpt-6.1-sol')` and `canonicalLookup('openai:gpt-6-luna')` return nothing at v0.60.95.0 (`c5fb0201`). gbrain's gateway routes both ids fine (a 16-token `chat()` call to each succeeded on 2026-10-06), but anything that prices from the built-in table refuses them: `evals/takes-bootstrap/harness.mjs` exits 2 ("has no canonical price"), and `gbrain pricing set` cannot help there because the harness checks the built-in table on a fresh in-memory brain that never reads the config plane.
>
> Please add rows for the GPT-6 family. List prices as recorded in gbrain-evals' ledger (`eval/runner/budget-ledger.ts`, checked 2026-10-06): `gpt-6.1-sol` $2 in / $10 out per 1M tokens (cache read $0.10), `gpt-6-sol` $2 / $10, `gpt-6-luna` $0.10 / $0.50, `gpt-6-astra` $10 / $50. Optionally, let the takes-bootstrap harness honor `pricing.overrides` or take price flags, as the gbrain-evals overlay does (`eval/runner/takes-bootstrap/harness-overlay.diff`).
>
> Per gbrain's agent-operator rule, an unpriced model should warn and run under a default cap rather than exit; under an explicit `--max-usd` it can block, but the message should say which rate to register and how.

## Reproduce and inspect

Keyless, $0, re-score every committed predictions file with gbrain's scorer (prints the label-independent verdict and the provisional per-kind table):

```bash
bun eval/runner/takes-bootstrap-frontier.ts rescore --dir docs/benchmarks/2026-10-06-takes-bootstrap-frontier
```

Expected: 0 malformed and 0 forbid violations for all four models; variants passed 72, 82, 69 and 68. gbrain's own replay gives the same per-model report, for example `bun eval/runner/takes-bootstrap/harness-overlay.mjs --replay docs/benchmarks/2026-10-06-takes-bootstrap-frontier/predictions-gpt-6.1-sol.jsonl`. When gbrain completes its archetype labels, run the same commands against the updated corpus (a newer `--gbrain-dir`) for the graduation verdict.

Live rerun (needs `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`; about 26 minutes; $2.52 in this run):

```bash
bun eval/runner/takes-bootstrap-frontier.ts run --preregistration docs/benchmarks/2026-10-06-takes-bootstrap-frontier-preregistration.md \
  --out-dir <dir> --caps anthropic:claude-sonnet-5-5=0.8,openai:gpt-6.1-sol=0.8,anthropic:claude-opus-5-5=1.4,anthropic:claude-fable-5-1=rest \
  --min-caps anthropic:claude-fable-5-1=2.5 --budget-ledger <ledger> --budget-usd 6
```

Spend: $2.520 for the four arms (ledger run `w4-takes-bootstrap-frontier-2026-10-06T18-13-11-439Z-314f842e`; each arm reserved its whole cap and settled to the harness's reported spend), plus $0.0046 for a 3-case smoke ([`smoke/`](2026-10-06-takes-bootstrap-frontier/smoke/), not scored) and $0.0001 for the route check: $2.525 against a $4.20 estimate and a $6 cap. Artifacts in [`2026-10-06-takes-bootstrap-frontier/`](2026-10-06-takes-bootstrap-frontier/): `receipt.json` (preregistration attestation, gbrain tree check, per-arm caps, spend, request stats, verdicts), and per model `predictions-*.jsonl`, `report-*.json` (gbrain's scorer output), `summary-*.json`, `requests-*.jsonl` and `stderr-*.log`; `rescore.json`; `ledger-status.json`.
