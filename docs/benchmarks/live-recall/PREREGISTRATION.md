# Live recall on Garry's brain: preregistration (phase 1)

This fixes the method, comparisons and decision rules for each live-recall question set before that set is searched.
It reports no result; batch 1's results are in the [batch 1 findings](../2026-11-06-live-recall-batch1.md) and batch
2's in the [batch 2 findings](../2026-11-07-live-recall-batch2.md). Batch 1's
sample size (50 questions), question file hash and minimum detectable difference are under
[Frozen sample](#frozen-sample), taken from Wintermute's freeze output before the counted run. A second, independent
question set, batch 2, runs under the [batch 2 amendment](#batch-2-amendment), fixed before that set was frozen; its
frozen sample (N, question file hash and minimum detectable differences) closes the amendment. A third set, batch 3,
adds freshness and entity questions under the [batch 3 amendment](#batch-3-amendment), fixed before any of its
questions was written. Batch 4 and batch 5 follow under their own amendments; batch 5 re-measures the paraphrase gap at
gbrain's newest release and adds an arm for gbrain's keyless partial-word fill.

## The question

How often does gbrain's search put the page that answers a real question at the top of its results, on Garry Tan's own
brain? How does that change with the kind of question (an identifier, an error string, a time window, a question that
needs two sources, a topic) and with its wording (the words the page uses, or a paraphrase that avoids them)? And what
does each layer of search add over gbrain's own lexical search: vectors, and the brain's configured reranker?

gbrain is a personal knowledge brain: it stores Markdown pages in Postgres (or PGLite) and finds them with keyword,
vector and hybrid search. Wintermute is the agent that runs on Garry's box beside his live brain. It writes the
questions from real retrieval needs, picks the answer page for each, runs this harness against the brain behind a
read-only barrier (a disposable copy by default; the counted run reads the live database through a role that cannot
write) and sends back an aggregate scorecard. No question, page text, slug or result leaves the box.

## System under test

- gbrain **0.60.577.0** at `52b9ccae42cd81e16c21624c545a9c02c3505c11`, the version Wintermute's box runs, loaded with
  `--gbrain <checkout>@52b9ccae` from a verified overlay copy. gbrain-evals pins 0.60.557.0 (`62637c96a`); the
  scorecard records both the declared pin and the loaded commit. Both versions expect database schema version 286
  (measured: the fixture control reports schema 286 under each), and the runner refuses a brain whose schema version
  differs from the loaded code, so it never migrates anything.
- The brain's own search configuration (mode, reranker, embedding model), read from the copy and from the box's
  `~/.gbrain/config.json`, recorded in the scorecard. Query expansion is forced off in every arm, so no chat model is
  called.

## Corpus and the read-only barrier

By default the run reads a disposable copy of the brain, not the live database. Where a copy cannot be made, it reads
the live database through a role that cannot write (barrier 3 below); the counted run on Wintermute's box does that, see
[Frozen sample](#frozen-sample). `eval/runner/live-recall/snapshot.sh make` reads the live database once with `pg_dump` (one read-only transaction), restores its public schema into a local
pgvector container, checks row counts against the source and creates a marker table. The runner refuses to search
until the database itself proves one of three barriers, in this order of preference:

1. **copy**: the marker table exists (only `snapshot.sh` creates it), it carries the system identifier of the cluster
   the runner is connected to (from `pg_control_system()`, so a marker restored into or created on another cluster
   proves nothing), and the runner reached it on a loopback address;
2. **standby**: `pg_is_in_recovery()` is true (a Supabase read replica);
3. **no_write_privilege**: a non-superuser role with no INSERT, UPDATE, DELETE or TRUNCATE on any table, view,
   materialized view or foreign table (column-level grants included), no CREATE on any schema or on the database, no
   UPDATE or USAGE on any sequence, and no EXECUTE on a SECURITY DEFINER function in `public`. Making such a role on
   Garry's database is a change to his database, so it is GBRA-108's or Garry's call, not Wintermute's.

`snapshot.sh` takes the source's row counts in their own read-only transactions just before and just after the dump.
Each table's count in the copy must lie between the two, and when the source changed during the dump the script says so.

A session flag alone is not a barrier on Postgres: gbrain opens transactions not marked read-only as `BEGIN READ WRITE`
and retries a statement refused with SQLSTATE 25006 inside one. On top of the barrier the runner forces every gbrain
transaction read-only, puts an allowlist in front of raw SQL (reads; `SET LOCAL` only in the form `SET LOCAL <name> =`
or `TO`, for a plain setting name; `set_config` only with a literal setting name and `is_local` true at every nesting
level; and transaction control other than starting a read-write transaction; neither setting form may name the role,
the session authorization or a read-only setting, and SQL containing `U&'` or `U&"` anywhere, even inside a literal or a
comment, is refused), disables the direct pool and blanks the database variables gbrain's config loader would otherwise
fill from `~/.gbrain/.env`. The allowlist is a second layer and does not refuse every route around itself: it accepts
the settings that change how Postgres reads later SQL (`standard_conforming_strings`, `client_encoding`,
`backslash_quote`), after which the guard and the server can disagree about where a literal ends. The barrier above is
what custody rests on. gbrain's search path flushes per-query counters into `search_telemetry`; the guard refuses those
writes and the scorecard counts them as `telemetry_write`.

Because the copy is a snapshot, pages still waiting for an index or projection stay that way during the run. gbrain
reports such states as degraded stages; the scorecard counts them per arm.

## Questions

Wintermute writes the questions on the box. The request asks for **100 questions, each in two forms, with 50 as the
minimum**:

- **type**, one of `identifier`, `error_string`, `time_window`, `cross_source`, `topic`, about evenly split;
- **exact form**: the words, identifiers or strings that appear in the answer page;
- **paraphrase form**: the same need without the page's distinctive tokens;
- **gold**: one or more page slugs (and optional chunk ids). Gold is chosen page first: open the page that answers the
  need, then write both forms. `gold_found_by` records how each gold page was found (`page_first`, `memory`,
  `gbrain_search`, `other_search`, `unknown`) and the scorecard reports the share of each, because gold found with
  gbrain's own search would favour gbrain's ranking;
- **window** (time_window questions, optional): the dates the question means, used only by the `configured_window`
  arm.

Before any search the runner checks that every gold page exists in the copy (a read-only page lookup). A question with
an absent gold page is dropped and counted; more than 10% dropped aborts the run. The scorecard also reports the share of
paraphrases that still share an identifier-like token with their exact form, as a check on how hard the paraphrases
are. The question file format is in [RUN-KIT.md](RUN-KIT.md#the-question-file).

## Arms

Each question form is searched by every arm, one at a time.

| Arm | What runs | Model calls allowed |
|---|---|---|
| `keyword` | `engine.searchKeyword`, 50 chunks | none |
| `vector` | `engine.searchVector` with the `hybrid` arm's own query embedding and the embedding column, legacy guard and iterative-scan settings `hybridSearch` gives its own vector leg, 50 chunks | none (reuses the embedding) |
| `hybrid_lexical` | `hybridSearch` with its vector leg off (`decide.keywordOnly`), reranker, expansion and autocut off, 50 chunks | none |
| `hybrid` | `hybridSearch` keyword plus vector fusion, reranker, expansion and autocut off, 50 chunks | query embedding |
| `configured` | `hybridSearch` as the brain is configured (its mode, reranker and default limit), expansion forced off | query embedding, rerank |
| `configured_window` | `configured` plus `since`/`until`, for time_window questions that carry a window | query embedding, rerank |

Every arm runs inside gbrain's AI invocation guard: an arm that tries a model call it is not allowed (chat, decide,
multimodal, or a rerank outside the configured arms) is refused and the query is marked `ai_refused`. A configured
result with no rerank score, or one where gbrain reports `rerank_failed` or `rerank_passthrough`, counts as a rerank
fail-open; past 10% of queries the configured arm is invalid.

## Metrics

Results are reduced to a page list: slugs in result order, duplicates removed, the first 20 kept.

- **success@k** for k = 1, 5, 10, 20: a gold page is among the first k pages. The denominator is question forms.
- **MRR**: the reciprocal rank of the first gold page, 0 when none is in the first 20.
- **recall_all@k** for questions with more than one gold page: every gold page is in the first k.
- **chunk success@k** where chunk gold is given.
- Mean pages returned, model calls by kind, degraded stages by name, and harness latency (pool size 2, local copy; not
  production latency).

Intervals: Wilson for a rate over one form; a cluster bootstrap over questions (seed 20261106, 10,000 draws) when both
forms are pooled and for MRR.

**Eligibility.** A question form counts in every arm only if the five common arms all answered it with status `ok`.
A query is not `ok` when it errored, was refused by the AI guard, was a rerank fail-open, or gbrain reported a
failure stage (`embed_unavailable`, `embed_timeout`, `vector_arm_failed`, `keyword_arm_failed`,
`title_arm_failed`, `rerank_failed`, `rerank_passthrough`). Other degraded stages (for example `keyword_zero`,
`budget_truncated`, a pending index) are how the brain behaves, so those queries count and the stage counts are
reported. Exclusions are counted by arm and reason.

## Comparisons

Paired by question form, deltas are B minus A, from `clusteredPairedDelta` with the question as the cluster (sign-flip
p, two-sided).

**Primary (Holm-corrected across the two, on success@5):**

- **P1: `hybrid` minus `hybrid_lexical`**, all question forms (both forms, clustered by question): what vectors add
  to gbrain's own lexical search.
- **P2: `configured` minus `hybrid_lexical`**, paraphrase forms only (one pair per question): what the brain's
  configured search adds where the words differ.

A comparison whose arm is invalid or absent is reported as skipped and still counts as one of the two in the Holm family
(as p = 1).

The baseline is gbrain's lexical hybrid, not plain keyword search. On the public fixture, `keyword` returned no page
at all for any of the 20 paraphrases (0 of 20; 0.70 pages per exact form), while `hybrid_lexical` put the gold page in
its first five for 15 of them (`--fixture` control at 52b9ccae). A baseline that finds nothing on paraphrases would make
P2 a foregone conclusion. This was amended before any counted run (GBEV-3, 2026-11-06); the first draft named
`keyword` as the baseline for both.

**Descriptive (reported with intervals, never tested):** the keyword contrasts, `hybrid_lexical` minus `keyword`,
`hybrid` minus `keyword` and `configured` minus `keyword` on paraphrases, plus `configured` minus `hybrid`,
`vector` minus `keyword`, `configured` minus `keyword` on exact forms, `hybrid` minus `keyword` on paraphrases,
`configured_window` minus `configured` on windowed time_window questions, paraphrase minus exact within each arm (this mostly measures how hard the paraphrases were written), MRR for
every comparison, and every per-type cell.

## Decision rules

- A primary comparison **holds** when its Holm-adjusted p is below 0.05 and its 95% interval excludes 0. It is reported
  with its size, interval and the minimum detectable difference at the frozen N.
- A primary comparison that does not hold gets one R48 "Why null?" cycle before it is reported (exposure: did the arm
  run as described, from model-call and degraded-stage counts; task fit; power and saturation, from the MDD and any
  ceiling in `hybrid_lexical`'s rate; and whether lexical search alone already does the job), with a verdict of KEEP,
  FIX-METHOD or CUT-CANDIDATE.
- **Paraphrase gap.** If `configured` success@5 on paraphrases trails its own exact forms by 20 points or more with the
  interval excluding 0, we write a public, synthetic reproduction in the style of the fixture and route it to gbrain's
  Captain (GBRA-108). No private question goes with it.
- Wintermute's session-search baseline (45 questions on OpenClaw's transcript index) measures a different system and is
  not compared with these numbers.
- Phase 2 (task success with and without retrieval) is decided by GBEV-3 from these numbers. Any gbrain release gate
  built on this scorecard is GBRA-108's call ([SCORECARD.md](SCORECARD.md#a-release-gate-proposal-not-wired)).

## Power

From the runner's `mde` (the same formula as `powerNote`): two-sided alpha 0.05, 80% power, success@5, in points.
"Discordant" is the share of pairs where the two arms disagree.

| Comparison | N = 50 | N = 100 |
|---|---|---|
| P1, both forms clustered by question, 20% discordant | 12.5 (forms independent) to 17.7 (forms fully correlated) | 8.9 to 12.5 |
| P2, paraphrase forms only, 10% / 20% / 30% discordant | 12.5 / 17.7 / 21.7 | 8.9 / 12.5 / 15.3 |
| One type alone, 20% discordant (N/5 questions) | about 28 to 40 | about 20 to 28 |

So the run can show large effects, such as vectors adding 15 to 20 points on paraphrases, and cannot rank arms 5
points apart. Per-type numbers are descriptive.

## Cost

No paid model calls by us. On Wintermute's keys, about one query embedding per form for `hybrid` and one for
`configured` (plus one for each windowed form), one preflight embedding, and one rerank call per configured query:
roughly 400 embeddings and 200 rerank calls at N = 100, well under $0.10. The build, review and run coordination are
charged to phase 1's $300 cap.

## Frozen sample

Frozen on 2026-11-06 from Wintermute's `run.ts freeze` output at gbrain-evals `d4651999`, before any counted search.
The runner refuses a question file whose hash differs from this one.

- **N = 50 questions** (100 question forms), 10 of each type: identifier, error_string, time_window, cross_source and
  topic. All 10 time_window questions carry a window, so `configured_window` runs on 20 forms.
- **Question file sha256:** `88eaa30c34d85d303aff2a0faf81e9adfe6a5815dadc5196879c827e6f02ae9f`.
- **Minimum detectable difference** in success@5 at N = 50 (two-sided alpha 0.05, 80% power), in points, by the share
  of pairs where the two arms disagree:

| Comparison | 10% discordant | 20% discordant | 30% discordant |
|---|---|---|---|
| P1, both forms clustered by question (forms independent to fully correlated) | 8.9 to 12.5 | 12.5 to 17.7 | 15.3 to 21.7 |
| P2, paraphrase forms only | 12.5 | 17.7 | 21.7 |

Wintermute's notes on the sample, aggregates only:

- All 50 gold pages were found page first. Wintermute drew a seeded random sample of real pages and wrote each question
  after reading its page, so none of the 50 is a real ask that once failed. Its 45 earlier session-search questions were
  not reused, because their gold lives only in OpenClaw's session index.
- Wintermute rates 2 of the 10 cross_source pairings as weak: each page holds half the answer, but the pairing is its
  own choice.
- The 10 error_string questions come from 6 pages, and several share a gold page, so that type tests fewer than 10
  pages.
- Its own checks before the freeze: every gold slug resolves through `gbrain get`, every exact form's key tokens are
  in its gold page, no paraphrase contains them, ids are unique, and every time_window question carries a window.
- By source (a field the runner ignores): ops 15, brain 14, meeting 13, conversation 8. No page from the week of the
  freeze is in the sample.

**Barrier for the counted run:** `no_write_privilege`. Wintermute's box is a container with no Docker, so
`snapshot.sh` cannot make a copy there. GBRA-108 approved a role with SELECT on gbrain's tables, USAGE on the
`extensions` schema, BYPASSRLS, no sequence grants and no role memberships. The runner connects as that role through
Supabase's session pooler and proves the barrier itself before any search.

## Batch 2 amendment

Fixed on 2026-11-06 by GBEV-3, after batch 1's results and before the batch 2 question set was frozen. Batch 2 is a
second, independent set of 50 questions. Arms, metrics, eligibility, custody and the decision rules are unchanged. The
primary comparison, the declared secondaries and the gbrain version under test change.

**Why.** Batch 1's P1, `hybrid` minus `hybrid_lexical` over both forms, came out at +10 points (95% interval 1 to
20, Holm p 0.092) against a minimum detectable difference of 14.4, so it does not hold, and its R48 verdict is KEEP
(underpowered). Exact forms leave vectors little room: `hybrid_lexical` already found 82% of them. On paraphrases the
two arms found 12% and 34%. That reading comes from batch 1's data, so the sharper primary is tested on new questions,
never on batch 1's.

**System under test.** Batch 2's counted run measures the gbrain that Wintermute's box runs after its scheduled upgrade
to the stable release v0.60.593.0 (2026-11-07, 11:20 UTC), so it measures what is deployed, as GBRA-108 asked. The
runner loads it with `--gbrain <checkout>@<commit>` at that release and refuses a brain whose schema version differs
from the loaded code, as for batch 1. The scorecard records the loaded version and commit beside the repository's pin.

**Primary (Holm-corrected across the two, on success@5):**

- **P1: `hybrid` minus `hybrid_lexical`**, paraphrase forms only (one pair per question): what vectors add to
  gbrain's own lexical search where the words differ. Comparison id `p1_hybrid_vs_hybrid_lexical_paraphrase`.
- **P2: `configured` minus `hybrid_lexical`**, paraphrase forms only, unchanged from batch 1.

**Declared secondaries** (reported with intervals, not Holm-adjusted):

- `batch1_p1_hybrid_vs_hybrid_lexical`: batch 1's P1, both forms, on batch 2's questions, as a replication. It is
  compared across versions: batch 1 measured gbrain 0.60.577.0 and batch 2 measures 0.60.593.0.
- The pooled analysis: batch 1's counted run (attempt 2, gbrain 0.60.577.0 at `52b9ccae`) and a batch 2 run on the
  same gbrain, scored as one set of 100 questions with batch 2's comparisons, by `run.ts pool` on the box. `pool`
  refuses two runs on the same question file, a fixture control, and runs whose gbrain commit or search settings
  differ, so its batch 2 half is a second run of the frozen batch 2 file at `52b9ccae`, made before the upgrade or
  afterwards if the brain's schema version still matches. Without such a run the pooled analysis is reported as not
  computable.
- The version change: `run.ts compare` between batch 2's two runs (`52b9ccae` and 0.60.593.0, the same questions),
  reported as a descriptive row, when both runs exist.
- Every descriptive comparison listed under [Comparisons](#comparisons).

**The protocol is frozen with the questions.** Wintermute freezes batch 2 with `run.ts freeze --protocol batch2`.
`freeze.json` records the protocol, the counted run takes it from there and refuses a `--protocol` flag that
disagrees (`LR_FREEZE_MISMATCH`), and the scorecard records it beside the comparisons.

**Questions.** Written fresh on the box in the same format and under the same rules as batch 1, plus: no batch 1 gold
page reused, gold chosen page first from a new seeded sample that includes recent pages wherever the brain's import is
current, error_string questions drawn from more than 6 pages, 10 questions of each type, and a window on every
time_window question.

**Arm preflight.** Before the first question the runner sends one public probe query through every arm and stops with
`LR_ARM_PREFLIGHT` if any arm errors, is refused a model call, fails its reranker open or reports a failure stage. It
changes no counted number. It stops a run like batch 1's first attempt, which lost every hybrid-search arm to a missing
grant, before the run uses the question set.

**Preflight probe change** (2026-11-07, before batch 2's counted run). The counted run on 0.60.593.0 stopped twice at
the arm preflight, at 18:54 and 19:21 UTC, with `configured_window degraded (keyword_arm_failed)`, and no question ran
in either attempt. The first attempt's log shows the probe's all-time windowed keyword statement hitting gbrain's own
keyword statement bound (`search.keyword_statement_timeout_ms`, 8 s by default); the second started with no gbrain job
active. The probe changed from `live-recall arm preflight probe` to two made-up words, `zqxjvk wfpqyz`. The probe never
counts, and the arms, questions, metrics and decision rules are unchanged. The batch 2 run at `52b9ccae` used the old
probe, at gbrain-evals `07bed75d`.

**Synopsis coverage.** GBRA-295 is to send, as aggregates, the share of the brain's chunks that carry `tokenmax`'s
per-chunk synopsis vectors and which of its triggers set `keyword_candidates_incomplete`. The batch 2 report carries
them as a note; no arm is added.

**Barrier.** A new `no_write_privilege` role from GBRA-108 with batch 1's final grants: SELECT on gbrain's tables,
USAGE on `extensions`, BYPASSRLS, EXECUTE on the five helper functions that are not SECURITY DEFINER (listed in
[RUN-KIT.md](RUN-KIT.md#other-barriers)), no sequence grants and no role memberships.

**Power.** At N = 50 the new P1 has the paraphrase-only minimum detectable differences: 12.5, 17.7 and 21.7 points at
10%, 20% and 30% discordant pairs. Batch 1's paraphrase rates (12% and 34%) imply at least 22% discordant pairs, where
the minimum detectable difference is 18.6 points, so batch 2 can detect an effect the size batch 1 showed and not much
smaller. The pooled analysis, at N = 100, detects 8.9, 12.5 and 15.3 points at the same shares.

**Batch 2 frozen sample.** Frozen on 2026-11-06 from Wintermute's `run.ts freeze --protocol batch2` output at
gbrain-evals `07bed75d`, before any batch 2 search. The runner refuses a question file whose hash differs from this
one, or a run whose protocol differs from `batch2`.

- **N = 50 questions** (100 question forms), 10 of each type. All 10 time_window questions carry a window, so
  `configured_window` runs on 20 forms.
- **Question file sha256:** `dd69701c55534429fb758ca8335af175a3dfcc3c9aca6c9c2d2fc81bf3f11099`.
- **Minimum detectable difference** in success@5 at N = 50 (two-sided alpha 0.05, 80% power), in points:

| Comparison | 10% discordant | 20% discordant | 30% discordant |
|---|---|---|---|
| P1, `hybrid` minus `hybrid_lexical`, paraphrase forms | 12.5 | 17.7 | 21.7 |
| P2, `configured` minus `hybrid_lexical`, paraphrase forms | 12.5 | 17.7 | 21.7 |
| `batch1_p1_hybrid_vs_hybrid_lexical`, both forms (forms independent to fully correlated) | 8.9 to 12.5 | 12.5 to 17.7 | 15.3 to 21.7 |

Wintermute's notes on the sample, aggregates only:

- 58 distinct gold pages, none of them a batch 1 gold page, and no question id shared with batch 1 (checked against
  batch 1's question file).
- Gold was chosen page first from a seeded sample (seed 4302) of 70 recent and 70 older pages, skipping held pages,
  READMEs, transcripts and batch 1's gold pages. One cross_source gold page is off-sample: Wintermute followed it from a
  sampled page. An earlier draw was discarded unused, and the question file was checked unchanged afterwards.
- The 10 error_string questions have 10 distinct gold pages, one each, drawn from a separate seeded shuffle of 310
  matches outside ops: 9 archived chat transcripts and 1 meeting page.
- 33 of the 58 gold pages are dated 2026-10-09 or later, by the date in their path.
- Import lag: email pages from 2026-10-30 onward do not resolve on the box, while email pages through 10-28 and
  meeting pages through 11-06 do. Five gold pages that failed to resolve were swapped for pages that resolve, so the
  newest email pages are not in the sample. GBRA-108 and GBRA-295 have been told.
- By source (a field the runner ignores): meeting 27, brain 13, conversation 9, ops 1.
- None of the 50 is a real ask that once failed: every such ask Wintermute could recall was answered only in a
  session, never on a page.
- Wintermute again rates some cross_source pairings as weak; the count is reported with the results.
- Its own checks before the freeze: every gold slug resolves, every exact form's key tokens are in its gold page, no
  paraphrase contains them, and ids are unique.

**Batch 2 counted run commit** (recorded 2026-11-07, before the counted run on 0.60.593.0). The run uses gbrain-evals
`bbde967d458f6f2a9f0d6ea6e1ab647895db1fff` on a clean tree, which the scorecard records as `runner_commit` and
`runner_dirty`, and loads gbrain at tag v0.60.593.0 (`27f8b9d6`). Harness digest:
`aee6a663997ce893ee8e10018d7dd45d8f7e88d785b8c1cbeaf6fba658d98549`, the sha256 of the output of
`git ls-tree -r bbde967d458f6f2a9f0d6ea6e1ab647895db1fff -- eval/runner bun.lock` (537 entries: every runner file and
the lockfile).

Phase 2 stays held until batch 2 lands and GBRA-108 answers on the paraphrase gap.

## Batch 3 amendment

Fixed on 2026-11-09 by GBEV-55 (GST-2005), under GBEV-3's approval of the predictive-measures plan, before any batch 3
question was written. Batch 3 is a third, independent question set that adds two question types. Arms, metrics,
eligibility, custody and the read-only barrier are unchanged. The types, the primaries, the declared secondaries and how
the freeze pins the gbrain under test change.

**Why.** The [predictive-measures preregistration](../2026-11-09-predictive-measures-preregistration.md) builds
synthetic measures of stale facts and wrong entities, the two most common recall failures Wintermute reported. Batch 1
and batch 2 asked neither kind of question, so neither can say whether those measures predict the real brain. Batch 3 is
their reference.

**Questions.** About 25 `freshness` and 25 `entity` questions, each with an exact and a paraphrased form, written and
frozen by Wintermute on the box. The freeze records the actual counts. A `freshness` question names the current page
as gold and the superseded pages in `stale`. An `entity` question's gold is the right page among pages for different
people or things with the same or similar names, and it may list the look-alike pages in `decoy`. Both types are accepted only under `--protocol batch3`. The question
file format and a public fixture are in the [run kit](RUN-KIT.md#the-question-file).

**System under test and the visibility epoch.** Batch 3 measures the gbrain Wintermute's box runs at the freeze.
GBRA-398 (garrytan/gbrain#8917) will clear over-applied `access: private` labels and let the owner and delegates read
private pages, so gold a reader could not see before it may be visible after it. The freeze records `gbrain_version`
and `visibility_epoch`, and a counted run refuses a freeze from the other epoch (`LR_FREEZE_MISMATCH`). When the
epoch reads `unknown`, the run must use the freeze's exact gbrain version. Results from the two epochs are never
pooled.

**Primary (Holm-corrected across the two, on success@5, both forms clustered by question):**

- **P1: `configured` minus `hybrid_lexical`** on `freshness` questions. Comparison id
  `p1_configured_vs_hybrid_lexical_freshness`.
- **P2: `configured` minus `hybrid_lexical`** on `entity` questions. Comparison id
  `p2_configured_vs_hybrid_lexical_entity`.

**Declared secondaries** (reported with intervals, not Holm-adjusted): `hybrid_vs_hybrid_lexical_freshness`,
`hybrid_vs_hybrid_lexical_entity`, `configured_vs_keyword_freshness`, `configured_vs_keyword_entity`, batch 2's P1
on batch 3's questions as `batch2_p1_hybrid_vs_hybrid_lexical_paraphrase`, and every descriptive comparison under
[Comparisons](#comparisons). Each arm also reports `stale_first` (all forms, exact, paraphrase): the share of
freshness forms where a stale page ranks above the gold, or comes back when the gold does not. Entity questions may
name their look-alike pages in `decoy`, and each arm then reports `decoy_first` the same way over the entity forms that
carry one. Both are descriptive and carry no interval.

**Power.** From `mde` in `run.ts`, in points, with 25 questions per type:

| Comparison | 10% discordant | 20% discordant | 30% discordant |
|---|---|---|---|
| P1 or P2, forms independent (50 pairs) | 12.5 | 17.7 | 21.7 |
| P1 or P2, forms fully correlated (25 pairs) | 17.7 | 25.0 | 30.6 |

So batch 3 can show a 20-point gain from configured search on either type, and cannot rank arms 10 points apart.

**The protocol is frozen with the questions.** Wintermute freezes with `run.ts freeze --protocol batch3` and the
`--gbrain` it will run. The counted run takes the protocol from `freeze.json`, as for batch 2.

**Cost.** No paid model calls by us. Wintermute's keys pay for about one query embedding per form for `hybrid` and
`configured` and one rerank call per configured query, as in batch 2.

**Batch 3 frozen sample.** Frozen on 2026-11-09 from Wintermute's `run.ts freeze --protocol batch3` output at
gbrain-evals `a1cfff13`, with `--gbrain` at gbrain v0.60.623.0 (`d253ec0f`, a clean checkout), before any batch 3
search. `freeze.json` records `gbrain_version` 0.60.623.0 and `visibility_epoch` `post_gbra_398`. The runner refuses a
question file whose hash differs from this one, and a run whose protocol or visibility epoch differs from the freeze's
(`LR_FREEZE_MISMATCH`).

- **N = 51 questions** (102 question forms): 25 `freshness` and 26 `entity`. The freshness questions name 25 stale
  pages in all.
- **Question file sha256:** `c023694ef59e03e64fd1b0553b6516f7bccad424b85f0f74bdf95d2a08b6014e`.
- **freeze.json sha256:** `ece4fc08627046d8d19449e5ace36123ea57b789c8794a820c7794efb56a20ad`.
- **Minimum detectable difference** in success@5 (two-sided alpha 0.05, 80% power), in points, both forms clustered by
  question (forms independent to fully correlated):

| Comparison | 10% discordant | 20% discordant | 30% discordant |
|---|---|---|---|
| P1, `configured` minus `hybrid_lexical`, freshness | 12.5 to 17.7 | 17.7 to 25.1 | 21.7 to 30.7 |
| P2, `configured` minus `hybrid_lexical`, entity | 12.3 to 17.4 | 17.4 to 24.6 | 21.3 to 30.1 |

An earlier freeze of the same question file on gbrain 0.60.618.0 checked the run kit. It read `pre_gbra_398` and matched
this freeze in every field but the gbrain version and the epoch. It is not counted, and no batch 3 result comes from it.

### 2026-11-10: batch 3 runs on gbrain 0.60.641.0

Written after the first counted attempt stopped and before any batch 3 search.

**What happened.** The first counted attempt ran on 2026-11-10 from gbrain-evals `446b9c14`, with `--gbrain` at
0.60.623.0 (`d253ec0f`). It stopped with `LR_SCHEMA_MISMATCH`: the brain's schema was 297, and 0.60.623.0 expects 296.
Earlier that day Wintermute's box had upgraded to gbrain 0.60.634.0, and that upgrade migrated the brain to schema 297.
The runner never migrates, and it refuses before any search, so the attempt ran no batch 3 query. No batch 3 data
exists at 0.60.623.0, and nothing from that attempt is counted or reported as a result.

**What changes.** Batch 3's system under test is gbrain 0.60.641.0
(`2560ffddb85244b82f2b325ee2ddc846f77c3cac`). That's the version the box runs, and it opens schema 297. The counted run
passes `--gbrain <checkout>@2560ffddb85244b82f2b325ee2ddc846f77c3cac` and runs from the gbrain-evals commit that adds
this amendment. Since `446b9c14` the runner has changed only in a check that applies to paid synthetic runs
(`e0c55bb0`), so the counted path is the same code.

**What doesn't change.** The question file and `freeze.json` are the ones recorded above, and their hashes stand:
question file `c023694ef59e03e64fd1b0553b6516f7bccad424b85f0f74bdf95d2a08b6014e` and `freeze.json`
`ece4fc08627046d8d19449e5ace36123ea57b789c8794a820c7794efb56a20ad`. There is no new freeze. The protocol, arms,
primaries, declared secondaries, power and minimum detectable differences are unchanged.

**Why the existing freeze still applies.** The freeze was recorded at 0.60.623.0. Under batch 3 the runner compares the
freeze's visibility epoch with the run's, and it compares gbrain versions only when both epochs read `unknown`
(`eval/runner/live-recall/run.ts`, lines 463 to 465). 0.60.623.0 and 0.60.641.0 both read `post_gbra_398`, so the
runner accepts this freeze at 0.60.641.0. The scorecard records both versions: `gbrain_loaded_version` 0.60.641.0 and
`freeze_gbrain_version` 0.60.623.0.

**What the numbers measure.** 0.60.641.0 hides more from scoped callers than 0.60.623.0 did. gbrain's changelog lists
three changes:
- 0.60.634.0 makes the SQL privacy checks behind list and search queries give the same answers as their TypeScript
  versions.
- 0.60.639.0 drops a link whose origin page is soft-deleted, or outside the caller's source grant.
- 0.60.641.0 makes facts, timeline entries and tags follow the page they're about. They stay hidden from a caller who
  can't read that page, and from everyone while the page is deleted.

So batch 3's numbers measure 0.60.641.0, not 0.60.623.0. Every batch 3 result is labelled with both versions: run at
0.60.641.0, frozen at 0.60.623.0.

**Order on the box.** The counted run starts after GBRA-398's relabel of over-applied `access: private` labels has
finished on the box, so the run reads one state of the brain. If the brain's schema moves past 297 before the run, the
runner refuses with `LR_SCHEMA_MISMATCH` again. That stop ends the attempt, and running at any other version needs
another dated amendment.

### 2026-11-10: batch 3 runs after relabel window 1, before window 2

Written before any batch 3 search, after the first counted attempt stopped with `LR_SCHEMA_MISMATCH`. It changes when the
counted run happens and nothing else. It replaces the timing in "Order on the box" in the amendment above; the rest of
that amendment stands.

**Why.** GBRA-398's relabel of over-applied `access: private` labels applies in windows of about 1,000 pages. Window 1
applied from 2026-11-10T08:39:14Z to 09:41:20Z: 961 pages applied and 39 declined because their files changed during the
apply. About 48 windows remain at about an hour each, so the last would land around 2026-11-12. The box is held at
0.60.641.0 only until 2026-11-11T08:00Z, and the brain's schema went from 291 (0.60.593.0, batch 2's run on 2026-11-07)
to 297 (0.60.641.0) in three days. A migration after the hold would stop the run with `LR_SCHEMA_MISMATCH` again.

**When the run happens.** The counted run starts after window 1's one-hour watch has ended, and window 2 is held from
the run's start until its teardown, so the run reads one state of the brain: relabel window 1 of about 49 applied (961
pages applied, 39 declined), the rest of the over-applied labels still in place. The run record names that state. If the
run can't start in this gap, it runs in a later gap between two windows before 2026-11-11T08:00Z, with the windows
applied named the same way. If no gap works by then, it runs after the last window, as the amendment above says.

**Unchanged.** Runner gbrain-evals `40235f35`, gbrain 0.60.641.0 at `2560ffdd` loaded as a verified overlay, the same
question file (sha256 `c023694e…`) and freeze.json (sha256 `ece4fc08…`, 51 questions, frozen at 0.60.623.0, visibility
epoch `post_gbra_398`), and the same arms, primaries and analysis.

**One counted run.** This is batch 3's only counted run. No later batch 3 run counts, including one after the relabel
finishes. A post-relabel read, if anyone makes one, is descriptive, labelled that way and never pooled with this one.

**What this state means for the results.**

- The freeze was made at 0.60.623.0 before the box's 0.60.634.0 upgrade (about 02:45Z on 2026-11-10; 0.60.623.0 can't
  open the upgraded schema), so before window 1 began. The run reads nearly the label state the questions were frozen
  against, with 961 pages relabelled since.
- About 2% of the relabel is applied. A page still wrongly labelled private stays hidden from a caller that can't read
  private pages. Where such a page is a question's gold, every arm misses it alike. That lowers success for every arm
  and pulls contrasts toward zero rather than reversing them, so it can leave fewer than three qualifying contrasts. A
  verdict that reads NO REFERENCE YET for that reason says so.
- Batch 2 ran on 2026-11-07 at 0.60.593.0, before the relabel began, so no relabel window had changed its labels either.
  It ran on the other visibility epoch (`pre_gbra_398`: owner and delegate connections couldn't read private pages).
  Whether every over-applied label already existed on 2026-11-07 isn't recorded here. The predictive measures' batch 2
  and batch 3 layers each compare a synthetic brain with one real run and are never pooled, so the two layers differ in
  visibility epoch and label state as well as in questions, and their results say so.

## Batch 4 amendment

Fixed on 2026-11-11 by GBEV-77 (GST-2449), before any batch 4 question was written. Batch 4 is a fourth, independent set
of 50 questions, made the way batch 2 was, for the predictive-measures test of G2's paraphrase-gap prediction
([amendment of 2026-11-11](../2026-11-09-predictive-measures-preregistration.md#2026-11-11-g2s-held-out-replication-on-batch-4)).
Arms, metrics, eligibility, custody, the read-only barrier and batch 2's comparisons are unchanged. What changes: the
freeze proves the questions are new, records the gbrain version and visibility epoch, and the scorecard adds a
simultaneous band over its success@5 comparisons.

**Questions.** Written fresh on the box in batch 2's format and under batch 2's rules: 10 questions of each of the five
live types, an exact and a paraphrased form each, gold chosen page first from a new seeded sample, error_string gold
drawn from more than 6 pages, and a window on every time_window question. Nothing may come from batches 1 to 3: no
question id, no form (compared after folding case, spacing and punctuation), and no gold page that was a batch 1 to 3
gold, stale or decoy page.

**The freeze checks that.** Wintermute freezes with `run.ts freeze --protocol batch4`, the `--gbrain` it will run, and
the three earlier question files, one `--prior` each. The runner checks their sha256 against the frozen ones below,
counts what the new file shares with them, and refuses with `LR_FREEZE_OVERLAP`, writing nothing, if it shares
anything or a file is missing or wrong. Only counts are printed. `freeze.json` records the protocol, the question
file's sha256, the counts by type, `gbrain_version`, `visibility_epoch`, the three earlier files' sha256
(`prior_question_files`) and a zero `prior_overlap`.

- Batch 1: `88eaa30c34d85d303aff2a0faf81e9adfe6a5815dadc5196879c827e6f02ae9f`
- Batch 2: `dd69701c55534429fb758ca8335af175a3dfcc3c9aca6c9c2d2fc81bf3f11099`
- Batch 3: `c023694ef59e03e64fd1b0553b6516f7bccad424b85f0f74bdf95d2a08b6014e`

**System under test and the visibility epoch.** Batch 4 measures the gbrain Wintermute's box runs at the freeze. As for
batch 3, a counted run refuses a freeze from the other GBRA-398 epoch, and with the epoch `unknown` it needs the
freeze's exact gbrain version. It also refuses a batch 4 freeze that records no clean check against the three earlier
files (`LR_FREEZE_MISMATCH`). The counted run uses gbrain-evals at the merge commit of this amendment, on a clean tree.

**If the box upgrades between freeze and run.** Batch 3's first counted attempt stopped with `LR_SCHEMA_MISMATCH` for
that reason and needed a dated amendment. For batch 4 the rule is fixed now. The counted run passes `--gbrain` at the
version the box runs when the run starts. If that version reads the freeze's visibility epoch, the freeze stands, and
the scorecard records both versions (`gbrain_loaded_version` and `freeze_gbrain_version`); the results label every
number with both. If the attempt stops with `LR_SCHEMA_MISMATCH` before any search, it is rerun once this way, with no
new amendment. A run on the other epoch needs a new freeze, which counts as a new batch. There is one counted run: no
later batch 4 run counts, and a second read, if anyone makes one, is descriptive and never pooled.

**Relabel state.** If GBRA-398's relabel windows are still applying on the box, Wintermute records which windows had been
applied at the freeze and at the run, and the results name both states. As in batch 3, a gold page still wrongly
labelled private is missed by every arm alike, which pulls contrasts toward zero rather than reversing them.

**Primary, secondaries and the family band.** Batch 2's P1 and P2 (paraphrase forms, Holm across the two) and its
declared secondaries are batch 4's, replicated on new questions. The scorecard also carries a `family` block and a
`family_ci95` on every success@5 comparison: a simultaneous 95% band over all of them from one bootstrap that resamples
whole questions within each of the five question types (seed 20261106, 10,000 draws), computed on the box from the same
records ([scorecard format](SCORECARD.md#scorecardjson)). The predictive-measures test reads that band; each comparison's own `ci95` is
computed exactly as in batch 2.

**Power.** At N = 50, as for batch 2: 12.5, 17.7 and 21.7 points for P1 or P2 at 10%, 20% and 30% discordant pairs.

**What leaves the box.** `freeze.json` before any search, then `scorecard.json` and `scorecard.md` after the counted
run, the relabel windows applied at the freeze and at the run, and the brain's embedding coverage at the freeze as
aggregates (the share of chunks with no vector, the share with synopsis vectors, and the share of sampled media pages
that are empty shells, with how each was counted). The coverage figures are descriptive: they show whether the
conditions the synthetic brain copies still describe the real one, and they change no outcome.

**Cost.** No paid model calls by us. Wintermute's keys pay for about one query embedding per form for `hybrid` and
`configured` and one rerank call per configured query, as in batch 2.

The batch 4 frozen sample, Wintermute's notes on it and the counted run commit are recorded in the results, as dated
entries made before the counted run.

### 2026-11-12: Batch 4 frozen sample

Written after the freeze and before any batch 4 search. Frozen on 2026-11-12 at 04:09Z from Wintermute's
`run.ts freeze --protocol batch4` at gbrain-evals `ecf8169c`, the merge commit of this amendment (2026-11-11T19:27:24Z),
on a clean tree, with `--gbrain` at gbrain 0.60.682.0 (`42faabf2`) and the three earlier question files as `--prior`.
`freeze.json` records `gbrain_version` 0.60.682.0, `visibility_epoch` `post_gbra_398`, the three earlier files' sha256
(each matching the values above) and a `prior_overlap` of 0 question ids, 0 forms and 0 gold pages.

- **N = 50 questions** (100 question forms), 10 of each type, and all 10 time_window questions carry a window.
- **Question file sha256:** `69f923673764fc11aa501a4d3b0efae53ff7d2ec8ce806a32176472662b3ca04`.
- **freeze.json sha256:** `ca66175ab378c2688317c057fa9e7dad0e8cad881d31af81a0d69cc1296b11f2`, committed as
  [`live-recall-batch4/freeze.json`](../live-recall-batch4/freeze.json).
- **Minimum detectable difference** in success@5 (two-sided alpha 0.05, 80% power), in points:

| Comparison | 10% discordant | 20% discordant | 30% discordant |
|---|---|---|---|
| P1 or P2 (paraphrase forms), and G2's primary `paraphrase_vs_exact_configured` | 12.5 | 17.7 | 21.7 |
| `batch1_p1_hybrid_vs_hybrid_lexical`, both forms (forms independent to fully correlated) | 8.9 to 12.5 | 12.5 to 17.7 | 15.3 to 21.7 |

Wintermute's notes on the sample, aggregates only:

- 60 distinct gold pages, chosen page first from a seeded sample (seed 20261111) drawn on 2026-11-11 at 19:31Z: 40 from
  meeting pages, 10 from company pages and 10 from conversations, none off-sample. The sample gave no other kind of
  gold page, so all 10 topic questions are about meetings.
- The sample skipped held pages, pages with a privacy label, and every batch 1 to 3 gold, stale or decoy page. A recheck
  found no access, visibility or confidentiality label on any of the 60 gold pages.
- The 10 error_string questions have 10 distinct gold pages. Their key strings appear in 1 to 14 files across the brain,
  so some are less unique than others. Each cross_source question pairs two meetings about the same company, both in
  the sample.
- 49 of the 60 gold pages carry a date in their path, and 8 of those are dated 2026-10-09 or later. Batch 2 had 33 of
  58, so batch 4 leans to older pages.
- Checks before the freeze, all passed: every gold page exists on disk and in the brain's page list, every exact form
  contains its key tokens and no paraphrase does, question ids are unique, and nothing is shared with batches 1 to 3.
- On 2026-11-11 a guard on the box refused the question build twice, before anything was saved; it was diagnosed as a
  false positive. In those attempts Wintermute drew the seeded sample, built the exclusion and page lists and read
  candidate pages. No question file was saved, nothing was frozen and nothing was searched. An error_string
  replacement planned then was never saved. The frozen file is a fresh set of 50 written from the same sample,
  exclusion list and rules, run through a workaround for that guard. It counts as batch 4: the amendment fixes the
  question set at the freeze, and no search informed it, as with batch 2's discarded draw. (On 2026-11-12, after the
  counted run, this note dropped internal tooling details about that guard; no fact about the sample or the rules
  changed.)
- The checkout ran `bun install` rather than `bun install --frozen-lockfile`. The tree stayed clean, so the lockfile
  didn't change.

**State of the brain at the freeze** (read-only, 2026-11-12 from 04:13Z to 04:15Z, just after the freeze; descriptive,
and it changes no outcome):

- **GBRA-398 relabel windows:** which windows had been applied couldn't be reconstructed on the box. Window 1 applied on
  2026-11-10 (above). The brain's checkout holds two commits titled "relabel: commit parked label writes" at 2026-11-11
  04:11Z that name no window. At about 03:50Z, 932 live pages still carried `access: private` with no `visibility`.
- **Embedding coverage:** 5.5% of chunks on live pages have no vector in the configured column (`embedding`,
  voyage-4), or 5.5% leaving out image-asset chunks. No page has synopsis vectors. Of 400 seeded-sampled media or video
  pages, none has zero chunks, 38% have under 500 characters of main-body text and 21% under 200. G2's counted synthetic
  brain copies 10% unembedded chunks, synopsis vectors off and about half the pages that aren't gold as shells, by a
  different shell rule, so the unembedded share it copies is about twice the share measured now.

**Counted run.** From gbrain-evals `ecf8169c` on a clean tree, after this entry is pushed, with `--gbrain` at the
version the box runs when the run starts, under the rule above for an upgrade between freeze and run.

## Batch 5 amendment

Fixed on 2026-11-16 by GBEV-93 (GST-2866), before any batch 5 question was written. Batch 5 is a fifth, independent set
of 50 questions, made the way batch 4 was. It re-measures configured search's paraphrase gap at gbrain's newest
release, measures gbrain's keyless partial-word fill on a real brain for the first time, and runs the build batch 4
measured on the same day, so a change in the gap can be tied to the build or to the questions. Arms, metrics,
eligibility, custody, the read-only barrier and batch 2's comparisons are unchanged. What changes: the gbrain under
test, a seventh arm that only reads, a primary for the fill, two scorecard blocks, and a rule that lets one named older
build read a brain whose schema is newer than it expects.

**The public lesson.** Whether gbrain's search on a real brain still misses questions asked in other words at its
newest release, and whether a brain with no embedding key finds more of them now that gbrain's search adds pages that
hold only some of the question's words.

**Why.**

- Batch 4's gap (configured search found 23 of 49 reworded forms against 36 of the same 49 exact ones, −26.53 points,
  interval −40.82 to −14.29) was measured on gbrain 0.60.682.0. gbrain publishes many releases a week, and a published
  number measured on an old build is re-measured at the newest release.
- gbrain#9414 (merged as `23a163fc`, first released in v0.60.725.0) adds the keyless any-word fill. On a brain with no
  embedding provider, when the all-words keyword search returns at least one row and fewer than the limit, gbrain's
  `search` and `query` operations add pages that hold only some of the question's words, after every row they returned
  before, marked `keyword_fill` (`src/core/search/hybrid/keyword-only.ts` and `src/core/ops/search-fill.ts` at
  v0.60.733.0). Its only measurement is on LongMemEval S, a public set of conversations. None of the six arms can trigger
  it: they call `hybridSearch` directly rather than the search operation, `hybrid_lexical` sets `decide.keywordOnly`,
  which turns the fill off, and every other arm runs with an embedding provider.

**System under test.** gbrain v0.60.733.0 at `6ce7195b44a034f85aec811f11fbf862db376f50`, the highest release tag on
gbrain's main branch when this amendment was written (`git ls-remote --tags`, 2026-11-16, about 20:00 UTC). If a newer
release tag exists when Wintermute freezes batch 5, a dated entry below re-pins batch 5 to it before the freeze; once
the first counted batch 5 search runs, the build is fixed for batch 5 and recorded in the results. The reference build is
gbrain 0.60.682.0 (`42faabf2`), the build batch 4 measured. Both load with `--gbrain <checkout>@<commit>`, as before.
gbrain-evals' own `package.json` pin is not the build under test, and the scorecard records both.

**Questions.** Written fresh on the box in batch 4's format and under batch 4's rules: 10 questions of each of the five
live types, an exact and a paraphrased form each, gold chosen page first from a new seeded sample, error_string gold
drawn from more than 6 pages, and a window on every time_window question. Nothing may come from batches 1 to 4: no
question id, no form (compared after folding case, spacing and punctuation), and no gold page that was a batch 1 to 4
gold, stale or decoy page.

**The freeze checks that.** Wintermute freezes with `run.ts freeze --protocol batch5`, `--gbrain` at the newest build,
and the four earlier question files, one `--prior` each. The runner checks them as it does for batch 4, against the
three sha256 values listed under batch 4 and batch 4's own,
`69f923673764fc11aa501a4d3b0efae53ff7d2ec8ce806a32176472662b3ca04`, and refuses with `LR_FREEZE_OVERLAP`, writing
nothing, if the new file shares anything with them or a file is missing or wrong. `freeze.json` records the protocol,
the question file's sha256, the counts by type, `gbrain_version`, `visibility_epoch`, the four earlier files' sha256 and
a zero `prior_overlap`. It leaves the box before any search and is committed here in a dated entry with the frozen
sample's notes.

**A seventh arm: `search_op_keyless`.** gbrain's `search` operation, called through gbrain's own dispatcher as a trusted
local caller, the way `gbrain search "<question>"` runs it on the command line, with the operation's own defaults (no
parameter but the question, so its default limit of 20 applies). It runs in a separate process that the runner starts
for this arm alone, with no embedding or reranking provider: every provider key gbrain's recipes name is blank in that
process's environment, gbrain's gateway there is configured with no key, and the process refuses to search unless
gbrain reports that neither embedding nor reranking is available. Nothing else changes: the same brain, barrier, guards
and loaded build. gbrain's AI invocation guard allows the arm no model call of any kind, and the process refuses any
HTTP request. Pages come from the response's rows in order, and each record keeps, row by row, whether gbrain marked the
row `keyword_fill`.

- **Fill on:** success@5 on the arm's first five pages.
- **Fill off:** success@5 on the first five pages of the same response after removing every row marked `keyword_fill`.
  gbrain returns the fill only when the response's other rows are exactly the response it gives without the fill
  (`chooseFill`), so this is the fill-off response without a second call.
- **Exposure:** forms where the fill fired (at least one `keyword_fill` row), forms where a fill row entered the first
  five pages, and forms where a fill row came before a row without the flag. That last count should be 0, because gbrain
  puts fill rows last; a form where it isn't 0 is counted and reported.

The arm stays out of the eligibility rule's common arms, so it changes no other arm's eligible forms or comparisons. Its
own forms count when its status is `ok`. On 0.60.682.0 the fill doesn't exist, so the arm runs the same search operation
with no fill, and its exposure must read 0 there. Every run from this amendment's runner adds the arm, batches 3 and 4
included.

**Primary for the fill.** Fill on minus fill off, success@5, on reworded (paraphrase) forms, one pair per question, at
the newest build: an exact one-sided sign test at alpha 0.05, with fill off as A and fill on as B. It is a family of
one, not Holm-adjusted with P1 and P2, because it answers a different question and drives a different decision. Fill
rows can only follow the rows already returned, so a form can move from a miss to a hit and never the other way: every
discordant pair should favour the fill, and k wins with no losses gives p = 0.5^k. The primary holds at 5 or more wins
with no losses (p = 0.031), which is 5 of 49 forms, about 10 points. A loss would mean a fill row displaced a page, and
the scorecard reports any beside the prefix count.

**Batch 2's primaries and secondaries.** P1 and P2 (paraphrase forms, Holm across the two) and batch 2's declared
secondaries are batch 5's too, replicated at the newest build. The paraphrase gap of configured search,
`paraphrase_vs_exact_configured`, is the comparison the gap rule reads. Batch 4's family band is not computed, because
nothing reads it here.

**Gap failure classes.** For configured search on each question type, the scorecard counts the questions whose exact
form it found in its first five pages and whose reworded form it didn't, split by where the reworded form's gold page
landed: ranked 6 to 20; not in its first 20 while `hybrid` or `vector` had it in their first five; or in no arm's first
five. These are counts only.

**The same-day build pair.** In one session on the box, batch 5 runs every arm at the newest build and then at
0.60.682.0, back to back, from the same runner commit, and `run.ts compare --a <0.60.682.0 run> --b <newest run>` pairs
them. The newest run is batch 5's counted run. The 0.60.682.0 run counts only for the build comparison. The fill can't
move configured search, because configured search has an embedding provider.

**The schema rule for two builds in one session.** The runner still opens a brain only when the loaded build expects
exactly the brain's schema version, with one exception: a run that passes `--reference-build` may load an older build on
a brain whose schema is newer, never the reverse, and only a build this preregistration names as a reference (here
0.60.682.0). It never migrates. The scorecard records the brain's schema version, the version the loaded build expects
and `reference_build`. So the reference run measures 0.60.682.0's search code on today's brain and schema; tables and
columns added since that build are invisible to it, and it is not the build as it was deployed on 2026-11-12. If an
older statement fails on the newer schema, the arm preflight stops the reference run before any question, and batch 5
reports the gap at the newest build with no build comparison. The newest build gets no exception: if the box upgrades
before the session and its brain's schema moves past the newest build's, the session stops before any search, and a
dated entry re-pins to the box's build when that is the newest release, before the session runs again.

**Visibility epoch.** 0.60.682.0 and 0.60.733.0 both read `post_gbra_398`, as do batch 3's freeze (0.60.623.0) and
batch 4's (0.60.682.0), so every freeze here is accepted at both builds and no new epoch rule is needed. gbrain added
access rules between the two builds (schema versions 303 to 309). Every arm here reads as a trusted local caller, the
brain's owner, and the results say if any count suggests a page became hidden to it.

**Batches 3 and 4, descriptive.** Their frozen question files and `freeze.json` run again at both builds in the same
session, from batch 5's runner commit, each under its own frozen protocol, with `run.ts compare` per batch. They are
descriptive: labelled that way, never pooled with each other or with batch 5, and they never replace batch 3's or batch
4's counted numbers.

**Decision rules.**

- **The fill holds** (5 or more wins, no losses, p below 0.05): the fill is shown to find pages on a real brain's
  keyless search, and README and the docs hub get that row, with its exposure counts.
- **The fill doesn't hold:** one R48 "Why null?" cycle, exposure first (how many reworded forms the fill fired on, and on
  how many a fill row reached the first five pages), then task fit (how many reworded forms got between 1 and 19
  all-words rows, the only case in which the fill can fire), then power, then whether all-words keyword search already
  finds the page, with a verdict of KEEP, FIX-METHOD or CUT-CANDIDATE that goes to gbrain's crew.
- **The gap is still 20 points or more at the newest build** (`paraphrase_vs_exact_configured` at or below −20 points
  with its interval excluding 0, the paraphrase-gap rule under [Decision rules](#decision-rules)): it goes to gbrain's
  crew (GBRA-108) as the top retrieval item, with batch 5's gap failure classes by question type. No private question
  goes with it.
- **The gap has closed** (that rule doesn't fire at the newest build): the reference run says whether the build closed
  it. If 0.60.682.0's gap on batch 5 doesn't fire the rule either, batch 5's questions, not the build, explain the change
  from batch 4. If it does, the build closed it when compare's `run_b_vs_run_a_configured_paraphrase` success@5 delta has
  a 95% interval above 0; otherwise the change can't be told from noise at this sample size, and the results say so.

**Power.** At N = 50, as for batches 2 and 4: 12.5, 17.7 and 21.7 points for P1, P2, the gap and the build comparison
on paraphrase forms at 10%, 20% and 30% discordant pairs. Batch 4's gap had 15 discordant pairs of 49 (31%), where the
smallest detectable gap is about 22 points. The fill's primary detects 5 of 49 forms, about 10 points.

**What leaves the box.** `freeze.json` before any search; then, after the session, `scorecard.json` and `scorecard.md`
for each run (batches 5, 3 and 4, each at both builds), `compare.json` for each batch's build pair, and the gbrain version
the box runs and the brain's schema version at the freeze and at the session. The new arm sends nothing to any provider.
`hybrid`, `configured` and `configured_window` send question forms and, for the reranker, passages to Voyage, as in
every earlier batch.

**Cost.** No paid model calls by us. Wintermute's keys pay for about one query embedding per form for `hybrid` and
`configured` and one rerank call per configured query at each build, for batch 5 and the two descriptive reruns.

**Harness changes.** The `batch5` protocol and its four-file freeze check, the `search_op_keyless` arm and its separate
process, the scorecard's fill and gap-failure blocks, and `--reference-build`, each with keyless tests on the public
live-recall-v1 fixture, go on this branch as dated commits before the counted session. The runner commit, its harness
digest and the session's commands are recorded in a dated entry before that session.

### 2026-11-16: Batch 5 frozen sample

Written after the freeze and before any batch 5 search. Frozen on 2026-11-16 at 20:21:43Z from Wintermute's
`run.ts freeze --protocol batch5` at gbrain-evals `a5041923` (the batch 5 protocol commit on this branch), in a clean
scratch clone (`bun install --frozen-lockfile` exited 0), with `--gbrain` at gbrain 0.60.733.0 (`6ce7195b`) in a
scratch clone and the four earlier question files as `--prior`. 0.60.733.0 was still gbrain's newest release tag, so
no re-pin was needed. `freeze.json` records `gbrain_version` 0.60.733.0, `visibility_epoch` `post_gbra_398` (also
0.60.682.0's epoch), the four earlier files' sha256 (each matching the values above), a `prior_overlap` of 0 question
ids, 0 forms and 0 gold pages, and the fill primary's threshold.

- **N = 50 questions** (100 question forms), 10 of each type, and all 10 time_window questions carry a window.
- **Question file sha256:** `8cc3e50f8e130b0a8820d6282327a9a33eeff4cff272ac6f264f88bc4b693039`.
- **freeze.json sha256:** `4792912a367ada70c0425dd4be80baf9099a0e216cc859d169c0a50ac2b3c27a`, committed as
  [`live-recall-batch5/freeze.json`](../live-recall-batch5/freeze.json).
- **Minimum detectable difference** in success@5 (two-sided alpha 0.05, 80% power), in points, the same as batch 4's:
  12.5, 17.7 and 21.7 for P1, P2 and the gap rule's `paraphrase_vs_exact_configured` at 10%, 20% and 30% discordant
  pairs. The fill primary holds at 5 wins with no losses, 5 of 50 reworded forms, or 10 points.

Wintermute's notes on the sample, aggregates only:

- 58 distinct gold pages, all chosen page first from a seeded sample (seed 20261116) drawn on 2026-11-16 at 20:15Z,
  before a large page import planned for the next day: 36 meeting pages, 14 company pages, 7 conversations and 1 other
  page. 400 pages were drawn from each of four pools (meetings, company pages, conversations and everything else).
- The sample skipped held pages, pages with a privacy label, pages under 600 characters, every batch 1 to 4 gold,
  stale or decoy page, and the pages of that pending import, which were not yet labelled. Sampled pages with no file
  on disk weren't used. A recheck found no access, visibility, confidentiality or `readable_by` label on any gold page.
- 43 of the 58 gold pages carry a date in their path, and 11 of those are dated 2026-10-09 or later (batch 4: 8 of 49).
- The 10 error_string questions use 8 distinct gold pages (two pages carry two errors each): 7 conversations and the 1
  other page. Each cross_source question pairs two sampled pages about the same company: 4 pair a meeting with the
  company's page, and 6 pair two meetings.
- Checks before the freeze, all passed: 50 rows with unique ids, 10 per type; nothing shared with batches 1 to 4;
  every gold page on disk, in the brain's page list and in the sample; every exact form holds its key tokens and no
  paraphrase does; every time_window question has a window and every cross_source question two gold pages; every
  error_string key string appears on its gold page. No search ran; Wintermute only read pages.
- The writer left out pages about personal matters and error-scan hits that were capitalised words rather than errors.
- The first freeze attempt (20:21:22Z) refused with `LR_QUESTIONS_INVALID` on line 1's `gold[0].slug`, because gold
  was written as plain strings rather than the `{"slug": ...}` entries the runner and RUN-KIT have always required, and
  wrote nothing. Only the gold field's shape changed before the freeze that counts.

### 2026-11-16: gbrain's home and its background upkeep during the session

Written before any batch 5 search. From gbrain v0.60.733.0 an idle `gbrain serve` runs upkeep and the conversation
archive under whatever home it shares, so this entry says what batch 5's session runs and what it allows.

- **No long-lived gbrain process.** `run.ts run` and the `search_op_keyless` process it starts load gbrain's library
  modules, search and exit. Neither starts `gbrain serve`, autopilot or the maintenance runner, and at v0.60.733.0 idle
  upkeep and the archive are started only from those (`src/commands/serve.ts`, `src/core/maintenance/idle.ts`). The
  same holds at 0.60.682.0.
- **A gbrain home of its own for each process.** Once gbrain has read the operator's config file and `~/.gbrain/.env`,
  each process copies that config file, without the database location or any credential, into its run directory
  (`gbrain-home`, and `keyless-gbrain-home` for the keyless process) and points `GBRAIN_HOME` and `HOME` there. A
  file-write trace of a full run at v0.60.733.0 on the public fixture in Postgres, as a SELECT-only role, found every
  gbrain write inside the run directory (audit files, the keyless search's backup status and a type cache), and none
  in the operator's gbrain home. Bun's `os.homedir()` reads the password database rather than `HOME`, so gbrain code
  that calls it directly would still find the operator's home; none of that code ran in the trace.
- **Upkeep.** The session's processes run none, and every brain connection goes through the read-only barrier, so any
  write would be refused and counted under `custody.guard_refusals`.
- **What this can't rule out.** The box's own gbrain install keeps running its `gbrain serve`, with idle upkeep and,
  from 0.60.733.0, the conversation archive, against the live brain the session reads. It can write pages between the
  newest and reference runs. Each scorecard records the brain's page count when the arms opened it and after the last
  search, and how many pages were written or changed since the run started (`run.brain_pages_*`). The results report
  them, and a build comparison whose two runs saw pages change says so beside its numbers.

### 2026-11-16: Batch 5 runs at v0.60.733.0 only

Written before any batch 5 search, after Garry's 2026-11-16 rule on re-runs: a published number is measured again only
when someone can name gbrain changes since its build that could move it, and otherwise it waits for the monthly refresh
on that month's `stable` tag. This entry replaces the same-day build pair and the descriptive reruns above.

- **What runs.** Batch 5 runs once, at gbrain v0.60.733.0 (`6ce7195b`), with every arm: `keyword`, `vector`,
  `hybrid_lexical`, `hybrid`, `configured`, `configured_window` and `search_op_keyless`. It is batch 5's counted run.
- **What moves to the monthly refresh.** Batch 5's run at 0.60.682.0 and its `compare`, and the descriptive reruns of
  batches 3 and 4 at both builds. The session loads no other build, and `--reference-build` stays in the runner unused.
  Batch 3's and batch 4's published numbers stay up, labelled with 0.60.641.0 and 0.60.682.0.
- **Why configured search still runs at the newest build.** `git log 42faabf2..6ce7195b` on the files configured search
  runs names two changes that could move it. gbrain #7935 (`692a11a37`, `src/core/search/exact-lookup.ts`) puts the
  best keyword match first when several exact identifier hits are promoted. It can lift exact forms only, because no
  reworded form shares an identifier token with its exact form, so it can only widen the gap. gbrain #9433
  (`d1859cb8d`, `src/core/search/rank-priors.ts`) ranks pages in the conversation-archive layout below a written page
  that scores close to them and keeps at most two per day, unless the question names a chat or a date. It can move the
  gap either way. Nothing in that range changes embedding, vector, rerank or fusion code on configured search's path,
  and the fill doesn't run there. A published gap that may have grown shouldn't stand as current, but a build comparison
  at N = 50 (17.7 to 21.7 points detectable) couldn't resolve changes this narrow.
- **The fill.** Its primary, its R48 cycle and the task-fit reading stand as written. Fill off is the same 0.60.733.0
  response without the rows gbrain marked `keyword_fill`, so the fill never used the reference run.
- **The gap rule** stands. Its last branch changes: if the rule doesn't fire at 0.60.733.0, the results report batch 5's
  gap beside batch 4's at 0.60.682.0 and say that the build, the questions and the brain's changes since 2026-11-12
  can't be told apart here. A later refresh can run the pair.
- **#9433's direction.** When the arms open the brain, the run counts its live pages in the archive layout
  (`run.archive_layout_pages`) and how many of the run's distinct gold pages are among them
  (`run.gold_pages_in_archive_layout`), using the slug pattern and sources from gbrain's `rank-priors.ts` at
  v0.60.733.0. With no such page, #9433 can't move any arm. With such pages but no gold page among them, it can only lift
  gold pages. With gold pages among them, it can also push those down on questions that name no chat or date. The
  results say which case held. The box's brain serves one person and ran 0.60.728.0 on 2026-11-16, and since 0.60.727.0
  gbrain turns the conversation archive on by default for such a brain, so archive pages may be appearing.
- **What leaves the box.** `freeze.json` (already committed), then batch 5's `scorecard.json` and `scorecard.md`, and
  the gbrain version the box runs and the brain's schema version at the session. There is no `compare.json`.
- **Cost.** Wintermute's keys pay for about one query embedding per form for `hybrid` and `configured`, and one rerank
  call per configured query, at one build. `search_op_keyless` sends nothing to any provider.

### 2026-11-18: Batch 5 runs at v0.60.737.0

Written before any batch 5 search. The box that holds the brain moved from gbrain v0.60.728.0 to v0.60.737.0
(`291b7996a`) for gbrain #9637, a security fix, and batch 5 runs at the build the box keeps, so the session's build
matches the brain's. The box's operator read back on 2026-11-18 that the upgrade is live and the brain's schema is
319; we haven't checked the box directly. Tag v0.60.737.0 peels to `291b7996a4e2881acc921b1085d818bb9640f5d0`, and no
later release is tagged. Batch 5's counted run hasn't started. This entry changes only the build of
[Batch 5 runs at v0.60.733.0 only](#2026-11-16-batch-5-runs-at-v0607330-only); the rest of that entry stands.

- **What runs.** Batch 5 runs once, at gbrain v0.60.737.0 (`291b7996a4e2881acc921b1085d818bb9640f5d0`), with every
  arm: `keyword`, `vector`, `hybrid_lexical`, `hybrid`, `configured`, `configured_window` and `search_op_keyless`. It
  is batch 5's counted run, and the box's gbrain runs the same build when the session starts.
- **The freeze stands.** `freeze.json` (sha256 `4792912a`…) records gbrain 0.60.733.0 and visibility epoch
  `post_gbra_398`. v0.60.737.0 is in the same epoch, so the runner takes that freeze unchanged. The pages the runner's
  caller can read don't change in code between the two builds: the runner reads as an unbound local caller (it refuses
  any relaxed privacy view), page read policy (`read-policy-sql.ts`, `safe-chunks.ts`) is unchanged, and the new
  visibility work in this range applies to remote callers, owner agents, credentials with a private-facts grant, or
  fact rows, none of which the runner is or ranks.
- **Schemas 318 and 319.** `v318-guard-ledgers-fail-closed` replaces seven write-guard functions, and
  `v319-principal-private-facts` adds a private-facts grant column with a constant default. Neither changes a page,
  chunk or row that a read returns. v0.60.737.0 adds no migration.
- **What can move a page rank** (`git log 6ce7195b..291b7996a` on the files the arms run):
  - gbrain #9502 (`ad6da0b72`, v0.60.734.0) caps the title step's all-words attempt at 5,000 matching pages for
    in-process searches. A question whose words match more pages than that, across titles and timelines, now ranks only
    the 5,000 with the lowest ids and puts title-only matches first (`keyword_candidates_incomplete`); at 0.60.733.0
    ranking every match could reach the statement timeout and fail the title step open (`title_arm_failed`, a
    degraded row here). Either direction. It reaches every arm built on `hybridSearch`: `hybrid_lexical`,
    `hybrid`, `configured`, `configured_window` and `search_op_keyless`, not `keyword` or `vector`.
  - gbrain #9592 (`4737c26e3`, v0.60.735.0) changes the title step's any-word retry, which runs when no page holds
    every word of a question. For an in-process caller it now matches page timelines as well as titles while every page
    matching any of the words fits the same 5,000-page cap, and titles alone, as before, when they don't. It aims at
    reworded relationship questions whose people's pages name the company only in their timelines, so it should mostly
    lift reworded forms and narrow the gap between exact and reworded questions; the extra candidates can also push a
    gold page down. On a large brain, an any-word set over 5,000 pages leaves the step as it was. It reaches the same
    arms as #9502, `hybrid_lexical` (`keywordOnly`) and `search_op_keyless` (through the search operation, called
    as a local caller) included, and not `keyword` or `vector`. The fill is unchanged: it still needs an all-words
    row.
  - gbrain #9567 (`c5a80f17f`, v0.60.735.0) reads a bare-date `since` as midnight UTC rather than midnight in the
    database session's time zone. It reaches `configured_window` only, whose windows are bare dates, and moves its
    first-day edge by the session's offset in either direction; a session in UTC sees no change.
- **What can't move a page rank in batch 5.** gbrain #9637 (`280b5a87c`) changes the text of link contexts and the
  core memory block for remote callers; relational rows keep their pages and order, and no arm returns core memory.
  gbrain #9630, #9588, #9627 and #9574 change what remote callers, owner agents and granted credentials read of facts
  and held page lines, behind checks the runner's calls don't meet (the search operation runs with `remote: false`)
  or in operations no arm calls. gbrain #9573, #9524 and #9603 change saved-fact rows, which the facts arm adds only
  after every page row, and the facts block and temporal reserve, which need a token budget the runner never passes.
  gbrain #9622 changes bounded-read cleanup and `traverse_graph`. gbrain #9656 (`15f17a311`), the one change from
  v0.60.736.0 to v0.60.737.0, changes which wishes and preferences conversation extraction keeps; it writes saved facts
  and touches no search code. Nothing in the range changes embedding, vector, rerank, fusion, exact-lookup or
  rank-priors code, so #7935's direction and the archive-layout reading of #9433 above hold.
- **Keyless check at v0.60.737.0.** `run.ts run --fixture --protocol batch5` at `291b7996a`, with every provider key
  blank and every provider and proxy address pointed at a closed local port, read schema 319, verified read-only and ran
  all 40 `search_op_keyless` forms `ok` with no provider call. It matched the same check at `6ce7195b` (v0.60.733.0) and
  at `4d1628afb` (v0.60.736.0) row for row on every arm, in first-hit rank and top ten pages: fill rows on 13 of 20
  exact forms and on none of the 20 reworded forms, and fill on and fill off level at 27, 35 and 36 of 40 at k1, k5 and
  k10. These are harness checks on the public fixture, too small to exercise the title-step changes above, not
  measurements.
- **Idle upkeep and the conversation archive.** During the session the box's own `gbrain serve` may run idle upkeep
  and the conversation archive as the box has them configured. The session doesn't stop, pause or change them, because
  batch 5 measures the live brain as it runs. The session's own processes run neither
  ([gbrain's home entry](#2026-11-16-gbrains-home-and-its-background-upkeep-during-the-session)). Upkeep's writes to
  saved facts can't move a page rank in any arm, since page search never ranks facts and the search operation adds fact
  rows only after every page row, and the pages upkeep or the archive write or change are counted in
  `run.brain_pages_*`, `run.archive_layout_pages` and `run.gold_pages_in_archive_layout`. Conversation extraction,
  which upkeep may run, keeps more wishes and preferences from v0.60.737.0 (gbrain #9656); what it keeps are saved
  facts. From gbrain #9563, a command that makes a brain shared (adding or enabling a member, setting an owner or an
  audience) keeps the archive pages written while it was personal to the owner, as an archive run on a shared brain
  already did, so no such command runs during the session. The box's operator read back on 2026-11-18, before the
  session, that the brain is personal and that no command making it shared has run since the freeze (2026-11-16
  20:21Z); we haven't checked the box directly. gbrain can also count a brain as shared when three or more
  non-automation MCP clients were active in the past 30 days (`classifyBrainAudience`), and an archive run on such a
  brain keeps the personal-era pages to the owner in the same way. The read-back didn't cover that count, so the
  session checks the audience itself, before the first search and after the last (next item).
- **The audience check.** Before the first search, the session reads the brain's audience with the box's gbrain
  v0.60.737.0, using three commands that only read:
  - `gbrain doctor --only memory_writeback --json`: the `memory_writeback` check's `details.audience` (`personal`,
    `shared` or `unknown`), gbrain's audience verdict, the client count included;
  - `gbrain transcripts archive status --json`: `rescope`, present with a `code` (such as `archive_rescope_pending`)
    when keeping the pages archived while the brain was personal to the owner is due and not done, and absent
    otherwise; and `source_id`;
  - `gbrain config get transcripts.archive.audience.<source_id>`: the audience the archive recorded at its last run.

  The session records only two things: personal or shared, and whether a re-scope is pending. The brain is personal
  when `details.audience` is `personal` and the archive's recorded audience isn't `shared`; anything else, `unknown`
  included, counts as shared. A re-scope is pending when `rescope` is present. If the brain is shared or a re-scope is
  pending, the session stops before any search and reports back to GBEV-3. After the last search it runs the same
  three reads; if either recorded value changed, the change is reported with the scorecard and noted in the results,
  and the result goes to GBEV-3 before anything is published. At `291b7996a`, keyless, on a test brain, the three
  reads changed no row in any of its 186 tables and made no provider call. With three non-automation clients logged,
  `details.audience` read `shared` and `rescope` appeared (`archive_rescope_owner_unset`), while the archive's
  recorded audience still read `personal`.
- **gbrain #9637.** No batch 1 to 5 file in this repository records link-context or core-memory text from the box: the
  freezes and scorecards carry no free text, and the plans and notes give aggregates only. Nothing published changes.
- **The run kit** names `291b7996a4e2881acc921b1085d818bb9640f5d0` in batch 5's command.

## Limits

- One writer who knows the brain writes both the questions and the gold, so paraphrase difficulty and topic choice
  follow Wintermute's sense of the brain. The identifier-overlap share and the `gold_found_by` shares are reported for
  that reason.
- A snapshot is static. A brain whose index is still building is measured in that state, and the degraded-stage counts
  show it. The counted run on Wintermute's box reads the live brain instead, so pages written during the run can change
  what it finds.
- Latency is harness latency (pool size 2; a local container for a copy, Supabase's session pooler for the counted
  run), not what Garry sees.
- The copy runs the container image's pgvector, which can differ from the live brain's, and the scorecard records both
  versions and the restore error count.
- The fixture control in CI uses hash embeddings and a token-overlap reranker. It proves the harness, not search
  quality.
