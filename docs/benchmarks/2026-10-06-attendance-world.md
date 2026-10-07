# Attendance lists written the documented way are parsed exactly, and "Who attended X?" now works; paraphrased wording still does not

Date: 2026-10-06. Workstream W3 of the [2026-10 follow-up round](../plans/2026-10-06-followups-round/PLAN.md). Evidence class: development evidence on a synthetic corpus. Build: gbrain `c5fb0201` (v0.60.95.0), the round's pin. Spend: $0.13 (paid N9 arm). Status: **Complete**. Preregistered outcome: **inconclusive** (one split passes, one fails), so the report states firing rates and makes no general claim.

## The finding

[gbrain](https://github.com/garrytan/gbrain) records that a person attended a meeting only when the meeting note says so in a form it documents: `attendees` frontmatter, an `Attendees:` line, or a `## Attendees` section of bare links ([attendance evidence guide](https://github.com/garrytan/gbrain/blob/c5fb0201d1960a0a5a81c35d77718311b03154b7/docs/guides/attendance-evidence.md)). Our relationship corpus, world-v1, names attendees only in prose, so on 2026-10-02 every "Who attended ...?" question found its meeting and then retrieved no attendees through the graph.

This run adds the documented list to the same 50 meetings and changes nothing else. On that corpus, gbrain at `c5fb0201`:

- **stored exactly the listed attendees.** After extraction, the index held 132 `attended` edges, one for each of the 132 list entries and no others, on each of three ingestion orders. That includes the 8 meetings whose list deliberately disagrees with the answer key. A person removed from a list but still named in the prose got no edge.
- **answered "Who attended <meeting>?" from the graph on all 150 runs** (50 meetings x 3 ingestion orders). Recall of the listed attendees in the top 5 rose from 32.3% with relational retrieval off to 80.3% with it on. On unchanged world-v1, the same questions fired 0 times and stayed at 45.6% either way.
- **did not recognize paraphrased wording.** "Who was in the room for ...", "Who took part in ..." and "Which people were present at ..." were never read as attendance questions: 0 of 150 runs parsed, so none fired. That is a wording gap in gbrain's relation parser, not a format problem: the same meetings answer the template wording perfectly.

The preregistered rule needed both wordings to fire on at least 80% of runs, with 0 false attendance. False attendance was 0, the template wording fired on 100% and the paraphrase wording on 0%. The outcome is inconclusive by the rule, so the supportable statement is narrow: **when meeting notes carry a `## Attendees` link list, gbrain stores exactly those attendees and answers the template question "Who attended X?" from them.** Prose-only attendance remains unsupported (N12-9).

## The concrete case

The world-v1 Acme Q1 2025 board meeting says, in prose, that Chris Jackson dialed in and Ian Anderson attended in person, and that Mia Brown led the session. The Cat 2 answer key lists Mia Brown and Chris Jackson (Ian Anderson has no page in the corpus). In world-v1-attendees, this is one of the 5 meetings with a person removed: its list reads

```markdown
## Attendees

- [Chris Jackson](people/chris-jackson-91)
```

Mia Brown is still named in the prose, as the person who led the session. gbrain stored Chris Jackson's attendance and not Mia Brown's, on all three ingestion orders, and "Who attended Acme Board Meeting Q1 2025?" never put Mia Brown in its top 5. The list on the page decides, as documented, rather than prose that reads like attendance. In the 3 meetings where the list adds someone the key does not have, the added person got an edge every time.

## The experiment and results

**Corpus.** `world-v1-attendees` ([generator](../../eval/generators/world-v1-attendees.ts), version `world-v1-attendees/1`, seed 20261006, fingerprint `25f53dc5...`, verified by `bun eval/generators/world-v1-attendees.ts --check`). Every world-v1 page is copied byte for byte. Each of the 50 meetings keeps its prose and gains a `## Attendees` section of bare links, generated from the Cat 2 answer key without a model. 42 lists equal the key. 8 differ by one person: 5 removals and 3 additions, listed in `eval/data/world-v1-attendees/_attendees-ledger.json`. In this corpus the gold is the list on the page. world-v1 is not edited.

**Arms** (all at gbrain `c5fb0201`):

| Arm | world-v1-attendees | world-v1 (unchanged) | Status |
|---|---|---|---|
| Stored `attended` edges after extraction, per ingestion order | 132 of 132 listed, 0 extra, on all 3 orders | 0 (134 listed people with a page, none stored) | Complete |
| "Who attended X?", template wording, fired (150 runs) | **150 (100%)** | 0 | Complete |
| Same, recall@5 of listed attendees, relational off / on | 32.3% / **80.3%** | 45.6% / 45.6% | Complete |
| "Who attended X?", paraphrase wording, fired (150 runs) | **0 (0%)**, 0 parsed | 0, 0 parsed | Complete |
| Same, recall@5 off / on | 26.0% / 26.0% | 34.5% / 34.5% | Complete |
| False attendance (stored edges against the page lists) | **0** | 0 | Complete |
| People not on the list in the top 5, template wording, off / on | 4 / 3 | 8 / 8 | Complete |

Recall with relational retrieval off fell from 45.6% to 32.3% when the list was added. Keyword search ranks the meeting page itself higher once its body names every attendee, which pushes person pages down. With the graph on, the attendees come back regardless.

**Perturbed meetings.** All 8 fired on all 3 template runs. None of the 5 removed people appeared in a top 5, with relational retrieval off or on. Of the 3 added people, one (Nimbus Q2 2025, 2 attendees) was in the top 5 on all 3 runs with the arm on. The other two stayed outside the top 5 (a demo day with 6 listed attendees and a one-on-one with 3); their stored edges are the evidence that gbrain read them.

**Composed questions (paid arm, report-only).** N9's two composed families that pass through attendance, run with hybrid search and OpenAI embeddings ($0.07 per corpus):

| Family, wording | world-v1-attendees: fired, all-supporting-pages hit (off / on) | world-v1: fired, hit (off / on) |
|---|---|---|
| Investor's founders' meetings, template (27 runs) | 27 fired; 0% / **77.8%** | 0 fired; 0% / 0% |
| Investor's founders' meetings, paraphrase (27) | 3 fired; 0% / 0% | 0 fired; 0% / 0% |
| Meetings attended by a company's investors, template (81) | 0 fired (meeting seed not resolved); 0% / 0% | 0 fired; 0% / 0% |
| Same, paraphrase (81) | 0 fired; 0% / 0% | 0 fired; 1.2% / 1.2% |

The three-hop "Which meetings did the founders that <investor> backed attend?" chain goes from impossible to 21 of 27 once attendance is stored. The paraphrased composed questions and the investor-to-meeting family still fail before the attendance hop.

**Attendee-role questions (planner coverage, report-only).** The development phrasing of `eval/generators/constrained-relational-gen.ts` ("Which founders attended X?", "Founders who attended X?"), for every meeting and every role among its listed attendees, never the custodian's sealed phrasing. 198 questions on world-v1-attendees:

| Measure | world-v1-attendees | world-v1 |
|---|---|---|
| Planned by the multi-relation planner | **0 of 198** | 0 of 204 |
| Planner's verdict | not applicable 148; refused: "the relations do not chain" 39 (e.g. "founders" read as a relation); refused: "time constraints are not planned" 11 (meeting titles contain a year) | same pattern |
| Parsed as one relation ("who attended X", role ignored) | 187 (94%) | 194 (95%) |
| Relational arm fired | 137 (69%): "Which <role>s attended" 88 of 99, "<Role>s who attended" 49 of 99 | 0 |
| Role-gold recall@10, off / on | 41.9% / 65.2% | 49.2% / 49.2% |
| Questions with an attendee of another role in the top 10, off / on | 37% / 64% | 44% / 44% |

gbrain answers a role-constrained attendance question as plain "Who attended X?": it returns every attendee, which raises recall of the right people and also brings in the other roles. Applying the role is left to the reader. The planner never takes these questions; it is built for chains of two or three relations.

**A defect in our measurement, fixed before scoring (amendment).** The preregistration first counted false attendance from the `relational` annotation on each search result. At this pin that annotation never reaches the returned rows on the keyword path, so the first receipts recorded 0 trivially. Before looking at any edge, the [amendment](2026-10-06-attendance-world-preregistration.md#amendments) moved the rule to the stored `attended` edges, the graph the relational arm walks. Both N9 hermetic runs and the probe were rerun. Fire rates and recall did not change between the runs, and the first receipts are kept in `run1-before-amendment/`.

## Who writes these lists

Attendance needs a list in a documented form, and someone has to write it. Today that is:

- **The user or their agent.** gbrain's meeting-ingestion guide has the agent write the meeting page with an `Attendees:` line and leave attendance edges to auto-link.
- **gbrain's calendar import.** Calendar event pages carry `attendees:` frontmatter, the invitees' email addresses, which resolve to person pages by address or alias. Its `## Attendees` section lists names with emails and response status, not bare links, so the frontmatter is the evidence.

A brain whose meeting notes name attendees only in prose, like world-v1, gets no attendance edges. That is documented behavior, not a regression.

## What to use and what to avoid

If your agent writes meeting notes, have it write a `## Attendees` section of bare links to person pages, or `attendees` frontmatter. gbrain then stores exactly those attendees, ignores people mentioned only in prose, and answers "Who attended X?" from the graph. Do not count on paraphrased wordings ("who was in the room for", "who took part in") reaching the graph yet. Do not expect gbrain to filter attendees by role; it returns everyone who attended.

Follow-ups worth a gbrain issue (not filed from this lane): the relation parser's attendance lexicon misses common paraphrases; the multi-relation planner refuses chains whose anchor title contains a year ("time constraints are not planned"); and role-constrained attendance questions are answered unconstrained.

## Reproduce and inspect

Keyless, $0, about a second: re-score the committed receipts against the lists on the pages.

```bash
bun eval/runner/attendance-world-score.ts --receipt docs/benchmarks/2026-10-06-attendance-world/n9-hermetic-world-v1-attendees.json --corpus eval/data/world-v1-attendees
# one-hop-template: fired 150/150 (100.0%) ... recall@5 off 0.323 on 0.803
# one-hop-paraphrase: fired 0/150 (0.0%) ...
# seed 1: 132 attended edges, 0 false, 0 listed attendees without an edge   (same for seeds 2 and 3)
bun eval/runner/attendance-world-score.ts --receipt docs/benchmarks/2026-10-06-attendance-world/n9-hermetic-world-v1.json --corpus eval/data/world-v1
bun eval/generators/world-v1-attendees.ts --check
```

Live, Bun 1.4.2. The hermetic runs take about 2.5 minutes each and the probe under a minute, with no key. The paid arm needs `OPENAI_API_KEY`, costs about $0.07 per corpus and takes about 9 minutes.

```bash
bun eval/runner/n9-multi-hop-paraphrase.ts --corpus eval/data/world-v1-attendees --output /tmp/n9-att
bun eval/runner/n9-multi-hop-paraphrase.ts --corpus eval/data/world-v1 --output /tmp/n9-w1
bun eval/runner/attendee-role-planner.ts --corpus eval/data/world-v1-attendees --output /tmp/role-att
bun eval/runner/n9-multi-hop-paraphrase.ts --corpus eval/data/world-v1-attendees --output /tmp/n9-att-paid \
  --paid --budget-run-id <id> --budget-ledger <ledger.sqlite>
bun test test/eval/attendance-world.test.ts
```

Receipts are in [`2026-10-06-attendance-world/`](2026-10-06-attendance-world/). `attendance-summary.json` holds every scored number and the preregistration attestation. `n9-hermetic-*.json` contain per-run rows and the stored edges per seed, `n9-paid-*.json` the composed families, and `attendee-role-*.json` every question with the planner's and parser's verdicts. `run1-before-amendment/` keeps the first runs. Spend is in the round ledger under run `w3-attendance-world-2026-10-06T19-34-39-555Z-56c68ad4`: $0.13, 2,408 requests.
