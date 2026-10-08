# Code search on questions that don't name the function: Voyage code-3 and OpenAI tie, Voyage code-4 trails

**Finding.** When a question describes what code does instead of naming the function, gbrain finds the right source file with Voyage `voyage-code-3` and OpenAI `text-embedding-3-large` about equally well, and noticeably less well with Voyage `voyage-code-4`. On October 6, 2026, at gbrain `c5fb0201` (v0.60.95.0), over 24 behavior questions on a 60-file slice of gbrain's own source, mean reciprocal rank (MRR) was 0.927 for `voyage-code-3`, 0.906 for `text-embedding-3-large` and 0.751 for `voyage-code-4`. `voyage-code-4` was lower than each of the other two by about 0.16 to 0.18 (Holm-adjusted p = 0.047 for both comparisons). `voyage-code-3` and `text-embedding-3-large` differed by 0.021, with a 95% interval of −0.062 to 0, inside the preregistered 0.10 tie margin. So this run gives no evidence that a code-tuned embedder beats the general OpenAI model, and `voyage-code-4` should not be recommended for code search on this evidence.

Status: **Complete** (3 of 3 cells valid, 36 of 36 questions scored per cell). Evidence class: **development evidence**; the questions were written by an agent who knew the answer files. Preregistration: [2026-10-06-cat21-paraphrase-preregistration.md](2026-10-06-cat21-paraphrase-preregistration.md), committed and pushed before the run (`594bd14`).

## The concrete case

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents. It indexes notes, and here source files, for search that combines keyword matching with vector similarity from an embedding model. An embedding model turns text into a vector so that similar meanings land close together; a code-tuned one is trained on source code.

Cat 21 asks gbrain to find a source file. Until now its 12 questions all named the symbol ("hybridSearch function"), so keyword search alone found the file and both embedders scored 12 of 12 on [October 2](2026-10-02-may-snapshot-reruns.md). The new questions describe behavior instead. For example, for the file defining `hybridSearch`:

> Which function merges keyword and vector result lists with reciprocal rank fusion, then boosts compiled truth and re-scores by cosine similarity?

The system has to match that description to the code, which the keyword arm can only partly do.

## The experiment

- **Corpus.** 60 TypeScript files from gbrain's `src/core` at `c5fb0201`: the 12 files the original questions point to, plus 48 distractors chosen by a fixed hash order (from 1,761 files at this pin, so the distractors differ from the October 2 run at an older pin). Each body is cut at 36,000 characters and stored as a Markdown code block. Each cell builds a fresh in-memory brain.
- **Questions.** The 24 frozen behavior questions in [`eval/data/cat21-paraphrase-v1/`](../../eval/data/cat21-paraphrase-v1/) (two per gold file; none uses the symbol's name or the file name), plus the 12 original named questions as a regression split. Both splits ran against the same index in one run.
- **Arms.** Three embedders, everything else identical: `voyage-code-3` (1,024 dimensions), `voyage-code-4` (1,024) and `text-embedding-3-large` (1,536). Search pinned to `balanced` mode with the reranker, query expansion and autocut off; the runner checked on every query that the reranker never fired and the vector arm never degraded to keyword-only.
- **Metric.** MRR of the gold file among the deduplicated pages of the top 30 results (1 for first place, 1/2 for second, 0 if absent), recall at 5 and first-place hits. Comparisons pair the same question across embedders and cluster by gold file (12 clusters), with an exact sign-flip test over files, a cluster-bootstrap interval, and Holm's correction across the three pairs.

## Results

Retrieval from gbrain `c5fb0201`, October 6, 2026. Paraphrase split: 24 questions per cell.

| Embedder | Paraphrase MRR | First place (of 24) | Recall at 5 | Named split MRR (of 12) | Mean query time | Status |
|---|---:|---:|---:|---:|---:|---|
| `text-embedding-3-large` (OpenAI) | 0.906 | 20 | 24/24 | 1.000 | 385 ms | Complete |
| `voyage-code-3` | **0.927** | 21 | 24/24 | 0.958 | 286 ms | Complete |
| `voyage-code-4` | 0.751 | 15 | 22/24 | 0.958 | 272 ms | Complete |

Paired differences on the paraphrase split (B minus A):

| A | B | MRR difference | 95% interval | p (exact) | p (Holm) | Reading |
|---|---|---:|---|---:|---:|---|
| `voyage-code-3` | `text-embedding-3-large` | −0.021 | −0.062 to 0 | 1.00 | 1.00 | tied: interval inside ±0.10 |
| `voyage-code-3` | `voyage-code-4` | −0.176 | −0.278 to −0.082 | 0.016 | 0.047 | `voyage-code-4` lower |
| `voyage-code-4` | `text-embedding-3-large` | +0.155 | +0.073 to +0.240 | 0.016 | 0.047 | `voyage-code-4` lower |

Recall at 5 is at the ceiling (24 of 24 for two embedders, 22 of 24 for `voyage-code-4`), so it cannot separate them; its differences are not significant. The named split stays at its ceiling (11 or 12 of 12 first place), as on October 2, and every cell passes its existing regression gate (MRR at least 0.5).

Where the embedders differed: 9 of 24 paraphrase questions were not first place for every embedder. `voyage-code-4` ranked the gold file lower than the others on all 9, most clearly on the embedded-Postgres question (rank 11 against 2 and 2) and the query-embedding deadline question (rank 15 against 4 and 4). Per-question ranks are in the receipt.

## What to use and what to avoid

- **For code search in gbrain, `text-embedding-3-large` and `voyage-code-3` are equally good choices on this evidence.** The `reindex --code` advice to switch to a Voyage code embedder gets no support from this run: the code-tuned model tied with the general one.
- **Avoid `voyage-code-4` for this workload until it is measured again.** It was the only embedder that missed first place on questions the others got, and it lost to both with a Holm-adjusted p of 0.047. That is a narrow margin on 12 files, so treat it as a warning, not a settled ranking.
- **Cat 21 now uses the paraphrase questions as its main split**, as the preregistration committed to when any pair differed. The named questions stay as a regression check.

Limits: one corpus (60 files of gbrain's own TypeScript), 24 questions written by an agent who had read the gold files, one embedding run per cell, and no reranker. With a reranker on, the gaps may shrink. Questions written without seeing the answers, or a larger code base, would make this stronger.

## Reproduce and inspect

Keyless, $0, from the committed receipt (prints per-split metrics and every paired comparison):

```bash
bun eval/runner/cat21-paired.ts docs/benchmarks/2026-10-06-cat21-paraphrase/receipt.json
```

Expected: paraphrase MRR 0.927 (`voyage-code-3`), 0.751 (`voyage-code-4`), 0.906 (`openai-default`); the two `voyage-code-4` comparisons at p_holm 0.0469. The output committed beside the receipt is [`paired.json`](2026-10-06-cat21-paraphrase/paired.json).

Live rerun (needs `VOYAGE_API_KEY` and `OPENAI_API_KEY`; about 6 minutes; $0.15 in this run):

```bash
bun eval/runner/cat21-code-retrieval.ts --split both --cells voyage-code-3,voyage-code-4,openai-default \
  --budget-ledger <ledger> --budget-usd 2
```

Hermetic plumbing check: `CAT21_SPLIT=both bun eval/runner/cat21-code-retrieval.ts --stub-embed`.

Run facts: gbrain `c5fb0201` (v0.60.95.0) from `node_modules/gbrain`; gbrain-evals runner at `594bd14`; questions sha256 `63f8401d…a9e713`. Spend $0.150 over 298 embedding requests through the round's budget ledger (run `cat21-code-retrieval-2026-10-06T18-17-37-031Z-c49f3993`), against a $0.30 estimate and a $2 cap. Wall time 3.6 minutes; 0 query errors and 0 refusals (the runner does not count provider retries separately). Artifacts: [`receipt.json`](2026-10-06-cat21-paraphrase/receipt.json) (preregistration attestation, per-query ranks and timings, ledger cost), [`paired.json`](2026-10-06-cat21-paraphrase/paired.json), [`run.log`](2026-10-06-cat21-paraphrase/run.log).
