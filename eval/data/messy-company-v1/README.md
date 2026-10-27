# messy-company-v1

messy-company-v1 is the knowledge base of a fictional company, written to be messy the way real ones are. It has
226 Markdown pages (118 dev, 108 held-out) and gold labels for 9 lanes. Pemberline Systems sells one product,
Pemberline Dock (yard and dock scheduling software), to 16 customer accounts. The pages are the account wiki,
emails, chats, CRM notes, meeting notes, support tickets, weekly team updates, assistant digests, private notes and
41 contract documents. Each page was written by `gpt-6.1-sol` or `gemini-4-argon` from a brief derived from one
frozen world plan. The model that did not write a page checked it, and every disagreement was settled by reading
the page. The data is frozen: [`MANIFEST.json`](MANIFEST.json) lists the sha256 of every data file, and
`bun eval/runner/validate-data.ts` fails if any of them changes.

The dataset is meant to be reused by many eval categories. [USES.md](USES.md) maps each lane to the categories it
serves, and [SCORING.md](SCORING.md) gives each scorer's input format and metrics.

## The world

"Today" is **2026-10-14**. The pages span November 2024 to October 2026. Account-manager stints are half-open
`[start, end)` intervals.

| Cluster | Split | Accounts |
|---|---|---|
| North | dev | Quarrendon Freight Lines, Brackenwater Freight Co., Tamsin Cold Chain, Orrin Mills (renamed Thornbury Cloth Co. on 2026-01-12) |
| Central | dev | Tansley Parcel, Tansleigh Packaging, Marrow Fieldworks, Marrow Agrisupply (subsidiary of Marrow Fieldworks) |
| Coastal | held-out | Pellucid Harbor Logistics, Driftmoor Marine Freight, Saltmarsh Provisions, Covey & Lark Retail (renamed Pellow Home Living) |
| Strategic | held-out | Vantorre Group, Vantorre Mobility (subsidiary), Orlavine Medical Supply, Quillfeather Outfitters |

The split is by account cluster, so no account, owner history or contract appears on both sides. Each page belongs
to one split, and each split's labels are about that split's accounts only. Pemberline has 14 employees. Non-customers that look like customers are part of the world: Quarendon Freightways (a competitor), Orlavene
Health (a prospect, not a customer), and the vendors Stoneharrow Billing and Carrowmere Cloud.

Every company and person name is invented. Each company name was checked by web search to confirm it isn't a known
real company.

## What makes it messy

These counts come from the built labels, both splits together.

| Trap | Count | Where it lands |
|---|---|---|
| Owner phrases that name an account through its owner ("Dana's freight account", "the account Tobias runs") | 191 candidates: 124 should link, 67 should not | owner-phrases |
| ... resolved by uniqueness, size, renewal window, inherited region, former owner, acting cover or team | 68 unique, 14 largest by ACV, 2 renewal window, 4 inherited region, 9 former owner, 6 acting cover, 7 team, 4 contact's employer, 10 undated but unique | owner-phrases |
| ... that must not link (two accounts fit, undated and ambiguous, the phrase names a person or vendor, a login, a story) | 16 two owned, 9 undated ambiguous, 26 non-owner object, 8 contact login, 5 vendor, 3 narrative | owner-phrases |
| Account codes and family names shared by two entities (TCC, TP, PHL, Marrow, Vantorre) | 69 colliding mentions | entity-mentions, aliases |
| Look-alike names (Tansley / Tansleigh, Quarrendon / Quarendon, Orlavine / Orlavene, Pellow / Pellucid) | 37 mentions; 21 false alias pairs | entity-mentions, aliases |
| Renamed accounts (Orrin Mills to Thornbury Cloth Co., Covey & Lark to Pellow Home Living), where the new code collides with another account | 2 renames | entity-mentions, timeline |
| A signed record that is not yet in force on the asked date | 107 governing-record rows | governing-records |
| A superseded value still on file | 105 rows | governing-records |
| An affiliate or partial override (an amendment changes only the subsidiary's seats and SLA) | 83 rows | governing-records |
| A wrong value stated elsewhere (call summary, weekly update) | 41 rows | governing-records, changes |
| A draft or unsigned version of the same document | 37 rows; 6 documents | governing-records, document-status |
| A deciding clause buried in a long contract with no word overlap with the question (58 KB and 34 KB MSAs) | 6 rows | governing-records |
| Contract status only in the body, not the frontmatter | 11 documents | document-status |
| An announced handoff corrected two or three days later | 2 corrections | ownership, timeline |
| An owner who kept working an account after the official handoff (belated overlap) | 2 stints | ownership |
| An owner whose start date was never recorded | 4 stints | ownership |
| An assignment stated only in a private note | 2 stints; 5 private pages | ownership, agent-tasks (public view) |
| Pages whose body date differs from the frontmatter date, and undated pages | 2 body-date pages, 8 undated pages | owner-phrases |
| Contradictions, dated changes and compatible pairs of claims | 9 contradictions, 8 changes, 5 compatible | changes |
| "Ignore my earlier number" retractions | 4 | changes |

## Lanes and counts

| Lane | Dev | Held-out | One row is |
|---|---|---|---|
| owner-phrases | 101 | 90 | an owner phrase on a page, with the accounts it names on its date (empty when it should not link) |
| entity-mentions | 613 | 551 | one occurrence of a company surface on a page line, with the entity it denotes (or null) |
| aliases | 52 | 45 | a surface-to-entity pair, true or false, with its validity window |
| ownership | 19 | 16 | an owner stint (17 + 14) or a corrected announcement (1 + 1) |
| governing-records | 164 | 156 | account, attribute and as-of date, with the value, governing record and deciding passage |
| document-status | 21 | 20 | a contract-like page and its status (signed, unsigned, draft) |
| timeline | 29 | 27 | a dated event with evidence pages, or a never-happened announced date (1 + 1) |
| changes | 14 | 12 | a claim pair (contradiction, change, compatible) or a retraction |
| agent-tasks | 22 | 22 | a natural-language question with a typed answer, evidence slugs and traps |

Owner-phrase candidates by split: dev 101 (66 should link), held-out 90 (58 should link).

## How it was made

1. **World plan.** [`world.ts`](../../generators/messy-company/world.ts) defines the accounts, people, stints,
   contract records, events, claims and retractions. [`pages.ts`](../../generators/messy-company/pages.ts) turns them
   into 226 page briefs. `generate.ts plan` writes both to [`plan/`](plan/) and locks them in `plan/PLAN.sha256`;
   the plan cannot change without `--force`. It was last changed before any page was generated.
2. **Gold.** [`oracle.ts`](../../generators/messy-company/oracle.ts) derives every label from the plan: owners on a
   date, the governing record as of a date, account ACV, and owner-phrase resolution. The gold never comes from a
   model.
3. **Pages.** Each brief went to one author model, alternating between `gpt-6.1-sol` (112 pages) and
   `gemini-4-argon` (114 pages). The prompts are in [`prompts/`](prompts/). A page was accepted only when
   deterministic checks passed. Each owner phrase had to appear verbatim exactly once, with required aliases used.
   Undated pages had to hold no date at all. A phrase whose owner is known only privately could not sit in a
   paragraph that names the account. A long contract had to reach its length, and its notice period had to appear
   in exactly one paragraph, past the middle, without the question's words. Retraction pages had to state both
   values. 225 pages passed on the first attempt and 1 on the second. Every attempt's prompt, response, usage and check result is in `raw/author/`. Claude wrote no page text.
   The generator only adds the frontmatter (title, type, date, status, visibility) above the model's body.
4. **Cross-model check.** The other model read each page and answered questions about it without seeing the gold:
   which accounts each owner phrase names, which entity each surface occurrence denotes, ownership statements,
   events, claims, contract terms and status. Transcripts are in `raw/verify/`.
5. **Adjudication.** `labels.ts compare` compared 1,740 labeled items with the verifier's answers. 91 disagreed
   (5.2%), and the verifier also reported 3 extra owner phrases. The Capy agent (Claude Opus 5.5) settled all 94 by
   reading the page text, under one rule: never keep a label the text doesn't support. Each decision and its reason
   is in [`verification/adjudications.json`](verification/adjudications.json), and every label row carries
   `verifier_agreed` plus any adjudication.
6. **Labels.** `labels.ts build` writes `labels/<lane>/{dev,heldout}.jsonl`. It refuses to run while any
   disagreement lacks a decision.

| Lane (items checked) | Disagreements | Outcome |
|---|---|---|
| entity-mentions (1,172) | 63 | 53 relabeled, 8 dropped, 2 kept |
| ownership (47) | 14 | 13 kept, 1 dropped |
| owner-phrases (192) | 3, plus 3 extra reports | 2 kept, 1 dropped; 3 extras rejected |
| timeline (60) | 5 | 3 kept, 2 dropped |
| changes (32) | 3 | 3 kept |
| governing-records (196) | 3 | 3 kept |
| document-status (41) | 0 | none needed |

Most disagreements were not author drift. Entity mentions had no planned gold where a shared code (TCC, PHL,
Vantorre) appeared without a page-level intent; the adjudication read each occurrence. The 8 dropped mentions name
a whole family ("the Vantorre enterprise MSA covers both Vantorre Group and Vantorre Mobility"). Seven occurrences
became `null` because they discuss a code as a string ("stop putting just TP in the triage queue"). Most ownership
disagreements came from a strict date match on pages that name the owner without restating the start date. Four
labels were dropped because the written text doesn't support them:

- An onboarding ticket that never escalated stopped being evidence for an escalation event.
- A recap that never mentions the Nov 20 meeting stopped being evidence for it.
- An unsigned private note that never says who manages the account stopped being evidence for that stint.
- "The account Tobias runs" was dropped: on the page date Tobias runs one account, but on the date the page talks
  about, he runs two.

## Files

| Path | Contents |
|---|---|
| `corpus/{dev,heldout}/<kind>/<slug>.md` | the pages; the slug is the path under the split |
| `labels/<lane>/{dev,heldout}.jsonl` | gold rows; schemas in [SCORING.md](SCORING.md) |
| `plan/` | the frozen world plan and page briefs, plus their lock hash |
| `prompts/` | the author and verifier system prompts |
| `raw/author/`, `raw/verify/` | every model call: prompt, response, usage, cost; the model for each page is `raw/author/<slug>.json` `.model` |
| `raw/pilot/` | pilot outputs (5 files) from before the plan was finalized; not part of the corpus |
| `verification/` | `disagreements.json`, `adjudications.json`, `stats.json` |
| `cost/ledger.jsonl` | every paid call, with model, tokens and USD |
| `MANIFEST.json` | sha256 and size of every file above; the dataset hash is the sha256 of this file |

## Use it

```bash
bun eval/runner/messy-company/load.ts --split dev          # import the dev pages into an in-memory gbrain brain
bun eval/runner/messy-company/load.ts --split heldout --db ./mc-heldout-brain --public-only
bun eval/runner/messy-company/score-owner-phrases.ts --split dev --system out.json   # one scorer per lane
bun eval/generators/messy-company/manifest.ts check         # confirm the data matches the frozen manifest
bun test test/eval/messy-company.test.ts                    # integrity, oracle checks, scorers, loader
```

The loader uses gbrain's own `importFromContent` with no embeddings, so it needs no API key. It reads pages only,
never labels.

Tune on **dev only**. Held-out is for preregistered gate runs. Report results with the dataset hash from the PR
that froze it, the split, and the view (`full` or `public`).

## Regenerating

Regeneration is not needed to use the data, and it would not reproduce the same pages, because model output varies.
The commands are recorded for audit: `generate.ts plan`, `generate.ts pages`, `verify.ts run`, `labels.ts compare`,
`labels.ts build` and `manifest.ts write`, all under `eval/generators/messy-company/`. They need `OPENAI_API_KEY` and
`GEMINI_API_KEY`. The client stops at $140 against a $150 cap. The whole dataset cost **$4.45**: $1.77 for authoring
and $2.33 for verification, plus a $0.35 worst-case estimate for six early calls whose ledger write failed. Both
models were billed at $2 per million input tokens and $10 per million output tokens.

## Known limits

- One verifier model checked each page. A label both models got wrong in the same way would pass.
- The entity-mention gold for surfaces only one entity uses comes from the surface table. The verifier agreed on
  each of those occurrences, but they are easy items, so read the colliding and look-alike subsets for difficulty.
- The agent tasks whose evidence is private (`answer_public_only: "unknown"`) treat "the public pages give no owner
  on that date" as the right public answer. A system that repeats the last public owner from months earlier is
  scored wrong. A hedged answer ("last recorded owner was Nadia, in March 2025; no record for January 2026") is
  scored right.
- The 58 KB Quarrendon MSA trips gbrain's content-sanity warning on import. That is deliberate.
- The authors mention a few real tools and carriers in passing (Slack 8 times, Zoom 6, DocuSign 6, Okta 5, Zebra
  printers 4, and UPS, FedEx and NetSuite once each). None of them is a labeled entity, and the labels never ask
  about them.

## Changelog

### 2026-10-14: Dataset created and frozen

First version: 226 pages, 9 lanes, 94 adjudications and a frozen manifest. Generated from the gbrain-evals
`messy-company` generator against gbrain `77cf8e1`.
