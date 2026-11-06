# Live recall on Garry's brain: preregistration (phase 1)

This fixes the method, comparisons and decision rules for each live-recall question set before that set is searched.
It reports no result; batch 1's results are in the [batch 1 findings](../2026-11-06-live-recall-batch1.md). Batch 1's
sample size (50 questions), question file hash and minimum detectable difference are under
[Frozen sample](#frozen-sample), taken from Wintermute's freeze output before the counted run. A second, independent
question set, batch 2, runs under the [batch 2 amendment](#batch-2-amendment), fixed before that set was frozen.

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

Phase 2 stays held until batch 2 lands.

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
