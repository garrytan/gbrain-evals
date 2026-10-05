/**
 * Dev-phase driver for the memory proof wave: ingest once per system and
 * dataset slice, tune retrieval knobs to each delivered-context target, then
 * run one cell per target (and the system's own default), all reusing the
 * shared store.
 *
 *   bun eval/runner/harness-dev.ts sweep --provider gbrain --dataset beam --split 100k \
 *     --units 3,11,12,15 --base '{"token_budget": 8100}' [--targets 4000,8000,16000,32000] \
 *     [--extra '{"embedding_model": "voyage:voyage-4"}'] [--lane raw] [--sample 60] [--no-default] \
 *     -- <harness:cell flags: --gbrain ..., --budget-ledger ...>
 *
 * Writes the generated specs to eval/harness-provider/cells/dev/ and a track
 * log to eval/reports/harness-dev/<track>.jsonl. A target whose knobs cannot
 * be tuned into the ±10% gate is skipped and logged, not run off-target.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CellSpec } from './harness-cell.ts';
import { REPO_ROOT } from './harness-env.ts';

export const DEV_ANSWER = 'gemini:gemini-3.8-flash';
export const DEV_JUDGE: Record<string, string> = { beam: 'gemini:gemini-3.5-flash', default: 'gemini:gemini-3.5-flash' };
const SPEC_DIR = join(REPO_ROOT, 'eval/harness-provider/cells/dev');
const LOG_DIR = join(REPO_ROOT, 'eval/reports/harness-dev');

export interface Track {
  provider: 'gbrain' | 'comparator' | 'qdrant';
  dataset: string; split: string; units?: string[]; questionIds?: string[];
  lane: CellSpec['lane']; mode: CellSpec['mode'];
  base: Record<string, number>; extra: Record<string, unknown>;
  targets: number[]; sample: number; runDefault: boolean;
  gbrainCredentials?: string[];
  answer?: string;
  name?: string;
}

export function trackName(t: Track): string {
  return t.name ?? `${t.provider}-${t.dataset}-${t.split}-${t.mode}-${t.lane}`;
}

export function devSpec(t: Track, target: number | null, knobs: Record<string, unknown>, budget: number): CellSpec {
  const spec: CellSpec = {
    dataset: t.dataset, split: t.split, provider: t.provider as CellSpec['provider'], mode: t.mode, lane: t.lane, seal: 'dev',
    target_tokens: target,
    models: { answer: t.answer ?? DEV_ANSWER, judge: DEV_JUDGE[t.dataset] ?? DEV_JUDGE.default },
    budget_usd: budget,
    questions: t.questionIds ? { ids: t.questionIds } : { units: t.units ?? [] },
    k: 10,
    provider_config: { ...t.extra, ...knobs },
    note: `memory proof wave dev ${trackName(t)} ${target === null ? 'system default' : `${target}-token target`}`,
  };
  if (t.provider === 'gbrain') spec.gbrain_credentials = t.gbrainCredentials ?? ['voyage'];
  return spec;
}

function launch(args: string[], passthrough: string[]): { code: number; out: string; err: string } {
  const p = Bun.spawnSync([process.execPath, 'eval/runner/harness-cell.ts', ...args, ...passthrough], { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe', env: { ...process.env } });
  return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString() };
}

function cellIdFrom(err: string): string | null {
  return /\[cell\] (\S+?):/.exec(err)?.[1] ?? /\[cell\] (\S+) exited/.exec(err)?.[1] ?? null;
}

export async function sweep(t: Track, passthrough: string[]): Promise<number> {
  mkdirSync(SPEC_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  const name = trackName(t);
  const log = (row: Record<string, unknown>) => { appendFileSync(join(LOG_DIR, `${name}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n'); console.log(`[dev:${name}]`, JSON.stringify(row).slice(0, 400)); };
  const ingestPath = join(SPEC_DIR, `${name}-ingest.json`);
  writeFileSync(ingestPath, JSON.stringify(devSpec(t, 8000, t.base, t.provider === 'comparator' || t.extra.gbrain_config ? 60 : 10), null, 2) + '\n');
  const ingest = launch(['ingest', ingestPath], passthrough);
  const ingestCell = cellIdFrom(ingest.err);
  log({ step: 'ingest', code: ingest.code, cell: ingestCell, tail: ingest.err.split('\n').slice(-3).join(' | ') });
  if (ingest.code !== 0 || !ingestCell) return 1;
  let chosen: Record<string, Record<string, number> | null> = {};
  if (t.targets.length && Object.keys(t.base).length) {
    const tune = launch(['tune', ingestCell, '--auto', JSON.stringify({ targets: t.targets, base: t.base, sample: t.sample })], passthrough);
    const line = tune.out.trim().split('\n').reverse().find(l => l.startsWith('{'));
    chosen = line ? JSON.parse(line) : {};
    log({ step: 'tune', code: tune.code, chosen });
  }
  let failures = 0;
  const runs: Array<[number | null, Record<string, unknown> | null]> = t.targets.map(target => [target, chosen[String(target)] ?? null]);
  if (t.runDefault) runs.push([null, Object.fromEntries(Object.keys(t.base).map(k => [k, null]))]);
  for (const [target, knobs] of runs) {
    if (target !== null && !knobs) { log({ step: 'run', target, skipped: 'no knob setting passed the delivered-context gate on the tuning sample' }); failures++; continue; }
    const spec = devSpec(t, target, target === null ? Object.fromEntries(Object.entries(knobs!).filter(([, v]) => v !== null)) : knobs!, target === null ? 40 : Math.max(10, Math.ceil(target / 1000) * 3));
    if (target === null && t.provider === 'gbrain') Object.assign(spec.provider_config!, { token_budget: null, return_unit: null, limit: null });
    const path = join(SPEC_DIR, `${name}-${target ?? 'default'}.json`);
    writeFileSync(path, JSON.stringify(spec, null, 2) + '\n');
    const r = launch(['run', path], passthrough);
    const already = r.err.includes('already has');
    const res = already ? launch(['resume', path], passthrough) : r;
    const summaryLine = res.out.split('\n').find(l => l.startsWith('{"cell_id"')) ?? res.err.split('\n').find(l => l.startsWith('{"cell_id"'));
    log({ step: 'run', target, code: res.code, cell: cellIdFrom(res.err), summary: summaryLine ? JSON.parse(summaryLine) : null, tail: res.code ? res.err.split('\n').slice(-4).join(' | ') : undefined });
    if (res.code !== 0) failures++;
  }
  return failures ? 3 : 0;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const dd = argv.indexOf('--');
  const own = dd >= 0 ? argv.slice(0, dd) : argv;
  const passthrough = dd >= 0 ? argv.slice(dd + 1) : [];
  const flag = (n: string) => { const i = own.indexOf(n); return i >= 0 ? own[i + 1] : undefined; };
  if (own[0] !== 'sweep') { console.error('usage: bun eval/runner/harness-dev.ts sweep --provider P --dataset D --split S (--units a,b | --question-ids-file f) --base JSON [...] -- <harness:cell flags>'); process.exit(2); }
  const qfile = flag('--question-ids-file');
  const t: Track = {
    provider: flag('--provider') as Track['provider'], dataset: flag('--dataset')!, split: flag('--split')!,
    units: flag('--units')?.split(','), questionIds: qfile ? JSON.parse(readFileSync(qfile, 'utf8')) : undefined,
    lane: (flag('--lane') ?? 'raw') as CellSpec['lane'], mode: (flag('--mode') ?? 'rag') as CellSpec['mode'],
    base: JSON.parse(flag('--base') ?? '{}'), extra: JSON.parse(flag('--extra') ?? '{}'),
    targets: (flag('--targets') ?? '4000,8000,16000,32000').split(',').filter(Boolean).map(Number),
    sample: Number(flag('--sample') ?? 60), runDefault: !own.includes('--no-default'),
    gbrainCredentials: flag('--gbrain-credentials')?.split(','), answer: flag('--answer'), name: flag('--name'),
  };
  process.exit(await sweep(t, passthrough));
}

export { existsSync, readdirSync };
