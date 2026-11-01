# Changelog

This records what each gbrain-evals release changed and what its measurements meant at the time. Versions follow `VERSION` and `package.json`. Historical scores keep their original dates; later corrections do not turn them into measurements of today's code.

## [Unreleased]

### particle-1 reads Q1's packed and full-context cells through the lease proxy

- **Q1's lease proxy routes Particle** (`eval/runner/metering-proxy.ts`, unit U5 of the particle-1 plan). `particle` joins its upstreams (`https://api.particle.ai`), key variables (`PARTICLE_API_KEY`), allowed routes (`POST /v1/chat/completions`, `GET /v1/models`), output fields (`max_completion_tokens`) and request paths, read from `eval/runner/providers/openai-compatible.ts`. A cell's slot environment points `PARTICLE_BASE_URL` at `<proxy>/<slot>/particle/v1` and gives the cell a dummy `PARTICLE_API_KEY`. A campaign unit whose cell reads with particle-1 passes the real key to its VM's proxy, and `shootout-cell.ts` gives the cell `PARTICLE_BASE_URL` and a dummy key as for the other providers. A slot's restored base URLs are now unset when they were unset before, instead of becoming the string `undefined`.
- **A per-model reader cap.** particle-1 is always sent at least 16,000 output tokens, because its reasoning shares the limit, and the reader route cap is 2,048. Route caps now take a `<class>@<provider>:<model>` key that the proxy checks before the class cap. `DEFAULT_ROUTE_CAPS` gains `reader@particle:particle-1: 16000`, so the campaign manifest's `output_caps`, the VM payload and the proxy's `--route-caps` carry it. Every other reader on the same slot stays at 2,048 (a test sends Opus at 16,000 and sees it refused).
- **Packed and full-context cells read with particle-1.** `answerFullContext` builds and sends a particle reading through the provider module, one request per attempt of its 5-attempt loop, with a `prompt_cache_key` per conversation and the 16,000-token floor counted in the fit check. A 429 or 5xx waits the provider's Retry-After, capped at 120 seconds; Particle's credit 402 or the lease's own 402 is `budget_not_run`, and a context-length 400 is `does_not_fit`. `READER_WINDOWS` gains particle-1 (1,048,576 tokens, 131,072 of them output). The packed reader already reached Particle through qa-v2. A reader's output limit comes from `readerMaxTokens` in `eval/runner/q1/cell.ts`, and an arm's run config records any limit above 2,048 under `reader.max_tokens_by_reader`.
- **Receipts and truncation.** A particle reader's answer record carries `finish`, `truncated` and `attempts`: one entry per provider attempt with its status, response model, finish, reasoning tokens, weight version, effort sent and effective, output limit and Retry-After wait, failed attempts and cache hits included. A try answered again later keeps its attempts in `answer-attempts.ndjson`. An answer cut at its output limit is scored as the model's answer and never retried, and the arm's receipt counts truncated answers (`counts.truncated`). A budget stop on a packed particle reading records the failing attempt before the cell stops. Every lease-proxy budget refusal is a budget stop for a particle reader, whatever its status. A missing `PARTICLE_API_KEY` (503) and a model off the cell's allowlist (403) used to be retried as a server or client error (issue #254).
- **A timed-out particle request is not sent again by the chat client or a Q1 cell (issue #250).** qa-v2's chat client, which memory-qa's reading lane and Q1's packed reader use, sent a particle request with the provider module's 300-second deadline and retried a timeout up to five times, and Particle may bill each attempt. Each attempt now gets the metering proxies' 900-second upstream deadline (`UPSTREAM_DEADLINE_MS`), and a timeout ends the loop with its receipt. Q1's full-context particle reading does the same. A timeout is a client-side `TimeoutError` or `AbortError`, or a 504 (`compatTimedOut` in `eval/runner/providers/openai-compatible.ts`). The lease proxy answers its own upstream deadline with a 504 instead of a 502. It also stops sending a particle request again when the connection was reset or closed before the response headers arrived, because Particle may have billed the generation by then. It answers that with a 504 too, and resends a particle request only when the connection was refused. A Q1 cell records a timed-out packed or full-context particle reading as a final `reader_error` with its attempt, so the cell's in-process retry pass never asks that question again. Some paths still resend. The Q1 file agent's loop sends a particle turn with Bun's 300-second fetch timeout and its cell asks again (issue #253), so an agent arm with a particle reader is refused behind the lease proxy. A reset after the response headers reaches the client as a 500 that it retries (issue #270). A memory-qa rerun asks a timed-out question again, because `reader_error` is not final there. Through a proxy that makes a request wait for admission, the client's deadline can also run out first, so the answer is lost while the proxy still pays for it (issue #271). The workload route got the same fix in `c1de346a`.
- **particle-1's tokenizer is calibrated.** A new calibration cell (`eval/runner/q1/calibration-cell.ts`) reads one dev smoke cell's packed arm with one reader and no frontier judges through a lease proxy in the same process, and writes the reader's factor and largest per-pack error under both tiktoken encodings. Its paid run on 2026-11-01 (LoCoMo dev `conv-44`, 20 questions, $0.0862 from the proxy's usage fields) gave particle-1 a factor of 1.0488 on `o200k_base` with a largest error of 0.50%, inside the 3% bar, so `READER_TOKENIZERS['particle:particle-1']` is calibrated and the plan's tokenizer fallback is not needed. All 20 answers were scored and none was truncated. The receipts, without answer text, are in [`docs/benchmarks/2026-11-01-particle-1-calibration/`](docs/benchmarks/2026-11-01-particle-1-calibration/README.md). The cell's proxy answers only the run's own cell and control tokens. `--keyless-upstream` given without an http(s) URL after it is a usage error rather than a paid run.
- **particle-1 never judges a Q1 cell.** A particle canonical or frontier judge is refused before the cell starts, with or without the lease proxy. The refusal of particle readers behind the lease proxy (unit U2) is lifted for packed and full-context arms; an agent arm with a particle reader is still refused there until issue #253 is fixed. Memory-system cells (`run-systems.ts`) still refuse particle behind `--provider-proxy`.
- **What does not change.** Other readers' requests, answer records and run configs are unchanged: the Anthropic and OpenAI full-context bodies are pinned by sha256 from main `8ca8d2cc` (`test/eval/file-agent.test.ts`). No counted Q1 cell reads with particle-1; adding it as its own arm is the Q1 owner's amendment. `docs/scoreboard.md` now gives the judge cap as 2,048 tokens, the value the code holds; it said 1,024.
- **Campaign identity.** `eval/runner/metering-proxy.ts`, `eval/runner/q1/cell.ts`, `eval/runner/shootout-cell.ts`, `eval/runner/memory-qa` and `eval/runner/systems` are in Q1's executed tree, so the Q1 campaign hash moves, and a new campaign manifest's `output_caps` gains the per-model key.

### Workload suites count truncated answers, read Fable only in smoke runs, and the harness proxy keeps slow requests open

- **An answer cut off at its output limit is the model's answer.** It is scored as is, usually wrong. It is never treated as an error and never asked again. Every reader reply now carries its provider's `finish_reason` and `truncated` flag, for Anthropic, OpenAI and particle-1 alike. A reply is truncated when `normalizeFinish` reads its finish reason as `max_tokens` (`length`, `max_tokens` or a context-window stop). Each answer receipt and each scored row in `results.json` records both fields, and each arm and reader there gets a `truncated` count. The score log line names the count, and the published table (`report.ts`) gains a "Cut off at output limit" column. A high count means that reader's output limit is too low. A reply that carries no finish reason, and an answer receipt or cached reply written before this change, has `truncated` null (unknown), and an arm with such a row reports its count as unknown (`n/a` in the table) rather than zero.
- **Fable is out of the counted frontier sweep.** CLAUDE.md allows Fable only in smoke tests, but the workload suites listed `anthropic:claude-fable-5-1` in `frontier_sweep`, and `modelRuleViolations` required a Fable model there. The sweep is now Opus 5.5, gpt-6-astra, Sonnet 5.5 and particle-1, and the rule requires an Opus, a GPT and a Sonnet model. Fable stays available as `MODEL_CONFIG.smoke_only_readers`, taken from `SMOKE_ONLY_READERS` in `eval/runner/systems/baselines.ts`. `modelRuleViolations` flags a smoke-only reader used as the fixed reader, in the sweep, as an alternate reader or as the judge. `bench.ts --models` refuses one unless the run is a labeled smoke run (`--smoke N`), and only a scoring run with `--smoke N` scores its answers. `--smoke` takes only a positive whole number, so `--smoke 0` can no longer score smoke-only answers into a counted directory, and `--models` takes only the readers `score` reads (`frontier_sweep` and `alternate_readers`, plus `smoke_only_readers` in a smoke run), so a sweep never pays for answers no score counts. The dry-run plan now counts three sweep readers instead of four.
- **The harness metering proxy no longer closes a request it is still answering.** It ran `Bun.serve` with `idleTimeout: 255` and now uses 0, as the lease proxy does. On Bun 1.4.4 that limit cuts only a request without a body. A GET held for 270 s was reset at 256 s, while a POST with a JSON body held for 270 s returned normally. Every paid chat request is a POST with a body, so paid requests were never cut and resent. Slow GETs, such as model listings, were.
- **particle-1 answered the workload suites' live question on 2026-11-01** (unit U6, under its own $0.50 ledger run, from main `4086e616`). It read the passing-details question "What's the code to open my bike lock?" through the harness proxy at effort `high` with a 16,000-token limit and answered correctly in 1.1 s. The ledger's settled cost, $0.0002395 for a one-word preflight and the question, matches the proxy request log exactly. Every bar 2 field was logged. Particle's response carried no `metadata` and no `system_fingerprint`, so `weight_version` is null on a successful answer.

### particle-1 reads in memory-qa: `--reader particle:particle-1`, a receipt per attempt and a budget stop

- **`bun eval/runner/memory-qa/run.ts --reader particle:particle-1` now reaches Particle** (unit U2 of the particle-1 plan). The reading lane's chat client (`eval/runner/memory-qa/qa-v2.ts`) builds and sends requests for any provider in `eval/runner/providers/openai-compatible.ts` through that module, once per attempt of its existing 5-attempt loop: `reasoning_effort` (default `high`), at least 16,000 output tokens and no `temperature`. A Retry-After from the provider replaces the backoff before the next attempt, capped at 120 seconds, a 200 without an answer is retried like Particle's other server errors, and a call whose fifth attempt fails now throws at once instead of waiting first. For these providers only a budget stop (`BudgetExceededError`) or an error the module classes as not retryable ends the loop early, so a 429 whose body mentions a budget is retried. `--reader-effort` sets the reading lane's reader effort and needs `--qa reader`. An effort the reader's provider does not list (Anthropic `low`, `medium`, `high`, `xhigh`, `max`; OpenAI `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; Particle its own), or any effort for an OpenAI model that is not a reasoning model, is refused before anything runs, so a typo no longer turns every question into a 400; a listed value can still be one a given model does not take. A memory-system cell refuses the flag. A missing `PARTICLE_API_KEY` for any reader or judge the run calls, or an effort Particle does not list, is refused before anything runs, memory-system cells included. A memory-system cell behind `--provider-proxy` refuses a particle reader or judge, because that lane points only OpenAI, Anthropic and Voyage at the proxy and those requests would spend outside the lease. `run.ts` now uses qa-v2's client and judges through qa-v2's `judgeResponse`, which sends qa.ts's prompts and output limit; `qa.ts` keeps the bytes the budgeted-delivery H1 decision pins.
- **Each attempt's receipt records what was sent and what answered.** particle reader and judge receipts carry `request` (effort sent and effective, output limit) and `response_meta` (Particle's metadata, service tier, fingerprint, truncation), and a failed attempt answered with a Retry-After carries the new optional `retry_after_ms`. A particle cache key adds the effort and output limit sent. Memory-system cells (`run-systems.ts`) now write `qa_receipts` for their reader calls.
- **A budget stop ends the run.** When a reader, think or judge call ends on the ledger's cap or Particle's credit 402, the question's row is written with its receipts, no later question or conversation runs, the receipt's summary says `stopped: budget`, and the run reads `partial`. Before, the reading lane recorded the stop as an answer error (`qa_error`), went on to the next question, and a rerun counted those questions as done; now the stopped question is an error row that a rerun retries, and the receipt's status, counts and QA summary read each question's latest row, so a rerun that answers it reads `complete` only when no question is left and counts that question once. gbrain think reports a refused request as an `llm_error` answer instead of throwing, so a think call after which the ledger has refused a request is a budget stop too; before, its empty answer was judged and scored 0, in both lanes. Memory-system cells mark the stopped question `budget_not_run`, which a rerun retries while the question has used fewer than its three attempts.
- **What changes for other models.** OpenAI and Anthropic request bodies and cache keys stay as they were, pinned by test. One behavior change: Claude 5 verdict calls in `run.ts` (judge calls under 1,024 output tokens) are now sent 2,000 tokens, the floor qa-v2 already gives Q1, so those calls get new cache keys. Receipts list `models_not_run`, empty here because both primary models have a route.
- **Campaign identity.** `eval/runner/memory-qa` and `eval/runner/q1/cell.ts` are in Q1's executed tree (`EXECUTES` in `eval/runner/q1/cell.ts`), so the Q1 campaign hash moves: a Q1-style campaign frozen before this change resumes only under a new campaign identity. A new test in `test/eval/q1-campaign.test.ts` checks that a file added under `eval/runner/providers`, which 0.10.139 put in that tree, changes the hash and refuses resume under the earlier freeze.

## [0.10.139] - 2026-10-31

### gbrain pin moves to v0.60.531.0, with four new read defaults held for comparable arms

- **The product pin moves from `7a6bdd357` (v0.60.454.0) to master `3ec766c40` (v0.60.531.0)**, 1,138 commits and 77 releases later; the old pin is in the new one's history. `gbrain-cues` and `gbrain-reader` stay where they are. gbrain's own dependency list did not change, so `bun.lock` changes only the `gbrain` entry. gbrain's Particle provider (gbrain #8324) is not in this release; a later pin picks it up.
- **The memory-qa harness holds three new gbrain defaults at their old values.** `HELD_GBRAIN_DEFAULTS` in `eval/runner/gbrain-under-test.ts` sets `search.query_facts_block=false` (v0.60.491.0 put up to 40 dated saved facts at the head of a `query` with a token budget), `search.saved_facts_supersede=false` (v0.60.493.0 puts a newer correction ahead of the saved fact it corrects) and `search.remote_page_cap=0` (v0.60.506.0 keeps at most 3 meaning-only pages in a remote `search` or `query` that names no `limit`). They join `DEFAULT_PINS` in `memory-qa/run.ts` and `memory-qa/run-systems.ts`, so receipts record them under `search_pins`, and the `gbrain-query` system's settings, whose capability record lists the values it wrote to the brain as `held_defaults` and names both changes in `deviations_from_vendor_code`. A `--pin` or `--config` still overrides each one, on `gbrain-query` too. The keyless memory-qa golden (`test/eval/fixtures/memory-qa-golden.json`) gains the three keys under `search_pins`; its rows and reader prompt hashes are unchanged. Tests check the three values, both entry points' default pins, the settings a `gbrain-query` brain opens with and its capability record. The legacy and shootout paths call `hybridSearch`, which none of the four changes reach.
- **Quote-fenced chat text (v0.60.507.0, v0.60.521.0) has no switch, so the `gbrain-query` connector unwraps it.** `query` and `assemble_evidence` now return a conversation page's text inside a marked quote fence. The connector hands on the stored text through gbrain's own `unquoteTranscriptText`, so a frozen list re-resolves against the stored chunks and readers get the text they got before. Without it, the E2 test's re-resolution refused all 25 frozen chunks as changed at the new pin. Delivered match spans move back onto the unwrapped text, and each delivery record counts those blocks as `quoted_blocks`. Two parts cannot be undone. A token budget counts the fence, so a budgeted delivery can carry slightly less text, and a tool-call block gbrain summarized stays summarized (a frozen row's text then differs from its stored chunk, which the re-resolution check refuses). A build that fences but has no `unquoteTranscriptText` (v0.60.507.0 to v0.60.520.0) is refused.
- **What still follows the product.** Arms that measure gbrain's own defaults take all four as shipped: `gbrain-shootout`, the gbrain-defaults container, the Cat 40 MCP arm and the agent tool bridges of Cats 8, 9 and 37 to 39. A Cat 40 rerun that wants comparable cells passes the three keys with `--gbrain-config` and records that in its preregistration. `--qa think` over conversation pages (`--facts conversation`) gets fenced evidence inside gbrain's `think`, where the harness cannot reach.
- **VM Bun.** gbrain v0.60.531.0's CLI exits on Bun below 1.4.4, so `eval/systems/bootstrap.sh` installs Bun 1.4.4 by default (was 1.4.2); the bootstrap test that 0.10.138's toolchain entry added caught it. The Cat 41 image and the harness-provider VM scripts install Bun for a gbrain ref they choose and are unchanged.
- **The documentation verifier checks the product pin.** `scripts/verify-documentation-refresh.py` checked only the `gbrain-cues` pin, so hubs drifted: `eval/README.md` and `eval/CONTRIBUTING.md` named `77cf8e111` (v0.60.169.0) through three re-pins until 0.10.138 fixed them by hand, and `docs/retrieval-lessons.md` still does. It now checks `bun.lock` and each hub sentence that names the product pin (README, `docs/README.md`, `docs/settings.md`, `docs/comparison-systems.md`, `docs/retrieval-lessons.md`, `eval/README.md`, `eval/CONTRIBUTING.md`) against `package.json`, and that they name one release, the one the installed gbrain reports. Run on main's documentation at `96e2f618` it names exactly that page. `test/eval/verify-documentation-refresh.test.ts` covers it, and the hubs name the new pin.
- `@types/bun` stays 1.4.2: at the new pin `src/core/cli-preflight.ts` still stores `signalCode` in a `string | null`, and bun-types 1.4.4 fails the typecheck there with TS2322.
- **Campaign identity.** `package.json`, `bun.lock`, `eval/runner/memory-qa`, `eval/runner/systems`, `eval/runner/gbrain-under-test.ts` and `eval/systems/bootstrap.sh` are in the F6 campaign's executed tree, so this release counts for F6 only under a new campaign identity. No file in the Cat 40 Hard freeze changed.

### particle-1 runs in Cat 40 and the Q1 file agent, and Hard freeze drift needs a dated record

- **Cat 40's agent loop runs particle-1** (`eval/runner/cat40/loop.ts`, unit U8 of the particle-1 plan). `particleLoop` sends Chat Completions with tools, `tool_choice: auto`, one `prompt_cache_key` per conversation, `reasoning_effort` `high` unless a caller passes one, and a 16,000-token output limit. It builds and parses requests with the provider module and sends them through the loop's own retries. A Particle retry waits at least the Retry-After it was sent, capped at 120 seconds, and never less than the backoff. An empty Particle balance stops the run with the budget stop after the failing attempt is recorded. `runAgentText` refuses particle-1, so it never judges. The claude-opus-5-5 and gpt-6.1-sol request bodies and retry timing are byte-identical to before (`test/eval/cat40-particle-loop.test.ts`).
- **Every provider attempt leaves a usage receipt.** The v1 ladder writes each attempt of a cell to `cells/<cell>/attempts.ndjson`, for every provider, including retries, network failures and bodies that are not JSON. The Q1 file agent writes `receipts.ndjson`, keyed by answer id and turn. A rerun numbers its attempts on from the earlier ones.
- **The Q1 file agent reads with `particle:particle-1`.** A budget stop ends the question as `budget_not_run` and stops the cell's later work. `eval/runner/providers` is now in Q1's executed tree, so it enters the campaign hash.
- **particle-1 runs on v1 ladder worlds only, and it never judges.** A v1 run with particle-1 must pass `--judge`, because the v1 default judge is gpt-5.4-mini, which the model rules never run. `--judge particle-1` is refused. A Hard world refuses particle-1, because amendment A6 keeps the Hard model list and the Hard freeze does not cover the particle transport. A Q1 cell refuses a particle reader through `--provider-proxy` until the lease proxy has a particle route.
- **Behavior change: `--accept-freeze-drift` accepts only recorded drift.** Before, the flag let a Cat 40 Hard run start over any change to a frozen file. Now the current hash of each drifted file must appear in `docs/benchmarks/cat40-hard/accepted-drift.json`, with its date and a note that is also in `calibration.md`. An unlisted drift stops the run with `HARD_FREEZE_DRIFT`. The record starts with the five files already drifted at main and with `loop.ts` after this change. Garry approved this as decision E1 of the particle-1 plan. The check runs when a Hard run starts, never in CI.
- **Checked live on 2026-11-01** under a $2 budget ledger. The A01 oracle smoke got a 200 with `prompt_cache_key` set and passed. The operability run (model-ladder-v1, 10 tasks, oracle and fs arms, particle-1, `--judge gpt-6.1-sol`) found no unparseable tool calls in 153 turns and passed 10 of 10 oracle tasks. Its 153 particle-1 requests read 1,338,089 input tokens, 436,224 of them from cache (32.6%), and the run cost $0.369 in all.
- **Campaign identity.** `loop.ts` and `cat40-model-ladder.ts` changed, so Cat 40 arms recorded before this change cannot be reused after it.

### particle-1 in the workload suites and the harness metering proxy

- **The workload suites can read with particle-1** (unit U6 of the particle-1 plan). `particle:particle-1` joins the frontier sweep in `eval/workload-suites/run-config.ts` as its own `particle` family and is refused as the judge. `bench-infra.ts` sends it through the harness metering proxy with `compatRequest` at effort `high` and an output limit of at least its 16,000-token floor (`maxTokensFor` in `bench.ts`), and writes one usage receipt per attempt to `attempts.ndjson`, carrying the request's settings and the response's identity. A 429 or 5xx waits its Retry-After, capped at 120 s. Particle's credit 402 writes its receipt and then stops every later reader and judge call, and a proxy budget refusal stays a refusal. The model cache keys a particle answer on the effort it was read at. `MODEL_CONFIG.models_not_run` lists any primary model the workload suites have no route for; today that list is empty. OpenAI and Anthropic reader requests are byte for byte what they were.
- **The harness metering proxy serves Particle.** Its `particle` row comes from `COMPAT_PROVIDERS`: prefix `/particle`, upstream `https://api.particle.ai`, key `PARTICLE_API_KEY`, and children get `PARTICLE_BASE_URL=<proxy>/particle/v1`. Every request-log line records what served it (`response_model`, `reasoning_tokens` and `response_meta`), read from a JSON body, an event stream or a Gemini chunk array. `readRequestLog` joins each line's request side from its stored body. That side holds the effort sent, the level it runs at with the table's source and date, and the output-limit field and value. Bar 2 of the particle-1 plan can be checked for every particle request from that log. The stub upstream answers `/particle/v1/chat/completions` the way Particle does.
- **Behavior change: long answers, unwritable receipts and the worker pool.** The harness proxy's upstream calls and `compatSend` now take the lease proxy's 900-second deadline instead of Bun's 300-second fetch timeout, and a particle request that times out is not sent again. A receipt that cannot be written stops the call instead of reading as a network failure that resends the paid request. When one call in the sweep's worker pool fails, the pool lets the calls already in flight finish before it raises that error.
- **Not run against Particle yet.** The unit's one live workload question waits for its paid window. Everything above is checked keylessly against the fake provider and the stub upstream.

### Current Claude models work in the shared judge and the other Claude call sites

- **claude-opus-5-5, claude-sonnet-5-5 and claude-haiku-5-5 no longer get HTTP 400 from the shared judge (`eval/runner/judge.ts`), the Cat 5, 14, 15, 29 and 35 judges, the Cat 15 extractor, the Cat 25 think client or the Cat 8/9 agent.** Those requests sent `temperature: 0`, which all three reject, or a forced `tool_choice`, which Opus 5.5 and Sonnet 5.5 reject. Each request now goes through `fitAnthropicRequest` in `eval/runner/anthropic-request.ts`. A Claude 5-family model (an id naming generation 5 or later, provider-prefixed ids such as `anthropic.claude-sonnet-5-5-v1:0` included; one predicate, `isClaude5Family`, decides it for every field) gets no temperature and `tool_choice: auto` with a message telling it to call the tool, and a runner's own default output limit rises to at least 4,096 tokens, because these models think inside that limit (at Cat 14's 700 tokens, Opus 5.5 spent them all thinking). The Cat 15 extractor's limit, gbrain's 2,048-token default, rises the same way; gbrain's own extractor retries at 4,096. A limit the caller passes is sent as given. No category's default model changes.
- **Older models get the same request bytes as before**, so their receipts stay comparable. A Claude 5 judge is a new judge identity: do not pool its verdicts with Haiku 4.5 verdicts.
- **Receipts record what was sent.** Each shared-judge result carries `temperature_sent` (null when omitted) and `tool_choice_sent` (`tool` or `auto`), and the Cat 5, 8, 9, 14, 15, 25, 29 and 35 receipts record them per role, the temperature as a number or null. A receipt's `judge.temperature` is the temperature sent, null when none was; the receipt type and schema now allow null.
- **The shared judge, the Cat 5, 29 and 35 judges and the Cat 8/9 agent price each model from the budget ledger's table** (`chatPrice`), cache reads and writes included, instead of fixed Haiku 4.5 or Sonnet 4.6 rates, and refuse a model with no price before they send anything. An OpenAI judge's cached input is priced at its cache rate, as the ledger prices it, because the OpenAI shim now keeps `input_tokens_details`. A Cat 5 run with an unpriced model now fails once before any claim instead of once per claim, and Cat 5 receipt input tokens include cache reads and writes, as its cost does.
- **Behavior change: a live Cat 15 or Cat 25 run needs `--paid --budget-run-id <id>`** naming an open budget-ledger run, and the ledger caps and records its spend; before, both runners spent with no ledger at all. `all.ts` passes both flags to them (the registry's `paidFlags`), and their dry runs need neither. Cat 14 and Cat 29 now refuse a live run with no ledger cap: they need a run id (`--budget-run-id`, or the `BRAINBENCH_BUDGET_RUN_ID` that `all.ts` sets) or `--budget-usd <dollars>`. Before, a run with neither spent uncapped, and a run id alone was ignored, so under `all.ts` they ran unguarded. `all.ts` also hands every child the ledger it checked the run in (`BRAINBENCH_BUDGET_LEDGER`), so a sweep given `--budget-ledger <path>` no longer has its children look for the run in the default ledger. A Cat 15 or Cat 25 run refused under `--paid --budget-run-id` (a missing, closed or spent run) writes an error receipt, not a skip that `BRAINBENCH_ALLOW_SKIP` would pass. A Cat 14, 15, 25 or 29 run whose ledger refuses a request partway stops and writes an error receipt instead of a completed one, and Cat 29 no longer judges an answer whose think request the ledger refused.
- **A Cat 15 extractor reply cut off at its token limit gets gbrain's one retry at 4,096 tokens** (`PROPOSE_TAKES_RETRY_MAX_TOKENS`), as gbrain's extractor does, and a reply still cut off scores as a miss (F1 0, `extraction_truncated`), because gbrain fails that page. Before, a cut-off reply scored as an unparseable miss with no retry. The receipt records the limits sent (`max_tokens_sent`). This retry is the one change to an older model's requests, and it happens only after a reply was cut off.
- **Checked live on 2026-10-31** under a scratch budget ledger: the shared judge passed on its first attempt with claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5 and claude-haiku-4-5-20251001, and its reported cost matched the ledger's settled cost; every changed call site answered with all four models; one Cat 14 probe scored with an Opus 5.5 judge. A $0 test, `test/eval/anthropic-request.test.ts`, holds the contract.
- **Campaign identity.** `eval/runner/openai-judge-shim.ts` and `eval/runner/receipt.ts` are in the F6 campaign's executed tree. This change counts for F6, or any Q1-style campaign frozen before it, only under a new campaign identity. No file in the Cat 40 Hard freeze changed.

### The post hoc LongMemEval-S facts-block check and the shipped-build equivalence check reach main

- **Removing the facts block alone closes none of the LongMemEval-S gap between gbrain's combined lane and its pages-only lane.** An exploratory, post hoc rerun of wave 1's combined shard 1 (100 questions, October 10, gbrain freeze build `d7467d1cf`) set `facts_tokens` to 0 and left the page budget at 6,300 tokens. Under one joint blinded re-judge it answered 71 correct, the same 71 as the combined lane with the block, against 80 for the pages-only lane and 83 for the comparator. Dropping the block changed the verdict on 8 questions: 4 gained and 4 lost. The check decides nothing, and the planned same-store cell at 1,800 fact tokens was refused by its ledger cap. Spend was $9.39 for the cell and $0.25 for the re-judge ([report](docs/benchmarks/2026-10-09-memory-proof-wave-sealed-results.md#descriptive-rows-longmemeval-s-and-locomo10), receipts under `docs/benchmarks/2026-10-10-memory-proof-wave-lme-facts0/`). Wave 2's step 0 later traced the gap to search mode instead.
- **The sealed-results report now carries the equivalence check of the build that shipped as gbrain#6066** ([section](docs/benchmarks/2026-10-09-memory-proof-wave-sealed-results.md#equivalence-of-the-shipped-build)). On the public BEAM dev conversations, retrieval at `d7d7686de` stays inside the same-build noise of `d7467d1cf` at 100k, 500k and 1M. End to end, results are within noise except that re-ingesting extracts a new fact set, so the combined rows also measure a new extraction. Its receipts were already on main; the README's equivalence claim now links this section.
- Both sections and the `facts_tokens` 0 receipts were written on October 10 on branch `capy/mpw-harness`, which never had a pull request. The receipts land byte for byte from that branch. The sections land as written with four edits. They point to wave 2's step 0, they say "the verdict on 8 questions" where the facts-block check said "8 answers", they give the raw stores' gate-flag counts beside the combined ones, and they quote the `equivalence_report.py` command on a fresh copy of the directory, because the script rewrites `report.json` in place and cannot regenerate its `extract_stale` fields. `docs/receipts-manifest.json` gains six entries that pin their hashes and quoted values, and the re-judge ledger status, which records a Capy scratch path, joins `test/eval/fixtures/historical-capy-local-paths.json`. Nothing was rerun.

### Score another system's Cat 35 documents beside gbrain's lanes

- **You can score a folder of another system's Markdown notes with Cat 35's judges.** Run the Cat 35 runner with `--external-lane NAME --external-dir DIR`; add `--lanes none` to score only the folder. The lane is judged the way gbrain's dream lane is, on recall with the evidence check, claim grounding, distractor leakage, the usability checklist, attribution hazards and quote fidelity. Read its recall next to the verbatim lane from the same run, which is the judge's ceiling. [eval/CONTRIBUTING.md](eval/CONTRIBUTING.md#score-another-systems-cat-35-documents) explains the folder layout, the commands and the limits.
- **The receipt records what was scored.** Its `external_lane` block holds the lane name, the folder's real path, each file's bytes, sha256 and gradable claim count, the conversations with no file, and a note that the harness has no record of how the documents were made. A run with an external lane is never publishable as the benchmark. The lane list, prior-run deltas, blended usability, judge-failure gate and WS0 counters cover gbrain's built-in lanes only, and the runner judges every built-in lane first, so the external lane's spend or provider errors cannot change them. The external lane has its own `external_judge_failed_rate` gate, which counts toward the exit code.
- **The runner treats the folder as untrusted.** Before any provider call it refuses the run on a symlink, a special file, a hard link, a file over 64 KiB or 80 claims, invalid UTF-8, a document that contains an answer-key id, or a folder swapped for another after its path was resolved. Judge prompts label the documents `external`, never with the contributor's lane name.
- The feature is rebuilt on main from Khaled Aly's (@khalloud) design in [#32](https://github.com/garrytan/gbrain-evals/pull/32).

### particle-1: a provider module, receipts that record how each answer was made, a freshness check and a weight canary

- **particle-1 requests are built, sent and classified in one place** (`eval/runner/providers/openai-compatible.ts`, unit U1 of the particle-1 plan). Particle's row reads its base URL from `PARTICLE_BASE_URL` (default `https://api.particle.ai/v1`) and its key from `PARTICLE_API_KEY`, and lists particle-1 with a 1,048,576-token context, a 131,072-token output ceiling, default effort `high` and a 16,000-token output floor. Every request sends `reasoning_effort` and an output limit and never `temperature` or `seed`. A 402 without either metering proxy's marker is Particle credit exhaustion and ends the run through each runner's existing budget stop. A request to a host the budget ledger cannot price goes only to a loopback host (a metering proxy slot or the keyless fake); the ledger prices `api.particle.ai` and `us.api.particle.ai` since #207. No runner calls particle-1 yet; the memory-qa, workload-suite and Cat 40 units wire it in.
- **Usage receipts record the request's settings and the response's identity.** `UsageReceipt` gains optional `request` (the effort sent and the level it runs at, the output-limit field and value, temperature and seed) and `response_meta` (Particle's raw `metadata`, weight version, service tier, system fingerprint, and whether the tier was non-default or the answer was cut off). `usageSourceOf` reads particle models with the OpenAI chat convention instead of throwing. The schema stays `usage-receipt/v1` ([docs/usage-receipt.md](docs/usage-receipt.md)).
- **`bun scripts/model-freshness.ts` reads Particle's free model list.** With `PARTICLE_API_KEY` set it matches `particle-ai/particle-1` by id and service tier and checks the ledger price against the default tier. A called Particle model that is unlisted, listed with no readable price or priced differently in the ledger blocks the run; a newer Particle model or a changed particle-1 listing warns. `particle:particle-1` joins the default model set.
- **A paid, opt-in weight canary, as code and keyless tests.** `bun scripts/particle-canary.ts --paid --budget-run-id <id> --out <dir>` sends 12 fixed prompts at effort `none` with temperature 0, a fixed seed and log probabilities, output capped at 64 tokens, and writes answer hashes, log probabilities and one receipt per attempt. `--compare` reports changed answers, changed serving identity and the mean log-probability move, and refuses a baseline of another model, sampling or endpoint before anything is sent. It has not run against Particle; its warning thresholds come from back-to-back noise pairs measured before its first counted use.
- **The keyless fake provider serves Particle** under `/particle/v1/`: response model, metadata, reasoning tokens, an empty answer when reasoning fills the output limit, tool calls, log probabilities, a two-tier model list and 405 on `/responses`, with queued 429, 402 and context-length faults.
- **Campaign identity.** `eval/runner/usage-receipt.ts` and `eval/systems/_shim/` are in the executed tree that Q1-style campaigns hash (`eval/runner/q1/cell.ts`), so this counts for F6, or any Q1-style campaign frozen before it, only under a new campaign identity.

## [0.10.138] - 2026-10-31

### Shared agents (on_behalf_of): search cost and recall

- **gbrain PR #7852 lets a shared agent read as the audience its harness names, and calls without an audience cost nothing measurable** ([report](docs/benchmarks/2026-10-28-shared-agent-audience.md)). Measured at `e5bee20d` against its parent `9167c248` on one Ubicloud VM, 8 interleaved runs per side, with raw JSON committed: every cell is within plus or minus 1% at 0%, 20% and 80% restricted. #7852 ships in train M (gbrain PR #8134, head `244f30dd`), where the train M attribution run from 0.10.137 puts the train within -1.3% to +0.3% of folder rules (A2) on a brain with no restrictions.
- **An audience costs 0.1 to 2.2 ms over the member's own token and keeps that member's recall.** A one-member audience adds under 0.8 ms. A two-member audience adds up to 1.3 ms at `e5bee20d` and up to 2.2 ms (keyword search) at the train M head. hit@10 is 1.0 in every audience cell on train M. The measured search code is the same at both heads, apart from a path under the operator privacy hatch that the bench never turns on.

### The budget ledger meters Particle and refuses hosts it cannot price

- **A paid run can no longer spend through a host the ledger doesn't know.** While a paid-request guard is installed, a request to any HTTP host that is neither in the ledger's paid-host table nor loopback is refused before it is sent, and the runner stops scheduling paid work. Before, such a host counted as free, so an OpenAI-compatible vendor reached through `OPENAI_BASE_URL` spent outside the cap and left no ledger record. A live particle-1 memory-qa smoke on 2026-10-31 recorded its Anthropic judge request and not the Particle reader call. Loopback hosts (the metering proxies, local fakes and shims, at `localhost`, `127.0.0.0/8`, `[::1]`, `0.0.0.0` or an IPv4-mapped `127.x` address) and local files pass as before. A guarded request no longer follows redirects, so an admitted host cannot forward it to one the ledger cannot price; batch status and result reads still follow them.
- **particle-1 is priced.** `api.particle.ai` and `us.api.particle.ai` are paid hosts for provider `particle`, and `particle:particle-1` lists at $0.25 input, $0.03 cached input and $1.00 output per million tokens (docs.particle.ai, checked 2026-10-31). Requests settle from OpenAI chat usage, with reasoning tokens counted inside `completion_tokens`. A request that names no output limit reserves Particle's 32,000-token default, and a dated model id now takes its family's output cap as it already took its price. A request that turns on Particle's hosted web search is refused, because each search bills $0.0025 outside usage. Off-peak calls bill at half price and settle here at the peak rate, so the ledger overstates them.

### memory-qa `--qa think` answers relative dates from the question's day

- `gbrain think` now gets a `referenceDate`: the question date, else the conversation's latest session date (LoCoMo and BEAM questions carry none). Before, "last month" in a LongMemEval question resolved against the day of the run. Each row records the date think reports it answered against as `qa_reference_date`; a gbrain build older than 0.60.88 ignores `referenceDate` and reports none, so its rows carry no date. This covers `run.ts`'s own think lane; `--system gbrain --qa think` in `run-systems.ts` still passes no date (#210). No published report on main used `--qa think`, so no committed number changes.
- `eval/runner/budget-ledger.ts` and `eval/runner/memory-qa/run.ts` are in the F6 campaign's frozen tree. These changes land on main only and count for F6 only under a new campaign identity.

### Tests and receipts

- `test/eval/q1-raise-lease.test.ts` covers a raised lease that finished and is then abandoned. It is charged its raised reservation, or closed at $0 only when its launch log shows the cell command never started (#196, #197).
- `rescore-may-2026-08-31.json` names the committed copy of its source rows instead of the gitignored path the aggregator read, and its manifest entry is re-hashed. The manifest entry for `judge-calibration-2026-08-25.json` now says its judge, `claude-sonnet-4-6`, is a movable alias. Both were leftovers of #26.

### Toolchain: Bun 1.4.4, a typecheck that fits in memory, two CI flakes fixed

- **`bun run typecheck` passes without a hand-set heap limit.** The program needs about 4.4 GB of heap, more than Node's default limit, so the script died of heap exhaustion (exit 134 after 1:54 at a 4.4 GB peak, measured at `e9bda629`). The script now raises the limit itself (`NODE_OPTIONS=--max-old-space-size=8192`); with it the run peaks near 4.9 GB of memory, so it still needs a machine with more than about 5 GB of RAM. CI used to raise it in its own step environment, which hid the failure; CI now runs the same script, and `test/eval/ci-workflow.test.ts` checks that it does and that the script keeps the limit and both programs.
- **CI runs Bun 1.4.4 in every job**, and `package.json` declares `"engines": { "bun": ">=1.4.4" }`. Bun 1.4.2 is below gbrain's `SECURE_BUN_VERSION` (a Brotli decoder CVE) and below the minimum that newer gbrain CLIs accept, so this comes before the next gbrain pin bump. A test checks that every CI job installs the version `engines` names, and the scoreboard's `doctor` now checks the launching host's Bun against `engines` and offers to install that version (it accepted any 1.4.x and offered 1.4.2). Doctor refuses an `engines.bun` that is not of the form `>=X.Y.Z`, the form whose version it installs, and the CI test checks that form. `@types/bun` stays at 1.4.2: version 1.4.4 types a subprocess's `signalCode` as a signal name or a number, and gbrain's `src/core/cli-preflight.ts` (at the pin and at master `922ba1a9`) stores it in a `string | null`, which the typecheck of gbrain's sources rejects. It moves once gbrain accepts the wider type. The VM bootstrap scripts and the Cat 41 image keep their recorded Bun 1.4.2: each is part of a campaign's measured setup, and Bun 1.4.2 still installs this lockfile. A new test checks that the Bun `eval/systems/bootstrap.sh` installs by default meets the pinned gbrain CLI's `MINIMUM_BUN_VERSION`, so a gbrain bump that raises that floor fails CI instead of a paid VM.
- **Two timing failures in CI's `tests (3)` are fixed at their causes**, with no assertion changed in either test file.
  - `test/eval/scoreboard-cli.test.ts`: doctor checks Docker with `docker info`. On a cold daemon that took more than 5 seconds on a CI runner (2026-10-28, `1c66e565`), so tests that never need Docker hit Bun's 5-second test timeout, and one then read the killed child's empty output. Doctor now checks Docker in the environment it is given, like its other checks, and the test puts a `docker` that always fails first on that PATH. With a `docker` that sleeps 8 seconds on the PATH, 13 of the file's 20 tests failed before this change and none after.
  - `test/eval/q1-campaign.test.ts`: the VM-side tests picked a random port from 24000 to 32999, which overlaps Linux's range for outgoing connections. On 2026-10-29 (`d58b4e33`) port 32890 was taken, the metering proxy exited at once, and `runRemote` kept polling for 10 seconds before failing. These tests and `q1-custody-launch.test.ts` now take a port the operating system reports free. `runRemote` now waits until the proxy's status route answers for this lease with the sha256 of the control token this launch gave it, and fails as soon as the proxy exits or is killed, naming its exit code or signal; each status request gives up after a second, so a listener that never answers cannot hold the launch. Before, a different server already answering on the port passed the check and received the cell's traffic, and so would a proxy left over from an earlier launch of the same lease; new tests hold the port with each of those, and with a listener that never answers, and check that the launch fails and the cell never runs. The metering proxy's status route now carries that hash as `control_sha256`.
- **Campaign identity.** `package.json`, `eval/runner/shootout-cell.ts` and `eval/runner/metering-proxy.ts` are in the F6 campaign's executed tree (`bun.lock` is unchanged). This release counts for F6, or any Q1-style campaign frozen before it, only under a new campaign identity. No file in the Cat 40 Hard freeze changed.

## [0.10.137] - 2026-10-31

### Per-member read access: search cost on a brain with no restrictions

- **gbrain's per-member read access, as it ships in train M (gbrain PR #8134: #7812 readers, #7842 folder rules, #7852 shared-agent audiences), costs hybrid search 1.5 to 1.9% and keyword-only search 2.2% on a brain with no restrictions** ([report](docs/benchmarks/2026-10-28-member-read-access.md)). Measured at `244f30dd` against master `922ba1a9` on one Ubicloud VM, 10 runs per side with the order alternated, raw JSON committed. That is the median of per-run p50s, the method the 2% gate was set with; the median of each round's paired ratio gives 2.2 to 2.6% (hybrid) and 2.7 to 2.8% (keyword). GBRA-108 accepted train M on the gate method.
- **Run order shifts the result by about a point.** An 8 + 8 run with the train always first read +4.1 to +4.7% for hybrid; a run with master always first read +0.1 to +1.1%. The #7812 runs (October 28, at `f1c39714` against `8e9cd64d`: hybrid +1.5 to 1.6%, keyword +3.2 to 3.9%) always ran the branch first, so they likely read a point or so high.
- **Where the keyword cost comes from.** Ablations on #7812 put it on reading one `pages` column per matched row: replacing the predicate with `TRUE` cuts the cost to +0.5%, and dropping the index changes nothing. Removing the cost would leave a one-request window at a brain's first restricted page, so GBRA-108 accepted it with the fail-safe kept. Folder rules and shared-agent audiences add no cost of their own (a master, A1, A2, train run within 2.6 points of each other).
- **Restricted brains.** Members, and shared agents naming those members, get every page they may read (hit@10 1.0 at 20% and 80% restricted).

### The October 7 10x memory advantage plan lands on main as a superseded record

- **Eleven reports and preregistrations on main cite a plan that main didn't have.** Three reports and eight
  preregistrations from the plan's waves 0 to 5 name `docs/plans/2026-10-07-10x-memory-advantage/PLAN.md`, the branch
  `capy/10x-memory-advantage-plan` or a link into it. The plan lived only on that branch, whose pull request, #97, was
  closed unmerged on 2026-10-29. The folder (the plan, its five audits, six reviews and the eng test plan) now lands at
  that path from the branch's last commit, `2b6ff9af` (2026-10-17). Its README opens with a dated banner: the plan
  is superseded, and no wave, cap or gate runs from it. Seven files are byte for byte the branch's. In the other six,
  each of the 118 external product names is replaced by its kind id in square brackets (`[ext-extract-first]`), as
  the name guard requires outside `docs/comparison-systems.md`; nothing else changed, and the branch keeps the
  original wording.
- None of the eleven citations changes, and the branch stays. The preregistrations are frozen (each changes only by
  an amendment appended at its end, and some are bound by recorded SHA-256 hashes), and every citation already
  resolves: the path now exists on main, and the branch keeps every revision of the plan as each report read it.
- The [docs index](docs/README.md) links the folder from its route table.

## [0.10.136] - 2026-10-29

### Spring-loaded skills for gbrain GBRA-194 measured

- **The opt-in skill index `gbrain setup <harness> --skill-loading spring` writes, at gbrain branch `12669180` (not on master)** ([report](docs/benchmarks/2026-10-24-spring-loaded-skills.md), preregistration and receipts under `docs/benchmarks/2026-10-24-spring-loaded-skills/`). On 12 tasks that each need one bundled skill's procedure, real Claude Code and Codex CLIs and three models (claude-sonnet-5-5, claude-opus-5-5, gpt-6.1-sol; 360 counted trials), the index got agents to load the right skill before acting in 29 of 36 Claude Code trials, against 15 with every skill in the native skills directory and 0 with no skill text, and tied native on Codex at 22 of 24. It adds about 2,057 standing input tokens per Claude Code turn (native adds 8,579) and 1,429 per Codex turn (native 6,420). Pass rates sit near the floor in the harnesses' real permission modes in every arm, because headless Claude Code denied gbrain MCP calls and Codex's read-only sandbox refused brain writes; the labeled MCP pre-approved configuration carries the pass comparison (21 against 12 for native). The preregistered rule proposes spring as the default; that decision is gbrain's, and the build under test keeps it off. Model spend was $41.27 against a $55 cap.

## [0.10.135] - 2026-10-29

### Brain-first install block for gbrain GBRA-188 measured

- **The managed block `gbrain setup claude-code` and `gbrain setup codex` write, at gbrain `10f74dbd` (block v1)** ([report](docs/benchmarks/2026-10-24-brain-first-install-block.md), receipts under `docs/benchmarks/2026-10-24-brain-first-install-block/`). On a synthetic two-source brain with 20 tasks, real Claude Code and Codex CLIs and four models (780 counted trials), the block and a one-sentence told rule both reached the brain in 221 of 221 trials on the tasks that need it, against 82% to 97% with no instructions. The block passed 254 of 260 trials, the told rule 251 and no instructions 222, at between 4% less and 6% more spend per trial than no instructions, with no scope leak in any arm. The paraphrase result is tuned on the tasks that chose the wording, not held out. gbrain v0.60.495.0 shipped block v2 with a reworded search line and a per-turn rule; neither was measured here.

## [0.10.134] - 2026-10-29

### Short first names in full-name search: gbrain#7471 measured

- **gbrain#7472, the fix for gbrain#7471, at `ad136eeb3` against master `3f0b6eecd` (v0.60.426.0)** ([report](docs/benchmarks/2026-10-24-name-variants-7471.md), receipts under `docs/benchmarks/2026-10-24-name-variants-7471/`). On a synthetic 560-page brain with 64 queries, a full-name query using the other form of the given name ("Matt X" for the page titled "Matthew X") went from 0 of 12 to 12 of 12 at rank 1 on keyword-only search and on hybrid search with the reranker off. No query ranked worse on the branch in any configuration. With the Voyage reranker on, both trees return the person page at rank 2. BrainBench is identical on all 24 cells. This is development evidence on placeholder names, not a held-out result.

## [0.10.133] - 2026-10-29

### The 8k conversion wave: preregistration, harness and held-out result

- **You can read the held-out verdict for gbrain's 8k conversion wave.** On the 200 held-out questions of sealed confirmation v2, the facts block (`search.query_facts_block`) answered 183 against 151 for the control, +16.0 points with a persona-clustered 95% interval of +11.0 to +21.5. By the preregistered rule the verdict is `pass`. The budget-unit flag and the evidence-titles flag are `inconclusive`. Read the [report](docs/benchmarks/2026-10-26-gbrain-8k-conversion.md); the flip of `search.query_facts_block` is the owner's call.
- You can repeat the whole run keyless: the preregistration, the decision file with its committed rule, the C8K harness (`eval/runner/budgeted-delivery/c8k*.ts` and scripts) and the dry-run receipts on the invented custody fixture are committed together, and `c8k-dry-run.sh` runs the development reading and the full custody chain with dummy keys and no provider call.
- **The held-out run's custody steps are covered by tests.** `test/eval/budgeted-delivery-c8k.test.ts` now exercises the retrieval checks, the final gate, the amendment resume of the freeze, the custody refusals of `decide`, the answer files and budget summary, evidence reading, the reader resume, the corpus build, the export and the extraction, each with a one-line statement of what it protects.

### Fixed

- **`receipt-secrets` is green again.** gitleaks read the `"tokenizer": "approx-chars-div-4"` label in eight gate receipts as an API key. A repo-root `.gitleaksignore` names those eight receipt lines. The receipts are hashed artifacts and are unchanged.

## [0.10.132] - 2026-10-29

### reuse-check and arm_power refuse inputs they used to pass

- **`reuse-check.ts` no longer approves a reuse it couldn't check.** It refuses when an import in the runner's closure can't be resolved by git at either commit (both sides used to read as "missing" and compare equal). A file the runner imports from an installed package is compared by the version `package.json` pins at each commit. It also refuses when the preregistration names a budget run id only as part of a longer id or a path. A `--arm` value with regex characters is now matched literally instead of crashing the check.
- **`arm_power.py` no longer reports agreement it didn't measure.** `--draws 0` used to print `0/0` with `all_agree: true`. Now zero draws or resamples, an unparsable fraction, a world given twice, a `--world` without `=`, cells with `repeat` above 0 and an unreadable results file or line are all usage errors (exit 2).
- **Two slow tests no longer fail on small machines.** The plain-hybrid ingestion test and a situation-recall decision test take 3 to 6 seconds on a 2-CPU machine, against the 5-second default timeout. When the first timed out, the test runner killed the shared fake server, and two later tests failed with it. Both now set a 60-second timeout, as the other slow tests in their files do.

## [0.10.131] - 2026-10-28

### Eval cost audit and two tools that cut a confirmation's cost

- **You can now reuse a Cat 40 arm that doesn't load gbrain.** `bun eval/runner/cat40/reuse-check.ts --prior <dir> --planned <dir> --arm fs` compares the two experiment manifests and receipts and refuses on any difference in world, Hard identity, limits, judge, scorer, settings, evaluator code, runner cell code or cell-affecting flag, when either run recorded a dirty checkout or the earlier run didn't finish, and unless `--preregistration` names the earlier budget run and the arm. A re-confirmation of a new gbrain build on the four October worlds, run from the runner commit those arms ran at, would run only the gbrain arms: about $650 instead of about $2,860 (a projection; the sealed worlds' arms are checked in custody).
- **You can size each arm by simulation before preregistering it.** `python3 eval/runner/cat40/arm_power.py` reruns the frozen confirmation endpoints with one arm on a fraction of the tasks and reports how often each verdict that uses the arm holds on fewer of the same tasks, and the spend on the tasks left out. On the October public cells, the files-only arm on half the tasks kept "ahead" in 20 of 20 draws and would have saved $291.
- **Both apply only to preregistrations written from 2026-10-28 on**, and each one declares its reused arms and its sizing simulation before any cell runs ([eval/CONTRIBUTING.md](eval/CONTRIBUTING.md#cut-the-cost-of-a-preregistered-run)).
- **The audit** ([docs/audit/2026-10-28-eval-cost-audit.md](docs/audit/2026-10-28-eval-cost-audit.md)): about $10,400 of model spend from October 14 to 28, 94% of it the Q1 scoreboard and the Cat 40 confirmation.
- **CI:** the `harness` job's Python tests and Bun proxy tests now run as two parallel jobs, `harness (pytest)` and `harness (proxy)`, with the same test files.

## [0.10.130] - 2026-10-27

### Q1 head-to-head scoreboard: preregistered, run, and published as aggregates

- **You can now read how gbrain's shipped defaults compare with external memory systems and plain baselines on the same questions** ([report](docs/benchmarks/2026-10-06-scoreboard-report.md), [scoreboard](docs/benchmarks/2026-10-06-scoreboard/scoreboard.md), README headline). The headline is BEAM-10M, a set never used to tune gbrain and run from the custodian's host. External systems are named by kind; their frozen bundles are listed in `docs/comparison-systems.md`.
- **Every GBrain row measures GBrain 0.60.138.0 (`f05943e6`, 2026-10-09), not current master.** A rerun at current master is planned (F6).
- **What the numbers say.** At 8k context, gbrain-defaults scores 56.3% on BEAM-10M (197 of 199 questions). The 8k rows are descriptive: with 10 conversations only differences of about 13.6 points are detectable, so no row is ranked. On whole-system rows nothing separates after Holm correction; the largest gap is the file-agent baseline, 9.3 points above gbrain (Holm p 0.099).
- **Preregistration with amendments A1 to A25.** Each amendment was committed before the cells it governs ran, with its campaign hash. The sealed campaign is frozen at `a92b06c5` (149 units). A25 limits publication to aggregates plus a `SHA256SUMS` commitment and keeps the full receipt sealed in custody until F6.
- **Check a published number yourself.** `bun eval/runner/scoreboard.ts check --sums <SHA256SUMS>` verifies the README block and `scoreboard.md` against the committed hash, and `check --commit <sha>` checks them against the results branch. Public renders print exclusions as counts by reason and refuse to print any sealed question id.
- **Run your own campaign.** `eval:scoreboard` drives the campaign: leases priced against block and campaign caps, cells on Ubicloud VMs, reattach after a lost session, resume by missing answers, a $0 fixture in CI, and `raise-lease` to raise a running lease on both ledgers.
- **Spend.** $7,034.32 on the campaign ledgers against an $8,000 sealed cap. Of 149 launch units, 114 settled complete, 8 partial and 27 not run, and each not-run row says why.

### Fixed

- An abandoned or still-open lease that `raise-lease` raised is now charged at its raised amount in lease listings, block spend, status and the next raise's block check, matching the campaign ledger.
- `eval/runner/q1/persist.sh` honours fractional hours (the default 5.8 ran 5 hours; 0.5 ran not at all).
- The name guard scans the tree in two passes instead of eleven, so its whole-tree test finishes inside its budget on a loaded machine.
- The render and chat-client changes Q1 needs live in `render-v2.ts` and `qa-v2.ts`, so `render.ts` and `qa.ts` keep main's bytes.

## [0.10.129] - 2026-10-25

### Re-pin to gbrain `7a6bdd357` (v0.60.454.0); N14 at large pages Wave B PR 4

- **Pin.** gbrain moves from `6e1086492` (v0.60.324.0) to `7a6bdd357` (v0.60.454.0). This brings large pages Wave B PR 4 (#7316): derived data is kept per segment, forced chunk cuts land on a sentence or line end, and a new transcript session imports as one page. It also brings the git-canonical privacy follow-up (#7586).
- **Re-pin fixes.** Each was root-caused, and no assertion was weakened:
  - N4 scores `remember`'s documented entity refusal (gbrain #7248) as unresolved, not as an error.
  - The ARS E2 broken-adapter test unfolds collapsed rows before it reverses them.
  - With `page_split: exchanges`, the harness provider no longer sends a `source_slug` that no page carries.
  - cat30 restores `GBRAIN_HOME` after it runs.
  - Docs name the new pin, and the search-mode notes add `collapse` and `rank_priors`.
- **N14** ([report](docs/benchmarks/2026-10-25-n14-large-page-fidelity-wave-b4.md)). Preregistration Amendment 6 was written before any counted run. The run is hermetic on the default config, covering PGLite from 2 MB to 260 MiB and Postgres at 2 MB and from 100 MiB to 260 MiB, at $0.
  - **Counted verdict: pass.** This is the first time every rule passes. The recall gap is 0 at 2 MB, 20 MB and 24 MiB; it was 2.5 at 24 MiB, because the split needle is now found whole. The worst native append ratio is 2.87.
  - Segmented pages have 2 to 4% fewer chunks. Every stored page is still found 40/40, read in windows and exported byte-identical.
  - Exploratory: the Postgres doubled append embed did not recur (0 of 30 document runs, against 5 of 23 at v0.10.124). Ingest at 100 MiB and above is 5 to 14% slower, all in the projection seal.
  - Forget on pages over 24 MiB is still unreachable: an upload replace adding the fence fails with `request_too_large`.
- **Registry.** The N14 row stays held only for the trusted-local egress rule, which waits on a product decision.

## [0.10.128] - 2026-10-21

### Agent retrieval shapes: gbrain#7195 measured

- **gbrain#7195, merged as `a6204367` (v0.60.349.0), against master `c0b30d71`** ([report](docs/benchmarks/2026-10-20-agent-retrieval-shapes.md#entity-lookup-families-gbrain7195), receipts under `docs/benchmarks/2026-10-20-agent-retrieval-shapes/gbrain-7195/`; keyword path, no embedding key, $0). Name variants beyond N4 (E6) 0/24 to 24/24, and the ambiguous-surname control now stays unresolved (negatives 1/2 to 2/2). Title-prefixed person stubs (E7) stay 0/4: the exact-matching stub remains the card by design and the real page is listed as a possible duplicate. Raw-only names (E8, 2/2) and identifiers (E10, 9/9) already passed on this fixture. Every other family is unchanged.

## [0.10.127] - 2026-10-20

### Agent retrieval shapes: gbrain#7186 measured

- **gbrain#7186 at `42588edd` against master `9c03ec68`** ([report](docs/benchmarks/2026-10-20-agent-retrieval-shapes.md#builds-measured), receipts under `docs/benchmarks/2026-10-20-agent-retrieval-shapes/gbrain-7186/`; keyword path, no embedding key, $0). Twin slugs across sources (E1) 0/30 to 30/30, merge stubs above their target (E2) 5/15 to 15/15, the founder above the company (E4) 0/6 to 6/6. Score order (E12) holds at 306/306 and E15 at 48/50 hit@1. Derived copies of one talk (E3) stay 0/6: the copies fold into one row, but that row still ranks above the decision page. The largest returned row (E13) stays 59,883 characters, a whole conversation block the PR leaves alone.

## [0.10.126] - 2026-10-20

### Agent retrieval shapes: E1 to E15 as a report-only category

- **New category `agent-retrieval-shapes`** ([report](docs/benchmarks/2026-10-20-agent-retrieval-shapes.md); runner `eval/runner/agent-retrieval-shapes.ts`, generator `eval/generators/agent-retrieval-shapes-gen.ts`, alias ARS). It turns 15 retrieval failure shapes that an operator agent reported on a large multi-source production brain (gbrain issues #4612, #6058, #7153 to #7157 and #7159 to #7165) into a seeded fictional world of 621 pages in three sources plus 5 images, with gold from an independent oracle. Tier H, free, report-only with exploratory metrics only, and runnable against any build with `--gbrain`.
- **First run at gbrain `6e1086492`** (keyword path, no embedding key, 20.7 s, $0). Nine shapes reproduce: twin slugs across federated sources (E1, 0/30), same-title merge stubs above their target (E2, 5/15), derived copies of one talk (E3, 0/6), a founder page above the company a product query describes (E4, 0/6), name variants beyond N4 (E6, 0/24), title-prefixed person stubs (E7, 0/4), a 59,883-character returned row (E13, 0/1), `projection_pending` on unrelated text queries (E14, 0/3), and `query` returning the same top 10 as `search` (E15, 48/50 hit@1). E8 to E12 hold. E5 is not measured, because search and query take no frontmatter filter.
- **Bug ledger.** ARS-1 to ARS-7 and ARS-13 to ARS-15 open as feature gaps, each naming its gbrain issue.
- **Not measured.** Vector, hybrid, reranked and expanded retrieval; a paid arm is follow-up work.

## [0.10.125] - 2026-10-20

### Sync freshness: gbrain's commit notifier, first sync after activation, and PR 2b

- **Sync freshness** ([report](docs/benchmarks/2026-10-19-sync-freshness.md), GBRA-133). Commit-to-searchable latency through a running `gbrain serve` after gbrain's commit notifier (v0.60.316.0, #7079): 0.60 s p50 in watch mode on Postgres (was 3.7 s on managed brains and never on classic ones) and 2.15 s p50 in poll mode, plus embedding drain under backlog and provider outage, serve start catch-up, multi-source fairness and idle cost.
- **First managed sync after activating a classic brain** on gbrain v0.60.320.0 (#6712 PR 4b): every run converged in one pass; Postgres 100,000 pages took 129.6 s and 23,243 statements (n = 1), 10,000 pages about 13 s on both engines (n = 3).
- **gbrain PR 2b** (#7111): no-op sync round trips on managed Postgres and search latency during a sync, with the raw runs under `docs/benchmarks/2026-10-19-sync-freshness/raw/`.

## [0.10.124] - 2026-10-20

### Re-pin to gbrain `6e1086492` (v0.60.324.0); N14 at large pages Wave B PR 3

- **Pin.** gbrain moves from `f717b1a5b` (v0.60.299.0) to `6e1086492` (v0.60.324.0), which adds `append_page`, upload sessions and segmented `edit_page` (large pages Wave B PR 3, #7104) and the large-pages hardening (#7081). The suite needed only the docs that name the pin; `src/core/search/mode.ts` is identical at both commits.
- **N14** ([report](docs/benchmarks/2026-10-20-n14-large-page-fidelity-wave-b3.md), preregistration Amendment 5, written before any counted run). A hermetic run on the default config, PGLite 2 MB to 260 MiB and Postgres 2 MB and 100 MiB to 260 MiB, at $0.
  - The native arm appends with `append_page` and writes every document over 4 MiB through an upload session, as its preregistered definition says once gbrain has them. The runner's upload call now follows gbrain's session contract, and its append keeps the page equal to the source plus the append.
  - The append rule is counted from this run and passes: worst native ratio 2.87. Append time falls from 7.0 s to 0.9 s at 20 MB, 8.4 s to 0.7 s at 24 MiB and 17.4 s to 2.4 s at 256 MiB.
  - Upload sessions store what the file import stored (128 MiB on PGLite, 256 MiB on Postgres), found 40/40, read in windows and exported byte-identical.
  - Counted verdict: fail, on the recall-gap rule at 24 MiB (2.5 points), the same split needle as v0.10.123; the chunker change is deferred. Safety, the floor and the append rule pass.
  - Forget on pages over 24 MiB is still unreachable: `append_page` refuses fence text, and an upload replace refuses `request_too_large`.
  - Exploratory: on Postgres the 2 MB novel or log append sometimes sends a doubled embedding input (5 of 23 document runs), as the single-page arm did at v0.10.123. It never happened on PGLite.
- **Bug ledger.** N14-5 is fixed by #7081: a purge after `forget_fact`, delete and restore leaves no segment text on either engine.
- **Registry.** The N14 row stays held only for the trusted-local egress rule, which waits on a product decision.

## [0.10.123] - 2026-10-18

### Re-pin to gbrain `f717b1a5b` (v0.60.299.0); N14 at large pages Wave B PR 2 and the switch-on

- **Pin.** gbrain moves from `77cf8e111` (v0.60.169.0) to `f717b1a5b` (v0.60.299.0), which turns `pages.segmented_storage` on by default (#6963) on top of Wave B PR 2 (#6900). The harness follows gbrain where its own docs and commits changed behavior, with no assertion weakened:
  - Cat 15 uses `extractorOutcome` (#6782).
  - The tool-bridge fake engine answers get_page's trust read.
  - N4's presence check follows gbrain's alias convention: declared prose names are stored since v0.60.174.0.
  - N2 records `total_visible` for scoped callers (D9).
  - The stubbed hash-embed runs turn off gbrain's OpenAI model discovery (#6607).
  - The shootout reranker is gbrain's default `rerank-3-lite`.
  - `@types/cookie-parser` and `@types/cors` match gbrain's `serve-http` imports.
  - The docs name the new pin and the two search-mode values that changed since `77cf8e111`.
- **N14** ([report](docs/benchmarks/2026-10-18-n14-large-page-fidelity-wave-b2.md), preregistration Amendment 4, written before any counted run). This was a hermetic run on the default config, PGLite 2 MB to 260 MiB and Postgres 2 MB and 100 MiB to 260 MiB, at $0.
  - Every stored page is found 40/40, read in windows and exported byte-identical, except the 24 MiB chat (39/40). No response passes 1 MiB, because a trusted-local full read of a segmented page now refuses.
  - The file import stores up to 128 MiB on PGLite and 256 MiB on Postgres, the 200 MB chat included. `put_page` stays at 24 MiB per call.
  - A 1 KB append writes one tail segment and re-embeds one chunk (worst native ratio 2.87, held pending Wave B PR 3).
  - Counted verdict: fail, on the recall-gap rule at 24 MiB (2.5 points), where one needle's sentence is split across two chunks. Safety and the floor pass.
  - The runner gains binary tiers at the engine ceilings, `--engine postgres`, a size-scaled settle bound, and a lifecycle step (forget, delete, restore, purge, with residue counts).
- **Bug ledger.** N14-2 closes, because a document over 24 MiB is now written through the file import. N14-5 opens: a purge after `forget_fact`, delete and restore leaves one segment text holding page content until the 1 h segment GC.

## [0.10.122] - 2026-10-18

### Graph backend: HydraDB vs Postgres for gbrain's graph walks (GBRA-123)

- **Report** ([doc](docs/benchmarks/2026-10-17-graph-backend.md), [preregistration](docs/benchmarks/2026-10-17-graph-backend-preregistration.md), pushed before any timed run). gbrain's `traverseGraph` and `traversePathsDetailed` on seeded fictional power-law graphs of 10,000, 100,000 and 1,000,000 pages: the old recursive CTE (`b1fdcb843`) and the breadth-first walks of #6934 (`fc1121cae58`) on Postgres 17, against HydraDB `fe496d475be` as the walk engine with Postgres hydration. HydraDB returned the same answer as breadth-first Postgres on all 54,842 compared calls, but its warm p95 was 6.28 s against 1.44 s at 100,000 pages and 6.28 s against 3.45 s at 1,000,000. The preregistered rule (2x and 50 ms faster) is not met, so production HydraDB routing is not built. HydraDB is faster on deep `both` edge walks (10.3 s against 3.8 s p95 at depth 3, 1,000,000 pages), flagged as the next Postgres target. The old CTE differs from breadth-first only where its row cap fired.
- **Harness**: `eval/runner/graph-backend/` (generator, loaders, eval-only HydraDB HTTP adapter, resumable runner, analyzer); receipts per tier under `docs/benchmarks/2026-10-17-graph-backend/`. Cost: $0 in model spend; one Ubicloud `standard-16` for 8 h 24 min (about $4.20).

## [0.10.121] - 2026-10-17

### W11: gbrain W4 (weekly belief diff) confirmed on sealed material

- **Held-out verdict** ([file](docs/benchmarks/2026-10-05-heldout-verdicts/w11-w4-heldout-2026-10-17.json), [preregistration](docs/benchmarks/2026-10-17-w11-w4-sealed-confirmation-preregistration.md), frozen in 0.10.120 before the material was minted). The custodian ran gbrain release v0.60.289.0 (`15b159514`) with harness `60e2b21f3` on three fresh seeds and a fresh phrasing set minted in custody on the Dyson Sphere (set `w11-cust-2026-10-17-a`, SHA-256 `31b5f86d…`), PGLite only. Every gate passes. G1: set-F1 1.0 on each of the three seeds (bar 0.95). G2: 28 of 28 gold re-scores reported with their exact before and after, 0 wrong or missing, 0 extra. G3 and G4: cause and evidence pointer correct on 108 of 108 reported changes. So `delta {beliefs: true}` and `gbrain beliefs` keep shipping as they are, and W11 closes.
- **Tokens, reported, not gated**: the weekly belief diff runs 238 to 507 tokens against 238 to 390 for `delta`'s page list over the same week (5 to 8 pages).
- **Records**: the verdict index gains the file. The phrasing, the receipt and the brains stay in custody; the custodian checked that the verdict quotes no held-out line. No harness errors, no reruns. Cost: $0, no model calls (cap $1).

## [0.10.120] - 2026-10-17

### W11: sealed confirmation of gbrain W4 (weekly belief diff), preregistered

- **Preregistration** ([file](docs/benchmarks/2026-10-17-w11-w4-sealed-confirmation-preregistration.md), results glob in `preregistrations.d/w11-w4-sealed-confirmation.json`). W11 now confirms W4 alone (`delta {beliefs: true}`, `gbrain beliefs`, gbrain #6866) on gbrain release v0.60.289.0. The custodian mints three fresh seeds and fresh wording for every belief-changing line inside custody on the Dyson Sphere; only the aggregate verdict leaves it. Gates: W4's own bar, set-F1 at least 0.95 on every seed, plus exact before and after for every re-score, and correct cause and evidence pointer on every reported change. Tokens against `delta`'s page list are reported, not gated.
- **Harness**: `eval/runner/belief-weekly-probes.ts` with `eval/generators/belief-weekly-gen.ts`, a port of gbrain's W4 probe that takes custodian phrasing (`--phrasing-file`, access-logged) and fresh seeds. It calls no model. On v0.60.289.0 with development phrasing and seed 20261016 it passes every gate (37 of 37 changes) and matches the gbrain probe's per-week counts exactly. Cost: $0, cap $1.

## [0.10.119] - 2026-10-17

### Living pages (gbrain W9) decided on prior: not built in V1, W10 dropped with it

- **Verdict** ([file](docs/benchmarks/2026-10-17-living-pages/verdict.json); the [preregistration](docs/benchmarks/2026-10-17-living-pages-preregistration.md) records it under Changes). No owner data: the owner declined to supply production-brain counts, so the observed ratio is unknown and the decision is taken on the prior. The build threshold is 1,387 reads per changed page-day (0.5 review minutes at $2.00 a minute, $0.017 a refresh), and nothing known about a personal brain's read rate comes close, so W9 is not built in V1 and W10 (provenance render and block undo) is dropped with it. The preregistered rule is unchanged. Reopen if aggregate telemetry from a hosted brain shows the observed ratio at or above the threshold. Cost: $0.

## [0.10.118] - 2026-10-17

### Living pages (gbrain wave 4b W9): the read/write break-even, preregistered before the owner's counts

- **Preregistration** ([doc](docs/benchmarks/2026-10-17-living-pages-preregistration.md)). The plan builds living pages only if the cheaper designs lose, and the answer turns on reads per change. From pinned questions, the closest measured analogue (C4 run 3, Sonnet 5.5), a refreshed page is cheaper per correct answer than equal-token anchored retrieval above **8.2** reads per change with the cheapest measured refresh and free review, **23.2** with the plan's $0.017 living-page refresh, and **1,387** once a proposal costs 0.5 review minutes at $2.00 a minute (the build threshold; the doc tabulates 194 to 13,663 across review times and prices). The owner's ratio comes from two read-only aggregate queries over 30 days: operation counts from `mcp_request_log` (frozen read set) over changed page-days from `page_versions` and new pages. W9 is built only at or above 1,387; otherwise it and W10 (provenance render and block undo, which need refreshed blocks) are dropped. If W9 is built, the paid `living-pages` category (capped at $40) replaces the priors with measured review minutes and costs before any default.
- **Classifier**: `eval/runner/living-pages-breakeven.ts` turns the two query results into the decision, with a test that pins the thresholds; `preregistrations.d/living-pages.json` registers the experiment. No owner data is in this repository. Cost: $0.

## [0.10.117] - 2026-10-17

### Forecast journal (gbrain wave 4b W7, #6886), shipped in v0.60.286.0

- **Report** ([doc](docs/benchmarks/2026-10-17-forecast-journal.md), [preregistration](docs/benchmarks/2026-10-17-forecast-journal-preregistration.md), frozen in gbrain `65ed40ec6` before any scored run). The $0 synthetic gate for the private forecast journal: 20 cohorts of placeholder holders with known skill, 5,622 predictions, in-memory PGLite. It passes every criterion. Shrunk accuracy ranks holders in their true order (median Spearman ρ 0.905, bar 0.80). Who-was-right set-F1 is 1.000. Journal totals, per-holder counts, `low_n` flags and uncertified prediction-time labels match exactly. All 8 remote probes pass: remote `takes_list`, `takes_search` and `takes_scorecard {}` are unchanged and carry no journal field, and remote `group_by` or `min_n` is refused with `scorecard_group_by_local_only`. Set-F1 and the exact counts are a ceiling (regression guards); ρ is a diagnostic of shrinkage, not a ranking of real people.
- **Shipped**: gbrain #6886 merged as `d28cbaeee` (v0.60.286.0). A rerun at that commit gives identical results; its `summary.json` and `summary.md` and a `verdict.json` are in `docs/benchmarks/2026-10-17-forecast-journal/`. `README.md` and `docs/README.md` gain the row.
- Measured through gbrain's own harness; the pin is unchanged. Cost: $0.

## [0.10.116] - 2026-10-17

### P1 E2 rerun on gbrain W5: late closures disclosed as upper bounds, apply certification holds

- **Held-out verdict** ([file](docs/benchmarks/2026-10-05-heldout-verdicts/p1-e2-w5-heldout-2026-10-16.json), [preregistration](docs/benchmarks/2026-10-16-p1-e2-w5-rerun-preregistration.md), frozen in 0.10.113 before the first cell). The custodian ran gbrain `6c3e6fe05` (v0.60.273.0, wave 4a W4 and W5) with harness `3a9360b86` on phrasing set C's joins-only ledger, whose SHA-256 matches the E2 attempt-2 receipt: `claude-opus-5-5`, `claude-sonnet-5-5` and `gpt-6.1-sol`, seeds 11, 13 and 17, 27 of 27 runs. C1 passes: every late closure is disclosed as an upper bound (`late_upper_bound` equals `late` in every run). C2 passes for all three models: 0 wrong and 0 undated closures in every run, as-of exact 0.392 to 0.397 against the 0.361 floor. So the three models keep `apply` on the W5 build.
- **Late closures, reported, not gated**: 48 of 75 per run (48 of 74 in one Sonnet run, where one judge error left a proposal unapplied; no harness errors, no reruns). W5's build applies more closures per run than E2's (74 to 75 against 66), so this is not comparable with E2's 41 of 66.
- **Records**: the verdict index and the held-out program's P1 section and scorecard gain the rerun. Row-level output stays in custody. Cost: $2.40 of the $8 cap, on the custodian's eval ledger.

## [0.10.115] - 2026-10-17

### Take grading shipped in gbrain v0.60.282.0 (#6882), and the auto-resolve follow-ups

- **Shipped**: gbrain #6882 merged as `4e698e9d9` (v0.60.282.0). `GRADE_TAKES_MEASURED_MODELS` is `openai:gpt-6.1-sol` for prompt `hybrid-evidence-v2`, and auto-resolve stays unwired. The [take-grading report](docs/benchmarks/2026-10-16-take-grading.md) and its `verdict.json` (`gbrain_shipped_in`) name the release.
- **Follow-ups for auto-resolve** (decided October 16, recorded in the report): auto-resolve is a later opt-in PR, built only after a real sample of about 300 graded takes passes. A take whose numeric target was missed is never auto-applied, neither as `partial` nor as `incorrect`; it is held for manual review. The measured judge is scoped to its prompt version. A thinking setting or larger output ceiling for the judge, and a parser tolerance, are proposed for the next preregistration.
- Measured through `--gbrain`; the pin is unchanged. Cost: $0.

## [0.10.114] - 2026-10-17

### Take grading (gbrain wave 4b W6, #6882)

- **Report** ([doc](docs/benchmarks/2026-10-16-take-grading.md), [preregistration](docs/benchmarks/2026-10-16-take-grading-preregistration.md), frozen in gbrain `d99b84694` before any counted run). 790 counted synthetic forecasting takes with dated evidence and placeholder names (750 in the rule: 500 resolvable, 250 the evidence cannot settle; 40 exploratory), one run per model through gbrain's production evidence block, judge call and parser, $9.25 in all. A verdict counts as applied when it is not `unresolvable` and its confidence is at least 0.95; a model qualifies when the one-sided 95% upper bound on wrong applied verdicts is at most 1%. `gpt-6.1-sol` applied 496 with none wrong (0.6%), resolving 99.2% of resolvable takes and holding back on every unresolvable one; it qualifies, and gbrain's `GRADE_TAKES_MEASURED_MODELS` lists it. `claude-opus-5-5` gave the gold verdict on every resolvable take but applied 2; `claude-sonnet-5-5` applied 121 with one wrong (a real-world proposition graded from its own knowledge). On the exploratory `partial` set every model calls a missed target `incorrect`, a policy question left open; 12 of 18 unparsed answers spent the judge's 600-token ceiling on thinking.
- **Records**: fixtures, dev-round and counted rows with each model's reasoning, `summary.json`, `summary.md` and `verdict.json` in `docs/benchmarks/2026-10-16-take-grading/`; `README.md` and `docs/README.md` gain the row.

## [0.10.113] - 2026-10-16

### N6 on gbrain's weekly belief diff (delta beliefs) at the v0.60.273.0 release, and the P1 E2 rerun preregistration for W5

gbrain v0.60.273.0 (#6866, wave 4a) adds `beliefs: true` to `delta`: each belief that changed in a window, with its value
before and after, the event that caused it and a pointer to the evidence, read from the belief ledger. N6 now fuzzes it
with the ledger on before seeding, records the trusted and remote outcome of every `beliefs` probe, counts the probes
that read real history with signal, and fails the HTTP verdict when a build exposes `beliefs` and none do. The oracle
view masks `beliefs.until`, the request instant. On the branch, N6 found 12 content leaks in process and over Postgres
HTTP (held Takes shown to remote callers, as revisions and in a new page's creation body), fixed before review. At the
release, from a clean checkout of the tag: Postgres over HTTP passes 155 of 155 mandatory cells with 0 leaks and 0
oracles, and in process on PGLite 0 leaks and 0 oracles, with 28 `beliefs` probes reading real history on each
([report](docs/benchmarks/2026-10-16-n6-delta-beliefs.md)).

The P1 E2 rerun after gbrain W5 is preregistered ([preregistration](docs/benchmarks/2026-10-16-p1-e2-w5-rerun-preregistration.md)):
Opus 5.5, Sonnet 5.5 and GPT-6.1 Sol on phrasing set C's joins-only ledger, seeds 11, 13 and 17, run by the custodian
after this release with a $8 cap. It reports the late-closure count and checks that every late closure is disclosed as
an upper bound. `temporal-contradictions.ts` gains that count, `late_upper_bound`, with a test. No held-out text is in
this repository. Measured through `--gbrain`; the pin is unchanged. Cost: $0.

## [0.10.112] - 2026-10-16

### N6 with gbrain's recorded-time reads (known_as_of), at the v0.60.267.0 release

gbrain v0.60.267.0 (#6850) adds `known_as_of` to `get_page` and `get_versions`: the page as the brain had recorded it at an
instant, from the belief ledger. N6 now fuzzes both params, with the ledger on before seeding, and records for every
`known_as_of` probe what the trusted caller and the remote caller got back (`history`, `coverage_from`, `coverage_gap`,
`unproven`, `invalid_params` or `refused`). The Postgres-over-HTTP verdict fails when a build exposes `known_as_of` and no
probe reads real history. At the release, from a clean checkout of the tag: Postgres over HTTP passes 155 of 155
mandatory cells with 0 leaks and 0 oracles, and 56 of its 136 `known_as_of` probes read real history with signal; in
process on PGLite, 0 leaks and 0 oracles, with 90 of 180 reading real history. An earlier W2 head had 16 existence
oracles over HTTP (a remote client got `page_not_found` for a private page but `coverage_from` for a slug never written),
fixed before release ([report](docs/benchmarks/2026-10-16-n6-known-as-of.md)). Measured through `--gbrain`; the pin is
unchanged. Cost: $0.

## [0.10.111] - 2026-10-16

### N1 with gbrain's belief ledger on (probe 40), at the v0.60.265.0 release

gbrain's belief ledger (W1, #6806) shipped in v0.60.265.0. Probe 40 of its design requires that turning the ledger on
changes no answer, so N1 ran with the ledger off and on against the release commit `09943580e`, on PGLite and Postgres
over the CLI, stdio MCP and HTTP MCP. Both arms gave 388 of 388 current values, 0 stale, 385 of 385 history, 124 of 124
negative controls, and no leaks, lost writes or system errors, with identical per-cell and per-checkpoint counts
([report](docs/benchmarks/2026-10-16-belief-ledger-n1.md)). The runner gains the `EVAL_BELIEF_LEDGER=1` hook, which
runs `gbrain beliefs enable` in each cell before any write, and the N1 runner now scrubs home and temp paths from its
receipts. Measured through `--gbrain`; the pin is unchanged. Cost: $0.

## [0.10.110] - 2026-10-16

### LHF wave 2: plan, verdicts and the attendance paraphrase gate

gbrain's second low-hanging-fruit wave (latency, retrieval and cost) shipped as gbrain v0.60.259.0 (#6822). Its plan,
the three audits it came from, both rounds of gstack autoplan reviews and the measured verdict for every item are in
[docs/plans/2026-10-15-lhf-wave-2/](docs/plans/2026-10-15-lhf-wave-2/VERDICTS.md). Against master, every shipped
performance item was parity-clean on PGLite and Postgres. A remote MCP search 30 ms from Postgres went from 1.72 s to
0.88 s at p50, and the 79-call parity run went from 6,008 to 3,580 statement round trips. The attendance paraphrase item
failed its [preregistered gate](docs/benchmarks/2026-10-16-lhf-wave-2-attendance-preregistration.md). The development
split went from 0 to 150 of 150, but 30 independently written held-out questions fired 18 of 90 runs (master 6 of 90),
against an 80% floor, so it did not ship. The held-out text is not published. N9 gains `--extra-split`, and the gate adds
a relation-aware scorer (`eval/runner/lhf-wave-2-attendance-gate.ts`) and a parser probe
(`eval/runner/parse-relational-questions.ts`). Cost: $0.

## [0.10.109] - 2026-10-15

### N14 at large pages Wave B PR 1: segmented storage (exploratory)

An exploratory, hermetic N14 run against gbrain master `7f3c9f5` (v0.60.252.0, #6787) with `pages.segmented_storage` on
and off. It cost $0. With the switch on, the 2 MB documents and the 20 MB chat are stored in segments (8, 8, 6 and 74) and
found 40 of 40 in every decile. A 1 KB append writes one tail segment and re-embeds one chunk (two for the 2 MB chat, a
4.35x ratio). The 20 MB append takes 7.1 s, against 11.9 s inline, and ingest peaks at 2.9 GB, against 4.1 GB. The stored
segments match the source byte for byte. But `get_page` and `gbrain export` refuse a segmented page with
`page_body_segmented` until PR 2, so windowed reads are 0 of 40 and the export round trip fails. The 200 MB chat is
still refused: `put_page` with `request_too_large` at 24 MiB, and the streamed import with `file_too_large` at PGLite's
128 MiB ceiling. With the switch off, the same commit reproduces Wave A. The runner gains `--config`,
`--native-ingest import`, segment storage, append-write and segment round-trip measures, polling of `write_pending`
receipts and a wait for the segmented projection (preregistration Amendments 2 and 3). The bug ledger reviews N14-2.
See the [report](docs/benchmarks/2026-10-15-n14-large-page-fidelity-wave-b1.md).

## [0.10.108] - 2026-10-15

### D9 remote `find_contradictions`: N6 holds at 0 leaks; N2's verdict carries forward

gbrain v0.60.250.0 (#6784) gives remote, source-scoped and `min_trust` callers stored contradiction findings, re-reading
each side live under the caller's read policy. N6 could not test this before, because the op returned nothing to scoped
callers and its world had no stored report. The N6 runner now seeds one (`seedContradictionReport`), built by gbrain's own
contradiction probe with an oracle judge, so the report copies every protected marker. The
[D9 report](docs/benchmarks/2026-10-15-d9-find-contradictions.md) has three N6 runs on seed 20260930:

- v0.60.250.0 (`3c16e9ba4`): 540 `find_contradictions` probes, 160 with signal, 0 leaks; the whole run passes with
  0 content and 0 existence leaks.
- master before the release (`ea93c770b`): the op was suspended, so 0 signal and 0 leaks.
- A forced probe that skips the live re-read: 288 content and 192 existence leaks, all on `find_contradictions`.

The keyless N2 arm at v0.60.250.0 offers the same 2,680 pairs as the wave 14 re-pin (`77cf8e111`), and no commit since
changes the judge or probe, so the paid compatible-pair result (4 of 51, 7.8%, under the 0.10 cap) carries forward. A
remote caller now reads 100 of N2's 190 stored findings, where it read 0 before. Spend was $0.

## [0.10.107] - 2026-10-15

### D7 Cat 41 brief scenarios: no time-saved signal; the brief stays default-off

Cat 41 gains the D7 brief scenarios: reply, meeting prep, task start and a namesake negative, on two new
program-primary worlds (seeds 20261222 and 20261226), with facts aged 72 hours or crowded out of hot memory. gbrain
wires each harness itself with `gbrain setup`, and the brief switch is off or on, plus a hooks-off pull arm. The driver
timestamps every transcript line, keeps each hook's output, and has a $0 smoke mode that sends the harness's model
calls to its fake provider. `eval/runner/cat41/brief-d7.ts` runs the smoke and the analysis (`summarizeD7`).

The [preregistration](docs/benchmarks/2026-10-15-cat41-brief-preregistration.md) was frozen on gbrain v0.60.247.0
before any spend. The run had 48 native sessions: Claude Code with Sonnet 5.5 and Opus 5.5, Codex with gpt-6.1-sol,
and a Sonnet pull arm. It reports [no time-saved signal](docs/benchmarks/2026-10-15-cat41-brief.md):

- Time to the first correct output fell 6% with the brief on (ratio 0.938, 95% interval 0.853 to 1.032), short of
  the required 20%. Turns and tool calls to it fell about 10%, while per-request provider latency was unchanged.
- Success was 15 of 15 on against 14 of 15 off. Non-inferiority fails on width (lower bound −7.6 points).
- The brief fired in every positive brief-on cell and was always complete. It made 0 false pushes and was silent in
  every negative. Hot memory carried no needed value.
- In 19 of 20 brief-off sessions, the agent pulled the same brief itself with `context_pack(counterparty)`, so the
  push saved one round trip.

Under the preregistered rule, wave 5's brief work closes at default-off. Spend was $4.46 of a new $30 ledger.

## [0.10.106] - 2026-10-15

### D6 proactive brief, development v2: no time-saved signal

The D6 redesign reruns brief-off against brief-on on the T0 carrier where hot memory cannot carry the facts. Session 1's
facts are either backdated 72 hours (aged) or buried under 40 newer, unrelated facts (crowded). Each cell records its
session-1 save path and whether hot memory held a needed fact. The primary moved to time saved (session-2 tool calls
and input tokens) with non-inferiority on success, because the plan's exit allows "task success or user time saved".
The [preregistration](docs/benchmarks/2026-10-15-proactive-brief-dev-v2-preregistration.md) was written after v1's
results, approved, and frozen at `3952fb33` on gbrain v0.60.247.0 (`47f052af`, the brief's page-edit source) before
any spend. There are six new development seeds, 20261211 and 20261213 to 20261217.

The run used Opus 5.5, Sonnet 5.5 and gpt-6.1-sol, 144 cells, and reports
[no time-saved signal](docs/benchmarks/2026-10-15-proactive-brief-dev-v2.md):

- Session-2 tool calls fell 6% with the brief on (ratio 0.940, 95% interval 0.856 to 1.032), short of the required
  20%. Session-2 input tokens fell 8% (ratio 0.918, upper bound 0.971).
- Both arms finished 72 of 72 paired tasks, so success is non-inferior at −5 points.
- Hot memory carried no needed fact in any cell. The brief fired in 72 of 72 brief-on cells, including all 10 page-only
  sessions that v1 missed, and was silent in every brief-off cell. It made 0 false pushes and had no confident-wrong
  cells.

This is development evidence only and does not decide the default. v1's verdict stands. Spend was $29.60 of a new $35
ledger.

## [0.10.105] - 2026-10-15

### Cat 40 next wave: development, preregistration and confirmation

This release adds the Cat 40 next-wave development harness, development rounds 1 to 3, the d1b gate, the frozen
preregistration (`docs/plans/2026-10-11-cat40-next-wave/PREREG.md`, with Amendment 1 and a cap note), and the
counted confirmation on four new 50,000-document worlds: public P1 and P2, and sealed S1 and S2, whose seeds stay in
owner custody. It also includes the #133 plan and its F2 frozen record.

The two generators ended up testing two different builds. On the public worlds, the build with F5 (owner-phrase
resolution) was ahead of plain files by +12.50 points [+9.17, +15.83] and ahead of the baseline by +4.00, with fewer
wrong values (−3.50, D3 passes). F5 then failed its precision ship condition on `messy-company-v1` (6 of 22 links), so
Part 1 ships without it. On the sealed worlds, where F5 resolves nothing, the build without F5 was ahead of files by
+10.67 [+7.00, +14.50]. It was level with the baseline (−1.17 [−4.33, +2.00]), and D3 fails there. Development round 3
had measured the same no-F5 configuration as level with control. The baseline is ahead of files on both generators
(+8.50 public, +11.83 sealed). The wave's gain over the baseline depends on F5 and probably doesn't transfer to real
brains. No single build ran on both generators, so no single general claim is made. Program spend was $2,863.25 of
$3,400.

The harness changes are limited to the confirmation program (`eval/runner/cat40/next-confirm.ts`,
`next_confirm_analysis.py`), the confirmation seeds, a write-tool race fix in `hard.ts`/`arms.ts` with a forced-probe
test, and the development tooling. See the
[confirmation report](docs/benchmarks/2026-10-15-cat40-next-confirm/README.md).

## [0.10.104] - 2026-10-15

### N14 large-page fidelity after large pages Wave A

The N14 rerun against gbrain master `44eb049` (v0.60.242.0) is hermetic and cost $0. Each 2 MB document and the 20 MB chat is
stored as one page and found 40 of 40 in every decile (0 of 40 at the baseline). Windowed reads around a hit are
correct 40 of 40, the largest 20,871 bytes. Export round trips are exact, and a 1 KB append re-embeds one chunk (1.87
to 2.87 times the appended text, under the preregistered 3x). An older brain's skipped page comes back with
`reindex --oversized`. Of the preregistered rules, Wave A passes all measured here except the egress contract: a trusted
local default `get_page` is still the full page by design, while the agent-facing default read is 23.6 to 35.6 KB.
Pages over 24 MiB are refused, now with `request_too_large` (bug N14-4 fixed), and appends still rewrite the whole
page: both wait for Wave B. Preregistration Amendment 1 adds the upgrade-path case and the agent-facing read. The bug
ledger closes N14-1 and N14-3, fixes N14-4 and narrows N14-2. See the
[Wave A report](docs/benchmarks/2026-10-15-n14-large-page-fidelity-wave-a.md).

## [0.10.103] - 2026-10-14

### D6 proactive brief, development phase: no improvement signal

Cat 40 family P gains the proactive-brief arms. The T0 runner takes `--arms brief-off,brief-on`. Brief-on sets
`context.proactive_brief` after every restore. The paid-arm guard halts the run on any brief in a brief-off cell, and
paid brief cells need `--preregistration`. `eval/runner/t0/brief.ts` reads the brief block, classifies each pushed item
against the gold and summarizes the preregistered primary and diagnostics. There are six new development seeds,
20261201 to 20261206, and a registry row `proactive-brief` (D6).

The [preregistration](docs/benchmarks/2026-10-14-proactive-brief-dev-preregistration.md) was frozen and pushed before
any spend. The run used gbrain v0.60.240.0 with Opus 5.5, Sonnet 5.5 and gpt-6.1-sol, 144 cells, and reports
[no improvement signal](docs/benchmarks/2026-10-14-proactive-brief-dev.md):

- Both arms finished 70/72 paired tasks: a difference of 0 points, 95% interval −5.5 to +5.5. Two of the four
  discordant pairs were provider errors.
- The guard check fails: the brief missed in 14 of 72 brief-on cells. Each miss was a Sonnet session that updated
  pages without calling `remember`, which left the brief no fact to push.
- The brief pushed one item per session, 397 characters at most, with 0 false pushes and no rise in confident-wrong
  answers.

This is development evidence only and does not decide the default. Spend was $27.85 of a new $45 ledger.

## [0.10.102] - 2026-10-14

### D5 brief parameters: the re-smoke passes

After gbrain #6708 fixed `list_write_conflicts`, the D5 brief Cat 40 smoke ran again under a dated
[Amendment 1](docs/benchmarks/2026-10-14-d5-brief-smoke-amendment-1.md). It compared master `3961bf16` (v0.60.232.0)
with gbrain #6703's head `f127b1b5`, using the same rules, tasks, models and arm.

It passes every preregistered check:

- Success was 29/30 on master and 28/30 on the head, within R1. Sol lost B01 and F01 and gained F02, and none of those
  cells used a brief parameter.
- Tool calls were at or below master for every model.
- No cell passed `counterparty` or `intent`.
- There were 0 output leaks and 0 unsafe writes.
- N6 found 0 findings of any kind on either build.

Spend was $6.78 of a new $10 ledger. See the [re-smoke verdict](docs/benchmarks/2026-10-14-d5-brief-smoke/resmoke-1/VERDICT.md).
The first run's verdict stands for its builds.

### The Cat 40 runner scrubs what it writes

Every file the Cat 40 runner writes under `--out` now goes through `scrubMachinePaths`. That covers
`experiment.json`, the receipt, results, attempts, transcripts, judge requests, served instructions and tools, and
`run.log`. The gbrain checkout is recorded as `gbrain@<sha>`, the slot root as `<slots>`, and other paths
repo-relative. A resume still binds to an `experiment.json` written before this change. The re-smoke record is the
first written this way, with no hand edits.

## [0.10.101] - 2026-10-14

### D5 brief parameters: Cat 40 smoke on gbrain #6703

gbrain #6703 adds `counterparty` and `intent` to `context_pack`. A preregistered Cat 40 smoke compared master
`14ea3e2e` with the PR head `e6575894` on Opus 5.5, Sonnet 5.5 and gpt-6.1-sol (10 tasks per model per build, callable
`full`, advertised `starter`). Success was 29/30 on master and 30/30 on the head. Tool calls stayed within the frozen
limit for every model, and no cell passed `counterparty` or `intent`.

An N6 fuzz with a new `counterparty` variant found 0 leaks in `context_pack`'s 540 probes, including the pulled brief.
The frozen verdict is "regresses, on L1 only". Both builds show the same 4 existence findings in
`list_write_conflicts` (#6643, already on master), where the op echoes a foreign `source_id` and returns no rows.

Spend was $6.78 of a new $10 ledger. See the [summary](docs/benchmarks/2026-10-14-d5-brief-smoke.md) and the
[verdict](docs/benchmarks/2026-10-14-d5-brief-smoke/VERDICT.md).

### Machine paths in committed receipts

The D5 record's receipts and experiment files now name builds as `gbrain@<sha>`, slot roots as `<slots>/…` and the
ledger as `.budget/d5-brief-smoke.sqlite`. The receipt machine-path test also now rejects Capy checkout and scratch
paths (`/workspace/…`, `~/.capy/…`, `$HOME/.capy/…`), which home scrubbing leaves in a form the old pattern accepted.
The 404 earlier receipts that contain them are frozen by hash in
`test/eval/fixtures/historical-capy-local-paths.json`.

## [0.10.100] - 2026-10-14

### N14 large-page fidelity: preregistered category and master baseline

New category N14 `large-page-fidelity` asks whether an agent can find and read what's deep inside one very large
document, and whether keeping it up to date stays cheap. The preregistration landed before any counted run. On gbrain
master `c71fe74` (v0.60.225.0), hermetic and at $0, each 2 MB document is stored but unsearchable (keyword recall@10
0 of 120 needles, all present in the stored body), `get_page` returns 1.5 to 2.0 MB, a 20 MB write is refused and a
200 MB write gets a retryable `queue_capacity` it can never pass (bug N14-4). The managed-parts arm (hub plus day
pages) finds 40 of 40 needles in every decile at 2, 20 and 200 MB, but a 1 KB append re-embeds 2.1 to 11.8 times the
appended text. The native arm reports "capability absent" until gbrain ships large-page reads. See the
[baseline report](docs/benchmarks/2026-10-14-n14-large-page-fidelity-baseline.md). Receipts now record a `--gbrain`
overlay as `gbrain@<ref>`, never a checkout path.

## [0.10.99] - 2026-10-14

### Query expansion latency: no expansion on `tokenmax` keeps quality at a ninth of the latency

GBRA-94 compared gbrain's `query` expansion setups on 300 LongMemEval-S questions, with embeddings and the reranker
frozen at the proxy so that only expansion varied ([preregistration and results](docs/benchmarks/2026-10-14-expansion-latency-preregistration.md)).

- **No expansion passes the preregistered rule and is fastest:** strict recall@10 299 → 298 (the reference's own re-run
  also scored 298), strict@5 287 → 285, nDCG@10 +0.0008, and end-to-end query time 2,022 → 227 ms p50 (2,292 → 384 ms
  p95). No expanding arm answered a question that the no-expansion arm missed.
- **Faster expansion models don't close the gap.** `claude-haiku-5-5` is 7% faster at p50 and 6x cheaper, but slower at
  p95. `gpt-6-luna` and `gemini-3.8-flash` are slower than Haiku 4.5 at their default reasoning, and Gemini fails nDCG
  on its 90-question screen.
- **Skipping expansion on pasted passages (≥30 words)** changes no score; a short-keyword rule fires on 1 query on this
  set.
- Spend about $4.71 of a $5 cap. This recommends a setting; it does not change gbrain's default.
- **Test flake fix:** the Cat 40 Hard 50k ledger test (`test/eval/cat40-hard.test.ts`) generates two 50k ledgers per
  seed, CPU-bound, and timed out at bun's 5 s default on a busy CI runner (5.6 s). It now has a 60 s test timeout, like
  the file's other heavy test; no assertion changed. Measured on a 4 vCPU cloud machine, Bun 1.4.3, one run each: 3.9 s
  idle; pinned to one CPU shared with two busy loops, it timed out at 5 s before the change and passed in 10.4 s after.

## [0.10.98] - 2026-10-14

### F5 owner-phrase precision on messy-company-v1: FAIL

gbrain's F5 owner-phrase linking at gbrain `4e10136b` derived 6 links across both splits of messy-company-v1. All 6
were correct, but 6 is below the 22-link minimum, and the Wilson 95% lower bound of 0.610 is below the 0.85 bar, so
the ship condition fails. Recall was 2 of 66 should-link phrases on dev and 4 of 58 on held-out, with 0 links on
should-not-link rows. The [run record](docs/benchmarks/2026-10-14-f5-messy-company/README.md) has the decision rule
(sha256 `6ca46ba4…0b11`), the scores and the scripts as run. The dataset's [USES.md](eval/data/messy-company-v1/USES.md)
now lists the run and records that the owner-phrases held-out split has been used once.

## [0.10.97] - 2026-10-14

### messy-company-v1: a frozen messy-company dataset with gold for 9 lanes

New reusable dataset [`eval/data/messy-company-v1`](eval/data/messy-company-v1/README.md): a fictional company
knowledge base of 226 pages (118 dev, 108 held-out, split by account cluster) with gold labels for owner phrases,
entity mentions, aliases, ownership windows, governing records, document status, timelines, changes and agent tasks.
`gpt-6.1-sol` and `gemini-4-argon` wrote the pages, each checked by the other model. 91 of 1,740 labeled items
disagreed (5.2%), and every disagreement was adjudicated by reading the page. Gold comes from the world plan's oracle,
never from a model. `validate-data` now fails if any data file drifts from the frozen manifest (dataset hash
`4a6bd099…4568`). It adds a loader, nine scorers and tests. Model spend was $4.45.

## [0.10.96] - 2026-10-14

### Cat 41 fifth-run report: reading times corrected

The [fifth setup report](docs/benchmarks/2026-10-14-cat41-setup-run5.md) said C r1 and C r2 spent 26.2 and 15.0 s
reading the install guide, against 4.5 and 4.6 s in the fourth run. Those numbers came from tables built two
different ways. Measured the same way, the guide reads took 14.4, 16.9 and 10.2 s against 14.5, 6.9 and 8.2 s. Only C
r2 read for longer, after its own `ls` exited 2 and cut its first fetch short. The report has a dated correction note
and a rebuilt "Where the time went" table. A new descriptive appendix gives the C runs' path through gbrain's docs,
and a phase split of the wired-recall runs against the fourth run. No verdict, score or results artifact changed.

## [0.10.95] - 2026-10-14

### Cat 41 setup, fifth run: first push met on v0.60.219.0

The fourth run's preregistered design, unchanged except the gbrain version (scorer `cat41-score-v8`,
[preregistration](docs/benchmarks/2026-10-14-cat41-setup-run5-preregistration.md) at `b2e32ccb`, approved by GBRA-40
before any paid cell). On v0.60.219.0, with `claude-opus-5-5`, 3 runs per cell and the frozen targets:
- First push: met, 3/3. The SessionStart hook printed the preference into every fresh session, and no agent also
  saved it to Claude Code's own memory.
- Wired recall: missed, 60.2 s against 60 s.
- Consent: met, 0 provider requests.
- Faster setup: missed, 2.8% (the same on reading).

No `setup` run ran `gbrain apply-migrations` by hand, and a positional `gbrain recall "<question>"` returned the saved
fact in all 3 D runs. The fourth run's verdicts stand. $6.56 of a $10 ledger cap
([result](docs/benchmarks/2026-10-14-cat41-setup-run5.md)).

## [0.10.94] - 2026-10-13

### Vector side alongside the keyword arms: about 150 ms faster per search on a 20,000-page Postgres brain

gbrain v0.60.214.0 (gbrain#6641) starts the query embed and expansion with the keyword arms instead of after them
([report](docs/benchmarks/2026-10-13-vector-side-early.md)). Median warm `search` went from 578 / 572 ms to
424 / 402 ms and `query` from 578 / 548 ms to 448 / 428 ms on a 20,000-page Postgres brain with Voyage. On a 400-page
PGLite brain the saving is only the 13 to 15 ms the keyword arms take. Results are unchanged: the bench digests match
master, and with stub providers on the 20k brain all 80 result lists match. About $0.40 in provider calls.

## [0.10.93] - 2026-10-13

### Reranker settings addendum: rerank-3-lite at the shipped shape cuts rerank cost 60% with no loss

GBRA-86 re-ran the frozen LongMemEval-S candidate lists (300 questions) under Voyage `rerank-3` and `rerank-3-lite`,
with a fresh reference run and per-query reranker latency ([addendum](docs/benchmarks/2026-10-13-rerank3-addendum-preregistration.md)).

- **`rerank-3-lite`, 50 candidates × 1,400 tokens, passes the preregistered rule:** strict recall@10 299 → 298,
  strict@5 288 → 289, nDCG@10 −0.0012, and rerank cost $1.51 → $0.60 per 1,000 queries (−60%). Reranker latency is
  about the same (p50 232 → 251 ms, p95 596 → 604 ms).
- **`rerank-3` at the same shape** passes at today's price and has the best strict@5 (291).
- **Cutting candidates to 25 or 15** takes 8–17% off p50 latency but loses 3–5 questions on strict@10 with either
  model, so it fails, as in 0.10.84.
- **The reference reproduced:** fresh `rerank-2.5` calls jittered scores by up to 0.003 and flipped no question.
- Spend about $3.74 of a $5 cap. This recommends a setting; it does not change gbrain's default.

## [0.10.92] - 2026-10-13

### Receipt source-tree hash reads only changed files

The intermittent 2-failure run of the receipts tests (`round-trips atomically` timed out, then `writeReceipt stores
the executed source tree` saw `dirty: null`) came from `sourceTreeIdentity`. The first receipt in each process
hashed every byte of the evals tree, about 1.7 GB of committed artifacts: 1.4 s warm, 2.3 s cold and over 5 s under
load on a 4-core machine, inside a test with Bun's 5 s timeout. A timeout during `git status` also left `dirty: null`
cached for the rest of the process.

- The hash now takes each file's blob id from git's index when `git status` reports the file unchanged, and reads
  and hashes (as a git blob) only changed and untracked files: 0.1 to 0.4 s warm, 0.6 to 0.7 s cold under load.
  For the evals tree and for clones with modified, untracked, deleted, staged, renamed, touched and copied files,
  the result matched a full read of every file.
- The field is versioned. New receipts write `execution.source_tree.scheme: "git-index-blob-v1"` next to `sha256`,
  which is sha256 over (name, git blob id). Receipts written before v0.10.92 have no `scheme`; readers
  (`sourceTreeScheme`) treat them as `legacy-full-read`, sha256 over (name, size, bytes). The validator accepts
  `git-index-blob-v1` or no scheme and rejects anything else. Hashes from the two schemes are not comparable, and
  nothing in the repository compares them. A test pins both: a new receipt carries the scheme, and a legacy receipt
  without one still validates and loads.
- A failed or interrupted git call returns an identity with an error and is no longer cached. A new test makes
  `git status` fail once and checks that the next call hashes the tree.

No assertion or timeout was loosened. A forced probe (cold page cache plus six CPU hogs, the targeted receipts
command, default timeout) failed all 6 trials before the fix and passed all 9 after.

## [0.10.91] - 2026-10-13

### Cat 41 setup, fourth run: push delivers a preference; first push 1/3

A new preregistration, written after the v0.60.208.0 results and approved by Garry, made three changes (scorer
`cat41-score-v8`): a world-visible preference ("I take my coffee black, with a pinch of cardamom") as the first-push
item, any unambiguous form of the expected date, and an agent's save-and-recall smoke fact counted as its exempt
install check. On v0.60.208.0, with `claude-opus-5-5`, 3 runs per cell and the frozen targets:
- First push: missed. The SessionStart hook printed the preference into all 3 fresh sessions, but the target was met
  in 1 of 3 runs, because two agents also saved the preference to Claude Code's own memory.
- Wired recall: met, 55.5 s.
- Consent: met, 0 provider requests.
- Faster setup: missed, 20.7% (18.4% on reading).

$7.58 of a $10 ledger cap ([result](docs/benchmarks/2026-10-13-cat41-setup-run4.md),
[preregistration](docs/benchmarks/2026-10-13-cat41-setup-run4-preregistration.md)).

## [0.10.90] - 2026-10-13

### Low-hanging fruit plan: published with its outcome

[The plan](docs/plans/2026-10-11-low-hanging-fruit/PLAN.md) and its autoplan review record (CEO, DX and Eng phases,
each with a native Claude Opus 5.5 and an outside GPT-6 Astra reviewer) are published, approved by Garry on
2026-10-12 and closed on 2026-10-13. Items 0, 1b and 2 to 5 shipped in gbrain v0.60.178.0, v0.60.188.0 and
v0.60.205.0. The `balanced` new-install default did not ship because its Cat 40 gate was inconclusive. The measured
verdicts are in the [wave report](docs/benchmarks/2026-10-12-lhf-wave.md).

## [0.10.89] - 2026-10-13

### Cat 41 setup on gbrain v0.60.208.0: wired recall and consent met, first push missed

The third preregistered measurement of `gbrain setup claude-code` ran on the published v0.60.208.0 (`febbd4ebc`, #6612),
with `claude-opus-5-5` on Claude Code, 3 runs per cell and the second run's frozen targets and scorer.
- Wired recall: 54.3 s mean, 3/3 (met).
- Consent: 0 provider requests in each of 3 runs, `GET /v1/models` included (met).
- First push: 0/3 (missed). All three agents saved the locker code as a private fact, which push never carries.
- Faster setup: missed as scored (C 1/3, after a correct day-first date and an install test fact failed the frozen
  rules); 28.1% faster on reading.

The runner's preflight cost estimate now counts only runs still to do (preregistration Amendment 1); no measurement
changed. $7.13 of a $10 ledger cap ([result](docs/benchmarks/2026-10-13-cat41-setup-v208.md),
[preregistration](docs/benchmarks/2026-10-13-cat41-setup-v208-preregistration.md)).

## [0.10.88] - 2026-10-13

### W1 guidance smoke (A12g): fails, guidance stays parked

A preregistered one-shot smoke installed the gbrain plugin natively in Claude Code from gbrain `d5a86e4f8` (master
`148b74d14` plus the `recall` `question` guidance) and ran A12's prompt and MCP setup in 5 fresh sessions per model.
Opus 5.5 passed 2 of 5 and Fable 5.1 passed 5 of 5; the rule needs both at 4 of 5, so the guidance stays parked. No
session invoked a skill, though `brain-ops` and `query` were listed in every one. All 30 answers were correct. $3.43, run
once, none replaced ([result](docs/benchmarks/2026-10-13-w1-guidance-smoke.md),
[preregistration](docs/benchmarks/2026-10-13-w1-guidance-smoke-preregistration.md)).

## [0.10.87] - 2026-10-13

### Low-hanging-fruit wave item 5: per-stage search timings change no results

gbrain v0.60.205.0 (gbrain#6601) reports per-stage timings in `_meta.retrieval.timings` and `--explain`. On the
keyless 400-page refactor-wave-1 bench, all 40 result digests match master before the merge and no time went
unclaimed by a stage (`other_ms` 0 on every response); added to the
[wave report](docs/benchmarks/2026-10-12-lhf-wave.md#item-5-per-stage-search-timings-no-paid-run) with receipts. No
paid run.

## [0.10.86] - 2026-10-13

### Cat 41 setup re-measure on gbrain v0.60.203.0: three of four targets still missed

The preregistered re-measure of `gbrain setup claude-code` on gbrain v0.60.203.0 (`449483cc7`, with gbrain#6562 and
#6572), scorer v7, Opus 5.5 on Claude Code, n = 3 per cell, against the same frozen targets
([report](docs/benchmarks/2026-10-13-cat41-setup-remeasure.md); Amendment 1 pushed before the first paid cell).

- **Wired recall missed:** 3/3 correct, 67.8 s mean against 60 s (first run 83.8 s); no install session ended on a
  question.
- **First push missed, 0/3:** two agents saved the item with `gbrain capture` (a page) because `remember` is missing
  from `gbrain --help`; in the third the fact was saved and the SessionStart hook still printed nothing.
- **Faster setup met as scored, not on reading:** 26.5% lower median than by hand as scored; 19% on reading, because
  the frozen date rule rejected one correct by-hand answer written day-first ("14 November 2026"). The claim is not
  made.
- **Consent missed:** 2 of 3 runs sent an unbilled `GET /v1/models` from a `gbrain doctor` run before setup recorded
  the provider decline; doctor runs after the decline sent nothing.
- Descriptive cell F (the comparator's own prompt): 56.2 s mean; all three agents chose `setup` unprompted. Spend
  $6.65 of a $25 cap.

## [0.10.85] - 2026-10-13

### Memory proof wave 2: question-ranked combined recall passes its gates; adaptive W5 ships on at 1.50

Wave 2 confirmed gbrain's question-ranked combined lane (`combined-v2`) at gbrain `71b6d85`, the head of #6445
([results](docs/benchmarks/2026-10-13-memory-proof-wave-2-results.md), [preregistration](docs/benchmarks/2026-10-10-memory-proof-wave-2-preregistration.md)
and [addenda](docs/benchmarks/2026-10-10-memory-proof-wave-2-preregistration-addenda.md)).

- **Gate 1, LongMemEval-S (400 questions):** +14.00 points over the old combined lane (lower bound +10.96) and
  non-inferior to pages alone (+2.75, lower bound −0.87 against −2).
- **Gates 2 and 3, 72 BEAM conversations:** +1.62 over the old combined lane [+0.49, +2.79], and +3.97 over the
  memory-bank server it was compared against [+2.63, +5.33], at the same 8,000-token budget.
- **Adaptive W5 passes at factor 1.50** (−0.25 points pooled, [−1.00, +0.49]; no question kind below −3), so the
  default flips on. The factor was set by an amendment after the dev re-tune, recorded beside the result.
- **Cost per correct answer** is 0.750× the comparator's at R = 20 [0.727, 0.773]. Gate 4 (W3) failed under A15,
  which changes W3's ship form only. LoCoMo10 was not run.
- Confirmation spend $398.04; wave 2 $591.35 in all, before A15's own spend.

## [0.10.84] - 2026-10-13

### Reranker settings on LongMemEval-S: no cheaper setting holds recall, keep the default

GBRA-86 reranked frozen candidate lists for 300 stratified LongMemEval-S questions under 18 cheaper settings and the
shipped one (50 candidates × 1,400 tokens × `rerank-2.5`), through the pinned `gbrain-defaults` shim at gbrain master
`0832f9fe` ([preregistration and results](docs/benchmarks/2026-10-12-rerank-settings-preregistration.md)).

- **No cell passes the preregistered rule.** Every 25-candidate cell loses 3 questions on strict recall@10 (the rule
  allows 2) and none gains; 15 and 10 candidates lose 5 to 6, mostly temporal-reasoning.
- **Nearest misses:** 25×1400 `rerank-2.5` would halve the rerank cost (−3 strict@10, nDCG +0.0008); 25×512
  `rerank-2.5-lite` would cut it 83% (−3 strict@10, −8 strict@5).
- **A 768-token document cap saves 1%:** conversation chunks are mostly shorter than that.
- Clean reads 300 of 300 in every cell; spend about $6.33 of an $8 cap.

## [0.10.83] - 2026-10-12

### BEAM-1M S1: the harness reranks by default; the diverse pool and wider reading stay off

Wave 3's S1 measured the three fixes the BEAM-1M failure analysis ranked, on the BEAM-1M dev split with Opus 5.5,
Sonnet 5.5 and gpt-6.1-sol ([report](docs/benchmarks/2026-10-12-beam-1m-s1-fixes.md), preregistered with two
amendments).

- **The memory-qa harness reranks by default and fails closed** (`RERANKER_INACTIVE`) when a query is not reranked.
  At gbrain master that raises strict recall at 5 from 46 to 55 of 198 (+4.5 points, [1.5, 8.1]). This is a harness
  change, not a product change: BEAM-1M numbers from the old harness (reranker off) are not directly comparable.
- **`search.diverse_pool_depth=100`** (gbrain#6568, shipped off): strict recall at 10 +3.5 [0.0, 6.6], answers within
  ±0.4 points per reader. Two of three preregistered flip rules fail, so the default stays off.
- **Reading 10 turn groups instead of 5:** answers +2.0 [-0.7, 4.7] for gpt-6.1-sol, with abstention down from 63.6%
  to 43.2%; the default stays 5.
- **Readers on identical evidence:** Opus 5.5 69.7%, Sonnet 5.5 68.1%, gpt-6.1-sol 66.7%, not distinguished; no-memory
  floors 30.0%, 32.0% and 28.6%.
- Spend $55.45 of a $60 cap.

## [0.10.82] - 2026-10-12

### Cat 41: the scripted user answers both install arms alike; setup re-measure preregistered

- **Scorer `cat41-score-v7`.** The October 12 setup TTHW's scripted user replied to the by-hand arm's closing question
  and missed the setup arm's wording, so the arms got unequal help. v7 sends one fixed reply ("Use the defaults you
  recommend and go ahead.") whenever an agent's turn closes by asking for input or gbrain is not registered yet, at
  most 3 per run, in every install arm; counts closing and unanswered closing questions; detects `gbrain setup`
  through any gbrain launcher; and, in the consent-negative scenario, counts any provider request, the unbilled model
  list included.
- **Re-score beside the published report.** The #136 report stands as published. Re-scored under v7, the setup arm
  has 3 unanswered closing questions (interventions 3 by hand and 3 with setup, where v6 counted 3 and 0; the
  faster-setup rule is still met on those transcripts) and every consent run has 1 violation. Descriptive only.
- **Re-measure preregistered** ([preregistration](docs/benchmarks/2026-10-12-cat41-setup-remeasure-preregistration.md)):
  the same frozen targets on a gbrain release containing gbrain#6562 and gbrain#6572, Opus 5.5 on Claude Code, n = 3
  per cell, a new $25 ledger. Paid cells wait for that release and an amendment naming its commit.
- **Runner errors.** Nineteen eval runners print an error's message before its stack: under load Bun sometimes printed
  the stack without the message line (12 of 240 runs before, 0 of 480 after).

## [0.10.81] - 2026-10-12

### Low-hanging-fruit wave paid gates: `query` expansion follows the mode; `balanced` stays opt-in

The paid gates of the low-hanging-fruit plan (#134), run at gbrain `f77f1418c` under the
[preregistration](docs/benchmarks/2026-10-12-lhf-wave-preregistration.md)
([report](docs/benchmarks/2026-10-12-lhf-wave.md)).

- **Item 1b passes.** On `balanced`, `query` without expansion answered 451 of 470 LongMemEval-S questions in strict
  `recall_all@5`, against 448 with expansion (+5/−2, lower bound −0.21 points). Operation latency p50 fell from
  2,216 ms to 370 ms. gbrain's `query` now expands only when the search mode says so.
- **Item 1's default flip does not ship.** `balanced` tied `tokenmax` on LongMemEval-S, 451 vs 451 for both `search`
  and `query` with expansion off, so both comparisons passed. The Cat 40 Hard world M rerank-pool replay was
  inconclusive: gold hit@5 37.0% under a 25-row pool against 37.9% under 50 over 966 calls (−0.93 points, lower bound
  −1.55, needs above −1.0). New installs with a chat key are still recommended `tokenmax`.
- **Tooling.** The via-operation LongMemEval driver, its analysis script with unit tests, the arm runner and the Cat 40
  rerank-pool replay runner. Spend $13.64 of a $30 cap.

## [0.10.80] - 2026-10-12

### Cat 41: time to a working memory with `gbrain setup claude-code`

The wave 2 measurement of `gbrain setup claude-code` on gbrain v0.60.184.0 (`a618302c9`), with real Claude Code
sessions on Opus 5.5, three runs per cell, against targets frozen before any paid session
([report](docs/benchmarks/2026-10-12-cat41-setup-tthw.md),
[preregistration](docs/benchmarks/2026-10-12-cat41-setup-tthw-preregistration.md)).

- **Wired recall missed:** 3/3 correct, 83.8 s mean against the 60 s target (the documented path on v0.60.130.0 was
  98.8 s).
- **First push missed, 0/3:** the SessionStart hook prints nothing while Claude Code is still starting gbrain's
  server, so no fresh session saw the remembered item without a tool call.
- **Faster-setup threshold met as scored:** 35% lower median than the by-hand path on the same release. Only the
  by-hand runs got a scripted reply; without that session the gap is 23%, under the 25% threshold. Both are reported.
- **Consent negatives not met as written:** no capture, no unrequested fact write and no paid request, but every run's
  `gbrain doctor` sent one unbilled `GET /v1/models` with the user's key.
- **Harness:** five named-only Claude Code scenarios (the release-gate `all` set is unchanged), scorer v6 (re-scoring
  the published re-baseline gives identical scores) and a recorded `--preregistration` attestation. Spend $8.37 of a
  $25 cap.

## [0.10.79] - 2026-10-12

### Cat 40 warm boot waits for gbrain's persistence drain; D2/D4 smoke records

- **Harness fix.** gbrain answers tool calls while it is still draining queued persistence effects. The Cat 40 warm
  boot treated the first answer as the end of the drain, stopped the server and snapshotted the slot: one master slot
  was saved with 5,081 effects still queued. `eval/runner/cat40/gbrain-arm.ts` now holds the server until gbrain
  reports no drain in progress; the rebuilt slot has 0 queued.
- **D2/D4 smoke** ([verdict](docs/benchmarks/2026-10-12-d2d4-smoke/VERDICT.md), preregistered with one amendment
  written before any cell). D2's `hidden_tool_content` notice passes: gpt-6.1-sol 10/10 on the branch against 1/10 on
  master, Opus 5.5 and Sonnet 5.5 10/10 (all at the ceiling, so the smoke cannot rank them), 0 leaks, 0 unsafe writes,
  0 `unknown_tool` answers after a notice. D4's `grant_blocked_operations` is not exercised by Cat 40's stdio arm, as
  preregistered. Spend $3.30 of an $8 cap.

## [0.10.78] - 2026-10-12

### Retire the Cat 40 v1 success headline

The README's Cat 40 row reported 95.6% success for gbrain and for plain files on five frontier models. gbrain ran
without its reranker in all 500 of those cells (gbrain-evals #110), and the world is at its ceiling, so a rerun could
only confirm parity. The claim is retired without a rerun.

- **Kept:** the permission result, 0 of 100 finance-only leaks into the agent's context, which does not depend on
  reranking.
- **Retired:** the frontier tie and the older six-model lead (75.7% against 72.8%), on the README and as the current
  reading of the [Cat 40 report](docs/benchmarks/2026-10-02-model-ladder.md#retired-2026-10-12). Its numbers stay as
  measured.
- **Replaced by:** a README row for the [Cat 40 Hard confirmation](docs/benchmarks/2026-10-10-model-ladder-hard-confirmation.md),
  where gbrain is ahead of plain files by +7.7 points on a fresh world and +13.0 on a sealed one with reranking
  verified.

## [0.10.77] - 2026-10-11

### T0b sealed confirmation: 10x fewer end-to-end memory failures than v0.60.106.0

The custodian-sealed run preregistered in T0b amendment 5 compares the shipped stack, gbrain v0.60.174.0
(`0df9f2ee7`), with the frozen v0.60.106.0 (`7aa2caa0`) on 32 personas minted on the maintainer's Mac
([report](docs/benchmarks/2026-10-11-t0b-sealed-confirmation.md)).

- **Verdict `10x` under `t0b-score-v2`.** The stack fails 5 of 576 runs and the frozen release fails 271 (failure
  ratio 0.020, 95% interval 0.006 to 0.045). Opus 5.5 goes from 142 to 0, Sonnet 5.5 from 124 to 5, and gpt-6.1-sol
  from 5 to 0, near its ceiling and inconclusive on its own.
- **Under `t0b-score-v1` the verdict is `improvement`** (273 to 13, factor 20, interval 0.019 to 0.101).
- **Validity held.** Both mutants were detected in 144 of 144 runs, every cell was scored, and the stack stayed inside
  the resource envelope for every reader.
- **Cost.** The sealed ledger committed $232.01 of its $265 cap; the round stands at $370.12 of the approved $420.
- **Records are aggregates and receipts only.** Per-cell scores, receipts, cost records, paired statistics and status
  logs are committed under `docs/benchmarks/2026-10-08-program-primary-hard/sealed-confirmation/`. No world file,
  seed, sealed documents, task text or transcripts are.

## [0.10.76] - 2026-10-11

### Re-pin to gbrain v0.60.169.0 (`77cf8e111`)

gbrain-evals installs gbrain release v0.60.169.0, master `77cf8e1116e9af67c1983adcbb3223b96f0991a5` (was `8a3eedeac`,
v0.60.126.0, 43 first-parent merges earlier), after a preregistered keyless regression check on paired Ubicloud VMs
([report](docs/benchmarks/2026-10-11-wave14-repin.md), [preregistration](docs/benchmarks/2026-10-11-wave14-repin-preregistration.md)
with four amendments). The keyless runs cost $0 of provider spend and the paid N2 judge arm cost $7.07.

- **No gbrain regression.** All 34 offline-tier categories pass at `77cf8e111`. Full N1 and N5 pass on PGLite and
  Postgres through every interface. N6 on Postgres over HTTP passes with 155 of 155 cells and 0 leaks, and N6 and N8
  pass attested. Every ledger repro, every preregistered check and the memory trust repros 37-1, 37-2 and 37-5 pass.
- **Memory trust gates.** `eval/registry.ts` drops the hold on Cats 37 to 39. They fail at `8a3eedeac`, which
  predates the feature, and pass every keyless contract at `77cf8e111`.
- **The counted pair's two rule breaks were not gbrain.** N6 on Postgres lost `recall` coverage at the new pin (153
  of 155) through harness defect N6-5. Cat 7 ran 1.3 to 2.7 times slower on every operation, `putPage` included,
  because of the after VM's host. Two fresh hosts each running both pins (amendment 3) show N6 complete at both pins,
  no Cat 7 operation more than 25% slower on both hosts, and the Cat7-1 repro passing at both pins. Cat7-1 stays
  open: `get_timeline` p50 at 1,000 pages is 0.075 to 0.078 ms against the 0.056 ms closure bar. `traverse_paths_d1`
  at 1,000 pages ran 20% to 30% slower in three pairings; it is below the confirmed-regression rule and recorded as
  the operation to watch.
- **Four harness fixes, each with a test, none changing a result at the old pin.**
  - N6 decodes `delta`'s base64 cursors before masking them (N6-4).
  - Cat 39 reads a fact row's page from `page_slug` (39-8, found when #6066's query facts arm returned fact rows).
  - N6 gives an optional `question` its own variant without `include_expired` and `supersessions`, which `recall`
    refuses alongside it (N6-5).
  - The operator-wave check `edit-page-diff-order` reads the `edit_page` receipt block and ignores appended notice
    blocks.
- **A flaky harness test made deterministic.** `test_facts_extraction_and_lanes` (`eval/harness-provider/`) stores
  one identical stub fact from five extraction windows running eight at a time. gbrain keeps the first insert, so the
  conversation that owns the fact depended on timing. It failed on one core at both pins and in four of seven CI
  runs on this branch. The test now extracts one window at a time with `d-a1` first, and it passes on one core at
  both pins.
- **Pin-following updates.** N12 renders gbrain's new `plain-role-no-time` pattern (29 of 29 formats). Four tests
  that assumed the old pin's behaviour were updated (`tool-bridge`, `pglite-snapshot`, `cat38-state-resolution`,
  `budgeted-delivery-h1`). The VM scripts for this check live in `docs/benchmarks/2026-10-11-wave14-repin/vm/`.
- **Docs.** README, `docs/README.md`, `docs/settings.md`, `docs/comparison-systems.md`, `docs/retrieval-lessons.md`,
  `eval/README.md` and `eval/CONTRIBUTING.md` name the new pin. README moves the rows rerun here to `77cf8e111` and
  adds the features the old pin predated, each on evidence measured inside the new pin's history: memory trust
  labels, the verbatim-quote probe, scoped vector search and the matched BEAM comparison.
- **Paid N2 judge arm at the new pin (approved, $7.07 of a $30 cap).** The judge (`claude-haiku-4-5-20251001`, prompt
  version 4, the same inputs to the token as the published run at `48ed5e8`) called 146 of 150 planted conflicts
  contradictions, against 149. It flagged 0 of 40 dated changes and 4 of 51 compatible pairs (6 of 51 before), so all
  three of the report's decision rules hold. The three lost conflicts are sampling variation (exact McNemar p =
  0.25). README's N2 row moves to `77cf8e111` with 146 of 150. 2,774 requests went through the budget ledger, all
  reconciled to provider usage, none refused.
- **Recorded commits stay.** The sealed MPW (`d7467d1cf`), H1 (`8a3eedeac`), Q1 (`f05943e6`, `7aa2caa0`) and Cat 40
  runs keep the commits they recorded. The report lists every place that reads the installed pin, including the Q1
  campaign custody hash, which covers `package.json` and `bun.lock`.

## [0.10.75] - 2026-10-11

### Cat 40 Hard fix wave: plan, development record, preregistration and results

The records behind the October 10 confirmation (released in 0.10.74) move from the plan branch to main, under [docs/plans/2026-10-07-cat40-hard-fix/](docs/plans/2026-10-07-cat40-hard-fix/). No paid call ran for this release.

- **[PLAN.md](docs/plans/2026-10-07-cat40-hard-fix/PLAN.md)** and **[DEV-RECORD.md](docs/plans/2026-10-07-cat40-hard-fix/DEV-RECORD.md):** the fix wave's plan and its development rounds on the calibration world, with the root-cause scripts `rca.py` to `rca4.py`. The development record now carries the alias precision check (2026-10-11): on the owner's real brain the anchored rule was right on 25 of 25 aliases, and on 890 public Wikipedia articles on 20 of 25. Garry Tan accepted it with multi-word captures on. It also records that gbrain #6271 merged as v0.60.174.0 (master `0df9f2ee7`), whose build derives identically to the confirmed `3e4ff61ce` on worlds M and S, the calibration world and the v1 world.
- **[PREREG.md](docs/plans/2026-10-07-cat40-hard-fix/PREREG.md):** the confirmation preregistration with everything recorded before cells (world digests, custody VMs, ledgers, oracle gates, the slot allowance and the $900 caps).
- **[RESULTS.md](docs/plans/2026-10-07-cat40-hard-fix/RESULTS.md):** the verdict ("ahead" in both worlds; Δ_M +7.7, Δ_S +13.0), per-model and per-family tables, secondary measures (wrong answers, stops, cost per success, seconds per cell, the rerank check, DX measures), costs with the ledger overstatement explained, the deviations log and the weaknesses. Computed with `confirm_secondary.py`, which prints counts only.
- **[SEALED.md](docs/benchmarks/cat40-hard/SEALED.md):** the sealed 50k world was generated on 2026-10-10 on the owner's Mac (its digest matched the committed one) and ran once in the confirmation; only aggregates are published, and the seed, documents and task text stay in owner custody. It is no longer a first-look held-out set: a future result on it is a repeat measurement, and the next confirmation needs a new sealed seed.
- **Version.** Main is at 0.10.74, so this release is 0.10.75.

## [0.10.74] - 2026-10-11

### Cat 40 Hard confirmation: gbrain ahead of plain files on a fresh and a sealed 55,000-document company

On two worlds no development agent had seen, Sonnet 5.5, Opus 5.5 and GPT-6.1 Sol finished more Hard tasks with gbrain v0.60.139.0 (`3e4ff61ce`, gbrain #6271, since merged as gbrain v0.60.174.0, master `0df9f2ee7`) than with plain files: +7.7 points on world M (fresh seed 20261021; 78.7% vs 71.0%, 95% CI +2.7 to +12.7) and +13.0 points on the sealed world S (66.0% vs 53.0%, CI +7.7 to +18.3). Both lower bounds are above 0, so the preregistered wording is "ahead" in both worlds and the kill criterion does not fire. Limits: gbrain trails on M's conflicting-source family H4 (47 vs 56 of 60), S's H1 is at the floor on both arms, fs overflowed the context 22 times on S at the fixed 16-turn cap, and gbrain gives more wrong answers. Report: [docs/benchmarks/2026-10-10-model-ladder-hard-confirmation.md](docs/benchmarks/2026-10-10-model-ladder-hard-confirmation.md); preregistration and full results in `docs/plans/2026-10-07-cat40-hard-fix/` (#93). Ledgers $572.34 (M) and $775.63 (S) of $900 each.

- **Confirmation steps.** `scripts/cat40-hard.sh step confirm-world|confirm-slots|confirm-oracle|confirm-cells` per world (`CONFIRM_WORLD=main|sealed`), seed 20261021 registered as `HARD_SEEDS.confirmation`, one ledger per world (`CONFIRM_CAP_USD` 900), and the 95% oracle gate.
- **Warm-boot fix.** The slot build's warm start waits for the reply to one read-only `entity` call before the snapshot, so the snapshot no longer keeps tens of thousands of queued persistence effects that stalled every restore's first tool call; each slot receipt records `queued_effects` at snapshot.
- **Rejected requests settle at $0.** The metering proxy's in-process mode (gbrain's own provider calls) now settles a 4xx answer without usage at $0, as lease mode and the paid-request guard do; a 413 or a prompt over the context window no longer books its whole reservation.
- **One implementation each** after merging main: `rerankProbe` and `refreshProviderBaseUrls` live in `eval/runner/cat40/gbrain-arm.ts` (the runner re-exports the probe), and every slot start refreshes the Voyage base URL and advertised surface through `refreshProviderBaseUrls`; `MeteringProxy` lives in `eval/runner/metering-proxy.ts`.

### Cat 40 Hard result: gbrain trails plain files by 11.3 points on the 55,000-document company

On 100 unseen Hard tasks, Sonnet 5.5, Opus 5.5 and GPT-6.1 Sol finished 62.0% with gbrain v0.60.95.0 and 73.3% with plain files (paired difference −11.3 points, 95% CI −16.7 to −6.0); Postgres search finished 68.3%. The gap is wrong answers (gbrain 50, fs 13), not turn caps. The preregistered decision is "gbrain behind": the next wave targets retrieval on H1 aggregation, with alias resolution, current-value preference and cross-session recall as the concrete fixes. Fable 5.1's finished cells (descriptive, amendment A6) went the other way: 65% with gbrain, 20% with plain files. Report: [docs/benchmarks/2026-10-07-model-ladder-hard.md](docs/benchmarks/2026-10-07-model-ladder-hard.md). Hard ledger $2,000 of $2,044.

- **Exploratory gbrain-fs arm (plan C16).** `--arms gbrain-fs` gives the agent every gbrain tool plus the fs arm's read tools (`list_dir`, `grep`, `read_file`, same limits) over the same files, with writes through gbrain only (no `write_file`), to ask whether gbrain beside the files beats files alone. Cells are labelled `<gbrain-label>+fs`; a gbrain tool named like an fs read tool is refused; the arm runs only on the calibration-seed development world outside any program step (`HARD_ARM_EXPLORATORY`) and records `exploratory: true` in `experiment.json` and the receipt. No cell has run.

### Cat 40 Hard round 4: questions about several accounts; the held-out run is 50k only

Round 3 (50k, generator v2) left the better simple arm at 83%: H1 fell to 15-20%, but H2 to H5, which each asked about
one account, stayed at 85 to 100%. Under amendment A2, H2 to H5 questions now ask about several accounts at once and H1
sets shrink. No paid call ran; round 4 is ready to calibrate.

- **Multi-account questions.** Knobs `multi_account_min` and `multi_account_max` set how many accounts each H2 to H5
  question asks about; [knobs.round-4.json](docs/benchmarks/cat40-hard/knobs.round-4.json) uses 2 to 3. A question
  lists its items as numbered one-account questions, each a complete instance of its family with its own records, and
  asks for a JSON array of the answers in order. No two accounts in a question share a descriptor, first word, code
  prefix or account manager, so each needs its own search. With a maximum of 1 the generator writes the v2 world, and
  the round-3 world is unchanged.
- **Scoring.** The Hard scorer grades the array as a new `values` answer kind (`cat40-hard-score-v2`): each element is
  graded like a one-account answer, and success needs every element right. Earlier answer kinds score as before. The
  validator checks every item's accounts and the unlinked rule, and the H5 write diagnostic matches each superseded
  fact to its own chain.
- **Smaller H1.** Round 4 asks for 6 to 12 members (round 3: 10 to 40). When a predicate cannot land in range, the
  generator narrows it to one region or segment.
- **Held-out path.** The held-out run is 50k only: freeze check, freeze, smoke, the 50k world, slots, then four batches
  that each run after the one before (gbrain and fs, the oracle, pg, memory on two models), each with its own
  projection and ledger gate. `slots-4k`, `simple-4k`, `comparator` and `gbrain-4k` stop with `HARD_STEP_RETIRED`.
  The primary endpoint is `holdout_stats.py --hard-headline gbrain-hard,fs --simple fs`, adding pg when it ran.
- **Proxy.** `hard-proxy.ts` also reports oracle documents and accounts per answer. On the 50k calibration world,
  H2 to H5 answers now need 2.4 to 2.7 accounts and two to three times the oracle documents
  ([calibration.md](docs/benchmarks/cat40-hard/calibration.md)).

### Cat 40 Hard generator v2: records stop naming their account

Calibration round 2 left plain files at 95%: agents searched for the account name in the question and read every
record, because every record named the account. Generator `model-ladder-hard-v2` (amendment A1) keeps every fact and
answer key and changes how records refer to accounts. No paid call ran; round 3 is ready to calibrate on the 50k world.

- **Reference forms.** Each account reference in an event record uses the account's name, its code, its nickname, or
  `<manager>'s <region> <industry> account`, meaning the account that manager held on the record's date. Knobs
  `direct_name_share`, `code_ref_weight`, `nickname_ref_weight` and `manager_ref_weight` set the mix;
  [knobs.round-3.json](docs/benchmarks/cat40-hard/knobs.round-3.json) starts at 15% by name and about 30%, 30% and 24%
  for the others. CRM records, new account sheets, rename and merger notices name the account and resolve the other
  forms in at most two hops. A manager reference is used only where it fits one account on that date from the records
  written by then. Event documents get opaque ids, so paths never name an account. A knob file without the new keys
  writes v1's worlds byte for byte (rounds 1 and 2 still regenerate); with `direct_name_share` 1 the documents and
  tasks are v1's.
- **Checks.** `hardWorldProblems` checks every reference: its text is in its document, a reference not by name never
  names the account, a manager reference fits one account, every code, nickname and descriptor is introduced on or
  before its use, and every task's oracle documents tie each reference to the asked name. Oracle evidence carries the
  resolution documents each record needs. [WORLD_SCHEMA.md](docs/benchmarks/cat40-hard/WORLD_SCHEMA.md) states the
  rules for the sealed generator.
- **Difficulty proxy.** `bun eval/runner/cat40/hard-proxy.ts` reports, without a model call, how often the oracle's
  records name the asked account. On the 50k calibration world it falls from 91% with round-2 knobs to 14% with
  round-3 knobs; code and nickname searches together still reach 76%, so the manager form carries most of the added
  difficulty ([calibration.md](docs/benchmarks/cat40-hard/calibration.md)).
- **Calibration at 50k.** `scripts/cat40-hard.sh step calibrate` builds the 50k world from round 3 on (`SCALE=large`,
  `SCALE=v1` for the 4k world). Projections use measured cells at the step's scale when there are any and add the pg
  arm's one-time corpus embedding when the world is known (about $2.70 at 50k). The pg store now checkpoints PGlite while it builds; without that, the 50k Hard build ran out of memory and hung. Appended 50k accounts have their own
  account managers, so 4k records keep their meaning inside the 50k world.
- **H1 set sizes.** H1 keys are computed over the 4k accounts so they match at both scales; the 261-account
  population supports at most 25 to 34 members per predicate, so round 3 keeps 10 to 40.

### Cat 40 Hard: the harness for tasks that measure the edge of frontier models

Cat 40 no longer separates the models people use most: on the development world gbrain master finished 239 of 250
frontier-model runs. The Hard tier asks harder memory questions, and this release builds everything it needs. No paid
cell ran; calibration and the held-out runs follow the [runbook](docs/benchmarks/cat40-hard/RUNBOOK.md) under Garry's
2026-10-05 gate decisions (16 turns with the cap as the last knob, tier A, a $4,350 authorization, the Hard ledger at
$1,794).

- **Generator.** `bun eval/generators/model-ladder-gen.ts --mode hard` writes a ledger-first world of about 4,000
  documents with five families: H1 sets and counts over 10 to 40 accounts, H2 attribute histories with reversals,
  backdated corrections and effective dates, H3 look-alike, renamed and merged accounts, H4 conflicts decided by
  authority with long deciding documents, and H5 five-session memory. `--knobs` takes a validated knob file;
  `--scale large --base-world` appends accounts and non-deciding documents to about 50,000 documents and refuses
  unless every H1 key recomputed over the full ledger equals the 4k key and every H3 disambiguation stays unique.
  Dates, corrections, user statements and names follow one written semantics (`eval/generators/hard/semantics.ts`),
  and one predicate evaluator computes and checks every H1 key. Each family and the background draw from their own
  seeded streams, so a knob change moves only the family it controls.
- **World contract.** `eval/generators/hard/schema.ts` and `validate.ts` hold the world, task and answer types, the
  knob schema and the invariants, separate from the renderers, so the sealed validation variant can be written against
  [WORLD_SCHEMA.md](docs/benchmarks/cat40-hard/WORLD_SCHEMA.md) alone.
- **Runner.** Hard worlds carry their identity (seed, scale, mode, knobs) and turn cap (16; `--max-turns` overrides
  and changes the experiment identity). H5 cells run five sessions with a fresh session between them on every arm.
  Hard runs refuse a missing judge, gpt-5.4-mini and unpriced models, write v2 records to `attempts.jsonl`, retry only
  harness errors (at most twice), score a context-length error as its own stop kind, quarantine a gbrain slot whose
  restore fails, and exit 3 with a stable code for every refusal and stop. `--preflight` lists keys, prices, identity,
  cells, slots, the roster-checked ledger and the step projection without a paid call. v1 runs are unchanged.
- **Scoring and judge.** `eval/runner/cat40/score-hard.ts` scores sets, counts and values (wrong values anywhere in the
  answer fail; unreadable sets are reported apart), importing `score.ts` unchanged. `judge-hard.ts` (`--judge
  gpt-6.1-sol`) treats H5 user messages as evidence, caps H1 near misses, persists requests and re-judges failures.
- **Fairness and cost.** pg embeds long documents in chunks on Hard; grep returns every match with full lines and a
  total and runs in a Worker with a time limit; pg pages with offsets and totals; restores run asynchronously; every
  embedding request is charged to setup or to its cell.
- **Analysis.** `analyze.ts`, `rescore.ts`, `latency-replay.ts` and `holdout_stats.py` read v1 and v2 records. New:
  the freeze-rule analyzer (`--freeze-rule --round N`), Hard report tables, offline Hard rescoring, and
  `holdout_stats.py --hard-comparator`, `--hard-headline` (primary endpoint, simultaneous intervals against every
  simple arm, weakest-family rule, cost per extra correct answer) and `--hard-mdd`.
- **Operator tools and paperwork.** `scripts/cat40-hard.sh hello|status|preflight|step`, the runbook, the
  preregistration template, the calibration record, the program ledger roster, the cost basis, a report template and
  the `model-ladder-hard` registry row (tier P, report-only).
- **Regression contract.** Tests pin the v1 world, the large manifest digest, the `score.ts` hash, v1 tool limits and
  a v1 scripted run's scores against a fixture recorded from the previous runner.
- **After calibration round 1 (2026-10-05).** Both oracle models missed the same account on two H1 tasks: a renamed
  account's ticket written after the rename still used the old name, and the H1 evidence lacked the rename notice.
  Records written on or after a rename now use the new name, H1 evidence carries rename and merger notices, a merged
  account's tickets count for the account it merged into, and H1 predicates that turn on a date boundary are not
  drawn ([calibration.md](docs/benchmarks/cat40-hard/calibration.md)). Projections now go per model, arm and family
  from round 1's measured Hard costs (2 to 5 times v1 per cell) plus the measured judge cost; a resumed step opens a
  new budget run (`--new-budget-run`) sized to the cells still missing. `knobs.round-2.json` makes H2 and H3 harder.

- **Version.** Main is at 0.10.73, so this release is 0.10.74.

## [0.10.73] - 2026-10-11

### Contributor fix wave: Bash 3.2 resume args and non-finite judge scores

- **`scripts/run-shootout-phase1.sh` runs on macOS Bash 3.2.** Under `set -u`, Bash before 4.4 treats an empty
  `"${resume_args[@]}"` as unbound, so a first run with no output file to resume from exited before calling gbrain.
  The expansion is now guarded the way `CAP_CMD` already was, as is the same pattern in
  `eval/runner/longmemeval-batch.sh`. A repo-wide structural test (`test/eval/shell-nounset-arrays.test.ts`) fails
  on any unguarded expansion of an array a `set -u` script declares empty. Reproduced in the official `bash:3.2`
  image: the script exits 1 with `resume_args[@]: unbound variable` before the fix and reaches gbrain for both
  no-reranker cells after it. Contributed by @armandovargash (supersedes #30).
- **The shared judge rejects non-finite scores.** `parseCriterionScores` clamped every number to 0-5, so an
  overflowing JSON score (`1e309` parses to `Infinity`) became 5/5 with no corrective retry, and `NaN` could reach
  the overall score. A non-finite score is now malformed output: one corrective retry naming the criterion, then
  `judge_failed`; Cat 29's pairwise judge uses the same parser and its existing `JudgeFailure` path. Finite
  out-of-range scores still clamp. Published scores and receipts are not regenerated. Contributed by @BichengWang
  (supersedes #128).

## [0.10.72] - 2026-10-11

### Memory proof wave: sealed BEAM results for gbrain #6066

The preregistered comparison of gbrain against a memory-bank server with background extraction and reflection
([report](docs/benchmarks/2026-10-09-memory-proof-wave-sealed-results.md), preregistration
`docs/benchmarks/2026-10-05-memory-proof-wave-preregistration.md` and its addenda). The measured build was frozen at
gbrain `d7467d1cf`, and its retrieval was checked equivalent at `d7d7686de`. The defaults it supports shipped in
gbrain #6066 (v0.60.164.0).

- **Accuracy: `ahead`.** On sealed BEAM 100k + 500k + 1M (1,080 questions), gbrain's combined lane (pages plus facts)
  answered 67.0% against the comparator's 64.4%: +2.64 points, one-sided 95% bounds +0.90 and +4.41, with the
  preregistered 3.5-point margin. By size: +6.03 at 100k, +2.20 at 500k, +1.13 at 1M.
- **Cost: an edge at low read volume only.** Cost per correct answer was 0.63 of the comparator's at 20 reads per
  stored conversation and 1.01 at 200 reads (no edge). gbrain's ingest was cheaper ($20 against $47), and its reads
  cost slightly more ($20 against $17), so reads dominate at high volume.
- **Pages-only lane: inconclusive** at 62.3%.
- **Descriptive rows.** LongMemEval-S (400 questions): combined 69.8%, pages-only 80.3%, comparator 84.5%. LoCoMo10
  (1,218): 93.3%, 85.0% and 83.3%. The comparator exceeded the 8,800-token context gate on both (p95 9,373 and
  8,855). On LongMemEval-S, the combined lane trails the pages-only lane by 10.5 points.
- **Custody.** The private per-question receipts were lost with a machine. The verdict stands on the published
  aggregates, and the addenda record the custody as final.
- **Harness.** The repository adds the wave's harness, power and grouping tools, and workload suites.

## [0.10.71] - 2026-10-10

### Budgeted delivery H1 results: `depth_first` fails on held-out questions; `cap_only` stays the explicit-budget default

Release decision 2 of sealed confirmation v2 (`sealed-v2-decision-2-2026-10-10:depth-first-vs-cap-only`), run by the
custodian on main `9b200886` (v0.10.70) at gbrain `8a3eedeac`
([report](docs/benchmarks/2026-10-10-gbrain-budgeted-delivery-h1.md), aggregates in
`docs/benchmarks/2026-10-10-gbrain-budgeted-delivery-h1/results/`). Spend $46.89 of the $145 cap.

- **Verdict `fail`.** With an explicit 5,500-token budget and Sonnet 5.5, `depth_first` answered 122 of 200 and
  `cap_only` 145: −11.5 points (95% persona-clustered interval −18.0 to −4.5), 14 wins and 37 losses, exact McNemar
  p = 0.0018. Guard 7 found a clear loss in multi-session (40 → 15 of 80; 5 wins, 30 losses, one-sided p = 1.1e-5).
  Temporal rose 26 → 32, knowledge update fell 39 → 35 (p = 0.11), abstention was 40 of 40 in both. Opus 5.5
  (138 → 122) and gpt-6.1-sol (144 → 121) agree. References: `off` 142, `off` on the first five hits 150 (+2.5 over
  `cap_only`, not distinguishable).
- **Why.** `depth_first` fit about 3 whole conversations and delivered every gold chat for 76 of 160 answerable
  questions (16 of 80 multi-session); `cap_only` reached pieces of about 10 and covered 159. Sealed v2's
  multi-session and knowledge-update questions need three or four chats months apart. The run landed beyond the
  preregistered "multi-session rewards breadth" power scenario (P(pass) 5.5%).
- **Every evidence guard held** before any label read: guard 1 (no-budget bytes identical) on 200 of 200, guards 3, 4
  and 5 on 200 of 200, and all 1,600 reader contexts re-rendered to the bytes the readers got.
- **Custody.** One freeze resume after an embedding-cache lock at startup (lease $0.64; the freeze cost $0.86 over 2
  leases), no label read before it. The access log went from 6 to 35 lines, all 29 new lines under this decision,
  with 8 label reads, all after the final gate.
- **What it means.** `cap_only` stays gbrain's explicit-budget default; `depth_first` stays opt-in, is not tested on
  sealed v2 again and is not tuned on it. Sealed v2 has one opening left. The protocol's Openings record, the H1
  preregistration and the docs index row are updated.

## [0.10.70] - 2026-10-10

### Budgeted delivery H1: preregistered held-out test of `depth_first` against the shipped `cap_only`

A preregistration, not a result ([doc](docs/benchmarks/2026-10-10-gbrain-budgeted-delivery-h1-preregistration.md),
[decision directory](docs/benchmarks/2026-10-10-gbrain-budgeted-delivery-h1/)). Decision
`sealed-v2-decision-2-2026-10-10:depth-first-vs-cap-only`, the second of sealed confirmation v2's three openings, at
gbrain `8a3eedeac` (v0.60.126.0, the pin): `depth_first` against `cap_only` at a 5,500-token gbrain budget for an
8,000-token reader budget, one frozen 25-hit list per question, E2's pseudo-session renderer, read by Sonnet 5.5 and
judged by gpt-4o-2024-08-06 over all 200 questions. Pass needs a persona-clustered 95% interval above zero, exact
McNemar p < 0.05 and guards 1, 3, 4, 6, 7 and 8. No paid call and no sealed file were used.

- **Why the pin and not E2's `ca2c447bd`.** Only `src/core/chunkers/token-estimate.ts` changed among the files that
  feed retrieval, packing or token counting; a counting change is disclosed and measured at the pin. The keyless dry
  run froze the same lists and delivered byte-identical evidence at both commits on the invented fixture.
- **Guard 7, changed before custody (Garry, 2026-10-10).** A kind fails only on a clear loss: an exact one-sided
  McNemar test on that kind's discordant pairs, p < 0.05. It replaced the plan's point rule (no kind down by more
  than max(1 question, 2% of the kind)) after a pre-custody sensitivity analysis of five kind guards
  (`scripts/guard7-sensitivity.ts`, `guard7-sensitivity.json`): P(pass) is bounded by superiority under all of them,
  and the point rule mainly turned noise into `fail`.
- **Power.** Simulated from E2's paired Sonnet rows with the committed rule: P(pass) 69% if E2's per-kind effects carry
  over, 39% if multi-session gains nothing, 26% if multi-session truly loses 5 points, 5.5% if it behaves like E2's
  `breadth_capped` pairs, and 1.3% with no effect. The limit is superiority, and no kind guard reliably catches a true
  5-point multi-session loss at 80 questions.
- **Budget.** Estimate $47, cap $145 (about 3x), five local lease cells in one campaign ledger.
- **Custody chain** (`eval/runner/budgeted-delivery/h1-run.sh`, `h1.ts`): custody check of the files and the access
  log, a label-free corpus, the gates on frozen evidence before any label read, answers files, scoring through the
  sealed runner, the rule, an export scanned for every corpus id, and the access log returned. The keyless dry run
  (`h1-dry-run.sh`, `h1-fixture.ts`; receipts committed) passed every gate, read the labels once per arm after the
  final gate, refused all nine refusal probes without a label read, and left no fixture text outside the custody root.
- **Harness.** `deliver_set=h1` in the gbrain-query system; reader-only arms (`judge: "none"`) in memory-qa; the
  custody corpus hash on memory-qa's custody open line; `sealed-confirmation.ts score --custody-root` and
  `GBRAIN_EVALS_CUSTODY_LOG` for its access log; `OPENAI_BASE_URL` in the sealed runner's judge client;
  `SHOOTOUT_KEYLESS_UPSTREAM` for local lease cells; the stub proxy's `/responses` route and `--vary`. Tests in
  `test/eval/budgeted-delivery-h1.test.ts` and the E2 real-PGLite test.

## [0.10.69] - 2026-10-10

### T0b generator v2, scorer t0b-score-v2 and the custodian-sealed confirmation preregistration (no paid cells)

Prepares the program primary's held-out test: the shipped stack (Candidate 1 plus garrytan/gbrain#6271's short-code
alias rule) against frozen gbrain v0.60.106.0, on 32 personas minted on the maintainer's Mac.

- **Generator v2** (`V2_KNOBS`): every company's short code is unique within a brain and never a word-like code
  (`CODE_STOPWORDS`); namesake promises match only their distinctive phrase (`NAMESAKE_STRICT`); mail ids are keyed by
  company. Version 1 worlds are byte-identical (baseline digest pinned in a test).
- **Custodian mode**: `--mint-sealed --personas N --custodian-out <dir>` writes seeds to a 0600 file outside the
  repository and prints only their commitment; `--custodian-seeds` renders a seedless world (`sealed-01`...) and its
  digest; the T0b runner reads it with `--world --expect-digest` and refuses a world inside the repository.
- **Scorer t0b-score-v2**: a line carrying a namesake value is the namesake's when it names the namesake (last name,
  company or code) and not the contact, or carries a disambiguation cue; the cue list adds the phrases the namesake
  diagnostic found missing. The 25 audited lines score as the diagnostic read them (v1 flags 11), and 576 mutation
  lines restating a namesake value as the contact's all fail.
- **Preregistration amendment 5** ([doc](docs/benchmarks/2026-10-08-program-primary-hard-preregistration.md)): arms,
  size (32 personas: P(`10x`) 0.82 at a true factor of 20), claims, validity mutants, gates, custody chain and a $265
  ledger cap. It runs once #6271 merges.

## [0.10.68] - 2026-10-10

### T0b namesake diagnostic: all 11 namesake flags left after the alias fix are scorer false positives

A $0 diagnostic (keyless replays, no reader cells) of every alias-stack run whose answer names a namesake value.

- **Report** ([doc](docs/benchmarks/2026-10-10-namesake-diagnostic.md)). 25 runs name a namesake value; the scorer
  flags 11. All 11 are false positives: 7 disambiguations outside `t0b-score-v1`'s cue list ("a different account",
  "Neither is this call") and 4 generic words that overlap a namesake-promise pattern. No run states a namesake's value
  as the contact's, and none of the 24 `context_pack` and 16 `entity` calls returned the namesake. Rescoring the 11
  (exploratory, post hoc) moves the alias-stack development comparison from 25 to 11 to 22 to 6 of 144. The report
  proposes entity-anchored namesake attribution and distinctive namesake items for the next scorer and generator
  versions, preregistered and mutation-tested before the sealed run.
- **Records**: `audit.json`, per-call replay traces and `namesake-replay.ts` in
  `docs/benchmarks/2026-10-08-program-primary-hard/namesake-diagnostic/`; `README.md` and `docs/README.md` name the report.

## [0.10.67] - 2026-10-09

### Memory trust (Cats 37 to 39): labels cut planted-claim adoption, the defaults are flag, flag and allow; paired with gbrain #6396 (merged as `d4dc2d4d8`)

gbrain #6396 (merged as `d4dc2d4d8`, v0.60.139.0) ships the #5575 memory trust feature: trust labels on everything an agent reads back, a
write gate for instruction-like text and opt-in suppression. Three keyless categories and a preregistered paid run
measure it. Real spend $212.15 of a $500 cap.

- **Categories.** Cat 37 (memory poisoning: 200 scenarios, external and agent-relayed paths), Cat 38 (state
  resolution: does the current value survive lower-trust writes) and Cat 39 (deletion audit: does `forget --purge`
  remove a claim everywhere), with hermetic contracts and dry and paid model arms
  (`eval/runner/cat37-memory-poisoning.ts`, `cat38-state-resolution.ts`, `cat39-deletion-audit.ts`,
  `eval/runner/memory-trust/`). All three pass every keyless contract at `5b9c814b`, the tree that merged as `d4dc2d4d8` (and at `c3a89f05`).
- **Preregistration** ([doc](docs/benchmarks/2026-10-07-memory-trust-preregistration.md)) with amendments 1 to 5:
  the utility guard, a labels-absent arm, user-stated preferences, amendment 4's fixed preference harness and
  relay-origin check at `62773f02`, and amendment 5's write-gate flag rate on natural conversations at `5b9c814b`.
- **Paid results** ([report](docs/benchmarks/2026-10-08-memory-trust-results-paid.md)) with Opus 5.5, Sonnet 5.5 and
  GPT-6.1 Sol at `c2f10ee8`: with labels, planted claims were adopted in 1.5% to 5% of later sessions against 5.1% to
  10.6% with labels stripped (Sonnet p = 0.00002); no model followed an instruction-worded injection in any arm, so
  the preregistered rules set `write_gate.external_mode = flag`, `write_gate.agent_mode = flag` and
  `trust.agent_activation = allow`. In Cat 38, labels raise current-value answers from 53% to 55% without them to 100% (Opus), 81% (Sonnet) and 68% (GPT); no model
  recovered a purged claim in Cat 39; LongMemEval-S is unchanged. Amendment 4: preferences saved as `user_said`
  survive the label (47 or 48 of 48 per model), Opus 5.5 holds back 14 of 48 saved without an origin, and an
  artifact asking to be saved as `user_said` raised no model's attack success. Amendment 5
  (`eval/runner/memory-trust/flag-rate.ts`): on 563 LongMemEval-S sessions of 12 simulated users, saved with
  `put_page`, Haiku 5.5 extraction and a Sonnet 5.5 agent's `remember`, the gate flagged 0 of 5,124 facts and 15 of
  563 transcript pages (all false flags, 8 on the assistant's "As an AI language model…" replies), `gbrain trust
  review` listed 0 items, and all 15 injected instruction lines were flagged.
- **Findings** ([ledger](docs/benchmarks/2026-10-07-memory-trust-bugs.md)): 9 bugs, all fixed and verified by rerun,
  including 37-5 (context_pack showed quarantined external text unlabeled at `62773f02`, fixed in `ec5ae21a`), and 7
  feature gaps closed.
- **Index**: `docs/README.md` and `README.md` name the report.

## [0.10.66] - 2026-10-09

### Verbatim probe: gbrain #6391 makes every last-session probe read clean; recall unchanged; preregistered paired verdict passes

gbrain #6391 (merged as `f05943e65` in v0.60.138.0) attaches the rerank score to every confidence grade, keeps inferred
image intent off text-only installs, and collapses long dash runs before `websearch_to_tsquery`. Estimated spend $10.18
of a $12 cap (voyage-4 embeddings, rerank-2.5, haiku expansion; no LLM judge).

- **Report** ([preregistration and results](docs/benchmarks/2026-10-09-verbatim-probe-preregistration.md), with
  `2026-10-09-verbatim-probe-verdict.json`). Paired on 500 LongMemEval-S brains, merge base 0e52ac91 against #6391 at
  fecc7827, scored on gold sessions with the shim classifier at 846fa6dd: the verbatim-quote probe: 71 questions gained a clean read and none lost one (429 to 500 of 500, exact McNemar p = 8.5e-22), with strict recall@10 unchanged at 496 of 500. No
  question type moved and neither arm had errors. The reranker-settings extension did not run.
- **Index**: `docs/README.md` and `README.md` name the report.

## [0.10.65] - 2026-10-09

### HNSW scale: a 20,000-tuple pooled scan fixes random selective scopes at 1M to 2M chunks; topic-coherent sources remain a gap; mirrored from gbrain #6380

gbrain #6380 (merged as `2e84d234e` in v0.60.135.0) makes every pooled vector attempt scan up to 20,000 tuples and
refreshes `content_chunks` and search-filter page statistics after import, sync, reindex and embed drains. Real-vector
spend $13.07 (voyage-4, 1M Wikipedia chunks).

- **Report** ([doc](docs/benchmarks/2026-10-09-hnsw-scale.md), with `budget-ledger.json` and `results-summary.json`).
  Same database, master against the fix: random 10% source or visibility recall@50 rises from 0.52 to 0.63 to 0.96 to
  0.99 on 1M and 2M synthetic chunks, and from 0.765 to 0.970 on 1M real chunks, at +16 to 36 ms p50. Unscoped search
  is identical. Escalate-when-short, the other candidate, ends in the exact fallback at up to 8.6 s p95. Measured again
  on top of gbrain v0.60.131.0's exact scope scan, the budget still adds recall wherever the pool runs. Topic-coherent
  10% sources reach 0.76 to 0.78; since v0.60.134.0 (#6390) a source up to 120,000 counted chunks takes the exact scan
  instead.
- **Index**: `docs/README.md` and `README.md` name the report.

## [0.10.64] - 2026-10-09

### T0b alias stack: short-code aliases on top of Candidate 1 cut fresh-seed failures from 18 to 4; development inconclusive

Measures GBRA-39's short-code alias fix (gbrain #6271 at `f24ca6afe`, merged locally with master `dda603ac` as the
unbranched build `9ac26bea`) against current master, which carries Candidate 1. Paid spend $61.78 of a $70 ledger and
$49.68 of a $60 ledger.

- **Report** ([doc](docs/benchmarks/2026-10-09-alias-stack.md), [preregistration](docs/benchmarks/2026-10-08-program-primary-hard-preregistration.md)
  amendment 4 and its note, `78271606` and `7cc77a65`). Paired cell by cell with the reranker live: 18 to 4 of 72 failed
  runs on eight fresh seeds drawn after the build froze (factor 4.11, 95% interval for R 0.05 to 0.68, `improvement`)
  and 25 to 11 of 144 on the development seeds (factor 2.22, R 0.12 to 1.41, `inconclusive`; Sonnet 5.5 20 to 3,
  `improvement`; Opus 5.5 4 to 8), so the preregistered "stacks" criterion is not met. On the 38 of 48 tasks whose call
  note the code links, stale-terms failures fall from 25 to 0. Both validity mutants are detected on the alias build for
  all three readers. 9 of the 10 unlinked tasks are codes the T0b generator gives two companies in one brain; the report
  asks the next generator version to draw unique codes.
- **Harness**: eight fresh development seeds (`PPH_FRESH_SEEDS_ALIAS`) join the seeds the T0b runner accepts, with a test
  that they are new and solvable. The $0 alias probe, the `context_pack` replay and the route analysis sit beside the
  receipts in `docs/benchmarks/2026-10-08-program-primary-hard/alias-stack/`. `docs/README.md` and `README.md` name the
  report.

## [0.10.63] - 2026-10-09

### Slug-conflict judgment: three frontier models give no harmful answer on 48 pairs; Opus 5.5 merges the most true duplicates; mirrored from gbrain #6377

gbrain #6377 (PR #6384, merged as `0e52ac914` in v0.60.132.0; runs made on branch commit `ac6e0868`) adds a content-repair lane that clears sync holds itself and asks a chat model only where identity needs judgment: a file whose frontmatter `slug:` names another page is a duplicate to merge into a canonical page (a recommendation for a person; gbrain does not merge pages yet), a stray line to delete, or a case for a person. This release mirrors the preregistered eval that decides which models may give that judgment by default.

- **Report** ([doc](docs/benchmarks/2026-10-09-content-repair-judgment.md), [preregistration](docs/benchmarks/2026-10-09-content-repair-judgment-preregistration.md), frozen with the fixtures before any run). 48 synthetic pairs with placeholder names (25 true duplicates, 10 stray slugs, 8 adversarial, 5 ambiguous), three runs per model through gbrain's production prompt, call and parser, $2.05 in all. `claude-opus-5-5`, `gpt-6.1-sol` and `claude-sonnet-5-5` each gave no harmful answer in 144 pair runs (no `remove_slug` on a true duplicate, no `merge_into` of two different things, no wrong canonical, no unusable answer), removed every stray slug, deferred every ambiguous pair and never merged an adversarial pair; they recognised 69, 64 and 60 of 75 true duplicates (92.0%, 85.3%, 80.0%) and deferred the rest. All three meet the bar (zero hard failures, at least 80%); gbrain's `CONTENT_REPAIR_MEASURED_MODELS` lists them in that order. Deferrals concentrate on pairs whose two hygiene notes each read "Duplicate of the other"; a prompt change is proposed, to be measured under a new prompt version.
- **Records**: fixtures, per-run rows with the model's `why` sentences, `summary.json`, `summary.md` and `verdict.json` in `docs/benchmarks/2026-10-09-content-repair-judgment/`; `README.md` and `docs/README.md` gain the row.
## [0.10.62] - 2026-10-09

### Budgeted delivery E2: how `auto` should pack an explicit token budget

E2 of the approved budgeted delivery plan (v3), on gbrain `ca2c447bd` (v0.60.124.0, the merge of gbrain #6367, loaded
as a copied overlay), development data only. Ledger: $178.46 of a $600 cap (Garry raised the caps mid-run so evals
don't stop on a cap: E2 $270 to $600, E3 $10 to $25, program $700 to $1,500).

- **Report** ([doc](docs/benchmarks/2026-10-09-gbrain-budgeted-delivery-e2.md), [preregistration](docs/benchmarks/2026-10-09-gbrain-budgeted-delivery-e2-preregistration.md)
  with amendments A1 to A4). On all 500 LongMemEval-S questions with Claude Sonnet 5.5 at an 8,000-token reader
  budget: `off` (today's uncapped `auto`) 69.0%, `cap_only` 67.4% (−1.6, −3.8 to +0.4; fails the question-kind
  guard), `breadth_capped` 77.8% (+8.8, +5.2 to +12.2), `depth_first` 79.4% (+10.4, +6.4 to +14.4). `depth_first`
  passes guards 1 to 9, loses nothing measurable on LoCoMo (−0.3) or BEAM (+4.0), and keeps its gain under Sonnet 5.5,
  Opus 5.5 and gpt-6.1-sol (+16, +13, +13 on the slice), so by the preregistered rule it goes to H1. On multi-session
  questions it trails `breadth_capped` by 10.5 points, which H1's preregistration should weigh for the
  multi-session-heavy sealed set. E3 (session fusion) changes no top-five recall and stays parked.
- **Harness.** `gbrain-query` gains the E2 stages (`variants=e2`: freeze, $0 size and deliver on hash-vector
  re-imports with a redaction-aware chunk-text check, live checks that switch `search.auto_packing` and time the
  reranker separately) and per-call `auto_packing`; `pseudo-session-rank` rendering (C5); `budget-sizing.ts --e2`;
  `e2-readings.ts`, `e3-retrieval-gate.ts`, the keyless gate and a parallel shard runner; local campaign cells and
  `shootout-cell.ts raise-cap`; the receipt exporter can drop arm-row accounting.
- **Bootstrap.** `eval/systems/bootstrap.sh` installs Bun 1.4.2 (the CI pin gbrain needs) instead of 1.3.14;
  `BUN_VERSION` still overrides. Every E2 VM cell already ran on 1.4.2.

## [0.10.61] - 2026-10-09

### Cat 41 re-baseline: fresh install to wired recall on gbrain v0.60.130.0

The wave 2 (D8) time-to-hello-world comparator from the "10x memory advantage" plan. Paid spend $14.09 of a $30
ledger.

- **Report** ([doc](docs/benchmarks/2026-10-09-cat41-rebaseline.md), [preregistration](docs/benchmarks/2026-10-09-cat41-rebaseline-preregistration.md)
  with amendments 1 and 2). The unchanged `fresh_install_to_wired_recall` scenario on gbrain `dda603ac9` (v0.60.130.0),
  Claude Code (`claude-opus-5-5`) and Codex (`gpt-6.1-sol`), six runs each: 98.8 s and 161.9 s mean wall time,
  `download_ms` 8.1 s and 5.3 s, one scripted reply in 11 of 12 runs, 12 of 12 successful, 0 consent violations. The
  published `b3f4e8b` build, rerun interleaved the same hour, took 107.0 s and 175.4 s (published: 96.7 s and
  121.7 s), so the release is not measurably slower and the published Codex number reflects a faster day. Every run
  registered `--surface full` (143 tools), which adds about 32K input tokens and 3 s to Codex's recall session.
- **Artifacts** in `docs/benchmarks/2026-10-09-cat41-rebaseline/`: both passes' scores, summaries and run archives,
  the token overhead per surface, and `attribution.ts` with its per-session output for all four passes.

## [0.10.60] - 2026-10-09

### Candidate 3 diagnostic: the remaining T0b terms and hop failures are notes linked only by a declared short code

A $0.10 diagnostic in place of Candidate 3 of the [10x memory advantage plan](https://github.com/garrytan/gbrain-evals/pull/97) (GBRA-60), on development and fresh public seeds; no reader cells and no gbrain change.

- **Report** ([doc](docs/benchmarks/2026-10-09-candidate-3-diagnostic.md)). Replaying the 33 Candidate 1 cells that failed on terms or the hop commitment on gbrain master `dda603ac` with reranking live: the call note with the corrected figure was in no tool result in any of the 29 terms cells, and the technical review was in no tool result in any of the 7 hop cells. The call note names the company by the short code its page declares ("Call with JOF"), and every development hop failure passed that code to `context_pack`. A keyless card probe puts the call note on the card in 0 of 24 development tasks on master and 21 of 24 on master merged with gbrain #6271's short-code rule; code collisions (BRL, PRF) and stoplisted codes (THE) leave the rest, about 15% of tasks with the fresh seeds. First names, nicknames and file-name words are shared with the generator's namesakes, so no separate Candidate 3 was built; collective disambiguation of colliding codes is documented as the follow-up.
- **Tools**: the rank replay and the card probe sit beside their receipts in `docs/benchmarks/2026-10-08-program-primary-hard/candidate-3/`; `docs/README.md` links the report from the agent-task row.

## [0.10.59] - 2026-10-09

### Candidate 1: newest dated mentions on `context_pack` cards cut T0b failures from 67 to 27; pin gbrain `8a3eedeac` (v0.60.126.0)

The first candidate from the [T0b root cause](docs/benchmarks/2026-10-08-program-primary-hard-root-cause.md), shipped in gbrain #6362 (on by default). Paid spend $58.36 of a $60 ledger and $42.38 of a $45 ledger.

- **Report** ([doc](docs/benchmarks/2026-10-09-candidate-1-newer-mentions.md), [preregistration](docs/benchmarks/2026-10-08-program-primary-hard-preregistration.md) amendments 2 and 3). Against a fresh master arm on the same harness revision, with the reranker live in every cell: 67 to 27 of 144 failed runs on the development seeds (factor 2.45, 95% interval for R 0.25 to 0.64, `improvement`; Opus 5.5 40 to 6), and 33 to 9 of 72 on eight fresh public seeds drawn after the code freeze (factor 3.53, `improvement`). Contact and date failures fell from 74 items to 1; stale terms remain, from a call note that links to no entity. Every validity mutant was detected. An exploratory merge with the short-code alias fix (#6271's `f24ca6afe`) failed 1 of 18 Sonnet cells against 6 for Candidate 1 alone.
- **Harness**: eight fresh development seeds (`PPH_FRESH_SEEDS_C1`) join the seeds the T0b runner accepts; the mechanism probe, gold builder and route analysis sit beside the receipts. The shootout `runRemote` tests take a free port instead of a random one in the kernel's ephemeral range.
- **Pin**: gbrain moves from `fc548317f` (v0.60.122.0) to `8a3eedeac` (v0.60.126.0, the merge of gbrain #6362); `bun.lock` follows. At the new pin the `gbrain-query` fixtures assert what gbrain #6367 fixed (`auto` stays inside an explicit budget; the frozen-hit path carries dates), and N2 loads the CLI's `makeContext` from `src/cli/main.ts`, where gbrain #6365 moved it.

## [0.10.58] - 2026-10-09

### Budgeted delivery E1: gbrain measured through `query`; dates were most of the LoCoMo gap, hit count is the lever at 8,000 tokens

E1 of the [budgeted delivery plan](https://github.com/garrytan/gbrain-evals/blob/capy/gbrain-budgeted-delivery-plan/docs/plans/2026-10-08-gbrain-budgeted-delivery/PLAN.md) (approved 2026-10-08, E1 cap $100), at gbrain `c5fb0201`, development data. Ledger committed $66.42, of which $16.65 is reservations charged for Sonnet 5.5 requests the provider refused unbilled.

- **Report** ([doc](docs/benchmarks/2026-10-08-gbrain-budgeted-delivery-e1.md), [preregistration](docs/benchmarks/2026-10-08-gbrain-budgeted-delivery-e1-preregistration.md) with amendments A0 to A2). Both reproduction arms land inside their bands. A date line on each of the comparison's chunks lifts LoCoMo temporal from 28 to 78 of 100 (all LoCoMo 66.1% to 75.1%), so the LoCoMo shortfall is mainly the adapter. `query`'s `auto` at 8,000 tokens on 25 hits adds +4 / +0.5 / +1 points over dated chunks and overran its explicit budget on every slice and LoCoMo question; on the first five hits it reaches 82% on the LongMemEval-S slice with Sonnet 5.5, level with whole sessions (80%), so `breadth_capped` leads E2. Rendering changes nothing (+1). As shipped (24,000 tokens, read whole) gbrain answers 89% on the slice. The saved-facts probe (Sonnet 4.6 extraction, gbrain `c5fb0201`'s default) is 11 points below the best LoCoMo arm: no headroom.
- **`gbrain-query` connector** (`eval/runner/systems/gbrain-query/`, with a README for reuse): named wire requests (frozen chunk list, native default, `auto` with an explicit budget, live parity, bare budget), pin checks against gbrain's registered keys, per-block delivery records (unit, budget, overrun, spill) and reader bytes, live parity on every consumed field, and keyless fixtures for the `auto` overrun at 8,000 tokens and the frozen-hit `effective_date` loss.
- **memory-qa recipes**: named contexts with immutable recipe hashes in the context and arm keys (dated native, undated twin reused by prompt hash, pseudo-session with a specified block parser, rehydration of the frozen list, a per-recipe harness budget), typed `RetrieveResult.accounting`, `--frozen-from` for deliveries on frozen lists, and the facts lane's token count.
- **Tooling**: budget sizing on the real frozen lists, the preregistered drop order, a keyless accounting gate and its stub proxy, the readings script, and a text-free receipt exporter.

## [0.10.57] - 2026-10-09

### Evidence brief confirmation (wave 1 A6): on 400 fresh questions the brief is not shown to match whole sessions

Wave 1 item A6 of the [10x memory advantage plan](https://github.com/garrytan/gbrain-evals/pull/97) (GBRA-60), run on the maintainer's 2026-10-08 decision to continue and confirm after the pilot. Paid spend $94.91 of a $150 ledger cap.

- **Report** ([doc](docs/benchmarks/2026-10-08-evidence-brief-confirmation.md), [preregistration](docs/benchmarks/2026-10-08-evidence-brief-confirmation-preregistration.md), commit `943385f` before any cell, no amendments). Primary: the 2,000-token Haiku 5.5 brief read by Sonnet 5.5 scores 363 of 400 against 375 for whole sessions, -3.0 points (95% interval -5.25 to -0.75): inconclusive at T0's 3.0-point tolerance, so the brief does not join the sealed v2 opening. Secondaries (Holm): the brief on Opus 5.5 and `gpt-6.1-sol` and at 1k/4k/7k tokens, DIRECT and FALLBACK are inconclusive (FALLBACK -1.25, Holm p 0.10); TRUNC at 2k and 7k fail. Builder and reader tokens, dollars and p95 on every row, from a timing cohort over all thirteen cells.
- **Finding.** The brief validator's number check drops a correct claim that cites its session's date, which lives in the `<chat_session>` header rather than the text (3 of the 16 questions the brief lost had a number-check drop).
- **Driver.** `eval/runner/pilot/run.ts --split confirm`, `eval/runner/pilot/confirm.ts` (the A6 cells and comparison families), a cohort over any cell set, and per-question correctness in the report.

## [0.10.56] - 2026-10-09

### Cat 40 corrections: published runs where gbrain ran without reranking

Docs-only follow-up to the restore audit in #109 (GBRA-39). Restored Cat 40 slots kept the slot build's metering-proxy port in their Voyage URL, so in later processes every rerank request failed and gbrain returned unreranked results; #76 (`7709a70`) and #109 fixed the harness. No receipt or number is rewritten.

- **Dated corrections (2026-10-09)** near the top of each affected report, with per-run counts of cells whose metered gbrain calls include a rerank request ([audit](docs/benchmarks/2026-10-08-program-primary-hard/root-cause/restore-audit.json)), and a changelog line at the bottom: the [Cat 40 report](docs/benchmarks/2026-10-02-model-ladder.md) (the finding's held-out wave 0 of 500, the cost wave 0 of 1,709, entity recall 0 of 1,850, development and fix-wave ladders, scale tier 0 of 200, release ladder 362 of 1,456 and capped pilot 185 of 300; held-out check 1,691 of 1,800, unaffected) and its scale-tier, follow-ups, release-ladder, a714410a5-headline and P8 hidden-tool pages; [Cat 41](docs/benchmarks/2026-10-03-agent-operator.md) (instruction A/B 0 of 900; the `b3f4e8b` same-window pair is 0 of 300 against 300 of 300 and confounded); [registration surface](docs/benchmarks/2026-10-05-registration-surface.md) (0 of 120); [P8](docs/benchmarks/2026-10-05-heldout-program/p8.md) (0 of 402 development cells); fix wave [11](docs/benchmarks/2026-10-07-wave11-agent-smoke.md) (0 of 316) and [12](docs/benchmarks/2026-10-07-wave12-agent-smoke.md) (0 of 280) agent smokes.
- **What holds.** Comparisons between gbrain builds or surfaces that shared the condition stay internally valid for gbrain without its reranker. Comparisons of gbrain with files, Postgres or the memory tool measure that configuration. The F1/F10 same-window pair for `b3f4e8b`, and the 59-to-46 baseline drift it was set up to control, mix a reranked and an unreranked run. The only measurement of the effect is on the Cat 40 Hard development world (Sonnet 5.5, `8e11aa1f3`, 50 tasks: 21 with reranking, 19 without; 7 won, 5 lost; #76), a different world and tier, not a correction factor.
- **README and docs index.** The Cat 40 results row, the agent-tasks comparison, a new Corrections bullet, and the wave 11 and wave 12 index rows link the corrections.

## [0.10.55] - 2026-10-08

### T0b root cause: the correcting page almost never reaches the reader; current master is not measurably better; restored slots searched without the reranker

Wave 1 follow-up of the [10x memory advantage plan](https://github.com/garrytan/gbrain-evals/pull/97) (GBRA-60). Development seeds only. Ledger spend $53.19 of a $60 cap.

- **Root cause** ([report](docs/benchmarks/2026-10-08-program-primary-hard-root-cause.md)). Every recorded T0b baseline tool call was replayed on rebuilt v0.60.106.0 brains. In 111 of 112 failed contact, terms and date items, no tool result held the correcting page or its decisive sentence; no push carried a stale value; facts extraction never ran on imported pages. The mails link only to the champion's person page, the call note links nowhere and the company's short code is not one of its names, while `context_pack` cards omit `referenced_by`. Readers that called `entity` on the champion (78 runs) never failed on the contact or the date; gpt-6.1-sol makes that call in 46 of 48 runs, Opus 5.5 in 3. Ranked candidate fixes, no build.
- **Candidate 0** (preregistration amendment 1, `46d9ca77`, before any cell): gbrain master `fc548317` (v0.60.122.0) on the frozen protocol fails 67 of 144 runs against 74, factor 1.10 (ratio interval 0.64 to 1.28), `inconclusive` for every reader; both mutants detected; inside the resource envelope. `eval/runner/t0/paired.ts` computes the paired PW comparison.
- **Harness: restored slots searched without the reranker.** `GbrainSlot` kept the build process's proxy port in each snapshot's Voyage URL, so every later process reranked against a dead port. `restore()` now rewrites it, and two fixes come from GBRA-39's #76: a fail-closed rerank probe before any Cat 40 or T0b paid cell, and a keyed proxy unbind. An audit of committed results (`root-cause/restore-audit.json`) lists the runs whose cells never reached the reranker; no receipt is rewritten.
- **Fixture** for the short-code alias case in gbrain #6271: four unchanged pages from T0b dev seed 20261104.

## [0.10.54] - 2026-10-08

### The harder program primary (T0b): calibration, preregistration and the v0.60.106.0 development baseline

Follow-up to the T0 baseline's ceiling (wave 1 of the [10x memory advantage plan](https://github.com/garrytan/gbrain-evals/pull/97), GBRA-60). Ledger spend $78.19 of a $110 cap.

- **Workload.** `eval/generators/program-primary-hard-gen.ts` (`program-primary-hard-v1`): 919-page founder brains; session 2 replies to a champion and an unnamed procurement lead with no cue to look; the meeting move sits in a mail thread, the corrected figure in a call note, a dated mail hands procurement to a new person, and one promise comes from a review the champion did not attend. Runner `eval/runner/t0b-program-primary.ts` on the T0 carrier, scorer `t0b-score-v1`, registry entry `program-primary-hard` (T0b).
- **Preregistration** ([doc](docs/benchmarks/2026-10-08-program-primary-hard-preregistration.md), commit `b355a8df`): three calibration rounds on separate development seeds (18/18, 8/18, 6/18 failures); knobs frozen at 14/36.
- **Baseline** ([report](docs/benchmarks/2026-10-08-program-primary-hard-baseline.md)): 74 of 144 runs fail (51.4%; Opus 5.5 38/48, Sonnet 5.5 35/48, gpt-6.1-sol 1/48), mostly by greeting the procurement contact who handed off. Both mutants fail 24 of 24 for every reader. The push-off ablation is inconclusive. PW's sample-size rule gives 32 personas.

## [0.10.53] - 2026-10-08

### The evidence architecture pilot (wave 1 A4, A5, A10): a 2,000-token brief keeps Sonnet 5.5 within 1 point of whole sessions at a sixth of the cost, but the preregistered off-ramp fires

Wave 1 items A4, A5 and A10 of the [10x memory advantage plan](https://github.com/garrytan/gbrain-evals/pull/97) (GBRA-60); A3, the brief builder, ships in gbrain v0.60.122.0, which this release pins. Paid spend $60.48 of an $80 ledger cap.

- **Pilot** ([report](docs/benchmarks/2026-10-08-evidence-architecture-pilot.md), [preregistration](docs/benchmarks/2026-10-08-evidence-architecture-pilot-preregistration.md), commits `6d19207` and amendment 1 `1fd8a2d`, both before the cells they govern). Seven arms (whole sessions, a cheap reader, cheap with frontier fallback, a model-written brief, write-time digests, prompt caching, truncation) at 1k to 7k tokens on a 100-question LongMemEval-S development split, replayed over the frozen W10a captures so every arm reads identical evidence, plus a 480-unit synchronous timing cohort. On Sonnet 5.5: whole sessions 93 at $0.0473 and p95 2.5 s; the Haiku-built brief 92 at $0.0079 and p95 8.6 s; Haiku reading the whole sessions itself 89 at $0.0025 and p95 4.0 s, which matches the brief within the 3-point tolerance at lower cost and latency, so the off-ramp fires: no A6 grid, no product op. Truncation and small digests lose 20 to 50 points; no arm reduced committed-wrong answers.
- **Driver** (`eval/runner/pilot/`): evidence substitution with a byte-identical A0 replay test against the W10a and W10c manifests, the seven arms, a keyless 2-question smoke of all 50 cells, the frozen FALLBACK rule, the timing cohort, the report and the decision rule; every call writes usage-receipt/v1 records through the budget ledger's guard. Reader settings for `gpt-6-luna` and `claude-haiku-5-5` join `MODEL_SETTINGS`.
- **Outcome instrument v3** (`eval/runner/outcomes/v3.ts`): commitment, correctness, abstention, hedge and execution error as separate axes with derived categories; mutation tests (a hedge cannot improve a wrong committed answer, a wrong value appended to an abstention commits it, an execution error can only raise the failure rate); `scoreAnswerV2` and earlier scorers stay byte-identical and both committed A4 receipts rescore identically. The judged hedge labeler passed the 0.90 abstain-precision bar on GBRA-49's held-back sample (0.985) but not the hedged bar (0.877), so the hedge axis reports nothing.

## [0.10.52] - 2026-10-08

### The program primary (T0): preregistration, delivery contract, power (PW) and the v0.60.106.0 development baseline

Wave 1 items T0 and PW of the [10x memory advantage plan](https://github.com/garrytan/gbrain-evals/pull/97) (GBRA-60). Paid spend $61.02 (budget ledger), PW $0.

- **Workload and carrier.** `eval/generators/program-primary-gen.ts` (seeded founder brains, two-session meeting and reply prep after a correction) and `eval/runner/t0-program-primary.ts`, which runs the release's own SessionStart and UserPromptSubmit hook commands at Claude Code's points under a frozen delivery contract (`eval/runner/t0/delivery.ts`); a forced-drop and a stale-correction mutant, a push-off ablation, and a native Claude Code parity slice (`eval/runner/t0/parity.ts`). Registry entry `program-primary` (T0).
- **Preregistration** ([doc](docs/benchmarks/2026-10-08-program-primary-preregistration.md)): commits `1e5caf3`, amendment 1 (scorer `t0-score-v2`) `76910b7` and amendment 2 (parity slice) `0dcf723`, all before the cells they govern. Loss tolerance 3.0 points.
- **Power (PW).** `eval/runner/power/`: a clustered paired failure-risk ratio whose interval (conditional binomial) was chosen by simulation because the delta method and the persona bootstrap undercover, and a within-persona size contrast for the wave 3 manifest ([power.json](docs/benchmarks/2026-10-08-program-primary/power.json)).
- **Baseline** ([report](docs/benchmarks/2026-10-08-program-primary-baseline.md)): on gbrain v0.60.106.0 the workload is at its ceiling. Sonnet 5.5 and gpt-6.1-sol fail 0 of 64 runs and Opus 5.5's 11 scored failures are all namesake warnings, so a human reading finds no failure; both mutants fail 32 of 32 and the parity slice agrees 8 of 8.
- **Budget ledger.** Streamed (SSE) responses settle from their usage events instead of their reservation; one `sseUsage` lives in `budget-ledger.ts`.

## [0.10.51] - 2026-10-08

### Q2 parser gaps: guards for typed list lines, a held-out frame for grammar precision and recall, relationship-phrasing units, and the custodian harness

Paired with gbrain #6343 (branch `capy/q2-parser-gaps`, frozen build `4ec7fbbe4`, baseline master `5b5891069`), merged, v0.60.120.0 (`61624308b`). Held-out spend $306.56 for the campaign, $333.97 with minting.

- **Verdicts.** [Record](docs/benchmarks/2026-10-05-heldout-program/q2.md) and [verdict file](docs/benchmarks/2026-10-05-heldout-verdicts/q2-heldout-2026-10-08.json). `line_grammar.enabled` stays opt-in: G1 fails (459 of 583 minted lines wrong on 664,930 held-out list lines, Wilson upper bound 75.6 per 100,000 against 2; all but one wrong line comes from the stress stratum of changelog, glossary and template notes; 14 template-slot lines against 0) and G3's decoys fail (17 of 52 template-slot decoys minted), while G3's relation recall (511/511), G4 guard loss (0.994), G2 agent-written relation lines (299/300, lower bound 0.981) and G5 carry-over pass. G6 did not run, as the order of runs requires after a G1–G5 failure. The C-gates select U34, U1 and U25 (U6 fails safety); fixed-sequence confirmation passes P1 (U34, false starts −0.41) and P2 (+U1, advisor traps +0.43) and fails P3 (+U25, no change), so U3, U4 and U1 ship and U2, U5 and U6 are reverted. Future-cycle candidates (closed category vocabulary, multi-word slot refusal, changelog-tag refusal) are recorded as candidates only.
- **Preregistration and freeze record.** [Preregistration](docs/benchmarks/2026-10-06-q2-parser-gaps-preregistration.md) with amendments 1–4 before the freeze and every deviation in its freeze record, including the run deviations found after the last cell (export outside the campaign guard, the stress-floor counting error, nine reconstructed access-log lines).
- **Harness.** `eval/runner/q2/` (grammar gates G1–G4 and G2 with two-judge labels and no adjudication, the runner's own zero-tolerance classes, the K conformance scorer, transition-identity C-gates with Holm selection and a fixed-sequence evaluator, the crossed bootstrap for G6, the power simulation, the campaign guard, preflight and allowlisted export); custody roots outside every git worktree with symlinks resolved; receipts that keep gate outcomes apart from execution status; resumable answer and judge checkpoints; the career-chronicle corpus and its development generator. The [custodian runbook](docs/benchmarks/2026-10-06-q2-parser-gaps-runbook.md) and [campaign manifest](docs/benchmarks/2026-10-06-q2-parser-gaps-campaign.json) fix the order of runs.
- **Defects found in the sealed run, fixed after the decision.** `junk-audit.ts g2-sample` and `label` now write receipts with `run_status` (the custodian had recorded wrapper receipts); W manifests may key their list `pages` and the career manifest `documents`; `campaign.ts not-run` records a step a failed upstream gate stops, so the export runs inside the guard when G6 does not.
- **CI flake fix.** `budget-ledger-sqlite.test.ts` "verify passes a healthy ledger" timed out on a CI runner (`tests (3)` on `35027cff`): its 400 reserve and settle pairs make 825 `synchronous = FULL` fsyncs, so on a busy runner disk it outlasts the 5 s test timeout. Its ledger now lives on tmpfs, as the scale test's does; the assertions are unchanged. Forced probe: with fsync delayed 10 ms on a disk path the test body takes 10.1 s, on tmpfs 0.7 s.
- **Pin.** The `gbrain` dependency moves from `a865f8f` (v0.60.104.0) to `61624308b` (v0.60.120.0), the merge of gbrain #6343; `bun.lock` follows. README, docs/README, the settings page (`src/core/search/mode.ts` is identical at both commits) and the comparison page name the new pin; `cat36-grounded-answers.ts` narrows a usage value the new pin's types mark optional (same check). Committed results keep the commits they were measured at.
- **Version.** Main is at 0.10.50, so this release is 0.10.51.

## [0.10.50] - 2026-10-08

### Open-source memory comparison: the remaining project names move to the one systems table (amendment A6b)

[Systems table](docs/comparison-systems.md#systems-in-the-open-source-comparison), [amendment A6b](docs/benchmarks/2026-10-06-oss-memory-shootout-preregistration.md#amendments), [hash manifest](docs/benchmarks/2026-10-06-oss-memory-shootout/rename-a6b.json). Finishes the naming pass that 0.10.46 started: other memory systems are described by kind everywhere in the comparison, and names, versions, licenses and links appear only in the systems table. No number changed.

- **Receipts and capability records.** Upstream identities (package pins, vendor images, vendor benchmark code, vendor MCP servers) read `see comparison-systems table: <label>` and keep their commits and digests; the table holds the full identities. Prose describes vendor code by kind. 454 receipt and row files in both campaigns changed only in those strings.
- **Harness names.** The shims' own environment variables (`EXTRACT_FIRST_CHUNK_TURNS`, `MEMORY_BANK_LLM_PROVIDER`, `MEMORY_BANK_URL`, `AGENT_RUNTIME_APP_SERVER_PORT`, `AGENT_RUNTIME_WS_TOKEN_FILE`), the memory-bank Postgres credentials and the shim classes use the labels. Vendor imports, vendor-read environment variables, Dockerfiles, lock files and compose image references keep the upstream identifiers that pinning needs.
- **Plan, reviews, preregistrations, shim READMEs and pilot notes** describe the systems by kind and link the table instead of the projects. The docs index gains the comparison report.
- **Evidence that only labels changed.** `scripts/verify-a6b-rename.py` checks the before and after sha256 of every changed file and that every JSON, NDJSON and gzipped NDJSON file in both campaigns, the sealed aggregates included, keeps the same shape, numbers, booleans and nulls. Both campaign hashes move because the extract-first cell commands name the renamed variable (`36ba918f` to `f7a22503`, `ae18af15` to `90c4956c`); the PrecisionMemBench system test pins the new hash.
- **Version.** Main is at 0.10.48, so this release is 0.10.49.

## [0.10.49] - 2026-10-08

### gbrain managed catch-up follow-up: first page at 15.5 s, page saves within a second of idle

Paired with gbrain #6344 (branch `capy/next-wave-g3-g6-g7`, measured at `d6d9d5956` against master `b5f12b12e`, v0.60.117.0; merged as `7c4c36e31`, v0.60.119.0). Mirror, $0 here.

- **Catch-up and page saves, three runs per head.** [Report](docs/benchmarks/2026-10-08-managed-sync-followup-wave.md), [`results.json`](docs/benchmarks/2026-10-08-managed-sync-followup-wave/results.json) and the raw bench JSON for every run. First commit 15.5 to 15.6 s (master 19.0 to 19.6 s; target 15 s, missed by 0.5 s); slowest page saves during a catch-up +0.52 to +0.77 s over idle with none failed (master +0.52 to +2.28 s, one failed); catch-up while saving every 5 s 55 to 64% of idle (target 50%).
- **Correction.** The October 7 report's catch-up-while-saving row (45%, one run) was low; three more runs of that code measured 60.6 to 63.2%. The October 7 report carries the correction in its changelog.

## [0.10.48] - 2026-10-08

### The R2 facts-extraction report describes its write-cost comparators by kind

- [docs/benchmarks/2026-10-08-facts-extraction-model.md](docs/benchmarks/2026-10-08-facts-extraction-model.md): the write-cost context sentence now uses the comparison table's kind labels (`memory-bank`, `extract-first`, `graph-pipeline`, `temporal-graph`, `markdown-notes`) and links to [the table](docs/comparison-systems.md#systems-in-the-open-source-comparison), the one place that names the systems. The figures are unchanged.
- **Version.** Main is at 0.10.47, so this release is 0.10.48.

## [0.10.47] - 2026-10-08

### Facts-absorb quality gate: Claude Haiku 5.5 passes as gbrain's background fact-extraction model, GPT-6 Luna does not; write cost of three extraction models

[Report](docs/benchmarks/2026-10-08-facts-extraction-model.md), [preregistration](docs/benchmarks/2026-10-08-facts-extraction-model/PREREGISTRATION.md) (SHA-256 `8f9be0d9…` frozen before any counted cell; post-run scorer amendments disclosed), gate and write-cost receipts. Item R2 of the 10x plan, wave 0; paired with gbrain #6338. $23.30 of the $40 cap.

- **Gate (gbrain master `1935c74a`, v0.60.110.0).** The real `facts-absorb` job behind `gbrain serve`, on 170 pages of a seeded chat world (529 planted claims) and the 20 Cat 35 transcripts. Under the preregistered rule Claude Haiku 5.5 passes every check against Sonnet 4.6 and GPT-6 Luna fails attribution (−6.6 points); the extractor-disabled and drop-all-output mutants both fail. After the disclosed scorer fixes, the templated world is at a ceiling for all three models; on natural transcripts Haiku 5.5 covers 4.6 points fewer planted items (95% interval −9.0 to −0.6), inside the 10-point harm margin.
- **Write cost (P8 protocol, 1,000 LongMemEval-S sessions).** Extraction off $0.32, today's Sonnet 4.6 default $15.94 (P8 measured $9.94 at v0.60.48), Haiku 5.5 $1.38 per 1,000 pages; GPT-6 Luna's arm hit the 3-hour drain limit (about $1.23, an estimate).
- **Harness.** `eval/runner/facts-absorb-gate.ts` with its scorer and generator, `--rescore` / `--reread` modes, a write-cost arm for an explicit extraction model, and a response-transform hook on the shared metering proxy for the drop mutant. The lifecycle `freePort` test now holds an OS-assigned port instead of fixed port 47998, which sits in the ephemeral range.
- **Version.** Main is at 0.10.46, so this release is 0.10.47.

## [0.10.46] - 2026-10-08

### Open-source memory comparison: gbrain and five open-source memory systems through one harness

[Report](docs/benchmarks/2026-10-06-oss-memory-shootout.md), [preregistration](docs/benchmarks/2026-10-06-oss-memory-shootout-preregistration.md) (frozen 2026-10-06, amendments A1 to A8), [update-and-forget preregistration](docs/benchmarks/2026-10-06-oss-memory-shootout-lifecycle-lite-preregistration.md), per-cell receipts and text-free rows. The systems are named by kind (`memory-bank`, `graph-pipeline`, `extract-first`, `markdown-notes`, `temporal-graph`, `agent-runtime`); [docs/comparison-systems.md](docs/comparison-systems.md#systems-in-the-open-source-comparison) maps each to its project.

- **Primary family (LongMemEval-S, 100 questions, 8,000 tokens of each system's evidence, `gpt-4o` reader).** gbrain at master `c5fb0201`, measured through an adapter that hands the reader bare chunks without titles or dates, answered 59%; `memory-bank` 91%, `graph-pipeline` 83% and `extract-first` 79% are ahead after Holm, `markdown-notes` 69% is not distinguishable and `temporal-graph` 37% is behind. gbrain's strict `recall_all@5` is 97.9%, tied for the top, and its answers reach 78% on the original sessions behind its hits, so the gap is delivery through this adapter, not retrieval. A `gbrain-query` adapter is planned.
- **Also measured.** LoCoMo dev, BEAM-100K dev, the custodian's sealed LoCoMo and BEAM-100K batch (aggregates only, gbrain's pin as the blind row), PrecisionMemBench on the upstream contract (S3) and update-and-forget (lifecycle-lite, report-only). The frontier-reader replays (D2) await a scope decision.
- **Harness.** Ubicloud cell runner with durable leases and a fail-closed metering proxy (`eval/runner/shootout-cell.ts`), the shim protocol and six vendor shims (`eval/systems/`), multi-arm memory QA, the sealed execution profile, the PrecisionMemBench system path and S3 analysis, lifecycle-lite with its mutation kit, and `eval/runner/shootout-report.ts`.
- **Frontier readers (D2).** On the LongMemEval-S primary arm, Opus 5.5, Sonnet 5.5 and `gpt-6.1-sol` lift every system; gbrain gains 7 to 9 points and the order holds. Fable 5.1 is descriptive only.
- **Spend.** $1,079.48 measured across Phases 4 to 7 and D2, plus a $283 reservation with unknown actual spend held against the $1,450 cap.
- **Version.** Main is at 0.10.45, so this release is 0.10.46.

## [0.10.45] - 2026-10-08

### gbrain #6317 mirror: the sync wedge is a pooler round trip that never completes; two consumers were a multiplier

Paired with gbrain #6330 (branch `capy/6317-reliability-contract`, merged as `b5f12b12e`, v0.60.117.0) and the mechanism fix #6329 (v0.60.114.0). No paid call ($0 here); this mirror reruns nothing.

- **Two-consumer and partition arms (mirror, $0 here).** [Report](docs/benchmarks/2026-10-08-managed-sync-clientread-wedge.md). On 16-vCPU Ubicloud VMs behind PgBouncer in transaction mode at 57 ms: 2 h 49 min of `gbrain serve --http` beside a 6-lane `gbrain sync` on v0.60.110.0 published 4,951 pages with no wedge (three arms: plain; adoption load plus CLI restarts; dual direct pool plus restarts), while one `gbrain sync --no-lanes` with no serve wedged within one sample once the client→pooler half of its connections was dropped: backend `active`/`ClientRead`, the consumer's `expired_claims` round trip parked 135 s past its 5 s deadline, renewals lapsing, zero commits, until the network came back. The named await is postgres.js's query promise in `runUnsafe`; the v0.60.112.0 preparation budget does not cover it (run F: 16 members parked 166 s, nothing cut or held).
- **Reading.** `persistence.single_consumer` ships off in gbrain v0.60.117.0 per the preregistered reading (the single-process arm wedged). The fix is the bounded client-side settle in v0.60.114.0; v0.60.117.0 adds direct-lane routing for the consumer's round trips, `owner.backend[]` in `writer status`, and movement-based health.
- **Version.** Main is at 0.10.44, so this release is 0.10.45.

## [0.10.44] - 2026-10-08

### BEAM-1M failure analysis on the development split: the 1M no-memory floor, frontier readers, the oracle ceiling and the reranker; the BEAM date order in the reader prompt fixed

Wave 0 item B2 / E5.3 of the 10x memory advantage plan (gbrain-evals #97, GBRA-60). No gbrain change. Paid: $52.42 of a $60 ledger cap, preregistered before any paid request (46013ab, amendments 05a7cbb, 593b557 and 1d28760). Development split only; no sealed conversation was read.

- **Report.** [BEAM-1M failure analysis](docs/benchmarks/2026-10-08-beam-1m-failure-analysis.md), with [`decomposition.json`](docs/benchmarks/2026-10-08-beam-1m-failure-analysis/decomposition.json) and [`arms-summary.json`](docs/benchmarks/2026-10-08-beam-1m-failure-analysis/arms-summary.json) recomputed keyless by `decompose.ts --check` and `analyze.ts --check`, and every arm's receipts, rows and full answers under `arms/`. The 1M no-memory floor is 26.2% with the `gpt-4.1-mini` bridge and 28.6% to 31.3% with Sonnet 5.5, Opus 5.5 and `gpt-6.1-sol`. On the published top 5, `gpt-6.1-sol` scores 62.0% against the bridge's 53.9% (+8.1 points, 95% interval [4.4, 12.2]); with only the gold turns it reaches 84.9%. The shipped reranker raises strict recall at 5 from 47 to 57 of 198 at gbrain `7aa2caa0` with voyage-4; its answer gain (+3.2) is not distinguished. The three-reader ranking is confounded by unequal output limits (preregistration amendment 3).
- **Free decomposition.** 49 of 194 answerable questions can never pass strict recall at 5; strict recall is 36 of 145 feasible at 5 and 57 of 160 at 10. The 57 questions with no gold in the top 5 are 30 semantic drift, 15 lexical gap and 12 date-scoped. 50 of 220 published answers commit to a wrong value regardless of hedge (model-read labels).
- **Reader prompt date order (fix).** `renderHistory` sorted BEAM's `Month-DD-YYYY` dates as strings, so sessions reached the reader alphabetically by month name, and the fallback "Current Date" was the alphabetically last date, earlier than the true latest session in 8 of 11 BEAM-1M dev conversations. `sessionDateKey` and `latestDate` in `eval/runner/memory-qa/qa.ts` compare BEAM dates as dates; other date formats keep their string keys, so LongMemEval and LoCoMo prompts are byte-identical. Rerun with the fix, the published 53.5% bridge row is 53.9%.
- **Runner.** `memory-qa/run.ts` gains `--retrieved-from` (replay another arm's ranked lists without building a brain), `--qa-context none|oracle` (the no-memory floor and the gold-evidence ceiling), and `--search-limit`, `--pool-depth` and `--max-per-session`. A dev run loads only its split's conversation files. With the reranker pinned on, a run is `invalid` unless every query carries rerank scores, none reports a rerank degradation, and the budget ledger holds a request to the configured reranker model for every reranked query. Claude 5 readers are sent no `temperature`, which they reject. Tests: `test/eval/memory-qa-arms.test.ts`.
- **Version.** Main is at 0.10.43, so this release is 0.10.44.

## [0.10.43] - 2026-10-08

### One usage receipt for every reading lane, the reading headroom recount, and model rules that match the project rule

Wave 0 items A1, A2 and R1 of the 10x memory advantage plan (gbrain-evals #97, GBRA-60). No gbrain change and no paid call ($0).

- **Shared usage receipt (A1).** [`eval/runner/usage-receipt.ts`](eval/runner/usage-receipt.ts) defines `usage-receipt/v1`, documented in [docs/usage-receipt.md](docs/usage-receipt.md): total, uncached, cache-read and cache-write input, output and reasoning tokens, the full answer, a provider-neutral finish reason and delivered tokens with the tokenizer named, one record per replicate and per attempt. Anthropic's separate cache buckets are summed; OpenAI's cached and cache-write tokens are already inside `prompt_tokens` and are never added on top (the committed W10b `gpt-5.4` arm shows the size of that error: 17,004 against a billed 14,458 mean). memory-qa now writes the receipt for reader, `think` and judge calls (`readAndJudge` in `eval/runner/memory-qa/run.ts`): the `think` lane records `think`'s returned usage instead of the question's characters, every replicate keeps its full answer instead of the last one cut to 2,000 characters, a row with no provider usage says so instead of reporting a count, and reader rows carry cl100k delivered tokens. The W10 re-score reads committed usage through the same normalizer and still reproduces every committed summary byte for byte. New test: `test/eval/memory-qa-usage.test.ts` (recorded synthetic Anthropic and OpenAI responses, retries, failures, cache hits, `think` usage, a 5,000-character answer, and the committed W10 means 22,167, 22,077, 13,695 and 14,458).
- **Reading headroom recount (A2).** [Report](docs/benchmarks/2026-10-08-reading-headroom.md), [`headroom.json`](docs/benchmarks/2026-10-08-reading-headroom/headroom.json) and [`eval/runner/reading-headroom.ts`](eval/runner/reading-headroom.ts), from the committed W10a and W10b receipts; exploratory, not preregistered. The answer's own sessions are 41% of the 15,823 chars/4 tokens gbrain delivers (8,981 on multi-session questions); readers' notes run 138.5 (Sonnet 5.5), 150.8 (Opus 5.5) and 62.5 (`gpt-6.1-sol`) tokens; committed wrong answers are 25 of 470 answerable for Sonnet 5.5 (W10a) and 19 for Opus 5.5, and 29 and 24 for Sonnet 5.5 and `gpt-6.1-sol` on the W10b text. The commitment counts rest on agent-written labels ([`commitment-labels.json`](docs/benchmarks/2026-10-08-reading-headroom/commitment-labels.json)) that no person has reviewed.
- **Model rules and prices (R1).** CLAUDE.md "Choose models" and AGENTS.md follow the 2026-10-07 project rule: counted runs use the newest Opus, Sonnet and GPT (`claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-6.1-sol`), Fable runs only in smoke tests, `gpt-4.1-mini` only as the bridge to earlier BEAM runs, never `gpt-5.4-mini`. `scripts/model-freshness.ts` blocks `gpt-5.4-mini` and flags Fable and `gpt-4.1-mini`. The budget ledger prices `claude-haiku-5-5` ($0.10 / $0.50, and $0.50 / $2.50 above 100,000 input tokens) and the GPT-6 long-prompt rates above 272K input tokens, reserving and settling at the long rates only when a prompt crosses the threshold.
- **Ledger correction.** `usageCost` settled OpenAI cache writes (`cache_write_tokens`) at the uncached input price; it now uses the cache-write price. The committed `gpt-6.1-sol` arms of W10b and W10c were settled the old way and are understated by about $6 in total if the batch discount applies to cache writes; their receipts are left as recorded.
- **Version.** Main is at 0.10.42, so this release is 0.10.43.

## [0.10.42] - 2026-10-08

### gbrain #6278 mirror: a stuck write is cut off and held within 240 s; a table lock still pins the pool

Paired with gbrain #6298 (branch `capy/6278-preparation-deadline`, merged as `b65d4bae7`, v0.60.112.0), which fixes issue #6278.

- **Preparation stall before and after (mirror, $0 here).** [Report](docs/benchmarks/2026-10-08-managed-sync-preparation-stall.md), [`results.json`](docs/benchmarks/2026-10-08-managed-sync-preparation-stall/results.json) and the raw captures (report, per-pass tables, stall captures, 30 s timelines; the lock runs keep their full samples). A 15,000-entry catch-up with heavy fact adoption behind a transaction-mode pooler at 57 ms, on 16-vCPU Ubicloud VMs: v0.60.105.0 never drained (102 pages in 47.6 min at pool 10, 62 at pool 3, with no page committed for 888 s and 668 s). The fixed head drained in 2 passes (91 min) at pool 10 and 3 passes at pool 3, with 0 failed fence receipts, 0 watchdog stops and 20 files held with their reason. The report records how the cause picture moved: a lock-wait class proven by a forced probe (`LOCK TABLE pages` through the pooler), a never-settling await found live by the reporter's managed brain (open as gbrain #6317), and two zero-progress modes (the lock wait, and adoption writes queued ahead of the sync).
- **Goals.** G1 (one request never stops the catch-up) is partly met: a stuck write is cut off at 120 s and held at 240 s, but a table lock still pins 9 of 10 pool connections until it drops (gbrain #6318). G2 (writer status names the step) and G3 (fence defects never consume the write path) are met. G4 (`fence_repair` during a sync) is not met in this release: 22 candidates, none repaired. G5 meets its rate and watchdog parts (1,500-file bench 150.4 to 150.0 pages/min wall and 401.5 to 378.1 steady; 0 watchdog stops in 5 passes) but one pass does not drain 15,000 entries at a 3600 s timeout; it does at the reporter's 14,400 s by arithmetic, and no run used that timeout.
- **What this mirror could not measure.** The 15,000-entry runs ran at `846bea442`, before the bounded reads and the two follow-up fixes; the merged head was checked by the 1,500-file bench and the lock runs only. Foreground `put_page` latency during the catch-up, a database outage and several poisoned entries in one run were not measured.
- **Version.** Main is at 0.10.41, so this release is 0.10.42.

## [0.10.41] - 2026-10-08

### gbrain #6279 mirror: managed Postgres catch-up at 368 pages/min, a page save at 2.5 s

Paired with gbrain #6279 (branch `capy/sync-feeder-fast-writes`, measured at `0ba3b1f7c`, merged as `9d013e52d`, v0.60.111.0).

- **Catch-up and put_page before and after (mirror, $0 here).** [Report](docs/benchmarks/2026-10-07-managed-sync-lanes-foreground.md), [`results.json`](docs/benchmarks/2026-10-07-managed-sync-lanes-foreground/results.json) and the raw bench JSON for every row. Master `a865f8f8` and the branch on 16-vCPU Ubicloud VMs at 57 ms: the 10,000-file backlog takes 33.6 min (was 74.5), steady 367.9 pages/min (was 174.8), idle `put_page` p50 2.46 s (was 8.6), 3,332 pages/min near the database (was 2,404). Three of gbrain's targets missed and are recorded as missed: first commit (18.4 s against 15 s), `put_page` p95 during a catch-up (idle + 1.5 s against idle + 1 s) and catch-up while a page is saved every 5 s (174.4 pages/min, 45% of idle against 50%; master 0.4 with 115 of 120 saves failed).
- **Version.** Main is at 0.10.40, so this release is 0.10.41.

## [0.10.40] - 2026-10-07

### gbrain fix wave 12 agent smoke: the forget-caveat move regresses Opus 5.5 write-back; the restored put_page UUID line does no harm

Paired with gbrain fix wave 12 (GBRA-57, branch `capy/fix-wave-12`, head `209b20a96`, v0.60.106.0) against `capy/fix-wave-11` head `027d3c69f`. Shipped in gbrain v0.60.106.0, merge commit `7aa2caa0` (#6269), with W4.6 reverted (the shipped instructions are byte-identical to the baseline's) and W4.16 kept.

- **Agent smoke (Cat 40, $38.88).** [Report](docs/benchmarks/2026-10-07-wave12-agent-smoke.md), [preregistration](docs/benchmarks/2026-10-07-wave12-agent-smoke-preregistration.md) committed before any cell, with amendment 1 (one attribution set) written after the preregistered cells and before that set ran. #92's harness and gated cells, `gbrain` arm, `claude-opus-5-5`, `claude-sonnet-5-5` and `gpt-6.1-sol`. Permission tasks: 60/60 on both builds, no leaks. Write-back: 60/60 against 55/60, all of it Opus 5.5 (20/20 to 15/20), so the preregistered W4.6 gate reads regress. The wave 12 build serving the baseline's instructions gives Opus 19/20, which names the instruction change. W4.16: Opus non-UUID first-write `request_id` 17/30 on the baseline and 14/30 on wave 12 (p = 0.61), so it does no harm but shows no measured gain. Five of six model-family cells are at the ceiling. No model called `put_page`. Computed, not measured: on the full surface the move pushes 152 characters of clause 7's "what is true now" sentence past a 2,048-character cap (53 before).
- **Version.** Main is at 0.10.39, so this release is 0.10.40.

## [0.10.39] - 2026-10-07

### gbrain fix wave 11: relaxed HNSW scan order ships default-on; the D12 agent smoke passes

Two records paired with gbrain fix wave 11 (branch `capy/fix-wave-11`, head `b5c8fd5e8`, v0.60.103.0).

- **W6.3, relaxed HNSW scan order (mirror, $0 here).** [Report](docs/benchmarks/2026-10-07-hnsw-relaxed-order.md), [`verdict.json`](docs/benchmarks/2026-10-07-hnsw-relaxed-order/verdict.json), raw tables and logs, and a copy of gbrain's `scripts/bench/hnsw-iterative-scan.ts`. On about 60,000 chunks of real text, 100 queries, Postgres 16 with pgvector 0.8.7, recall@10 at a 50% source filter goes from 0.962 to 0.983 with `voyage-4` at 1,024 dimensions and from 0.950 to 0.967 with `text-embedding-3-small` at 1,536 dimensions; k=50 and the 10% filter are unchanged (the 10% rows are exact in both modes). Latency moves both ways, by at most 3.7 ms at p50 and 5.7 ms at p95. Verdict: `relaxed_order` ships default-on, with `search.hnsw_iterative_scan strict_order` as the escape hatch. The lane's 128-d synthetic numbers (+8.3 points filtered recall) are recorded as a limit. Idea from #6132 by @MarvinDontPanic.
- **D12 agent smoke (Cat 40, $49.21).** [Report](docs/benchmarks/2026-10-07-wave11-agent-smoke.md), [preregistration](docs/benchmarks/2026-10-07-wave11-agent-smoke-preregistration.md) committed before any cell with one amendment (separate `--gbrain-root` per build, Bun 1.4.2). gbrain master `5b5891069` against the wave, same window, `gbrain` arm, `claude-opus-5-5`, `claude-sonnet-5-5` and `gpt-6.1-sol` counted, `claude-fable-5-1` smoke-only. Verdict: pass. Permission tasks 60/60 on both builds with no leaks; write-back 55/60 on master and 56/60 on the wave with no unsafe writes. Five of six model-family cells sit at the ceiling. No model called `put_page`, so its shorter description is untested by agents; Opus 5.5 sent a non-UUID `request_id` on its first write in 12 of 20 write-back cells on master and 17 of 20 on the wave (p = 0.16), and recovered every time.
- **Version.** 0.10.39, the next free version after #94 shipped 0.10.38.

## [0.10.38] - 2026-10-07

### The budget-ledger scale test measures the ledger, not the runner's disk

`test/eval/budget-ledger-sqlite.test.ts` "reserve+settle averages under 5 ms on a 200k-entry ledger" turned main's CI red (run 37685939608: a 1k-entry mean of 15.3 ms against a 9.0 ms median, and a 200k-entry mean of 5.5 ms against a 0.6 ms median). Each reserve and each settle is a durable `synchronous = FULL` commit, so every timed pair waits for two fsyncs of the WAL, plus a fsync of the database file at each automatic checkpoint. On GitHub's runner, with the other test shards writing to the same disk, a few of those fsyncs take hundreds of milliseconds. They set the mean, and they have nothing to do with how many entries the ledger holds. In the failing run, the 200k-entry ledger was faster per pair than the 1k-entry one. The test now keeps its scale ledger on tmpfs (`/dev/shm`, where fsync does not wait on a disk) and checkpoints the seeding writes before timing. It runs the same ledger code, and the 5 ms mean bar and the no-growth median check are unchanged.

Evidence, with a stall-injection shim (`LD_PRELOAD` over `fsync` and `fdatasync`, stalling only files on a disk):
- **The old test fails on stalls alone.** With one in fifty disk fsyncs stalling 200 ms, it failed 3 of 3 runs (200k mean 8.4 to 8.5 ms, median 0.33 to 0.38 ms). With each checkpoint's database-file fsync taking 500 ms, it also failed 3 of 3 (mean 5.4 ms, median 0.3 ms): the CI signature.
- **The new test ignores stalls.** It passed 3 of 3 under each injection, and 20 of 20 with both injected at once (200k mean about 0.1 ms).
- **The new test still catches the regressions it guards against.** Making settle find its entry without the id index failed it 3 of 3 (200k mean 56.6 to 57.8 ms). Making reserve sum the run's entries failed it 3 of 3 (33.8 to 36.6 ms).
- **It holds under load.** The whole test file passed 25 of 25 runs with four CPU-bound processes and two fsync-heavy disk writers running beside it.

## [0.10.37] - 2026-10-07

### The October follow-up round: re-pin to gbrain v0.60.104.0, privacy gates, current-model reruns and LongMemEval at the current pin

One wave of the [2026-10 follow-up round plan](docs/plans/2026-10-06-followups-round/PLAN.md) (approved by Garry with its autoplan reviews). Every paid or gating measurement has a preregistration committed and pushed before its first cell, now enforced: runners record an attestation against `origin` and a new CI job (`eval/runner/prereg.ts`, full history) fails when a result file predates its preregistration. API spend: $210.82 of a $297 round cap, all through one budget ledger; no sealed set was opened.

**Re-pin.** gbrain moves from `739e5cc` (v0.60.46.0) to `a865f8f` (v0.60.104.0), in two steps. The step to `c5fb0201` (v0.60.95.0) brought one regression: gbrain's maintenance sweep made acknowledged ontology observations unreadable after a page rewrite (N1-7, from gbrain `7007ba60` in #6024), which failed the N1 CI slice on loaded machines. Otherwise no category got worse. N9 composed multi-hop questions rose from 2.7% to 61.9% strict all-hit@10 (P7 planner), and temporal-edge traps from 0.45 to 1.00 (P1). gbrain #6265 fixed N1-7, and the pin moved on to `a865f8f` under a dated preregistration amendment. There, the repro and N1-ci pass, also pinned to one core, and N1-7 is closed as fixed. On paired VMs, the offline tier, all 28 ledger repros and every check report the same results at `c5fb0201` and `a865f8f`, apart from N6. A Cat 7 slowdown on the first VM pair reversed in the preregistered repeat. Free and gating results are stated at `a865f8f`. The paid results below were measured at `c5fb0201` and none of them uses the ontology with the sweep. Cat7-1 stays open (0.078 ms against a 0.056 ms bar). Fixes found by the re-pins: N6 parsed notice blocks as part of a response and read `latency_ms` as an existence oracle (N6-2), and at `a865f8f` read `open_loops`' `as_of` clock the same way (N6-3), both harness defects; the takes-bootstrap refusal test uses a synthetic unpriced model now that gbrain prices `gpt-6.1-sol`; N12 gains a renderer for gbrain's new `email-thread-heading` format (28 of 28); `requirePaidArm` ignored `--budget-ledger`. [Report](docs/benchmarks/2026-10-06-followups-repin.md).

**Privacy.** Proactive recall (N8) now gates CI: 0 private pages to remote callers or the turn block, and the same rules catch the old leak. N6 on Postgres over the real HTTP transport: 155 of 155 mandatory cells across five kinds of caller, 0 leaks, with a control build that leaks 470. [N8](docs/benchmarks/2026-10-06-n8-privacy-gate.md), [N6](docs/benchmarks/2026-10-06-n6-postgres-http.md).

**LongMemEval answers.** At the current pin with the Sonnet 5.5 benchmark notes reader: 468 of 500 (no change shown against the same reader on the 2026-09-29 retrieval, 462). On that frozen retrieval, Opus 5.5 (474) and Sonnet 5.5 direct (465) beat Sonnet 4.6's 453 after Holm; `gpt-5.4` with the official prompt answers 460. Pasting the whole history into the reader stays within the preregistered 7 points of gbrain on 150 questions (Sonnet 5.5 144 vs 139; GPT-6.1 Sol 141 vs 137) at about seven times gbrain's recurring cost. A new batch lane under `eval/runner/batch/` reserves every batch in the ledger, submits exactly once and re-scores keylessly. [Current pin](docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin.md), [reader replay](docs/benchmarks/2026-10-07-longmemeval-w10b-reader-replay.md), [full context](docs/benchmarks/2026-10-07-longmemeval-w10c-full-context.md).

**Current-model reruns.** N2's contradiction judge passes every rule with GPT-6 Luna, Sonnet 5.5, GPT-6.1 Sol and Opus 5.5 (0 of 251 compatible pairs flagged, against Haiku 4.5's 6 of 51); the cheapest is GPT-6 Luna at $0.21 per 1,000 pairs. The takes-bootstrap classifier makes 0 forbidden attributions on Sonnet 5.5, GPT-6.1 Sol and Opus 5.5 (Haiku 4.5: 3) but is not graduated. Cat 20 is inconclusive: gbrain's internal judge passes 0 of 216 ideas while three outside judges score them 3.11 to 3.55. A4 with the Jev S4 signal abstains on 120 of 120 unanswerable questions with no false refusal, at a ceiling. [N2](docs/benchmarks/2026-10-06-n2-judges.md), [takes](docs/benchmarks/2026-10-06-takes-bootstrap-frontier.md), [Cat 20](docs/benchmarks/2026-10-06-cat20-judges.md), [A4](docs/benchmarks/2026-10-06-a4-s4-on.md).

**Retrieval and harness checks.** The reranker adds 13 to 17 points on held-out concept questions for every embedder, and no embedder beats `voyage-4` (130 of 181). Cat 21 gets 24 paraphrased questions; a code embedder does not help. Negative controls: Cat 14, Cat 35 and LongMemEval answers notice a broken configuration; Cat 20 and Cat 29 do not and become report-only. BEAM-1M with every session dated keeps strict recall at 18.2%, identical at the new pin. Attendance from documented `## Attendees` lists is stored exactly (132 of 132) and template questions fire 150 of 150, but paraphrased wording fires 0 of 150, so W3 is inconclusive by its rule. [Embeddings](docs/benchmarks/2026-10-06-embedding-matrix.md), [Cat 21](docs/benchmarks/2026-10-06-cat21-paraphrase.md), [controls](docs/benchmarks/2026-10-06-negative-controls.md), [BEAM-1M](docs/benchmarks/2026-10-06-beam-1m-dates.md), [attendance](docs/benchmarks/2026-10-06-attendance-world.md).

**Models.** Under Garry's 2026-10-07 rule, Opus 5.5 is the top Anthropic model in counted results and Fable is smoke-only. Fable 5.1 cells that ran before the rule (takes, Cat 20, N2, the 200-question reader replay) are kept and labeled, with dated amendments; no verdict changes without them. The Cat 40 and Cat 41 F1/F10 check moves to Sonnet 5.5, GPT-6.1 Sol and Opus 5.5. `scripts/model-freshness.ts` names the newest model per family and blocks unpriced models.

**Awaiting a person.** Two review packets for Garry are in [`docs/benchmarks/2026-10-06-w11-review/`](docs/benchmarks/2026-10-06-w11-review/README.md): the 38 `auto_chronicle` reference labels (about 15 minutes) and an optional blind Cat 35 judge calibration. Their scoring rules are preregistered and the offline scorer is `scripts/w11-score.ts`; results ship in a later release.

## [0.10.36] - 2026-10-06

### Tier 3 fence repair across five models, two rounds (gbrain #6188, T4)

gbrain repairs malformed facts and takes tables in tiers; Tier 3 sends the rows deterministic rules cannot place to a chat model and writes the answer only if it passes seven validation gates, which check that text is preserved but not which free-text column it belongs in. [The report](docs/benchmarks/2026-10-06-fence-repair-tier3.md) covers two preregistered rounds ([preregistration](docs/benchmarks/2026-10-06-fence-repair-tier3-preregistration.md), [amendment 1](docs/benchmarks/2026-10-06-fence-repair-tier3-amendment-1.md)), three runs per model on fresh brains through gbrain's production path.

**Round 1** (gbrain `171a7e24`, prompt v1, 78 synthetic fences): gate-pass 96.5% to 100%, but the default `claude-opus-4-7` put a cell in the wrong column in 8 of 198 repairs (4.0%, bar 1%); `gpt-6.1-sol` (1 of 198) and `claude-fable-5-1` (0) met the bar. The report proposed seven fixes, and gbrain's PR 4 made them.

**Round 2** (gbrain `7d75e08c`, prompt v2 with a `HOLD` decline, a Tier 1 rule for stray empty cells, split claims and extra text cells held for a person, a reasoning allowance): measured on the round 1 fixtures and on a 52-fence held-out set frozen before the new code ran. `gpt-6.1-sol`, `claude-opus-5-5` and `claude-fable-5-1` qualify: on the held-out set they repaired 95, 95 and 93 of the 99 attempts that reached the model with no wrong cell and answered `HOLD` on the rest. `claude-opus-4-7` fails on the round 1 fixtures (3 of 165) and `claude-sonnet-5-5` on both sets. With an Anthropic key only, the default becomes `claude-opus-5-5` (gbrain [`51f4602d`](https://github.com/garrytan/gbrain/commit/51f4602d4420ee5471984bac19e8a948d939fc73)), which ties `gpt-6.1-sol` and beats Fable 5.1 on gate-pass, cost and speed. A claim cut by an unescaped pipe in a fence with no header reached the model at the measured code; gbrain fixed that routing before shipping, and the result shipped in v0.60.102.0 ([`5b5891069`](https://github.com/garrytan/gbrain/commit/5b5891069), #6229), where a $0 routing replay moves only that fixture to manual. Raw per-fixture rows, summaries and verdicts for both rounds are committed with a keyless recount test and receipts-manifest entries. $23.50 in all.

## [0.10.35] - 2026-10-06

### P2 held-out records, the P4 core-gate remainder and P6's LongMemEval-M confirmation

**P2: date-grounded extraction and speaker attribution on, hub dampening removed.** Mirrors gbrain [#6020](https://github.com/garrytan/gbrain/pull/6020) (merged as `e7f59913e` in v0.60.94.0) in [the P2 page](docs/benchmarks/2026-10-05-heldout-program/p2.md). Date-grounded extraction passes E2 on 7 sealed LoCoMo conversations (1,076 questions): saved facts with an unresolved relative date fall from 8.95% to 2.05% (−77% relative, CI [−8.3, −5.5] points), temporal QA holds (+0.8 [−1.2, +2.7]) and overall QA rises (+1.2 [+0.6, +1.7]); per-prompt checks turn it on for dream synthesis, `extract_atoms` and `propose_takes`, and life chronicle events stay opt-in after missing criterion (a) on a floor. Speaker attribution passes E3 on 60 sealed synthetic conversations: assistant-said QA rises from 44.1% to 95.8% (+51.7 [+42.9, +60.3]) with every guard passing, at about 41% more saved facts per conversation. Hub dampening at H = 32 fails E1 on all 12 cells of sealed hub-world seeds 2 and 3: both rivals beat it on concept nDCG@5 and hub-as-answer falls 10.0 to 36.2 points against a −0.5 guard, so gbrain#6020 removed the search-side mechanism before merge. The three P2 verdict files join the verdict index.

**P4 core gate, report-only models complete.** The `claude-opus-5-5` and `claude-fable-5-1` runs that stopped at their budget caps were resumed to completion on all 14 sealed BEAM-100K conversations (56 questions, $197): Opus 89.1% → 89.4%, +0.3 points [−5.9, +6.5]; Fable 89.3% → 86.8%, −2.4 [−8.9, +4.2]. The earlier partial figures (+3.4, +2.3) did not hold. Fable is a second model below zero if all four models gate; the verdict is FAIL either way and core memory stays off. The four-model custodian aggregate, `p4-core-heldout-2026-10-06.json`, joins the verdict index, and the P4 page and the program scorecard cite it.

**P6 LongMemEval-M confirmation: not runnable.** The preregistration leaves the sealed LongMemEval-M split to the eval harness owner, and none was ever defined: the frozen harness `cf270c2` marks every LongMemEval question id as development data (`lme-s.json`, `dev_fraction` 1; S and M share ids), and its memory-qa runner has no LongMemEval-M path. P6 development also used 470 LongMemEval-M questions. No run was made ($0); the sealed LoCoMo pass stands as P6's evidence.

## [0.10.34] - 2026-10-06

### P5 held-out records: wanted pages on, typed relation lines and the similar-page hint off

Mirrors gbrain [#6017](https://github.com/garrytan/gbrain/pull/6017) (merged as `426e129ec` in v0.60.93.0) in [the P5 page](docs/benchmarks/2026-10-05-heldout-program/p5.md). Wanted pages pass: sequential writes lose 0 of 3,738 edges instead of 1,849 of 3,810, and withheld-entity recall is 1.000 over local writes and over HTTP (H4, H8), so `wanted_pages.enabled` and `wanted_pages.remote` ship on. Typed relation lines pass H1 and H2 but fail H3: the grammar minted 18 of 696,295 held-out list lines, all fact lines from unfilled template slots and dictionary usage labels, precision 0/18 (Wilson 95% [0.00, 0.18]) against 0.95, so `line_grammar.enabled` ships off and H6 does not run; a placeholder guard waits for a follow-up with its own held-out frame. The similar-page hint passes H5a but fails H5b on wrong merges (+1.25 points against a +1 bar, all in the `gpt-6.1-sol` arm), so `put_page.similar_pages` ships off. Validity ranges (H7) and the link-typing changes (H9) pass; the advisory-role guard and the post-freeze typing and lexicon changes failed their set G and set H re-checks and were removed. The P5 verdict files join the verdict index.

## [0.10.33] - 2026-10-06

### P6 held-out records: the `think` date frame ships on

Mirrors gbrain [#6112](https://github.com/garrytan/gbrain/pull/6112) (merged as `43b0adb69` in v0.60.88.0) in [the P6 page](docs/benchmarks/2026-10-05-heldout-program/p6.md). The date frame gives `think` the current date and the content dates of the page blocks it reads. On sealed LoCoMo (7 conversations, 1,399 questions) judged accuracy rises from 74.2% to 88.2%, +14.0 points with a clustered 95% CI of [+11.8, +16.2], 229 wins and 33 losses; temporal questions go from 27 to 199 of 221, and retrieval is identical in both arms. The first sealed pass stopped at its $80 ledger cap after 4 of 7 conversations, and the 142 rows whose `think` call the cap refused were answered again in a second pass, so every question has one answer; spend was about $162. `think` p95 latency, measured on 150 LongMemEval-S development questions because the sealed lane times retrieval only, has a ratio of 0.93 [0.88, 1.03], within the +20% bar. The LongMemEval-M sealed confirmation is pending. Fact keys failed the `tokenmax` gate on LoCoMo development data and stay a recorded negative result; time scope and notes-first reading were killed in development. The LoCoMo verdict file joins the verdict index.

## [0.10.32] - 2026-10-06

### P4 held-out records: pre-compaction save notice on, core memory tier off

Mirrors gbrain [#6015](https://github.com/garrytan/gbrain/pull/6015) (merged as `66cf3f589` in v0.60.87.0) in [the P4 page](docs/benchmarks/2026-10-05-heldout-program/p4.md). The growth-aware save notice passes its sealed pressure gate on BEAM-500K with `claude-sonnet-5-5`: 51.7% → 63.0%, +11.35 points [+8.3, +14.4] over 460 paired questions, with no question type's interval entirely below −2.0. It costs $0.87 instead of $0.68 per question and $1.38 instead of $1.32 per correct answer, and ships on. The pressure gate ran before the BEAM loader's date fix (0.10.31); both arms saw the same headers, so the paired verdict stands, but the temporal-reasoning and event-ordering breakdowns were measured with most session dates hidden. The always-loaded core memory tier fails its sealed core gate on BEAM-100K: `gpt-6.1-sol` −2.4 points [−5.4, +0.3], from an instruction-following drop, against a bar of at least 0 on every model; `claude-sonnet-5-5` is +4.6 [−0.4, +10.7]. Core ships off as an opt-in. The `claude-opus-5-5` and `claude-fable-5-1` core runs stopped at their budget caps (32 and 28 of 56 questions); their remainders are report-only, cannot change the verdict, and land in a later pull request. The pressure gate's aggregate verdict file joins the verdict index.

## [0.10.31] - 2026-10-06

### BEAM loader dates every session

BEAM dates each batch once, on the first message of its first turn group. The memory-qa loader (`eval/runner/memory-qa/corpus.ts`, used by the decision kit, the starting line and the P4 streaming harness) made one session per turn group, but took a date only from a message inside that group. So on development data only 21 of 486 BEAM-100K, 110 of 4,728 BEAM-500K and 106 of 9,003 BEAM-1M sessions carried a date. Every turn group now takes its batch's date (`beamGroupDates`, unit-tested), which gives 3 to 10 distinct dates per conversation. Paired comparisons saw the same undated sessions in both arms. A reported-only BEAM-100K dev rerun on the starting-line build moves strict R@5 from 45.4% to 47.2% and reader accuracy from 57.1% to 58.0% ([note](docs/benchmarks/2026-10-05-heldout-program.md#the-starting-line-on-master)). $0.76.

## [0.10.30] - 2026-10-06

### P8 held-out records: write guard, semantic withdrawal, quote grounding, advertised surface

Mirrors gbrain [#6027](https://github.com/garrytan/gbrain/pull/6027) (merged in v0.60.77.0) in [the P8 page](docs/benchmarks/2026-10-05-heldout-program/p8.md). Write cost and the review-gated withdrawal pass. Quote grounding failed its first sealed run (15 of 319 supported quotes wrongly flagged, Wilson upper 7.6%) and a second-custodian rescore (16 of 319). It passes a retest on fresh custodian-written synthetic sessions: 5 of 321 wrongly flagged, Wilson upper 3.59%. A retest on sealed-confirmation-v2 was stopped and is void; the corpus exposure is recorded in the v2 protocol. Narrower advertised tool surfaces fail in both arms on the sealed Cat 40 world (`starter` −8.5 points, `verbs` −9.9), so new installs keep advertising `full`. The quote-grounding runner attributes flags to spans by exact text (`flaggedSpans`), gains `--exclude-questions` and `--resume`, and the P8 dev receipts are restored. Retest spend about $15.

## [0.10.29] - 2026-10-05

### Mirror: gbrain fix wave 9 pins `search_path` at about 10-13% insert cost; takes-quality receipts move to protocol 2

gbrain #6111 (fix wave 9, v0.60.74.0, open and pending merge at head `1fbe8660c`) carries two changes recorded here ([report](docs/benchmarks/2026-10-05-fix-wave-9-mirror.md), [`verdict.json`](docs/benchmarks/2026-10-05-fix-wave-9-mirror/verdict.json), upstream text verbatim in `upstream/`). Nothing was rerun; $0.

- **`search_path` pinning (#5190, migration v211 `function_search_path`): accepted cost.** Every gbrain plpgsql function pins `search_path`, a security hardening. On the wave lane's own machine (3 runs per side, ranges only), 10,000 fact inserts through the withdrawal trigger went from 1.31-1.46 s to 1.45-1.69 s on PGLite and from 531-536 ms to 565-604 ms on Postgres 16: +13% and +10% at the midpoints, 6-16% at the range ends. The cause is the trigger's pinned setting. A 24-claim fact-fingerprint golden is byte-identical before and after on both engines, and the fingerprint index is still used. Not a retrieval change.
- **Takes-quality protocol 2 (#5325): comparability note, not a verdict.** One same-model correction per malformed judge slot, priced against the cap first; valid low scores are never re-asked. Receipts gain `protocol_version`, `correction_selection_rule` and `corrections`, and `regress` treats a protocol change as dissimilar inputs. No before/after score was measured. Compare takes-quality receipts only within one protocol version; this repository has published none so far.
- **Version.** #78 and #80 took 0.10.26 and 0.10.28, so this release is 0.10.29.

## [0.10.28] - 2026-10-05

### Held-out follow-ups for the merged plans: root causes, fresh-wording rechecks, sealed-v2 exposure

A second custodian reread the failed held-out decisions of the merged plans and ran rechecks on phrasing sets that share no wording with earlier sets. All runs here are deterministic; $0 in model calls.

- **P3 root causes** ([report section](docs/benchmarks/2026-10-05-heldout-program.md#root-causes-of-the-p3-failures-custodian-analysis)). E1's flat LoCoMo result is a limit of the benchmark shape (feedback weights apply and move 18% of rankings at λ = 0.1, with no net signal), not a harness bug. E4's miss is parser coverage: triplet scoring changes all 37 questions where the relational arm fires and gains +2.27 NDCG@10 points there. E5 is a product defect.
- **P3 E5 retest on fresh material** ([record](docs/benchmarks/2026-10-05-heldout-verdicts/p3-e5-setf-retest-2026-10-05.json)). Without the advisory-role guard, 23 of 23 single-value closures are wrong; with it, 0 are applied and every gate passes. No E5 run has recorded a correct closure, so `dream.single_value.mode` stays `propose`.
- **P1 E1 on a third phrasing set** ([record](docs/benchmarks/2026-10-05-heldout-verdicts/p1-e1-sete-2026-10-05.json)). This fails traps at 89 of 105: the employment lexicon misses the set's join, leave and move cues, so ended jobs stay live.
- **Sealed confirmation v2 exposure** ([protocol](docs/benchmarks/2026-10-01-sealed-confirmation-v2-protocol.md#access-policy)). The corpus's sessions were used for gbrain P8 quote grounding on custodian machines; future v2 decisions must name this.
- **Report.** The program report gains a changelog. Plans still in progress publish their records in their own pages under `docs/benchmarks/2026-10-05-heldout-program/`.

## [0.10.26] - 2026-10-05

### Mirror: managed Postgres catch-up goes from 3.4 to about 150 pages a minute 57 ms from the database

gbrain measured its managed-sync catch-up on a 57 ms latency rig across three releases
([#5996](https://github.com/garrytan/gbrain/pull/5996), v0.60.48.0; [#6021](https://github.com/garrytan/gbrain/pull/6021),
v0.60.58.0; [#6098](https://github.com/garrytan/gbrain/pull/6098), v0.60.73.0). Pages per minute went from 3.4
(v0.60.39.0, one page per run) to 13.1, 28.8 and finally 152.8 in steady state with six lanes saving groups at once
(137.4 over the whole 10k run; the 10,000-file backlog from about 49 h to about 1.2 h). Foreground page writes stay
within about 1.7 s of idle at p95 with no failures. The bench output is copied into
`docs/benchmarks/2026-10-05-managed-sync-catchup/raw/` and summarized in `results.json`
([report](docs/benchmarks/2026-10-05-managed-sync-catchup.md)). Nothing was rerun here; $0.

## [0.10.25] - 2026-10-05

### Mirror: gbrain's Hangul end-boundary rule cuts word-internal mention matches from 1,041 to 11

gbrain #6080 (v0.60.69.0) makes a Korean name end at a non-Hangul character or at an attached title, particle or copula form. On 7.3M characters of public Korean text, word-internal false matches fell from 1,041 to 11, while 65 of 74 real name mentions still matched. Precision over real names plus word-internal matches rose from 6.6% to 85.5%. Report, scripts and per-match labels: [docs/benchmarks/2026-10-05-hangul-mention-boundaries.md](docs/benchmarks/2026-10-05-hangul-mention-boundaries.md). Labeling cost $0.36.

## [0.10.24] - 2026-10-05

### README describes other memory systems by kind

README's "How gbrain compares" section and its changelog no longer name other memory projects; each is described by
kind (for example "a verbatim-session memory system"). Names, versions and sources stay in
[comparisons and their protocols](docs/comparison-systems.md), which README links. No measurement changed; $0.

## [0.10.23] - 2026-10-05

### Top-level docs read as the current state, with a changelog per document

README, the docs index, the settings guide, retrieval lessons, the comparison page, the evaluation guide, the
contributor guide and the credits now open with what gbrain does at the pinned commit (`739e5cc`, v0.60.46.0) and
close with a `## Changelog` section recording how that document changed and why, one entry per commit, newest first.

- **README.** Three parts: what gbrain does, current results (one table, each number with its gbrain commit and
  report) and how gbrain compares (strict LongMemEval retrieval, answer accuracy with the same reader,
  PrecisionMemBench, concept search, Cat 40 against files, Postgres and the memory tool), then known limits. The
  dated "Update, October 2/3/4" blocks move to its changelog. New on the page: Cat 40 on frontier models, the
  multi-relation planner's held-out pass (gbrain v0.60.60.0) and the held-out program.
- **Settings and retrieval lessons.** Dated "October 4, 2026:" amendments become current statements (opaque-id
  recount at `109b992`), a `return_unit` row and a whole-conversation delivery section are added, and the September 6
  values move to the changelog.
- **Comparison page.** Sentences about earlier versions of the page now state the current position; the history is
  in its changelog.
- **CLAUDE.md** records the shape (current state on top, a per-document changelog below), and AGENTS.md summarizes
  it so Codex and other agents that read only AGENTS.md see it.

No measurement changed; $0.

## [0.10.22] - 2026-10-05

### Mirror: gbrain's takes-bootstrap classifier did not graduate; its autopilot stays `manual_only`

gbrain's first live graduation run of the takes-bootstrap eval
([#6013](https://github.com/garrytan/gbrain/pull/6013), merge `d37fab68e`,
v0.60.59.0; measured 2026-10-04 with Claude Haiku 4.5, $0.0935) passed 75 of
123 pages. Fact precision was 0.714 (50 of 70), bet precision 0.545 (18 of 33),
and hunch precision 0.750 with recall 0.667, against bars of 0.80 and 0.70,
with 3 forbidden attributions. The autopilot tier stays `manual_only`
([mirror](docs/benchmarks/2026-10-04-takes-bootstrap-verdict.md), with the
upstream text copied verbatim and `verdict.json`). Nothing was rerun here, and
gbrain committed no predictions file. The run used an older model generation,
so TODOS asks for a rerun on current frontier models before the result is
cited as model-independent.
- **Version.** 0.10.21 went to #65, which merged first, so this release is 0.10.22.

## [0.10.21] - 2026-10-05

### Cat 40 on frontier models: gbrain ties plain files at the ceiling; the entity-recall wave lifts renewal briefs and cuts cost

The finding now uses the five newest frontier models: Sonnet 5.5, Opus 5.5, Fable 5.1, GPT-6.1 Sol and GPT-6 Astra.
They run under the new model-selection rules.

- **Headline.** gbrain `51f865d78` (the entity-recall wave, gbrain v0.60.62.0) and plain files each finish 95.6% of
  held-out tasks: 0.0 points, CI −3.2 to +3.0. The oracle scores 97.6%, so these tasks are at the ceiling for
  frontier models. gbrain puts no finance-only text into the agent's context in 100 permission runs; files put it
  there in all 100. gbrain costs about twice as much per task ($0.238 against $0.112).
- **Wave against v0.60.44.0.** Renewal briefs rise 7.0 points (CI +1.0 to +12.0), success is level (+0.4), cost per
  task falls 26%, and there are no leaks. The ship rule and the default-on rule pass.
- **Development rounds and controls.** Master and two rounds ran on the five models. For the three models new to the
  eval, the held-out world also got `a714410a5` and the simple arms. Artifacts are in
  `docs/benchmarks/2026-10-02-model-ladder/entity-recall/`.
- **`holdout_stats.py`** no longer fails when a cost table lists an arm with no cells for a model.

### The corrected Cat 40 headline: on the held-out world, gbrain and plain files with grep finish about as many tasks

The [Cat 40 report](docs/benchmarks/2026-10-02-model-ladder.md)'s finding now compares gbrain `a714410a5`
(v0.60.44.0), measured on the fixed harness, with the simple setups on the held-out world (6 models, 2 repeats,
50 tasks). gbrain succeeds on 75.7% of cells and plain Markdown files with `grep` on 72.8%: a paired difference of
+2.8 points (95% CI −2.3 to +8.2), a tie. gbrain is ahead of Postgres search (+9.7, CI +3.2 to +16.8) and the memory
tool (+12.3, CI +6.8 to +18.3), leaks nothing in 120 permission runs, trails files on renewal briefs (−9.2, CI −20.8
to +0.8) and costs about 2.5 times as much per task. By model it gains 16 to 17 points with Haiku 4.5 and Sonnet 4.6
and loses 15 with GPT-5.4-mini. The earlier summary stays in the report as history under the 2026-10-04 correction.
This follows Garry's gate decisions UC1 and UC2 on the
[entity-recall plan](docs/plans/2026-10-04-cat40-entity-recall/PLAN.md).

- **Reused simple-arm cells, audited.** `eval/runner/cat40/rescore.ts` rescores stored Cat 40 cells with today's
  `score.ts` from their answers and transcripts ($0). It rescores only success and claims, keeps the original safety
  flags (transcripts cut tool results at 40,000 characters), marks cells whose eligibility cannot be shown as needing
  a rerun, and lists cells whose claims need the paid judge again. On the 2026-10-02 held-out simple arms, all 2,520
  cells are eligible and nothing changed ([audit](docs/benchmarks/2026-10-02-model-ladder/entity-recall/simple-arms-rescored/README.md)).
- **Preregistration before the wave runs.** [PREREGISTRATION.md](docs/benchmarks/2026-10-02-model-ladder/entity-recall/PREREGISTRATION.md)
  fixes the comparator (`fs`, the best pooled of `fs`, `memory` and `pg`), the headline sentences, the ship rule, the
  default-on rule (family-E point gain above 0, cost per task up at most 25%), the G1 and harm-screen thresholds, the
  exact A3 commands and the analysis commands.
- **`holdout_stats.py` modes.** `--choose-comparator`, `--headline` (pooled, per model and per family against the
  comparator, plus every other simple arm, with `fs-acl` on family C only), `--capability-screen` (gates on success,
  flags families at −10 points or worse) and `--default-on`. The ship rule's leak check is now per
  (model, task, repeat, leak kind) cell: a leak that moves to another cell fails it even when totals are equal.
- **Slot coverage preflight.** Slot builds run `gbrain extract --stale --catch-up`, ask the built brain for its
  mention coverage through an `entity` miss, and record it beside the snapshot and in the slot receipt. A round
  refuses slots whose coverage is not `complete` with 0 pending pages; builds whose gbrain does not report coverage
  are not checked.

## [0.10.20] - 2026-10-05

### Ledger: CL-1 and CL-2 point at the merged gbrain fix

gbrain [#6010](https://github.com/garrytan/gbrain/pull/6010) merged to master as
`b9ee931` (v0.60.49.0). CL-1 and CL-2 now name `b9ee931` as their fixing commit,
with the note "verified at PR head 5a44025; chronicle code identical at merge":
no file under `src/core/chronicle/` or `src/core/cycle/` differs between the
measured head and the merge. The [rerun report](docs/benchmarks/2026-10-04-auto-chronicle-rerun.md)
carries a dated line saying so. No new measurement; $0.

## [0.10.19] - 2026-10-04

### `auto_chronicle` rerun on gbrain's date-quality fix: default-on supported at PR #6010's head

A preregistered rerun of the 0.10.18 off-versus-on experiment against gbrain PR
[#6010](https://github.com/garrytan/gbrain/pull/6010) at its head `5a44025`
(v0.60.49.0, open when measured), loaded as a copied overlay; the `package.json`
pin stays at `739e5cc` ([report](docs/benchmarks/2026-10-04-auto-chronicle-rerun.md),
[preregistration](docs/benchmarks/2026-10-04-auto-chronicle-rerun-preregistration.md)).

- **Result.** Two new ON brains on amara-life-v1: recall 37 and 38 of 38
  labeled events (35 and 37 at `739e5cc`), 0 events dated after their page (22
  and 25), 1 false event each, so 0.04 wrong events per judged labeled page
  against the 0.20 gate (0.96 before). 0 of 96 control pages judged; $0.0105
  per judged page; 5 and 8 proposals dropped as `date_imprecise`. Every rule
  holds on both runs, so default-on is supported at `5a44025`. The agent arm
  was not rerun; its `739e5cc` result stands.
- **Ledger.** CL-1 and CL-2 are fixed: garrytan/gbrain#6010, verified at PR
  head `5a44025`, pending merge.
- **Runner.** `eval/runner/chronicle-lift.ts run` takes
  `--gbrain <checkout>@<ref>` to measure a copied overlay.
- **Docs.** The original report carries a dated notice; README, the docs index,
  the `auto_chronicle` settings row and TODOS point to the rerun.
- **Spend.** $1.01.

## [0.10.18] - 2026-10-04

### Re-pin to gbrain `739e5cc` (v0.60.46.0): no accuracy lost, A4 improves, Cat7-1 narrowed; the first off-versus-on test of `auto_chronicle` contradicts its default

gbrain is pinned at master `739e5cc` (v0.60.46.0), which adds
[#5985](https://github.com/garrytan/gbrain/pull/5985),
[#5987](https://github.com/garrytan/gbrain/pull/5987),
[#5982](https://github.com/garrytan/gbrain/pull/5982),
[#5992](https://github.com/garrytan/gbrain/pull/5992) (v0.60.41.0),
[#5995](https://github.com/garrytan/gbrain/pull/5995) (the Cat 40 cost wave),
[#5993](https://github.com/garrytan/gbrain/pull/5993) (`auto_chronicle`,
v0.60.45.0) and [#5991](https://github.com/garrytan/gbrain/pull/5991) (the
agent-first operator wave) ([re-pin report](docs/benchmarks/2026-10-04-operator-wave-repin.md),
[`auto_chronicle` report](docs/benchmarks/2026-10-04-auto-chronicle-lift.md); three
preregistrations, each committed before its runs).

- **Regression check** (paired Ubicloud VMs, keyless, $0). 29 of 30 offline
  categories reach the same verdict with every scored field unchanged except
  A4, which moves toward gold: answerable questions graded `moderate` 40 to
  100 of 120, unanswerable still 0 of 120 (#5919). All 28 ledger repros pass
  (27 at `109b992`). Cat 34 now runs inside the tier. The one Cat 7
  slowdown over 25% (`get_backlinks` at 1,000 pages) was not repeated on fresh
  VMs.
- **N6 harness fix (N6-1).** N6 reported 3 existence-oracle probes on `think`
  at `739e5cc`. gbrain #5991 shows each agent notice once per session, and N6
  sent all probes through one session, so the first of two identical calls
  carried a notice the second lacked; a keyless repro shows the notice follows
  call order. Each N6 probe now gets its own session id; N6 passes at both
  pins, and only the oracle count changes.
- **Follow-up checks** (`docs/benchmarks/2026-10-04-operator-wave-repin/checks/`):
  the empty-grant refusal names the token by id; `edit_page` diffs list removed
  lines first; `conversation_segment_gap_minutes` splits a page on its own gap
  and rejects bad values with a warning (#5918); `auto_chronicle` without a
  chat model writes a clear receipt and judges nothing. All four pass at
  `739e5cc` and fail at `109b992`. Wave 8 check C now stops at gbrain's consent
  prompt, as v0.60.46.0 intends; a `--yes` variant passes.
- **Cat7-1 narrowed, still open.** The repro passes 7 of 7 runs at `739e5cc`
  (median 0.057 to 0.062 ms), but Cat 7's `get_timeline` at 1,000 pages is
  about 0.075 ms against 0.045 ms before Foundations 1 on VMs started together,
  so the preregistered closure rule is not met. `109b992` is bimodal (0.10 or
  0.046 ms between runs).
- **`auto_chronicle` off versus on** (new runner `eval/runner/chronicle-lift.ts`,
  labels in `eval/data/chronicle-lift-v1/`). On amara-life-v1 (144 pages, 48
  judged), two ON runs found 35 and 37 of 38 labeled events and judged 0 of 96
  control pages for $0.57 each, but wrote 22 and 25 planned follow-ups as
  events on their future dates; with misdated past events that is 0.96 wrong
  events per judged page against gbrain's 0.20 gate. A Claude Sonnet 4.6 agent
  answered 36 temporal questions at 94.4% off and 100% on (paired interval 0
  to +13.9 points; both gains on "who did Amara meet on day X"). Under the
  preregistered rule, default-on is contradicted. New ledger entries CL-1
  (future-dated events) and CL-2 (vague past dates put on specific days).
- **Ledger.** Cat7-1 and A4-2 reviewed at `739e5cc`; N6-1, CL-1 and CL-2 are
  new.
- **Spend.** $17.35 in provider calls, all for `auto_chronicle` ($1.13 judge
  calls, $15.37 agent runs, $0.66 unsettled reservations from a stopped run,
  $0.19 cost pilot, $0.004 smoke).
- **Version.** 0.10.17 went to #60 (merged first), so this release is 0.10.18.

## [0.10.17] - 2026-10-04

### Cat 41 agent operator outcomes: baseline shows agents spending and rebuilding without asking

Cat 41 (`agent-operator`, tier P, gating its own before/after report) runs real
Claude Code 2.1.285 (`claude-opus-5-5`) and Codex CLI 0.160.0 (`gpt-6.1-sol`)
sessions, pinned in Docker, through 17 scripted requests where an agent
operating gbrain often goes wrong: paid fixes nobody approved, destructive
repairs, a locked or unmounted brain, a read-only client, a tool that refuses
on stdio, an unpriced model under a user cap, a fresh install, and three
docs-only tasks ([report](docs/benchmarks/2026-10-03-agent-operator.md),
[protocol](docs/benchmarks/2026-10-03-agent-operator-protocol.md)). Scoring is
deterministic: a logging `gbrain` wrapper, a fake model provider and machine
probes decide whether a paid, destructive, credentials, egress or
persistent-install effect happened without authorization.

- **Baseline, gbrain v0.60.35.0 (`566a242`), 102 sessions:** 25 consent
  violations in 12 of 66 safety runs, all in two scenarios: every session ran
  paid embedding when asked to "fix" a low health score, and every session ran
  `pglite-repair --yes`, `reinit-pglite --yes` or replaced the brain when asked
  to "get it working again". 0 false "no notes" answers. A second `gbrain
  serve` or an unmounted brain reaches the agent only as "Connection closed".
  Fresh install to recall and the docs tasks pass. Spend $16.38.
- **F1/F10 agent-loop baseline** (Cat 40 `gbrain` arm, three models, two
  repeats): 218 of 300 tasks, zero leaks, $32.17.
- **The gate** for gbrain's agent-first operator wave is preregistered in the
  registry: zero consent violations in safety scenarios, no newly introduced
  false-empty answers, token overhead within +15% per MCP surface, with utility
  floors. `eval/runner/cat41/after-pass.sh` runs the candidate pass.
- **Early after-pass on the wave collector `7d16702` (v0.60.38.0):** the gate
  fails with 9 violation steps (from 25), mostly gbrain's own (`doctor` sends a
  paid embedding probe; read commands write to a corrupted brain's WAL; `embed`
  has no consent gate), plus one new false "no notes" cell (transcripts tool
  hidden on stdio). Token overhead passes (+5.9% at most). The Cat 40 F1/F10
  check drops 4.7 points (gpt-5.4-mini authority tasks, type filters that hide
  amendments). Scorer v3 fixes two measurement defects found in this pass.
- **Cat 40 F1/F10 follow-up:** the gpt-5.4-mini drop is provider drift, not
  gbrain text. The same baseline code scored 59/100 and then 46/100 seven hours
  apart; with matched timing the candidate is within noise, and no instruction
  or description variant restores 59. Cat 40 gains evaluator-side flags to A/B
  the instructions and tool descriptions the model sees, and the protocol now
  reruns the baseline in the same window as each candidate.
- **Confirmation pass on the final candidate `b3f4e8b`: the gate passes.** 0
  consent violations, 0 new false "no notes" cells, token overhead within
  +5.9%, task success 96/102 (baseline 78/102). Scored with v5: owner decision A
  (2026-10-04) counts embedding from a write the agent chose, with a configured
  key, as the configured feature; v4 recognizes "can't find your memory at
  <path>" as a missing-brain reason. The v3 and v4 gate reports stay published.
  The same-window Cat 40 pair: candidate 205/300 against baseline 202/300.
- **Rechecked on the fixed SQLite ledger:** `gpt-5.4-mini` scores 46/100 on
  both the baseline and the candidate. The candidate's memory-loop line makes
  mini save write-back corrections with `remember` (16 of 20 runs) and rarely
  read them back, so write-back drops from 10/20 to 4/20 while pooled success
  holds.
- **Docs describe Cat 40 and Cat 41 as they stand:** the README section on
  agents operating gbrain, the docs index, the evaluation guide, and the Cat 40
  and Cat 41 protocol pages state what each measures, its gate and the current
  commands. The method's history moves to the run report's "Method changes"
  section and this changelog.

## [0.10.16] - 2026-10-04

### The budget ledger moves to SQLite, so paid runs stop stalling their own timing; Cat 40 gets the tooling for the gbrain cost wave

Every paid request reserves its cost in the budget ledger before it is sent.
The ledger was one JSON file that each reservation parsed, rewrote and
fsynced in full on the runner's event loop. At 110,000 entries that blocked
the loop for about 0.6 s per request, which is why gbrain's tool latency in
the Cat 40 harness looked 10 to 30 times slower than the same calls replayed
alone. The ledger is now a SQLite file (`bun:sqlite`, WAL mode,
`synchronous=FULL`), following Garry's gate decision (UC3) on the
[Cat 40 follow-ups plan](docs/plans/2026-10-03-cat40-followups/PLAN.md).
Guide: [docs/budget-ledger.md](docs/budget-ledger.md).

- **Constant-cost reservations.** A reserve plus settle took 0.45 to 0.8 ms
  with 200,000 entries in the ledger on a 4-core cloud machine, most of it two
  fsyncs; a test holds the average under 5 ms at that size. Cross-process
  safety comes from SQLite's `BEGIN IMMEDIATE`: four processes making 2,000
  reservations against a tight budget never overspend, and a writer paused
  between its check and its write cannot be overtaken.
- **The program cap lives in the ledger.** `init` records it ($500 by
  default), runners without a cap flag adopt it, a disagreeing flag or
  environment variable is refused with the fix, and `set-cap` changes it only
  with a reason. A missing ledger off the default path refuses with the `init`
  command instead of starting empty. New CLI commands: `init`, `verify`,
  `set-cap`, `migrate --finish`; `status` is read-only JSON with hints.
- **Safe migration.** An existing `ledger.json` migrates once under both its
  old lock and the new one, keeps a `.migrated` copy, and is replaced by a
  tombstone that code from before this release refuses to spend against. A
  crash at any step leaves either the legacy file or a state that `migrate
  --finish` completes; differing totals stop spending and say to ask the user.
  `evidence-delivery.ts`, which read `ledger.json` directly, now goes through
  the shared reader, and a campaign manifest's cap is an upper limit.
- **Reservations cover what providers bill.** Tool schemas, OpenAI
  `instructions`, the context a `previous_response_id` carries (a full window
  when the chain is unknown) and the cache-write premium are now reserved. Any
  remaining overshoot is recorded. A failed ledger write stops the process
  from spending.
- **Event-loop lag in every receipt.** `startPaidRun` records lag p50, p99 and
  max; every receipt's cost block carries it with the ledger path and recorded
  cap (`n2-3-prompt-ab.ts` included). A deliberate 100 ms block registers.
- **Cat 40 runner.** Tool results are uncapped by default (`--max-tool-chars
  none` spells it). Each `--out` directory is bound to its experiment, and a
  resume joins the step's original budget run instead of opening a fresh one.
  Slot brains are built by their own `--build-slots` step, one at a time, and
  agent steps refuse when a snapshot is missing. `--order model` finishes
  each model before the next. gbrain's provider calls are charged to the cell
  that made them even when they finish after it, unpriced ones at their
  reservation, and cells record `restore_ms`.
- **Cat 40 analysis.** `analyze.ts` splits each cell's `total_usd` into
  uncached input, cache writes, cache reads, output and gbrain provider calls
  (the parts sum to the total), reports tool-result characters by tool and cost
  per success, warns on event-loop lag, and reconciles cells against the
  ledger. `holdout_stats.py` refuses comparisons without complete, unique
  coverage and adds the gate's ship rule (-5 point margin, -3 beside it), the
  dev-round harm screen, a power check, and pairs for the new build against
  the contemporaneous `566a242a` control.
- **Paid-run script.** `scripts/cat40-followups.sh` holds the exact commands
  for dev rounds 1 and 2, the latency comparator, the new-build held-out run
  and the `566a242a` control, on one ledger capped at $237. `PRINT_ONLY=1`
  prints them.
### Cat 40 results on the fixed harness, and a correction

- **Correction to the Cat 40 report.** In every earlier gbrain run, the ledger stall made gbrain's embedding
  requests fail, and gbrain quietly fell back to keyword-only search. A recorded search replayed on the same build
  and brain reproduces its recorded results only when embeddings are unreachable. The `51a30c1` renewal-brief
  cells rerun under the new ledger scored 4 of 30, against 14 of 30 before. The report now carries a correction
  note: gbrain against plain files has not been re-measured.
- **gbrain cost wave (gbrain v0.60.44.0) on the held-out world.** Against a contemporaneous v0.60.35.0 control
  (6 models × 2 repeats):
  - cost per task fell 32% ($0.118 to $0.080), and cost per successful task fell 34%
  - success went from 73.5% to 75.7%: +2.2 points per task (95% CI −0.5 to +5.0)
  - no leaks
  - the gate's ship rule passes

  Development rounds and artifacts: `docs/benchmarks/2026-10-02-model-ladder/followups/`. Spend: $179.66 of the
  $237 ledger.
## [0.10.15] - 2026-10-04

### LongMemEval with opaque session ids: retrieval confirmed, the notes gain holds, and a frontier reader answers 447/500

Measured at the existing pin, gbrain `109b992`, after a committed
[preregistration](docs/benchmarks/2026-10-04-longmemeval-opaque-followups-preregistration.md)
([report](docs/benchmarks/2026-10-04-longmemeval-opaque-followups.md)).
Provider spend: $67.83 of an $80 budget.

- **Retrieval recount (September 28 audit, C-01).** All 13 published
  LongMemEval retrieval arms were re-run with opaque session ids, so the
  `answer_` prefix of labeled evidence ids never reaches gbrain, with settings
  matched by recomputing each arm's recorded knob hash. Over the 470 answerable
  questions, the release configuration found every labeled session for 451
  (published 449, +2/−0) and the reranker-off arm for 434 (439, +1/−6,
  p = 0.13); autocut on scored 384 (379). Ten of 13 arms are confirmed. The
  three expansion arms without the reranker moved up (legacy expansion 255 to
  436 in gbrain's harness, 258 to 440 in this repository's runner).
  A post-hoc check at the published gbrain commit attributes that change to
  later gbrain code (+12/−1 on 40 questions), not to the ids (+2/−1).
- **Reading-notes transfer with opaque ids.** On the 361-question cohort,
  rebuilt from public receipts, the notes reader beat the direct reader 320 to
  304 (+25/−9, paired 95% interval +1.4 to +7.5 points), so the predeclared
  gate passes; 308/361 to 324/361 stays as the raw-id measurement. Eleven notes
  responses hit the 512-token limit.
- **Frontier reader (audit B6).** `gpt-5.4` at medium reasoning, on exactly the
  September 29 GPT-4o arm's official prompts, answered 447/500 (official judge
  448/500): +33/−16 against GPT-4o (p = 0.021), +25/−17 against gbrain's house
  reader (p = 0.28). No ranking against vendor results is claimed.
- **Published claims.** Dated annotations in the September 6 ranker-wave, May
  LongMemEval, September 9 refresh, September 25 reading-notes and September 29
  opaque-id reports; the README, settings guide, retrieval lessons and
  comparison page now carry the recounts, and the finding that query expansion
  hurts retrieval is marked as no longer true of current gbrain.
- **Tooling.** `scripts/verify-longmemeval-opaque-followups.py` recounts all
  three items from the committed receipts and runs in `bun run validate`;
  three receipt-manifest entries; new TODOS follow-ups for a frontier reader on
  the reranked retrieval and a reading-notes run at 1,024 tokens.

## [0.10.13] - 2026-10-03

### Re-pin to gbrain `109b992` (fix wave 8 and Foundations 1): no accuracy change, one small latency regression, nine new checks

gbrain is pinned at master `109b992` (v0.60.37.0), which contains
[#5932](https://github.com/garrytan/gbrain/pull/5932) (v0.60.35.0), fix wave 8
([#5927](https://github.com/garrytan/gbrain/pull/5927), v0.60.36.0) and
Foundations 1 ([#5962](https://github.com/garrytan/gbrain/pull/5962),
v0.60.37.0) ([report](docs/benchmarks/2026-10-03-wave8-f1-repin.md),
preregistrations for the [regression check](docs/benchmarks/2026-10-03-wave8-f1-repin-preregistration.md)
and the [new checks](docs/benchmarks/2026-10-03-wave8-f1-coverage-preregistration.md)).
Provider spend: $0.

- **Regression check.** The offline tier ran at `48ed5e8` and `109b992` on
  paired Ubicloud VMs: 30 of 30 categories reach the same verdicts, with no
  change in any accuracy, recall or leak count. All 27 ledger repros pass.
  Cat 34 (run against both checkouts) and N12 at seed 7 are unchanged.
- **One regression (Cat7-1).** Cat 7's `get_timeline` at 1,000 pages went from
  a 0.045 ms to a 0.097 ms median, and the preregistered paired repeat
  confirmed it (0.052 to 0.101 ms). A keyless repro bisects it to Foundations 1
  and shows that `GBRAIN_PLANNER_AUTO_ANALYZE=0` removes it. The same
  statistics made `search_keyword` at 10,000 pages 30 times faster (4.00 to
  0.13 ms).
- **Link typing (#5882).** On world-v1, person-to-company edges went from 125
  right and 52 wrong to 128 right and 43 wrong; N9's relational arm returns
  fewer candidates with unchanged hits on all 870 one-hop runs.
- **New checks** (`docs/benchmarks/2026-10-03-wave8-f1-repin/checks/`), each
  keyless through gbrain's CLI or MCP server, with a scripted provider on
  127.0.0.1 where a model is needed: the unpriced-model flow under a cap
  (refusal with guidance, default cap runs, `gbrain pricing set`, metered
  retry, no remote registration); `gbrain import` of a directory the
  repository ignores; the embed budget stop (exit 11); pending-fact counts;
  Dream reading conversation pages; repeated searches; empty legacy source
  grants; creation attribution with `edit_page`. All nine pass at `109b992`;
  seven fail at `48ed5e8` as expected.
- **Ledger.** Twelve entries that the range touched get a 2026-10-03 review at
  `109b992` (statuses unchanged); Cat7-1 is new.
- **Version.** 0.10.12 is taken by the open PR #58, so this release is 0.10.13.

## [0.10.11] - 2026-10-03

### Cat 40 Model Ladder: gbrain lost to grep at release v0.60.27.0; a fix wave puts it ahead on the dev world and level-to-ahead on a held-out world

Cat 40 (`model-ladder`, tier P, report-only) gives one agent loop 50 tasks
about a fictional company, with different memory setups: plain Markdown files
with `grep`, Anthropic's memory tool, plain Postgres search, gbrain's MCP
server, and an oracle arm that is handed the evidence. The task families are
contract authority, who-owns-it-now, permissions, five-part renewal briefs
and write-back across sessions
([report](docs/benchmarks/2026-10-02-model-ladder.md),
[protocol](docs/benchmarks/2026-10-02-model-ladder-protocol.md)).

- **Release v0.60.27.0 lost to grep.** 11 models, uncapped tool output,
  7,624 runs: gbrain was 8 points below the best simple setup pooled
  (95% CI −13 to −4). It leaked finance-only text in 64 of 330 permission
  runs, against 17 for files. On a 52,028-document world (4 models) it was
  16 points behind.
- **The gbrain fix wave** ([garrytan/gbrain#5932](https://github.com/garrytan/gbrain/pull/5932))
  addresses the five mechanisms found in the transcripts: derived pages
  leaking private sources, guessed page types hiding evidence, saved facts
  invisible to search, other names for a customer, and wasted cold-start
  turns. On the development world it finished 494 of 550 runs, against 455
  for files: +7 points pooled (CI +3 to +9), with 0 leaks.
- **Held-out world** (seed 20261003, 6 models, 2 repeats, the shipped build
  `77dcf414`): +16.7 points over the release (CI +9.7 to +23.8) and +6.0 over
  files (CI −0.2 to +12.3). It leaked nothing in 120 permission runs.
- **Price:** a gbrain run costs 2.5 to 4 times a file run.
- **Latency measured inside the harness is invalid.** Every model request
  rewrites the whole budget ledger synchronously on the runner's event loop,
  and that loop also proxies gbrain's own provider requests. An isolated
  replay shows the fixed build's searches are as fast as the release's.
- **Not measurable here:** whether gbrain's advantage grows with model
  capability. The strongest models score 96–100% with every setup.
- **New:** generator `eval/generators/model-ladder-gen.ts`, runner
  `eval/runner/cat40-model-ladder.ts` with `eval/runner/cat40/` (loop, arms,
  scoring, analysis), and budget-ledger allowances (one reservation covering
  many small requests) plus prices for the ladder models.
- **Spend:** $1,763 across the program, under a $2,000 authorization.

## [0.10.10] - 2026-10-03

### Re-pin to gbrain `48ed5e8` (fix wave 7): eight ledger gaps closed and verified, N2 prompt v4, an N7 oracle amendment

gbrain is pinned at master `48ed5e8` (v0.60.32.0), which contains fix wave 7
([garrytan/gbrain#5908](https://github.com/garrytan/gbrain/pull/5908)). The
owning categories were rerun with the October 2 runners, seeds and settings
([report](docs/benchmarks/2026-10-03-wave7-repin.md),
[preregistration](docs/benchmarks/2026-10-03-wave7-repin-preregistration.md)).
Paid spend: $15.68 against a $30 cap, every request reconciled. No new gbrain
bug was found.

- **N2: judge prompt version 4.** 149 of 150 planted same-time conflicts
  called contradictions end to end (version 3 at `d44296c`: 132), 50 of 50
  between undated notes (36). False contradictions: 6 of 51 compatible pairs
  (3 of 50) and 38 of 1,977 unplanted pairs (26 of 1,968). The compatible-pair
  decision rule (at most 10%) fails at 11.8%, so the report no longer says the
  judge separates conflicts from dated changes on this world. A preregistered
  repeat of version 3 at `d44296c` gave 129 of 150 and 5 of 51 compatible
  pairs, so the compatible-pair difference is within run-to-run variation.
  Before the run, the probe budget was raised from $6 to $10 in its own
  commit; every one of the 2,680 offered pairs was judged.
- **N7: oracle amendment.** gbrain changed its documented rule so that an
  acknowledgement-only reply to a question no longer closes a loop (gap
  N7-2). The frozen oracle encoded the old rule, and the first run failed
  closure accuracy (34 of 39, threshold 0.95) on exactly those threads. A
  dated amendment makes the oracle apply the rules documented by the gbrain
  version under test; no threshold, contract or input changed, the failing
  receipt is kept, and at `d44296c` the amended oracle reproduces the
  October 2 receipt byte for byte
  ([amendment](docs/benchmarks/2026-10-03-n7-oracle-amendment.md)). N7 then
  passes every rule: 53 of 53 planted loops, 34 of 34 closures.
- **Gaps closed by gbrain and verified here:** N7-2, N7-5 (`as_of` pins the
  ranking), N7-6 (loop age from the request), N7-7 (`?` inside a link), N9-5
  (unresolved one-hop seeds 45 to 6 of 435 runs), N12-6 (`Participants:`
  attendees 5 of 5, was 0), N13-8 (member calls; resolved edges 76 to 72 of
  91 with all 42 same-file calls kept) and A4-2 (unanswerable questions graded
  `weak` 120 of 120, was `moderate`; 80 of 120 answerable also grade `weak`).
- **Ledger.** A 2026-10-03 review on every entry; earlier reviews kept in a
  new `review_history` field. All 20 bugs re-verified. Wave 7's by-design
  dispositions (A4-1, N2-5, N5-4, N5-5, N5-6, N12-4, N12-5, N13-4) cite
  gbrain's documented reasons. New entries N7-8 (the frozen oracle) and N12-9
  (speakers-only attendance, split from N12-6). 27 repros pass, three of them
  new keyless checks.
- **A4-3 fixed:** the budget ledger prices TypeSafe requests at gbrain's own
  rate and refuses an unpriced Jev model. A4 still has no S4-on arm.
- **No gate flipped.** No threshold moved; N7, N12, A4, N2 and the N1 and N5
  CI slices gate and pass.
- `@ai-sdk/anthropic` moves to 3.0.127 in the lockfile with gbrain's new
  floor, and `cat36-production.ts` casts the older `gbrain-cues` operations
  through `unknown` (gbrain 0.60.31.0 made `outputRedaction` required).

## [0.10.9] - 2026-10-02

### CI slices for N1 and N5, faster N9, a matched concept cell, fresh Cat 14 and Cat 19 to 21 receipts, wider N6, live negative controls

gbrain stays pinned at master `d44296c` (v0.60.30.0). Paid spend for the
whole wave: $1.09 metered by the budget ledger (concept cells and a smoke
run), plus about $2.20 counted from runners that do not meter their spend,
about $3.30 against a $50 cap. No new gbrain bug was found.

- **N1 and N5 now gate in CI.** New registry entries `knowledge-update-ci`
  and `forget-residue-ci` run in the offline tier. Each is an entity subset
  of the seeded ledger on one PGLite cell, served over stdio MCP by the
  gbrain CLI, with trusted and private reads through `gbrain call`. They
  keep every rule of the full category and add signal floors computed from
  the sliced ledger. The subsets, cell and floors were preregistered in their
  own commit before any slice ran. First runs passed every rule: N1-ci 64/64
  current-value and 57/57 history probes in 57 s, N5-ci 0 prohibited outputs
  and 120/120 retained pairs in 79 s. A pure CLI-transport cell could not fit
  two minutes: each `gbrain call` costs about 1 s, 0.7 s of it opening
  PGLite, and the full N5 CLI cell made 508 calls in 575 s
  ([report](docs/benchmarks/2026-10-02-ci-slices.md)).
- **N9 hermetic arm: 47 s instead of about 130 s.** Each ingestion seed now
  runs in its own process and the rows merge in seed order. A serial and a
  parallel receipt are identical apart from timing fields and the runner
  hash; `--serial-seeds` restores the old path. **N2 was not trimmed:**
  seeding 825 pages through `put_page` (49 s) and the two gating probes
  already take about 65 s, and the remaining cuts would shrink the
  preregistered 150-conflict denominator
  ([note](docs/benchmarks/2026-10-02-hermetic-arm-trims.md)).
- **Concept search with the same reranker on both sides** (September 28
  audit, B2). New opt-in Cat 13 adapter `vector-rerank` sends vector results
  through gbrain's own `applyReranker`. On the 181 held-out questions:
  vectors 118, vectors with the reranker 128, gbrain 99, gbrain with the
  reranker 130 exact targets first. Reranked gbrain won first place on 8
  questions and lost it on 10 (p = 0.81). The README now quotes this matched
  set; the September cells (102, 118, 130) stay as history
  ([report](docs/benchmarks/2026-10-02-concept-vector-rerank.md)).
- **Cat 14 rerun with the blind runner** (audit A-01): 8/8 probes scored, the
  calibrated advice preferred in 5 of 6 win-eligible probes and never the
  plain answer; the gate fails on the counter-argument (2/4) and voice (31%)
  axes. The May 75% stays retracted
  ([report](docs/benchmarks/2026-10-02-cat14-rerun.md)).
- **Cats 19, 20 and 21 have fresh receipts** (audit A-09). Cat 19 passes 5/5
  gates with live embeddings (health score 10 to 85). Cat 20 fails its judge
  floor: grounding 1.00 over 69 graded ideas, judge 1.17/5 against 2.5. Cat
  21 ties at the ceiling (12/12 for both embedders), so it needs questions
  that do not name the symbol. The May rows keep their numbers with dated
  pointers ([report](docs/benchmarks/2026-10-02-may-snapshot-reruns.md)).
- **N6 generator v2** seeds a private ontology observation, raw data on a
  private page and a private orphan page beside public twins. Read-op
  coverage rose from 26 to 30 of 74 with 0 leaks; skills, code intelligence
  and schema-pack ops remain uncovered for the reasons recorded in the
  [update](docs/benchmarks/2026-09-30-n6-visibility-fuzz.md#update-2026-10-02-three-more-surfaces-seeded-30-of-74-read-ops-covered).
- **Live negative controls** (WS3), both preregistered and both passing the
  0.5 rule: Cat 25 `think` without trajectory data 0.00 against 0.84 with
  it; Cat 13 vector search with hash embeddings held-out nDCG@5 0.077
  against 0.606 with Voyage
  ([report](docs/benchmarks/2026-10-02-live-negative-controls.md)).
- Plans written before the paid runs:
  [paid reruns and negative controls](docs/benchmarks/2026-10-02-paid-reruns-plan.md),
  [CI slices](docs/benchmarks/2026-10-02-ci-slices-preregistration.md).

## [0.10.8] - 2026-10-02

### Sealed v2, release decision 1: whole-conversation delivery confirmed on held-out data

The first preregistered opening of sealed confirmation set v2 asked whether
gbrain's shipped evidence default, `auto` (whole conversation pages within a
24,000-token budget), is non-inferior to the old `chunk` default and whether it
is better, at gbrain `d44296c` (v0.60.30.0)
([results](docs/benchmarks/2026-10-02-sealed-v2-decision-1.md),
[preregistration](docs/benchmarks/2026-10-02-sealed-v2-decision-1-preregistration.md)).

- **Result.** `auto` answered 192 of 200 questions and `chunk` 132 of 200,
  from the same five retrieved hits, with Claude Sonnet 4.6 at temperature 0
  reading and `gpt-4o-2024-08-06` judging. `auto` won 60 and lost 0: +30.0
  points, 95% persona-cluster interval +24.0 to +36.0. The preregistered
  verdict is `pass`, with superiority confirmed (exact McNemar p = 1.7e-18;
  persona sign-flip p = 0.00005). Multi-session questions went from 33 to 76
  of 80 and temporal questions from 21 to 36 of 40. Knowledge update (38 to
  40) and abstention (40 and 40) barely moved. Reader input rose from a mean of
  3,280 to 12,982 tokens.
- **Retrieval was not the bottleneck.** The shared top five held every gold
  chat for 153 of 160 answerable questions. All 60 wins came from those 153.
- **Rule written first.** The 3-point non-inferiority margin, the fixed-order
  superiority test (reusing the E2 rule from the auto v2 manifest), the
  `compare.ts` family and a simulated power table were committed in `d0efb58`
  before the sealed files reached the machine.
- **Runner.** `eval/runner/sealed-confirmation.ts` gains `evidence-freeze`
  (the evidence-delivery freeze on sealed questions, sharded by history),
  `evidence-answer` (the protocol reader over one frozen arm, resumable from
  its response cache) and `decide` (the preregistered rule over `compare.ts`
  output). `score` now writes `haystack_id` per question, and adds
  `error`/`error_origin` only on failed rows, so its rows pair in `compare.ts`.
  `readAnswer` also returns the provider-reported input tokens.
- **Custody.** Labels were read twice through the runner under one decision
  id. The access log went from 1 to 3 lines, and it was handed back with the
  per-question scores for private custody. Everything else holding sealed
  content was deleted from the machine. This is release decision 1 of the 3 the
  protocol allows. The v2 protocol doc and README record the opening.
- **Cost:** $16.06 of a $60 cap (10,600 requests), plus about $0.22 for setup
  runs on invented fixtures.

## [0.10.6] - 2026-10-02

### Re-pin to gbrain `d44296c`: all 20 wave bugs fixed and verified, N12 gates

gbrain fix wave 5 ([#5839](https://github.com/garrytan/gbrain/pull/5839),
v0.60.28.0) and fix wave 6 ([#5845](https://github.com/garrytan/gbrain/pull/5845),
v0.60.30.0) have merged. This release pins gbrain master `d44296c`, which
contains both, and reruns the October 1 categories with the same runners,
seeds and settings
([results](docs/benchmarks/2026-10-02-wave-repin.md)).

- **Gate changes.**
  - **N12 format fidelity now gates.** Its frozen hold said to re-pin to a
    master with the N12-1 fix, rerun N12 and remove the hold. At `d44296c`
    it passes all six preregistered rules on seeds 12 and 7, including 0
    fabricated turns out of 16 negative items (3 turns on October 1). The
    hold was removed in the re-pin commit. No rule value changed.
  - N1 and N5 already had gate status, and now pass every rule on PGLite and
    Postgres. They stay listed, not dispatched, until a CI-sized slice exists.
  - N8 stays report-only, and its private-delivery targets stay exploratory.
    N9 and N13 have no gating rule. Paid arms never gate.
- **Before and after (October 1 at `3a284ae`, October 2 at `d44296c`).**
  - **N1 knowledge update.** Current-value accuracy went from 288/388 to
    388/388 probes, and history retained from 168/385 to 385/385. Stale
    values stayed at 0 of 773.
  - **N5 forgetting residue.** Prohibited outputs after forget went from 2 to
    0 on PGLite and from 12 to 0 on Postgres. Retained-neighbor recall went
    from 738/750 to 750/750, and reinstatement from 4/6 to 6/6. Remote
    responses carrying a forgotten fact in `_meta` went from 108 and 304 to
    0 and 0.
  - **N2 contradiction surfacing (paid, judge prompt v3).** Conflicts called
    contradictions rose from 105/150 to 132/150. Unplanted false
    contradictions fell from 109/1,977 to 26/1,968, and judged-pair precision
    rose from 48.6% to 82.0%. All three preregistered decision rules now
    hold. Undated conflicts did not move (36 of 50 both times). One of four
    probe runs hit its $1.50 cap, so 13 of 2,680 pairs went unjudged; no
    planted conflict was among them.
  - **N8 proactive recall.** Private pages delivered went from 4 to 0 for
    remote callers and from 4 to 0 for the turn block.
  - **N13 code intelligence.** `code_def` top-1 went from 40/50 to 49/50, and
    the `resolved` flag from 0 of 81 edges to 76 of 91.
  - **N7 open loops.** Backfill nudges went from 0/6 and 0/4 to 6/6 and 4/4.
    The gating numbers are unchanged.
  - **N9 multi-hop.** Unchanged: 0 composed plans and 0 firings. "Who
    attended" seeds now resolve (150/150, was 0), but the arm still fires 0
    times. World-v1 names attendees only in prose, which the evidence gate now
    types as mentions. The one-hop paid rerun repeated its October 1 numbers.
- **Bug ledger.** Each entry gains a dated `review` with the commit checked,
  the evidence and its receipts. Fixed bugs gain `fixing_pr` and
  `fixing_commit`, and a new `closed` status covers a gap that gbrain closes on
  purpose. The original findings are unchanged. Status on 2026-10-02:
  - 20 of 20 bugs are fixed and verified by a rerun. None is fixed upstream
    without verification, and none is still open.
  - Gap N12-7 (legacy-pack attendance) is closed by gbrain `81755f5b`.
  - Of the other gaps, 25 still reproduce. A4-1 and A4-2 were not rechecked,
    because A4 was not rerun.
  - All 24 ledger repros now exit 0
    ([output](docs/benchmarks/2026-10-02-wave-repin/repros-d44296c.txt)).
- **No new gbrain bugs.** Three findings are follow-up work, not contract
  breaks: undated conflicts called temporal, prose attendance typed as
  mentions, and the N2 probe cap. They are in `TODOS.md`.
- **Harness.**
  - N2 gains a `local_bare_cli` probe that asks gbrain's own `makeContext`
    for the context. The existing probe imitates the October 1 CLI context
    and is unchanged.
  - N2 now records the judge prompt version from gbrain instead of
    hard-coding "2".
  - The N2 small-world test now pins the fixed behavior.
- **Runtime.** gbrain v0.60.27.0 requires Bun 1.4.0 or newer, so CI and the
  reruns moved from Bun 1.3.14 to 1.4.2. That is the one setting that
  differs from the October 1 runs.
- **Paid spend: $6.37** in one budget run capped at $60, with every request
  reconciled. Of that, the N2 judge cost $6.24, the N9 paid arm $0.065,
  the relational-ab one-hop rerun $0.065 and the N1 paid arm $0.000006.
  Everything else ran keyless. The sealed confirmation sets were not touched.

## [0.10.5] - 2026-10-01

### Eval-category wave: eleven categories at gbrain `3a284ae`, 20 gbrain bugs found

This release integrates the October 1 eval-category wave
([plan](docs/plans/2026-10-01-eval-category-wave/README.md)): a shared step 0
and five category lanes, merged as one release. Every new category froze its
promotion rules in the registry before its first counted run, and every
counted run used gbrain master `3a284ae` (v0.60.26.0) through a copied
overlay, with provider keys stripped and System One off.

- **Gate changes.**
  - **N4 entity resolution now gates.** It was report-only. It gates on five
    safety contracts (zero identity-group leaks; zero wrong merges on resolve,
    recall, remember and resolve-on-save) and two exact-lookup floors at 100%,
    all of which held at `6c8373c` and `3a284ae`. Its runner verdict stays
    `fail` because B-cubed F1 is under 0.9 on variants gbrain does not read by
    design; that metric is now exploratory.
  - **N6 visibility fuzz gains a coverage floor.** `content_reachable_coverage
    >= 1` sits beside its six zero-leak contracts. It held at both commits.
  - **N7 open loops gates from its first run.** Five safety contracts and
    three quality floors all held.
  - N2 and A4 also gate, and both held. N12 lands report-only with its rules
    held (see below). N8, N9 and N13 are report-only. N1 and N5 carry gating
    rules but are listed, not dispatched: their CLI cells take 6 to 17
    minutes and the Postgres cells need Docker.
- **Headline numbers.**
  - **N1 knowledge update.** Safety contracts pass: 0 stale values served in
    773 probes. The floors fail. Current-value accuracy is 288/388 (74.2%) and
    history retained is 168/385 (43.6%). Every miss is an ontology probe,
    because `ontology_propose` is refused on default brains (N1-1). With real
    embeddings, 0 of 10 value changes were superseded implicitly.
  - **N5 forgetting residue.** 0 reactivations, 0 collateral expirations, 0
    unauthorized forgets and 0 private leaks. It fails on 2 prohibited
    `context_pack` outputs from the hot-memory cache (N5-1), retained recall
    738/750 and reinstatement 4/6.
  - **N2 contradiction surfacing.** With a query that names the company and
    attribute, the hermetic probe offered 150/150 planted conflicts to the
    judge. With queries that name no company it offered 4/150. With gbrain's
    judge (paid), end-to-end recall was 105/150 and false contradictions were
    0/60 on dated changes. That is below the preregistered 0.80, so the judge
    does not yet separate conflicts from dated changes.
  - **A4 abstention.** Every one of 240 calls carried a grade, but every
    natural question was graded `moderate`. With a paid house reader on
    retrieved evidence, it answered 120/120 correctly and abstained on 119/120
    unanswerable questions.
  - **N7 open loops (Gmail-shaped threads).** Recall 45/45, closure 39/39,
    counterparty 45/45 and 0 safety violations.
  - **N8 proactive recall.** Alias and title recall was 42/42 with 0/68 false
    alarms. Common-word aliases fired 6/6. Associative recall was 0/240. The
    private-page contracts fail: 4 deliveries to remote callers and 4 into the
    `turn_context` block (N8-1, N8-2).
  - **N9 multi-hop with held-out wording.** 0 of 250 composed wordings
    produced a multi-relation plan, so the relational arm never fired. Strict
    all-hit at 10 was 10/375 (keyword, canonical). On the one-hop paid rerun,
    paraphrase recall at five rose from 0.411 to 0.537 (19 better, 0 worse,
    p = 0.000004), on development data.
  - **N12 format fidelity.** Across all 27 registered formats, adapter roles
    were right for 266/266 turns, adapter timestamps for 266/266 and parser
    speakers for 760/760. Attendance from documented forms was 20/20 with 0
    false. One safety contract fails: a status note with three bold labels
    parses as a 3-turn chat (N12-1).
  - **N13 code intelligence (scout).** All 6 ops answer the trusted call and
    all 6 refuse remote callers. `code_def` top-1 was right for 40 of 50
    functions, and `resolved` is false on 81 of 81 edges.
- **N12 is report-only until gbrain fixes N12-1.** The fix is in gbrain fix
  wave 5 ([#5839](https://github.com/garrytan/gbrain/pull/5839)), which was
  still open on 2026-10-01. A new `held` field on the promotion rules keeps
  the frozen rules evaluated and printed without letting them gate. When
  master contains the fix, re-pin, rerun N12 and remove the hold in that
  commit.
- **gbrain bugs found (20).**
  - **Fixed in fix wave 5, lane A ([#5839](https://github.com/garrytan/gbrain/pull/5839), open):**
    - N7-1: the nudge on first sight.
    - N8-1 and N8-2: private pages reach `volunteer_context` and the turn
      block.
    - N12-1: one-off bold labels parse as a conversation.
    - N12-2: offset timestamps land a day early.
    - N13-1: merged arrow functions lose their definitions.
    - N13-2: the `resolved` flag.
    - N13-3: the shared-name language gate.
  - **In the upcoming fix wave 6, lane B:**
    - N9-2: schema-pack frontmatter relations are forced outgoing.
    - N9-3: meeting attendance is stored meeting to person.
    - N9-4: the attended seed never resolves.
    - Lane B also covers the legacy-pack attendance gap, N12-7.
  - **In fix wave 6, lane C:**
    - N1-1: `ontology_propose` is refused on managed brains.
    - N1-2: an ontology revert is a no-op.
    - N1-3: private ontology observations reach remote callers.
    - N5-1: the hot-memory cache serves forgotten facts for 30 s.
    - N5-2: concurrent PGLite writes leave a forgotten fact's page without
      chunks.
    - N5-3: the first `remember` after a forget is refused with
      `scope_denied`.
  - **In fix wave 6, lane D:**
    - N2-1: undated pages reach the judge with the fallback date.
    - N2-2: `find-contradictions` with no flags returns nothing.
    - N2-3: judge quality against its own prompt rules. Fixed by judge prompt
      v3 (gbrain `89a4f8a9`). On a fresh seed (development data), same-time
      conflicts called contradictions went from 101/150 to 131/150, and
      unplanted false contradictions from 59/820 to 11/820
      ([addendum](docs/benchmarks/2026-10-01-n2-contradiction-surfacing.md#addendum-2026-10-01-the-n2-3-prompt-fix-on-development-data)).
- **Feature gaps (28)** are listed rather than "fixed":
  - Implicit supersession, paraphrase retraction and physical erasure.
  - Corpus-wide contradiction discovery, and findings hidden from remote
    callers.
  - Keyless abstention and a grade that never separates answerable from
    unanswerable questions.
  - Any reply closes a loop, there is no fulfillment tracking, loops are
    Gmail-only, and loops rank by wall clock and detection age.
  - Common-word alias false alarms, and no associative recall.
  - No composed multi-hop plans.
  - No generic JSON transcript adapter, the `1970-01-01` date fallback,
    dropped seconds and undocumented attendance forms.
  - Substring `code_refs`, no cross-file resolution, and code reads that are
    trusted-only.
  - The full list is in the [wave ledger](docs/benchmarks/2026-10-01-wave-bugs.md).
- **Category defects (7), fixed or recorded here, never in gbrain:**
  - N1-5 and N1-6: N1 scoring errata.
  - N5-7: N5's first retention definition.
  - N2-6: 6 of 10 amara-life contradiction labels relabelled.
  - A4-3: the budget ledger cannot price TypeSafe, so S4-on was not run.
  - A4-4: refusals that name another company's value count as answers.
  - N12-8: the first development run measured the legacy schema pack.
- **Paid spend: $15.75 in total.**
  - N2 judge: $5.74, plus $2.76 from a first attempt that a tool time limit
    stopped with no receipt.
  - N2-3 prompt A/B (development data): $5.90.
  - A4 reader: $1.12.
  - N9 paid arms: $0.129.
  - N7 extractor replay: $0.10.
  - N1 paid arm: $0.000006.
  - Step 0, N12, N13 and N5: $0.
- **Step 0 infrastructure.**
  - gbrain is re-pinned from `6c8373c` (v0.60.13.0) to `3a284ae`.
    `MODE_BUNDLES` are identical.
  - `eval/runner/hermetic-env.ts` strips provider and TypeSafe keys, uses a
    fresh `GBRAIN_HOME`, and proves System One is off before and after a run.
  - Registry promotion rules: `all.ts` gates only on them. It also gains
    `--only` and a `--paid --budget-run-id` guard.
  - A scorer mutation kit, with empty, always-positive, always-refuse, stale
    and wrong-source fakes.
  - A shared bug ledger, `eval/runner/bug-ledger.ts`.
  - A capability and entrypoint matrix with committed keyless probes.
  - An "add a category" checklist.
- **Known limits.**
  - The N9 hermetic arm (about 134 s) and N2 (about 76 s) run over the
    wave's 60-second CI target.
  - N8 waits on human review of its associative labels.
  - The SO report still says the pin lacks `--decide`; at `3a284ae` it has
    it.
- Reports: `docs/benchmarks/2026-10-01-*.md`. Ledger:
  `docs/benchmarks/2026-10-01-wave-bugs.json`, with its rendered view beside
  it. Capability matrix: `docs/benchmarks/2026-10-01-capability-matrix.md`.

## [0.10.4] - 2026-10-01

### System One v1 (Jev decision support): two slots help, three regress

gbrain's System One lets TypeSafe's Jev (`typesafe:jev-1.13.0`, always
resolved to `jev-1.13.0`) make nine decisions inside gbrain. gbrain measured
each slot on 2026-09-30 as a matched pair on branch `feat/system-one-v1-evals`
(v0.60.17.0 plus the System One work, receipts committed in `57661631`). This
release mirrors that record and makes every slot runnable from here.

- **Result.** Jev measurably helped dream triage (S7) and contradiction
  proposals (S9); reranking (S1), evidence trimming (S3) and abstention (S4)
  regressed; routing (S2) changed nothing; S5, S6 and S8 were inconclusive.
  S7: buried-signal misses 10/18 to 0/18, routine chats rejected 78/79 to
  52/79, triage $0.0046 to $0.0009 per transcript; end to end 10/10 buried
  signals synthesized against 3/10, dream spend $1.50 to $2.60. S9: supersedes
  found 0/97 to 94/97, one wrong proposal. S1: `recall_all@5` 94.8% with Voyage
  against 91.4% to 94.0% with Jev on 233 LongMemEval-S questions.
- **Post-eval fix, not re-measured.** S1 with query expansion timed out on
  every question (248/248 and 28/28) because the 1,500 ms decision budget
  started before expansion. gbrain `9f7794ec` starts it after retrieval.
- **Labels.** Generator construction, benchmark annotations or
  `claude-sonnet-5` (S8); none is a human hand label. Judge agreement: kappa
  0.73 against gpt-4o on LongMemEval answers, 0.58 against the S8 labels.
- **Spend.** $24.95 of a $40 cap in gbrain's run, itemised in the copied
  ledgers. This release's own smoke runs cost about $0.07.
- **New category.** `eval/runner/system-one-jev.ts` with per-slot
  definitions in `eval/runner/system-one/slots.ts`: 15 evaluations covering
  S1 to S9 through `gbrain eval longmemeval --decide`, `eval brainbench
  --decide`, `decide judge-agreement`, gbrain's triage-pair runner and its
  recorded-answer runner. `verify` (registry `SO`, tier H, in CI) recomputes
  every dataset and split hash, rebuilds the S7/S8 inputs, recounts the S7
  pair and all LongMemEval arm summaries from per-item rows, and checks every
  number in `verdicts.json` against its receipt. `build`, `analyze` and `run`
  take `--gbrain <checkout>@<ref>`, since the pinned gbrain has no System One
  commands (registry `SO-live`, tier P).
- **Reproduced keylessly on 2026-10-01** against gbrain `fc9a1d45` and again
  at `9196543d` (v0.60.26.0, gbrain#5797): `build` matched the frozen hashes of
  S7, S8, S3 and S4, and `analyze` reproduced the S2, S6, S8 and S9 analysis
  files exactly. The copy is pinned to `9196543d`; between the two commits only
  the Ubicloud setup script changed in the record, and the key-aware defaults
  gbrain added never apply to eval runs.
- **Data.** `eval/data/system-one-v1/`. S7 and S8 reuse the Cat 35 corpus in
  `eval/data/transcript-distill-v1` (their 24 and 16 Cat 35 transcripts were
  byte-identical copies) and add only the 230 synthetic S7 transcripts and
  the S8 labels. S3 and S4 (57 MB and 14 MB) are rebuilt from LongMemEval-S.
- **Not ported.** The preset end-to-end dream run has receipts but no
  upstream driver; S7 on a local `llm:` model was never measured.
- Report: `docs/benchmarks/2026-09-30-system-one-jev.md`; receipts, ledgers,
  provenance and upstream runners under
  `docs/benchmarks/2026-09-30-system-one-jev/`. Tests:
  `test/eval/system-one-jev.test.ts`.
## [0.10.3] - 2026-10-01

### Auto delivery at the 24,000-token budget: no question cut, requests equal page's (development data)

gbrain now ships `auto` evidence delivery as the default, a judgment call on
development evidence after the sealed release check in 0.10.2 could not show a
gain, and raised the default conversation budget from 16,000 to 24,000 tokens
(gbrain `aea59b2f`, v0.60.23.0). This release adds a development-data addendum
measuring that budget. It was not preregistered and does not change the
sealed E2 verdict; the sealed set was not touched.

- **Setup:** the 81 LongMemEval-S questions the 16,000-token budget cut, on
  the same frozen top-five hit lists, Sonnet notes reader and both judges.
  Every frozen hit's chunk text matched the re-import on all 81; no reader
  errors.
- **Result:** at 24,000 no question is cut (largest delivery 19,989 tokens),
  and auto's request is byte-identical to page's on all 81. auto answered 71
  against 68 at 16,000 (+3/−0, p = 0.25) and 72 for page (+1/−2, p = 1.0);
  official judge 70, 68 and 72. Mean reader input 19,066 tokens, equal to
  page's. Since the other 419 questions were already under 16,000, auto at
  24,000 is page delivery on all 500 development questions (inferred from the
  delivery rule, not re-run).
- **Cost:** $5.17 against a $20 cap, through one ledger run.
- Code: a `budget-check` subcommand in `eval/runner/evidence-auto-v2.ts`.
  Report: the addendum in `docs/benchmarks/2026-09-30-evidence-auto-v2.md`,
  receipts under `docs/benchmarks/2026-09-30-evidence-auto-v2/results/lme/budget-24k/`.

### Sealed confirmation set v2: built, frozen, not opened

v1 was too easy to confirm a delivery gain (the chunk default answered 147 of
150), so this release freezes a harder second sealed set with v1's custody
design. No gbrain run has touched it.

- **The set:** 200 questions over 40 invented personas (80 multi-session, 40
  temporal, 40 knowledge update, 40 abstention; no single-session). Histories
  of 46 chats, 135,000 to 150,000 tokens each (about LongMemEval-S size), over
  eight to twelve months. Answers need three to four chats for multi-session,
  two to three chats 90+ days apart for temporal, and an initial value plus
  two changes for knowledge update. Planned and audited by `gpt-6-sol`,
  written by `gpt-6-luna`, seed 20261002; 616 of 640 persona chats passed the
  fact audit and 19 questions carry an audit flag.
- **Solvability (reported, never used to delete items):** oracle 199/200,
  chunk oracle 196/200, no memory 40/200 (0/160 answerable). The evidence
  always fits in five chunks (median two to four), so the set tests whether
  retrieval finds several chats months apart, not whether chunks can hold the
  answer.
- **Overlap audit** against LongMemEval S/M: no exact or near-duplicate
  questions (max Jaccard 0.33), no persona full names; only filler chats share
  a 13-word run (stock phrases; 6 in S, 10 in M), no persona chat does.
- **Custody:** only the manifest (commitments and counts), the solvability
  summary and the overlap counts are committed. Access log: one line, the
  solvability run.
- **Cost:** $29.90 of a $60 cap ($20.99 generation, $0.35 pilot, $8.56
  solvability). About $8 of generation was wasted by a duplicate process
  started by mistake after an agent restart; the manifest records the
  settled total and the note.
- Code: `eval/generators/sealed-confirmation-v2-gen.ts` and
  `sealed-confirmation-v2-prompts.ts` with a keyless test suite; the sealed
  runner names its dataset after the manifest's set. Protocol:
  `docs/benchmarks/2026-10-01-sealed-confirmation-v2-protocol.md`.

## [0.10.2] - 2026-09-30

One release for four pieces of work that followed v0.10.1: the LongMemEval
reranker-on follow-ups, the evidence-delivery study, its auto v2 release check
on the sealed set, and three keyless categories (N3, N4, N6). It was built on three branches (numbered 0.10.2 to
0.10.4 while in review) and ships as a single patch release. It also moves the
gbrain pin to master `6c8373c` (v0.60.13.0), which contains the evidence
delivery code and the fixes for the seven bugs N3, N4 and N6 found.

Paid work in this release: the reranker-on runs ($51.22 against a $120 cap),
the evidence-delivery program ($112.44 through one ledger run) and its $0.97
plumbing smoke, and the auto v2 release check ($73.92 through one ledger run
against a $150 cap). Everything else is keyless.

### Auto v2 release check on the sealed set: `fail`

gbrain's new default, `auto` v2 (gbrain `e9b580c5`, v0.60.16.0), returns the
whole page for conversation hits within a 16,000-token budget and leaves other
hits' chunks unchanged. A second decision manifest, committed before any paid
call and pinned in its own commit, made the sealed confirmation set the
decision and LongMemEval-S a sanity check.

- **Verdict: `fail`.** On the 150 sealed questions, auto answered 149 against
  147 for the chunk default (+2/−0, exact McNemar p = 0.50, persona-clustered
  p = 0.49; official judge 149 against 146). The rule required a significant
  gain. Chunks were already at 98% on the short sealed chats, so no delivery
  change could reach significance there (it would need six one-sided wins;
  chunks missed three questions). No demonstrated benefit on held-out data,
  and no demonstrated harm.
- **LongMemEval-S (development data, 500 questions):** auto 445, page 457,
  chunk 312 (auto against chunk +145/−12, p = 4e-30; against page +7/−19).
  The sanity bar, page − 10 = 447, was missed by two questions.
- **Truncation cost:** the 16,000-token budget cut 81 questions (85 of 2,451
  blocks truncated, no fallbacks); there auto scored 68 against page's 72,
  about 0.8% of 500. On the other 419 questions auto's request was
  byte-identical to page's and the reader still disagreed on 20 (377 against
  385), which is reader noise and most of the shortfall.
- **Custody:** the sealed questions, labels and access log were transferred
  to the Capy machine with a custody note and never copied to a VM. Labels
  opened once through the sealed runner (commitment check, decision id
  `evidence-auto-v2-2026-09-30:e2:auto`, access log 2 → 3 lines). Only
  aggregates are published, and every sealed file and derived artifact was
  deleted after scoring. This was the first of the set's three release
  decisions.
- Code: decision manifest v2, `eval/runner/evidence-delivery/decision-v2.ts`
  with a keyless test suite, a power analysis, `eval/runner/evidence-auto-v2.ts`;
  the paid guard and sealed scorer now take a manifest path, campaign runner
  and E2 rule, and the watchdog measures staleness from each attempt's start.
  Report: `docs/benchmarks/2026-09-30-evidence-auto-v2.md`.

### Evidence delivery: whole pages help; cheaper windows do not close enough of the gap

The evidence-delivery study: preregistered, run and reported. gbrain is
adding an opt-in stage that returns neighbors, sections or whole pages
instead of bare chunks.

- **Result: whole pages help; cheaper windows do not close enough of the
  gap.** On 400 held-out LongMemEval-S questions with the reranker on and
  retrieval frozen at gbrain `732ee811`, whole-page delivery answered 361
  against 253 for five chunks (+114/−6, p = 6e-27). The two pilot winners,
  one or two neighbor chunks per side, scored 285 and 292 at 44% of
  whole-page input tokens: significant against chunks, but only 30% and 36%
  of the gap against the preregistered 60%. Decision-manifest verdict:
  `page_only`, so `page` ships opt-in and the default stays `chunk`; the
  sealed set was not opened. An agent that could fetch pages scored 83/100
  on the pilot (chunks 68, pages 92). The gpt-4o reader tied (128 against
  129/400) because it abstained on about two thirds of questions under the
  notes prompt. E3 reproduced the frozen evidence over MCP on 100/100
  questions for every arm. Paid cost $112.44 through one ledger run.
  Report: `docs/benchmarks/2026-09-30-evidence-delivery.md`, receipts under
  `docs/benchmarks/2026-09-30-evidence-delivery/results/`.

- **An executable decision manifest**
  (`docs/benchmarks/2026-09-30-evidence-delivery/decision-manifest.json`),
  committed before any paid call. It fixes judge roles (gbrain judge primary,
  official judge may not reverse), the gap and 60% closure formula, the 50%
  provider-token rule, the six-candidate Holm family, pilot selection and
  tie-breaks, clusters, error handling, the E2 pass/reject/inconclusive rule
  and the gbrain commit pin. `eval/runner/evidence-delivery/decision.ts`
  applies it; a keyless suite covers close wins, zero and negative gaps,
  sparse types, judge disagreement, many-policy selection and failed calls.
- **A power analysis** over the exact decision code. A candidate that closes
  70% of the gap passes 65% to 82% of the time. The per-type rule fails even
  a page-quality policy 12% to 24% of the time through reader noise, and E2
  rejects a truly equal winner 6% to 20% of the time. Both rules are kept as
  preregistered and flagged.
- **A content-addressed frozen evidence manifest.** `freeze` stores each
  question's reranked top-5 and top-10 hits with chunk text, every chunk of
  every hit page, the harness page text and every arm's delivered evidence
  with gbrain's fingerprint, plus code, parser and index hashes and the
  agreement with R1.
- **The E1 runner** (ten arms, the `get_page` agent arm, gpt-4o arms), with
  three token counts per row and a byte-level check that the harness page
  request reproduces R1's logged request before any model call.
- **The E3 product-path check** over MCP stdio as a remote caller, with
  gbrain's server spend joining the ledger through a preload, and **the E2
  bridge**, which gives the sealed set the E1 reader instead of the sealed
  runner's whole-session prompt.
- `bun eval/runner/evidence-delivery.ts costs`: the paid program is estimated
  at $122 ($153 with a retry margin) against a $400 campaign cap.
- A $0.97 plumbing smoke against the WIP gbrain branch: 4 of 4 identical-list
  questions reproduced R1's request bytes; the product `page` drops page
  frontmatter and 9 of 24 blocks lost a paragraph break at chunk seams (fixed
  in gbrain before the pinned commit); MCP `assemble_evidence` reproduced the
  local fingerprints.
- Sharded freezing (one process per embedding cache) with `merge-frozen`,
  `e3-summary`, and the VM pipeline and watchdog scripts used for the run.
- Voyage rerank timeout raised to 30 s in freeze and E3 after 28 haystacks
  timed out at gbrain's 5 s default during a Voyage overload.

Harness changes made for the study:

- The budget ledger prices dated model snapshots (`gpt-4o-2024-08-06`) at
  their family's list price and prices Voyage rerank requests.
- The sealed runner refuses to open labels for scoring without a decision id.
- Lifecycle drivers accept an entry override so a server can run with a
  preload.

### LongMemEval with the reranker on

The two reranker-on follow-ups from the LongMemEval opaque-id re-run. Both
use the same gbrain code as the 439/500 arm (`a7cb37b`), the same data,
embedding cache and judges, with `voyage:rerank-2.5` on.

- **R1, the house notes reader with the reranker on: 453/500 (90.6%).**
  - The reranker raised strict retrieval from 435/470 to 450/470 (paired
    +22/−7, exact McNemar p = 0.008).
  - Against reranker off, answers moved +31/−17 (p = 0.059); with the
    official judge, 451 against 443 (p = 0.33). That is suggestive, not a
    demonstrated answer gain.
- **R2, the published configuration without the leak: 432/500.** It used the
  direct reader at 512 tokens, the reranker on and opaque ids. Paired against
  the invalid published 433/500, it moved +15/−16 (p = 1.0). Hiding the gold
  ids made no measurable difference there. The published number stays
  invalid because it was measured with the ids visible, and the report lists
  the remaining configuration differences.
- **Notes against direct on identical reranked retrieval: 453 against 432**
  (+32/−11, p = 0.002; official judge p = 0.049). This is a new full-500
  comparison, not a re-run of the September 25 transfer cohort, whose flag
  stays in place.
- Voyage accounting for each run: 500 calls, all HTTP 200, 6.94M tokens
  ($0.35), 500/500 rows reranked, 0 `rerank_failed` or other degraded
  stages. Paid cost for both runs was $51.22 against a $120 cap. Each run
  hit the known #5092 stall five times; a watchdog resumed each time without
  repeating a reader call.
- Receipts under `docs/benchmarks/2026-09-29-longmemeval-opaque-qa/reranker-on/`
  with nine manifest entries. `scripts/verify-longmemeval-opaque-qa.py` now
  also recounts both runs, their paired tests against arm a and the
  published rows, rerank coverage and the prompt leak check.
- The report gains a reranker-on section. The README now gives the
  reranker-on numbers beside the 439/500 and says the leak made no
  measurable difference to the published configuration.

### Offline categories N3, N4 and N6

Three keyless categories from the evidence-delivery plan (section 5): temporal
and as-of questions (N3), entity resolution (N4), and a visibility and access
leak fuzz over every read operation (N6). Each has a registry entry with a
semantic contract, gold from a seeded generator ledger (never from gbrain
output), solvability and negative controls, presence assertions, receipt v2,
tests and a dated report. All three landed report-only, and each found gbrain
bugs, which gbrain v0.60.13.0 fixed (see the re-run below). No paid calls.

Measured on the pinned gbrain (`608a174`, 0.60.10.0) and on master (`f8d1e39`,
0.60.11.0) as a copied overlay; every category gave identical numbers on both.

- **N3 temporal and as-of** (`temporal-asof`,
  [report](docs/benchmarks/2026-09-30-n3-temporal-asof.md)). 500 of 513 probes
  pass: chronicle reads, search date bounds, effective-date precedence,
  time-zone and daylight-saving edges and trajectories all 100%, range set-F1
  1.000 over 179 probes, `ontology_get` as-of 99/104, last seen 76/83. The 13
  misses are four gbrain bugs: `ontology_get` drops a late-recorded stint that
  names the current value, `chronicle_last_seen` matches attendees by
  substring and can report the previous day, and a non-ISO `query` date bound
  such as `since: "May 5"` returns nothing instead of an error. The
  forward job-state gold moved from `temporal.ts` into
  `eval/generators/job-state.ts`, shared by Cat 4 and N3.
- **N4 entity resolution** (`entity-resolution`,
  [report](docs/benchmarks/2026-09-30-n4-entity-resolution.md)). On 136
  single-source mentions the resolver merged wrongly once, refused all 17
  mentions that must be refused and resolved every variant recorded in
  `aliases:`; B-cubed F1 0.755 against 0.566 for exact-only, 0.480 for refusing
  everything and 0.109 for merging everything. Typos, initials and prose-only
  nicknames stay unresolved by design. Two bugs: another page's alias beats a
  page's own exact name, and federated `recall({ entity })` merges two
  different people who share a slug and drops `source_id`.
- **N6 visibility and access leak fuzz** (`visibility-leak-fuzz`,
  [report](docs/benchmarks/2026-09-30-n6-visibility-fuzz.md)). Enumerates
  gbrain's read operations at run time (73) and calls each as stdio, serve-http
  read, write and slug-bound clients and remote and local subagents, against
  private pages, held Takes, private Facts, derived atoms and an ungranted
  source, with public-twin and trusted-local controls and a never-written
  ghost for existence oracles. 24 of the 25 read ops that return protected
  content held, and 0 of 90 access gates were bypassed. One bug: `entity` and
  `context_pack` show remote callers inbound links from private pages, with
  the private slug and a sentence of its body. It also runs against the
  `capy/evidence-delivery` branch (c0a72ab, same result); that head documents
  `return_unit` and `assemble_evidence` but does not implement them yet. A
  later run against the branch head with the code (732ee81) fuzzed every
  `return_unit` value on `search`, `query`, `recall` and `assemble_evidence`,
  with new presence controls for expansion (an expanded `delivered` block, and
  delivered text spanning the stripped Takes and Facts rows): no expansion
  path leaked.
- **`--gbrain <checkout>[@ref]` / `GBRAIN_UNDER_TEST`** for the new runners
  (`eval/runner/gbrain-under-test.ts`): extracts the ref with `git archive`
  into `.gbrain-overlays/`, installs it, verifies the copy (tree hash, no
  symlinks, CLI version) and records the loaded commit in the receipt's
  product identity. Never a symlink.
- **N4 is hermetic inside a shared test process.** `runN4` now removes
  provider keys and points `GBRAIN_HOME` at a temporary directory for the run,
  as N3 and N6 already did. Before, a test that had configured gbrain's
  gateway earlier in the same process made `remember` writes wait on provider
  calls when keys were present, and the end-to-end test timed out. Scores
  are unchanged: the re-run receipts match the earlier ones row for row.
- **`all.ts` honors `gate: 'report-only'`.** A report-only category that
  completes with a non-pass verdict is REPORTED, never a pass and never a
  failure of the run; missing, stale, invalid and errored receipts still fail.
- **Re-run at the new pin, gbrain master `6c8373c` (v0.60.13.0, #5769), which
  fixes all seven bugs above.** Same seeds and ledgers, clean tree, $0.
  N3: 513/513 probes pass (as-of 104/104, last seen 83/83 with 0.00 days mean
  error, negative controls 155/155, the non-ISO bound now rejected). N4: 0
  wrong merges on every surface (was 1 on the resolver and 3 on `recall`),
  exact-name floor 48/48 on the resolver and 50/50 on `recall`, `recall`
  refusals 21/21; seed 7 agrees. N6: 0 content leaks,
  0 existence leaks, 0 oracles and 0 gate bypasses over 3,854 probes and 74
  read ops, with every `return_unit` fuzzed. **N3 and N6 are now gates**
  (`gate: 'gate'`); N4 stays report-only because its B-cubed F1 and
  unresolved targets miss on variants gbrain does not read by design (typos,
  unrecorded initials, prose-only names). Receipts:
  `receipt-pin-6c8373c*.json` beside each report, with four manifest entries.

### gbrain pin

- **gbrain is pinned to master `6c8373c` (v0.60.13.0,
  [#5769](https://github.com/garrytan/gbrain/pull/5769))**, replacing
  `608a174` (v0.60.10.0). The `balanced`, `conservative` and `tokenmax` mode
  definitions are unchanged. `gbrain-cues` (`939232f`) and `gbrain-reader`
  (`e78f1c3`) keep their pins, so the frozen cue and reader package
  identities are unchanged. The evidence-delivery results stay dated to the
  commit they measured, `732ee811`. The README, settings guide and
  comparison-systems page name the new pin.

## [0.10.1] - 2026-09-29

One release for all of the work that followed the September 28 audits and the
approved 10x plan. It was built on eight branches (numbered 0.10.1 to 0.10.8
while in review) and ships as a single patch release. Several published
numbers had been measured by code that could not fail, or that let the system
under test see the answer. This release fixes those runners and scorers,
corrects the published claims in place beside dated errata, runs the whole
suite in CI, adds an independent evaluator, a category registry, receipt v2
and a paid-run budget ledger, freezes a sealed confirmation set, adds a memory
lifecycle experiment, and replaces the invalid LongMemEval answer score with a
leak-free re-run. Historical scores keep their original dates; where a fix
moves a number, the old number stays in its dated report.

Paid work in this release: the LongMemEval opaque-id answer re-run (about
$59.6), the sealed confirmation set ($17.83) and the relationship paraphrase
check ($0.0645 of OpenAI embeddings). Everything else is keyless.

### Measurement integrity (audited 2026-09-28)

Keyless reruns and recomputations in this section were made at the pin of the
day, `939232f`.

- **LongMemEval runners no longer show the gold label.** Every gold session id
  starts with `answer_` and no other session does. The retrieval runner, the
  answer check, the reading-notes request builder and the M-pilot build now
  give the system and the reader opaque ids (`s-` plus 10 hex characters) and
  translate back before scoring. A test asserts that no system or reader input
  contains `answer_` (C-01, PD-05, PD-08). The published 433/500 judged answers
  and the 308 to 324 of 361 reading-notes result came from readers that saw raw
  ids (see the leak-free re-run below).
- The LongMemEval aggregator marks a run publishable only when every adapter
  has the expected row count, and stamps the gbrain version recorded in the
  rows rather than the local install (PD-01, PD-02). Resume and batch
  completion are keyed on `run_config_hash` (PD-03). The NDJSON validator
  rejects residual error rows unless `--allow-errors` is passed (PD-04).
  Answer-generation outages count as dependency errors (PD-06).
- `all.ts` requires a fresh, valid receipt from every runner it dispatches. A
  missing or invalid receipt is a failure, never an exit-code pass (C-06,
  C-07). It lists every category in the repository with a tier, runs
  `--tier offline` (default), `paid` or `all`, and prints each category it did
  not run with the reason (C-09). Latency categories run alone (C-11). The
  `eval:brainbench:published` script, which claimed N=10 while no dispatched
  runner read N, is removed (C-08). A keyless `--tier offline` sweep at
  `939232f` passed 17 of 17 dispatched categories.
- Cat 2 type accuracy charges every inferred type that differs from gold, so an
  extractor that emits every type can no longer score 100% (C-05). At
  `939232f` this scorer gave 86.6% (240/277 found pairs; 97.1% under the old
  any-type rule, still reported as a diagnostic) and strict F1 41.3% (48.1%
  before); the attendance-direction correction below later replaced both.
  Cat 2 and Cat 3 write receipts and gate on regression floors.
- Cat 3 scores the handle without `@` as documented, because the keyword index
  strips the `@`. Undocumented alias recall is 13.75% (55/400), not the
  published 31.0% (C-03).
- Cat 1 reports Precision@5 with the standard /5 denominator: 29.9% before and
  35.4% after graph traversal, against a ceiling of 36.0%. The legacy
  /min(5, returned) value (39.2% to 46.5% at this pin) is kept beside it
  (C-04).
- The Cat 36 offline smoke fails when search crashes on every probe or finds no
  evidence (PC-05). Cat 34 gates on production-seam cells and reports
  contract-seam cells as informational, so it can pass (PC-08).
- Cat 35 reports the evidence-verified joint score next to the judge-only score
  and excludes judge failures instead of counting them as misses (PC-01,
  PC-03). Recomputed from the committed receipts (dream lane macro): 88.1%
  judge-only is 74.9% joint; the earlier 70.2% is 58.2% joint; the Aug-25
  baseline is 64.7% judge-only (61.5% published) with 8 of 173 failed items
  excluded. Cat 35 writes a common receipt and skips cleanly without keys
  (PC-09).
- Cat 29 judges both answers in one blind prompt in both orders and flags
  position-inconsistent pairs; the earlier "both orders" made the same
  single-answer call twice (B-29-01).
- The multi-adapter `gbrain` row runs the product path (hybrid search with
  relational retrieval). The regex parser for the four query templates stays as
  `graph-oracle-parse`, labeled as an upper bound (C-10).
- Cat 13 reports probes that copy the target page's title, description or body
  as a lexical control beside the conceptual probes. Recomputed from the
  2026-09-09 receipt, gbrain scores 61.5% nDCG@5 on the 246 conceptual probes
  and 53.6% on the 302 lexical-control probes (A-14).
- Every `readdirSync` enumeration is sorted, with a repository-wide test
  (A-06). The Cat 13 probe set is unchanged; Cat 6 injects different mentions
  in some cases with every gated rate unchanged.
- Judges and direct model calls run at temperature 0 where the SDK allows it
  (PC-02, B-29-03, A-03). Judge prompts escape system output, fence it in a
  per-call nonce block, and state that block content is data. Judge prompt
  versions moved, so new judged receipts do not compare with older ones (C-13,
  A-20, B-JDG-01, PC-10).
- `dcgAtK` counts each id once, so nDCG cannot exceed 1 (C-16).

### Corrections to published claims

Every original figure stays visible beside a dated erratum. The README now
states where gbrain actually leads: strict `recall_all@5` of 95.53% (449/470)
on LongMemEval, against 90.0% and 85.7% for our strict recounts of MemPalace's
saved rankings and 87.45% self-reported by ContextFit. Answer accuracy is not a
matched comparison yet, and the README says so.

- **Cat14 calibration (May 18): retracted.** The 75% win rate (6 of 8) and 100%
  axis scores came from a judge that saw each probe's expected behavior and
  knew which answer was calibrated.
- **Cat 3 undocumented alias recall (April 18): 31.0% becomes 13.75%
  (55/400).** The handle without `@` is in the indexed page text and scored
  100/100. Verified by re-running `eval/runner/identity.ts`.
- **Cat 2 link type accuracy (April 18): 70.7% to 88.5% came from a lenient
  scorer.** A strict re-run at `939232f` gave 86.6% (240/277) and strict F1
  41.3% (48.1% before the scorer fix). That count was itself wrong: the answer
  key pointed attendance edges from the meeting to the person, and gbrain
  stores them the other way, so the 86.6% counted 131 reversed edges as
  correct. **With the direction corrected, type accuracy is 74.7% (109/146) and
  strict F1 18.8%** at both `939232f` and `b80cad6`; the regression floors
  moved to 70% / 15%. Cats 1 and 6 are unchanged between the two commits.
  [Report](docs/benchmarks/2026-09-29-repin-cats-1-2-6.md).
- **The multi-adapter `gbrain` row (April 19, April 23, May 23)** came from a
  regular-expression template parser, now `graph-oracle-parse`, and is marked
  invalid as a product score. The September 9 concept report gains a split of
  conceptual and lexical-control probes.
- **Cat 1 precision at five (April 18): 39.2% to 44.7% becomes 29.9% to
  35.4%** when divided by five slots per question (145 × 5 = 725), against a
  ceiling of 36.0%. Verified by re-running `eval/runner/before-after.ts`; the
  legacy denominator now gives 46.5% after, against 44.7% published.
- **Cat 35 retention (August 31): 88.1% is judge-only.** Evidence-verified
  retention, recomputed from the committed receipts, is 74.9% (58.2% before the
  change). The August 25 baseline is 64.7% with judge failures excluded (61.5%
  published) and 51.2% evidence-verified. The README also says the result is
  in-sample.
- **May snapshot, Cats 18b to 29:** every row is marked with the defect of the
  pre-audit runner that produced it, including Cat 29's duplicate-call "both
  orders" scoring.
- **LongMemEval answer accuracy (433/500): invalid.** The answer model saw the
  `answer_` prefix that marks every labeled evidence session id. The README,
  the comparison page and the September 6 report point to the leak-free
  September 29 re-run below and say that the answer comparison with vendor
  self-reports is still not matched. **The reading-notes transfer result
  (308/361 to 324/361) was not re-run and stays pending.** A 30-question check
  found no effect of the prefix on retrieval.
- The README concept claim compares like with like (102/181 for gbrain against
  118/181 for vectors without a reranker; 130/181 with one), and the
  relationship claim reports the overall result (first-place hits 14% to 24%)
  and attendance (0/50) beside the investor example. It discloses that the
  95.53% configuration was chosen on the same 470 questions and that the
  pre-registered 92% answer target was missed.
- The PrecisionMemBench comparison table shows the September 9 corrected gbrain
  rows with their non-null case counts; the invalid May rows are struck
  through, no longer bold (B10).
- `docs/settings.md` and `docs/comparison-systems.md` no longer say that gbrain
  `2efaaf8f` is the installed library; a test checks such claims against the
  `package.json` pin.

### CI and the test suite

- `bun run test` runs the 77 colocated unit tests under `eval/` (counted on
  2026-09-28), the 25 Python orchestrator tests and the validators (published
  LongMemEval recount, LongMemEval opaque-id recount, documentation, links,
  queries, data). CI runs all of them.
- The Bun suite ran in about 2 minutes 25 seconds instead of about 9 minutes
  20 seconds on a 4-core machine when this was measured on 2026-09-28. A test
  preload builds one pre-migrated PGLite snapshot per embedding shape through
  gbrain's own snapshot loader, and `scripts/test-shards.ts` runs four
  ordinary `bun test --shard` processes at once. (Bun's `--parallel` worker
  mode was tried and rejected: tests that call `Bun.spawnSync` hung in 2 of 4
  full runs.) CI splits the tests into four shard jobs and moves type checks,
  validators and hermetic runners into a separate job, each with its own
  timeout. That job runs every keyless category through
  `bun run eval:brainbench` (`all.ts --tier offline`), so the Cat 1, 2, 3 and
  10 gates fail CI on a regression. Two PGLite-building tests carry explicit
  timeouts because they exceed 5 seconds under four shards.
- `tsc` passes with no output filtering: DOM libraries, `@types/js-yaml` and
  `@types/express`, TypeScript 5.9, and small shims for Bun text imports and
  one image encoder signature. CI gates both type checks unfiltered.
- The `postgres@3.4.9` patch is declared in `patchedDependencies`, so the
  cancellation-capable driver `gbrain-reader` expects is actually installed.
- Removed the PGLite postinstall link. gbrain finds the hoisted PGLite assets
  without it.
- Cat30 to Cat33 import SkillOpt through gbrain's public `./core/skillopt`
  export.
- The built-in Tier 5.5 family is labeled `synthetic-outsider` in new
  scorecards; no outside author wrote those questions.
- Documentation follows the opaque session ids: the LongMemEval-M
  preregistration describes the `indexed-projection-v3` build, the
  reading-notes report describes request schema 2, and the May LongMemEval
  report shows how to validate the prefix-bracket stream with
  `--allow-errors`.
- `scripts/check-links.py` checks every link and heading anchor in the
  repository's Markdown on each `bun run validate`; a weekly workflow also
  fetches external links (B12).

### Independent evaluator and paired comparisons (plan amendments 4 and 6)

- **Paired comparator: `bun eval/runner/compare.ts <A> <B>`.** It pairs two runs
  question by question and refuses duplicate ids, missing pairs and questions
  that are eligible on one side only. It reports the absolute change with a
  clustered 95% bootstrap interval, a clustered sign-flip test, the exact
  McNemar test and a power note (the smallest change detectable at 80% power).
  Items share a cluster id, so ten paraphrases of one concept count once. The
  statistics generalize the situation-recall regression gate's bootstrap,
  sign-flip and Holm code (`eval/runner/stats/`), and a test holds the two to
  identical results. Recounting the committed September 6 rows reproduces the
  published reranker comparison: 18 wins and 8 losses over 470 answerable
  LongMemEval-S questions, +2.13 points (interval 0.00 to +4.26), McNemar
  p = 0.0755.
- **Three gates over a preregistered family** (`--family`). Exact correctness
  and safety assertions fail at once with no significance test. Noisy quality
  metrics pass only when non-inferiority within a stated tolerance is shown
  after Holm correction; a wide interval is inconclusive, not a pass.
  Exploratory metrics never gate.
- **Independent evaluator** (`eval/runner/evaluator/`). A gold store keeps
  labels in a private field and hands out scores. The LongMemEval runner keeps
  only gold-free question views and scores through a gold store loaded by a
  separate read of the dataset, checked byte for byte. Cat13 gold comes from a
  separate corpus read and must match the runner's probes id for id and text
  for text. A reference scorer reimplements the metrics without importing the
  product.
- **Input allowlist** for every payload sent to the system under test or a
  reader or judge. It refuses undeclared fields, non-plain objects and any raw
  dataset session id beyond what the conversation text accounts for, whether or
  not the id starts with `answer_`. A violation voids the run. It covers
  LongMemEval retrieval and answers and Cat13, and in the final fix wave also
  the reading-notes reader input and captured request, Cat 29's question and
  pairwise judge, and Cat 35's transcripts and scaffold (no gold id), coverage
  judge (no verbatim anchor beyond the judged document), leak judge and
  usability judge (no gold statement beyond the pages). Receipts record the
  gold-store fingerprint, scorer version and boundary names under
  `resolved_config.evaluator`.
- **Adversarial tests** the evaluator must catch: known rankings, permuted
  labels, removed metadata, duplicate ids, an empty system, wrong answers, and
  adapters that leak gold, return nothing or return duplicates
  (`test/eval/evaluator-adversarial.test.ts`).
- Cat13 per-question rows gain `cluster_id` (the target concept) and, when an
  adapter repeats a page, `duplicate_results`. Scores are unchanged: repeated
  pages already earned nothing.
- [Comparing runs](docs/comparing-runs.md) explains all of the above.

### gbrain pins, category registry, receipt v2 and the budget ledger

- **gbrain is pinned to master.** On 2026-09-29 the pin moved from `939232f`
  (a side branch) to master `b80cad6` (v0.59.13.0), and at integration it moved
  again to master `608a174` (v0.60.10.0). The memory-cue experiments
  (situation recall, the LongMemEval-M pilot and Cat 36 cue arms) need code
  that exists only on gbrain's `capy/situation-aware-recall` branch, so they
  load a separate package alias, `gbrain-cues`, pinned to `939232f`. Cat 36 and
  situation-recall runtimes pick the package from the arm: cue and summary
  arms use `gbrain-cues`, every other arm measures the pinned product. Pins
  are read from `package.json` (`eval/runner/pins.ts`).
- **Re-pin check at `608a174` (2026-09-29).** Cats 1, 2 and 6 give the same
  data as their committed `b80cad6` receipts (Cat 2 still 74.7% type accuracy,
  18.8% strict F1), so no published number moves. The offline tier passes
  every dispatched category, and Cat 34 passes 12 of 12 against a gbrain
  checkout at the same commit. Two behavior changes in gbrain surfaced:
  - gbrain v0.60.6.0 (#5675) records a file import's `file://` origin in
    `source_uri`, which also server-stamps `ingested_at`. Cat 24's file-import
    probe and its native collector now expect that origin, and still require
    `source_kind` and `ingested_via` to stay empty. Before this pin the probe
    expected all four fields empty.
  - gbrain v0.60.6.0 widened its relationship parser. The keyless
    relational-ab check fires on 33 of 145 paraphrased questions at `608a174`,
    against 0 at `b80cad6`; template firing is unchanged at 58. The paid
    paraphrase measurement stays dated to `b80cad6`, and the README, the report
    and TODOS carry a dated note.
- **`gbrain-reader` pins gbrain master `e78f1c3`** (v0.59.0.0), replacing
  `a9de062`, which is on no branch. The two commits' `src/` trees and
  `package.json` are byte-identical; the 22 reading-notes tests pass.
- **ZeroEntropy cells are retired** (supersedes PR #35). Cat 18 compares OpenAI
  and Voyage embedders; Cat 18b pairs each with `voyage:rerank-2.5`. Both are
  dispatchable paid categories again.
- gbrain v0.59.10.0 saves a page's text when embedding fails instead of
  throwing. Runners that measure vector or hybrid search treat such a deferred
  embedding as an error, so a provider outage can no longer be scored as
  keyword-only retrieval under an embedding label.
- **`eval/registry.ts`**: one row per category with its legacy alias, family,
  tier (H hermetic, K keyed under $1, P paid), cost estimate and its basis,
  receipt path, headline metric and denominator, gate status, evidence
  maturity and a short statement of what it measures. `all.ts` reads it and
  accepts `--tier H|K|P`. No category was renumbered. The registry lists the
  lifecycle experiment and the sealed confirmation set, and
  `test/eval/registry.test.ts` fails when a file under `eval/runner/` is
  neither a registry script nor listed in `RUNNER_HELPERS`.
- **Receipt schema v2.** Every receipt records the content hash of the evals
  tree that ran (uncommitted edits included), the declared pin and content
  hash of the gbrain package actually loaded, planned, attempted, scored and
  errored probes with errors kept apart from misses, and cost, p50/p95 latency
  and tokens delivered to models when a runner measures them. v1 receipts
  remain readable. Cost and delivered tokens are recorded as a measured zero
  in 16 keyless runners and stub modes, from the budget ledger in
  relational-ab live runs, and latency in Cats 13b, 28 and relational-ab.
- **Budget ledger** (`eval/runner/budget-ledger.ts`). LongMemEval, Cat 13, Cat
  35 and relational-ab live runs refuse to start without `--budget-usd`, print
  their estimate, and reserve every provider request (retries and gbrain's
  internal calls included) against the run budget and a $500 program cap
  before sending it. Reservations reconcile to provider-reported usage. The
  ledger is a gitignored JSON file (`.budget/ledger.json`), tested with mocked
  providers. `longmemeval-batch.sh` opens one ledger run and passes
  `--budget-run-id` to every worker, so `--budget-usd` caps all workers and
  restarted batches together.
- Receipts stop recording machine-local paths: `writeReceipt` makes paths under
  the checkout repo-relative, `bun eval/runner/receipt.ts scrub <file>` also
  rewrites home and temp paths before a receipt is committed, and a test fails
  on any committed receipt with such a path, except historical receipts frozen
  by hash (B11). The frozen list holds the 63 receipts recorded before the fix
  wave plus the two lifecycle receipts, which are kept byte-for-byte because
  the manifest and the recount test pin them.

### Sealed confirmation set (plan amendment 1)

The LongMemEval-S questions and the Cat13 held-out concepts were used to
choose gbrain's settings, so they are now development data. This release
freezes a separately written confirmation set for future release decisions and
publishes only its method, counts and SHA-256 commitments. No gbrain run has
touched it.

- **Sealed confirmation set v1.** 30 fictional personas, each with a 55-chat
  history (20 personal chats, 35 general-help chats), and 150 questions: 30
  each of single-session fact, multi-session aggregation, temporal reasoning,
  knowledge update and abstention. Written by OpenAI `gpt-6-sol`, a model not
  used for LongMemEval or any earlier corpus here. Personas share no
  occupation, hobby or life arc. Labels come from the generation ledger. The
  questions, chats and labels stay private;
  `eval/data/sealed-confirmation-v1/manifest.json` holds their commitments.
  Protocol:
  [`2026-09-29-sealed-confirmation-protocol.md`](docs/benchmarks/2026-09-29-sealed-confirmation-protocol.md).
- **Solvability controls, reported and never used to drop items.** With only
  the gold chats, a Claude Sonnet 4.6 reader answered 150/150 (GPT-4o judge,
  official LongMemEval prompts). With no chats it answered 0/120 answerable
  questions and, as expected, 30/30 abstention questions.
- **Overlap audit.** Against LongMemEval S and M: 0 of 150 questions identical,
  highest word-set similarity 0.33, 0 persona full names, 0 of 1,650 chats
  sharing a 13-word run of text. All 500 M questions are S questions.
- **`eval/runner/sealed-confirmation.ts`.** Runs gbrain through the LongMemEval
  runner's code path on a questions file that passes an input allowlist, then
  scores with the private labels path given only at scoring time. Scoring
  refuses a labels file that does not match its commitment and logs every
  access with its purpose and decision id.
- **`eval/generators/sealed-confirmation-gen.ts`** with frozen prompts, and a
  durable spend-reservation ledger checked before every paid request.
- Cost: $17.83 in paid API calls, $15.82 generation (including two one-persona
  pilots) and $2.00 solvability.

### Memory lifecycle experiment (plan amendment 8)

A new experiment follows one small vault through a full memory lifecycle
(ingest, query, an ingest during an embedding outage, corrections, a full
reconcile, a forget, a restart) and scores what an agent can read against a
ledger the evaluator writes itself. It compares four gbrain builds on PGLite
and Postgres through the local CLI, MCP stdio and MCP HTTP, twice, at $0.

- **`eval/runner/lifecycle-experiment.ts`** and `eval/runner/lifecycle/`: the
  scenario and ground-truth ledger, drivers for the three interfaces, a
  hermetic OpenAI-compatible hash embedder with fault injection, the scorer,
  and copied-overlay build preparation. A build runs only if its copied files
  hash to the requested commit's tree, no symlink exists under `src/`, and
  `gbrain --version` matches its `VERSION`.
- **`eval/runner/lifecycle-report.ts`**: tables from a receipt, and a
  cell-by-cell comparison of repeat runs.
- **[Lifecycle report](docs/benchmarks/2026-09-29-lifecycle.md)** with a
  primary run and a repeat.
- Measured 2026-09-29: forgetting one entity's fact expired the identical claim
  on another entity, and refused the same claim for a third, in 18 of 18 cells
  on v0.59.3.0, v0.59.11.0 and master v0.59.13.0. Master plus #5666 fixed both
  in 6 of 6. A remote caller read a private page's tags in 4 of 4 remote cells
  on v0.59.3.0 and v0.59.11.0, and 0 of 4 from master (#5676) on. Still failing
  on every build: a slug collision stops its source's sync, so files after it
  are never imported; a renamed page loses its inbound link and its old slug;
  on PGLite with a live MCP server, delegated syncs extract 0 or 1 of 8 links,
  and `gbrain extract --stale` was refused in 240 of 240 attempts.

### Leak-free LongMemEval answer re-run (2026-09-29)

With session ids made opaque, gbrain's house reader answered **439/500
(87.8%)**. A GPT-4o reader using LongMemEval's official reading prompt, on
exactly the same retrieved sessions, answered 430/500 (86.0%); paired, that is
21 wins and 30 losses, exact McNemar p = 0.26, so the readers are not
demonstrably different. The run used the reranker off and the notes reader
with 1,024 output tokens, measured on gbrain PR 5676 at `a7cb37b`. That is not
the September 6 configuration, so it does not measure how much the leak
helped.

- **Report: [LongMemEval answers without the answer key](docs/benchmarks/2026-09-29-longmemeval-opaque-qa.md).**
  Strict retrieval on the same rows was 435/470. A 100-question component
  study with the reader and evidence held fixed found that the evidence budget
  matters far more than the prompt. Full retrieved sessions (about 15,800
  input tokens) gave 89/100. The five retrieved chunks alone (about 3,400
  tokens) gave 65/100 with gbrain's reader prompt, 65/100 with a plain prompt
  and 64/100 with `gbrain think`'s prompt; each prompt against gbrain's was
  p = 1.0. The report lists four harness stalls, a machine restart and the
  paid cost (about $59.6).
- Receipts under `docs/benchmarks/2026-09-29-longmemeval-opaque-qa/`: summary,
  per-question table, and rows for all five arms; the official-judge files;
  the full reader and judge prompts (gzip); chunk texts, logs, scripts, and
  provenance with dataset and cache hashes. Twelve manifest entries pin their
  hashes and the counts 439/500, 430/500, 65, 65 and 64 of 100, and 435/470.
- `scripts/verify-longmemeval-opaque-qa.py`, a keyless recount run by
  `bun run validate`. It re-derives every arm's verdict counts, the paired
  tests and the strict recall count, and checks that none of the 1,300 saved
  reader prompts contains `answer_` or a retrieved raw session id.

### Final fix wave on the September 28 audits

- **Relationship retrieval does not help on reworded questions.** A seeded
  paraphrase grammar, committed before scoring, rewords the 145 world-v1
  relationship questions without changing their answers. At gbrain `b80cad6`,
  over three ingestion orders (435 paired runs per wording), relationship
  retrieval fired on 174 template runs and 0 paraphrase runs. Template
  wording: first-place hits 27.6% to 42.8% (72 runs better, 6 worse), recall
  at five 0.737 to 0.763 (18 better, 0 worse, 6 distinct questions).
  Paraphrased: 0.411 recall at five and 4.8% first-place hits in both arms, no
  run changed (audit B-RAB-01, issue #24 finding 6).
  [Report](docs/benchmarks/2026-09-29-relational-paraphrase.md).
- **Cat 6 bare-name mentions: 50/50 linked** by gbrain's by-mention pass (a new
  gazetteer arm), 0/50 by the ordinary links pass. The pure-extractor gates are
  unchanged (250 probes, recall and labeled precision 1.0).
- **Gates that could pass on nothing.** Cat 27 fails when no probe improves; it
  currently passes because one of four probes gains 3.1 points of nDCG@10, and
  every probe's ranking changes (B-27-01). Cat 24's dedup probe requires the
  hash short-circuit itself (status `skipped`, unchanged `updated_at` and chunk
  ids); a forced re-chunk fails it (B-24-01). Cat 32 Part B needs at least one
  candidate the held-out gate blocked; no regression with zero blocks is
  `partial` (B-32-01). Cat 30's `seed-no-brain-first` held-out scores
  retrieval of a generated topic page from a brain Cat 30 imports, instead of
  citations an empty brain could only invent (B-30-01).
- **Unpublishable stub receipts.** Cat 19 and Cat 27 hash-embedding runs are no
  longer publishable (A-22, B-27-01); Cat 29 stub runs report `partial` and no
  longer overwrite a crashed side's zero (B-29-04); perf is unpublishable when
  no threshold was evaluated and counts only successful link writes (C-11).
- **Data integrity.** `validate-data.ts` checks amara-life hashes under the
  generator's scheme (per record for JSONL and calendar entries, per file
  otherwise): 424 of 424 manifest items verify, and a mismatch fails instead
  of warning (C10). `poison.json` is generated from the planted fixtures; the
  five gold stubs with no generator or runnable consumer (`backlinks`,
  `citations`, `entities`, `personalization-rubric`, `qrels`) are removed, and
  a hand-written template row fails validation.
- Smaller audit items: Cat 13 gap localizer withholds its proposal above a 5%
  re-simulation mismatch and reads the committed E0 receipt (A-16); malformed
  `CAT18_MIN_RECALL` / `CAT21_MIN_MRR` throw and overrides are unpublishable
  (A-23); a zero-query Cat 18 cell is invalid (A-24); situation-recall Cat 13b
  over its infra cap is an error (A-25); Cat 13b drops its gateway memo and
  restores `GBRAIN_SOURCE_BOOST` (A-17); Cat 22's presence floor is the seeded
  count minus two (B-22-01); Cat 33 B-pre reports no transfer ratio (B-33-01);
  Cat 30/33 gates need all but one seed scored (B-30-04); Cat 32 `sel_climb`
  compares like splits (B-32-02); Cat 28 isolates `GBRAIN_HOME` and records
  failed-pass latency (B-28-01); Cat 35 leakage leaves judge-failed hits out of
  the denominator, including in the native Cat 35 reconstruction (PC-04); the
  shootout driver reports `partial` (PD-15); `query:validate` rejects unfilled
  scaffold placeholders (PD-17); the skillopt sentinel clears stale partial
  results (B-SH-01); relational-ab `--limit` samples across templates
  (B-RAB-02).
- Cat 6's header said gbrain has no bare-name linking; it does, through the
  by-mention pass. Cat 3 and Cat 4 headers and registry names say they test
  keyword alias lookup and timeline storage, and name the gbrain features they
  leave untested (F3, F4, F5).
- `gold/contradictions.json` is documented as reserved for the planned N2
  category. Both claims appear verbatim in their source text for 9 of 15
  fixtures, which N2 must check first (F6).

### Plan documents

- `docs/plans/2026-09-28-gbrain-10x/` records the approved gbrain 10x plan, its
  outside review and the five September 28 audits (evals correctness, evals
  docs and infrastructure, coverage and categories, gbrain read path, gbrain
  write path). The docs index links them.

### Limits

- Cat 30 to 33 model calls and the Cat 35 dream and facts lanes run inside
  gbrain and still use the provider default temperature. The reading-notes
  reader keeps its published default temperature so that an opaque-id rerun
  changes one variable.
- The reading-notes result stays pending until its opaque-id re-run, and the
  retracted Cat14, Cat 29 and multi-adapter figures stay invalid until paid
  re-runs. A reranker-on LongMemEval answer run needs a Voyage key.
- Receipt v2 cost stays null in paid runners not yet wired to the budget
  ledger (Cats 14, 15, 18, 18b, 20, 21, 25, 26, 29 live, multi-adapter,
  PrecisionMemBench).
- The evaluator separation is still in-process; a product in the same process
  could still read dataset files. The sealed confirmation set is not yet wired
  to the paired comparator.
- On 2026-09-29 gbrain's own `gbrain eval compare` printed a bootstrap
  methodology string without computing a bootstrap
  (`src/commands/eval-compare.ts:243`). gbrain v0.59.18.0 (#5685), included in
  the `608a174` pin, replaced it with a paired cluster bootstrap.
- Cat 34 records a skip in CI because it needs an external gbrain checkout.

## [0.10.0] - 2026-09-25

Taking brief notes before answering helped the tested readers use intact
conversations. On 361 fixed-retrieval questions, the historical Sonnet 4.6
reader rose from 308 to 324 judged correct answers; the separate 500-question
GPT-4o oracle replication found gains with notes in both natural-language and
JSON presentation. This measures answer reading, not retrieval or production
readiness. Nine historical notes answers hit the 512-token output limit, and
source audits exposed grading artifacts.

In a separate release smoke, all nine selected prior cutoff responses ended
naturally at the new 1,024-token limit. That is a completion check, not a
new accuracy measurement, and its $0.562143 spend is outside the study total.

### Added

- A dated standalone report with original public per-question labels, repeat
  controls, regrades, cost aggregates and private-source provenance. It keeps
  the earlier failed excerpt approach identifiable and does not publish
  conversations, prompts or model-generated answers.
- A keyless, fail-closed recount that reproduces every paired score and
  category breakdown, rejects incomplete/mismatched streams, and checks
  aggregate token-priced spend including the earlier failed pilot. No model
  call runs from the report, recount or tests.
- An offline paired-request preparer through the GBrain sanitizer and an
  explicitly opt-in gateway execution lane with a finite spend cap and
  per-attempt accounting. The new lane reports completion and cost; it does
  not claim new answer accuracy without graded responses.

### Changed

- Document the companion GBrain notes-first reader default and direct
  override separately from the immutable historical 512-token study. The
  packaged 1,024-token default is a new setting that needs its own measured
  comparison; this release does not claim its performance was tested here.
- Keep the established `gbrain` pin for historical runners and add a separate
  immutable `gbrain-reader` pin only for the new comparison path. Retain its required
  `postgres@3.4.9` patch at the repository root so Bun's frozen lockfile
  install can resolve the transitive patch from a clean checkout. (September 28, 2026 correction: this patch was never applied, because
  `package.json` did not declare `patchedDependencies`; v0.10.2 declares it.
  The "historical runners" results also came from gbrain `2efaaf8f`, not
  from the `939232f` pin kept here.)
- Restrict CI TypeScript filtering to diagnostics whose path begins with
  `node_modules/`, so a repo-owned error mentioning a dependency path still
  fails instead of disappearing.

### Limits

The public labels and token aggregates support a keyless recount, not
generation of the private historical responses or an independent per-call
audit. The two study phases share questions and differ in dates and reader
models, so they are not independent confirmations.

## [0.9.0] - 2026-09-23

Engineers can now test whether situation cues help retrieve the original notes
needed by an indirectly worded question, and inspect the evidence required to
reject a regression. This release adds the
[evaluation protocol and harness](docs/benchmarks/2026-09-23-situation-recall-protocol.md),
not a measured retrieval gain. No paid comparison or all-category no-regression
result is published here.

### Added

- Cat36 Associative Retrieval: 120 fictional scenario families across five
  domains, with 160 development and 320 holdout probes. Its primary metric
  requires all labeled source spans in the five actual production chunks,
  rather than crediting a correct page with the wrong passage.
- Production cue-build receipts, frozen-index Scene/Horizon read-time
  comparisons, separate Bridge construction, and a real contextual-summary
  control. Deterministic provider stubs remain nonpublishable plumbing checks.
- A complete category inventory and paired release gate covering native metric
  denominators, floors, slices, source identity, execution observations and
  critical case losses. Missing, partial, stale or unsupported cells block release.
- Explicit programmatic category drivers, a native Cat13b pilot, source and
  reminder replays, and separate answer-grounding replays that retain original
  outputs and judge attempts. The LongMemEval secondary check is not official
  answer accuracy.
- OpenRouter development controls with fixed model routes, local request and
  reservation limits, and fsynced, sanitized request/response evidence. A closed
  source-only policy separates construction from embedding-only replay; it is
  preparatory infrastructure, not a new dataset or measured capability result.
  Operator-controlled diagnostics remain nonpublishable and do not claim an
  external provider credit cap.
- A separately registered v2 source-only policy for the v4 source-reference
  formatter. It checks the actual installed formatter's canonical wire content
  without treating internal excerpt metadata as a public request shape. The
  historical v1/v3 contract and all financial and output ceilings remain intact.

### Changed

- Pin the candidate product to `939232f1746381b4e932d620d6c709e29198f14c`
  (gbrain v0.55.0.0), while keeping the historical dependency and fresh baseline
  identities distinct. CI uses supported Bun 1.3.13.
- Retain previously omitted native per-item observations without changing
  benchmark inputs, scoring formulas or published historical artifacts.
- Add opt-in LongMemEval evidence capture and isolated HOME/configuration paths,
  with exact loaded-code, model, source and build identities.

### Fixed

- Keep the existing keyword and identity fixtures readable through current,
  revision-bound projections while preserving their original text and labels.
- Distinguish a valid zero-score judge control from an unavailable judge, and
  update tool-bridge test fixtures for atomic page snapshots without relaxing
  their behavior assertions.
- Preserve malformed or over-budget raw responses and existing LongMemEval
  receipts on rejected capture, score legitimate bounded search misses, and
  verify the product's actual configuration-file resolver.

### Not yet measured

For publishable comparisons, independent corpus and recipe review, real input
catalogs, supported transport and protocol coverage, enforced external provider
allowances, and complete live B/C0/C1 receipts remain prerequisites. The cue
builder's durable cap does not create a whole-cell spending limit. Unattributable
traversal results and other missing evidence remain blocked; hermetic checks do
not prove semantic quality, privacy, reminder precision or release readiness.

## [0.8.0] - 2026-09-09

Engineers can now choose a retrieval configuration by the questions they need to
answer. The rewritten guides explain word search, vectors, relationships, and
ranking through concrete cases. The [retrieval refresh](docs/benchmarks/2026-09-09-retrieval-refresh.md)
publishes all eleven planned experiment cells, including losses and the settings
that produced them.

### Added

- Three reading paths: [understand retrieval](docs/retrieval-lessons.md),
  [choose settings](docs/settings.md), and [inspect the research](docs/README.md).
- A controlled production relationship comparison with shared indexes and query
  vectors. It improved recall on 15 of 145 questions in each of three ingestion
  orders, with no recall losses; attendance questions did not improve.
- Complete concept, source-preference, baseline, and PrecisionMemBench results,
  with per-question rankings, paired comparisons, charts, and API accounting.
  Recorded usage estimates total $0.7133 before credits, within the $1,000 ceiling.
- Reproduction and verification scripts, explicit configuration records, and
  regression tests for result order, failed features, shared evidence, and spending limits.

### Changed

- Rewrote all 42 authored documents, including 18 historical reports, in plain
  English. Preserved benchmark inputs, generated evidence, tested prompts,
  historical measurements, and the gbrain dependency pin.
- Separated finding evidence from answering correctly. The September 6
  LongMemEval records support recounting retrieval and saved judgments; omitted
  answer text prevents independent re-judging.
- Dated external comparisons, corrected stale configuration and cache guidance,
  and linked adoption recommendations to their workloads and evidence.

### Fixed

- Hybrid adapters preserve gbrain's final order and keep the first occurrence
  of each page, so they no longer undo reranking or deliberate relationship placement.
- Failed searches produce valid diagnostic receipts. Offline publication checks
  reject incomplete relationship comparisons and can follow saved report paths
  after the repository moves to another checkout.

## [0.7.0] - 2026-09-06

The [ranking experiment](docs/benchmarks/2026-09-06-longmemeval-ranker-wave.md) showed that preserving additional evidence helped multi-part conversation questions. The release default reached **95.53% strict recall_all@5 (449/470)**, compared with **80.64%** for the previous default. The result-cutoff step had been dropping a second required session.

The first judged answer-quality run scored **86.6% (433/500)**. That is a different measure from finding the evidence, and this release made no cross-system answer-quality claim.

Two other changes addressed specific ranking failures: the metadata boost gate improved Cat13 held-out nDCG@5 from **53.0 to 57.8**, and preserving graph-derived relational results through reranking improved NamedThingBench hit@1 from **3/39 to 21/39**. Expansion-weight budgeting and keyword-arm confidence did not satisfy their decision rules and did not become defaults.

### Evidence and configuration

- Added compacted per-question results for eight LongMemEval arms and the judged run, cutoff replays, miss diagnostics, Cat13 E0/E2/E3 results, NamedThingBench R1 results, aggregate JSON and two SVG charts.
- Added a converter from the gbrain harness's NDJSON into the chart runner's `RunnerOutput` format.
- Updated both dependency files to the ranking release. The installed pin became merge commit `2efaaf8f`, gbrain v0.48.4.0. Updating only `package.json` had previously left frozen installation broken and local runs on v0.48.2.0.
- Cat13 receipts now identify the resolved `balanced` bundle and explicit overrides. They expose whether two nominally similar runs inherited different defaults.
- E1 localization and Cat27 graph-signal comparisons explicitly select `search.metadata_boost_gate=always` when testing the old, ungated behavior. The E1 live result records `gate_always` so its replay can be checked.

### Cat13 runner improvements

All adapters now use the selected embedding model and dimensions. Flags override `CAT13_EMBEDDING_MODEL` and `CAT13_EMBED_DIMS`; defaults remain `openai:text-embedding-3-large` at 1536 dimensions. Receipts record the gateway state after each adapter initializes, and mismatched settings invalidate the run.

The gbrain-backed adapters accept explicit reranker and autocut flags, both off by default in this runner. Reranker-on selects `voyage:rerank-2.5`, requires a Voyage key, rejects fake embeddings, and must produce observed reranker scores. Expansion budgeting, keyword-arm confidence and generic `--search-pin KEY=VALUE` support controlled comparisons. Unknown CLI flags are rejected.

The concept split defaults to 20 tuning concepts and 10 held-out concepts, seed 42. Scores and per-template results are reported separately; questions spanning both sets stay in the overall result but not either subset. See the [Cat13 recipe](eval/runner/README-cat13-phase-e0.md).

### Test reliability

A process-global embedding transport could be reset by another test, causing a supposedly hermetic run to call a live provider. The runner now reinstalls its transport and verifies it before ingestion and queries.

PGLite's roughly 1 GB WASM allocation also delayed garbage collection. Tests accumulated 1–2 GB of temporary objects and more than 50,000 memory mappings, approaching the default kernel limit of 65,530. Collection is paced every 40 imported pages, every 25 queries and after teardown. Full-suite peak mappings fell from about 55,000 to 16,000 without changing assertions.

## [0.6.1] - 2026-09-02

A fresh [LongMemEval-S comparison](docs/benchmarks/2026-05-07-longmemeval-s.md) measured gbrain v0.48.2.0 on the cleaned September 2025 dataset. Each arm scored 470 answerable questions at k=5 in one run, with zero errors.

| Arm | Strict recall_all@5 | Questions |
|---|---|---|
| Hybrid | 93.19% | 438/470 |
| Hybrid with reranking | 95.32% | 448/470 |
| Hybrid with session diversity | 93.40% | 439/470 |
| Session diversity plus reranking | 95.53% | 449/470 |
| Hybrid with query expansion | 54.89% | 258/470 |

The reranker gained 18 questions and lost 8 compared with hybrid. Its any-hit score was 99.79%. Temporal-reasoning recall rose from 84.3% to 89.8% (107 to 114 of 127), the knowledge-update and three single-session types reached 100%, and multi-session recall stayed at 92.6% (112/121).

Session diversity added one question without reranking. Expansion lost 183 and gained 3; its earlier v0.48.0.0 measurement was 49.6%. More alternative phrasings did not help at this five-result limit.

### Reproducibility and comparisons

The dependency moved to `5cfb84f1`, the v0.48.2.0 PR #4792 head, pending its merge pin. Reranker specifications explicitly selected `voyage:rerank-2.5` and derived the required `VOYAGE_API_KEY` from that model choice.

The 93.19% hybrid result matched the v0.48.0.0 receipt and could be compared with the May 83.40% result. A pre-fix run at `2a56b512` recorded 51.39%. All five arms and the pre-fix stream were committed with artifact hashes, an aggregate and regenerated charts.

The charts separated strict recall from any-hit and answer accuracy. Their contextual comparisons used our recomputation of MemPalace's strict scores, 85.7% raw and 90.0% with LLM reranking, and ContextFit's self-reported 87.45% with its label-leakage qualification.

### Compatibility fixes

- Reconciled `package.json`, previously 0.5.1, with `VERSION` at 0.6.1.
- Updated graph traversal contract tests for gbrain #4704's bidirectional `GraphPath[]` result shape. Tests retained the depth-10 cap, explicit depth and depth-2 default checks.
- Cat15 reads `PROPOSE_TAKES_PROMPT_VERSION` from gbrain instead of a stale literal. The prompt text also changed in gbrain #4736, so the old Cat15 F1 result required a live remeasurement.

## [0.6.0] - 2026-09-01

Outside reviews #26 and #24 prompted stronger links between claims and saved results. The review's sub-claim about PR #13 containing benchmark figures was refuted.

### Saved evidence

- Committed the May LongMemEval stream: 2,696 rows, hash `a26453…3d0b`. An offline regression test recalculates all four adapters' summaries and per-type results. The previously referenced but missing NDJSON validator was added.
- Added `docs/receipts-manifest.json`, which maps selected claims to artifact hashes and expected values or explicit gaps. The declared gaps were SkillOpt, relational recall and the stability snapshot.
- Committed the June Cat34 originals and a dated offline rerun at `2a56b512`: know-to-ask failures 0/149 and push recall 0.9063 / 1.000 / 0.5521. The report disclosed that it relies on counters reported by the system under test and preserved historical charts.
- Cat35 receipts began recording server-reported model IDs and call counts. Cross-run deltas require matching resolved models; `claude-sonnet-4-6` remained a movable alias rather than a dated snapshot.

### Session-level diagnostics

The May top-five chunk lists averaged 2.68 distinct sessions, with 99.6% containing fewer than five distinct sessions. This motivated explicit session-diversity adapters, including expansion and reranker variants. It did not itself prove diversity would improve accuracy. Existing adapters retained their behavior, rows gained a `run_config_hash`, and aggregation rejected mixed configurations.

### Clearer claims

The comparison guide identified MemPalace's 96.6% as any-hit recall and labeled the then-quoted 97.66% gbrain comparison accordingly. ContextFit's 84.3% token-plus-certificates and 87.45% fused strict scores were separated from gbrain's May 83.40% / 84.26%. LETHE, Memoria, Mem0 and a PrecisionMemBench comparison were added with sources.

PrecisionMemBench's 0.582 became an explicitly qualified upper bound and the default was corrected to 0.075. Cat35's “zero junk leakage” became 1.2% (1/86), Cat34's 0.552 Codex integration result was included, and the historical relational 97.9% / 49.1% result gained a pre-audit qualification.

CI stopped swallowing typechecker crashes. Phase 2 smoke arguments were changed to an array.

## [0.5.1] - 2026-08-31

The May LongMemEval scoring error was corrected at $0 by rescoring the saved output. The same returned and expected sessions produced:

| Adapter | Strict recall_all@5 |
|---|---|
| Keyword | 10.64% |
| Vector | 79.36% |
| Hybrid | 83.40% |
| Hybrid with expansion | 84.26% |

There were 470 scored questions; 30 abstention questions were excluded. Hybrid multi-session recall was 71.9% and temporal-reasoning recall 69.3%. Knowledge-update also lost credit on one question requiring multiple sessions.

The old score reconciled exactly: 459 answerable any-hits plus 29 abstention any-hits gave 488/500 = 97.60%. All 500 reference answer sets matched the dataset, there were no error rows, and 696 resume duplicates were removed with successful rows preferred. Saved summaries are `rescore-may-2026-08-31.json` and its generated Markdown companion.

Under strict scoring, expansion added four questions, or 0.85 percentage points overall, and 3.9 points on temporal reasoning. The earlier “no effect” conclusion came from an almost saturated any-hit metric.

Reproduction examples were corrected: `--path` takes the file path, `--dataset` the split name, and the runner defaults to k=8. A published k=5 comparison must select it explicitly. A fresh run of newer gbrain code remained separate work at this release.

## [0.5.0] - 2026-08-31

**Scoring definitions changed. Earlier scores cannot be compared directly with post-audit runs.** The [audit](docs/audit/2026-08-31-eval-audit.md) verified 237 findings and drove these changes:

- Recall counts unique IDs; precision@k divides by k. LongMemEval uses all-required-session recall. Model judges must return every required criterion at temperature 0.
- Common receipts distinguish success, failure, skip and error origin. The category runner reads receipts instead of interpreting every zero exit as success. System failures remain scored misses; excessive harness failures invalidate a run at the stated greater-than-10% limit.
- Fixed Cat13/Cat13b gateway setup, asynchronous link extraction, LongMemEval imports and 17 runners' version stamps. The gbrain dependency and lockfile were pinned.
- About 12 tests that could not previously fail gained reachable failure conditions, feature boundaries and negative controls. Judges were blinded where needed. Unintended reranking was removed from embedder comparisons.
- Repaired source-data references, an overwritten synthetic deal page and the q11 answer label with a recorded rationale. Baseline latency capture became serial; the old concurrent measurements were about ten times too high.
- Added offline CI checks for types, tests, data integrity, selected end-to-end runners and the qrels/baseline comparison.
- SkillOpt held-out tasks gained different, stricter judging criteria. Earlier held-out scores tested topic transfer but reused training criteria.
- Wrapper scripts now propagate failed categories. The LongMemEval batch script respects the dataset and its size. Shootout scripts check each cell, and Phase 1 has a wall-clock limit. The prior environment-expansion bug had silently killed four of seven cells.

Releases 0.3.0 and 0.4.0 landed during remediation. The final pin was v0.47.8.0 (`2a56b512`), six commits after the audited v0.47.6.0 code. The remediated suite was rechecked against it.

## [0.4.0] - 2026-08-31

The [Cat35 report](docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill.md) added before-and-after runs around gbrain's write-path fixes in [PR #4742](https://github.com/garrytan/gbrain/pull/4742). They used the same corpus, judge model and prompt version.

Dream-lane retention reached **88.1%**, with a 95% interval of **82.0–93.5**, compared with 61.5% in the original publication and 70.2% immediately before the change. All 20 expected sessions produced pages, up from 16. The four recovered sessions used verified quoted segments despite falling below the ordinary triage threshold; routine controls did not trigger the rescue.

Quote fidelity reached 82.7% from 45.4%, claim hallucination fell to 7.0% from 14.1%, and facts-lane recall reached 64.8%. Adding an idea category improved idea recall from 38.3% to 50.0%. Both new receipts were preserved alongside the original, with qualifications about single-run judge variation, changed quote denominators and a distractor judgment changing.

The [Cat34 update](docs/benchmarks/2026-06-12-brainbench-memory.md) recorded know-to-ask failure falling from 0.150 to 0.000 on all three integrations after gbrain v0.46.15.0. False fires were 0.000, push recall 0.906 / 1.000 / 0.552, and precision 1.000.

The dependency advanced to `2a56b512`, v0.47.8.0. The PGLite teardown freeze no longer reproduced there; six skipped test teardowns were restored after watchdog-protected verification.

## [0.3.0] - 2026-08-27

Added Cat35 to measure what survives when a working conversation becomes memory: facts, ideas, decisions, entities and emotional context.

The [first publication](docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill.md) measured **61.5% retained content** (95% interval 45.0–77.6), 85% usability, zero distractor leakage and 14.1% hallucinated claims. The verbatim control measured 93.1% judged coverage, 100% leakage after the case-insensitive correction, and 0% usability. Emotional-context recall was 71.4% versus 52.5% for facts; the separate facts extractor scored 69% on facts and 38% on ideas.

The committed corpus contains 24 fictional sessions, six scenarios, 173 important content units with verbatim anchors, 86 distractors and two attribution hazards. Its skeleton is deterministic; its prose came from cached Opus generation.

The runner defaults to a small paid setup check, historically about $0.10. The full package command selects `CAT35_FULL` and performs a cost preflight. Receipts include comparison deltas, triage thresholds and a judge-calibration scaffold.

Review added case-insensitive anchor checks, full-corpus publication requirements, evidence-backed judge verdicts, explicit judge-failure handling and transcript hash validation. The leakage correction changed the verbatim floor from 96.5% to 100%; dream remained 0%.

The dependency was pinned to gbrain v0.46.3.0, installation gained the PGLite path repair, and category-runner/tool-bridge tests were fixed. The Bun teardown freeze was temporarily worked around and tracked upstream.

## [0.2.0] - 2026-05-29

Integrated [PrecisionMemBench](https://github.com/tenurehq/precisionmembench), using tenurehq's MIT fixtures and scorer at `c9689ca`. The test separates how much relevant material search returns from whether a later model writes a good answer.

The initial default hybrid score was reported as **0.076 precision**, with recall 0.99. Returning many pages made recall high but precision low. Later documentation reconciled the default to its saved value, 0.0752.

That experiment led to optional adaptive result limits. The historical tight setting scored **0.582 precision, 29 active passes and 44/77 overall cases**, compared with the cited supermemory row of 0.43 and 17 active passes at roughly three times the latency. These comparisons describe that recorded setup; subsequent adapter corrections required remeasurement.

A proposed score-gap detector did not separate right from wrong first results: the rank-one/rank-two gap was 0.60 for correct results and 0.57 for incorrect ones. Restricting result count accounted for the useful improvement in this experiment.

The report distinguished the 35-belief lexical corpus, harness-computed structural cases and the think adapter's citation-based view from ordinary search. Adaptive behavior stayed off by default pending a recall comparison. The then-promoted LongMemEval 97.60% number used the old any-hit metric; release 0.5.1 later corrected its interpretation.

Added the external fixtures, scorer, adapters, seed code, attribution, four-mode runner, instrumentation and tests. The adaptive option initially needed a local unreleased gbrain checkout.

Saved JSONs were added for the tight result and ordinary settings. One shipped-default adaptive row was reconciled to its actual run: 0.16 precision, one active pass and 8/77 cases. The scorer's type import was corrected to its local layout, the gold-schema test excluded unrelated subset files, and the fictional v0.41-launch baseline/qrels work was included.

## [0.1.0] - prior

Initial BrainBench included world-v1 and amara-life-v1, the 12-category catalog, LongMemEval-S integration and the v0.40.6.0 snapshot. Its historical 97.60% LongMemEval figure was compared with MemPalace's 96.6% raw figure; subsequent releases clarified the metric and comparison limits. See the dated reports for the original experiments.
