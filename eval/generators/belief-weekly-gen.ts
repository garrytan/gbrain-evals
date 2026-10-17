/**
 * Synthetic weekly belief changes for the sealed W4 confirmation (W11). This is a port of the generator in gbrain's W4
 * acceptance probe (`test/belief-ledger-weekly-probes.test.ts`, added in gbrain #6866 at v0.60.273.0). The claim text
 * comes from phrasing templates, so a custodian can mint fresh phrasing. Development phrasing `W4` renders exactly
 * the lines that probe writes, so dev seed 20261016 reproduces it.
 *
 * Six company pages start with two facts and one take each. Each of four weeks then applies ten seeded edits:
 * a fact added, removed or re-scored; a take added or re-weighted; a link added or removed; a page created (one fact,
 * one take, one link); or an edit reverted inside the same week. The generator keeps its own record of every page at
 * each week boundary, and the gold diff for a week is the difference between its start and end records.
 * Gold model, as in the probe: a page created in a week is one page change plus one per fact and take; its links
 * are counted on the page, not listed (gbrain docs/designs/BELIEF_LEDGER.md section 15).
 */
export const BELIEF_WEEKLY_GENERATOR_VERSION = 'belief-weekly-v1';
export const DEV_SEEDS = [20261016] as const;
export const WEEKS = 4;
export const OPS_PER_WEEK = 10;
export const COMPANIES = 6;

/** Templates for every belief-changing line. {n} (a counter) is required and keeps lines distinct. */
export interface WeeklyPhrasing {
  /** A starting page's facts and take: {i} (company index), {title}, {slug}, {n}. */
  seed_fact: string;
  seed_take: string;
  /** Facts and takes added during a week, including those of a page created that week: {slug}, {title}, {n}. */
  fact: string;
  take: string;
  /** The fact written and reverted inside one week: {slug}, {title}, {n}. */
  transient: string;
}

export const PHRASING_W4: WeeklyPhrasing = {
  seed_fact: 'Company {i} fact {n}', seed_take: 'Company {i} take {n}',
  fact: '{slug} fact {n}', take: '{slug} take {n}', transient: '{slug} transient {n}',
};

const TEMPLATE_KEYS = ['seed_fact', 'seed_take', 'fact', 'take', 'transient'] as const;
const PLACEHOLDERS: Record<typeof TEMPLATE_KEYS[number], readonly string[]> = {
  seed_fact: ['i', 'title', 'slug', 'n'], seed_take: ['i', 'title', 'slug', 'n'],
  fact: ['title', 'slug', 'n'], take: ['title', 'slug', 'n'], transient: ['title', 'slug', 'n'],
};

/**
 * Check a custodian's templates before any page is written. Each must be a single line of at most 200 characters with
 * no surrounding whitespace, contain {n}, use only its own placeholders, and avoid | and <!-- (they would break the
 * facts and takes tables). Errors name the template, never its text.
 */
export function validateWeeklyPhrasing(raw: unknown): WeeklyPhrasing {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('weekly phrasing needs an object with seed_fact, seed_take, fact, take and transient');
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).filter(k => !(TEMPLATE_KEYS as readonly string[]).includes(k));
  if (extra.length) throw new Error(`weekly phrasing has unknown templates: ${extra.join(', ')}`);
  for (const key of TEMPLATE_KEYS) {
    const t = o[key];
    if (typeof t !== 'string' || !t) throw new Error(`weekly phrasing template ${key} is missing or not a string`);
    if (t.length > 200 || /[\r\n]/.test(t) || t !== t.trim()) throw new Error(`weekly phrasing template ${key} must be one line of at most 200 characters without surrounding whitespace`);
    if (t.includes('|') || t.includes('<!--')) throw new Error(`weekly phrasing template ${key} contains | or <!--, which would break the facts and takes tables`);
    if (!t.includes('{n}')) throw new Error(`weekly phrasing template ${key} needs {n}, which keeps every line distinct`);
    const unknown = [...t.matchAll(/\{([^{}]*)\}/g)].map(m => m[1]!).filter(p => !PLACEHOLDERS[key].includes(p));
    if (unknown.length) throw new Error(`weekly phrasing template ${key} uses placeholders it cannot fill: ${unknown.map(p => `{${p}}`).join(', ')} (allowed: ${PLACEHOLDERS[key].map(p => `{${p}}`).join(', ')})`);
  }
  return { seed_fact: o.seed_fact as string, seed_take: o.seed_take as string, fact: o.fact as string, take: o.take as string, transient: o.transient as string };
}

export interface PageState { facts: Map<string, string>; takes: Map<string, string>; links: Set<string> }
/** One put_page with the page's whole state. transient marks a write that a later write in the same week reverts. */
export interface WeeklyWrite { slug: string; state: PageState; transient: boolean }
export interface WeeklyWeek { writes: WeeklyWrite[]; start: Map<string, PageState>; end: Map<string, PageState> }
export interface WeeklyWorld { seed: number; generator_version: string; initial: WeeklyWrite[]; weeks: WeeklyWeek[] }
export interface WeeklyGold { set: Set<string>; values: Map<string, [string, string]> }

export const titleOf = (slug: string) => slug.split('/')[1]!;
const clone = (p: PageState): PageState => ({ facts: new Map(p.facts), takes: new Map(p.takes), links: new Set(p.links) });
const snapshot = (brain: Map<string, PageState>) => new Map([...brain].map(([k, v]) => [k, clone(v)]));
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

/** The seeded edit history. Random draws happen in the probe's order, so the seed and phrasing alone fix the world. */
export function generateWeeklyWorld(seed: number, phrasing: WeeklyPhrasing = PHRASING_W4): WeeklyWorld {
  const rand = rng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const scores = ['0.5', '0.6', '0.7', '0.8', '0.9'];
  const seen = new Set<string>();
  let n = 0;
  const line = (template: string, v: { slug: string; i?: number }) => {
    const text = template.replace(/\{(i|title|slug|n)\}/g, (_, k: string) => k === 'n' ? String(n) : k === 'i' ? String(v.i) : k === 'slug' ? v.slug : titleOf(v.slug));
    n++;
    if (seen.has(text)) throw new Error(`weekly phrasing renders the same line twice (seed ${seed}, counter ${n - 1}); every template needs {n} where it keeps lines distinct`);
    seen.add(text);
    return text;
  };
  const brain = new Map<string, PageState>();
  const initial: WeeklyWrite[] = [];
  for (let i = 0; i < COMPANIES; i++) {
    const slug = `companies/co-${i}`;
    const first = line(phrasing.seed_fact, { slug, i });
    const second = line(phrasing.seed_fact, { slug, i });
    const state = { facts: new Map([[first, '0.7'], [second, '0.8']]), takes: new Map([[line(phrasing.seed_take, { slug, i }), '0.5']]), links: new Set<string>() };
    brain.set(slug, clone(state));
    initial.push({ slug, state, transient: false });
  }
  const weeks: WeeklyWeek[] = [];
  for (let week = 0; week < WEEKS; week++) {
    const start = snapshot(brain);
    const writes: WeeklyWrite[] = [];
    const write = (slug: string, p: PageState) => { brain.set(slug, clone(p)); writes.push({ slug, state: clone(p), transient: false }); };
    for (let op = 0; op < OPS_PER_WEEK; op++) {
      const slugs = [...brain.keys()];
      const slug = pick(slugs);
      const p = clone(brain.get(slug)!);
      const roll = rand();
      if (roll < 0.15) { const c = line(phrasing.fact, { slug }); p.facts.set(c, pick(scores)); }
      else if (roll < 0.3 && p.facts.size > 1) { p.facts.delete(pick([...p.facts.keys()])); }
      else if (roll < 0.45 && p.facts.size) { const c = pick([...p.facts.keys()]); p.facts.set(c, pick(scores.filter(s => s !== p.facts.get(c)))); }
      else if (roll < 0.55) { const c = line(phrasing.take, { slug }); p.takes.set(c, pick(scores)); }
      else if (roll < 0.65 && p.takes.size) { const c = pick([...p.takes.keys()]); p.takes.set(c, pick(scores.filter(s => s !== p.takes.get(c)))); }
      else if (roll < 0.75) { const target = pick(slugs.filter(s => s !== slug)); if (p.links.has(target)) p.links.delete(target); else p.links.add(target); }
      else if (roll < 0.85) {
        const fresh = `companies/new-${week}-${op}`;
        const fact = line(phrasing.fact, { slug: fresh });
        write(fresh, { facts: new Map([[fact, '0.6']]), takes: new Map([[line(phrasing.take, { slug: fresh }), '0.4']]), links: new Set([slug]) });
        continue;
      } else {
        const c = line(phrasing.transient, { slug });
        writes.push({ slug, state: { ...clone(p), facts: new Map([...p.facts, [c, '0.5']]) }, transient: true });
      }
      write(slug, p);
    }
    weeks.push({ writes, start, end: snapshot(brain) });
  }
  return { seed, generator_version: BELIEF_WEEKLY_GENERATOR_VERSION, initial, weeks };
}

/** Gold changes between two records of the brain, as kind|page|belief|change, and the before/after of every re-scored belief. */
export function weeklyGold(before: Map<string, PageState>, after: Map<string, PageState>): WeeklyGold {
  const set = new Set<string>(); const values = new Map<string, [string, string]>();
  for (const [slug, a] of after) {
    const b = before.get(slug);
    if (!b) {
      set.add(`page|${slug}||added`);
      for (const c of a.facts.keys()) set.add(`fact|${slug}|${c}|added`);
      for (const c of a.takes.keys()) set.add(`take|${slug}|${c}|added`);
      continue;
    }
    for (const [kind, x, y] of [['fact', b.facts, a.facts], ['take', b.takes, a.takes]] as const) {
      for (const [c, v] of y) {
        if (!x.has(c)) set.add(`${kind}|${slug}|${c}|added`);
        else if (x.get(c) !== v) { set.add(`${kind}|${slug}|${c}|changed`); values.set(`${kind}|${slug}|${c}`, [x.get(c)!, v]); }
      }
      for (const c of x.keys()) if (!y.has(c)) set.add(`${kind}|${slug}|${c}|removed`);
    }
    for (const l of a.links) if (!b.links.has(l)) set.add(`link|${slug}|${l}|added`);
    for (const l of b.links) if (!a.links.has(l)) set.add(`link|${slug}|${l}|removed`);
  }
  return { set, values };
}
