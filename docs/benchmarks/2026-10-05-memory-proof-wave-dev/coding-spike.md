# Coding-agent memory spike: can the harness's coding benchmark measure gbrain?

**Finding (2026-10-05).** Yes. The public harness's coding benchmark runs end to end on a Capy cloud machine with gbrain as the memory, and every model and embedding call goes through the metering proxy. In 12 measured task runs (3 tasks, 2 agent images, with and without memory), the agent with gbrain memory fixed the bug on its first try in 5 of 6 runs; without memory it did so in 1 of 6. gbrain put the deciding document first in its retrieved context for all 60 of the 61 tasks whose corpus contains one. The spike cost $4.65 of metered spend. A full run with three arms and three seeds is estimated at $190 to $290 and about 5 hours on a 16-vCPU machine. **Recommendation: go**, after the four pieces of work listed under [Build first](#build-first). This is a feasibility spike on 3 hand-picked tasks, not a benchmark result.

gbrain is a memory system for agents: it stores notes as Markdown pages and builds a search index over them ([github.com/garrytan/gbrain](https://github.com/garrytan/gbrain)). The harness is the public agent-memory benchmark pinned in [`harness.lock.json`](../../../eval/harness-provider/harness.lock.json) at commit `f618ed7b`. The extract-first memory server it also tests is called "the comparator" here.

## The concrete case

The benchmark has 61 bug-fix tasks planted in a real Python library (boltons, pinned at `979fa9b`). Each task gives a coding agent a short bug report and a failing test. The obvious fix makes that test pass but breaks a hidden test, because the project once decided on a rule the obvious fix violates.

Example, task `boltons-discount-001`. The bug report says: "Stacked discounts compute the wrong total. Two 50% discounts on $100 give $0 instead of $25." Compounding the discounts fixes the visible test. The hidden test also encodes a rule settled in a past developer chat that never made it into the code. An agent can only pass it first try if it knows that chat.

Where the rule lives is the benchmark's main axis: 28 tasks keep it in a documented git commit (`history`), 27 in a past developer chat (`conversation`), and 6 in a chat that was later amended by a second chat (`conversation-amended`, only the amended rule is correct).

Each task's memory corpus has about 241 documents and 111,000 tokens: the deciding chat(s) or commit, 140 decoy developer chats about other parts of the library, and the library's last 100 commit messages.

Grading runs pytest in a separate Docker container on a clean copy with only the agent's source patch applied. When a grade fails, the harness feeds the pytest output back to the agent and lets it try again, up to 5 times. A task counts as solved when all tests pass. The useful metric is the number of these **corrections**: 0 means solved first try.

## How the benchmark runs

| Part | What the harness does | What the spike used |
|---|---|---|
| Coding agent | opencode, Claude Code or Codex CLI, each in its own Docker image | opencode 1.16.2 in the harness's image, model `google/gemini-3.8-flash` |
| Grading | `sdebench-base` image: Python 3.11 and pytest 8 | the same image plus two environment variables (see [Infrastructure fixes](#infrastructure-fixes)) |
| Memory, generic path | `provider.retrieve(bug_report, k=10)`; the blocks are joined and appended to the task prompt under "Relevant memory (surfaced for you by your memory system)" (harness arm `provided`) | gbrain, one brain per task, default retrieval settings |
| Memory, plugin path | the comparator runs inside the agent as a plugin that consults its server on every prompt (harness arm for the comparator's coding plugin) | not run (needs the plugin package and server wiring) |
| No memory | full repository with git history; the task's past chats are seeded as opencode sessions the agent may open but is not told about (harness arm `full`) | the same |

The harness's cell runner path (`mpw/cell.py`) supports only `rag`, `agentic-rag`, `agent` and `retrieval`, so `harness:cell` cannot run this benchmark. The spike adds its own launcher instead of changing the cell runner:

- [`eval/runner/coding-spike.ts`](../../../eval/runner/coding-spike.ts) opens a budget run in the shared ledger, starts the same metering proxy `harness:cell` uses (process labels `agent` and `gbrain`), checks out the dataset and host repository at their pins, builds the agent images and starts the driver with only proxy tokens in its environment.
- [`eval/harness-provider/coding-spike/spike.py`](../../../eval/harness-provider/coding-spike/spike.py) ingests each task's corpus into gbrain through the existing provider (`mpw/gbrain_provider.py`) with opaque document and unit ids, retrieves with the bug report, writes the joined context exactly as the harness's `modes/coding.py` does, and runs the harness's own `sdebench/harness/run.py` for each arm. Grading, corrections and the solved flag are the harness's.
- [`coding-spike/Dockerfile.agent`](../../../eval/harness-provider/coding-spike/Dockerfile.agent) and [`Dockerfile.base`](../../../eval/harness-provider/coding-spike/Dockerfile.base) derive the agent and grading images.

### Metering

The agent runs inside Docker and cannot reach the proxy's loopback address. The launcher therefore relays TCP from the Docker bridge gateway to the proxy, and the derived agent image sets opencode's Gemini base URL to that relay. The container receives a proxy token, never a real key, so a call that skipped the proxy would fail upstream and cost nothing. In all paid runs the proxy logged and settled every Gemini and Voyage request and refused none.

| Agent CLI | Base URL override | Status |
|---|---|---|
| opencode (Gemini) | opencode config `provider.google.options.baseURL`, baked into the derived image | metered, run |
| Claude Code | `ANTHROPIC_BASE_URL`; `run.py` passes only `ANTHROPIC_API_KEY` into the container, so the URL must go into a derived image | meterable, not wired, not run |
| Codex CLI | `OPENAI_BASE_URL` or `openai_base_url` in its config; same derived-image need | meterable, not wired, not run |
| The comparator's in-agent plugin | plugin calls go to the comparator server, whose model calls our server launcher already meters; the plugin and its repository-native ingest are not wired | not run, must not run paid until wired |

Unmetered: nothing that costs money ran outside the proxy. The agent container still has open internet access for non-model traffic (opencode's tools include web fetch). That costs nothing but is a leak risk, covered below.

## Results

### Agent runs

Tasks were chosen, before running, as the three where the harness's committed results show the clearest gap between its no-memory opencode arm and its memory arm, one per source type. They are not a sample, so these runs show that the measurement works and points in a plausible direction; they do not estimate an effect size.

Spike 1 used the harness's agent image unchanged. Spike 2 added Python and pytest to the agent image (see [the first finding](#the-harnesss-opencode-image-has-no-python)). Corrections are pytest feedback rounds before all tests passed (0 is first try). Cost is the metered spend for the task run, including gbrain's ingest for the gbrain arm.

| Task (source) | Spike | No memory: corrections | No memory: cost | gbrain: corrections | gbrain: cost |
|---|---|---|---|---|---|
| `boltons-discount-001` (conversation) | 1 | 2 | $0.381 | **0** | $0.217 |
| | 2 | 1 | $0.236 | **0** | $0.122 |
| `boltons-hostallow-history-001` (history) | 1 | 1 | $0.307 | 1 | $0.283 |
| | 2 | **0** | $0.210 | **0** | $0.344 |
| `boltons-dedupe-amended-001` (conversation-amended) | 1 | 2 | $0.534 | **0** | $0.524 |
| | 2 | 2 | $0.575 | **0** | $0.483 |
| **First-try solves** | | **1 of 6** | | **5 of 6** | |

All 12 runs were solved within the 5-correction cap. That matches the harness's committed results, where every arm solves 60 or 61 of 61 tasks, so "solved" is at its ceiling and the comparison has to use first-try solves and mean corrections.

For context only (different model, different prices): in the harness's committed results for opencode on `gemini-3.5-flash`, three seeds per arm, the no-memory arm solved 3 to 5 of 61 tasks first try (mean 1.13 to 1.25 corrections) and the comparator's plugin arm 19 or 20 (mean 0.75 to 0.82). We recomputed these numbers from the committed result files under the harness's `outputs/sdebench/`.

### Retrieval over all 61 tasks

A retrieval-only pass ingested every task's corpus into gbrain and retrieved with the bug report, with no agent run ($0.44 of Voyage embeddings).

| Source | Tasks | Deciding document delivered | Ranked first | Mean delivered context (cl100k tokens) |
|---|---|---|---|---|
| conversation | 27 | 27 | 27 | 5,381 |
| conversation-amended | 6 | 6 (both chats) | 6 | 5,082 |
| history | 28 | 27 | 27 | 5,041 |
| **All** | **61** | **60** | **60** | **5,195** |

The one history task without a hit, `boltons-omdset-001`, has no deciding document in its corpus: its cause lives only in the host repository's own history, which the dataset loader does not ingest. No memory system using the generic path can help on it.

For the 6 amended tasks, gbrain returned the original chat first and the amending chat second. The corpus carries no dates (`Date: unknown` on every block), so the agent has to tell which rule is current from the text; the amending chats say so ("Amendment to the merge rule from last month").

Retrieval is close to its ceiling on this corpus because the decoys discuss unrelated modules. A full run will therefore mostly measure whether the agent uses the memory it is given, and how much context arrives with it, not ranking quality.

## Findings

### The harness's opencode image has no Python

The harness's opencode image (`node:22-slim` plus opencode) has no Python interpreter; its Claude Code and Codex images do. The opencode agent cannot run the failing test it is asked to fix. In spike 1, the agent searched for a Python interpreter in all 6 runs, and 4 of 6 first rounds ended with no edit at all, which the harness then counts as a correction. This handicap is in the harness's committed opencode results too, and it inflates the value of injected memory: an agent that cannot test its guess benefits more from being told the rule. With Python added (spike 2), every first round produced a patch and the no-memory arm solved one task first try. A full run should use the image with Python as its primary setting.

### Infrastructure fixes

- **Root-owned files break grading on Linux.** Both containers run as root and pytest writes `.pyc` files and its cache into the mounted checkout. The harness's next `shutil.rmtree` of that checkout, run as the invoking user, fails with `Permission denied` before grading finishes. On macOS, Docker Desktop maps file ownership, so the harness authors would not have seen this. The derived images set `PYTHONDONTWRITEBYTECODE=1` and `PYTEST_ADDOPTS="-p no:cacheprovider"`.
- **The dataset and host repository are not installed by `harness:setup`.** The tasks live in a git submodule at `sdebench/datasets` (pinned at `afcce15c`), which the harness tarball omits, and every task's `build.py` needs a clone of the host repository fork. The launcher checks both out at their pins.
- **The harness venv cannot locate the tasks.** The harness is installed into the venv as a package, so the dataset loader's repository-relative path points into `site-packages`. The driver points it at the fetched source tree.
- **opencode's title request fails.** opencode asks its small model for a session title with `thinkingLevel: minimal`, which `gemini-3.8-flash` rejects with HTTP 400. The rejection costs nothing and does not affect the task.

### gbrain findings

- **Ingest sends one embedding request per page.** A 241-page task made about 242 Voyage requests, each with a single input, and ingest took 51 to 66 seconds per task even though writing the pages took about 6 seconds. Batching embeddings across the pages of one `put_pages` call would cut this sharply. It does not change results, but it adds about an hour to a 61-task, three-seed run.
- **The provider labels every page a conversation.** `mpw/gbrain_provider.py` renders git commit messages as `type: conversation` pages titled "Conversation d-...". It did not hurt retrieval here, but a commit page type would describe the corpus correctly.

Neither finding required a gbrain change for this spike.

## Cost and time of a full run

Measured over the 12 agent runs: $0.35 per task run on average ($0.12 to $0.58), of which gbrain's ingest is about $0.007. The three tasks were picked from the harder end, so a representative mean is likely a little lower; the harness's committed opencode runs average $0.57 to $0.68 per task at `gemini-3.5-flash` prices, which is about $0.29 to $0.34 at `gemini-3.8-flash` list prices.

| Scope | Task runs | Estimated spend | Wall time |
|---|---|---|---|
| One arm, one seed | 61 | about $21 | about 2 hours sequential |
| No memory, gbrain, comparator (generic path); 3 seeds | 549 | about $190 | about 5 hours at 4 tasks in parallel |
| Same, with a 1.5x margin | 549 | **about $290** | |
| Add one no-memory seed on the unmodified harness image, to link to the committed results | 61 | about $21 | |

The comparator's ingest adds its extraction calls (about 6.8 million input tokens over 61 tasks, a few dollars at its default extraction model). The proxy reserves each agent request at its maximum output (about $0.25), so a run's budget must cover only the requests in flight at once. Adding newer agent models, such as the newest Claude or GPT families through their CLIs, multiplies the agent cost per family; the harness's committed Claude Code runs cost $0.32 to $0.45 per task.

## Build first

1. **Close the agent container's network.** The agent can reach the internet, and the public dataset repository contains every hidden test. Put the agent on an internal Docker network whose only route is the proxy relay, and confirm opencode still starts without its model catalog.
2. **Typed records, resume and parallelism.** The spike driver runs tasks one at a time, keeps no schedule and cannot resume. A full run needs a fixed schedule, a typed outcome per task run (solved, corrections, capped, infrastructure error), resume, 4-way parallelism and one gbrain ingest reused across seeds. Either promote the driver or add a coding mode to the cell runner (`mpw/cell.py`, `mpw/records.py`, `mpw/scorer.py`).
3. **The comparator arm.** Run the comparator through the same generic path with `mpw/comparator_provider.py`, at the same delivered-context target as gbrain (about 5,200 tokens). Running the comparator's own in-agent plugin is a separate arm that needs its plugin package and metered server wiring.
4. **Preregister.** Fix the arms, seeds, agent image (with Python), model and metric before any paid cell: first-try solve rate and mean corrections per source type, with solved reported but not used as the decision metric.

## Reproduce and inspect

From the repository root, with Bun 1.4 or newer and Docker:

```sh
bun install --frozen-lockfile && bun run harness:setup
bun eval/runner/budget-ledger.ts init --budget-ledger .budget/mpw-dev-coding.sqlite --program-cap-usd 25 --reason "coding spike"
git clone https://github.com/garrytan/gbrain ~/gbrain   # code under test: e8e1f66b

# keyless plumbing check (stub upstream, throwaway ledger)
bun eval/runner/coding-spike.ts --tasks boltons-discount-001 --stub-upstream --max-interventions 1 \
  --gbrain ~/gbrain@e8e1f66b8e5225b113cacd18931b627fca451bae

# spike 2 (GEMINI_API_KEY and VOYAGE_API_KEY in the launcher's environment)
bun eval/runner/coding-spike.ts --tasks boltons-discount-001,boltons-hostallow-history-001,boltons-dedupe-amended-001 \
  --arms none,gbrain --agent-python --budget-usd 8 --budget-ledger .budget/mpw-dev-coding.sqlite \
  --gbrain ~/gbrain@e8e1f66b8e5225b113cacd18931b627fca451bae

# retrieval only, all tasks
bun eval/runner/coding-spike.ts --tasks all --arms gbrain --retrieval-only --budget-usd 2 \
  --budget-ledger .budget/mpw-dev-coding.sqlite --gbrain ~/gbrain@e8e1f66b8e5225b113cacd18931b627fca451bae
```

Identities: harness `f618ed7b1f0eb9cad7b42e876f91a42f0eadb150`, dataset submodule `afcce15c1f608242e28e48832c301f39c5aed708`, host repository `979fa9b613fa8c0a455ae16ea6f2ec91c11ecafe`, gbrain `e8e1f66b8e5225b113cacd18931b627fca451bae` (version 0.60.64.0, copied overlay), opencode 1.16.2, embeddings `voyage-4` at 1024 dimensions, gbrain retrieval `token_budget` 8000 with `return_unit: page`. Measured on a Capy cloud VM with 4 vCPUs on 2026-10-05.

Receipts are in [`coding-spike/`](coding-spike/):

- `spike-1-harness-image/` and `spike-2-agent-python/`: resolved settings, the budget run summary (`spend.json`), the proxy request log, and per task and arm the record, the harness's `result.json` and `trace.json` (agent trajectory, patches, pytest output) and, for gbrain, the exact injected context (`context.txt`) and retrieval receipt.
- `retrieval-61/records.jsonl`: one retrieval receipt per task (retrieved documents mapped back to dataset ids, ranks of the deciding documents, delivered tokens). The first retrieval run hit the tool's one-hour limit after 49 tasks and was stopped before writing `spend.json`; its ledger run was closed by hand at $0.353, and the remaining 12 tasks ran separately ($0.086).
- `ledger-status.json`: the ledger after all runs: $4.65 committed of the $25 cap, 4 runs, none open.

Machine paths in the receipts are scrubbed. Agent trajectories that printed the container's environment or git metadata had the comparator's product name and its maker's name replaced with `comparator` and `<dataset-org>`; nothing else was edited.
