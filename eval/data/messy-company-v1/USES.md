# Uses of messy-company-v1

The same 226 pages serve many eval categories, so one frozen corpus can compare features without each category
building its own world. This page maps each lane to the questions it can answer. The rules are the same for every
use:

- Tune prompts, thresholds and code on **dev** (North and Central accounts). Run **held-out** (Coastal and
  Strategic) only for a preregistered gate. Held-out has the same trap types on different accounts, names and
  contracts.
- Load pages with `bun eval/runner/messy-company/load.ts`. It never reads labels.
- Cite the dataset hash from the freezing PR, the split, the view (`full` or `public`) and the scorer report.
- Rows with `verifier_agreed: false` were adjudicated. Rows with `adjudication: "relabel"` changed. A category may
  report results with and without them.

| Lane | Category it serves | Dev | Held-out | What it measures there |
|---|---|---|---|---|
| owner-phrases | Owner-phrase linking | 101 | 90 | Does a phrase like "Dana's freight account" link to the account Dana owned on the page's date, and stay unlinked when two accounts fit or the phrase names something else? The `public` view checks that a link never relies on a private page. |
| aliases | Alias precision (P3) | 52 | 45 | Are codes, short names, former names and nicknames attached to the right entity, while look-alikes and corpus typos are not? `collides_with` marks surfaces two entities share legitimately. |
| entity-mentions | Look-alike disambiguation; Cat 40 Hard H3 (look-alike entities) | 613 | 551 | Which entity does each occurrence of TCC, PHL, TP, Marrow or Vantorre denote on that page and date? Use the 69 colliding and 37 look-alike rows as the headline; unique surfaces only check coverage. |
| ownership | Cat 40 Hard H2 (long histories); account-history recall | 19 | 16 | Who owned an account on a date, through corrected announcements, belated overlaps, unknown starts, acting cover and private-only assignments? |
| governing-records | Governing record as of a date (F1); deciding passage (F2); Cat 40 Hard H4 (authority) | 164 | 156 | What value governs on a date, which record decides it, and which line says so? Traps: signed but not yet effective, superseded, drafts, partial affiliate overrides, misstatements, and clauses deep in 34–58 KB contracts with no word overlap. |
| document-status | Document status (F3) | 21 | 20 | Signed, unsigned or draft, including 11 documents whose status is only in the body. |
| timeline | auto_chronicle-style timelines | 29 | 27 | Are dated events extracted with the right date and account, and is no event placed on a handoff date that a correction retracted? Event evidence lists every page that states the event. |
| changes | Contradiction surfacing (N2) | 14 | 12 | Contradictions, dated changes and compatible pairs between claims; "ignore my earlier number" retractions. A category that proposes resolutions can use `correct` on each side. |
| agent-tasks | Cat 40 Hard style agent questions; takes and attribution | 22 | 22 | End-to-end questions over the brain with typed answers and evidence slugs. Each task names the lane it exercises, and `traps` lists what makes it hard. |

## Runs on this dataset

Each run that used this dataset, newest first. A held-out run spends that lane's held-out split: later work on the
same lane tunes on dev only, and any later held-out run reports that the split was used before.

| Date | Lane and splits | Purpose | Code | Rule sha256 | Result |
|---|---|---|---|---|---|
| 2026-10-14 | owner-phrases, dev and held-out | F5 owner-phrase precision ship condition | gbrain `4e10136b` | `6ca46ba4a25e09dd87a3b0ca298f406ab077e71fb06145f83e40703b5fce0b11` | **FAIL.** 6 links, 6 correct, Wilson 95% [0.610, 1.000], against a bar of ≥ 0.85 with ≥ 22 links. Recall dev 2/66, held-out 4/58. 0 links on should-not-link rows. [Run record](../../../docs/benchmarks/2026-10-14-f5-messy-company/README.md) |

**Held-out use so far:** owner-phrases, once (the F5 run above). Future owner-phrase work tunes on dev only. No other
lane's held-out split has been used.

## Notes per use

**Owner phrases.** Each row records `reason` and `window_relation`, so a report can show which resolution rule
fails: start day, last day, after the window, acting window, inside an unknown-start stint, or undated. The
`stints` field names the ownership rows the answer depends on, so a failure can be traced to an ownership error.
Every candidate phrase appears verbatim exactly once on its page.

**Takes and attribution.** Many pages are first-person: private notes, account wiki edits and weekly updates
compiled "from Ilse's notes". The ownership evidence and the adjudication notes record when a page states something
only in the first person. An attribution category can use those rows to ask who said what, and on whose authority.

**Governing records with long contexts.** The two long MSAs (Quarrendon, 58 KB, dev; Vantorre, 34 KB, held-out)
each state the notice period in one paragraph past the middle of the document, without the words a question would
use: no form of "renew", "cancel", "terminate" or "expire", and no "notice period" or "opt out". `deciding_passage.chars_into_document` gives the offset.

**Timeline negatives.** The two `negative: true` rows are handoffs that were announced and then corrected. An
extractor that trusts the first email places an event on a date when nothing happened.

**Private pages.** Five pages carry `visibility: private`. Two ownership stints, and the answers that depend on
them, are known only from those pages. Run the `public` view with `load.ts --public-only` to measure that private
facts don't leak into public answers.

## Changelog

### 2026-10-14: First run entry

Added "Runs on this dataset" with the F5 owner-phrase run: FAIL at gbrain `4e10136b`, 6 of 6 links correct but
below the 22-link minimum and the 0.85 Wilson bar. The owner-phrases held-out split has now been used once.

### 2026-10-14: First version

Lane-to-category map for the frozen dataset.
