/**
 * Test preload: no test can see a real provider key.
 *
 * Every bun test process starts with the provider keys set to the empty string, so a test that forgets to blank them,
 * or falls back to the environment with `process.env.X || 'dummy'`, can never send a request a provider bills. Blank,
 * not deleted: a child bun process loads .env, .env.local and .env.test from its cwd, and those fill a missing key but
 * never overwrite a set one. Bun.spawn and Bun.spawnSync otherwise hand a child the environment the process started
 * with, keys included, so they default to the cleaned process.env here; node:child_process already does. A test that
 * needs a key sets a placeholder.
 *
 * gbrain fills a blank provider key from its own config file ($GBRAIN_HOME/.gbrain/config.json, else
 * ~/.gbrain/config.json), so GBRAIN_HOME points at a fresh empty directory too, and no test or child sees the
 * config of the machine it runs on. A test that needs a brain home sets its own.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'PARTICLE_API_KEY', 'VOYAGE_API_KEY']) process.env[k] = '';
process.env.GBRAIN_HOME = mkdtempSync(join(tmpdir(), 'no-provider-keys-gbrain-home-'));
const withEnv = <T extends (...a: any[]) => any>(spawn: T): T => ((cmd: any, opts?: any) => (Array.isArray(cmd)
  ? spawn(cmd, { ...opts, env: opts?.env ?? { ...process.env } })
  : spawn({ ...cmd, env: cmd?.env ?? { ...process.env } }))) as T;
Bun.spawn = withEnv(Bun.spawn);
Bun.spawnSync = withEnv(Bun.spawnSync);
