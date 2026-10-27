# Cell ledger for the memory proof wave, rebuilt from measured usage

Measured October 5, 2026. The plan approved a $2,500 cap and asked that the paid acceptance cells rebuild its eight purchase lines from measured usage, and that the plan come back for approval if the rebuilt total exceeds the cap.

**Result: as planned on October 5, the work cost about $2,720, $220 over the cap. With line 7 dropped and LongMemEval-M removed from line 8 on October 6, the rebuilt total is about $2,451.** The overrun is almost all in line 4: the B-suite frontier sweep sends 25% of 76M reader input tokens to three models priced at up to $10 per million input tokens. Sweeping 10% of questions instead of 25% brings the total to about $2,421, inside the cap with $79 to spare. That is a decision for the plan owner; nothing broad runs until it is made.

## Lines

| Line | What | Plan estimate | Rebuilt from measured usage |
|---|---|---:|---:|
| 1 | A0 smoke and the primary comparison (BEAM 500k + 1M) | $500 | $153 |
| 2 | Secondary datasets and matched public benchmarks | $350 | $315 |
| 3 | Dev sweeps, lanes, agent modes, fallback-model overlap | $300 | $589 |
| 4 | B suites and B5 | $200 | $719 |
| 5 | Fix-lane validation reruns | $100 | $27 |
| 6 | Full coding-agent benchmark run | $400 | $400 |
| 7 | BEAM 10M, both systems: dropped October 6 (reserved as another campaign's held-out set; never opened, ingested or answered here) | $350 | — |
| 8 | Extra frontier points on sealed (LongMemEval-M dropped: the harness pin does not load it) | $200 | $144 |
| 9 | Reserve | $100 | $100 |
| | Already spent in this lane (acceptance cells, reader probes, re-judges) | | $4.16 |
| | **Total** | **$2,500** | **$2,451** |

The primary comparison is cheaper than planned ($153 against $500) because BEAM answers and rubric judging use Gemini Flash models at $0.75 and $1.50 per million input tokens, and the comparator's extraction model is the inexpensive gpt-4o-mini. Lines 3 and 4 grew: line 3 now prices gbrain's facts-lane extraction over all of LongMemEval-S (57M document tokens), and line 4 prices the B suites' actual 76M-token reader volume.

## How each figure is built

Each item is questions x systems x delivered-context targets x readers, plus one ingest per system, at list prices from `eval/runner/budget-ledger.ts`. Question, document-token and judge-call counts per dataset split come from `inputs.json` (computed free with `python -m mpw.ledger_inputs`). The plan items are in `plan.json`; `bun eval/runner/harness-ledger.ts` prices them.

| Line | Item | Dollars | Biggest parts |
|---|---|---:|---|
| 1 | Primary: BEAM 500k + 1M validation and sealed (56 of 70 conversations), both systems, 8k target | $125.5 | ingest comparator extraction $58.4; answer gemini:gemini-3.8-flash $35.2; judge gemini:gemini-3.5-flash $27.7 |
| 1 | Primary: joint blinded re-judge of both systems | $27.7 | judge gemini:gemini-3.5-flash $27.7 |
| 2 | Secondary: PersonaMem 32k, LifeBench, LongMemEval-S, LoCoMo10, both systems, 8k target | $282.5 | answer gemini:gemini-3.8-flash $150.2; ingest comparator extraction $93.6; judge gemini:gemini-3.5-flash $32.0 |
| 2 | Secondary: joint re-judge | $32.0 | judge gemini:gemini-3.5-flash $32.0 |
| 3 | Dev sweep: BEAM dev conversations, targets 4k/8k/16k/32k and a 24k stand-in for each system's default | $117.1 | answer gemini:gemini-3.8-flash $66.8; judge gemini:gemini-3.5-flash $34.6; ingest comparator extraction $14.6 |
| 3 | Lanes: gbrain facts extraction (facts-only and combined) on LongMemEval-S, LoCoMo10 and BEAM dev; extraction priced at the comparator's measured rate (assumed) | $195.6 | ingest gbrain extraction $91.1; answer gemini:gemini-3.8-flash $75.0; judge gemini:gemini-3.5-flash $23.1 |
| 3 | Lanes: comparator facts-only and raw-only retrieval on the same stores | $98.1 | answer gemini:gemini-3.8-flash $75.0; judge gemini:gemini-3.5-flash $23.1 |
| 3 | Agent modes: agentic-rag (about 4 answer calls per question, assumed) on dev slices of LongMemEval-S, LoCoMo10, LifeBench | $111.3 | answer gemini:gemini-3.8-flash $104.9; judge gemini:gemini-3.5-flash $6.4 |
| 3 | Agent modes: agent (each system's own synthesis, one call per question at the 8k rate, assumed) | $42.7 | answer openai:gpt-6.1-sol $36.3; judge gemini:gemini-3.5-flash $6.4 |
| 3 | Fallback answer model overlap on BEAM validation (newest Sonnet) | $24.5 | answer anthropic:claude-sonnet-5-5 $17.6; judge gemini:gemini-3.5-flash $6.9 |
| 4 | B1-B4 fixed reader (newest Sonnet): 76M reader input tokens at 8k from the suites' dry runs; 150 output tokens per answer (assumed, cap 400) | $166.2 | answer anthropic:claude-sonnet-5-5 $166.2 |
| 4 | B1-B4 frontier sweep: 25% of questions across Opus, GPT, Fable | $498.8 | answer openai:gpt-6-astra $207.8; answer anthropic:claude-fable-5-1 $207.8; answer anthropic:claude-opus-5-5 $83.1 |
| 4 | B ingest: extraction for the comparator and gbrain facts lanes over an assumed 5M document tokens per system (lane 3 to confirm) | $14.0 | fixed $14.0 |
| 4 | B5 pinned-question benefit gate (not measured here; plan figure share) | $40.0 | fixed $40.0 |
| 5 | Fix lane: three gbrain rounds re-ingested and answered on BEAM validation | $26.7 | answer gemini:gemini-3.8-flash $13.2; judge gemini:gemini-3.5-flash $10.4; ingest gbrain embeddings $3.1 |
| 6 | Coding-agent memory benchmark, full run (not measured here; plan figure) | $400.0 | fixed $400.0 |
| 8 | Two extra frontier targets on sealed BEAM (16k, 32k), stores reused | $144.2 | answer gemini:gemini-3.8-flash $102.6; judge gemini:gemini-3.5-flash $41.6 |
| 9 | Reserve | $100.0 | fixed $100.0 |

## Measured rates

Five paid cells on the same ten BEAM 100k questions (the acceptance pair on gbrain `e8e1f66`, plus three reader probes) (the first conversation), all through the metering proxy, produced these rates. Their receipts are in [docs/benchmarks/2026-10-05-harness-acceptance/](../../docs/benchmarks/2026-10-05-harness-acceptance/).

| Rate | Value | Source |
|---|---|---|
| Answer input tokens per cl100k prompt token, gemini-3.8-flash | 1.23 | gbrain BEAM cell |
| Same, claude-sonnet-5-5 and claude-opus-5-5 | 1.66 | reader probe cells (includes the structured-output tool schema) |
| Same, gpt-6.1-sol | 1.01 | reader probe cell |
| Answer output tokens per answer: gemini-3.8-flash / sonnet-5-5 / opus-5-5 / gpt-6.1-sol | 2152 / 390 / 535 / 466 | measured (Gemini's count includes thinking tokens) |
| BEAM rubric judge call (gemini-3.5-flash), input / output tokens | 745 / 316 | measured |
| gbrain embedding tokens (voyage-4) per cl100k document token | 1.59 | measured, includes query embeddings |
| Comparator extraction (gpt-4o-mini) input / output tokens per cl100k document token | 6.14 / 0.70 | measured; one call per 3,000-character chunk with a fixed 2.8k-token system prompt |

## What is assumed, not measured

- **The answer model for the A cells.** The preregistration has not frozen it. The ledger uses `gemini-3.8-flash`, which the acceptance cells measured. With the newest Sonnet as the A reader the total is about $3,483; with Opus 5.5 about $4,976; with gpt-6.1-sol about $3,014 (`alternatives` in `ledger.json`).
- **gbrain's facts-lane extraction** is priced at the comparator's measured extraction rate. gbrain's opt-in extraction has not been measured on these datasets.
- **gpt-6-astra and claude-fable-5-1 output tokens** (1,200 per answer) and **Fable's input ratio** (1.25) are assumptions; neither model ran in this lane. Fable's price ($10 / $50) is the row being added in gbrain-evals#65.
- **agentic-rag** is priced at four answer calls per question, and **agent** mode at one call at the 8k rate.
- **B-suite reader output** is 150 tokens per answer (the reader is capped at 400). B-suite ingest assumes 5M document tokens per system.
- **Fixed plan figures** stand where this lane measured nothing: the coding-agent run ($400), the B5 benefit gate ($40), LongMemEval-M ($100, not loaded by the pinned harness) and the reserve ($100).
- **Prices change.** Gemini 3.6 to 3.8 Flash are at a promotional $0.75 / $3.75 until January 1, 2027, then $1.50 / $7.50.

## Levers

| Change | Total |
|---|---:|
| As planned (25% frontier sweep, 8k target) | $2,720 |
| Frontier sweep on 10% of B questions | $2,421 |
| Primary and secondary targets at 16k instead of 8k | $2,976 |
| Judge sealed and secondary cells once, in the joint re-judge only (skip the inline judge) | about $60 less |

## Reproduce

```sh
bun eval/runner/harness-ledger.ts --plan eval/harness-provider/ledger/plan.json \
  --inputs eval/harness-provider/ledger/inputs.json \
  --cells-dir docs/benchmarks/2026-10-05-harness-acceptance \
  --out eval/harness-provider/ledger/ledger.json
```
