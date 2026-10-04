/**
 * Temporal typed edges (P1, E1): a seeded employment ledger rendered as linked
 * prose, with gold derived from the ledger alone.
 *
 * Each person holds one to four employment stints (with gaps and rejoins).
 * Pages carry what real notes carry: present-tense prose for the current
 * employer, past tense for earlier ones, dated join/leave timeline lines, the
 * explicit relationship grammar ("Ended works_at [[companies/x]]"), and
 * frontmatter `company:` objects with since/until. A share of people keep a
 * stale summary that still names the employer they left, which only the
 * dated timeline corrects.
 *
 * Traps that must not close or reopen anything: an advisor role at another
 * company while employed, an investment in a former employer after leaving,
 * an alumni meeting at a former employer dated after the move, and a
 * "previously at X, now runs X's EU team" rejoin.
 *
 * Phrasing: only set A (development) lives here. A held-out phrasing set with
 * different cue verbs and templates is authored and frozen by the custodian
 * and kept outside the repository; it reaches this module only as a template
 * object the custodian's runner loads from custody (`sealedPhrasing`). A
 * phrasing name other than "A" is refused, so held-out text never reaches the
 * implementer's tree.
 */
import { Rng, fingerprint } from './seeded.ts';

export const TEMPORAL_EDGES_GENERATOR_VERSION = 'temporal-edges-gen/1';
export const DEV_SEEDS: readonly number[] = [3, 5];
export const PHRASING_SETS = ['A'] as const;
export type PhrasingSet = typeof PHRASING_SETS[number] | `sealed:${string}`;

/** Line templates. Placeholders: {name} {company} (a link) {slug} {role} {prev} (a link). */
export interface PhrasingTemplates {
  current: string; stale_summary: string; rejoin_eu: string; former: string; advises: string;
  tl_move: string; tl_join: string; tl_leave: string; tl_advise: string; tl_invest: string; tl_alumni: string;
  explicit_start: string; explicit_end: string;
}
export const PHRASING_A: PhrasingTemplates = {
  current: '{name} works at {company} as {role}.',
  stale_summary: '{name} works at {company} as {role}.',
  rejoin_eu: "Previously at {company}, {name} now runs {company}'s EU team.",
  former: 'Earlier, {name} worked at {company}.',
  advises: '{name} also advises {company}.',
  tl_move: 'linkedin — Left {prev} to join {company} as {role}',
  tl_join: 'linkedin — Joined {company} as {role}',
  tl_leave: 'linkedin — Left {company}',
  tl_advise: 'note — Became an advisor to {company}',
  tl_invest: "note — Invested in {company}'s seed extension",
  tl_alumni: 'meeting — Met with the {company} alumni group',
  explicit_start: 'note — Started works_at [[{slug}]] as {role}',
  explicit_end: 'note — Ended works_at [[{slug}]]',
};
export const PHRASING_KEYS = Object.keys(PHRASING_A) as Array<keyof PhrasingTemplates>;

export function validatePhrasing(t: unknown): PhrasingTemplates {
  const o = t as Record<string, unknown>;
  const missing = PHRASING_KEYS.filter(k => typeof o?.[k] !== 'string' || !(o[k] as string).trim());
  if (missing.length) throw new Error(`phrasing templates missing: ${missing.join(', ')}`);
  for (const k of ['explicit_start', 'explicit_end'] as const) if (!(o[k] as string).includes('[[{slug}]]')) throw new Error(`${k} must keep the [[{slug}]] link grammar`);
  return o as unknown as PhrasingTemplates;
}

const fill = (t: string, v: Record<string, string>) => t.replace(/\{(name|company|slug|role|prev)\}/g, (_, k: string) => v[k] ?? '');

export interface Stint { company: string; from: string; until: string | null; role: string }
export type PersonStyle = 'timeline' | 'explicit' | 'frontmatter' | 'stale_summary';
export interface TePerson {
  slug: string; name: string; style: PersonStyle; stints: Stint[];
  advises: { company: string; from: string } | null;
  invests_after_exit: { company: string; on: string } | null;
  alumni_meeting: { company: string; on: string } | null;
  rejoin_eu: boolean;
}
export interface TeCompany { slug: string; name: string }
export interface TePage { slug: string; content: string }
export interface TemporalEdgesWorld {
  seed: number; phrasing: PhrasingSet; companies: TeCompany[]; people: TePerson[];
  /** Company pages first (entity pages exist before notes link to them), then people in shuffled order. */
  pages: TePage[]; fingerprint: string;
  asof_probes: Array<{ id: string; person: string; date: string; gold: string[] }>;
  during_probes: Array<{ id: string; person: string; from: string; until: string; gold: string[] }>;
}

const COMPANY_WORDS = ['acme', 'globex', 'initech', 'umbrella', 'hooli', 'vandelay', 'wonka', 'tyrell', 'cyberdyne', 'soylent', 'stark', 'wayne', 'oscorp', 'gringotts'];
const FIRST = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan', 'judy', 'mallory', 'niaj', 'olivia', 'peggy', 'rupert', 'sybil', 'trent', 'victor', 'walter', 'yolanda'];
const ROLES = ['engineer', 'designer', 'product manager', 'CTO', 'head of sales', 'data scientist', 'VP engineering'];
const TODAY_YEAR = 2026;
const DAY = 86_400_000;
const TODAY_LIMIT = Date.UTC(TODAY_YEAR - 1, 11, 31);
const dayIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const iso = (y: number, m: number, d = 1) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const title = (s: string) => s.replace(/(^|[-\s])([a-z])/g, (_, p, c) => (p ? ' ' : '') + c.toUpperCase());

export function generateTemporalEdgesWorld(opts: { seed: number; phrasing?: string; sealedPhrasing?: { id: string; templates: PhrasingTemplates }; people?: number; companies?: number }): TemporalEdgesWorld {
  if (opts.phrasing !== undefined && !(PHRASING_SETS as readonly string[]).includes(opts.phrasing)) {
    throw new Error(`phrasing set ${opts.phrasing} is held out: only the custodian's sealed generator renders it`);
  }
  const phrasing: PhrasingSet = opts.sealedPhrasing ? `sealed:${opts.sealedPhrasing.id}` : 'A';
  const templates = opts.sealedPhrasing ? validatePhrasing(opts.sealedPhrasing.templates) : PHRASING_A;
  const rng = new Rng(opts.seed * 7919 + 17);
  const companies: TeCompany[] = rng.shuffle(COMPANY_WORDS).slice(0, opts.companies ?? 12)
    .map(w => ({ slug: `companies/${w}-example`, name: title(w) }));
  const styles: PersonStyle[] = ['timeline', 'explicit', 'frontmatter', 'stale_summary'];
  const people: TePerson[] = [];
  for (let i = 0; i < (opts.people ?? 80); i++) {
    const n = rng.int(1, 4);
    let day = Date.UTC(rng.int(2008, 2016), rng.int(0, 11), rng.int(1, 28));
    const stints: Stint[] = [];
    for (let k = 0; k < n; k++) {
      const pool = companies.filter(c => c.slug !== stints[stints.length - 1]?.company);
      const rejoin = k >= 2 && rng.float() < 0.25;
      const company = rejoin ? stints[k - 2].company : rng.pick(pool).slug;
      const from = dayIso(day);
      const end = day + rng.int(300, 1500) * DAY;
      const last = k === n - 1 || end >= TODAY_LIMIT;
      if (last) { stints.push({ company, from, until: rng.float() < 0.85 ? null : dayIso(Math.min(end, TODAY_LIMIT - 30 * DAY)), role: rng.pick(ROLES) }); break; }
      stints.push({ company, from, until: dayIso(end), role: rng.pick(ROLES) });
      day = end + (rng.float() < 0.5 ? 0 : rng.int(30, 400) * DAY);
      if (day >= TODAY_LIMIT) break;
    }
    const style = n >= 2 ? styles[i % styles.length] : (i % 2 ? 'timeline' : 'frontmatter');
    const current = stints.find(s => s.until === null) ?? null;
    const former = stints.filter(s => s.until !== null);
    const lastExit = former[former.length - 1];
    people.push({
      slug: `people/${rng.pick(FIRST)}-${i}-example`, name: `${title(rng.pick(FIRST))} ${String.fromCharCode(65 + (i % 26))}.`,
      style, stints,
      advises: current && rng.float() < 0.2 ? { company: rng.pick(companies.filter(c => !stints.some(s => s.company === c.slug))).slug, from: iso(TODAY_YEAR - 1, rng.int(1, 6)) } : null,
      invests_after_exit: lastExit && rng.float() < 0.2 ? { company: lastExit.company, on: iso(Number(lastExit.until!.slice(0, 4)) + 1 > TODAY_YEAR - 1 ? TODAY_YEAR - 1 : Number(lastExit.until!.slice(0, 4)) + 1, 7, 15) } : null,
      alumni_meeting: lastExit && current && rng.float() < 0.25 ? { company: lastExit.company, on: iso(TODAY_YEAR - 1, 9, 10) } : null,
      rejoin_eu: false,
    });
  }
  for (const p of people) {
    const cur = p.stints.find(s => s.until === null);
    if (cur && p.stints.filter(s => s.company === cur.company).length > 1 && p.style === 'timeline') p.rejoin_eu = true;
  }

  const name = (slug: string) => companies.find(c => c.slug === slug)!.name;
  const link = (slug: string) => `[${name(slug)}](../${slug}.md)`;
  const companyPages: TePage[] = companies.map(c => ({ slug: c.slug, content: `---\ntype: company\ntitle: ${c.name}\n---\n\n${c.name} is a company.\n` }));
  const dated = [...companyPages, ...rng.shuffle(people.map(p => ({ slug: p.slug, content: renderPerson(p, link, templates) })))];

  const asof_probes: TemporalEdgesWorld['asof_probes'] = [];
  const during_probes: TemporalEdgesWorld['during_probes'] = [];
  for (const p of people) {
    const first = Number(p.stints[0].from.slice(0, 4));
    for (let k = 0; k < 3; k++) {
      const date = iso(rng.int(first, TODAY_YEAR - 1), rng.int(1, 12), rng.int(1, 28));
      asof_probes.push({ id: `asof:${p.slug}:${date}`, person: p.slug, date, gold: employersAt(p, date) });
    }
    const y = rng.int(first, TODAY_YEAR - 1);
    const from = iso(y, 1, 1), until = iso(y + 1, 1, 1);
    during_probes.push({ id: `during:${p.slug}:${y}`, person: p.slug, from, until, gold: employersDuring(p, from, until) });
  }
  const world = { seed: opts.seed, phrasing, companies, people, pages: dated, asof_probes, during_probes };
  return { ...world, fingerprint: fingerprint({ v: TEMPORAL_EDGES_GENERATOR_VERSION, ...world }) };
}

export function currentEmployers(p: TePerson): string[] {
  return [...new Set(p.stints.filter(s => s.until === null).map(s => s.company))].sort();
}
export function employersAt(p: TePerson, date: string): string[] {
  return [...new Set(p.stints.filter(s => s.from <= date && (s.until === null || date < s.until)).map(s => s.company))].sort();
}
export function employersDuring(p: TePerson, from: string, until: string): string[] {
  return [...new Set(p.stints.filter(s => s.from < until && (s.until === null || s.until > from)).map(s => s.company))].sort();
}

function renderPerson(p: TePerson, link: (slug: string) => string, t: PhrasingTemplates): string {
  const cur = p.stints.find(s => s.until === null) ?? null;
  const former = p.stints.filter(s => s.until !== null);
  const fm: string[] = ['type: person', `title: ${p.name}`];
  if (p.style === 'frontmatter') {
    fm.push('company:');
    for (const s of p.stints) fm.push(`  - { name: ${s.company}, since: ${s.from}${s.until ? `, until: ${s.until}` : ''} }`);
  }
  const prose: string[] = [];
  if (p.style === 'stale_summary' && former.length) {
    const old = former[former.length - 1];
    prose.push(fill(t.stale_summary, { name: p.name, company: link(old.company), role: old.role }));
  } else if (cur && p.rejoin_eu) {
    prose.push(fill(t.rejoin_eu, { name: p.name, company: link(cur.company) }));
  } else if (cur) {
    prose.push(fill(t.current, { name: p.name, company: link(cur.company), role: cur.role }));
  }
  const named = new Set([cur?.company, p.style === 'stale_summary' ? former[former.length - 1]?.company : undefined]);
  for (const company of [...new Set(former.map(s => s.company))]) {
    if (named.has(company)) continue;
    prose.push(fill(t.former, { name: p.name, company: link(company) }));
  }
  if (p.advises) prose.push(fill(t.advises, { name: p.name, company: link(p.advises.company) }));

  const lines: Array<[string, string]> = [];
  p.stints.forEach((s, k) => {
    const prev = p.stints[k - 1];
    if (p.style === 'explicit') {
      lines.push([s.from, fill(t.explicit_start, { slug: s.company, role: s.role })]);
      if (s.until) lines.push([s.until, fill(t.explicit_end, { slug: s.company })]);
      return;
    }
    if (prev && prev.until === s.from) lines.push([s.from, fill(t.tl_move, { prev: link(prev.company), company: link(s.company), role: s.role })]);
    else lines.push([s.from, fill(t.tl_join, { company: link(s.company), role: s.role })]);
    const next = p.stints[k + 1];
    if (s.until && !(next && next.from === s.until)) lines.push([s.until, fill(t.tl_leave, { company: link(s.company) })]);
  });
  if (p.advises) lines.push([p.advises.from, fill(t.tl_advise, { company: link(p.advises.company) })]);
  if (p.invests_after_exit) lines.push([p.invests_after_exit.on, fill(t.tl_invest, { company: link(p.invests_after_exit.company) })]);
  if (p.alumni_meeting) lines.push([p.alumni_meeting.on, fill(t.tl_alumni, { company: link(p.alumni_meeting.company) })]);
  lines.sort((a, b) => a[0].localeCompare(b[0]));
  return `---\n${fm.join('\n')}\n---\n\n${prose.join(' ')}\n\n## Timeline\n\n${lines.map(([d, x]) => `- **${d}** | ${x}`).join('\n')}\n`;
}
