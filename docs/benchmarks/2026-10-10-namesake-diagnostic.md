# T0b namesake failures are scorer false positives: 11 of 11 runs disambiguated correctly or never named the namesake

## The finding

After the [short-code alias fix](2026-10-09-alias-stack.md), most of the failures left on its arm are namesake flags
(`unsupported` under `t0b-score-v1`). The flag means the answer contains a value that belongs to the contact's
namesake: their meeting date, their seats or price, or the promise the user owes them. This diagnostic read every run
that names a namesake value, on both arms, the development seeds and the fresh seeds. It found no conflation.

- **25 runs name a namesake value; the scorer flags 11 of them, and all 11 are false positives.** No reader stated a
  namesake's value as the contact's fact.
  - **7 of the 11 are disambiguations the scorer's cue list misses.** Examples: "That's Elodie Petrov at Yarithe Foods,
    a different account, so I left it out", "a different prospect, not Felix Mehta", "there's an Arjun Torvik at
    Branesso Robotics ... Neither is this call", "most likely the DOL Omari, not Om Quist. Check before you treat it as
    a DOA item". The v3 cue list (`eval/runner/t0/score.ts:64` and `:100`) knows "different person/contact/company",
    "don't mix" and "separate". It does not know "different account" or "different prospect", "not <contact>",
    "neither" or "not for". Every one of the 7 lines names the namesake person.
  - **4 of the 11 are generic words that overlap a namesake promise's pattern.**
    - Two offer "an order form" or "a corrected order form" when the namesake is owed "the updated order form" (the
      pattern is `order form`).
    - One is gpt-6.1-sol relaying a gbrain maintenance notice into the reply ("reference lists may be incomplete").
    - One is a true fact about the contact: "In July she asked about a sandbox for another team", from the contact's
      own July mail (`inbox/2026-07-14-torvik-340`), while the namesake is owed "a sandbox account for their team".
  - The other 14 runs disambiguate in words the scorer catches ("don't confuse", "separate deal").
- **gbrain never resolved the wrong entity.** The 25 runs made 24 `context_pack` calls and 16 `entity` calls. Each one
  named the contact or the company by full name, slug or code, and none returned the namesake's person page. Readers
  never looked anyone up by a bare first name or nickname.
- **The namesake reaches readers mainly through search on the company's first word, which the namesake company
  shares.** On the alias arm it reached the reader through the first
  `context_pack` call in 5 runs. (On master, `search` carried the namesake's page or name; the daily note itself
  was not reproduced by keyword search.) The reason is that the daily note that holds the namesake's promise also says "Pinged
  Mira at DOA about SSO." The alias fix links "DOA" to the contact's company, so the daily note becomes one of the
  company card's newer mentions, and its preview is the start of the note, namesake line included. Readers attributed
  that line correctly in 5 of 5 runs.

Rescoring the 11 audited runs as passes is post hoc and exploratory; the preregistered result stands. It changes the
alias-stack development comparison from 25 to 11 of 144 (`inconclusive`) to 22 to 6 of 144 (factor 3.46, 95%
interval for R 0.06 to 0.91, `improvement`). The fresh-seed result stays 18 to 4 of 72, because its one flagged run
also misses a commitment. Opus 5.5's development failures go from 4 and 8 to 2 and 4. All of the 4 left on the alias
arm are stale terms on tasks whose call note the generator's code collisions leave unlinked.

So the residual between a ~15x and a ~20x sealed factor is not a namesake product failure in this evidence. It is the
scorer, plus the code collisions that T0b generator v2 removes. Namesake flags also count against the stack more than
against the frozen release. The frozen baseline's only two flags sat on runs that failed for other reasons. The stack
fails so rarely that each false flag is a whole failed run.

## The concrete case

Development persona 20261107, task 3, alias arm, Opus 5.5, repeat 2 (invented data). The contact is Omari Quist ("Om")
of Dovvane Analytics, coded DOA. The brain also has Omari Rahman ("Om") of Dovvane Logistics, coded DOL. The October 7
daily note reads:

```
- Pinged Mira at DOA about SSO.
- Investor update went out; two replies asking about churn.
- Omari Rahman (DOL) asked about 15 seats; I owe Om the customer reference list.
```

The reader's first call, `context_pack {"entities": "Dovvane Analytics,Omari Quist"}`, returned that note among the
company card's newer mentions. The reader then opened it and wrote:

> **Not DOA:** Your Oct 7 daily note says "I owe Om the customer reference list." In that note, "Om" is Omari Rahman of
> **Dovvane Logistics (DOL)**, a different prospect with a similar name. They're at 15 seats, and their security review
> is Oct 30. So that list isn't something you owe Om Quist, unless you also promised it to him somewhere I can't see.

That answer is right, and it flags the ambiguity in the user's own note. The scorer failed the run three times over:
"15 seats", "Oct 30" and "reference list" sit in a line whose only cue, "a different prospect", is not on its list.

## Method

- **Runs.** Every baseline run in the [alias-stack receipts](2026-10-08-program-primary-hard/alias-stack/) (master
  `dda603ac` and "master + alias fix" `9ac26bea`, development 144 runs per arm, fresh seeds 72 per arm) whose session-2
  answer matches any namesake pattern. That is 25 runs: 11 flagged and 14 excused by the scorer, with 12 on development
  master, 11 on the development alias arm, 2 on fresh master and 0 on the fresh alias arm.
- **Reading.** Each matching line was read against the brain: which namesake value, whether it is attributed to the
  namesake, hedged, or stated as the contact's, and whether the value belongs to the namesake at all
  (`namesake-diagnostic/audit.json`).
- **Replay ($0).** `namesake-replay.ts` re-executes every read call of each run's session 2, with its recorded
  arguments and in order, on keyless rebuilds of that persona's brain on the run's gbrain build. It records which
  results carry the namesake's page, name or daily note, and which people each `context_pack` and `entity` call
  resolved. The pushed hook text is checked as recorded; it never carried the namesake.
- **Replay limits.** Without embeddings and the reranker, `search` is keyword search, so the search rows are
  approximate. In the master runs the namesake's person page comes back from searches on the company's first word,
  but the daily note itself was not reproduced. `get_page` replays match the recorded sizes (median difference 0).
  `context_pack` and `entity` replays come back about 1,000 to 2,100 characters shorter (medians 1,792 and 2,043),
  because the keyless brain lacks session 1's saved fact. The receipts keep only result sizes, so the lists cannot be
  compared page by page; the replay shows what the same call returns on the same brain without session 1's write.

## Mechanism classes

| Class | Runs | Flagged by the scorer | Development master | Development alias | Fresh master |
|---|---:|---:|---:|---:|---:|
| Disambiguation the scorer caught | 14 | 0 | 7 | 6 | 1 |
| Disambiguation the scorer missed | 7 | 7 | 2 (Opus) | 5 (Opus 4, Sonnet 1) | 0 |
| Generic word overlaps a namesake-promise pattern | 4 | 4 | 3 (Opus 1, Sonnet 1, gpt 1) | 0 | 1 (Sonnet) |
| Namesake value stated as the contact's | **0** | 0 | 0 | 0 | 0 |

Where the namesake's material first appeared in a run's tool results (replayed): `search` in 20 runs, the first
`context_pack` in 5 (all on the alias arm, all through the daily note described above). No `entity` call, no
`get_page` of the namesake's person page and no pushed hook text carried it first.

## What to change

**In the scorer and generator (preregistered before the sealed run).**
1. Attribute by entity, not by cue word. A namesake value in a line that names the namesake person (full or last
   name) or the namesake company (name or code) is attributed to the namesake. All 7 missed lines and the 14 caught
   ones name the namesake. Keep the cue list as a second route for lines that name neither.
2. In generator v2, give each namesake promise a distinctive multi-word item, and match the item phrase ("the updated
   order form", "a sandbox account"), not its head noun. Also keep namesake items out of the vocabulary of filler mail
   lines and generic offers ("Is there a sandbox we could try for another team?" is a filler line today).
3. Validate before freezing. The 25 audited lines must score as they read here: 25 passes on the namesake item. A
   mutation set must fail: each namesake value restated as the contact's ("Om, I owe you the customer reference list",
   "your review on Oct 30"), including lines that also name the namesake. The existing
   `assertScorerRejectsFakeSystems` kit is where those cases go.

The regression to guard against is a real conflation that also names the namesake. An example: "Omari Rahman's team
asked about 15 seats, so Om, here's the reference list I owe you." Rule 1 would excuse it. A per-sentence owner check
(the value's sentence addresses or names the contact as its owner) closes that hole, and the mutation set should
contain exactly this case.

**In gbrain (optional; the evidence does not require it).**
- **Line-anchored previews for list-style pages.** A newer-mention preview on a card currently shows the start of the
  page. For a page whose lines are separate items (daily notes, bulleted logs), show the line that mentions the
  entity, here "Pinged Mira at DOA about SSO.", instead of the first 200 characters. That would have kept the
  namesake's line off the company card in the 5 alias-arm runs.
  - Opus 5.5 and Sonnet 5.5 already attributed the line correctly in those 5 runs, so the expected score change is
    zero. The expected gain is
    fewer distracting lines and fewer tokens on busy brains.
  - The risk is real. For a mail, the decisive sentence often follows the line that names the entity ("From: Kofi
    Aziz (JOF)" and then "Yusuf takes over procurement"), and Candidate 1's gain comes from that preview. So the rule
    must apply only to list-style pages, and it needs its own paired measurement before it ships.
- **Maintenance notices addressed to the operator.** gbrain's "pending entity indexing" notice ended up in a reply
  drafted for a customer. Labelling such notices as operator-only text, not for user-facing output, is a one-line
  wording change.

No change to `entity` resolution or to how cards label same-first-name people is supported by this evidence. Both
already kept the people apart in every call.

## Reproduce and inspect

```bash
D=docs/benchmarks/2026-10-08-program-primary-hard
# keyless slots come from the alias-stack probe (alias-probe.ts, labels master / stack / master-fresh / stack-fresh)
bun $D/namesake-diagnostic/namesake-replay.ts --gbrain <gbrain> --ref dda603ac9e152be45afd6f4edd3789bc11e000b8 --label master --arm $D/alias-stack/development/master --out replay-development-master.json
bun $D/namesake-diagnostic/namesake-replay.ts --gbrain <gbrain> --ref 9ac26bea780e15cb660b2f29691613fcad5d0bf6 --label stack  --arm $D/alias-stack/development/alias  --out replay-development-alias.json
# fresh seeds: --label master-fresh / stack-fresh with $D/alias-stack/fresh-seeds/<arm>
```

Receipts are in [`2026-10-08-program-primary-hard/namesake-diagnostic/`](2026-10-08-program-primary-hard/namesake-diagnostic/):
- `audit.json`: each of the 25 runs, its class, the matching lines and the reading.
- `replay-*.json`: per-call traces with recorded and replayed sizes, carriers and resolved people. The fresh alias arm
  had no run to replay.
- `namesake-replay.ts`.

No paid calls; every replay ran on keyless brains.

## Changelog

### 2026-10-10: first version

Every namesake-flagged T0b run on the alias-stack arms read and replayed.
