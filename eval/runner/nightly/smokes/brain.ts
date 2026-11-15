/**
 * The seeded synthetic brain the nightly system smokes run on.
 *
 * `generateBrain(seed)` returns a few hundred invented Markdown pages, the same bytes for the same seed on every
 * machine: people, companies, projects, notes and meetings, with the shapes that broke gbrain in October 2026:
 *
 * - hub index.md files below the source root that carry type:, title: and their own slug: line (the folder's slug, or
 *   only its leaf name), which sync must treat as scaffolding rather than hold;
 * - pages with a "## Facts" fence, which import into the facts table with no model call;
 * - a unique search token on every page, so a smoke can ask whether one page is searchable.
 *
 * largePage(seed, bytes) builds a page over gbrain's 4 MiB segmented-storage threshold at run time, so the repository
 * never stores it. Every name ends in -example; nothing comes from a real brain.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface SeedPage {
  path: string;
  /** The slug gbrain derives from the path; a hub's is the folder slug its own slug line names. */
  slug: string;
  title: string;
  /** A word that appears on this page only. */
  token: string;
  kind: 'person' | 'company' | 'project' | 'note' | 'meeting' | 'hub';
  /** Claims in the page's Facts fence, when it has one. */
  facts: string[];
}

export interface SeedBrain { seed: number; pages: SeedPage[]; files: Map<string, string> }

/** mulberry32: a small seeded generator, so the brain never depends on Math.random. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['ada', 'bram', 'cleo', 'dev', 'esme', 'femi', 'gil', 'hiro', 'ines', 'jonah', 'kira', 'lev', 'mira', 'nico', 'oona', 'pax', 'quin', 'rhea', 'saul', 'tova'];
const LAST = ['alder', 'birch', 'cedar', 'dune', 'ember', 'fern'];
const COMPANIES = ['acme', 'basalt', 'cobalt', 'delta', 'ember', 'fjord', 'garnet', 'harbor', 'indigo', 'juniper', 'kestrel', 'lumen', 'meridian', 'nimbus', 'onyx', 'pylon', 'quarry', 'ridge', 'sable', 'tundra'];
const PROJECTS = ['apollo', 'beacon', 'cascade', 'drift', 'echo', 'flint', 'glacier', 'halo', 'iris', 'jetty'];
const TOPICS = ['pricing', 'hiring', 'roadmap', 'onboarding', 'security', 'billing', 'search', 'support', 'mobile', 'analytics'];
const WORDS = ['ledger', 'harbor', 'signal', 'quarter', 'review', 'launch', 'budget', 'design', 'metric', 'customer', 'contract', 'pilot', 'rollout', 'feedback', 'latency', 'archive', 'migration', 'renewal', 'forecast', 'workshop'];

const pick = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const sentence = (rand: () => number, n: number) => cap(Array.from({ length: n }, () => pick(rand, WORDS)).join(' ')) + '.';

/** A narrow Facts fence in gbrain's own layout, with world-visible rows dated inside October 2026. */
export function factsFence(claims: string[], day = 1): string {
  const rows = claims.map((c, i) => `| ${i + 1} | ${c} | fact | 1.0 | world | medium | 2026-10-${String(Math.min(day + i, 28)).padStart(2, '0')} |  | nightly smoke seed |  |`);
  return ['## Facts', '', '<!--- gbrain:facts:begin -->',
    '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
    '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
    ...rows, '<!--- gbrain:facts:end -->'].join('\n');
}

const page = (type: string, title: string, body: string) => `---\ntype: ${type}\ntitle: ${title}\n---\n\n${body.trimEnd()}\n`;

export function generateBrain(seed = 1): SeedBrain {
  const rand = prng(seed);
  const pages: SeedPage[] = [];
  const files = new Map<string, string>();
  let n = 0;
  const token = () => `smk${seed}x${(n++).toString(36).padStart(3, '0')}`;
  const add = (p: SeedPage, text: string) => { pages.push(p); files.set(p.path, text); };

  const people: string[] = [];
  for (const first of FIRST) for (const last of LAST) people.push(`${first}-${last}-example`);
  people.forEach((who, i) => {
    const t = token();
    const company = COMPANIES[i % COMPANIES.length]!;
    const title = who.split('-').slice(0, 2).map(cap).join(' ');
    const facts = i % 2 === 0 ? [`${title} works at ${cap(company)} Example`, `${title} leads the ${pick(rand, TOPICS)} review`] : [];
    const body = [`${title} is a fictional person in the nightly smoke brain. Search token ${t}.`, '',
      `Works with [[companies/${company}-example]] on ${pick(rand, TOPICS)}. ${sentence(rand, 8)}`,
      ...(facts.length ? ['', factsFence(facts, 1 + (i % 20))] : [])].join('\n');
    add({ path: `people/${who}.md`, slug: `people/${who}`, title, token: t, kind: 'person', facts }, page('person', title, body));
  });

  COMPANIES.forEach((c, i) => {
    const dir = `companies/${c}-example`;
    const t = token();
    const title = `${cap(c)} Example`;
    // A hub whose own slug line names its folder: scaffolding, never a held page.
    add({ path: `${dir}/index.md`, slug: dir, title, token: t, kind: 'hub', facts: [] },
      `---\ntype: company\ntitle: ${title}\nslug: ${dir}\n---\n\n# ${title}\n\nHub for ${title}. Search token ${t}.\n`);
    for (let k = 1; k <= 2; k++) {
      const tk = token();
      const facts = k === 1 ? [`${title} renewed its ${pick(rand, TOPICS)} contract`, `${title} has ${10 + i} staff`] : [];
      const body = [`Note ${k} about [[${dir}]]. Search token ${tk}.`, '', sentence(rand, 12), ...(facts.length ? ['', factsFence(facts, 3 + i)] : [])].join('\n');
      add({ path: `${dir}/note-${k}.md`, slug: `${dir}/note-${k}`, title: `${title} note ${k}`, token: tk, kind: 'company', facts }, page('note', `${title} note ${k}`, body));
    }
  });

  PROJECTS.forEach((p, i) => {
    const dir = `projects/${p}`;
    const t = token();
    const title = `Project ${cap(p)}`;
    // Half the project hubs name only their leaf, the other spelling that held as frontmatter_slug_conflict.
    const slugLine = i % 2 === 0 ? dir : p;
    add({ path: `${dir}/index.md`, slug: dir, title, token: t, kind: 'hub', facts: [] },
      `---\ntype: project\ntitle: ${title}\nslug: ${slugLine}\n---\n\n# ${title}\n\nHub for ${title}. Search token ${t}.\n`);
    const tk = token();
    add({ path: `${dir}/plan.md`, slug: `${dir}/plan`, title: `${title} plan`, token: tk, kind: 'project', facts: [] },
      page('project', `${title} plan`, `Plan for ${title}. Search token ${tk}.\n\n${sentence(rand, 14)}`));
  });

  for (let i = 0; i < 100; i++) {
    const t = token();
    const topic = TOPICS[i % TOPICS.length]!;
    const title = `${cap(topic)} note ${Math.floor(i / TOPICS.length) + 1}`;
    const facts = i % 3 === 0 ? [`The ${topic} note ${i} decision shipped`, `The ${topic} team met on day ${1 + (i % 28)}`] : [];
    const body = [`${title}. Search token ${t}.`, '', `${sentence(rand, 10)} See [[people/${people[i % people.length]}]].`, '', sentence(rand, 16),
      ...(facts.length ? ['', factsFence(facts, 1 + (i % 25))] : [])].join('\n');
    add({ path: `notes/${topic}-${i + 1}.md`, slug: `notes/${topic}-${i + 1}`, title, token: t, kind: 'note', facts }, page('note', title, body));
  }

  for (let i = 0; i < 30; i++) {
    const t = token();
    const day = String(1 + (i % 28)).padStart(2, '0');
    const title = `Meeting ${day} October ${i + 1}`;
    add({ path: `meetings/2026-10-${day}-sync-${i + 1}.md`, slug: `meetings/2026-10-${day}-sync-${i + 1}`, title, token: t, kind: 'meeting', facts: [] },
      page('meeting', title, `Attendees: [[people/${people[(3 * i) % people.length]}]], [[people/${people[(3 * i + 1) % people.length]}]]. Search token ${t}.\n\n${sentence(rand, 18)}`));
  }

  // A bare root index.md is always scaffolding; it keeps the root shaped like a real brain.
  files.set('index.md', '# Nightly smoke brain\n\nInvented pages for gbrain-evals system smokes.\n');
  return { seed, pages, files };
}

/**
 * generateBrain(seed) plus `count` plain archive notes under archive/<year>/, for smokes that need more pages than the
 * seeded brain, such as one past a 500-page batch limit. The seeded pages keep their bytes, archive/ sorts before every
 * seeded folder, and each archive note has its own search token.
 */
export function archiveBrain(seed: number, count: number): SeedBrain {
  const brain = generateBrain(seed);
  const rand = prng(seed ^ 0xa7c4);
  for (let i = 0; i < count; i++) {
    const token = `smk${seed}a${i.toString(36).padStart(4, '0')}`;
    const topic = TOPICS[i % TOPICS.length]!;
    const title = `Archive ${topic} note ${i + 1}`;
    const path = `archive/${2021 + (i % 5)}/${topic}-${String(i + 1).padStart(5, '0')}.md`;
    brain.pages.push({ path, slug: path.slice(0, -3), title, token, kind: 'note', facts: [] });
    brain.files.set(path, page('note', title, `${title}. Search token ${token}.\n\n${sentence(rand, 12)}\n\n${sentence(rand, 16)}`));
  }
  return brain;
}

/** The sha256 of a brain's paths and bytes, in path order. */
export function brainDigest(brain: SeedBrain): string {
  const h = createHash('sha256');
  for (const path of [...brain.files.keys()].sort()) h.update(`${path}\0${brain.files.get(path)}\0`);
  return h.digest('hex');
}

export function writeBrain(dir: string, brain: SeedBrain, filter: (path: string) => boolean = () => true): void {
  for (const [path, text] of brain.files) {
    if (!filter(path)) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

/** A deterministic page of at least `bytes` bytes (default 4.5 MiB), past gbrain's 4 MiB segmented-page threshold. */
export function largePage(seed: number, bytes = 4.5 * 1024 * 1024, title = 'Large smoke page'): string {
  const rand = prng(seed ^ 0x5eed);
  const head = `---\ntype: note\ntitle: ${title}\n---\n\nA large invented page for the nightly write-latency smoke. Search token smk${seed}large.\n\n`;
  const parts = [head];
  let size = head.length;
  for (let i = 0; size < bytes; i++) {
    const para = `## Section ${i + 1}\n\n${Array.from({ length: 6 }, () => sentence(rand, 14)).join(' ')}\n\n`;
    parts.push(para);
    size += para.length;
  }
  return parts.join('');
}
