/**
 * Test preload: no test can see a real provider key.
 *
 * Every bun test process starts with the provider keys removed from its environment, so a test that forgets to blank
 * them, or falls back to the environment with `process.env.X || 'dummy'`, can never send a request a provider bills.
 * Bun.spawn and Bun.spawnSync otherwise hand a child the environment the process started with, keys included, so they
 * default to the cleaned process.env here; node:child_process already does. A test that needs a key sets a placeholder.
 */
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'PARTICLE_API_KEY', 'VOYAGE_API_KEY']) delete process.env[k];
const withEnv = <T extends (...a: any[]) => any>(spawn: T): T => ((cmd: any, opts?: any) => (Array.isArray(cmd)
  ? spawn(cmd, { ...opts, env: opts?.env ?? { ...process.env } })
  : spawn({ ...cmd, env: cmd?.env ?? { ...process.env } }))) as T;
Bun.spawn = withEnv(Bun.spawn);
Bun.spawnSync = withEnv(Bun.spawnSync);
