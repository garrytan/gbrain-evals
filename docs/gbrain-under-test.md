# The gbrain under test

This page names the gbrain that every result in this repository is read against, says what it does, and lists how its
search and read defaults differ from the earlier commits some results were measured at. The [README](../README.md)
gives the results; this page holds the version detail behind them. Every row of the README and of the
[documentation hub](README.md) links to a report, and each report names the gbrain build it measured.

## The pin

This repository installs gbrain v0.60.771.0 ([`97ef356f5`](https://github.com/garrytan/gbrain/tree/97ef356f574a66709ef1bf4ae1cad604727852d8)), gbrain's newest release on 2026-11-25.
It is declared as `gbrain` in `package.json`, and this is the one page that names it: the README and the other hub
pages link here. Every new run measures gbrain's newest release ([CLAUDE.md, "Choose the gbrain
build"](../CLAUDE.md#choose-the-gbrain-build)), and `bun eval/runner/gbrain-pin.ts bump` moves the pin there when gbrain
tags a newer one, rewriting the line above. That is newer than gbrain's own default install, which follows its `stable`
channel: stable moves to a release only after extra testing ([gbrain's
STABILITY.md](https://github.com/garrytan/gbrain/blob/master/docs/STABILITY.md)). The rest of this page, and what the hub
pages say gbrain does, were last read against v0.60.733.0; [gbrain's
CHANGELOG](https://github.com/garrytan/gbrain/blob/master/CHANGELOG.md) lists what each later release changed. Two
fixed-purpose aliases, `gbrain-cues` (`939232f`) and `gbrain-reader` (`e78f1c3`), are frozen pins of the experiments
that name them and don't move with `gbrain`. gbrain-evals itself is at the release [`VERSION`](../VERSION) names, and
[CHANGELOG.md](../CHANGELOG.md) records each release.

## What gbrain does

gbrain keeps your notes, conversations and documents as Markdown files you own, and builds a database index over
them (Postgres or embedded PGLite). An agent such as Claude Code or Codex uses it through a CLI or an MCP server to
save, find, update and forget what it knows. The parts that matter for an agent:

- **Hybrid retrieval.** Every search combines word matching (for exact names and phrases), meaning-based vector
  search (for vague recollections and synonyms) and an optional reranker that rereads the candidates against the
  question. [How the pieces work together](retrieval-lessons.md). Without an embedding key, `search` and `query` still
  find pages that hold most of the question's words when too few pages hold all of them.
- **Relationships as evidence.** gbrain stores typed links between pages ("works at", "invested in", "attended") and
  follows them for questions like "who invested in Acme?", where the answer page may never mention the question's
  words.
- **Whole conversations for the reader.** Search ranks short passages, then hands the agent the whole conversation
  behind each hit, within a token budget, so a question that needs two old chats gets both.
- **Memory that stays correct.** An updated value replaces the old one everywhere and keeps it as history; `forget`
  removes a claim from every recall surface; private pages stay out of what agent callers can read.
- **Memory that says where it came from.** Everything an agent reads back is labelled by its source: your notes,
  something you told your agent, something an agent wrote, or outside content such as an email. A write gate flags
  instruction-like text, and a purge removes a claim from every store, with a record of what was removed.
  [What the labels change](benchmarks/2026-10-08-memory-trust-results-paid.md).
- **Built to be run by an agent.** Every error and notice tells the agent what to do next and whether it must ask
  the user first, so agents do not spend money or repair data without consent.
- **A write path you can measure.** Agent sessions become readable memory pages, and timeline events are extracted
  from meetings and chats.
- **An archive of your agent conversations.** On a personal brain, gbrain saves each day of the conversations your
  agent harnesses keep on your machine as one redacted, searchable page per conversation, plus a daily index. Archive
  pages rank a little below the pages you wrote, and `gbrain transcripts archive off` turns it off.
- **One brain for you, your company or a group.** `gbrain setup claude-code --shape personal|company|both` (or `codex`)
  starts a brain with pages about you, a company part beside your own notes, or both. A brain can serve several people, each with their own
  key and a folder only they can read. Notes from people in a group chat are kept apart as guest notes until you take
  them, and a read can be marked with whether the people in a given chat could see it.

## Results measured at other commits

Some results were measured at earlier commits than the pin; each names its commit. Every commit the README names is in
the release's history except three pull-request builds: `a7cb37b`, the September 29 branch commit whose retrieval the
reader replay row froze; `94bd52e01`, the multi-relation planner's held-out build (merged in v0.60.60.0); and
`079941d2`, the build behind the row on keeping useful material when an agent session becomes a memory page (shipped as
v0.47.8.0).

## Search defaults that changed since then

The search modes held the same values from v0.48.4.0 through v0.60.169.0. Since then:

- the default reranker became Voyage `rerank-3-lite` (was `rerank-2.5`, v0.60.223.0);
- `tokenmax` stopped expanding queries (v0.60.250.0);
- every mode turned on result-time collapse and rank priors (`search.collapse`, `search.rank_priors`, v0.60.332.0):
  same-slug twins in other sources, merge stubs and copies of one document fold into one result row, and organization,
  OCR and date priors adjust the ranking after the reranker;
- two keys joined the modes, off in every one (v0.60.710.0): `search.qualified_aliases` brings a page to the top when
  a 3- to 6-word phrase inside a longer question is its alias, and `search.title_qualified` boosts a person or company
  page whose title appears inside the question;
- on a brain with no embedding provider, a `search` or `query` whose first page of results is short adds, after the
  rows it already had, pages that hold only some of the question's words, with no setting to turn it off
  (v0.60.725.0). It runs in the `search` and `query` operations; runners here that call gbrain's hybrid search function
  directly don't ask for it;
- conversation archive pages rank under a 0.8 prior, and one result list keeps at most two archive hits per day
  unless the question asks about a conversation or a date (v0.60.726.0; `search.rank_priors false` turns both off).

On 300 LongMemEval-S questions the reranker and expansion changes each kept retrieval within their preregistered
margins ([reranker addendum](benchmarks/2026-10-13-rerank3-addendum-preregistration.md),
[expansion latency](benchmarks/2026-10-14-expansion-latency-preregistration.md)); collapse and rank priors have no
such check here, and neither do the changes since v0.60.623.0. Retrieval results measured before v0.60.223.0 used
`rerank-2.5`, results measured before v0.60.332.0 ran without collapse or rank priors, and keyless results measured
through `search` or `query` before v0.60.725.0 ran without the partial-word fill.

## Read defaults that changed after v0.60.454.0

Five read defaults outside the mode bundles changed after v0.60.454.0:

1. A `query` with a token budget leads with up to 40 dated saved facts, and since v0.60.555.0 never more than its
   `limit` (`search.query_facts_block`, v0.60.491.0); a `query` without a budget gets no facts block, so its
   `limit` caps the whole result.
2. `search` puts a newer correction ahead of the saved fact it corrects (`search.saved_facts_supersede`,
   v0.60.493.0).
3. A remote `search` or `query` that names no `limit` keeps every page that matched its words but at most 3 pages
   that matched only by meaning (`search.remote_page_cap`, v0.60.506.0).
4. Text from conversation, chat, email and meeting pages comes back inside a quote fence, marked as source material,
   from `search`, `query`, `assemble_evidence` and `think`, and over MCP from `get_page`, `fetch`, `recall`,
   `delta` facts and hot memory (v0.60.507.0, v0.60.521.0).
5. Since v0.60.536.0 a remote reader, such as an agent over MCP, also gets any text below the owner's own notes in
   that fence: text an agent wrote, tool data, external text and text with no recorded origin, on search, recall, page,
   chunk, timeline, version and write-receipt reads, and from v0.60.538.0 to v0.60.541.0 on chronicle and takes reads,
   timeline sources, ontology values and a quoted page's title, tags and frontmatter.

Local reads are unchanged, no setting turns either fence off, and `gbrain trust claim-sources` with `gbrain trust
backfill` marks an owner's older notes as theirs.

Apart from the keyless memory trust checks in the README's memory trust row, and live recall phase 2, which ran gbrain
0.60.613.0 (a release after all five changes) on the live brain's own configuration, no result in the README was
measured with these defaults. The memory question-answering harness holds the first three at their old values and
unwraps the fence on its `query` path, which reads locally
([`eval/runner/gbrain-under-test.ts`](../eval/runner/gbrain-under-test.ts)). Setups that run the pinned gbrain with its
own defaults (the open-source comparison, the hard company benchmark's MCP setup and the agent tool bridges) take all
five as shipped. The scoreboard's gbrain-defaults container builds its own gbrain, `f05943e6` (v0.60.138.0), so it runs
none of them. gbrain's changelog names none of the five between v0.60.623.0 and v0.60.733.0, and the three keys the
harness holds keep their names and defaults.

## Other changes since v0.60.623.0

- **Agent arms on GPT models.** `get_page` with `known_as_of` and `traverse_graph` with `hops` set aside the arguments
  they don't use instead of refusing the call (v0.60.671.0), and gbrain's tool loop sends OpenAI tool definitions
  without strict mode, so the model no longer fills every optional argument (v0.60.675.0). Replayed at `6ce7195b4`,
  480 of GPT-6.1 Sol's 651 recorded SkillOpt page and graph calls read, against 472 at `d253ec0ff`
  ([`test/eval/skillopt-tool-calls.test.ts`](../test/eval/skillopt-tool-calls.test.ts)).
- **Deletes and purges hide more.** A soft-deleted page's facts, timeline rows, tags and links are hidden from every
  caller, local ones included (v0.60.639.0, v0.60.641.0). A purge expires the facts filed on the purged page
  (v0.60.642.0) and the extracted facts that name it (v0.60.723.0), and a forgotten fact stays forgotten when
  extraction runs again (v0.60.639.0).
- **Upkeep while `gbrain serve` is idle.** An open `gbrain serve` runs gbrain's free upkeep when its agent goes quiet,
  at most one full round a day (v0.60.715.0), and on a personal brain that upkeep includes the conversation archive. A
  harness that drives `gbrain serve` through a long run can see links, timeline rows and archive pages change
  mid-run; `gbrain config set maintenance.auto false` turns the upkeep off.
- **Postgres over the network needs TLS.** A Postgres URL for any host other than this machine, Docker service names
  included, now requires TLS unless it says `sslmode=disable` (v0.60.653.0). PGLite is unchanged.
- **The same library surface.** No package export or source file was removed or renamed between the two releases.
  One export was added (`gbrain/skill-resolver`), and the install no longer runs a `postinstall` step: migrations run
  on the first command instead.
- **Shared and remote brains.** Most of the other releases change what callers of a brain shared by several people,
  or reached over MCP, can read and write: rooms, guest notes, members kept to labelled pages. A local owner's reads
  are unchanged.

## When the keyless correctness checks last ran

The README's correctness rows (updates, `forget`, privacy, chat formats) come from keyless checks on synthetic worlds
with generated answer keys. The [November 16 keyless re-pin](benchmarks/2026-11-16-w0-keyless-repin.md) reran
updates, `forget`, privacy on Postgres over real HTTP, the lifecycle matrix and large pages at gbrain's newest
release, `6ce7195b4` (v0.60.733.0), and read privacy in process and chat formats from CI's gates at that build. The
README's rows for updates, `forget`, privacy and chat formats now name `6ce7195b4`; large pages keep `7a6bdd3`. The
other keyless rows last ran in full at
`77cf8e111`, in the [October 11 re-pin](benchmarks/2026-10-11-wave14-repin.md), and wait for the December refresh on
that month's stable build. CI's keyless BrainBench tier
runs the same checks on every pull request against the gbrain `package.json` pins, smaller (the update and `forget`
worlds on a slice, privacy in process only), and every one passed at `6ce7195b4` in [the checks on pull request
#448](https://github.com/garrytan/gbrain-evals/actions/runs/43940805988), as did the large-page check's small tiers. The
29 reproductions in the [bug ledger](benchmarks/2026-10-01-wave-bugs.md) and three memory trust reproductions (37-1,
37-2 and 37-5 in the [memory trust ledger](benchmarks/2026-10-07-memory-trust-bugs.md)) last ran as a set in that
October 11 re-pin, where they passed; the timeline-latency entry (Cat7-1) passed on the second pair of hosts, and stays
open under its stricter closure rule (see the README's known limits). The 10 privacy and data-loss reproductions among
them ran again at `6ce7195b4`: 9 behave as recorded, and N2-2 (`find-contradictions` with no `--source`) is fixed.
Rows marked `c5fb0201` were measured in the October round at an earlier pin (the paid runs and the attendance world).

## Changelog

### 2026-11-25: Re-pin to gbrain `97ef356f5` (v0.60.771.0)

`bun eval/runner/gbrain-pin.ts bump` moved the pin from `38831bb69` (v0.60.769.0) to `97ef356f5` (v0.60.771.0),
2 releases and 19 commits later. Only the pin line changed, and no result was rerun.

### 2026-11-24: Re-pin to gbrain `38831bb69` (v0.60.769.0)

`bun eval/runner/gbrain-pin.ts bump` moved the pin from `7f1623446` (v0.60.748.0) to `38831bb69` (v0.60.769.0),
21 releases and 162 commits later. Only the pin line changed, and no result was rerun.

### 2026-11-19: Re-pin to gbrain `7f1623446` (v0.60.748.0)

`bun eval/runner/gbrain-pin.ts bump` moved the pin from `7d45c5d17` (v0.60.747.0) to `7f1623446` (v0.60.748.0),
1 releases and 14 commits later. Only the pin line changed, and no result was rerun.

### 2026-11-19: Re-pin to gbrain `7d45c5d17` (v0.60.747.0)

`bun eval/runner/gbrain-pin.ts bump` moved the pin from `16124807c` (v0.60.743.0) to `7d45c5d17` (v0.60.747.0),
4 releases and 26 commits later. Only the pin line changed, and no result was rerun.

### 2026-11-19: Re-pin to gbrain `16124807c` (v0.60.743.0)

`bun eval/runner/gbrain-pin.ts bump` moved the pin from `6ce7195b4` (v0.60.733.0) to `16124807c` (v0.60.743.0),
10 releases and 101 commits later. Only the pin line changed, and no result was rerun.

### 2026-11-16: The keyless correctness checks at gbrain v0.60.733.0

The opening says that every row of the README and the documentation hub links to a report, and that each report names
the gbrain build it measured. "When the keyless correctness checks last ran" now names the [November 16 keyless
re-pin](benchmarks/2026-11-16-w0-keyless-repin.md) at `6ce7195b4`: which rows it reran, which it read from CI, which
keep `77cf8e111` until the December refresh, and what the 10 privacy and data-loss reproductions showed.

### 2026-11-16: Two lines name v0.60.733.0 instead of the pin

The read-defaults paragraph says gbrain's changelog names none of the five between v0.60.623.0 and v0.60.733.0 (was
"the pin"), and the replay of GPT-6.1 Sol's recorded calls reads "at `6ce7195b4`" (was "at the pin"), so a later
re-pin doesn't carry those claims to a build nobody checked.

### 2026-11-16: This page alone names the pin

The pin sentence is a line of its own, with the commit linked, that `bun eval/runner/gbrain-pin.ts bump` rewrites; each
bump also adds its own entry here. The README and the hub pages now link to this section instead of naming the commit,
so a bump changes one page. The section says the page's descriptions were last read against v0.60.733.0 and links
gbrain's CHANGELOG for later releases, and the STABILITY.md link follows gbrain's master instead of one release. Nothing
else on the page changed.

### 2026-11-16: Re-pin to gbrain `6ce7195b4`, gbrain's newest release

The pin moves from `d253ec0ff` (v0.60.623.0) to `6ce7195b4` (v0.60.733.0), 110 releases later, and the page says the
pin now follows gbrain's newest release, newer than gbrain's `stable` channel, while `gbrain-cues` and `gbrain-reader`
stay frozen. "What gbrain does" adds keyless partial-word search, the conversation archive and brains for a company or
for several people. "Search defaults" adds `search.qualified_aliases` and `search.title_qualified` (off in every mode),
the keyless partial-word fill and the archive's rank prior. A new section, "Other changes since v0.60.623.0", covers
agent arms on GPT models, deletes and purges, idle upkeep under `gbrain serve`, Postgres TLS, the library surface and
shared brains. The keyless correctness checks name the CI run on pull request #448 at the new pin (was `3ec766c40` on
pull request #223). No result was rerun.

### 2026-11-09: Page created from the README's "The gbrain under test"

The README's section "The gbrain under test" (the pin and its aliases, the three pull-request builds outside the
release's history, the search defaults changed since v0.60.169.0 and the five read defaults changed after v0.60.454.0),
its capability list under "What gbrain does" and the paragraph on when the keyless correctness checks last ran moved
here, so the README can open with results; the pin table stays in the README's quick start. The text is the README's at
gbrain-evals v0.10.188, with four changes: the pin table is a paragraph, the five read defaults are a numbered list,
internal names in prose became plain descriptions ("the keyless memory trust checks" for "Cats 37 to 39", "the build
behind the row on keeping useful material when an agent session becomes a memory page" for "Cat 35's post-wave build",
"the large-page check's small tiers" for "N14's small tiers", "the open-source comparison" for "the shootout", "CI's
keyless BrainBench tier" for "the BrainBench offline tier"), and links point from `docs/`. No number changed. The
sentence on which README results ran with the five read defaults also names live recall phase 2, which the README gained
in the same change.
