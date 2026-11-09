import { expect, test } from 'bun:test';
import { join } from 'node:path';

const PROVIDER_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'PARTICLE_API_KEY', 'VOYAGE_API_KEY'];

// Value: protects=no test reaches a real provider, whatever keys the shell holds; fails_when=a bun test process, or a child it spawns with Bun.spawn, Bun.spawnSync, Bun.$ or node:child_process, sees a provider key from the shell that started it; why_new=GBEV-3 rule 1 (2026-11-08) after a possible unwindowed judge call; seam=none; no_claim=Python tests (test:py)
test('a bun test started from a shell holding provider keys sees none of them, and neither do its children', () => {
  const root = join(import.meta.dir, '..', '..');
  const shell = { ...process.env, ...Object.fromEntries(PROVIDER_KEYS.map(k => [k, `shell-held-${k.toLowerCase()}`])) };
  const r = Bun.spawnSync(['bun', 'test', './test/fixtures/no-provider-keys/probe.ts'], { cwd: root, env: shell, stdout: 'pipe', stderr: 'pipe' });
  expect(r.stderr.toString()).toContain(' 1 pass');
  expect(r.exitCode).toBe(0);
}, 60_000);
