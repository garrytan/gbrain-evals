# Spring-loaded skills: does an on-demand skill index get agents to load and follow the right gbrain skill?

Written 2026-10-24 for GBRA-194. `gbrain setup <harness> --skill-loading spring` writes a short index of gbrain's 71 bundled skills into the harness's instruction file, and the agent loads a skill's full text only when it needs it, with `<gbrain> bundled-skill <name>`. This report compares that index (spring) with today's default, where no skill text reaches the agent (off), and with today's skill-carrying lane, where every skill sits in the harness's native skills directory (native). The build under test is the gbrain branch `capy/gbra194-spring-skills` at `12669180`. It is not on master. The plan, written before any counted cell, is in [the preregistration](2026-10-24-spring-loaded-skills/preregistration.md); Amendment 1 there wins where it differs from the text below it.

**Finding: the preregistered rule proposes spring as the default on both harnesses.** On the 12 tasks that each need one skill's procedure, spring loaded the right skill before acting in 29 of 36 Claude Code trials, against 15 for native and 0 for off. On Codex it tied native at 22 of 24. Spring passed at least as many tasks as native everywhere: 6 against 4 on Claude Code, 2 against 0 on Codex, and 21 against 12 in the secondary Claude Code configuration where gbrain's MCP tools are pre-approved. Spring adds about 2,057 input tokens to every Claude Code turn over off and 1,429 to every Codex turn. Native adds 8,579 and 6,420. Spring cost less per trial than native in every cell but one, where they tie.

**Most tasks could not pass in the harnesses' real permission modes, in any arm.** Run headless as setup leaves it, Claude Code denied gbrain MCP calls, reads included, in 108 of 135 trials; Codex's default read-only sandbox refused every brain write. So pass is near the floor in the primary configuration: 6 of 36 at best on Claude Code and 2 of 24 on Codex. right_skill_used, which is what spring is for, is not affected by that floor. The pass comparison that shows whether a loaded skill changes the outcome comes from the labeled secondary configuration. See [The permission floor](#the-permission-floor).

## The concrete case

A user asks their agent: "Add 'renew the fabrikam-example contract' to my tasks." gbrain's `daily-task-manager` skill says tasks live on the `ops/tasks` page, each under a priority heading (P3 when the user gives none) with an `<!-- id: t-YYYYMMDD-NN -->` marker. An agent that never reads the skill writes the task to `notes/todo.md` or a new page of its own design. The task "works", but gbrain's task tooling can't find it. All names here are invented placeholders.

With no skill text (off), Sonnet put the task in the wrong place in every trial. With every skill installed natively, Claude Code lists all 71 skill descriptions on every turn, and Sonnet loaded `daily-task-manager` in 1 of 4 trials across both configurations. With the spring index, Sonnet ran `gbrain bundled-skill daily-task-manager` in 4 of 4 and, where it was allowed to write to the brain, filed the task correctly both times (`claude|claude-sonnet-5-5|spring+mcp-allow|S05|1` and `|2`).

## The experiment

**Harnesses.** The real Claude Code CLI (2.1.310, `claude -p --output-format stream-json`) and the real Codex CLI (0.164.0, `codex exec --json`). Each trial has its own `HOME`, a synthetic two-source PGLite brain built from GBRA-188's corpus plus [this run's fixtures](2026-10-24-spring-loaded-skills/gen-fixtures.ts), and gbrain wired by the real `gbrain setup <harness> --surface starter --no-hooks`. gbrain runs keyless from source through a launcher script that unsets provider keys, so every paid call is the harness's own.

**Arms.** The brain-first block from GBRA-188 is on in every arm.

| Arm | What reaches the agent |
|---|---|
| off | Brain-first block and gbrain's MCP tools. No skill text. |
| native | off, plus all 71 bundled skills and the 18 shared files they name, copied into `~/.claude/skills/` or `~/.agents/skills/`. The harness lists them itself. |
| spring | `--skill-loading spring --gbrain-bin <launcher>`: the brain-first block plus the `gbrain:skills` index. On Claude Code, setup also adds `Bash(<launcher> bundled-skill:*)` to `~/.claude/settings.json` so a load is never denied. |
| bare | No gbrain. Standing-token baseline only. |

Native files are written by `<launcher> bundled-skill <name> --json` and `--asset`, so native and spring carry byte-identical skill text. The `bundled-skill` command exists in every arm's binary, but only spring's instructions mention it. No off or native trial ran it.

**Permission configurations.** The primary configuration is real: Claude Code in its default permission mode as setup leaves it (no `--dangerously-skip-permissions`), and Codex in its default sandbox and approval policy. Every trial records the calls the harness denied. The secondary configuration, mcp-allow, adds the bootstrap lane's `permissions.allow: ["mcp__gbrain"]` on Claude Code only, for all arms and all 15 tasks. Codex has no secondary because no gbrain lane ships a Codex pre-approval.

**Tasks.** [tasks.json](2026-10-24-spring-loaded-skills/tasks.json) holds 12 skill tasks (S01 to S12), each needing one skill's procedure, and 3 controls (C01 to C03) that need none. [grade.ts](2026-10-24-spring-loaded-skills/grade.ts) is deterministic: it reads the final answer, the brain's pages straight from PGLite before and after the trial, and the workspace files. The preregistration's task table lists each pass condition. In the validity pilot the off arm passed 0 of 12 skill tasks and 3 of 3 controls, so every skill task needs its skill.

**Models and sample size.** claude-sonnet-5-5 and claude-opus-5-5 on Claude Code, gpt-6.1-sol on Codex: the newest model of each family the CLIs accept. Sonnet and gpt-6.1-sol ran 2 reps per task per arm. Opus ran 1, for budget, as preregistered. That makes 135 trials on Claude Code real, 135 on Claude Code mcp-allow and 90 on Codex, 360 counted in total. Every row is on `12669180`. No trial timed out or failed in the harness.

**Metrics.** right_skill_used: the expected skill was loaded before the first mutating call (any brain write, file write, or writing shell command), or at any point when the trial made no mutation. A load is a `bundled-skill <name>` shell call (spring), the Claude Code Skill tool or a read of `<name>/SKILL.md` (native), or an MCP `get_skill {name}` that returned. Over-fetch: a control trial that loaded any skill. Standing tokens: input tokens of the main model's turn for "Reply with the single word OK", 2 reps per arm per model.

## Results

Models are listed in the order people use them most. Skill columns cover the 12 skill tasks; control columns cover the 3 controls.

| Harness and model | Arm | Right skill used | Pass | Control over-fetch | Control pass | Trials with a denial | Input tokens per trial | Spend per trial |
|---|---|---|---|---|---|---|---|---|
| Claude Code, claude-sonnet-5-5 | off | 0/24 (0%) | 0/24 | 0/6 | 2/6 | 28/30 | 76,497 | $0.0341 |
|  | native | 10/24 (42%) | 3/24 | 0/6 | 2/6 | 28/30 | 115,697 | $0.0560 |
|  | spring | 17/24 (71%) | 4/24 | 0/6 | 2/6 | 26/30 | 102,754 | $0.0484 |
| Codex, gpt-6.1-sol | off | 0/24 (0%) | 0/24 | 0/6 | 4/6 | 14/30 | 147,323 | $0.0877 |
|  | native | 22/24 (92%) | 0/24 | 6/6 | 4/6 | 16/30 | 230,909 | $0.1346 |
|  | spring | 22/24 (92%) | 2/24 | 6/6 | 3/6 | 15/30 | 186,810 | $0.1150 |
| Claude Code, claude-opus-5-5 | off | 0/12 (0%) | 0/12 | 0/3 | 1/3 | 14/15 | 103,880 | $0.0887 |
|  | native | 5/12 (42%) | 1/12 | 0/3 | 1/3 | 14/15 | 171,980 | $0.1521 |
|  | spring | 12/12 (100%) | 2/12 | 0/3 | 1/3 | 15/15 | 138,693 | $0.1415 |
| Claude Code, claude-sonnet-5-5, mcp-allow (secondary) | off | 0/24 (0%) | 0/24 | 0/6 | 4/6 | 6/30 | 85,286 | $0.0484 |
|  | native | 9/24 (38%) | 6/24 (25%) | 0/6 | 4/6 | 6/30 | 143,092 | $0.0801 |
|  | spring | 15/24 (63%) | 13/24 (54%) | 0/6 | 4/6 | 4/30 | 120,231 | $0.0691 |
| Claude Code, claude-opus-5-5, mcp-allow (secondary) | off | 0/12 (0%) | 0/12 | 0/3 | 2/3 | 3/15 | 135,961 | $0.1470 |
|  | native | 4/12 (33%) | 6/12 (50%) | 0/3 | 2/3 | 6/15 | 209,795 | $0.2121 |
|  | spring | 11/12 (92%) | 8/12 (67%) | 0/3 | 2/3 | 6/15 | 190,388 | $0.2128 |

Per-task tables, the expected-skill-at-any-point column and the wrong-skill-only column are in [summary.md](2026-10-24-spring-loaded-skills/summary.md); [summary.json](2026-10-24-spring-loaded-skills/summary.json) holds the same numbers.

### Standing input tokens per turn

| Harness and model | bare | off | native | spring | off vs bare | native vs off | spring vs off |
|---|---|---|---|---|---|---|---|
| Claude Code, claude-sonnet-5-5 | 16,638 | 18,817 | 27,396 | 20,874 | +2,179 | +8,579 | +2,057 |
| Codex, gpt-6.1-sol | 13,375 | 13,605 | 20,025 | 15,034 | +230 | +6,420 | +1,429 |
| Claude Code, claude-opus-5-5 | 16,632 | 18,811 | 27,390 | 20,868 | +2,179 | +8,579 | +2,057 |

Spring's index costs about a quarter of what native's skill listing costs on each turn: 24% on Claude Code and 22% on Codex.

### Decision rule

Pooled over each harness's models, over the 12 skill tasks. Spring needs ≥ off and ≥ native − 1 trial on both right_skill_used and pass, and standing tokens below native's for every model.

| Harness, configuration | Right skill used (off / native / spring) | Pass (off / native / spring) | Spring tokens below native | Propose spring as default |
|---|---|---|---|---|
| Claude Code, real | 0 / 15 / 29 of 36 | 0 / 4 / 6 of 36 | yes | **yes** |
| Codex, real | 0 / 22 / 22 of 24 | 0 / 0 / 2 of 24 | yes | **yes** |
| Claude Code, mcp-allow (secondary) | 0 / 13 / 26 of 36 | 0 / 12 / 21 of 36 | yes | **yes** |

No configuration has pass at 0 in every arm, so Amendment 1's floor clause never applies. But the real-mode pass counts are small. On Claude Code real, only S01, S09 and S12 passed in any arm, because those three can pass from workspace reads and the answer text alone. On Codex real, spring's 2 passes (`codex|gpt-6.1-sol|spring|S01|2`, `codex|gpt-6.1-sol|spring|S12|1`) against native's 0 are within noise. The pass evidence that a loaded skill changes outcomes is the secondary configuration: there, Claude Code trials that loaded the right skill passed 27 of 39 times (spring 19 of 26, native 8 of 13), and trials that didn't passed 6 of 69.

## The permission floor

This is a finding about today's default installs, separate from the spring question.

- **Claude Code, real.** Headless `claude -p` in default mode never prompts, so every tool outside its built-in allowlist is denied. That included gbrain's MCP tools, reads such as `search`, `get_page`, `list_pages` and `entity` as much as writes. 104 of 135 trials had a gbrain read denied and 108 had some gbrain call denied. The brain-lookup control C02 failed in all 9 trials across all three arms (for example `claude|claude-sonnet-5-5|off|C02|1`, `claude|claude-sonnet-5-5|native|C02|1`, `claude|claude-opus-5-5|spring|C02|1`). Write, Edit and writing Bash calls were denied too. spring's own allow rule worked: no skill load was denied in any arm.
- **Codex, real.** `codex exec` defaults to a read-only sandbox with the approval policy `never`. gbrain MCP reads worked, and every brain write was refused with "MCP tool call requires approval, but approval policy is never": 45 of 90 trials had a gbrain call refused, all but one of them writes (for example `codex|gpt-6.1-sol|off|S02|1`, `codex|gpt-6.1-sol|native|S08|2`, `codex|gpt-6.1-sol|spring|S04|2`). Workspace writes failed as well, so C03 (add a calendar event) failed in all 6 Codex trials (`codex|gpt-6.1-sol|off|C03|1`).
- **Claude Code, mcp-allow.** The bootstrap lane's pre-approval fixes the brain, but Write, Edit and writing Bash stay denied, so C03 still failed in all 9 trials (`claude|claude-sonnet-5-5|off+mcp-allow|C03|1`).

The consequence for users: a headless Claude Code run installed with `gbrain setup claude-code` can't read the brain until the user approves gbrain's tools, and a default `codex exec` run can read but never write. The receipts for the same finding on the pilot and smokes are in [results/pilot/pilot-off-real-12669180.jsonl](2026-10-24-spring-loaded-skills/results/pilot/pilot-off-real-12669180.jsonl) and [results/smoke/](2026-10-24-spring-loaded-skills/results/smoke/).

## Where skill use went wrong

**Claude Code mostly ignores native skills.** With 87 skills listed on every turn (71 from gbrain, 16 built in), Sonnet invoked the right one in 19 of 48 trials and Opus in 9 of 24, across both configurations. The same models with the spring index loaded it in 32 of 48 and 23 of 24. Native's misses were not wrong picks: no Claude Code trial in any arm loaded only a wrong skill. The agent loaded nothing and improvised.

**Sonnet skipped the index on a few task types.** Spring's Claude Code misses were all Sonnet, all but one with no skill loaded: S03 fact-check (0 of 4), S11 enrich (1 of 4), S01 data-loss-gate (1 of 4), S09 ask-user (1 of 4) and S06 brain-link-discipline (1 of 4; one more trial loaded it only after its first write). Opus loaded the right skill in 23 of 24 spring trials; its one miss, `claude|claude-opus-5-5|spring+mcp-allow|S11|1`, still passed.

**Codex loads skills eagerly, in both skill arms.** Codex loaded the right skill in 22 of 24 trials in native and in spring. It also loaded `brain-ops`, whose description covers "any brain read/write", in nearly every trial, controls included, which is why its control over-fetch is 6 of 6 in both arms. It cost tokens, not answers: the controls passed at the same rate as off, except one spring C02 trial. Codex picked a wrong skill in 2 trials per arm: native loaded only `brain-ops` for S09 ask-user (`codex|gpt-6.1-sol|native|S09|1` and `|2`), and spring loaded `ingest` instead of `idea-ingest` for S08 (`codex|gpt-6.1-sol|spring|S08|1` and `|2`).

**Extra skills.** On Claude Code, `brain-taxonomist` came along on S10 (it is an accepted alternative there) and once with `brain-ingest-gate`. On Codex, native pulled more extras than spring: `brain-ingest-gate` 10 times, `brain-taxonomist` 12 and `brain-link-discipline` 9, against at most 2 each for a handful of skills in spring. Two loads came after the first mutation, one in each Claude Code skill arm, both on S06 (`claude|claude-opus-5-5|native+mcp-allow|S06|1`, `claude|claude-sonnet-5-5|spring+mcp-allow|S06|2`).

**Two tasks never passed, for reasons in the task, not the arm.**

- S03 fact-check needs two labels from the skill's 6-level scale. Agents that loaded the skill still wrote their own verdicts ("❌ False", "correct") in every trial (`claude|claude-opus-5-5|spring+mcp-allow|S03|1`, `codex|gpt-6.1-sol|spring|S03|1`). Loading the skill didn't make them use its template.
- S10 asks the agent to file a framework note; the grader wants it under `concepts/`. Spring trials identified `concepts/` correctly but stopped to ask, because the starter schema pack has no `concept` page type and brain-taxonomist says to ask rather than force a page into the nearest type (`claude|claude-sonnet-5-5|spring+mcp-allow|S10|1`, `claude|claude-opus-5-5|spring+mcp-allow|S10|1`). Native and off trials filed it under `decisions/` or `notes/`, or asked. The skill and the default schema disagree; that is worth a gbrain issue, separate from this decision.

## Limits

- **Small samples.** 2 reps for Sonnet and gpt-6.1-sol, 1 for Opus. A difference of one or two trials on a task means little; the pooled right_skill_used gaps on Claude Code (29 against 15, and 26 against 13) are the robust result.
- **Ceilings.** Codex sits at 92% right_skill_used in both native and spring, so this run can't separate them there. Off sits at 0% on every skill-task metric everywhere, by design. Pass in the real configuration sits near 0 for every arm on both harnesses, because of the permission floor.
- **No Codex secondary.** Whether a loaded skill changes Codex's outcomes when it can write is not measured here.
- **The S01 grader changed before counting**, from literal confirmation-card labels to recoverability, an alternative and an explicit "yes". All off-arm pilot rows still fail under the new grader.
- **Hooks off.** Every arm runs `--no-hooks`, so this measures the instruction files and skill listings alone.
- **Superseded rows.** 8 standing-token probe rows ran on `2b92f8cd` before the pin moved; they are in `results/superseded-2b92f8cd/` and not counted. Pilot and smoke rows on `4f52139b` and `2b92f8cd` ran in bypass mode and are not counted either.

## What to ship

Make spring the skill-loading default for `gbrain setup claude-code` and `gbrain setup codex`: it met the preregistered rule on both harnesses, and it carries the skills at about a quarter of native's per-turn cost. Keep spring's Claude Code allow rule, since it is the reason no load was denied. Separately, the permission floor means a headless default install can't use the brain on Claude Code and can't write to it on Codex; that deserves its own fix and measurement. This would flip if a Codex secondary with writes enabled showed native passing clearly more than spring, since right_skill_used ties there.

## Reproduce and inspect

Requirements: Bun, `npm i -g @anthropic-ai/claude-code@2.1.310 @openai/codex@0.164.0`, `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, and a gbrain checkout of `capy/gbra194-spring-skills` at `12669180`. From the repository root:

```bash
cd docs/benchmarks/2026-10-24-spring-loaded-skills
export SKEVAL_CHECKOUT=/path/to/gbrain-checkout
bun run.ts --probe --harness claude --models claude-sonnet-5-5,claude-opus-5-5 --reps 2 --out results/probe-claude-code.jsonl
bun run.ts --probe --harness codex --models gpt-6.1-sol --reps 2 --out results/probe-codex.jsonl
bun run.ts --harness claude --models claude-sonnet-5-5 --reps 2 --perm real --out results/claude-code.jsonl
bun run.ts --harness claude --models claude-opus-5-5 --reps 1 --perm real --out results/claude-code.jsonl
bun run.ts --harness codex --models gpt-6.1-sol --reps 2 --perm real --out results/codex.jsonl
bun run.ts --harness claude --models claude-sonnet-5-5 --reps 2 --perm mcp-allow --out results/claude-code-mcp-allow.jsonl
bun run.ts --harness claude --models claude-opus-5-5 --reps 1 --perm mcp-allow --out results/claude-code-mcp-allow.jsonl
bun summarize.ts --probe results/probe-claude-code.jsonl results/probe-codex.jsonl -- results/claude-code.jsonl results/codex.jsonl results/claude-code-mcp-allow.jsonl > summary.md
```

The runner writes its launcher, slots and ledger under `~/.capy/work/skeval`, skips trials already in the output file, and stops before a trial that could take the ledger past `--cap` dollars.

Receipts in [`2026-10-24-spring-loaded-skills/`](2026-10-24-spring-loaded-skills/):

- `results/claude-code.jsonl`, `results/codex.jsonl`, `results/claude-code-mcp-allow.jsonl`: one row per counted trial, with the arm, permission configuration, allow rules, instruction-file hash, skill loads and how each was made, denied calls, every tool call (arguments and results truncated), the final answer, brain and workspace changes, grades, tokens and cost. Machine paths are rewritten by `scrubMachinePaths`.
- `results/probe-claude-code.jsonl`, `results/probe-codex.jsonl`: standing-token probes.
- `results/pilot/`, `results/smoke/`, `results/superseded-2b92f8cd/`: pilots, wiring smokes and superseded probes, not counted.
- `summary.md`, `summary.json`, `preregistration.md`, `tasks.json`, `base-instructions.md`, `gen-fixtures.ts`, `export-bundled.ts`, `run.ts`, `detect.ts`, `grade.ts`, `dbdump.ts`, `summarize.ts`.

Model spend for the 360 counted trials was $34.52: on Claude Code real, $4.15 for Sonnet and $5.73 for Opus; on Claude Code mcp-allow, $5.93 for Sonnet and $8.58 for Opus; on Codex, $10.12 for gpt-6.1-sol. The standing-token probes cost $0.84, and pilots, smokes and superseded probes $5.91, for $41.27 in total against a $55 cap. Claude Code reports its own list-price cost. Codex cost is computed from its token counts at gpt-6.1-sol's list prices in `eval/runner/budget-ledger.ts`.
