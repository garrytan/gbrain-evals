/**
 * Cat 40 cell records, v1 and v2.
 *
 * v1 (`CellRecord` in cat40-model-ladder.ts) is what the v1 runner writes:
 * one line per cell in results.jsonl, with `run` and an optional `session1`.
 *
 * v2 is what Hard runs write (ENG-F1, ENG-F2): every attempt of a cell is one
 * line in attempts.jsonl with a unique `attempt_id`, the sessions of the cell
 * in `sessions[]`, and a cell-level `stop`. Only `harness_error` attempts are
 * retried, at most HARD_MAX_RETRIES times. The canonical cell is the last
 * harness-clean attempt per key; analysis sums cost over every attempt.
 * results.jsonl of a Hard run holds the canonical (harness-clean) attempts.
 *
 * Readers here accept both versions so analyze.ts, rescore.ts,
 * latency-replay.ts and holdout_stats.py see one shape.
 */
import { readFileSync } from 'node:fs';
import type { AgentRun } from './loop.ts';
import type { HardScore, HardStopKind } from '../../generators/hard/schema.ts';

export const CELL_SCHEMA_V2 = 'cat40-cell-v2';
/** Retries of a harness error per cell; a cell has at most 1 + HARD_MAX_RETRIES attempts. */
export const HARD_MAX_RETRIES = 2;

export type StrippedRun = Omit<AgentRun, 'tools' | 'stop'> & { stop: HardStopKind; tool_calls: Array<{ name: string; ms: number; chars: number; truncated: boolean; error?: string }> };

export interface SessionRecord {
  /** 1-based. */
  index: number;
  /** `record` sessions (H5 1 to 4) must submit RECORDED; the `question` session is scored. */
  role: 'record' | 'question';
  stop: HardStopKind;
  run: StrippedRun;
  /** Dollars of model calls in this session. */
  usd: number;
  /** For H5 write diagnostics: store changes made in this session (paths or ids written). */
  writes?: string[];
}

/** Where each paid dollar of an attempt went (ENG-F12). */
export interface CostAttribution {
  agent_usd: number;
  /** pg arm query and note embeddings during the attempt. */
  embed_usd: number;
  /** gbrain's own provider calls during the attempt (metering proxy). */
  gbrain_usd: number;
  judge_usd: number;
}

/** Wall-clock split of an attempt (ENG-F13): agent latency comes from `agent_ms`, never from restore time. */
export interface CellTimings { queue_ms: number; session_start_ms: number; agent_ms: number; restore_ms: number; judge_ms: number }

export interface CellRecordV2 {
  schema: typeof CELL_SCHEMA_V2;
  key: string;
  attempt_id: string;
  /** 1-based attempt number for this key. */
  attempt: number;
  model: string;
  provider: string;
  arm: string;
  task: string;
  family: string;
  variant: string;
  repeat: number;
  stop: HardStopKind;
  /** For `harness_error` or `error`: what failed, naming the failing session ("session 3: ..."). */
  error?: string;
  score: HardScore;
  claims: { claims: Array<{ claim: string; verdict: string }>; unsupported: number; contradicted: number; total: number } | null;
  judge_error?: string;
  sessions: SessionRecord[];
  /** The scored (final) session's run, so v1 readers that look at `run` keep working. */
  run: StrippedRun;
  gbrain_internal?: { usd: number; requests: number; unpriced: number; undrained?: number; byModel: Record<string, { usd: number; requests: number }> };
  cost: CostAttribution;
  /** Agent sessions plus embeddings plus gbrain's provider calls; the judge is separate (`judge_usd`). */
  total_usd: number;
  judge_usd: number;
  timings: CellTimings;
  restore_ms?: number;
  budget_run_id: string | null;
  /** The experiment settings that change behavior, repeated per record so a reader can validate them. */
  experiment: { world_digest: string; scale: 'v1' | 'large'; max_turns: number; tool_limits: 'v1' | 'hard'; judge: string | null };
  wall_ms: number;
  started_at: string;
}

/** The fields every reader needs, from either record version. */
export interface CellView {
  version: 1 | 2;
  key: string;
  attempt_id: string;
  attempt: number;
  model: string;
  arm: string;
  task: string;
  family: string;
  repeat: number;
  stop: string;
  success: boolean;
  harness_clean: boolean;
  total_usd: number;
  judge_usd: number;
  /** Agent-only latency in ms (v1: wall_ms minus restore_ms). */
  agent_ms: number;
  wall_ms: number;
  turns: number;
  tool_calls: number;
  sessions: Array<{ index: number; stop: string; usd: number; turns: number; tool_calls: number }>;
  unparseable_set: boolean;
  raw: Record<string, unknown>;
}

export function isV2(r: unknown): r is CellRecordV2 {
  return !!r && typeof r === 'object' && (r as { schema?: unknown }).schema === CELL_SCHEMA_V2;
}

type V1Like = { key: string; model: string; arm: string; task: string; family: string; repeat: number; score: { success: boolean }; total_usd: number; judge_usd?: number; wall_ms: number; restore_ms?: number;
  run: { stop: string; turns: number; usd: number; tool_calls?: unknown[] }; session1?: { stop: string; turns: number; usd: number; tool_calls?: unknown[] } };

export function view(raw: Record<string, unknown>): CellView {
  if (isV2(raw)) {
    const r = raw;
    return {
      version: 2, key: r.key, attempt_id: r.attempt_id, attempt: r.attempt, model: r.model, arm: r.arm, task: r.task, family: r.family, repeat: r.repeat,
      stop: r.stop, success: r.score.success, harness_clean: r.stop !== 'harness_error', total_usd: r.total_usd, judge_usd: r.judge_usd ?? 0,
      agent_ms: r.timings?.agent_ms ?? r.wall_ms, wall_ms: r.wall_ms,
      turns: r.sessions.reduce((s, x) => s + x.run.turns, 0), tool_calls: r.sessions.reduce((s, x) => s + x.run.tool_calls.length, 0),
      sessions: r.sessions.map(s => ({ index: s.index, stop: s.stop, usd: s.usd, turns: s.run.turns, tool_calls: s.run.tool_calls.length })),
      unparseable_set: Boolean(r.score.unparseable_set), raw,
    };
  }
  const r = raw as unknown as V1Like;
  const sessions = [...(r.session1 ? [{ index: 1, s: r.session1 }] : []), { index: r.session1 ? 2 : 1, s: r.run }];
  return {
    version: 1, key: r.key, attempt_id: `${r.key}#1`, attempt: 1, model: r.model, arm: r.arm, task: r.task, family: r.family, repeat: r.repeat,
    stop: r.run.stop, success: r.score.success, harness_clean: true, total_usd: r.total_usd, judge_usd: r.judge_usd ?? 0,
    agent_ms: r.wall_ms - (r.restore_ms ?? 0), wall_ms: r.wall_ms,
    turns: sessions.reduce((s, x) => s + x.s.turns, 0), tool_calls: sessions.reduce((s, x) => s + (x.s.tool_calls?.length ?? 0), 0),
    sessions: sessions.map(x => ({ index: x.index, stop: x.s.stop, usd: x.s.usd, turns: x.s.turns, tool_calls: x.s.tool_calls?.length ?? 0 })),
    unparseable_set: false, raw,
  };
}

export function readRecords(paths: string[]): Array<Record<string, unknown>> {
  return paths.flatMap(p => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>));
}

/**
 * The canonical cell per key: the last harness-clean attempt (v1 records are
 * one attempt each, so a duplicated v1 key keeps its last line). A v2 attempt
 * read twice (attempts.jsonl and results.jsonl together) counts once. Cost summed
 * over every attempt of the key, retries included, is returned beside it.
 */
export function canonicalCells(records: Array<Record<string, unknown>>): { cells: CellView[]; attempts: CellView[]; cost_all_attempts_usd: number; retries: Record<string, number>; incomplete: string[] } {
  const seenAttempt = new Set<string>();
  const attempts = records.map(view).filter(a => a.version === 1 || (!seenAttempt.has(a.attempt_id) && !!seenAttempt.add(a.attempt_id)));
  const byKey = new Map<string, CellView[]>();
  for (const a of attempts) { if (!byKey.has(a.key)) byKey.set(a.key, []); byKey.get(a.key)!.push(a); }
  const cells: CellView[] = [];
  const retries: Record<string, number> = {};
  const incomplete: string[] = [];
  const seen = new Set<string>();
  for (const [key, list] of byKey) {
    const clean = list.filter(a => a.harness_clean);
    const pick = clean.at(-1);
    const ma = `${list[0].model}|${list[0].arm}`;
    retries[ma] = (retries[ma] ?? 0) + list.filter(a => !a.harness_clean).length;
    if (!pick) { incomplete.push(key); continue; }
    if (!seen.has(pick.attempt_id)) { seen.add(pick.attempt_id); cells.push(pick); }
  }
  return { cells, attempts, cost_all_attempts_usd: attempts.reduce((s, a) => s + a.total_usd + a.judge_usd, 0), retries, incomplete };
}

/**
 * Check a set of canonical cells against the expected grid and one experiment
 * identity. Returns problems; empty when the grid is complete and consistent.
 */
export function gridProblems(cells: CellView[], expect: { models: string[]; arms: string[]; tasks: string[]; repeats: number }): string[] {
  const problems: string[] = [];
  const have = new Set(cells.map(c => c.key));
  let missing = 0;
  for (const m of expect.models) for (const a of expect.arms) for (const t of expect.tasks) for (let r = 0; r < expect.repeats; r++) {
    if (!have.has(`${m}|${a}|${t}|${r}`)) missing++;
  }
  if (missing) problems.push(`${missing} expected cells are missing`);
  const ids = new Set<string>();
  for (const c of cells) {
    if (c.version !== 2) continue;
    const e = (c.raw as unknown as CellRecordV2).experiment;
    ids.add(JSON.stringify({ world: e.world_digest, scale: e.scale, max_turns: e.max_turns, tool_limits: e.tool_limits }));
  }
  if (ids.size > 1) problems.push(`records come from ${ids.size} different experiments (world, scale, turn cap or tool limits differ): ${[...ids].join(' | ')}`);
  return problems;
}
