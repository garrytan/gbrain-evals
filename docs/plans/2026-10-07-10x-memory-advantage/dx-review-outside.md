OUTSIDE DX REVIEW (GPT-6 Astra), input sha 2ce6d25fe9a00a7add9e0ab15aecf2b06d19a447dd7d47c03105d15d26389151

The plan is not yet an executable developer-experience contract. It specifies research gates more precisely than the path from an existing agent installation to a verified recall in another session.
I read the complete 464-line input before the repository evidence; its SHA-256 matches. This was a static review against gbrain `7aa2caa0`, not a live harness trial. No paid calls or repository changes were made.
References below use `Plan` for `dx-implementation.md` and `Audit D` for `gbrain-evals/docs/plans/2026-10-07-10x-memory-advantage/audit/D-proactive-distribution.md`; other paths are relative to gbrain.
Section 11's accepted CEO obligations are treated as binding. I am not reopening the surface-choice decision, asking for the already-added adoption funnel, or repeating the thin-client unsupported-label amendment.

## Findings

1. A harness name is not enough information to choose the brain.
Severity: High.
Plan text at issue: D8 promises “`gbrain setup <harness>` ... idempotent init, MCP registration” (Plan:211), while D8b adds the remote route separately (Plan:212).

Evidence: `docs/guides/hosted-harness-access.md:5-17,126-146` separates the host, client, credential flow, and native activation. `docs/guides/in-agent-setup.md:37-42,72-75` pins an isolated launcher and explicitly refuses to convert a hosted client during adoption.
`INSTALL_FOR_AGENTS.md:408-417` says a second stdio server cannot share a live PGLite brain. `src/commands/bootstrap.ts:1414-1429` already avoids registering a second server when a plugin owns the name, and warns that enabled is not healthy.

The proposed command does not say whether it adopts that plugin, an existing remote connection, a different local brain, or an empty home. Initializing the wrong one can produce a flawless synthetic round trip while all useful memory remains elsewhere. Wiring a second harness can instead produce a lock failure.
Amendment: “Setup resolves the existing brain, source, transport, absolute launcher and registration owner before any mutation, and shows the selected target. An existing hosted connection never falls back to a new local brain. A live PGLite owner is reused through an approved shared-server route or produces an actionable conflict; setup never starts a second owner.”
Add adoption cases for an enabled-but-broken plugin, a remote-only configuration, two local brains, and a second harness. Reuse the existing connection receipts and ownership checks rather than introducing another installation-state system.

2. The four-harness push promise outruns the native capability evidence.
Severity: High.
Plan text at issue: D8 includes “push hooks” for Claude Code, Codex, OpenClaw and Hermes, and requires “first pushed item ... 3/3 on Claude Code and Codex” (Plan:211). The current-state summary says nothing is pushed “on plugins” (Plan:54).

Evidence: `src/core/bootstrap/codex-hooks.ts:2-45` verifies only SessionEnd capture on Codex 0.147.0, including silent trust-gate failure and version sensitivity. `BOOTSTRAP_FOR_AGENTS.md:156-162` describes Codex context as pull-based. `src/core/harness/registry.ts:49-51` describes Hermes as manual stdio; Audit D:495-500 makes Codex push conditional and calls the Hermes route pull, not push.
The blanket plugin claim is false: `openclaw.plugin.json:2-7` declares a context engine, and Audit D:51-52,115 documents its local reflex. Conversely, the install docs wrongly say Postgres lacks the hook lane (`INSTALL_FOR_AGENTS.md:182-184`), while `src/mcp/resolve-ipc-binding.ts:4-17` implements engine-uniform IPC for stdio and HTTP.

These are different capabilities, not interchangeable wiring tasks. A config writer cannot supply a hook event the native harness does not execute. The engine-doc contradiction also pushes developers toward single-process PGLite for a benefit Postgres already supports locally.
Amendment: “D8 begins with a versioned harness × transport capability table. Native push is claimed only after an observed event injects a randomized item into a fresh native session. Codex push is conditional on that observation; otherwise ship verified pull without blocking setup. Hermes is pull unless a native push mechanism is separately proved. Local OpenClaw context-engine and thin-client OpenClaw are separate rows.”
Correct the Postgres and plugin statements in the same documentation change. Keep D8b's already-accepted thin-client test/unsupported fallback.

3. “Opt-in capture” needs a different installer path, not just a sentence.
Severity: High.
Plan text at issue: D8 removes the bootstrap interview, installs push hooks, allows at most one user reply, and says “with opt-in capture only” (Plan:211).

Evidence: `INSTALL_FOR_AGENTS.md:115-130` already bundles search mode, writeback, wiring and optional scaffolding into one reply, but requires the choices to be applied separately. `src/core/bootstrap/hooks.ts:595,634-637` defaults to every hook and relies on an explicit reduced event set to remove capture events.
Those defaults include Stop and SessionEnd (`src/core/bootstrap/host-specs.ts:185-200`); their handlers bank writeback and ingest transcripts (`src/commands/hook.ts:250-255`). The bootstrap dispatcher treats installing hooks as consent by default (`src/commands/bootstrap.ts:1073-1080`). Ambient chat credentials also enable extraction behavior described at `INSTALL_FOR_AGENTS.md:102-106`.

Reusing bootstrap without the interview must not reuse bootstrap's broader consent assumptions. “No embedding” is not a specification for no transcript capture or no paid chat calls. Removing questions without separating those effects risks making the shorter path more surprising.
Amendment: “Setup reuses the first-run decision bundle but records separate decisions for wiring scope, automatic capture and provider use. Memory-only setup installs only the disclosed read-context events; capture/writeback events and paid enrichment stay disabled unless explicitly accepted. Existing opt-outs win over defaults.”
Require negative tests with provider variables present, capture declined, and a pre-existing opt-out. Assert no transcript ingestion, no automatic fact write, and no paid outbound request. Count native permission approvals separately from conversational replies.

4. D8 can pass without proving that setup is faster, durable, or reversible.
Severity: Medium.
Plan text at issue: “the first ten minutes ... get simpler” (Plan:205); D8's proof is 3/3, wall time “vs 93.4 s / 437.9 s,” and a five-step funnel counted on three installs (Plan:211).

Evidence: Audit D:287-289 identifies those times as historical Cat 41 container runs on v0.60.35.0, not this release or a cold-machine baseline. Today's prerequisite is Bun ≥1.4.0 (`README.md:88`; `INSTALL_FOR_AGENTS.md:47-68`), and the current install check explicitly separates process persistence from new-conversation recall (`INSTALL_FOR_AGENTS.md:520-537`).
Hosted verification already returns partial when actual harness evidence is missing (`docs/guides/hosted-harness-access.md:172-176`). Isolated setup preserves edits and distinguishes repair from upgrade (`docs/guides/in-agent-setup.md:278-299`); hook writers also have ownership-aware removal (`src/core/bootstrap/hooks.ts:796-807`).

The accepted funnel is necessary but has no improvement threshold. Three successful trials can show feasibility, not the claimed time saving. “Idempotent init” also says nothing about interruption after the first of several configuration writes, or removing setup without deleting memory.
Amendment: “Measure the old documented path and setup on the same release and environment. Start the clock at the install instruction and stop at observed correct recall of imported useful data in a fresh native session; report prerequisite download time, approval taps, restarts, retries, abandonment and developer interventions separately. Freeze a setup-time or intervention-reduction threshold before the run; otherwise describe the result without a faster-setup claim.”
Setup must report configured/connection-verified/native-pending/native-verified separately, resume after interrupted wiring, and remove only unchanged owned configuration while preserving memory. Test correction and withdrawal, not just either one, and test a second run and removal alongside fresh installation.

5. In-band discovery is tested against a different callable surface from the installed product.
Severity: High.
Plan text at issue: D2 names a hidden tool in `next` and reveals it on stdio (Plan:209); D3 gates advertised full versus candidate (Plan:210); D8 uses the “shipped default surface” (Plan:211).

Evidence: `src/core/mcp-registration.ts:18-36` pins new stdio registrations to callable `starter`; both coding-agent plugin manifests do the same (`.claude-plugin/plugin.json:22-29`, `.codex-plugin/mcp.json:2-9`).
`src/mcp/surface.ts:365-380` reveals only within the already-visible callable set. It does not widen that set. Dispatch rejects tools outside `allowedOps` (`src/mcp/dispatch.ts:739-744`), and the server passes revelation and the allow-set separately (`src/mcp/server.ts:426-431`). P8 held callable full constant (Audit D:293-296,324-326).

Consequently, `revealTools(['takes_list'])` is not a complete repair for a normal starter registration. A message that says “call this tool” can lead directly to `unknown_tool`. D4 changes HTTP profile defaults, not every existing stdio or plugin registration. A sealed advertised-surface win would miss this failure.
Amendment: “D2 distinguishes hidden-but-callable from unavailable-under-the-current-ceiling. It reveals and recommends direct invocation only in the first case. Otherwise it emits the existing permitted session-widen action or a host-owned repair, preserving read-only access, operator pins and the force-surface clamp.”
Run the hidden-takes scenario through actual installed starter, full, verbs, read-only stdio and pinned HTTP configurations, including a client that ignores list-change notifications. When narrowing is dropped, D2 still needs an independent correctness gate; its only proof cannot disappear with D3's sealed run.

6. The bulk-write repair is invisible to the client it is supposed to help.
Severity: Medium.
Plan text at issue: existing clients get a doctor finding with “`ask_user` + `gbrain auth rescope`” (Plan:167).

Evidence: memory-writer receives read/write, not admin (`src/core/grants/profiles.ts:31-35`), while remote `run_doctor` is admin-scoped (`src/core/ops/admin.ts:165-187`). The existing request-tools path separately diagnoses server ceiling and operator pin (`src/core/ops/request-tools.ts:214-249`).
`docs/mcp/ADMIN.md:55-58` forbids opening a live PGLite database from another process for administration; `docs/guides/hosted-harness-access.md:224-244` supplies revision-checked host-side grant updates and distinguishes restrictions from added scopes. Surface and operation snapshot are separate axes (`src/core/grants/profiles.ts:41-48`).

A memory agent can fail to find `put_pages` and have no authority to run the new diagnostic. Asking that agent to execute a local auth editor is not the same as getting the brain owner to repair the running server. A one-axis fix may also leave the second blocker intact.
Amendment: “Expose a caller-safe missing-capability diagnosis on the connection's authenticated capability/denial path, not only in host doctor. Identify whether the blocker is scope, operation snapshot, client pin or server ceiling, without disclosing ungranted content. Route the proposed minimal change to the brain owner through the running admin API when required; preview with the current revision, then verify the same connection.”
Do not offer `operations all` as the default repair. Include a client blocked by both snapshot and pin, a deliberately restricted client, and a reader that correctly remains unable to call `put_pages`.

7. Embedding latency is being renamed findability, despite existing revision-aware readiness.
Severity: High.
Plan text at issue: E-C uses “embedded-at minus created-at” for “p95 write-to-findable < 5 min” (Plan:213); B9 proposes per-arm readiness “so write-to-queryable is measured without polling” (Plan:237).

Evidence: search already returns `projection_readiness`, degraded stages and held-file information (`src/core/ops/search.ts:392-435,452-458`). The readiness probe compares `text_projection_revision` with `knowledge_revision`, respects the read policy, and distinguishes unknown from ready (`src/core/search/projection-readiness.ts:76-116`).
Keyword search works without embedding credentials (`INSTALL_FOR_AGENTS.md:101-106,283-295`). A successful remote page write also does not prove typed graph availability (`INSTALL_FOR_AGENTS.md:310-323`). These are different searchable representations with different completion points.

An embedding timestamp does not prove that a corrected page revision is returned by the reader's actual query, or that `recall` sees the corrected fact. A completion-only p95 can look excellent while never-completing writes are absent from the sample. A fresh keyless installation should not appear broken because it deliberately has no vectors.
Amendment: “Extend the existing revision-aware readiness contract rather than adding a competing readiness op. Report keyword, vector, facts and graph state separately, using disabled/not-requested rather than pending for capabilities the user declined. Track the accepted write/revision through each requested projection; report unfinished writes and their ages alongside completed-write latency.”
The developer-facing gate must observe a planted write and a correction through the normal CLI/MCP read path from a fresh session with the same grants. Withdrawal must remove the old active answer. Provider completion timestamps remain diagnostics, not the proof of correct recall.

8. The proposed completeness explanation can leak metadata and overstate negative evidence.
Severity: High.
Plan text at issue: E-C adds “searched N of M sources, K chunks unembedded” to read results and shares status machinery (Plan:213); A8 uses those figures in the brief's not-found statement (Plan:180,192).

Evidence: the code explicitly warns “Aggregates leak by subtraction” and scopes diagnostic counters to remote source grants (`src/core/ops/admin.ts:25-34`). Its identity packet uses that scope (`src/core/ops/admin.ts:111-139`).
The status path targeted for reuse selects all active sources (`src/core/ops/skills-catalog.ts:326-368`), and the sync report counts nondeleted pages/chunks without a page-visibility predicate (`src/core/sync-status-report.ts:137-162`). By contrast, search readiness receives source, private-page, type and exclusion filters (`src/core/ops/search.ts:416-425`).

Moving administrative totals into a read-scope answer is not a harmless formatting change. Hidden-source totals or private-page backlog changes can reveal activity. Even safely scoped “100% indexed” is not proof that the retriever searched exhaustively or that an omitted fact does not exist.
Amendment: “Completeness metadata is computed under the exact caller read policy and request filters. M means eligible sources for this request, never all sources in the brain; private or ungranted records cannot affect N, M, K or the explanation. Failed probes report unknown, not zero backlog.”
Require paired privacy probes where only unauthorized sources/private records change and the response metadata stays identical. Use wording such as “No supporting evidence was returned from the searched scope; index readiness is X,” never infer “not in the brain” from healthy indexing.

9. The plan adds public selection surface while claiming it has stopped doing so.
Severity: Medium.
Plan text at issue: “The only new advertised name is discover” (Plan:310), but A9 adds `evidence_brief` beside `assemble_evidence` (Plan:193), W9 adds a read op (Plan:261), and D4 makes advertised full the new-profile default (Plan:167).

Evidence: `src/mcp/surface.ts:217-228` returns every operation for full, and `src/mcp/surface.ts:331-355` only hides names when an advertised subset is chosen. Existing discovery is named `request_tools`, with three distinct behaviors (`src/core/ops/request-tools.ts:157-182,319-336`).
Under the full-surface outcome, a new remote operation is advertised unless the implementation adds another filtering rule. Developers and agents then choose among query, assemble_evidence, think with a flag, and evidence_brief. A smoke in which an agent uses the new tool does not establish that it picks the right one or avoids unintended paid work.
Amendment: “List every added tool, parameter and config knob under each approved surface outcome. Do not call an operation hidden unless that outcome actually hides it. Prefer exposing budgeted evidence delivery through an existing operation if it meets the winning pilot's contract; otherwise explicitly justify and measure the extra tool-selection branch.”
If `discover` is introduced, specify whether it is an advertised alias for `request_tools`, how old callers remain compatible, and whether both names consume schema budget. Add keyless, opt-out and budget-exhaustion agent cases that verify the chosen call and fallback, not merely schema validity.

## Numbers and claims I checked

These are source checks, not newly measured user outcomes. “Mismatch” includes an overbroad claim or missing applicability condition, not just wrong arithmetic.

| Claim | File evidence | Match / mismatch |
| --- | --- | --- |
| Catalog has 140 tools, with 72 read, 32 write, 25 admin and 11 other scope combinations. | `docs/TOOL_CATALOG.md`, all 140 tool rows; Audit D:183-189. I recounted the rows and scope columns. | Match. This is a catalog count, not every client's effective list. |
| Starter contains 40 tools. | `docs/TOOL_CATALOG.md`, starter column; `src/mcp/surface.ts:91-110`. I recounted 40 marked rows. | Match; the source header's “~20” is stale. |
| Verbs is exactly seven, without discovery. | `src/mcp/surface.ts:10-13,80-85,217-222`; Audit D:192-194. | Match. D1 does not make `request_tools` callable on that ceiling. |
| `request_tools {tools: []}` returns empty today. | `src/core/ops/request-tools.ts:298-316`. | Match; the catalog branch starts at line 319. |
| Memory profiles are operator-pinned to starter and snapshot operations. | `src/core/grants/profiles.ts:31-48`. | Match. Full is still bounded by scope and the snapshot. |
| `put_pages` is outside starter. | `docs/TOOL_CATALOG.md:176`; `src/mcp/surface.ts:91-110`; Audit D:198-204. | Match. A reader must still be refused after any surface change. |
| A single registration-surface constant is needed. | `src/core/mcp-registration.ts:18-36`; `README.md:176-180,225-233`. | Partial: the constant already exists; docs/manual routes and transport policy diverge. |
| No `gbrain setup <harness>` exists. | `src/cli/command-table.ts`; Audit D:278-281. | Match for this pinned tree. |
| Bootstrap workspace hooks require initialized agent state. | `src/commands/bootstrap.ts:1093-1100`. | Match for that command; do not generalize it to every harness-install route. |
| Plugins never push context. | `openclaw.plugin.json:2-7`; Audit D:106-116. | Mismatch: local OpenClaw's context-engine plugin is the exception. |
| Codex currently lacks the claimed start/prompt push lane. | `src/core/bootstrap/codex-hooks.ts:2-45`; `BOOTSTRAP_FOR_AGENTS.md:156-162`. | Match for shipped integration; future support needs a new native observation. |
| Postgres must give up bootstrap hook push. | `INSTALL_FOR_AGENTS.md:182-184` versus `src/mcp/resolve-ipc-binding.ts:4-17`. | Mismatch within today's install path; local Postgres IPC is implemented. |
| 93.4 s and 437.9 s are install baselines. | Audit D:287-289. | Match as historical reported container means, not measurements of current setup or a clean user's first hour. |
| `get_brain_identity.last_sync_iso` is unfilled. | `src/core/ops/admin.ts:103-104,134-139`. | Match. Filling it requires a caller-scoped freshness definition. |
| B9 proposes an additional readiness op or doctor field. | Plan:237; `src/core/ops/search.ts:420-425,453`; `src/core/search/projection-readiness.ts:96-116`. | Partial gap: revision-aware text readiness already exists; vector/fact/graph completion is additional work. |
| Only `discover` will be newly advertised. | Plan:193,261,310; `src/mcp/surface.ts:217-222,351-355`. | Mismatch under the plan's full-advertisement outcome. |

## Developer journey: my first hour

This is a concrete journey to test, not an invented timing result. I have an existing coding project, edited agent instructions, a folder of Markdown notes, and both Claude Code and Codex. I want them to share one memory without buying enrichment or creating another personal agent.

Today, minutes 0–10:
I encounter the memory-only paste block, two-command lighter path, plugins and optional bootstrap. I must identify the GitHub distribution, meet the Bun floor, preserve my instructions, and decline the identity/private-repository route.
The lighter path lists verbs, the plugin lists starter, and a bare server lists full. None of those choices tells me whether a new conversation will automatically recall anything.

Today, minutes 10–25:
I initialize keyless memory and answer the existing decision bundle, then import a small approved notes folder without embedding. I check exact keyword retrieval before asking for a synthesized answer.
I connect one harness and inspect an actual MCP call. If I also connect the second through another stdio process, I can hit the PGLite ownership limit. The documentation sends me toward a shared HTTP server or Postgres, while an outdated paragraph incorrectly warns that Postgres sacrifices hooks.

Today, minutes 25–45:
I save a randomized test fact with provenance, close the conversation, and ask for it without repeating the value. I inspect the GBrain call rather than accepting the model's answer as evidence.
I then test a fact from my imported notes. The marker test alone does not prove that the intended notes source, page projection, or the agent's ordinary retrieval habit works.

Today, minutes 45–60:
I correct the fact, verify the replacement, withdraw it, and verify active recall again. For hosted access I may need the owner to repair a snapshot or surface; I cannot do that with an ordinary memory token.
If I want automatic pushes, I must distinguish read-context hooks from transcript capture and check native execution. An installed file, an exit-zero hook or a successful server verifier is not enough.

After the plan as currently written:
`setup claude-code` can shorten command discovery and D1 can prevent an empty discovery response. D4 can remove a fresh hosted writer's bulk-write ceiling. Those are the concrete shortcuts.
The plan still leaves my target brain, plugin ownership, second-harness concurrency, push capability and interrupted-install state underspecified. It can move the ambiguity into a command without eliminating it.
I also gain more choices about evidence briefs, surfaces, readiness, proactive context and eventual page refresh. Most wave gates measure task quality after installation, not how much of my first hour those choices consume.

After the amendments above:
The command first shows the brain/source/transport it will use and the owned configuration it will change. One consent bundle preserves opt-outs; it does not hide native approval taps.
It reuses the plugin or existing connection, initializes only an explicitly selected new brain, and names any second-process conflict before writing configuration. It returns the exact restart action and a native-pending status.
My next conversation performs the marker and useful-note checks through the real agent, then correction and withdrawal. Unsupported push stays labelled pull-only; embedding-disabled remains a valid state, not a repair recommendation.
If wiring is interrupted, the same command resumes its owned steps. Removing the integration leaves the notes, database and unrelated harness settings intact. The paired timing/intervention comparison, rather than the existence of the command, decides whether this is a DX improvement.

Recommendation: amend D8, D2, D4 and E-C before approving their implementations because the current gates can certify a working research arm or local round trip while a normally installed agent still targets the wrong brain, cannot invoke the suggested tool, or cannot demonstrate correct recall in a fresh session.
