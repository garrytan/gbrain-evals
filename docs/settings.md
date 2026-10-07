# Which retrieval settings should I use?

For an agent searching long conversation histories with a small result budget, start by evaluating gbrain's
`balanced` mode. It combines search methods, uses the Voyage reranker when available, and leaves query expansion and
autocut off. That setup retrieves all labeled conversations for 451/470 answerable LongMemEval questions, counted
with opaque session ids at gbrain `109b992`. [Recount](benchmarks/2026-10-04-longmemeval-opaque-followups.md),
[original experiment](benchmarks/2026-09-06-longmemeval-ranker-wave.md).

This page describes the gbrain this repository installs, master `a865f8f` (v0.60.104.0, declared in
`package.json`). Most experiments here ran at gbrain v0.48.4.0 (`2efaaf8f`) or later commits named beside each
number. The `balanced`, `conservative` and `tokenmax` mode definitions (`MODE_BUNDLES` in
`src/core/search/mode.ts`) hold the same values from `2efaaf8f` through `a865f8f`, apart from three keys v0.60.60.0
added for the multi-relation planner (`relational_planner`, on in `balanced` and `tokenmax`). The planner plans none
of LongMemEval's 500 questions, so the conversation measurements describe the installed modes; other code differs. Existing per-key overrides take precedence over a mode, so a mode name alone
is not a complete description of an experiment. Everything above [Changelog](#changelog) is current.

## Choose by the questions you need to answer

| Workload | Starting point | Why and what to watch |
|---|---|---|
| Long conversations; questions need several old sessions | `balanced`, reranker on, expansion off, autocut off | Complete retrieval is 451/470 with reranking versus 434/470 without (opaque ids, `109b992`). Autocut discards necessary additional evidence. [Recount](benchmarks/2026-10-04-longmemeval-opaque-followups.md) |
| Exact names, identifiers, or remembered phrases | Include a keyword baseline | The `grep-only` adapter is a BM25 ranker. Compare it with gbrain on your actual phrases before paying for extra stages. [Concept comparison](benchmarks/2026-09-09-retrieval-refresh.md) |
| Choosing an embedder | `voyage-4` or `text-embedding-3-large`, with the reranker on | On 181 held-out concept questions with the reranker, `voyage-4` put an exact target first on 130, `voyage-4-large` 128, OpenAI `text-embedding-3-large` 126 and a local `qwen3-embedding:8b` 120; no embedder is shown better than `voyage-4`. The reranker adds 13 to 17 points for every embedder, at about $0.50 per 1,000 queries. A code embedder (`voyage-code-4`) did not help code search on described functions. [Embedding matrix](benchmarks/2026-10-06-embedding-matrix.md), [Cat 21](benchmarks/2026-10-06-cat21-paraphrase.md) |
| Synonyms and vague descriptions | Compare gbrain with reranking and lexical metadata gating against a vector baseline | Held-out concept nDCG@5 was 0.6619 with reranking, 0.5780 without it, and 0.6054 for vectors alone. Link popularity must not overwhelm a better match. [Concept experiment](benchmarks/2026-09-09-retrieval-refresh.md#concept-search-order-meaning-and-popularity) |
| Recognized relationship questions over linked pages | Evaluate production relationship retrieval; retain relational pin `3` with reranking | Enabling the stage raised investor first-place hits from 9/39 to 21/39. Attendance questions did not improve; link direction and parser coverage matter. [Controlled test](benchmarks/2026-09-09-retrieval-refresh.md#production-relationship-retrieval-one-switch) |
| Curated notes mixed with imported chat | Compare the measured `originals/` factor `1.5` and `openclaw/chat/` factor `0.5` with neutral `1.0` weights | The boost gained one top result out of 30, with no losses. Vector search still led this fixture. Test the preference on your own source layout. [Paired experiment](benchmarks/2026-09-09-retrieval-refresh.md#a-source-preference-is-a-choice-about-trust) |
| A few precise facts with a strict reading budget | Test adaptive return sizing with an explicit cap | Tight adaptive retrieval plus reranking measured 0.5859 mean precision and 0.8250 mean recall on PrecisionMemBench. Returning broadly measured 0.0565 precision and 0.9884 recall. [Fresh results](benchmarks/2026-09-09-retrieval-refresh.md) |

**nDCG@5** scores how well the first five pages are ordered, giving more credit
to more relevant pages near the top. **Precision** measures how much returned
material is relevant; **recall** measures how much needed material was found.
The [metric examples](retrieval-lessons.md#what-the-scores-mean) explain the
denominators and why these are separate from answer accuracy.

“On” means the feature actually ran. gbrain can continue without a reranker after
an API problem. That is useful product behavior, but a benchmark must disclose it.
The fresh experiment runners record these fallbacks and refuse to publish them
as completed reranked measurements.

## What each control means

| Control | Meaning | Guidance from the experiments |
|---|---|---|
| `search.mode` | A bundle of defaults | `balanced` is the measured small-budget conversation starting point. Individual overrides can change its behavior. |
| `search.reranker.enabled` / `.model` | Re-read and reorder candidate passages | The measured reranker is `voyage:rerank-2.5`. It needs `VOYAGE_API_KEY`; availability and latency are part of the tradeoff. |
| `search.expansion` | Generate alternative query phrasings with a language model | Off for the five-result conversation workload. At gbrain `109b992` it scores 436/470 against 434/470 without the reranker, and 442/470 against 451/470 with it, so it adds a model call per query with no measured gain. [Recount](benchmarks/2026-10-04-longmemeval-opaque-followups.md) |
| `search.expansion_variant_budget` | Total voting weight shared by query rewrites | Not a recommended setting. At `109b992` legacy weighting and `0.25` score the same (436 and 435 of 470), so the budget changes nothing measurable. |
| `search.autocut` | Trim results after a large score drop | Off for questions that may require several sessions. Off raises all-evidence recall from 384 to 451 of 470 (opaque ids, `109b992`). |
| `search.metadata_boost_gate` | Decide when link/age and other metadata bonuses may apply | `lexical` skips these bonuses on a vector-only candidate pool. Keyword, title, or relationship contributions allow them for the pool. Compare with `always` when studying this mechanism. |
| `search.relational_retrieval` / `search.relational_retrieval_depth` | Enable relationship retrieval and limit how many links it follows | `balanced` enables it at depth `2`. The controlled experiment changes only the enable switch. A question still has to match a supported relationship pattern. |
| `search.relational_rerank_pin` | Preserve a bounded number of relationship-derived results through reranking | The measured value is `3`. It protects useful graph answers; it cannot repair an incorrect link. |
| `search.adaptive_return` | Cap results according to query intent | Off for the broad-return baseline. Try it when irrelevant results cost more than missed additional evidence. |
| `search.adaptive_return_entity_max` / `_other_max` / `_min_keep` | Caps for entity questions, other questions, and the minimum kept | Product defaults are 2, 6, and 1. The tight experiment explicitly uses 1, 1, and 1. |
| `return_unit` on `search`, `query` and `recall` | How much text comes back around each hit: `chunk`, `window`, `section`, `page` or `auto` | `auto` (the default) returns the whole conversation behind each hit within a 24,000-token budget and leaves other hits as chunks. On a sealed held-out set it answered 192 of 200 against 132 for bare chunks, at about four times the reader input. Use `chunk` when reader tokens matter more than answer quality. [Sealed v2 decision](benchmarks/2026-10-02-sealed-v2-decision-1.md), [delivery study](benchmarks/2026-09-30-evidence-delivery.md) |
| `auto_chronicle` | Turn saved meeting, conversation and calendar pages into timeline events with one chat call per page (on by default since v0.60.45.0) | At the pinned `739e5cc` it writes dated follow-ups from meeting notes as events on their future dates (0.96 wrong events per page against gbrain's 0.20 gate); turn it off (`gbrain config set auto_chronicle false`) if meeting notes carry dated action items. From gbrain v0.60.49.0 (`b9ee931`, PR #6010) keep it on: it finds 37 and 38 of 38 labeled events, writes 0 events dated after their page and 0.04 wrong events per judged page, for about $0.01 per page. [Experiment](benchmarks/2026-10-04-auto-chronicle-lift.md), [rerun](benchmarks/2026-10-04-auto-chronicle-rerun.md). |
| `GBRAIN_SOURCE_BOOST` | Override the source-prefix weight map | This is an environment setting, separate from the search mode. A stale prefix can make an intended preference do nothing. |

The settings are defined in the pinned
[mode implementation](https://github.com/garrytan/gbrain/blob/2efaaf8f8a817b5b82e023383618fdcdb1cc5f7d/src/core/search/mode.ts)
and [adaptive return policy](https://github.com/garrytan/gbrain/blob/2efaaf8f8a817b5b82e023383618fdcdb1cc5f7d/src/core/search/return-policy.ts).
Mode defaults describe the product. A report's resolved configuration describes
what a benchmark actually ran.

The `balanced` mode's search limit is 25. The LongMemEval and controlled
relationship experiments explicitly request five chunks, then identify the
sessions or pages those chunks came from. Selecting `balanced` alone does not
reproduce that five-result limit. Nor does setting the relational pin enable
relationship retrieval: the pin protects results that the enabled retrieval
stage has already found.

## Set up a comparison before changing your own defaults

From an installed gbrain-evals checkout, this is a small concept-search run:

```sh
# Set VOYAGE_API_KEY in your environment first.
CAT13_PROBES=200 bun eval/runner/cat13-conceptual.ts \
  --embedding-model voyage:voyage-4 --embedding-dims 1024 \
  --reranker off --autocut off \
  --search-pin search.metadata_boost_gate=lexical
```

This is a smaller experiment than the published 500-target-probe run. The probe
builder produces the actual count reported in its receipt; the published target
of 500 produces 548 probes. Do not label a reduced run as the full benchmark.

For a local gbrain installation, the corresponding search choices can be made
explicit through its CLI:

```sh
gbrain config set search.mode balanced
gbrain config set search.reranker.enabled true
gbrain config set search.reranker.model voyage:rerank-2.5
gbrain config set search.expansion false
gbrain config set search.autocut false
gbrain config set search.metadata_boost_gate lexical
gbrain config set search.relational_rerank_pin 3
```

These commands change the target gbrain installation's configuration. They do not
choose an embedding model, rebuild existing vectors, or force an unavailable
provider to work. If you only installed gbrain as this repository's dependency,
its CLI entry point is `bun node_modules/gbrain/src/cli.ts` in place of `gbrain`.
Use the [upstream setup instructions](https://github.com/garrytan/gbrain/tree/2efaaf8f8a817b5b82e023383618fdcdb1cc5f7d#readme)
for initializing an actual knowledge store.

## Embedding models and dimensions are part of the experiment

An **embedding space** is the coordinate system produced by a particular model
and vector width. Documents and queries must use the same space. Changing the
query model while keeping old document vectors is not a valid model comparison.

The fresh baseline, relationship, source-swamp, and precision runs use
`openai:text-embedding-3-large` at 1536 dimensions. The concept matrix uses
`voyage:voyage-4` at 1024 dimensions to match the earlier concept experiment.
These are recorded experimental choices, not a claim that one model is best for
every language or corpus.

Embedding calls send document/query text to their provider. Reranking sends the
query and candidate text. Expansion sends the question to a generative model.
Count those costs and dependencies when deciding whether a configuration fits.
A keyword-only baseline provides a useful comparison without these provider calls.

## Read costs and timings carefully

A cold run may need to embed all the documents. A warm run may reuse embeddings.
Those are different workloads. The multi-adapter runner re-embeds its corpus;
the LongMemEval runner has a separate content-addressed embedding cache, and this
repository does not ship that populated cache.

The refresh publishes per-attempt API usage and gross cost estimates, plus
conservative spending reservations. A reservation is not an invoice. Timing
includes the work identified in each report: setup, ingestion, query execution,
or some combination. It should not become an unsupported production-latency claim.

## What to try next

Choose representative questions before selecting a winning setup. Include names,
paraphrases, relationship questions, changes over time, and questions with no
answer where those occur in your application. Record which documents would be
needed for a complete answer.

Run the simple baseline and gbrain on the same questions. Inspect a few gains and
losses. Check the relevant result unit and reading budget. Then vary one setting
at a time, keeping a held-out group for a final check. The
[query and adapter guide](../eval/CONTRIBUTING.md) gives the existing interfaces;
the [refresh report](benchmarks/2026-09-09-retrieval-refresh.md) gives the full
reproducible matrix used here.

## Changelog

### 2026-10-07: Installed pin moves to `a865f8f`

gbrain-evals v0.10.37. The installed gbrain commit changed from `c5fb0201` (v0.60.95.0) to `a865f8f` (v0.60.104.0). `src/core/search/mode.ts` is identical at both commits, so the mode-definition note stands with the new end commit.

### 2026-10-06: Installed pin moves to `c5fb0201`; an embedder row

gbrain-evals v0.10.37. The installed gbrain commit changed from `739e5cc` (v0.60.46.0) to `c5fb0201` (v0.60.95.0). The mode-definition note now says the bundles are unchanged except the three multi-relation planner keys, which plan no LongMemEval question. A new "Choosing an embedder" row cites the October 6 embedding matrix (reranker +13 to +17 points; no embedder better than `voyage-4`) and Cat 21's paraphrase questions (no gain from a code embedder).

How this page changed, newest first. Measurement history lives in the dated reports and in
[CHANGELOG.md](../CHANGELOG.md).

### 2026-10-05: Restructured as a current-state page with this changelog

gbrain-evals v0.10.23. The opening now quotes the opaque-id recount (451/470 at `109b992`) as the headline and states the installed pin once, replacing the list of nine commits at which the mode definitions were checked (they are identical from `2efaaf8f` through `739e5cc`). Rows that carried dated "October 4, 2026:" amendments (the long-conversation workload, `search.expansion`, `search.expansion_variant_budget`, `search.autocut`) now state only the current measurement; the September 6 values remain in the entries below and in the reports. The `auto_chronicle` row leads with the pinned behavior. A new `return_unit` row describes the `auto` evidence-delivery default and its sealed-set result (192 of 200 against 132).

### 2026-10-04: `auto_chronicle` row says keep it on from v0.60.49.0

[`bfe09be`](https://github.com/garrytan/gbrain-evals/commit/bfe09be). A rerun at gbrain `5a44025` (the head of gbrain PR #6010, released as v0.60.49.0) found the future-dated event problem fixed, so the `auto_chronicle` advice flipped from "turn it off" to "keep it on with v0.60.49.0 or later". The row now reports 37 and 38 of 38 labeled events found, 0 events dated after their page, 0.04 wrong events per judged page against gbrain's 0.20 gate, and about $0.01 per page. The `739e5cc` result (0.96 wrong events per page) stays as the reason to turn it off on older releases, and the row links the new rerun report beside the original experiment.

### 2026-10-04: New `auto_chronicle` row

[`b54b978`](https://github.com/garrytan/gbrain-evals/commit/b54b978). The controls table gained a row for `auto_chronicle`, which gbrain turned on by default in v0.60.45.0. The off-versus-on experiment at `739e5cc` found 92% to 97% of labeled events and helped "who did I meet that day" questions, but it wrote dated follow-ups from meeting notes as events on their future dates (0.96 wrong events per judged page against gbrain's 0.20 gate). The row advised `gbrain config set auto_chronicle false` when meeting notes carry dated action items.

### 2026-10-04: Installed pin moves to `739e5cc`

[`bf5fa53`](https://github.com/garrytan/gbrain-evals/commit/bf5fa53). The installed gbrain commit changed from `109b992` (v0.60.37.0) to `739e5cc` (v0.60.46.0, the agent-first operator wave). The mode-definition check added `739e5cc` (checked on 2026-10-04), so the recommendations still describe the installed modes.

### 2026-10-04: Opaque-id recount beside the September numbers

[`6bc98aa`](https://github.com/garrytan/gbrain-evals/commit/6bc98aa). The October 4 LongMemEval recount with opaque session ids at `109b992` added dated numbers without removing the September ones:

- The opening `balanced` claim of 449/470 now adds 451/470 from the recount and links the recount report.
- The long-conversation workload row adds 451 versus 434 (reranking on versus off) beside 449 versus 439.
- `search.expansion` keeps "off" but changes the reason: at `109b992` expansion no longer loses (436/470 against 434/470 without the reranker, 442/470 against 451/470 with it), so the cost is a model call per query with no measured gain.
- `search.expansion_variant_budget` notes that legacy weighting and 0.25 now score the same (436 and 435 of 470), so the budget has nothing left to repair.

### 2026-10-03: Installed pin moves to `109b992`

[`f321afb`](https://github.com/garrytan/gbrain-evals/commit/f321afb). The installed gbrain commit changed from `48ed5e8` (v0.60.32.0) to `109b992` (v0.60.37.0, fix wave 8 and Foundations 1). The mode-definition check added `109b992` (checked on 2026-10-03).

### 2026-10-02: Installed pin moves to `48ed5e8`

[`c8350c5`](https://github.com/garrytan/gbrain-evals/commit/c8350c5). The installed gbrain commit changed from `d44296c` (v0.60.30.0) to `48ed5e8` (v0.60.32.0, fix wave 7). The mode-definition check added `48ed5e8` (checked on 2026-10-03).

### 2026-10-02: Installed pin moves to `d44296c`

[`adffe95`](https://github.com/garrytan/gbrain-evals/commit/adffe95). The installed gbrain commit changed from `3a284ae` (v0.60.26.0) to `d44296c` (v0.60.30.0, fix waves 5 and 6). The mode-definition check added `d44296c` (checked on 2026-10-02).

### 2026-10-01: Installed pin moves to `3a284ae`

[`f94e98d`](https://github.com/garrytan/gbrain-evals/commit/f94e98d), gbrain-evals v0.10.5. The installed gbrain commit changed from `6c8373c` (v0.60.13.0) to `3a284ae` (v0.60.26.0). The mode-definition check added `3a284ae` (checked on 2026-10-01).

### 2026-09-30: Installed pin moves to `6c8373c`

[`1ec19a2`](https://github.com/garrytan/gbrain-evals/commit/1ec19a2), gbrain-evals v0.10.2. The installed gbrain commit changed from `608a174` (v0.60.10.0) to `6c8373c` (v0.60.13.0). The mode-definition check added `6c8373c` (checked on 2026-09-30).

### 2026-09-29: Measured version separated from installed version

[`88d0b19`](https://github.com/garrytan/gbrain-evals/commit/88d0b19), gbrain-evals v0.10.1. The page had described gbrain v0.48.4.0 (`2efaaf8f`) as the installed library. It now says `2efaaf8f` is the code measured in the September 6 and September 9 experiments, and that the repository installs gbrain master `608a174` (v0.60.10.0) from `package.json`. A new check records that the `balanced`, `conservative` and `tokenmax` definitions in `MODE_BUNDLES` have the same values at `939232f`, `b80cad6` and `608a174` (checked on 2026-09-29), so the recommendations still describe the installed modes while other code differs. "At this repository's pinned version" in the opening became "In the measured version".

### 2026-09-09: Page created

[`9238ec8`](https://github.com/garrytan/gbrain-evals/commit/9238ec8), gbrain-evals v0.8.0. The page answered "which retrieval settings should I use?" for gbrain v0.48.4.0 (`2efaaf8f`). It covered:

- A starting point: `balanced` with the reranker on and expansion and autocut off, which found all labeled conversations for 449/470 LongMemEval questions.
- A workload table: long conversations (449/470 reranked versus 439/470), exact names (keyword baseline), synonyms (concept nDCG@5 0.6619 reranked, 0.5780 without, 0.6054 vectors alone), relationship questions (investor first-place hits 9/39 to 21/39), source boosts (one top result gained out of 30) and adaptive return sizing (0.5859 precision and 0.8250 recall against 0.0565 and 0.9884 for broad return).
- A controls table explaining each `search.*` key and `GBRAIN_SOURCE_BOOST`, with links to the pinned `mode.ts` and `return-policy.ts`.
- A sample Cat13 command, the matching `gbrain config set` commands, and sections on embedding spaces, provider calls, costs and timings, and how to run your own comparison.
