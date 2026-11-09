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
import { BG1_CUSTODY_MARKER, BG1_DEV_SEEDS, BG1_FIXTURE_TOKENS, PUBLIC_PHRASING, renderBriefs, renderTemplateSession, sealedWorldSeed, type Turn, type World, type WorldPlan } from '../../eval/generators/changing-facts-gen.ts';
import { BG1_DEV_CONVERSATIONS } from '../../eval/runner/bg1/types.ts';
import { checkPrompt, checkSession, fakeModels, proxyEndpoint, renderPrompt, renderWorld, type Models } from '../../eval/custody/bg1/render.ts';
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
    for (const r of [missing, open, noHaiku]) expect(r.all).not.toContain('not-real');
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
    expect([...r.out.matchAll(/^bg1-render world=(\S+) status=written /gm)].map(m => m[1])).toEqual(BG1_DEV_CONVERSATIONS);
    expect([...r.out.matchAll(/^bg1-render world=(\S+) report status=written attempts=\d+ regenerated=0$/gm)].map(m => m[1])).toEqual(BG1_DEV_CONVERSATIONS);
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
