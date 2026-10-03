/**
 * Cat 40 latency comparator (plan 2026-10-03, Item 1 latency check).
 *
 * Harness tool latency is only meaningful when the runner itself does not
 * stall. This replays `search` and `query` calls sampled from a Cat 40 run's
 * own transcripts against the same gbrain build and world, at the harness's
 * concurrency (one agent per slot, every slot in parallel), outside the agent
 * loop, and compares p50s:
 *
 *   pass  harness p50 <= 2x replay p50 for both search and query, and the
 *         harness run's event-loop lag p99 < 50 ms (from its receipt).
 *
 * The replay's own provider calls (query embeddings, reranks) go through the
 * metering proxy and the paid-request guard, so it needs --budget-usd (about
 * $1 of embeddings for 40 calls). It needs the run's slot snapshots
 * (cat40-model-ladder.ts --build-slots) and refuses without them.
 *
 *   bun eval/runner/cat40/latency-replay.ts --run eval/reports/cat40/followups-dev1 --label gbrain-c12-dev \
 *     --gbrain-repo ../gbrain --gbrain-ref <ref> --slot-ref ad7900d --slots 5 --calls 40 \
 *     --budget-usd 1 --budget-ledger .budget/cat40-followups.sqlite --out eval/reports/cat40/followups-latency
 *
 * Writes <out>/verdict.json and a receipt.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { budgetOptionsFrom, receiptCost, startPaidRun } from '../budget-ledger.ts';
import { DEFAULT_LADDER_DIR, worldDigest, type LadderWorld } from '../../generators/model-ladder-gen.ts';
import { prepareBuild } from '../lifecycle/builds.ts';
import { GbrainSlot, MeteringProxy } from './gbrain-arm.ts';
import { missingSlotSnapshots, slotRoot } from '../cat40-model-ladder.ts';

export const REPLAY_TOOLS = ['search', 'query'] as const;
export interface ReplayCall { name: string; args: Record<string, unknown> }

/** Every 10th search/query call of the first 400 the label's cells made, up to `n` (the 2026-10-03 replay's rule). */
export function sampleReplayCalls(transcriptLines: string[], label: string, n = 40): ReplayCall[] {
  const calls: ReplayCall[] = [];
  for (const line of transcriptLines) {
    if (!line.trim() || !line.includes(`|${label}|`)) continue;
    for (const t of JSON.parse(line).tools as Array<ReplayCall & { result?: string }>) {
      if ((REPLAY_TOOLS as readonly string[]).includes(t.name) && calls.length < n * 10) calls.push({ name: t.name, args: t.args });
    }
  }
  return calls.filter((_, i) => i % 10 === 0).slice(0, n);
}

/**
 * Replay calls with one worker per slot, all slots in parallel (the harness
 * runs one agent per slot at a time). Worker i takes calls i, i+k, i+2k, ...
 */
export async function replayParallel<W>(calls: ReplayCall[], workers: W[], fn: (worker: W, call: ReplayCall) => Promise<void>): Promise<Array<ReplayCall & { ms: number; worker: number }>> {
  const timed: Array<ReplayCall & { ms: number; worker: number }> = [];
  await Promise.all(workers.map(async (w, i) => {
    for (let j = i; j < calls.length; j += workers.length) {
      const t = performance.now();
      await fn(w, calls[j]);
      timed.push({ ...calls[j], ms: performance.now() - t, worker: i });
    }
  }));
  return timed;
}

const p50 = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[(s.length - 1) >> 1] : NaN; };

/** Harness tool-call milliseconds by tool name, from a run's results.jsonl (both sessions). */
export function harnessToolMs(resultLines: string[], label: string): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const line of resultLines) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (r.arm !== label) continue;
    for (const t of [...(r.session1?.tool_calls ?? []), ...r.run.tool_calls]) (out[t.name] ??= []).push(t.ms);
  }
  return out;
}

export interface LatencyVerdict {
  pass: boolean;
  tools: Record<string, { harness_p50_ms: number; replay_p50_ms: number; ratio: number; pass: boolean; harness_calls: number; replay_calls: number }>;
  harness_lag_p99_ms: number | null;
  lag_pass: boolean;
  reasons: string[];
}

export function latencyVerdict(harness: Record<string, number[]>, replay: Array<{ name: string; ms: number }>, harnessLagP99: number | null): LatencyVerdict {
  const tools: LatencyVerdict['tools'] = {};
  const reasons: string[] = [];
  for (const name of REPLAY_TOOLS) {
    const h = harness[name] ?? [], r = replay.filter(x => x.name === name).map(x => x.ms);
    if (!h.length || !r.length) { reasons.push(`${name}: no ${h.length ? 'replay' : 'harness'} calls to compare`); continue; }
    const ratio = p50(h) / p50(r);
    tools[name] = { harness_p50_ms: Math.round(p50(h)), replay_p50_ms: Math.round(p50(r)), ratio: Number(ratio.toFixed(2)), pass: ratio <= 2, harness_calls: h.length, replay_calls: r.length };
    if (ratio > 2) reasons.push(`${name}: harness p50 ${Math.round(p50(h))} ms is ${ratio.toFixed(1)}x the replay's ${Math.round(p50(r))} ms`);
  }
  const lagPass = harnessLagP99 !== null && harnessLagP99 < 50;
  if (!lagPass) reasons.push(harnessLagP99 === null ? 'the harness receipt has no event-loop lag measurement' : `harness event-loop lag p99 ${harnessLagP99} ms is 50 ms or more`);
  const pass = lagPass && REPLAY_TOOLS.every(n => tools[n]?.pass);
  return { pass, tools, harness_lag_p99_ms: harnessLagP99, lag_pass: lagPass, reasons };
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv = process.argv.slice(2)) {
  const runDir = resolve(flag(argv, '--run') ?? '');
  const label = flag(argv, '--label');
  if (!flag(argv, '--run') || !label) throw new Error('--run <cat40 --out dir> and --label <gbrain label> are required');
  const out = resolve(flag(argv, '--out') ?? join(runDir, 'latency-replay'));
  mkdirSync(out, { recursive: true });
  const worldPath = resolve(flag(argv, '--world') ?? join(DEFAULT_LADDER_DIR, 'world.json'));
  const world: LadderWorld = JSON.parse(readFileSync(worldPath, 'utf8'));
  const analyze = !argv.includes('--no-pglite-analyze');
  const nSlots = Number(flag(argv, '--slots') ?? 5);
  const repo = resolve(flag(argv, '--gbrain-repo') ?? '../gbrain');
  const root = resolve(flag(argv, '--gbrain-root') ?? join(process.env.HOME ?? '.', '.capy/work/cat40/gbrain'));
  const rev = (ref: string) => execFileSync('git', ['-C', repo, 'rev-parse', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
  const commit = rev(flag(argv, '--gbrain-ref') ?? 'HEAD');
  const slotCommit = flag(argv, '--slot-ref') ? rev(flag(argv, '--slot-ref')!) : commit;
  const slotDir = slotRoot(root, slotCommit, world, analyze);
  const missing = missingSlotSnapshots(slotDir, nSlots);
  if (missing.length) throw new Error(`slot snapshots missing (${missing.join(', ')}); build them with cat40-model-ladder.ts --build-slots first`);

  const calls = sampleReplayCalls(readFileSync(join(runDir, 'transcripts.jsonl'), 'utf8').split('\n'), label, Number(flag(argv, '--calls') ?? 40));
  if (!calls.length) throw new Error(`no ${REPLAY_TOOLS.join('/')} calls for ${label} in ${runDir}/transcripts.jsonl (was the run started with --transcripts?)`);
  const harness = harnessToolMs(readFileSync(join(runDir, 'results.jsonl'), 'utf8').split('\n'), label);
  const receipts = readdirSync(runDir).filter(f => /^receipt-\d+\.json$/.test(f)).sort();
  const lags = receipts.map(f => JSON.parse(readFileSync(join(runDir, f), 'utf8')).cost?.event_loop_lag_ms?.p99).filter((x): x is number => typeof x === 'number');
  const harnessLagP99 = lags.length ? Math.max(...lags) : null;

  const log = (s: string) => process.stderr.write(`[latency-replay] ${s}\n`);
  const { run, guard } = startPaidRun('cat40-latency-replay', { ...budgetOptionsFrom(argv), estimateUsd: 1, log });
  const proxy = new MeteringProxy();
  let timed: Awaited<ReturnType<typeof replayParallel>> = [];
  const slots: GbrainSlot[] = [];
  let summary;
  try {
    const build = prepareBuild(repo, { label: 'under-test', ref: commit, description: 'gbrain under test' }, join(root, 'builds'));
    proxy.start();
    for (let i = 0; i < nSlots; i++) { const s = new GbrainSlot(`slot${i}`, slotDir, build.dir, proxy.port, flag(argv, '--surface') ?? 'starter'); await s.restore(); slots.push(s); }
    log(`replaying ${calls.length} calls on ${nSlots} slots, one worker per slot`);
    timed = await replayParallel(calls, slots, async (s, c) => { await s.client!.call(c.name, c.args); });
  } finally {
    await Promise.all(slots.map(s => s.stop()));
    proxy.stop();
    summary = run.close();
    guard.uninstall();
  }
  const verdict = latencyVerdict(harness, timed, harnessLagP99);
  const record = { schema: 'cat40-latency-replay-v1', run: runDir, label, gbrain_commit: commit, slot_commit: slotCommit, world_digest: worldDigest(world), slots: nSlots,
    concurrency: 'one worker per slot, all slots in parallel', harness_receipts: receipts, verdict, calls: timed, cost: receiptCost(summary), finished_at: new Date().toISOString() };
  writeFileSync(join(out, 'verdict.json'), JSON.stringify(record, null, 2) + '\n');
  log(`${verdict.pass ? 'PASS' : 'FAIL'}: ${JSON.stringify(verdict.tools)}${verdict.reasons.length ? `; ${verdict.reasons.join('; ')}` : ''}`);
  if (!verdict.pass) process.exitCode = 1;
  return record;
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(1); });
}
