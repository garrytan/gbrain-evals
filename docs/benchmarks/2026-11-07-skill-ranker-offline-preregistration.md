# Preregistration: offline skill ranker eval (GBRA-377 Step 1)

Written 2026-11-07, before any paid request, any turn, any label or any arm run. Plan: GBRA-377 / GST-1860 "General-purpose skill resolver in GBrain", Step 1, with the gate-2 amendments (deployable set A0 to A5; embedding arms diagnostic only). Directory: [2026-11-07-skill-ranker-offline/](2026-11-07-skill-ranker-offline/).

## Question

Agents now carry hundreds of skills, but harnesses show the model a short list, some of them in alphabetical order. Should gbrain build a per-turn skill resolver (a word-matching ranker over a prebuilt index, with a "no skill applies" gate), and if so, with which ranking fields, parameters and gate threshold? This measurement decides whether PR A (the resolver core) starts, and freezes its release constants if it does.

## Evidence class

Development evidence on synthetic data. Turns are written by a model and labelled by a second model from another family. It is offline: no agent runs, so it measures whether an acceptable skill reaches the list, not whether an agent then uses it. The cross-harness behaviour eval (HARN-52) is the confirmation.

## Build and data

- gbrain `ff11cb911c7434690bb40124372906773238d9c9` (v0.60.610.0): bundled skills, spring index and `scoreSkillMatch` come from this commit through `scripts/dump-gbrain.ts`.
- gbrain-evals base `3b9c3367b960031a12d762c4b8f57ddceb10585c`.
- Catalog: `data/catalog.jsonl` (committed as `data/catalog.jsonl.gz`), sha256 `5b9b29a47ca6cd34ed36a23b6e4d8101c12ccb53ca4115f143bc17acb5de8254`, built by `scripts/build-catalog.ts` (sha256 `5ecf082b0ea092517e218002bd4373dc2ff666264e31f545e5969b5b62d24943`) from 71 gbrain bundled skills, 61 gstack skills and 1,368 skills from 17 permissively licensed public repositories, each pinned to a commit (SOURCES in the script; licences in `SOURCES.md`). Each skill stores only id, name, description, triggers, routing rows and a body bounded to 4 KB. Pool after name dedupe: 1,841; kept 1,500.
- Catalog sizes (nested): 250 (every gbrain and gstack skill plus 118 seeded public skills), 750 and 1,500 (further seeded public skills, seed `gbra377-catalog-v1`). Step 0 (where harness listings truncate) runs in parallel, so catalog size stands in for "every skill visible" against "listing truncated".
- Catalog variants: **D, description-only (primary)**: name, description and, for A5, body; triggers and routing rows removed. **T, with-triggers (secondary)**: triggers and routing rows kept where the source supplies them (132 skills carry triggers, all in the 250 core; 69 gbrain skills carry RESOLVER.md routing rows).
- Areas: `data/areas.json` sha256 `9e9d1692aa9301c7812e41b67c9c63cd240805f42b24369eaa03bc23cc693a88`: 45 hand-written task areas, written without reading any skill's description, and 10 generic no-skill kinds.
- Turns: 300, written once by `scripts/gen-turns.ts` (sha256 `af734d1e40721c6ba36ac783b76ce3b4d82a2c16a4eb65f9620b24ac3826ed17`): per area, 5 skill-seeking turns and 1 near-miss turn a capable assistant answers directly; plus 30 generic no-skill turns (25% of turns are written as no_skill_needed). The writer sees the area scenario only, never a skill name or description. No data from garrytan/harness-evals' request sets is used.
- Labels: `scripts/judge.ts` (sha256 `9ac9ce452a1501d35a41564897737861b42ebc84cdbd230af00b1f745bf2d3d6`). The judge reads the full 1,500-skill catalog (id and description, in a hash order unrelated to any arm), 5 turns per request, and returns each turn's acceptable skill ids (at most 8) and a best skill. It sees no arm output. Pass 1 is the label set. Pass 2 relabels every turn in different batches and is used only for label stability.
- Split: within each written intent (skill 225, near_miss 45, generic 30), turns are sorted by sha256(`gbra377-split-v1` + id) and the first 20% go to dev (45 + 9 + 6 = 60); the other 240 are test. Immediately after labelling, an amendment records the sha256 of `data/turns.jsonl`, the pass-1 labels, `data/dev.jsonl` and `data/test.jsonl`, and is pushed before any arm runs. The scorer refuses a test file whose hash differs.

## Arms

Models, all called through `scripts/lib.ts`:

| Role | Model | Settings |
|---|---|---|
| Turn writer | openai `gpt-6.1-sol` | Responses API, reasoning effort medium, strict JSON schema, max_output_tokens 20,000, no temperature |
| Label judge | anthropic `claude-opus-5-5` | Messages API, `output_config.effort` high, max_tokens 24,000, no temperature, catalog in a cached system block |
| A7 embeddings | openai `text-embedding-3-small` | skill text "name: description", turn text as is |
| A6 embeddings | `nomic-embed-text` (v1.5, Apache-2.0) on Ollama 0.40.15 at 127.0.0.1 | prefixes `search_document: ` and `search_query: ` |

This is not a model comparison, so the writer and judge are the newest frontier models of two different families and no model is under test. Fable and gpt-5.4-mini are not used.

Every arm sees the turn's single user message only.

**Config-only arms** (a static list, the same on every turn; a turn is a hit when any acceptable skill is in the list):

- **A0**, alphabetical first N: skills sorted by name, the first N = round(0.11 x size), the cut ratio of the large install in the plan, rendered `- name: description` (full description).
- **A1**, names-only full catalog: every skill name, alphabetical, one per line.
- **A1u**, usage-ordered static list: skills ordered by how many dev turns list them as acceptable (pass 1), ties and unseen skills alphabetical.
- **A1s**, spring static index: gbrain's compact bundled index as rendered at ff11cb91 (71 bundled skills, name plus up to 3 triggers).

Each is scored at **matched tokens**: B = 200 tokens (tokenizer bytes/4), the size of the per-turn block at k=5. A0 and A1u fill B with `- name: hint` lines, A1 with names, A1s with its own lines in block order. A0 and A1s are also reported at their natural size (A0 at 11%, A1s whole), and A1 at its natural size (membership is 100% by construction, so only its tokens are informative). The best config-only arm is the best matched-B hit rate of A0, A1, A1u and A1s.

**Per-turn arms** rank every skill in the catalog for the turn. The top 5 form the block `<relevant_skills>` with lines `- name: hint`, where hint is the description cut at 120 characters on a word boundary. A gate suppresses the whole block when the arm's normalized top score is below its threshold.

- **A2**, today's ranker: `scoreSkillMatch` (src/core/skill-catalog.ts at ff11cb91), vendored verbatim with an equivalence check against the gbrain checkout. Zero scores drop, ties break by name. Normalized score: top score / distinct query tokens.
- **A3**, BM25F on name (hyphens split) and description.
- **A4**, A3 plus triggers and routing rows as fields. In variant D these fields are empty, so A4 equals A3 there and is reported once.
- **A5**, A4 plus the bounded body (4 KB) as a field.
- **A6**, A4 fused with local embeddings: score = w x bm25n + (1 - w) x cosine.
- **A7**, A4 fused with provider embeddings, same fusion. Offline, synthetic data only; it sizes the gap and never runs per turn.

Lexical details, fixed: lowercase; split on anything that is not a letter or digit; drop tokens under 2 characters and a fixed 60-word stopword list; a light suffix stemmer (fixed rules for -ies, -es, -s, -ing, -ed). BM25F: tf~ = sum over fields of w_f x tf_f / (1 - b + b x len_f / avglen_f); score = sum over distinct query terms of idf x tf~ / (k1 + tf~); idf = ln(1 + (N - df + 0.5) / (df + 0.5)), N and df over the catalog at that size. bm25n = score / sum of idf over query terms present in the catalog, so it lies in [0, 1).

**Deployable set (preregistered).** Only A0 to A5 can win: they need no model and no network on the turn path, as the v1 contract requires. A6 and A7 are diagnostic upper bounds. If only an embedding arm passes the bars, the verdict is "no deployable winner", PR A does not start, and the result goes to GBRA-108.

## Calibration (dev split only)

All tuning uses the 60 dev turns, catalog size 750, separately for variants D and T. The test split is never read during tuning.

- Grid: k1 in {0.9, 1.2, 1.6}; b in {0.4, 0.75}; w_name in {1, 2, 3}; w_desc = 1; w_trigger = w_routing in {1, 2, 3} (T only); w_body in {0.2, 0.5, 1} (A5, with A4's other parameters frozen); fusion w in {0.3, 0.5, 0.7} (A6, A7, with A4's parameters frozen). Pick the highest dev ungated hit@5; ties go to MRR@10, then the earlier grid point.
- Gate: suggest iff the normalized top score is at least tau. Candidates are 0 and every dev turn's normalized top score. Pick the tau with the highest dev gated hit@5 subject to dev false-suggestion rate at most 15%; ties go to the lower tau. When no candidate reaches 15%, take the lowest false-suggestion rate, then the lower tau.
- Parameters and tau are frozen and applied unchanged at 250, 750 and 1,500 skills.
- **The chosen arm** is picked on dev: the deployable per-turn arm (A2, A3, A5) with the highest dev gated hit@5 in D at 750; ties go to the simpler arm (A2, then A3, then A5).

## Metric and denominator

- Labels at size S are the pass-1 acceptable set intersected with the catalog at S.
- **Skill turns at S**: at least one acceptable skill in the catalog at S. Denominator of hit@1, hit@3, hit@5 and MRR@10 (ungated ranking) and of gated hit@5 (a gated-off turn is a miss), and of config-only membership.
- **no_skill_needed turns**: the judge's acceptable set is empty over all 1,500 skills, whatever the writer intended. Denominator of the false-suggestion rate (FSR: the share where the arm shows a non-empty block). The same turns at every size.
- **Absent-skill turns at S**: acceptable skills exist only outside the catalog at S. Excluded from both denominators and counted; their suggestion rate is reported as a secondary number.
- Block tokens: mean tokens of the shown block (bytes/4), with empty blocks counted as 0.
- Unit: the turn. Intervals: paired bootstrap over test turns, 2,000 resamples, seed `gbra377-boot`, 95% percentile intervals.
- A judge reply with an id that is not in the catalog drops that id (counted). A failed or unparseable judge reply is retried up to 3 times; a turn that still fails is reported and excluded.

## Decision rule

All on the test split, variant D (primary):

1. **Win:** the chosen arm's gated hit@5 beats the best config-only arm at matched tokens by at least 10 points, at each of 250, 750 and 1,500 skills.
2. **No-skill gate:** the chosen arm suggests something on at most 20% of no_skill_needed turns, at each size.
3. **Gate transfer:** the chosen arm's FSR spread across the three sizes (max minus min) is at most 5 points.
4. **Cuts:** the bounded body stays only if A5 beats A4 by at least 2 points of ungated hit@5 at 750; otherwise it is cut, and if A5 was chosen the chosen arm becomes A4 (A3 in D) with its own frozen gate. Embeddings stay in the plan only if they beat A4 by at least 3 points of ungated hit@5 at 750 (A6 and A7 judged separately), and even then remain diagnostic.

Bars are on point estimates; intervals are reported beside them. No multiple-comparison correction is applied because no p-value decides anything; each bar is a fixed threshold. With roughly 170 test skill turns per size, a 10-point paired difference is resolvable; a difference whose 95% interval spans 0 is reported as "not resolved by this sample" even when the point estimate passes.

**Pass** = bars 1 to 3 hold for the chosen deployable arm. A null or negative result gets one R48 "Why null?" cycle (exposure, task fit, power and saturation, whether a frontier model does without it) and a KEEP, FIX-METHOD or CUT-CANDIDATE verdict, reported plainly. The report also gives the chosen arm's frozen parameters and normalized gate threshold (PR A's release constants) and, if a config-only arm wins or ties, the cheapest real fix it implies.

Secondary, not deciding: variant T at every size; label stability (pass-2 Jaccard, agreement on empty versus non-empty, and whether the verdict changes when scored on pass-2 labels); per-source breakdowns; block tokens.

## What each outcome changes

| If it wins | If it loses | If inconclusive or at the ceiling |
|---|---|---|
| PR A starts with only the arms that passed, shipping the chosen arm's frozen parameters and gate threshold; cut arms are not ported. | If a config-only arm wins or ties, PR A does not start; the cheapest real fix (for example a usage-ordered or names-only static list in harness config) is named and goes to GBRA-108. If only A6 or A7 passes: "no deployable winner", PR A does not start, GBRA-108 decides. | R48 cycle, then KEEP, FIX-METHOD or CUT-CANDIDATE to GBRA-108. A ceiling (config-only arms near 100%) means the catalog does not truncate at that size, which is reported as such. |

## Budget

Ledger: `results/spend.jsonl`, one line per paid call with provider-reported usage and cost at the list prices in `eval/runner/budget-ledger.ts`. Hard cap $50; the runner refuses a call once ledger plus reservation (writer $0.50, judge $1.50, embeddings $0.05 per call) would pass $45. Expected spend: writer under $2, judge about $5 to $8 per pass, embeddings under $0.10. When the stop is reached the run ends where it is, partial results are reported as partial, and no paid arm is rerun without a named repair.

## Amendments

### Amendment 1, 2026-11-07: data frozen before any arm runs

Turns and pass-1 labels are written; no arm has run on any turn. Recorded hashes (sha256), also in `results/freeze.json`:

- `data/turns.jsonl` `12465c52a202a857dee98683377ed5226d05b98d28e10d4f7229c5a690ab0843` (300 turns, gpt-6.1-sol)
- `results/judge-pass1.jsonl` `bdcb49c9d0513afde8b36ae4f2c897a7b9802c0359355a54b364db545aaddf51` (300 rows, claude-opus-5-5, no retries, 1 out-of-catalog id dropped)
- `data/dev.jsonl` `7b39cb156940ea522d0d7053c67a550c40ef18170df4499f2961cf163742ba76` (60 turns, 17 no_skill_needed)
- `data/test.jsonl` test.jsonl sha256 8b4588f2aed83bf6e2bbdef00220793ecf77a7045cbd7c3c733e3e4dcbbe0b02 (240 turns, 70 no_skill_needed)
- `data/catalog.jsonl` `5b9b29a47ca6cd34ed36a23b6e4d8101c12ccb53ca4115f143bc17acb5de8254` (unchanged)
- `data/spring-block.txt` `3af0f0c0e81c91b2e23eb1e97674288c3043e15b1fab04f6eb91d7716aff9252`: A1s's block as gbrain ff11cb91 renders it, saved so A1s does not need a gbrain checkout.

Judge outcome by written intent (pass 1): 212 of 225 skill turns got at least one acceptable skill and 13 got none; 44 of 45 near-miss turns and all 30 generic turns got none. So 87 turns are no_skill_needed under the preregistered definition (judge's empty set wins over the writer's intent). The judge's cached catalog block measured 188,837 input tokens. Ledger after pass 1: $4.97.

No change to arms, bars, grids or decision rule.

### Amendment 2, 2026-11-07: the preregistered gate fails on dev; a secondary gate analysis and a gate-stress set, added before any test cell

Calibration on the 60 dev turns (catalog 750) ran; no arm has run on a test turn.

**What dev showed.** Under the preregistered gate (normalized top score, tau chosen for dev false-suggestion rate at most 15%), every per-turn arm in both variants gets dev gated hit@5 = 0: the only thresholds that keep false suggestions at or under 15% also suppress every skill turn. The cause is length. bm25n divides by the summed idf of the query's terms, and A2's feature divides by the number of query tokens, so short messages score high. The 17 dev no_skill_needed turns are short (median about 6 content tokens) and the dev skill turns are long (at least 22, median about 45), because the writer was asked for short near-miss questions and wrote long skill requests. The preregistered gate therefore ranks no-skill turns above skill turns. Probe: `scripts/_probe.ts`.

**Primary analysis unchanged.** The test split is scored exactly as preregistered and that result is the primary verdict.

**Secondary analysis, fixed now, before any test cell:**

1. Extra gate features for every per-turn arm: *raw* (the arm's unnormalized top score; for A6 and A7, the raw top score of their A4 BM25 component), *ratio* (top score over the mean of ranks 2 to 10, zero-filled; length-free), and a *length-only control* (the turn's content-token count, which ignores the catalog). The control is never selectable; it shows whether a gate does more than measure message length.
2. A gate-stress set that breaks the confound, written by the same writer under the same rules (`scripts/gen-stress.ts`): per area, 1 terse skill-seeking turn (at most 12 words) and 1 long no-skill turn (3 to 6 sentences of background before a simple question), plus 10 long generic no-skill turns: 100 turns. Labelled by the same judge, instructions, catalog listing and batch size as pass 1 (`scripts/judge-stress.ts`) and split 20/80 within each intent by the same hash rule. Its hashes are recorded in Amendment 3 before any test cell.
3. Secondary calibration: ranking parameters stay as tuned (ungated, dev only). For each gate feature, tau is chosen on dev plus stress-dev (80 turns) by the preregistered rule. The secondary chosen pair is the (deployable arm, gate feature in {raw, ratio}) with the highest gated hit@5 on dev plus stress-dev at 750 in variant D; ties go to the simpler arm, then raw before ratio.
4. Secondary verdict: the same four bars, on test plus stress-test (320 turns), also reported for each set alone. It is labelled as amended and post-dev and never replaces the primary verdict.

Budget: about $3 more (writer and one judge pass over 100 turns). Ledger before this amendment: $8.80.

### Amendment 3, 2026-11-07: gate-stress set frozen before any test cell

`scripts/gen-stress.ts` and `scripts/judge-stress.ts` ran as Amendment 2 describes; still no arm has run on a test turn. Hashes (sha256):

- `data/stress-turns.jsonl` `89274b6bc2dff6edbb1e4a37561c6c06c61e8d4bd4ec71f4796c247809cd869f` (100 turns)
- `results/judge-stress.jsonl` `da2a1e56ab5f829b2a879187077a4767cd75706c202efdc62206dfbd1be7963c`
- `data/stress-dev.jsonl` `b6a86c4424ec2e6814cc6ab0a6cb08515eb2826a87acc8a10c008ad86372a405` (20 turns)
- `data/stress-test.jsonl` stress-test.jsonl sha256 a6000dfd6e12c46459efa10988df1f2a169cd1db743ebb7e3d7a249773b3b3ac (80 turns)

Judge outcome: 43 of 45 terse skill turns got an acceptable skill; 39 of 45 long no-skill turns and all 10 long generic turns got none (6 long "no-skill" turns were judged to have a fitting skill, and count as skill turns, as preregistered). Ledger: $11.06.
