/** Per-reader token calibration from dev smoke cells (eval/runner/q1/calibrate.ts), on a synthetic cell output. */
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calibrate, calibrationSamples } from '../../eval/runner/q1/calibrate.ts';
import { calibrationCell } from '../../eval/runner/q1/calibration-cell.ts';
import { findCell } from '../../eval/runner/q1/cell.ts';
import { loadManifest } from '../../eval/runner/q1/cells/definitions.ts';
import { encodingCount } from '../../eval/runner/systems/render-v2.ts';

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
  expect(calibrationSamples(tmp, { encoding: 'o200k_base' }).map(s => s.local)).toEqual([encodingCount('o200k_base', prompts[0]), encodingCount('o200k_base', prompts[1]), encodingCount('o200k_base', prompts[1])]);
});

// Value: protects=a calibration run reads dev data with the one reader it calibrates; fails_when=it could run a counted (sealed) cell, keep the cell's three readers or its frontier judges; why_new=particle-1's Q1 calibration (plan GST-605 Phase 2) runs through this; seam=none; no_claim=the paid run itself
test('a calibration cell is a dev smoke cell\'s packed arm read by one reader, without frontier judges; a cell outside the dev split or without a packed arm is refused', () => {
  const m = loadManifest();
  const def = calibrationCell(findCell('s3-smoke.baseline-hybrid.baseline', m), 'particle:particle-1');
  expect(def.arms).toHaveLength(1);
  expect(def.arms[0]).toMatchObject({ mode: 'packed', budget: 8000, readers: ['particle:particle-1'], reader_replicates: {}, frontier: null });
  expect(() => calibrationCell(findCell('s3-smoke.baseline-full-context.baseline', m), 'particle:particle-1')).toThrow('no packed arm');
  const sealed = m.cells.find(c => c.split !== 'dev' && c.arms.some(a => a.mode === 'packed'))!;
  expect(() => calibrationCell(sealed, 'particle:particle-1')).toThrow('dev data only');
});

test('--pre-normalizer re-derives the provider total from the raw buckets old packed answers stored, per reader convention', () => {
  const out = join(tmp, 'pre');
  const run = join(out, 'runs', 's3-smoke.y.recipe');
  mkdirSync(join(run, 'r', 'rid'), { recursive: true });
  const prompt = 'A packed context. '.repeat(300);
  writeFileSync(join(run, 'contexts.ndjson'), JSON.stringify({ key: 'k', prompt, meta: { context_sha256: 'c' } }) + '\n');
  const o200k = encodingCount('o200k_base', prompt), cl100k = encodingCount('cl100k_base', prompt);
  const answers = [
    { reader: 'openai:gpt-6.1-sol', context_sha256: 'c', usage: { input: o200k, output: 5, cache_read: 1024, cache_write: 0 }, provider_input_tokens: o200k + 1024, outcome: 'scored' },
    { reader: 'anthropic:claude-opus-5-5', context_sha256: 'c', usage: { input: cl100k - 100, output: 5, cache_read: 100, cache_write: 0 }, provider_input_tokens: cl100k, outcome: 'scored' },
  ];
  writeFileSync(join(run, 'r', 'rid', 'answers.ndjson'), answers.map(a => JSON.stringify(a) + '\n').join(''));
  expect(calibrationSamples(out).map(s => s.provider)).toEqual([o200k + 1024, cl100k]);
  expect(calibrationSamples(out, { preNormalizer: true }).map(s => s.provider)).toEqual([o200k, cl100k]);
});
