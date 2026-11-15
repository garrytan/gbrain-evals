#!/usr/bin/env bun
/**
 * Write test/timings.json, the per-file test times that `bun test --shard --timings` uses to split the suite by time
 * instead of by file count, in CI's shard jobs and in scripts/test-shards.ts.
 *
 * Refresh it from main's CI runs when a shard job nears 10 minutes. Each run's shards upload their JUnit reports as
 * tested-files-<n>; download one directory per run and pass them all, and each file gets its median time across the
 * runs, which damps runner-to-runner noise:
 *
 *   gh run download <run id> -R garrytan/gbrain-evals -p 'tested-files-*' -D <dir>
 *   bun scripts/test-timings.ts <dir> [<dir>...]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Timings { version: 1; files: Record<string, number> }

/** Each test file's time in ms from one Bun JUnit report: the time of its top-level <testsuite>, not its describes. */
export function fileTimes(xml: string): Record<string, number> {
  const times: Record<string, number> = {};
  let depth = 0;
  for (const m of xml.matchAll(/<(\/?)testsuite\b([^>]*?)(\/?)>/g)) {
    if (m[1]) { depth--; continue; }
    if (depth === 0) {
      const file = /\sfile="([^"]*)"/.exec(m[2]!)?.[1];
      const seconds = Number(/\stime="([^"]*)"/.exec(m[2]!)?.[1]);
      if (!file || !Number.isFinite(seconds)) throw new Error(`a top-level <testsuite> has no file or time: ${m[0]}`);
      times[file] = Math.round(seconds * 1000);
    }
    if (!m[3]) depth++;
  }
  return times;
}

/** One map of file times per CI run in, each file's median time across the runs that ran it out, files sorted. */
export function medianTimings(runs: Array<Record<string, number>>): Timings {
  const seen: Record<string, number[]> = {};
  for (const run of runs) for (const [file, ms] of Object.entries(run)) (seen[file] ??= []).push(ms);
  const files: Record<string, number> = {};
  for (const file of Object.keys(seen).sort()) {
    const s = seen[file]!.sort((a, b) => a - b);
    const mid = s.length >> 1;
    files[file] = s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
  }
  return { version: 1, files };
}

if (import.meta.main) {
  const dirs = process.argv.slice(2);
  if (!dirs.length) {
    console.error('usage: bun scripts/test-timings.ts <junit dir> [<junit dir>...]   (one directory per CI run)');
    process.exit(2);
  }
  const runs = dirs.map(dir => {
    const reports = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(f => f.endsWith('.xml')).sort();
    if (!reports.length) throw new Error(`${dir} holds no JUnit reports`);
    return Object.assign({}, ...reports.map(f => fileTimes(readFileSync(join(dir, f), 'utf8')))) as Record<string, number>;
  });
  const timings = medianTimings(runs);
  writeFileSync(join(import.meta.dir, '..', 'test', 'timings.json'), `${JSON.stringify(timings, null, 2)}\n`);
  const total = Object.values(timings.files).reduce((a, b) => a + b, 0);
  console.log(`test/timings.json: ${Object.keys(timings.files).length} files, ${Math.round(total / 1000)} s in all, from ${runs.length} run(s)`);
}
