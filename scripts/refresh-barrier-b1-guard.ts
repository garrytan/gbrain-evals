/**
 * Runs one command, normally the refresh-barrier B1 check, under the idle-machine guard of the refresh write barrier
 * preregistration's Amendment 5, and writes guard.json and samples.jsonl to --out.
 *
 *   bun scripts/refresh-barrier-b1-guard.ts --out <dir> [--max-wait-min 60] -- <command...>
 *
 * Start: polls /proc/loadavg every 10 s, for up to --max-wait-min minutes, until the 1-, 5- and 15-minute load averages
 * are all below 0.5; otherwise it exits 3 without running the command.
 * Each second while the command runs, it records /proc/loadavg and counts foreign runnable tasks. The command's process
 * tree is the process this script spawns plus every process whose chain of parents (field 4 of /proc/<pid>/stat) reaches
 * it. A foreign runnable task is a thread (/proc/<pid>/task/<tid>/stat) in state R whose process <pid> is neither in that
 * tree nor this script's own process. Kernel threads count as foreign.
 * A sample's arm is 'on' while a process of the tree runs the switch probe (`bun -e`) or a Cat 18 or Cat 26 runner with
 * GBRAIN_REFRESH_BARRIER=1 in its environment, 'off' while one runs without it, and null otherwise. An environment is
 * checked only for that one entry, and nothing from it is recorded.
 * An arm's load before and after is the sample just before its first sample and just after its last (the start check's
 * reading when the arm opens the run, the reading at exit when it closes it). The run is valid
 * when the start check passed and neither arm, from its first sample to its last, has foreign runnable tasks in 3 or
 * more consecutive samples.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

type Arm = 'off' | 'on' | null;
interface Sample { t: string; load: number[]; arm: Arm; foreign: number; foreign_comm: string[] }

const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
const opt = (k: string) => { const i = argv.indexOf(k); return i >= 0 && (dash < 0 || i < dash) ? argv[i + 1] : undefined; };
const command = dash >= 0 ? argv.slice(dash + 1) : [];
const outArg = opt('--out');
if (!outArg || command.length === 0) { console.error('usage: bun scripts/refresh-barrier-b1-guard.ts --out <dir> [--max-wait-min 60] -- <command...>'); process.exit(2); }
const out = resolve(outArg);
const maxWaitMs = Number(opt('--max-wait-min') ?? 60) * 60_000;
const IDLE_MAX = 0.5;
const CONSECUTIVE_LIMIT = 3;
mkdirSync(out, { recursive: true });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const loadavg = () => readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).map(Number);
const read = (p: string) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const pids = () => readdirSync('/proc').filter(d => /^\d+$/.test(d)).map(Number).sort((a, b) => a - b);
const statFields = (s: string) => { const close = s.lastIndexOf(')'); return { comm: s.slice(s.indexOf('(') + 1, close), rest: s.slice(close + 2).split(' ') }; };

function tree(root: number): Set<number> {
  const children = new Map<number, number[]>();
  for (const pid of pids()) {
    const s = read(`/proc/${pid}/stat`);
    if (!s) continue;
    const ppid = Number(statFields(s).rest[1]);
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const inTree = new Set<number>([root]);
  const queue = [root];
  while (queue.length) for (const c of children.get(queue.pop()!) ?? []) if (!inTree.has(c)) { inTree.add(c); queue.push(c); }
  return inTree;
}

function armOf(inTree: Set<number>): Arm {
  let arm: Arm = null;
  for (const pid of inTree) {
    const args = (read(`/proc/${pid}/cmdline`) ?? '').split('\0');
    const probe = args.includes('-e');
    const runner = args.some(a => a.endsWith('cat18-embedding-providers.ts') || a.endsWith('cat26-contextual-retrieval.ts'));
    if (!probe && !runner) continue;
    const on = (read(`/proc/${pid}/environ`) ?? '').split('\0').includes('GBRAIN_REFRESH_BARRIER=1');
    if (on) return 'on';
    arm = 'off';
  }
  return arm;
}

function foreignRunnable(inTree: Set<number>): string[] {
  const found: string[] = [];
  for (const pid of pids()) {
    if (pid === process.pid || inTree.has(pid)) continue;
    let tids: string[] = [];
    try { tids = readdirSync(`/proc/${pid}/task`).sort(); } catch { continue; }
    for (const tid of tids) {
      const s = read(`/proc/${pid}/task/${tid}/stat`);
      if (!s) continue;
      const f = statFields(s);
      if (f.rest[0] === 'R') found.push(`${f.comm}[${pid}]`);
    }
  }
  return found;
}

const waitStart = Date.now();
let startLoad = loadavg();
while (!startLoad.every(x => x < IDLE_MAX) && Date.now() - waitStart < maxWaitMs) { await sleep(10_000); startLoad = loadavg(); }
const idle = startLoad.every(x => x < IDLE_MAX);
const idleCheck = { load: startLoad, waited_s: Math.round((Date.now() - waitStart) / 1000), threshold: IDLE_MAX, pass: idle };
if (!idle) {
  writeFileSync(join(out, 'guard.json'), JSON.stringify({ command, idle_check: idleCheck, valid: false, reasons: ['machine not idle within the wait'] }, null, 2) + '\n');
  console.error('[b1-guard] load averages did not all fall below 0.5; command not run');
  process.exit(3);
}

const child = spawn(command[0]!, command.slice(1), { stdio: 'inherit' });
const root = child.pid!;
let exitCode: number | null = null;
const done = new Promise<void>(r => child.on('exit', code => { exitCode = code; r(); }));
let finished = false;
done.then(() => { finished = true; });
const samples: Sample[] = [];
const samplesPath = join(out, 'samples.jsonl');
writeFileSync(samplesPath, '');
while (!finished) {
  const inTree = tree(root);
  const comm = foreignRunnable(inTree);
  const s: Sample = { t: new Date().toISOString(), load: loadavg(), arm: armOf(inTree), foreign: comm.length, foreign_comm: comm };
  samples.push(s);
  appendFileSync(samplesPath, JSON.stringify(s) + '\n');
  await Promise.race([done, sleep(1000)]);
}
const after = { t: new Date().toISOString(), load: loadavg() };

const arms = Object.fromEntries((['off', 'on'] as const).map(arm => {
  const first = samples.findIndex(s => s.arm === arm);
  const last = samples.map(s => s.arm).lastIndexOf(arm);
  if (first < 0) return [arm, { seen: false }];
  const span = samples.slice(first, last + 1);
  let run = 0, maxRun = 0;
  for (const s of span) { run = s.foreign > 0 ? run + 1 : 0; maxRun = Math.max(maxRun, run); }
  const before = first > 0 ? { t: samples[first - 1]!.t, load: samples[first - 1]!.load } : { t: null, load: startLoad };
  const afterArm = last + 1 < samples.length ? { t: samples[last + 1]!.t, load: samples[last + 1]!.load } : after;
  return [arm, { seen: true, before, after: afterArm, samples: span.length, foreign_samples: span.filter(s => s.foreign > 0).length,
    max_consecutive_foreign: maxRun, foreign_comm: [...new Set(span.flatMap(s => s.foreign_comm))].slice(0, 20) }];
}));
const reasons = [
  ...(['off', 'on'] as const).filter(a => !(arms[a] as { seen: boolean }).seen).map(a => `no ${a}-arm sample`),
  ...(['off', 'on'] as const).filter(a => ((arms[a] as { max_consecutive_foreign?: number }).max_consecutive_foreign ?? 0) >= CONSECUTIVE_LIMIT)
    .map(a => `foreign runnable tasks in ${CONSECUTIVE_LIMIT} or more consecutive samples during the ${a} arm`),
];
const guard = { command, idle_check: idleCheck, exit_code: exitCode, samples: samples.length, arms, consecutive_limit: CONSECUTIVE_LIMIT, valid: reasons.length === 0, reasons };
writeFileSync(join(out, 'guard.json'), JSON.stringify(guard, null, 2) + '\n');
console.error(`[b1-guard] valid=${guard.valid}${reasons.length ? ' (' + reasons.join('; ') + ')' : ''}`);
process.exit(exitCode ?? 1);
