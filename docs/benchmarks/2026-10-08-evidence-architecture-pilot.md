# Evidence architecture pilot: a model-written brief keeps Sonnet 5.5 within 1 point of whole sessions at a sixth of the cost, but a cheap model reading the whole sessions matches the brief for less, so the preregistered off-ramp fires

Date: 2026-10-08 (Pacific). Wave 1 items A3, A4, A5 and A10 of the approved "Build the 10x memory advantage" plan
(thread GBRA-60; plan on gbrain-evals branch `capy/10x-memory-advantage-plan`). Evidence class: **development**
(LongMemEval-S, a 100-question pilot split; no sealed set opened). Preregistration:
[2026-10-08-evidence-architecture-pilot-preregistration.md](2026-10-08-evidence-architecture-pilot-preregistration.md),
committed before any paid request (`6d192070`), with amendment 1 (`1fd8a2d7`) committed after a $0.11 shape probe
and before any counted cell. Spend: $60.48 of an $80 ledger cap. Status: every preregistered cell **complete**.
Loss tolerance: 3.0 points, the plan's proposal, which this pilot used as a working value. T0 froze the same
3.0 points in its own preregistration (`1e5caf37`, committed on its branch while this pilot ran and merged in #105),
so the verdict needs no recomputation.

[gbrain](https://github.com/garrytan/gbrain) is a Markdown-first memory system for agents. When an agent asks a
question about old conversations, gbrain retrieves the five best-matching conversations and hands a reader model
their full text: about 14,000 tokens per question on [LongMemEval](https://arxiv.org/abs/2410.10813), a benchmark
of questions about long chat histories. This pilot asks whether a smaller, smarter hand-off does as well for less:
a short evidence brief written by a cheap model, a write-time digest of each conversation, a cheap model reading
the whole text itself, a cheap model that escalates to a frontier model when unsure, provider prompt caching, or
plain truncation.

## The finding

**The brief works, and it is not the cheapest design that works.** On Sonnet 5.5 (the plan's primary reader), the
whole sessions (A0) answer 93 of 100. A brief of about 740 tokens written by `claude-haiku-5-5` answers 92 at
$0.0079 a question, against A0's $0.0473: within the 3-point tolerance, one question discordant each way short of
A0 (exact McNemar p = 1.0), at a sixth of the dollars. The `gpt-6-luna` builder's brief answers 91 at $0.0110. So
the first half of the off-ramp (the brief misses for every builder) does not fire.

**The second half does.** `claude-haiku-5-5` reading the identical whole sessions itself (DIRECT) answers 89 with 7
committed-wrong answers, at $0.0025 a question and a synchronous p95 of 4.0 seconds. Against the best brief (92,
6 committed-wrong, $0.0079, p95 8.6 seconds), it is within 3 points and 3 committed-wrong answers, cheaper and
faster, which is the preregistered condition for "a cheaper design matches the brief". Per the plan, wave 1 stops
before A6 ($120), A8 and A9, and the cheaper design is what ships.

**State the catch plainly.** The off-ramp rule compares the cheaper design with the brief, not with A0. DIRECT with
Haiku is 4 points below A0 (93 to 89: 4 questions A0 got right and DIRECT missed, none the other way; exact
McNemar p = 0.125), so it sits
outside the 3-point tolerance against whole sessions, while the brief sits inside it. On n = 100 that is one
question past the line. The rule fires as written; the report recommends DIRECT with Haiku as an opt-in cheap reader
policy with that gap on its label, and names FALLBACK (Haiku, escalating to Sonnet 5.5 on hedged or declined
answers: 91, $0.0205, p95 6.7 s) as the option that stays within A0's tolerance. Neither should become a default
without confirmation on more questions.

**What the other designs show.**
- *The brief is slow.* Its builder is a serial model call before the reader: p95 8.6 s (Haiku builder) and 7.6 s
  (luna) against A0's 2.5 s on Sonnet 5.5. That is more than 3x A0, far outside the +20% latency gate A8 would have to pass.
- *Truncation loses badly.* Keeping whole sessions in rank order until 2,000 tokens answers 49; at 7,000 tokens, 79.
  The answer is usually not in the top-ranked session alone.
- *Write-time digests lose at small budgets* (36 to 46 at 1,000 tokens, 69 to 74 at 2,000) and approach the brief
  only at 7,000 tokens (86 to 87), while costing about $0.04 a question to write every haystack session once.
- *Caching saves money only when evidence is re-read.* A warm prefix read cut a Sonnet 5.5 request from $0.058 to
  about $0.006 and was served 99.98% from cache, but did not cut latency (p95 2.6 s cold and warm). At one read per prefix,
  which is what LongMemEval does, CACHE costs more than A0 (the write premium); at 5 reads, $0.017.
- *No design reduced committed-wrong answers.* A0 commits to a wrong value 6 times (Sonnet 5.5), the best brief 6,
  DIRECT 7. Representation is not the lever for bet (a), fewer confident wrong answers.
- *Opus 5.5* answers 94 on whole sessions ($0.097) and 93 on the Haiku brief ($0.016).

## The concrete case

*From the data.* Question `001be529` asks how long the user waited for a decision on an asylum application. gbrain
delivered five conversations, 12,336 tokens of text; the answer is one sentence in one of them ("Over a year of
uncertainty was really tough"). The Haiku-built brief for this question is two claims, each with a verbatim quote, its
conversation's id and date, inside the same `<chat_session>` framing the reader already treats as untrusted data.
The reader gets 401 tokens instead of 12,336, and the judge marks its answer correct. One of the two paraphrases
("did not state a specific duration") was withheld by the negation check, so the reader saw only its quote.

*Invented, to show the failure the checks target.* A session says "We decided not to book the lake venue." A
builder writes "The team booked the lake venue" and quotes the sentence. The quote is found verbatim, so a
provenance check passes it. The brief validator compares negation in the paraphrase and the quote, withholds the
paraphrase, and shows the reader only the quote. Grounding proves where a claim came from, not that it is right.

## The experiment

**Evidence.** Every arm replays the same frozen reader request: the W10a captures of gbrain `c5fb0201`'s own
LongMemEval-S requests (release retrieval: balanced mode, reranker on, top 5 whole sessions). An arm changes only
the evidence section of that request; the question, date and reader instruction stay byte for byte. A test proves
the A0 bodies are byte-identical to the committed W10a (Sonnet 5.5) and W10c (`gpt-6.1-sol`) batch manifests, so
those committed answers serve as A0 for those readers.

**Questions.** A 100-question pilot split, drawn stratified by question type from W10c's 150-question subset
(seed 20261007): temporal reasoning 25, multi-session 24, knowledge update 15, single-session user 13,
single-session assistant 11, preference 6, unanswerable 6. The other 400 questions are the untouched confirm split.

**Arms.** Budgets are cl100k tokens of delivered evidence (1,000, 2,000, 4,000, 7,000).

| Arm | What the reader gets |
|---|---|
| A0 | the five whole sessions (about 14,000 tokens) |
| DIRECT | a cheap model (`gpt-6-luna` or `claude-haiku-5-5`) reads the same whole sessions and answers |
| FALLBACK | DIRECT's answer, replaced by the frontier reader's A0 answer when the cheap answer is an error, or is labeled declined or hedged |
| BRIEF@B | a cheap builder reads the five sessions with the question and writes `evidence-brief-v1` claims; quotes are grounded, ungrounded claims dropped, and the full text delivered instead when grounding fails |
| DIGEST@B | a question-independent digest of each session (B/5 tokens each), written once per session at ingest |
| CACHE | A0's request with provider prompt caching on the whole prefix |
| TRUNC@B | whole sessions in rank order while they fit B; else the top session's head |

Frontier readers: `claude-sonnet-5-5` and `gpt-6.1-sol` on every cell; `claude-opus-5-5` on A0 and the two leading
arms (picked by mean success across the two readers, ties to lower dollars: BRIEF@2000 and BRIEF@7000 with the
Haiku builder). No Fable, no older generation.

**Metrics.** Supported task success: the official LongMemEval judge (`gpt-4o-2024-08-06`) says the answer is right
(for unanswerable questions, that it declined). Every execution error counts as a failure. Committed-wrong: an
incorrect answer that commits to a value however it is hedged (outcome-v3, A10 below); the bound in parentheses
counts every wrong answer as committed. Dollars: every model call in the design at list price (builder, digest
writer, reader, the routing label and the fallback reader), from usage-receipt/v1 provider usage; batch pricing
would halve the reader cost of A0 and is a cost column only. p95: the synchronous timing cohort below.

**Timing cohort.** 24 of the 100 questions (stratified, seed 20261008), 20 cells at 2,000 tokens, 480 units run one
request at a time in a seeded random order with no answer cache. Each unit times builder, reader, routing label and
fallback calls end to end; retrieval is replayed, identical across arms and not timed. A reader call whose usage
reports a prompt-cache read is in the cache-hit stratum. CACHE sends each request cold and again inside the TTL.
DIGEST's digests are written at ingest, so its latency is the reader's alone.

## Results

### The pilot table (n = 100 per row)

Rows are `arm@budget:builder:reader`. p95 comes from the cohort, which ran at the 2,000-token budget only; rows at
other budgets were not timed (their reader-side latency tracks delivered tokens, and BRIEF's builder call does not
depend on the budget).

| Cell | Success /100 | Committed-wrong (bound) | Abstained | $ / question (list) | Builder $ | Reader in / out tokens | Delivered cl100k | Builder in / out tokens | p95 ms (cohort) | A0 right, cell wrong / reverse |
|---|---|---|---|---|---|---|---|---|---|---|
| `a0:Sonnet 5.5` | 93 | 6 (7) | 1 | 0.0473 | 0.0000 | 22,645 / 201 | 14,030 |  | 2,540 |  |
| `cache:Sonnet 5.5` | 93 | 6 (7) | 1 | 0.0473 | 0.0000 | 22,645 / 201 | 14,030 |  | 2,610 | 0 / 0 |
| `a0:gpt-6.1-sol` | 92 | 7 (8) | 1 | 0.0362 | 0.0000 | 14,040 / 110 | 14,030 |  | 4,104 |  |
| `cache:gpt-6.1-sol` | 92 | 7 (8) | 1 | 0.0362 | 0.0000 | 14,040 / 110 | 14,030 |  | 5,792 | 0 / 0 |
| `direct:luna` | 84 | 11 (16) | 5 | 0.0018 | 0.0000 | 14,040 / 85 | 14,030 |  | 2,204 |  |
| `direct:haiku` | 89 | 7 (11) | 4 | 0.0025 | 0.0000 | 22,645 / 420 | 14,030 |  | 3,970 |  |
| `fallback:luna>Sonnet 5.5` (escalated 21%) | 86 | 13 (14) | 1 | 0.0137 | 0.0000 | 18,882 / 126 | 14,030 |  | 4,719 | 8 / 1 |
| `fallback:luna>gpt-6.1-sol` (escalated 21%) | 86 | 13 (14) | 1 | 0.0114 | 0.0000 | 17,047 / 109 | 14,030 |  | 6,753 | 7 / 1 |
| `fallback:haiku>Sonnet 5.5` (escalated 33%) | 91 | 8 (9) | 1 | 0.0205 | 0.0000 | 30,025 / 498 | 14,030 |  | 6,709 | 2 / 0 |
| `fallback:haiku>gpt-6.1-sol` (escalated 33%) | 90 | 9 (10) | 1 | 0.0168 | 0.0000 | 27,229 / 462 | 14,030 |  | 7,564 | 3 / 1 |
| `trunc@1000:Sonnet 5.5` | 47 | 11 (53) | 42 | 0.0052 | 0.0000 | 1,808 / 155 | 962 |  | not in cohort | 47 / 1 |
| `trunc@1000:gpt-6.1-sol` | 43 | 13 (57) | 44 | 0.0039 | 0.0000 | 1,147 / 105 | 962 |  | not in cohort | 50 / 1 |
| `brief@1000:luna:Sonnet 5.5` (11 full-text fallbacks) | 90 | 4 (10) | 6 | 0.0107 | 0.0020 | 3,407 / 194 | 2,023 | 14,402 / 375 | not in cohort | 3 / 0 |
| `digest@1000:luna:Sonnet 5.5` | 36 | 14 (64) | 50 | 0.0084 | 0.0041 | 1,206 / 198 | 653 | 16,552 / 3,971 | not in cohort | 59 / 2 |
| `brief@1000:luna:gpt-6.1-sol` (11 full-text fallbacks) | 84 | 11 (16) | 5 | 0.0056 | 0.0020 | 2,198 / 120 | 2,023 | 14,402 / 375 | not in cohort | 9 / 1 |
| `digest@1000:luna:gpt-6.1-sol` | 27 | 12 (73) | 61 | 0.0068 | 0.0041 | 845 / 104 | 653 | 16,552 / 3,971 | not in cohort | 66 / 1 |
| `brief@1000:haiku:Sonnet 5.5` (1 full-text fallbacks) | 88 | 10 (12) | 2 | 0.0078 | 0.0028 | 1,338 / 226 | 720 | 23,147 / 1,056 | not in cohort | 7 / 2 |
| `digest@1000:haiku:Sonnet 5.5` | 46 | 19 (54) | 35 | 0.0090 | 0.0047 | 1,228 / 189 | 678 | 26,156 / 4,142 | not in cohort | 49 / 2 |
| `brief@1000:haiku:gpt-6.1-sol` (1 full-text fallbacks) | 88 | 7 (12) | 5 | 0.0061 | 0.0028 | 910 / 134 | 720 | 23,147 / 1,056 | not in cohort | 6 / 2 |
| `digest@1000:haiku:gpt-6.1-sol` | 43 | 20 (57) | 37 | 0.0075 | 0.0047 | 871 / 111 | 678 | 26,156 / 4,142 | not in cohort | 50 / 1 |
| `trunc@2000:Sonnet 5.5` | 49 | 18 (51) | 33 | 0.0081 | 0.0000 | 3,285 / 157 | 1,884 |  | 2,271 | 46 / 2 |
| `trunc@2000:gpt-6.1-sol` | 48 | 20 (52) | 32 | 0.0062 | 0.0000 | 2,056 / 104 | 1,884 |  | 4,860 | 45 / 1 |
| `brief@2000:luna:Sonnet 5.5` (12 full-text fallbacks) | 91 | 5 (9) | 4 | 0.0110 | 0.0020 | 3,549 / 189 | 2,114 | 14,402 / 389 | 7,626 | 4 / 2 |
| `digest@2000:luna:Sonnet 5.5` | 69 | 9 (31) | 22 | 0.0110 | 0.0044 | 2,240 / 209 | 1,340 | 16,552 / 4,761 | 3,541 | 27 / 3 |
| `brief@2000:luna:gpt-6.1-sol` (12 full-text fallbacks) | 88 | 5 (12) | 7 | 0.0087 | 0.0020 | 2,288 / 124 | 2,114 | 14,402 / 389 | 8,410 | 5 / 1 |
| `digest@2000:luna:gpt-6.1-sol` | 60 | 9 (40) | 31 | 0.0093 | 0.0044 | 1,517 / 109 | 1,340 | 16,552 / 4,761 | 5,287 | 32 / 0 |
| `brief@2000:haiku:Sonnet 5.5` (1 full-text fallbacks) | 92 | 6 (8) | 2 | 0.0079 | 0.0029 | 1,359 / 225 | 741 | 23,147 / 1,158 | 8,631 | 2 / 1 |
| `digest@2000:haiku:Sonnet 5.5` | 74 | 11 (26) | 15 | 0.0106 | 0.0049 | 1,903 / 192 | 1,141 | 26,156 / 4,584 | 2,907 | 23 / 4 |
| `brief@2000:haiku:gpt-6.1-sol` (1 full-text fallbacks) | 90 | 4 (10) | 6 | 0.0057 | 0.0029 | 934 / 118 | 741 | 23,147 / 1,158 | 10,872 | 5 / 3 |
| `digest@2000:haiku:gpt-6.1-sol` | 71 | 11 (29) | 18 | 0.0093 | 0.0049 | 1,326 / 113 | 1,141 | 26,156 / 4,584 | 6,783 | 22 / 1 |
| `trunc@4000:Sonnet 5.5` | 54 | 18 (46) | 28 | 0.0120 | 0.0000 | 5,188 / 165 | 3,072 |  | not in cohort | 40 / 1 |
| `trunc@4000:gpt-6.1-sol` | 48 | 19 (52) | 33 | 0.0089 | 0.0000 | 3,228 / 106 | 3,072 |  | not in cohort | 45 / 1 |
| `brief@4000:luna:Sonnet 5.5` (15 full-text fallbacks) | 89 | 5 (11) | 6 | 0.0125 | 0.0020 | 4,340 / 182 | 2,610 | 14,402 / 379 | not in cohort | 5 / 1 |
| `digest@4000:luna:Sonnet 5.5` | 83 | 11 (17) | 6 | 0.0156 | 0.0049 | 4,307 / 214 | 2,672 | 16,552 / 5,610 | not in cohort | 11 / 1 |
| `brief@4000:luna:gpt-6.1-sol` (15 full-text fallbacks) | 87 | 5 (13) | 8 | 0.0063 | 0.0020 | 2,777 / 122 | 2,610 | 14,402 / 379 | not in cohort | 6 / 1 |
| `digest@4000:luna:gpt-6.1-sol` | 84 | 7 (16) | 9 | 0.0130 | 0.0049 | 2,827 / 110 | 2,672 | 16,552 / 5,610 | not in cohort | 11 / 3 |
| `brief@4000:haiku:Sonnet 5.5` (2 full-text fallbacks) | 90 | 8 (10) | 2 | 0.0083 | 0.0029 | 1,566 / 223 | 870 | 23,147 / 1,196 | not in cohort | 3 / 0 |
| `digest@4000:haiku:Sonnet 5.5` | 86 | 7 (14) | 7 | 0.0138 | 0.0050 | 3,326 / 208 | 2,100 | 26,156 / 4,814 | not in cohort | 9 / 2 |
| `brief@4000:haiku:gpt-6.1-sol` (2 full-text fallbacks) | 84 | 7 (16) | 9 | 0.0065 | 0.0029 | 1,061 / 130 | 870 | 23,147 / 1,196 | not in cohort | 11 / 3 |
| `digest@4000:haiku:gpt-6.1-sol` | 84 | 8 (16) | 8 | 0.0118 | 0.0050 | 2,267 / 106 | 2,100 | 26,156 / 4,814 | not in cohort | 9 / 1 |
| `trunc@7000:Sonnet 5.5` | 79 | 11 (21) | 10 | 0.0196 | 0.0000 | 8,872 / 183 | 5,378 |  | not in cohort | 18 / 4 |
| `trunc@7000:gpt-6.1-sol` | 74 | 14 (26) | 12 | 0.0148 | 0.0000 | 5,504 / 106 | 5,378 |  | not in cohort | 19 / 1 |
| `brief@7000:luna:Sonnet 5.5` (12 full-text fallbacks) | 89 | 5 (11) | 6 | 0.0112 | 0.0020 | 3,660 / 187 | 2,175 | 14,402 / 366 | not in cohort | 5 / 1 |
| `digest@7000:luna:Sonnet 5.5` | 87 | 7 (13) | 6 | 0.0183 | 0.0054 | 5,398 / 211 | 3,351 | 16,557 / 6,681 | not in cohort | 9 / 3 |
| `brief@7000:luna:gpt-6.1-sol` (12 full-text fallbacks) | 88 | 5 (12) | 7 | 0.0084 | 0.0020 | 2,346 / 117 | 2,175 | 14,402 / 366 | not in cohort | 6 / 2 |
| `digest@7000:luna:gpt-6.1-sol` | 87 | 5 (13) | 8 | 0.0153 | 0.0054 | 3,500 / 112 | 3,351 | 16,557 / 6,681 | not in cohort | 8 / 3 |
| `brief@7000:haiku:Sonnet 5.5` | 91 | 7 (9) | 2 | 0.0075 | 0.0029 | 1,150 / 226 | 612 | 23,147 / 1,162 | not in cohort | 4 / 2 |
| `digest@7000:haiku:Sonnet 5.5` | 87 | 8 (13) | 5 | 0.0141 | 0.0051 | 3,474 / 201 | 2,201 | 26,161 / 4,992 | not in cohort | 8 / 2 |
| `brief@7000:haiku:gpt-6.1-sol` | 90 | 7 (10) | 3 | 0.0059 | 0.0029 | 807 / 135 | 612 | 23,147 / 1,162 | not in cohort | 6 / 4 |
| `digest@7000:haiku:gpt-6.1-sol` | 86 | 9 (14) | 5 | 0.0120 | 0.0051 | 2,366 / 102 | 2,201 | 26,161 / 4,992 | not in cohort | 8 / 2 |
| `a0:Opus 5.5` | 94 | 5 (6) | 1 | 0.0966 | 0.0000 | 22,645 / 299 | 14,030 |  | not in cohort |  |
| `brief@2000:haiku:Opus 5.5` (1 full-text fallbacks) | 93 | 7 (7) | 0 | 0.0156 | 0.0029 | 1,359 / 363 | 741 | 23,147 / 1,158 | not in cohort | 4 / 3 |
| `brief@7000:haiku:Opus 5.5` | 90 | 9 (10) | 1 | 0.0147 | 0.0029 | 1,150 / 362 | 612 | 23,147 / 1,162 | not in cohort | 5 / 1 |

The 6 unanswerable questions are in every denominator. No reader, builder or judge call ended in an error in any
counted cell or in the cohort.

### Latency (timing cohort, 24 questions, milliseconds)

| Cell | p50 | p95 | p95 cold | p95 cache-hit |
|---|---|---|---|---|
| `a0:Sonnet 5.5` | 1,837 | 2,540 | 2,540 | |
| `cache:Sonnet 5.5` (cold and warm) | 1,738 | 2,610 | 2,591 | 2,613 |
| `a0:gpt-6.1-sol` | 3,034 | 4,104 | 5,841 | 3,928 |
| `cache:gpt-6.1-sol` (cold and warm) | 2,999 | 5,792 | 6,013 | 4,824 |
| `direct:luna` | 1,443 | 2,204 | 1,611 | 2,479 |
| `direct:haiku` | 2,329 | 3,970 | 3,970 | |
| `fallback:luna>Sonnet 5.5` | 2,493 | 4,719 | | |
| `fallback:haiku>Sonnet 5.5` | 4,113 | 6,709 | | |
| `trunc@2000:Sonnet 5.5` | 1,685 | 2,271 | | |
| `brief@2000:luna:Sonnet 5.5` | 4,444 | 7,626 | | |
| `brief@2000:haiku:Sonnet 5.5` | 6,854 | 8,631 | | |
| `digest@2000:haiku:Sonnet 5.5` | 1,783 | 2,907 | | |

The brief's builder alone takes a p95 of 7.0 s (Haiku) or 5.0 s (luna); its reader call is as fast as A0's. The
`gpt-6.1-sol` rows and every other cohort cell are in `pilot-report.json`. Some `gpt-6.1-sol` calls were cache hits
because OpenAI caches prefixes on its own and other cells for the same question shared the opening of the request.

### CACHE dollars per read (24 cold and warm pairs per reader)

| Reader | 1 read per prefix | 2 reads | 5 reads | Warm reads served from cache |
|---|---|---|---|---|
| Sonnet 5.5 | $0.0582 | $0.0323 | $0.0167 | 24 of 24 |
| `gpt-6.1-sol` | $0.0360 | $0.0192 | $0.0091 | 24 of 24 |

### DIGEST's write-time cost

Digesting every haystack session once (about 48 per LongMemEval-S history) costs about $0.036 to $0.049 a question
when a history is asked one question, the LongMemEval case; the table's "$ / question" for DIGEST charges only the
five delivered sessions' digests. Digests are reused across questions, so the write cost per question falls with
the number of questions asked of the same history; it is still the most expensive design here at one question per
history.

### The brief builder's checks across 800 briefs (A3)

| Builder | Briefs | Delivered as brief | Full-text fallback | Claims | Grounded | Dropped: number not in source | Dropped: quote not found | Paraphrase withheld (negation) | Uncited corrections appended |
|---|---|---|---|---|---|---|---|---|---|
| `gpt-6-luna` | 400 | 341 (+9 no evidence) | 50 | 785 | 678 (86%) | 101 | 6 | 43 | 134 |
| `claude-haiku-5-5` | 400 | 395 (+1 no evidence) | 4 | 1,152 | 1,118 (97%) | 29 | 5 | 223 | 240 |

Two limits show here. The number check drops claims that state a derived figure ("three weeks" from two dates),
which is why the luna builder falls back to the full text on 50 briefs; and the negation check withholds about one
Haiku paraphrase in five, most of them harmless rewordings, so the reader often sees only the quote. Neither stopped
the Haiku brief from matching A0 within 1 point. No claim was dropped for instruction-like context: the pilot
questions contain no injected instructions, so the injection defences are proven by fixtures only.

## The outcome instrument and its labeler (A10)

`eval/runner/outcomes/v3.ts` scores commitment, correctness, abstention, hedge and execution error as separate
axes and derives the categories from them; `scoreAnswerV2` and every earlier scorer stay unchanged, and both
committed A4 receipts rescore identically under them (a test pins their source text). Mutation tests prove that
adding a hedge cannot improve a wrong committed answer, that appending a wrong value cannot keep a pure
abstention, and that an execution error can only raise the failure rate. On the A4 receipts, outcome-v3 differs
from V2 only on 4 answers V2 could not score ("unscorable"), which v3 reads as the correct declines they are.

Commitment on free text comes from a judged label (one model call per answer). It was validated against GBRA-49's
600 hand-labeled answers (LoCoMo dev and BEAM-1M dev, kept by GBRA-49 and not published; label-set manifest sha256
in the receipts). The preregistered ladder picked `claude-sonnet-5-5` on samples 1 and 2 (hedged precision 0.927,
abstain 0.969; `gpt-6-luna` 0.862 and Haiku 0.750 on hedged missed the 0.90 bar). On sample 3, the only sample no
classifier was tuned on, it reached abstain precision 0.985 but **hedged precision 0.877, below the bar**, so the
hedge axis reports nothing: this report gives no hedged-wrong or hedge-among-correct numbers. Labels decide only
commitment (abstain against not-abstain, 0.985 precision) and FALLBACK's routing. All 12 synthetic mutation probes
passed with every candidate. Cost: $1.61.

## What to use and what to avoid

- **Use a cheap reader on whole sessions as an opt-in cost policy, labeled honestly.** DIRECT with Haiku answers 89
  where Sonnet 5.5 answers 93, at about 1/19 of the dollars and 1.6x the p95. FALLBACK with Haiku escalating to the
  frontier reader keeps 91 at 43% of A0's dollars and 2.6x A0's p95. The pilot cannot tell 89 from 93 at this size
  (p = 0.125); A6's 400-question confirm split, or the wave that adopts the policy, would.
- **Do not build the brief as a paid MCP operation now.** It is accurate, but a serial builder triples latency, and
  a cheaper design matched it. The builder code stays eval-only in gbrain, available if a later wave needs
  compact evidence (for example for a model with a small context).
- **Do not shrink delivery by truncation or small digests.** Both lose 20 to 50 points at 1,000 to 2,000 tokens.
- **Use CACHE only where the same evidence is read again in a session.** It saves money from the second read on and
  saves no latency here.
- **Do not expect representation to cut confident wrong answers.** No arm moved committed-wrong; that lever is the
  answerability threshold and read policy of bet (a).
- **Limits.** One development split of 100 questions; one judge; the cohort
  timed only the 2,000-token cells; DIRECT and FALLBACK were measured on LongMemEval's five-session hand-off, not on
  the program primary's agent tasks; committed-wrong uses a labeler that passed the abstain bar but not the hedged
  bar.

## Recommended order of waves 2 to 6

The pilot says the reading step is not where gbrain's remaining failures are: frontier readers on whole sessions
already answer 92 to 94 of 100, cheap readers 84 to 89, and no representation reduced committed-wrong answers. The
measured gaps are in retrieval at scale (plain files lead by 11 to 16 points past 50,000 documents) and in the
end-to-end task failures the program primary counts. T0's baseline on the frozen release puts that workload at its
ceiling for Sonnet 5.5 and gpt-6.1-sol (0 of 64 failures each), so it cannot yet show a factor either. So, in order:

1. **Wave 3, scale**, first: its retrieval fixes and the bet (a) answerability lever target the largest measured
   deficits, and the cheap-reader policies cut the reader cost of its runs by about 2x (FALLBACK) to 19x (DIRECT).
2. **Wave 5, the proactive brief**, second: its family-P tasks carry the program primary (missed commitments after a
   correction), the failure type this pilot cannot see; it needs a harder task set than T0's ceilinged baseline.
3. **Wave 2's paid findability run**, third (its $0 DX items already have a fixed slot).
4. **Wave 4, time travel**, fourth: it is parity with an existing kind of system, not a gap.
5. **Wave 6, the extended benchmark**, last, so it measures the waves above.

Budget: wave 1 spent $60.48 of its pilot cap; the $120 for A6 and the A8, A9 and A11 work are released to the wave
ranked first.

## Reproduce and inspect

```bash
bun eval/runner/pilot/run.ts split                      # the pilot/confirm split ($0)
bun eval/runner/pilot/run.ts smoke                      # keyless 2-question smoke of all 50 cells ($0)
bun test test/eval/pilot-arms.test.ts test/eval/outcomes-v3.test.ts
# paid stages (each needs --paid --budget-run-id <id> --budget-ledger <path>):
bun eval/runner/pilot/run.ts probe|build|read|judge|label|cohort
bun eval/runner/outcomes/validate-labeler.ts --stage select|confirm --labels-dir <custodian dir>
# rebuild the table from the committed receipts: gunzip the *.ndjson.gz below into a directory, then
PILOT_STATE_DIR=<dir> bun eval/runner/pilot/run.ts report
```

- **Code.** gbrain-evals `eval/runner/pilot/` and `eval/runner/outcomes/`; the brief builder is gbrain
  `src/eval/longmemeval/evidence-brief.ts`, shipped in gbrain v0.60.122.0 (`fc548317f`, the pin) with the same
  sha256 `a8da5b9b...` the preregistration froze and the pilot ran (the run loaded it from a checkout of that
  code before the release existed); the driver loads the pinned copy, or `PILOT_GBRAIN_ROOT` for a candidate.
  Tested by gbrain `test/evidence-brief.test.ts`. Bun 1.4.2.
- **Receipts** in [`2026-10-08-evidence-architecture-pilot/`](2026-10-08-evidence-architecture-pilot/):
  `pilot-report.json` (every row), `decision.json` (the rule's evaluation and CACHE dollars), `reads`, `builds`,
  `judges`, `labels` and `cohort` (`.ndjson.gz`, every call with its usage-receipt/v1 records),
  `labeler-validation-select.json` and `-confirm.json` (aggregates and label-file hashes only), `a4-live-probe.json`,
  `ledger-status.json`.
- **Cost and time.** $60.48 at list price: A4 probe $0.11, A10 labeler $1.61, A5 quality cells $51.89 (builders
  $5.80, readers $40.40, judge $2.85, labels $2.84), timing cohort $6.87. About 2.5 hours of wall time. Keys:
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`.
