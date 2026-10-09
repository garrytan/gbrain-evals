# Scoped vector search at 1M to 2M chunks: deeper scans fix random scopes, topic-coherent ones still miss

## The finding

gbrain's Postgres vector arm lost most of its recall under selective scopes at production scale. With a
10% source or visibility scope, a `limit 50` search (what hybrid search issues) returned recall@50 of
0.52 to 0.63 on 1M and 2M synthetic chunks, and 0.64 to 0.77 on 1M real voyage-4 chunks. The cause was
the first pooled attempt's `hnsw.max_scan_tuples` of 2,000. It found about 200 eligible chunks, which
covered enough pages to be accepted but stopped short of the true neighbours. `ef_search`, the lever
the plan proposed (`search.hnsw_ef_search_floor`), barely moved it: at the GUC ceiling of 1,000,
random-scope recall@50 reached only 0.93 on real vectors.

The fix ships in gbrain: every pooled attempt now scans up to 20,000 tuples, pgvector's own default.
Measured on the same database against master:

| corpus | scope | recall@50, master → fixed | recall@10, master → fixed | p50 cost |
|---|---|---|---|---|
| synthetic 1M | random 10% source / visibility | 0.612 / 0.631 → **0.986 / 0.983** | 0.922 / 0.924 → 0.986 / 0.989 | +16 to 17 ms |
| synthetic 2M | random 10% source / visibility | 0.560 / 0.518 → **0.958 / 0.957** | 0.921 / 0.915 → 0.990 / 0.979 | +26 to 36 ms |
| voyage-4 1M Wikipedia | random 10% visibility | 0.765 → **0.970** | 0.916 → 0.990 | +17 to 32 ms |
| voyage-4 1M Wikipedia | topic-coherent 50% source | 0.852 → **0.951** | 0.875 → 0.959 | +5 to 13 ms |
| voyage-4 1M Wikipedia | topic-coherent 10% source | 0.638 → 0.777 | 0.629 → 0.837 | +31 to 41 ms |
| all | unscoped | identical | identical | none |

**Escalate-when-short was the other candidate.** It keeps the 2,000-tuple start but refuses a short
window. Its window stays short at every step, so it ends in the exact fallback. On synthetic data it
reached recall@50 0.65 to 0.75 with p95 up to 8.6 s. On real topic-coherent 10% scopes it reached 0.955,
but at 1.0 to 1.6 s per search.

**Topic-coherent selective scopes remain a gap.** When a scope covers a tenth of the brain and its
pages share topics, most queries come from other topics. The nearest in-scope chunks then sit outside
the region an HNSW scan reaches, and scanning 50,000 or 100,000 tuples left recall unchanged. Closing
that gap needs an exact or filter-first pass, about 1.0 to 1.6 s per search at 1M chunks, or per-source
indexes. Both are proposed, not shipped.

**A second fix ships with it.** Without planner statistics on `content_chunks(model, modality,
page_id)` and `pages(deleted_at, ...)`, the candidate statement sorted every eligible chunk instead of
walking the index. That is the state right after a bulk import, before autovacuum runs, because
gbrain's own refresh analyzed only two `pages` columns. At 1M to 2M chunks, 44% to 100% of 50%-scoped
searches ran past the 8 s budget and fell back to keyword only. Import, sync, reindex and embed drains
now refresh those columns. In that state the fixed code plans on HNSW at 1M and 2M with no incomplete
results.

**Index build options change neither result.** `ef_construction` 128 adds about 0.02 to 0.03
unscoped recall@10 for about 25% more build time. `halfvec` gives the same recall with an index a third
the size. The defaults stay, and both are recorded as candidates for a later migration.

The full record is in gbrain: `docs/eval/hnsw-scale-bench.md`, with the method, every table, the
EXPLAIN plans across statistics states, the build grid and the commands.

## Same-database comparisons

Synthetic-latent corpus, 1,024 dimensions, 100 queries, shipped `ef_search`, relaxed order:

| chunks | filter | k | master recall@k | escalate-when-short | fixed (20,000) | master p50 / p95 ms | escalate p50 / p95 ms | fixed p50 / p95 ms |
|---|---|---|---|---|---|---|---|---|
| 1M | none | 10 | 0.972 | 0.972 | **0.972** | 17.9 / 23 | 15.9 / 23.2 | 9.7 / 12.1 |
| 1M | none | 50 | 0.990 | 0.990 | **0.990** | 27.7 / 32.8 | 22.7 / 29.3 | 19.9 / 23.8 |
| 1M | source10 | 10 | 0.922 | 0.922 | **0.986** | 29 / 36.4 | 25.3 / 32.4 | 27.6 / 36.9 |
| 1M | source10 | 50 | 0.612 | 0.747 | **0.986** | 36.7 / 44.6 | 39.5 / 1342.8 | 54 / 62.5 |
| 1M | vis10 | 10 | 0.924 | 0.924 | **0.989** | 24.5 / 31.9 | 27.3 / 32.2 | 31.5 / 40.5 |
| 1M | vis10 | 50 | 0.631 | 0.715 | **0.983** | 40.1 / 104.5 | 49.3 / 8471.6 | 56 / 64.4 |
| 1M | source50 | 10 | 0.981 | 0.981 | **0.981** | 11.1 / 18.9 | 13.2 / 25.8 | 10.2 / 19.6 |
| 1M | source50 | 50 | 0.970 | 0.970 | **0.975** | 37.4 / 93.2 | 39.2 / 93.3 | 40.7 / 93.9 |
| 1M | vis50 | 10 | 0.981 | 0.981 | **0.981** | 13.3 / 24.3 | 13.2 / 23.8 | 13.4 / 22.9 |
| 1M | vis50 | 50 | 0.959 | 0.959 | **0.973** | 37.9 / 100.5 | 38.7 / 92.8 | 38.4 / 97.4 |
| 2M | none | 10 | 0.935 | 0.935 | **0.935** | 16 / 23.4 | 15.8 / 26 | 13.6 / 66.5 |
| 2M | none | 50 | 0.981 | 0.981 | **0.981** | 21.2 / 27 | 22.2 / 36.2 | 17.8 / 24.3 |
| 2M | source10 | 10 | 0.921 | 0.921 | **0.990** | 22.3 / 26.7 | 23 / 29.2 | 28.1 / 182.7 |
| 2M | source10 | 50 | 0.560 | 0.646 | **0.958** | 38.6 / 119.7 | 38.5 / 142 | 74.6 / 320.8 |
| 2M | vis10 | 10 | 0.915 | 0.915 | **0.979** | 23.5 / 27.2 | 22.7 / 25.6 | 29.1 / 41.3 |
| 2M | vis10 | 50 | 0.518 | 0.669 | **0.957** | 37.9 / 43.4 | 143.3 / 8592 | 63.5 / 125.7 |
| 2M | source50 | 10 | 0.928 | 0.928 | **0.928** | 16 / 20.2 | 16.2 / 22.6 | 15.6 / 24.1 |
| 2M | source50 | 50 | 0.962 | 0.962 | **0.979** | 28.9 / 90 | 28.3 / 104 | 28 / 102.2 |
| 2M | vis50 | 10 | 0.936 | 0.936 | **0.941** | 19.4 / 23.8 | 18.6 / 23.6 | 19.2 / 24.9 |
| 2M | vis50 | 50 | 0.963 | 0.963 | **0.981** | 31.8 / 84.7 | 32 / 86.5 | 32.4 / 114.5 |

1M English Wikipedia chunks embedded with voyage-4. The source scopes are whole k-means topic clusters
(10.4% and 50.5% of chunks); the visibility scopes are random. Recall@10 inside the `limit 50` call is in
parentheses:

| filter | k | master recall@k (@10 in call) | fixed recall@k (@10 in call) | escalate-when-short | master p50 / p95 ms | fixed p50 / p95 ms | escalate p50 / p95 ms |
|---|---|---|---|---|---|---|---|
| none | 10 | 0.968 (0.968) | **0.968** (0.968) | 0.968 | 12.9 / 19.9 | 11.5 / 21.3 | 17.3 / 31.5 |
| none | 50 | 0.981 (0.984) | **0.981** (0.984) | 0.981 | 23.4 / 38.9 | 22.8 / 27.8 | 25.7 / 32.4 |
| topic 10% (source) | 10 | 0.629 (0.629) | **0.837** (0.837) | 0.956 | 30.8 / 169.3 | 61.9 / 101.9 | 1577.9 / 1779.8 |
| topic 10% (source) | 50 | 0.638 (0.813) | **0.777** (0.889) | 0.955 | 50 / 1087 | 91 / 1078.1 | 1027.2 / 1138.9 |
| topic 50% (source) | 10 | 0.875 (0.875) | **0.959** (0.959) | 0.905 | 14 / 24.5 | 19 / 58.9 | 19.1 / 83.5 |
| topic 50% (source) | 50 | 0.852 (0.908) | **0.951** (0.974) | 0.913 | 29.5 / 47 | 42.7 / 97 | 31.2 / 6857.4 |
| random 10% (visibility) | 10 | 0.916 (0.916) | **0.990** (0.990) | 0.916 | 24.9 / 29.5 | 42.4 / 58.5 | 25 / 27.6 |
| random 10% (visibility) | 50 | 0.765 (0.939) | **0.970** (0.994) | 0.809 | 40.8 / 48.7 | 73 / 87.4 | 47.8 / 6535.8 |
| random 50% (visibility) | 10 | 0.957 (0.957) | **0.967** (0.967) | 0.957 | 13.6 / 24.9 | 18.4 / 32.5 | 14.4 / 24.1 |
| random 50% (visibility) | 50 | 0.945 (0.978) | **0.971** (0.986) | 0.945 | 30.7 / 41.6 | 37.9 / 58.1 | 32 / 43.6 |

## Method

- **Query path.** Every search calls gbrain's `PostgresEngine.searchVector`: the index walk, the pooled
  statement, escalations, the exact fallback and the incomplete signal. The bench is
  `scripts/bench/hnsw-iterative-scan.ts` in gbrain.
- **Truth.** For each query and scope, the exact per-page max-pooled top 100 is computed in float64 from
  the float4 values loaded. 15 queries per corpus were checked against gbrain's own exact statement, and
  the top-10 and top-50 sets matched every time.
- **Comparisons.** Each corpus is loaded once with the fixed tree. A master checkout and the
  escalate-when-short variant then run against the same database and index, so build variance (about
  ±0.02) does not enter the comparison.
- **Servers.** Ubicloud standard-16 (16 vCPU, 64 GB RAM), PostgreSQL 16.15 with pgvector 0.8.7,
  shared_buffers 16 GB, random_page_cost 1.1. The client runs on the same VM, single-threaded, with the
  index cached.
- **Real corpus.** English Wikipedia (`wikimedia/wikipedia`, 20231101.en, the first two shards): 207,185
  articles cut into 1,000,000 chunks of up to 1,200 characters (mean 920) by
  `scripts/bench/hnsw-real-corpus-prep.py`. Queries are the first sentence of random chunks, embedded as
  voyage-4 queries.

## Cost

| item | tokens | dollars |
|---|---:|---:|
| voyage-4 documents (1,000,000 chunks) | 217,838,741 | $13.07 |
| voyage-4 queries (100) | 3,409 | <$0.01 |
| **total** (cap $30, hard stop $28) | | **$13.07** |

Tokens are the provider-reported usage of every call. Dollars use gbrain's list price for voyage-4 ($0.06
per 1M tokens). Details are in [`2026-10-09-hnsw-scale/budget-ledger.json`](2026-10-09-hnsw-scale/budget-ledger.json).
Ubicloud compute was four standard-16 VMs for about 4.5 VM-hours in total, all destroyed after their runs.

## Files

- [`results-summary.json`](2026-10-09-hnsw-scale/results-summary.json): every cell of every run (scope,
  k, `ef_search`, scan budget, recall@k, recall@10, p50/p95/p99, short, incomplete, served-by, exact
  fallbacks), corpus statistics and index builds.
- [`budget-ledger.json`](2026-10-09-hnsw-scale/budget-ledger.json): the paid embedding calls.

## Limitations

- **One real corpus.** A personal brain's mail and notes may cluster differently from Wikipedia.
- **Scopes.** Scopes were either random or whole topic clusters. Real sources sit somewhere between.
- **Latency.** All latency is server-local. Production adds network round trips.
