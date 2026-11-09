# OpenAI cache-write audit, November 9, 2026

gbrain is Garry Tan's own project. Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator. Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1. See [disclosures](../disclosures.md).

## The finding

No score, verdict or ranking a report states changes. One takeaway does: the memory proof wave's rebuilt cell ledger
no longer fits its approved cap with the full frontier sweep if gpt-6-astra's cache writes behave like gpt-6.1-sol's,
though its 10% sweep option fits either way. One description changes too: on the Hard confirmation's M world,
gpt-6.1-sol's dollars per success with gbrain are now 1.09 to 1.63 times those with files, so the report calls gbrain
dearer for Sol rather than slightly dearer.

Some published dollar figures for gpt-6.1-sol, gpt-6-sol, gpt-6-luna and gpt-6-astra are low, for two reasons. First,
the code that priced them counted OpenAI's cache writes as plain input. OpenAI's Responses API reports every uncached
token but 3 of a prompt of 1,027 tokens or more as a cache write (`input_tokens_details.cache_write_tokens`), and it
prices cache writes above input: $2.50 per million tokens against $2.00 for gpt-6.1-sol and gpt-6-sol, $0.125 against
$0.10 for gpt-6-luna and $12.50 against $10 for gpt-6-astra. That alone leaves a figure low by at most a quarter of its
input dollars. Second, Cat 40's price code never applied OpenAI's long-context rates: a request over 272,000 input
tokens pays twice the input, cached-input and cache-write prices and 1.5 times the output price for the whole request.
No Cat 40 file records each request's size, so a Cat 40 figure whose sessions could have held such a request is given
as a range. Elsewhere every request whose size is committed is under 272,000 tokens, and the figures whose request
sizes aren't committed say what they assume. No other OpenAI model these evals ran has a cache-write price; the rule
is measured on gpt-6.1-sol and gpt-6-luna records and assumed for gpt-6-sol and gpt-6-astra.

Three code paths missed the count:

- `eval/runner/q1/usage.ts`, which the Q1 cell runner and the Cat 40 agent loop use (the loop also runs the
  program-primary lane and the multi-source scope test), read cache writes only from Anthropic's field and
  `cache_write_tokens` at the top level, from `905b01c0` (October 8) until gbrain-evals #397 (`02fc9ca8`, November 9).
  Before `905b01c0` the Cat 40 loop had its own reader with the same gap.
- The budget ledger and `eval/runner/usage-receipt.ts` price OpenAI cache writes only from `8a8e502a` (October 8,
  19:24 UTC). Ledgers settled by older harness commits booked them as input.
- Other runners priced usage with their own code or an older ledger, neither with a cache-write rate: N2's judge
  replay, SkillOpt, content repair, memory trust's first arms, facts extraction, Hangul labeling, expansion latency and
  P4's stream model.

Anthropic reports cache writes in `cache_creation_input_tokens`, a field of its own that every path reads, so no
Claude figure moves. No committed Anthropic row has a one-hour cache write, so the five-minute write price applies
everywhere.

## How the figures were repriced

The corrected figure adds the cache-write premium to the published one: (cache-write price minus input price) times
the cache-write tokens. Where a report commits each response's raw usage, the cache-write tokens are read from it.
Where it commits only each request's input tokens, the rule measured on every committed raw usage record applies: a
gpt-6.1-sol or gpt-6-luna response reports its uncached prompt less 3 tokens as cache writes, and a prompt under 1,027
tokens reports none. That holds for 14,779 of 14,784 gpt-6.1-sol records and all 4,844 gpt-6-luna records. The five
exceptions, long prompts in the evidence-brief confirmation, report no write at all, so the rule can only overstate a
premium. Where a session's rows don't show whether its first request was long enough to write the cache, the figure
gets an upper and a lower bound. No provider was called. Three tools recompute every corrected figure from committed
files with no key: [BEAM-1M and the program-primary lane](2026-11-09-openai-cache-writes/beam-and-program-primary/README.md),
[Cat 40](2026-11-09-openai-cache-writes/cat40/README.md) and
[other runners](2026-11-09-openai-cache-writes/other-runners/README.md).

The ledgers that do price cache writes check the method. On every run where nothing was charged at its reservation,
the ledger minus the runner's own rows equals the predicted premium to within half a cent: six Cat 40
gpt-6.1-sol smoke runs, four multi-source scope runs and two SkillOpt runs. Where the two differ by more, the rest is
requests charged at their reservation, judge calls or proposer calls the rows don't carry.

Each corrected report keeps its original figure beside the new one, as "corrected 2026-11-09: cache writes were
under-counted; was X". Run and program totals stay out of public docs, so a corrected total says only how far it was
low, in percent. [Corrections](../corrections.md#openai-cache-writes) summarizes the entries.

## BEAM-1M and the program-primary lane

| Report | Figure | Was | Now |
|---|---|---|---|
| [BEAM-1M failure analysis](../benchmarks/2026-10-08-beam-1m-failure-analysis.md#2-reading-arms-on-the-frozen-evidence) | A2 top 5, gpt-6.1-sol arm cost | $4.30 | $5.09 |
| same | A3 top 10 | $7.42 | $8.97 |
| same | A4 oracle | $4.05 | $4.80 |
| same | A5 R0 top 5 | $3.98 | $4.71 |
| same | A5 R1 top 5 | $4.19 | $4.96 |
| same | A1 no-memory floor | $0.60 | unchanged: every prompt is under 1,024 tokens |
| [Program-primary baseline](../benchmarks/2026-10-08-program-primary-baseline.md) | gpt-6.1-sol dollars per run | $0.100 | $0.116 |
| [Program-primary hard baseline](../benchmarks/2026-10-08-program-primary-hard-baseline.md) | gpt-6.1-sol dollars per run | $0.075 | $0.088 |
| [Sealed confirmation](../benchmarks/2026-10-11-t0b-sealed-confirmation.md) | gpt-6.1-sol dollars per cell, stack against frozen | $0.077 against $0.075 (1.04x) | at most $0.093 against $0.089 (1.04x) |
| [Hard root cause](../benchmarks/2026-10-08-program-primary-hard-root-cause.md) | gpt-6.1-sol dollar ratio against the baseline | 1.01x | 1.00x |
| [Alias stack](../benchmarks/2026-10-09-alias-stack.md) | gpt-6.1-sol dollar ratio, development | 1.09x | 1.10x |
| [Candidate 1](../benchmarks/2026-10-09-candidate-1-newer-mentions.md) | gpt-6.1-sol dollar ratio, fresh seeds | 1.01x | 1.02x |
| [Proactive brief](../benchmarks/2026-10-14-proactive-brief-dev.md) | dollars per cell, all readers, off and on | $0.190 and $0.179 | $0.196 and $0.183 |
| [Proactive brief v2](../benchmarks/2026-10-15-proactive-brief-dev-v2.md) | dollars per cell, off and on | $0.208 and $0.192 | $0.214 and $0.196 |

The BEAM-1M arms were settled by a ledger from before `8a8e502a` and are repriced from each answer's recorded input
tokens; cached answers and prompts under 1,024 tokens get no premium. The lane's figures come from its committed usage
receipts. The sealed confirmation's rows are not committed, so its figures give gpt-6.1-sol the whole gap between each
arm's ledger and its cells' recorded dollars, which makes them upper bounds; its ratio and envelope verdict don't
change. In the hard baseline, the gpt-6.1-sol premium from the rows is 92% of the gap between the ledger and the cells.
Every envelope stays inside its limits. No committed request in these runs passes 272,000 input tokens (the largest has
103,137), so the long-context tier doesn't apply. The sealed confirmation commits no requests; its gpt-6.1-sol cells
average 93,000 to 97,000 input tokens in all. [The BEAM-1M and lane tool](2026-11-09-openai-cache-writes/beam-and-program-primary/README.md)
recomputes every figure in this section and the cache-write rule.

## Cat 40

Cat 40's agent loop recorded OpenAI usage with no cache writes until gbrain-evals #397 (`02fc9ca8`), so every gpt-6.1-sol, gpt-6-sol, gpt-6-astra and gpt-6-luna turn priced its cache-written prompt tokens at the input rate. Its price code (`priceUsage`, `eval/runner/cat40/loop.ts` line 200) also charges every request the standard rates, while OpenAI bills the whole of a request over 272,000 input tokens at long-context rates: twice the input, cached-input and cache-write prices and 1.5 times output. The corrected values below reprice the committed rows with the cache-write rule measured on every committed raw OpenAI usage record (`cache_write_rule` in the [BEAM-1M and lane tool's results](2026-11-09-openai-cache-writes/beam-and-program-primary/results.json)): a request whose whole prompt is 1,027 tokens or more writes its uncached prompt less 3 tokens to the cache, and a shorter one writes none. It was measured on gpt-6.1-sol and gpt-6-luna; no raw gpt-6-sol or gpt-6-astra record is committed, so it's assumed for both. Cache writes cost $2.50 per million against $2.00 for input for gpt-6.1-sol and gpt-6-sol, $12.50 against $10 for gpt-6-astra and $0.125 against $0.10 for gpt-6-luna, and the tier is priced at the long-context rates. No committed file holds per-request usage, because each row keeps its sessions' token totals and request counts, so a corrected value is a range wherever the bounds differ. The low end leaves up to 1,026 tokens of a multi-request fs, fs-acl, pg, memory or oracle session's first request, and 3 tokens of every other request, at the input rate, and prices no request at the long-context rates, except a single-request session whose prompt passed 272,000 tokens. The high end has every request write its uncached prompt less 3 tokens and prices every session that could have held a request over 272,000 tokens at the long-context rates; on a budget run settled by a ledger at or after `8a8e502a`, which applied those rates, that tier share is capped at the ledger's surplus over the cache-write-corrected rows. On six post-fix runs, the D2/D4 and D5 smokes, the ledger minus the rows equals the predicted cache-write premium to $0.001 and no session could reach the tier; on every other post-fix run the ledger's surplus over the rows is at least the predicted premium. No score or verdict changes, and no ranking that a report states in its text changes; the repriced tables do reorder some pairs of models within an arm, [listed below](#cw-orderings). Spend totals are given as percentages.

One command at the repository root reproduces every figure here from committed files, with no provider call and no key: `bun docs/audit/2026-11-09-openai-cache-writes/cat40/reprice.ts`. It takes about 95 seconds and writes [`cat40/results.json`](2026-11-09-openai-cache-writes/cat40/results.json); the [README](2026-11-09-openai-cache-writes/cat40/README.md) gives the price table, the bounds and the output fields. It checks 94 report figures, of which 84 move.

### Report figures

| Doc | Figure | Was | Now |
|---|---|---|---|
| [2026-10-02-model-ladder.md](../benchmarks/2026-10-02-model-ladder.md) | gbrain $/task, held-out wave, five models (summary and entity-recall table) | $0.238 | $0.248 |
| [2026-10-02-model-ladder.md](../benchmarks/2026-10-02-model-ladder.md) | fs $/task, held-out, five models | $0.112 | $0.115 to $0.116 |
| [2026-10-02-model-ladder.md](../benchmarks/2026-10-02-model-ladder.md) | gbrain against fs per task, held-out ("about twice") | about twice (2.13 times) | 2.14 to 2.16 times, still about twice |
| [2026-10-02-model-ladder.md](../benchmarks/2026-10-02-model-ladder.md) | entity-recall $/task: dev master, round 1, round 2 | 0.341, 0.286, 0.240 | 0.357, 0.301, 0.251 |
| [2026-10-02-model-ladder.md](../benchmarks/2026-10-02-model-ladder.md) | entity-recall $/task: held-out previous gbrain | 0.323 | 0.338 |
| [2026-10-02-model-ladder.md](../benchmarks/2026-10-02-model-ladder.md) | default-on cost per task, fall against the previous gbrain | 26% | 26% (unchanged) |
| [2026-10-02-model-ladder.md](../benchmarks/2026-10-02-model-ladder.md) | price line: gbrain against fs per task, development world | $0.19 against $0.054 | $0.20 to $0.21 against $0.056 |
| [2026-10-02-model-ladder.md](../benchmarks/2026-10-02-model-ladder.md) | gbrain against fs per task, development and held-out ("2.5 to 4 times") | 2.5 to 4 times (3.55 and 4.03) | 3.58 to 3.75 and 4.04 to 4.05 times |
| [2026-10-02-model-ladder.md](../benchmarks/2026-10-02-model-ladder.md) | held-out cost per task: fixed build, release, fs, pg | $0.130, $0.098, $0.032, $0.021 | $0.133, $0.100, $0.033, $0.022 |
| [2026-10-02-model-ladder.md](../benchmarks/2026-10-02-model-ladder.md) | cost and speed table $ per task: fs, pg, memory | 0.054, 0.038, 0.269 | 0.056, 0.040 to 0.041, 0.284 to 0.302 |
| [2026-10-02-model-ladder.md](../benchmarks/2026-10-02-model-ladder.md) | cost and speed table $ per task: gbrain release, gbrain fixed | 0.190, 0.192 | 0.201 to 0.209, 0.202 to 0.203 |
| [2026-10-02-model-ladder.md](../benchmarks/2026-10-02-model-ladder.md) | cost wave $/task, GPT-6.1 Sol: control, wave | 0.097, 0.065 | 0.117 to 0.122, 0.078 |
| [2026-10-02-model-ladder.md](../benchmarks/2026-10-02-model-ladder.md) | cost wave $/task, all models: control, wave | 0.118, 0.080 | 0.121 to 0.122, 0.082 |
| [2026-10-02-model-ladder.md](../benchmarks/2026-10-02-model-ladder.md) | cost wave falls: per task, per successful task | 32%, 34% | 32% to 33%, 34% to 35% |
| [2026-10-02-model-ladder.md](../benchmarks/2026-10-02-model-ladder.md) | cost wave cost per successful task: control, wave | $0.161, $0.106 | $0.165 to $0.166, $0.109 |
| [2026-10-02-model-ladder.md](../benchmarks/2026-10-02-model-ladder.md) | whole-program spend | as published | 6% to 9% low |
| [scale-tier/README.md](../benchmarks/2026-10-02-model-ladder/scale-tier/README.md) | spend per cell: oracle, fs-acl, pg, fs, gbrain, memory | $0.010, $0.021, $0.031, $0.060, $0.157, $1.30 | $0.010, $0.022, $0.032, $0.061, $0.161 to $0.164, $1.34 to $1.61 |
| [scale-tier/README.md](../benchmarks/2026-10-02-model-ladder/scale-tier/README.md) | ledger spend; cell records | as published | 3% to 18% low; 3% to 19% low |
| [baseline-uncapped/README.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/README.md) | ledger total; recorded cells | as published | 5% to 9% low from the recorded cells, plus the unknown premium on cells lost in flight; 5% to 9% low |
| [holdout/README.md](../benchmarks/2026-10-02-model-ladder/holdout/README.md) | run spend: runs 1, 2, 3 and 4; ledger total | as published | 3% to 8% low; about 3% low; about 2% low; about 2% low; 3% to 4% low |
| [followups/README.md](../benchmarks/2026-10-02-model-ladder/followups/README.md) | ledger spend | as published | about 2% low |
| [p8-hidden-tool-dev-smoke/README.md](../benchmarks/2026-10-02-model-ladder/p8-hidden-tool-dev-smoke/README.md) | ledger spend; cell spend (gpt-6-luna), from the unrounded rows | as published | about 7% low; about 14% low |
| [simple-arms-rescored/README.md](../benchmarks/2026-10-02-model-ladder/entity-recall/simple-arms-rescored/README.md) | cost to rerun the simple arms | as published | 3% to 8% low |
| [2026-10-05-registration-surface.md](../benchmarks/2026-10-05-registration-surface.md) | cost per surface (40 cells each): starter, full, verbs | $14.17, $15.39, $14.37 | $14.36, $15.55, $14.53 |
| [2026-10-05-registration-surface.md](../benchmarks/2026-10-05-registration-surface.md) | agent-cell spend | as published | about 1% low |
| [2026-10-07-model-ladder-hard.md](../benchmarks/2026-10-07-model-ladder-hard.md) | $ per task: fs, pg, gbrain | 0.98, 0.29, 0.69 | 0.99 to 1.00, 0.30, 0.72 to 0.78 |
| [2026-10-07-model-ladder-hard.md](../benchmarks/2026-10-07-model-ladder-hard.md) | gbrain against fs per task ("cheaper") | 0.71 times | 0.72 to 0.79 times, still cheaper |
| [2026-10-07-model-ladder-hard.md](../benchmarks/2026-10-07-model-ladder-hard.md) | Hard ledger | as published | 1% to 2% low from the committed held-out rows, plus an unknown calibration share |
| [2026-10-07-wave11-agent-smoke.md](../benchmarks/2026-10-07-wave11-agent-smoke.md) | cell totals: all, master, wave 11, pilot; ledger total | as published | about 2% low; about 2% low; about 1% low; about 19% low; about 2% low |
| [2026-10-07-wave12-agent-smoke.md](../benchmarks/2026-10-07-wave12-agent-smoke.md) | preregistered cells: all, baseline, wave 12; ledger total | as published | about 2% low; about 2% low; about 2% low; about 1% low |
| [2026-10-10-model-ladder-hard-confirmation.md](../benchmarks/2026-10-10-model-ladder-hard-confirmation.md) | world M, Sol: gbrain and fs $/success | 0.32, 0.24 | 0.38 to 0.45, 0.28 to 0.35 |
| [2026-10-10-model-ladder-hard-confirmation.md](../benchmarks/2026-10-10-model-ladder-hard-confirmation.md) | world M, Sol: gbrain against fs per success ("slightly dearer") | 1.35 times | 1.09 to 1.63 times, now "dearer" |
| [2026-10-10-model-ladder-hard-confirmation.md](../benchmarks/2026-10-10-model-ladder-hard-confirmation.md) | world S, Sol: gbrain and fs $/success | 0.46, 0.32 | not recomputed (rows not committed); 19% to 42% low and 17% to 48% low, as on M |
| [2026-10-12-d2d4-smoke/VERDICT.md](../benchmarks/2026-10-12-d2d4-smoke/VERDICT.md) | gpt-6.1-sol cost, 10 cells: master, d2d4 | $0.36, $0.14 | $0.43, $0.16 |
| [2026-10-14-d5-brief-smoke/VERDICT.md](../benchmarks/2026-10-14-d5-brief-smoke/VERDICT.md) | gpt-6.1-sol cost, 10 cells: master, d5 | $0.38, $0.37 | $0.46, $0.44 |
| [2026-10-13-cat40-dev-round-1/README.md](../benchmarks/2026-10-13-cat40-dev-round-1/README.md) | arm USD, judge excluded (header said agent + judge): control, all-on, f5 | 155.23, 126.03, 144.90 | 160.07 to 161.43, 130.25 to 131.49, 149.38 to 151.56 |
| [2026-10-13-cat40-dev-round-1/README.md](../benchmarks/2026-10-13-cat40-dev-round-1/README.md) | arm USD, judge excluded: f1, f1-no-names-row, f2, f4 | 74.84, 71.56, 85.47, 81.07 | 77.53, 74.11, 88.41, 84.04 |
| [2026-10-13-cat40-dev-round-2/README.md](../benchmarks/2026-10-13-cat40-dev-round-2/README.md) | arm USD, judge excluded (header said agent + judge): control, all-on, f5 | 156.23, 129.17, 148.98 | 161.12 to 163.14, 133.18 to 135.23, 153.53 to 156.23 |
| [2026-10-13-cat40-dev-round-3/README.md](../benchmarks/2026-10-13-cat40-dev-round-3/README.md) | attempts' agent plus judge cost; the untraced gap to the ledger | as published | 3% to 5% low; Sol agent cache writes are about two thirds of the gap, and the Sol judge's cache writes (up to about a fifth) and the long-context rates fit the rest |
| [2026-10-15-cat40-next-confirm/README.md](../benchmarks/2026-10-15-cat40-next-confirm/README.md) | $ per successful cell, public wave and baseline | 0.53, 0.63 | 0.55, 0.65 |
| [2026-10-15-cat40-next-confirm/README.md](../benchmarks/2026-10-15-cat40-next-confirm/README.md) | fs $ per success, public | $1.35 | $1.37 |
| [2026-10-15-cat40-next-confirm/README.md](../benchmarks/2026-10-15-cat40-next-confirm/README.md) | sealed $ per success: wave, baseline, fs | 0.98, 0.94, $1.77 | not recomputed (rows not committed); 3% to 4% low, 3% to 4% low, about 1% low, as on public |
| [2026-10-15-cat40-next-confirm/README.md](../benchmarks/2026-10-15-cat40-next-confirm/README.md) | wave against fs per success, public ("cheaper") | 0.39 times | 0.40 times, still cheaper |
| [calibration.md](../benchmarks/cat40-hard/calibration.md) | round and arm costs (GPT-6 Astra agents, gpt-6.1-sol judge) | as published | not recomputed (rows not committed); at most 25% low if no request passed 272,000 input tokens, up to 150% if requests did |

### Generated pages

Each page below was regenerated with the repo's own analyzer (`eval/runner/cat40/analyze.ts` or `holdout_stats.py`) from the original rows and from the low-end and high-end corrected rows. A line is listed when the original regeneration reproduces it exactly and a corrected one differs; line numbers count the notice at the top of each page. 2,567 of 2,619 committed lines reproduce. The rest are the ledger reconciliation tables at the foot of the follow-up and wave 11 pages, which need ledger files the analyzer isn't given (their cell and ledger columns rest on the same under-counted prices, so their gaps stand), the hand-written wrapper around the [a714410a5 headline](#cw-ladder-er-headline-a714410a5) output and one leak-count line on the follow-ups' ship-rule page.

<a id="cw-ladder-baseline-uncapped-analysis"></a>
### [2026-10-02-model-ladder/baseline-uncapped/analysis.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis.md)

The high ends include the long-context rates for sessions that could pass 272,000 input tokens.

| Line | Row | Column | Was | Now |
|---|---|---|---|---|
| 3 | Spend in these records | spend total | | 5% to 9% low |
| 89 | gpt-6-astra / fs | $/task | 0.109 | 0.125 to 0.127 |
| 89 | gpt-6-astra / fs | $/success | 0.109 | 0.125 to 0.127 |
| 90 | gpt-6-astra / fs-acl | $/task | 0.083 | 0.095 to 0.097 |
| 90 | gpt-6-astra / fs-acl | $/success | 0.083 | 0.095 to 0.097 |
| 91 | gpt-6-astra / gbrain | $/task | 0.362 | 0.427 |
| 91 | gpt-6-astra / gbrain | $/success | 0.371 | 0.437 |
| 92 | gpt-6-astra / memory | $/task | 0.758 | 0.868 to 0.960 |
| 92 | gpt-6-astra / memory | $/success | 0.886 | 1.013 to 1.121 |
| 93 | gpt-6-astra / oracle | $/task | 0.022 | 0.025 |
| 93 | gpt-6-astra / oracle | $/success | 0.022 | 0.025 |
| 94 | gpt-6-astra / pg | $/task | 0.092 | 0.106 to 0.109 |
| 94 | gpt-6-astra / pg | $/success | 0.096 | 0.110 to 0.113 |
| 95 | gpt-6-sol / fs | $/task | 0.022 | 0.024 to 0.025 |
| 95 | gpt-6-sol / fs | $/success | 0.022 | 0.025 to 0.026 |
| 96 | gpt-6-sol / fs-acl | $/task | 0.014 | 0.016 |
| 96 | gpt-6-sol / fs-acl | $/success | 0.014 | 0.016 |
| 97 | gpt-6-sol / gbrain | $/task | 0.139 | 0.164 to 0.246 |
| 97 | gpt-6-sol / gbrain | $/success | 0.146 | 0.173 to 0.260 |
| 98 | gpt-6-sol / memory | $/task | 0.115 | 0.132 |
| 98 | gpt-6-sol / memory | $/success | 0.157 | 0.179 to 0.180 |
| 100 | gpt-6-sol / pg | $/task | 0.019 | 0.022 |
| 100 | gpt-6-sol / pg | $/success | 0.022 | 0.025 |
| 101 | gpt-6.1-sol / fs | $/task | 0.021 | 0.024 |
| 101 | gpt-6.1-sol / fs | $/success | 0.021 | 0.024 to 0.025 |
| 102 | gpt-6.1-sol / fs-acl | $/task | 0.014 | 0.016 to 0.017 |
| 102 | gpt-6.1-sol / fs-acl | $/success | 0.014 | 0.016 to 0.017 |
| 103 | gpt-6.1-sol / gbrain | $/task | 0.075 | 0.090 |
| 103 | gpt-6.1-sol / gbrain | $/success | 0.075 | 0.091 |
| 104 | gpt-6.1-sol / memory | $/task | 0.148 | 0.174 to 0.204 |
| 104 | gpt-6.1-sol / memory | $/success | 0.162 | 0.190 to 0.223 |
| 105 | gpt-6.1-sol / oracle | $/task | 0.004 | 0.005 |
| 105 | gpt-6.1-sol / oracle | $/success | 0.004 | 0.005 |
| 106 | gpt-6.1-sol / pg | $/task | 0.017 | 0.020 |
| 106 | gpt-6.1-sol / pg | $/success | 0.019 | 0.022 |

<a id="cw-ladder-baseline-uncapped-analysis-repeats-0-1"></a>
### [2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md)

The high ends include the long-context rates for sessions that could pass 272,000 input tokens.

| Line | Row | Column | Was | Now |
|---|---|---|---|---|
| 3 | Spend in these records | spend total | | 5% to 9% low |
| 89 | gpt-6-astra / fs | $/task | 0.116 | 0.133 to 0.136 |
| 89 | gpt-6-astra / fs | $/success | 0.116 | 0.133 to 0.136 |
| 90 | gpt-6-astra / fs-acl | $/task | 0.086 | 0.097 to 0.100 |
| 90 | gpt-6-astra / fs-acl | $/success | 0.086 | 0.097 to 0.100 |
| 91 | gpt-6-astra / gbrain | $/task | 0.399 | 0.470 |
| 91 | gpt-6-astra / gbrain | $/success | 0.407 | 0.480 |
| 92 | gpt-6-astra / memory | $/task | 0.849 | 0.965 to 1.086 |
| 92 | gpt-6-astra / memory | $/success | 0.987 | 1.122 to 1.263 |
| 93 | gpt-6-astra / oracle | $/task | 0.022 | 0.026 |
| 93 | gpt-6-astra / oracle | $/success | 0.022 | 0.026 |
| 94 | gpt-6-astra / pg | $/task | 0.099 | 0.114 to 0.117 |
| 94 | gpt-6-astra / pg | $/success | 0.103 | 0.119 to 0.122 |
| 95 | gpt-6-sol / fs | $/task | 0.023 | 0.026 to 0.027 |
| 95 | gpt-6-sol / fs | $/success | 0.024 | 0.027 to 0.028 |
| 96 | gpt-6-sol / fs-acl | $/task | 0.014 | 0.016 |
| 96 | gpt-6-sol / fs-acl | $/success | 0.014 | 0.016 |
| 97 | gpt-6-sol / gbrain | $/task | 0.156 | 0.186 to 0.288 |
| 97 | gpt-6-sol / gbrain | $/success | 0.166 | 0.197 to 0.306 |
| 98 | gpt-6-sol / memory | $/task | 0.130 | 0.148 |
| 98 | gpt-6-sol / memory | $/success | 0.178 | 0.202 to 0.203 |
| 100 | gpt-6-sol / pg | $/task | 0.021 | 0.024 |
| 100 | gpt-6-sol / pg | $/success | 0.024 | 0.027 to 0.028 |
| 101 | gpt-6.1-sol / fs | $/task | 0.022 | 0.026 |
| 101 | gpt-6.1-sol / fs | $/success | 0.023 | 0.026 to 0.027 |
| 102 | gpt-6.1-sol / fs-acl | $/task | 0.014 | 0.017 |
| 102 | gpt-6.1-sol / fs-acl | $/success | 0.014 | 0.017 |
| 103 | gpt-6.1-sol / gbrain | $/task | 0.084 | 0.102 |
| 103 | gpt-6.1-sol / gbrain | $/success | 0.085 | 0.103 |
| 104 | gpt-6.1-sol / memory | $/task | 0.165 | 0.192 to 0.232 |
| 104 | gpt-6.1-sol / memory | $/success | 0.181 | 0.211 to 0.255 |
| 105 | gpt-6.1-sol / oracle | $/task | 0.004 | 0.005 |
| 105 | gpt-6.1-sol / oracle | $/success | 0.004 | 0.005 |
| 106 | gpt-6.1-sol / pg | $/task | 0.019 | 0.022 |
| 106 | gpt-6.1-sol / pg | $/success | 0.020 | 0.024 |

<a id="cw-ladder-fix-wave-ladder-analysis-next"></a>
### [2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md](../benchmarks/2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md)

The high ends include the long-context rates for sessions that could pass 272,000 input tokens.

| Line | Row | Column | Was | Now |
|---|---|---|---|---|
| 3 | Spend in these records | spend total | | 5% to 9% low |
| 98 | gpt-6-astra / fs | $/task | 0.114 | 0.131 to 0.134 |
| 98 | gpt-6-astra / fs | $/success | 0.114 | 0.131 to 0.134 |
| 99 | gpt-6-astra / fs-acl | $/task | 0.087 | 0.099 to 0.101 |
| 99 | gpt-6-astra / fs-acl | $/success | 0.087 | 0.099 to 0.101 |
| 100 | gpt-6-astra / gbrain | $/task | 0.404 | 0.475 |
| 100 | gpt-6-astra / gbrain | $/success | 0.404 | 0.475 |
| 101 | gpt-6-astra / gbrain-next | $/task | 0.411 | 0.482 |
| 101 | gpt-6-astra / gbrain-next | $/success | 0.411 | 0.482 |
| 102 | gpt-6-astra / memory | $/task | 0.864 | 0.984 to 1.144 |
| 102 | gpt-6-astra / memory | $/success | 0.960 | 1.093 to 1.271 |
| 103 | gpt-6-astra / oracle | $/task | 0.022 | 0.026 |
| 103 | gpt-6-astra / oracle | $/success | 0.022 | 0.026 |
| 104 | gpt-6-astra / pg | $/task | 0.100 | 0.115 to 0.118 |
| 104 | gpt-6-astra / pg | $/success | 0.104 | 0.120 to 0.123 |
| 105 | gpt-6-sol / fs | $/task | 0.024 | 0.027 to 0.028 |
| 105 | gpt-6-sol / fs | $/success | 0.025 | 0.028 |
| 106 | gpt-6-sol / fs-acl | $/task | 0.015 | 0.017 |
| 106 | gpt-6-sol / fs-acl | $/success | 0.015 | 0.017 |
| 107 | gpt-6-sol / gbrain | $/task | 0.148 | 0.176 to 0.261 |
| 107 | gpt-6-sol / gbrain | $/success | 0.158 | 0.187 to 0.277 |
| 108 | gpt-6-sol / gbrain-next | $/task | 0.114 | 0.135 to 0.145 |
| 108 | gpt-6-sol / gbrain-next | $/success | 0.114 | 0.135 to 0.145 |
| 109 | gpt-6-sol / memory | $/task | 0.130 | 0.148 to 0.149 |
| 109 | gpt-6-sol / memory | $/success | 0.176 | 0.200 to 0.201 |
| 111 | gpt-6-sol / pg | $/task | 0.021 | 0.023 to 0.024 |
| 111 | gpt-6-sol / pg | $/success | 0.023 | 0.027 |
| 112 | gpt-6.1-sol / fs | $/task | 0.022 | 0.026 |
| 112 | gpt-6.1-sol / fs | $/success | 0.023 | 0.027 to 0.028 |
| 113 | gpt-6.1-sol / fs-acl | $/task | 0.015 | 0.017 to 0.018 |
| 113 | gpt-6.1-sol / fs-acl | $/success | 0.015 | 0.017 to 0.018 |
| 114 | gpt-6.1-sol / gbrain | $/task | 0.080 | 0.097 |
| 114 | gpt-6.1-sol / gbrain | $/success | 0.082 | 0.099 |
| 115 | gpt-6.1-sol / gbrain-next | $/task | 0.075 | 0.090 |
| 115 | gpt-6.1-sol / gbrain-next | $/success | 0.076 | 0.092 |
| 116 | gpt-6.1-sol / memory | $/task | 0.160 | 0.186 to 0.228 |
| 116 | gpt-6.1-sol / memory | $/success | 0.171 | 0.198 to 0.242 |
| 117 | gpt-6.1-sol / oracle | $/task | 0.004 | 0.005 |
| 117 | gpt-6.1-sol / oracle | $/success | 0.004 | 0.005 |
| 118 | gpt-6.1-sol / pg | $/task | 0.018 | 0.021 to 0.022 |
| 118 | gpt-6.1-sol / pg | $/success | 0.020 | 0.023 to 0.024 |

<a id="cw-ladder-followups-control-analysis"></a>
### [2026-10-02-model-ladder/followups/control/analysis.md](../benchmarks/2026-10-02-model-ladder/followups/control/analysis.md)

The high ends include the long-context rates for sessions that could pass 272,000 input tokens.

| Line | Row | Column | Was | Now |
|---|---|---|---|---|
| 3 | Spend in these records | spend total | | about 3% low |
| 36 | gpt-6.1-sol / gbrain-566a242a-control | $/task | 0.097 | 0.117 to 0.122 |
| 36 | gpt-6.1-sol / gbrain-566a242a-control | $/success | 0.097 | 0.117 to 0.122 |
| 47 | gpt-6.1-sol / gbrain-566a242a-control | uncached input $ | 0.0811 | 0.0000 |
| 47 | gpt-6.1-sol / gbrain-566a242a-control | cache write $ | 0.0000 | 0.1013 to 0.1060 |
| 47 | gpt-6.1-sol / gbrain-566a242a-control | cache read $ | 0.0117 | 0.0117 to 0.0119 |
| 47 | gpt-6.1-sol / gbrain-566a242a-control | output $ | 0.0036 | 0.0036 to 0.0037 |
| 47 | gpt-6.1-sol / gbrain-566a242a-control | total_usd | 0.0966 | 0.1169 to 0.1219 |

<a id="cw-ladder-followups-holdout-analysis"></a>
### [2026-10-02-model-ladder/followups/holdout/analysis.md](../benchmarks/2026-10-02-model-ladder/followups/holdout/analysis.md)

| Line | Row | Column | Was | Now |
|---|---|---|---|---|
| 3 | Spend in these records | spend total | | about 3% low |
| 36 | gpt-6.1-sol / gbrain-c1234-holdout | $/task | 0.065 | 0.078 |
| 36 | gpt-6.1-sol / gbrain-c1234-holdout | $/success | 0.065 | 0.078 |
| 47 | gpt-6.1-sol / gbrain-c1234-holdout | uncached input $ | 0.0540 | 0.0000 |
| 47 | gpt-6.1-sol / gbrain-c1234-holdout | cache write $ | 0.0000 | 0.0674 |
| 47 | gpt-6.1-sol / gbrain-c1234-holdout | total_usd | 0.0648 | 0.0783 |

<a id="cw-ladder-holdout-analysis-base"></a>
### [2026-10-02-model-ladder/holdout/analysis-base.md](../benchmarks/2026-10-02-model-ladder/holdout/analysis-base.md)

The high ends include the long-context rates for sessions that could pass 272,000 input tokens.

| Line | Row | Column | Was | Now |
|---|---|---|---|---|
| 3 | Spend in these records | spend total | | 3% to 4% low |
| 78 | gpt-6.1-sol / fs | $/task | 0.022 | 0.026 |
| 78 | gpt-6.1-sol / fs | $/success | 0.022 | 0.026 |
| 79 | gpt-6.1-sol / fs-acl | $/task | 0.015 | 0.017 to 0.018 |
| 79 | gpt-6.1-sol / fs-acl | $/success | 0.015 | 0.017 to 0.018 |
| 80 | gpt-6.1-sol / gbrain-base | $/task | 0.077 | 0.093 |
| 80 | gpt-6.1-sol / gbrain-base | $/success | 0.090 | 0.108 |
| 81 | gpt-6.1-sol / gbrain-next | $/task | 0.092 | 0.110 |
| 81 | gpt-6.1-sol / gbrain-next | $/success | 0.092 | 0.110 |
| 82 | gpt-6.1-sol / gbrain-next-51a30c1 | $/task | 0.081 | 0.097 |
| 82 | gpt-6.1-sol / gbrain-next-51a30c1 | $/success | 0.082 | 0.098 |
| 83 | gpt-6.1-sol / memory | $/task | 0.187 | 0.217 to 0.276 |
| 83 | gpt-6.1-sol / memory | $/success | 0.217 | 0.252 to 0.321 |
| 85 | gpt-6.1-sol / pg | $/task | 0.018 | 0.021 to 0.022 |
| 85 | gpt-6.1-sol / pg | $/success | 0.019 | 0.022 to 0.023 |

<a id="cw-ladder-holdout-analysis-next"></a>
### [2026-10-02-model-ladder/holdout/analysis-next.md](../benchmarks/2026-10-02-model-ladder/holdout/analysis-next.md)

The high ends include the long-context rates for sessions that could pass 272,000 input tokens.

| Line | Row | Column | Was | Now |
|---|---|---|---|---|
| 3 | Spend in these records | spend total | | 3% to 4% low |
| 78 | gpt-6.1-sol / fs | $/task | 0.022 | 0.026 |
| 78 | gpt-6.1-sol / fs | $/success | 0.022 | 0.026 |
| 79 | gpt-6.1-sol / fs-acl | $/task | 0.015 | 0.017 to 0.018 |
| 79 | gpt-6.1-sol / fs-acl | $/success | 0.015 | 0.017 to 0.018 |
| 80 | gpt-6.1-sol / gbrain-base | $/task | 0.077 | 0.093 |
| 80 | gpt-6.1-sol / gbrain-base | $/success | 0.090 | 0.108 |
| 81 | gpt-6.1-sol / gbrain-next | $/task | 0.092 | 0.110 |
| 81 | gpt-6.1-sol / gbrain-next | $/success | 0.092 | 0.110 |
| 82 | gpt-6.1-sol / gbrain-next-51a30c1 | $/task | 0.081 | 0.097 |
| 82 | gpt-6.1-sol / gbrain-next-51a30c1 | $/success | 0.082 | 0.098 |
| 83 | gpt-6.1-sol / memory | $/task | 0.187 | 0.217 to 0.276 |
| 83 | gpt-6.1-sol / memory | $/success | 0.217 | 0.252 to 0.321 |
| 85 | gpt-6.1-sol / pg | $/task | 0.018 | 0.021 to 0.022 |
| 85 | gpt-6.1-sol / pg | $/success | 0.019 | 0.022 to 0.023 |

<a id="cw-ladder-pilot-capped-20k-analysis"></a>
### [2026-10-02-model-ladder/pilot-capped-20k/analysis.md](../benchmarks/2026-10-02-model-ladder/pilot-capped-20k/analysis.md)

| Line | Row | Column | Was | Now |
|---|---|---|---|---|
| 3 | Spend in these records | spend total | | about 2% low |
| 66 | gpt-6.1-sol / fs | $/task | 0.022 | 0.026 to 0.027 |
| 66 | gpt-6.1-sol / fs | $/success | 0.022 | 0.026 to 0.027 |
| 67 | gpt-6.1-sol / fs-acl | $/task | 0.013 | 0.015 |
| 67 | gpt-6.1-sol / fs-acl | $/success | 0.013 | 0.015 |
| 68 | gpt-6.1-sol / gbrain | $/task | 0.047 | 0.056 |
| 68 | gpt-6.1-sol / gbrain | $/success | 0.055 | 0.065 |
| 69 | gpt-6.1-sol / memory | $/task | 0.117 | 0.136 |
| 69 | gpt-6.1-sol / memory | $/success | 0.143 | 0.165 to 0.166 |
| 70 | gpt-6.1-sol / oracle | $/task | 0.004 | 0.005 |
| 70 | gpt-6.1-sol / oracle | $/success | 0.004 | 0.005 |
| 71 | gpt-6.1-sol / pg | $/task | 0.018 | 0.021 |
| 71 | gpt-6.1-sol / pg | $/success | 0.019 | 0.022 |

<a id="cw-ladder-scale-tier-analysis"></a>
### [2026-10-02-model-ladder/scale-tier/analysis.md](../benchmarks/2026-10-02-model-ladder/scale-tier/analysis.md)

The high ends include the long-context rates for sessions that could pass 272,000 input tokens.

| Line | Row | Column | Was | Now |
|---|---|---|---|---|
| 3 | Spend in these records | spend total | | 3% to 19% low |
| 52 | gpt-6.1-sol / fs | $/task | 0.026 | 0.030 to 0.031 |
| 52 | gpt-6.1-sol / fs | $/success | 0.027 | 0.031 to 0.032 |
| 53 | gpt-6.1-sol / fs-acl | $/task | 0.013 | 0.016 |
| 53 | gpt-6.1-sol / fs-acl | $/success | 0.013 | 0.016 |
| 54 | gpt-6.1-sol / gbrain | $/task | 0.085 | 0.103 to 0.114 |
| 54 | gpt-6.1-sol / gbrain | $/success | 0.093 | 0.112 to 0.124 |
| 55 | gpt-6.1-sol / memory | $/task | 0.894 | 1.078 to 2.152 |
| 55 | gpt-6.1-sol / memory | $/success | 1.277 | 1.540 to 3.075 |
| 57 | gpt-6.1-sol / pg | $/task | 0.018 | 0.020 to 0.021 |
| 57 | gpt-6.1-sol / pg | $/success | 0.019 | 0.022 |

<a id="cw-ladder-p8-b6622a-surface-full-analysis"></a>
### [2026-10-02-model-ladder/p8-hidden-tool-dev-smoke/b6622a-surface-full/analysis.md](../benchmarks/2026-10-02-model-ladder/p8-hidden-tool-dev-smoke/b6622a-surface-full/analysis.md)

| Line | Row | Column | Was | Now |
|---|---|---|---|---|
| 3 | Spend in these records | spend total | | about 10% low |
| 32 | gpt-6-luna / b6622a-surface-full | uncached input $ | 0.0010 | 0.0000 |
| 32 | gpt-6-luna / b6622a-surface-full | cache write $ | 0.0000 | 0.0013 |
| 32 | gpt-6-luna / b6622a-surface-full | total_usd | 0.0026 | 0.0028 |

<a id="cw-ladder-p8-b6622a-surface-starter-analysis"></a>
### [2026-10-02-model-ladder/p8-hidden-tool-dev-smoke/b6622a-surface-starter/analysis.md](../benchmarks/2026-10-02-model-ladder/p8-hidden-tool-dev-smoke/b6622a-surface-starter/analysis.md)

| Line | Row | Column | Was | Now |
|---|---|---|---|---|
| 3 | Spend in these records | spend total | | about 18% low |
| 26 | gpt-6-luna / b6622a-surface-starter | $/task | 0.007 | 0.009 |
| 32 | gpt-6-luna / b6622a-surface-starter | uncached input $ | 0.0051 | 0.0000 |
| 32 | gpt-6-luna / b6622a-surface-starter | cache write $ | 0.0000 | 0.0063 |
| 32 | gpt-6-luna / b6622a-surface-starter | total_usd | 0.0072 | 0.0085 |

<a id="cw-ladder-p8-c6c958-adv-full-analysis"></a>
### [2026-10-02-model-ladder/p8-hidden-tool-dev-smoke/c6c958-adv-full/analysis.md](../benchmarks/2026-10-02-model-ladder/p8-hidden-tool-dev-smoke/c6c958-adv-full/analysis.md)

| Line | Row | Column | Was | Now |
|---|---|---|---|---|
| 3 | Spend in these records | spend total | | about 11% low |
| 32 | gpt-6-luna / c6c958-callfull-adv-full | uncached input $ | 0.0013 | 0.0000 |
| 32 | gpt-6-luna / c6c958-callfull-adv-full | cache write $ | 0.0000 | 0.0017 |
| 32 | gpt-6-luna / c6c958-callfull-adv-full | total_usd | 0.0031 | 0.0034 |

<a id="cw-ladder-p8-c6c958-adv-starter-analysis"></a>
### [2026-10-02-model-ladder/p8-hidden-tool-dev-smoke/c6c958-adv-starter/analysis.md](../benchmarks/2026-10-02-model-ladder/p8-hidden-tool-dev-smoke/c6c958-adv-starter/analysis.md)

| Line | Row | Column | Was | Now |
|---|---|---|---|---|
| 3 | Spend in these records | spend total | | about 16% low |
| 26 | gpt-6-luna / c6c958-callfull-adv-starter | $/task | 0.005 | 0.006 |
| 32 | gpt-6-luna / c6c958-callfull-adv-starter | uncached input $ | 0.0035 | 0.0000 |
| 32 | gpt-6-luna / c6c958-callfull-adv-starter | cache write $ | 0.0000 | 0.0044 |
| 32 | gpt-6-luna / c6c958-callfull-adv-starter | total_usd | 0.0055 | 0.0064 |

<a id="cw-ladder-p8-c6c958-adv-verbs-analysis"></a>
### [2026-10-02-model-ladder/p8-hidden-tool-dev-smoke/c6c958-adv-verbs/analysis.md](../benchmarks/2026-10-02-model-ladder/p8-hidden-tool-dev-smoke/c6c958-adv-verbs/analysis.md)

| Line | Row | Column | Was | Now |
|---|---|---|---|---|
| 3 | Spend in these records | spend total | | about 10% low |
| 26 | gpt-6-luna / c6c958-callfull-adv-verbs | $/task | 0.005 | 0.006 |
| 26 | gpt-6-luna / c6c958-callfull-adv-verbs | $/success | 0.107 | 0.117 |
| 32 | gpt-6-luna / c6c958-callfull-adv-verbs | uncached input $ | 0.0021 | 0.0000 |
| 32 | gpt-6-luna / c6c958-callfull-adv-verbs | cache write $ | 0.0000 | 0.0026 |
| 32 | gpt-6-luna / c6c958-callfull-adv-verbs | total_usd | 0.0053 | 0.0059 |

<a id="cw-w11-master-gated-analysis"></a>
### [2026-10-07-wave11-agent-smoke/master-gated/analysis.md](../benchmarks/2026-10-07-wave11-agent-smoke/master-gated/analysis.md)

| Line | Row | Column | Was | Now |
|---|---|---|---|---|
| 3 | Spend in these records | spend total | | about 2% low |
| 32 | gpt-6.1-sol / master | $/task | 0.042 | 0.049 |
| 32 | gpt-6.1-sol / master | $/success | 0.042 | 0.049 |
| 40 | gpt-6.1-sol / master | uncached input $ | 0.0301 | 0.0000 |
| 40 | gpt-6.1-sol / master | cache write $ | 0.0000 | 0.0375 |
| 40 | gpt-6.1-sol / master | total_usd | 0.0416 | 0.0491 |

<a id="cw-w11-master-sentinel-analysis"></a>
### [2026-10-07-wave11-agent-smoke/master-sentinel/analysis.md](../benchmarks/2026-10-07-wave11-agent-smoke/master-sentinel/analysis.md)

| Line | Row | Column | Was | Now |
|---|---|---|---|---|
| 3 | Spend in these records | spend total | | about 3% low |
| 32 | gpt-6.1-sol / master | $/task | 0.046 | 0.055 |
| 32 | gpt-6.1-sol / master | $/success | 0.046 | 0.055 |
| 40 | gpt-6.1-sol / master | uncached input $ | 0.0380 | 0.0000 |
| 40 | gpt-6.1-sol / master | cache write $ | 0.0000 | 0.0475 |
| 40 | gpt-6.1-sol / master | total_usd | 0.0460 | 0.0555 |

<a id="cw-w11-wave11-gated-analysis"></a>
### [2026-10-07-wave11-agent-smoke/wave11-gated/analysis.md](../benchmarks/2026-10-07-wave11-agent-smoke/wave11-gated/analysis.md)

| Line | Row | Column | Was | Now |
|---|---|---|---|---|
| 3 | Spend in these records | spend total | | about 2% low |
| 32 | gpt-6.1-sol / wave11 | $/task | 0.039 | 0.046 |
| 32 | gpt-6.1-sol / wave11 | $/success | 0.039 | 0.046 |
| 40 | gpt-6.1-sol / wave11 | uncached input $ | 0.0276 | 0.0000 |
| 40 | gpt-6.1-sol / wave11 | cache write $ | 0.0000 | 0.0344 |
| 40 | gpt-6.1-sol / wave11 | total_usd | 0.0390 | 0.0459 |

<a id="cw-w11-wave11-sentinel-analysis"></a>
### [2026-10-07-wave11-agent-smoke/wave11-sentinel/analysis.md](../benchmarks/2026-10-07-wave11-agent-smoke/wave11-sentinel/analysis.md)

| Line | Row | Column | Was | Now |
|---|---|---|---|---|
| 3 | Spend in these records | spend total | | about 3% low |
| 32 | gpt-6.1-sol / wave11 | $/task | 0.048 | 0.058 |
| 32 | gpt-6.1-sol / wave11 | $/success | 0.048 | 0.058 |
| 40 | gpt-6.1-sol / wave11 | uncached input $ | 0.0400 | 0.0000 |
| 40 | gpt-6.1-sol / wave11 | cache write $ | 0.0000 | 0.0500 |
| 40 | gpt-6.1-sol / wave11 | total_usd | 0.0484 | 0.0585 |

<a id="cw-w12-baseline-gated-analysis"></a>
### [2026-10-07-wave12-agent-smoke/baseline-gated/analysis.md](../benchmarks/2026-10-07-wave12-agent-smoke/baseline-gated/analysis.md)

| Line | Row | Column | Was | Now |
|---|---|---|---|---|
| 3 | Spend in these records | spend total | | about 2% low |
| 32 | gpt-6.1-sol / baseline | $/task | 0.038 | 0.044 |
| 32 | gpt-6.1-sol / baseline | $/success | 0.038 | 0.044 |
| 40 | gpt-6.1-sol / baseline | uncached input $ | 0.0261 | 0.0000 |
| 40 | gpt-6.1-sol / baseline | cache write $ | 0.0000 | 0.0325 |
| 40 | gpt-6.1-sol / baseline | total_usd | 0.0376 | 0.0441 |

<a id="cw-w12-wave12-gated-analysis"></a>
### [2026-10-07-wave12-agent-smoke/wave12-gated/analysis.md](../benchmarks/2026-10-07-wave12-agent-smoke/wave12-gated/analysis.md)

| Line | Row | Column | Was | Now |
|---|---|---|---|---|
| 3 | Spend in these records | spend total | | about 2% low |
| 32 | gpt-6.1-sol / wave12 | $/task | 0.037 | 0.043 |
| 32 | gpt-6.1-sol / wave12 | $/success | 0.037 | 0.043 |
| 40 | gpt-6.1-sol / wave12 | uncached input $ | 0.0255 | 0.0000 |
| 40 | gpt-6.1-sol / wave12 | cache write $ | 0.0000 | 0.0318 |
| 40 | gpt-6.1-sol / wave12 | total_usd | 0.0365 | 0.0429 |

<a id="cw-hardconf-analysis-main"></a>
### [2026-10-10-model-ladder-hard-confirmation/analysis-main.md](../benchmarks/2026-10-10-model-ladder-hard-confirmation/analysis-main.md)

The high ends include the long-context rates for sessions that could pass 272,000 input tokens.

| Line | Row | Column | Was | Now |
|---|---|---|---|---|
| 5 | Spend over every attempt | spend total | | 2% to 5% low |
| 24 | fs / H1 | $/task | $1.1019 | $1.1223 to $1.2213 |
| 24 | fs / H1 | $/success | $6.0103 | $6.1215 to $6.6618 |
| 25 | fs / H2 | $/task | $0.9964 | $1.0023 to $1.0025 |
| 25 | fs / H2 | $/success | $1.2996 | $1.3074 to $1.3076 |
| 26 | fs / H3 | $/task | $0.8964 | $0.9034 to $0.9035 |
| 26 | fs / H3 | $/success | $1.1205 | $1.1292 to $1.1294 |
| 27 | fs / H4 | $/task | $1.1299 | $1.1368 to $1.1370 |
| 27 | fs / H4 | $/success | $1.2107 | $1.2180 to $1.2182 |
| 28 | fs / H5 | $/task | $0.8229 | $0.8375 to $0.8384 |
| 28 | fs / H5 | $/success | $0.9495 | $0.9664 to $0.9674 |
| 29 | fs / all | $/task | $0.9895 | $1.0005 to $1.0205 |
| 29 | fs / all | $/success | $1.3937 | $1.4091 to $1.4374 |
| 30 | gbrain-hard / H1 | $/task | $0.9975 | $1.0242 to $1.1397 |
| 30 | gbrain-hard / H1 | $/success | $3.3250 | $3.4140 to $3.7988 |
| 31 | gbrain-hard / H2 | $/task | $0.4584 | $0.4776 to $0.4857 |
| 31 | gbrain-hard / H2 | $/success | $0.5094 | $0.5306 to $0.5397 |
| 32 | gbrain-hard / H3 | $/task | $0.6173 | $0.6349 |
| 32 | gbrain-hard / H3 | $/success | $0.6497 | $0.6683 |
| 33 | gbrain-hard / H4 | $/task | $0.4785 | $0.4968 to $0.5159 |
| 33 | gbrain-hard / H4 | $/success | $0.6108 | $0.6342 to $0.6585 |
| 34 | gbrain-hard / H5 | $/task | $0.3449 | $0.3528 |
| 34 | gbrain-hard / H5 | $/success | $0.3449 | $0.3528 |
| 35 | gbrain-hard / all | $/task | $0.5793 | $0.5973 to $0.6258 |
| 35 | gbrain-hard / all | $/success | $0.7364 | $0.7592 to $0.7955 |
| 60 | gpt-6.1-sol / fs | $/task (all attempts) | $0.1897 | $0.2226 to $0.2829 |
| 60 | gpt-6.1-sol / fs | $/success | $0.2371 | $0.2783 to $0.3536 |
| 61 | gpt-6.1-sol / gbrain-hard | $/task (all attempts) | $0.2812 | $0.3351 to $0.4207 |
| 61 | gpt-6.1-sol / gbrain-hard | $/success | $0.3196 | $0.3808 to $0.4780 |
| 71 | gpt-6.1-sol / gbrain-hard | Δ $/task | $0.0915 | $0.1124 to $0.1378 |
| 71 | gpt-6.1-sol / gbrain-hard | $ per extra success | $1.1439 | $1.4055 to $1.7223 |
| 72 | all / gbrain-hard | Δ $/task | $-0.4102 | $-0.4032 to $-0.3948 |
| 72 | all / gbrain-hard | $ per extra success | $-5.3502 | $-5.2592 to $-5.1490 |

<a id="cw-ladder-er-headline-a714410a5"></a>
### [2026-10-02-model-ladder/entity-recall/headline-a714410a5.md](../benchmarks/2026-10-02-model-ladder/entity-recall/headline-a714410a5.md)

The high ends include the long-context rates for sessions that could pass 272,000 input tokens.

| Line | Row | Column | Was | Now |
|---|---|---|---|---|
| 101 | oracle | $/task | 0.0070 | 0.0072 |
| 101 | oracle | $/success | 0.0072 | 0.0073 |
| 102 | fs | $/task | 0.0323 | 0.0329 to 0.0330 |
| 102 | fs | $/success | 0.0444 | 0.0452 to 0.0453 |
| 103 | fs-acl | $/task | 0.0186 | 0.0189 to 0.0190 |
| 103 | fs-acl | $/success | 0.0225 | 0.0230 to 0.0231 |
| 104 | pg | $/task | 0.0212 | 0.0217 to 0.0218 |
| 104 | pg | $/success | 0.0321 | 0.0328 to 0.0330 |
| 105 | memory | $/task | 0.1380 | 0.1431 to 0.1529 |
| 105 | memory | $/success | 0.2179 | 0.2259 to 0.2415 |
| 106 | gbrain-c1234-holdout | $/task | 0.0800 | 0.0822 |
| 106 | gbrain-c1234-holdout | $/success | 0.1057 | 0.1087 |
| 132 | gpt-6.1-sol / fs | $/task | 0.0223 | 0.0257 to 0.0263 |
| 133 | gpt-6.1-sol / pg | $/task | 0.0185 | 0.0213 to 0.0219 |
| 134 | gpt-6.1-sol / memory | $/task | 0.1869 | 0.2171 to 0.2764 |
| 135 | gpt-6.1-sol / gbrain-c1234-holdout | $/task | 0.0648 | 0.0783 |
| 160 | fs | $/task | 0.0323 | 0.0329 to 0.0330 |
| 161 | memory | $/task | 0.1380 | 0.1431 to 0.1529 |
| 162 | pg | $/task | 0.0212 | 0.0217 to 0.0218 |
| 231 | gpt-6.1-sol | gbrain-c1234-holdout $/task | 0.0648 | 0.0783 |
| 231 | gpt-6.1-sol | gbrain-c1234-holdout $/success | 0.0648 | 0.0783 |
| 231 | gpt-6.1-sol | fs $/task | 0.0223 | 0.0257 to 0.0263 |
| 231 | gpt-6.1-sol | fs $/success | 0.0223 | 0.0257 to 0.0263 |
| 231 | gpt-6.1-sol | oracle $/task | 0.0046 | 0.0054 |
| 231 | gpt-6.1-sol | oracle $/success | 0.0046 | 0.0054 |
| 231 | gpt-6.1-sol | pg $/task | 0.0185 | 0.0213 to 0.0219 |
| 231 | gpt-6.1-sol | pg $/success | 0.0194 | 0.0224 to 0.0231 |
| 231 | gpt-6.1-sol | memory $/task | 0.1869 | 0.2171 to 0.2764 |
| 231 | gpt-6.1-sol | memory $/success | 0.2173 | 0.2525 to 0.3214 |
| 232 | all | gbrain-c1234-holdout $/task | 0.0800 | 0.0822 |
| 232 | all | gbrain-c1234-holdout $/success | 0.1057 | 0.1087 |
| 232 | all | fs $/task | 0.0323 | 0.0329 to 0.0330 |
| 232 | all | fs $/success | 0.0444 | 0.0452 to 0.0453 |
| 232 | all | oracle $/task | 0.0070 | 0.0072 |
| 232 | all | oracle $/success | 0.0072 | 0.0073 |
| 232 | all | pg $/task | 0.0212 | 0.0217 to 0.0218 |
| 232 | all | pg $/success | 0.0321 | 0.0328 to 0.0330 |
| 232 | all | memory $/task | 0.1380 | 0.1431 to 0.1529 |
| 232 | all | memory $/success | 0.2179 | 0.2259 to 0.2415 |
| 234 | Spend in these records | spend total | | 3% to 6% low |
| 235 | oracle | spend total | | about 1% low |
| 236 | fs | spend total | | about 2% low |
| 237 | fs-acl | spend total | | about 2% low |
| 238 | pg | spend total | | about 2% low |
| 239 | memory | spend total | | 4% to 11% low |
| 240 | gbrain-c1234-holdout | spend total | | about 3% low |

<a id="cw-ladder-er-holdout-headline-wave"></a>
### [2026-10-02-model-ladder/entity-recall/holdout/headline-wave.md](../benchmarks/2026-10-02-model-ladder/entity-recall/holdout/headline-wave.md)

The high ends include the long-context rates for sessions that could pass 272,000 input tokens.

| Line | Row | Column | Was | Now |
|---|---|---|---|---|
| 83 | oracle | $/task | 0.0217 | 0.0223 |
| 83 | oracle | $/success | 0.0223 | 0.0228 |
| 84 | fs | $/task | 0.1116 | 0.1153 to 0.1160 |
| 84 | fs | $/success | 0.1167 | 0.1206 to 0.1213 |
| 85 | fs-acl | $/task | 0.0610 | 0.0632 to 0.0638 |
| 85 | fs-acl | $/success | 0.0616 | 0.0638 to 0.0644 |
| 86 | pg | $/task | 0.0880 | 0.0910 to 0.0917 |
| 86 | pg | $/success | 0.0978 | 0.1012 to 0.1019 |
| 87 | memory | $/task | 0.2283 | 0.2434 to 0.2731 |
| 87 | memory | $/success | 0.2819 | 0.3006 to 0.3372 |
| 88 | gbrain-entity-holdout | $/task | 0.2382 | 0.2485 |
| 88 | gbrain-entity-holdout | $/success | 0.2492 | 0.2599 |
| 98 | gpt-6.1-sol / fs | $/task | 0.0223 | 0.0257 to 0.0263 |
| 99 | gpt-6.1-sol / pg | $/task | 0.0185 | 0.0213 to 0.0219 |
| 100 | gpt-6.1-sol / memory | $/task | 0.1869 | 0.2171 to 0.2764 |
| 101 | gpt-6.1-sol / gbrain-entity-holdout | $/task | 0.0481 | 0.0577 |
| 108 | gpt-6-astra / fs | $/task | 0.1126 | 0.1277 to 0.1307 |
| 109 | gpt-6-astra / pg | $/task | 0.0889 | 0.1011 to 0.1039 |
| 110 | gpt-6-astra / gbrain-entity-holdout | $/task | 0.2389 | 0.2808 |
| 163 | gpt-6.1-sol | gbrain-entity-holdout $/task | 0.0481 | 0.0577 |
| 163 | gpt-6.1-sol | gbrain-entity-holdout $/success | 0.0481 | 0.0577 |
| 163 | gpt-6.1-sol | fs $/task | 0.0223 | 0.0257 to 0.0263 |
| 163 | gpt-6.1-sol | fs $/success | 0.0223 | 0.0257 to 0.0263 |
| 163 | gpt-6.1-sol | oracle $/task | 0.0046 | 0.0054 |
| 163 | gpt-6.1-sol | oracle $/success | 0.0046 | 0.0054 |
| 163 | gpt-6.1-sol | pg $/task | 0.0185 | 0.0213 to 0.0219 |
| 163 | gpt-6.1-sol | pg $/success | 0.0194 | 0.0224 to 0.0231 |
| 163 | gpt-6.1-sol | memory $/task | 0.1869 | 0.2171 to 0.2764 |
| 163 | gpt-6.1-sol | memory $/success | 0.2173 | 0.2525 to 0.3214 |
| 166 | gpt-6-astra | gbrain-entity-holdout $/task | 0.2389 | 0.2808 |
| 166 | gpt-6-astra | gbrain-entity-holdout $/success | 0.2438 | 0.2865 |
| 166 | gpt-6-astra | fs $/task | 0.1126 | 0.1277 to 0.1307 |
| 166 | gpt-6-astra | fs $/success | 0.1149 | 0.1303 to 0.1334 |
| 166 | gpt-6-astra | oracle $/task | 0.0162 | 0.0181 |
| 166 | gpt-6-astra | oracle $/success | 0.0162 | 0.0181 |
| 166 | gpt-6-astra | pg $/task | 0.0889 | 0.1011 to 0.1039 |
| 166 | gpt-6-astra | pg $/success | 0.0926 | 0.1053 to 0.1082 |
| 167 | all | gbrain-entity-holdout $/task | 0.2382 | 0.2485 |
| 167 | all | gbrain-entity-holdout $/success | 0.2492 | 0.2599 |
| 167 | all | fs $/task | 0.1116 | 0.1153 to 0.1160 |
| 167 | all | fs $/success | 0.1167 | 0.1206 to 0.1213 |
| 167 | all | oracle $/task | 0.0217 | 0.0223 |
| 167 | all | oracle $/success | 0.0223 | 0.0228 |
| 167 | all | pg $/task | 0.0880 | 0.0910 to 0.0917 |
| 167 | all | pg $/success | 0.0978 | 0.1012 to 0.1019 |
| 167 | all | memory $/task | 0.2283 | 0.2434 to 0.2731 |
| 167 | all | memory $/success | 0.2819 | 0.3006 to 0.3372 |
| 169 | Spend in these records | spend total | | 4% to 6% low |
| 170 | oracle | spend total | | about 2% low |
| 171 | fs | spend total | | 3% to 4% low |
| 172 | fs-acl | spend total | | about 4% low |
| 173 | pg | spend total | | 3% to 4% low |
| 174 | memory | spend total | | 7% to 19% low |
| 175 | gbrain-entity-holdout | spend total | | about 4% low |

<a id="cw-ladder-er-holdout-ship-rule-and-default-on"></a>
### [2026-10-02-model-ladder/entity-recall/holdout/ship-rule-and-default-on.md](../benchmarks/2026-10-02-model-ladder/entity-recall/holdout/ship-rule-and-default-on.md)

| Line | Row | Column | Was | Now |
|---|---|---|---|---|
| 75 | gbrain-c1234-holdout | $/task | 0.3230 | 0.3379 |
| 75 | gbrain-c1234-holdout | $/success | 0.3393 | 0.3550 |
| 76 | gbrain-entity-holdout | $/task | 0.2382 | 0.2485 |
| 76 | gbrain-entity-holdout | $/success | 0.2492 | 0.2599 |
| 84 | gpt-6.1-sol / gbrain-c1234-holdout | $/task | 0.0648 | 0.0783 |
| 85 | gpt-6.1-sol / gbrain-entity-holdout | $/task | 0.0481 | 0.0577 |
| 90 | gpt-6-astra / gbrain-c1234-holdout | $/task | 0.3299 | 0.3911 |
| 91 | gpt-6-astra / gbrain-entity-holdout | $/task | 0.2389 | 0.2808 |
| 126 | Cost per task |  | $0.2382 | $0.2485 |
| 126 | Cost per task |  | $0.3230 | $0.3379 |
| 126 | Cost per task |  | -26.2% | -26.5% |
| 130 | Spend in these records | spend total | | about 4% low |
| 131 | gbrain-c1234-holdout | spend total | | about 5% low |
| 132 | gbrain-entity-holdout | spend total | | about 4% low |

<a id="cw-ladder-followups-holdout-ship-rule"></a>
### [2026-10-02-model-ladder/followups/holdout/ship-rule.md](../benchmarks/2026-10-02-model-ladder/followups/holdout/ship-rule.md)

The high ends include the long-context rates for sessions that could pass 272,000 input tokens.

| Line | Row | Column | Was | Now |
|---|---|---|---|---|
| 81 | gbrain-566a242a-control | $/task | 0.1181 | 0.1215 to 0.1223 |
| 81 | gbrain-566a242a-control | $/success | 0.1607 | 0.1653 to 0.1664 |
| 82 | gbrain-c1234-holdout | $/task | 0.0800 | 0.0822 |
| 82 | gbrain-c1234-holdout | $/success | 0.1057 | 0.1087 |
| 98 | gpt-6.1-sol / gbrain-566a242a-control | $/task | 0.0966 | 0.1169 to 0.1219 |
| 99 | gpt-6.1-sol / gbrain-c1234-holdout | $/task | 0.0648 | 0.0783 |
| 130 | Spend in these records | spend total | | about 3% low |
| 131 | gbrain-566a242a-control | spend total | | about 3% low |
| 132 | gbrain-c1234-holdout | spend total | | about 3% low |

<a id="cw-ladder-holdout-holdout-stats"></a>
### [2026-10-02-model-ladder/holdout/holdout-stats.md](../benchmarks/2026-10-02-model-ladder/holdout/holdout-stats.md)

The high ends include the long-context rates for sessions that could pass 272,000 input tokens.

| Line | Row | Column | Was | Now |
|---|---|---|---|---|
| 93 | oracle | $/task | 0.0070 | 0.0072 |
| 93 | oracle | $/success | 0.0072 | 0.0073 |
| 94 | fs | $/task | 0.0323 | 0.0329 to 0.0330 |
| 94 | fs | $/success | 0.0444 | 0.0452 to 0.0453 |
| 95 | fs-acl | $/task | 0.0186 | 0.0189 to 0.0190 |
| 95 | fs-acl | $/success | 0.0225 | 0.0230 to 0.0231 |
| 96 | pg | $/task | 0.0212 | 0.0217 to 0.0218 |
| 96 | pg | $/success | 0.0321 | 0.0328 to 0.0330 |
| 97 | memory | $/task | 0.1380 | 0.1431 to 0.1529 |
| 97 | memory | $/success | 0.2179 | 0.2259 to 0.2415 |
| 98 | gbrain-base | $/task | 0.0976 | 0.1002 |
| 98 | gbrain-base | $/success | 0.1570 | 0.1611 |
| 99 | gbrain-next-51a30c1 | $/task | 0.1093 | 0.1120 |
| 99 | gbrain-next-51a30c1 | $/success | 0.1369 | 0.1403 |
| 100 | gbrain-next | $/task | 0.1302 | 0.1333 |
| 100 | gbrain-next | $/success | 0.1652 | 0.1691 |
| 136 | gpt-6.1-sol / fs | $/task | 0.0223 | 0.0257 to 0.0263 |
| 137 | gpt-6.1-sol / pg | $/task | 0.0185 | 0.0213 to 0.0219 |
| 138 | gpt-6.1-sol / memory | $/task | 0.1869 | 0.2171 to 0.2764 |
| 139 | gpt-6.1-sol / gbrain-base | $/task | 0.0775 | 0.0929 |
| 140 | gpt-6.1-sol / gbrain-next-51a30c1 | $/task | 0.0809 | 0.0971 |
| 141 | gpt-6.1-sol / gbrain-next | $/task | 0.0917 | 0.1103 |
| 238 | Spend in these records | spend total | | 3% to 4% low |
| 239 | oracle | spend total | | about 1% low |
| 240 | fs | spend total | | about 2% low |
| 241 | fs-acl | spend total | | about 2% low |
| 242 | pg | spend total | | about 2% low |
| 243 | memory | spend total | | 4% to 11% low |
| 244 | gbrain-base | spend total | | about 3% low |
| 245 | gbrain-next-51a30c1 | spend total | | about 2% low |
| 246 | gbrain-next | spend total | | about 2% low |

<a id="cw-hard07-holdout-stats"></a>
### [2026-10-07-model-ladder-hard/holdout-stats.md](../benchmarks/2026-10-07-model-ladder-hard/holdout-stats.md)

The high ends include the long-context rates for sessions that could pass 272,000 input tokens.

| Line | Row | Column | Was | Now |
|---|---|---|---|---|
| 65 | fs | $/task | 0.9770 | 0.9876 to 0.9959 |
| 65 | fs | $/success | 1.3323 | 1.3467 to 1.3581 |
| 66 | pg | $/task | 0.2905 | 0.3005 to 0.3008 |
| 66 | pg | $/success | 0.4252 | 0.4398 to 0.4403 |
| 67 | gbrain-hard | $/task | 0.6933 | 0.7160 to 0.7810 |
| 67 | gbrain-hard | $/success | 1.1183 | 1.1548 to 1.2596 |
| 79 | gpt-6.1-sol / fs | $/task | 0.1808 | 0.2123 to 0.2374 |
| 80 | gpt-6.1-sol / pg | $/task | 0.1624 | 0.1924 to 0.1933 |
| 81 | gpt-6.1-sol / gbrain-hard | $/task | 0.3574 | 0.4252 to 0.6202 |
| 126 | gpt-6.1-sol | gbrain-hard $/task | 0.3574 | 0.4252 to 0.6202 |
| 126 | gpt-6.1-sol | gbrain-hard $/success | 0.4467 | 0.5315 to 0.7752 |
| 126 | gpt-6.1-sol | fs $/task | 0.1808 | 0.2123 to 0.2374 |
| 126 | gpt-6.1-sol | fs $/success | 0.2232 | 0.2621 to 0.2931 |
| 127 | all | gbrain-hard $/task | 0.6933 | 0.7160 to 0.7810 |
| 127 | all | gbrain-hard $/success | 1.1183 | 1.1548 to 1.2596 |
| 127 | all | fs $/task | 0.9770 | 0.9876 to 0.9959 |
| 127 | all | fs $/success | 1.3323 | 1.3467 to 1.3581 |
| 141 | Spend in these records | spend total | | 2% to 6% low |
| 142 | fs | spend total | | 1% to 2% low |
| 143 | pg | spend total | | about 3% low |
| 144 | gbrain-hard | spend total | | 3% to 12% low |

<a id="cw-hard07-holdout-stats-with-fable-descriptive"></a>
### [2026-10-07-model-ladder-hard/holdout-stats-with-fable-descriptive.md](../benchmarks/2026-10-07-model-ladder-hard/holdout-stats-with-fable-descriptive.md)

The high ends include the long-context rates for sessions that could pass 272,000 input tokens.

| Line | Row | Column | Was | Now |
|---|---|---|---|---|
| 69 | fs | $/task | 1.4173 | 1.4256 to 1.4322 |
| 69 | fs | $/success | 2.2942 | 2.3076 to 2.3182 |
| 70 | gbrain-hard | $/task | 1.4017 | 1.4195 to 1.4708 |
| 70 | gbrain-hard | $/success | 2.2380 | 2.2665 to 2.3484 |
| 80 | gpt-6.1-sol / fs | $/task | 0.1808 | 0.2123 to 0.2374 |
| 81 | gpt-6.1-sol / gbrain-hard | $/task | 0.3574 | 0.4252 to 0.6202 |
| 94 | Spend in these records | spend total | | 1% to 3% low |
| 95 | fs | spend total | | about 1% low |
| 96 | gbrain-hard | spend total | | 1% to 5% low |

<a id="cw-hardconf-holdout-stats-main"></a>
### [2026-10-10-model-ladder-hard-confirmation/holdout-stats-main.md](../benchmarks/2026-10-10-model-ladder-hard-confirmation/holdout-stats-main.md)

The high ends include the long-context rates for sessions that could pass 272,000 input tokens.

| Line | Row | Column | Was | Now |
|---|---|---|---|---|
| 63 | fs | $/task | 0.9895 | 1.0005 to 1.0205 |
| 63 | fs | $/success | 1.3937 | 1.4091 to 1.4374 |
| 64 | gbrain-hard | $/task | 0.5793 | 0.5973 to 0.6258 |
| 64 | gbrain-hard | $/success | 0.7364 | 0.7592 to 0.7955 |
| 74 | gpt-6.1-sol / fs | $/task | 0.1897 | 0.2226 to 0.2829 |
| 75 | gpt-6.1-sol / gbrain-hard | $/task | 0.2812 | 0.3351 to 0.4207 |
| 119 | gpt-6.1-sol | gbrain-hard $/task | 0.2812 | 0.3351 to 0.4207 |
| 119 | gpt-6.1-sol | gbrain-hard $/success | 0.3196 | 0.3808 to 0.4780 |
| 119 | gpt-6.1-sol | fs $/task | 0.1897 | 0.2226 to 0.2829 |
| 119 | gpt-6.1-sol | fs $/success | 0.2371 | 0.2783 to 0.3536 |
| 119 | gpt-6.1-sol | $ per extra success | 1.1439 | 1.4055 to 1.7223 |
| 120 | all | gbrain-hard $/task | 0.5793 | 0.5973 to 0.6258 |
| 120 | all | gbrain-hard $/success | 0.7364 | 0.7592 to 0.7955 |
| 120 | all | fs $/task | 0.9895 | 1.0005 to 1.0205 |
| 120 | all | fs $/success | 1.3937 | 1.4091 to 1.4374 |
| 120 | all | $ per extra success | -5.3502 | -5.2592 to -5.1490 |
| 134 | Spend in these records | spend total | | 2% to 5% low |
| 135 | fs | spend total | | 1% to 3% low |
| 136 | gbrain-hard | spend total | | 3% to 8% low |

<a id="cw-hardconf-analysis-sealed"></a>
### [2026-10-10-model-ladder-hard-confirmation/analysis-sealed.md](../benchmarks/2026-10-10-model-ladder-hard-confirmation/analysis-sealed.md)

World S's rows aren't committed, so this page's gpt-6.1-sol cells can't be recomputed. On world M the correction raises Sol's gbrain dollars per success by 19% to 42%, its fs dollars per success by 17% to 48% and the page's spend line by 2% to 5%, the high ends with the long-context rates; world S is likely similar but unmeasured.

<a id="cw-long-tier"></a>
### The long-context tier

OpenAI bills a request over 272,000 input tokens at long-context rates for gpt-6.1-sol, gpt-6-sol, gpt-6-luna and gpt-6-astra, and Cat 40's price code never applied them. Budget ledgers did from `8a8e502a` (October 8) for gpt-6.1-sol, gpt-6-luna and gpt-6-astra, though the ledger's gpt-6-sol entry (`eval/runner/budget-ledger.ts`) still has neither the cache-write price nor the tier; no committed post-fix run used gpt-6-sol. The rows hold each session's token totals and request count, not each request's prompt, so the audit can only bound which requests passed the line. A session could have held one if its uncached input plus its output plus the first request's cache hit (at most the smaller of its cache reads and its mean prompt) passes 272,000 tokens, because a session's prompt only grows and each request reads from the cache at most what came before it. A session must have held one if its mean prompt passes 272,000 tokens. Counting each cell once (a round's results.jsonl beside its attempts.jsonl, the pilot's first run and the rescored simple arms repeat other rows), 222 sessions could have held such a request and 6 must have: six gpt-6.1-sol memory sessions in the scale tier, whose uncapped directory listings filled the prompt. No row says which requests passed the line, so every tier share in this audit is a bound.

| Rows | Model | Arm | Sessions | Could pass 272k | Must |
|---|---|---|---|---|---|
| [2026-10-02-model-ladder/baseline-uncapped/results.jsonl](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/results.jsonl) | gpt-6-sol | gbrain | 152 | 15 | 0 |
| [2026-10-02-model-ladder/baseline-uncapped/results.jsonl](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/results.jsonl) | gpt-6-astra | memory | 152 | 3 | 0 |
| [2026-10-02-model-ladder/baseline-uncapped/results.jsonl](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/results.jsonl) | gpt-6.1-sol | memory | 152 | 6 | 0 |
| [2026-10-02-model-ladder/fix-wave-ladder/results.jsonl](../benchmarks/2026-10-02-model-ladder/fix-wave-ladder/results.jsonl) | gpt-6-sol | gbrain-next | 60 | 1 | 0 |
| [2026-10-02-model-ladder/followups/control/results.jsonl](../benchmarks/2026-10-02-model-ladder/followups/control/results.jsonl) | gpt-6.1-sol | gbrain-566a242a-control | 120 | 1 | 0 |
| [2026-10-02-model-ladder/holdout/results.jsonl](../benchmarks/2026-10-02-model-ladder/holdout/results.jsonl) | gpt-6.1-sol | memory | 120 | 9 | 0 |
| [2026-10-02-model-ladder/scale-tier/results.jsonl](../benchmarks/2026-10-02-model-ladder/scale-tier/results.jsonl) | gpt-6.1-sol | memory | 36 | 36 | 6 |
| [2026-10-02-model-ladder/scale-tier/results.jsonl](../benchmarks/2026-10-02-model-ladder/scale-tier/results.jsonl) | gpt-6.1-sol | gbrain | 60 | 1 | 0 |
| [2026-10-07-model-ladder-hard/cells-50k/results.jsonl](../benchmarks/2026-10-07-model-ladder-hard/cells-50k/results.jsonl) | gpt-6.1-sol | gbrain-hard | 180 | 27 | 0 |
| [2026-10-07-model-ladder-hard/cells-50k/results.jsonl](../benchmarks/2026-10-07-model-ladder-hard/cells-50k/results.jsonl) | gpt-6.1-sol | fs | 180 | 4 | 0 |
| [2026-10-10-model-ladder-hard-confirmation/main-cells/results.jsonl](../benchmarks/2026-10-10-model-ladder-hard-confirmation/main-cells/results.jsonl) | gpt-6.1-sol | gbrain-hard | 180 | 13 | 0 |
| [2026-10-10-model-ladder-hard-confirmation/main-cells/results.jsonl](../benchmarks/2026-10-10-model-ladder-hard-confirmation/main-cells/results.jsonl) | gpt-6.1-sol | fs | 180 | 9 | 0 |
| [2026-10-13-cat40-dev-round-1/all-on/attempts.jsonl](../benchmarks/2026-10-13-cat40-dev-round-1/all-on/attempts.jsonl) | gpt-6.1-sol | gbrain-dev-r1-all-on | 180 | 8 | 0 |
| [2026-10-13-cat40-dev-round-1/control/attempts.jsonl](../benchmarks/2026-10-13-cat40-dev-round-1/control/attempts.jsonl) | gpt-6.1-sol | gbrain-dev-r1-control | 180 | 7 | 0 |
| [2026-10-13-cat40-dev-round-1/f5/attempts.jsonl](../benchmarks/2026-10-13-cat40-dev-round-1/f5/attempts.jsonl) | gpt-6.1-sol | gbrain-dev-r1-f5 | 180 | 3 | 0 |
| [2026-10-13-cat40-dev-round-2/all-on/attempts.jsonl](../benchmarks/2026-10-13-cat40-dev-round-2/all-on/attempts.jsonl) | gpt-6.1-sol | gbrain-dev-r2-all-on | 180 | 6 | 0 |
| [2026-10-13-cat40-dev-round-2/control/attempts.jsonl](../benchmarks/2026-10-13-cat40-dev-round-2/control/attempts.jsonl) | gpt-6.1-sol | gbrain-dev-r2-control | 180 | 7 | 0 |
| [2026-10-13-cat40-dev-round-2/f5/attempts.jsonl](../benchmarks/2026-10-13-cat40-dev-round-2/f5/attempts.jsonl) | gpt-6.1-sol | gbrain-dev-r2-f5 | 180 | 8 | 0 |
| [2026-10-13-cat40-dev-round-3/all-on-no-f5/attempts.jsonl](../benchmarks/2026-10-13-cat40-dev-round-3/all-on-no-f5/attempts.jsonl) | gpt-6.1-sol | gbrain-dev-r3-all-on-no-f5 | 180 | 9 | 0 |
| [2026-10-14-cat40-next-confirm-public/p1/baseline/attempts.jsonl](../benchmarks/2026-10-14-cat40-next-confirm-public/p1/baseline/attempts.jsonl) | gpt-6.1-sol | gbrain-next-baseline | 180 | 8 | 0 |
| [2026-10-14-cat40-next-confirm-public/p1/fs/attempts.jsonl](../benchmarks/2026-10-14-cat40-next-confirm-public/p1/fs/attempts.jsonl) | gpt-6.1-sol | fs | 180 | 7 | 0 |
| [2026-10-14-cat40-next-confirm-public/p1/wave/attempts.jsonl](../benchmarks/2026-10-14-cat40-next-confirm-public/p1/wave/attempts.jsonl) | gpt-6.1-sol | gbrain-next-wave | 180 | 8 | 0 |
| [2026-10-14-cat40-next-confirm-public/p2/baseline/attempts.jsonl](../benchmarks/2026-10-14-cat40-next-confirm-public/p2/baseline/attempts.jsonl) | gpt-6.1-sol | gbrain-next-baseline | 180 | 8 | 0 |
| [2026-10-14-cat40-next-confirm-public/p2/fs/attempts.jsonl](../benchmarks/2026-10-14-cat40-next-confirm-public/p2/fs/attempts.jsonl) | gpt-6.1-sol | fs | 180 | 6 | 0 |
| [2026-10-14-cat40-next-confirm-public/p2/wave/attempts.jsonl](../benchmarks/2026-10-14-cat40-next-confirm-public/p2/wave/attempts.jsonl) | gpt-6.1-sol | gbrain-next-wave | 180 | 12 | 0 |

<a id="cw-orderings"></a>
### Orderings in the repriced tables

These pairs swap order in the repriced rows at one or both ends of the range (108 pair-and-end entries in `order_changes`). Each is an ordering the rows imply, in a generated table or, for dev round 1, in the per-model rows behind its arm totals, not one a report states: the stated comparisons (gbrain about twice files per task on the first world, gbrain cheaper than files on the October 7 Hard world, gbrain dearer than files for Sol on the confirmation's world M, the wave cheaper than files on next-confirm) all hold at both ends.

| Rows | Metric | Within | Was cheaper, now dearer | Ends |
|---|---|---|---|---|
| [2026-10-02-model-ladder/baseline-uncapped/analysis.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis.md) | $/task | arm fs | gpt-6.1-sol against claude-haiku-4-5 | both |
| [2026-10-02-model-ladder/baseline-uncapped/analysis.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis.md) | $/task | arm pg | gpt-6.1-sol against gpt-5.4 | both |
| [2026-10-02-model-ladder/baseline-uncapped/analysis.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis.md) | $/task | arm memory | gpt-6.1-sol against claude-sonnet-4-6 | both |
| [2026-10-02-model-ladder/baseline-uncapped/analysis.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis.md) | $/task | arm memory | gpt-6.1-sol against claude-sonnet-5 | high |
| [2026-10-02-model-ladder/baseline-uncapped/analysis.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis.md) | $/task | arm gbrain | gpt-6-sol against claude-sonnet-4-6 | high |
| [2026-10-02-model-ladder/baseline-uncapped/analysis.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis.md) | $/task | arm gbrain | gpt-6-sol against claude-sonnet-5 | high |
| [2026-10-02-model-ladder/baseline-uncapped/analysis.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis.md) | $/task | arm gbrain | gpt-6-sol against claude-sonnet-5-5 | high |
| [2026-10-02-model-ladder/baseline-uncapped/analysis.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis.md) | $/task | arm gbrain | gpt-6.1-sol against gpt-5.4 | both |
| [2026-10-02-model-ladder/baseline-uncapped/analysis.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis.md) | $/task | arm fs-acl | gpt-6.1-sol against claude-haiku-4-5 | high |
| [2026-10-02-model-ladder/baseline-uncapped/analysis.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis.md) | $/success | arm pg | gpt-6-sol against claude-haiku-4-5 | both |
| [2026-10-02-model-ladder/baseline-uncapped/analysis.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis.md) | $/success | arm memory | gpt-6-sol against gpt-5.4 | both |
| [2026-10-02-model-ladder/baseline-uncapped/analysis.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis.md) | $/success | arm memory | gpt-6.1-sol against gpt-5.4 | both |
| [2026-10-02-model-ladder/baseline-uncapped/analysis.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis.md) | $/success | arm gbrain | gpt-6-sol against claude-sonnet-5-5 | high |
| [2026-10-02-model-ladder/baseline-uncapped/analysis.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis.md) | $/success | arm gbrain | gpt-6-sol against gpt-5.4 | both |
| [2026-10-02-model-ladder/baseline-uncapped/analysis.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis.md) | $/success | model gpt-6-sol | gbrain against memory | high |
| [2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md) | $/task | arm fs | gpt-6-sol against claude-haiku-4-5 | both |
| [2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md) | $/task | arm fs | gpt-6.1-sol against claude-haiku-4-5 | both |
| [2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md) | $/task | arm pg | gpt-6.1-sol against gpt-5.4 | both |
| [2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md) | $/task | arm memory | gpt-6.1-sol against claude-sonnet-4-6 | both |
| [2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md) | $/task | arm memory | gpt-6.1-sol against claude-sonnet-5 | high |
| [2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md) | $/task | arm gbrain | gpt-6-sol against claude-sonnet-4-6 | both |
| [2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md) | $/task | arm gbrain | gpt-6-sol against claude-sonnet-5 | high |
| [2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md) | $/task | arm gbrain | gpt-6-sol against claude-sonnet-5-5 | high |
| [2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md) | $/task | arm gbrain | gpt-6.1-sol against gpt-5.4 | both |
| [2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md) | $/task | arm fs-acl | gpt-6.1-sol against claude-haiku-4-5 | both |
| [2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md) | $/success | arm pg | gpt-6-sol against claude-haiku-4-5 | high |
| [2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md) | $/success | arm memory | gpt-6-sol against gpt-5.4 | both |
| [2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md) | $/success | arm memory | gpt-6.1-sol against gpt-5.4 | both |
| [2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md) | $/success | arm gbrain | gpt-6-sol against claude-sonnet-5-5 | high |
| [2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md) | $/success | arm gbrain | gpt-6-sol against gpt-5.4 | both |
| [2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md](../benchmarks/2026-10-02-model-ladder/baseline-uncapped/analysis-repeats-0-1.md) | $/success | model gpt-6-sol | gbrain against memory | high |
| [2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md](../benchmarks/2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md) | $/task | arm fs | gpt-6.1-sol against claude-haiku-4-5 | both |
| [2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md](../benchmarks/2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md) | $/task | arm fs | gpt-6-astra against gpt-5.5 | high |
| [2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md](../benchmarks/2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md) | $/task | arm pg | gpt-6.1-sol against gpt-5.4 | both |
| [2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md](../benchmarks/2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md) | $/task | arm memory | gpt-6.1-sol against claude-sonnet-4-6 | both |
| [2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md](../benchmarks/2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md) | $/task | arm memory | gpt-6.1-sol against claude-sonnet-5 | high |
| [2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md](../benchmarks/2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md) | $/task | arm gbrain | gpt-6-sol against claude-sonnet-4-6 | high |
| [2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md](../benchmarks/2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md) | $/task | arm gbrain | gpt-6-sol against claude-sonnet-5 | high |
| [2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md](../benchmarks/2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md) | $/task | arm gbrain | gpt-6-sol against claude-sonnet-5-5 | high |
| [2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md](../benchmarks/2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md) | $/task | arm gbrain | gpt-6.1-sol against gpt-5.4 | both |
| [2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md](../benchmarks/2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md) | $/task | arm fs-acl | gpt-6.1-sol against claude-haiku-4-5 | high |
| [2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md](../benchmarks/2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md) | $/task | arm fs-acl | gpt-6.1-sol against gpt-5.4 | high |
| [2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md](../benchmarks/2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md) | $/task | arm gbrain-next | gpt-6.1-sol against claude-haiku-4-5 | both |
| [2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md](../benchmarks/2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md) | $/success | arm memory | gpt-6.1-sol against gpt-5.4 | both |
| [2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md](../benchmarks/2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md) | $/success | arm memory | gpt-6.1-sol against gpt-6-sol | high |
| [2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md](../benchmarks/2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md) | $/success | arm gbrain | gpt-6.1-sol against claude-haiku-4-5 | both |
| [2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md](../benchmarks/2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md) | $/success | arm gbrain | gpt-6-sol against claude-sonnet-5 | high |
| [2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md](../benchmarks/2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md) | $/success | arm gbrain | gpt-6-sol against gpt-5.4 | both |
| [2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md](../benchmarks/2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md) | $/success | arm fs-acl | gpt-6.1-sol against gpt-5.4 | high |
| [2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md](../benchmarks/2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md) | $/success | arm gbrain-next | gpt-6-sol against gpt-5.4 | both |
| [2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md](../benchmarks/2026-10-02-model-ladder/fix-wave-ladder/analysis-next.md) | $/success | model gpt-6-sol | gbrain against memory | high |
| [2026-10-02-model-ladder/followups/control/analysis.md](../benchmarks/2026-10-02-model-ladder/followups/control/analysis.md) | $/success | arm gbrain-566a242a-control | gpt-6.1-sol against claude-haiku-4-5 | both |
| [2026-10-02-model-ladder/followups/holdout/analysis.md](../benchmarks/2026-10-02-model-ladder/followups/holdout/analysis.md) | $/task | arm gbrain-c1234-holdout | gpt-6.1-sol against gpt-5.4 | both |
| [2026-10-02-model-ladder/holdout/analysis-base.md](../benchmarks/2026-10-02-model-ladder/holdout/analysis-base.md) | $/task | arm fs | gpt-6.1-sol against claude-haiku-4-5 | both |
| [2026-10-02-model-ladder/holdout/analysis-base.md](../benchmarks/2026-10-02-model-ladder/holdout/analysis-base.md) | $/task | arm pg | gpt-6.1-sol against gpt-5.4 | high |
| [2026-10-02-model-ladder/holdout/analysis-base.md](../benchmarks/2026-10-02-model-ladder/holdout/analysis-base.md) | $/task | arm memory | gpt-6.1-sol against claude-sonnet-5-5 | high |
| [2026-10-02-model-ladder/holdout/analysis-base.md](../benchmarks/2026-10-02-model-ladder/holdout/analysis-base.md) | $/task | arm fs-acl | gpt-6.1-sol against claude-haiku-4-5 | high |
| [2026-10-02-model-ladder/holdout/analysis-base.md](../benchmarks/2026-10-02-model-ladder/holdout/analysis-base.md) | $/task | arm gbrain-next-51a30c1 | gpt-6.1-sol against gpt-5.4 | both |
| [2026-10-02-model-ladder/holdout/analysis-base.md](../benchmarks/2026-10-02-model-ladder/holdout/analysis-base.md) | $/success | arm memory | gpt-6.1-sol against claude-sonnet-4-6 | high |
| [2026-10-02-model-ladder/pilot-capped-20k/analysis.md](../benchmarks/2026-10-02-model-ladder/pilot-capped-20k/analysis.md) | $/task | arm fs | gpt-6.1-sol against claude-haiku-4-5 | both |
| [2026-10-02-model-ladder/pilot-capped-20k/analysis.md](../benchmarks/2026-10-02-model-ladder/pilot-capped-20k/analysis.md) | $/task | arm pg | gpt-6.1-sol against gpt-5.4 | both |
| [2026-10-02-model-ladder/pilot-capped-20k/analysis.md](../benchmarks/2026-10-02-model-ladder/pilot-capped-20k/analysis.md) | $/task | arm gbrain | gpt-6.1-sol against claude-haiku-4-5 | both |
| [2026-10-02-model-ladder/pilot-capped-20k/analysis.md](../benchmarks/2026-10-02-model-ladder/pilot-capped-20k/analysis.md) | $/success | arm memory | gpt-6.1-sol against gpt-5.4 | both |
| [2026-10-02-model-ladder/scale-tier/analysis.md](../benchmarks/2026-10-02-model-ladder/scale-tier/analysis.md) | $/task | arm memory | gpt-6.1-sol against claude-sonnet-4-6 | high |
| [2026-10-02-model-ladder/scale-tier/analysis.md](../benchmarks/2026-10-02-model-ladder/scale-tier/analysis.md) | $/task | arm memory | gpt-6.1-sol against gpt-5.4 | both |
| [2026-10-02-model-ladder/scale-tier/analysis.md](../benchmarks/2026-10-02-model-ladder/scale-tier/analysis.md) | $/task | arm memory | gpt-6.1-sol against claude-sonnet-5-5 | high |
| [2026-10-02-model-ladder/scale-tier/analysis.md](../benchmarks/2026-10-02-model-ladder/scale-tier/analysis.md) | $/task | arm gbrain | gpt-6.1-sol against gpt-5.4 | high |
| [2026-10-02-model-ladder/scale-tier/analysis.md](../benchmarks/2026-10-02-model-ladder/scale-tier/analysis.md) | $/success | arm memory | gpt-6.1-sol against gpt-5.4 | high |
| [2026-10-02-model-ladder/scale-tier/analysis.md](../benchmarks/2026-10-02-model-ladder/scale-tier/analysis.md) | $/success | arm memory | gpt-6.1-sol against claude-sonnet-5-5 | high |
| [2026-10-13-cat40-dev-round-1/README.md](../benchmarks/2026-10-13-cat40-dev-round-1/README.md) | $/task | model gpt-6.1-sol | gbrain-dev-r1-all-on against gbrain-dev-r1-f2 | high |
| [2026-10-13-cat40-dev-round-1/README.md](../benchmarks/2026-10-13-cat40-dev-round-1/README.md) | $/task | model gpt-6.1-sol | gbrain-dev-r1-all-on against gbrain-dev-r1-f4 | high |
| [2026-10-13-cat40-dev-round-1/README.md](../benchmarks/2026-10-13-cat40-dev-round-1/README.md) | $/task | model gpt-6.1-sol | gbrain-dev-r1-f4 against gbrain-dev-r1-f5 | low |

### The judge path

At `34cd6299`, `eval/runner/cat40/loop.ts` still prices OpenAI judges with `cache_write: 0` (`runAgentText`, lines 545-546). #397 fixed agent turns, which read usage through `eval/runner/q1/usage.ts`, but the judge call reads only `input_tokens_details.cached_tokens` and drops the cache-write count, and `priceUsage` applies no long-context rate to agent turns or judges. So any new Cat 40 run with a gpt-6.1-sol judge still records `judge_usd` low, by up to a quarter of the judge's uncached-input dollars when its prompt is under 272,000 tokens and by more above that, and any agent request over 272,000 tokens is still recorded at the standard rates. A budget ledger that meters the call prices both correctly, and the committed post-fix runs fit that: after the agents' predicted cache-write premium, the ledger's remaining surplus over the rows is within about $2 of a quarter of the Sol judge dollars per run, except where the report names rejected requests charged at their reservation. That surplus is also the cap this audit puts on the agents' tier share on those runs, and since the judge's own cache writes would take about a quarter of its dollars, little or none of it is left for agent requests over 272,000 tokens: the high ends on post-fix runs are loose.

## Other runners

This table lists every OpenAI cost figure the other-runners audit checked. Each report below now carries its correction
in place, with the original beside it, except the preregistrations, which get dated notes only, and the JSON receipts,
which aren't edited. A per-unit figure gives its corrected value. A spend, total or plan figure gives how far low it
was, and a figure whose rows aren't committed gives an upper bound instead. The figures and their bounds are in the
repricing tool's [results.json](2026-11-09-openai-cache-writes/other-runners/results.json).

| Doc | Figure | Was | Now or status |
|---|---|---|---|
| [N2 judges](../benchmarks/2026-10-06-n2-judges.md) | GPT-6 Luna cost per 1,000 judged pairs (title, finding, table) | $0.21 | $0.24; Luna stays the cheapest model that passes |
| [N2 judges](../benchmarks/2026-10-06-n2-judges.md) | GPT-6.1 Sol cost per 1,000 judged pairs | $2.69 | $3.22 |
| [N2 judges](../benchmarks/2026-10-06-n2-judges.md) | Spend for the five models | $25.52 | about 2% low |
| [N2 judges](../benchmarks/2026-10-06-n2-judges.md) | GPT-6 Luna spend (also the low end of the per-model range) | $0.16 | about 13% low |
| [N2 judges](../benchmarks/2026-10-06-n2-judges.md) | GPT-6.1 Sol spend | $1.99 | about 20% low |
| [TODOS](../../TODOS.md) | N2 entry: spend; cheapest passing model's cost per 1,000 pairs | $25.52; $0.21 | about 2% low; $0.24 |
| [Content repair](../benchmarks/2026-10-09-content-repair-judgment.md) | gpt-6.1-sol USD per pair (report table and summary.md) | $0.0022 | $0.0023; Sol stays the cheapest per pair |
| [Content repair](../benchmarks/2026-10-09-content-repair-judgment.md) | gpt-6.1-sol spend | $0.31 | about 5% low |
| [Content repair](../benchmarks/2026-10-09-content-repair-judgment.md) | Spend for 432 pair runs | $2.05 | about 1% low |
| [Multi-source scope](../benchmarks/2026-10-24-multi-source-scope-tools-list.md) | Model spend over 964 counted trials (report and summary.md) | $20.76 | about 3% low |
| [Multi-source scope](../benchmarks/2026-10-24-multi-source-scope-tools-list.md) | gpt-6.1-sol spend | $1.72 | about 12% low |
| [Multi-source scope](../benchmarks/2026-10-24-multi-source-scope-tools-list.md) | gpt-6-astra spend | $4.72 | about 11% low |
| [Multi-source scope](../benchmarks/2026-10-24-multi-source-scope-tools-list/summary.md) | gpt-6.1-sol USD per trial, base / PR | $0.0046 / $0.0040 | $0.0050 / $0.0044 |
| [Multi-source scope](../benchmarks/2026-10-24-multi-source-scope-tools-list/summary.md) | gpt-6-astra USD per trial, base / PR | $0.0322 / $0.0296 | $0.0351 / $0.0325; Sol stays the cheapest, and PR stays cheaper than base |
| [Multi-source scope](../benchmarks/2026-10-24-multi-source-scope-tools-list.md) | Budget ledger total, and the smoke runs | $31.59; $0.60 | no move: the ledger priced cache writes |
| [SkillOpt method](../benchmarks/2026-11-01-skillopt-method/REPORT.md) | Sol $ per correct, query seed / rewrite | $0.033 / $0.026 | $0.039 / $0.031 |
| [SkillOpt method](../benchmarks/2026-11-01-skillopt-method/REPORT.md) | Sol $ per correct, briefing seed / rewrite | $0.16 / $0.034 | $0.18 / $0.040 |
| [SkillOpt method](../benchmarks/2026-11-01-skillopt-method/REPORT.md) | Sol $ per correct, fact-check seed / rewrite | $0.18 / $0.036 | $0.19 / $0.043; Sol stays cheaper than Opus in every cell |
| [SkillOpt method](../benchmarks/2026-11-01-skillopt-method/REPORT.md) | Program spend (frontier probe, test read, total) | ledger figures | no move: ledger-priced |
| [SkillOpt probe](../benchmarks/2026-11-01-skillopt-method/probe/frontier/README.md) | Sol mean rollout F0a / F0b, query | $0.033 / $0.032 | $0.039 / $0.039 |
| [SkillOpt probe](../benchmarks/2026-11-01-skillopt-method/probe/frontier/README.md) | Sol mean rollout F0a / F0b, briefing | $0.079 / $0.048 | $0.090 / $0.055 |
| [SkillOpt probe](../benchmarks/2026-11-01-skillopt-method/probe/frontier/README.md) | Sol mean rollout F0a / F0b, fact-check | $0.091 / $0.054 | $0.100 / $0.062 |
| [SkillOpt probe](../benchmarks/2026-11-01-skillopt-method/probe/frontier/README.md) | Probe and test-read spend | ledger figures | no move: ledger-priced |
| [SkillOpt ceiling](../benchmarks/2026-11-02-skillopt-ceiling/PREREGISTRATION.md) | Sol mean per rollout, first calibration rounds 1 and 2 (superseded) | $0.0631, $0.0626 | about 13% low (rows not committed; the re-read's ratio); dated note |
| [SkillOpt ceiling](../benchmarks/2026-11-02-skillopt-ceiling/PREREGISTRATION.md) | Round-2 re-priced stages | planning table | about 3% to 4% low (rows not committed); each stays inside its cap; dated note |
| [SkillOpt ceiling](../benchmarks/2026-11-02-skillopt-ceiling/PREREGISTRATION.md) | Sol mean per rollout, calibration re-read | $0.0736 | $0.0829; dated note |
| [SkillOpt ceiling](../benchmarks/2026-11-02-skillopt-ceiling/PREREGISTRATION.md) | Sol mean per rollout by skill: query, briefing, fact-check | $0.0141, $0.1084, $0.0983 | $0.0170, $0.1230, $0.1087; dated note |
| [SkillOpt ceiling](../benchmarks/2026-11-02-skillopt-ceiling/PREREGISTRATION.md) | Re-read re-priced stages: gate attempt, stop-path read, B0 | planning table | about 4% low; each stays inside its cap; dated note |
| [SkillOpt ceiling](../benchmarks/2026-11-02-skillopt-ceiling/PREREGISTRATION.md) | Sol's 1.25× re-price trigger | $0.0920 | unchanged (gate text); the corrected mean stays under it, and Sol's gate never ran |
| [SkillOpt ceiling](../benchmarks/2026-11-02-skillopt-ceiling/PREREGISTRATION.md) | Gap called in-flight spend after the restart | $0.52 | about two thirds of it is the missed premium, about a third in-flight spend; dated note |
| [Harness ledger](../../eval/harness-provider/LEDGER.md) | Line 3 Sol agent mode | $42.7 | about 17% low |
| [Harness ledger](../../eval/harness-provider/LEDGER.md) | Line 3 Sol answer part | $36.3 | about 20% low |
| [Harness ledger](../../eval/harness-provider/LEDGER.md) | Line 4 frontier sweep | $498.8 | about 10% low (Astra's cache writes assumed to behave like Sol's) |
| [Harness ledger](../../eval/harness-provider/LEDGER.md) | Line 4 Astra part | $207.8 | about 23% low (assumed as above) |
| [Harness ledger](../../eval/harness-provider/LEDGER.md) | Line 3 and line 4 totals | $589; $719 | about 1% low; about 7% low |
| [Harness ledger](../../eval/harness-provider/LEDGER.md) | Rebuilt total | $2,451 | about 2% low; over the cap only if about 88% or more of gpt-6-astra's reader input is cache-written (no Astra request ran in the lane); `within_cap` in `ledger.json` stays the October 7 record (`true`) |
| [Harness ledger](../../eval/harness-provider/LEDGER.md) | As planned on October 5 | $2,720 | about 2% low; the overrun is larger |
| [Harness ledger](../../eval/harness-provider/LEDGER.md) | 10% frontier sweep | $2,421 | about 1% low; it still fits the cap |
| [Harness ledger](../../eval/harness-provider/LEDGER.md) | 16k targets lever | $2,976 | about 2% low |
| [Harness ledger](../../eval/harness-provider/LEDGER.md) | A-reader alternatives: Sonnet, Opus, gpt-6.1-sol | $3,483, $4,976, $3,014 | about 2%, 1% and 8% low |
| [Memory trust](../benchmarks/2026-10-08-memory-trust-results-paid.md) | Cat 37 counted GPT cell | $6.17 | low by at most 18% (rows not committed) |
| [Memory trust](../benchmarks/2026-10-08-memory-trust-results-paid.md) | Cat 37 counted cells | $33.77 | low by at most 3% |
| [Memory trust](../benchmarks/2026-10-08-memory-trust-results-paid.md) | Cat 37 labels-absent arm | $17.01 | low by at most 22% (no per-model split; bound from its input tokens) |
| [Memory trust](../benchmarks/2026-10-08-memory-trust-results-paid.md) | Cat 37 Fable smoke and GPT pre-flight | $0.35 | low by at most 1% |
| [Memory trust](../benchmarks/2026-10-08-memory-trust-results-paid.md) | Cat 38 model arm | $5.44 | low by at most 24% (no per-model split) |
| [Memory trust](../benchmarks/2026-10-08-memory-trust-results-paid.md) | Cat 39 model arm and embedding probe | $0.85 | low by at most 23% (no per-model split) |
| [Memory trust](../benchmarks/2026-10-08-memory-trust-results-paid.md) | Utility guard GPT reader | $14.72 | about 24% low (estimate by W10b's corrected ratio; rows not committed) |
| [Memory trust](../benchmarks/2026-10-08-memory-trust-results-paid.md) | Utility guard line | $86.23 | about 4% low |
| [Memory trust](../benchmarks/2026-10-08-memory-trust-results-paid.md) | Real spend | $212.15 | about 2% low, and low by at most 5% |
| [Memory trust](../benchmarks/2026-10-08-memory-trust-results-paid.md) | Spent before amendment 4 | $165.14 | about 2% low, and low by at most 6% |
| [Memory trust](../benchmarks/2026-10-08-memory-trust-results-paid.md) | Preference, preference v2 and relay GPT cells | $3.12, $2.50, $2.14 + $2.12 | no move: priced by runners that read cache writes |
| [Facts extraction](../benchmarks/2026-10-08-facts-extraction-model.md) | GPT-6 Luna $ per 1,000 pages, measured / if all 996 ran | $0.89 / $1.23 | low by at most 3% each (rows not committed); Haiku 5.5 stays above Luna at the bound |
| [Facts extraction](../benchmarks/2026-10-08-facts-extraction-model.md) | Luna extraction over 624 requests | $0.57 | low by at most 4% |
| [Facts extraction](../benchmarks/2026-10-08-facts-extraction-model.md) | Luna gate arm, 190 pages | $0.16 | no visible move: the bound stays inside the rounding |
| [Facts extraction](../benchmarks/2026-10-08-facts-extraction-model.md) | gpt-6.1-sol judge | about $0.34 | low by at most 25% |
| [Facts extraction](../benchmarks/2026-10-08-facts-extraction-model.md) | Gate; off, Luna and Haiku arms; R2 total | $3.27; $2.59; $23.30 | low by at most 3%; at most 1%; less than 1% |
| [Hangul boundaries](../benchmarks/2026-10-05-hangul-mention-boundaries.md) | Labeling cost | $0.36 | about 19% low (estimate from batch sizes; no usage committed) |
| [Expansion latency](../benchmarks/2026-10-14-expansion-latency-preregistration.md) | GPT-6 Luna expansion spend; total | $0.05; $4.71 | low by at most 25%; less than 1% (request log not committed); dated note |
| [Expansion latency](../benchmarks/2026-10-14-expansion-latency-preregistration.md) | Plan estimate for Haiku 5.5 + GPT-6 Luna expansion | $0.10 | unchanged: preregistered plan text |
| [Q2](../benchmarks/2026-10-05-heldout-program/q2.md) | G6 ingest (Sonnet, Sol and Opus) | $293.70 | low by at most 25% (no per-model split committed) |
| [Q2](../benchmarks/2026-10-05-heldout-program/q2.md) | Campaign cost, with and without minting | $306.56; $333.97 | not annotated: the doc doesn't say what it includes |
| [Temporal graph 0.31](../comparison-systems/ext-temporal-graph/shipped-0.31/README.md) | gpt-6-luna ingest, 10 requests | $0.0017 | low by at most 20% (proxy rows not committed) |
| [Temporal graph 0.31](../comparison-systems/ext-temporal-graph/shipped-0.31/README.md) | Probe stack billed total | $0.0022 | low by at most 15% |
| [P4](../benchmarks/2026-10-05-heldout-program/p4.md) | Core gate gpt-6.1-sol cost per correct answer, A′ → C (verdict JSON also gives $0.282 / $0.318 per question) | $0.32 → $0.37 | low by at most 25% (the rows are in gbrain's decision record); dated note; Sonnet stays above Sol at the bound; JSON not edited |
| [Held-out verdicts](../benchmarks/2026-10-05-heldout-verdicts/p5-h5b-heldout-2026-10-06.json) | P5 H5b agent spend, off / on, Sonnet and Sol together | 20.6 / 21.71 | low by at most 25%; the P5 page doesn't print it, and the JSON isn't edited |
| [Held-out verdicts](../benchmarks/2026-10-05-heldout-verdicts/p5-h3-heldout-2026-10-06.json) | P5 H3 judge spend, Sonnet and Sol judges | 0.054 | low by at most 25%; as above |
| [Fence repair](../benchmarks/2026-10-06-fence-repair-tier3.md) | Sol $ per repair | $0.0026 / $0.0023 | no move: every Sol prompt is under 1,024 tokens |
| [Takes bootstrap](../benchmarks/2026-10-06-takes-bootstrap-frontier.md) | Sol run | $0.174 | no move: largest prompt 325 tokens |
| [Take grading](../benchmarks/2026-10-16-take-grading.md) | Sol per verdict | $0.0016 | no move: every Sol prompt is under 1,024 tokens |
| [Skill ranker](../benchmarks/2026-11-07-skill-ranker-offline.md) | Sol writer spend | as published | no move: largest prompt 368 tokens |
| [Evidence pilot](../benchmarks/2026-10-08-evidence-architecture-pilot.md) | Sol and Luna reads and builds | as published | no move: every row prices its cache writes |
| [Evidence confirmation](../benchmarks/2026-10-08-evidence-brief-confirmation.md) | Sol and Luna reads and builds | as published | no move: every row prices its cache writes |
| [External ideas A2](../benchmarks/2026-10-21-external-ideas-wave-a2.md) | Sol harm check | as published | no move: every Sol row prices cache writes |
| [Brain-first install block](../benchmarks/2026-10-24-brain-first-install-block.md) | Codex gpt-6.1-sol | as published | no move: Codex reports and prices cache writes |
| [Spring-loaded skills](../benchmarks/2026-10-24-spring-loaded-skills.md) | Codex gpt-6.1-sol | as published | no move: Codex reports and prices cache writes; 15 runs passed 272,000 input tokens in total, but each made at least 3 requests, so no request passed about 203,000 |
| [SkillOpt rebaseline](../benchmarks/2026-11-01-skillopt-rebaseline/PREREGISTRATION.md) | Metered Sol judge share | $0.0242 | no move: priced through a ledger that reads cache writes |
| [GST-1365 judge robustness](../benchmarks/2026-11-04-gst-1365-judge-robustness-preregistration.md) | Second-judge cost per answer | $0.0188 | no move: ledger-based |
| [Cat 41 brief](../benchmarks/2026-10-15-cat41-brief-preregistration.md) | Codex run estimate | about $0.50 | no move: Codex prices cache writes |
| [RS1 stage 0](../benchmarks/2026-11-04-rs1-stage0.md) | Cost per minted conversation | as published | no move: OpenAI only embeds here |
| [Wave 11 smoke](../benchmarks/2026-10-07-wave11-agent-smoke-preregistration.md) | Sol build estimate | $2.6 | out of scope: a planning figure taken from the Cat 40 cells |
| [Sealed confirmation v1](../benchmarks/2026-09-29-sealed-confirmation-protocol.md) | gpt-6-sol generation | $15.82 | no move: its runner priced reported cache writes from its first commit |
| [Sealed confirmation v2](../benchmarks/2026-10-01-sealed-confirmation-v2-protocol.md) | gpt-6-sol and gpt-6-luna generation | $20.99 | no move: as above |
| [P2-E2 consumers](../benchmarks/p2-e2-consumers/README.md) | gpt-6-sol pairwise judge | none published | no figure |

The ledgers that priced cache writes agree with the repriced rows. On the multi-source runs, the budget ledger minus
the runner's records equals the predicted premium to about a tenth of a cent on each of the four runs with nothing
charged at its reservation; the two runs that hit gpt-6-astra's budget guard differ by those reservation charges. On
SkillOpt, the F0a run agrees to within half a cent and the smoke run to within a thousandth of a cent. The test read
sits about a quarter of a dollar above the prediction, with three requests charged at their reservation, and F0b
sits further above it, with one reservation charge and about half a million ledger input tokens that no meter row
has. On the SkillOpt ceiling's calibration re-read, the gap between Sol's ledger entries and its meters is about two
thirds missed premium and one third spend on rollouts that were in flight at a restart. This check
reads ledger entries that aren't committed, so the repricing tool below leaves it out.

**gpt-6-sol.** Only three reports in this scope use gpt-6-sol: the two sealed-confirmation generation runs, whose
runner (`eval/runner/sealed-confirmation-lib.ts`) read OpenAI's cache-write count and priced it at gpt-6-sol's $2.50
from its first commit, and the P2-E2 consumers judge, which publishes no cost. The takes-bootstrap report lists
gpt-6-sol's price only. The Cat 40 model ladder's gpt-6-sol cells are part of the Cat 40 audit. The budget ledger's
price row for gpt-6-sol has no cache-write rate and no long-context tier, but no figure here was priced through it.

**Long-context tier.** No figure in this scope has a request above 272,000 input tokens, so none moves for the tier.
Where rows give each request's size, the largest is 20,085 tokens (the evidence-brief reads); the content-repair,
N2, take-grading, takes-bootstrap, fence-repair and skill-ranker requests are all under 2,400. Where only totals are
committed, a total bounds each request in it: at most 43,012 tokens per multi-source trial, 69,250 per SkillOpt ceiling
call and 150,385 per sealed-confirmation haystack. Codex reports one total per run. In the spring-loaded skills lane,
15 runs passed 272,000 input tokens in total; Codex resends an append-only conversation, so the last request is the
largest and is at most the run's total divided by its requests plus its new input, and each of those runs needed at
least 3 requests by its chain of dependent tool calls. That puts every request under about 203,000 tokens, and every
brain-first request under about 116,000. The P4 harness compacts before 95% of its 32k-token window, and the harness
ledger's readers are planned at an 8k target. The memory-trust, facts-extraction, Q2, P5 and expansion-latency requests
aren't committed. Their receipts average 735 to 2,285 input tokens per request where they give a count, and their
bounds assume no request above the tier.

**Rerun the repricing.** From the repository root:

```sh
python3 docs/audit/2026-11-09-openai-cache-writes/other-runners/reprice.py
```

It reads only committed files, calls no provider and needs no key; for the harness ledger it reruns
`harness-ledger.ts` with bun on copies of the plan in a temporary directory. It writes
[results.json](2026-11-09-openai-cache-writes/other-runners/results.json), one figure per line, and checks that each
corrected report above still carries its corrected wording; all 34 figures with such wording match. Its
[README](2026-11-09-openai-cache-writes/other-runners/README.md) gives the prices, the method and the output fields.

## Figures that don't move

- The BEAM-1M S1 fixes' reader costs were settled by a ledger that prices cache writes; the rows reproduce them.
- The F6 dry run's gpt-6.1-sol cost per call reproduces only at the cache-write rate, so it was already right.
- The 2026-11-01 corrections to W10b, W10c and the particle-1 replay already price Sol's cache writes; the committed
  rows confirm every corrected figure.
- Q1's scoreboard publishes no cost per answer.
- The evidence-architecture pilot, the evidence-brief confirmation, the external-ideas wave A2 harm check, the Codex
  arms, fence repair, takes bootstrap, take grading, the skill ranker, the SkillOpt rebaseline, memory trust's later
  arms, GST-1365 and RS1 either price cache writes already or send only prompts under 1,024 tokens.
- Budgeted delivery H1's and the 8k conversion's reader spend was settled by the metering proxy after `8a8e502a`, which
  prices cache writes.

## Limits and follow-up

- **Not recomputed:** the particle-1 F6 add-on's gpt-6.1-sol reader rows (report.md), because the per-answer usage stays
  in custody; the Hard confirmation's S world, the sealed next-confirm cells, the Hard calibration and the P8 surface
  held-out verdict, whose rows aren't committed. Each report says how far its figures can be low: at most a quarter of
  the OpenAI input dollars where no request can have passed 272,000 input tokens, and more where one could have (the
  F6 add-on's file agent and the Hard calibration, whose figures could be up to 2.5 times as high).
- **Cat 40's long-context ranges stay open.** Its rows record each session's totals, not each request's size, so a figure
  the tier could touch is a range. Committing each request's usage would close them.
- **The Cat 40 judge path still under-counts.** At `34cd6299`, `runAgentText` in `eval/runner/cat40/loop.ts` records
  `cache_write: 0` for an OpenAI judge, so a new Cat 40 run with a gpt-6.1-sol judge still under-records its judge
  dollars. The ledger prices them correctly, and caps bind on the ledger. `eval/runner/p5-agent.ts` and
  `eval/runner/p4-stream/model.ts` record OpenAI cache writes the same way.
- **The budget ledger's gpt-6-sol price has no cache-write rate and no long-context tier.** No corrected figure here was
  priced through it. It and the recording above are a follow-up, not part of this audit.
- Judge dollars in Cat 40 are bounded per run from the ledger, not repriced, since the rows don't split judge usage.
