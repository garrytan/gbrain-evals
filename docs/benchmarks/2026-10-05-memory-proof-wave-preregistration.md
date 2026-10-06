# Memory proof wave: preregistration skeleton, 2026-10-05

This is the preregistration for the memory proof wave's primary comparison, completed on October 6, 2026, before any sealed conversation was opened. It fixes the question, the data, the split, the systems and their configurations, the statistic, the margin and what each outcome means. The grouping runner opens sealed conversations only while this file is committed and has no open placeholder, and every open is access-logged with this file's SHA-256.

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents. It keeps what it is told as Markdown pages and searches them with no model call on writes. The comparator is an extract-first memory server: it calls a language model on every write to pull out facts, keeps them in a database and also keeps the raw text. The wave asks whether gbrain answers questions about long conversations about as well as the comparator, at a lower total cost per correct answer.

## The question

The primary claim, as approved in the wave plan:

> On untouched sealed conversations, under one audited protocol with the same answer model, judge and delivered-context targets for both systems, gbrain's graded accuracy on BEAM is non-inferior to the comparator's (one-sided 95% bound of the paired difference above −margin), at a lower total cost per correct answer under a preregistered cost formula.

After the [power simulation](2026-10-05-memory-proof-wave-power.md), Garry moved BEAM 100k into the primary endpoint, so the primary test covers BEAM 100k + 500k + 1M (October 5, 2026, recorded in the wave plan). After the dev power re-estimate, he set the margin to 3.5 points (October 6; see [The margin](#the-margin)).

[BEAM](https://arxiv.org/abs/2510.27246) is a public benchmark of very long chat histories. Each conversation has 20 questions of ten kinds (abstention, contradiction resolution, event ordering, information extraction, instruction following, knowledge update, multi-session reasoning, preference following, summarization, temporal reasoning). A judge scores each answer against a short rubric, item by item, so a question can earn partial credit between 0 and 1. The 100k size has 20 conversations of about 0.1 million tokens; the 500k and 1M sizes have 35 each, of about 0.5 and 1 million tokens.

## What is fixed

| Item | Value |
|---|---|
| Decision id | `mpw-beam-ni-2026-10-06` |
| Benchmark harness | The public agent-memory benchmark harness at the commit in [`harness.lock.json`](../../eval/data/memory-proof-wave/harness.lock.json) (`f618ed7b1f0eb9cad7b42e876f91a42f0eadb150`). BEAM queries: 100k `f58e001b…`, 500k `fe4553ac…`, 1M `ed5fd003…` (SHA-256 of `queries.json.gz`). |
| Split | [`grouping-manifest.json`](../../eval/data/memory-proof-wave/grouping-manifest.json), committed before any tuning: 18 dev, 18 validation and 54 sealed conversations (100k 4 / 4 / 12, 500k and 1M 7 / 7 / 21 each). Resealed on October 5 (see [Reseal](#reseal-2026-10-05)): private file commitment `22292099…`, salt commitment `62449d8c…`. Built and resealed by [`memory-proof-wave-grouping.ts`](../../eval/runner/memory-proof-wave-grouping.ts). |
| Sealed questions | 1,080: 54 conversations × 20 questions (240 at 100k, 420 at 500k, 420 at 1M) |
| gbrain build | Freeze build `d7467d1cf` (#6066 head: master `c5fb0201d` with MCP SDK 1.31.0, the wave, date-grounded extraction from #6020 and the temporal fact reserve; full gate green on this tree), installed from GitHub; the merged `src/` tree is checked byte-identical at merge |
| gbrain configuration | Read through `query` with `return_unit: page` and `token_budget` tuned on dev to the target (8,100 to 8,800 by build and layout); `search.return_budget_max_remote` raised to 200,000 and the remote clamp asserted unfired on every row; the harness date header on (`date_header: true`; the C1 evidence-date-header switch showed no dev gain: 0.588/0.586 at 100k, 0.586/0.586 at 500k). BEAM's per-dataset ingest config writes one dated gbrain page per exchange (`page_split: "exchanges"`, gbrain only; the comparator chunks internally); the dev report gives the measurements. **Primary gbrain arm: the combined lane**, decided October 6. It uses opt-in fact extraction (`extract_facts` over whole-turn windows, extraction model `openai:gpt-6-luna`, whose spend is counted in the cost formula) plus the page query. Facts get 600 tokens and the page query `token_budget` 7,500, so the combined prompt delivers about 8,000 tokens. The 8,000-token target is the delivered target, counted on the text inserted into the prompt; it is not the page arm's budget, which would deliver about 8.7k with the facts block and fail the gate. This reading was accepted for the temporal-fact-reserve decision on October 6. The temporal fact reserve (`search.temporal_fact_reserve: true`, read-time) is on if its validation confirmation on this build passes its preregistered win rule (temporal reasoning and event ordering improve, paired, and pooled is not lower), and off otherwise. The verdict is recorded before any sealed gbrain cell runs, and the comparator's cells do not depend on it. The raw lane (secondary) uses exchange pages and `token_budget` 8,700 (tuned on dev), with no facts and no reserve. `extraction.date_grounding` stays at the build default, on. The rule was fixed before the result: false would replace the default only if it beat the default on pooled score (paired) without lowering temporal reasoning. In the dev interaction check on 94e9e8875 (reserve on, 360 questions), false against default was +0.001 pooled (48/45/267) but −0.014 on temporal reasoning (2/2/32), so the default stays. This matches the comparator's best supported mode, extracted facts plus raw chunks, so each system runs at its best. **The raw lane (pages only) is a preregistered secondary arm on the same sealed cells**, reported beside the primary without deciding anything. On BEAM dev at 8,000 tokens, gbrain leads the comparator by 0.7 points in the combined lane (505a65aab) and trails by 0.6 in the raw lane with exchange pages (a87c3e2af)) |
| Comparator build | The comparator server's pinned current release, 0.10.2 (lock SHA-256 `49a0e4f3…`, [`comparator.lock.json`](../../eval/harness-provider/comparator.lock.json)), in its own environment with its documented default extraction model, local CPU embeddings and reranker, in its best supported mode: extracted facts plus raw chunks, observations off |
| Comparator configuration | Fact and chunk budgets scaled together at a fixed 7:4 ratio and tuned on dev to the target: at 8,000 tokens, `max_tokens` 3,129 / 2,845 / 2,855 and `max_chunk_tokens` 1,788 / 1,626 / 1,631 for 100k / 500k / 1M (delivered mean 7,763 / 7,617 / 7,745, p95 8,631 / 8,607 / 8,539) |
| Harness mode | `rag` for both systems |
| Answer model | `gemini-3.8-flash` for both systems, set through `OMB_ANSWER_LLM` / `OMB_ANSWER_MODEL` with `.env` loading disabled. Resolved id `gemini-3.8-flash` (Gemini API, asserted from the metering proxy log on every call). No fallback model: if the model is unavailable the run pauses and resumes; it never switches models mid-decision. |
| Judge | `gemini-3.5-flash`, BEAM's judge as the harness forces it, asserted by model id on every call; one blinded, shuffled joint judging pass over both systems |
| Delivered-context target | 8,000 tokens, counted with `cl100k_base` on the exact text inserted into the final prompt; every cell gated on mean and p95 within ±10% of the target (7,200 to 8,800); no truncation |
| Scorer | Audited harness scorer, revision `7619a08c…` (`scorer_revision` in every cell's `cell.json`): typed outcomes, strict judge field validation, every rubric item scored, fixed denominator ([`SCORER.md`](../../eval/harness-provider/SCORER.md)) |
| Cost formula | Per system, cost per correct answer = (ingest LLM dollars + ingest embedding dollars + ingest CPU-hours × $0.05 per vCPU-hour, divided by R reads per written conversation) + read-time dollars per question (query embedding, any read-time LLM call, and answer-model input and output for the delivered context) divided by accuracy. All dollars are proxy-metered at the ledger's list prices. R = 20 (each sealed conversation is read by its 20 questions), with sensitivity at R = 1× and 10× that. |
| Spending cap for this decision | $450 of proxy-metered spend for the sealed primary: the gbrain combined and raw cells, the comparator cells (ingest included), the joint re-judge and the analysis. These are drawn from the ledger `mpw-confirm-sealed` (cap $1,165, which also covers the validation confirmation and the secondary rows) and the comparator VMs' ledgers. The wave cap is $2,800. If the primary would exceed $450, the run stops and is reported before any further spend. |

## The estimand and the statistic

For each sealed question, the paired difference is gbrain's graded score minus the comparator's, times 100, in points. The estimand is the mean of these 1,080 differences. Every conversation has 20 questions, so this equals the mean of the 54 conversation means; by question share, 100k carries 22% of the weight and 500k and 1M 39% each.

The primary gbrain arm is the combined lane (see the table above). The raw lane runs on the same sealed cells as a secondary arm: its bound and decision are computed the same way, reported beside the primary and labelled secondary, and never change the primary outcome.

The analysis treats conversations, not questions, as the independent units, and keeps the three sizes as strata:

- **Standard error.** Stratified cluster-robust (CR1): within each size, the variance of conversation totals around the size mean, scaled by G/(G − 1), combined with question-share weights.
- **Primary lower bound.** The restricted wild cluster bootstrap-t with Webb six-point weights, 9,999 draws, seed `20261005`: the smallest null value the one-sided 5% test does not reject, found by bisection ([`ni-stats.ts`](../../eval/runner/memory-proof-wave/ni-stats.ts), `wildRestrictedLowerBound`). The upper bound uses the same test in the other direction.
- **Reported beside it, deciding nothing.** The analytic CR1 t bound with 51 degrees of freedom, and the stratified cluster bootstrap-t.

The [power report](2026-10-05-memory-proof-wave-power.md) checked these choices by simulation at 54 sealed conversations (100k + 500k + 1M): one-sided coverage of the primary method was 94.0% to 95.6% across four assumption sets, the lowest being the one in which a tenth of conversations lose 15 points. The percentile bootstrap undercovers and is not used.

## The margin

**3.5 points**, approved by Garry on 2026-10-06, before any validation or sealed cell ran.

The history: the plan first said 2.0, and the October 5 power report moved it to 3.0 with BEAM 100k added (87% power under its central assumptions). The dev phase then re-estimated power from the dev pairs (below). The measured paired variance was about twice the assumed one, so 3.0 gave 71–76% power, under the plan's 80% rule. A check with two answer samples per question averaged gave no gain (76% at 3.0), because the variance is mostly question-by-question disagreement between the systems, not answer noise. At 3.5 points the primary pairing reaches 86–87% power at 54 sealed conversations. A loss of 3.5 points on a score near 66 is about a 5% relative loss.

**Dev re-estimate (October 6).** The dev pairs (18 conversations, 360 questions; gbrain raw with exchange pages against the comparator's facts plus chunks, 8,000 tokens, gemini-3.8-flash) give a per-question paired variance of 0.185 and a conversation effect of 3.2 points, against 0.097 and 3.5 assumed. At 54 sealed conversations that puts power at a true difference of 0 at 71–74% for a 3.0-point margin (82–84% at 3.5, 91% at 4.0); a second pairing gives 73–76%. The 80% rule in the plan fires, so the margin or the design changes before any validation or sealed cell. On the primary pairing (gbrain combined with exchange pages, 505a65aab) power at 3.0 is 76% with one answer sample and 76% with two samples averaged per question: answer noise is about 0.025 of a 0.158 paired variance, so more samples do not reach 80%. A 3.5-point margin gives 86–87%.

## What each outcome means

The outcome is computed by `decide()` in [`ni-stats.ts`](../../eval/runner/memory-proof-wave/ni-stats.ts) from the one-sided 95% lower and upper bounds of gbrain minus comparator. There is no "tied" outcome: a non-significant difference never becomes a claim of equality.

| Outcome | Rule | What is published |
|---|---|---|
| `ahead` | lower bound > 0 | gbrain's graded accuracy on sealed BEAM 100k + 500k + 1M is higher than the comparator's under this protocol, with the bound and both accuracies. |
| `non-inferior` | −margin < lower bound ≤ 0 | gbrain is at most `margin` points behind, with 95% confidence. If the upper bound is also below 0, the report says gbrain is measurably lower but within the margin. Cost per correct answer is reported beside it. |
| `behind` | lower bound ≤ −margin and upper bound < 0 | gbrain is measurably behind, and a loss larger than the margin cannot be ruled out. Published as such, with the per-kind breakdown. |
| `inconclusive` | lower bound ≤ −margin and upper bound ≥ 0 | The sample cannot tell. Published as inconclusive; no equality or parity claim. |

The cost claim ("lower total cost per correct answer") is reported with its own interval under the preregistered cost formula. The ratio of the two systems' cost per correct answer gets a 95% interval from the stratified cluster bootstrap over conversations (9,999 draws, seed `20261005`), with the sensitivity at 1× and 10× reads reported beside it. A cost claim is made only when the whole interval lies below 1.

A sealed cell is marked incomplete, and the decision is `inconclusive`, if any sealed question lacks a scored row for either system, any BEAM rubric item is unscored, or the delivered-context gate fails. An answer failure, retrieval failure or incomplete ingest scores 0 for that system and is counted by type.

## Access rules

- **Dev** conversation ids are public in the manifest. Tuning, knob sweeps and the delivered-context fitting use dev only.
- **Validation** ids are opened through `memory-proof-wave-grouping.ts open --split validation`, which checks the private file against its commitment and appends a line to the access log. Every fix and configuration choice is confirmed on validation before it counts.
- **Sealed** ids open only with `--decision-id`, a purpose, and this file committed with no open placeholder. The log line records this file's SHA-256. Sealed runs once per system. A failed sealed result ends this decision; it is never rerun with `--only-failed` or merged reruns.
- **Validation receipts stay in custody.** For validation cells the repository gets only summaries and per-category aggregates: scores, paired W/L/T counts, firing rates, gates and spend. It gets no conversation or question ids, schedules or per-question rows. The full validation receipts stay in custody beside the private file until the sealed run is scored, and are then published with the sealed receipts.
- BEAM is public, so after validation is opened the sealed set is the complement of dev and validation. The protection is procedural: the commitments prove the split was fixed before tuning, and the log shows every open.

**Overlap with a separately drawn split.** Another campaign drew its own BEAM split, called P0, independently of this grouping manifest. Eight of this wave's BEAM dev conversations are sealed in P0 and in its successor split Q2: 100k conversations 12 and 15, 500k conversations 8, 9 and 35, and 1M conversations 1, 6 and 26. These are public dev ids, already listed in the grouping manifest and the dev receipts. This wave's own sealed set is unaffected, because its grouping manifest drew it. P0's sealed set, though, has been partly opened by this wave's dev phase, so those eight conversations cannot serve as untouched sealed conversations for P0. BEAM 10M is not opened, ingested or answered by this wave. The BEAM 1M validation and sealed cells run on terms agreed with that campaign. Until its Q2 decision (`q2-parser-gaps-2026-10`) is recorded, every BEAM 1M per-question row and conversation id stays in custody. For BEAM 1M only pooled aggregates are published: no per-question rows, no conversation ids and no per-conversation scores.

## Reseal, 2026-10-05

The first private grouping file (private file `f67da64c…`, salt `d7c382d8…`) was stored where every project subagent could read it, so its validation and sealed partition is treated as possibly seen. No validation or sealed ids had been opened: no access log existed, and dev runs had used only the public dev ids. The split was therefore resealed before any open, with `memory-proof-wave-grouping.ts reseal`:

- dev ids, cluster lists and counts stay exactly as committed;
- in every stratum (BEAM 100k, 500k and 1M, PersonaMem, LifeBench), the non-dev clusters are re-split into validation and sealed with a fresh random salt by the same HMAC rule;
- the manifest's `reseals` entry records the reason, the date, the previous private file and salt commitments, and every previous validation and sealed commitment;
- the new private file (`22292099…`) goes to the repository owner's custody, outside the repository and outside any shared drive. The previous one opens nothing: its hash no longer matches the manifest.

In the smallest strata the new partition can match the old one by chance (LifeBench, 2 validation users drawn from 8: 1 in 28). That is a property of the data size, not of the procedure.

## Secondary rows

Each secondary dataset is its own row, never pooled with BEAM. Both are descriptive rows only (decided October 5): no bound-based claim is made for either.

| Dataset | Unit | Sealed clusters (questions) | Score | Note from the power report |
|---|---|---|---|---|
| PersonaMem 32k | persona (all histories of a persona together; 20 personas, 37 histories) | 12 (347) | multiple choice, its own row | Minimum detectable margin at 80% power: 3.5 to 7.4 points. Descriptive only. |
| LifeBench | user (10 users) | 6 (1,246) | binary | Coverage drops to 89–91% when a user can fail badly. Report the point estimate and per-user results only, no bound-based claim. |

## Models

The answer model is `gemini-3.8-flash` and the BEAM judge `gemini-3.5-flash` (see the table above). There is no fallback answer model. Agent-mode rows, which are descriptive only, use `gemini-3.8-flash` as the synthesis model for both systems (gbrain `think`, the comparator's reflect). They follow the gbrain eval model rules: the newest frontier model of each family, no older generations except one shared link to a previous result, and no gpt-5.4-mini. A change to a model named here is written into this file, with its reason, before any new cell runs.

## Reproduce

```bash
bun eval/runner/memory-proof-wave-grouping.ts check
bun eval/runner/memory-proof-wave-grouping.ts open --split dev --strata beam/100k,beam/500k,beam/1m
bun test test/eval/memory-proof-wave-power.test.ts test/eval/memory-proof-wave-grouping.test.ts
```

The sealed run uses [`mpw-sealed-run.sh`](../../eval/harness-provider/mpw-sealed-run.sh) and [`mpw-sealed-specs.py`](../../eval/harness-provider/mpw-sealed-specs.py). Ids, specs, cells and per-question rows stay in custody (`C`, outside the repository); cell ids are recorded in the results, since they hash the sealed schedule.

```bash
export C=<custody dir> DECISION_ID=mpw-beam-ni-2026-10-06 RESERVE=<on|off: the validation verdict> \
  GBRAIN=<gbrain checkout>@d7467d1cf LEDGER=.budget/mpw-confirm-sealed.sqlite UBI_OWNER=gbra52 UBI_GC_HOURS=0
bash eval/harness-provider/mpw-sealed-run.sh open                  # access-logged sealed open; nine specs
bash eval/harness-provider/mpw-sealed-run.sh comparator 100k <vm>  # likewise 500k and 1m, one VM per size
bash eval/harness-provider/mpw-sealed-run.sh gbrain                # combined (primary) and raw (secondary), each size
bash eval/harness-provider/mpw-sealed-run.sh judge                 # joint blinded re-judge of all three systems per size
bash eval/harness-provider/mpw-sealed-run.sh analyse               # primary NI at -3.5; raw lane as the secondary
```
