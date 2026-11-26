/**
 * The verdict rules of the multi-writer behavior suite (eval/runner/multi-writer/classify.ts) and its report. The suite
 * itself needs a gbrain build and real engines, so it runs as a runner, not here; these tests pin how its results are
 * judged: a typed refusal is not_supported, wrong data is a fail, lease and fence failures are counted apart, and a
 * switch-on run passes only when the running engine proved multi-user mode.
 */
import { describe, expect, test } from 'bun:test';
import { combineStatus, isConflict, judgeSwitch, mergeTally, MOVED_UNDER_WRITE, normalizeForParity, outcomeClass, percentile, phaseStatus, recordReadFailure, tallyOps } from '../../eval/runner/multi-writer/classify.ts';
import { childEnv } from '../../eval/runner/multi-writer/brain.ts';
import { errorCodeOf, type OpLine } from '../../eval/runner/multi-writer/worker.ts';
import { asJson } from '../../eval/runner/multi-writer/scenarios.ts';
import { firstDifference, renderReport, type Receipt } from '../../eval/runner/multi-writer-behavior.ts';

const line = (o: Partial<OpLine>): OpLine => ({ kind: 'op', lane: 0, i: 0, op: 'put_page', tag: 't', ok: true, t0: 0, t1: 1, ms: 1, ...o });

describe('tallyOps and phaseStatus', () => {
  test('acknowledged writes pass; a typed refusal is not_supported, not a fail', () => {
    expect(phaseStatus(tallyOps([line({}), line({})]), [])).toBe('pass');
    const t = tallyOps([line({}), line({ ok: false, code: 'engine_capability_missing' })]);
    expect(t.refused).toEqual({ engine_capability_missing: 1 });
    expect(phaseStatus(t, [])).toBe('not_supported');
  });

  test('wrong data fails even when every write was acknowledged', () => {
    expect(phaseStatus(tallyOps([line({})]), ['a tag is missing'])).toBe('fail');
  });

  test('an untyped error fails, and a lease or fence failure is counted as the write-lock bug', () => {
    const t = tallyOps([line({ ok: false, code: 'internal_error' }), line({ ok: false, code: 'write_pending', request_id: 'r1', lease_fence: true })]);
    expect(t.errors.internal_error!.count).toBe(1);
    expect(t.pending_never_applied).toBe(1);
    expect(t.write_lock_bug).toBe(1);
    expect(phaseStatus(t, [])).toBe('fail');
  });

  test('a pending write that committed later counts as acknowledged; an expected error counts as neither', () => {
    const t = tallyOps([line({ ok: false, code: 'write_pending', request_id: 'r1' }), line({ ok: false, code: 'page_not_found' })], { applied: new Set(['r1']), expectedError: l => l.code === 'page_not_found' });
    expect(t.acked).toBe(1);
    expect(t.errors).toEqual({});
  });

  test('a lost race is judged by code, never by free text inside an untyped error', () => {
    expect(isConflict('revision_conflict')).toBe(true);
    expect(isConflict('invalid_params', `{"message":"${MOVED_UNDER_WRITE}"}`)).toBe(true);
    expect(isConflict('internal_error', 'expected revision no longer matches')).toBe(false);
    const t = tallyOps([line({ ok: false, code: 'internal_error', message: 'revision no longer matches' })]);
    expect(phaseStatus(t, [])).toBe('fail');
  });

  test('a store owner that went away is not_supported, kept apart, and survives a merge', () => {
    const a = tallyOps([line({ ok: false, code: 'owner_unavailable', message: 'The process that owns this brain exited' })]);
    expect(a.handoff).toEqual({ owner_unavailable: 1 });
    expect(phaseStatus(a, [])).toBe('not_supported');
    const merged = mergeTally(tallyOps([line({})]), a);
    expect(merged.handoff).toEqual({ owner_unavailable: 1 });
    expect(merged.total).toBe(2);
    expect(phaseStatus(merged, [])).toBe('not_supported');
  });

  test('a failed read-back never counts as the data being gone', () => {
    const t = tallyOps([]);
    recordReadFailure(t, { ok: false, code: 'page_not_found', op: 'get_page' }, true);
    expect(phaseStatus(t, [])).toBe('pass');
    recordReadFailure(t, { ok: false, code: 'internal_error', op: 'search', message: 'boom' }, true);
    expect(phaseStatus(t, [])).toBe('fail');
    const u = tallyOps([]);
    recordReadFailure(u, { ok: false, code: 'page_not_found', op: 'get_page' }, false);
    expect(phaseStatus(u, [])).toBe('fail');
  });

  test('combineStatus: fail beats not_supported beats pass, and an invalid run marks every check invalid', () => {
    expect(combineStatus(['pass', 'not_supported'])).toBe('not_supported');
    expect(combineStatus(['not_supported', 'fail'])).toBe('fail');
    expect(combineStatus(['pass', 'pass'])).toBe('pass');
    expect(combineStatus(['pass'], true)).toBe('invalid');
  });
});

describe('judgeSwitch: the proof comes from the running engine', () => {
  const owner = (multiuser: boolean, session: string) => ({ store_open: true, role: 'owner', store_multiuser: multiuser, session_probe: session });

  test('on is proven only by an owner store that says multiuser and reaches the token check', () => {
    expect(judgeSwitch('rust', 'on', [owner(true, 'reached_store_mint')]).verdict).toBe('on_proven');
    expect(judgeSwitch('rust', 'on', [owner(false, 'refused_multiuser_off')]).verdict).toBe('invalid');
    expect(judgeSwitch('rust', 'on', [owner(true, 'refused_multiuser_off')]).verdict).toBe('invalid');
    expect(judgeSwitch('rust', 'on', [{ store_open: false, role: 'client' }]).verdict).toBe('invalid');
  });

  test('off is proven by owner stores that say not multiuser; other engines have no switch', () => {
    expect(judgeSwitch('rust', 'off', [owner(false, 'refused_multiuser_off')]).verdict).toBe('off_proven');
    expect(judgeSwitch('rust', 'off', [owner(true, 'reached_store_mint')]).verdict).toBe('invalid');
    expect(judgeSwitch('postgres', 'off', []).verdict).toBe('not_applicable');
  });

  test('the child environment carries the switch exactly as asked and no provider key', () => {
    const on = childEnv({ home: '/h', userHome: '/u', switchSetting: 'on', env: { PATH: '/bin', OPENAI_API_KEY: 'x', GBRAIN_RUST_MULTIUSER: '1' } });
    const off = childEnv({ home: '/h', userHome: '/u', switchSetting: 'off', env: { PATH: '/bin', GBRAIN_RUST_MULTIUSER: '1' } });
    expect(on.GBRAIN_RUST_MULTIUSER).toBe('1');
    expect('GBRAIN_RUST_MULTIUSER' in off).toBe(false);
    expect(Object.keys(on).some(k => /KEY|TOKEN_SECRET/.test(k) && k !== 'GBRAIN_HTTP_RATE_LIMIT_TOKEN')).toBe(false);
    expect(on.GBRAIN_HOME).toBe('/h');
  });
});

describe('helpers', () => {
  test('percentile is nearest-rank and null on no data', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 100], 95)).toBe(100);
    expect(percentile([], 50)).toBeNull();
  });

  test('normalizeForParity drops timestamps, uuids, timings and paths but keeps the rest', () => {
    const a = normalizeForParity({ ms: 3, at: '2026-11-26T00:00:00.000Z', rev: '41b13e31-4131-4018-b3a6-9f238ec93f47', path: '/w/x/brain', n: 2 }, ['/w/x']);
    expect(a).toEqual({ at: '<ts>', ms: '<volatile>', n: 2, path: '<work>/brain', rev: '<uuid>' });
  });

  test('outcomeClass, asJson and errorCodeOf read gbrain output shapes', () => {
    expect(outcomeClass({ ok: true, result: [1, 2] })).toBe('ok:2');
    expect(outcomeClass({ ok: false, code: 'invalid_params' })).toBe('refused:invalid_params');
    expect(asJson('[{"slug":"a"}]\n[gbrain search] Rows are a ranked top-K')).toEqual([{ slug: 'a' }]);
    expect(errorCodeOf('{ "error": "page_not_found", "code": "page_not_found" }')).toBe('page_not_found');
  });

  test('firstDifference names the first differing path', () => {
    expect(firstDifference({ a: [1, 2] }, { a: [1, 2] })).toBeNull();
    expect(firstDifference({ a: [1, 2] }, { a: [1, 3] })).toStartWith('$.a[1]');
  });

  test('renderReport flags a check 7 outcome that differs between engines', () => {
    const r = (engine: 'pglite' | 'postgres', v: string): Receipt => ({
      schema: 'gbrain-evals.multi-writer-behavior.v1', started_at: '', finished_at: '', engine, switch_requested: null,
      gbrain: { version: '1', commit: 'abcdef1234567', overlay: null, rust_addon: null }, gbrain_evals_commit: null, writers: 2, rounds: 1, config: {},
      switch_proof: { requested: 'off', probes: [], verdict: 'not_applicable', reason: '' }, status_by_check: {},
      checks: [{ id: 'c7_access', title: 'Access', status: 'pass', phases: [], cross_engine: { 'numeric: search limit -1': v } }],
      latency: {}, write_lock_bug_failures: 0, serial: { sha256: '', transcript: null },
    });
    expect(renderReport([r('pglite', 'ok:0'), r('postgres', 'refused:invalid_params')])).toContain('**DIFFERENT**');
    expect(renderReport([r('pglite', 'ok:0'), r('postgres', 'ok:0')])).not.toContain('**DIFFERENT**');
  });
});
