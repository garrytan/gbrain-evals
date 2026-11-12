# Corrections to published numbers

These published numbers are invalid, overstated or retired. Each affected report keeps its original figures, labeled,
beside a dated correction or notice. The list covers the audit of September 28, 2026, the corrections README carried
until 2026-11-01 and the rows the comparisons page dropped as invalid. A report that later corrected its own figures
says so in that report. [README](../README.md) and the hub pages show only the numbers that stand; this page
says which ones do not and why. Everything above [Changelog](#changelog) is current.

## LongMemEval

- **LongMemEval answer accuracy 433/500 (86.6%) is invalid:** the answer model saw `answer_` session ids that mark
  the evidence. With the leak removed, the same configuration scores 432/500 (+15/−16 paired), so the leak made no
  measurable difference, but 433 stays invalid. Retrieval numbers recounted with opaque ids are confirmed.
  [Report](benchmarks/2026-09-29-longmemeval-opaque-qa.md),
  [recount](benchmarks/2026-10-04-longmemeval-opaque-followups.md).
- **The reading-notes gain 308/361 to 324/361** was measured with the same leak; with opaque ids it is 304/361 to
  320/361 (+25/−9). [Report](benchmarks/2026-09-25-reading-notes.md).
- **Query expansion "hurts retrieval"** described the September 6 code (255/470). At gbrain `109b992` it scores
  436/470 against 434/470 without it (+6/−4, p = 0.75), so that finding no longer describes gbrain.
  [Recount](benchmarks/2026-10-04-longmemeval-opaque-followups.md).
- **Two cost figures in the particle-1 replay report are off** (2026-11-01). Its results table gives Opus 5.5
  $0.0994 per correct answer; $47.091364 over 474 correct answers is $0.099349, which is $0.0993 (the table rounded
  summary.json's five-decimal value a second time; the opening paragraph's $0.099 stands). Its batch-price figures for
  Opus 5.5 and Sonnet 5.5, $0.0507 and $0.0255 per correct answer ($0.051 in the opening paragraph), come from W10's
  ledger-settled amounts. W10's preregistration settled each arm's 10-question pilot at list price until the batch
  discount was confirmed, but the provider billed the pilots at the batch rate too, so at half the list price the
  figures are $0.0497 and $0.0250. Every particle-1 figure is unaffected; GPT-6.1 Sol's figures have their own entry
  below. The report keeps its original figures; this page carries the correction.
  [Report](benchmarks/2026-11-01-longmemeval-particle-replay/REPORT.md),
  [recheck](findings/2026-11-01-particle-1-longmemeval-w10b.md).
- **GPT-6.1 Sol's reader costs in W10b, W10c and the particle-1 replay are about a fifth low** (2026-11-01). OpenAI
  reported almost every Sol prompt token as a cache write (6,845,950 of 6,847,450 in W10b), and it prices cache writes
  at $2.50 per million tokens against $2.00 for input. W10 settled its rows on 2026-10-06 at the input price, two days
  before the budget ledger began pricing OpenAI cache writes (`8a8e502a`). At the cache-write rate, W10b's Sol reader
  cost is $8.83 at batch price (was $7.12), so the W10b run total is $92.00 (was $90.29). W10c's Sol reader costs
  $0.0178 per question on gbrain's retrieval (was $0.0144, so the recurring total with the rerank rises by $0.0034) and
  $0.1339 with the whole history (was $0.1073), so gbrain's recurring cost is still about a seventh of the whole
  history's, with one question per history ([see below](#full-context-reads-and-openais-prompt-cache)). The replay
  report's W10b figures for Sol are $0.0381 per correct answer at list and $0.0190 at batch (was $0.0307 and $0.0154,
  which was itself $0.01535 rounded a second time), so particle-1's list cost per correct answer is about a ninth of
  Sol's, not a seventh. Its W10c figures for Sol are $0.0356 and $0.0178 per question on gbrain's retrieval (was
  $0.0287 and $0.0144) and $0.2679 and $0.1339 with the whole history (was $0.2145 and $0.1073). OpenAI's billing API
  refused our key, so these follow OpenAI's published rate and the usage the responses reported, not an invoice. No
  accuracy figure changes, and the reports keep their original figures. Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1. gbrain is Garry Tan's own project. Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.
  [W10b](benchmarks/2026-10-07-longmemeval-w10b-reader-replay.md),
  [W10c](benchmarks/2026-10-07-longmemeval-w10c-full-context.md),
  [replay report](benchmarks/2026-11-01-longmemeval-particle-replay/REPORT.md),
  [recheck](findings/2026-11-01-particle-1-longmemeval-w10b.md).
- **The W10b reader-replay report calls Opus 5.5 "the strongest reader on this retrieval"** (2026-11-01). Its
  preregistered test compares each reader with the replayed Sonnet 4.6 run only (one-sided, Holm across six arms), so
  it supports "Opus 5.5 scored higher than Sonnet 4.6" (474 against 451, Holm p = 0.0002), not a ranking of the newer
  readers against each other. README's row says this; the report keeps its original sentence.
  [Report](benchmarks/2026-10-07-longmemeval-w10b-reader-replay.md),
  [preregistration](benchmarks/2026-10-06-longmemeval-w10-preregistration.md).
- **The W10b report's Fable sensitivity note is wrong, and W10's superiority p values ran low** (2026-11-04). The
  superiority gate's p was the share of bootstrap draws at or below the minimum effect, which is not a p-value and is
  too small with few clusters. The note said that removing the Fable arm after the fact would have let Holm over five
  arms count `gpt-6.1-sol` as higher (adjusted p = 0.041). With the exact one-sided sign-flip p the value is 0.061, so
  it would not. Every preregistered W10 result stands. The reported p values move: W10a's one-sided p is 0.105 (was
  0.081), W10b's Holm values are 0.0002, 0.0002, 0.082, 0.12, 0.19 and 0.29 (were 0.0006, 0.0006, 0.055, 0.097, 0.15
  and 0.25), and W10c's two loss tests are 0.97 and 0.997 (were 0.96 and 0.99). The reports now give the exact values
  and list the old ones in their changelogs; their `summary.json` files keep the values as computed. gbrain is Garry Tan's own project. Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.
  [Audit](audit/2026-11-04-superiority-p.md), [W10b](benchmarks/2026-10-07-longmemeval-w10b-reader-replay.md),
  [W10a](benchmarks/2026-10-07-longmemeval-w10a-current-pin.md),
  [W10c](benchmarks/2026-10-07-longmemeval-w10c-full-context.md).

## Relationships and calibration

- **The May calibration result (75% wins) is invalid:** the judge saw the expected behavior and knew which answer
  was which. [Report](benchmarks/2026-05-18-brainbench-cat14-cat15-calibration.md).
- **The April relationship precision at five (39.2% to 44.7%)** used a lenient denominator; divided by five slots it
  is 29.9% to 35.4%. Its alias recall falls from 31.0% to 13.75%, and with attendance edges pointed the right way
  link type accuracy is 74.7% (109/146).
  [Report](benchmarks/2026-04-18-brainbench-v1.md),
  [September 29 re-run](benchmarks/2026-09-29-repin-cats-1-2-6.md).
- **The April and May relationship tables' `gbrain` row (49.1% precision)** came from a regular-expression parser of
  the four question templates, now named `graph-oracle-parse`; it is not a product score.
  [Report](benchmarks/2026-04-19-brainbench-multi-adapter.md).

## PrecisionMemBench

- **The May gbrain rows (tight adaptive 0.582 and hybrid 0.075 mean precision) are invalid:** the seeding hid four
  superseded beliefs using ground-truth metadata unavailable to other providers. The September 9 corrected run
  replaces them (tight adaptive with reranking 0.5859, broad hybrid 0.0565).
  [Report](benchmarks/2026-05-29-precisionmembench.md),
  [September 9 refresh](benchmarks/2026-09-09-retrieval-refresh.md).

## Writing memory

- **Cat 35's 88.1%** is judge-only; evidence-verified retention is 74.9%.
  [Report](benchmarks/2026-08-16-brainbench-cat35-transcript-distill.md).
- **The May snapshot's Category 18b to 29 rows** came from runners written before the August audit; Cat 29's +4.00
  synthesis lift also scored the same single-answer call twice.
  [Report](benchmarks/2026-05-23-v0.40.6.0-snapshot.md).
- **The strict-source pageless facts report overstated its title-only pages and called agent labels hand-made**
  (2026-11-12). It said 45 of the 99 entity pages agents created unasked on v0.60.685.0 carry only a title; 45 lack
  the fact, and 39 of those carry nothing but frontmatter and a heading. It described its rule checks as labelled by
  hand; the labels came from the eval agent that ran the experiment, on claude-opus-5-5, one of the two models under
  test. Both outcomes are scored by code, and no counted number or verdict changes. The report carries both
  corrections. [Report](benchmarks/2026-11-12-strict-pageless-facts.md). gbrain is Garry Tan's own project.

## Agent tasks

- **Cat 40 agent-task results from October 2 to 7 measured gbrain without its reranker.** Restored harness slots
  kept a closed metering-proxy port for Voyage, so every rerank request failed and gbrain returned unreranked results.
  That covers the frontier tie with plain files (0 of 500 gbrain cells reranked), the six-model cost-wave set, the
  entity-recall rounds, the fix-wave development ladders, the 52,000-document tier, most of the release ladder, the
  F1/F10 instruction A/B in the Cat 41 report, the registration-surface cell, the P8 surface development runs and the
  fix wave 11 and 12 smokes. Comparisons between gbrain builds that shared the condition stay internally valid. The
  F1/F10 same-window pair for `b3f4e8b` reranked on one side only and does not support its conclusion as stated. The
  fix wave's held-out check reranked (1691 of 1800 cells) and is unaffected. Fixed in gbrain-evals #76 and #109.
  [Cat 40 correction](benchmarks/2026-10-02-model-ladder.md#correction-2026-10-09),
  [Cat 41 correction](benchmarks/2026-10-03-agent-operator.md#correction-2026-10-09),
  [audit](benchmarks/2026-10-08-program-primary-hard/root-cause/restore-audit.json).
- **The first Cat 40 world's success figures are retired** (2026-10-12): the 95.6% tie with plain files and the
  six-model set's 75.7% against 72.8% were measured with the reranker off, and the world sits near its ceiling
  (oracle 97.6%), so a rerun could at best confirm parity. Its permission result (0 of 100 finance-only leaks into
  context) does not depend on reranking and still stands. For agent-task success, read the
  [Cat 40 Hard confirmation](benchmarks/2026-10-10-model-ladder-hard-confirmation.md).
  [Notice](benchmarks/2026-10-02-model-ladder.md#retired-2026-10-12).

## Q1 head-to-head scoreboard

- **The file agent's BEAM-10M and BEAM-1M sealed cells left out its context-overflow stops** (2026-11-03). The
  preregistered outcome rule (`eval/runner/memory-qa/outcomes.ts`) counts an agent's own `turn_cap` and
  `context_overflow` stops as product failures, scored 0 and kept in the denominator, and the ruling of 2026-11-03 via
  GBRA-108 is that this rule wins. The first published render (results commit `f15e7302`) counted them as harness
  failures instead, because `eval/runner/scoreboard.ts` kept its own, shorter list of product failures, so every
  file-agent question with a stop left that row. All 7 stops are `claude-opus-5-5` answers that the file agent
  classified `context_overflow` from the provider's error text; none hit the turn cap. No stop's HTTP status was
  recorded: the answer records, meters and ledger keep neither the status nor the error text, and the proxy logs went
  with the runner VMs. The custodian, reading the sealed receipt, reports that each stop has the same shape: a first
  turn of about 1,130 to 1,160 input tokens that succeeded and a second request, carrying the first grep result, that
  failed, which fits a context-length refusal after an uncapped grep. The custodian re-rendered the receipt under the
  rule with `scoreboard.ts` at `a1c346e8` (results
  commit `bf902d9f`), and README's block and the scoreboard tables now show it. On BEAM-10M (S1) the file agent's row
  goes from 67.96% (193/199) to 67.25% (199/199), printed 68.0% to 67.2%, and its Opus reader from 73.53% to 71.31%; on
  BEAM-1M sealed (S2b) from 71.13% (239/240) to 71.11% (240/240) and its Opus reader from 76.51% to 76.19%. Its S1
  sensitivity views move from 68.6% (191/197) to 67.8% (197/197) without the questions of shipped-defaults' 10
  `harness_invalid` answers and from 69.6% (154/159) to 68.9% (159/159) on temporal-graph's 8 conversations. README's
  loss bullet, the file agent against gbrain's whole-system row on the questions both scored, moves from 68.3% against
  59.0% on 192 questions to 67.6% against 58.9% on 198, with a detectable difference of about 12.4 points (was 12.9); the
  two still cannot be told apart. No other system's row changes. gbrain is Garry Tan's own project.
  [Report](benchmarks/2026-10-06-scoreboard-report.md), [tables](benchmarks/2026-10-06-scoreboard/scoreboard.md).

## OpenAI cache writes

- **Some reports priced OpenAI's cache writes as plain input** (2026-11-09). OpenAI reports every uncached token but 3 of a
  gpt-6.1-sol or gpt-6-luna prompt of 1,027 tokens or more as a cache write (all but five of the committed rows), and
  it prices cache writes above input: $2.50 per million tokens against $2.00 for Sol and gpt-6-sol, $0.125
  against $0.10 for gpt-6-luna and $12.50 against $10 for gpt-6-astra. The rule is measured on gpt-6.1-sol and
  gpt-6-luna records and assumed for gpt-6-sol and gpt-6-astra. No other OpenAI model these evals ran has a cache-write
  price, so `gpt-4.1-mini` and the rest are unaffected. OpenAI also bills a whole request over 272,000 input tokens at
  long-context rates (twice the input, cached-input and cache-write prices, 1.5 times output). Budget ledgers from
  `8a8e502a` apply them for gpt-6.1-sol, gpt-6-luna and gpt-6-astra, but Cat 40's price code never did, and no Cat 40
  file records each request's size, so the Cat 40 figures the tier could touch are ranges. Elsewhere every request
  whose size is committed is under 272,000 tokens, and the figures whose request sizes aren't committed say what they
  assume. The Cat 40 agent loop, which the program-primary lane and the multi-source scope test also use, and the Q1 cell runner priced each agent turn's recorded usage without reading that
  count until gbrain-evals #397 (`02fc9ca8`) fixed `eval/runner/q1/usage.ts`; the loop's judge path still doesn't
  read it. Budget ledgers from before `8a8e502a` (October 8) booked those tokens as input too, and so did several
  other runners' own price code. Anthropic reports its cache writes in a field of their own, which every path reads, so
  no Claude figure moves. The figures below are repriced from the usage the responses reported, committed with each
  report, and checked against the ledgers that do price cache writes: on runs where nothing was charged at its
  reservation, the ledger minus the runner's rows equals the predicted difference to within half a cent. No provider
  was called. No score or verdict changes, no ranking a report states changes, and each report keeps its
  original figure beside the correction. The [audit](audit/2026-11-09-openai-cache-writes.md) lists every figure.
  Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.
- **The BEAM-1M failure analysis's gpt-6.1-sol reading arms cost 18% to 21% more than published.** A2 to A5 are
  repriced from the answers' recorded input tokens. The no-memory floor is unchanged, because all its prompts are
  under 1,024 tokens, and the arms' order by cost is unchanged.
  [Report](benchmarks/2026-10-08-beam-1m-failure-analysis.md#2-reading-arms-on-the-frozen-evidence).
- **gpt-6.1-sol's dollars in the program-primary lane are low.** Its dollars per run are $0.116 in the baseline (was
  $0.100) and $0.088 in the hard baseline (was $0.075). The sealed confirmation's are at most $0.0931 against $0.0893
  (was $0.077 against $0.075); its sealed rows are not committed, so these give Sol the whole gap between each arm's
  ledger and its cells, and their ratio is 1.04x at the recorded dollars and at both upper bounds; the committed data
  allow 0.87x to 1.24x, inside the 1.5x envelope. The hard root cause's Sol dollar ratio is 1.00x (was 1.01x), the alias
  stack's development ratio 1.10x (was 1.09x) and Candidate 1's fresh-seed ratio 1.02x (was 1.01x). The proactive
  brief's dollars per cell, all three readers together, are $0.196 off and $0.183 on (was $0.190 and $0.179), and $0.214
  and $0.196 in v2 (was $0.208 and $0.192). Every envelope stays inside its limits.
  [Baseline](benchmarks/2026-10-08-program-primary-baseline.md),
  [hard baseline](benchmarks/2026-10-08-program-primary-hard-baseline.md),
  [sealed confirmation](benchmarks/2026-10-11-t0b-sealed-confirmation.md),
  [hard root cause](benchmarks/2026-10-08-program-primary-hard-root-cause.md),
  [alias stack](benchmarks/2026-10-09-alias-stack.md),
  [Candidate 1](benchmarks/2026-10-09-candidate-1-newer-mentions.md),
  [proactive brief](benchmarks/2026-10-14-proactive-brief-dev.md),
  [proactive brief v2](benchmarks/2026-10-15-proactive-brief-dev-v2.md).
- **Cat 40's gpt-6.1-sol, gpt-6-sol, gpt-6-luna and gpt-6-astra dollars are low.** Repriced from the committed results
  rows with the repository's own analyzers, single-model figures rise 15% to 23% for gpt-6.1-sol at the low end and up
  to 141% at the high end, where every session could have passed 272,000 input tokens (scale-tier memory dollars per
  success); gpt-6-sol's rise 14% to 19%, up to 85%; gpt-6-astra's 13% to 19%, up to 33%; gpt-6-luna's about 9% to 18%.
  On the Hard confirmation's M world, Sol's dollars per success are $0.38 to $0.45 with gbrain and $0.28 to $0.35 with
  files (was $0.32 and $0.24). Figures averaged over several models rise 1% to 7% at the low end and up to 25% at the
  high end: on the first world, gbrain and files cost $0.248 and $0.115 to $0.116 per task (was $0.238 and $0.112),
  still about twice, and on the October 7 Hard world gbrain stays cheaper per task than files (0.72 to 0.78 against 0.99
  to 1.00, was 0.69 against 0.98). Each low end assumes that only the first request of a simple-arm session (fs, fs-acl,
  pg, memory or oracle) can be under 1,027 tokens; the rows record session totals, so they can't confirm it, and each
  request that breaks it lowers that session's true premium by at most 1,026 tokens at its model's cache-write premium,
  about $0.0005 for gpt-6.1-sol and $0.0026 for gpt-6-astra. The Hard confirmation's S world, the sealed next-confirm
  cells, the Hard calibration and the P8 surface held-out verdict have no committed rows, so they are not recomputed.
  [Model ladder](benchmarks/2026-10-02-model-ladder.md),
  [Hard](benchmarks/2026-10-07-model-ladder-hard.md),
  [Hard confirmation](benchmarks/2026-10-10-model-ladder-hard-confirmation.md),
  [audit](audit/2026-11-09-openai-cache-writes.md#cat-40).
- **Other runners' OpenAI dollars are low too.** N2's contradiction judges cost $0.24 per 1,000 pairs with gpt-6-luna
  (was $0.21), still the cheapest passing model, and $3.22 with gpt-6.1-sol (was $2.69); README's row gives the new
  figure. SkillOpt's gpt-6.1-sol costs per correct answer rise by about a fifth and stay below Opus 5.5's in every
  cell. The multi-source scope test's Sol and Astra costs per trial, content repair's Sol cost per pair and the SkillOpt
  ceiling's Sol price per rollout move too, and that price stays under the ceiling's re-price trigger. The memory proof
  wave's rebuilt cell ledger no longer fits its approved cap with the full frontier sweep if gpt-6-astra's cache writes
  behave like Sol's (no Astra request ran in that lane); the 10% sweep option fits either way. Figures from memory
  trust, facts extraction, Hangul mention boundaries, expansion latency, Q2's G6 ingest and P4 can only be bounded,
  because their rows aren't committed.
  [N2](benchmarks/2026-10-06-n2-judges.md),
  [SkillOpt method](benchmarks/2026-11-01-skillopt-method/REPORT.md),
  [cell ledger](../eval/harness-provider/LEDGER.md),
  [audit](audit/2026-11-09-openai-cache-writes.md#other-runners).
- **The particle-1 F6 add-on's gpt-6.1-sol reader dollars are low by an unknown amount** (2026-11-09). report.md's
  Sol rows (dollars and dollars per correct answer for F6's Sol reader) were priced before #397, and the per-answer
  usage stays in custody, so they are not recomputed here. The cache-write rate is a quarter above the input rate, so
  the re-read rows, whose contexts are 8,000 tokens, are low by at most a quarter. The file agent's row can be low by
  more: its runner never applied OpenAI's long-context rates and its request sizes aren't committed, so if a request
  passed 272,000 input tokens, its Sol figures could be up to 2.5 times as high. particle-1's and Opus 5.5's figures,
  every accuracy figure and both judges' results are unaffected. Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.
  [Finding](findings/2026-11-04-particle-1-f6-addon.md#limits).

## Full-context reads and OpenAI's prompt cache

- **Q1's full-context reads never let GPT-6.1 Sol read a history back from OpenAI's prompt cache** (2026-11-10). From
  GPT-5.6 on, OpenAI writes and looks up its prompt cache only at breakpoints, and with no explicit breakpoint the only
  one falls at the end of the last user message. Q1's full-context reader (`answerFullContext` in
  `eval/runner/systems/baselines.ts`) sent Sol the whole conversation history and the question as one message, so
  that breakpoint fell after the question. Every question on a conversation wrote the whole history to the cache
  again, at the cache-write rate, and no later question read it back. Claude readers already sent the history as a
  cached prefix and did read it back. From 2026-11-10 the reader sends Sol the same text with an explicit breakpoint at
  the end of the history. The model reads the same text, so answers and accuracy should not change, but no run has
  checked that; the change is meant to lower cost. Q1 publishes no cost per answer, so the
  one published figure this reaches is S2b full-context's settled spend, which includes 20 Sol answers, 10 on each of
  the two BEAM-1M conversations that fit Sol's window, in the [scoreboard report](benchmarks/2026-10-06-scoreboard-report.md), README's scoreboard block
  and the [scoreboard tables](benchmarks/2026-10-06-scoreboard/scoreboard.md). It was measured with a harness that
  never let a later question hit OpenAI's prompt cache, so it overstates that arm's cost. It stays as measured, and no corrected figure is
  given, because none was measured. The README block and the tables are generated from the sealed receipt, so neither
  changes: README carries a note under its block, and the tables carry no note of their own, so the scoreboard
  report's note covers them. Sol's full-context reads on BEAM-100K and LoCoMo ran the same way and
  publish no cost. The [dev smokes](benchmarks/2026-10-06-scoreboard/dev-smokes/README.md)' full-context cell ran the
  same reader, and its page says what that means for its two figures. Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.
  [Report](benchmarks/2026-10-06-scoreboard-report.md).
- **W10c's whole-history reader costs are for one question per history** (2026-11-10). Each of W10c's 150 LongMemEval
  questions comes with its own history, and each history was read once. No whole-history read could reuse a prompt
  cache: all 150 GPT-6.1 Sol reads were cache writes with no cache reads, by design rather than because of the
  breakpoint above. The figures stand as the cost of one read of a whole history. The comparison drawn from them,
  that gbrain's recurring reader cost per question is about a seventh of the whole history's, holds when each history
  is asked one question. A history that answers several questions can stay in a prompt cache, and later questions then
  pay the cached-input rate for it. W10c didn't measure that, so with several questions per history the whole history
  would cost less per question than these figures show, and gbrain's cost advantage would be smaller. README,
  [W10c](benchmarks/2026-10-07-longmemeval-w10c-full-context.md) and the
  [particle-1 replay](benchmarks/2026-11-01-longmemeval-particle-replay/REPORT.md) say so beside the figures. No
  accuracy figure or verdict changes. gbrain is Garry Tan's own project. Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.

## Predictive measures

- **Recall (G2)'s paraphrase-gap claim was stated as a prediction before anything tested it as one** (2026-11-11). The
  [results](benchmarks/2026-11-10-predictive-measures.md) said the synthetic recall brain catches the real brain's
  paraphrase gap only when it carries the real brain's embedding gaps. Every number and verdict reproduces, but the
  gap-copied brain became the counted condition after batch 2's results were public. The clean brain agrees on 12 of
  the 13 qualifying contrasts, so the gaps' whole effect is one contrast, from 7 of 100 questions. And the 13 contrasts
  share 5 setups and one set of questions, so they're worth about 5 to 8 independent checks. G2 now reads PREDICTIVE for
  which search setup beats which. Its paraphrase-gap prediction read PENDING until a held-out replication on batch 4
  (2026-11-12) found it HELD for direction ([results](benchmarks/2026-11-12-g2-paraphrase-gap-replication.md)), so G2
  may gate on the gap's direction, never its size. Its paraphrase Kendall tau of 0.80 breaks a synthetic
  tie by list order; as tau-b it is 0.949. Tau never gates. gbrain is Garry Tan's own project.

## Changelog

### 2026-11-12: Strict-source pageless facts

A new Writing memory entry says the strict-source pageless facts report overstated its title-only pages (45 of 99,
now 39) and described labels its eval agent made as hand-made.

### 2026-11-12: Predictive measures, batch 4

The recall (G2) entry says that its paraphrase-gap prediction, PENDING when the entry was written, held for direction
on held-out batch 4.

### 2026-11-11: Predictive measures

A new section says that recall (G2)'s PREDICTIVE reading covers which search setup beats which, that its
paraphrase-gap prediction is PENDING a held-out replication, and why, with the paraphrase Kendall tau's tie.

### 2026-11-10: Full-context reads and OpenAI's prompt cache

A new section says Q1's full-context reader never let GPT-6.1 Sol read a history back from OpenAI's prompt cache, so
S2b full-context's spend overstates that arm's cost, and that W10c's whole-history costs are for one question per
history, so its "about a seventh" comparison holds for that case. The W10c entry above points to it.

### 2026-11-09: OpenAI cache writes

A new section lists the reports whose gpt-6.1-sol, gpt-6-sol, gpt-6-luna and gpt-6-astra dollars counted OpenAI's cache
writes as plain input, or in Cat 40 missed OpenAI's long-context rates: the BEAM-1M failure analysis, the
program-primary lane, Cat 40 and other runners, with the figures that move, the ones that can only be bounded and the
F6 add-on's Sol reader rows that custody holds. The [audit](audit/2026-11-09-openai-cache-writes.md) lists every
figure, and its three keyless tools recompute them from committed files.

### 2026-11-04: W10's superiority p values and the Fable sensitivity note

A LongMemEval entry is added: the superiority gate's p was a bootstrap share, not a p-value. With the exact one-sided
sign-flip p no W10 verdict changes, but W10b's Fable sensitivity note no longer holds (0.061, was 0.041), and the
entry lists the p values that move. The W10b ranking entry's Holm p is 0.0002 (was 0.0006).
[Audit](audit/2026-11-04-superiority-p.md).

### 2026-11-03: The Q1 file agent's entry after the custody re-render

The Q1 entry now says README's block and the scoreboard tables show the re-render (`bf902d9f`), with the printed
figures, the file agent's two S1 sensitivity views and the loss bullet's new comparison (67.6% against 58.9% on 198
questions). It also says no stop's HTTP status was recorded, so "the provider refused at its context limit" became a
classification from the error text with the stops' shape as the evidence.

### 2026-11-03: The Q1 file agent's context-overflow stops

A new Q1 head-to-head scoreboard section lists the file agent's BEAM-10M and BEAM-1M sealed cells, which counted its 7
`context_overflow` stops as harness failures instead of product failures scored 0, with the custodian's rescore and
what the next custody render changes.

### 2026-11-02: The GPT-6.1 Sol entry carries the gbrain and OpenAI lines

The GPT-6.1 Sol entry reports an OpenAI model's costs and gbrain's recurring cost beside particle-1's, so after the
Particle line it carries the gbrain and OpenAI lines from [disclosures](disclosures.md). No figure changed.

### 2026-11-01: The particle-1 cost comparison carries its disclosure

The GPT-6.1 Sol entry's comparison with particle-1's cost carries the line from [disclosures](disclosures.md). No
figure changed.

### 2026-11-01: particle-1 replay and GPT-6.1 Sol cost figures

The recheck behind the [particle-1 W10b finding](findings/2026-11-01-particle-1-longmemeval-w10b.md) recounted the
replay's numbers from its committed rows. Every quoted count and interval reproduced, and so did every particle-1
cost. Three entries are added under LongMemEval. The first covers two figures in the replay report: Opus 5.5's list cost
per correct answer in the results table ($0.0994, correctly $0.0993) and the batch-price figures for Opus 5.5 and
Sonnet 5.5 ($0.0507 and $0.0255, at the batch rate $0.0497 and $0.0250). The second reprices GPT-6.1 Sol's reader
costs in W10b, W10c and the replay report at OpenAI's cache-write rate, which W10's ledger did not yet apply. The third
records that the W10b report's opening sentence calls Opus 5.5 the strongest reader, which its preregistered test does
not support; README's row was reworded in the same change.

### 2026-11-01: Page created from README's corrections

Created in the documentation refresh at gbrain `3ec766c40` (v0.60.531.0), gbrain-evals #241. README's
`## Corrections` section moved here, so README's current state shows only numbers that stand. The entries keep their
wording, grouped by topic, with two changes: the query-expansion entry names the commit it was measured at
(`109b992`, was "current gbrain") and links its recount. Two entries are new on this page, moved from current-state
text elsewhere: the invalid May PrecisionMemBench rows, which [comparisons](comparison-systems.md) showed struck
through in its table, and the retirement of the first Cat 40 world's success figures, which README told inside its
agent-task comparison.
