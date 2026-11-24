# Cost and write-to-queryable time for a personal agent: preregistration

Written on 2026-11-24 for GST-3680, the first of two pull requests (R77: this preregistration, then one results pull
request). Nothing in this experiment has run except one keyless check of gbrain's write and read path (below). This
file is frozen by its merge commit. Any later change is a dated amendment under "Amendments", committed on the results
branch before the cells it governs.

README's "How gbrain compares" table has two columns that read "not measured" for every system: "Dollars per month,
personal agent" and "Write to queryable, p50". The Q1 scoreboard preregistered both
([scoreboard preregistration](2026-10-06-scoreboard-preregistration.md), "Cost and speed") and never measured them;
F6 left them out by name. This experiment measures both, for gbrain's shipped defaults and for every compared system in
that table that can still run, on one public workload, and fills a cost-and-speed table in which every row names its
build. Beside each monthly cost it reports the cost per correct answer, so a cheap system that answers badly doesn't
read as a bargain.

## The question

For a personal agent that saves its chats to memory and looks things up in it, what does each memory system cost per
month, counting its own model and embedding calls, the machine it runs on and its storage, and the answer model's
reading? What does each correct answer cost? And after the agent saves something, how long until a search finds it?

## The public lesson

Someone choosing a memory system for their agent sees accuracy tables everywhere and almost never a bill or a delay.
Three things make the bill differ between systems, and none of them shows up in an accuracy number:

- **Model calls on every write.** An extract-first server calls a language model on every write to pull out and update
  facts. A memory-bank server extracts on write and consolidates in the background. gbrain embeds every page on write
  and extracts facts from conversations in a background job. A verbatim store and plain hybrid search call no language
  model on write at all. So the write side of the bill can differ by orders of magnitude.
- **How much each read hands the answer model.** gbrain's shipped read hands the answer model whole conversations, up
  to 24,000 tokens; an extract-first server hands it a short list of facts. The answer model is usually the most
  expensive model in the stack, so a system that writes cheaply but reads generously can still cost more per month.
- **Background work and its delay.** A system that does its expensive work after the write returns makes the write feel
  instant, but a search right after it may miss what was just saved. The write-to-queryable time measures that delay
  directly: write a fact, then poll until a search returns it.

The lesson we expect to publish is which of these dominates the monthly bill for a typical personal agent, what a
correct answer costs in each system, and whether a fact saved by gbrain is searchable as soon as an agent would ask for
it.

## What the result decides

Each outcome changes something (R97). "System cost" below is a system's own provider calls plus its hosting, without
the answer model; "total" adds the answer model's reading at the profile's reader. Each comparison is fixed here:

- **The compared memory servers** are extract-first, memory-bank and verbatim-session. **The compared systems** are
  those three plus hybrid search and the file agent.
- A ratio is gbrain's figure over the comparator's, from paired world means, with a 95% interval from the paired cluster
  bootstrap over worlds (Statistics). "The cheapest server" is the server with the lowest world-mean system cost,
  chosen again inside each bootstrap resample, so the interval carries the choice.
- Hosting is part of system cost in every rule, held fixed outside the resample (Measures); each ratio is also reported
  without hosting where it is defined. Verbatim-session makes no provider calls, so without hosting its system cost is
  zero and a ratio over it has no value; that sensitivity row reports gbrain's gap in dollars a month over the cheapest
  server instead, with its paired interval, and marks the ratio "not defined".

1. **gbrain's monthly system cost is at least 1.25 times the cheapest server's**, the interval's lower end above 1.25:
   gbrain's largest cost line, by phase (write, background, read, idle, hosting) and model, goes to gbrain's
   maintainers as an issue with the aggregates, and README's cost paragraph names that line. Otherwise no issue is filed
   on cost.
2. **gbrain's answer-model cost per question, at its shipped read with claude-opus-5-5 reading, is at least 1.5 times
   the median over the four other passive systems** (the three servers and hybrid search), the interval's lower end
   above 1.5: gbrain's maintainers get an issue proposing a smaller default delivery for remote agents, with its cost
   per correct answer beside the 8,000-token rows in [settings by workload](../settings.md). README says the shipped
   read is the largest part of gbrain's bill only if gbrain's own per-phase split also shows the answer model's read
   above each of gbrain's write, background, idle and hosting lines (paired world means); otherwise README names the
   line that is largest. **Expected in advance:** the scoreboard's measured default
   delivery (`vendor_default_tokens` in `eval/runner/q1/cells/definitions.ts`: gbrain 23,800 tokens against 1,200 to
   10,400 for the others) predicts this rule fires. The experiment measures its size on this workload and whether cost
   per correct answer still favours gbrain.
3. **gbrain's write-to-queryable p50 is above 60 seconds, its p95 above 5 minutes, or more than 5% of its counted
   probes miss the 10-minute horizon:** gbrain's maintainers get an issue with the probe records and gbrain's own logs from
   the probe windows. The probe records alone can't show which stage a probe waited on (the write, the keyword index,
   or embeddings and background extraction), so the issue names a stage only where gbrain's logs show it, and says
   "stage not identified" otherwise. The 5-minute p95 is the
   write-to-findable bar gbrain's own improvement plan set (item E-C in the 10x memory plan). Otherwise README states
   the number and no issue is filed. Only the counted probes (written to an idle system) feed this rule; the
   bulk-import probes never do.
4. **The upper end of the interval for every compared server's system share of its total, at claude-opus-5-5, is under
   10%:** README says plainly that the answer model, not the memory system, sets a personal agent's bill, and points
   at cost per correct answer as the number to choose by, with the particle-1 rows showing what a low-cost answer model
   changes.
5. **A compared system's total is at least 1.25 times gbrain's**, the interval's lower end above 1.25: README states
   the gap with its interval. No gbrain change follows.
6. **In every case** README's "How gbrain compares" gains the cost-and-speed table, every row naming its build and the
   measurement date, with cost per correct answer beside each monthly cost, and the results page carries the per-phase
   split for each system. The October scoreboard block is left as rendered (below, "README").

## Workload profile

A personal agent here is one person's assistant that saves its chats to memory and searches memory when it needs
something it was told before.

| Quantity | Value | Basis |
|---|---|---|
| Messages written to memory | 2,000 a month (about 67 a day) | the Q1 scoreboard's preregistered personal workload, kept so the two experiments price the same agent |
| Memory reads (questions) | 300 a month (10 a day) | the same |
| Message length | 40.3 cl100k tokens, the measured mean of the ten worlds below (about 80,700 tokens a month) | the workload's own text, so write cost per token is priced on the text that was written |
| How messages are saved | one save per chat session, as the harness writes them (the worlds average 29.1 messages a session) | what the harness measures; see the caveat below |
| History when the month is priced | one year at this rate: 24,000 messages | a year-old assistant; storage and the full-context check use it |
| Answer model (reader) | claude-opus-5-5 | the primary frontier model; particle-1 is priced beside it as the low-cost reader |

The public anchor: OpenAI reported about 2.5 billion ChatGPT messages a day in July 2025 across about 700 million
weekly users ([OpenAI, "How people are using ChatGPT"](https://openai.com/index/how-people-are-using-chatgpt/);
[NBER working paper 34255](https://www.nber.org/papers/w34255)). That is about 3.6 user messages a day per weekly
user, or about 7 a day counting the assistant's replies: roughly 215 a month. This profile is about nine times that
average, a person who uses their assistant every day and whose agent also saves notes. Because every unit cost is
measured per token and per question, the results also price a **light profile** at the public average (215 messages
and 32 questions a month, the same read-to-write ratio). Neither profile comes from any real person's usage.

**Per-session saves.** Write cost is measured per ingested token with one save per session. An agent that saves every
message separately makes about 29 times as many write calls, which costs more for a system that calls a model once per
write (the extract-first server) and about the same for one that prices by token. The results report write cost per
save and per token, and label the per-token projection a lower bound for per-message savers.

## Workload data

Ten public synthetic chat histories: worlds `bg1-dev-01` to `bg1-dev-10` of
[`eval/data/changing-facts-v1/dev/worlds`](../../eval/data/changing-facts-v1/dev/worlds), rendered from the changing-facts
generator's plans. Each is one fictional person's chats with an assistant over 545 days: 142 to 158 sessions, 4,461 to
4,503 messages (mean 4,480) and 178,203 to 182,251 cl100k tokens (mean 180,720, counted with gbrain's own cl100k
counter at the pin), with 64 questions about facts that change over time, each
keyed with its accepted answers and its earlier, superseded values. They are public, already used by the
changing-facts battleground's development runs, and contain no real person's data. No world, question or label is
changed for this experiment.

Each world is written to each system session by session in time order, the way an agent saves its chats. Twenty
questions per world, the same seeded sample for every system and reader, are the reads.

## Systems

Every system runs behind the comparison harness's [shim protocol](../../eval/systems/PROTOCOL.md) or in process as the
Q1 scoreboard ran it, with every provider call sent through the metering proxy. Each runs as its vendor ships it: the
vendor's own default (`recipe`), never the harness's matched `common` configuration, and with any background work the
product runs by default switched on.

| Row | Build | What it calls | Runs |
|---|---|---|---|
| `gbrain-defaults` | gbrain's newest release at launch; v0.60.769.0 (`38831bb6`) at registration, shipped defaults, starter MCP surface, idle upkeep left on as shipped | Voyage embeddings on write; Claude Haiku 5.5 fact extraction in a background job; on read, Voyage query embedding and reranking | yes |
| `ext-extract-first` | its pinned bundle (lock `9777b7a8`), recipe | gpt-5-mini extraction and update on every write; text-embedding-3-small | yes |
| `ext-memory-bank` | its pinned bundle (lock `f54d89df`), recipe, with observations (its background consolidation) on as the server ships them | gpt-4o-mini extraction on write and consolidation in the background; local embedder and reranker | yes |
| `ext-verbatim-session` | its pinned bundle (lock `e2e066bf`), recipe | nothing: a local embedder indexes each session inside the write | yes |
| `baseline-hybrid` | this repository's plain Postgres full-text plus pgvector search | text-embedding-3-large at 1,536 dimensions, one call per session and per question | yes |
| `baseline-file-agent` | this repository's list, grep and read agent, uncapped grep, 40 turns | nothing on write: the write is a Markdown file | yes |
| `baseline-none` | the question alone | nothing | priced: system cost is zero by construction, reader cost measured |
| `baseline-full-context` | the whole history in the prompt, with prompt caching | nothing | priced from measured whole-world reads: each reader reads each world whole, and its cached, cache-write and uncached input dollars per token are scaled to each profile's one-year history (light: 2,580 messages, about 104,000 tokens of text; heavy: 24,000 messages, about 968,000). The harness renders each profile's one-year prompt the way it renders a whole world and checks it against each reader's input limit (`checkFit` in `eval/runner/systems/baselines.ts`); a profile and reader whose prompt doesn't fit is reported as "doesn't fit", not priced. The measured reads ask consecutive questions of a fixed world, so they hit the cache more often than an agent whose history grows each day and whose ten daily questions are spread across the day. The monthly cost is therefore shown as a range: a warm bound, where the history is written to the cache once a day and the day's other questions read it from cache, and a cold bound, where every question writes the history to the cache again |
| `ext-temporal-graph` | | | not run: its pinned configuration calls a reranker and an ingest model its provider retired, and a compared system's settings are never changed (the scoreboard's ruling of 2026-10-26) |
| `ext-graph-pipeline`, `ext-markdown-kb` | | | not run in this experiment: left out of its scope. Their published "not run" reasons (a 32 GiB graph-store limit, reindex time that grows with the square of the chunk count) were measured at BEAM-10M scale, so a run at this workload's size may be possible; it is listed as follow-up work, not claimed impossible |
| `ext-agent-runtime` | | | not run: it has no passive write and search interface; its agent edits its own memory, so a per-write cost and a write-to-queryable time aren't defined the same way |

**Shipped-behaviour audit.** The memory-bank shim the scoreboard used creates each bank with observations off, so it
ran retain only. This experiment runs it with the server's default, observations on. Observations carry no source id,
so a probe or a question can't attribute them; their cost is still counted. Before the freeze, the harness compares
every compared system's shim with its shipped defaults and lists each remaining difference, with its reason, in the
freeze amendment and on the results page. If memory-bank's shipped configuration can't run in the harness, its row is
labelled "retain only", with the reason.

gbrain's build follows [CLAUDE.md, "Choose the gbrain build"](../../CLAUDE.md#choose-the-gbrain-build): if a newer
release lands on master before the first counted gbrain cell, a dated amendment re-pins before that cell, and the build
freezes once counted gbrain cells start. The external systems keep the locks above; the results name each lock.

## Readers and the answer key

claude-opus-5-5 and particle-1 read every system's evidence for the twenty questions per world, as the Q1 harness
reads it: the system's shipped read (`vendor-default`), at each system's own default amount of evidence, with the reader
settings the changing-facts confirmation used. The file agent is its own reader: each reader runs the agent.

Each answer is scored against the question's key with the changing-facts battleground's deterministic matcher
(`eval/runner/bg1/match.ts`): correct when it states an accepted answer and no other tracked value. An answer that
states both an old and a new value (`unclear`) counts as not correct and is counted separately. No model judges, so
R78's agreement check doesn't apply; the battleground reports this matcher's agreement with its model judges. The
key-matched accuracy is published only as the denominator of cost per correct answer, labelled "key-matched", and is
not comparable with the battleground's judged numbers.

GPT-6.2 Sol is not run. This is not a model comparison, and no claim here needs a second frontier reader. A Sol figure
derived from the published token counts would leave out its own output and reasoning tokens, so none is published.

## Measures

**Provider dollars.** Every provider call a system or reader makes goes through the metering proxy, which records the
provider's own usage fields per call (input, cached input, cache writes and output tokens, embedding tokens, rerank
units) and prices them from `eval/runner/budget-ledger.ts`. Each call is attributed to one phase: write (during a
session's write), background (after the last write returns until the system reports ready, plus unattributed work that
arrives later), read (a system's own calls while answering a question), probe (every search a write-to-queryable probe
makes), idle (the idle window below) and reader. Probe searches are kept out of write, background and read, so polling
never inflates a system's bill; a keyless test holds that. `eval/runner/cost-speed.ts` computes the unit costs from
those lines; no dollar figure is modelled where a usage field exists.

**Idle.** Some systems spend while nobody is using them: gbrain's idle upkeep runs after a 10-minute quiet tick, and a
memory-bank server consolidates in the background. Before the freeze, the harness lists each system's scheduled
background jobs and their shipped cadence, including whether gbrain's documented install starts its autopilot daemon
and what that daemon's cycles call. On two worlds per system, the stack then stays up with no traffic for one full
cycle of its longest scheduled job, at least 30 minutes and at most 2 hours. Idle dollars per month are each job's
measured cost per run times its shipped runs per month. A job whose cadence is longer than 2 hours is run once through
the vendor's documented trigger, if it has one, and priced per run; otherwise it is listed as not priced.

**Hosting.** Each system's whole stack (its containers, or the harness process for in-process baselines) is sampled for
resident memory and disk bytes after ingest drains, through the probes, the questions and the idle window; the bulk
import's burst is left out. Hosting per month is the on-demand price of the smallest instance in one named public
cloud's general-purpose family whose memory holds 1.5 times that steady peak, for 730 hours, plus block storage for the
disk bytes projected linearly to the one-year history at that provider's per-GB-month price. The provider, a second
instance family for a sensitivity row, the prices and the date they were read are fixed in the freeze amendment from
the providers' public price pages. Hosting comes from a price ladder, so it is the same in most worlds; it is held fixed
outside the bootstrap rather than resampled. gbrain or the file agent run on a laptop have no hosting bill, so hosting
is its own column, and every total is also shown without it.

**Monthly cost.** For each system, world and reader:

- write and background: provider dollars per million ingested tokens, times the profile's tokens a month;
- read: the system's own provider dollars per question, times the profile's questions a month (300);
- idle: as above;
- hosting: as above;
- reader: the reader's provider dollars per question, times the profile's questions a month (300).

The system cost is the first four lines; the total adds the reader. Each is reported per world and summarised across
worlds. The light profile uses the same unit costs at its own volumes: 215 messages (about 8,700 tokens) and 32
questions a month.

**Cost per correct answer.** For each system and reader, the profile's monthly total divided by the correct answers
it would give in that month: the profile's own questions a month (300, or 32 for the light profile) times its
key-matched accuracy. It is reported for both profiles, with the accuracy beside it. A system and reader with no
key-matched correct answer get "no correct answers" in place of a cost per correct answer, and an interval is reported
only when every bootstrap resample has at least one correct answer; otherwise the row gives the point estimate and
says the interval is not defined.

**History growth.** Some systems compare each write with what they already hold, so a write can cost more as memory
grows. For each system the results report write-and-background dollars per million tokens over each world's last
quarter of sessions against its first quarter. A ratio above 1.25 is reported beside the monthly cost as a sign the
projection understates a year-old history.

**Write to queryable.** The counted probes measure what an agent sees when it saves something to an idle system. In
each world, the last 21 sessions are held back from the bulk import. After the import drains (the system reports
ready) and 60 seconds pass with no traffic, the harness writes the held-back sessions one at a time, in time order. A
probe's clock starts when the harness sends a session's write. As soon as the write returns, the harness searches with
a 300-character passage from the longest of the session's opening turns, through the system's shipped read, and
repeats every second until a returned item names that session or 10 minutes pass. The next probe starts only after the
previous one ends and the system again reports ready. The write-to-queryable time is the clock at the first search that
finds the session. A probe that never finds it within 10 minutes is a miss: the harness then waits for the system to
report ready and searches once more, and the miss is **late** if that search finds the session and **never found** if
it doesn't. Each poll's errors are recorded, not swallowed. p50 and p95 are taken over all counted probes with misses
ranked above the horizon, so a percentile that falls on a miss is reported as "more than 10 minutes", and late and
never-found misses are counted per system. Ten worlds give 210 counted probes per system.

What this measures is **source-attributed session retrieval**, and the results label it that way. A search counts as
finding the session only when a returned item carries that session's id. A system can return the fact without an id
(memory-bank's consolidated observations carry none), which this rule records as not found, and a keyword match can
return a session before background extraction finishes, so a hit shows the session can be retrieved, not that its facts
are extracted. Polls that return items with no session id are counted per system and reported beside the probe times
as unattributed returns.

A **bulk-import probe**, the same measurement on a seeded sample of 20 sessions during the bulk import, is reported as a
separate, labelled number: what a search sees while the system works through a backlog, such as a first import of old
chats. It never feeds decision 3 or README's p50.

For the file agent, the write is the session's Markdown file and each poll is a deterministic grep for the passage over
the agent's directory through its own grep tool, with no model call.

## Statistics

The unit is the world. Each system's monthly cost (system and total, per reader), cost per correct answer and
write-to-queryable p50 and p95 get a 95% interval from a cluster bootstrap over the 10 worlds (10,000 resamples, seed
`cost-speed-1`), and each comparison in "What the result decides" is a ratio of paired world means with its paired
bootstrap interval. A ratio whose interval includes 1 is reported as no measurable difference at this sample size,
never as equal.

**Smallest detectable difference, stated in advance.** For monthly cost ratios, 1.10 times. The changing-facts
confirmation's cost-per-correct ratios over 24 worlds had intervals about 1.5% either side of the estimate (1.05 to
1.08 and 0.33 to 0.34), and 10 worlds widen that by about the square root of 24/10, so a 1.10 ratio is resolved; the
decision rules use 1.25 and 1.5, practical margins above it. For write-to-queryable p50 ratios, 1.5 times, assuming a
log-normal spread of probe times with a log standard deviation of 1 and 210 probes clustered in 10 worlds. Before the
freeze the harness simulates both from the pilot's records (its probes for the spread of probe times), with the battleground confirmation's interval widths as
the floor for the cost spread. If either simulated difference is larger than stated, a dated amendment raises the world
count, up to all 20 dev worlds, before any counted cell.

## Plan and machines (R111)

The pilot's checks below compare against these planned unit rates and machine hours. They come from the battleground's
measured rates (`BG1_MEASURED` in `eval/runner/q1/cells/definitions.ts`), adjusted where this experiment's configuration
differs, and from the scoreboard's measured default deliveries. Program totals and caps are kept out of this file, as
CLAUDE.md asks; they go in the paid-window request and the tracking issue.

| Row | Write and background, dollars per million ingested tokens | Answer-model input per question | Machine hours per world |
|---|---|---|---|
| `gbrain-defaults` | 1.0 (measured embeddings 0.08, plus background fact extraction at an assumed 0.9 or less) | 23,800 tokens | 2 |
| `ext-extract-first` | 95 (its recipe's rate from the scoreboard's development smokes, `ingest_usd_per_mtok` in `definitions.ts`; the battleground's 20.09 for gpt-4.1-mini in its matched configuration, times the 2.84 per-call ratio [its pilot](../../eval/systems/extract-first/PILOT.md) measured for gpt-5-mini, gives about 57, so the plan takes the higher) | 1,200 tokens | 20 (its recipe's 110 hours per million tokens, `hours_per_mtok`, for a world of about 0.18 million) |
| `ext-memory-bank` | 3.7 (1.85 measured for its recipe with observations off, doubled for observations) | 10,400 tokens | 2 |
| `ext-verbatim-session` | 0 | 8,000 tokens | 1.5 |
| `baseline-hybrid` | 0.14 (measured) | 7,100 tokens | 1 |
| `baseline-file-agent` | 0 | 73,000 tokens over the agent's turns | 1.5 |
| `baseline-none` | 0 | the question only | 0.5 |
| `baseline-full-context` | 0 | the whole world, cached after the first read | 0.5 |

Hours include the probes, the questions for both readers and, on the two idle worlds, up to 2 more hours for the idle
window. Every multi-hour cell runs on its own Ubicloud VM through the repository's runner (`eval/runner/q1/cell.ts` with
`ubi-runner.sh`), detached, with one ledger writer on the VM's lease and the runner's resume path, and the VM is
destroyed when its cell ends. Answer output is capped at the reader settings the confirmation used.

## Pilot (R111)

Before any counted cell, one paid pilot cell per system on world `bg1-dev-11` (not among the ten counted worlds), at
no more than a tenth of that system's planned spend. A full pilot world would not fit that cap for a system that pays
per write: two worlds hold about a fifth of the counted sessions. So the paid pilot writes only the first 60 sessions of
`bg1-dev-11`: the first 40 as its bulk import, then the next 20 one at a time as probes, as the counted cells do. That
is about 4% of the roughly 1,500 sessions the counted cells write, 20 probes against 210, and four seeded questions per
reader against 200, so every paid part is under a tenth of its counted counterpart. The questions may ask about facts
the first 60 sessions don't hold, so pilot answers check only that reads run and get a matcher class; pilot accuracy
is not a check. `baseline-none` and `baseline-full-context` write nothing, so their pilot reads the four questions,
and for full context the whole of `bg1-dev-11`.

A separate **keyless capacity check** writes all of world `bg1-dev-12` to each system with its provider calls
answered by the repository's fake upstream (`eval/systems/gbrain-defaults/fake_upstream.py`, extended on the results
branch to the other systems' provider endpoints), no keys present, to show the stack holds and indexes a whole world on the
planned machine. It says nothing about provider latency. A system whose provider calls the fake upstream can't answer
is named in the freeze amendment, and its capacity is checked on its first counted world instead, which stops at the
cell boundary if ingest runs past 1.5 times the planned machine hours.

Each system's pilot must show:

- **the part under test ran:** usage lines with provider usage fields for each call the table above says the system
  makes on write and on read (verbatim-session, the file agent and the floors must show no provider write lines), at
  least 20 completed counted probes with a time or a miss, no probe search billed to another phase, hosting samples
  with nonzero resident memory, and for memory-bank, consolidation calls in its background lines;
- **no judge:** there is none; every pilot answer gets a matcher class;
- **the units can be supplied:** the paid pilot's write-and-drain time per session, times a world's session count, is
  inside the planned machine hours, the keyless capacity check finishes, and the write and background rate falls inside
  1.5 times the planned rate above; for `baseline-none`, every pilot question is read inside the planned
  reader rate. A rate outside that band, or more than 2 times the battleground's measured rate for a system it ran, is
  explained and re-planned in the freeze amendment before the counted run.

A system whose pilot fails is fixed and piloted again, or left out and reported as left out, with the reason.

## Earlier receipts

The changing-facts battleground and its confirmation metered gbrain, the extract-first and memory-bank servers and
hybrid search on worlds of this shape, and the Q1 scoreboard's development smokes recorded write-to-queryable probes for
several systems. They are not the counted numbers here: gbrain was measured at older builds (R100 asks for the newest),
the confirmation's worlds are sealed and its usage logs stay in custody, its external servers ran matched or retain-only
configurations rather than their shipped ones, and none ran verbatim-session or a file-agent write probe. They set the
planned rates above, and the results say where the new rates differ from them.

## Harness (keyless prep, on the results branch before any paid call)

- Cell definitions for this experiment (`eval/runner/q1/cells/cs1.ts`) over the ten worlds and the two pilot worlds: one
  cell per system, readers claude-opus-5-5 and particle-1 on the twenty-question sample, the held-back counted probes,
  the bulk-import probes, the idle window on two worlds, and the full-context row's whole-world reads with each
  profile's fit check.
- Every new runner behaviour (the held-back probe mode, the probe read as the shipped read, 1-second polls, the
  10-minute horizon, late and never-found misses, the probe meter phase, the idle window and hosting samples) is a
  per-cell option that only `cs1.ts` sets. Every existing cell manifest stays byte-identical, and a test holds that.
- At v0.60.769.0 gbrain's starter MCP surface refuses `query`'s `autocut` parameter (`param_not_on_surface`), so the
  fixed-evidence read the Q1 probe used fails on gbrain's shipped surface; the probe uses the shipped read. The keyless
  check below found it.
- The memory-bank shim takes observations on for this experiment's cells, and its default stays as it is for every
  other cell.
- `cost-speed.ts` gains the phases above, idle, hosting, the per-reader split, key-matched cost per correct answer, the
  history-growth ratio, both profiles and the bootstrap, and renders the results table. Every new path gets a keyless
  test with a dead upstream and blanked keys.

## Keyless check before registration

On 2026-11-24, with no provider keys and the shim's fake upstream standing where the metering proxy stands, gbrain
v0.60.769.0 installed through the gbrain-defaults image resolved its shipped defaults (PGLite, `voyage:voyage-4` at
1,024 dimensions, search mode `tokenmax`, reranker `voyage:rerank-3-lite`). A session written with `put_page` came back
from `query` on the first search, 644 ms after the write started; that is a keyword match only, because the fake
upstream's embeddings carry no meaning. Every provider call went to the proxy's address: Voyage embeddings and one
rerank. This shows the write and read path exists at the newest release and that its calls can be metered. It measures
nothing.

## README

The October scoreboard block in README is generated from a sealed campaign receipt and checked against the hash that
campaign published, and its gbrain row measures `f05943e6`. Writing a cost measured at v0.60.769.0 into that row would
put two builds in one row. So the block stays as rendered, and the results pull request adds a cost-and-speed table
directly under it: one row per system above, run rows and not-run rows with their reasons, with columns for system
cost, answer-model cost at claude-opus-5-5 and at particle-1, total, cost per correct answer at each reader, and
write-to-queryable p50 and p95, each row naming its build and measurement date. A sentence under the block points its
two "not measured" columns at that table.

## What it can and can't claim

It can say what each system costs per month for this profile, on this text, at these builds, what a key-matched
correct answer costs, and how long a saved session takes to become searchable on an idle system and during a bulk
import. It can't say what a different workload costs beyond rescaling the published unit costs, how a system behaves
past an 18-month history (the public 1,000,000-token dev worlds, once rendered, are follow-up work for that), or how
accurate any system is beyond the key match on these questions.

## Amendments

### 2026-11-24: probe attribution, idle check, probe errors and the world pool

Made on the results branch before any paid call, from the review of this plan's final draft. Where this amendment
and the text above differ, this amendment wins.

1. **Probe searches are labelled by their own text.** A write can still be sending provider requests when a probe
   searches, because some systems (the extract-first server among them) return from a write before their work ends.
   So phase by arrival time alone could bill a write's requests to the probe or the reverse. Before each probe the
   harness registers the probe's passage with the metering proxy (`/__proxy/probe` in
   `eval/runner/metering-proxy.ts`). An embedding or rerank request whose search text is exactly that passage is
   labelled `probe`, and every other request keeps its write, background or idle phase. Each request is still logged
   and charged once, so the phases sum to the bill; a keyless test in `test/eval/cost-speed-probes.test.ts` overlaps
   a write and a probe on one slot and checks both.
2. **A bounded idle check replaces "the system reports ready" between probes.** gbrain's shim can wait several minutes
   per drain round, and its `/finish` can say ready while background work is undrained. Before each counted probe
   the harness waits until the system reports no pending background work (or can't say) and its provider slot has been
   quiet for 60 seconds, checking each second, for at most 10 minutes. The check only watches: it never drains or
   stops the system's scheduler. A probe that starts after the 10 minutes without the system idle is recorded as
   "not idle" and doesn't count. A `/finish` that says ready with undrained background work isn't drained.
   Each counted world adds up to 21 × 20 minutes (7 hours) of probe and idle time to the machine hours above, and the
   pilot up to 20 × 20 minutes. The pilot's machine-hours check counts this allowance.
3. **Errored polls are not misses.** A probe is found at its first poll that returns the session, missed when every
   poll returned without it by the horizon, and errored when it never found the session and at least one poll
   errored. Errored probes are reported per system but stay out of p50, p95 and the miss share in decision 3. A world
   whose probes are more than a tenth errored or not idle is void: none of its probes count, and it is reported.
   The pilot's 20 probes must be found or missed, with none errored. Rules in `eval/runner/cost-speed-probes.ts`.
4. **The pilot and capacity worlds stay out of the counted pool.** If the smallest-difference check raises the world
   count, it draws only from the 18 dev worlds other than `bg1-dev-11` and `bg1-dev-12`. If 18 worlds can't resolve
   the stated difference, the results say so and report the interval they reach instead of adding those two.

## Disclosures

gbrain is Garry Tan's own project.

Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.

Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator.
Garry Tan runs Y Combinator.
