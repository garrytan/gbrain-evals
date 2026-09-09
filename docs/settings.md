# Which retrieval settings should I use?

For an agent searching long conversation histories with a small result budget,
start by evaluating gbrain's `balanced` mode. At this repository's pinned version,
it combines search methods, uses the Voyage reranker when available, and leaves
query expansion and autocut off. That setup retrieved all labeled conversations
for 449/470 answerable LongMemEval questions. It is a useful starting point backed
by a specific experiment. [September 6 results](benchmarks/2026-09-06-longmemeval-ranker-wave.md).

These recommendations refer to **gbrain v0.48.4.0, commit `2efaaf8f`**, the library
installed by this repository. Existing per-key overrides can take precedence over
a mode. A mode name alone is not a complete description of an experiment.

## Choose by the questions you need to answer

| Workload | Starting point | Why and what to watch |
|---|---|---|
| Long conversations; questions need several old sessions | `balanced`, reranker on, expansion off, autocut off | Complete retrieval was 449/470 with reranking versus 439/470 without. Autocut discarded necessary additional evidence. [Experiment](benchmarks/2026-09-06-longmemeval-ranker-wave.md) |
| Exact names, identifiers, or remembered phrases | Include a keyword baseline | The `grep-only` adapter is a BM25 ranker. Compare it with gbrain on your actual phrases before paying for extra stages. [Concept comparison](benchmarks/2026-09-09-retrieval-refresh.md) |
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
| `search.expansion` | Generate alternative query phrasings with a language model | Off for the measured five-result conversation workload. Expansion introduced substantial losses there. |
| `search.expansion_variant_budget` | Total voting weight shared by query rewrites | `0.25` repaired part of the expansion loss but still underperformed no expansion. It is not the recommended default. |
| `search.autocut` | Trim results after a large score drop | Off for questions that may require several sessions. In the recorded comparison, off improved all-evidence recall by 70 questions. |
| `search.metadata_boost_gate` | Decide when link/age and other metadata bonuses may apply | `lexical` skips these bonuses on a vector-only candidate pool. Keyword, title, or relationship contributions allow them for the pool. Compare with `always` when studying this mechanism. |
| `search.relational_retrieval` / `search.relational_retrieval_depth` | Enable relationship retrieval and limit how many links it follows | `balanced` enables it at depth `2`. The controlled experiment changes only the enable switch. A question still has to match a supported relationship pattern. |
| `search.relational_rerank_pin` | Preserve a bounded number of relationship-derived results through reranking | The measured value is `3`. It protects useful graph answers; it cannot repair an incorrect link. |
| `search.adaptive_return` | Cap results according to query intent | Off for the broad-return baseline. Try it when irrelevant results cost more than missed additional evidence. |
| `search.adaptive_return_entity_max` / `_other_max` / `_min_keep` | Caps for entity questions, other questions, and the minimum kept | Product defaults are 2, 6, and 1. The tight experiment explicitly uses 1, 1, and 1. |
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
