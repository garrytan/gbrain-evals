# Cat 40 Hard: the sealed validation variant

The sealed variant is a second Cat 40 Hard world generator, written separately from the main one. It produces the same kinds of tasks (H1 to H5) with the same answer rules, but in document styles, naming conventions and folder layouts that gbrain has never been tuned on. Its seed is private and its rendered world stays unopened until a later held-out check reveals it. That check shows whether a gbrain improvement measured on the main Hard tier also holds on company documents written another way, or whether it learned the main generator's habits.

The generator lives in [`eval/generators/hard-sealed/`](../../../eval/generators/hard-sealed/). It is registered with the runner as `hard-sealed`, and its worlds pass the same invariants, runner checks and scorer as main Hard worlds. Gate decision CEO-UC2 in [the Hard plan](../../plans/2026-10-05-cat40-hard/PLAN.md) created it. No paid cell has run on it.

## Committed digest

| Field | Value |
|---|---|
| Sealed world digest (4k) | `<to be recorded after the seed is chosen>` |
| Knob file | `<to be recorded>` (knob digest `<to be recorded>`) |
| Generator commit | `<to be recorded>` |
| Recorded on | `<to be recorded>` |

The digest is the SHA-256 of the world JSON (`sealedWorldDigest` in `generate.ts`). It changes if the seed, the knobs, or any code that shapes the world changes: the sealed generator itself, `eval/generators/hard/schema.ts` and `eval/generators/hard/semantics.ts`. A changed digest means the revealed world is not the world that was sealed. Record a new digest, with its date and reason, before relying on it.

## What makes it independent

The variant was written from the family specification and the world contract only. The author read:

- the Hard plan's family specification ("The Hard tier"), the H1 to H5 requirements under "Accepted review requirements" and the gate decisions;
- the contract modules [`schema.ts`](../../../eval/generators/hard/schema.ts), [`semantics.ts`](../../../eval/generators/hard/semantics.ts) and [`validate.ts`](../../../eval/generators/hard/validate.ts), and [WORLD_SCHEMA.md](WORLD_SCHEMA.md);
- the runner registration point `HARD_WORLD_GENERATORS` in `eval/runner/cat40/hard.ts` and the Hard scorer (`eval/runner/cat40/score-hard.ts`, with the `score.ts` helpers it calls);
- the type signatures of the shared document type (`LadderDoc`), the `renderDoc` export and the main generator's `generateHardWorld` export.

The author did not read the main generator's renderers, templates or document builders (`eval/generators/hard/render.ts`, `eval/generators/model-ladder-hard.ts` and the prose templates in `eval/generators/model-ladder-gen.ts`), nor the main generator's tests. The variant has its own random number generator rather than reusing `eval/generators/hard/rng.ts`.

A hermetic test compares outputs, not code. It renders a main Hard world through its exported generate function and checks that no sealed sentence template and no six-word run of sealed text appears in it. A sentence template is the sentence with digits and capitalized words replaced by placeholders.

## How the sealed world differs

| Aspect | Sealed variant |
|---|---|
| Company and people | A fictional supplier, Verrowind Systems, with its own staff, customers, sites and contacts. Customer names are invented words plus a trade, such as a cold-storage firm or a water board. |
| Account codes | Called short-names, in the form `ABC-12`. Record cards declare them in a header table (`Short-name`); contracts, mail subjects and helpdesk exports declare them as `Ref:`. |
| Renamed and merged accounts | A rename is a change-log row ("registered name") plus a forwarded notice from the customer. A merger is a change-log row ("merged in") plus a notice that the absorbed account's order form is retired. |
| Account leads | Record cards give the first lead. Later handoffs are change-log rows with separate "keyed" and "applies from" dates, or late notices in forwarded mail and ops bulletins. Some rows are corrected later. |
| Contracts | An order form with a commercial schedule; numbered change orders, either executed or unsigned drafts, with an "applies from" date. Corrections are corrective change orders. Long documents bury the deciding clause among numbered general clauses. |
| Mail, meetings, tickets, notes | Forwarded threads with a header table and quoted original; minutes with a timestamped discussion log and an action-item table; helpdesk exports as key-value blocks with a dated state history; assistant scratchpads; numbered ops bulletins. |
| Folder layout | `registry/<short-name>/`, `paper/<short-name>/`, `mail/<short-name>/`, `minutes/<short-name>/`, `assistant/<short-name>/`, `support/<ticket>` and `bulletin/issue-<n>`. No document id contains a date. |
| H5 chains | Which site receives signed renewal paperwork, and who signs for documents at each site. The final answer needs the routing statement and the contact statement in force, and one of them is replaced later in the chain. |

The variant keeps everything the scorer and runner depend on: task ids, answer kinds, `gold.wrong`, oracle evidence, the H5 ideal-store note, and the meaning of dates, corrections, authority and user statements from `semantics.ts`. It reads the same knob set as the main generator. At the default knobs a 4k world has about 4,100 documents and the 50k world about 46,000.

## Choose and record the seed

1. Pick a seed privately, for example with `od -An -N4 -tu4 /dev/urandom`. Do not use the plan's fixed seeds (20261005, 20261006, 20261099) or the test seeds (101, 202, 303).
2. Keep the seed outside the repository, where Garry or the preregistration owner can retrieve it.
3. Print the digest without writing any document:

   ```bash
   bun eval/generators/hard-sealed/cli.ts --seed <s> --out eval/reports/cat40/hard-sealed --digest-only
   ```

   Add `--knobs <file.json>` to use a knob file other than the default knobs. The command prints the digest, the knob digest and counts only, never the seed or document text.
4. Record the digest, knob file, knob digest, generator commit and date in the table above.

## Reveal and run it later

A held-out check that Garry or a preregistration names opens the sealed world:

1. Regenerate it and confirm the digest matches the committed one:

   ```bash
   bun eval/generators/hard-sealed/cli.ts --seed <s> --out eval/reports/cat40/hard-sealed [--knobs <file.json>]
   ```

   This writes `world.json`, the rendered documents under `docs/` and `digest.txt`. Add `--scale large` for the 50k world, which appends accounts and documents without changing any answer key.
2. Check the harness at $0:

   ```bash
   bun eval/runner/cat40-model-ladder.ts --scripted --arms fs,memory,oracle --world eval/reports/cat40/hard-sealed/world.json --out eval/reports/cat40/hard-sealed-scripted
   ```

3. Run the paid comparison with the Hard runner's usual flags (`--world <world.json> --models <list> --judge gpt-6.1-sol --arms oracle,fs,pg,memory,gbrain`), as [RUNBOOK.md](RUNBOOK.md) describes for Hard steps. The runner checks the world against the `hard-sealed` generator before any cell starts.

## Tests

`test/eval/cat40-hard-sealed.test.ts` covers determinism, every `validate.ts` invariant, runner acceptance and tamper refusal, family shapes, the scorer contract (gold answers pass; wrong values, hedges, missing or extra set members, off-by-one counts and prose sets fail), H5 dependency (each required fact changes or voids the answer), the 50k extension and the independence comparison above.

## Changelog

- 2026-10-05: The sealed generator, CLI, tests and this document are added. The digest is not yet recorded. During authoring, the output comparison found a few generic contract phrases shared with the main world (for example, a phrase about both parties signing on a date); they were reworded before the first commit.
