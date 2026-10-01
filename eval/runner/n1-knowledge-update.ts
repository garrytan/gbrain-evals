#!/usr/bin/env bun
/**
 * BrainBench N1: knowledge update and supersession, through the lifecycle
 * harness (eval-category wave amendment 5).
 *
 * The seeded ledger (eval/generators/n1-knowledge-update-gen.ts) holds value
 * changes for fictional people and companies: explicit Facts-fence
 * supersession (struck "superseded by #N" rows, reverts to an earlier
 * value), ontology observations with valid-time dates (forward updates,
 * reverts with the same and with distinct provenance, a backdated
 * late-recorded value) and typed metric trajectories (appended months and
 * corrected points). Each cell (engine x transport, lifecycle/slice.ts)
 * writes the ledger in rounds through the transport under test, then:
 *
 *   updated     probes after the four sequential update rounds;
 *   restart     probes after the server (or CLI session) restarts;
 *   reimport    probes after the vault is committed and fully re-synced;
 *   concurrent  probes after one more update round written concurrently
 *               (refused writes are retried, acknowledged ones must stick).
 *
 * Surfaces: recall (active facts, and include_expired for history), search
 * (fence rows in chunks; a struck row is history, an unstruck old value is
 * stale), ontology_get (now and as-of), find_trajectory. Exposure controls
 * follow N6: private values must reach the trusted local caller and never a
 * remote one, and a world twin proves the remote probe could see the surface.
 *
 * A supplementary in-process arm replays the ontology chains on an
 * unmanaged in-memory PGLite engine (the N3 setup), so ontology semantics
 * stay measurable even where the default managed brain refuses the write.
 * It is exploratory and never gates.
 *
 * Hermetic: keys stripped, fresh GBRAIN_HOME per cell, no embedding model;
 * implicit supersession (remember's 0.95 cosine rule) needs an embedding key
 * and is recorded as a gap. Gating metrics (data.metrics) aggregate the
 * PGLite cells; Postgres cells are report-only (data.metrics_postgres).
 *
 * Usage: bun eval/runner/n1-knowledge-update.ts [--seed N] [--output <dir>] [--gbrain <checkout>[@ref]]
 *          [--engines pglite,postgres] [--interfaces cli,mcp-stdio,mcp-http] [--pg-url <url>] [--concurrency N] [--json]
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { OperationContext } from 'gbrain/operations';
import { gbrainSpecFrom, importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { gbrainPin } from './gbrain-version.ts';
import { DECIDE_OFF, withHermeticEnv } from './hermetic-env.ts';
import type { Driver } from './lifecycle/drivers.ts';
import {
  breakdown, n1Metrics, recallTokens, scoreExposure, scoreN1Probe, searchRowTokens,
  type ExposureRow, type N1Answer, type N1Metrics, type N1Row,
} from './lifecycle/n1-score.ts';
import { ENGINES, IFACES, SliceCell, asRows, collectStrings, postgresReachable, runMatrix, type Engine, type Iface } from './lifecycle/slice.ts';
import { registryEntry } from '../registry.ts';
import { evaluatePromotion } from './promotion.ts';
import { budgetOptionsFrom, receiptCost, startPaidRun } from './budget-ledger.ts';
import { PaidArmRefusal, paidRequested, requirePaidArm } from './paid-arm.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, latencySummary, noModelSpend, receiptPath, sourceTreeIdentity, writeReceipt, type Receipt } from './receipt.ts';
import {
  N1_DEFAULT_SEED, N1_GENERATOR_VERSION, ROUNDS, fenceRowsAt, generateN1World, n1ExposureProbes, n1Probes, ontologyObservationsAt, privateTokens, renderEntityPage,
  type ExposureProbe, type GoldState, type N1Ledger, type N1Probe, type N1World, type Round,
} from '../generators/n1-knowledge-update-gen.ts';

export const CATEGORY = 'n1-knowledge-update';
export const CHECKPOINTS = ['updated', 'restart', 'reimport', 'concurrent'] as const;
export type Checkpoint = typeof CHECKPOINTS[number];

export const GAPS: ReadonlyArray<{ capability: string; reason: string }> = [
  { capability: 'implicit supersession (remember)', reason: 'writeSingleFact supersedes only a near-duplicate (cosine >= 0.95, same kind, different text) and skips dedup without an embedding provider (src/core/facts/write-single.ts); a keyless run has none, so this is a gap, not a failure. The preregistered paid arm measures it with a real embedding model.' },
  { capability: 'natural-language change detection', reason: 'no gbrain path detects "moved from Lisbon to Porto" in prose as a supersession beyond the near-duplicate rule (capability matrix, N1).' },
  { capability: 'direct fact supersession op', reason: 'no supersede_fact operation exists (capability matrix P1); explicit supersession is a fence edit through put_page.' },
  { capability: 'think over updated values', reason: 'think synthesis needs a chat model; keyless think returns the gather only.' },
];

// ─── Writes ──────────────────────────────────────────────────────────────

export interface WriteRecord { round: string; target: string; op: string; ok: boolean; attempts: number; first_error?: string; final_error?: string }

/** Chains whose value changes when `entity` is written at `round`. */
function chainsChangedAt(ledger: N1Ledger, entity: string, round: Round): string[] {
  if (round === 0) return [...ledger.fence, ...ledger.trajectory].filter(c => c.entity === entity).map(c => c.id);
  const prev = ROUNDS[ROUNDS.indexOf(round) - 1];
  const before = new Set(fenceRowsAt(ledger, entity, prev).map(r => r.token + r.active));
  return [...new Set(fenceRowsAt(ledger, entity, round).filter(r => !before.has(r.token + r.active)).map(r => r.chain))];
}

export interface WritePlanItem { target: string; op: 'put_page' | 'ontology_propose'; args: Record<string, unknown>; chains: string[] }

export function writePlan(ledger: N1Ledger, round: Round): WritePlanItem[] {
  const items: WritePlanItem[] = [];
  for (const e of ledger.entities) {
    const chains = chainsChangedAt(ledger, e.slug, round);
    if (!chains.length) continue;
    items.push({ target: e.slug, op: 'put_page', args: { slug: e.slug, content: renderEntityPage(ledger, e, round) }, chains });
  }
  for (const c of ledger.ontology) {
    const now = ontologyObservationsAt(c, round);
    const before = round === 0 ? [] : ontologyObservationsAt(c, ROUNDS[ROUNDS.indexOf(round) - 1]);
    if (now.length === before.length) continue;
    const o = now[now.length - 1];
    items.push({ target: `${c.entity}#${c.dimension}`, op: 'ontology_propose', args: { entity: c.entity, dimension: c.dimension, value: o.value, valid_from: o.valid_from, source: o.source, visibility: c.visibility, confidence: 0.9 }, chains: [c.id] });
  }
  return items;
}

/**
 * One write as a documented client makes it: put_page on an existing page
 * reads get_page (include_content) first and passes its revision as
 * expected_revision; a new page is created without one.
 */
async function writeOnce(d: Driver, it: WritePlanItem) {
  if (it.op !== 'put_page') return d.call(it.op, it.args);
  const current = await d.call('get_page', { slug: it.args.slug, include_content: true });
  const revision = current.ok && current.data && typeof current.data === 'object' ? (current.data as Record<string, unknown>).revision : undefined;
  return d.call('put_page', typeof revision === 'string' ? { ...it.args, expected_revision: revision } : it.args);
}

async function applyPlan(d: Driver, plan: WritePlanItem[], round: string, concurrent: boolean, acks: Map<string, boolean>): Promise<WriteRecord[]> {
  const records: WriteRecord[] = [];
  const once = (it: WritePlanItem) => writeOnce(d, it);
  const first = concurrent ? await Promise.all(plan.map(once)) : [];
  for (const [k, it] of plan.entries()) {
    let r = concurrent ? first[k] : await once(it);
    const rec: WriteRecord = { round, target: it.target, op: it.op, ok: r.ok, attempts: 1, ...(r.ok ? {} : { first_error: r.error?.slice(0, 300) }) };
    // A client retries a refused write; only an acknowledged write is owed durability.
    while (!r.ok && concurrent && rec.attempts < 4) {
      await new Promise(res => setTimeout(res, 1000));
      r = await once(it);
      rec.attempts++;
    }
    rec.ok = r.ok;
    if (!r.ok) rec.final_error = r.error?.slice(0, 300);
    for (const c of it.chains) acks.set(c, r.ok);
    records.push(rec);
  }
  return records;
}

// ─── Observation ─────────────────────────────────────────────────────────

export interface Observation { answers: Map<string, N1Answer>; raws: Map<string, string | null>; struckInSearch: number }

const errAnswer = (e: string | undefined): N1Answer => ({ error: e ?? 'no data' });

/** Ask the probes' questions through `d`, one call per distinct question. */
export async function observeN1(d: Driver, ledger: N1Ledger, probes: readonly N1Probe[], scope: 'all' | 'current' = 'all'): Promise<Observation> {
  const answers = new Map<string, N1Answer>();
  const raws = new Map<string, string | null>();
  let struckInSearch = 0;
  const memo = new Map<string, Promise<{ ok: boolean; data: unknown; error?: string; raw: string }>>();
  const ask = (op: string, args: Record<string, unknown>) => {
    const k = `${op}:${JSON.stringify(args)}`;
    if (!memo.has(k)) memo.set(k, d.call(op, args));
    return memo.get(k)!;
  };
  for (const p of probes) {
    if (scope === 'current' && !['fence_current', 'ontology_current', 'trajectory_current'].includes(p.type)) continue;
    if (scope === 'current' && p.type === 'fence_current' && p.surface === 'search') continue;
    switch (p.type) {
      case 'fence_current': {
        if (p.surface === 'recall') {
          const r = await ask('recall', { entity: p.entity, limit: 100 });
          raws.set(`recall:${p.entity}`, r.ok ? r.raw : null);
          answers.set(p.id, r.ok ? { tokens: recallTokens(asRows(r.data, ['facts']), p.key, 'active') } : errAnswer(r.error));
        } else {
          const r = await ask('search', { query: p.key, limit: 20 });
          if (!r.ok) { answers.set(p.id, errAnswer(r.error)); break; }
          const rows = searchRowTokens(collectStrings(r.data, 'chunk_text'), p.key);
          struckInSearch += rows.struck.length;
          answers.set(p.id, rows);
        }
        break;
      }
      case 'fence_history': {
        const r = await ask('recall', { entity: p.entity, include_expired: true, limit: 100 });
        answers.set(p.id, r.ok ? { expired: recallTokens(asRows(r.data, ['facts']), p.key, 'expired') } : errAnswer(r.error));
        break;
      }
      case 'ontology_current':
      case 'ontology_asof': {
        const args = p.type === 'ontology_asof' ? { entity: p.entity, asof: p.asof } : { entity: p.entity };
        const r = await ask('ontology_get', args);
        if (p.type === 'ontology_current') raws.set(`ontology_get:${p.entity}`, r.ok ? r.raw : null);
        const row = asRows(r.data, ['values', 'ontology', 'rows']).find(x => x.dimension === p.dimension);
        answers.set(p.id, r.ok ? { value: row ? String(row.value) : null } : errAnswer(r.error));
        break;
      }
      case 'trajectory_current':
      case 'trajectory_history': {
        const r = await ask('find_trajectory', { entity_slug: p.entity, metric: p.metric });
        raws.set(`find_trajectory:${p.entity}:${p.metric}`, r.ok ? r.raw : null);
        if (!r.ok) { answers.set(p.id, errAnswer(r.error)); break; }
        const pts = asRows(r.data, ['points']).map(x => [String(x.valid_from).slice(0, 7), Number(x.value)] as [string, number]);
        answers.set(p.id, p.type === 'trajectory_current' ? { latest: pts.length ? pts[pts.length - 1][1] : null } : { points: pts });
        break;
      }
    }
  }
  return { answers, raws, struckInSearch };
}

export function exposureRaw(obs: Observation, p: ExposureProbe, twin = false): string | null {
  const metric = twin && p.twin_metric ? p.twin_metric : p.metric;
  const key = p.surface === 'find_trajectory' ? `find_trajectory:${p.entity}:${metric}` : `${p.surface}:${p.entity}`;
  return obs.raws.get(key) ?? null;
}

/** Score one checkpoint: rows for every probe the observer may see, plus exposure rows. */
export function scoreCheckpoint(probes: readonly N1Probe[], exposure: readonly ExposureProbe[], obs: Observation, trusted: Observation | null, remote: boolean): { rows: N1Row[]; exposure: ExposureRow[] } {
  const rows = probes.filter(p => !(remote && p.private)).map(p => scoreN1Probe(p, obs.answers.get(p.id) ?? { error: 'not asked' }));
  const ex = remote ? exposure.map(p => scoreExposure(p, exposureRaw(obs, p), trusted ? exposureRaw(trusted, p) : null, exposureRaw(obs, p, true))) : [];
  return { rows, exposure: ex };
}

/** Chains whose last write was acknowledged but whose current value the trusted caller does not see. */
export function lostWrites(probes: readonly N1Probe[], trusted: Observation, acks: ReadonlyMap<string, boolean>): string[] {
  const lost = new Set<string>();
  for (const p of probes) {
    if (!['fence_current', 'ontology_current', 'trajectory_current'].includes(p.type)) continue;
    if (p.type === 'fence_current' && (p.surface !== 'recall' || p.gold === null)) continue;
    if (!acks.get(p.chain)) continue;
    const a = trusted.answers.get(p.id);
    if (a && !scoreN1Probe(p, a).pass) lost.add(p.chain);
  }
  return [...lost].sort();
}

// ─── One cell ────────────────────────────────────────────────────────────

export interface CellOutcome {
  id: string;
  engine: Engine;
  interface: Iface;
  started_at: string;
  duration_ms: number;
  fatal?: string;
  void_reason?: string;
  server_version: string;
  decide: SliceCell['decideOff'];
  presence: Array<{ name: string; ok: boolean; detail: string }>;
  writes: WriteRecord[];
  checkpoints: Partial<Record<Checkpoint, { rows: N1Row[]; exposure: ExposureRow[]; acked_lost: string[]; struck_in_search: number }>>;
  private_value_leaks: number;
  leak_evidence: Array<{ op: string; caller: string; token: string; excerpt: string }>;
  calls: { primary: number; trusted: number; primary_ms: number[] };
  operator: SliceCell['operatorLog'];
}

async function runCell(world: N1World, gut: GbrainUnderTest, engine: Engine, iface: Iface, opts: { work: string; pgAdminUrl: string; port: number; log: (s: string) => void }): Promise<CellOutcome> {
  const t0 = Date.now();
  const cell = new SliceCell({ buildDir: gut.root, engine, iface, work: opts.work, label: 'n1', pgAdminUrl: opts.pgAdminUrl, port: opts.port });
  const { ledger } = world;
  const out: CellOutcome = {
    id: cell.id, engine, interface: iface, started_at: new Date().toISOString(), duration_ms: 0, server_version: '', decide: cell.decideOff,
    presence: [], writes: [], checkpoints: {}, private_value_leaks: 0, leak_evidence: [], calls: { primary: 0, trusted: 0, primary_ms: [] }, operator: cell.operatorLog,
  };
  const acks = new Map<string, boolean>();
  const secret = privateTokens(ledger);
  try {
    await cell.setup();
    out.server_version = cell.serverVersion;
    if (!cell.decideOff.ok) { out.void_reason = `System One is not provably off in this cell: ${cell.decideOff.error ?? JSON.stringify(cell.decideOff.slots.filter(s => s.effective !== 'off'))}`; return out; }

    out.writes.push(...await applyPlan(cell.primary, writePlan(ledger, 0), '0', false, acks));
    // Presence: the trusted caller reads every world fence and trajectory value written in round 0.
    const round0 = n1Probes(ledger, 'sequential').filter(p => !p.private && (p.type === 'fence_current' || p.type === 'trajectory_current'));
    const presence = await cell.trusted(d => observeN1(d, ledger, round0, 'current'));
    for (const c of ledger.fence.filter(x => x.visibility === 'world')) {
      const p = round0.find(x => x.type === 'fence_current' && x.surface === 'recall' && x.chain === c.id)!;
      const a = presence.answers.get(p.id);
      const ok = !!a && 'tokens' in a && a.tokens.includes(c.values[0].token);
      out.presence.push({ name: `fence round-0 value readable: ${c.id}`, ok, detail: JSON.stringify(a) });
    }
    for (const c of ledger.trajectory.filter(x => x.visibility === 'world')) {
      const p = round0.find(x => x.type === 'trajectory_current' && x.chain === c.id)!;
      const a = presence.answers.get(p.id);
      const ok = !!a && 'latest' in a && a.latest === c.initial.at(-1)!.value;
      out.presence.push({ name: `trajectory round-0 points readable: ${c.id}`, ok, detail: JSON.stringify(a) });
    }
    const missing = out.presence.filter(p => !p.ok);
    if (missing.length) { out.void_reason = `Presence check failed: the trusted caller could not read ${missing.length} of ${out.presence.length} round-0 values, so a stale-served count of 0 would mean nothing. First: ${missing[0].name} -> ${missing[0].detail}`; return out; }

    for (const r of [1, 2, 3, 4] as const) out.writes.push(...await applyPlan(cell.primary, writePlan(ledger, r), String(r), false, acks));

    const checkpoint = async (cp: Checkpoint, state: GoldState, withTrusted: boolean) => {
      const probes = n1Probes(ledger, state);
      const exposure = n1ExposureProbes(ledger, state);
      const obs = await observeN1(cell.primary, ledger, probes);
      const trusted = !cell.remote ? obs : withTrusted || exposure.length ? await cell.trusted(d => observeN1(d, ledger, probes, 'current')) : null;
      const scored = scoreCheckpoint(probes, exposure, obs, trusted, cell.remote);
      out.checkpoints[cp] = { ...scored, acked_lost: withTrusted && trusted ? lostWrites(probes, trusted, acks) : [], struck_in_search: obs.struckInSearch };
      opts.log(`[n1] ${cell.id} ${cp}: ${scored.rows.filter(r => r.pass).length}/${scored.rows.length} probes pass, ${scored.rows.filter(r => r.stale).length} stale`);
    };

    await checkpoint('updated', 'sequential', true);
    await cell.restart();
    await checkpoint('restart', 'sequential', false);
    cell.commitVaults('n1 sequential rounds');
    await cell.maintenance('reimport-sync', ['sync', '--source', 'vault', '--full', '--no-pull']);
    await checkpoint('reimport', 'sequential', false);
    out.writes.push(...await applyPlan(cell.primary, writePlan(ledger, 'C'), 'C', true, acks));
    await checkpoint('concurrent', 'concurrent', true);
  } catch (e) {
    out.fatal = `${(e as Error).stack ?? String(e)}${cell.remote ? `\n[server stderr tail]\n${cell.stderrTail().join('\n')}` : ''}`;
  } finally {
    await cell.close();
    const remoteCalls = cell.remote ? cell.calls.filter(c => c.caller !== 'trusted') : [];
    for (const c of remoteCalls) {
      const text = c.raw + (c.meta ?? '');
      const tok = secret.find(t => text.includes(t));
      if (!tok) continue;
      out.private_value_leaks++;
      if (out.leak_evidence.length < 10) { const i = text.indexOf(tok); out.leak_evidence.push({ op: c.op, caller: c.caller, token: tok, excerpt: text.slice(Math.max(0, i - 160), i + 60) }); }
    }
    const primary = cell.calls.filter(c => c.caller === 'primary');
    out.calls = { primary: primary.length, trusted: cell.calls.filter(c => c.caller === 'trusted').length, primary_ms: primary.map(c => c.ms) };
    out.duration_ms = Date.now() - t0;
  }
  return out;
}

// ─── In-process ontology arm (unmanaged engine, exploratory) ──────────────

export interface OntologyArm { rows: N1Row[]; exposure: ExposureRow[]; writes: Array<{ chain: string; action: string; ok: boolean; error?: string }>; error?: string }

async function ontologyUnmanagedArm(gut: GbrainUnderTest, ledger: N1Ledger): Promise<OntologyArm> {
  const out: OntologyArm = { rows: [], exposure: [], writes: [] };
  type EngineModule = { PGLiteEngine: new () => { connect(c: object): Promise<void>; initSchema(): Promise<void>; disconnect(): Promise<void> } };
  type Op = { name: string; handler: (ctx: OperationContext, p: Record<string, unknown>) => Promise<unknown> };
  const { PGLiteEngine } = await importGbrain<EngineModule>(gut, 'src/core/pglite-engine.ts');
  const { operations } = await importGbrain<{ operations: Op[] }>(gut, 'src/core/operations.ts');
  const engine = new PGLiteEngine();
  try {
    await engine.connect({});
    await engine.initSchema();
    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const ctx = (remote: boolean) => ({ engine, config: { engine: 'pglite', database_path: ':memory:' }, logger, dryRun: false, remote, sourceId: 'default' }) as unknown as OperationContext;
    const op = (name: string, remote: boolean, p: Record<string, unknown>) => operations.find(o => o.name === name)!.handler(ctx(remote), p);
    const write = async (round: Round) => {
      for (const it of writePlan(ledger, round).filter(x => x.op === 'ontology_propose')) {
        try {
          const r = await op('ontology_propose', false, it.args) as { action?: string };
          out.writes.push({ chain: it.chains[0], action: `${String(round)}:${String(r?.action ?? 'unknown')}`, ok: true });
        } catch (e) { out.writes.push({ chain: it.chains[0], action: `${String(round)}:error`, ok: false, error: (e as Error).message.slice(0, 200) }); }
      }
    };
    const asDriver = (remote: boolean): Driver => ({
      kind: remote ? 'mcp-stdio' : 'cli', remote, start: async () => {}, restart: async () => {}, close: async () => {}, sessions: () => 0,
      call: async (name, args) => {
        try { const data = await op(name, remote, args); return { ok: true, data, raw: JSON.stringify(data), ms: 0 }; }
        catch (e) { return { ok: false, data: null, error: (e as Error).message, raw: '', ms: 0 }; }
      },
    });
    const probe = async (state: GoldState) => {
      const probes = n1Probes(ledger, state).filter(p => p.type === 'ontology_current' || p.type === 'ontology_asof');
      const local = await observeN1(asDriver(false), ledger, probes);
      const remote = await observeN1(asDriver(true), ledger, probes);
      out.rows.push(...scoreCheckpoint(probes, [], local, null, false).rows);
      out.exposure.push(...scoreCheckpoint([], n1ExposureProbes(ledger, state).filter(p => p.surface === 'ontology_get'), remote, local, true).exposure);
    };
    for (const round of [0, 1, 2, 3, 4] as const) await write(round);
    await probe('sequential');
    await write('C');
    await probe('concurrent');
  } catch (e) {
    out.error = (e as Error).stack ?? String(e);
  } finally {
    await engine.disconnect().catch(() => {});
  }
  return out;
}

// ─── Paid arm: implicit supersession with a real embedding model ───────────

export const PAID_ESTIMATE_USD = 0.05;
const PAID_EMBEDDING_MODEL = 'openai:text-embedding-3-small';

export interface PaidPair { chain: string; kind: 'value-change' | 'unrelated-control' | 'near-duplicate-control'; first: string; second: string; status: string; degraded_dedup: boolean | null; error?: string }

/**
 * The preregistered paid arm (docs/benchmarks/2026-10-01-n1-n5-preregistration.md):
 * remember each world fence chain's first two values in order, with real
 * embeddings, and record whether the second supersedes the first. Controls:
 * an unrelated claim on the same entity (must not supersede) and a
 * punctuation-only near duplicate (shows the dedup path is live). In
 * process on an unmanaged in-memory PGLite engine; every provider request
 * goes through the budget ledger's fetch guard.
 */
async function runPaidArm(gut: GbrainUnderTest, ledger: N1Ledger, argv: readonly string[], log: (s: string) => void): Promise<{ pairs: PaidPair[]; cost: ReturnType<typeof receiptCost>; run_id: string }> {
  const { budgetRunId } = requirePaidArm(argv, { arm: 'N1 implicit-supersession paid arm', estimateUsd: PAID_ESTIMATE_USD });
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('The N1 paid arm needs OPENAI_API_KEY for text-embedding-3-small. Export it, then rerun with --paid --budget-run-id <id>.');
  const { run, guard } = startPaidRun('n1-knowledge-update-paid', { ...budgetOptionsFrom(argv), runId: budgetRunId, estimateUsd: PAID_ESTIMATE_USD, log });
  type EngineModule = { PGLiteEngine: new () => { connect(c: object): Promise<void>; initSchema(): Promise<void>; disconnect(): Promise<void> } };
  type Op = { name: string; handler: (ctx: OperationContext, p: Record<string, unknown>) => Promise<unknown> };
  const { configureGateway } = await importGbrain<{ configureGateway: (c: Record<string, unknown>) => void }>(gut, 'src/core/ai/gateway.ts');
  configureGateway({ embedding_model: PAID_EMBEDDING_MODEL, embedding_dimensions: 1536, env: { OPENAI_API_KEY: key } });
  const { PGLiteEngine } = await importGbrain<EngineModule>(gut, 'src/core/pglite-engine.ts');
  const { operations } = await importGbrain<{ operations: Op[] }>(gut, 'src/core/operations.ts');
  const engine = new PGLiteEngine();
  const pairs: PaidPair[] = [];
  try {
    await engine.connect({});
    await engine.initSchema();
    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const ctx = { engine, config: { engine: 'pglite', database_path: ':memory:' }, logger, dryRun: false, remote: false, sourceId: 'default' } as unknown as OperationContext;
    const op = (name: string, p: Record<string, unknown>) => operations.find(o => o.name === name)!.handler(ctx, p);
    const phrase = (attr: string, label: string) => `${attr === 'city' ? 'Home city is' : 'Works at'} ${label}`;
    for (const c of ledger.fence.filter(x => x.visibility === 'world')) {
      const entity = c.entity.replace('-example', `-${c.attr}-example`);
      const plan: Array<[PaidPair['kind'], string, string]> = [
        ['value-change', phrase(c.attr, c.values[0].label), phrase(c.attr, c.values[1].label)],
        ['unrelated-control', phrase(c.attr, c.values[0].label), `Enjoys long walks near ${c.values[1].label}`],
        ['near-duplicate-control', phrase(c.attr, c.values[0].label), `${phrase(c.attr, c.values[0].label)}.`],
      ];
      for (const [k, [kind, first, second]] of plan.entries()) {
        const slug = `${entity}-${k}`;
        try {
          await op('remember', { fact: first, entity: slug, provenance: 'n1-paid', visibility: 'world' });
          const r = await op('remember', { fact: second, entity: slug, provenance: 'n1-paid', visibility: 'world' }) as Record<string, unknown>;
          pairs.push({ chain: c.id, kind, first, second, status: String(r.status ?? 'unknown'), degraded_dedup: typeof r.degraded_dedup === 'boolean' ? r.degraded_dedup : null });
        } catch (e) { pairs.push({ chain: c.id, kind, first, second, status: 'error', degraded_dedup: null, error: (e as Error).message.slice(0, 200) }); }
      }
    }
  } finally {
    await engine.disconnect().catch(() => {});
    guard.uninstall();
  }
  const summary = run.close();
  return { pairs, cost: receiptCost(summary), run_id: budgetRunId };
}

// ─── Aggregation and receipt ─────────────────────────────────────────────

export function aggregate(cells: readonly CellOutcome[]): N1Metrics & { cells: number; void_cells: number } {
  const rows = cells.flatMap(c => Object.values(c.checkpoints).flatMap(cp => cp!.rows));
  const exposure = cells.flatMap(c => Object.values(c.checkpoints).flatMap(cp => cp!.exposure));
  const lost = cells.reduce((n, c) => n + Object.values(c.checkpoints).reduce((m, cp) => m + cp!.acked_lost.length, 0), 0);
  const leaks = cells.reduce((n, c) => n + c.private_value_leaks, 0);
  return { ...n1Metrics(rows, { private_value_leaks: leaks, exposure, acknowledged_writes_lost: lost }), cells: cells.length, void_cells: cells.filter(c => c.void_reason || c.fatal).length };
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at >= 0) return argv[at + 1];
  return argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const log = json ? () => {} : (s: string) => console.log(s);
  const seed = Number(argValue(argv, '--seed') ?? N1_DEFAULT_SEED);
  if (!Number.isInteger(seed)) throw new Error('--seed needs an integer');
  const engines = (argValue(argv, '--engines') ?? 'pglite,postgres').split(',') as Engine[];
  const ifaces = (argValue(argv, '--interfaces') ?? IFACES.join(',')).split(',') as Iface[];
  for (const e of engines) if (!ENGINES.includes(e)) throw new Error(`--engines takes ${ENGINES.join(',')}, not ${e}`);
  for (const i of ifaces) if (!IFACES.includes(i)) throw new Error(`--interfaces takes ${IFACES.join(',')}, not ${i}`);
  const pgAdminUrl = argValue(argv, '--pg-url') ?? process.env.LIFECYCLE_PG_URL ?? 'postgres://postgres@127.0.0.1:55432/postgres';
  const concurrency = Number(argValue(argv, '--concurrency') ?? '3');
  const output = argValue(argv, '--output');
  const outPath = output ? join(output, 'receipt.json') : receiptPath(CATEGORY);
  const work = resolve(argValue(argv, '--work') ?? join('eval/reports', CATEGORY, 'cells'));
  mkdirSync(work, { recursive: true });
  const startedAt = new Date().toISOString();
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  log(`# BrainBench N1: knowledge update and supersession (gbrain ${gut.version}${gut.overlay ? `, overlay ${gut.overlay.build.commit.slice(0, 7)}` : ', pinned'})`);

  const world = generateN1World({ seed });
  if (paidRequested(argv)) {
    const paid = await runPaidArm(gut, world.ledger, argv, log);
    const count = (kind: PaidPair['kind'], status: string) => paid.pairs.filter(p => p.kind === kind && p.status === status).length;
    const of = (kind: PaidPair['kind']) => paid.pairs.filter(p => p.kind === kind).length;
    const summary = {
      implicit_supersession_rate: of('value-change') ? count('value-change', 'superseded') / of('value-change') : null,
      value_change_pairs: of('value-change'),
      value_change_superseded: count('value-change', 'superseded'),
      unrelated_controls_superseded: count('unrelated-control', 'superseded'),
      unrelated_controls: of('unrelated-control'),
      near_duplicate_controls_deduped: paid.pairs.filter(p => p.kind === 'near-duplicate-control' && (p.status === 'superseded' || p.status === 'duplicate')).length,
      near_duplicate_controls: of('near-duplicate-control'),
      degraded_dedup: paid.pairs.filter(p => p.degraded_dedup).length,
      errors: paid.pairs.filter(p => p.status === 'error').length,
    };
    const paidOut = output ? join(output, 'receipt-paid.json') : receiptPath(`${CATEGORY}-paid`);
    writeReceipt(paidOut, {
      schema_version: RECEIPT_SCHEMA_VERSION, benchmark_version: BENCHMARK_VERSION, category: `${CATEGORY}-paid`,
      run_status: summary.errors || summary.degraded_dedup ? 'error' : 'completed', ...(summary.errors || summary.degraded_dedup ? {} : { verdict: 'pass' as const }),
      n_total: paid.pairs.length, n_scored: paid.pairs.length - summary.errors, completion_rate: paid.pairs.length ? (paid.pairs.length - summary.errors) / paid.pairs.length : 0,
      errors: paid.pairs.filter(p => p.error).map(p => ({ probe_id: `${p.chain}:${p.kind}`, origin: 'dependency' as const, message: p.error! })),
      publishable: true, gbrain_version: gut.version, gbrain_pin: gbrainPin(),
      execution: { source_tree: sourceTreeIdentity(), product: productIdentityFor(gut) },
      cost: paid.cost, delivered_tokens: { tokens: paid.cost.input_tokens, basis: 'embedding input tokens from the budget ledger' },
      resolved_config: { arm: 'implicit supersession through remember (report-only, preregistered)', embedding_model: PAID_EMBEDDING_MODEL, budget_run_id: paid.run_id, engine: 'pglite-in-memory, unmanaged, trusted local handlers', seed, ledger_sha256: world.fingerprint, gbrain_overlay: overlaySummary(gut) },
      started_at: startedAt, finished_at: new Date().toISOString(),
      data: { summary, pairs: paid.pairs },
    });
    log(`paid arm: ${summary.value_change_superseded} of ${summary.value_change_pairs} value changes superseded implicitly; ${summary.unrelated_controls_superseded} of ${summary.unrelated_controls} unrelated controls superseded; ${summary.near_duplicate_controls_deduped} of ${summary.near_duplicate_controls} near duplicates deduplicated; cost $${paid.cost.usd.toFixed(4)}`);
    log(`receipt: ${paidOut}`);
    process.exit(0);
  }
  const result = await withHermeticEnv('n1', async () => {
    const pgDown = engines.includes('postgres') ? await postgresReachable(pgAdminUrl) : null;
    const runEngines = engines.filter(e => e !== 'postgres' || !pgDown);
    const cells = await runMatrix(runEngines, ifaces, concurrency, 47300, (engine, iface, port) => {
      log(`[n1] start ${engine}/${iface}`);
      return runCell(world, gut, engine, iface, { work, pgAdminUrl, port, log }).then(c => { log(`[n1] done ${c.id} in ${Math.round(c.duration_ms / 1000)}s${c.fatal ? ` FATAL ${c.fatal.split('\n')[0]}` : c.void_reason ? ` VOID ${c.void_reason}` : ''}`); return c; });
    });
    const ontology = await ontologyUnmanagedArm(gut, world.ledger);
    return { cells, ontology, pgDown };
  });

  const pglite = result.cells.filter(c => c.engine === 'pglite');
  const postgres = result.cells.filter(c => c.engine === 'postgres');
  const metrics = aggregate(pglite);
  const metricsPg = postgres.length ? aggregate(postgres) : null;
  const harnessErrors = result.cells.filter(c => c.fatal || c.void_reason).map(c => ({ probe_id: c.id, origin: 'harness' as const, message: (c.void_reason ?? c.fatal ?? '').slice(0, 500) }));
  const allRows = pglite.flatMap(c => Object.values(c.checkpoints).flatMap(cp => cp!.rows));
  const sutErrors = allRows.filter(r => r.error).slice(0, 50).map(r => ({ probe_id: r.probe_id, origin: 'sut' as const, message: r.error!.slice(0, 300) }));
  const entry = registryEntry('N1')!;
  const pgliteVoid = pglite.length === 0 || pglite.some(c => c.fatal || c.void_reason);
  const runStatus = pgliteVoid ? 'error' : 'completed';
  const safety = {
    stale_served: metrics.stale_served === 0,
    private_value_leaks: metrics.private_value_leaks === 0,
    acknowledged_writes_lost: metrics.acknowledged_writes_lost === 0,
  };
  const quality = {
    current_value_accuracy: { value: metrics.current_value_accuracy, threshold: 1, pass: metrics.current_value_accuracy === 1 },
    history_retained_rate: { value: metrics.history_retained_rate, threshold: 1, pass: metrics.history_retained_rate === 1 },
  };
  const verdict = Object.values(safety).every(Boolean) ? 'pass' : 'fail';
  const ontologyArmMetrics = n1Metrics(result.ontology.rows, { private_value_leaks: result.ontology.exposure.filter(e => e.leak).length, exposure: result.ontology.exposure, acknowledged_writes_lost: 0 });
  const allPrimaryMs = pglite.flatMap(c => c.calls.primary_ms);
  const receipt: Receipt = {
    ...noModelSpend('hermetic: provider keys stripped, no embedding model, System One off; no model and no paid request'),
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CATEGORY,
    run_status: runStatus,
    ...(runStatus === 'completed' ? { verdict } : {}),
    n_total: allRows.length,
    n_scored: allRows.length,
    completion_rate: allRows.length ? 1 : 0,
    errors: [...harnessErrors, ...sutErrors],
    publishable: !pgliteVoid,
    gbrain_version: gut.version,
    gbrain_pin: gbrainPin(),
    execution: { source_tree: sourceTreeIdentity(), product: productIdentityFor(gut) },
    latency_ms: latencySummary(allPrimaryMs, 'primary-transport call latency over the PGLite cells'),
    resolved_config: {
      decide: DECIDE_OFF,
      decide_status_per_cell: Object.fromEntries(result.cells.map(c => [c.id, c.decide.ok ? 'all slots off' : c.decide])),
      engines: { requested: engines, run: [...new Set(result.cells.map(c => c.engine))], postgres_unreachable: result.pgDown },
      interfaces: ifaces,
      harness: 'eval/runner/lifecycle/slice.ts (lifecycle drivers: trusted local CLI `gbrain call`, stdio `gbrain serve`, HTTP `gbrain serve --http` with an OAuth client_credentials client bound to the vault source)',
      init: '`gbrain init --no-embedding --non-interactive` (managed persistence, keyword search only), a git vault as the default source',
      seed, generator_version: N1_GENERATOR_VERSION, ledger_sha256: world.fingerprint,
      checkpoints: CHECKPOINTS,
      oracle: {
        fence: 'the author\'s own fence: the active row is current, struck rows are history (eval/generators/n1-knowledge-update-gen.ts fenceRowsAt)',
        ontology: 'valid time: latest valid_from on or before the as-of day, later recorded wins ties (ontologyValueAt, the N3 semantics)',
        trajectory: 'every unstruck point charted in date order; struck (corrected) points are not',
      },
      gating_scope: 'data.metrics aggregates the PGLite cells; data.metrics_postgres is report-only outside CI',
      gbrain_overlay: overlaySummary(gut),
    },
    hashes: { ledger_sha256: world.fingerprint },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: {
      metrics,
      metrics_postgres: metricsPg,
      safety,
      quality,
      promotion_rules: entry.promotion,
      by_surface: breakdown(allRows, r => r.surface),
      by_depth: breakdown(allRows.filter(r => !r.probe_id.startsWith('concurrent:')), r => `depth ${r.depth}`),
      by_kind: breakdown(allRows, r => r.kind),
      by_checkpoint: Object.fromEntries(CHECKPOINTS.map(cp => [cp, breakdown(pglite.flatMap(c => c.checkpoints[cp]?.rows ?? []), () => 'all').all ?? null])),
      by_cell: result.cells.map(c => ({
        id: c.id, duration_ms: c.duration_ms, fatal: c.fatal?.split('\n')[0], void_reason: c.void_reason, server_version: c.server_version,
        private_value_leaks: c.private_value_leaks, calls: { primary: c.calls.primary, trusted: c.calls.trusted },
        checkpoints: Object.fromEntries(Object.entries(c.checkpoints).map(([k, v]) => [k, { probes: v!.rows.length, passed: v!.rows.filter(r => r.pass).length, stale: v!.rows.filter(r => r.stale).length, acked_lost: v!.acked_lost, exposure_signal: v!.exposure.filter(e => e.signal).length, exposure: v!.exposure.length }])),
        writes: { total: c.writes.length, refused_first: c.writes.filter(w => w.attempts > 1 || !w.ok).length, failed: c.writes.filter(w => !w.ok).map(w => ({ round: w.round, target: w.target, op: w.op, error: w.final_error })) },
      })),
      struck_history_in_search: pglite.reduce((n, c) => n + Object.values(c.checkpoints).reduce((m, cp) => m + cp!.struck_in_search, 0), 0),
      leak_evidence: result.cells.flatMap(c => c.leak_evidence.map(e => ({ cell: c.id, ...e }))).slice(0, 20),
      ontology_unmanaged: { scope: 'exploratory: the ontology chains replayed through in-process handlers on an unmanaged in-memory PGLite engine (no persistence coordinator), trusted local writes, local and remote reads', metrics: ontologyArmMetrics, writes: result.ontology.writes, failures: result.ontology.rows.filter(r => !r.pass), exposure: result.ontology.exposure, error: result.ontology.error },
      gaps: GAPS,
      failures: allRows.filter(r => !r.pass || r.stale).slice(0, 200),
      cells: result.cells.map(c => ({ ...c, calls: { primary: c.calls.primary, trusted: c.calls.trusted } })),
    },
  };
  writeReceipt(outPath, receipt);
  const outcome = evaluatePromotion(entry.promotion!, receipt);

  log(`\nverdict: ${runStatus === 'error' ? `error (${harnessErrors.map(e => e.message).join('; ').slice(0, 400)})` : verdict}`);
  log(`safety contracts (PGLite cells, ${pglite.length} cells):`);
  log(`  stale values served as current: ${metrics.stale_served} of ${metrics.current_value_probes + metrics.history_probes} current-value and history probes`);
  log(`  private values in remote responses: ${metrics.private_value_leaks} (exposure probes with signal: ${metrics.exposure_probes_with_signal} of ${metrics.exposure_probes})`);
  log(`  acknowledged writes lost: ${metrics.acknowledged_writes_lost}`);
  log(`quality metrics:`);
  log(`  current-value accuracy: ${pct(metrics.current_value_accuracy)} (${metrics.current_value_correct} of ${metrics.current_value_probes} current-value probes)`);
  log(`  history retained: ${pct(metrics.history_retained_rate)} (${metrics.history_retained} of ${metrics.history_probes} history probes)`);
  log(`  negative controls: ${metrics.negative_controls_passed} of ${metrics.negative_controls}`);
  if (metricsPg) log(`  postgres (report-only): current ${pct(metricsPg.current_value_accuracy)} of ${metricsPg.current_value_probes}, stale ${metricsPg.stale_served}, history ${pct(metricsPg.history_retained_rate)}, leaks ${metricsPg.private_value_leaks}, lost ${metricsPg.acknowledged_writes_lost}`);
  log(`  in-process ontology arm (unmanaged engine, exploratory): current ${pct(ontologyArmMetrics.current_value_accuracy)} of ${ontologyArmMetrics.current_value_probes}, stale ${ontologyArmMetrics.stale_served}, as-of ${pct(ontologyArmMetrics.history_retained_rate)}, remote leaks ${ontologyArmMetrics.private_value_leaks}`);
  log(`promotion rules: ${outcome.pass ? 'pass' : 'fail'} (${outcome.failures.map(f => f.id).join(', ') || 'none failed'})`);
  log(`gbrain findings: see docs/benchmarks/2026-10-01-wave-bugs.md (N1-*)`);
  log(`receipt: ${outPath}`);
  if (json) process.stdout.write(JSON.stringify({ run_status: runStatus, verdict, metrics, metrics_postgres: metricsPg }, null, 2) + '\n');
  process.exit(runStatus === 'error' ? 3 : verdict === 'pass' ? 0 : 1);
}

if (import.meta.main) {
  main().catch(e => {
    if (e instanceof PaidArmRefusal) { console.error(e.message); process.exit(2); }
    console.error(e);
    process.exit(3);
  });
}
