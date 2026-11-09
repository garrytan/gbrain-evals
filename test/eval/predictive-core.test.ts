import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CAUSE_IDS, CAUSE_MODE, countByCause, isCauseId } from '../../eval/runner/predictive/causes.ts';
import { costPerCorrect, passHatCurve, passHatK, taskPassHatK } from '../../eval/runner/predictive/passk.ts';
import { kendallTau, loadReference, ValidityReferenceError, verdict, type ReferenceFile } from '../../eval/runner/predictive/validity.ts';

const TAXONOMY = resolve(import.meta.dir, '../../eval/runner/failure-causes/taxonomy.ts');

describe('cause ids', () => {
  test('every id maps to a mode entry and counts start at zero', () => {
    expect(Object.keys(CAUSE_MODE).sort()).toEqual([...CAUSE_IDS].sort());
    expect(Object.values(countByCause([])).every((n) => n === 0)).toBe(true);
    expect(countByCause(['stale_fact', 'stale_fact', 'wrong_entity']).stale_fact).toBe(2);
    expect(isCauseId('stale_fact')).toBe(true);
    expect(isCauseId('stale')).toBe(false);
  });

  test.skipIf(!existsSync(TAXONOMY))('matches the failure-cause taxonomy when it is present', async () => {
    const mod = await import(TAXONOMY);
    expect(CAUSE_IDS.filter((id) => id !== mod.UNCLASSIFIED).sort()).toEqual(mod.CAUSES.map((c: { id: string }) => c.id).sort());
    expect(CAUSE_IDS).toContain(mod.UNCLASSIFIED);
  });
});

describe('pass^k', () => {
  test('matches the closed form on small cases', () => {
    expect(taskPassHatK(4, 4, 4)).toBe(1);
    expect(taskPassHatK(3, 4, 4)).toBe(0);
    expect(taskPassHatK(3, 4, 1)).toBeCloseTo(0.75);
    expect(taskPassHatK(3, 4, 2)).toBeCloseTo(0.5);
    expect(passHatK([{ task_id: 'a', successes: 4, trials: 4 }, { task_id: 'b', successes: 2, trials: 4 }], 2)).toBeCloseTo((1 + 1 / 6) / 2);
  });

  test('is non-increasing in k', () => {
    const curve = passHatCurve([{ task_id: 'a', successes: 3, trials: 4 }, { task_id: 'b', successes: 1, trials: 4 }], 4);
    for (let i = 1; i < curve.length; i += 1) expect(curve[i]).toBeLessThanOrEqual(curve[i - 1]);
  });

  test('refuses impossible counts', () => {
    expect(() => taskPassHatK(5, 4, 1)).toThrow();
    expect(() => taskPassHatK(1, 2, 4)).toThrow();
    expect(() => passHatK([], 1)).toThrow();
  });

  test('cost per correct is null with no correct answers', () => {
    expect(costPerCorrect(2, 4)).toBe(0.5);
    expect(costPerCorrect(2, 0)).toBeNull();
  });
});

const ref = (contrasts: ReferenceFile['contrasts']): ReferenceFile => ({ id: 'r', source: 'test', contrasts, orderings: { arms: ['a', 'b', 'c'] } });

describe('verdict', () => {
  const sig = (id: string, est: number) => ({ id, estimate: est, lo: est - 1, hi: est + 1 });
  const wide = (id: string, est: number) => ({ id, estimate: est, lo: -10, hi: 10 });

  test('no reference reads NO_REFERENCE_YET', () => {
    expect(verdict({ mapped: [], reference: null, synthetic: [] }).verdict).toBe('NO_REFERENCE_YET');
  });

  test('every real interval including zero reads NO_REFERENCE_YET, never PREDICTIVE', () => {
    const r = ref([wide('x', 3), wide('y', 2), wide('z', -1)]);
    const out = verdict({ mapped: ['x', 'y', 'z'], reference: r, synthetic: [sig('x', 3), sig('y', 2), sig('z', -2)] });
    expect(out.verdict).toBe('NO_REFERENCE_YET');
    expect(out.qualifying).toEqual([]);
  });

  test('exactly one qualifying contrast is below the minimum', () => {
    const r = ref([sig('x', 5), wide('y', 2), wide('z', 1)]);
    expect(verdict({ mapped: ['x', 'y', 'z'], reference: r, synthetic: [sig('x', 5), sig('y', 2), sig('z', 1)] }).verdict).toBe('NO_REFERENCE_YET');
  });

  test('sign agreement on three qualifying contrasts reads PREDICTIVE', () => {
    const r = ref([sig('x', 5), sig('y', 3), sig('z', -4)]);
    const out = verdict({ mapped: ['x', 'y', 'z'], reference: r, synthetic: [wide('x', 1), sig('y', 2), sig('z', -1)], ordering: { key: 'arms', synthetic: ['a', 'b', 'c'] } });
    expect(out.verdict).toBe('PREDICTIVE');
    expect(out.agree).toEqual(['x', 'y', 'z']);
    expect(out.kendall_tau).toBe(1);
  });

  test('one sign flip reads NOT_PREDICTIVE', () => {
    const r = ref([sig('x', 5), sig('y', 3), sig('z', -4)]);
    expect(verdict({ mapped: ['x', 'y', 'z'], reference: r, synthetic: [sig('x', 5), sig('y', -3), sig('z', -4)] }).disagree).toEqual(['y']);
  });

  test('a significant synthetic contrast against a non-qualifying reference direction reads NOT_PREDICTIVE', () => {
    const r = ref([sig('x', 5), sig('y', 3), sig('z', -4), wide('w', 2)]);
    const out = verdict({ mapped: ['x', 'y', 'z', 'w'], reference: r, synthetic: [sig('x', 5), sig('y', 3), sig('z', -4), sig('w', -5)] });
    expect(out.verdict).toBe('NOT_PREDICTIVE');
    expect(out.disagree).toEqual(['w']);
  });

  test('a preregistered contrast missing from either side throws', () => {
    const r = ref([sig('x', 5)]);
    expect(() => verdict({ mapped: ['q'], reference: r, synthetic: [] })).toThrow();
    expect(() => verdict({ mapped: ['x'], reference: r, synthetic: [], minQualifying: 1 })).toThrow();
  });

  test('kendall tau over reversed and partial orderings', () => {
    expect(kendallTau(['a', 'b', 'c'], ['c', 'b', 'a'])).toBe(-1);
    expect(kendallTau(['a'], ['a'])).toBeNull();
  });
});

describe('reference loading', () => {
  function fixture(body: string, sha?: string, status: 'available' | 'pending' = 'available') {
    const dir = mkdtempSync(join(tmpdir(), 'validity-ref-'));
    writeFileSync(join(dir, 'r.json'), body);
    const digest = sha ?? createHash('sha256').update(body).digest('hex');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify([{ id: 'r', file: 'r.json', sha256: digest, status }]));
    return join(dir, 'manifest.json');
  }
  const good = JSON.stringify({ id: 'r', source: 'test', contrasts: [{ id: 'x', estimate: 1, lo: 0.5, hi: 1.5 }] });

  test('loads a reference whose digest matches', () => {
    expect(loadReference(fixture(good), 'r')?.contrasts[0].id).toBe('x');
  });

  test('a pending reference returns null', () => {
    expect(loadReference(fixture(good, undefined, 'pending'), 'r')).toBeNull();
  });

  test('digest mismatch, corrupt JSON and unknown ids raise a coded error', () => {
    const cases = [() => loadReference(fixture(good, 'f'.repeat(64)), 'r'), () => loadReference(fixture('{nope'), 'r'), () => loadReference(fixture(good), 'other')];
    for (const run of cases) {
      try {
        run();
        throw new Error('expected a throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ValidityReferenceError);
        expect((err as ValidityReferenceError).code).toBe('VALIDITY_REFERENCE_INVALID');
      }
    }
  });

  test('a malformed contrast raises a coded error', () => {
    const bad = JSON.stringify({ id: 'r', source: 'test', contrasts: [{ id: 'x', estimate: 1, lo: 2, hi: 0 }] });
    expect(() => loadReference(fixture(bad), 'r')).toThrow(ValidityReferenceError);
  });
});
