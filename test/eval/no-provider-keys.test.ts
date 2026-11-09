import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { KEY_ENV } from '../../eval/runner/metering-proxy.ts';
import { BG1_GEMINI_KEY_ENV } from '../../eval/runner/q1/cell.ts';
import { PROVIDER_KEYS } from '../support/no-provider-keys.ts';


// Value: protects=no test reaches a real provider, whatever keys the shell holds; fails_when=a bun test process, or a child it spawns with Bun.spawn, Bun.spawnSync, Bun.$ or node:child_process, sees a provider key from the shell that started it; why_new=GBEV-3 rule 1 (2026-11-08) after a possible unwindowed judge call; seam=none; no_claim=Python tests (test:py)
test('a bun test started from a shell holding provider keys sees none of them, and neither do its children', () => {
  const root = join(import.meta.dir, '..', '..');
  const shell = { ...process.env, ...Object.fromEntries(PROVIDER_KEYS.map(k => [k, `shell-held-${k.toLowerCase()}`])) };
  const r = Bun.spawnSync(['bun', 'test', './test/fixtures/no-provider-keys/probe.ts'], { cwd: root, env: shell, stdout: 'pipe', stderr: 'pipe' });
  expect(r.stderr.toString()).toContain(' 1 pass');
  expect(r.exitCode).toBe(0);
}, 60_000);

// Value: protects=no test reaches BG1's Gemini judge with the custody host's own key; fails_when=the preload leaves BG1_GEMINI_API_KEY (cell.ts BG1_GEMINI_KEY_ENV, the key BG1's lease proxies and re-reads hand Gemini) or a key variable the lease proxy routes (KEY_ENV) set; why_new=#398 open note 8; seam=none; no_claim=key names the repository's other runners read outside the lease proxy
test('the preload blanks BG1\'s own Gemini key and every key variable the lease proxy routes', () => {
  expect([BG1_GEMINI_KEY_ENV, ...Object.values(KEY_ENV)].filter(k => !PROVIDER_KEYS.includes(k))).toEqual([]);
  expect(process.env[BG1_GEMINI_KEY_ENV]).toBe('');
});
