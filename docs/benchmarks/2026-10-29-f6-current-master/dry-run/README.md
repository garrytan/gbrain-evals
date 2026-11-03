# F6 dry run (public data, at most $60)

The F6 dry run went through the real launch path: one Ubicloud VM per unit (UBI_OWNER=gbra240), the metering proxy and
the campaign ledger. It used public data only: BEAM-1M dev conversation 1m-16 (10 questions) and LoCoMo conv-44 (20
questions), three readers (claude-opus-5-5, claude-sonnet-5-5, gpt-6.1-sol) and the canonical judges. These scores
come from 10 and 20 questions. They test the harness and say nothing about the scoreboard. The aggregates are in
`summary.json`.

Spend: **$31.17 of the $60 cap**, counted against F6's $3,100. Every VM was destroyed when its unit ended.

## Runs

| Cell | Run | Lease | Spent | Requests | Outcome |
|---|---|---:|---:|---:|---|
| s2b-ingest.gbrain-defaults.f6-master | r1, tree 5e5f5721 | $12.64 | $7.96 | 9,209 | complete, but every row `ingest_degraded` (harness bug 1 below); superseded by r2 |
| s2b-ingest.ext-temporal-graph.shipped-0.31 | r1, tree 5e5f5721 | $15.20 | $5.14 | 10,705 | 30 of 30 answers scored, readiness probe found |
| s3-smoke.gbrain-defaults.f6-master | r1 | $23.64 | $0.00 | 0 | launcher stopped while its VM was being created; lease closed unstarted at $0 |
| s2b-ingest.gbrain-defaults.f6-master | r2, tree 15430482 | $14.02 | $8.07 | 9,102 | 210 of 210 answers scored, readiness probe found |
| s3-smoke.gbrain-defaults.f6-master | r2, tree 15430482 | $23.68 | $10.00 | 1,317 | 420 of 420 answers scored, readiness probe found |

r2 is campaign `q1-scoreboard-f6-current-master-dry-run-r2`, with its own ledger and a $46 cap so the two campaigns
together stay within $60. The temporal graph's r1 cell ran code that r2 did not change for it, so it was not rerun.

## Measurements (they replace the F6_ASSUMPTIONS placeholders in commit 15430482)

| Quantity | Measured | Was assumed |
|---|---:|---:|
| gbrain extraction, model tokens per conversation token (claude-haiku-5-5) | 4.31 in, 1.15 out | 1.6 in, 0.12 out |
| gbrain extraction dollars per million conversation tokens | $0.83 metered; $1.07 by gbrain's own ledger | $0.22 |
| gbrain saved facts per million conversation tokens | 4,887 (r2), 4,985 (r1) | 2,500 |
| gbrain ingest dollars per million tokens beyond extraction (voyage-4) | $0.08 | $0.12 |
| gbrain ingest hours per million tokens (page ingest plus serial extraction on PGLite) | 1.92 | 2.5 |
| temporal graph 0.31.2 ingest dollars per million tokens | $4.01 | $7.30 |
| temporal graph 0.31.2 ingest hours per million tokens | 2.26 | 3.53 |

On 1m-16 (926,773 tokens, 928 sessions) gbrain's build took 6,298 s, almost all of it extraction. It covered 928 pages
and 1,047 segments, with 0 failed pages. r1 ran under a $1 cap and gbrain's ledger charged $0.99855. r2 ran under a $2
cap, charged $0.991868 and processed the same 1,047 segments. So r1 did not stop on its cap, and the cap rule (twice
the extraction estimate, at least $1) now gives $2 for this conversation.

### Per-answer dollars (8,000-token reader budget)

| Model | BEAM-1M (S2b) per call | LoCoMo (S3) per call |
|---|---:|---:|
| claude-opus-5-5 reader | $0.0568 | $0.0433 |
| claude-sonnet-5-5 reader | $0.0242 | $0.0191 |
| gpt-6.1-sol reader | $0.0177 | $0.0149 |
| BEAM judge gpt-4.1-mini, per answer | $0.0028 | |
| LoCoMo judge gpt-4o-2024-08-06, per answer | | $0.0008 |
| gbrain rerank-3-lite, per query | $0.0005 | $0.0004 |

When two arms deliver byte-identical contexts, they share one reader call. That is why S2b made 67 calls per reader
for 70 answers, and S3 made 124 for 140.

### Policy switches

An overlay switch costs about 8.4 s (docker test at the pin: 8,217, 8,514 and 8,370 ms). With policy-major retrieval
that is six switches per conversation for seven arms.

## Harness errors found and fixed

1. **Readiness barrier on F6 stacks (fixed in 8bb7ed12).** The barrier read under Q1's fixed-evidence policy. On an
   F6 stack that reads under whichever overlay was written last. Its rank-1 saved-fact row failed the rerank check,
   the shim answered 503 twice, and the probe counted a miss. So every r1 gbrain row was `ingest_degraded` even
   though 0 of 928 sessions failed. The barrier now reads under the cell's first arm identity. r2: probe found, 0
   degraded rows.
2. **Receipt versions (fixed in df77fd60).** F6 receipts named Q1's build (f05943e6, Bun 1.4.2). They now name the
   image's pin (0ccf2bdd, gbrain 0.60.493.0) and Bun 1.4.4.

Recorded, not errors:

- One ECONNRESET on the anthropic route during r1 extraction. gbrain retried it, the proxy reported 0 failed, and the
  build finished ok.
- The temporal graph's extractor sometimes returned invalid JSON or an out-of-range index. The product retried these
  itself: 0 failed sessions.
