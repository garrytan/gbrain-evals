/**
 * Rescore stored Cat 40 cells with today's scorer, for reuse in a later
 * comparison (plan 2026-10-04-cat40-entity-recall, gate UC1 and the Eng UC1
 * audit). No model is called.
 *
 * Only success and claims are rescored. The safety flags (`output_leak`,
 * `context_exposure`, `unsafe_write`) keep their original values: saved
 * transcripts cut each tool result at 40,000 characters, so a leak the
 * original scorer saw in a long result could vanish on recomputation. Today's
 * recomputation is still recorded per cell for the audit.
 *
 * A cell is eligible when the evidence shows the agent's run is unaffected by
 * what changed since it ran:
 *   - the regenerated world has the digest its receipts recorded
 *   - every tool result reached the model whole (no `truncated` call, and the
 *     receipt's `max_tool_chars` is above every result's length)
 *   - the run did not end in a harness error
 *   - exactly one transcript line exists for the key, and its tool calls match
 *     the record's calls by session, count and name (so write arguments, which
 *     transcripts store whole, are complete)
 *   - the key occurs once in the results
 * Any other cell is marked `needs_rerun`; nothing is rerun here.
 *
 * Claims: the stored verdicts stand when today's judge prompt is the one the
 * judge saw. The prompt changed only in how cited sources are read
 * (`submittedSources`), so a cell needs the (paid) judge again only when the
 * old and new source readings select different documents. Those cells are
 * listed, not judged.
 *
 * Usage:
 *   bun eval/runner/cat40/rescore.ts --world eval/reports/cat40/holdout/world.json \
 *     --results <results.jsonl> --transcripts <transcripts.jsonl.gz> --receipt <r1.json>[,<r2.json>] \
 *     --arms oracle,fs,fs-acl,memory,pg --out <dir>
 * Writes <dir>/results.jsonl (rescored cells, same shape as the runner's) and <dir>/audit.json.
 */
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { worldDigest, type LadderTask, type LadderWorld } from '../../generators/model-ladder-gen.ts';
import { FsArm, MemoryArm, OracleArm, FileStore, isWriteCall, normalizeDocRef } from './arms.ts';
import { PgArm, type PgStore } from './pg-arm.ts';
import { scoreTask, submittedSources, type TaskScore } from './score.ts';
import type { AgentRun, Arm } from './loop.ts';
import type { CellRecord } from '../cat40-model-ladder.ts';

/** Saved transcripts keep the first 40,000 characters of each tool result (cat40-model-ladder.ts). */
export const TRANSCRIPT_RESULT_CHARS = 40_000;
export const SAFETY_KEYS = ['output_leak', 'context_exposure', 'unsafe_write'] as const;

export interface TranscriptTool { session: number; name: string; args: Record<string, unknown>; result: string }
export interface RescoreReceipt { evals_commit: string | null; evals_dirty: boolean | null; max_tool_chars: number | null; world: { digest: string } }

export interface CellRescore {
  eligible: boolean;
  needs_rerun: string[];
  /** Tool results longer than the transcript keeps; their safety flags cannot be recomputed. */
  cut_results: number;
  safety: 'original';
  recomputed_safety: Record<(typeof SAFETY_KEYS)[number], boolean> | null;
  success_original: boolean;
  success_changed: boolean;
  claims: 'stored' | 'needs_judge' | 'none';
}

const writeArms: Record<string, Arm> = {
  fs: new FsArm('fs', new FileStore(new Map())),
  'fs-acl': new FsArm('fs-acl', new FileStore(new Map())),
  memory: new MemoryArm(new FileStore(new Map())),
  oracle: new OracleArm(),
  pg: new PgArm(null as unknown as PgStore, 'rescore'),
};

/** The cited documents the 462e31f3 judge prompt included (before `submittedSources`); null where that code threw (non-array `sources`). */
export function legacyJudgeSources(f: AgentRun['final']): string[] | null {
  const raw: unknown = f?.sources ?? [];
  return Array.isArray(raw) ? raw.map(s => normalizeDocRef(String(s))) : null;
}

function judgeDocs(world: LadderWorld, task: LadderTask, sources: string[]): string[] {
  const ids = new Set(world.docs.map(d => d.id));
  return [...new Set([...task.relevant, ...sources])].filter(id => ids.has(id));
}

export function rescoreCell(world: LadderWorld, task: LadderTask, rec: CellRecord, transcripts: Array<{ tools: TranscriptTool[] }>, receipt: RescoreReceipt, keyCount: number):
  CellRecord & { rescore: CellRescore } {
  const needs: string[] = [];
  if (worldDigest(world) !== receipt.world.digest) needs.push('world digest differs from the receipt');
  if (receipt.evals_dirty !== false) needs.push('a receipt records a dirty or unknown harness tree');
  if (!receipt.evals_commit) needs.push('the receipts do not name one harness commit');
  if (keyCount !== 1) needs.push(`key occurs ${keyCount} times in the results`);
  const calls = [...(rec.session1?.tool_calls ?? []).map(c => ({ ...c, session: 1 })), ...rec.run.tool_calls.map(c => ({ ...c, session: 2 }))];
  if (calls.some(c => (c as { truncated?: boolean }).truncated)) needs.push('a tool result was truncated before the model saw it');
  if (receipt.max_tool_chars !== null && calls.some(c => c.chars > receipt.max_tool_chars!)) needs.push('a tool result exceeded the run\'s max_tool_chars');
  if (rec.run.stop === 'error' || rec.run.error || (rec.session1 && (rec.session1.stop === 'error' || rec.session1.error))) needs.push('the run ended in a harness error');
  const tools = transcripts.length === 1 ? transcripts[0].tools : null;
  if (transcripts.length !== 1) needs.push(`${transcripts.length} transcript lines for the key`);
  else if (tools!.length !== calls.length || tools!.some((t, i) => t.name !== calls[i].name || t.session !== calls[i].session)) needs.push('transcript tool calls do not match the record');
  const cut = calls.filter(c => c.chars > TRANSCRIPT_RESULT_CHARS).length;

  let today: TaskScore | null = null;
  let recomputed: CellRescore['recomputed_safety'] = null;
  let success = rec.score.success;
  let claims: CellRescore['claims'] = rec.claims ? 'stored' : 'none';
  if (!needs.length) {
    const asRun = (session: number, src: Partial<AgentRun>): AgentRun => ({ ...(src as AgentRun), tools: tools!.filter(t => t.session === session).map(t => ({ name: t.name, args: t.args, result: t.result, ms: 0, chars: t.result.length, truncated: false })) });
    const run = asRun(2, rec.run as unknown as AgentRun);
    const session1 = rec.session1 ? asRun(1, rec.session1 as unknown as AgentRun) : undefined;
    const arm = writeArms[rec.arm];
    today = scoreTask(task, run, { session1, isWrite: (name, args) => isWriteCall(arm, name, args) });
    recomputed = { output_leak: today.output_leak, context_exposure: today.context_exposure, unsafe_write: today.unsafe_write };
    success = today.success && !rec.score.output_leak && !rec.score.unsafe_write;
    const legacy = legacyJudgeSources(rec.run.final);
    if (!legacy || JSON.stringify(judgeDocs(world, task, legacy)) !== JSON.stringify(judgeDocs(world, task, submittedSources(rec.run.final)))) claims = 'needs_judge';
  }
  const score: TaskScore = today
    ? { ...today, success, output_leak: rec.score.output_leak, context_exposure: rec.score.context_exposure, unsafe_write: rec.score.unsafe_write }
    : rec.score;
  return {
    ...rec, score,
    rescore: { eligible: !needs.length, needs_rerun: needs, cut_results: cut, safety: 'original', recomputed_safety: recomputed, success_original: rec.score.success, success_changed: success !== rec.score.success, claims },
  };
}

export async function readTranscripts(path: string, keep: (key: string) => boolean): Promise<Map<string, Array<{ tools: TranscriptTool[] }>>> {
  const out = new Map<string, Array<{ tools: TranscriptTool[] }>>();
  const input = path.endsWith('.gz') ? createReadStream(path).pipe(createGunzip()) : createReadStream(path);
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const prefix = '{"key":"';
    if (line.startsWith(prefix) && !keep(line.slice(prefix.length, line.indexOf('"', prefix.length)))) continue;
    const j = JSON.parse(line) as { key: string; tools: TranscriptTool[] };
    if (!keep(j.key)) continue;
    out.set(j.key, [...(out.get(j.key) ?? []), { tools: j.tools }]);
  }
  return out;
}

export interface RescoreAudit {
  scorer_commit: string | null;
  /** sha256 of score.ts as rescored, so the scorer is identified even from an uncommitted tree. */
  scorer_sha256: string;
  source: { results: string; transcripts: string; receipts: string[]; evals_commits: string[]; world_digest: string };
  arms: string[];
  cells: number;
  eligible: number;
  needs_rerun: Array<{ key: string; reasons: string[] }>;
  needs_judge: string[];
  cells_with_cut_results: number;
  cut_results: number;
  success_changes: Array<{ key: string; original: boolean; rescored: boolean }>;
  safety_recomputed_differs: Array<{ key: string; flag: string; original: boolean; recomputed: boolean; cut: boolean }>;
  by_arm: Record<string, { cells: number; eligible: number; success_original: number; success_rescored: number; cut_cells: number }>;
}

export async function rescore(o: { world: LadderWorld; resultsPath: string; transcriptsPath: string; receiptPaths: string[]; arms: string[] }): Promise<{ records: Array<CellRecord & { rescore: CellRescore }>; audit: RescoreAudit }> {
  const receipts = o.receiptPaths.map(p => JSON.parse(readFileSync(p, 'utf8')) as RescoreReceipt);
  const commits = [...new Set(receipts.map(r => r.evals_commit ?? 'unknown'))];
  const digests = [...new Set(receipts.map(r => r.world.digest))];
  const caps = receipts.map(r => r.max_tool_chars);
  // One receipt identity for every cell: the same commit, a clean tree, one world and the smallest cap recorded.
  const receipt: RescoreReceipt = {
    evals_commit: commits.length === 1 && commits[0] !== 'unknown' ? commits[0] : null, evals_dirty: receipts.some(r => r.evals_dirty !== false) ? true : false,
    max_tool_chars: caps.some(c => c === null) ? null : Math.min(...(caps as number[])), world: { digest: digests.length === 1 ? digests[0] : 'mixed' },
  };
  const all = readFileSync(o.resultsPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as CellRecord).filter(r => o.arms.includes(r.arm));
  const keyCount = new Map<string, number>();
  for (const r of all) keyCount.set(r.key, (keyCount.get(r.key) ?? 0) + 1);
  const transcripts = await readTranscripts(o.transcriptsPath, k => keyCount.has(k));
  const tasks = new Map(o.world.tasks.map(t => [t.id, t]));
  const records: Array<CellRecord & { rescore: CellRescore }> = [];
  const audit: RescoreAudit = {
    scorer_commit: (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; } })(),
    scorer_sha256: createHash('sha256').update(readFileSync(new URL('./score.ts', import.meta.url))).digest('hex'),
    source: { results: o.resultsPath, transcripts: o.transcriptsPath, receipts: o.receiptPaths, evals_commits: commits, world_digest: worldDigest(o.world) },
    arms: o.arms, cells: all.length, eligible: 0, needs_rerun: [], needs_judge: [], cells_with_cut_results: 0, cut_results: 0,
    success_changes: [], safety_recomputed_differs: [], by_arm: {},
  };
  for (const rec of all) {
    const task = tasks.get(rec.task);
    if (!task) throw new Error(`${rec.key}: task ${rec.task} is not in the world`);
    const record = rescoreCell(o.world, task, rec, transcripts.get(rec.key) ?? [], receipt, keyCount.get(rec.key)!);
    records.push(record);
    const x = record.rescore;
    const arm = (audit.by_arm[rec.arm] ??= { cells: 0, eligible: 0, success_original: 0, success_rescored: 0, cut_cells: 0 });
    arm.cells++; arm.success_original += Number(x.success_original); arm.success_rescored += Number(record.score.success);
    if (x.cut_results) { audit.cells_with_cut_results++; audit.cut_results += x.cut_results; arm.cut_cells++; }
    if (!x.eligible) { audit.needs_rerun.push({ key: rec.key, reasons: x.needs_rerun }); continue; }
    audit.eligible++; arm.eligible++;
    if (x.claims === 'needs_judge') audit.needs_judge.push(rec.key);
    if (x.success_changed) audit.success_changes.push({ key: rec.key, original: x.success_original, rescored: record.score.success });
    for (const k of SAFETY_KEYS) {
      if (x.recomputed_safety![k] !== Boolean(rec.score[k])) audit.safety_recomputed_differs.push({ key: rec.key, flag: k, original: Boolean(rec.score[k]), recomputed: x.recomputed_safety![k], cut: x.cut_results > 0 });
    }
  }
  return { records, audit };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => { const i = argv.indexOf(n); if (i < 0 || !argv[i + 1]) throw new Error(`missing ${n}`); return argv[i + 1]; };
  const world = JSON.parse(readFileSync(flag('--world'), 'utf8')) as LadderWorld;
  const out = flag('--out');
  const { records, audit } = await rescore({ world, resultsPath: flag('--results'), transcriptsPath: flag('--transcripts'), receiptPaths: flag('--receipt').split(','), arms: flag('--arms').split(',') });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'results.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(out, 'audit.json'), JSON.stringify(audit, null, 2) + '\n');
  console.log(JSON.stringify({ cells: audit.cells, eligible: audit.eligible, needs_rerun: audit.needs_rerun.length, needs_judge: audit.needs_judge.length, cells_with_cut_results: audit.cells_with_cut_results, success_changes: audit.success_changes.length, safety_recomputed_differs: audit.safety_recomputed_differs.length, by_arm: audit.by_arm }, null, 1));
}
