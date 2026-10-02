# Faster hermetic arms: N9 runs in 47 seconds, N2 stays at about 74

**Finding.** On October 2, 2026, at gbrain `d44296c`, the N9 hermetic arm dropped from about 130 seconds to 47 seconds with no change to what it measures. N2 could not get under 60 seconds without shrinking the seeded world, so it is unchanged and this note records why.

## N9: one process per ingestion seed

N9 asks whether gbrain's relationship retrieval helps questions that chain two or three relations, in wording its parser never saw ([report](2026-10-01-n9-multi-hop.md)). The hermetic arm builds a fresh keyword index three times, once per ingestion order (seeds 1, 2 and 3), and runs 540 questions with relationship retrieval off and on over each: 3,240 searches. Ingestion order matters: in the October 2 receipt 18 of the 250 composed question wordings score differently across seeds, so dropping seeds would lose information.

The seeds share nothing, so each now runs in its own child process and the parent merges the rows in seed order. Nothing was dropped. A serial run and a parallel run produced receipts that are identical field by field once timing fields, index ids, execution identity and hashes are set aside. The only differing field in the raw receipts is `hashes.runner`, because the runner file changed. `--serial-seeds` restores the old behavior, and the paid arm stays serial because it shares one query-embedding cache and one budget ledger run.

| N9 hermetic arm, alone on a 4-core machine | Wall time | Questions x wordings x seeds x arms |
|---|---:|---:|
| Serial (before) | about 120 s alone; 130 s in the offline tier | 540 x 3 x 2 = 3,240 searches |
| One process per seed (now) | 47 s | the same 3,240 searches |

The trade is CPU for wall time: the arm now uses three cores for about 45 seconds instead of one core for two minutes. CI's offline tier runs two categories at a time on a 4-core runner.

## N2: why it stopped

N2 seeds 825 fictional company pages through gbrain's `put_page` and then runs gbrain's contradiction probe ([report](2026-10-01-n2-contradiction-surfacing.md)). In the October 2 offline-tier receipt the stages took:

| N2 stage | Time |
|---|---:|
| Seeding 825 pages through `put_page` | 49.3 s |
| Oracle-judge probe over 270 supplied queries | 14.4 s |
| Throwing-judge probe | 1.6 s |
| Everything else (generic queries, `find_contradictions` read-back, development pairs) | 8.3 s |
| Total | 73.6 s |

Each `put_page` costs about 55 ms and the cost does not grow with the brain: 5.5 to 5.8 seconds per 100 pages from the first hundred to the last. A CPU profile of 200 writes puts about half the time inside PGLite statement execution and the rest in gbrain's write path. PGLite runs synchronously in one thread, so concurrent writes in one process do not overlap, and the probe needs every page in one database, so the seeding cannot be split across processes. Wrapping all writes in one outer transaction hung on gbrain's page-key locks and was abandoned.

The seeding plus the two gating probes already take about 65 seconds. The remaining options shrink the world: fewer distractor profiles or fewer planted pairs. Either changes the 150-conflict denominator of N2's preregistered candidate-recall floor, which is a different test, so N2 stays as it is. A faster write path in gbrain would shorten it without any change here.

## Reproduce

```bash
bun eval/runner/n9-multi-hop-paraphrase.ts --output /tmp/n9-parallel
bun eval/runner/n9-multi-hop-paraphrase.ts --serial-seeds --output /tmp/n9-serial
bun eval/runner/n2-contradiction-surfacing.ts   # data.timings_ms in the receipt
```

Cost: $0. The comparison hashes, timestamps and N2 timings are in [evidence.json](2026-10-02-hermetic-arm-trims/evidence.json). The two N9 receipts are 1.4 MB each and are not committed; rerun the commands above to regenerate them.
