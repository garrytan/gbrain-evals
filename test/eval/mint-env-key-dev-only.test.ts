/**
 * GBEV-3's condition for #627: mint.sh takes Gemini's key from GEMINI_API_KEY only for a --dev mint, which renders public worlds.
 * Every sealed real-mode mint (BG1, BG1-C and Set W, the custody sets) still refuses that key and reads only the owner-only key
 * file. Keyless: bun is a stub on PATH that records each call and runs nothing, the provider keys are placeholders or blanked, and
 * the base URLs point at a closed local port.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BG1_CUSTODY_MARKER, PUBLIC_PHRASING } from '../../eval/generators/changing-facts-gen.ts';

const MINT = join(resolve(import.meta.dir, '../..'), 'eval/custody/bg1/mint.sh');
const roots: string[] = [];
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });
const DEAD = 'http://127.0.0.1:9';
const ENV_KEY = 'test-gemini-env-key-not-real';
const KEY_FILE_ONLY = 'only from BG1_GEMINI_API_KEY in ~/.config/gbrain-evals/bg1.env';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'mint-env-key-')); roots.push(dir);
  const bin = join(dir, 'bin'), home = join(dir, 'home'), log = join(dir, 'bun-calls.log');
  mkdirSync(bin); mkdirSync(home); mkdirSync(join(dir, 'ledgers'));
  writeFileSync(join(bin, 'bun'), ['#!/usr/bin/env bash', `printf '%s\\t%s\\n' "\${GEMINI_API_KEY:+gemini-key}" "$*" >> ${JSON.stringify(log)}`,
    'case "$1" in',
    '  *bgw-checks.ts) [ "$2" = length ] && echo 200000 || echo "bgw-checks batch set=W1 slots=56" ;;',
    '  *harness-metering-proxy.ts) while [ $# -gt 1 ]; do [ "$1" = --ready-file ] && printf "{}" > "$2"; shift; done ;;',
    '  *render.ts) echo "bg1-render world=x status=written" ;;',
    'esac', 'exit 0', ''].join('\n'));
  chmodSync(join(bin, 'bun'), 0o755);
  const files = (kind: 'bg1' | 'bgw') => {
    const seed = join(dir, `test.${kind}-seed`), phrasing = join(dir, `test.${kind}-phrasing.json`);
    writeFileSync(seed, `${[kind, 'seed', 'v1'].join('-')}:${'ab'.repeat(32)}\n`);
    writeFileSync(phrasing, JSON.stringify({ ...PUBLIC_PHRASING, custody: BG1_CUSTODY_MARKER }));
    chmodSync(seed, 0o600); chmodSync(phrasing, 0o600);
    return ['--seed-file', seed, '--phrasing', phrasing];
  };
  const mint = (args: string[]) => {
    rmSync(log, { force: true });
    const r = spawnSync('bash', [MINT, ...args, '--paid-window', 'test-window', '--window-cap-usd', '5', '--budget-ledger', 'ledgers/ledger.sqlite', '--budget-run-id', 'r1'], {
      cwd: dir, encoding: 'utf8', timeout: 60_000,
      env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: home, GEMINI_API_KEY: ENV_KEY, BG1_GEMINI_API_KEY: '', GOOGLE_API_KEY: '', GOOGLE_GENERATIVE_AI_API_KEY: '',
        ANTHROPIC_API_KEY: 'test-anthropic-key-not-real', OPENAI_API_KEY: '', GOOGLE_GEMINI_BASE_URL: DEAD, ANTHROPIC_BASE_URL: DEAD, OPENAI_BASE_URL: DEAD } });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').replace(/\n$/, '').split('\n').map(l => l.split('\t')) : [];
    return { code: r.status, all: (r.stdout ?? '') + (r.stderr ?? ''), calls };
  };
  return { dir, files, mint };
}

describe('mint.sh: GEMINI_API_KEY is a --dev-only key route', () => {
  // Value: protects=a sealed real-mode mint of any custody set never takes Gemini's key from the environment, so the env route GBEV-3 approved for the public long dev worlds cannot reach a custody render; fails_when=mint.sh reads GEMINI_API_KEY for a BG1, BG1-C or Set W real mint, or starts a metering proxy without the key file; why_new=GBEV-3's condition on #627 ("a custody or real-mode mint must still refuse an env key"); seam=a bun stub on PATH that records calls and runs nothing, placeholder keys, dead base URLs; no_claim=the proxies' or render.ts's own key handling
  test('BG1, BG1-C and Set W real mints refuse an env key and start no proxy; only --dev takes it, for the Gemini proxy', () => {
    const h = harness();
    const sealed = [
      ['--out', join(h.dir, 'bg1-custody-env'), ...h.files('bg1'), '--count', '1'],
      ['--bg1c', '--out', join(h.dir, 'bg1-custody-env-c'), ...h.files('bg1'), '--start', '31', '--count', '1'],
      ['--bgw', '--batch', String(1000 + 1), '--out', join(h.dir, 'bgw-custody-env'), ...h.files('bgw'), '--start', String(1000 + 1), '--count', '1', '--target-tokens', '200000'],
    ];
    for (const args of sealed) {
      const r = h.mint(args);
      expect(r.code).toBe(2);
      expect(r.all).toContain(KEY_FILE_ONLY);
      expect(r.calls.some(([, a]) => a.includes('harness-metering-proxy.ts') || a.includes('render.ts'))).toBe(false);
      expect(r.all).not.toContain('not-real');
    }
    const dev = h.mint(['--dev', '--out', 'dev-out', '--worlds', 'bg1-dev-long-01']);
    expect(dev.code).toBe(0);
    expect(dev.all).toContain('summary=dev mode=real worlds=1 written=1 skipped=0 gemini_key_var=GEMINI_API_KEY');
    const proxies = dev.calls.filter(([, a]) => a.split(' ')[0].endsWith('harness-metering-proxy.ts'));
    expect(proxies.map(([seen, a]) => [seen, / --cell-id \S+-gemini /.test(` ${a} `)])).toEqual([['gemini-key', true], ['', false]]);
    expect(dev.calls.filter(([, a]) => a.split(' ')[0].endsWith('render.ts')).every(([seen]) => seen === '')).toBe(true);
    expect(dev.all).not.toContain('not-real');
  }, 120_000);
});
