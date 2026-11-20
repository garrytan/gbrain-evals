import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');
const home = mkdtempSync(join(tmpdir(), 'gbrain-home-config-'));
mkdirSync(join(home, '.gbrain'));
writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(home, 'none.pglite'), openai_api_key: 'config-held-openai', anthropic_api_key: 'config-held-anthropic' }) + '\n');
afterAll(() => rmSync(home, { recursive: true, force: true }));
const shell = () => { const env: Record<string, string | undefined> = { ...process.env, HOME: home }; delete env.GBRAIN_HOME; return env; };
const heldKeys = "import { loadConfig } from 'gbrain/config'; const c = loadConfig() ?? {}; console.log(JSON.stringify(Object.keys(c).filter(k => k.endsWith('_api_key') && String(c[k]).startsWith('config-held'))))";

// Value: protects=no test reaches a real provider through the machine's own gbrain config; fails_when=the preload leaves GBRAIN_HOME unset, so gbrain fills the blanked keys from ~/.gbrain/config.json (gbrain's mergedProviderEnv drops empty env values); why_new=GBEV-3's decision on #394's deferred preload note (2026-11-09), BG1 custody runs on a host with that file; seam=HOME; no_claim=configs gbrain reads from a cwd .env or a database plane
test('outside a test, gbrain fills blanked keys from ~/.gbrain/config.json; inside one, the preload hides that config', () => {
  const bare = Bun.spawnSync(['bun', '-e', heldKeys], { cwd: root, env: { ...shell(), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }, stdout: 'pipe', stderr: 'pipe' });
  expect(JSON.parse(bare.stdout.toString())).toEqual(['openai_api_key', 'anthropic_api_key']);
  const r = Bun.spawnSync(['bun', 'test', './test/fixtures/no-provider-keys/gbrain-home-probe.ts'], { cwd: root, env: shell(), stdout: 'pipe', stderr: 'pipe' });
  expect(r.stderr.toString()).toContain(' 1 pass');
  expect(r.exitCode).toBe(0);
}, 60_000);
