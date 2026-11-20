// Run by test/eval/no-provider-keys-gbrain-home.test.ts as its own bun test process, with HOME holding a gbrain config
// whose provider keys are fake and GBRAIN_HOME unset: fails if gbrain, in this process or in a child, reads that config.
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { loadConfig } from 'gbrain/config';

const heldKeys = "const c = loadConfig() ?? {}; console.log(JSON.stringify(Object.keys(c).filter(k => k.endsWith('_api_key') && String(c[k]).startsWith('config-held'))))";

test('gbrain reads no config from the home directory, here or in a child', () => {
  const home = process.env.GBRAIN_HOME ?? '';
  expect(isAbsolute(home)).toBe(true);
  expect(home.startsWith(process.env.HOME ?? '/nonexistent')).toBe(false);
  expect(existsSync(join(home, '.gbrain', 'config.json'))).toBe(false);
  const c = (loadConfig() ?? {}) as Record<string, unknown>;
  expect(Object.keys(c).filter(k => k.endsWith('_api_key') && c[k])).toEqual([]);
  const child = Bun.spawnSync(['bun', '-e', `import { loadConfig } from 'gbrain/config'; ${heldKeys}`], { stdout: 'pipe', stderr: 'pipe' });
  expect(JSON.parse(child.stdout.toString())).toEqual([]);
});
