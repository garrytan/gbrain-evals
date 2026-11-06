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
   barrier, mode and so on) or matches a fixed shape: an ISO timestamp, a hex commit, a version number, or a
   `provider:model` id. Every number is finite. A question form or slug has no field it could land in.
2. **Needle scan.** The JSON and the Markdown are searched for every question form, gold slug and retrieved slug of the
   run. Distinctive needles are scanned (a space, slash or digit, or at least 12 characters); a short single word
   cannot be told apart from the format's own vocabulary and is already kept out by the structure check.

The Markdown is rendered from the validated JSON alone. The per-query detail behind the aggregates
(`detail.local.jsonl`, pointers only) stays on the box.

## scorecard.json

Top level: `schema` (`"live-recall-scorecard/v1"`), `run`, `custody`, `questions`, `eligibility`, `arms`,
`comparisons`.

**`run`**: what ran. `started_at`, `finished_at`; `runner_commit` and `runner_dirty` (gbrain-evals); the declared
pin (`gbrain_pin_version`, `gbrain_pin_commit`) and what was loaded (`gbrain_loaded_version`,
`gbrain_loaded_commit`, `gbrain_overlay`); `schema_version` of the brain; `engine` (`postgres`, or `pglite` for
the fixture); `barrier` (`copy`, `standby` or `no_write_privilege`) and `connection` (`direct_or_local`,
`session_pooler`, `transaction_pooler_rewritten`, or `in_process`); the brain's `search_mode`, `reranker_enabled`,
`reranker_model`, `embedding_model` and `mode_expansion` (the mode's own expansion default; every arm runs with
expansion off); `control` (true for the hash-embedding fixture, whose numbers say nothing about search quality).

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
n), `primary` (`P1`, `P2` or `null`) and, on the two primary success@5 rows, `p_holm`. A comparison whose arm is
invalid is `{"id": ..., "skipped": "arm_invalid_or_absent"}`.

Rates, deltas and intervals are fractions rounded to four decimals; the Markdown shows them as percentages.

## scorecard.md

A header naming the gbrain version and commit, schema, engine, barrier and mode (and a control warning for the
fixture); a table of every arm on all question forms (success@1, 5, 10, 20, MRR, pages returned); success@5 by type and
form; every paired comparison with its interval, p, Holm p and MDE; and a custody paragraph (read-only checks, guard
refusals, exclusions).

## compare.json (live-recall-compare/v1)

`run.ts compare --a <run dir> --b <run dir>` reads two runs' detail files on the box and pairs them per arm and form
(`all`, `exact`, `paraphrase`) on question forms that are `ok` in both. Each row has the comparison fields above
with `a: "run_a"`, `b: "run_b"`, `id` `run_b_vs_run_a_<arm>_<form>`, and `top5_changed` (how many forms' first
five pages differ). It passes the same structural check.

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
