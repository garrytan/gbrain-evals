# CEO review: open-source memory shootout plan (`docs/plans/2026-10-05-oss-memory-shootout/PLAN.md`)

Reviewer: Claude (gstack `/plan-ceo-review`, mode SELECTIVE EXPANSION, auto-decide). Date: 2026-10-05.
Inputs read: `CLAUDE.md`, the plan, `docs/comparison-systems.md`, `docs/decisions.md`, `docs/benchmarks/2026-10-05-heldout-program.md`,
`docs/benchmarks/2026-10-02-model-ladder.md` and its protocol, `docs/plans/2026-09-28-gbrain-10x/audit/coverage-and-categories.md` (sections 3 and 5),
`eval/runner/memory-qa/{run,qa,corpus}.ts`, `eval/runner/cat40/{loop,arms,gbrain-arm}.ts`, `eval/runner/decisions/splits.ts`,
`eval/decisions/splits/*.json`, `eval/runner/budget-ledger.ts`, `eval/runner/precisionmembench.ts`, `eval/runner/lifecycle-experiment.ts`.
Facts checked today: temporal-graph and extract-first source at their pinned tags, PyPI versions, agent-runtime, graph-pipeline, memory-bank and markdown-notes docs, AMB.
Dataset sizes were measured by downloading the pinned LoCoMo and LongMemEval-S files (4 characters per token).

## 1. Verdict

The plan asks the right question and its skeleton (one interface, Docker shims, preregistration, two configurations, published failures) is the right one, but as written it cannot run: its LoCoMo-all-10 and BEAM-100K-all-20 cells collide with the held-out program's sealed splits, its $1,200 cap is unenforceable because vendor containers call OpenAI outside the budget ledger, and its cost table is off by roughly 3x once temporal-graph's real default model (`gpt-5.5`) and the frontier-reader cell are priced. The fairness protocol is credible on paper but has three holes a skeptical vendor will find in an afternoon: gbrain's reader gets raw corpus sessions rehydrated by the harness while competitors get whatever text they return, Cat 40 is gbrain's home field (its tool surface was tuned on that world, used three times for gbrain decisions, and at the frontier it is at ceiling), and nothing checks that each system honored session dates or finished background ingestion before it was queried. Fix the eight critical and high items below (all are plan edits, none needs new research) and this becomes the most useful public memory comparison available; the single highest-value addition is a full-context baseline (flagged as a User Challenge), because "do I need a memory system at all" is the first question an engineer has.

## 2. Findings

Severity counts: 3 critical, 7 high, 9 medium, 6 low.

### F1. Critical: LoCoMo "all 10" and BEAM-100K "20 conversations" open the sealed splits and break custody

- **Section:** "Which categories" P1 row (PLAN.md:39); Phase 3 (PLAN.md:120).
- **Problem:** `eval/decisions/splits/locomo.json` has 3 dev and 7 sealed conversations; `beam-100k.json` has 6 dev and 14 sealed, and the 14 sealed are reserved by P4 ("preference_following and instruction_following questions on all 14 sealed conversations", `beam-100k.json:33`). The memory-qa runner refuses any non-dev split for a non-custodian (`run.ts:136`, `SEALED_SOURCE_IN_DEV`) and filters to dev conversations (`run.ts:220`). The held-out program says sealed conversations "report aggregates until they retire" (`splits.ts` header; heldout-program.md:11). Publishing per-question rows for all 10 LoCoMo conversations, as the report section promises (PLAN.md:131), would hand sealed rows to gbrain implementers while P2, P4, P5, P6 and P8 are still in progress (heldout-program.md:44-54).
- **Fix:** Replace the P1 Memory QA row's dataset cell with:
  > LoCoMo dev (3 conversations, 587 questions) and BEAM-100K dev (6 conversations, 120 questions) with public per-question rows; LoCoMo sealed (7) and BEAM-100K sealed (14) run once by the custodian under decision id `shootout-2026-10`, aggregate-only receipts, BEAM sealed cell excluding the question categories P4 reserved until P4's held-out verdict lands; LongMemEval-S (all development data) stratified 100-question subset.

  Add to Phase 4: "custodian runs the LoCoMo and BEAM-100K sealed conversations through every adapter once, logs the opening in `GBRAIN_EVALS_CUSTODY_LOG`, publishes aggregates only." The report pools dev and sealed only as aggregates (sum of per-split counts), never as rows.

### F2. Critical: the $1,200 cap cannot be enforced; vendor containers spend outside the ledger

- **Section:** "Phases and gates" cap sentence (PLAN.md:126); Architecture shim bullet (PLAN.md:104-106).
- **Problem:** The ledger only sees requests that go through the harness's own `fetch` (memory-qa `ChatClient`, Cat 40 loop) or through `MeteringProxy` (`gbrain-arm.ts:53`). The plan meters vendor calls through the proxy only for Cat 40 (PLAN.md:109). Phase 3 ingest, the largest line item (temporal-graph alone is about 122M input tokens on the LME-S subset, table below), runs inside six Python containers holding the real `OPENAI_API_KEY`. Two concrete blockers in the existing proxy: it binds `127.0.0.1` (`gbrain-arm.ts:87`), unreachable from a Docker bridge network, and it forwards the client's own `Authorization` header (`gbrain-arm.ts:97`), so every container must hold the real key. `priceRequest` also has no prices for the vendor-default models (`gpt-5-mini`, `gpt-4.1-nano`, `gpt-4o-mini`, `text-embedding-3-small`; `budget-ledger.ts:1019-1039` lists none of them), so their calls would be charged at reservation and marked unpriced.
- **Fix:** Add an architecture bullet:
  > **Every provider call is metered.** Each shim container gets `OPENAI_BASE_URL=http://<proxy>:<port>/<system>/openai/v1` and a dummy key; the metering proxy listens on the Docker bridge address, strips the client's `Authorization` header and injects the real key, and charges each request to a per-system ledger allowance. Containers have no network route except the proxy (Docker `internal` network plus the proxy as the only gateway). A shim whose SDK ignores the base URL is `blocked` in Phase 0. Before Phase 0, register list prices for every vendor-default model in `CHAT_PRICE_OVERRIDES`.

  Add a Phase 0 gate: "for each system, proxy request count and dollars equal the OpenAI project usage page for a dedicated test project key, within 2%."

### F3. Critical: the cost estimate is about 3x low and the vendor-default arm on LongMemEval-S alone exceeds the cap

- **Section:** "Phases and gates" cost column and total (PLAN.md:117-127); Risks row 1 (PLAN.md:142); fairness item 2 (PLAN.md:55-59).
- **Problem:** temporal-graph at its pin defaults to `gpt-5.5` for its main model and `gpt-4.1-nano` for small prompts (`llm_client/openai_base_client.py:34-35` at the pinned tag); the ledger prices `gpt-5.5` at $5 input / $30 output per million tokens (`budget-ledger.ts:1033`). extract-first at its pin defaults to `gpt-5-mini` (`llms/openai.py:40`), graph-pipeline ships `openai/gpt-5-mini`, memory-bank's README default is `gpt-4o-mini` and it recommends Groq `gpt-oss-20b`, markdown-notes defaults to local FastEmbed `bge-small-en-v1.5` (384 dimensions). The measured LME-S haystack is 122,418 tokens on average (61.2M tokens for 500 questions, 12.2M for the 100-question subset), and isolation per question forces re-ingest of shared sessions. Ingest estimate (raw tokens measured; per-system LLM multipliers are my estimates from each system's documented call pattern: extract-first 3x input and 15% output, graph-pipeline 2.5x and 30%, memory-bank 4x and 30%, temporal-graph 10x and 30% per its 4 to 6+ serial calls per episode; Phase 0 must replace them with measurements):

  | Benchmark | Raw tokens | temporal-graph LLM input | 4 extraction systems, matched (`gpt-4.1-mini`) | 4 extraction systems, vendor defaults | of which temporal-graph default |
  |---|---|---|---|---|---|
  | LoCoMo dev (3 conv) | 0.06M | 0.6M | $1 | $3 | $3 |
  | LoCoMo all 10 | 0.19M | 1.9M | $2 | $9 | $8 |
  | LME-S 100 questions | 12.2M | 122M | $116 | $568 | $509 |
  | LME-S 500 questions | 61.2M | 612M | $580 | $2,846 | $2,549 |
  | BEAM-100K dev (6) | 0.6M | 6M | $6 | $28 | $25 |
  | BEAM-100K all 20 | 2.0M | 20M | $19 | $93 | $83 |
  | Cat 40 world (4,036 docs) | 0.82M per build | 8.2M | $8 | $38 | $34 |

  gbrain, agent-runtime archival and markdown-notes spend only on embeddings (about $0.13 per million tokens with `text-embedding-3-large`, $0 with FastEmbed). Readers add about $4 per arm on full LoCoMo (the `gpt-4o` judge dominates), about $2.40 per arm on the LME-S subset, and the plan's "one frontier-reader cell on LoCoMo" is about $36 per system on all 1,986 questions (`gpt-6.1-sol` at $2/$10 with at least 2,000 completion tokens allowed, `qa.ts` `openaiChat`), so about $250 for seven systems. As written, Phase 3 is roughly $1,200 by itself against a $350 line.
- **Fix:** Replace fairness item 2's scope and the cost table:
  > The vendor-default configuration runs on LoCoMo, BEAM-100K dev, PrecisionMemBench and the custody set. LongMemEval-S runs the matched configuration only; temporal-graph's default `gpt-5.5` extraction would cost about $500 on the 100-question subset alone. The full 500 questions are outside this plan's cap (about $580 for the matched extraction systems) and need separate approval. The frontier-reader cell runs on a 300-question stratified LoCoMo subset and on the LME-S subset, matched configuration, fixed budget.

  New phase costs: Phase 3 about $410 (matched ingest $127, vendor-default ingest $37, readers $164, frontier cell $38, full-context baseline $43 if F10 is accepted); sealed LoCoMo/BEAM custodian cells about $85; Phase 4 custody set $60 plus authoring; Phase 5 $20; Phase 6 about $400 (F8). Total about $1,000 with about $200 headroom under $1,200. Keep the existing 50% overrun stop.

### F4. High: gbrain's reader sees raw corpus sessions rehydrated by the harness, not gbrain's output

- **Section:** fairness items 3 and 4 (PLAN.md:60-66); `MemorySystem.retrieve` (PLAN.md:101).
- **Problem:** In the current path the reader never sees gbrain's returned text. The harness maps gbrain's ranked slugs back to session ids, then builds the prompt from the benchmark's own session objects (`run.ts:374-375`, `sessById` and `packSessions`). The evidence budget is the variable that matters most: the same reader fell from 89/100 to 65/100 when given gbrain's five chunks instead of full sessions (comparison-systems.md:82). If the plan lets each adapter render its own `context` string, gbrain gets five whole raw sessions (about 11,500 tokens on LME-S) while extract-first gets terse extracted memories, and the default-budget arm measures packaging, not memory. A vendor will call this out first.
- **Fix:** Change the interface to return items, and render in one place:
  > `retrieve(namespace, question, k) -> { items: [{ text, source_ids[], timestamp?, score? }], native_tokens }`. The harness renders every system's items with one renderer and packs them with the existing `packSessions` budget logic. Two context modes, both reported: **native** (the item text the system returned; gbrain's items are the page text its read API returns, not corpus sessions) and **provenance-rehydrated** (the harness replaces items by the raw sessions behind their `source_ids`, in first-appearance order, for every system with provenance; this isolates ranking). The fixed-budget arm applies to both modes.

### F5. High: adapters are written from scratch instead of mirroring each vendor's own benchmark ingestion

- **Section:** "How each run stays fair" item 7 (PLAN.md:72-74); Architecture shim bullet.
- **Problem:** Ingestion conventions move scores by double digits (extract-first's LoCoMo runs store each speaker's turns as that speaker's memories; markdown-notes's pinned release line reports its own LoCoMo retrieval MRR; the vendor behind temporal-graph publishes a LoCoMo harness for it; memory-bank and graph-pipeline ship benchmark code and AMB providers). A from-scratch adapter invites "you held it wrong", and the one-week review window is the only defense.
- **Fix:** Add fairness item 7a:
  > Each adapter starts from the vendor's own published benchmark ingestion code where one exists (extract-first's benchmark repository, memory-bank's benchmark repository and its AMB provider, graph-pipeline's evaluation framework and AMB provider, markdown-notes's LoCoMo benchmark, the vendor's LoCoMo harness for temporal-graph), pinned by commit. The adapter README lists every deviation (reader, judge, budget, namespace scheme) and why. Where no vendor code exists the adapter says so.

### F6. High: no check that session dates were honored or that background ingestion finished before queries

- **Section:** `MemorySystem` interface (`ingestSession`, `finishIngest`, PLAN.md:99-102); Phase 0 gate (PLAN.md:117).
- **Problem:** Temporal and knowledge-update questions depend on each memory carrying the session's date, not the wall-clock time of ingest (temporal-graph `reference_time`, memory-bank retain timestamps, agent-runtime passage `created_at`, markdown-notes frontmatter dates, extract-first metadata). Several systems finish work asynchronously (memory-bank observation consolidation, graph-pipeline `run_in_background`, markdown-notes background sync and embedding). Extraction calls can fail on malformed JSON and the SDK may log and continue. Each of these silently lowers one system's score and the report would attribute it to the system's design.
- **Fix:** Add to the interface and Phase 0:
  > `ingestSession` takes `event_time` (the session date) and returns `{ items_created, errors[] }`; the receipt sums them per conversation and marks a conversation `ingest-degraded` above 1% failed sessions. `finishIngest` polls a system-specific quiescence signal (queue empty, no running pipeline) with a timeout recorded as an outcome. Phase 0 gates per system: (a) a dated probe ("what did I do on 8 May 2023") retrieves the right session, proving event time is honored or recording that the API cannot set it; (b) a canary fact ingested in namespace A is never returned from namespace B; (c) zero unexplained ingest errors on one LoCoMo conversation.

### F7. High: gbrain's "vendor default" row would silently use the matched setting, and "current master" is a moving target

- **Section:** systems table gbrain row (PLAN.md:20); fairness item 2; Phase 1 gate (PLAN.md:118).
- **Problem:** The plan's vendor default for others is "what a new install gets", but gbrain's harness path pins `text-embedding-3-large` at 1,536 dimensions, balanced mode, reranker off, autocut off (`run.ts:107`), which comparison-systems.md:28 says is not gbrain's new-install embedding default. Then gbrain gets the matched setting in both arms. The parity gate reproduces "the starting-line LoCoMo dev numbers exactly", but the starting line was measured at gbrain `6622a119e` (v0.60.48.0; heldout-program.md:19), not the repository pin `739e5cc` (v0.60.46.0), and master has since merged P1, P3 and P7 (v0.60.57 to v0.60.63).
- **Fix:** gbrain row: "pin `739e5cc` (v0.60.46.0) and master frozen at `<sha>` on the preregistration date; vendor default = what `gbrain init` produces at that commit with only `OPENAI_API_KEY` set; matched = `text-embedding-3-large` at 1,536 dimensions, reranker off." Phase 1 gate: "the new gbrain adapter, run at `6622a119e`, reproduces the starting line's LoCoMo dev retrieved session ids row for row and its answer accuracy within judge cache identity."

### F8. High: Cat 40 as planned is gbrain's home field, at ceiling, and its leak metric is unfair to systems without visibility

- **Section:** P2 row (PLAN.md:41); Phase 6 (PLAN.md:123).
- **Problem:** On the five frontier models the oracle arm scores 97.6% and gbrain and plain files both score 95.6%, with GPT-6.1 Sol at 100% (model-ladder.md:10-31). The held-out world (seed 20261003) had been used three times for gbrain decisions (model-ladder.md:44), and gbrain's MCP surface was tuned against Cat 40 in the cost wave and entity-recall wave. "Reuse the 2026-10-04 gbrain and files cells" mixes builds (`51f865d78` there versus the pin here). The leak metric rewards gbrain's `visibility: private` hiding (`gbrain-arm.ts:8`); none of the six vendors is configured to hide finance documents, so every competitor leaks by construction, and the report would present a configuration choice as a capability. Writing runs also need each system restored to its post-build state; rebuilding temporal-graph per writing cell costs about $7 in the matched configuration.
- **Fix:** Rewrite Phase 6:
  > The custodian generates a fresh Cat 40 world (new seed and template set, `model-ladder-gen.ts` custodian mode) that neither gbrain nor any vendor has seen. gbrain (pinned build), `fs` and every competitor run on it in the same run; no 2026-10-04 cells are reused. Four models, the newest of each family (Sonnet 5.5, Opus 5.5, Fable 5.1, GPT-6.1 Sol), one run each. The preregistration states that success differences are not claimed where the oracle and best arm are within 3 points (ceiling); the primary Cat 40 outcomes are cost per task, turns, finance-text leaks and success. Finance access: each system keeps finance-only documents in a separate native partition (namespace, bank, dataset, project or agent) the acting user's connection cannot read; a system with no partition gets the `fs-acl`-style filtered corpus and is labeled "harness-filtered". Each system's state is restored from a Docker volume snapshot after a writing run. extract-first's MCP server is a separate package; pin its own version.

### F9. High: the "sealed custody set" does not exist yet and has no authoring spec

- **Section:** P1 row 2 (PLAN.md:40); Phase 4 (PLAN.md:121).
- **Problem:** Benchmark `custody` was added to the runner on 2026-10-05 (commit `7ba8d75`, `corpus.ts:283-299`); no custody corpus has been used in any verdict. The plan budgets $60 to run it but no work, owner or size to build it. If the gbrain team's custodian writes it, a vendor will call it home-field data. LoCoMo's own split note says 7 clusters are too few for a primary confirmation (`locomo.json` note), so a small custody set would also be underpowered.
- **Fix:** Add Phase 4a "Custody corpus":
  > The custodian authors the corpus from a generator whose specification (conversation shape, question types matching LongMemEval's six, answer-key rules) is published in the preregistration before any system runs; at least 30 conversations and 300 questions so a cluster bootstrap has power. It runs once per adapter and configuration, publishes aggregates, then retires: the corpus and per-question rows are published after the report so vendors can rerun it. Owner: custodian. Cost: authoring about $10, run about $60.

### F10. High (User Challenge): no full-context baseline, so the report cannot answer "do I need a memory system at all"

- **Section:** "Which categories" (PLAN.md:37-43); "What the report will be able to say" (PLAN.md:129-136).
- **Problem:** LoCoMo conversations average 19,000 tokens and BEAM-100K about 100,000; both fit in current context windows, and LME-S haystacks (122,000 tokens) fit in `gpt-4.1-mini`. The one independent extract-first study in comparison-systems.md found long-context GPT-5-mini at 82.4% against extract-first's 49.0% (comparison-systems.md:52). The held-out program lists "a full-context baseline and a file-agent baseline at matched cost" as not yet done (heldout-program.md:136). Without it, every system's number lacks the reference an engineer needs.
- **Fix (not auto-applied; Garry decides):** add a "full context" arm to Memory QA: the reader gets the whole conversation (or haystack), same reader and judge. Cost about $43 (LoCoMo all 10 $8, LME-S subset $30, BEAM-100K dev $5). Optional second baseline: the existing plain Postgres full-text plus pgvector arm (`arms.ts`, `pg`) as "naive RAG", about $5.

### F11. Medium: the plan's premise that only vendor numbers exist ignores AMB

- **Section:** "The question" (PLAN.md:9-11).
- **Problem:** Vectorize's AMB (agentmemorybenchmark.ai, `vectorize-io/agent-memory-benchmark`) already runs extract-first, memory-bank, graph-pipeline, Qdrant and BM25 under one harness with fixed prompts and a Gemini judge. The repository's own audit called it "big opportunity" and "the clean route" (coverage-and-categories.md:232, 256). AMB is vendor-run (Vectorize makes memory-bank), so it does not replace this plan, but ignoring it weakens the opening claim and wastes a free cross-check.
- **Fix:** Replace PLAN.md:9-11's second sentence with: "Today the answers are each vendor's own numbers and one vendor-run shared harness (AMB, built by memory-bank's maker, Gemini reader and judge). This plan adds what neither gives: strict retrieval with provenance, ingest cost and time, a matched extraction model, an OpenAI reader and judge continuous with LongMemEval's official prompts, update and forget probes, and agent tasks." Add a Phase 0 sanity check: for each system AMB also runs, our vendor-default LoCoMo number is compared with AMB's published one, and a gap above 10 points blocks Phase 3 until explained.

### F12. Medium: ingest is nondeterministic and the plan measures it once

- **Section:** fairness item 3; Phase 3.
- **Problem:** LLM extraction varies run to run. Paired intervals over questions capture reader variance, not ingest variance, so a 3-point difference between two extraction systems may be ingest noise.
- **Fix:** "Each extraction system ingests LoCoMo dev twice (about $1 per system matched); the report gives the spread between the two ingests beside every difference and claims no difference smaller than it."

### F13. Medium: no preregistered minimum detectable difference

- **Section:** fairness item 1 (PLAN.md:52-54); "What the report will be able to say".
- **Problem:** With 100 paired LME-S questions and about 20% discordant pairs, the 95% interval half-width on a difference is about 1.96 x sqrt(0.2/100), roughly 9 points. LoCoMo dev has 3 conversation clusters. Without stating this, readers will over-read small gaps.
- **Fix:** Preregistration lists, per benchmark, the expected half-width (LME-S subset about ±9 points; LoCoMo dev question-level about ±4 points with 3 clusters disclosed; custody set computed from its size) and the sentence used for a tie: "{A} and {B} answer about as many questions; the difference is {d} points (95% CI {lo} to {hi})."

### F14. Medium: "line up with published numbers" overclaims

- **Section:** fairness item 3 (PLAN.md:60-63).
- **Problem:** Published LoCoMo numbers mostly use extract-first's J-score judge and exclude adversarial category 5; the harness uses LongMemEval's prompts with a planted-answer check (`qa.ts` `judgePromptsFor`, `repeatsTrap`). LoCoMo also has a documented 6.4% answer-key error rate (coverage-and-categories.md:217).
- **Fix:** Change to "so gbrain's rows line up with the program's starting line. Published vendor numbers use other readers, judges and category handling; the report quotes them as context and claims no ranking against them." Report LoCoMo categories 1 to 4 and category 5 separately, with the trap-repeat rate; disclose the answer-key error rate.

### F15. Medium: `update()` is an unneeded method; lifecycle-lite should use the natural user actions and measure derived-memory residue

- **Section:** `MemorySystem` interface (PLAN.md:101); P3 row (PLAN.md:42); Phase 5.
- **Problem:** "Update a fact" has no common API (extract-first has `update(memory_id)`, temporal-graph invalidates through new episodes, markdown-notes edits a note). An `update()` method forces each adapter to invent semantics. For privacy, the question engineers have is whether deleting a source conversation also removes memories derived from it (extract-first facts, temporal-graph edges, memory-bank observations). The repository already has a lifecycle runner with an independent ledger and N1/N5 scorers (`eval/runner/lifecycle/{scenario,score,n1-score,n5-score}.ts`).
- **Fix:** Drop `update()`. Lifecycle-lite: an update is a later-dated session stating the new value, ingested through `ingestSession`; `forget(namespace, source_id)` deletes a source document; the probe then checks that answers and retrieved items no longer contain the forgotten fact or anything derived from it (residue per tier, following N5's metric), plus a natural-language forget where a system offers one, reported separately. Reuse `lifecycle/scenario.ts`'s evaluator-side ledger pattern and N1/N5 scoring rather than writing a new scorer from zero.

### F16. Medium: the report does not give an engineer the numbers they choose by

- **Section:** "What the report will be able to say" (PLAN.md:129-136).
- **Problem:** A per-benchmark leaderboard does not tell an engineer which system to pick for their workload, what it costs at their volume, or what they must operate.
- **Fix:** Add:
  > A decision table, one row per system: best-fit workload (chat-history QA, agent over company documents, frequently changing facts, deletion requirements), ingest dollars and minutes per million tokens of conversation (normalized from receipts), p50 and p95 query latency, services to operate (containers, peak RAM, disk from `docker stats`), license (a copyleft license matters for hosted products), runtime, MCP availability, and the question types where it is strongest and weakest (LongMemEval's six types). A native-answer arm for systems with their own answer path (gbrain `think`, graph-pipeline graph completion, memory-bank `reflect`), reported separately from the fixed-reader arm.

### F17. Medium: retrieval for consolidating systems is structurally penalized

- **Section:** fairness item 5 (PLAN.md:67-69).
- **Problem:** extract-first merges a later fact into an earlier memory and keeps the earlier add's metadata; a temporal-graph edge can cite several episodes. Mapping returned items to sessions then loses or misorders provenance, so strict session recall is a lower bound for those systems.
- **Fix:** Add: "Returned items map to sessions in first-appearance order across `source_ids`. Systems that consolidate memories across sessions are labeled `provenance-limited`; their strict recall is a lower bound and the report says so beside the number."

### F18. Medium: public vendor-review posts need Garry's explicit approval, and the window delays every result by a week

- **Section:** fairness item 7 (PLAN.md:72-74); Phase 2; "Needs from Garry" (PLAN.md:150-153).
- **Problem:** Posting issues on six vendors' repositories under `garrytan` is a public action not listed in "Needs from Garry". The window also blocks all paid work for a week.
- **Fix:** Add to Needs: "Approval to open one public issue or discussion per vendor repository under the garrytan account." Change Phase 2/3 ordering: "During the window, the cheap public cells (LoCoMo dev, BEAM-100K dev, PrecisionMemBench; about $40) run as provisional and are shared with vendors as part of the review. LongMemEval-S, sealed, custody and Cat 40 cells run after the window. A vendor may submit one tuned configuration during the window; it runs once and is reported as `vendor-tuned` beside default and matched. A vendor that does not respond is reported as 'no response by <date>'."

### F19. Medium: vendor telemetry and key exposure

- **Section:** Architecture; Risks.
- **Problem:** extract-first at its pin sends telemetry unless `MEM0_TELEMETRY` is false (`memory/telemetry.py:14`); temporal-graph and graph-pipeline also have telemetry switches. Six third-party codebases holding the real OpenAI key is avoidable.
- **Fix:** Covered by F2's network rule plus: "Every shim sets the vendor's telemetry-off switch (recorded in the receipt); the containers hold a dummy key; the run uses a dedicated OpenAI project with a hard monthly limit equal to the cap."

### F20. Low: lead with a current reader

- **Section:** fairness item 3.
- **Problem:** CLAUDE.md "Report the models people use first". GPT-4o and GPT-4o-mini are the continuity link to the starting line, which the model rules allow, but they are not what an engineer would deploy in October 2026.
- **Fix:** "The report leads with the frontier-reader (`gpt-6.1-sol`) results where they exist (LME-S subset, LoCoMo 300-question subset) and gives the GPT-4o-family results as the link to the starting line."

### F21. Low: agent-runtime's row needs sharper labeling

- **Section:** systems table agent-runtime row (PLAN.md:24, 28-30).
- **Problem:** The legacy server repository is archived ("should not be used in production", the legacy repository's README); the pinned vendor image tag is not obviously a real tag for the App Server. Archival insert and search exercise a vector store, not agent-runtime's agent-managed memory, which is its design.
- **Fix:** "Phase 0 confirms the App Server image and tag. If an archival API exists, agent-runtime's QA rows are labeled 'archival store, not agent memory'; its agent memory is tested only in Cat 40."

### F22. Low: matched embedder is not reachable for every system

- **Section:** fairness item 2.
- **Problem:** markdown-notes supports OpenAI embeddings (`text-embedding-3-small` default for that provider; other models through `semantic_embedding_model` and the experimental LiteLLM provider); agent-runtime and memory-bank have their own defaults.
- **Fix:** Add a "matched-ness" column per system and configuration listing extraction model, embedder and dimensions actually achieved, so a partially matched row is visible.

### F23. Low: reranker policy is unstated

- **Section:** fairness item 2.
- **Problem:** gbrain (Voyage), extract-first and markdown-notes (Cohere, Jina, Voyage via LiteLLM) and temporal-graph (cross-encoder) have optional rerankers.
- **Fix:** "Matched: optional paid rerankers off for every system. Vendor default: whatever a new install does."

### F24. Low: PrecisionMemBench can reuse upstream provider adapters

- **Section:** P4 row (PLAN.md:43).
- **Problem:** Upstream PrecisionMemBench already lists rows for extract-first and for the hosted service built on temporal-graph; its provider code is the vendor-neutral reference. Return-set precision is dominated by each system's default `k`.
- **Fix:** "Start from upstream PMB's extract-first provider (pinned commit, see `eval/precisionmembench/ATTRIBUTION.md`); report each system at its default `k` and at `k = 5`."

### F25. Low: wall time for temporal-graph needs parallelism across namespaces

- **Section:** Risks row 4 (PLAN.md:145).
- **Problem:** The LME-S subset is about 4,800 temporal-graph episodes at several serial LLM calls each (temporal-graph issue #1516 documents the per-episode cost). Serially that is most of a day.
- **Fix:** "Episodes within a namespace are added in date order; namespaces run in parallel up to the provider rate limit; Phase 0 records the OpenAI tier and tokens per minute available."

## 3. Decisions

| # | Decision | Classification | Principle | Rationale |
|---|---|---|---|---|
| 1 | Run LoCoMo and BEAM-100K dev publicly; sealed conversations only through the custodian, aggregate-only; honor P4's BEAM reservation (F1) | Mechanical | 2 fix blast radius | Existing custody rules and runner guards already require it |
| 2 | Route every vendor provider call through a Docker-reachable metering proxy with key injection; register vendor-default prices (F2) | Mechanical | 1 completeness | A cap the ledger cannot see is not a cap |
| 3 | Vendor-default arm skips LongMemEval-S; full 500 questions out of cap (F3) | Taste | 3 pragmatic | temporal-graph's `gpt-5.5` default costs about $500 on the subset alone; matched arm still answers the design question |
| 4 | Frontier-reader cell on a 300-question LoCoMo subset plus the LME-S subset (F3, F20) | Taste | 3 pragmatic | $38 instead of about $250 for the same ranking check |
| 5 | Replace the cost table with the measured-token estimate (F3) | Mechanical | 5 explicit | Phase gates are meaningless with a 3x error |
| 6 | Interface returns items; one harness renderer; native and provenance-rehydrated modes (F4) | Taste | 5 explicit, 4 DRY | Removes the packaging advantage; reuses `packSessions` |
| 7 | Adapters start from each vendor's own benchmark ingestion code (F5) | Taste | 4 reuse | Strongest answer to "you held it wrong" |
| 8 | Event time, quiescence, ingest receipts, isolation canary as Phase 0 gates (F6) | Mechanical | 1 completeness | Each is a silent score loss otherwise |
| 9 | gbrain vendor default = `gbrain init` defaults; freeze master SHA; parity at `6622a119e` (F7) | Mechanical | 5 explicit | Same rule applied to gbrain as to vendors |
| 10 | Cat 40 on a fresh custodian world; rerun gbrain and `fs`; native partitions for finance docs; volume snapshots (F8) | Taste | 1 completeness | Removes home-field and configuration-as-capability objections |
| 11 | Cat 40 with one model per family, one run; drop GPT-6 Astra (F8) | Taste | 3 pragmatic | GPT-6.1 Sol is the newest GPT and both GPT models sit at 98 to 100%; CLAUDE.md requires one newest per family |
| 12 | Reorder priorities: lifecycle-lite above Cat 40 (P2 and P3 swap) | Taste | 6 bias to action | $20 for a question engineers ask (updates, deletion) versus about $400 on a ceilinged benchmark |
| 13 | Add a full-context baseline arm (F10) | User Challenge | 1 completeness | Not applied; adds an arm Garry did not name; about $43 |
| 14 | Add a naive-RAG baseline (existing `pg` arm) (F10) | User Challenge | 4 reuse | Not applied; weaker recommendation than 13; about $5 |
| 15 | Acknowledge AMB and cross-check against its published cells (F11) | Taste | 5 explicit | Corrects the premise; free adapter sanity check |
| 16 | Ingest LoCoMo dev twice per extraction system (F12) | Mechanical | 1 completeness | About $1 each; separates ingest noise from design |
| 17 | Preregister minimum detectable differences and the tie sentence (F13) | Mechanical | 5 explicit | Evidence rules: name the denominator and the uncertainty |
| 18 | Remove "line up with published numbers"; split LoCoMo categories 1 to 4 and 5 (F14) | Mechanical | 5 explicit | CLAUDE.md "compare matching conditions" |
| 19 | Drop `update()`; lifecycle-lite uses dated sessions, source deletion and residue scoring, reusing lifecycle/N1/N5 code (F15) | Taste | 4 DRY | Fewer invented semantics; measures derived-memory deletion |
| 20 | Decision table, normalized cost, ops footprint, native-answer arm (F16) | Taste | 1 completeness | What an engineer chooses by; native-answer adds about $15 |
| 21 | Label consolidating systems `provenance-limited` (F17) | Mechanical | 5 explicit | Lower bound must be stated beside the number |
| 22 | Add Garry's approval for public vendor posts to "Needs"; run cheap cells during the window; vendor-tuned slot (F18) | Mechanical (approval) / Taste (ordering, slot) | 6 bias to action | Public action under his account; a week of idle budget otherwise |
| 23 | Telemetry off, dummy keys, dedicated project key (F19) | Mechanical | 2 blast radius | Avoidable exposure |
| 24 | agent-runtime labeling and tag check (F21) | Mechanical | 5 explicit | Archival store is not agent-runtime's memory design |
| 25 | Matched-ness column and reranker policy (F22, F23) | Mechanical | 5 explicit | Partial matching must be visible |
| 26 | PMB starts from upstream provider adapters; report default `k` and `k = 5` (F24) | Taste | 4 reuse | Vendor-neutral reference already exists |
| 27 | Review mode SELECTIVE EXPANSION, depth implementation-ready for harness pieces | Mechanical | n/a | Set by the dispatch; plan adds capability to an existing harness |

## 4. Required sections

### 4.1 Premise challenges

1. **"The only answers are each vendor's own numbers."** False as stated. AMB runs several of these systems under one harness. The plan's real differentiators are provenance-scored retrieval, ingest cost, matched extraction model, lifecycle probes and agent tasks. Restate the premise (F11).
2. **"Same reader, judge and prompts makes it fair."** Necessary, not sufficient. The evidence budget and what the reader is handed dominate (89 versus 65 out of 100 on the same reader, comparison-systems.md:82), and today's gbrain path hands the reader corpus sessions, not gbrain output (F4).
3. **"LoCoMo all 10 and BEAM-100K all 20 can run."** They cannot without the custodian, and doing it publicly would breach the held-out program's custody (F1).
4. **"The sealed custody set is the fully fair cell."** It is the right idea, but the corpus does not exist and, authored by gbrain's own custodian with no published spec, it is home-field data (F9).
5. **"Cat 40 is high priority."** For gbrain's own story yes; for choosing among systems, its 50 tasks are at ceiling on the frontier models CLAUDE.md requires, and its world and tool surface were tuned for gbrain. It is worth running only on a fresh world with cost and leaks as the primary outcomes (F8).
6. **"$900 with a $1,200 cap."** The estimate omits vendor default models' prices and the frontier cell, and the cap cannot see vendor spend (F2, F3).
7. **"Vendor default means OpenAI-hosted default models."** True for five systems at very different price points (temporal-graph `gpt-5.5`, extract-first and graph-pipeline `gpt-5-mini`, memory-bank `gpt-4o-mini`), and false for markdown-notes (local FastEmbed). gbrain itself must also be held to its own new-install default (F7).
8. **"Engineers want a leaderboard."** They want a choice for a workload, a cost at their volume, an operations footprint, and a reference point for "no memory system" (F10, F16).

Are these the right categories for "high priority"? Memory QA is right and should stay P1 (with F1's split handling). The custody set is right in principle (F9). Lifecycle-lite deserves P2: knowledge update is the weakest LongMemEval type for most systems, deletion of derived memories is a privacy requirement every engineer faces, and it costs $20. PrecisionMemBench is cheap and fine at P4. Cat 40 drops to P3 and is resized (Decision 12). The one missing high-priority cell is the full-context baseline (User Challenge, Decision 13).

Is the fairness protocol credible to a skeptical vendor? With F4 (one renderer, native and rehydrated modes), F5 (their own ingestion code), F6 (dates and quiescence verified), F8 (fresh Cat 40 world, native partitions), F12 (ingest repeats), F18 (vendor-tuned slot) and F19 (no telemetry, metered), yes. Without them, a vendor can credibly dispute every loss.

### 4.2 Review sections

**Section 1, Architecture.** Findings F2, F4, F6, F15, F25. Revised dependency graph:

```
 gbrain-evals harness (Bun, TypeScript)
 +-------------------------------------------------------------------+
 | memory-qa runner   PMB runner   lifecycle-lite   Cat 40 loop      |
 |        \              |             /               |             |
 |         v             v            v                v             |
 |   MemorySystem client (HTTP contract)        generic MCP arm      |
 |         |   items[] + source_ids                    |             |
 |         v                                           |             |
 |   one renderer + packSessions budget                |             |
 |   (native | provenance-rehydrated)                  |             |
 |         |                                           |             |
 |   fixed reader + judge (ChatClient, ledger)         |             |
 +---------|-------------------------------------------|-------------+
           | HTTP                                      | MCP (stdio/http)
           v                                           v
 +------------------- Docker internal network ---------------------+
 | gbrain adapter (in-process or container)                        |
 | temporal-graph+neo4j | graph-pipeline | extract-first+qdrant | agent-runtime | markdown-notes    |
 | memory-bank+postgres         (each: shim + vendor SDK, uv.lock)   |
 |   all provider calls --> OPENAI_BASE_URL = metering proxy       |
 +-----------------------------------|-----------------------------+
                                     v
              MeteringProxy (bridge address, key injection,
              per-system ledger allowance) --> api.openai.com
```

Data flow, per item: happy path (reset namespace, ingest sessions with event time, finishIngest until quiet, retrieve, render, read, judge, row); nil path (system returns zero items: reader gets "(none)", row scored, `native_tokens = 0` recorded, not an error); empty path (session with zero turns: skipped by the adapter and counted in the receipt); error path (ingest error: `items_created`/`errors[]` in the row, conversation `ingest-degraded` above 1%; retrieve error: row `error_origin: sut`; provider refusal from the ledger: `error_origin: harness`, run stops). Namespace state machine: `absent -> ingesting -> settling -> ready -> queried -> reset -> absent`; querying in `ingesting` or `settling` is invalid and the client refuses it. Single points of failure: the metering proxy (if down, every system fails loudly, which is correct) and the custodian machine for sealed cells. Rollback: the plan publishes documents only; a bad run is withdrawn by reverting the report commit and keeping receipts. Platform potential: the HTTP contract plus Docker images become a reusable comparison harness; a version bump becomes a re-run, not a project.

**Section 2, Error and rescue map.** See 4.3.

**Section 3, Security and threat model.**

| Threat | Likelihood | Impact | Mitigated by plan? | Fix |
|---|---|---|---|---|
| Real OpenAI key inside six third-party containers | High | Medium | No | F2, F19 |
| Vendor telemetry sends usage or content off-box | High (extract-first on by default) | Low (public data) | No | F19 |
| Sealed rows published in a public receipt | Medium | High (spends program evidence) | No | F1 |
| Prompt injection inside benchmark text steering an extraction LLM | Low | Low | n/a | Benchmarks are public; record and ignore |
| Copyleft obligations from markdown-notes | Low | Medium | Yes (PLAN.md:146) | none |
| Neo4j or Postgres exposed on host ports | Medium | Low | No | Internal network only (F2) |

**Section 4, Data flow and edge cases.** Shadow paths that matter here: LoCoMo sessions with images (captions only; adapters must not drop the session), LME-S haystacks that repeat a session (occurrence ids already handle this, `corpus.ts` header), BEAM conversations far above a system's batch size (timeouts recorded as outcomes), duplicate ingest on retry (shims must be idempotent per `session_id`, or reset and re-ingest the namespace), a session whose date fails to parse (record `event_time: null`, count in the receipt). Async ordering: the only shared mutable state is a namespace; the invariant is "no query before quiescence", enforced by the client state machine above and tested by a scripted shim that delays settling.

**Section 5, Code quality.** F15 (drop `update()`), F4 (single renderer instead of per-adapter `context` strings), F5 and F24 (reuse vendor and upstream code). The lifecycle scorer should reuse `eval/runner/lifecycle/` scoring rather than a new one. No other issues.

**Section 6, Tests.** Required, all keyless except where noted: a fixture-corpus contract test every shim passes (already planned; add event-time, quiescence, idempotent re-ingest, isolation canary and empty-result cases); a metering test that a scripted shim's calls appear in the ledger with correct model prices; a renderer test that native and rehydrated modes produce identical prompts for gbrain when its items are whole sessions; a custody test that a sealed run writes no per-question rows to the public output directory; the lifecycle-lite scorer mutation kit (planned). Hostile-QA test: a shim that returns gold-looking session ids it never retrieved (provenance spoofing) must be caught by checking returned item text against the cited session. Flakiness: every LLM-backed path is nondeterministic, which is why F12 exists.

**Section 7, Performance.** temporal-graph ingest wall time (F25); Neo4j memory at BEAM scale (planned risk row); reader cache reuse across budgets (the `ChatClient` cache keys on prompt, so the 8,000-token arm reuses nothing from the default arm, budget accordingly); proxy throughput (it buffers whole responses, `gbrain-arm.ts` reads `res.text()`, so streaming SDK calls must be off or the proxy extended; Phase 0 check).

**Section 8, Observability.** Receipts per cell: system version and image digest, configuration and matched-ness, telemetry switch, ingest items and errors per conversation, quiescence wait, proxy dollars by model, reader and judge tokens, p50 and p95 latency, `docker stats` peak RAM and disk. A one-page run dashboard (markdown table regenerated from receipts) during Phase 3 shows cells done, dollars spent against allowance and degraded conversations. Runbook entries: proxy down, 429 storm, OOM, quiescence timeout, vendor correction mid-run.

**Section 9, Deployment and rollout.** Order: Phase 0 spike, harness and contract tests, preregistration commit, vendor window with provisional cheap cells, counted cells, custodian cells, report. Smoke check before each paid phase: one LoCoMo conversation per system, metered dollars match the estimate within 50%. Rollback of a published claim: a correction entry in the report's changelog with the new receipts, per CLAUDE.md.

**Section 10, Long-term trajectory.** Reversibility 4 of 5 (documents and adapters; the only one-way door is opening sealed material, handled by F1). Debt: six shims to maintain as vendors release weekly; mitigated if a version bump triggers an automated re-run of the cheap cells. Path dependency: the HTTP contract becomes the place new systems plug in, which is good. The 1-year question: a new engineer can read one shim and the contract and add a system in a day if the contract is documented with the fixture tests.

**Section 11, Design and UX.** SKIPPED (no UI scope).

### 4.3 Error and rescue registry

| Capability | What can go wrong | Rescued? | Rescue action | Reader of the report sees | Owner must prove |
|---|---|---|---|---|---|
| Shim ingest | Extraction JSON parse failure, SDK logs and continues | N (gap) | `items_created`/`errors[]` per session; `ingest-degraded` flag | Degraded conversations listed beside the score | Phase 0 fault-injection on each shim |
| Shim ingest | 429 or 5xx from provider | Unknown per SDK | Proxy records status; shim retries with backoff or fails the session | Error count in receipt | Each SDK's retry behavior under a scripted 429 |
| Shim ingest | Event time ignored | N (gap) | Dated probe in Phase 0; `event_time_honored` field | Column in matched-ness table | Probe per system |
| finishIngest | Background work still running at query time | N (gap) | Quiescence poll with timeout as outcome | Timeout listed as an outcome | Signal exists per system |
| Namespace isolation | Memory from item A visible in item B | N (gap) | Canary probe; reset verified by an empty search | System marked `blocked` until fixed | Canary per system |
| Metering | Vendor call bypasses ledger | N (critical gap) | Base URL override, internal network, project usage reconciliation | Dollars per cell trustworthy | Reconciliation within 2% |
| Metering | Unknown model price | Partial | Charged at reservation, marked unpriced | Unpriced count in receipt | Prices registered before Phase 0 |
| Retrieve | System returns nothing | Y | Reader gets "(none)"; scored | Row scored, zero tokens | Contract test |
| Retrieve | Provenance missing | Y (planned) | Retrieval "not measurable", QA counts | Label beside number | Per system |
| Retrieve | Provenance spoofed or wrong after consolidation | N (gap) | Check cited session contains item text; `provenance-limited` label | Label beside number | Spot check 50 items per system |
| Reader / judge | Provider error | Y | `qa_error` in row (existing `run.ts` handling) | Error count | existing |
| Custodian cells | Per-question rows written publicly | N (critical gap) | Output dir outside repo, aggregate-only writer | Aggregates only | Custody test |
| Cat 40 slot | Writing run pollutes next task | N (gap) | Volume snapshot restore | n/a | Restore test per system |
| Docker | OOM or timeout at BEAM scale | Y (planned) | Recorded as outcome | Outcome in table | Planned |

### 4.4 Failure modes registry

| Codepath | Failure mode | Rescued? | Test? | User sees? | Logged? | Verdict |
|---|---|---|---|---|---|---|
| Vendor SDK calls OpenAI directly | Spend outside cap | N | N | Silent | N | **CRITICAL GAP** |
| Sealed-split rows in public output | Custody breach | N | N | Silent until noticed | N | **CRITICAL GAP** |
| Extraction failure swallowed by SDK | Low score blamed on design | N | N | Silent | Partial (vendor log) | **CRITICAL GAP** |
| Query before background ingest settles | Low recall blamed on design | N | N | Silent | N | **CRITICAL GAP** |
| Event time ignored | Temporal and update questions fail | N | N | Silent | N | **CRITICAL GAP** |
| Namespace leak | Inflated score | N | N | Silent | N | **CRITICAL GAP** |
| Consolidation loses provenance | Recall understated | N | N | Unlabeled number | N | gap (labeling fixes) |
| gbrain gets corpus sessions, others get own text | Packaging advantage | N | N | Unlabeled | N | gap (F4) |
| Cat 40 leak metric without partitions | Configuration shown as capability | N | N | Misleading | Y | gap (F8) |
| Proxy unreachable from containers | Phase 0 fails | Y (loud) | Phase 0 | Blocked status | Y | ok |
| Provider 429 storms | Slow or failed sessions | Unknown | N | Error count | Y | verify |
| Neo4j OOM at BEAM scale | Timeout | Y | Planned | Outcome row | Y | ok |
| Reader/judge errors | Missing QA score | Y | existing | `qa_error` count | Y | ok |
| Vendor disputes config | Credibility | Y | n/a | Quoted disagreement | Y | ok |

14 rows, 6 critical gaps.

### 4.5 NOT in scope

Deferred (to the plan's follow-ups or TODOS.md, with reason):
- LongMemEval-S all 500 questions: about $580 extra for matched extraction systems; needs its own approval (Decision 3).
- BEAM-1M and BEAM-500K: ingest scale makes temporal-graph and graph-pipeline cost and time unbounded inside this cap; the program's own BEAM-500K sealed split is reserved by P4.
- world-v1 relational retrieval for temporal-graph and graph-pipeline (plan's own deferral, agreed): the most relevant category for graph systems, worth a follow-up once adapters exist.
- Submitting a gbrain provider to AMB: independent cross-check, small work once the HTTP contract exists.
- Automated re-run on vendor version bumps: the standing-arena trajectory below.
- HaluMem extraction scoring: fair and system-agnostic per the audit, but a different harness.
- LongMemEval-M: one 28-case pilot exists; not this plan.

Rejected for this plan (with reason):
- Cat 41, N6 visibility fuzz and Cat 35 (plan's own reasons, agreed).
- Adding systems Garry did not name (the hosted service built on temporal-graph, Supermemory, Honcho, MemPalace, Mastra): out of the ask; the full-context and naive-RAG baselines are the only additions recommended, as User Challenges.
- Vendor-default arm on LongMemEval-S (Decision 3).

### 4.6 What already exists (reuse)

| Need | Existing code | Reused by plan? |
|---|---|---|
| Benchmark loading, opaque session ids, dataset hashes | `eval/runner/memory-qa/corpus.ts` | Yes (implicit); keep it as the only loader |
| Reader prompts, judge prompts, cache, trap check | `eval/runner/memory-qa/qa.ts` | Yes; add item renderer beside `renderHistory` |
| Budget packing | `qa.ts` `packSessions` | Should be (F4) |
| Stratified subset selection | `run.ts` `selectQuestions` | Should be, for the LME-S 100 and LoCoMo 300 subsets |
| Dev/sealed splits, custody log | `eval/runner/decisions/splits.ts`, `sealed-confirmation-lib.ts` | Must be (F1) |
| Custodian corpus loader | `corpus.ts` `custody` (commit `7ba8d75`) | Yes; corpus itself missing (F9) |
| Paid-run guard, ledger, prices | `paid-arm.ts`, `budget-ledger.ts` | Partially; extend prices and allowances (F2) |
| Metering proxy | `cat40/gbrain-arm.ts` `MeteringProxy` | Planned for Cat 40 only; extend to all shims (F2) |
| MCP client and Arm contract | `cat40/gbrain-arm.ts` `McpClient`, `cat40/loop.ts` `Arm` | Yes |
| Permissioned comparator | `cat40/arms.ts` `fs-acl` | Should be the fallback label (F8) |
| Custodian world generation | `model-ladder-gen.ts` custodian mode | Should be (F8) |
| Lifecycle ledger and N1/N5 scoring | `eval/runner/lifecycle/` | Should be (F15) |
| PMB scorer and fixtures | `eval/precisionmembench/`, upstream providers | Partially (F24) |
| Vendor benchmark ingestion | extract-first's and memory-bank's benchmark repositories, AMB providers, the markdown-notes and temporal-graph vendors' LoCoMo harnesses | Not mentioned (F5) |

### 4.7 Dream-state delta

```
 CURRENT STATE                      THIS PLAN (with fixes)                 12-MONTH IDEAL
 Vendor self-reports and one   -->  One matched, metered, preregistered -->  A standing public arena: each system an
 vendor-run harness (AMB);          comparison of 7 systems on dev,          adapter behind one documented contract,
 gbrain numbers only on its         sealed and custody sets; cost, ops,      re-run automatically on every vendor
 own harness                        update/forget and agent-task cells;      release; custodian-rotated sealed sets;
                                    full-context reference (if accepted)     vendors maintain their own adapters by
                                                                             PR and co-sign configs; results also
                                                                             submitted to AMB; Pareto charts of
                                                                             accuracy against ingest and query cost
```

This plan moves toward the ideal if the HTTP contract, shims and fixture tests are built as durable repository code (not one-off scripts) and the report records how to add a system. The remaining gap after it ships: automation of re-runs, vendor-maintained adapters, rotation of sealed material, and scale tiers (LongMemEval-M, BEAM-1M).

### 4.8 Scope expansion decisions (SELECTIVE EXPANSION cherry-picks, auto-decided)

| # | Proposal | Effort | Decision | Reasoning |
|---|---|---|---|---|
| 1 | Full-context baseline | S | Flagged, User Challenge | Highest value per dollar; adds an arm Garry did not name |
| 2 | Naive-RAG baseline (existing `pg` arm) | S | Flagged, User Challenge | Useful floor; lower priority than 1 |
| 3 | Isolation canary and derived-memory deletion probes | S | Accepted (folded into F6, F15) | Inside existing categories; privacy question engineers have |
| 4 | Ops footprint and normalized cost columns | S | Accepted (F16) | Receipts already hold most of it |
| 5 | Native-answer arm | S | Accepted (F16) | About $15; what a user of each system actually gets |
| 6 | AMB cross-check | S | Accepted (F11) | Free sanity check |
| 7 | gbrain provider for AMB | M | Deferred | Follow-up once the contract exists |
| 8 | Automated re-run on vendor releases | M | Deferred | Trajectory, not this report |

### 4.9 Temporal interrogation (for the implementer)

- Hour 1: read `run.ts` end to end; the gbrain path is the reference behavior the new interface must reproduce at `6622a119e`.
- Hours 2 to 3: the ambiguity they will hit is what "a session" is for each system (one episode, one add, one note, one document) and how its date is set; decide per system in the adapter README before writing code.
- Hours 4 to 5: the surprise will be async ingestion and SDKs that ignore base URLs or stream responses through the proxy.
- Hour 6 onward: they will wish they had the per-session ingest receipts and the snapshot restore from day one.
- Effort: harness, contract and six shims about 2 to 3 weeks for a human team; about 2 to 3 days with Claude Code and gstack, plus the vendor window.

## 5. Completion summary

```
+====================================================================+
|            MEGA PLAN REVIEW - COMPLETION SUMMARY                   |
+====================================================================+
| Mode selected        | SELECTIVE EXPANSION (dispatch)              |
| System Audit         | sealed splits collide with plan; ledger     |
|                      | blind to vendor spend; Cat 40 at ceiling;   |
|                      | custody corpus missing; AMB unmentioned     |
| Step 0               | 8 premise challenges; 27 decisions          |
| Section 1  (Arch)    | 5 issues found                              |
| Section 2  (Errors)  | 14 error paths mapped, 8 GAPS               |
| Section 3  (Security)| 6 threats, 2 High likelihood                |
| Section 4  (Data/UX) | 5 edge cases mapped, 5 unhandled            |
| Section 5  (Quality) | 3 issues found                              |
| Section 6  (Tests)   | test list produced, 6 gaps                  |
| Section 7  (Perf)    | 4 issues found                              |
| Section 8  (Observ)  | 3 gaps found                                |
| Section 9  (Deploy)  | 2 risks flagged                             |
| Section 10 (Future)  | Reversibility: 4/5, debt items: 1           |
| Section 11 (Design)  | SKIPPED (no UI scope)                       |
+--------------------------------------------------------------------+
| NOT in scope         | written (10 items)                          |
| What already exists  | written                                     |
| Dream state delta    | written                                     |
| Error/rescue registry| 14 rows, 2 CRITICAL GAPS                    |
| Failure modes        | 14 total, 6 CRITICAL GAPS                   |
| TODOS.md updates     | 3 items proposed (LME-S 500, AMB provider,  |
|                      | release-triggered re-runs)                  |
| Scope proposals      | 8 proposed, 4 accepted, 2 flagged as User   |
|                      | Challenge, 2 deferred                       |
| CEO plan             | not persisted (review-only run)             |
| Outside voice        | skipped (parallel reviewers in /autoplan)   |
| Lake Score           | N/A (no coverage-scored questions asked)    |
| Diagrams produced    | 3 (architecture, namespace state machine,   |
|                      | dream-state)                                |
| Stale diagrams found | 1 (PLAN.md mermaid: no proxy, no renderer)  |
| Unresolved decisions | 2 (User Challenges 13 and 14 for Garry)     |
+====================================================================+
```

Status: DONE_WITH_CONCERNS. The plan should not be approved for spend until F1, F2 and F3 are applied; F4 to F9 should land in the same revision because they change the preregistration. Decisions 13 and 14 (full-context and naive-RAG baselines) are Garry's call.

Durable learning for this repository: the budget ledger meters only requests that pass through the harness or `MeteringProxy`, so any plan that runs third-party code making its own provider calls must route that code through the proxy before a cap means anything.
