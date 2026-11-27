# gbrain's Rust engine at v0.60.777.0: the counted engine-bench wave

- **We learned that PGLite and Postgres give the same answers at gbrain v0.60.777.0.** On LongMemEval-S, both engines returned the same top 5 on all 470 scored questions in every arm, with recall_all@5 of 0.811 (keyword), 0.917 (vector) and 0.906 (hybrid). They passed the same correctness checks, matched on 301 of 302 CLI, MCP and markdown outputs (the one difference is the known `stale` field), and scored the same on the 14 scored gate suites gbrain's design plan names. The 15th, Cat 7, records only latency and throughput, where the two engines differ as expected. If you run gbrain on either engine today, this release behaves the same on both.
- **We learned that the Rust engine at this release is not ready to hold a brain yet.** gbrain's own page write refuses on a Rust brain (`engine_capability_missing`), so every stage that writes through gbrain's import or write path failed at that first write. Cat 7, which writes through the engine directly, completed its timing runs on Rust. Rust passed 3 of the 15 gate suites (Cat 10, Cat 4 and the reported Cat 7). The eval-gates file reads **E1 FAIL, E2 FAIL and E3 FAIL**, and swap readiness criterion 8 was not run, because Rust stored no pages to time. gbrain's maintainers describe this as the gap between gbrain's master branch and its `rust-engine` branch, where the engine is further along. It is not a regression we diagnosed.
- **You should keep Rust off for real brains on this release and wait for the second wave.** It runs on the first master release that carries the Rust engine trunk, under a later amendment to the [preregistration](2026-11-17-engine-bench-preregistration.md).

## The build and why it was counted

The counted wave measured gbrain v0.60.777.0 (tag commit [`d8eb3576`](https://github.com/garrytan/gbrain/tree/d8eb35769120cf0b60704478aaef96a412ee0009)), with the release's Rust addon for linux-x64-glibc (SHA-256 `d325d17502bda4dd3ebcd73ff73a45e15016e87823a0c50cd4bb9261d4748d74`, 53,108,048 bytes). Every VM checked the tag, the checkout and the addon digest before its first counted cell ([preflight/](2026-11-27-engine-bench/preflight/)).

This build misses the preregistered trigger, which asks for a build that serves gbrain's own import and search on Rust. gbrain's maintainers named it anyway. Ember (Vorflux), 2026-11-27 00:40Z: "v0.60.777.0 stands for the Nov 27 delivery as I read it". By their account, the release candidate piloted earlier (b66e4077) came from gbrain's `rust-engine/main` branch, which serves `readManagedModeRows`, transactions and `access_control`. Master serves none of them yet. gbrain#10372, #10409, #10410 and #10411 bring them to master, followed by the next Rust snapshot. The [2026-11-27 amendment](2026-11-17-engine-bench-preregistration.md#2026-11-27-the-named-build-is-gbrain-v0607770-counted-at-the-maintainers-request-although-it-does-not-meet-the-build-trigger) records the reasoning: the eval-gates file gbrain pins for its Dec 1 opt-in swap needs a counted verdict on the build the maintainers named.

## Results

**The eval-gates file.** [`eval/results/engine-bench/eval-gates/v0.60.777.0/8e36959c52cf4f327d1a20f634cde2e20b9069ae.json`](../../eval/results/engine-bench/eval-gates/v0.60.777.0/8e36959c52cf4f327d1a20f634cde2e20b9069ae.json) is FINAL. It names gbrain_tag v0.60.777.0, gbrain_commit d8eb3576, the addon digest above, target linux-x64-glibc and evals_commit 8e36959c, and it links its 19 input receipts by SHA-256. It sets `engine_format_version` to 7. Each row's `threshold` quotes RUST_ENGINE.md's wording (Cat 12 "50/50", Cat 24 "5/5"). The rule actually applied is the preregistered reading beside it: 24 of 24 for Cat 12 and 7 of 7 for Cat 24. The counted receipts do not record that number, so it was read from the `FORMAT` file of a Rust store that `gbrain init --migrate-only` created at d8eb3576 with the same addon bytes, in a keyless run.

| Gate | Verdict | What decided it |
|---|---|---|
| E1 | FAIL | LongMemEval-S: Rust errored on all 470 questions in every arm, against both TypeScript engines. Cat 13b and Cat 12 (18 of 24) failed, and Cat 13 also failed (reported only). Cat 10 passed 133 of 133. Cat 7 ran on all three engines (reported; Rust was slower on 22 latency rows). |
| E2 | FAIL | BrainBench Cats 1+2, Cat 3 and type accuracy: Rust left no receipt. Cat 24 scored 1 of 7 and memory-verb conformance 0 of 24. Cat 4 passed 114 of 114. |
| E3 | FAIL | Cats 22, 19, 27 and 23: Rust did not run, or scored no gates. |
| Criterion 8 (speed, reported) | not run | Rust refused at import, so no operation class has a Rust pair. |

**Correctness (stage 1).** PGLite and Postgres passed N1, N5, N6, N12 and N14, and Postgres also passed N6 over HTTP, which the runner does not run on PGLite or Rust. On Rust, N1 and N5 stopped at `readManagedModeRows` (persistence_journal), N6 at `transaction` (transactions) and N12 at `getLinks` with the `temporal` option (links). N14 failed because Rust stored no page: its native write refused with persistence_journal. N14's recall on Rust stays reported-only on this build, as the amendment sets out.

**Output bytes (stage 2).** Rust's import of the fixed corpus errored, so it produced no outputs to compare. PGLite and Postgres matched on 55 of 56 CLI outputs, all 47 comparable MCP outputs and all 199 markdown outputs.

**Answers (stage 3).** LongMemEval-S, 470 scored questions, 4 workers, each checking the embedding cache's digest before it started. Rust errored on every question, so each arm's paired lower bound, Rust minus each TypeScript engine, sits far below -0.018 (for keyword, -0.847 against both). PGLite and Postgres tied exactly on all 470 questions in each arm.

| Arm | PGLite recall_all@5 | Postgres recall_all@5 | Rust |
|---|---|---|---|
| keyword | 0.811 | 0.811 | errored on 470 of 470 |
| vector | 0.917 | 0.917 | errored on 470 of 470 |
| hybrid | 0.906 | 0.906 | errored on 470 of 470 |

**Gate suites.** One VM ran each suite once per engine at the same commit and addon digest. Rust's failures name their refused calls in each suite file under [gate-suites/](2026-11-27-engine-bench/gate-suites/). The most common is `readManagedModeRows` at `core/persistence/maintenance.ts:59`, reached from gbrain's import path (`core/import-file.ts:347`). Cat 12 records 54 refusals on Rust across the `graph`, `pages`, `keyword_search`, `chunks` and `raw_sql` capabilities.

**Remote callers.** Registering an OAuth client on a Rust brain (`gbrain auth register-client`) refuses with `engine_capability_missing` (raw_sql) at `oauth-provider.ts:1114`, so a Rust brain cannot serve remote MCP callers on this build. That is a named gap under item 7 of the 2026-11-20 amendment.

**Speed, PGLite against Postgres.** The speed arm ran at 10,000 pages ([speed/](2026-11-27-engine-bench/speed/)). Postgres had lower `put_page` latency (median 36.1 ms against 50.0 ms) and was faster on graph walks and backlinks. It also handled more reads and writes once several clients ran at once: at 16 clients, 293 reads per second against PGLite's 16, and 268 pages written per second against 58. With one client, PGLite wrote faster (54 pages per second against 27). Single-page reads were about equal (median 2.10 ms on Postgres, 2.05 ms on PGLite).

## Reproduce

From the repository root at 8e36959c, with Bun and Docker and a gbrain checkout with tags. Set `GBRAIN_RUST_ENGINE_ADDON` to the addon file and `GBRAIN_RUST_ENGINE_ADDON_SHA256` to its digest, `PG` to a pgvector Postgres admin URL (`LIFECYCLE_PG_URL` for the gate suites), and `GB` to `<gbrain checkout>`. The LongMemEval-S workers also need the dataset and the embedding cache whose digests the amendment names:

```sh
P=docs/benchmarks/2026-11-17-engine-bench-preregistration.md
bun eval/runner/engine-bench/correctness.ts --prereg $P --engines pglite,postgres,rust --gbrain "$GB@v0.60.777.0" --pg-url "$PG"
bun eval/runner/engine-bench/surface-parity.ts --prereg $P --engines pglite,postgres,rust --gbrain "$GB@v0.60.777.0" --pg-url "$PG"
for W in 0 1 2 3; do  # one worker per VM in the counted run
  bun eval/runner/engine-bench/lme-recall.ts run --prereg $P --engines pglite,postgres,rust --arms keyword,vector,hybrid --gbrain "$GB@v0.60.777.0" --pg-url "$PG" \
    --dataset "$DATASET" --cache "$CACHE" --worker-id $W --total-workers 4 --out lme-w$W.json --ndjson lme-w$W.ndjson
done
bun eval/runner/engine-bench/lme-recall.ts aggregate --ndjson lme-w0.ndjson,lme-w1.ndjson,lme-w2.ndjson,lme-w3.ndjson --out aggregate.json
bun eval/runner/engine-bench/perf.ts --scale 10000 --engines pglite,postgres,rust --prereg $P --gbrain "$GB@v0.60.777.0"
RUN_ID=$(bun eval/runner/budget-ledger.ts open --runner engine-bench-gate-suites-v0.60.777.0 --budget-usd 1 | tail -1)
bun eval/runner/engine-bench/gate-suites.ts run --gbrain "$GB@d8eb35769120cf0b60704478aaef96a412ee0009" --engines pglite,postgres,rust --paid --budget-run-id "$RUN_ID" --budget-usd 1 --embed-cache-dir "$EMBED_CACHE_DIR"
bun eval/runner/budget-ledger.ts close --budget-run-id "$RUN_ID"
bun eval/runner/engine-bench/gate-suites.ts emit --out "$SUITES_DIR" --counted
bun eval/runner/engine-bench/eval-gates.ts --engine-format-version 7 --answers aggregate.json --speed <speed receipt> --correctness <correctness receipt> --surface-parity <surface-parity receipt> --suite "$SUITES_DIR"/<suite>.json ...
```

The gate-suite stage's only paid calls are Cat 13 and Cat 13b's OpenAI embeddings, made once by PGLite under the budget ledger. Every other stage is keyless. The raw receipts, per-question rows and logs are in [2026-11-27-engine-bench/](2026-11-27-engine-bench/). Paths on the run machines appear in the logs as they were printed.

## Disclosures

- gbrain is Garry Tan's own project.
