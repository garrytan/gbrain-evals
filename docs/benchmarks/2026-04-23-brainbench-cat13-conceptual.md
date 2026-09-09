# When remembering the idea works better than remembering the words

**Historical run: April 23, 2026.** gbrain `96852c0` (PR #195 HEAD, v0.20.0); gbrain-evals `8dab7f7`. Command: `CAT13_PROBES=500 bun eval/runner/cat13-conceptual.ts`. Five hundred seeded probes, about eleven minutes across four adapters, estimated API cost $0.03.

Someone may ask for “that essay about unscalable founder work” when the note is titled “Do Things That Don't Scale.” Keyword search needs overlapping words. Vector search compares representations of meaning, so it has another way to find the note. This test was built to measure that difference.

These April figures predate corrections to probe generation and shared metrics. They are historical evidence, not directly comparable to the corrected [September retrieval refresh](2026-09-09-retrieval-refresh.md). The September 6 report also found that the old adapters re-sorted results after reranking; affected reranker-on results are historical until rerun with final order preserved.

## The four search methods

`grep-only` used an inverted word index with BM25 ranking; it was not a shell grep command. `vector` used OpenAI `text-embedding-3-large` and cosine similarity. `vector-grep-rrf-fusion` used gbrain's hybrid search without graph-first traversal. `gbrain` used the full adapter.

| Adapter                 | nDCG@5    | P@5 (graded ≥1) | P@1 (strict target) | Wall (s) |
|-------------------------|-----------|------------------|----------------------|----------|
| **vector**              | **49.1%** | **25.3%**        | **52.9%**            |   111    |
| vector-grep-rrf-fusion  |     47.5% |     24.9%        |     49.4%            |   323    |
| gbrain                  |     47.0% |     24.4%        |     49.4%            |   220    |
| grep-only               |     46.2% |     21.6%        |     49.4%            |     0    |

The score is nDCG@5: it rewards putting the most relevant page near the top of five results. The intended concept had relevance grade 3; related concepts had grade 1. The recorded vector score was 49.1%, versus 47.0% for gbrain and 46.2% for keyword search. That narrow overall difference hides larger differences between kinds of question.

## Which questions separated the methods?

| Template                 | vector      | vector-grep-rrf-fusion | gbrain    | grep-only   | #probes |
|--------------------------|-------------|------------------------|-----------|-------------|---------|
| title-paraphrase         |  **76.4%**  | 71.2%                  | 72.8%     | 71.5%       | 80      |
| title-variation          |  **75.2%**  | 66.8%                  | 68.0%     | 70.6%       | 49      |
| description-paraphrase   |  **75.5%**  | 74.2%                  | 74.1%     | 71.1%       | 19      |
| synonym                  |  63.7%      | **64.9%**              | 64.0%     |  44.7%      | 114     |
| synonym-fuzzy            |  **66.2%**  | 63.6%                  | 63.6%     |  29.5%      | 39      |
| body-fuzzy               |  16.8%      | 17.0%                  | 15.0%     | **33.3%**   | 156     |
| semantic-neighborhood    |  25.0%      | 24.4%                  | 24.6%     | **29.7%**   | 53      |

“Synonym-fuzzy” means a question combines alternate vocabulary with an imprecise reference such as “that essay.” It was the clearest vector advantage:

| Adapter   | nDCG@5      |
|-----------|-------------|
| vector    | 66.2%       |
| gbrain    | 63.6%       |
| vector-grep-rrf-fusion | 63.6% |
| grep-only | **29.5%**   |

The 66.2% and 29.5% values are averages across this question family, not probabilities for one example. They support using semantic search when the user has forgotten the wording.

The reverse happened when the generator reused a distinctive phrase from a page body:

| Adapter   | nDCG@5      |
|-----------|-------------|
| grep-only | **33.3%**   |
| vector-grep-rrf-fusion | 17.0% |
| vector    | 16.8%       |
| gbrain    | 15.0%       |

For “the framework I wrote about manual onboarding,” exact words can be a strong clue. Grep's 33.3% beat vector's 16.8% in this family. Because these phrases were drawn from the target pages, the fixture made exact matching particularly useful.

The historical full and hybrid-reference scores, 47.0% and 47.5%, were close. That does not isolate a graph effect. The broader lesson is that relationship questions and concept questions need different evidence, and a useful search system should be tested on both.

## How the questions were made

The fixture draws on thirty concept pages in `world-v1`, including agent workflows, unit economics, product-market fit, and founder mode. Its seeded generator used mulberry32 with seed 42: five title paraphrases, four title variations, two description paraphrases, three or four authored synonyms used in four forms, body phrases, and related-concept questions.

A thirty-entry synonym map supplied alternate wording. Related concepts were inferred from shared companies or people in `_facts`. The adapters received sanitized prose; the answer-key fields were removed before retrieval.

Later audit corrections matter here: some generated questions had identical text with conflicting answers, and random-sort sampling was replaced with a seeded shuffle. A small difference between old and new scores can therefore reflect a better test rather than a changed search engine.

## Running the historical version

The original command was `bun install && bun link gbrain`, followed by `OPENAI_API_KEY=... CAT13_PROBES=500 bun eval/runner/cat13-conceptual.ts` against the historical pins. Estimated vector cost was $0.01 for five hundred query embeddings, and about $0.03 for all four adapters. There was no answer model or judge, but embedding API calls still occurred.

The original follow-ups were to paraphrase copied body phrases, diversify beyond 1,000 template probes, broaden the authored synonym map, and improve related-concept labels beyond simple co-occurrence. They remain separate questions from whether a particular search setting wins on this small fixture.
