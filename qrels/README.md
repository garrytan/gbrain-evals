# Published qrels for `gbrain eval gate --qrels`

This directory holds **hermetic-synthetic** qrels (query relevance
labels) consumed by `gbrain eval gate --qrels <FILE>`. Each qrels file
is a hand-curated list of queries with their known-right answers; CI
in this repo gates every PR against the latest qrels to catch retrieval
*correctness* drops (not just regressions).

## Privacy posture (gbrain D9)

**Placeholder names only.** Same rule as `../baselines/`: every slug
referenced in a qrels file is a `*-example` form. No real people,
companies, queries, or meeting names.

## Files

| File | Purpose |
|---|---|
| `v0.41-launch.qrels.json` | First published qrels. Promoted from gbrain's `test/fixtures/eval-baselines/qrels-search.json` when v0.41 closed the eval LOOP. 12 queries. |

## File format

JSON object `{schema_version, _description, queries: [...]}`. Each
entry has:

- `query_id` — stable identifier
- `query` — the search query string
- `relevant_slugs` — slugs that should appear in the retrieved set (drives `mean_recall_at_k`)
- `first_relevant_slug` — the slug that should be top-1 (drives `expected_top1_hit_rate`)
- `embedding_dim` — optional; the basis-vector dimension for hermetic embedding (used by gbrain's internal unit-test runner)

For federated brains, an alternative shape carries explicit `source_id`:

```json
{
  "query_id": "q1",
  "query": "...",
  "relevant": [{"source_id": "host", "slug": "people/alice"}],
  "expected_top1": {"source_id": "host", "slug": "people/alice"}
}
```

Both shapes are parsed by `gbrain eval gate`; the legacy slug-only shape
auto-promotes to `source_id='default'`.

## Refresh discipline (gbrain D4)

When ranking changes intentionally move expected slugs, edit this file
and **include a `Why:` line in the commit body** so future maintainers
can audit the trail.

## Adjudication log (2026-08-31 audit, finding data-integrity-02)

The 2026-08-31 audit found 4 of 12 `first_relevant_slug` labels were
unreachable by ANY retriever on the reference corpus. Root causes and
resolutions — labels were corrected by ADJUDICATION (reading content and
gbrain's documented ranking policy), never by copying retrieval output:

1. **3 labels: corpus generation bug, labels kept.** The reference corpus
   (synthesized by `scripts/generate-v0.41-launch.ts`) embedded keywords
   from only the FIRST query listing each slug, so slugs labeled relevant
   to a second query had no matching content at all. The generator is now
   label-faithful (content carries every listing query's keywords, and each
   query's expected top-1 carries decisive emphasis). The generator now
   FAILS if any top-1 label is not at rank 1 on the reference corpus.
2. **q11-research-paper: label corrected.** Expected top-1 changed from
   `concepts/rag-example` to `writing/retrieval-overview-example`. Why:
   gbrain's keyword relevance saturates near 1.0 for any matching page, so
   the final ranking between two relevant pages is decided by the
   documented source-boost policy (`writing/` 1.4 > `concepts/` 1.3 —
   curated long-form outranks concept stubs by design; see gbrain
   `src/core/search/source-boost.ts`). Under that intended policy no
   concepts/ page can outrank a relevant writing/ page, making the old
   label untestable. Both slugs remain in `relevant_slugs`.

## Running the gate manually

```bash
gbrain eval gate --qrels gbrain-evals/qrels/v0.41-launch.qrels.json
```

For best signal, pair with the regression baseline (both gates run; both
must pass):

```bash
gbrain eval gate \
  --baseline gbrain-evals/baselines/v0.41-launch.baseline.ndjson \
  --qrels gbrain-evals/qrels/v0.41-launch.qrels.json
```
