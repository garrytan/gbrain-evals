# LongMemEval's local embedding cache

An embedding is the list of numbers a model produces for a piece of text. The runner saves that result so it does not pay to embed identical text again.

No cache ships in this directory. This README explains the cache; the actual SQLite files are created under:

```text
eval/reports/longmemeval/embed-cache/
```

That directory is ignored by Git. A full LongMemEval-S cache has historically occupied about 700 MB. Cold OpenAI embedding cost was approximately $2; this is a historical estimate, not a spending limit.

## What makes a cache entry reusable

The key identifies the model and dimensions, the text's SHA-256 hash, and whether the text was embedded as a query or a document. Some providers produce different vectors for those two uses. Reusing a document vector for a query would quietly change the experiment.

Changing the text or model settings causes a cache miss. On 2026-08-31, adding the query/document distinction deliberately made the older entries unusable.

“Content-addressed” means the lookup key depends on the input text. It does not authenticate the vector stored under that key or make a tampered cache trustworthy.

## Use or share it

The runner prints the resolved cache filename and hit/miss counts. Filenames include a sanitized model identifier and dimensions. Use `--cache-dir <directory>` to select another location or `--no-cache` to disable caching.

To share a cache, close its writers first and copy the database safely, or use SQLite's backup facilities. SQLite's WAL mode can keep recent writes in a separate file, so copying only the main database while it is active can omit entries. The runner uses WAL and a ten-second lock wait for workers sharing a cache.

A warm cache avoids repeated embedding calls. It does not pay for query expansion, reranking, answer generation or judging. Nor does this cache apply automatically to other runners.

See the [runbook](../../../RUNBOOK.md) for a small LongMemEval setup run.
