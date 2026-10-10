# Cat 40 Hard fix wave: development record

Status 2026-10-09. Every number here comes from the **development (calibration) world**: seed 20261005, 50k documents, round-5 frozen knobs, 10 tasks per family (H1–H5), 50 tasks in all. We developed gbrain against these tasks, so the estimates are optimistic, and only the preregistered confirmation on fresh and sealed worlds can show the effect. No held-out world or sealed output was read during development: the implementer and the development agents did not open `eval/generators/hard-sealed`, and the alias grammar spec (`835024150`) was committed before any calibration document was read.

Ledger `.budget/cat40-hard-fix.sqlite`: $1,725.80 committed. The cap is $2,542: Garry authorized $478, then +$800, then doubling, and $14 is booked for two runs whose ledger copies were lost when machines were wiped. All cells use the frozen 16-turn cap, the `gpt-6.1-sol` judge and identical settings for both arms. Harness fixes (rerank repoint `7709a70`, fail-closed rerank probe `62b2886`, metering unbind `f345d58`, embed retry `dbb7304`) apply equally to every arm.

## Result

In round 4, gbrain is ahead of plain files on all three models. The pooled result (mean over models of gbrain − fs, per task) is **+4.9 points, 95% CI [+0.4, +9.6]**, from a task-level bootstrap over 50 tasks with every repeat pooled.

| Model | gbrain round 4 (runs) | fs (runs) | gbrain | fs | gap |
|---|---|---|---|---|---|
| Opus 5.5 | 39, 42, 41, 39, 41, 43 | 41, 41, 37, 37 | 81.7% | 78.0% | +3.7 |
| Sonnet 5.5 | 36, 33, 35 | 32, 28, 35, 31 | 69.3% | 63.0% | +6.3 |
| GPT-6.1 Sol | 45, 43, 44 | 41, 41, 43 | 88.0% | 83.3% | +4.7 |

The round-4 gbrain runs above are build `9bba4da40`, three of them with the guidance overrides that reproduce `fa520b72b`. The fs runs come from four separate days, the round-4 day included (`dev-r4-fs`). Sol is at its ceiling on H2–H5 for both arms, so H1 carries most of its gap. GPT-6.1 Sol had no development comparator before round 3.

## Progression (scores out of 50)

| Round | Build | Change | Opus gbrain | Sonnet gbrain | Sol gbrain |
|---|---|---|---|---|---|
| held-out build | `8e11aa1f3` | none (rerank on) | – | 21 | – |
| held-out build | `8e11aa1f3` | none (rerank off) | – | 19 | – |
| 1 | `af0098b43` | R0, R1, F1–F4, F6 | 33 | 25 | – |
| 2 | `6b05f551a` | sibling-page facts, label-line aliases, keyword fan-out | 39 | 28 | – |
| 3 | `3ad9f0657` | re-saving a claim with its entity links the unlinked copy; forget refuses to withdraw linked facts | 32, 39, 38 | 32, 35, 34 | 44, 45 |
| 4 | `9bba4da40` | `entity names[]` (batch lookup), short-code aliases | 39, 42, 41 | 36 | 45 |
| 4 + guidance | `9bba4da40` + overrides = `fa520b72b` | batch-lookup and OR-search guidance in instruction 7 and the `search` description | 39, 41, 43 | 33, 35 | 43, 44 |

Noise: identical setups vary by up to 7 cells (Opus gbrain, round 3: 32 and 39; Sonnet fs: 28 and 35), so compare averages over repeats, not single runs.

## What each round found (paired losses: gbrain wrong where fs is right)

- **Round 1** (23 losses): saved corrections not retrieved (H5, 8), turn caps from 31–60 searches (6), nickname evidence never seen (4).
- **Round 2** (16 losses): in all 7 Sonnet H5 losses, the agent's own `forget` of an unlinked duplicate had withdrawn the linked fact (14 of 14 wrong items); turn caps (3); wrong reasoning with all evidence seen (3); manager-form documents (2). Fixed in round 3.
- **Round 3** (Opus, 14 losses over two repeats): turn caps from search churn (9; on H1, 168 of 413 calls were single-name lookups, while fs does it in one regex alternation); all evidence seen, wrong answer (4); evidence filed under the account code never seen (1). This led to `entity names[]` in round 4.
- **Prompting (Garry's question)**: on H1, Opus used OR in 2% of its searches, while GPT-6.1 Sol used `"A" OR "B" OR …` keyword searches and needed a third of the calls. Instruction 7 said "run separate searches for separate parts of a question", and no gbrain text mentioned OR. The guidance change raised Opus OR queries from 31 to 252 per 50-cell run and cut its cost 14% ($52.8 → $40.7 per run), with no measurable score change (Opus 41.0 vs 40.7 average; Sonnet 34.0 vs 36; Sol 43.5 vs 45; all within noise). It ships as a product change in `fa520b72b`, the same text for every client.

## Exploratory gbrain-plus-files arm (C16)

Same gbrain tools plus `list_dir`, `grep` and `read_file` over the same files; writes go through gbrain only.

| | gbrain + files | gbrain alone | files alone |
|---|---|---|---|
| Opus (round-3 build) | 40 | 32, 39, 38 | 41, 41, 37, 37 |
| Sonnet (round-4 build + guidance) | 26 | 33, 35 | 32, 28, 35, 31 |

Adding files did not help. Sonnet fell back to grep (874 grep and 788 read_file calls against 57 searches), and 17 of its 50 cells hit the turn cap.

## Reranking

In every development gbrain cell that made a hybrid search, reranking ran. The lower rerank counts in the guidance runs (Opus 33–36 of 50 cells, Sol 1–4 of 50) come from agents switching to keyword search, which does not rerank. One degraded notice appeared in each of two 50-cell runs. Separately, on the held-out build, reranking on vs off scored 21 vs 19 of 50 (within noise), which is now in #76's caveat.

## Product changes in gbrain #6271 (branch `capy/cat40-hard-fix`, draft)

R0 (rerank degradation reasons), R1 (`fact_withdrawn` at write time), F1 (identity excerpt, generator-independent alias grammar, sibling cards, alias fan-out), F2 (`keyword_total` and keyword paging), F3 (provenance demotion of gbrain-generated pages), F4 (date source labels), F6 (any `request_id`), sibling-page facts, label-line aliases, claim linking and the forget guard, short-code aliases (2–3 characters, declared on the entity's own page, stoplisted; credit: gbrain-evals#109), `entity names[]` and the batching guidance.

An external measurement of the short-code change (GBRA-60, T0b workload, three counted readers): failures fell from 18 to 4 of 72 on fresh seeds (improvement) and from 25 to 11 of 144 on dev seeds (inconclusive). 397 of 400 declared codes were derived, with 0 false aliases.

## Stopping condition and what remains before confirmation

The plan's stopping condition is met: the pooled Sonnet and Opus development estimate is ≥ +3 points (+5.0), and nickname reachability from the card is 2,829 of 2,829. Development ran four rounds instead of three, because round 3 had not reached the +3 bar on Opus.

Before any confirmation cell:

1. Merge current gbrain master into the branch and pin that SHA. Master now includes #6362 (newer dated mentions on `context_pack` cards, on by default), which touches the same card. So the pinned build gets one final development run (Opus, Sonnet and Sol, one run each) to confirm no regression, as the plan's build-attribution rule requires.
2. Run the Cat 40 v1 no-regression check (Sonnet 5.5, gbrain arm) on the pinned build.
3. Run the full ci:ubicloud gate on the pinned build.
4. Get Garry's authorization for the confirmation spend (about $1,280), plus his written statement of what a kill means for gbrain's docs and roadmap, and his choice of machine for the sealed world (owner custody).
5. Preregister: fresh main seed plus sealed world (co-primary, per UC2 "approve all"), 50k, frozen knobs, gbrain vs fs, Opus 5.5, Sonnet 5.5 and GPT-6.1 Sol, 100 tasks each, oracle ≥ 95% gate per world, the parity wording rule (lower bound above −3) and the kill rule (point estimate below 0).

Still open: a real-brain alias precision check on an owner brain, since the development world gives no evidence on short codes.
