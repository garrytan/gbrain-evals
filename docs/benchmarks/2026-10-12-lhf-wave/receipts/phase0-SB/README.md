# Phase 0: `balanced` through the real `search` operation reproduces the published baseline

Preregistered in [`../../../2026-10-12-lhf-wave-preregistration.md`](../../../2026-10-12-lhf-wave-preregistration.md) (phase 0). Run on 2026-10-12 at gbrain `e62f72c4b353b5d0fb2d410a95ef812b0c745585` (tree `6f09cd1a13fa`, clean), Bun 1.4.2, in four shards of consecutive answerable question ids, each with its own cold embedding cache.

- **Result:** 451/470 strict `recall_all@5`, against 451/470 for the published October 4 `FINAL` arm (direct harness at gbrain `109b992`). Paired: +1/-1, estimate 0, one-sided 95% lower bound -0.43 points: **reproduced** (needs above -1.0). [`verdict-vs-published-FINAL.json`](verdict-vs-published-FINAL.json).
- **Validity:** 470 rows, every row one embedding and one rerank call, no degraded stage, no failed model call.
- **Latency** (operation, this machine, includes the reranker round trip): p50 626 ms, p95 969 ms.
- **Cost:** $7.44 in the program ledger (four runs, 61.2M embedding input tokens plus Voyage rerank); `shard*/cost.json`.
- **Embedding cache:** the four shard caches merged into one file of 101,325 entries (SHA-256 `cf0a0492…`), copied per counted arm.

`rows.ndjson.gz` holds the merged rows with each row's `hypothesis` (the retrieved session text, about 117k characters a row) replaced by its SHA-256 and length. Machine paths are replaced by `<work>` and `~`. `shard*/summary.json.gz` is each shard's run summary; its `via_operation_summary.tree` names the gbrain-evals checkout the driver ran from (a harness bug fixed on gbrain `capy/lhf-wave` before the counted arms; `../../../2026-10-12-lhf-wave/scripts/driver-via-op.ts` records the gbrain commit itself from then on).

Recount: `bun docs/benchmarks/2026-10-12-lhf-wave/scripts/analyze-lme.ts docs/benchmarks/2026-10-12-lhf-wave/receipts/phase0-SB/rows.ndjson.gz docs/benchmarks/2026-10-04-longmemeval-opaque-followups/1a-harness/FINAL/rows.ndjson.gz --control-direct`
