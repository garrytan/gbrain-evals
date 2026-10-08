# A cheaper model for gbrain's background fact extraction: Claude Haiku 5.5 passes the gate, with a small loss on natural transcripts

**Finding.** gbrain saves facts from every page an agent writes, in a background job that calls a chat model. On October 8, 2026, at gbrain master `1935c74a` (v0.60.110.0), we ran that job, unchanged, with three models on the same pages and scored what it stored. Under the preregistered rule, **Claude Haiku 5.5 passes** and **GPT-6 Luna does not** (it failed the attribution check by 6.6 points). Both checks that must fail did fail: an extractor switched off, and an extractor whose output is thrown away. Haiku 5.5 costs **$1.38 per 1,000 pages** against **$15.94 for today's default, Claude Sonnet 4.6**, on P8's 1,000 LongMemEval-S sessions. The default now costs more than P8 measured ($9.94 at v0.60.48), because today's extraction prompt asks for more fields per fact.

The gate has two caveats. First, our templated chat world turned out too easy: once three scorer defects found after the run are fixed, all three models score between 97.9% and 100% on recall, precision, attribution and correction handling, so that part of the gate cannot tell them apart. Second, on 20 natural transcripts written by Claude Opus 4.5, where the gate can tell them apart, Haiku 5.5's stored facts cover **4.6 points fewer** of the planted items than Sonnet 4.6's (95% interval −9.0 to −0.6), inside the preregistered 10-point harm margin. So Haiku 5.5 saves about nine tenths of the extraction bill and loses a small, measurable share of salient facts on long natural conversations.

Status: **Complete** (5 of 5 gate arms, 4 write-cost arms). Evidence class: **development evidence** (synthetic and public development data; nothing sealed was opened). Preregistration: [2026-10-08-facts-extraction-model/PREREGISTRATION.md](2026-10-08-facts-extraction-model/PREREGISTRATION.md), SHA-256 `8f9be0d9…` recorded in the gate receipt before any counted cell ran; its "Amendments" section records the post-run scorer fixes. This is item R2 of the 10x plan (maintainer decision 2, 2026-10-08): switch the default if this gate passes before the Q1 scoreboard freezes `gbrain-defaults` (Oct 13 to 15).

## What the background job does

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents. When an agent writes a page with `put_page`, gbrain queues a `facts-absorb` job. A worker sends the page to a chat model with an extraction prompt and stores what comes back as fact rows: the claim, its kind, the entity it is about, who asserted it (`attributed_to`: user, assistant or a named third party) and, for amounts, typed metric fields. An agent later reads these facts with `recall`, `context_pack` and `think`.

Which model does that work: unless the user sets `facts.extraction_model`, gbrain asks for its `reasoning` tier, which resolves to `anthropic:claude-sonnet-4-6` when an Anthropic key is present (gbrain `src/core/facts/extract.ts:60-72`, `src/core/model-config.ts:91-95`). That model is an older generation, and it is most of the cost of a gbrain write.

A typical page in this test (invented, from the facts-absorb world):

> **user:** Alder lives in Evora... actually scratch that, wrong person. Alder lives in Leiria.
> **assistant:** Got it, noted.
> **assistant:** Have you thought about introducing Perrin to Quarry Systems? They are hiring.
> **user:** No. Perrin turned that down flat.
> **user:** Rowan told me Gammaline's March MRR came in at $61,000.

A good extractor stores that Alder lives in Leiria (not Evora), does not store that Perrin works at Quarry Systems, and keeps "Rowan" in the MRR fact so a reader knows it is hearsay.

## The experiment

**Path.** Each arm is a fresh PGLite brain behind `gbrain serve` (stdio MCP), the path an agent uses. The agent writes every page with `put_page`; the write queues the real `facts-absorb` job, which `gbrain jobs work --concurrency 4` drains after the session closes. Then every gbrain process exits and a fresh process reads every stored fact, job row and failure log row. A seeded sample of recalled claims is also read back through `gbrain call recall {grep}` in a new process. gbrain's own call ledger (`GBRAIN_AI_CALL_LOG`) records the model at each extraction call. Runner: [`eval/runner/facts-absorb-gate.ts`](../../eval/runner/facts-absorb-gate.ts); scorer: [`eval/runner/facts-absorb/score.ts`](../../eval/runner/facts-absorb/score.ts).

**Arms.**

| Arm | Setting | Role |
|---|---|---|
| Sonnet 4.6 | `facts.extraction_model` unset (the shipped default) | baseline |
| GPT-6 Luna | `openai:gpt-6-luna` | candidate |
| Haiku 5.5 | `anthropic:claude-haiku-5-5` | candidate |
| disabled | `facts.extraction_enabled false` | must fail |
| drop | GPT-6 Luna, with every model response replaced by `{"facts":[]}` in the metering proxy after it is billed | must fail |

The candidates are the newest cheap model of each provider on October 8 (both $0.10 in and $0.50 out per million tokens). Every model ran with gbrain's own request settings.

**Corpus.** Two parts, both development data:

1. The **facts-absorb world** ([`eval/generators/facts-absorb-gen.ts`](../../eval/generators/facts-absorb-gen.ts), seeds 60 and 61). It follows the N1 knowledge-update world: fictional people and companies whose city, employer and metrics change over time, here written as dated chat sessions instead of fact tables. 170 pages hold 529 planted claims: 328 user statements, 64 assistant recommendations, 41 relayed third-party claims, 64 self-corrections within a turn and 32 corrections of an amount from an earlier session. Around them sit 64 rejected assistant suggestions, 86 low-notability asides and long assistant replies. No model wrote it, and every claim carries a unique value token, so the scorer needs no model.
2. A **natural-prose stratum**: the 20 Cat 35 transcripts (`eval/data/transcript-distill-v1`, written by Claude Opus 4.5) that carry planted items, 173 items in all, each transcript written as one page. Cat 35's coverage judge labels each item FULL, PARTIAL or ABSENT against the stored facts; the judge was `openai:gpt-6.1-sol`, because current Claude Sonnet and Opus reject the forced tool call the judge uses.

**Metrics** (full definitions in the preregistration): recall of planted claims; precision of stored facts (a fact is wrong when it restates a retracted value, states a rejected suggestion as fact, gives the assistant's advice as the user's, or pairs a person with a value no claim on its page gives them); attribution (assistant recommendations attributed to the assistant, third-party claims keeping the source's name, rejected suggestions not stored as fact); correction handling (corrected value stored, retracted value not restated); parse failures; and facts readable after the restart.

**Decision rule.** Paired 95% bootstrap intervals over pages, candidate minus baseline. A candidate passes when recall and precision are non-inferior within 5 points (lower bound above −5), attribution and correction handling are no worse (point difference at least −2 points and the interval not wholly below zero), there are zero unhandled parse failures, every extraction call resolved to the requested model, every inserted fact reads back after the restart, every job completed, and natural-prose coverage is within 10 points of the baseline.

## Results

### The preregistered verdict

| Check | GPT-6 Luna vs Sonnet 4.6 | Haiku 5.5 vs Sonnet 4.6 | disabled | drop |
|---|---|---|---|---|
| Recall, non-inferior at −5 | +0.6 [−1.3, +2.8] pass | −0.2 [−2.1, +1.9] pass | −97.5 fail | −97.5 fail |
| Precision, non-inferior at −5 | 0.0 [0.0, 0.0] pass | 0.0 [0.0, 0.0] pass | −100 fail | −100 fail |
| Attribution, no worse (−2) | **−6.6 [−13.9, +0.1] fail** | −1.9 [−6.9, +3.4] pass | +8.4 pass | +8.4 pass |
| Correction handling, no worse (−2) | +2.1 [0.0, +7.0] pass | +2.1 [0.0, +7.0] pass | −97.9 fail | −97.9 fail |
| Natural-prose coverage, harm margin −10 | −6.4 [−11.6, −1.7] pass | −4.6 [−9.0, −0.6] pass | −75.7 fail | −75.7 fail |
| Unhandled parse failures | 0 | 0 | 0 | 0 |
| Resolved model at the facts call | `openai:gpt-6-luna` | `anthropic:claude-haiku-5-5` | none called | `openai:gpt-6-luna` |
| Inserted facts unreadable after restart | 0 | 0 | 0 | 0 |
| **Verdict** | **fail** | **pass** | fail (must) | fail (must) |

Points, with 95% intervals. The baseline resolved to `anthropic:claude-sonnet-4-6` on all 191 extraction calls. The mutants score "better" on attribution only because a rejected suggestion that is never stored counts as handled; they fail on everything else. The drop mutant's proxy emptied all 190 extraction responses.

Per arm, on the facts-absorb world (preregistered scorer):

| Arm | Recall | Precision | Attribution | Corrections | Facts stored | Parse failures | $ for 190 pages |
|---|---:|---:|---:|---:|---:|---:|---:|
| Sonnet 4.6 | 97.5% (516/529) | 100% (841/841) | 91.6% (152/166) | 97.9% (94/96) | 868 | 1, logged | $2.43 |
| GPT-6 Luna | 98.1% (519/529) | 100% (983/983) | 84.9% (141/166) | 100% (96/96) | 1,043 | 0 | $0.16 |
| Haiku 5.5 | 97.4% (515/529) | 100% (816/816) | 89.7% (148/165) | 100% (96/96) | 843 | 0 | $0.18 |

Sonnet 4.6's one parse failure (`malformed_output` on one page) was logged and visible; that page's three claims count as misses. Precision is 100% for every arm: no arm restated a retracted value, stored a rejected suggestion as fact, or credited the assistant's advice to the user. Facts that name no world value (`unmatched`: 3.1%, 5.8% and 3.2% of stored facts) are outside precision; the ones we read were true chatter, such as "User is evaluating a new provider for payroll".

### After the scorer fixes: a ceiling

Reading the stored facts after the run turned up three scorer defects and one harness defect, listed with their effect in the preregistration's [Amendments](2026-10-08-facts-extraction-model/PREREGISTRATION.md#amendments). The largest: after the assistant recommends a venue, the user says "Okay, I will look into it", and every model correctly saves "User will look into Villa Serra". The preregistered scorer counted that true user fact as a misattribution of the assistant's recommendation. It accounts for all 25 of GPT-6 Luna's attribution failures, all 17 of Haiku 5.5's and 12 of Sonnet 4.6's 14. The other fixes: accented city names ("Setúbal") and singular allergies ("a peanut allergy") now match, and a claim that both seeds share counts as recalled through the one copy gbrain's deduplication keeps.

| Arm (amended scorer) | Recall | Precision | Attribution | Corrections |
|---|---:|---:|---:|---:|
| Sonnet 4.6 | 99.6% (527/529) | 100% | 98.2% (166/169) | 97.9% (94/96) |
| GPT-6 Luna | 100% (529/529) | 100% | 100% (169/169) | 100% (96/96) |
| Haiku 5.5 | 100% (529/529) | 100% | 98.8% (167/169) | 100% (96/96) |

Under the amended scorer both candidates pass every check ([rescore](2026-10-08-facts-extraction-model/gate/rescore.json)). The verdict of record stays the preregistered one, because the scorer changed after we saw the data. The amended table also shows the templated world is at a ceiling: a model at 100% cannot show a difference, so this part of the gate only shows that no model makes these errors here. It does not rank them.

### Natural transcripts: where the models differ

| Arm | Items covered (FULL + PARTIAL of 173) | FULL only | Facts stored on 20 pages | Pages at the 10-fact cap |
|---|---:|---:|---:|---:|
| Sonnet 4.6 | 131 (75.7%) | 103 | 195 | 16 |
| GPT-6 Luna | 120 (69.4%) | 94 | 189 | 12 |
| Haiku 5.5 | 123 (71.1%) | 98 | 175 | 8 |

gbrain keeps at most 10 facts per extraction call. On these long transcripts Sonnet 4.6 fills that cap on 16 of 20 pages; Haiku 5.5 stops earlier and stores fewer facts, and the items it misses are the ones it never wrote down. The interval for Haiku 5.5's difference (−9.0 to −0.6 points) excludes zero, so the loss is real on this corpus, and it stays inside the 10-point harm margin set before the run. This stratum has 173 items in 20 transcripts and one judge; it cannot resolve a 5-point margin.

### Write cost on P8's sessions

P8's protocol, unchanged: the first 1,000 distinct LongMemEval-S sessions (10,313 messages) written as `note` pages through `gbrain serve`, one `remember` per page, then the background queue drained. Same build as the gate. Dollars come from the metering proxy at list prices and are recorded in the budget ledger ([receipts](2026-10-08-facts-extraction-model/write-cost/)).

| gbrain arm (per 1,000 pages) | Extraction model at the call | Extraction calls | $ per 1,000 pages | Of which embeddings |
|---|---|---:|---:|---:|
| Extraction off | none | 0 | $0.32 | $0.32 |
| Default today | `anthropic:claude-sonnet-4-6` | 999 | $15.94 | $0.33 |
| Haiku 5.5 | `anthropic:claude-haiku-5-5` | 996 | $1.38 | $0.33 |
| GPT-6 Luna (failed the gate; incomplete, see below) | `openai:gpt-6-luna` | 623 of 996 jobs | $0.89 measured for 624 jobs; about $1.23 if all 996 ran | $0.33 |
| *P8 sealed, v0.60.48 (Oct 5)* | *Sonnet 4.6* | *1,021* | *$9.94 on / $0.32 off* | |

Today's Sonnet 4.6 run used 2.75M input and 0.49M output tokens for 996 jobs (P8: 2.17M and 0.21M); Haiku 5.5 used 4.35M input and 1.23M output tokens (its output includes its reasoning) and still cost $1.05 for extraction. GPT-6 Luna's drain hit the runner's 3-hour `gbrain jobs work` limit at about 17 seconds per job, with 372 of 996 jobs still queued; its row reports the 624 metered requests ($0.57 of extraction) and a per-job extrapolation, which is an estimate, not a measurement. Every arm also had the same two `put_page` conflicts (two LongMemEval-S sessions share a slug), and the Haiku 5.5 arm had two `remember` calls that returned before their writes committed. The extraction prompt has gained speaker attribution and dates since v0.60.48, so each fact carries more output.

For comparison, the open-source shootout's ingest cost on 100 LongMemEval-S histories (about 4,800 sessions), recounted per 1,000 sessions from audit B of the 10x plan (not re-measured here): Hindsight (`ext-memory-bank`) about $6.7, Mem0 (`ext-extract-first`) about $8.8, Cognee (`ext-graph-pipeline`) about $12.7, Graphiti (`ext-temporal-graph`) about $22.6, Basic Memory about $0.30, the plain hybrid control about $0.27 and gbrain with extraction off about $0.32. A P8 page is one LongMemEval-S session, so both units count sessions, but the session sets differ (P8's first 1,000 distinct sessions against the shootout's 100 haystacks), so these are context, not a matched comparison.

## What to use and what to avoid

- **Under the preregistered rule, make Claude Haiku 5.5 the default for installs that resolve through Anthropic.** It cuts the write bill from $15.94 to $1.38 per 1,000 pages (extraction alone from $15.60 to $1.05), and it made none of the errors this world plants: no retracted value restated, no rejected suggestion stored, no hearsay stripped of its source, no parse failure.
- **Expect slightly fewer facts from long, natural conversations.** On the Cat 35 transcripts Haiku 5.5 covered 4.6 points fewer planted items. A user who wants maximum recall from long transcripts can keep Sonnet 4.6 with `gbrain config set facts.extraction_model anthropic:claude-sonnet-4-6`.
- **Keep OpenAI-only installs on their current default for now.** GPT-6 Luna failed the preregistered attribution check, although that failure was a scorer defect, and it lost 6.4 points on natural transcripts. Making it a default would need a fresh preregistered run with the amended scorer frozen.
- **Do not read the templated results as a ranking.** After the fixes every model sits between 97.9% and 100% there. A harder or more natural corpus with an independent judge is what would separate them.

Regression checks on the prepared gbrain change (master `1935c74a` plus the change, built from a scratch commit): N1 knowledge update **388/388** current-value probes, 0 stale, 385/385 history, the same as master ([summary](2026-10-08-facts-extraction-model/regression/n1-knowledge-update.json)); takes-bootstrap per-kind precision unchanged, because the takes extractor uses the gateway's chat model, not `facts.extraction_model` (gbrain `src/core/extract-takes-from-pages.ts:245`; the comment at line 80 says otherwise), confirmed by a keyless rescore of the committed predictions ([rescore](2026-10-08-facts-extraction-model/regression/takes-bootstrap-rescore.json)). A 10-page smoke through the real job on the changed build resolved to `anthropic:claude-haiku-5-5` with `facts.extraction_model` unset ([receipt](2026-10-08-facts-extraction-model/regression/candidate-default-smoke-receipt.json)).

Limits: one corpus run per arm (no repeated runs, so sampling variation in the models' own output is inside the intervals only through page resampling); one judge on the natural stratum; the templated world is easier than real chat; Haiku 5.5 bills five times its base rate for prompts above 100,000 tokens, which no extraction call here approached.

## Reproduce and inspect

From the repository root, with `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, a gbrain checkout at `1935c74a`, and a budget ledger:

```bash
bun eval/runner/facts-absorb-gate.ts --gbrain <gbrain-checkout>@1935c74a9e217b276c7bbf3075ddd3c220e96a09 \
  --prereg docs/benchmarks/2026-10-08-facts-extraction-model/PREREGISTRATION.md --seeds 60,61 \
  --arm-allowance-usd 5 --budget-usd 10 --out eval/reports/facts-absorb-gate/<name>
bun eval/runner/facts-absorb-gate.ts --rescore --out <copy of docs/benchmarks/2026-10-08-facts-extraction-model/gate>   # $0, no model calls
bun run eval:decide fetch --benchmark lme-s
bun eval/runner/p8-write-cost.ts --gbrain <gbrain-checkout>@1935c74a9e217b276c7bbf3075ddd3c220e96a09 --sessions 1000 \
  --arms off,on,on:anthropic:claude-haiku-5-5,on:openai:gpt-6-luna --budget-usd 25 --out eval/reports/p8-write-cost/<name>
```

Observed: the gate took 2 h 38 min and $3.27 (Sonnet 4.6 $2.43, the judge about $0.34, the rest under $0.50); the Sonnet 4.6 write-cost arm took 2 h 53 min and $15.94; the off, GPT-6 Luna and Haiku 5.5 arms took 5 h 32 min together and $2.59 (Haiku 5.5's drain 2 h 2 min). Total R2 spend including setup checks: $23.30 of the $40 cap, all recorded in one budget ledger.

Files: [gate receipt](2026-10-08-facts-extraction-model/gate/receipt.json) (build identity, preregistration hash, per-arm totals, validity, resolved models, verdicts), per-arm stored facts and per-claim scores (`gate/arm-*.json`), the [amended rescore](2026-10-08-facts-extraction-model/gate/rescore.json) and the [first-fix-only rescore](2026-10-08-facts-extraction-model/gate/rescore-amendment1-only.json), the [sample read-back](2026-10-08-facts-extraction-model/gate/sample-reads-reread.json), and the [write-cost receipts](2026-10-08-facts-extraction-model/write-cost/). Code identity: gbrain-evals branch for R2 (this report's commit), gbrain `1935c74a9e217b276c7bbf3075ddd3c220e96a09`.
