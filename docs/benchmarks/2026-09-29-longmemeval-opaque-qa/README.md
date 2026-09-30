# Receipts: LongMemEval answers with opaque session ids (2026-09-29)

These files support [the report](../2026-09-29-longmemeval-opaque-qa.md). Everything was measured on 2026-09-29 with gbrain `a7cb37b` (PR 5676). `provenance.json` holds the code, dataset and cache identities and the SHA-256 of each executed script.

| File | What it holds |
|---|---|
| `summary.json` | Every arm's counts, tokens, latency, failures and cost; paired gains, losses and exact McNemar p-values; judge agreement; evidence-complete counts. |
| `per_question.csv` | One row per question: type, subset membership, strict retrieval flag, and correctness for every arm under both judges. |
| `a/rows.ndjson` | Arm a (house reader), 500 rows from gbrain's harness plus its schema-v2 summary line. Rows contain answers and the retrieved chunk ids with raw session ids for scoring. |
| `a/official-judge.ndjson` | The verbatim official LongMemEval judge over arm a, with each prompt and raw reply. |
| `a/calls.ndjson.gz` | Every paid call of arm a: reader calls with the full system and user prompt, answer, usage and latency; judge calls with the full prompt and reply; embedding calls with counts and tokens. |
| `b/rows.ndjson.gz` | Arm b (GPT-4o, official reading prompt): prompt, answer, usage, latency, retries, and both judges. |
| `c/chunks.ndjson` | The top-5 chunk texts for the 100-question subset, and whether each list matched arm a (100/100). |
| `c/c1.ndjson`, `c/c2.ndjson`, `c/c3.ndjson` | Component arms: system prompt, user prompt, raw output, answer and both judges. |
| `subset100_seed20260929.txt`, `pilot20.txt` | Question ids for the component subset and the cost pilot. |
| `logs/` | Harness logs for the pilot and the full run, and the watchdog log of the four stalls. |
| `scripts/` | The executed driver, arm and analysis scripts. Only machine-local paths differ from the executed bytes. |
| `reranker-on/` | Added 2026-09-30: runs R1 (notes reader) and R2 (direct 512 reader) with `voyage:rerank-2.5` on the same code, cache and judges. `summary-rerank.json`, `per_question_rerank.csv`, and per run `rows.ndjson`, `official-judge.ndjson` and `calls.ndjson.gz` (every paid call, including Voyage rerank records), plus logs, scripts and `provenance-rerank.json`. |

The LongMemEval data is MIT-licensed. The dataset file and the embedding cache are not committed. Recount the saved results with `python3 scripts/verify-longmemeval-opaque-qa.py` from the repository root.
