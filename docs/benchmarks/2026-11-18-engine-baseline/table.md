| Engine | Runs | nDCG@5 | P@5 (graded) | R@5 | MRR@5 | p50 ms | p95 ms | Cost/query (scored run) |
|---|---|---|---|---|---|---|---|---|
| pglite | 3 | 55.7% [55.7–55.7, sd 0.0] | 27.4% [27.4–27.4, sd 0.0] | 79.5% [79.5–79.5, sd 0.0] | 67.5% [67.5–67.5, sd 0.0] | 201 [200–202, sd 1] | 220 [219–220, sd 1] | 0.000000 [0.000000–0.000000, sd 0.000000] |
| postgres | 3 | 55.7% [55.7–55.7, sd 0.0] | 27.4% [27.4–27.4, sd 0.0] | 79.5% [79.5–79.5, sd 0.0] | 67.5% [67.5–67.5, sd 0.0] | 43 [41–47, sd 3] | 56 [55–57, sd 1] | 0.000000 [0.000000–0.000000, sd 0.000000] |
| rust | 0 scored | blocked | blocked | blocked | blocked | blocked | blocked | blocked |

Cells: mean [min–max, sd] across runs. Not scored:
- rust-r1 (exit 3): FAILED to run: OperationError: This brain's engine does not support upsertChunks (option embeddingColumn) yet (it needs the chunks capability), so nothing ran.
- rust-r2 (exit 3): FAILED to run: OperationError: This brain's engine does not support upsertChunks (option embeddingColumn) yet (it needs the chunks capability), so nothing ran.
- rust-r3 (exit 3): FAILED to run: OperationError: This brain's engine does not support upsertChunks (option embeddingColumn) yet (it needs the chunks capability), so nothing ran.
- warmup-pglite (exit 0): warm-up run (fills the shared embedding cache); excluded from the table
