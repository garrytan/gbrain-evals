# Audit E: scale in production (bet 3): the embedding backlog, stale sync, BEAM-1M failure modes, and what a 10M-token brain needs

Auditor: GBRA-60 subagent E. Date: 2026-10-07 (PT). Read-only.
Code under audit: gbrain master `7aa2caa0` (v0.60.106.0, wave 12 #6269 merged), gbrain-evals main `f1ce49fe` (v0.10.40).
Scratch analysis (free, local, outside both repos): `~/.capy/work/gbra60/audit/scratch/beam_xtab.py` re-reads the committed BEAM-1M rows.
Side effect to disclose: one `git fetch origin capy/sync-feeder-fast-writes` in /workspace/gbrain created the remote-tracking ref `origin/capy/sync-feeder-fast-writes` (no working-tree or branch change).
Nothing here ran gbrain against a real brain, called a paid API, or touched Garry's OpenClaw. Every number about Garry's OpenClaw comes from GitHub issues filed by `garrytan-agents`, which match the parent's description; I could not confirm they are the same brain.

---

## 0. Summary in eight lines

1. The ~140k missing embeddings very likely are the #6223 backlog (136,314 NULL-embedding chunks in source `default`, plus 192 in a second source, voyage-4, managed Postgres on a Supabase pooler, coverage 89.3%). Three image pages without a text projection made every `embed --stale` and every cycle embed phase return before embedding anything. Wave 12 (#6269, v0.60.106.0, merged today) fixed that with a keyset walk past blocked projections.
2. "Last synced 417 h ago" most plausibly means no managed sync run has checkpointed its whole manifest for about 17 days. Managed sync stamps `sources.last_sync_at` only when the full cursor commits (`sync-prepare.ts:324`) or when a run finds nothing to do. #6278 shows every pass stalling (`preparing` with no deadline) and getting killed at 3600 s, so the stamp never moves while some pages still land.
3. Clearing the backlog is cheap and short once the brain runs ≥ v0.60.106.0: about $3.6 to $12.6 at voyage-4 list price, provider-bound at 8 to 26 minutes on Voyage tier 1. The wall time is not measured anywhere and is probably DB-bound at 0.5 to 2 h. The real blockers are #6278 (sync) and the silent-failure surfaces, not money.
4. Silent recurrence is possible today: the cycle's `runPhaseEmbed` reports `ok` with 0 embedded. Doctor `embeddings` says `ok` at ≥ 90% coverage whatever the absolute backlog. `get_brain_identity.last_sync_iso` is hard-coded `null`. No production metric measures "time until a new write is findable".
5. On BEAM-1M dev, strict recall@5 is 18.2% (36/198) and answers 53.5%. 49 of the 198 scored questions have more than 5 gold turn groups (and 4 have none), so they cannot score at k=5. Among feasible questions strict recall@5 is 24.8% (36/145).
6. The failure is mostly retrieval for multi-gold questions (event ordering, summarization) and single-needle misses (information extraction: 12 of 22 have no gold session in the top 5). Knowledge update and abstention are read failures: knowledge update has 21/22 any@5 but answers 0.45, and abstention scores 0 on 15 of 22.
7. BEAM-1M ran with the reranker off, OpenAI embeddings, PGLite and one conversation (about 2.8k chunks) per brain. That is neither the production configuration nor an index-scale test. The reranker (+13 to 17 points first-place on Cat 13) and a 10-session read are the cheapest untested levers, at about $2 to $5 each on dev.
8. BEAM-10M is not loadable in gbrain-evals (manifest sizes: 100k/500k/1m only). Large-scale index evidence is thin: HNSW recall@10 is 0.927 unfiltered on 200k synthetic chunks and 0.95 to 0.98 on 60k real chunks, with default `m`/`ef_construction`, `ef_search` sized to a ≤ 100 candidate pool, and an 8 s / 20k-tuple escalation cap.

---

## 1. WHAT EXISTS today (code, config, CLI, MCP)

### 1.1 Where chunks get embeddings

| Path | What it does | Evidence |
|---|---|---|
| Write path (put_page, import, sync without `--no-embed`) | Embeds new chunks inline under the configured key; outside the paid-consent gate by design. | `src/core/embed-consent.ts` header (lines 1-15) |
| Sync auto-backfill (Postgres) | After a sync that wrote chunks, submits an `embed-backfill` minion job per source. Cooldown `embed.backfill_cooldown_min` (default 10), cap `embed.backfill_max_usd_per_source_24h` (default $25). | `src/core/embed-backfill-submit.ts:35,48-52`; `src/core/sync-embed-backfill.ts` (`syncProducedEmbeddableContent` gate) |
| `gbrain sync --no-embed` | Imports chunks with `embedding = NULL` and queues no effect (bench rows and #6278's loop use it). | `docs/eval/managed-sync-catchup.md:588-592`; #6278 body |
| Cycle / autopilot embed phase | `runPhaseEmbed` → `runEmbedCore(engine, {stale:true})` with the default 30-min budget, no `--catch-up`. Returns `status:'ok'` unless the stall watchdog fired; it never inspects `result.failures` or `result.blocked`. | `src/core/cycle.ts:1621-1666` |
| `gbrain embed --stale [--catch-up] [--source X] [--batch-size N] [--pace] [--yes \| --max-usd N] [--dry-run]` | Keyset drain over stale chunks. DB page size 2000 chunks (`embed.ts:1834`, `embed-stale.ts:351`). API outer batch `BATCH_SIZE = 100` (`src/core/embedding.ts:79`), pre-split per recipe. Time budget `GBRAIN_EMBED_TIME_BUDGET_MS`, default 30 min (`embed.ts:1470,1616`); `--catch-up` removes it (`embed.ts:941`, #1946). A budget stop exits 11 and prints the resume command (`src/core/embed-budget-stop.ts`). | as cited |
| Voyage recipe | `max_batch_tokens: 120_000`, `chars_per_token: 1`, `safety_factor: 0.5`, so about 60k characters per request; default model `voyage-4` at 1024 dims. | `src/core/ai/recipes/voyage.ts:49-62` |
| Retry / rate limits | `embedBatchWithBackoff`: 429 and 502/503/504 retry, honours retry-after hints, ±30% jitter, `maxRetries:0` passed to the SDK; zero-norm vectors never retried; partial batches keep their usable vectors. | `src/core/embed-retry.ts` (KEY_FILES `providers.md:23`) |
| Stall watchdog | No successful forward progress for `GBRAIN_EMBED_STALL_ABORT_SECONDS` (default 900) produces a `stall_timeout` result; cycle converts it to a failed phase. | `src/core/embed-stall.ts:50-64`, `cycle.ts:1634` |
| Concurrency | CLI `embed --stale`: `GBRAIN_EMBED_CONCURRENCY` default 20, clamped to the pool on Postgres (`embed-concurrency.ts:18-38`, `embed.ts:1838`). Job and remediation drains: `min(20, floor(poolMax/2))` (`embed-concurrency.ts:50-62`, #5902). | as cited |
| Pool | `GBRAIN_POOL_SIZE`, fallback 10 (`src/core/db.ts:60,149-157`). Port 6543 auto-disables prepared statements (PgBouncer transaction-mode convention, `db.ts:63-82,353`). Sync lanes are capped by the pool: pool 10 allows 6 lanes, pool 5 allows 1 (evals `2026-10-05-managed-sync-catchup.md`, "What to use"). | as cited |
| Wave 12 #6223 fix | "`embed --stale` and embed-backfill drain past blocked projections with a keyset walk". Before it, `runEmbedCore` returned before the stale loop when `readiness.blocked > 0`. | `CHANGELOG.md:69` (0.60.106.0); `embed-stale.ts:384-400,487-493,635-639` (`blocked` now counted, `complete=false`); tests `test/embed-stale-unavailable-snapshot.serial.test.ts:81-90`, `test/embedding-readiness.test.ts:48` |
| Embedding-recovery parity | `test/e2e/embedding-recovery-parity.test.ts` (3 lines) re-registers `test/embedding-recovery.serial.test.ts` (1,543 lines) on Postgres, so PGLite and Postgres run the same recovery cases. | files read |
| HNSW during a bulk re-embed | `gbrain migrate embeddings` defers the HNSW build until after the drain, because inserting into a live graph measured 4x slower on PGLite. A plain `embed --stale` backlog inserts into the live index. | `src/core/embedding-ann-build.ts:1-19` |
| Keyword arm | `search_vector` is filled by a trigger, so unembedded chunks stay keyword-findable but are invisible to the vector arm. | `src/schema.sql:334,358,374-385` |
| Consent | `embedBackfillFix`: `argv gbrain embed --stale --catch-up --yes`, `preview_argv … --dry-run`, `consent:['paid']`, so the agent must `ask_user`. A non-interactive run without `--yes`/`--max-usd`/tokenmax exits 3. | `src/core/embed-consent.ts:1-45`; AGENTS.md operator protocol |

### 1.2 Doctor and status surfaces

| Surface | Behaviour | Evidence |
|---|---|---|
| `embeddings` check | Coverage ≥ 0.9 → `ok` even with a backlog (message carries the backlog and fix); 0 < coverage < 0.9 → `warn`; `details.code: embedding_backlog`, `requires_user_approval: 'paid embedding calls'`. | `src/commands/doctor/checks/schema-health.ts:339-393` (≥0.9 at :378) |
| `embed_staleness`, `embedding_width_consistency`, `vector_plan`, `vector_coverage` | Onboard checks and index-use checks. | `sync-search.ts:210,243`; `checks/vector-plan.ts`, `checks/vector-coverage.ts` |
| `sync_freshness` | Warn > `GBRAIN_SYNC_FRESHNESS_WARN_HOURS` (24), fail > `…_FAIL_HOURS` (72): "Source X last synced Nd ago — brain search is stale!". The local path short-circuits on git `HEAD == last_commit`; the remote path uses `newest_content_at` lag. | `checks/extraction-sync.ts:1214-1216,1348-1449` |
| `managed_sync_backlog` | Lists unfinished managed cursors with remaining entries and ETA; warns only when a cursor has not advanced for 60 min. | `checks/managed-sync-backlog.ts:5-17` |
| `gbrain status`, `sources status`, MCP `get_status_snapshot` | `hours_since_last_sync` (raw wall clock), `staleness_hours`, `chunks_unembedded`, `embedding_coverage_pct`, `backfill_queued/active/last_completed_at`. | `src/core/sync-status-report.ts:40-66,231-260` |
| MCP `get_brain_identity` | Returns `last_sync_iso: null` always ("deferred… TODO v0.31.x"). | `src/core/ops/admin.ts:103,139` |
| `doctor --remediation-plan` / `--remediate` | `embed.stale` step: severity critical, cost from `missing × 1500 chars ÷ 3.5 chars/token × price`, `est_seconds = min(3600, 5 + n × 0.05)`. `max_reachable_score` comes from `maxReachableScore(health, classifications)`. | `src/core/brain-score-recommendations.ts:227-272`; `src/core/embedding-pricing.ts:146-149`; `src/core/remediation/plan.ts:43-88` |

### 1.3 Sync path and holds (managed Postgres)

- `last_sync_at` is written in four places: a no-op git sync heartbeat (`src/commands/sync/preflight.ts:171-184`), a managed run that found nothing (`src/core/persistence/sync-run.ts:874-879`), the full-cursor checkpoint (`src/core/persistence/sync-prepare.ts:324`, which requires every page write of the run committed, `:311-321`), and `sync-anchor.ts:264-269` on the classic path.
- Preparation deadline: `consumer.ts:536-537`. `bounded` is true only for `remember` and intent-less `put_page`/`edit_page`, with a 30 s budget. `managed_sync_import` and `managed_maintenance_*` prepare with no deadline while the claim lease renews (GBRA-59's reading, confirmed in code).
- Git holds (#5988) and fence holds (#6188): `src/core/persistence/sync-holds.ts:1-26`. A deterministic refusal is held and the rest of the source moves. #6278 shows fence round-trip errors (`prepared-maintenance.ts:290`) failing preparation instead of holding.
- Sync deadlines: non-TTY hard deadline 3600 s (`GBRAIN_SYNC_MAX_RUNTIME_SECONDS`), extended while progressing; stall abort 900 s (`docs/operations/backfill-pacing.md:18,32`).
- GBRA-45 branch `capy/sync-feeder-fast-writes` (head `d00f4d03`, no PR yet; 111 files, +4,995/−925 vs master): foreground writes jump queued sync groups (#5984 Phase 4.5), lanes up to 16 clamped by the pool, admit-ahead within the writer's outstanding limit, pipelined feeder. It does not add a preparation deadline for sync members (git log read; no commit names one).

### 1.4 Hybrid search knobs that matter at scale

| Knob | Value | Evidence |
|---|---|---|
| RRF k | 60 | `src/core/search/hybrid.ts:54` |
| Per-arm pre-fusion pool | `min(max(limit×2, 50, offset+limit, evalDepth), cap)`, cap `MAX_SEARCH_LIMIT = 100`; eval-only depth ≤ 300 | `hybrid.ts:64`, `search/eval-pool-depth.ts`, `src/core/engine.ts:754` |
| HNSW build | `USING hnsw (embedding vector_cosine_ops)`, no `WITH`, so pgvector defaults | `src/core/vector-index.ts:23`, `schema.sql:348` |
| `hnsw.ef_search` | `= candidateLimit`, clamped to [40, 1000] | `vector-index.ts:65-80`; `search/vector-settings.ts:14` |
| Iterative scan | `relaxed_order` default (wave 11, #6132); `max_scan_tuples` 2,000 × 4^escalation, capped at 20,000; inner limit ×4, at most 3 escalations; 8 s arm deadline; one exact fallback on Postgres, none on PGLite (reports `vector_candidates_incomplete`) | `search/hnsw-iterative-scan.ts:24`; `search/vector-pool.ts:35-60`; `docs/architecture/RETRIEVAL.md:86-108` |
| Dimension caps | vector 2,000, halfvec 4,000 for HNSW | `vector-index.ts:19,33-34` |
| Mode bundles | conservative: tokenBudget 4,000, searchLimit 10, reranker off. balanced: tokenBudget 12,000, searchLimit 25, reranker on, `top_n_in` 25. tokenmax: no budget, searchLimit 50, reranker on, `top_n_in` 50. Autocut off in every bundle. | `search/mode.ts:441-449,500-510,566-581,302-309` |
| Internal breadth | Internal callers disable autocut and adaptive return (2 pages entity / 6 otherwise) | `search/internal-breadth.ts` |

### 1.5 BEAM runner and loader (gbrain-evals)

- `eval/runner/memory-qa/corpus.ts:251-299` `loadBeam(size: '100k'|'500k'|'1m')`. Each BEAM **turn group** becomes a "session" (`b<batch>-g<group>`). Gold = the set of turn groups holding `source_chat_ids`. Dates come from `beamGroupDates` (v0.10.32 fix).
- Dataset manifest `eval/decisions/datasets/beam-b2da22e.json`: sizes `100k: 20`, `500k: 35`, `1m: 35` conversations. **No 10M.** Splits (`eval/decisions/splits/beam-*.json`, salted, 2026-10-04): 1M dev 11 / sealed 24; 500k 11/24; 100k 6/14.
- `run.ts:281-297`: in-memory **PGLite**, one conversation per brain (reset between conversations). `run.ts:362`: `hybridSearch(engine, q, {limit: topK*3, expansion:false})` reduced to distinct sessions, top 10. The reader gets the top 5 sessions in date order (`--qa-sessions 5`). `--embed hash` gives a keyless, free arm.

---

## 2. WHAT HAS BEEN MEASURED

### 2.1 Production brain (issue reports, not benchmarks)

| Fact | Value | Source | Date / build |
|---|---|---|---|
| NULL-embedding chunks | 136,314 in `default`, 192 in a second source; `embedding_column` 89.3%; doctor `embed_staleness` about 68.8k | gbrain #6223 (garrytan-agents) | 0.60.95 to 0.60.99 |
| Blocking cause | 3 `type: image` pages with `text_projection_revision IS NULL`; `--catch-up --max-usd 10` twice: $0 spent, 0 embedded | #6223 | same |
| Fix shipped | v0.60.106.0, #6269 "Fixes #6223" (issue closed 2026-10-08T01:40Z) | CHANGELOG:69, PR body line 59 | 2026-10-07 |
| Managed sync stall | 13,627-entry manifest; 7 to 19 pages/min for 10 to 15 min, then no progress until `sync_deadline_stop` (rc 143, 3600 s); 4 passes in a row; effective about 0.8 pages/min (153 of 13,627 in about 3.3 h); ETA meter says 20 to 31 h | gbrain #6278 (garrytan-agents, open) | 0.60.105.0, schema 215, Supavisor |
| Earlier stall | 0.60.99: 151 entries, then 2,793 s with no progress | #6278 | 2026-10-07 |
| Inferred brain size | If 89.3% uses the same denominator as the 136.5k missing, the brain holds about 1.28M chunks. Derived, **not verified.** | arithmetic on #6223 | |

"417 hours" (about 17.4 days) appears in no file I read. It matches `hours_since_last_sync` from `gbrain status` / `get_status_snapshot`, or the doctor `sync_freshness` text ("last synced 17d ago"). It does not come from `get_brain_identity`, which returns `null`.

### 2.2 Managed sync catch-up (synthetic bench)

| Build | 57 ms RTT | 10k-file backlog | Source |
|---|---|---|---|
| v0.60.39.0 | 3.4 pages/min | about 49 h | evals `2026-10-05-managed-sync-catchup.md` table 1 |
| v0.60.48.0 (#5996) | 13.1 (15.7 on 10k) | about 10.7 h | same |
| v0.60.58.0 (#6021) | 28.8 (30.9 on 10k) | about 5.4 h | same |
| v0.60.73.0 (#6098), 6 lanes | **152.8 steady, 137.4 wall** | about 1.2 h | same; gbrain `docs/eval/managed-sync-catchup.md:711` |
| ~0 ms | 740.6 pages/min (v0.60.73.0) | | evals report |
| Foreground write at 57 ms | p50 11.8 s idle, 11.3 / p95 15.8 s during catch-up | | evals report |

**Negative and limit:** synthetic pages, `--no-embed` in the throughput rows, a simulated network, one rig. Production on #6278 gets about 0.8 pages/min effective, **about 190x below the bench**, because of stalls the bench corpus never triggers (fence round-trip errors, unbounded preparation). The `effects` row with stub embeddings (200 ms/call, 4 concurrent) kept pace: 2 unembedded chunks at CLI exit, 0 shortly after (`docs/eval/managed-sync-catchup.md:188,227-232`), but links stayed stale until the checkpoint.

### 2.3 BEAM (development evidence unless noted)

BEAM-1M dev, 11 conversations, 220 questions (198 with gold), balanced mode, reranker off, autocut off, expansion off, `openai:text-embedding-3-large`@1536, top 10, seed 42. Reader and judge `gpt-4.1-mini`, 1 run, top 5 sessions. Source: evals `docs/benchmarks/2026-10-06-beam-1m-dates.md`, `…/beam-summary.json`.

| Metric | Old loader `6622a119e` | Fixed loader `6622a119e` | Fixed loader pin `c5fb0201` |
|---|---:|---:|---:|
| Strict recall@5 | 18.2% (36) | 18.2% (36) | 18.2% (36) |
| Any@5 | 68.7% | 69.2% (137) | 69.2% |
| Strict recall@10 | 27.8% (55) | 28.8% (57) | 28.8% |
| nDCG@10 | 0.428 | 0.432 | 0.432 |
| Answers, 220 | 54.6% | **53.5%** | not run (cap) |
| Answerable / abstention | 58.7 / 18.2% | 56.1 / 29.5% | |

**Negative results:** dates did not move strict recall (2 gained, 2 lost). The P-series (v0.60.48 → v0.60.95) retrieved identically on all 198 questions, with 212/220 identical lists; the verdict is inconclusive at difference 0. Answer changes of 29 better and 42 worse are reader noise. Cost: $1.57 retrieval cold, $1.14 answers; wall time about 25 min retrieval (3 shards), about 50 min answers on a 4-core machine.

Starting line (same build, old loader), `2026-10-05-heldout-program/starting-line/summary.json`: BEAM-100K dev strict@5 45.4%, any@5 80.6%, answers 57.1%, abstention 8.3%. A fixed-loader rerun at 100K gives strict@5 47.2% and answers 58.0% (`2026-10-05-heldout-program.md:35`). LME-S strict@5 92.8%, answers 85.6% (for scale contrast). No BEAM-500K dev retrieval row was found.

Sealed (held-out) BEAM, `2026-10-05-heldout-verdicts/README.md:21-22`: P4 pre-compaction notice passed on **BEAM-500K sealed** (+11.35 points [+8.3, +14.4]). P4 core tier **failed** on BEAM-100K sealed (gpt-6.1-sol −2.4, claude-fable-5-1 −2.4). The GBRA-52 thread reports a 100k/500k/1M confirmation (1M: 0.708 fix-off vs 0.677 fix-on). That is a **thread message, not a committed file**, on a different protocol, so treat it as unverified here.

Competitor BEAM figures (self-reported, mixed scales), `docs/plans/2026-09-28-gbrain-10x/audit/coverage-and-categories.md:238-248`: Mem0 1M 64.1 / 10M 48.6; Hindsight 1M 73.9% / 10M 64.1%; Honcho 1M 0.631 / 10M 0.406 (0-1 rubric); Exabase 1M 75.0 / 10M 68.0. These do not compare directly with gbrain's 53.5% (different reader and protocol).

### 2.4 New per-question analysis of committed BEAM-1M rows (free, this audit)

Joined `runs/beam-1m/baseline` (retrieval) with `qa/baseline` (answers) on the fixed loader, `6622a119e`, using `scratch/beam_xtab.py`:

| Category (22 each) | median gold turn groups | all@5 | any@5 | all@10 | answers | answers when all@5 / some@5 / none@5 (n) |
|---|---:|---:|---:|---:|---:|---|
| event_ordering | 24 | 0 | 12 | 0 | 0.47 | – / 0.61 (12) / 0.30 (10) |
| summarization | 13 | 0 | 11 | 0 | 0.40 | – / 0.48 (11) / 0.24 (8) |
| information_extraction | 1 | 8 | 10 | 10 | 0.41 | 0.62 (8) / 0.61 (2) / 0.24 (12) |
| temporal_reasoning | 2.5 | 5 | 19 | 8 | 0.42 | 0.70 (5) / 0.35 (14) / 0.33 (3) |
| knowledge_update | 3 | 5 | 21 | 8 | 0.45 | 0.60 (5) / 0.44 (16) / 0.00 (1) |
| multi_session_reasoning | 3.5 | 3 | 18 | 6 | 0.60 | 0.67 (3) / 0.62 (15) / 0.47 (4) |
| contradiction_resolution | 3 | 4 | 21 | 9 | 0.66 | 0.62 (4) / 0.66 (17) / 0.75 (1) |
| instruction_following | 1 | 6 | 7 | 7 | 0.71 | 0.92 (6) / 1.00 (1) / 0.61 (15) |
| preference_following | 3 | 5 | 18 | 9 | 0.92 | 0.93 / 0.92 / 0.92 |
| abstention | 0 | – | – | – | 0.30 | 15 of 22 score 0 |

Derived facts:
- **Metric ceiling.** 49 of 198 scored questions have more than 5 gold turn groups (event ordering 22, summarization 17, multi-session 5, temporal 3, contradiction 1, knowledge update 1) and 34 have more than 10, so they can never reach strict@5 or strict@10. Four non-abstention questions have 0 gold and count as misses in the 198 denominator (`recount.ts` sums `Number(null)=0`). Among feasible questions: strict@5 = 36/145 = **24.8%**, strict@10 = 57/160 = **35.6%**. By gold count: 1 gold 18/41 at 5 and 21/41 at 10; 2 gold 13/40 and 20/40; 3 gold 5/32 and 9/32; 4 gold 0/24 at 5.
- **Read vs retrieval.** Answers average 0.727 when all gold is in the top 5 (36 q), 0.586 with some (101 q), 0.424 with none (61 q). So even perfect retrieval loses about 27% to reading, and about 61 questions are pure retrieval misses.
- **Confident wrong answers (heuristic regex on the answer tail, approximate).** 41 of 45 zero-score answerable questions show no hedge, and 15 of 22 abstention questions answer confidently and score 0. That makes about **56/220 = 25% confident-wrong**. This is the bet-(a) baseline on 1M.
- **Scale sensitivity vs 100K (same build, fixed loader, `starting-line-beam-dates/beam-100k-qa`).** Information extraction strict@5 is 10/12 at 100K vs 8/22 at 1M, the cleanest needle-at-scale signal. Event-ordering median gold is 3 at 100K vs 24 at 1M, and summarization 5 vs 13: gold grows with conversation length because sessions are turn groups. Knowledge update answers poorly at both (0.25 at 100K, 0.45 at 1M) despite 12/12 and 21/22 any@5, so it is a read or supersession problem. Abstention is 1/12 at 100K and 7/22 at 1M.
- **Reader context:** median 7,035 tokens (mean 7,684) at 5 sessions on 1M; 9,175 at 100K. This harness reads about 7k tokens, not the ~22k figure in Garry's framing.
- **Index scale:** about 31.2k chunk embeddings over 11 conversations (receipt `cache_stats`), so **about 2.8k chunks per 1M-token brain**. BEAM-1M stresses ranking among many similar sessions, not ANN index size. Retrieval latency median 451 ms, p95 694 ms (PGLite, shared machine, not comparable).

### 2.5 Index scale and perf

- HNSW relaxed vs strict, evals `2026-10-07-hnsw-relaxed-order.md`: about 60k real chunks, Postgres 16, pgvector 0.8.7, default build. 50% filter recall@10 0.962 → 0.983 (voyage-4/1024) and 0.950 → 0.967 (3-small/1536); k=50 unchanged (0.951/0.952, 0.937/0.937). The 10% filter is exact (1.000) but 5-6x slower, probably a non-HNSW plan (no EXPLAIN). Synthetic 128-dim, 200k chunks: **unfiltered recall@10 0.927** (k=50 0.986), 10% filter 0.867 → 0.950. Lane scratch, recorded only as a limit.
- #5824 vector plan, CHANGELOG:3708: on a 160k-chunk brain, vector p50 went from about 500 ms to about 15 ms with identical top-10 after the freshness check left the HNSW CTE.
- Refactor wave 1 baseline, `docs/designs/refactor-wave-1/perf-baseline.md`: **800 chunks only**. Hybrid warm median 108.9 ms (direct PG local) / 121.9 ms (VM); searchVector limit 100 median 21.8 to 33.6 ms. It says nothing about scale.
- Embedding matrix, evals `2026-10-06-embedding-matrix.md`: reranker `rerank-2.5` adds 13 to 17 points of first-place rate for every embedder (Holm p = 0.03). voyage-4 + rerank 130/181, 3-large + rerank 126/181. Query-phase cost about $0.51 per 1,000 queries.
- Not found: any HNSW recall or latency measurement above 200k chunks; any embed-drain throughput (chunks/min) on a real or remote brain; any `ef_search` / `m` / `ef_construction` sweep; any halfvec measurement.

---

## 3. GAPS between Garry's bet and reality

1. **The flagship brain fails the "write is findable" promise in two layers.** Its sync is stuck (#6278) and its vectors were starved (#6223). The bench numbers (152.8 pages/min; embeddings keep pace) did not predict either, because bench corpora contain no image attachments, fence anomalies or long-lived managed cursors.
2. **No production metric for "time until a new write is findable".** Only the bench's `retrieval_ready_after_sync_s` exists (`docs/eval/managed-sync-catchup.md:168`). Grep for findable/retrieval-ready in `src/` finds nothing operational.
3. **Silent-success surfaces.** (a) `runPhaseEmbed` returns `ok` while `result.failures`/`blocked` > 0 (`cycle.ts:1633-1655`), which is how 136k chunks sat for days. (b) Doctor `embeddings` is `ok` at ≥ 90%: on a 1.3M-chunk brain that is up to about 130k invisible chunks reported green (`schema-health.ts:378-381`). (c) `last_sync_iso` is always `null` (`admin.ts:139`). (d) The managed ETA assumes no stall (#6278). (e) `sync_freshness` reports only "last synced 17d ago" when pages are landing but the checkpoint is not. Progress (`last_progress_at` in the backlog check) and checkpoint (`last_sync_at`) are separate signals, and no surface joins them.
4. **BEAM-1M does not measure production.** Reranker off (balanced has it on), OpenAI 3-large (default voyage-4), PGLite, 2.8k chunks per brain, a 5-session reader. The one lever with strong evidence (the reranker) is untested there.
5. **The strict@5 headline is partly a metric artifact.** About a quarter of scored questions (49 of 198, plus 4 with no gold) are infeasible at k=5, because BEAM's natural session is the batch and the loader's unit is the turn group. The report does not say so.
6. **No 10M path.** No loader, no manifest entry, no index-scale bench above 200k chunks, while Garry's OpenClaw is probably over 1M chunks.
7. **Living pages:** "living page" is not found in either repository (docs, src, TODOS, CHANGELOG). The pilot has no spec to audit.

---

## 4. RISKS and prior failures the plan must not repeat

- **A bench that never sees production failure shapes.** Catch-up went 3.4 → 152.8 pages/min on synthetic notes while the real brain stalls at about 0.8 effective (#6278). Every scale claim needs a run on a copy, or a read-only replay, of real-brain shapes: images, fences, held files, receipt history.
- **"One bad item blocks everything" recurs:** #5988 frontmatter, #6188 fences, #6223 projections, #6278 preparation. Any new per-item failure needs hold-and-continue plus a loud count from day one.
- **`status: ok` with zero work done** (cycle embed). Do not add more phases that report success without asserting progress.
- **Paid spend without consent.** `embed --stale --catch-up` is `paid` (ask_user). Unattended cycles are exempt by design, so turning on a larger cycle budget is itself a spend decision for Garry.
- **Pool starvation.** More embed workers than pool connections stalled at 0% CPU before (#5183). Lanes and embed workers share `GBRAIN_POOL_SIZE`. On Supavisor session mode, `EMAXCONNSESSION` hit the lock refresher (KEY_FILES commands-6). Raise pool and workers together, never one alone.
- **HNSW live inserts during a big backlog.** 4x slower on PGLite. Postgres is unmeasured. Watch `vector_plan` after a 140k insert, and ANALYZE (the #5824 planner flip happened at 160k chunks).
- **Eval protocol drift.** Do not compare a reranker-on 1M run with the 18.2% row as a "fix". Preregister it. Per the scope rules, new answer runs use the newest Opus, GPT and Sonnet, with at most one bridge model (`gpt-4.1-mini` is the only link to the 53.5% row). Keep sealed BEAM conversations closed: GBRA-52's sealed runs own them.
- **Reader noise.** 29 better / 42 worse at identical retrieval. Any answer-level claim needs at least 3 reader runs or a paired test.
- **Privacy.** Real-brain diagnostics must go to scratch and report aggregates only (GBRA-58's dry-run rule on Garry's Mac).

---

## 5. PROPOSED WORK ITEMS

### 5.1 Backlog-clearing runbook for Garry's OpenClaw (operator, no code)

Preconditions: GBRA-59's #6278 fix and GBRA-45 do not gate the embed backlog, because embed writes go straight to `content_chunks` and do not use the managed journal (`embed-stale.ts` has no persistence/managed path). They do gate sync freshness.

1. **Upgrade (read the version first).** `gbrain --version`; if below 0.60.106.0, `gbrain upgrade`. Without wave 12 the drain embeds 0 (#6223).
2. **Read-only diagnosis (no consent needed):**
   - `gbrain doctor --json` (look at `embeddings`, `embed_staleness`, `sync_freshness`, `managed_sync_backlog`, `git_held_files`, `vector_plan`)
   - `gbrain status` (per source `hours_since_last_sync`, `chunks_unembedded`, `backfill_*`)
   - `gbrain sources status default`
   - `gbrain embed --stale --dry-run --json` (`would_embed`, blocked pages)
   - `gbrain doctor --remediation-plan --json` (`embed.stale` `est_usd_cost`, `plan_hash`, `max_reachable_score`)
   - `echo $GBRAIN_POOL_SIZE $GBRAIN_EMBED_CONCURRENCY`
3. **Consent point (ask_user, verbatim `user_message` from `embedBackfillFix`).** State the cost range below and that page text goes to Voyage.
4. **Drain:** `GBRAIN_POOL_SIZE=20 GBRAIN_EMBED_CONCURRENCY=16 gbrain embed --stale --catch-up --source default --max-usd 15`, then the second source. Keep `--max-usd` as the hard bound rather than `--yes`. Pool 20 is a suggestion: the pooler's limit must allow it, otherwise leave the defaults (10 workers). Alternative: `gbrain doctor --remediate --yes --include-repairs --expect <plan_hash> --max-usd 15`.
5. **Blocked pages:** the result lists projection-blocked pages (image attachments) with the rebuild command (CHANGELOG 0.60.106 "What you see"). Run that per page, or leave them counted as `blocked` (192 + 3 in #6223).
6. **Verify:** `gbrain doctor --only embeddings --json` (from `fix.verify`), `gbrain status`, then `vector_plan` (the planner still uses `idx_chunks_embedding`). Run `ANALYZE content_chunks` only if `vector_plan` warns.
7. **Sync (separate track):** `gbrain sync --source default --no-pull` without `--no-embed`, once GBRA-59's preparation deadline ships. Until then each pass stalls (#6278). Reading `gbrain sources writer status --probe --json` is safe.

Cost, from gbrain's own estimator and voyage-4 list price $0.06 per 1M tokens (`embedding-pricing.ts:44`): 140,000 × 1,500 chars ÷ 3.5 = 60M tokens, so **$3.60**. With the recipe's worst case of 1 char = 1 token (`voyage.ts:61`), 210M tokens, so **$12.60**. With voyage-4-large or text-embedding-3-large, $7.20 to $7.80 by the estimator. Voyage's rate-limit page mentions free tokens on current models, but this audit did not verify an allowance for voyage-4.

Wall time: no measured drain throughput exists anywhere (not found).
- Provider bound, Voyage tier 1 for voyage-4 at 8M TPM / 2,000 RPM (docs.voyageai.com/docs/rate-limits, fetched 2026-10-07): 60M to 210M tokens takes **7.5 to 26 min**, and about 3,500 requests of ~40 chunks take ≥ 1.75 min. Tier 2 halves both.
- DB bound: 10 workers by default, 2,000-chunk keyset pages, over Supavisor.
- The remediation formula gives 5 + 140,000 × 0.05 = 7,005 s ≈ 1.9 h (displayed capped at 3,600).
- Plan for 0.5 to 2 h. **Measure** `embedded` per minute in the first `--json` progress or a 30-min budgeted run before promising anything.

What could block it: projection-blocked pages (now skipped, not blocking); 429s (handled by backoff); a pool below the worker count (clamped with a warning); the stall watchdog at 900 s with no successful chunk (an invalid key or a provider outage shows as `stall_timeout`); `embed.backfill_max_usd_per_source_24h=$25` on queued jobs (not on the CLI path); zero-norm or oversize chunks (`embed-oversize-heal.ts`, open contributor PR #5347 "stop retrying chunks the embedder can never accept").

Effort: 0.25 human-day or 1 to 2 agent-hours of operator time, plus a device-permission prompt on Garry's machine. No migration.

### 5.2 Make it impossible to recur silently (code)

| # | Goal | Files | Migration | Effort | Proof (metric, dataset) | Paid |
|---|---|---|---|---|---|---|
| A | Cycle embed phase fails or warns when `blocked`/`failures` > 0 or when a backlog > 0 and 0 embedded for N cycles | `src/core/cycle.ts:1621-1666`, cycle report types, `test/cycle*.test.ts` | no | 0.5 hd / 2-3 ah | forced probe: blocked image page + stale chunks → phase `warn` with count (fails on master) | $0 |
| B | Doctor `embeddings`: warn on an absolute backlog (for example > 1,000 chunks or > 1%) and on backlog age (oldest NULL chunk's `created_at`), not just < 90% | `checks/schema-health.ts:339-393`, `engine-sql/health.ts` | no (an index on NULL-embedding chunks may exist; check `content_chunks_stale_idx`) | 0.5 hd / 3 ah | probe: 95% coverage with 50k missing → warn | $0 |
| C | "Time until findable" metric: per source `oldest_unembedded_age_s`, `oldest_uncheckpointed_commit_age_s`, p50/p95 of `embedded_at − chunk created_at` over 24 h; surface in `gbrain status`, `get_status_snapshot`, doctor `write_findability` and a `[gbrain notice]` | `sync-status-report.ts`, `checks/` (new), `ops/admin.ts` (fill `last_sync_iso`), `src/core/notice*` | likely yes (`content_chunks.embedded_at` if absent; verify) | 2 hd / 8-12 ah | managed bench `effects` row + a new real-shape row: p95 write→findable < 5 min; production: the metric on Garry's OpenClaw daily | $0 |
| D | Split "progress" from "checkpoint" in `sync_freshness`: report pages published in the last hour and cursor age next to `last_sync_at`; make the managed ETA stall-aware (use the last-hour rate) | `checks/extraction-sync.ts`, `checks/managed-sync-backlog.ts`, `persistence/sync-drain.ts` | no | 1 hd / 4-6 ah | probe: a cursor with progress but no checkpoint → "publishing, checkpoint pending" | $0 |

Overlap: D touches GBRA-59's (#6278) and GBRA-45's files (`sync-drain.ts`, consumer); land after GBRA-45 merges, coordinated with GBRA-59. C's `embedded_at` needs a migration number at merge time (GBRA-40 slot).

### 5.3 BEAM-1M failure analysis (free first, then cheap preregistered arms)

Free, on committed receipts (0.5 hd / 3-4 ah, $0):
1. Publish the feasibility-adjusted numbers above (strict@5 24.8% of 145, strict@10 35.6% of 160) and the 0-gold accounting note as a recount over committed rows, with a changelog entry on the 1M report.
2. Recompute gold at **batch granularity** (BEAM's natural session) from the dataset. `eval:decide fetch` is a free download, but run it in a scratch clone, not the shared checkout. Score the committed `retrieved` lists both ways. If strict@5 at batch level moves sharply, the headline is a unit choice, not a retrieval failure.
3. Classify the 61 none@5 questions: lexical gap (the query's key terms are absent from the gold turn group; compare with `--embed hash` keyword-only, a free arm) vs semantic drift vs date-scoped.
4. Tag confident-wrong answers with a stricter rubric (hedge detector + judge rubric item) to make the 25% figure exact.

Candidate fixes, ranked by evidence. All on the 1M **dev** split; sealed stays with GBRA-52.

| Rank | Change | Evidence for it | Metric that proves it | Cost |
|---|---|---|---|---|
| 1 | Reranker on (balanced default, `rerank-2.5`, `top_n_in` 25→50) | +13 to 17 pts first-place on Cat 13 (embedding matrix); production default | paired strict@5 and any@5 on 198 q (feasible-adjusted too); then answers on newest Opus/GPT/Sonnet + `gpt-4.1-mini` bridge | retrieval about $1.6 (cold OpenAI embed) + rerank about $0.2; answers about $1.1 bridge + about $5-15 for three frontier readers (estimate) |
| 2 | Read 10 sessions instead of 5 (≈ 14k tokens) | strict@10 28.8% vs @5 18.2%; answers rise 0.42 → 0.73 as coverage rises | answer accuracy, confident-wrong rate, tokens/answer | ≈ 2x the answer half |
| 3 | Deeper pool + per-session diversity (cap chunks per session before fusion, `--eval-pool-depth 100-300`) | gold growth to 13-24 turn groups for event ordering / summarization | all@10 and nDCG@10 on those two categories | retrieval only, about $0.1 with a warm cache |
| 4 | voyage-4 embeddings (production default) | matrix: no embedder beat voyage-4 | parity check, not a fix | about $0.7 (≈ 11-12M tokens at $0.06) |
| 5 | Abstention / supersession read policy (knowledge update 0.45, abstention 0.30) | read failures with any@5 21/22 | confident-wrong rate on abstention + knowledge-update | reader-only arms |
| 6 | Query expansion | the expansion budget note in `mode.ts:115-134` shows a prior regression (54.89%, +3/−183) | strict@5 | about $0.5 Haiku-class calls |

Effort: preregistration + 3 arms ≈ 2 hd / 8-12 ah. Total paid ≈ $10-25. Needs Garry's approval (gbrain-evals rules: preregister, budget ledger).

### 5.4 A 10M-token brain (and a 1M+-chunk production brain)

Index needs, from code:
- per-arm pool ≤ 100 (`MAX_SEARCH_LIMIT`)
- `ef_search` = pool (≥ 40, ≤ 1000)
- `max_scan_tuples` ≤ 20k with 3 escalations inside 8 s
- one exact fallback on Postgres (a sequential scan of about 1.3M × 1024-dim vectors will not finish in the leftover budget; unmeasured)
- default HNSW `m=16`, `ef_construction=64` (pgvector defaults, no `WITH`)

Raw vector storage at 1024-dim float4 ≈ 4 KB/chunk, so about 5.2 GB for 1.3M chunks before graph overhead; halfvec halves it. This is arithmetic, not a measurement.

Measure first (ordered):
1. **Real-shape index bench at 1M chunks.** Extend `scripts/bench/hnsw-iterative-scan.ts` (it already takes `--chunks`) to 250k / 1M / 2M synthetic-latent chunks for free. Report recall@10/50 against exact, p50/p95, underfill rate and `vector_candidates_incomplete` rate at `ef_search` 40/100/200/400, unfiltered and at 10%/50% filters. Effort 1 hd / 6-8 ah; $0 synthetic; real voyage-4 on 1M chunks ≈ 1M × 430 tokens × $0.06/M ≈ $26 (estimate). Run on Ubicloud standard-16 per the scope rules.
2. **Index build options:** `WITH (m=24|32, ef_construction=128|200)` and halfvec. Needs a migration for the canonical index and for `embedding-ann-build.ts` acceptance (the regex already allows `WITH`). Build time, size and recall from the same bench. 1.5 hd / 8 ah.
3. **BEAM-10M loader:** add `10m` to the manifest and `loadBeam` (corpus.ts:251), check the dataset revision (the 10M set is listed in BEAM, 100 convs / 2,000 Q total; the manifest has 90 conversations, so about 10 at 10M is a derived inference). About 28k chunks per conversation (2.8k × 10). Embedding about 10M tokens per conversation, ≈ $0.60 voyage-4 / $1.30 3-large each, ≈ $6-13 for 10 conversations. Ingest on PGLite with the deferred-ANN pattern. Split dev/sealed before any run. 2 hd / 10-12 ah. Coordinate with GBRA-49 (Q1 scoreboard claims BEAM-10M).
4. **Write cost at scale:** chunks/min of `embed --stale --catch-up` and sync with embeddings on, measured on the managed bench `effects` row against a real Voyage endpoint for 10k pages (≈ $0.30). That turns "10x cheaper writes" into a number. 1 hd / 4 ah.

Decision rule for production: keep defaults unless the 1M-chunk bench shows recall@10 < 0.95 or underfill > 1% at the shipped `ef_search`. If it does, ship a per-brain `search.hnsw_ef_search_floor` config knob before any migration.

---

## 6. OVERLAPS with in-flight work

| Thread / PR | Overlap with this audit | Recommendation |
|---|---|---|
| **GBRA-59** (#6278 plan; stacking on GBRA-45; read-only diagnostics requested on the issue) | Root cause of "417 h" (no preparation deadline for sync members, `consumer.ts:536`; fence round-trip `invalid_params`; `fence_repair owner_unavailable` = host-id or binding mismatch, `repair-io.ts:85`) | Items 5.2-D and the sync half of 5.1 wait for its PR. Ask GBRA-59 to include a "progress vs checkpoint" field in its sync output so D is small. |
| **GBRA-45** `capy/sync-feeder-fast-writes` (no PR; next in queue per GBRA-40) | Throughput and foreground priority; touches consumer, sync-drain and lanes | Do not touch persistence files before it merges; land 5.2-D after. Its bench rows could add a real-shape corpus (images + fences) for risk §4. |
| **GBRA-52** #6066 + evals #69 (BEAM 100k+500k+1M sealed, 54 sealed conversations, NI margin 3.0) | BEAM-1M dev arms in 5.3 must not open sealed splits; GBRA-52 is already rerunning search on the merged build (relaxed_order) | Run 5.3 on dev only, after or alongside; share the reranker-on harness check (GBRA-40 asked GBRA-39 for a fail-closed "reranker active" check). |
| **GBRA-49** evals #88 (Q2 parser gaps) and Q1 scoreboard (#89 shootout harness; BEAM-10M) | 5.4-3 (10M loader) and the tokens / write-findable columns | Let Q1 own the BEAM-10M loader; this plan contributes the index bench (5.4-1/2) and the write-to-findable metric (5.2-C) as scoreboard columns. |
| **GBRA-39** #6271 (Cat 40 Hard fixes; rerank and write failures named), evals #76/#93/#77 | Reranker activation in eval harnesses; "honest keyword counts" | Reuse #6271's rerank-failure naming in the 5.3 arms; take migration numbers after #6271 (it also planned v219). |
| **GBRA-58** (#5575 trust tiers, approved; read-only dry run on Garry's Mac) | Same device and the same privacy rules; persistence files in its PR2 | Schedule the 5.1 read-only diagnosis on the same device-permission grant if Garry agrees. Keep scratch-only output. |
| Contributor PRs | #5347 (stop retrying unembeddable chunks), #5654 (in-DB cosine rescore), #5922 (DashScope windowing) | Not mergeable directly (contributor rule). Fold #5347's idea into 5.2-A if it shows up in the backlog drain. |

---

## Appendix: files read

gbrain:
- CLAUDE.md (privacy rule), AGENTS.md, CHANGELOG.md (0.60.105-106, :3708)
- docs/eval/managed-sync-catchup.md, docs/operations/backfill-pacing.md, docs/architecture/RETRIEVAL.md:80-115, docs/designs/refactor-wave-1/perf-baseline.md
- src/core/{embedding.ts, embed-concurrency.ts, embed-stale.ts, embed-stall.ts, embed-consent.ts, embed-backfill-submit.ts, embedding-pricing.ts, embedding-ann-build.ts, vector-index.ts, db.ts, cycle.ts, sync-status-report.ts, brain-score-recommendations.ts}
- src/core/ai/recipes/voyage.ts
- src/core/search/{hybrid.ts, vector-settings.ts, vector-pool.ts, hnsw-iterative-scan.ts, eval-pool-depth.ts, internal-breadth.ts, mode.ts, rerank.ts}
- src/core/persistence/{consumer.ts, sync-run.ts, sync-prepare.ts, sync-holds.ts}, src/core/ops/admin.ts, src/core/remediation/plan.ts
- src/commands/{embed.ts, sync/preflight.ts}
- src/commands/doctor/checks/{schema-health.ts, extraction-sync.ts, managed-sync-backlog.ts, sync-search.ts}
- tests named above; scripts/bench/{hnsw-iterative-scan.ts, stale-drain.ts, vector-plan-5824.ts}
- gh: #6223, #6278 (+ comment), #5984, #5406, #6188, PR #6263 and #6269 bodies, open PR list, branch `capy/sync-feeder-fast-writes` log

gbrain-evals:
- CLAUDE.md
- docs/benchmarks/{2026-10-06-beam-1m-dates.md + receipts/rows, 2026-10-05-heldout-program.md + starting-line/summary.json + starting-line-beam-dates rows, 2026-10-05-heldout-verdicts/README.md, 2026-10-05-managed-sync-catchup.md, 2026-10-07-hnsw-relaxed-order.md, 2026-10-06-embedding-matrix.md}
- docs/plans/2026-09-28-gbrain-10x/audit/coverage-and-categories.md
- eval/runner/memory-qa/{corpus.ts, run.ts}, eval/decisions/datasets/beam-b2da22e.json, eval/decisions/splits/beam-*.json
- gh PR #69, #89 bodies

Threads read (no messages sent): GBRA-39, 45, 49, 52, 58, 59.
