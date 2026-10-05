# gbrain facts lanes on the dev slices (interim, 2026-10-05)

Interim. LongMemEval-S cells are still running and this note will be updated when they finish. Raw-lane cells for the same slices run in the parent lane and are not repeated here.

gbrain build e8e1f66b8 (copied overlay). Answer model gemini:gemini-3.8-flash. Judge gemini:gemini-3.5-flash (BEAM's forced judge). Extraction model openai:gpt-6-luna. Delivered context is counted with cl100k_base on the text inserted into the final prompt. Receipts are in [cells/](cells/) (summary, cell, spec, spend, tuning, and `questions.jsonl` with per-question outcome, score, delivered tokens and fact tokens). Extraction receipts per memory unit are in [facts-lanes/stores/](facts-lanes/stores/), the per-slice extraction totals are in [facts-lanes/extraction.json](facts-lanes/extraction.json), and the dev driver logs are in [facts-lanes/tracks/](facts-lanes/tracks/).

## Lane definitions

- **raw** is today's provider: `query` with `token_budget` and `return_unit: page`.
- **facts** is facts only. Each question gets its `saved_facts` from `query` (at most five facts that match at least three quarters of the question's words), then `recall`'s facts (at most 100, newest first, not ranked by the question). These are packed one line per fact under their source page's date header, and pages are dropped.
- **combined** is the facts block packed to `facts_tokens`, followed by the raw page query with `token_budget`. Query expansion is off (`expand: false`) so the page arm matches the raw lane, which has no chat key and never expands.
- **Extraction.** gbrain's automatic extraction never runs on these pages. The put_page backstop and its drain skip `type: conversation`, and the conversation extractor (`extract-conversation-facts`, the opt-in cycle phase) parses no messages from `role: text` transcripts. So ingest calls gbrain's explicit `extract_facts` op once per window of whole turns that fits its 8,000-character input, with `visibility: "world"` (stdio MCP is a remote caller and reads world facts only). Every extraction request goes through the metering proxy under label gbrain.

## Results

The delivered-token gate passes when the mean and p95 are both within ±10% of the target. Facts-only cells have no target (`default`): gbrain's fact retrieval cannot deliver 8,000 tokens. Auto-tune on BEAM 100k unit 3 measured a mean of 1,796 at `facts_tokens` 8000, so these cells run at gbrain's ceiling and are not delivered-token matched.

| Cell | Slice | Lane | Knobs | Delivered mean / p95 | Correct / scheduled | Accuracy | Mean score | Gates | Cost |
|---|---|---|---|---|---|---|---|---|---|
| `beam-100k-gbrain-rag-091fa4bdc37f` | BEAM 100k (4 conv) | combined | facts 1800, pages 6300 | 7,927 / 8,071 | 57 / 80 | 0.713 | 0.647 | pass | $2.30 |
| `beam-100k-gbrain-rag-88ccfaf52605` | BEAM 100k | combined | facts 600, pages 7500 | 8,078 / 8,125 | 58 / 80 | 0.725 | 0.664 | pass | $2.36 |
| `beam-100k-gbrain-rag-6076391483b1` | BEAM 100k | facts | ceiling | 1,678 / 1,794 | 32 / 80 | 0.400 | 0.373 | no target | $1.73 |
| `beam-500k-gbrain-rag-5e6f48723881` | BEAM 500k (7 conv) | combined | facts 1800, pages 6300 | 7,912 / 8,191 | 100 / 140 | 0.714 | 0.641 | pass | $5.35 |
| `beam-500k-gbrain-rag-e0c8684af630` | BEAM 500k | facts | ceiling | 1,677 / 2,077 | 53 / 140 | 0.379 | 0.345 | no target | $2.95 |
| `beam-1m-gbrain-rag-a418fcfae976` | BEAM 1m (7 conv) | combined | facts 1800, pages 6300 | 7,954 / 8,249 | 97 / 140 | 0.693 | 0.640 | pass | $4.90 |
| `beam-1m-gbrain-rag-6fd67a9e9a1a` | BEAM 1m | facts | ceiling | 1,708 / 2,042 | 36 / 140 | 0.257 | 0.248 | no target | $3.42 |
| `locomo-locomo10-gbrain-rag-7875d00f3b75` | LoCoMo10 (conv-44, conv-42) | combined | facts 1800, pages 6300 | 8,036 / 8,136 | 291 / 322 | 0.904 | 0.904 | pass | $4.54 |
| `locomo-locomo10-gbrain-rag-15da9e907a79` | LoCoMo10 | facts | ceiling | 1,744 / 1,819 | 137 / 322 | 0.425 | 0.425 | no target | $2.82 |

Every denominator is the full scheduled set. BEAM accuracy counts a question as correct when its graded score is at least 0.5, and the mean score is the rubric-graded mean.

Superseded LoCoMo cells, kept for the split comparison: `locomo-locomo10-gbrain-rag-146f654a74a2` (facts 1793, pages 6275, 285/322) and `locomo-locomo10-gbrain-rag-9c77c271d7b8` (facts 585, pages 7316, 284/322). They ran before the provider kept image-intent queries: 8 rows were retrieval failures when gbrain reported `vector_arm_failed` for a photo question on a text-only voyage-4 brain, so they fail `no_answer_or_retrieval_failures`.

**Split.** The facts and page split for combined was tuned on BEAM 100k and LoCoMo: facts 1800 scored 57/80 and 285/322, and facts 600 scored 58/80 and 284/322. The two are tied. The remaining slices use facts 1800, which is all of `recall`'s 100 facts (about 1.5k to 1.6k tokens), because that is the setting where the facts lane actually contributes. More facts tokens cannot help: `recall` caps at 100 facts.

**Wrapper revisions.** The BEAM 100k cells and the BEAM 500k combined cell ran on wrapper revision `4f465aaba5c3`; the others ran on `b7d4b3475c90`, after merging the harness branch's degraded-stage policy. The changes between the two touch only rows with a degraded stage, a date-header switch that stays on, and locking. No BEAM row had a degraded stage.

## Extraction cost

Extraction runs once per slice. Its share of each slice is below. It is a one-time ingest cost, not a per-question cost.

| Slice | Units | Document tokens | Calls | Input / output tokens | Chat $ | Chat $ per 1M doc tokens | Calls per 1k doc tokens | Facts written | Embeddings $ (pages and facts) |
|---|---|---|---|---|---|---|---|---|---|
| BEAM 100k | 4 | 579,786 | 365 | 927k / 239k | $0.21 | $0.37 | 0.63 | 1,388 | $0.05 |
| BEAM 500k | 7 | 3,576,673 | 1,985 | 5.46M / 1.10M | $1.09 | $0.30 | 0.56 | 5,550 | $0.25 |
| BEAM 1m | 7 | 7,786,917 | 4,627 | 12.2M / 2.04M | $2.24 | $0.29 | 0.59 | 9,357 | $0.57 |
| LoCoMo10 | 2 | 99,092 | 64 | 157k / 54k | $0.04 | $0.43 | 0.65 | 520 | $0.01 |
| LongMemEval-S | 99 of 100 | 11,326,071 | 8,913 | 18.7M / 4.24M | $3.94 | $0.35 | 0.79 | 30,340 | $0.75 |

No extraction window failed after one retry. LongMemEval counts include one interrupted unit that was re-extracted after the repeated-session fix. One LongMemEval history (`gpt4_468eb063`) does not ingest at all: its `put_pages` batch stays `pending` past the 900-second barrier, and gbrain serve logs repeated `[persistence] phase=preparation reason=deadline_exceeded`. This happens on two attempts, while every embedding request succeeds and no chat request is made. Its question is an incomplete-ingest row in the LongMemEval cells.

## Spend

Ledger `.budget/mpw-dev-facts.sqlite`, cap $120: $54.85 committed, $65.15 remaining, 83,976 metered requests (status at the time of this note).
