# Cat 40 Hard world schema

This document is the contract between a Cat 40 Hard world generator and the Cat 40 runner, oracle, scorer and judge. A generator whose output satisfies it runs through the same harness as the main Hard generator. The sealed validation variant (gate decision CEO-UC2 in [the plan](../../plans/2026-10-05-cat40-hard/PLAN.md)) is written against this document and the family specification only.

The contract lives in code in three small modules:

| Module | Holds |
|---|---|
| [`eval/generators/hard/schema.ts`](../../../eval/generators/hard/schema.ts) | the world, task, entity, predicate and answer types, the knob schema, the scorer contract (`HardScore`) and the stop kinds |
| [`eval/generators/hard/semantics.ts`](../../../eval/generators/hard/semantics.ts) | what dates, corrections, user statements and names mean, and the single H1 predicate evaluator |
| [`eval/generators/hard/validate.ts`](../../../eval/generators/hard/validate.ts) | the invariants every world must pass; the runner refuses a world that fails them |

None of the three renders prose or draws random numbers. The main generator's renderers and templates are separate ([`hard/render.ts`](../../../eval/generators/hard/render.ts), [`model-ladder-hard.ts`](../../../eval/generators/model-ladder-hard.ts)), and the sealed variant replaces them.

## The world

A Hard world is one JSON object (`HardWorld`):

| Field | Meaning |
|---|---|
| `version` | the generator's version string: `model-ladder-hard-v2` for a knob file with the reference-form keys (the frozen generator, amendment A1), `model-ladder-hard-v1` without them (calibration rounds 1 and 2). The runner regenerates the world with the generator registered under this string and refuses a world that does not match. |
| `mode` | always `"hard"`. The runner uses it to select the Hard path. |
| `seed` | the world seed. Seeds 20261099 (smoke) and 20261006 (held out) must use the frozen knobs. |
| `scale` | absent for the 4k world, `"large"` for the 50k world. |
| `base_digest` | 50k only: the digest of the 4k world it extends. |
| `knob_schema`, `knobs`, `knob_digest` | the knob set and its digest (`knobDigest`: SHA-256 over the sorted knobs and the schema version: 2 with the reference-form keys, 1 without). A variant may use its own knob keys; the digest rule is the same. |
| `max_turns` | turns per session. The runner uses it unless `--max-turns` overrides it. |
| `today`, `principal` | the date "now" means and the person the agent works for. |
| `entities` | every account: a stable `id`, the canonical `name` and every other name in `aliases` (account code, former names, names of accounts merged into it, and in v2 every nickname). v2 adds `refs` (below). |
| `docs` | the corpus, in the Cat 40 document shape (`id`, `title`, `type`, `date`, `author`, `body`). Every arm sees each document rendered the same way. |
| `tasks` | the questions and their answer keys. |
| `references` | v2: every account reference in an event record (below). Absent in v1 worlds and in v2 worlds with `direct_name_share` 1. |

The world identity the runner records and checks on every resume is `(seed, scale, mode, version, knob_digest)`.

## Reference forms (generator v2)

Questions name accounts by name. In a v2 world most records do not: they refer to their account in one of four forms, and separate resolution documents tie each form to the name. A reader who searches for the name finds the resolution documents, then has to follow the code, the nickname or the account manager to the records. The rules below are the contract; the sealed generator implements them from this section.

**Accounts.** Every account has a name, an account code, a nickname, a region, an industry and an account manager timeline.

- The **nickname** is two capitalized words (the main generator draws one word from each of two lists, `NICK_A` and `NICK_B` in `render.ts`). Nicknames are unique across all accounts at both scales, never contain a name, code or the first word of a name, and no nickname is a substring of another account's name, code or nickname. A nickname is an alias of its entity. A renamed account keeps its nickname; a merged account's nickname becomes an alias of the account it merged into.
- The **industry** is a word fixed when the account is created (the main generator maps the suffix of the first name: Systems software, Health healthcare, Logistics freight, Labs research, Foods food, Capital finance, Robotics automation, Energy utilities, Media publishing, Retail consumer). A rename does not change it.
- The **descriptor** is `<region> <industry>`, for example `EMEA freight`.
- The **account manager** is the account owner: the CRM record gives the first one, handoff notes and owner corrections give later ones, with the effective and recorded dates of the time rules below. At 50k, appended accounts have their own team of 150 managers (none of the 18 4k managers), so a 4k record's manager reference stays unique inside the 50k world.

**Event records and resolution documents.** A resolution document names its account by full name and never uses another form: the CRM record (name, code, segment, region, first owner, champion, other names), the account sheet (name, nickname, industry, region, and the descriptor), rename notices and merger notices. Every other document that refers to an account is an event record: contracts, amendments, change orders and their corrections, tickets, handoff notes and owner corrections, agent notes, routine email, meeting transcripts, team updates, H4 drafts and summaries, H5 discount-code email and the 50k non-deciding documents. Each account reference in an event record takes one form:

| Form | Text in the record | Resolved by |
|---|---|---|
| `name` | the account's name in force on the record's date (the former name before a rename); the record may also give the code | the name itself; a former or merged name needs the rename or merger notice |
| `code` | the account code in force on the record's date, and no name | the CRM record (it lists the code, former codes and names) |
| `nickname` | the nickname, and no name or code | the account sheet |
| `manager` | `<manager>'s <descriptor> account` (`managerReference` in `semantics.ts`), for example `Mira Okafor's EMEA freight account`, and no name or code | the account sheet (descriptor) plus the account's manager timeline up to the record's date |

A record's date is its document `date`. A manager reference means the one account with that descriptor whose manager on that date is that person. The generator uses it only when it is unambiguous for any reader, using only records dated on or before it:

1. the manager in effect on the date with hindsight equals the manager the records written by then show (`managerKnownOn`: no belated handoff note or later correction is pending);
2. no other account with the same descriptor, merged accounts included, has that person as its manager on that date under either reading (`managerReadingsOn`);
3. the record is not a handoff note or owner correction (they define the timeline), and not a record of an account that later merged into another.

When a drawn manager form fails any test, the reference falls back to the code or nickname form, drawn by their weights.

**Drawing forms.** Each reference draws its form independently: `name` with probability `direct_name_share`; otherwise `code`, `nickname` or `manager` in proportion to `code_ref_weight`, `nickname_ref_weight` and `manager_ref_weight`. The main generator draws from a stream named by the document's pre-opaque id and the reference's position, after the ledger is complete, so forms never change a fact or an answer key. With `direct_name_share` 1 the generator writes v1's world exactly, apart from `version`, `knob_schema`, `knobs` and `knob_digest`.

**Resolution chains.** Every reference resolves in at most two hops, each through a document dated on or before the record: code or nickname to the CRM record or account sheet (one hop; a merged account's code or nickname then needs the merger notice, two hops); a manager reference to the handoff notes of the manager (which refer to the account by name, code or nickname) and then to the CRM record or account sheet (two hops). Every resolution document is dated on or before the first record that depends on it (the main generator dates CRM records and account sheets on the contract's signing date).

**Paths.** Event documents have opaque ids: the directory and a leading date stay, the rest is a hash, so neither a path nor a directory listing names an account. Resolution documents keep readable ids (`crm/<name>`, `accounts/<name>`).

**Oracle evidence.** `relevant` and `gold.evidence` add, for each event record they hold, the resolution documents its reference needs: the CRM record for a code, the account sheet for a nickname, the account sheet and every manager-timeline document recorded on or before the record (with their own resolution documents) for a manager reference, the rename notice for a former name and the merger notice for a merged account's record.

**World fields.** `entities[].refs` holds `codes` (own, former and merged codes), `nicknames` (own and merged), `descriptor` and `managers` (each `{ name, effective, recorded, doc }`). `references` lists `{ doc, entity, form, text }` for every reference in an event record; resolution documents are exactly the documents with no entry.

## Multi-account questions (amendment A2)

Knobs `multi_account_min` and `multi_account_max` (knob schema 3; both or neither, and only with the reference-form knobs) set how many accounts each H2 to H5 question asks about. Each task draws its count k from that range; with a maximum of 1 the generator writes the v2 world exactly (only `knob_schema`, `knobs` and `knob_digest` differ). The world `version` stays `model-ladder-hard-v2`.

**Items.** A question with k = 1 is the v2 single-account task. For k of 2 or more, the task is k independent single-account instances of its family, called items, each with its own accounts, variant, attribute, documents, key and evidence, exactly as v2 builds one task. Item j of task i in the main generator takes variant and attribute from index i + j * (tasks_per_family + 1) and draws from random streams named `<i>:<j>` (item 0 keeps v2's names), so items of one question differ in variant or attribute; a sealed generator may choose differently but must keep each item a complete instance of its family:

- H2: one account's attribute as of the item's own date (each item keeps its own date).
- H3: one look-alike cluster with its own ambiguous first word or code prefix and its own disambiguating fact; the item's account is the account the disambiguation resolves to (the holder for a merged pair).
- H4: one account's authoritative current value.
- H5: one statement chain (four facts, one per recording session, with the superseded fact, the required facts and the look-alike or noise fact, as in v2). The item's account is the account the item's question names (routing: the account; merge: the account folded into another).

**Unlinked accounts.** No two accounts created for different items of one question share a descriptor, the first word of a name, the first three characters of an account code, or any account manager in their timelines, so no single search or manager phrase covers two items. The main generator redraws an item's account (stream `<key>:<attempt>`) until it holds, and excludes the other items' managers when it adds a later handoff. Look-alikes of an item are not checked against other items (they share their own target's first word or prefix by design).

**Wording.** The question is the items' v2 single-account questions, numbered, in this exact shape:

```
Answer each of these <k> questions:
1. <item 1's single-account question>
2. <item 2's single-account question>
Answer with a JSON array of the <k> answers in the order asked, as one string in `answer`, for example ["first answer","second answer"].
```

**H5 sessions.** Each recording session carries one statement from every item's chain: session n's message is the chains' n-th statements in item order, joined by a space, then the recording instruction. `session_facts` lists, for each session in order, one fact per chain in item order; a fact's `superseded_by` names the later session holding the fact with the same key. The oracle note is `Recorded from team updates (sessions 1 to 4):` followed by every chain's lines.

**Task fields.** `answer_kind` is `values`; `accounts` is every item's accounts (H5: each chain's account and, for a merge chain, the account folded into it), without repeats; `variant` is the items' variants joined by `|`; `gold.items` as above; `gold.evidence` and `relevant` are the union of the items' (each item's records carry their resolution documents, so the oracle can tie every item's records to its account).

**People and size.** A multi-account knob set needs about twice the 4k accounts, so the main generator draws surnames from `LAST` plus `LAST_MORE`. Its 4k world is only the 50k world's base (A2: no 4k cells), so only the 50k world is held to its size band.

## Tasks

Each task (`HardTask`) has an id `H1-01` to `H5-NN`, a `family`, a `variant` for breakdowns and an `answer_kind`:

- **`value`** (H2 to H5): one value in `answer`. `gold.answer` lists accepted values; `gold.wrong` lists values that fail the answer when named anywhere in it (superseded values, a look-alike's value, lower-authority values, superseded user statements). Every H2 to H5 task fills `gold.wrong`.
- **`set`** (H1): a JSON array of account names, sent as one JSON-encoded string in `answer`. `gold.members` lists each member's entity id and every accepted name, canonical first.
- **`count`** (H1): the integer at the start of `answer`; `gold.count` is the key.
- **`values`** (H2 to H5 multi-account questions, amendment A2): a JSON array with one answer per numbered item, in order, sent as one JSON-encoded string in `answer`. `gold.items` lists, per item in question order, the entity id it asks about (`account`), its accepted values (`answer`) and the values that fail that item (`wrong`). There is no task-level `gold.answer` or `gold.wrong`.

Other fields:

| Field | Meaning |
|---|---|
| `question` | the scored question. For H5 it is the final session's message. |
| `sessions` | H5 only: the user messages of the four recording sessions, in order. Each asks the agent to record a statement and submit `RECORDED`. |
| `gold.evidence` | documents that decide the answer, for missed-evidence reporting. |
| `relevant` | documents the oracle arm receives. |
| `oracle_notes` | synthesized documents the oracle also receives. For H5 this is the ideal store after the recording sessions. |
| `predicate`, `near_miss` | H1: the predicate the key came from, and how many near-miss entities exist and how many the oracle evidence covers. |
| `session_facts` | H5: each recording session's fact, whether the answer depends on it, and which later session supersedes it. The write diagnostic uses it. |

### What each family must contain

- **H1, many records.** A set or count over `h1_min_members` to `h1_max_members` accounts (round 4: 6 to 12), from a predicate over owners, open escalated tickets, renewal dates, segments and regions, as of a date. The key is `evaluatePredicate` over the generator's ledger. Oracle evidence holds every member's deciding records and the near misses' records, capped in seeded order, plus the rename or merger notice of any of them whose records use more than one name. No predicate turns on a boundary a reader could take either way (an event on the as-of date, a renewal on a window edge). When a template's plain predicate cannot land in the member range after half its attempts (2,500 of 5,000), the main generator adds one clause: a region (the owner, segment-and-escalated and escalated-and-renewal templates, worded "<region> accounts") or, for the region-and-renewal template, a segment. v1 and v2 knob sets never reach that point.
- **H2, long histories.** One attribute that changes 3 to 6 times with reversals, backdated corrections and effective dates that differ from signing dates, asked as of a date. Oracle evidence holds the attribute's full dated history.
- **H3, look-alikes.** Accounts sharing a first word or a code prefix, a renamed account or a merged account. The question names only the ambiguous name and one fact that has to be looked up. Oracle evidence holds the disambiguating record and the look-alikes' records.
- **H4, authority.** 3 to 5 documents that disagree: executed contract and amendments, draft amendment, email summary and agent note. Some deciding documents are long, with the deciding line mid-document.
- **H5, five sessions.** The final answer depends on facts from at least two recording sessions, one fact is superseded later in the chain, and removing a required fact changes or voids the answer.

## Meaning of dates, corrections, statements and names

These rules decide every answer key, and the Hard system prompt states them to every arm, the oracle included:

1. Every attribute value has an effective date and a recorded date.
2. "As of D" is the value in effect on D, using every document, including documents written after D.
3. A change takes effect on its stated effective date. A change whose effective date is after `today` does not apply yet.
4. A correction replaces the corrected value from that value's effective date: it carries the corrected value's effective date and a later recorded date. Two values with the same effective date resolve to the later recorded one.
5. Authority: an executed contract or executed amendment outranks a draft amendment, which outranks an email summary, which outranks an agent note. Between two executed documents the later effective date wins.
6. A user statement in an H5 chain outranks documents, and a later statement outranks an earlier one.
7. Every name, code, former name and merged name maps to exactly one entity id, at both scales. A merged account's records (its tickets, for example) are the entity's records.
8. Records an account writes on or after its rename date use the new name and code; earlier records keep the old ones. The rename or merger notice is the document that links the names.
9. v2: a record may refer to its account by code, nickname or as `<manager>'s <descriptor> account`, which means the one account with that descriptor whose account manager on the record's date is that person. The Hard system prompt of a v2 world states this rule and where account sheets, CRM records and handoff notes give the parts (`HARD_RULES_REFERENCES`).

## Invariants (`validate.ts`)

The runner refuses a world (stop code `HARD_WORLD_INVALID`) unless:

- `mode` is `hard`, `knob_digest` matches `knobs`, and `max_turns` is a positive integer;
- document ids are unique and every `relevant` and `gold.evidence` id exists;
- task ids look like `H1-01`, H5 tasks have four recording sessions and other tasks have none;
- set tasks have members that are entities, count tasks have a non-negative integer, value tasks have accepted answers; a `values` task has two or more items about different entities, each with accepted answers and (H2 to H5) wrong values, and no two items' entities share a descriptor, first word, first three code characters or account manager;
- accepted and wrong values are pairwise distinct and never substrings of each other after `normalizeValue` (per item in a `values` task);
- the name namespace is injective;
- v2 (`referenceProblems`): every reference's text is in its document; a `name` reference uses a name of its entity, a `code` or `nickname` reference one of its codes or nicknames; a reference not by name contains no name of its entity, and a nickname or manager reference no code either; a manager reference names the manager known on its date and fits no other account with the same descriptor; every code, nickname and descriptor a reference uses appears with a name of the entity in a resolution document dated on or before it; and in every task's `relevant`, each reference reaches the entity's canonical name within two hops through other oracle documents, with the manager timeline present for manager references.

Problems name only the family, the task index and counts, so a held-out world is checked without anyone reading it.

## How answers are scored

[`eval/runner/cat40/score-hard.ts`](../../../eval/runner/cat40/score-hard.ts) implements the rules in `schema.ts`:

1. **Coercion.** An array `answer` becomes its JSON string, other non-strings become strings, and null or missing becomes empty.
2. **Values.** The head of the answer (the text before a parenthetical, semicolon or dash aside) must name an accepted value, and the whole answer must name no wrong value. "X (or Y)" fails when Y is wrong.
3. **Sets.** The answer must parse as a JSON array of strings, directly or inside surrounding text. Each element maps to an entity by exact normalized equality with one of its names, never by substring; elements naming the same entity count once. Success is exact set equality. Precision, recall and Jaccard are reported and never count as success. An answer that is not a JSON array is `unparseable_set`.
4. **Counts.** The integer at the very start of the answer must equal the key. "12" and "12 accounts" pass; "As of 2026-07-01, 12" does not.
5. **H5.** Only the final session is scored; whether each recording session submitted `RECORDED` is reported.
6. **Multi-account values.** The answer must parse as a JSON array of strings or numbers (numbers read as strings), directly or inside surrounding text, with exactly one element per item. Element n is scored by rule 2 against item n's accepted and wrong values. Success needs every element right; items answered right are reported. An answer that is not such an array is `unparseable_set`. Scorer version `cat40-hard-score-v2`; rules 1 to 5 are unchanged from v1.

## Adding a generator

A second generator, such as the sealed validation variant, does three things:

1. Writes worlds that satisfy `HardWorld` and pass `hardWorldProblems`, with its own `version` string. A v2-equivalent generator writes `references` and `entities[].refs` by the reference-form rules above.
2. Uses `semantics.ts` for every answer key, so the rules above hold.
3. Registers its regenerator in `HARD_WORLD_GENERATORS` in [`eval/runner/cat40/hard.ts`](../../../eval/runner/cat40/hard.ts), keyed by its version string, so the runner can check a world against its generator.

Its seed and rendered world stay sealed until a held-out check that Garry or a preregistration names.
