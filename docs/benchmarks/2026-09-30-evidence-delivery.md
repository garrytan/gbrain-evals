# Evidence delivery on LongMemEval-S: whole pages help, cheaper windows do not close enough of the gap

**Finding, 2026-09-30.** With gbrain's reranker on and retrieval held fixed, giving the reader the whole conversation behind each of the top five hits answered **361 of 400** held-out questions correctly, against **253 of 400** for the five chunks alone (+114 / −6, exact McNemar p = 6e-27). The two cheaper policies that won the pilot, one or two neighboring chunks on each side (`window1`, `window2`), also beat chunks significantly (285 and 292 of 400) at 44% of whole-page input tokens. But they recovered only 30% and 36% of the chunk-to-page difference, short of the preregistered 60%. **Decision-manifest verdict: `page_only`, benefit only at full token cost.** The `page` unit ships as a documented opt-in; the default stays `chunk`. The sealed confirmation set (E2) was not opened, because the manifest runs it only after a success.

The gbrain code measured is the evidence-delivery PR ([gbrain #5769](https://github.com/garrytan/gbrain/pull/5769)) at `732ee8116b6fd7d2de38824a54d35f57e4ea35c4`, pinned in the [decision manifest](2026-09-30-evidence-delivery/decision-manifest.json) before any paid run. The question, arms and rule were preregistered in the [preregistration](2026-09-30-evidence-delivery-preregistration.md). LongMemEval-S is development data for gbrain, so these are development results, not an independent confirmation.

## The concrete case

[gbrain](https://github.com/garrytan/gbrain) returns ranked text chunks from stored notes and conversations. [LongMemEval](https://arxiv.org/abs/2410.10813) asks questions about long chat histories; a reader model answers from what retrieval returns and a judge model grades the answer.

An invented example of the hard case: *"How many weeks passed between buying the blue widget and returning it?"* The answer needs two conversations and both dates. One chunk may hold the purchase, another the return, and neither carries the surrounding turns that say which widget or when. Multi-session and temporal questions are where chunks lost most in this study too.

gbrain's new opt-in stage (`return_unit`) returns more around each hit: `window` (neighbor chunks), `section` (the enclosing section or conversation round), `page` (the whole page, up to 60,000 characters) or `auto` (a structural rule). This study measures what each delivers to a one-shot reader.

## The experiment

**Frozen retrieval.** Each of the 500 questions' histories was imported into a fresh in-memory brain at the pinned commit. The R1 settings were used throughout: `voyage:rerank-2.5` on 25 candidates, top 5, balanced mode, no autocut, no query expansion, and `text-embedding-3-large` at 1,536 dimensions. The ordered hits, their chunk text, every chunk of every hit page, the harness page text and every arm's delivered evidence were stored once, content-addressed by SHA-256, with gbrain's own evidence fingerprints. Of the 500 top-five lists, 406 were identical to R1's (the September 30 reranker-on run on older code) and 410 matched on pages. No question was dropped for differing.

**One reader request.** Every arm used the house notes reader: `anthropic:claude-sonnet-4-6`, the R1 system text, 1,024 output tokens and provider-default temperature. Each delivered block became one `<chat_session>` block with its opaque session id and date. Only the delivered evidence differed between arms. Two judges graded every answer: gbrain's framed judge (primary) and the verbatim official LongMemEval judge (confirmation), both `gpt-4o-2024-08-06` at temperature 0.

**Parity before any model call.** On all 406 questions whose lists matched R1, the harness `page_legacy` request was byte-identical to the request R1 logged. The product `page` text matched the harness page text with its metadata header removed on 2,448 of 2,451 blocks. The three exceptions are pages whose best hit was a fenced-code chunk: there the product delivered that code chunk instead of the page.

**Sets.** Policies were chosen on a fixed random 100 questions (the pilot) and tested on the other 400 (confirmatory).

### Pilot: choosing two candidates (100 questions)

| Arm | What the reader gets | Correct (gbrain judge) | Official judge | Mean reader input tokens | Against chunk |
|---|---|---|---|---|---|
| `chunk` | the five ranked chunks | 68 | 68 | 3,539 | |
| `window1` | each hit plus 1 neighbor chunk per side, 6,000-token budget | **79** | 79 | 6,762 | +12 / −1 |
| `window2` | 2 neighbors per side, 6,000 tokens | **77** | 77 | 6,890 | +11 / −2 |
| `auto6k` | gbrain's `auto` rule at 6,000 tokens | 76 | 76 | 6,904 | +9 / −1 |
| `section` | enclosing section or conversation round, 6,000 tokens | 75 | 74 | 5,432 | +10 / −3 |
| `auto4k` | `auto` at 4,000 tokens | 70 | 72 | 4,715 | +5 / −3 |
| `auto7_5k` | `auto` at 7,500 tokens (ineligible: 58% of page's tokens) | 78 | 79 | 8,537 | +12 / −2 |
| `page` | whole page per hit (the reference) | 92 | 92 | 14,617 | +24 / −0 |
| `k10` | top ten chunks packed to 6,000 tokens (comparator) | 67 | 67 | 6,709 | +1 / −2 |
| `page_legacy` | the harness reader's own page text (control) | 89 | 91 | 14,834 | +22 / −1 |
| `agent_fetch` | chunks plus a `get_page` tool, up to 5 fetches | 83 | 82 | 12,390 | +15 / −0 |

`window1` and `window2` advanced. The page reference guard passed: `page` used 0.985 times `page_legacy`'s tokens. More chunks at the same budget (`k10`) did not help at all; the gain comes from surrounding context, not from more hits.

### Confirmatory: the decision (400 questions)

| Arm | Correct (gbrain judge) | Official judge | Against chunk | Share of gap closed | Tokens vs page | Mean / p95 reader input tokens |
|---|---|---|---|---|---|---|
| `chunk` | 253 | 255 | | | 0.23 | 3,511 / 4,023 |
| `window1` | 285 | 286 | +47 / −15 | 29.6% | 0.44 | 6,805 / 7,179 |
| `window2` | 292 | 292 | +54 / −15 | 36.1% | 0.45 | 6,906 / 7,207 |
| `page` | 361 | 361 | +114 / −6 | 100% | 1.00 | 15,484 / 19,445 |

How each preregistered condition came out:

- **Gap.** `page - chunk = 108` questions, McNemar p = 6e-27, so the gap is established. The official judge agrees (106).
- **Closure.** The hurdle is `253 + 0.6 x 108 = 317.8`. `window2` reached 292 and `window1` 285, so **both fail**. The paired contrast `P - chunk - 0.6 x (page - chunk)` is −0.065 per question for `window2`, with a cluster bootstrap 95% interval of −0.099 to −0.031, clearly below zero.
- **Tokens.** Both pass: 0.44 and 0.45 of page's provider-reported input, against the 0.50 limit.
- **Significance.** Both pass. With Holm correction over all six candidates, McNemar p = 1.6e-5 (`window2`) and 2.9e-4 (`window1`); the cluster sign-flip test agrees.
- **Per type.** Both pass. No type had a net loss against chunk; `window2`'s smallest gain was 2 questions.
- **Outcome.** `page_only`. The gap is real and no candidate closed 60% of it. The confirmation judge would not have changed this.

By question type (gbrain judge, correct answers):

| Type | n | chunk | window1 | window2 | page |
|---|---|---|---|---|---|
| multi-session | 112 | 52 | 67 | 69 | 91 |
| temporal-reasoning | 110 | 61 | 66 | 67 | 99 |
| knowledge-update | 55 | 44 | 45 | 46 | 52 |
| single-session-user | 54 | 41 | 45 | 46 | 54 |
| single-session-assistant | 44 | 37 | 43 | 44 | 44 |
| single-session-preference | 25 | 18 | 19 | 20 | 21 |

Neighbor windows help most where a chunk is cut mid-answer: single-session questions and part of multi-session. They leave most of the temporal gap open (67 against 99): the date and ordering evidence is often elsewhere in the session. Across all 500 questions, `page` scored 453/500, the same number as R1, and `chunk` scored 321/500.

### Three token counts

Every row records three counts. The decision uses only the provider-reported one.

| Arm (confirmatory means) | gbrain's cl100k count of delivered text | Serialized tool payload (cl100k) | Provider-reported reader input |
|---|---|---|---|
| `chunk` | 2,790 | 3,428 | 3,511 |
| `window1` | 5,867 | 7,063 | 6,805 |
| `window2` | 5,953 | 7,150 | 6,906 |
| `page` | 13,800 | 15,254 | 15,484 |

A "6,000-token budget" in gbrain's own count became about 6,900 reader tokens. That is because the reader request also carries framing, dates, ids and the question, and Claude's tokenizer is not cl100k.

### An agent that can fetch pages

`agent_fetch` saw the chunk request plus a `get_page` tool (at most 5 fetches, 6 turns, fresh history per question). It answered 83 of 100 pilot questions, against 68 for chunks and 92 for `page`. It fetched no page on 30 questions, one page on 32 and two or more on 38 (1.3 fetches on average). It used 12,390 input tokens across turns, 0.85 of `page`, and its median latency was 10.5 s against 7.4 s. It lost to `page` on 10 questions and won 1. An agent allowed to fetch recovers part of the gap, but it under-fetches: it often answers, or abstains, from the chunks when the whole session would have helped. This arm is outside the decision family.

### Does it hold for another reader?

The manifest's gpt-4o check (chunk and the better advanced candidate, `window2`, on the 400) came out **128 against 129 of 400**, a tie (+47 / −46). The number is low because gpt-4o, given the house notes prompt, said the information was not available on 261 to 274 of 400 questions. With the official LongMemEval prompt on full sessions, gpt-4o scored about as well as Sonnet in the [September 29 study](2026-09-29-longmemeval-opaque-qa.md). So this check says the notes prompt does not transfer to gpt-4o. It says nothing either way about windows for gpt-4o.

### Product path (E3)

For each of the 100 pilot questions, a fresh on-disk brain was served by gbrain's own MCP server over stdio as a remote caller, with `query` called with `expand: false`:

- **Hit lists.** The live `query` hit lists equalled the frozen ones on 100 of 100.
- **Local against remote.** `assemble_evidence` over the frozen hits reproduced the frozen local fingerprints and delivered-token counts for `page`, `window1` and `window2` on 100 of 100. Readers scored from the exact serialized `query` evidence used, to the token, the same input as E1.
- **Answers.** The E3 answers agreed with E1's frozen-evidence answers on 92 to 95 of 100, which is reader noise on identical bytes.
- **`query` against `assemble_evidence`.** They matched on 100 of 100 for `page` and `window1`, and on 99 of 100 for `window2`. On the one mismatch, a rerun showed the policy `query` retrieving a different hit list from the chunk-mode `query`, which points to rerank variability between the two calls. By the manifest's letter, `window2` did not pass E3. This did not matter, because no candidate succeeded.
- **Containment.** One question's fenced-code hit delivered the chunker's synthesized code-chunk header, text that is not in the page body. It is not protected content, but it is a product behavior worth fixing alongside the fenced-code `page` case above.

### Noise controls

On the 81 pilot questions whose lists matched R1, `page_legacy` (byte-identical requests to R1) agreed with R1's stored verdicts on 77. That is about 5% reader noise at provider-default temperature. The two judges agreed on 1,581 of 1,600 confirmatory Sonnet verdicts (98.8%).

## What to use and what to avoid

- **Ask for `return_unit: "page"` when a question may span or depend on a whole conversation.** On this benchmark it bought 108 more correct answers per 400 questions for about 4.4 times the input tokens of chunks.
- **`window` with one or two neighbors is a real but partial improvement:** +32 to +39 correct per 400 at about twice the tokens of chunks. That is worth it when tokens are tight, but it does not come close to whole pages on temporal questions.
- **Do not expect more chunks to substitute for context.** Ten chunks at the same budget scored the same as five.
- **An agent that can fetch pages should be prompted to fetch.** Left to itself it fetched on only 70 of 100 questions.
- **Limits.** Every measured page here is a chat session, and LongMemEval-S is development data. The sealed set was not used. None of this covers curated notes, code or multilingual pages. Per the manifest, no default flips.

## Deviations and operational notes

- **Reranker timeout.** Voyage was overloaded during the freeze (HTTP 503s, and reranks slower than gbrain's 5 s timeout). On 28 questions the reranker fell back to unreranked order; the freeze refused those lists. Those 28 were frozen with `search.reranker.timeout_ms` raised to 30 s, and each carries `reranker_timeout_ms: 30000` in the frozen manifest. The timeout does not change the order of a completed rerank. E3 used the same timeout.
- **Errors.** There were no reader errors in any arm, so no question needed the error rules.
- **Accounting.** Timed-out and 503 rerank requests (548) and 5 embedding retries had no usage in their responses. The ledger charges them at their worst-case reservation, so reported spend can only overstate.
- **The two strict rules flagged in the power analysis did not decide anything.** No type had a net loss, and E2 did not run.

## Reproduce and inspect

- Code: gbrain-evals branch `capy/evidence-delivery-evals`. The runner is `eval/runner/evidence-delivery.ts` and the decision code is `eval/runner/evidence-delivery/decision.ts`. The freeze (after its first attempt at `6a7c9eb`), every Sonnet arm and E3 ran at evals commit `f538872`. The gpt-4o arms and the E3 rerun ran at `58a4213`, which differs only in E3 reporting code.
- gbrain `732ee8116b6fd7d2de38824a54d35f57e4ea35c4`. Dataset: cleaned LongMemEval-S, SHA-256 `d6f21ea9…`.
- Compute: one Ubicloud `standard-16` VM (us-east-a2), about 4 hours, with the [pipeline and watchdog scripts](2026-09-30-evidence-delivery/scripts/pipeline.sh). The VM was destroyed afterwards.
- **Cost: $112.44** through one campaign ledger run (cap $400, program cap $1,000): Sonnet reader $85.27, gpt-4o reader and gbrain judge $13.22, official judge $3.04, embeddings $9.11, Voyage $1.80 ([ledger summary](2026-09-30-evidence-delivery/results/ledger-summary.json)). Smoke tests and debugging on the Capy machine, in a separate local ledger, cost $1.04 in provider-reconciled requests. That ledger also holds $1.50 of charged reservations from debugging reranks whose requests never left the machine.
- Receipts under [`2026-09-30-evidence-delivery/results/`](2026-09-30-evidence-delivery/results/):
  - [pilot](2026-09-30-evidence-delivery/results/pilot-decision.json) and [confirmatory](2026-09-30-evidence-delivery/results/confirmatory-decision.json) decisions;
  - per-question rows for every arm (`e1/*.ndjson.gz`), with hypotheses, both verdicts, three token counts and request hashes;
  - the frozen manifest (`frozen/frozen-manifest.jsonl.gz`, content hashes only), its header with code, parser and index hashes, and the parity report;
  - E3 records and [summary](2026-09-30-evidence-delivery/results/e3/e3-summary.json);
  - watchdog and pipeline logs.
- The 381 MB blob store behind the frozen manifest is not committed. Re-running `freeze` at the pinned commit regenerates it, and the committed hashes verify it.

```bash
export GBRAIN_DIR=<gbrain checkout at 732ee811>
bun eval/runner/evidence-delivery.ts analyze --rows-dir <rows> --stage confirmatory --pilot-decision docs/benchmarks/2026-09-30-evidence-delivery/results/pilot-decision.json
bun eval/runner/evidence-delivery.ts e3-summary --e3 <e3.ndjson>
```
