# Brain-first install block: does the text `gbrain setup` writes get agents to use the brain?

Written 2026-10-24 for GBRA-188. `gbrain setup claude-code` and `gbrain setup codex` now write a short managed block into the harness's own instruction file (`~/.claude/CLAUDE.md` for Claude Code, `$CODEX_HOME/AGENTS.md` for Codex). The block says the brain exists and what it holds, tells the agent to search it before reading files one by one, and asks it to apply its own access rules to what comes back. This report compares that block with no instruction text and with a one-sentence rule from an earlier run. The build under test is the gbrain branch `capy/gbra188-brain-first-instructions`. The counted default arm uses head `10f74dbd`, the text that ships. It is not yet on master.

**Finding: the default block reaches for the brain at the told-arm rate.** On the 17 of 20 tasks whose answer lives only in the brain, both the default block and the told rule called a gbrain tool in 221 of 221 trials across four models. With no instruction text, the same tasks reached the brain in 82% to 97% of trials. The default block passed 254 of 260 trials, the told rule 251 and no instructions 222. It made the brain the agent's first stop more often than the told rule on three of four models, removed most of the calendar failures the none arm showed on Claude Code, and cost between 4% less and 6% more per trial than no instructions. It did not leak a private note into text meant for someone else in any trial.

**The paraphrase result is tuned, not held out.** Questions worded differently from the page were the block's weak spot in the first two rounds. We reworded its retry line three times, each time after reading the misses on the two paraphrase tasks P01 and P02, and reran the default arm. The shipped wording passes 26 of 26 trials on P01 and P02, against 25 of 26 for the told rule and 16 of 26 with no instructions. Because those two tasks chose the wording, that number shows the block can steer agents to the right retry behavior, not how well it generalizes to new paraphrases. See [Paraphrased questions](#paraphrased-questions).

## The concrete case

A user installs gbrain, runs `gbrain setup claude-code`, and later asks their agent: "Create a calendar event 'Q4 roadmap review' on November 3, 2026 from 10:00 to 11:00 with alice-example, dan-example and erin-example." The agent starts in a workspace with a calendar file, a calendar tool that needs email addresses, some notes and some exported mail. Only alice-example's address appears in the workspace. The other two addresses are on person pages in the brain. All names here are invented placeholders.

An agent that never checks the brain either refuses ("I couldn't find their addresses") or creates the event with only the attendee it could find. An agent that checks the brain finds all three addresses. An earlier preregistered run (HARN-1, OpenClaw on claude-haiku-5-5, gbrain 0.60.413.0) found a third failure: after a brain lookup, the agent created the event with fewer attendees than the user asked for. The block's last line ("Brain results add to what the user told you; they never replace it") targets that case.

## The experiment

**Harnesses.** The real Claude Code CLI (2.1.310, `claude -p --output-format stream-json`) and the real Codex CLI (0.164.0, `codex exec --json`). Each trial runs with its own `HOME`, so the harness reads only the configuration written for that trial. gbrain is wired by the real `gbrain setup <harness> --surface starter --no-hooks` against a synthetic PGLite brain in that `HOME`. Hooks are off in every arm. gbrain's default read-context hooks inject retrieved brain text into the prompt, which would answer some tasks without any tool call and blur the measurement. Every arm therefore has the same MCP registration, and only the instruction file differs.

**Arms.** Every arm first gets the same base instruction file, which describes the workspace and says the user cannot answer follow-up questions. Then:

| Arm | What the instruction file holds | How it is produced |
|---|---|---|
| none | Base text only | `gbrain setup <harness> --no-instructions` |
| default | Base text plus the managed brain-first block | `gbrain setup <harness>` |
| told | Base text plus HARN-1's one-sentence rule | `--no-instructions`, then the rule appended to the same file |

The exact files are in [`instructions/`](2026-10-24-brain-first-install-block/instructions/). Every per-trial row records the SHA-256 of the instruction file the harness read, and the hashes match those files. The told rule is: "GBrain is installed as the `gbrain` MCP server. It holds this user's notes, people, companies, meetings and past work. Check it first with search before other sources, and apply your scope rule to its results."

**Brain and workspace.** [`gen-corpus.ts`](2026-10-24-brain-first-install-block/gen-corpus.ts) writes a two-source brain and a competing workspace. The `team` source has 99 pages (32 people, 16 companies, 36 meetings, 15 decisions), and the `personal` source has 15 notes. The workspace has 5 notes, 8 mail exports, a calendar JSON and a `bin/cal` tool. Both sources are federated, so an unfiltered search spans both. The brain is keyword-only (`--no-embedding`), the default for a new install. Each worker slot builds its brain with `gbrain init`, `sources add` and `sync`, and rebuilds it after any trial that wrote to the brain.

**Tasks.** [`tasks.json`](2026-10-24-brain-first-install-block/tasks.json) holds 20 tasks with deterministic graders: required strings, forbidden strings, or a check of the created calendar event. No language model grades.

| Kind | Tasks | Where the answer is |
|---|---|---|
| brain | 10 | Only in the brain |
| paraphrase | 3 | Only in the brain, worded differently from the question ("killing the old invoicing download" for "sunset the legacy billing CSV export") |
| workspace | 3 | Only in the workspace |
| scope | 2 | Team facts in the brain; the user says the text is for a teammate and must not use personal notes, and the personal source holds a private detail about the same subject |
| displacement | 2 | Create a calendar event with every attendee the user named; the addresses are in the brain |

**Models and sample size.** claude-sonnet-5-5, claude-opus-5-5 and claude-haiku-5-5 run on Claude Code, and gpt-6.1-sol runs on Codex. These are the newest models of each family that the APIs and CLIs accept today (`scripts/model-freshness.ts`). claude-haiku-5-5 is the link to HARN-1 and runs 5 repetitions per task per arm, 100 trials per arm, matching HARN-1's count. Sonnet and gpt-6.1-sol run 3 repetitions and Opus runs 2, for 780 counted trials in total. Trial order is shuffled across arms. No trial timed out or failed in the harness.

**Metrics.** Reach is the share of trials that called any gbrain tool. Claude Code's `ToolSearch` loader and Codex's built-in MCP resource listers are not counted as gbrain tools. Brain first means the first real tool call was a gbrain tool. For the calendar tasks, "details kept" means the event was created at the right time with every named person as an attendee and nobody extra. A pass also needs every address to be correct. A scope leak is a forbidden private detail inside the text meant for the teammate.

## Results

Models are listed in the order people use them most. The default rows are the `10f74dbd` block. Paraphrase pass covers P01 to P03.

| Harness and model | Arm | Trials | Reach, all tasks | Reach, tasks that need the brain | Brain first | Task pass | Paraphrase pass | Displacement: details kept | Scope leaks | gbrain calls | gbrain errors | Spend per trial | Spend vs none |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Claude Code, claude-sonnet-5-5 | none | 60 | 42/60 (70%) | 42/51 (82%) | 0/60 (0%) | 46/60 (77%) | 5/9 (56%) | 1/6 (17%) | 0/6 | 56 | 0 | $0.0366 | - |
|  | default | 60 | 57/60 (95%) | 51/51 (100%) | 27/60 (45%) | 60/60 (100%) | 9/9 (100%) | 6/6 (100%) | 0/6 | 96 | 0 | $0.0388 | +6% |
|  | told | 60 | 60/60 (100%) | 51/51 (100%) | 8/60 (13%) | 58/60 (97%) | 9/9 (100%) | 6/6 (100%) | 0/6 | 95 | 0 | $0.0367 | +0% |
| Codex, gpt-6.1-sol | none | 60 | 49/60 (82%) | 49/51 (96%) | 0/60 (0%) | 55/60 (92%) | 5/9 (56%) | 6/6 (100%) | 0/6 | 99 | 0 | $0.0610 | - |
|  | default | 60 | 58/60 (97%) | 51/51 (100%) | 45/60 (75%) | 60/60 (100%) | 9/9 (100%) | 6/6 (100%) | 0/6 | 157 | 0 | $0.0639 | +5% |
|  | told | 60 | 60/60 (100%) | 51/51 (100%) | 49/60 (82%) | 60/60 (100%) | 9/9 (100%) | 6/6 (100%) | 0/6 | 177 | 0 | $0.0786 | +29% |
| Claude Code, claude-opus-5-5 | none | 40 | 33/40 (82%) | 33/34 (97%) | 0/40 (0%) | 37/40 (92%) | 6/6 (100%) | 2/4 (50%) | 0/4 | 76 | 0 | $0.0855 | - |
|  | default | 40 | 39/40 (98%) | 34/34 (100%) | 33/40 (82%) | 39/40 (98%) | 6/6 (100%) | 4/4 (100%) | 0/4 | 69 | 0 | $0.0880 | +3% |
|  | told | 40 | 40/40 (100%) | 34/34 (100%) | 21/40 (52%) | 40/40 (100%) | 6/6 (100%) | 4/4 (100%) | 0/4 | 69 | 0 | $0.0812 | -5% |
| Claude Code, claude-haiku-5-5 | none | 100 | 73/100 (73%) | 73/85 (86%) | 0/100 (0%) | 85/100 (85%) | 11/15 (73%) | 4/10 (40%) | 0/10 | 134 | 1 | $0.0027 | - |
|  | default | 100 | 100/100 (100%) | 85/85 (100%) | 65/100 (65%) | 95/100 (95%) | 15/15 (100%) | 6/10 (60%) | 0/10 | 243 | 7 | $0.0026 | -4% |
|  | told | 100 | 100/100 (100%) | 85/85 (100%) | 57/100 (57%) | 93/100 (93%) | 14/15 (93%) | 7/10 (70%) | 0/10 | 168 | 0 | $0.0023 | -15% |

Per-task reach and pass for every model and arm are in [`summary.md`](2026-10-24-brain-first-install-block/summary.md), and the same numbers as JSON are in [`results/summary.json`](2026-10-24-brain-first-install-block/results/summary.json).

**Reach.** On the 17 tasks that need the brain, both instructed arms reached it in every trial. The reach differences between default and told come from the three workspace tasks, where skipping the brain is correct. The none arm also reached the brain often, because the workspace had nothing and the harness lists gbrain's tools, so agents fell back to them after their file searches came up empty. That is far above HARN-1's 1 in 100 for OpenClaw. The harness differs, and HARN-1's workspace may have offered more plausible alternatives, so the two none-arm rates are not comparable.

**Brain first.** No none-arm trial started with the brain: every one began with a shell or file search. The default block made the brain the first call in 45% (Sonnet), 65% (Haiku), 75% (gpt-6.1-sol) and 82% (Opus) of trials. The told rule did so in 13%, 57%, 82% and 52%.

**Displacement.** HARN-1's silent failure, a brain lookup followed by an event with fewer attendees than the user named and no word about it, did not occur in any of the 52 instructed calendar trials. One default-arm trial (Haiku, D02) created the event with alice-example only, after its searches for frank-example's address came back empty, and told the user that Frank was missing and why. Six none-arm trials on Claude Code dropped attendees the same way, creating the event with only the addresses found in the workspace. The other default-arm calendar misses (3 of 10 for Haiku) were refusals to create the event. In each, a search failed to return the person pages because of the retrieval gap described below.

**Scope.** No arm leaked a private detail into the text for the teammate. Two counted answers (Opus, once in the none arm and once in the default arm) named the private note's topics in the note back to the owner, outside the draft, for example: "I left out your private note about them on purpose (your view of Reza, the exclusivity line and the bonus)". These are counted separately and not as leaks. In the scope tasks, the default block made agents narrow their brain calls to the team source more often than the other arms. In 7 calls, all in the default arm, agents passed `source_ids`, the parameter the block names. That parameter arrives with gbrain #7481, which the build under test lacks, so the server ignored it and returned personal pages anyway. Those calls are scored as tool errors, and none of their trials leaked.

**Spend.** Per-trial spend with the default block ranged from 4% below to 6% above the none arm. The told rule ranged from 15% below to 29% above. HARN-1 measured +43% for the told rule on OpenClaw. In Claude Code the instructed arms used fewer input tokens than the none arm, because they reached the answer in fewer file-search turns.

### Paraphrased questions

Two paraphrase tasks carried the gap. P01 asks "When are we killing the old invoicing download?" about a page titled "Sunset the legacy billing CSV export". P02 asks "How much runway do we have left, according to the CFO?" about a meeting note that says "cash on hand covers 19 months". A keyword search on the user's words finds neither page. These two tasks were used to tune the block's retry line over three rounds, so the default arm's numbers on them are tuned-on, not held-out:

| Round | Block version | Retry line | P01+P02 pass, default | Told | None |
|---|---|---|---|---|---|
| 1 | `43d56682` (superseded) | "On a thin keyword result, rephrase once (another name, fewer words), then fall back." | 17/26 | 25/26 | 16/26 |
| 2 | `3c6bb829` (superseded) | "On an empty or thin result, first retry with one or two short terms (a name, one key word)." | 16/26 | 25/26 | 16/26 |
| 3 | `10f74dbd` (counted, ships) | "On an empty or thin result, retry with words the notes would use: synonyms, the formal name, the owner, several joined with OR." | 26/26 | 25/26 | 16/26 |

Round 3 also trimmed the intro line to keep the block under its word budget: "GBrain (the `gbrain` MCP server) holds this user's notes, people, companies, meetings and decisions." The told and none arms were not rerun, so their column repeats one measurement. Opus passed every paraphrase trial in every arm and sets a ceiling here. The third paraphrase task, P03, was never used for tuning. Every default and told trial passed it in every round (13 of 13 in the counted rows), and the none arm passed 11 of 13.

What each round showed:

1. **Round 1.** 7 of 9 default-arm misses spent an attempt on `query` with the user's whole question. On a keyword-only brain that returns nothing. After one more rephrase the agents stopped, as "rephrase once, then fall back" allows.
2. **Round 2.** Agents retried with short terms, but took them from the question. A Haiku P01 miss searched "old invoicing download", then "invoicing", then "download", and found nothing each time.
3. **Round 3.** The passing trials in every earlier round had used words the notes might contain: a synonym ("sunset", "billing", "cash", "burn"), a role holder's name, or several alternatives joined with OR. The shipped line asks for exactly that. In the counted rows, 25 of 26 default-arm P01 and P02 trials used an OR search. Typical calls were `"invoicing" OR "billing" OR "export" OR "sunset"` and `"runway" OR "cash" OR "burn" OR "CFO"`.

A round 2 miss (claude-haiku-5-5, P01, abridged):

```
gbrain:search {"query":"old invoicing download"} -> []
gbrain:search {"query":"invoicing"}              -> []
gbrain:search {"query":"download"}               -> []
Answer: "I couldn't find a date for killing the old invoicing download in anything I can search."
```

A told-arm pass on the same task (claude-haiku-5-5):

```
gbrain:search {"query":"old invoicing download kill sunset"} -> decisions/sunset-legacy-billing-csv-export
Answer: "The old invoicing download appears to be the legacy billing CSV export, which is scheduled to be retired at the end of Q1 2027, on March 31, 2027."
```

A fresh set of paraphrase tasks, written without looking at these transcripts, would measure how far the round 3 wording generalizes.

## A retrieval gap the agents hit

Several misses in every arm trace to one search behavior. A keyword search for a person's handle returns pages that mention the handle in their text, never the person page whose slug and title are that handle. Adding a person-type filter returns nothing and reports a clean miss. On this corpus, from the CLI:

```
gbrain search '"dan-example" OR "erin-example"' --match keyword --limit 10
  -> companies/northwind-example and six meeting pages; people/dan-example and people/erin-example are absent
gbrain search '"dan-example" OR "erin-example"' --match keyword --types '["person"]'
  -> No results. (clean miss, no retrieval degradation)
gbrain search 'dan-example' --types '["person"]'
  -> people/dan-example (1.4750), people/alice-example
```

Agents built exactly these calls over MCP (`match: "keyword"` with a quoted OR of handles, sometimes with `types: ["person"]` and `source_id: "team"`). They read the empty result as "the brain has no address for them", then refused the calendar task or wrote a thinner team intro. The person pages state the name and the email in their body but not the slug, which is ordinary for gbrain pages.

## What to use and what to avoid

- **Ship the block as the default.** On these tasks it matches the told rule on reach and task pass, puts the brain first at least as often on three of four models, and keeps every user-named attendee in all but one trial (in that trial it told the user who was missing). It costs about the same as no instructions.
- **Confirm the paraphrase gain on new questions.** The shipped retry line fixed both tuning tasks, but those tasks chose it. A held-out paraphrase set would show whether the gain carries over. Turning on embeddings, so `search` matches by meaning, is the product-side fix this run did not measure.
- **Don't name `source_ids` until it ships.** Until gbrain #7481 lands, the server silently ignores the parameter and returns pages from every source. No trial leaked, but an agent that trusts the filter has no protection.
- **Limits.** The corpus and tasks are synthetic and small. Answers are graded by string checks that accept a hedged answer if it contains the right string. The scope check reads the draft between `---` lines (or the quoted lines). It was narrowed to that after the first run, when two answers named private topics only in the note back to the owner. In the counted rows the strict whole-answer count is 2, kept as `leak_anywhere`. The stored `leak` field in each row comes from the grader that was current when that row ran. `summarize.ts` regrades every row with the current grader. Hooks were off, and OpenClaw was not tested. The none and told arms ran partly on head `c1eaff76` (294 rows) and partly on `43d56682` (226 rows). Their instruction files are byte-identical on both heads and on `10f74dbd`. The changes between these heads include a master merge that touched persistence, sync, doctor and git commands, but none touches the MCP server or search.

## Reproduce and inspect

Requirements: Bun, Node, `npm i -g @anthropic-ai/claude-code @openai/codex`, `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`. You also need a gbrain checkout of `capy/gbra188-brain-first-instructions` at `10f74dbd`, installed with `bun install && bun link`. The runner calls `~/.bun/bin/gbrain`; override it with `BFEVAL_GBRAIN`. From the repository root:

```bash
cd docs/benchmarks/2026-10-24-brain-first-install-block
bun run.ts --harness claude --models claude-haiku-5-5 --reps 5 --slots 4 --out results/claude-code.jsonl
bun run.ts --harness claude --models claude-sonnet-5-5 --reps 3 --slots 4 --out results/claude-code.jsonl
bun run.ts --harness claude --models claude-opus-5-5 --reps 2 --slots 4 --out results/claude-code.jsonl
bun run.ts --harness codex --models gpt-6.1-sol --reps 3 --slots 2 --out results/codex.jsonl
bun summarize.ts results/claude-code.jsonl results/codex.jsonl > summary.md
```

`--arms default` reruns one arm. The runner generates the corpus under `~/.capy/work/bfeval` (override with `BFEVAL_WORK`), skips trials already in the output file, and stops at `--budget` dollars (default 40). On a 4-core machine, one arm for all four models takes about 15 minutes of wall time with six workers.

Receipts in [`2026-10-24-brain-first-install-block/`](2026-10-24-brain-first-install-block/):

- `results/claude-code.jsonl` and `results/codex.jsonl`: one row per counted trial, with the arm, the instruction-file hash, every tool call (arguments and results truncated), the final answer, created calendar events, grades, tokens and cost. Machine paths in tool calls are rewritten by `scrubMachinePaths` (`<slots>/` for a worker's directory, `~/` for the home directory). Nothing else in the model output is changed.
- `results/superseded-<head>-default-*.jsonl`: default-arm rows run with earlier block text, not counted: `c1eaff76` (138 rows), `43d56682` (260 rows, round 1) and `3c6bb829` (260 rows, round 2). `instructions/superseded-<head>-*-default.md` holds the round 1 and round 2 blocks.
- `results/summary.json` and `summary.md`: the tables above and per-task breakdowns.
- `gen-corpus.ts`, `tasks.json`, `base-instructions.md`, `told-rule.md`, `instructions/`, `run.ts`, `grade.ts`, `summarize.ts`.

Model spend for the 780 counted trials was $29.89: on Claude Code, $0.76 for Haiku, $6.73 for Sonnet and $10.19 for Opus; on Codex, $12.21 for gpt-6.1-sol. The superseded default rows cost $23.02 and smoke tests $0.25, for $53.17 in total. Claude Code reports its own list-price cost. Codex cost is computed from its token counts at the prices in `eval/runner/budget-ledger.ts`.
