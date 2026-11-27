# What a personal agent's memory costs a month, and how soon a saved chat can be found: gbrain v0.60.776.0 and five other systems

- **We learned that a personal agent's memory system makes few paid calls of its own; the bill is the server and the
  answer model.** On a heavy user's month (2,000 messages saved, 300 questions asked), the memory systems' own provider
  calls cost between $0 and $6.49. Renting the smallest cloud server that holds each one costs about $74 a month (AWS
  m7i, on demand) or about $30 (AWS Graviton m7g). The answer model reading what memory hands back costs $6.28 to $29.69
  a month with claude-opus-5-5 and under $1.30 with particle-1. You should pick a memory system by how much text each
  search hands your answer model, and decide separately whether it needs a server of its own.
- **We learned that gbrain at its shipped defaults is fast to search after a save and hands the answer model less to
  read than most systems.** A session saved to gbrain v0.60.776.0 was searchable after 1.2 seconds at the median and 1.7
  seconds at the 95th percentile, and all 210 timed saves were found. Its reads cost claude-opus-5-5 $12.48 a month,
  0.55 times the median of the three memory servers and hybrid search (95% interval 0.52 to 0.57). Its own provider
  calls cost $0.21 a month, almost all of it its search. Writing cost about 0.11 dollars per million tokens **because
  gbrain's shipped defaults store and embed these chat sessions without extracting facts from them**: gbrain skips fact
  extraction on conversation pages, so this cost reflects saving sessions, not building a fact store from them.
- **We learned that cost per correct answer, scored by exact key match, doesn't rank memory systems on this text.** The
  matcher counts an answer as not correct when it names the current value and also an earlier one, and most answers from
  systems that find the history walk through it before answering. With claude-opus-5-5 reading, every memory system
  scored 7% to 13.5% key-matched correct and the no-memory floor scored 9%, and the floor has the lowest cost per correct answer. Read
  the cost columns and the speed columns; read cost per correct answer only beside the accuracy counts below.

Settled call: no cost or speed issue goes to gbrain's maintainers, and README's "How gbrain compares" carries the
cost-and-speed table below as the measured "Dollars per month" and "Write to queryable" figures.

The run measured 23 cells from 2026-11-26 to 2026-11-27 under the
[frozen plan and its three dated amendments](2026-11-24-cost-speed-preregistration.md), on ten public synthetic chat
histories (`bg1-dev-01` to `bg1-dev-10`). gbrain is v0.60.776.0 (`3a360389f152e62ccb627ab96eccfad8a9204e75`), the
newest release on gbrain's master when the run started, at the harness commit `46a975b4`. Every provider call went
through the metering proxy, and every dollar figure below is priced from the providers' own usage fields. None of the
five preregistered decision rules fired, so no gbrain issue follows from this run.

## Results

The heavy profile is 2,000 messages and 300 questions a month with a one-year history; each figure is a 95% interval
from a cluster bootstrap over the ten worlds. "System cost" is the memory system's own provider calls plus its server;
"answer model" is the reader's cost of reading what the system returns; "total" adds them at claude-opus-5-5. Cost per
correct answer divides the total by the key-matched correct answers a month (see [Accuracy](#accuracy-and-what-cost-per-correct-answer-can-say)).
Write to queryable is how long after a save the system's own search returns that session, on an idle system.

| System | System cost a month | Answer model a month, claude-opus-5-5 | Answer model a month, particle-1 | Total a month, claude-opus-5-5 | Cost per correct answer, claude-opus-5-5 | Cost per correct answer, particle-1 | Write to queryable, p50 | Write to queryable, p95 | Build | Measured |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gbrain-defaults | $73.85 ($73.85 to $73.85) | $12.48 ($11.96 to $12.99) | $0.55 ($0.51 to $0.58) | $86.33 ($85.80 to $86.84) | $2.50 ($1.92 to $3.39) | $2.16 ($1.77 to $2.75) | 1.2 s (1.2 s to 1.3 s) | 1.7 s (1.7 s to 1.8 s) | gbrain v0.60.776.0 (3a360389f), shipped defaults | 2026-11-26 |
| ext-extract-first | $80.39 ($80.35 to $80.44) | $6.28 ($6.17 to $6.39) | $0.43 ($0.39 to $0.46) | $86.67 ($86.56 to $86.78) | $3.85 ($3.21 to $4.82) | $3.37 ($2.69 to $4.49) | 2.1 min (1.9 min to 2.3 min) | 8.7 min (5.8 min to more than 10 minutes) | bundle lock 9777b7a8, recipe | 2026-11-26 to 2026-11-27 |
| ext-memory-bank | $74.56 ($74.50 to $74.61) | $19.86 ($19.67 to $20.03) | $0.95 ($0.93 to $0.97) | $94.42 ($94.23 to $94.60) | $4.50 ($3.70 to $5.72) | $2.80 ($2.29 to $3.59) | 17.8 s (16.9 s to 18.8 s) | 24.4 s (21.2 s to 26.3 s) | bundle lock f54d89df, recipe, observations on | 2026-11-26 to 2026-11-27 |
| ext-verbatim-session | $73.59 ($73.59 to $73.59) | $29.69 ($28.02 to $31.14) | $1.23 ($1.15 to $1.31) | $103 ($102 to $105) | $2.99 ($2.22 to $4.36) | $2.77 ($1.92 to $4.99) | 462 ms (439 ms to 477 ms) | more than 10 minutes (more than 10 minutes to more than 10 minutes) | bundle lock e2e066bf, recipe | 2026-11-26 |
| baseline-hybrid | $73.60 ($73.60 to $73.60) | $25.68 ($25.05 to $26.27) | $1.08 ($1.05 to $1.10) | $99.28 ($98.64 to $99.87) | $2.45 ($1.83 to $3.67) | $1.91 ($1.42 to $2.77) | 476 ms (466 ms to 486 ms) | 604 ms (557 ms to 650 ms) | gbrain-evals 46a975b4 | 2026-11-26 |
| baseline-file-agent | $73.58 ($73.58 to $73.58) | $7.08 ($6.59 to $7.52) | $1.27 ($1.19 to $1.36) | $80.67 ($80.17 to $81.10) | $3.59 ($2.99 to $4.48) | $2.94 ($2.38 to $3.84) | 33 ms (30 ms to 36 ms) | 56 ms (53 ms to 61 ms) | gbrain-evals 46a975b4, uncapped grep, 40 turns | 2026-11-26 |
| baseline-none | $0 ($0 to $0) | $1.52 ($1.49 to $1.54) | $0.057 ($0.056 to $0.058) | $1.52 ($1.49 to $1.54) | $0.056 ($0.05 to $0.067) | $0.0095 (interval not defined) | not measured | not measured | gbrain-evals 46a975b4 | 2026-11-26 |
| baseline-full-context | $0 | doesn't fit | doesn't fit | doesn't fit | doesn't fit | doesn't fit | no write | no write | gbrain-evals 46a975b4, prompt caching | 2026-11-26 |
| ext-temporal-graph | not run: its pinned configuration calls a reranker and an ingest model its provider retired, and a compared system's settings are never changed |  |  |  |  |  |  |  | bundle lock 4ce9b216 |  |
| ext-graph-pipeline | not run: left out of this experiment's scope; its published limit was measured at BEAM-10M scale, so a run at this size is follow-up work |  |  |  |  |  |  |  | bundle lock 59af44d5 |  |
| ext-markdown-kb | not run: left out of this experiment's scope; its published limit was measured at BEAM-10M scale, so a run at this size is follow-up work |  |  |  |  |  |  |  | bundle lock e1a14a19 |  |
| ext-agent-runtime | not run: it has no passive write and search interface: its agent edits its own memory, so a per-write cost and a write-to-queryable time aren't defined the same way |  |  |  |  |  |  |  | bundle capabilities d55c28c9 |  |

gbrain's system cost is almost all server: its own calls are $0.21 a month ($0.0086 writing and embedding, $0.20 its own
search's query embeddings and reranking, $0 idle), and **that low write cost reflects storing and embedding sessions
without extracting facts from them**, which is what gbrain ships for conversation pages. Its daily upkeep ran through its
trigger in each two-hour idle window and made no provider call.

### Without a rented server

gbrain or the file agent run on a laptop have no server bill, so every total is also shown without hosting. Per month,
heavy profile, point estimates (intervals are in [`load-primary.json`](2026-11-24-cost-speed/load-primary.json)):

| System | Write and background | Own reads | Idle | Hosting | System cost without hosting | Answer model, claude-opus-5-5 | Answer model, particle-1 | Total without hosting, claude-opus-5-5 | Total without hosting, particle-1 | Hosting instance |
|---|---|---|---|---|---|---|---|---|---|---|
| gbrain-defaults | $0.0086 | $0.204 | $0 | $73.64 | $0.212 | $12.48 | $0.549 | $12.70 | $0.762 | m7i.large |
| ext-extract-first | $6.49 | $0.0001 | $0 | $73.90 | $6.49 | $6.28 | $0.426 | $12.77 | $6.91 | m7i.large |
| ext-memory-bank | $0.927 | $0 | $0 | $73.63 | $0.927 | $19.86 | $0.948 | $20.79 | $1.88 | m7i.large |
| ext-verbatim-session | $0 | $0 | $0 | $73.59 | $0 | $29.69 | $1.23 | $29.69 | $1.23 | m7i.large |
| baseline-hybrid | $0.011 | $0.0005 | $0 | $73.58 | $0.012 | $25.68 | $1.08 | $25.70 | $1.09 | m7i.large |
| baseline-file-agent | $0 | $0 | $0 | $73.58 | $0 | $7.08 | $1.27 | $7.08 | $1.27 | m7i.large |
| baseline-none | $0 | $0 | $0 | $0 | $0 | $1.52 | $0.057 | $1.52 | $0.057 | none |

Without hosting, the answer model is the largest line for every system except extract-first, whose background
extraction ($6.49 a month) costs about as much as claude-opus-5-5 reading its results ($6.28).

### Comparisons the plan fixed in advance

Each ratio is gbrain's figure over the other system's, from paired world means, with a paired bootstrap interval, at the
heavy profile with claude-opus-5-5 reading.

| Rule | Result | Fired? |
|---|---|---|
| 1. gbrain's system cost is at least 1.25 times the cheapest server's | 1.004 times verbatim-session's (95% interval 1.004 to 1.004), the cheapest server in every resample. Without hosting the ratio isn't defined, because verbatim-session makes no provider calls; gbrain costs $0.21 a month more (0.21 to 0.21). gbrain's largest line is hosting. | no |
| 2. gbrain's answer-model cost per question is at least 1.5 times the median of the three servers and hybrid search | 0.55 times ($0.042 against $0.076 a question; 95% interval 0.52 to 0.57). The answer model's read is not gbrain's largest line; hosting is. | no |
| 3. gbrain's write-to-queryable p50 above 60 seconds, p95 above 5 minutes, or more than 5% of probes missed | p50 1.2 s, p95 1.7 s, 0 of 210 missed | no |
| 4. Every server's system share of its total under 10% (upper end) | the servers' shares are 0.71 to 0.93, because the server bill is in every system cost | no |
| 5. A compared system's total is at least 1.25 times gbrain's | memory-bank 1.09 (1.09 to 1.10), verbatim-session 1.20 (1.18 to 1.21), hybrid search 1.15 (1.14 to 1.16), extract-first 1.004 (0.998 to 1.010), the file agent 0.93 (0.93 to 0.94). Without hosting: 1.64, 2.34, 2.02, 1.01 (0.97 to 1.05) and 0.56. | no |

So gbrain's month at claude-opus-5-5 costs less than memory-bank's, verbatim-session's and hybrid search's, can't be
told apart from extract-first's, and costs more than the file agent's, whose reads cost claude-opus-5-5 $7.08 a month
against gbrain's $12.48.

### Write to queryable

A probe saves one held-back session to an idle system, then searches once a second with a passage from it until a result
names that session or 10 minutes pass. This is **source-attributed session retrieval**: a result counts only when it
carries the session's id, and a keyword match can find a session before any background extraction finishes.

| System | Counted probes | Found | Missed, found later | Missed, never found | p50 (95% interval) | p95 (95% interval) | During the bulk import: found, p50 |
|---|---:|---:|---:|---:|---|---|---|
| gbrain-defaults | 210 | 210 | 0 | 0 | 1.2 s (1.2 to 1.3) | 1.7 s (1.7 to 1.8) | 200 of 200, 0.98 s |
| ext-extract-first | 207 | 198 | 3 | 6 | 2.1 min (1.9 to 2.3) | 8.7 min (5.8 min to more than 10) | 2 of 200 |
| ext-memory-bank | 210 | 206 | 0 | 4 | 17.8 s (16.9 to 18.8) | 24.4 s (21.2 to 26.3) | 200 of 200, 15.5 s |
| ext-verbatim-session | 210 | 172 | 0 | 38 | 0.46 s (0.44 to 0.48) | more than 10 minutes | 187 of 200, 0.67 s |
| baseline-hybrid | 210 | 210 | 0 | 0 | 0.48 s (0.47 to 0.49) | 0.60 s (0.56 to 0.65) | 200 of 200, 3.3 s |
| baseline-file-agent | 210 | 210 | 0 | 0 | 33 ms (30 to 36) | 56 ms (53 to 61) | 200 of 200, 0.18 s |

- Verbatim-session either finds a session at once or not at all: its 38 misses are spread over all ten worlds, each
  polled about 500 times with no errors, and none was found after the system was idle again: its search with the
  probe's passage didn't return that session.
- Extract-first queues extraction behind each write. During the bulk import it found 2 of 200 sampled sessions, and in the
  two worlds checked its backlog took about 16 hours to drain after the last write. 3 of its 210 probes started before it was
  idle and are left out, as the plan says.
- Memory-bank returned 40,814 results with no session id during its probes: its consolidated observations carry none, so
  they can't count as finding a session, though their cost is counted.
- "Idle" before each probe means the system's metered provider traffic was quiet for 60 seconds. The harness asked no
  system for its own count of pending work, so work that makes no provider call (local indexing, for example) could
  still be running when a probe started. This can only slow a probe down or make it miss, never speed it up. The same
  quiet check runs before a missed probe's last search and gives up after 20 minutes, and the records don't say which
  of the two ended it, so a miss counted as never found (extract-first's 6, memory-bank's 4) could be one whose
  background work was still going.
- The file agent's write is a Markdown file and its poll is a grep with no model call, so its times are file-system
  times.
- The no-memory floor saves nothing and full context has no write, so neither is probed.

### Accuracy, and what cost per correct answer can say

Each answer is scored against the question's answer key by the changing-facts battleground's deterministic matcher: it
is correct when it names an accepted current value and no other tracked value. An answer that names the current value
and an earlier one is **unclear** and counts as not correct. The readers used the changing-facts confirmation's settings,
which ask for the dated history before the answer, so a reader that is given the history usually names earlier values
on the way. That is why most answers from systems that find the history are unclear, and why the floor, which finds
nothing and so names nothing earlier, has the lowest cost per correct answer.

The last two columns are not preregistered and are a looser count, not a bound on what a judge would accept: they
divide the total by answers that were correct or unclear. An unclear answer can still end on the wrong value, and the
changing-facts confirmation's judges accepted many answers this matcher calls stale, which neither count includes. No
judge ran here.

| System | Key-matched correct, claude-opus-5-5 | Unclear, claude-opus-5-5 | Key-matched correct, particle-1 | Unclear, particle-1 | Cost per correct-or-unclear answer, claude-opus-5-5 | Same, particle-1 |
|---|---|---|---|---|---|---|
| gbrain-defaults | 23 of 200 | 141 | 23 of 200 | 127 | $0.351 | $0.331 |
| ext-extract-first | 15 of 200 | 175 | 16 of 200 | 172 | $0.304 | $0.287 |
| ext-memory-bank | 14 of 200 | 175 | 18 of 200 | 165 | $0.333 | $0.275 |
| ext-verbatim-session | 23 of 200 | 16 | 18 of 200 | 11 | $1.77 | $1.72 |
| baseline-hybrid | 27 of 200 | 66 | 26 of 200 | 58 | $0.712 | $0.593 |
| baseline-file-agent | 15 of 200 | 169 | 17 of 200 | 177 | $0.292 | $0.257 |
| baseline-none | 18 of 200 | 0 | 4 of 200 | 0 | $0.056 | $0.0095 |

Full context isn't in the table: at the heavy profile the one-year history (about 968,000 tokens) doesn't fit either
reader's input limit. At the light profile (215 messages and 32 questions a month, a one-year history of about 104,000
tokens) it costs $28.24 to $29.63 a month with claude-opus-5-5 (warm cache to cold) and $1.02 to $1.07 with particle-1,
which read from its cache but reported no cache writes, so each cache fill is priced at its uncached rate; it had 14
key-matched correct and 176 unclear answers of 200 with claude-opus-5-5, and 31 and 153 with particle-1. At the light profile a rented server costs more than any
system's provider calls and reading combined, so full context costs less a month than any system on a rented server and
more than any system run without one (the light table is in
[`table-primary-light.md`](2026-11-24-cost-speed/table-primary-light.md)).

### History growth

The plan flags a system whose writing and background cost per million tokens in the bulk import's last quarter of
sessions is over 1.25 times its first quarter's, as a sign a year-old history would cost more than this month shows.
gbrain (9.8 times), memory-bank (8.1) and extract-first (9,258) are flagged. The rule takes the lines that arrive in each
quarter's time window, and the last window runs until the import's background work ends, so it also holds work that runs
once after the final write. A check after the run, not preregistered, ended the last window when the last write returned
(each other window runs from its quarter's first write to the next quarter's first, over all ten worlds). In those
windows memory-bank's write and background cost per million tokens was 4.27, 4.13, 4.13 and 4.41 dollars by quarter,
and gbrain's 0.033, 0.042, 0.034 and 0.042; memory-bank's consolidation ran for about an hour after the last write in
the two worlds checked, gbrain's background embedding step ran at the end of the import, and extract-first made almost
no calls while the sessions were written and nearly all of them afterwards. So these flags show background work timed at the end of an import, and the run measured no growth in
cost per write as the history grew. That background work is in every monthly cost above.

### Server size

Every stack that holds memory fit the smallest instance on each price ladder: m7i.large (8 GiB) on the primary ladder
and m7g.medium (4 GiB) on the Graviton sensitivity ladder, with memory at 1.5 times each stack's steady peak (memory-bank
the largest, at 2.6 GiB needed). Storage for a one-year history adds at most $0.32 a month (extract-first, 4.0 GB). On
the Graviton ladder each total drops by about $43.80 a month and the order of the systems doesn't change; that table is
in [`table-sensitivity-heavy.md`](2026-11-24-cost-speed/table-sensitivity-heavy.md).

## What the result changes

- README's "How gbrain compares" gains the cost-and-speed table above, with every row's build and measurement date, and
  its October scoreboard block points its two "not measured" columns at it.
- README names hosting as gbrain's largest cost line (rule 2) and states its write-to-queryable p50 and p95 (rule 3).
- No issue goes to gbrain's maintainers: no rule fired.
- gbrain's low write cost is a fact about what it doesn't do on chat sessions by default. A comparison of the cost of
  building a fact store would run gbrain's `extract-conversation-facts`, which a shipped install doesn't run on its own;
  that is a separate question and this run doesn't answer it.

## Deviations from the plan

- **File-agent cells.** Both file-agent cells finished with exit code 0, 100 of 100 answers per reader and a settled
  spend lease, but the launcher marked them failed: its checkpoint watcher listed a file the running cell had just
  deleted and stopped on the missing file. The plan's completion rule is about the cell, not the launcher, so both count.
  The watcher now skips files a running cell deletes (`attemptRows` in `eval/runner/shootout-cell.ts`, with a test).
- **Memory-bank, first world, first attempt.** The cell stopped during setup when its container image couldn't be found
  by digest, before any provider call, and was closed with no spend; its second attempt is the counted one.
- **One hosting sample.** 1 of memory-bank's 283 hosting samples failed (Docker couldn't read an image's disk usage);
  the other 282 set its server size.
- **The smallest detectable differences weren't simulated before the freeze.** The plan asked for a simulation from the
  pilot's records, with more worlds if it showed a larger difference than stated (1.10 times for monthly cost, 1.5
  times for write-to-queryable p50). It wasn't run. The counted intervals are narrower than both: monthly-cost ratios
  resolve to within about 1% with hosting and 5% without, and every p50 interval is within about 10% of its estimate.
- **Loader corrections after the run, before any number was published.** The plan says the no-memory floor's system
  cost is zero by construction; the loader had priced its harness process as a server, and now gives it none (a test
  holds this). The loader no longer asks the floor for ingest data it never writes, takes the not-run rows' reasons from
  the rows file, and lists systems in the plan's order. No other system's numbers changed.
- **How the campaign ran.** The scoreboard's launcher refuses a campaign on a dataset outside its public list without a
  custody receipt, so the cells ran through the shootout cell runner directly, one Ubicloud VM per cell, as the pilot
  did.
- **Spend reconciliation.** Spend was reconciled from the per-call usage fields the metering proxy recorded, not from the
  providers' account balances. Every billed dollar was attributed to a world and phase except $0.00003 of gbrain's slot.

## Systems and builds

| Row | Build | What it calls |
|---|---|---|
| `gbrain-defaults` | gbrain v0.60.776.0 (`3a360389f`), shipped defaults, starter MCP surface, idle upkeep as shipped | Voyage `voyage-4` embeddings on write; on read, a query embedding and `rerank-3-lite`; no fact extraction on these sessions |
| `ext-extract-first` | bundle lock `9777b7a8`, recipe | `gpt-5-mini` extraction and update after every write; `text-embedding-3-small` |
| `ext-memory-bank` | bundle lock `f54d89df`, recipe, observations on as the server ships them | `gpt-4o-mini` extraction on write and consolidation in the background (its shipped default); local embedder and reranker |
| `ext-verbatim-session` | bundle lock `e2e066bf`, recipe | nothing: a local embedder indexes each session inside the write |
| `baseline-hybrid` | this repository at `46a975b4` | `text-embedding-3-large` at 1,536 dimensions |
| `baseline-file-agent` | this repository at `46a975b4`, uncapped grep, 40 turns | nothing on write; the reader runs the agent |
| `baseline-none` | this repository at `46a975b4` | nothing |
| `baseline-full-context` | this repository at `46a975b4`, prompt caching | nothing; each reader reads each world whole |

Not run: `ext-temporal-graph` (its pinned configuration calls a reranker and an ingest model its provider retired, and
a compared system's settings are never changed), `ext-graph-pipeline` and `ext-markdown-kb` (left out of scope;
their published limits were measured at BEAM-10M scale, so a run at this size is follow-up work) and
`ext-agent-runtime` (no passive write and search interface).

## Reproduce the numbers

Every number on this page comes from the files in [`2026-11-24-cost-speed/`](2026-11-24-cost-speed/). `records.tar.gz`
holds every cell's answers, writes, probes, idle windows, hosting samples and metered usage lines; the retrieved evidence
and lease databases are left out for size. To rebuild `load-primary.json` and the table with no provider call:

```bash
mkdir -p /tmp/cs1 && tar -xzf docs/benchmarks/2026-11-24-cost-speed/records.tar.gz -C /tmp/cs1
GBRAIN_EVALS_BG1_WORLD_END=2026-11-22 bun eval/runner/cs1-load.ts \
  $(for d in /tmp/cs1/*/*/; do d=${d%/}; [ -f $d/usage.ndjson ] && [ -d $d/runs ] && echo --unit $d:$d/usage.ndjson; done) \
  --out /tmp/cs1/load-primary.json --ladder primary \
  --rows docs/benchmarks/2026-11-24-cost-speed/rows.json --table /tmp/cs1/table.md --profile heavy
```

The loader's sum-back check: attributed plus unattributed dollars equal the billed dollars to within $0.000001, and
$0.00003 is unattributed.

## Disclosures

gbrain is Garry Tan's own project.

Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.

Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator.
Garry Tan runs Y Combinator.
