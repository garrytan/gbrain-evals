/**
 * The keyless W10 re-score: verdicts come from stored judge replies, reader
 * errors are wrong, and the W8 control applies its ratio rule and signal floor.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rescore, scoreArm } from '../../eval/runner/batch/w10-rescore.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'w10-rescore-')); dirs.push(d); return d; };

const row = (id: string, ok: boolean, extra: Record<string, unknown> = {}) => ({
  question_id: id, question_type: 'multi-session', hypothesis: 'h', finish: 'stop', error: null, usd: 0.01, usage: { input_tokens: 100, output_tokens: 10 },
  official: { verdict: ok, raw: ok ? 'Yes.' : 'No', error: null }, secondary: { verdict: ok, raw: ok ? 'yes' : 'no', error: null }, ...extra,
});
const write = (dir: string, rows: unknown[]) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'rows.ndjson'), rows.map(r => JSON.stringify(r)).join('\n') + '\n'); };

test('verdicts are recomputed from the stored replies; reader and judge errors count as wrong', () => {
  const d = tmp();
  write(d, [
    row('a', true), row('b', false),
    row('c', true, { error: 'reader_max_tokens', finish: 'max_tokens' }),
    row('d', true, { official: { verdict: null, raw: null, error: 'judge_errored' } }),
    row('e', false, { official: { verdict: false, raw: 'YES, it is correct', error: null } }),
  ]);
  const s = scoreArm(d);
  expect([...s.values()].map(x => x.official)).toEqual([1, 0, 0, 0, 1]);
  expect(s.get('c')!.secondary).toBe(0);
});

test('W8: the control passes at degraded <= 0.5 x real, and is inconclusive below the signal floor', () => {
  const w10b = tmp(), w8 = tmp();
  const ids = Array.from({ length: 100 }, (_, i) => `q${String(i).padStart(3, '0')}`);
  write(join(w10b, 'arms', 'w10b-sonnet55-notes'), ids.map((id, i) => row(id, i < 90)));
  write(join(w8, 'arms', 'w8-lme-swap'), ids.map((id, i) => row(id, i < 20)));
  write(join(w8, 'arms', 'w8-lme-partial'), ids.slice(0, 50).map((id, i) => row(id, i < 30)));
  const out = rescore('w8', w8, w10b) as any;
  expect([out.real_correct, out.degraded_correct, out.control]).toEqual([90, 20, 'pass']);
  expect(out.partial_fault).toMatchObject({ n: 50, real_correct: 50, fault_correct: 30 });
  write(join(w8, 'arms', 'w8-lme-swap'), ids.map((id, i) => row(id, i < 60)));
  expect((rescore('w8', w8, w10b) as any).control).toBe('fail');
  write(join(w10b, 'arms', 'w10b-sonnet55-notes'), ids.map((id, i) => row(id, i < 40)));
  expect((rescore('w8', w8, w10b) as any).control).toBe('inconclusive');
});
