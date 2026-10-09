# Engineering review (Claude voice): open-source memory shootout, PLAN.md v2

Target: `/workspace/gbrain-evals/docs/plans/2026-10-05-oss-memory-shootout/PLAN.md` (v2, uncommitted, amended after the CEO phase).
Repository HEAD: `d47c40d`. gbrain pin in `package.json:45`: `739e5cc` (installed `node_modules/gbrain` reports 0.60.46.0).
Mode: /autoplan engineering phase, auto-decide, no questions. Method: plan-eng-review (Scope Challenge, Sections 1 to 4, required outputs). Preamble, telemetry, review log and the gstack test-plan artifact are skipped under the hard rule "write only this file"; the test plan is inline below and is **not persisted** elsewhere.
Evidence: every finding quotes or cites code I read on this machine. Vendor claims come from the pinned wheels (temporal-graph, graph-pipeline, extract-first, the memory-bank client and markdown-notes at the pins the comparison table lists, all confirmed on PyPI and unpacked into `/tmp`). agent-runtime and the vendor MCP servers were not unpacked.

## 1. Verdict

The plan is sound in intent and its contracts are the right ones, but four of them are not yet true in the code it builds on: the memory-qa runner appends duplicate rows on resume and silently drops reader failures from the QA mean, the evidence item cannot carry a fact's validity window, provenance-based recall can be inflated by one item that cites every session, and LoCoMo and BEAM dev have 3 and 6 conversation clusters, so the "paired, clustered intervals against gbrain" the report promises can never resolve on them. The architecture also splits gbrain (in-process on the Capy machine) from the vendors (HTTP to Ubicloud VMs), which makes latency, ingest wall time and the budget cap unequal or unenforceable; running the whole cell (harness, shim, proxy, ledger) on one identical VM per system fixes all three with existing tools (`ubi-runner.sh run --setup --pass --pull`, `BudgetRun.reserve/settle`, the existing `MeteringProxy`). With the 25 findings below fixed (most mechanical, none needing new infrastructure beyond the per-vendor shims), P1 is buildable in about one week of CC time, and P2 and P4 should be separate lanes that do not gate the P1 report.

## 2. Findings

Format: `[severity] (confidence) location — problem`. Fix follows. Severity: P1 blocks a trustworthy counted run; P2 should land before the counted run; P3 follow-up.

### Architecture

**A1. [P1] (9/10) `eval/runner/memory-qa/run.ts:235-238, 403, 411-418, 435`; `eval/runner/stats/paired.ts:77, 92-95` — plan contract 7 ("each expected question id gets exactly one terminal outcome") is not what the runner does.**
Resume keeps only error-free ids (`if (!r.error) done.add(r.id);`, run.ts:237), so an errored id is re-run and a second line is appended (`appendFileSync(rowsPath, JSON.stringify(row) + '\n')`, run.ts:403). `run_status` compares line count to expected (`allRows.length < expected ? 'partial' : 'complete'`, run.ts:418), so two lines for one id can mask a missing id. The paired comparator then refuses the file (`if (map.has(row.id)) problems.push(\`${side}: duplicate id ${row.id}\`)`, paired.ts:77). Reader and judge failures set `qa_error` with `error: null` (run.ts:394-396), so they never retry and the QA mean counts only rows with `qa_score` (run.ts:435): a system whose reader calls fail more often looks better. In the comparator, a harness failure on one side only makes eligibility differ and throws (paired.ts:92-95), so one flaky reader call blocks a whole seven-system family.
Fix: split `rows.ndjson` into `attempts.ndjson` (append-only history) and `outcomes.ndjson` (exactly one row per expected id, rewritten by a `finalizeOutcomes()` pass in run.ts). Terminal outcome enum: `scored`, `product_error` (miss, stays in the denominator), `harness_invalid` (retried up to a preregistered N, then excluded), `budget_stop`. A preregistered pre-pairing join excludes an id from every system when any system has `harness_invalid` for it, and the report prints the excluded count. `run_status: complete` means every expected id has a terminal outcome, counted by distinct id.

**A2. [P1] (8/10) PLAN "Architecture" diagram (`MS --> GB[gbrain adapter]`, `MS --> SH[shim per system, HTTP]`, `SH --> VM`) — gbrain runs in the harness process while vendors run behind the internet on Ubicloud VMs.**
run.ts measures latency in-process around `hybridSearch` (run.ts:360-363). A vendor measured from the Capy machine adds internet round trips; gbrain's ingest runs on a 4-core Capy machine while vendors get a 16-vCPU VM. The budget ledger is a local SQLite file (`DEFAULT_LEDGER_PATH = .budget/ledger.sqlite`, budget-ledger.ts:80) and `BudgetAllowance` is in-memory per process (budget-ledger.ts:955-968), so a proxy on a remote VM cannot reserve against the host's cap synchronously. "One parent allowance split across systems, so the sum cannot pass it" has no mechanism today.
Fix: a **cell** is one VM running everything for one system: the Bun harness (run.ts shards), the vendor shim stack, a standalone metering proxy and a VM-local ledger. gbrain gets an identical VM. The ubicloud skill's `ubi-runner.sh run --setup <bootstrap> --pass OPENAI_API_KEY --pull <receipts and ledger>` already does provision, sync, run, pull, destroy. Before launching a cell, the host reserves that cell's whole allowance in the host ledger (`BudgetRun.reserve(usd, description)`, budget-ledger.ts:861); the VM ledger is initialized with that amount as its program cap; after pull the host settles the reservation to the VM ledger's committed total (`settle`, budget-ledger.ts:889). A cell that never reports back keeps its full reservation, which matches the ledger's "can only overstate" rule. Retries reserve again from what is left, so the parent cap holds across reruns.

**A3. [P2] (7/10) PLAN "Namespaces" and `MemorySystem.reset` (no namespace argument); run.ts:299-303, 315-316 — store size differs between gbrain and vendors.**
gbrain gets a fresh, truncated store per conversation (`else if (processed > 0) await reset(engine);`). The plan does not say whether vendor namespaces are co-resident; with a global `reset` and "parallel namespaces" in the Risks table, the natural build puts 100 LongMemEval haystacks in one Neo4j, Qdrant or Postgres. That compares a one-conversation index with a 100-conversation index filtered by namespace, changes latency, and exposes filtered-ANN behavior (a selective filter on an HNSW index can return fewer than k rows) that gbrain never faces. Medium confidence on the ANN effect for any given vendor; the asymmetry itself is certain.
Fix: mirror run.ts for every system: per namespace `reset → ingestSession* → finishIngest → retrieve*`. Parallelism comes from N independent shard processes, each with its own vendor stack on the cell VM (N sized to VM memory), reusing run.ts `--shard i/n` (run.ts:138-140) and the shared budget run (`--budget-run-id`, budget-ledger.ts:53-58).

**A4. [P2] (8/10) `eval/runner/cat40/gbrain-arm.ts:53-132`, `eval/runner/budget-ledger.ts:1174-1180` — the existing metering proxy only fails closed when a paid-request guard is active in the same process.**
The proxy swallows pricing errors (`try { price = priceRequest(target, body ? JSON.parse(body) : undefined); } catch { price = null; }`, line 101) and charges `$0` for unpriced requests (`} else charge(0, false);`, line 123). `priceRequest` throws for an unknown model (budget-ledger.ts:1077-1125), which is exactly the vendor-default case (extract-first `gpt-5-mini` is not in `CHAT_PRICE_OVERRIDES`, budget-ledger.ts:1019-1041). Refusal happens only because `forward` calls global `fetch`, which is `delegatingFetch` (budget-ledger.ts:1176-1180) and re-prices through the guard when one is installed. A standalone proxy that imports the ledger but never calls `startPaidRun` forwards unpriced traffic unmetered.
Fix: extract `MeteringProxy` to `eval/runner/metering-proxy.ts` (two real callers: Cat 40 and the shootout cell), make a pricing throw return 402 without forwarding, add key injection (strip inbound `authorization` / `x-api-key`, inject from the proxy's env), keep the existing `/<slot>/<provider>/…` routing and `bind`/`finalize` (lines 64, 75), and require the standalone entrypoint to call `startPaidRun` first. The plan's "listens on the bridge" is a one-line `hostname` change from `'127.0.0.1'` (line 87).

**A5. [P2] (7/10) PLAN "Phases and gates" Phase 0 and the 12-hour GC rule in the ubicloud skill (`ubirun-*` VMs older than 12 hours are destroyed by any thread's `up`) — long cells die mid-run.**
Graph-system ingest of 100 LME-S haystacks (about 50 sessions each) can pass 12 hours on one VM. Vendor state lives in the VM's containers, so question-level resume (run.ts:232-239) cannot recover a namespace whose store was destroyed.
Fix: size each cell shard to finish in under 8 hours using Phase 0's measured per-session ingest time, record per-namespace completion in `outcomes.ndjson`, and re-ingest only incomplete namespaces on a new VM.

### Code quality and contracts

**C1. [P1] (9/10) PLAN contract 2 (`{ text, source_ids[], event_time?, score? }`); temporal-graph `edges.py:267` (`episodes: list[str]`), temporal-graph edge validity fields; extract-first `memory/main.py:1393-1403` (`reference_date`, `show_expired`) — the evidence item cannot say a fact stopped being true.**
temporal-graph keeps superseded facts as edges with a validity window by design; flattening them to text presents an invalidated fact as current. That biases P1 temporal and knowledge-update questions and all of P2 against the systems whose design is temporal, while the plan's own mitigation ("report retrieval as not measurable") does not cover it. extract-first search also takes `reference_date`, which the interface never passes, so it ranks 2023 conversations relative to a 2026 wall clock.
Fix: `Item = { text, source_ids, event_time?, valid_from?, valid_to?, score? }`; the one renderer prints `[valid 2023-05-01 to 2023-06-02]` when present; `retrieve(ns, question, { k, now })` passes the public `question_date` (corpus.ts:29, already public in `readerPrompt`, qa.ts:64) as `now`.

**C2. [P1] (8/10) PLAN "What the report will say" ("strict session recall where provenance exists"); run.ts:368 — recall from `source_ids` is undefined and gameable.**
Today recall is computed over distinct sessions in rank order, cut at top-k (`uniqueInOrder(results.map(...)).slice(0, a.topK)`). An item may carry many `source_ids` (a temporal-graph edge's `episodes`, a merged extract-first memory). One item that cites every session scores recall 1.0.
Fix: preregister strict recall as `recall_all@5/@10` over the distinct `source_ids` in first-appearance order across items, truncated at K, exactly the current gbrain definition; record per-row fan-out (mean and max `source_ids` per item). The P1 scorer gets a mutation suite: an "always-positive" fake (every item cites every session in the namespace) must fail via `assertScorerRejectsFakeSystems` (mutation-kit.ts).

**C3. [P1] (9/10) `eval/runner/memory-qa/corpus.ts:224-225`; PLAN contract 5 — the namespace id leaks the abstention marker.**
For LongMemEval the conversation id is the question id (`conversations.push({ id: q.question_id, sessions })`) and abstention is `q.question_id.endsWith('_abs')`. The in-process gbrain path never sends conversation ids to gbrain, but every vendor namespace (extract-first `user_id`, temporal-graph `group_id`, memory-bank bank, graph-pipeline dataset) would receive `…_abs` if the adapter uses the conversation id. LongMemEval raw session ids also carry `answer_` prefixes for gold sessions; they must stay behind the existing opaque `occurrenceId` (corpus.ts:50-52).
Fix: `sanitize.ts` maps namespace ids to `sha256(salt, conversation).slice(0,16)` and source ids to `occurrenceId`, and the harness passes a `PublicQuestion` type (text and `question_date` only), reusing the compile-time boundary pattern of `PublicQuery` in `eval/runner/types.ts:226-229`. The runtime tripwire lives in the metering proxy: scan outbound bodies for a forbidden set (raw dataset session ids, question ids, category names, `_abs`), never for answer text (answers legitimately appear in sessions). A hit marks the cell `invalid`.

**C4. [P2] (8/10) `eval/runner/memory-qa/qa.ts:40, 42-45, 51-61`; PLAN contract 2 ("counts tokens with the reader's tokenizer", "first-appearance order") — packing rules conflict with the existing renderer and with D2.**
`approxTokens` is `Math.ceil(s.length / 4)`; `renderHistory` sorts sessions by date (`[...sessions].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))`), not first appearance. Packing with each reader's tokenizer produces a different context per reader, which defeats D2-A's "four frontier readers on frozen contexts", and needs a tokenizer per provider (Anthropic has none offline).
Fix: keep one reader-independent budget unit (`approxTokens`, already tested at `test/eval/decide-kit.test.ts:179`) and record the reader-reported input tokens per row. Preregister: selection in rank order (first item that does not fit ends the pack, as qa.ts:56 does); presentation in date order for source-rehydrated sessions (parity with the starting line) and in rank order for native items.

**C5. [P2] (8/10) PLAN contract 3 ("each system's own default retrieval amount, and a fixed 8,000-token budget") — two budgets would mean two retrieval calls.**
Defaults differ (extract-first `top_k: int = 20`, main.py:1397; graph-pipeline `top_k: int = 15`, recall.py:353). Calling `retrieve` twice doubles query cost and can return different rankings.
Fix: one `retrieve` per (system, configuration, question) at `k_fill` large enough for 8,000 tokens; store the raw items in the attempt row; derive both budgets and both context modes offline with a pure `packItems()` function; the default-amount context is the first `k_default` items. Phase 0 adds a prefix-stability probe (top `k_default` at `k_fill` equals the result at `k_default`) per system and records the result. Reader runs (including D2) then replay from rows without touching vendor stores.

**C6. [P2] (7/10) `eval/runner/memory-qa/corpus.ts:61-74, 254`; temporal-graph client module lines 1043-1055 (`reference_time: datetime` required) — `event_time` can be missing.**
`isoSessionDate` returns null for any format other than LongMemEval, LoCoMo or ISO (line 73). BEAM takes `time_anchor` as-is (line 254); its format was not checked here (dataset not downloaded), hence 7/10. A shim that falls back to `datetime.now()` silently dates every fact to 2026.
Fix: a keyless test per benchmark loader: every session yields an ISO `event_time` or a disclosed synthetic one (monotone, anchored to the first dated session), with the fallback count written to the receipt. Shims reject a missing `event_time` instead of defaulting.

**C7. [P2] (8/10) PLAN contract 8 ("adapters start from vendor code") versus `ingestSession(ns, session, event_time)` — vendor benchmark recipes ingest per message or per turn pair, not per session.**
Fix: `ingestSession` passes the whole session (turns with roles); the adapter chooses the vendor recipe's granularity and the capability record states it; `source_id` stays session-level so recall is comparable. Cost estimates in Phase 0 use the chosen granularity.

**C8. [P2] (8/10) `eval/runner/precisionmembench.ts:1-17`, `eval/precisionmembench/scorer/baseAdapter.ts` (`searchText`, `SearchResult { id, memory }`), `fixtures/retrieval.cases.json` (12 "Scope disambiguation" cases, `scope: ["domain:code"]`) — P3 needs more than `retrieve(ns, …)`.**
The scorer drives `searchText(query, scope[])` and scores returned belief ids. Scope cases need a scope filter or several namespaces per query. The structural categories (pinned facts, relation expansion, open questions) are harness-computed and identical for every provider (precisionmembench.ts header), so the headline precision compresses real differences.
Fix: `retrieve` accepts `ns: string | string[]`, and the shim protocol states the merge rule for systems that cannot search several namespaces at once (round-robin by rank, preregistered). Belief ids map from `source_ids`; a merged item counts as returning every belief it cites. Report the searchText categories (alias, scope, fuzzy, supersession, ranking) as the P3 headline, structural categories separately.

**C9. [P2] (8/10) graph-pipeline `api/v1/recall/recall.py:353-363` (`auto_route: bool = True`; comment: "only_context / verbose inspect retriever-specific shapes. Pin query_type: unspecified hybrid may defer to GRAPH_COMPLETION"); extract-first `memory/telemetry.py:14` (`MEM0_TELEMETRY = os.environ.get("MEM0_TELEMETRY", "True")`) — capability records must pin vendor switches the plan does not name.**
Fix: the graph-pipeline record pins `query_type` and `auto_route`, and the shim normalizes that one shape; `include_references=True` for provenance. Every record lists telemetry switches set off (extract-first `MEM0_TELEMETRY=false`), so fail-closed egress does not surface as ingest errors.

**C10. [P2] (9/10) `node_modules/gbrain/src/core/ai/defaults.ts:15` (`DEFAULT_EMBEDDING_MODEL = 'voyage:voyage-4'`) — gbrain's "documented recipe" row needs a Voyage key that this environment does not have.**
The jam's configured variables are `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `UBICLOUD_API_KEY`. The ledger can price it (`'voyage:voyage-4': { pricePerMTok: 0.06 }`, gbrain embedding-pricing.ts:44) and the proxy already routes `voyage`.
Fix: the Phase 0 capability record for gbrain names `voyage:voyage-4` and its search defaults; without `VOYAGE_API_KEY` that row is `blocked` and the report says so. Listed below as an access item for Garry.

**C11. [P2] (8/10) PLAN "The systems, pinned" gbrain row and Phase 1 ("parity with the starting line at `6622a119e`") — three gbrain identities.**
`6622a119e` is gbrain master v0.60.48.0 (starting-line receipts: `"commit": "6622a119e40ea09a7719233046aca24741863ed2"`), not the repo pin `739e5cc`, and the counted run adds a third "master frozen at one SHA". Each identity multiplies cells.
Fix: parity at `6622a119e` is a harness check only; counted gbrain rows run at the frozen master SHA, labelled with its commit as CLAUDE.md requires when it differs from the pin. Drop the `739e5cc` counted row unless the pin is bumped to the frozen SHA (a separate, docs-wide change).

**C12. [P2] (9/10) `eval/registry.ts:1207`, `test/eval/registry.test.ts:58-70`; `eval/CONTRIBUTING.md` "Add a category" steps 2-3 — repository plumbing the plan omits.**
The registry test fails on any unclassified directory under `eval/runner/` (`if (!RUNNER_HELPER_DIRS.includes(name)) unclassified.push(...)`).
Fix: add `systems` (and `shootout` if used) to `RUNNER_HELPER_DIRS`, `metering-proxy.ts` to `RUNNER_HELPERS`, and a `lifecycle-lite` registry row with promotion rules in the same commit as its runner, before any counted run.

**C13. [P2] (8/10) PLAN P2 and Phase 5; `eval/generators/n5-forget-residue-gen.ts`, `eval/generators/n1-knowledge-update-gen.ts`, `eval/runner/mutation-kit.ts` (`FAKE_SYSTEM_KINDS = ['empty', 'always-positive', 'always-refuse', 'stale', 'wrong-source']`); temporal-graph client module lines 1824-1834; extract-first `memory/main.py:1883` — lifecycle-lite should reuse two existing oracles and needs a witness step.**
N5 already solves "is the fact gone": each canary carries a unique token (`cnry` plus 8 letters) and a witness checkpoint proves presence before the forget. Without a witness, a system whose extractor dropped the fact scores as a perfect forget. Deletion semantics differ: temporal-graph `remove_episode` deletes only edges whose first episode is the deleted one (`if edge.episodes and edge.episodes[0] == episode.uuid`); extract-first deletes memories, not sources (`def delete(self, memory_id)`).
Fix: lifecycle-lite renders N1-style dated value chains and N5 canary tokens as chat sessions, with a witness read before every delete or correction; a pair not witnessed carries no signal and is counted, never scored. Map the plan's mutation list onto the kit: delete-everything is the `empty` fake, stale post-delete is `stale`; leaked ids, inflated provenance and dropped failures are harness contract tests (C3, C2, A1), not answer-space fakes. Each capability record states its delete semantics.

**C14. [P3] (8/10) PLAN P1 data cell ("excluding the question categories P4 has reserved"); `eval/decisions/splits/beam-100k.json` (reservation `"decision": "P4 core memory (always-loaded core page)"`); run.ts:222 — naming collision and a missing filter.**
"P4" there is the held-out program's core-memory decision, not this plan's P4 (Cat 40). run.ts only has an include filter (`a.categories!.includes(q.category)`).
Fix: say "the categories reserved for the held-out program's P4 core-memory decision (`preference_following`, `instruction_following`)", and have the custodian pass the complementary explicit `--categories` list, recorded in the preregistration.

### Test review

**T1. [P2] (9/10) PLAN Phase 1 gate ("every shim passes the keyless fixture") — infeasible as written.**
temporal-graph, graph-pipeline, extract-first with `infer=True` and memory-bank need an LLM to ingest at all; a keyless run of their real code is impossible without per-vendor canned LLM responses. CI (`.github/workflows/ci.yml`) runs no Docker today.
Fix: the keyless CI gate covers the harness: a reference fake shim (TypeScript, in-repo) speaking the shim protocol, the HTTP client, sanitizer, renderer and packer, outcome accounting and the proxy. Each real vendor shim gets a paid Phase 0 smoke (cents) on its cell VM. markdown-notes runs keyless with its local FastEmbed embedder, so it is the real-vendor end-to-end canary on a VM. Optional: proxy record/replay of a vendor's LLM traffic, reporting the cache-miss rate rather than assuming determinism.

**T2. [P1] (9/10) PLAN Phase 1 ("replay parity with the starting line … same retrieved session ids row for row") — the paid parity check alone does not protect the refactor.**
Fix: before moving any code out of run.ts, capture a keyless golden: `runArm` on the `fixture` benchmark with hash embeddings (the path `test/eval/decide-kit.test.ts:153-162` already exercises), rows minus `latency_ms`. After the `MemorySystem` refactor the gbrain adapter must reproduce it byte for byte. The paid starting-line parity stays as a one-time Phase 1 check.

### Performance

**P1. [P2] (7/10) run.ts:360-363; PLAN "What the report will say" (p50 and p95 latency, query cost) — latency and per-query cost are measured at the wrong boundary and under load.**
Retrieval interleaved with other namespaces' ingest measures contention. Per-query cost needs request attribution, and vendor SDKs cannot forward a meter key.
Fix: shims report `service_ms` around the vendor call and the gbrain adapter times the same boundary; queries run as a serial pass after `finishIngest`; the shim calls the proxy's existing `bind(slot, key)` and `finalize(key)` (gbrain-arm.ts:64, 75) around each `retrieve`, so query-time LLM and embedding calls land on the question's row. Ingest cost is attributed per namespace the same way.

**P2. [P2] (7/10) PLAN contract 6 (`finishIngest` waits for quiescence) — a quiescence signal that lies yields silently low scores.**
Fix: after `finishIngest`, a per-namespace readiness probe queries a verbatim sentence from the last ingested session and expects its `source_id` in the top k; failure marks the namespace `ingest-degraded` (the existing 1% rule) and is reported. This adds no inputs to the benchmark data. memory-bank exposes an operations API for `retain_async` (the pinned Python client module, lines 457-471, 388) that the shim can poll.

### Cat 40 (P4)

**K1. [P3] (8/10) `eval/runner/cat40/gbrain-arm.ts:136-160` (`spawn('bun', [join(this.run.buildDir, 'src/cli.ts'), 'serve', ...this.args]`), line 460 (`writeTools() { return this.client.tools.filter(t => t.annotations?.readOnlyHint !== true)… }`); `eval/runner/cat40/arms.ts:210-213`; `eval/runner/cat40-model-ladder.ts:410` — the "generic MCP arm" does not exist and three Cat 40 measures assume gbrain.**
The MCP client is stdio-only and hard-wired to the gbrain CLI; temporal-graph and memory-bank serve MCP over HTTP. Unannotated vendor tools all count as writes, so every cell triggers a restore, and vendor stores have no snapshot or restore today. `unsafe_write` and `evidence_cited` read `path`/`slug`/`id` arguments and document ids, so for vendor tools they read as zero rather than unmeasurable. The judge defaults to `gpt-5.4-mini` (`flag(argv, '--judge') ?? 'gpt-5.4-mini'`), which CLAUDE.md forbids basing decisions on.
Fix: a `McpArm` in `cat40/mcp-arm.ts` on `@modelcontextprotocol/sdk` (present in `node_modules` transitively; add it as a pinned direct dependency) with stdio and streamable-HTTP transports; per-system write-tool lists in the capability record when annotations are absent; Docker-volume snapshot and restore after a writing cell, timed and reported; `unsafe_write` and `evidence_cited` reported as "not measurable" for arms whose tools cannot name a document; an explicit `--judge` in the preregistration. Build this lane after the P1 report, not before.

## 3. Decisions (auto-decided)

| # | Decision | Classification | Principle | Rationale |
|---|---|---|---|---|
| E1 | Attempts and terminal outcomes in separate files; cross-system exclusion join for harness-invalid ids (A1) | Mechanical | 1, 5 | Plan contract 7 already requires it; the code contradicts it |
| E2 | One VM per system runs the whole cell; gbrain on an identical VM (A2) | Mechanical | 2, 4 | Equal hardware and an enforceable cap with existing tools |
| E3 | Host reserves each cell's allowance up front and settles after pull (A2) | Mechanical | 4, 5 | Uses `reserve`/`settle`; no new ledger feature |
| E4 | One namespace resident per vendor stack; parallelism by shards (A3) | Taste | 1, 5 | Matches gbrain's store size; costs some vendor throughput |
| E5 | Extract `MeteringProxy` to a shared module, fail closed on pricing errors, inject keys (A4) | Mechanical | 2, 4 | Two real callers; closes an unmetered path |
| E6 | Cells sized under 8 hours, namespace-level resume (A5) | Mechanical | 2 | The 12-hour GC rule is outside our control |
| E7 | Item carries `valid_from`/`valid_to`; `retrieve` carries `now` (C1) | Mechanical | 1, 5 | Otherwise the comparison is biased against temporal designs |
| E8 | Strict recall over first-appearance distinct sources, cut at K, with fan-out recorded and a mutation fake (C2) | Mechanical | 1, 5 | Same definition gbrain already uses |
| E9 | Hashed namespace ids, `PublicQuestion` type, proxy tripwire on id markers only (C3) | Mechanical | 2 | Closes a concrete leak |
| E10 | One reader-independent budget unit (`approxTokens`); rank selection, date presentation for rehydrated (C4) | Taste | 3, 5 | Keeps parity and frozen contexts; a real tokenizer is a defensible alternative |
| E11 | Retrieve once at `k_fill`, derive budgets and modes offline (C5) | Mechanical | 3, 4 | Halves query cost and enables D2 replay |
| E12 | No silent `event_time` fallback; disclosed synthetic dates counted (C6) | Mechanical | 1, 5 | Silent 2026 dates would corrupt temporal results |
| E13 | Session-level interface, vendor granularity inside the adapter (C7) | Mechanical | 4, 5 | Keeps vendor recipes and comparable recall |
| E14 | PMB: multi-namespace retrieve with a preregistered merge; searchText categories as headline (C8) | Taste | 1, 5 | Reporting choice; structural numbers stay visible |
| E15 | Capability records pin graph-pipeline routing and vendor telemetry switches (C9) | Mechanical | 5 | Determinism and fail-closed egress |
| E16 | gbrain recipe row `blocked` without `VOYAGE_API_KEY` (C10) | User Challenge (access) | 1 | Only Garry can provision the key |
| E17 | Counted gbrain rows at one frozen master SHA; `6622a119e` parity is a harness check (C11) | Taste | 3 | Cuts cells; keeping the pin row is also defensible |
| E18 | Registry plumbing in the same commits (C12) | Mechanical | 1 | The registry test fails otherwise |
| E19 | lifecycle-lite reuses N5 canaries and N1 chains, adds witness, maps fakes to the kit (C13) | Mechanical | 4 | Existing oracles; witness prevents false forgets |
| E20 | Rename the P4 reservation reference; explicit custodian category list (C14) | Mechanical | 5 | Ambiguity |
| E21 | Keyless gate = harness with a reference fake shim; vendor smokes are paid Phase 0; markdown-notes as keyless canary (T1) | Mechanical | 3 | The stated gate is impossible |
| E22 | Keyless golden parity before the refactor (T2) | Mechanical | 2 | Catches refactor drift for free |
| E23 | `service_ms`, serial query pass, per-query proxy binding (P1) | Mechanical | 1, 5 | Comparable latency and cost |
| E24 | Post-ingest readiness probe per namespace (P2) | Mechanical | 1 | Detects lying quiescence |
| E25 | Cat 40 vendor arms on the MCP SDK, built after the P1 report (K1) | Taste | 3, 6 | P4 should not delay P1 |
| E26 | Inference only on sets with at least 10 clusters; LoCoMo and BEAM dev descriptive (S1 below) | Taste | 1, 5 | Statistics code already marks fewer than 10 clusters inconclusive |
| E27 | One shared Python shim app plus a per-vendor adapter module and image (scope challenge) | Mechanical | 4 | DRY across six images with conflicting dependencies |
| E28 | Allow a P1 + P3 report before P2 and P4 finish | Taste | 6 | Shortest path to a useful result; the CEO plan has one report |

## 4. Required sections

### Scope challenge

**S1. [P1] (9/10) PLAN "What the report will say" ("paired, conversation-clustered intervals against gbrain"); `eval/decisions/splits/locomo.json` (dev 3, sealed 7, note: "7 sealed conversations are fewer than the comparator default of 10 clusters, so the sealed split is diagnostic evidence"); `eval/runner/stats/paired.ts:132, 180-199`; `eval/runner/stats/gates.ts:165` (`const minClusters = family.min_clusters ?? 10;`).**
With 3 LoCoMo dev clusters the exact sign-flip test has 2^3 = 8 patterns, so the smallest two-sided p is 0.25; BEAM-100K dev's 6 clusters give 0.031 at best; the gate code marks anything under 10 clusters inconclusive. Only the LongMemEval-S 100 slice (one haystack per question, 100 clusters) supports pairwise inference. Fix: the preregistration names LME-S 100 as the inferential set; LoCoMo dev and BEAM dev are descriptive, printed with `n_clusters`; the custodian may compute pooled dev plus sealed intervals (10 and 20 clusters) as aggregates only. Comparisons reuse `stats/gates.ts` family files (`validateFamily`, `evaluateFamily`) with `cluster_by: conversation`.

**What already solves each sub-problem.** Most of the harness exists: dataset loading and pinning (`memory-qa/corpus.ts`), opaque ids (`occurrenceId`), reader and judge (`memory-qa/qa.ts`), sealed custody (`run.ts:215-218`, `decisions/splits.ts`), sharding and resume (`run.ts`), budget enforcement (`budget-ledger.ts`), a metering proxy with per-cell attribution (`cat40/gbrain-arm.ts`), paired clustered statistics (`stats/`), the mutation kit, the forget and update oracles (N5, N1 generators), the agent loop (`cat40/loop.ts`), and VM provisioning (ubicloud skill `ubi-runner.sh`). The plan's new pieces are the interface, the gbrain adapter refactor, the shim protocol and six shims, the sanitizer, item packing, outcome accounting, the cell runner and lifecycle-lite.

**Smallest change that delivers P1.** Add the `MemorySystem` seam to the existing memory-qa runner rather than writing a new runner; reuse `qa.ts` for reading and judging; ship one Python shim app shared by all vendors; run each system as one VM cell; leave Cat 40, lifecycle-lite and the frontier-reader decision out of the P1 critical path. Counted, that is 9 new TypeScript files, 3 changed TypeScript files, 1 shared Python app, 6 vendor directories (adapter, `pyproject.toml`, `uv.lock`, Dockerfile, compose file), 1 bootstrap script, and 1 preregistration. New services: the shim (one app, six images) and the standalone proxy entrypoint. The complexity gate trips (8+ files, 2 new services). No feature cut is recommended because the six systems are a user direction (CEO decision 1). The **smaller arrangement** is the one recommended here: one shared shim app instead of six bespoke services, the proxy extracted rather than rewritten, and no new runner. Accepted scope: the plan's P1 to P4 features with the fixes above; P1 and P3 first, P2 and P4 as later lanes. Pending remedies: none (auto-decided).

**Distribution.** Shim images build on each cell VM from committed `uv.lock` files and pinned base-image digests; nothing is published to a registry. The bootstrap script installs Docker, Bun and dependencies, mirroring CI.

**TODOS cross-reference.** `TODOS.md:105` ("Retire or repair the historical shootout wrapper", `scripts/RUNBOOK_SHOOTOUT.md`) uses the same word for an unrelated gbrain-config wrapper. Name new paths `systems/` and the report "open-source memory comparison" to avoid confusion; no blocking TODO.

**Search.** Vendor feasibility was checked against the pinned wheels rather than web search: temporal-graph `add_episode(..., reference_time: datetime, group_id, uuid)` and `remove_episode`; graph-pipeline `recall(..., only_context, auto_route, include_references, top_k)`; extract-first `add(messages, user_id, metadata, timestamp, infer)`, `search(..., reference_date, show_expired)`, `delete(memory_id)`; memory-bank `retain(bank_id, content, timestamp, document_id, metadata, retain_async)` and `DocumentsApi.delete_document`; markdown-notes MCP tools `write_note`, `search_notes`, `delete_note`. All plan rows are feasible at their pins; agent-runtime was not checked.

### Architecture (recommended file layout)

```
gbrain-evals/
├── eval/runner/
│   ├── memory-qa/
│   │   ├── run.ts            CHANGED  --system <name>, --context native|rehydrated, --budget-tokens;
│   │   │                              gbrain code moves out; attempts/outcomes split; finalizeOutcomes()
│   │   ├── qa.ts             CHANGED  + renderItems(), packItems() beside packSessions(); validity window
│   │   └── corpus.ts         CHANGED  event_time normalization + disclosed fallback (BEAM)
│   ├── systems/              NEW dir  (add to RUNNER_HELPER_DIRS, registry.ts:1207)
│   │   ├── types.ts          NEW      MemorySystem, Item, PublicQuestion, Capabilities, IngestResult
│   │   ├── gbrain.ts         NEW      importFromContent/hybridSearch path lifted from run.ts:281-368
│   │   ├── http.ts           NEW      one client for every shim (timeouts, service_ms, error origin)
│   │   ├── sanitize.ts       NEW      hashed ns ids, occurrenceId source ids, PublicQuestion builder
│   │   ├── fake.ts           NEW      reference shim in TS for keyless tests (scriptable faults)
│   │   └── registry.ts       NEW      system name -> factory + capability record path
│   ├── metering-proxy.ts     NEW      extracted from cat40/gbrain-arm.ts:31-132; key injection;
│   │                                  fail closed; standalone entrypoint calls startPaidRun
│   ├── cat40/gbrain-arm.ts   CHANGED  imports MeteringProxy from ../metering-proxy.ts
│   ├── shootout-cell.ts      NEW      host side: reserve allowance, ubi-runner run, pull, settle,
│   │                                  merge outcomes; listed as a registry row (tier P)
│   └── lifecycle-lite.ts     NEW (P2) registry row + promotion rules first
├── eval/generators/
│   └── lifecycle-lite-gen.ts NEW (P2) N1 chains + N5 canaries rendered as dated sessions
├── eval/systems/
│   ├── _shim/app.py          NEW      FastAPI: /reset /ingest /finish /retrieve /delete /capabilities
│   │                                  /healthz; service_ms; proxy bind/finalize calls
│   ├── <vendor>/adapter.py   NEW x6   temporal-graph, graph-pipeline, extract-first, agent-runtime, markdown-notes, memory-bank
│   ├── <vendor>/pyproject.toml + uv.lock + Dockerfile + compose.yml + capability.json
│   └── bootstrap.sh          NEW      VM setup (Docker, Bun, deps), mirrors CI
├── docs/benchmarks/2026-10-xx-oss-memory-preregistration.md   NEW
└── test/eval/
    ├── memory-systems.test.ts      NEW  interface, sanitizer, packing, outcomes, fake shim
    ├── memory-qa-golden.test.ts    NEW  keyless parity of the refactor (fixture + hash embed)
    ├── metering-proxy.test.ts      NEW  fail closed, key injection, bind/finalize attribution
    ├── shootout-cell.test.ts       NEW  reserve/settle accounting with a fake VM runner
    └── lifecycle-lite.test.ts      NEW (P2) determinism, scorer, broken adapter, mutation suite

Runtime, per cell (one Ubicloud VM per system, identical class):

  run.ts shard 0..N-1 ──▶ systems/http.ts ──localhost──▶ shim stack k (one namespace resident)
        │                                                     │ vendor SDK, base_url = proxy
        │ reader/judge (qa.ts ChatClient)                     ▼
        └────────────────────────────────────────▶ metering-proxy (bridge IP) ──▶ provider APIs
                                                   │  VM ledger (program cap = cell allowance)
  host: shootout-cell.ts  reserve ─▶ ubi-runner run ─▶ pull receipts + ledger ─▶ settle
```

### Codepath-to-test diagram

```
CODE PATH                                         TEST (file :: case)                                    KEY?
systems/sanitize.ts  hash ns, source ids          memory-systems :: ns ids carry no _abs/raw ids          keyless
systems/sanitize.ts  PublicQuestion               memory-systems :: tsc rejects q.gold (expect-error)     keyless
systems/gbrain.ts    ingest + retrieve            memory-qa-golden :: fixture rows equal pre-refactor     keyless
systems/http.ts      timeout, 5xx, malformed      memory-systems :: fake shim faults -> product_error     keyless
                     harness fault                memory-systems :: fake shim harness fault -> retry,     keyless
                                                  then harness_invalid
qa.ts packItems      rank select, budget cut      memory-systems :: first misfit ends pack; budgets       keyless
                                                  derived from one retrieve
qa.ts renderItems    validity window              memory-systems :: invalidated fact shows its window     keyless
run.ts outcomes      one terminal row per id      memory-systems :: resume after errors -> distinct ids;  keyless
                                                  complete only when all terminal
run.ts outcomes      qa_error accounting          memory-systems :: reader failure is harness_invalid,    keyless
                                                  never dropped from the mean silently
run.ts strict recall first-appearance, cut at K   memory-systems :: mutation suite, always-positive       keyless
                                                  (cite-everything) fails
stats join           cross-system exclusion       memory-systems :: harness_invalid on one system         keyless
                                                  excluded on all; pairObservations succeeds
corpus.ts event_time every session dated          decide-kit (extend) :: per loader, ISO or counted       keyless*
                                                  fallback
metering-proxy.ts    unpriced model               metering-proxy :: 402, nothing forwarded                keyless
                     key injection                metering-proxy :: inbound key stripped, env key sent    keyless
                     forbidden-marker tripwire    metering-proxy :: body with raw id -> invalid           keyless
                     bind/finalize                cat40-followups (existing) + metering-proxy             keyless
shootout-cell.ts     reserve/settle               shootout-cell :: lost VM keeps reservation; retry       keyless
                                                  cannot pass parent cap
_shim/app.py         protocol conformance         run fake.ts contract suite against the shim app with    keyless
                                                  a stub adapter (pytest or bun over HTTP)
<vendor>/adapter.py  real ingest + retrieve       Phase 0 paid smoke on cell VM (dated probe,             paid
                                                  canary isolation, one LoCoMo conversation)
markdown-notes         real end to end              Phase 0 smoke on VM, local FastEmbed                    keyless (VM)
readiness probe      lying quiescence             memory-systems :: fake shim "late index" ->             keyless
                                                  ingest-degraded
lifecycle-lite       oracle, witness, delete      lifecycle-lite :: determinism, scorer negative,         keyless
                                                  broken adapter, mutation suite
cat40/mcp-arm.ts     stdio + HTTP transports      cat40-followups (extend) :: scripted model over a      keyless
                                                  fake MCP server, write-tool fallback list
* needs the pinned dataset downloaded, no key
```

### Test plan

Keyless, in `bun run test` (each with the regression it would catch):

1. **Refactor golden** (`memory-qa-golden.test.ts`): fixture benchmark, hash embeddings, rows minus latency equal a golden captured before moving code. Catches any drift in the gbrain path. Must be committed before the refactor commit.
2. **Outcome accounting**: a fake shim that fails ids 2 and 5 once, then succeeds, and fails id 7 permanently as a harness fault. After resume, `outcomes.ndjson` has one row per id, id 7 is `harness_invalid`, `run_status` reflects distinct ids, and the stats join excludes id 7 for every system. Catches A1.
3. **Sanitizer**: LME-style fixture with `_abs` and `answer_` ids; capture every request body the HTTP client sends; none contains a forbidden marker. Catches C3.
4. **Packing and rendering**: rank selection, whole-item packing, both budgets from one retrieve, validity window printed. Catches C1, C4, C5.
5. **Recall mutation suite**: honest, empty, always-positive (cite everything), always-refuse, wrong-source over a fixture; only honest passes. Catches C2.
6. **Proxy**: unknown model returns 402 and the upstream stub sees nothing; inbound credential replaced; bind/finalize charges the right key; tripwire flags a raw id. Catches A4, C3.
7. **Cell accounting**: fake VM runner that never returns keeps the host reservation; a retry with less than the remaining cap is refused. Catches A2.
8. **Event time**: each loader yields ISO dates or a counted disclosed fallback (dataset needed, no key). Catches C6.
9. **Readiness probe**: fake shim that indexes late is marked `ingest-degraded`. Catches P2.
10. **lifecycle-lite** (P2 lane): CONTRIBUTING step 7 set (determinism, scorer negative, broken adapter, mutation suite) plus witness: an unwitnessed fact never scores as forgotten.

Paid, Phase 0 (per cell VM, logged in the ledger): dated probe, cross-namespace canary, one LoCoMo conversation, prefix-stability probe, proxy versus provider usage within 2%, one LME-S haystack and one BEAM history for the cost estimate. Phase 1 paid: starting-line parity at `6622a119e` on LoCoMo dev rows.

Tests made obsolete: none. `test/eval/cat40-followups.test.ts` keeps working after the proxy move once its import changes.

Pending decisions affecting tests: D2 (frontier readers) only changes which reader replays stored contexts; no test change.

### NOT in scope

- Per-reader tokenizers: the budget unit stays reader-independent (E10).
- A new memory-qa runner: the seam goes into `run.ts`.
- Vendor images in GitHub CI: keyless CI covers the harness and a fake shim; vendor code runs only on cell VMs.
- Cross-namespace co-resident stores: rejected for fairness (E4).
- Bumping the `package.json` gbrain pin to the frozen master SHA: docs-wide change, separate decision.
- Cat 40 vendor arms and lifecycle-lite before the P1 report (E25, E28).
- Recording and replaying vendor LLM traffic as a required test: optional, miss rate reported if attempted.
- agent-runtime API verification: left to Phase 0 as the plan says.

### What already exists (reuse map)

| Need | Existing code | Reuse or rebuild |
|---|---|---|
| Datasets, pinning, splits | `eval/runner/memory-qa/corpus.ts` (`readDatasetFile`, loaders), `eval/runner/decisions/splits.ts` | Reuse unchanged except event-time normalization |
| Opaque ids | `occurrenceId` (corpus.ts:50-52) | Reuse in the sanitizer |
| Compile-time gold boundary | `PublicQuery` in `eval/runner/types.ts:226-229` | Reuse the pattern for `PublicQuestion` |
| Reader, judge, cache, replicates | `eval/runner/memory-qa/qa.ts` | Reuse; add `packItems`/`renderItems` beside `packSessions` |
| Sharding, resume, custody | `run.ts:123-163, 215-240` | Reuse; fix resume per A1 |
| Budget cap across processes | `budget-ledger.ts` shared runs (lines 53-58), `reserve`/`settle` (861, 889), `startPaidRun` | Reuse; no new ledger features |
| Metering proxy with attribution | `MeteringProxy` (`cat40/gbrain-arm.ts:53-132`) | Extract and extend (two callers) |
| Paired clustered statistics | `stats/paired.ts`, `stats/rows.ts`, `stats/gates.ts` | Reuse; add the cross-system exclusion join before pairing |
| Scorer fakes | `eval/runner/mutation-kit.ts` | Reuse for P1 recall and P2 |
| Forget and update oracles | `eval/generators/n5-forget-residue-gen.ts`, `n1-knowledge-update-gen.ts`, `seeded.ts` | Reuse concepts and RNG; render as sessions |
| PMB scorer | `eval/precisionmembench/scorer/*`, `gbrainAdapter.ts` | Reuse; one generic `MemorySystem` adapter beside the gbrain one |
| Keyless fixture | `eval/data/decide-fixture/conversations.json` (4 conversations, 8 questions) | Reuse for golden and fake-shim tests |
| Agent loop and arms | `cat40/loop.ts`, `cat40/arms.ts` | Reuse; new `McpArm` (P4) |
| MCP client | hand-rolled stdio `McpClient` (gbrain-arm.ts:136) | Rebuild generic arm on `@modelcontextprotocol/sdk` |
| VM lifecycle | ubicloud skill `scripts/ubi-runner.sh` (`run --setup --pass --pull`) | Reuse from `shootout-cell.ts` |
| Plain hybrid baseline (D1) | `eval/runner/adapters/vector-grep-rrf-fusion.ts` (`HybridNoGraphAdapter`) | Candidate for D1 if approved, wrapped as a `MemorySystem` |

Shared-code evidence for the proxy extraction: callers are `cat40-model-ladder.ts` (imports `MeteringProxy`, line 51) and the proposed shootout cell (proposed caller, plan "Metering"). Roughly 100 lines move, about 30 lines are added (key injection, fail closed, standalone entrypoint), none removed elsewhere; net growth about 30 lines plus tests, justified by closing the unmetered path (A4) rather than by savings.

### Failure modes registry

| Path | Realistic failure | Test | Handling | User-visible? | Critical gap? |
|---|---|---|---|---|---|
| Resume after errors | Duplicate ids; reader failures dropped from the QA mean | T-plan 2 | outcomes file (A1) | Silent today | **Yes, until A1** |
| Standalone proxy | Unpriced vendor model forwarded unmetered | T-plan 6 | fail closed (A4) | Silent today | **Yes, until A4** |
| Namespace naming | `_abs` reaches vendor `user_id` | T-plan 3 | hashed ids + tripwire (C3) | Silent | **Yes, until C3** |
| Graph validity | Invalidated temporal-graph fact rendered as current | T-plan 4 | item validity window (C1) | Silent bias | **Yes, until C1** |
| Provenance fan-out | One item cites every session, recall 1.0 | T-plan 5 | first-appearance cut + fan-out (C2) | Silent | **Yes, until C2** |
| Missing event time | Shim defaults to now(); facts dated 2026 | T-plan 8 | reject, disclosed fallback (C6) | Silent | **Yes, until C6** |
| Background indexing | Queries before the index is ready | T-plan 9 | readiness probe (P2) | Lower scores, silent | No once P2 lands |
| VM garbage-collected at 12 h | Cell dies mid-ingest | none keyless | shards under 8 h, namespace resume (A5) | Partial run, loud | No |
| Lost VM | Ledger never pulled | T-plan 7 | reservation stands (A2) | Overstated cost, loud | No |
| SSE responses | Usage unreadable, reservation kept | existing ledger tests | ledger overstates by design (budget-ledger.ts:1198-1201) | Overstated cost, reported as unpriced | No |
| One-sided reader failure | PairingError blocks a family | T-plan 2 | cross-system exclusion join | Loud | No |
| Few clusters | Intervals cannot resolve on LoCoMo/BEAM dev | existing `decide-kit` "too few clusters" | descriptive reporting (S1) | Loud if preregistered | No |
| Vendor egress telemetry | Blocked call surfaces as ingest error | Phase 0 smoke | switches off in capability record (C9) | Loud | No |
| graph-pipeline routing | Retriever shape varies by query | Phase 0 smoke | pinned `query_type` (C9) | Loud (parse error) | No |
| Cat 40 vendor writes | No restore, later cells see earlier notes | cat40 extension | volume snapshot restore (K1) | Silent | Deferred with P4 |

Failure modes: **6 critical gaps flagged**, each closed by a P1 task below.

### Worktree parallelization

| Step | Modules touched | Depends on |
|---|---|---|
| Golden + interface + gbrain adapter + outcomes | `eval/runner/memory-qa/`, `eval/runner/systems/`, `test/eval/` | — |
| Proxy extraction | `eval/runner/` (metering-proxy), `eval/runner/cat40/` | — |
| Shim app + fake + protocol tests | `eval/systems/_shim/`, `eval/runner/systems/fake.ts` | interface types |
| Vendor adapters (six) | `eval/systems/<vendor>/` | shim app |
| Cell runner + bootstrap | `eval/runner/` (shootout-cell), `eval/systems/bootstrap.sh` | proxy, interface |
| lifecycle-lite (P2) | `eval/generators/`, `eval/runner/`, `eval/registry.ts` | interface |
| Cat 40 MCP arm (P4) | `eval/runner/cat40/` | proxy extraction |

Lane A: golden → interface → gbrain adapter → outcomes → packing (memory-qa, systems). Lane B: proxy extraction (independent). Lane C: shim app → vendor adapters (after Lane A publishes `types.ts`). Then the cell runner after A and B merge. P2 and P4 lanes start after the P1 report. Conflict flag: `eval/registry.ts` is touched by Lanes A, B and P2; sequence those edits.

### Implementation tasks

Effort assumptions: tests about 50x, scaffolding about 100x, features about 30x, architecture about 5x, research about 3x (human time divided by CC time).

- [ ] **T1 (P1, human ~3h / CC ~10min)** — memory-qa — Capture the keyless golden before any refactor. Surfaced by T2. Files: `test/eval/memory-qa-golden.test.ts`. Verify: `bun test test/eval/memory-qa-golden.test.ts`.
- [ ] **T2 (P1, human ~1d / CC ~45min)** — systems — Add `types.ts` (Item with validity window, `retrieve(ns | ns[], q, {k, now})`, `PublicQuestion`), `sanitize.ts`, `registry.ts`; register the directory. Surfaced by C1, C3, C8, C12. Files: `eval/runner/systems/*`, `eval/registry.ts`. Verify: `bun run typecheck`, `bun test test/eval/registry.test.ts`.
- [ ] **T3 (P1, human ~1d / CC ~45min)** — memory-qa — Move the gbrain path into `systems/gbrain.ts`; `run.ts` gains `--system`, `--context`, `--budget-tokens`; golden still passes. Surfaced by T2. Files: `run.ts`, `systems/gbrain.ts`. Verify: golden test, `decide-kit.test.ts`.
- [ ] **T4 (P1, human ~1d / CC ~40min)** — memory-qa — Attempts and outcomes split, terminal outcome enum, `finalizeOutcomes`, cross-system exclusion join before pairing. Surfaced by A1. Files: `run.ts`, `stats/rows.ts` or a new join helper, tests. Verify: test-plan item 2.
- [ ] **T5 (P1, human ~6h / CC ~30min)** — memory-qa — `packItems`/`renderItems`, one retrieve at `k_fill`, strict recall over first-appearance sources with fan-out, recall mutation suite. Surfaced by C2, C4, C5. Files: `qa.ts`, `run.ts`, tests. Verify: test-plan items 4 and 5.
- [ ] **T6 (P1, human ~4h / CC ~20min)** — corpus — Event-time normalization for BEAM and counted disclosed fallback. Surfaced by C6. Files: `corpus.ts`, `decide-kit.test.ts`. Verify: test-plan item 8.
- [ ] **T7 (P1, human ~6h / CC ~30min)** — proxy — Extract `MeteringProxy`, fail closed on pricing errors, key injection, bridge binding, marker tripwire, standalone entrypoint with `startPaidRun`. Surfaced by A4, C3. Files: `eval/runner/metering-proxy.ts`, `cat40/gbrain-arm.ts`, `eval/registry.ts`, tests. Verify: test-plan item 6; `cat40-followups.test.ts`.
- [ ] **T8 (P1, human ~1d / CC ~45min)** — shims — Shared FastAPI shim app (protocol, `service_ms`, bind/finalize, readiness probe), TS reference fake, HTTP client, conformance suite. Surfaced by T1, P1, P2. Files: `eval/systems/_shim/app.py`, `eval/runner/systems/{http,fake}.ts`, tests. Verify: conformance suite keyless.
- [ ] **T9 (P1, human ~5d / CC ~1d)** — shims — Six vendor adapters and images from vendor benchmark code, capability records (granularity, routing pins, telemetry off, delete semantics, model roles). markdown-notes and extract-first first, then memory-bank, temporal-graph, graph-pipeline, agent-runtime. Surfaced by C7, C9, C13. Files: `eval/systems/<vendor>/*`. Verify: Phase 0 paid smoke per vendor; markdown-notes keyless on a VM.
- [ ] **T10 (P1, human ~1d / CC ~40min)** — cells — `shootout-cell.ts` (reserve, `ubi-runner run`, pull, settle, merge), `bootstrap.sh`, shards under 8 hours. Surfaced by A2, A3, A5. Files: `eval/runner/shootout-cell.ts`, `eval/systems/bootstrap.sh`, `eval/registry.ts`. Verify: test-plan item 7; one fixture cell on a real VM.
- [ ] **T11 (P1, human ~4h / CC ~30min)** — preregistration — Inferential versus descriptive sets, outcome rules, recall definition, packing rule, k_fill, gbrain identity, exclusion join, custodian category list, comparison family files. Surfaced by S1, C11, C14, E10, E14. Files: `docs/benchmarks/2026-10-xx-oss-memory-preregistration.md`, `stats` family JSON. Verify: `validateFamily` on each family file; docs checks.
- [ ] **T12 (P2, human ~3d / CC ~3h)** — lifecycle-lite — Generator from N1 chains and N5 canaries, witness checkpoint, oracle, registry row and promotion rules first, CONTRIBUTING step 7 tests. Surfaced by C13, C12. Files: `eval/generators/lifecycle-lite-gen.ts`, `eval/runner/lifecycle-lite.ts`, `eval/registry.ts`, `test/eval/lifecycle-lite.test.ts`. Verify: test-plan item 10.
- [ ] **T13 (P2, human ~4h / CC ~20min)** — PMB — Generic `MemorySystem` PMB adapter with multi-namespace merge and source-id mapping; searchText categories as headline. Surfaced by C8. Files: `eval/precisionmembench/systemAdapter.ts`, `eval/runner/precisionmembench.ts`. Verify: fake-shim PMB run keyless.
- [ ] **T14 (P3, human ~3d / CC ~3h)** — Cat 40 — `McpArm` on the MCP SDK (stdio and HTTP), write-tool fallback lists, volume snapshot restore, "not measurable" for path-based measures, explicit judge. Surfaced by K1. Files: `eval/runner/cat40/mcp-arm.ts`, `cat40-model-ladder.ts`, `package.json`. Verify: scripted model over a fake MCP server.

### Unresolved decisions

- **E16 / access**: `VOYAGE_API_KEY` for gbrain's documented-recipe row (C10). Without it the row is `blocked`. Add to the plan's "Decisions for Garry".
- No other unresolved decisions in this review; all others were auto-decided above.

### Completion summary

- Step 0: Scope Challenge — scope accepted as-is (smaller arrangement adopted: one shared shim app, proxy extracted, no new runner; P2 and P4 sequenced after P1, not cut)
- Architecture Review: 5 issues found (A1 to A5)
- Code Quality Review: 14 issues found (C1 to C14)
- Test Review: diagram produced, 2 gaps identified (T1, T2)
- Performance Review: 2 issues found (P1, P2)
- Also: 1 scope finding (S1) and 1 Cat 40 finding (K1), reported outside the four-section count
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 0 items proposed (naming note only)
- Failure modes: 6 critical gaps flagged
- Unresolved decisions: 1 (E16, access)
- Outside voice: skipped (the /autoplan run supplies separate voices)
- Parallelization: 3 lanes for P1 (2 parallel from the start, 1 after the interface lands), plus 2 later lanes
- Lake Score: N/A (no interactive answers in auto-decide mode)

### Suppressed findings (confidence 4 or below)

- (4/10) pgvector-backed systems (memory-bank) may under-return on selective bank filters if namespaces are co-resident. Moot once E4 is adopted.
- (4/10) `CHAT_PRICE_OVERRIDES` may lack temporal-graph's and memory-bank's default small models; `canonicalLookup` in the gbrain table may cover them. Phase 0 price registration catches this either way.

## GSTACK REVIEW REPORT

| Field | Value |
|---|---|
| Skill | plan-eng-review (Claude voice, /autoplan engineering phase) |
| Target | `docs/plans/2026-10-05-oss-memory-shootout/PLAN.md` v2 |
| Commit | `d47c40d` |
| Status | issues_open (all mapped to tasks T1 to T14) |
| Issues found (four sections) | 23 |
| Critical gaps | 6 |
| Unresolved | 1 (access: `VOYAGE_API_KEY`) |
| Mode | FULL_REVIEW |
| Review log, telemetry, test-plan artifact | not persisted (hard rule: this file only) |
