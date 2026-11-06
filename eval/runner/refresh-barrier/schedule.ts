/**
 * Trial schedules for the refresh-barrier validation (docs/benchmarks/2026-11-06-refresh-barrier-preregistration.md).
 *
 * One seed fixes a whole trial: how many agent processes write, which write each issues and when, which refresh ticks run,
 * where each tick pauses and for how long, which upstream files each tick brings in, and the fault strata (a foreign plain-git
 * commit with a later sync, a refresh process killed mid-tick and resumed, a writer process killed, a short deferral limit).
 * The flag-off and flag-on arms replay the same schedule, so every comparison is paired by seed.
 *
 * Pure and deterministic: the same seed and engine give the same schedule on every machine.
 */
import { PEOPLE, SEED_SLUGS, type SourceKey } from './fixture.ts';

export const SCHEDULE_VERSION = 2;
export type Engine = 'postgres' | 'pglite';
export type OpKind = 'remember_entity' | 'remember_unattributed' | 'put_create' | 'put_update' | 'put_blind';
export type Boundary = 'none' | 'drained' | 'fenced' | 'merged' | 'syncing';

export interface ScheduledOp { index: number; at_ms: number; kind: OpKind; source: SourceKey; slug: string | null; marker: string; request_id: string }
export interface WriterPlan { index: number; ops: ScheduledOp[]; kill_after_op: number | null }
export interface TickPlan {
  index: number; at_ms: number; source: SourceKey; boundary: Boundary; pause_ms: number;
  /** Another machine pushes this long before the tick, as a scheduled refresh follows pushes made earlier elsewhere. */
  push_lead_ms: number;
  pushes: Array<{ path: string; marker: string }>;
  crash: boolean; resume_after_ms: number | null;
}
export interface ForeignCommit { at_ms: number; path: string; marker: string; sync_after_ms: number }
export interface TrialSchedule {
  version: number; seed: number; engine: Engine; writers: WriterPlan[]; ticks: TickPlan[]; foreign: ForeignCommit[];
  max_wait_ms: number | null; ops_window_ms: number;
  strata: { foreign: boolean; import_sequence: boolean; crash: boolean; writer_kill: boolean; expiry: boolean };
}

/** The generator's fixed parameters, quoted in the preregistration. */
export const PARAMS = {
  ops_window_ms: 30_000,
  writers: [1, 2, 4, 8],
  ops_per_writer: [3, 8],
  op_mix: [['remember_entity', 0.33], ['remember_unattributed', 0.07], ['put_create', 0.20], ['put_update', 0.25], ['put_blind', 0.15]] as Array<[OpKind, number]>,
  beta_share: 0.25,
  ticks: [1, 3],
  tick_start_ms: [2_000, 22_000],
  boundary_mix: [['none', 0.15], ['drained', 0.30], ['fenced', 0.20], ['merged', 0.15], ['syncing', 0.20]] as Array<[Boundary, number]>,
  pause_ms: [250, 25_000],
  pushes_per_tick: [1, 4],
  push_lead_ms: [1_000, 6_000],
  tick_attempts: 5,
  tick_retry_ms: 1_500,
  converge_attempts: 40,
  push_overlap: 0.5,
  p_foreign: 0.30,
  p_import_sequence: 0.70,
  p_crash: 0.15,
  p_writer_kill: 0.10,
  p_expiry: 0.15,
  expiry_max_wait_ms: [2_000, 8_000],
} as const;

/** sfc32 seeded through splitmix32: small, fast and stable across runtimes. */
export function rng(seed: number, stream: string): () => number {
  let h = seed >>> 0;
  for (let i = 0; i < stream.length; i++) h = Math.imul(h ^ stream.charCodeAt(i), 0x9e3779b1) >>> 0;
  const split = () => { h = (h + 0x9e3779b9) >>> 0; let z = h; z = Math.imul(z ^ (z >>> 16), 0x85ebca6b); z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35); return (z ^ (z >>> 16)) >>> 0; };
  let a = split(), b = split(), c = split(), d = split();
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b | 0) + d | 0; d = d + 1 | 0;
    a = b ^ (b >>> 9); b = c + (c << 3) | 0; c = (c << 21) | (c >>> 11); c = c + t | 0;
    return (t >>> 0) / 4294967296;
  };
}

const int = (r: () => number, [lo, hi]: readonly [number, number]) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
const weighted = <T>(r: () => number, mix: ReadonlyArray<readonly [T, number]>): T => {
  let x = r();
  for (const [v, w] of mix) { if (x < w) return v; x -= w; }
  return mix[mix.length - 1]![0];
};
const logUniform = (r: () => number, [lo, hi]: readonly [number, number]) => Math.round(Math.exp(Math.log(lo) + r() * (Math.log(hi) - Math.log(lo))));

/** A version-4-shaped UUID from the stream, so request ids replay identically in both arms. */
export function uuid(r: () => number): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(r() * 16).toString(16));
  hex[12] = '4'; hex[16] = '89ab'[Math.floor(r() * 4)]!;
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/**
 * One seed's trial schedule. With `quiet` (the quiet latency block) it keeps the same writers and writes and drops every
 * tick, upstream push, foreign commit, sync and fault, so every write runs while no refresh is running.
 */
export function generateSchedule(seed: number, engine: Engine, quiet = false): TrialSchedule {
  const r = rng(seed, 'trial');
  const tag = seed.toString(36);
  const multiProcess = engine === 'postgres';
  const strata = {
    foreign: r() < PARAMS.p_foreign,
    crash: multiProcess && r() < PARAMS.p_crash,
    writer_kill: multiProcess && r() < PARAMS.p_writer_kill,
    expiry: r() < PARAMS.p_expiry,
  };
  const max_wait_ms = strata.expiry ? int(r, PARAMS.expiry_max_wait_ms) : null;

  const nWriters = pick(r, PARAMS.writers);
  const writers: WriterPlan[] = [];
  for (let w = 0; w < nWriters; w++) {
    const wr = rng(seed, `writer-${w}`);
    const n = int(wr, PARAMS.ops_per_writer);
    const times = Array.from({ length: n }, () => Math.floor(wr() * PARAMS.ops_window_ms)).sort((a, b) => a - b);
    const ops = times.map((at_ms, i): ScheduledOp => {
      const kind = weighted(wr, PARAMS.op_mix);
      const source: SourceKey = wr() < PARAMS.beta_share ? 'beta' : 'alpha';
      const slug = kind === 'remember_entity' ? pick(wr, PEOPLE)
        : kind === 'put_update' || kind === 'put_blind' ? pick(wr, SEED_SLUGS)
        : kind === 'put_create' ? `notes/w${w}-${i}-${tag}` : null;
      return { index: i, at_ms, kind, source, slug, marker: `RBM${seed}w${w}o${i}q`, request_id: uuid(wr) };
    });
    writers.push({ index: w, ops, kill_after_op: null });
  }
  if (quiet) return { version: SCHEDULE_VERSION, seed, engine, writers, ticks: [], foreign: [], max_wait_ms: null, ops_window_ms: PARAMS.ops_window_ms,
    strata: { foreign: false, import_sequence: false, crash: false, writer_kill: false, expiry: false } };
  if (strata.writer_kill) {
    const victim = writers[Math.floor(r() * writers.length)]!;
    victim.kill_after_op = Math.min(1, victim.ops.length - 1);
  }

  const tr = rng(seed, 'ticks');
  const nTicks = int(tr, PARAMS.ticks);
  const starts = Array.from({ length: nTicks }, () => int(tr, PARAMS.tick_start_ms)).sort((a, b) => a - b);
  const ticks = starts.map((at_ms, i): TickPlan => {
    const boundary = weighted(tr, PARAMS.boundary_mix);
    const nPush = int(tr, PARAMS.pushes_per_tick);
    const pushes = Array.from({ length: nPush }, (_, j) => {
      const src = tr() < PARAMS.beta_share ? 'beta' : 'alpha';
      const path = tr() < PARAMS.push_overlap ? `${src}/${pick(tr, SEED_SLUGS)}.md` : `${src}/notes/upstream-${tag}-${i}-${j}.md`;
      return { path, marker: `UPM${seed}t${i}p${j}q` };
    });
    return { index: i, at_ms, source: 'alpha', boundary, pause_ms: boundary === 'none' ? 0 : logUniform(tr, PARAMS.pause_ms), push_lead_ms: int(tr, PARAMS.push_lead_ms), pushes, crash: false, resume_after_ms: null };
  });
  if (strata.expiry && max_wait_ms !== null) {
    const t = ticks[0]!;
    if (t.boundary === 'none') t.boundary = 'drained';
    t.pause_ms = Math.max(t.pause_ms, max_wait_ms + 3_000 + int(tr, [0, 4_000]));
  }
  if (strata.crash) {
    const paused = ticks.filter(t => t.boundary !== 'none');
    const victim = paused.length ? pick(tr, paused) : ticks[0]!;
    if (victim.boundary === 'none') { victim.boundary = 'fenced'; victim.pause_ms = logUniform(tr, PARAMS.pause_ms); }
    victim.crash = true;
    victim.resume_after_ms = int(tr, [1_000, 5_000]);
  }

  const fr = rng(seed, 'foreign');
  const foreign: ForeignCommit[] = strata.foreign
    ? Array.from({ length: int(fr, [1, 2]) }, (_, i) => ({ at_ms: int(fr, [0, 25_000]), path: `alpha/${pick(fr, SEED_SLUGS)}.md`, marker: `FCM${seed}f${i}q`, sync_after_ms: int(fr, [3_000, 10_000]) }))
      .sort((a, b) => a.at_ms - b.at_ms)
    : [];
  // GBRA-108 / GBRA-347 case: write A (a blind local put) is held for an import, write B to the same page follows, then the
  // import's sync (the checkpoint) releases both.
  const import_sequence = strata.foreign && fr() < PARAMS.p_import_sequence;
  if (import_sequence) {
    const f = foreign[0]!;
    const slug = pick(fr, PEOPLE);
    f.path = `alpha/${slug}.md`;
    const aAt = f.at_ms + int(fr, [300, 1_500]);
    const bAt = aAt + int(fr, [300, 1_500]);
    f.sync_after_ms = bAt - f.at_ms + int(fr, [2_000, 6_000]);
    const wa = writers[Math.floor(fr() * writers.length)]!;
    const others = writers.filter(w => w !== wa);
    const wb = others.length ? others[Math.floor(fr() * others.length)]! : wa;
    const bKind = weighted(fr, [['remember_entity', 0.4], ['put_update', 0.3], ['put_blind', 0.3]] as Array<[OpKind, number]>);
    const add = (w: WriterPlan, at_ms: number, kind: OpKind, tagName: string) => w.ops.push({ index: -1, at_ms, kind, source: 'alpha', slug, marker: `RBM${seed}${tagName}q`, request_id: uuid(fr) });
    add(wa, aAt, 'put_blind', 'ia');
    add(wb, bAt, bKind, 'ib');
    for (const w of [wa, wb]) {
      w.ops.sort((x, y) => x.at_ms - y.at_ms);
      w.ops.forEach((op, i) => { op.index = i; if (!op.marker.endsWith('iaq') && !op.marker.endsWith('ibq')) op.marker = `RBM${seed}w${w.index}o${i}q`; });
    }
  }

  // Version 2: a tick push and a foreign commit to one file would both add a line at its top, a same-line Git conflict
  // (integrate_conflict, a convergence path this eval does not measure), so such a push goes to a new upstream note instead.
  // No random draw changes, so every other part of every schedule is as in version 1.
  const foreignPaths = new Set(foreign.map(f => f.path));
  for (const t of ticks) t.pushes.forEach((p, j) => { if (foreignPaths.has(p.path)) p.path = `alpha/notes/upstream-${tag}-${t.index}-${j}.md`; });

  return { version: SCHEDULE_VERSION, seed, engine, writers, ticks, foreign, max_wait_ms, ops_window_ms: PARAMS.ops_window_ms, strata: { ...strata, import_sequence } };
}

export const allOps = (s: TrialSchedule) => s.writers.flatMap(w => w.ops.map(op => ({ writer: w.index, ...op })));
