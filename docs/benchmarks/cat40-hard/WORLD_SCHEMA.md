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
| `version` | the generator's version string, for example `model-ladder-hard-v1`. The runner regenerates the world with the generator registered under this string and refuses a world that does not match. |
| `mode` | always `"hard"`. The runner uses it to select the Hard path. |
| `seed` | the world seed. Seeds 20261099 (smoke) and 20261006 (held out) must use the frozen knobs. |
| `scale` | absent for the 4k world, `"large"` for the 50k world. |
| `base_digest` | 50k only: the digest of the 4k world it extends. |
| `knob_schema`, `knobs`, `knob_digest` | the knob set and its digest (`knobDigest`: SHA-256 over the sorted knobs and the schema version). A variant may use its own knob keys; the digest rule is the same. |
| `max_turns` | turns per session. The runner uses it unless `--max-turns` overrides it. |
| `today`, `principal` | the date "now" means and the person the agent works for. |
| `entities` | every account: a stable `id`, the canonical `name` and every other name in `aliases` (account code, former names, names of accounts merged into it). |
| `docs` | the corpus, in the Cat 40 document shape (`id`, `title`, `type`, `date`, `author`, `body`). Every arm sees each document rendered the same way. |
| `tasks` | the questions and their answer keys. |

The world identity the runner records and checks on every resume is `(seed, scale, mode, version, knob_digest)`.

## Tasks

Each task (`HardTask`) has an id `H1-01` to `H5-NN`, a `family`, a `variant` for breakdowns and an `answer_kind`:

- **`value`** (H2 to H5): one value in `answer`. `gold.answer` lists accepted values; `gold.wrong` lists values that fail the answer when named anywhere in it (superseded values, a look-alike's value, lower-authority values, superseded user statements). Every H2 to H5 task fills `gold.wrong`.
- **`set`** (H1): a JSON array of account names, sent as one JSON-encoded string in `answer`. `gold.members` lists each member's entity id and every accepted name, canonical first.
- **`count`** (H1): the integer at the start of `answer`; `gold.count` is the key.

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

- **H1, many records.** A set or count over 10 to 40 accounts, from a predicate over owners, open escalated tickets, renewal dates, segments and regions, as of a date. The key is `evaluatePredicate` over the generator's ledger. Oracle evidence holds every member's deciding records and the near misses' records, capped in seeded order.
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
7. Every name, code, former name and merged name maps to exactly one entity id, at both scales.

## Invariants (`validate.ts`)

The runner refuses a world (stop code `HARD_WORLD_INVALID`) unless:

- `mode` is `hard`, `knob_digest` matches `knobs`, and `max_turns` is a positive integer;
- document ids are unique and every `relevant` and `gold.evidence` id exists;
- task ids look like `H1-01`, H5 tasks have four recording sessions and other tasks have none;
- set tasks have members that are entities, count tasks have a non-negative integer, value tasks have accepted answers;
- accepted and wrong values are pairwise distinct and never substrings of each other after `normalizeValue`;
- the name namespace is injective.

Problems name only the family, the task index and counts, so a held-out world is checked without anyone reading it.

## How answers are scored

[`eval/runner/cat40/score-hard.ts`](../../../eval/runner/cat40/score-hard.ts) implements the rules in `schema.ts`:

1. **Coercion.** An array `answer` becomes its JSON string, other non-strings become strings, and null or missing becomes empty.
2. **Values.** The head of the answer (the text before a parenthetical, semicolon or dash aside) must name an accepted value, and the whole answer must name no wrong value. "X (or Y)" fails when Y is wrong.
3. **Sets.** The answer must parse as a JSON array of strings, directly or inside surrounding text. Each element maps to an entity by exact normalized equality with one of its names, never by substring; elements naming the same entity count once. Success is exact set equality. Precision, recall and Jaccard are reported and never count as success. An answer that is not a JSON array is `unparseable_set`.
4. **Counts.** The integer at the very start of the answer must equal the key. "12" and "12 accounts" pass; "As of 2026-07-01, 12" does not.
5. **H5.** Only the final session is scored; whether each recording session submitted `RECORDED` is reported.

## Adding a generator

A second generator, such as the sealed validation variant, does three things:

1. Writes worlds that satisfy `HardWorld` and pass `hardWorldProblems`, with its own `version` string.
2. Uses `semantics.ts` for every answer key, so the rules above hold.
3. Registers its regenerator in `HARD_WORLD_GENERATORS` in [`eval/runner/cat40/hard.ts`](../../../eval/runner/cat40/hard.ts), keyed by its version string, so the runner can check a world against its generator.

Its seed and rendered world stay sealed until a held-out check that Garry or a preregistration names. [SEALED.md](SEALED.md) describes the sealed variant, its independence rules and how to reveal it.
