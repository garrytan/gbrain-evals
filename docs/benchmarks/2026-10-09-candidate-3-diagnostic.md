# Candidate 3 diagnostic: the remaining T0b corrections are linked by a declared short code, not by nothing

## The finding

After [Candidate 1](2026-10-09-candidate-1-newer-mentions.md), two T0b failure classes are left: stale prices or seat
counts, which come from a later call note, and missed hop commitments, which come from a technical review the champion
did not attend. Both were described as notes that "name no entity". They do name one. The call note is titled
"Call with JOF", JOF being the short code the company page declares for itself ("Also called JOF in my notes"). gbrain
master does not treat a three-letter code as a name, so the note links to nothing. The hop failures come from the same
code: the reader passed it to `context_pack` in place of the company's name.

Measured on October 9, 2026, at $0.10 and with no reader cells:

- **The pages never reached the reader.** 33 Candidate 1 cells failed on terms or the hop (29 terms, 7 hop, some
  both), 216 cells in all across development and fresh seeds. We replayed their session-2 calls on gbrain master
  `dda603ac` (v0.60.130.0) with reranking live. The call note was in no tool result in any of the 29 terms cells. That
  includes the 12 searches that named the company and a pricing word. The technical review was in no tool result in
  any of the 7 hop cells. In both arms, every run that opened the page passed the item.
- **The short code is the only signal that picks the right entity.** The champion's first name and nickname are shared
  with a namesake person. The company's first word, which is also the word in the note's file name, is shared with a
  namesake company. The generator does this on purpose.
- **The short-code alias fix in gbrain#6271 (candidate 2) closes most of the gap.** On keyless rebuilds of the eight
  development brains, `context_pack` on the champion and the company returned the call note in 0 of 24 tasks on
  master and in 21 of 24 on master merged with #6271.
- **What #6271 leaves is code collisions and stoplisted codes.** BRL and PRF are each declared by two companies in
  their brain, so #6271 drops them as ambiguous, and THE is on its stoplist. That is 3 of 24 development tasks and 4 of
  24 fresh tasks (three collisions and ONE), about 15%. Those tasks account for 8 of the 29 terms failures and 2 of
  the 7 hop failures.

So no separate Candidate 3 was built or measured. A design that does not use the code would have to link through
first names, nicknames, file names or initials. In this workload those either attach the note to the namesake or work
only because of how the generator builds names. The follow-up that does stand is collective disambiguation for
colliding codes (below). It is documented here and was not built.

## The concrete case

Invented data from the generator (persona 20261104, task 2). The brain holds:

- the company page `companies/gralenza-analytics` (dated August 1): "Also called GRA in my notes", champion Vikram
  Marchetti, engineering contact Vikram Aziz;
- the deal page: "Terms quoted: 35 seats at $14 per seat per month";
- the October 11 note `meetings/2026-10-11-gralenza-call`, titled "Call with GRA": "Attendees: Vik, me." and "Scope:
  they need 15 seats, not 35 (my earlier count was off)";
- the October 1 note "Gralenza Analytics technical review": "Attendees: Vik (GRA engineering), me" and "Me: send GRA
  our benchmark results on their monorepo".

Sonnet 5.5 on Candidate 1 called `context_pack` on "Vikram Marchetti, Gralenza Analytics" and opened nine pages,
including the technical review, which the company card lists. Then it searched "Gralenza seats price quote revised
true-up". The replayed search lists 34 pages and not the call note, because the note contains neither "Gralenza" nor
anyone's full name. The reader quoted 35 seats in both repeats.

Nothing else in the note can tell which Vikram it means. "Vik" is the nickname of both Vikrams at the company and of
the champion's namesake at the other "Gralenza" company. The file name's "gralenza" fits both companies. GRA fits only
this one.

## The experiment and results

### Inputs

- Candidate 1 cells: `candidate-1-newer-mentions/candidate-1/` (development seeds 20261101 to 20261108, 144 cells) and
  `candidate-1-newer-mentions/fresh-seeds/candidate-1/` (amendment 3's fresh seeds, 72 cells), with their usage
  receipts. Failure classes use the root-cause classifier's rules.
- World: generator `program-primary-hard-v1`, `DEFAULT_KNOBS`, digests `dccafc6f` (development) and `081ea8b8`
  (fresh).
- No custodian-sealed seed was opened.

### Remaining failures (Candidate 1 arm)

| Seeds | Reader | Terms | Hop | Opened the call note when terms failed | Opened the technical review when hop failed |
|---|---|---:|---:|---:|---:|
| development | Opus 5.5 | 5 | 0 | 0 | n/a |
| development | Sonnet 5.5 | 16 | 6 | 0 | 0 |
| fresh | Opus 5.5 | 3 | 0 | 0 | n/a |
| fresh | Sonnet 5.5 | 5 | 1 | 0 | 0 |

gpt-6.1-sol has no terms or hop failures. Across the 216 cells, every run that opened the call note avoided the stale
terms and every run that opened the technical review kept the hop commitment.

### Rank replay (`candidate-3/rank-replay.ts`)

The replay rebuilt the brains of the 33 failing cells on gbrain `dda603ac`, which contains Candidate 1, with embeddings
on and the reranker live (the fail-closed rerank probe from #109 passed on every slot). It re-executed each cell's
session-2 tool calls in order and recorded where the call note, the technical review, the deal and the company page
appear among the slugs each result lists.

| What we looked for | Cells | In any tool result |
|---|---:|---:|
| Call note, in terms-failure cells | 29 | 0 |
| Call note, in the 12 searches of those cells that name pricing, seats or a quote | 12 searches | 0 |
| Technical review, in hop-failure cells | 7 | 0 |

The searches look reasonable: "Ondrumbr order form seats pricing discount", "Iskenza quote pricing seats revised
discount", "Ondrellis Energy quote revised seats price". They rank pages that name the company, and the call note
names it only as a code. When the call note did come back, the query carried the code: in 2 hop-only cells, Sonnet's
"BRL call Arjun procurement lead" and "NAE call procurement lead" returned it at positions 0 and 11. In the
successful Candidate 1 runs, the last lookup before the reader opened the call note named the code in 71 of 139.

### Why the hop commitment was missed

The technical review is titled with the full company name ("Gralenza Analytics technical review"), so the mention pass
links it to the company and Candidate 1 puts it on the company card. A `context_pack` with the company's name returned
it in 24 of 24 development tasks. In all 6 development hop failures, Sonnet 5.5 passed the code instead: "Arjun Thorne,
BRL", "Ayla Eskildsen, VER" (twice), "Calla Castellan, NAR" (twice), "Kenji Fairbourne, NAE". The prep prompt names the
customer by its code ("a call with Quin from JOF"), and the code resolves to no entity on master, so the company card
was never built. The one fresh hop failure made no `context_pack` call.

### Card probe (`candidate-3/card-probe.ts`, $0)

The probe builds keyless brains for the eight development personas and calls `context_pack` on each task's champion
plus the company, once by name and once by the code the prompt uses. No reader runs.

| Build | Call note on the card (name / code) | Technical review on the card (name / code) | Median result size (name / code) |
|---|---|---|---|
| master `dda603ac` | 0 / 0 | 24 / 0 | 10,585 / 5,627 characters |
| master + #6271 (`5461914c`, a local merge with #6271's head `9bba4da4`) | 21 / 21 | 24 / 22 | 11,516 / 11,820 characters |

The handoff and the reschedule mail were on the card in 24 of 24 tasks both ways on both builds.

The merge is a measurement build, not a branch. Its conflicts were in the CHANGELOG, the module-size table, two
goldens, the behavior-change list (both sides kept), an import line in `engine.ts` (both imports kept) and the
migration registry. Master and #6271 both add a v223, so #6271's `v223-persistence-client-request-id` is renumbered
v225 here. When #6271 lands, its own merge will make that choice.

### The residual after #6271

| Seeds | Task | Company | Declared code | Why #6271 does not link it |
|---|---|---|---|---|
| development | h20261103-t2 | Branesso Logistics | BRL | two companies declare BRL (`alias_collision`, `src/core/by-mention.ts:631` on #6271) |
| development | h20261103-t3 | Thalellis Energy | THE | stoplist (`src/core/mentions/short-codes.ts:25` on #6271) |
| development | h20261107-t1 | Pralithe Freight | PRF | two companies declare PRF |
| fresh | h306480323-t1 | Thalesso Foods | THF | collision |
| fresh | h476843991-t3 | Iskique Foods | ISF | collision |
| fresh | h691467441-t1 | Caelura Foods | CAF | collision |
| fresh | h731983881-t2 | Ondrellis Energy | ONE | stoplist |

The generator builds each code from the first two letters of the first word and the first letter of the second
(`eval/generators/program-primary-hard-gen.ts:157`), and about 30 companies share a brain, so some codes are bound to
collide. Real codes collide and look like words too. These are the tasks a follow-up would reach.

### Signals that would be traps

Each signal a reader or a linker might use instead of the code, checked against the generator:

- **File name or folder.** The call note's slug is `meetings/<date>-<first word>-call` (:272). The namesake company
  shares the first word (:195), and its check-ins use the same file-name word (:235). Linking on it attaches notes to
  both companies.
- **Attendee first name or nickname.** "Attendees: Vik, me." The namesake person has the champion's first name, and
  so the same nickname (:196). In some tasks a colleague at the same company shares it too (persona 20261104, task 2).
- **Initials.** Guessing a code from a company name's letters reproduces how the generator builds codes (:157). It
  would score well here and mean nothing in a real brain.
- **Same-day meetings, calendar attendees, links out of the deal page.** T0b has no calendar pages, the deal page links
  only to the champion, and the call note's date is drawn independently of every other page's. The workload cannot
  exercise these signals.

The only unambiguous link is the code the company page declares. That is the realistic signal, and #6271 already uses
it.

## What to use and what to avoid

Use candidate 2 (#6271's short-code rule, together with Candidate 1) as the fix for the terms and hop classes. On these
worlds it puts the call note on the card in 21 of 24 development tasks and resolves the code the prep prompt uses. The
paired measurement of that stack runs separately.

Do not build a candidate that links notes by file name, attendee first names or initials. On T0b it would either
mislink to the namesake, which the namesake class scores as a failure, or score well only because of the generator.

If code collisions matter in real brains, the follow-up is collective disambiguation, stacked on #6271, with zero LLM
calls at write time. When a page contains a code more than one entity declares ("BRL") and a participant first name
("Attendees: Arjun"), it links both only if exactly one code-and-person pair is connected in the graph (Arjun Thorne
works at Branesso Logistics). The same rule could admit a stoplisted code that a linked attendee corroborates. It would
also put call notes on the champion's card. On T0b it reaches about 7 of 48 tasks, which 144 pairs cannot measure, so
it needs its own preregistered workload with more collisions, and a precision check on a routine-mail brain.

Limits: development and fresh public seeds only, no custodian-sealed set. The card probe uses keyless brains, which
matter for search but not for card contents. The #6271 merge is local, and #6271's head may change before it lands.

## Reproduce and inspect

```bash
# rank replay ($0.10 of embeddings and reranking): every session-2 call of the Candidate 1 cells that failed on terms or the hop
bun eval/runner/budget-ledger.ts open --runner t0b-candidate-3-rank-replay --budget-usd 3 --estimate-usd 1
bun docs/benchmarks/2026-10-08-program-primary-hard/candidate-3/rank-replay.ts --gbrain <gbrain checkout> --ref dda603ac --label master-dda603ac --budget-run-id <id>

# card probe ($0, keyless brains)
bun docs/benchmarks/2026-10-08-program-primary-hard/candidate-3/card-probe.ts --gbrain <gbrain checkout> --ref dda603ac --label master
# master + #6271: merge origin/capy/cat40-hard-fix (9bba4da4) into dda603ac, keep both sides of behavior-change-notice.ts and the
# engine.ts imports, renumber #6271's v223-persistence-client-request-id to v225, take master's side of the non-runtime conflicts
bun docs/benchmarks/2026-10-08-program-primary-hard/candidate-3/card-probe.ts --gbrain <gbrain checkout> --ref <merge commit> --label master-plus-6271
```

Keys for the replay: `OPENAI_API_KEY` and `VOYAGE_API_KEY`. Bun 1.4.2 (also at `/usr/local/bin/bun`, which harness
slots spawn).

Receipts are in [`2026-10-08-program-primary-hard/candidate-3/`](2026-10-08-program-primary-hard/candidate-3/):
`rank-replay.ts` and `rank-replay-master.json.gz` (every replayed call with the four pages' positions and the
ledger receipt), `card-probe.ts`, `card-probe-master.json` and `card-probe-master-plus-6271.json`.

| Ledger run `t0b-candidate-3-rank-replay-2026-10-09T13-37-30-837Z-2b297e92` | Dollars |
|---|---:|
| Rank replay: 12 brain builds and 33 cells' session-2 calls | 0.10 |
| Card probes (keyless) | 0.00 |
| **Total** | **0.10** |

## Changelog

### 2026-10-09: first version

A diagnostic in place of Candidate 3: rank replay, card probes on master and master + #6271, the residual after #6271,
and the signals that would be traps. No candidate was built, and no reader cells ran.
