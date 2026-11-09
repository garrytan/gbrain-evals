/**
 * BG1 custody scripts (GST-2010): eval/custody/bg1/mint.sh, render.ts, validate.ts and hashlist.ts, and BG1's block of
 * the sealed key in .gstack/pregate.json. Keyless: mint.sh and render.ts run in --fake mode or stop at a refusal, the
 * real-mode client meets only a dead loopback port, and nothing reaches a provider. The seeds here are test seeds made
 * at run time; the BG1 seed and phrasing are chosen in custody and are never these.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { BG1_CUSTODY_MARKER, BG1_DEV_SEEDS, BG1_FIXTURE_TOKENS, BG1_TARGET_TOKENS, PUBLIC_PHRASING, renderBriefs, renderTemplateSession, sealedWorldSeed, type RenderBrief, type Turn, type World, type WorldPlan } from '../../eval/generators/changing-facts-gen.ts';
import { BG1_DEV_CONVERSATIONS } from '../../eval/runner/bg1/types.ts';
import { CHECK_MODELS, cachedClient, checkPrompt, checkSession, clientModels, fakeModels, geminiProxyClient, haikuProxyClient, proxyEndpoint, renderPrompt, renderWorld, type ModelClient, type Models } from '../../eval/custody/bg1/render.ts';
import { encodingCount } from '../../eval/runner/systems/render-v2.ts';
import * as renderTs from '../../eval/custody/bg1/render.ts';
import { BudgetRun, closeLedgers, initLedger } from '../../eval/runner/budget-ledger.ts';
import { freePort } from '../../eval/runner/lifecycle/slice.ts';
import { bg1DevFixtureProblem } from '../../eval/runner/memory-qa/corpus.ts';

const REPO = resolve(import.meta.dir, '../..');
const MINT = join(REPO, 'eval/custody/bg1/mint.sh');
const RENDER = join(REPO, 'eval/custody/bg1/render.ts');
const VALIDATE = join(REPO, 'eval/custody/bg1/validate.ts');
const HASHLIST = join(REPO, 'eval/custody/bg1/hashlist.ts');
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const seedLine = (name: string) => ['bg1', 'seed', 'v1'].join('-') + ':' + sha(name);

const roots: string[] = [];
const scratch = (name: string) => { const d = mkdtempSync(join(tmpdir(), `bg1-custody-test-${name}-`)); roots.push(d); return d; };
afterAll(() => { closeLedgers(); for (const d of roots) rmSync(d, { recursive: true, force: true }); });

/** A child process with only PATH and HOME, the provider keys blanked, and whatever the test adds. */
function run(cmd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', timeout: 240_000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', BG1_GEMINI_API_KEY: '', ...env } });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', all: (r.stdout ?? '') + (r.stderr ?? '') };
}
function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) { const p = join(dir, name); if (statSync(p).isDirectory()) files(p, out); else out.push(p); }
  return out;
}
/** Custody inputs in a fresh directory: an owner-only seed file and phrasing set (public phrasing with the custody marker). */
function inputs(name: string, opts: { marker?: boolean } = {}) {
  const dir = scratch(name);
  const seed = join(dir, 'test.bg1-seed'), phrasing = join(dir, 'test.bg1-phrasing.json');
  writeFileSync(seed, seedLine(name) + '\n');
  writeFileSync(phrasing, JSON.stringify({ ...PUBLIC_PHRASING, ...(opts.marker === false ? {} : { custody: BG1_CUSTODY_MARKER }) }));
  chmodSync(seed, 0o600); chmodSync(phrasing, 0o600);
  return { dir, seed, phrasing, line: seedLine(name) };
}
/** Text a custody tree holds, as probes: every planned line, entity name and value, the seed line, the world seeds and the marker. */
function probes(setDir: string, line: string): string[] {
  const out = new Set<string>([line, line.split(':')[1], BG1_CUSTODY_MARKER]);
  for (const slot of [1, 2, 3, 4, 5]) out.add(sealedWorldSeed(line, slot));
  for (const path of files(setDir).filter(p => p.endsWith('plan.json'))) {
    const plan = JSON.parse(readFileSync(path, 'utf8')) as WorldPlan;
    for (const s of plan.sessions) for (const l of s.lines) out.add(l.text);
    for (const e of plan.entities) out.add(e.name);
    for (const v of Object.keys(plan.lexicon)) if (v.length >= 6) out.add(v);
  }
  return [...out];
}
const leaks = (output: string, ps: string[]) => ps.filter(p => output.includes(p));
const mint = (out: string, i: ReturnType<typeof inputs>, extra: string[] = [], env: Record<string, string> = {}) =>
  run('bash', [MINT, '--out', out, '--seed-file', i.seed, '--phrasing', i.phrasing, '--target-tokens', '4000', ...extra], env);

/**
 * mint.sh's real mode with nothing real behind it: a fresh directory holding ledgers/, an owner-only bg1.env with a
 * placeholder key, and a bun stub on PATH that records each call's directory and arguments and runs nothing.
 */
function stubbed(name: string) {
  const j = inputs(name);
  const home = scratch(`${name}-home`), bin = join(j.dir, 'bin'), log = join(j.dir, 'bun-calls.log');
  mkdirSync(join(home, '.config', 'gbrain-evals'), { recursive: true });
  const keyFile = join(home, '.config', 'gbrain-evals', 'bg1.env');
  writeFileSync(keyFile, 'BG1_GEMINI_API_KEY=test-bg1-key-not-real\n');
  chmodSync(keyFile, 0o600);
  mkdirSync(bin);
  mkdirSync(join(j.dir, 'ledgers'));
  writeFileSync(join(bin, 'bun'), [
    '#!/usr/bin/env bash',
    `printf '%s\\t%s\\n' "$PWD" "$*" >> ${JSON.stringify(log)}`,
    'case "$1" in',
    '  *harness-metering-proxy.ts) while [ $# -gt 1 ]; do [ "$1" = --ready-file ] && printf "{}" > "$2"; shift; done ;;',
    '  *render.ts) echo "bg1-render slot=1 world=bg1-001 status=written" ;;',
    'esac',
    'exit 0', ''].join('\n'));
  chmodSync(join(bin, 'bun'), 0o755);
  const mintHere = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync('bash', [MINT, ...args], { cwd: j.dir, encoding: 'utf8', timeout: 60_000,
      env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: home, ANTHROPIC_API_KEY: 'test-anthropic-key-not-real', GEMINI_API_KEY: '', OPENAI_API_KEY: '', BG1_GEMINI_API_KEY: '', ...env } });
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
  };
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(l => l.split('\t')) : [];
  const window = ['--paid-window', 'bg1-test', '--window-cap-usd', '5', '--budget-ledger', 'ledgers/ledger.sqlite', '--budget-run-id', 'r1'];
  return { j, log, mint: mintHere, calls, window };
}
const ledgerArgs = (calls: string[][]) => [...new Set(calls.map(([, args]) => /--budget-ledger (\S+)/.exec(args)?.[1]))];

// ─── mint.sh --fake end to end ───────────────────────────────────────

describe('mint.sh --fake, validate.ts and hashlist.ts end to end', () => {
  let i: ReturnType<typeof inputs>, out = '', first: ReturnType<typeof run>, again: ReturnType<typeof run>;
  beforeAll(() => {
    i = inputs('e2e');
    out = join(i.dir, 'bg1-custody-a');
    first = mint(out, i, ['--fake', '--count', '3', '--fake-break', '2:4:2', '--target-tokens', '30000']);
    again = mint(out, i, ['--fake', '--count', '3', '--target-tokens', '30000']);
  }, 240_000);

  test('writes plan, questions and world for each slot, owner-only, each carrying the custody marker', () => {
    expect(first.code).toBe(0);
    expect(first.out).toContain('bg1-mint summary=mint mode=fake slots=3 written=3 skipped=0 dropped=0');
    for (const id of ['bg1-001', 'bg1-002', 'bg1-003']) for (const f of ['plan.json', 'questions.json', 'world.json']) {
      const path = join(out, 'set', 'worlds', id, f);
      expect(readFileSync(path, 'utf8')).toContain(BG1_CUSTODY_MARKER);
      expect(statSync(path).mode & 0o077).toBe(0);
    }
    expect(first.out).toMatch(/slot=2 world=bg1-002 status=written sessions=\d+ attempts=\d+ regenerated=2 /);
  });

  test('prints counts and hashes only: no planned line, name, value, seed or marker', () => {
    const ps = probes(join(out, 'set'), i.line);
    expect(ps.length).toBeGreaterThan(300);
    expect(leaks(first.all + again.all, ps)).toEqual([]);
    for (const l of (first.out + again.out).trim().split('\n')) expect(l).toMatch(/^bg1-(mint|render) /);
  });

  test('a rerun skips every slot it already wrote from the same plan', () => {
    expect(again.code).toBe(0);
    expect(again.out).toContain('written=0 skipped=3 dropped=0');
  });

  test('a session that fails every attempt drops its world; two drops in slots 1 to 5 pause with exit 3', () => {
    const j = inputs('yield');
    const r = mint(join(j.dir, 'bg1-custody-y'), j, ['--fake', '--count', '5', '--fake-break', '1:2:4,3:6:4']);
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/slot=1 world=bg1-001 status=dropped dropped_session=2 .*failures=shape:4\n/);
    expect(r.out).toContain('summary=paused reason=yield_gate mode=fake written=1 skipped=0 dropped=2 last_slot=3');
    expect(existsSync(join(j.dir, 'bg1-custody-y', 'set', 'worlds', 'bg1-001'))).toBe(false);
    expect(JSON.parse(readFileSync(join(j.dir, 'bg1-custody-y', 'render', 'bg1-001.json'), 'utf8')).status).toBe('dropped');
    expect(leaks(r.all, probes(join(j.dir, 'bg1-custody-y', 'set'), j.line))).toEqual([]);
    const late = mint(join(j.dir, 'bg1-custody-z'), j, ['--fake', '--start', '6', '--count', '2', '--fake-break', '6:1:4,7:1:4']);
    expect(late.code).toBe(0);
    expect(late.out).toContain('written=0 skipped=0 dropped=2');
  });

  // Value: protects=the yield gate pauses the mint on two dropped worlds among slots 1 to 5, whichever invocation dropped them; fails_when=a resumed or --start run on the same --out counts only its own drops and renders past the gate; why_new=#398 open note 10 (mint.sh counted early drops per invocation); seam=mint.sh --fake with planned breaks; no_claim=a paid render
  test('the yield gate counts early drops across invocations on one --out: a resumed run pauses at the second, and a later --start run pauses before rendering', () => {
    const j = inputs('yield-resume');
    const out = join(j.dir, 'bg1-custody-r');
    const one = mint(out, j, ['--fake', '--count', '1', '--fake-break', '1:2:4']);
    expect(one.code).toBe(0);
    expect(one.out).toContain('summary=mint mode=fake slots=1 written=0 skipped=0 dropped=1');
    const two = mint(out, j, ['--fake', '--start', '2', '--count', '4', '--fake-break', '3:6:4']);
    expect(two.code).toBe(3);
    expect(two.out).toContain('summary=paused reason=yield_gate mode=fake written=1 skipped=0 dropped=1 last_slot=3 early_drops=2');
    const later = mint(out, j, ['--fake', '--start', '6', '--count', '1']);
    expect(later.code).toBe(3);
    expect(later.out).toContain('summary=paused reason=yield_gate mode=fake written=0 skipped=0 dropped=0 last_slot=5 early_drops=2');
    expect(existsSync(join(out, 'set', 'worlds', 'bg1-006'))).toBe(false);
    expect(leaks(one.all + two.all + later.all, probes(join(out, 'set'), j.line))).toEqual([]);
  }, 240_000);

  // Value: protects=GBEV-3's approval of a yield-gate pause lets the mint go on, and the gate still pauses on two more drops; fails_when=an approved pause exits 3 on every later invocation, an ack is taken with no pause or with a malformed or used id, or an ack turns the gate off; why_new=BG1 follow-up fix 7 (mint.sh had no way to go on after an approved pause); seam=mint.sh --fake with planned breaks; no_claim=a paid render
  test('--yield-gate-ack records an approved pause, so later invocations go on, and two more drops pause again', () => {
    const j = inputs('yield-ack');
    const out = join(j.dir, 'bg1-custody-k'), acks = join(out, 'render', 'yield-gate-acks.jsonl');
    const go = (start: number, count: number, extra: string[] = []) => mint(out, j, ['--fake', '--start', String(start), '--count', String(count), ...extra]);
    const ackLog = () => readFileSync(acks, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { ack: string; at: string; early_drops: number });
    const paused = go(1, 3, ['--fake-break', '1:2:4,3:2:4']);
    expect(paused.code).toBe(3);
    expect(paused.out).toContain('summary=paused reason=yield_gate mode=fake written=1 skipped=0 dropped=2 last_slot=3 early_drops=2\n');
    expect(go(6, 1).code).toBe(3);
    for (const id of ['a-0123456789a', 'a-0123456789abc', 'A-0123456789ab', 'a-0123456789AB', 'b-0123456789ab', 'a-0123456789ag']) {
      const bad = go(6, 1, ['--yield-gate-ack', id]);
      expect(bad.code).toBe(2);
      expect(bad.err).toContain('approval id');
    }
    expect(existsSync(acks)).toBe(false);

    const acked = go(6, 1, ['--yield-gate-ack', 'a-0123456789ab']);
    expect(acked.code).toBe(0);
    expect(acked.out).toContain('bg1-mint yield_gate_ack=a-0123456789ab early_drops=2\n');
    expect(acked.out).toContain('summary=mint mode=fake slots=1 written=1 skipped=0 dropped=0');
    expect(ackLog()).toEqual([{ ack: 'a-0123456789ab', at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/), early_drops: 2 }]);
    expect(go(7, 1).code).toBe(0);
    expect(go(8, 1, ['--yield-gate-ack', 'a-0123456789ab']).code).toBe(0);
    expect(ackLog()).toHaveLength(1);
    const unpaused = go(9, 1, ['--yield-gate-ack', 'a-ba9876543210']);
    expect(unpaused.code).toBe(2);
    expect(unpaused.err).toContain('not paused');
    expect(ackLog()).toHaveLength(1);

    const twoMore = go(4, 2, ['--fake-break', '4:2:4,5:2:4']);
    expect(twoMore.code).toBe(3);
    expect(twoMore.out).toContain('summary=paused reason=yield_gate mode=fake written=0 skipped=0 dropped=2 last_slot=5 early_drops=4 acked_drops=2\n');
    expect(go(9, 1, ['--yield-gate-ack', 'a-0123456789ab']).code).toBe(3);
    const second = go(9, 1, ['--yield-gate-ack', 'a-ba9876543210']);
    expect(second.code).toBe(0);
    expect(ackLog().map(a => [a.ack, a.early_drops])).toEqual([['a-0123456789ab', 2], ['a-ba9876543210', 4]]);
    const old = go(10, 1, ['--yield-gate-ack', 'a-0123456789ab']);
    expect(old.code).toBe(2);
    expect(old.err).toContain('earlier pause');
    expect(ackLog()).toHaveLength(2);
    for (const id of ['bg1-006', 'bg1-007', 'bg1-008', 'bg1-009']) expect(existsSync(join(out, 'set', 'worlds', id, 'world.json'))).toBe(true);
    expect(existsSync(join(out, 'set', 'worlds', 'bg1-010'))).toBe(false);
    expect(leaks(paused.all + acked.all + twoMore.all + second.all, probes(join(out, 'set'), j.line))).toEqual([]);
  }, 240_000);

  // Value: protects=two drops among slots 1 to 5 past GBEV-3's latest approved count pause the mint, however later runs cover the slots; fails_when=a run whose --start covers an acknowledged dropped slot renders it again, the early-drop count falls, and two more drops go on without a pause; why_new=the Opus fix-check on 12256467..806fc1ba, finding 1 (its probe); seam=mint.sh --fake with planned breaks; no_claim=a paid render
  test('the fix-check probe: after an ack, a rerun over slots 1 to 3 renders neither dropped slot again, so drops at 4 and 5 pause', () => {
    const j = inputs('yield-probe');
    const out = join(j.dir, 'bg1-custody-p');
    const go = (start: number, count: number, extra: string[] = []) => mint(out, j, ['--fake', '--start', String(start), '--count', String(count), ...extra]);
    const records = () => ['bg1-001', 'bg1-003'].map(id => readFileSync(join(out, 'render', `${id}.json`), 'utf8'));
    const paused = go(1, 3, ['--fake-break', '1:2:4,3:2:4']);
    expect(paused.code).toBe(3);
    expect(paused.out).toContain('summary=paused reason=yield_gate mode=fake written=1 skipped=0 dropped=2 last_slot=3 early_drops=2\n');
    const dropped = records();
    expect(go(6, 1, ['--yield-gate-ack', 'a-0123456789ab']).code).toBe(0);
    const rerun = go(1, 3, ['--yield-gate-ack', 'a-0123456789ab']);
    expect(rerun.code).toBe(0);
    expect(rerun.out).not.toMatch(/^bg1-render slot=[13] /m);
    expect(records()).toEqual(dropped);
    for (const id of ['bg1-001', 'bg1-003']) expect(existsSync(join(out, 'set', 'worlds', id))).toBe(false);
    expect(rerun.out).toContain('bg1-mint slot=1 world=bg1-001 status=dropped_earlier\n');
    expect(rerun.out).toContain('bg1-mint slot=3 world=bg1-003 status=dropped_earlier\n');
    expect(rerun.out).toContain('summary=mint mode=fake slots=3 written=0 skipped=1 dropped=0 dropped_earlier=2\n');
    const twoMore = go(4, 2, ['--fake-break', '4:2:4,5:2:4']);
    expect(twoMore.code).toBe(3);
    expect(twoMore.out).toContain('summary=paused reason=yield_gate mode=fake written=0 skipped=0 dropped=2 last_slot=5 early_drops=4 acked_drops=2\n');
    expect(leaks(paused.all + rerun.all + twoMore.all, probes(join(out, 'set'), j.line))).toEqual([]);
  }, 240_000);

  // Value: protects=a dropped world stays dropped, so the drop count the gate and validate.ts read only grows; fails_when=a later invocation renders a slot whose render record says dropped, or rewrites that record; why_new=the Opus fix-check on 12256467..806fc1ba, finding 1 (rule one); seam=mint.sh --fake with planned breaks; no_claim=a paid render
  test('a recorded drop is final: a later run skips the slot with a counted line and leaves its record untouched, early slot or late', () => {
    const j = inputs('drop-final');
    const out = join(j.dir, 'bg1-custody-d');
    const record = (id: string) => { const p = join(out, 'render', `${id}.json`); return { text: readFileSync(p, 'utf8'), mtime: statSync(p).mtimeMs }; };
    expect(mint(out, j, ['--fake', '--count', '2', '--fake-break', '2:2:4']).out).toContain('bg1-render slot=2 world=bg1-002 status=dropped ');
    expect(mint(out, j, ['--fake', '--start', '7', '--count', '1', '--fake-break', '7:1:4']).out).toContain('bg1-render slot=7 world=bg1-007 status=dropped ');
    const before = [record('bg1-002'), record('bg1-007')];
    const again = mint(out, j, ['--fake', '--count', '3']);
    const late = mint(out, j, ['--fake', '--start', '7', '--count', '1']);
    expect([again.code, late.code]).toEqual([0, 0]);
    expect(again.out + late.out).not.toMatch(/^bg1-render slot=[27] /m);
    expect([record('bg1-002'), record('bg1-007')]).toEqual(before);
    for (const id of ['bg1-002', 'bg1-007']) expect(existsSync(join(out, 'set', 'worlds', id))).toBe(false);
    expect(existsSync(join(out, 'set', 'worlds', 'bg1-003', 'world.json'))).toBe(true);
    expect(again.out).toContain('bg1-mint slot=2 world=bg1-002 status=dropped_earlier\n');
    expect(again.out).toContain('summary=mint mode=fake slots=3 written=1 skipped=1 dropped=0 dropped_earlier=1\n');
    expect(late.out).toBe('bg1-mint slot=7 world=bg1-007 status=dropped_earlier\nbg1-mint summary=mint mode=fake slots=1 written=0 skipped=0 dropped=0 dropped_earlier=1\n');
  }, 240_000);

  // Value: protects=the gate never measures new drops against an acknowledged count the render records no longer hold; fails_when=an early-drop count below the latest ack's (a render record removed or rewritten outside mint.sh) lets a run render, or takes a new ack; why_new=the Opus fix-check on 12256467..806fc1ba, finding 1 (rule two); seam=mint.sh --fake with planned breaks and a render record removed by hand; no_claim=a paid render
  test('an early-drop count below the latest ack\'s refuses with exit 3 and a reason line, before any render or new ack', () => {
    const j = inputs('drops-fell');
    const out = join(j.dir, 'bg1-custody-e'), acks = join(out, 'render', 'yield-gate-acks.jsonl');
    const go = (start: number, count: number, extra: string[] = []) => mint(out, j, ['--fake', '--start', String(start), '--count', String(count), ...extra]);
    expect(go(1, 3, ['--fake-break', '1:2:4,3:2:4']).code).toBe(3);
    expect(go(6, 1, ['--yield-gate-ack', 'a-0123456789ab']).code).toBe(0);
    rmSync(join(out, 'render', 'bg1-001.json'));
    for (const extra of [[], ['--yield-gate-ack', 'a-0123456789ab'], ['--yield-gate-ack', 'a-ba9876543210']]) {
      const r = go(7, 1, extra);
      expect(r.code).toBe(3);
      expect(r.out).toBe('bg1-mint summary=refused reason=early_drops_below_ack mode=fake written=0 skipped=0 dropped=0 last_slot=6 early_drops=1 acked_drops=2\n');
    }
    expect(readFileSync(acks, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(existsSync(join(out, 'set', 'worlds', 'bg1-007'))).toBe(false);
  }, 240_000);

  test('validate.ts passes the minted set and keeps it in slot order; tampering fails the matching gate', () => {
    const report = join(i.dir, 'validation', 'report.json');
    const v = run('bun', [VALIDATE, '--set', join(out, 'set'), '--seed-file', i.seed, '--phrasing', i.phrasing, '--report', report, '--target-tokens', '30000', '--tolerance', '0.25', '--n-final', '2']);
    expect(v.code).toBe(0);
    expect(v.out).toMatch(/^bg1-validate checked=3 passed=3 failed=0 render_dropped=0 kept=2 gates=none report_sha256=[0-9a-f]{16}\n$/);
    expect(JSON.parse(readFileSync(report, 'utf8')).kept).toEqual(['bg1-001', 'bg1-002']);
    const copy = join(i.dir, 'bg1-custody-t');
    cpSync(out, copy, { recursive: true });
    const w = (id: string, f: string) => join(copy, 'set', 'worlds', id, f);
    const world = JSON.parse(readFileSync(w('bg1-001', 'world.json'), 'utf8'));
    const value = Object.keys(JSON.parse(readFileSync(w('bg1-001', 'plan.json'), 'utf8')).lexicon)[0];
    world.sessions[3].turns[1].content += ` By the way, ${value}.`;
    writeFileSync(w('bg1-001', 'world.json'), JSON.stringify(world, null, 1) + '\n');
    const qs = JSON.parse(readFileSync(w('bg1-002', 'questions.json'), 'utf8'));
    qs[0].bg1.gold_values = qs[0].bg1.stale_values.length ? qs[0].bg1.stale_values : ['nothing'];
    writeFileSync(w('bg1-002', 'questions.json'), JSON.stringify(qs, null, 1) + '\n');
    writeFileSync(w('bg1-003', 'plan.json'), readFileSync(w('bg1-003', 'plan.json'), 'utf8').replace('"long": false', '"long": true'));
    const t = run('bun', [VALIDATE, '--set', join(copy, 'set'), '--seed-file', i.seed, '--phrasing', i.phrasing, '--report', join(i.dir, 'validation', 'tampered.json'), '--target-tokens', '30000', '--tolerance', '0.25']);
    expect(t.code).toBe(0);
    expect(t.out).toContain('checked=3 passed=0 failed=3');
    const byId = Object.fromEntries(JSON.parse(readFileSync(join(i.dir, 'validation', 'tampered.json'), 'utf8')).worlds.map((x: { id: string; failed: string[] }) => [x.id, x.failed]));
    expect(byId).toEqual({ 'bg1-001': ['sessions'], 'bg1-002': ['gold'], 'bg1-003': ['plan'] });
    expect(leaks(v.all + t.all, probes(join(out, 'set'), i.line))).toEqual([]);
    expect(run('bun', [VALIDATE, '--set', join(out, 'set'), '--seed-file', i.seed, '--phrasing', i.phrasing, '--report', join(out, 'set', 'r.json')]).code).toBe(2);
  }, 120_000);

  test('hashlist.ts writes a list outside the root and a restored copy matches it', () => {
    const list = join(i.dir, 'set.sha256');
    const w = run('bun', [HASHLIST, '--root', join(out, 'set'), '--out', list]);
    expect(w.code).toBe(0);
    expect(w.out).toMatch(/^bg1-hashlist files=9 bytes=\d+ list_sha256=[0-9a-f]{64}\n$/);
    const restored = join(i.dir, 'bg1-custody-restored');
    cpSync(join(out, 'set'), restored, { recursive: true });
    expect(run('bun', [HASHLIST, '--root', restored, '--check', list]).out).toContain('identical=true');
    writeFileSync(join(restored, 'worlds', 'bg1-001', 'world.json'), '{}');
    const c = run('bun', [HASHLIST, '--root', restored, '--check', list]);
    expect(c.code).toBe(1);
    expect(c.out).toContain('changed=1');
    expect(run('bun', [HASHLIST, '--root', join(out, 'set'), '--out', join(out, 'set', 'x.sha256')]).code).toBe(2);
  });
});

// ─── refusals ────────────────────────────────────────────────────────

describe('mint.sh and render.ts refuse before anything is written or any key is read', () => {
  let i: ReturnType<typeof inputs>;
  let ledger = '', runId = '';
  beforeAll(() => {
    i = inputs('refuse');
    ledger = join(i.dir, 'ledger.sqlite');
    expect(run('bun', ['eval/runner/budget-ledger.ts', 'init', '--budget-ledger', ledger, '--program-cap-usd', '5']).code).toBe(0);
    const open = run('bun', ['eval/runner/budget-ledger.ts', 'open', '--runner', 'bg1-test', '--budget-usd', '2', '--budget-ledger', ledger]);
    expect(open.code).toBe(0);
    runId = open.out.trim().split('\n').at(-1)!;
  });
  const window = () => ['--paid-window', 'bg1-test', '--window-cap-usd', '5', '--budget-ledger', ledger, '--budget-run-id', runId];

  test('real mode without the granted window, or with caps it cannot check, exits 2', () => {
    const none = mint(join(i.dir, 'bg1-custody-r1'), i);
    expect(none.code).toBe(2);
    expect(none.err).toContain('needs --paid-window <unit> and --window-cap-usd <n>');
    const unknown = mint(join(i.dir, 'bg1-custody-r2'), i, ['--paid-window', 'bg1-test', '--window-cap-usd', '5', '--budget-ledger', join(i.dir, 'none.sqlite'), '--budget-run-id', 'r']);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('is unknown');
    const above = mint(join(i.dir, 'bg1-custody-r3'), i, ['--paid-window', 'bg1-test', '--window-cap-usd', '1', '--budget-ledger', ledger, '--budget-run-id', runId]);
    expect(above.code).toBe(2);
    expect(above.err).toContain('above paid window');
    for (const d of ['bg1-custody-r1', 'bg1-custody-r2', 'bg1-custody-r3']) expect(existsSync(join(i.dir, d))).toBe(false);
  });

  test('inside the window, Gemini\'s key comes only from an owner-only bg1.env, never from GEMINI_API_KEY', () => {
    const home = scratch('home');
    const env = { HOME: home, GEMINI_API_KEY: 'test-gemini-key-not-real' };
    const missing = mint(join(i.dir, 'bg1-custody-k1'), i, window(), env);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('only from BG1_GEMINI_API_KEY in ~/.config/gbrain-evals/bg1.env');
    mkdirSync(join(home, '.config', 'gbrain-evals'), { recursive: true });
    const keyFile = join(home, '.config', 'gbrain-evals', 'bg1.env');
    writeFileSync(keyFile, 'BG1_GEMINI_API_KEY=test-bg1-key-not-real\n');
    chmodSync(keyFile, 0o644);
    const open = mint(join(i.dir, 'bg1-custody-k2'), i, window(), env);
    expect(open.code).toBe(2);
    expect(open.err).toContain('must be mode 600 or 400');
    chmodSync(keyFile, 0o600);
    const noHaiku = mint(join(i.dir, 'bg1-custody-k3'), i, window(), env);
    expect(noHaiku.code).toBe(2);
    expect(noHaiku.err).toContain('ANTHROPIC_API_KEY is not set');
    writeFileSync(keyFile, 'OTHER=1\n');
    expect(mint(join(i.dir, 'bg1-custody-k4'), i, window(), env).err).toContain('has no BG1_GEMINI_API_KEY line');
    writeFileSync(keyFile, 'export BG1_GEMINI_API_KEY=test-bg1-key-not-real\n');
    const exported = mint(join(i.dir, 'bg1-custody-k5'), i, window(), env);
    expect(exported.code).toBe(2);
    expect(exported.err).not.toContain('has no BG1_GEMINI_API_KEY line');
    expect(exported.err).toContain('ANTHROPIC_API_KEY is not set');
    for (const r of [missing, open, noHaiku, exported]) expect(r.all).not.toContain('not-real');
  });

  // Value: protects=the window check, both proxies and render.ts reserve against one ledger file; fails_when=a relative --budget-ledger reaches render.ts as written, which runs inside --out and so names another file there; why_new=#398 open note 10 (mint.sh resolved a relative --budget-ledger inside its output directory); seam=a bun stub on PATH that records each call's directory and arguments and runs nothing, placeholder keys; no_claim=the window check's, the proxies' or render.ts's own behaviour
  test('a relative --budget-ledger is resolved once, so the window check, both proxies and render.ts name the same absolute file', () => {
    const s = stubbed('ledger-rel'), out = join(s.j.dir, 'bg1-custody-l');
    const r = s.mint(['--out', out, '--seed-file', s.j.seed, '--phrasing', s.j.phrasing, '--count', '1', ...s.window]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('summary=mint mode=real slots=1 written=1');
    const calls = s.calls();
    expect(calls.map(([, args]) => args.split(' ')[0].split('/').at(-1))).toEqual(['paid-window.ts', 'harness-metering-proxy.ts', 'harness-metering-proxy.ts', 'render.ts']);
    expect(calls.at(-1)![0]).toBe(realpathSync(out));
    expect(ledgerArgs(calls)).toEqual([join(realpathSync(s.j.dir), 'ledgers', 'ledger.sqlite')]);
    expect(r.out + r.err + readFileSync(s.log, 'utf8')).not.toContain('not-real');
  });

  // Value: protects=a relative --out and --budget-ledger resolve against the directory mint.sh starts in; fails_when=a CDPATH exported in the caller's shell sends mint.sh's cd to a like-named directory elsewhere and makes cd print that path into the resolved one; why_new=BG1 follow-up fix 6 (mint.sh ran with the caller's CDPATH); seam=the bun stub and a CDPATH directory holding ledgers/ and the out name; no_claim=the window check's, the proxies' or render.ts's own behaviour
  test('a CDPATH in the caller\'s shell changes nothing: a relative --out and --budget-ledger resolve against the starting directory', () => {
    const s = stubbed('cdpath'), decoy = scratch('cdpath-decoy');
    for (const d of ['ledgers', 'bg1-custody-c']) mkdirSync(join(decoy, d));
    const r = s.mint(['--out', 'bg1-custody-c', '--seed-file', s.j.seed, '--phrasing', s.j.phrasing, '--count', '1', ...s.window], { CDPATH: decoy });
    expect(r.code).toBe(0);
    expect(r.out).toContain('summary=mint mode=real slots=1 written=1');
    const calls = s.calls(), here = realpathSync(s.j.dir);
    expect(calls.at(-1)![0]).toBe(join(here, 'bg1-custody-c'));
    expect(ledgerArgs(calls)).toEqual([join(here, 'ledgers', 'ledger.sqlite')]);
    expect(readdirSync(decoy).sort()).toEqual(['bg1-custody-c', 'ledgers']);
    for (const d of ['ledgers', 'bg1-custody-c']) expect(readdirSync(join(decoy, d))).toEqual([]);
  });

  test('custody paths: the out name, a checkout, and the seed and phrasing files\' names, modes and contents', () => {
    const bad = (out: string, j = i, extra: string[] = []) => mint(out, j, ['--fake', '--count', '1', ...extra]);
    expect(bad(join(i.dir, 'custody-a')).err).toContain('starts with bg1-custody');
    expect(bad(join(REPO, 'bg1-custody-in-repo')).err).toContain('outside any git checkout');
    const loose = inputs('loose');
    chmodSync(loose.seed, 0o644);
    expect(bad(join(loose.dir, 'bg1-custody-a'), loose).err).toContain('must be mode 600 or 400');
    const wrong = inputs('wrong');
    writeFileSync(wrong.seed, 'bg1-seed-v1:short\n');
    expect(bad(join(wrong.dir, 'bg1-custody-a'), wrong).err).toContain('does not hold one bg1-seed-v1 line');
    const unmarked = inputs('unmarked', { marker: false });
    const r = bad(join(unmarked.dir, 'bg1-custody-a'), unmarked);
    expect(r.code).toBe(2);
    expect(r.err).toContain('lacks the custody marker');
    expect(mint(join(i.dir, 'bg1-custody-b'), i, ['--fake', '--count', '1', '--seed-file', join(i.dir, 'x.seed')]).err).toContain('*.bg1-seed');
    expect(existsSync(join(REPO, 'bg1-custody-in-repo'))).toBe(false);
  });

  test('render.ts real mode: the window first, then no provider key in its own environment, then only loopback proxy tokens', () => {
    const base = ['--set', join(i.dir, 'bg1-custody-p', 'set'), '--seed-file', i.seed, '--phrasing', i.phrasing, '--slot', '1', '--target-tokens', '4000'];
    expect(run('bun', [RENDER, ...base]).err).toContain('bg1-render refused: bg1 render spends real keys');
    const keyed = run('bun', [RENDER, ...base, ...window()], { ANTHROPIC_API_KEY: 'test-anthropic-key-not-real' });
    expect(keyed.code).toBe(2);
    expect(keyed.err).toContain('this process holds ANTHROPIC_API_KEY');
    expect(keyed.all).not.toContain('not-real');
    expect(run('bun', [RENDER, ...base, ...window()]).err).toContain('needs BG1_GEMINI_READY');
    const ready = (b: string, token: string) => { const p = join(scratch('ready'), 'ready.json'); writeFileSync(p, JSON.stringify({ env: { bg1: b.includes('anthropic') ? { ANTHROPIC_BASE_URL: b, ANTHROPIC_API_KEY: token } : { GOOGLE_GEMINI_BASE_URL: b, GEMINI_API_KEY: token } } })); return p; };
    expect(() => proxyEndpoint(ready('https://generativelanguage.googleapis.com/gemini', 'mpwp-bg1-x'), 'gemini')).toThrow('not the loopback metering proxy');
    expect(() => proxyEndpoint(ready('http://127.0.0.1:9/gemini', 'AIza-not-a-proxy-token'), 'gemini')).toThrow('not a bg1 metering-proxy token');
    expect(() => proxyEndpoint(ready('http://127.0.0.1:9/gemini', 'mpwp-bg1-x'), 'anthropic')).toThrow('does not serve anthropic');
    expect(proxyEndpoint(ready('http://127.0.0.1:9/gemini', 'mpwp-bg1-x'), 'gemini')).toEqual({ base: 'http://127.0.0.1:9/gemini', token: 'mpwp-bg1-x' });
  });

  test('render.ts real mode against a dead loopback proxy fails with an error class and a hash, never text', async () => {
    const port = await freePort(0);
    const dir = scratch('dead');
    const g = join(dir, 'gemini.json'), a = join(dir, 'anthropic.json');
    writeFileSync(g, JSON.stringify({ env: { bg1: { GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${port}/gemini`, GEMINI_API_KEY: 'mpwp-bg1-dead' } } }));
    writeFileSync(a, JSON.stringify({ env: { bg1: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/anthropic`, ANTHROPIC_API_KEY: 'mpwp-bg1-dead' } } }));
    const set = join(dir, 'bg1-custody-d', 'set');
    const r = run('bun', [RENDER, '--set', set, '--seed-file', i.seed, '--phrasing', i.phrasing, '--slot', '1', '--target-tokens', '4000', ...window()], { BG1_GEMINI_READY: g, BG1_ANTHROPIC_READY: a });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^bg1-render error class=\w+ sha256=[0-9a-f]{16}\n$/);
    expect(r.out).toBe('');
    expect(existsSync(join(set, 'worlds'))).toBe(false);
  });
});

// ─── the public dev worlds: mint.sh --dev and render.ts --dev ────────

describe('mint.sh --dev and render.ts --dev render stage 1\'s public dev worlds', () => {
  const committed = (id: string, name: string) => readFileSync(join(renderTs.BG1_DEV_WORLDS, id, name), 'utf8');

  // Value: protects=stage 1 renders the three public dev worlds from the committed plans and gold, through the sealed path's renderer and checks; fails_when=mint.sh or render.ts has no dev path, renders a plan or questions other than the committed ones, skips a world or renders out of order, or a drop does not stop the run; why_new=BG1 follow-up fix 8 (stage 1's dev worlds had no render path); seam=mint.sh --dev --fake with planned breaks; no_claim=a paid render or the rendered text's quality
  test('--dev --fake renders bg1-dev-01, -02 and -03 in order, each plan and questions byte-identical to the committed files; a drop stops with exit 3', () => {
    const out = join(scratch('dev-fake'), 'dev-out');
    const r = run('bash', [MINT, '--dev', '--fake', '--out', out, '--target-tokens', '4000']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('bg1-mint summary=dev mode=fake worlds=3 written=3 skipped=0');
    for (const l of r.out.trim().split('\n')) expect(l).toMatch(/^bg1-(mint|render) /);
    expect([...r.out.matchAll(/^bg1-render world=(\S+) status=written /gm)].map(m => m[1])).toEqual([...BG1_DEV_CONVERSATIONS]);
    expect([...r.out.matchAll(/^bg1-render world=(\S+) report status=written attempts=\d+ regenerated=0$/gm)].map(m => m[1])).toEqual([...BG1_DEV_CONVERSATIONS]);
    for (const id of BG1_DEV_CONVERSATIONS) {
      const dir = join(out, 'set', 'worlds', id);
      for (const name of ['plan.json', 'questions.json']) expect(readFileSync(join(dir, name), 'utf8')).toBe(committed(id, name));
      const world = JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8')) as World;
      expect([world.id, world.renderer, 'custody' in world]).toEqual([id, 'fake-template', false]);
      expect(JSON.parse(readFileSync(join(out, 'set', 'render', `${id}.json`), 'utf8')).status).toBe('written');
    }
    expect(bg1DevFixtureProblem(join(out, 'set'))).toContain('holds template-rendered worlds');

    const dropOut = join(scratch('dev-drop'), 'dev-out');
    const drop = run('bash', [MINT, '--dev', '--fake', '--out', dropOut, '--target-tokens', '4000', '--fake-break', '2:3:4']);
    expect(drop.code).toBe(3);
    expect(drop.out).toContain('bg1-render world=bg1-dev-02 status=dropped dropped_session=3 ');
    expect(drop.out).toContain('bg1-render world=bg1-dev-02 report status=dropped attempts=');
    expect(drop.out).toContain('bg1-mint summary=stopped reason=dev_world_dropped mode=fake world=bg1-dev-02 written=1 skipped=0');
    expect(readdirSync(join(dropOut, 'set', 'worlds'))).toEqual(['bg1-dev-01']);
  }, 240_000);

  // Value: protects=a dev render reads no custody input and writes nowhere Git could pick it up; fails_when=--dev takes a seed or phrasing file or a slot, or render.ts writes a dev set inside a checkout; why_new=BG1 follow-up fix 8; seam=mint.sh and render.ts refusals, which exit before anything is read or written; no_claim=the sealed path's own refusals
  test('--dev takes no seed, phrasing or slot, and render.ts refuses a --set inside a checkout', () => {
    const j = inputs('dev-refuse');
    const out = join(j.dir, 'dev-out'), set = join(j.dir, 'dev-set');
    for (const extra of [['--seed-file', j.seed], ['--phrasing', j.phrasing], ['--count', '1'], ['--start', '2'], ['--yield-gate-ack', 'a-0123456789ab']]) {
      const r = run('bash', [MINT, '--dev', '--fake', '--out', out, ...extra]);
      expect(r.code).toBe(2);
      expect(r.err).toContain(`so it takes no ${extra[0]}`);
    }
    for (const extra of [['--seed-file', j.seed], ['--phrasing', j.phrasing], ['--slot', '1']]) {
      const r = run('bun', [RENDER, '--dev', 'bg1-dev-01', '--fake', '--set', set, ...extra]);
      expect(r.code).toBe(2);
      expect(r.err).toContain('takes no --seed-file, --phrasing or --slot');
    }
    expect(run('bun', [RENDER, '--dev', 'bg1-dev-04', '--fake', '--set', set]).err).toContain('usage: --dev <bg1-dev-01|bg1-dev-02|bg1-dev-03>');
    const inRepo = join(REPO, 'eval', 'data', 'changing-facts-v1', 'dev-set-must-not-exist');
    const r = run('bun', [RENDER, '--dev', 'bg1-dev-01', '--fake', '--set', inRepo]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--set must sit outside any git checkout');
    for (const p of [out, set, inRepo]) expect(existsSync(p)).toBe(false);
  });

  // Value: protects=dev worlds never land in a custody --out, beside sealed worlds or in their render-cache; fails_when=mint.sh --dev renders into an --out named bg1-custody* in any case, or into one whose set/worlds or render/ holds a sealed bg1-NNN entry; why_new=the Opus fix-check on 12256467..806fc1ba, finding 4 (its probe: --dev --fake --out .../bg1-custody-z over a set holding worlds/bg1-001 exited 0); seam=mint.sh --dev --fake, which refuses before it writes anything; no_claim=the sealed path's own --out checks
  test('--dev refuses a custody --out: a bg1-custody name in any case, or a set/worlds or render/ holding a bg1-NNN entry', () => {
    const j = inputs('dev-custody');
    const dev = (out: string) => run('bash', [MINT, '--dev', '--fake', '--out', out, '--target-tokens', '4000']);
    const sealed = join(j.dir, 'bg1-custody-z');
    expect(mint(sealed, j, ['--fake', '--count', '1']).code).toBe(0);
    const before = files(sealed).sort();
    const probe = dev(sealed);
    expect(files(sealed).sort()).toEqual(before);
    expect(probe.code).toBe(2);
    expect(probe.err).toContain('--dev never writes into a custody --out, so its name may not start with bg1-custody');
    for (const name of ['bg1-custody-new', 'BG1-Custody-new']) {
      const r = dev(join(j.dir, name));
      expect(existsSync(join(j.dir, name))).toBe(false);
      expect(r.code).toBe(2);
    }
    const worlds = join(scratch('dev-mixed-worlds'), 'dev-out'), records = join(scratch('dev-mixed-records'), 'dev-out');
    mkdirSync(join(worlds, 'set', 'worlds', 'bg1-001'), { recursive: true });
    mkdirSync(join(records, 'render'), { recursive: true });
    writeFileSync(join(records, 'render', 'bg1-002.json'), '{}');
    for (const out of [worlds, records]) {
      const r = dev(out);
      expect(existsSync(join(out, 'set', 'worlds', 'bg1-dev-01'))).toBe(false);
      expect(r.code).toBe(2);
      expect(r.err).toContain('holds a sealed bg1-NNN entry under set/worlds or render/');
    }
  }, 240_000);

  // Value: protects=a dev render's model replies never land where Git could pick them up; fails_when=render.ts --dev takes an explicit --cache inside a checkout while its --set sits outside, and real mode creates that cache directory there; why_new=the Opus fix-check on 12256467..806fc1ba, INFO item 5; seam=render.ts --dev, real mode against a dead loopback proxy inside a scratch ledger's window, and --fake; no_claim=the sealed path's cache, which mint.sh puts under its custody --out
  test('render.ts --dev refuses a --cache inside a checkout before it opens a client or renders, and takes one outside', async () => {
    const dir = scratch('dev-cache'), set = join(dir, 'set');
    const inRepo = join(REPO, 'eval', 'data', 'changing-facts-v1', 'dev-cache-must-not-exist');
    const port = await freePort(0);
    const ready = (name: string, bg1: Record<string, string>) => { const p = join(dir, name); writeFileSync(p, JSON.stringify({ env: { bg1 } })); return p; };
    const proxies = { BG1_GEMINI_READY: ready('gemini.json', { GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${port}/gemini`, GEMINI_API_KEY: 'mpwp-bg1-dead' }),
      BG1_ANTHROPIC_READY: ready('anthropic.json', { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/anthropic`, ANTHROPIC_API_KEY: 'mpwp-bg1-dead' }) };
    const ledgerPath = join(dir, 'ledger.sqlite');
    initLedger({ ledgerPath, programCapUsd: 5, reason: 'dev cache test' });
    const window = ['--paid-window', 'bg1-test', '--window-cap-usd', '5', '--budget-ledger', ledgerPath, '--budget-run-id', BudgetRun.open({ runner: 'bg1-dev-cache-test', budgetUsd: 2, ledgerPath }).runId];
    const base = [RENDER, '--dev', 'bg1-dev-01', '--set', set, '--target-tokens', '4000'];
    try {
      const real = run('bun', [...base, '--cache', inRepo, ...window], proxies);
      expect(existsSync(inRepo)).toBe(false);
      expect(real.code).toBe(2);
      expect(real.err).toContain('--cache must sit outside any git checkout');
      const fake = run('bun', [...base, '--fake', '--cache', inRepo]);
      expect(existsSync(join(set, 'worlds'))).toBe(false);
      expect(fake.code).toBe(2);
      expect(fake.err).toContain('--cache must sit outside any git checkout');
    } finally { rmSync(inRepo, { recursive: true, force: true }); }
    const ok = run('bun', [...base, '--fake', '--cache', join(dir, 'render-cache')]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('bg1-render world=bg1-dev-01 status=written ');
  }, 120_000);

  // Value: protects=a dev world is rendered only from the plan and gold committed for it; fails_when=render.ts plans a dev world and spends on it while the committed plan.json or questions.json differs from that plan, or is missing; why_new=BG1 follow-up fix 8; seam=render.ts main with a counting fake Models and a scratch copy of the committed dev worlds; no_claim=the generator's own determinism (changing-facts-gen.ts check)
  test('a committed dev plan or questions file that differs or is missing refuses before any model call', async () => {
    const worlds = join(scratch('dev-tamper'), 'worlds');
    cpSync(renderTs.BG1_DEV_WORLDS, worlds, { recursive: true });
    let calls = 0;
    const counting = (plan: WorldPlan): Models => {
      const m = fakeModels(plan);
      return { renderer: m.renderer, render: (...a) => { calls++; return m.render(...a); }, check: (...a) => { calls++; return m.check(...a); } };
    };
    const set = join(scratch('dev-tamper-out'), 'set');
    const go = () => renderTs.main(['--dev', 'bg1-dev-01', '--set', set, '--target-tokens', '4000'], {}, counting, worlds);
    const plan = join(worlds, 'bg1-dev-01', 'plan.json'), questions = join(worlds, 'bg1-dev-01', 'questions.json');
    const original = { plan: readFileSync(plan, 'utf8'), questions: readFileSync(questions, 'utf8') };
    writeFileSync(plan, original.plan.replace('"sessions"', '"sessions" '));
    await expect(go()).rejects.toThrow("bg1-dev-01's plan.json differs from the committed");
    writeFileSync(plan, original.plan);
    writeFileSync(questions, original.questions.replace(/"answer": "/, '"answer": "x'));
    await expect(go()).rejects.toThrow("bg1-dev-01's questions.json differs from the committed");
    rmSync(questions);
    await expect(go()).rejects.toThrow("bg1-dev-01's questions.json differs from the committed");
    expect(calls).toBe(0);
    expect(existsSync(set)).toBe(false);
    writeFileSync(questions, original.questions);
    expect((await go()).status).toBe('written');
    expect(calls).toBeGreaterThan(0);
  }, 120_000);

  // Value: protects=a real dev render spends only inside the granted window, behind each world's own pair of metering proxies on one ledger; fails_when=mint.sh --dev starts a proxy or render.ts without the window, or renders a dev world behind another world's proxies or on another ledger; why_new=BG1 follow-up fix 8; seam=the bun stub, which records each call and runs nothing, placeholder keys; no_claim=the window check's, the proxies' or render.ts's own behaviour
  test('real-mode --dev without the window refuses before any proxy starts; inside it, each world gets its own pair of proxies on one ledger', () => {
    const s = stubbed('dev-real');
    const none = s.mint(['--dev', '--out', 'dev-out']);
    expect(none.code).toBe(2);
    expect(none.err).toContain('real mode spends real keys, so it needs --paid-window');
    expect(s.calls()).toEqual([]);
    expect(run('bun', [RENDER, '--dev', 'bg1-dev-01', '--set', join(s.j.dir, 'render-set')]).err).toContain('bg1-render refused: bg1 render spends real keys');

    const r = s.mint(['--dev', '--out', 'dev-out', ...s.window]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('bg1-mint summary=dev mode=real worlds=3 written=3 skipped=0');
    const calls = s.calls(), here = realpathSync(s.j.dir);
    const name = (args: string) => args.split(' ')[0].split('/').at(-1);
    expect(calls.map(([, args]) => name(args))).toEqual(['paid-window.ts', ...BG1_DEV_CONVERSATIONS.flatMap(() => ['harness-metering-proxy.ts', 'harness-metering-proxy.ts', 'render.ts']), 'render.ts', 'render.ts', 'render.ts']);
    BG1_DEV_CONVERSATIONS.forEach((id, k) => {
      const [gemini, anthropic, render] = calls.slice(1 + 3 * k, 4 + 3 * k).map(([, args]) => args);
      expect(gemini).toContain(`--cell-id bg1-${id}-gemini `);
      expect(anthropic).toContain(`--cell-id bg1-${id}-anthropic `);
      expect(render).toContain(`--dev ${id} --set ${join(here, 'dev-out', 'set')} `);
      expect(render).toContain('--paid-window bg1-test');
      expect(calls[10 + k][1]).toContain(`--dev-report ${id} --set ${join(here, 'dev-out', 'set')} --budget-ledger `);
    });
    for (const [dir, args] of calls) {
      if (name(args) === 'render.ts') expect(dir).toBe(join(here, 'dev-out'));
      expect(args).not.toMatch(/--seed-file|--phrasing|--slot/);
    }
    expect(ledgerArgs(calls)).toEqual([join(here, 'ledgers', 'ledger.sqlite')]);
    expect(r.out + r.err + readFileSync(s.log, 'utf8')).not.toContain('not-real');
  });

  // Value: protects=the spend mint.sh --dev reports per world is that world's two proxies' requests in the ledger run, at their settled cost; fails_when=devReport counts another world's or another run's requests, or drops a request settled at its reservation; why_new=BG1 follow-up fix 8; seam=a scratch ledger with reservations under the proxies' descriptions; no_claim=the proxies' pricing
  test('--dev-report gives a world\'s attempts and its own proxies\' requests and spend in the ledger run', () => {
    const dir = scratch('dev-report'), set = join(dir, 'set'), ledgerPath = join(dir, 'ledger.sqlite');
    mkdirSync(join(set, 'render'), { recursive: true });
    writeFileSync(join(set, 'render', 'bg1-dev-01.json'), JSON.stringify({ world: 'bg1-dev-01', status: 'written', attempts: 7, regenerated: 2 }));
    initLedger({ ledgerPath, programCapUsd: 10, reason: 'devReport test' });
    const run1 = BudgetRun.open({ runner: 'bg1-dev-report-test', budgetUsd: 5, ledgerPath });
    const run2 = BudgetRun.open({ runner: 'bg1-dev-report-test', budgetUsd: 5, ledgerPath });
    const book = (r: BudgetRun, cell: string, reserved: number, actual: number | null) => r.settle(r.reserve(reserved, `gemini:gemini-3.8-flash chat (proxy ${cell}/bg1)`), actual === null ? null : { usd: actual, input_tokens: 1, output_tokens: 1 });
    book(run1, 'bg1-bg1-dev-01-gemini', 0.5, 0.25);
    book(run1, 'bg1-bg1-dev-01-anthropic', 0.2, null);
    book(run1, 'bg1-bg1-dev-02-gemini', 0.5, 0.4);
    book(run2, 'bg1-bg1-dev-01-gemini', 0.5, 0.3);
    const report = renderTs.devReport(['--dev-report', 'bg1-dev-01', '--set', set, '--budget-ledger', ledgerPath, '--budget-run-id', run1.runId]);
    expect(report).toBe('bg1-render world=bg1-dev-01 report status=written attempts=7 regenerated=2 requests=2 spend_usd=0.4500 unreconciled=1');
    expect(renderTs.devReport(['--dev-report', 'bg1-dev-02', '--set', set])).toBe('bg1-render world=bg1-dev-02 report record=missing');
    expect(() => renderTs.devReport(['--dev-report', 'bg1-dev-01', '--set', set, '--budget-ledger', ledgerPath])).toThrow('usage: --dev-report');
  });
});

// ─── the deterministic check and the render loop ─────────────────────

describe('checkSession and renderWorld', () => {
  const dev = JSON.parse(readFileSync(join(REPO, 'eval/data/changing-facts-v1/dev/worlds/bg1-dev-01/plan.json'), 'utf8')) as WorldPlan;
  const briefs = renderBriefs(dev, 4000);
  const at = dev.sessions.findIndex(s => s.lines.some(l => l.position === 'middle'));
  const turns = () => renderTemplateSession(dev, dev.sessions[at], briefs[at].target_tokens);
  const value = Object.keys(dev.lexicon).find(v => !dev.sessions[at].lines.some(l => l.values.includes(v)))!;

  test('every session of the committed template fixtures passes the deterministic check', () => {
    for (const id of BG1_DEV_CONVERSATIONS) {
      const plan = JSON.parse(readFileSync(join(REPO, `eval/data/changing-facts-v1/dev/worlds/${id}/plan.json`), 'utf8')) as WorldPlan;
      const world = JSON.parse(readFileSync(join(REPO, `eval/data/changing-facts-v1/fixtures/worlds/${id}/world.json`), 'utf8')) as World;
      const fixtureBriefs = renderBriefs(plan, BG1_FIXTURE_TOKENS);
      expect(world.sessions).toHaveLength(plan.sessions.length);
      world.sessions.forEach((s, k) => expect(checkSession(fixtureBriefs[k], s.turns)).toEqual([]));
    }
  });

  test('a template session passes, and each broken rule fails its own gate', () => {
    expect(checkSession(briefs[at], turns())).toEqual([]);
    const t = turns();
    const li = t.findIndex(x => x.content.includes(briefs[at].lines[0].text));
    const edit = (f: (ts: Turn[]) => void) => { const ts = structuredClone(t); f(ts); return checkSession(briefs[at], ts); };
    expect(edit(ts => { ts[li].content = 'Nothing much to say.'; })).toContain('line_missing');
    expect(edit(ts => { ts[0].content += ' ' + briefs[at].lines[0].text; })).toContain('line_repeated');
    expect(edit(ts => { ts.splice(li, 2); ts.splice(0, 0, t[li], t[li + 1]); })).toContain('line_position');
    expect(edit(ts => { ts[1].content += ` Also ${value}.`; })).toEqual(['value_outside']);
    const alias = Object.entries(dev.lexicon).find(([, l]) => l.implications.length && !dev.sessions[at].lines.some(x => x.text.includes(l.implications[0])))!;
    expect(edit(ts => { ts[1].content += ` I love ${alias[1].implications[0]}.`; })).toEqual(['value_outside']);
    expect(edit(ts => { ts[1].content += ' See you on [[D:-3]].'; })).toEqual(['date_token']);
    expect(edit(ts => { ts[1].content += ' See you on [[D:-3].'; })).toEqual(['date_token']);
    expect(edit(ts => { ts[1].content += ' See you on March 4.'; })).toEqual(['raw_date']);
    expect(edit(ts => { ts[1].content += ' See you Tuesday.'; })).toEqual(['raw_date']);
    expect(edit(ts => { ts[1].content += ' Back in 2024 it was different.'; })).toEqual(['raw_date']);
    expect(edit(ts => { ts[li].speaker = 'assistant'; })).toEqual(['shape']);
    expect(checkSession(briefs[at], null)).toEqual(['shape']);
    expect(checkSession({ ...briefs[at], target_tokens: 5000 }, t)).toEqual(['length']);
  });

  test('the prompts carry the planned lines, the forbidden terms and the date rules', () => {
    const prompt = renderPrompt(briefs[at], 1, ['value_outside']);
    for (const l of briefs[at].lines) expect(prompt).toContain(l.text);
    expect(prompt).toContain(value);
    expect(prompt).toContain(`[[W:${briefs[at].day}]]`);
    expect(prompt).toContain('attempt 2');
    expect(renderPrompt(briefs[at], 0, [])).not.toContain('attempt');
    expect(checkPrompt(briefs[at], turns())).toContain('{"extra_claims": true} or {"extra_claims": false}');
  });

  const renderSchema = (minItems: number, maxItems: number) => ({ type: 'object', properties: { turns: { type: 'array', minItems, maxItems, items: { type: 'object', properties: { speaker: { type: 'string', enum: ['user', 'assistant'] }, content: { type: 'string' } }, required: ['speaker', 'content'], additionalProperties: false } } }, required: ['turns'], additionalProperties: false });
  /** The turns a session asks for: N, the even number nearest target / 47 and at least 2 × (lines + 1) and 4, to N + 2·max(1, floor(0.05N)). */
  const turnRange = (b: RenderBrief) => { const n = Math.max(4, 2 * (b.lines.length + 1), 2 * Math.round(b.target_tokens / 47 / 2)); return [n, n + 2 * Math.max(1, Math.floor(0.05 * n))] as const; };
  const checkSchema = { type: 'object', properties: { extra_claims: { type: 'boolean' } }, required: ['extra_claims'], additionalProperties: false };

  // Value: protects=Gemini's render and check requests ask for the reply's JSON shape, and the Haiku check has room to answer after thinking; fails_when=a render or Gemini check request goes out without generationConfig.responseJsonSchema, or the Haiku check asks for fewer than 2048 output tokens; why_new=stage 1's first real dev render (09b3f414): 6 shape failures, 5 of them broken JSON, and 3 empty Haiku replies at max_tokens 256; seam=geminiProxyClient and haikuProxyClient through clientModels against a loopback server that records each request body; no_claim=how well gemini-3.8-flash follows a schema
  test('Gemini render and check requests carry a responseJsonSchema, and the Haiku check asks for 2048 tokens', async () => {
    const bodies: Array<{ path: string; body: { generationConfig?: Record<string, unknown>; max_tokens?: number } }> = [];
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
      const path = new URL(req.url).pathname;
      bodies.push({ path, body: await req.json() });
      return Response.json(path.startsWith('/gemini') ? { candidates: [{ content: { parts: [{ text: '{"extra_claims": false}' }] } }] } : { content: [{ type: 'text', text: '{"extra_claims": false}' }] });
    } });
    try {
      const dir = scratch('wire');
      const ready = (name: string, bg1: Record<string, string>) => { const p = join(dir, name); writeFileSync(p, JSON.stringify({ env: { bg1 } })); return p; };
      const models = clientModels(geminiProxyClient(ready('gemini.json', { GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${server.port}/gemini`, GEMINI_API_KEY: 'mpwp-bg1-wire' })),
        haikuProxyClient(ready('anthropic.json', { ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}/anthropic`, ANTHROPIC_API_KEY: 'mpwp-bg1-wire' })));
      await models.render(briefs[at], 0, []);
      await models.check(CHECK_MODELS[0], briefs[at], turns());
      await models.check(CHECK_MODELS[1], briefs[at], turns());
    } finally { server.stop(true); }
    expect(bodies.map(b => b.path)).toEqual(['/gemini/v1beta/models/gemini-3.8-flash:generateContent', '/gemini/v1beta/models/gemini-3.8-flash:generateContent', '/anthropic/v1/messages']);
    const [render, gemini, haiku] = bodies;
    expect(render.body.generationConfig?.responseJsonSchema).toEqual(renderSchema(...turnRange(briefs[at])));
    expect(render.body.generationConfig).toMatchObject({ responseMimeType: 'application/json', temperature: 1 });
    expect(render.body.generationConfig?.responseSchema).toBeUndefined();
    expect(gemini.body.generationConfig?.responseJsonSchema).toEqual(checkSchema);
    expect(gemini.body.generationConfig).toMatchObject({ responseMimeType: 'application/json', maxOutputTokens: 256, temperature: 0 });
    expect(haiku.body.max_tokens).toBe(2048);
  });

  // Value: protects=the render prompt states each session's length as words and a range of turns, and a short session regenerates with its measured length and the allowed range in words; fails_when=the prompt gives the length only in tokens or no range of turns, or a regeneration after a length failure does not name the last attempt's length; why_new=stage 1's first real dev render (09b3f414): 15 length failures, sessions at about 450 to 1,500 tokens against targets of 757 to 3,236; seam=clientModels over a fake ModelClient that records each request, with renderWorld; no_claim=how long gemini-3.8-flash writes
  test('the render prompt states the length in words and turns, and a length failure regenerates with its measured length, then passes', async () => {
    expect(renderPrompt({ ...briefs[at], target_tokens: 1121, lines: [] }, 0, [])).toContain('Write about 940 words (about 1121 tokens) in total, as 24 to 26 alternating turns starting with the user, each about 39 words.');
    expect(renderPrompt({ ...briefs[at], target_tokens: 3236, lines: [] }, 0, [])).toContain('Write about 2720 words (about 3236 tokens) in total, as 68 to 74 alternating turns');
    expect(renderPrompt({ ...briefs[at], target_tokens: 400, lines: briefs[at].lines.slice(0, 1).concat(briefs[at].lines.slice(0, 1), briefs[at].lines.slice(0, 1)) }, 0, [])).toContain('Write about 340 words (about 400 tokens) in total, as 8 to 10 alternating turns');
    expect(renderPrompt({ ...briefs[at], target_tokens: 300, lines: briefs[at].lines.slice(0, 1).concat(briefs[at].lines.slice(0, 1), briefs[at].lines.slice(0, 1)) }, 0, [])).toContain('Write about 250 words (about 300 tokens) in total, as 8 to 10 alternating turns');
    const small = { ...dev, sessions: dev.sessions.slice(0, 12) } as WorldPlan;
    const target = 12_000;
    const sized = renderBriefs(small, target);
    expect(sized.some(b => b.tracked)).toBe(true);
    const calls: Array<{ id: string; prompt: string; max: number; temperature: number; schema?: object }> = [];
    let reply = '';
    const client = (id: string): ModelClient => ({ id, async complete(prompt, max, temperature, schema) { calls.push({ id, prompt, max, temperature, schema }); return temperature === 1 ? reply : '{"extra_claims": false}'; } });
    const real = clientModels(client(CHECK_MODELS[0]), client(CHECK_MODELS[1]));
    const short = renderTemplateSession(small, small.sessions[0], 50);
    const measured = short.reduce((n, t) => n + encodingCount('cl100k_base', t.content), 0);
    expect(sized[0].target_tokens).toBeGreaterThanOrEqual(400);
    expect(measured).toBeLessThan(0.6 * sized[0].target_tokens);
    const seen: RenderBrief[] = [];
    const models: Models = { renderer: real.renderer, check: real.check, render(brief, attempt, failures, lastTokens) {
      seen.push(brief);
      const i = small.sessions.findIndex(s => s.id === brief.session);
      reply = JSON.stringify({ turns: i === 0 && attempt === 0 ? short : renderTemplateSession(small, small.sessions[i], brief.target_tokens) });
      return real.render(brief, attempt, failures, lastTokens);
    } };
    const out = await renderWorld(small, models, { targetTokens: target, concurrency: 1 });
    const renders = calls.filter(c => c.temperature === 1);
    const words = (tokens: number) => Math.round((tokens * 0.84) / 10) * 10;
    const range = `between ${Math.ceil((0.6 * sized[0].target_tokens * 0.84) / 10) * 10} and ${Math.floor((1.5 * sized[0].target_tokens * 0.84) / 10) * 10} words`;
    expect(renders[1].prompt).toContain(`This is attempt 2. The last attempt broke these rules: The last attempt was about ${words(measured)} words (${measured} tokens); the session must be ${range}, so aim for about ${words(sized[0].target_tokens)}.`);
    expect(renders[0].prompt).toContain(`Write about ${words(sized[0].target_tokens)} words (about ${sized[0].target_tokens} tokens) in total, as ${turnRange(sized[0]).join(' to ')} alternating turns`);
    expect(out.world).not.toBeNull();
    expect(out.stats.regenerated).toBe(1);
    expect(out.stats.failures).toEqual({ length: 1 });
    expect(renders).toHaveLength(small.sessions.length + 1);
    renders.forEach((c, k) => expect(c.schema).toEqual(renderSchema(...turnRange(seen[k]))));
    const checks = calls.filter(c => c.temperature === 0);
    expect(checks.filter(c => c.id === CHECK_MODELS[0]).map(c => [c.max, c.schema])).toEqual(checks.filter(c => c.id === CHECK_MODELS[0]).map(() => [256, checkSchema]));
    expect(checks.filter(c => c.id === CHECK_MODELS[1]).length).toBeGreaterThan(0);
    for (const c of checks.filter(x => x.id === CHECK_MODELS[1])) expect([c.max, c.schema]).toEqual([2048, undefined]);
  });

  // Value: protects=every BG1 session asks for a turn range that keeps it inside the length gate at the measured 36 to 58 tokens a turn, and leaves each planned line its own user turn; fails_when=the render schema or prompt carries no turn range or one off the rule, a range's N × 36 falls under 0.6 times its target or its top × 58 passes 1.5 times it, or a range holds fewer than 2 × (lines + 1) turns; why_new=stage 1's second real dev render (4ec6a610): gemini-3.8-flash kept to the turn count at a median of about 47 tokens a turn but wrote about 0.69 of the target, and 13 of its 36 attempts failed the length gate; seam=clientModels over a fake ModelClient that records each render request, for every target from 757 to 3,236 and every brief of the three dev worlds at BG1_TARGET_TOKENS; no_claim=how long gemini-3.8-flash writes, or that it honours minItems and maxItems
  test('every target from 757 to 3,236 and every dev brief asks for a turn range that fits the length gate at 36 to 58 tokens a turn', async () => {
    const sent: Array<{ prompt: string; schema?: object }> = [];
    const client: ModelClient = { id: CHECK_MODELS[0], async complete(prompt, _max, _temperature, schema) { sent.push({ prompt, schema }); return ''; } };
    const models = clientModels(client, client);
    const sweep: RenderBrief[] = Array.from({ length: 3236 - 757 + 1 }, (_, k) => ({ ...briefs[at], target_tokens: 757 + k, lines: [] }));
    const devBriefs = BG1_DEV_CONVERSATIONS.flatMap(id => renderBriefs(JSON.parse(readFileSync(join(REPO, `eval/data/changing-facts-v1/dev/worlds/${id}/plan.json`), 'utf8')) as WorldPlan, BG1_TARGET_TOKENS));
    expect(devBriefs).toHaveLength(467);
    expect(devBriefs.every(b => b.target_tokens >= 400)).toBe(true);
    const wrong: string[] = [];
    let low = Infinity, high = 0;
    for (const b of [...sweep, ...devBriefs]) {
      sent.length = 0;
      await models.render(b, 0, []);
      const turns = (sent[0].schema as { properties: { turns: { minItems?: number; maxItems?: number } } }).properties.turns;
      const n = turns.minItems ?? 0, top = turns.maxItems ?? Infinity;
      const [ruleN, ruleTop] = turnRange(b);
      if (n !== ruleN || top !== ruleTop || n < 2 * (b.lines.length + 1) || !sent[0].prompt.includes(`as ${n} to ${top} alternating turns starting with the user, each about 39 words.`)) wrong.push(`${b.session} at ${b.target_tokens}`);
      low = Math.min(low, (n * 36) / b.target_tokens);
      high = Math.max(high, (top * 58) / b.target_tokens);
    }
    expect(wrong).toEqual([]);
    expect(low).toBeGreaterThanOrEqual(0.6);
    expect(high).toBeLessThanOrEqual(1.5);
    expect([757, 997, 1082, 3236].map(t => turnRange({ ...briefs[at], target_tokens: t, lines: [] }))).toEqual([[16, 18], [22, 24], [24, 26], [68, 74]]);
  });

  // Value: protects=a cached reply is reused only for the same request, schema included, and no reply cached before the method changes is reused; fails_when=cachedClient's key leaves out the schema, or a v1-keyed reply is still found; why_new=the renderer method changes after 09b3f414 (requests now carry a schema); seam=cachedClient over a counting fake client, with a cache directory holding a v1-keyed reply; no_claim=caching in the metering proxies (they keep none)
  test('the render cache keys on the schema and reuses no reply cached under v1', async () => {
    const dir = scratch('cache');
    let n = 0;
    const base: ModelClient = { id: CHECK_MODELS[0], async complete() { n++; return `reply ${n}`; } };
    writeFileSync(join(dir, `${sha(['bg1-render-cache/v1', base.id, '256', '0', 'the prompt'].join('\u0000'))}.txt`), 'cached under v1');
    const cache = cachedClient(base, dir);
    const a = { type: 'object' }, b = { type: 'object', required: ['x'] };
    expect(await cache.complete('the prompt', 256, 0, a)).toBe('reply 1');
    expect(await cache.complete('the prompt', 256, 0, a)).toBe('reply 1');
    expect(await cache.complete('the prompt', 256, 0, b)).toBe('reply 2');
    expect(await cache.complete('the prompt', 256, 0)).toBe('reply 3');
    expect(n).toBe(3);
  });

  // Value: protects=a high-thinking request is never served the reply to the same prompt at low thinking, the level reaches the client, and no reply cached before thinking levels joined the key is reused; fails_when=cachedClient's key leaves out the thinking level, the level is not passed on, or a v2-keyed reply is still found; why_new=method change 3 (GBEV-3, 2026-11-09) renders long sessions and every re-render at high thinking, with prompts a low-thinking request has already sent; seam=cachedClient over a counting fake client that records each level, with a cache directory holding a v2-keyed reply; no_claim=caching in the metering proxies (they keep none)
  test('the render cache keys on the thinking level, passes it on, and reuses no reply cached under v2', async () => {
    const dir = scratch('cache-thinking');
    const levels: Array<string | undefined> = [];
    const base: ModelClient = { id: CHECK_MODELS[0], async complete(_prompt, _max, _temperature, _schema, thinking) { levels.push(thinking); return `reply ${levels.length}`; } };
    const schema = { type: 'object' };
    writeFileSync(join(dir, `${sha(['bg1-render-cache/v2', base.id, '256', '1', JSON.stringify(schema), 'the prompt'].join('\u0000'))}.txt`), 'cached under v2');
    const cache = cachedClient(base, dir);
    expect(await cache.complete('the prompt', 256, 1, schema, 'low')).toBe('reply 1');
    expect(await cache.complete('the prompt', 256, 1, schema, 'high')).toBe('reply 2');
    expect(await cache.complete('the prompt', 256, 1, schema, 'low')).toBe('reply 1');
    expect(await cache.complete('the prompt', 256, 1, schema, 'high')).toBe('reply 2');
    expect(levels).toEqual(['low', 'high']);
  });

  // Value: protects=--fake mode, which the keyless tests and drills run, renders what it rendered before the method changes; fails_when=the schema, length or regeneration changes reach fakeModels or what renderWorld returns in --fake; why_new=the renderer method changes after stage 1's first real dev render (09b3f414); seam=render.ts --dev --fake at the fixture size against the committed template fixture; no_claim=the real renderer's output
  test('--fake output is unchanged: a dev world at the fixture size matches the committed template fixture, with no regeneration', () => {
    const set = join(scratch('fake-same'), 'set');
    const r = run('bun', [RENDER, '--dev', 'bg1-dev-01', '--fake', '--set', set, '--target-tokens', String(BG1_FIXTURE_TOKENS)]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^bg1-render world=bg1-dev-01 status=written sessions=(\d+) attempts=\1 regenerated=0 checks=\d+ failures=none tokens=\d+ world_sha256=[0-9a-f]{16}\n$/);
    const world = JSON.parse(readFileSync(join(set, 'worlds', 'bg1-dev-01', 'world.json'), 'utf8')) as World;
    const fixture = JSON.parse(readFileSync(join(REPO, 'eval/data/changing-facts-v1/fixtures/worlds/bg1-dev-01/world.json'), 'utf8')) as World;
    expect(world.renderer).toBe('fake-template');
    expect(world.sessions).toEqual(fixture.sessions);
  });

  test('a check that finds extra claims regenerates; an unreadable verdict counts as a failure; four failures drop the world', async () => {
    const small = { ...dev, sessions: dev.sessions.slice(0, 12) } as WorldPlan;
    const base = fakeModels(small);
    const tracked = renderBriefs(small, 400).find(b => b.tracked)!.session;
    let haiku = 0;
    const flaky: Models = { ...base, async check(model, brief, ts) { if (model.startsWith('anthropic') && brief.session === tracked && haiku++ < 2) return haiku === 1 ? '{"extra_claims": true}' : 'no idea'; return base.check(model, brief, ts); } };
    const ok = await renderWorld(small, flaky, { targetTokens: 400, concurrency: 1 });
    expect(ok.world).not.toBeNull();
    expect(ok.stats.regenerated).toBe(2);
    expect(ok.stats.failures).toEqual({ 'extra_claims:anthropic:claude-haiku-5-5': 1, 'check_unreadable:anthropic:claude-haiku-5-5': 1 });
    const never: Models = { ...base, async check(model) { return model.startsWith('gemini') ? '{"extra_claims": true}' : '{"extra_claims": false}'; } };
    const dropped = await renderWorld(small, never, { targetTokens: 400, concurrency: 1 });
    expect(dropped.world).toBeNull();
    expect(dropped.stats.dropped_session).toBe(0);
    expect(dropped.stats.attempts).toBe(4);
  });

  // Value: protects=an unreadable Gemini check reply is asked once more, with its own closing line and cache key, and fails the attempt only when the second reply is unreadable too, while a readable verdict and the Haiku check are never asked again; fails_when=renderWorld fails an attempt on Gemini's first unreadable reply, the second ask is not the same request plus the closing line, the cache serves it the first reply, stats.checks leaves it out, or a readable verdict or a Haiku reply is asked again; why_new=stage 1's second real dev render (4ec6a610): 2 Gemini check replies were the literal "Here is the JSON requested:\n" despite responseJsonSchema, and each failed its attempt; seam=renderWorld over fakeModels' renderer and clientModels' checks, with Gemini behind cachedClient over fake ModelClients that record each request; no_claim=how often gemini-3.8-flash answers the second ask readably
  test('an unreadable Gemini check reply is asked once more with a closing line and its own cache key, and only a second unreadable reply fails the attempt', async () => {
    const small = { ...dev, sessions: dev.sessions.slice(0, 12) } as WorldPlan;
    const fake = fakeModels(small);
    const closing = '\nReply with only the JSON object, with no other text.';
    const ok = '{"extra_claims": false}', unreadable = 'Here is the JSON requested:\n';
    type Sent = Array<{ prompt: string; max: number; temperature: number; schema?: object }>;
    const client = (id: string, sent: Sent, reply: (prompt: string, sent: Sent) => string): ModelClient => ({ id, async complete(prompt, max, temperature, schema) { sent.push({ prompt, max, temperature, schema }); return reply(prompt, sent); } });
    const render = async (gem: (prompt: string, sent: Sent) => string, hai: (prompt: string, sent: Sent) => string = () => ok, cache = false) => {
      const gemini: Sent = [], haiku: Sent = [];
      const g = client(CHECK_MODELS[0], gemini, gem);
      const real = clientModels(cache ? cachedClient(g, scratch('reask')) : g, client(CHECK_MODELS[1], haiku, hai));
      return { ...(await renderWorld(small, { ...fake, check: real.check }, { targetTokens: 400, concurrency: 1 })), gemini, haiku };
    };
    const clean = await render(() => ok);
    expect(clean.stats.failures).toEqual({});
    expect(clean.haiku.length).toBeGreaterThan(0);

    const once = await render((_p, sent) => (sent.length === 1 ? unreadable : ok), undefined, true);
    expect(once.world).not.toBeNull();
    expect(once.stats.failures).toEqual({});
    expect(once.stats.regenerated).toBe(0);
    expect(once.stats.checks).toBe(clean.stats.checks + 1);
    expect(once.gemini).toHaveLength(clean.gemini.length + 1);
    expect(once.gemini[1]).toEqual({ prompt: once.gemini[0].prompt + closing, max: 256, temperature: 0, schema: checkSchema });
    expect(once.gemini.filter(c => c.prompt.endsWith(closing))).toHaveLength(1);

    const twice = await render((p, sent) => (p.endsWith(closing) ? (sent.filter(c => c.prompt.endsWith(closing)).length === 1 ? unreadable : ok) : p === sent[0].prompt ? unreadable : ok));
    expect(twice.world).not.toBeNull();
    expect(twice.stats.failures).toEqual({ 'check_unreadable:gemini:gemini-3.8-flash': 1 });
    expect(twice.stats.regenerated).toBe(1);
    expect(twice.stats.checks).toBe(clean.stats.checks + 3);

    const claims = await render((_p, sent) => (sent.length === 1 ? '{"extra_claims": true}' : ok));
    expect(claims.stats.failures).toEqual({ 'extra_claims:gemini:gemini-3.8-flash': 1 });
    expect(claims.stats.checks).toBe(clean.stats.checks + 1);
    expect(claims.gemini.some(c => c.prompt.endsWith(closing))).toBe(false);

    const haikuOff = await render(() => ok, (_p, sent) => (sent.length === 1 ? unreadable : ok));
    expect(haikuOff.stats.failures).toEqual({ 'check_unreadable:anthropic:claude-haiku-5-5': 1 });
    expect(haikuOff.stats.checks).toBe(clean.stats.checks + 2);
    expect([...haikuOff.gemini, ...haikuOff.haiku].some(c => c.prompt.endsWith(closing))).toBe(false);
  });
});

// ─── the sealed key ──────────────────────────────────────────────────

/** A sealed-key path glob as gstack-pregate reads it: * and ? within a segment, ** across directories. */
function globRe(glob: string, ci: boolean): RegExp {
  let re = '';
  for (let k = 0; k < glob.length; k++) {
    const c = glob[k];
    if (c === '*' && glob[k + 1] === '*') { if (glob[k + 2] === '/') { re += '(?:.*/)?'; k += 2; } else { re += '.*'; k += 1; } }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, ci ? 'i' : '');
}

describe('BG1\'s block of the sealed key in .gstack/pregate.json', () => {
  const sealed = JSON.parse(readFileSync(join(REPO, '.gstack/pregate.json'), 'utf8')).sealed as { paths: string[]; answer_markers: string[]; seed_patterns: string[]; case_insensitive: boolean };
  const pathHit = (rel: string) => sealed.paths.some(g => globRe(g, sealed.case_insensitive).test(rel));
  const textRules = [...sealed.answer_markers, ...sealed.seed_patterns].map(r => new RegExp(r));
  const textHit = (text: string) => text.split('\n').some(line => textRules.some(re => re.test(line)));

  test('covers the custody output, seed files and phrasing sets, the custody marker and the seed format, distinct from the dev seeds', () => {
    expect(sealed.paths).toEqual(expect.arrayContaining(['**/bg1-custody*', '**/bg1-custody*/**', '**/*.bg1-seed', '**/*.bg1-phrasing.json']));
    expect(sealed.paths).toEqual(expect.arrayContaining(['**/rs1-custody*', '**/rs1-custody*/**', '**/*.rs1-seed']));
    expect(sealed.answer_markers.some(r => new RegExp(r).test(`"custody": "${BG1_CUSTODY_MARKER}"`))).toBe(true);
    expect(sealed.seed_patterns.some(r => new RegExp(r).test(seedLine('any seed')))).toBe(true);
    for (const s of Object.values(BG1_DEV_SEEDS)) expect(textHit(s)).toBe(false);
    for (const p of ['bg1-custody/set/worlds/bg1-001/world.json', 'x/BG1-Custody-a/render/bg1-001.json', 'keys/main.bg1-seed', 'a/b/house.bg1-phrasing.json']) expect(pathHit(p)).toBe(true);
  });

  test('every committed dev world, plan and gold file, and BG1\'s code and tests, pass it', () => {
    const committed = [...files(join(REPO, 'eval/data/changing-facts-v1')), ...files(join(REPO, 'eval/custody/bg1')), join(REPO, 'eval/generators/changing-facts-gen.ts'),
      join(REPO, 'eval/runner/memory-qa/corpus.ts'), join(REPO, 'eval/decisions/datasets/bg1-manifest.json'), join(REPO, 'eval/decisions/splits/bg1.json'), join(REPO, 'eval/decisions/splits/bg1-dev.json'),
      join(REPO, '.gstack/pregate.json'), import.meta.path, join(REPO, 'test/eval/bg1-generator.test.ts'), join(REPO, 'test/eval/bg1-loader.test.ts')];
    expect(committed.length).toBeGreaterThan(15);
    for (const path of committed) {
      expect(pathHit(relative(REPO, path))).toBe(false);
      expect(textHit(readFileSync(path, 'utf8'))).toBe(false);
    }
  });

  test('a sealed fixture is refused by its path and, under any name, by the marker in each of its files', () => {
    const j = inputs('sealed-key');
    const out = join(j.dir, 'bg1-custody-s');
    expect(mint(out, j, ['--fake', '--count', '1']).code).toBe(0);
    for (const path of files(join(out, 'set'))) {
      expect(pathHit(relative(j.dir, path))).toBe(true);
      expect(textHit(readFileSync(path, 'utf8'))).toBe(true);
      expect(pathHit(`eval/data/innocent/${path.split('/').pop()}`)).toBe(false);
    }
    expect(pathHit(relative(j.dir, j.seed)) && textHit(readFileSync(j.seed, 'utf8'))).toBe(true);
    expect(pathHit(relative(j.dir, j.phrasing)) && textHit(readFileSync(j.phrasing, 'utf8'))).toBe(true);
  }, 120_000);
});
