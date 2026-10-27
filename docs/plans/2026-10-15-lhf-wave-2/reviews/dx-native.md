INPUT: dx 2ea3b35280d7f37a6d2ac5843bc6089f3c3ac7b02ffd288e073cbb190c36810c

# DX review (native voice), round 2: LHF wave 2 plan, revision 2

Reviewer: anthropic/claude-opus-5-5 (native), gstack plan-devex-review methodology (`gstack: ok 1.91.101.0 for=autoplan` on this machine), unattended, mode **DX POLISH**. Checkout: the shared gbrain checkout at `capy/lhf-wave-2` head `8e615169`, which already merges master `7f3c9f5f` (v0.60.252.0) and adds `9a4e54e8` (troubleshooting advice for item 0). Read-only, no provider spend. DX Trend Check: one prior DX review (round 1 of this run), overall 5/10.

Revision 2 resolves every round-1 High. It does so mostly by moving the agent-visible contract changes (lean-row elision, `context_pack` compaction, keyword-count skip, expansion model) out of scope, with reasons that name exactly what each needs before it returns. Item 1 now keeps its notice unchanged. What remains is a performance wave whose developer surface is upgrade output, doctor, the bench harness and one relational lexicon change. I found no Critical or High problems. The nine findings below are about operators and contributors: a doctor counter that has no path from the server to `gbrain doctor`, audit rows that can be dropped with no opt-out, doctor wording that would contradict itself for item 6's new staleness reason, silent PGLite index builds on upgrade, and a docs plan that is empty apart from one BEHAVIOR_CHANGES row.

## Round-1 findings: status

| Round 1 | Status in revision 2 | Evidence |
|---|---|---|
| F1 `[gbrain dates]` mislabels elided rows | Resolved (descoped) | Item 8 is out of scope; NOT in scope requires per-brain `row_defaults` that "keep the `[gbrain dates]` labels" |
| F2 Item 1 notice loses the type list | Resolved | Item 1 runs the existing `DISTINCT` list only on a miss, so the notice is unchanged; the item G parity fixtures cover missing-type and alias cases |
| F3 `context_pack` breaks frozen v1 with no escape hatch | Resolved (descoped) | NOT in scope requires "an opt-in format or a v2 protocol decision" |
| F4 BEHAVIOR_CHANGES gaps | Resolved for the current scope | Rows for items 0 and 9; items 2 and 5 are listed as operational changes; items 10 and 4 left the wave. Residual: N8 |
| F5 `create_safety` elision | Resolved (descoped) | NOT in scope names "the `create_safety` guard" |
| F6 Elision defaults unnamed | Resolved (descoped) | Same as F1 |
| F7 `gbrain models` truthfulness | Resolved (descoped) | NOT in scope requires "one resolver shared by serving and `gbrain models`, unchanged OCR fallback" |
| F8 Keyword-count skip semantics | Resolved (descoped) | NOT in scope requires "a distinct `skipped` state" |
| F9 Item 6 ANALYZE failure path | Mostly resolved | Best effort, warning, migration never fails; already-present indexes get flagged. Residual: N3, N4 |
| F10 Item 2 silent LIKE fallback | Resolved | Item 2 is now a trigram index on the unchanged expression, so there is no second path |
| F11 Receipts not reproducible | Mostly resolved | Order digest, `--rtt-ms` committed, master baseline committed first. Residual: N5, N9 |
| F12 Docs list incomplete | Partly resolved | The descoped items took most of the doc burden with them. Residual: N5 |
| F13 Contributor PR handling | Resolved | The #6734 comment lists each dropped commit with its reason; #6335 stays open as TODO-D input |
| F14 Naming drift | Resolved | The notice comment now says "item 0" (`behavior-change-notice.ts:648`); the report is `2026-10-16-lhf-wave-2.md` |

## Step 0

### Developer Persona Card

| | |
|---|---|
| **Primary (this revision)** | Self-hosting operator who runs `gbrain upgrade` and `gbrain serve --http`, reads BEHAVIOR_CHANGES and `gbrain doctor`, and uses the admin dashboard or `gbrain auth` usage to manage clients. |
| **Secondary** | Agent-harness integrator whose agent asks attendance questions (item 9) and otherwise should notice nothing but speed. |
| **Tertiary** | The next gbrain contributor, who must find and rerun the contract-parity harness (item G) for their own performance change. |
| **Mental model** | "A performance wave changes nothing I can see except speed. If it changes something operational, doctor tells me what and how to act." |

### Developer Empathy Narrative (operator, after this wave as planned)

"My PGLite brain upgraded and sat silent for a while, building an index and then running ANALYZE, with nothing printed. Search is faster. Doctor says request-log inserts were dropped, but I can't find where that number came from, and nothing lets me keep every audit row; I bill clients from the per-client usage. Another doctor line says a table has '0 rows changed since ANALYZE' and is still stale, which reads like a bug. My agent now answers 'who took part in the planning meeting?' correctly. If it started misrouting 'who joined acme', I wouldn't know the switch to turn it off."

### Competitive DX Benchmark (qualitative; no web research in this unattended pass)

| Dimension | gbrain today | Mature self-hosted databases and servers | Target for this wave |
|---|---|---|---|
| Upgrade progress | Postgres index builds print a "this can take minutes; safe to leave running" line; PGLite prints nothing | Long migration steps print progress | The same line on both engines |
| Operational counters | Doctor checks have code, message, fix and verify; some read cross-process heartbeat rows | Metrics endpoint plus a CLI | Drop counter persisted where doctor can read it, with its knob named |
| Audit completeness | Synchronous request log | Configurable async or sync logging | Async by default, sync available |
| Perf contributor tooling | Bench script, undocumented in TESTING.md | `make bench` plus docs | A documented parity harness with a package script |

Rank: **Competitive**. With N1-N5 resolved it stays Competitive and moves toward Champion on contributor tooling.

### Magical Moment Specification

Typed search on Postgres with JIT on drops by about 500 ms, remote search at 30 ms RTT drops from about 1,550 to about 800 ms, and federated PGLite search drops from about 1.3 s to 0.5 s, all with byte-identical results. An agent's "who took part in X" also starts working. The vehicle is the CHANGELOG plus item 9's BEHAVIOR_CHANGES row. Revision 2's strongest DX choice is the parity requirement: "nothing to relearn" is now something the item G harness proves.

### Developer Journey Map

| Stage | Action | Friction | Finding |
|---|---|---|---|
| Upgrade (PGLite) | `gbrain upgrade` runs item 2's index build and item 6's ANALYZE | No progress line on PGLite; the warning's command isn't named | N4 |
| Upgrade (any) | Read the PR or CHANGELOG operational notes | Fact-insert cost and ANALYZE time aren't listed | N8 |
| Doctor | `gbrain doctor` | Drop counter has no data path; the new staleness reason reads as contradictory | N1, N3 |
| Audit | Admin dashboard, `gbrain auth` usage | Rows can be dropped, with no opt-out and no "approximate" label | N2 |
| Agent attendance question | `query`/`search` | Works; if it misroutes, the off-switch isn't in the notice | N7 |
| Contributor perf PR | Find and run the parity harness | Undocumented, named after refactor wave 1, and a second RTT injector with a different flag | N5, N9 |
| Silent fallback | Item 3's SQL statement fails | Falls back to JS with no signal | N6 |

### First-Time Developer Confusion Report

1. "Doctor says requests were dropped. Dropped where, and from which process?" (N1)
2. "How do I make the request log complete again?" (N2)
3. "Why is a table with 0 changed rows stale?" (N3)
4. "Is the upgrade hung?" (N4, PGLite)
5. "Where is the parity harness documented?" (N5)

## Pass 1: Getting Started: unchanged

Nothing in the install, init or first-run path changes. Item 0's init-picker copy correction (no claim that `tokenmax` builds per-chunk synopses) makes the first-run choice more accurate. **No issues found in scope.**

## Pass 2: API/CLI design: 7/10 → 8/10 with fixes

- Item 1 adds a `jitOff` option to `BrainEngine.executeRaw` (`src/core/engine.ts:2655-2659`). It is additive, sits beside the existing `timeoutMs`/`deadlineAt` options, and is a documented no-op on PGLite. That is consistent. Its doc comment should also say whether it is ignored inside a caller's transaction, the way `timeoutMs` is.
- Item 9's escape hatches already exist: per call `relational: false` (`ops/search.ts:880`) and `search.relational_retrieval` in config (`config.ts:1346`). The plan should name them where users read about the change (N7).
- Item 5's async request log adds an opinionated default with no knob (N2).

## Pass 3: Errors and debugging: 6/10 → 8/10 with fixes

Three paths traced:

1. **Request-log backpressure (item 5).** The plan says the drop counter is "reported by doctor", but `gbrain doctor` is a separate process from `gbrain serve --http`, and an in-memory counter is invisible to it. The repo already has a cross-process channel: consumer heartbeat rows read by `serve_build_drift` (`src/commands/doctor/checks/persistence-consumers.ts:117-135`). The plan has to name where the count lives, the check's name and its fix (N1).
2. **Expression index without statistics (item 6).** Today's `planner_stats_stale` message renders each stale table as "`<table> (<pending> rows changed since ANALYZE, threshold <n>)`". On Postgres it explains this with "Autovacuum has not analyzed them in the last hour" (`src/commands/doctor/checks/planner-stats.ts:55-62`). A table flagged only because a new expression index has no `pg_stats` row would print "0 rows changed" and blame autovacuum, which contradicts itself. It needs its own reason naming the index. On Postgres it also needs to say who runs the ANALYZE, because `planner.auto_analyze` is the PGLite row-delta mechanism (N3).
3. **SQL cosine failure (item 3).** "Falls back to the existing JS path for that search" is right for availability. But if the failure is permanent (a future column or cast change), every search silently loses the gain and nothing points at the cause. Use the `countErrorLogged` pattern (`keyword-paging.ts:115-136`: log once per process with the SQLSTATE and "this is a bug") plus a timings label (N6).

## Pass 4: Documentation: 5/10 → 8/10 with fixes

The plan names no documentation work beyond item 9's BEHAVIOR_CHANGES row. These pages need it:

- `docs/guides/planner-stats.md` for item 6's new reason and its fix.
- The troubleshooting symptom table and doctor docs for the request-log drop check (item 5).
- `docs/guides/attendance-evidence.md` / `docs/architecture/RETRIEVAL.md` for the new phrasings and the meeting/event guard (item 9).
- KEY_FILES entries for new files (`config-snapshot.ts`, the item 2 migration, peeled modules).
- `docs/TESTING.md` for the item G harness, which is not mentioned in TESTING.md, CONTRIBUTING.md or `package.json` today (N5).

## Pass 5: Upgrade and migration: 7/10 → 8/10 with fixes

Upgrade risk is now low because results are parity-gated. Two problems remain:

- `buildIndexOnline`'s PGLite branch (`src/core/schema-migrations/helpers.ts:89-93`) prints nothing. Item 2's trigram GIN over up to 100k facts, then item 6's ANALYZE, run silently on the engine most single-user brains use (N4).
- The PR body's operational changes list index build time and droppable audit rows. It leaves out item 2's fact-insert cost (the gate allows up to +25%) and item 6's ANALYZE time during migrations, and the coordinator contract makes an omission found in review Critical (N8).

## Pass 6: Developer environment and tooling: 7/10 → 8/10 with fixes

Item G is the best DX addition in the plan: committed master baselines, an order-only digest, a full remote-response comparison and a pool-contention mode. Two gaps:

- It lives in `scripts/bench-refactor-wave-1.ts`, a name nobody will search for when they need a "contract parity" check, and it is undocumented (N5).
- `--rtt-ms` brings the scratch TCP delay proxy into the repo as a second latency injector. The toxiproxy harness in `scripts/bench/managed-sync-catchup-lib.ts` and `foreground-put-page.ts --rtt` already exist, under a different flag name (N9).

## Pass 7: Community: 8/10

Credit, `Co-Authored-By`, `Supersedes` lines, the #6734 comment that lists each dropped commit with its reason and where it is filed, and #6335 left open as TODO-D input: this is the project's contributor rule done well. **No issues found.**

## Pass 8: DX measurement: 8/10

Interleaved base and branch runs on the integrated tree, estimates labelled as estimates, and one dated gbrain-evals report. The item 9 gate's statistical design is CEO territory (circular split, no held-out bar) and is not repeated here. **No new DX issues.**

## NOT in scope (DX, deferred)

- A metrics endpoint for serve counters. A heartbeat-row field is enough for one counter.
- Renaming `bench-refactor-wave-1.ts`. A package script plus docs gets discoverability without breaking existing receipts and links.
- Everything revision 2 already moved out of scope, with its stated preconditions (payload, keyword-count skip, expansion model, post-fusion fan-out, year tokens).

## What already exists (reuse)

- Index-build notice and failure text: `buildIndexOnline` (`helpers.ts:106-114`); extend it to the PGLite branch.
- Cross-process serve state: consumer heartbeat rows (`src/core/persistence/consumer-diagnostics.ts`, read by `persistence-consumers.ts`).
- Doctor check contract: name, message, fix, verify (`planner-stats.ts`); repair command `gbrain repair planner-stats --apply`.
- Once-per-process bug log: `countErrorLogged` in `keyword-paging.ts`.
- Relational off-switches: `relational: false`, `search.relational_retrieval`.
- Latency injection: toxiproxy harness in `scripts/bench/`.

## TODOS.md updates (proposed; unattended)

1. **What:** a serve metrics surface (request-log drops, pool incidents) readable by doctor and the admin API. **Why:** counters inside the serve process are invisible to operators. **Depends on:** N1's single-counter fix. Recommendation: A) add.

## DX Scorecard

```
+====================================================================+
|              DX PLAN REVIEW — SCORECARD (round 2)                   |
+====================================================================+
| Dimension            | Score  | Prior  | Trend  |
|----------------------|--------|--------|--------|
| Getting Started      | n/a    | n/a    | unchanged (not touched) |
| API/CLI/SDK          | 7/10   | 5/10   | ↑ (→8 with N2, N7) |
| Error Messages       | 6/10   | 5/10   | ↑ (→8 with N1, N3, N6) |
| Documentation        | 5/10   | 6/10   | ↓ docs plan empty (→8 with N5) |
| Upgrade Path         | 7/10   | 5/10   | ↑ (→8 with N4, N8) |
| Dev Environment      | 7/10   | 5/10   | ↑ (→8 with N5, N9) |
| Community            | 8/10   | 6/10   | ↑ |
| DX Measurement       | 8/10   | 6/10   | ↑ |
+--------------------------------------------------------------------+
| TTHW                 | unchanged (not re-measured)                  |
| Competitive Rank     | Competitive                                  |
| Magical Moment       | designed via parity-proven speedups + item 9 notice |
| Product Type         | MCP server + CLI (agent memory)              |
| Mode                 | POLISH                                       |
| Overall DX           | 7/10   | 5/10   | ↑ (→8 with fixes) |
+====================================================================+
| DX PRINCIPLE COVERAGE                                               |
| Zero Friction      | covered                                        |
| Learn by Doing     | gap (N5: harness and guides)                   |
| Fight Uncertainty  | gap (N1, N3, N4, N6)                           |
| Opinionated + Escape Hatches | gap (N2; N7 discoverability)         |
| Code in Context    | covered                                        |
| Magical Moments    | covered (parity gate)                          |
+====================================================================+
```

Documentation scores below 6, so this is DX debt for operators. It doesn't block adoption, because results don't change.

## DX Implementation Checklist

```
[ ] Request-log drop count persisted where gbrain doctor can read it (heartbeat row); check name, message, fix, docs (N1)
[ ] Request-log completeness knob (sync mode or queue size) named in the doctor message; admin/usage counts labelled approximate when drops > 0 (N2)
[ ] planner_stats_stale gets its own reason for "expression index without statistics", naming the index; Postgres message names who runs ANALYZE (N3)
[ ] buildIndexOnline prints its progress line on PGLite too; ANALYZE warning names `gbrain repair planner-stats --apply` (N4)
[ ] Docs: planner-stats guide, troubleshooting row, attendance guide/RETRIEVAL, KEY_FILES, TESTING.md harness section + package script (N5)
[ ] Item 3 fallback logs once with SQLSTATE and stamps a timings label; parity run forces the fallback (N6)
[ ] Item 9 BEHAVIOR_CHANGES row names `relational: false` and `search.relational_retrieval false` (N7)
[ ] PR body operational changes add fact-insert cost and ANALYZE migration time (N8)
[ ] One RTT injector and one flag name (N9)
```

## Unresolved Decisions

None. Every finding has a fix within the plan's direction.

## Review log row (not written; the parent owns autoplan logging)

`{"skill":"plan-devex-review","status":"issues_open","initial_score":7,"overall_score":8,"product_type":"mcp-server+cli","tthw_current":"unchanged","tthw_target":"unchanged","mode":"POLISH","persona":"self-hosting operator","competitive_tier":"Competitive","unresolved":0,"commit":"8e615169"}`

## Next steps

Run eng review next (required gate). N1 and N2 change item 5's design slightly, and N3 touches the item 6 check that CEO round 2 also flagged for its execution path. Run `/devex-review` after the wave ships to confirm the upgrade output and the doctor lines read as planned.

```gstack-findings
{"id":"N1","severity":"Medium","title":"Item 5's request-log drop counter is 'reported by doctor', but gbrain doctor runs in a different process from gbrain serve --http and can't see an in-memory counter","file":"src/commands/serve-http-mcp.ts","line":276,"fix":"Persist the drop count where doctor can read it, e.g. a field on the serve consumer heartbeat row (src/core/persistence/consumer-diagnostics.ts, already read cross-process by persistence-consumers.ts), with a named check (code, message, fix, verify) registered in doctor-categories and a troubleshooting docs row."}
{"id":"N2","severity":"Medium","title":"Item 5 makes request-log rows droppable with no opt-out, though the admin dashboard, per-client usage and last_used_at read mcp_request_log","file":"src/commands/serve-http-admin-api.ts","line":260,"fix":"Keep async logging as the default, but add one knob (a sync mode or the queue size) and name it in the doctor drop message; label admin and `gbrain auth` usage counts as approximate whenever the drop count is above zero."}
{"id":"N3","severity":"Medium","title":"Item 6's new staleness reason would print through the existing message as '<table> (0 rows changed since ANALYZE, threshold N)' and blame autovacuum on Postgres, which contradicts itself","file":"src/commands/doctor/checks/planner-stats.ts","line":55,"fix":"Give 'expression index without statistics' its own reason and wording that names the index and the fix (`gbrain repair planner-stats --apply`). On Postgres, state who runs the ANALYZE, since planner.auto_analyze is the PGLite row-delta path; add a doctor golden for the new reason on both engines."}
{"id":"N4","severity":"Medium","title":"PGLite upgrades build item 2's trigram GIN and run item 6's ANALYZE with no progress line, because buildIndexOnline's PGLite branch prints nothing","file":"src/core/schema-migrations/helpers.ts","line":89,"fix":"Print the existing 'building <index> on ~N rows; this can take minutes; it is safe to leave running' notice on the PGLite branch too, add 'then analyzing <table>', and make the best-effort ANALYZE warning name `gbrain repair planner-stats --apply`."}
{"id":"N5","severity":"Medium","title":"The plan has no documentation work beyond item 9's notice row, and the item G parity harness it relies on is undocumented and named after refactor wave 1","file":"docs/TESTING.md","fix":"Add a TESTING.md section and a package.json script (e.g. bench:parity) for the harness with copy-paste invocations for PGLite, Postgres, --rtt-ms and pool contention; update docs/guides/planner-stats.md (item 6), the troubleshooting symptom table (item 5 drops), docs/guides/attendance-evidence.md and RETRIEVAL.md (item 9 phrasings and the meeting/event guard), and KEY_FILES for new files."}
{"id":"N6","severity":"Low","title":"Item 3's fallback to the JS cosine path on SQL failure is silent, so a permanently failing statement removes the gain with no signal","file":"src/core/search/hybrid.ts","fix":"Log once per process with the SQLSTATE (the countErrorLogged pattern in keyword-paging.ts), stamp a label in _meta.retrieval.timings when the fallback ran, and have the parity harness force the fallback path once to prove identical output."}
{"id":"N7","severity":"Low","title":"Item 9's BEHAVIOR_CHANGES row doesn't name the way back if a new phrasing misroutes, though both switches already exist","file":"src/core/behavior-change-notice.ts","fix":"Name `relational: false` (per call) and `gbrain config set search.relational_retrieval false` in the row, and state that broad verbs ('joined', 'was at', 'went to') route only when the anchor is a meeting or event."}
{"id":"N8","severity":"Low","title":"The PR body's operational changes leave out item 2's fact-insert cost (gate allows up to +25%) and item 6's ANALYZE time during migrations, and the contract makes an omission Critical at review","fix":"List both in the PR body's operational changes, with the measured insert p50/p95 delta from item 2's gate and the ANALYZE time from the upgraded-fixture run."}
{"id":"N9","severity":"Low","title":"`--rtt-ms` adds a second latency injector and flag name next to the existing toxiproxy harness and `--rtt` in scripts/bench","file":"scripts/bench/foreground-put-page.ts","line":5,"fix":"Drive --rtt from the existing toxiproxy harness (scripts/bench/managed-sync-catchup-lib.ts), or, if the TCP proxy is kept for PGLite-free runs, use the same flag name `--rtt` and document why both exist."}
```
