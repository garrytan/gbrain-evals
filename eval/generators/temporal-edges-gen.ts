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
 *
 * Render `relation-lines` (P5 delta H7): for a seeded half of the people
 * (sha256 of seed and slug, `rangeRendered`), employment is stated only as
 * typed relation lines with validity ranges, one per stint, under a `## Roles`
 * heading (the grammar never reads lines inside Timeline or other
 * machine-written sections):
 *
 *   - works_at @effective[2019-03-04,2021-05-06) [[companies/acme-example]]
 *   - works_at @effective[2021-05-06,) [[companies/globex-example]]
 *   - advises @effective[2025-03-01,) [[companies/wonka-example]]
 *
 * Their employment prose, join/leave timeline lines and frontmatter `company:`
 * objects are dropped; investment and alumni trap lines stay. The other half
 * render exactly as in the default mode. The ledger and probes do not change.
 *
 * E5 probe (P5 delta H10, `e5Probe`): extra probe people on dedicated probe
 * companies, each with one long current stint (a dated join line) and a later
 * dated advisory line in one of three forms: the phrasing set's `tl_advise`,
 * "Became an advisor at [X]" and "Took an advisory role with [X]" (the two
 * forms the delta preregistration names). The advisory target X is the
 * employer itself (`same`) or another probe company the page also asserts
 * works_at to in an undated sentence (`other`). Any applied single-value
 * closure on a probe person is wrong: nothing in their ledger ended.
 */
import { createHash } from 'node:crypto';
import { Rng, fingerprint } from './seeded.ts';

export const TEMPORAL_EDGES_GENERATOR_VERSION = 'temporal-edges-gen/1';
export const DEV_SEEDS: readonly number[] = [3, 5];
export const PHRASING_SETS = ['A', 'A2', 'A3'] as const;
export const RENDER_MODES = ['prose', 'relation-lines'] as const;
export type RenderMode = typeof RENDER_MODES[number];
export const E5_FORMS = ['tl_advise', 'became_advisor_at', 'took_advisory_role_with'] as const;
export type E5Form = typeof E5_FORMS[number];
export const E5_TARGETS = ['same', 'other'] as const;
export const E5_PROBES_PER_SEED = 36;
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
/**
 * Development sets A2 and A3, written by the P1 implementer after the set B
 * verdict, without sight of set B: wider join/leave verbs, present perfect and
 * promotion prose for current jobs, possessive and event wording for the
 * traps. Development data like A; a re-decision uses a fresh held-out set.
 */
export const PHRASING_A2: PhrasingTemplates = {
  current: '{name} has worked at {company} for several years and is its {role}.',
  stale_summary: '{name} is currently {role} at {company}.',
  rejoin_eu: '{name} returned to {company} and now leads its EU team.',
  former: '{name} spent a few years at {company} earlier on.',
  advises: '{name} advises {company} on hiring.',
  tl_move: 'linkedin — Moved from {prev} to {company} as {role}',
  tl_join: 'linkedin — Was hired by {company} as {role}',
  tl_leave: 'linkedin — Moved on from {company}',
  tl_advise: "note — Joined {company}'s advisory board",
  tl_invest: "note — Joined {company}'s Series B as an angel investor",
  tl_alumni: 'event — Back at {company} for an alumni reunion',
  explicit_start: 'note — Started works_at [[{slug}]] as {role}',
  explicit_end: 'note — Ended works_at [[{slug}]]',
};
export const PHRASING_A3: PhrasingTemplates = {
  current: '{name} was promoted to {role} at {company} last year.',
  stale_summary: '{name} works for {company} as {role}.',
  rejoin_eu: 'After a break, {name} rejoined {company} to run the EU team.',
  former: 'Formerly at {company}.',
  advises: '{name} is an advisor to {company}.',
  tl_move: 'linkedin — Left {prev} for {company} ({role})',
  tl_join: 'linkedin — Started at {company} as {role}',
  tl_leave: 'linkedin — Stepped away from {company}',
  tl_advise: 'note — Started advising {company}',
  tl_invest: 'note — Wrote an angel check into {company} after leaving',
  tl_alumni: 'meeting — Joined the {company} alumni dinner',
  explicit_start: 'note — Started works_at [[{slug}]] as {role}',
  explicit_end: 'note — Ended works_at [[{slug}]]',
};
const DEV_PHRASINGS: Record<(typeof PHRASING_SETS)[number], PhrasingTemplates> = { A: PHRASING_A, A2: PHRASING_A2, A3: PHRASING_A3 };
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
export interface TeE5Probe extends TePerson { e5: { form: E5Form; target: typeof E5_TARGETS[number]; advisory_target: string; advisory_on: string } }
export interface TeCompany { slug: string; name: string }
export interface TePage { slug: string; content: string }
export interface TemporalEdgesWorld {
  seed: number; phrasing: PhrasingSet; companies: TeCompany[]; people: TePerson[];
  /** Company pages first (entity pages exist before notes link to them), then people in shuffled order. */
  pages: TePage[]; fingerprint: string;
  asof_probes: Array<{ id: string; person: string; date: string; gold: string[] }>;
  during_probes: Array<{ id: string; person: string; from: string; until: string; gold: string[] }>;
  /** Render `relation-lines` only: the people whose employment is stated as relation lines with ranges. */
  range_people?: string[];
  /** `e5Probe` only: probe people (not in `people`) and their probe companies (not in `companies`). */
  e5_probes?: TeE5Probe[];
  e5_companies?: TeCompany[];
}

/** The seeded half of the people rendered as relation lines: the low bit of sha256(`${seed}:${slug}`). */
export function rangeRendered(seed: number, slug: string): boolean {
  return (createHash('sha256').update(`${seed}:${slug}`).digest()[0]! & 1) === 1;
}

const E5_COMPANY_WORDS = ['northwind', 'fabrikam', 'tailspin', 'litware', 'proseware', 'adatum'];
const COMPANY_WORDS = ['acme', 'globex', 'initech', 'umbrella', 'hooli', 'vandelay', 'wonka', 'tyrell', 'cyberdyne', 'soylent', 'stark', 'wayne', 'oscorp', 'gringotts'];
const FIRST = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan', 'judy', 'mallory', 'niaj', 'olivia', 'peggy', 'rupert', 'sybil', 'trent', 'victor', 'walter', 'yolanda'];
const ROLES = ['engineer', 'designer', 'product manager', 'CTO', 'head of sales', 'data scientist', 'VP engineering'];
const TODAY_YEAR = 2026;
const DAY = 86_400_000;
const TODAY_LIMIT = Date.UTC(TODAY_YEAR - 1, 11, 31);
const dayIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const iso = (y: number, m: number, d = 1) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const title = (s: string) => s.replace(/(^|[-\s])([a-z])/g, (_, p, c) => (p ? ' ' : '') + c.toUpperCase());

export function generateTemporalEdgesWorld(opts: { seed: number; phrasing?: string; sealedPhrasing?: { id: string; templates: PhrasingTemplates }; people?: number; companies?: number; render?: RenderMode; e5Probe?: boolean }): TemporalEdgesWorld {
  if (opts.render !== undefined && !(RENDER_MODES as readonly string[]).includes(opts.render)) throw new Error(`render ${opts.render}: use ${RENDER_MODES.join(' or ')}`);
  if (opts.phrasing !== undefined && !(PHRASING_SETS as readonly string[]).includes(opts.phrasing)) {
    throw new Error(`phrasing set ${opts.phrasing} is held out: only the custodian's sealed generator renders it`);
  }
  const devSet = (opts.phrasing ?? 'A') as (typeof PHRASING_SETS)[number];
  const phrasing: PhrasingSet = opts.sealedPhrasing ? `sealed:${opts.sealedPhrasing.id}` : devSet;
  const templates = opts.sealedPhrasing ? validatePhrasing(opts.sealedPhrasing.templates) : DEV_PHRASINGS[devSet];
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
  const companyPage = (c: TeCompany): TePage => ({ slug: c.slug, content: `---\ntype: company\ntitle: ${c.name}\n---\n\n${c.name} is a company.\n` });
  const companyPages: TePage[] = companies.map(companyPage);
  const ranged = opts.render === 'relation-lines' ? new Set(people.filter(p => rangeRendered(opts.seed, p.slug)).map(p => p.slug)) : new Set<string>();
  const dated = [...companyPages, ...rng.shuffle(people.map(p => ({ slug: p.slug, content: ranged.has(p.slug) ? renderPersonLines(p, link, templates) : renderPerson(p, link, templates) })))];
  const e5 = opts.e5Probe ? e5ProbeWorld(opts.seed, templates) : null;
  if (e5) dated.push(...e5.companies.map(companyPage), ...e5.pages);

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
  const world = { seed: opts.seed, phrasing, companies, people, pages: dated, asof_probes, during_probes,
    ...(opts.render === 'relation-lines' ? { range_people: [...ranged].sort() } : {}),
    ...(e5 ? { e5_probes: e5.probes, e5_companies: e5.companies } : {}) };
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

/** E5 probe people on their own companies, from an RNG separate from the world's (the world is identical with or without them). */
function e5ProbeWorld(seed: number, t: PhrasingTemplates): { companies: TeCompany[]; probes: TeE5Probe[]; pages: TePage[] } {
  const rng = new Rng(seed * 104_729 + 31);
  const companies: TeCompany[] = E5_COMPANY_WORDS.map(w => ({ slug: `companies/${w}-probe-example`, name: title(w) }));
  const link = (slug: string) => `[${companies.find(c => c.slug === slug)!.name}](../${slug}.md)`;
  const probes: TeE5Probe[] = [];
  const pages: TePage[] = [];
  for (let i = 0; i < E5_PROBES_PER_SEED; i++) {
    const form = E5_FORMS[i % E5_FORMS.length]!;
    const target = E5_TARGETS[Math.floor(i / E5_FORMS.length) % E5_TARGETS.length]!;
    const employer = rng.pick(companies).slug;
    const advisoryTarget = target === 'same' ? employer : rng.pick(companies.filter(c => c.slug !== employer)).slug;
    const startMs = Date.UTC(rng.int(2008, 2014), rng.int(0, 11), rng.int(1, 28));
    const from = dayIso(startMs);
    const advisoryOn = dayIso(startMs + rng.int(3 * 365, 9 * 365) * DAY);
    const role = rng.pick(ROLES);
    const p: TeE5Probe = {
      slug: `people/e5-probe-${i}-example`, name: `${title(rng.pick(FIRST))} P${i}.`, style: 'timeline',
      stints: [{ company: employer, from, until: null, role }], advises: null, invests_after_exit: null, alumni_meeting: null, rejoin_eu: false,
      e5: { form, target, advisory_target: advisoryTarget, advisory_on: advisoryOn },
    };
    const advisory = form === 'tl_advise' ? fill(t.tl_advise, { company: link(advisoryTarget) })
      : form === 'became_advisor_at' ? `note — Became an advisor at ${link(advisoryTarget)}`
      : `linkedin — Took an advisory role with ${link(advisoryTarget)}`;
    const prose = [fill(t.current, { name: p.name, company: link(employer), role }), ...(target === 'other' ? [`${p.name} also works at ${link(advisoryTarget)}.`] : [])];
    const lines = [`- **${from}** | ${fill(t.tl_join, { company: link(employer), role })}`, `- **${advisoryOn}** | ${advisory}`];
    probes.push(p);
    pages.push({ slug: p.slug, content: `---\ntype: person\ntitle: ${p.name}\n---\n\n${prose.join(' ')}\n\n## Timeline\n\n${lines.join('\n')}\n` });
  }
  return { companies, probes, pages };
}

/** H7: employment and advisory roles as typed relation lines with `@effective[start,end)` ranges; trap timeline lines kept. */
function renderPersonLines(p: TePerson, link: (slug: string) => string, t: PhrasingTemplates): string {
  const lines = p.stints.map(s => `- works_at @effective[${s.from},${s.until ?? ''}) [[${s.company}]]`);
  if (p.advises) lines.push(`- advises @effective[${p.advises.from},) [[${p.advises.company}]]`);
  const timeline: Array<[string, string]> = [];
  if (p.invests_after_exit) timeline.push([p.invests_after_exit.on, fill(t.tl_invest, { company: link(p.invests_after_exit.company) })]);
  if (p.alumni_meeting) timeline.push([p.alumni_meeting.on, fill(t.tl_alumni, { company: link(p.alumni_meeting.company) })]);
  timeline.sort((a, b) => a[0].localeCompare(b[0]));
  return `---\ntype: person\ntitle: ${p.name}\n---\n\n${p.name} is a person.\n\n## Roles\n\n${lines.join('\n')}\n`
    + (timeline.length ? `\n## Timeline\n\n${timeline.map(([d, x]) => `- **${d}** | ${x}`).join('\n')}\n` : '');
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
