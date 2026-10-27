# Cat 40 next wave: d4b zero-provider transfer and negative-control gate

**Verdict: PASS** (R1-R4 all hold; no failures). The gate ran on 2026-10-13 and gates paid development round 1
(plan `docs/plans/2026-10-11-cat40-next-wave/PLAN.md`, the d4b decision).

- Pass rule: [`DECISION-RULE.md`](DECISION-RULE.md), sha256 `11115df9d5a941f626a4c31354e8cd274845ec81ef2a9bff4597aeec5bd19e39`, written
  2026-10-13T01:16:29Z before the pages were authored.
- Pages: 25 per condition, hand-authored by the evaluator (who implemented none of F1-F5) with placeholder names only;
  [`MANIFEST.json`](MANIFEST.json) freezes every file's sha256 before any run. `author.py` writes the pages and `cases.json`.
- Builds: W = gbrain `a798de1f` with the all-on recipe and `mentions.owner_phrases=true`; B = merge base `09d21554d`, no wave keys.
  Keyless PGLite brains, no provider keys in any gbrain process, remote MCP over `serve --surface starter` (`run.ts`).
- Conditions: O = pages as authored (no `status`, no `effective_date`); E = the same pages with `status` and `effective_date` on
  contracts, amendments and the draft. `evaluate.py` applies the rule to `results/outputs.json`; `results/report.json` is its output.
- The F5 part of the gate is the frozen F5 ownership transfer set (frozen-rule P 0.900 / R 0.900; final code, post hoc, P 1.000).

## Which surfaces served the deciding page

A digit n means surface Sn's output contained the deciding page slug; `p` after it means the deciding passage was there
too. W rows list S1-S9 (S6 is W's F2-off search); B rows list S1-S5 and S7-S9. S1 entity names, S2 entity card, S3
context_pack structured, S4 context_pack text, S5 search, S7 search `snippet_chars: 300`, S8 `token_budget: 2000`, S9
`token_budget: 24000`.

| case | W-O | W-E | B-O | B-E |
|---|---|---|---|---|
| C1a-partial-override-amended-term | `123456789` | `123456789` | `.2345789` | `.2345789` |
| C1b-partial-override-unchanged-term | `123456789` | `123456789` | `.2345789` | `.2345789` |
| C2-future-validity | `123456789` | `123456789` | `.2345789` | `.2345789` |
| C3-no-lexical-overlap | `12345p6p78p9p` | `12345p6p78p9p` | `.2345p78p9p` | `.2345p78p9p` |
| C4-summary-only-evidence | `.23456789` | `.23456789` | `.2345789` | `.2345789` |
| C5-long-page-repeated-terms | `12345p67p89` | `12345p67p89` | `.2345789` | `.2345789` |
| C6a-missing-date | `.23456789` | `.23456789` | `.2345789` | `.2345789` |
| C6b-conflicting-dates | `.23456789` | `.23456789` | `.2345789` | `.2345789` |
| C7-draft-without-status | `123456789` | `123456789` | `.2345789` | `.2345789` |

Reading it: the wave adds S1 (names rows now list records) for every contract and amendment case and keeps everything
B served. On the long page (C5) the deciding passage reaches S5 only with F2's section delivery: W's F2-off control (S6),
the 2,000-token budget (S8) and the 24,000-token budget (S9) do not carry it, and B never does. `snippet_chars: 300` (S7)
does not cut a widened row.

## Draft-first (reported; expected sign stated in the rule)

The draft amendment led the executed record in S1-S3 on W in both conditions ({"S1": "draft-first", "S2": "draft-first", "S3": "draft-first"} in O); B lists no
records on names rows (S1 `neither`) and led with the draft on S2-S3 as well. In E, W's draft rows carry `page_status: draft`
(60 `page_status` fields in W-E, all matching frontmatter; none in O, none on B). The expected positive sign holds.
