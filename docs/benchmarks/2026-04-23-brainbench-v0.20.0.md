# The v0.20 relationship-search baseline

**Historical run: April 23, 2026.** gbrain `96852c0` (PR #195 HEAD, v0.20.0); gbrain-evals `8dab7f7`. Command: `BRAINBENCH_N=1 bun eval/runner/multi-adapter.ts`. One run, about three minutes on an M3 laptop; approximately $0 additional embedding cost with the cache warm. No answer model or judge was used.

**September 1 erratum:** these numbers predate the August 31 audit, and no receipt for this run is committed. Older recall could double-count chunk duplicates; older precision divided by the number returned instead of five; the corpus also contained a dangling person-to-company link. The v0.5.0 evaluation release declared earlier results non-comparable to corrected runs. Use the [retrieval refresh](2026-09-09-retrieval-refresh.md) for current figures.

The historical experiment asked whether extraction and graph-first search helped answer questions like “Who works at this company?” It recorded a clear advantage for the full adapter, but its query parser recognized the same four templates used by the question generator. That makes this a narrow test of those relationship paths.

## Recorded scorecard

| Adapter                     | Runs | Queries | P@5       | R@5       | correct in top-5 |
|-----------------------------|------|---------|-----------|-----------|------------------|
| **gbrain**                  |    1 |     145 | **49.1%** | **97.9%** | **248 / 261**    |
| vector-grep-rrf-fusion      |    1 |     145 |     17.8% |     65.1% |     129 / 261    |
| grep-only                   |    1 |     145 |     17.1% |     62.4% |     124 / 261    |
| vector                      |    1 |     145 |     10.8% |     40.7% |      78 / 261    |

Precision@5 measures relevant results among the first five. Recall@5 measures required evidence found there. The columns above are the old helper's outputs and should not be treated as corrected values.

| Adapter                | Δ P@5       | Δ R@5       | Δ correct-in-top-5 |
|------------------------|-------------|-------------|---------------------|
| vector-grep-rrf-fusion | −31.4 pts   | −32.9 pts   | −119                |
| grep-only              | −32.0 pts   | −35.5 pts   | −124                |
| vector                 | −38.4 pts   | −57.2 pts   | −170                |

The 31.4-point precision difference is an adapter comparison. It is **not a measured graph-only improvement**: extraction, query interpretation, retrieval, and result handling also differ. The hybrid reference is a gbrain-backed adapter, not a separately benchmarked graph database alternative.

## Continuity with the earlier release

| Adapter                | v0.12.1 P@5 | v0.20.0 P@5 | Δ         |
|------------------------|-------------|-------------|-----------|
| gbrain                 | 49.1%       | 49.1%       | **0.0**   |
| vector-grep-rrf-fusion | 17.8%       | 17.8%       | 0.0       |
| grep-only              | 17.1%       | 17.1%       | 0.0       |
| vector                 | 10.7%       | 10.8%       | +0.1      |

The recorded values were within 0.1 point of the v0.12.1 reference. The report used this as a regression checkpoint across v0.16, v0.17, v0.18.0, v0.18.1, v0.18.2, v0.19.0, and v0.20.0, which added operations, multi-source storage, access controls, migrations, checks, and this separate evaluation repository. Endpoint agreement does not prove that every intermediate release or query path was tested.

## What was configured

The corpus was 240 fictional pages: eighty people, eighty companies, fifty meetings, and thirty concepts. Its answer key generated 145 relationship questions. `_facts` and `gold` were removed at the adapter boundary.

The runtime was Bun 1.3.10, in-memory `pglite@0.4.3`, `postgres@3.4.9`, and `pgvector@0.2.1`. Embeddings used OpenAI `text-embedding-3-large`. Each adapter ingested an isolated copy of the pages. The historical graph adapter extracted relationships; the reference disabled automatic links. Keyword search used BM25-style ranking; vector search used cosine similarity.

The original report recorded zero standard deviation at N=1 and claimed exact reruns. One run cannot estimate variability. A template-blind test using paraphrased relationship questions was proposed in issue #24 to measure how much of the advantage survives different wording.

## Reproduction and scope

The historical procedure was to install this repository, link the chosen gbrain checkout with `bun link gbrain`, and run `OPENAI_API_KEY=... bun run eval:run:dev`. Linking today's gbrain produces a new experiment.

Only categories 1 and 2, retrieval precision and recall, ran here. The broader suite listed identity, time, provenance, prose links, performance, skill use, workflows, adversarial inputs, multimodal ingestion, and operation contracts. The original estimates were about $22 for agent-loop smoke testing at N=1 and $215 for a published N=10 suite; they are historical budgeting figures. The [companion concept report](2026-04-23-brainbench-cat13-conceptual.md) tests the different case where a user remembers meaning rather than an entity relationship.
