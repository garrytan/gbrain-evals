# F2 scoped-policy frozen step: decision rule (written and hashed before any number was computed)

Recorded 2026-10-12. It follows the global-unit step (../DECISION-RULE.md, outcome: none picked) and PLAN.md at
8f5e4fad: F2 widens only long non-conversation hits under implied `auto`, through the existing delivery seam, and
counts in the existing delivery budget.

Frozen hits: the same as the global-unit step (../frozen.json). World M H4 gbrain calls are primary
(277 pairs of a call and a deciding page: 82 long, 195 short); dev (r3, dev-r5) is the check. S is not opened.

Policy emulated (in a scratch copy of gbrain at the M build 3e4ff61c; the repository is not changed):
- The `auto` path is unchanged for conversation pages: today's auto rules, which widen them to `page`.
- A hit page is "long non-conversation" when its rendered body is at least 20,000 characters and gbrain's own
  `conversationSignal` returns null for it. Such pages join the widened groups with unit U, where U is one of
  window, section or page. All other hits stay ranked chunks, reserved first, exactly as `auto` reserves them today.
- The call goes through `assembleEvidenceForHits` with `return_unit: auto` and no explicit budget, so the cap path
  stays off as on an ordinary search. The budget comes from `search.return_budget_conversation`, set to B.
- B = 6,000 tokens is primary (the same fixed budget as the global-unit step). B = 24,000, the implied-auto
  default, is reported for information only and does not decide.

Comparators, all replayed in the same run on the same pairs:
- chunk: return_unit chunk, the bar comparator;
- today: unpatched `auto` at B, reported.

Crowd-out (reported): a long deciding pair that scoped(U) does not cover, although the isolated replay of the
global-unit step covers it, in a call where an earlier-ranked page was F2-widened.

Guard, declared now and replayed for every U whether or not crowd-out appears: share cap. Each F2-widened block
grows to at most 50% of B, floor included; conversation blocks are unchanged. Rank ordering is not a separate arm:
at the M build, `allocate()` already reserves every block's floor and then enriches blocks in rank order. That is
stated as current behavior.

Bars (M, B = 6,000), evaluated per variant (U, and U + cap):
1. Long-pair coverage is strictly greater than chunk's.
2. No short pair is lost: every short pair chunk covers, the variant covers too (pair by pair).
3. Long-pair coverage is above 48/53 (90.6%), the recorded selector bar.

Pick:
- Unguarded variants that pass all three bars are preferred. If none passes, guarded variants are considered.
- Within the preferred set, pick the highest long coverage. If two are within 2 percentage points, pick the one
  with the lower median characters per call.
- If nothing passes, nothing is picked.

Dev check (can veto when dev has at least 5 long pairs): the picked variant's dev long coverage is not below
chunk's, and no dev short pair is lost.
