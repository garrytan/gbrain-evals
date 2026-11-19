| Engine | Runs | nDCG@5 | P@5 (graded) | R@5 | MRR@5 | p50 ms | p95 ms | warm p50 ms | warm p95 ms | Cost/query (scored run) |
|---|---|---|---|---|---|---|---|---|---|---|
| pglite | 1 | 55.7% [55.7–55.7, sd 0.0] | 27.4% [27.4–27.4, sd 0.0] | 79.5% [79.5–79.5, sd 0.0] | 67.5% [67.5–67.5, sd 0.0] | 204 [204–204, sd 0] | 224 [224–224, sd 0] | 203 [203–203, sd 0] | 221 [221–221, sd 0] | 0.000000 [0.000000–0.000000, sd 0.000000] |
| postgres | 1 | 55.7% [55.7–55.7, sd 0.0] | 27.4% [27.4–27.4, sd 0.0] | 79.5% [79.5–79.5, sd 0.0] | 67.5% [67.5–67.5, sd 0.0] | 45 [45–45, sd 0] | 53 [53–53, sd 0] | 44 [44–44, sd 0] | 54 [54–54, sd 0] | 0.000000 [0.000000–0.000000, sd 0.000000] |
| rust | 0 scored | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked |

Cells: mean [min–max, sd] across runs. Not scored:
- rust-r1 (exit 3): [gbrain] 1/1 searchVector arms failed (salvaging survivors): This brain's engine does not support searchVector yet (it needs the vector_search capability), so nothing ran. | SEARCH INCOMPLETE: 548 query execution/observation failures; scores are diagnostic only. | [cat13] RUN INVALID — search execution incomplete
- rust-r2 (exit 3): [gbrain] 1/1 searchVector arms failed (salvaging survivors): This brain's engine does not support searchVector yet (it needs the vector_search capability), so nothing ran. | SEARCH INCOMPLETE: 548 query execution/observation failures; scores are diagnostic only. | [cat13] RUN INVALID — search execution incomplete
- rust-r3 (exit 3): [gbrain] 1/1 searchVector arms failed (salvaging survivors): This brain's engine does not support searchVector yet (it needs the vector_search capability), so nothing ran. | SEARCH INCOMPLETE: 548 query execution/observation failures; scores are diagnostic only. | [cat13] RUN INVALID — search execution incomplete
