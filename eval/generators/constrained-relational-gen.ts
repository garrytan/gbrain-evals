/**
 * Constrained relational questions (plan P3, E4): one seed entity, one typed
 * relation, and one attribute constraint that selects a subset of the seed's
 * neighbors. Built for relational triplet scoring, which reorders a seed's
 * relational neighbors by how well each neighbor and edge match the rest of the
 * question, so every question here has a wide fanout (8 to 14 neighbors) and a
 * small gold subset (1 to 4).
 *
 * A seeded world of investors, companies, employees and meetings, rendered as
 * linked notes; gold comes from the world model alone:
 *   who_at_topic     "Who at <company> works on <topic>?"            gold: employees on that topic
 *   portfolio_sector "What has <investor> invested in within <industry>?"  gold: portfolio companies in it
 *   attended_role    "Which <role>s attended <meeting>?"             gold: attendees with that role
 *
 * Every template is phrased so gbrain's relational-intent parser recognizes it
 * (the arm must fire on at least 80% of questions); the runner reports the fire
 * rate so a phrasing that stops firing is visible.
 *
 * Phrasing and seeds: only set A and the development seeds live here. The
 * held-out phrasing (question templates and page prose) and seeds are authored
 * and frozen by the custodian outside the repository and reach this module
 * only as a template object (`sealedPhrasing`). Any other phrasing name is
 * refused, so held-out text never reaches the implementer's tree.
 */
import { Rng, fingerprint } from './seeded.ts';

export const CONSTRAINED_RELATIONAL_GENERATOR_VERSION = 'constrained-relational-gen/1';
export const DEV_SEEDS: readonly number[] = [11, 13];

export type Template = 'who_at_topic' | 'portfolio_sector' | 'attended_role';

/**
 * Placeholders: {name} {company} {topic} {industry} {role} {a_role} (role with its article) {roles} {Roles} {investor}
 * {meeting} {date} {year} {link}. Employee links read "the team" so the company name is not on the person's page;
 * attendee lines sit under a fixed `## Attendees` heading and must stay a bare link (gbrain's attendance grammar).
 */
export interface PhrasingTemplates {
  q_who_at_topic: string[];
  q_portfolio_sector: string[];
  q_attended_role: string[];
  employee: string;
  employee_extra: string;
  investor_intro: string;
  investment: string;
  company: string;
  meeting_intro: string;
  attendee: string;
  person_role: string;
}

export const PHRASING_A: PhrasingTemplates = {
  q_who_at_topic: ['Who at {company} works on {topic}?', 'Who at {company} leads the {topic} work?'],
  q_portfolio_sector: ['What has {investor} invested in within {industry}?', 'What companies did {investor} invest in that build {industry} products?'],
  q_attended_role: ['Which {roles} attended {meeting}?', '{Roles} who attended {meeting}?'],
  employee: '{name} works at {link} as {a_role} and spends most days on {topic}.',
  employee_extra: 'Most of their recent work has been on {topic}.',
  investor_intro: '{name} is an investor who writes early checks.',
  investment: '- Invested in {link}, a {industry} company.',
  company: '{company} is a {industry} company founded in {year}.',
  meeting_intro: '{meeting} took place on {date}.',
  attendee: '- {link}',
  person_role: '{name} is {a_role}.',
};
const PHRASING_KEYS = Object.keys(PHRASING_A) as Array<keyof PhrasingTemplates>;

export function validatePhrasing(t: unknown): PhrasingTemplates {
  const o = t as Record<string, unknown>;
  const bad = PHRASING_KEYS.filter(k => k.startsWith('q_')
    ? !Array.isArray(o?.[k]) || !(o[k] as unknown[]).length || (o[k] as unknown[]).some(x => typeof x !== 'string' || !x.trim())
    : typeof o?.[k] !== 'string' || !(o[k] as string).trim());
  if (bad.length) throw new Error(`phrasing templates missing or empty: ${bad.join(', ')}`);
  for (const k of ['employee', 'investment', 'attendee'] as const) if (!(o[k] as string).includes('{link}')) throw new Error(`${k} must keep the {link} placeholder`);
  return o as unknown as PhrasingTemplates;
}

export interface CrPage { slug: string; type: 'person' | 'company' | 'meeting'; title: string; compiled_truth: string; timeline: string }
export interface CrQuestion { id: string; template: Template; text: string; seed_slug: string; neighbors: number; gold: string[] }
export interface ConstrainedRelationalWorld {
  seed: number; phrasing: string; fingerprint: string; pages: CrPage[]; questions: CrQuestion[];
}

const FIRST = ['Ada', 'Ben', 'Cara', 'Dev', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivo', 'Jun', 'Kai', 'Lena', 'Milo', 'Nia', 'Omar', 'Pia', 'Quin', 'Rhea', 'Sol', 'Tess', 'Uma', 'Vic', 'Wren', 'Xan', 'Yara', 'Zed'];
const LAST = ['Abara', 'Brandt', 'Castell', 'Dorne', 'Ekwe', 'Faro', 'Galen', 'Hollis', 'Ibsen', 'Jarvi', 'Kerr', 'Lund', 'Marlo', 'Novak', 'Oduya', 'Pryce', 'Quarry', 'Rook', 'Sabin', 'Tolle'];
const COMPANY_WORDS = ['Arbor', 'Basalt', 'Cinder', 'Delta', 'Ember', 'Fathom', 'Glint', 'Harbor', 'Indigo', 'Juniper', 'Kestrel', 'Lumen', 'Meridian', 'Nimbus', 'Orchid', 'Pylon', 'Quartz', 'Ridge', 'Sable', 'Tundra', 'Umbra', 'Vertex', 'Willow', 'Zephyr'];
const COMPANY_SUFFIX = ['Labs', 'Systems', 'Works', 'Health', 'Robotics', 'Data', 'Bio', 'Pay'];
const INDUSTRIES = ['biotech', 'cybersecurity', 'fintech', 'robotics', 'climate tech', 'developer tools', 'edtech', 'health tech'];
const TOPICS = ['payments', 'search', 'infrastructure', 'mobile', 'security', 'data pipelines', 'machine learning', 'billing', 'onboarding', 'growth'];
const EMPLOYEE_ROLES = ['engineer', 'designer', 'product manager', 'data scientist'];
const MEETING_ROLES: Array<{ role: string; plural: string }> = [
  { role: 'founder', plural: 'founders' }, { role: 'investor', plural: 'investors' }, { role: 'advisor', plural: 'advisors' }, { role: 'partner', plural: 'partners' },
];

const fill = (t: string, v: Record<string, string>) => {
  const vars: Record<string, string> = { ...v, ...(v.role ? { a_role: `${/^[aeiou]/i.test(v.role) ? 'an' : 'a'} ${v.role}` } : {}), ...(v.roles ? { Roles: v.roles[0]!.toUpperCase() + v.roles.slice(1) } : {}) };
  return t.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k]! : `{${k}}`));
};
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function generateConstrainedRelationalWorld(opts: { seed: number; phrasing?: string; sealedPhrasing?: { id: string; templates: PhrasingTemplates } }): ConstrainedRelationalWorld {
  if (opts.phrasing && opts.phrasing !== 'A') throw new Error(`phrasing set ${opts.phrasing} is held out: only the custodian's sealed runner renders it`);
  const t = opts.sealedPhrasing ? validatePhrasing(opts.sealedPhrasing.templates) : PHRASING_A;
  const phrasing = opts.sealedPhrasing ? `sealed:${opts.sealedPhrasing.id}` : 'A';
  const rng = new Rng(opts.seed);
  const usedNames = new Set<string>();
  const person = () => {
    for (;;) {
      const name = `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
      if (!usedNames.has(name)) { usedNames.add(name); return { name, slug: `people/${slugify(name)}-${opts.seed}` }; }
    }
  };
  const link = (title: string, slug: string) => `[${title}](${slug})`;

  const companyNames = rng.shuffle(COMPANY_WORDS.flatMap(w => COMPANY_SUFFIX.map(s => `${w} ${s}`))).slice(0, 36);
  const companies = companyNames.map((name, i) => ({ name, slug: `companies/${slugify(name)}-${opts.seed}`, industry: INDUSTRIES[i % INDUSTRIES.length]!, year: String(rng.int(2012, 2023)) }));
  const pages: CrPage[] = [];
  const questions: CrQuestion[] = [];
  const qid = () => `cr-${opts.seed}-${String(questions.length + 1).padStart(3, '0')}`;
  const bodies = new Map<string, string[]>();
  const add = (slug: string, line: string) => bodies.set(slug, [...(bodies.get(slug) ?? []), line]);
  const roleOf = new Map<string, string>();

  for (const c of companies) add(c.slug, fill(t.company, { company: c.name, industry: c.industry, year: c.year }));

  // Employees: the first 10 companies have 9 to 12 people, each on one topic; 2 or 3 topics carry 1 to 4 people.
  const staffed = companies.slice(0, 10);
  for (const c of staffed) {
    const n = rng.int(9, 12);
    const topics = rng.shuffle(TOPICS);
    const staff: Array<{ slug: string; topic: string }> = [];
    for (let i = 0; i < n; i++) {
      const p = person();
      const topic = topics[i % 5]!;
      const role = rng.pick(EMPLOYEE_ROLES);
      roleOf.set(p.slug, role);
      pages.push({ slug: p.slug, type: 'person', title: p.name, timeline: '', compiled_truth: [
        fill(t.employee, { name: p.name, link: link('the company', c.slug), role, topic }),
        fill(t.employee_extra, { company: c.name, topic }),
      ].join('\n\n') });
      staff.push({ slug: p.slug, topic });
    }
    for (const topic of [...new Set(staff.map(s => s.topic))].slice(0, 3)) {
      const gold = staff.filter(s => s.topic === topic).map(s => s.slug);
      if (gold.length < 1 || gold.length > 4) continue;
      questions.push({ id: qid(), template: 'who_at_topic', text: fill(rng.pick(t.q_who_at_topic), { company: c.name, topic }), seed_slug: c.slug, neighbors: staff.length, gold });
    }
  }

  // Investors: 8 people, each with 10 to 14 portfolio companies; up to 3 industries per investor with 1 to 3 holdings.
  for (let i = 0; i < 8; i++) {
    const p = person();
    roleOf.set(p.slug, 'investor');
    const portfolio = rng.shuffle(companies).slice(0, rng.int(10, 14));
    pages.push({ slug: p.slug, type: 'person', title: p.name, timeline: '', compiled_truth: [
      fill(t.investor_intro, { name: p.name }),
      ...portfolio.map(c => fill(t.investment, { link: link(c.name, c.slug), industry: c.industry })),
    ].join('\n') });
    const byIndustry = new Map<string, string[]>();
    for (const c of portfolio) byIndustry.set(c.industry, [...(byIndustry.get(c.industry) ?? []), c.slug]);
    for (const [industry, gold] of rng.shuffle([...byIndustry.entries()]).filter(([, g]) => g.length >= 1 && g.length <= 3).slice(0, 3)) {
      questions.push({ id: qid(), template: 'portfolio_sector', text: fill(rng.pick(t.q_portfolio_sector), { investor: p.name, industry }), seed_slug: p.slug, neighbors: portfolio.length, gold });
    }
  }

  // Meetings: 10 meetings with 8 to 11 attendees of mixed roles from a pool of 30 people.
  const pool = Array.from({ length: 30 }, () => {
    const p = person();
    const r = rng.pick(MEETING_ROLES).role;
    roleOf.set(p.slug, r);
    pages.push({ slug: p.slug, type: 'person', title: p.name, timeline: '', compiled_truth: fill(t.person_role, { name: p.name, role: r }) });
    return p;
  });
  for (let m = 0; m < 10; m++) {
    const host = rng.pick(companies);
    const title = `${host.name} ${rng.pick(['Strategy Review', 'Board Meeting', 'Planning Day', 'Partner Sync'])} ${2024 + (m % 2)}-${String(m + 1).padStart(2, '0')}`;
    const slug = `meetings/${slugify(title)}-${opts.seed}`;
    const date = `${2024 + (m % 2)}-${String(m + 1).padStart(2, '0')}-${String(rng.int(1, 28)).padStart(2, '0')}`;
    const attendees = rng.shuffle(pool).slice(0, rng.int(8, 11));
    pages.push({ slug, type: 'meeting', title, timeline: '', compiled_truth: [
      fill(t.meeting_intro, { meeting: title, date }),
      ['## Attendees', ...attendees.map(a => fill(t.attendee, { link: link(a.name, a.slug) }))].join('\n'),
    ].join('\n\n') });
    for (const { role, plural } of rng.shuffle(MEETING_ROLES).slice(0, 2)) {
      const gold = attendees.filter(a => roleOf.get(a.slug) === role).map(a => a.slug);
      if (gold.length < 1 || gold.length > 4) continue;
      questions.push({ id: qid(), template: 'attended_role', text: fill(rng.pick(t.q_attended_role), { roles: plural, meeting: title }), seed_slug: slug, neighbors: attendees.length, gold });
    }
  }

  for (const c of companies) pages.push({ slug: c.slug, type: 'company', title: c.name, timeline: '', compiled_truth: bodies.get(c.slug)!.join('\n\n') });
  return { seed: opts.seed, phrasing, fingerprint: fingerprint({ pages, questions }), pages, questions };
}
