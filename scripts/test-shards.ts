#!/usr/bin/env bun
/**
 * Run the Bun suite as concurrent `bun test --shard=i/N` processes.
 *
 * Each shard is an ordinary single-process `bun test` run, so tests keep the
 * serial runner's semantics. We avoid `bun test --parallel`: in its worker
 * mode, a test that calls `Bun.spawnSync` intermittently hung for the whole
 * job (seen in 2 of 4 full runs on Bun 1.3.14), while sharded processes did not.
 *
 * Usage: bun scripts/test-shards.ts [--job=k/n] [--junit-dir=<dir>] [paths...]   (default paths: test/eval/ eval/)
 * TEST_SHARDS sets how many processes run at once (default: min(4, CPU count)). Alone, they are the whole suite in
 * TEST_SHARDS shards. With --job=k/n, as CI's n shard jobs run it, job k runs its TEST_SHARDS processes as shards
 * k, k+n, k+2n, ... of n*TEST_SHARDS, so the n jobs together run every shard exactly once. --junit-dir writes each
 * shard's JUnit report there as tests-<shard>.xml, for CI's tested-tree job, and fails a shard whose report is
 * missing, since Bun exits 0 when it cannot write one. With --job, each line prints as it
 * arrives, led by its shard's number, so a shard that hangs still shows where; otherwise each shard prints whole at the end. Shards split the files by the CI times in
 * test/timings.json (scripts/test-timings.ts), and the script runs from the repository root, where Bun resolves that
 * file's relative paths.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';

export interface ShardResult { shard: number; code: number; output: string }
export interface SuiteSummary { pass: number; fail: number; skip: number; failedShards: number[] }

export function summarize(results: ShardResult[]): SuiteSummary {
  const total = { pass: 0, fail: 0, skip: 0, failedShards: [] as number[] };
  for (const r of results) {
    for (const key of ['pass', 'fail', 'skip'] as const) {
      const match = new RegExp(`^\\s*(\\d+) ${key}$`, 'm').exec(r.output);
      if (match) total[key] += Number(match[1]);
    }
    if (r.code !== 0) total.failedShards.push(r.shard);
  }
  return total;
}

/** The shards job k of n runs with `procs` processes: k, k+n, ... of n*procs. */
export function jobShards(job: number, jobs: number, procs: number): { shards: number[]; of: number } {
  if (!(Number.isInteger(job) && Number.isInteger(jobs) && Number.isInteger(procs) && jobs >= 1 && procs >= 1 && job >= 1 && job <= jobs)) {
    throw new Error(`bad shard job ${job}/${jobs} with ${procs} processes`);
  }
  return { shards: Array.from({ length: procs }, (_, i) => job + i * jobs), of: jobs * procs };
}

async function runShard(shard: number, shards: number, paths: string[], junitDir: string | undefined, live: boolean): Promise<ShardResult> {
  const junit = junitDir ? ['--reporter=junit', `--reporter-outfile=${join(junitDir, `tests-${shard}.xml`)}`] : [];
  const proc = Bun.spawn([process.execPath, 'test', `--shard=${shard}/${shards}`, '--timings=test/timings.json', ...paths, ...junit], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([stream(proc.stdout, shard, live), stream(proc.stderr, shard, live), proc.exited]);
  const report = junitDir && join(junitDir, `tests-${shard}.xml`);
  if (report && !existsSync(report)) return { shard, code: code || 1, output: `${stdout}${stderr}\nno JUnit report at ${report}\n` };
  return { shard, code, output: stdout + stderr };
}

/** Collects a shard's output and, when live, also prints each line as it arrives with the shard's number in front. */
async function stream(from: ReadableStream<Uint8Array>, shard: number, live: boolean): Promise<string> {
  const decoder = new TextDecoder();
  let all = '';
  let partial = '';
  for await (const chunk of from) {
    const text = decoder.decode(chunk, { stream: true });
    all += text;
    if (!live) continue;
    const lines = (partial + text).split('\n');
    partial = lines.pop()!;
    for (const line of lines) process.stdout.write(`[shard ${shard}] ${line}\n`);
  }
  all += decoder.decode();
  if (live && partial) process.stdout.write(`[shard ${shard}] ${partial}\n`);
  return all;
}

if (import.meta.main) {
  const procs = Number(process.env.TEST_SHARDS ?? Math.min(4, cpus().length));
  const args = process.argv.slice(2);
  const flag = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const [job, jobs] = (flag('job') ?? '1/1').split('/').map(Number);
  const junitDir = flag('junit-dir');
  const rest = args.filter(a => !a.startsWith('--job=') && !a.startsWith('--junit-dir='));
  const paths = rest.length ? rest : ['test/eval/', 'eval/'];
  const { shards, of } = jobShards(job!, jobs!, procs);
  if (junitDir) mkdirSync(junitDir, { recursive: true });
  const started = Date.now();
  const live = flag('job') !== undefined;
  const results = await Promise.all(shards.map(s => runShard(s, of, paths, junitDir, live)));
  if (!live) for (const r of results) process.stdout.write(`\n===== shard ${r.shard}/${of} (exit ${r.code}) =====\n${r.output}`);
  const summary = summarize(results);
  console.log(`\n${shards.length} of ${of} shards: ${summary.pass} pass, ${summary.skip} skip, ${summary.fail} fail in ${Math.round((Date.now() - started) / 1000)}s`);
  if (summary.failedShards.length) {
    console.error(`failing shards: ${summary.failedShards.join(', ')}`);
    process.exit(1);
  }
}
