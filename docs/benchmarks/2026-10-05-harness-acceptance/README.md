# Paid acceptance cells for the agent-memory harness wrapper

October 5, 2026. These cells check that the audited harness path works end to end with real models, and they measure per-stage usage for the [rebuilt cell ledger](../../../eval/harness-provider/LEDGER.md). They are not a comparison of gbrain and the comparator: ten questions from one conversation cannot separate two systems, and these numbers must not be quoted as one.

## What ran

Every cell asks the same ten BEAM 100k questions (the first ten of conversation 1: two each of abstention, contradiction resolution, event ordering, information extraction and instruction following). BEAM gives each question a rubric; its judge, which the harness fixes to `gemini-3.5-flash`, scores each rubric item 0, 0.5 or 1, and a question's score is the mean over its items. The delivered-context target is 8,000 cl100k tokens for every cell.

- **gbrain**, raw lane: one PGLite brain for the conversation, pages written through stdio MCP with `voyage-4` embeddings, retrieved with `query` at `token_budget` 8,100 and `return_unit: page`. No LLM runs on write. gbrain at the pinned dependency (0.60.46.0).
- **The comparator**, its best supported mode (extracted facts plus raw chunks): the pinned current server release (0.10.2) in its own environment, extracting facts with its documented default model (`gpt-4o-mini`), local CPU embeddings and reranker.

All model traffic went through the metering proxy against one ledger capped at $40 for this lane.

## Results

| Cell | System | Answer model | Knobs | Delivered tokens, mean / p95 | Mean rubric score | Cost |
|---|---|---|---|---|---:|---:|
| `beam-100k-gbrain-rag-48a25f23a91b` | gbrain | gemini-3.8-flash | token_budget 8,100 | 7,936 / 7,970 | 0.71 | $0.34 |
| `beam-100k-comparator-rag-b1bc1d8eee25` | comparator | gemini-3.8-flash | facts 3,500, chunks 2,000 | 8,099 / 8,495 | 0.81 | $0.42 |
| `beam-100k-comparator-rag-894be477adbb` | comparator | gemini-3.8-flash | facts 4,000, chunks 4,000 | 10,752 / 11,426 | 0.85 | $0.44 |
| `beam-100k-gbrain-rag-f83eab84169e` | gbrain | gpt-6.1-sol | token_budget 8,100 | 7,936 / 7,970 | 0.64 | $0.34 |
| `beam-100k-gbrain-rag-5bf8aeae392b` | gbrain | claude-sonnet-5-5 | token_budget 8,100 | 7,936 / 7,969 | 0.45 | $0.39 |
| `beam-100k-gbrain-rag-a9d78f4f21df` | gbrain | claude-opus-5-5 | token_budget 8,100 | 7,936 / 7,969 | 0.47 | $0.73 |

The first two rows are the acceptance pair. Both pass every gate: all ten questions have a typed outcome, no answer or retrieval failed, delivered tokens are within 10% of the target on mean and p95, and gbrain's remote budget clamp did not fire. A joint blinded re-judge of the pair (`rejudge/`) called the dataset's own judge on both cells' answers in one shuffled pass and reproduced the scores above.

The third row is the comparator at the first knob setting tried. It delivered 10,752 tokens on average and failed the context gate, so the scores of rows 2 and 3 are not comparable. A retrieval-only sweep on that cell (`tuning/`, no answer or judge calls) chose the knobs used in row 2.

The last three rows rerun the gbrain cell with other answer models to measure each reader's token usage for the ledger. The two Claude models declined to answer the same four of the ten questions (`stop_reason: refusal`); those runs predate the change that scores a refusal as an answer, so they record four answer failures each and fail the failure gate.

## What we learned

- **Rerun variance is visible at ten questions.** An earlier run of the same gbrain configuration on older wrapper code scored 0.60; this one scored 0.71. The answer model runs at temperature 0 and still varies.
- **The comparator's default knobs overshoot the target.** Its facts and chunk budgets count only part of what reaches the prompt; at 4,000 + 4,000 it delivered 34% more than 8,000 tokens. Knobs have to be tuned per target on dev before any comparison cell.
- **Ingest completes later than writes return.** gbrain's embeddings landed 14 seconds after the last `put_page` returned, and the comparator's extraction queue took 45 seconds to drain for six documents. The completion barrier waited in both cases before the first question.
- **The comparator's recall takes about 19 seconds per question on CPU** during the knob sweep (local reranker on four vCPUs).
- **Gemini 3.8 Flash spends about 2,200 output tokens per answer** (thinking included), against 390 to 540 for the Claude models and 470 for gpt-6.1-sol.

## Reproduce

```sh
bun run harness:setup
bun run harness:comparator install
bun eval/runner/budget-ledger.ts init --budget-ledger .budget/lane.sqlite --program-cap-usd 10 --reason "acceptance cells"
export GEMINI_API_KEY=... VOYAGE_API_KEY=... OPENAI_API_KEY=...
bun run harness:cell run eval/harness-provider/cells/acceptance-beam100k-gbrain-rag.json --budget-ledger .budget/lane.sqlite
bun run harness:cell run eval/harness-provider/cells/acceptance-beam100k-comparator-rag.json --budget-ledger .budget/lane.sqlite
bun run harness:cell rejudge <gbrain-cell-id> <comparator-cell-id> --budget-ledger .budget/lane.sqlite
```

The comparator needs `OPENAI_API_KEY` for its extraction model; gbrain needs only `VOYAGE_API_KEY`; the answer and judge models need `GEMINI_API_KEY`. Each run takes two to four minutes. The cell ids differ from the ones above when any code or configuration differs, which is the point of content-addressed cells.

Each cell folder holds `cell.json` (spec, pins, schedule), `summary.json`, `spend.json`, the proxy's request log and, for the acceptance pair, every stage receipt with the final prompts and byte-exact model requests. The reader-probe cells keep only their summaries and request logs.
