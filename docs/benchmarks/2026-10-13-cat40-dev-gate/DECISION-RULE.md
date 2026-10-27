# d4b zero-provider transfer and negative-control gate: pass rule

Written and hashed before the page set is authored and before anything runs
(plan `docs/plans/2026-10-11-cat40-next-wave/PLAN.md`, the d4b decision and the
CEO-rerun pass-rule line). Author: the evaluator, who implemented none of F1-F5.
The F5 part of this gate is the frozen F5 ownership transfer set scored earlier
(frozen-rule P 0.900 / R 0.900); it is not rerun here.

## What runs

- **Builds.** W = gbrain `a798de1f966dcce401546170b9c1882b1fb56904` (Part 1 F1-F4 + F5 + master wave 16) with the
  preregistered all-on recipe: `entity.names_references=true`, `entity.record_types=contract,amendment`,
  `entity.row_page_status=true`, `search.long_page_unit=section`, `search.long_page_min_chars=20000`,
  `mcp.instructions_governing_rule=in_effect`, slot built with `mentions.owner_phrases=true`.
  B = the merge base `09d21554d`, no wave keys.
- **Zero providers.** Keyless PGLite brains: no embedding step, no provider keys in any gbrain process, so search is
  keyword-only and nothing is reranked or expanded. Every call is a remote MCP call over `gbrain serve --surface
  starter`, the way the Cat 40 gbrain arm connects.
- **Conditions.** O (original): the pages as authored; contracts, amendments and the draft carry no `status` and no
  `effective_date`. E (metadata-enriched): the same pages with `status` (executed / draft) and `effective_date`
  frontmatter added on contracts, amendments and the draft. O and E are separate brains and are reported separately.
- **Surfaces, per case, first call only (no `next`, no pagination):**
  - S1 `entity` names mode: `names` = the case's accounts.
  - S2 `entity` card: `name` = the case's primary account.
  - S3 `context_pack` structured output (`entities` = the case's accounts), everything except `text`.
  - S4 `context_pack` packed text (`text`).
  - S5 `search` lean rows, default arguments, `query` = the case query.
  - S6 `search` on W with `search.long_page_unit=off` (the F2-off, today's chunk output, frozen-hit control).
  - S7 `search` with `snippet_chars: 300`.
  - S8 `search` with `token_budget: 2000`, and S9 with `token_budget: 24000`.

## Cases

Each case names a deciding page (and, for `passage` cases, a deciding passage: a verbatim sentence fragment of that
page). The case list, queries and deciding items are fixed in `cases.json`, written with the pages and hashed in
`MANIFEST.json` before any run.

## Pass rule

The gate passes only when all four hold.

- **R1, deciding evidence surfaces within caps (W, in O and in E).** For every case, the deciding page slug appears in
  the output of at least one of S1-S5. For a `passage` case, the deciding passage also appears in S5's output.
- **R2, no hidden rows (every build, condition, surface).** No output contains the slug of a `visibility: private`
  page or that page's marker sentence.
- **R3, no wrong-status rows (every build, condition, surface).** Every object carrying `page_status` names a page
  (its `slug`) whose frontmatter `status` equals that value. In O no output carries `page_status` at all.
- **R4, no regression against the merge base (condition O).** For every case and every surface S1-S5 and S7-S9: when
  B's output contains the deciding page slug (and, for a `passage` case on a search surface, the deciding passage),
  W's output on the same surface with the same arguments contains it too.

Reported beside the verdict, not part of it: per case and surface, which build surfaced the deciding items; S6 against
S5 on W; E against O; the draft-first share (rows naming the draft before the executed record in S1-S3) with its
expected sign stated below.

## Expected sign: draft-first

In config-only worlds (O) the draft amendment carries no `page_status`, and F1's record lists are newest page date
first, so W should lead with the draft more often than B, which lists no records (a positive draft-first share is the
expected harm). In E, W's rows carry `page_status: draft`, which marks it.
