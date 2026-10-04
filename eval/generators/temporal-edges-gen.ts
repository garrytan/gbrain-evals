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
 * different cue verbs and templates is authored and frozen by the custodian;
 * this module refuses any other set so held-out text never reaches the
 * implementer's tree.
 */
import { Rng, fingerprint } from './seeded.ts';

export const TEMPORAL_EDGES_GENERATOR_VERSION = 'temporal-edges-gen/1';
export const DEV_SEEDS: readonly number[] = [3, 5];
export const PHRASING_SETS = ['A'] as const;
export type PhrasingSet = typeof PHRASING_SETS[number];

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

export function generateTemporalEdgesWorld(opts: { seed: number; phrasing?: string; people?: number; companies?: number }): TemporalEdgesWorld {
  const phrasing = (opts.phrasing ?? 'A') as PhrasingSet;
  if (!PHRASING_SETS.includes(phrasing)) {
    throw new Error(`phrasing set ${opts.phrasing} is held out: only the custodian's sealed generator renders it`);
  }
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
  const dated = [...companyPages, ...rng.shuffle(people.map(p => ({ slug: p.slug, content: renderPerson(p, link) })))];

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

function renderPerson(p: TePerson, link: (slug: string) => string): string {
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
    prose.push(`${p.name} works at ${link(old.company)} as ${old.role}.`);
  } else if (cur && p.rejoin_eu) {
    prose.push(`Previously at ${link(cur.company)}, ${p.name} now runs ${link(cur.company)}'s EU team.`);
  } else if (cur) {
    prose.push(`${p.name} works at ${link(cur.company)} as ${cur.role}.`);
  }
  const named = new Set([cur?.company, p.style === 'stale_summary' ? former[former.length - 1]?.company : undefined]);
  for (const company of [...new Set(former.map(s => s.company))]) {
    if (named.has(company)) continue;
    prose.push(`Earlier, ${p.name} worked at ${link(company)}.`);
  }
  if (p.advises) prose.push(`${p.name} also advises ${link(p.advises.company)}.`);

  const lines: Array<[string, string]> = [];
  p.stints.forEach((s, k) => {
    const prev = p.stints[k - 1];
    if (p.style === 'explicit') {
      lines.push([s.from, `note — Started works_at [[${s.company}]] as ${s.role}`]);
      if (s.until) lines.push([s.until, `note — Ended works_at [[${s.company}]]`]);
      return;
    }
    if (prev && prev.until === s.from) lines.push([s.from, `linkedin — Left ${link(prev.company)} to join ${link(s.company)} as ${s.role}`]);
    else lines.push([s.from, `linkedin — Joined ${link(s.company)} as ${s.role}`]);
    const next = p.stints[k + 1];
    if (s.until && !(next && next.from === s.until)) lines.push([s.until, `linkedin — Left ${link(s.company)}`]);
  });
  if (p.advises) lines.push([p.advises.from, `note — Became an advisor to ${link(p.advises.company)}`]);
  if (p.invests_after_exit) lines.push([p.invests_after_exit.on, `note — Invested in ${link(p.invests_after_exit.company)}'s seed extension`]);
  if (p.alumni_meeting) lines.push([p.alumni_meeting.on, `meeting — Met with the ${link(p.alumni_meeting.company)} alumni group`]);
  lines.sort((a, b) => a[0].localeCompare(b[0]));
  return `---\n${fm.join('\n')}\n---\n\n${prose.join(' ')}\n\n## Timeline\n\n${lines.map(([d, t]) => `- **${d}** | ${t}`).join('\n')}\n`;
}
