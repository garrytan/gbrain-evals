# The usage receipt: one record of what each model call read, wrote and cost

Every reading lane in this repository records model calls in one shape, `usage-receipt/v1`, defined in
[`eval/runner/usage-receipt.ts`](../eval/runner/usage-receipt.ts). The memory-qa reader, gbrain `think` and judge
calls write it today ([`eval/runner/memory-qa/run.ts`](../eval/runner/memory-qa/run.ts)), and the W10 batch
re-score reads its committed rows through the same normalizer
([`eval/runner/batch/w10-rescore.ts`](../eval/runner/batch/w10-rescore.ts)). The Cat 40 agent loop reports every
provider attempt, retries and failures included, and `attemptReceipt` in
[`eval/runner/cat40/loop.ts`](../eval/runner/cat40/loop.ts) turns each into one record. The v1 model ladder writes a
cell's attempts to `cells/<cell>/attempts.ndjson` under its `--out` directory, and the Q1 file agent writes its
attempts to `receipts.ndjson` in its work directory (`runs/<cell>/file-agent/` under a Q1 cell's output). This page
is for harness authors who want token counts and dollars that compare across providers. The Q1 scoreboard cells and
the wave 1 pilot arms of the [10x memory advantage plan](https://github.com/garrytan/gbrain-evals/pull/97) adopt it.

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
- **Particle** (`particle:particle-1`), like every provider in the OpenAI-compatible provider module
  ([`eval/runner/providers/openai-compatible.ts`](../eval/runner/providers/openai-compatible.ts)), reports OpenAI
  Chat Completions usage: cached reads inside `prompt_tokens`, and reasoning inside `completion_tokens`, which it
  bills as output. `usageSourceOf('particle:…')` returns the OpenAI convention.

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
| `lane`, `role` | The harness lane (`memory-qa`, `w10-batch`, `q1-cell`, `cat40-model-ladder`, `q1-file-agent`) and the call's role (`reader`, `think`, `judge`, `builder`) |
| `question_id`, `replicate`, `attempt` | Which question and replicate; `attempt` counts from 0 within that question, replicate and role |
| `model`, `response_model` | The requested `provider:model` and the model id the provider reported |
| `status`, `error` | `ok`, or `error` with the provider's message |
| `from_cache` | True when the harness's local cache answered and no provider call ran |
| `finish`, `finish_raw` | The stop reason in one vocabulary (`stop`, `max_tokens`, `tool_use`, `refusal`) and as the provider sent it |
| `answer` | The full answer text, never truncated |
| `usage` | The normalized numbers below, or null when the response carried none |
| `usage_raw` | The provider's usage object, unchanged |
| `delivered` | Tokens of the text delivered to the model, with the tokenizer named (`cl100k` for reader prompts; `think` reports its own delivery count) |
| `request` | Optional: what the request sent, for calls made through the OpenAI-compatible provider module and every Cat 40 loop attempt (below) |
| `response_meta` | Optional: what identifies the serving model and tier, for calls made through the provider module (below) |

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

Records from the two Cat 40 loop lanes carry three more fields. `turn` is the loop's turn, `ms` the attempt's wall
time, and `retry_after_ms` the Retry-After a Particle error sent, in milliseconds (capped at 120 seconds, null
otherwise). In the ladder, `question_id` is the cell key and session (`<model>|<arm label>|<task>|<repeat>|s2` for
the scored session, `|s1` for a family F task's first session) and `replicate` is the repeat. In the file agent,
`question_id` is the Q1 cell's opaque answer id, so its receipts join `answers.ndjson` without a raw question id. A
rerun numbers its attempts on from the records already in the file, so `question_id`, `replicate` and `attempt` name
one attempt.

## Request settings and response identity

A reasoning model's answer depends on settings the model id does not show, and a provider can change the weights
behind an id. Lanes that call a provider through the OpenAI-compatible provider module record both on every attempt:
the memory-qa reading lane (`eval/runner/memory-qa/qa-v2.ts`, for `--reader` or `--judge particle:particle-1`),
particle-1 in the Cat 40 loop and the particle weight canary (`scripts/particle-canary.ts`). The fields are optional,
so the schema stays `usage-receipt/v1` and older receipts stay valid.

`request`, built by `compatRequest` with the request itself:

| Field | Meaning |
|---|---|
| `effort_sent`, `effort_effective` | The `reasoning_effort` sent and the level the provider runs it at. Particle runs `minimal` as `low`, `medium` and `xhigh` as `high`, and `ultra` as `max`, so a campaign that fixes `medium` for every reader records particle-1 at `high` |
| `output_limit_field`, `output_limit` | The output-limit field (`max_completion_tokens`) and its value. particle-1 is sent at least 16,000 tokens, because reasoning shares the limit: a 48-token limit at the default effort returned empty content (probe, 2026-10-31) |
| `temperature_sent`, `seed_sent` | Null when none was sent. Particle is sent neither, and then samples with top_p 0.85; only the weight canary (`scripts/particle-canary.ts`) sends them |

The Cat 40 loop sends particle-1 `reasoning_effort` `high` unless the caller passes another level. It records
`request` for its Anthropic and OpenAI attempts too, built by the loop itself. Those providers run the effort they
are sent, so `effort_sent` and `effort_effective` both hold the effort the caller passed (null when it passes none,
as the ladder does). The output-limit field is `max_tokens` or `max_output_tokens`, and temperature and seed are null.

`response_meta`, from `responseMeta(response)`:

| Field | Meaning |
|---|---|
| `metadata` | The response's raw `metadata` object, unchanged. Particle sends a weight version, or a list per span |
| `weight_version` | `metadata.weight_version` when it is a string. Particle reported one in 1 of 18 probe responses (2026-10-31), and then only `default`, so its absence proves nothing; the paid weight canary watches for changes instead |
| `service_tier`, `system_fingerprint` | As the response reports them |
| `non_default_tier` | True when the response names a tier other than `default`. Particle's `flex` tier lists at half price and may serve differently |
| `truncated` | True when the model stopped at the output limit (`finish_reason: length`) |

A failed attempt (a 429, a network error, a 402) has no response, so every `response_meta` field is null, never an
invented value, and `response_model` and `usage` are null as before. One `error` attempt keeps a body. The Cat 40
loop and memory-qa retry a Particle 2xx that has no `choices[0].message` as a server error, and that attempt's record
keeps the body's usage (the Cat 40 loop keeps its response metadata too); `sumUsage` totals count successful records
only. In memory-qa, a failed attempt the provider answered with a Retry-After also has `retry_after_ms`: the wait
before the next attempt, capped at 120 seconds, absent when the provider sent none or no attempt followed. In
memory-qa and Q1, a Particle attempt waits up to the metering proxies' 900-second upstream deadline. On a loopback
lease-proxy slot it waits that deadline plus the proxy's longest admission wait (600 seconds) and a minute, so the
proxy always answers first (issue #271). An attempt that times out, or whose connection resets or closes after the
request went out, is the last attempt, because Particle may have billed it; a Q1 cell records that answer as a final
`reader_error` and does not ask the question again. The Q1 file agent's particle turns follow the same rules: a turn
that times out, loses its connection or is answered 504 ends the question as a final `reader_error` (issue #253). For
the same reason, the lease proxy answers a particle request whose connection was reset before the response headers
arrived, or whose body failed to read after them, with a 504 instead of sending it again, and charges its reservation
(issue #270). A truncated response keeps its own content as
`answer`, even when that is empty: the reasoning text (Particle's `reasoning_content`) never fills an answer.

## How a memory-qa row uses it

`readAndJudge` in `eval/runner/memory-qa/run.ts` writes `qa_receipts` (every reader, think and judge record for
the question), `qa_input_tokens` and `qa_output_tokens` (means over replicates of `input_total` and
`output_total` from the answer records), `qa_delivered_tokens` and `qa_answer` (the final replicate's full
answer). A `--qa think` row also has `qa_reference_date`, the day (YYYY-MM-DD) `think` reports it resolved relative
dates against: the harness asks for the question date, else the conversation's latest session date, and a gbrain
build older than 0.60.88 reports none, so its rows carry no date. When any answer's response carried no usage, the row
has `qa_usage_missing` instead of token means.
The arm's `receipt.json` adds `usage.by_role`, the `sumUsage` totals per role. A question stopped by a budget stop
(the ledger's cap, or Particle's credit 402) keeps the records gathered before the stop on its error row. Memory-system
cells (`eval/runner/memory-qa/run-systems.ts`) write `qa_receipts` for their reader calls.

## How a Q1 answer uses it

Q1 cells (`eval/runner/q1/cell.ts`) keep answer records (`eval/runner/memory-qa/records.ts`), not receipt files. A
packed or full-context answer from a reader in the OpenAI-compatible provider module (particle-1) adds `finish` (the
answering attempt's raw finish reason), `truncated` (the answer stopped at its output limit; it is still scored as
the model's answer and never retried) and `attempts`: one entry per provider attempt, in order, with `status`,
`error`, `from_cache`, `response_model`, `finish`, `reasoning_tokens`, `weight_version`, `effort_sent`,
`effort_effective`, `output_limit` and `retry_after_ms`. A failed attempt's response fields are null. A try that
fails below the attempt limit, or ends on a budget stop, keeps its attempts on its `answer-attempts.ndjson` line. The
arm's `receipt.json` counts truncated answers in `counts.truncated`. Other readers' records are unchanged, and the
Q1 file agent writes `receipts.ndjson` as above.

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
bun test test/eval/memory-qa-usage.test.ts test/eval/openai-compatible.test.ts test/eval/memory-qa-particle.test.ts
bun test test/eval/cat40-particle-loop.test.ts test/eval/cat40-particle-ladder.test.ts test/eval/file-agent.test.ts
bun test test/eval/q1-cell.test.ts
```

The first file serves recorded synthetic Anthropic and OpenAI responses through a mocked fetch and checks that both
conventions give the same totals, that retries and failures leave one record per attempt, that `think` rows
carry `think`'s own usage and the reference date `think` reports, that a 5,000-character answer survives whole, and
that the normalizer reproduces the committed W10 means (22,167 for W10a; 22,077 for Opus 5.5, 13,695 for
`gpt-6.1-sol` and 14,458 for `gpt-5.4` in W10b). The second file checks Particle's convention, the `request` and
`response_meta` fields, the null fields of a failed attempt and the empty answer of a truncated response, against a
mocked fetch and the keyless fake provider. The third checks the memory-qa particle route: a 429, 429, 200 sequence
leaves three records with what each sent and the first one's wait, a particle judge's records carry the same fields,
and a credit 402 leaves its record and stops the run. The second command checks the Cat 40 loop lanes.
`cat40-particle-loop` checks one record per attempt for every provider, with its turn and request fields.
`cat40-particle-ladder` runs the ladder against a fake Particle server on loopback and checks `attempts.ndjson` and
its rerun numbering. `file-agent` checks `receipts.ndjson`, keyed by answer id, and the particle full-context
reading's attempts and truncation. The third command runs Q1's packed and full-context cells with particle-1 through
the real lease proxy in front of a fake Particle, and checks each answer record's `attempts`, the truncation count and
the attempt a lease refusal leaves. It also runs a file-agent cell with particle-1, through the proxy and straight to a
fake Particle, and checks that a turn that times out leaves its question a final `reader_error`. None of these files
makes a provider call.
