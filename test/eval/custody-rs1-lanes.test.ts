/**
 * RS1's parallel mint driver (GST-1886, amendment of 2026-11-12): eval/custody/rs1/mint-lanes.ts. Keyless: mint.sh runs
 * in --fake mode or is replaced by a stub script, BEAM is a stub tree, and nothing reaches a provider. The seeds here are
 * test seeds made at run time.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { readBeamPaths } from '../../eval/custody/rs1/beam-paths.ts';

const REPO = resolve(import.meta.dir, '../..');
const RS1 = join(REPO, 'eval/custody/rs1');
const MINT = join(RS1, 'mint.sh');
const LANES = join(RS1, 'mint-lanes.ts');
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const seedLine = (name: string) => ['rs1', 'seed', 'v1'].join('-') + ':' + sha(name);
const words = (seed: string, n: number) => Array.from({ length: n }, (_, i) => 'w' + sha(`${seed}/${i}`).slice(0, 7)).join(' ');

const roots: string[] = [];
const scratch = (name: string) => { const d = mkdtempSync(join(tmpdir(), `rs1-${name}-`)); roots.push(d); return d; };
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

function run(cmd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', PYTHONDONTWRITEBYTECODE: '1', ...env }, timeout: 300_000 });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', all: (r.stdout ?? '') + (r.stderr ?? '') };
}

/** custody-rs1.test.ts's BEAM-shaped public tree: public topics, and a chat and questions file per listed dev conversation. */
function fakeBeam(root: string): string {
  const beam = join(root, 'beam');
  const write = (rel: string, value: unknown) => { mkdirSync(dirname(join(beam, rel)), { recursive: true }); writeFileSync(join(beam, rel), JSON.stringify(value)); };
  const chat = (seed: string) => [{ batch_number: 1, time_anchor: 'x', turns: Array.from({ length: 10 }, (_, i) => [{ role: 'user', id: 2 * i, content: words(`${seed}-u${i}`, 60) }, { role: 'assistant', id: 2 * i + 1, content: words(`${seed}-a${i}`, 60) }]) }];
  write('topics/1M/1M_topics.json', ['Coding', 'Math', 'Cooking'].map((category, i) => ({ id: i + 1, category, title: `Public ${category} topic`, theme: `Public theme ${i}`, subtopics: ['a', 'b', 'c'] })));
  for (const rel of readBeamPaths().paths.filter(p => p.startsWith('chats/'))) {
    write(rel, rel.endsWith('/chat.json') || rel.endsWith('/chat_trunecated.json') ? chat(`public-${rel}`) : {});
  }
  return beam;
}

/** Every file under dir with its SHA-256, by path relative to dir. */
function tree(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) tree(p, base, out); else out[relative(base, p)] = sha(readFileSync(p));
  }
  return out;
}
const events = (out: string) => out.split('\n').filter(l => l.startsWith('rs1-mint-lanes event=')).map(l => Object.fromEntries(l.split(' ').slice(1).map(kv => kv.split('=')))) as Array<Record<string, string>>;
const summary = (out: string) => Object.fromEntries(out.split('\n').find(l => l.startsWith('rs1-mint-lanes summary='))!.split(' ').slice(1).map(kv => kv.split('=')));

describe('mint-lanes.ts with mint.sh --fake', () => {
  const SEED = 'test seed lanes';
  let root = '', beam = '', seedFile = '';
  let lanes: ReturnType<typeof run>, sequential: ReturnType<typeof run>;
  const SLOTS = 6;

  beforeAll(() => {
    root = scratch('lanes');
    beam = fakeBeam(root);
    mkdirSync(join(root, 'keys'));
    seedFile = join(root, 'keys/l.rs1-seed');
    writeFileSync(seedFile, seedLine(SEED) + '\n', { mode: 0o600 });
    const common = ['--fake', '--beam-dir', beam, '--seed-file', seedFile];
    sequential = run('bash', [MINT, ...common, '--out', join(root, 'rs1-custody-seq'), '--count', String(SLOTS), '--until', 'probe'], { RS1_FAKE_TOPIC_COLLIDE: '3' });
    lanes = run('bun', [LANES, '--first', '1', '--last', String(SLOTS), '--still-needed', String(SLOTS), '--lanes', '4', '--', ...common, '--out', join(root, 'rs1-custody-lanes')], { RS1_FAKE_TOPIC_COLLIDE: '3' });
  }, 600_000);

  test('four lanes write the same set, byte for byte, and the same usage.json as one mint.sh over the same slots', () => {
    expect(sequential.code).toBe(0);
    expect(lanes.code).toBe(0);
    const seq = tree(join(root, 'rs1-custody-seq/set')), par = tree(join(root, 'rs1-custody-lanes/set'));
    expect(Object.keys(seq).filter(p => p.endsWith('manifest.json'))).toHaveLength(SLOTS);
    expect(Object.keys(seq).some(p => p.includes('topic-attempts'))).toBe(true);
    expect(par).toEqual(seq);
    expect(readFileSync(join(root, 'rs1-custody-lanes/usage.json'), 'utf8')).toBe(readFileSync(join(root, 'rs1-custody-seq/usage.json'), 'utf8'));
    expect(summary(lanes.out)).toMatchObject({ slots: String(SLOTS), started: String(SLOTS), done: String(SLOTS), dropped: '0', failed: '0', refused: '0', not_started: '0', stop: 'none', usage_exit: '0' });
    for (const line of lanes.out.trim().split('\n')) expect(line).toMatch(/^rs1-mint(-lanes)? ( ?[a-z0-9_]+=[^ ]*)+$/);
    expect(lanes.err).toBe('');
  });

  test('topic passes run one at a time in slot order, and at most four mint.sh run at once, more than one at some point', () => {
    const ev = events(lanes.out);
    const plans = ev.filter(e => e.phase === 'plan');
    expect(plans.filter(e => e.event === 'start').map(e => Number(e.slot))).toEqual(Array.from({ length: SLOTS }, (_, i) => i + 1));
    for (let i = 0; i + 1 < plans.length; i += 2) expect([plans[i].event, plans[i + 1].event, plans[i].slot]).toEqual(['start', 'end', plans[i + 1].slot]);
    let open = 0, max = 0;
    for (const e of ev) { open += e.event === 'start' ? 1 : -1; max = Math.max(max, open); expect(Number(e.in_flight)).toBe(open); }
    expect(open).toBe(0);
    expect(max).toBeLessThanOrEqual(4);
    expect(max).toBeGreaterThan(1);
    expect(summary(lanes.out).max_in_flight).toBe(String(max));
    const probes = ev.filter(e => e.phase === 'probe' && e.event === 'start');
    expect(probes.map(e => Number(e.slot)).sort((a, b) => a - b)).toEqual(Array.from({ length: SLOTS }, (_, i) => i + 1));
    for (const p of probes) expect(ev.findIndex(e => e.phase === 'plan' && e.event === 'end' && e.slot === p.slot)).toBeLessThan(ev.indexOf(p));
  });

  test('a rerun over the same range runs no step again and changes no file', () => {
    const dir = join(root, 'rs1-custody-lanes');
    const before = tree(join(dir, 'set'));
    const again = run('bun', [LANES, '--first', '1', '--last', String(SLOTS), '--still-needed', String(SLOTS), '--', '--fake', '--beam-dir', beam, '--seed-file', seedFile, '--out', dir]);
    expect(again.code).toBe(0);
    expect(summary(again.out)).toMatchObject({ done: String(SLOTS), held: '0', stop: 'none' });
    const logs = readdirSync(join(dir, 'lanes')).sort();
    expect(logs).toEqual(Array.from({ length: SLOTS }, (_, i) => [`c00${i + 1}-plan-1.log`, `c00${i + 1}-probe-1.log`]).flat().sort());
    for (const n of logs) {
      const runs = readFileSync(join(dir, 'lanes', n), 'utf8').trim().split('\n').filter(l => l.includes(' summary=mint '));
      expect(runs).toHaveLength(2);
      expect(runs[1]).toContain(' steps_run=0 ');
    }
    expect(tree(join(dir, 'set'))).toEqual(before);
  });

  test('refuses more slots than are still needed, mint.sh flags of its own, --mint-sh without --fake, and an --out not named rs1-custody, before anything runs', () => {
    const out = join(root, 'rs1-custody-refuse');
    const cases: Array<[string[], string]> = [
      [['--first', '1', '--last', '11', '--still-needed', '10', '--', '--fake', '--out', out], 'more than the 10 still needed'],
      [['--first', '1', '--last', '2', '--still-needed', '10', '--', '--fake', '--out', out, '--until', 'probe'], "mint.sh's --until is the driver's to set"],
      [['--first', '1', '--last', '2', '--still-needed', '10', '--', '--fake', '--out', out, '--candidates', 'x'], "mint.sh's --candidates is the driver's to set"],
      [['--first', '1', '--last', '2', '--still-needed', '10', '--mint-sh', '/bin/true', '--', '--out', out], 'only, with --fake'],
      [['--first', '1', '--last', '2', '--still-needed', '10', '--lanes', '9', '--', '--fake', '--out', out], '--lanes must be 1 to 8'],
      [['--first', '1', '--last', '2', '--still-needed', '10', '--', '--fake', '--out', join(root, 'elsewhere')], 'starts with rs1-custody'],
    ];
    for (const [args, message] of cases) {
      const r = run('bun', [LANES, ...args]);
      expect([r.code, r.out]).toEqual([2, '']);
      expect(r.err).toStartWith('rs1-mint-lanes refused: ');
      expect(r.err).toContain(message);
    }
    expect(existsSync(out)).toBe(false);
    expect(existsSync(join(root, 'elsewhere'))).toBe(false);
  });
});

describe('mint-lanes.ts stops and retries (stub mint.sh)', () => {
  /**
   * A stand-in for mint.sh: it records each start and end in calls.log, sleeps, and fails as STUB_PLAN says for its
   * slot, phase and attempt (attempts counted in its own state directory).
   */
  const STUB = String.raw`#!/usr/bin/env bash
set -euo pipefail
while [ $# -gt 0 ]; do case "$1" in --out) OUT="$2"; shift 2 ;; --start) K="$2"; shift 2 ;; --until) U="$2"; shift 2 ;; *) shift ;; esac; done
mkdir -p "$OUT/stub"; N=$(( $(cat "$OUT/stub/$K-$U" 2>/dev/null || echo 0) + 1 )); echo "$N" > "$OUT/stub/$K-$U"
echo "start $K $U $N" >> "$OUT/stub/calls.log"; sleep 0.4
case " $STUB_PLAN " in
  *" $K:$U:$N:402 "*) echo "rs1-mint conv=c00$K step=answer status=error error_class=ProviderRefusal error_sha256=0"; echo "rs1-mint refused: HTTP 402 ClientError" >&2; echo "end $K $U" >> "$OUT/stub/calls.log"; exit 1 ;;
  *" $K:$U:$N:step "*) echo "rs1-mint conv=c00$K step=answer status=error error_class=StepFailure error_sha256=0"; echo "end $K $U" >> "$OUT/stub/calls.log"; exit 1 ;;
  *" $K:$U:$N:drop "*) echo "rs1-mint summary=mint mode=fake conversations=1 complete=0 dropped=1 select_exhausted=0"; echo "end $K $U" >> "$OUT/stub/calls.log"; exit 0 ;;
esac
echo "rs1-mint summary=mint mode=fake conversations=1 complete=0 dropped=0 select_exhausted=0"; echo "end $K $U" >> "$OUT/stub/calls.log"
`;
  let root = '', stub = '';
  beforeAll(() => { root = scratch('lanes-stub'); stub = join(root, 'mint-stub.sh'); writeFileSync(stub, STUB, { mode: 0o700 }); });
  const lanes = (out: string, plan: string, last = 8) => run('bun', [LANES, '--first', '1', '--last', String(last), '--still-needed', '8', '--lanes', '3', '--mint-sh', stub, '--', '--fake', '--out', join(root, out)], { STUB_PLAN: plan });
  const calls = (out: string) => readFileSync(join(root, out, 'stub/calls.log'), 'utf8').trim().split('\n');

  test('a 402 starts no new slot and no retry, lets the running lanes finish, and exits 3 naming it', () => {
    const r = lanes('rs1-custody-402', '3:probe:1:402');
    expect(r.code).toBe(3);
    const s = summary(r.out);
    expect(s).toMatchObject({ stop: 'http_402', refused: '1', failed: '0', retries: '0', usage_exit: '0' });
    expect(Number(s.not_started)).toBeGreaterThan(0);
    expect(Number(s.started) + Number(s.not_started)).toBe(8);
    const log = calls('rs1-custody-402');
    expect(log.filter(l => l.startsWith('start')).length).toBe(log.filter(l => l.startsWith('end')).length);
    const refusedAt = log.indexOf('end 3 probe');
    expect(log.slice(refusedAt + 1).filter(l => l.startsWith('start'))).toEqual([]);
    expect(log.filter(l => l.startsWith('start 3 '))).toEqual(['start 3 plan 1', 'start 3 probe 1']);
    expect(Number(s.max_in_flight)).toBeLessThanOrEqual(3);
    expect(existsSync(join(root, 'rs1-custody-402/usage.json'))).toBe(true);
    expect(Number(s.done) + Number(s.refused) + Number(s.held)).toBe(Number(s.started));
  }, 120_000);

  test('a StepFailure is retried in its lane up to --retries times; one that keeps failing starts no new slot and exits 1', () => {
    const ok = lanes('rs1-custody-retry', '2:probe:1:step 5:plan:1:step', 6);
    expect(ok.code).toBe(0);
    expect(summary(ok.out)).toMatchObject({ done: '6', retries: '2', stop: 'none' });
    expect(calls('rs1-custody-retry').filter(l => l.startsWith('start 2 probe') || l.startsWith('start 5 plan'))).toEqual(['start 2 probe 1', 'start 2 probe 2', 'start 5 plan 1', 'start 5 plan 2']);
    const bad = lanes('rs1-custody-fail', '2:probe:1:step 2:probe:2:step 2:probe:3:step');
    expect(bad.code).toBe(1);
    expect(summary(bad.out)).toMatchObject({ failed: '1', stop: 'failed', retries: '2' });
    expect(calls('rs1-custody-fail').filter(l => l.startsWith('start 2 probe'))).toHaveLength(3);
    expect(Number(summary(bad.out).not_started)).toBeGreaterThan(0);
  }, 120_000);

  test('a slot whose topic is dropped runs no lane', () => {
    const r = lanes('rs1-custody-drop', '4:plan:1:drop', 5);
    expect(r.code).toBe(0);
    expect(summary(r.out)).toMatchObject({ done: '4', dropped: '1', stop: 'none' });
    expect(calls('rs1-custody-drop').filter(l => l.startsWith('start 4 '))).toEqual(['start 4 plan 1']);
  }, 120_000);
});
