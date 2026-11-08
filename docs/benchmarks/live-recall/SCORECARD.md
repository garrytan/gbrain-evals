# Live recall: scorecard format (live-recall-scorecard/v1)

A live-recall run writes `scorecard.json` and renders `scorecard.md` from it. They are the only run outputs that
leave the box that holds the brain. Both carry aggregates only: counts, rates, intervals and paired deltas, never a
question, a slug, a chunk id or a per-question row. The method behind the numbers is in
[PREREGISTRATION.md](PREREGISTRATION.md); how to produce one is in [RUN-KIT.md](RUN-KIT.md).

## How custody is enforced

`eval/runner/live-recall/scorecard.ts` checks the JSON before anything is written, and refuses with
`LR_CUSTODY_LEAK` (naming only the field path) if any check fails:

1. **Structure.** Every key is one the format defines (gbrain's degraded-stage names and the guard's verbs are allowed
   as keys in their two count maps). Every string is an allowlisted word (arm, type, form, status, comparison id,
   barrier, mode and so on) or matches a fixed shape: an ISO timestamp, a hex commit or a version number anywhere, a
   `provider:model` id (the model part may carry `/`, `_`, `.`, `:` and capitals, as Ollama and OpenRouter ids
   do) only at `run.reranker_model` and `run.embedding_model`, and a lower-case column name only at
   `run.embedding_column`. Every number is finite. A question form or slug has no field it could land in.
2. **Needle scan.** The JSON and the Markdown are searched for every question form, gold slug and retrieved slug of the
   run. Distinctive needles are scanned (a space, slash or digit, or at least 12 characters); a short single word
   cannot be told apart from the format's own vocabulary, nor can a needle that is itself one of the format's words, and
   a bare date, version or hex string (a daily page's slug, say) cannot be told apart from the run's own timestamps and
   commits. The structure check already keeps all of these out.

The Markdown is rendered from the validated JSON alone. The per-query detail behind the aggregates
(`detail.local.jsonl`, pointers only) stays on the box.

## scorecard.json

Top level: `schema` (`"live-recall-scorecard/v1"`), `protocol` (`batch1` or `batch2`: from `freeze.json` on a
counted run, from `--protocol` on the fixture, and `batch1` when neither names one), `run`, `custody`, `questions`,
`eligibility`, `arms`, `comparisons`.

**`run`**: what ran. `started_at`, `finished_at`; `runner_commit` and `runner_dirty` (gbrain-evals); the declared
pin (`gbrain_pin_version`, `gbrain_pin_commit`) and what was loaded (`gbrain_loaded_version`,
`gbrain_loaded_commit`, `gbrain_overlay`); `schema_version` of the brain; `engine` (`postgres`, or `pglite` for
the fixture); `barrier` (`copy`, `standby` or `no_write_privilege`) and `connection` (`direct_or_local`,
`session_pooler`, `transaction_pooler_rewritten`, or `in_process`); the brain's `search_mode`, `reranker_enabled`,
`reranker_model`, `embedding_model`, `embedding_column` (the column `hybridSearch` and the `vector` arm search;
`unknown` when its name is not a plain column name) and `mode_expansion` (the mode's own expansion default; every arm
runs with expansion off); `control` (true for the hash-embedding fixture, whose numbers say nothing about search quality);
`pgvector_version` (the pgvector extension version in the database searched, for every barrier); and, on a copy,
`source_pgvector`, `source_server_version_num`, `copy_server_version_num` and `restore_errors`, read from the row
`snapshot.sh` writes into the marker table (the copy runs the container image's pgvector, which can differ from the
source's). Versions are `null` unless they are plain version numbers; `pgvector_version` is `null` when unknown, and the
four copy fields are `null` when unknown or not a copy.

**`custody`**: `readonly_verified_start` and `readonly_verified_end` (the session reported
`default_transaction_read_only = on` and gbrain's direct pool was off, before the first search and after the last),
and `guard_refusals` by verb (for example `telemetry_write`, gbrain's per-query counters, which the guard refuses).

**`questions`**: `loaded`, `gold_missing` (dropped because a gold page was absent), `by_type` counts,
`gold_found_by` counts, `paraphrase_shares_identifier_token` (the share of paraphrases that still contain an
identifier-like token from their exact form) and `freeze_sha_prefix` (the first 12 hex characters of the question
file's sha256, to match against the freeze).

**`eligibility`**: `eligible_question_forms`, `exclusions` (`<arm>_<status>` counts for the first failing arm of
each excluded form), `invalid_arms` (`rerank_fail_open_over_cap`, `embedding_opted_out`) and `common_arms`.

**`arms`**: one entry per arm (`keyword`, `vector`, `hybrid_lexical`, `hybrid`, `configured`,
`configured_window`), either `{"invalid": <reason>}` or `overall` and `by_type.<type>`, each split into `all`
(both forms pooled), `exact` and `paraphrase`. Each cell holds:

| Field | Meaning |
|---|---|
| `n` | question forms in the cell |
| `success_at.k1` ... `k20` | `hits`, `n`, `rate`, `ci95` and `interval` (`wilson` for one form, `cluster_bootstrap` over questions when forms are pooled) for "a gold page is in the first k pages" |
| `mrr` | `mean`, `ci95` (cluster bootstrap), `n` |
| `recall_all_at` | as `success_at`, for forms with more than one gold page: every gold page in the first k; `null` when none |
| `chunk_success_at` | as `success_at` at chunk grain, where chunk gold was given; `null` when none |
| `mean_pages_returned` | distinct pages per query, capped at 20 |
| `harness_latency_ms` | `p50`, `p95` on the local copy, not production latency |
| `model_calls` | calls by kind (`embedding`, `rerank`, and any refused kind) |
| `degraded_stages` | how many queries gbrain marked with each degraded stage |

**`comparisons`**: one row per comparison and metric (`success_at_5` and `mrr`), in the preregistration's order:
`id`, `metric`, `a`, `b`, `form` (`all`, `exact`, `paraphrase` or `exact_vs_paraphrase` with `arm`),
`n_pairs`, `n_clusters`, `mean_a`, `mean_b`, `delta` (B minus A), `ci95`, `p_two_sided` and `p_method` (cluster
sign flip), `mcnemar` (exact, when there is one pair per question), `mde` (the minimum detectable difference at this
n), `primary` (`P1`, `P2` or `null`) and, on the two primary success@5 rows, `p_holm`. Under `batch1` the primaries are
`p1_hybrid_vs_hybrid_lexical` (both forms) and `p2_configured_vs_hybrid_lexical_paraphrase`. Under `batch2` they are
`p1_hybrid_vs_hybrid_lexical_paraphrase` and `p2_configured_vs_hybrid_lexical_paraphrase`, and batch 1's both-forms
contrast is the secondary `batch1_p1_hybrid_vs_hybrid_lexical`. Under both, the keyword contrasts
(`hybrid_lexical_vs_keyword`, `hybrid_vs_keyword`, `configured_vs_keyword_paraphrase` and the rest) are descriptive.
A comparison whose arm is invalid or absent is `{"id": ..., "skipped": "arm_invalid_or_absent"}`; a skipped primary
still counts in the Holm family of two, as p = 1.

Rates, deltas and intervals are fractions rounded to four decimals; the Markdown shows them as percentages.

## scorecard.md

A header naming the gbrain version and commit, schema, engine, barrier, pgvector version and mode (with a control
warning for the fixture, and a warning that vector search on the copy may differ from the live brain when the source's
pgvector differs from the copy's or the restore reported errors); a line naming the protocol and its two primary comparisons; a table of every arm on all question forms (success@1, 5, 10, 20, MRR, pages returned); success@5 by type and
form; every paired comparison with its interval, p, Holm p and MDE; and a custody paragraph (read-only checks, guard
refusals, exclusions).

## compare.json (live-recall-compare/v1)

`run.ts compare --a <run dir> --b <run dir>` reads two runs' `scorecard.json` and detail files on the box. It refuses
with `LR_FREEZE_MISMATCH` when the runs used different question files and with `LR_COMPARE_CONTROL` when either is a
fixture control. `run_a` and `run_b` carry each run's `gbrain_loaded_version`, `gbrain_loaded_commit`, `barrier`,
`control` and `freeze_sha_prefix`, so a swapped pair shows. It pairs the runs per arm and form (`all`, `exact`,
`paraphrase`) on question forms that are `ok` in both. An arm invalid in either run's scorecard (a configured arm past
its fail-open cap, say) is not paired: each of its rows is `{"id": ..., "skipped": "arm_invalid_or_absent"}`. Each row has the comparison fields above
with `a: "run_a"`, `b: "run_b"`, `id` `run_b_vs_run_a_<arm>_<form>`, and `top5_changed` (how many forms' first
five pages differ). It passes the same structural check.

## pool.json (live-recall-pool/v1)

`run.ts pool --a <run dir> --b <run dir>` scores two counted runs on different question files (batch 1 and batch 2) as
one set, for the batch 2 amendment's pooled secondary. It reads both runs' `scorecard.json` and detail files on the
box and opens no database. It refuses with `LR_POOL_MISMATCH` when the runs share a question file or differ in
`gbrain_loaded_commit`, `search_mode`, `reranker_enabled`, `reranker_model`, `embedding_model` or
`embedding_column`, and with `LR_COMPARE_CONTROL` when either is a fixture control. It holds `schema`, then
`eligibility`, `arms` and `comparisons` as in `scorecard.json`, over the pooled question forms with `batch2`'s
comparison list, then `run_a` and `run_b` as in `compare.json`. Every comparison has `primary: null` and no
`p_holm`, because the pooled analysis is secondary. An arm invalid in either run is
`{"invalid": "invalid_in_one_run"}` and its comparisons are skipped. It passes the same structural check.

## Phase 2 task scorecard (live-recall-task-scorecard/v1)

`tasks.ts run` (and `tasks.ts score <run dir>`, which rebuilds it from the run directory alone) writes phase 2's
`scorecard.json` and renders `scorecard.md` from it. The method is in
[PHASE2-PREREGISTRATION.md](PHASE2-PREREGISTRATION.md). `eval/runner/live-recall/task-scorecard.ts` builds and checks
it the same two ways as phase 1's, before anything is written, refusing with `LR_CUSTODY_LEAK` and the field path:

1. **Structure.** Every key is one the format defines (gbrain's degraded-stage names, the guard's verbs and refused AI
   call kinds are allowed as keys in their three count maps), every string is an allowlisted word (arm, form, model,
   status, comparison id, barrier, abort code and so on) or a timestamp, hex digest or version, a `provider:model` id
   only at `run.reranker_model` and `run.embedding_model`, a short token only at `run.window_note` and
   `judge_check.waiver`, and a served model version that starts with a judge's or model's id only under `versions`.
   Every number is finite. A task, answer, fact or slug has no field it could land in.
2. **Needle scan.** Both files are searched for every task form, gold answer, required fact, acceptable variant and
   task id, and every slug the run saw, searched or cited. Needles with no letter (a number or a date) are left to the
   structure check.

Top level:

- `schema`: `"live-recall-task-scorecard/v1"`. `status`: `complete` once every task, form, arm and model has an
  outcome (counted, or excluded for a reason other than `not_run` or `unjudged`) and no cap stop is outstanding, else
  `incomplete`. A cap stop that GBEV-3 extended and a resume continued past is no longer outstanding. `stop`:
  `LR_CAP_STOP` while a cap stop is outstanding, else null.
- `run`: identity. Start and finish times, runner commit and whether it was dirty, `harness_digest` (sha256 over the
  runner's source files), gbrain's pinned and loaded versions and commits, schema version, engine, barrier, connection,
  `control` (true for the public fixture), search mode, reranker, embedding model, `privacy_posture` (`remote`),
  `remote_private_pages` (false), `crag_escalation`, `crag_think`, `result_cache`, `tool_defs_digest` (sha256 of the
  gbrain tool definitions sent), models, arms, forms, `judges` (model to counted judge), the second judge, `labellers`
  and `label_effort` (a judge-check run only, else null), effort, output
  and turn limits, tool result, paste and page caps, `budget_usd` (the starting cap), `final_cap_usd` (the cap the run's
  ledger run records after any extensions), `cap_extensions` (how many times GBEV-3 extended the cap after a cap stop),
  `window_note`, concurrency and `openai_store`.
- `tasks`: submitted, kept at the freeze, dropped as unreachable, lost since the freeze, kept at the run, the task file's
  sha256 prefix, N frozen, counts by type and by how each gold page was found, and `mdd_primaries` (the minimum
  detectable difference at N frozen for 10%, 20% and 30% discordant pairs, at alpha 0.05 and at Holm's 0.0125).
- `cost`: `model_calls_usd` and `by_role_usd` (answer, summariser, judge, second judge, and `label` for a judge-check
  run's labellers), each priced from the response's
  usage at the ledger's list prices; `ledger_usd`, the ledger's total for this run directory's own ledger run across
  all its sessions (never another run directory's or runner's spend); and `other_usd`, the difference
  (gbrain's embedding and rerank calls, and requests retried after a failure).
- `cells`: form (`paraphrase`, `exact`, and `pooled` when both ran) to arm to model. Each cell has `n_tasks`, `counted`,
  `model_errors` (counted no-answers from a model-caused 400), `excluded` by reason (`harness_error`, `timed_out`, `degraded`, `judge_error`, `unjudged`, `not_run`), `invalid` and
  `invalid_reason` (`errors_over_cap` or `degraded_over_cap`), and `rates`: `correct`, `correct_grounded` (null for A),
  `partial`, `abstained`, `no_answer`, `confidently_wrong` and `contradicted`, each as `k`, `n`, `point` and `ci95` (Wilson;
  a cluster bootstrap over tasks when pooled). Then `citations` (mean per answer, supported share), `exposure` (shares
  that `searched`, saw, opened and cited a gold page, `summary_gold_cited` for C and `pasted_gold` for D), turns and tool
  calls per episode, latency p50 and p95 in milliseconds, `tokens` by kind, `cost_usd` by role and
  `answer_cost_per_correct_usd`. Pooled cells carry no tokens or cost.
- `comparisons`: the four primaries (`primary` `P1` or `P2`) and the descriptive set. Each has its id, form, model, arms
  `a` and `b`, metric, `untested`, `n_pairs`, `mean_a`, `mean_b`, `delta` (b minus a), `ci95` (cluster bootstrap),
  `worse_tasks` (tasks where b scored below a, both forms summed when pooled), `reading` (`no_measurable_difference`
  when the interval includes zero, else `b_higher` or `b_lower`; a primary whose interval excludes zero but whose
  `p_holm` is 0.05 or more reads `not_significant_after_correction`, so it never reads as a difference Holm does not
  support; the markdown marks the descriptive copy of each primary),
  `mcnemar`
  (wins, losses, discordant pairs, exact two-sided p; per form only), `p_two_sided`, `p_holm` (primaries only, Holm over
  the four) and `mde` (the observed minimum detectable difference).
- `judge_agreement`: `second_judge_correct` (`n`, `agree`, `kappa` between the counted judge and claude-opus-5-5 on
  particle-1's paraphrase rows of B, C and D) and `audit` (Wintermute's `n` and `agree`, or null).
- `judges`: each judge model's `rows`, how many of them were `truncated` at the output-token cap (each a judge error),
  and the `versions` its provider reported serving.
- `judge_check`: the judge check the counted run started from (`judge_check_sha256`, `passed`, GBEV-3's `waiver` note
  or null, and its `judges` block as below), or null for the fixture and for a judge-check run.
- `custody`: read-only verified at the start and the end, `guard_refusals` by verb, `ai_refusals` by call kind and
  `degraded_stages` by stage.

`scorecard.md` opens with the status and identity line, then the primary models' paraphrase table with answer cost per
correct answer, the four primaries with their reading, tasks worse and Holm p, every cell, the descriptive comparisons,
and the judge (versions and the judge check), cost and custody lines.

## Judge check (live-recall-judge-check/v1)

`tasks.ts judge-check` (and `tasks.ts judge <judge-check dir>`, which repairs judge errors and rewrites it) writes
`judge-check.json`, the R78 check in [PHASE2-PREREGISTRATION.md](PHASE2-PREREGISTRATION.md#judge-check-before-the-counted-run-r78),
checked by the same structure check and needle scan as the scorecard:

- `schema`, `passed` (the check is complete, every counted judge passed both metrics and no judge model's truncation
  rate is above 1%), `thresholds` (`min_labels` 40, `kappa` 0.6, `truncation` 0.01), `n_answers` (answered episodes),
  `n_tasks_checked` (finished tasks: every arm and model has its final answer and, when answered, its counted verdict and
  both labels; at least 20 for a counted run to use it), `complete` (every planned task finished and no cap stop
  outstanding; a counted run refuses an incomplete check), `tasks_sha256` (the task file's sha256, which the counted run
  must match) and `stop` (`LR_CAP_STOP` while a cap stop is outstanding, else null).
- `steps`: the label floor's steps in order, each with `n_tasks` and `labels`, counted judge to its label counts on
  `correct` and `correct_grounded` over that step's tasks. One step when the first 20 tasks gave every judge 40 labels.
- `truncation`: each judge model's `rows` (every judge and label call it made, earlier calls on an answer judged again
  included), `truncated` and `rate`.
- `judges`: counted judge to `answer_models` (the models whose rows it judges), `correct` and `correct_grounded` (B, C and
  D only), and `by_model` with the same two blocks per answering model. Each block has `n_rows`, `unusable` (a counted
  verdict or a label missing or a judge error), `labeller_agree` and `labeller_kappa` (the two labellers over every
  usable row), `n_labelled` (rows both labellers grade alike), `n_bad`, `n_good`, `caught` and `catch_rate` (bad
  answers the counted judge failed), `false_fails` and `false_fail_rate` (good answers it failed), `kappa` (counted
  verdict against the labels) and `passed`.
- `versions`: each judge and labeller's rows, truncated rows and served model versions.
- `run`: start and finish times, runner commit and dirty flag, `harness_digest` (the counted run must match it),
  gbrain's loaded version and commit, schema version, `control`, effort, `labellers`, `label_effort`, and the `models`
  and `arms` it covered (the counted run's must be among them).
- `cost`: `model_calls_usd`, `by_role_usd` (answer, summariser, judge, label) and `ledger_usd`.

## A release gate (proposal, not wired)

Nothing here is wired into gbrain. Whether a gbrain release gate uses this scorecard is GBRA-108's decision, after at
least five runs. The proposal:

- **Measure noise first.** Five same-version runs on fresh nightly copies give the night-to-night standard deviation of
  `configured` success@5; two back-to-back runs on one copy give run-to-run jitter alone.
- **Pair the candidate with the baseline.** The runner targets a copy, so a candidate gbrain can migrate its own copy:
  run the baseline and the candidate on the same night's copy and pair them with `compare`.
- **Flag a regression** when the paired delta in `configured` success@5 has a 95% upper bound below zero and a point
  estimate worse than the larger of 5 points and twice the night-to-night standard deviation. Warn only until
  GBRA-108 adopts it.
