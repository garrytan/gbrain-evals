/**
 * skillopt-method-v3, revision 1 (GBEV-30, plan section 4's one revision):
 * what the revision-1 families of the three skills share.
 *
 * Calibration put the seed at the ceiling on query and briefing because
 * gbrain's keyword search puts the deciding pages on its first result page.
 * Revision 1 changes task structure, not knobs, along four patterns:
 *
 *   indirect      the question names an entity by a description (the account
 *                 a contact works at, a company's former officer, the company
 *                 that acquired another), so the page that decides the answer
 *                 is not found from the question's own words
 *   join          the answer is the one account meeting two conditions that
 *                 two different pages decide
 *   aggregation   a comparison or a total over every account a Lanterncrest
 *                 rep owns, so an exhaustive reader opens at least 10 pages
 *   supersession  the record in force is the newest one, issued to the
 *                 account's legal entity (world-v3 at revision 1), so a
 *                 search on the account's name ranks the older records first
 *
 * Every fact is read twice, as in revision 0: from the world model, and by an
 * oracle from the rendered page text alone; a candidate whose two paths
 * disagree is dropped.
 *
 * The findability control runs gbrain's own search (the `search` operation the
 * rollouts call, at the pinned gbrain, embeddings off, the clock pinned to the
 * world's present) on each candidate's question text. findability-v3.ts runs
 * it and writes findability-v3-rev1.jsonl, keyed by the world's hash;
 * generation reads that file, so regeneration stays byte for byte and needs no
 * database. The rules (`FINDABILITY_RULES`) drop a candidate when its indirect
 * or join probe finds every deciding page in the first 5 hits, when its
 * supersession probe ranks the newest deciding record first, or when its
 * aggregation needs fewer than 10 pages. Abstention probes have no deciding
 * page: they are searched and their near-miss ranks reported, never filtered.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assembleV3, careerFromText, FINDABILITY_DROP, founderFromText, goldOf, nameValue, parseLongDate, roleHolderFromText, stintFromText, uniqueValues, valueFromText,
  type CandidateV3, type DraftV3, type MethodTaskV3, type QuotasV3, type SkillGenerationV3, type WorldCorpus,
} from './common-v3.ts';
import {
  addDays, chainEnd, currentStint, daysBetween, partyOf, tenureAt, valueAt, VENDOR, WORLD_NOW,
  type AttrId, type AttrValue, type Contract, type Org, type Person, type V3Knobs,
} from './world-v3.ts';
import type { GoldValue, SkillName } from '../../runner/skillopt-method/score.ts';

// ─── Findability ─────────────────────────────────────────────────────────────

export const PATTERNS = ['indirect', 'join', 'aggregation', 'supersession', 'abstention'] as const;
export type Pattern = typeof PATTERNS[number];

/** The search the control runs: the operation, its default page of results, the hits the indirect and join rule reads, the pages aggregation needs, and the clock (gbrain's recency stage reads it). */
export const FINDABILITY = { tool: 'search', limit: 20, top: 5, min_needed_pages: 10, clock: `${WORLD_NOW}T12:00:00.000Z` } as const;
export const FINDABILITY_RULES: Readonly<Record<Pattern, string>> = {
  indirect: `the first ${FINDABILITY.top} hits do not hold every deciding page`,
  join: `the first ${FINDABILITY.top} hits do not hold every deciding page`,
  supersession: 'the newest deciding record is not the first hit',
  aggregation: `an exhaustive reader opens at least ${FINDABILITY.min_needed_pages} pages`,
  abstention: 'none: no page decides the answer, so the near-miss ranks are reported only',
};
export const FINDABILITY_CACHE_PATH = join(import.meta.dir, 'findability-v3-rev1.jsonl');

/** One search the control runs for a task: the text, the patterns whose rules apply, and the pages they read. */
export interface ProbeSpec {
  query: string;
  patterns: Pattern[];
  /** Pages that decide the answer. */
  deciding: string[];
  /** Supersession: the newest deciding record. */
  newest?: string;
  /** Aggregation: the pages an exhaustive reader opens (each member's page and every record it lists as signed by the date). */
  needed?: string[];
  /** Abstention: the near-miss pages. */
  near?: string[];
}
export interface FindabilityProbe {
  query: string;
  patterns: Pattern[];
  /** Each deciding page's rank among the distinct pages the search returns (1 is the first hit); null when it is not on the page of results. */
  deciding: Array<{ slug: string; rank: number | null }>;
  newest?: { slug: string; rank: number | null };
  needed_pages?: number;
  near_miss?: Array<{ slug: string; rank: number | null }>;
  /** The first hits. */
  top: string[];
}
export interface FindabilityRecord { probes: FindabilityProbe[]; fails: string[] }

export type DraftRev1 = { ok: true; candidate: CandidateV3; probes: ProbeSpec[]; priority?: number } | Extract<DraftV3, { ok: false }>;

/** sha256 over every page's slug and text, in slug order: the world a cache was searched on. */
export function worldHash(pages: ReadonlyMap<string, string>): string {
  const h = createHash('sha256');
  for (const [slug, text] of [...pages].sort(([a], [b]) => (a < b ? -1 : 1))) h.update(`${slug}\n${text}\u0000`);
  return h.digest('hex');
}

export interface FindabilityHeader { world_sha256: string; gbrain_version: string; tool: string; limit: number; clock: string; embeddings: 'off'; queries: number }
const FIX = 'run `bun eval/generators/skillopt-method/findability-v3.ts write`';

/** The committed search results, query text to the distinct page slugs the search returned in order. Throws when the file is missing or was searched on another world. */
export function loadFindabilityCache(pages: ReadonlyMap<string, string>, path = FINDABILITY_CACHE_PATH): { header: FindabilityHeader; hits: Map<string, string[]> } {
  if (!existsSync(path)) throw new Error(`findability cache ${path} is missing; ${FIX}`);
  const [head, ...lines] = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const header = JSON.parse(head!) as FindabilityHeader;
  const want = worldHash(pages);
  if (header.world_sha256 !== want) throw new Error(`findability cache was searched on world ${header.world_sha256.slice(0, 12)}, this world is ${want.slice(0, 12)}; ${FIX}`);
  return { header, hits: new Map(lines.map(l => { const r = JSON.parse(l) as { q: string; hits: string[] }; return [r.q, r.hits]; })) };
}

const rankIn = (hits: readonly string[], slug: string) => { const i = hits.indexOf(slug); return i < 0 ? null : i + 1; };

/** One probe's ranks and the rules it breaks. */
export function evaluateProbe(spec: ProbeSpec, hits: readonly string[]): { probe: FindabilityProbe; fails: string[] } {
  const probe: FindabilityProbe = { query: spec.query, patterns: spec.patterns, deciding: spec.deciding.map(slug => ({ slug, rank: rankIn(hits, slug) })), top: hits.slice(0, FINDABILITY.top) };
  if (spec.newest) probe.newest = { slug: spec.newest, rank: rankIn(hits, spec.newest) };
  if (spec.needed) probe.needed_pages = spec.needed.length;
  if (spec.near?.length) probe.near_miss = spec.near.map(slug => ({ slug, rank: rankIn(hits, slug) }));
  const fails: string[] = [];
  const inTop = (r: number | null) => r !== null && r <= FINDABILITY.top;
  for (const p of spec.patterns) {
    if ((p === 'indirect' || p === 'join') && probe.deciding.every(d => inTop(d.rank))) fails.push(`${p}: every deciding page is in the first ${FINDABILITY.top} hits`);
    if (p === 'supersession' && probe.newest?.rank === 1) fails.push(`supersession: the newest deciding record ${spec.newest} is the first hit`);
    if (p === 'aggregation' && (spec.needed?.length ?? 0) < FINDABILITY.min_needed_pages) fails.push(`aggregation: ${spec.needed?.length ?? 0} pages needed`);
  }
  return { probe, fails };
}

/** Every query a set of drafts searches. */
export const probeQueries = (drafts: readonly DraftRev1[]) => [...new Set(drafts.flatMap(d => (d.ok ? d.probes.map(p => p.query) : [])))];

/** Read every ok draft's probes from the cache: a draft that breaks a rule becomes a drop with the reason; each kept draft's record is keyed by its anchor. Throws when a query was never searched. */
export function applyFindability(drafts: readonly DraftRev1[], hits: ReadonlyMap<string, string[]>): { drafts: DraftV3[]; records: Map<string, FindabilityRecord> } {
  const records = new Map<string, FindabilityRecord>();
  const out = drafts.map((d): DraftV3 => {
    if (!d.ok) return d;
    const evaluated = d.probes.map(spec => {
      const h = hits.get(spec.query);
      if (!h) throw new Error(`findability cache has no search for "${spec.query}"; ${FIX}`);
      return evaluateProbe(spec, h);
    });
    const fails = evaluated.flatMap(e => e.fails);
    if (fails.length) return { ok: false, family: d.candidate.family, anchor: d.candidate.anchor.id, reason: `${FINDABILITY_DROP} ${fails.join('; ')}` };
    records.set(d.candidate.anchor.id, { probes: evaluated.map(e => e.probe), fails });
    return { ok: true, candidate: d.candidate, ...(d.priority !== undefined ? { priority: d.priority } : {}) };
  });
  return { drafts: out, records };
}

export interface FamilyFindability {
  family: string;
  patterns: Pattern[];
  rules: string[];
  tasks: number;
  probes: number;
  /** Median rank of the deciding pages over the probes of the family's tasks; a page not on the page of results counts as limit + 1. */
  median_deciding_rank: number | null;
  /** Share of deciding pages in the first 5 hits, and not on the page of results. */
  deciding_in_top: number | null;
  deciding_not_found: number | null;
  median_newest_rank?: number;
  needed_pages?: { min: number; median: number };
  median_near_miss_rank?: number;
}
export interface FindabilityReport {
  search: FindabilityHeader;
  rules: Readonly<Record<Pattern, string>>;
  families: FamilyFindability[];
  tasks: Array<{ task_id: string; family: string; probes: FindabilityProbe[] }>;
}

const median = (xs: readonly number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const asRank = (r: number | null) => r ?? FINDABILITY.limit + 1;
const share = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 1000 : null);

/** Per family and per task, over the placed tasks: the ranks the generation report records. */
export function findabilityReport(header: FindabilityHeader, tasks: readonly MethodTaskV3[], records: ReadonlyMap<string, FindabilityRecord>, families: readonly string[]): FindabilityReport {
  const rows = tasks.map(t => ({ task_id: t.task_id, family: t.family, probes: records.get(t.anchor.id)?.probes ?? [] }));
  const missing = rows.find(r => !r.probes.length);
  if (missing) throw new Error(`findability: task ${missing.task_id} has no probe`);
  return {
    search: header, rules: FINDABILITY_RULES,
    families: families.map(family => {
      const probes = rows.filter(r => r.family === family).flatMap(r => r.probes);
      const patterns = PATTERNS.filter(p => probes.some(x => x.patterns.includes(p)));
      const ranks = probes.flatMap(p => p.deciding.map(d => d.rank));
      const row: FamilyFindability = {
        family, patterns, rules: patterns.map(p => `${p}: ${FINDABILITY_RULES[p]}`), tasks: rows.filter(r => r.family === family).length, probes: probes.length,
        median_deciding_rank: median(ranks.map(asRank)), deciding_in_top: share(ranks.filter(r => r !== null && r <= FINDABILITY.top).length, ranks.length), deciding_not_found: share(ranks.filter(r => r === null).length, ranks.length),
      };
      const newest = probes.flatMap(p => (p.newest ? [asRank(p.newest.rank)] : []));
      if (newest.length) row.median_newest_rank = median(newest)!;
      const needed = probes.flatMap(p => (p.needed_pages !== undefined ? [p.needed_pages] : []));
      if (needed.length) row.needed_pages = { min: Math.min(...needed), median: median(needed)! };
      const near = probes.flatMap(p => (p.near_miss ?? []).map(n => asRank(n.rank)));
      if (near.length) row.median_near_miss_rank = median(near)!;
      return row;
    }),
    tasks: rows,
  };
}

/** Revision 1's assembly: the findability control over the drafts, assembly as in revision 0, and the findability report. */
export function assembleRev1(skill: SkillName, seed: number, knobs: V3Knobs, corpus: WorldCorpus, drafts: readonly DraftRev1[], quotas: QuotasV3, heldOut: readonly string[], notes: readonly string[] = []): SkillGenerationV3 {
  const cache = loadFindabilityCache(corpus.pages);
  const { drafts: screened, records } = applyFindability(drafts, cache.hits);
  const gen = assembleV3(skill, seed, knobs, screened, quotas, { heldOut, notes, findability: true });
  gen.report.findability = findabilityReport(cache.header, gen.tasks, records, Object.keys(quotas));
  return gen;
}

// ─── Oracles: page text only ─────────────────────────────────────────────────

const LINK = (prefix: string) => `\\[([^\\]]+)\\]\\((${prefix}\\/[a-z0-9-]+)\\)`;
const ESC = (s: string) => s.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');

/** The legal entity an account page names, and the day its contracts moved to it. */
export function legalEntityFromText(pages: ReadonlyMap<string, string>, account: string): { name: string; since: string } | null {
  const m = new RegExp(`Since ([A-Z][a-z]+ \\d{1,2}, \\d{4}), its contracts with ${VENDOR.name} have been issued to its legal entity, ([^.\\n]+)\\.`).exec(pages.get(account) ?? '');
  const since = m ? parseLongDate(m[1]!) : null;
  return m && since ? { name: m[2]!, since } : null;
}

/** The customer a contract record names: its title after the colon. */
export const partyFromText = (pages: ReadonlyMap<string, string>, record: string): string | null => /^# [^:\n]+: (.+)$/m.exec(pages.get(record) ?? '')?.[1] ?? null;

/** The Lanterncrest rep an account page names as its owner. */
export function ownerFromText(pages: ReadonlyMap<string, string>, account: string): { name: string; slug: string } | null {
  const m = new RegExp(`^- Account owner at ${VENDOR.name}: ${LINK('people')}$`, 'm').exec(pages.get(account) ?? '');
  return m ? { name: m[1]!, slug: m[2]! } : null;
}

/** Every account page that names `rep` as its owner, in slug order. */
export const accountsOwnedFromText = (pages: ReadonlyMap<string, string>, rep: string): string[] =>
  [...pages.keys()].filter(s => s.startsWith('accounts/') && ownerFromText(pages, s)?.slug === rep).sort();

/** The records an account page lists as signed on or before `date`. */
export function recordsSignedBy(pages: ReadonlyMap<string, string>, account: string, date: string): string[] {
  const section = /## Contract history\n\n([\s\S]*?)(?:\n\n|$)/.exec(pages.get(account) ?? '')?.[1] ?? '';
  return [...section.matchAll(/\]\((contracts\/[a-z0-9-]+)\), signed ([A-Z][a-z]+ \d{1,2}, \d{4})$/gm)].filter(m => parseLongDate(m[2]!)! <= date).map(m => m[1]!);
}

/** The pages an exhaustive reader opens for accounts' terms on `date`: each account page and every record it lists as signed by then. */
export const neededFor = (pages: ReadonlyMap<string, string>, accounts: readonly string[], date: string) => [...new Set(accounts.flatMap(a => [a, ...recordsSignedBy(pages, a, date)]))];

/** The contacts an account page lists as current: name, slug and title. */
export function currentContactsFromText(pages: ReadonlyMap<string, string>, account: string): Array<{ name: string; slug: string; title: string }> {
  const section = /## Contacts\n\n([\s\S]*?)(?:\n\n|$)/.exec(pages.get(account) ?? '')?.[1] ?? '';
  return [...section.matchAll(new RegExp(`^- ${LINK('people')}, ([^(\\n]+) \\(since [A-Z][a-z]+ \\d{4}\\)$`, 'gm'))].map(m => ({ name: m[1]!, slug: m[2]!, title: m[3]! }));
}

// ─── Terms on a date ─────────────────────────────────────────────────────────

export interface TermFact {
  account: Org; attr: AttrId; date: string;
  value: AttrValue; answer: GoldValue;
  record: Contract;
  /** The deciding pages: the record in force, and a rescission that reinstated its value. */
  slugs: string[];
  /** The newest deciding record by signing date. */
  newest: string;
  /** The record in force names the account's legal entity, not the account. */
  alias: boolean;
  /** The value a reader who stops at the records naming the account gives, when it differs. */
  stale: AttrValue | null;
  distractors: GoldValue[];
  distractorSlugs: string[];
  evidence: string;
  key: string;
}

/** An account's term on a date, from the chain and confirmed from the contract pages, with the values a careless answer gives. */
export function termFact(corpus: WorldCorpus, a: Org, attr: AttrId, date: string): TermFact | { reason: string } {
  const { world: w, pages } = corpus;
  const chain = w.chains.get(a.slug)!;
  const g = valueAt(chain, attr, date);
  if (!g) return { reason: `no record sets ${attr} for ${a.slug} on ${date}` };
  const o = valueFromText(pages, a.slug, attr, date);
  if (!o || String(o.value) !== String(g.value) || o.slug !== g.record.slug) return { reason: `oracle: the contract pages give ${o ? `${o.value} on ${o.slug}` : 'no value'} for ${a.slug} ${attr} on ${date}, the chain ${g.value} on ${g.record.slug}` };
  const slugs = [g.record.slug, ...(o.rescission ? [o.rescission] : [])];
  const newest = slugs.map(s => w.contracts.get(s)!).sort((x, y) => x.signed.localeCompare(y.signed)).at(-1)!.slug;
  const party = partyFromText(pages, g.record.slug);
  const legal = legalEntityFromText(pages, a.slug);
  const alias = !!legal && party === legal.name;
  if (alias !== (partyOf(a, g.record) !== a.name)) return { reason: `oracle: ${g.record.slug} names ${party}, the world ${partyOf(a, g.record)}` };
  const own = chain.filter(c => partyOf(a, c) === a.name);
  const staleAt = alias ? valueAt(own, attr, date)?.value ?? null : null;
  const stale = staleAt !== null && String(staleAt) !== String(g.value) ? staleAt : null;
  const wrong = w.mentions.filter(m => m.account === a.slug && m.attr === attr && !m.correct && m.date <= date);
  const pending = chain.filter(c => c.signed <= date && c.effective > date && attr in c.sets).map(c => c.sets[attr]!);
  const answer = goldOf(attr, g.value);
  const distractors = uniqueValues([...(stale !== null ? [stale] : []), ...pending, ...chain.flatMap(c => (attr in c.sets ? [c.sets[attr]!] : [])), valueAt(chain, attr, WORLD_NOW)!.value, ...wrong.map(m => m.value)].map(v => goldOf(attr, v)), [answer]);
  if (!distractors.length) return { reason: `${a.slug} ${attr}: the chain holds no other value` };
  if (attr === 'renewal_date' && distractors.some(d => d.value === date)) return { reason: 'the date asked equals a candidate value' };
  return {
    account: a, attr, date, value: g.value, answer, record: g.record, slugs, newest, alias, stale, distractors,
    distractorSlugs: [...new Set([...chain.filter(c => !slugs.includes(c.slug) && attr in c.sets).map(c => c.slug), ...wrong.map(m => m.page)])],
    evidence: o.evidence + (o.rescission ? `; reinstated by ${o.rescission}` : '') + (alias ? `; the record names ${party}, the legal entity the account page names` : ''),
    key: `val:${a.slug}:${attr}@${g.record.slug}`,
  };
}

/** Up to `n` days on which `record` decides `attr`, clear of every signing and effective date by 3 days, after `from` and before the chain ends. */
export function daysDecidedBy(chain: readonly Contract[], record: Contract, attr: AttrId, int: (lo: number, hi: number) => number, n: number, from = '0000-00-00'): string[] {
  const last = [addDays(WORLD_NOW, -2), chainEnd(chain)].sort()[0]!;
  const changes = [...new Set(chain.flatMap(c => [c.effective, c.signed]))].sort();
  const out = new Set<string>();
  for (let k = 0; k < n * 5 && out.size < n; k++) {
    const d = addDays(record.effective, int(4, 200));
    if (d > last || d < from || valueAt(chain, attr, d)?.record.slug !== record.slug || !changes.every(x => Math.abs(daysBetween(x, d)) >= 3)) continue;
    out.add(d);
  }
  return [...out].sort();
}

/** Accounts whose name is the only one in use on `date`: one that had moved its contracts to its legal entity by then has two. */
export const singleName = (a: Org, date: string) => !a.legal || date < a.legal.since;

// ─── Contacts: the account a person works at ─────────────────────────────────

export interface ContactFact { person: Person; account: Org; title: string; since: string; evidence: string }

/** Current account contacts who are the only current contact with their title there, read from the person's career list and the account's contacts list. */
export function contactFacts(corpus: WorldCorpus): ContactFact[] {
  const { world: w, pages } = corpus;
  const lookalike = new Set([...w.lookalikes.homonyms.flat(), ...w.lookalikes.near.flat()]);
  const out: ContactFact[] = [];
  for (const a of accountsOf(corpus)) {
    const listed = currentContactsFromText(pages, a.slug);
    for (const c of listed) {
      const p = w.people.get(c.slug);
      const cur = p ? currentStint(p) : null;
      if (!p || !cur || lookalike.has(p.slug) || cur.org !== a.slug || cur.title !== c.title || listed.filter(x => x.title === c.title).length !== 1) continue;
      const s = stintFromText(pages, p.slug, WORLD_NOW);
      if ('reason' in s || s.org !== a.slug || s.title !== c.title) continue;
      out.push({ person: p, account: a, title: c.title, since: s.start, evidence: `${p.slug}: "${s.line}"; ${a.slug} lists no other current ${c.title}` });
    }
  }
  return out;
}

// ─── Joins ───────────────────────────────────────────────────────────────────

export const JOIN_ATTRS = ['tier', 'payment', 'notice'] as const satisfies readonly AttrId[];
export type JoinCond = { attr: AttrId; value: AttrValue } | { owner: Person };

export interface JoinFact {
  date: string;
  conds: [JoinCond, JoinCond];
  account: Org;
  /** The deciding pages, one group per condition: the record in force (with a rescission that reinstated its value), or the account page for its owner. */
  groups: [string[], string[]];
  keys: string[];
  /** The accounts a careless reading gives: matching both conditions under the master agreements, now, or four months either side, then matching one. */
  near: Org[];
  evidence: string;
}

/** The phrase a join names one condition with. */
export function condPhrase(c: JoinCond): string {
  if ('owner' in c) return `owned at ${VENDOR.name} by ${c.owner.name}`;
  if (c.attr === 'tier') return `on ${c.value} support`;
  if (c.attr === 'payment') return `on payment terms of net ${c.value}`;
  return `on a ${c.value}-day non-renewal notice period`;
}

/** Every two-condition join on `date` that exactly one account meets, read from every account's pages and checked against the chains. */
export function joinFacts(corpus: WorldCorpus, date: string, pick: <T>(xs: readonly T[], n: number) => T[]): JoinFact[] {
  const { world: w, pages } = corpus;
  const read = new Map<string, Map<AttrId, { value: string; slug: string; resc: string | null }>>();
  for (const a of accountsOf(corpus)) {
    const m = new Map<AttrId, { value: string; slug: string; resc: string | null }>();
    for (const attr of JOIN_ATTRS) {
      const o = valueFromText(pages, a.slug, attr, date);
      const g = valueAt(w.chains.get(a.slug)!, attr, date);
      if (!o || !g || String(o.value) !== String(g.value) || o.slug !== g.record.slug) break;
      m.set(attr, { value: String(o.value), slug: o.slug, resc: o.rescission });
    }
    if (m.size === JOIN_ATTRS.length && ownerFromText(pages, a.slug)?.slug === a.owner) read.set(a.slug, m);
  }
  const at = (s: string, attr: AttrId, d: string) => String(valueAt(w.chains.get(s)!, attr, d)?.value ?? '');
  const out: JoinFact[] = [];
  const pairs: Array<['owner' | AttrId, AttrId]> = [['tier', 'payment'], ['tier', 'notice'], ['payment', 'notice'], ['owner', 'tier'], ['owner', 'payment'], ['owner', 'notice']];
  for (const [x, y] of pairs) {
    const xOf = (s: string, d?: string) => (x === 'owner' ? w.orgs.get(s)!.owner! : d ? at(s, x, d) : read.get(s)!.get(x)!.value);
    const yOf = (s: string, d?: string) => (d ? at(s, y, d) : read.get(s)!.get(y)!.value);
    const byKey = new Map<string, string[]>();
    for (const s of read.keys()) byKey.set(`${xOf(s)}|${yOf(s)}`, [...(byKey.get(`${xOf(s)}|${yOf(s)}`) ?? []), s]);
    for (const [key, members] of byKey) {
      if (members.length !== 1) continue;
      const s = members[0]!;
      const a = w.orgs.get(s)!;
      if (!singleName(a, date)) continue;
      const [kx, ky] = key.split('|') as [string, string];
      const r = read.get(s)!;
      const deciding = [x === 'owner' ? s : r.get(x)!.slug, r.get(y)!.slug];
      if (new Set(deciding).size !== 2) continue;
      const both = (t: string, d: string) => xOf(t, d) === kx && yOf(t, d) === ky;
      const msa = (t: string) => { const m = w.chains.get(t)![0]!; return (x === 'owner' ? xOf(t) : String(m.sets[x])) === kx && String(m.sets[y]) === ky; };
      const others = [...read.keys()].filter(t => t !== s);
      const traps = others.filter(t => msa(t) || both(t, WORLD_NOW) || both(t, addDays(date, -120)) || both(t, addDays(date, 120)));
      const half = others.filter(t => !traps.includes(t) && (xOf(t) === kx || yOf(t) === ky));
      const near = [...traps, ...pick(half, Math.max(0, 4 - traps.length))].map(t => w.orgs.get(t)!);
      if (!near.length) continue;
      const first: JoinCond = x === 'owner' ? { owner: w.people.get(kx)! } : { attr: x, value: valueAt(w.chains.get(s)!, x, date)!.value };
      out.push({
        date, conds: [first, { attr: y, value: valueAt(w.chains.get(s)!, y, date)!.value }], account: a,
        groups: [[deciding[0]!, ...(x !== 'owner' && r.get(x)!.resc ? [r.get(x)!.resc!] : [])], [deciding[1]!, ...(r.get(y)!.resc ? [r.get(y)!.resc!] : [])]],
        keys: [`join:${x}=${kx}:${y}=${ky}@${date}`, ...(x === 'owner' ? [`owner:${s}`] : [`val:${s}:${x}@${r.get(x)!.slug}`]), `val:${s}:${y}@${r.get(y)!.slug}`],
        near,
        evidence: `on ${date}, of ${read.size} accounts read, only ${s} has ${x}=${kx} (${deciding[0]}) and ${y}=${ky} (${deciding[1]})`,
      });
    }
  }
  return out;
}

// ─── Aggregation over a rep's accounts ───────────────────────────────────────

export const GROUP_ATTRS = ['seats', 'price', 'discount'] as const satisfies readonly AttrId[];
export type GroupOp = 'max' | 'min' | 'sum' | 'next-renewal';

export interface GroupFact {
  rep: Person; date: string; attr: AttrId; op: GroupOp;
  members: Org[];
  answer: GoldValue;
  /** max, min and next-renewal: the winner, and its deciding pages. */
  winner: Org | null;
  winnerSlugs: string[];
  /** Per member, its deciding pages. */
  memberSlugs: string[][];
  needed: string[];
  distractors: GoldValue[];
  evidence: string;
  key: string;
}

const isYearLike = (n: number) => n >= 1990 && n <= 2035;

/** Comparisons and totals over every account `rep` owns, on `date`: ownership from the account pages, terms from the contract pages, each checked against the world. */
export function groupFacts(corpus: WorldCorpus, rep: Person, date: string): GroupFact[] {
  const { world: w, pages } = corpus;
  const memberSlugs = accountsOwnedFromText(pages, rep.slug);
  const world = accountsOf(corpus).filter(o => o.owner === rep.slug).map(o => o.slug).sort();
  if (memberSlugs.join() !== world.join() || memberSlugs.length < 3) return [];
  const members = memberSlugs.map(s => w.orgs.get(s)!);
  const needed = neededFor(pages, memberSlugs, date);
  const out: GroupFact[] = [];
  const read = (attr: AttrId) => {
    const rs = members.map(a => ({ a, o: valueFromText(pages, a.slug, attr, date), g: valueAt(w.chains.get(a.slug)!, attr, date) }));
    return rs.every(r => r.o && r.g && String(r.o.value) === String(r.g.value) && r.o.slug === r.g.record.slug) ? rs.map(r => ({ a: r.a, o: r.o! })) : null;
  };
  const slugsOf = (o: { slug: string; rescission: string | null }) => [o.slug, ...(o.rescission ? [o.rescission] : [])];
  const winnerFact = (attr: AttrId, op: GroupOp, rs: NonNullable<ReturnType<typeof read>>, nums: number[], best: number) => {
    const winners = rs.filter((_, i) => nums[i] === best);
    if (winners.length !== 1 || !singleName(winners[0]!.a, date)) return;
    const win = winners[0]!;
    out.push({
      rep, date, attr, op, members, answer: nameValue(win.a.name), winner: win.a, winnerSlugs: slugsOf(win.o), memberSlugs: rs.map(r => slugsOf(r.o)), needed,
      distractors: members.filter(m => m !== win.a).map(m => nameValue(m.name)), evidence: rs.map(r => `${r.a.slug}: ${r.o.evidence}`).join('\n'),
      key: `agg:${rep.slug}:${attr}:${op}@${win.o.slug}`,
    });
  };
  for (const attr of GROUP_ATTRS) {
    const rs = read(attr);
    if (!rs) continue;
    const nums = rs.map(r => Number(r.o.value));
    winnerFact(attr, 'max', rs, nums, Math.max(...nums));
    winnerFact(attr, 'min', rs, nums, Math.min(...nums));
    if (attr !== 'seats') continue;
    const total = nums.reduce((s, n) => s + n, 0);
    const chainOf = (a: Org) => w.chains.get(a.slug)!;
    const sumOf = (f: (a: Org) => number | null) => { const xs = members.map(f); return xs.every((x): x is number => x !== null && !Number.isNaN(x)) ? xs.reduce((s, n) => s + n, 0) : null; };
    const traps = [
      sumOf(a => Number(chainOf(a)[0]!.sets.seats)),
      sumOf(a => Number(valueAt(chainOf(a), 'seats', WORLD_NOW)!.value)),
      sumOf(a => { const c = chainOf(a).filter(x => x.signed <= date && x.sets.seats !== undefined).at(-1); return c ? Number(c.sets.seats) : null; }),
      sumOf(a => Number(/Seats: (\d+)\./.exec(pages.get(a.slug) ?? '')?.[1] ?? NaN)),
      sumOf(a => { const own = chainOf(a).filter(c => partyOf(a, c) === a.name); return Number(valueAt(own, 'seats', date)?.value ?? NaN); }),
    ];
    const asked = new Set([Number(date.slice(0, 4)), Number(date.slice(8, 10))]);
    const distractors = uniqueValues(traps.filter((t): t is number => t !== null && t !== total && !asked.has(t) && !isYearLike(t)).map(t => goldOf('seats', t)));
    if (!distractors.length || asked.has(total) || isYearLike(total)) continue;
    out.push({
      rep, date, attr, op: 'sum', members, answer: goldOf('seats', total), winner: null, winnerSlugs: [], memberSlugs: rs.map(r => slugsOf(r.o)), needed, distractors,
      evidence: rs.map(r => `${r.a.slug}: ${r.o.evidence}`).join('\n') + `\ntotal ${total}`, key: `agg:${rep.slug}:seats:sum@${rs.map(r => r.o.slug).join('+')}`,
    });
  }
  const rd = read('renewal_date');
  if (rd && rd.every(r => String(r.o.value) > date)) {
    const days = rd.map(r => daysBetween(date, String(r.o.value)));
    winnerFact('renewal_date', 'next-renewal', rd, days, Math.min(...days));
  }
  return out;
}

/** The phrase a question compares members with. */
export function groupPhrase(attr: AttrId, op: GroupOp): string {
  if (op === 'next-renewal') return 'the earliest renewal date';
  if (attr === 'seats') return op === 'max' ? 'the most subscribed seats' : 'the fewest subscribed seats';
  if (attr === 'price') return op === 'max' ? 'the highest list price per seat per year' : 'the lowest list price per seat per year';
  return op === 'max' ? 'the largest percentage discount' : 'the smallest percentage discount';
}

// ─── A former role names the person ──────────────────────────────────────────

export interface FormerRoleFact {
  person: Person;
  former: Org; title: string;
  company: Org; founder: Person;
  /** "Corvane Robotics' former head of product" */
  phrase: string;
  deciding: string[];
  distractors: GoldValue[];
  evidence: string;
}

/** People a former role names alone (the only career list that lists that title there as ended), who now work at a company someone else founded. */
export function formerRoleFacts(corpus: WorldCorpus, possessive: (s: string) => string): FormerRoleFact[] {
  const { world: w, pages } = corpus;
  const lookalike = new Set([...w.lookalikes.homonyms.flat(), ...w.lookalikes.near.flat()]);
  const holders = new Map<string, string[]>();
  for (const slug of [...pages.keys()].filter(s => s.startsWith('people/'))) {
    for (const s of careerFromText(pages, slug)) if (s.end) holders.set(`${s.org}|${s.title}`, [...(holders.get(`${s.org}|${s.title}`) ?? []), slug]);
  }
  const out: FormerRoleFact[] = [];
  for (const p of w.people.values()) {
    const cur = currentStint(p);
    if (!cur || lookalike.has(p.slug)) continue;
    const company = w.orgs.get(cur.org)!;
    if (company.kind !== 'company' || !company.founder || company.founder === p.slug) continue;
    const now = stintFromText(pages, p.slug, WORLD_NOW);
    if ('reason' in now || now.org !== company.slug) continue;
    const f = founderFromText(pages, company.slug);
    if ('reason' in f || f.slug !== company.founder) continue;
    const founder = w.people.get(company.founder)!;
    for (const s of careerFromText(pages, p.slug).filter(x => x.end && x.org !== company.slug)) {
      if ((holders.get(`${s.org}|${s.title}`) ?? []).join() !== p.slug || !p.stints.some(x => x.org === s.org && x.title === s.title && x.end)) continue;
      const former = w.orgs.get(s.org)!;
      if (former.kind === 'vendor') continue;
      const formerCeo = tenureAt(former.ceo, WORLD_NOW)?.person;
      const ceo = tenureAt(company.ceo, WORLD_NOW)?.person;
      const distractors = uniqueValues([
        ...(former.founder ? [nameValue(w.people.get(former.founder)!.name)] : []), ...(formerCeo ? [nameValue(w.people.get(formerCeo)!.name)] : []), ...(ceo && ceo !== founder.slug ? [nameValue(w.people.get(ceo)!.name)] : []),
      ], [nameValue(founder.name)]).filter(v => v.value !== p.name);
      if (!distractors.length) continue;
      out.push({
        person: p, former, title: s.title, company, founder, phrase: `${possessive(former.name)} former ${s.title}`, deciding: [p.slug, company.slug, founder.slug], distractors,
        evidence: `${p.slug}: "${s.line}", the only career list with a former ${s.title} at ${former.slug}; now "${now.line}"\n${f.evidence}`,
      });
    }
  }
  return out;
}

// ─── The company that acquired another ───────────────────────────────────────

export interface ParentFact { company: Org; parent: Org; day: string; ceo: Person; deciding: string[]; distractors: GoldValue[]; evidence: string; key: string }

/** The chief executive, on `day`, of the company that acquired `c`: the acquired company's ownership line, then the acquirer's leadership line. */
export function parentFact(corpus: WorldCorpus, c: Org, day: string): ParentFact | { reason: string } {
  const { world: w, pages } = corpus;
  if (!c.acquiredBy || c.acquiredBy.date > addDays(day, -10)) return { reason: `${c.slug} was not acquired by ${day}` };
  const parent = w.orgs.get(c.acquiredBy.org)!;
  const t = tenureAt(parent.ceo, day);
  if (!t) return { reason: `${parent.slug} has no chief executive on ${day}` };
  if (!new RegExp(`was acquired by \\[${ESC(parent.name)}\\]\\(${ESC(parent.slug)}\\)`).test(pages.get(c.slug) ?? '')) return { reason: `${c.slug} does not name its acquirer` };
  const o = roleHolderFromText(pages, parent.slug, 'Chief executive', day);
  if ('reason' in o) return o;
  if (o.slug !== t.person) return { reason: `${parent.slug}'s page names ${o.slug}, the world ${t.person}` };
  const own = tenureAt(c.ceo, day)?.person;
  const distractors = uniqueValues([
    ...(own ? [nameValue(w.people.get(own)!.name)] : []), ...parent.ceo.filter(x => x !== t).map(x => nameValue(w.people.get(x.person)!.name)), ...(parent.founder ? [nameValue(w.people.get(parent.founder)!.name)] : []), ...(c.founder ? [nameValue(w.people.get(c.founder)!.name)] : []),
  ], [nameValue(o.name)]);
  if (!distractors.length) return { reason: 'no other name to confuse' };
  return { company: c, parent, day, ceo: w.people.get(t.person)!, deciding: [c.slug, parent.slug], distractors, evidence: `${c.slug}: acquired by ${parent.slug}; ${o.evidence}`, key: `role:${parent.slug}:chief executive:${t.person}` };
}

// ─── Names no page carries ───────────────────────────────────────────────────

/** A legal-entity-style name built from a real legal entity's stem and another suffix, which no page carries. */
export function absentLegalName(corpus: WorldCorpus, a: Org, suffixes: readonly string[]): string | null {
  if (!a.legal) return null;
  const stem = a.legal.name.split(' ')[0]!;
  const allText = corpus.allText;
  for (const s of suffixes) {
    const name = `${stem} ${s}`;
    if (name !== a.legal.name && !new RegExp(`(?<![a-z0-9])${ESC(name.toLowerCase())}(?![a-z0-9])`).test(allText)) return name;
  }
  return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export const accountsOf = (corpus: WorldCorpus) => [...corpus.world.orgs.values()].filter(o => o.kind === 'account');
export const repsOf = (corpus: WorldCorpus) => [...corpus.world.people.values()].filter(p => p.stints.some(s => s.role === 'vendor') && accountsOf(corpus).some(a => a.owner === p.slug));export const cite = (slugs: readonly string[]) => slugs.map(s => `[Source: ${s}]`).join(' ');
