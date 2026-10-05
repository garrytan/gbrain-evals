# Independent engineering review: open-source memory shootout

## Verdict

Request engineering amendments before the first paid pilot: the comparison is worthwhile, but the plan currently promises properties its proposed interface and existing runners cannot enforce. The largest blockers are cross-machine budget enforcement, PrecisionMemBench's evaluator-supplied memory behavior, sealed-output containment, and vendor-specific provenance and deletion semantics. Keep all six vendors and select D1 plus D2-A for the recommended matrix, deliver P1 through a compatibility-preserving extension of `memory-qa`, and make P2–P4 separately gated consumers of that foundation rather than prerequisites for its first useful result.

Reviewed the live v2 plan on 2026-10-05; final readback says “under autoplan review, not yet approved” (SHA-256 `a3b7661ed8b05b47a69eeaa1f8a9d2c5ca00b21f49faa894a9d5bd90072b7da9`). Auto-decisions below are recommendations for the plan, not spending or publication authorization. This is an independent GPT-6 Astra engineering review; no other reviewers' files were read, no repository files were edited, and no paid calls or vendor installations were performed.

## Numbered findings

### 1. CRITICAL — Architecture / phases: a parent allowance is not a distributed budget service

**Problem.** `BudgetRun.join` joins a run in a local SQLite file (`eval/runner/budget-ledger.ts:814–823`); `BudgetAllowance` holds mutable counters in one process and routes calls through `AsyncLocalStorage` (`:946–984`). Six VMs cannot share that object. The existing proxy is explicitly a loopback, same-process helper (`eval/runner/cat40/gbrain-arm.ts:84–126`), forwards incoming credentials, buffers the whole response, and relies on a separately installed fetch guard. Merely binding it to a bridge does not implement authenticated allocation, crash recovery, or streaming usage reconciliation. The current ledger also records rather than prevents measured overshoot (`budget-ledger.ts:884–900`): its input reservation estimates bytes divided by three (`:1106–1111`), which is not a hard upper bound on tokens. Thus “the sum cannot pass it” is stronger than the implementation guarantees.

**Concrete fix.** Before any remote pilot, reserve disjoint, durable system/phase leases from one campaign ledger; their sum, including reader/judge leases and safety headroom, must be at most $1,200. A VM may spend only its reserved lease, using its own durable ledger; a crashed or unreachable VM's lease remains committed until reconciled and cannot be reissued. Alternatively use one authenticated central proxy/ledger, but choose one topology, not an in-memory hybrid. Use a provider/route allowlist, redact incoming auth, inject keys only at the trusted boundary, reject unknown models before forwarding, and explicitly support JSON and SSE or disable streaming in every capability record. For a literal cap, use a conservative input upper bound plus enforced output limits, reserving again for every retry; stop on any pricing uncertainty. Keyless tests must prove concurrent leases cannot overspend, leases cannot be replayed after restart, and an unpriced or over-budget request never reaches the fake upstream. Provider dashboard reconciliation is a later accounting check, not the cap mechanism; its access and reporting lag have not been proven.

### 2. CRITICAL — P3 / one evidence contract: PrecisionMemBench is not 77 ordinary retrieval queries

**Problem.** The vendored `BaseAdapter.buildContext` injects pinned facts and open questions, expands relations from the fixture, and maps returned IDs back into the full seed (`eval/precisionmembench/scorer/baseAdapter.ts:188–241,269–307,310–333`). The existing gbrain adapter intentionally overrides only search (`eval/precisionmembench/gbrainAdapter.ts:4–15`). `scoreCases` asserts persona, pinned, belief, scope, ordering and question contracts, not just retrieval text (`eval/precisionmembench/scorer/runCases.ts:42–80,138–160`). The actual 77 cases include four persona cases, four relation-expansion cases, six type/open-question cases and five budget cases. Running that unchanged while claiming “no evaluator-side expansion” is contradictory; bypassing it silently changes the benchmark. Conversely, forbidding all scope/user metadata would break operative PMB inputs, not prevent answer leakage.

**Concrete fix.** Preserve the vendored scorer and fixture byte-for-byte. Add a `SystemBeliefAdapter` that overrides only `searchText`, translates opaque source IDs back to belief IDs solely on the evaluator side, and uses the same upstream context builder for every system. Label this table **“PrecisionMemBench upstream contract; shared evaluator supplies persona, pins and relation expansion”**, not native product precision. Report categories separately and identify which exercise the product search. Permit opaque user/scope filters as declared query inputs while keeping `expect`, `superseded_by`, labels and case IDs out of vendor requests. If a no-expansion product-only variant is desired, name it separately and preregister it; do not substitute it for the 77-case result. `eval/runner/precisionmembench.ts:348–380` already provides the right per-case adapter and exception seam.

### 3. CRITICAL — P1 sealed cells: aggregate-only is not enforced by today's runner

**Problem.** `memory-qa/run.ts` logs an opening but then takes any output directory (`:210–219`), appends per-question rows (`:402–403`), writes answers (`:390–395`), and uses a shared home-directory QA cache (`:290`). `ChatClient` caches full model responses (`memory-qa/qa.ts:113–126`). The plan additionally requires exact reader contexts. Custodian execution alone does not stop those artifacts from landing in a public receipt tree, persistent VM volume, captured-request log, or shared cache. Cat 40 already rejects an in-repository custodian output (`cat40-model-ladder.ts:388–395`); the QA path does not.

**Concrete fix.** Add a sealed execution profile before enabling Phase 4: reject repository-contained output/cache/temp destinations, require a custodian-owned root and access log before loading the corpus, disable shared caches, and keep vendor state and request traces inside the same custody boundary. A separate allowlist-based exporter emits only preregistered aggregate fields, code/config hashes, counts, and interval summaries. Test it with synthetic sealed markers in answers, source IDs, exception text, contexts and filenames; none may appear in exported JSON or logs. An opening is one frozen batch containing the complete matrix, not one privileged retry per system. Do not open either reserved sealed-confirmation set.

### 4. HIGH — Fixed denominators: a sentence does not repair resume semantics

**Problem.** The current runner marks rows done when `!r.error`, so a row with `qa_error` is treated as finished (`memory-qa/run.ts:231–238,394–395`). Failed retrieval rows are appended again on resume; completeness is then checked by line count, not unique expected IDs (`:411–435`). Existing statistical pairing rejects duplicate IDs and asymmetric eligibility (`stats/paired.ts:70–101`). `stats/rows.ts:62–70` recognizes `error` and `error_origin`, not `qa_error`. A new adapter can therefore produce a nominally complete run that cannot be compared, or quietly improve its denominator by retrying only failures.

**Concrete fix.** Materialize a frozen expected-cell manifest before execution. Keep append-only attempts separate from one canonical terminal record per cell. Specify retry eligibility and maximum attempts before the run; a successful retry replaces an attempt, not an extra scored row. Distinguish retrieval failure, reader failure, judge failure, unsupported capability, invalid harness, ingest degradation, and budget-not-run. Product failures remain zero in service-quality denominators; infrastructure/budget failures make the comparison incomplete, never a product loss. Build summary and pairing inputs from the same canonical records. Reuse `ProbeAccounting` (`eval/runner/probe-accounting.ts:43–64`) for scoring policy, not as a substitute for an expected-ID manifest. Test crash/restart after each write boundary and reject duplicate, missing and foreign IDs.

### 5. HIGH — Interface / budgets: `retrieve(ns, question, k)` cannot express the experiment

**Problem.** `k` represents neither a vendor's native defaults nor a fixed token budget, and the interface drops query time. At Hindsight 0.10.2, `recall` takes `max_tokens=4096`, `budget="mid"`, `query_timestamp`, separate chunk/source-fact budgets and no top-k argument ([client source](https://github.com/vectorize-io/hindsight/blob/v0.10.2/hindsight-clients/python/hindsight_client/hindsight_client.py#L618-L639)). Packing its already capped 4,096-token response to 8,000 tokens does not create the same retrieval opportunity. Graphiti `search_` returns several result classes under a search recipe rather than one inherently ranked list ([source](https://github.com/getzep/graphiti/blob/v0.30.2/graphiti_core/graphiti.py#L1662-L1679)). Cognee explicitly advises pinning `query_type` for `only_context` callers ([source](https://github.com/topoteretes/cognee/blob/v1.6.2/cognee/api/v1/recall/recall.py#L347-L379)). A generic shim must not invent these choices at runtime.

**Concrete fix.** Make retrieval accept a named, versioned policy containing `query`, optional normalized `query_time`, mode `vendor-default | fixed-evidence`, and the resolved per-vendor retrieval settings; return ranked evidence plus the actual settings and truncation/completeness flags. Treat “8,000 tokens” as a reader evidence ceiling, not proof that all APIs have an identical top-k knob. Freeze candidate limits and whether one public read-by-ID expansion is part of each native recipe. No hidden secondary fetch may improve one system's evidence. Require a deterministic normalization rule for Graphiti result classes and pin Cognee's query type/routing/reference flags. Unsupported controls are recorded as such, never silently approximated.

### 6. HIGH — Provenance: returned items need evidence identities, not just arrays of source IDs

**Problem.** The plan's Graphiti “edge and node `episodes`” claim is false for entity nodes at the pin: `EntityNode` declares embedding, summary and attributes, not an `episodes` field ([nodes.py:499–504](https://github.com/getzep/graphiti/blob/v0.30.2/graphiti_core/nodes.py#L499-L504)). Source metadata can be coarse or incomplete even when present. The current QA scorer merely converts slugs to session IDs and deduplicates (`memory-qa/run.ts:362–369`), suitable for one page per session but insufficient for a fact carrying ten sources. A fact whose provenance names the whole namespace would get excellent source-rehydrated recall while providing poor evidence. A dictionary of known source IDs does not prove the attribution is truthful.

**Concrete fix.** Give evidence a stable item ID, an explicit native rank, item type, and `provenance_status: exact | partial | unavailable`, with opaque source references validated against the current namespace. Record raw vendor results and the mapping algorithm. Graphiti entity-node provenance must use a demonstrated public API path or remain unavailable; do not query the database privately to manufacture it. Deduplicate rehydrated sessions once, preserve first appearance, and define deterministic source order within an item. Mark mixed/partial provenance separately; do not award ordinary strict recall to inflated or unknown mappings. Add adversarial fixtures for namespace-wide citations, one real source plus invented ones, duplicate sources, and two sessions merged into one fact. Phase 0 needs a multi-session provenance test, not only a canary that retrieves one source.

### 7. HIGH — Event time / ingestion: a uniform method name hides incompatible temporal semantics

**Problem.** Mem0 OSS 2.2.1 exposes a `timestamp` parameter but explicitly rejects every non-null value as platform-only ([main.py:760–818](https://github.com/mem0ai/mem0/blob/v2.2.1/mem0/memory/main.py#L760-L818)). It must receive dates as in-band text, not through that tempting SDK argument. `isoSessionDate` produces timestamps without a zone and allows unknown formats to return null (`memory-qa/corpus.ts:56–74`), while ingestion today follows the dataset array (`memory-qa/run.ts:318–327`). Graph extractors and correction handling can depend on insertion order. “Parallel namespaces” is safe only after each namespace's ordered writes and readiness rules are established.

**Concrete fix.** Pin timestamp parsing, timezone assumptions, unknown-date handling, and a stable event-time ordering policy, preserving original sequence for ties and recording it in the dataset fingerprint. Distinguish native temporal metadata from date-in-text support in capability records. Serialize sessions within each namespace until a vendor documents safe equivalent bulk behavior; parallelize across independent namespaces. For Mem0, render the date in the input text and do not set `timestamp`. Test out-of-order corrections, tied dates, missing dates and relative dates. Do not silently substitute wall-clock time for historical events or claim native temporal support merely because a textual date is searchable.

### 8. HIGH — Feasibility / readiness: successful SDK returns can still hide partial ingestion

**Problem.** Mem0's pinned implementation falls back from a failed batch insert to per-record inserts, logs individual failures, and only raises if *none* persisted ([main.py:1055–1076](https://github.com/mem0ai/mem0/blob/v2.2.1/mem0/memory/main.py#L1055-L1076)). “Items created and errors” cannot be faithfully filled from a successful return unless the shim has evidence for missing items. Waiting for empty queues only proves work stopped. Existing gbrain extraction already records `pages_failed` and still measures saved facts (`memory-qa/run.ts:329–353`); retain that distinction across systems.

**Concrete fix.** Capability records must state what ingestion completion and completeness can actually be observed through public APIs and diagnostic output. Preserve successful creation counts, warnings and known partial failures; represent unknown completeness explicitly rather than synthesizing zero errors. A non-scored setup probe with known planted facts plus a public inventory/count check, where available, establishes the adapter's ingestion path. Add fault-injected fake-provider tests that fail the second insert and make the adapter report degradation despite HTTP 200. Keep one namespace alive through readiness; measure all background work and drain metering before its final receipt. A product's lack of visibility is a reported limitation, not proof of success or permission to inspect private tables.

### 9. HIGH — P2: delete-by-source and “forget” are not interchangeable

**Problem.** Mem0 deletes a memory ID, not a source session ([main.py:1883–1896](https://github.com/mem0ai/mem0/blob/v2.2.1/mem0/memory/main.py#L1883-L1896)). Graphiti's public `remove_episode` deletes an edge when its first recorded episode is the deleted episode, including the case where the edge lists other episodes ([graphiti.py:1824–1835](https://github.com/getzep/graphiti/blob/v0.30.2/graphiti_core/graphiti.py#L1824-L1835)). A harness that repairs this using direct database edits or deletes every memory in a namespace is no longer measuring the public product. The proposed interface also has no close/dispose hook, operation receipt, idempotency key, or distinction between unsupported deletion and an observed failed deletion.

**Concrete fix.** Specify `deleteSource` as removal of an identified source and its permitted derivatives, with capability states `native | public-api-composition | unsupported`. An ingestion-time reverse mapping may compose documented memory-ID deletes, but its loss of shared facts must remain observable. Add a public-API deletion receipt, eventual-completion barrier and idempotent retry policy. Seed a duplicate/shared fact, a source-unique fact, and an unrelated survivor; prove presence before delete, then test absence and survivors from a fresh reader session and after restart. If precise source deletion is unsupported, report that capability gap instead of a fabricated P2 score. Reuse the existing mutation kit's honest, empty, refuse-all, stale and wrong-source controls (`mutation-kit.ts:27–53,111–117`) and add delete-all/partial-delete controls; do not replace those required controls with the plan's new list.

### 10. HIGH — P4: a generic MCP arm is not a generic Cat 40 runtime

**Problem.** The current `McpClient.start` hardcodes `bun <gbrain>/src/cli.ts serve` and line-delimited stdio (`cat40/gbrain-arm.ts:154–179`). `Arm` only describes tools and calls (`cat40/loop.ts:23–35`), while `runCell` owns gbrain-only slot acquire, session reset, restore and cost attribution (`cat40-model-ladder.ts:177–235`). Any unknown arm currently enters the gbrain fallback. Write protection recognizes only a handful of argument field names (`cat40/arms.ts:209–217`); vendor `memory_id`, `document_id`, nested patch targets or batch writes would evade it. HTTP MCP, stateful Letta sessions, write-back isolation and provider spend are therefore not solved by implementing `Arm.call`.

**Concrete fix.** Keep the provider-neutral model loop, introduce an explicit arm factory/runtime lease with `newSession`, `restore`, `close`, metering and source/write-target normalization, and reject unknown arm names before spend. Use a maintained MCP client for stdio and Streamable HTTP rather than extending the gbrain line parser into a protocol stack. Freeze tool schemas and instructions in the experiment hash; process tool-list changes and preserve structured errors. Map write targets to canonical corpus IDs for scoring. Run each mutable task on a clean namespace/snapshot while preserving memory between the two family-F sessions. Test cross-cell contamination and restart behavior. Keep Letta's native loop outside `runAgent` with its own transcript/cost adapter; local Letta's source confirms memory-filesystem behavior, not the table's presumed archival API (`letta-code v0.34.4/src/backend/local/local-backend.ts:178–183,502–525`). Phase 0 still owes that archival API probe. Add bounded transport/model deadlines: today's `postJson` has retries but no abort timeout (`cat40/loop.ts:118–128`).

### 11. HIGH — Harness migration: parity and the new gbrain recipe are different contracts

**Problem.** Today's runner directly imports `hybridSearch`, forces expansion off, requests `topK * 3` chunks, and reduces them to sessions (`memory-qa/run.ts:281–283,362–369`). It pins reranking/autocut off by default (`:107`), and its reader rehydrates corpus sessions (`:374–385`). The new native public-read recipe, actual `gbrain init` defaults, exact packing, current master and a different reader cannot all reproduce that historical pipeline. Also, `6622a119e` is a **gbrain** revision, not a gbrain-evals revision; the starting-line receipts name it as the loaded product SHA. A replay that merely rereads old rows proves no adapter parity.

**Concrete fix.** First extract the existing engine lifecycle/retrieval behind a legacy-compatible adapter without changing observable defaults, row schema or prompts. Test the old CLI and the new orchestration on the same keyless corpus and fixed recorded provider fixtures. Pin both repository revisions and resolved settings for historical regression comparisons. Separately add a clearly named shootout-native recipe using the chosen public operation and measured initialization defaults; changes from the starting line are intentional new measurements, not parity failures to tune away. Keep `eval:decide`'s baseline/candidate feature workflow intact (`eval/runner/decide.ts:5–15,23–29`); reuse its components, do not turn it into an n-vendor campaign manager.

### 12. HIGH — Evidence packing / reader replay: token counts, ordering and prompts must be frozen explicitly

**Problem.** Existing `packSessions` uses characters divided by four, stops at the first oversized session, and `renderHistory` sorts selected sessions by a lexical date string (`memory-qa/qa.ts:39–64`). None implements the proposed native rank-preserving renderer or exact 8,000-token contract. D2-A's frontier-reader replay creates a second ambiguity: repacking each reader's context using its own tokenizer changes the evidence, so it is no longer a reader-only comparison. `ChatClient` retries/cache keys omit campaign identity and returns missing content as an empty string (`qa.ts:116–160`); the plan must distinguish valid abstention from a malformed provider response. The statement that the starting line uses GPT-4o and official prompts for every benchmark is also inaccurate: BEAM's default judge is GPT-4.1-mini with the repository's rubric prompt (`qa.ts:34–35,92–100`).

**Concrete fix.** Preserve the historical renderer and add a separate pure, versioned evidence renderer/packer. Declare rank order, duplicate handling, headers counted in the budget, oversized-first-item policy, date rendering and tokenizer identity. Freeze the primary reader's exact context bytes and replay those unchanged to all four frontier readers; record each reader's own measured input usage without repacking, and label context-limit failures. Use a pinned local tokenizer where supported or provider token counting; if a tokenizer is approximate, label it rather than calling it exact. Save full answers, prompt hashes, completion/finish reasons, judge responses and parse status. Choose and preregister each benchmark's exact judge model/prompt as an instrument, including the BEAM choice, instead of inheriting defaults. Reject malformed responses as dependency/judge errors and test truncation, non-ASCII text, empty evidence and invalid judge output.

### 13. HIGH — Statistics: three conversations cannot support the apparent inferential promise

**Problem.** Clustering is the correct unit, but LoCoMo dev has only three clusters and BEAM dev six. The repository's exact cluster sign-flip enumerates `2^g` patterns (`stats/paired.ts:180–200`): with three nonzero aligned clusters, the smallest two-sided p-value is 2/8 = 0.25. The gate defaults to at least ten clusters (`stats/gates.ts:58–59,165,241–259`). Re-ingesting the same three conversations twice does not create six independent conversations. Ceiling equality also does not establish equivalent systems on other workloads; the existing power helper says zero variation cannot estimate an effect (`stats/paired.ts:275–290`).

**Concrete fix.** Report LoCoMo/BEAM dev as descriptive paired outcomes with cluster counts, observed ranges and explicitly weak intervals, not powered superiority/noninferiority claims. Keep repeat ingestions nested within conversation and report their disagreement separately. Preregister one primary configuration/context/budget contrast and the multiple-comparison family before inspecting results; the other matrix cells are secondary. Use the existing pairing and Holm functions, and state an inconclusive outcome when gates lack clusters. Do not lower `min_clusters` to make the comparison pass. Say “no observed difference at this ceiling,” not statistical equivalence. Power and claim language for the custodian batch must be fixed before opening it.

### 14. HIGH — Campaign identity / cost / performance: the phase table is not an executable matrix

**Problem.** The plan combines two gbrain builds, vendor recipe/common models, two budgets, two context modes, two ingestions on LoCoMo, proposed controls and frontier replay. It does not enumerate which axes multiply, which artifacts are reused, or whether the $330 includes both gbrain builds and repeated queries. The existing QA config hash omits the full selected ID manifest and new adapter/deployment identities (`memory-qa/run.ts:204–207`); resume knows nothing about the new axes. QA cache keys include prompt/model/replicate (`qa.ts:116–120`), so identical prompts can reuse calls across nominal ingestions. Native-provider retrieval may also learn from queries. Meanwhile gbrain is drawn in-process on the harness and vendors on separate VMs, so “identical VM classes” does not yet define comparable query latency.

**Concrete fix.** Generate a machine-readable campaign matrix before pilots and amend it with measured pilot costs before counted cells. Key every cell and artifact by dataset/selected-ID hashes, ingest replicate, product and wrapper SHAs, image/model revisions, configuration, retrieval policy, context mode, reader/judge/prompt/renderer identity, and seed. Retrieve once per frozen retrieval policy and derive both context modes from its recorded result; do not rerun ingestion for a reader-only comparison. Distinguish cache-hit marginal cost from reproducible cold ingest/query cost. Make duplicate runs explicit independent repetitions, not accidentally cached copies. Run gbrain's measured serving path on the same VM class or report server time and harness/network time separately. Freeze warmup, concurrency, rate limits and query order; measure cold start, ingestion readiness, retrieval, rendering, reader and judge separately. Provisioned VM/storage costs and teardown are separate from API dollars, but cannot disappear from “at what cost.”

### 15. MEDIUM — Phase gates / repository integration: P2 priority and category obligations are missing from execution order

**Problem.** Although lifecycle is P2, Phase 3 runs PMB and Phase 4 opens sealed data before Phase 5 even builds lifecycle. The new category omits the registry, promotion rules, hermetic wrapper and bug classification required by `eval/CONTRIBUTING.md:67–80`. `eval/registry.ts:924–929,969–981` already separates PMB, lifecycle and Model Ladder contracts. “Every shim passes a keyless fixture” is also ambiguous: a mocked contract can pass while the real vendor package never imports. Phase 0 currently schedules paid full-conversation and Cat 40 pilots before Phase 1 builds the sanitizer and enforceable runner boundary.

**Concrete fix.** Reorder to keyless campaign/accounting/meter/sanitizer skeleton, import-only locked-container checks, tiny metered API probes, then the one-history pilots. Ship P1 dev before P2, then PMB, then Cat 40, and open the frozen sealed batch only after its adapter and data-path gates are final. Register `lifecycle-lite` report-only with separate exact safety assertions and a survivor utility floor; use `withHermeticEnv` (`hermetic-env.ts:76–113`), paid flags, the shared mutation kit and bug ledger. Do not run environment-mutating hermetic wrappers concurrently in one process. Distinguish keyless harness tests, actual installed-package tests using fake providers, and paid product-quality probes in every gate. D4 remains disabled until separately approved; do not block all execution on an unapproved vendor-post window.

## Decisions table

Auto-decided for this engineering recommendation. “User Challenge” records a product-scope recommendation, not permission to spend or post publicly. The $1,200 cap remains a proposed planning limit pending approval. Principles: 1 completeness, 2 fix blast radius, 3 pragmatic, 4 reuse/DRY, 5 explicit over clever, 6 bias to action.

| ID | Decision | Classification | Principles | Disposition |
|---|---|---|---|---|
| E1 | Use durable pre-reserved per-VM leases, with no lease reuse after uncertain failure | Mechanical | 1, 2, 5 | Required before paid pilots |
| E2 | Preserve PMB's upstream context-builder contract and label evaluator-supplied behavior | Mechanical | 1, 4, 5 | Required; no scorer fork |
| E3 | Custodian-only storage plus allowlist aggregate export | Mechanical | 1, 2 | Required before sealed work |
| E4 | Expected-cell manifest, attempt log and canonical terminal table | Mechanical | 1, 4, 5 | Required for every counted lane |
| E5 | Typed retrieval policy and explicit provenance/time/deletion capabilities | Mechanical | 1, 5 | Required shared contract |
| E6 | Serialize within namespaces; parallelize independent namespaces | Taste | 2, 3, 5 | Default until vendor equivalence is proven |
| E7 | Extract legacy gbrain behavior before adding native recipe | Mechanical | 2, 4 | Required compatibility boundary |
| E8 | Freeze primary-reader contexts for frontier replay; never repack per reader | Mechanical | 1, 5 | Implements recommended D2-A |
| E9 | Keep small-cluster dev claims descriptive; no lowered gate thresholds | Mechanical | 1, 5 | Required statistical interpretation |
| E10 | Extend Cat 40 through runtime leases and canonical write effects, not `Arm` alone | Mechanical | 1, 2, 4 | Required before P4 |
| E11 | P1 first useful slice; P2–P4 remain planned later milestones | Taste | 3, 6 | Recommended implementation order |
| E12 | Recommend D1, D2-A and $1,200; defer D3; D4 disabled pending explicit approval | User Challenge | 2, 3, 5 | Auto-selected recommendation; no claimed user approval |

## Scope challenge: the smallest change that delivers P1

P1 needs a multi-system retrieval/evidence lane, not a universal memory-and-agent framework. The smallest complete change reuses corpus loading and question selection from `memory-qa/corpus.ts` and `run.ts:165–191`, extracts the existing gbrain lifecycle into a compatibility adapter, adds one sanitized HTTP client for vendor shims, and uses one renderer, canonical accounting layer and campaign manifest. The new campaign entrypoint orchestrates systems while the old `memory-qa/run.ts` CLI remains valid for `eval:decide`.

The first runnable vertical slice is the keyless corpus plus gbrain and one installed vendor shim, with fake providers and all failure paths tested. It proves the contract before six adapters are built in parallel. Then add the other vendors without changing the common scorer. Letta is explicitly agent-only if its passive API cannot be demonstrated; that is a visible capability outcome, not a missing row hidden from the study.

Include D1's controls and D2-A's readers in the recommended matrix. The full-history control is a separately labeled context ceiling where it fits, not a fake 8,000-token retrieval arm; the no-memory control receives no historical evidence; plain hybrid must have a concrete standalone implementation/configuration rather than aliasing tuned gbrain. P1 does not need a generic MCP client, lifecycle generator, PMB adaptation, or native Letta loop to start delivering valid dev evidence. Those remain in the campaign but must not expand the first integration diff.

## Architecture: recommended real module/file layout

`+` new; `~` changes; `=` reused unchanged. Later milestones are shown explicitly, not hidden in an oversized first PR.

```text
eval/runner/shootout/
  + run.ts                  CLI: preflight -> freeze -> ingest -> query -> summarize
  + manifest.ts             resolved matrix, identities, expected cells, cost estimate
  + outcomes.ts             attempt log -> one terminal row per expected cell
  + report.ts               service/completed metrics, stats, allowlisted sealed export
  + metering.ts             authenticated proxy, durable lease consumption, teardown
         |                                   |
         | uses                              +--> = budget-ledger.ts
         |                                          prices/reservations/settlement
         v
eval/runner/memory-qa/
  ~ run.ts                  keep legacy CLI/defaults; delegate gbrain lifecycle
  = corpus.ts               loaders, gold kept evaluator-side, opaque IDs, dates
  ~ qa.ts                   preserve legacy prompts; accept recorded evidence context
  + evidence.ts             sanitizer, validated provenance, renderer, token packer
         |
         v
eval/runner/systems/
  + types.ts                session/query/evidence/receipt/capability contracts
  + gbrain.ts               legacy adapter + explicit shootout-native recipe
  + http.ts                 one validated shim protocol, deadlines, typed errors
         |
         +--> eval/systems/{graphiti,cognee,mem0,basic-memory,hindsight}/
         |      + adapter.py, pyproject.toml, uv.lock, Dockerfile, capability.json
         |      + tests/     installed SDK + fake-provider contract tests
         +--> eval/systems/letta/
                + locked local backend, native-agent driver; passive path only if proven

Later independent consumers:
  + eval/runner/lifecycle-lite.ts
  + eval/generators/lifecycle-lite-gen.ts
  + eval/runner/lifecycle-lite-score.ts
      --> same MemorySystem/evidence/outcomes; = mutation-kit.ts
  ~ eval/runner/precisionmembench.ts
  + eval/precisionmembench/systemAdapter.ts
      --> same MemorySystem; = scorer/baseAdapter.ts + runCases.ts (upstream semantics)
  ~ eval/runner/cat40-model-ladder.ts
  ~ eval/runner/cat40/arms.ts, score.ts
  + eval/runner/cat40/system-arm.ts
      --> runtime lease + maintained MCP client --> vendor native tool surfaces
      --> = cat40/loop.ts (except bounded deadline/error plumbing if needed)
      --> = gbrain-arm.ts slot lifecycle, extracted meter only if both callers benefit

Common existing infrastructure:
  = hermetic-env.ts, paid-arm.ts, probe-accounting.ts, bug-ledger.ts
  = stats/{rows,paired,gates}.ts, gbrain-under-test.ts, receipt.ts
  ~ eval/registry.ts         lifecycle-lite contract; campaign listed/report-only entry
  = eval/runner/decide.ts    existing gbrain feature workflow, not the campaign controller
```

Keep each vendor's service implementation local to its adapter directory. Share the HTTP schema and contract-test fixture, not a new Python abstraction framework. Do not force the Node-based Letta runtime into the plan's blanket “vendor Python + uv.lock” architecture. A provider proxy has keys and budget authority; shims have only short-lived routing credentials. Vendor containers get no host Docker socket, no real provider keys, no unrestricted egress, and no way to override the namespace imposed by the runtime lease.

## Codepath-to-test diagram

All new test names below are proposed. Existing test names are explicitly identified in the reuse section.

```text
manifest parse/resolve/freeze
  -> test/eval/shootout-manifest.test.ts
     invalid flags/model price; all frozen axes; immutable IDs; changed config refuses resume
dataset -> sanitized input -> SDK/HTTP request
  -> test/eval/shootout-boundary.test.ts
     gold/raw-ID sentinels; opaque user/scope; dated turns; unknown fields rejected
namespace reset -> ordered ingest -> readiness -> close
  -> test/eval/shootout-ingest.test.ts
     partial success, timeout, crash/retry/idempotency, cross-namespace canaries, teardown
  -> eval/systems/<vendor>/tests/test_contract.py (Node tests for Letta)
     actual pinned imports/signatures, fake-provider responses, no paid network
native response -> validated provenance -> rehydrated sessions
  -> test/eval/shootout-evidence.test.ts
     unknown/foreign/partial/inflated sources; merged facts; stable order; no hidden fetch
render -> pack -> primary context -> frozen frontier replay
  -> test/eval/shootout-packing.test.ts
     Unicode/token ceilings, headers, oversized items, exact byte replay, context-limit failure
gbrain legacy extraction -> native recipe
  -> test/eval/memory-qa-adapter.test.ts
     old CLI output/fixture parity; old defaults unchanged; intentional native divergence
retrieve/reader/judge -> attempt -> terminal -> resume -> summary
  -> test/eval/shootout-outcomes.test.ts
     every throw boundary; product zero vs infrastructure invalid; duplicates; truncated log
  -> test/eval/shootout-reader.test.ts
     retry caps, malformed/empty/truncated responses, cache provenance, judge parse failures
system VM -> credential-injecting meter -> paid route -> settlement
  -> test/eval/shootout-metering.test.ts
     unknown routes/models, auth redaction, simultaneous holds, retry charging, JSON/SSE usage
campaign lease -> remote ledger -> crash/restart -> reconciliation
  -> test/eval/shootout-leases.test.ts
     disjoint lease sum, exhausted lease, replayed/reissued lease, unknown spend retained
container egress -> allowed proxy only
  -> eval/systems/tests/egress.test.sh
     direct provider/alternate port/redirect denied; proxy succeeds; no host credentials
sealed run -> custody storage -> aggregate exporter
  -> test/eval/shootout-custody.test.ts
     log-before-load, path containment/symlinks, cache isolation, hostile error/context markers
canonical rows -> paired stats -> report
  -> test/eval/shootout-report.test.ts
     cluster/repeat structure, few-cluster inconclusive, ceiling wording, missing capability
P2 generator -> oracle -> correction/delete -> observer -> scorer
  -> test/eval/lifecycle-lite.test.ts
     deterministic gold, presence checks, restart, survivors, public-delete capability gaps
  -> test/eval/lifecycle-lite-mutation.test.ts
     shared five fakes + delete-all + partial-delete + forged provenance
PMB seed -> opaque source mapping -> SystemBeliefAdapter -> upstream scoreCases
  -> test/eval/precisionmembench-system.test.ts
     same 77 case semantics, no seed-label leak, fixture-backed expansion disclosed
Cat40 runtime acquire -> MCP/session -> canonical writes -> restore/release
  -> test/eval/cat40-system-arm.test.ts
     stdio/HTTP/errors/schema changes, two-session persistence, no cross-cell state,
     opaque write target mapped to protected doc, poisoned slot never reused
Letta native run -> transcript/cost/outcome normalization
  -> test/eval/cat40-letta.test.ts
     canned native transcript, incomplete run, both session costs, no fake shared-loop claim
new runner -> registry/hermetic/paid gates -> receipts
  -> extend test/eval/registry.test.ts and test/eval/paid-runner-budget.test.ts
     report-only contract, missing paid flags, keys stripped, no omitted terminal cells
```

## Test plan

1. **Characterize before extracting.** Add a keyless legacy `memory-qa` regression fixture at the public seam, including retrieved session order and historical prompt bytes. Run existing `test/eval/decide-kit.test.ts`, `stats-paired.test.ts`, `stats-gates.test.ts`, `receipt-accounting.test.ts` and `precisionmembench-scorer.test.ts` after shared changes. Do not weaken historical packing tests to bless the new renderer; exercise the new policy separately.
2. **Test the harness without vendor services.** Bun's existing test framework covers the manifest, boundary, outcomes, renderer, scorer and fake HTTP/MCP services. Run hermetic helpers in isolated subprocesses where environment mutation could collide. Fail tests on any unexpected external network call; fake-model scores are harness evidence only.
3. **Test real pinned packages with fake providers.** Build each locked container, verify exact installed versions and transitive core/MCP alignment, and execute public add/read/delete/ready probes using a deterministic local OpenAI-compatible endpoint where the vendor supports it. For Graphiti's MCP tag, explicitly constrain core 0.30.2: its `mcp_server/pyproject.toml:10` declares `graphiti-core[falkordb]>=0.30.1`, not the table's exact version. Unsupported fake-provider paths need an import/schema test plus the later small paid probe, not an invented keyless quality claim.
4. **Fault and boundary tests precede live calls.** Kill the service during ingestion, after provider acceptance but before local receipt, and during query; return 429, malformed JSON, HTTP 200 with partial inserts, wrong namespace IDs, late usage, and missing SSE usage. Restart coordinator and worker and verify the terminal matrix and committed budget stay conservative. Test egress denial in the actual Docker topology, not only mocked fetch.
5. **Metered feasibility gates.** Only after those tests, run the smallest planted fact/date/namespace probe on every vendor, then the planned single history. Record exact requests, creation/readiness evidence, retrieval output, provenance, latency and costs. Stop the affected system as `blocked` on unmetered traffic or invalid adapter behavior; preserve the evidence and continue valid independent systems within the existing allowance. No score-based tuning on sealed data.
6. **Counted-run gates.** Freeze and validate the complete campaign manifest, current model identities/prices, renderer/judge versions and receipt schema. Run P1 dev; inspect accounting and adapter fidelity rather than cherry-picking product outcomes. Then P2, PMB, Cat 40 and the custodian batch according to their gates. Publication includes all failures and capability gaps, exact denominators, cold/cache cost disclosures and machine configuration.
7. **Repository checks.** Run targeted `bun test` files for each workstream, then `bun run typecheck`; run the repository's relevant validators for any committed receipts/docs, including manifest hash checks and links. `package.json` has no separate lint script. Measure the lifecycle keyless slice against the 60-second category budget before calling it CI-ready. Full-suite execution is an implementation gate, not something this read-only plan review claimed to perform.

## What already exists: reuse map

| Existing component | Reuse | Boundary to preserve |
|---|---|---|
| `memory-qa/corpus.ts:22–88,185–229,242–272` | Corpus types, loaders, opaque IDs, date helper | Keep labels evaluator-side; date policy needs an explicit timezone |
| `memory-qa/run.ts:165–191,281–327,355–403` | Selection, metrics, gbrain lifecycle and retrieval seam | Preserve legacy CLI; add native recipe separately |
| `memory-qa/qa.ts:32–35,92–100,113–181` | Historical prompts, provider calls, judgment machinery | Do not silently change old defaults; add response validity/context receipts |
| `probe-accounting.ts:43–64` and `stats/rows.ts:55–70` | Product-vs-infrastructure error policy | Canonicalize expected IDs before calling them |
| `stats/paired.ts:70–101,134–202` and `stats/gates.ts:165,241–259` | Pair validation, clustered intervals, few-cluster guard | No duplicate repeat rows or weaker cluster threshold |
| `budget-ledger.ts:814–906,1077–1151` | Durable reservations, prices, usage settlement | Not a distributed object; strengthen reservation bounds for a hard cap |
| `cat40/gbrain-arm.ts:53–132,260–364` | Meter accounting pattern and gbrain slot setup | Extract only shared behavior; do not turn loopback forwarding into a public proxy by changing one string |
| `cat40/loop.ts:79–95,131–178` | Provider-neutral loop and scripted-model hook | Runtime/session/transport ownership belongs outside the loop |
| `cat40/arms.ts:30–45,65–115` | File baseline with isolated overlays | These are useful controls, not a generic passive-memory adapter |
| `precisionmembench/scorer/{baseAdapter,runCases}.ts` | Upstream fixture and scorer contracts | No native-product claims for evaluator-supplied pins/relations/persona |
| `hermetic-env.ts:76–113`, `mutation-kit.ts:78–117` | Hermetic category wrapper and mutation assertions | Environment wrappers need subprocess isolation; all applicable fakes required |
| `eval/runner/lifecycle/{scenario,n1-score,n5-score,drivers}.ts` | Existing scenario/probe conventions and negative controls | Existing gbrain-specific drivers are not portable delete APIs |
| `eval/runner/decide.ts:23–29` | Identity, split and comparison plumbing patterns | Keep two-build gbrain decision workflow separate from n-vendor scheduling |
| `test/eval/decide-kit.test.ts:105–127,170–203` | Existing corpus/packing/cache regression assertions | Add tests; do not redefine old behavior to get green |
| `test/eval/precisionmembench-scorer.test.ts:82–169,289–314` | Scorer parity and live superseded-belief protections | Retain upstream semantics and no answer-key ingestion |
| `test/eval/cat40-model-ladder.test.ts:58–116`, `cat40-tool-list-changes.test.ts:33–35` | Scripted loop, bad-arm, budget, ACL and tool-list tests | Extend to vendor transport/runtime/write-target differences |

There is enough genuine reuse to avoid another statistics package, scorer family, paid-request client, gbrain build resolver or dataset loader. The campaign manifest, validated evidence contract, distributed lease protocol and canonical attempt state machine are genuinely new; hiding them as “small shims” would obscure the difficult work.

## Failure modes registry

“Critical gap” means the current plan names neither a concrete handling path nor a test for a failure that could silently corrupt the result. The fixes below close the proposed gaps; they are not already implemented.

| Path | Realistic failure | Required handling / test | Current gap |
|---|---|---|---|
| Cross-VM spend | Worker restarts with a fresh allowance while the old one spent money | Durable leases, unreconciled reservation retained; `shootout-leases` crash test | **Critical** |
| Proxy | Unknown model/redirect/SSE bypass is forwarded or priced as zero | Fail before forward; actual-network egress and streamed-usage tests | **Critical** |
| PMB | Shared fixture provides answer-bearing expansion, reported as product capability | Explicit upstream table contract; category/canned-result parity test | **Critical** |
| Sealed output | Exact context/answer leaks through shared cache or error log | Custody root plus allowlist export; marker and symlink tests | **Critical** |
| Resume | Duplicate error rows satisfy expected count or QA failure is never retried | Canonical ID state and fixed retries; crash-boundary tests | High |
| Vendor ingestion | Successful SDK call hides second insert failure | `completeness: unknown/degraded`, diagnostic receipts; partial-insert test | High |
| Time | Historical event becomes current date or parallel update races | Frozen date/order policy; tied/out-of-order test | High |
| Provenance | One graph node claims all sessions or another namespace | Validate source membership/status; inflation/foreign-ID tests | High |
| Packing | Oversized top item causes empty context or Unicode exceeds ceiling | Explicit overflow policy and real tokenizer checks | High |
| Reader/judge | Empty/malformed provider response scored as a meaningful answer | Typed dependency/judge error and saved raw response; parse tests | High |
| Query cache/state | Repeated ingestion reuses cached answer; one query influences another | Run identity, cache provenance and read-mutation policy; replay tests | High |
| Lifecycle delete | Deletes all memories and “passes” absence | Presence and survivor floor; delete-all/shared-fact mutation | High |
| MCP/runtime | Restored vendor cell retains prior task write | Fresh namespace/runtime restore evidence; cross-cell contamination test | High |
| Write scoring | `memory_id` target bypasses protected-document check | Canonical write effects/source mapping; protected-target test | High |
| Statistics | Three clusters generate confident ranking language | Few-cluster descriptive gate and report assertion | High |
| Teardown | Readiness hangs or VM persists after run failure | Per-operation deadlines, `finally` disposal, teardown receipt | High |
| Deployment | MCP and core silently resolve different versions | Locked install/import test, digest/version receipt | High |
| Publication | Unsupported or incomplete vendor vanishes from table | Manifest-based report includes every planned system/cell | High |

## NOT in scope

- Implementing or tuning missing vendor memory features. Measure the pinned products through public APIs; unsupported capabilities remain visible.
- Replacing `eval:decide`, the vendored PMB scorer, the statistical library, or historical `memory-qa` defaults. The new campaign consumes them or adds explicit new policies.
- A general distributed scheduler, Python adapter framework or full MCP implementation. One campaign coordinator, a narrow shim protocol and an existing MCP client are sufficient.
- Modifying the current gbrain pin, fixing unrelated gbrain retrieval bugs, or rewriting existing historical reports. Report actionable findings separately with evidence.
- D3's graph/multi-hop and BEAM-1M extensions, full LME-S 500, Cat 35, Cat 41, N6, or either reserved sealed-confirmation set. These remain outside the recommended initial workload.
- Public vendor issues/posts before separate approval. Adapter capability records may be prepared locally without publishing them.
- Claiming native archival retrieval for local Letta before probing it, or wrapping its full agent loop and calling that passive memory QA.
- Guaranteed public 95% rankings from three LoCoMo conversations, or claiming equal quality from all systems reaching a ceiling.

## Implementation task list, in order

Rough engineering effort, not wall-clock promises. “CC” means an assisted coding session including targeted tests; vendor installation/debugging variance and paid-provider waiting are additional. Human time is review/verification judgment, not manual coding of everything.

| Order | Task / dependency | Human effort | CC effort | Exit evidence |
|---|---|---|---|---|
| 1 | Freeze the concrete campaign manifest/schema and baseline capability records; honor D1/D2-A/D3/D4 | 1–2 h | 3–5 h | All axes/expected IDs and claim rules machine-validated |
| 2 | Add durable budget leases, conservative reservations and hardened proxy before live vendor traffic | 2–4 h security/accounting review | 8–14 h | Concurrent/restart/egress tests; no-forward-on-refusal |
| 3 | Add canonical outcomes/resume and custody storage/export | 1–2 h | 5–8 h | Fault-injected terminal matrix and sealed-marker tests |
| 4 | Extract gbrain legacy adapter; add sanitizer, evidence normalization and renderer behind explicit new policy | 1–2 h | 6–10 h | Old CLI/decide tests unchanged; native-context tests pass |
| 5 | Implement one installed vendor vertical slice using fake provider, then tiny metered probe | 1–2 h | 4–8 h | SDK version/API/provenance/readiness proof |
| 6 | Implement remaining independent adapters, locked environments and capability probes | 0.5–1 h/vendor | 3–8 h/vendor | Recorded support matrix; no fabricated provenance/API compatibility |
| 7 | Add reader replay, controls, statistical/report assembly and measured pilot cost matrix | 1–2 h | 4–7 h | Exact context replay and all planned rows in output |
| 8 | Run and preserve P1 dev, then freeze counted remaining cells | 1–2 h interpretation | 2–4 h orchestration plus runtime | Complete matched dev evidence and cost/latency receipts |
| 9 | Build lifecycle-lite with independent oracle, presence/survivor tests and registry contract | 1–2 h | 5–9 h | All applicable shared/new mutations rejected |
| 10 | Add PMB system adapter without altering vendored semantics | 0.5–1 h | 3–5 h | Same 77-case contract and disclosed wrapper contributions |
| 11 | Add Cat 40 vendor runtime/MCP leases and separate native Letta driver | 1–3 h | 8–16 h | Fresh two-session writeback, protected writes, isolation, metering |
| 12 | Custodian executes frozen sealed batch, aggregate export only | 1–2 h custodian | 2–4 h orchestration plus runtime | Logged opening and validated aggregate file |
| 13 | Publish dated report, comparison page/README, receipts and changelogs | 1–2 h claim review | 3–5 h | Hash/link/data checks and every loss/failure disclosed |

**Parallelization.** First implement the shared schema and one vertical slice sequentially. After it stabilizes, use separate worktrees for (A) budget/custody, (B) QA evidence/accounting, and (C) vendor adapters partitioned by vendor; each lane owns disjoint files. Adapter lanes depend on the frozen schema and metering contract. Later lifecycle, PMB and Cat 40 consumers can proceed in separate worktrees after the shared interface is stable; one integrator owns registry, manifest and report changes. No concurrent commits in a shared checkout.

## Completion Summary

- **Status:** DONE_WITH_CONCERNS. The review is complete; the plan needs the 15 engineering amendments above before its relevant gates can pass.
- **Scope challenge:** P1 is the first complete slice; all planned later workloads remain in scope, with clearer dependency gates.
- **Architecture review:** 7 primary findings (1, 3, 5, 6, 9, 10, 11); the diagram names the files and boundaries that must exist.
- **Code-quality review:** 4 primary findings (2, 4, 7, 8); reuse is explicit and historical contracts remain intact.
- **Test review:** Every new path has a proposed regression test; four silent critical gaps are identified in the failure registry. Vendor mock tests are not mistaken for product-quality evidence.
- **Performance/statistics review:** Findings 12–14 fix packing/replay, few-cluster claims, cache accounting and comparable latency. Phase/integration finding 15 fixes gate ordering.
- **Decisions:** 12 auto-decisions/recommendations classified; no questions asked and no authority inferred to increase the cap or post publicly.
- **What was verified:** Repository source and relevant existing test assertions; pinned Graphiti, Mem0, Cognee, Basic Memory, Hindsight and Letta source excerpts; gstack installation check passed. The parity SHA was verified as a gbrain product revision via the committed starting-line receipt references and GitHub commit metadata.
- **What was not verified:** Vendor installation/runtime behavior, model availability/prices at execution time, API dashboard access, real token counts, live egress enforcement or numerical cost estimates. No tests or paid benchmarks were run in this read-only review.
- **Artifacts:** Only `~/.capy/work/shootout-review/eng-astra.md` was authored. No changes to PLAN.md, repository code, tests, TODOS.md or other reviewers' outputs. Workflow state/telemetry writes were omitted to honor the output-only constraint.
- **Durable learnings:** No new personal preference or cross-project operating rule to save; all technical findings are evidence specific to this plan and its pinned sources.
