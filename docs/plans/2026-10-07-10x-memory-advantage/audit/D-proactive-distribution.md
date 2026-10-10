# Audit D: proactive context (bet 5) and distribution

Auditor: GBRA-60 subagent D, read-only. Date 2026-10-07.
Pins read: gbrain master `7aa2caa0` (v0.60.106.0, migrations head v219), gbrain-evals main `f1ce49fe` (v0.10.40).
Nothing was run against a real brain; no paid calls. `bun test` could not run locally (`node_modules` absent:
"Cannot find package 'ai'"), so every behaviour below comes from reading code, docs and committed receipts.

Headline findings (details and citations below):

1. gbrain already pushes context, but only on the deep install lane. The Claude Code `SessionStart` hook pushes a
   context pack (standing entities, their open commitments, hot facts), `UserPromptSubmit` pushes a per-turn block, and
   the pre-compaction save notice (P4) passed a sealed test (+11.35 points). The plugin installs, the README
   "lighter way" and every remote/thin-client install get no push at all.
2. Nothing measures whether an agent *uses* pushed content. N8 and Cat 34 measure delivery (recall and false
   alarms). The only uptake signal in the product is `volunteer_context --stats`, which its own docs call approximate.
3. "Advertise the 7 verbs plus a discover tool" is close to the `verbs` arm that lost P8's sealed test. Working from
   the published aggregates: `starter` lost nothing outside the hidden-tool family (−0.2 points), while `verbs` lost
   7.6 points on ordinary memory and write tasks as well. So the 7 verbs alone are the wrong core set. The hidden-tool
   collapse has a concrete cause: models answered from a superseded email that `search` returned, and the one
   `request_tools` call sent an empty `tools` list and got nothing back.
4. Garry's token most likely lacks `put_pages` for two independent reasons: every OAuth profile grant pins the
   `starter` surface, and `put_pages` is outside `starter`; and grants snapshot their operation list at mint time,
   while `put_pages` shipped in v0.60.64.0 (2026-10-05).
5. The "September 21 review": **not found** in either repository or in Capy Drive. The only text is GBRA-60's own
   framing. The tool count is confirmed: the generated catalog went 137 (`d3a6aa7e`, 2026-10-05) → 140 (`7aa2caa0`),
   adding `put_pages`, `rate_answer` and `wanted_pages`.

---

## Part 1. Bet 5: the brain speaks up before the agent asks

### 1.1 What exists today

**Push core (zero LLM).**
- `src/core/context/volunteer.ts`: `volunteerContext()`. Entity extraction over a rolling window, then the resolver
  arms: alias 0.9, exact title 0.8, slug-suffix 0.6, plus 0.05 for multi-turn or newest-turn mentions. The gate is
  `VOLUNTEER_DEFAULT_MIN_CONFIDENCE = 0.7` (line 43), the cap is `VOLUNTEER_DEFAULT_MAX_PAGES = 3` (line 41) with a
  hard cap of 5 (line 42). Header comment: "push noise is worse than pull silence (#2095)". Surname arm 0.72 and
  lowercase alias probes are described in `docs/guides/push-context.md:24-38`.
- `src/core/context/retrieval-reflex.ts` `resolveEntitiesToPointers`, used by every push channel. N8-1/N8-2 private
  filtering was added there (`excludePrivate`).
- `src/core/context/entity-salience.ts`: single-turn capitalized-run extractor. The header lists its limits:
  lowercase surnames, caseless scripts, and "true pronoun coreference ... remains out of scope".

**Channels** (`docs/guides/push-context.md:10-15`):
- `volunteer_context` MCP op (`src/core/ops/insights.ts:24`). Read scope, takes `window`, `prior_context`,
  `max_pages`, `min_confidence`, `session_id`, `turn` and `stats`. It applies `resolveExcludePrivatePages(ctx.engine,
  ctx.remote)` (the N8-1 fix), logs to `context_volunteer_events` (migration v117), and with `stats: true` returns
  `volunteerUsageStats`, where "used" means `pages.last_retrieved_at > volunteered_at` (`volunteer.ts:348-391`;
  `approximate: true`). It is **not in `starter`** (see 2.1), so the default registrations never list it.
- Reflex inside the OpenClaw context engine (`src/core/context-engine.ts`, `src/core/context/reflex.ts`), with a
  1500 ms pointer arm and a volunteer arm. The `openclaw.plugin.json` `kind` is `context-engine`.
- `gbrain watch` (stdin stream).
- Claude Code hooks (`src/commands/hook.ts`, events at lines 241-258):
  - `session-start` (`hookSessionStart`, line 484; deadline `SESSION_START_DEADLINE_MS = 1500`, line 122) prints the
    MEMORY.md digest, push status, backup and failure notes, then a **context pack over IPC** (`requestContextPack`,
    lines 534-570). It puts always-loaded core first when `memory.core.enabled`. Output is capped at
    `CLAUDE_HOOK_OUTPUT_CAP_CHARS = 10000` (`src/core/bootstrap/host-specs.ts:207`; composer in
    `src/core/context/session-start-output.ts`).
  - `user-prompt` builds the turn block through serve IPC (`assembleTurnContext`, `src/core/context/turn-context.ts`).
    It has three sections, "Brain pages mentioned this turn", "Brain pages the brain volunteers" and "Hot memory
    (recent facts)" (`turn-context.ts:411-425`), and a budget of `TURN_CONTEXT_DEFAULT_MAX_BYTES = 8192` (line 68).
    Hot facts are world-only. Cross-turn dedupe reads the hook's own earlier injections back from the transcript
    (`push-context.md` "Harness hooks").
  - `compact` (PreCompact) banks standing entities so the post-compaction session start serves a warm pack.
- System One S6 `recall_needed` (`src/core/context/recall-needed.ts`). Paid and **off keyless**; N8 did not measure
  it (N8 report, "System One S6 is off keyless and not measured").

**What the session-start pack contains** (`turn-context.ts:505-560`, `renderPack` at 794-815): "Standing entities"
(entity cards), "Open threads" and "Hot memory (recent facts)". Open threads come from entity cards, with `kind:
'commitment' | 'recent_event'` (`src/core/verbs/entity-card.ts:53-54`). So **commitments already ride the pack**,
but only for the entities banked for the session. Delta mode adds "Pages changed since T", "New facts" and "Thread
updates" (`renderDelta`). It is world-only unless `includePrivate === true` (`assemblePack` line 516).

**Save before compaction and the core tier (P4, gbrain #6015, v0.60.87.0).**
- `src/core/context/pressure.ts`: at `memory.pressure.warn_ratio` (default `0.8`, line 21) the next turn carries one
  notice telling the agent to `remember` with `items`. `memory.pressure.enabled` is **on by default**.
- `src/core/core-memory.ts`: `memory.core.enabled` (default **false**, line 81), `memory.core.max_chars` (default
  4000, line 22), `memory.core.remote_edit`. It is delivered by the session-start hook, by
  `src/core/context/openclaw-core.ts` and by the static file `gbrain compile-context --include-core`
  (`src/core/context/compiled-core.ts`). `docs/mcp/HERMES.md` has an "Always-loaded core memory" section.

**Open loops** (`src/core/loops/loops-store.ts`; ops in `src/core/ops/loops.ts`):
- `open_loops` (line 347, read) groups by counterparty, filters on `loop_type ∈ {commitment_owed_by_me,
  commitment_owed_to_me, unanswered_inbound, unanswered_outbound, decision_pending}` and takes `as_of`. Remote callers
  get redacted evidence. Its sources are the Gmail thread-state detector and the LLM commitment extractor.
- `loops_close`, `loops_mute` and `loops_unmute` are write ops. The CLI is `gbrain waiting [--top N] [--json]
  [--stale-ok]`, which refuses when every google source is more than 24 hours stale (`docs/guides/open-loops.md:160-167`).
- **Nothing pushes loops.** No hook, pack or turn-context arm reads `open_loops`. A grep of `src/commands/hook.ts`,
  `src/core/context/` and `src/mcp/` for `open_loops` and `loops-store` returns nothing. The `briefing` and
  `daily-task-prep` skills (calendar lookahead, "open threads from yesterday") are pull-only skills built on
  search/query/get_page.

**Contradictions:** `find_contradictions` (`insights.ts:185`) reads stored probe runs only, and **returns empty to
every remote caller and every source-filtered caller** ("Stored contradiction reports are temporarily available only
to trusted local callers without a source filter", lines 214-216). There is no answer-time "you are about to
contradict X" check. `think.quote_verify` (P8 quote grounding, shipped on) is the closest thing to an output check.

**Recent salience:** `get_recent_salience` (`src/core/ops/salience.ts:21`, read, **in starter**).

**What the instructions tell agents** (`src/mcp/instructions.ts:50-51`): "call `context_pack` at session start ..."
when `context_pack` is callable, and "call `volunteer_context` when the conversation shifts topic" **only when
`volunteer_context` is callable**. Starter (the default registration) does not include it, so starter agents never
see that line.

**Install-lane reach of push:**

| Lane | MCP surface | Push? | Source |
|---|---|---|---|
| `gbrain bootstrap hooks --harness claude-code` | starter | SessionStart pack + UserPromptSubmit block + PreCompact | `bootstrap.ts:131-140`; requires an initialized agent workspace (`runHooks`, `bootstrap.ts:1093-1100`: "not an agent workspace (agent.json ...) — run `gbrain bootstrap render` first") |
| `gbrain bootstrap harness` (framework-spawned sessions, running `serve --http`) | token-scoped | lifecycle hooks (user scope) | `bootstrap.ts:147-160` |
| Codex (bootstrap) | starter | **SessionEnd capture only**; no SessionStart/UserPromptSubmit push | `src/core/bootstrap/codex-hooks.ts:2` ("SessionEnd capture lane", spec codex-cli 0.147.0) |
| Claude Code / Codex plugin | `serve --surface starter --source-guard` | **none** (manifests carry no hooks) | `.claude-plugin/plugin.json`, `.codex-plugin/mcp.json`; `plugin/` holds only README + skills |
| README "lighter way": `claude mcp add ... serve --surface verbs` | verbs | none (relies on the agent calling `context_pack`) | `README.md:179-180` |
| OpenClaw plugin | bare `serve` (full) | reflex context engine | `openclaw.plugin.json` (`mcpServers.gbrain.args: ["serve"]`) |
| Thin-client / remote MCP (`gbrain connect`, Grok Bot, Muse, hosted) | profile surface | **none**: "every push channel is dead there" | `TODOS.md` "P3 — thin-client remote push route" (~line 3944) |

### 1.2 What has been measured

| Report | Date / pin | Data class | Numbers (quoted) |
|---|---|---|---|
| N8 proactive recall, evals `docs/benchmarks/2026-10-01-n8-proactive-recall.md` | 2026-10-01, gbrain `3a284ae` v0.60.26.0 | synthetic dev world (seed 8); associative arm on associative-recall-v1 **dev, labels pending human review** | Alias and exact-title recall 42/42 (100%), surname 12/12, slug-tail 0/6 at gate 0.7; false alarms 0/68 innocuous; **common-word aliases 6/6 fire, 7.5% over all 80 negatives at every threshold 0.5-0.95 (N8-3)**; **associative: 0/240 indirect, 0/120 direct, 0/120 false alarms (N8-4)**; keyword-search baseline 79.2% indirect but fires on 100% of negatives; tokens per turn mean 24.6 (p95 73) with `prior_context`; turn block 23.4 (p95 64); without `prior_context`, 1.87 redundant pages per session; private leaks 4 remote + 4 turn block (N8-1/N8-2) |
| N8 privacy gate, `2026-10-06-n8-privacy-gate.md` | 2026-10-06, `c5fb0201` v0.60.95.0 | same synthetic world, preregistered gate, $0 | Private leaks 0/0 (control `3a284ae`: 4/4), alias recall 42/42 remote and turn block; N6 `volunteer_context` 16 signal probes, 0 leaks. Report-only remainder: all triggers 54/60, common-word 50%, associative 0/240. The trusted local CLI still returns private pages by design |
| Cat 34 BrainBench memory, `2026-06-12-brainbench-memory.md` | June 2026 on 0.44.0.0; Sept 1 rerun 0.47.8.0 | synthetic | June push recall 0.809 (openclaw), 0.660 (claude-code contract), 0.447 (codex contract); know-to-ask failure 0.150 for all three; Sept rerun "zero missed triggers and zero false triggers on its expanded corpus". Delivery only, not uptake |
| P4 pressure gate (sealed), evals `2026-10-05-heldout-program/p4.md` | 2026-10-05; A′ `8c9a8e9a4` vs B `66956a3ee`; `claude-sonnet-5-5` | **sealed BEAM-500K**, 460 paired questions | 51.7% → 63.0%, **+11.35 [+8.3, +14.4] PASS**; $0.68 → $0.87 per question; evidence-saved 39.6% → 60.7%; 309 compaction segments got no notice. Caveat: the BEAM loader left most sessions undated, so temporal breakdowns are affected |
| P4 core gate (sealed) | 2026-10-06 | **sealed BEAM-100K**, 56 preference/instruction questions | **FAIL**: `gpt-6.1-sol` 88.1 → 85.7 (−2.4 [−5.4, +0.3]), drop in instruction following 91.1 → 85.7; `claude-fable-5-1` −2.4; `claude-opus-5-5` +0.3; `claude-sonnet-5-5` +4.6. Diagnosis lead: "with the standing instructions loaded at the top of every session, `gpt-6.1-sol` followed them less often than when it found the same page by retrieval" |
| N7 open loops, `2026-10-01-n7-open-loops-email.md` | 2026-10-01 `3a284ae`; reruns 10-02 `d44296c`, 10-03 `48ed5e8` | synthetic Gmail-shaped threads | Gate pass: planted-loop recall 45/45 (later 53/53), closure 39/39 (later 34/34 under the amended oracle), counterparty 45/45, remote 0 leaks. **Open gaps:** N7-3 promise fulfillment never tracked (4/4 fulfilled commitments stayed open in a $0.10 paid replay); N7-4 no Slack or calendar loops. N7-2 (a "Thanks!" reply closes the loop; 13/23 = 57% of reply-closed threads still waiting) was fixed in wave 7 |
| N2 contradictions, `2026-10-01-n2-contradiction-surfacing.md` | 10-01 `3a284ae`; rerun 10-03 `48ed5e8` | synthetic | Discovery 150/150 only with a supplied query naming company and attribute, **4/150 with 8 generic queries**; v4 judge: 149/150 conflicts, but false contradictions 6/51 compatible pairs (11.8%), so the decision rule fails; `find_contradictions` suspended for remote (N2-5) |
| P8 hidden-tool H family, dev smoke, `2026-10-02-model-ladder/p8-hidden-tool-dev-smoke/README.md` | 2026-10-05, build `6c958d6e2`, `gpt-6-luna`, 1 repeat | dev wide world | full listed 17/20; starter listed **0/20** (7 wrong values, mostly the superseded email forecast); verbs 1/20 (via paid `synthesize`); "called `request_tools` once, with an empty list, and got nothing back". $0.90 |

**Never measured (searched evals `docs/benchmarks`, `TODOS.md` and gbrain `docs/eval`):** whether an agent uses
pushed content (no uptake metric beyond the approximate `volunteer_context --stats`); task success with the
session-start pack on vs off; any push of open loops, delta or contradictions; push on Codex; push in real harness
sessions (Cat 41 has no push scenario); the pre-compaction notice's report-only slice on three more models ("not run
yet", p4.md).

### 1.3 Gaps between the bet and reality

1. **"Open commitments" is half there.** Commitments ride the session-start pack only via entity cards of banked
   entities. The Gmail-derived `open_loops` (who is waiting, what I promised) are never pushed, and remote callers get
   redacted loop evidence.
2. **"Recent changes" exists as `delta`** (a verb, in starter and verbs), but delta is pull: the agent must call it.
   Session-start uses pack mode, not delta, except for `since`-filtered open threads.
3. **"Contradictions with what the agent is about to say" does not exist.** There is no pre-answer check, stored
   reports are local-only, and discovery needs a query that names the entity (N2: 4/150 without one).
4. **"Before a meeting or an email reply" has no trigger.** Calendar sync and meeting pages exist, but no hook keys
   on an upcoming event or a reply-to-person intent. The triggers today are session start, every prompt (entity
   mentions only) and compaction.
5. **"Measure how often the agent uses them" has no instrument.** "Used" is the `last_retrieved_at` heuristic, which
   has a 5-minute throttle, false negatives and false positives (`push-context.md`, CLI section).
6. **Reach.** Push only works on the bootstrap lane (an agent workspace plus a PGLite/Postgres serve socket) and on
   OpenClaw. Plugins, `--surface verbs` quickstarts, Codex (beyond capture), remote MCP and thin CLI get nothing.
   Garry's OpenClaw registry entry is `modes: ['local-cli', 'thin-cli']` (`src/core/harness/registry.ts:34`).
7. **Associative recall is 0/240** (N8-4) and the Cat36 situation-cue work is "experimental and off by default"
   (`2026-09-23-situation-recall-protocol.md`). Its corpus labels still need independent review (round inventory B3).
   The narrow feature must not depend on it.

### 1.4 Risks and prior failures to avoid

- **Pushing instruction-like text at session start cost accuracy.** P4 core: −2.4 on `gpt-6.1-sol` and on Fable
  5.1. Pushed facts must read as data in the existing provenance envelope (`TURN_CONTEXT_ENVELOPE`), never as
  standing instructions, and must stay small.
- **Instruction wording moves results.** In the wave 12 smoke (2026-10-07), moving one `forget` sentence dropped Opus
  5.5 write-back from 20/20 to 15/20 (Opus with that text: 24 of 30 against 48 of 50 with the baseline text,
  Fisher p = 0.047). Any new push block or discover sentence needs a preregistered Cat 40 smoke before merge.
- **Privacy regressions have happened** (N8-1/N8-2). Any new push arm (loops, delta, contradictions) must inherit
  `resolveExcludePrivatePages` and be added to the N8 gate (`eval/registry.ts` entry `proactive-recall`) and to the
  N6 fuzz.
- **Confident wrong pushes.** Loops that never close on fulfillment (N7-3), a contradiction judge with 11.8% false
  contradictions (N2), and common-word aliases that fire 7.5% of the time (N8-3) would each turn into confident wrong
  unprompted claims. That works against bet (a).
- **Silent no-op.** All hook events fail open ("All events fail open: errors exit 0 with empty stdout",
  `hook.ts:257-259`). A push feature can be "on" and deliver nothing. The heartbeat file is the only trace.
- **Dates.** The P4 pressure gate ran on an undated BEAM loader. Any push evaluated on BEAM must use the fixed loader
  (gbrain-evals `evals/beam-session-dates`).

---

## Part 2. Distribution

### 2.1 What exists today: the MCP surface

**Tool count (exact).** The generated `docs/TOOL_CATALOG.md:7` lists "140 tools across 23 areas". Every
non-localOnly op, counted from the table rows (140), splits by scope as follows: read 72, write 32, admin 25,
admin+skill_publisher 2, sources_admin 2, read+skills_member_self 3, agent 2, write+skill_editor 2. Starter members:
**40**. Publish-gated: 5 (`advisor` → `mcp.publish_advisor`; `get_skill`, `get_skill_asset`, `list_brain_skillpack`,
`list_skills` → `mcp.publish_skills`). History from git: 137 at `d3a6aa7e` (2026-10-05, when the catalog renderer
landed, `d37fab68`), 138 at `aa02a8de` (#6014), 139 at `66cf3f58` (#6015), 140 at `7aa2caa0`. The tools added were
`put_pages`, `rate_answer` and `wanted_pages`.

**Surfaces** (`src/mcp/surface.ts`):
- `McpSurface = 'verbs' | 'starter' | 'full'` (line 42). `verbs` is exactly the ops with `verb: true`: `VERB_NAMES =
  ['recall','remember','entity','synthesize','forget','context_pack','delta']` (`src/core/verbs.ts:37`). It is frozen,
  and `request_tools` is never listed on it (header, lines 9-13).
- `STARTER_OPS` (line 91) is the 7 verbs, plus `BRAIN_TOOL_ALLOWLIST` (the subagent allow-list, a **fallback**: "the
  plan's STARTER_OPS derivation from the production `mcp_request_log` histogram ... had NOT landed", lines 61-70),
  plus agent-lane ops, `whoami`, `request_tools`, `capture`, `edit_page`, the write-request ops, the skills ops and
  `mute_notice`. The 40 starter tools are `mute_notice request_tools whoami get_ingest_log find_anomalies
  get_recent_salience cancel_job get_agent_job submit_agent get_backlinks list_link_sources traverse_graph
  context_pack delta entity forget recall remember synthesize cancel_write_request capture edit_page get_page
  get_write_request list_pages list_write_requests put_page resolve_slugs query search delete_skill get_skill
  get_skill_asset join_brain leave_brain list_brain_skillpack list_skills put_skill sync_brain_skills
  add_timeline_entry`. **Not in starter:** `put_pages`, `volunteer_context`, `open_loops`, `find_contradictions`,
  `takes_list`, `takes_search`, `find_trajectory`, `add_link`.
- Callable-surface resolution: stdio `GBRAIN_SURFACE` > `--surface` > config `mcp_surface` > `'full'`
  (`resolveStdioSurface`, lines 202-214). The kill switch `GBRAIN_MCP_FORCE_SURFACE` can only narrow.
- **Registrations gbrain writes pin `starter`**: `REGISTRATION_SURFACE = 'starter'` (`src/core/mcp-registration.ts:23`).
  This applies to init's quickstart (`init-first-run.ts:144-160`), `bootstrap hooks` and the plugin generator.
- **Advertised surface** `mcp.advertised_surface` (`resolveAdvertisedSurface`, line 339; DB plane, then file
  plane). It is **unset by default, which means advertise the whole callable set**, and it narrows `tools/list` only;
  dispatch keeps the callable set (lines 331-338). On stdio, tools revealed by `request_tools {tools}` are added to the
  list and `tools/list_changed` is sent (`stdioToolListing`, lines 363-384).
- HTTP: `effectiveSurfaceForClient` = min(ceiling, client row surface ?? `mcp.default_surface_dcr` ?? ceiling)
  (lines 404-416). `mcp.allow_session_widen` defaults to true (line 455).

**How hidden tools are discovered today:**
- `request_tools` (`src/core/ops/request-tools.ts:157`, read scope, `mutating: true`, area `discovery`). With no args
  it returns a catalog of one-liners grouped by area. `{tools:[names]}` returns schemas (and reveals them on stdio).
  `{surface}` widens the stdio session or persists per OAuth client, except when the client is operator-pinned
  (`surface_set_by === 'operator'` → `permission_denied`, "amendment 19").
  - **Defect:** `{tools: []}` takes the descriptor branch and returns `{tools: []}` (lines 298-316). The empty list is
    never treated as "list the catalog". This is exactly the call the H smoke observed.
- The initialize instruction sentence "The tool list shows the everyday tools; N more are callable. Call
  request_tools ..." (`instructions.ts:114-115`) is **appended after the contract**, and the contract runs about 4.8k
  characters (`INSTRUCTIONS_MAX_CHARS = 4_868`, `test/mcp-schema-budget.test.ts`). The code itself notes that
  "capped harnesses read the first 2,048 characters" (`instructions.ts`, #6170 comment). So on a capped harness the
  only discovery hint is cut off. Cat 40 passes the full instructions (`eval/runner/cat40/gbrain-arm.ts:449-452`), so
  this did not cause the P8 loss, but it matters in real harnesses.
- `hiddenToolHint` (`src/mcp/hidden-tool-hint.ts`): when an agent calls a real tool outside its surface over stdio,
  the error carries a `fix` → `request_tools {surface:'full'}`. It only fires on stdio, and only after the agent
  already knows the tool's name.

**Cost of the listed set.** `test/mcp-schema-budget.test.ts` pins the served starter list at 25,000 model-visible
characters or less (`SERVED_STARTER_MAX_CHARS`, line 51) and 5,700 tokens or less. Recorded measurements: 24,763
characters / 5,568 cl100k tokens after the cost wave, down from 59,969 / 13,077; 24,324 characters / 5,471 tokens
after entity recall. **gbrain #6271 (GBRA-39) reports 24,925 of 25,000**, so adding any tool to starter breaks the
budget unless something else shrinks. A full-surface token count is **not found**; it could not be measured here
because `node_modules` is absent.

### 2.2 What exists today: grants

- Profiles (`src/core/grants/profiles.ts:29-33`): `memory-reader` [read], `memory-writer` [read, write],
  `coding-agent` [read, write] plus a required isolated write namespace, `operator` [admin], `delegating-agent`
  [read, write, agent], `full` [admin, agent]. The default for new clients is **`memory-writer`** (`src/commands/mcp.ts:28`,
  `mcp-provision.ts:67`; `gbrain mcp grant ... profiles` prints `default: 'memory-writer'`, `mcp.ts:106`).
- Every profile stores an **operation snapshot**: `allowedOperations` = every non-localOnly op allowed by the scopes
  and bound-client fence **at mint time** (lines 41-43). It also sets `surface: 'starter'` for every profile except
  `full` and `operator`, with `surfaceSetBy: 'operator'` (line 46), which locks out agent self-widening.
- The docs agree: `docs/guides/hosted-harness-access.md:111-117` gives every non-admin profile "Starter". Line 122
  says: "New grants snapshot operation names ... A later server upgrade does not silently give a snapshot-bound client
  new operations". The fixes are `gbrain auth rescope-client <id> --allowed-operations …`, `--operations all`
  (includes future ops) or `rescope-token --refresh-operations` (preview) then `--add`.
- Native registration without explicit permissions "defaults to `read` on source `default`" (`docs/mcp/ADMIN.md:136`).
- Legacy `gbrain auth create` without `--scopes` holds read, write and admin (`ADMIN.md:289-293`) and has no snapshot.
- Grant migrations "only narrow unusable delegation; never grants tools or scopes" (`src/core/grants/migration.ts:6`).
- `put_pages` shipped in **v0.60.64.0 (2026-10-05)**, described as "New MCP tool `put_pages` (full surface)"
  (`CHANGELOG.md:1339`). Instructions mention it only if callable (`instructions.ts:65-66`).
- **Why Garry's token lacks `put_pages`** (mechanism read from code; his actual grant was not inspected): (1) every
  `memory-writer` client is operator-pinned to `starter`, which excludes `put_pages`, and request_tools cannot widen an
  operator pin; (2) any client minted before 2026-10-05 also lacks it in its snapshot. Check with `gbrain auth clients`
  (shows `operations` and `includes_future_operations`) or `whoami`.

### 2.3 What exists today: install paths

There are **13 harness adapter IDs** (`src/core/harness/registry.ts:22-58`): claude-code, claude-desktop, codex,
opencode, openclaw (local-cli, thin-cli), grok-build, grok-bot, muse, muse-code, hermes (**stdio only, `connection:
'manual'`**), cursor, perplexity, chatgpt, plus generic. README "Choose your setup" offers 3 top-level choices, then 3
bootstrap lanes, 4 "lighter ways in" and 12 per-client connection bullets (`README.md:11-245`).

| Harness | What exists | Default surface | One command? | Push? |
|---|---|---|---|---|
| Claude Code | plugin (`/plugin marketplace add garrytan/gbrain`), `claude mcp add ... serve --surface verbs` (README), init quickstart line (starter), `gbrain bootstrap hooks` (needs agent workspace), `gbrain connect URL --token --install` (remote) | verbs, starter or full depending on path | Plugin is 2 commands plus `bun install -g` plus `gbrain init`; hooks need the ~15-minute bootstrap (`BOOTSTRAP_FOR_AGENTS.md:19`) | Bootstrap lane only |
| Codex | plugin (`codex plugin marketplace add garrytan/gbrain@codex-plugin`), `codex mcp add`, `gbrain connect --agent codex` | starter / verbs | similar | SessionEnd capture only |
| OpenClaw | ClawHub bundle plugin, `openclaw mcp add` (`docs/mcp/OPENCLAW.md`), thin CLI block (`openclawThinClientBlock`, `mcp-registration.ts:211-240`: "native remote MCP isn't supported yet") | full (bare `serve`) | Plugin install | Reflex context engine (local); none on thin CLI |
| Hermes | `printf 'Y\n' \| hermes mcp add gbrain ... --args serve` (`INSTALL_FOR_AGENTS.md:423`) | full (bare `serve`) | One command plus a manual `hermes mcp test` verify | None |
| Grok Bot / Muse | `scripts/setup-in-agent.sh --harness grok-bot|muse` (`docs/guides/in-agent-setup.md` §2), or `gbrain mcp expose --funnel` + `mcp grant` + thin CLI | profile (starter) | Closest to one command | None |

`gbrain mcp expose` prints the next step `gbrain mcp grant NAME --harness ID --profile memory-writer ...`
(`src/commands/mcp-expose.ts:94, 415, 1020-1029`). **No `gbrain setup <harness>` command exists**: a grep of
`src/commands` finds no setup-claude or setup-codex. `gbrain bootstrap harness` and `gbrain agent register <name>
--harness claude-code|codex|opencode|openclaw` (`agent-register.ts:143`) are the nearest.

**Inconsistent surfaces across paths** (a simplicity cost in itself): init → starter; README lighter-way, Grok Build
and opencode docs → `--surface verbs`; Hermes and OpenClaw → bare `serve` = full; plugins → starter; OAuth profiles →
starter.

**Measured install outcomes (Cat 41,** `2026-10-03-agent-operator.md`, gbrain v0.60.35.0 `566a242`, real Claude Code
and Codex CLI in containers, 102 sessions): `fresh_install_to_wired_recall` 3/3 Claude (mean 93.4 s, $1.50) and 3/3
Codex (mean 437.9 s, $1.70); baseline pass spend $16.38. Codex took "4 to 8 minutes".

### 2.4 What has been measured on narrowing the surface (P8, gbrain #6027, v0.60.77.0)

- **Preregistration** (`docs/eval/decisions/p8/PREREGISTRATION.md` §7): Cat 40, callable `full` in every arm,
  advertised `full` vs `starter` vs `verbs`, 4 models, 2 repeats, at least 100 tasks with at least 20 hidden-tool (H)
  tasks. Gates: pooled success no worse than control −3 points, hidden-tool no worse than control −5, no rise in
  leaks. $800 cap.
- **Dev** (`DEV_RESULTS.md:68-88`, model-ladder-v1, **not sealed**, build `8f585b0ce`, **no H family**): full 90/100,
  starter 92/100 (+2.0 [−2.0, +7.0]), verbs 88/100 (−2.0 [−7.0, +3.0]). Input tokens 30.4M / 14.7M / 12.8M; dollars
  $38.09 / $29.54 / $28.24 ("Starter cuts dollars by 22% and input tokens by 52%"). `request_tools` calls: 0 / 0 / 3.
- **Sealed** (`SEALED_VERDICTS.md:50-71`; evals `2026-10-05-heldout-verdicts/p8-surface-heldout-2026-10-05.json`;
  build `6c958d6e2`, harness `0b7abad`, seed-disjoint P0 world, 120 tasks including 20 H; models Sonnet 5.5,
  GPT-6.1 Sol, Opus 5.5 (2 repeats each) and Fable 5.1 (1 repeat)). This is the held-out test that was lost:

| Arm | Pooled | Δ (95% CI) | Hidden-tool | Δ | $ |
|---|---|---|---|---|---|
| full (control) | 93.2% | | 96.9% | | 236.75 |
| starter | 84.7% | −8.5 (−12.5, −4.8) | 46.9% | −50.0 (−58.1, −42.5) | 233.56 |
| verbs | 83.3% | −9.9 (−13.3, −6.7) | 75.6% | −21.2 (−28.7, −14.4) | 240.98 |

  Per model, starter H: Sonnet 100 → 57.5, GPT-6.1 Sol 87.5 → **5.0**, Opus 100 → 100, Fable 100 → 25. Verbs H:
  87.5 / 50.0 / 95.0 / 70.0. Without Fable: starter −7.5, verbs −9.0 pooled. Total spend $766.93.
  "The arms cost about the same, so the narrower lists saved no tokens."
- **Derived here from the aggregates** (my arithmetic; ±0.1 from rounding): non-H success on 100 tasks is full
  (93.2·120 − 96.9·20)/100 = 92.46%, starter 92.26% (**−0.2**), verbs 84.84% (**−7.6**). So starter lost only the
  hidden-tool family, and verbs lost ordinary memory and write-back tasks too. The verbs surface has no
  `search`/`query`/`get_page`/`put_page` ("The verbs surface serves no put_page (its write is remember)",
  `cat40-model-ladder.ts:508`).
- **What H measured** (`2026-10-02-model-ladder-protocol.md`, "The wide world and the hidden-tool family"):
  renewal forecasts stored as takes; gbrain strips the takes table from `get_page`/`search`/`query` for MCP callers,
  so only `takes_list`/`takes_search` reach them; for half the accounts an email quotes the earlier, superseded
  forecast. **Failure mode** (dev smoke): with the narrow list "the model never called a takes tool. It called
  `request_tools` once, with an empty list, and got nothing back. Wrong answers were mostly the superseded forecast
  from the email." This is a confident wrong answer caused by the advertised tools returning a plausible stale value.
- **Outcome shipped:** new installs advertise `full`. `mcp.advertised_surface` is opt-in. New stdio registrations
  keep `serve --surface starter`. Note the tension: Cat 40's sealed loss was for *advertised* starter with *callable*
  full, yet every default registration runs *callable* starter, where hidden tools need a session widen.

### 2.5 The September 21 review

Not found. Searched gbrain (`docs/`, `TODOS.md`, `CHANGELOG.md`), gbrain-evals (`docs/`, `TODOS.md`, both 10x
plans), and Capy Drive (`project-gbrain/`, `project-user-gbrain-garry-tan/`, `user-garry-tan/`, `org-gstack-gbrain/`)
for "September 21", "2026-09-21", "Sep 21" and "simplicity". The only hits are unrelated CHANGELOG or engine dates.
The prior 10x plan (evals `docs/plans/2026-09-28-gbrain-10x/PLAN.md`, autoplan 2026-09-28) does not quote it. The
only statement of it is GBRA-60's own framing ("adoption is limited by simplicity, not features, and the tool count
went from 137 to 140"). The 137 → 140 count checks out against the catalog history above.

### 2.6 Distribution gaps

1. **Seven verbs plus discover, as stated, reproduces the losing `verbs` arm** (−9.9 pooled, −7.6 on non-H). The
   core set needs search, read-page and write-page tools. In practice the "7" becomes about 7 tools of which at most
   4 are the current verbs.
2. **Discovery is pull-by-guess.** Models do not call `request_tools` unless they suspect a missing tool. In the
   sealed H family, `search` returned something plausible, so they never suspected one. The empty-`tools` defect
   wastes the one attempt they make.
3. **Grant default.** `memory-writer` is operator-pinned to `starter`, and snapshots freeze the op list. No migration
   may widen either (migration.ts:6).
4. **One-command setup exists only for Grok Bot/Muse** (`setup-in-agent.sh`). Claude Code and Codex hooks need the
   bootstrap interview. Hermes is manual with a bare full surface. OpenClaw push is lost on thin CLI.
5. **Usage-derived core.** `STARTER_OPS` was never derived from `mcp_request_log` (surface.ts:61-70).
   `scripts/derive-starter-ops.ts` and `src/core/mcp-usage.ts` exist but have not been run on real usage. Nobody
   knows which 7 tools Garry's agents actually call.

### 2.7 Distribution risks

- Re-running a narrower-surface test on the **already opened** P8 sealed world would be tuning on held-out data. The
  P8 world is spent. A new seed-disjoint wide world is required.
- **Fable is smoke-only** (project AGENTS.md, 2026-10-07). P8 used Fable in counted cells, so a new gate's model list
  is Opus 5.5, Sonnet 5.5 and the newest GPT (P8 used `gpt-6.1-sol`; check at run time). The preregistration must
  record why the model list differs from P8. Do not use gpt-5.4-mini.
- Opus sat at 100% on starter H and 100% on full H, a ceiling. Report the models people use first.
- The starter character budget is at 24,925/25,000 (#6271). A new `discover` tool must fit or replace
  `request_tools`'s 560-character budget (`TOOL_BUDGETS.request_tools`).
- Wording sensitivity (wave 12 smoke): the discover description and instruction placement need a smoke.
- Widening grants is an authority change. It needs consent (`ask_user`), a `BEHAVIOR_CHANGES` row
  (`src/core/behavior-change-notice.ts`, 72 rows) and a doctor finding, not a silent migration.

---

## Part 3. Proposed work items

Effort is in human-days (hd) and agent-hours (ah). Costs come from receipts cited above. Version and migration
numbers are chosen at merge time (head is v219 on master; #6271 also references v219).

### D1. Fix `request_tools` empty-list and catalog ergonomics
- **Goal:** `request_tools {tools: []}` (and an unknown-name-only list) returns the catalog plus a "did you mean"
  instead of an empty array. The catalog response leads with capability families ("takes / forecasts", "open loops",
  "contradictions", "timeline/trajectory").
- **Files:** `src/core/ops/request-tools.ts` (descriptor branch lines 298-316, catalog branch 318-338),
  `test/request-tools*.test.ts`, `docs/TOOL_CATALOG.md` (regenerate).
- **Migration:** no. **Effort:** 0.5 hd / 2-3 ah.
- **Proof:** Cat 40 H-family dev smoke (the P8 smoke recipe, 20 tasks), advertised starter, H success rises from
  0/20. **Cost:** about $1-5 (smoke $0.90 last time). It is a smoke, not a gate, so a non-Fable cheap model is fine.

### D2. In-band discovery: results name the tool that holds the rest
- **Goal:** when a listed read tool omits content that a hidden tool serves, the result says so with a `next`
  pointing at the tool, and on stdio it reveals that tool (`revealTools`). Cases: takes stripped from
  `get_page`/`search`/`query`, `open_loops` for a person page, `find_trajectory` for metric facts, `add_link` after
  writes. Discovery then rides on what the agent already called, which removes the "never suspected a tool was
  missing" failure behind the H collapse.
- **Files:** `src/core/ops/search.ts`, page read ops, the takes-strip site (`src/mcp/dispatch.ts:170-178` region),
  `src/core/interop-notices.ts`, `src/mcp/surface.ts` (`stdioToolListing.reveal`), the HTTP per-session reveal,
  `test/mcp-schema-budget.test.ts` (result text is not in the list budget).
- **Migration:** no. **Effort:** 3 hd / 12-20 ah.
- **Proof:** a new seed-disjoint Cat 40 wide world (`bun eval/generators/model-ladder-gen.ts --scale wide`, new
  seed), preregistered, arms advertised `full` vs advertised `core+discover` (D3), with P8's gates unchanged (pooled
  ≥ control −3, H ≥ control −5, no leak rise) and a new secondary metric: **wrong-value rate on H** (the confident
  stale answer). Models: Opus 5.5, Sonnet 5.5, newest GPT, 2 repeats. **Cost:** P8's sealed spend without Fable was
  $124.72 (full) and $120.61 (starter) for 3 models × 120 tasks × 2 repeats, so 2 arms ≈ **$250**, plus a dev round
  ≈ $60 and slot builds ≈ $1.

### D3. Define the advertised core from evidence, not from `VERB_NAMES`
- **Goal:** a new advertised surface (working name `core`) of about 8 tools: the read/write primitives the non-H
  stratum needs (`search` or `query`, `get_page`, `put_page`), the memory verbs agents call most (`recall`,
  `remember`, `context_pack`, `entity`) and `discover` (`request_tools` renamed or aliased, listed first, with a
  description that names the hidden families). Keep `verbs` frozen; its semantics are pinned (surface.ts:9-13).
- **Step 0:** run `scripts/derive-starter-ops.ts` over `mcp_request_log` on Garry's brain (owner-run, read-only, $0)
  to see which tools real agents call. This replaces the FOV-6b fallback.
- **Files:** `src/mcp/surface.ts` (union, rank, `filterOpsForSurface`), `src/core/config.ts` (`advertised_surface`
  type), `src/core/mcp-registration.ts`, `src/core/grants/profiles.ts`, `src/mcp/instructions.ts` (move the hidden-tool
  sentence **inside the first 2,048 characters**), `test/mcp-surface.test.ts`, `test/mcp-schema-budget.test.ts`,
  `docs/TOOL_CATALOG.md`, `docs/mcp/*`.
- **Migration:** no for the file/DB config plane. `oauth_clients.surface` is an open TEXT value space (amendment 18,
  surface.ts:288-300), but older servers ignore unknown values with a warning, so ship server support before writing
  rows.
- **Effort:** 3 hd / 12-16 ah. **Proof:** same run as D2 (one preregistration, arms `full` vs `core`). Also report
  input tokens per task, because the sealed P8 run showed no token saving ($236.75 vs $233.56) even though dev showed
  −52% input tokens. Tokens are a reported metric, not a gate, unless Garry preregisters one.

### D4. Grant default that includes `put_pages`
- **Goal:** new `memory-writer`/`memory-reader`/`coding-agent` grants get callable ceiling `full` (authority is still
  the scope plus the snapshot) with advertised `core`, so `put_pages` and the other hidden write tools are callable.
  Also offer `--operations all` (future ops included) as an explicit, disclosed choice.
- **Existing clients:** no widening migration (forbidden by `grants/migration.ts:6`). Add a doctor finding
  (`grant_new_ops_available`: snapshot or pin excludes `put_pages` or other write ops added since mint) whose fix is
  `next: ask_user` with `gbrain auth rescope --client ID --operations ...` or `--surface full`, plus a
  `BEHAVIOR_CHANGES` row for the new-grant default (`src/core/behavior-change-notice.ts`).
- **Files:** `src/core/grants/profiles.ts:46`, `src/commands/mcp-provision.ts`, `src/commands/doctor.ts`,
  `behavior-change-notice.ts`, `docs/guides/hosted-harness-access.md:111-122`, `docs/mcp/ADMIN.md`,
  `skills/mcp-access/SKILL.md`.
- **Migration:** no schema migration (columns exist). **Effort:** 2 hd / 8-12 ah.
- **Proof:** hermetic unit and E2E tests (grant snapshot contains `put_pages`; `tools/call put_pages` succeeds on a
  fresh memory-writer client; an operator-pinned old client is reported, not widened), N6 visibility fuzz unchanged
  (0 leaks), $0. Cat 41 hosted-connect scenario: one-session bulk write succeeds, about $5.

### D5. Narrow proactive brief: three facts before a meeting or a reply
- **Trigger points:**
  1. `SessionStart` (exists) gains a "Before you start" section.
  2. A new `UserPromptSubmit` intent gate: the prompt names a person or company that the brain resolves at ≥ 0.8
     (alias/title arms only, never common-word aliases, N8-3) **and** either a calendar event with that counterparty
     starts within N hours, or the prompt matches a reply/email/meeting intent (deterministic lexicon, zero LLM).
  3. MCP pull: `context_pack` gains `intent: 'meeting'|'reply'` and `counterparty`, for harnesses without hooks.
- **What is pushed:** at most **3 items** per counterparty, ranked: (a) open loops (`commitment_owed_by_me`,
  `unanswered_inbound`) from `open_loops`; (b) the newest dated change (delta since the last session); (c) one stored,
  certified contradiction touching that entity, local only until `find_contradictions` remote is unsuspended (GBRA-58).
  Each item carries a date, a source slug and a short id (`[g:xxxx]`).
- **Size cap:** ≤ 600 characters per item and ≤ 1,800 characters total, inside the 8,192-byte turn budget and the
  10,000-character session-start cap. Compare N8's 24.6 tokens per turn today; this stays far below the reader's 22k.
- **Privacy gate:** world-only like pack mode; `resolveExcludePrivatePages`; remote loop evidence stays redacted; add
  the new arm to the N8 `proactive-recall` safety rules and the N6 fuzz before default-on.
- **Confident-wrong guard:** skip loops older than the staleness halflife, skip google sources that are >24 h stale
  (the `gbrain waiting` refusal rule), mark any undated item "undated". Never push a contradiction from a judge run
  that failed its N2 rule.
- **Uptake telemetry:** reuse `context_volunteer_events` with new `channel` values (`brief-session-start`,
  `brief-prompt`) and `match_arm` (`loop`, `delta`, `contradiction`). TEXT columns, so **no migration for v1**. Add
  a local Stop-hook scorer that marks "used" when the assistant's reply contains the item's id or its value (hashes
  only, like S6 receipts). A `used_at`/`used_how` column would need a migration; defer it.
- **Files:** `src/core/context/turn-context.ts`, `src/commands/hook.ts`, `src/core/context/resolve-ipc.ts`,
  `src/core/ops/loops.ts` (export a ranked top-N reader), `src/core/verbs` (context_pack params),
  `src/core/context/volunteer-events.ts`, `docs/guides/push-context.md`, `src/mcp/instructions.ts` (only if the
  smoke passes).
- **Effort:** 6-8 hd / 30-45 ah. Ship **off** by default until D6 passes.

### D6. Measure uptake in Cat 40-style tasks (new family P, "pushed fact")
- **Design:** two-session tasks built on Family F's write-back structure (`2026-10-02-model-ladder-protocol.md`,
  family F). Session 1 seeds a commitment, a dated change and a conflict. Session 2 asks a meeting-prep or reply task
  whose correct answer needs one of them, and the prompt never names the fact. Arms: brief **on** vs **off** (same
  tools). Every task carries a ledger answer, and the Cat 40 records already log `tool_calls` (name, ms, chars) per
  run (`cat40-model-ladder.ts:94`).
- **Metrics (preregister):** task success Δ; **uptake rate** = items whose value appears in the answer ÷ items
  pushed; **confident-wrong rate** = answers asserting a superseded or closed item; tool calls and input tokens per
  task; false-push rate on tasks where nothing should be pushed.
- **Dataset:** a new generated world (dev seeds for development, a sealed seed for the decision); the N8 world stays
  the privacy gate.
- **Cost:** 60 tasks × 2 arms × 3 models × 2 repeats is about half of a P8 arm-pair, so **≈ $125 sealed + ≈ $40
  dev** (scaled from $124.72 per arm for 120 tasks). Effort 3 hd / 15-20 ah in gbrain-evals (registry row,
  preregistration, paid-arm guard, scorer mutation kit per `eval/CONTRIBUTING.md`).

### D7. Measure uptake in real harness sessions (Cat 41 scenarios)
- **Design:** add 4 scenarios to `eval/runner/cat41/scenarios.ts`: meeting prep, reply to an email, start-of-task
  with an open commitment, and a negative (no relevant entity). Claude Code with bootstrap hooks vs without; Codex once
  D8 gives it SessionStart. Score from transcripts (`cat41/transcript.ts`, `classify.ts`): did the assistant surface
  the pushed item, did it act on it, and did it repeat a stale or closed item.
- **Cost:** about $0.16-0.57 per session (baseline $16.38/102 sessions; install scenario $1.50-1.70 per 3 runs).
  4 scenarios × 2 harnesses × 2 arms × 3 runs = 48 sessions ≈ **$15-30**. Effort 2 hd / 8-12 ah.
- **Production signal:** `gbrain volunteer-context --stats` per channel plus the D5 Stop-hook "used" marks on
  Garry's brain (owner-run, local, no text leaves the machine).

### D8. One command per harness: `gbrain setup <harness>`
- **Goal:** one idempotent command that does `init --pglite --no-embedding` if no brain exists, registers MCP with
  advertised `core` (D3) and callable full, installs push hooks **without** requiring the bootstrap interview (split
  `runHooks` from the `agent.json` gate at `bootstrap.ts:1093-1100`), and verifies with a remember/recall round trip
  plus one hook heartbeat.
  - **Claude Code:** register + SessionStart/UserPromptSubmit/PreCompact hooks. The plugin path should ship
    `hooks/hooks.json` so plugin installs also get push.
  - **Codex:** add SessionStart/UserPromptSubmit to `codex-hooks.ts` if the pinned codex-cli supports them (the spec
    target 0.147.0 verified only SessionEnd; re-verify against the current CLI); keep the trust-gate writer.
  - **OpenClaw:** keep the plugin; add the thin-client remote push route (`TODOS.md` P3: `volunteer_context` over
    remote MCP from the hook), because Garry's OpenClaw runs thin CLI.
  - **Hermes:** wrap `hermes mcp add` + `hermes mcp test` and pin a surface instead of bare `serve`. Hermes has no
    hook API in the registry (`connection: 'manual'`), so push there is MCP pull via D5 trigger 3.
- **Also:** one default surface constant for every path (README, INSTALL_FOR_AGENTS, docs/mcp/*, plugin manifests).
- **Files:** new `src/commands/setup.ts`, `src/cli/command-table.ts`, `src/core/bootstrap/{hooks,codex-hooks}.ts`,
  `src/core/mcp-registration.ts`, `.claude-plugin/plugin.json`, `.codex-plugin/mcp.json`, `openclaw.plugin.json`,
  `README.md`, `INSTALL_FOR_AGENTS.md`, `docs/mcp/{CLAUDE_CODE,CODEX,HERMES,OPENCLAW}.md`.
- **Migration:** no. **Effort:** 5-7 hd / 25-35 ah (Codex hook re-verification is the unknown).
- **Proof:** Cat 41 `fresh_install_to_wired_recall`, extended to "fresh install to first pushed item", on Claude Code
  and Codex. Targets: 3/3 success, agent wall time (baseline 93.4 s Claude, 437.9 s Codex), user replies ≤ 1, zero
  safety violations. **Cost:** ≈ $5-10 per pass.

### D9. Make `find_contradictions` and loop evidence safe for remote push (dependency)
- **Goal:** unsuspend remote `find_contradictions` with visibility and trust-tier filtering, so pushed conflicts can
  reach hosted agents. This depends on GBRA-58's trust tiers (#5575) and N2's judge rule passing.
- **Effort:** 2-3 hd / 10 ah after #5575 lands. **Proof:** N6 fuzz 0 leaks; N2 compatible-pair false-contradiction
  rate under its rule (currently 11.8%, failing). Paid N2 rerun about $10 (preregistered budget raised from $6 to $10).

### Not proposed now
Associative (situation) recall as a push trigger. It stays research until the associative-recall-v1 labels pass
independent human review, and N8-4 says gbrain does not claim it.

---

## Part 4. Evaluation plan and budget summary

| Item | Dataset | Gate / metric | Sealed? | Cost |
|---|---|---|---|---|
| D1 | Cat 40 H dev smoke | H success from 0/20 | dev | ≤ $5 |
| D2+D3 | new seed-disjoint Cat 40 wide world (≥ 100 tasks, ≥ 20 H) | P8 gates (pooled ≥ −3, H ≥ −5, no leak rise); report H wrong-value rate and tokens | sealed (custodian) | ≈ $250 + $60 dev |
| D4 | hermetic grant tests + N6 + Cat 41 bulk write | `put_pages` callable on a fresh memory-writer client; 0 leaks | n/a | ≈ $5 |
| D5 privacy | N8 world + new brief arm | 0 private items remote and in the block | gate, $0 | $0 |
| D6 | new family P | success Δ, uptake rate, confident-wrong rate, false push, tokens | dev, then sealed | ≈ $40 + $125 |
| D7 | Cat 41 + 4 scenarios | surfaced/acted/stale in transcripts | report | ≈ $15-30 |
| D8 | Cat 41 fresh install | 3/3, wall time, ≤ 1 reply, 0 violations | report | ≈ $10 |
| D9 | N2 + N6 | N2 rule, 0 leaks | gate | ≈ $10 |

Total paid ≈ **$520-560**, mostly D2/D3 and D6 sealed cells. Ubicloud time follows the project rules
(`UBI_OWNER=gbra60`).

---

## Part 5. Overlaps with in-flight work

- **gbrain #6271, Cat 40 Hard fix wave (GBRA-39; draft, head `08e68fe06`)** touches `src/core/ops/search.ts`,
  `page-batch.ts`, `persistence.ts`, `dispatch.ts` and `operations-descriptions.ts`. It reports the starter list at
  **24,925/25,000 characters**. D2/D3 edit the same files and budget: stack D2/D3 after #6271 merges. Its
  Cat 40 Hard world (evals **#76**, "gbrain trails plain files by 11.3 points on a 55,000-document company", and the
  sealed generator **#77**, fix-wave plan **#93**) is the natural harder world for D6.
- **gbrain #6066 + evals #69, memory-proof wave (GBRA-52; drafts)** cover dated evidence and per-model supersession
  thresholds; the primary endpoint is "BEAM 100k + 500k + 1M, ... 54 sealed conversations". D5's "newest dated
  change" and stale-item guard should consume #6066's dated-evidence fields. Avoid BEAM sealed conversations for D6.
  They belong to GBRA-52.
- **GBRA-45 `capy/sync-feeder-fast-writes`:** write-path speed. Overlaps D4 only in that `put_pages` throughput
  claims belong there. No file overlap with D1-D3 found.
- **GBRA-58, trust tiers plan for #5575** ("memory trust tiers, blocking write gate, and verifiable forget --purge"):
  D5 must not push quarantined or low-trust memory. D9 depends on it. Coordinate the tier filter in the push resolver.
- **GBRA-59, plan for #6278** ("Managed sync stalls every pass ..."): a stalled managed sync means a stale brain, so
  D5's freshness guard (skip stale google sources, mark stale) must read the same freshness signals. No file overlap.
- **GBRA-49 evals #88 (Q2 parser gaps)** and its Q1 scoreboard with BEAM-10M: the surface-form parser limits
  (`2026-10-05-heldout-program.md`, "Surface-form parsers cap relational ideas") also limit D5 trigger 2's intent
  lexicon. Reuse #88's reworded-phrasing sets to test the meeting/reply intent gate for false negatives.
- **Contributor PRs touching this area (do not merge; fold if needed):** gbrain #6202 (`oauth.dcr_default_source`,
  overlaps D4 grant defaults), #5372 (Prime Agent harness adapter, overlaps D8 registry), #5524 (loop extraction
  exclude labels, overlaps D5 loop quality), #5552 (graded confidence on `remember`).
