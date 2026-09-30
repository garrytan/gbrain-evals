/**
 * N6 world generator: a seeded brain with protected content next to public
 * twins, and the ledger that says which is which.
 *
 * The ledger is the gold. Every protected marker, its class, its source and
 * page, and its public twin come from here; the runner never learns what is
 * protected by asking gbrain. Markers are random lowercase words ending in
 * `q` (so English stemming leaves them intact), unique per seed.
 *
 * Classes (all in source `alpha` unless noted):
 *   private_page    a `visibility: private` note with a body marker, a tag
 *                   marker and a timeline marker, linking to a public hub;
 *                   twin: the same shape without `visibility: private`.
 *   private_take    a Takes row held by a named holder on a public person
 *                   page; twin: a `world` row on the same page.
 *   private_fact    a `private` Facts row on the same person page; twin: a
 *                   `world` row.
 *   derived_atom    an `atom` page with no visibility field (derived pages
 *                   default to private); twin: a plain concept page.
 *   foreign_source  a page in source `beta` at the same slug as an `alpha`
 *                   page, plus a beta-only page; twin: the alpha page.
 *
 * Every class also gets a ghost: values that were never written, so a
 * response to a protected target can be compared with the response to
 * something that does not exist.
 *
 * Usage: bun eval/generators/n6-visibility-gen.ts [--seed N] [--json]
 */
import { createHash } from 'node:crypto';

export const N6_GENERATOR_VERSION = 'n6-visibility-v1';
export const N6_DEFAULT_SEED = 20260930;
export const N6_SOURCES = ['alpha', 'beta'] as const;
/** The source every scoped caller is granted. */
export const N6_GRANTED_SOURCE = 'alpha';

export type N6Class = 'private_page' | 'private_take' | 'private_fact' | 'derived_atom' | 'foreign_source';
export const N6_CLASSES: readonly N6Class[] = ['private_page', 'private_take', 'private_fact', 'derived_atom', 'foreign_source'];

export interface N6Page {
  source_id: string;
  slug: string;
  /** Full markdown as written through put_page. */
  content: string;
}

export interface N6Target {
  slug: string;
  /** A word written only on this target (search and entity probes use it). */
  query: string;
  /** Source to name explicitly, when the target lives outside the ambient scope. */
  source_id?: string;
  holder?: string;
  type?: string;
  tag?: string;
  date?: string;
}

export interface N6ClassSpec {
  class: N6Class;
  /** Protected target: a scoped remote caller must never read it. */
  protected: N6Target;
  /** Public twin of the same shape: every caller must be able to read it (presence control). */
  twin: N6Target;
  /** Never written. Same shape as `protected`. */
  ghost: N6Target;
  /** Markers that must never reach a scoped remote caller. */
  protected_markers: string[];
  /** Slugs whose existence a scoped remote caller must not learn (empty when the slug is shared with a public page). */
  protected_slugs: string[];
  /** Markers every caller should be able to see somewhere. */
  twin_markers: string[];
}

export interface N6Ledger {
  generator_version: string;
  seed: number;
  sources: readonly string[];
  granted_source: string;
  hub_slug: string;
  pages: N6Page[];
  classes: N6ClassSpec[];
  filler_slugs: string[];
}

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

const LETTERS = 'bcdfghjklmnprstvwxz';
const VOWELS = 'aeiou';

export function generateN6World(seed = N6_DEFAULT_SEED): N6Ledger {
  const rand = mulberry32(seed);
  const used = new Set<string>();
  const word = (syllables = 4): string => {
    for (;;) {
      let w = '';
      for (let i = 0; i < syllables; i++) w += LETTERS[Math.floor(rand() * LETTERS.length)] + VOWELS[Math.floor(rand() * VOWELS.length)];
      w += 'q';
      if (!used.has(w)) { used.add(w); return w; }
    }
  };
  const marker = () => `zx${word(5)}`;
  const dayIn2024 = () => {
    const d = new Date(Date.UTC(2024, 0, 1) + Math.floor(rand() * 360) * 86_400_000);
    return d.toISOString().slice(0, 10);
  };

  const hub = `notes/hub-${word(2)}`;
  const pages: N6Page[] = [];
  const classes: N6ClassSpec[] = [];
  const note = (fm: Record<string, string>, body: string, timeline?: string) =>
    `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}\n${timeline ? `\n<!-- timeline -->\n${timeline}\n` : ''}`;

  // private_page
  {
    const [pSlug, tSlug, gSlug] = [`notes/${word()}`, `notes/${word()}`, `notes/${word()}`];
    const [pBody, tBody, gBody] = [marker(), marker(), marker()];
    const [pTag, tTag] = [marker(), marker()];
    const [pTl, tTl] = [marker(), marker()];
    const [pDate, tDate] = [dayIn2024(), dayIn2024()];
    pages.push({ source_id: 'alpha', slug: pSlug, content: note({ title: `Note ${pBody}`, type: 'note', visibility: 'private', tags: `[${pTag}]` }, `Planning memo ${pBody} for the offsite. See [[${hub}]].`, `- **${pDate}** | ${pTl} planning call held`) });
    pages.push({ source_id: 'alpha', slug: tSlug, content: note({ title: `Note ${tBody}`, type: 'note', tags: `[${tTag}]` }, `Planning memo ${tBody} for the offsite. See [[${hub}]].`, `- **${tDate}** | ${tTl} planning call held`) });
    classes.push({
      class: 'private_page',
      protected: { slug: pSlug, query: pBody, type: 'note', tag: pTag, date: pDate },
      twin: { slug: tSlug, query: tBody, type: 'note', tag: tTag, date: tDate },
      ghost: { slug: gSlug, query: gBody, type: 'note', tag: marker(), date: dayIn2024() },
      protected_markers: [pBody, pTag, pTl],
      protected_slugs: [pSlug],
      twin_markers: [tBody, tTag, tTl],
    });
  }

  // private_take and private_fact share one public person page.
  {
    const person = `people/${word(2)}-example`;
    const holder = `${word(2)}-example`;
    const [pTake, tTake, pFact, tFact] = [marker(), marker(), marker(), marker()];
    const personBody = [
      `A person page for the ${person} fixture. See [[${hub}]].`,
      '',
      '## Takes',
      '',
      '<!--- gbrain:takes:begin -->',
      '| # | claim | kind | who | weight | since | source |',
      '|---|-------|------|-----|--------|-------|--------|',
      `| 1 | ${tTake} is the public view | fact | world | 1.0 | 2024-01 | memo |`,
      `| 2 | ${pTake} is suspected privately | take | ${holder} | 0.8 | 2024-02 | chat |`,
      '<!--- gbrain:takes:end -->',
      '',
      '## Facts',
      '',
      '<!--- gbrain:facts:begin -->',
      '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
      '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
      `| 1 | ${tFact} is on record | fact | 1.0 | world | high | 2024-01-01 |  | memo |  |`,
      `| 2 | ${pFact} was said in confidence | fact | 0.9 | private | medium | 2024-02-01 |  | chat |  |`,
      '<!--- gbrain:facts:end -->',
    ].join('\n');
    pages.push({ source_id: 'alpha', slug: person, content: note({ title: `Person ${person.slice(7)}`, type: 'person' }, personBody) });
    const ghostHolder = `${word(2)}-example`;
    classes.push({
      class: 'private_take',
      protected: { slug: person, query: pTake, holder, type: 'person' },
      twin: { slug: person, query: tTake, holder: 'world', type: 'person' },
      ghost: { slug: person, query: marker(), holder: ghostHolder, type: 'person' },
      protected_markers: [pTake],
      protected_slugs: [],
      twin_markers: [tTake],
    });
    classes.push({
      class: 'private_fact',
      protected: { slug: person, query: pFact, type: 'person' },
      twin: { slug: person, query: tFact, type: 'person' },
      ghost: { slug: person, query: marker(), type: 'person' },
      protected_markers: [pFact],
      protected_slugs: [],
      twin_markers: [tFact],
    });
  }

  // derived_atom
  {
    const [pSlug, tSlug, gSlug] = [`atoms/${word()}`, `concepts/${word()}`, `atoms/${word()}`];
    const [pBody, tBody] = [marker(), marker()];
    pages.push({ source_id: 'alpha', slug: pSlug, content: note({ title: `Atom ${pBody}`, type: 'atom', source_slug: hub }, `Extracted claim ${pBody} from a conversation. See [[${hub}]].`) });
    pages.push({ source_id: 'alpha', slug: tSlug, content: note({ title: `Concept ${tBody}`, type: 'concept' }, `Hand-written concept ${tBody}. See [[${hub}]].`) });
    classes.push({
      class: 'derived_atom',
      protected: { slug: pSlug, query: pBody, type: 'atom' },
      twin: { slug: tSlug, query: tBody, type: 'concept' },
      ghost: { slug: gSlug, query: marker(), type: 'atom' },
      protected_markers: [pBody],
      protected_slugs: [pSlug],
      twin_markers: [tBody],
    });
  }

  // foreign_source
  {
    const shared = `projects/${word()}`;
    const betaOnly = `projects/${word()}`;
    const [bShared, aShared, bOnly] = [marker(), marker(), marker()];
    pages.push({ source_id: 'alpha', slug: shared, content: note({ title: `Project ${aShared}`, type: 'project' }, `Alpha project record ${aShared}. See [[${hub}]].`) });
    pages.push({ source_id: 'beta', slug: shared, content: note({ title: `Project ${bShared}`, type: 'project' }, `Beta project record ${bShared}.`) });
    pages.push({ source_id: 'beta', slug: betaOnly, content: note({ title: `Project ${bOnly}`, type: 'project' }, `Beta-only project record ${bOnly}.`) });
    classes.push({
      class: 'foreign_source',
      protected: { slug: betaOnly, query: bOnly, source_id: 'beta', type: 'project' },
      twin: { slug: shared, query: aShared, type: 'project' },
      ghost: { slug: `projects/${word()}`, query: marker(), source_id: 'beta', type: 'project' },
      protected_markers: [bShared, bOnly],
      protected_slugs: [betaOnly],
      twin_markers: [aShared],
    });
  }

  pages.push({ source_id: 'alpha', slug: hub, content: note({ title: 'Team hub', type: 'note' }, 'Hub page for the team. Offsite planning lives here.') });
  const filler_slugs: string[] = [];
  for (let i = 0; i < 8; i++) {
    const slug = `notes/filler-${word(2)}`;
    filler_slugs.push(slug);
    pages.push({ source_id: 'alpha', slug, content: note({ title: `Filler ${i}`, type: 'note' }, `Filler note ${i} about offsite planning logistics.`) });
  }

  return { generator_version: N6_GENERATOR_VERSION, seed, sources: N6_SOURCES, granted_source: N6_GRANTED_SOURCE, hub_slug: hub, pages, classes, filler_slugs };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined)
      .map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function ledgerFingerprint(ledger: N6Ledger): string {
  return createHash('sha256').update(canonical(ledger)).digest('hex');
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--seed');
  const ledger = generateN6World(at >= 0 ? Number(argv[at + 1]) : N6_DEFAULT_SEED);
  if (argv.includes('--json')) console.log(JSON.stringify(ledger, null, 2));
  else console.log(`${ledger.generator_version} seed=${ledger.seed} pages=${ledger.pages.length} classes=${ledger.classes.length} sha256=${ledgerFingerprint(ledger)}`);
}
