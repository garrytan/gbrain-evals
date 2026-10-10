# Audit B: head-to-head benchmark, scale curve and cost table (bets 2 and 3)

Auditor: GBRA-60 subagent B. Date: 2026-10-07. Read-only.
Pins audited: gbrain master `7aa2caa0` (v0.60.106.0), gbrain-evals main `f1ce49fe` (v0.10.40).
Branches read without touching either checkout (scratch clone at `~/.capy/work/gbra60/scratchB/evals`, `git show origin/<branch>:<path>`):
`capy/oss-memory-shootout` (evals #89, head `9c07b7e`), `evals/q1-scoreboard` (head `778e92f`), `capy/memory-proof-wave` (evals #69),
gbrain `capy/memory-proof-wave` design doc via `gh api` (gbrain #6066).

Numbers marked **[recount]** are my own recomputation from committed per-question rows on a draft branch. They are not a
published result and are not the preregistered (Holm, clustered) analysis. Scripts: `~/.capy/work/gbra60/scratchB/{tab,agg}.py`.

## 0. Headline findings (read these first)

1. **Bet 2 is already ~70% designed and partly built, in two in-flight campaigns that the parent's overlap list does not fully name.**
   - **evals #89 "open-source memory comparison" (owner GBRA-1, not GBRA-49)**: a `MemorySystem` interface, an HTTP shim protocol, pinned
     Docker shims for Mem0, Hindsight, Graphiti, Cognee, Basic Memory and Letta (agent-only), a fail-closed metering proxy, a sanitizer, a frozen
     preregistration, and **Phase 4 complete (2026-10-08)**: LoCoMo dev, BEAM-100K dev and a LongMemEval-S 100-question slice for every system,
     plus full-context, no-memory and plain-hybrid controls, with ingest dollars, reader tokens and latency per cell.
   - **`evals/q1-scoreboard` (GBRA-49, preregistration draft 2026-10-06)**: the "head-to-head scoreboard" with BEAM-10M as the inferential
     headline (S1), BEAM-100K/1M sealed, LoCoMo, LME-S and LME-M rows, a file-agent (grep) baseline, write-to-queryable latency, $ per 1,000
     messages, monthly workload cost, a dispute template and an add-a-system guide. It reuses #89's harness. Cap $8,500.
   - **evals #69 / gbrain #6066 memory proof wave (GBRA-52)**: gbrain vs one "extract-first" comparator through the public agent-memory benchmark
     harness on sealed BEAM 100k+500k+1M (54 sealed conversations, margin 3.0 pts), BEAM 10M budgeted at ~$350, cap $2,800.
   Bet 2 must extend these, not start a fourth harness.
2. **The draft shootout data says gbrain loses on the token-matched read path today.** [recount] On the LME-S 100 slice at a fixed
   8,000-token budget of each system's native evidence (the preregistered primary arm, `fixed-evidence.native.b8000.main`, gpt-4o reader):
   gbrain master 0.59, Hindsight 0.89, Cognee 0.83, Mem0 0.77, plain hybrid 0.71, Basic Memory 0.69, Graphiti 0.37. gbrain has the best
   strict recall (0.979) but its native items are chunks. When every system's items are rehydrated to the raw sessions they cite, at the
   same 8k budget, gbrain is first: 0.78 vs Hindsight 0.76, Cognee 0.74, Mem0 0.73, Basic Memory 0.72, plain hybrid 0.70, Graphiti 0.40.
   So gbrain's ranking is strong and its evidence packaging is what loses.
   Cause candidate: the shootout's gbrain adapter calls `hybridSearch` and returns `chunk_text`
   (`eval/runner/systems/gbrain.ts:99,185` on #89), not gbrain's shipped `query` evidence delivery (`auto`, whole conversations), which the sealed
   v2 check measured at 192 vs 132 of 200 over chunks. The scoreboard fixes this by reading through MCP `query`.
3. **"10x cheaper writes" has real support, with a caveat.** [recount] Ingest $ for the same LME-S 100 haystacks (~4,800 sessions): gbrain
   $1.53 (embeddings only), Basic Memory $1.45, plain hybrid $1.28, Hindsight $32.11, Mem0 $42.27, Cognee $60.88, Graphiti $108.69. That is
   21x to 71x. Caveat: gbrain's shipped defaults are not zero-LLM on write (`facts.extraction` with `claude-sonnet-4-6` runs in background:
   $9.94 vs $0.32 per 1,000 pages, P8 sealed; `tokenmax`, the scripted first-run default in the scoreboard recipe, sets
   `contextual_retrieval: per_chunk_synopsis`, one Haiku call per chunk, `src/core/search/mode.ts:605`).
4. **"10x fewer tokens" runs against measured evidence.** Delivering less text has lost every time it was tested: chunks vs whole
   conversations 132 vs 192 of 200 sealed (3,280 vs 12,982 input tokens); window1/window2 recovered only 30%/36% of the gap at 44% of tokens;
   answer packets 48/60 vs 53/60. Mem0's own default context in the shootout is ~1,262 provider-reported input tokens per question (not ~7k;
   the "~7K tokens/query" figure only appears quoted in `docs/plans/2026-09-28-gbrain-10x/audit/coverage-and-categories.md:393`).
5. **BEAM-1M 53.5% is mostly a retrieval-coverage and scoring-floor problem, not dates.** [recount from committed rows] 49 of 194 answerable
   BEAM-1M dev questions have more than 5 gold turn groups (34 have more than 10) and can never pass strict recall@5; on the 145 feasible ones,
   strict@5 is 36/145 (24.8%). Accuracy is 0.727 when all gold is in the top 5, 0.586 with some, 0.424 with none. BEAM's rubric gives partial
   credit: the no-memory control scores 0.278 on BEAM-100K [recount, #89]. Abstention: 15 of 22 abstention questions scored 0 (the reader answered).
6. **Scale evidence is thin and mixed.** Only per-conversation BEAM 100K/1M dev and one merged 12M-token stress pilot exist; no BEAM-500K dev
   answer row, no BEAM-10M row, no LongMemEval-M result (4 pilot cases). At company scale gbrain trails plain files: −16 pts at 52,028 docs
   (Cat 40 scale tier) and −11.3 pts at 55,235 docs (Cat 40 Hard, #76).
7. **Sealed BEAM material is largely spent for gbrain.** BEAM-500K sealed was used by P4's pressure gate; BEAM-100K sealed by P4's core gate and
   #89 Phase 7; BEAM-1M sealed by Q2's junk audit (21 conversations) and the proof wave. The scoreboard already relabels BEAM-100K/1M sealed as
   "public rows, descriptive only". Only BEAM-10M (10 conversations, 1 question exposed) and a fresh 10-conversation 1M reserve (minting, A2)
   remain unused, and 10 clusters give a minimum detectable difference of ~16 points (scoreboard `power.json`, amendment A1).

## 1. WHAT EXISTS today

### 1.1 gbrain-evals main (`f1ce49fe`)

| Piece | Where | What it does |
|---|---|---|
| Memory QA runner | `eval/runner/memory-qa/run.ts` (456 lines), `corpus.ts` (326), `qa.ts` (181) | Loads LME-S, LoCoMo, BEAM 100k/500k/1m (`corpus.ts:128-130,251,318-322`), imports into gbrain, hybrid retrieval, optional reader (`--qa reader|think`, `run.ts:153-156`), per-benchmark default reader/judge, `--shard`, `--paid`, budget ledger. BEAM judge = one yes/no per rubric item, score = fraction met (`qa.ts:19,99-100`). |
| BEAM loader and dataset manifest | `eval/decisions/datasets/beam-b2da22e.json` (sizes 100k: 20 convs, 500k: 35, 1m: 35; hashes only, CC BY-SA 4.0); `corpus.ts:245` `beamGroupDates` (date fix, v0.10.32) | **No 10M size on main.** 10M lives only on the q1 branch (HF `Mohammadta/BEAM-10M` at `9b209619`). |
| Held-out splits | `eval/decisions/splits/beam-{100k,500k,1m}.json` | salted whole-conversation splits, dev fraction 0.3: 100k 6 dev/14 sealed, 500k 11/24, 1m 11/24 (created 2026-10-04). Also `lme-s.json`, `locomo.json`, `hub-world.json`, `world-v1-relational.json`. |
| Decision kit | `bun run eval:decide init|fetch|dev|verdict` (used by `docs/benchmarks/2026-10-06-beam-1m-dates/`) | baseline vs candidate build overlays, shards, preregistered verdict. |
| Paired comparator | `eval/runner/compare.ts` (165 lines) | `compare.ts <A> <B> --family <gates> --metric --cluster-by --seed --draws`; exit 0 pass, 1 fail, 2 inconclusive; uses `stats/gates.ts`, `stats/rows.ts`. Wild cluster bootstrap-t is on the q1 branch (`eval/runner/stats/wild-cluster.ts`). |
| Budget ledger | `eval/runner/budget-ledger.ts`, `docs/budget-ledger.md` | SQLite reservation ledger, worst-case reserve before every paid request, program cap stored in ledger. Prices (per M tokens) at `budget-ledger.ts:1020-1035`: Haiku 4.5 $1/$5, Sonnet 4.6 $3/$15, Sonnet 5.5 $2/$10, Opus 5.5 $4/$20, gpt-4.1-mini $0.4/$1.6, gpt-6.1-sol $2/$10; Voyage rerank-2.5 at line 1009. |
| Receipts manifest | `docs/receipts-manifest.json` (`schema_version, description, updated, entries`) | selected hashes and expected values checked by tests; does not verify prose. |
| Sealed custody protocol | `docs/benchmarks/2026-09-29-sealed-confirmation-protocol.md`, `-2026-10-01-sealed-confirmation-v2-protocol.md`; `eval/runner/sealed-confirmation*.ts`; data `eval/data/sealed-confirmation-v{1,2}` | 30 personas, 150 questions (30 per LME kind incl. 30 abstention), opened only at preregistered release decisions with an access log. v2 was used for the evidence-delivery release check (2026-10-02). |
| Synthetic personal world | `eval/generators/amara-life*.ts`, `eval/data/amara-life-v1/{inbox,slack,meetings,calendar.ics,notes,doc}` | 50 emails, 300 Slack messages, 20 calendar events, 8 meeting transcripts (`amara-life.ts:6-9`). Tiny: far from 1M tokens. |
| Company worlds (Cat 40) | `eval/data/model-ladder-v1/world.json`, `model-ladder-v1-large/manifest.json`, `eval/runner/cat40/`, `cat40-model-ladder.ts` | ~4,000-doc v1 world; 52,028-doc scale tier; 55,235-doc Hard tier (#76, branch). Arms oracle, fs, fs-acl, memory, pg, gbrain. |
| Privacy worlds | N6 `eval/runner/n6-visibility-fuzz.ts`, `n6-postgres-http.ts`; N8 `n8-proactive-recall.ts` (privacy gate in offline tier) | gbrain-specific (`visibility: private`); not portable to systems without a privacy concept. |
| Lifecycle / update / forget | `n1-knowledge-update.ts`, `n5-forget-residue.ts`, `lifecycle-experiment.ts` | gbrain-only; the portable `lifecycle-lite` exists on #89. |
| Abstention | `a4-abstention.ts`, `a4-s4-rescore.ts` | synthetic company world, 240 questions; near ceiling for frontier readers. |
| In-process competitor adapters | `eval/runner/adapters/`: `gbrain-inline`, `grep-only`, `vector`, `vector-rerank`, `vector-grep-rrf-fusion`, `claude-sonnet-with-tools` | **No competitor product adapter on main.** PrecisionMemBench `providers.config.json` lists only `gbrain`. |
| LongMemEval-M | `longmemeval-m-pilot-*.ts`, prereg `docs/benchmarks/2026-09-24-longmemeval-m-pilot-preregistration.md` | 28-case frozen pilot; 4 baseline cases run; no result report. |
| Streaming BEAM | `eval/runner/p4-stream/beam.ts` | BEAM conversations replayed live through gbrain hooks (P4); sealed opened by custodian only. |

### 1.2 In-flight harness code on branches (not on main)

| Branch / PR | Code | Status |
|---|---|---|
| `capy/oss-memory-shootout` (#89, GBRA-1) | `eval/runner/systems/types.ts` (`MemorySystem`: `reset`, `ingestSession(ns, session, event_time)`, `finishIngest`, `retrieve(ns, question, policy)`, `deleteSource`, `capabilities`), `eval/runner/systems/gbrain.ts` (gbrain-legacy and gbrain-shootout adapters), `eval/runner/metering-proxy.ts`, `eval/runner/shootout-cell.ts`, `eval/systems/PROTOCOL.md` (HTTP: `/health /capabilities /reset /ingest /finish /retrieve /delete_source`), `eval/systems/{mem0,hindsight,graphiti,cognee,basic-memory,letta,_fake,_shim}` with `capability.json`, compose stacks, `PILOT.md`; `lifecycle-lite` | Phase 4 (memory QA dev) complete 2026-10-08; Phase 5 PMB and Phase 6 lifecycle-lite cells committed; Phase 7 sealed (LoCoMo sealed + BEAM-100K sealed) added by amendment A5; Phase 8 Cat 40 pending. Cap $1,450. 1,159 files changed vs main. |
| `evals/q1-scoreboard` (GBRA-49) | `eval/runner/scoreboard.ts`, `scoreboard-cli.ts` (`bun run eval:scoreboard check|fixture|explain|doctor|plan|smoke|run|status|judge|render|dispute`), `eval/runner/q1/{power,stress-pilot,scoreboard-errors}.ts`, `eval/systems/kinds.json`, `docs/scoreboard.md`, `.github/ISSUE_TEMPLATE/scoreboard-dispute.md`, `docs/comparison-systems/ext-*/README.md` | Preregistration draft, OPEN values (frozen gbrain commit, campaign hash, calibration). Dev stress pilot done 2026-10-07. Sibling branches `evals/q1-runner` (write-to-queryable probes, packed and whole-system arms), `q1-baselines`, `q1-integration`, `q1-data-instruments`, `q1-frontdoor`, `q1-gbrain-defaults`. |
| `capy/memory-proof-wave` (#69, GBRA-52) | `eval/harness-provider/` (`bun run harness:cell plan|run|resume|tune|rejudge`), `eval/runner/memory-proof-wave/` (power sim, grouping manifest), `eval/workload-suites/` B1-B4 | Acceptance cells only, $4.16 spent of $2,800; sealed runs not yet. |

### 1.3 gbrain product surfaces relevant to bets 2 and 3 (master `7aa2caa0`)

- **Eval CLI**: `src/commands/eval.ts` dispatches `export, prune, replay, gate, cross-modal, brainbench, code-retrieval, retrieval-quality,
  brainstorm, whoknows, suspected-contradictions, trajectory, conversation-parser, run-all, compare, synthesize-concepts` (lines 28-125); plus
  `eval-longmemeval.ts` (`gbrain eval longmemeval`, in-memory PGLite per question, `src/eval/longmemeval/*`). **No BEAM, no competitor and no
  cost-per-ingest command in gbrain.** `gbrain eval compare` prints aggregates (10x plan amendment 4 says its "bootstrap" claim is not real).
  Docs: `docs/eval-bench.md` (1,394 lines; LongMemEval section from line 391; "Recorded experiments, including negative results" at line 20).
- **Evidence delivery / token lever**: `src/core/search/evidence-delivery.ts` (`token_budget`, `return_unit` window|section|page|auto,
  `tokens_delivered` at lines 91, 971, 1018). Remote budgets clamp at 32k (MPW design, gbrain #6066).
- **Write path**: commit path makes 0 generative calls (P8 sealed); embeddings are the only synchronous cost. Background: `facts-absorb`
  (`facts.extraction_enabled`, `src/core/config.ts:1448-1450`; model `claude-sonnet-4-6`), contextual retrieval tier per mode
  (`src/core/search/mode.ts:471` none, `:537` title, `:605` per_chunk_synopsis in tokenmax; comment: "One-time backfill cost ~$5-50 for a 10K-page
  brain"), trust-gated per-page overrides (`src/core/contextual-retrieval-resolver.ts`).
- **Scale limits found in the field** (Cat 40 scale tier README, gbrain `ad7900d`): `sources add` refuses >~8,000 files (1 MiB manifest bound,
  `src/core/persistence/source-lifecycle.ts:111`); PGLite sync slows from >7 to 2.3 docs/s by 13,000 pages (stale planner stats), hard-killed
  after 1 hour; `embed --stale` stops after 30 min without `--catch-up`; `gbrain serve` takes ~80 s to boot at 52k docs vs a 60 s deadline.
  Doctor emits `pglite_scale` past 1,000 pages (scoreboard engine rule). Managed Postgres catch-up: 152.8 pages/min (v0.60.73.0, README).

### 1.4 Competitor systems: adapter vs quoted (source: `docs/comparison-systems.md` on main, shims on #89, kinds on q1)

| System | On main | Runnable shim (#89) | Scoreboard kind (q1) | Quoted numbers on main |
|---|---|---|---|---|
| Mem0 OSS 2.2.1 | no | yes (Qdrant) | `ext-extract-first` (mapping confirmed in `docs/comparison-systems.md` on `evals/q1-scoreboard`, lines 22-28) | LME-S 94.4% self-reported (gpt-4o, top-200); 49.00% independent; HaluMem extraction 42.9%; PMB 0.06 |
| Hindsight 0.10.2 | no | yes (Postgres+pgvector) | `ext-memory-bank` | LME-S 91.4% / 89.0% / 94.6% vendor; AMB rows (MPW doc: comparator BEAM rag 86.2/80.1/79.1 at 100k/500k/1M, historical only) |
| Graphiti 0.30.2 (not Zep) | no | yes (Neo4j 5.26) | `ext-temporal-graph` | Zep 90.2% (gpt-5.4 reader+judge), 71.2% older paper |
| Cognee 1.6.2 | no | yes | `ext-graph-pipeline` | none on main |
| Basic Memory 0.23.2 (AGPL) | no | yes | `ext-markdown-kb` | none |
| Letta 0.34.4 | no | agent-only (no passive memory API) | `ext-agent-runtime` | none |
| MemPalace 3.10.0 (raw vector; LoCoMo hybrid, LLM rerank off) | no | no (#89); install bundle on q1 | `ext-verbatim-session` | MemPal any-hit 96.6-100%, our strict recount 85.7-90.0% |
| Mastra OM, Supermemory, ByteRover, Zep platform, MemCog, Lethe, agentmemory, ContextFit | no | no | no | quoted only (LME-S QA or R@5) |
| Full context, plain files + grep, Postgres hybrid, recency, none | partly (Cat 40 fs/pg arms) | full-context, no-memory, plain-hybrid controls | `baseline-*` | n/a |

## 2. WHAT HAS BEEN MEASURED

### 2.1 BEAM (all development data unless stated)

| Run | Build | Size, split | Retrieval | Answer | Reader / judge | Source |
|---|---|---|---|---|---|---|
| Starting line, old loader | `6622a119e` v0.60.48.0 | 100K dev, 120 q (108 gold) | strict@5 45.4%, any@5 80.6%, nDCG@10 0.568 | 57.1% (answerable 62.6%, abstention 8.3%) | gpt-4.1-mini / gpt-4.1-mini | `docs/benchmarks/2026-10-05-heldout-program.md:26`, `starting-line/summary.json` |
| Starting line, old loader | same | 1M dev, 220 q (198 gold) | strict@5 18.2%, any@5 68.7%, all@10 27.8%, nDCG@10 0.428 | 54.6% (answerable 58.7%, abstention 18.2%) | same | same, line 27 |
| Fixed loader | `6622a119e` | 100K dev | strict@5 47.2% | 58.0% | same | heldout-program.md:35 |
| Fixed loader (W13) | `6622a119e` and `c5fb0201` | 1M dev | strict@5 18.2% (36/198) both builds; any@5 69.2%; all@10 28.8% | **53.5%** at `6622a119e` (answerable 56.1%, abstention 29.5%); not run at `c5fb0201` ($2 cap) | same | `docs/benchmarks/2026-10-06-beam-1m-dates.md`; spend $2.76 |
| P4 pressure gate (**sealed**) | master `8c9a8e9a4` vs #6015 | 500K sealed, 24 convs, 480 q | n/a | +11.35 pts for save notice; $0.87 vs $0.68 per question | claude-sonnet-5-5 / gpt-4.1-mini x10 | `heldout-program/p4.md:7,15,33` |
| P4 core gate (**sealed**) | same | 100K sealed, 14 convs, 56 q | n/a | FAIL: gpt-6.1-sol 88.1→85.7, fable −2.4 | four models | `p4.md:16,34` |
| Shootout Phase 4 | gbrain `c5fb0201` (master) and pin | 100K dev, 6 convs | gbrain-shootout strict@5 0.574 (best of 7 systems) | see 2.3 | gpt-4.1-mini / gpt-4.1-mini | #89 receipts [recount] |
| Scoreboard dev stress pilot | `gbrain-defaults` 0.60.95.0, voyage-4, tokenmax, rerank on | 11 BEAM-1M dev convs **merged into one brain**: 9,003 sessions, 22,338 messages, ~12.0M tokens | recall_any@10 0.825, recall_all@10 0.361; tokens delivered mean 26,127 per bare `query` | not judged | n/a | `docs/benchmarks/2026-10-06-scoreboard/dev-stress-pilot/receipt.json` (q1 branch); ingest 39 min, embed barrier +43 min, query p50 4.3 s p95 6.0 s, peak RSS 0.82 GB (670,276 KB serve), brain 1.07 GB, spend $1.79 |
| BEAM-10M | none | | | | | not found |
| BEAM-500K dev answers | none | | | | | not found |

Model-rule note: the BEAM reader `gpt-4.1-mini` violates "run the newest frontier model of each family; don't run older generations"
(project AGENTS.md). The W13 report justifies it as the protocol-fixed historical link (decisions G8, G9). It cannot support any product claim
about what a frontier reader does with gbrain's BEAM evidence. The BEAM *judge* `gpt-4.1-mini` is a fixed instrument and is kept by the scoreboard.

### 2.2 BEAM-1M failure decomposition from committed rows ([recount], `docs/benchmarks/2026-10-06-beam-1m-dates/qa/baseline/shard-*/rows.ndjson.gz`, 220 rows, mean 0.5348)

| Bucket | n | Mean score | Full credit | Zero |
|---|---:|---:|---:|---:|
| All gold turn groups in top 5 | 36 | 0.727 | 23 | 7 |
| Some gold in top 5 | 101 | 0.586 | 30 | 19 |
| No gold in top 5 | 61 | 0.424 | 16 | 19 |
| Abstention questions | 22 | 0.295 | 6 | 15 |

- Gold count distribution (answerable with gold, n=194): 41 need 1, 40 need 2, 32 need 3, 24 need 4, 8 need 5, **49 need more than 5, 34 more
  than 10** (max 38). Strict@5 on the 145 feasible questions: 36 (24.8%). Mean score on the 49 infeasible: 0.411.
- No-gold bucket still scores 0.424 because BEAM's rubric gives partial credit per item (`qa.ts:99-100`); the #89 no-memory control on BEAM-100K
  scored 0.278 [recount]. The effective dynamic range of "53.5%" is roughly 28% to 73%, not 0 to 100.
- Category x bucket: summarization 11 none / 11 some / 0 all; instruction following 15 none / 6 all; information extraction 12 none / 8 all;
  event ordering 10 none / 12 some / 0 all; knowledge update 16 some / 5 all.
- Reader context: mean 7,684 counted context tokens (5 sessions), p95 13,205.
- Reading loss is real but second: even with every gold turn group delivered, mean is 0.727 with a weak reader (7 zeros of 36).
- Retrieval did not move between v0.60.48 and v0.60.95 (identical recall on all 198; 212/220 identical ranked lists). Settings never tested on
  BEAM-1M at scale: reranker on, expansion on, top-k > 10, page-unit delivery, a frontier reader, `think` with date frame.

### 2.3 Open-source shootout Phase 4 ([recount] from #89 rows; service quality = product failures count 0; tokens = provider-reported reader input tokens, mean per question)

**LongMemEval-S, stratified 100-question slice, reader gpt-4o-2024-08-06, judge gpt-4o official prompts** (development data for gbrain):

| System (common models) | 8k native svc | 8k native tok | Default amount svc | Default tok | 8k rehydrated svc | strict@5 | Ingest $ (100 haystacks) |
|---|---:|---:|---:|---:|---:|---:|---:|
| gbrain-shootout @ master `c5fb0201` | **0.59** | 6,638 | 0.63 | 10,015 | 0.78 | 0.979 | **1.53** |
| Hindsight | 0.89 | 8,739 | 0.88 | 7,169 | 0.76 | 0.979 | 32.11 (a3 rerun) |
| Cognee (3 shards pooled) | 0.83 | ~6,900 | 0.85 | ~6,130 | 0.74 | 0.94 | 60.88 |
| Mem0 | 0.77 | 7,591 | 0.78 | **1,262** | 0.73 | 0.94 | 42.27 |
| plain hybrid control | 0.71 | 5,530 | 0.86 | 25,019 | 0.70 | 0.896 | 1.28 |
| Basic Memory (2 shards pooled) | 0.69 | ~5,090 | 0.85 | ~20,600 | 0.72 | 0.83 | 1.45 |
| Graphiti | 0.37 | 6,077 | 0.86 | 27,797 | 0.40 | 0.40 | 108.69 |
| full-context control | 0.14 at 8k | | 0.78 at ~128k ctx | | | | 0 |
| no-memory control | | | 0.09 | 139 | | | 0 |

**BEAM-100K dev, 6 conversations, 120 q, reader and judge gpt-4.1-mini:**

| System | 8k native svc | Default svc | Default tok | strict@5 | Ingest $ |
|---|---:|---:|---:|---:|---:|
| gbrain-shootout master | 0.605 | 0.578 | 10,389 | **0.574** | 0.115 |
| gbrain-shootout master, recipe (`gbrain init` defaults) | 0.599 | 0.611 | 9,840 | 0.546 | 0.055 |
| Cognee common | 0.569 | 0.578 | 12,677 | 0.537 | 2.10 |
| Hindsight common | 0.583 | 0.574 | 7,158 | 0.398 | 3.21 |
| Mem0 common / recipe | 0.554 / 0.550 | 0.570 / 0.591 | 1,297 / 1,394 | 0.426 / 0.407 | 1.63 / 5.69 |
| Basic Memory recipe (local embedder) | 0.622 | 0.573 | 5,447 | 0.444 | 0 |
| Graphiti common | 0.431 | 0.637 | 17,447 | 0.120 | 10.28 |
| plain hybrid | 0.549 | 0.592 | 14,377 | 0.426 | 0.089 |
| full context | 0.378 at 8k | 0.600 at ~148,700 ctx | | | 0 |
| no memory | | 0.278 | 135 | | 0 |

**LoCoMo dev r1, 587 q, reader gpt-4o-mini:** gbrain-shootout master 8k native 0.649 (rehydrated 0.727, strict@5 0.873); Mem0 common (a2)
0.760; Hindsight common 0.756; Cognee recipe 0.712; Graphiti recipe vendor-default 0.702; Basic Memory 0.673; plain hybrid 0.670; full
context 0.629 (at ~25k ctx); no memory 0.218.

Reading: rehydration isolates ranking from packaging; gbrain's ranking leads, its native packaging trails. On BEAM-100K every system sits between 0.55 and 0.65 under a weak reader, full context ties retrieval systems, and only 3 and 6
clusters exist (the preregistration labels LoCoMo and BEAM dev descriptive). On LME-S gbrain's retrieval is the best but its native evidence
unit is the worst-performing at 8k among non-graph systems. These are the cells the bet's head-to-head would publish.

### 2.4 Write cost

| Measurement | Number | Data | Class | Source |
|---|---|---|---|---|
| P8 write cost, sealed verdict | **on $9.942 / off $0.32 per 1,000 pages**; commit-path generative attempts 0 in both arms | 1,000 LME-S sessions (10,313 messages, 991 remembered facts), gbrain `6c958d6e2` v0.60.48.0, text-embedding-3-large | sealed/held-out verdict file (data is LME-S, public) | `docs/benchmarks/2026-10-05-heldout-verdicts/p8-write-cost-2026-10-05.json`; `heldout-program/p8.md:22`; gbrain `CHANGELOG.md:774` |
| Breakdown (on arm) | Sonnet 4.6 facts-absorb $9.62 (1,021 calls, 2.17M in / 0.21M out tokens), embeddings $0.322 (5,551 calls, 2.48M tokens); `put_page` p50/p95 80/168 ms; `remember` 282/399 ms; **job drain 4,673 s (78 min) for 996 jobs** | | | same JSON |
| P8 dev | on $11.97 / off $0.32 per 1,000 pages ($1.16 / $0.03 per 1,000 messages); drain 96 min; extraction jobs drain ~one at a time on PGLite even at `--concurrency 4` | build `ef0de8657` | development | gbrain `docs/eval/decisions/p8/DEV_RESULTS.md:19-33` |
| Derived embedding price | $0.322 / 2.48M tokens ≈ $0.13 per M tokens (text-embedding-3-large) | | derived | from P8 JSON |
| Per-system ingest $ per M ingested tokens [recount, #89] | BEAM-100K (~0.6M tokens): gbrain ~$0.19, Mem0 common ~$2.7, Cognee ~$3.5, Hindsight ~$5.4, Graphiti ~$17 | | development | #89 receipts; token count assumes ~100k per conversation (BEAM size label) |
| Scoreboard stress pilot | ~12.0M tokens ingested for $1.79 total (embeddings, rerank, expansion), voyage-4 | | development | q1 prereg "Engine rule" |

### 2.5 Tokens delivered

- gbrain release read for LME-S: ~22,000 Sonnet 5.5 input tokens per question (mean 22,077 for Claude readers, 13,695 for gpt-6.1-sol on the
  same text) at 93.6% (468/500): `docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin.md:9,17`, `w10b-reader-replay.md:53`.
- Bare `query` default delivers up to 24,000 tokens (scoreboard prereg); mean 26,127 on the 12M merged brain (stress pilot).
- Sealed v2: `auto` 192/200 at 12,982 tokens vs `chunk` 132/200 at 3,280 (`2026-10-02-sealed-v2-decision-1.md:3-5`).
- Evidence delivery (dev, LME-S 400): page 361, chunks 253, window1 285, window2 292 at 44% of page tokens; verdict `page_only`
  (`2026-09-30-evidence-delivery.md:3`).
- Answer packets: 48/60 vs 53/60 full sessions, $8.01 (gbrain `docs/eval-bench.md:24-31`).
- Mem0's "~7K tokens/query" is quoted only in a plan audit; #89 measured ~1,262-1,394 reader input tokens for Mem0's default.

### 2.6 Scale (accuracy as the corpus grows)

- Cat 40 scale tier (52,028 docs, 41.5 MB Markdown, gbrain `ad7900d`): gbrain −16 pts vs grep files pooled over four models (CI −24 to −10);
  gpt-6.1-sol 92% vs 96%. Claims judge was `gpt-5.4-mini` (now disallowed). `docs/benchmarks/2026-10-02-model-ladder/scale-tier/README.md:7-9`.
- Cat 40 Hard (#76, draft, 55,235 docs, 100 held-out tasks): gbrain 62.0%, fs 73.3%, pg 68.3%, oracle 98.0%; gbrain − fs = −11.3 [−16.7, −6.0];
  wrong answers 50 vs 13. Root cause (#93): missing nicknames ~6.7 pts, no result counts 0-2 pts.
- BEAM per-conversation: 100K strict@5 47.2% → 1M 18.2% (different conversations; not a controlled curve).
- No same-questions-growing-haystack curve exists for gbrain. LME-M (the natural S→M curve) has 4 pilot cases.

### 2.7 Confident wrong answers and abstention

- LoCoMo adversarial (dev, starting line): 63.4% abstain correctly, **42.3% repeat the planted false answer** (`heldout-program.md:25`,
  `summary.json` `abstention_trap_rate` 0.4228).
- BEAM-1M fixed loader: abstention 29.5%; 15 of 22 abstention questions scored 0 [recount]. BEAM-100K starting line abstention 8.3%.
- A4 synthetic world: reader abstains 119/120 (Sonnet 4.6) and 117/120 (Sonnet 5.5); S4 separates perfectly at 0.5 but "ships no threshold"
  (`2026-10-06-a4-s4-on.md`). CRAG grade useless as a gate (`2026-10-01-a4-abstention.md`).
- No benchmark in either repo reports a "confident wrong answer" rate or a risk-coverage curve (grep for `confident wrong|risk-coverage|AURC`
  finds only plan text).

### 2.8 Time until a new write is findable

- Commit path: `put_page` p50 80 ms; keyword-findable at commit (synchronous import, `gbrain.ts` capability "readiness: synchronous").
- Vectors: stress pilot embedding barrier finished 43 min after the last of 9,003 bulk writes (q1 prereg).
- Facts: 78 min to drain 996 extraction jobs (P8 sealed JSON).
- `remember` writes were not findable by `search`/`query` at v0.60.27 (scale-tier README:79). Current status not verified here.
- No published per-system write-to-queryable p50/p95; it is a scoreboard metric (q1 prereg "Metrics" 3) and a q1-runner probe.

### 2.9 Negative results the plan must carry

Retrieval unchanged by the whole P-series on BEAM-1M (W13). P2 hub dampening FAIL (sealed). P3 triplet scoring FAIL, LoCoMo feedback FAIL. P4
core tier FAIL. P5 H3 FAIL (precision 0/18). P8 narrower tool surface FAIL (−8.5/−9.9 pts). P1 E1 round 1 FAIL and third-phrasing FAIL
(traps 89/105). Fusion experiment flat (202/215 vs 203/215). Window delivery missed its 60% bar. Answer packets lost 5. gbrain trails files at
52k and 55k docs. Shootout: gbrain native 8k last among non-graph systems on LME-S [recount].

## 3. GAPS between Garry's bet and reality

| Bet element | Reality | Gap |
|---|---|---|
| Realistic personal-scale worlds (email, meetings, docs) at 1M-10M tokens | Scoreboard and #89 use conversation benchmarks only (BEAM, LoCoMo, LME). Personal world `amara-life-v1` is ~380 items; company worlds are 52-55k docs of business mail | **No personal email+meetings+docs world at 1M-10M tokens exists.** Must be generated (seeded, solvable, oracle ledger). |
| Facts that change | BEAM knowledge-update and contradiction categories; N1 (gbrain-only); #89 `lifecycle-lite` (portable, update and forget) | Need change events across sources (email correction, later meeting) inside the big world, scored as-of. |
| Multi-hop | BEAM multi-session, N9 (gbrain), Cat 40 Hard multi-account | Need cross-document hops in the personal world (person → meeting → doc). |
| Trick questions where "I don't know" is right | BEAM abstention (22 of 220 at 1M), LoCoMo adversarial, A4 | No "confident wrong" column; partial-credit BEAM judge blurs it. |
| Privacy-leak checks | N6/N8 gbrain-only; #89 Phase 0 cross-namespace canary; scoreboard excludes N6 | No portable privacy column. Most competitors have no private-page concept; need a namespace/grant model and forget-residue instead. |
| Columns: accuracy, confident-error rate, tokens/answer, read latency, $ to ingest, time to findable | Scoreboard has accuracy, tokens, latency, $/1,000 messages, write-to-queryable, monthly cost | Missing: confident-error rate; findability split by retrieval arm (keyword vs vector vs facts). |
| Adapters for Mem0, Hindsight, Graphiti, Letta-style files, full context | #89 shims: Mem0, Hindsight, Graphiti, Cognee, Basic Memory, Letta (agent-only); controls full-context, none, hybrid; q1 adds file agent, recency | **Built.** Gap is gbrain's own adapter (chunks vs shipped delivery) and Letta passive memory. |
| Defaults and best settings | #89 "recipe" vs "common models"; scoreboard headline = documented recipe if ingest fits 48 h | "Best settings" (vendor-tuned) not defined; needs a vendor-tuning window or a published sweep with caps. |
| Vendors invited to submit | #89 D4 "no public vendor posts for now"; scoreboard has dispute template and add-a-system guide | No submission protocol for vendor-run results; no verification beyond disputes. |
| Scale curve 100k → 10M | BEAM 100K/1M dev rows, 500K sealed (P4 only), 12M merged stress pilot (retrieval only); scoreboard S1 BEAM-10M, S2 100K/1M | No controlled curve (same questions, growing haystack). No 500K or 10M answer row yet. |
| Cost table for 10 years of one person's data | Per-system ingest $ at 0.6M and ~11.5M tokens exist in #89 rows; P8 per-page cost | "10 years of email/meetings/docs" token size not found anywhere; no extrapolation method published. |
| "BEAM 1M at 53.5% says gbrain does not look best" | Under gpt-4.1-mini reader; comparator's quoted AMB BEAM rag 79.1 at 1M is a different harness, judge and reader (MPW doc) | No matched BEAM-1M comparison exists yet (MPW sealed and scoreboard S2b will produce one). |

## 4. RISKS and prior failures the plan must not repeat

1. **Duplicate harnesses.** Three campaigns (#89, q1 scoreboard, #69) each built a metering proxy, sanitizer and cell runner; q1 reuses #89,
   #69 uses the public harness. A fourth would split vendors' attention and the spend cap. Extend the scoreboard.
2. **Measuring gbrain through a non-shipped read path.** #89's gbrain-shootout returns `hybridSearch` chunk text; the shipped path returns whole
   conversations (`auto`). The headline would understate gbrain by roughly the 8k native vs rehydrated gap (0.59 vs 0.78 on LME-S [recount]).
   The opposite risk also exists: tuning gbrain's adapter after seeing competitor results. Fix the gbrain arm before any sealed cell.
3. **Spent sealed data.** BEAM 100K/500K/1M sealed have all shaped gbrain defaults (P4, Q2, MPW). Re-using them as "held out" repeats 10x-plan
   amendment 1's error. Only BEAM-10M (minus `1_abstention_0`, exposed) and the A2 fresh reserve are clean, and only from gbrain's side.
4. **Underpowered headline.** 10 BEAM-10M conversations: MDD 16.0 pts with nine comparisons, 13.6 after shrink (q1 `power.json`, A1). A
   "10x fewer errors" claim cannot be read off 10 clusters. A generated world can supply 50-100 independent personas.
5. **Partial-credit judge floors.** BEAM rubric: no memory = 0.278. Report a no-memory floor beside every BEAM number and a strict all-items-met
   rate; never quote "53.5%" without the floor.
6. **Old readers.** gpt-4.1-mini / gpt-4o / gpt-4o-mini readers are protocol links only. Product claims need opus-5-5, gpt-6.1-sol,
   sonnet-5-5 (Fable smoke only, project rule 2026-10-07). Note: gbrain-evals `CLAUDE.md` "Choose models" still says "Opus, GPT, Sonnet and
   Fable"; the project rule overrides it and the file should be amended. Cat 40 scale tier used a `gpt-5.4-mini` claims judge (disallowed).
7. **Token-saving premise.** Every less-text delivery tested so far lost accuracy (2.5). Bet (b) must be framed as accuracy at equal tokens
   (frontier curve), not a token cut at fixed settings.
8. **Zero-LLM write claim vs shipped defaults.** Facts extraction (Sonnet 4.6, background) is on by default (P8 dev "on (default)"); tokenmax adds
   per-chunk Haiku synopses. A cost table that shows gbrain at embedding-only cost must name the configuration and also show the defaults row.
9. **Scale fragility at 50k+ docs** (manifest bound, sync slowdown, embed timeout, serve boot). A 10M-token personal world (~tens of thousands of
   pages) will hit these; GBRA-45 and GBRA-59 are on the sync side.
10. **Harness failure counted as product loss.** #89 logged Mem0 `/finish` timeouts (587 rows `ingest_degraded`), Hindsight 64 MB shm (340 of
    400 `retrieval_error`), Cognee lease refusals; each needed an amendment and rerun. Keep the canonical-outcome rules.
11. **Leaks.** Raw `answer_` session ids reached readers (historical 86.6% invalid); the public harness puts `{question_id}_{session_id}` into
    contexts (61 of 500 committed contexts, MPW doc) and scores `bool("false")` as a pass. Use the sanitizer and input allowlist (amendment 6).
12. **Vendor relations.** #89 decision D4 deferred vendor posts; BEAM-10M exposure audit shows another thread printed a gold answer into an agent
    context. Custody discipline is mandatory before inviting outside submissions.

## 5. PROPOSED WORK ITEMS

Effort: human-days (HD) / agent-hours (AH), rough. Costs use ledger prices (2.4) and #89 measured cell costs; all estimates, re-price at freeze.

### 5.1 Benchmark spec (name-free; working title "personal memory scoreboard")

**Worlds.** (W-P) Seeded personal worlds, one persona each, rendered as dated email threads, calendar events, meeting transcripts, chat, and
documents (drafts with revisions). Sizes 100k, 500k, 1M, 3M, 10M tokens, **nested**: each larger world contains the smaller world verbatim plus
added distractor months, so the same questions are asked at every size. 60 personas at 1M (clusters for inference), 10 at 10M. Oracle ledger
(fact, source doc ids, valid_from/valid_to, privacy class) written by the generator; questions never shown to systems. Plus the existing public
sets (BEAM 100K-10M, LoCoMo, LME-S/M) as external-validity rows.

**Question types (per persona, fixed mix):** single fact (15%), multi-hop across sources (15%), aggregation over 3+ docs (10%), temporal/as-of
(15%), knowledge update after a correction (15%), contradiction between sources with a resolvable rule (5%), unanswerable trick questions where
the right answer is "I don't know" (15%: never-mentioned, sibling attribute, wrong-person, future date), privacy probes (10%: a fact marked
private or deleted, asked by a non-owner principal or after `forget`).

**Columns and definitions.**
- Accuracy: judged correct share over all questions (product failures = 0); BEAM-style partial credit reported separately with its no-memory floor.
- **Confident wrong answer rate (CWA)**: share of questions where the answer commits to a value (not an abstention under the frozen abstention
  rubric, e.g. A4-4 revision) and the judge scores it wrong (score 0, or < 0.5 on rubric sets). Report per 100 questions overall and on
  unanswerable questions separately (hallucination rate). Where a system exposes a confidence or answerability score (gbrain S4), add a
  risk-coverage curve and selective risk at 90% coverage. 10x target: CWA ratio vs baseline, with a cluster CI.
- Tokens per answer: provider-reported reader input tokens (and the harness's packed count), mean and p95; plus system-internal LLM tokens on
  the read path (expansion, rerank) priced separately.
- Read latency: server-side retrieval p50/p95 on identical VM classes; end-to-end answer p50/p95.
- $ to ingest: ingest LLM $ + embedding $ + CPU-hours at a stated rate, per 1M ingested tokens and per persona-world; synchronous vs background split.
- **Time to findable**: write-start to the first successful retrieval of a planted probe fact, p50/p95, measured per arm (keyword, vector,
  extracted fact/graph); probes = last session plus 20 sampled sessions per world (q1 already defines "write-start-to-queryable").
- Privacy leak count: private-fact or deleted-fact text in any delivered context or answer for a non-entitled principal; exact `== 0` safety gate;
  "not applicable" (not 0) where a system has no grant model; forget residue from `lifecycle-lite`.

### 5.2 Work items

| # | Goal | Files | Migration | Effort | Proof metric and dataset | Paid cost |
|---|---|---|---|---|---|---|
| B1 | **Fix gbrain's arm in the head-to-head**: read through shipped `query` evidence delivery (`auto`/page, `token_budget`) in #89's gbrain-shootout adapter, as a named amendment before Phase 7 sealed cells; keep the chunk arm as a diagnostic | evals `eval/runner/systems/gbrain.ts` (#89), prereg amendment; no gbrain change | no | 1 HD / 4 AH | LME-S 100 slice and LoCoMo dev, 8k native: gbrain `query`-delivery svc vs chunk svc and vs Hindsight/Mem0; paired, conversation-clustered | ~$20 per LME-S arm (gbrain LME-S cell committed $19.9), ~$7 LoCoMo, ~$3 BEAM-100K |
| B2 | **BEAM-1M failure analysis** (retrieval vs reading vs dates vs loader vs judge) | evals: new `docs/benchmarks/<date>-beam-1m-failure-analysis*`, reuse `memory-qa/run.ts`; no gbrain change | no | 2 HD / 8 AH | 1M dev 220 q: (a) keyless decomposition table (2.2) incl. feasible-subset strict@5; (b) oracle-evidence arm (gold turn groups to the reader) = reading ceiling; (c) frontier reader replay (sonnet-5-5, opus-5-5, gpt-6.1-sol) on frozen top-5 contexts; (d) top-k 5/10/20/40 x reranker on/off x expansion on/off, retrieval only; (e) page/`auto` delivery at 8k/16k/24k; (f) loader audit: turn-group granularity vs BEAM's own session unit, gold count > 5 share; (g) no-memory floor and strict all-items-met rate | retrieval arms ~$0.06 each (cached embeddings); reader arms: 220 q x ~8k tokens ≈ 1.8M in: sonnet-5-5 ~$4-5, gpt-6.1-sol ~$4-5, opus-5-5 ~$8-9 per arm incl. output; judge gpt-4.1-mini ~$1/arm. Total ≈ $40-60 |
| B3 | **Personal world generator** (email, meetings, calendar, docs, chat) with nested sizes 100k → 10M and an oracle ledger incl. change events, hops, traps and privacy classes | evals `eval/generators/personal-world-*.ts` (extend `amara-life.ts`, `world.ts`, `n1/n3/n5/n6` generators), `eval/data/personal-world-v1/manifest.json` (hashes only for big sizes), solvability + presence checks | no | 6 HD / 30 AH | keyless: solvability 100% on oracle evidence; presence of every gold span; nested invariance (100k questions answerable identically at all sizes with oracle) | generation: if LLM-rendered prose, ~10M output tokens for one 10M world; at sonnet-5-5 output $10/M ≈ $100 per 10M persona, ~$10 per 1M persona; template rendering ≈ $0. Recommend template core + LLM paraphrase for 20% |
| B4 | **Confident-wrong and abstention instrument** shared by all systems | evals `eval/runner/memory-qa/outcomes.ts`/`instruments.ts` (q1), `qa.ts` | no | 1.5 HD / 6 AH | CWA definition validated on A4 (known labels) and LoCoMo adversarial (planted answers): human-adjudicated 100-item sample, judge agreement ≥ 90% | ~$5 judge re-runs |
| B5 | **Portable privacy column** (grants/namespaces + forget residue + secret redaction probes) | evals `eval/systems/PROTOCOL.md` (optional `/principal` or namespace-per-principal), `lifecycle-lite`, privacy probes in B3 world | no | 2 HD / 8 AH | leak count == 0 per system on privacy probes; "not applicable" recorded where unsupported; control: a deliberately leaky fake shim must fail | <$10 (retrieval only plus deletes) |
| B6 | **Scale curve experiment** (see 5.4) | evals q1 runner cells; `scoreboard.ts` render | no | 3 HD / 12 AH | accuracy, CWA, tokens, latency, ingest $ at 100k/500k/1M/3M/10M on the nested personal world (same questions), plus BEAM per-size rows and the merged-BEAM 1M→12M retrieval curve | see 5.4: ~$700-1,000 |
| B7 | **Cost table** (see 5.5) | evals `docs/benchmarks/<date>-cost-table.md`, `scoreboard.ts` monthly-cost columns | no | 1.5 HD / 6 AH | $ per 1M ingested tokens per system per config (defaults, common, gbrain zero-LLM), measured on BEAM-100K, LME-S and personal-world 1M; extrapolated to "10 years" with the token model stated | mostly reuse #89/q1 receipts; new personal-world ingest for 6 systems at 1M ≈ $3-17 per system per persona (BEAM-100K $/M rates) x 3 personas ≈ $150 |
| B8 | **Vendor submission and verification protocol** (5.6) | evals `docs/scoreboard.md` "Submit a system", `eval/systems/PROTOCOL.md`, receipt schema (campaign hash, image digests, proxy usage log hash, per-row context hashes), `eval:scoreboard verify` | no | 2 HD / 8 AH | a fake vendor submission passes `verify`; a tampered one (edited row, swapped image digest, unmetered call) fails; custodian spot re-run reproduces ≥ 95% of retrieval lists for deterministic systems | spot re-runs ~10% of a vendor's cells ≈ $20-50 per vendor |
| B9 | **Time-to-findable instrumentation in gbrain** (expose per-arm readiness: keyword at commit, vectors embedded, facts extracted) so the column can be measured without polling | gbrain `src/core/operations.ts` (read-only `index_status` op or `doctor` field), `src/commands/jobs*`, docs; tests | no (reads existing job/embedding state) | 2 HD / 8 AH | write-to-queryable p50/p95 per arm on the personal world 1M, gbrain vs systems | $0 extra (rides B6) |
| B10 | **Headline power**: move the inferential family to the nested personal world (60 personas at 1M) and keep BEAM-10M as a descriptive/external row | q1 prereg amendment (before freeze) | no | 0.5 HD / 2 AH | simulated MDD ≤ 5 pts on accuracy and a 2x CWA ratio detectable at 80% power (`eval/runner/q1/power.ts`) | $0 (simulation) |

### 5.3 Adapter contract (reuse #89 / q1 as-is)

`MemorySystem` (`eval/runner/systems/types.ts` on #89) and the HTTP shim protocol (`eval/systems/PROTOCOL.md`): `/health`, `/capabilities`
(capability record: versions incl. lock sha and image digest, configs recipe/common with every model role, time native|in-text, provenance
exact|partial|unavailable, delete native|composition|unsupported, readiness signal, namespace, retrieval policies, telemetry off, deviations from
vendor code), `/reset`, `/ingest(ns, session, event_time)`, `/finish` (quiescence), `/retrieve(ns, question, policy)` returning ranked items
`{id, rank, type, text, source_ids[], valid_from?, valid_to?, provenance_status}` with applied settings, `/delete_source`. Additions needed for
this bet: `principal` on ingest/retrieve (B5), a readiness probe endpoint per arm (B9), and a document-kind field (email, meeting, doc) so
systems that treat sources differently can use it.

| Adapter | State | Remaining effort |
|---|---|---|
| Mem0, Hindsight, Graphiti, Cognee, Basic Memory | built and piloted (#89) | ~0.5 HD each to add `principal` and readiness |
| Letta | agent-only (no passive API at 0.34.4) | native-agent cell exists in q1 plan for LoCoMo; 2 HD to add personal-world agent cell |
| Letta-style files / file agent | `baseline-file-agent` (q1: list/grep/read, 40-turn cap) and Cat 40 `fs`/`memory` arms | 1 HD to point at personal-world Markdown |
| Full context | built (#89 control; q1 with prompt caching) | 0 |
| gbrain | gbrain-legacy, gbrain-shootout (#89, chunk text), `gbrain-defaults` (q1, MCP `query`) | B1 |
| Supermemory, Zep platform, Mastra OM | quoted only; managed/closed | vendor submission only (B8) |

### 5.4 Scale-curve experiment design

- **Primary curve (controlled):** nested personal world, sizes 100k, 500k, 1M, 3M, 10M tokens; same question set at every size (questions planted
  in the 100k core, plus size-specific needle questions placed in added months). 10 personas at every size (60 at 1M for B10's inference).
- **External rows:** BEAM 100K/500K/1M dev (public), BEAM-10M (S1, custodian), LME-S → LME-M 100 (q1 S5).
- **Cheap retrieval-only curve now:** the 11 BEAM-1M dev conversations, asked one at a time against their own 1M brain vs against the merged
  ~12M brain (stress pilot already ingested it): strict@5/@10, any@10, tokens delivered, p95 latency, same gbrain-defaults config. Cost ≈ $2.
- **Systems:** gbrain-defaults, gbrain zero-LLM config (facts off, title CR), Hindsight, Mem0, Cognee, Graphiti (common config; recipe only
  where ingest fits 48 h), file agent, plain hybrid, full context where it fits the reader window (fails past ~1M; record "refused").
- **Readers (model rule):** claude-opus-5-5, gpt-6.1-sol, claude-sonnet-5-5 on the 8k matched arm; sonnet-5-5 only on the default-amount and
  2k/16k sweep; Fable smoke only. Judges: canonical per benchmark; personal world judge = gpt-6.1-sol with a 300-item human-checked sample.
- **Cost (estimate):** reader: 10 personas x 5 sizes x ~100 q x 3 readers x ~8k tokens ≈ 120M input tokens ≈ $300 (blended $2.7/M) + outputs
  ≈ $350-450. Ingest at 10M x 10 personas = 100M tokens: gbrain ~$15 (stress-pilot rate), Mem0 ~$270, Hindsight ~$540, Cognee ~$350,
  Graphiti ~$1,700 (BEAM-100K $/M rates) → Graphiti likely capped to 1M or common-config only. Total ≈ $700-1,000 without Graphiti at 10M.
  This fits inside the scoreboard's $8,500 cap only if it replaces, not adds to, cut-able blocks (S5, S2a).
- **Outputs:** accuracy and CWA vs size with clustered CIs; tokens vs size; p95 latency vs size; $ per correct answer vs size. Decision rule
  preregistered: "gbrain's accuracy slope from 1M to 10M is non-inferior to the best external system's within 3 pts" etc.

### 5.5 Cost-table method

1. Measured, not modeled: per-cell metering proxy totals by model and phase (ingest sync, ingest background, read internal, reader, judge), as
   #89 and q1 already log. Settle against provider usage within 2% (#89 Phase 0 rule).
2. Normalize: $ per 1M ingested tokens, $ per 1,000 messages, $ per correct answer at a stated reads-per-write ratio (1x and 10x, MPW A6).
3. gbrain rows: (a) shipped defaults as installed (facts extraction on, tokenmax synopsis if the recipe picks it), (b) zero-LLM write path
   (facts off, CR title/none), (c) common embedder. P8's $0.32 vs $9.94 per 1,000 pages shows the spread; (a) is the honest headline row.
4. "10 years of one person": the token volume is **not found** in either repo. Define it from the personal-world generator's parameters
   (emails/day, meetings/week, doc revisions) and publish the assumption; report the table at 1M, 10M and 50M tokens so readers can pick their own.
5. Include wall time to ingest and write-to-findable beside $, since background extraction (78 min per 1,000 pages on PGLite) is a time cost.

### 5.6 Vendor-run submissions: verification

- Vendors submit a shim image digest + capability record + lock sha, never results on sealed sets. Public-set results may be vendor-run if the
  receipt carries: campaign hash over the executed git tree and image digests, metering-proxy usage log hash, per-question rows with context
  sha256 and answer text, judge outputs, and `run_config_hash`.
- `eval:scoreboard verify` (new) checks hashes, recounts every aggregate (q1 `check` already does), re-judges a stratified 10% from frozen
  contexts, and the custodian re-runs 10% of cells with the submitted image digest; deterministic retrieval must match ≥ 95% of ranked lists,
  accuracy must fall inside the submitted cell's CI. Sealed cells: custodian-only, aggregates only (q1 custody rules).
- Disputes: existing template (7-day answer). Vendor tuning window: one round, preregistered, before freeze (#89 fairness rule 9).

### 5.7 BEAM-1M failure analysis: what must be answered (B2)

1. **Loader:** BEAM's unit is a batch with turn groups; gbrain-evals treats each turn group as a session (`b2-g5` ids). Does that granularity
   inflate gold counts (34 questions need >10 groups)? Compare with BEAM's own session definition and re-score at batch granularity.
2. **Retrieval:** strict@5 on feasible questions (24.8%), any@5 69.2%; sweep k, reranker, expansion, page delivery; check whether summarization
   and instruction-following (15 and 11 "none") are retrievable at all by query similarity (they may need whole-history or profile memory).
3. **Reading:** oracle-evidence ceiling with each frontier reader; current reader scores 0.727 with all gold present.
4. **Dates:** settled by W13 (no effect); keep `think` date frame (P6 PASS on LoCoMo) as an arm.
5. **Judge:** report no-memory floor (~0.28) and strict all-items-met; check judge agreement with a frontier re-judge on 100 items.
6. **Abstention:** 15/22 zero; test S4 gating and the reader's abstention prompt.

## 6. OVERLAPS with in-flight threads and PRs

| Thread / PR | What it covers | Relation to bets 2-3 |
|---|---|---|
| **GBRA-1, evals #89 (not in parent's list)** | OSS shootout: shims for 6 systems, controls, ingest $, tokens, latency, lifecycle-lite, PMB; Phase 4 done; Phase 7 sealed (LoCoMo sealed, BEAM-100K sealed) next; cap $1,450 | Bet 2's adapters and first cost table already exist here. B1 is an amendment to this PR. Its LME-S result is the strongest current counter-evidence to "gbrain is best". |
| **GBRA-49 `evals/q1-scoreboard` + q1-* branches** | Head-to-head scoreboard: BEAM-10M S1 headline, BEAM 100K/1M sealed public rows, LoCoMo, LME-S, LME-M 100; file agent, full context, recency, hybrid; write-to-queryable; monthly cost; dispute; add-a-system; stress pilot; power MDD 16 pts; A2 fresh 1M reserve; cap $8,500 | **Bet 2 = this, plus worlds, CWA, privacy, vendor submissions and a powered headline.** All of B3-B8, B10 should land as amendments to its prereg before freeze. |
| GBRA-49 evals #88 (Q2 parser gaps) | typed list lines, relationship phrasings; uses 21 BEAM-1M sealed conversations for the junk audit | Locks BEAM-1M sealed per-question rows until Q2's decision; B2 must use dev only. |
| GBRA-52 gbrain #6066 + evals #69 (memory proof wave) | gbrain vs one extract-first comparator in the public harness; sealed BEAM 100k+500k+1M (54 sealed convs, margin 3.0 pts in #69 body; design doc says 500k+1M, 14/14/42, margin 2.0); BEAM 10M both systems (~$350); equal-context frontier 4k/8k/16k/32k; cost per correct answer; dated evidence headers, entity anchoring, pinned questions (migration v209) | Produces the matched BEAM-1M comparison and a token frontier. Bet 3's scale curve and cost table should consume its receipts, not re-run BEAM 10M separately. Its sealed use further consumes BEAM sealed splits. |
| GBRA-39 gbrain #6271, evals #76/#93/#77 (Cat 40 Hard) | 55,235-doc company; gbrain −11.3 vs files; fix wave (nicknames, result counts); sealed variant #77 unrun; confirmation ~$1,280 pending | Company-scale data point for the scale curve; nickname/alias gap also matters for personal worlds (people have nicknames). |
| GBRA-45 `capy/sync-feeder-fast-writes` | faster writes/sync | Directly affects time-to-findable and 10M ingest wall time (B9, B6). |
| GBRA-58 trust tiers (#5575) | trust tiers plan | Overlaps B5 privacy column design (principal/grant model). |
| GBRA-59 managed sync stall (#6278) | sync stall plan | Same scale-path bottlenecks (Cat 40 scale tier workarounds). |

## Appendix: commands used for recounts

```bash
# BEAM-1M decomposition (keyless)
python3 - < (see section 2.2; reads docs/benchmarks/2026-10-06-beam-1m-dates/qa/baseline/shard-*/rows.ndjson.gz)
# Shootout aggregates (keyless, scratch clone)
cd ~/.capy/work/gbra60/scratchB/evals && python3 ../agg.py lme-s hindsight-common-lme-s-a2-18ab0d18
python3 ../agg.py beam-100k basic-memory-common-beam-100k-a1-b180b106
```

Excluded attempts: Hindsight LME-S a2 (340/400 `retrieval_error`, shm bug, superseded by a3), Graphiti LME-S a1/a2 (lost at launch/sync),
Mem0 LoCoMo a1 (`ingest_degraded`, superseded by a2), Basic Memory BEAM a1 (one degraded conversation, superseded by a2). Mem0 LME-S includes 2
`ingest_degraded` rows counted as 0. Cognee and Basic Memory LME-S are pooled across shards by question count.
