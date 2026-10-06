# Preregistration: attendance on notes written the documented way (world-v1-attendees, 2026-10-06)

Frozen on October 6, 2026, in its own commit, before any run on the new corpus and before the world-v1 comparison runs at the pin. Nothing below changes after a run; a later change is a dated amendment at the end. Workstream W3 of the [2026-10 follow-up round](../plans/2026-10-06-followups-round/PLAN.md) (inventory row D2; CEO finding C6).

## Question

Since gbrain v0.60.30.0, a person counts as a meeting's attendee only with explicit evidence: `attendees` frontmatter, an `Attendees:` line, or a `## Attendees` section of bare links (`docs/guides/attendance-evidence.md` at the pin). world-v1 meetings name attendees only in prose, so N9's 150 "Who attended ...?" runs per split resolved their meeting and fired 0 times (2026-10-02). When the same meetings carry an attendee list in the documented form, does gbrain parse it and use it end to end, and does it use the page rather than agree with an answer key by chance?

The claim this can support is narrow: **the documented attendee format is parsed and used end to end.** Prose-only attendance stays unsupported (N12-9), and nothing here says anything about it.

## Evidence class

Development evidence on a synthetic corpus. The lists are generated from the Cat 2 answer key; the questions are N9's existing templates and the constrained-relational development phrasing. Nothing is held out, and no sealed phrasing is used.

## Build and data

- gbrain `c5fb0201d1960a0a5a81c35d77718311b03154b7` (v0.60.95.0), the round's pin, installed dependency, Bun 1.4.2.
- Corpus `world-v1-attendees` (generator `eval/generators/world-v1-attendees.ts`, version `world-v1-attendees/1`, seed 20261006, corpus fingerprint `25f53dc5eb464a7abbf5ca03427d6dd089e88e465ff66413ada4499cd39c3f4d`; `bun eval/generators/world-v1-attendees.ts --check` verifies the committed files). Every world-v1 page is copied byte for byte except the 50 meetings, which gain one `## Attendees` section of bare links `- [Name](people/slug)` after their unchanged prose. 42 lists equal the Cat 2 key (`_facts.attendees` in world-v1); 8 (16%, the plan's 15% rounded to whole meetings) differ by one person: 3 add a person the key does not list, 5 remove one (`_attendees-ledger.json` names each). In this corpus the gold is the list on the page. world-v1 itself is not edited.
- Comparison corpus: world-v1 unchanged.

## Arms

1. **N9 hermetic, both corpora.** `bun eval/runner/n9-multi-hop-paraphrase.ts --corpus <dir>`: keyword search, provider keys stripped, ingestion seeds 1, 2 and 3, relational retrieval off and on over the same index. The attendance rows are the one-hop "Who attended <meeting>?" questions (50 meetings x 3 seeds = 150 runs per split) in the template split and the paraphrase split, whose wordings are regenerated from each corpus by the frozen generators.
2. **N9 paid, both corpora.** The same with `--paid` (hybrid search with OpenAI embeddings, composed splits only). Reported: the composed attendance families (`meeting_investors`, `investor_founder_meetings`) in the paraphrase split, off and on.
3. **Attendee-role probe, both corpora.** `bun eval/runner/attendee-role-planner.ts --corpus <dir>`: the development phrasing of `eval/generators/constrained-relational-gen.ts` (`PHRASING_A.q_attended_role`: "Which {roles} attended {meeting}?" and "{Roles} who attended {meeting}?") rendered for every meeting and every role present among its listed attendees, gold the attendees on the list who hold that role. Instrumentation per question: the multi-relation planner's verdict (`parseRelationalPlan`: plan, not applicable, or unsupported with its reason and matched phrases), the one-relation parser, whether the relational arm fired on a keyword index (seed 1), what it returned, and role-gold recall@10 off and on.

## Metric and denominator

Scored by `eval/runner/attendance-world-score.ts` from the receipts and the corpus, never from gbrain's labels:

- **Fire rate** per split: runs where the relational arm fired, over all attendance runs in the split (150), errors included in the denominator.
- **False attendance**: (run, person) pairs where the relational arm returned a person page the meeting's list does not name. On world-v1, the list is the Cat 2 key.
- **Perturbed meetings**, per split: for each removed person, runs that returned them (should be 0); for each added person, runs that returned them (should match the fired runs).
- recall@5 of the listed attendees, off and on, and the stage funnel (parsed, meeting resolved, fired) as reported by N9.
- Attendee-role probe: share planned, share parsed as one relation, share fired, recall@10 off and on, false attendance, questions where attendees of another role came back.

## Decision rule

The narrow claim holds when, on world-v1-attendees in the N9 hermetic arm, **both** attendance splits fire on at least 80% of their runs **and** false attendance is 0 across both splits. A split below 80% is reported with its funnel stage (not parsed, meeting not resolved, resolved but not fired). Everything else is report-only: the world-v1 numbers beside them (expected near 0 fired), the paid composed families, the perturbed-meeting breakdown and the attendee-role probe. No statistics: deterministic counts over fixed seeds. The attendee-role probe makes no claim about answer quality; it measures how gbrain's planner and parser read those questions.

## What each outcome changes

| If it wins | If it loses | If inconclusive or at the ceiling |
|---|---|---|
| Attendance documented as working end to end for the documented format, with the planner coverage numbers | A gbrain issue with the failing pages; N9 unchanged | Report the firing rate; no claim |

"Inconclusive" here means a split fires on 80% or more but false attendance is above 0, or one split passes and the other fails: the firing rate is published with the failing cases and no claim is made.

## Budget

Ledger `/workspace/gbrain-evals/.budget/followups-2026-10.sqlite`; one ledger run for W3 opened with `budget-ledger.ts open --runner w3-attendance-world --budget-usd 3` (estimate $1: N9's paid arm is $0.07 per run at its recorded estimate, two corpora); the paid N9 runs pass `--paid --budget-run-id <id> --budget-ledger <path>`, and every embedding request is reserved and settled through it. The hermetic arms and the probe cost $0.

## Who writes these lists

The report says who writes attendee lists in this form today (the user, or an import adapter such as gbrain's calendar import), and that a brain whose meeting notes name attendees only in prose gets no attendance edges.

## Amendments

None yet.
