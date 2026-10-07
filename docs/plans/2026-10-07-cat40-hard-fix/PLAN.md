# Cat 40 Hard fix wave: make gbrain find what plain files find

Status: draft for autoplan review, 2026-10-07. Owner: GBRA-39. Merge queue: GBRA-40.

## ELI10

gbrain lost to plain files on the Cat 40 Hard test by 11.3 points. The main reason is simple. In the test company, most records don't say a customer's name. They use a nickname ("Kumquat Vulture"), a code ("ZEU8") or "Dana's freight account". An agent with plain files greps the name, and the grep output shows the account sheet line "Nickname used by the team: Kumquat Vulture", so the agent searches the nickname next. An agent with gbrain asks gbrain for the customer's card. The card lists the name and the code, but never the nickname, so the agent believes it has every alias. It misses the records filed under the nickname and answers with an old value. The fix is to make gbrain know every name a customer goes by, and to say so on the card and in search. Smaller fixes: tell the agent how many results exist (grep does, gbrain doesn't), and stop auto-generated summaries outranking real records. Then we measure again on companies gbrain has never seen.

## What happened

Held-out result ([report](../../benchmarks/2026-10-07-model-ladder-hard.md)): 100 tasks on a 55,235-document company, Sonnet 5.5, Opus 5.5 and GPT-6.1 Sol. gbrain finished 62.0% and fs 73.3%, a paired difference of −11.3 points with 95% CI [−16.7, −6.0]. pg finished 68.3% and the oracle 98.0%.

## Root cause, from the existing 50k results (no new spend)

The analysis scripts are beside this plan: `rca.py`, `rca2.py` and `rca3.py`. They read `eval/reports/cat40/hard/cells-50k/` and the held-out world. On paired cells (same model, same task), gbrain lost 54 cells that fs won and won 20 that fs lost. That nets to 34 of 300 cells, or 11.3 points.

| Rank | Cause | Lost cells | Points (gross) | Evidence |
|---|---|---|---|---|
| 1 | **Alias blindness.** gbrain does not know an account's nickname or its owner-based name, so agents miss the records filed under them and answer with an earlier or superseded value. | 31 (H2 11, H4 10, H5 7, H3 3) | 10.3 | See the four points below. |
| 2 | **Running out of turns on aggregation.** Search has no totals or exhaustion flag and stops at 20 rows, so agents re-search instead of paging. | 20 (H1 11, H3 6, H4 2, H2 1) | 6.7 | Turn-capped gbrain cells averaged 41 searches. 50% of all gbrain searches returned exactly the 20-row cap. fs grep prints every match and a total; pg (68.3%) returns totals and an exhaustion flag. |
| 3 | **Auto-generated summaries outrank records.** | 6 of the 31 above (H2) | ~2, inside rank 1 | Agent notes are 2.0% of the corpus and 2.4% of fs grep lines, but 5.1% of gbrain search rows. Most of those come through vector matches (`weak_semantic`). Their wrong values reached six lost answers. |
| 4 | Other | 3 | 1.0 | Two H5 values not from the asked account; one incomplete H1 set. |

Evidence for rank 1:

- **The card omits nicknames.** On the 431 `entity` cards agents opened for accounts, the account's nickname appeared in `aka` zero times. `ALIAS_DECLARATION` (`src/core/mentions/aliases.ts`) recognizes `account code`, `also known as`, `a.k.a.`, `aka`, `short name`, `ticker` and `code name`. It does not recognize "Nickname used by the team:" or "the team also calls it". Its capture is also one token, so it cannot hold a two-word nickname.
- **The alias lives on a different page from the card.** The account sheet (`accounts/x`) declares the nickname, but the card resolves to the CRM record (`crm/x`). These are two pages titled for the same account, not unified.
- **Owner-based names are not resolved at all.** A reference like "<manager>'s <segment> account" depends on who owned the account on that date. That ownership is stated in handoff notes and the CRM record.
- **The outcome.** Agents learned the nickname on 66% of account-cells with gbrain against 99% with fs. They queried it on 55% against 92%. On the cells gbrain lost, gbrain agents never saw 57% of the needed documents that use the nickname (fs: 19%) and 65% of those that use the owner phrase (fs: 41%). Documents that use the name or code were seen equally by both arms.

What is not the cause: harness errors (none), tool failures, context overflow (gbrain 0, fs 1), and startup cost (warm snapshots, 25 s per restore, excluded from agent time). gbrain was 2.5 times slower per cell (p50 170 s against 68 s). That costs wall-clock time, not accuracy, and is a separate item. Where gbrain won (20 cells, mostly H3 and H4), fs had run out of turns. Fable 5.1 is the extreme case: gbrain 65%, fs 20%.

## Goal and kill criterion

**Goal.** gbrain at or above fs on a fresh held-out Hard world, pooled over Opus 5.5, Sonnet 5.5 and GPT-6.1 Sol. Fable runs in smoke tests only.

**Kill criterion.** If the confirmation shows gbrain still behind fs (point estimate below 0), we publish that result as it is. We stop this wave's tuning and do not run another round on the same tasks.

## Fixes (all gbrain product changes, one batched gbrain PR)

Nothing changes in the tasks, grading, turn cap, tool limits or any arm's settings. A harness change ships only if it applies to every arm and is justified by itself.

### F1. Every name an entity goes by (cause 1, expected +5 to +7 points)

1. **Declared-alias grammar.** Widen it to the common ways people write an alias:
   - `nickname`, `nicknamed`, `also called`, `goes by`, `known internally as`, `referred to as`, `the team calls it`;
   - quoted multi-word names, up to 4 words.

   Keep the existing precedence: frontmatter, then declared, then subject. Keep the collision guard: a derived alias never answers for another live page's exact title. Add tests with placeholder names.
2. **One identity per real-world entity.** When two linkable pages' title subjects normalize to the same name in the same source (`Account sheet: X` and `CRM record: X`), treat them as one identity. The card's `aka` then carries the aliases declared on either page, and `referenced_by` counts mentions of any alias. This builds on the existing `entity_identity.union` machinery; check its current default and turn it on for this case.
3. **Owner-based references.** gbrain already extracts owner and handoff facts from text (the facts pipeline). The card gains `known_as` rows with each owner phrase's validity window: "Dana Example's freight account", valid 2025-03 to 2025-09. The mention index then links documents that use the phrase within that window. This is general to CRMs and support desks, where people say "Dana's account". If the generic version proves too broad in review, ship the alias grammar and the identity union first and put owner phrases behind a measured follow-up.
4. **Card and tool text.** The card says `aka` is complete for declared aliases, and tells the agent to search every alias before answering a history or as-of question. This must fit the served-tool character ceiling (26,450).

### F2. Totals and exhaustive paging (cause 2, expected +2 to +3 points)

Keyword-mode search returns `total`, `has_more` and `next_offset`, and accepts a `limit` up to 100, as pg does. Hybrid mode states that it is top-K and that coverage is not proven, and points to keyword mode with totals for enumeration. `entity` → `referenced_by` already pages, and gains a total for every alias (F1).

### F3. Provenance-aware ranking (cause 3, expected +1 to +2 points)

Pages a machine wrote, either authored by an agent (`author: agent:*`) or typed as an auto-summary, rank below primary records for the same entity. Their rows carry `provenance: generated`. This is general: summaries are not evidence. That principle is already in the `entity` description ("Previews are not evidence"). Measured on the Cat 40 v1 families too, so the change doesn't regress them.

### F4. Date honesty in search rows (preventive, no points claimed)

Search rows show `effective_date`, which is the page's document date, such as a contract's signing date. In 66% of amendment rows that date differs from the in-text "Effective YYYY-MM-DD". Rename the row field to `page_date`, keeping `effective_date` as a deprecated alias for one release, so agents don't read it as the contract's effective date. The per-item analysis traced only one wrong answer to this.

### F5. Latency (no points claimed)

Profile why one gbrain cell takes 170 s against 68 s for fs, from the per-tool timings in the transcripts, and fix the top cost if it is in gbrain. This is reported, not gated.

**Expected total:** +8 to +12 points against an 11.3-point gap. Parity is plausible. A positive result is not assured, which is why the kill criterion exists.

## Development and confirmation (no tuning on held-out data)

- **Development.** Use the calibration world (seed 20261005, 50k, frozen knobs), which gbrain never ran on. Run the gbrain arm on Sonnet 5.5 and Opus 5.5, 10 tasks per family, against the round-5 fs and pg cells already recorded on that world (Sonnet 5.5). Allow 2 to 3 rounds with a fresh slot build per gbrain change. Per-round cost is about $90 in cells and $14 in slots. Free checks first: the alias-coverage proxy (share of an account's nicknames on its card, and the share of needed documents reachable from card aliases) on the calibration world, and gbrain's unit and E2E gates.
- **Confirmation, preregistered before any cell.** Use a fresh main-generator seed (never generated before), 50k, frozen knobs, gbrain against fs, Opus 5.5, Sonnet 5.5 and GPT-6.1 Sol, 100 tasks, primary endpoint gbrain minus fs. **Plus the sealed variant at 50k** with the same arms and models. Its seed is on Garry's Mac and its documents are written in phrasings gbrain was never tuned on, so a fix that only matches the main generator's wording shows up there.
- **Fable.** A 5-cell smoke only.

## Cost

| Item | Estimate |
|---|---|
| Development, 3 rounds (cells and slot builds) | ~$320 |
| Confirmation on a fresh main seed (gbrain and fs, 3 models, 100 tasks; 5 slot builds) | ~$870 |
| Confirmation on the sealed variant (same shape) | ~$870 |
| Total | **~$2,060** (new authorization; the Hard ledger has $44 left) |

A cheaper variant drops the fresh main seed and confirms on the sealed set only, for about $1,190.

## Shipping

- **gbrain.** One batched PR through GBRA-40 with F1 to F5. Register at start. Full gate (`ci:ubicloud`, `UBI_OWNER=gbra39`), PATCH version, CHANGELOG led by the measured result.
- **gbrain-evals.** The paired PR carries this plan, the root-cause scripts, the development record, the confirmation preregistration and the report. It names the gbrain PR, and the gbrain PR names it.
- **Drafts.** #76 and #77 stay drafts until the confirmation.

## Review record

(autoplan writes here)
