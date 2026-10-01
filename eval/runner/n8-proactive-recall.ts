/**
 * BrainBench N8: unsolicited recall at final delivery (wave amendment 8).
 *
 * Two worlds, both on in-memory PGLite:
 *
 *   mechanics    eval/generators/n8-proactive-recall-gen.ts: entity pages and
 *                sessions whose user turns never ask the brain for anything.
 *                Each user turn is replayed with its rolling window through
 *                the volunteer_context operation (trusted local with and
 *                without prior_context, remote with prior_context, and a
 *                min_confidence sweep) and, locally only, through
 *                assembleTurnContext, the builder behind the IPC-only
 *                turn_context. Scored on the final delivered pages and bytes.
 *   associative  eval/data/associative-recall-v1: every probe as a one-turn
 *                window through volunteer_context, scored against the frozen
 *                span labels with strict and adjudicated false-alarm rates
 *                (eval/data/n8-proactive-recall/associative-negatives-adjudication-v1.json).
 *                gbrain does not claim general associative recall; this arm
 *                measures that gap and its false alarms, it is never mapped
 *                onto associative QA.
 *
 * Baselines: never-inject, always-inject (three seeded random pages per turn)
 * and turn-text keyword search (the search operation, top three).
 *
 * Report-only: the category stays report-only until associative-recall-v1
 * labels pass independent human review. The receipt verdict is the four
 * delivery contracts frozen in eval/registry.ts (proactive-recall).
 *
 * Hermetic: provider keys stripped, fresh GBRAIN_HOME, System One off (S6
 * recall_needed is not scoreable keyless).
 *
 * Usage: bun eval/runner/n8-proactive-recall.ts [--seed N] [--output <dir>] [--gbrain <checkout>[@ref]] [--json] [--record-bugs]
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OperationContext } from 'gbrain/operations';
import { WAVE_BUG_LEDGER, upsertBug, type BugEntry } from './bug-ledger.ts';
import { gbrainSpecFrom, importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { gbrainPin } from './gbrain-version.ts';
import { DECIDE_OFF, withHermeticEnv } from './hermetic-env.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, noModelSpend, receiptPath, sourceTreeIdentity, writeReceipt, type Receipt } from './receipt.ts';
import {
  NEGATIVE_KINDS, N8_DEFAULT_SEED, N8_GENERATOR_VERSION, TRIGGER_KINDS, generateN8World, windowAt,
  type EntityPage, type GeneratedN8, type TurnGold, type TurnKind,
} from '../generators/n8-proactive-recall-gen.ts';

export const CATEGORY = 'n8-proactive-recall';
export const SWEEP_THRESHOLDS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95] as const;
export const FA_BUDGET = 0.05;
const ADJUDICATION = 'eval/data/n8-proactive-recall/associative-negatives-adjudication-v1.json';

export const ENTRY_POINTS = [
  'operations: volunteer_context (remote false and true), search (baseline), get_page (presence)',
  'src/core/context/turn-context.ts assembleTurnContext (turn mode; the builder behind IPC turn_context)',
  'src/core/import-file.ts importFromContent; engine.softDeletePage',
] as const;

export const UNSUPPORTED: ReadonlyArray<{ feature: string; reason: string }> = [
  { feature: 'turn_context over IPC', reason: 'turn_context is an IPC kind served by a running gbrain serve (gbrain hook user-prompt), not an operation; the runner calls assembleTurnContext in process. No real hook trace is claimed.' },
  { feature: 'System One S6 recall_needed', reason: 'off keyless and not a key default; cited from the SO category, not re-measured.' },
  { feature: 'general associative recall', reason: 'volunteer_context and turn_context resolve entity mentions (alias, title, surname, slug tail); recall of situations that name no entity is not a gbrain capability (capability matrix N8). The associative arm reports it as a gap.' },
  { feature: 'turn_context over several sources', reason: 'assembleTurnContext takes one sourceId, so the associative arm (one source per fixture source) runs through volunteer_context only.' },
  { feature: 'agent use of the injected block', reason: 'no model reads the delivered context in a hermetic run.' },
  { feature: 'hot facts in turn_context', reason: 'the seeded world has no facts rows; the hot-memory section is empty in every turn and its world-only posture is not exercised here.' },
];

// ─── Pure scoring ────────────────────────────────────────────────────────

export interface TurnDelivery { turn: string; delivered: string[]; tokens: number; latency_ms: number; error?: string; private_markers?: string[] }

export interface ModeMetrics {
  trigger_turns: number;
  hits: number;
  recall: number;
  recall_by_kind: Record<string, { n: number; hits: number }>;
  /** Alias and exact-title triggers only (the preregistered headline). */
  recall_alias_title: number;
  negative_turns: number;
  negative_turns_with_false_alarm: number;
  false_alarm_rate: number;
  collision_turns: number;
  collision_false_alarm_rate: number;
  innocuous_and_no_mention_false_alarm_rate: number;
  false_alarm_by_kind: Record<string, { n: number; false_alarms: number }>;
  deliveries: number;
  useful_deliveries: number;
  useful_precision: number | null;
  redundant_deliveries: number;
  redundant_per_session: number;
  private_deliveries: number;
  withdrawn_deliveries: number;
  tokens_per_turn_mean: number;
  tokens_per_turn_p95: number;
  tokens_per_negative_turn_mean: number;
  latency_ms_p50: number;
  latency_ms_p95: number;
  errors: number;
}

function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

export function scoreMode(world: Pick<GeneratedN8, 'ledger' | 'gold'>, deliveries: readonly TurnDelivery[]): ModeMetrics {
  const entity = new Map(world.ledger.entities.map(e => [e.slug, e]));
  const byTurn = new Map(deliveries.map(d => [d.turn, d]));
  const recall_by_kind: ModeMetrics['recall_by_kind'] = {};
  const false_alarm_by_kind: ModeMetrics['false_alarm_by_kind'] = {};
  let trigger = 0, hits = 0, negatives = 0, faTurns = 0, collisions = 0, collisionFa = 0, plainNeg = 0, plainFa = 0;
  let deliveriesN = 0, useful = 0, redundant = 0, priv = 0, withdrawn = 0, errors = 0;
  let atN = 0, atHits = 0;
  const negTokens: number[] = [];
  const sessions = new Set<string>();
  const seenInSession = new Map<string, Set<string>>();
  for (const s of world.ledger.sessions) {
    sessions.add(s.id);
    const seen = new Set<string>();
    seenInSession.set(s.id, seen);
    for (const t of s.turns) {
      if (t.role !== 'user') continue;
      const g = world.gold.get(t.id)!;
      const d = byTurn.get(t.id) ?? { turn: t.id, delivered: [], tokens: 0, latency_ms: 0, error: 'not run' };
      if (d.error) errors++;
      const delivered = [...new Set(d.delivered)];
      const before = new Set(seen);
      let falseAlarm = false;
      for (const slug of delivered) {
        deliveriesN++;
        const e = entity.get(slug);
        if (e?.withdrawn) withdrawn++;
        if (e?.visibility === 'private') priv++;
        if (seen.has(slug)) redundant++;
        else if (g.allowed.includes(slug) && !e?.withdrawn) useful++;
        if (!g.allowed.includes(slug)) falseAlarm = true;
        seen.add(slug);
      }
      if (TRIGGER_KINDS.includes(g.kind)) {
        trigger++;
        const hit = g.target.every(x => delivered.includes(x) || before.has(x));
        if (hit) hits++;
        const k = (recall_by_kind[g.kind] ??= { n: 0, hits: 0 });
        k.n++;
        if (hit) k.hits++;
        if (g.kind === 'trigger_alias' || g.kind === 'trigger_title') { atN++; if (hit) atHits++; }
      }
      if (NEGATIVE_KINDS.includes(g.kind)) {
        negatives++;
        negTokens.push(d.tokens);
        if (falseAlarm) faTurns++;
        const fk = (false_alarm_by_kind[g.kind] ??= { n: 0, false_alarms: 0 });
        fk.n++;
        if (falseAlarm) fk.false_alarms++;
        if (g.kind === 'collision_lower' || g.kind === 'collision_initial') { collisions++; if (falseAlarm) collisionFa++; }
        else { plainNeg++; if (falseAlarm) plainFa++; }
      }
    }
  }
  const tokens = deliveries.map(d => d.tokens);
  const lat = deliveries.map(d => d.latency_ms);
  const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  return {
    trigger_turns: trigger, hits, recall: trigger ? hits / trigger : 0, recall_by_kind, recall_alias_title: atN ? atHits / atN : 0,
    negative_turns: negatives, negative_turns_with_false_alarm: faTurns, false_alarm_rate: negatives ? faTurns / negatives : 0,
    collision_turns: collisions, collision_false_alarm_rate: collisions ? collisionFa / collisions : 0,
    innocuous_and_no_mention_false_alarm_rate: plainNeg ? plainFa / plainNeg : 0,
    false_alarm_by_kind,
    deliveries: deliveriesN, useful_deliveries: useful, useful_precision: deliveriesN ? useful / deliveriesN : null,
    redundant_deliveries: redundant, redundant_per_session: sessions.size ? redundant / sessions.size : 0,
    private_deliveries: priv, withdrawn_deliveries: withdrawn,
    tokens_per_turn_mean: mean(tokens), tokens_per_turn_p95: quantile(tokens, 0.95), tokens_per_negative_turn_mean: mean(negTokens),
    latency_ms_p50: quantile(lat, 0.5), latency_ms_p95: quantile(lat, 0.95), errors,
  };
}

/** The frozen targets (registry exploratory list), as one pass flag for the mutation suite and the report. */
export function n8Targets(m: ModeMetrics): { pass: boolean; failed: string[] } {
  const failed: string[] = [];
  if (!(m.recall_alias_title >= 0.8)) failed.push(`recall_alias_title=${m.recall_alias_title.toFixed(3)}`);
  if (!(m.innocuous_and_no_mention_false_alarm_rate <= FA_BUDGET)) failed.push(`false_alarm_rate=${m.innocuous_and_no_mention_false_alarm_rate.toFixed(3)}`);
  if (m.redundant_deliveries) failed.push(`redundant=${m.redundant_deliveries}`);
  if (m.private_deliveries) failed.push(`private=${m.private_deliveries}`);
  if (m.withdrawn_deliveries) failed.push(`withdrawn=${m.withdrawn_deliveries}`);
  return { pass: failed.length === 0, failed };
}

/** Trapezoid PR-AUC over sweep points (recall, precision), anchored at recall 0. */
export function prAuc(points: ReadonlyArray<{ recall: number; precision: number | null }>): number | null {
  const ps = points.filter(p => p.precision !== null).map(p => ({ r: p.recall, p: p.precision! })).sort((a, b) => a.r - b.r || b.p - a.p);
  if (!ps.length) return null;
  let auc = 0;
  let prev = { r: 0, p: ps[0].p };
  for (const q of ps) { auc += (q.r - prev.r) * (q.p + prev.p) / 2; prev = q; }
  return auc;
}

// ─── Associative arm scoring ─────────────────────────────────────────────

interface AssocProbe { id: string; family_id: string; kind: 'indirect' | 'direct' | 'negative'; text: string; required_span_ids: string[] }
interface AssocSource { family_id: string; source_id: string; slug: string; title: string; text: string; visibility: 'public' | 'private' | 'withdrawn' }
interface AssocSpan { id: string; source_id: string; slug: string }
interface Adjudication { decisions: Array<{ probe_id: string; permissible_pages: Array<{ source_id: string; slug: string }> }> }

export interface AssocDelivery { probe: string; delivered: Array<{ source_id: string; slug: string }>; error?: string }

export function scoreAssociative(probes: readonly AssocProbe[], spans: readonly AssocSpan[], sources: readonly AssocSource[], adjudication: Adjudication, deliveries: readonly AssocDelivery[]): Record<string, unknown> {
  const spanPage = new Map(spans.map(s => [s.id, `${s.source_id}|${s.slug}`]));
  const vis = new Map(sources.map(s => [`${s.source_id}|${s.slug}`, s.visibility]));
  const permissible = new Map(adjudication.decisions.map(d => [d.probe_id, new Set(d.permissible_pages.map(p => `${p.source_id}|${p.slug}`))]));
  const by = new Map(deliveries.map(d => [d.probe, d]));
  const acc = { indirect: { n: 0, any: 0, all: 0 }, direct: { n: 0, any: 0, all: 0 } };
  let neg = 0, strictFa = 0, adjFa = 0, priv = 0, withdrawn = 0, total = 0, fired = 0, errors = 0;
  for (const p of probes) {
    const d = by.get(p.id);
    if (!d || d.error) errors++;
    const got = new Set((d?.delivered ?? []).map(x => `${x.source_id}|${x.slug}`));
    total++;
    if (got.size) fired++;
    for (const k of got) { if (vis.get(k) === 'private') priv++; if (vis.get(k) === 'withdrawn') withdrawn++; }
    if (p.kind === 'negative') {
      neg++;
      if (got.size) strictFa++;
      const ok = permissible.get(p.id) ?? new Set<string>();
      if ([...got].some(k => !ok.has(k))) adjFa++;
      continue;
    }
    const need = [...new Set(p.required_span_ids.map(id => spanPage.get(id)!))];
    const a = acc[p.kind];
    a.n++;
    if (need.some(k => got.has(k))) a.any++;
    if (need.every(k => got.has(k))) a.all++;
  }
  return {
    probes: total, probes_with_any_delivery: fired, errors,
    indirect: { ...acc.indirect, any_hit_recall: acc.indirect.n ? acc.indirect.any / acc.indirect.n : 0, all_hit_recall: acc.indirect.n ? acc.indirect.all / acc.indirect.n : 0 },
    direct: { ...acc.direct, any_hit_recall: acc.direct.n ? acc.direct.any / acc.direct.n : 0, all_hit_recall: acc.direct.n ? acc.direct.all / acc.direct.n : 0 },
    negatives: neg,
    strict_false_alarm_rate: neg ? strictFa / neg : 0,
    adjudicated_false_alarm_rate: neg ? adjFa / neg : 0,
    strict_false_alarms: strictFa, adjudicated_false_alarms: adjFa,
    private_deliveries: priv, withdrawn_deliveries: withdrawn,
  };
}

// ─── gbrain under test ───────────────────────────────────────────────────

interface Engine { connect(o: object): Promise<void>; initSchema(): Promise<void>; disconnect(): Promise<void>; executeRaw<T>(q: string, p?: unknown[]): Promise<T[]>; softDeletePage(slug: string, o: object): Promise<unknown> }
interface Sut {
  engine: Engine;
  op(name: string, params: Record<string, unknown>, ctx: { remote: boolean; sourceId?: string; allowedSources?: string[] }): Promise<unknown>;
  importPage(slug: string, content: string, sourceId: string): Promise<unknown>;
  turnContext(window: Array<{ role: string; text: string }>, prior: string, sessionId: string): Promise<{ text: string }>;
}

async function openSut(gut: GbrainUnderTest): Promise<Sut> {
  const { PGLiteEngine } = await importGbrain<{ PGLiteEngine: new () => Engine }>(gut, 'src/core/pglite-engine.ts');
  const { operations } = await importGbrain<{ operations: Array<{ name: string; handler: (ctx: OperationContext, p: Record<string, unknown>) => Promise<unknown> }> }>(gut, 'src/core/operations.ts');
  const importer = await importGbrain<{ importFromContent: (e: unknown, slug: string, c: string, o: object) => Promise<unknown> }>(gut, 'src/core/import-file.ts');
  const tc = await importGbrain<{ assembleTurnContext: (e: unknown, o: object) => Promise<{ text: string }> }>(gut, 'src/core/context/turn-context.ts');
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const byName = new Map(operations.map(o => [o.name, o]));
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  return {
    engine,
    op: async (name, params, c) => {
      const o = byName.get(name);
      if (!o) throw new HarnessError(`gbrain has no operation ${name}`);
      const ctx = { engine, config: { engine: 'pglite' }, logger, dryRun: false, remote: c.remote, sourceId: c.sourceId ?? 'default', ...(c.allowedSources ? { auth: { allowedSources: c.allowedSources } } : {}) } as unknown as OperationContext;
      return await o.handler(ctx, params);
    },
    importPage: (slug, content, sourceId) => importer.importFromContent(engine, slug, content, { sourceId, noEmbed: true }),
    turnContext: (window, prior, sessionId) => tc.assembleTurnContext(engine, { sourceId: 'default', window, priorContextText: prior || undefined, sessionId }),
  };
}

class HarnessError extends Error {}
const errMsg = (e: unknown) => e instanceof Error ? e.message : String(e);
const approxTokens = (s: string) => Math.ceil(s.length / 4);

function pageContent(e: EntityPage): string {
  return `---\ntype: ${e.type}\ntitle: ${JSON.stringify(e.title)}\nvisibility: ${e.visibility}\naliases: ${JSON.stringify(e.aliases)}\n---\n\n${e.body}\n`;
}

const windowText = (turns: Array<{ role: string; text: string }>) => turns.map(t => `${t.role}: ${t.text}`).join('\n');

type Mode = { name: string; kind: 'volunteer'; remote: boolean; prior: boolean; minConfidence?: number } | { name: string; kind: 'turn_context' } | { name: string; kind: 'search' } | { name: string; kind: 'always'; seed: number } | { name: string; kind: 'never' };

async function runMode(sut: Sut, world: GeneratedN8, mode: Mode, acc: ProbeAccounting | null): Promise<TurnDelivery[]> {
  const out: TurnDelivery[] = [];
  const slugs = world.ledger.entities.map(e => e.slug);
  const live = world.ledger.entities.filter(e => !e.withdrawn && e.visibility === 'world').map(e => e.slug);
  let rnd = mode.kind === 'always' ? mode.seed : 0;
  const nextRnd = () => { rnd = (rnd * 1103515245 + 12345) >>> 0; return rnd / 4294967296; };
  for (const s of world.ledger.sessions) {
    let prior = '';
    for (const [i, t] of s.turns.entries()) {
      if (t.role !== 'user') continue;
      const win = windowAt(s, i, world.ledger.window_turns).map(w => ({ role: w.role, text: w.text }));
      const started = performance.now();
      let delivered: string[] = [];
      let payload = '';
      try {
        if (mode.kind === 'volunteer') {
          const res = await sut.op('volunteer_context', { window: windowText(win), ...(mode.prior && prior ? { prior_context: prior } : {}), ...(mode.minConfidence !== undefined ? { min_confidence: mode.minConfidence } : {}) }, { remote: mode.remote }) as { pages: Array<{ slug: string }> };
          delivered = res.pages.map(p => p.slug);
          payload = res.pages.length ? JSON.stringify(res.pages) : '';
        } else if (mode.kind === 'turn_context') {
          const res = await sut.turnContext(win, prior, s.id);
          payload = res.text;
          delivered = slugs.filter(slug => payload.includes(`\`${slug}\``));
        } else if (mode.kind === 'search') {
          const res = await sut.op('search', { query: t.text, limit: 3 }, { remote: false }) as Array<{ slug: string }> | { results: Array<{ slug: string }> };
          const rows = Array.isArray(res) ? res : res.results ?? [];
          delivered = [...new Set(rows.map(r => r.slug))].filter(x => slugs.includes(x)).slice(0, 3);
          payload = JSON.stringify(rows.slice(0, 3));
        } else if (mode.kind === 'always') {
          const pool = [...live];
          for (let k = 0; k < 3 && pool.length; k++) delivered.push(pool.splice(Math.floor(nextRnd() * pool.length), 1)[0]);
          payload = delivered.join('\n');
        }
        if (mode.kind === 'volunteer' || mode.kind === 'turn_context') prior += payload ? `\n${payload}` : '';
        const privateMarkers = world.ledger.entities.filter(e => e.visibility === 'private' && payload.includes(e.marker)).map(e => e.marker);
        out.push({ turn: t.id, delivered, tokens: approxTokens(payload), latency_ms: performance.now() - started, ...(privateMarkers.length ? { private_markers: privateMarkers } : {}) });
        acc?.score(`${mode.name}:${t.id}`, 1);
      } catch (e) {
        out.push({ turn: t.id, delivered: [], tokens: 0, latency_ms: performance.now() - started, error: errMsg(e) });
        acc?.error(`${mode.name}:${t.id}`, 'sut', errMsg(e));
      }
    }
  }
  return out;
}

function runtimeSourceId(fixtureSourceId: string): string {
  return `n8a-${createHash('sha256').update(fixtureSourceId).digest('hex').slice(0, 24)}`;
}

function loadAssociative(): { probes: AssocProbe[]; spans: AssocSpan[]; sources: AssocSource[]; adjudication: Adjudication; hashes: Record<string, string> } {
  const root = join(import.meta.dir, '../data/associative-recall-v1');
  const read = (f: string) => readFileSync(join(root, f), 'utf8');
  const manifest = JSON.parse(read('manifest.json')) as { hashes: Record<string, string> };
  for (const f of ['sources.json', 'probes.json', 'qrels.json']) {
    const actual = createHash('sha256').update(readFileSync(join(root, f))).digest('hex');
    if (actual !== manifest.hashes[f]) throw new HarnessError(`associative-recall-v1 ${f} hash ${actual} differs from the frozen manifest`);
  }
  const adjudication = JSON.parse(readFileSync(join(import.meta.dir, '../..', ADJUDICATION), 'utf8')) as Adjudication & { corpus_hashes: Record<string, string> };
  for (const [f, h] of Object.entries(adjudication.corpus_hashes)) if (manifest.hashes[f] !== h) throw new HarnessError(`adjudication was made against a different ${f}`);
  return {
    probes: (JSON.parse(read('probes.json')) as { probes: AssocProbe[] }).probes,
    spans: (JSON.parse(read('qrels.json')) as { spans: AssocSpan[] }).spans,
    sources: (JSON.parse(read('sources.json')) as { sources: AssocSource[] }).sources.map(s => ({ ...s, text: s.text.replace(/\r\n?/g, '\n').normalize('NFC') })),
    adjudication,
    hashes: manifest.hashes,
  };
}

// ─── Run ─────────────────────────────────────────────────────────────────

export interface N8RunResult {
  world: GeneratedN8;
  presence: Record<string, unknown> | null;
  modes: Record<string, ModeMetrics>;
  sweep: Array<{ min_confidence: number; recall: number; recall_alias_title: number; false_alarm_rate: number; innocuous_and_no_mention_false_alarm_rate: number; collision_false_alarm_rate: number; useful_precision: number | null; recall_by_kind: ModeMetrics['recall_by_kind'] }>;
  associative: Record<string, unknown> | null;
  contracts: Record<string, number> | null;
  targets: { pass: boolean; failed: string[] } | null;
  verdict: 'pass' | 'fail' | null;
  leak_examples: Array<{ mode: string; turn: string; slug: string; private_body_marker_delivered: boolean }>;
  outputs_sha256: string | null;
  acc: ProbeAccounting;
  harnessError: string | null;
}

export async function runN8(opts: { gut: GbrainUnderTest; seed?: number; log?: (s: string) => void }): Promise<N8RunResult> {
  return withHermeticEnv('n8', () => runN8Hermetic(opts));
}

async function runN8Hermetic(opts: { gut: GbrainUnderTest; seed?: number; log?: (s: string) => void }): Promise<N8RunResult> {
  const log = opts.log ?? (() => {});
  const world = generateN8World({ seed: opts.seed ?? N8_DEFAULT_SEED });
  const assoc = loadAssociative();
  const userTurns = world.gold.size;
  const acc = new ProbeAccounting(userTurns * 4 + assoc.probes.length);
  const result: N8RunResult = { world, presence: null, modes: {}, sweep: [], associative: null, contracts: null, targets: null, verdict: null, leak_examples: [], outputs_sha256: null, acc, harnessError: null };
  const sut = await openSut(opts.gut);
  try {
    for (const e of world.ledger.entities) {
      await sut.importPage(e.slug, pageContent(e), 'default');
      if (e.withdrawn) await sut.engine.softDeletePage(e.slug, { sourceId: 'default' });
    }
    const live = world.ledger.entities.filter(e => !e.withdrawn);
    let readable = 0;
    for (const e of live) { try { if (await sut.op('get_page', { slug: e.slug }, { remote: false })) readable++; } catch { /* counted below */ } }
    const people = world.ledger.entities.filter(e => e.kind === 'person');
    let aliasFired = 0;
    for (const e of people) {
      const r = await sut.op('volunteer_context', { window: `user: ${e.short}` }, { remote: false }) as { pages: Array<{ slug: string }> };
      if (r.pages.some(p => p.slug === e.slug)) aliasFired++;
    }
    result.presence = { live_pages: live.length, readable_pages: readable, direct_alias_controls: people.length, direct_alias_controls_fired: aliasFired };
    if (readable !== live.length) throw new HarnessError(`presence: ${readable} of ${live.length} live pages readable through get_page`);
    if (aliasFired === 0) throw new HarnessError(`presence: none of ${people.length} direct alias mentions fired, so a false-alarm rate of 0 would mean nothing`);

    log(`mechanics: ${world.ledger.sessions.length} sessions, ${userTurns} user turns`);
    const modes: Mode[] = [
      { name: 'volunteer_local_prior', kind: 'volunteer', remote: false, prior: true },
      { name: 'volunteer_local_no_prior', kind: 'volunteer', remote: false, prior: false },
      { name: 'volunteer_remote_prior', kind: 'volunteer', remote: true, prior: true },
      { name: 'turn_context_local', kind: 'turn_context' },
    ];
    const deliveries: Record<string, TurnDelivery[]> = {};
    for (const m of modes) {
      deliveries[m.name] = await runMode(sut, world, m, acc);
      result.modes[m.name] = scoreMode(world, deliveries[m.name]);
    }
    for (const m of [{ name: 'baseline_never', kind: 'never' }, { name: 'baseline_always_3', kind: 'always', seed: world.ledger.seed }, { name: 'baseline_keyword_search_top3', kind: 'search' }] as Mode[]) {
      deliveries[m.name] = await runMode(sut, world, m, null);
      result.modes[m.name] = scoreMode(world, deliveries[m.name]);
    }
    log(`sweep: ${SWEEP_THRESHOLDS.length} thresholds`);
    for (const t of SWEEP_THRESHOLDS) {
      const m = scoreMode(world, await runMode(sut, world, { name: `sweep_${t}`, kind: 'volunteer', remote: false, prior: true, minConfidence: t }, null));
      result.sweep.push({ min_confidence: t, recall: m.recall, recall_alias_title: m.recall_alias_title, false_alarm_rate: m.false_alarm_rate, innocuous_and_no_mention_false_alarm_rate: m.innocuous_and_no_mention_false_alarm_rate, collision_false_alarm_rate: m.collision_false_alarm_rate, useful_precision: m.useful_precision, recall_by_kind: m.recall_by_kind });
    }
    const entity = new Map(world.ledger.entities.map(e => [e.slug, e]));
    for (const name of ['volunteer_remote_prior', 'turn_context_local']) {
      for (const d of deliveries[name]) for (const slug of d.delivered) if (entity.get(slug)?.visibility === 'private' && result.leak_examples.length < 6) result.leak_examples.push({ mode: name, turn: d.turn, slug, private_body_marker_delivered: (d.private_markers ?? []).includes(entity.get(slug)!.marker) });
    }

    log(`associative: ${assoc.sources.length} sources, ${assoc.probes.length} probes`);
    const runtime = new Map<string, string>();
    for (const id of new Set(assoc.sources.map(s => s.source_id))) {
      runtime.set(runtimeSourceId(id), id);
      await sut.engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`, [runtimeSourceId(id)]);
    }
    for (const s of assoc.sources) {
      const rid = runtimeSourceId(s.source_id);
      await sut.importPage(s.slug, `---\ntype: note\ntitle: ${JSON.stringify(s.title)}\nvisibility: ${s.visibility === 'private' ? 'private' : 'world'}\n---\n\n${s.text}\n`, rid);
      if (s.visibility === 'withdrawn') await sut.engine.softDeletePage(s.slug, { sourceId: rid });
    }
    const allowedSources = [...runtime.keys()];
    const assocDeliveries: AssocDelivery[] = [];
    const assocSearch: AssocDelivery[] = [];
    const toFixture = (rows: Array<{ slug: string; source_id: string }>) => rows.map(r => ({ source_id: runtime.get(r.source_id) ?? r.source_id, slug: r.slug }));
    for (const p of assoc.probes) {
      try {
        const r = await sut.op('volunteer_context', { window: `user: ${p.text}` }, { remote: false, allowedSources }) as { pages: Array<{ slug: string; source_id: string }> };
        assocDeliveries.push({ probe: p.id, delivered: toFixture(r.pages) });
        acc.score(`assoc:${p.id}`, 1);
      } catch (e) {
        assocDeliveries.push({ probe: p.id, delivered: [], error: errMsg(e) });
        acc.error(`assoc:${p.id}`, 'sut', errMsg(e));
      }
      try {
        const r = await sut.op('search', { query: p.text, limit: 3 }, { remote: false, allowedSources }) as Array<{ slug: string; source_id: string }> | { results: Array<{ slug: string; source_id: string }> };
        const rows = (Array.isArray(r) ? r : r.results ?? []);
        const seen = new Set<string>();
        const pages = rows.filter(x => { const k = `${x.source_id}|${x.slug}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 3);
        assocSearch.push({ probe: p.id, delivered: toFixture(pages) });
      } catch (e) {
        assocSearch.push({ probe: p.id, delivered: [], error: errMsg(e) });
      }
    }
    result.associative = {
      volunteer_context: scoreAssociative(assoc.probes, assoc.spans, assoc.sources, assoc.adjudication, assocDeliveries),
      baseline_keyword_search_top3: scoreAssociative(assoc.probes, assoc.spans, assoc.sources, assoc.adjudication, assocSearch),
      adjudication: ADJUDICATION,
      corpus_hashes: assoc.hashes,
      label_status: 'pending-independent-relevance-review (corpus manifest); three disputed negatives agent-adjudicated',
    };

    const lp = result.modes.volunteer_local_prior;
    const rp = result.modes.volunteer_remote_prior;
    const tcm = result.modes.turn_context_local;
    result.contracts = {
      private_pages_delivered_remote: rp.private_deliveries,
      private_pages_delivered_turn_context: tcm.private_deliveries,
      withdrawn_pages_delivered: lp.withdrawn_deliveries + rp.withdrawn_deliveries + tcm.withdrawn_deliveries,
      redelivered_with_prior_context: lp.redundant_deliveries + rp.redundant_deliveries,
    };
    result.verdict = Object.values(result.contracts).every(v => v === 0) ? 'pass' : 'fail';
    result.targets = n8Targets({ ...lp, private_deliveries: rp.private_deliveries });
    result.outputs_sha256 = createHash('sha256').update(JSON.stringify({ deliveries: Object.fromEntries(Object.entries(deliveries).map(([k, v]) => [k, v.map(d => [d.turn, d.delivered])])), assocDeliveries })).digest('hex');
    return result;
  } catch (e) {
    const msg = e instanceof HarnessError ? errMsg(e) : `harness: ${errMsg(e)}`;
    acc.error('run', 'harness', msg);
    result.harnessError = msg;
    return result;
  } finally {
    await sut.engine.disconnect().catch(() => {});
  }
}

// ─── Findings → bug ledger ───────────────────────────────────────────────

const REPRO_DIR = 'docs/benchmarks/2026-10-01-n8-proactive-recall/repro';

export function n8Findings(r: N8RunResult, gbrainSha: string): BugEntry[] {
  const out: BugEntry[] = [];
  const c = r.contracts;
  if (c && c.private_pages_delivered_remote > 0) {
    out.push({
      id: 'N8-1', category: 'proactive-recall', classification: 'bug', gbrain_sha: gbrainSha,
      contract: 'src/core/search/private-visibility.ts (#4352): untrusted callers exclude visibility: private pages by default (fail-closed); docs/mcp/DEPLOY.md: "MCP callers also exclude private pages by default".',
      surface: 'volunteer_context op (src/core/ops/insights.ts) -> volunteerContext -> resolveEntitiesToPointers (src/core/context/retrieval-reflex.ts), no excludePrivate',
      repro: `bun ${REPRO_DIR}/n8-1-private-volunteer-remote.ts`,
      expected: 'A remote (MCP) caller whose window mentions a private page by title or alias gets no page for it, as remote search does.',
      actual: `volunteer_context returns the private page with its title and a body synopsis to the remote caller: ${c.private_pages_delivered_remote} private deliveries over the seeded sessions (remote search for the same name returns nothing).`,
      status: 'open',
    });
  }
  if (c && c.private_pages_delivered_turn_context > 0) {
    out.push({
      id: 'N8-2', category: 'proactive-recall', classification: 'bug', gbrain_sha: gbrainSha,
      contract: 'src/core/context/turn-context.ts header: the IPC turn_context path "must never widen what MCP would return"; the injected block goes into a model context window that may be logged or synced (pack mode is world-only by default for that reason).',
      surface: 'assembleTurnContext turn mode (src/core/context/turn-context.ts): reflex pointers and volunteered pages resolve without a visibility filter',
      repro: `bun ${REPRO_DIR}/n8-2-private-turn-context.ts`,
      expected: 'The per-turn block injected by gbrain hook user-prompt carries no visibility: private page; only its hot facts are filtered to world today.',
      actual: `The block lists the private page and its body synopsis under "Brain pages mentioned this turn": ${c.private_pages_delivered_turn_context} private deliveries over the seeded sessions.`,
      status: 'open',
    });
  }
  const lp = r.modes.volunteer_local_prior;
  if (lp && lp.collision_false_alarm_rate > 0) {
    out.push({
      id: 'N8-3', category: 'proactive-recall', classification: 'feature-gap', gbrain_sha: gbrainSha,
      contract: 'src/core/context/volunteer.ts: "Zero-LLM, deterministic, precision-biased: push noise is worse than pull silence."',
      surface: 'src/core/context/entity-salience.ts candidate extraction + alias arm of resolveEntitiesToPointers',
      repro: `bun ${REPRO_DIR}/n8-3-common-word-alias.ts`,
      expected: 'An alias that is an ordinary English word ("Harbor", "Summit") is not volunteered when the turn uses the word in its ordinary sense.',
      actual: `At the default gate ${(lp.collision_false_alarm_rate * 100).toFixed(0)}% of common-word turns (${lp.collision_turns} turns) delivered the company page; matching is lexical and has no sense disambiguation.`,
      status: 'open',
    });
  }
  const assoc = (r.associative?.volunteer_context ?? null) as { indirect?: { any_hit_recall: number; n: number } } | null;
  if (assoc?.indirect) {
    out.push({
      id: 'N8-4', category: 'proactive-recall', classification: 'feature-gap', gbrain_sha: gbrainSha,
      contract: 'Capability matrix N8: volunteer_context and turn_context resolve entity mentions; general associative recall is not implemented.',
      surface: 'volunteer_context op; assembleTurnContext',
      repro: 'bun eval/runner/n8-proactive-recall.ts  (the "associative" line; data.quality.associative in the receipt)',
      expected: 'A later situation that names no entity ("We could squeeze an extra layer of bowls into the community firing") surfaces the earlier note that matters, unasked.',
      actual: `volunteer_context delivered a required page on ${(assoc.indirect.any_hit_recall * 100).toFixed(1)}% of ${assoc.indirect.n} indirect associative-recall-v1 probes.`,
      status: 'open',
    });
  }
  return out;
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at >= 0) return argv[at + 1];
  return argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

const pct = (v: number | null | undefined) => v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(1)}%`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const log = json ? () => {} : (s: string) => console.log(s);
  const seedArg = argValue(argv, '--seed');
  const seed = seedArg === undefined ? N8_DEFAULT_SEED : Number(seedArg);
  if (!Number.isInteger(seed)) throw new Error('--seed needs an integer');
  const output = argValue(argv, '--output');
  const outPath = output ? join(output, 'receipt.json') : receiptPath(CATEGORY);
  const startedAt = new Date().toISOString();
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  const sha = gut.overlay?.build.commit ?? gbrainPin().split('#')[1] ?? 'unknown';
  log(`# BrainBench N8: unsolicited recall at final delivery (gbrain ${gut.version}${gut.overlay ? `, overlay ${gut.overlay.build.commit.slice(0, 7)}` : ', pinned'})`);
  const r = await runN8({ gut, seed, log });
  const a = r.acc.summary();
  const findings = /^[0-9a-f]{40}$/.test(sha) && !r.harnessError ? n8Findings(r, sha) : [];
  const lp = r.modes.volunteer_local_prior;
  const atBudget = (fa: (s: N8RunResult['sweep'][number]) => number) => {
    const ok = r.sweep.filter(s => fa(s) <= FA_BUDGET);
    return ok.length ? Math.max(...ok.map(s => s.recall)) : null;
  };
  const receipt: Receipt = {
    ...noModelSpend('hermetic: provider keys stripped; no model call'),
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
      decide: DECIDE_OFF,
      seed,
      generator_version: N8_GENERATOR_VERSION,
      ledger_sha256: r.world.fingerprint,
      window_turns: r.world.ledger.window_turns,
      caller: 'volunteer_context with OperationContext { remote: false | true, sourceId: default }; assembleTurnContext in process (turn mode, sourceId default, priorContextText = earlier delivered blocks in the session)',
      entry_points: ENTRY_POINTS,
      token_estimate: 'ceil(characters / 4) of the delivered payload (JSON pages for volunteer_context, the rendered block for turn_context)',
      gbrain_overlay: overlaySummary(gut),
      report_only: 'until associative-recall-v1 labels pass independent human review (amendment 8, CEO requirement)',
    },
    hashes: { ledger_sha256: r.world.fingerprint, outputs_sha256: r.outputs_sha256 ?? '' },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: {
      contracts: r.contracts,
      targets: r.targets,
      presence: r.presence,
      quality: {
        mechanics: lp ? { recall_default: lp.recall_alias_title, false_alarm_rate_default: lp.innocuous_and_no_mention_false_alarm_rate, ...lp } : null,
        modes: r.modes,
        sweep: { points: r.sweep, fa_budget: FA_BUDGET, recall_at_fa_budget_all_negatives: atBudget(s => s.false_alarm_rate), recall_at_fa_budget_innocuous_and_no_mention: atBudget(s => s.innocuous_and_no_mention_false_alarm_rate), pr_auc: prAuc(r.sweep.map(s => ({ recall: s.recall, precision: s.useful_precision }))) },
        tokens_per_turn: Object.fromEntries(Object.entries(r.modes).map(([k, m]) => [k, { mean: m.tokens_per_turn_mean, p95: m.tokens_per_turn_p95, negative_turn_mean: m.tokens_per_negative_turn_mean }])),
        latency_ms: Object.fromEntries(Object.entries(r.modes).map(([k, m]) => [k, { p50: m.latency_ms_p50, p95: m.latency_ms_p95 }])),
        session: Object.fromEntries(Object.entries(r.modes).map(([k, m]) => [k, { redundant: m.redundant_deliveries, per_session: m.redundant_per_session }])),
        associative: r.associative,
        baselines: { never: r.modes.baseline_never, always_3: r.modes.baseline_always_3, keyword_search_top3: r.modes.baseline_keyword_search_top3 },
      },
      leak_examples: r.leak_examples,
      unsupported: UNSUPPORTED,
      findings: findings.map(f => ({ id: f.id, classification: f.classification, surface: f.surface, expected: f.expected, actual: f.actual, repro: f.repro })),
      harness_error: r.harnessError,
    },
  };
  writeReceipt(outPath, receipt);

  log(`verdict: ${receipt.run_status === 'completed' ? `${receipt.verdict} (report-only)` : `error (${r.harnessError})`}`);
  if (r.contracts) {
    log('delivery contracts (target 0, report-only):');
    for (const [k, v] of Object.entries(r.contracts)) log(`  ${k}: ${v}`);
  }
  if (lp) {
    log('quality (volunteer_context, trusted local, prior_context passed, default gate):');
    log(`  proactive recall, alias and exact-title triggers: ${pct(lp.recall_alias_title)}; all triggers ${pct(lp.recall)} (${lp.hits} of ${lp.trigger_turns})`);
    for (const [k, v] of Object.entries(lp.recall_by_kind)) log(`    ${k}: ${v.hits} of ${v.n}`);
    log(`  false-alarm rate, innocuous and no-mention turns: ${pct(lp.innocuous_and_no_mention_false_alarm_rate)}; common-word turns ${pct(lp.collision_false_alarm_rate)} (${lp.collision_turns} turns)`);
    log(`  tokens per turn: mean ${lp.tokens_per_turn_mean.toFixed(1)}, p95 ${lp.tokens_per_turn_p95}; turn_context mean ${r.modes.turn_context_local.tokens_per_turn_mean.toFixed(1)}`);
    log(`  redundant deliveries per session without prior_context: ${r.modes.volunteer_local_no_prior.redundant_per_session.toFixed(2)}`);
    log(`  sweep (min_confidence: recall / false-alarm rate on all negative turns): ${r.sweep.map(s => `${s.min_confidence}: ${pct(s.recall)} / ${pct(s.false_alarm_rate)}`).join(', ')}`);
    const av = (r.associative?.volunteer_context ?? {}) as { indirect?: { any_hit_recall: number; n: number }; strict_false_alarm_rate?: number; adjudicated_false_alarm_rate?: number };
    const as = (r.associative?.baseline_keyword_search_top3 ?? {}) as typeof av;
    log(`  associative (report-only gap): volunteer indirect any-hit ${pct(av.indirect?.any_hit_recall)} of ${av.indirect?.n}, negatives strict FA ${pct(av.strict_false_alarm_rate)}, adjudicated ${pct(av.adjudicated_false_alarm_rate)}; keyword search top 3: ${pct(as.indirect?.any_hit_recall)}, strict FA ${pct(as.strict_false_alarm_rate)}, adjudicated ${pct(as.adjudicated_false_alarm_rate)}`);
  }
  log('gbrain findings:');
  for (const f of findings) log(`  ${f.id} [${f.classification}] ${f.surface}: ${f.repro}`);
  if (argv.includes('--record-bugs')) {
    for (const f of findings) upsertBug(f);
    log(`  recorded ${findings.length} findings in ${WAVE_BUG_LEDGER}`);
  }
  log(`receipt: ${outPath}`);
  if (json) process.stdout.write(JSON.stringify({ run_status: receipt.run_status, verdict: receipt.verdict, contracts: r.contracts }, null, 2) + '\n');
  process.exit(receipt.run_status === 'error' ? 3 : r.verdict === 'pass' ? 0 : 1);
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(3); });
}
