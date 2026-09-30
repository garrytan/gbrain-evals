# N4 entity resolution: gbrain keeps different people apart, resolves what `aliases:` records, and has two merge bugs

Date: 2026-09-30. Category `entity-resolution` (legacy alias N4), report-only. gbrain 0.60.10.0 (the pinned dependency, 608a174) and 0.60.11.0 (master, f8d1e39, loaded as a copied overlay). Both produced identical numbers: the resolver, save-time and identity code did not change between the two commits.

## The finding

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents: notes are Markdown pages, and a database index serves search, facts and relationships. When a note or an agent names someone ("Lenny", "@llinden", "L. Linden-Example"), gbrain has to decide which page that name means before it can attach a fact or answer a question. This category measures that decision on a generated world with known answers.

On 136 single-source mentions at the default seed, gbrain's resolver was precise: it merged a mention into the wrong entity once (1/136), refused every one of the 17 mentions that should be refused, and resolved every variant that the page records in its `aliases:` frontmatter (25 of 25, plus 4 correct refusals of a shared alias). Its B-cubed F1 over mention clusters was 0.755, against 0.566 for an exact-name-only baseline, 0.480 for refusing everything and 0.109 for merging everything.

Recall is where it stops: 68.1% of the 119 solvable mentions resolved. All 37 misses are variants gbrain does not read by design: one-letter typos, initials that are not in `aliases:`, and nicknames or handles that appear only in page prose. None of them turned into a wrong merge.

Two behaviors are bugs:

1. **The exact-name floor breaks when another page lists that name as an alias.** A person's own exact name resolves to a different person whose former name it was. The resolver, `remember`, `recall` and the bulk save path all inherit it; `search` gets the same case right.
2. **Federated `recall` merges two different people who share a slug in two sources.** With a two-source grant, `recall({ entity })` returns both people's facts in one list, and the rows carry no `source_id`, so the caller cannot separate them.

Verdict: `fail` against the contract targets (wrong merges must be 0, the floor 100%, B-cubed F1 at least 0.9, unresolved at most 10%). The category is report-only, so this is information, not a CI failure.

## Update, 2026-09-30: both merge bugs fixed at the new pin (`6c8373c`, v0.60.13.0)

gbrain v0.60.13.0 ([#5769](https://github.com/garrytan/gbrain/pull/5769)) includes fixes for both bugs. Re-run at the new pinned dependency, gbrain master `6c8373c`, with the same ledger (default seed 20260930, same ledger SHA-256) on a clean gbrain-evals tree (commit `26cb600`):

| Surface | Wrong merges | Floor | Correct refusals | Accuracy | B-cubed F1 |
|---|---|---|---|---|---|
| resolver | 0/136 (was 1) | 48/48 (was 47) | 17/17 | 82/119, 68.9% (was 81) | 0.762 (was 0.755) |
| recall | 0/144 (was 3) | 50/50 (was 49) | 21/21 (was 19) | 86/123, 69.9% (was 85) | 0.778 (was 0.770) |
| remember | 0/136 (was 1) | 48/48 | 17/17 | 82/119 | 0.762 |
| resolve_on_save | 0/136 (was 1) | 48/48 | 17/17 | 82/119 | 0.762 |

"Leonard Linden-Example" now resolves to his own page on all four surfaces, and a two-source `recall({ entity })` for the same-slug namesakes (name and slug) is refused instead of merging both people's facts. Seed 7 also gives 0 wrong merges, the full floor and every refusal (resolver 74/119, B-cubed F1 0.719). 740 of 740 probes scored with 0 errors on both seeds.

The verdict is still `fail`, and the category stays report-only. The remaining shortfall is recall of variants gbrain does not read by design (typos, initials not in `aliases:`, names declared only in prose), which keeps B-cubed F1 under 0.9 and unresolved above 10%. Receipts: [receipt-pin-6c8373c.json](2026-09-30-n4-entity-resolution/receipt-pin-6c8373c.json) and [seed 7](2026-09-30-n4-entity-resolution/receipt-pin-6c8373c-seed7.json). The historical sections below describe `608a174` and `f8d1e39`.

## The concrete case

All names are invented placeholders.

- `people/leonard-linden-example`, titled "Leonard Linden-Example".
- `people/leonard-dunmore-example`, titled "Leonard Dunmore-Example", with `aliases: ["Leonard Linden-Example"]` and the prose line "Formerly Leonard Linden-Example; name changed on 2023-04-10."

An agent calls `remember` with "Leonard Linden-Example joined the platform team" and `entity: "Leonard Linden-Example"`. The name is exactly the first person's title and slug. gbrain stores the fact on `people/leonard-dunmore-example`, the other Leonard. Searching the same name puts `people/leonard-linden-example` first, because the search exact-lookup tier checks exact titles; the resolver checks aliases before it checks the exact page name.

Other mentions in the world, and what the right answer is:

| Mention | Right answer | Why |
|---|---|---|
| `people/alice-tern-example` | that page | exact slug (the floor) |
| "Lenny" with `aliases: [Lenny]` | Leonard Linden | the page records it |
| "Lenny" only in prose ("Goes by Lenny.") | Leonard Linden | written, but not in `aliases:` |
| "Lenard Linden-Example" | Leonard Linden | one deleted letter, no other name within two edits |
| "Florence Pebble-Example" | refuse | two different people carry that exact name |
| "Theo" asked by a caller who can read only `default` | refuse | the alias exists only in the `team` source |
| "Rebecca Flint-Example" asked with a `default`+`team` grant | refuse | two different people, one per source, no identity link |
| "Theodore Thistle-Example" asked with a `default`+`team` grant | Theodore Thistle | one person with a page in each source, linked by an identity group |

## The experiment and results

**World.** `eval/generators/n4-entity-gen.ts` writes a seeded ledger: 28 pages in two sources (`default` and `team`) for 26 entities (24 people, 2 companies), 3 identity groups, and 144 mentions. Variant families: exact slug, exact name, nickname, typo, @handle, initials, changed name (a marriage-style surname change and a company rebrand, each with an effective date), bare first name, namesake, and no-referent names. Each variant is recorded in `aliases:` or declared only in prose by a seeded coin, so both kinds occur.

**Gold.** An oracle re-reads the rendered Markdown the harness imports, restricted to the sources the caller may read, and applies the first matching rule: exact slug, exact name, declared name (an `aliases:` entry or a prose declaration), a one-edit typo with no other name within two edits, initials, bare first name. One entity is solvable, and the gold records the evidence line that proves it. Two or more entities are ambiguous; none is no-evidence. Pages linked by a written identity assertion count as one entity; a shared slug alone does not. The oracle throws if its verdict disagrees with the ledger's design, so a generator bug cannot become gold. Gold is held in a `GoldStore`; gbrain only sees mention text.

**Surfaces.** Each is real gbrain code on in-memory PGLite with no embedding provider:

- `resolver`: `resolveEntitySlugWithSource`, the read-time cascade (exact slug, alias exact, exact basename, bare-name prefix expansion, same-name fuzzy match, slugify fallback). A `fallback_slugify` result counts as a refusal, which is gbrain's own documented gate.
- `recall`: the `recall` operation with `entity`. Each page carries one marker fact, so the facts returned name the page gbrain resolved to. Callers are scoped local, remote with a one-source grant and remote with a two-source grant.
- `remember`: the `remember` operation; the stored `entity_slug` is the resolution. A slug that is no seeded page is a new, fragmented identity.
- `resolve_on_save`: `resolveExtractedEntitiesForSave`, the bulk-extraction save path, fed extractor-shaped facts directly.
- `search_floor`: the `search` operation on exact slugs and names; the page itself must rank first.
- `identity`: `entity_identity_list` for every page under five caller scopes.

**Metrics.** B-cubed precision and recall over mention clusters (a refusal is its own cluster; predicted clusters follow gbrain's stored identity groups), accuracy over solvable mentions, wrong merges (a mention attached to a different entity, or any attachment of a mention that must be refused) over all mentions, unresolved and fragmentation rates over solvable mentions, correct refusals over the refusal set, and the floor (exact slug and exact name probes). Product exceptions are scored misses; there were none.

### Head to head (default seed 20260930, pin and master identical)

| Surface | Mentions | B-cubed F1 | Accuracy | Wrong merges | Unresolved | Fragmented | Correct refusals | Floor |
|---|---|---|---|---|---|---|---|---|
| resolver | 136 | 0.755 | 81/119 (68.1%) | 1/136 | 31.1% | 0% | 17/17 | 47/48 |
| recall | 144 | 0.770 | 85/123 (69.1%) | 3/144 | 30.1% | 0% | 19/21 | 49/50 |
| remember | 136 | 0.755 | 81/119 (68.1%) | 1/136 | 0% | 31.1% | 17/17 | 47/48 |
| resolve_on_save | 136 | 0.755 | 81/119 (68.1%) | 1/136 | 31.1% | 0% | 17/17 | 47/48 |
| baseline: singleton-everything | 136 | 0.480 | 0/119 | 0/136 | 100% | 0% | 17/17 | 0/48 |
| baseline: merge-everything | 136 | 0.109 | 0/119 | 136/136 | 0% | 0% | 0/17 | 0/48 |
| baseline: exact-only | 136 | 0.566 | 48/119 (40.3%) | 0/136 | 59.7% | 0% | 17/17 | 48/48 |

The baselines run through the same scorer over the resolver's 136 mentions. Refusing everything wins every refusal and loses all recall; merging everything loses every refusal. gbrain's resolver B-cubed precision was 0.990 and recall 0.611.

`search_floor`: 48/48 exact slugs and names ranked their own page first, including the Leonard case. `identity`: 32/32 expected group members visible, 0 members leaked outside a grant.

The refusal set on the resolver surface is 11 ambiguous mentions (namesakes, a shared first name, a shared alias), 4 names that belong to nobody, and 2 alias lookups from a source that cannot read the alias. Recall adds a remote one-source caller (2 more unreadable) and two ambiguous two-source lookups.

### By variant family (resolver)

| Family | Mentions | Correct | Correct refusal | Unresolved | Wrong merge | Resolver stage that answered |
|---|---|---|---|---|---|---|
| exact slug | 26 | 26 | | | | `exact_page` 26 |
| exact name | 22 | 21 | | | 1 | fuzzy/basename 21, `alias_exact` 1 |
| nickname | 16 | 5 | 4 | 7 | | `alias_exact` 5, fallback 11 |
| typo | 15 | 0 | | 15 | | fallback 15 |
| handle | 19 | 14 | | 5 | | `alias_exact` 14, fallback 5 |
| initials | 14 | 4 | | 10 | | `alias_exact` 4, fallback 10 |
| first name | 12 | 9 | 3 | | | `prefix_expansion` 9, fallback 3 |
| changed name | 2 | 2 | | | | `alias_exact` 2 |
| namesake | 6 | | 6 | | | fallback 6 |
| no referent | 4 | | 4 | | | fallback 4 |

Split by where the variant is written: recorded in `aliases:` 25 correct and 4 correct refusals of 29; declared only in prose or derivable only by rule (typo, unrecorded initials) 0 of 37.

A second seed (7, same structure, different names and coin flips) gave resolver accuracy 73/119 (61.3%), B-cubed F1 0.715, the same 1 wrong merge, 17/17 refusals and 47/48 floor; recall again had 3 wrong merges and 19/21 refusals. The structural failures do not depend on the seed; accuracy moves with how many variants the coins put in `aliases:`.

## What to use and what to avoid

Use `aliases:` frontmatter for every name an entity goes by: nicknames, handles, initials, former names. gbrain resolves those exactly and refuses them when two pages claim the same alias. A name in prose ("Goes by Lenny.") is invisible to the resolver.

Expect typos to be refused, not corrected. gbrain accepts a fuzzy candidate only when it carries the same name tokens, so "Alicia" never becomes "Alice". That keeps wrong merges near zero at the cost of recall, and it is a deliberate design (`sameEntityName` in `src/core/entities/resolve.ts`).

Namesakes are safe to store: two people with the same name stay apart, and mentions of the bare shared name are refused. Disambiguate them with distinct slugs and aliases; the resolver takes no surrounding context.

Cross-source identity groups work as intended: a person linked across two sources resolves to one identity for a caller who can read both, and a caller whose grant covers one source never sees the other source's members or aliases.

Avoid, until the bugs below are fixed: giving a page an alias that is another page's exact name (for example recording a former name that someone else now carries), and `recall({ entity })` with a multi-source grant where two sources may hold different entities under the same slug.

`remember` with a name it cannot resolve stores the fact under a new slug (for example `alie-tern-example`) without creating a page. That is documented ("a fallback name remains DB-only until a real entity page exists"); here it shows up as 31.1% fragmentation instead of refusals.

## gbrain bugs found

### 1. An alias of another page outranks a page's own exact name

- **Where:** `src/core/entities/resolve.ts:65-70` in both 608a174 and f8d1e39 (`resolveEntitySlug`), and the mirror at lines 265-270 (`resolveEntitySlugWithSource`). `tryAliasExact` runs and returns before `findExactBasenameCandidates`, so an unambiguous `page_aliases` hit wins over a live page whose slug basename is exactly the mention.
- **Expected:** "Leonard Linden-Example" resolves to `people/leonard-linden-example`, whose title and slug it is exactly (the exact-lookup floor), or at worst is refused as ambiguous. The search exact-lookup tier (`src/core/search/exact-lookup.ts`) already ranks that page first.
- **Actual:** `{ slug: 'people/leonard-dunmore-example', source: 'alias_exact' }`. `remember` stores the fact on the other person; `recall({ entity })` returns the other person's facts; `resolveExtractedEntitiesForSave` attributes extracted facts to the other person.
- **Probes broken:** the floor-collision exact-name mention on all four resolution surfaces (resolver, recall, remember, resolve_on_save): the 1 wrong merge and the 47/48 floor on each.

Repro (run from a gbrain checkout: `bun repro-floor.ts`):

```ts
import { PGLiteEngine } from './src/core/pglite-engine.ts';
import { importFromContent } from './src/core/import-file.ts';
import { resolveEntitySlugWithSource } from './src/core/entities/resolve.ts';
import { operations } from './src/core/operations.ts';

const engine = new PGLiteEngine();
await engine.connect({});
await engine.initSchema();
// Two different people. The second changed her name; her former name is the first person's current name.
await importFromContent(engine, 'people/jordan-lee-example',
  '---\ntitle: Jordan Lee-Example\ntype: person\n---\n\n# Jordan Lee-Example\n', { noEmbed: true });
await importFromContent(engine, 'people/jordan-smith-example',
  '---\ntitle: Jordan Smith-Example\ntype: person\naliases:\n  - "Jordan Lee-Example"\n---\n\n# Jordan Smith-Example\n\nFormerly Jordan Lee-Example; name changed on 2023-04-10.\n', { noEmbed: true });

console.log('resolver:', await resolveEntitySlugWithSource(engine, 'default', 'Jordan Lee-Example'));
const ctx = { engine, config: {}, logger: console, dryRun: false, remote: false, sourceId: 'default' } as any;
const remember = operations.find(o => o.name === 'remember')!;
const saved = await remember.handler(ctx, { fact: 'Jordan Lee-Example joined the platform team', entity: 'Jordan Lee-Example', provenance: 'repro' }) as any;
console.log('remember stored entity_slug:', saved.entity_slug);
const search = operations.find(o => o.name === 'search')!;
const hits = await search.handler(ctx, { query: 'Jordan Lee-Example', limit: 2 }) as any[];
console.log('search rank 1:', hits[0]?.slug);
process.exit(0);
```

Observed on f8d1e39: `resolver: { slug: "people/jordan-smith-example", source: "alias_exact" }`, `remember stored entity_slug: people/jordan-smith-example`, `search rank 1: people/jordan-lee-example`.

### 2. Federated `recall({ entity })` merges different same-slug entities and drops `source_id`

- **Where:** `src/core/ops/facts.ts:334-341` (f8d1e39 and 608a174): the entity arm resolves the name independently in every granted source and merges all rows newest first. The response projection at `src/core/ops/facts.ts:495-523` omits `source_id`, although the engine's fact rows carry it.
- **Expected:** gbrain's identity key is `(source_id, slug)` (`src/core/entity-identity.ts`), so two pages with the same slug in different sources are different entities unless an identity group links them. A federated entity read should keep them apart: refuse the ambiguous name, or at least label each fact with its source so the caller can tell whose fact it is.
- **Actual:** with grant `['default', 'team']`, `recall({ entity: 'Sam Example' })` (or the slug `people/sam-example`) returns the default Sam's and the team Sam's facts in one list; every row has `source_id: undefined`.
- **Probes broken:** the two ambiguous two-source mentions (name and slug of the same-slug-different-people pair): 2 of recall's 3 wrong merges and its 19/21 correct refusals. Legitimately linked cross-source people are unaffected (both of their two-source name lookups scored correct).

Repro (run from a gbrain checkout: `bun repro-recall.ts`):

```ts
import { PGLiteEngine } from './src/core/pglite-engine.ts';
import { importFromContent } from './src/core/import-file.ts';
import { operations } from './src/core/operations.ts';

const engine = new PGLiteEngine();
await engine.connect({});
await engine.initSchema();
await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('team', 'team', '{}')`);
// Two different people who happen to share a name and slug, one per source. No identity link.
for (const source of ['default', 'team']) {
  await importFromContent(engine, 'people/sam-example',
    `---\ntitle: Sam Example\ntype: person\n---\n\n# Sam Example\n\nThe ${source} Sam.\n`, { noEmbed: true, sourceId: source });
  await engine.insertFact({ fact: `fact about the ${source} Sam`, entity_slug: 'people/sam-example', source: 'note', visibility: 'world', embedding: null }, { source_id: source });
}
const recall = operations.find(o => o.name === 'recall')!;
const ctx = { engine, config: {}, logger: console, dryRun: false, remote: true, sourceId: 'default', auth: { allowedSources: ['default', 'team'] } } as any;
const res = await recall.handler(ctx, { entity: 'Sam Example' }) as any;
console.log(res.facts.map((f: any) => ({ fact: f.fact, entity_slug: f.entity_slug, source_id: f.source_id })));
process.exit(0);
```

Observed on f8d1e39: both "fact about the team Sam" and "fact about the default Sam", each with `entity_slug: "people/sam-example"` and `source_id: undefined`.

## Unsupported and documented limitations (not bugs)

- **Typos** are refused by design: fuzzy candidates must carry the same name tokens (`sameEntityName`). 15/15 typo mentions unresolved, none merged.
- **Names declared only in prose** ("Goes by X.", "Handle: @x", "Formerly X; ...") never reach `page_aliases`; only `aliases:` frontmatter does. Counted as misses under "prose or derived".
- **No context-aware disambiguation.** The resolver takes mention text and a source id only. Namesake mentions are therefore scored as refusals, and a namesake can be selected only by slug or a distinct alias.
- **`remember` fragments instead of refusing.** An unresolved name becomes a database-only slug (documented stub guard).
- **Bare first names resolve by uniqueness alone** (`prefix_expansion`): the sole `people/<name>-*` page wins without confirmation, as the resolver's own comment notes. In this world that was always right (9/9) and refused when two people shared the name (3/3).
- **`entity_identity_list` takes no `source_id`.** A slug seeds groups from any source the caller may read (documented in `listEntityIdentities`), so asking about `default:people/rebecca-flint-example` also returns the team namesake's one-member group. 3 such rows (trusted local, local team, remote two-source), 0 for single-source remote callers. Reported, not scored.
- **Not exercised:** the LLM extractor in front of `resolve_on_save` (extractor-shaped facts are fed directly), import-time mention linking in page bodies (covered by `prose-autolink-precision`), and the `entity_identity.union` link read. The resolver cascade has no embedding or LLM stage, so no stage was skipped for lack of a key.

## Seeds, oracle derivation and errors

- Default seed 20260930, generator `n4-entity-gen/1.0.0`, ledger sha256 `e9fc8e3059f78e6beebecca7ac039cc2c0a8002644f089e9a75d9e1781dd727d`; the receipts also record the gold fingerprint. Second seed 7 reported above. The unit test checks that the oracle agrees with the ledger design on seeds 1 through 60, that the same seed gives the same fingerprint, and that another seed gives a different ledger.
- Oracle rule counts at the default seed: exact slug 26, exact name 24, declared name 39, typo 15, initials 10, first name 9; refusals: 13 ambiguous, 8 no-evidence (4 no-referent names, 4 unreadable-source lookups).
- Presence assertions passed on both runs before scoring: 28/28 pages with their titles, `page_aliases` rows equal to each page's `aliases:` (30 rows for 30 written aliases), 3 identity groups with members and canonical, 28 marker facts.
- Accounting: 740 planned probes, 740 scored, 0 errors (harness, dependency or product) on both runs.

## Reproduce and inspect

```bash
bun install
bun eval/runner/n4-entity-resolution.ts                      # pinned gbrain (608a174), ~13 s
bun eval/runner/n4-entity-resolution.ts --gbrain ../gbrain --output eval/reports/n4-entity-resolution/master   # a gbrain checkout at HEAD, copied overlay
bun eval/runner/n4-entity-resolution.ts --seed 7 --output eval/reports/n4-entity-resolution/seed7
bun eval/generators/n4-entity-gen.ts --seed 20260930 > ledger.json   # the ledger and gold
bun test test/eval/n4-entity-resolution.test.ts
```

No keys, no network after install, $0. Raw receipts with per-mention rows (gold, evidence, each surface's prediction and the resolver stage), identity rows and the full ledger: [receipt-pin.json](2026-09-30-n4-entity-resolution/receipt-pin.json) and [receipt-master.json](2026-09-30-n4-entity-resolution/receipt-master.json).
