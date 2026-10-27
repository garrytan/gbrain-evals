/**
 * Agent retrieval shapes (registry id `agent-retrieval-shapes`): seeded world
 * generator and independent gold oracle.
 *
 * Fifteen probe families (E1 to E15) reproduce, on invented data, retrieval
 * failure shapes an operator agent reported on a large multi-source
 * production brain (gbrain issues #4612, #6058 and #7153 to #7165). Each
 * family writes its own pages with its own invented vocabulary, so one
 * family's pages never answer another family's probe.
 *
 * `generateArsLedger({ seed })` builds a deterministic LEDGER: the pages as
 * written (source, slug, frontmatter, body), the image files E14 imports,
 * and the probes (query text, op parameters, family, variant). It never
 * writes gold.
 *
 * `deriveArsGold(ledger)` is the independent oracle. It re-parses the
 * rendered Markdown the runner writes (frontmatter and body text) and
 * applies one rule per family: the page whose body holds an identifier, the
 * target a stub says it was merged into, the page whose frontmatter matches
 * a partner, cycle and outcome, the person page whose title matches a name
 * variant after the rewrite gbrain#7160 asks for, and so on. It throws when
 * its answer disagrees with the generator's design (a solvability control),
 * so a generator bug cannot become gold. Gold never comes from gbrain output.
 *
 * All names are fictional: surnames carry "-Example", companies end in
 * "Example", identifiers use the 555-01xx fictional phone range, example.org
 * mail and random hex.
 */
import { createHash } from 'node:crypto';

export const ARS_GENERATOR_VERSION = 'agent-retrieval-shapes-gen/1.0.0';
export const ARS_DEFAULT_SEED = 20261020;
export const ARS_SOURCES = ['default', 'source-a', 'source-b'] as const;
export type ArsSource = typeof ARS_SOURCES[number];

export const ARS_FAMILIES = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9', 'E10', 'E11', 'E12', 'E13', 'E14', 'E15'] as const;
export type ArsFamily = typeof ARS_FAMILIES[number];

/** The chunker's documented hard cap on one chunk (gbrain src/core/chunkers/recursive.ts, ChunkOptions.maxChars default). */
export const ARS_CHUNK_CAP_CHARS = 6000;
/** Rows scored per ranking probe. */
export const ARS_TOP_K = 10;
/** Rows requested per ranking probe (the issues' probes used --limit 20). */
export const ARS_LIMIT = 20;
/** Honorific and job-title prefixes the E6/E7 oracle strips before matching. */
export const HONORIFICS = ['dr', 'dr.', 'mayor', 'senator', 'ceo', 'mr', 'mr.', 'ms', 'ms.', 'prof', 'prof.', 'judge'] as const;
/** Common diminutives (first name to diminutive); the E6 oracle reads this table, never the ledger. */
export const DIMINUTIVES: Readonly<Record<string, string>> = {
  Katherine: 'Kate', William: 'Bill', Robert: 'Bob', Elizabeth: 'Liz', Margaret: 'Peggy', Theodore: 'Ted',
};

export interface ArsPage {
  source: ArsSource;
  slug: string;
  family: ArsFamily;
  /** What the page is in its family's design (target, twin, stub, distractor, ...). */
  role: string;
  frontmatter: Record<string, string | string[]>;
  body: string;
}

/** A PNG E14 imports through gbrain's image importer (every file holds the same 1x1 PNG; the names differ). */
export interface ArsImage { slug: string; file: string; family: 'E14' }

export type ArsSurface = 'search' | 'query' | 'entity';

export interface ArsProbe {
  id: string;
  family: ArsFamily;
  /** Variant inside the family: default, types-company, filter, honorific, ... */
  variant: string;
  surfaces: ArsSurface[];
  /** search/query text or the entity name. */
  text: string;
  /** Extra operation parameters (source_id, types, return_unit, where). */
  params: Record<string, unknown>;
  /** A negative control: the correct answer is a refusal, an empty result or the absence of a defect. */
  negative: boolean;
  /** The generator's design, checked against the oracle; never used as gold. */
  design: Record<string, unknown>;
}

export interface ArsLedger {
  version: string;
  seed: number;
  pages: ArsPage[];
  images: ArsImage[];
  probes: ArsProbe[];
}

export type ArsGold =
  /** need 'first': the target is the first distinct page; 'above': the target is returned and no not_above page ranks over it. */
  | { kind: 'rank'; target: string; need: 'first' | 'above'; not_above?: string[]; family_pages?: string[]; family_max_top5?: number }
  | { kind: 'twin'; slug: string; keys: string[] }
  | { kind: 'resolve'; key: string; forbidden_suggestions: string[] }
  | { kind: 'refuse'; candidates: string[]; forbidden_suggestions: string[] }
  | { kind: 'mentions'; keys: string[] }
  | { kind: 'no-mentions' }
  | { kind: 'chunk-cap'; cap: number; page: string }
  | { kind: 'no-stage'; stage: string }
  | { kind: 'empty' }
  | { kind: 'known-item'; target: string };

export const pageKey = (source: string, slug: string) => `${source}:${slug}`;

// ─── Rendering (what the runner writes) ────────────────────────────────

export function renderPage(p: Pick<ArsPage, 'frontmatter' | 'body'>): string {
  const yaml = Object.entries(p.frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
  return `---\n${yaml}\n---\n${p.body}\n`;
}

export interface ParsedPage { source: string; slug: string; frontmatter: Record<string, unknown>; title: string; type: string; body: string }

/** The oracle's own reader of a rendered page. */
export function parseRendered(source: string, slug: string, text: string): ParsedPage {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`oracle: ${slug} has no frontmatter block`);
  const frontmatter: Record<string, unknown> = {};
  for (const line of m[1].split('\n')) {
    const at = line.indexOf(': ');
    frontmatter[line.slice(0, at)] = JSON.parse(line.slice(at + 2));
  }
  return { source, slug, frontmatter, title: String(frontmatter.title ?? ''), type: String(frontmatter.type ?? ''), body: m[2].trimEnd() };
}

// ─── Seeded randomness and vocabulary ──────────────────────────────────

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

const ONSETS = ['b', 'br', 'c', 'd', 'dr', 'f', 'g', 'gl', 'h', 'k', 'l', 'm', 'n', 'p', 'qu', 'r', 's', 'st', 't', 'tr', 'v', 'w', 'z'];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'ai', 'ou'];
const CODAS = ['', 'n', 'r', 'l', 'm', 'x', 'nd', 'rk', 'sk', 'th'];
const FIRST_NAMES = ['Nina', 'Tomas', 'Ilse', 'Ravi', 'Mira', 'Oskar', 'Lena', 'Pavel', 'Ines', 'Dario', 'Hana', 'Felix', 'Greta', 'Joel', 'Vera', 'Anton',
  'Sofia', 'Emil', 'Ada', 'Leon', 'Clara', 'Hugo', 'Maren', 'Otto', 'Rosa', 'Ivo', 'Tess', 'Bruno', 'Elin', 'Kofi', 'Amara', 'Basil', 'Celia', 'Dmitri',
  'Esther', 'Farid', 'Gemma', 'Hector', 'Iris', 'Jonas', 'Kira', 'Luca', 'Malin', 'Nils', 'Odile', 'Priya', 'Quentin', 'Runa', 'Selma', 'Tariq'];
const cap = (w: string) => w[0].toUpperCase() + w.slice(1);
const slugPart = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

interface Rng { int: (n: number) => number; shuffle: <T>(xs: readonly T[]) => T[]; word: () => string; first: () => string; hex: (n: number) => string }

function makeRng(seed: number): Rng {
  const next = mulberry32(seed);
  const used = new Set<string>();
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T,>(xs: readonly T[]) => xs[int(xs.length)];
  const firstPool = [...FIRST_NAMES];
  return {
    int,
    shuffle: <T,>(xs: readonly T[]) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = int(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; },
    word: () => {
      for (;;) {
        const w = pick(ONSETS) + pick(VOWELS) + pick(ONSETS) + pick(VOWELS) + pick(CODAS);
        if (w.length >= 6 && w.length <= 9 && !used.has(w)) { used.add(w); return w; }
      }
    },
    first: () => {
      if (!firstPool.length) throw new Error('generator: first-name pool exhausted');
      return firstPool.splice(int(firstPool.length), 1)[0];
    },
    hex: (n: number) => Array.from({ length: n }, () => '0123456789abcdef'[int(16)]).join(''),
  };
}

// ─── World ──────────────────────────────────────────────────────────────

export interface ArsWorldOptions { seed?: number; families?: readonly ArsFamily[] }

export function generateArsLedger(opts: ArsWorldOptions = {}): ArsLedger {
  const seed = opts.seed ?? ARS_DEFAULT_SEED;
  const rng = makeRng(seed);
  const pages: ArsPage[] = [];
  const images: ArsImage[] = [];
  const probes: ArsProbe[] = [];
  const page = (p: ArsPage) => { pages.push(p); };
  const probe = (p: Omit<ArsProbe, 'negative' | 'params' | 'design'> & Partial<Pick<ArsProbe, 'negative' | 'params' | 'design'>>) => {
    probes.push({ negative: false, params: {}, design: {}, ...p });
  };
  const RANK: ArsSurface[] = ['search', 'query'];
  const person = () => {
    const first = rng.first();
    const stem = cap(rng.word());
    return { first, stem, name: `${first} ${stem}-Example`, slug: `people/${slugPart(first)}-${slugPart(stem)}-example` };
  };

  // E1: twin collapse. 30 slugs in both federated sources (same body, different type), 30 single-source distractors.
  for (let i = 0; i < 30; i++) {
    const a = rng.word(), b = rng.word();
    const slug = `concepts/${a}-${b}`;
    const body = `${cap(a)} ${b} is the shared playbook for the ${a} ${b} rollout. Owners review the ${a} ${b} checklist every quarter and record decisions here.`;
    page({ source: 'source-a', slug, family: 'E1', role: 'twin', frontmatter: { type: 'concept', title: `${cap(a)} ${b}` }, body });
    page({ source: 'source-b', slug, family: 'E1', role: 'twin', frontmatter: { type: 'note', title: `${cap(a)} ${b}` }, body });
    const d = rng.word();
    page({ source: i % 2 ? 'source-a' : 'source-b', slug: `notes/${a}-${d}`, family: 'E1', role: 'distractor', frontmatter: { type: 'note', title: `${cap(a)} ${d}` },
      body: `${cap(a)} ${d} notes: a side discussion that mentions ${a} once and the ${d} budget.` });
    probe({ id: `E1:twin:${i}`, family: 'E1', variant: 'default', surfaces: RANK, text: `${a} ${b}`, params: { source_id: '__all__' }, design: { slug } });
    if (i < 3) probe({ id: `E1:single-source:${i}`, family: 'E1', variant: 'single-source-control', surfaces: RANK, text: `${a} ${b}`, params: { source_id: 'source-a' }, negative: true, design: { slug } });
  }

  // E2: merge-redirect stub. A target page with real content, a stub whose body says it was merged into the target.
  // same-title: the stub keeps the merged page's name (gbrain#7153's repro); renamed-stub: the stub's title adds a word.
  for (let i = 0; i < 15; i++) {
    const a = rng.word();
    const topic = `${cap(a)} gardening`;
    const target = `concepts/${a}-gardening`;
    const variant = i < 10 ? 'same-title' : 'renamed-stub';
    const stub = variant === 'same-title' ? `concepts/${a}-gardening-old` : `concepts/${a}-gardening-notes`;
    page({ source: 'default', slug: target, family: 'E2', role: 'target', frontmatter: { type: 'concept', title: topic },
      body: `${topic} covers raised beds, compost timing and the watering rota for the ${a} plots. The ${a} gardening group meets on Saturdays and keeps seed lists, soil tests and harvest notes on this page.` });
    page({ source: 'default', slug: stub, family: 'E2', role: 'stub', frontmatter: { type: 'concept', title: variant === 'same-title' ? topic : `${topic} notes` }, body: `This page has been merged into [[${target}]].` });
    for (let k = 0; k < 2; k++) {
      const w = rng.word();
      page({ source: 'default', slug: `notes/${w}-${a}`, family: 'E2', role: 'distractor', frontmatter: { type: 'note', title: `${cap(w)} errands` },
        body: `${cap(w)} errands list: buy twine, return the ${a} ladder, call the plumber about the leak.` });
    }
    probe({ id: `E2:${variant}:${i}`, family: 'E2', variant, surfaces: RANK, text: `${a} gardening`, design: { target, stub } });
  }

  // E3: document family. Transcript, summary and diarized copies of one talk (shared origin) plus a separate answer page.
  for (let i = 0; i < 6; i++) {
    const a = rng.word();
    const origin = `talks/${a}-pricing-talk.mp4`;
    const talkLine = `The ${a} pricing tiers talk walked through every ${a} pricing tier, how customers compare pricing tiers, and why the team will decide on ${a} tiers later.`;
    const copies: Array<[string, string, string]> = [
      ['transcript', `media/${a}-pricing-talk`, `${talkLine}\n\nSpeaker one: ${talkLine}\n\nSpeaker two: pricing tiers again, ${a} pricing, the team, the tiers.`],
      ['summary', `media/${a}-pricing-talk-summary`, `Summary. ${talkLine}`],
      ['transcript', `media/${a}-pricing-talk-diarized`, `[00:00] Speaker 1: ${talkLine}\n[03:10] Speaker 2: ${talkLine}`],
    ];
    for (const [type, slug, body] of copies) page({ source: 'default', slug, family: 'E3', role: 'family', frontmatter: { type, title: `${cap(a)} pricing talk`, origin }, body });
    const answer = `decisions/${a}-pricing-tiers`;
    page({ source: 'default', slug: answer, family: 'E3', role: 'answer', frontmatter: { type: 'note', title: `Decision record ${i + 1}` },
      body: `After the talk the team met again. What did the team decide about ${a} pricing tiers? They decided to keep three tiers and drop the annual discount.` });
    probe({ id: `E3:family:${i}`, family: 'E3', variant: 'default', surfaces: RANK, text: `what did the team decide about ${a} pricing tiers`, design: { answer, family: copies.map(c => c[1]) } });
  }

  // E4: org vs founder. A product-description query; a short company page and a longer, densely linked founder page.
  const products = [['inventory forecasting', 'florists'], ['shift scheduling', 'veterinary clinics'], ['invoice matching', 'shipyards'], ['menu translation', 'food trucks'],
    ['noise monitoring', 'concert venues'], ['seed tracking', 'orchards']] as const;
  for (const [i, [what, who]] of products.entries()) {
    const co = cap(rng.word());
    const f = person();
    const company = `companies/${slugPart(co)}-example`;
    page({ source: 'default', slug: company, family: 'E4', role: 'company', frontmatter: { type: 'company', title: `${co} Example` },
      body: `${co} Example builds the ${what} API for ${who}.` });
    page({ source: 'default', slug: f.slug, family: 'E4', role: 'founder', frontmatter: { type: 'person', title: f.name },
      body: [`${f.name} founded [[${company}]], the ${what} API for ${who}, after ten years in operations.`,
        `Before that ${f.first} ran logistics for a regional grocer, taught night classes and advised two nonprofits.`,
        `${f.first} writes a monthly letter about hiring, pricing and customer support, and mentors first-time founders.`,
        `Colleagues describe ${f.first} as patient, direct and good with spreadsheets. ${f.first} lives near the coast with two dogs.`,
        `Recent notes: board meeting prep, a podcast appearance, a talk on ${who} at a trade fair and a hiring plan for the API team.`].join('\n\n') });
    for (let l = 0; l < 8; l++) {
      const w = rng.word();
      page({ source: 'default', slug: `notes/${w}-sync`, family: 'E4', role: 'linker', frontmatter: { type: 'note', title: `${cap(w)} sync` },
        body: `Call with [[${f.slug}|${f.first}]] about the ${w} intro and next steps.` });
    }
    probe({ id: `E4:org:${i}`, family: 'E4', variant: 'default', surfaces: RANK, text: `${what} API for ${who}`, design: { company, founder: f.slug } });
    probe({ id: `E4:org-typed:${i}`, family: 'E4', variant: 'types-company', surfaces: RANK, text: `${what} API for ${who}`, params: { types: ['company'] }, design: { company, founder: f.slug } });
  }

  // E5: frontmatter discriminator. 20 identical interview transcripts that differ only in partner, cycle and outcome.
  const partners = Array.from({ length: 4 }, () => person());
  const cycles = ['spring-2025', 'fall-2025', 'spring-2026', 'summer-2026', 'fall-2026'];
  const iw = rng.word();
  const interviews: Array<{ slug: string; partner: string; cycle: string; outcome: string }> = [];
  for (const [pi, pp] of partners.entries()) for (const [ci, cycle] of cycles.entries()) {
    const outcome = (pi + ci) % 2 ? 'rejected' : 'accepted';
    const slug = `interviews/${iw}-${pi}-${ci}`;
    interviews.push({ slug, partner: pp.name, cycle, outcome });
    page({ source: 'default', slug, family: 'E5', role: 'interview', frontmatter: { type: 'transcript', title: `${cap(iw)} interview transcript`, partner: pp.name, cycle, outcome },
      body: `${cap(iw)} interview transcript. The founders described their company, the market and the team. Questions covered traction, competition, pricing and hiring. The partner asked about churn and the next milestone.` });
  }
  for (const [n, it] of rng.shuffle(interviews).slice(0, 8).entries()) {
    probe({ id: `E5:baseline:${n}`, family: 'E5', variant: 'baseline', surfaces: RANK, text: `${iw} interview ${it.partner} ${it.cycle} ${it.outcome}`, design: { slug: it.slug } });
    probe({ id: `E5:filter:${n}`, family: 'E5', variant: 'filter', surfaces: RANK, text: `${iw} interview`, params: { where: { partner: it.partner, cycle: it.cycle, outcome: it.outcome } }, design: { slug: it.slug } });
  }
  {
    const it = interviews[0];
    probe({ id: 'E5:filter-empty', family: 'E5', variant: 'filter-empty', surfaces: RANK, text: `${iw} interview`, negative: true,
      params: { where: { partner: it.partner, cycle: it.cycle, outcome: it.outcome === 'accepted' ? 'rejected' : 'accepted' } }, design: { empty: true } });
  }

  // E6: entity name variants N4 does not cover. Empty aliases and no declaration in the body.
  const e6People = Object.keys(DIMINUTIVES).map(first => {
    const stem = cap(rng.word());
    return { first, stem, name: `${first} ${stem}-Example`, slug: `people/${slugPart(first)}-${slugPart(stem)}-example` };
  });
  for (const p of e6People) {
    page({ source: 'default', slug: p.slug, family: 'E6', role: 'person', frontmatter: { type: 'person', title: p.name, aliases: [] },
      body: `${p.name} chairs the regional water board and writes the quarterly infrastructure report.` });
  }
  const sharedStem = cap(rng.word());
  const namesakes = [rng.first(), rng.first()].map(first => ({ first, stem: sharedStem, name: `${first} ${sharedStem}-Example`, slug: `people/${slugPart(first)}-${slugPart(sharedStem)}-example` }));
  for (const p of namesakes) page({ source: 'default', slug: p.slug, family: 'E6', role: 'namesake', frontmatter: { type: 'person', title: p.name, aliases: [] }, body: `${p.name} is a ferry captain.` });
  const allE6 = [...e6People, ...namesakes];
  page({ source: 'default', slug: 'indexes/people-index', family: 'E6', role: 'index', frontmatter: { type: 'index', title: 'People index' },
    body: `Everyone with a page, by surname:\n${allE6.map(p => `- ${p.stem}-Example, ${p.first}: Dr. or Senator where it applies`).join('\n')}` });
  page({ source: 'default', slug: 'digests/weekly-digest-2026-09-28', family: 'E6', role: 'digest', frontmatter: { type: 'digest', title: 'Weekly digest 2026-09-28' },
    body: `This week in notes: ${allE6.map(p => p.name).join(', ')}. Dr. and Senator titles came up twice.` });
  for (const [i, p] of e6People.entries()) {
    const honorific = i % 2 ? 'Senator' : 'Dr.';
    const variants: Array<[string, string]> = [
      ['honorific', `${honorific} ${p.name}`],
      ['surname', `${p.stem}-Example`],
      ['diminutive', `${DIMINUTIVES[p.first]} ${p.stem}-Example`],
      ['reversed', `${p.stem}-Example ${p.first}`],
    ];
    for (const [variant, text] of variants) probe({ id: `E6:${variant}:${i}`, family: 'E6', variant, surfaces: ['entity'], text, design: { slug: p.slug } });
  }
  probe({ id: 'E6:ambiguous-surname', family: 'E6', variant: 'ambiguous-surname', surfaces: ['entity'], text: `${sharedStem}-Example`, negative: true, design: { refuse: namesakes.map(n => n.slug) } });
  probe({ id: 'E6:no-referent', family: 'E6', variant: 'no-referent', surfaces: ['entity'], text: `${rng.first()} ${cap(rng.word())}-Example`, negative: true, design: { refuse: [] } });

  // E7: honorific duplicate. A short title-prefixed stub plus the real, linked person page.
  for (const [i, t] of ['Mayor', 'Dr', 'Senator', 'CEO'].entries()) {
    const p = person();
    const stub = `people/${t.toLowerCase()}-${slugPart(p.stem)}-example`;
    page({ source: 'default', slug: p.slug, family: 'E7', role: 'canonical', frontmatter: { type: 'person', title: p.name, aliases: [] },
      body: `${p.name} has served on the city council and the transit board, and hosts the monthly neighborhood forum.` });
    page({ source: 'default', slug: stub, family: 'E7', role: 'stub', frontmatter: { type: 'person', title: `${t} ${p.stem}-Example` }, body: `${t} ${p.stem}-Example spoke at the forum.` });
    for (let l = 0; l < 3; l++) {
      const w = rng.word();
      page({ source: 'default', slug: `notes/${w}-forum`, family: 'E7', role: 'linker', frontmatter: { type: 'note', title: `${cap(w)} forum notes` },
        body: `Forum notes: [[${p.slug}|${p.first}]] answered questions about the ${w} route.` });
    }
    probe({ id: `E7:prefixed:${i}`, family: 'E7', variant: 'prefixed', surfaces: ['entity'], text: `${t} ${p.stem}-Example`, design: { slug: p.slug, stub } });
    probe({ id: `E7:full-name:${i}`, family: 'E7', variant: 'full-name-control', surfaces: ['entity'], text: p.name, design: { slug: p.slug, stub } });
  }

  // E8: raw-only names. Full names that appear only in daily notes; no person page; mention extraction never runs.
  const raw = [person(), person()];
  const counts = [50, 5];
  for (let d = 0; d < 50; d++) {
    const day = `2026-0${7 + Math.floor(d / 28)}-${String((d % 28) + 1).padStart(2, '0')}`;
    const names = raw.filter((_, i) => d < counts[i]).map(r => r.name);
    const w = rng.word();
    page({ source: 'default', slug: `daily/${day}`, family: 'E8', role: 'daily', frontmatter: { type: 'note', title: `Daily ${day}`, date: day },
      body: `Daily note ${day}. Morning: ${w} errands and the gym. Coffee with ${names.join(' and ')} about the harbor grant.` });
  }
  for (const [i, r] of raw.entries()) probe({ id: `E8:raw-only:${i}`, family: 'E8', variant: 'raw-only', surfaces: ['entity'], text: r.name, design: { name: r.name, count: counts[i] } });
  probe({ id: 'E8:nowhere', family: 'E8', variant: 'nowhere', surfaces: ['entity'], text: `${rng.first()} ${cap(rng.word())}-Example`, negative: true, design: { name: null } });

  // E9: OCR single word. Short image pages that share one word with a person-name query.
  for (let i = 0; i < 6; i++) {
    const p = person();
    page({ source: 'default', slug: p.slug, family: 'E9', role: 'person', frontmatter: { type: 'person', title: p.name },
      body: `${p.name} restores old sailboats and teaches a weekend navigation class. ${p.first} keeps a logbook of every repair.` });
    const shared = (i % 2 ? p.first : p.stem).toUpperCase();
    for (let k = 0; k < 3; k++) {
      const n = 1000 + rng.int(9000);
      page({ source: 'default', slug: `media/img-${n}-${i}-${k}-jpg`, family: 'E9', role: 'ocr', frontmatter: { type: 'image', title: `IMG_${n}.jpg` }, body: `${shared} ${['SALE', 'OPEN DAILY', 'RECEIPT'][k]}` });
    }
    probe({ id: `E9:name:${i}`, family: 'E9', variant: 'default', surfaces: RANK, text: p.name, design: { slug: p.slug } });
  }

  // E10: identifiers. 200 contact cards with look-alike phones, mail addresses and hex ids; 9 identifiers each sit in exactly one card.
  const cards: Array<{ slug: string; phone: string; mail: string; hex: string }> = [];
  const hexPrefix = rng.hex(8);
  for (let c = 0; c < 200; c++) {
    const w = rng.word();
    const card = { slug: `contacts/${w}`, phone: `(415) 555-${String(100 + c).padStart(4, '0')}`, mail: `desk-${c}-${w}@example.org`, hex: hexPrefix + rng.hex(24) };
    cards.push(card);
    page({ source: 'default', slug: card.slug, family: 'E10', role: 'card', frontmatter: { type: 'note', title: `${cap(w)} contact card` },
      body: `Contact card for ${cap(w)}. Phone ${card.phone}. Mail ${card.mail}. Ticket ${card.hex}. Met at the supplier fair.` });
  }
  for (const [k, kind] of (['phone', 'mail', 'hex'] as const).entries()) {
    for (let j = 0; j < 3; j++) {
      const c = cards[17 + 61 * j + 7 * k];
      probe({ id: `E10:${kind}:${j}`, family: 'E10', variant: kind, surfaces: RANK, text: c[kind], design: { slug: c.slug } });
    }
  }

  // E11: temporal. "When did <company> start <program>?" with an undated concept stub and a dated meeting page.
  for (let i = 0; i < 6; i++) {
    const co = cap(rng.word());
    const prog = rng.word();
    const day = `2025-${String(1 + i).padStart(2, '0')}-${String(3 + 2 * i).padStart(2, '0')}`;
    const stub = `concepts/${prog}-pilot`;
    const dated = `meetings/${day}-${slugPart(co)}-${prog}-kickoff`;
    page({ source: 'default', slug: stub, family: 'E11', role: 'undated', frontmatter: { type: 'concept', title: `${cap(prog)} pilot` },
      body: `The ${prog} pilot is a loyalty program ${co} Example started for repeat customers.` });
    page({ source: 'default', slug: dated, family: 'E11', role: 'dated', frontmatter: { type: 'meeting', title: `${co} Example ${prog} kickoff`, date: day },
      body: `On ${day}, ${co} Example started the ${prog} pilot at the kickoff meeting. Attendees agreed on the launch checklist.` });
    probe({ id: `E11:when:${i}`, family: 'E11', variant: 'default', surfaces: RANK, text: `When did ${co} Example start the ${prog} pilot?`, design: { dated, stub } });
  }

  // E13: chunk cap. One meeting page of about 60,000 characters.
  {
    const a = rng.word();
    const slug = `meetings/2026-05-12-${a}-all-hands`;
    const turns: string[] = [];
    for (let t = 0; turns.join('\n\n').length < 60000; t++) {
      turns.push(`**Speaker ${t % 4}:** Item ${t} of the ${a} roadmap: we reviewed owners, dates and risks for the ${a} launch, and agreed to follow up in writing before the next all hands.`);
    }
    page({ source: 'default', slug, family: 'E13', role: 'long-meeting', frontmatter: { type: 'meeting', title: `${cap(a)} all hands`, date: '2026-05-12' }, body: turns.join('\n\n') });
    probe({ id: 'E13:default', family: 'E13', variant: 'default', surfaces: RANK, text: `${a} roadmap launch`, design: { slug } });
    probe({ id: 'E13:return-unit-chunk', family: 'E13', variant: 'return-unit-chunk', surfaces: RANK, text: `${a} roadmap launch`, params: { return_unit: 'chunk' }, design: { slug } });
  }

  // E14: notice scoping. Image pages whose text projection is left unsealed, then text queries that cannot match an image.
  for (let i = 0; i < 5; i++) {
    const w = rng.word();
    images.push({ slug: `media/scans/${w}-scan-${i}.png`, file: `${w}-scan-${i}.png`, family: 'E14' });
  }

  // E15: known-item paraphrase. 50 pages of six types; each question avoids the title's distinctive word.
  const known: Array<{ type: string; n: number; a: readonly string[]; b: readonly string[]; title: (w: string) => string; body: (t: string, a: string, b: string) => string; q: (a: string, b: string) => string }> = [
    { type: 'person', n: 10, a: ['pastry chef', 'tax attorney', 'glassblower', 'beekeeper', 'radio host'], b: ['Lisbon', 'Osaka', 'Tucson', 'Bergen'],
      title: w => `${rng.first()} ${cap(w)}-Example`, body: (t, a, b) => `${t} works as a ${a} in ${b}. On weekends they volunteer at the library and fix bicycles.`, q: (a, b) => `which ${a} working in ${b} repairs bikes on weekends` },
    { type: 'company', n: 8, a: ['solar inverters', 'pet insurance', 'payroll software', 'cold brew coffee'], b: ['hospitals', 'schools', 'farmers', 'airlines'],
      title: w => `${cap(w)} Example`, body: (t, a, b) => `${t} sells ${a} to ${b}. It has forty employees and a small office near the station.`, q: (a, b) => `the firm that sells ${a} to ${b}` },
    { type: 'meeting', n: 8, a: ['budget review', 'hiring plan', 'office move', 'security audit'], b: ['finance team', 'design team', 'legal team', 'sales team'],
      title: w => `${cap(w)} sync`, body: (t, a, b) => `${t}: the ${b} met to discuss the ${a}. They agreed to send a written summary by Friday.`, q: (a, b) => `when the ${b} discussed the ${a}` },
    { type: 'note', n: 8, a: ['bread recipe', 'garden layout', 'tax checklist', 'packing list'], b: ['cabin', 'balcony', 'garage', 'studio'],
      title: w => `${cap(w)} notes`, body: (t, a, b) => `${t}. My ${a} for the ${b}, kept up to date after each try.`, q: (a, b) => `my ${a} for the ${b}` },
    { type: 'concept', n: 8, a: ['spaced repetition', 'opportunity cost', 'regression to the mean', 'network effects'], b: ['economics', 'psychology', 'statistics', 'education'],
      title: w => `${cap(w)} principle`, body: (t, a, b) => `${t}: how ${a} shows up in ${b}, with two worked examples and common mistakes.`, q: (a, b) => `explain ${a} as it applies to ${b}` },
    { type: 'transcript', n: 8, a: ['marine biologist', 'jazz drummer', 'wildfire scientist', 'chess coach'], b: ['morning podcast', 'science hour', 'book club', 'radio call-in'],
      title: w => `${cap(w)} episode`, body: (t, a, b) => `${t}. Transcript of the ${b} with a ${a} as the guest, covering their first job and a typical week.`, q: (a, b) => `the ${b} episode where a ${a} was the guest` },
  ];
  const e15: Array<{ slug: string; question: string }> = [];
  for (const k of known) {
    const as = rng.shuffle(k.a), bs = rng.shuffle(k.b);
    for (let i = 0; i < k.n; i++) {
      const a = as[i % as.length], b = bs[(i + Math.floor(i / as.length)) % bs.length];
      const w = rng.word();
      const title = k.title(w);
      const slug = `known/${k.type}-${w}`;
      page({ source: 'default', slug, family: 'E15', role: 'known-item', frontmatter: { type: k.type, title }, body: k.body(title, a, b) });
      e15.push({ slug, question: k.q(a, b) });
    }
  }
  for (const [i, k] of e15.entries()) probe({ id: `E15:known:${i}`, family: 'E15', variant: 'default', surfaces: RANK, text: k.question, design: { slug: k.slug } });
  for (const [n, k] of e15.slice(0, 3).entries()) {
    probe({ id: `E14:unscoped:${n}`, family: 'E14', variant: 'unscoped', surfaces: RANK, text: k.question, design: {} });
    probe({ id: `E14:typed:${n}`, family: 'E14', variant: 'types-note', surfaces: RANK, text: k.question, params: { types: ['note'] }, design: {} });
  }

  // E12 scores every search/query response of the run; it adds no pages and no probes of its own.
  const keep = opts.families ? new Set<ArsFamily>(opts.families) : null;
  return {
    version: ARS_GENERATOR_VERSION, seed,
    pages: keep ? pages.filter(p => keep.has(p.family)) : pages,
    images: keep && !keep.has('E14') ? [] : images,
    probes: keep ? probes.filter(p => keep.has(p.family)) : probes,
  };
}

export function ledgerFingerprint(ledger: ArsLedger): string {
  return createHash('sha256').update(JSON.stringify(ledger)).digest('hex');
}

// ─── Independent oracle ────────────────────────────────────────────────

const tokens = (s: string) => s.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [];
const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'for', 'in', 'on', 'at', 'and', 'or', 'what', 'which', 'when', 'did', 'my', 'as', 'it', 'that', 'where', 'was', 'about', 'how']);
export const contentWords = (s: string) => tokens(s).flatMap(t => t.split('-')).filter(t => !STOP.has(t));

/** Strip one leading honorific or job title, the rewrite gbrain#7160 asks for. */
export function stripHonorific(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 && (HONORIFICS as readonly string[]).includes(parts[0].toLowerCase()) ? parts.slice(1).join(' ') : name.trim();
}

/** The E6/E7 oracle: resolve a name variant against canonical person titles only (never index, digest or title-prefixed pages). */
export function resolveVariant(text: string, pages: readonly ParsedPage[]): { kind: 'one'; key: string; rule: string } | { kind: 'refuse'; candidates: string[] } {
  const prefixed = (p: ParsedPage) => (HONORIFICS as readonly string[]).includes(p.slug.split('/')[1].split('-')[0]);
  const canon = pages.filter(p => p.type === 'person' && !prefixed(p));
  const norm = (s: string) => s.toLowerCase().replace(/,/g, '').replace(/\s+/g, ' ').trim();
  const wanted = norm(stripHonorific(text));
  const split = (p: ParsedPage) => { const [first, ...rest] = p.title.split(' '); return { first, last: rest.join(' ') }; };
  const rules: Array<[string, (p: ParsedPage) => boolean]> = [
    ['exact', p => norm(p.title) === wanted],
    ['reversed', p => { const { first, last } = split(p); return norm(`${last} ${first}`) === wanted; }],
    ['diminutive', p => { const { first, last } = split(p); return DIMINUTIVES[first] !== undefined && norm(`${DIMINUTIVES[first]} ${last}`) === wanted; }],
    ['surname', p => norm(split(p).last) === wanted],
  ];
  for (const [rule, test] of rules) {
    const hits = canon.filter(test);
    if (hits.length === 1) return { kind: 'one', key: pageKey(hits[0].source, hits[0].slug), rule };
    if (hits.length > 1) return { kind: 'refuse', candidates: hits.map(h => pageKey(h.source, h.slug)).sort() };
  }
  return { kind: 'refuse', candidates: [] };
}

function check(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`oracle disagrees with the generator design: ${msg}`);
}

/** Gold for every probe, from the rendered pages and each probe's public text and parameters. */
export function deriveArsGold(ledger: ArsLedger): Map<string, ArsGold> {
  const parsed = ledger.pages.map(p => parseRendered(p.source, p.slug, renderPage(p)));
  const key = (p: ParsedPage) => pageKey(p.source, p.slug);
  const words = (p: ParsedPage) => new Set(contentWords(`${p.title} ${p.body}`));
  const containsAll = (p: ParsedPage, ws: readonly string[]) => { const have = words(p); return ws.every(w => have.has(w)); };
  const bodyHas = (needle: string) => parsed.filter(p => p.body.includes(needle));
  const forbidden = parsed.filter(p => p.type === 'index' || p.type === 'digest').map(key).sort();
  const gold = new Map<string, ArsGold>();
  for (const pr of ledger.probes) {
    const d = pr.design;
    const q = contentWords(pr.text);
    let g: ArsGold;
    switch (pr.family) {
      case 'E1': {
        const scope = pr.params.source_id === '__all__' ? null : String(pr.params.source_id);
        const full = parsed.filter(p => (scope === null || p.source === scope) && contentWords(p.title).join(' ') === q.join(' '));
        check(full.length === (scope === null ? 2 : 1) && full.every(p => p.slug === d.slug), `${pr.id}: twin set`);
        check(new Set(full.map(p => p.body)).size === 1, `${pr.id}: twins share one body`);
        g = { kind: 'twin', slug: full[0].slug, keys: full.map(key).sort() };
        break;
      }
      case 'E2': {
        const stubs = parsed.filter(p => /^This page has been merged into \[\[[^\]]+\]\]\.$/.test(p.body) && containsAll(p, q));
        check(stubs.length === 1, `${pr.id}: one stub carries the query words`);
        const target = /\[\[([^\]]+)\]\]/.exec(stubs[0].body)![1];
        const tp = parsed.find(p => p.slug === target);
        check(target === d.target && tp && containsAll(tp, q), `${pr.id}: the stub's target holds the query words`);
        g = { kind: 'rank', target: key(tp!), need: 'above', not_above: [key(stubs[0])] };
        break;
      }
      case 'E3': {
        const holders = parsed.filter(p => containsAll(p, q));
        const answers = holders.filter(p => !p.frontmatter.origin && p.body.toLowerCase().includes(pr.text.toLowerCase()));
        check(answers.length === 1 && answers[0].slug === d.answer, `${pr.id}: one page states the question and answers it`);
        const origins = new Map<string, ParsedPage[]>();
        for (const p of holders) if (p.frontmatter.origin) origins.set(String(p.frontmatter.origin), [...(origins.get(String(p.frontmatter.origin)) ?? []), p]);
        const fam = [...origins.values()].filter(ps => ps.length >= 2);
        check(fam.length === 1 && fam[0].map(p => p.slug).sort().join() === [...(d.family as string[])].sort().join(), `${pr.id}: the copies share one origin`);
        g = { kind: 'rank', target: key(answers[0]), need: 'first', family_pages: fam[0].map(key).sort(), family_max_top5: 1 };
        break;
      }
      case 'E4': {
        const companies = parsed.filter(p => p.type === 'company' && p.body.includes(pr.text));
        check(companies.length === 1 && companies[0].slug === d.company, `${pr.id}: one company page describes the product`);
        check(!q.some(w => contentWords(companies[0].title).includes(w)), `${pr.id}: the query names no title word`);
        check(!parsed.some(p => p.type === 'person' && q.some(w => contentWords(p.title).includes(w))), `${pr.id}: the query names no person`);
        g = { kind: 'rank', target: key(companies[0]), need: 'first' };
        break;
      }
      case 'E5': {
        const interviews = parsed.filter(p => p.type === 'transcript' && p.frontmatter.partner);
        check(new Set(interviews.map(p => p.body)).size === 1 && new Set(interviews.map(p => p.title)).size === 1, `${pr.id}: interview titles and bodies are identical`);
        const where = pr.params.where as Record<string, string> | undefined;
        const match = interviews.filter(p => where
          ? Object.entries(where).every(([k, v]) => p.frontmatter[k] === v)
          : pr.text.includes(String(p.frontmatter.partner)) && pr.text.includes(` ${String(p.frontmatter.cycle)} `) && pr.text.endsWith(` ${String(p.frontmatter.outcome)}`));
        if (d.empty) { check(match.length === 0, `${pr.id}: no page matches the negative filter`); g = { kind: 'empty' }; break; }
        check(match.length === 1 && match[0].slug === d.slug, `${pr.id}: exactly one interview matches partner, cycle and outcome`);
        g = { kind: 'rank', target: key(match[0]), need: 'first' };
        break;
      }
      case 'E6':
      case 'E7': {
        const r = resolveVariant(pr.text, parsed);
        if (d.refuse) {
          check(r.kind === 'refuse' && r.candidates.join() === (d.refuse as string[]).map(s => pageKey('default', s)).sort().join(), `${pr.id}: refusal`);
          g = { kind: 'refuse', candidates: (r as { candidates: string[] }).candidates, forbidden_suggestions: forbidden };
          break;
        }
        check(r.kind === 'one' && r.key === pageKey('default', String(d.slug)), `${pr.id}: the variant resolves to ${String(d.slug)}`);
        g = { kind: 'resolve', key: (r as { key: string }).key, forbidden_suggestions: forbidden };
        break;
      }
      case 'E8': {
        const holders = bodyHas(pr.text);
        check(!parsed.some(p => p.title === pr.text), `${pr.id}: no page is titled with the name`);
        if (d.name === null) { check(holders.length === 0, `${pr.id}: the name appears nowhere`); g = { kind: 'no-mentions' }; break; }
        check(holders.length === d.count, `${pr.id}: ${String(d.count)} pages mention the name`);
        g = { kind: 'mentions', keys: holders.map(key).sort() };
        break;
      }
      case 'E9': {
        const people = parsed.filter(p => p.type === 'person' && p.title === pr.text);
        check(people.length === 1 && people[0].slug === d.slug, `${pr.id}: one person page carries the name`);
        const ocr = parsed.filter(p => p.type === 'image' && contentWords(p.body).some(w => q.includes(w)));
        check(ocr.length === 3 && ocr.every(p => contentWords(p.body).filter(w => q.includes(w)).length === 1), `${pr.id}: three OCR pages share exactly one word`);
        g = { kind: 'rank', target: key(people[0]), need: 'first' };
        break;
      }
      case 'E10': {
        const holders = bodyHas(pr.text);
        check(holders.length === 1 && holders[0].slug === d.slug, `${pr.id}: the identifier sits in exactly one page`);
        g = { kind: 'rank', target: key(holders[0]), need: 'first' };
        break;
      }
      case 'E11': {
        const ws = q.filter(w => w !== 'start');
        const candidates = parsed.filter(p => containsAll(p, ws) && /\bstarted\b/.test(p.body));
        const dated = candidates.filter(p => typeof p.frontmatter.date === 'string' && p.body.includes(String(p.frontmatter.date)));
        check(candidates.length === 2 && dated.length === 1 && dated[0].slug === d.dated, `${pr.id}: one dated and one undated page say it started`);
        g = { kind: 'rank', target: key(dated[0]), need: 'first', not_above: candidates.filter(p => p !== dated[0]).map(key) };
        break;
      }
      case 'E13': {
        const long = parsed.filter(p => p.body.length >= 60000);
        check(long.length === 1 && long[0].slug === d.slug && containsAll(long[0], q), `${pr.id}: one 60,000-character page holds the query`);
        g = { kind: 'chunk-cap', cap: ARS_CHUNK_CAP_CHARS, page: key(long[0]) };
        break;
      }
      case 'E14':
        check(ledger.images.length > 0 && !q.some(w => ledger.images.some(i => contentWords(i.file).includes(w))), `${pr.id}: the text query shares no word with an image`);
        g = { kind: 'no-stage', stage: 'projection_pending' };
        break;
      case 'E15': {
        const target = parsed.find(p => p.slug === d.slug)!;
        const distinct = new Set(contentWords(target.title).filter(w => !['example', 'sync', 'notes', 'principle', 'episode'].includes(w)));
        check(distinct.size > 0 && !q.some(w => distinct.has(w)), `${pr.id}: the question avoids the title's distinctive words`);
        const shared = (p: ParsedPage) => { const have = words(p); return q.filter(w => have.has(w)).length; };
        const best = Math.max(...parsed.map(shared));
        const top = parsed.filter(p => shared(p) === best);
        check(top.length === 1 && top[0] === target, `${pr.id}: the target shares the most question words of every page`);
        g = { kind: 'known-item', target: key(target) };
        break;
      }
      default:
        throw new Error(`oracle: no rule for ${pr.family}`);
    }
    gold.set(pr.id, g);
  }
  return gold;
}

export interface GeneratedArs { ledger: ArsLedger; gold: Map<string, ArsGold>; fingerprint: string }

export function generateArsWorld(opts: ArsWorldOptions = {}): GeneratedArs {
  const ledger = generateArsLedger(opts);
  return { ledger, gold: deriveArsGold(ledger), fingerprint: ledgerFingerprint(ledger) };
}
