# Preregistration (draft, before custody): does gbrain's 8k conversion wave answer more held-out questions at a tight budget? (2026-10-26)

This is a preregistration, not a result. It fixes the question, the arms, the readers, the judge, the metric, the
decision rule, the spending cap and what each outcome means for gbrain's defaults before any sealed file is copied
into a custody root. **Status: draft.** Nothing in it runs until (1) the gbrain wave PR that adds the flags has
merged and its merge commit is written below, (2) the spend is approved, (3) the use of sealed confirmation v2's
last opening is approved, and (4) the machine-readable files and the keyless dry run listed under "Before custody"
are committed in this pull request. Owner thread: GBRA-205.

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

The question is whether these change answers on questions nobody tuned on, read the way an agent reads them.

## The question

At gbrain `<wave merge commit>` (to be filled before custody), on sealed confirmation v2, with an explicit query
budget of 5,500 gbrain tokens for an 8,000-token reader budget and the evidence read as the agent receives it: **does
each flag, added in order, answer more held-out questions than the configuration before it, without losing a
question kind or abstention?**

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

| Arm | Keys on | Call |
|---|---|---|
| A0, control (shipped default) | none | `query {token_budget: 5500}` |
| A1, F1 | `query_budget_unit=auto` | same call |
| A2, F1+F2 | A1 + `evidence_date_header`, `evidence_titles` | same call |
| A3, F1+F2+F3 | A2 + `query_facts_block` | same call |
| A4, F1+F2+F3+F4 | A3 + `fact_source_pages` | same call |
| R5, reference | none | `query {limit: 5}`, no budget (the shipped no-budget `auto`: whole conversations, 24,000 tokens), cut at the reader budget |

R5 is H1's "first five hits" arm (150 of 200 there, against `cap_only`'s 145), rerun at the pin. It decides
nothing on its own and is the comparison in F1's non-inferiority rule.

**Rendering (product text).** The reader sees the text content of the MCP tool result exactly as returned (rows,
fields and notices, in the returned order), with nothing added by the harness: no harness dates, titles or session
wrappers. Rows past 8,000 harness tokens (characters / 4) are cut whole and counted. This differs from H1 and E2,
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

## Metric and comparisons

`answer_correct` over all 200 questions; a reader error or an empty answer counts as wrong. Pairing by question,
clusters the 40 personas.

Primary family (Sonnet), each the next flag against the configuration before it:

| Comparison | Tests |
|---|---|
| D1: A1 − A0 | F1 |
| D2: A2 − A1 | F2 |
| D3: A3 − A2 | F3 |
| D4: A4 − A3 | F4 |

Persona-clustered bootstrap (20,000 draws, seed 20261026) for each difference's 95% interval, and the exact
two-sided McNemar test with Holm's correction across the four comparisons, computed by `compare.ts`.

## The decision rule

1. **Gate after retrieval**, before any reader call: every arm has one tool result per question; A0's results are
   byte-identical between the freeze and a repeat call on 20 questions chosen by seed (retrieval is deterministic at
   the pin); every A1–A4 result reports `delivery.budget_used` at most 5,500 and `auto_packing: cap_only`; facts in
   A3 and A4 take at most 22% of the budget; no row of any arm names a page outside the persona's history.
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
5. **Recommendations follow the passing prefix.** Each flag was measured on top of the ones before it, so a default
   change is recommended only for the contiguous run of recommended comparisons starting at D1. A later pass after
   an earlier non-pass is reported and recommends nothing.

## What each outcome means for gbrain's defaults

No default changes because of this run. Every flip is the owner's decision, brought with these numbers.

| Outcome | Recommendation brought to the owner |
|---|---|
| D1 recommended | flip `search.query_budget_unit` to `auto` (`BEHAVIOR_CHANGES` row; callers without a budget unaffected) |
| D1, D2 recommended | also flip `search.evidence_date_header` and `search.evidence_titles` on |
| D1–D3 recommended | also flip `search.query_facts_block` on |
| D1–D4 recommended | also flip `search.fact_source_pages` on |
| anything else | every flag stays off; the set is not reopened for these flags, and nothing is tuned on it |

Each arm is answered once. No other budget, packing, unit, reader, prompt or judge is tried on the sealed set under
this decision.

## Measured besides the decision (decides nothing)

- Every arm against R5 and against A0, Sonnet; every primary comparison under Opus 5.5 and gpt-6.1-sol.
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
| Fact extraction | 40 histories of about 143,000 tokens with the default extraction model | $25 | $60 |
| Freeze | embeddings once, about 1,200 reranked queries | $3 | $10 |
| Sonnet 5.5 readers | 1,200 calls (6 arms × 200) | $30 | $80 |
| Opus 5.5 and gpt-6.1-sol readers | 1,200 calls each | $80 | $180 |
| Judge | 3,600 gpt-4o calls | $5 | $15 |
| **Held-out total** | | **$143** | **$300** |
| Development reading | dev100 extraction, 6 arms × 100 × 2 readers, judge | $55 | $100 |

The program cap asked for is **$400** (held-out $300 plus development $100). No paid cell, development included, runs
before the spend is approved.

## Before custody (this pull request)

1. The gbrain wave merged; its merge commit written above and into `decision.json`.
2. Harness: the live product-path arms, the product-text renderer, the extraction step, R5, `decision.json`,
   `family.json` (Holm over D1–D4, plus the R5 non-inferiority interval), the verdict function with unit tests.
3. A keyless dry run on H1's invented fixture with stub models, receipts committed.
4. The development reading and the power simulation, committed.
5. The owner's approvals (spend, last opening) in the changelog.

## Changelog

### 2026-10-26: drafted

First version, before any sealed file was copied, any paid cell ran, or the gbrain wave merged.
