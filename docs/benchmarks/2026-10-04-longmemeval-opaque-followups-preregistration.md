# Preregistration: LongMemEval opaque-id follow-ups and a frontier reader (2026-10-04)

Frozen on October 4, 2026, in its own commit, before any measured run. Nothing below changes after a run; a later change gets a new dated section marked as an amendment, written before the run it affects. Configuration smoke runs of 2 and 3 questions preceded this file (harness flags, expansion replay, search pins, the reranker transport and this repository's runner). They checked that the commands execute and are not part of any result.

[gbrain](https://github.com/garrytan/gbrain) is a Markdown-first memory system for agents. [LongMemEval](https://arxiv.org/abs/2410.10813) asks questions about long histories of old conversations. Every labeled evidence conversation ("session") in LongMemEval has an id starting with `answer_`, and no other session does. Until gbrain-evals v0.10.1 and gbrain `b80cad6`, those raw ids reached the system under test (as page titles) and the answer model (as `<chat_session id="answer_…">`). This file plans the three measurements still open from the September 28 audit (finding C-01) and audit item B6.

All three use the cleaned `_s` split, SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`, and the installed gbrain dependency at the main pin, `109b992172e1f49107f9de9841758c1d043a2668` (v0.60.37.0), unless a section says otherwise. Bun is 1.4.2. No sealed set is opened and no corpus is regenerated.

## Order and budget

The paid budget for this whole round is **$80**, across `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY`. Spending follows the item order: 1a first, then 1b, then 2. Each item has a cap. A later item starts its paid calls only when the earlier items' caps are covered by the remaining budget, so a later item can never take money an earlier one needs. If an item's projection exceeds its cap, it stops before the call that would cross it and is reported as incomplete; settings are never changed to make it cheaper.

| Item | What | Estimate | Cap |
|---|---|---:|---:|
| 1a-H | Eight September 6 retrieval arms plus four development-slice replays, gbrain's own harness | $9.40 | $11 |
| 1a-R | Five September 2 retrieval arms, this repository's runner | $9.30 | $11 |
| 1b | Reading-notes transfer, 361 questions, two readers, one judge | $36.30 | $38 |
| 2 | Frontier reader, 500 questions, two judges | $18.20 | $20 |
| **Total** | | **$73.20** | **$80** |

The estimates come from measured receipts, at list prices on 2026-10-04:

- **Embeddings.** A cold pass of gbrain's harness over all 500 questions embedded 58,368,935 tokens on 2026-09-29 (arm a of the [opaque-id re-run](2026-09-29-longmemeval-opaque-qa.md)); at $0.13 per million tokens for OpenAI `text-embedding-3-large` that is $7.59. Opaque ids are salted per question, so no session is shared between questions. This repository's runner renders sessions differently and keeps its own cache, so 1a-R pays its own cold pass, estimated at the same $7.59. Expansion replays add query embeddings only (three variants per question, under $0.05).
- **Reranking.** Voyage `rerank-2.5` used 6.94M tokens per 500-question arm on 2026-09-30, $0.35 at $0.05 per million. 1a-H has five reranked arms ($1.75), 1a-R two ($0.70).
- **Expansion.** 1a-H replays the variants recorded in the published A3 receipt, so it makes no language-model calls. 1a-R's `hybrid+expansion` adapter calls Claude Haiku once per question, estimated at $1 for 500 questions.
- **1b.** 722 reader calls to `claude-sonnet-4-6` at $3 / $15 per million input / output tokens. The prepared requests average 63,858 characters, about 15,500 input tokens: 11.2M input tokens, $33.60. Output, at the September 25 means of 87 (direct) and 244 (notes) tokens: $1.80. Judge: 722 calls to `gpt-4o-2024-08-06`, about $0.90.
- **2.** `gpt-5.4` through OpenAI's Batch API at $1.25 / $7.50 per million input / output tokens. The prompts are arm b's, 14,775 input tokens on average: $9.25 for 500. Output includes reasoning tokens; at an assumed mean of 2,000 per question, $7.50. A 10-question pilot at the standard price ($2.50 / $15) measures the real output and is included in the 500. Two gpt-4o judges over 500 answers: about $1.10.

Spend is accounted from provider usage in each run's own call log, priced at the rates above.

## 1a. Recount the published retrieval arms with opaque ids

### The question

The published LongMemEval retrieval numbers came from runs in which every labeled evidence session's id started with `answer_`, and that id reached gbrain as part of the page title. A 30-question check on 2026-09-28 found the same strict recall with and without the prefix. Do the full published arms give the same numbers when the ids are opaque?

### Arms

**1a-H: the September 6 ranker-wave arms**, from the [ranker-wave report](2026-09-06-longmemeval-ranker-wave.md). They were produced by gbrain's own `gbrain eval longmemeval` harness at v0.48.4.0 (`2efaaf8f`, receipts on branch head `fd7e7fd9`). The same harness, from the installed dependency at `109b992`, now imports each session under an opaque per-question slug (`chat/s-<10 hex>`) and maps back to the dataset ids only for scoring. It runs unmodified through `scripts/driver-retrieval.ts`, which only logs paid calls.

Common flags, as published: `--retrieval-only --top-k 5 --by-type --no-trajectory --embed-cache <one cache>`, with `GBRAIN_EMBEDDING_MODEL=openai:text-embedding-3-large` and `GBRAIN_EMBEDDING_DIMENSIONS=1536`.

| Arm | Published strict hits | Flags beyond the common set |
|---|---:|---|
| A1 | 439/470 | `--mode balanced --reranker off --autocut off` + pre-flip pins |
| A2 | 449/470 | `--mode balanced --reranker on --autocut off` + pre-flip pins |
| A3 | 255/470 | `--mode balanced --reranker off --autocut off --expansion-replay A3` + pre-flip pins |
| A4 | 379/470 | `--mode balanced --reranker on --autocut on` + pre-flip pins |
| A3′ | 394/470 | `--mode balanced --reranker off --autocut off --expansion-replay A3 --expansion-variant-budget 0.25` + pre-flip pins |
| A3′R | 381/470 | `--mode tokenmax --reranker on --autocut on --expansion-replay A3 --expansion-variant-budget 0.25` + pre-flip pins |
| tokenmax as released (TMXR) | 436/470 | `--mode tokenmax --reranker on --autocut off --expansion-replay A3` |
| final release configuration | 449/470 | `--mode balanced --reranker on --autocut off` |
| development slice, budgets 2.0, 1.0, 0.5, 0.25 | 24, 26, 30, 34 of 40 | `--mode balanced --reranker off --autocut off --expansion-replay A3 --expansion-variant-budget B --question-ids dev40` + pre-flip pins |

`A3` is the committed `2026-09-06-longmemeval-ranker-wave/longmemeval/A3-hybrid-expansion-rerank-off-autocut-off.ndjson`. Its rows keep the expansion variants that A3′, A3′R, TMXR and the development slice replayed on September 6. Our A3 replays them too; the published A3 generated them live. Replaying the same text is the closer match, and it removes the Haiku cost and its randomness. `dev40` is the 40 question ids of the committed development-slice receipts (seed 42).

**Pre-flip pins** are `--search-pin search.relational_rerank_pin=0 --search-pin search.metadata_boost_gate=always`. Six of the published arms ran on branch code before the relationship pin and the metadata gate existed. We checked this by recomputing each arm's recorded `knobs_hash` with gbrain's own `resolveSearchMode` and `knobsHash`: A1, A2, A3, A4, A3′ and A3′R match at `885bb91a1` and earlier, and not at `85cb21c4a` (which added the pin) or later. TMXR and the final configuration match the release `2efaaf8f`. The pre-flip code had no relationship pin (the same as pin 0), applied metadata boosts unconditionally (gate `always`) and had no keyword-confidence floor (the current default, off). With the two pins above, every other resolved search setting at `109b992` equals the published arm's setting (`scripts/knob-check.txt`); without them, the six arms would inherit the current defaults (pin 3, gate `lexical`). The check script and its output go in the receipts. The `retrieval_config_hash` itself cannot match, because gbrain's knob vocabulary moved from version 29 to 30. A4's published run also captured candidate pools (`--capture-pool`); that only adds output and is omitted.

**1a-R: the September 2 five-arm run**, from the [May report's rerun section](2026-05-07-longmemeval-s.md). It was produced by this repository's runner at gbrain v0.48.2.0, which since gbrain-evals v0.10.1 renders sessions under opaque ids. Command, as published:

```bash
bash eval/runner/longmemeval-batch.sh \
  --adapters hybrid,hybrid+expansion,hybrid-sessdiv,hybrid+rerank,hybrid-sessdiv+rerank \
  --embedding-model openai:text-embedding-3-large --embedding-dims 1536 \
  --path <longmemeval_s_cleaned.json> --budget-usd 11
```

Published strict hits: hybrid 438, hybrid+expansion 258, hybrid-sessdiv 439, hybrid+rerank 448, hybrid-sessdiv+rerank 449, each of 470. The runner pins only mode, reranker and autocut, so the relationship pin and metadata gate run at their current defaults here. On the September 6 receipts, A2 (no pin, no gate) and the final configuration (pin 3, gate `lexical`) returned identical session lists on 500 of 500 questions, so we expect no effect; 1a-H's A2 and final arms measure it again at `109b992`.

### Execution

The arms run on Ubicloud VMs. 1a-H builds its cache with A1 split into four shards of 125 questions (by `--question-ids`), each with its own cache; the caches are then merged into one file and the shard rows concatenated, and the harness is re-run over the full set with `--resume-from` so it writes the run summary without new work. Each later arm runs as its own process on its own copy of the merged cache. Questions are independent (the in-memory database is reset between questions), so sharding changes execution only. A watchdog restarts a stalled process from its rows file (gbrain issue #5092, a long single-process stall seen on 2026-09-29) and logs every restart. 1a-R uses the runner's own three-worker batching and resume.

### Metrics and comparison

For every arm: strict `recall_all@5` over the 470 answerable questions (a question counts only when every labeled evidence session is among the distinct sessions of the first five returned chunks), `recall_any@5` over the same 470, and for 1a-H the 430-question decision set (the 470 minus the 40 development questions). The development slice uses its own 40-question denominator.

Each arm is paired question by question with its published receipt: gains, losses and a two-sided exact McNemar p-value on strict hits. The September 29 and 30 opaque-id harness runs at gbrain `a7cb37b` (435/470 reranker off, 450/470 reranker on) are reported beside A1 and the final configuration as context.

### Decision rule

A published number **moved** if its paired comparison has exact McNemar p < 0.05 or the strict count differs by 10 or more questions. Otherwise it is **confirmed with opaque ids**.

- Every published retrieval number gets a dated annotation in its report with the recount, the paired result and this verdict.
- A confirmed number keeps its place in the README and settings guide, with the opaque-id recount beside it.
- A moved number is replaced as the current claim by the opaque-id recount, and the old number stays visible as historical.
- The README's statement that gbrain's strict recall is higher than every other system we can score on the same metric is rechecked against the recount of the release configuration and MemPalace's 423/470.

The code moved from v0.48 to v0.60 between the published runs and the recount, so a moved number cannot be attributed to the ids alone. If a README-cited arm (A1, A2, A4 or the final configuration) moves and budget remains after items 1b and 2, we run that arm once more at its published code on a copy of the dataset whose session ids are replaced by opaque ids; otherwise the change is reported as not attributed.

## 1b. The reading-notes transfer with opaque ids

### The question

On 2026-09-24, with raw ids visible to the reader, asking the reader to take brief notes before answering raised correct answers from 308/361 to 324/361 on the same retrieved sessions ([report](2026-09-25-reading-notes.md)). Does the gain hold when the reader sees only opaque ids?

### Inputs

The original frozen inputs are private. We rebuild them from public data:

- **Questions and order:** the 361 `pair` rows of the public receipt `2026-09-25-reading-notes/reading-notes-transfer.ndjson`.
- **Retrieved sessions:** the `retrieved_session_ids` of the September 6 D1 receipt (`D1-judged-release-config-sonnet46-reader-gpt4o-judge.ndjson`), in rank order. Evidence that this is the original retrieval: the receipt's `retrieval_complete` flag matches D1 on 361 of 361 questions (345 complete, 16 not). A2 and the final configuration returned the same session lists as D1 on all 500 questions, so they match too; every other September 6 arm disagrees on 15 to 162 of the 361.
- **Session text and dates:** the cleaned `_s` file. Each session body is rendered the way gbrain's harness renders a session page (front matter with type, date and session id, then `**role:** content` turns), with the session's opaque id from `eval/runner/longmemeval-session-ids.ts` in place of the dataset id.

The rebuilt file has 1,766 sessions, none above the reader's 60,000-character cap, and no `answer_` in any prepared request. Its SHA-256 is `747598d17ed262f6871d42ea5e446e7df2f7e3ac69a939eb3e90a9a820d58f67`. It cannot be checked against the original receipt hash (`65ffeaa8…`), because the original serialization is not published. The rebuild script is committed.

### Arms

Prepared with `eval/runner/reading-notes-requests.ts --model anthropic:claude-sonnet-4-6 --max-tokens 512` and executed with `eval/runner/reading-notes-run.ts`, the repository's existing capped lane, through the `gbrain-reader` alias at `e78f1c3`:

- **direct:** gbrain's prior LongMemEval reader prompt (`gbrain-lme-reader-v3-abstention-fullsessions`, SHA-256 `7d991ff3e789…`, the published D1 prompt);
- **notes:** the same prompt with one sentence replaced by "First extract all the relevant information, then reason over the information to get the answer. Keep the notes brief and end with a concise final answer." (`gbrain-lme-reader-v4-notes-fullsessions`, `3db7ccbb12b2…`).

Both arms use a 512-token output limit and provider-default temperature, as on September 24. The run lane allows no retries; we split the 361 questions into four consecutive parts with their own journals, so a halt costs at most one part. A halted part is re-run only for its unanswered questions, and every halt is reported.

### Grading

The complete response, notes included, is graded by gbrain's data-boundary judge (`judgeRow` from `src/eval/longmemeval/judge.ts`, identical bytes in `gbrain` and `gbrain-reader`) with `openai:gpt-4o-2024-08-06`, temperature 0, 16 output tokens. A judge error is retried at most twice and otherwise counts as incorrect. A response that hit the 512-token limit is graded as written, as on September 24, and also reported under the September 25 conservative rule (every cutoff counts as incorrect).

### Metrics and decision rule

Correct answers of 361 per arm; answerable questions of 354; abstention questions of 7; the 345 questions with complete retrieval; cutoffs per arm. Paired: wins, losses, exact McNemar p, and a paired 95% bootstrap interval for the difference (10,000 resamples, `mulberry32` seed 20261004).

The predeclared September 24 gate applies unchanged: **the notes gain holds with opaque ids** if the paired 95% interval for notes minus direct lies above zero and the notes abstention count is not lower than direct's. Otherwise it does not hold.

Each arm is also paired with its own September 24 label on the same question. Generation is not deterministic (12 repeated baseline prompts went 11/12 to 10/12 on September 24), so these within-arm comparisons describe the combined effect of the leak and run-to-run variation and are reported as such.

The reading-notes report gets a dated annotation with the result. The 308/361 and 324/361 figures stay as historical. If the gate passes, the opaque-id numbers become the current claim for the transfer; if it fails, the README and report say the notes gain is not established with opaque ids.

## 2. Frontier-reader answer accuracy

### The question

On 2026-09-29, a GPT-4o reader with LongMemEval's official reading prompt answered 430/500 on gbrain's retrieved sessions. Published systems report answer accuracy with frontier readers. What does a frontier reader score on exactly the same gbrain retrieval and official prompt?

### Reader

**`gpt-5.4` (OpenAI), reasoning effort `medium`.** Why this model: Zep's 90.2% (451/500) on LongMemEval used a `gpt-5.4` reader at medium reasoning effort, and Memoria's 84.97% (424/499) used a `gpt-5.4` reader on frozen retrieval ([comparison sources](../comparison-systems.md)). Memoria's 88.78% used `claude-opus-4.6`, which would cost about twice as much per input token and does not fit the budget; Mastra's and Supermemory's Gemini readers need a provider key this repository's runs do not have.

### Arm

The input is the exact user prompt of every arm-b row in `2026-09-29-longmemeval-opaque-qa/b/rows.ndjson.gz` (field `reader_prompt`): LongMemEval's official `run_generation.py` prompt with JSON history, both speakers, and "Answer the question step by step: first extract all the relevant information, and then reason over the information to get the answer" (`con`, notes first), over the distinct sessions behind the top five chunks of the reranker-off run at gbrain `a7cb37b` (435/470 strict retrieval), sorted by date. Only the reader changes from arm b. The official prompt carries no session ids.

Request: one user message, `reasoning_effort: "medium"`, `max_completion_tokens: 12000`. Two settings necessarily differ from arm b and from the official script: `gpt-5.4` with reasoning does not accept temperature 0, so the provider default is used; and the official 800-token limit would be consumed by reasoning, so the limit is 12,000 tokens, covering reasoning and answer. A `length` finish is graded as written and reported. A 10-question pilot (the first 10 ids of `pilot20.txt`) runs through Chat Completions; the other 490 run through the Batch API with identical request bodies. A request that fails is retried at most twice; a question with no answer counts as incorrect.

### Grading and decision rule

The same two judges as arms a and b: gbrain's judge (`judgeRow`, `openai:gpt-4o`, temperature 0, 16 tokens) and the verbatim official `evaluate_qa.py` judge (`gpt-4o-2024-08-06`, temperature 0, 10 tokens, "yes" in the lowercased reply).

Primary result: correct answers of 500 under the gbrain judge; secondary under the official judge; both by question type and on the 435 questions with complete retrieval. Paired with arm b (GPT-4o, same prompts) and arm a (house reader, same sessions): wins, losses, exact McNemar p. A reader difference is **demonstrated** only at p < 0.05 under the gbrain judge.

The README and comparison page report the number with its reader, judge, retrieval and prompt. No ranking against vendor results is claimed: retrieval, context size and judges still differ from every published row, including Zep's, which used a `gpt-5.4` judge.

## What is published

One dated results report, `docs/benchmarks/2026-10-04-longmemeval-opaque-followups.md`, with raw receipts under `docs/benchmarks/2026-10-04-longmemeval-opaque-followups/`: harness rows (compressed), call logs, run summaries, the rebuilt reading-notes inputs' hash and builder, per-question labels and responses for 1b and 2, every executed script, and the knob check. Failed, partial and halted runs are reported, not dropped.
