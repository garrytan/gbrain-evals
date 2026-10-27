# F2 scoped policy, frozen replay (World M primary, dev as check)

No model calls and no spend; S was not opened. The rule in `DECISION-RULE.md` was written and hashed before anything was computed; the hash is in `DECISION-RULE.sha256`. Everything else in this directory:

- `replay_scoped.ts` runs the replay against `gb-scoped/`, a scratch copy of gbrain at the M build 3e4ff61c. `patch.diff` shows the three emulation hooks. The gbrain checkout itself is unchanged.
- `analyze_scoped.py` prints `analysis.out`.

**What was emulated.** gbrain's own `auto` path, with long non-conversation pages added to the widened groups at unit U. Long means a rendered body of at least 20,000 characters (21 such pages appear in M's hit lists, 13 in dev's). All other hits stay ranked chunks, reserved first, exactly as `auto` reserves them today. There is no explicit budget, so the cap path stays off. The budget comes from `search.return_budget_conversation`.

**Pairs.** These are the same frozen pairs as the global-unit step: 277 (call, deciding page) pairs on M, 82 long and 195 short. Dev has 162, 35 of them long.

## M at B = 6,000 tokens (the deciding budget)

| variant | long covered | short covered | short lost vs chunk | crowd-out by an earlier widened block | median chars per long call |
|---|---|---|---|---|---|
| chunk (bar comparator) | 3/82 (3.7%) | 195/195 | — | — | 9,758 |
| today (`auto`, unpatched) | 3/82 | 195/195 | 0 | — | 11,804 |
| scoped window | 3/82 | 195/195 | 0 | 2 | 15,980 |
| scoped section | 50/82 (61.0%) | 195/195 | 0 | 2 | 28,846 |
| scoped page | 50/82 (61.0%) | 195/195 | 0 | 2 | 28,846 |
| scoped section or page + 50% share cap | 22/82 (26.8%) | 195/195 | 0 | 2 | 23,267 |
| scoped window + cap | 3/82 | 195/195 | 0 | 2 | 15,980 |

## Rule outcome: no variant is picked

Every variant fails at least one bar:

- Window doesn't beat chunk.
- Section and page beat chunk and lose no short pair, but reach only 61.0%, short of the 90.6% bar.
- The capped variants reach 26.8%.

Dev agrees. At B = 6,000, chunk covers 0 of 35 long pairs, section and page cover 16 of 35, and the capped versions cover 7 of 35. No dev short pair is lost.

## How the shared budget behaves under the scoped policy

- **Short pages are protected.** The scoped policy never drops a short deciding page, on M or on dev. Short hits stay chunks paid for first, so a widened block can't take their budget. That fixes the one short loss the global unit had.
- **A widened block can still crowd out a later long deciding page, but it is rare.** It happened in 2 of the 82 long pairs on M and 1 of 35 on dev. Those are every long pair that had an earlier-ranked long page in the same hit list, so it happened whenever it could. Rank ordering is already what `allocate()` does: every block's floor is reserved, then blocks enrich in rank order. So "order by rank" is the current behavior and adds nothing.
- **Most misses come from the reserved chunks, not from crowd-out.** 30 of the 32 uncovered long pairs on M had no earlier long page. The reserved short chunks spend part of the 6,000 tokens first. The deciding page then grows outward from its hit chunk with what is left and stops before reaching the sentence. Given the full budget alone, the same pages are covered 82 of 82 times.
- **The declared guard doesn't help.** A 50% share cap on each widened block leaves the 2 crowd-outs in place and cuts coverage to 26.8%, because it also limits the deciding block itself.

## Informational: B = 24,000 (the implied-auto default)

This budget doesn't decide under the rule, but the result changes the picture. Scoped section and page reach 82 of 82 on M and 35 of 35 on dev. They lose no short pair and have no crowd-out. The cost is a median of 44,001 characters per long call on M, against 9,758 for chunk (about 4.5 times). Window stays at 3 of 82.

The plan counts F2 "in the existing delivery budget", and under implied `auto` that budget is 24,000 tokens, not 6,000. A rule that decides on 24,000 needs its own preregistration, with a byte or payload bar stated first.
