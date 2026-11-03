#!/usr/bin/env bun
/**
 * The tested-tree record that lets gstack carry a green CI run instead of running the suite again
 * (gstack docs/pregate.md#ci-carry, GSTA-258).
 *
 * CI is the one full test run. After the checks job and every test shard pass, the `tested-tree` job in
 * .github/workflows/ci.yml writes tree.json: the run, the tree it tested and every test file it ran.
 * `.gstack/pregate.json` names that job and artifact in `run_profiles`, and `ship_lanes_from` maps each
 * /ship lane command to the inventory below. gstack's pregate and /ship then count a green run at the same
 * clean tree as the lane's result, but only when tree.json lists every file the inventory prints.
 *
 *   bun scripts/ci-tested-tree.ts inventory [--lane test|unit|py]       the test files the lane runs, one per line
 *   bun scripts/ci-tested-tree.ts record --junit <dir> --out <tree.json>  in CI, after the checks job and every shard passed
 *
 * `record` fails, and writes nothing, when an inventory file did not run. Bun's report leaves out a test file that
 * registers no tests, and a run missing one file carries no lane, so the job goes red instead of carry stopping quietly.
 *
 * The Bun files come from each shard's JUnit report, so tree.json lists only files Bun ran, and `tests` counts
 * the Bun tests that ran (skips excluded). The Python files are the ones the checks job runs; the job needs it.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const BUN_TEST_ROOTS = ['test/eval', 'eval'];
export const PYTHON_TESTS = ['test/retrieval_refresh_orchestrator_test.py'];
export const LANES = ['test', 'unit', 'py'] as const;
export type Lane = (typeof LANES)[number];

const SHA = /^[0-9a-f]{40}$/;
const OSES = ['Linux', 'macOS', 'Windows'];

export function isBunTestFile(path: string): boolean {
  return /(?:\.|_)(?:test|spec)\.[cm]?[jt]sx?$/.test(path);
}

/** The test files a lane runs: `unit` is the Bun suite (`bun run test:unit`), `py` the Python tests (`bun run test:py`), `test` both (`bun run test`). */
export function inventory(lane: Lane, tracked: string[]): string[] {
  const bun = tracked.filter(f => BUN_TEST_ROOTS.some(root => f.startsWith(`${root}/`)) && isBunTestFile(f)).sort();
  if (lane === 'unit') return bun;
  if (lane === 'py') return [...PYTHON_TESTS];
  return [...bun, ...PYTHON_TESTS];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTITIES[e]!);
const attr = (tag: string, name: string) => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return m ? unescape(m[1]!) : undefined; };

/** The files a Bun JUnit report ran and how many of its tests ran (skips excluded). */
export function junitFiles(xml: string): { files: string[]; tests: number } {
  const root = /<testsuites\b[^>]*>/.exec(xml)?.[0];
  if (!root) throw new Error('the JUnit report has no <testsuites> element');
  const total = Number(attr(root, 'tests'));
  const skipped = Number(attr(root, 'skipped') ?? '0');
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(skipped) || skipped > total) throw new Error('the JUnit report has no valid tests and skipped counts');
  const files = [...xml.matchAll(/<testsuite\b[^>]*>/g)].map(m => attr(m[0], 'file')).filter((f): f is string => !!f);
  return { files: [...new Set(files)].sort(), tests: total - skipped };
}

/** tree.json for the run in `env`; throws on any missing or malformed input, so a broken record fails the job instead of uploading. */
export function treeRecord(env: Record<string, string | undefined>, o: { reports: Array<{ files: string[]; tests: number }>; tree: string }) {
  const int = (name: string) => { const v = Number(env[name]); if (!Number.isSafeInteger(v) || v < 1) throw new Error(`${name} is not a positive integer`); return v; };
  const sha = env.GITHUB_SHA ?? '';
  const event = env.GITHUB_EVENT_NAME ?? '';
  const head = event === 'pull_request' ? env.PR_HEAD_SHA ?? '' : sha;
  if (!SHA.test(sha) || !SHA.test(head)) throw new Error(`GITHUB_SHA ${JSON.stringify(sha)} or the head ${JSON.stringify(head)} is not a commit sha (PR_HEAD_SHA is required for pull_request)`);
  if (!/^[a-z_]+$/.test(event)) throw new Error(`GITHUB_EVENT_NAME ${JSON.stringify(event)} is not an event name`);
  const workflow = /^[^/]+\/[^/]+\/(\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml)@/.exec(env.GITHUB_WORKFLOW_REF ?? '')?.[1];
  if (!workflow) throw new Error(`GITHUB_WORKFLOW_REF ${JSON.stringify(env.GITHUB_WORKFLOW_REF)} names no workflow file`);
  if (!OSES.includes(env.RUNNER_OS ?? '')) throw new Error(`RUNNER_OS ${JSON.stringify(env.RUNNER_OS)} is not one of ${OSES.join(', ')}`);
  if (!SHA.test(o.tree)) throw new Error(`${JSON.stringify(o.tree)} is not a tree id`);
  if (!o.reports.length) throw new Error('no JUnit report was found');
  const bun = o.reports.flatMap(r => r.files);
  if (!bun.length) throw new Error('the JUnit reports list no test files');
  const files = [...new Set([...bun, ...PYTHON_TESTS])].sort();
  const tests = o.reports.reduce((n, r) => n + r.tests, 0);
  return { run_id: int('GITHUB_RUN_ID'), run_attempt: int('GITHUB_RUN_ATTEMPT'), event, sha, head_sha: head, tree: o.tree, workflow, os: env.RUNNER_OS!, files, tests };
}

function git(args: string[]): string {
  const r = spawnSync('git', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr ?? '').trim()}`);
  return r.stdout;
}

const tracked = () => git(['ls-files', '-z', '--', ...BUN_TEST_ROOTS]).split('\0').filter(Boolean);

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`${name} <value> is required`);
  return v;
}

function record(args: string[]): void {
  const dir = flag(args, '--junit');
  const out = flag(args, '--out');
  if (!dir || !out) throw new Error('record needs --junit <dir> and --out <tree.json>');
  const reports = readdirSync(dir).filter(f => f.endsWith('.xml')).sort().map(f => junitFiles(readFileSync(join(dir, f), 'utf8')));
  const rec = treeRecord(process.env, { reports, tree: git(['rev-parse', '--verify', `${process.env.GITHUB_SHA ?? ''}^{tree}`]).trim() });
  const ran = new Set(rec.files);
  const listed = inventory('test', tracked());
  const missing = listed.filter(f => !ran.has(f));
  const extra = rec.files.filter(f => !listed.includes(f));
  const lines = [`TESTED_TREE: run ${rec.run_id}/${rec.run_attempt} ${rec.event} head ${rec.head_sha.slice(0, 12)} tree ${rec.tree.slice(0, 12)} files=${rec.files.length} tests=${rec.tests} os=${rec.os}`];
  if (missing.length) lines.push(`::error::${missing.length} inventory file(s) did not run, so no /ship lane could carry from this run (a test file must register at least one test; a skipped one counts): ${missing.slice(0, 10).join(', ')}`);
  if (extra.length) lines.push(`::warning::${extra.length} file(s) ran that the inventory does not list: ${extra.slice(0, 10).join(', ')}`);
  for (const line of lines) console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.map(l => l.replace(/^::error::/, 'Error: ').replace(/^::warning::/, 'Warning: ')).join('\n')}\n`);
  if (missing.length) throw new Error(`${missing.length} inventory file(s) did not run; tree.json was not written`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(rec, null, 2)}\n`);
}

if (import.meta.main) {
  const [verb, ...args] = process.argv.slice(2);
  try {
    if (verb === 'inventory') {
      const lane = (flag(args, '--lane') ?? 'test') as Lane;
      if (!LANES.includes(lane)) throw new Error(`--lane is one of ${LANES.join(', ')}`);
      const files = inventory(lane, tracked());
      if (!files.length) throw new Error('the inventory is empty');
      process.stdout.write(`${files.join('\n')}\n`);
    } else if (verb === 'record') record(args);
    else {
      console.error('usage: bun scripts/ci-tested-tree.ts inventory [--lane test|unit|py] | record --junit <dir> --out <tree.json>');
      process.exit(2);
    }
  } catch (e) {
    console.error(`ci-tested-tree: ${(e as Error).message}`);
    process.exit(1);
  }
}
