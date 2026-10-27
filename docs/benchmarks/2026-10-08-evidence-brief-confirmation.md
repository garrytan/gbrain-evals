# Evidence brief confirmation (A6): on 400 fresh questions the brief costs Sonnet 5.5 three points, so it is not shown to match whole sessions and does not go to the sealed set

Date: 2026-10-08 (Pacific). Wave 1 item A6 of the approved "Build the 10x memory advantage" plan (thread GBRA-60),
run on the maintainer's decision of 2026-10-08 to "continue and confirm" after the
[evidence architecture pilot](2026-10-08-evidence-architecture-pilot.md). Evidence class: **development** (the
LongMemEval-S confirm split, 400 questions the pilot never read; no sealed set opened). Preregistration:
[2026-10-08-evidence-brief-confirmation-preregistration.md](2026-10-08-evidence-brief-confirmation-preregistration.md),
committed and pushed before any cell (`943385f7`), with no amendments. Spend: $94.91 of a $150 ledger cap. Status:
every preregistered cell **complete**; no cell was dropped.

[gbrain](https://github.com/garrytan/gbrain) is a Markdown-first memory system for agents. On
[LongMemEval](https://arxiv.org/abs/2410.10813), a benchmark of questions about long chat histories, gbrain retrieves
the five best-matching conversations and hands a reader model their full text, about 14,000 tokens a question. The
pilot found that a short evidence brief written by a cheap model (`claude-haiku-5-5`) kept Sonnet 5.5 within one
question of the whole text on 100 questions, at a sixth of the cost. This run asks whether that holds on 400 new
questions under a preregistered non-inferiority test.

## The finding

**It does not hold.** Sonnet 5.5 answers 375 of 400 with the whole sessions (A0) and 363 with the 2,000-token
Haiku brief: a loss of 3.0 points, 95% interval −5.25 to −0.75. The test needed the interval's lower end above −3.0
points (T0's frozen tolerance), so the primary is **inconclusive**, not a pass. The interval lies entirely below
zero, so the brief is measurably worse than whole sessions; whether the loss is within 3 points cannot be said. The
brief also commits to more wrong answers (27 against 20). Per the preregistration, **the brief is not a candidate
for the joint sealed v2 opening**, and A8 and A9 stay unstarted.

**The pilot's one-point gap was optimistic.** On the pilot's 100 questions the same brief lost 1 point (92 against
93); here it loses 3.0. Every brief cell lands in the same place: Opus 5.5 −1.75 (interval −4.00 to +0.50),
`gpt-6.1-sol` −3.25, and Sonnet 5.5 at 1,000, 4,000 and 7,000 tokens −3.25, −2.25 and −2.25. A bigger budget does
not recover the loss, because the Haiku builder writes about the same 700 to 1,100 tokens whatever the budget.

**The cheap-reader options get a verdict too.** Haiku 5.5 reading the whole sessions (DIRECT) loses 3.0 points
(363), inconclusive. FALLBACK (Haiku, escalating to Sonnet 5.5's answer on hedged or declined answers, 31.5% of
questions) loses 1.25 points (370 against 375, interval −2.50 to 0.00): its unadjusted one-sided p is 0.011, and
after Holm across the nine secondaries 0.10, so it is also inconclusive, but it is the only design whose interval
reaches zero. It costs $0.0201 a question against A0's $0.0461, with a p95 of 6.4 s against 3.1 s.

**The controls behave.** Truncating to whole sessions in rank order loses 43 points at 2,000 tokens and 20.5 at
7,000 (both fail), so the test detects a real loss.

## The concrete case

*From the data.* Question `59524333` asks "What time do I usually go to the gym?" (answer: 6:00 pm). The user
said 7:00 pm in a February session and 6:00 pm in a May session. With the whole sessions, Sonnet 5.5 answers
6:00 pm. The Haiku builder did write the right claim, "The user usually goes to the gym at 6:00 pm, according to the
later May 30 session", with a verbatim quote, but the brief validator dropped it: its number check looks for "May
30" in the session's text, and the session's date lives in the `<chat_session>` header, not the text. The reader
saw only the February 7:00 pm claim and answered "about 7:00 pm ... it may have changed", a committed wrong answer.

The number check dropped at least one claim in 20 of the 400 briefs (this session-date case among them), and in 3
of the 16 questions A0 answered and the brief missed. The other 13 losses are what the builder left out or weighed
wrongly: 7 of the 16 are multi-session (mostly counting,
for example 3 of 4 art events), 4 temporal, 3 knowledge updates and 2 preferences. All 16 were delivered as briefs,
not the full-text fallback. Fixing the date check (pass each session's own date as an exempt numeric key to
`unsupportedNumericClaims`) would recover at most those 3 questions, and only where the dropped claim cited a session date, leaving the brief about 2.25 points behind,
still not shown within the tolerance; the run is reported as preregistered, with the defect unfixed.

## The experiment

- **Evidence.** The same frozen reader requests as the pilot: the W10a captures of gbrain `c5fb0201`'s own
  LongMemEval-S requests (release retrieval: balanced mode, reranker on, top 5 whole sessions). An arm changes only
  the evidence section of the request.
- **Questions.** The 400-question confirm split (temporal reasoning 102, multi-session 97, knowledge update 57,
  single-session user 51, single-session assistant 45, preference 24, unanswerable 24).
- **Brief builder.** gbrain `src/eval/longmemeval/evidence-brief.ts` from the pinned gbrain `fc548317f`
  (v0.60.122.0), the file the pilot ran (sha256 `a8da5b9b...`).
- **Cells.** A0 for Sonnet 5.5, Opus 5.5 and `gpt-6.1-sol`; BRIEF@2000 (Haiku 5.5 builder) for the same three;
  BRIEF@1000, @4000 and @7000 for Sonnet 5.5; TRUNC@2000 and TRUNC@7000 for Sonnet 5.5; DIRECT; FALLBACK. Sonnet
  5.5's A0 rows and 50 of `gpt-6.1-sol`'s are the committed W10 answers to byte-identical requests; the other A0 rows
  are new.
- **Test.** Non-inferiority at 3.0 points of supported task success, paired by question, cluster bootstrap (10,000
  draws), one-sided alpha 0.025 (the lower end of a 95% interval). The primary is its own family; the nine
  secondaries are Holm-adjusted together.
- **Metrics.** Supported task success under the official LongMemEval judge (`gpt-4o-2024-08-06`), every execution
  error a failure (there were none); committed-wrong under outcome-v3 with the Sonnet 5.5 commitment labeler, the
  bound in parentheses counting every wrong answer as committed; list dollars of every call in the design
  (usage-receipt/v1); p50 and p95 from a timing cohort of 24 questions over **all thirteen cells** (312 synchronous
  units, seeded random order, no answer cache).

## Results

### Every cell (n = 400; latency n = 24 per cell)

| Cell | Success /400 | Committed-wrong (bound) | Abstained | $ / question | of which builder | Reader in / out tokens | Delivered cl100k | Builder in / out tokens | p50 / p95 ms (cohort, n = 24) | Comparator right, cell wrong / reverse |
|---|---|---|---|---|---|---|---|---|---|---|
| `a0:Sonnet 5.5` | 375 | 20 (25) | 5 | 0.0461 | 0.0000 | 22,048 / 204 | 13,666 |  | 2,020 / 3,116 |  |
| `a0:Opus 5.5` | 375 | 17 (25) | 8 | 0.0943 | 0.0000 | 22,048 / 305 | 13,666 |  | 4,657 / 7,970 |  |
| `a0:gpt-6.1-sol` | 370 | 20 (30) | 10 | 0.0352 | 0.0000 | 13,676 / 111 | 13,666 |  | 3,264 / 5,019 |  |
| `brief@2000:Haiku 5.5:Sonnet 5.5` (4 full-text fallbacks) | 363 | 27 (37) | 10 | 0.0078 | 0.0028 | 1,357 / 229 | 738 | 22,550 / 1,183 | 7,076 / 9,918 | 16 / 4 |
| `brief@2000:Haiku 5.5:Opus 5.5` (4 full-text fallbacks) | 368 | 25 (32) | 7 | 0.0156 | 0.0028 | 1,357 / 364 | 738 | 22,550 / 1,183 | 9,609 / 13,275 | 15 / 8 |
| `brief@2000:Haiku 5.5:gpt-6.1-sol` (4 full-text fallbacks) | 357 | 21 (43) | 22 | 0.0058 | 0.0028 | 930 / 129 | 738 | 22,550 / 1,183 | 8,698 / 12,955 | 20 / 7 |
| `brief@1000:Haiku 5.5:Sonnet 5.5` (8 full-text fallbacks) | 362 | 29 (38) | 9 | 0.0081 | 0.0028 | 1,518 / 226 | 836 | 22,550 / 1,122 | 6,837 / 9,684 | 17 / 4 |
| `brief@4000:Haiku 5.5:Sonnet 5.5` (14 full-text fallbacks) | 366 | 28 (34) | 6 | 0.0090 | 0.0029 | 1,920 / 231 | 1,093 | 22,550 / 1,197 | 6,974 / 10,254 | 12 / 3 |
| `brief@7000:Haiku 5.5:Sonnet 5.5` (6 full-text fallbacks) | 366 | 25 (34) | 9 | 0.0081 | 0.0029 | 1,475 / 229 | 816 | 22,550 / 1,212 | 7,222 / 12,274 | 13 / 4 |
| `trunc@2000:Sonnet 5.5` | 203 | 77 (197) | 120 | 0.0082 | 0.0000 | 3,284 / 159 | 1,880 |  | 1,879 / 2,876 | 177 / 5 |
| `trunc@7000:Sonnet 5.5` | 293 | 62 (107) | 45 | 0.0202 | 0.0000 | 9,128 / 191 | 5,544 |  | 1,860 / 2,884 | 85 / 3 |
| `direct:Haiku 5.5` | 363 | 28 (37) | 9 | 0.0024 | 0.0000 | 22,048 / 463 | 13,666 |  | 1,997 / 4,296 | 18 / 6 |
| `fallback:Haiku 5.5>Sonnet 5.5` (escalated 32%) | 370 | 25 (30) | 5 | 0.0201 | 0.0000 | 29,218 / 542 | 13,666 |  | 3,903 / 6,436 | 6 / 1 |

| Comparison | Family | Arm minus comparator | 95% interval | One-sided p (tolerance 3.0) | Holm p | Verdict |
|---|---|---|---|---|---|---|
| `brief2000-sonnet` | primary | -3.00 | -5.25 to -0.75 | 0.5424 | 0.5424 | inconclusive |
| `brief2000-opus` | secondary | -1.75 | -4.00 to +0.50 | 0.1740 | 1.0000 | inconclusive |
| `brief2000-sol` | secondary | -3.25 | -5.75 to -0.75 | 0.6146 | 1.0000 | inconclusive |
| `brief1000-sonnet` | secondary | -3.25 | -5.50 to -1.00 | 0.6287 | 1.0000 | inconclusive |
| `brief4000-sonnet` | secondary | -2.25 | -4.25 to -0.50 | 0.2553 | 1.0000 | inconclusive |
| `brief7000-sonnet` | secondary | -2.25 | -4.25 to -0.25 | 0.2653 | 1.0000 | inconclusive |
| `trunc2000-sonnet` | secondary | -43.00 | -48.00 to -38.00 | 1.0000 | 1.0000 | fail |
| `trunc7000-sonnet` | secondary | -20.50 | -24.75 to -16.50 | 1.0000 | 1.0000 | fail |
| `direct-haiku` | secondary | -3.00 | -5.50 to -0.75 | 0.5252 | 1.0000 | inconclusive |
| `fallback-haiku-sonnet` | secondary | -1.25 | -2.50 to +0.00 | 0.0112 | 0.1008 | inconclusive |

No call ended in an execution error in any cell or in the cohort. Only `gpt-6.1-sol` A0 calls met a provider cache
hit in the cohort (OpenAI caches shared prefixes on its own); every other row is cold.

## What to use and what to avoid

- **Keep whole-session delivery as the default reader input.** On fresh questions every brief cell lost 1.75 to
  3.25 points and committed to more wrong answers; the pilot's near-tie did not replicate.
- **Do not send the brief to sealed v2.** The preregistered primary did not pass, so GBRA-1's budgeted-delivery
  candidate opens sealed v2 alone, as the post-gate plan already allows.
- **FALLBACK is the cheap-reader design worth a further look.** It loses 1.25 points at 44% of A0's dollars and
  2.1x its p95; on these 400 questions it is not shown non-inferior (Holm p 0.10). DIRECT loses 3.0 points and is
  not a reader policy to recommend.
- **The latency cost of a brief is the builder.** Every brief cell's p95 is 9.7 to 13.3 s against 3.1 s (Sonnet
  5.5) to 8.0 s (Opus 5.5) for A0.
- **Limits.** One development split; one judge; Sonnet 5.5's A0 answers are the committed W10a batch answers to
  identical requests rather than a same-day run; committed-wrong uses a labeler that passed the abstain-precision bar
  but not the hedged bar.

## Reproduce and inspect

```bash
bun test test/eval/pilot-arms.test.ts                     # A0 byte-identity, the A6 families, keyless smoke of all 13 cells
# paid stages (each needs --paid --budget-run-id <id> --budget-ledger <path>):
bun eval/runner/pilot/run.ts build|read|judge|label|cohort --split confirm
# rebuild the table from the committed receipts: gunzip the *.ndjson.gz below into a directory, then
PILOT_STATE_DIR=<dir> bun eval/runner/pilot/run.ts report --split confirm
```

- **Code.** gbrain-evals `eval/runner/pilot/` (`confirm.ts` holds the cells and both comparison families) and
  `eval/runner/stats/gates.ts` (`evaluateFamily`); the brief builder from the pinned gbrain. Bun 1.4.2.
- **Receipts** in [`2026-10-08-evidence-brief-confirmation/`](2026-10-08-evidence-brief-confirmation/):
  `confirmation-report.json` (every row and per-question correctness), `decision.json` (both families with
  intervals and p-values), `reads`, `builds`, `judges`, `labels` and `cohort` (`.ndjson.gz`, every call with its
  usage-receipt/v1 records), `pricing-smoke-report.json`, `ledger-status.json`.
- **Cost and time.** $94.91 at list price: pricing smoke $1.01 (5 pilot-split questions, all 13 cells), quality
  cells $87.59 (builders $4.55, readers $77.32, judge $3.13, labels $2.58), timing cohort $6.31. About 1.5 hours of
  wall time. Keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`.
