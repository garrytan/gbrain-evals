/** Per-reader token calibration from dev smoke cells (eval/runner/q1/calibrate.ts), on a synthetic cell output. */
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calibrate, calibrationSamples } from '../../eval/runner/q1/calibrate.ts';
import { encodingCount } from '../../eval/runner/systems/render.ts';

const tmp = mkdtempSync(join(tmpdir(), 'q1-calibrate-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test('each packed answer pairs the local count of its exact prompt with the provider count; other outcomes and unknown contexts are skipped', () => {
  const run = join(tmp, 'runs', 's3-smoke.x.recipe');
  mkdirSync(join(run, 'r', 'rid'), { recursive: true });
  const prompts = ['Session one: Ana met Bo in Lisbon.\nQuestion: where?', 'A much longer context. '.repeat(200)];
  writeFileSync(join(run, 'contexts.ndjson'), prompts.map((p, i) => JSON.stringify({ key: `k${i}`, prompt: p, meta: { context_sha256: `c${i}` } }) + '\n').join(''));
  const local = prompts.map(p => encodingCount('cl100k_base', p));
  const answers = [
    { reader: 'anthropic:claude-sonnet-5-5', context_sha256: 'c0', provider_input_tokens: Math.round(local[0] * 1.5), outcome: 'scored' },
    { reader: 'anthropic:claude-sonnet-5-5', context_sha256: 'c1', provider_input_tokens: Math.round(local[1] * 1.5), outcome: 'scored' },
    { reader: 'anthropic:claude-sonnet-5-5', context_sha256: 'c1', provider_input_tokens: null, outcome: 'reader_error' },
    { reader: 'anthropic:claude-sonnet-5-5', context_sha256: 'whole-history', provider_input_tokens: 99_999, outcome: 'scored' },
    { reader: 'openai:gpt-6.1-sol', context_sha256: 'c1', provider_input_tokens: encodingCount('o200k_base', prompts[1]), outcome: 'scored' },
  ];
  writeFileSync(join(run, 'r', 'rid', 'answers.ndjson'), answers.map(a => JSON.stringify(a) + '\n').join(''));
  const samples = calibrationSamples(tmp);
  expect(samples).toHaveLength(3);
  const c = calibrate(samples);
  expect(c['anthropic:claude-sonnet-5-5']).toMatchObject({ encoding: 'cl100k_base', samples: 2, needs_provider_count: false });
  expect(c['anthropic:claude-sonnet-5-5'].factor).toBeCloseTo(1.5, 2);
  expect(c['openai:gpt-6.1-sol']).toMatchObject({ encoding: 'o200k_base', factor: 1, max_error: 0, samples: 1 });
  expect(calibrationSamples(join(tmp, 'missing'))).toEqual([]);
});
