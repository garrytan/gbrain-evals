# LHF wave 2: measured verdicts

gbrain v0.60.259.0 (garrytan/gbrain#6822, GBRA-107). Each performance item was checked with the item G
contract-parity harness (`bun run bench:parity <base-ref>`): a 400-page fixture brain built once from the base
tree, then the same 79 MCP calls on each tree, comparing every response block, `_meta` field and database write.
Only timings may differ.

## The integrated wave against master v0.60.257.0 (9a49032e0)

| Engine | Parity | Statement round trips, 79 calls (master → wave) |
|---|---|---|
| PGLite | CLEAN | 8106 → 6277 |
| Postgres 16 | CLEAN | 6008 → 3580 |

Latency at 30 ms RTT (toxiproxy, Postgres, interleaved over 2 rounds, wave tree against master 7f3c9f5f before
the last master merge): search p50 1721 → 879 ms, query 1880 → 974 ms. Pool contention (pool sizes 2 and 6,
eight concurrent searches plus a small write, 3 interleaved runs): zero errors, p95 no worse than master.

## Shipped

| Item | Verdict | Evidence |
|---|---|---|
| 0: `tokenmax` `query` stops expanding | Shipped (Garry approved the flip) | GBRA-94 re-run: retrieval 298 vs 299 of 300; query p50 2022 → 227 ms |
| G: contract-parity harness | Shipped | Self-test clean on both engines; the `--perturb` run fails as it should |
| 1: typed-search type check without JIT | Shipped | Postgres 20k pages, jit on, median of three rounds: hit 729 → 154 ms, miss 734 → 183 ms at RTT 0; hit 2522 → 1945 ms at RTT 30. jit off: within noise |
| 3: cosine re-score in SQL | Shipped | Max abs difference SQL vs JS: PGLite cosine 8.8e-7, score 2.6e-7; Postgres cosine 2.7e-7, score 8.2e-8 (tolerances 5e-6 / 2e-6) |
| 5: fewer serial round trips (from #6734) | Shipped | Per call, Postgres search 74.5 → 44 and query 75 → 47 round trips; RTT 30 search p50 1724 → 890 ms (faster in 80 of 80 calls), query 1892 → 1032 ms |
| 6: ANALYZE after index builds | Shipped; latency win not reproduced | ANALYZE fixes the title-arm estimate (275 rows → 1) but the 55k-page entity-names batch is unchanged (2495 vs 2555 ms; 2469 vs 2396 ms). ANALYZE cost at 55k: about 319 ms PGLite, 800 ms Postgres. The remaining cost is filed as a lead (`readIdentitySiblings`) |
| 7: federated vector walk key probes (from #6747) | Shipped | Plan tests fail without the fix on both engines. Timing flat on synthetic brains (10k pages, two sources: Postgres p50 12.95 vs 13.9 ms, PGLite 12.75 vs 12.25 ms); the reporter's pathological plan did not reproduce synthetically |
| 11: TODO bookkeeping, 20k scale ceiling | Shipped | Nightly run 38708604843: 36.3 ms at 20k vs 68.4 ms at 10k |

## Dropped by their own gates

| Item | Verdict | Evidence |
|---|---|---|
| 2: saved-facts trigram index | Dropped | Lookups 5-7x faster (PGLite 167 → 23 ms at 100k facts), but every index configuration failed the +25% insert gate: `fastupdate=off` cut batch throughput 45%; pending lists of 256k-1MB cut it 11-37% and added 15-30 ms flush stalls |
| 9: attendance paraphrases | Dropped | Development split 0 → 150 of 150, but the 30 held-out questions fired 18 of 90 runs (master 6 of 90) against the preregistered 80% floor. See [the preregistration and verdict](../../benchmarks/2026-10-16-lhf-wave-2-attendance-preregistration.md) |
