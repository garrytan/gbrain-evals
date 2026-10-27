# F2 free frozen-hit step: delivery-unit comparison (World M primary, dev as check)

No model calls, no spend, S not opened. I wrote the rule in `DECISION-RULE.md` before computing anything (sha256 in `DECISION-RULE.sha256`). To reproduce:

1. `python3 collect.py` builds `frozen.json` from the recorded cells.
2. `cd /workspace/gbrain && bun <dir>/replay.ts M ~/.capy/work/mworld/world/world.json <dir>/M.jsonl`, and the same with `dev` and `~/.capy/work/r3/world.json` for the dev world.
3. `python3 analyze.py` prints the tables in `analysis.out`.

**Method.** `replay.ts` imports every page in the frozen hit lists, rendered byte-for-byte the way the Cat 40 gbrain arm renders them, into an in-memory PGLite brain. It uses gbrain's own importer at the M build, 3e4ff61c (v0.60.139.0). It then maps each recorded hit to its chunk by text: M has 4,878 hits mapped and 7 unmapped; dev has 2,984 mapped and none unmapped. Finally it asks gbrain's own `assembleEvidenceForHits` for each unit at 6,000 tokens.

**Frozen hits.** On M there are 244 gbrain `search`/`query` calls in H4 cells whose recorded hit list contains an item's deciding document, giving 277 (call, deciding page) pairs. Of those pairs, 82 are on long pages (at least 20,000 characters) and 195 on short ones. Dev has 139 calls and 162 pairs, 35 of them long.

**Check of the replay.** The replayed chunk unit matches the recorded result on 267 of 277 M pairs (159 of 162 on dev). All 10 mismatches on M are short pages where the recorded result was cut by `snippet_chars`, which the rule says not to apply.

## Results, M (shared budget: the call's whole hit list packed into 6,000 tokens)

| unit | long: deciding sentence delivered | short: delivered | median chars per call (long calls) | median chars of the deciding block (long) |
|---|---|---|---|---|
| chunk (today, control) | 3/82 (3.7%) | 195/195 | 9,758 | 2,800 |
| window (±1 chunk) | 3/82 (3.7%) | 194/195 | 15,263 | 5,582 |
| section | 50/82 (61.0%) | 194/195 | 28,846 | 21,566 |
| page | 50/82 (61.0%) | 194/195 | 28,846 | 21,566 |

- **Isolated budget** (the deciding page's hits alone get the 6,000 tokens): section and page deliver the sentence in 82 of 82 long pairs, at a median of 32,154 characters per block. Chunk and window stay at 3 of 82.
- **Section equals page here.** The long documents have no internal headings below the title, so the section is the whole page.
- **The short miss.** The one short pair that the wider units lose has its deciding page dropped entirely: earlier-ranked pages' bigger blocks used up the shared budget.
- **Coverage by model.** These counts are long pairs where page or section delivered the sentence, shared budget: Sonnet 29 of 44, Opus 15 of 22, Sol 6 of 16. With chunk, only Sonnet had any (3 of 44).
- **Clipped hit lists.** 16 long pairs come from hit lists the transcript clipped. Leaving them out gives 47 of 66 for page or section and 3 of 66 for chunk.
- **Latency.** Medians are 17 ms for chunk and 24 ms for page, in process on local PGLite. That's indicative only.

**Dev check.** On long pairs with the shared budget, chunk 0/35, window 0/35, section 16/35 (45.7%), page 16/35 (45.7%). Short pairs are 127/127 for chunk and 126/127 for the wider units. With the isolated budget, section and page deliver the sentence in 35 of 35 long pairs.

## Rule outcome: no unit is picked

| unit | rule 1: beats chunk on long | rule 1: short not lower | rule 2: long > 90.6% (the 48/53 selector bar) |
|---|---|---|---|
| window | no (3.7% vs 3.7%) | no (194 vs 195) | no |
| section | yes (61.0% vs 3.7%) | no (194 vs 195) | no (61.0%) |
| page | yes (61.0% vs 3.7%) | no (194 vs 195) | no (61.0%) |

Under rule 4, F2 does not go on to a unit-only paid step on the strength of this step.

## What the numbers say

- **Chunk and window can't carry the decision.** Today's chunk output delivers the deciding sentence of a long page in 3 of 82 cases, and window does no better.
- **Page carries it but crowds out other pages.** Page (or section) always contains the sentence when the long page has the budget to itself, at about 32,000 characters per block. A global unit, though, spends the shared 6,000-token budget on every page in the hit list. The deciding page then misses its share in 32 of 82 long pairs, and one short deciding page is dropped outright. That's why page fails the selector bar.
- **The rule tested a global unit, not the plan's F2 policy.** This replay measured a global unit, which is what the paid step on the merge base would measure. The F2 policy in the plan is different: it widens only long non-conversation hits under implied `auto` and leaves short hits as chunks. The isolated condition (82 of 82, about 32,000 characters) is the upper bound for that scoped policy. Under a shared budget, its cost is that bytes from other pages get displaced.
- **The next step should be a frozen comparison of the scoped policy itself,** run with the same rule and a budget-accounting line of its own, before any paid unit step. It needs either the F2 delivery seam or a faithful emulation.
