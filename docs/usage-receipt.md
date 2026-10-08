# The usage receipt: one record of what each model call read, wrote and cost

Every reading lane in this repository records model calls in one shape, `usage-receipt/v1`, defined in
[`eval/runner/usage-receipt.ts`](../eval/runner/usage-receipt.ts). The memory-qa reader, gbrain `think` and judge
calls write it today ([`eval/runner/memory-qa/run.ts`](../eval/runner/memory-qa/run.ts)), and the W10 batch
re-score reads its committed rows through the same normalizer
([`eval/runner/batch/w10-rescore.ts`](../eval/runner/batch/w10-rescore.ts)). This page is for harness authors
who want token counts and dollars that compare across providers: the Q1 scoreboard cells and the wave 1 pilot arms
of the [10x memory advantage plan](https://github.com/garrytan/gbrain-evals/pull/97) adopt it.

Nothing on this page is a new measurement. Its worked numbers recount committed W10 receipts.

## Why one shape

Providers count cached input differently, and adding numbers across that difference silently inflates or
deflates a token count.

- **Anthropic** reports `input_tokens` as the uncached input only. Prompt-cache reads
  (`cache_read_input_tokens`) and writes (`cache_creation_input_tokens`) are separate buckets, so the input a
  model read is the sum of the three.
- **OpenAI** reports `prompt_tokens` (Chat Completions) or `input_tokens` (Responses) as the total input
  already. Cached reads (`cached_tokens`) and cache writes (`cache_write_tokens`) are subsets of that total.
  Adding them on top counts them twice: a 100-token prompt with 60 cached tokens becomes 160.

The same formula, `input + cache_read + cache_write`, is right for Anthropic and wrong for OpenAI. The committed
W10b `gpt-5.4` arm shows the size of the error: its 500 requests read 1,272,832 tokens from the cache, so the
double count reports a mean of 17,004 input tokens where the provider billed 14,458.

Two other defects the receipt replaces: the memory-qa `think` lane counted only the question's characters as
input (`tin += approxTokens(q.question)`), and every lane kept only the last replicate's answer, cut to 2,000
characters, so a later rescoring of committed-wrong answers could not see what the judge saw.

## The record

One record per attempted invocation. A request retried twice leaves two `error` records and one `ok` record;
each replicate has its own records; a response served from the harness's local response cache is a record
with `from_cache: true` and the original call's usage.

| Field | Meaning |
|---|---|
| `schema` | `usage-receipt/v1` |
| `lane`, `role` | The harness lane (`memory-qa`, `w10-batch`, `q1-cell`) and the call's role (`reader`, `think`, `judge`, `builder`) |
| `question_id`, `replicate`, `attempt` | Which question and replicate; `attempt` counts from 0 within that question, replicate and role |
| `model`, `response_model` | The requested `provider:model` and the model id the provider reported |
| `status`, `error` | `ok`, or `error` with the provider's message |
| `from_cache` | True when the harness's local cache answered and no provider call ran |
| `finish`, `finish_raw` | The stop reason in one vocabulary (`stop`, `max_tokens`, `tool_use`, `refusal`) and as the provider sent it |
| `answer` | The full answer text, never truncated |
| `usage` | The normalized numbers below, or null when the response carried none |
| `usage_raw` | The provider's usage object, unchanged |
| `delivered` | Tokens of the text delivered to the model, with the tokenizer named (`cl100k` for reader prompts; `think` reports its own delivery count) |

`usage` holds:

| Field | Anthropic | OpenAI |
|---|---|---|
| `input_total` | `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` | `prompt_tokens` (or `input_tokens`) |
| `input_uncached` | `input_tokens` | total minus `cached_tokens` minus `cache_write_tokens` |
| `cache_read` | `cache_read_input_tokens` | `cached_tokens` |
| `cache_write` | `cache_creation_input_tokens` | `cache_write_tokens` |
| `output_total` | `output_tokens` (thinking included) | `completion_tokens` (or `output_tokens`, reasoning included) |
| `reasoning` | `output_tokens_details.thinking_tokens` | `reasoning_tokens` |

gbrain's `think` returns `{ input_tokens, output_tokens }` summed over its synthesis calls with no cache split,
so its `input_uncached`, `cache_read`, `cache_write` and `reasoning` are null (not reported), never zero.
`sumUsage` keeps that distinction: a sum that mixes `think` records with cache-split records reports the cache
fields as null instead of a partial sum. A memory-qa response cached before raw usage was kept is recorded with
`convention: "legacy-cache"`: its stored input and output totals, and null cache fields.

Provider-reported tokens are not comparable across model families: on the same W10b text, Claude readers saw a
mean of 22,077 tokens and `gpt-6.1-sol` 13,695. A gate that compares arms with different readers uses `delivered`
(one tokenizer, cl100k, on the delivered text) and reports the provider numbers beside it.

## How a memory-qa row uses it

`readAndJudge` in `eval/runner/memory-qa/run.ts` writes `qa_receipts` (every reader, think and judge record for
the question), `qa_input_tokens` and `qa_output_tokens` (means over replicates of `input_total` and
`output_total` from the answer records), `qa_delivered_tokens` and `qa_answer` (the final replicate's full
answer). When any answer's response carried no usage, the row has `qa_usage_missing` instead of token means.
The arm's `receipt.json` adds `usage.by_role`, the `sumUsage` totals per role.

## Adopting it in another harness

1. Keep the provider's raw usage object with each response.
2. Call `normalizeUsage(usageSourceOf(model), rawUsage)` for the numbers; never add cached tokens yourself.
3. Write one `receipt(...)` record per attempt, including failed attempts and replicates, with the full answer.
4. Report `input_total` as the provider input, `delivered` as the cross-arm number, and dollars from the budget
   ledger, which settles cache reads and writes at their own prices
   ([`usageCost` in `eval/runner/budget-ledger.ts`](../eval/runner/budget-ledger.ts)).

For the Q1 scoreboard (`evals/q1-scoreboard`, `eval/runner/q1/cell.ts`), the change is local to the answer record:
`provider_input_tokens` becomes `normalizeUsage(source, raw).input_total`, which is
`input_tokens + cache_read + cache_write` for Anthropic and `prompt_tokens` alone for OpenAI.

## Check it

```bash
bun test test/eval/memory-qa-usage.test.ts
```

The test serves recorded synthetic Anthropic and OpenAI responses through a mocked fetch and checks that both
conventions give the same totals, that retries and failures leave one record per attempt, that `think` rows
carry `think`'s own usage, that a 5,000-character answer survives whole, and that the normalizer reproduces the
committed W10 means (22,167 for W10a; 22,077 for Opus 5.5, 13,695 for `gpt-6.1-sol` and 14,458 for `gpt-5.4` in
W10b). It makes no provider call.
