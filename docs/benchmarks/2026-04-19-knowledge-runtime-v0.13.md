# Making a timeline searchable as soon as a page is saved

**Historical report: April 19, 2026.** Compared master v0.12.1 (`c0b6219`) with branch v0.13.0.0. All tests used synthetic data and in-process PGLite, without private data, external databases, API keys, or network calls.

Before this change, saving a page through the operation API did not necessarily make its dated events available to timeline queries. A separate extraction step was needed. After the change, the fixture's **40 expected events were queryable immediately**, up from zero.

The cost was additional write work. Average write latency rose from 2.00ms to 2.58ms. That is small in this test, but it is not free.

## Write latency

The test made 200 `put_page` operation calls. Half the pages contained three timeline entries; ten seed pages supplied targets for automatic links. Script: `test/benchmark-put-page-latency.ts --json` in the historical gbrain checkout.

|  | master (v0.12.1, c0b6219) | branch (v0.13.0.0) | Δ |
|---|---:|---:|---:|
| mean | 2.00 ms | 2.58 ms | **+0.58 ms (+29%)** |
| p50 | 1.92 ms | 2.31 ms | +0.39 ms (+20%) |
| p95 | 2.56 ms | 3.57 ms | +1.01 ms (+39%) |
| p99 | 3.46 ms | 13.44 ms | +9.98 ms (+288%) |
| max | 10.89 ms | 14.34 ms | +3.45 ms |
| timeline entries extracted | **0** | **300** | +300 |

The new path created 300 timeline entries. Median latency rose by 0.39ms and P95 by 1.01ms. P99 rose from 3.46ms to 13.44ms, nearly fourfold, not twofold. The original report suggested batch-flush variation as a cause, but did not isolate it. The measurements show the tail change; they do not establish its cause.

## Can a user query what they just wrote?

The `ttq` part of `test/benchmark-knowledge-runtime.ts` wrote twenty pages through the operation API and immediately queried each page's timeline for forty expected events.

|  | queryable right after ingest |
|---|---:|
| branch (auto_timeline on, default) | **40/40 (100%)** |
| master (auto_timeline off, current behavior) | 0/40 (0%) |

This is a concrete improvement in the write workflow: an agent can save a dated note and ask about that date without remembering a second command. It says nothing about whether every date in arbitrary prose will be extracted correctly.

## Repair decisions with a simulated resolver

The integrity test supplied fifty pages with social-post phrases and `x_handle` metadata. Its fake resolver was deliberately programmed to return 70% high-confidence, 20% medium-confidence, and 10% low-confidence matches.

|  | count | % |
|---|---:|---:|
| auto-repair (confidence ≥ 0.8) | 35 | 70% |
| review queue (0.5 ≤ c < 0.8) | 10 | 20% |
| skip (c < 0.5) | 5 | 10% |

A score of at least 0.8 triggered automatic repair; 0.5–0.8 sent the item for review; lower scores skipped it. Getting 35/10/5 verifies the routing rules against the fake inputs. It does not measure the accuracy of a real API resolver or show that its confidence scores are calibrated.

## What the health check found

The doctor test planted seven issues: three social-post phrases over two pages, three external-link citations, and one page with `validate: false` that should be skipped. The scanner reports at most one phrase issue per line.

|  | count |
|---|---:|
| issues planted | 7 |
| should surface | 6 |
| grandfathered (correctly skipped) | 1 |
| **surfaced** | **5 (83%)** |
| bare tweets caught | 2/2 lines |
| external links caught | 3/3 |
| grandfathered page respected | 1/1 |

The recorded table says five of six expected issues surfaced, or 83%. The accompanying procedure counts two reportable phrase lines plus three external links, which gives five reportable items and five found. These are different denominators. Keep the original table, but describe the result as “all five reportable lines/links found, with one opted-out page respected,” rather than claiming an unexplained universal 100% completeness rate.

## Checks that stayed the same

The graph test used eighty fictional pages and thirty-five relationship questions across seven categories:

| metric | master | branch | Δ |
|---|---:|---:|---|
| link_recall | 0.889 | 0.889 | 0 |
| link_precision | 1.000 | 1.000 | 0 |
| type_accuracy | 0.889 | 0.889 | 0 |
| timeline_recall | 1.000 | 1.000 | 0 |
| timeline_precision | 1.000 | 1.000 | 0 |
| relational_recall | 0.900 | 0.900 | 0 |
| relational_precision | 1.000 | 1.000 | 0 |
| idempotent_links | true | true | = |
| idempotent_timeline | true | true | = |

Those values were identical across versions. The test called `engine.putPage()` and explicit extraction, bypassing the operation handler changed here. It is a useful check on the paths exercised, not proof that every other feature was unaffected. “Idempotent” means that repeating extraction did not add duplicates.

The search test used thirty pages, twenty graded questions, and three settings: baseline, boost only, and boost plus intent classification.

| metric | A (baseline) | B (boost) | C (full) | Δ master→branch |
|---|---:|---:|---:|---|
| P@1 | 0.947 | 0.895 | 0.947 | 0 |
| P@5 | 0.811 | 0.674 | 0.695 | 0 |
| MRR | 0.974 | 0.939 | 0.974 | 0 |
| nDCG@5 | 1.191 | 1.028 | 1.069 | 0 |

The historical nDCG values above exceed 1.0. A correctly normalized nDCG is bounded by 1.0, so these values should be retained only as historical output, not interpreted as valid normalized quality scores. The unchanged table records what the old helper emitted.

## Reproduction and historical summary

The four original scripts completed in under thirty seconds combined:

```bash
# From this branch
bun run test/benchmark-put-page-latency.ts --json
bun run test/benchmark-knowledge-runtime.ts --json
bun run test/benchmark-graph-quality.ts --json
bun run test/benchmark-search-quality.ts

# Compare against master
cd /path/to/gbrain-master-worktree
# (copy benchmark-put-page-latency.ts and benchmark-knowledge-runtime.ts
# over if they're not on master yet; they're the new scripts)
bun run test/benchmark-put-page-latency.ts --json
bun run test/benchmark-graph-quality.ts --json
bun run test/benchmark-search-quality.ts
```

The original summary is preserved here. Read “free,” “100%,” and “unchanged” with the measurement limits explained above.

| benchmark | moves? | direction |
|---|---|---|
| put_page latency | yes | +0.5ms cost for 300 free timeline entries per 200 writes |
| time-to-queryable | yes | 0% → 100% |
| integrity repair rate | new | n/a on master, 70/20/10 split delivered |
| doctor completeness | new | 0% → 100% on real issues |
| graph quality | no | unchanged, as designed |
| search quality | no | unchanged, as designed |

The useful result is immediate availability of extracted dates after a page write. Repair accuracy with a real resolver, wider prose coverage, and the write-latency tail each need their own measurements.
