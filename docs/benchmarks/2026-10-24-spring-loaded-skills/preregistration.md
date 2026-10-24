# Preregistration: spring-loaded skills A/B (GBRA-194)

Written 2026-10-24, after the validity pilot and the wiring smokes and before any counted cell ran. Amended the same day, still before any counted cell (see [Amendment 1](#amendment-1-final-pin-and-real-permission-modes)); the amendment wins wherever it differs from the text below it. Nothing changes after counted cells start, and a counted cell is never rerun to change a verdict.

## Amendment 1: final pin and real permission modes

Written after a review requirement and a new pin, before any counted cell. The 8 standing-token probe rows that ran on `2b92f8cd` before the pin moved are kept in [results/superseded-2b92f8cd/](results/superseded-2b92f8cd/) and are not counted.

**Pin.** gbrain `capy/gbra194-spring-skills` at `12669180`. The launcher (an absolute path) answers `bundled-skill --json`, and setup checks that it serves the same skill catalog before writing the index.

**What each arm ships with, on top of the earlier table.** spring: on Claude Code, setup also adds `Bash(<launcher> bundled-skill:*)` to `~/.claude/settings.json`, so a load is not denied. native: no allow rule, because none exists today. off: nothing. In every arm the `gbrain bundled-skill` command exists in the binary, but only spring's instructions mention it; any use outside spring is counted as unprompted.

**Permission configurations.**

| Configuration | Claude Code | Codex | Role |
|---|---|---|---|
| real | Default permission mode as setup leaves it (no `--dangerously-skip-permissions`) | Default sandbox and approval policy (no bypass flag) | Primary, all arms, all tasks |
| mcp-allow | real, plus the bootstrap lane's pre-approval: `permissions.allow: ["mcp__gbrain"]` in `~/.claude/settings.json` | not run: no gbrain lane ships a Codex pre-approval | Secondary, Claude Code only, all arms, all 15 tasks |

The secondary runs all 15 tasks, not only the write tasks, because in real mode Claude Code also denies gbrain's read tools (see below). No other allow rule is added in any configuration. Every trial records `permission_denials` (Claude Code: the result event's list; Codex: calls refused by the sandbox or the approval policy), the denied calls and denied skill loads.

**What the real-mode pilot and smokes showed** (receipts: [results/pilot/pilot-off-real-12669180.jsonl](results/pilot/pilot-off-real-12669180.jsonl), [results/smoke/](results/smoke/)):

- Claude Code, real: every gbrain MCP call was denied in every arm, reads included (`search`, `list_pages`, `entity`, `whoami`), as were Write, Edit and writing Bash commands. 13 of 15 off-arm pilot trials hit a denial, and the brain-lookup control C02 failed in all three arms (`claude|claude-sonnet-5-5|off|C02|1`, `…|native|C02|1`, `…|spring|C02|1`). spring's allow rule worked: `bundled-skill` loads ran without a denial (`…|spring|S05|1`, `…|spring|S11|1`).
- Codex, real: `codex exec` defaults to a read-only sandbox and the approval policy `never`. gbrain MCP reads work. Every gbrain MCP write was refused with "MCP tool call requires approval, but approval policy is never" (`codex|gpt-6.1-sol|off|S11|1`, `…|native|S11|1`, `…|spring|S11|1`, `…|spring|S05|1`), workspace writes fail, and the gbrain CLI's brain commands fail in the sandbox (EROFS on the writer lock). `bundled-skill` is engine-free and works there.
- Claude Code, mcp-allow: MCP reads and writes work. Write, Edit and writing Bash stay denied, which leaves the calendar control C03 unpassable in every arm.
- The off arm still passes 0 of 12 skill tasks in real mode, and 1 of 3 controls (C01, the workspace-only one).

So in real mode the tasks that need a brain write (S02, S04, S05, S06, S07, S08, S10, S11) cannot pass on either harness in any arm, and on Claude Code neither can the brain reads (S03, S09, S12, C02). That floor is a finding, reported with trial ids. right_skill_used still measures what spring is for in that configuration, and pass is reported with the floor called out.

**Models and reps, revised for budget.** real: claude-sonnet-5-5 2 reps, gpt-6.1-sol 2 reps, claude-opus-5-5 1 rep. mcp-allow: claude-sonnet-5-5 2 reps, claude-opus-5-5 1 rep. Opus gets no second rep in either configuration. Estimated counted spend about $38 against $49 left under the cap.

**Standing tokens** are measured once, in the real configuration (2 reps per arm per model). An allow rule adds a few bytes of settings, not instruction text.

**Decision rule.** Unchanged, evaluated per harness for each configuration, pooled over that harness's models. Where an arm's pass count sits at a floor of 0 in every arm, the pass condition holds trivially, and the report says it carries no information there.

---

## Question

Does the spring-loaded skill resolver (`gbrain setup <harness> --skill-loading spring`: a compact index of gbrain's bundled skills in the harness instruction file, each loaded on demand with `<gbrain> bundled-skill <name>`) get agents to load and follow the right gbrain skill, compared with today's default (no skill text reaches the agent) and with today's skill-carrying lanes (all skills installed in the harness's native skills directory), and what does it add to every turn's input?

## Build under test

gbrain branch `capy/gbra194-spring-skills` at `2b92f8cd`, run from source through a launcher script (`bun <checkout>/src/cli.ts`). The launcher unsets provider keys, so gbrain runs keyless (the documented default install) and every paid call in a trial is the harness's own, counted from the CLI's usage output.

## Harnesses, models, reps

| Harness | CLI | Model | Reps per task per arm |
|---|---|---|---|
| Claude Code | 2.1.310, `claude -p --output-format stream-json` | claude-sonnet-5-5 | 2 |
| Codex | 0.164.0, `codex exec --json` | gpt-6.1-sol | 2 |
| Claude Code | 2.1.310 | claude-opus-5-5 | 1, plus a second rep only if the ledger after rep 1 projects the whole run under the cap |

These are the newest model of each family the CLIs accept today, per the project eval rules: no Fable in counted cells, no gpt-5.4-mini, no older generations. The Opus second-rep decision depends on spend only, never on results, and is recorded in the report. OpenClaw is not run.

## Arms

The brain-first block is on in every gbrain arm, and every arm uses `--surface starter --no-hooks`.

| Arm | Setup | What reaches the agent |
|---|---|---|
| off | `gbrain setup <harness> --surface starter --no-hooks` | Brain-first block, gbrain MCP tools. No skill text. |
| native | off, then all 71 bundled skills and the 18 shared files they name copied into `~/.claude/skills/` (Claude Code) or `~/.agents/skills/` (Codex), at their relative paths | The harness's own skill listing |
| spring | `gbrain setup <harness> --surface starter --no-hooks --skill-loading spring --gbrain-bin <launcher>` | Brain-first block plus the `gbrain:skills` index block |
| bare | Base instruction file only, no gbrain | Standing-token baseline only |

The native files are materialized with `<launcher> bundled-skill <name> --json` and `--asset <path> --json` (export-bundled.ts), so native and spring carry byte-identical skill text (89 files, catalog `0d99fb4951e8`). The smokes confirmed the wiring: Claude Code's init event lists 87 skills in the native arm (71 gbrain plus 16 built-in) against 16 elsewhere; Codex read `~/.agents/skills/<name>/SKILL.md` in native trials; the spring instruction file carries the index block and agents on both harnesses ran `bundled-skill <name>` successfully from their shell.

Held constant in every arm: the base instruction file (base-instructions.md); a synthetic two-source PGLite brain (GBRA-188's corpus plus the fixtures in gen-fixtures.ts, each source committed with git, keyword-only); `sources.default = team`, because a local stdio MCP connection writes only to its resolved source and the tasks edit team pages (without it every team-page write was refused with `permission_denied`, see pilot 1); and the `first_run_decisions` notice muted, because every trial is a first session and the ask would otherwise repeat in each one.

## Tasks

[tasks.json](tasks.json): 12 skill-requiring tasks, each needing one skill's procedure, and 3 controls that need no skill. Graders ([grade.ts](grade.ts)) are deterministic and read the final answer, the brain's pages (read straight from PGLite before and after the trial) and the workspace files.

| Task | Expected skill | What passes |
|---|---|---|
| S01 | data-loss-gate | Archive files untouched; the answer states recoverability, offers an alternative to deletion, and requires an explicit "yes" |
| S02 | correction-pipeline | No page still holds the wrong number (3 pages carried it), and the corrected line carries a `[Source: user ...]` citation |
| S03 | fact-check | At least two labels of the skill's 6-level scale (VERIFIED, LIKELY ACCURATE, UNVERIFIED, DISPUTED, LIKELY INACCURATE, FALSE), and the real founder named from the brain |
| S04 | meeting-ingestion | A new meeting page with a plain `Attendees:` line linking the people pages, and all four sections: Summary, Key Decisions, Action Items, Notable Quotes |
| S05 | daily-task-manager | `ops/tasks` holds the task with a `<!-- id: t-YYYYMMDD-NN -->` id under the P3 heading (no priority given) |
| S06 | brain-link-discipline | Frank's page gets a relative markdown link to the globex page, and the answer gives the repo-relative path `people/frank-example.md` with no machine path (the brain repo has no hosted remote) |
| S07 | reports | A new page at `reports/<category>/<YYYY-MM-DD-HHMM>` |
| S08 | idea-ingest | A new page filed in a subject directory (not sources/, inbox/, notes/, media/ or articles/), with an `**Author:**` line, and the author's existing people page links back to it |
| S09 | ask-user | 2 to 4 options with Skip or Cancel as the last one, and nothing changed |
| S10 | repo-architecture (brain-taxonomist also counts) | The framework is filed under `concepts/` or `wiki/concepts/` |
| S11 | enrich | `people/yuki-example` with a State section, an inline `[Source: ...]` citation and a Timeline |
| S12 | citation-fixer | The answer carries at least 3 of the skill's report fields (Pages scanned, Citations found, Issues fixed, Tweet links resolved, Remaining gaps), and no decisions page lost content |
| C01 | none | The PO number from the latest invoice mail |
| C02 | none | fund-b and $4.2M from the brain |
| C03 | none | A Gym event at the right time |

### Validity pilot (off arm, claude-sonnet-5-5, one rep)

| Pilot | Build | Result |
|---|---|---|
| 1 | 4f52139b | 0/12 skill tasks, 3/3 controls. S02, S06 and part of S04/S08 could not write team pages (`permission_denied`), so those tasks were untestable; fixed with `sources.default = team`. Superseded. |
| 2 | 4f52139b | 0/12 skill tasks, 3/3 controls, every write task writing to team |
| 3 | 2b92f8cd (the pin) | 0/12 skill tasks, 3/3 controls |

No task passed without its skill, so none was dropped or rewritten. Each failure was the skill's rule, not an infrastructure error: for example the task went to `notes/todo.md` instead of `ops/tasks` (S05), the report was saved to `notes/` (S07), the article was filed under `articles/` with no author credit (S08), the correction carried no citation (S02), the meeting page had two of the four sections (S04).

One grader changed after the smokes, before any counted cell: S01 first required three of the confirmation card's literal field labels. In the Codex smokes the agent loaded data-loss-gate and followed it (recoverability, an alternative, an explicit "yes") in its own words, so the grader now checks that substance instead of the template's labels. Under the new grader, all three off-arm pilot rows still fail S01. Receipts: [results/pilot/](results/pilot/) and [results/smoke/](results/smoke/).

## Metrics

- **right_skill_used** (skill tasks): the expected skill (or an accepted alternative) was loaded before the first mutating call (any brain write, file write or edit, destructive or writing shell command); with no mutation, at any point. Loads counted: `bundled-skill <name>` in a shell without `--asset` (spring), the Claude Code Skill tool, a Read or shell read of `<name>/SKILL.md` (native, or a gbrain checkout), and a plain MCP `get_skill {name}` that returned without an error. Also reported: expected skill loaded at any point, and trials that loaded only a wrong skill.
- **pass**: the grader above.
- **over_fetch** (controls): any skill loaded.
- **Tokens and cost per trial**: input including cache read and cache write, and output, from the CLI's own usage (Claude Code `total_cost_usd`; Codex usage priced at gpt-6.1-sol's list rates, as in GBRA-188).
- **Standing input tokens per turn**: one "Reply with the single word OK" trial per arm (bare, off, native, spring) per harness and model, two reps; input tokens of the main model's turn (input plus cache read plus cache write). Reported as the delta against bare and against off.

## Decision rule

Per harness, pooled over that harness's models, over the 12 skill-requiring tasks: propose making spring the default when

1. spring ≥ off and spring ≥ native − 1 trial on right_skill_used, and
2. spring ≥ off and spring ≥ native − 1 trial on pass, and
3. spring's standing input tokens are below native's for every model on that harness.

The report gives spring's added standing tokens over off either way. Ceilings: a model at 100% (or 0%) in every arm on a metric cannot show a difference, and the report says so where it happens.

## Budget

Hard cap $55 of API spend across pilot, smokes, probes and counted cells, tracked per trial in a ledger. The runner stops before a trial that could take the ledger past the cap ($0.60 reserve per in-flight trial). Spent before counted cells: $5.91 (pilots, smokes and the superseded probes).
