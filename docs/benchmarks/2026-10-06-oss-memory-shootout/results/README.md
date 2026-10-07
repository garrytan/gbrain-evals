# Phase 4 cell results

One directory per cell and lease (`<cell>/<lease>/`), copied from the cell VM after the lease settled:

- `lease-summary.json`: the lease, its committed dollars and request count, and the cell's exit code.
- `receipt.json`: the memory-QA run receipt (system identity and capability record, ingest counts, outcomes, summary
  metrics); `arms/<arm>/receipt.json` per arm.
- `arms/<arm>/rows.ndjson.gz` and `retrievals/rows.ndjson.gz`: one row per question with ids, category, outcome,
  strict recall, retrieved session ids, tokens, latency and cost. Reader answers, retrieved item text and the packed
  contexts are left out: they carry dataset text. They are kept outside the repository with the pulled run.
- Receipts are byte-for-byte as the VM wrote them, except that the VM home directory `/home/ubi/` in the gbrain overlay
  path (`overlay.requested`) is written as `~/`, the rewrite the receipt writer applies to every other path.

The manifests and campaign hash are in [manifests/](../manifests/) and the rules in the
[preregistration](../../2026-10-06-oss-memory-shootout-preregistration.md).

## Status

| Cell | Lease | Status |
|---|---|---|
| `mem0-common-locomo-r1` | `a1-757e7284` | harness failure: every `/finish` hit the runner's 600-second default while Mem0's queue drained, so all 587 rows are `ingest_degraded` (amendment A3); rerun as attempt 2 |

| `graphiti-common-lme-s` | `a1-cfb6cb33` | lost at launch: the host stopped the driver while ubi-runner was creating the VM, and the VM was destroyed before sync. No VM ledger or proxy usage log exists, so the ledger holds the full $283 as a reservation, actual unknown, not measured spend. The launch log shows the cell command never started |
| `graphiti-common-lme-s` | `a2-c5057994` | lost at sync (a concurrent `git fetch` changed `.git` while ubi-runner read it); closed at $0 with `abandon --unstarted`, launch log kept as evidence |
| `hindsight-common-lme-s` | `a1-b6bfb19c` | as above, closed at $0 |
| `gbrain-shootout-common-lme-s` | `a1-7b217224` | as above, closed at $0 |

| `cognee-common-locomo-r2` | `a1-3aa83ae3` | harness failure: the $2 lease was smaller than the metering proxy's in-flight reservations during Cognee's parallel ingest ($0.053 per chat call at the 32,768-token output bound), so 19 calls were refused and every row is `budget_not_run`; rerun under amendment A7 |
| `cognee-recipe-locomo-r2` | `a1-acf4475f` | as above, 16 calls refused |
| `hindsight-common-lme-s` | `a2` | 340 of 400 rows `retrieval_error`: after each shard's first haystack, the server answered every bank reset with HTTP 500 while the other shards were ingesting; cause under investigation |
| `basic-memory-common-beam-100k` | `a1-b180b106` | one of six conversations hit the runner's 600-second `/finish` default (`ingest_degraded`, 20 questions per arm) |

Every other directory here is a complete cell. Directories with `shard-<i>/` hold one receipt per parallel shard of a
LongMemEval-S cell; `pmb/` holds a PrecisionMemBench run (rows without the fixture's query and description text,
which the repository already carries in `eval/precisionmembench/fixtures/`).

## Stop rules and the unknown-actual reservation

The per-system stop (1.5 times the pilot estimate) counts measured settled spend only. Graphiti's lease `a1-cfb6cb33`
($283) is a reservation with unknown actual spend from a cell command that never started; the campaign ledger keeps it
in `committed` against the $1,450 cap, but the stop check counts it separately. On 2026-10-07 the driver had counted it
as spend and tripped Graphiti's stop at $535.78; Graphiti's measured spend was $252.78 against its $252 pilot estimate
(1.0 times; the stop is $378), so the check was corrected and the stop cleared before any Phase 7 cell.

## Changelog

- 2026-10-07: The per-system stop counts measured spend only; Graphiti's stop trip from the unknown-actual reservation cleared.

- 2026-10-07: Phase 4 and Phase 5 cells as they settled, with the harness failures above.

- 2026-10-07: Seven more cells (LongMemEval-S controls and gbrain rows, Graphiti recipe LoCoMo r2); plain-hybrid LongMemEval-S has one degraded haystack (4 of 400 rows, under the 5% threshold).
- 2026-10-06: First ten LoCoMo dev r1 cells and the Mem0 r1 harness failure.
