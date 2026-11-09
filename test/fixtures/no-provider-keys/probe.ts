// Run by test/eval/no-provider-keys.test.ts as its own bun test process: fails if this process, or a child it spawns, sees a provider key.
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

const PROVIDER_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'PARTICLE_API_KEY', 'VOYAGE_API_KEY'];
const seen = `console.log(JSON.stringify(${JSON.stringify(PROVIDER_KEYS)}.filter(k => process.env[k] !== undefined)))`;

test('no provider key in this process or its children', async () => {
  expect(PROVIDER_KEYS.filter(k => process.env[k] !== undefined)).toEqual([]);
  expect(JSON.parse(Bun.spawnSync(['bun', '-e', seen], { stdout: 'pipe' }).stdout.toString())).toEqual([]);
  expect(JSON.parse(Bun.spawnSync({ cmd: ['bun', '-e', seen], stdout: 'pipe' }).stdout.toString())).toEqual([]);
  expect(JSON.parse(await new Response(Bun.spawn(['bun', '-e', seen], { stdout: 'pipe' }).stdout).text())).toEqual([]);
  expect(JSON.parse(await Bun.$`bun -e ${seen}`.text())).toEqual([]);
  expect(JSON.parse(spawnSync('bun', ['-e', seen]).stdout.toString())).toEqual([]);
});
