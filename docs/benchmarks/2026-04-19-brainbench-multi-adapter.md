# Four ways to answer relationship questions

**Historical run: April 19, 2026.** Branch `garrytan/gbrain-evals`, commit `b81373d`, in-memory PGLite. Corpus: 240 fictional pages in `eval/data/world-v1/`. Runner: `bun run eval:run`, five runs with seeded page-order shuffling. Total wall time: about 11.5 minutes.

The graph-first gbrain adapter found more of the required person pages than the text-search adapters in this fixture. For questions such as “Who invested in this company?”, an explicit investment edge is a useful clue that similarity alone does not supply.

These are historical adapter comparisons. The adapters differ in retrieval strategy, extraction, and result handling. The **31.4-point precision difference cannot be attributed to the graph alone**. See the [retrieval refresh](2026-09-09-retrieval-refresh.md) for current measurements and settings.

## Results and what the measures mean

Current Precision@5 measures how many of the first five result slots are relevant; current Recall@5 measures how much required evidence appears there. The table below predates the metric audit: older code could reward short result lists and count duplicate hits, and the original per-query receipts are unavailable. Its 49.1% / 97.9% figures cannot be interpreted as freshly verified scores under the corrected definitions. A count of correct results is also a different aggregation from averaging per-question scores.

| Adapter          | Runs | Queries | P@5          | R@5          | Correct in top-5 (run 1) |
|------------------|------|---------|--------------|--------------|--------------------------|
| **gbrain** | 5    | 145     | **49.1%** ±0 | **97.9%** ±0 | **248 / 261**            |
| vector-grep-rrf-fusion   | 5    | 145     | 17.8%        | 65.1%        | 129 / 261                |
| grep-only     | 5    | 145     | 17.1%        | 62.4%        | 124 / 261                |
| vector      | 5    | 145     | 10.8%        | 40.7%        | 78 / 261                 |

All five repetitions reported zero standard deviation under shuffled ingestion order. That checks sensitivity to page order in this fixture, not uncertainty about new questions or corpora.

Relative to gbrain, the recorded precision/recall differences were −31.4/−32.9 points for the hybrid reference, −32.0/−35.5 for grep, and −38.4/−57.2 for vector search. The corresponding differences in correct top-five items were −119, −124, and −170. These preserve the original rounded deltas.

## What each adapter did

The `gbrain` adapter extracted typed relationships, traversed them for matching questions, and used a text fallback. `vector-grep-rrf-fusion` used gbrain's hybrid text search without that graph-first strategy. `grep-only` ranked in-memory word matches. `vector` compared numerical representations of page meaning with the question.

A biography about a founder at one company can resemble a biography about an employee at another. Similarity is useful for finding a topic; it does not by itself establish who works where. Conversely, these relationship questions do not measure where vector search is strongest: paraphrases and descriptions of ideas.

The adapter name `vector-grep-rrf-fusion` is historical. It does not mean that an external vector database and a shell `grep` process were combined, or that everything except graph access was held constant.

## Runtime

| Adapter        | Time    | Per run | Notes                                    |
|----------------|---------|---------|------------------------------------------|
| gbrain   | 7.4s    | ~1.5s   | PGLite + extract (graph) + grep fallback |
| vector-grep-rrf-fusion | 555.1s  | ~111s   | Re-embeds 240 pages every run            |
| grep-only   | 0.1s    | ~20ms   | Pure in-memory term matching             |
| vector    | 131.8s  | ~26s    | Embeds once, cosine per query            |

These times include different setup costs. The hybrid reference re-embedded 240 pages on every run, whereas the graph-first path used PGLite, extraction, and a text fallback. The timing gap is not a clean measure of graph-query speed versus vector-query speed.

## Corpus and procedure

The corpus has 80 people, 80 companies, 50 meetings, and 30 concepts, generated as fictional prose. Its `_facts` metadata supplies the answer key for 145 questions about attendance, employment, investment, and advice. The adapter boundary removes that answer-key metadata before search sees the pages.

Every adapter ran five times. A seeded linear congruential generator shuffled ingestion order. None of these questions were temporal; date-sensitive queries elsewhere require an explicit `as_of_date`.

## Reproduction and limits

Use the historical checkout for the original experiment:

```sh
# From a clean checkout at commit b81373d
export OPENAI_API_KEY=sk-proj-...   # embedding-based adapters need this
bun install
bun run eval:run
```

The original report expected exact agreement for deterministic adapters and some embedding variation for the hybrid reference. `BRAINBENCH_N=1 bun run eval:run:dev` was the shorter, approximately two-minute iteration command.

The runner printed its complete scorecard but exited with code 99 at the end; that defect was recorded separately. A printed table should not be confused with a clean process exit. The [April 18 before/after report](2026-04-18-brainbench-v1.md) describes an earlier configuration and a different question count.
