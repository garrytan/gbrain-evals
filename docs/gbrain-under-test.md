# The gbrain under test

This page names the gbrain that every result in this repository is read against, says what it does, and lists how its
search and read defaults differ from the earlier commits some results were measured at. The [README](../README.md)
gives the results; this page holds the version detail behind them.

## The pin

This repository installs gbrain v0.60.623.0 (`d253ec0ff`), declared as `gbrain` in `package.json`. Two
fixed-purpose aliases, `gbrain-cues` (`939232f`) and `gbrain-reader` (`e78f1c3`), are used only by the experiments
that name them. gbrain-evals itself is at the release [`VERSION`](../VERSION) names, and
[CHANGELOG.md](../CHANGELOG.md) records each release. The README's quick start shows the same pin as a table.

## What gbrain does

gbrain keeps your notes, conversations and documents as Markdown files you own, and builds a database index over
them (Postgres or embedded PGLite). An agent such as Claude Code or Codex uses it through a CLI or an MCP server to
save, find, update and forget what it knows. The parts that matter for an agent:

- **Hybrid retrieval.** Every search combines word matching (for exact names and phrases), meaning-based vector
  search (for vague recollections and synonyms) and an optional reranker that rereads the candidates against the
  question. [How the pieces work together](retrieval-lessons.md).
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
  OCR and date priors adjust the ranking after the reranker.

On 300 LongMemEval-S questions the reranker and expansion changes each kept retrieval within their preregistered
margins ([reranker addendum](benchmarks/2026-10-13-rerank3-addendum-preregistration.md),
[expansion latency](benchmarks/2026-10-14-expansion-latency-preregistration.md)); collapse and rank priors have no
such check here. Retrieval results measured before v0.60.223.0 used `rerank-2.5`, and results measured before
v0.60.332.0 ran without collapse or rank priors.

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
none of them.

## When the keyless correctness checks last ran

The README's correctness rows (updates, `forget`, privacy, chat formats) come from keyless checks on synthetic worlds
with generated answer keys. Their counts were last measured in full at `77cf8e111`, in the [October 11
re-pin](benchmarks/2026-10-11-wave14-repin.md); no re-pin since has rerun them in full. CI's keyless BrainBench tier
runs the same checks on every pull request against the gbrain `package.json` pins, smaller (the update and `forget`
worlds on a slice, privacy in process only), and every one passed at `3ec766c40` in [the checks on pull request
#223](https://github.com/garrytan/gbrain-evals/actions/runs/41270941149), as did the large-page check's small tiers. The
29 reproductions in the [bug ledger](benchmarks/2026-10-01-wave-bugs.md) and three memory trust reproductions (37-1,
37-2 and 37-5 in the [memory trust ledger](benchmarks/2026-10-07-memory-trust-bugs.md)) last ran as a set in that
October 11 re-pin, where they passed; the timeline-latency entry (Cat7-1) passed on the second pair of hosts, and stays
open under its stricter closure rule (see the README's known limits). Rows marked `c5fb0201` were measured in the
October round at an earlier pin (the paid runs and the attendance world).

## Changelog

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
