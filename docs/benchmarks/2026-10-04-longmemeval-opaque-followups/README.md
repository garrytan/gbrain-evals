# Receipts: LongMemEval opaque-id follow-ups and frontier reader (2026-10-04)

These files support [the report](../2026-10-04-longmemeval-opaque-followups.md) and follow its [preregistration](../2026-10-04-longmemeval-opaque-followups-preregistration.md). Everything was measured on 2026-10-04 at gbrain `109b992` (the `package.json` pin), Bun 1.4.2, with the cleaned LongMemEval `_s` file (SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`, MIT-licensed, not committed). Machine-local paths are replaced by `.` (the checkout), `~` (a home directory) and `<work>` (a scratch directory). Recount everything without keys with `python3 scripts/verify-longmemeval-opaque-followups.py` from the repository root.

| Path | What it holds |
|---|---|
| `summary-1a.json` | Item 1a: every recount arm against its published receipt (strict and any-hit counts over 470, the 430-question decision set, paired gains and losses, exact McNemar p, verdict), run configuration, cache misses, error and degraded rows, and the comparison with the 2026-09-29/30 runs at `a7cb37b`. |
| `1a-harness/<arm>/rows.ndjson.gz` | gbrain harness rows (500, or 40 for `dev40-*`) plus the run summary line. Each row keeps the retrieved chunk ids, scores, rerank scores and the retrieved chunk text (`hypothesis`), with dataset session ids restored for scoring. `A1` is the four shards concatenated and closed by a no-op resume. |
| `1a-harness/<arm>/calls.ndjson.gz` | Every paid call: embedding batches with usage tokens, Voyage rerank calls with status and usage. A1's are in `A1-shard0` to `A1-shard3`. |
| `1a-harness/<arm>/stderr.log.gz`, `watchdog.log` | Harness logs and the watchdog record (one normal exit per process; no stall restarts). |
| `1a-harness/q0.txt` … `q3.txt`, `dev40.txt`, `cache.txt` | Shard and development-slice question ids; hash, size and row count of the merged embedding cache (not committed, 943 MB). |
| `1a-runner/rows.ndjson.gz` | This repository's runner, five adapters × 500 rows. |
| `1a-runner/aggregate.json`, `rows.md`, `aggregate-receipt.json` | The runner's own aggregate and receipt. |
| `1a-runner/budget-ledger.json.gz` | Every reserved and settled provider request of the two budget-ledger runs. |
| `1a-runner/batch.log`, `restarts.log` | Batch wrapper log and the record of the one operator restart. |
| `summary-1b.json` | Item 1b: per-arm counts by subset and category, cutoffs, paired result with the bootstrap interval, the gate, the comparison with the September 24 labels, and reader spend from the journals. |
| `1b/journal-part1..4.ndjson.gz` | The run lane's append-only journals: admission, settlement, response text, finish reason and usage for all 722 calls. |
| `1b/labels.ndjson.gz` | One row per response with the judge's verdict, raw output and usage. |
| `1b/requests-part1..4.identity.json`, `run-part1..4.out`, `frozen-inputs.sha256` | Request-plan identities (installed reader and package hashes, prompt hashes), run summaries, and the hashes of the rebuilt inputs. The inputs themselves are derived from the dataset and not committed; `scripts/build-reading-notes-inputs.ts` rebuilds them byte for byte. |
| `summary-2.json` | Item 2: correct counts for the frontier reader and arms a and b under both judges, paired tests, retrieval-complete subset, by type, tokens and cost. |
| `2/judged.ndjson.gz` | One row per question: answer, usage (including reasoning tokens), finish reason, route (Chat Completions or Batch), both judges. |
| `2/batch.json`, `batch-final.json`, `batch-files.sha256` | Batch submission and completion records, and the hashes of the batch input and output files. |
| `attribution/` | The post-hoc expansion attribution on the 40 development questions at gbrain `885bb91a1`: rows, call logs and logs per arm, and the opaque dataset copy's hash. |
| `scripts/` | Every executed script: drivers, orchestration, the reading-notes input builder, the frontier reader, the judges, the three analyses and the knob check with its output. |
