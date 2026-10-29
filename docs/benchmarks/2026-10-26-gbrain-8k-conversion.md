# A dated facts block lifts held-out answers 16 points at an 8k reader budget: gbrain's 8k conversion wave (2026-10-26)

## The finding

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents. The 8k conversion wave
([gbrain#7610](https://github.com/garrytan/gbrain/pull/7610)) added four default-off flags for an agent that reads
memory through a tight budget. This test covers three of them, F1 to F3. F4 (`search.fact_source_pages`) had no
held-out arm, because on development data it changed one tool result in 100 and no verdict (spec change 7).

**On the 200 held-out questions of sealed confirmation v2, the facts block (F3, `search.query_facts_block`) on today's
defaults answered 183 against 151 for the control.** That is +16.0 points, with a persona-clustered 95% interval of
+11.0 to +21.5. The facts block won 33 questions and lost 1 (exact McNemar p = 4.1e-9, Holm-adjusted 1.6e-8). **By
the preregistered rule the verdict is `pass`,** with superiority shown. The recommendation is to **flip
`search.query_facts_block` on**. That flip is the owner's call; this document only measures it.

The gain is all in the kinds that need several chats:

| Kind | Control | Facts block |
|---|---|---|
| Multi-session | 45 of 80 | 69 of 80 |
| Temporal | 26 of 40 | 34 of 40 |

Knowledge-update and abstention questions are at the ceiling (40 of 40) in every arm, so this test can't show an
effect there in either direction. Guards 7 and 8 found no clear loss in any kind.

The facts block added on top of F1 and F2 (D3, A3 against A2) also passes: +13.5 points, 28 wins and 1 loss. A3 and
B3 both answer 183 under Sonnet 5.5, so F1 and F2 add nothing measurable once the facts block is on.

**F1 (`search.query_budget_unit = auto`) and F2 (`search.evidence_titles`) are `inconclusive`, and neither is
recommended.**
- F1 (D1): +1.5 points, interval −2.0 to +5.0, 7 wins and 4 losses. F1 does pass its non-inferiority check against R5
  (A1 − R5 = +21.5 points, interval +14.0 to +28.5).
- F2 (D2): +1.0 point, interval −1.0 to +3.0, 3 wins and 1 loss.

Both flags stay default-off.

Tested configuration:
- gbrain `cf3ec433f4fffda60d00076bae7361100c632cc4` (v0.60.461.0), the head of #7610, not a merge commit.
- One live `query` per question and arm through gbrain's MCP dispatch, with the stdio server's options.
- `token_budget` 5,500 for an 8,000-token reader, `limit: 25`.
- Each brain was extracted with gbrain's own conversation-facts extraction, then repaired with
  `gbrain repair safe-chunks`.
- Primary reader `claude-sonnet-5-5`; judge `gpt-4o-2024-08-06` with LongMemEval's per-kind prompts.

The rule was committed before custody in the [preregistration](2026-10-26-gbrain-8k-conversion-preregistration.md),
and the decision file the run read hashes to `a893822f…`.

## All arms, all readers

Correct answers out of 200. Replay readers are descriptive and decide nothing.

| Arm | Flags | Sonnet 5.5 (decides) | Opus 5.5 | gpt-6.1-sol |
|---|---|---|---|---|
| A0, control | none | 151 | 152 | 151 |
| A1 | F1 | 154 | 156 | 155 |
| A2 | F1, F2 | 156 | 157 | 156 |
| A3 | F1, F2, F3 | 183 | 184 | 184 |
| B3 | F3 alone | **183** | 182 | 181 |
| R5, reference | first five hits whole, cut at the reader budget | 111 | 110 | 111 |

All three readers agree. R5, the H1-style reference, does much worse here: its packed recall reaches every gold chat
on 36 of 160 answerable questions, against about 157 for the budgeted arms. That's because five whole conversations
overflow an 8,000-token reader.

What the facts block delivers:
- Question-ranked dated facts appear in 195 of 200 results, against 121 for the control's default facts arm.
- The mean is 7.5 fact rows, and no block ever exceeded its 22% share.
- Result rows rise from about 10 to about 16.

## Gates and custody

- **Retrieval gate passed.**
  - The 20 seeded A0 repeats were byte-identical (spec change 6's response cache for embedding and rerank calls).
  - No result reported `safe_index_pending`.
  - Every F1 arm stayed within 5,500 tokens with `cap_only`.
  - Every F3 arm stayed within its facts share.
- **Final gate passed:** 0 re-render mismatches and 0 reader errors.
- **Labels:** every label read came after the final gate, 19 of them against 18 expected (see the deviation below).
  The access log went from 35 to 55 lines.
- **Commitments:** questions and labels matched their commitments at custody check (`8d29e92d…`, `83bf52d1…`).
- **Receipts:** aggregate receipts are in
  [2026-10-26-gbrain-8k-conversion/receipts/held-out/](2026-10-26-gbrain-8k-conversion/receipts/held-out/).

**Deviation (harness, not spec).** The score cell first stopped at the scorer's own $2 cap. That cap was cumulative
across all 18 scorings in one spend ledger, while the score lease was $12. It was raised to the $12 lease, as H1 had
done, and the cell resumed (changelog, 2026-10-26). The arm it interrupted was scored again, which produced the
19th label read. No score was changed or picked.

## Cost

| Item | Spent |
|---|---|
| Import | $0.70 |
| Extraction | $4.33 |
| Freeze | $0.06 |
| Sonnet readers | $29.32 |
| Opus and gpt-6.1-sol readers | $82.79 |
| Judge | $3.33 |
| **Held-out total** | **$120.53** |
| Development reading | $36.65 |
| **Program total** | **$157.18 of the approved $300** |

## What this means

On the 8,000-token reader case, the reader was missing facts, not passages. The facts block gives it question-ranked
dated facts ahead of the pages. With them it answers 69 of 80 multi-session questions instead of 45, and it loses
almost nothing. Changing the budget unit (F1) and titling page headers (F2) barely moved the result.

Sealed confirmation v2 has now used all three of its openings, and nothing more is tuned on it.
