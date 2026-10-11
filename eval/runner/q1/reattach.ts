#!/usr/bin/env bun
/**
 * Reattach a Q1 campaign's launched leases to their VMs after the launching
 * host lost its ubi-runner sessions (a host restart or sleep).
 *
 * The cell keeps running on its VM when the SSH session drops, but nobody pulls
 * its checkpoints, settles its lease or destroys its VM, and a VM that was
 * still in setup never starts its cell. This watcher does those steps from the
 * campaign's own lease events, so the launching host only needs to be awake
 * for pulls, never for the whole cell:
 *
 *   setup still running         wait
 *   setup ended, cell never ran start `setup && cell` detached on the VM (setsid, so it survives the next drop)
 *   cell running                pull checkpoint/ and realization/ every interval and record the realization
 *   any running cell            every interval, even while its launcher holds the session: the metering proxy's
 *                               status, a snapshot of its lease ledger and the system's receipt count go to
 *                               <results>/progress/, so a lost VM still leaves measured spend (A18)
 *   cell ended with a summary   pull its output, record the realization, settle the lease, destroy the VM
 *   cell ended with no summary  pull what is there and report `crashed`; the VM stays for inspection
 *   VM unreachable              report `lost` (resume or abandon is the operator's call)
 *
 * It never reserves, launches or abandons a lease, and it lives outside the
 * campaign's hashed tree.
 *
 *   bun eval/runner/q1/reattach.ts --campaign <manifest.json> --state <dir> [--once] [--interval-min 10] [--hours 5.8]
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { Campaign, resolveRunner, type LeaseState } from '../shootout-cell.ts';
const REPO_ROOT = resolve(import.meta.dir, '../../..');

type Phase = 'setup' | 'started' | 'running' | 'settled' | 'crashed' | 'lost' | 'waiting';

const argv = process.argv.slice(2);
const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const manifest = one('--campaign'), state = one('--state');
if (!manifest || !state) { console.error('usage: reattach.ts --campaign <manifest.json> --state <dir> [--once] [--interval-min 10] [--hours 5.8]'); process.exit(2); }
const intervalMs = Number(one('--interval-min') ?? 10) * 60_000;
const deadline = Date.now() + Number(one('--hours') ?? 5.8) * 3_600_000;
const runner = resolveRunner();
const remoteRoot = `work/${basename(REPO_ROOT)}`;

const ubi = (...args: string[]) => {
  const p = Bun.spawnSync(['bash', runner, ...args], { stdout: 'pipe', stderr: 'pipe', env: process.env, timeout: (args[0] === 'pull' ? 1800 : 120) * 1000 });
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
};

const probe = (vm: string, out: string) => ubi('ssh', vm, [
  `[ -d ${remoteRoot} ] || { echo nodir; exit 0; }; cd ~`,
  `s=0; pgrep -f '[b]ootstrap.sh setup' >/dev/null && s=1`,
  `r=0; pgrep -f '[s]hootout-cell.ts remote' >/dev/null && r=1`,
  `l=0; [ -f ${out}/lease-summary.json ] && l=1`,
  `o=0; [ -d ${out} ] && o=1`,
  `m=0; [ -f ~/.q1-reattach-started ] && m=1`,
  `echo "state $s $r $l $o $m"`,
].join('; '));

const lastPull = new Map<string, number>();
const lastProgress = new Map<string, number>();

/** The proxy's live status, a consistent copy of its lease ledger (VACUUM INTO) and the system's receipt count, pulled into <results>/progress. */
function pullProgress(l: LeaseState, vm: string, resultsDir: string) {
  if (Date.now() - (lastProgress.get(l.lease_id) ?? 0) < intervalMs) return;
  lastProgress.set(l.lease_id, Date.now());
  const dir = `q1-progress/${l.lease_id}`;
  const db = `$(ls -d ~/custody/${l.lease_id}/proxy/lease.sqlite ~/work/*/eval/reports/shootout/*/${l.lease_id}/lease.sqlite ~/custody/out/*/${l.lease_id}/lease.sqlite 2>/dev/null | head -1)`;
  ubi('ssh', vm, [
    `mkdir -p ~/${dir}`,
    `curl -s --max-time 10 http://127.0.0.1:8787/__proxy/status > ~/${dir}/proxy-status.json || true`,
    `n=0; for f in /var/lib/docker/volumes/*/_data/logs/receipts.ndjson; do [ -e "$f" ] && n=$((n + $(sudo wc -l < "$f"))); done; echo $n > ~/${dir}/receipts.txt`,
    `d=${db}; rm -f ~/${dir}/lease.sqlite; [ -n "$d" ] && bun -e "const { Database } = require('bun:sqlite'); new Database(process.argv[1], { readonly: true }).exec(\"VACUUM INTO '\" + process.argv[2] + \"'\")" "$d" ~/${dir}/lease.sqlite || true`,
  ].join('; '));
  const out = join(resultsDir, 'progress');
  mkdirSync(out, { recursive: true });
  if (ubi('pull', vm, dir, out).code !== 0) return;
  const here = join(out, l.lease_id);
  let status: Record<string, unknown> = {};
  try { status = JSON.parse(readFileSync(join(here, 'proxy-status.json'), 'utf8')); } catch { /* proxy not up yet */ }
  const receipts = existsSync(join(here, 'receipts.txt')) ? Number(readFileSync(join(here, 'receipts.txt'), 'utf8').trim()) : null;
  appendFileSync(join(out, 'progress.ndjson'), JSON.stringify({ at: new Date().toISOString(), lease_id: l.lease_id, committed_usd: status.committed_usd ?? null, forwarded: status.forwarded ?? null, refused: status.refused ?? null, receipts }) + '\n');
}
const misses = new Map<string, number>();
const final = new Map<string, Phase>();

function pullParts(c: Campaign, l: LeaseState, vm: string) {
  for (const part of ['checkpoint', 'realization']) ubi('pull', vm, `${c.remotePath(l)}/${part}`, c.resultsDir(l));
  c.recordRealization(l.lease_id);
  lastPull.set(l.lease_id, Date.now());
}

/** A launcher on this host still holds the lease's VM session: it pulls, settles and tears down itself, so reattach stays out. */
const launcherAlive = (vm: string) => Bun.spawnSync(['pgrep', '-f', `ubi-runner.sh run .*-n ${vm}`]).exitCode === 0;

function step(c: Campaign, l: LeaseState): Phase {
  const vm = l.vm;
  if (!vm) return 'lost';
  if (launcherAlive(vm)) { pullProgress(l, vm, c.resultsDir(l)); return 'running'; }
  const out = c.remotePath(l);
  const p = probe(vm, out);
  const m = p.out.match(/state (\d) (\d) (\d) (\d) (\d)/);
  if (p.code !== 0 || !m) {
    const n = (misses.get(l.lease_id) ?? 0) + 1;
    misses.set(l.lease_id, n);
    return n >= 3 ? 'lost' : 'waiting';
  }
  misses.delete(l.lease_id);
  const [setup, running, summary, outDir, started] = m.slice(1).map(x => x === '1');
  if (setup) return 'setup';
  if (running) {
    pullProgress(l, vm, c.resultsDir(l));
    if (Date.now() - (lastPull.get(l.lease_id) ?? 0) >= intervalMs) pullParts(c, l, vm);
    return 'running';
  }
  if (summary) {
    ubi('pull', vm, out, dirname(c.resultsDir(l)));
    c.recordRealization(l.lease_id);
    if (!existsSync(join(c.resultsDir(l), 'lease-summary.json'))) return 'waiting';
    c.settle(l.lease_id);
    const down = ubi('down', vm);
    if (down.code !== 0) console.error(`[reattach] ${l.lease_id}: settled, but destroying ${vm} failed: ${down.err.slice(-200)}`);
    return 'settled';
  }
  if (!outDir && !started) {
    const launched = readFileSync(join(state!, 'leases.ndjson'), 'utf8').split('\n').filter(Boolean).map(x => JSON.parse(x) as { event: string; lease_id: string; argv?: string[] })
      .filter(e => e.event === 'launched' && e.lease_id === l.lease_id).at(-1);
    const cmd = launched?.argv?.at(-1);
    if (!cmd) return 'lost';
    const inner = `sudo chown -R ubi:ubi ~/.docker 2>/dev/null; bash -l ~/.ubirun-setup.sh && ${cmd}`;
    ubi('ssh', vm, `cd ${remoteRoot} && . ~/.ubirun-env && touch ~/.q1-reattach-started && (setsid nohup bash -lc ${JSON.stringify(inner)} > ~/q1-cell.log 2>&1 < /dev/null &) ; echo started`);
    return 'started';
  }
  pullParts(c, l, vm);
  return 'crashed';
}

for (;;) {
  const c = new Campaign(manifest, state);
  const open = c.leases().filter(l => l.status === 'launched' && !final.has(l.lease_id));
  const report: Record<string, Phase> = {};
  for (const l of open) {
    let ph: Phase;
    try { ph = step(c, l); } catch (e) { console.error(`[reattach] ${l.lease_id}: ${(e as Error).message}`); ph = 'waiting'; }
    report[l.cell] = ph;
    if (ph === 'settled' || ph === 'crashed' || ph === 'lost') final.set(l.lease_id, ph);
  }
  for (const [id, ph] of final) report[c.lease(id).cell] = ph;
  const line = { at: new Date().toISOString(), ...report };
  console.log(JSON.stringify(line));
  writeFileSync(join(state, 'reattach.json'), JSON.stringify(line, null, 2) + '\n');
  const pending = c.leases().filter(l => l.status === 'launched' && !final.has(l.lease_id)).length;
  if (argv.includes('--once') || !pending || Date.now() + 60_000 > deadline) break;
  await Bun.sleep(Math.min(120_000, Math.max(0, deadline - Date.now())));
}
