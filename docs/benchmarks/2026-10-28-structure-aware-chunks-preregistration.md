# Structure-aware chunks: preregistration

Date: 2026-10-28. Thread GBRA-234 (follow-up to the STAIR paper review, arXiv 2609.03874). Runner: [`eval/runner/structure-aware-chunks.ts`](../../eval/runner/structure-aware-chunks.ts).

## Question

Should gbrain build either of two structure signals the STAIR review proposed?

1. **Idea 1, heading path in the embedding prefix.** Each chunk's heading path (minus a leading page-title heading) rides in the embed-time contextual prefix next to the title.
2. **Idea 2, chunks start at headings.** Inline pages chunk with `headingsLead`, so a heading begins its section's chunk instead of trailing the previous one.

Plus the keyless sub-arm a default repo-less install would use: the heading path added to each chunk's `search_vector` at weight C (no embeddings), and idea 2 on a keyless brain. Approved scope: retrieval only, at most $15 of embeddings, no paid model calls. Idea 3 (section delivery to a reader) is not part of this run.

## Evidence class

Development evidence. Corpus A is the messy-company dev split (held-out untouched); corpus B is the public Qasper dev split. A win here earns a build proposal, not a default flip; any build goes through autoplan and Garry's approval and would carry its own confirmation.

## Build and data

- gbrain: master `5af37ba4445547b150ba1a4432f07fafe01c43c6` (v0.60.482.0) plus a local experiment commit `26e2c03b048cac41eb5f0af2331cbe5710b3600a` that is never pushed to gbrain. Its full diff is committed here as [`2026-10-28-structure-aware-chunks-gbrain-experiment.patch`](2026-10-28-structure-aware-chunks-gbrain-experiment.patch) (sha256 `0c7cb1ae7849a145bffedc51a2a8766ba0601f4b9c812d24af863bd3bdf75336`). Both ideas sit behind env flags (`GBRAIN_EXP_HEADING_PREFIX=1`, `GBRAIN_EXP_HEADINGS_LEAD=1`); with neither set the build behaves as master. Loaded through `gbrain-under-test.ts` (`--gbrain /workspace/gbrain@exp/structure-aware-chunks`), which verifies the copied tree.
- Corpus A: `eval/data/messy-company-v1/corpus/dev` (118 pages; concatenated sha256 `e10a158ca863abccc0a133e37c6082e1d282b5a8d17ee26c39b42e35069e151a`) and `labels/governing-records/dev.jsonl` (sha256 `f5a5a59cd5474044cfb67bf6cdf437e507899ba17fd3934178bee9ce63fbb036`).
- Corpus B: Qasper dev v0.3 (`qasper-dev-v0.3.json`, 281 papers, sha256 `2ae7ee62a65b1c4225791c70de80c2aad4e8998cf1fd4f09a53103db4f21af93`; the runner refuses another hash). Each paper is rendered as markdown: title, abstract, then one `##` heading per section.
- No seeds: no sampling anywhere. Embeddings are `openai:text-embedding-3-large` at 1536 dims through an embedding cache, so a re-run reproduces the vectors.

## Arms

All arms: gbrain `balanced` search mode, reranker off, query expansion off, query cache off (pins are read back and the run refuses if they did not apply). No LLM runs anywhere.

| Arm | Heading prefix | headingsLead | Embeddings | Heading terms in search_vector |
|---|---|---|---|---|
| `base` (comparator) | no | no | yes | no |
| `prefix` | yes | no | yes | no |
| `lead` | no | yes | yes | no |
| `prefix_lead` | yes | yes | yes | no |
| `kw_base` (keyless comparator) | no | no | no | no |
| `kw_lead` | no | yes | no | no |
| `kw_terms` | no | no | no | yes (weight C) |
| `kw_lead_terms` | no | yes | no | yes (weight C) |

The terms arm is applied by the runner with SQL after import, because no column stores a heading path today.

## Measurements, metric and denominator

**Corpus A, deciding measurement (`aw`).** All 118 dev pages are imported into one brain. One question per (account, attribute) labelled in `governing-records/dev.jsonl`, written from the runner's fixed templates (`ACCOUNT_NAMES`, `ACCOUNT_QUERIES`): 39 questions. A question hits at k when one of `hybridSearch`'s top k rows (gbrain returns one chunk per page) contains a labelled deciding passage for that account and attribute.

This replaces the within-document design for corpus A. The plan run showed that only 2 of the 18 dev documents that carry deciding passages split into at least 4 chunks, which leaves 10 within-document questions, too few to decide anything. That within-document cell (`a`) is still run and reported, but it does not decide.

**Corpus B (`b`), within-document.** Each paper is imported into a per-arm brain on its own, its questions run, then it is removed. Papers that split into fewer than 4 chunks are excluded (5 of 276 papers with usable evidence), leaving 271 papers and 880 questions. A chunk hits when it holds a 20-word run of a Qasper evidence paragraph, or a whole evidence paragraph of 5 to 19 words. hit@k ranks the paper's chunks by reciprocal-rank fusion (k = 60) over gbrain's two chunk-grain legs: `searchKeywordChunks` and the cosine of the query embedding with each stored chunk vector (keyless arms use the keyword leg alone). The `lead hit` secondary is whether `hybridSearch`'s single row for the page is a gold chunk.

**Primary metric:** hit@3, one row per question. The analysis unit is the question, with paired comparisons between arms on the same questions. A question whose search throws counts as a miss and is listed. Every live cell must have 0 errors and no deferred embedding, or it is rerun before any contrast is read.

**No-regression check.** gbrain's inline adapter, loaded from the same experiment build with the arm's flags set, scores Cat 13 (world-v1, 548 probes, nDCG@5 graded, reranker and autocut off) and Cat 13b (source-swamp-v1, 30 queries, top-1 hit rate, the category's own pins) for `base`, `prefix`, `kw_base` and `kw_terms`. The guard (`guard` subcommand) showed the `lead` arms produce chunks and embedding inputs identical to `base` on every Cat 13 and Cat 13b page, so they cannot change either category and are not rerun. `prefix` changes one chunk per page there (the `## Timeline` section), so it must be measured.

## Decision rule

A contrast's rule is met when all of these hold:

1. hit@3 net wins (treatment-only hits minus control-only hits) are greater than 0 on `aw`, and greater than 0 on `b`.
2. Exact two-sided McNemar on the pooled `aw` + `b` questions (919) gives p < 0.05.
3. No Cat 13 or Cat 13b regression: Cat 13 nDCG@5 falls by no more than 0.01, Cat 13 strict P@1 is not significantly worse (exact McNemar, p < 0.05 with more losses than wins), and Cat 13b top-1 hits fall by no more than 1 of 30 queries, with 0 errors.

**Primary contrast:** `prefix` vs `base` (idea 1), alpha 0.05, no correction.

**Secondary family**, Holm-corrected across its four pooled p-values: `lead` vs `base`; `prefix_lead` vs `prefix` (idea 2 on top of idea 1); `kw_terms` vs `kw_base`; `kw_lead` vs `kw_base`. Condition 3 for an arm that includes `lead` uses the arm without it, because `lead` is a no-op there.

**Descriptive only:** `prefix_lead` vs `base`, `kw_lead_terms` vs `kw_base`, every contrast on the within-document corpus A cell `a`, hit@1, and lead hit.

**Resolution.** With 919 pooled questions and about 10% discordant pairs (about 92), p < 0.05 needs roughly a 56 to 36 split, a net gain of about 2 points of pooled hit@3. A smaller true effect will read as inconclusive, which this run reports as "no detectable gain", not as "no effect". Corpus A alone (39 questions) can only show direction.

## What each outcome changes

| If it wins | If it loses | If inconclusive or at the ceiling |
|---|---|---|
| Idea 1: write an autoplan build proposal for the heading-path prefix (it changes embedding inputs, so it needs a re-embed plan). Idea 2 wins on top of idea 1: add headingsLead to the same proposal with its rechunk cost; idea 2 wins only alone: propose it separately. Keyless terms win: propose a stored heading-path field for search_vector. | Drop the idea. If idea 1 fails on both corpora, also drop idea 3, since the structure signal is already captured by titles and page-grain fusion. | Report "no detectable gain at this size" and recommend no build; a larger run is only worth it if one corpus moves and the other is flat. |

## Budget

Embedding spend only, list price $0.13 per million input tokens, enforced per process by `--budget-usd` (each batch is refused if it would pass the cap) and recorded per cell from provider-reported tokens. Cold-cache estimate from the plan run: about $1.12 for the four embedding arms on both corpora; Cat 13 and Cat 13b add a few cents. Per-process caps: `b` $1.00 per arm, `aw` $0.25, `a` $0.10, Cat 13 $0.50, Cat 13b $0.10, a worst case of $6.60 against the approved $15. If a cap is reached the cell stops and is reported as incomplete; nothing is rerun past $15 total.

## Amendments

None yet.
