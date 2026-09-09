# Importing social posts with a script and with an agent

**Historical run: April 18, 2026.** Branch `garrytan/minions-jobs`; Minions v0.11.0, PR #130; OpenClaw 2026.4.10. Suite: gbrain's `test/e2e/bench-vs-openclaw/tweet-ingest.bench.ts`. Minions used no model; the agent path used `anthropic/claude-sonnet-4`.

The script completed five imports. The agent path completed three and timed out twice. Among successful attempts, the script averaged **719ms** and the agent **12,480ms**. The useful lesson is to encode a repeatable import once, then run it as a job.

Those results do not establish a 40% general failure rate for agents. There were only five attempts, on one loaded deployment, and the two paths' recorded tweet counts differ.

## What counted as an import

Each attempt was meant to fetch roughly 100 posts for a month, write a Markdown page with metadata and links, commit it, and submit a sync job. Queue submission is the endpoint; these times do not establish that indexing had finished.

The Minions handler performed one HTTP fetch, parsed JSON, wrote the page, committed it, and called `queue.add('sync', {repo, noPull: true})`. The model-driven path received those steps as a task and used shell tools to carry them out.

The report describes the agent both as `openclaw agent --local` and as a gateway session spawn. The timeout observations refer to a gateway under load. That inconsistency limits exact reproduction of the competing execution mode; it should not be silently resolved into a cleaner comparison than was recorded.

The deployment was an ephemeral ARM64 Render container, Supabase Postgres in us-east-1, and a 45K-page brain. The five months were July–November 2020. The external API was estimated at 200–500ms per call. The report also described a localhost Docker reproduction, which is a different environment.

## The five scripted runs

| Run | Month | Tweets | Wall time | Status |
|-----|-------|--------|-----------|--------|
| 1 | 2020-07 | 99 | 753ms | ✅ |
| 2 | 2020-08 | 87 | 681ms | ✅ |
| 3 | 2020-09 | 92 | 724ms | ✅ |
| 4 | 2020-10 | 78 | 698ms | ✅ |
| 5 | 2020-11 | 103 | 741ms | ✅ |

Mean was 719ms, median 724ms, P95 753ms, minimum 681ms, and maximum 753ms. All 5/5 attempts completed, with $0.00 in LLM-token spend. Hosting, database, and API charges are outside that figure.

## The five agent attempts

| Run | Month | Tweets | Wall time | Status |
|-----|-------|--------|-----------|--------|
| 1 | 2020-07 | — | >10,000ms | ❌ gateway timeout |
| 2 | 2020-08 | — | >10,000ms | ❌ gateway timeout |
| 3 | 2020-09 | 99 | 12,340ms | ✅ |
| 4 | 2020-10 | 87 | 11,890ms | ✅ |
| 5 | 2020-11 | 92 | 13,210ms | ✅ |

Successful attempts averaged 12,480ms, with median 12,340ms. Three of five completed. Estimated token cost was $0.03 per successful run, or $0.09 for the three successes. The deployment had 19 active cron jobs and heartbeats; the original report attributed the timeouts to a saturated spawn queue, without an isolated load experiment.

Notice that the successful agent rows do not match the scripted rows' tweet counts for the same month. Keep the timing evidence, but do not describe these as verified byte-for-byte equivalent imports.

## How to read the comparison

| Metric | Minions | OpenClaw Sub-agent | Ratio |
|--------|---------|-------------------|-------|
| **Mean wall time** | **719ms** | **12,480ms** | **17.3×** |
| **p50** | 724ms | 12,340ms | 17.0× |
| **Success rate** | 100% | 60% | — |
| **Token cost per run** | $0.00 | ~$0.03 | ∞ |
| **Survives restart** | ✅ | ❌ | — |
| **Progress tracking** | ✅ `jobs get` | ❌ | — |
| **Auto-retry** | ✅ 3 attempts | ❌ | — |

The 17.3× mean and 17.0× median comparisons use successful attempts only. They exclude the two agent timeouts. The infinity sign in the token-cost row means the scripted path used no LLM tokens, not that the entire job was free. The durability and retry entries describe the tested job system, not every possible agent deployment.

## The separate backfill

The scripted path also imported 19,240 posts over 36 months, 2021–2023, in about 15 minutes:

| Metric | Minions | OpenClaw Sub-agent (est.) |
|--------|---------|--------------------------|
| **Total time** | ~15 min | ~7.5 min (best case) to ∞ (gateway timeouts) |
| **Total cost** | $0.00 | ~$1.08 (36 × $0.03) |
| **Expected failures** | 0 | ~14 (36 × 40% failure rate) |
| **Manual intervention** | None | Re-spawn failed months |

Only the Minions column was measured. The agent column extrapolates $1.08 from 36 × $0.03 and approximately fourteen failures from the five-attempt failure fraction. Its 7.5-minute best case and timeout bound are projections, not another run.

This is the kind of task a queue makes easier to operate: the steps are known, failed attempts can be retried, and progress is saved. A model remains useful for deciding what to import, resolving an unfamiliar response, or preparing a summary afterward. Calendar sync is another fixed pipeline; email triage and meeting preparation require more judgment.

## Reproduction

These commands belong to the historical gbrain checkout. The stated $0.15 estimate assumes five agent calls at $0.03 each. Using a canned API response measures a different, local version of the pipeline.

```bash
# 1. Set environment
export X_BEARER_TOKEN=...           # external API bearer token
export DATABASE_URL=postgresql://... # Postgres with gbrain schema v7+
export BRAIN_PATH=/path/to/brain    # Git repo with brain pages
export ANTHROPIC_API_KEY=sk-ant-... # For OpenClaw side only

# 2. Run the benchmark
bun test test/e2e/bench-vs-openclaw/tweet-ingest.bench.ts

# 3. Cost: ~$0.15 total (5 OC runs × ~$0.03 each, Minions = $0)

# 4. On localhost without X API: mock the fetch in the test file
#    to return a canned JSON response. The benchmark measures
#    pipeline overhead, not API latency.
```
