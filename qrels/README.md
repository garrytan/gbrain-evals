# Answer labels for retrieval

“Qrels” is information-retrieval shorthand for **query relevance judgments**. In plain English, these files say which pages a question should find.

A [baseline](../baselines/README.md) records what an earlier version returned. Qrels describe the intended answers. Using both lets us catch a changed ranking and check whether the new result is correct.

The committed `v0.41-launch.qrels.json` contains 12 hand-reviewed queries. It was promoted from gbrain's `test/fixtures/eval-baselines/qrels-search.json` when v0.41 added the evaluation loop. Its people, companies and page names are fictional placeholders.

## What each field means

The file contains `schema_version`, `_description` and a `queries` array.

| Field | Meaning |
|---|---|
| `query_id` | Stable identifier used to follow the same question across runs |
| `query` | The text sent to search |
| `relevant_slugs` | Pages that should appear in the results |
| `first_relevant_slug` | The expected first result |
| `embedding_dim` | Optional vector width for gbrain's deterministic test embeddings |

For a question that requires two pages, returning only one loses recall. Returning the second page first may satisfy recall while failing the expected-first-result check.

The public gbrain gate also accepts source-qualified labels for a brain spanning multiple sources:

```json
{
  "query_id": "q1",
  "query": "...",
  "relevant": [{"source_id": "host", "slug": "people/alice-example"}],
  "expected_top1": {"source_id": "host", "slug": "people/alice-example"}
}
```

The slug-only format is interpreted as `source_id: "default"`.

## Run the reference check

From the repository root:

```sh
bun scripts/generate-v0.41-launch.ts --check
```

This builds the fictional reference corpus and checks the 12 queries without a model API. It is the qrels-plus-baseline check used in this repository's CI.

For a separately prepared brain containing the matching corpus, the public CLI is:

```sh
gbrain eval gate \
  --baseline baselines/v0.41-launch.baseline.ndjson \
  --qrels qrels/v0.41-launch.qrels.json
```

## Why labels changed on 2026-08-31

The audit found that four expected first results were unreachable on the generated reference corpus. We investigated the content and intended ranking policy rather than copying the search output into the answer key.

For three labels, the label was right and the generator was wrong. It inserted only the first query's words into pages shared by several queries. The generator now includes every associated query and emphasizes its expected first result. It fails if an expected first result is not actually first on the reference corpus.

For `q11-research-paper`, the first-result label changed from `concepts/rag-example` to `writing/retrieval-overview-example`. Both remain relevant. Under the documented policy, relevant `writing/` pages receive a 1.4 weight and `concepts/` pages 1.3; matching keyword scores saturated near 1.0, so that policy decided their order. The previous first-result label contradicted the behavior the test intended to preserve.

Future changes to answer labels must include the reason. Use a `Why:` line in the commit body so readers can distinguish an intentional correction from making a test agree with a regression.
