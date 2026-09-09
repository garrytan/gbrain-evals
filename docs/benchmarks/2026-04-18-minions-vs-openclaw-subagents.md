# What a persistent worker saved on small agent jobs

**Historical run: April 18, 2026.** Branch `garrytan/minions-jobs`; Minions v0.11.0, PR #130; OpenClaw 2026.4.10 (`44e5b62`). Tests lived in gbrain's `test/e2e/bench-vs-openclaw/`. Model: `anthropic/claude-haiku-4-5`.

A short model call can finish sooner than the machinery needed to start it. This experiment compared a running worker that claims jobs from Postgres with a fresh `openclaw agent --local` process for each task. The warm worker was much faster on these small jobs. It also recovered queued work after a worker failure.

Both LLM tests asked for the same response: “Reply with just: OK. No other text.” The machine was a Mac with Apple Silicon and local Postgres 16 plus pgvector in Docker. These results describe that setup, not OpenClaw's gateway mode or a sustained cluster workload.

## Recovering interrupted work

| System | Delivered | Wall time | p50 per job | p95 per job |
|--------|-----------|-----------|-------------|-------------|
| **Minions** | **10 / 10** | 458ms total | 257ms | 410ms |
| OpenClaw `--local` | **0 / 10** | 22989ms (all SIGKILLed at 500ms) | n/a | n/a |

On the Minions side, the test created ten active jobs whose ownership leases had expired, then started a rescue worker. All ten completed within 458ms. On the OpenClaw side, ten local processes were killed after 500ms; none had emitted a reply. Its total test wall time was 22,989ms.

This demonstrates recovery from saved queue state. It is not an identical crash-and-restart procedure on both systems, and a caller could add retries around local processes. The queue provides that recovery as part of its design.

Source: `test/e2e/bench-vs-openclaw/durability.bench.ts` in the historical gbrain checkout.

## Starting twenty short tasks in sequence

| System | p50 | p95 | p99 | Mean | Min | Max | Success |
|--------|-----|-----|-----|------|-----|-----|---------|
| **Minions** | **778ms** | **1931ms** | **1931ms** | **911ms** | 639ms | 1931ms | 20/20 |
| OpenClaw `--local` | 8086ms | 10094ms | 10094ms | 8335ms | 7405ms | 10094ms | 20/20 |
| **Ratio** | **10.4×** | **5.2×** | **5.2×** | **9.2×** | 11.6× | 5.2× | — |

Minions called the Anthropic SDK from a running worker. OpenClaw started a new local process on each dispatch. Median time was 778ms versus 8,086ms, a 10.4× ratio; means were 911ms and 8,335ms, a 9.2× ratio. Both completed 20/20 tasks.

The report attributed roughly seven seconds to loading the agent runtime, authentication, plugins, and MCP servers, and roughly 100ms to the queue path beyond model latency. The full timings were measured; that breakdown was an explanation of the difference, not a separate profile. Slower models can reduce the relative advantage of saving startup time.

Source: `test/e2e/bench-vs-openclaw/throughput.bench.ts`.

## Starting ten tasks together

| System | Completed | Mean wall time | Runs (ok/N) | Wall times (ms) |
|--------|-----------|----------------|-------------|-----------------|
| **Minions** (concurrency=10) | **30 / 30** | **1090ms** | 10/10, 10/10, 10/10 | 890, 1135, 1245 |
| OpenClaw (10 parallel spawns) | 17 / 30 | 22598ms | 6/10, 5/10, 6/10 | 22204, 22505, 23084 |
| **Ratio (wall time)** | — | **~21×** | — | — |

The queue used one worker with concurrency ten. The comparison started ten local processes. Across three repetitions, Minions completed 30/30; OpenClaw completed 17/30, with rate-limit and spawn errors in the failed attempts. Mean wall time was 1,090ms versus 22,598ms, about 21×.

The observed failure fraction was 13/30, about 43%. No tuning was done to either the provider limits or the competing dispatch path. This small experiment shows the benefit of bounded dispatch in this setup. It does not establish a universal ten-agent limit.

Source: `test/e2e/bench-vs-openclaw/fanout.bench.ts`.

## Memory while jobs waited

| System | Baseline RSS | Peak with 10 in flight | Delta | Processes |
|--------|--------------|------------------------|-------|-----------|
| **Minions** | 84 MB | **86 MB** | **+2 MB** | 1 |
| OpenClaw | n/a | 814 MB (summed across 10) | — | 10 |
| **Ratio** | — | **~407×** | — | — |

The worker rose from 84MB to 86MB while ten cheap handlers waited. Ten OpenClaw processes together occupied 814MB. The original 407× figure divides OpenClaw's total memory by Minions' **additional** 2MB; it is not a comparison of total process memory. Nor was the increase 2MB per job: it was 2MB for all ten.

These tests measured process overhead with waiting handlers, not the memory cost of ten full reasoning tasks. Source: `test/e2e/bench-vs-openclaw/memory.bench.ts`.

## When the result is useful

A queue is a good fit when a program repeatedly dispatches independent tasks and needs retries, saved results, and bounded concurrency. A running worker avoids paying process startup on every task. That is the practical gain demonstrated here.

OpenClaw's gateway mode, longer model calls, tuned dispatch, hundreds of concurrent jobs, and hours of sustained load were not tested. The sample sizes were ten jobs for recovery, twenty serial calls, three ten-job fan-outs, and ten waiting tasks for memory. They are too small to characterize rare failures or precise tail latency.

## Reproduction

These commands refer to the historical gbrain repository. Durability and memory tests need no model calls; the original estimate for throughput and fan-out together was about $0.25 in Haiku tokens.

```bash
# 1. Start a test Postgres
docker run -d --name gbrain-test-pg \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=gbrain_test \
  -p 5436:5432 pgvector/pgvector:pg16

# 2. Set env
export DATABASE_URL=postgresql://postgres:postgres@localhost:5436/gbrain_test
export ANTHROPIC_API_KEY=sk-ant-...

# 3. Run each bench (durability + memory are free; throughput + fan-out
#    cost ~$0.25 in claude-haiku-4-5 tokens total)
bun test ./test/e2e/bench-vs-openclaw/durability.bench.ts
bun test ./test/e2e/bench-vs-openclaw/throughput.bench.ts
bun test ./test/e2e/bench-vs-openclaw/fanout.bench.ts
bun test ./test/e2e/bench-vs-openclaw/memory.bench.ts

# 4. Tear down
docker stop gbrain-test-pg && docker rm gbrain-test-pg
```
