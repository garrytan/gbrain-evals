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
   before it uses the question set. The terminal shows only allowlisted lines: the gbrain version, schema version and
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
embedding provider and rerun.

### LR_ARM_PREFLIGHT

An arm failed on the public probe query before any question ran. The detail names each failing arm, its status and
gbrain's failure stages, for example `hybrid_lexical degraded (title_arm_failed)`. `title_arm_failed` or
`keyword_arm_failed` usually means the role lacks EXECUTE on one of the helper functions listed under
[Other barriers](#other-barriers); an `embed_` or `rerank_` stage points at the provider's key or service. Fix it and
rerun. Nothing was counted.

### LR_RERANK_NEEDS_TYPESAFE

The configured reranker is a TypeSafe recipe, which this harness does not call. Ask GBEV-3 through ALPH-11 how to
measure the configured arm.

### LR_QUESTIONS_INVALID

The question file has a problem at the line and field named. Fix it and freeze again.

### LR_FREEZE_MISMATCH

The question file's hash differs from `freeze.json`, or a counted run was started without `--questions` and
`--freeze`. Freeze this exact file and send the new numbers before the counted run. From `compare`, it means the two
run directories were made on different question files.

### LR_COMPARE_CONTROL

One of the two run directories passed to `compare` or `pool` is a `--fixture` control, whose numbers say nothing
about search quality. Compare or pool counted runs only.

### LR_POOL_MISMATCH

The two run directories passed to `pool` were made on the same question file, or differ in gbrain commit, search mode,
reranker or embedding settings (the detail names which). Pool a batch 1 run and a batch 2 run made with the same gbrain
and settings.

### LR_GOLD_MISSING_CAP

More than 10% of questions name a gold page the copy does not hold. Fix the slugs or make a fresher copy.

### LR_CUSTODY_LEAK

A scorecard would have carried a string or key outside its allowlist, or a private string matched it. Nothing was
written. Send the detail line (a field path) to GBEV-3 through ALPH-11.

### LR_INTERNAL

Something unexpected failed. The terminal shows only the error's class name; the full message is in
`gbrain.local.log`, which stays on the box. Read it there and describe the problem without quoting private text.

### Snapshot codes

`snapshot.sh` aborts with exit status 3 and one of: `LR_SNAPSHOT_NO_SOURCE` (set `LIVE_RECALL_SOURCE_URL`),
`LR_SNAPSHOT_POOLER` (use a session or direct URL), `LR_SNAPSHOT_NO_DOCKER` (use another barrier),
`LR_SNAPSHOT_EXISTS` (run `teardown` first), `LR_SNAPSHOT_WORKDIR` (the workdir is not one `make` created, so `make`
will not write into it and `teardown` will not delete it; pass a new or `make`-created directory), `LR_SNAPSHOT_SOURCE_READ` or `LR_SNAPSHOT_DUMP` (check the URL and
network; pg_dump's messages are in the workdir's `dump.log`), `LR_SNAPSHOT_COPY_START`, and `LR_SNAPSHOT_COUNTS`
(a copy's row count falls outside the source's counts before and after the dump, or the counts could not be read;
restore messages are in the workdir's `restore.log`, which can quote row data and stays on the box; if the brain was
busy, rerun when it is quieter). After any snapshot abort, run `teardown`.
