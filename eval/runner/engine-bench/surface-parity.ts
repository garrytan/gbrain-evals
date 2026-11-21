/**
 * engine-bench surface parity: the same inputs through each storage engine must give byte-identical output on every
 * surface a user or agent reads. This is the Rust engine's parity bar (gbrain docs/designs/RUST_ENGINE.md, "Engine
 * benchmark in gbrain-evals"): CLI JSON, MCP tool results and markdown are byte-exact with PGLite and with Postgres.
 *
 * One child step per engine, each against the gbrain CLI under test with a throwaway GBRAIN_HOME whose
 * `.gbrain/config.json` comes from cliEngineConfig (a PGLite data directory, a fresh database on a local pgvector
 * Postgres, or a Rust store path) plus `embedding_disabled: true`, gbrain's keyless mode (`gbrain init
 * --no-embedding` writes the same key): import runs with --no-embed and search is keyword only, so no provider is
 * ever called. The child environment is built from nothing, so it carries no provider key.
 *
 *   brain A: import the corpus with --no-embed, export every page as markdown, run the script as `gbrain call <op>
 *            '<json>'` and a few CLI-native `--json` commands, then export again.
 *   brain B: import the same corpus, start `gbrain serve` (stdio MCP), read every page through get_page with
 *            view "markdown", then run the same script as tools/call requests. The raw JSON-RPC response lines are
 *            what is compared.
 *
 * The compare step byte-compares each captured output across engines after a fixed list of normalization rules for
 * values that legitimately differ per run (timestamps, durations, temp paths, random revision ids). Every rule is
 * listed in the receipt with its replacement count per engine and surface. Anything else that differs is a parity
 * failure, reported with the operation, the surface, a short diff excerpt and a class (ordering, float formatting,
 * numeric value, timestamp or content).
 *
 * Engine selection goes through eval-engine.ts. The rust arm refuses (EvalEngineUnavailable) until the gbrain under
 * test carries the engine and its addon loads; the receipt then reports rust as `refused` with the reason, never
 * as a pass or a fail.
 *
 *   bun eval/runner/engine-bench/surface-parity.ts --dev | --prereg <path> [--engines pglite,postgres] [--gbrain <checkout>@<ref>]
 *     [--pg-url <admin url>] [--out <dir>] [--captures <dir>] [--work-dir <dir>] [--keep-work]
 *
 * Without --pg-url, a postgres arm starts a pgvector/pgvector:pg16 container on a free local port and removes it at
 * the end. GBRAIN_EVAL_ENGINE adds its engine to the default list.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { SQL } from 'bun';
import {
  EVAL_ENGINES, EvalEngineUnavailable, RUST_ENGINE_DIR, cliEngineConfig, evalEngineKind, evalEngineRequested, openEvalEngine,
  rustAddonEnv, rustAddonIdentity, rustEngineInBuild, type EvalEngineKind, type RustAddonIdentity,
} from '../eval-engine.ts';
import { gbrainSpecFrom, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from '../gbrain-under-test.ts';
import { strippedKeysIn } from '../hermetic-env.ts';
import { writeScrubbedJson } from '../receipt.ts';
import { freePort } from '../lifecycle/slice.ts';
import { countedRun } from './counted.ts';

export const SURFACE_PARITY_SCHEMA_VERSION = 'engine-bench-surface-parity/v1';
export const SURFACE_PARITY_RUNNER = 'engine-bench/surface-parity';
export const SURFACES = ['cli', 'mcp', 'markdown'] as const;
export type Surface = (typeof SURFACES)[number];
/** `refused`: only the Rust engine failed, each time with gbrain's engine_capability_missing, so it is a named gap, never a pass. */
export type OpStatus = 'identical' | 'differs' | 'errored' | 'refused' | 'not_applicable';
export type DiffClass = 'ordering' | 'float_formatting' | 'numeric_value' | 'timestamp' | 'content';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
export const WORLD_DIR = join(REPO_ROOT, 'eval/data/world-v1');
/** Every corpus file gets this mtime, so gbrain's effective_date fallback (the file's mtime) is the same on every run. */
export const CORPUS_MTIME = new Date('2025-01-01T00:00:00.000Z');
const CALL_TIMEOUT_MS = 180_000;

// ─── Corpus ─────────────────────────────────────────────────────────

export interface CorpusFile { path: string; content: string }
interface WorldPage { slug: string; type: string; title: string; compiled_truth: string; timeline?: string | string[] }

/** A world-v1 page as the markdown file a user would keep: front matter, compiled truth, then its timeline. */
export function renderWorldPage(p: WorldPage): string {
  const timeline = (Array.isArray(p.timeline) ? p.timeline.join('\n') : p.timeline ?? '').trim();
  return `---\ntitle: ${JSON.stringify(p.title)}\ntype: ${p.type}\n---\n\n${p.compiled_truth.trim()}\n${timeline ? `\n## Timeline\n\n${timeline}\n` : ''}`;
}

/** The first `perType` world-v1 pages of each slug folder by sorted slug: 15 each of companies, concepts, meetings and people by default. */
export function worldSubset(dataDir = WORLD_DIR, perType = 15): WorldPage[] {
  const pages = readdirSync(dataDir).filter(f => f.endsWith('.json') && !f.startsWith('_'))
    .map(f => JSON.parse(readFileSync(join(dataDir, f), 'utf8')) as WorldPage)
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const byFolder = new Map<string, WorldPage[]>();
  for (const p of pages) {
    const folder = p.slug.split('/')[0];
    const list = byFolder.get(folder) ?? [];
    if (list.length < perType) list.push(p);
    byFolder.set(folder, list);
  }
  return [...byFolder.keys()].sort().flatMap(k => byFolder.get(k)!);
}

function longPageBody(): string {
  const topics = ['warehouse robotics', 'seed financing', 'board governance', 'hiring plans', 'customer pilots', 'supply chains'];
  const paragraphs: string[] = [];
  for (let i = 0; i < 120; i++) {
    const t = topics[i % topics.length];
    paragraphs.push(`Paragraph ${i + 1} covers ${t}. Item ${i * 7 + 3} of the review notes that the ${t} plan moved from draft to agreed after ${(i % 9) + 2} meetings, with ${(i * 13) % 97} open questions closed and ${(i * 5) % 11} still pending.`);
  }
  return paragraphs.join('\n\n');
}

/** Edge cases the world pages lack: unicode, a long page, rich front matter, links and dense timeline lines. */
export function edgeCases(world: WorldPage[]): CorpusFile[] {
  const company = world.find(p => p.slug.startsWith('companies/'))?.slug ?? 'companies/none';
  const person = world.find(p => p.slug.startsWith('people/'))?.slug ?? 'people/none';
  return [
    { path: 'edge/unicode.md', content: `---\ntitle: "Café Zürich — 東京 ☕"\ntype: note\n---\n\nUnicode across scripts: Café, naïve, Zürich, Ελληνικά, Русский, 東京タワー, 서울, עברית, العربية, and emoji 🚀🧠.\nCombining marks: e\u0301 versus é. Zero width joiner: 👩\u200d💻.\n` },
    { path: 'edge/long-page.md', content: `---\ntitle: Long page\ntype: note\n---\n\n${longPageBody()}\n` },
    { path: 'edge/frontmatter.md', content: `---\ntitle: "Front matter: quotes, lists and numbers"\ntype: concept\ntags: [parity, frontmatter, "with space"]\naliases:\n  - FM page\n  - Front-matter page\nrating: 4.5\ncount: 12\nactive: true\ndate: 2024-03-09\nowner:\n  name: Ada\n  team: storage\n---\n\nA page whose front matter carries lists, numbers, a boolean, a date and a nested map.\n` },
    { path: 'edge/links.md', content: `---\ntitle: Links page\ntype: note\n---\n\nThis page links to [the first company](${company}), to [[${person}]] and to [the unicode page](edge/unicode).\nIt also links to [a page that does not exist](notes/missing-page) and to [the timeline page](edge/timeline).\n` },
    { path: 'edge/timeline.md', content: `---\ntitle: Timeline page\ntype: note\n---\n\nA page with a dense timeline, including two entries on one day and dates out of order.\n\n## Timeline\n\n- **2024-05-01** | Kickoff with [the first company](${company})\n- **2024-05-01** | Second entry on the same day\n- **2023-12-31** | An earlier entry listed later\n- **2024-07-15** | Mid-year review: 3.25% growth, score 0.1\n- **2025-01-02** | New year planning\n` },
  ];
}

export function buildCorpus(dataDir = WORLD_DIR, perType = 15): CorpusFile[] {
  const world = worldSubset(dataDir, perType);
  return [...world.map(p => ({ path: `${p.slug}.md`, content: renderWorldPage(p) })), ...edgeCases(world)];
}

export const slugOf = (f: CorpusFile) => f.path.replace(/\.md$/, '');

// ─── Script ─────────────────────────────────────────────────────────

/** One scripted operation. `cli` set means a CLI-native command (`gbrain <argv>`), run on the CLI surface only. */
export interface Step { id: string; op?: string; args?: Record<string, unknown>; cli?: string[] }

export function defaultScript(corpus: CorpusFile[]): Step[] {
  const slugs = corpus.map(slugOf);
  const first = (prefix: string) => slugs.find(s => s.startsWith(prefix)) ?? `${prefix}none`;
  const company = first('companies/');
  const person = first('people/');
  const meeting = first('meetings/');
  const concept = first('concepts/');
  const rid = (id: string) => `surface-parity-${id}`;
  return [
    { id: 'get_stats', op: 'get_stats', args: {} },
    { id: 'get_health', op: 'get_health', args: {} },
    { id: 'list_pages/slug', op: 'list_pages', args: { sort: 'slug', limit: 200 } },
    { id: 'list_pages/default', op: 'list_pages', args: {} },
    { id: 'list_pages/type-company', op: 'list_pages', args: { type: 'company', sort: 'slug' } },
    ...[company, person, meeting, concept, 'edge/unicode', 'edge/long-page', 'edge/frontmatter', 'edge/links', 'edge/timeline']
      .map(slug => ({ id: `get_page/${slug}`, op: 'get_page', args: { slug } })),
    ...['Acme', 'robotics startup', 'board meeting', 'Café', '東京', 'seed round', 'zzqx-no-match']
      .map(query => ({ id: `search/${query}`, op: 'search', args: { query, match: 'keyword', limit: 10 } })),
    ...[meeting, 'edge/links'].map(slug => ({ id: `get_links/${slug}`, op: 'get_links', args: { slug } })),
    ...[company, person, 'edge/timeline'].map(slug => ({ id: `get_backlinks/${slug}`, op: 'get_backlinks', args: { slug } })),
    ...[meeting, 'edge/timeline'].map(slug => ({ id: `get_timeline/${slug}`, op: 'get_timeline', args: { slug } })),
    ...['edge/frontmatter', company].map(slug => ({ id: `get_tags/${slug}`, op: 'get_tags', args: { slug } })),
    { id: 'traverse_graph/edge/links', op: 'traverse_graph', args: { slug: 'edge/links', depth: 2 } },
    { id: 'cli:stats --json', cli: ['stats', '--json'] },
    { id: 'cli:list --json', cli: ['list', '--json'] },
    { id: 'cli:search --json', cli: ['search', 'Acme', '--json'] },
    { id: 'cli:tags --json', cli: ['tags', 'edge/frontmatter', '--json'] },
    { id: 'cli:backlinks --json', cli: ['backlinks', company, '--json'] },
    { id: 'cli:timeline --json', cli: ['timeline', 'edge/timeline', '--json'] },
    { id: 'cli:get (markdown)', cli: ['get', 'edge/frontmatter'] },
    { id: 'write/put_page-update', op: 'put_page', args: { slug: 'edge/frontmatter', request_id: rid('put-update'), force: true, content: '---\ntitle: "Front matter, updated"\ntype: concept\ntags: [parity, updated]\n---\n\nThe front matter page after an update through put_page.\n' } },
    { id: 'after/get_page/edge/frontmatter', op: 'get_page', args: { slug: 'edge/frontmatter' } },
    { id: 'write/put_page-new', op: 'put_page', args: { slug: 'edge/new-page', request_id: rid('put-new'), content: '---\ntitle: New page\ntype: note\n---\n\nA page created by the script. It mentions Acme and [the links page](edge/links).\n' } },
    { id: 'after/get_page/edge/new-page', op: 'get_page', args: { slug: 'edge/new-page' } },
    { id: 'write/add_tag', op: 'add_tag', args: { slug: 'edge/new-page', tag: 'parity-added', request_id: rid('add-tag') } },
    { id: 'after/get_tags/edge/new-page', op: 'get_tags', args: { slug: 'edge/new-page' } },
    { id: 'write/add_link', op: 'add_link', args: { from: 'edge/new-page', to: company, link_type: 'mentions', request_id: rid('add-link') } },
    { id: 'after/get_links/edge/new-page', op: 'get_links', args: { slug: 'edge/new-page' } },
    { id: `after/get_backlinks/${company}`, op: 'get_backlinks', args: { slug: company } },
    { id: 'write/add_timeline_entry', op: 'add_timeline_entry', args: { slug: 'edge/new-page', date: '2025-02-03', summary: 'Added by the parity script', request_id: rid('add-timeline') } },
    { id: 'after/get_timeline/edge/new-page', op: 'get_timeline', args: { slug: 'edge/new-page' } },
    { id: 'write/delete_page', op: 'delete_page', args: { slug: 'edge/long-page', request_id: rid('delete'), force: true } },
    { id: 'after/get_page/edge/long-page', op: 'get_page', args: { slug: 'edge/long-page' } },
    { id: 'after/list_pages/slug', op: 'list_pages', args: { sort: 'slug', limit: 200 } },
    { id: 'after/search/Acme', op: 'search', args: { query: 'Acme', match: 'keyword', limit: 10 } },
    { id: 'after/get_stats', op: 'get_stats', args: {} },
  ];
}

/** sha256 over the corpus bytes (sorted by path) and the script, so a receipt names exactly what went in. */
export function inputFingerprint(corpus: CorpusFile[], script: Step[]) {
  const corpusHash = createHash('sha256');
  for (const f of [...corpus].sort((a, b) => (a.path < b.path ? -1 : 1))) corpusHash.update(`${f.path}\0${f.content}\0`);
  const corpus_sha256 = corpusHash.digest('hex');
  const script_sha256 = createHash('sha256').update(JSON.stringify(script)).digest('hex');
  const sha256 = createHash('sha256').update(`${SURFACE_PARITY_SCHEMA_VERSION}\0${corpus_sha256}\0${script_sha256}\0${CORPUS_MTIME.toISOString()}`).digest('hex');
  return { sha256, corpus_sha256, script_sha256, corpus_files: corpus.length, script_steps: script.length, corpus_mtime: CORPUS_MTIME.toISOString() };
}

// ─── Normalization ──────────────────────────────────────────────────

export interface NormalizationRule { id: string; description: string; pattern: string }

/** What the normalizer needs to know about one engine's run. */
export interface NormalizeContext { workDir: string; engineDir: string; databaseLocations: string[] }

const ISO_TS = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}(?::?\d{2})?)?/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const DURATION = /("[A-Za-z_]*(?:duration|elapsed|took|latency)[A-Za-z_]*"|"ms"|"[A-Za-z_]+_ms")(\s*:\s*)-?\d+(?:\.\d+)?/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The normalization rules, in the order they apply. Each masks only a value that legitimately changes from run to
 * run; nothing an engine computes from the inputs is masked. Timestamps equal to the fixed corpus mtime are kept,
 * because every engine must report them unchanged.
 */
export const NORMALIZATION_RULES: NormalizationRule[] = [
  { id: 'database_location', description: "This engine's PGLite data directory, Postgres URL or Rust store path, replaced by <DATABASE>.", pattern: '(exact strings per engine)' },
  { id: 'engine_dir', description: "This engine's throwaway directory (its GBRAIN_HOME, exports and store), replaced by <ENGINE_DIR>.", pattern: '(exact string per engine)' },
  { id: 'work_dir', description: 'The run work directory (the shared corpus lives under it), replaced by <WORK>.', pattern: '(exact string per run)' },
  { id: 'timestamp', description: 'ISO-8601 date-times written at run time (created_at, updated_at, ingested_at and the like), replaced by <TS:shape>, where the shape keeps every separator and the digit count (for example <TS:####-##-##T##:##:##.###Z>), so a change of precision, zone form or separator is still a difference. The fixed corpus mtime is kept.', pattern: ISO_TS.source },
  { id: 'uuid', description: 'Random UUIDs (page revisions, generated request and write ids), replaced by <UUID-n> numbered in order of first appearance within one output, so equal ids stay equal.', pattern: UUID.source },
  { id: 'duration', description: 'Wall-clock durations under keys naming a duration, elapsed time, latency or milliseconds, replaced by the string "<DURATION>" so JSON stays parseable.', pattern: DURATION.source },
  { id: 'timings', description: 'The whole object under a "timings" key (search\'s per-stage wall-clock breakdown, whose stage keys also come out in completion order), replaced by the string "<TIMINGS>".', pattern: '"timings":{ ... } (balanced, string-aware)' },
];

/** Replace the object value of every top-level-escaped `"timings":{...}` with "<TIMINGS>"; counts each one. */
function maskTimings(text: string, count: () => void): string {
  const key = '"timings":';
  let out = '';
  let from = 0;
  for (let at = text.indexOf(key); at >= 0; at = text.indexOf(key, from)) {
    let i = at + key.length;
    while (text[i] === ' ') i++;
    if (text[i] !== '{') { out += text.slice(from, i); from = i; continue; }
    let depth = 0;
    let inString = false;
    let j = i;
    for (; j < text.length; j++) {
      const ch = text[j];
      if (inString) { if (ch === '\\') j++; else if (ch === '"') inString = false; continue; }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) break;
    }
    if (depth !== 0) break;
    out += `${text.slice(from, i)}"<TIMINGS>"`;
    count();
    from = j + 1;
  }
  return out + text.slice(from);
}

export type RuleCounts = Record<string, number>;

const zeroRuleCounts = (): RuleCounts => Object.fromEntries(NORMALIZATION_RULES.map(r => [r.id, 0]));

export function normalize(text: string, ctx: NormalizeContext): { text: string; counts: RuleCounts } {
  const counts = zeroRuleCounts();
  const literal = (id: string, needles: string[], replacement: string) => {
    for (const n of needles.filter(Boolean).sort((a, b) => b.length - a.length)) {
      for (const variant of new Set([n, JSON.stringify(n).slice(1, -1)])) {
        text = text.replace(new RegExp(escapeRe(variant), 'g'), () => { counts[id]++; return replacement; });
      }
    }
  };
  literal('database_location', ctx.databaseLocations, '<DATABASE>');
  literal('engine_dir', [ctx.engineDir], '<ENGINE_DIR>');
  literal('work_dir', [ctx.workDir], '<WORK>');
  const fixed = CORPUS_MTIME.toISOString().slice(0, 19);
  text = text.replace(ISO_TS, m => {
    if (m.replace(' ', 'T').startsWith(fixed)) return m;
    counts.timestamp++;
    return `<TS:${m.replace(/\d/g, '#')}>`;
  });
  const seen = new Map<string, string>();
  text = text.replace(UUID, m => {
    counts.uuid++;
    if (!seen.has(m)) seen.set(m, `<UUID-${seen.size + 1}>`);
    return seen.get(m)!;
  });
  text = maskTimings(text, () => counts.timings++);
  text = text.replace(DURATION, (_m, key: string, sep: string) => { counts.duration++; return `${key}${sep}"<DURATION>"`; });
  return { text, counts };
}

// ─── Captures and comparison ────────────────────────────────────────

export interface Capture {
  surface: Surface;
  op: string;
  /** Raw stdout bytes (CLI), the raw JSON-RPC response line (MCP) or the exported file (markdown), base64. */
  raw_b64?: string;
  exit_code?: number;
  /** A harness failure: the step could not run or its output could not be captured. */
  error?: string;
  /** Set when this surface does not have this operation. */
  not_applicable?: string;
}

export interface EngineCapture {
  kind: EvalEngineKind;
  status: 'ran' | 'refused' | 'errored';
  reason?: string;
  refusal_reason?: string;
  ctx?: NormalizeContext;
  captures: Capture[];
  setup: Array<{ step: string; code: number; ms: number; tail?: string }>;
  /** One entry per write on each surface: how long it and its effects took to settle before the next read or export. */
  settles: Array<{ surface: 'cli' | 'mcp'; op: string; settled: boolean; polls: number; ms: number; last: string }>;
  postgres_version?: string;
}

export interface OpResult {
  surface: Surface;
  op: string;
  status: OpStatus;
  engines_compared: EvalEngineKind[];
  reason?: string;
  /** Per engine output size and sha256 after normalization. */
  /** `text` is the normalized reply, kept in full for write operations (ids starting `write/`). */
  outputs?: Partial<Record<EvalEngineKind, { bytes: number; sha256: string; exit_code?: number; text?: string }>>;
  diffs?: Array<{ reference: EvalEngineKind; engine: EvalEngineKind; class: DiffClass; excerpt: string }>;
}

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

function parseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return undefined; }
}

/** MCP text content is itself JSON; unwrap it so the ordering check can see inside. */
function deepParse(v: unknown): unknown {
  if (typeof v === 'string') { const p = parseJson(v); return p !== null && typeof p === 'object' ? deepParse(p) : v; }
  if (Array.isArray(v)) return v.map(deepParse);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepParse(x)]));
  return v;
}

/** JSON with object keys sorted and, when sortArrays is set, every array sorted by its items' canonical text. */
function canonical(v: unknown, sortArrays: boolean): unknown {
  if (Array.isArray(v)) { const items = v.map(x => canonical(x, sortArrays)); return sortArrays ? items.map(x => JSON.stringify(x)).sort() : items; }
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical((v as Record<string, unknown>)[k], sortArrays)]));
  return v;
}

const NUM = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g;
const DATE = /\d{4}-\d{2}-\d{2}(?:[T ][0-9:.]+(?:Z|[+-]\d{2}(?::?\d{2})?)?)?/g;

/**
 * Why two normalized outputs differ: the same JSON values written differently (float formatting, or key order counted
 * as ordering), the same items in another order, dates, number values, or content.
 */
export function classifyDiff(a: string, b: string): DiffClass {
  const la = a.split('\n');
  const lb = b.split('\n');
  if (la.length === lb.length && [...la].sort().join('\n') === [...lb].sort().join('\n')) return 'ordering';
  const ja = parseJson(a);
  const jb = parseJson(b);
  const numberTokensOnly = a.replace(NUM, '#') === b.replace(NUM, '#');
  if (ja !== undefined && jb !== undefined) {
    const da = deepParse(ja);
    const db = deepParse(jb);
    if (JSON.stringify(canonical(da, false)) === JSON.stringify(canonical(db, false))) return numberTokensOnly ? 'float_formatting' : 'ordering';
    if (JSON.stringify(canonical(da, true)) === JSON.stringify(canonical(db, true))) return 'ordering';
  }
  if (a.replace(DATE, '<D>') === b.replace(DATE, '<D>')) return 'timestamp';
  if (numberTokensOnly) {
    const na = a.match(NUM) ?? [];
    const nb = b.match(NUM) ?? [];
    return na.every((x, i) => Number(x) === Number(nb[i])) ? 'float_formatting' : 'numeric_value';
  }
  return 'content';
}

/** Leaf paths where two JSON values differ (MCP text payloads unwrapped), at most `max`, each value cut to 120 characters. */
export function jsonPathDiffs(a: unknown, b: unknown, max = 6): string[] {
  const out: string[] = [];
  const show = (v: unknown) => { const s = v === undefined ? '(missing)' : JSON.stringify(v); return s.length > 120 ? `${s.slice(0, 120)}…` : s; };
  const walk = (x: unknown, y: unknown, path: string) => {
    if (out.length >= max) return;
    if (x && y && typeof x === 'object' && typeof y === 'object' && Array.isArray(x) === Array.isArray(y)) {
      const keys = Array.isArray(x) ? [...Array(Math.max(x.length, (y as unknown[]).length)).keys()].map(String) : [...new Set([...Object.keys(x), ...Object.keys(y as object)])];
      for (const k of keys) walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], Array.isArray(x) ? `${path}[${k}]` : `${path}.${k}`);
      return;
    }
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push(`${path || '$'}: ${show(x)} vs ${show(y)}`);
  };
  walk(a, b, '');
  return out;
}

/**
 * Where two outputs first differ: the line and the characters around the first differing one, then, for JSON, the
 * first differing leaf paths with both values.
 */
export function diffExcerpt(a: string, b: string, labels: [string, string]): string {
  const la = a.split('\n');
  const lb = b.split('\n');
  let i = 0;
  while (i < la.length && i < lb.length && la[i] === lb[i]) i++;
  const x = la[i] ?? '';
  const y = lb[i] ?? '';
  let c = 0;
  while (c < x.length && c < y.length && x[c] === y[c]) c++;
  const window = (s: string | undefined) => (s === undefined ? '(end of output)' : `${c > 60 ? '…' : ''}${s.slice(Math.max(0, c - 60), c + 140)}${s.length > c + 140 ? '…' : ''}`);
  const out = [`first difference at line ${i + 1}, character ${c + 1}`, `- ${labels[0]}: ${window(la[i])}`, `+ ${labels[1]}: ${window(lb[i])}`];
  const ja = parseJson(a);
  const jb = parseJson(b);
  if (ja !== undefined && jb !== undefined) {
    const paths = jsonPathDiffs(deepParse(ja), deepParse(jb));
    if (paths.length) out.push(`JSON paths that differ (${labels[0]} vs ${labels[1]}):`, ...paths.map(p => `  ${p}`));
  }
  return out.join('\n');
}

export interface Comparison {
  operations: OpResult[];
  replacements: Partial<Record<EvalEngineKind, Partial<Record<Surface, RuleCounts>>>>;
}

interface Normalized { text?: string; capture: Capture }

/** Byte-compare every captured output across the engines that ran, after normalization. */
export function compareCaptures(engines: EngineCapture[]): Comparison {
  const ran = engines.filter(e => e.status === 'ran');
  const kinds = ran.map(e => e.kind);
  const replacements: Comparison['replacements'] = {};
  const normalized = new Map<EvalEngineKind, Map<string, Normalized>>();
  const keys: string[] = [];
  for (const e of ran) {
    const per = new Map<string, Normalized>();
    const counts: Partial<Record<Surface, RuleCounts>> = {};
    for (const c of e.captures) {
      const key = `${c.surface}\0${c.op}`;
      if (!keys.includes(key)) keys.push(key);
      if (c.raw_b64 === undefined) { per.set(key, { capture: c }); continue; }
      const raw = Buffer.from(c.raw_b64, 'base64');
      const decoded = raw.toString('utf8');
      if (!Buffer.from(decoded, 'utf8').equals(raw)) { per.set(key, { text: `<non-utf8 bytes, sha256 ${sha(raw)}>`, capture: c }); continue; }
      const n = normalize(decoded, e.ctx!);
      const surfaceCounts = counts[c.surface] ?? zeroRuleCounts();
      for (const [rule, k] of Object.entries(n.counts)) surfaceCounts[rule] += k;
      counts[c.surface] = surfaceCounts;
      per.set(key, { text: n.text, capture: c });
    }
    normalized.set(e.kind, per);
    replacements[e.kind] = counts;
  }
  const operations: OpResult[] = [];
  for (const key of keys) {
    const [surface, op] = key.split('\0') as [Surface, string];
    const entries = kinds.map(k => [k, normalized.get(k)!.get(key)] as const);
    const na = entries.find(([, v]) => v?.capture.not_applicable)?.[1]?.capture.not_applicable;
    if (na) { operations.push({ surface, op, status: 'not_applicable', engines_compared: [], reason: na }); continue; }
    if (kinds.length < 2) {
      operations.push({ surface, op, status: 'not_applicable', engines_compared: kinds, reason: `fewer than two engines ran (${kinds.join(', ') || 'none'}), so there is nothing to compare` });
      continue;
    }
    const refusedBy = entries.filter(([, v]) => /engine_capability_missing/.test(v?.capture.error ?? v?.text ?? ''));
    if (refusedBy.length === 1 && refusedBy[0]![0] === 'rust') {
      operations.push({ surface, op, status: 'refused', engines_compared: kinds, reason: `rust: ${(refusedBy[0]![1]!.capture.error ?? refusedBy[0]![1]!.text ?? '').slice(0, 400)}` });
      continue;
    }
    const errored = entries.filter(([, v]) => v?.capture.error);
    if (errored.length) {
      operations.push({ surface, op, status: 'errored', engines_compared: kinds, reason: errored.map(([k, v]) => `${k}: ${v!.capture.error}`).join('; ') });
      continue;
    }
    const outputs: NonNullable<OpResult['outputs']> = {};
    for (const [k, v] of entries) {
      if (v?.text !== undefined) outputs[k] = { bytes: Buffer.byteLength(v.text), sha256: sha(v.text), ...(v.capture.exit_code !== undefined ? { exit_code: v.capture.exit_code } : {}), ...(op.startsWith('write/') ? { text: v.text } : {}) };
    }
    const [refKind, ref] = entries[0];
    const diffs: NonNullable<OpResult['diffs']> = [];
    for (const [k, v] of entries.slice(1)) {
      if (ref?.text === undefined || v?.text === undefined) {
        diffs.push({ reference: refKind, engine: k, class: 'content', excerpt: `${ref?.text === undefined ? refKind : k} has no output for this operation` });
        continue;
      }
      const sameExit = ref.capture.exit_code === v.capture.exit_code;
      if (ref.text === v.text && sameExit) continue;
      const exitNote = sameExit ? '' : `exit code ${refKind}=${ref.capture.exit_code} ${k}=${v.capture.exit_code}\n`;
      diffs.push({
        reference: refKind, engine: k,
        class: ref.text === v.text ? 'content' : classifyDiff(ref.text, v.text),
        excerpt: exitNote + (ref.text === v.text ? 'output bytes identical' : diffExcerpt(ref.text, v.text, [refKind, k])),
      });
    }
    operations.push({ surface, op, status: diffs.length ? 'differs' : 'identical', engines_compared: kinds, outputs, ...(diffs.length ? { diffs } : {}) });
  }
  return { operations, replacements };
}

// ─── Child processes ────────────────────────────────────────────────

/** The environment of every gbrain child: built from nothing, so no provider key or user config can reach it. */
export function childEnv(home: string, userHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: userHome, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1', TZ: 'UTC', LANG: 'C.UTF-8', NO_COLOR: '1',
    ...rustAddonEnv(),
  };
  const keys = strippedKeysIn(env);
  if (keys.length) throw new Error(`child environment carries provider keys: ${keys.join(', ')}`);
  return env;
}

interface CliResult { code: number; stdout: Buffer; stderr: string; ms: number; timedOut: boolean }

function runGbrain(gut: GbrainUnderTest, env: NodeJS.ProcessEnv, args: string[], timeoutMs = CALL_TIMEOUT_MS): Promise<CliResult> {
  const t0 = Date.now();
  return new Promise(done => {
    const proc = spawn('bun', [join(gut.root, 'src/cli.ts'), ...args], { env, cwd: env.GBRAIN_HOME, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let stderr = '';
    let timedOut = false;
    proc.stdout.on('data', (c: Buffer) => out.push(c));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (c: string) => { stderr = (stderr + c).slice(-4000); });
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, timeoutMs);
    proc.on('close', code => { clearTimeout(timer); done({ code: code ?? -1, stdout: Buffer.concat(out), stderr, ms: Date.now() - t0, timedOut }); });
    proc.on('error', e => { clearTimeout(timer); done({ code: -1, stdout: Buffer.concat(out), stderr: `${stderr}\n${e.message}`, ms: Date.now() - t0, timedOut }); });
  });
}

const tail = (s: string, n = 400) => s.trim().split('\n').slice(-4).join(' | ').slice(-n);

/**
 * Set on `gbrain serve` only, both gbrain's own switches for background work whose timing, not the engine, decides
 * which call sees it:
 *   GBRAIN_NO_ONBOARD_NUDGE=1  the onboarding notices (onboard_*_coverage, features_auto_fix, first_run_decisions)
 *                              ride whichever call is running when a background cache refresh finishes; two runs on
 *                              one engine put them on different calls (src/core/onboard/mcp-onboarding.ts). The counts
 *                              behind them are compared through the get_health step instead.
 *   GBRAIN_SWEEP=0             the startup sweep (link and timeline extraction) fires about 3 s after start, during
 *                              the script; one dry run saw it pick up the script's new page on Postgres and not on
 *                              PGLite (src/core/sweep.ts armStartupSweep). Both brains run the same sweep to a quiet
 *                              pass with `gbrain sweep --once` before serve starts, so this only stops the race.
 */
export const MCP_SESSION_ENV = { GBRAIN_NO_ONBOARD_NUDGE: '1', GBRAIN_SWEEP: '0' } as const;

/** A stdio MCP session against `gbrain serve` that keeps each response line's raw bytes, matched by request id. */
class RawMcpSession {
  private proc: ChildProcess | null = null;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  /** get_write_request polls take ids from their own range, so a slow write cannot shift the ids of the compared calls. */
  private nextPollId = 1_000_000;
  private pending = new Map<number, { resolve: (line: Buffer) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private stderr = '';
  private closed: string | null = null;
  constructor(private gut: GbrainUnderTest, private env: NodeJS.ProcessEnv) {}

  async start(): Promise<void> {
    const proc = spawn('bun', [join(this.gut.root, 'src/cli.ts'), 'serve'], { env: { ...this.env, ...MCP_SESSION_ENV }, cwd: this.env.GBRAIN_HOME, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    proc.stdout!.on('data', (c: Buffer) => {
      this.buf = Buffer.concat([this.buf, c]);
      let nl: number;
      while ((nl = this.buf.indexOf(0x0a)) >= 0) {
        const line = Buffer.from(this.buf.subarray(0, nl));
        this.buf = this.buf.subarray(nl + 1);
        const msg = parseJson(line.toString('utf8')) as { id?: unknown } | undefined;
        if (!msg || typeof msg.id !== 'number') continue;
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(line);
      }
    });
    proc.stderr!.setEncoding('utf8');
    proc.stderr!.on('data', (c: string) => { this.stderr = (this.stderr + c).slice(-4000); });
    proc.on('close', code => {
      this.closed = `exit ${code}`;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(`MCP server exited (${this.closed}): ${tail(this.stderr)}`)); }
      this.pending.clear();
    });
    const init = parseJson((await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'engine-bench-surface-parity', version: '1' } })).toString('utf8')) as { error?: unknown } | undefined;
    if (init?.error) throw new Error(`MCP initialize failed: ${JSON.stringify(init.error).slice(0, 300)}`);
    proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }

  request(method: string, params: Record<string, unknown>, o: { poll?: boolean; timeoutMs?: number } = {}): Promise<Buffer> {
    const id = o.poll ? this.nextPollId++ : this.nextId++;
    const timeoutMs = o.timeoutMs ?? CALL_TIMEOUT_MS;
    return new Promise((res, rej) => {
      if (!this.proc || this.closed) { rej(new Error(`MCP transport closed before ${method}${this.closed ? ` (${this.closed})` : ''}`)); return; }
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Error(`MCP ${method} got no response in ${timeoutMs / 1000} s`)); }, timeoutMs);
      this.pending.set(id, { resolve: res, reject: rej, timer });
      this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async close(): Promise<void> {
    const p = this.proc;
    if (!p || this.closed) return;
    await new Promise<void>(done => {
      const t = setTimeout(() => { p.kill('SIGKILL'); done(); }, 20_000);
      p.once('close', () => { clearTimeout(t); done(); });
      p.stdin!.end();
    });
  }
}

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir).sort().flatMap(name => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full, base) : [relative(base, full)];
  });
}

const SETTLE_TIMEOUT_MS = 30_000;
const SWEEP_MAX_PASSES = 5;
const SETTLED_EFFECT = (state: unknown) => !['queued', 'pending', 'running', 'in_progress'].includes(String(state));

/**
 * Wait until a write and its post-commit effects are done, so the reads or the export after it do not race them. Over
 * stdio, put_page and friends queue a `links` effect that `gbrain serve` applies when idle; whether a read lands before
 * or after it is scheduling, not engine behaviour (a first dry run saw Postgres miss the queued mention link once). A
 * CLI write's receipt is read the same way, with `gbrain call get_write_request`, before the export after the writes, but
 * without waiting on its `embedding` effect: a CLI write applies its links in process and exits with that effect queued, and
 * only the next gbrain process that writes drains it (on a keyless brain, to `skipped`), so no read could see it settle, and
 * it changes no exported byte. Its state still shows in `last`. `poll` returns one get_write_request answer as JSON text;
 * the answers are not compared, and the receipt lists each wait.
 */
async function settleWrite(poll: () => Promise<string>, timeoutMs: number, unawaited: string[] = []): Promise<{ settled: boolean; polls: number; ms: number; last: string }> {
  const t0 = Date.now();
  let last = '';
  for (let polls = 1; ; polls++) {
    const body = parseJson(await poll().catch(e => String((e as Error).message))) as { state?: string; error?: string; effects?: Array<{ kind?: string; state?: string }> } | undefined;
    if (body?.error === 'not_found') return { settled: true, polls, ms: Date.now() - t0, last: 'no write receipt for this request_id (the operation keeps none), nothing to wait for' };
    last = body?.error ? `error ${body.error}` : `state ${body?.state ?? 'unknown'}; effects ${(body?.effects ?? []).map(x => `${x.kind}=${x.state}`).join(', ') || 'none'}`;
    if (body?.state && !body.error && SETTLED_EFFECT(body.state) && (body.effects ?? []).every(x => unawaited.includes(String(x.kind)) || SETTLED_EFFECT(x.state))) return { settled: true, polls, ms: Date.now() - t0, last };
    if (Date.now() - t0 > timeoutMs) return { settled: false, polls, ms: Date.now() - t0, last };
    await Bun.sleep(250);
  }
}

// ─── One engine ─────────────────────────────────────────────────────

export interface Brain { home: string; config: Record<string, unknown>; databaseLocation: string; drop?: () => Promise<void> }

interface EngineRunInput {
  gut: GbrainUnderTest;
  kind: EvalEngineKind;
  workDir: string;
  engineDir: string;
  corpusDir: string;
  corpus: CorpusFile[];
  script: Step[];
  makeBrain: (label: 'a' | 'b') => Promise<Brain>;
  settleTimeoutMs: number;
}

/** The child step for one engine: brain A for the CLI surface and the markdown export, brain B for MCP. */
async function captureEngine(o: EngineRunInput): Promise<EngineCapture> {
  const locations: string[] = [];
  const result: EngineCapture = { kind: o.kind, status: 'ran', captures: [], setup: [], settles: [], ctx: { workDir: o.workDir, engineDir: o.engineDir, databaseLocations: locations } };
  const brains: Brain[] = [];
  const setupStep = async (step: string, env: NodeJS.ProcessEnv, args: string[]) => {
    const r = await runGbrain(o.gut, env, args, 600_000);
    const out = r.stderr + r.stdout.toString('utf8');
    result.setup.push({ step, code: r.code, ms: r.ms, ...(r.code !== 0 ? { tail: tail(out) } : {}) });
    if (r.code !== 0) throw new Error(`${step} failed (exit ${r.code}${r.timedOut ? ', timed out' : ''}): ${tail(out)}`);
    return r;
  };
  /**
   * Run gbrain's maintenance sweep (link and timeline extraction over recently changed pages) until a pass extracts
   * nothing. `gbrain serve` runs the same sweep about 3 s after it starts, concurrently with the first calls, so
   * without this the MCP reads race it (a dry run saw Postgres finish it mid-script and PGLite not). Running it first,
   * on both brains, makes the serve's own startup sweep a no-op. The first pass's output is the compared capture.
   */
  const sweepUntilQuiet = async (label: 'a' | 'b', env: NodeJS.ProcessEnv) => {
    let first: CliResult | undefined;
    for (let pass = 1; pass <= SWEEP_MAX_PASSES; pass++) {
      const r = await setupStep(`sweep-${label}-${pass}`, env, ['sweep', '--once', '--budget-ms', '600000', '--json']);
      first ??= r;
      const body = parseJson(r.stdout.toString('utf8')) as { linksExtracted?: number; linksRemoved?: number; timelineExtracted?: number; factsReconciled?: number } | undefined;
      if (!body || !(body.linksExtracted || body.linksRemoved || body.timelineExtracted || body.factsReconciled)) return first;
    }
    throw new Error(`sweep-${label} still extracting after ${SWEEP_MAX_PASSES} passes`);
  };
  const openBrain = async (label: 'a' | 'b') => {
    const brain = await o.makeBrain(label);
    brains.push(brain);
    locations.push(brain.databaseLocation);
    mkdirSync(join(brain.home, '.gbrain'), { recursive: true });
    writeFileSync(join(brain.home, '.gbrain', 'config.json'), `${JSON.stringify(brain.config, null, 2)}\n`);
    const userHome = join(o.engineDir, `user-home-${label}`);
    mkdirSync(userHome, { recursive: true });
    const env = childEnv(brain.home, userHome);
    if (brain.config.engine === 'rust') await setupStep(`init-${label}`, env, ['init', '--migrate-only', '--non-interactive']);
    return env;
  };
  const exportMarkdown = async (env: NodeJS.ProcessEnv, phase: string) => {
    const dir = join(o.engineDir, phase);
    const r = await runGbrain(o.gut, env, ['export', '--dir', dir], 600_000);
    result.setup.push({ step: phase, code: r.code, ms: r.ms, ...(r.code !== 0 ? { tail: tail(r.stderr) } : {}) });
    if (r.code !== 0) { result.captures.push({ surface: 'markdown', op: `${phase}/(export)`, error: `gbrain export exited ${r.code}: ${tail(r.stderr)}` }); return; }
    const files = listFiles(dir);
    result.captures.push({ surface: 'markdown', op: `${phase}/(file list)`, raw_b64: Buffer.from(files.join('\n')).toString('base64') });
    for (const f of files) result.captures.push({ surface: 'markdown', op: `${phase}/${f}`, raw_b64: readFileSync(join(dir, f)).toString('base64') });
  };
  try {
    const envA = await openBrain('a');
    const imported = await setupStep('import-a', envA, ['import', o.corpusDir, '--no-embed', '--json']);
    result.captures.push({ surface: 'cli', op: 'import --no-embed --json', raw_b64: imported.stdout.toString('base64'), exit_code: imported.code });
    const swept = await sweepUntilQuiet('a', envA);
    result.captures.push({ surface: 'cli', op: 'sweep --once --json', raw_b64: swept.stdout.toString('base64'), exit_code: swept.code });
    await exportMarkdown(envA, 'export');
    for (const s of o.script) {
      const r = await runGbrain(o.gut, envA, s.cli ?? ['call', s.op!, JSON.stringify(s.args ?? {})]);
      if (r.timedOut || r.code === -1) result.captures.push({ surface: 'cli', op: s.id, error: `${r.timedOut ? 'timed out' : 'did not start'}: ${tail(r.stderr)}` });
      else result.captures.push({ surface: 'cli', op: s.id, raw_b64: r.stdout.toString('base64'), exit_code: r.code });
      const requestId = s.args?.request_id;
      if (typeof requestId !== 'string') continue;
      const settled = await settleWrite(async () => (await runGbrain(o.gut, envA, ['call', 'get_write_request', JSON.stringify({ request_id: requestId })])).stdout.toString('utf8'), o.settleTimeoutMs, ['embedding']);
      result.settles.push({ surface: 'cli', op: s.id, ...settled });
      if (!settled.settled) result.captures.push({ surface: 'cli', op: `${s.id} (settle)`, error: `write ${requestId} did not settle in ${o.settleTimeoutMs / 1000} s: ${settled.last}` });
    }
    await exportMarkdown(envA, 'export-after-writes');

    const envB = await openBrain('b');
    await setupStep('import-b', envB, ['import', o.corpusDir, '--no-embed', '--json']);
    await sweepUntilQuiet('b', envB);
    const mcp = new RawMcpSession(o.gut, envB);
    try {
      await mcp.start();
      const call = async (surface: Surface, op: string, name: string, args: Record<string, unknown>) => {
        try {
          result.captures.push({ surface, op, raw_b64: (await mcp.request('tools/call', { name, arguments: args })).toString('base64') });
        } catch (e) {
          result.captures.push({ surface, op, error: (e as Error).message });
        }
      };
      for (const f of o.corpus) {
        const slug = slugOf(f);
        await call('markdown', `get_page view=markdown/${slug}`, 'get_page', { slug, view: 'markdown', body: 'window', bytes: { offset: 0, length: 1_000_000 } });
      }
      for (const s of o.script) {
        if (s.cli) { result.captures.push({ surface: 'mcp', op: s.id, not_applicable: `CLI-native command "gbrain ${s.cli.join(' ')}" has no MCP tool; the call steps cover its operation` }); continue; }
        await call('mcp', s.id, s.op!, s.args ?? {});
        const requestId = s.args?.request_id;
        if (typeof requestId !== 'string') continue;
        const settled = await settleWrite(async () => {
          const line = await mcp.request('tools/call', { name: 'get_write_request', arguments: { request_id: requestId } }, { poll: true });
          return (parseJson(line.toString('utf8')) as { result?: { content?: Array<{ text?: string }> } } | undefined)?.result?.content?.[0]?.text ?? '';
        }, o.settleTimeoutMs);
        result.settles.push({ surface: 'mcp', op: s.id, ...settled });
        if (!settled.settled) result.captures.push({ surface: 'mcp', op: `${s.id} (settle)`, error: `write ${requestId} did not settle in ${o.settleTimeoutMs / 1000} s: ${settled.last}` });
      }
    } finally {
      await mcp.close();
    }
  } catch (e) {
    result.status = 'errored';
    result.reason = (e as Error).message;
  } finally {
    for (const b of brains) await b.drop?.().catch(() => {});
  }
  return result;
}

// ─── Postgres ───────────────────────────────────────────────────────

/** A fresh database on the Postgres server behind `adminUrl`; drop() removes it. */
export async function freshPostgresDatabase(adminUrl: string, name: string): Promise<{ url: string; version: string; drop: () => Promise<void> }> {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe database name ${name}`);
  const admin = new SQL(adminUrl);
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const version = String((await admin.unsafe('SELECT version() AS v'))[0]?.v ?? '');
    const u = new URL(adminUrl);
    u.pathname = `/${name}`;
    return {
      url: u.toString(), version,
      drop: async () => {
        const a = new SQL(adminUrl);
        try { await a.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await a.close(); }
      },
    };
  } finally {
    await admin.close();
  }
}

/** Start a throwaway pgvector container on a free local port. stop() removes it. */
export async function startPgvectorContainer(image = 'pgvector/pgvector:pg16'): Promise<{ url: string; name: string; image_digest: string; stop: () => void }> {
  const port = await freePort(0);
  const name = `engine-bench-surface-parity-${process.pid}-${Date.now()}`;
  const password = createHash('sha256').update(`${name}${Math.random()}`).digest('hex').slice(0, 24);
  const run = spawnSync('docker', ['run', '-d', '--rm', '--name', name, '-e', `POSTGRES_PASSWORD=${password}`, '-p', `127.0.0.1:${port}:5432`, image], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`docker run ${image} failed: ${tail(run.stderr)}`);
  const stop = () => { spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' }); };
  const url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
  for (let i = 0; ; i++) {
    const ready = spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres', '-h', '127.0.0.1'], { encoding: 'utf8' });
    if (ready.status === 0) {
      try { const s = new SQL(url); await s.unsafe('SELECT 1'); await s.close(); break; } catch { /* not accepting yet */ }
    }
    if (i >= 90) { stop(); throw new Error(`Postgres in ${name} did not become ready in 90 s`); }
    await Bun.sleep(1000);
  }
  const digest = spawnSync('docker', ['inspect', '--format', '{{index .RepoDigests 0}}', image], { encoding: 'utf8' }).stdout.trim();
  return { url, name, image_digest: digest, stop };
}

// ─── Orchestrator entry ─────────────────────────────────────────────

export interface SurfaceParityOptions {
  gut: GbrainUnderTest;
  engines: EvalEngineKind[];
  /** Admin URL of a Postgres server with pgvector; each postgres brain gets a fresh database on it. */
  postgresUrl?: string;
  /** Directory for this run's corpus, homes, stores and exports. A temp directory when omitted. */
  workDir?: string;
  corpus?: CorpusFile[];
  script?: Step[];
  /** Keep the work directory after the run (it is deleted by default). */
  keepWork?: boolean;
  /** Write every normalized output here, one file per engine, surface and operation, so a difference can be read in full. */
  capturesDir?: string;
  /** Extra receipt fields, for example the Postgres container's image digest. */
  environment?: Record<string, unknown>;
  /** How long a write may take to settle before its `(settle)` operation errors. 30 s when omitted. */
  settleTimeoutMs?: number;
}

export interface SurfaceParityReceipt {
  schema_version: typeof SURFACE_PARITY_SCHEMA_VERSION;
  runner: typeof SURFACE_PARITY_RUNNER;
  generated_at: string;
  gbrain: { version: string; product: ReturnType<typeof productIdentityFor>; overlay: Record<string, unknown> | null; rust_engine_in_build: boolean; rust_addon: RustAddonIdentity | null };
  input_fingerprint: ReturnType<typeof inputFingerprint>;
  keyless: { config: { embedding_disabled: true }; import_flags: string[]; child_env: string[]; mcp_session_env: typeof MCP_SESSION_ENV; mcp_session_env_why: string; provider_calls: 0 };
  engines: Record<string, { status: EngineCapture['status']; reason?: string; refusal_reason?: string; setup: EngineCapture['setup']; settles: EngineCapture['settles']; postgres_version?: string; captures: number }>;
  normalization: { rules: NormalizationRule[]; replacements: Comparison['replacements'] };
  surfaces: Record<Surface, { counts: Record<OpStatus, number>; operations: OpResult[] }>;
  differences_by_class: Partial<Record<Surface, Partial<Record<DiffClass, number>>>>;
  summary: { counts: Record<OpStatus, number>; verdict: 'byte_exact' | 'differs' | 'incomplete'; engines_ran: EvalEngineKind[]; engines_refused: EvalEngineKind[]; engines_errored: EvalEngineKind[] };
  environment: Record<string, unknown>;
}

const zeroCounts = (): Record<OpStatus, number> => ({ identical: 0, differs: 0, errored: 0, refused: 0, not_applicable: 0 });

/** Why the rust arm cannot run on this build, or null when it opens through eval-engine.ts. */
export async function rustRefusal(gut: GbrainUnderTest, storePath: string): Promise<{ reason: string; message: string } | null> {
  try {
    const opened = await openEvalEngine({ gut, kind: 'rust', databasePath: storePath });
    await (opened.engine as { disconnect?: () => Promise<void> }).disconnect?.();
    return null;
  } catch (e) {
    if (e instanceof EvalEngineUnavailable) return { reason: e.reason, message: e.message };
    throw e;
  }
}

export async function runSurfaceParity(o: SurfaceParityOptions): Promise<SurfaceParityReceipt> {
  const engines = [...new Set(o.engines)];
  for (const k of engines) if (!(EVAL_ENGINES as readonly string[]).includes(k)) throw new Error(`unknown engine ${k}`);
  const workDir = resolve(o.workDir ?? mkdtempSync(join(tmpdir(), 'surface-parity-')));
  const corpus = o.corpus ?? buildCorpus();
  const script = o.script ?? defaultScript(corpus);
  const corpusDir = join(workDir, 'corpus');
  rmSync(corpusDir, { recursive: true, force: true });
  for (const f of corpus) {
    const p = join(corpusDir, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
    utimesSync(p, CORPUS_MTIME, CORPUS_MTIME);
  }
  const captures: EngineCapture[] = [];
  try {
    for (const kind of engines) {
      const engineDir = join(workDir, 'engines', kind);
      rmSync(engineDir, { recursive: true, force: true });
      mkdirSync(engineDir, { recursive: true });
      const refused = (refusal_reason: string, reason: string) => captures.push({ kind, status: 'refused', refusal_reason, reason, captures: [], setup: [], settles: [] });
      if (kind === 'postgres' && !o.postgresUrl) { refused('postgres_url_missing', 'The postgres engine needs a database URL: pass --pg-url, or let the CLI entry start a pgvector container.'); continue; }
      if (kind === 'rust') {
        const refusal = await rustRefusal(o.gut, join(engineDir, 'probe.rust'));
        if (refusal) { refused(refusal.reason, refusal.message); continue; }
      }
      let postgresVersion: string | undefined;
      const makeBrain = async (label: 'a' | 'b'): Promise<Brain> => {
        const home = join(engineDir, `home-${label}`);
        if (kind === 'postgres') {
          const db = await freshPostgresDatabase(o.postgresUrl!, `surface_parity_${process.pid}_${Date.now()}_${label}`);
          postgresVersion = db.version;
          return { home, config: { ...cliEngineConfig('postgres', { databaseUrl: db.url }), embedding_disabled: true }, databaseLocation: db.url, drop: db.drop };
        }
        const databasePath = join(engineDir, `brain-${label}.${kind}`);
        return { home, config: { ...cliEngineConfig(kind, { databasePath }), embedding_disabled: true }, databaseLocation: databasePath };
      };
      const c = await captureEngine({ gut: o.gut, kind, workDir, engineDir, corpusDir, corpus, script, makeBrain, settleTimeoutMs: o.settleTimeoutMs ?? SETTLE_TIMEOUT_MS });
      if (postgresVersion) c.postgres_version = postgresVersion;
      captures.push(c);
    }
  } finally {
    if (!o.keepWork) rmSync(workDir, { recursive: true, force: true });
  }
  if (o.capturesDir) writeNormalizedCaptures(o.capturesDir, captures);
  return buildReceipt(o.gut, captures, corpus, script, o.environment ?? {});
}

/** One file per engine, surface and operation holding the normalized output the comparison read. */
export function writeNormalizedCaptures(dir: string, captures: EngineCapture[]): void {
  for (const e of captures) {
    if (e.status !== 'ran') continue;
    for (const c of e.captures) {
      if (c.raw_b64 === undefined) continue;
      const p = join(dir, e.kind, c.surface, `${c.op.replace(/[^A-Za-z0-9._=-]+/g, '_')}.txt`);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, normalize(Buffer.from(c.raw_b64, 'base64').toString('utf8'), e.ctx!).text);
    }
  }
}

export function buildReceipt(gut: GbrainUnderTest, captures: EngineCapture[], corpus: CorpusFile[], script: Step[], environment: Record<string, unknown>): SurfaceParityReceipt {
  const comparison = compareCaptures(captures);
  const surfaces = Object.fromEntries(SURFACES.map(s => [s, { counts: zeroCounts(), operations: [] as OpResult[] }])) as SurfaceParityReceipt['surfaces'];
  const differences: SurfaceParityReceipt['differences_by_class'] = {};
  const total = zeroCounts();
  for (const r of comparison.operations) {
    surfaces[r.surface].operations.push(r);
    surfaces[r.surface].counts[r.status]++;
    total[r.status]++;
    for (const d of r.diffs ?? []) {
      const byClass = differences[r.surface] ?? {};
      byClass[d.class] = (byClass[d.class] ?? 0) + 1;
      differences[r.surface] = byClass;
    }
  }
  const ran = captures.filter(c => c.status === 'ran').map(c => c.kind);
  const refused = captures.filter(c => c.status === 'refused').map(c => c.kind);
  const erroredEngines = captures.filter(c => c.status === 'errored').map(c => c.kind);
  const verdict = total.differs > 0 ? 'differs'
    : total.errored > 0 || total.refused > 0 || erroredEngines.length > 0 || ran.length < 2 || total.identical === 0 ? 'incomplete' : 'byte_exact';
  return {
    schema_version: SURFACE_PARITY_SCHEMA_VERSION,
    runner: SURFACE_PARITY_RUNNER,
    generated_at: new Date().toISOString(),
    gbrain: { version: gut.version, product: productIdentityFor(gut), overlay: overlaySummary(gut), rust_engine_in_build: rustEngineInBuild(gut), rust_addon: captures.some(c => c.kind === 'rust') ? rustAddonIdentity(gut) : null },
    input_fingerprint: inputFingerprint(corpus, script),
    keyless: {
      config: { embedding_disabled: true }, import_flags: ['--no-embed'],
      child_env: ['PATH', 'HOME', 'GBRAIN_HOME', 'GBRAIN_SKIP_STARTUP_HOOKS', 'TZ', 'LANG', 'NO_COLOR'], provider_calls: 0,
      mcp_session_env: MCP_SESSION_ENV,
      mcp_session_env_why: 'gbrain serve attaches its onboarding coaching notices to whichever call is running when a background refresh finishes, and runs a link and timeline extraction sweep about 3 s after start, concurrently with the script; both make results depend on scheduling, not on the engine. get_health compares the onboarding counts, and both brains run gbrain sweep --once to a quiet pass before the script.',
    },
    engines: Object.fromEntries(captures.map(c => [c.kind, {
      status: c.status, ...(c.reason ? { reason: c.reason } : {}), ...(c.refusal_reason ? { refusal_reason: c.refusal_reason } : {}),
      setup: c.setup, settles: c.settles, ...(c.postgres_version ? { postgres_version: c.postgres_version } : {}), captures: c.captures.length,
    }])),
    normalization: { rules: NORMALIZATION_RULES, replacements: comparison.replacements },
    surfaces,
    differences_by_class: differences,
    summary: { counts: total, verdict, engines_ran: ran, engines_refused: refused, engines_errored: erroredEngines },
    environment,
  };
}

// ─── CLI ────────────────────────────────────────────────────────────

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  return argv.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

/** --engines, else pglite and postgres plus GBRAIN_EVAL_ENGINE's engine when it is set. */
export function enginesFrom(argv: string[], env: Record<string, string | undefined> = process.env): EvalEngineKind[] {
  const raw = flag(argv, '--engines');
  const list = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : ['pglite', 'postgres', ...(evalEngineRequested(env) ? [evalEngineKind(env)] : [])];
  for (const k of list) if (!(EVAL_ENGINES as readonly string[]).includes(k)) throw new Error(`--engines: ${k} is not an engine. Use ${EVAL_ENGINES.join(', ')}.`);
  return [...new Set(list)] as EvalEngineKind[];
}

export function summaryLines(r: SurfaceParityReceipt): string[] {
  const lines = [`surface parity: gbrain ${r.gbrain.version}, verdict ${r.summary.verdict}, input ${r.input_fingerprint.sha256.slice(0, 12)}`];
  for (const [k, e] of Object.entries(r.engines)) lines.push(`  ${k}: ${e.status}${e.reason ? ` (${e.reason.slice(0, 200)})` : ''}`);
  for (const s of SURFACES) {
    const c = r.surfaces[s].counts;
    const classes = r.differences_by_class[s];
    lines.push(`  ${s}: ${c.identical} identical, ${c.differs} differ, ${c.errored} errored, ${c.refused} refused, ${c.not_applicable} not applicable${classes ? ` (${Object.entries(classes).map(([k, n]) => `${k} ${n}`).join(', ')})` : ''}`);
    for (const op of r.surfaces[s].operations.filter(x => x.status === 'differs' || x.status === 'errored' || x.status === 'refused')) {
      lines.push(`    ${op.status} ${op.op}${op.diffs ? ` [${op.diffs.map(d => d.class).join(',')}]` : ''}${op.reason ? `: ${op.reason.slice(0, 160)}` : ''}`);
    }
  }
  return lines;
}

async function main(argv: string[]): Promise<number> {
  const run = countedRun(argv, REPO_ROOT);
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  const engines = enginesFrom(argv);
  const outDir = resolve(flag(argv, '--out') ?? join(REPO_ROOT, 'eval/reports/engine-bench/surface-parity'));
  let postgresUrl = flag(argv, '--pg-url');
  let container: Awaited<ReturnType<typeof startPgvectorContainer>> | null = null;
  const environment: Record<string, unknown> = { platform: `${process.platform}-${process.arch}`, bun: Bun.version };
  try {
    if (engines.includes('postgres') && !postgresUrl) {
      container = await startPgvectorContainer();
      postgresUrl = container.url;
      environment.postgres = { source: 'local container', image: 'pgvector/pgvector:pg16', image_digest: container.image_digest };
    } else if (postgresUrl) {
      environment.postgres = { source: '--pg-url' };
    }
    const capturesDir = flag(argv, '--captures');
    const receipt = await runSurfaceParity({ gut, engines, postgresUrl, keepWork: argv.includes('--keep-work'), workDir: flag(argv, '--work-dir'), capturesDir: capturesDir && resolve(capturesDir), environment });
    const file = join(outDir, `surface-parity-${receipt.generated_at.replace(/[:.]/g, '-')}.json`);
    writeScrubbedJson(file, { ...receipt, ...run });
    for (const l of summaryLines(receipt)) console.log(l);
    console.log(`receipt: ${relative(process.cwd(), file)}`);
    return receipt.summary.verdict === 'byte_exact' ? 0 : receipt.summary.verdict === 'differs' ? 1 : 2;
  } finally {
    container?.stop();
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(code => process.exit(code), e => { console.error(e instanceof Error ? e.message : e); process.exit(2); });
}
