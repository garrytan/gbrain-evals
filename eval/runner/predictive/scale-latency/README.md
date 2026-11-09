# Scale latency

This runner measures how long gbrain's agent-facing operations take on a brain the size of a real one. It builds a synthetic brain of any size (the target is 300,000 pages), then times query, search, get, entity, recall, remember and sync through gbrain's own tool dispatcher, the path an agent's tool call takes. It also counts statement-timeout fall-opens: searches where gbrain's Postgres keyword statement ran past `search.keyword_statement_timeout_ms` and the search answered from the vector side alone.

Small test brains answer in milliseconds, while the counted latencies on Wintermute (the agent that runs on Garry Tan's own brain) are seconds at the median and tens of seconds at p95. The question this runner asks is how much of that gap comes from size alone.

## What it builds

- **Pages.** `build.ts` generates fictional people, companies, projects, meetings and notes from a seeded generator (seed 55 by default). Words come from an invented vocabulary with a Zipf curve, so the commonest terms match a large share of the brain, as common words do in a real one. That matters because broad keyword terms are what push a keyword statement into its timeout. The test pins a digest of the first 200 pages.
- **Vectors.** gbrain's embedding transport is replaced inside the process: each chunk gets a seeded random unit vector at gbrain's default width (`DEFAULT_EMBEDDING_DIMENSIONS`, 1024 for `voyage:voyage-4` at the pinned gbrain, 0.60.557.0). No embedding provider is called.
- **Writes.** Pages go in through gbrain's own importer (`importFromContent`), so chunking, triggers and index maintenance are gbrain's.
- **Search config.** Nothing is configured. The brain keeps what gbrain resolves by default (`resolveSearchMode`), and the scorecard records it: at the pin, mode `balanced`, reranker `voyage:rerank-3-lite` on, expansion off, keyword statement timeout 8,000 ms on Postgres.
- **Resume.** The load runs in batches (1,000 pages by default). After each batch the checkpoint file names the last finished batch, so a rerun with the same settings continues from there. A rerun with a different seed, size, batch size or width is refused.

## What it measures

`probe.ts` runs query, search, get, entity, recall and remember round-robin as a remote stdio caller, after an untimed warmup, and sync (local only) as one incremental sync of one new note in a scratch git repository. Arguments come from the same seeded generator, so the same seed asks the same questions. Calls run inside gbrain's AI invocation guard, which allows only embedding and rerank calls, and the in-process transports answer those. The reranker is a token-overlap stand-in. So the numbers carry no provider latency.

The scorecard (`gbrain-evals/scale-latency-scorecard/v1`) holds:

| Field | Meaning |
|---|---|
| `pages`, `chunks` | Live pages and chunk rows in the brain when the probe ended |
| `embedding_dim`, `embedding_model` | The width and model identity the vectors were written at |
| `gbrain_version`, `engine` | The gbrain code loaded, and `pglite` or `postgres` |
| `search_config` | Resolved mode, reranker, expansion and keyword statement timeout |
| `ops.<op>` | `n` timed successful calls, `p50_ms`, `p95_ms` (`percentile` in `eval/runner/metrics.ts`), `errors` |
| `statement_timeout_fall_opens` | Retrieval meta entries `keyword_arm_failed` with reason `timeout` or `skipped_after_timeout`; `fall_opens_by_op` splits them |
| `degraded_stages`, `ai_refused` | Every degraded stage seen, and any AI call kind the guard refused |
| `calibration` | The factor-of-2 comparison below |

## Calibration, and the predictive test

The `calibration` block compares each p50 and p95 with Wintermute's counted values and marks whether both are within a factor of 2:

| Operation | Counted p50 | Counted p95 |
|---|---|---|
| query | 10.1 s | 30.1 s |
| search | 9.8 s | 30.4 s |
| get | 2.8 s | 10.9 s |
| remember | 8.2 s | 42.7 s |
| sync | 3.7 s | 120 s |

Entity and recall have no counted reference. This match is calibration only: it says whether the synthetic setup is in the right range, and it cannot validate itself (gate change D1). The predictive test is one held-out latency contrast, named in the preregistration before it runs: the same synthetic brain at gbrain 549 against 570, or one knob changed (for example the keyword statement timeout), with the synthetic difference checked for sign agreement against the real one through `eval/runner/predictive/validity.ts`.

A keyless scorecard has no provider time in it, so its query and search numbers sit below the counted ones by roughly the embedding and rerank round trips. Read its calibration block with that in mind.

## Run it

Keyless, in memory (a quick smoke; the test uses 1,000 pages):

```bash
bun eval/runner/predictive/scale-latency/probe.ts --pglite --pages 500 --out eval/reports/scale-latency/smoke.json
```

Against a scratch Postgres with pgvector (the database is written to; never point it at a real brain):

```bash
export SCALE_LATENCY_DATABASE_URL=postgresql://<user>@127.0.0.1:5432/<scratch db>
bun eval/runner/predictive/scale-latency/build.ts --database-url-env SCALE_LATENCY_DATABASE_URL \
  --pages 300000 --checkpoint eval/reports/scale-latency/checkpoint.json
bun eval/runner/predictive/scale-latency/probe.ts --database-url-env SCALE_LATENCY_DATABASE_URL \
  --checkpoint eval/reports/scale-latency/checkpoint.json --n 200 --sync-n 30 --out eval/reports/scale-latency/scorecard.json
```

The same URL in `SCALE_LATENCY_DATABASE_URL` turns on the opt-in Postgres case in `test/eval/predictive-scale-latency.test.ts` (300 pages).

On a Ubicloud VM, which costs money and so needs an open budget-ledger run:

```bash
bun eval/runner/predictive/scale-latency/ubicloud.ts --paid --budget-run-id <id> --owner <thread code> --pages 300000
```

`ubicloud.ts` follows gate change J1. It refuses without `--paid` and `--budget-run-id` (`eval/runner/paid-arm.ts`). It writes the VM's name to its state file before the create request, tears every recorded VM down in a finally path, retries a failed attempt at most twice (reusing the VM, so the build resumes from its checkpoint there), and on failure reports `partial` with every VM id and whether it was torn down. A rerun adopts a VM that a dead controller left in the state file if it still answers ssh. `vm-setup.sh` installs Postgres 16 with pgvector (8 GB shared buffers), a loopback-only scratch database and bun on the VM. The Ubicloud client is injectable, and the tests drive a fake that fails.

## Limits

- No provider latency is included. Sampling real Voyage rerank and embedding round trips belongs in a paid window and is not part of this runner yet.
- Page shapes are synthetic: a few hundred words, Zipf words, no links between pages. A real brain's long pages, links and facts may change these numbers.
- Sync times a one-note change in a side repository, not a sync of the brain's own repository.
- Postgres settings on the VM are chosen here (`vm-setup.sh`), not copied from the production database.
- Running a second gbrain pin needs that pin installed as its own alias (gate change H1); `build.ts` and `probe.ts` accept `--gbrain <checkout>@<ref>` for a local checkout.
