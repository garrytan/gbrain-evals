# Relationship retrieval on reworded questions (2026-09-29)

## The finding

gbrain's relationship retrieval helps only when a question uses the wording its parser recognizes. On the 145 world-v1 relationship questions in their original template form ("Who invested in Quasar?"), turning relationship retrieval on raised first-place hits from 27.6% to 42.8% and recall at five from 0.737 to 0.763, over three ingestion orders. When the same questions, with the same answer labels and the same index, were reworded by a fixed paraphrase grammar ("List the investors in Quasar."), relationship retrieval never fired and every metric was identical in both arms: recall at five 0.411, first-place hits 4.8%.

This is a measured limit, not a verdict on the idea. It says the current benefit comes from the parser matching a small set of verbs, and that a reworded question falls back to ordinary hybrid search. Measured on gbrain master `b80cad6` (v0.59.13.0) with the gbrain-evals runner at commit `da02f97`.

**Update, 2026-09-29, after the re-pin to gbrain master `608a174` (v0.60.10.0).** gbrain v0.60.6.0 widened its relationship parser to accept ordinary wording. The keyless check above, rerun at `608a174` with the same runner (hash `7bdda5ec…4cb254a`), now fires relationship retrieval on 33 of 145 paraphrases (10/40 works_at, 15/39 invested_in, 8/16 advises, 0/50 attended), against 0 of 145 at `b80cad6`. Template firing is unchanged at 58 of 145. Firing counts come from the parser, so they carry over to a live run; the recall and first-place numbers in that check come from hash embeddings and are not evidence. The tables above remain the measurement for `b80cad6`. The paid paraphrase run has not been repeated at `608a174`, so how much of the benefit now survives rewording is unmeasured. Receipt: [relational-ab.608a174-stub-smoke.receipt.json](2026-09-29-relational-paraphrase/relational-ab.608a174-stub-smoke.receipt.json).

**Update, 2026-10-01, paid rerun at gbrain `3a284ae` (v0.60.26.0).** The paid run was repeated with the same recipe. The template split is unchanged (recall at five 0.737 to 0.763, first-place hits 27.8% to 42.8%). On the paraphrase split relationship retrieval fired on 99 of 435 runs and raised recall at five from 0.411 to 0.537 and first-place hits from 4.8% to 16.6%, with 19 distinct questions better and none worse. This split is development data. See the [October 1 multi-hop report](2026-10-01-n9-multi-hop.md).

## The concrete case

gbrain stores links between pages, such as "person invested in company". When relationship retrieval is on, the search step tries to read a question as a relationship ("who invested in X"), finds the page for X, and adds the pages linked to it by that relationship. The parser recognizes a fixed list of verbs: "invested in", "backed", "advises", "works at", "attended" and a few others.

The four world-v1 question templates use exactly those verbs, because they were written alongside the parser (audit finding B-RAB-01, issue #24 finding 6). So the September 9 comparison measured an in-grammar upper bound. This check asks how much of the benefit survives ordinary rewording.

## The experiment and results

**Paraphrases.** `eval/generators/relational-paraphrase-gen.ts` holds four frames per template, written as questions a person might ask and not tested against the parser. Each of the 145 questions gets one frame, chosen by a seeded generator (seed 20260929). The output, `eval/data/relational-paraphrase-v1/paraphrases.json` (SHA-256 `29ac7cfd…593b4d`), was committed in `f2270ac` before any scoring run, and the runner refuses a file that differs from the generator. Examples of the frames:

| Template | Original | Paraphrase frames |
|---|---|---|
| attended | Who attended X? | Which people were present at X? / Who was in the room for X? / Who took part in X? / List the participants of X. |
| works_at | Who works at X? | Who is employed by X? / Which people are on the team at X? / List the staff of X. / Who is part of X? |
| invested_in | Who invested in X? | Which investors put money into X? / Who holds a stake in X? / List the investors in X. / Who provided capital to X? |
| advises | Who advises X? | Who serves as an advisor to X? / Which people give advice to X? / Who sits on the advisory board of X? / List the advisors of X. |

**Comparison.** `eval/runner/relational-ab.ts` (`--split both`, the default) builds one extracted index per ingestion seed (1, 2, 3) and runs every question twice on it, relationship retrieval off and on, with the same query embedding bytes, five returned chunks and the same pinned settings (balanced mode, no reranker, no expansion, no autocut, graph signals on). Embeddings are OpenAI `text-embedding-3-large` at 1,536 dimensions. Each split has 145 questions × 3 seeds = 435 paired runs. The three seeds repeat the same questions, so they measure sensitivity to ingestion order, not independent samples. Scores count distinct pages in the first five chunks; precision divides by 5.

| Split | Metric | Off | On | Paired runs better / worse / same |
|---|---|---:|---:|---|
| Template | Recall at five | 0.7368 | 0.7632 | 18 / 0 / 417 (6 distinct questions) |
| Template | First-place hit | 27.6% | 42.8% | 72 / 6 / 357 |
| Template | Precision at five | 0.2069 | 0.2152 | 18 / 0 / 417 |
| Template | Runs where relationship retrieval fired | | 174 / 435 | |
| Paraphrase | Recall at five | 0.4109 | 0.4109 | 0 / 0 / 435 |
| Paraphrase | First-place hit | 4.8% | 4.8% | 0 / 0 / 435 |
| Paraphrase | Precision at five | 0.1117 | 0.1117 | 0 / 0 / 435 |
| Paraphrase | Runs where relationship retrieval fired | | 0 / 435 | |

By template (runs where relationship retrieval fired, first-place hit off → on):

| Template | Template split | Paraphrase split |
|---|---|---|
| attended (150 runs) | fired 0, 0.0% → 0.0% | fired 0, 0.0% → 0.0% |
| works_at (120) | fired 39, 40.0% → 47.5% | fired 0, 5.0% → 5.0% |
| invested_in (117) | fired 93, 41.0% → 74.4% | fired 0, 7.7% → 7.7% |
| advises (48) | fired 42, 50.0% → 87.5% | fired 0, 12.5% → 12.5% |

Two further observations. Rewording also cost ordinary retrieval a great deal (recall at five 0.737 against 0.411 with relationship retrieval off), mostly on investor questions (0.893 against 0.073), so the template wording helps the text and vector arms too. And attendance questions still never fire relationship retrieval in either wording, as in the keyless check recorded in TODOS.

These template numbers differ from the September 9 comparison (recall at five 0.663 → 0.724 at gbrain `2efaaf8f`) because the product changed; that run stays the historical record for its version.

## What to use and what to avoid

Relationship retrieval is worth enabling for agents that phrase relationship questions in its verbs; it gained first-place hits on 72 runs and lost 6. Do not expect it to help on free wording yet. A parser that accepted these paraphrases, or a model-based intent step, is the change this benchmark can now measure, and the paraphrase split should be the headline for any claim that relationship retrieval helps in general.

## Reproduce and inspect

From the repository root, with `OPENAI_API_KEY`:

```bash
bun install
bun eval/generators/relational-paraphrase-gen.ts --check
bun eval/runner/relational-ab.ts --budget-usd 2
```

The run took 6 minutes 37 seconds and the budget ledger recorded $0.0645 for 1,010 embedding requests (496,198 input tokens). A keyless plumbing check is `bun eval/runner/relational-ab.ts --stub-embed --seeds 1`; its scores come from hash embeddings and say nothing about search quality, but its firing counts are real parser behavior (at `b80cad6`, 58/145 template questions and 0/145 paraphrases; at `608a174`, 58/145 and 33/145).

The committed receipt is [relational-ab.receipt.json](2026-09-29-relational-paraphrase/relational-ab.receipt.json). It holds every paired run (`data.per_query`, with `split`), the per-split and per-template summaries (`data.by_split`, `data.by_split_template`), the paraphrase file hash and the runner hash (`7bdda5ec…4cb254a`, identical to `eval/runner/relational-ab.ts` at `da02f97`). Its `execution.source_tree` hash was taken when the receipt was written, while unrelated files in the working tree were being edited, so use the runner hash to identify the code that ran.
