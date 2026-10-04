# Multi-relation query planner (P7): preregistration (2026-10-04)

Frozen before any held-out cell runs, in a commit separate from every result. It covers the sealed confirmation of gbrain's multi-relation query planner (`search.relational_planner`) and its one-hop orientation setting (`search.relational_orient_onehop`). The planner reads a question that chains two or three typed relations ("Who founded the companies Alice invested in?") into a typed walk over the link graph. Both settings ship off; this document fixes in advance which results turn each one on by default. The custodian runs every held-out cell; the implementer never reads the sealed wording or the sealed results before this file is committed.

## System under test

- **Candidate build:** gbrain `1b84e519124fa34da05c1fc5246369ed8ac2f330` on branch `capy/p7-multi-hop-planner`, loaded as a copied overlay (`--gbrain <checkout>@1b84e519`). It is stacked on the temporal-edges build (P1, `6dcac08dd89451f6e9cc27418293e3b7818f9b8b`, branch `capy/gbra-49-p1-temporal-edges`), which sits on master `5bd9e84978126689b11cf65107c0a9aa0e91e11b` (v0.60.48.0). Chains walk relationships through P1's validity predicate (live by default). Later commits on the branch that touch only documentation do not change the build under test. Uncommitted edits are never measured.
- **Arms.** Every cell compares two arms of the same build on the same index per ingestion seed:
  - *Baseline:* relational retrieval on, planner off (the build's default).
  - *Feature:* the same, with `search.relational_planner=true` set on the engine before ingest.
  - *Orientation ablation* (relational-ab only): `search.relational_orient_onehop=true`, planner off.
- **How the feature arm is set.** `GBRAIN_EVAL_SEARCH_PINS="search.relational_planner=true"` (or `search.relational_orient_onehop=true`) in the runner's environment. The shared-index harness applies these pins after the relational-ab pins, checks them by config readback and records them in the receipt's `common_search_pins`. A run without the variable is the baseline arm. The N9 runner's own off/on pair is relational retrieval off/on; this comparison uses its **on** arm from the baseline run against its **on** arm from the feature run, per question and seed.
- **Cells.**
  - (a) relational-ab pins (balanced, reranker off, expansion off, autocut off, graph signals on, relational depth 2), run keyless (hermetic, keyword path) and paid (OpenAI `text-embedding-3-large`, 1,536 dimensions).
  - (b) the shipped `balanced` default: (a)'s pins plus `search.reranker.enabled=true`, paid.
  - Reported, never gating: autocut-on stress (`search.autocut=true`) and `search.mode=tokenmax`.
- **Arm order** alternates per question so the baseline arm does not always run first (latency fairness).

## Held-out set

`multi-hop-paraphrase` (legacy alias N9), `eval/data/n9-multihop-paraphrase-v1/questions.json`, SHA-256 `1a2bdd9c00dbb1c106d117dae1005a8a903a9f9a4a299546d3edea2bb0def396`: 125 composed questions over world-v1 (94 two-hop, 31 three-hop, seven families), each with a canonical wording (`composed-template`) and one seeded paraphrase (`composed-paraphrase`), three ingestion seeds, k = 10. The planner's grammar was developed on model-written and hand-written frames over world-v1 without reading this file. After this run the v1 set is spent: it becomes development data, and any retry waits for a fresh sealed composed set (v2 wording).

## Metrics

- **Primary:** strict supporting-fact all-hit@10 (the N9 definition: every answer page and every page stating an edge on a gold chain among the first 10 distinct pages). The headline is computed over the five typed-relation families (investor→founders, advisor→founders, founder→investors, co-investors, three-hop founder→other portfolio); the all-seven number is reported beside it and labeled extraction-capped, because world-v1 does not type `attended` edges.
- **Secondary:** answer all-hit@10, answer recall@10, support all-hit@10, by hop count and family; the funnel (planned, anchor resolved, fired, delivered) from `meta.relational_plan`.
- **Safety:**
  - *Chain answer precision:* the share of rows with `relational.role = "answer"` in the first 10 that are gold answers, over fired runs.
  - *Edge-evidence correctness:* the share of chain answers whose `relational.edges` state the right relation between the right pair according to `_facts`.
  - *Wrong-answer promotion:* non-gold chain rows placed above the first gold page, compared with the baseline's non-chain wrong-page rate.
  - *Abstention:* on unanswerable chain questions (a valid chain with no gold answer, or an anchor without the first relation), the share of runs where the chain returns answers.

## Release gates (checked on the frozen build in CI and on development data, not on the sealed set)

All passed at `1b84e519` before this file was committed (full CI gate: unit, serial, slow and E2E on PGLite, Postgres and PgBouncer); the evidence is listed under "Development evidence".

1. Remote leak tests, including hidden-neighbor, hidden-origin and hidden-degree invariance (no hidden page changes answers, scores, path counts or diagnostics), and relationship validity (an ended state relationship is not walked by default; `status: "all"` and `as_of` walk it).
2. Bounded work on a degree-10,000 hub (rows within caps, under 2 s on PGLite).
3. Engine parity on exact `best_path` and `score` (PGLite and Postgres).
4. Planner and orientation off → whole-search byte-identical to the base commit.
5. Latency: added p95 search latency ≤ 25 ms on the world-v1 index and ≤ 100 ms on a 100k-link synthetic graph, both engines reported.

## Benefit gates (all must hold for the planner to default on)

1. **Sign test.** N9 decision rule 1 on the paid arm, `composed-paraphrase` split, cell (a): more distinct questions improve than worsen on mean strict all-hit across the three seeds (feature minus baseline), exact two-sided sign test p < 0.05, ties dropped.
2. **Absolute effect floor.** Strict all-hit@10 on the five typed families improves by at least 10 percentage points on paid paraphrase in cell (a), and by at least 5 points in cell (b).
3. **Safety.** Chain answer precision ≥ 0.7 over fired runs; edge-evidence correctness ≥ 0.8; wrong-answer promotion no worse than the baseline's non-chain wrong-page rate in cell (b); on unanswerable questions the chain returns answers in ≤ 10% of runs; no typed family's strict all-hit drops more than 5 points below baseline.
4. **No hurt.** No cell shows "hurts" under N9 rule 2, including the keyless cell.
5. **One-hop regression.** `relational-ab` (template and the 2026-09-29 paraphrase split): no distinct question worse on recall@5 or hit@1 with p < 0.05 in either split, for both the feature arm and the orientation ablation.
6. **False fire.** A plan for ≤ 1% of LongMemEval-S questions and ≤ 1% of BrainBench non-relational queries, every fired question listed in the receipt (parse only, $0).
7. **Latency.** Release gate 5 holds on the frozen build.

## Default rule

- `search.relational_planner` defaults on in `balanced` and `tokenmax` if and only if release gates 1-5 and benefit gates 1-7 all hold. Otherwise the code ships with the planner off in every bundle and this receipt is published as a loss. The planner needs no key, and upgrades inherit the bundle default.
- `search.relational_orient_onehop` defaults on only if the orientation ablation passes benefit gate 5 and improves relational-ab paraphrase recall@5 under N9 rule 1. Otherwise it ships off (unset follows the planner).
- `traverse_graph` `hops` is not a default: it runs only when an agent passes it, and it ships once the release gates hold.
- A miss is not rerun. Changing this file after any held-out cell runs requires writing the change and its reason here first.

## Development evidence (not held-out; recorded so the confirmation can be read against it)

- **Oracle reachability (world-v1, keyless):** an exact traversal of the gold plan reaches every gold answer and support page for 0.875 (investor→founders), 1.0 (advisor→founders), 0.913 (founder→investors) and 0.789 (co-investors) of questions, against a baseline strict all-hit near 0, so the graph does not cap the gain below the +15-point stop line.
- **Implementer dev probe (world-v1 keyword path, hand-written frames, not anchor-disjoint from N9, indicative only), strict all-hit@10 off → on:** 0.02 → 0.875, 0 → 1.0, 0 → 0.913, 0.05 → 1.0, 0 → 0.727 (three-hop). Pooled chain answer precision about 0.83; advisor→founders alone is 0.625. Its wrong answers come from body extraction typing round-lead investors on timeline lines as `founded`. On world-v1, `founded` links written on both endpoint pages are all gold (40 of 40) and single-page `founded` links none (0 of 14). That is an extraction fact, not a ranking rule; the planner does not filter on it.
- **Paraphrase coverage (non-shipping LLM probe, `claude-sonnet-5-5`, $0.36 total):** 60 model-written paraphrases of the five families. The grammar first planned 16 correctly and an LLM planner 42. After grammar work on that set, a fresh set of 60 was planned correctly by the grammar in 44 cases (1 wrong) and by the LLM in 40. Three-hop paraphrases remain the weakest family for both (grammar 4 of 12, LLM 0 of 12 with valid JSON).
- **False fire (parse only):** 0 of 500 LongMemEval-S questions, 0 of 77 BrainBench tier-5 non-relational queries, 0 of 50 cat-13 queries. All 145 relational-ab template questions and 110 paraphrases stay single-relation (`not_applicable`).
- **One-hop regression (relational-ab, hash-stub embeddings, three seeds, on-arm per question against master):** feature and orientation-only arms both: template recall@5 0.636 → 0.636 (0 improved, 0 worse), hit@1 0.510 → 0.524 (2 improved, 0 worse); paraphrase recall@5 0.373 → 0.379 (1, 0), hit@1 0.214 → 0.221 (1, 0).
- **LongMemEval-S guardrail (decision kit dev stage, P1 head `6dcac08dd` against the candidate with the planner on, all 500 questions, hash embeddings):** recall_all@5 0.5553 → 0.5553, nDCG@10 identical, latency Δ −0.33 ms (95% CI −0.90 to +0.24). Kit verdict pass; spec and verdict are committed in the gbrain branch under `docs/eval/decisions/p7-dev-2026-10-04/`.
- **Latency (planner off vs on, alternating order, 150 queries):** world-v1 PGLite added p95 15.3-15.6 ms; 100k-link synthetic (10,000 pages) PGLite 51-54 ms, Postgres 27.5-35.7 ms. The first run in a process that had just built the synthetic graph measured 145 ms on PGLite; repeated runs on the persisted graph did not reproduce it.

Probes and their outputs: [`2026-10-04-p7-multi-hop-planner/`](2026-10-04-p7-multi-hop-planner/) (`probes/p7-falsefire.ts`, `p7-onehop-check.ts`, `p7-d2-coverage.ts`, `p7-d2-regrammar.ts`, `p7-latency.ts`; `falsefire.json`, `d2.json`, `d2-check.json`).

## Spend

Embeddings and reranking only, all through the budget ledger with a program cap of $10 for P7: sealed N9 paid about $0.07 per arm, cell (b) about $0.10, relational-ab paid plus ablation about $0.15. Paid runs use `--paid --budget-run-id <id>`.
