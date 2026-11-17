/**
 * BrainBench person-dedupe: are really different people kept apart?
 * (registry id `person-dedupe`)
 *
 * Question: when a duplicate-people finder reads a brain of person pages, how
 * often does it put two pages of different people in one group (the
 * headline, the false-merge rate), and how many real duplicates does it find?
 *
 * World: eval/generators/person-dedupe-gen.ts writes person pages in two
 * sources with a ledger of which person each page belongs to. Families cover
 * namesakes (alone, same company, same city, same slug across sources, behind
 * a team address on 2, 5 or 6 pages, a family email, a placeholder email),
 * Jr suffixes, assistants and shared mailboxes, lookalike names, a
 * transitive chain, and the same person written differently.
 *
 * Systems, all scored by the same scorer:
 *   reference matchers   deterministic rules written here (exact name, folded
 *                        name, shared email, email plus folded name, email
 *                        plus nickname-aware name). Controls that show what
 *                        each rule costs; not gbrain.
 *   contract-emulator    gbrain's documented finder (finder contract schema 1:
 *                        org drive research/entity-resolution/finder-contract.md)
 *                        reimplemented here from its prose and passed through
 *                        the finder's JSON shape. A stand-in until the finder
 *                        ships; never reported as gbrain.
 *   finder               `--finder-json <file>`: the output of
 *                        `gbrain dedupe --preview --json` on this world
 *                        (written with `--write-world <dir>`), labelled
 *                        `--finder-build <tag or sha>`.
 *
 * A finder-shaped output is scored under two selections: auto-link (kind
 * cross_source and class clean, what automatic linking would join) and
 * proposed (every group except conflict, which is a review list and never a
 * merge), plus one selection per class. Groups are closed transitively, since
 * links chain. Headline: designed different-people pairs placed in one
 * component, over all designed different-people pairs, with a Wilson 95%
 * interval. Then pairwise precision and recall over every page pair, B-cubed,
 * and the false-merge rate per family, with each false merge attributed to
 * the groups that joined it.
 *
 * Usage: bun eval/runner/person-dedupe.ts [--seed N] [--per-family N] [--output DIR]
 *          [--write-world DIR] [--finder-json FILE --finder-build LABEL] [--json]
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  FAMILIES, NICKNAMES, PERSON_DEDUPE_DEFAULT_PER_FAMILY, PERSON_DEDUPE_DEFAULT_SEED, PERSON_DEDUPE_GENERATOR_VERSION,
  deriveGold, generateLedger, ledgerFingerprint, renderPage, writtenPages,
  type DesignedPair, type Ledger, type WrittenPage,
} from '../generators/person-dedupe-gen.ts';
import { gbrainPin } from './gbrain-version.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, noModelSpend, productIdentity, receiptPath, sourceTreeIdentity, writeReceipt, type Receipt } from './receipt.ts';

export const CATEGORY = 'person-dedupe';
export const RECEIPT_STEM = 'person-dedupe';

/** Runner targets for the headline selection: no designed false merge, and every plain duplicate (same name, same email, two sources) found. */
export const TARGETS = { false_merges: 0, same_exact_recall: 1 } as const;

export const FINDER_KINDS = ['cross_source', 'in_source', 'conflict', 'thin'] as const;
export const FINDER_CLASSES = ['clean', 'likely', 'weak', 'thin', 'conflict'] as const;
const CROWDED_AFTER = 5;
const PLACEHOLDERS = new Set(['unknown', 'none', 'null', 'n/a', 'na', 'tbd', 'todo', '-', '?']);

// ─── Name keys ────────────────────────────────────────────────────────────

/** The finder's strict fold: NFKD, combining marks removed, lowercase, punctuation to spaces, spaces collapsed. Every token kept. */
export function strictFold(title: string): string {
  return title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

const HONORIFICS = new Set(['dr', 'mr', 'mrs', 'ms', 'mx', 'prof', 'sir', 'dame', 'mayor', 'ceo', 'cto', 'cfo']);

/** The finder's variant fold: the strict fold without leading honorifics or job titles. Name suffixes stay. */
export function variantFold(title: string): string {
  const parts = strictFold(title).split(' ');
  while (parts.length > 1 && HONORIFICS.has(parts[0])) parts.shift();
  return parts.join(' ');
}

/** "Exactly the same name" as a plain reading: trimmed, spaces collapsed, case folded; accents and punctuation still count. */
export function exactNameKey(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}

const NICK = new Map<string, string>();
for (const [formal, nick] of NICKNAMES) { NICK.set(formal.toLowerCase(), formal.toLowerCase()); NICK.set(nick.toLowerCase(), formal.toLowerCase()); }

/** Strict fold with the given name mapped to its formal form when the nickname table knows it. */
export function nicknameKey(title: string): string {
  const parts = strictFold(title).split(' ');
  if (parts.length >= 2) parts[0] = NICK.get(parts[0]) ?? parts[0];
  return parts.join(' ');
}

/** An email the finder would use as a key, or null for a placeholder. */
export function emailKey(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (!v || /^0+$/.test(v) || PLACEHOLDERS.has(v) || v.length > 320 || !v.includes('@')) return null;
  return v;
}

// ─── Groups ───────────────────────────────────────────────────────────────

export interface Group { members: string[]; kind: string; class: string; rules: string[] }

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x) ?? x;
    if (p !== x) { p = this.find(p); this.parent.set(x, p); }
    return p;
  }
  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

const sourceOf = (key: string) => key.slice(0, key.indexOf(':'));
const kindOf = (members: readonly string[]) => new Set(members.map(sourceOf)).size > 1 ? 'cross_source' : 'in_source';

function bucket<K>(pages: readonly WrittenPage[], keysOf: (p: WrittenPage) => K[]): Map<K, WrittenPage[]> {
  const m = new Map<K, WrittenPage[]>();
  for (const p of pages) for (const k of new Set(keysOf(p))) m.set(k, [...(m.get(k) ?? []), p]);
  return m;
}

/** Connected components of the pairs `linked` accepts, among pages that share a candidate block. */
function linkGroups(pages: readonly WrittenPage[], linked: (a: WrittenPage, b: WrittenPage) => boolean, rule: string): Group[] {
  const uf = new UnionFind();
  const blocks = [...bucket(pages, p => p.emails.map(e => `e:${e.trim().toLowerCase()}`).concat([`n:${strictFold(p.title).split(' ').at(-1)}`])).values()];
  const seen = new Set<string>();
  for (const block of blocks) for (let i = 0; i < block.length; i++) for (let j = i + 1; j < block.length; j++) {
    const a = block[i], b = block[j];
    const k = a.key < b.key ? `${a.key}|${b.key}` : `${b.key}|${a.key}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (linked(a, b)) uf.union(a.key, b.key);
  }
  const comps = new Map<string, string[]>();
  for (const p of pages) { const r = uf.find(p.key); comps.set(r, [...(comps.get(r) ?? []), p.key]); }
  return [...comps.values()].filter(m => m.length > 1).map(m => ({ members: m.sort(), kind: kindOf(m), class: 'clean', rules: [rule] }));
}

const sharesEmail = (a: WrittenPage, b: WrittenPage) => a.emails.some(e => emailKey(e) !== null && b.emails.some(f => emailKey(f) === emailKey(e)));

export interface Matcher { id: string; description: string; run(pages: readonly WrittenPage[]): Group[] }

export const REFERENCE_MATCHERS: readonly Matcher[] = [
  { id: 'exact-name', description: 'same name (case and spacing ignored), nothing else', run: ps => linkGroups(ps, (a, b) => exactNameKey(a.title) === exactNameKey(b.title), 'exact-name') },
  { id: 'folded-name', description: 'same strict-folded name, nothing else', run: ps => linkGroups(ps, (a, b) => strictFold(a.title) === strictFold(b.title), 'folded-name') },
  { id: 'shared-email', description: 'any shared email (placeholders dropped), whatever the names', run: ps => linkGroups(ps, sharesEmail, 'shared-email') },
  { id: 'email+folded-name', description: 'a shared email and the same strict-folded name, with no crowding or one-per-source checks', run: ps => linkGroups(ps, (a, b) => sharesEmail(a, b) && strictFold(a.title) === strictFold(b.title), 'email+folded-name') },
  { id: 'email+nickname-name', description: 'a shared email and the same name after folding and mapping nicknames to formal names', run: ps => linkGroups(ps, (a, b) => sharesEmail(a, b) && nicknameKey(a.title) === nicknameKey(b.title), 'email+nickname-name') },
];

/**
 * What decides `clean`, as switches. The approved rule is the finder
 * contract's; the others are the variants proposed after the first stress
 * result, and each arm runs with and without a check of the union.
 */
export interface CleanRule {
  /** An email whose local part reads as a role or household address never makes clean. */
  noRole?: boolean;
  /** ...unless every page with an email at that domain has one strict-folded name (one person's own domain). */
  singlePersonDomain?: boolean;
  /** The pages must also share a value of a second key type. */
  twoKeyTypes?: boolean;
  /** Two members that both carry a single-valued key type (LinkedIn, GitHub) must share its value; otherwise the group is a conflict, in every class. Email is left out: one person often has several. */
  noContradiction?: boolean;
  /** An exclusive id (LinkedIn, GitHub) makes clean on its own; an email needs a second signal of another kind: a shared exclusive id or the same employer. */
  keyTypeSplit?: boolean;
  /** With keyTypeSplit: drop the employer path, so an email never makes clean; it waits on the confirm list. */
  noEmployerSignal?: boolean;
  /** Clean groups that share a page are checked as one union: one page per source, and every pair in it shares a key. A union that fails demotes all its clean groups to likely. */
  unionCheck?: boolean;
}

const BASE_ARMS: Record<string, { rule: CleanRule; text: string }> = {
  '1': { rule: {}, text: 'approved rule: one shared key value that only the group carries, the same strict-folded name, one page per source' },
  '2': { rule: { noRole: true }, text: 'arm 1, but a role or household email (team, support, hello, family and similar words) never makes clean' },
  '2b': { rule: { keyTypeSplit: true, noRole: true, noContradiction: true }, text: 'key-type split: LinkedIn or GitHub plus the same name links; an email needs a shared LinkedIn or GitHub or the same employer as well; role emails never; no contradicting key' },
  '3': { rule: { twoKeyTypes: true }, text: 'arm 1, and the pages also share a value of a second key type' },
  '4': { rule: { noContradiction: true }, text: 'arm 1, and no contradicting LinkedIn or GitHub (any class)' },
  '5': { rule: { noRole: true, noContradiction: true }, text: 'arms 2 and 4 together' },
  '6': { rule: { noRole: true, noContradiction: true, singlePersonDomain: true }, text: 'arm 5, but a role email still counts when its domain belongs to one person in the brain' },
  '7': { rule: { keyTypeSplit: true, noEmployerSignal: true, noContradiction: true, unionCheck: true }, text: 'arm 2b without the employer path, with the union check: only a shared LinkedIn or GitHub plus the same name links; an email never links by itself and goes to the confirm list; no contradicting key' },
};

export const ARMS: Record<string, { rule: CleanRule; text: string }> = Object.fromEntries(Object.entries(BASE_ARMS).flatMap(([id, a]) => a.rule.unionCheck ? [[id, a]] : [
  [id, a],
  [`${id}+union`, { rule: { ...a.rule, unionCheck: true }, text: `${a.text}; plus a check of the union before linking` }],
]));

/** Email local-part words that mark a role or household address rather than one person. */
export const ROLE_WORDS = new Set(['team', 'support', 'info', 'hello', 'contact', 'office', 'admin', 'sales', 'help', 'hr', 'billing', 'accounts', 'family', 'home', 'household', 'reception', 'frontdesk', 'enquiries', 'inquiries', 'press', 'jobs', 'careers', 'ops', 'noreply', 'mail']);

export function isRoleEmail(key: string): boolean {
  const local = key.slice(0, key.indexOf('@'));
  return local.split(/[^a-z]+/).some(w => ROLE_WORDS.has(w));
}

/** The keys a page carries, as `<type>:<value>`, normalized as the finder contract says; placeholders dropped. */
export function pageKeys(p: WrittenPage): string[] {
  const out = p.emails.map(emailKey).filter((k): k is string => k !== null).map(k => `email:${k}`);
  const li = p.linkedin?.trim().toLowerCase().match(/\/(in|company)\/[^/?#]+/)?.[0];
  if (li) out.push(`linkedin:${li}`);
  const gh = p.github?.trim().toLowerCase().replace(/^@/, '').replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\/$/, '');
  if (gh && !PLACEHOLDERS.has(gh)) out.push(`github:${gh}`);
  return [...new Set(out)];
}

const typeOf = (k: string) => k.slice(0, k.indexOf(':'));
const EXCLUSIVE = new Set(['linkedin', 'github']);

/**
 * gbrain's finder as its contract (schema 1) describes it, for person pages
 * with email, LinkedIn and GitHub keys: clean, likely, weak and conflict.
 * Slug-shape and thin rules have no case in this world. `rule` swaps the test
 * that decides clean. Where the contract leaves a choice open, the choice is
 * written next to it.
 */
export function emulateFinder(pages: readonly WrittenPage[], rule: CleanRule = {}): FinderOutput {
  const byKey = new Map(pages.map(p => [p.key, p]));
  const keysOf = new Map(pages.map(p => [p.key, pageKeys(p)]));
  const holders = bucket(pages, p => keysOf.get(p.key)!);
  const crowdedKeys = new Set([...holders].filter(([, ps]) => ps.length > CROWDED_AFTER).map(([k]) => k));
  const usable = (key: string) => keysOf.get(key)!.filter(k => !crowdedKeys.has(k));
  const shareKey = (a: string, b: string) => usable(a).some(k => usable(b).includes(k));
  const domainNames = new Map<string, Set<string>>();
  for (const p of pages) for (const k of keysOf.get(p.key)!) if (typeOf(k) === 'email') {
    const d = k.slice(k.indexOf('@') + 1);
    domainNames.set(d, new Set([...(domainNames.get(d) ?? []), strictFold(p.title)]));
  }
  const contradicts = (members: readonly string[]) => {
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
      const a = usable(members[i]), b = usable(members[j]);
      for (const t of new Set(a.map(typeOf))) if (t !== 'email' && b.some(k => typeOf(k) === t) && !a.some(k => typeOf(k) === t && b.includes(k))) return true;
    }
    return false;
  };
  const groups: Group[] = [];
  const add = (members: string[], kind: string, cls: string, why: string) => {
    members = [...new Set(members)].sort();
    if (rule.noContradiction && cls !== 'conflict' && contradicts(members)) { kind = 'conflict'; cls = 'conflict'; }
    const same = groups.find(g => g.kind === kind && g.members.join('\n') === members.join('\n'));
    const rank = (c: string) => FINDER_CLASSES.indexOf(c as typeof FINDER_CLASSES[number]);
    if (same) { if (!same.rules.includes(why)) same.rules.push(why); if (rank(cls) < rank(same.class)) same.class = cls; return; }
    groups.push({ members, kind, class: cls, rules: [why] });
  };
  const keyed = new Set<string>();
  for (const [key, ps] of holders) {
    if (crowdedKeys.has(key) || ps.length < 2) continue;
    const members = ps.map(p => p.key);
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) keyed.add([members[i], members[j]].sort().join('|'));
    const type = typeOf(key), value = key.slice(type.length + 1);
    const why = `shared_key:${type}`;
    if (new Set(ps.map(p => variantFold(p.title))).size > 1) { add(members, 'conflict', 'conflict', why); continue; }
    const shared = usable(members[0]).filter(k => members.every(m => usable(m).includes(k)));
    const sharedTypes = new Set(shared.map(typeOf));
    const role = type === 'email' && isRoleEmail(value) && !(rule.singlePersonDomain && domainNames.get(value.slice(value.indexOf('@') + 1))!.size === 1);
    const employer = ps.every(p => p.company !== null && p.company === ps[0].company);
    const clean = new Set(ps.map(p => strictFold(p.title))).size === 1
      && new Set(ps.map(p => p.source)).size === ps.length && kindOf(members) === 'cross_source'
      && !(rule.noRole && role)
      && !(rule.twoKeyTypes && sharedTypes.size < 2)
      && !(rule.keyTypeSplit && !EXCLUSIVE.has(type) && !shared.some(k => EXCLUSIVE.has(typeOf(k))) && (rule.noEmployerSignal || !employer));
    add(members, kindOf(members), clean ? 'clean' : 'likely', why);
  }
  for (const [, ps] of bucket(pages, p => [strictFold(p.title)])) {
    if (new Set(ps.map(p => p.source)).size < 2) continue;
    // Choice: a weak group is the whole same-name bucket across sources, unless every pair in it already shares a key.
    const members = ps.map(p => p.key);
    let allKeyed = true;
    for (let i = 0; i < members.length && allKeyed; i++) for (let j = i + 1; j < members.length; j++) if (!keyed.has([members[i], members[j]].sort().join('|'))) { allKeyed = false; break; }
    if (!allKeyed) add(members, 'cross_source', 'weak', 'strict_name');
  }
  if (rule.unionCheck) {
    const clean = groups.filter(g => g.kind === 'cross_source' && g.class === 'clean');
    const uf = new UnionFind();
    for (const g of clean) for (const m of g.members.slice(1)) uf.union(g.members[0], m);
    const unions = new Map<string, Set<string>>();
    for (const g of clean) for (const m of g.members) { const r = uf.find(m); unions.set(r, new Set([...(unions.get(r) ?? []), m])); }
    for (const [root, set] of unions) {
      const members = [...set];
      const perSource = new Set(members.map(m => byKey.get(m)!.source)).size === members.length;
      const clique = members.every((a, i) => members.slice(i + 1).every(b => shareKey(a, b)));
      if (!perSource || !clique) for (const g of clean) if (uf.find(g.members[0]) === root) g.class = 'likely';
    }
  }
  return toFinderOutput(groups, crowdedKeys.size);
}

// ─── The finder's JSON shape ──────────────────────────────────────────────

export interface FinderOutput {
  schema_version: number;
  groups: Array<{ id: string; kind: string; class: string; members: Array<{ source_id: string; slug: string }>; evidence: Array<{ matcher: string; rule: string; key?: string; field?: string }> }>;
  counts: { by_kind: Record<string, number>; by_class: Record<string, number>; crowded_key_values: number };
}

const exactKeys = (o: object, want: string, what: string) => {
  const got = Object.keys(o).sort().join(',');
  if (got !== want) throw new Error(`person-dedupe: ${what} has keys ${got}, expected ${want}`);
};

/** Reads `gbrain dedupe --preview --json` into groups over page keys. Throws on a shape the bench cannot score. */
export function parseFinderOutput(raw: unknown, known: ReadonlySet<string>): Group[] {
  const o = raw as FinderOutput;
  if (!o || typeof o !== 'object' || !Array.isArray(o.groups)) throw new Error('person-dedupe: finder output has no groups');
  exactKeys(o, 'counts,groups,schema_version', 'finder output');
  if (o.schema_version !== 1) throw new Error(`person-dedupe: finder schema_version ${o.schema_version} is not one this bench reads (1)`);
  return o.groups.map((g, i) => {
    exactKeys(g, 'class,evidence,id,kind,members', `finder group ${i}`);
    if (!(FINDER_KINDS as readonly string[]).includes(g.kind)) throw new Error(`person-dedupe: finder group ${g.id} has kind ${g.kind}`);
    if (!(FINDER_CLASSES as readonly string[]).includes(g.class)) throw new Error(`person-dedupe: finder group ${g.id} has class ${g.class}`);
    const members = g.members.map(m => {
      exactKeys(m, 'slug,source_id', `finder group ${g.id} member`);
      const k = `${m.source_id}:${m.slug.replace(/^people\//, '')}`;
      if (!known.has(k)) throw new Error(`person-dedupe: finder group ${g.id} names ${k}, which the world does not have`);
      return k;
    });
    return { members: [...new Set(members)].sort(), kind: g.kind, class: g.class, rules: g.evidence.map(e => `${e.matcher}/${e.rule}${e.key ? `/${e.key}` : ''}`) };
  });
}

export function groupId(kind: string, members: readonly string[]): string {
  const lines = members.map(k => `${sourceOf(k)}\tpeople/${k.slice(k.indexOf(':') + 1)}`).sort().join('\n');
  return `dedupe/${createHash('sha256').update(`${kind}\n${lines}`).digest('hex').slice(0, 16)}`;
}

/** Writes groups in the finder's shape, so the stand-in goes through the same parser as the real finder. */
export function toFinderOutput(groups: readonly Group[], crowded = 0): FinderOutput {
  const by_kind: Record<string, number> = Object.fromEntries(FINDER_KINDS.map(k => [k, 0]));
  const by_class: Record<string, number> = Object.fromEntries(FINDER_CLASSES.map(c => [c, 0]));
  for (const g of groups) { by_kind[g.kind]++; by_class[g.class]++; }
  return {
    schema_version: 1,
    groups: groups.map(g => ({
      id: groupId(g.kind, g.members), kind: g.kind, class: g.class,
      members: g.members.map(k => ({ source_id: sourceOf(k), slug: `people/${k.slice(k.indexOf(':') + 1)}` })),
      evidence: g.rules.map(r => r.startsWith('shared_key:') ? { matcher: 'shared_key', rule: 'shared_key', key: r.slice(11), field: r === 'shared_key:email' ? 'emails' : r.slice(11) } : r === 'strict_name' ? { matcher: 'same_name', rule: 'strict_name' } : { matcher: r, rule: r }),
    })),
    counts: { by_kind, by_class, crowded_key_values: crowded },
  };
}

// ─── Scoring ──────────────────────────────────────────────────────────────

export function wilson(k: number, n: number, z = 1.959963984540054): [number, number] | null {
  if (n === 0) return null;
  const p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

export interface Rate { k: number; n: number; rate: number | null; ci95: [number, number] | null }
const rate = (k: number, n: number): Rate => ({ k, n, rate: n ? k / n : null, ci95: wilson(k, n) });

export interface Score {
  /** Headline: designed different-people pairs in one component, over all designed different-people pairs. */
  false_merge: Rate;
  /** Designed same-person pairs in one component. */
  designed_recall: Rate;
  /** Every page pair: merged pairs that are one person, over merged pairs. */
  precision: Rate;
  /** Every page pair: same-person pairs merged, over all same-person pairs. */
  recall: Rate;
  /** Different-people pairs merged anywhere in the world, designed or not. */
  false_merges_anywhere: number;
  b3: { precision: number; recall: number; f1: number };
  /** Per family: different-people pairs merged and same-person pairs found (null where the family has none). */
  by_family: Record<string, { label: string; false_merge: Rate | null; found: Rate | null }>;
  same_exact_recall: Rate;
  /** Each designed false merge, with the groups that hold both pages directly ("closure" when only the closure joins them). */
  false_merge_cases: Array<{ a: string; b: string; family: string; via: string[] }>;
  groups: number;
}

const choose2 = (n: number) => (n * (n - 1)) / 2;

export function scoreGroups(groups: readonly Group[], pairs: readonly DesignedPair[], person: ReadonlyMap<string, string>): Score {
  const uf = new UnionFind();
  for (const g of groups) for (const m of g.members.slice(1)) uf.union(g.members[0], m);
  const merged = (a: string, b: string) => uf.find(a) === uf.find(b);

  const byFamily: Record<string, { fm: number; nd: number; fs: number; ns: number }> = {};
  const cases: Score['false_merge_cases'] = [];
  let fm = 0, nd = 0, fs = 0, ns = 0, se = 0, sn = 0;
  for (const p of pairs) {
    const f = (byFamily[p.family] ??= { fm: 0, nd: 0, fs: 0, ns: 0 });
    const m = merged(p.a, p.b);
    if (p.label === 'different') {
      nd++;
      f.nd++;
      if (m) {
        fm++;
        f.fm++;
        const via = groups.filter(g => g.members.includes(p.a) && g.members.includes(p.b)).map(g => `${g.kind}/${g.class}: ${g.rules.join('+')}`);
        cases.push({ a: p.a, b: p.b, family: p.family, via: via.length ? via : ['closure'] });
      }
    } else { ns++; f.ns++; if (m) { fs++; f.fs++; } }
    if (p.family === 'same-exact') { sn++; if (m) se++; }
  }

  const comps = new Map<string, string[]>();
  for (const k of person.keys()) { const r = uf.find(k); comps.set(r, [...(comps.get(r) ?? []), k]); }
  const personSize = new Map<string, number>();
  for (const pid of person.values()) personSize.set(pid, (personSize.get(pid) ?? 0) + 1);
  let mergedPairs = 0, mergedSame = 0, b3p = 0, b3r = 0;
  for (const members of comps.values()) {
    mergedPairs += choose2(members.length);
    const counts = new Map<string, number>();
    for (const k of members) counts.set(person.get(k)!, (counts.get(person.get(k)!) ?? 0) + 1);
    for (const [pid, c] of counts) {
      mergedSame += choose2(c);
      b3p += (c * c) / members.length;
      b3r += (c * c) / personSize.get(pid)!;
    }
  }
  const allSame = [...personSize.values()].reduce((s, c) => s + choose2(c), 0);
  const P = b3p / person.size, R = b3r / person.size;
  return {
    false_merge: rate(fm, nd),
    designed_recall: rate(fs, ns),
    precision: rate(mergedSame, mergedPairs),
    recall: rate(mergedSame, allSame),
    false_merges_anywhere: mergedPairs - mergedSame,
    b3: { precision: P, recall: R, f1: P + R ? (2 * P * R) / (P + R) : 0 },
    by_family: Object.fromEntries(FAMILIES.filter(f => byFamily[f.id]).map(f => { const x = byFamily[f.id]; return [f.id, { label: f.label, false_merge: x.nd ? rate(x.fm, x.nd) : null, found: x.ns ? rate(x.fs, x.ns) : null }]; })),
    same_exact_recall: rate(se, sn),
    false_merge_cases: cases,
    groups: groups.length,
  };
}

export function verdictOf(s: Score): { pass: boolean; shortfalls: string[] } {
  const shortfalls: string[] = [];
  if (s.false_merge.k > TARGETS.false_merges) shortfalls.push(`${s.false_merge.k} of ${s.false_merge.n} designed different-people pairs merged (target 0)`);
  if ((s.same_exact_recall.rate ?? 0) < TARGETS.same_exact_recall) shortfalls.push(`found ${s.same_exact_recall.k} of ${s.same_exact_recall.n} plain duplicates (same name, same email, two sources; target all)`);
  return { pass: shortfalls.length === 0, shortfalls };
}

// ─── Run ──────────────────────────────────────────────────────────────────

/** The groups a selection treats as "same person". Conflict groups are a review list and never count. */
export const SELECTIONS: Record<string, (g: Group) => boolean> = {
  'auto-link': g => g.kind === 'cross_source' && g.class === 'clean',
  proposed: g => g.class !== 'conflict',
  ...Object.fromEntries(FINDER_CLASSES.filter(c => c !== 'conflict').map(c => [`class:${c}`, (g: Group) => g.class === c])),
  /** Cross-source likely groups held together by a shared email: what an owner would confirm in one go. */
  'confirm-list': g => isConfirm(g),
  'auto-link+confirm-list': g => (g.kind === 'cross_source' && g.class === 'clean') || isConfirm(g),
};

function isConfirm(g: Group): boolean {
  return g.kind === 'cross_source' && g.class === 'likely' && g.rules.some(r => r.endsWith('/email'));
}

export interface ArmResult { id: string; system: 'reference' | 'contract-emulator' | 'finder'; arm: string | null; selection: string; description: string; build: string | null; score: Score; verdict: ReturnType<typeof verdictOf> }

export function runPersonDedupe(ledger: Ledger, opts: { finderJson?: unknown; finderBuild?: string } = {}): ArmResult[] {
  const person = deriveGold(ledger);
  const pages = writtenPages(ledger);
  const known = new Set(pages.map(p => p.key));
  for (const p of pages) if (!person.has(p.key) || !p.title) throw new Error(`person-dedupe: presence: page ${p.key} has no person or no title`);
  const arm = (id: string, system: ArmResult['system'], armId: string | null, selection: string, description: string, groups: Group[], build: string | null = null): ArmResult => {
    const score = scoreGroups(groups, ledger.pairs, person);
    return { id, system, arm: armId, selection, description, build, score, verdict: verdictOf(score) };
  };
  const describe = (sel: string) => ({ 'auto-link': 'groups automatic linking would join (cross_source and clean)', proposed: 'every group except conflict (clean, likely, weak, thin)', 'confirm-list': 'cross_source likely groups held by a shared email (the confirm list)', 'auto-link+confirm-list': 'automatic links plus the whole confirm list, confirmed in one go' } as Record<string, string>)[sel] ?? `only ${sel.slice(6)} groups`;
  const finderArms = (system: 'contract-emulator' | 'finder', armId: string | null, all: Group[], build: string | null, selections: readonly string[]) =>
    selections.map(sel => arm(`${system}${armId ? `[arm ${armId}]` : ''}:${sel}`, system, armId, sel, `${describe(sel)}${armId ? `; clean rule: ${ARMS[armId].text}` : ''}`, all.filter(SELECTIONS[sel]), build));
  const arms = REFERENCE_MATCHERS.map(m => arm(m.id, 'reference', null, 'all', m.description, m.run(pages)));
  for (const [armId, a] of Object.entries(ARMS)) arms.push(...finderArms('contract-emulator', armId, parseFinderOutput(JSON.parse(JSON.stringify(emulateFinder(pages, a.rule))), known), null, armId === '1' ? Object.keys(SELECTIONS) : ['auto-link', 'proposed', 'confirm-list', 'auto-link+confirm-list']));
  if (opts.finderJson !== undefined) arms.push(...finderArms('finder', null, parseFinderOutput(opts.finderJson, known), opts.finderBuild ?? null, Object.keys(SELECTIONS)));
  return arms;
}

export function writeWorld(ledger: Ledger, dir: string): void {
  for (const p of ledger.pages) {
    const file = join(dir, p.source, 'people', `${p.slug}.md`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderPage(p));
  }
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at >= 0) return argv[at + 1];
  return argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

const pct = (r: Rate) => r.rate === null ? 'n/a' : `${(r.rate * 100).toFixed(1)}% (${r.k}/${r.n}; 95% CI ${(r.ci95![0] * 100).toFixed(1)} to ${(r.ci95![1] * 100).toFixed(1)}%)`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const log = json ? () => {} : (s: string) => console.log(s);
  const seed = Number(argValue(argv, '--seed') ?? PERSON_DEDUPE_DEFAULT_SEED);
  const perFamily = Number(argValue(argv, '--per-family') ?? PERSON_DEDUPE_DEFAULT_PER_FAMILY);
  const outputDir = argValue(argv, '--output');
  const receiptFile = outputDir ? join(resolve(outputDir), 'receipt.json') : receiptPath(RECEIPT_STEM);
  if (outputDir) mkdirSync(resolve(outputDir), { recursive: true });
  const finderFile = argValue(argv, '--finder-json');
  const finderBuild = argValue(argv, '--finder-build');
  if (finderFile && !finderBuild) throw new Error('person-dedupe: --finder-json needs --finder-build <tag or sha>');
  const startedAt = new Date().toISOString();

  const ledger = generateLedger(seed, perFamily);
  const fingerprint = ledgerFingerprint(ledger);
  const worldDir = argValue(argv, '--write-world');
  if (worldDir) { writeWorld(ledger, resolve(worldDir)); log(`world written: ${ledger.pages.length} pages under ${worldDir}/<source>/people/`); }

  const arms = runPersonDedupe(ledger, { finderJson: finderFile ? JSON.parse(readFileSync(finderFile, 'utf8')) : undefined, finderBuild });
  const headline = arms.find(a => a.id === 'finder:auto-link') ?? arms.find(a => a.id === 'contract-emulator[arm 1]:auto-link')!;
  const nDiff = ledger.pairs.filter(p => p.label === 'different').length;

  log('# BrainBench person-dedupe: are really different people kept apart?\n');
  log(`seed ${seed}; ${perFamily} per family; ledger ${fingerprint.slice(0, 12)}; ${ledger.pages.length} pages; ${ledger.pairs.length} designed pairs (${nDiff} different-people, ${ledger.pairs.length - nDiff} same-person)`);
  log(`\nHeadline (${headline.id}${headline.build ? ` at ${headline.build}` : ', a stand-in for the finder, not gbrain'}): false-merge rate ${pct(headline.score.false_merge)}`);
  log('\n| system | false-merge rate (designed different-people pairs) | precision (all pairs) | recall (all pairs) | B-cubed F1 | false merges anywhere |');
  log('|---|---|---|---|---|---|');
  for (const a of arms) log(`| ${a.id} | ${pct(a.score.false_merge)} | ${pct(a.score.precision)} | ${pct(a.score.recall)} | ${a.score.b3.f1.toFixed(3)} | ${a.score.false_merges_anywhere} |`);
  log(`\nVerdict (${headline.id}): ${headline.verdict.pass ? 'pass' : 'fail'}${headline.verdict.shortfalls.map(s => `\n  ${s}`).join('')}`);

  writeReceipt(receiptFile, {
    ...noModelSpend('hermetic: generated Markdown and deterministic matchers, no model call'),
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CATEGORY,
    gbrain_version: headline.build ?? 'not loaded (reference matchers and the finder-contract stand-in only)',
    gbrain_pin: gbrainPin(),
    started_at: startedAt,
    execution: { source_tree: sourceTreeIdentity(), product: productIdentity() },
    run_status: 'completed',
    verdict: headline.verdict.pass ? 'pass' : 'fail',
    n_total: ledger.pairs.length,
    n_scored: ledger.pairs.length,
    completion_rate: 1,
    errors: [],
    publishable: true,
    resolved_config: { seed, per_family: perFamily, generator_version: PERSON_DEDUPE_GENERATOR_VERSION, ledger_sha256: fingerprint, sources: ledger.sources, finder_build: finderBuild ?? null, finder_contract_schema: 1, targets: TARGETS, closure: 'transitive', selections: Object.keys(SELECTIONS) },
    hashes: { ledger: fingerprint },
    finished_at: new Date().toISOString(),
    data: {
      headline: { arm: headline.id, build: headline.build, false_merge: headline.score.false_merge, precision: headline.score.precision, recall: headline.score.recall, shortfalls: headline.verdict.shortfalls },
      arms: arms.map(a => a.selection === 'auto-link' ? a : { ...a, score: { ...a.score, false_merge_cases: `${a.score.false_merge_cases.length} cases; listed only for auto-link selections` } }),
      families: FAMILIES,
      ledger: { seed, per_family: perFamily, generator_version: PERSON_DEDUPE_GENERATOR_VERSION, sha256: fingerprint, pages: ledger.pages.length, pairs: ledger.pairs.length, regenerate: 'generateLedger(seed, per_family) in eval/generators/person-dedupe-gen.ts; --write-world writes the pages' },
    },
  } satisfies Receipt);
  log(`\nReceipt: ${receiptFile}`);
  if (json) process.stdout.write(JSON.stringify(arms.map(a => ({ id: a.id, build: a.build, false_merge: a.score.false_merge, precision: a.score.precision, recall: a.score.recall, verdict: a.verdict })), null, 2) + '\n');
  process.exit(headline.verdict.pass ? 0 : 1);
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(3); });
}
