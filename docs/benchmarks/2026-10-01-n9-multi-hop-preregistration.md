# N9 multi-hop with held-out wording: preregistration (2026-10-01)

Frozen before the first scoring run, in a commit separate from the runner. It covers the hermetic arm and the paid arm of the `multi-hop-paraphrase` category (legacy alias N9) and the paid one-hop paraphrase rerun of `relational-ab` at the wave pin. Nothing here gates CI: the registry rows have no safety contract and no quality threshold, so every number below is exploratory and the decision rules only decide what the report may claim.

## What is measured

- **Question set.** `eval/data/n9-multihop-paraphrase-v1/questions.json`, SHA-256 `1a2bdd9c00dbb1c106d117dae1005a8a903a9f9a4a299546d3edea2bb0def396`, committed in `9a0603a` before any scoring. 125 composed questions over world-v1: 94 two-hop and 31 three-hop, in seven families. Each question has a canonical wording (plain relation verbs, split `composed-template`) and one seeded paraphrase (split `composed-paraphrase`). Gold comes from the generator-written `_facts` chains, never from gbrain.
- **System under test.** gbrain `3a284aea26889b77c633aebb4149c3016d834ee6` (v0.60.26.0), loaded through a copied overlay (`--gbrain <checkout>@3a284ae`), with System One off (keys stripped, fresh `GBRAIN_HOME`).
- **Arms.** One PGLite index per ingestion seed (1, 2, 3) built through the relational-ab harness (import plus `extract links` and `extract timeline`). Every question runs twice on the same index, relational retrieval off and on, with the relational-ab pins (balanced mode, reranker off, expansion off, autocut off, graph signals on, relational depth 2).
  - Hermetic arm: keyword path, no embedding provider, provider keys stripped, $0.
  - Paid arm: OpenAI `text-embedding-3-large` at 1,536 dimensions, one shared query vector per question across both arms.
- **k.** Each arm returns 10 chunk rows for composed questions. The one-hop rerun keeps relational-ab's recipe unchanged (5 chunk rows).

## Metrics and denominators

- **Primary: strict supporting-fact all-hit@10.** A run scores 1 when every required page (the pages whose `_facts` state each edge on the chains, plus every answer page) is among the distinct pages of the first 10 result rows; otherwise 0. Denominator: 125 questions x 3 seeds = 375 runs per arm and wording. A product exception scores 0 and stays in the denominator.
- **Secondary:** answer all-hit@10, support all-hit@10, answer recall@10, strict all-hit@5 (first 5 rows of the same result), by hop count, by family, and on the subsets without a single-page shortcut and with every edge stated in text.
- **Stage funnel** (ON arm, per run): the parser returned a relational query; at least one seed resolved; the arm fired (added candidates); every required page delivered. All four are reported as counts over the same 375 runs.
- **Composed-query capability check.** `parseRelationalQuery` on every wording. A composed plan would need more than one relation set; the parser returns one (`linkTypes`), so a composed plan is impossible by type at this commit. The check reports what the parser does instead: no parse, the first-hop relation, the last-hop relation or another relation, and whether its seed is the anchor name or a longer phrase. Composed questions are a recorded feature gap; they are still scored on what the system returns.

## Controls (reported, never used to drop a question)

- **Solvability:** every required page is in the corpus and at most 10 per question (a generator design rule); edges stated in the holder page's text (8 of 125 questions have at least one edge not stated by link or name; reported as a subset).
- **Shortcut:** questions where one page mentions the anchor and every answer (46 of 125) are reported separately.
- **Negative control (gold shuffle):** each arm's results are also scored against the gold of another question in the same family (a fixed derangement). Strict all-hit against shuffled gold should be near zero; a high value would mean the scorer or the questions leak.
- **Presence (void condition):** in each seed's index, a query made of only the anchor's name must return the anchor page in the first 10 rows for at least half of the distinct anchors. Below that the index is not searchable and the run is void (error, not a result).
- **Void conditions:** overlay identity mismatch, System One precondition failure, a harness error, or a paraphrase or question file that differs from its generator.

## Decision rules for the report

1. "Relational retrieval helps composed questions" is claimed for a wording only if, over the 125 distinct questions, the number of questions whose mean on-minus-off strict all-hit across the three seeds is positive exceeds the number where it is negative, with an exact two-sided sign test p < 0.05 (ties dropped). Otherwise the report says "no demonstrated benefit" for that wording and arm. The headline claim uses the paid arm on the `composed-paraphrase` split; the hermetic arm is reported as the keyword-path result.
2. "Relational retrieval hurts composed questions" uses the same test in the other direction.
3. The one-hop paid rerun (`relational-ab.ts`, template and the 2026-09-29 paraphrase split, which is development data) uses rule 1 on recall@5 and on hit@1, separately per split, and reports firing counts beside them, so it answers the open question in the 2026-09-29 report: how much of the template benefit survives rewording at the new pin.
4. Every finding about gbrain goes in the wave bug ledger as a bug against a stated contract, a feature gap or a category defect. A composed question the parser cannot plan is a feature gap, never a bug.

## Budget

Both paid arms run only through the guard (`--paid --budget-run-id <id>`), in a budget run capped at $5 for this lane. Estimate: about $0.07 for the one-hop rerun (measured $0.0645 on 2026-09-29) and about $0.07 for the composed paid arm (the same corpus embeddings per seed plus 250 distinct questions).
