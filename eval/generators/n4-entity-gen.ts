/**
 * N4 entity-resolution world generator and solvability oracle.
 *
 * `generateLedger(seed)` builds a deterministic LEDGER: the world as written
 * (entities, the pages that describe them in each source, the aliases and
 * prose declarations on those pages, cross-source identity assertions) plus
 * the mentions a caller will ask gbrain to resolve. Every mention records the
 * entity its author meant (`referent`) and its design: `solvable`, or one of
 * the refusal designs (`ambiguous`, `no-referent`, `unreadable`).
 *
 * `deriveGold(ledger)` is the independent oracle. It never sees the ledger's
 * structured fields for pages: it re-parses the rendered Markdown that the
 * harness imports (title, `aliases:` lines, body declarations) plus the
 * written identity assertions, restricted to the sources the caller may
 * read, and applies an ordered rule list (exact slug, exact name, declared
 * name, one-edit typo, initials, first name). The first rule with a hit
 * decides: one entity is solvable (with the evidence line that proves it),
 * two or more are ambiguous, none is no-evidence. It throws when its
 * verdict disagrees with the ledger's design, so a generator bug cannot
 * become gold. Gold never comes from gbrain output.
 *
 * All names are fictional placeholders: every surname carries "-Example"
 * and every company name ends in "Example".
 */
import { createHash } from 'node:crypto';

export const N4_GENERATOR_VERSION = 'n4-entity-gen/1.0.0';
export const N4_DEFAULT_SEED = 20260930;
export const N4_SOURCES = ['default', 'team'] as const;
export type SourceId = typeof N4_SOURCES[number];

export type MentionFamily =
  | 'exact-slug' | 'exact-name' | 'nickname' | 'typo' | 'handle' | 'initials'
  | 'changed-name' | 'first-name' | 'namesake' | 'no-referent';
export type MentionDesign = 'solvable' | 'ambiguous' | 'no-referent' | 'unreadable';
export type Scenario = 'plain' | 'shared-first-name' | 'namesake' | 'changed-name' | 'floor-collision'
  | 'company' | 'cross-source-linked' | 'same-slug-distinct' | 'negative';

export interface LedgerEntity {
  id: string;
  kind: 'person' | 'company';
  name: string;
  scenario: Scenario;
  former_name: { name: string; changed_on: string } | null;
}

export interface LedgerPage {
  source: SourceId;
  slug: string;
  entity: string;
  type: 'person' | 'company';
  title: string;
  /** Written into the `aliases:` frontmatter list. */
  aliases: string[];
  /** Prose lines in the body that declare another name for the entity. */
  declarations: string[];
  /** Other prose (no names of other entities). */
  body: string;
}

export interface LedgerIdentity {
  entity_id: string;
  entity: string;
  canonical: { source: SourceId; slug: string };
  members: Array<{ source: SourceId; slug: string }>;
}

export interface MentionCaller {
  /** Sources the caller may read. One source = a scoped local caller unless `remote`. */
  sources: SourceId[];
  remote: boolean;
}

export interface LedgerMention {
  id: string;
  text: string;
  family: MentionFamily;
  scenario: Scenario;
  caller: MentionCaller;
  /** The entity the author meant; null when the name belongs to no entity in the world. */
  referent: string | null;
  design: MentionDesign;
  /** For variants: true when the variant is in `aliases:` frontmatter, false when only prose declares it, null otherwise. */
  documented: boolean | null;
  note: string;
}

export interface Ledger {
  generator_version: string;
  seed: number;
  sources: readonly SourceId[];
  entities: LedgerEntity[];
  pages: LedgerPage[];
  identities: LedgerIdentity[];
  mentions: LedgerMention[];
}

// ─── Seeded randomness ─────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], next: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ─── Name pools (fictional) ────────────────────────────────────────────

/** [first name, nickname]. Nicknames never equal another first name's slug prefix. */
const FIRST_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['Alice', 'Ally'], ['Benjamin', 'Benji'], ['Catherine', 'Cat'], ['Daniel', 'Danno'], ['Eleanor', 'Nell'],
  ['Frederick', 'Freddie'], ['Gabriel', 'Gabe'], ['Harriet', 'Hattie'], ['Isabel', 'Izzy'], ['Jonathan', 'Jonty'],
  ['Katherine', 'Kit'], ['Leonard', 'Lenny'], ['Margaret', 'Maggie'], ['Nicholas', 'Nico'], ['Olivia', 'Liv'],
  ['Patrick', 'Paddy'], ['Rebecca', 'Becca'], ['Theodore', 'Theo'], ['Victoria', 'Tori'], ['Zachary', 'Zeke'],
  ['Abigail', 'Abby'], ['Dorothy', 'Dot'], ['Edward', 'Ned'], ['Florence', 'Flo'], ['Gregory', 'Greg'],
  ['Josephine', 'Josie'], ['Lawrence', 'Larry'], ['Matilda', 'Tilly'], ['Nathaniel', 'Nate'], ['Penelope', 'Penny'],
  ['Raymond', 'Ray'], ['Susannah', 'Sukie'], ['Timothy', 'Timbo'], ['Valentina', 'Vala'], ['Winifred', 'Winnie'],
  ['Beatrice', 'Bea'], ['Cornelius', 'Neil'], ['Ophelia', 'Ophy'], ['Rosalind', 'Roz'], ['Silas', 'Sy'],
];

/** Surname stems; the written surname is `<Stem>-Example`. */
const SURNAME_STEMS: readonly string[] = [
  'Harbor', 'Quill', 'Bracken', 'Marsh', 'Stone', 'Fallow', 'Thistle', 'Rook', 'Juniper', 'Vale',
  'Copper', 'Linden', 'Moss', 'Tern', 'Heather', 'Birch', 'Cinder', 'Dunmore', 'Ember', 'Flint',
  'Garnet', 'Hollis', 'Ivory', 'Kestrel', 'Larch', 'Meadow', 'Nettle', 'Oakes', 'Pebble', 'Quarry',
  'Rowan', 'Sable', 'Tamsin', 'Umber', 'Wren', 'Yarrow', 'Alder', 'Briar', 'Corwin', 'Drift',
];

const COMPANY_STEMS: readonly string[] = ['Orbitline', 'Lanternfield', 'Glowmere', 'Northwick', 'Pellucid', 'Quayside'];

const PLAIN_PEOPLE = 14;
const NAMESAKE_PAIRS = 2;
const CHANGED_NAME_PEOPLE = 2;
const CROSS_SOURCE_LINKED = 2;
const NEGATIVE_MENTIONS = 4;

// ─── Helpers shared by generator and oracle (pure string functions) ───

export function slugPart(raw: string): string {
  return raw.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

/** Case, width and whitespace folding for name equality (the oracle's notion of "the same written name"). */
export function normName(raw: string): string {
  return raw.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

export function pageKey(p: { source: string; slug: string }): string {
  return `${p.source}:${p.slug}`;
}

// ─── Rendering (what gbrain actually receives) ─────────────────────────

function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function renderPage(page: LedgerPage): string {
  const lines = ['---', `title: ${yamlQuote(page.title)}`, `type: ${page.type}`];
  if (page.aliases.length) {
    lines.push('aliases:');
    for (const a of page.aliases) lines.push(`  - ${yamlQuote(a)}`);
  }
  lines.push('---', '', `# ${page.title}`, '', page.body);
  if (page.declarations.length) lines.push('', ...page.declarations);
  return lines.join('\n') + '\n';
}

// ─── Generator ─────────────────────────────────────────────────────────

interface PersonSpec {
  id: string;
  first: string;
  nick: string;
  stem: string;
  source: SourceId;
  slug: string;
  scenario: Scenario;
}

export function generateLedger(seed: number = N4_DEFAULT_SEED): Ledger {
  if (!Number.isSafeInteger(seed)) throw new Error(`seed must be an integer, got ${seed}`);
  const next = mulberry32(seed);
  const firsts = shuffle(FIRST_NAMES, next);
  const stems = shuffle(SURNAME_STEMS, next);
  const companies = shuffle(COMPANY_STEMS, next);
  // Every newly taken first name and surname stem stays three or more edits
  // from the ones already taken, so a one-edit typo has exactly one nearby
  // name. Deliberate collisions (shared first names, namesakes) reuse a
  // taken value instead of drawing a new one.
  const takenFirsts: string[] = [];
  const takenStems: string[] = [];
  const draw = <T>(pool: T[], nameOf: (t: T) => string, taken: string[]): T => {
    const at = pool.findIndex(t => taken.every(x => levenshtein(nameOf(t).toLowerCase(), x.toLowerCase()) >= 3));
    if (at < 0) throw new Error('n4 generator: name pool exhausted under the edit-distance margin');
    const [picked] = pool.splice(at, 1);
    taken.push(nameOf(picked));
    return picked;
  };
  const takeFirst = () => draw(firsts, ([f]) => f, takenFirsts);
  const takeStem = () => draw(stems, s => s, takenStems);

  const entities: LedgerEntity[] = [];
  const pages: LedgerPage[] = [];
  const identities: LedgerIdentity[] = [];
  const mentions: LedgerMention[] = [];
  const local = (source: SourceId): MentionCaller => ({ sources: [source], remote: false });
  const mention = (m: Omit<LedgerMention, 'id'>) => mentions.push({ id: `m${String(mentions.length + 1).padStart(3, '0')}`, ...m });
  const personName = (first: string, stem: string) => `${first} ${stem}-Example`;
  const personSlug = (first: string, stem: string, suffix = '') => `people/${slugPart(first)}-${slugPart(stem)}-example${suffix}`;
  const handleOf = (first: string, stem: string) => `@${first[0].toLowerCase()}${slugPart(stem)}`;
  const coin = (p: number) => next() < p;

  /** Delete one interior letter of the first name: a one-edit typo of the full name. */
  const typoOf = (first: string, stem: string) => {
    const i = 1 + Math.floor(next() * (first.length - 2));
    return personName(first.slice(0, i) + first.slice(i + 1), stem);
  };

  // Plain people, two pairs of which share a first name (so the bare first
  // name and the nickname are ambiguous for them).
  const plain: PersonSpec[] = [];
  for (let i = 0; i < PLAIN_PEOPLE; i++) {
    const shared = i >= PLAIN_PEOPLE - 2;
    const [first, nick] = shared ? FIRST_NAMES.find(([f]) => f === plain[i - (PLAIN_PEOPLE - 2)].first)! : takeFirst();
    const stem = takeStem();
    plain.push({ id: `person-${slugPart(first)}-${slugPart(stem)}`, first, nick, stem, source: 'default',
      slug: personSlug(first, stem), scenario: shared ? 'shared-first-name' : 'plain' });
  }
  const sharedFirst = new Set(plain.filter(p => p.scenario === 'shared-first-name').map(p => p.first));
  for (const p of plain) if (sharedFirst.has(p.first)) p.scenario = 'shared-first-name';

  // Changed-name people. The first one's former name is the CURRENT name of
  // plain[2] (a namesake by former name): the floor-collision case.
  const collisionTarget = plain[2];
  const changed: Array<PersonSpec & { formerStem: string; changedOn: string }> = [];
  for (let i = 0; i < CHANGED_NAME_PEOPLE; i++) {
    const collision = i === 0;
    const [first, nick] = collision ? [collisionTarget.first, collisionTarget.nick] as const : takeFirst();
    const formerStem = collision ? collisionTarget.stem : takeStem();
    const stem = takeStem();
    const changedOn = `202${3 + i}-0${4 + i}-1${i}`;
    changed.push({ id: `person-${slugPart(first)}-${slugPart(stem)}`, first, nick, stem, source: 'default',
      slug: personSlug(first, stem), scenario: collision ? 'floor-collision' : 'changed-name', formerStem, changedOn });
  }
  // plain[2] now shares its first name with the collision person.
  collisionTarget.scenario = 'floor-collision';

  // Namesake pairs: two distinct people with the same written name.
  const namesakes: Array<[PersonSpec, PersonSpec]> = [];
  for (let i = 0; i < NAMESAKE_PAIRS; i++) {
    const [first] = takeFirst();
    const stem = takeStem();
    const [orgA, orgB] = i === 0 ? ['acme', 'globex'] : ['initech', 'umbrella'];
    const mk = (org: string): PersonSpec => ({ id: `person-${slugPart(first)}-${slugPart(stem)}-${org}`, first, nick: '', stem,
      source: 'default', slug: personSlug(first, stem, `-${org}`), scenario: 'namesake' });
    namesakes.push([mk(orgA), mk(orgB)]);
  }

  // Cross-source people: one entity, one page in each source, linked by a
  // written identity assertion. The team page carries a team-only nickname.
  const linked: Array<PersonSpec & { teamSlug: string }> = [];
  for (let i = 0; i < CROSS_SOURCE_LINKED; i++) {
    const [first, nick] = takeFirst();
    const stem = takeStem();
    linked.push({ id: `person-${slugPart(first)}-${slugPart(stem)}`, first, nick, stem, source: 'default',
      slug: personSlug(first, stem), scenario: 'cross-source-linked',
      teamSlug: `people/${first[0].toLowerCase()}${slugPart(stem)}-example` });
  }

  // Same slug in both sources, two different people, no identity assertion.
  const [sameFirst] = takeFirst();
  const sameStem = takeStem();
  const sameSlug = personSlug(sameFirst, sameStem);
  const sameIds = { default: `person-${slugPart(sameFirst)}-${slugPart(sameStem)}-default`, team: `person-${slugPart(sameFirst)}-${slugPart(sameStem)}-team` } as const;

  // ── Pages ──
  const personPage = (p: PersonSpec, over: Partial<LedgerPage> = {}): LedgerPage => ({
    source: p.source, slug: p.slug, entity: p.id, type: 'person', title: personName(p.first, p.stem),
    aliases: [], declarations: [], body: `${personName(p.first, p.stem)} is a person in the ${p.source} notes.`, ...over,
  });

  const variantDocs = new Map<string, { nick: boolean; handle: boolean; initials: boolean }>();
  for (const p of plain) {
    // Shared-first-name people both record the nickname as an alias, so the
    // shared alias is visible to a resolver and is a true ambiguity.
    const docs = { nick: p.scenario === 'shared-first-name' ? true : coin(0.5), handle: coin(0.5), initials: coin(0.3) };
    variantDocs.set(p.id, docs);
    const initials = `${p.first[0]}. ${p.stem}-Example`;
    const aliases: string[] = [];
    const declarations: string[] = [];
    (docs.nick ? aliases : declarations).push(docs.nick ? p.nick : `Goes by ${p.nick}.`);
    (docs.handle ? aliases : declarations).push(docs.handle ? handleOf(p.first, p.stem) : `Handle: ${handleOf(p.first, p.stem)}`);
    if (docs.initials) aliases.push(initials);
    pages.push(personPage(p, { aliases, declarations }));
    entities.push({ id: p.id, kind: 'person', name: personName(p.first, p.stem), scenario: p.scenario, former_name: null });
  }
  for (const [i, p] of changed.entries()) {
    const former = personName(p.first, p.formerStem);
    const documented = i === 0 ? true : coin(0.5);
    pages.push(personPage(p, {
      aliases: documented ? [former] : [],
      declarations: [`Formerly ${former}; name changed on ${p.changedOn}.`],
    }));
    entities.push({ id: p.id, kind: 'person', name: personName(p.first, p.stem), scenario: p.scenario, former_name: { name: former, changed_on: p.changedOn } });
  }
  for (const pair of namesakes) {
    for (const p of pair) {
      const org = p.slug.split('-').pop()!;
      pages.push(personPage(p, { aliases: [`@${slugPart(p.first)}-${org}`], body: `${personName(p.first, p.stem)} works at ${org[0].toUpperCase()}${org.slice(1)} Example Corp.` }));
      entities.push({ id: p.id, kind: 'person', name: personName(p.first, p.stem), scenario: 'namesake', former_name: null });
    }
  }
  for (const p of linked) {
    pages.push(personPage(p));
    pages.push(personPage({ ...p, source: 'team', slug: p.teamSlug }, { aliases: [p.nick] }));
    entities.push({ id: p.id, kind: 'person', name: personName(p.first, p.stem), scenario: 'cross-source-linked', former_name: null });
    identities.push({ entity_id: `n4-${slugPart(p.first)}-${slugPart(p.stem)}`, entity: p.id,
      canonical: { source: 'default', slug: p.slug },
      members: [{ source: 'default', slug: p.slug }, { source: 'team', slug: p.teamSlug }] });
  }
  for (const source of N4_SOURCES) {
    const name = personName(sameFirst, sameStem);
    pages.push({ source, slug: sameSlug, entity: sameIds[source], type: 'person', title: name, aliases: [], declarations: [],
      body: `${name} is the ${source === 'default' ? 'designer' : 'accountant'} in the ${source} notes; not the same person as the namesake in the other source.` });
    entities.push({ id: sameIds[source], kind: 'person', name, scenario: 'same-slug-distinct', former_name: null });
  }
  // The team-side person gets a one-member identity group: it must never
  // absorb the default-side page that merely shares its slug.
  identities.push({ entity_id: `n4-${slugPart(sameFirst)}-${slugPart(sameStem)}-team`, entity: sameIds.team,
    canonical: { source: 'team', slug: sameSlug }, members: [{ source: 'team', slug: sameSlug }] });

  const [plainCo, rebrandCo, formerCo] = companies;
  const companySlug = (stem: string) => `companies/${slugPart(stem)}-example`;
  const coName = (stem: string) => `${stem} Example`;
  pages.push({ source: 'default', slug: companySlug(plainCo), entity: `company-${slugPart(plainCo)}`, type: 'company', title: coName(plainCo),
    aliases: [`@${slugPart(plainCo)}`], declarations: [], body: `${coName(plainCo)} is a company in the default notes.` });
  entities.push({ id: `company-${slugPart(plainCo)}`, kind: 'company', name: coName(plainCo), scenario: 'company', former_name: null });
  const rebrandOn = '2023-11-15';
  pages.push({ source: 'default', slug: companySlug(rebrandCo), entity: `company-${slugPart(rebrandCo)}`, type: 'company', title: coName(rebrandCo),
    aliases: [coName(formerCo)], declarations: [`Formerly ${coName(formerCo)}; rebranded on ${rebrandOn}.`], body: `${coName(rebrandCo)} is a company in the default notes.` });
  entities.push({ id: `company-${slugPart(rebrandCo)}`, kind: 'company', name: coName(rebrandCo), scenario: 'company', former_name: { name: coName(formerCo), changed_on: rebrandOn } });

  // ── Mentions ──
  const floorPair = (p: { slug: string; entity: string; source: SourceId; title: string }, scenario: Scenario, caller = local(p.source), design: MentionDesign = 'solvable') => {
    mention({ text: p.slug, family: 'exact-slug', scenario, caller, referent: p.entity, design, documented: null, note: 'exact slug of the page' });
  };
  const pageOf = (id: string, source: SourceId = 'default') => pages.find(p => p.entity === id && p.source === source)!;
  const firstNameCount = (first: string) => pages.filter(p => p.source === 'default' && p.type === 'person' && p.title.split(' ')[0] === first).length;

  for (const p of plain) {
    const page = pageOf(p.id);
    const docs = variantDocs.get(p.id)!;
    floorPair(page, p.scenario);
    mention({ text: page.title, family: 'exact-name', scenario: p.scenario, caller: local('default'), referent: p.id, design: 'solvable', documented: null,
      note: p === collisionTarget ? `exact canonical name; also the former name (alias) of ${changed[0].id}` : 'exact canonical name' });
    // The second person of a shared-first-name pair would repeat the same
    // ambiguous nickname and first-name probes; only the first one asks.
    const repeat = plain.findIndex(o => o.first === p.first) !== plain.indexOf(p);
    if (!repeat) mention({ text: p.nick, family: 'nickname', scenario: p.scenario, caller: local('default'), referent: p.id,
      design: p.scenario === 'shared-first-name' ? 'ambiguous' : 'solvable', documented: docs.nick,
      note: p.scenario === 'shared-first-name' ? 'nickname recorded as an alias by two people' : docs.nick ? 'nickname in aliases' : 'nickname declared in prose only' });
    mention({ text: typoOf(p.first, p.stem), family: 'typo', scenario: p.scenario, caller: local('default'), referent: p.id, design: 'solvable', documented: false,
      note: 'one deleted letter in the first name' });
    mention({ text: handleOf(p.first, p.stem), family: 'handle', scenario: p.scenario, caller: local('default'), referent: p.id, design: 'solvable', documented: docs.handle,
      note: docs.handle ? 'handle in aliases' : 'handle declared in prose only' });
    mention({ text: `${p.first[0]}. ${p.stem}-Example`, family: 'initials', scenario: p.scenario, caller: local('default'), referent: p.id, design: 'solvable', documented: docs.initials,
      note: docs.initials ? 'initials form in aliases' : 'first initial plus surname, not recorded' });
    const unique = firstNameCount(p.first) === 1;
    if (!repeat) mention({ text: p.first, family: 'first-name', scenario: p.scenario, caller: local('default'), referent: p.id, design: unique ? 'solvable' : 'ambiguous', documented: null,
      note: unique ? 'bare first name, unique among people' : 'bare first name shared by two people' });
  }
  for (const p of changed) {
    const page = pageOf(p.id);
    floorPair(page, p.scenario);
    mention({ text: page.title, family: 'exact-name', scenario: p.scenario, caller: local('default'), referent: p.id, design: 'solvable', documented: null, note: 'current name after the change' });
    if (p.scenario === 'changed-name') {
      mention({ text: personName(p.first, p.formerStem), family: 'changed-name', scenario: p.scenario, caller: local('default'), referent: p.id, design: 'solvable',
        documented: page.aliases.length > 0, note: `former name, changed on ${p.changedOn}${page.aliases.length ? ' (in aliases)' : ' (prose only)'}` });
    }
  }
  for (const pair of namesakes) {
    const [a, b] = pair;
    for (const p of pair) {
      const page = pageOf(p.id);
      floorPair(page, 'namesake');
      mention({ text: page.aliases[0], family: 'handle', scenario: 'namesake', caller: local('default'), referent: p.id, design: 'solvable', documented: true, note: 'disambiguating handle in aliases' });
    }
    const name = personName(a.first, a.stem);
    mention({ text: name, family: 'namesake', scenario: 'namesake', caller: local('default'), referent: a.id, design: 'ambiguous', documented: null, note: `full name shared by ${a.id} and ${b.id}` });
    mention({ text: a.first, family: 'namesake', scenario: 'namesake', caller: local('default'), referent: b.id, design: 'ambiguous', documented: null, note: 'bare first name shared by both namesakes' });
    mention({ text: `${a.first[0]}. ${a.stem}-Example`, family: 'namesake', scenario: 'namesake', caller: local('default'), referent: a.id, design: 'ambiguous', documented: null, note: 'initials form shared by both namesakes' });
  }
  const both: MentionCaller = { sources: ['default', 'team'], remote: true };
  const remoteDefault: MentionCaller = { sources: ['default'], remote: true };
  for (const p of linked) {
    const team = pageOf(p.id, 'team');
    const name = personName(p.first, p.stem);
    floorPair(team, 'cross-source-linked');
    mention({ text: name, family: 'exact-name', scenario: 'cross-source-linked', caller: local('team'), referent: p.id, design: 'solvable', documented: null, note: 'exact name inside the team source' });
    mention({ text: p.nick, family: 'nickname', scenario: 'cross-source-linked', caller: local('team'), referent: p.id, design: 'solvable', documented: true, note: 'team-only alias, team caller' });
    mention({ text: p.nick, family: 'nickname', scenario: 'cross-source-linked', caller: local('default'), referent: p.id, design: 'unreadable', documented: true, note: 'team-only alias; the default caller cannot read the team page' });
    mention({ text: name, family: 'exact-name', scenario: 'cross-source-linked', caller: both, referent: p.id, design: 'solvable', documented: null, note: 'one person with a page in each source, linked by an identity assertion' });
    mention({ text: p.nick, family: 'nickname', scenario: 'cross-source-linked', caller: both, referent: p.id, design: 'solvable', documented: true, note: 'team-only alias, caller granted both sources' });
    mention({ text: p.nick, family: 'nickname', scenario: 'cross-source-linked', caller: remoteDefault, referent: p.id, design: 'unreadable', documented: true, note: 'team-only alias; remote grant covers only default' });
  }
  {
    const name = personName(sameFirst, sameStem);
    for (const source of N4_SOURCES) {
      mention({ text: name, family: 'exact-name', scenario: 'same-slug-distinct', caller: local(source), referent: sameIds[source], design: 'solvable', documented: null, note: `same name and slug exist in the other source for a different person; ${source} caller` });
      mention({ text: sameSlug, family: 'exact-slug', scenario: 'same-slug-distinct', caller: local(source), referent: sameIds[source], design: 'solvable', documented: null, note: `slug shared with a different person in the other source; ${source} caller` });
    }
    mention({ text: name, family: 'namesake', scenario: 'same-slug-distinct', caller: both, referent: sameIds.default, design: 'ambiguous', documented: null, note: 'two different people with the same name and slug in two sources, no identity assertion' });
    mention({ text: sameSlug, family: 'namesake', scenario: 'same-slug-distinct', caller: both, referent: sameIds.team, design: 'ambiguous', documented: null, note: 'same slug in two sources is not identity' });
  }
  {
    const co = pageOf(`company-${slugPart(plainCo)}`);
    floorPair(co, 'company');
    mention({ text: co.title, family: 'exact-name', scenario: 'company', caller: local('default'), referent: co.entity, design: 'solvable', documented: null, note: 'exact company name' });
    mention({ text: co.aliases[0], family: 'handle', scenario: 'company', caller: local('default'), referent: co.entity, design: 'solvable', documented: true, note: 'company handle in aliases' });
    const i = 2 + Math.floor(next() * (plainCo.length - 3));
    mention({ text: coName(plainCo.slice(0, i) + plainCo.slice(i + 1)), family: 'typo', scenario: 'company', caller: local('default'), referent: co.entity, design: 'solvable', documented: false, note: 'one deleted letter in the company name' });
    const rb = pageOf(`company-${slugPart(rebrandCo)}`);
    floorPair(rb, 'company');
    mention({ text: rb.title, family: 'exact-name', scenario: 'company', caller: local('default'), referent: rb.entity, design: 'solvable', documented: null, note: 'current company name after a rebrand' });
    mention({ text: coName(formerCo), family: 'changed-name', scenario: 'company', caller: local('default'), referent: rb.entity, design: 'solvable', documented: true, note: `former company name, rebranded on ${rebrandOn} (in aliases)` });
  }
  // Negative controls: names that belong to nobody in the world.
  const farFromEveryTitle = (name: string) => pages.every(p => levenshtein(normName(name), normName(p.title)) >= 3);
  for (let i = 0; i < NEGATIVE_MENTIONS; i++) {
    const base = plain[i];
    const text = i % 2 === 0
      ? personName(takeFirst()[0], takeStem())
      : personName(FIRST_NAMES.map(([f]) => f).find(f => f[0] !== base.first[0] && farFromEveryTitle(personName(f, base.stem)))!, base.stem);
    mention({ text, family: 'no-referent', scenario: 'negative', caller: local('default'), referent: null, design: 'no-referent', documented: null,
      note: i % 2 === 0 ? 'a name no page carries' : `a different first name with the surname of ${base.id}: possibly a relative, not the same person` });
  }

  return { generator_version: N4_GENERATOR_VERSION, seed, sources: N4_SOURCES, entities, pages, identities, mentions };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/** sha256 over the canonical JSON of the whole ledger. */
export function ledgerFingerprint(ledger: Ledger): string {
  return createHash('sha256').update(canonical(ledger)).digest('hex');
}

// ─── Oracle ─────────────────────────────────────────────────────────────

export type OracleRule = 'exact-slug' | 'exact-name' | 'declared-name' | 'typo' | 'initials' | 'first-name';

export type Gold =
  | { kind: 'entity'; entity: string; pages: string[]; rule: OracleRule; evidence: string }
  | { kind: 'refuse'; reason: 'ambiguous' | 'no-evidence'; candidates: string[]; rule: OracleRule | null };

/** What the oracle reads back from one rendered page: nothing but the written text. */
export interface WrittenPage {
  key: string;
  source: SourceId;
  slug: string;
  title: string;
  type: string;
  aliases: string[];
  /** [declared name, the line it came from]. */
  declared: Array<[string, string]>;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"')) return JSON.parse(t) as string;
  return t;
}

/** Parse the Markdown `renderPage` wrote. Independent of the ledger's structured fields. */
export function parseWrittenPage(source: SourceId, slug: string, markdown: string): WrittenPage {
  const [, fm = '', body = ''] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(markdown) ?? [];
  let title = '';
  let type = '';
  const aliases: string[] = [];
  let inAliases = false;
  for (const line of fm.split('\n')) {
    if (/^aliases:\s*$/.test(line)) { inAliases = true; continue; }
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (inAliases && item) { aliases.push(unquote(item[1])); continue; }
    inAliases = false;
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv?.[1] === 'title') title = unquote(kv[2]);
    if (kv?.[1] === 'type') type = kv[2].trim();
  }
  const declared: Array<[string, string]> = [];
  for (const line of body.split('\n')) {
    const nick = /^Goes by (.+)\.$/.exec(line);
    const handle = /^Handle: (@\S+)$/.exec(line);
    const former = /^Formerly (.+?); (?:name changed|rebranded) on \d{4}-\d{2}-\d{2}\.$/.exec(line);
    const name = nick?.[1] ?? handle?.[1] ?? former?.[1];
    if (name) declared.push([name, line]);
  }
  return { key: pageKey({ source, slug }), source, slug, title, type, aliases, declared };
}

/**
 * Oracle verdict for one mention over the pages the caller can read.
 * `groupOf` maps a page key to its written identity group (or the page key
 * itself), so pages linked by an identity assertion count as one entity.
 */
export function oracleResolve(
  text: string,
  readable: readonly WrittenPage[],
  groupOf: (key: string) => string,
): { rule: OracleRule | null; hits: Array<{ page: WrittenPage; evidence: string }> } {
  const q = normName(text);
  const people = readable.filter(p => p.type === 'person');
  const rules: Array<[OracleRule, (p: WrittenPage) => string | null]> = [
    ['exact-slug', p => (p.slug === text.trim() ? `slug ${p.slug}` : null)],
    ['exact-name', p => (normName(p.title) === q ? `title: ${p.title}` : null)],
    ['declared-name', p => {
      const alias = p.aliases.find(a => normName(a) === q);
      if (alias !== undefined) return `aliases: - ${alias}`;
      return p.declared.find(([n]) => normName(n) === q)?.[1] ?? null;
    }],
    ['typo', p => (q.includes(' ') && levenshtein(q, normName(p.title)) === 1 ? `title: ${p.title}` : null)],
    ['initials', p => {
      const m = /^([a-z])\. (.+)$/.exec(q);
      if (!m || p.type !== 'person') return null;
      const [first, ...rest] = normName(p.title).split(' ');
      return first[0] === m[1] && rest.join(' ') === m[2] ? `title: ${p.title}` : null;
    }],
    ['first-name', p => (!q.includes(' ') && p.type === 'person' && normName(p.title).split(' ')[0] === q ? `title: ${p.title}` : null)],
  ];
  for (const [rule, test] of rules) {
    const pool = rule === 'initials' || rule === 'first-name' ? people : readable;
    const hits = pool.flatMap(page => {
      const evidence = test(page);
      return evidence === null ? [] : [{ page, evidence }];
    });
    if (rule === 'typo' && hits.length > 0) {
      // A typo is solvable only with a margin: no other readable name within two edits.
      const near = readable.filter(p => levenshtein(q, normName(p.title)) <= 2 && !hits.some(h => groupOf(h.page.key) === groupOf(p.key)));
      if (near.length) return { rule, hits: [...hits, ...near.map(page => ({ page, evidence: `title: ${page.title}` }))] };
    }
    if (hits.length) return { rule, hits };
  }
  return { rule: null, hits: [] };
}

/**
 * Derive gold for every mention from the written pages and identity
 * assertions. Throws when the oracle disagrees with the ledger's design.
 */
export function deriveGold(ledger: Ledger): Map<string, Gold> {
  const written = ledger.pages.map(p => ({ written: parseWrittenPage(p.source, p.slug, renderPage(p)), entity: p.entity }));
  const entityOfKey = new Map(written.map(w => [w.written.key, w.entity]));
  const group = new Map<string, string>();
  for (const id of ledger.identities) for (const m of id.members) group.set(pageKey(m), `identity:${id.entity_id}`);
  const groupOf = (key: string) => group.get(key) ?? key;

  const gold = new Map<string, Gold>();
  for (const m of ledger.mentions) {
    const readable = written.filter(w => m.caller.sources.includes(w.written.source)).map(w => w.written);
    const { rule, hits } = oracleResolve(m.text, readable, groupOf);
    const groups = [...new Set(hits.map(h => groupOf(h.page.key)))];
    let g: Gold;
    if (groups.length === 1) {
      const entity = entityOfKey.get(hits[0].page.key)!;
      g = { kind: 'entity', entity, pages: [...new Set(hits.map(h => h.page.key))].sort(), rule: rule!, evidence: hits[0].evidence };
    } else {
      g = { kind: 'refuse', reason: groups.length > 1 ? 'ambiguous' : 'no-evidence', candidates: [...new Set(hits.map(h => h.page.key))].sort(), rule };
    }
    const expectRefuse = m.design !== 'solvable';
    if (expectRefuse !== (g.kind === 'refuse')) {
      throw new Error(`oracle disagrees with ledger design for ${m.id} "${m.text}" (${m.design}): ${JSON.stringify(g)}`);
    }
    if (g.kind === 'entity' && g.entity !== m.referent) {
      throw new Error(`oracle resolved ${m.id} "${m.text}" to ${g.entity}, ledger referent is ${m.referent}`);
    }
    if (g.kind === 'refuse' && m.design === 'ambiguous' && g.reason !== 'ambiguous') {
      throw new Error(`ledger marks ${m.id} "${m.text}" ambiguous, oracle found ${g.reason}`);
    }
    gold.set(m.id, g);
  }
  return gold;
}

/** Page key -> ledger entity, for the evaluator. */
export function entityByPage(ledger: Ledger): Map<string, string> {
  return new Map(ledger.pages.map(p => [pageKey(p), p.entity]));
}

if (import.meta.main) {
  const at = process.argv.indexOf('--seed');
  const seed = at >= 0 ? Number(process.argv[at + 1]) : N4_DEFAULT_SEED;
  const ledger = generateLedger(seed);
  const gold = deriveGold(ledger);
  process.stdout.write(JSON.stringify({ fingerprint: ledgerFingerprint(ledger), ledger, gold: Object.fromEntries(gold) }, null, 2) + '\n');
}
