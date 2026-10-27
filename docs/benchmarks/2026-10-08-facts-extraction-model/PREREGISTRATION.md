# Preregistration: a cheaper default model for background fact extraction

Written 2026-10-08 (Pacific) before any counted cell ran. Thread GBRA-60, plan item R2 of the 10x wave plan (gbrain-evals `docs/plans/2026-10-07-10x-memory-advantage/PLAN.md`, section 4, wave 0). The receipts of every counted run record this file's SHA-256; any later edit is a new preregistration and is listed under "Amendments" below with its reason, before the cells it affects.

## The decision this run informs

gbrain saves facts from every page an agent writes, in a background job (`facts-absorb`). With an Anthropic key present, that job calls `anthropic:claude-sonnet-4-6` unless the user sets `facts.extraction_model` (gbrain `src/core/facts/extract.ts:60-72` asks for the `reasoning` tier; `src/core/model-config.ts:91-95` maps that tier to Sonnet 4.6 for an Anthropic-keyed install, and the walk in `resolveTierDefault` picks the first provider with a key). P8 measured that extraction at $9.94 per 1,000 pages against $0.32 with it off.

The maintainer's decision 2 at the plan's approval gate (2026-10-08): switch the default extraction model to a current cheap model if this facts-absorb quality gate passes before the Q1 scoreboard freezes `gbrain-defaults` (Oct 13 to 15); otherwise keep the default and publish both cost rows.

## Arms

All arms run gbrain master `1935c74a9e217b276c7bbf3075ddd3c220e96a09` (v0.60.110.0), copied with `prepareBuild` and identity-checked, on fresh PGLite brains with `openai:text-embedding-3-large` embeddings.

| Arm | Setting | Role |
|---|---|---|
| `sonnet46` | `facts.extraction_model` unset (the shipped default; the receipt must show `anthropic:claude-sonnet-4-6` at the facts invocation) | baseline |
| `luna` | `openai:gpt-6-luna` | candidate |
| `haiku55` | `anthropic:claude-haiku-5-5` | candidate |
| `disabled` | `facts.extraction_enabled false` | mutant, must fail |
| `drop` | `openai:gpt-6-luna`, and the metering proxy replaces every chat response's output with `{"facts":[]}` after metering | mutant, must fail |

Candidates are the newest cheap model of each family on 2026-10-08: OpenAI's model list names `gpt-6-luna` as its model for "cost-sensitive, high-volume workloads" ($0.10 / $0.50 per 1M tokens), and Anthropic's lists Claude Haiku 5.5 ($0.10 / $0.50 per 1M tokens up to 100,000-token prompts). No newer cheap model of either family exists on that date. Sonnet 4.6 is an older generation under the project's model rules; it runs because it is the shipped default being replaced, the one link the rules allow. Each model runs with gbrain's own request settings (no reasoning or temperature override); the receipt records the resolved model gbrain's call ledger (`GBRAIN_AI_CALL_LOG`) saw at each facts-absorb call.

## Path under test

Each arm is a fresh brain behind `gbrain serve` (stdio MCP). The agent writes every page with `put_page`; the write queues the real `facts-absorb` job (the managed persistence outbox), which `gbrain jobs work --concurrency 4` drains after the session closes (PGLite cannot host a worker beside `serve`). After every gbrain process has exited, a fresh process reads every stored fact, every job row and the `ingest_log` failure rows. A seeded sample of 30 recalled claims is also read through `gbrain call recall {grep}` (the trusted local CLI) in a new process, to confirm the operation surface returns the same facts. None of N1's hermetic ledger writes or takes-bootstrap's `extractTakesFromPages` is involved.

## Corpus (development data only, nothing sealed)

1. **Facts-absorb world**, `eval/generators/facts-absorb-gen.ts` (`facts-absorb-gen@1`), seeds 60 and 61, fingerprints `2b3735ab…` and `016811f4…`. It follows the N1 knowledge-update ledger (fictional people and companies whose city, employer and metrics change over time) and renders it as dated chat sessions written as `note` pages: 170 pages, 529 planted claims (328 user statements, 64 assistant recommendations, 41 relayed third-party claims, 64 in-turn self-corrections, 32 corrections of an earlier session's amount), 64 rejected assistant suggestions and 86 low-notability asides, with long assistant replies around them. No model wrote it.
2. **Natural-prose stratum**, the Cat 35 corpus `eval/data/transcript-distill-v1` (committed, development, written by Claude Opus 4.5): the 20 transcripts that carry planted items, 173 items, each written as one `note` page.

## Metrics

Facts-absorb world, scored without a model (`eval/runner/facts-absorb/score.ts`). A fact belongs to the page its `context` names and matches a claim on that page when it names the claim's entity (text or entity slug) and carries its value (text, or the typed `claim_value` for amounts). Expired facts are excluded.

- **Recall**: planted claims matched by at least one stored fact / planted claims.
- **Precision**: supported facts / (supported + wrong). Wrong means a fact restates a retracted value as current, states a rejected suggestion as fact, gives the assistant's advice as the user's, or pairs a named entity with a world value no claim on its page gives that entity. Facts that name no world value are `unmatched`, reported with their rate and audited by hand, and excluded from precision.
- **Attribution**: correct cases / cases. Cases are each recalled assistant recommendation (every matching fact attributed to the assistant: `attributed_to = assistant` or "assistant" in the text), each recalled third-party claim (every matching fact keeps the third party's name), and each rejected suggestion (no fact states it as fact unless it says the assistant suggested it or that it was declined).
- **Correction handling**: correct cases / cases, over self-corrections and later-session amount corrections; correct when the corrected value is recalled and no fact on the page restates the retracted value as current.
- **Parse failures**: facts-absorb jobs whose result or error names `malformed_output`, `parse_failure`, `truncated_output` or `non_terminal_stop`. **Unhandled** means such a job completed with no `ingest_log` failure row (the output was consumed silently).
- **Readable after restart**: fact ids the jobs reported inserted that the fresh process cannot read.

Natural-prose stratum: the Cat 35 coverage judge (`scoreSalienceCoverage`, prompt `2026-09-28-v2`) labels each planted item FULL, PARTIAL or ABSENT against the page's stored facts, rendered as `- [kind] fact` lines. Judge: `openai:gpt-6.1-sol` through the Cat 35 OpenAI shim (reasoning effort low). It is a counted reader under the model rules and a different family from one candidate; the current Anthropic Sonnet and Opus models reject the forced tool choice the Cat 35 judge uses (observed in the setup check). Covered = (FULL + PARTIAL) / items.

## Decision rule

Intervals are paired 95% percentile bootstraps over pages (4,000 resamples, seeded), candidate minus baseline.

A candidate **passes** only if all of these hold:

1. Recall non-inferior: the interval's lower bound is above −5.0 points.
2. Precision non-inferior: the interval's lower bound is above −5.0 points.
3. Attribution no worse: the point difference is at least −2.0 points and the interval does not lie wholly below zero.
4. Correction handling no worse: the same test as 3.
5. Zero unhandled parse failures.
6. Every facts-absorb call resolved to the requested model (`gpt-6-luna` or `claude-haiku-5-5`), and the baseline's to `claude-sonnet-4-6`.
7. Every inserted fact readable after the restart, and every facts-absorb job completed.
8. Natural-prose harm check: covered items no more than 10.0 points below the baseline (point difference), with judge failures at most 5% of items in either arm. With 173 items in 20 transcripts this stratum cannot resolve a 5-point margin, so it can only block, not confirm.

The gate is **valid** only if both mutants fail it. "No worse" carries a 2-point tolerance because a zero tolerance on about 100 to 170 cases would fail an identical model about half the time.

If both candidates pass, the gbrain default becomes key-aware: an install whose extraction would resolve through Anthropic gets `claude-haiku-5-5`, one that resolves through OpenAI gets `gpt-6-luna`. If one passes, only installs on that provider change and the other keeps today's default. If none passes, gbrain is unchanged (option (a)) and both cost rows are published. An explicit `facts.extraction_model`, `models.tier.reasoning` or `models.default` setting keeps winning in every case.

A ceiling (every arm at or above 98% on recall and precision) is reported as a ceiling: the rule still decides, and the report says the templated stratum could not show a difference there.

## Regression checks

- N1 knowledge update keeps 388/388 with 0 stale on any prepared gbrain change (keyless lifecycle run).
- takes-bootstrap per-kind precision: rerun keyless (`rescore`) on the committed predictions; any prepared change must not touch the takes pipeline's model resolution.

## Write-cost rows

Separately from the gate, `eval/runner/p8-write-cost.ts` runs P8's protocol (the first 1,000 distinct LongMemEval-S sessions written as `note` pages through `gbrain serve`, one `remember` per page, the background queue drained) on the same build with arms `off`, `on` (default Sonnet 4.6), `on:openai:gpt-6-luna` and `on:anthropic:claude-haiku-5-5`. Dollars come from the metering proxy at the budget ledger's list prices and are reported per 1,000 pages, beside the comparators' per-1,000-session costs from the open-source shootout, with both units named.

## Budget

All spending is reserved in one budget ledger with a $40 program cap (R2's cap). Expected: the gate about $6 (Sonnet 4.6 about $3, the judge about $2, the cheap arms and mutants under $1), the cost rows about $13.

## Amendments

Everything above this heading is the text whose SHA-256 (`8f9be0d9…`) the counted receipts record. The amendments below were written on 2026-10-08 after the counted gate run, once its scores were visible. They change the scorer, not the arms, the corpus or the decision rule. The verdict of record stays the preregistered one; the amended scores are reported beside it as a secondary analysis.

1. **Accents and singular forms match** (scorer defect). The models wrote "Setúbal" and "Évora" for the world's "Setubal" and "Evora", and "a peanut allergy" for "peanuts", which the matcher counted as misses. Folding accents and accepting the singular moved Sonnet 4.6's recall from 97.5% to 98.1% and changed no verdict.
2. **A claim an earlier page already stated counts as recalled through that page's fact** (harness defect). Seeds 60 and 61 share their people, hobbies, allergies and venues, and both run in one brain, so gbrain's deduplication correctly keeps one copy of a repeated fact. Every remaining miss in all three arms was on a seed-61 page for this reason (and on the one page Sonnet 4.6's extraction failed to parse).
3. **The user's own reply about a recommendation is not an attribution error** (scorer defect). After the assistant recommends a venue, the user says "Okay, I will look into it", and the models correctly save "User will look into Villa Serra". The preregistered scorer required every fact naming the venue to be the assistant's, so it counted those true user facts as misattributions: 12 of Sonnet 4.6's 14 attribution failures, all 25 of gpt-6-luna's and all 17 of Claude Haiku 5.5's. Amended: correct when a fact gives the recommendation to the assistant and no fact presents it as the user's own choice ("decided", "booked", "will use" without a hedge such as "look into").
4. **The sample read-back looked up claims by id only** (harness defect, diagnostic only). Claim ids repeat across seeds, so half the `gbrain call recall {grep}` checks searched for the wrong claim's value. Looked up by id and page (`--reread`, no model calls), every sampled claim's facts came back: 24 of 24, 25 of 25 and 20 of 20.
