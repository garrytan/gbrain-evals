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
 *                        (written with `--write-world <dir>` into a new
 *                        directory), labelled `--finder-build <tag or sha>`,
 *                        with `--finder-imports <file>` holding the
 *                        `gbrain import --json` summaries, one per line, so
 *                        the run fails unless the finder saw every page.
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
 * Opt-in, dev seed only: --company-autolink adds the company auto-link table from eval/runner/company-autolink.ts,
 * which scores key-based company auto-link rules (the contract emulator's company tier, people unchanged) on this
 * company world plus the development V families in eval/generators/company-dedupe-v-gen.ts (renames, moves, rejected
 * pairs, a shared LinkedIn page, a subsidiary on its parent's root domain). Without the flag nothing below changes.
 *
 * Usage: bun eval/runner/person-dedupe.ts [--seed N] [--per-family N] [--generator-version N] [--output DIR] [--company-autolink]
 *          [--write-world DIR] [--finder-json FILE --finder-build LABEL --finder-imports FILE] [--json]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  DECLARED_PERSON_ID_FIELD, FAMILIES, NICKNAMES, PERSON_DEDUPE_DEFAULT_PER_FAMILY, PERSON_DEDUPE_DEFAULT_SEED, PERSON_DEDUPE_GENERATOR_VERSION,
  deriveGold, generateLedger, ledgerFingerprint, renderPage, writtenPages,
  type DesignedPair, type Ledger, type LedgerPage, type WrittenPage,
} from '../generators/person-dedupe-gen.ts';
import {
  COMPANY_FAMILIES, companyWrittenPages, deriveCompanyGold, generateCompanyLedger, renderCompanyPage,
  type CompanyLedger,
} from '../generators/company-dedupe-gen.ts';
import { gbrainPin } from './gbrain-version.ts';
import { RunnerRefusal, exitOnRefusal } from './runner-refusal.ts';
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

/** gbrain's corporate suffixes (CORPORATE_SUFFIXES in src/core/entities/near-name.ts, finder PR #9680), dropped from the end of a company name by the variant fold. */
export const CORPORATE_SUFFIXES: ReadonlySet<string> = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'labs', 'lab', 'gmbh', 'plc', 'ag', 'sa', 'bv', 'the']);

/** The finder's variant fold: the strict fold without leading honorifics or job titles, and for a company without trailing corporate suffixes. Name suffixes stay. */
export function variantFold(title: string, type: WrittenPage['type'] = 'person'): string {
  const parts = strictFold(title).split(' ');
  while (parts.length > 1 && HONORIFICS.has(parts[0])) parts.shift();
  if (type === 'company') while (parts.length > 1 && CORPORATE_SUFFIXES.has(parts.at(-1)!)) parts.pop();
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

/** A company domain as the finder keys it (from `domain` or a `website` URL): the host, lowercase, without www. */
export function domainKey(raw: string): string | null {
  const host = raw.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#:]/)[0].replace(/^www\./, '');
  return host.includes('.') && /^[a-z0-9.-]+$/.test(host) ? host : null;
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
  const blocks = [...bucket(pages, p => p.emails.map(e => `e:${e.trim().toLowerCase()}`).concat(p.domains.map(d => `d:${domainKey(d)}`), [`n:${strictFold(p.title).split(' ').at(-1)}`])).values()];
  const seen = new Set<string>();
  for (const block of blocks) for (let i = 0; i < block.length; i++) for (let j = i + 1; j < block.length; j++) {
    const a = block[i], b = block[j];
    const k = a.key < b.key ? `${a.key}|${b.key}` : `${b.key}|${a.key}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (a.type === b.type && linked(a, b)) uf.union(a.key, b.key);
  }
  const comps = new Map<string, string[]>();
  for (const p of pages) { const r = uf.find(p.key); comps.set(r, [...(comps.get(r) ?? []), p.key]); }
  return [...comps.values()].filter(m => m.length > 1).map(m => ({ members: m.sort(), kind: kindOf(m), class: 'clean', rules: [rule] }));
}

const sharesEmail = (a: WrittenPage, b: WrittenPage) => a.emails.some(e => emailKey(e) !== null && b.emails.some(f => emailKey(f) === emailKey(e)));
const sharesDomain = (a: WrittenPage, b: WrittenPage) => a.domains.some(d => domainKey(d) !== null && b.domains.some(e => domainKey(e) === domainKey(d)));
/** A shared email between people, a shared domain between companies: the contact key of each type. */
const sharesContact = (a: WrittenPage, b: WrittenPage) => a.type === 'company' ? sharesDomain(a, b) : sharesEmail(a, b);

/** A reference matcher; `company` says what it does on company pages. A person page never links to a company page. */
export interface Matcher { id: string; description: string; company: string; run(pages: readonly WrittenPage[]): Group[] }

export const REFERENCE_MATCHERS: readonly Matcher[] = [
  { id: 'exact-name', description: 'same name (case and spacing ignored), nothing else', company: 'the same rule on company names', run: ps => linkGroups(ps, (a, b) => exactNameKey(a.title) === exactNameKey(b.title), 'exact-name') },
  { id: 'folded-name', description: 'same strict-folded name, nothing else', company: 'the same rule on company names', run: ps => linkGroups(ps, (a, b) => strictFold(a.title) === strictFold(b.title), 'folded-name') },
  { id: 'shared-email', description: 'any shared email (placeholders dropped), whatever the names', company: 'any shared domain (a `domain` value or the `website` host), whatever the names', run: ps => linkGroups(ps, sharesContact, 'shared-email') },
  { id: 'email+folded-name', description: 'a shared email and the same strict-folded name, with no crowding or one-per-source checks', company: 'a shared domain and the same strict-folded name', run: ps => linkGroups(ps, (a, b) => sharesContact(a, b) && strictFold(a.title) === strictFold(b.title), 'email+folded-name') },
  { id: 'email+nickname-name', description: 'a shared email and the same name after folding and mapping nicknames to formal names', company: 'no nickname table for companies; instead a shared domain and the same name after the variant fold drops trailing legal suffixes', run: ps => linkGroups(ps, (a, b) => sharesContact(a, b) && (a.type === 'company' ? variantFold(a.title, 'company') === variantFold(b.title, 'company') : nicknameKey(a.title) === nicknameKey(b.title)), 'email+nickname-name') },
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

/** `text` is the rule on person pages; `company` says what of it applies to company pages, whose keys are a domain (contact, like email) and a LinkedIn company page (exclusive). */
const BASE_ARMS: Record<string, { rule: CleanRule; text: string; company: string }> = {
  '1': { rule: {}, text: 'approved rule: one shared key value that only the group carries, the same strict-folded name, one page per source', company: 'the same rule; the key is a shared domain or LinkedIn company page' },
  '2': { rule: { noRole: true }, text: 'arm 1, but a role or household email (team, support, hello, family and similar words) never makes clean', company: 'no company rule: role words are read from email addresses and company pages carry none, so on companies arm 2 is arm 1' },
  '2b': { rule: { keyTypeSplit: true, noRole: true, noContradiction: true }, text: 'key-type split: LinkedIn or GitHub plus the same name links; an email needs a shared LinkedIn or GitHub or the same employer as well; role emails never; no contradicting key', company: 'a shared LinkedIn company page plus the same name links; the employer path has no company rule, so a shared domain links only with a shared LinkedIn company page as well; no contradicting LinkedIn' },
  '3': { rule: { twoKeyTypes: true }, text: 'arm 1, and the pages also share a value of a second key type', company: 'the same rule: a shared domain and a shared LinkedIn company page' },
  '4': { rule: { noContradiction: true }, text: 'arm 1, and no contradicting LinkedIn or GitHub (any class)', company: 'the same rule: no contradicting LinkedIn company page; two different domains are no contradiction' },
  '5': { rule: { noRole: true, noContradiction: true }, text: 'arms 2 and 4 together', company: 'arm 4 on companies: the role-word part has no company rule' },
  '6': { rule: { noRole: true, noContradiction: true, singlePersonDomain: true }, text: 'arm 5, but a role email still counts when its domain belongs to one person in the brain', company: 'arm 4 on companies: the role-word and one-person-domain parts have no company rule' },
  '7': { rule: { keyTypeSplit: true, noEmployerSignal: true, noContradiction: true, unionCheck: true }, text: 'arm 2b without the employer path, with the union check: only a shared LinkedIn or GitHub plus the same name links; an email never links by itself and goes to the confirm list; no contradicting key', company: 'the same rule: only a shared LinkedIn company page plus the same name links; a shared domain never links by itself' },
};

export const ARMS: Record<string, { rule: CleanRule; text: string; company: string }> = Object.fromEntries(Object.entries(BASE_ARMS).flatMap(([id, a]) => a.rule.unionCheck ? [[id, a]] : [
  [id, a],
  [`${id}+union`, { rule: { ...a.rule, unionCheck: true }, text: `${a.text}; plus a check of the union before linking`, company: `${a.company}; plus the union check` }],
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
  for (const d of p.domains) { const k = domainKey(d); if (k) out.push(`domain:${k}`); }
  const li = p.linkedin?.trim().toLowerCase().match(/\/(in|company)\/[^/?#]+/)?.[0];
  if (li) out.push(`linkedin:${li}`);
  const gh = p.github?.trim().toLowerCase().replace(/^@/, '').replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\/$/, '');
  if (gh && !PLACEHOLDERS.has(gh)) out.push(`github:${gh}`);
  const declaredId = p.external_id?.trim().toLowerCase();
  if (declaredId && !PLACEHOLDERS.has(declaredId) && !/^0+$/.test(declaredId) && declaredId.length <= 320) out.push(`declared_id:${declaredId}`);
  return [...new Set(out)];
}

const typeOf = (k: string) => k.slice(0, k.indexOf(':'));
const EXCLUSIVE = new Set(['linkedin', 'github', 'declared_id']);
const CONTACT = new Set(['email', 'domain']);

/**
 * gbrain's finder as its contract (schema 1) describes it, for person pages
 * with email, LinkedIn and GitHub keys and company pages with domain and
 * LinkedIn keys: clean, likely, weak and conflict.
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
      for (const t of new Set(a.map(typeOf))) if (!CONTACT.has(t) && b.some(k => typeOf(k) === t) && !a.some(k => typeOf(k) === t && b.includes(k))) return true;
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
    if (new Set(ps.map(p => variantFold(p.title, p.type))).size > 1) { add(members, 'conflict', 'conflict', why); continue; }
    const shared = usable(members[0]).filter(k => members.every(m => usable(m).includes(k)));
    const sharedTypes = new Set(shared.map(typeOf));
    const role = type === 'email' && isRoleEmail(value) && !(rule.singlePersonDomain && domainNames.get(value.slice(value.indexOf('@') + 1))!.size === 1);
    const employer = ps.every(p => p.company !== null && p.company === ps[0].company);
    const clean = new Set(ps.map(p => strictFold(p.title))).size === 1 && new Set(ps.map(p => p.type)).size === 1
      && new Set(ps.map(p => p.source)).size === ps.length && kindOf(members) === 'cross_source'
      && !(rule.noRole && role)
      && !(rule.twoKeyTypes && sharedTypes.size < 2)
      && !(rule.keyTypeSplit && !EXCLUSIVE.has(type) && !shared.some(k => EXCLUSIVE.has(typeOf(k))) && (rule.noEmployerSignal || !employer));
    add(members, kindOf(members), clean ? 'clean' : 'likely', why);
  }
  for (const [, ps] of bucket(pages, p => [`${p.type}:${strictFold(p.title)}`])) {
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
  for (const g of groups) if (g.kind === 'cross_source' && g.class === 'likely' && (g.rules.includes('shared_key:email') || g.rules.includes('shared_key:domain'))) g.rules.push('contact_key_only');
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

/** A page key's slug as the finder prints it: people/<slug>, or companies/<slug> as the key already carries it. */
const finderSlug = (key: string) => { const rest = key.slice(key.indexOf(':') + 1); return rest.startsWith('companies/') ? rest : `people/${rest}`; };

export function groupId(kind: string, members: readonly string[]): string {
  const lines = members.map(k => `${sourceOf(k)}\t${finderSlug(k)}`).sort().join('\n');
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
      members: g.members.map(k => ({ source_id: sourceOf(k), slug: finderSlug(k) })),
      evidence: g.rules.map(r => r.startsWith('shared_key:') ? { matcher: 'shared_key', rule: 'shared_key', key: r.slice(11), field: r === 'shared_key:email' ? 'emails' : r === 'shared_key:declared_id' ? DECLARED_PERSON_ID_FIELD : r.slice(11) } : r === 'strict_name' ? { matcher: 'same_name', rule: 'strict_name' } : r === 'contact_key_only' ? { matcher: 'key_check', rule: 'contact_key_only' } : { matcher: r, rule: r }),
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
const ALL_FAMILIES: ReadonlyArray<{ id: string; label: string }> = [...FAMILIES, ...COMPANY_FAMILIES];
/** The plain-duplicate families behind the utility floor: same name and same email or domain, two sources. */
const SAME_EXACT = new Set(['same-exact', 'co-same-exact']);

/**
 * Scores groups against the entities in `person` (page key to person or company id). `closure` is the
 * set of groups whose links chain (by default `groups`); scoring one entity type passes every group
 * there, so a chain through a page of another type still counts.
 */
export function scoreGroups(groups: readonly Group[], pairs: readonly DesignedPair[], person: ReadonlyMap<string, string>, closure: readonly Group[] = groups): Score {
  const uf = new UnionFind();
  for (const g of closure) for (const m of g.members.slice(1)) uf.union(g.members[0], m);
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
    if (SAME_EXACT.has(p.family)) { sn++; if (m) se++; }
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
    by_family: Object.fromEntries(ALL_FAMILIES.filter(f => byFamily[f.id]).map(f => { const x = byFamily[f.id]; return [f.id, { label: f.label, false_merge: x.nd ? rate(x.fm, x.nd) : null, found: x.ns ? rate(x.fs, x.ns) : null }]; })),
    same_exact_recall: rate(se, sn),
    false_merge_cases: cases,
    groups: groups.length,
  };
}

export type Scope = 'person' | 'company' | 'all';
const SCOPE_WORDS: Record<Scope, [string, string]> = {
  person: ['different-people', 'same name, same email'],
  company: ['different-company', 'same name, same domain'],
  all: ['different-entity', 'same name, same email or domain'],
};

export function verdictOf(s: Score, scope: Scope = 'person'): { pass: boolean; shortfalls: string[] } {
  const [different, plain] = SCOPE_WORDS[scope];
  const shortfalls: string[] = [];
  if (s.false_merge.k > TARGETS.false_merges) shortfalls.push(`${s.false_merge.k} of ${s.false_merge.n} designed ${different} pairs merged (target 0)`);
  if ((s.same_exact_recall.rate ?? 0) < TARGETS.same_exact_recall) shortfalls.push(`found ${s.same_exact_recall.k} of ${s.same_exact_recall.n} plain duplicates (${plain}, two sources; target all)`);
  return { pass: shortfalls.length === 0, shortfalls };
}

// ─── Run ──────────────────────────────────────────────────────────────────

/** The groups a selection treats as "same person". Conflict groups are a review list and never count. */
export const SELECTIONS: Record<string, (g: Group) => boolean> = {
  'auto-link': g => g.kind === 'cross_source' && g.class === 'clean',
  proposed: g => g.class !== 'conflict',
  ...Object.fromEntries(FINDER_CLASSES.filter(c => c !== 'conflict').map(c => [`class:${c}`, (g: Group) => g.class === c])),
  /** The confirm list: cross-source likely groups the finder marks contact_key_only (the stand-in marks those held by a shared email). */
  'confirm-list': g => isConfirm(g),
  'auto-link+confirm-list': g => (g.kind === 'cross_source' && g.class === 'clean') || isConfirm(g),
};

function isConfirm(g: Group): boolean {
  return g.kind === 'cross_source' && g.class === 'likely' && g.rules.some(r => r.endsWith('/contact_key_only'));
}

export interface TypeResult { score: Score; verdict: ReturnType<typeof verdictOf> }

export interface ArmResult {
  id: string; system: 'reference' | 'contract-emulator' | 'finder'; arm: string | null; selection: string; description: string;
  /** What the arm does on company pages; null for the finder, which brings its own rules. */
  company_rule: string | null;
  build: string | null;
  /** Every page and designed pair, people and companies together. */
  score: Score; verdict: ReturnType<typeof verdictOf>;
  /** The same metrics over one entity type's pages and pairs (closure still runs over every group); company is null in a people-only world. */
  by_type: { person: TypeResult; company: TypeResult | null };
  /** Person and company pages that end up in one component: always wrong, since a person is never a company. */
  cross_type_merges: number;
}

export function runPersonDedupe(ledger: Ledger, opts: { companies?: CompanyLedger; finderJson?: unknown; finderBuild?: string } = {}): ArmResult[] {
  const peopleLedger = opts.companies?.founders?.length ? { ...ledger, pages: [...ledger.pages, ...opts.companies.founders] } : ledger;
  const people = deriveGold(peopleLedger);
  const companies = opts.companies ? deriveCompanyGold(opts.companies) : new Map<string, string>();
  const gold = new Map([...people, ...companies]);
  const pages = [...writtenPages(peopleLedger), ...(opts.companies ? companyWrittenPages(opts.companies) : [])];
  const pairs = [...ledger.pairs, ...(opts.companies?.pairs ?? [])];
  const known = new Set(pages.map(p => p.key));
  for (const p of pages) if (!gold.has(p.key) || !p.title) throw new Error(`person-dedupe: presence: page ${p.key} has no person or company, or no title`);
  const peoplePairs = pairs.filter(p => people.has(p.a) && people.has(p.b)), companyPairs = pairs.filter(p => companies.has(p.a) && companies.has(p.b));
  const arm = (id: string, system: ArmResult['system'], armId: string | null, selection: string, description: string, groups: Group[], build: string | null = null, companyRule: string | null = null): ArmResult => {
    const part = (keys: ReadonlyMap<string, string>, typePairs: readonly DesignedPair[], scope: Scope): TypeResult => {
      const score = scoreGroups(groups.filter(g => g.members.some(m => keys.has(m))), typePairs, keys, groups);
      return { score, verdict: verdictOf(score, scope) };
    };
    const score = scoreGroups(groups, pairs, gold);
    const person = part(people, peoplePairs, 'person');
    const company = opts.companies ? part(companies, companyPairs, 'company') : null;
    const cross = score.false_merges_anywhere - person.score.false_merges_anywhere - (company?.score.false_merges_anywhere ?? 0);
    return { id, system, arm: armId, selection, description, company_rule: companyRule, build, score, verdict: verdictOf(score, opts.companies ? 'all' : 'person'), by_type: { person, company }, cross_type_merges: cross };
  };
  const describe = (sel: string) => ({ 'auto-link': 'groups automatic linking would join (cross_source and clean)', proposed: 'every group except conflict (clean, likely, weak, thin)', 'confirm-list': 'cross_source likely groups marked contact_key_only (the confirm list)', 'auto-link+confirm-list': 'automatic links plus the whole confirm list, confirmed in one go' } as Record<string, string>)[sel] ?? `only ${sel.slice(6)} groups`;
  const finderArms = (system: 'contract-emulator' | 'finder', armId: string | null, all: Group[], build: string | null, selections: readonly string[]) =>
    selections.map(sel => arm(`${system}${armId ? `[arm ${armId}]` : ''}:${sel}`, system, armId, sel, `${describe(sel)}${armId ? `; clean rule: ${ARMS[armId].text}` : ''}`, all.filter(SELECTIONS[sel]), build, armId ? ARMS[armId].company : null));
  const arms = REFERENCE_MATCHERS.map(m => arm(m.id, 'reference', null, 'all', m.description, m.run(pages), null, m.company));
  for (const [armId, a] of Object.entries(ARMS)) arms.push(...finderArms('contract-emulator', armId, parseFinderOutput(JSON.parse(JSON.stringify(emulateFinder(pages, a.rule))), known), null, armId === '1' ? Object.keys(SELECTIONS) : ['auto-link', 'proposed', 'confirm-list', 'auto-link+confirm-list']));
  if (opts.finderJson !== undefined) arms.push(...finderArms('finder', null, parseFinderOutput(opts.finderJson, known), opts.finderBuild ?? null, Object.keys(SELECTIONS)));
  return arms;
}

/** Writes the world's pages. Refuses (WORLD_DIR_USED) a directory that already has files, so an old world never mixes into a new one. */
export function writeWorld(ledger: Ledger, dir: string, founders: readonly LedgerPage[] = []): void {
  const used = existsSync(dir) ? readdirSync(dir).length : 0;
  if (used > 0) throw new RunnerRefusal('WORLD_DIR_USED', `person-dedupe: --write-world ${dir} is not empty; write each world into a new directory`, { entries_in_folder: used }, 'pass a fresh --write-world directory');
  for (const p of [...ledger.pages, ...founders]) {
    const file = join(dir, p.source, 'people', `${p.slug}.md`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderPage(p));
  }
}

export interface ImportSummary { status: string; source_id: string; imported: number; unchanged: number; total_files: number; errors: number; malformed_skipped: number; failures: unknown[] }

/**
 * Checks, from the `gbrain import --json` summaries, that the finder's brain holds every page of the
 * world: one successful import per source into a fresh brain, with every file imported and none failed.
 * gbrain counts a page that is still publishing as unchanged, so an unchanged page fails the check too.
 * Refuses otherwise (IMPORT_INCOMPLETE, with the pages expected and imported), because a finder that never saw a page
 * can't link it and would score as safe.
 */
export function checkFinderCoverage(imports: readonly unknown[], pages: readonly { source: string }[]): void {
  const want = new Map<string, number>();
  for (const p of pages) want.set(p.source, (want.get(p.source) ?? 0) + 1);
  const imported = imports.reduce<number>((n, raw) => {
    const s = raw as ImportSummary | null;
    return n + (s && typeof s === 'object' && want.has(s.source_id) && Number.isFinite(s.imported) ? s.imported : 0);
  }, 0);
  const incomplete = (detail: string) => new RunnerRefusal('IMPORT_INCOMPLETE', detail, { pages_expected: pages.length, pages_imported: imported },
    'import each source into a fresh brain, rerun until every page is imported, and pass every source\'s gbrain import --json summary');
  const seen = new Set<string>();
  for (const raw of imports) {
    const s = raw as ImportSummary;
    if (!s || typeof s !== 'object' || typeof s.source_id !== 'string') throw incomplete('person-dedupe: an import summary has no source_id');
    const n = want.get(s.source_id);
    if (n === undefined) throw incomplete(`person-dedupe: import summary for source ${s.source_id}, which the world does not have`);
    if (seen.has(s.source_id)) throw incomplete(`person-dedupe: two import summaries for source ${s.source_id}`);
    seen.add(s.source_id);
    const problems = [
      s.status !== 'success' && `status ${s.status}`,
      s.errors !== 0 && `${s.errors} errors`,
      s.malformed_skipped !== 0 && `${s.malformed_skipped} malformed pages skipped`,
      (!Array.isArray(s.failures) || s.failures.length > 0) && 'failures listed',
      s.total_files !== n && `${s.total_files} files, the world has ${n}`,
      s.imported !== n && `${s.imported} imported (${s.unchanged} unchanged), the world has ${n}; import each source into a fresh brain and rerun until every page is imported`,
    ].filter(Boolean);
    if (problems.length) throw incomplete(`person-dedupe: the finder's brain is missing pages of source ${s.source_id}: ${problems.join('; ')}`);
  }
  const missing = [...want.keys()].filter(src => !seen.has(src));
  if (missing.length) throw incomplete(`person-dedupe: no import summary for source ${missing.join(', ')}; the finder never saw those pages`);
}

/** Writes the company pages beside the person pages: <dir>/<source>/companies/<slug>.md. */
export function writeCompanyWorld(companies: CompanyLedger, dir: string): void {
  for (const p of companies.pages) {
    const file = join(dir, p.source, 'companies', `${p.slug}.md`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderCompanyPage(p));
  }
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at >= 0) return argv[at + 1];
  return argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

const pct = (r: Rate) => r.rate === null ? 'n/a' : `${(r.rate * 100).toFixed(1)}% (${r.k}/${r.n}; 95% CI ${(r.ci95![0] * 100).toFixed(1)} to ${(r.ci95![1] * 100).toFixed(1)}%)`;
const headlineOf = (r: TypeResult) => ({ false_merge: r.score.false_merge, designed_recall: r.score.designed_recall, precision: r.score.precision, recall: r.score.recall, shortfalls: r.verdict.shortfalls });
const briefCases = (s: Score): Score => ({ ...s, false_merge_cases: `${s.false_merge_cases.length} cases; listed only for auto-link selections` as unknown as Score['false_merge_cases'] });

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const log = json ? () => {} : (s: string) => console.log(s);
  const seed = Number(argValue(argv, '--seed') ?? PERSON_DEDUPE_DEFAULT_SEED);
  const perFamily = Number(argValue(argv, '--per-family') ?? PERSON_DEDUPE_DEFAULT_PER_FAMILY);
  const generatorVersion = Number(argValue(argv, '--generator-version') ?? PERSON_DEDUPE_GENERATOR_VERSION);
  const outputDir = argValue(argv, '--output');
  const receiptFile = outputDir ? join(resolve(outputDir), 'receipt.json') : receiptPath(RECEIPT_STEM);
  if (outputDir) mkdirSync(resolve(outputDir), { recursive: true });
  const finderFile = argValue(argv, '--finder-json');
  const finderBuild = argValue(argv, '--finder-build');
  if (finderFile && !finderBuild) throw new Error('person-dedupe: --finder-json needs --finder-build <tag or sha>');
  const importsFile = argValue(argv, '--finder-imports');
  if (finderFile && !importsFile) throw new Error('person-dedupe: --finder-json needs --finder-imports <file of gbrain import --json summaries, one per line>');
  const companyAutolink = argv.includes('--company-autolink');
  if (companyAutolink && (seed !== PERSON_DEDUPE_DEFAULT_SEED || generatorVersion !== PERSON_DEDUPE_GENERATOR_VERSION)) {
    throw new Error(`person-dedupe: --company-autolink runs only on the dev seed ${PERSON_DEDUPE_DEFAULT_SEED} at generator version ${PERSON_DEDUPE_GENERATOR_VERSION}, not seed ${seed} at version ${generatorVersion}`);
  }
  const vGen = companyAutolink ? await import('../generators/company-dedupe-v-gen.ts') : null;
  const vWorld = vGen?.generateCompanyVWorld(seed, perFamily) ?? null;
  const startedAt = new Date().toISOString();

  const ledger = generateLedger(seed, perFamily, generatorVersion);
  const companies = generateCompanyLedger(seed, perFamily, generatorVersion);
  const founders = companies.founders ?? [];
  const fingerprint = ledgerFingerprint(ledger);
  const companyFingerprint = ledgerFingerprint(companies);
  const worldDir = argValue(argv, '--write-world');
  if (worldDir) {
    writeWorld(ledger, resolve(worldDir), founders);
    writeCompanyWorld(companies, resolve(worldDir));
    log(`world written: ${ledger.pages.length + founders.length} person pages under ${worldDir}/<source>/people/ and ${companies.pages.length} company pages under ${worldDir}/<source>/companies/`);
  }

  if (importsFile) checkFinderCoverage(readFileSync(importsFile, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)), [...ledger.pages, ...founders, ...companies.pages]);
  const arms = runPersonDedupe(ledger, { companies, finderJson: finderFile ? JSON.parse(readFileSync(finderFile, 'utf8')) : undefined, finderBuild });
  const headline = arms.find(a => a.id === 'finder:auto-link') ?? arms.find(a => a.id === 'contract-emulator[arm 1]:auto-link')!;
  const count = (ps: readonly DesignedPair[]) => { const d = ps.filter(p => p.label === 'different').length; return `${ps.length} designed pairs (${d} different, ${ps.length - d} same)`; };

  log('# BrainBench person-dedupe: are really different people and companies kept apart?\n');
  log(`seed ${seed}; ${perFamily} per family`);
  log(`people: ledger ${fingerprint.slice(0, 12)}; ${ledger.pages.length} pages; ${count(ledger.pairs)}`);
  log(`companies: stream seed ${companies.stream_seed}; ledger ${companyFingerprint.slice(0, 12)}; ${companies.pages.length} company pages and ${founders.length} founder person pages; ${count(companies.pairs)} including cross-type pairs`);
  log(`\nHeadline (${headline.id}${headline.build ? ` at ${headline.build}` : ', a stand-in for the finder, not gbrain'}), false-merge rate:`);
  log(`  people     ${pct(headline.by_type.person.score.false_merge)}`);
  log(`  companies  ${pct(headline.by_type.company!.score.false_merge)}`);
  log(`  combined   ${pct(headline.score.false_merge)}; person and company pages merged together: ${headline.cross_type_merges}`);
  const scopes: Array<[string, (a: ArmResult) => TypeResult]> = [['People', a => a.by_type.person], ['Companies', a => a.by_type.company!], ['People and companies combined', a => ({ score: a.score, verdict: a.verdict })]];
  for (const [title, of] of scopes) {
    log(`\n## ${title}\n`);
    log('| system | false-merge rate (designed pairs) | recall (designed pairs) | precision (all pairs) | recall (all pairs) | B-cubed F1 | false merges anywhere |');
    log('|---|---|---|---|---|---|---|');
    for (const a of arms) { const s = of(a).score; log(`| ${a.id} | ${pct(s.false_merge)} | ${pct(s.designed_recall)} | ${pct(s.precision)} | ${pct(s.recall)} | ${s.b3.f1.toFixed(3)} | ${s.false_merges_anywhere} |`); }
  }
  log(`\nVerdict (${headline.id}): ${headline.verdict.pass ? 'pass' : 'fail'}${headline.verdict.shortfalls.map(s => `\n  ${s}`).join('')}`);
  let autolink: Record<string, unknown> | null = null;
  if (vGen && vWorld) {
    const { COMPANY_V_FAMILIES, COMPANY_V_GENERATOR_VERSION } = vGen;
    const { COMPANY_AUTOLINK_ARMS, formatCompanyAutoLink, runCompanyAutoLink } = await import('./company-autolink.ts');
    const results = runCompanyAutoLink(vWorld);
    log('\n## Company auto-link rules (dev seed, company pages only; a stand-in for the finder, not gbrain)\n');
    log(`${vWorld.pages.length} company pages and ${vWorld.pairs.length} designed company pairs, with the V families; ${vWorld.rejections.length} rejected pairs. Base counts cover the families above; per-family counts use rejection memory keyed on the stable page id.\n`);
    for (const line of formatCompanyAutoLink(results)) log(line);
    autolink = { generator_version: COMPANY_V_GENERATOR_VERSION, families: COMPANY_V_FAMILIES, arms: COMPANY_AUTOLINK_ARMS, pages: vWorld.pages.length, pairs: vWorld.pairs.length, rejections: vWorld.rejections.length, results };
  }

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
    n_total: ledger.pairs.length + companies.pairs.length,
    n_scored: ledger.pairs.length + companies.pairs.length,
    completion_rate: 1,
    errors: [],
    publishable: true,
    resolved_config: {
      seed, per_family: perFamily, generator_version: ledger.generator_version, ledger_sha256: fingerprint,
      company_generator_version: companies.generator_version, company_stream_seed: companies.stream_seed, company_ledger_sha256: companyFingerprint,
      sources: ledger.sources, finder_build: finderBuild ?? null, finder_contract_schema: 1, identity_keys: { person: [DECLARED_PERSON_ID_FIELD] }, targets: TARGETS, closure: 'transitive', selections: Object.keys(SELECTIONS), scopes: ['person', 'company', 'all'],
      ...(autolink ? { company_autolink: { generator_version: autolink.generator_version } } : {}),
    },
    hashes: { ledger: fingerprint, company_ledger: companyFingerprint },
    finished_at: new Date().toISOString(),
    data: {
      headline: { arm: headline.id, build: headline.build, person: headlineOf(headline.by_type.person), company: headlineOf(headline.by_type.company!), all: headlineOf({ score: headline.score, verdict: headline.verdict }), cross_type_merges: headline.cross_type_merges },
      arms: arms.map(a => a.selection === 'auto-link' ? a : {
        ...a, score: briefCases(a.score),
        by_type: { person: { ...a.by_type.person, score: briefCases(a.by_type.person.score) }, company: a.by_type.company && { ...a.by_type.company, score: briefCases(a.by_type.company.score) } },
      }),
      families: FAMILIES,
      company_families: COMPANY_FAMILIES,
      ledger: { seed, per_family: perFamily, generator_version: ledger.generator_version, sha256: fingerprint, pages: ledger.pages.length, pairs: ledger.pairs.length, regenerate: 'generateLedger(seed, per_family, generator_version) in eval/generators/person-dedupe-gen.ts; --write-world writes the pages' },
      company_ledger: { seed, stream_seed: companies.stream_seed, per_family: perFamily, generator_version: companies.generator_version, sha256: companyFingerprint, pages: companies.pages.length, founder_pages: founders.length, pairs: companies.pairs.length, regenerate: 'generateCompanyLedger(seed, per_family, generator_version) in eval/generators/company-dedupe-gen.ts; --write-world writes the pages' },
      ...(autolink ? { company_autolink: autolink } : {}),
    },
  } satisfies Receipt);
  log(`\nReceipt: ${receiptFile}`);
  const brief = (r: TypeResult | null) => r && { false_merge: r.score.false_merge, designed_recall: r.score.designed_recall, precision: r.score.precision, recall: r.score.recall };
  if (json) process.stdout.write(JSON.stringify(arms.map(a => ({ id: a.id, build: a.build, false_merge: a.score.false_merge, precision: a.score.precision, recall: a.score.recall, people: brief(a.by_type.person), companies: brief(a.by_type.company), cross_type_merges: a.cross_type_merges, verdict: a.verdict })), null, 2) + '\n');
  process.exit(headline.verdict.pass ? 0 : 1);
}

if (import.meta.main) {
  main().catch(e => {
    try { exitOnRefusal(e); } catch { console.error(e); process.exit(3); }
  });
}
