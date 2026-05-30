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
