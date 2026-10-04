# LongMemEval with opaque session ids: retrieval holds, the notes gain holds, and a frontier reader reaches 447/500

Published 2026-10-04. Measured 2026-10-04 at gbrain `109b992172e1f49107f9de9841758c1d043a2668` (v0.60.37.0, this repository's `package.json` pin), Bun 1.4.2, following a [preregistration](2026-10-04-longmemeval-opaque-followups-preregistration.md) committed before any measured run.

[gbrain](https://github.com/garrytan/gbrain) is a Markdown-first memory system for agents. [LongMemEval](https://arxiv.org/abs/2410.10813) asks questions about long histories of old conversations ("sessions"). A memory system first has to find the right sessions; then a language model (the "reader") answers from what was found, and a second model (the "judge") grades the answer against the dataset's reference.

On September 28 we found that every labeled evidence session in LongMemEval has an id starting with `answer_`, and no other session does. Until gbrain `b80cad6` and gbrain-evals v0.10.1, that raw id reached gbrain as part of the page title and reached the reader as `<chat_session id="answer_…">`. The judged answers were re-run without the leak on September 29 and 30 ([report](2026-09-29-longmemeval-opaque-qa.md)). This report closes the three follow-ups that remained.

## The findings

**1a. The published retrieval numbers hold with opaque ids, except the query-expansion arms, which got much better.** We re-ran all thirteen published retrieval arms with opaque ids at the current pin and paired each one question by question with its published receipt. The denominator is the 470 answerable questions of the cleaned `_s` split. Strict `recall_all@5` counts a question only when every labeled evidence session is among the first five returned chunks.

- The release configuration (`balanced`, Voyage reranker on, autocut off) found every labeled session for **451/470 (95.96%)**, against 449/470 published (+2/−0, exact McNemar p = 0.50).
- Without the reranker, **434/470 (92.34%)** against 439/470 (+1/−6, p = 0.13).
- With autocut on, 384/470 against 379/470 (+7/−2, p = 0.18). Turning autocut off still gains 67 questions and loses none.
- Legacy query expansion moved from 255/470 to **436/470** in the harness and from 258/470 to **440/470** in this repository's runner. At the current code, expansion no longer hurts plain hybrid search (436 against 434, +6/−4, p = 0.75).

By the preregistered rule (p < 0.05 or a change of 10 or more questions), 10 of the 13 full-set arms are confirmed. The three that moved are the expansion arms without the reranker (legacy weight in each runner, and budget 0.25); two of the four 40-question development replays, also expansion, moved too. The code moved from v0.48 to v0.60 between the published runs and this recount, so a change is not automatically an effect of the ids. A [post-hoc check](#where-the-expansion-change-came-from) on the 40 development questions attributes the expansion change to the code: at the published gbrain commit, hiding the ids changed legacy expansion by +2/−1, while moving to the current code changed it by +12/−1.

**1b. Taking notes before answering still helps with opaque ids: 304/361 to 320/361.** On the September 24 reading-notes cohort, rebuilt from public receipts, the notes instruction won 25 questions and lost 9 (p = 0.009). The paired 95% bootstrap interval for the difference is +1.4 to +7.5 percentage points, and abstention stayed at 7/7 in both arms, so the preregistered gate passes. The September 24 result with raw ids was 308/361 to 324/361. The net gain is the same, +16 questions.

**2. A frontier reader, `gpt-5.4`, answered 447/500 (89.4%) on gbrain's retrieved sessions with LongMemEval's official reading prompt.** That is exactly arm b's input from September 29, where GPT-4o answered 430/500. Paired, `gpt-5.4` won 33 questions and lost 16 (p = 0.021), a demonstrated reader difference under both judges. Against gbrain's house reader on the same sessions (439/500), it won 25 and lost 17 (p = 0.28), not a demonstrated difference.

The total paid cost was **$67.83** of the $80 budget. Details are in [cost](#cost).

## 1a. Retrieval with opaque ids

### What was run

We re-ran every LongMemEval retrieval arm whose numbers are published in this repository:

- **The eight September 6 ranker-wave arms and four development-slice replays** ([report](2026-09-06-longmemeval-ranker-wave.md)). They came from gbrain's own `gbrain eval longmemeval` harness at v0.48.4.0. The same harness, from the installed dependency at `109b992`, now imports each session under an opaque per-question slug (`chat/s-<10 hex>`) and maps back to the dataset ids only for scoring. It ran unmodified through [`scripts/driver-retrieval.ts`](2026-10-04-longmemeval-opaque-followups/scripts/driver-retrieval.ts), which only logs paid calls.
- **The five September 2 arms** ([report](2026-05-07-longmemeval-s.md)). They came from this repository's runner, `eval/runner/longmemeval.ts`, which renders sessions under opaque ids since v0.10.1.

All arms used the published flags: top 5, OpenAI `text-embedding-3-large` at 1,536 dimensions, one embedding cache per runner, the cleaned `_s` file (SHA-256 `d6f21ea9…`). The expansion arms replayed the alternative phrasings recorded in the published A3 receipt, as the published A3′, A3′R, tokenmax and development-slice runs did; the published A3 had generated them live.

**Matching the published settings.** Six of the September 6 arms ran on branch code before gbrain added the relationship pin and the metadata-boost gate. We confirmed this by recomputing each arm's recorded `knobs_hash` with gbrain's own functions at each commit ([`knob-check.txt`](2026-10-04-longmemeval-opaque-followups/scripts/knob-check.txt)). Those six arms ran with `search.relational_rerank_pin=0` and `search.metadata_boost_gate=always`, which reproduce the old behavior. With those two pins, every resolved search setting at `109b992` equals the published arm's. What still differs is the code between v0.48 and v0.60, including page-grain fusion in v0.59.13.0.

### Results

Strict and any-hit counts over the 470 answerable questions; paired gains and losses on strict hits against the published receipt; two-sided exact McNemar p.

| Arm | Published strict | Opaque-id strict | Any-hit, published → opaque | Paired | p | Decision set (430), published → opaque | Verdict |
|---|---:|---:|---|---|---:|---|---|
| A1: hybrid, reranker off, autocut off | 439 | **434** | 464 → 463 | +1 / −6 | 0.13 | 403 → 398 | confirmed |
| A2: reranker on, autocut off | 449 | **451** | 469 → 470 | +2 / −0 | 0.50 | 412 → 414 | confirmed |
| A3: expansion, legacy weight, reranker off | 255 | **436** | 399 → 463 | +184 / −3 | 1e-50 | 231 → 400 | moved |
| A4: reranker on, autocut on (the old default) | 379 | **384** | 467 → 468 | +7 / −2 | 0.18 | 344 → 350 | confirmed |
| A3′: expansion at budget 0.25, reranker off | 394 | **435** | 458 → 464 | +49 / −8 | 3e-8 | 360 → 399 | moved |
| A3′R: tokenmax, budget 0.25, reranker on, autocut on | 381 | **383** | 466 → 467 | +6 / −4 | 0.75 | 347 → 350 | confirmed |
| tokenmax as released (legacy expansion, reranker on, autocut off) | 436 | **442** | 468 → 469 | +7 / −1 | 0.070 | 400 → 406 | confirmed |
| final release configuration | 449 | **451** | 469 → 470 | +2 / −0 | 0.50 | 412 → 414 | confirmed |

The development slice is 40 questions chosen with seed 42 to tune the expansion budget on September 6:

| Development replay | Published (40) | Opaque-id (40) | Paired | p | Verdict |
|---|---:|---:|---|---:|---|
| budget 2.0 | 24 | 36 | +13 / −1 | 0.002 | moved |
| budget 1.0 | 26 | 36 | +11 / −1 | 0.006 | moved |
| budget 0.5 | 30 | 36 | +7 / −1 | 0.070 | confirmed |
| budget 0.25 | 34 | 36 | +3 / −1 | 0.63 | confirmed |

This repository's runner, the September 2 arms:

| Adapter | Published strict | Opaque-id strict | Any-hit, published → opaque | Paired | p | Verdict |
|---|---:|---:|---|---|---:|---|
| `hybrid` | 438 | **436** | 464 → 463 | +2 / −4 | 0.69 | confirmed |
| `hybrid+expansion` (live Haiku variants) | 258 | **440** | 407 → 467 | +184 / −2 | 4e-52 | moved |
| `hybrid-sessdiv` | 439 | **437** | 464 → 463 | +2 / −4 | 0.69 | confirmed |
| `hybrid+rerank` | 448 | **451** | 469 → 469 | +3 / −0 | 0.25 | confirmed |
| `hybrid-sessdiv+rerank` | 449 | **452** | 469 → 469 | +3 / −0 | 0.25 | confirmed |

Every arm returned all 500 rows, with no error rows, no degraded search stage, no reranker skips and no expansion replay misses. The first harness pass embedded 58.2M tokens; every later harness arm ran with zero cache misses apart from the expansion variants.

**Context.** The September 29 and 30 opaque-id runs at gbrain `a7cb37b` scored 435/470 (reranker off) and 450/470 (reranker on). The recount agrees with them to within one question (434, +0/−1; 451, +1/−0).

**The settings comparisons still point the same way.** Within the recount, with every arm on the same code and ids:

| Comparison | Strict counts | Paired | p |
|---|---|---|---:|
| Reranker on against off (A2 against A1) | 451 against 434 | +23 / −6 | 0.002 |
| Autocut on against off, reranker on (A4 against A2) | 384 against 451 | +0 / −67 | 1e-20 |
| Legacy expansion against none, reranker off (A3 against A1) | 436 against 434 | +6 / −4 | 0.75 |
| Tokenmax as released against `balanced` (both reranked) | 442 against 451 | +3 / −12 | 0.035 |

By type, strict hits, opaque ids:

| Type | n | A1 | A2 = final | A3 | A4 | A3′ | A3′R | tokenmax |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| knowledge-update | 72 | 71 | 72 | 71 | 52 | 71 | 55 | 72 |
| multi-session | 121 | 109 | 112 | 110 | 92 | 109 | 88 | 107 |
| single-session-assistant | 56 | 56 | 56 | 56 | 56 | 56 | 56 | 56 |
| single-session-preference | 30 | 29 | 30 | 29 | 30 | 29 | 29 | 29 |
| single-session-user | 64 | 63 | 64 | 63 | 64 | 63 | 64 | 64 |
| temporal-reasoning | 127 | 106 | 117 | 107 | 90 | 107 | 91 | 114 |

### Where the expansion change came from

*Post-hoc, not preregistered.* The preregistration only planned an attribution run if a README-cited arm moved, and none did. The expansion arms moved by up to 184 questions, so we ran a cheap check ($1.20) on the 40 development questions (all answerable). We ran A1 and A3 (legacy expansion, the same replayed phrasings) with gbrain's harness at `885bb91a1`, the code that produced the published A1 and A3, twice: once on the original dataset file and once on a copy whose session ids are all replaced by opaque ids ([`scripts/opaque-dataset.py`](2026-10-04-longmemeval-opaque-followups/scripts/opaque-dataset.py), [`scripts/run-attribution.sh`](2026-10-04-longmemeval-opaque-followups/scripts/run-attribution.sh)).

| Code | Session ids | A1, strict hits of 40 | A3, strict hits of 40 |
|---|---|---:|---:|
| published receipts, `885bb91a1` (September 6) | raw | 36 | 24 |
| `885bb91a1`, re-run today | raw | 36 | 24 |
| `885bb91a1`, re-run today | opaque | 36 | 25 |
| `109b992` (this recount) | opaque | 36 | 36 |

- The old code reproduces the published numbers with raw ids (A1 and A3 each +0/−0 per question).
- At the old code, hiding the ids moves A3 by +2/−1 (p = 1.0) and A1 not at all.
- With opaque ids, moving from the old code to the current code moves A3 by +12/−1 (p = 0.003) and A1 not at all.

So the expansion change comes from gbrain's code between v0.48 and v0.60, not from the ids. We did not bisect which release fixed it; gbrain's changelog for v0.59.x already reports legacy-weighted expansion level with budgeted expansion on 215 LongMemEval questions.

### What this means for the published claims

- **The headline retrieval numbers stand.** 449/470 with the reranker and 439/470 without were confirmed with opaque ids; the current numbers are 451/470 and 434/470. The README now shows both. gbrain's strict recall remains higher than MemPalace's 423/470, the best other system we can score on the same metric.
- **Autocut.** "Turning autocut off raised complete retrieval from 379/470 to 449/470" is confirmed; with opaque ids at the current code it is 384/470 to 451/470 (+67/−0).
- **Query expansion.** "Extra query rewrites hurt retrieval at a five-result limit" was true of the code measured on September 2 and 6, and not because of the leak, but it is not true of the current code: legacy expansion now matches plain hybrid search (436 against 434) and, with the reranker, stays slightly below `balanced` (442 against 451, +3/−12, p = 0.035). The settings guide keeps expansion off for this workload because it has no measured benefit and costs a model call per query, not because it destroys retrieval. The expansion-budget tuning on the development slice is obsolete for the same reason.

## 1b. The reading-notes transfer with opaque ids

### The question and the inputs

On September 24, with raw ids visible to the reader, asking for brief notes before the answer raised correct answers from 308/361 to 324/361 on the same retrieved sessions ([report](2026-09-25-reading-notes.md)). The original frozen inputs are private, so we rebuilt them from public data with [`scripts/build-reading-notes-inputs.ts`](2026-10-04-longmemeval-opaque-followups/scripts/build-reading-notes-inputs.ts):

- the 361 questions and their order from the published paired-label receipt;
- the retrieved sessions, in rank order, from the September 6 D1 receipt. D1 matches the receipt's per-question "all evidence retrieved" flag on 361 of 361 questions, which identifies it as the original retrieval;
- the session text and dates from the cleaned `_s` file, rendered as gbrain's harness renders a session page, with the session's opaque id (`s-` plus 10 hex characters) in place of the dataset id.

The rebuilt file has 1,766 sessions and hashes to `747598d1…`. No prepared request contains `answer_`. It cannot be checked against the original private receipt hash.

### What was run

The repository's existing lanes did the work: `eval/runner/reading-notes-requests.ts` prepared the paired requests, and `eval/runner/reading-notes-run.ts` executed them in four parts under spend caps, through the `gbrain-reader` alias at `e78f1c3`. The reader was `claude-sonnet-4-6` at provider-default temperature with a 512-token output limit, as on September 24:

- **direct**: gbrain's earlier LongMemEval reader prompt (`gbrain-lme-reader-v3-abstention-fullsessions`, SHA-256 `7d991ff3…`, the prompt of the published D1 run);
- **notes**: the same prompt with one sentence replaced by "First extract all the relevant information, then reason over the information to get the answer. Keep the notes brief and end with a concise final answer."

All 722 calls were accepted on the first attempt. gbrain's data-boundary judge (`judgeRow`, `gpt-4o-2024-08-06`, temperature 0, 16 tokens) graded every complete response, with no judge errors.

### Results

| Metric | Direct | Notes |
|---|---:|---:|
| Correct, all questions | **304/361 (84.2%)** | **320/361 (88.6%)** |
| Answerable questions | 297/354 | 313/354 |
| Abstention questions | 7/7 | 7/7 |
| All evidence retrieved | 301/345 | 317/345 |
| Some evidence missing | 3/16 | 3/16 |
| Output-limit finishes | 0 | 11 |
| Mean output tokens | 89 | 249 |
| Reader cost | $17.23 | $18.11 |

Paired, notes won 25 and lost 9, with 295 right in both and 32 wrong in both (exact McNemar p = 0.009). The paired 95% bootstrap interval for notes minus direct is **+1.4 to +7.5 percentage points** (10,000 resamples). The interval lies above zero and abstention did not fall, so the preregistered gate passes. All 25 wins and 9 losses come from questions with complete retrieval; notes do not repair missing evidence.

| Category | Questions | Direct | Notes | Net |
|---|---:|---:|---:|---:|
| Knowledge update | 52 | 46 | 49 | +3 |
| Multi-session | 96 | 75 | 74 | −1 |
| Single-session assistant | 40 | 39 | 40 | +1 |
| Single-session preference | 20 | 14 | 17 | +3 |
| Single-session user | 49 | 49 | 48 | −1 |
| Temporal reasoning | 104 | 81 | 92 | +11 |

**Output-limit caveat.** Eleven notes responses hit the 512-token limit (five of them are among the nine that did on September 24). Under the September 25 conservative rule, every cutoff counts as wrong; then notes score 314/361 against 304/361, +24/−14, with an interval of −0.6 to +6.1 points. The gate is defined on graded labels and passes; the conservative view no longer clears zero. gbrain's current packaged notes reader uses 1,024 tokens, and on September 30 it ended naturally on all 500 questions with the reranker on.

**Against September 24.** With raw ids, the arms scored 308 and 324. With opaque ids, direct went 308 to 304 (+9/−13 per question, p = 0.52) and notes 324 to 320 (+8/−12, p = 0.50). Both arms fell by four questions. Generation is not deterministic (identical prompts went 11/12 to 10/12 on September 24), so this measures the leak and run-to-run variation together; neither change is distinguishable from zero.

**What changes in the published claim.** The September 25 report's flag is resolved: the transfer result now reads 304/361 to 320/361 with opaque ids, and 308 to 324 stays as the historical raw-id measurement.

## 2. A frontier reader on gbrain's retrieval

### Why `gpt-5.4`

Published LongMemEval answer scores use many readers. Zep's 90.2% (451/500) used `gpt-5.4` at medium reasoning effort with a `gpt-5.4` judge; Memoria's 84.97% (424/499) used `gpt-5.4` on frozen retrieval ([sources](../comparison-systems.md)). `gpt-5.4` is a frontier reader that two public baselines used. Memoria's best reader, `claude-opus-4.6`, costs about twice as much per input token and did not fit the budget; Gemini readers (Mastra, Supermemory) need a key we do not have.

### What was run

The input was the exact prompt of every arm-b row from September 29: LongMemEval's official `run_generation.py` reading prompt with JSON history, both speakers, and "Answer the question step by step: first extract all the relevant information, and then reason over the information to get the answer" (notes first). The sessions are the distinct sessions behind the top five chunks of the reranker-off run at gbrain `a7cb37b` (435/470 strict retrieval), sorted by date. The prompt carries no session ids. Only the reader changed.

Reader: `gpt-5.4` (reported snapshot `gpt-5.4-2026-03-05`), `reasoning_effort: "medium"`, `max_completion_tokens: 12000`, provider-default temperature (reasoning models do not accept temperature 0, and the official 800-token limit would be consumed by reasoning). Ten pilot questions went through Chat Completions and the other 490 through the Batch API with identical request bodies. All 500 finished naturally; the longest used 3,543 completion tokens. The judges were the two used for arms a and b: gbrain's judge (`openai:gpt-4o`, temperature 0, 16 tokens) and the verbatim official `evaluate_qa.py` judge (`gpt-4o-2024-08-06`, temperature 0, 10 tokens). They agreed on 495 of 500 answers, with no judge errors.

### Results

Denominator: all 500 questions, including the 30 whose correct response is to abstain.

| Reader (same sessions) | Prompt | Correct, gbrain judge | Correct, official judge |
|---|---|---:|---:|
| **`gpt-5.4`, medium reasoning** | official, notes first | **447/500 (89.4%)** | **448/500 (89.6%)** |
| gbrain house reader, `claude-sonnet-4-6` (arm a) | gbrain notes | 439/500 (87.8%) | 443/500 (88.6%) |
| `gpt-4o-2024-08-06` (arm b) | official, notes first | 430/500 (86.0%) | 432/500 (86.4%) |

| Paired comparison | Judge | `gpt-5.4` better | `gpt-5.4` worse | Exact McNemar p |
|---|---|---:|---:|---:|
| against GPT-4o | gbrain | 33 | 16 | 0.021 |
| against GPT-4o | official | 30 | 14 | 0.023 |
| against the house reader | gbrain | 25 | 17 | 0.28 |
| against the house reader | official | 21 | 16 | 0.51 |

When retrieval had found every labeled session (435 answerable questions), `gpt-5.4` answered 413, the house reader 403 and GPT-4o 395 (gbrain judge).

By type, gbrain judge:

| Type | n | `gpt-5.4` | house reader | GPT-4o |
|---|---:|---:|---:|---:|
| single-session-assistant | 56 | 55 | 55 | 55 |
| single-session-user | 64 | 62 | 62 | 62 |
| knowledge-update | 72 | 64 | 67 | 67 |
| temporal-reasoning | 127 | 110 | 108 | 108 |
| multi-session | 121 | 102 | 95 | 87 |
| single-session-preference | 30 | 28 | 24 | 23 |
| abstention | 30 | 26 | 28 | 28 |

The frontier reader's gain is concentrated in multi-session questions (102 against 87 for GPT-4o) and preference questions (28 against 23). It abstained less well (26/30 against 28/30) and lost three knowledge-update questions.

**What this does and does not compare.** This is the matched-reader comparison audit item B6 asked for: on identical gbrain retrieval and the official prompt, a frontier reader is demonstrably better than GPT-4o. It is not a ranking against Zep's 90.2% or any vendor result. Zep used its own retrieval and a `gpt-5.4` judge; our arms use reranker-off retrieval (435/470) and gpt-4o judges. The release configuration with the reranker found complete evidence on 450/470 on September 30 and was not paired with this reader.

## What to use and what to avoid

- **Retrieval.** For long conversation histories at a five-result budget, `balanced` with the reranker on and autocut off remains the measured choice: 451/470 with opaque ids. Autocut still discards needed evidence (67 questions lost, none gained). Query expansion is no longer harmful at the current code but adds a model call per query without a measured gain.
- **Reading.** Ask the reader to take brief notes before answering. The gain held with opaque ids (+16 net on 361). Give it room: at 512 tokens, 11 of 361 notes responses were cut off.
- **Reader choice.** A frontier reader adds answers where several sessions must be combined. If you compare gbrain's answer accuracy with a published number, match the reader, the judge and the retrieval budget before drawing a conclusion.

## Cost

Usage-priced from each run's own call log or budget ledger, at 2026-10-04 list prices. All paid calls succeeded on the first attempt except as noted.

| Item | What was paid for | Cost | Cap |
|---|---|---:|---:|
| Configuration smoke runs (before the preregistration) | embeddings and five rerank calls for 2 to 3 questions | about $0.09 | |
| 1a, harness arms | 58.2M embedding tokens ($7.57); 47.2M Voyage rerank tokens over 2,500 calls ($2.36) | $9.93 | $11 |
| 1a, runner arms | embeddings ($7.56), Haiku expansion ($0.30), Voyage rerank ($0.69) | $8.55 | $11 |
| 1b | 722 Sonnet 4.6 reader calls ($35.34); 722 judge calls ($0.68) | $36.03 | $38 |
| 2 | 500 `gpt-5.4` reader calls ($11.11: 10 standard, 490 at Batch prices); 1,000 judge calls ($0.92) | $12.03 | $20 |
| Post-hoc attribution | 9.2M embedding tokens for 40 questions, two caches | $1.20 | |
| **Total** | | **$67.83** | **$80** |

Compute: two Ubicloud `standard-16` VMs for about 1.6 hours each, destroyed after the runs; not included in the dollar total.

Incidents:

- The runner arms were restarted once to raise the worker count from 6 to 14, because the workers were waiting on the embedding API. Killing the batch wrapper closed its budget-ledger run, so the restart opened a second run with the remaining $4.67 of the $11 cap; together they spent $8.55. Eleven embedding reservations from killed workers were never settled (at most $0.004 reserved). Rows resumed from the shared file; [`1a-runner/restarts.log`](2026-10-04-longmemeval-opaque-followups/1a-runner/restarts.log) records both events.
- Each harness process recorded one watchdog line, its normal exit. No stall restart was needed.

## Reproduce and inspect

Receipts are in [`2026-10-04-longmemeval-opaque-followups/`](2026-10-04-longmemeval-opaque-followups/README.md): harness rows and paid-call logs per arm, the runner rows and budget ledger, the reading-notes journals and labels (with response text), the frontier rows with both judges, the three analysis summaries and every executed script. Machine-local paths are replaced by `.`, `~` and `<work>`.

Keyless recount from the repository root (no dataset or network needed):

```bash
python3 scripts/verify-longmemeval-opaque-followups.py
```

To re-run, with `OPENAI_API_KEY`, `VOYAGE_API_KEY` and (for 1a runner expansion and 1b) `ANTHROPIC_API_KEY`, and the cleaned `_s` file at `~/lme/data/longmemeval_s_cleaned.json` (SHA-256 `d6f21ea9…`):

```bash
S=docs/benchmarks/2026-10-04-longmemeval-opaque-followups/scripts
bash $S/run-1a-harness.sh        # 1a harness arms; about 1.5 h on a 16-vCPU VM, $10
bash $S/run-1a-runner.sh         # 1a runner arms; about 1.5 h with 14 workers, $9
bun  $S/build-reading-notes-inputs.ts <dataset> docs/benchmarks/2026-09-25-reading-notes/reading-notes-transfer.ndjson \
     docs/benchmarks/2026-09-06-longmemeval-ranker-wave/longmemeval/D1-judged-release-config-sonnet46-reader-gpt4o-judge.ndjson frozen.json
bun eval/runner/reading-notes-requests.ts --input frozen.json --output eval/reports/reading-notes/plan.json --model anthropic:claude-sonnet-4-6 --max-tokens 512
bun eval/runner/reading-notes-run.ts --execute --input frozen.json --requests eval/reports/reading-notes/plan.json \
    --journal eval/reports/reading-notes/run.ndjson --max-usd 38 --approval-id <yours>   # about 1.5 h sequential, $35
LME_DATASET=<dataset> bun $S/grade-1b.ts labels.ndjson eval/reports/reading-notes/run.ndjson
LME_DATASET=<dataset> OUT=<dir> bun $S/frontier.ts pilot && bun $S/frontier.ts submit   # then collect, then judge; $12
```

Each run took between 15 minutes (the frontier batch) and 1.5 hours (the harness arms). Runs share no state other than the dataset file, so they can run in parallel.
