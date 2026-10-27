# Root cause of gbrain's two weak spots: wrong answers and M H4

Free analysis (no model calls, no spend), October 11, 2026. Inputs are World M (the counted confirmation, 300 cells per arm) and the development world (r3, 150 cells per arm). No S cells or transcripts were opened. Every number below is printed by `rca_next.py`; run `python3 nextwave/rca_next.py --json nextwave/rca_next.json` from `~/.capy/work` (about 40 seconds) and compare against `rca_next.out`. Counts, task ids, families, models, tool names and document types only; no names, values or document text.

## Verdict

Both weak spots have the same root cause: gbrain answered from the account's own older record (the original contract or a superseded amendment) because the sentence that decides the current value never reached the model. In the 11 M H4 cells that fs won and gbrain lost, 12 of the 13 failed items never had the deciding sentence in any tool result. The deciding document was either never returned (7) or returned only as a chunk that didn't contain the sentence (5; 2 of these are uncertain because the transcript clipped the result). In 9 of the 13 items the deciding document was a long executed contract or amendment of 30,185 to 38,962 characters. In none of the 13 did the model open the deciding document with `get_page`, although every one of the 52 `get_page` calls on a long H4 document did return its deciding sentence. Alias or entity confusion, values found in no document, and turn-cap rushes explain none of the gap.

The realistic ceiling for fixing the top two causes is +6.0 points of pooled gbrain − fs on M (+2.7 on dev). That counts only cells where fs, on the same model and task, got it right. If every cell with those causes flipped, the ceiling would be +7.3 points on M and +4.0 on dev. Treat these as ceilings, not promises.

## A correction to my earlier draft

The first run of the script reported 14 gbrain items as class (b) alias confusion and 8 fs items as class (d) value in no document. Both counts came from a boundary bug in the value matcher. It stripped whitespace, so a number directly after a word ("change to" + number) failed the "not inside a longer word" test. That made the account's own documents look like they didn't contain the value. After the fix, (b) and (d) are 0 on both worlds. Two checks agree with the corrected numbers. First, every one of the 32 gbrain and 17 fs wrong cells either named a value from the task's listed wrong values, which the generator draws only from the asked account's own history, or was an H1 set or count error, so no answer carried an unlisted value that could have come from another account. Second, a direct trace of the formerly-(b) items found the value in the account's own amendments, emails and agent notes.

## 1. Wrong answers by class (World M)

Totals reproduce the published counts. Cells that named a listed wrong value: gbrain 22 (Sonnet 15, Opus 7, Sol 0), fs 14 (Sonnet 7, Opus 1, Sol 6). Wrong submitted cells including H1 set or count errors: gbrain 32, fs 17. The table counts failed items; an H1 cell counts as one item.

| Class | gbrain | fs | gbrain So/Op/Sol | fs So/Op/Sol | gbrain H1..H5 | fs H1..H5 |
|---|---|---|---|---|---|---|
| (a) superseded or older value of the account | 22 | 20 | 16/6/0 | 7/3/10 | 0/6/3/13/0 | 0/5/0/2/13 |
| (b) alias or entity confusion | 0 | 0 | | | | |
| (c) set or count error (H1) | 10 | 3 | 2/3/5 | 1/1/1 | 10/0/0/0/0 | 3/0/0/0/0 |
| (d) value in no document or session | 0 | 0 | | | | |
| (e) generated summary or agent-note text | 1 | 0 | 1/0/0 | 0/0/0 | 0/1/0/0/0 | 0 |
| (f) other | 0 | 0 | | | | |
| disclosed extra: (g) unsigned draft or hearsay email | 3 | 0 | 2/1/0 | 0/0/0 | 0/0/0/3/0 | 0 |
| disclosed extra: (a_future) amendment applied before its effective date | 0 | 0 | | | | |

How the classes are assigned: a wrong value is classified by where it occurs among the asked account's documents (H5 also checks its session text). When it occurs in several, the first tool result that carried it decides. Two classes extend your list, and I kept them separate rather than fold them in. (a_future) is a subclass of (a), split out to test whether amendments that aren't yet effective trip the model; it is 0 everywhere, so it adds nothing. (g) is the generator's lower-authority sources, the unsigned DRAFT amendment and the "summary from the call" email. They aren't generated summaries, so they don't fit (e). Fold them into (e) if you read (e) as "non-authoritative text taken as evidence", or into (f) otherwise.

**Which tool carried the wrong value.** For gbrain class (a), the first carrier was `search` in 16 of 22 items, then `context_pack` 2, `get_page` 2 and `get_backlinks` 2. In 20 of the 22, that result also named the stale source document, so the model was shown where the old value came from. The right document appeared somewhere in the cell for only 12 of 22. The three (g) items came from `context_pack` (2) and `get_backlinks` (1). The (e) item came from `search`. Source document types for gbrain's wrong values were contract 11, amendment 11, email 3 and agent note 1. For fs, the carriers were `read_file` 15 and `grep` 5. fs's (a) errors are mostly H5 (13 of 20 items; Sol accounts for 10 of the 20), where it kept an earlier session's value. That failure is fs-specific, and gbrain has none of it.

**Should have abstained.** Neither world has a task whose correct answer is "unknown", and neither arm abstained on any item (0 and 0), so the strict measure is 0 by construction. The useful proxy is answering an item without the deciding document ever being returned: gbrain did this on 15 of 36 failed items (H1 2, H2 5, H4 8), fs on 4 of 10 (H2 3, H4 1).

**Turn-cap rush.** The turn cap is 16. Only 4 of gbrain's 32 wrong cells were submitted at turns 14 to 16, against 5 of fs's 17. gbrain's wrong cells have a median submit turn of 8, against 12 for fs. gbrain's wrong answers are early and confident, not rushed.

## 2. M H4, paired by task and model (gbrain 47, fs 56 of 60)

**What H4 tests (from the generator).** Each H4 task asks for one current contract term (seats, payment terms, uptime SLA or liability cap) for each of several accounts. Each item is one of four variants. In "contract holds", the original contract still governs. In "amended", one executed amendment changes the term. In "later effective wins", two executed amendments exist, and the one with the later effective date governs even though it was signed earlier. In "future effective", an executed amendment isn't effective yet, so the contract still governs. Lower-authority distractors (an unsigned draft, a call-summary email, an auto-generated agent note) carry other values. A knob makes some executed documents long, with the deciding sentence buried in 26,000 to 40,000 characters of boilerplate ("+long" below).

**Cells.** fs won 11 cells and lost 2, with 45 both and 2 neither. Each fs win is a different task on one model (H4-02, 03, 04, 08, 09, 10, 11, 13, 17, 18, 19). gbrain's two wins were Sonnet on H4-11 and H4-12, and fs won H4-11 on Opus, so H4-11 nets to a tie. That reproduces holdout_stats' 1 better / 10 worse / 9 tied tasks. Sonnet lost 6 of the 11 fs-won cells and Opus 5; Sol lost none.

**Items by variant (all models).** The gap sits in the long amended variants. On "amended+long", gbrain got 16 of 21 items right and fs 20. On "later effective wins+long", gbrain got 11 of 15 and fs 14. Every other variant is within one item, and gbrain is one item ahead on short "later effective wins" (41 against 40).

**Where gbrain's path diverges (13 failed items in the 11 cells).**

- **Search miss (7).** The deciding document was never returned. 4 of these are short documents: a short amendment, or the contract in a "future effective" item. 3 are long. The 126 `search` calls in these cells never used a date filter.
- **Returned without the deciding sentence (5).** The deciding document showed up as a search hit or backlink, but no result contained the sentence that sets the value. 2 of these are uncertain because a result naming the document passed the 40,000-character transcript cap. The model saw the full result, so it may have seen the sentence. 4 answered class (a) and 1 class (g).
- **Shown and still answered stale (1).**
- **Turn budget (0).** No lost cell hit the turn cap.
- **Missing count or total (not applicable).** H4 answers one value per item.

Over all 52 `get_page` calls on long H4 documents, the deciding sentence was in the result 52 times. So opening the long document works; the model just didn't open it in these cells. Meanwhile it used fewer steps than fs on the same tasks, with a median of 19 tool calls against 28 and 8 turns against 10.

**Entity card gap.** An asked H4 account has a median of 29 documents. Across all gbrain H4 cells, `context_pack` results listed 4.2 of the account's documents on average and included the deciding document in 8 of 88 results. `get_backlinks` listed 7.8 and included it in 25 of 62. `entity` results listed no documents. In the 11 lost cells, no `entity` or `context_pack` result listed the deciding document for any of the 39 items. Nothing in gbrain's account-level views points the model at the executed amendments or their effective dates. A model that trusts the card or a snippet answers from the original contract.

## 3. Development world: systematic or noise

The dev gbrain cells (dev-r5, 50 tasks per model) and the M cells come from the same gbrain build, 3e4ff61ce, according to their receipts. The dev fs cells come from an earlier round on a different day (dev-r4-fs), so dev comparisons across arms are looser than M's. Pooled, gbrain led on dev, 125 to 111 of 150 (+9.3 points).

The patterns that hold:

- **Class (a) dominates gbrain's wrong answers.** It accounts for 6 of 8 failed items on dev (Sonnet 5, Opus 1, Sol 0). (b) and (d) are 0, (e) is 1, (c) is 1.
- **`search` carries the stale value.** It was the first carrier for 5 of the 6 (a) items, and every carrier result named the stale source document.
- **Sonnet carries the wrong answers.** It accounts for 5 of gbrain's 6 dev cells that named a listed wrong value, against 15 of 22 on M.
- **Early submits.** gbrain's wrong cells have a median submit turn of 8, and none was submitted at turns 14 to 16.
- **The card gap is the same.** `context_pack` lists 4.5 of an account's documents and includes the deciding document in 3 of 46 results; `entity` lists none. `get_page` on long documents returned the deciding sentence 22 of 22 times.

The H4 deficit itself does not reproduce on dev, where H4 tied 27 to 27 and the two arms traded two cells each. Dev has fewer long amended items (15 against M's 36), and both arms got 10 of 12 on "amended+long". The one dev H4 loss of the fs-wins kind is the same signature: a long amendment returned without its deciding sentence. So the mechanism is systematic, while the size of the M H4 gap depends on how many long amended items the world draws. Expect H4 to swing with that knob.

## 4. Ceiling and headroom

**Paired cells by family on M (same model and task).**

| Family | gbrain wins, fs loses | fs wins, gbrain loses |
|---|---|---|
| H1 | 8 | 1 |
| H2 | 13 | 5 |
| H3 | 11 | 2 |
| H4 | 2 | 11 |
| H5 | 8 | 0 |

**gbrain's 64 failed cells on M, by cause.** Turn cap or no answer accounts for 32 (mostly H1, where fs also fails), class (a) for 18, (c) for 10, mixed (a)+(g) for 2, and (e) and (g) for 1 each. Of the 19 cells fs won and gbrain lost, 18 are wrong-value cells of classes (a), (g) or (e). The other one is a turn cap.

The top two causes to fix are the superseded value (a) and the lower-authority source (g/e). They are one mechanism: the term's governing record never reached the model. Turn cap is larger by count, but fs fails 31 of those 32 cells too, so fixing it wouldn't close any gap with fs, and nothing in these runs shows it can be fixed.

| Fix | M ceiling (all cells) | M fs-matched bound | dev ceiling | dev fs-matched bound |
|---|---|---|---|---|
| (a) superseded value | +6.0 (18 cells) | +4.7 (14) | +3.3 (5) | +2.0 (3) |
| (a) + (g/e) | +7.3 (22) | +6.0 (18) | +4.0 (6) | +2.7 (4) |
| turn cap, for comparison | +10.7 (32) | +0.3 (1) | +12.0 (18) | +1.3 (2) |

Points are pooled gbrain − fs over 300 M cells (150 dev); one cell is 0.33 points on M and 0.67 on dev. "fs-matched" counts only cells where fs succeeded on the same model and task, so the evidence says they're solvable. On H4 alone, flipping the 11 fs-won cells would take gbrain from 47 to 58 against fs's 56: +3.3 points on H4 instead of −15.0.

## What this points to for the next wave

These follow from the mechanism above. They are not tested.

1. **Make account views list the governing contract record.** Have `entity` and `context_pack` list each executed contract and amendment for the account, with its signed and effective dates, ahead of emails and notes. This targets the search misses and the card gap together.
2. **Surface the deciding chunk of long executed documents.** For long documents, search should return the chunk that matches the asked term (or the doc's "Effective … change to …" sentences), or flag that the hit is part of a long document and that `get_page` should be used. This targets the "returned without the deciding sentence" items.
3. **Label authority in results.** Mark DRAFT and call-summary sources as unsigned or hearsay in result headers. The (g) items came through `context_pack` and `get_backlinks`, so the label belongs there too.

These rows could be lifted only by a change in model behavior, and agent instructions alone have not moved that before: gbrain answers early (median turn 8) from snippets. A retrieval-side fix doesn't depend on that behavior.

## Limits

- The deciding-sentence test was checked against items answered right: the sentence was present in 194 of 194 right gbrain H4 items and 200 of 200 fs items on M (dev: 107 of 108 and 102 of 102). Transcripts clip each tool result at 40,000 characters, and the model saw the full result, so "not shown" is uncertain for the 2 items flagged above.
- The class rule picks the first carrying result. When a value also appears in a correction email or agent note, the authority order (a_future, a, g, e) decides among documents in the same result.
- The dev fs arm is from a different round and day than the dev gbrain arm.
