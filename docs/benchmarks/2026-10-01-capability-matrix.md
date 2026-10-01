# Capability and entrypoint matrix for the eval-category wave (Step 0)

Purpose. This page fixes what gbrain actually implements, and through which entrypoint, for the nine categories of the eval-category wave, before any runner is written. It applies amendment 3 of the wave plan: a category scores only capabilities that exist at the tested commit. A capability that does not exist is recorded as a gap in that category's report, never scored as a failure, and never fed to the fix wave as a "bug". Every claim below cites a line in the gbrain tree that was read, and the behavioural claims are backed by keyless probes listed in the appendix (referenced as P1 to P11).

Tested code: gbrain `3a284aea26889b77c633aebb4149c3016d834ee6` (v0.60.26.0). Line references are `src/...:N` relative to the gbrain repo root. The tree read was a clean checkout of that commit; its `src/` is byte-identical to `node_modules/gbrain/src` in this repo (checked with `diff -rq`, no output).

## Transport legend

| Code | Transport | Trust posture | Ref |
|---|---|---|---|
| IN | In-process import of an internal function | caller decides | n/a |
| OP | Operation handler with a trusted local context (`remote: false`). Reached in-process via `handleToolCall`, or from a shell via `gbrain call <op> <json>` | trusted | `src/mcp/server.ts:456-478`, `src/commands/call.ts:11-19,89` |
| STDIO | stdio MCP (`gbrain serve`) | **untrusted** (`remote: true`), keeps `localOnly` ops listed | `src/mcp/server.ts:318-322`, `src/mcp/server.ts:199-203` |
| HTTP | HTTP MCP (`serve-http` and the legacy bearer transport) | untrusted (`remote: true`), `localOnly` ops filtered and refused | `src/commands/serve-http.ts:805-807`, `src/mcp/http-transport.ts:200-203,529`, `src/mcp/dispatch.ts:539-548` |
| CLI | Named CLI command: either an op with a non-hidden `cliHints.name`, or a `CLI_ONLY` command in the command table | trusted (`remote: false`) | `src/cli.ts:74-80`, `src/cli.ts:1509`, `src/cli/command-table.ts:343` |

Two registry facts drive most rows. First, stdio MCP is untrusted too, so every handler that branches on `ctx.remote !== false` refuses or redacts on stdio exactly as on HTTP. Second, an op whose `cliHints` is `hidden` is not registered as a CLI command (`src/cli.ts:74-80`); it is reachable from a shell only through `gbrain call`. The registry has 153 ops, 19 of them `localOnly` (P1). There is no per-op "remote exposure" flag beyond `localOnly`, `scope`, `requiredScopes` and `publishGateKey` (`src/core/ops/contract.ts:470-550`); remote suspension is done inside handlers.

## Summary

| Category | Exists (entrypoints) | Transports | Not implemented (record as gap) |
|---|---|---|---|
| N1 knowledge-update | Explicit fence supersession (`superseded by #N`, reconciled by the `extract_facts` cycle phase); implicit supersession in `remember` (embedding cosine >= 0.95, same kind, different text); `ontology_propose` / `ontology_get asof`; `find_trajectory`; `takes_supersede` | All ops are network ops: OP, STDIO, HTTP, CLI. `ontology_get` redacts diary provenance for remote callers | No op to supersede a fact directly; implicit discovery is off without an embedding provider; no natural-language change detection; S9 only proposes |
| N2 contradiction-surfacing | `runContradictionProbe` (injectable `judgeFn`, `searchFn`); `gbrain eval suspected-contradictions`; `find_contradictions` (reads latest stored run); `ontology_conflicts` (deterministic) | Probe: IN, CLI only. `find_contradictions` returns an empty note to STDIO, HTTP **and** default-scoped CLI; only `--source __all__` local calls see data (P4) | No corpus-wide or fact-identity scanner; pair discovery limited to top-K per supplied query; resolutions are paste-ready proposals, never applied |
| N5 forget-residue | `forget` verb, `forget_fact` op, `gbrain forget`; durable `fact_withdrawals` ledger plus insert trigger; fence strike; chunk rebuild without forgotten rows | All write-scope network ops: OP, STDIO, HTTP; CLI via `gbrain forget` | Semantic paraphrase retraction (matching is lexical, P3); prose outside the fence; page history, files, backups, Markdown export; takes, ontology, timeline |
| A4 abstention | `gradeRetrievalConfidence` attached as `crag` meta on the `query` op; optional CRAG escalation; S4 `answerable` in think (and diagnostic-only in query) | `query`: OP, STDIO, HTTP, CLI. `crag_think` escalation local only. think keyless returns gather-only | No keyless answerability or abstaining answerer; CRAG grades retrieval, returns `strong` on an exact title match with no answer text (P5); S4 off keyless and not a key default; S4 cannot abstain on an identity hit (P5) |
| N7 open-loops-email | `detectThreadLoop` / `applyThreadLoopVerdict` (Gmail turn-flip machine); `runLoopsExtract` (LLM commitments, upsert-only); `markStaleLoops`; ops `open_loops`, `loops_close`, `loops_mute`; `gbrain waiting`, `gbrain loops` | Detector and extractor: IN only (run inside Google sync and a minion job). Loop ops: OP, STDIO, HTTP (remote evidence redacted), CLI via `waiting`/`loops` | Promise-fulfillment reconciliation; a reply never closes an extracted commitment; Slack and calendar are not loop sources; ranking, staleness and closure timestamps use the wall clock |
| N8 proactive-recall | `volunteer_context` op (`volunteerContext`); `assembleTurnContext` behind IPC `turn_context`; `context_pack` / `delta` verbs; S6 `recall_needed` | `volunteer_context`: OP, STDIO, HTTP, CLI. `turn_context`: IPC only (`gbrain hook user-prompt` to serve), not an op (P1, P10) | General associative recall; private facts never enter turn-context hot facts; S6 off keyless and not a key default |
| N9 multi-hop-paraphrase | `parseRelationalQuery` (regex, one relation set); relational arm in hybrid search (fanout depth <= 3, or two-seed intersection); `traverse_graph` op | `search` / `query` / `traverse_graph`: OP, STDIO, HTTP, CLI | Composed multi-relation query plans; nested seed phrases are taken verbatim (P7) |
| N12 format-fidelity | `transcriptAdapters()`: 7 formats (P8); `gbrain transcripts`; `parseConversation` with 20 built-in patterns (P8); opt-in LLM fallback; attendance extraction in `link-extraction.ts` | IN, CLI only. No ingest op; `get_recent_transcripts` is `localOnly` (STDIO only) | Generic JSON adapter (none; JSON body is `no_match`, P8); LLM polish phase is declared but not wired; attendance is not a parser output |
| N13 code-intelligence | Ops `code_def`, `code_refs`, `code_callers`, `code_callees`, `code_blast`, `code_flow`; CLI `code-def`, `code-refs`, `code-callers`, `code-callees`, `reindex-code` | All six ops throw `permission_denied` on STDIO and HTTP (P9). `code_blast` and `code_flow` have no named CLI command; only `gbrain call` or IN | Semantic references (`code_refs` is substring ILIKE); cross-file resolution in the symbol resolver; blast/flow outside TS/TSX/JS/Python; real control or data flow |

System One across all categories: with no TypeSafe key every slot resolves `off` (P2). With a key, only `triage` and `conflict` default on (P2), so S4 `answerable` and S6 `recall_needed` stay off unless explicitly enabled even on a keyed install.

---

## N1 knowledge-update

**What exists.**
- Explicit supersession. A struck fence row with context `superseded by #N` parses to `supersededBy: N` (P3) and the pure resolver maps the page-local row number to a fact id, refusing self-references, dangling rows and cycles with a warning (`src/core/facts/supersede-resolve.ts:1-13,79-115`, P3). The fence is reconciled into the facts index by the `extract_facts` cycle phase, which is deterministic and treats the fence as canonical (`src/core/cycle/extract-facts.ts:1-18`); struck rows get `expired_at` in the mapper (`src/core/facts/extract-from-fence.ts:14-21`). There is no op that supersedes a fact directly (P1: `supersede_fact` absent). The write path is `put_page` with an edited fence, then a cycle run.
- Implicit supersession. `remember` (`src/core/verbs.ts:62`) goes through `writeSingleFact`: top dedup candidate with cosine >= 0.95, same kind and different text supersedes; same text is a duplicate (`src/core/facts/write-single.ts:1-19,28,140-166`). With no embedding provider, dedup and supersession are skipped and `degraded_dedup: true` is returned (`src/core/facts/write-single.ts:113-126`). Keyless `isAvailable('embedding')` is false (P11), so this path is off in a hermetic run unless an embedding endpoint is configured. The gateway's embed test seam (`src/core/ai/gateway.ts:721`) does not flip `isAvailable('embedding')`, which checks configuration (`src/core/ai/gateway.ts:1004`).
- Ontology validity windows. `ontology_propose` writes (it is not a proposal queue despite the name): idempotent on entity, dimension, value and source, a new value supersedes the prior, a backdated conflict is flagged rather than rewritten (`src/core/ops/chronicle.ts:153-188`). `ontology_get` reads the resolved value at `asof` (valid time) and redacts diary-sourced rows for remote callers (`src/core/ops/chronicle.ts:128-151`).
- `find_trajectory` charts typed metric and event rows of an entity with regressions and drift; remote callers see `world` facts only (`src/core/ops/insights.ts:250-338`).
- Takes have their own explicit supersession op, `takes_supersede` (`src/core/ops/takes.ts:447`).
- Superseded fence rows stay in the chunked search text; forgotten rows do not (`src/core/remote-body.ts:40-43`, P3). A search hit on an old value can therefore be a correctly struck historical row, which a stale-served metric must distinguish.

**Transports.** `remember`, `entity`, `recall`, `put_page`, `search`, `query`, `ontology_*`, `find_trajectory`, `takes_supersede` are all non-`localOnly` (P1): OP, STDIO, HTTP; CLI where a `cliHints` name exists (`remember`, `entity`, `ontology`, `ontology-add`, `find-trajectory`, `search`, `query`), otherwise `gbrain call`. `recall` and `forget` are `CLI_ONLY` commands rather than op CLI names (`src/cli/command-table.ts:289,191`). `writeSingleFact`, the fence parser and the resolver are IN.

**Not implemented.** Direct fact-supersede op; implicit update discovery without embeddings; natural-language change detection beyond the 0.95 near-duplicate rule; automatic application of S9 conflict findings.

**System One.** S9 `conflict` sweeps facts written since a watermark and only creates pending `decide_proposals`; it never supersedes (`src/core/ai/decide/sweep.ts:1-14`). Accepting a proposal is a separate checked operation (`src/core/facts/proposal-supersede.ts:1-16`). S2 `intent` can replace the regex `knowledge_update` intent that gates trajectory in think (`src/core/think/decide.ts:4-8`). Keyless: all off (P2). With a key, `conflict` defaults on (P2), which still only proposes.

Scoreable hermetically at this commit: explicit fence supersession through the cycle phase, ontology valid-time reads (`ontology_get asof`, backdated-conflict flagging), `find_trajectory` ordering and regressions, and current-vs-historical delivery through `search`/`recall`/`entity` on PGLite; implicit supersession is not scoreable without an embedding endpoint.

## N2 contradiction-surfacing

**What exists.**
- `runContradictionProbe` (`src/core/eval-contradictions/runner.ts:243`). For each supplied query it runs search (default `hybridSearch`, top-K 5), builds every distinct-slug pair among the top-K plus chunk-versus-take pairs for each result page, applies the date pre-filter, sorts by combined score and judges each surviving pair (`src/core/eval-contradictions/runner.ts:1-25,57,155-215,316-428`). `judgeFn` and `searchFn` are injectable (`src/core/eval-contradictions/runner.ts:78-80,281-284`). A judge exception is recorded as an error row, never as "no contradiction" (`src/core/eval-contradictions/runner.ts:419-421`, P4).
- The "cap" is a USD budget, not a pair count: default $5, a pre-flight estimate that throws `PreFlightBudgetError` unless `yesOverride`, and a mid-run stop (`src/core/eval-contradictions/runner.ts:70-75,280-299,371-374`). Pairs outside the top-K of a supplied query are never generated.
- Date filter: both texts carry explicit dates more than 30 days apart, and the pages lack effective dates, so the pair is skipped before judging; when both pages have effective dates it is not skipped (`src/core/eval-contradictions/date-filter.ts:1-26,159-185`, P4).
- Resolutions are proposals. `auto-supersession.ts` classifies each finding into a resolution kind and a paste-ready command and never applies it (`src/core/eval-contradictions/auto-supersession.ts:1-24`); one kind points at a deferred timeline writer (`src/core/eval-contradictions/types.ts:55-72`).
- `find_contradictions` triggers no probe; it reads only the latest run within 30 days and filters it (`src/core/ops/insights.ts:175-246`). It returns an empty note for any remote caller and for any local call carrying a source filter (`src/core/ops/insights.ts:197-200`). The CLI context always sets a source id, `default` when nothing else resolves (`src/cli.ts:1515`), so `gbrain find-contradictions` without `--source __all__` also gets the empty note (P4). Runs are persisted by the CLI command, not by the runner (`src/commands/eval-suspected-contradictions.ts:18-20,368`).
- `ontology_conflicts`: deterministic, dimensions with two or more distinct current values from two or more provenances, explicitly "not temporal supersession" (`src/core/ops/chronicle.ts:201-223`).

**Transports.** Probe: IN, and CLI via `gbrain eval suspected-contradictions` (`src/cli/command-table.ts:217`, thin client refused). `find_contradictions`: registered on every transport (P1) but only useful as OP or CLI with `__all__` scope (`src/core/source-resolver.ts:154,166` pass `__all__` through from flag or env). `ontology_conflicts`: OP, STDIO, HTTP, CLI (`ontology-contradictions`), with remote diary redaction.

**Not implemented.** Corpus-wide or fact-identity-aware conflict discovery; applied resolutions; pair discovery outside query-driven top-K.

**System One.** None in the probe path (no decide import under `src/core/eval-contradictions/`). The S9 `conflict` slot works on facts, not page chunks, and only proposes (`src/core/ai/decide/conflict.ts:1-3`, `src/core/ai/decide/sweep.ts:1-14`). Keyless off (P2).

Scoreable hermetically at this commit: candidate-pair discovery (which planted pairs were offered to a recording judge), date-filter skips, error accounting and the oracle-judge ceiling via injected `judgeFn`/`searchFn`; `ontology_conflicts` end to end; `find_contradictions` read-back only with `__all__` scope. Classification quality needs the paid judge.

## N5 forget-residue

**What exists.**
- Verbs and ops: `forget` verb (opaque id, expires, keeps audit trail; `src/core/verbs.ts:342-383`), `forget_fact` op (`src/core/ops/facts.ts:929-943`), CLI `gbrain forget` (`src/cli/command-table.ts:191`). Both ops submit the same forget mutation.
- Durable withdrawal. A `fact_withdrawals` row keyed on source, visibility, subject and normalized-claim fingerprint, and a BEFORE INSERT/UPDATE trigger that expires any matching fact on reinsertion (`src/core/facts/withdrawal-schema.ts:20-66`). `recordFactWithdrawal` expires every matching active fact for that subject (or source-wide for subjectless facts), bumps affected pages' revisions and **deletes their content chunks** for rebuild (`src/core/facts/withdrawal.ts:12-60`). Re-remembering the exact claim is refused (`src/core/facts/write-single.ts:105-110`). Discovery is bounded to 256 pages per withdrawal (`src/core/facts/withdrawal-discovery.ts:7,24`).
- Fence and chunks: the fence row is struck with a `forgotten:` marker (`src/core/facts/withdrawal-overlay.ts:9-15`); the chunker drops forgotten rows (`src/core/remote-body.ts:40-43`, P3).
- Normalization is lexical: case, whitespace and listed punctuation fold; a paraphrase gets a different fingerprint (`src/core/facts/withdrawal-schema.ts:1-17`, P3).

**Retained by design.** `src/core/facts/forget.ts:1-10` states that original prose, files and backups may retain text and that a Markdown-only clone does not carry DB-only withdrawals. Probe P3 shows a prose sentence outside the fence survives in the chunked text. Page history stays readable through `get_versions` (`src/core/ops/admin.ts:163`). `forget.ts`, `withdrawal.ts` and `withdrawal-discovery.ts` contain no writes to takes, ontology observations or timeline entries (grep), so those tiers keep any copy.

**Transports.** `forget` and `forget_fact`: write scope, non-`localOnly` (P1): OP, STDIO, HTTP. CLI: `gbrain forget`. Withdrawal functions are IN.

**Not implemented.** Semantic paraphrase retraction; physical erasure of history, files, backups and exports; propagation into takes, ontology, timeline or synthesized pages. The chunk deletion on affected pages means retained neighbours on the same page are unsearchable until rebuild; that is an exposure condition a retained-neighbour control should time, not a capability gap.

**System One.** No decide hook in the forget path (no decide import in `src/core/facts/forget.ts` or `withdrawal*.ts`). Dream-phase slots `triage` and `grounding` sit on `dream` call sites (`src/core/ai/decide/slots.ts:64-72`) and could matter for derived tiers. Keyless off (P2).

Scoreable hermetically at this commit: zero prohibited active output after forget across facts recall, entity, fence, chunk search and reimport (trigger), exact-normalized reactivation refusal, retained-neighbour collateral, and honest reporting of retained prose/history tiers; paraphrase residue is reportable only as a gap.

## A4 abstention

**What exists.**
- `gradeRetrievalConfidence` is zero-LLM and grades the top result: identity signals (`exact_lookup`, alias hit, `exact_title_match`, `high_vector_match`) give `strong`, a reranker score at or above 0.2 gives `strong`, `keyword_exact` gives `moderate`, otherwise `weak` (`src/core/search/crag.ts:1-33,61-107`). An exact title match with no answer-bearing text is `strong` (P5).
- The `query` op attaches `crag` (confidence, reason, query shape) to its response meta on every call (`src/core/ops/search.ts:725-741,889-890`). `search` does not. Escalation (`search.crag_escalation`) and think escalation (`search.crag_think`, local callers only) are config-gated and default off (`src/core/ops/search.ts:742-760`, `src/core/search/crag.ts:20-30`).
- think without a chat provider returns the gather without synthesis (`src/core/think/index.ts:784`, `src/core/think/index.ts:1113-1116`), so there is no keyless answer to abstain from.
- S4 `answerable` (think): abstains only when the probability is below threshold minus margin, coverage is complete, and there is no identity hit or deterministic strong CRAG grade (`src/core/think/decide.ts:9-18,114-131`, `src/core/ai/decide/answerable.ts:62-68`, P5). In `query` S4 is diagnostic only and never changes results (`src/core/search/decide-retrieval.ts:1-10`).

**Transports.** `query`: OP, STDIO, HTTP, CLI (P1). `think`: OP, STDIO, HTTP, CLI, but synthesis needs a chat model. `gradeRetrievalConfidence` and `reduceAnswerable`: IN.

**Not implemented.** Keyless answerability or an "I don't know" answerer; attribute-level sufficiency in the CRAG grade; S4 abstention on exact-entity / missing-attribute questions (blocked by the identity-hit rule).

**System One.** S4 `answerable` (think, query) and S3 `evidence` (a cleared S3 stamp makes CRAG `strong`, `src/core/search/crag.ts:90-93`). Keyless off; S4 is not in the key-default set either (P2).

Scoreable hermetically at this commit: the CRAG grade's operating points against evidence sufficiency through the `query` op meta (including the exact-entity/missing-attribute "strong" case), and the S4 reducer logic as a pure function; answer abstention needs a paid answerer.

## N7 open-loops-email

**What exists.**
- Mechanics: `detectThreadLoop` is a pure Gmail thread-turn machine with grace windows (inbound 24 h, outbound 72 h), noise, calendar, list, self-thread and CC-only exclusions, outbound requiring a `?`, and turn flip as the only close signal (`src/core/google/loop-detect.ts:1-26,40-41,83-170`, P6). It takes `now` as a parameter. `applyThreadLoopVerdict` closes answered thread loops and upserts open ones (`src/core/google/loop-detect.ts:217-262`); its `now` defaults to wall clock and Google sync calls it without one (`src/core/google/google-source.ts:607-608`). Any reply flips the turn: "Thanks!" closes an inbound loop (P6).
- Semantics: `runLoopsExtract` is one LLM call per thread page extracting commitments and pending decisions, projected into `open_loops`, a facts row and an edge (`src/core/google/loops-extract.ts:1-25,284`). The prompt tells the model fulfilled promises are not open (`src/core/google/loops-extract.ts:159`), but persistence only upserts what was extracted (`src/core/google/loops-extract.ts:401-456`, `src/core/loops/loops-store.ts:106-165`); nothing marks a previously extracted commitment fulfilled. Keyless it throws a retryable `llm_unavailable` (`src/core/google/loops-extract.ts:329-338`).
- Store: reply auto-close touches only `deterministic_thread` loops (`src/core/loops/loops-store.ts:187-203`); staleness closes `llm_extract` loops overdue more than 14 days or idle 90 days, using SQL `now()` (`src/core/loops/loops-store.ts:237-258`).
- Ops: `open_loops` (grouped and ranked, remote callers get redacted evidence; `src/core/ops/loops.ts:278-300`), `loops_close` (manual done/dropped; `src/core/ops/loops.ts:454-470`), `loops_mute`. Group ranking and source staleness use `Date.now()` (`src/core/ops/loops.ts:67,218-230`).
- CLI: `gbrain waiting` refuses stale data unless `--stale-ok` (`src/commands/loops.ts:76-118`) and `gbrain loops`, both dispatching through `handleToolCall` (`src/commands/loops.ts:17-25,96`; `src/cli/command-table.ts:301-302`).

**Transports.** Detector and extractor: IN only (sync and a minion handler, `src/core/minions/handlers/loops-extract.ts:19-20`). `open_loops`, `loops_*`: OP, STDIO, HTTP (redacted), CLI via `waiting`/`loops`.

**Not implemented.** Promise-fulfillment state; Slack (no connector: providers are `chatgpt` and `claude` only, `src/core/connectors/providers/`); calendar commitments (calendar mail is excluded from loops, `src/core/google/loop-detect.ts:94-108`); a pinnable clock for ranking, staleness and close timestamps.

**System One.** None (no decide import under `src/core/google/` or `src/core/loops/`).

Scoreable hermetically at this commit: Gmail thread-state open/hold/close verdicts with synthetic `GmailThreadData` and a pinned `now` through `detectThreadLoop`, plus store-level closure and manual close on PGLite; `waiting` ranking only with an in-process clock override; promise extraction and fulfillment need the paid extractor and are a gap on the fulfillment side.

## N8 proactive-recall

**What exists.**
- `volunteer_context` op: zero-LLM, confidence-gated (alias 0.9, exact title 0.8, slug suffix 0.6, gate 0.7), at most 3 pages (`src/core/ops/insights.ts:23-116`, `src/core/context/volunteer.ts:1-24,275`). Window parsing folds unprefixed continuation lines into the previous turn (P10).
- `assembleTurnContext`: reflex pointers, volunteered pages and hot facts under an 8 KB budget; hot facts are built with `remote: true`, so only `world` facts are injected (`src/core/context/turn-context.ts:1-23,197-311`). It is served over IPC `turn_context` (`src/core/context/resolve-ipc.ts:22,153,822-831`), driven by `gbrain hook user-prompt` (`src/cli/commands/hook.ts:28`). There is no `turn_context` op (P1, P10).
- `context_pack` and `delta` verbs use the same module's pack and delta assemblers (`src/core/ops/facts.ts:599-640,709`).

**Transports.** `volunteer_context`, `context_pack`, `delta`: OP, STDIO, HTTP, CLI (P1). `assembleTurnContext`: IN, or IPC through a running serve.

**Not implemented.** General associative recall beyond entity mentions in the window; private facts in turn context; agent use of the injected block.

**System One.** S6 `recall_needed` runs concurrently in turn mode only and can fire one keyword search or suppress the reflex window (`src/core/context/recall-needed.ts:1-22`, `src/core/context/turn-context.ts:213-311`). `volunteer_context` has no S6 (no decide import in `volunteer.ts`). Keyless off, not a key default (P2).

Scoreable hermetically at this commit: final delivered bytes of `assembleTurnContext` (turn mode) and `volunteer_context` on trigger, negative and innocuous turns, including session dedupe and the world-only fact posture; S6 is not scoreable without a key.

## N9 multi-hop-paraphrase

**What exists.**
- `parseRelationalQuery`: pure regex archetypes (`who_rel`, `who_at`, `connects`, `intro`) returning one or two seeds, one link-type set and a direction (`src/core/search/relational-intent.ts:1-48,337`). It does not compose relations: "Which people work for companies backed by Fund Example?" yields one `works_at` relation seeded by the whole phrase, and "Which employers have staff who advise Acme?" yields only `advises` into Acme (P7).
- `relational-recall.ts`: single-seed fanout, or for `connects` the intersection of two fanouts (`src/core/search/relational-recall.ts:285-337`). Fanout walks the same link-type set at every hop, default depth 2, hard cap 3, within one source (`src/core/types.ts:1505-1523`, `src/core/engine.ts:1550-1565`). The arm feeds hybrid search, including the keyless path (`src/core/search/hybrid.ts:1078,1108`).
- `traverse_graph` op for explicit graph walks (`src/core/ops/links.ts:248`).

**Transports.** `search`, `query` (with `relational` override, `src/core/ops/search.ts:722-723`), `traverse_graph`: OP, STDIO, HTTP, CLI. Parser and fanout: IN.

**Not implemented.** Composed multi-relation plans (different edge types per hop), nested or quantified seeds.

**System One.** S1 `rerank` and S2 `intent` on the search path (`src/core/ai/decide/slots.ts:36-43`); none in the parser or arm. Keyless off (P2).

Scoreable hermetically at this commit: parse success and seed shape on held-out wording, relational arm firing and supporting-fact delivery for single-relation and `connects` questions on PGLite keyword search; composed questions are recordable only as a capability gap at the parse stage.

## N12 format-fidelity

**What exists.**
- `transcriptAdapters()` registers seven formats: `hermes`, `openclaw`, `codex`, `claude-code`, `grok`, `claude-export`, `chatgpt` (`src/core/transcripts/detect.ts:76-86`, P8). Messages carry `role` (`user` or `assistant`), optional `speaker`, and a source timestamp that adapters must never invent (`src/core/transcripts/types.ts:17-43`). Zero-yield files return diagnostics (`src/core/transcripts/types.ts:11-14,95-101`).
- `parseConversation`: 20 built-in patterns (P8), phases `regex_match`, `polish`, `llm_fallback`, `no_match`, with `timezone_warning`, `unrecognized_headings` and `date_fallback_count` diagnostics (`src/core/conversation-parser/types.ts:37-103`, `src/core/conversation-parser/parse.ts:657`). Time-only formats with no date get `1970-01-01` timestamps and a UTC warning (P8). The LLM fallback runs only on a true built-in miss and only when `conversation_parser.llm_fallback_enabled` is set (`src/commands/extract-conversation-facts.ts:1003-1012`). No code path sets phase `polish` (grep).
- Attendance is a separate link-extraction stage that types person links as `attended` on meeting pages with attendance evidence (`src/core/link-extraction.ts:660-685,988`).

**Transports.** IN; CLI `gbrain transcripts` (thin client refused), `extract-conversation-facts`, `conversation-parser` (`src/cli/command-table.ts:274,239,258`). No ingest op; `get_recent_transcripts` is `localOnly` (P1), so STDIO only.

**Not implemented.** A generic JSON adapter (none registered; a JSON body is `no_match`, P8); LLM polish; attendance as a parser field; meeting-speaker semantics in the transcript seam (roles are user/assistant).

**System One.** None (no decide import under `src/core/transcripts/` or `src/core/conversation-parser/`).

Scoreable hermetically at this commit: speaker/role, turn order and timestamp semantics for the seven registered adapters and 20 built-in patterns, honest zero-session and no-match diagnostics, and attendance as a separately named link-extraction subscore; LLM fallback quality is a paid row.

## N13 code-intelligence

**What exists.**
- Ops `code_callers`, `code_callees`, `code_def`, `code_refs`, `code_blast`, `code_flow` (`src/core/ops/code-intel.ts:37,76,113,137,191,226`), all wrapped to throw `permission_denied` when `ctx.remote !== false` (`src/core/ops/code-intel.ts:293-307`, P9). Their `cliHints` are hidden (`src/core/ops/code-intel.ts:72,109,133,157,222,254`).
- CLI commands `code-def`, `code-refs`, `code-callers`, `code-callees`, `reindex-code` (`src/cli/command-table.ts:321-328`). No `code-blast` or `code-flow` command exists (grep), so those two run only via `gbrain call` or IN.
- `code_def` matches `content_chunks.symbol_name` exactly (`src/commands/code-def.ts:16,73`). `code_refs` is a substring ILIKE over chunk text (`src/commands/code-refs.ts:1-18,65`).
- Symbol resolution is within-file: one same-page qualified match resolves, several mark ambiguous, none is left to other passes (`src/core/chunkers/symbol-resolver.ts:1-24`).
- `code_blast` / `code_flow` are BFS walks over stored edges with depth caps (5 callers, 8 callees), a node cap and cycle detection (`src/core/code-intel/recursive-walk.ts:1-15,148-178`); flow sinks are static classifications (`src/core/code-intel/recursive-walk.ts:19`).
- Languages: the chunker knows 30 (`src/core/chunkers/code.ts:155-159`); call edges are extracted for TS, TSX, JS, Python, Ruby, Go, Rust, Java, Kotlin, C# (`src/core/chunkers/edge-extractor.ts:108-127`) plus Dart (`src/core/chunkers/edge-extractor.ts:432`); blast and flow refuse languages other than TS, TSX, JS and Python (`src/core/code-intel/recursive-walk.ts:65,172-176`).

**Transports.** OP (local) and CLI for def/refs/callers/callees; OP via `gbrain call` and IN only for blast/flow; STDIO and HTTP refused for all six.

**Not implemented.** Remote code reads (suspended); semantic references; cross-file resolution in the resolver; runtime or control-flow analysis; blast/flow for the other edge languages.

**System One.** None.

Scoreable hermetically at this commit: a capability and readiness scout through trusted local calls (def top-1, lexical refs, edge presence, walk envelopes and language gating) after `reindex-code` on a pinned repo; semantic reference and flow quality need independent gold and stay deferred.

---

## Corrections to the plan and outside review

- Plan §8 N2 assumes stored contradiction findings are readable through `find_contradictions`; at this commit it returns an empty note to every remote caller and to every scoped local call, including the default CLI scope (P4). Read-back needs `--source __all__` or an IN call.
- Plan §3 N12 lists "generic JSON" among formats: there is no such adapter (P8). The outside review's adapter list is correct.
- Plan §3 N13 lists `code_flow` and `code_callees` as entrypoints: they exist, but `code_blast` and `code_flow` have no named CLI command, and all six are suspended for STDIO as well as HTTP (P9).
- Outside review N1 calls `ontology_propose` "ontology proposals"; it writes and supersedes directly (`src/core/ops/chronicle.ts:153-188`). The pending-proposal mechanism is S9 `decide_proposals`, a different system.
- Outside review N2 refers to a judge "cap": the runner's cap is a USD budget (default $5), not a pair count; the pair limit comes from top-K per query.
- Outside review line ranges checked and found accurate within a few lines: `write-single.ts:1-20,141-173`, `runner.ts:156-215`, `withdrawal-schema.ts:1-74`, `verbs.ts:343-349`, `crag.ts:67-106`, `loop-detect.ts:112-164`, `loops-extract.ts:402-456`, `loops-store.ts:186-201,238-255`, `code-intel.ts:288-307`, `detect.ts:75-88`, `link-extraction.ts:660-685`.
- Edge-extractor header says 8 languages (`src/core/chunkers/edge-extractor.ts:28-30`); the config has 10 plus Dart (`:108-127,432`). Thin-client hints in `src/cli.ts:1869-1872` still say code reads have "no MCP op yet".

---

## Appendix: Probes

All probes ran keyless from the repository root on 2026-10-01 with this prefix (written `$KEYLESS` below). P4 to P11 are committed as scripts in [`2026-10-01-capability-matrix/probes/`](2026-10-01-capability-matrix/probes/), so each can be rerun with the command shown; P1 to P3 are the inline `bun -e` programs summarized in their blocks:

```
env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u VOYAGE_API_KEY -u JEV_TYPESAFE_API_KEY -u TYPESAFE_API_KEY GBRAIN_HOME=$(mktemp -d)
```

Imports use `./node_modules/gbrain/src/core/...` (identical to the tested tree). No database, network or paid call was made; only pure functions and handlers with stub contexts. Output is verbatim, trimmed where marked `[...]`.

**P1. Operations registry, per-category ops.**
```
$KEYLESS bun -e 'const {operations}=await import("./node_modules/gbrain/src/core/operations.ts"); /* for each wanted name print scope, localOnly, mutating, verb, cliHints.name, or ABSENT */'
```
```
total 153 localOnly 19
remember scope=write localOnly=false mutating=true verb=true cli=remember
entity scope=read localOnly=false mutating=false verb=true cli=entity
recall scope=read localOnly=false mutating=false verb=true cli=-
forget scope=write localOnly=false mutating=true verb=true cli=-
forget_fact scope=write localOnly=false mutating=true verb=false cli=-
extract_facts scope=write localOnly=false mutating=true verb=false cli=-
context_pack scope=read localOnly=false mutating=false verb=true cli=context-pack
delta scope=read localOnly=false mutating=false verb=true cli=delta
search scope=read localOnly=false mutating=false verb=false cli=search
query scope=read localOnly=false mutating=false verb=false cli=query
think scope=read localOnly=false mutating=true verb=false cli=think
takes_supersede scope=write localOnly=false mutating=true verb=false cli=-
traverse_graph scope=read localOnly=false mutating=false verb=false cli=graph
get_versions scope=read localOnly=false mutating=false verb=false cli=history
ontology_get scope=read localOnly=false mutating=false verb=false cli=ontology
ontology_propose scope=write localOnly=false mutating=true verb=false cli=ontology-add
ontology_conflicts scope=read localOnly=false mutating=false verb=false cli=ontology-contradictions
find_trajectory scope=read localOnly=false mutating=false verb=false cli=find-trajectory
find_contradictions scope=read localOnly=false mutating=false verb=false cli=find-contradictions
volunteer_context scope=read localOnly=false mutating=false verb=false cli=volunteer-context
open_loops scope=read localOnly=false mutating=false verb=false cli=-
loops_close scope=write localOnly=false mutating=true verb=false cli=-
loops_mute scope=write localOnly=false mutating=true verb=false cli=-
get_recent_transcripts scope=read localOnly=true mutating=false verb=false cli=transcripts
code_def scope=read localOnly=false mutating=false verb=false cli=code_def
code_refs scope=read localOnly=false mutating=false verb=false cli=code_refs
code_callers scope=read localOnly=false mutating=false verb=false cli=code_callers
code_callees scope=read localOnly=false mutating=false verb=false cli=code_callees
code_blast scope=read localOnly=false mutating=false verb=false cli=code_blast
code_flow scope=read localOnly=false mutating=false verb=false cli=code_flow
code_traversal_cache_clear scope=admin localOnly=true mutating=true verb=false cli=code_traversal_cache_clear
turn_context ABSENT
supersede_fact ABSENT
answerable ABSENT
transcripts_ingest ABSENT
```
(The `code_*` CLI names above are hidden hints, so they are not CLI commands: `src/cli.ts:74-80`.)

**P2. System One config, keyless vs key defaults.**
```
$KEYLESS bun -e 'const c=await import(".../ai/decide/config.ts"); const r=await import(".../ai/decide/reference-calibrations.ts"); const i=await import(".../ai/decide/index.ts");
console.log(i.hasTypesafeKey()); readDecideConfig(null,{typesafeKey:i.hasTypesafeKey()}) / readDecideConfig(null,{typesafeKey:true}) slot modes; r.recommendedSlots(c.DEFAULT_TYPESAFE_PROVIDER)'
```
```
hasTypesafeKey() false
keyless modes {"rerank":"off","intent":"off","evidence":"off","answerable":"off","injection":"off","recall_needed":"off","triage":"off","grounding":"off","conflict":"off"}
with-key default modes {"rerank":"off","intent":"off","evidence":"off","answerable":"off","injection":"off","recall_needed":"off","triage":"on","grounding":"off","conflict":"on"}
recommendedSlots ["triage","conflict"]
```

**P3. Fence supersession, chunker view after forget, claim normalization.**
```
$KEYLESS bun -e '/* rows: 1 active "Alice works at Acme"; 2 struck "Alice works at Beta" context "superseded by #1"; 3 struck "Alice prefers email" context "forgotten: user asked"; body = "# Alice\n\nProse: Alice prefers email.\n\n" + renderFactsTable(rows)
parseFactsFence(body); resolveSupersededByRow(2,1,{id:101,struck:false}); (2,2,...); (2,9,undefined); sanitizeRemoteBody(body); normalizeLoweredClaim(...) */'
```
```
parsed [{"row":1,"active":true,"supersededBy":null,"forgotten":false},{"row":2,"active":false,"supersededBy":1,"forgotten":false},{"row":3,"active":false,"supersededBy":null,"forgotten":true}] warnings 0
resolve row2->#1 {"superseded_by":101,"warning":null}
resolve self {"superseded_by":null,"warning":"people/alice row 2: \"superseded by #2\" references itself [...]"}
resolve dangling {"superseded_by":null,"warning":"people/alice row 2: \"superseded by #9\" names a row absent from the fence [...]"}
chunker view contains: Acme true | Beta(superseded) true | prefers email (fence forgotten row) false | prose sentence true
normalize "prefers email." -> "prefers email"
normalize "prefers email!" -> "prefers email"
normalize "prefers  email ;" -> "prefers email"
normalize "email is the preferred contact method" -> "email is the preferred contact method"
```

**P4. Contradiction runner with injected judge and search; `find_contradictions` scoping.**
```
$KEYLESS bun docs/benchmarks/2026-10-01-capability-matrix/probes/p4-contradictions.ts
/* searchFn returns 4 results (people/alice "Alice is CFO of Acme.", companies/acme "Acme's CFO is Bob.", notes/2024 "On 2024-01-05 Acme MRR was $50K.", notes/2026 "On 2026-03-01 Acme MRR was $2M."); stub engine with no takes; recording judgeFn returns contradiction for alice|acme, throws for acme|notes/2024;
runContradictionProbe({engine, queries:["who is acme cfo"], judgeFn, searchFn, noCache:true, topK:4, yesOverride:true});
find_contradictions.handler with {remote:true}, {remote:false, sourceId:"default"}, {remote:false, sourceId:"__all__"} over a stub engine holding one run */
```
```
pairs offered to judge: 5 ["people/alice|companies/acme","people/alice|notes/2024","companies/acme|notes/2024","people/alice|notes/2026","companies/acme|notes/2026"]
per_query: {"result_count":4,"pairs_skipped_by_date":1,"pairs_judged":4,"findings":[["people/alice","companies/acme","contradiction","dream_synthesize"]]}
judge error rows: [{"kind":"unknown","pair_id":"cross_slug_chunks:companies/acme#21:notes/2024#31","reason":"simulated judge failure"}]
date filter (2024 vs 2026, no page dates): {"skip":true,"reason":"both_explicit_separated"}
date filter (same texts, both page dates set): {"skip":false,"reason":"both_have_effective_date"}
find_contradictions remote=true (stdio/HTTP) -> {"contradictions":[],"note":"Stored contradiction reports are temporarily available only to trusted local callers without a source filter."}
find_contradictions remote=false, sourceId=default (CLI default) -> {"contradictions":[],"note":"Stored contradiction reports are temporarily available only to trusted local callers without a source filter."}
find_contradictions remote=false, sourceId=__all__ -> {"run_id":"r1","ran_at":"2026-10-01","contradictions":[],"total_in_run":0}
```

**P5. CRAG grade and the S4 reducer.**
```
$KEYLESS bun docs/benchmarks/2026-10-01-capability-matrix/probes/p5-crag.ts
/* gradeRetrievalConfidence on hand-built top results; reduceAnswerable(0.02,{threshold:0.5,margin:0.1},signals) */
```
```
grade "exact title match, chunk has no answer text" -> {"level":"strong","reason":"exact_title_match","top_evidence":"exact_title_match"}
grade "exact_lookup set" -> {"level":"strong","reason":"exact_lookup","top_evidence":"exact_title_match"}
grade "keyword_exact top, no reranker" -> {"level":"moderate","reason":"keyword_exact_top","top_evidence":"keyword_exact"}
grade "weak_semantic top" -> {"level":"weak","reason":"weak_semantic_top","top_evidence":"weak_semantic"}
grade "rerank 0.19" -> {"level":"weak","reason":"rerank_top_below_floor","top_rerank_score":0.19}
grade "zero results" -> {"level":"weak","reason":"zero_results"}
S4 reduce p=0.02 complete, identityHit ->  pass
S4 reduce p=0.02 complete, strongGrade ->  pass
S4 reduce p=0.02 complete, no signals ->  abstain
S4 reduce p=0.02 incomplete ->  incomplete
```

**P6. Gmail thread-state detector with pinned `now` (2026-10-01T12:00:00Z), me = me@example.com.**
```
$KEYLESS bun docs/benchmarks/2026-10-01-capability-matrix/probes/p6-gmail.ts
/* detectThreadLoop(thread, new Set(["me@example.com"]), now) on synthetic GmailThreadData; ages in hours before now */
```
```
grace hours inbound/outbound: 24 72
inbound 30h, To me -> {"open":[["unanswered_inbound","bob@example.org"]],"close":["unanswered_outbound"]}
inbound 10h (inside grace) -> {"open":[],"close":["unanswered_outbound"]}
inbound CC-only 30h -> {"open":[],"close":["unanswered_outbound"]}
inbound then my reply 'thanks!' (no deck) -> {"open":[],"close":["unanswered_inbound"]}
my promise 'I'll send the deck Friday' (no ?) 100h -> {"open":[],"close":["unanswered_inbound"]}
my question 100h -> {"open":[["unanswered_outbound","bob@example.org"]],"close":["unanswered_inbound"]}
my question 100h then calendar notice from them -> {"open":[["unanswered_outbound","bob@example.org"]],"close":["unanswered_inbound"]}
```

**P7. Relational parser.**
```
$KEYLESS bun docs/benchmarks/2026-10-01-capability-matrix/probes/p7-relational.ts   /* parseRelationalQuery(q) */
```
```
"Who works at Acme?" -> {"kind":"who_rel","seeds":["Acme"],"linkTypes":["works_at"],"direction":"in","relationPhrase":"Who works at Acme?"}
"Which people work for companies backed by Fund Example?" -> {"kind":"who_rel","seeds":["companies backed by Fund Example"],"linkTypes":["works_at"],"direction":"in","relationPhrase":"Which people work for companies backed by Fund Example?"}
"Which employers have staff who advise Acme?" -> {"kind":"who_rel","seeds":["Acme"],"linkTypes":["advises"],"direction":"in","relationPhrase":"who advise Acme?"}
"Who invested in Acme?" -> {"kind":"who_rel","seeds":["Acme"],"linkTypes":["invested_in","led_round"],"direction":"in","relationPhrase":"Who invested in Acme?"}
"What connects Fund Example and Acme?" -> {"kind":"connects","seeds":["Fund Example","Acme"],"linkTypes":null,"direction":"both","relationPhrase":"What connects Fund Example and Acme?"}
```

**P8. Transcript adapter registry, conversation-parser built-ins and timestamp diagnostics.**
```
$KEYLESS bun docs/benchmarks/2026-10-01-capability-matrix/probes/p8-transcripts.ts
/* transcriptAdapters().map(a=>a.format); BUILTIN_PATTERNS ids; parseConversation(body,{noFallback:true,noPolish:true,...}) */
```
```
transcriptAdapters(): ["hermes","openclaw","codex","claude-code","grok","claude-export","chatgpt"]
BUILTIN_PATTERNS: 20 ["imessage-slack","telegram-bracket","bold-paren-time","bold-paren-time-12h","bold-time-dash","speaker-letter-no-time","chatgpt-export-you-chatgpt","bold-name-no-time","telegram-text-export","whatsapp-iso","whatsapp-us","discord-export","teams-export","signal-export","discord-classic","matrix-element","irc-classic","irc-weechat","markdown-heading-turn","python-dict-utterance"]
time-only iMessage shape, no date -> {"phase":"regex_match","pattern":"bold-paren-time-12h","n":3,"first":{"speaker":"Alice Example","timestamp":"1970-01-01T09:05:00Z","text":"hi"},"tz":"[conversation-parser] pattern=bold-paren-time-12h assumed UTC for time-only timestamps; add 'timezone: <IANA>' to page frontmatter for accurate facts"}
time-only iMessage shape, fallbackDate -> {"phase":"regex_match","pattern":"bold-paren-time-12h","n":3,"first":{"speaker":"Alice Example","timestamp":"2026-09-30T09:05:00Z","text":"hi"},"tz":"[...]"}
meeting speaker shape -> {"phase":"regex_match","pattern":"bold-name-no-time","n":3,"first":{"speaker":"Alice Example","timestamp":"1970-01-01T00:00:00Z","text":"hi there"},"tz":"[...]"}
generic JSON body -> {"phase":"no_match","n":0}
```

**P9. Code-intel remote suspension.**
```
$KEYLESS bun docs/benchmarks/2026-10-01-capability-matrix/probes/p9-code.ts
/* for each op in codeIntelOperations: op.handler({remote:true, sourceId:"default", engine:{}}, {symbol:"parseMarkdown"}) */
```
```
code_callers remote=true -> permission_denied | code_callers is temporarily unavailable to agent callers. Use the trusted local CLI for code reads.
code_callees remote=true -> permission_denied | code_callees is temporarily unavailable to agent callers. Use the trusted local CLI for code reads.
code_def remote=true -> permission_denied | code_def is temporarily unavailable to agent callers. Use the trusted local CLI for code reads.
code_refs remote=true -> permission_denied | code_refs is temporarily unavailable to agent callers. Use the trusted local CLI for code reads.
code_blast remote=true -> permission_denied | code_blast is temporarily unavailable to agent callers. Use the trusted local CLI for code reads.
code_flow remote=true -> permission_denied | code_flow is temporarily unavailable to agent callers. Use the trusted local CLI for code reads.
code_traversal_cache_clear localOnly= true scope= admin
```

**P10. Volunteer window parsing; `turn_context` is not an op.**
```
$KEYLESS bun docs/benchmarks/2026-10-01-capability-matrix/probes/p10-volunteer.ts
/* parseWindow("user: I'm meeting Alice Example tomorrow\nassistant: ok\nwhat should I bring?"); operations filtered by name */
```
```
parseWindow: [{"role":"user","text":"I'm meeting Alice Example tomorrow"},{"role":"assistant","text":"ok\nwhat should I bring?"}]
ops named turn_context: 0 | volunteer_context: [{"scope":"read","localOnly":false}]
```

**P11. Gateway availability keyless.**
```
$KEYLESS bun docs/benchmarks/2026-10-01-capability-matrix/probes/p11-embed.ts   /* gw.isAvailable("embedding"), gw.isAvailable("chat") */
```
```
isAvailable('embedding') -> false
isAvailable('chat') -> false
```
