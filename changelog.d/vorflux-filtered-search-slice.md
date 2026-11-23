- **A new runner measures whether filtered search returns the right pages, enough of them and fast, on PGLite, Postgres and Rust.**

### Added

- `eval/runner/filtered-search-slice.ts` runs cat13's probes through gbrain's `query` operation with one filter at a time. The filters are a small source and a large source, one page type and a set of types, a 7-day and a 1-year date window, a source plus a type, and a `where` frontmatter match. Each page gets its source, date and frontmatter value from a seeded hash of its slug, so every filter keeps a known share of the corpus.
- For each filter the runner reports vector-arm recall@10 against an exact filtered scan over the same stored vectors, how many rows came back and whether any query came back short, rows that break the filter, nDCG@5 against cat13 gold inside the filter, and p50, p95 and every query over one second.
- On PGLite and Postgres an optional reference pass reruns every query with index scans off on the same brain, so hybrid results can be compared with an exact search.
- A cell the `query` operation refuses on an engine is measured through hybridSearch directly and marked as a diagnostic, with the refusal recorded. A query whose vector arm never ran makes the run invalid.
- `test/eval/filtered-search-slice.test.ts` pins the seeded filter shares on world-v1 and the date windows.
