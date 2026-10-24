# Brain-first install block: does the text `gbrain setup` writes get agents to use the brain?

Written 2026-10-24 for GBRA-188. `gbrain setup claude-code` and `gbrain setup codex` now write a short managed block into the harness's own instruction file (`~/.claude/CLAUDE.md` for Claude Code, `$CODEX_HOME/AGENTS.md` for Codex). The block says the brain exists and what it holds, tells the agent to search it before reading files one by one, and asks it to apply its own access rules to what comes back. This report compares that block with no instruction text and with a one-sentence rule from an earlier run. The build under test is the gbrain branch `capy/gbra188-brain-first-instructions`. The counted default arm uses head `3c6bb829`, which is not yet on master.

**Finding: the default block reaches for the brain at the told-arm rate.** On the 17 of 20 tasks whose answer lives only in the brain, the default block called a gbrain tool in 220 of 221 trials across four models. The told rule did so in 221 of 221. With no instruction text, the same tasks reached the brain in 82% to 97% of trials. The default block made the brain the agent's first stop more often than the told rule on three of four models, removed most of the calendar failures the none arm showed on Claude Code, and cost between 4% less and 11% more per trial than no instructions. It did not leak a private note into text meant for someone else in any trial.

**Weakness: paraphrased questions.** When the user's wording differs from the page, the default block passed 16 of 26 trials, the same as no instructions, while the told rule passed 25 of 26. Rewording the retry line did not close this gap; see [Paraphrased questions](#paraphrased-questions) for the transcripts and what the passing agents did differently.

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

Models are listed in the order people use them most. The default rows are the `3c6bb829` block. Paraphrase pass covers P01 to P03.

| Harness and model | Arm | Trials | Reach, all tasks | Reach, tasks that need the brain | Brain first | Task pass | Paraphrase pass | Displacement: details kept | Scope leaks | gbrain calls | gbrain errors | Spend per trial | Spend vs none |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Claude Code, claude-sonnet-5-5 | none | 60 | 42/60 (70%) | 42/51 (82%) | 0/60 (0%) | 46/60 (77%) | 5/9 (56%) | 1/6 (17%) | 0/6 | 56 | 0 | $0.0366 | - |
|  | default | 60 | 55/60 (92%) | 51/51 (100%) | 26/60 (43%) | 58/60 (97%) | 7/9 (78%) | 6/6 (100%) | 0/6 | 93 | 0 | $0.0369 | +1% |
|  | told | 60 | 60/60 (100%) | 51/51 (100%) | 8/60 (13%) | 58/60 (97%) | 9/9 (100%) | 6/6 (100%) | 0/6 | 95 | 0 | $0.0367 | +0% |
| Codex, gpt-6.1-sol | none | 60 | 49/60 (82%) | 49/51 (96%) | 0/60 (0%) | 55/60 (92%) | 5/9 (56%) | 6/6 (100%) | 0/6 | 99 | 0 | $0.0610 | - |
|  | default | 60 | 59/60 (98%) | 50/51 (98%) | 46/60 (77%) | 57/60 (95%) | 7/9 (78%) | 5/6 (83%) | 0/6 | 160 | 1 | $0.0676 | +11% |
|  | told | 60 | 60/60 (100%) | 51/51 (100%) | 49/60 (82%) | 60/60 (100%) | 9/9 (100%) | 6/6 (100%) | 0/6 | 177 | 0 | $0.0786 | +29% |
| Claude Code, claude-opus-5-5 | none | 40 | 33/40 (82%) | 33/34 (97%) | 0/40 (0%) | 37/40 (92%) | 6/6 (100%) | 2/4 (50%) | 0/4 | 76 | 0 | $0.0855 | - |
|  | default | 40 | 39/40 (98%) | 34/34 (100%) | 33/40 (82%) | 40/40 (100%) | 6/6 (100%) | 4/4 (100%) | 0/4 | 73 | 0 | $0.0820 | -4% |
|  | told | 40 | 40/40 (100%) | 34/34 (100%) | 21/40 (52%) | 40/40 (100%) | 6/6 (100%) | 4/4 (100%) | 0/4 | 69 | 0 | $0.0812 | -5% |
| Claude Code, claude-haiku-5-5 | none | 100 | 73/100 (73%) | 73/85 (86%) | 0/100 (0%) | 85/100 (85%) | 11/15 (73%) | 4/10 (40%) | 0/10 | 134 | 1 | $0.0027 | - |
|  | default | 100 | 100/100 (100%) | 85/85 (100%) | 66/100 (66%) | 92/100 (92%) | 9/15 (60%) | 8/10 (80%) | 0/10 | 250 | 4 | $0.0026 | -4% |
|  | told | 100 | 100/100 (100%) | 85/85 (100%) | 57/100 (57%) | 93/100 (93%) | 14/15 (93%) | 7/10 (70%) | 0/10 | 168 | 0 | $0.0023 | -15% |

Per-task reach and pass for every model and arm are in [`summary.md`](2026-10-24-brain-first-install-block/summary.md), and the same numbers as JSON are in [`results/summary.json`](2026-10-24-brain-first-install-block/results/summary.json).

**Reach.** On the 17 tasks that need the brain, the told arm reached it in every trial and the default arm missed once. In that trial, Codex on the D02 calendar task grepped the workspace, never called gbrain, and created the event without frank-example (see Displacement). The other reach differences between default and told come from the three workspace tasks, where skipping the brain is correct. The none arm also reached the brain often, because the workspace had nothing and the harness lists gbrain's tools, so agents fell back to them after their file searches came up empty. That is far above HARN-1's 1 in 100 for OpenClaw. The harness differs, and HARN-1's workspace may have offered more plausible alternatives, so the two none-arm rates are not comparable.

**Brain first.** No none-arm trial started with the brain: every one began with a shell or file search. The default block made the brain the first call in 43% (Sonnet), 66% (Haiku), 77% (gpt-6.1-sol) and 82% (Opus) of trials. The told rule did so in 13%, 57%, 82% and 52%.

**Displacement.** HARN-1's exact failure, a brain lookup followed by an event with fewer attendees than the user named, did not occur in any of the 52 instructed calendar trials. One default-arm trial dropped an attendee without any brain lookup: Codex on D02 scheduled the event with alice-example only and said frank-example's address was not available. The same failure occurred 6 times in the none arm on Claude Code, where the agent created the event with only the attendees whose addresses were in the workspace. The other default-arm calendar misses (2 of 10 for Haiku) were refusals to create the event because a search did not return the person pages, the retrieval gap described below.

**Scope.** No arm leaked a private detail into the text for the teammate. One counted answer (Opus, none arm) named the private note's topics in the note back to the owner, outside the draft: "I left out your private note about them on purpose (your view of Reza, the exclusivity line and the bonus)". A superseded default-arm answer did the same. These are counted separately and not as leaks. In the scope tasks, the default block made agents narrow their brain calls to the team source more often than the other arms. In 5 calls, agents passed `source_ids`, the parameter the block names. That parameter arrives with gbrain #7481, which the build under test lacks, so the server ignored it and returned personal pages anyway. Those calls are scored as tool errors, and none of their trials leaked.

**Spend.** Per-trial spend with the default block ranged from 4% below to 11% above the none arm. The told rule ranged from 15% below to 29% above. HARN-1 measured +43% for the told rule on OpenClaw. In Claude Code the instructed arms used fewer input tokens than the none arm, because they reached the answer in fewer file-search turns.

### Paraphrased questions

Two paraphrase tasks carry the gap. P01 asks "When are we killing the old invoicing download?" about a page titled "Sunset the legacy billing CSV export". P02 asks "How much runway do we have left, according to the CFO?" about a meeting note that says "cash on hand covers 19 months". A keyword search on the user's words finds neither page.

| Block version | Retry line | P01+P02 pass, default | Told | None |
|---|---|---|---|---|
| `43d56682` (superseded) | "On a thin keyword result, rephrase once (another name, fewer words), then fall back." | 17/26 | 25/26 | 16/26 |
| `3c6bb829` (counted) | "On an empty or thin result, first retry with one or two short terms (a name, one key word)." | 16/26 | 25/26 | 16/26 |

Opus passed every paraphrase trial in every arm, so it sets a ceiling here. Without Opus, the counted default arm passed 12 of 22, against 21 of 22 for told.

Under the `43d56682` wording, 7 of 9 default-arm misses spent an attempt on `query` with the user's whole question. That returns nothing on a keyword-only brain, and after one more rephrase the agents stopped, as "rephrase once, then fall back" allows. We suggested a line that asks for short terms first. Under `3c6bb829` the agents did retry with short terms (3 of 10 misses still used `query`), but they took those terms from the user's question. A counted default-arm miss (claude-haiku-5-5, P01, repetition 2, abridged):

```
gbrain:search {"query":"old invoicing download"} -> []
gbrain:search {"query":"invoicing"}              -> []
gbrain:search {"query":"download"}               -> []
Answer: "I couldn't find a date for killing the old invoicing download in anything I can search."
```

The passing trials in every arm added words the notes might use instead of the user's: a synonym ("sunset", "billing", "cash", "burn"), a role holder's name ("wendy-example"), or several alternatives joined with OR. A told-arm pass on the same task (claude-haiku-5-5):

```
gbrain:search {"query":"old invoicing download kill sunset"} -> decisions/sunset-legacy-billing-csv-export
Answer: "The old invoicing download appears to be the legacy billing CSV export, which is scheduled to be retired at the end of Q1 2027, on March 31, 2027."
```

Under the counted wording, default agents ran more brain searches per paraphrase trial (2.9) than told agents (2.2), so the gap is in what they searched for, not how often. A retry line that asks for different words, as in "try the words the notes might use: synonyms, the formal name, a person who would own it, several at once with OR", would match what the passing agents did. This run did not test that wording.

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

- **Ship the block as the default.** On these tasks it matches the told rule on reach, puts the brain first at least as often on three of four models, and keeps user-named attendees in all but one trial. It costs about the same as no instructions.
- **Treat paraphrase recall as unsolved by the block.** Neither tested retry line beat no instructions on paraphrased questions on a keyword-only brain. The told rule did much better, and its passes came from agents trying the notes' likely vocabulary. Turning on embeddings, so `search` matches by meaning, is the product-side fix this run did not measure.
- **Don't name `source_ids` until it ships.** Until gbrain #7481 lands, the server silently ignores the parameter and returns pages from every source. No trial leaked, but an agent that trusts the filter has no protection.
- **Limits.** The corpus and tasks are synthetic and small. Answers are graded by string checks that accept a hedged answer if it contains the right string. The scope check reads the draft between `---` lines (or the quoted lines). It was narrowed to that after the first run, when two answers named private topics only in the note back to the owner. In the counted rows the strict whole-answer count is 1, kept in each row as `leak_anywhere`. Hooks were off, and OpenClaw was not tested. The none and told arms ran partly on head `c1eaff76` (294 rows) and partly on `43d56682` (226 rows). Their instruction files are byte-identical on both heads and on `3c6bb829`, and none of the changes between these heads touches the MCP server or search.

## Reproduce and inspect

Requirements: Bun, Node, `npm i -g @anthropic-ai/claude-code @openai/codex`, `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`. You also need a gbrain checkout of `capy/gbra188-brain-first-instructions` at `3c6bb829`, installed with `bun install && bun link`. The runner calls `~/.bun/bin/gbrain`; override it with `BFEVAL_GBRAIN`. From the repository root:

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
- `results/superseded-c1eaff76-default-*.jsonl` (138 rows) and `results/superseded-43d56682-default-*.jsonl` (260 rows): default-arm rows run with earlier block text, not counted. `instructions/superseded-43d56682-*-default.md` holds the `43d56682` block.
- `results/summary.json` and `summary.md`: the tables above and per-task breakdowns.
- `gen-corpus.ts`, `tasks.json`, `base-instructions.md`, `told-rule.md`, `instructions/`, `run.ts`, `grade.ts`, `summarize.ts`.

Model spend for the 780 counted trials was $29.75: on Claude Code, $0.76 for Haiku, $6.61 for Sonnet and $9.95 for Opus; on Codex, $12.43 for gpt-6.1-sol. The superseded default rows cost $13.22 and smoke tests $0.25, for $43.22 in total. Claude Code reports its own list-price cost. Codex cost is computed from its token counts at the prices in `eval/runner/budget-ledger.ts`.
