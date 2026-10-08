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
| `extract-first-common-locomo-r1` | `a1-757e7284` | harness failure: every `/finish` hit the runner's 600-second default while extract-first's queue drained, so all 587 rows are `ingest_degraded` (amendment A3); rerun as attempt 2 |

| `temporal-graph-common-lme-s` | `a1-cfb6cb33` | lost at launch: the host stopped the driver while ubi-runner was creating the VM, and the VM was destroyed before sync. No VM ledger or proxy usage log exists, so the ledger holds the full $283 as a reservation, actual unknown, not measured spend. The launch log shows the cell command never started |
| `temporal-graph-common-lme-s` | `a2-c5057994` | lost at sync (a concurrent `git fetch` changed `.git` while ubi-runner read it); closed at $0 with `abandon --unstarted`, launch log kept as evidence |
| `memory-bank-common-lme-s` | `a1-b6bfb19c` | as above, closed at $0 |
| `gbrain-shootout-common-lme-s` | `a1-7b217224` | as above, closed at $0 |

| `graph-pipeline-common-locomo-r2` | `a1-3aa83ae3` | harness failure: the $2 lease was smaller than the metering proxy's in-flight reservations during graph-pipeline's parallel ingest ($0.053 per chat call at the 32,768-token output bound), so 19 calls were refused and every row is `budget_not_run`; rerun under amendment A7; attempt `a2-1295319b` completed |
| `graph-pipeline-recipe-locomo-r2` | `a1-acf4475f` | as above, 16 calls refused; attempt `a2-04920c35` completed |
| `memory-bank-common-lme-s` | `a2` | 340 of 400 rows `retrieval_error`: after each shard's first haystack, the server answered every bank reset with HTTP 500 while the other shards were ingesting. Cause: the database container's 64 MB `/dev/shm` (amendment A7); attempt `a3-7c90ca22` with `shm_size: 1g` scored 98 of 100 rows (2 `ingest_degraded`) |
| `markdown-notes-common-beam-100k` | `a1-b180b106` | one of six conversations hit the runner's 600-second `/finish` default (`ingest_degraded`, 20 questions per arm); attempt `a2-bf2d30ca` with the four-hour wait completed |

Every other directory here is a complete cell. Directories with `shard-<i>/` hold one receipt per parallel shard of a
LongMemEval-S cell; `sealed/` holds a Phase 7 cell's allowlisted per-arm aggregates, beside its custody access log; `pmb/` holds a PrecisionMemBench run (rows without the fixture's query and description text,
which the repository already carries in `eval/precisionmembench/fixtures/`).

## Stop rules and the unknown-actual reservation

The per-system stop (1.5 times the pilot estimate) counts measured settled spend only. temporal-graph's lease `a1-cfb6cb33`
($283) is a reservation with unknown actual spend from a cell command that never started; the campaign ledger keeps it
in `committed` against the $1,450 cap, but the stop check counts it separately. On 2026-10-07 the driver had counted it
as spend and tripped temporal-graph's stop at $535.78; temporal-graph's measured spend was $252.78 against its $252 pilot estimate
(1.0 times; the stop is $378), so the check was corrected and the stop cleared before any Phase 7 cell.

### `memory-bank` passed its per-system stop during Phase 7

`memory-bank`'s measured spend is $132.90 against its stop of $109.50 (1.5 times the $73 pilot estimate). Phases 4
and 5 account for $102.81, under the stop; the two sealed cells ($15.15 LoCoMo, $14.94 BEAM-100K) took it over. Both
sealed cells had launched before the total crossed, and they ran to the end so the frozen sealed batch has no hole
(campaign owner's decision, 2026-10-08). The overshoot has two causes beyond the sealed cells, which the pilot
estimate never covered: the failed LongMemEval-S attempt `a2` ($9.82, the database shared-memory limit of amendment
A7), and the LongMemEval-S rerun `a3` costing $66.74 against the pilot's $50.12 LongMemEval-S estimate. No other
`memory-bank` cell remains.

## Changelog

- 2026-10-08: `memory-bank`'s stop overshoot logged with its causes.

- 2026-10-08: Phase 7 sealed cells (aggregates, custody access logs and lease summaries only); every counted cell finished.

- 2026-10-08: Phase 4 complete: the A7 reruns of the two graph-pipeline LoCoMo r2 cells, markdown-notes BEAM and memory-bank LongMemEval-S.
- 2026-10-07: The per-system stop counts measured spend only; temporal-graph's stop trip from the unknown-actual reservation cleared.

- 2026-10-07: Phase 4 and Phase 5 cells as they settled, with the harness failures above.

- 2026-10-07: Seven more cells (LongMemEval-S controls and gbrain rows, temporal-graph recipe LoCoMo r2); plain-hybrid LongMemEval-S has one degraded haystack (4 of 400 rows, under the 5% threshold).
- 2026-10-06: First ten LoCoMo dev r1 cells and the extract-first r1 harness failure.
