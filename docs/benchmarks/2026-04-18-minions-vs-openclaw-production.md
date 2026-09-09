# Running a known import as a job instead of an agent task

**Historical run: April 18, 2026.** Wintermute on Render, ephemeral container, Supabase Postgres. GBrain v0.11.0 on `minions-jobs`; OpenClaw 2026.4.10. The brain contained 45,798 pages, 98K chunks, 25K links, and 79K timeline entries.

The import steps were already known: fetch a month of social posts, write a Markdown page, commit it, and queue a sync. A model did not need to decide what to do. In this single production attempt, the scripted path reached the queued-sync stage in **753ms**, while the subagent spawn timed out after more than **10,000ms**.

This complements the [local dispatch experiment](2026-04-18-minions-vs-openclaw-subagents.md). It is a record of one deployment and one failed spawn, not a general reliability rate for OpenClaw.

## The completed path

The scripted path imported May 2020: 99 posts fetched, one page written and committed, and a sync job queued. The 753ms measurement stops at queue submission; it does not time completion of the background sync.

```bash
# 1. Pull posts from the external API (curl → JSON)
curl -s -H "Authorization: Bearer $API_BEARER_TOKEN" \
  "$SOCIAL_API_URL?from=my_account&start=2020-05-01&end=2020-06-01" \
  > /tmp/bench-posts.json

# 2. Parse + write brain page (python)
python3 parse_and_write.py

# 3. Git commit
cd /data/brain && git add media/social/2020-05.md && git commit -m "archive: 2020-05"

# 4. Submit sync to Minions
gbrain jobs submit sync --params '{"repo":"/data/brain","noPull":true}'
```

The approximate breakdown was 300ms for the external API, 50ms to parse and write, 100ms for the commit, and 300ms to submit the job. LLM-token cost was $0.00. That excludes API, hosting, and database costs.

## The failed spawn

The agent request used June 2020, so the two attempts did not fetch the same month:

```javascript
sessions_spawn({
  task: "Pull my social posts for June 2020 and save as a brain page...",
  model: "anthropic/claude-sonnet-4-20250514",
  mode: "run",
  runTimeoutSeconds: 120
})
```

The gateway exceeded its ten-second timeout before the task started. The container also had 19 active cron jobs. Load is a plausible explanation; this one attempt does not isolate the cause.

The original report estimated a successful off-peak agent invocation at 10–15 seconds and about $0.03 in tokens: roughly 500ms to receive the request, 2–3 seconds for session setup, 2–3 seconds for model planning, and about one second each for fetch, parse, commit, and reporting. Those are estimates, not measurements from the failed attempt.

## Recorded comparison

The table preserves the original figures and deployment descriptions. “100%” and “0%” mean one successful scripted attempt and one failed spawn. Memory, retry, and persistence entries describe the tested architecture; they were not all separately measured here. The subagent token estimate is not a charge observed for the timed-out attempt.

| Metric | Minions | Sub-agent |
|--------|---------|-----------|
| **Wall time** | **753ms** | **>10,000ms** (gateway timeout) |
| **Token cost** | $0.00 | ~$0.03 per run |
| **Success rate** | 100% | 0% (timeout on first attempt) |
| **Survives restart** | Yes (Postgres) | No (dies with process) |
| **Progress tracking** | `gbrain jobs get <id>` | poll sessions_list |
| **Auto-retry** | 3 attempts, exponential backoff | manual re-spawn |
| **Concurrency** | FOR UPDATE SKIP LOCKED | hope-based maxConcurrent |
| **Steerable** | inbox messages | fire and forget |
| **Results persisted** | job record | lost on compaction |
| **Memory** | ~2MB per in-flight job | ~80MB per spawned session |

A persistent queue keeps work in Postgres so another worker can claim it after a restart. In this version, claims used `FOR UPDATE SKIP LOCKED` to keep workers from taking the same job. Agent-session behavior depends on the execution mode; the table's broad labels should not be applied to every OpenClaw deployment.

## What the longer backfill tells us

The scripted path also pulled 19,240 posts across 36 months (2021–2023) in about 15 minutes with no LLM-token spend. The original extrapolation for agents was 36 × $0.03 = $1.08, and 36 × 15 seconds = nine minutes before retries. Its roughly 40% failure assumption came from a separate fan-out experiment. It is not a measured 36-month agent run.

These figures support putting repeatable imports in code. They do not prove that every workload with 100+ months or 1,000+ jobs requires this queue, or that the same failure rate would persist after tuning.

Use an agent when deciding is part of the work: prioritizing email, judging whether news deserves an alert, preparing a meeting brief, or researching a prospective contact. Use a persistent job for a known sequence of operations. An agent can choose a job and let the job execute it.
