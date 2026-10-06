# Cat 40 Hard: the sealed validation variant

The sealed variant is a second Cat 40 Hard world generator, written separately from the main one. It produces the same kinds of tasks (H1 to H5) with the same answer rules, but in document styles, naming conventions and folder layouts that gbrain has never been tuned on. Its seed is private and its rendered world stays unopened until a later held-out check reveals it. That check shows whether a gbrain improvement measured on the main Hard tier also holds on company documents written another way, or whether it learned the main generator's habits.

The generator lives in [`eval/generators/hard-sealed/`](../../../eval/generators/hard-sealed/). It reads the same knob files as the main generator and implements the same reference forms (generator v2, amendment A1): with the reference-form knobs, most records name their customer by short-name, desk handle or "<lead>'s <territory> <sector> account" instead of by name. With the multi-account knobs (amendment A2) its H2 to H5 questions ask about two or more unlinked customers at once. It is registered with the runner as `hard-sealed` (knob files without the reference-form keys) and `hard-sealed-v2` (knob files with them, multi-account keys included), and its worlds pass the same invariants, runner checks and scorer as main Hard worlds. Gate decision CEO-UC2 in [the Hard plan](../../plans/2026-10-05-cat40-hard/PLAN.md) created it. No paid cell has run on it.

## Committed digest

| Field | Value |
|---|---|
| Sealed world digest (4k) | `<to be recorded after the knob freeze>` |
| Knob file | `<the frozen knob file>` (knob digest `<to be recorded>`) |
| Generator commit | `<to be recorded>` |
| Recorded on | `<to be recorded>` |

The digest is recorded only after the main generator's knobs are frozen, with the frozen knob file, because any knob change changes the sealed world. Until then nobody generates the sealed world at all. The digest is the SHA-256 of the world JSON (`sealedWorldDigest` in `generate.ts`). It changes if the seed, the knobs, or any code that shapes the world changes: the sealed generator itself, `eval/generators/hard/schema.ts` and `eval/generators/hard/semantics.ts`. A changed digest means the revealed world is not the world that was sealed. Record a new digest, with its date and reason, before relying on it.

## What makes it independent

The variant was written from the family specification and the world contract only. The author read:

- the Hard plan's family specification ("The Hard tier"), the H1 to H5 requirements under "Accepted review requirements" and the gate decisions;
- the contract modules [`schema.ts`](../../../eval/generators/hard/schema.ts), [`semantics.ts`](../../../eval/generators/hard/semantics.ts) and [`validate.ts`](../../../eval/generators/hard/validate.ts), and [WORLD_SCHEMA.md](WORLD_SCHEMA.md);
- the runner registration point `HARD_WORLD_GENERATORS` in `eval/runner/cat40/hard.ts` and the Hard scorer (`eval/runner/cat40/score-hard.ts`, with the `score.ts` helpers it calls);
- the type signatures of the shared document type (`LadderDoc`), the `renderDoc` export and the main generator's `generateHardWorld` export.

The author did not read the main generator's renderers, templates or document builders (`eval/generators/hard/render.ts`, `eval/generators/model-ladder-hard.ts` and the prose templates in `eval/generators/model-ladder-gen.ts`), nor the main generator's tests. The variant has its own random number generator rather than reusing `eval/generators/hard/rng.ts`.

The reference forms were added the same way, from the "Reference forms" section of WORLD_SCHEMA.md and the shared `schema.ts`, `semantics.ts` (`managerReference`, `managerKnownOn`, `managerReadingsOn`) and `validate.ts` (`referenceProblems`). The author did not open the main generator's v2 rendering code, its nickname lists or its v2 tests, and needed no main-generator code to settle a schema question.

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
| Reference forms | See below. Only with the reference-form knob keys and `direct_name_share` below 1. |

## Reference forms

With a knob file that carries `direct_name_share`, `code_ref_weight`, `nickname_ref_weight` and `manager_ref_weight` (for example `knobs.round-3.json`), the sealed variant follows the same contract as the main generator: each customer reference in a record takes the name, code, nickname or manager form, drawn by those knobs after the ledger is complete, and resolves to one customer in at most two hops through documents dated on or before it. Answer keys do not change: a world with the reference keys has the same questions and keys as the world from the same knobs without them. The one link that can postdate a record is from a former or merged-away name to the current name: for a record written before a rename or merger, the notice that links the names is later, although the record still points at exactly one customer on its date. A drawn lead form that a reader could not pin to one customer falls back to the short-name or handle, so at the round-3 knobs about a fifth of references use the lead form (996 of 5,108 on test seed 101) rather than the 42.5% the weights alone would give. Its own styles:

| Contract part | Sealed variant |
|---|---|
| Code form | The short-name (`ABC-12`), declared on the record card. Tickets give it as `ref:`, mail subjects as `Ref:`, order forms as `VF-<short-name>`. |
| Nickname form | A desk handle: two capitalized words from the variant's own lists (materials and colours, then tools and fittings), such as "Amber Lantern". Tickets give it as `handle:`. |
| Manager form | "`<lead>'s <territory> <sector> account`", built by `managerReference`. The territory is one of the four sealed territories; the sector comes from the trade in the first registered name (several trades share one, so look-alike descriptors are common). Tickets give it as `account:`. |
| Resolution documents | The record card (short-name, first lead, primary contact) and a new account profile (registered name, desk handle, sector, territory, and the literal "`<territory> <sector> account`" phrase), both dated the day the card opened, plus the rename and merger notices and their change slips. |
| Lead timeline | The record card for the first lead, then one change slip per change-log row, plus late notices by forwarded mail or ops bulletin. With reference forms the single change log becomes one slip per row, so every timeline document carries the date it was keyed. Slips and notices never use the lead form. |
| Customer mail | A customer address spells the customer's name, so a forwarded customer mail shows the sender's address only when the record names the customer; otherwise the sender appears as "(customer side)". |
| Document ids | Event records move to `<area>/<ten consonants>`, for example `mail/bdkqrtxwzm`, so no path names a customer. Record cards, profiles and rename and merger documents keep `registry/<short-name>/...` and `mail/<short-name>/...` ids. Ticket and bulletin ids never named a customer and are unchanged. |
| 50k world | Appended customers have their own 150 leads (none of the 12 Verrowind leads), so a lead named in a 4k record still points at one 4k customer. |

A knob file without the reference keys reproduces the earlier sealed worlds byte for byte. With the keys and `direct_name_share` 1, the world is the reference-free world apart from `version`, `knob_schema`, `knobs` and `knob_digest`, as WORLD_SCHEMA.md requires.

One change is not tied to reference forms: an H3 task with more than four look-alikes needs seven or more distinct attribute values, more than the base pools hold, so the variant now adds two overflow values per attribute in that case only. Before this, round-2 and round-3 knobs stopped the sealed generator with "cannot sample 7 of 6". Worlds whose knobs never need the overflow values are unchanged.

## Multi-account questions

With `multi_account_min` and `multi_account_max` (knob schema 3, for example `knobs.round-4.json`), each H2 to H5 task draws its item count k from that range, and the variant follows WORLD_SCHEMA.md's "Multi-account questions" section:

- **Items.** Each item is a complete single-account instance of its family, built by the same code as a single-account task, with its own customers, documents, key, evidence and resolution documents. Item j of task i takes its variant or attribute from index i + j and its random streams from `<i>/item<j>` (item 0 keeps the single-account names), so consecutive items differ in variant or attribute.
- **No shortcut.** While a question's items are built, each item's customer (and, for a merged H3 pair, the customer folded into it) takes a territory and sector pair and account leads that no earlier item's customer has: the trade, territory and lead team are drawn from what is still free. First words and short-name prefixes already never repeat outside one look-alike cluster. Look-alikes are not checked across items, as the contract says.
- **Wording, sessions and fields.** The question, the H5 session layout (every chain's n-th statement in item order, then one recording instruction), `session_facts` order, the oracle note's first line, `answer_kind` `values`, `gold.items`, `accounts`, `variant` and the evidence unions follow the contract text exactly, because the shared scorer and runner read them. The sealed single-account question texts and the sealed recording instructions fill the parts the contract leaves open.
- **Unchanged worlds.** Without the multi-account keys, or with `multi_account_max` 1, the world is byte for byte the reference-form world (with the keys, only `knob_schema`, `knobs` and `knob_digest` differ).

At the round-4 knobs a 4k world has about 9,400 to 9,900 documents and the 50k world about 54,000 to 55,000 (test seeds). The sealed H1 search finds its 20 predicates in the smaller 6-to-12 member range without the main generator's extra-clause fallback; if a future knob set left it short, generation stops with a message naming the knobs to change.

Readings of the contract where it leaves room:

- A sealed H5 statement can carry two facts (the contact statement names a signer at each of two sites). `session_facts` therefore lists every fact of each chain's statement for a session, in item order, rather than exactly one fact per chain.
- The contract gives the oracle note's opening line (`Recorded from team updates (sessions 1 to 4):`) but not where it goes. It is the first line of the note's body; the note title keeps the sealed style and names every item's customer.
- "No two accounts created for different items" is read as each item's customer plus, for a merged H3 pair, the merged-away customer, whose name and short-name are aliases of the item's customer. Look-alikes and the H5 noise customer are exempt.

The variant keeps everything the scorer and runner depend on: task ids, answer kinds, `gold.wrong`, oracle evidence, the H5 ideal-store note, and the meaning of dates, corrections, authority and user statements from `semantics.ts`. It reads the same knob set as the main generator. At the default knobs a 4k world has about 4,100 documents and the 50k world about 46,000.

## Choose and record the seed

1. Pick a seed privately, for example with `od -An -N4 -tu4 /dev/urandom`. Do not use the plan's fixed seeds (20261005, 20261006, 20261099) or the test seeds (101, 202, 303).
2. Keep the seed outside the repository and off any shared agent drive, where Garry or the preregistration owner can retrieve it. The current seed lives on Garry's Mac at `~/Private/gbrain-sealed/cat40-hard-sealed-seed.txt` (mode 600). It was rotated on 2026-10-05 because the first seed sat on a project drive that every implementing agent could read; nothing had been generated from it.
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

For reference forms it checks, on test seeds and the round-3 knobs: byte-for-byte reproduction of the earlier worlds from knob files without the reference keys; that every reference resolves to exactly one customer and is introduced by a resolution document dated on or before it; that oracle `relevant` and `gold.evidence` each tie every reference to the canonical name through resolution documents, with the lead timeline for the lead form; that answer keys equal the reference-free world's; desk-handle uniqueness and containment rules at both scales; opaque ids; the 50k extension; and that no sealed sentence template or six-word run appears in a main-generator v2 world.

For multi-account questions it checks, on test seeds and the round-4 knobs: that `multi_account_max` 1 reproduces the reference-form world; every invariant, determinism and runner acceptance; the contract wording and fields; the no-shortcut rule (no shared descriptor, name first word, short-name prefix or account lead between items' customers); resolvability and oracle completeness; that each item's evidence holds a record about its customer; the H5 layout and per-item dependency; the scorer on gold, swapped, short, prose and wrong-valued arrays; and the full round-4 50k extension for seed 101.

## Changelog

- 2026-10-06: Multi-account questions (amendment A2) added from WORLD_SCHEMA.md: k items per H2 to H5 question, unlinked items, the contract's wording, H5 session layout and `values` fields; the round-4 knobs run at both scales. Worlds without the multi-account keys are unchanged.
- 2026-10-05: Reference forms (generator v2, amendment A1) added from WORLD_SCHEMA.md, with the variant's own desk handles, account profile, change slips and id scheme, the `hard-sealed-v2` version, and the H3 overflow values that let round-2 and round-3 knobs run. Worlds from knob files without the reference keys are unchanged. The digest stays unrecorded until the knob freeze.
- 2026-10-05: The sealed generator, CLI, tests and this document are added. The digest is not yet recorded. During authoring, the output comparison found a few generic contract phrases shared with the main world (for example, a phrase about both parties signing on a date); they were reworded before the first commit.
