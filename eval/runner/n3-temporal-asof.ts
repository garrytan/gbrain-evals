/**
 * BrainBench N3: temporal and as-of questions through gbrain's own temporal
 * features.
 *
 * The world comes from eval/generators/n3-temporal-gen.ts: a seeded ledger
 * of people, job changes (each with a valid date and a separate recorded
 * date), meetings with timestamped chronicle events, pages with competing
 * date signals, time-zone edge pages and company metric trajectories. The
 * runner writes that ledger through gbrain's operation handlers
 * (put_page, add_timeline_entry, ontology_propose; chronicle events through
 * runChronicleExtract with a scripted judge) on in-memory PGLite, proves the
 * data landed, then asks gbrain temporal questions and scores the answers
 * against gold the generator derived from the ledger, never from gbrain.
 *
 * Features probed (operation handlers called with an OperationContext, the
 * way eval/runner/mcp-contract.ts does):
 *   - true as-of state: ontology_get(asof) over fact validity windows
 *     (valid_from / valid_until), and get_timeline(before) over timeline rows;
 *   - page-date filtering: query(until) over notes dated when they were
 *     written. Scored as a date filter; its as-of answer is compared with
 *     both the valid-time and the recorded-time gold to show where the two
 *     differ (descriptive, not in the verdict);
 *   - search date bounds (query since/until, keyword path, no embedding key);
 *   - effective date: frontmatter precedence, and recorded time (creation)
 *     for undated pages, stable across rewrites;
 *   - relative durations ('7d', '2w', '1m', '1y') on clock-relative pages,
 *     and rejection of inputs outside the documented contract;
 *   - time zones: offsets near UTC midnight, brain.timezone for naive
 *     datetimes across DST, chronicle.tz day projection;
 *   - chronicle_day (and week), chronicle_since (and kind),
 *     chronicle_on_this_day, chronicle_last_seen;
 *   - find_trajectory ranges and the latest point on or before a date.
 *
 * Accounting: every probe is scored pass (1) or fail (0). A gbrain
 * operation that throws where an answer was expected is a 'sut' error and
 * a scored miss; a thrown rejection is the pass for inputs the contract
 * rejects. A failed presence assertion is a harness error and ends the run
 * with run_status 'error'.
 *
 * Hermetic: no provider key is read (the process strips them before gbrain
 * loads), PGLite in memory, keyword search only.
 *
 * Usage: bun eval/runner/n3-temporal-asof.ts [--seed N] [--output <dir>] [--gbrain <checkout>[@ref]] [--json]
 */
import { join } from 'node:path';
import type { GBrainConfig } from 'gbrain/config';
import type { OperationContext } from 'gbrain/operations';
import type { PGLiteEngine as PGLiteEngineType } from 'gbrain/pglite-engine';
import { GoldStore } from './evaluator/gold-store.ts';
import { gbrainSpecFrom, importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { gbrainPin } from './gbrain-version.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import {
  BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, noModelSpend, receiptPath, sourceTreeIdentity, writeReceipt, type Receipt,
} from './receipt.ts';
import { dateKey, jobChangeCompany } from '../generators/job-state.ts';
import {
  N3_DEFAULT_SEED, N3_GENERATOR_VERSION, daysBetween, generateN3World, relativeWorld,
  type GeneratedN3, type N3Feature, type N3Gold, type N3Ledger, type N3Probe, type RelativeProbe,
} from '../generators/n3-temporal-gen.ts';

export const CATEGORY = 'n3-temporal-asof';
const PROVIDER_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'COHERE_API_KEY', 'TOGETHER_API_KEY', 'DEEPSEEK_API_KEY', 'XAI_API_KEY'];
const NOTE_TOKEN = 'ledgernote';
const REL_TOKEN = 'relpage';
const UNDATED_TOKEN = 'undatedpage';

export type RuntimeFeature = 'effective_date_recorded_time' | 'relative_durations' | 'date_bound_input_validation';
export type AnyFeature = N3Feature | RuntimeFeature;

export const UNSUPPORTED: ReadonlyArray<{ feature: string; reason: string }> = [
  { feature: 'relative expressions against a pinned "now"', reason: 'resolveDateBoundary (src/core/search/date-bounds.ts) reads Date.now() and no operation parameter pins the reference time. Relative durations are measured instead on clock-relative pages dated from the run date, outside the ledger fingerprint.' },
  { feature: 'natural-language relative dates in search date bounds ("yesterday", "last week", "3 days ago")', reason: 'not in the documented contract (ISO-8601 or a duration like 7d, 2w, 1m, 1y); probed as inputs that must be rejected.' },
  { feature: 'date bounds on the `search` operation', reason: 'search declares no since/until parameters; date bounds live on the `query` operation, which the probes call with expansion off on the keyword path.' },
  { feature: 'think temporal window (src/core/think/temporal-window.ts)', reason: 'reachable only through think, which calls a chat model.' },
  { feature: 'chronicle event extraction from meeting prose', reason: 'the chronicle_extract judge is a chat model. Events enter through runChronicleExtract\'s judge parameter (the seam gbrain\'s own src/eval/chronicle/harness.ts uses), so the event pages, projection, day mapping and reads are gbrain code but extraction from text is not measured.' },
  { feature: 'sub-day as-of', reason: 'ontology_get and chronicle_last_seen take a YYYY-MM-DD asof; instants inside a day are not addressable.' },
  { feature: 'default "today" anchors', reason: 'chronicle_on_this_day and chronicle_last_seen default to the database clock; probes always pass date/asof so results are reproducible.' },
];

// ─── Pure scoring helpers (exported for tests) ───────────────────────────

/** Set F1; both empty is a correct empty answer (1), one side empty is 0. */
export function setF1(expected: readonly string[], returned: readonly string[]): { f1: number; precision: number; recall: number; hits: number } {
  const exp = new Set(expected);
  const ret = new Set(returned);
  if (exp.size === 0 && ret.size === 0) return { f1: 1, precision: 1, recall: 1, hits: 0 };
  let hits = 0;
  for (const r of ret) if (exp.has(r)) hits++;
  const precision = ret.size ? hits / ret.size : 0;
  const recall = exp.size ? hits / exp.size : 0;
  return { f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0, precision, recall, hits };
}

/** Employer from note chunks: the latest "On <date>, … joined|hired by startup-N" on or before asof. */
export function employerFromNotes(chunks: ReadonlyArray<string>, asof: string): string | null {
  let best = '';
  let company: string | null = null;
  for (const text of chunks) {
    for (const m of text.matchAll(/On (\d{4}-\d{2}-\d{2}), [^.]*?\b((?:joined|hired by) startup-\d+)\./g)) {
      const c = jobChangeCompany(m[2]);
      if (c && m[1] <= asof && m[1] >= best) { best = m[1]; company = c; }
    }
  }
  return company;
}

export interface ProbeRow {
  probe_id: string;
  feature: AnyFeature;
  negative: boolean;
  status: 'scored' | 'error';
  pass: boolean;
  f1?: number;
  gold: unknown;
  predicted: unknown;
  detail?: string;
  scenario?: string;
}

export interface N3Summary {
  asof_accuracy: number;
  asof_timeline_accuracy: number;
  range_set_f1: number;
  range_probes: number;
  last_seen_mae_days: number | null;
  last_seen_mae_n: number;
  last_seen_exact_rate: number;
  negative_control_pass_rate: number;
  negative_controls: number;
  feature_pass_rates: Record<string, { passed: number; total: number; rate: number }>;
  asof_by_scenario: Record<string, { facts: string; timeline: string }>;
  pagedate_asof: { vs_recorded_time: string; vs_valid_time: string; probes_where_valid_differs_from_recorded: number };
}

const RANGE_FEATURES: ReadonlySet<AnyFeature> = new Set<AnyFeature>([
  'search_date_bounds', 'pagedate_filter', 'chronicle_day', 'chronicle_week', 'chronicle_since', 'chronicle_since_kind',
  'chronicle_on_this_day', 'timezone_chronicle', 'trajectory_range', 'relative_durations',
]);

const frac = (n: number, d: number) => `${n}/${d}`;
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;

export function summarize(rows: readonly ProbeRow[], extras: { lastSeenErrors: number[]; pagedate: Array<{ recorded_ok: boolean; valid_ok: boolean; differs: boolean }> }): N3Summary {
  const byFeature = new Map<string, ProbeRow[]>();
  for (const r of rows) byFeature.set(r.feature, [...(byFeature.get(r.feature) ?? []), r]);
  const rate = (f: string) => { const rs = byFeature.get(f) ?? []; return rs.length ? rs.filter(r => r.pass).length / rs.length : NaN; };
  const feature_pass_rates: N3Summary['feature_pass_rates'] = {};
  for (const [f, rs] of [...byFeature.entries()].sort()) feature_pass_rates[f] = { passed: rs.filter(r => r.pass).length, total: rs.length, rate: rs.filter(r => r.pass).length / rs.length };
  const range = rows.filter(r => RANGE_FEATURES.has(r.feature));
  const neg = rows.filter(r => r.negative);
  const scenarios: N3Summary['asof_by_scenario'] = {};
  for (const r of rows.filter(x => x.feature === 'asof_facts' || x.feature === 'asof_timeline')) {
    const s = r.scenario ?? 'unknown';
    scenarios[s] ??= { facts: '0/0', timeline: '0/0' };
    const key = r.feature === 'asof_facts' ? 'facts' : 'timeline';
    const [p, t] = scenarios[s][key].split('/').map(Number);
    scenarios[s][key] = frac(p + (r.pass ? 1 : 0), t + 1);
  }
  const ls = byFeature.get('chronicle_last_seen') ?? [];
  return {
    asof_accuracy: rate('asof_facts'),
    asof_timeline_accuracy: rate('asof_timeline'),
    range_set_f1: mean(range.map(r => r.f1 ?? 0)),
    range_probes: range.length,
    last_seen_mae_days: extras.lastSeenErrors.length ? mean(extras.lastSeenErrors) : null,
    last_seen_mae_n: extras.lastSeenErrors.length,
    last_seen_exact_rate: ls.length ? ls.filter(r => r.pass).length / ls.length : NaN,
    negative_control_pass_rate: neg.length ? neg.filter(r => r.pass).length / neg.length : NaN,
    negative_controls: neg.length,
    feature_pass_rates,
    asof_by_scenario: scenarios,
    pagedate_asof: {
      vs_recorded_time: frac(extras.pagedate.filter(p => p.recorded_ok).length, extras.pagedate.length),
      vs_valid_time: frac(extras.pagedate.filter(p => p.valid_ok).length, extras.pagedate.length),
      probes_where_valid_differs_from_recorded: extras.pagedate.filter(p => p.differs).length,
    },
  };
}

/** Contract targets: exact conformance on every metric. */
export function n3Verdict(s: N3Summary): 'pass' | 'fail' {
  const EPS = 1e-9;
  const perfect = s.asof_accuracy >= 1 - EPS
    && s.asof_timeline_accuracy >= 1 - EPS
    && s.range_set_f1 >= 1 - EPS
    && (s.last_seen_mae_days === null || s.last_seen_mae_days <= EPS)
    && s.last_seen_exact_rate >= 1 - EPS
    && s.negative_control_pass_rate >= 1 - EPS
    && Object.values(s.feature_pass_rates).every(f => f.rate >= 1 - EPS);
  return perfect ? 'pass' : 'fail';
}

// ─── gbrain surface ──────────────────────────────────────────────────────

type OperationsModule = typeof import('gbrain/operations');
type EngineModule = typeof import('gbrain/pglite-engine');
interface ChronicleExtractModule {
  runChronicleExtract: (engine: unknown, opts: { slug: string; sourceId?: string; tz?: string; judge?: (input: unknown) => Promise<{ events: unknown[] }> }) => Promise<{ status: string; events_written: number; reason?: string }>;
}
interface ChronicleConfigModule { chronicleTz: (engine: unknown) => Promise<string> }

interface Sut {
  engine: PGLiteEngineType;
  op: (name: string, params: Record<string, unknown>) => Promise<unknown>;
  sql: <T = Record<string, unknown>>(q: string, params?: unknown[]) => Promise<T[]>;
  extract: ChronicleExtractModule['runChronicleExtract'];
  chronicleTz: ChronicleConfigModule['chronicleTz'];
}

async function openSut(gut: GbrainUnderTest): Promise<Sut> {
  const { PGLiteEngine } = await importGbrain<EngineModule>(gut, 'src/core/pglite-engine.ts');
  const { operations } = await importGbrain<OperationsModule>(gut, 'src/core/operations.ts');
  const { runChronicleExtract } = await importGbrain<ChronicleExtractModule>(gut, 'src/core/chronicle/extract-events.ts');
  const { chronicleTz } = await importGbrain<ChronicleConfigModule>(gut, 'src/core/chronicle/config.ts');
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const config: GBrainConfig = { engine: 'pglite', database_path: ':memory:' };
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  // Trusted local caller, the posture of the gbrain CLI (remote: false).
  const ctx: OperationContext = { engine, config, logger: logger as never, dryRun: false, remote: false, sourceId: 'default' };
  const byName = new Map(operations.map(o => [o.name, o]));
  return {
    engine,
    op: async (name, params) => {
      const o = byName.get(name);
      if (!o) throw new HarnessError(`gbrain has no operation ${name}`);
      return await o.handler(ctx, params);
    },
    sql: async (q, params) => await (engine as unknown as { executeRaw: <T>(q: string, p?: unknown[]) => Promise<T[]> }).executeRaw(q, params),
    extract: runChronicleExtract,
    chronicleTz,
  };
}

class HarnessError extends Error {}

// ─── Seeding ─────────────────────────────────────────────────────────────

function page(frontmatter: Record<string, string | string[]>, body: string): string {
  const yaml = Object.entries(frontmatter).map(([k, v]) => Array.isArray(v) ? `${k}: [${v.join(', ')}]` : `${k}: ${v}`).join('\n');
  return `---\n${yaml}\n---\n${body}\n`;
}

function factsFence(points: ReadonlyArray<{ valid_from: string; value: number }>, company: string): string {
  const header = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context | claim_metric | claim_value | claim_unit | claim_period |';
  const sep = '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|--------------|-------------|------------|--------------|';
  const rows = points.map((p, i) => `| ${i + 1} | Team size ${p.value} at ${company} | fact | 1.0 | world | medium | ${p.valid_from} |  | ledger |  | team_size | ${p.value} | people |  |`);
  return ['## Facts', '', '<!--- gbrain:facts:begin -->', '', header, sep, ...rows, '<!--- gbrain:facts:end -->', ''].join('\n');
}

export interface SeedReport {
  writes: number;
  write_errors: string[];
  undated_written: Array<{ slug: string; before_ms: number; after_ms: number }>;
  relative_anchor: string;
  relative_pages: ReturnType<typeof relativeWorld>['pages'];
  chronicle_extract: Array<{ slug: string; status: string; events_written: number; reason?: string }>;
}

async function seed(sut: Sut, ledger: N3Ledger, anchorDay: string): Promise<SeedReport> {
  const report: SeedReport = { writes: 0, write_errors: [], undated_written: [], relative_anchor: anchorDay, relative_pages: [], chronicle_extract: [] };
  const write = async (name: string, params: Record<string, unknown>) => {
    try { await sut.op(name, params); report.writes++; }
    catch (e) { report.write_errors.push(`${name} ${String(params.slug ?? params.entity ?? '')}: ${e instanceof Error ? e.message : String(e)}`); }
  };
  await sut.engine.setConfig('search.mcp_keyword_only', 'true');
  await sut.engine.setConfig('brain.timezone', ledger.brain_timezone);
  await sut.engine.setConfig('chronicle.tz', ledger.chronicle_tz);

  for (const c of ledger.companies) {
    const traj = ledger.trajectories.find(t => t.company === c.slug);
    await write('put_page', { slug: c.slug, content: page({ type: 'company', title: c.id }, `${c.id} is a fictional company.\n\n${traj ? factsFence(traj.points, c.id) : ''}`) });
  }
  for (const p of ledger.people) await write('put_page', { slug: p.slug, content: page({ type: 'person', title: p.name }, `Profile of ${p.name}, a fictional person.`) });
  for (const p of ledger.precedence_pages) {
    await write('put_page', { slug: p.slug, content: page({ type: 'note', title: `Precedence ${p.token}`, ...p.frontmatter }, `Precedence probe page. ${p.token} precedencepage`) });
  }
  for (const t of ledger.tz_pages) await write('put_page', { slug: t.slug, content: page({ type: 'note', title: `TZ ${t.token}`, event_date: t.event_date }, `Time-zone probe page (${t.case}). ${t.token} tzpage`) });
  for (const u of ledger.undated_pages) {
    const before = Date.now();
    await write('put_page', { slug: u.slug, content: page({ type: 'note', title: `Undated ${u.token}` }, `An undated page. ${u.token} ${UNDATED_TOKEN}`) });
    report.undated_written.push({ slug: u.slug, before_ms: before, after_ms: Date.now() });
  }
  const rel = relativeWorld(anchorDay);
  report.relative_pages = rel.pages;
  for (const r of rel.pages) await write('put_page', { slug: r.slug, content: page({ type: 'note', title: `Relative ${r.age_days}d`, date: r.date }, `Clock-relative page aged ${r.age_days} days. ${REL_TOKEN}`) });

  // Person events in RECORDED order: the note is written on recorded_on,
  // the timeline row carries the valid date, the employer fact carries
  // valid_from = valid date. Late records therefore arrive backdated.
  const personName = new Map(ledger.people.map(p => [p.slug, p]));
  const ordered = [...ledger.person_events].sort((a, b) => a.recorded_on < b.recorded_on ? -1 : a.recorded_on > b.recorded_on ? 1 : a.id < b.id ? -1 : 1);
  for (const e of ordered) {
    const person = personName.get(e.person)!;
    await write('put_page', {
      slug: e.note_slug,
      content: page({ type: 'note', title: `Note about ${person.name}`, date: e.recorded_on }, `On ${e.date}, ${person.name} ${e.summary}. Note written ${e.recorded_on}. ${NOTE_TOKEN} ${person.token}`),
    });
    await write('add_timeline_entry', { slug: e.person, date: e.date, summary: e.summary, source: e.note_slug });
    if (jobChangeCompany(e.summary)) {
      await write('ontology_propose', { entity: e.person, dimension: 'employer', value: e.company, valid_from: e.date, source: e.note_slug, confidence: 0.9 });
    }
  }

  const tz = await sut.chronicleTz(sut.engine);
  for (const m of ledger.meetings) {
    await write('put_page', {
      slug: m.slug,
      content: page({ type: 'meeting', title: `Meeting ${m.token}`, date: m.date, attendees: m.attendees }, `Meeting notes for a fictional meeting. ${m.token} meetingpage. ${'The group reviewed plans and follow-ups. '.repeat(3)}`),
    });
    try {
      const r = await sut.extract(sut.engine, { slug: m.slug, tz, judge: async () => ({ events: m.events.map(e => ({ when: e.when, who: e.who, what: e.what, kind: e.kind })) }) });
      report.chronicle_extract.push({ slug: m.slug, ...r });
    } catch (e) {
      report.write_errors.push(`runChronicleExtract ${m.slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return report;
}

// ─── Presence ────────────────────────────────────────────────────────────

export interface PresenceCheck { name: string; expected: number; actual: number; ok: boolean }

async function presence(sut: Sut, ledger: N3Ledger, seedReport: SeedReport): Promise<PresenceCheck[]> {
  const checks: PresenceCheck[] = [];
  const check = (name: string, expected: number, actual: number) => checks.push({ name, expected, actual, ok: expected === actual });
  const slugs = [
    ...ledger.companies.map(c => c.slug), ...ledger.people.map(p => p.slug), ...ledger.person_events.map(e => e.note_slug),
    ...ledger.meetings.map(m => m.slug), ...ledger.precedence_pages.map(p => p.slug), ...ledger.tz_pages.map(t => t.slug),
    ...ledger.undated_pages.map(u => u.slug), ...seedReport.relative_pages.map(r => r.slug),
  ];
  const present = await sut.sql<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE deleted_at IS NULL AND slug = ANY($1::text[])`, [slugs]);
  check('ledger pages present', new Set(slugs).size, Number(present[0]?.n ?? 0));
  const chronicleEvents = ledger.meetings.reduce((n, m) => n + m.events.length, 0);
  const tl = await sut.sql<{ own: number; projected: number }>(`SELECT count(*) FILTER (WHERE event_page_id IS NULL)::int AS own, count(*) FILTER (WHERE event_page_id IS NOT NULL)::int AS projected FROM timeline_entries`);
  check('person timeline rows', ledger.person_events.length, Number(tl[0]?.own ?? 0));
  check('chronicle event projections', chronicleEvents, Number(tl[0]?.projected ?? 0));
  const ev = await sut.sql<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE deleted_at IS NULL AND slug LIKE 'life/events/%'`);
  check('chronicle event pages', chronicleEvents, Number(ev[0]?.n ?? 0));
  const jobs = ledger.person_events.filter(e => jobChangeCompany(e.summary)).length;
  const emp = await sut.sql<{ n: number }>(`SELECT count(*)::int AS n FROM facts WHERE dimension = 'employer'`);
  check('employer facts (one row per proposal)', jobs, Number(emp[0]?.n ?? 0));
  const points = ledger.trajectories.reduce((n, t) => n + t.points.length, 0);
  const met = await sut.sql<{ n: number }>(`SELECT count(*)::int AS n FROM facts WHERE claim_metric = 'team_size' AND expired_at IS NULL`);
  check('team_size metric facts', points, Number(met[0]?.n ?? 0));
  // The keyword index answers at all: every tz page is found by its own token.
  let found = 0;
  for (const t of ledger.tz_pages) {
    const r = await sut.op('query', { query: t.token, expand: false, limit: 10, autocut: false, adaptive_return: false }) as Array<{ slug: string }>;
    if (r.some(x => x.slug === t.slug)) found++;
  }
  check('keyword index finds each tz page by token (no date bounds)', ledger.tz_pages.length, found);
  check('seed write errors', 0, seedReport.write_errors.length);
  return checks;
}

// ─── Probing ─────────────────────────────────────────────────────────────

interface Ctx {
  sut: Sut;
  gold: GoldStore<N3Gold>;
  acc: ProbeAccounting;
  rows: ProbeRow[];
  negative: Set<string>;
  lastSeenErrors: number[];
  pagedate: Array<{ recorded_ok: boolean; valid_ok: boolean; differs: boolean }>;
}

const errMsg = (e: unknown) => e instanceof Error ? e.message : String(e);

function record(c: Ctx, row: Omit<ProbeRow, 'status'> & { status?: ProbeRow['status'] }): void {
  const full: ProbeRow = { status: 'scored', ...row };
  c.rows.push(full);
  if (full.status === 'error') c.acc.error(full.probe_id, 'sut', String(full.detail ?? 'operation threw'));
  else c.acc.score(full.probe_id, full.pass ? 1 : 0);
}

const QUERY_DEFAULTS = { expand: false, limit: 100, autocut: false, adaptive_return: false, use_cache: false } as const;

async function querySlugs(sut: Sut, params: Record<string, unknown>): Promise<Array<{ slug: string; text: string }>> {
  const r = await sut.op('query', { ...QUERY_DEFAULTS, ...params }) as Array<{ slug: string; chunk_text?: string }>;
  return r.map(x => ({ slug: x.slug, text: x.chunk_text ?? '' }));
}

const uniq = (xs: string[]) => [...new Set(xs)].sort();

async function runProbe(c: Ctx, p: N3Probe): Promise<void> {
  const g = c.gold.read(p.id);
  const negative = c.negative.has(p.id);
  const base = { probe_id: p.id, feature: p.feature, negative, gold: g };
  try {
    switch (p.feature) {
      case 'asof_facts': {
        const r = await c.sut.op('ontology_get', { entity: p.person, asof: p.asof }) as Array<{ dimension: string; value: string }>;
        const value = r.find(x => x.dimension === 'employer')?.value ?? null;
        const want = (g as { company: string | null }).company;
        record(c, { ...base, scenario: p.scenario, pass: value === want, predicted: value });
        return;
      }
      case 'asof_timeline': {
        const r = await c.sut.op('get_timeline', { slug: p.person, before: p.asof, limit: 1000 }) as Array<{ date: unknown; summary: string }>;
        const leaked = r.filter(x => dateKey(x.date) > p.asof).length;
        // No harness date filter: gbrain's `before` bound decides which rows count.
        let best = '';
        let company: string | null = null;
        for (const row of r) { const d = dateKey(row.date); const co = jobChangeCompany(row.summary); if (co && d >= best) { best = d; company = co; } }
        const want = (g as { company: string | null }).company;
        record(c, { ...base, scenario: p.scenario, pass: company === want && leaked === 0, predicted: company, detail: leaked ? `${leaked} rows after asof` : undefined });
        return;
      }
      case 'pagedate_filter': {
        const hits = await querySlugs(c.sut, { query: p.token, until: p.asof });
        const slugs = uniq(hits.map(h => h.slug));
        const s = setF1((g as { ids: string[] }).ids, slugs);
        const derived = employerFromNotes(hits.map(h => h.text), p.asof);
        const facts = c.gold.read(`asof_facts:${p.id.slice('pagedate_filter:'.length)}`) as { company: string | null; recorded_company?: string | null };
        c.pagedate.push({ recorded_ok: derived === (facts.recorded_company ?? null), valid_ok: derived === facts.company, differs: facts.company !== (facts.recorded_company ?? null) });
        record(c, { ...base, scenario: p.scenario, pass: s.f1 === 1, f1: s.f1, predicted: { slugs, derived_employer: derived } });
        return;
      }
      case 'search_date_bounds': {
        const params: Record<string, unknown> = { query: p.token };
        if (p.since) params.since = p.since;
        if (p.until) params.until = p.until;
        const slugs = uniq((await querySlugs(c.sut, params)).map(h => h.slug));
        const s = setF1((g as { ids: string[] }).ids, slugs);
        record(c, { ...base, pass: s.f1 === 1, f1: s.f1, predicted: slugs });
        return;
      }
      case 'effective_date_precedence':
      case 'timezone_search': {
        const want = g as Extract<N3Gold, { kind: 'page_days' }>;
        const checks: Record<string, boolean> = {};
        let fieldDay: string | null = null;
        let fieldSource: string | null = null;
        if (p.feature === 'effective_date_precedence') {
          const pg = await c.sut.op('get_page', { slug: p.slug }) as { effective_date?: unknown; effective_date_source?: string | null };
          fieldDay = pg.effective_date == null ? null : new Date(pg.effective_date as string).toISOString().slice(0, 10);
          fieldSource = pg.effective_date_source ?? null;
          checks.field_day = fieldDay === want.include_day;
          checks.field_source = fieldSource === want.source;
        }
        for (const day of p.check_days) {
          const slugs = (await querySlugs(c.sut, { query: p.token, since: day, until: day })).map(h => h.slug);
          checks[`${day === want.include_day ? 'includes' : 'excludes'} ${day}`] = day === want.include_day ? slugs.includes(p.slug) : !slugs.includes(p.slug);
        }
        const pass = Object.values(checks).every(Boolean);
        record(c, { ...base, scenario: p.feature === 'timezone_search' ? p.case : undefined, pass, predicted: { field_day: fieldDay, field_source: fieldSource, checks } });
        return;
      }
      case 'chronicle_day':
      case 'chronicle_week':
      case 'timezone_chronicle':
      case 'chronicle_since':
      case 'chronicle_since_kind':
      case 'chronicle_on_this_day': {
        const opName = p.feature === 'chronicle_since' || p.feature === 'chronicle_since_kind' ? 'chronicle_since'
          : p.feature === 'chronicle_on_this_day' ? 'chronicle_on_this_day' : 'chronicle_day';
        const params: Record<string, unknown> = { date: p.date, limit: 100000 };
        if (p.feature === 'chronicle_week') params.week = true;
        if (p.feature === 'chronicle_since_kind') params.kind = p.kind;
        const r = await c.sut.op(opName, params) as Array<{ page_slug: string; date: unknown; summary: string }>;
        const ids = uniq(r.map(x => `${x.page_slug}|${dateKey(x.date)}|${x.summary}`));
        const s = setF1((g as { ids: string[] }).ids, ids);
        record(c, { ...base, pass: s.f1 === 1, f1: s.f1, predicted: ids });
        return;
      }
      case 'chronicle_last_seen': {
        const r = await c.sut.op('chronicle_last_seen', { entity: p.entity, asof: p.asof }) as { last_date: string | null; days_ago: number | null };
        const want = g as Extract<N3Gold, { kind: 'last_seen' }>;
        const lastDate = r.last_date == null ? null : dateKey(r.last_date);
        if (lastDate !== null && want.last_date !== null) c.lastSeenErrors.push(Math.abs(daysBetween(want.last_date, lastDate)));
        record(c, { ...base, scenario: p.case, pass: lastDate === want.last_date && r.days_ago === want.days_ago, predicted: { last_date: lastDate, days_ago: r.days_ago } });
        return;
      }
      case 'trajectory_range': {
        const r = await c.sut.op('find_trajectory', { entity_slug: p.entity, metric: p.metric, since: p.since, until: p.until, limit: 500 }) as { points: Array<{ valid_from: string }> };
        const got = uniq(r.points.map(x => x.valid_from));
        const s = setF1((g as { ids: string[] }).ids, got);
        record(c, { ...base, pass: s.f1 === 1, f1: s.f1, predicted: got });
        return;
      }
      case 'trajectory_asof': {
        const r = await c.sut.op('find_trajectory', { entity_slug: p.entity, metric: p.metric, until: p.asof, limit: 500 }) as { points: Array<{ valid_from: string; value: number }> };
        const latest = [...r.points].sort((a, b) => a.valid_from < b.valid_from ? -1 : 1).pop();
        const value = latest ? Number(latest.value) : null;
        record(c, { ...base, pass: value === (g as { value: number | null }).value, predicted: value });
        return;
      }
    }
  } catch (e) {
    if (e instanceof HarnessError) throw e;
    record(c, { ...base, status: 'error', pass: false, f1: RANGE_FEATURES.has(p.feature) ? 0 : undefined, predicted: null, detail: errMsg(e) });
  }
}

/** Clock-dependent probes: gold from the harness clock and the run's anchor day, kept in their own GoldStore. */
async function runtimeProbes(c: Omit<Ctx, 'gold'>, ledger: N3Ledger, seedReport: SeedReport): Promise<void> {
  type RuntimeGold = { kind: 'ages'; ages: number[] } | { kind: 'reject' } | { kind: 'undated'; before_ms: number; after_ms: number } | { kind: 'stable' } | { kind: 'excluded_recent' };
  const entries: Array<[string, RuntimeGold]> = [];
  const rel = relativeWorld(seedReport.relative_anchor);
  for (const rp of rel.probes) entries.push([rp.id, rp.expected_ages === 'reject' ? { kind: 'reject' } : { kind: 'ages', ages: rp.expected_ages }]);
  for (const u of seedReport.undated_written) {
    entries.push([`recorded_time:fallback:${u.slug}`, { kind: 'undated', before_ms: u.before_ms, after_ms: u.after_ms }]);
    entries.push([`recorded_time:stable-after-rewrite:${u.slug}`, { kind: 'stable' }]);
  }
  const dated = ledger.precedence_pages[0];
  entries.push([`recorded_time:stable-after-rewrite:${dated.slug}`, { kind: 'stable' }]);
  entries.push([`recorded_time:rewritten-dated-page-not-recent:${dated.slug}`, { kind: 'excluded_recent' }]);
  entries.push(['recorded_time:undated-pages-in-7d', { kind: 'ages', ages: [] }]);
  const gold = new GoldStore<RuntimeGold>('n3-clock-relative', entries);

  const ageOf = new Map(seedReport.relative_pages.map(r => [r.slug, r.age_days]));
  for (const rp of rel.probes as RelativeProbe[]) {
    const feature: RuntimeFeature = rp.expected_ages === 'reject' ? 'date_bound_input_validation' : 'relative_durations';
    const g = gold.read(rp.id);
    const params: Record<string, unknown> = { query: REL_TOKEN };
    if (rp.since) params.since = rp.since;
    if (rp.until) params.until = rp.until;
    try {
      const hits = await querySlugs(c.sut, params);
      const ages = uniq(hits.map(h => String(ageOf.get(h.slug) ?? h.slug)));
      if (g.kind === 'reject') {
        record(c as Ctx, { probe_id: rp.id, feature, negative: false, gold: g, pass: false, predicted: { accepted: true, returned: ages }, detail: 'accepted an input the documented contract rejects' });
      } else {
        const want = (g as { ages: number[] }).ages.map(String);
        const s = setF1(want, ages);
        record(c as Ctx, { probe_id: rp.id, feature, negative: want.length === 0, gold: g, pass: s.f1 === 1, f1: s.f1, predicted: ages });
      }
    } catch (e) {
      if (g.kind === 'reject') record(c as Ctx, { probe_id: rp.id, feature, negative: false, gold: g, pass: true, predicted: { rejected: errMsg(e).slice(0, 160) } });
      else record(c as Ctx, { probe_id: rp.id, feature, negative: false, gold: g, status: 'error', pass: false, f1: 0, predicted: null, detail: errMsg(e) });
    }
  }

  const feature: RuntimeFeature = 'effective_date_recorded_time';
  const eff = async (slug: string) => {
    const pg = await c.sut.op('get_page', { slug }) as { effective_date?: unknown; effective_date_source?: string | null };
    return { ms: pg.effective_date == null ? null : new Date(pg.effective_date as string).getTime(), source: pg.effective_date_source ?? null };
  };
  const rewrite = async (slug: string, fm: Record<string, string>, body: string) => {
    await new Promise(r => setTimeout(r, 25));
    await c.sut.op('put_page', { slug, content: page(fm, body), force: true });
  };
  for (const u of seedReport.undated_written) {
    const id1 = `recorded_time:fallback:${u.slug}`;
    const id2 = `recorded_time:stable-after-rewrite:${u.slug}`;
    const tok = ledger.undated_pages.find(x => x.slug === u.slug)!.token;
    try {
      const first = await eff(u.slug);
      const g1 = gold.read(id1) as { before_ms: number; after_ms: number };
      const inWindow = first.ms !== null && first.ms >= g1.before_ms - 1000 && first.ms <= g1.after_ms + 1000;
      record(c as Ctx, { probe_id: id1, feature, negative: false, gold: g1, pass: first.source === 'fallback' && inWindow, predicted: first });
      await rewrite(u.slug, { type: 'note', title: `Undated ${tok}` }, `An undated page, edited. ${tok} ${UNDATED_TOKEN}`);
      const second = await eff(u.slug);
      record(c as Ctx, { probe_id: id2, feature, negative: false, gold: gold.read(id2), pass: second.ms === first.ms && second.source === first.source, predicted: { before: first, after: second } });
    } catch (e) {
      for (const id of [id1, id2]) if (!c.rows.some(r => r.probe_id === id)) record(c as Ctx, { probe_id: id, feature, negative: false, gold: gold.read(id), status: 'error', pass: false, predicted: null, detail: errMsg(e) });
    }
  }
  const idStable = `recorded_time:stable-after-rewrite:${dated.slug}`;
  const idRecent = `recorded_time:rewritten-dated-page-not-recent:${dated.slug}`;
  try {
    const before = await eff(dated.slug);
    await rewrite(dated.slug, { type: 'note', title: `Precedence ${dated.token}`, ...dated.frontmatter }, `Precedence probe page, edited today. ${dated.token} precedencepage`);
    const after = await eff(dated.slug);
    record(c as Ctx, { probe_id: idStable, feature, negative: false, gold: gold.read(idStable), pass: before.ms === after.ms && before.source === after.source, predicted: { before, after } });
    // updated_at is now, the event date is in 2023: a 7-day window must not include it.
    const recent = (await querySlugs(c.sut, { query: dated.token, since: '7d' })).map(h => h.slug);
    record(c as Ctx, { probe_id: idRecent, feature, negative: true, gold: gold.read(idRecent), pass: !recent.includes(dated.slug), predicted: recent });
  } catch (e) {
    for (const id of [idStable, idRecent]) if (!c.rows.some(r => r.probe_id === id)) record(c as Ctx, { probe_id: id, feature, negative: id === idRecent, gold: gold.read(id), status: 'error', pass: false, predicted: null, detail: errMsg(e) });
  }
  // Undated pages were recorded minutes ago: '7d' must include all of them (fallback = recorded time).
  const id7 = 'recorded_time:undated-pages-in-7d';
  try {
    const got = uniq((await querySlugs(c.sut, { query: UNDATED_TOKEN, since: '7d' })).map(h => h.slug));
    const want = uniq(seedReport.undated_written.map(u => u.slug));
    const s = setF1(want, got);
    record(c as Ctx, { probe_id: id7, feature, negative: false, gold: { kind: 'set', ids: want }, pass: s.f1 === 1, f1: s.f1, predicted: got });
  } catch (e) {
    record(c as Ctx, { probe_id: id7, feature, negative: false, gold: gold.read(id7), status: 'error', pass: false, predicted: null, detail: errMsg(e) });
  }
}

/** Number of clock-relative probes the runtime phase adds (for n_total). */
export function runtimeProbeCount(ledger: N3Ledger): number {
  return relativeWorld('2026-01-01').probes.length + ledger.undated_pages.length * 2 + 3;
}

// ─── Run ─────────────────────────────────────────────────────────────────

export interface N3RunResult {
  world: GeneratedN3;
  goldFingerprint: string;
  seedReport: SeedReport | null;
  presence: PresenceCheck[];
  rows: ProbeRow[];
  summary: N3Summary | null;
  verdict: 'pass' | 'fail' | null;
  acc: ProbeAccounting;
  harnessError: string | null;
}

export async function runN3(opts: { gut: GbrainUnderTest; seed?: number; people?: number; meetings?: number; anchorDay?: string; log?: (s: string) => void }): Promise<N3RunResult> {
  for (const k of PROVIDER_KEYS) delete process.env[k];
  const log = opts.log ?? (() => {});
  const world = generateN3World({ seed: opts.seed ?? N3_DEFAULT_SEED, people: opts.people, meetings: opts.meetings });
  const gold = new GoldStore<N3Gold>('n3-temporal', world.gold.entries());
  const acc = new ProbeAccounting(world.probes.length + runtimeProbeCount(world.ledger));
  const result: N3RunResult = { world, goldFingerprint: gold.fingerprint, seedReport: null, presence: [], rows: [], summary: null, verdict: null, acc, harnessError: null };
  const sut = await openSut(opts.gut);
  try {
    const anchorDay = opts.anchorDay ?? new Date().toISOString().slice(0, 10);
    log(`seeding ${world.ledger.person_events.length} person events, ${world.ledger.meetings.length} meetings`);
    result.seedReport = await seed(sut, world.ledger, anchorDay);
    result.presence = await presence(sut, world.ledger, result.seedReport);
    const failed = result.presence.filter(p => !p.ok);
    if (failed.length) {
      const msg = `presence assertions failed: ${failed.map(f => `${f.name} expected ${f.expected} got ${f.actual}`).join('; ')}${result.seedReport.write_errors.length ? `; first write error: ${result.seedReport.write_errors[0]}` : ''}`;
      acc.error('presence', 'harness', msg);
      result.harnessError = msg;
      return result;
    }
    const c: Ctx = { sut, gold, acc, rows: result.rows, negative: world.negative, lastSeenErrors: [], pagedate: [] };
    log(`probing ${world.probes.length} ledger probes`);
    for (const p of world.probes) await runProbe(c, p);
    await runtimeProbes(c, world.ledger, result.seedReport);
    result.summary = summarize(result.rows, { lastSeenErrors: c.lastSeenErrors, pagedate: c.pagedate });
    result.verdict = n3Verdict(result.summary);
    return result;
  } catch (e) {
    const msg = `harness: ${errMsg(e)}`;
    acc.error('run', 'harness', msg);
    result.harnessError = msg;
    return result;
  } finally {
    await sut.engine.disconnect().catch(() => {});
  }
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at >= 0) return argv[at + 1];
  return argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const log = json ? () => {} : (s: string) => console.log(s);
  const seedArg = argValue(argv, '--seed');
  const seedValue = seedArg === undefined ? N3_DEFAULT_SEED : Number(seedArg);
  if (!Number.isInteger(seedValue)) throw new Error('--seed needs an integer');
  const output = argValue(argv, '--output');
  const outPath = output ? join(output, 'receipt.json') : receiptPath(CATEGORY);
  const startedAt = new Date().toISOString();
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  log(`# BrainBench N3: temporal and as-of (gbrain ${gut.version}${gut.overlay ? `, overlay ${gut.overlay.build.commit.slice(0, 7)}` : ', pinned'})`);

  const r = await runN3({ gut, seed: seedValue, log });
  const a = r.acc.summary();
  const { ledger } = r.world;
  const featureCounts: Record<string, number> = {};
  for (const p of r.world.probes) featureCounts[p.feature] = (featureCounts[p.feature] ?? 0) + 1;
  const receipt: Receipt = {
    ...noModelSpend('hermetic: provider keys stripped, keyword search only, scripted chronicle judge; no model and no paid request'),
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CATEGORY,
    run_status: r.harnessError || a.run_invalid ? 'error' : 'completed',
    ...(r.harnessError || a.run_invalid ? {} : { verdict: r.verdict ?? 'fail' }),
    n_total: a.n_total,
    n_scored: a.n_scored,
    completion_rate: a.completion_rate,
    errors: a.errors,
    publishable: a.publishable && !r.harnessError,
    gbrain_version: gut.version,
    gbrain_pin: gbrainPin(),
    execution: { source_tree: sourceTreeIdentity(), product: productIdentityFor(gut) },
    resolved_config: {
      engine: 'pglite-in-memory',
      caller: 'operation handlers with OperationContext { remote: false, sourceId: default }',
      search_path: 'query operation, expand=false, autocut=false, adaptive_return=false, limit=100; no embedding gateway (keyword only); search.mcp_keyword_only=true',
      brain_timezone: ledger.brain_timezone,
      chronicle_tz: ledger.chronicle_tz,
      seed: seedValue,
      generator_version: N3_GENERATOR_VERSION,
      ledger_sha256: r.world.fingerprint,
      clock_relative_anchor: r.seedReport?.relative_anchor ?? null,
      oracle: {
        asof: 'ForwardJobState over the person\'s events in valid-time order (eval/generators/job-state.ts)',
        recorded_asof: 'the same machine over events recorded on or before the query date',
        sets: 'set arithmetic over the ledger\'s timeline rows, notes, trajectory points',
        effective_date: 'independent implementation of the documented precedence chain (src/core/effective-date.ts header)',
        time_zone: 'independent US Eastern DST rule (second Sunday of March to first Sunday of November, 02:00 local)',
        clock_relative: 'pages dated anchor minus N days; windows at least two days from every page',
      },
      gbrain_overlay: overlaySummary(gut),
      targets: 'every metric exact: as-of accuracies 1, range set-F1 1, last-seen MAE 0 days and exact rate 1, every feature pass rate 1',
    },
    hashes: { ledger_sha256: r.world.fingerprint, gold_fingerprint: r.goldFingerprint },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: {
      summary: r.summary,
      ledger_counts: {
        people: ledger.people.length, person_events: ledger.person_events.length,
        late_recorded_events: ledger.person_events.filter(e => e.late).length,
        meetings: ledger.meetings.length, chronicle_events: ledger.meetings.reduce((n, m) => n + m.events.length, 0),
        precedence_pages: ledger.precedence_pages.length, tz_pages: ledger.tz_pages.length, undated_pages: ledger.undated_pages.length,
        trajectory_points: ledger.trajectories.reduce((n, t) => n + t.points.length, 0),
      },
      probes_by_feature: featureCounts,
      ledger_negative_controls: r.world.negative.size,
      presence: r.presence,
      seed_report: r.seedReport ? { writes: r.seedReport.writes, write_errors: r.seedReport.write_errors, chronicle_extract: r.seedReport.chronicle_extract } : null,
      unsupported: UNSUPPORTED,
      failures: r.rows.filter(x => !x.pass).map(x => ({ probe_id: x.probe_id, feature: x.feature, gold: x.gold, predicted: x.predicted, detail: x.detail })),
      rows: r.rows,
      harness_error: r.harnessError,
    },
  };
  writeReceipt(outPath, receipt);

  if (r.summary) {
    const s = r.summary;
    log(`\n| feature | passed |\n|---|---|`);
    for (const [f, v] of Object.entries(s.feature_pass_rates)) log(`| ${f} | ${v.passed}/${v.total} |`);
    log(`\nas-of accuracy (ontology_get): ${(s.asof_accuracy * 100).toFixed(1)}%  timeline: ${(s.asof_timeline_accuracy * 100).toFixed(1)}%`);
    log(`range set-F1: ${s.range_set_f1.toFixed(3)} over ${s.range_probes} range probes`);
    log(`last-seen MAE: ${s.last_seen_mae_days === null ? 'n/a' : s.last_seen_mae_days.toFixed(2)} days (n=${s.last_seen_mae_n}), exact ${(s.last_seen_exact_rate * 100).toFixed(1)}%`);
    log(`negative controls: ${(s.negative_control_pass_rate * 100).toFixed(1)}% of ${s.negative_controls}`);
    log(`page-date as-of: matches recorded-time gold ${s.pagedate_asof.vs_recorded_time}, valid-time gold ${s.pagedate_asof.vs_valid_time}`);
    log(`verdict: ${r.verdict}`);
  } else {
    log(`run error: ${r.harnessError}`);
  }
  log(`receipt: ${outPath}`);
  if (json) process.stdout.write(JSON.stringify({ run_status: receipt.run_status, verdict: receipt.verdict, summary: r.summary, errors: a.errors }, null, 2) + '\n');
  process.exit(receipt.run_status === 'error' ? 3 : r.verdict === 'pass' ? 0 : 1);
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(3); });
}

