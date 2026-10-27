# Which budget the recorded searches got, and F2 judged at that budget

No model calls and no spend; S was not opened. The rule in `DECISION-RULE.md` was hashed (`DECISION-RULE.sha256`) before any F2 number was computed.

## The budget was set per call, and the F2 path's budget is 24,000

The M runs passed no `--gbrain-config` (receipt argv), so every `search.*` key was at its 3e4ff61c default. Note that `return_budget_default` is 6,000 and `return_budget_conversation` is 24,000; the conversation key is the 24,000 one, not 6,000. `paths.py` assigned each of the 3,180 recorded M agent search/query calls a path from its arguments and the types of its hits:

| path | M calls | dev calls | evidence budget |
|---|---|---|---|
| implied auto, no conversation hit | 2,107 | 1,059 | none: chunk path, rows unchanged |
| implied auto, conversation hit present | 551 | 289 | 24,000 (auto path) |
| `search` with `token_budget` | 497 | 197 | the caller's budget (auto cap path) |
| explicit `return_unit` | 25 | 0 | 6,000 |

`verify_widening.py` confirms the auto path empirically. Every conversation page of at least 3,000 characters in an implied-auto call came back whole (559 of 559). Long non-conversation pages came back as single chunks.

F2's activation path is implied auto with a long hit and no explicit budget, and that path runs at 24,000. The plan's "in the existing delivery budget" therefore means 24,000.

## F2 replayed on every recorded call, each on its own path

| variant | M long covered | M short lost | M payload rise, H2–H4 | dev long | dev payload rise, H2–H4 |
|---|---|---|---|---|---|
| chunk | 3/82 (3.7%) | — | — | 0/35 | — |
| today | 3/82 | 0 | — | 0/35 | — |
| F2 window | 3/82 | 0 | +1.1% | 0/35 | +0.8% |
| F2 section | 78/82 (95.1%) | 0 | +8.2% | 34/35 (97.1%) | +8.3% |
| F2 page | 78/82 (95.1%) | 0 | +8.2% | 34/35 (97.1%) | +8.3% |

Payload rise is the delivered characters F2 adds, divided by the recorded serialized result characters. Across all families on M the rise is +7.5%. Measured against replayed text alone (about 46% of the serialized size), the rise is +15.8%, which still passes the strict 16.4% sensitivity bound. 31 of 180 M H2–H4 cells individually rise by more than 25%. The bar is pooled because cost is capped per arm.

All 4 long pairs M still misses are paths where F2 can't help. 2 are cap-path calls with a small caller budget (9 of 11 cap-path pairs are covered). The other 2 are explicit-unit calls, where F2 is inert by precedence. On the plain implied-auto path, F2 covers 69 of 69.

## X derivation (in the rule, from `derive.out`)

1. **Headroom.** The F2-only arm on H2–H4 is priced at $107.89, and its per-arm cap is 1.15 × that, so it has 15% headroom.
2. **Search results' share of agent cost.** Re-reading search results accounts for 57.9% of agent cost in the arm's M cells. That figure combines three measurements from the records: 3.195 characters per cl100k token, an observed cost per input-side token for each model, and a count of how many later requests re-read each result.
3. **The bound.** Keeping projected cost inside the cap requires 15% / 57.9% = 25.9%. Rounded down, X = 25%.

## Rule outcome: pick section, with page tied

Section and page pass all four bars on M, and the dev check doesn't contradict. They are byte-identical on these worlds, because the long documents have no inner headings, so the rule's tie-break can't separate them; section is listed first. Window fails because it doesn't beat chunk.

## Limits

- Hits that couldn't be mapped back to chunks: 582 on M (0.9%) and 652 on dev.
- Calls with no replayable rows: 278 on M (11 of them had hits, none mappable) and 127 on dev (9). These count in the payload base with no added characters.
- The cost model spreads each session's calls evenly over its requests. That overstates Sol's re-reads, which makes X stricter.
