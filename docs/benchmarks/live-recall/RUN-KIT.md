# Live recall: run kit for Wintermute

This is everything needed to run the live-recall harness on the box that holds Garry's brain. It measures how well
gbrain's search finds the right page for real questions, arm by arm, and writes an aggregate scorecard. The method and
decision rules are in [PREREGISTRATION.md](PREREGISTRATION.md); the scorecard format is in [SCORECARD.md](SCORECARD.md).

Only these files ever leave the box: `freeze.json` (counts, a hash and power numbers), the run's `scorecard.json`
and `scorecard.md` (aggregates), and `compare.json` or `pool.json` when you make one (aggregates too). The question file, the per-query detail, gbrain's log and the brain copy stay.

## What you need

- `bun` and `git`, and this repository at the commit named in the run request, installed with `bun install`.
- A gbrain git checkout that contains `52b9ccae42cd81e16c21624c545a9c02c3505c11` (v0.60.577.0, the version the box
  runs). The runner copies that commit into `.gbrain-overlays/` and verifies the copy; your checkout is not changed.
- Docker, with room for one copy of the brain (the default barrier). Without Docker, see [Other
  barriers](#other-barriers).
- The shell runs as the user whose `~/.gbrain/config.json` serves the brain (or `GBRAIN_HOME` points at the
  directory that holds `.gbrain/`), so gbrain reads the brain's embedding model and search settings.
- The keys gbrain uses on this box for query embeddings and reranking (for example `OPENAI_API_KEY` and
  `VOYAGE_API_KEY`), exported in that shell. Expected use at 100 questions: about 400 embeddings and 200 rerank calls,
  well under $0.10.
- `GBRAIN_DIRECT_DATABASE_URL` unset in the shell. The runner refuses to start with it set.

## Steps

All commands run from the repository root.

1. **Make the copy.** Point `LIVE_RECALL_SOURCE_URL` at the brain's Postgres (a session or direct connection, not the
   `:6543` transaction pooler). `snapshot.sh` reads it once with `pg_dump` in one read-only transaction and writes
   nothing to it. The dump holds shared locks on the brain's tables while it runs, so a gbrain migration that needs an
   exclusive lock would wait for it, and queries would queue behind that migration: make the copy when no gbrain
   upgrade is due.

   ```bash
   LIVE_RECALL_SOURCE_URL='<brain url>' eval/runner/live-recall/snapshot.sh make
   ```

   It counts rows in `pages`, `content_chunks` and `links` on the source just before and just after the dump, and each
   count in the copy must lie between the two (they match exactly when nothing wrote to the brain meanwhile; the script
   says so when something did). It writes
   `~/.gbrain-evals-live-recall-copy/copy.env` (mode 600). If the source runs a newer Postgres major version than 17,
   set `LIVE_RECALL_PG_IMAGE` to the matching `pgvector/pgvector` image.

2. **Smoke the harness, keyless.** This builds the public 30-page fixture in memory with stand-in embeddings and takes
   about 15 seconds. Its numbers are a harness check, not a measurement.

   ```bash
   bun eval/runner/live-recall/run.ts run --fixture --gbrain <gbrain checkout>@52b9ccae42cd81e16c21624c545a9c02c3505c11
   ```

3. **Write the question file** on the box, outside this repository ([format](#the-question-file)).

4. **Freeze it** and send `freeze.json` back through ALPH-11. We commit its numbers to the preregistration before the
   counted run.

   ```bash
   bun eval/runner/live-recall/run.ts freeze --questions <questions.jsonl> --out freeze.json
   ```

   Changing the question file after this needs a new freeze.

   For batch 2, freeze with `--protocol batch2`. `freeze.json` then records the protocol, and the counted run takes
   its primary comparisons from it ([batch 2 amendment](PREREGISTRATION.md#batch-2-amendment)); a `--protocol` flag on
   `run` that disagrees with the freeze is refused.

   ```bash
   bun eval/runner/live-recall/run.ts freeze --questions <questions.jsonl> --out freeze.json --protocol batch2
   ```

5. **Run**, after we confirm the freeze is committed:

   ```bash
   . ~/.gbrain-evals-live-recall-copy/copy.env
   bun eval/runner/live-recall/run.ts run --questions <questions.jsonl> --freeze freeze.json \
     --gbrain <gbrain checkout>@52b9ccae42cd81e16c21624c545a9c02c3505c11 --database-url-env LIVE_RECALL_DATABASE_URL
   ```

   For batch 2's counted run, pass the gbrain commit of v0.60.593.0, the release the box runs after its 2026-11-07
   upgrade, instead of `52b9ccae` ([batch 2 amendment](PREREGISTRATION.md#batch-2-amendment)). A second run of the
   same batch 2 file at `52b9ccae` is what the pooled and version-change secondaries need.

   Before the first question, the runner sends one public probe query through every arm and stops with
   [`LR_ARM_PREFLIGHT`](#lr_arm_preflight) if any arm errors, is refused a model call, fails its reranker open or
   reports a failure stage, so a missing grant ends the run
   before it uses the question set. The probe is two made-up words, rare enough that its keyword, title and
   windowed statements find nothing or next to nothing through the index and finish well inside gbrain's keyword statement
   bound (8 s by default). The terminal shows only allowlisted lines: the gbrain version, schema version and
   barrier, the preflight result, progress every 10 questions, and the output paths. Everything gbrain prints goes to `gbrain.local.log` in the run directory
   (`eval/reports/live-recall/<timestamp>/` unless you pass `--out`), and gbrain's own audit files land there too.

6. **Send** `scorecard.json` and `scorecard.md` from the run directory. Keep everything else in it on the box:
   `detail.local.jsonl` holds per-query pointers (a later `compare` reads it), and `gbrain.local.log` and the audit
   files hold gbrain's own output.

7. **Tear down the copy.**

   ```bash
   eval/runner/live-recall/snapshot.sh teardown
   ```

To compare two runs on the box (two gbrain versions on the same night's copy, or the same version twice for
run-to-run noise): `bun eval/runner/live-recall/run.ts compare --a <run dir> --b <run dir> --out <dir>` writes an
aggregate `compare.json`. It refuses with `LR_FREEZE_MISMATCH` when the two runs used different question files and
with `LR_COMPARE_CONTROL` when either is a `--fixture` control. `run_a` and `run_b` in `compare.json` name each run's
gbrain version and commit, barrier and freeze, so a swapped `--a` and `--b` shows.

To pool batch 1 and batch 2 for the preregistered N = 100 secondary:
`bun eval/runner/live-recall/run.ts pool --a <batch 1 run dir> --b <batch 2 run dir> --out <dir>` writes an aggregate
`pool.json` from the two runs' `scorecard.json` and `detail.local.jsonl`, and opens no database. It refuses with
`LR_POOL_MISMATCH` when the two runs used the same question file or differ in gbrain commit or search settings, and
with `LR_COMPARE_CONTROL` when either is a `--fixture` control.

## The question file

JSONL, one question per line. Fields the runner does not know are ignored, so your own bookkeeping can stay in the file.

```json
{"id":"err-1","type":"error_string","forms":{"exact":"ERR_QUEUE_SATURATED: shard 7 exceeded 40000 pending jobs","paraphrase":"the time work piled up faster than the scheduler could drain it"},"gold":[{"slug":"incidents/2026-03-14-queue-backlog"}],"gold_found_by":"page_first"}
{"id":"time-1","type":"time_window","forms":{"exact":"pricing review 2026-03-02","paraphrase":"what did we decide about what to charge customers in early March"},"gold":[{"slug":"meetings/2026-03-02-pricing-review"}],"gold_found_by":"page_first","window":{"since":"2026-03-01","until":"2026-03-07"}}
```

(These two lines come from the public fixture, `eval/data/live-recall-v1/`; the company and its pages are invented.)

- `id`: letters, digits, `.`, `_` or `-`, unique, at most 64 characters.
- `type`: `identifier`, `error_string`, `time_window`, `cross_source` or `topic`.
- `forms.exact` and `forms.paraphrase`, both required. The exact form uses the words, identifiers or strings that
  appear in the gold page. The paraphrase asks for the same thing without them.
- `gold`: one or more `{"slug": ...}` entries naming gbrain pages, with optional `"chunk_ids": [...]`. A
  cross_source question lists every page it needs.
- `gold_found_by`: `page_first` (you opened the answer page, then wrote the question), `memory`, `gbrain_search`,
  `other_search` or `unknown`. Page first is what we ask for.
- `window` (optional, time_window only): `{"since": "YYYY-MM-DD", "until": "YYYY-MM-DD"}`.

**From `evals/recall/questions.jsonl`.** Its gold is message ids in OpenClaw's session index, which is a different
search system. Here gold must be the gbrain page that holds the answer: if a session is imported into gbrain, use that
page's slug; if the answer lives only in the session index, leave the question out, because gbrain cannot find it. Its
`paraphrase` stratum becomes the paraphrase form of a question here, so each question needs both forms written.
`stratum`, `topic` and `gold_rule` can stay in the file and are ignored.

## Other barriers

The runner searches only a database that proves, by itself, that this run cannot change Garry's brain:

- **A copy** (default, `snapshot.sh`), proven by its marker table, which must carry the system identifier of the
  cluster the runner is connected to, reached on a loopback address (`copy.env` points at `127.0.0.1`).
- **A hot standby**, such as a Supabase read replica: set `LIVE_RECALL_DATABASE_URL` to the replica's URL. Proven by
  `pg_is_in_recovery()`.
- **A role with no write privilege**: no INSERT, UPDATE, DELETE or TRUNCATE on any table, view, materialized view or
  foreign table (column grants included), no CREATE on any schema or on the database, no UPDATE or USAGE on any
  sequence, no EXECUTE on a SECURITY DEFINER function in `public`, membership in no other role (a member can switch
  to a role that writes, which the runner's check of the role itself does not see), and BYPASSRLS so it can read tables
  with row-level security. It also needs EXECUTE on gbrain's five helper functions that are not SECURITY DEFINER
  (`gbrain_fts_input`, `gbrain_fact_fingerprint`, `gbrain_fact_fingerprint_v1`, `gbrain_fact_normalize`,
  `gbrain_try_jsonb`): without `gbrain_fts_input` every hybrid-search arm fails with `title_arm_failed`, which the
  arm preflight catches. Creating that role changes Garry's database, so ask through
  ALPH-11 first; it is GBRA-108's or Garry's decision.

## Phase 2

Phase 2 asks whether gbrain retrieval changes the answers a model gives about Garry's brain
([preregistration](PHASE2-PREREGISTRATION.md)). Each task goes to claude-opus-5-5, particle-1 and gpt-6.1-sol in four
arms (no retrieval, gbrain's own read tools, a summarising helper, and the top five pages pasted in), a judge from
another model family (gpt-6-astra for claude-opus-5-5 and particle-1, claude-opus-5-5 for gpt-6.1-sol) grades each
answer against the gold answer, and the runner writes an aggregate scorecard. Before the counted run, a judge check
grades 240 answers on 20 of the frozen tasks twice more, once by each judge model, to measure the judges. Every
model call carries task text, and the gbrain arms carry retrieved page text, to Anthropic, OpenAI and Particle; Garry
agreed to that for this eval (T1, 2026-11-07). The runner reads the brain only as gbrain's untrusted remote caller, so
gbrain hides pages flagged private from the models and the judge. gbrain caches its privacy setting for 30 seconds, so
if someone relaxes it mid-run, pages served inside that window can reach a model before the runner notices.

Only these leave the box: `freeze.json` (counts, a hash and power numbers), the freeze's reachability line (two counts),
the `estimate` lines (dollars), the judge check's `judge-check.json` (counts, rates and kappas), and the run's
`scorecard.json` and `scorecard.md` (aggregates). The task file, `tasks.meta.json`, the run's records, page
snapshots, audit rows and gbrain's log stay.

### Phase 2: what you need

- This repository at the commit named in the run request, installed with `bun install`.
- The gbrain checkout the box runs, passed as `--gbrain /data/gbrain@98dda48fb9fd` (0.60.613.0, schema 296). The runner
  loads that commit from a verified overlay copy; the checkout is not changed.
- A read-only barrier, as for phase 1. For the counted run, the no-write role ALPH-72 creates just before the run, its
  URL in `LIVE_RECALL_DATABASE_URL`. `freeze` and `estimate` read the brain too; a `snapshot.sh` copy (phase 1, step
  1) works for them.
- The model keys `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `PARTICLE_API_KEY`, and the keys gbrain uses here for query
  embeddings and reranking, exported in the shell. Check each with `test -n "$NAME"`; never print one.
- The shell rules from phase 1: run as the user whose `~/.gbrain/config.json` serves the brain, with
  `GBRAIN_DIRECT_DATABASE_URL` unset. `GBRAIN_REMOTE_PRIVATE_PAGES` is removed from the runner's own process; if the
  brain's config sets `search.remote_private_pages`, the runner refuses to start.
- A budget ledger on the box, for example `/data/ops/live-recall/phase2/ledger.sqlite`. The first paid command on a new
  ledger also takes `--program-cap-usd 900`, which covers the judge check's $200 cap and the counted run's $700.

### Phase 2: the task file

JSONL, one task per line, kept on the box outside this repository. This line is from the public fixture
(`eval/data/live-recall-v1/tasks.jsonl`; the company and its pages are invented):

```json
{"id":"time-1","type":"time_window","source_question":"time-1","forms":{"exact":"What did the 2026-03-02 pricing review decide?","paraphrase":"What did we decide in early March about what to charge customers?"},"gold_pages":["meetings/2026-03-02-pricing-review"],"gold_answer":{"text":"The usage tier moves to $4 per robot-hour, billed monthly, with a floor of $500.","required_facts":[{"id":"f1","fact":"Usage pricing of $4 per robot-hour, billed monthly."},{"id":"f2","fact":"A floor of $500."}]},"window":{"since":"2026-03-01","until":"2026-03-07"},"gold_found_by":"page_first"}
```

- `id`: letters, digits, `.`, `_` or `-`, unique, at most 64 characters. Keep it opaque.
- `type`: `identifier`, `error_string`, `time_window`, `cross_source` or `topic`.
- `source_question`: the phase 1 question id it came from, or `null` for a new task.
- `forms.exact` and `forms.paraphrase`: the same question twice. The exact form uses the gold page's own words,
  identifiers or strings; the paraphrase asks for the same thing without them.
- `gold_pages`: one or more gbrain page slugs that hold the answer. Every one must be readable by a remote caller: not
  `visibility: private`, not a derived atom or synthesized concept without a visibility, not a pinned question, and not
  restricted to named readers. Every one must also live in the source the runner reads, the one
  `gbrain sources current` names from the repository root.
- `gold_answer.text`: the short answer. `gold_answer.required_facts`: one to four `{"id", "fact"}` entries, each a fact a
  correct answer must state, taken from text outside the page's protected facts and takes fences.
  `gold_answer.acceptable_variants` (optional): other wordings of the answer that also count.
- `gold_found_by`: `page_first`, `memory`, `gbrain_search`, `other_search` or `unknown`, as in phase 1.
- `window` (optional): `{"since": "YYYY-MM-DD", "until": "YYYY-MM-DD"}`.

### Phase 2: steps

All commands run from the repository root.

1. **Check the task file.** Keyless, and it opens nothing.

   ```bash
   bun eval/runner/live-recall/tasks.ts check --tasks <tasks.jsonl>
   ```

2. **Freeze it** through a barrier and send `freeze.json` and the reachability line back through ALPH-72. It checks
   every gold page as a remote caller in the source the runner reads and drops any task whose page a remote caller cannot
   open there (private, or no safe chunk), counting the drop without naming the task. It prints
   `gold pages reachable from the reader's source: k of n`, where n is every distinct gold page in the file. If a gold
   page lives only in another source, it stops with [`LR_GOLD_OUT_OF_SOURCE`](#lr_gold_out_of_source) and writes
   nothing: send the detail line to GBEV-3 and do not drop or edit the task yourself. It makes no model call. Under 100
   kept tasks it prints `FREEZE UNDER 100`: write replacement tasks of the same type and freeze again before accepting
   lower power. Exit status 5 means fewer than 60 tasks are kept: tell GBEV-3 before the freeze is used. Any
   change to the task file after this needs a new freeze.

   ```bash
   bun eval/runner/live-recall/tasks.ts freeze --tasks <tasks.jsonl> --out freeze.json \
     --gbrain /data/gbrain@98dda48fb9fd --database-url-env LIVE_RECALL_DATABASE_URL
   ```

3. **Estimate the cost** (the cost gate). `--smoke` and `--smoke-check` are the public smoke's run directory and its
   fixture judge check's, which come with the run request. It reads the frozen gold pages' sizes and makes no model
   call. It prints each judge's share on its own line and the judge check's projection over 20 tasks and over 40 (the
   most the label floor can add), and ends with `cost gate passed`, or stops with [`LR_COST_GATE`](#lr_cost_gate); send the lines either way.

   ```bash
   bun eval/runner/live-recall/tasks.ts estimate --tasks <tasks.jsonl> --freeze freeze.json --smoke <smoke run dir> \
     --smoke-check <smoke judge-check dir> --gbrain /data/gbrain@98dda48fb9fd \
     --database-url-env LIVE_RECALL_DATABASE_URL --out estimate.json
   ```

4. **Judge check**, in the window GBEV-3 grants, before the run. It answers the paraphrase form of 20 frozen tasks in
   every arm and model, judges each answer as the run will, and has both judge models grade every answer again. It
   prints one line per judge and metric, one per judge model with its calls truncated at the output cap, and writes
   `judge-check.json` in its own run directory. If after 20 tasks a judge has fewer than 40 labels on either metric, it
   adds 10 more frozen tasks at a time, up to 40, by itself in the same directory and under the same cap (the label
   floor; a `--fixture` check runs its tasks once); `judge-check.json` lists every step. Exit status 0 means it passed; send `judge-check.json`. Exit status 7
   means a judge did not pass: send `judge-check.json` to GBEV-3 and run nothing counted until GBEV-3 answers. Exit
   status 1 means the check is unfinished: some answer, verdict or label is missing. It cannot pass until the same
   command with `--resume` finishes it in a window GBEV-3 grants; re-judging (step 6) repairs judge errors but never
   answers. A cap stop (6), a truncation stop
   ([`LR_JUDGE_TRUNCATED`](#lr_judge_truncated)) and a resume work as for the run.

   ```bash
   bun eval/runner/live-recall/tasks.ts judge-check --tasks <tasks.jsonl> --freeze freeze.json \
     --gbrain /data/gbrain@98dda48fb9fd --database-url-env LIVE_RECALL_DATABASE_URL \
     --budget-usd 200 --budget-ledger <ledger> --program-cap-usd 900 --out <judge-check dir>
   ```

5. **Run**, in the same window, after we confirm the freeze numbers are committed and the judge check passed. Start it
   detached (for example in `tmux`): it takes hours, and the paraphrase pass finishes before the exact pass starts. It
   refuses to start without a passing judge check made on the same task file and harness digest
   ([`LR_JUDGE_CHECK`](#lr_judge_check)).

   ```bash
   bun eval/runner/live-recall/tasks.ts run --tasks <tasks.jsonl> --freeze freeze.json \
     --gbrain /data/gbrain@98dda48fb9fd --database-url-env LIVE_RECALL_DATABASE_URL \
     --judge-check <judge-check dir>/judge-check.json \
     --budget-usd 700 --budget-ledger <ledger> --program-cap-usd 900 --out <run dir>
   ```

   Before the first task the runner proves the barrier, refuses a brain that shows private pages to remote callers
   (and checks that again before every task and after every episode), repeats the gold-page check (printing the
   reachability line for the frozen tasks), and sends one public probe query through D's search and B's `query` tool
   (and again whenever an episode degrades). The terminal shows only the gbrain version and barrier, the reachability
   line, the task counts, the preflight result, progress every 10 tasks per pass,
   any [`LR_JUDGE_ERROR`](#lr_judge_error) or [`LR_CELL_INVALID`](#lr_cell_invalid) count, the output paths and the
   ledger total for this run directory across all its sessions. Exit status: 0 complete, 1 incomplete (some episode is
   missing or unjudged), 6 cap stop, paused at the cap ([`LR_CAP_STOP`](#lr_cap_stop)), 3 abort (including
   [`LR_JUDGE_TRUNCATED`](#lr_judge_truncated)), 4 unexpected error.

6. **Re-judge, if asked.** If the run or the judge check printed `LR_JUDGE_ERROR`, re-judge those answers without
   re-answering (`tasks.ts judge <judge-check dir>` also re-labels, rewrites `judge-check.json`, exits 1 if an answer is
   still missing and 7 if the finished check does not pass). It joins the run's
   ledger run and cap, and after a cap stop it needs the extension's two flags ([`LR_CAP_STOP`](#lr_cap_stop)).

   ```bash
   bun eval/runner/live-recall/tasks.ts judge <run dir>
   ```

7. **Audit 30 answers.** This draws 30 judged answers, blind to arm and model, into `audit-rows.local.jsonl` in the run
   directory. Grade each against its gold answer and write one line per row, `{"row": 1, "correct": true}`, to a file
   on the box. Then rescore with the grades; only the agreement count reaches the scorecard.

   ```bash
   bun eval/runner/live-recall/tasks.ts audit <run dir>
   bun eval/runner/live-recall/tasks.ts score <run dir> --audit-grades <grades.jsonl>
   ```

8. **Send** `scorecard.json` and `scorecard.md` from the run directory. Keep everything else in it on the box.

9. **Remove the role** (ALPH-72) and send the teardown proof to GBRA-108.

If the run stops for any reason other than a cap stop (the machine restarted, a provider refused a key:
[`LR_PROVIDER_REJECTED`](#lr_provider_rejected)), continue it with the same command plus `--resume --window-note <id>`, where the id is from GBEV-3's window note. A resume judges answered episodes
that have no verdict, reruns only episodes with no record or an unfinished harness error, and never reruns a particle-1
answer that may have been billed. A cap stop pauses the run at its cap instead: it continues the same way once GBEV-3
extends the cap, with the extension id and the new cap ([`LR_CAP_STOP`](#lr_cap_stop)).

## Abort codes

Every abort prints its code, a one-line detail built only from counts, field names and line numbers, the fix below,
and "Side effects: none outside <run directory>". Exit status is 3 for an abort, 4 for an unexpected error and 2 for a
usage error. Send the code and detail line; they carry no private text.

### LR_NO_DATABASE_URL

The variable named by `--database-url-env` (default `LIVE_RECALL_DATABASE_URL`) is empty. Source `copy.env`, or set
it to the standby or read-only-role URL.

### LR_NO_BARRIER

The database is not a marked copy reached on a loopback address, not a standby, and the role can write. A copy whose
marker names another cluster (a copy's dump restored somewhere else) does not count. Make a copy with `snapshot.sh`
and use the URL in its `copy.env`, or use another barrier above. The runner connected, ran read-only catalog queries and disconnected.

### LR_READONLY_UNVERIFIED

The session did not report `default_transaction_read_only = on`, or gbrain's direct pool was active. Rerun against the
copy and send the detail line.

### LR_DIRECT_URL_OVERRIDE

`GBRAIN_DIRECT_DATABASE_URL` is set in the shell, or a database variable came back while gbrain loaded its config.
Unset it and rerun.

### LR_SCHEMA_MISMATCH

The brain's schema version differs from the gbrain the runner loaded. Pass `--gbrain <checkout>@<commit>` at the
version that wrote the brain. The runner never migrates.

### LR_EMBEDDING_UNVERIFIED

gbrain found no explicit embedding model, so the brain's vectors cannot be searched safely. Run as the user whose
`~/.gbrain/config.json` serves the brain, or set `GBRAIN_HOME`.

### LR_EMBEDDING_UNAVAILABLE

Embedding one preflight query (the fixed text `live-recall preflight`) failed. Export the key for the brain's
embedding provider and rerun. In phase 2 the runner also sends its public probe again whenever an episode degrades; if
the probe fails then, the embedding key or service failed during the run (refused, revoked or out of credit). That
episode has no record. Fix or top up the key, then continue with the same command plus `--resume --window-note <id>`,
which reruns it.

### LR_ARM_PREFLIGHT

An arm failed on the public probe query before any question ran. The detail names each failing arm, its status and
gbrain's failure stages, for example `hybrid_lexical degraded (title_arm_failed)`. `title_arm_failed` or
`keyword_arm_failed` usually means the role lacks EXECUTE on one of the helper functions listed under
[Other barriers](#other-barriers); an `embed_` or `rerank_` stage points at the provider's key or service.
`keyword_arm_failed` can also be gbrain's keyword statement timeout (`search.keyword_statement_timeout_ms`, 8 s by
default), and then `gbrain.local.log` says `canceling statement due to statement timeout`: rerun when gbrain's
maintenance jobs are idle, and report it if it repeats on an idle database. Fix the cause and rerun. Nothing was
counted. In phase 2 the probe is also sent again whenever an episode degrades; a failure then has no record for that
episode, so fix the cause and continue with `--resume --window-note <id>`.

### LR_RERANK_NEEDS_TYPESAFE

The configured reranker is a TypeSafe recipe, which this harness does not call. Ask GBEV-3 through ALPH-11 how to
measure the configured arm.

### LR_QUESTIONS_INVALID

The question file has a problem at the line and field named. Fix it and freeze again.

### LR_FREEZE_MISMATCH

The question file's hash differs from `freeze.json`, or a counted run was started without `--questions` and
`--freeze`. Freeze this exact file and send the new numbers before the counted run. From `compare`, it means the two
run directories were made on different question files. In phase 2 it means the task file's hash differs from
`freeze.json`, or the kept line count does not match it: run with the frozen file, or freeze again. On a phase 2
`--resume` it means the resume differs from the session that started the run directory in its harness digest, loaded
gbrain version or commit, schema version, barrier kind, the source it reads, configured retrieval settings (search
mode, reranker or embedding model, CRAG settings, result cache flag, tool definitions), models, arms, forms or kept
tasks (the detail names which). Resume with the same harness, barrier, source, brain configuration and flags, or start
a new run directory.

### LR_COMPARE_CONTROL

One of the two run directories passed to `compare` or `pool` is a `--fixture` control, whose numbers say nothing
about search quality. Compare or pool counted runs only.

### LR_POOL_MISMATCH

The two run directories passed to `pool` were made on the same question file, or differ in gbrain commit, search mode,
reranker or embedding settings (the detail names which). Pool a batch 1 run and a batch 2 run made with the same gbrain
and settings.

### LR_GOLD_MISSING_CAP

More than 10% of questions name a gold page the copy does not hold. Fix the slugs or make a fresher copy. In phase 2,
more than 10% of the frozen tasks lost their gold page to a remote caller since the freeze: freeze again and send the new
numbers.

### LR_CUSTODY_LEAK

A scorecard would have carried a string or key outside its allowlist, or a private string matched it. Nothing was
written. Send the detail line (a field path) to GBEV-3 through ALPH-11.

### LR_INTERNAL

Something unexpected failed. The terminal shows only the error's class name; the full message is in
`gbrain.local.log`, which stays on the box. Read it there and describe the problem without quoting private text.

### LR_TASKS_INVALID

Phase 2: the task file has a problem at the line and field named. Fix it and freeze again.

### LR_PRIVACY_RELAXED

Phase 2: the brain's config shows private pages to remote callers (`search.remote_private_pages`). At the start nothing
runs. The runner reads the policy again before every task and after every episode, so a change during the run stops it
with no record for the episode that just ran. gbrain caches the setting for 30 seconds, so pages it served inside that
window may have reached a model. The runner never relaxes or works around it; GBEV-3 decides.

### LR_CAP_STOP

Phase 2: the budget ledger refused a reservation at the cap. The runner wrote `cap-stop.json`, scored what finished as
an incomplete scorecard, and exited with status 6. The run is paused at its cap, not over. Send the scorecard and the
`LR_CAP_STOP` line (this run directory's spend across all its sessions, and the cap its ledger run records) to GBEV-3
through ALPH-72 and ask for an extension. GBEV-3 answers with an extension id and a new cap. Continue with the same run
command, `--budget-usd` set to the new cap, plus `--resume --window-note <extension id>`:

```bash
bun eval/runner/live-recall/tasks.ts run --tasks <tasks.jsonl> --freeze freeze.json \
  --gbrain /data/gbrain@98dda48fb9fd --database-url-env LIVE_RECALL_DATABASE_URL \
  --budget-ledger <ledger> --program-cap-usd <program cap> --out <run dir> \
  --resume --window-note <extension id> --budget-usd <new cap>
```

The resume raises the ledger run's budget through the ledger, records the old cap, the new cap, the extension id and
the time in `run.json`, and reruns the episodes the cap refused; finished episodes are never answered again. The ledger
refuses a run budget above its program cap, which the first paid command set to 900, so first raise the program cap with
the ledger's own command, the extension id as the reason, and pass the same number as `--program-cap-usd` above and in
any later resume:

```bash
bun eval/runner/budget-ledger.ts set-cap --budget-ledger <ledger> --program-cap-usd <program cap> --reason "<extension id>"
```

A cap stop during `tasks.ts judge` continues with `tasks.ts judge <run dir> --window-note <extension id> --budget-usd
<new cap>`. Without both flags, or with a cap no higher than the one `cap-stop.json` records, the runner stops with
this code again and spends nothing.

### LR_CELL_INVALID

Phase 2, not an abort: a form, arm and model cell lost more than 5% of its episodes to errors or more than 10% to
degraded searches. The scorecard marks it invalid and reports its comparisons untested. Send the scorecard as it is.

### LR_JUDGE_ERROR

Phase 2, not an abort: some judge outputs failed to parse twice. Run `tasks.ts judge <run dir>` (step 6), which
re-judges them without re-answering, then send the new scorecard.

### LR_RESUME_NEEDS_WINDOW

Phase 2: `--resume` on a counted run needs `--window-note <id>`, because a resume can make paid calls again. Ask GBEV-3
through ALPH-72 for a window note.

### LR_COST_GATE

Phase 2: the projected counted cost breaks the cost gate (the paraphrase pass over $525, 75% of the $700 cap, the total
over the cap, or the judge check's 20 tasks over its $200 cap). Send the estimate lines to GBEV-3 through ALPH-72; no counted call
runs until GBEV-3 answers.

### LR_JUDGE_CHECK

Phase 2: the counted run has no passing judge check. `tasks.ts run` needs `--judge-check <judge-check.json>` from
`tasks.ts judge-check` on the same task file and harness digest, finished (every planned task answered, judged and
labelled), covering at least 20 tasks and every model and arm the run asks for, with no cap stop, and that check must
have passed. A check paused at its cap is finished first (resume it
in the window GBEV-3 grants). If the judge check did not pass (it exits with status 7), send `judge-check.json` to GBEV-3 through ALPH-72 and run
nothing counted. If GBEV-3 decides to go ahead anyway, add `--judge-check-waiver <note id>` with GBEV-3's note id; the
scorecard reports the waiver.

### LR_JUDGE_TRUNCATED

Phase 2: a judge model hit its 8192-token output cap on more than 1% of its counted-judge calls at one effort (while it
has fewer than 100, on more than one), so the judge check or the run stopped; the line names the model, the effort and
the counts. Each truncated call is recorded as a judge error and nothing in it is counted. Judging again does not clear
the count: it covers every judge call, and a resume or re-judge checks it before any new call or cap extension. Send
the line to GBEV-3 through ALPH-77 and run nothing more until GBEV-3 answers. If GBEV-3 decides to go on, it gives a
written note id; continue with the same command plus `--truncation-waiver <note id>` (and, for a counted resume, the
`--window-note` it needs anyway). The waiver covers only the truncations recorded so far, `run.json` and the scorecard
record it, and the stop comes back if new truncations pass 1% again. A note works once and only while a stop is
outstanding: drop the flag on any later resume, and bring a new stop back to GBEV-3 for a new note.

### LR_PROVIDER_REJECTED

Phase 2: a provider refused the key, the model or the account on an answer, summary or judge call (401, 403, 404,
another 4xx, a 400 about credit or billing, OpenAI's 429 `insufficient_quota`, or particle-1's own 402 for an empty
prepaid balance; a metering proxy's 402 is a cap stop instead). The detail names the model and the HTTP status. The episode has no
record, so nothing was counted. Fix the key, the model access or the balance, then continue with the same command plus
`--resume --window-note <id>`, which reruns that episode.

### LR_GOLD_OUT_OF_SOURCE

Phase 2: a gold page exists in the brain, but only in a source other than the one the runner reads, so no call from the
runner's source can reach it. The runner reads the source gbrain resolves for this shell; `gbrain sources current`, run
from the repository root, names it. The detail gives counts only. A freeze wrote nothing and dropped no task; a run
stopped before any task. Send the detail line to GBEV-3 through ALPH-72, which decides between fixing the gold slug
and reading another source, then freeze again.

### Snapshot codes

`snapshot.sh` aborts with exit status 3 and one of: `LR_SNAPSHOT_NO_SOURCE` (set `LIVE_RECALL_SOURCE_URL`),
`LR_SNAPSHOT_POOLER` (use a session or direct URL), `LR_SNAPSHOT_NO_DOCKER` (use another barrier),
`LR_SNAPSHOT_EXISTS` (run `teardown` first), `LR_SNAPSHOT_WORKDIR` (the workdir is not one `make` created, so `make`
will not write into it and `teardown` will not delete it; pass a new or `make`-created directory), `LR_SNAPSHOT_SOURCE_READ` or `LR_SNAPSHOT_DUMP` (check the URL and
network; pg_dump's messages are in the workdir's `dump.log`), `LR_SNAPSHOT_COPY_START`, and `LR_SNAPSHOT_COUNTS`
(a copy's row count falls outside the source's counts before and after the dump, or the counts could not be read;
restore messages are in the workdir's `restore.log`, which can quote row data and stays on the box; if the brain was
busy, rerun when it is quieter). After any snapshot abort, run `teardown`.
