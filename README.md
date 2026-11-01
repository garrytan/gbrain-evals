# gbrain-evals

[gbrain](https://github.com/garrytan/gbrain) is a memory system for AI agents. gbrain-evals is its public test
suite: the data, the comparison systems, the scoring code and every published result. Use it to see what gbrain
does well, check any claim against its saved records, or run the same tests on another system.

This page has three parts: [what gbrain does](#what-gbrain-does), [its current results](#current-results) and
[how it compares with other memory systems](#how-gbrain-compares). Everything above [Changelog](#changelog)
describes gbrain as this repository pins it today; the changelog at the bottom records how this page changed.

## The gbrain under test

| Item | Value |
|---|---|
| Pinned product | gbrain [`3ec766c40`](https://github.com/garrytan/gbrain/tree/3ec766c40664b652b14e39788d177139f5a7b105), release v0.60.531.0, declared as `gbrain` in `package.json` |
| Fixed-purpose aliases | `gbrain-cues` (`939232f`) and `gbrain-reader` (`e78f1c3`), used only by the experiments that name them |
| This repository | gbrain-evals v0.10.139 (`VERSION`) |

This repository installs gbrain v0.60.531.0 (`3ec766c40`). Some results below were measured at earlier commits; each
names its commit, and every commit named below is in the release's history except `a7cb37b`, the September 29 branch
commit whose retrieval the reader replay row froze. The search modes held the same values from v0.48.4.0 through
v0.60.169.0. Since then the default reranker became Voyage `rerank-3-lite` (was `rerank-2.5`, v0.60.223.0),
`tokenmax` stopped expanding queries (v0.60.250.0), and every mode turned on result-time collapse and rank priors
(`search.collapse`, `search.rank_priors`, v0.60.332.0): same-slug twins in other sources, merge stubs and copies of
one document fold into one result row, and organization, OCR and date priors adjust the ranking after the reranker. On
300 LongMemEval-S questions the reranker and expansion changes each kept retrieval within their preregistered margins
([reranker addendum](docs/benchmarks/2026-10-13-rerank3-addendum-preregistration.md),
[expansion latency](docs/benchmarks/2026-10-14-expansion-latency-preregistration.md)); collapse and rank priors have no
such check here. Retrieval results measured before v0.60.223.0 used `rerank-2.5`, and results measured before
v0.60.332.0 ran without collapse or rank priors.

Four read defaults outside the mode bundles changed after v0.60.454.0, the previous pin. A `query` with a token budget
leads with up to 40 dated saved facts (`search.query_facts_block`, v0.60.491.0). `search` puts a newer correction
ahead of the saved fact it corrects (`search.saved_facts_supersede`, v0.60.493.0). A remote `search` or `query` that
names no `limit` keeps every page that matched its words but at most 3 pages that matched only by meaning
(`search.remote_page_cap`, v0.60.506.0). Text from conversation, chat, email and meeting pages comes back inside a quote
fence, marked as source material, from `search`, `query`, `assemble_evidence` and `think`, and over MCP from `get_page`,
`fetch`, `recall`, `delta` facts and hot memory (v0.60.507.0, v0.60.521.0); `search_exact`, `get_chunks` and timeline
rows still return stored text. Apart from the keyless Cats 37 to 39 check in the memory trust row, no result on this page
was measured with them. The memory-qa harness holds the first three
at their old values and unwraps the fence on its `query` path
([`eval/runner/gbrain-under-test.ts`](eval/runner/gbrain-under-test.ts)); arms that measure gbrain's own defaults take
all four as shipped.

## What gbrain does

gbrain keeps your notes, conversations and documents as Markdown files you own, and builds a database index over
them (Postgres or embedded PGLite). An agent such as Claude Code or Codex uses it through a CLI or an MCP server to
save, find, update and forget what it knows. The parts that matter for an agent:

- **Hybrid retrieval.** Every search combines word matching (for exact names and phrases), meaning-based vector
  search (for vague recollections and synonyms) and an optional reranker that rereads the candidates against the
  question. [How the pieces work together](docs/retrieval-lessons.md).
- **Relationships as evidence.** gbrain stores typed links between pages ("works at", "invested in", "attended") and
  follows them for questions like "who invested in Acme?", where the answer page may never mention the question's
  words.
- **Whole conversations for the reader.** Search ranks short passages, then hands the agent the whole conversation
  behind each hit, within a token budget, so a question that needs two old chats gets both.
- **Memory that stays correct.** An updated value replaces the old one everywhere and keeps it as history; `forget`
  removes a claim from every recall surface; private pages stay out of what agent callers can read.
- **Memory that says where it came from.** Everything an agent reads back is labelled by its source: your notes,
  something you told your agent, something an agent wrote, or outside content such as an email. A write gate flags
  instruction-like text, and a purge removes a claim from every store, with a record of what was removed.
  [What the labels change](docs/benchmarks/2026-10-08-memory-trust-results-paid.md).
- **Built to be run by an agent.** Every error and notice tells the agent what to do next and whether it must ask
  the user first, so agents do not spend money or repair data without consent.
- **A write path you can measure.** Agent sessions become readable memory pages, and timeline events are extracted
  from meetings and chats.

## Current results

| What we measure | Result | gbrain | Report |
|---|---|---|---|
| Finding every conversation a question needs (LongMemEval, strict `recall_all@5`) | **451 of 470 (95.96%)** | `109b992` | [Recount](docs/benchmarks/2026-10-04-longmemeval-opaque-followups.md) |
| Answer accuracy on LongMemEval, release retrieval, benchmark notes reader (`claude-sonnet-5-5`, official `gpt-4o` judge) | **468 of 500 (93.6%)** | `c5fb0201` | [Current pin](docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin.md) |
| Best reader on the same retrieval (`claude-opus-5-5`, frozen 2026-09-29 retrieval) | **474 of 500 (94.8%)**, above Sonnet 4.6's 453 after Holm | `a7cb37b` retrieval | [Reader replay](docs/benchmarks/2026-10-07-longmemeval-w10b-reader-replay.md) |
| Whole-conversation delivery against bare chunks, sealed held-out set | **192 vs 132 of 200** (+60/−0) | `d44296c` | [Sealed decision](docs/benchmarks/2026-10-02-sealed-v2-decision-1.md) |
| Concept questions in different words, target ranked first (with reranker) | **130 of 181** | `d44296c` | [Matched comparison](docs/benchmarks/2026-10-02-concept-vector-rerank.md) |
| Relationship retrieval on reworded one-hop questions, recall at five | **0.411 → 0.537**, 19 better, 0 worse | `3a284ae` | [N9](docs/benchmarks/2026-10-01-n9-multi-hop.md) |
| Questions chaining two or three relations (multi-relation planner) | **24 better, 0 worse** held-out; +27 points strict all-hit@10 | v0.60.60.0 | [Held-out program](docs/benchmarks/2026-10-05-heldout-program.md) |
| Meeting attendance from a documented `## Attendees` list | **132 of 132** attendees stored, 0 false; "who attended" recall at five 32% → 80% | `c5fb0201` | [Attendance world](docs/benchmarks/2026-10-06-attendance-world.md) |
| Answers on 72 BEAM conversations, question-ranked facts plus pages at 8,000 tokens, against a memory-bank server at the same budget | **70.5 vs 66.5** points (+4.0, lower bound +2.6, ahead at the 3.5-point margin); 0.75× its cost per correct answer at 20 reads | `71b6d85` (gbrain #6445) | [Wave 2 results](docs/benchmarks/2026-10-13-memory-proof-wave-2-results.md) |
| A query that quotes a saved turn word for word (LongMemEval-S, 500 questions) | **500 of 500** return the conversation as a clean read (was 429; the rest lacked a rerank score or lost a search arm); strict recall@10 unchanged at 496 | `fecc7827` (#6391, merged as `f05943e65`) | [Verbatim probe](docs/benchmarks/2026-10-09-verbatim-probe-preregistration.md) |
| Vector search inside a 10% source or visibility scope, 1M to 2M chunks on Postgres | recall@50 **0.96 to 0.99** (was 0.52 to 0.77); a topic-coherent 10% source scope still reaches only 0.78 | `2e84d234e` (#6380) | [Scoped vector search](docs/benchmarks/2026-10-09-hnsw-scale.md) |
| Returning only the right facts (PrecisionMemBench, tight adaptive + reranker) | **0.586 precision**, 0.825 recall | `2efaaf8f` | [Refresh](docs/benchmarks/2026-09-09-retrieval-refresh.md) |
| Serving the new value after an update | **388 of 388** probes, never stale, on PGLite and Postgres through the CLI and MCP | `77cf8e111` | [N1](docs/benchmarks/2026-10-01-n1-knowledge-update.md), [re-pin](docs/benchmarks/2026-10-11-wave14-repin.md) |
| Nothing left behind after `forget` | **0** prohibited outputs, 6 of 6 reinstatements | `77cf8e111` | [N5](docs/benchmarks/2026-10-01-n5-forget-residue.md), [re-pin](docs/benchmarks/2026-10-11-wave14-repin.md) |
| Private pages reaching agent callers or remote callers | **0**, in process and on Postgres over real HTTP (155 of 155 cells, 5 kinds of caller); proactive recall gated in CI | `77cf8e111` | [N6 on Postgres](docs/benchmarks/2026-10-06-n6-postgres-http.md), [N8 gate](docs/benchmarks/2026-10-06-n8-privacy-gate.md), [re-pin](docs/benchmarks/2026-10-11-wave14-repin.md) |
| An attacker's false claim from an email or a relayed tool result, adopted in a later session (Opus 5.5, Sonnet 5.5, GPT-6.1 Sol) | **1.5% to 5%** of sessions with trust labels shown, 5.1% to 10.6% with them stripped; **0 of 360** instruction-worded injections followed per model; Cats 37 to 39 pass every keyless contract at the pin | `c2f10ee8` to `5b9c814b` (shipped as `d4dc2d4d8`); keyless at `3ec766c40` | [Memory trust](docs/benchmarks/2026-10-08-memory-trust-results-paid.md), [re-pin](docs/benchmarks/2026-10-11-wave14-repin.md) |
| Keeping speaker and time across chat export formats | **29 of 29** formats | `77cf8e111` | [N12](docs/benchmarks/2026-10-01-n12-format-fidelity.md), [re-pin](docs/benchmarks/2026-10-11-wave14-repin.md) |
| Finding contradicting notes | **146 of 150** conflicts with the default judge model (`claude-haiku-4-5`), 0 of 40 dated changes and 4 of 51 compatible pairs flagged; 149 at `48ed5e8` with the same prompt, the difference is sampling | `77cf8e111` | [N2](docs/benchmarks/2026-10-01-n2-contradiction-surfacing.md), [re-pin](docs/benchmarks/2026-10-11-wave14-repin.md#the-paid-n2-judge-arm) |
| Contradiction judge on current models | **150 of 150** conflicts and **0 of 251** compatible pairs flagged, for each of four current models (Opus 5.5 the top Anthropic one); cheapest passing model $0.21 per 1,000 pairs | `c5fb0201` | [N2 judges](docs/benchmarks/2026-10-06-n2-judges.md) |
| Attributing someone else's claim to the page holder (takes classifier) | **0 of 123** cases on Sonnet 5.5, GPT-6.1 Sol and Opus 5.5 (3 with Claude Haiku 4.5); the classifier is not yet graduated | `c5fb0201` | [Takes-bootstrap](docs/benchmarks/2026-10-06-takes-bootstrap-frontier.md) |
| Real agents (Claude Code, Codex) spending or destroying data without consent | **0** violations in 66 safety sessions; 96 of 102 tasks finished | v0.60.46.0 | [Cat 41](docs/benchmarks/2026-10-03-agent-operator.md) |
| Hard company questions answered by agents, against plain files with `grep` (Cat 40 Hard confirmation: two 50,000-document worlds, Opus 5.5, Sonnet 5.5, GPT-6.1 Sol, reranking verified in every gbrain slot) | gbrain ahead by **+7.7 points** (95% CI +2.7 to +12.7) on a fresh world and **+13.0** (+7.7 to +18.3) on a sealed one, for every model; behind on the fresh world's conflicting-source family (47 against 56 of 60) | `3e4ff61ce` (shipped as v0.60.174.0, `0df9f2ee7`) | [Cat 40 Hard confirmation](docs/benchmarks/2026-10-10-model-ladder-hard-confirmation.md) |
| Hard company questions after the Cat 40 next wave (four new 50,000-document worlds, two generators; Opus 5.5, Sonnet 5.5, GPT-6.1 Sol) | What ships, Part 1 without F5: gbrain ahead of plain files by **+10.67 points** (95% CI +7.00 to +14.50) on two sealed worlds. The pre-wave baseline is also ahead: **+8.50** (+4.83 to +12.33) on two public worlds and **+11.83** (+8.00 to +15.83) on the sealed ones. Against that baseline, the shipped configuration is level on sealed (−1.17, −4.33 to +2.00) and was level with control in development. The public build with F5 measured +12.50 (+9.17 to +15.83) against files and +4.00 against the baseline. That build is **not shipped (F5 failed its precision ship condition)**, and its gain came from F5 | `4e10136b4` (F5 off on sealed), baseline `09d21554d` | [Cat 40 next-wave confirmation](docs/benchmarks/2026-10-15-cat40-next-confirm/README.md) |
| Finance-only text reaching an agent's context in permission runs (Cat 40, five frontier models) | **0 of 100** (plain files 100, plain Postgres 97 with 4 leaked answers); the world's 95.6% success figure is retired ([why](docs/benchmarks/2026-10-02-model-ladder.md#retired-2026-10-12)) | `51f865d78` | [Cat 40](docs/benchmarks/2026-10-02-model-ladder.md) |
| Timeline events extracted from meetings and chats | **37 and 38 of 38**, 0.04 wrong per page | `b9ee931` | [`auto_chronicle`](docs/benchmarks/2026-10-04-auto-chronicle-rerun.md) |
| Managed Postgres catch-up 57 ms from the database (10,000-file backlog) | **367.9 pages/min** steady, **33.6 min** for the backlog (was 174.8 pages/min and 74.5 min on the same rig); a page save 2.5 s instead of 8.6 s | v0.60.111.0 (#6279) | [Lanes and foreground](docs/benchmarks/2026-10-07-managed-sync-lanes-foreground.md) |
| A managed Postgres catch-up when one write cannot finish preparing (15,000 entries, heavy fact adoption, 57 ms, transaction-mode pooler) | Drains in **2 passes (91 min, pool 10)** and 3 passes (pool 3), with **0** failed fence receipts and **0** watchdog stops; v0.60.105.0 never drained (102 pages in 47.6 min). A stuck write is held in **240 s**; a table lock still pins 9 of 10 connections | v0.60.112.0 (#6298; 15,000-entry runs at `846bea442`) | [Preparation stall](docs/benchmarks/2026-10-08-managed-sync-preparation-stall.md) |
| A managed Postgres sync behind a transaction-mode pooler whose round trip never completes | Wedges with **one process and no lanes** (backend `ClientRead`, consumer parked 135 s, zero commits) on v0.60.110.0 and on #6298's head; **0 wedges in 2 h 49 min** of the two-consumer shape (4,951 pages); fixed by the bounded settle in v0.60.114.0 | v0.60.110.0 → v0.60.117.0 | [ClientRead wedge](docs/benchmarks/2026-10-08-managed-sync-clientread-wedge.md) |
| A single-file commit becoming searchable through a running `gbrain serve` with `sync.on_commit` on (10,000 synthetic pages, local database, 4 vCPUs) | **0.60 s** p50 (p95 0.61 s, n = 40) on Postgres in watch mode, was 3.7 s managed and never on classic sources; poll mode 2.15 s p50, p95 3.20 s; vector for hybrid search 0.3 s later on managed, about 6 s later on classic; after a 30 s embedding outage PGLite left about 3% of a 1,000-chunk backlog unembedded | v0.60.316.0 (#7079) | [Sync freshness](docs/benchmarks/2026-10-19-sync-freshness.md) |
| The first managed sync after activating a classic brain already synced to HEAD (synthetic pages, local database, 4 vCPUs) | Converges in **1 pass** on every run: Postgres 10,000 pages 13.2 s p50 (n = 3, 2,487 statements), PGLite 10,000 pages 12.9 s (n = 3), Postgres 100,000 pages **129.6 s** (n = 1, 23,243 statements). v0.60.316.0 took 1.6 s, 1.8 s and 7.1 s but compared no files, because its commit replay range was empty | v0.60.320.0 (#7053, PR head `426c4ef5`) | [Sync freshness](docs/benchmarks/2026-10-19-sync-freshness.md#first-managed-sync-after-activating-a-classic-brain-gbrain-v0603200-6712-pr-4b) |
| Malformed facts/takes tables repaired by a model without a wrong cell (held-out set, model tier only) | **96.0%** repaired, **0** wrong cells (gpt-6.1-sol and claude-opus-5-5, the measured defaults); every other case held | v0.60.102.0 ([`5b58910`](https://github.com/garrytan/gbrain/commit/5b5891069)) | [Fence repair Tier 3](docs/benchmarks/2026-10-06-fence-repair-tier3.md) |
| A file whose frontmatter `slug:` names another page: duplicate to merge, stray line to delete, or a case for a person (model judgment) | **0** harmful answers in 432 pair runs (no duplicate split, no merge of two different things); true duplicates recognised **92.0%** (Opus 5.5), 85.3% (gpt-6.1-sol), 80.0% (Sonnet 5.5), the rest deferred to a person | gbrain #6377 (`ac6e0868`) | [Slug-conflict judgment](docs/benchmarks/2026-10-09-content-repair-judgment.md) |
| A forecasting take graded by a model, among verdicts confident enough to apply (≥ 0.95) | **0** wrong in 496 applied verdicts by gpt-6.1-sol (upper bound 0.6%, bar 1%), which resolved 99.2% of resolvable takes and held back on all 250 unresolvable ones; Opus 5.5 and Sonnet 5.5 rarely reach 0.95 (2 and 121 applied, Sonnet 1 wrong) | gbrain #6882 (`d99b84694`) | [Take grading](docs/benchmarks/2026-10-16-take-grading.md) |
| A forecast journal over synthetic holders of known skill (private, trusted local only) | Shrunk accuracy ranks holders in their true order, median Spearman ρ **0.905** (bar 0.80); who-was-right set-F1 **1.000**; every open, overdue and undated prediction counted exactly; **8/8** remote probes see none of it | gbrain #6886 (`65ed40ec6`), v0.60.286.0 | [Forecast journal](docs/benchmarks/2026-10-17-forecast-journal.md) |
| Graph walks (`traverseGraph`, `traversePathsDetailed`) on fictional graphs of 10,000 to 1,000,000 pages: Postgres with breadth-first walks against HydraDB as the walk engine | Postgres faster at every size, same answer on all 54,842 compared calls: warm p95 **1.44 s vs 6.28 s** at 100,000 pages and **3.45 s vs 6.28 s** at 1,000,000; HydraDB faster only on deep `both` walks (2.7x at depth 3); production HydraDB routing not built | gbrain #6934 (`fc1121cae58`) | [Graph backend](docs/benchmarks/2026-10-17-graph-backend.md) |
| Useful material kept when a session becomes a memory page | **88.1%** judged (judge calibration awaiting a person's review); 74.9% with quoted evidence | Cat 35 run | [Cat 35](docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill.md) |

All 29 reproductions in the [bug ledger](docs/benchmarks/2026-10-01-wave-bugs.md) pass at `77cf8e111`, including
N1-7's (fixed by gbrain #6265) and Cat7-1's, whose entry stays open under its stricter closure rule (see known limits).
The memory trust findings with keyless repros (37-1, 37-2 and 37-5 in the
[memory trust ledger](docs/benchmarks/2026-10-07-memory-trust-bugs.md)) pass too
([re-pin report](docs/benchmarks/2026-10-11-wave14-repin.md)). Rows marked `c5fb0201` were measured in the October
round at an earlier pin (the paid runs and the attendance world). The correctness rows come from keyless checks on
synthetic worlds with generated answer keys, rerun at every pin.

Settings that change these numbers are in [settings by workload](docs/settings.md). Two matter most: keep autocut off
for questions that need several conversations (451 against 384 of 470), and leave query expansion off, since it adds
a model call without a measured gain.

## How gbrain compares

Other systems publish different metrics on different protocols, so these comparisons use only numbers we can put on
the same footing, and say so where we cannot. This page describes the other systems by kind; their names, versions,
sources and every row we could not match are in [comparisons and their protocols](docs/comparison-systems.md).

**Head-to-head on sealed data: measured, descriptive.** The [Q1 scoreboard](docs/benchmarks/2026-10-06-scoreboard-preregistration.md)
gives gbrain `f05943e6` (0.60.138.0) and every other system the same BEAM-10M questions, never used to tune gbrain,
the same three answer models and the same 8,000-token budget, and names each system by kind. The sealed waves ran from
2026-10-09 to 2026-10-27, and the block below is rendered from the campaign receipt by `bun eval/runner/scoreboard.ts render`.
[The report](docs/benchmarks/2026-10-06-scoreboard-report.md) says how the published tables are checked;
[the scoreboard guide](docs/scoreboard.md) covers how to reproduce a number, add a system or dispute a row.

<!-- scoreboard:headline:begin -->
On BEAM-10M (never used to tune gbrain), measured 2026-10-27 at gbrain `f05943e`, the component comparison is descriptive: with these conversations it detects only differences of about 13.58 points, so no row is ranked. The table is incomplete: `ext-graph-pipeline`, `ext-markdown-kb` did not run on BEAM-10M, so no field-wide claim is made.

| Kind and configuration | BEAM-10M accuracy at 8k, three-reader mean | Dollars per month, personal agent | p50 answer latency | Write to queryable, p50 | Receipt |
|---|---|---|---|---|---|
| `gbrain-defaults`: gbrain with its shipped defaults, installed and read the documented way; GBrain 0.60.138.0 (f05943e6, 2026-10-09), shipped defaults, tokenmax search | incomplete: 56.3% (197/199; 95% interval 50.1% to 62.5%) | not measured | 11.1 s | not measured | [cell](docs/benchmarks/2026-10-06-scoreboard/scoreboard.md#cells) |
| `ext-extract-first`: an extract-first memory server (an LLM extracts and updates facts on every write); component, 8,000 tokens | 58.9% (199/199; 95% interval 54.0% to 63.8%) | not measured | 9.0 s | not measured | [cell](docs/benchmarks/2026-10-06-scoreboard/scoreboard.md#cells) |
| `ext-memory-bank`: a memory-bank server with background extraction and reflection; component, 8,000 tokens | 55.4% (199/199; 95% interval 50.8% to 59.7%) | not measured | 13.7 s | not measured | [cell](docs/benchmarks/2026-10-06-scoreboard/scoreboard.md#cells) |
| `ext-graph-pipeline`: a knowledge-graph pipeline (an LLM builds a graph per document); component, 8,000 tokens | not run: the product's own behavior (A23): its graph store's hard-coded 32 GiB size limit, once reached, fails every later write and retrieval, and its incremental re-extraction makes each session cost more; three shards ingested for 62 hours without finishing | not measured | not measured | not measured | none |
| `ext-temporal-graph`: a temporal knowledge-graph library (bi-temporal edges, LLM extraction per episode); component, 8,000 tokens | 45.1% (159/159; 95% interval 40.1% to 49.9%), on the 8 conversations A17 measured validly (c0-c7) | not measured | 17.5 s | not measured | [cell](docs/benchmarks/2026-10-06-scoreboard/scoreboard.md#cells) |
| `ext-markdown-kb`: a Markdown-file knowledge base (local embedder, no LLM on write); component, 8,000 tokens | not run: projected ~61 h > 48 h limit per conversation (A23: the product's own reindex cost grows with the square of the chunk count) | not measured | not measured | not measured | none |
| `ext-verbatim-session`: a verbatim-session memory system (whole sessions, vector search, LLM rerank off); component, 8,000 tokens | 50.8% (199/199; 95% interval 44.2% to 57.9%) | not measured | 7.4 s | not measured | [cell](docs/benchmarks/2026-10-06-scoreboard/scoreboard.md#cells) |
| `ext-agent-runtime`: a self-editing agent memory runtime (the agent edits its own memory blocks and files) | not run on BEAM-10M | not measured | not measured | not measured | none |
| `baseline-full-context`: the whole history in the prompt, where it fits the reader's window; whole history, where it fits | no scored questions | not measured | not measured | not measured | [cell](docs/benchmarks/2026-10-06-scoreboard/scoreboard.md#cells) |
| `baseline-file-agent`: an agent with list, grep and read tools over the same Markdown files; file agent, uncapped grep, 40 turns | incomplete: 68.0% (193/199; 95% interval 64.3% to 72.0%), whole system | not measured | 19.8 s | not measured | [cell](docs/benchmarks/2026-10-06-scoreboard/scoreboard.md#cells) |
| `baseline-hybrid`: plain Postgres full-text plus pgvector search with reciprocal-rank fusion; component, 8,000 tokens | 51.6% (199/199; 95% interval 44.3% to 58.7%) | not measured | 7.7 s | not measured | [cell](docs/benchmarks/2026-10-06-scoreboard/scoreboard.md#cells) |
| `baseline-none`: the question alone, no memory; component, 8,000 tokens | 25.8% (199/199; 95% interval 23.2% to 28.3%) | not measured | 3.2 s | not measured | [cell](docs/benchmarks/2026-10-06-scoreboard/scoreboard.md#cells) |

Descriptive, not tested: correct-abstention rate (abstention-question answers the benchmark's own judgment passes) on BEAM-10M: `gbrain-defaults` 86.0%; `ext-extract-first` 86.0%; `ext-memory-bank` 84.2%; `ext-temporal-graph` 88.9%; `ext-verbatim-session` 91.2%; `baseline-full-context` n/a; `baseline-file-agent` 91.2%; `baseline-hybrid` 93.0%; `baseline-none` 100.0%.

| System | BEAM-100K sealed | BEAM-1M sealed | BEAM-10M |
|---|---|---|---|
| `gbrain-defaults`: gbrain with its shipped defaults, installed and read the documented way; GBrain 0.60.138.0 (f05943e6, 2026-10-09) | 67.8% (140/140) | 63.1% (240/240) | 56.3% (197/199) |
| `baseline-full-context`: the whole history in the prompt, where it fits the reader's window | 72.2% (140/140) | no scored questions | no scored questions |
| `baseline-file-agent`: an agent with list, grep and read tools over the same Markdown files | 72.8% (140/140) | 71.1% (239/240) | 68.0% (193/199) |
| best external row, `ext-extract-first`: an extract-first memory server (an LLM extracts and updates facts on every write) | 69.5% (140/140) | 63.4% (240/240) | 58.9% (199/199) |

- BEAM-10M: never used to tune gbrain.
- BEAM-10M, 2k/16k sweep subset: never used to tune gbrain.
- BEAM-1M sealed: used to choose gbrain settings.
- BEAM-100K sealed: used to choose gbrain settings.
- LoCoMo: used to choose gbrain settings.
- LongMemEval-S: gbrain was developed on it.
- LongMemEval-S, shootout slice: gbrain was developed on it.
- LongMemEval-M: gbrain was developed on it.
- Where gbrain loses: On BEAM-10M we could not tell `baseline-file-agent` and gbrain-defaults apart (68.3% vs 59.0%); a difference smaller than about 12.9 points would not have been detected.
- Where gbrain loses: On BEAM-10M, 2k/16k sweep subset (10 conversations), `ext-extract-first` scored 59.3% and gbrain-defaults 52.4% (difference -6.9 points, 95% interval -12.3 to -1.4 points). 10 conversations describe these systems on this set; they cannot rank them.
- Where gbrain loses: On LoCoMo (10 conversations), `baseline-full-context` scored 84.2% and gbrain-defaults 80.0% (difference -4.2 points, 95% interval -7.0 to -1.0 points). 10 conversations describe these systems on this set; they cannot rank them.
- GBrain rows measure GBrain 0.60.138.0 (f05943e6, 2026-10-09). That is not current master; a rerun of the GBrain rows at current master is planned after amendment A23.
- Sealed spend settled at $7,034.32 on the campaign ledgers against the $8,000 sealed cap; $6,729.26 of it is measured: $6,626.00 across the four freezes' cells (A17, A22, A23 and A24) plus $103.26 for the A19 frontier-judge backfill. Of 149 launch units, 114 settled complete, 8 partial and 27 not run; each not-run row says why.
- S2b full-context (`s2b.baseline-full-context.baseline`): A23 priced each gpt-6.1-sol whole-history reading's reservation from its token estimate, but the metering proxy reserves the request's byte count as input tokens, about 3.6 times as much, so the $20 lease admitted one reading at a time. The custodian raised the lease to $110 inside the A24 cap (raise-lease.ts) and resumed. The unit settled complete, 720 of 720 answers, at $191.34 measured across its seven leases.
- ext-temporal-graph: its pinned configuration calls a reranker and an ingest model that their provider retired, and a competitor's settings are never changed, so (ruling 2026-10-26 via GBRA-108, option 1) its BEAM-10M row is shown on the 8 conversations A17 measured validly (c0-c7), every system is also shown on those 8 as a sensitivity view, its cells after the retirement are not run, and it is retested at its current release in the follow-up current-master rerun (F6). c8 and c9 hold A22 rows with 120 `ingest_degraded` and are not merged.
- gbrain-defaults shipped-defaults S1, 8k component arm: 10 answers (5 on each of c4 and c5), 0.4% of the row's answers, are recorded `harness_invalid`. A24's re-answer carried them forward under their earlier realization instead of answering them again. The custodian traced the 10 A22 retrievals behind them: 9 failed as the shim's `degraded read (harness failure; retry after quiesce)` (8 `expansion_not_applied`, 1 `expansion_partial` with `rescore_skipped`; c4 fixed-evidence 3, c5 fixed-evidence 3, c5 vendor-default 3), and the tenth, c4 vendor-default, scored; the stored strings carry no HTTP status. A harness failure leaves its question out of that row's mean, and the sensitivity view `a24-shipped-defaults-harness-invalid` leaves those questions out for every system. The carry-forward fix goes into the follow-up rerun (F6).
- gbrain-defaults full-surface S2b `whole-think`: 10 gpt-6.1-sol answers on c0 and c1 stopped at exactly 4,000 output tokens; every scored Sol answer in those cells used fewer. At the pin, gbrain think gives 16,000 output tokens only to Claude 5, Claude 4.x, gpt-5 and o-series models and to recipes that declare thinking by default; any other model, gpt-6.1-sol included, gets 4,000. gbrain's own path labels that stop `output_truncated`, and the shim records any status other than an answer as `harness_invalid`. The attribution rests on gbrain's code at the pin, the custodian's count (all 10 stopped at exactly 4,000 output tokens) and a keyless $0 repro of the limit; the pulled lease logs do not keep the shim's status field, so the `output_truncated` label itself was not observed. The limit and the flag are gbrain's shipped behavior with this model, so the 10 count as product failures, scored 0 and kept in the denominator. gbrain #7421 (2026-10-24, after the pin) gives OpenAI reasoning models from gpt-5 to gpt-9 the 16,000-token limit.
- S3 file-agent (`s3.baseline-file-agent.baseline`): 23 gpt-6.1-sol answers are `reader_error`, a harness failure, so their questions leave that row's mean under the outcome rules.
- S3 agent runtime (`s3.ext-agent-runtime.recipe`): all 200 of its gpt-6.1-sol answers are `retrieval_error`. The runtime calls gpt-6.1-sol through chat completions with function tools and a reasoning effort, and the provider refuses that request. The preregistration (A19, item E) records this as the runtime's own request, which the harness does not change, and leaves it to the program owner; no alternative ran, so the row reports the Sol answers as the runtime's failure. Its Opus and Sonnet answers are unaffected, and the per-reader table shows each reader. 2 further answers are `reader_error`.
- Frontier-judge column: the A19 backfill filled 1,960 of 2,140 gpt-6.1-sol frontier judgments; the frozen tool does not judge the other 180, which are temporal-graph `ingest_degraded` answers. 194 of 214 Opus redos landed (2 remain `judge_error`, 18 fall outside a published arm), and a redo replaces the logged error under the same key. Agreement is reported on the covered set, with each judge's coverage.
- Measured 2026-10-09 to 2026-10-27 with gbrain 0.60.138.0 (`f05943e`); pinned systems: `ext-extract-first` bundle lock 9777b7a8, capabilities 0acaff3a; `ext-memory-bank` bundle lock f54d89df, capabilities 23a033f4; `ext-graph-pipeline` bundle lock 59af44d5, capabilities e00e4600; `ext-temporal-graph` bundle lock 4ce9b216, capabilities 0ae56345; `ext-markdown-kb` bundle lock e1a14a19, capabilities 4e95f8ef; `ext-agent-runtime` bundle capabilities d55c28c9; `ext-verbatim-session` bundle lock e2e066bf, capabilities ffd48dae.
- Full tables, cohorts and exclusions: [scoreboard report](docs/benchmarks/2026-10-06-scoreboard/scoreboard.md).
<!-- scoreboard:headline:end -->

**Finding all the evidence: gbrain leads every system we can score strictly.** A question counts only if every
required session is in the top five.

| System | Strict `recall_all@5` on LongMemEval | Source |
|---|---|---|
| **gbrain**, `balanced` with Voyage reranker | **95.96% (451/470)** | our run, opaque session ids |
| gbrain, same without the reranker | 92.34% (434/470) | our run, opaque session ids |
| A verbatim-session memory system, hybrid search + LLM rerank | 90.0% (423/470) | our strict recount of its saved rankings |
| A token-native retrieval system + embedding fusion | 87.45% (411/470) | self-reported, its own harness |
| The same verbatim-session system, raw vector search | 85.7% (403/470) | our strict recount of its saved rankings |

Many headline LongMemEval "R@5" scores of 95% to 100% count a question as found when any one required session
appears; on that looser metric gbrain finds at least one for 470 of 470. Limits: gbrain returns five chunks while
the verbatim-session system returns five whole sessions, the configuration was chosen on these 470 questions, and embedders and
chunking differ, so this compares pipelines, not components.

**Retrieval or the whole history: within 7 points at a seventh of the recurring cost.** On 150 LongMemEval-S questions with the same reader, gbrain's retrieval answered 139 against 144 with the whole ~115,000-token history pasted in (Sonnet 5.5), and 137 against 141 (GPT-6.1 Sol). Both stay within the preregistered 7-point margin, which is not the same as equal: the gap is in questions that need several conversations. gbrain's recurring cost per question is $0.024 against $0.173 with Sonnet 5.5, plus a one-time $0.015 to index each history. [Full-context comparison](docs/benchmarks/2026-10-07-longmemeval-w10c-full-context.md).

**Answer accuracy: close to the published systems that use the same reader.** With `gpt-5.4` as the reader,
gbrain's retrieval answers 89.4%; a temporal knowledge-graph service publishes 90.2% and a database-backed memory
system 84.97% with the same reader model. Judges,
prompts and retrieval budgets differ, so this is context, not a ranking. Published results across systems range from
81.6% to 96.1%.

**A memory-bank server on sealed BEAM: gbrain ahead by 2.6 points, cheaper only at low read volume.** In a matched,
preregistered test with the same reader, judge and context budget on sealed BEAM conversations (1,080 questions at
100k, 500k and 1M tokens), gbrain's pages plus extracted facts answered 67.0% against 64.4% for a memory-bank server
with background extraction and reflection (+2.64 points, one-sided 95% bounds +0.90 and +4.41). Its cost per correct
answer was 0.63 of the server's at 20 reads per stored conversation and level at 200. The server keeps an edge on
event ordering and temporal reasoning, and on LongMemEval-S (84.5% against 80.3% for gbrain's pages alone). gbrain
ran its freeze build `d7467d1cf`, whose retrieval was
[checked equivalent](docs/benchmarks/2026-10-09-memory-proof-wave-sealed-results.md#equivalence-of-the-shipped-build) at
`d7d7686de`; both are in the pin's history. [Sealed results](docs/benchmarks/2026-10-09-memory-proof-wave-sealed-results.md).

**Returning only what matters: gbrain's tight mode is more precise than every memory product in the
PrecisionMemBench table except the benchmark author's own belief store.** Its mean precision is 0.586, against 0.22,
0.09 and 0.06 for three hosted memory products listed upstream; the author's belief store scores 1.00. Upstream rows may use different
denominators and machines.

**Memory over long conversations: ahead of a memory-bank server on BEAM, behind its earlier answers on LongMemEval-S.**
On 72 BEAM conversations (1,440 questions), gbrain's question-ranked facts-plus-pages lane scores 70.5 against 66.5 for
a memory-bank server with background extraction, both at 8,000 tokens of context and judged jointly and blind. The gap is
+4.0 points, with a lower bound of +2.6. gbrain costs 0.75 times as much per correct answer at 20 reads per stored
conversation. On LongMemEval-S, gbrain trails that server's earlier answers by 3.25 points, but those answers were
scored on more context than the budget (p95 9,373 tokens), so the row decides nothing.
[Wave 2 results](docs/benchmarks/2026-10-13-memory-proof-wave-2-results.md).

**Concept search: level with a vector store, when both are reranked.** gbrain 130 of 181, vectors with the same
reranker 128.

**Agent tasks: ahead of plain files on hard company questions, and safer with restricted data.** In Cat 40 Hard's
preregistered confirmation (two 50,000-document worlds, a 16-turn cap, Opus 5.5, Sonnet 5.5 and GPT-6.1 Sol, with
reranking verified in every gbrain slot), agents using gbrain answered more questions correctly than the same agents
with plain Markdown files and `grep`: +7.7 points (95% CI +2.7 to +12.7) on a fresh world and +13.0 (+7.7 to +18.3)
on a sealed one, for every model. gbrain trails files on the fresh world's conflicting-source family and gives more
confidently wrong answers. On the earlier, easier Cat 40 world, gbrain puts finance-only text into the agent's context
in 0 of 100 permission runs; files do in 100, and plain Postgres in 97 (with 4 leaked answers). That world's success
figures are retired: gbrain ran without its reranker in those cells and the world sits at its ceiling, so the frontier
tie (95.6% each) and the older six-model lead no longer describe gbrain
([why](docs/benchmarks/2026-10-02-model-ladder.md#retired-2026-10-12)).

## Known limits

- A timeline read on a 1,000-page brain took about 0.075 ms at `77cf8e111` against 0.045 ms before the Foundations 1
  release (ledger entry Cat7-1, open; 0.075 and 0.078 ms on the two hosts measured). It has not been measured at the
  pin.
- Open loops cover Gmail only, and a commitment fulfilled by reply does not close.
- There is no corpus-wide contradiction scanner; the judge compares notes that search returns together.
- Associative recall, which gbrain does not claim, scores 0 of 240.
- Several retrieval settings were chosen on the same LongMemEval questions they are scored on; held-out
  confirmation exists for evidence delivery, not yet for the retrieval configuration.

## Where to read next

| Question | Where to start |
|---|---|
| When do words, vectors or relationships find the right answer? | [Retrieval lessons](docs/retrieval-lessons.md) |
| Which configuration should I try? | [Settings by workload](docs/settings.md) |
| Every report, grouped by the question it answers | [Documentation index](docs/README.md) |
| How do retrieval scores differ from answer accuracy? | [What the scores mean](docs/retrieval-lessons.md#what-the-scores-mean) |
| How are new gbrain defaults decided? | [Held-out program](docs/benchmarks/2026-10-05-heldout-program.md), [decision kit](docs/decisions.md) |
| Can I reproduce a result or test my own system? | [Run the suite](eval/README.md), [contribute an adapter or a category](eval/CONTRIBUTING.md), [reproduce a scoreboard number, add a memory system or dispute a row](docs/scoreboard.md) |
| What is still unfinished? | [Open work](TODOS.md) |

## Try a small experiment

Install [Bun](https://bun.sh/) and clone this repository:

```sh
git clone https://github.com/garrytan/gbrain-evals.git
cd gbrain-evals
bun install --frozen-lockfile

# No provider calls: rank the committed documents by matching words.
BRAINBENCH_N=1 bun eval/runner/multi-adapter.ts --adapter grep-only

# Check the committed corpus and question files.
bun eval/runner/validate-data.ts
bun run eval:query:validate
```

To compare all four retrieval adapters, set `OPENAI_API_KEY` in your environment:

```sh
BRAINBENCH_N=1 bun eval/runner/multi-adapter.ts --queries all
```

The run writes a scorecard and individual rankings to `eval/reports/multi-adapter/receipt.json`, using the fictional
corpus already in the repository. Vector and hybrid adapters make paid embedding calls; this runner does not ship a
warm embedding cache.

To run gbrain on the public agent-memory benchmark harness (LongMemEval-S, LoCoMo10, PersonaMem, LifeBench, BEAM and
PrecisionMemBench) under an audited protocol, follow the [harness quickstart](docs/benchmarks/harness-quickstart.md). Its
first step is a keyless plumbing check through the real gbrain adapter.

The agent benchmarks run like this:

**Cat 40 Hard** asks the same agents harder questions about a larger, messier
company: sets and counts over 10 to 40 accounts, values that changed several
times with backdated corrections, customers with look-alike names, documents
that disagree by authority, and facts that must survive five conversations.
It is tuned on plain files until frontier models finish about half, then
measured on a held-out world at about 4,000 and about 50,000 documents.
[Operator guide](docs/benchmarks/cat40-hard/RUNBOOK.md),
[world and scoring contract](docs/benchmarks/cat40-hard/WORLD_SCHEMA.md).

```sh
# Cat 41: a candidate gbrain commit, its gate, and the Cat 40 instruction check
# (Docker, ANTHROPIC_API_KEY, OPENAI_API_KEY; about $80 for both)
eval/runner/cat41/after-pass.sh <gbrain checkout> <commit>

# Cat 40 v1 without spending: the scripted, hermetic arms
bun eval/runner/cat40-model-ladder.ts --scripted --arms fs,memory,oracle --out $(mktemp -d)

# Cat 40 Hard without spending: every family through the scripted arms, plus the freeze-rule table
scripts/cat40-hard.sh hello
```

For the full pinned configuration matrix, prerequisites, output paths and spending controls, follow the
[refresh report](docs/benchmarks/2026-09-09-retrieval-refresh.md). To evaluate your own application, choose
representative questions and their relevant documents before comparing systems; the
[contributor guide](eval/CONTRIBUTING.md) explains the question and adapter formats.

## Corrections

These published numbers are invalid or overstated. Each affected report keeps its original figures, labeled,
beside a dated correction (audit of September 28, 2026, plus later follow-ups):

- **LongMemEval answer accuracy 433/500 (86.6%) is invalid:** the answer model saw `answer_` session ids that mark
  the evidence. With the leak removed, the same configuration scores 432/500 (+15/−16 paired), so the leak made no
  measurable difference, but 433 stays invalid. Retrieval numbers recounted with opaque ids are confirmed.
  [Report](docs/benchmarks/2026-09-29-longmemeval-opaque-qa.md),
  [recount](docs/benchmarks/2026-10-04-longmemeval-opaque-followups.md).
- **The reading-notes gain 308/361 to 324/361** was measured with the same leak; with opaque ids it is 304/361 to
  320/361 (+25/−9). [Report](docs/benchmarks/2026-09-25-reading-notes.md).
- **Query expansion "hurts retrieval"** described the September 6 code (255/470); at current gbrain it scores
  436/470 against 434/470 without it, so that finding no longer describes gbrain.
- **The May calibration result (75% wins) is invalid:** the judge saw the expected behavior and knew which answer
  was which. [Report](docs/benchmarks/2026-05-18-brainbench-cat14-cat15-calibration.md).
- **The April relationship precision at five (39.2% to 44.7%)** used a lenient denominator; divided by five slots it
  is 29.9% to 35.4%. Its alias recall falls from 31.0% to 13.75%, and with attendance edges pointed the right way
  link type accuracy is 74.7% (109/146).
  [Report](docs/benchmarks/2026-04-18-brainbench-v1.md),
  [September 29 re-run](docs/benchmarks/2026-09-29-repin-cats-1-2-6.md).
- **The April and May relationship tables' `gbrain` row (49.1% precision)** came from a regular-expression parser of
  the four question templates, now named `graph-oracle-parse`; it is not a product score.
  [Report](docs/benchmarks/2026-04-19-brainbench-multi-adapter.md).
- **Cat 35's 88.1%** is judge-only; evidence-verified retention is 74.9%.
  [Report](docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill.md).
- **Cat 40 agent-task results from October 2 to 7 measured gbrain without its reranker.** Restored harness slots
  kept a closed metering-proxy port for Voyage, so every rerank request failed and gbrain returned unreranked results.
  That covers the frontier tie with plain files (0 of 500 gbrain cells reranked), the six-model cost-wave set, the
  entity-recall rounds, the fix-wave development ladders, the 52,000-document tier, most of the release ladder, the
  F1/F10 instruction A/B in the Cat 41 report, the registration-surface cell, the P8 surface development runs and the
  fix wave 11 and 12 smokes. Comparisons between gbrain builds that shared the condition stay internally valid. The
  F1/F10 same-window pair for `b3f4e8b` reranked on one side only and does not support its conclusion as stated. The
  fix wave's held-out check reranked (1691 of 1800 cells) and is unaffected. Fixed in gbrain-evals #76 and #109.
  [Cat 40 correction](docs/benchmarks/2026-10-02-model-ladder.md#correction-2026-10-09),
  [Cat 41 correction](docs/benchmarks/2026-10-03-agent-operator.md#correction-2026-10-09),
  [audit](docs/benchmarks/2026-10-08-program-primary-hard/root-cause/restore-audit.json).
- **The May snapshot's Category 18b to 29 rows** came from runners written before the August audit; Cat 29's +4.00
  synthesis lift also scored the same single-answer call twice.
  [Report](docs/benchmarks/2026-05-23-v0.40.6.0-snapshot.md).

## Inspect or extend the work

- `eval/data/` contains public fixtures and answer keys. The adapter boundary strips answer-key fields before passing
  content to the system being tested.
- `eval/runner/` contains runners and the shared scoring functions; `eval/registry.ts` lists every category with its
  gate rules.
- `eval/reports/` holds temporary output. Published records live beside their reports in `docs/benchmarks/`.
- `test/eval/` contains tests for the harness; `.github/workflows/ci.yml` runs the checks that do not need provider
  credentials.

External adapters and independently written questions are welcome. The
[August audit](docs/audit/2026-08-31-eval-audit.md) explains earlier scoring and harness errors. The
[receipt manifest](docs/receipts-manifest.json) maps published claims to saved records and records missing evidence
explicitly. [CHANGELOG.md](CHANGELOG.md) records each release of this repository.

Code is MIT licensed. Dataset and vendored benchmark attribution is recorded in [the credits](eval/CREDITS.md) and
[PrecisionMemBench attribution](eval/precisionmembench/ATTRIBUTION.md).

## Changelog

### 2026-10-31: Re-pin to gbrain `3ec766c40`; the four new read defaults are named; repository row names v0.10.139

gbrain-evals v0.10.139 re-pins gbrain, adds the Cat 35 external lane, which scores another system's notes with Cat 35's
judges ([contributor guide](eval/CONTRIBUTING.md#score-another-systems-cat-35-documents)), and lands the post hoc
LongMemEval-S facts-block check and the shipped-build equivalence check
([sealed results](docs/benchmarks/2026-10-09-memory-proof-wave-sealed-results.md)), current Claude models in the shared
judge and the other Claude call sites, and the particle-1 provider module (see [CHANGELOG.md](CHANGELOG.md)). The
repository row names v0.10.139
(was v0.10.138). The pinned product row changes from `7a6bdd357` (v0.60.454.0) to `3ec766c40` (v0.60.531.0), and so does the sentence
under the table. Every commit the current state names is in the new release's history except `a7cb37b`, as before. A
new paragraph under it names the four read defaults gbrain added after the old pin (the dated facts block of a budgeted
`query`, v0.60.491.0; correction ordering of saved facts, v0.60.493.0; the remote page cap, v0.60.506.0; quote-fenced
chat text, v0.60.507.0 and v0.60.521.0), says that apart from the keyless Cats 37 to 39 check no result on this page was
measured with them, and says the memory-qa
harness holds the first three at their old values and unwraps the fence. The memory trust row's keyless check moves from
`77cf8e111` to `3ec766c40`: Cats 37, 38 and 39 pass every safety and quality contract in the BrainBench offline tier at
the new pin, as on main at `7a6bdd357`. Known limits: the timeline-read bullet said "At the pin" about a measurement
made at `77cf8e111`; it now names that commit and says the pin is unmeasured. The `auto_chronicle` bullet is removed:
it described gbrain before v0.60.49.0, which this pin and the three before it all postdate. No other result row changes.

### 2026-10-31: Equivalence claim links its section

The memory-bank paragraph says `d7467d1cf`'s retrieval was checked equivalent at `d7d7686de`; that claim now links the [equivalence section](docs/benchmarks/2026-10-09-memory-proof-wave-sealed-results.md#equivalence-of-the-shipped-build) of the sealed results, which reached main on 2026-10-31 together with the post hoc LongMemEval-S facts-block check. No result row on this page changes.

### 2026-10-31: Repository row names v0.10.138

gbrain-evals v0.10.138 adds the [shared-agent audience cost report](docs/benchmarks/2026-10-28-shared-agent-audience.md) for gbrain #7852 and train M (#8134). The repository row names v0.10.138 (was v0.10.137). No result row on this page changes; the report is listed in the [docs index](docs/README.md).

### 2026-10-31: Repository row names v0.10.137

gbrain-evals v0.10.137 adds the [member read access search cost report](docs/benchmarks/2026-10-28-member-read-access.md) for gbrain #7812 and train M (#8134). The repository row names v0.10.137 (was v0.10.136). No result row on this page changes; the report is listed in the [docs index](docs/README.md).

### 2026-10-29: Repository row names v0.10.136

gbrain-evals v0.10.136 adds the [spring-loaded skills report](docs/benchmarks/2026-10-24-spring-loaded-skills.md) for gbrain GBRA-194. The repository row names v0.10.136 (was v0.10.135). No result row on this page changes; the report is listed in the [docs index](docs/README.md).

### 2026-10-29: Repository row names v0.10.135

gbrain-evals v0.10.135 adds the [brain-first install block report](docs/benchmarks/2026-10-24-brain-first-install-block.md) for gbrain GBRA-188. The repository row names v0.10.135 (was v0.10.134). No result row on this page changes; the report is listed in the [docs index](docs/README.md).

### 2026-10-29: Repository row names v0.10.134

gbrain-evals v0.10.134 adds the [name-variant report](docs/benchmarks/2026-10-24-name-variants-7471.md) for gbrain#7471. The repository row names v0.10.134 (was v0.10.133). No result row on this page changes; the report is listed in the [docs index](docs/README.md).

### 2026-10-29: Repository row names v0.10.133

gbrain-evals v0.10.133 adds the [8k conversion report](docs/benchmarks/2026-10-26-gbrain-8k-conversion.md) with its preregistration, harness and held-out result. The repository row names v0.10.133 (was v0.10.132). No result row on this page changes; the report is listed in the [docs index](docs/README.md).

### 2026-10-29: Repository row names v0.10.132

gbrain-evals v0.10.132 makes `reuse-check.ts` and `arm_power.py` refuse inputs they used to pass, described in the [contributor guide](eval/CONTRIBUTING.md#cut-the-cost-of-a-preregistered-run). The repository row names v0.10.132 (was v0.10.131). No result row on this page changes.

### 2026-10-28: Repository row names v0.10.131

gbrain-evals v0.10.131 adds the [eval cost audit](docs/audit/2026-10-28-eval-cost-audit.md) and two Cat 40 cost tools, listed in the [docs index](docs/README.md). The repository row names v0.10.131 (was v0.10.130). No result row on this page changes.

### 2026-10-27: Q1 scoreboard headline block, measured; repository row names v0.10.130

The Q1 scoreboard's headline block between the `scoreboard:headline` markers now holds the measured results rendered
from the campaign receipt: BEAM-10M at 8,000 tokens, the BEAM-100K to BEAM-10M size curve, and the notes on every row
that is incomplete or not run. The sentence above the block no longer says the sealed waves are running, and links
[the report](docs/benchmarks/2026-10-06-scoreboard-report.md) and [the scoreboard guide](docs/scoreboard.md). Every GBrain
row measures gbrain 0.60.138.0 (`f05943e6`), not current master; a rerun is planned (F6). The repository row names
v0.10.130 (was v0.10.129). No other result on this page changed.

### 2026-10-25: Re-pin to gbrain `7a6bdd357`; repository row names v0.10.129

gbrain-evals v0.10.129. The pinned product row changes from `6e1086492` (v0.60.324.0) to `7a6bdd357` (v0.60.454.0). On pages over 1 MiB, gbrain
now keeps links, mentions, timeline, fences, conversation facts and synopses per segment, cuts forced chunks at sentence
ends and imports a new transcript session as one page (large pages Wave B PR 4, gbrain #7316); a git-canonical page that
turns private and then world again gets its file back (gbrain #7586). `src/core/search/mode.ts` changed between the two
commits: gbrain v0.60.332.0 added `collapse` and `rank_priors` to every mode bundle, both on (gbrain changelog,
0.60.332.0), so the search-mode sentences under the table now name them and say that earlier retrieval results ran
without them. Every commit that paragraph names is still in the release's history except `a7cb37b`. No result row on
this page changes. The repository row names v0.10.129 (was v0.10.128).

### 2026-10-21: Repository row names v0.10.128

gbrain-evals v0.10.128 adds the gbrain#7195 measurements to the [agent retrieval shapes report](docs/benchmarks/2026-10-20-agent-retrieval-shapes.md). The repository row names v0.10.128 (was v0.10.127).

### 2026-10-20: Repository row names v0.10.127

gbrain-evals v0.10.127 adds the gbrain#7186 measurements to the [agent retrieval shapes report](docs/benchmarks/2026-10-20-agent-retrieval-shapes.md). The repository row names v0.10.127 (was v0.10.126).

### 2026-10-20: Repository row names v0.10.126

gbrain-evals v0.10.126 adds the report-only [agent retrieval shapes](docs/benchmarks/2026-10-20-agent-retrieval-shapes.md) category (ARS). The repository row names v0.10.126 (was v0.10.125).

### 2026-10-20: Sync freshness rows; repository row names v0.10.125

gbrain-evals v0.10.125 adds the two sync freshness rows below (GBRA-133) and the PR 2b section of the [sync freshness report](docs/benchmarks/2026-10-19-sync-freshness.md): no-op round trips on managed Postgres and search latency during a sync. The repository row names v0.10.125 (was v0.10.124).

#### First managed sync after activation row

New row in Current results: the first managed sync after activating a classic brain, on gbrain v0.60.320.0 (#6712 PR 4b,
#7053), mirrored from GBRA-133 in
[the sync freshness report](docs/benchmarks/2026-10-19-sync-freshness.md#first-managed-sync-after-activating-a-classic-brain-gbrain-v0603200-6712-pr-4b).
Every run converged in one pass: Postgres 100,000 pages took 129.6 s and 23,243 statements (n = 1); 10,000 pages took
about 13 s on both engines (n = 3). No other row changes.

#### Sync freshness row

New row in Current results: how fast a commit becomes searchable through a running `gbrain serve` after gbrain
v0.60.316.0 (#7079) added the commit notifier, mirrored from GBRA-133 PR 2b.6 in
[the sync freshness report](docs/benchmarks/2026-10-19-sync-freshness.md): 0.60 s p50 in watch mode on Postgres (was
3.7 s on managed brains and never on classic ones), 2.15 s p50 in poll mode, and a PGLite embedding gap after a provider
outage. No other row changes.

### 2026-10-20: Re-pin to gbrain `6e1086492`; repository row names v0.10.124

gbrain-evals v0.10.124. The pinned product row changes from `f717b1a5b` (v0.60.299.0) to `6e1086492` (v0.60.324.0),
which adds `append_page`, upload sessions for pages larger than one request, and segmented `edit_page` (large pages Wave
B PR 3, gbrain #7104). `src/core/search/mode.ts` is identical at both commits, so the search-mode sentences stand, and
every commit the paragraph under the table names is still in the release's history except `a7cb37b`. This release also
records the N14 run at Wave B PR 3 ([report](docs/benchmarks/2026-10-20-n14-large-page-fidelity-wave-b3.md)). No result
row on this page changes. The repository row names v0.10.124 (was v0.10.123).

### 2026-10-18: Re-pin to gbrain `f717b1a5b`; repository row names v0.10.123

gbrain-evals v0.10.123. The pinned product row changes from `77cf8e111` (v0.60.169.0) to `f717b1a5b` (v0.60.299.0), which
turns segmented page storage on by default (large pages Wave B). The paragraph under the table now lists only `a7cb37b` as
a named commit outside the release's history: the other three it listed shipped before v0.60.299.0. It also says the
search modes changed after v0.60.169.0, with the Voyage `rerank-3-lite` default and `tokenmax` without expansion, and
cites the two addenda that checked them. This release also records the N14 run at the switch-on
([report](docs/benchmarks/2026-10-18-n14-large-page-fidelity-wave-b2.md)). No result row on this page changes. The
repository row names v0.10.123 (was v0.10.122).

### 2026-10-18: Graph backend row (HydraDB vs Postgres); repository row names v0.10.122

Current results gains a graph-walk row from the [graph backend benchmark](docs/benchmarks/2026-10-17-graph-backend.md)
(GBRA-123, preregistered): gbrain's breadth-first walks on Postgres (#6934, `fc1121cae58`) answer faster than HydraDB
at 10,000, 100,000 and 1,000,000 pages with identical answers, so production HydraDB routing is not built. No existing
number changed. The repository row names v0.10.122 (was v0.10.121).

### 2026-10-17: W11 confirms gbrain W4 on sealed material; repository row names v0.10.121

gbrain-evals v0.10.121 records the custodian's W11 run on gbrain v0.60.289.0: the weekly belief diff scores set-F1 1.0
on three fresh seeds with fresh wording, with exact before and after on 28 of 28 re-scores and correct cause and
evidence on 108 of 108 changes. The repository row names v0.10.121 (was v0.10.120).

### 2026-10-17: W11 sealed-confirmation preregistration for gbrain W4; repository row names v0.10.120

gbrain-evals v0.10.120 preregisters W11, the sealed confirmation of gbrain W4's weekly belief diff on a fresh seed and
fresh wording minted in custody, with a $0 harness that ports W4's own probe. The repository row names v0.10.120 (was
v0.10.119).

### 2026-10-17: Living pages decided on prior; repository row names v0.10.119

gbrain-evals v0.10.119 records the living-pages verdict for gbrain W9: with no owner data, W9 is not built in V1 and W10
is dropped with it, because the build threshold (1,387 reads per changed page-day) is far above any known personal-brain
read rate. The repository row names v0.10.119 (was v0.10.118).

### 2026-10-17: Living-pages preregistration; repository row names v0.10.118

gbrain-evals v0.10.118 preregisters the living-pages build decision for gbrain W9: a refreshed page beats anchored
retrieval only above about 1,387 reads per change once review time is priced, and the owner's ratio is read from two
aggregate queries. The repository row names v0.10.118 (was v0.10.117).

### 2026-10-17: Forecast-journal row; repository row names v0.10.117

gbrain-evals v0.10.117 mirrors the $0 forecast-journal gate for gbrain #6886 (wave 4b W7, shipped in v0.60.286.0): on
synthetic holders of known skill the journal ranks them in their true order (median ρ 0.905), counts every open
prediction exactly, and stays invisible to remote callers. New row after the take-grading row. The repository row names
v0.10.117 (was v0.10.116).

### 2026-10-17: P1 E2 rerun on gbrain W5; repository row names v0.10.116

gbrain-evals v0.10.116 records the custodian's P1 E2 rerun on gbrain v0.60.273.0 (W5): every late closure is disclosed
as an upper bound, and Opus 5.5, Sonnet 5.5 and GPT-6.1 Sol keep `apply` (0 wrong and 0 undated closures, as-of
exact 0.392 to 0.397). The repository row names v0.10.116 (was v0.10.115).

### 2026-10-17: Take grading shipped in gbrain v0.60.282.0; repository row names v0.10.115

gbrain #6882 merged as `4e698e9d9` (v0.60.282.0), so gpt-6.1-sol is gbrain's measured take-grading judge for prompt
`hybrid-evidence-v2`; the take-grading report and its `verdict.json` name the release. The report also records the
auto-resolve follow-ups decided on October 16. The repository row names v0.10.115 (was v0.10.114).

### 2026-10-17: Take-grading row; repository row names v0.10.114

gbrain-evals v0.10.114 records the take-grading eval for gbrain #6882 (wave 4b W6, `d99b84694`): among the verdicts the
auto-resolve rule would apply, gpt-6.1-sol applied 496 with none wrong (one-sided 95% upper bound 0.6%, under the
preregistered 1%), so it is gbrain's measured take-grading judge; Opus 5.5 and Sonnet 5.5 do not qualify. New row
after the slug-conflict row. The repository row names v0.10.114 (was v0.10.113).

### 2026-10-16: Repository row names v0.10.113

gbrain-evals v0.10.113 records N6 on gbrain's weekly belief diff (`delta {beliefs: true}`) at the v0.60.273.0 release
(`6c3e6fe0`, #6866): 0 leaks and 0 oracles in process and over Postgres HTTP, with real-history signal on both
(measured through `--gbrain`; the pin is unchanged), and adds the P1 E2 rerun preregistration for gbrain W5. No result
row on this page changes. The repository row names v0.10.113 (was v0.10.112).

### 2026-10-16: Repository row names v0.10.112

gbrain-evals v0.10.112 records N6 on gbrain's recorded-time reads (`known_as_of`) at the v0.60.267.0 release (`933a7677`,
#6850): 0 leaks and 0 oracles in process and over Postgres HTTP, with real-history signal on both (measured through
`--gbrain`; the pin is unchanged). No result row on this page changes. The repository row names v0.10.112 (was v0.10.111).

### 2026-10-16: Repository row names v0.10.111

gbrain-evals v0.10.111 records N1 with gbrain's belief ledger on, at the v0.60.265.0 release (`09943580e`, #6806):
388 of 388 current values and 0 stale with the ledger off and on (measured through `--gbrain`; the pin is unchanged). No
result row on this page changes. The repository row names v0.10.111 (was v0.10.110).

### 2026-10-16: Repository row names v0.10.110

gbrain-evals v0.10.110 records the LHF wave 2 plan, its reviews and measured verdicts (gbrain v0.60.259.0, #6822), and
the preregistered attendance paraphrase gate, which failed (measured through `--gbrain`; the pin is unchanged). No
result row on this page changes. The repository row names v0.10.110 (was v0.10.109).

### 2026-10-15: Repository row names v0.10.109

gbrain-evals v0.10.109 records an exploratory N14 run of segmented page storage (large pages Wave B PR 1, gbrain
v0.60.252.0, measured through `--gbrain`; the pin is unchanged). No result row on this page changes. The repository row
names v0.10.109 (was v0.10.108).

### 2026-10-15: Repository row names v0.10.108

gbrain-evals v0.10.108 records the D9 check of remote `find_contradictions` on gbrain v0.60.250.0: N6 now seeds a
stored contradiction report and finds 0 leaks, and N2's compatible-pair rule still holds, so its wave 14 number carries
forward. No result row on this page changes. The repository row names v0.10.108 (was v0.10.107).

### 2026-10-15: Repository row names v0.10.107

gbrain-evals v0.10.107 records the D7 Cat 41 brief scenarios. In 48 native Claude Code and Codex sessions on gbrain
v0.60.247.0, the pushed brief cut time to the first correct output by 6% against a preregistered 20%. So it shows no
time-saved signal, and the brief stays off by default; this is development evidence only. No result row on this page
changes. The repository row names v0.10.107 (was v0.10.106).

### 2026-10-15: Repository row names v0.10.106

gbrain-evals v0.10.106 records the D6 proactive-brief development v2 run. On the T0 carrier with gbrain v0.60.247.0,
with session-1 facts aged or crowded out of hot memory, the brief cut session-2 tool calls by 6% against a
preregistered 20%, so it shows no time-saved signal; success held at 72 of 72 in both arms. This is development
evidence only. No result row on this page changes. The repository row names v0.10.106 (was v0.10.105).

### 2026-10-15: Cat 40 next-wave confirmation; repository row names v0.10.105

gbrain-evals v0.10.105 adds the Cat 40 next-wave development record, preregistration and confirmation. A new row under
Current results reports what ships: Part 1 without F5 ahead of plain files by +10.67 points on two sealed worlds, the
pre-wave baseline ahead on both generators, and the public build with F5 marked not shipped because F5 failed its
precision ship condition. The repository row names v0.10.105 (was v0.10.104).

### 2026-10-15: Repository row names v0.10.104

gbrain-evals v0.10.104 adds the N14 large-page fidelity rerun after large pages Wave A (gbrain `44eb049`, measured
through `--gbrain`; the pin is unchanged). No result row on this page changes. The repository row names v0.10.104 (was
v0.10.103).

### 2026-10-14: Repository row names v0.10.103

gbrain-evals v0.10.103 records the D6 proactive-brief development run. On the T0 carrier with gbrain v0.60.240.0,
brief-on and brief-off both finished 70 of 72 paired tasks, so it shows no improvement signal; this is development
evidence only. No result row on this page changes. The repository row names v0.10.103 (was v0.10.102).

### 2026-10-14: Repository row names v0.10.102

gbrain-evals v0.10.102 records the D5 brief re-smoke on gbrain #6703, which passes, and makes the Cat 40 runner scrub
machine paths from the files it writes. No result row on this page changes. The repository row names v0.10.102 (was
v0.10.101).

### 2026-10-14: Repository row names v0.10.101

gbrain-evals v0.10.101 records the Cat 40 smoke for gbrain #6703's `context_pack` `counterparty` and `intent`
parameters. No result row on this page changes. The repository row names v0.10.101 (was v0.10.100).

### 2026-10-14: Repository row names v0.10.100

gbrain-evals v0.10.100 adds BrainBench N14, large-page fidelity, and its hermetic baseline on gbrain master `c71fe74`.
The category is report-only and held until gbrain ships a large-page API. No result row on this page changes. The
repository row names v0.10.100 (was v0.10.99).

### 2026-10-14: Repository row names v0.10.99

gbrain-evals v0.10.99 adds the query-expansion latency result: on 300 LongMemEval-S questions, `query` without
expansion on `tokenmax` keeps retrieval quality within the preregistered margins at about a ninth of the latency. No
result row on this page changes. The repository row names v0.10.99 (was v0.10.98).

### 2026-10-14: Repository row names v0.10.98

gbrain-evals v0.10.98 records the F5 owner-phrase run on messy-company-v1. No result on this page changed. The
repository row names v0.10.98 (was v0.10.97).

### 2026-10-14: Repository row names v0.10.97

gbrain-evals v0.10.97 adds the messy-company-v1 dataset. No result on this page changed. The repository row names
v0.10.97 (was v0.10.96).

### 2026-10-14: Cat 41 fifth-run report corrected; repository row names v0.10.96

gbrain-evals v0.10.96. The [fifth Cat 41 setup report](docs/benchmarks/2026-10-14-cat41-setup-run5.md) had compared
install-guide reading times measured two different ways. Measured one way, they are 14.4, 16.9 and 10.2 s against
the fourth run's 14.5, 6.9 and 8.2 s. The report also gained a descriptive appendix. No verdict and no result row on
this page changes. The repository row names v0.10.96 (was v0.10.95).

### 2026-10-14: Cat 41 setup fifth run; repository row names v0.10.95

gbrain-evals v0.10.95. On gbrain v0.60.219.0, with the fourth run's design unchanged, first push is met for the first
time: the hook printed the preference into all 3 fresh Claude Code sessions, and every agent kept it in gbrain only.
Consent is met (no provider request). Wired recall misses by 0.2 s (60.2 s against 60 s), and faster setup misses
(2.8%) ([report](docs/benchmarks/2026-10-14-cat41-setup-run5.md)). No result row on this page changes. The repository
row names v0.10.95 (was v0.10.93, since v0.10.94 did not update it).

### 2026-10-13: Repository row names v0.10.93

gbrain-evals v0.10.93 adds the reranker-settings addendum: on 300 LongMemEval-S questions, Voyage `rerank-3-lite` at
the shipped 50 × 1,400 shape keeps retrieval quality within the preregistered margins and cuts rerank cost 60%, with
about the same latency. No result row on this page changes. The repository row names v0.10.93 (was v0.10.92).

### 2026-10-13: receipt source-tree hash fix; repository row names v0.10.92

gbrain-evals v0.10.92 hashes the source tree for receipts from git's index, reading only changed files, so the
first receipt in a test no longer hashes 1.7 GB. No result on this page changes. The repository row names v0.10.92 (was v0.10.91).

### 2026-10-13: Cat 41 setup fourth run; repository row names v0.10.91

gbrain-evals v0.10.91. With a world-visible preference as the first-push item, gbrain v0.60.208.0's hook printed it
into all 3 fresh Claude Code sessions. First push still met its target in only 1 of 3 runs, because two agents also
saved the preference to Claude Code's own memory. Wired recall (55.5 s) and consent (no provider request) are met,
and faster setup (20.7%) is missed ([report](docs/benchmarks/2026-10-13-cat41-setup-run4.md)). No result row on this
page changes. The repository row names v0.10.91 (was v0.10.89, since v0.10.90 did not update it).

### 2026-10-13: Cat 41 setup on v0.60.208.0; repository row names v0.10.89

gbrain-evals v0.10.89. On gbrain v0.60.208.0 setup meets wired recall (54.3 s against 60 s) and consent (no provider
request in any run). It misses first push (0/3: every agent saved the locker code as a private fact, which push never
carries). The faster-setup claim misses as scored and holds on reading (28.1%)
([report](docs/benchmarks/2026-10-13-cat41-setup-v208.md)). No result row on this page changes. The repository row
names v0.10.89 (was v0.10.88).

### 2026-10-13: W1 guidance smoke; repository row names v0.10.88

gbrain-evals v0.10.88 adds the W1 guidance smoke (A12g): with the gbrain plugin installed natively, Opus 5.5 passed 2 of
5 sessions and Fable 5.1 5 of 5, so the `recall` `question` guidance stays parked
([report](docs/benchmarks/2026-10-13-w1-guidance-smoke.md)). No result row on this page changes. The repository row
names v0.10.88 (was v0.10.86; v0.10.87 did not update it).

### 2026-10-13: Cat 41 setup re-measure; repository row names v0.10.86

gbrain-evals v0.10.86. On gbrain v0.60.203.0 setup still misses wired recall (67.8 s against 60 s), first push (0/3)
and consent, and meets the faster-setup threshold as scored (26.5%) but not on reading (19%, a frozen date-rule miss)
([report](docs/benchmarks/2026-10-13-cat41-setup-remeasure.md)). The repository row names v0.10.86 (was v0.10.85).

### 2026-10-13: Memory proof wave 2 results; repository row names v0.10.85

gbrain-evals v0.10.85 adds the wave 2 BEAM row to current results and a memory comparison to how gbrain compares. Both are measured at gbrain
`71b6d85` (#6445): `combined-v2` passes gates 1, 2 and 3, and adaptive W5 passes its gate at factor 1.50. No other row
changes. The repository row names v0.10.85 (was v0.10.84). The installed-pin note says `71b6d85` ships in gbrain
v0.60.202.0 (#6445), with W5 on by default at factor 1.50 and the W1 `question` guidance deferred (was: #6445 has not
merged).

### 2026-10-13: Repository row names v0.10.84

gbrain-evals v0.10.84 adds the reranker-settings verdict on LongMemEval-S: none of 18 cheaper rerank settings holds
strict recall@10 within 2 questions of the shipped 50 × 1,400 `rerank-2.5` setting on 300 questions, so the default
stays. No result row on this page changes. The repository row names v0.10.84 (was v0.10.83).

### 2026-10-12: BEAM-1M S1 fixes; repository row names v0.10.83

gbrain-evals v0.10.83. The memory-qa harness now reranks by default and fails closed without the reranker (+4.5
points strict recall at 5 on BEAM-1M dev, a harness change rather than a product change), and the S1 report records
the diverse pool and wider reading staying off ([report](docs/benchmarks/2026-10-12-beam-1m-s1-fixes.md)). The
repository row names v0.10.83 (was v0.10.82).

### 2026-10-12: Cat 41 scripted user v7 and setup re-measure preregistration; repository row names v0.10.82

gbrain-evals v0.10.82. Cat 41's scripted user now answers a closing question the same way in every install arm, the
October 12 setup runs are re-scored under v7 beside their unchanged report, and the setup re-measure is preregistered
against the same targets. The repository row names v0.10.82 (was v0.10.81).

### 2026-10-12: Low-hanging-fruit wave paid gates; repository row names v0.10.81

gbrain-evals v0.10.81 records the paid gates of the low-hanging-fruit wave
([report](docs/benchmarks/2026-10-12-lhf-wave.md)). No current-results row changes, because the results gate gbrain
defaults rather than score a release. The repository row names v0.10.81 (was v0.10.80).

### 2026-10-12: Cat 41 `gbrain setup claude-code` TTHW; repository row names v0.10.80

gbrain-evals v0.10.80. The wave 2 setup measurement on v0.60.184.0 misses its wired-recall (83.8 s against 60 s),
first-push (0/3) and consent targets as written and meets the faster-setup threshold as scored (35%, 23% like-for-like)
([report](docs/benchmarks/2026-10-12-cat41-setup-tthw.md)). The repository row names v0.10.80 (was v0.10.79).

### 2026-10-12: Cat 40 warm boot waits for the persistence drain; repository row names v0.10.79

gbrain-evals v0.10.79. The Cat 40 warm boot no longer snapshots a slot while gbrain is still draining persistence
effects, and the D2/D4 notice smoke is recorded ([verdict](docs/benchmarks/2026-10-12-d2d4-smoke/VERDICT.md)). The
repository row names v0.10.79 (was v0.10.78).

### 2026-10-12: Retire the Cat 40 v1 success headline; repository row names v0.10.78

gbrain-evals v0.10.78. The Cat 40 results row no longer reports 95.6% success on five frontier models: gbrain ran
without its reranker in all 500 of those cells (gbrain-evals #110) and the world is at its ceiling, so the tie and the
older six-model lead are retired without a rerun. The row keeps the permission result (0 of 100 finance-only leaks into
context), which does not depend on reranking. A new row reports the Cat 40 Hard confirmation (+7.7 and +13.0 points
over plain files on a fresh and a sealed world, reranking verified), and "How gbrain compares" describes agent tasks
from it. The repository row names v0.10.78 (was v0.10.77).

### 2026-10-12: Q1 scoreboard headline block, pending

New block at the top of "How gbrain compares": the Q1 scoreboard's six-column headline table between the
`scoreboard:headline` markers, every cell pending until the sealed waves settle. `bun eval/runner/scoreboard.ts
render` replaces it from the campaign receipt. No existing result changed.

### 2026-10-11: T0b sealed confirmation; repository row names v0.10.77

gbrain-evals v0.10.77. The custodian-sealed T0b confirmation reports the shipped stack (v0.60.174.0) failing 5 of 576
runs where v0.60.106.0 fails 271, verdict `10x` under `t0b-score-v2` and `improvement` under `t0b-score-v1`
([report](docs/benchmarks/2026-10-11-t0b-sealed-confirmation.md)). The repository row names v0.10.77 (was v0.10.76).

### 2026-10-11: Pin gbrain v0.60.169.0 (`77cf8e111`); repository row names v0.10.76

gbrain-evals v0.10.76. The pin moves from `8a3eedeac` (v0.60.126.0) to the release v0.60.169.0, `77cf8e111`, after a
paired keyless regression check that found no gbrain regression ([re-pin report](docs/benchmarks/2026-10-11-wave14-repin.md)).
The rows rerun at every pin now name `77cf8e111`: N1 (388 of 388, unchanged), N5 (0 prohibited outputs, unchanged),
the privacy row (0 leaks, 155 of 155 Postgres cells, unchanged) and N12, which reads 29 of 29 formats instead of 28 of
28 because gbrain registered one more chat pattern (`plain-role-no-time`) and N12 now covers it. The bug-ledger
sentence counts 29 repros and adds the three memory trust repros. The Cat7-1 limit adds its measurement at the pin.
Features the old pin predated now appear, each on evidence measured at a commit in the new pin's history: memory
trust labels (a capability and a results row from the paid run at `c2f10ee8` to `5b9c814b`, with Cats 37 to 39
passing keyless at the pin), the verbatim-quote probe (`fecc7827`, 500 of 500 clean against 429), scoped vector
search at 1M to 2M chunks (`2e84d234e`) and the matched BEAM comparison with a memory-bank server (`d7467d1cf`). The
N2 row moves to `77cf8e111` after its paid judge arm was rerun with Garry's approval ($7.07): it reads 146 of 150
instead of 149 of 150, with the same judge model and prompt. Three conflicts the earlier run caught were called
changes over time, which is sampling variation at the provider's default temperature (exact McNemar p = 0.25). It
also flags 4 of 51 compatible pairs instead of 6. The repository row names v0.10.76 (was v0.10.75).

### 2026-10-11: Repository row names v0.10.75

gbrain-evals v0.10.75 adds the Cat 40 Hard fix wave's plan, development record, confirmation preregistration and
results, and records that the sealed Hard world has now run once. No result row on this page changes. The repository
row names v0.10.75 (was v0.10.74).

### 2026-10-11: Repository row names v0.10.74

gbrain-evals v0.10.74 adds Cat 40 Hard: the tier, its calibration record, the October 7 held-out result and the fix
wave's confirmation, where gbrain v0.60.139.0 is ahead of plain files on a fresh and a sealed world (+7.7 and +13.0
points). No result row on this page changes. The repository row names v0.10.74 (was v0.10.73).

### 2026-10-11: Repository row names v0.10.73

gbrain-evals v0.10.73 folds in two contributor fixes: the Bash 3.2 resume-args guard in the phase 1 run script and
the shared judge's rejection of non-finite scores. No result row on this page changes. The repository row names
v0.10.73 (was v0.10.72).

### 2026-10-11: Repository row names v0.10.72

gbrain-evals v0.10.72 publishes the memory proof wave: the preregistration and addenda, the harness, and the sealed
BEAM results ([report](docs/benchmarks/2026-10-09-memory-proof-wave-sealed-results.md)) for the build that shipped as
gbrain #6066 (v0.60.164.0). No result row or capability on this page changes. The repository row names v0.10.72 (was
v0.10.71).

### 2026-10-10: Repository row names v0.10.71

gbrain-evals v0.10.71 adds the H1 results ([report](docs/benchmarks/2026-10-10-gbrain-budgeted-delivery-h1.md)): on
sealed confirmation v2, `depth_first` packing lost to the shipped `cap_only` at an explicit 5,500-token budget (122
against 145 of 200), so gbrain's explicit-budget default does not change. No result row or capability on this page
changes: the page states no explicit-budget packing result, and calls without a budget are unaffected. The repository
row names v0.10.71 (was v0.10.70).

### 2026-10-10: Repository row names v0.10.70

gbrain-evals v0.10.70 adds the preregistration of H1, the held-out test of `depth_first` packing against the shipped
`cap_only` on sealed confirmation v2 ([preregistration](docs/benchmarks/2026-10-10-gbrain-budgeted-delivery-h1-preregistration.md)).
It is not a result, so no result row on this page changes. The repository row names v0.10.70 (was v0.10.69).

### 2026-10-10: Repository row names v0.10.69

gbrain-evals v0.10.69 adds T0b generator v2 (unique short codes), scorer `t0b-score-v2`, custodian-sealed seed and world
tooling, and preregistration amendment 5 for the sealed confirmation of the shipped stack. No paid cells. The
repository row names v0.10.69 (was v0.10.68).

### 2026-10-10: Repository row names v0.10.68

gbrain-evals v0.10.68 adds the T0b namesake diagnostic: the 11 namesake-flagged runs left on the alias-stack arms are
scorer false positives, with no conflation and no wrong-entity resolution by gbrain. The repository row names v0.10.68
(was v0.10.67).

### 2026-10-09: Repository row names v0.10.67

gbrain-evals v0.10.67 adds the memory trust categories (Cats 37 to 39), their preregistration and the paid run for
gbrain #6396 (merged as `d4dc2d4d8`, v0.60.139.0, the #5575 memory trust feature): the [paid report](docs/benchmarks/2026-10-08-memory-trust-results-paid.md).
No result row on this page changes, because the pin is still `8a3eedeac`, which predates the feature. The repository
row names v0.10.67 (was v0.10.66).

### 2026-10-09: Repository row names v0.10.66

gbrain-evals v0.10.66 adds the verbatim-probe paired verdict for gbrain #6391 (merged as `f05943e65` in v0.60.138.0):
the verbatim-quote probe: 71 questions gained a clean read and none lost one (429 to 500 of 500, exact McNemar p = 8.5e-22), with strict recall@10 unchanged at 496 of 500. No result row on this page changes, because the pin is still `8a3eedeac`. The repository row names v0.10.66
(was v0.10.65).

### 2026-10-09: Repository row names v0.10.65

gbrain-evals v0.10.65 adds the HNSW scale report, mirrored from gbrain #6380 (merged as `2e84d234e` in v0.60.135.0):
at 1M to 2M chunks, pooled vector attempts that scan 20,000 tuples lift random 10% scope recall@50 from 0.52 to 0.77
to 0.96 to 0.99, and topic-coherent selective sources remain a gap. No result row on this page changes, because the
pin is still `8a3eedeac`. The repository row names v0.10.65 (was v0.10.64).

### 2026-10-09: Repository row names v0.10.64

gbrain-evals v0.10.64 adds the T0b alias-stack report: short-code aliases (gbrain #6271 at `f24ca6afe`) on top of
Candidate 1 cut failures from 18 to 4 of 72 on fresh seeds (`improvement`) and from 25 to 11 of 144 on development seeds
(`inconclusive`). The repository row names v0.10.64 (was v0.10.63).

### 2026-10-09: Slug-conflict judgment added to current results

gbrain-evals v0.10.63 (the repository row names it; was v0.10.62). New row: gbrain #6377 (`ac6e0868`, branch `capy/gbra72-content-repair`) adds a content-repair lane whose model tier judges a file whose frontmatter `slug:` names another page. On 48 synthetic pairs over three runs, `claude-opus-5-5`, `gpt-6.1-sol` and `claude-sonnet-5-5` gave no harmful answer (no `remove_slug` on a true duplicate, no `merge_into` of two different things, no wrong canonical), removed every stray slug and deferred every ambiguous pair; they recognised 92.0%, 85.3% and 80.0% of true duplicates and deferred the rest. All three qualify; Opus 5.5 leads gbrain's `CONTENT_REPAIR_MEASURED_MODELS`. Details in [the judgment report](docs/benchmarks/2026-10-09-content-repair-judgment.md) and [its preregistration](docs/benchmarks/2026-10-09-content-repair-judgment-preregistration.md).
### 2026-10-09: Repository row names v0.10.62

gbrain-evals v0.10.62 adds the budgeted delivery E2 report (how `auto` should pack an explicit token budget; development
data). The repository row names v0.10.62 (was v0.10.59).

### 2026-10-09: Pin gbrain `8a3eedeac`; repository row names v0.10.59

gbrain-evals v0.10.59. The pin moves from `fc548317f` (v0.60.122.0) to `8a3eedeac` (v0.60.126.0), the merge of gbrain #6362,
which puts the newest dated mentions of each entity on `context_pack` cards, on by default, as measured in the
[Candidate 1 report](docs/benchmarks/2026-10-09-candidate-1-newer-mentions.md). The repository row names v0.10.59
(was v0.10.57).

### 2026-10-09: Repository row names v0.10.57

gbrain-evals v0.10.57 adds the evidence brief confirmation (wave 1 A6). The repository row names v0.10.57 (was v0.10.56).

### 2026-10-09: Cat 40 rows note gbrain ran without its reranker; repository row names v0.10.56

gbrain-evals v0.10.56 adds dated corrections to the Cat 40 results that ran gbrain without reranking (restored harness slots kept a closed metering-proxy port; fixed in #76 and #109). The Cat 40 results row now says gbrain's reranker failed in all 500 cells, the agent-tasks comparison says both sets measured gbrain with the reranker off, and Corrections gains a bullet listing the affected runs. The numbers are unchanged. The repository row names v0.10.56 (was v0.10.55).

### 2026-10-08: Repository row names v0.10.55

gbrain-evals v0.10.55 adds the T0b root-cause report, a measurement of gbrain master v0.60.122.0 on the T0b protocol, and harness fixes so restored gbrain slots search with the reranker. The repository row names v0.10.55 (was v0.10.54). Results rows keep the commits they were measured at, so no row changes.

### 2026-10-08: Repository row names v0.10.54

gbrain-evals v0.10.54 adds the harder program primary (T0b): its preregistration with three calibration rounds and its development baseline at gbrain v0.60.106.0. The repository row names v0.10.54 (was v0.10.53). Results rows keep the commits they were measured at, so no row changes.

### 2026-10-08: Pin gbrain `fc548317f`; repository row names v0.10.53

gbrain-evals v0.10.53. The pin moves from `61624308b` (v0.60.120.0) to `fc548317f` (v0.60.122.0), the merge of gbrain #6350, which ships the eval-only evidence brief builder the wave 1 evidence architecture pilot measured. The repository row names v0.10.53 (was v0.10.52).

### 2026-10-08: Repository row names v0.10.52

gbrain-evals v0.10.52 adds the program primary (T0) preregistration and its development baseline at gbrain v0.60.106.0, and the power work (PW). The repository row names v0.10.52 (was v0.10.51). Results rows keep the commits they were measured at, so no row changes.

### 2026-10-08: Pin gbrain `61624308b`; repository row names v0.10.51

gbrain-evals v0.10.51. The pin moves from `a865f8f` (v0.60.104.0) to `61624308b` (v0.60.120.0), the merge of gbrain #6343 (Q2 parser gaps: the line-grammar guards and diagnostics, settings-bound link extraction, and the held-out-confirmed link-typing units U1, U3 and U4). The repository row names v0.10.51 (was v0.10.45; the 0.10.46 to 0.10.50 releases did not restamp it). This release adds the Q2 preregistration, harness, custodian runbook and held-out verdicts (typed relation lines stay opt-in). Results rows keep the commits they were measured at, so no row changes.

### 2026-10-08: ClientRead wedge row; repository row names v0.10.45

gbrain-evals v0.10.45. New row: a managed Postgres sync behind a transaction-mode pooler wedges with one process and no lanes when one round trip never completes, and two consumers on one host were a multiplier, not the cause (0 wedges in 2 h 49 min of the two-consumer shape), mirrored from gbrain's Phase 0 record for #6317 in [the ClientRead wedge report](docs/benchmarks/2026-10-08-managed-sync-clientread-wedge.md). The repository row names v0.10.45 (was v0.10.43).
### 2026-10-08: Repository row names v0.10.44

gbrain-evals v0.10.44. The repository row names v0.10.44 (was v0.10.43). This release adds the BEAM-1M failure analysis on the development split (wave 0 item B2 of the 10x memory advantage plan) and fixes the BEAM date order in the memory-qa reader prompt; the results table has no BEAM-1M row, so no other row changes.

### 2026-10-08: Repository row names v0.10.43

gbrain-evals v0.10.43. The repository row names v0.10.43 (was v0.10.42). This release adds the shared usage receipt, the reading headroom recount and the model-rule and price updates (wave 0 items A1, A2 and R1 of the 10x memory advantage plan); none of them changes a row in the results table, so no other row changes.

### 2026-10-08: Managed Postgres preparation stall row for gbrain #6298

gbrain-evals v0.10.42. The repository row names v0.10.42 (was v0.10.41). The results table gained a row for the preparation stall fix in gbrain v0.60.112.0 (#6298): a 15,000-entry catch-up with heavy fact adoption that never drained on v0.60.105.0 drains in two passes at pool 10 and three at pool 3, a stuck write is held within 240 s, and a table lock still pins the connection pool (gbrain #6318). One pass at a 3600 s timeout is not met. Full verdicts are in [the report](docs/benchmarks/2026-10-08-managed-sync-preparation-stall.md). No other row changes.

### 2026-10-08: Managed Postgres catch-up row updated for gbrain #6279

gbrain-evals v0.10.41. The catch-up row now reads 372.7 pages/min steady and 33.5 min for the 10,000-file backlog (was 152.8 pages/min and about 1.2 h on v0.60.73.0, from a 4-vCPU host), with a page save at 2.5 s instead of 8.6 s, mirrored from gbrain #6279's before-and-after on one 16-vCPU VM in [the lanes and foreground report](docs/benchmarks/2026-10-07-managed-sync-lanes-foreground.md). Three of gbrain's targets missed and are named there: first commit (20 s against 15 s), page saves during a catch-up, and catch-up speed while an agent saves a page every 5 s (15% of idle against 50%).

### 2026-10-07: Version stamp for the fix wave 12 agent smoke

gbrain-evals v0.10.40. The repository row names v0.10.40 (was v0.10.39). The release adds the fix wave 12 agent smoke, listed in the [docs index](docs/README.md). It is pinned to gbrain v0.60.106.0 (`7aa2caa`, #6269), which shipped the put_page UUID line and reverted the forget-caveat move. No result row on this page changes, because the pin stays at `a865f8f`.

### 2026-10-07: Version stamp for the fix wave 11 records

gbrain-evals v0.10.39. The repository row names v0.10.39 (was v0.10.38). The release adds two records paired with gbrain fix wave 11, listed in the [docs index](docs/README.md): the relaxed HNSW scan order mirror and the D12 agent smoke. No result row on this page changes, because both measure an unmerged gbrain branch rather than the pin.

### 2026-10-07: Re-pin to gbrain `a865f8f`; N1-7 fixed

gbrain-evals v0.10.37. The pin moves from `c5fb0201` (v0.60.95.0) to `a865f8f` (v0.60.104.0), which contains gbrain's fix for N1-7. The ledger sentence now says N1-7 is fixed (was: one open gbrain bug). The privacy and chat-format rows name `a865f8f`, where their keyless checks were rerun; the paid rows, the attendance world and the Postgres-over-HTTP privacy cells stay at `c5fb0201`, named as such.

### 2026-10-07: LongMemEval answers at the current pin, the full-context comparison, Fable smoke-only

gbrain-evals v0.10.37. The LongMemEval answer row moves from 453 of 500 (Sonnet 4.6 house reader, v0.59.13.0) to 468 of 500 at `c5fb0201` with the Sonnet 5.5 benchmark notes reader; against the same reader on the old retrieval that is "no change shown" (462, p = 0.08), so the move reflects the reader and the current pin. The `gpt-5.4` frontier-reader row (447 of 500) is replaced by the best current reader on the same frozen retrieval, Opus 5.5 at 474. "How gbrain compares" gains the matched-reader full-context comparison. Takes and contradiction-judge rows count Opus 5.5 as the top Anthropic model; Fable 5.1 results are smoke-only under Garry's 2026-10-07 rule.

### 2026-10-06: Re-pin to gbrain `c5fb0201` and the October follow-up round

gbrain-evals v0.10.37. The pin moves from `739e5cc` (v0.60.46.0) to `c5fb0201` (v0.60.95.0), which contains every held-out-program plan, so the "newer builds also measured" row is gone. Results rows: privacy now covers Postgres over real HTTP and the N8 gate at `c5fb0201` (was N6 and N8 at `739e5cc`); chat formats 28 of 28 (was 27 of 27); new rows for attendance from documented lists, the contradiction judge on current models and the takes classifier on frontier models; the Cat 35 row says its judge calibration awaits a person's review; the ledger sentence names the October 6 re-pin and the open N1-7 bug it found. Reasons and receipts: the [round plan](docs/plans/2026-10-06-followups-round/PLAN.md) and its reports.

How this page changed, newest first. Measurement history lives in the dated reports and in
[CHANGELOG.md](CHANGELOG.md); this section records what this page said and why it changed.

### 2026-10-06: Fence repair accuracy added to current results

gbrain-evals v0.10.36. New row: gbrain v0.60.102.0 ([`5b58910`](https://github.com/garrytan/gbrain/commit/5b5891069), #6229) repairs malformed facts and takes tables by itself, and its model tier ships with a measured default. On a 52-fence held-out set written before the repair fixes existed, gpt-6.1-sol and claude-opus-5-5 each repaired 96.0% of the fences that reach the model with zero wrong cells, and answered HOLD on the rest; claude-opus-4-7 and claude-sonnet-5-5 did not qualify. Details and both preregistered rounds are in [the fence repair report](docs/benchmarks/2026-10-06-fence-repair-tier3.md).

### 2026-10-05: Managed Postgres catch-up speed added to current results

gbrain-evals v0.10.26. New row: a managed Postgres brain 57 ms from its database catches up at 152.8 pages per minute in steady state with gbrain v0.60.73.0 (a 10,000-file backlog in about 1.2 h), mirrored from gbrain's own bench in [the catch-up report](docs/benchmarks/2026-10-05-managed-sync-catchup.md). The page had no write-throughput row before.

### 2026-10-05: Other systems described by kind, not by name

The "How gbrain compares" section and the changelog entries below describe other memory systems by kind (a verbatim-session memory system, a token-native retrieval system, a temporal knowledge-graph service, hosted memory products, a model provider's memory tool) instead of naming them. Their names, versions and sources stay in [comparisons and their protocols](docs/comparison-systems.md), which this page links. No number changed.

### 2026-10-05: Rewritten as what gbrain does, current results and how it compares

gbrain-evals v0.10.23. The page now has three parts above the changelog, replacing a run of dated findings and "Update, October 2/3/4" blocks:

- **What gbrain does:** the capabilities in plain words (hybrid retrieval, relationships, whole-conversation delivery, correctness, the agent operator contract, the write path), with a table naming the gbrain under test (pin `739e5cc`, v0.60.46.0, its aliases and the newer builds also measured).
- **Current results:** one table of every headline number with its gbrain commit and report, including results the page had not carried: Cat 40 on five frontier models (95.6%, 0 of 100 finance leaks), the multi-relation planner's held-out pass (24 better, 0 worse) and PrecisionMemBench precision (0.586).
- **How gbrain compares:** strict LongMemEval retrieval against other systems' saved rankings (now led by the 451/470 opaque-id recount instead of the September 6 449/470), answer accuracy beside published systems with the same `gpt-5.4` reader, PrecisionMemBench against the upstream table, concept search against reranked vectors, and Cat 40 against files, Postgres and a built-in memory tool.
- **Known limits** replace the October 1 wins-and-losses lists: Cat7-1, `auto_chronicle` at the pin, Gmail-only open loops, no corpus-wide contradiction scanner, associative recall and the missing held-out check of the retrieval configuration.
- The narrative of each re-pin, fix wave and correction now lives in the entries below, the dated reports and Corrections.

### 2026-10-04: `auto_chronicle` verdict updated for the fix rerun

[`bfe09be`](https://github.com/garrytan/gbrain-evals/commit/bfe09be). The October 4 `auto_chronicle` paragraph now limits "default-on is contradicted" to `739e5cc` and adds a rerun at gbrain PR #6010 (`5a44025`, not yet merged), which drops events dated after their page. That rerun found 0 such events, 0.04 wrong events per page and recall of 37 and 38 of 38, so default-on is supported there. A link to the rerun report joins the two existing links.

### 2026-10-04: October 4 re-pin update and the `auto_chronicle` off-versus-on test

[`b54b978`](https://github.com/garrytan/gbrain-evals/commit/b54b978). A new "Update, October 4" block reports the offline tier at `109b992` against `739e5cc` (gbrain v0.60.46.0). No category's accuracy changes except A4's: keyless `query` grades 100 of 120 answerable questions `moderate` (was 40). All 28 ledger repros pass, refusals now name the exact command, and N6 moved to one session per probe after a once-per-session notice tripped three probes. The block also reports the first off-versus-on test of `auto_chronicle`: it found 35 and 37 of 38 labeled events and raised "who did I meet that day" from 60% to 100%, but it wrote planned follow-ups as events on future dates (0.96 wrong events per page against a 0.20 gate), so default-on was contradicted under the preregistered rule.

### 2026-10-04: Cat 41 result names the shipped release

[`94cf3ac`](https://github.com/garrytan/gbrain-evals/commit/94cf3ac). The Cat 41 paragraph now credits gbrain v0.60.46.0 (the operator wave, measured at candidate `b3f4e8b`) instead of "candidate release `b3f4e8b` (v0.60.38.0)". The numbers are unchanged.

### 2026-10-04: New section on agents operating gbrain (Cat 40 and Cat 41)

[`da5093b`](https://github.com/garrytan/gbrain-evals/commit/da5093b). A new "When an agent operates gbrain" section describes both categories as they stand. Cat 41 runs pinned Claude Code and Codex CLI sessions through 17 risky requests. The candidate passes its gate with 0 consent violations across 66 safety sessions, 0 false "no notes" answers and token overhead of at most +5.9%, and it finishes 96 of 102 sessions. Released v0.60.35.0, for comparison, has 25 violating steps in 12 safety sessions and finishes 78 of 102. Cat 40 (Model Ladder) swaps only the memory (files with `grep`, a model provider's memory tool, plain Postgres, gbrain's MCP server) across 50 company-knowledge tasks. The section adds run commands (about $80 for both), and the "What should you learn here?" table gains a row for each category.

### 2026-10-04: Re-pin to gbrain `739e5cc`

[`bf5fa53`](https://github.com/garrytan/gbrain-evals/commit/bf5fa53). The installed-pin sentence moves from `109b992` (v0.60.37.0) to `739e5cc` (v0.60.46.0), which carries the Cat 40 cost wave, `auto_chronicle` and the agent-first operator wave. `src/core/search/mode.ts` is byte-identical, so the search-mode claim stands. The October 4 recount sentence now calls `109b992` "the pin at the time".

### 2026-10-04: LongMemEval recounted with opaque session ids

[`6bc98aa`](https://github.com/garrytan/gbrain-evals/commit/6bc98aa). Every published retrieval arm was recounted at `109b992` with opaque session ids, so the `answer_` prefix never reaches gbrain. The page changes in several places:

- "Where gbrain stands" adds the recount (451/470, 95.96%, paired +2/−0 against 449/470). The strict `recall_all@5` table gains two rows: 451/470 with the reranker and 434/470 (92.34%) without.
- A frontier-reader result joins the answer-accuracy paragraph. `gpt-5.4` on the GPT-4o arm's official prompts answered 447/500 (89.4%), winning 33 and losing 16 against GPT-4o (p = 0.021).
- The reading-notes study, re-run with opaque ids, still favors notes: 304/361 to 320/361 (+25/−9, p = 0.009).
- The trimming claim adds the recount values (384/470 to 451/470). "Query rewrites hurt retrieval" is now dated to September 6, because the recount shows 436/470 against 434/470, so expansion stays off only for its extra model call.
- The Corrections entry replaces "pending a re-run" with these outcomes.

### 2026-10-03: Wave 8 and Foundations 1 re-pin update

[`6eefe68`](https://github.com/garrytan/gbrain-evals/commit/6eefe68). A new "Update, October 3" block for gbrain `109b992` says fix wave 8 and Foundations 1 change no category's accuracy: 30 of 30 categories reach the same verdicts and all 27 ledger repros pass. It lists what the nine new checks show: unpriced models refused under a user cap, `gbrain import` of an ignored folder (3 of 3, was 0) and typed edges at 128 right and 43 wrong (was 125 and 52). It also reports one regression, a timeline read going from 0.05 ms to 0.10 ms on 1,000 pages.

### 2026-10-03: Re-pin to gbrain `109b992`

[`f321afb`](https://github.com/garrytan/gbrain-evals/commit/f321afb). The installed-pin sentence moves from `48ed5e8` (v0.60.32.0) to `109b992` (v0.60.37.0, fix wave 8 plus Foundations 1). The System One sentence is reworded from "That release adds" to "Its System One decision slots stay off".

### 2026-10-03: Fix wave 7 rerun update

[`5e46ca0`](https://github.com/garrytan/gbrain-evals/commit/5e46ca0). A new "Update, October 3" block reports gbrain `48ed5e8` closing eight more ledger gaps. The N2 contradiction judge (prompt v4) found 149 of 150 conflicts (was 132), but it called 6 of 51 compatible pairs contradictions, above the 10% limit, so the page drops the word "separates". The block also covers N7 open loops, N9 one-hop seeds (unresolved fell from 45 to 6 of 435), N12 `Participants:` lines (5 of 5, was 0) and A4 grades (all 120 unanswerable now `weak`).

### 2026-10-02: Re-pin to gbrain `48ed5e8`

[`c8350c5`](https://github.com/garrytan/gbrain-evals/commit/c8350c5). The installed-pin sentence moves from `d44296c` (v0.60.30.0) to `48ed5e8` (v0.60.32.0, fix wave 7). Mode bundles are unchanged.

### 2026-10-02: Concept-search claim rewritten around a matched reranked comparison

[`522c860`](https://github.com/garrytan/gbrain-evals/commit/522c860). The concept-search paragraph had said vector search with a reranker was untested. It now reports that run at gbrain `d44296c`: vector search with the same Voyage reranker scored 128/181 against gbrain's 130/181, with 8 wins and 10 losses for gbrain, so the two are level. The unreranked gbrain cell moves from 102 to 99 of 181, and the reranker's gain is now +40/−9 (was +37/−9). The advice changes to "rerank both" when comparing with a vector store. The September 9 cells (102, 118, 130) stay linked as older-pin history.

### 2026-10-02: Sealed v2 release decision for `auto` evidence delivery

[`2eebf81`](https://github.com/garrytan/gbrain-evals/commit/2eebf81), gbrain-evals v0.10.8. The evidence-delivery paragraph adds the first preregistered decision on the harder sealed v2 set (200 questions, histories of about 143,000 tokens). At gbrain `d44296c`, `auto` with a 24,000-token budget answered 192 of 200 against 132 for chunks (+60/−0, 95% interval +24 to +36 points), so the check passed. The cost is about four times the reader input.

### 2026-10-02: All 20 October 1 bugs verified fixed

[`bd8e44b`](https://github.com/garrytan/gbrain-evals/commit/bd8e44b). A new "Update, October 2" block reports the rerun at gbrain `d44296c` with the same runners and seeds. N1 current-value accuracy went from 288/388 to 388/388, N5 prohibited outputs from 2 to 0, N8 private-page leaks to 0, and N12 now gates CI. The N2 judge found 132 of 150 conflicts, and false contradictions fell from 109 to 26. N9 multi-hop planning is still open, and A4 was not rerun.

### 2026-10-02: Re-pin to gbrain `d44296c`

[`adffe95`](https://github.com/garrytan/gbrain-evals/commit/adffe95). The installed-pin sentence moves from `3a284ae` (v0.60.26.0) to `d44296c` (v0.60.30.0), which contains fix waves 5 and 6. Mode bundles are unchanged.

### 2026-10-01: October 1 category wave results

[`f94e98d`](https://github.com/garrytan/gbrain-evals/commit/f94e98d), gbrain-evals v0.10.5. A new block summarizes eleven keyless or cheap categories run at gbrain `3a284ae`. It lists where gbrain held up (N4, N6, N7 at 45/45, N12, N1, N5) and where it failed: `volunteer_context` leaked 4 private pages (N8), `ontology_propose` refusals cost 100 of 388 probes (N1), the contradiction judge found 105 of 150 (N2), and there was no multi-relation plan (N9). Of 20 bugs, 8 were in fix wave 5 and 10 were scheduled for wave 6. The installed pin moves from `6c8373c` (v0.60.13.0) to `3a284ae` (v0.60.26.0), with a note that its System One slots stay off without a TypeSafe key.

### 2026-10-01: New section on System One (Jev)

[`b13b219`](https://github.com/garrytan/gbrain-evals/commit/b13b219), gbrain-evals v0.10.4. A new "Where a small decision model helps" section reports matched pairs for nine Jev (`jev-1.13.0`) decision slots. Jev helped dream triage (0 of 18 buried items missed, against 10, but 57 of 109 transcripts sent to the page writer instead of 21) and contradiction proposals (94 of 97 updated facts, against none). Reranking, evidence trimming and abstention regressed, so `gbrain decide enable --recommended` turns on two slots only. The "What should you learn here?" table gains a System One row.

### 2026-09-30: Evidence delivery and reranker-on answer accuracy

[`1ec19a2`](https://github.com/garrytan/gbrain-evals/commit/1ec19a2), gbrain-evals v0.10.2. The answer-accuracy paragraph adds two reranker-on results: the notes reader at 453/500 (90.6%, +31/−17, p = 0.059), and the published configuration without the leak at 432/500 against the invalid 433/500 (+15/−16). A new evidence-delivery block reports that whole pages answered 361 of 400 held-out questions against 253 for chunks (p = 6e-27). Neighbor chunks closed only 30% to 36% of the gap, short of the preregistered 60%. The block also reports that the `auto` v2 release check failed on the sealed set (149 against 147 of 150). The Corrections entry and pin follow suit: `608a174` becomes "the previous pin" and the installed pin moves to `6c8373c` (v0.60.13.0).

### 2026-09-29: "Where gbrain stands" comparison and a Corrections section

[`88d0b19`](https://github.com/garrytan/gbrain-evals/commit/88d0b19), gbrain-evals v0.10.1. This release reworked the page after the September 28 audit:

- A new "Where gbrain stands" section adds a strict `recall_all@5` table. gbrain shows 449/470 with the reranker and 439/470 without. Other systems, from our strict recounts of saved rankings, show 423/470, 376/424 and 403/470, and one self-reports 411/470. Limits and an answer-accuracy paragraph follow; the paragraph gives the leak-free 439/500 (87.8%) and says we claim no answer ranking.
- The 433/500 claim is marked invalid because the answer model saw `answer_` session ids. A new paragraph shows full sessions beat chunks (89/100 against 65/100).
- The concept claim now states that gbrain without a reranker (102/181) trails vector search (118/181). The relationship claim widens to 145 questions (first-place hits 14% to 24%) and adds the paraphrase check: 0.411 in both arms at `b80cad6`, and 33 of 145 triggered at `608a174`.
- The write-side paragraph adds evidence-verified retention (58.2% to 74.9%) and an in-sample caveat. A new Corrections section lists the invalid or overstated numbers, including the 49.1% `graph-oracle-parse` row and the May calibration result.
- The pin text now separates the measured pin `2efaaf8f` (v0.48.4.0) from the installed `608a174` (v0.60.10.0), and a lifecycle row joins the table.

### 2026-09-26: Reading-notes study added

[`b439f12`](https://github.com/garrytan/gbrain-evals/commit/b439f12), gbrain-evals v0.10.0. A new shortlist paragraph reports the September 24 matched reading study: brief notes before answering raised judged correct answers from 308/361 to 324/361 on fixed retrieved sessions. It is labeled as answer reading, not a retrieval gain. The pinned gbrain link moves from `2efaaf8f` to `939232f1`.

### 2026-09-09: Rewritten as a guide to retrieval evidence

[`9238ec8`](https://github.com/garrytan/gbrain-evals/commit/9238ec8), gbrain-evals v0.8.0. The page was rewritten from scratch, removing 258 lines. Gone are the "beats the field" head-to-head table, the "three things nobody else does" list, the PrecisionMemBench section, the area table, the corpus and layout sections and the per-benchmark run commands. The new page opens with the different kinds of retrieval problem and points to `docs/retrieval-lessons.md`, `docs/settings.md` and `docs/README.md`. A "Why put gbrain on your shortlist?" section makes five evidence-linked claims: 449/470 (95.53%) LongMemEval strict retrieval with 433/500 answers, 130/181 against 118/181 on concept questions, investor first-place hits from 9/39 to 21/39, trimming off raising retrieval from 379/470 to 449/470, and an inspectable pipeline pinned at gbrain `2efaaf8f`. The rest is a question-to-document table, a keyless `grep-only` quick experiment, a write-side summary (70.2% to 88.1% retention, 7.0% hallucination) and an "Inspect or extend" section.

### 2026-09-02: LongMemEval rows updated for the v0.48.2.0 re-run

[`4ceb7f9`](https://github.com/garrytan/gbrain-evals/commit/4ceb7f9), gbrain-evals v0.6.1. Both LongMemEval rows replace 83.4% with the September 2 re-run on the cleaned Sept-2025 revision: 93.19% `recall_all@5` reranker off (438/470) and 95.32% with `voyage:rerank-2.5` (448/470), plus per-type figures. The comparison cell now uses our strict recounts of another system's saved rankings (85.7% raw, 90.0% with LLM rerank) and a third system's self-reported 87.45%. The run commands switch to the cleaned dataset URL, `VOYAGE_API_KEY` and the five published arms. Several cells drop their "first run scored 61.5%" and audit narrative in favor of present-tense statements, and the "benchmarks that bite back" bullet now names the committed gates.

### 2026-09-01: Outside-review remediation and claim hygiene

[`29e9ac9`](https://github.com/garrytan/gbrain-evals/commit/29e9ac9), gbrain-evals v0.6.0. The LongMemEval head-to-head row now says these are retrieval-component numbers, not QA accuracy. It records another system's 96.6% as any-hit and adds a third system's self-reported 84.3% and 87.45% All@5, so it claims no `recall_all` lead. Cat 35 leakage changes from "zero" to 1.2% (1/86), and the Cat 34 rows gain links to committed receipts and the 0.552 codex seam. The PrecisionMemBench 0.582 becomes an upper bound (the best hosted product now 0.22 upstream), the default precision moves from 0.076 to 0.075, and the relational 97.9%/49.1% row is flagged as pre-audit.

### 2026-09-01: LongMemEval erratum resolved at 83.4%

[`91d2af8`](https://github.com/garrytan/gbrain-evals/commit/91d2af8), gbrain-evals v0.5.1. Both LongMemEval rows replace "re-measurement pending" with the official `recall_all@5` of 83.4% (n=470), recomputed at $0 from the May run's raw rows. The rows keep 97.6% any-hit as a diagnostic (488/500) and name multi-session (71.9%) and temporal (69.3%) as the source of the loss.

### 2026-08-31: Eval audit and the head-to-head section

[`bd5ba0d`](https://github.com/garrytan/gbrain-evals/commit/bd5ba0d), gbrain-evals v0.5.0 (per `CHANGELOG.md`; the commit subject says BrainBench v0.3.0). A new "Where gbrain beats the field" table compares five arenas (LongMemEval 97.6%, Cat 35 88.1%, Cat 34, PrecisionMemBench 0.582 against a hosted product's 0.43, relational 49.1% P@5). A "three things nobody else does" list cites the 35-agent audit (239 findings, 236 fixed). "Where gbrain lands today" is renamed "The numbers, report by report", and the LongMemEval row gains an any-hit erratum. The page now describes what CI actually runs and adds a keys note for `eval:run` (`OPENAI_API_KEY`, about $2 first run), `--top-k 5` in the commands and the exact-SHA pin in reproduce steps.

### 2026-08-31: Cat 35 republished at 88.1% and Cat 34 row added

[`d101b01`](https://github.com/garrytan/gbrain-evals/commit/d101b01), gbrain-evals v0.4.0. The Cat 35 row moves from 61.5% to 88.1% salient-unit recall with all 20 sessions emitting, after the gbrain v0.47.8.0 fix wave (hallucination halved to 7%, quote fidelity 45% to 83%). A new Cat 34 memory-conformance row reports 0 know-to-ask failures, push precision 1.0 and recall 0.91 across 149 gold turns.

### 2026-08-30: Cat 35 transcript distillation added

[`d5b94c7`](https://github.com/garrytan/gbrain-evals/commit/d5b94c7), gbrain-evals v0.3.0. The results table gains a Cat 35 row (61.5% salient-unit recall, 85% usable, 0% noise leakage, against a 93.1% judge ceiling). The corpora list adds the 24 fictional agent sessions (173 salient units, 86 distractors). The layout gains `generators/` and `scripts/`, and a note explains that Cat 35 deep-imports `gbrain/src` internals, which is why the dependency is pinned to an exact SHA.

### 2026-06-03: Plain-English rewrite and SkillOpt result

[`565b807`](https://github.com/garrytan/gbrain-evals/commit/565b807). The page was rewritten in plain English as "the test suite for gbrain". It gained a "How these benchmarks work" explainer (corpus, sealed answers, score; recall and precision) and a "Where gbrain lands today" table with a plain-English column. The table adds a SkillOpt row (4/4 skills 0 to 1.00). A "We report the bad numbers too" section frames the PrecisionMemBench 0.076 default. The Cat catalog becomes an area table, and the corpus, layout and contributing sections are simplified.

### 2026-05-30: Streamlined around LongMemEval and PrecisionMemBench added

[`8fa09ff`](https://github.com/garrytan/gbrain-evals/commit/8fa09ff), gbrain-evals v0.2.0. A "Headline result" quote puts LongMemEval 97.60% R@5 against another system's 96.6% at the top, and the results table adds PrecisionMemBench (#2, 0.582 precision with the opt-in gate). A new PrecisionMemBench section reports the 0.076 default, the 0.582 adaptive result and the narrow-probe caveat, with run commands. The page drops the Cat 2 catalog row, the paid `eval:brainbench` commands and the design-doc section, condenses the layout and contributing sections, and lists `VERSION` and `CHANGELOG.md`.

### 2026-05-24: v0.40.6.0 snapshot headline

[`9ecc5b2`](https://github.com/garrytan/gbrain-evals/commit/9ecc5b2). "Latest results" now leads with the gbrain v0.40.6.0 comprehensive snapshot and three headline claims: LongMemEval 97.60% R@5 against another system's 96.6%, BrainBench 49.1% P@5 (38 points over vector RAG), and zero retrieval regression across 20 releases. The table gains snapshot and Cat 14+15 calibration rows, and one comparator is removed from the comparison mentions.

### 2026-05-07: LongMemEval result and public-benchmark family

[`c2d26e6`](https://github.com/garrytan/gbrain-evals/commit/c2d26e6). The intro now covers two families, BrainBench and public benchmarks. A "Latest results" section leads with LongMemEval `_s` at 97.60% R@5 (+1.0 point over another system's raw retrieval) and a dated table of reports. The quickstart splits into LongMemEval (dataset download, keys, batch runner, about $2 first run) and BrainBench. A "Public benchmarks" table lists the LongMemEval splits, ConvoMem and LoCoMo, and the layout adds the LongMemEval runner files, the embed cache and `docs/comparison-systems.md`.

### 2026-04-23: Adapters renamed to plain English

[`8dab7f7`](https://github.com/garrytan/gbrain-evals/commit/8dab7f7). Adapter names in the intro, layout and subpath list change: `ripgrep-bm25` becomes `grep-only`, `vector-only` becomes `vector` and `hybrid-nograph` becomes `vector-grep-rrf-fusion`.

### 2026-04-21: Created with the BrainBench v1 extraction

[`5bd8848`](https://github.com/garrytan/gbrain-evals/commit/5bd8848). The first README presented BrainBench as a benchmark for personal knowledge agent stacks. It scored four adapters on a 240-page fictional corpus, with a headline of gbrain P@5 49.1% and R@5 97.9% (+31.4 points over its graph-disabled variant). It covered why the repo is separate from gbrain, a quickstart, the Cat 1 to 12 catalog with thresholds, the world-v1 and amara-life-v1 corpora, the repo layout, three contributor paths, methodology, the license and the `gbrain/*` subpath exports it consumes.
