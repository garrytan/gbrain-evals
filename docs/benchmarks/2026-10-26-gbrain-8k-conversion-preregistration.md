# Preregistration (draft, before custody): does gbrain's 8k conversion wave answer more held-out questions at a tight budget? (2026-10-26)

This is a preregistration, not a result. It fixes the question, the arms, the readers, the judge, the metric, the
decision rule, the spending cap and what each outcome means for gbrain's defaults before any sealed file is copied
into a custody root. **Status: draft.** Nothing in it runs until (1) the gbrain commit measured is written below
(the wave PR's head, see "The question"), (2) the spend is approved, (3) the use of sealed confirmation v2's
last opening is approved, and (4) the machine-readable files and the keyless dry run listed under "Before custody"
are committed in this pull request. (1) is written; (2) and (3) were approved on 2026-10-26 (see "Approvals and spend"); (4) is in
this pull request. Owner thread: GBRA-205.

## Why this exists

An October 20 comparison of memory systems found that gbrain retrieves the needed evidence as well as or better
than any system it was compared with (every needed session in the top five for 97.9% of LongMemEval-S questions),
but turns it into fewer correct answers at an 8,000-token evidence cap: 59% through a bare-chunk adapter and 66%
through gbrain's own query path, where the strongest system scored 91%. Handing the same reader the dated sessions
behind gbrain's hits raised gbrain to 78% on that development slice. The receipts behind those numbers are the
[OSS shootout](2026-10-06-oss-memory-shootout.md), E1 and [E2](2026-10-09-gbrain-budgeted-delivery-e2.md); all of
them are development data, because LongMemEval-S guided gbrain's earlier tuning.

A read of gbrain master (v0.60.461.0) found why the query path lost: `query` with a `token_budget` and no
`return_unit` falls back to a legacy chunk trim (a characters/4 estimate over ranked chunks), so a budgeted query
never gets whole conversations, date headers or the facts-first packing that `recall` already has. The gbrain wave
(PR to be linked) adds four switches, all off by default, that close those gaps one at a time:

| Flag | Key | What it does with the key on |
|---|---|---|
| F1 | `search.query_budget_unit = auto` | `query`'s `token_budget` becomes evidence delivery's hard cap (cl100k), as for `search`: conversations are delivered whole or cut by `search.auto_packing` (default `cap_only`) |
| F2 | `search.evidence_date_header = true` plus `search.evidence_titles = true` | every delivered block starts with `[observed YYYY-MM-DD]`, and a page block's line ends with the page title |
| F3 | `search.query_facts_block = true` | every budgeted query gets question-ranked, dated saved facts, up to 22% of the budget and 40 rows, oldest first, ahead of the pages |
| F4 | `search.fact_source_pages = true` | the conversations the best-matching facts were extracted from (at most two not already present) join the hits after the top three rows |

Since spec change 7, F4 has no held-out arm: the development reading found it inert (it changed 1 of 100 tool
results and no verdict), and it is reported from that reading only. In its place B3 tests F3 alone on the shipped
default.

The question is whether these change answers on questions nobody tuned on, read the way an agent reads them.

## The question

At gbrain `cf3ec433f4fffda60d00076bae7361100c632cc4` (v0.60.461.0), on sealed confirmation v2, with an explicit query
budget of 5,500 gbrain tokens for an 8,000-token reader budget and the evidence read as the agent receives it: **does
each of F1, F2 and F3, added in order, answer more held-out questions than the configuration before it, and does F3
alone answer more than the shipped default, without losing a question kind or abstention?**

**Measured commit.** The commit above is the head of the wave PR (#7610, branch `capy/gbra205-8k-conversion`), not a
merge commit: 6f82a94 plus a documentation fold and an export golden, with `src/` identical. If `/ship` or a master
merge later changes `src/` before the flags ship, the result names the measured commit and the shipped one
separately; this run measures the one above.

## Sealed set and opening

`sealed-confirmation-v2` ([protocol](2026-10-01-sealed-confirmation-v2-protocol.md)): 200 questions over 40 invented
personas (80 multi-session, 40 temporal, 40 knowledge update, 40 abstention). Two of its three openings are used
(decision 1, `auto` vs `chunk`, `pass`; decision 2, H1, `depth_first` vs `cap_only`, `fail`). **This decision
would use the third and last opening.** That is a one-way door and needs the owner's explicit approval, recorded in
the changelog below before custody. The access log is expected at 35 lines; any other state stops the run.

## Arms

Every arm reads the same brain: the 40 histories imported at the pin, then gbrain's conversation fact extraction
run once over every history with gbrain's default extraction model (the condition "where an extraction key exists").
Arms differ only in the GBRA-205 keys. Retrieval is live through the product path: one `query` call per question
and arm, `limit: 25`, no expansion, `openai:text-embedding-3-large` at 1,536 dimensions, gbrain's default
reranker, made through the MCP dispatch as a local stdio agent, so the arm's evidence is exactly the tool result an
agent receives.

Each brain also sets `facts.default_visibility = world`, the single-principal posture `gbrain bootstrap` writes
when the key is unset. Without it extracted facts are private, and a stdio agent (a remote caller in gbrain's trust
model) never sees them, so F3 would measure nothing. Every other brain setting is E2 and H1's query-path pins.

After extraction, each brain gets gbrain's own operator remedy for the doctor's `safe_index_pending` check:
`gbrain repair safe-chunks` (preview), then `--apply`, embedding as normal (safe-chunks is not preview-bound, so
the preview prints no `--expect` hash). Extraction writes an `extract_receipt` page that is never chunked, and
until it is re-sealed every remote query reports `safe_index_pending` and carries a degraded-recall block. The
brain the arms read is therefore "the imported histories, extraction, and the doctor-recommended safe-chunks repair".
Once re-sealed, the receipt (a short page of extraction counts) is retrievable like any page, so it can appear as a
row in any arm's result, as it would for an agent on a repaired brain.

| Arm | Keys on | Call |
|---|---|---|
| A0, control (shipped default) | none | `query {token_budget: 5500}` |
| A1, F1 | `query_budget_unit=auto` | same call |
| A2, F1+F2 | A1 + `evidence_date_header`, `evidence_titles` | same call |
| A3, F1+F2+F3 | A2 + `query_facts_block` | same call |
| B3, F3 alone | `query_facts_block` only (A0 plus F3: the facts block under `query`'s legacy chunk budget) | same call |
| R5, reference | none | `query {limit: 5}`, no budget (the shipped no-budget `auto`: whole conversations, 24,000 tokens), cut at the reader budget |

R5 is H1's "first five hits" arm (150 of 200 there, against `cap_only`'s 145), rerun at the pin. It decides
nothing on its own and is the comparison in F1's non-inferiority rule.

**Rendering (product text).** The reader sees the text content of the MCP tool result exactly as returned (rows,
fields and notices, in the returned order), with nothing added by the harness: no harness dates, titles or session
wrappers. Rows past 8,000 harness tokens (characters / 4) are cut whole and counted: whole rows come off the end of
the result's JSON row array, and the kept rows keep gbrain's bytes. This differs from H1 and E2,
whose renderer rebuilt dated pseudo-sessions; dates and titles are part of what F2 tests, so the harness must not
supply them. The reader template is memory-qa's LongMemEval reading prompt with this text in place of the sessions.

## Readers and judge

- Primary reader, decides: `anthropic:claude-sonnet-5-5`, at most 1,024 output tokens, no temperature.
- Replay readers, descriptive: `anthropic:claude-opus-5-5` and `openai:gpt-6.1-sol`, every arm. Before custody the
  newest frontier model of each family is checked (gbrain-evals `CLAUDE.md`, "Choose models"); a newer one is added
  or substituted here, with the reason, before any cell runs. No Fable, no older generation, no gpt-5.4-mini.
- Judge: `gpt-4o-2024-08-06`, temperature 0, LongMemEval's per-kind prompts, through `sealed-confirmation.ts score
  --judge --decision-id`. It is the official LongMemEval judge and the one shared with decisions 1 and 2, which is
  the single older model the rules allow.

**The reader set complies with the project's eval model rules** (gbrain-evals `CLAUDE.md`, "Choose models"; checked
again at spec change 7). The held-out readers are the newest model of each frontier family: Sonnet 5.5 (primary),
Opus 5.5 and gpt-6.1-sol. `gpt-4o-2024-08-06` appears only twice: as the development cell's matched reader, named as
the single older-generation link to the OSS shootout's numbers (its 59%, 66% and 78% were read by it), and as
LongMemEval's official judge. No Fable model and no gpt-5.4-mini runs in any cell.

## Metric and comparisons

`answer_correct` over all 200 questions; a reader error or an empty answer counts as wrong. Pairing by question,
clusters the 40 personas.

Primary family (Sonnet): D1 to D3 each add the next flag to the configuration before it; D3′ (id `D3p`) adds F3 alone
to the shipped default:

| Comparison | Tests |
|---|---|
| D1: A1 − A0 | F1 |
| D2: A2 − A1 | F2 |
| D3: A3 − A2 | F3 |
| D3′: B3 − A0 | F3 alone |

Persona-clustered bootstrap (20,000 draws, seed 20261026) for each difference's 95% interval, and the exact
two-sided McNemar test with Holm's correction across the four comparisons. `compare.ts` computes each pair's
interval and McNemar p; the verdict function (`decideC8k`) applies Holm across the four, because `compare.ts` sees
one pair at a time.

## The decision rule

1. **Gate after retrieval**, before any reader call: every arm has one tool result per question; A0's results are
   byte-identical between the freeze and a repeat call on 20 questions chosen by seed (retrieval is deterministic at
   the pin given the cell's retrieval response cache, spec change 6); every A1–A3 result reports `delivery.budget_used` at most 5,500 and `auto_packing: cap_only`; facts in
   A3 and B3 take at most 22% of the budget; every result belongs to an arm of the table; no row of any arm names a page outside the persona's history (the brain's own extraction receipt is counted, not
   refused); no result
   of any arm reports the `safe_index_pending` degraded stage.
2. **Final gate** after the readers: every context re-renders to the bytes the reader got; every arm has one row per
   question; cuts are counted per arm.
3. **Verdict per comparison** (H1's rule, Holm-adjusted):
   - **pass**: both gates pass; the difference is above zero with its 95% interval above zero and the Holm-adjusted
     McNemar p below 0.05; no question kind with a clear loss (exact one-sided McNemar on that kind's discordant
     pairs, p < 0.05); the abstention score not below the earlier configuration's.
   - **fail**: a gate fails, a kind shows a clear loss, abstention falls, or the whole interval is below zero.
   - **inconclusive**: otherwise, including a blocked comparison or more than 3 reader errors in either arm.
4. **F1's held-out risk is part of its rule.** H1 measured `cap_only` at 145 of 200 against 150 for the first five
   hits delivered whole (difference +2.5, interval −1.0 to +6.5). So D1's pass recommends F1 only if A1 is also
   non-inferior to R5: the lower bound of the persona-clustered 95% interval of A1 − R5 is above −5 points. A D1 pass
   that misses this is reported as "pass, not recommended": the cap beats the chunk trim but a budgeted top-five
   whole-session delivery may beat the cap, and that design is left to new held-out material.
5. **Recommendations.** D1 to D3 each measure a flag on top of the ones before it, so they recommend only as the
   contiguous run of recommended comparisons starting at D1; a later pass after an earlier non-pass is reported and
   recommends nothing. F1 keeps its non-inferiority check against R5 (step 4). D3′ measures F3 alone on the shipped
   default, so F3 is recommended when D3′ passes, whatever D1 to D3 do (spec change 7). Guards 7 and 8 apply to D3′
   as to every comparison, and Holm runs across all four.

## What each outcome means for gbrain's defaults

No default changes because of this run. Every flip is the owner's decision, brought with these numbers.

| Outcome | Recommendation brought to the owner |
|---|---|
| D1 recommended | flip `search.query_budget_unit` to `auto` (`BEHAVIOR_CHANGES` row; callers without a budget unaffected) |
| D1, D2 recommended | also flip `search.evidence_date_header` and `search.evidence_titles` on |
| D1–D3 recommended | also flip `search.query_facts_block` on |
| D3′ passes (whatever D1 to D3 do) | flip `search.query_facts_block` on |
| anything else | every flag stays off; the set is not reopened for these flags, and nothing is tuned on it |

Each arm is answered once. No other budget, packing, unit, reader, prompt or judge is tried on the sealed set under
this decision.

## Measured besides the decision (decides nothing)

- Every arm against R5 and against A0, and A3 against B3, Sonnet; every primary comparison under Opus 5.5 and gpt-6.1-sol.
- F4, from the development reading only: inert (1 of 100 tool results changed, no verdict changed); no held-out arm.
- Packed recall: every gold chat among the chats the reader saw, over the 160 answerable questions.
- Per arm and kind: score, delivered tokens, rows, conversations delivered, fact rows, cuts, reader tokens, errors.
- Fact extraction: facts written per history, extraction spend, failures.
- Spend per step against its estimate.

## Development reading first (not held-out)

Before custody, the same six arms run on LongMemEval-S dev100 (the shootout's stratified seed-42 slice) at the same
budgets, read by `gpt-4o-2024-08-06` (the shootout's matched reader, the only link to its 59%/66%/78%) and Sonnet
5.5, judged by the official GPT-4o judge. It decides nothing. It checks the harness end to end on paid models,
measures cost per arm, and supplies per-kind paired rows for the power simulation below.

## Power, computed before custody

A simulation like H1's (`scripts/power.ts`) draws each sealed-shaped question's pair from the development
reading's rows of the same kind and runs the committed family and verdict function. Its output is committed here
before custody. If any comparison's simulated P(pass) under the development effects is below 20%, the
preregistration says so plainly; the run still goes ahead only on the owner's approval.

**Known limitation: the abstention pool is small.** dev100 holds only about 4 abstention questions (LongMemEval-S has
30 in 500), so the simulation draws sealed v2's 40 abstention questions from very few development pairs and its
guard 8 estimates are noisy. The design is unchanged; the limitation is reported with the power output.

**Result after spec change 7 (`power.json`, 1,000 simulations per scenario, from the paid development reading's
Sonnet 5.5 rows with B3 read).** Under the development effects, P(pass) is D1 34.1%, D2 71.6%, D3 100% and D3′ 100%;
F3 is recommended in every simulation, F1 in 11.3% and F2 in 4.7%. No comparison is below 20%. D3′'s figure is
optimistic: on dev100 Sonnet 5.5 gained 10 questions with B3 over A0 and lost none, so the resampled pools hold no
B3 loss to draw, and the abstention pool (4 questions, all right in every arm) cannot exercise guard 8. Under the
null (no flag has any effect), each comparison passes at most 0.7% of the time, and F3 is recommended 0.4% of the
time. Before spec change 7, the same simulation put D4 at 0% (F4 changed 1 of 100 tool results and no verdict) and
the most likely outcome at no recommendation (91%).

## Custody

The chain runs on the owner's Mac under `~/Private/gbrain-heldout-custody/c8k-sealed-v2/`, with H1's custody steps:
copy the sealed files from the owner's private directory, check them and the access log against the manifest and
`decision.json`, write a label-free corpus, run extraction, freeze, readers and score as local lease cells inside
the root, export aggregates only, and return the access log only if every added line is this decision's. Fact
extraction and readers send the chat text to model providers, as H1's readers and P8's grounding did; nothing is
tuned on it. No sealed text goes to a Capy machine, Capy Drive or the repository.

## Budget

Estimated at list prices (Sonnet 5.5 and gpt-6.1-sol $2 and $10, Opus 5.5 $4 and $20 per million input and output
tokens).

| Step | Basis | Estimate | Lease cap |
|---|---|---:|---:|
| Import | 40 histories embedded once with text-embedding-3-large | $1.50 | $5 |
| Fact extraction | 40 histories of about 143,000 tokens with the default extraction model | $25 | $50 |
| Freeze | about 1,220 queries: query embeddings and reranks | $1.50 | $3 |
| Sonnet 5.5 readers | 1,200 calls (6 arms × 200) | $30 | $55 |
| Opus 5.5 and gpt-6.1-sol readers | 1,200 calls each | $80 | $115 |
| Judge | 3,600 gpt-4o calls | $5 | $12 |
| **Held-out total** | | **$143** | **$240** |
| Development reading | dev100 import ($4 cap), extraction ($13), freeze ($2), 6 arms × 100 × 2 readers ($36), judge ($5) | $35 | $60 |
| **Program** | | **$178** | **$300** |

**Program total with Opus included, after spec change 7:** the development reading's actual ledger spend, $36.65
($33.31 before the amendment plus $3.34 for the B3 rerun: readers $3.19, judge $0.14, freeze under $0.01), plus the
held-out lease of $240 (Opus 5.5 and gpt-6.1-sol readers included, arm count unchanged) is at most **$276.65**, within
the $300 the owner approved.

The program cap asked for was $400 (held-out $300 plus development $100). The owner approved **$300 for both
together** (below), so the lease caps above were cut to fit it; no estimate changed. Every step is a local lease cell
of one campaign (`manifests/campaign.json`, cap $300) whose ledger the development and held-out cells share, so the
cap holds across both. No paid cell, development included, runs before the default-off wave PR and this pull
request are in place.

## Approvals and spend

**Spend and the last opening: approved by Garry on 2026-10-26** (decision relayed by GBRA-108). The Q1 eval cap rises
to $8,800. Of it, **$300 is leased to this preregistration, one cap covering the development reading and the
held-out F1–F4 cells together** (about $50 and $250). The approval is also the authority to use sealed confirmation
v2's third and last opening for these cells. In his words: "launch them once the default-off wave PR and the
gbrain-evals prereg PR are in place". Anything past $300 goes back to him before it is spent. The owner launches
the paid cells; no agent does.

## Before custody (this pull request)

1. **Half done.** The measured commit is written above and into `decision.json` (`gbrain.commit`, the wave PR's head
   `cf3ec433`). Still open: the custodian's reading of the access log written into `decision.json`
   (`sealed.access_log_before`, 29 of 35 lines `fill-at-custody`); the harness refuses every sealed step until then.
2. **Done.** Harness (`eval/runner/budgeted-delivery/c8k.ts`, `c8k-product.ts`, `c8k-run.sh`): the live
   product-path arms through the stdio dispatch, the product-text renderer, the extraction step, R5, `decision.json`,
   `family.json` (Holm over D1, D2, D3 and D3′, plus the R5 non-inferiority interval), the campaign and cells, the verdict function
   with unit tests (`test/eval/budgeted-delivery-c8k.test.ts`).
3. **Done.** A keyless dry run (`c8k-dry-run.sh`) on H1's invented fixture with stub models, receipts in
   `2026-10-26-gbrain-8k-conversion/receipts/dry-run/`, including a keyless pass of the development cell.
4. **Done.** The development reading (`c8k-run.sh dev`, paid) and the power simulation over its rows
   (`scripts/power.ts --dev-scores`), committed: aggregates in `2026-10-26-gbrain-8k-conversion/receipts/dev/`, the
   simulation in `2026-10-26-gbrain-8k-conversion/power.json`, rerun for the amended family after spec change 7 (B3
   read by both development readers and judged against the same freeze); no comparison is below 20%.
5. **Done.** The owner's approvals (spend, last opening), above and in the changelog.

## Changelog

### 2026-10-26: spec change 7, B3 replaces A4 (GBRA-108's call)

Before custody, after the paid development reading; nothing held-out has run. GBRA-108 decided to amend after the
development reading found F4 inert and showed that the passing-prefix rule would most likely recommend nothing even
with F3's effect intact (P(D1 recommended) 9%, P(no recommendation) 91%).

- **Arms.** B3 (A0's configuration plus `search.query_facts_block` alone, the same call) replaces A4. Six arms:
  A0, A1, A2, A3, B3, R5. No held-out arm sets `search.fact_source_pages`.
- **Confirmatory family (Sonnet 5.5).** D1, D2, D3 and D3′ (id `D3p`, B3 against A0), Holm across the four. F3 is
  recommended if D3′ passes, whatever the prefix; F1 and F2 keep the contiguous-prefix rule from D1, and F1 keeps its
  non-inferiority check against R5. D3 inside the prefix still recommends F3 as the flag stacked on F1 and F2.
  Guards 7 and 8 apply to D3′. `decideC8k` and its tests cover D3′ passing while D1 fails, D3′ failing while D3
  passes, and Holm across four. Descriptive: B3 against R5, A3 against B3, and D3′ under Opus 5.5 and gpt-6.1-sol.
- **F4** is reported from the development reading only: inert (1 of 100 tool results changed, no verdict changed),
  with no held-out arm.
- **Gate 1** applies the budget-cap checks to the arms that set F1 (A1 to A3), the facts-share check to the arms that
  set F3 (A3, B3), and refuses any result of an arm outside the table.
- **B3 fires without F1** (keyless dry run, before any paid B3 call): with query's legacy chunk budget the facts block
  is applied to every budgeted query, as in gbrain's `applyFactsStage`. On dev100, 44 of 100 B3 results carry fact
  rows (A0: 21, from the default facts arm), the largest facts block is 471 tokens against the 1,210-token share, and
  B3's tool result differs from A0's on 47 of 100 questions; on the fixture, 24 of 60, with no facts-share violation.
- **The development cell** keeps its freeze and cache: the freeze adds B3 to each frozen history after its own
  warm-up call and moves A4's rows to `evidence/retired/`, the A0 repeat stays as frozen, and readers and the judge
  resume per arm, so only B3 is read and judged.
- **Receipts.** The keyless dry-run receipts are regenerated with the retrieval-cache section and B3.

### 2026-10-26: retrieval response cache before the paid freeze reruns

Before any reader call of the paid development reading; nothing held-out has run.

- Spec change 6, construction: the freeze runs behind a retrieval response cache scoped to its cell. The paid
  development freeze failed gate 1 three times (0, 10 and 9 of 20 A0 repeats byte-identical). The stored repeat
  blocks showed why: every mismatch had the same retrieved rows with scores differing in the third or fourth decimal,
  and in 4 of 11 near-tied rows swapped or one row entered or left the set (once also changing which blocks came
  back). Real embeddings and the Voyage reranker do not return bit-identical floats for identical requests; the
  keyless runs (hash vectors, reranker off) never met this. Gate 1 stays as written. Embedding calls go through H1's
  cache (gbrain's `EmbeddingCache` / `installEmbedCache`, as the H1 / E2 freeze in
  `eval/runner/evidence-delivery/freeze.ts` ran it), keyed provider, model, dimensions, side and the text's SHA-256,
  one value of an embedding request. Rerank calls go through gbrain's rerank transport seam into a cache keyed by
  provider, endpoint path, model and the full request body, storing the first 2xx response's bytes. One cache serves
  every arm and the repeat in a cell, so a query embeds once and every arm sees the same vectors and rerank scores,
  which also keeps provider noise out of the paired comparisons. It lives in the cell's directory inside the custody
  root (`<cell>/cache/retrieval`), is never shared between the development and held-out cells and is never
  committed; the freeze receipt records its hit and miss counts and content hashes. Chat (readers, judge) and
  extraction calls stay uncached. Code: `budgeted-delivery/c8k-retrieval-cache.ts`.
- Harness, before the second freeze: one warm-up call per brain takes the once-per-brain `behavior_changes`
  disclosure (a brain imported over an hour before its first stdio call gets it, and it had landed in 99 brains'
  first A0 result), and gate 1 refuses any arm result that carries it. Freeze repeat rows now store their blocks, for
  diagnosis.

### 2026-10-26: development caps re-split before the paid development reading

The keyless dev100 run measured the development volumes: about 12.2M tokens of haystack text to embed (about $1.60,
reserved at bytes/3), so the $1 import cap could not hold. Within the same $60 development cap the step caps are now
import $4, extraction $13, freeze $2, readers $36, judge $5, and the estimates follow the measured volumes ($35 in
all). Nothing held-out changed.

### 2026-10-26: safe-chunks repair, measured commit

Before any sealed file was copied or any paid cell ran.

- Spec change 5, construction: each brain's state is "extraction plus the doctor-recommended safe-chunks repair"
  (`gbrain repair safe-chunks` preview, then `--apply`), and gate 1 checks that no result reports
  `safe_index_pending`. The extraction receipt page is never chunked at the pin, so without the repair every arm's
  evidence would carry a degraded-recall block. After the repair the receipt is a retrievable page; gate 1 counts
  its rows (`extract_receipt_rows`) instead of refusing them as outside the history. The underlying gbrain bug (the receipt writer stores the page without
  chunking it) is fixed outside this decision.
- The measured commit is the wave PR's head `cf3ec433`, not a merge commit ("The question").
- Power: the small development abstention pool is recorded as a known limitation.
- The keyless dry run was repeated at `cf3ec433` for both cells; receipts replaced.

### 2026-10-26: harness, keyless dry run, approvals

Before any sealed file was copied or any paid cell ran. Garry approved the spend ($300 for the development reading
and the held-out cells together) and the use of the last opening ("Approvals and spend"). Added the harness, the
decision directory and the keyless dry run's receipts. Changes to the text above, each the smallest that fits:

- Budget: the lease caps were cut from $300 held-out plus $100 development to $240 plus $60, inside the approved $300;
  import is its own step. Estimates unchanged.
- Arms: each brain sets `facts.default_visibility = world`. Without it a stdio agent never sees extracted facts
  (a gap the draft missed; gbrain bootstrap writes the same posture).
- Rendering: the cut is stated exactly (whole rows off the end of the JSON row array, gbrain's bytes kept).
- Metric: Holm across D1–D4 is applied by the verdict function, not by `compare.ts`, which sees one pair at a time.

### 2026-10-26: drafted

First version, before any sealed file was copied, any paid cell ran, or the gbrain wave merged.
