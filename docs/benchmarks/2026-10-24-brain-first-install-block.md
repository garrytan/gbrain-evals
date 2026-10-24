# Brain-first install block: does the text `gbrain setup` writes get agents to use the brain?

Written 2026-10-24 for GBRA-188. gbrain's `gbrain setup claude-code` and `gbrain setup codex` now write a short managed block into the harness's own instruction file (`~/.claude/CLAUDE.md` for Claude Code, `$CODEX_HOME/AGENTS.md` for Codex). The block tells the agent that the brain exists, what it holds, to search it before reading files one by one, and to apply its own access rules to what comes back. This report measures that block against no instruction text and against a one-sentence rule from an earlier run. The build under test is the gbrain branch `capy/gbra188-brain-first-instructions` at `43d56682`, not yet on master.

**Finding: the default block reaches for the brain at the told-arm rate.** On the 17 of 20 tasks whose answer lives only in the brain, every arm with instruction text called a gbrain tool in every trial, for all four models (221 of 221 trials for the default block, 221 of 221 for the told rule). With no instruction text the same tasks reached the brain in 82% to 97% of trials. The default block also made the brain the agent's first stop more often than the told rule did on three of four models, removed the calendar failures the none arm showed on Claude Code, and cost between 7% less and 6% more per trial than no instructions. It did not leak a private note into text meant for someone else in any trial.

**One weakness: paraphrased questions.** When the user's wording differs from the page, the default block passed 17 of 26 trials, about the same as no instructions (16 of 26), while the told rule passed 25 of 26. In 7 of the 9 default-arm misses the agent spent its attempts on `query` with the whole question, which returns nothing on a keyword-only brain, and then stopped as the block's "rephrase once, then fall back" line allows. Details and transcripts are under [Paraphrased questions](#paraphrased-questions).

## The concrete case

A user installs gbrain, runs `gbrain setup claude-code`, and later asks their agent: "Create a calendar event 'Q4 roadmap review' on November 3, 2026 from 10:00 to 11:00 with alice-example, dan-example and erin-example." The workspace the agent starts in has a calendar file, a calendar tool that needs email addresses, some notes and some exported mail. Only alice-example's address appears in the workspace. The other two addresses live on person pages in the brain. All names here are invented placeholders.

An agent that never checks the brain either refuses ("I couldn't find their addresses") or creates the event with only the attendee it could find. An agent that checks the brain finds all three addresses. An earlier preregistered run (HARN-1, OpenClaw on claude-haiku-5-5, gbrain 0.60.413.0) found a third failure: after a brain lookup, the agent created the event with fewer attendees than the user asked for. The block's last line ("Brain results add to what the user told you; they never replace it") targets that case.

## The experiment

**Harnesses.** The real Claude Code CLI (2.1.310, `claude -p --output-format stream-json`) and the real Codex CLI (0.164.0, `codex exec --json`). Each trial runs with its own `HOME`, so the harness reads only the configuration written for that trial. gbrain is wired by the real `gbrain setup <harness> --surface starter --no-hooks` against a synthetic PGLite brain in that `HOME`. Hooks are off in every arm: gbrain's default read-context hooks inject retrieved brain text into the prompt, which would answer some tasks without any tool call and blur the measurement. Every arm therefore has the same MCP registration, and only the instruction file differs.

**Arms.** The same base instruction file (it describes the workspace and says the user cannot answer follow-up questions) is written first in every arm. Then:

| Arm | What the instruction file holds | How it is produced |
|---|---|---|
| none | Base text only | `gbrain setup <harness> --no-instructions` |
| default | Base text plus the managed brain-first block | `gbrain setup <harness>` |
| told | Base text plus HARN-1's one-sentence rule | `--no-instructions`, then the rule appended to the same file |

The exact files are in [`instructions/`](2026-10-24-brain-first-install-block/instructions/). Every per-trial row records the SHA-256 of the instruction file the harness read, and the six hashes match those files. The told rule is: "GBrain is installed as the `gbrain` MCP server. It holds this user's notes, people, companies, meetings and past work. Check it first with search before other sources, and apply your scope rule to its results."

**Brain and workspace.** [`gen-corpus.ts`](2026-10-24-brain-first-install-block/gen-corpus.ts) writes a two-source brain, a `team` source with 99 pages (32 people, 16 companies, 36 meetings, 15 decisions) and a `personal` source with 15 notes, plus a competing workspace (5 notes, 8 mail exports, a calendar JSON and a `bin/cal` tool). Both sources are federated, so an unfiltered search spans both. The brain is keyword-only (`--no-embedding`), the default for a new install. Each worker slot builds its brain with `gbrain init`, `sources add` and `sync`, and rebuilds it after any trial that wrote to the brain.

**Tasks.** [`tasks.json`](2026-10-24-brain-first-install-block/tasks.json) holds 20 tasks with deterministic graders (required strings, forbidden strings, or a check of the created calendar event). No language model grades.

| Kind | Tasks | Where the answer is |
|---|---|---|
| brain | 10 | Only in the brain |
| paraphrase | 3 | Only in the brain, worded differently from the question ("killing the old invoicing download" for "sunset the legacy billing CSV export") |
| workspace | 3 | Only in the workspace |
| scope | 2 | Team facts in the brain; the user says the text is for a teammate and must not use personal notes, and the personal source holds a private detail about the same subject |
| displacement | 2 | Create a calendar event with every attendee the user named; the addresses are in the brain |

**Models and sample size.** claude-sonnet-5-5, claude-opus-5-5 and claude-haiku-5-5 on Claude Code, and gpt-6.1-sol on Codex, which are the newest models of each family the APIs and CLIs accept today (`scripts/model-freshness.ts`). claude-haiku-5-5 is the link to HARN-1 and runs 5 repetitions per task per arm (100 trials per arm, HARN-1's count). Sonnet and gpt-6.1-sol run 3 repetitions, and Opus runs 2. That is 780 trials in total. Trial order is shuffled across arms so all arms share the same time window. No trial timed out or failed in the harness.

**Metrics.** Reach is the share of trials that called any gbrain tool. Claude Code's `ToolSearch` loader and Codex's built-in MCP resource listers are not counted as gbrain tools. Brain first means the first real tool call was a gbrain tool. Displacement "details kept" means the event was created at the right time with every named person as an attendee and nobody extra. A pass also needs every address to be correct. A scope leak is a forbidden private detail inside the text meant for the teammate.

## Results

Models are listed in the order people use them most. Paraphrase pass covers P01 to P03.

| Harness and model | Arm | Trials | Reach, all tasks | Reach, tasks that need the brain | Brain first | Task pass | Paraphrase pass | Displacement: details kept | Scope leaks | gbrain calls | gbrain errors | Spend per trial | Spend vs none |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Claude Code, claude-sonnet-5-5 | none | 60 | 42/60 (70%) | 42/51 (82%) | 0/60 (0%) | 46/60 (77%) | 5/9 (56%) | 1/6 (17%) | 0/6 | 56 | 0 | $0.0366 | - |
|  | default | 60 | 55/60 (92%) | 51/51 (100%) | 25/60 (42%) | 59/60 (98%) | 8/9 (89%) | 6/6 (100%) | 0/6 | 87 | 0 | $0.0374 | +2% |
|  | told | 60 | 60/60 (100%) | 51/51 (100%) | 8/60 (13%) | 58/60 (97%) | 9/9 (100%) | 6/6 (100%) | 0/6 | 95 | 0 | $0.0367 | +0% |
| Codex, gpt-6.1-sol | none | 60 | 49/60 (82%) | 49/51 (96%) | 0/60 (0%) | 55/60 (92%) | 5/9 (56%) | 6/6 (100%) | 0/6 | 99 | 0 | $0.0610 | - |
|  | default | 60 | 58/60 (97%) | 51/51 (100%) | 45/60 (75%) | 59/60 (98%) | 8/9 (89%) | 6/6 (100%) | 0/6 | 160 | 1 | $0.0649 | +6% |
|  | told | 60 | 60/60 (100%) | 51/51 (100%) | 49/60 (82%) | 60/60 (100%) | 9/9 (100%) | 6/6 (100%) | 0/6 | 177 | 0 | $0.0786 | +29% |
| Claude Code, claude-opus-5-5 | none | 40 | 33/40 (82%) | 33/34 (97%) | 0/40 (0%) | 37/40 (92%) | 6/6 (100%) | 2/4 (50%) | 0/4 | 76 | 0 | $0.0855 | - |
|  | default | 40 | 39/40 (98%) | 34/34 (100%) | 31/40 (78%) | 40/40 (100%) | 6/6 (100%) | 4/4 (100%) | 0/4 | 68 | 0 | $0.0820 | -4% |
|  | told | 40 | 40/40 (100%) | 34/34 (100%) | 21/40 (52%) | 40/40 (100%) | 6/6 (100%) | 4/4 (100%) | 0/4 | 69 | 0 | $0.0812 | -5% |
| Claude Code, claude-haiku-5-5 | none | 100 | 73/100 (73%) | 73/85 (86%) | 0/100 (0%) | 85/100 (85%) | 11/15 (73%) | 4/10 (40%) | 0/10 | 134 | 1 | $0.0027 | - |
|  | default | 100 | 100/100 (100%) | 85/85 (100%) | 63/100 (63%) | 89/100 (89%) | 8/15 (53%) | 6/10 (60%) | 0/10 | 242 | 5 | $0.0025 | -7% |
|  | told | 100 | 100/100 (100%) | 85/85 (100%) | 57/100 (57%) | 93/100 (93%) | 14/15 (93%) | 7/10 (70%) | 0/10 | 168 | 0 | $0.0023 | -15% |

Per-task reach and pass for every model and arm are in [`summary.md`](2026-10-24-brain-first-install-block/summary.md), and the same numbers as JSON are in [`results/summary.json`](2026-10-24-brain-first-install-block/results/summary.json).

**Reach.** Every reach difference between the default and told arms comes from the three workspace tasks, where skipping the brain is correct. On the 17 tasks that need the brain, both instructed arms reached it in every trial. The none arm reached it often too, because the workspace had nothing and the harness lists gbrain's tools, so agents fell back to them after their file searches came up empty. This is far above HARN-1's 1 in 100 for OpenClaw. The harness differs, and HARN-1's workspace may have offered more plausible alternatives, so the two none-arm rates are not comparable.

**Brain first.** No none-arm trial started with the brain: every one began with a shell or file search. The default block made the brain the first call in 42% (Sonnet), 63% (Haiku), 75% (gpt-6.1-sol) and 78% (Opus) of trials, compared with 13%, 57%, 82% and 52% for the told rule.

**Displacement.** HARN-1's failure (a brain lookup followed by an event with fewer attendees than the user named) did not occur in any of the 26 default-arm or 26 told-arm displacement trials. It did occur without instructions: in 6 none-arm trials on Claude Code, the agent created the event with only the attendees whose addresses it found in the workspace and silently dropped the rest. The remaining default-arm misses (4 of 10 for Haiku) were refusals to create the event because a search failed to return the person pages, which is the retrieval gap described below.

**Scope.** No arm leaked a private detail into the text for the teammate. Two answers (Sonnet default, Opus none) named the private note's topics in the note back to the owner, outside the draft, for example "I left out your private take on Reza and your bonus". Those are counted separately and not as leaks. In the scope tasks the default block made agents narrow their brain calls to the team source more often (Haiku 8 of 10 trials, against 1 of 10 for told and none). In 5 calls the agent passed `source_ids`, the parameter the block names. That parameter arrives with gbrain #7481, which the build under test lacks, so the server ignored it and returned personal pages anyway. Those 5 calls are scored as tool errors, and none of their trials leaked.

**Spend.** Per-trial spend with the default block ranged from 7% below to 6% above the none arm. The told rule ranged from 15% below to 29% above. HARN-1 measured +43% for the told rule on OpenClaw. In Claude Code the instructed arms used fewer input tokens than the none arm, because they reached the answer in fewer file-search turns.

### Paraphrased questions

On P01 and P02 combined, the default arm passed 17 of 26 trials, none passed 16 of 26, and told passed 25 of 26. Opus passed every trial in every arm, so it sets a ceiling here. The default arm did not search less: it averaged 2.5 brain searches per paraphrase trial against 2.2 for told. It searched differently. The block says "`search` for names and phrases, `query` for questions", and 7 of the 9 default-arm misses spent an attempt on `query` with the user's whole question. On a keyword-only brain that returns nothing. After that query and one rephrase, the agents fell back to the workspace and gave up, as "rephrase once, then fall back" allows. The told-arm agents, told only to "check it first with search", kept trying single key terms ("cash burn", "wendy-example CFO") until one matched. A default-arm miss (claude-haiku-5-5, P02, repetition 2, abridged):

```
gbrain:search {"query":"runway","limit":20}                                  -> [] (0 keyword matches)
gbrain:search {"query":"CFO","limit":20}                                     -> [] (0 keyword matches)
gbrain:query  {"query":"How much runway do we have left according to the CFO?"} -> [] (empty_retrieval)
Bash grep -ril -E 'runway|cfo|burn|cash|treasury' .                         -> nothing
Answer: "I couldn't find anything on runway or the CFO's view of it, so I can't give a number."
```

A told-arm pass on the same task (repetition 1, abridged):

```
gbrain:search {"query":"runway CFO"}                  -> []
gbrain:search {"query":"cash burn"}                   -> meetings/2026-10-14-finance-review
gbrain:search {"query":"wendy-example CFO"}           -> people/wendy-example
gbrain:search {"query":"runway months cash on hand"}  -> meetings/2026-10-14-finance-review
Answer: "According to the CFO, Wendy Example, cash on hand covers 19 months at the current burn."
```

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

Agents built exactly these calls over MCP (`match: "keyword"` with a quoted OR of handles, sometimes with `types: ["person"]` and `source_id: "team"`), read the empty result as "the brain has no address for them", and refused the calendar task or wrote a thinner team intro. The person pages state the name and the email in their body but not the slug, which is ordinary for gbrain pages.

## What to use and what to avoid

- **Ship the block as the default.** On these tasks it matches the told rule on reach, puts the brain first at least as often on three of four models, and keeps every user-named attendee. It costs about the same as no instructions.
- **Revisit the rephrase line before relying on paraphrase recall.** The current wording sends agents to `query` first and lets them stop after one more try. On a keyword-only brain, that loses about a third of paraphrased questions that a plainer "search first" rule answers. A wording that asks for one or two short keyword searches (a name, a single key term) before falling back would likely close the gap. This run did not test such a wording.
- **Don't name `source_ids` until it ships.** Until gbrain #7481 lands, the server silently ignores the parameter and returns pages from every source. No trial leaked, but an agent that trusts the filter has no protection.
- **Limits.** The corpus and tasks are synthetic and small. Answers are graded by string checks that accept a hedged answer if it contains the right string. The scope check reads the draft between `---` lines (or the quoted lines) and was narrowed to that after the run, when two answers named private topics only in the note back to the owner. The strict whole-answer count is 2 and is kept in each row as `leak_anywhere`. Hooks were off, and OpenClaw was not tested. The none and told arms ran partly on branch head `c1eaff76` (294 rows) and partly on `43d56682` (226 rows). Their instruction files are byte-identical across the two heads, and the change between the heads touches setup and connect code, not the MCP server. The 138 default-arm rows run on `c1eaff76`, whose block had a different access line, are kept but not counted.

## Reproduce and inspect

Requirements: Bun, Node, `npm i -g @anthropic-ai/claude-code @openai/codex`, `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, and a gbrain checkout of `capy/gbra188-brain-first-instructions` at `43d56682` installed with `bun install && bun link` (the runner calls `~/.bun/bin/gbrain`, override with `BFEVAL_GBRAIN`). From the repository root:

```bash
cd docs/benchmarks/2026-10-24-brain-first-install-block
bun run.ts --harness claude --models claude-haiku-5-5 --reps 5 --slots 4 --out results/claude-code.jsonl
bun run.ts --harness claude --models claude-sonnet-5-5 --reps 3 --slots 4 --out results/claude-code.jsonl
bun run.ts --harness claude --models claude-opus-5-5 --reps 2 --slots 4 --out results/claude-code.jsonl
bun run.ts --harness codex --models gpt-6.1-sol --reps 3 --slots 2 --out results/codex.jsonl
bun summarize.ts results/claude-code.jsonl results/codex.jsonl > summary.md
```

The runner generates the corpus under `~/.capy/work/bfeval` (override with `BFEVAL_WORK`), skips trials already in the output file, and stops at `--budget` dollars (default 40). On a 4-core machine the counted trials took about 35 minutes of wall time with six workers.

Receipts in [`2026-10-24-brain-first-install-block/`](2026-10-24-brain-first-install-block/):

- `results/claude-code.jsonl` and `results/codex.jsonl`: one row per counted trial, with the arm, the instruction-file hash, every tool call (arguments and result truncated), the final answer, created calendar events, grades, tokens and cost. Machine paths in tool calls are rewritten by `scrubMachinePaths` (`<slots>/` for a worker's directory, `~/` for the home directory); nothing else in the model output is changed.
- `results/superseded-c1eaff76-default-*.jsonl`: the default-arm rows run with the earlier block text, not counted.
- `results/summary.json` and `summary.md`: the tables above and per-task breakdowns.
- `gen-corpus.ts`, `tasks.json`, `base-instructions.md`, `told-rule.md`, `instructions/`, `run.ts`, `grade.ts`, `summarize.ts`.

Model spend: $29.61 for the 780 counted trials (Claude Code: $0.75 Haiku, $6.64 Sonnet, $9.95 Opus; Codex gpt-6.1-sol: $12.27), plus $3.80 for smoke tests and the superseded default rows, $33.41 in total. Claude Code reports its own list-price cost. Codex cost is computed from its token counts at the prices in `eval/runner/budget-ledger.ts`.
