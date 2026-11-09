// Run by test/eval/no-provider-keys.test.ts as its own bun test process: fails if this process, or a child it spawns,
// sees a provider key, including a child started in a directory whose .env holds one.
import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROVIDER_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'PARTICLE_API_KEY', 'VOYAGE_API_KEY'];
const seen = `console.log(JSON.stringify(${JSON.stringify(PROVIDER_KEYS)}.filter(k => process.env[k])))`;
const dotenvDir = mkdtempSync(join(tmpdir(), 'no-provider-keys-'));
writeFileSync(join(dotenvDir, '.env'), PROVIDER_KEYS.map(k => `${k}=dotenv-held-${k.toLowerCase()}`).join('\n') + '\n');
afterAll(() => rmSync(dotenvDir, { recursive: true, force: true }));

test('no provider key in this process or its children', async () => {
  expect(PROVIDER_KEYS.filter(k => process.env[k])).toEqual([]);
  expect(JSON.parse(Bun.spawnSync(['bun', '-e', seen], { stdout: 'pipe' }).stdout.toString())).toEqual([]);
  expect(JSON.parse(Bun.spawnSync({ cmd: ['bun', '-e', seen], stdout: 'pipe' }).stdout.toString())).toEqual([]);
  expect(JSON.parse(await new Response(Bun.spawn(['bun', '-e', seen], { stdout: 'pipe' }).stdout).text())).toEqual([]);
  expect(JSON.parse(await Bun.$`bun -e ${seen}`.text())).toEqual([]);
  expect(JSON.parse(spawnSync('bun', ['-e', seen]).stdout.toString())).toEqual([]);
  expect(JSON.parse(Bun.spawnSync(['bun', '-e', seen], { cwd: dotenvDir, stdout: 'pipe' }).stdout.toString())).toEqual([]);
});
