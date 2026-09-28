#!/usr/bin/env bun
/**
 * Run the Bun suite as N concurrent `bun test --shard=i/N` processes.
 *
 * Each shard is an ordinary single-process `bun test` run, so tests keep the
 * serial runner's semantics. We avoid `bun test --parallel`: in its worker
 * mode, a test that calls `Bun.spawnSync` intermittently hung for the whole
 * job (seen in 2 of 4 full runs on Bun 1.3.14), while sharded processes did not.
 *
 * Usage: bun scripts/test-shards.ts [paths...]   (default: test/eval/ eval/)
 * TEST_SHARDS sets the shard count (default: min(4, CPU count)).
 */
import { cpus } from 'node:os';

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

async function runShard(shard: number, shards: number, paths: string[]): Promise<ShardResult> {
  const proc = Bun.spawn([process.execPath, 'test', `--shard=${shard}/${shards}`, ...paths], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { shard, code, output: stdout + stderr };
}

if (import.meta.main) {
  const shards = Number(process.env.TEST_SHARDS ?? Math.min(4, cpus().length));
  const paths = process.argv.length > 2 ? process.argv.slice(2) : ['test/eval/', 'eval/'];
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: shards }, (_, i) => runShard(i + 1, shards, paths)));
  for (const r of results) process.stdout.write(`\n===== shard ${r.shard}/${shards} (exit ${r.code}) =====\n${r.output}`);
  const summary = summarize(results);
  console.log(`\n${shards} shards: ${summary.pass} pass, ${summary.skip} skip, ${summary.fail} fail in ${Math.round((Date.now() - started) / 1000)}s`);
  if (summary.failedShards.length) {
    console.error(`failing shards: ${summary.failedShards.join(', ')}`);
    process.exit(1);
  }
}
