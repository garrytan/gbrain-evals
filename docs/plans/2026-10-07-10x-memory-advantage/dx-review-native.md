INPUT: dx 2ce6d25fe9a00a7add9e0ab15aecf2b06d19a447dd7d47c03105d15d26389151

# DX review: "Build the 10x memory advantage: the wave plan" (independent native reviewer)

Read: `native-prompt.md` lines 1-480 in full (SHA-256 c29792e7…e819e9 verified; embedded plan = `dx-implementation.md`, SHA-256 2ce6d25f…151 verified).
Pins checked: gbrain `/workspace/gbrain` at `7aa2caa0` (VERSION 0.60.106.0); gbrain-evals at `f1ce49fe`. Evals branches read with `git show`: `origin/capy/oss-memory-shootout` (`eval/systems/PROTOCOL.md`), `origin/evals/q1-scoreboard` (`docs/scoreboard.md`, `eval/runner/scoreboard-cli.ts`). Audit D read in full for Part 2 and Part 3. CEO review files were not used, to keep this review independent.

## Verdict

The plan's developer surface points the right way. D1, D4, E-A and E-B fix real silent failures, D8 attacks install sprawl, and every new capability ships behind a flag with a `BEHAVIOR_CHANGES` row. As written, though, four things undercut it. The wave 0 backlog runbook has a "green" verify that already passes on master with 136k chunks missing. The default surface is never named, so README keeps shipping the arm that lost P8. The TTHW baselines are 70 releases old, and the Codex number is 3.6x worse than the newest measurement. And all of the first-ten-minutes work sits in an unscheduled wave whose order depends on a reading-accuracy pilot that can't rank it. Each of these is cheap to fix in the plan text.

## Scores (0-10, the plan as written; target after the checklist)

| # | Dimension | Score | Target | Evidence in one line |
|---|---|---|---|---|
| 1 | Getting started / TTHW | 5 | 8 | D8 is the right command, but it's unscheduled (wave 2) and measured against stale, mismatched baselines (DX-1, DX-14) |
| 2 | API and CLI naming | 4 | 7 | `as_of`, `known_as_of`, `at` and `since` all mean different clocks, sometimes on the same op; `track_record` duplicates `takes scorecard`; `discover` vs `request_tools` (DX-7, DX-8) |
| 3 | Error handling and actionability | 6 | 8 | D4's `ask_user` + rescope is good; W3, A9, E-C, D8 and D8b refusals have no code, fix or docs anchor; hosted clients get an opaque `unknown_tool` (DX-6, DX-9, DX-10) |
| 4 | Documentation | 5 | 8 | The runbook is "a symptom row"; README and plugin manifests disagree on the surface; frozen-verb protocol doc missing from file lists (DX-2, DX-3, DX-15) |
| 5 | Escape hatches | 6 | 8 | Off-by-default flags everywhere; `gbrain setup` has no dry-run, undo, `--no-hooks` or `--surface`; audit D's `--operations all` choice was dropped (DX-6, DX-12) |
| 6 | Consistency across CLI, MCP, thin client and harness | 4 | 7 | Three different default surfaces today; new CLI commands under `pages` refuse on thin clients, where the flagship user lives (DX-3, DX-11) |
| 7 | Upgrade and migration path | 7 | 8 | No widening migration (`grants/migration.ts:6` respected), additive migrations, a ledger backup contract; missing: a client-side signal that a grant is stale (DX-6) |
| 8 | DX measurement | 6 | 8 | Cat 41 and Cat 40 smokes are strong habits; the funnel's day-7 retention can't be measured with opt-in capture and n = 3; no correction or return scenarios (DX-13, DX-18) |

Overall about 5.4 of 10 as written, about 7.8 with the checklist below.

## Time to hello world (TTHW)

**What "hello world" is here.** A fact remembered in session 1 is recalled through the harness MCP tools in a new session. This is Cat 41 `fresh_install_to_wired_recall` (evals `eval/runner/cat41/scenarios.ts:454-460`), where the agent does the install itself. Download time is measured separately as `download_ms` (lines 464-467).

**Current human path** (README "Lighter ways in", `README.md:174-181`, plus the install section and `INSTALL_FOR_AGENTS.md:210` "Step 3.5 ... DO NOT SKIP"):
1. `bun install -g github:garrytan/gbrain`
2. `gbrain init --pglite --no-embedding`
3. relay the 9-cell search-mode matrix and confirm (mandatory under AGENTS.md; README's "two commands" leaves it out)
4. `claude mcp add gbrain -- "$(command -v gbrain)" serve --surface verbs`
5. restart the harness
6. remember a fact, then recall it in a new session

That's 6 steps, 3 commands and 1 decision, and it lands on `--surface verbs`, P8's losing arm (−9.9 pooled; −7.6 on non-hidden-tool tasks by audit D §2.4's derivation). Nothing is pushed on this path: hooks need the bootstrap interview (`bootstrap.ts:1093-1100` refuses without an initialized `agent.json`).

**Current measured agent numbers** (evals `docs/benchmarks/2026-10-03-agent-operator.md:113-114`, `after-b3f4e8b/gate.json`):

| Build | Claude Code | Codex | n |
|---|---|---|---|
| `566a242` (v0.60.35.0, the baseline the plan cites) | 93.4 s | 437.9 s | 3 + 3 |
| `7d16702` (v0.60.38.0 early after-pass) | 97.9 s | 234.4 s | 3 + 3 |
| `b3f4e8b` (v0.60.38.0 confirmation pass, gate passed) | 96.7 s | 121.7 s | 3 + 3 |
| v0.60.106.0 (the plan's frozen release) | not measured | not measured | |

The plan's "wall time vs 93.4 s / 437.9 s baselines" (D8 proof) compares against the pre-fix build. It also extends the scenario to "first pushed item", which adds a session, so the times aren't comparable either way. Against 437.9 s, D8 would score a free 3.6x Codex win that the agent-operator wave already banked.

**Proposed targets** (to freeze in the wave 2 preregistration after a re-baseline on v0.60.106.0):
- Human path: 2 commands (`bun install -g …`, `gbrain setup <harness>`) and 1 decision (search mode, asked inside `setup`), no restart for Claude Code plugin installs.
- Agent wall time, unextended `fresh_install_to_wired_recall`: Claude Code ≤ 60 s, Codex ≤ 120 s (no regression from 121.7 s), with `download_ms` reported beside it.
- New cell `fresh_install_to_first_push`: Claude Code ≤ 120 s, Codex ≤ 180 s, 3/3, ≤ 1 user reply, 0 consent violations. This is a new metric with no baseline, so it's reported as measured rather than as an improvement.

## Developer journey map

| Stage | Today (evidence) | What the plan changes | Remaining friction |
|---|---|---|---|
| 1. Fresh install | 13 harness ids (`src/core/harness/registry.ts`), README offers 3 choices + 3 lanes + 4 lighter ways + 12 client bullets (audit D §2.3); surfaces disagree: README `verbs`, plugins `starter` (`.claude-plugin/plugin.json:26-28`, `.codex-plugin/mcp.json`), OpenClaw bare `serve` = full (`openclaw.plugin.json`), thin CLI full (`docs/architecture/thin-client.md`) | D8 `gbrain setup <harness>`, one surface constant (wave 2, unscheduled) | The constant's value is never named; `setup` becomes a 6th entry point beside `init`, `connect --install`, `agent register`, `bootstrap hooks`, `mcp expose` |
| 2. First useful recall | Keyless recall works (Cat 41 6/6); capped harnesses never see the discovery sentence, which is appended after a ~4.8k contract (`src/mcp/instructions.ts:53,114-115`; `INSTRUCTIONS_MAX_CHARS = 4_868`); `request_tools {tools: []}` returns `[]` (`request-tools.ts:298-316`) | D1 (wave 0); D2 in-band `next`, E-C "searched N of M sources" (wave 2) | Moving the instruction sentence is tied to conditional D3; unknown-name lookups stay silently empty |
| 3. First write | `memory-writer` grants pin `surface: 'starter'`, `surfaceSetBy: 'operator'` (`grants/profiles.ts:46`), so `put_pages` isn't callable; HTTP filters ops by snapshot (`serve-http-mcp.ts:159-160`) and returns an opaque `unknown_tool` (`dispatch.ts:523-546`) | D4: new grants callable/advertised `full`; host doctor finding for old clients | The agent on a hosted connection still gets "Unknown tool: put_pages" with no fix; the finding lives on a host doctor it never runs |
| 4. First correction or withdrawal | `forget(fact_id)` and `replaces_cross_page` exist (`MEMORY_VERBS_v1.md:287,480`); no Cat 41 scenario covers it (scenario list, `scenarios.ts:228-517`) | D8's funnel counts it on ≥ 3 non-maintainer installs; wave 4 adds `delta {beliefs}` and page-at-time | Unmeasured until wave 2; time parameters collide (DX-7) |
| 5. Return after 7 days | Doctor reports `ok` at ≥ 90% coverage with any backlog (`schema-health.ts:379-381`); the cycle embed phase reports `ok` regardless (`cycle.ts:1633-1654`); grants freeze their op list at mint; upgrade notices via `BEHAVIOR_CHANGES` | E-A, E-B (wave 0); E-C, E-D (wave 2); D4 `BEHAVIOR_CHANGES` row | No "return" scenario; day-7 retention has no counting mechanism under opt-in capture |

## Empathy narrative

I'm an engineer with Codex open and a free afternoon. README tells me memory is "two commands", so I run them and get `--surface verbs`. My agent remembers my tea preference, which feels great. A week later I ask it to prep for a meeting. It answers from an email that quotes a forecast the brain had already superseded, because the takes that hold the update sit behind a tool it can't see. It never asked for more tools, and when another agent did, it sent `tools: []` and got an empty list back. I connect a second laptop to the brain I host, try a bulk import, and get "Unknown tool: put_pages", with nothing telling me my grant was minted before that tool existed. I run `gbrain doctor` on the host and every check says ok. That includes embeddings, which turn out to be 136k chunks behind, so "not in the brain" really meant "not indexed yet". None of these failures is loud, and each one makes me trust the brain a bit less. The plan fixes most of them, but the fixes I'd hit first (the README surface, the discovery sentence, `setup`) wait on a reading-accuracy pilot I'll never see.

## Findings (consensus-ready)

**DX-1 (high). The TTHW baseline is stale and doesn't match the scenario.** Plan text (D8 proof): "Cat 41 `fresh_install_to_wired_recall` extended to "first pushed item": 3/3 on Claude Code and Codex, ≤ 1 user reply, 0 violations; wall time vs 93.4 s / 437.9 s baselines". Evidence: those numbers are from `566a242` (v0.60.35.0); the passed confirmation build `b3f4e8b` measured 96.7 s / 121.7 s (`after-b3f4e8b/gate.json`), and n = 3 per cell. Fix: re-baseline the unextended scenario on v0.60.106.0 (about $3.20 at the measured $1.50 and $1.70 per 3 runs), keep it as the TTHW comparator, add `fresh_install_to_first_push` as a separate cell, and freeze the targets above.

**DX-2 (critical). The E5.1 runbook's verify already passes on master, and its paid step refuses on a thin client.** Plan text: "`gbrain embed --stale --catch-up --max-usd 15`, verify" and proof "`gbrain doctor --only embeddings` green". Evidence: the `embeddings` check returns `status: 'ok'` whenever coverage is ≥ 90%, whatever the backlog (`src/commands/doctor/checks/schema-health.ts:379-381`), so a brain with 136k missing is "green" today. `embed` is `thinClient: 'refuse'` (`src/cli/command-table.ts:261`), and the plan says Garry's OpenClaw runs the thin CLI (D8b; audit D §2.3). Fix: the runbook names the brain host as the actor ("Who acts" column of `docs/guides/troubleshooting.md#symptom-table`). Verify becomes `details.backlog` = 0 (or under E-B's threshold) from `gbrain doctor --only embeddings --json`, and E5.1 can't be checked off before E-B merges. The read-only diagnosis names its commands: `gbrain status --json` and `get_brain_identity` (which returns `chunk_count`, `ops/admin.ts:107-138`), `gbrain sources list`, `gbrain embed --stale --dry-run --json`. Add the exit-4 (cap hit) resume line. Because a numbered runbook with consent and cost doesn't fit in a table cell, it gets its own anchored section that the symptom row links to.

**DX-3 (high). The default surface is unnamed, and README ships the losing arm.** Plan text (D8): "MCP registration with the shipped default surface … one default surface constant across README, INSTALL_FOR_AGENTS and plugin manifests". Evidence: `README.md:176-180`, `docs/mcp/CLAUDE_CODE.md:57`, `GROK.md:21` and `OPENCODE.md:24` use `--surface verbs`; plugins use `starter`; `REGISTRATION_SURFACE = 'starter'` (`mcp-registration.ts:23`); OpenClaw and Hermes use full; `docs/mcp/DEPLOY.md:71` says starter is "~27 ops" when it has 40. Under P8, callable `starter` needs a session widen to reach hidden tools (audit D §2.4 "tension"). Fix: name the constant in the plan (callable `full`, advertised `full` unless challenge 3 narrows it). Move the $0 alignment of README, docs/mcp, manifests and `REGISTRATION_SURFACE` into wave 0 with D4, behind a `BEHAVIOR_CHANGES` row.

**DX-4 (high). The discovery hint is cut off on capped harnesses, and the fix sits inside conditional D3.** Plan text (D3): "with the hidden-tool sentence inside the first 2,048 characters of server instructions" (dropped under option (c)). Evidence: `instructions.ts:53` ("capped harnesses read the first 2,048 characters") and lines 114-115, which append the sentence after the contract. Any starter registration has hidden callable tools whichever way challenge 3 goes. Fix: make it unconditional and ship it in wave 0 next to D1, gated by the preregistered Cat 40 smoke the plan already requires for instruction text.

**DX-5 (high). D1 covers only the empty list.** Plan text: "`request_tools {tools: []}` returns the catalog grouped by capability family with a "did you mean", instead of an empty array". Evidence: `request-tools.ts:307` "invisible names silently omitted"; audit D's D1 also covered "an unknown-name-only list", and a "did you mean" has nothing to match against an empty list. Fix: both cases return the catalog. "Did you mean" draws only from caller-visible ops, the same rule `unknownToolEnvelope` uses, so it isn't an existence oracle. State the smoke arm (advertised starter, callable full) and a bar above "rises from 0/20" (for example ≥ 10/20, with `request_tools` call counts per model reported).

**DX-6 (high). An existing hosted client gets no in-band signal that its grant is stale.** Plan text (D4): "existing clients get a doctor finding (`grant_new_ops_available`) whose fix is `ask_user` + `gbrain auth rescope`". Evidence: HTTP drops ops outside `allowedOperations` (`serve-http-mcp.ts:159-160`), and the `unknown_tool` envelope is opaque on HTTP by design (`dispatch.ts:523-546`; `hidden-tool-hint.ts` F6: "HTTP keeps the opaque unknown_tool envelope"). Fix: add a `whoami` field and a once-per-session notice on the client's own connection ("this grant predates N operations"), with `tell_user_to_run` and the exact host argv. This counts ops rather than naming them, so no existence oracle opens. The argv differs by credential type, and the plan's bare "`gbrain auth rescope`" hides that. For tokens it's `gbrain auth rescope --token <name> --refresh-operations --add put_pages` (preview first). OAuth clients can't use that flag: `--refresh-operations` is "Token only", and a client gets `client_refresh_operations_unsupported` (`auth.ts:1221`, `grants/cli.ts:138`). So a client needs `gbrain auth rescope --client <id> --operations <list>|all --surface full --dry-run`, and then the same command without `--dry-run`, because the operator pin also blocks the surface. Either give clients the same preview-then-add flow in D4's files, or spell out both argvs in the finding's `fix`. Restore audit D's explicit, disclosed `--operations all` choice ("Client only: 'all' = no snapshot … including ones later upgrades add", `auth.ts:1215-1218`).

**DX-7 (high). The time parameters collide.** Plan text (W2): "`get_page {at}` and `get_versions {at, diff}` … `known_as_of` on recall, takes_list, get_links, ontology_get and entity". Evidence: `get_links` already takes `as_of` meaning valid time, "YYYY-MM-DD" (`ops/links.ts:404`, `ops/edge-temporal.ts:17-26`); `open_loops` uses `as_of` as a reference clock (`ops/loops.ts:372`); `recall` and `delta` use `since`. Fix: use one recorded-time name on every op, `known_as_of` on `get_page` and `get_versions` too instead of `at`. Add a glossary table to `MEMORY_VERBS_v1.md` and `TOOL_CATALOG.md`, have the `as_of` and `known_as_of` descriptions name each other, add a coded refusal when a date-only value arrives where an instant is required, and include both in W2's Cat 40 smoke.

**DX-8 (medium). New ops contradict "no new advertised tools".** Plan text (§5): "the only new advertised name is `discover`", while A9 adds "MCP op `evidence_brief`", W9 "a read op", B9 a "readiness op" and W7 `track_record`. Under D4's advertised `full`, every new op is advertised. `gbrain takes scorecard [<holder>]` already exists (`commands/takes.ts:496`). Fix: either make these parameters (`assemble_evidence {mode: 'brief'}`, `takes_scorecard {group_by}`), or amend §5 to list each new op with its surface membership and character cost.

**DX-9 (medium). A paid MCP op has no spend contract.** Plan text (A9): "MCP op `evidence_brief` (paid, read scope …)". Evidence: preapprovals never apply over MCP (`dispatch.ts` render-context comment); the protocol's paid section covers only CLI paths (`AGENT_OPERATOR_v1.md:885-916`); `think` documents its keyless behaviour in its description (`ops/takes.ts:209`). Fix: name the cap (grant `budget_usd_per_day`, which already exists in `grants/model.ts:33`), the refusal code when it's exceeded, the keyless fallback (evidence plus a notice), and `cost_usd` in the result.

**DX-10 (medium). The new refusals and notices aren't in the error contract.** Plan text: W3 "refuses with `coverage_from`"; E-C "a `[gbrain notice]`"; D8b "labelled "push unsupported" in the docs"; E-A and E-B "warn". Evidence: `src/core/error-catalogue.ts` (code plus docs anchor, enforced by `test/error-catalogue.test.ts`); the envelope and `fix.next` table (`AGENT_OPERATOR_v1.md:552-692`). Fix: every new refusal gets a code, why, `fix.next`, a read-only verify and a docs anchor. E-A and E-B reuse `embedBackfillFix` with `paid` consent. On the thin client, D8b's "unsupported" fires as a runtime notice from the hook, not only as a docs label.

**DX-11 (medium). New CLI doesn't reach thin clients.** Plan text (W9): "CLI `gbrain pages refresh list|show --diff|accept|reject|undo`". Evidence: `pages` is `thinClient: 'refuse'` (`command-table.ts:384`); `gbrain beliefs` doesn't declare a mode. Fix: declare a `thinClient` mode for every new command, and route the review flow through an MCP op so thin-CLI owners can review proposals, or document "brain host only".

**DX-12 (medium). `gbrain setup` adds an entry point without escape hatches.** Plan text (D8): "idempotent init, MCP registration …, push hooks without the bootstrap interview". Evidence: the existing entry points (`README.md:183-195`; audit D §2.3). The Step 3.5 stop is mandatory (`INSTALL_FOR_AGENTS.md:210`); hooks are a persistent effect. Fix: `setup` becomes the README's first path, and the others are documented as what it calls. Add `--dry-run`, `--json`, `--surface`, `--no-hooks` and `--remove` flags, honour `GBRAIN_SURFACE`, and put the search-mode choice inside setup's single reply. Unsupported harness ids print the per-harness doc link with a coded refusal.

**DX-13 (medium). The funnel can't be measured as written.** Plan text (D8): "retained use after seven days, with opt-in capture only … counted on at least three non-maintainer installs". Fix: add a local-only `gbrain status --funnel --json` that the user chooses to share, report counts rather than rates, and add Cat 41 `correct_then_recall` and `return_after_gap` scenarios (simulated clock, an upgrade, a stale grant, a backlog notice).

**DX-14 (medium). The DX work is ordered by an unrelated pilot.** Plan text: "their order and start dates are set by the wave 1 pilot's verdict"; the wave 2 goal is "the first ten minutes with gbrain get simpler". The evidence-brief pilot (A5) measures reading accuracy and cost, so it can't rank setup work. Fix: give wave 2's $0 items (DX-3, DX-4, `setup claude-code`) a fixed slot or fold them into wave 0 or 1, and keep only sealed D3 behind the gate.

**DX-15 (medium). Frozen verbs gain parameters without a protocol doc update.** Plan text: W4 "`delta {beliefs: true}`"; D5 "`context_pack` gains `intent` and `counterparty`". Evidence: `MEMORY_VERBS_v1.md:28-31` (field names and semantics are frozen, additions are additive-forever). Fix: add `docs/protocol/MEMORY_VERBS_v1.md` and `test/fixtures/agent-contract/v1/` to both file lists.

**DX-16 (medium). The vendor path forks the existing front door.** Plan text (B8): "`docs/scoreboard.md` "Submit a system" … `eval:scoreboard verify`"; (B5) "namespace or principal per caller in the shim protocol". Evidence: the existing "Add a system" section (`docs/scoreboard.md:102-162` on `evals/q1-scoreboard`); the front door lists `check|fixture|explain|doctor|plan|smoke|run|status|judge|render|dispute` with no `verify`; it says "Every field is required" in the capability record; PROTOCOL.md v1 error kinds are fixed. Fix: extend "Add a system" with step 6 "Submit". Add `verify` and `submit` to the front door with its code and exit-code contract. Make B5's fields optional (`"privacy": "not_applicable"` default) with an optional conformance section, so protocol 1 shims keep passing. Add a target-time and cost row for a vendor submission to the Reproduce table, and say who pays the $20 to $50 and the custodian re-run turnaround (the dispute path already promises 7 days).

**DX-17 (medium). E-B will false-alarm.** Plan text: "warns on an absolute backlog (> 1,000 chunks or > 1%)". A fresh keyed brain mid-way through its first embed trips this. Fix: gate on backlog age or N cycles with no progress, and reuse doctor's existing grace rules for never-cycled sources.

**DX-18 (medium). Result text that steers models isn't smoke-tested.** Plan text: "Every new instruction or discover sentence gets a preregistered Cat 40 smoke". E-C's "searched N of M sources, K chunks unembedded" and D2's `next` are result-envelope text, and they can drive over-abstention. Fix: extend the smoke rule to new result-envelope and notice text.

**DX-19 (medium). D8 proves 2 of its 4 harnesses.** Plan text: "for Claude Code, Codex, OpenClaw and Hermes" with proof "3/3 on Claude Code and Codex". Fix: add a scripted smoke for Hermes (`hermes mcp test`) and OpenClaw (local plugin), separate from D8b's thin-client push.

## DX Implementation Checklist (amendments to the plan text)

- [ ] D8 proof: re-baseline `fresh_install_to_wired_recall` on v0.60.106.0; cite `b3f4e8b` (96.7 s / 121.7 s) next to `566a242`; add a separate `fresh_install_to_first_push` cell; freeze targets (Claude Code ≤ 60 s and Codex ≤ 120 s for wired recall; ≤ 120 s and ≤ 180 s to first push; ≤ 1 reply; 0 violations). (DX-1)
- [ ] E5.1: actor = brain host; named read-only commands; verify on `details.backlog`, not on "green"; depends on E-B; exit-4 resume; its own anchored runbook section linked from the symptom row. (DX-2)
- [ ] Wave 0 adds "S0: one surface constant": callable `full` and advertised `full` (or what challenge 3 picks) in README, `docs/mcp/*`, `INSTALL_FOR_AGENTS.md`, the three manifests and `REGISTRATION_SURFACE`; fix DEPLOY.md's "~27 ops"; `BEHAVIOR_CHANGES` row. (DX-3)
- [ ] Wave 0 D1: also cover unknown-name-only lists; "did you mean" from visible ops only; move the hidden-tool sentence into the first 2,048 characters unconditionally; smoke arm and bar stated. (DX-4, DX-5)
- [ ] D4: `whoami` and session notice for stale grants with `tell_user_to_run`; the doctor finding's `fix` carries both argvs (token: `--refresh-operations --add`; client: `--operations … --surface full --dry-run`, then apply), or D4 adds client preview-then-add; restore the disclosed `--operations all` option. (DX-6)
- [ ] W2: one recorded-time parameter name everywhere (no bare `at`); a glossary in `MEMORY_VERBS_v1.md` and `TOOL_CATALOG.md`; cross-referencing descriptions; a coded refusal for date or instant mismatches; in the Cat 40 smoke. (DX-7)
- [ ] §5: list every new op (A9, W7, W9, B9) with surface and character budget, or convert them to parameters; W7 extends `takes_scorecard` / `gbrain takes scorecard` instead of adding `track_record`. (DX-8)
- [ ] A9: spend cap, refusal code, keyless fallback, `cost_usd` in the result. (DX-9)
- [ ] New refusals (W3, A9, E-C, D8, D8b) and E-A/E-B warnings: an `error-catalogue.ts` entry with a docs anchor and a `fix` per the operator protocol. (DX-10)
- [ ] Every new CLI command declares its `thinClient` mode; W9's review flow is reachable over MCP or labelled host-only. (DX-11)
- [ ] D8: `--dry-run`, `--json`, `--surface`, `--no-hooks`, `--remove`; honours `GBRAIN_SURFACE`; search mode inside its one reply; README's first path; coded refusal for unsupported ids; Hermes and OpenClaw smokes. (DX-12, DX-19)
- [ ] Funnel: local `gbrain status --funnel --json`; counts, not rates; Cat 41 `correct_then_recall` and `return_after_gap`. (DX-13)
- [ ] Schedule wave 2's $0 DX items independently of the A5 verdict. (DX-14)
- [ ] D5 and W4 file lists add `docs/protocol/MEMORY_VERBS_v1.md` and the agent-contract fixtures. (DX-15)
- [ ] B5 and B8: extend "Add a system" with "Submit"; `verify` and `submit` on the front door; optional privacy fields under protocol 1; Reproduce-table row with target time and cost; who pays, and the re-run turnaround. (DX-16)
- [ ] E-B: age or no-progress gating plus the fresh-brain grace period. (DX-17)
- [ ] Extend the preregistered Cat 40 smoke rule to new result-envelope and notice text (E-C, D2). (DX-18)

## What the plan already gets right (keep)

- D4 respects "migrations never widen grants" (`src/core/grants/migration.ts:6`) and routes the widening through `ask_user`, a doctor finding and a `BEHAVIOR_CHANGES` row.
- Every new capability is off or propose-only until a measured gate passes (A8, D5, W9), and W2 keeps `starter` inside its 25,000-character budget through `test/mcp-schema-budget.test.ts`.
- D8b's honest fallback, labelling the thin client "push unsupported", is better than a silent no-op. It just needs to fire at runtime too (DX-10).
- The benchmark side starts from a strong base. `eval:scoreboard` already prints a code, why, next step and verify on every refusal, with exits 0, 2, 3 and 4 and target times. B8 should extend that front door, not fork it.
