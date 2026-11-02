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
| Pinned product | gbrain [`ca1281a2e`](https://github.com/garrytan/gbrain/tree/ca1281a2ed3236ac45adddb2d08e84423769c321), release v0.60.542.0, declared as `gbrain` in `package.json` |
| Fixed-purpose aliases | `gbrain-cues` (`939232f`) and `gbrain-reader` (`e78f1c3`), used only by the experiments that name them |
| This repository | gbrain-evals at the release [`VERSION`](VERSION) names; [CHANGELOG.md](CHANGELOG.md) records each release |

This repository installs gbrain v0.60.542.0 (`ca1281a2e`). Some results below were measured at earlier commits; each
names its commit, and every commit named below is in the release's history except three pull-request builds:
`a7cb37b`, the September 29 branch commit whose retrieval the reader replay row froze; `94bd52e01`, the multi-relation
planner's held-out build (merged in v0.60.60.0); and `079941d2`, Cat 35's post-wave build (shipped as v0.47.8.0). The
search modes held the same values from v0.48.4.0 through
v0.60.169.0. Since then the default reranker became Voyage `rerank-3-lite` (was `rerank-2.5`, v0.60.223.0),
`tokenmax` stopped expanding queries (v0.60.250.0), and every mode turned on result-time collapse and rank priors
(`search.collapse`, `search.rank_priors`, v0.60.332.0): same-slug twins in other sources, merge stubs and copies of
one document fold into one result row, and organization, OCR and date priors adjust the ranking after the reranker. On
300 LongMemEval-S questions the reranker and expansion changes each kept retrieval within their preregistered margins
([reranker addendum](docs/benchmarks/2026-10-13-rerank3-addendum-preregistration.md),
[expansion latency](docs/benchmarks/2026-10-14-expansion-latency-preregistration.md)); collapse and rank priors have no
such check here. Retrieval results measured before v0.60.223.0 used `rerank-2.5`, and results measured before
v0.60.332.0 ran without collapse or rank priors.

Five read defaults outside the mode bundles changed after v0.60.454.0. A `query` with a token budget leads with up to 40 dated saved facts (`search.query_facts_block`, v0.60.491.0). `search` puts a newer correction
ahead of the saved fact it corrects (`search.saved_facts_supersede`, v0.60.493.0). A remote `search` or `query` that
names no `limit` keeps every page that matched its words but at most 3 pages that matched only by meaning
(`search.remote_page_cap`, v0.60.506.0). Text from conversation, chat, email and meeting pages comes back inside a quote
fence, marked as source material, from `search`, `query`, `assemble_evidence` and `think`, and over MCP from `get_page`,
`fetch`, `recall`, `delta` facts and hot memory (v0.60.507.0, v0.60.521.0). Since v0.60.536.0 a remote reader, such as
an agent over MCP, also gets any text below the owner's own notes in that fence: text an agent wrote, tool data,
external text and text with no recorded origin, on search, recall, page, chunk, timeline, version and write-receipt
reads, and from v0.60.538.0 to v0.60.541.0 on chronicle and takes reads, timeline sources, ontology values and a quoted
page's title, tags and frontmatter. Local reads are unchanged, no setting turns either fence off, and `gbrain trust
claim-sources` with `gbrain trust backfill` marks an owner's older notes as theirs. Apart from the keyless Cats 37 to
39 check in the memory trust row, no result on this page was measured with these defaults. The memory-qa harness holds
the first three at their old values and unwraps the fence on its `query` path, which reads locally
([`eval/runner/gbrain-under-test.ts`](eval/runner/gbrain-under-test.ts)). Arms that run the pinned gbrain with its own
defaults (the shootout, the Cat 40 MCP arm and the agent tool bridges) take all five as shipped. The scoreboard's
gbrain-defaults container builds its own gbrain, `f05943e6` (v0.60.138.0), so it runs none of them.

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
| A newer reader on the same retrieval (`claude-opus-5-5`, frozen 2026-09-29 retrieval, official `gpt-4o` judge) | **474 of 500 (94.8%)**, higher than the replayed Sonnet 4.6 run's 451 (Holm p = 0.0006). The preregistered test compares each reader with Sonnet 4.6 only, so it does not rank the newer readers against each other | `a7cb37b` retrieval | [Reader replay](docs/benchmarks/2026-10-07-longmemeval-w10b-reader-replay.md) |
| Whole-conversation delivery against bare chunks, sealed held-out set | **192 vs 132 of 200** (+60/−0) | `d44296c` | [Sealed decision](docs/benchmarks/2026-10-02-sealed-v2-decision-1.md) |
| Concept questions in different words, target ranked first (with reranker) | **130 of 181** | `d44296c` | [Matched comparison](docs/benchmarks/2026-10-02-concept-vector-rerank.md) |
| Relationship retrieval on reworded one-hop questions, recall at five | **0.411 → 0.537**, 19 better, 0 worse | `3a284ae` | [N9](docs/benchmarks/2026-10-01-n9-multi-hop.md) |
| Questions chaining two or three relations (multi-relation planner) | **24 better, 0 worse** held-out; +27 points strict all-hit@10 | `94bd52e01` (shipped in v0.60.60.0) | [Held-out program](docs/benchmarks/2026-10-05-heldout-program.md) |
| Meeting attendance from a documented `## Attendees` list | **132 of 132** attendees stored, 0 false; "who attended" recall at five 32% → 80% | `c5fb0201` | [Attendance world](docs/benchmarks/2026-10-06-attendance-world.md) |
| Answers on 72 BEAM conversations, question-ranked facts plus pages at 8,000 tokens, against a memory-bank server at the same budget | **70.5 vs 66.5** points (+4.0, lower bound +2.6, ahead at the 3.5-point margin); 0.75× its cost per correct answer at 20 reads | `71b6d85` (gbrain #6445) | [Wave 2 results](docs/benchmarks/2026-10-13-memory-proof-wave-2-results.md) |
| A query that quotes a saved turn word for word (LongMemEval-S, 500 questions) | **500 of 500** return the conversation as a clean read (was 429; the rest lacked a rerank score or lost a search arm); strict recall@10 unchanged at 496 | `fecc7827` (#6391, merged as `f05943e65`) | [Verbatim probe](docs/benchmarks/2026-10-09-verbatim-probe-preregistration.md) |
| Vector search inside a 10% source or visibility scope, 1M to 2M chunks on Postgres | recall@50 **0.96 to 0.99** (was 0.52 to 0.77); a topic-coherent 10% source scope still reaches only 0.78 | `2e84d234e` (#6380) | [Scoped vector search](docs/benchmarks/2026-10-09-hnsw-scale.md) |
| Returning only the right facts (PrecisionMemBench, tight adaptive + reranker) | **0.586 precision**, 0.825 recall | `2efaaf8f` | [Refresh](docs/benchmarks/2026-09-09-retrieval-refresh.md) |
| Serving the new value after an update | **388 of 388** probes, never stale, on PGLite and Postgres through the CLI and MCP | `77cf8e111` | [N1](docs/benchmarks/2026-10-01-n1-knowledge-update.md), [re-pin](docs/benchmarks/2026-10-11-wave14-repin.md) |
| Nothing left behind after `forget` | **0** prohibited outputs, 6 of 6 reinstatements | `77cf8e111` | [N5](docs/benchmarks/2026-10-01-n5-forget-residue.md), [re-pin](docs/benchmarks/2026-10-11-wave14-repin.md) |
| Private pages reaching agent callers or remote callers | **0**, in process and on Postgres over real HTTP (155 of 155 cells, 5 kinds of caller); proactive recall gated in CI | `77cf8e111` | [N6 on Postgres](docs/benchmarks/2026-10-06-n6-postgres-http.md), [N8 gate](docs/benchmarks/2026-10-06-n8-privacy-gate.md), [re-pin](docs/benchmarks/2026-10-11-wave14-repin.md) |
| An attacker's false claim from an email or a relayed tool result, adopted in a later session (Opus 5.5, Sonnet 5.5, GPT-6.1 Sol) | **1.5% to 5%** of sessions with trust labels shown, 5.1% to 10.6% with them stripped; **0 of 360** instruction-worded injections followed per model; Cats 37 to 39 pass every keyless contract at the pin | `c2f10ee8` to `5b9c814b` (shipped as `d4dc2d4d8`); keyless at `ca1281a2e` | [Memory trust](docs/benchmarks/2026-10-08-memory-trust-results-paid.md), [re-pin](docs/benchmarks/2026-10-11-wave14-repin.md) |
| Keeping speaker and time across chat export formats | **29 of 29** formats | `77cf8e111` | [N12](docs/benchmarks/2026-10-01-n12-format-fidelity.md), [re-pin](docs/benchmarks/2026-10-11-wave14-repin.md) |
| One very large document stored as one page (2 MB to 260 MiB, counted under the preregistered rules) | **Every preregistered rule passes**: 0 crashes, 0 responses over 1 MiB, 0 bytes lost on export, keyword recall@10 1.00 at 2 MB and no recall gap to managed parts up to 24 MiB. PGLite stores up to 128 MiB, Postgres stored up to 256 MiB, and `put_page` refuses anything above 24 MiB; larger documents are refused (`request_too_large`), not stored. `forget` on pages over 24 MiB is still unreachable (`request_too_large` at 100 MiB and above) | `7a6bdd3` (v0.60.454.0, the previous pin) | [N14 Wave B PR 4](docs/benchmarks/2026-10-25-n14-large-page-fidelity-wave-b4.md) |
| Finding contradicting notes | **146 of 150** conflicts with the default judge model (`claude-haiku-4-5`), 0 of 40 dated changes and 4 of 51 compatible pairs flagged; 149 at `48ed5e8` with the same prompt, the difference is sampling | `77cf8e111` | [N2](docs/benchmarks/2026-10-01-n2-contradiction-surfacing.md), [re-pin](docs/benchmarks/2026-10-11-wave14-repin.md#the-paid-n2-judge-arm) |
| Contradiction judge on current models | **150 of 150** conflicts and **0 of 251** compatible pairs flagged, for each of four current models (Opus 5.5 the top Anthropic one); cheapest passing model $0.21 per 1,000 pairs | `c5fb0201` | [N2 judges](docs/benchmarks/2026-10-06-n2-judges.md) |
| Attributing someone else's claim to the page holder (takes classifier) | **0 of 123** cases on Sonnet 5.5, GPT-6.1 Sol and Opus 5.5 (3 with Claude Haiku 4.5); the classifier is not yet graduated | `c5fb0201` | [Takes-bootstrap](docs/benchmarks/2026-10-06-takes-bootstrap-frontier.md) |
| Real agents (Claude Code, Codex) spending or destroying data without consent | **0** violations in 66 safety sessions; 96 of 102 tasks finished | `b3f4e8b` (shipped in v0.60.46.0) | [Cat 41](docs/benchmarks/2026-10-03-agent-operator.md) |
| Hard company questions answered by agents, against plain files with `grep` (Cat 40 Hard confirmation: two 50,000-document worlds, Opus 5.5, Sonnet 5.5, GPT-6.1 Sol, reranking verified in every gbrain slot) | gbrain ahead by **+7.7 points** (95% CI +2.7 to +12.7) on a fresh world and **+13.0** (+7.7 to +18.3) on a sealed one, for every model; behind on the fresh world's conflicting-source family (47 against 56 of 60) | `3e4ff61ce` (shipped as v0.60.174.0, `0df9f2ee7`) | [Cat 40 Hard confirmation](docs/benchmarks/2026-10-10-model-ladder-hard-confirmation.md) |
| Hard company questions after the Cat 40 next wave (four new 50,000-document worlds, two generators; Opus 5.5, Sonnet 5.5, GPT-6.1 Sol) | What ships, Part 1 without F5: gbrain ahead of plain files by **+10.67 points** (95% CI +7.00 to +14.50) on two sealed worlds. The pre-wave baseline is also ahead: **+8.50** (+4.83 to +12.33) on two public worlds and **+11.83** (+8.00 to +15.83) on the sealed ones. Against that baseline, the shipped configuration is level on sealed (−1.17, −4.33 to +2.00) and was level with control in development. The public build with F5 measured +12.50 (+9.17 to +15.83) against files and +4.00 against the baseline. That build is **not shipped (F5 failed its precision ship condition)**, and its gain came from F5 | `4e10136b4` (F5 off on sealed), baseline `09d21554d` | [Cat 40 next-wave confirmation](docs/benchmarks/2026-10-15-cat40-next-confirm/README.md) |
| Finance-only text reaching an agent's context in permission runs (Cat 40, five frontier models) | **0 of 100** (plain files 100, plain Postgres 97 with 4 leaked answers) | `51f865d78` | [Cat 40](docs/benchmarks/2026-10-02-model-ladder.md) |
| Timeline events extracted from meetings and chats | **37 and 38 of 38**, 0.04 wrong per page | `b9ee931` | [`auto_chronicle`](docs/benchmarks/2026-10-04-auto-chronicle-rerun.md) |
| Managed Postgres catch-up 57 ms from the database (10,000-file backlog) | **367.9 pages/min** steady, **33.6 min** for the backlog (was 174.8 pages/min and 74.5 min on the same rig); a page save 2.5 s instead of 8.6 s | `0ba3b1f7c` (#6279, merged as `9d013e52d`, v0.60.111.0) | [Lanes and foreground](docs/benchmarks/2026-10-07-managed-sync-lanes-foreground.md) |
| A managed Postgres catch-up when one write cannot finish preparing (15,000 entries, heavy fact adoption, 57 ms, transaction-mode pooler) | Drains in **2 passes (91 min, pool 10)** and 3 passes (pool 3), with **0** failed fence receipts and **0** watchdog stops; v0.60.105.0 never drained (102 pages in 47.6 min). A stuck write is held in **240 s**; a table lock still pins 9 of 10 connections | `846bea442` (15,000 entries) and `a99c00565` (table lock), heads of #6298, merged as `b65d4bae7` (v0.60.112.0) | [Preparation stall](docs/benchmarks/2026-10-08-managed-sync-preparation-stall.md) |
| A managed Postgres sync behind a transaction-mode pooler whose round trip never completes | Wedges with **one process and no lanes** (backend `ClientRead`, consumer parked 135 s, zero commits) on v0.60.110.0 and on #6298's head; **0 wedges in 2 h 49 min** of the two-consumer shape (4,951 pages); gbrain's fix, the bounded settle in v0.60.114.0, was not measured here | `1935c74a` (v0.60.110.0) | [ClientRead wedge](docs/benchmarks/2026-10-08-managed-sync-clientread-wedge.md) |
| A single-file commit becoming searchable through a running `gbrain serve` with `sync.on_commit` on (10,000 synthetic pages, local database, 4 vCPUs) | **0.60 s** p50 (p95 0.61 s, n = 40) on Postgres in watch mode, was 3.7 s managed and never on classic sources; poll mode 2.15 s p50, p95 3.20 s; vector for hybrid search 0.3 s later on managed, about 6 s later on classic; after a 30 s embedding outage PGLite left about 3% of a 1,000-chunk backlog unembedded | `4ba4c36f` (v0.60.316.0, #7079) | [Sync freshness](docs/benchmarks/2026-10-19-sync-freshness.md) |
| The first managed sync after activating a classic brain already synced to HEAD (synthetic pages, local database, 4 vCPUs) | Converges in **1 pass** on every run: Postgres 10,000 pages 13.2 s p50 (n = 3, 2,487 statements), PGLite 10,000 pages 12.9 s (n = 3), Postgres 100,000 pages **129.6 s** (n = 1, 23,243 statements). v0.60.316.0 took 1.6 s, 1.8 s and 7.1 s but compared no files, because its commit replay range was empty | `426c4ef5` (#7053's head, merged as `c9f309f3`, v0.60.320.0) | [Sync freshness](docs/benchmarks/2026-10-19-sync-freshness.md#first-managed-sync-after-activating-a-classic-brain-gbrain-v0603200-6712-pr-4b) |
| Malformed facts/takes tables repaired by a model without a wrong cell (held-out set, model tier only) | **96.0%** repaired, **0** wrong cells (gpt-6.1-sol and claude-opus-5-5, the measured defaults); every other case held | v0.60.102.0 ([`5b58910`](https://github.com/garrytan/gbrain/commit/5b5891069)) | [Fence repair Tier 3](docs/benchmarks/2026-10-06-fence-repair-tier3.md) |
| A file whose frontmatter `slug:` names another page: duplicate to merge, stray line to delete, or a case for a person (model judgment) | **0** harmful answers in 432 pair runs (no duplicate split, no merge of two different things); true duplicates recognised **92.0%** (Opus 5.5), 85.3% (gpt-6.1-sol), 80.0% (Sonnet 5.5), the rest deferred to a person | gbrain #6377 (`ac6e0868`) | [Slug-conflict judgment](docs/benchmarks/2026-10-09-content-repair-judgment.md) |
| A forecasting take graded by a model, among verdicts confident enough to apply (≥ 0.95) | **0** wrong in 496 applied verdicts by gpt-6.1-sol (upper bound 0.6%, bar 1%), which resolved 99.2% of resolvable takes and held back on all 250 unresolvable ones; Opus 5.5 and Sonnet 5.5 rarely reach 0.95 (2 and 121 applied, Sonnet 1 wrong) | gbrain #6882 (`d99b84694`) | [Take grading](docs/benchmarks/2026-10-16-take-grading.md) |
| A forecast journal over synthetic holders of known skill (private, trusted local only) | Shrunk accuracy ranks holders in their true order, median Spearman ρ **0.905** (bar 0.80); who-was-right set-F1 **1.000**; every open, overdue and undated prediction counted exactly; **8/8** remote probes see none of it | gbrain #6886 (`65ed40ec6`), v0.60.286.0 | [Forecast journal](docs/benchmarks/2026-10-17-forecast-journal.md) |
| Graph walks (`traverseGraph`, `traversePathsDetailed`) on fictional graphs of 10,000 to 1,000,000 pages: Postgres with breadth-first walks against HydraDB as the walk engine | Postgres faster at every size, same answer on all 54,842 compared calls: warm p95 **1.44 s vs 6.28 s** at 100,000 pages and **3.45 s vs 6.28 s** at 1,000,000; HydraDB faster only on deep `both` walks (2.7x at depth 3); production HydraDB routing not built | gbrain #6934 (`fc1121cae58`) | [Graph backend](docs/benchmarks/2026-10-17-graph-backend.md) |
| Useful material kept when a session becomes a memory page | **88.1%** judged (judge calibration awaiting a person's review); 74.9% with quoted evidence | `079941d2` (shipped as v0.47.8.0) | [Cat 35](docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill.md) |

The correctness rows (updates, `forget`, privacy, chat formats) come from keyless checks on synthetic worlds with
generated answer keys. Their counts were last measured in full at `77cf8e111`, in the
[October 11 re-pin](docs/benchmarks/2026-10-11-wave14-repin.md); no re-pin since has rerun them in full. CI's BrainBench
offline tier runs the same checks on every pull request against the gbrain `package.json` pins, smaller (the update
and `forget` worlds on a slice, privacy in process only), and every one passed at `3ec766c40` in
[#223's checks](https://github.com/garrytan/gbrain-evals/actions/runs/41270941149), as did N14's small tiers. The 29
reproductions in the [bug ledger](docs/benchmarks/2026-10-01-wave-bugs.md) and the memory trust repros 37-1, 37-2 and
37-5 ([memory trust ledger](docs/benchmarks/2026-10-07-memory-trust-bugs.md)) last ran as a set in that October 11
re-pin, where they passed; Cat7-1 passed on the second pair of hosts, and its entry stays open under its stricter closure
rule (see known limits). Rows marked `c5fb0201` were measured in the October round at an earlier pin (the paid runs and
the attendance world).

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

The block is checked against the hash the campaign published (`bun eval/runner/scoreboard.ts check --commit
f15e73025cc38779528808e670db80909e538547`), so it changes only when the receipt is rendered again in custody. Two
numbers in its first loss bullet come from a different comparison than its first table. That bullet compares gbrain's
whole-system row, 59.0% (58.9% on all its questions), with the file agent's 68.3% on the 192 questions scored for both,
while the table's 56.3% is gbrain's 8,000-token component row. The bullet's 12.9-point detectable difference belongs to
that whole-system comparison; the 13.58 points in the opening sentence is the preregistered power check for the
component rows. The generator now names the evidence and the shared questions in each such sentence, and the next
custody render will print them.

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
required session is in the top five. gbrain was measured at `109b992`
([recount](docs/benchmarks/2026-10-04-longmemeval-opaque-followups.md)); the other rows and their sources are in
[comparisons](docs/comparison-systems.md#longmemeval-the-evidence-we-have).

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

**Retrieval or the whole history: within 7 points at a seventh of the recurring cost.** On 150 LongMemEval-S questions with the same reader, gbrain's retrieval (`c5fb0201`) answered 139 against 144 with the whole ~115,000-token history pasted in (Sonnet 5.5), and 137 against 141 (GPT-6.1 Sol). Both stay within the preregistered 7-point margin, which is not the same as equal: the gap is in questions that need several conversations. gbrain's recurring cost per question is $0.024 against $0.173 with Sonnet 5.5, plus a one-time $0.015 to index each history. [Full-context comparison](docs/benchmarks/2026-10-07-longmemeval-w10c-full-context.md). particle-1, reading the same prompts at high effort and at list price (Particle has no batch discount), answered 135 with gbrain's retrieval against 140 with the whole history, also within the margin by the preregistered test, though narrowly enough that a score test puts it just outside, at $0.0047 against $0.0275 per question ([particle-1 replay](docs/benchmarks/2026-11-01-longmemeval-particle-replay/REPORT.md)). Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1. gbrain is Garry Tan's own project. Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator. ([Disclosures](docs/disclosures.md).)

**Answer accuracy: close to the published systems that use the same reader.** With `gpt-5.4` as the reader,
gbrain's retrieval at `109b992` answers 89.4% ([opaque-id follow-ups](docs/benchmarks/2026-10-04-longmemeval-opaque-followups.md));
a temporal knowledge-graph service publishes 90.2% and a database-backed memory system 84.97% with the same reader
model. Judges, prompts and retrieval budgets differ, so this is context, not a ranking. Published results across
systems range from 81.6% to 96.1% ([sources](docs/comparison-systems.md#longmemeval-the-evidence-we-have)).

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
PrecisionMemBench table except the benchmark author's own belief store.** At `2efaaf8f` its mean precision is 0.586
([refresh](docs/benchmarks/2026-09-09-retrieval-refresh.md)), against 0.22, 0.09 and 0.06 for three hosted memory
products listed upstream; the author's belief store scores 1.00
([table](docs/comparison-systems.md#precisionmembench-returning-fewer-distractions)). Upstream rows may use different
denominators and machines.

**Memory over long conversations: ahead of a memory-bank server on BEAM, behind its earlier answers on LongMemEval-S.**
On 72 BEAM conversations (1,440 questions), gbrain's question-ranked facts-plus-pages lane (`71b6d85`) scores 70.5 against 66.5 for
a memory-bank server with background extraction, both at 8,000 tokens of context and judged jointly and blind. The gap is
+4.0 points, with a lower bound of +2.6. gbrain costs 0.75 times as much per correct answer at 20 reads per stored
conversation. On LongMemEval-S, gbrain trails that server's earlier answers by 3.25 points, but those answers were
scored on more context than the budget (p95 9,373 tokens), so the row decides nothing.
[Wave 2 results](docs/benchmarks/2026-10-13-memory-proof-wave-2-results.md).

**Concept search: level with a vector store, when both are reranked.** gbrain 130 of 181 at `d44296c`, vectors with
the same reranker 128 ([matched comparison](docs/benchmarks/2026-10-02-concept-vector-rerank.md)).

**Agent tasks: ahead of plain files on hard company questions, and safer with restricted data.** In Cat 40 Hard's
preregistered confirmation (gbrain `3e4ff61ce`, two 50,000-document worlds, a 16-turn cap, Opus 5.5, Sonnet 5.5 and
GPT-6.1 Sol, with reranking verified in every gbrain slot;
[report](docs/benchmarks/2026-10-10-model-ladder-hard-confirmation.md)), agents using gbrain answered more questions correctly than the same agents
with plain Markdown files and `grep`: +7.7 points (95% CI +2.7 to +12.7) on a fresh world and +13.0 (+7.7 to +18.3)
on a sealed one, for every model. gbrain trails files on the fresh world's conflicting-source family and gives more
confidently wrong answers. On the earlier, easier Cat 40 world, gbrain (`51f865d78`) puts finance-only text into the
agent's context in 0 of 100 permission runs; files do in 100, and plain Postgres in 97 (with 4 leaked answers)
([Cat 40](docs/benchmarks/2026-10-02-model-ladder.md)).

## Known limits

- A timeline read on a 1,000-page brain took about 0.075 ms at `77cf8e111` against 0.045 ms before the Foundations 1
  release (ledger entry Cat7-1, open; 0.075 and 0.078 ms on the two hosts measured). It has not been measured at the
  pin.
- Open loops cover Gmail only, and a commitment fulfilled by reply does not close (ledger entries N7-4 and N7-3, open).
  gbrain's open-loops guide at the pin still describes Gmail threads only and calls fulfilment by reply future work.
- There is no corpus-wide contradiction scanner. At the pin, the contradiction probe behind `find_contradictions`
  still judges pairs drawn from the top results of the queries it is given (ledger entry N2-4, open).
- Associative recall, which gbrain does not claim: `volunteer_context` delivered the needed page on 0 of 240
  indirect probes at `3a284ae` (ledger entry N8-4, open).
- Several retrieval settings were chosen on the same LongMemEval questions they are scored on; held-out
  confirmation exists for evidence delivery, not yet for the retrieval configuration.
- The head-to-head scoreboard measured gbrain `f05943e6` (v0.60.138.0); none of its gbrain rows has been rerun at the
  pin.

## Where to read next

| Question | Where to start |
|---|---|
| When do words, vectors or relationships find the right answer? | [Retrieval lessons](docs/retrieval-lessons.md) |
| Which configuration should I try? | [Settings by workload](docs/settings.md) |
| Every report, grouped by the question it answers | [Documentation index](docs/README.md) |
| How do retrieval scores differ from answer accuracy? | [What the scores mean](docs/retrieval-lessons.md#what-the-scores-mean) |
| How are new gbrain defaults decided? | [Held-out program](docs/benchmarks/2026-10-05-heldout-program.md), [decision kit](docs/decisions.md) |
| Can I reproduce a result or test my own system? | [Run the suite](eval/README.md), [contribute an adapter or a category](eval/CONTRIBUTING.md), [reproduce a scoreboard number, add a memory system or dispute a row](docs/scoreboard.md) |
| Which published numbers were later found invalid or overstated? | [Corrections](docs/corrections.md) |
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

### 2026-11-02: Re-pin to gbrain `ca1281a2e`

The pinned product moves from `3ec766c40` (v0.60.531.0) to master `ca1281a2e` (v0.60.542.0). The paragraph on read
defaults outside the mode bundles now covers five: since v0.60.536.0 a remote reader also gets text below the owner's
own notes quoted, with more read surfaces quoted through v0.60.541.0. Its claim that `search_exact`, `get_chunks` and
timeline rows return stored text no longer holds and is gone. The memory trust row's keyless check names the new pin:
Cats 37 to 39 pass their keyless contracts at `ca1281a2e` after the harness read labels and facts inside the fence. No
paid result was re-run, and every number keeps its own commit.

### 2026-11-02: The full-context paragraph carries the gbrain and OpenAI lines

The "Retrieval or the whole history" paragraph reports gbrain's result and GPT-6.1 Sol's beside particle-1's, so after
the Particle line it now carries two more from [docs/disclosures.md](docs/disclosures.md): gbrain is Garry Tan's own project. Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator. No
figure changed.

### 2026-11-01: The particle-1 sentence carries its disclosure

The particle-1 sentence in the "Retrieval or the whole history" paragraph now ends with the line from
[docs/disclosures.md](docs/disclosures.md): Y Combinator, which Garry Tan runs, is an investor in Particle. No figure
changed.

### 2026-11-01: The reader replay row no longer ranks readers

The reader replay row said "Best reader on the same retrieval" and "above Sonnet 4.6's 453 after Holm". W10b's
[preregistration](docs/benchmarks/2026-10-06-longmemeval-w10-preregistration.md) tests each reader against the replayed
Sonnet 4.6 run, one-sided with Holm across six arms, and says a pass reads "this reader scored higher than Sonnet 4.6 on
this retrieval". It never compares the newer readers with each other, so "best" was a ranking it does not support. The
row now says Opus 5.5 scored higher than Sonnet 4.6 and that the test does not rank the newer readers. The comparator
count changes from 453 to 451: 453 is Sonnet 4.6's score under gbrain's own judge wrapper in the
[2026-09-29 run](docs/benchmarks/2026-09-29-longmemeval-opaque-qa.md), while the Holm test and the row's 474 use the
official `gpt-4o` judge, under which Sonnet 4.6 scored 451.

### 2026-11-01: particle-1's two W10c rows join the full-context paragraph

The "Retrieval or the whole history" paragraph gains one sentence from the [particle-1 replay](docs/benchmarks/2026-11-01-longmemeval-particle-replay/REPORT.md): particle-1 at high effort answered 135 of the 150 W10c questions on gbrain's retrieval and 140 with the whole history, within the preregistered 7-point margin by the registered test (decision G; Tango's score test puts it just outside, p = 0.060), at $0.0047 and $0.0275 per question at list price. The plan for particle-1 adds this sentence whatever the result; the paragraph's headline and its Sonnet 5.5 and GPT-6.1 Sol numbers do not change. The report also finds that at this history size particle-1 reading the whole history costs about what Sonnet 5.5 reading gbrain's retrieval costs; whether the headline moves toward longer histories is a separate decision.

### 2026-11-01: Results name their commits; N14 row; corrections and history move out

gbrain-evals #241, the documentation refresh at the pin `3ec766c40` (v0.60.531.0).

- **Results.** Every row names the gbrain commit it was measured at: the multi-relation planner its held-out build
  `94bd52e01` (was v0.60.60.0), Cat 41 its candidate `b3f4e8b` (was v0.60.46.0), the three managed-sync rows
  `0ba3b1f7c`, `846bea442` with `a99c00565`, and `1935c74a` (were release numbers), sync freshness `4ba4c36f` (was
  v0.60.316.0), the first managed sync `426c4ef5` with its merge commit, and Cat 35 `079941d2` (was "Cat 35 run"). The
  ClientRead row says gbrain's fix in v0.60.114.0 was not measured here (was "fixed by"). A new N14 row reports
  large-page fidelity, counted at the previous pin `7a6bdd3`, where every preregistered rule passed for the first time.
  The sentence under the pin table now lists `94bd52e01` and `079941d2` beside `a7cb37b` as the commits outside the
  release's history.
- **Reruns.** The paragraph under the table said all 29 bug-ledger reproductions "pass at `77cf8e111`" and that the
  correctness rows are "rerun at every pin". No re-pin since `77cf8e111` has rerun them in full, so it now says they were
  last measured in full there, and that CI's smaller offline-tier versions passed at `3ec766c40` in #223's checks.
- **Comparisons.** Each comparison names its gbrain commit and links its report or the comparisons page: strict recall
  and the `gpt-5.4` reader (`109b992`), whole history (`c5fb0201`), PrecisionMemBench (`2efaaf8f`), BEAM wave 2
  (`71b6d85`), concept search (`d44296c`) and Cat 40 (`3e4ff61ce`, `51f865d78`). A new paragraph above the scoreboard
  block explains that its file-agent loss compares gbrain's whole-system row (59.0%) on 192 shared questions, not the
  8k row in its table (56.3%), and that its 12.9-point and 13.58-point detectable differences come from different
  comparisons. The block itself is unchanged, because its hash is published at `f15e7302`; the generator's clearer
  sentence appears at the next custody render.
- **Pin section.** It said arms that measure gbrain's own defaults take all four new read defaults; it now names those
  arms and says the scoreboard's gbrain-defaults container builds `f05943e6` and runs none of them.
- **Known limits.** The open-loops, contradiction-scanner and associative-recall lines name their ledger entries; the
  first two were checked against gbrain's source at the pin, and the third names its commit, `3a284ae`. A new line says
  the scoreboard's gbrain rows measure `f05943e6`, not the pin.
- **Moved out.** The Corrections section moved to [docs/corrections.md](docs/corrections.md), together with the
  retirement of the first Cat 40 world's success figures, which the finance row and the agent-task comparison carried;
  "Where to read next" links it. The entries of this changelog from 2026-04-21 to 2026-10-31 moved to CHANGELOG.md. The
  repository row no longer names a version (was v0.10.139), so a release stamp no longer needs an entry here.

Earlier entries, from the first README on 2026-04-21 to 2026-10-31, are in
[CHANGELOG.md](CHANGELOG.md#readmemd-changelog-2026-04-21-to-2026-10-31).
