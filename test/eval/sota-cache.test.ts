/**
 * The SOTA outcome cache (eval/runner/sota/cache.ts): every key field makes a row stale, a slot field makes it another
 * slot, a missing row is unknown, and the stale refusal exits 6 with SOTA_CACHE_STALE, the changed inputs, the re-buy
 * command and the paid-window request. Keyless: rows are synthetic and nothing reaches a provider.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CACHE_SCHEMA, freshness, KEY_FIELDS, main, OutcomeCache, projectUsd, rebuyUnit, STALE_EXIT, type Row, type Spec } from '../../eval/runner/sota/cache.ts';
import { SealedIdError } from '../../eval/runner/sota/sealed-guard.ts';

const roots: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'sota-cache-')); roots.push(d); return d; };
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

const SPEC: Spec = {
  kind: 'oracle', benchmark: 'beam-1m', system: 'oracle', reader: 'anthropic:claude-opus-5-5',
  system_version: 'oracle-0001', effort: null, max_tokens: 8192, judge: 'openai:gpt-6-astra', judge_prompt: 'prompt-0001', pass_threshold: 0.5,
  dataset: 'beam-b2da22e', validator_version: 'answerability-0001', harness_digest: 'harness-0001',
};
const row = (item: string, patch: Partial<Row> = {}): Row => ({
  ...SPEC, schema: CACHE_SCHEMA, item, context_digest: `ctx-${item}`, score: 0.75, pass: true, finish_reason: 'stop',
  usage: { reader_input: 20_000, reader_output: 1_000, judge_input: 4_000, judge_output: 100 }, at: '2026-11-20T09:00:00Z', source: 'test', ...patch,
});
/** A value for a key field that differs from SPEC's. */
const other = (f: typeof KEY_FIELDS[number]) => (f === 'max_tokens' ? 4096 : f === 'pass_threshold' ? 0.6 : f === 'effort' ? 'high' : `${SPEC[f]}-old`);

describe('lookup', () => {
  test('a row measured on the spec\'s inputs is a hit', () => {
    const cache = new OutcomeCache(scratch());
    cache.put([row('1m-2:event_ordering:0')]);
    expect(cache.lookup(SPEC, '1m-2:event_ordering:0')).toMatchObject({ status: 'hit', row: { score: 0.75, pass: true } });
  });

  test('each key field, changed alone, makes the row stale and is named', () => {
    for (const f of KEY_FIELDS) {
      const cache = new OutcomeCache(scratch());
      cache.put([row('1m-2:event_ordering:0', { [f]: other(f) })]);
      expect(cache.lookup(SPEC, '1m-2:event_ordering:0')).toMatchObject({ status: 'stale', changed: [f] });
    }
    expect(KEY_FIELDS).toEqual(['system_version', 'effort', 'max_tokens', 'judge', 'judge_prompt', 'pass_threshold', 'dataset', 'validator_version', 'harness_digest']);
  });

  test('the evidence digest counts when the caller supplies one', () => {
    const cache = new OutcomeCache(scratch());
    cache.put([row('1m-2:event_ordering:0')]);
    expect(cache.lookup(SPEC, '1m-2:event_ordering:0', 'ctx-1m-2:event_ordering:0').status).toBe('hit');
    expect(cache.lookup(SPEC, '1m-2:event_ordering:0', 'ctx-rebuilt')).toMatchObject({ status: 'stale', changed: ['context_digest'] });
  });

  test('another item, system, reader or benchmark is another slot: unknown, never stale', () => {
    const cache = new OutcomeCache(scratch());
    cache.put([row('1m-2:event_ordering:0')]);
    expect(cache.lookup(SPEC, '1m-2:event_ordering:1').status).toBe('unknown');
    expect(cache.lookup({ ...SPEC, system: 'grep-agent' }, '1m-2:event_ordering:0').status).toBe('unknown');
    expect(cache.lookup({ ...SPEC, reader: 'openai:gpt-6.1-sol' }, '1m-2:event_ordering:0').status).toBe('unknown');
    expect(cache.lookup({ ...SPEC, benchmark: 'lme-s' }, '1m-2:event_ordering:0').status).toBe('unknown');
    expect(cache.lookup({ ...SPEC, kind: 'leader' }, '1m-2:event_ordering:0').status).toBe('unknown');
  });

  test('an empty cache is unknown everywhere, and freshness counts it', () => {
    const f = freshness(new OutcomeCache(join(scratch(), 'missing')), SPEC, ['a', 'b']);
    expect([f.hits.size, f.unknown, f.stale]).toEqual([0, ['a', 'b'], []]);
  });

  test('old rows stay as history: a re-buy on new inputs is a hit, and going back to the old inputs finds the old row', () => {
    const cache = new OutcomeCache(scratch());
    cache.put([row('x', { judge_prompt: 'prompt-0000', score: 0.25, pass: false })]);
    cache.put([row('x')]);
    expect(cache.lookup(SPEC, 'x')).toMatchObject({ status: 'hit', row: { score: 0.75 } });
    expect(cache.lookup({ ...SPEC, judge_prompt: 'prompt-0000' }, 'x')).toMatchObject({ status: 'hit', row: { score: 0.25 } });
    expect(cache.lookup({ ...SPEC, judge_prompt: 'prompt-0002' }, 'x')).toMatchObject({ status: 'stale', changed: ['judge_prompt'], row: { score: 0.75 } });
  });

  test('an empty answer at the output limit is a hit with no verdict', () => {
    const cache = new OutcomeCache(scratch());
    cache.put([row('x', { score: null, pass: null, finish_reason: 'length' })]);
    expect(cache.lookup(SPEC, 'x')).toMatchObject({ status: 'hit', row: { pass: null, finish_reason: 'length' } });
  });
});

describe('put', () => {
  test('refuses a sealed id, a verdict that disagrees with its score, and rows of mixed kinds', () => {
    const dir = scratch(), cache = new OutcomeCache(dir);
    expect(() => cache.put([row('1m-1:temporal_reasoning:0')])).toThrow(SealedIdError);
    expect(existsSync(join(dir, 'oracle', 'beam-1m.ndjson'))).toBe(false);
    expect(() => cache.put([row('x', { score: 0.25, pass: true })])).toThrow('disagrees with score');
    expect(() => cache.put([row('x', { score: null, pass: true })])).toThrow('disagrees with score');
    expect(() => cache.put([row('x'), row('y', { kind: 'leader' })])).toThrow('one kind and benchmark');
  });

  test('refuses to read a file holding another kind\'s rows', () => {
    const dir = scratch();
    new OutcomeCache(dir).put([row('x')]);
    const path = join(dir, 'oracle', 'beam-1m.ndjson');
    writeFileSync(path, readFileSync(path, 'utf8').replace('"kind":"oracle"', '"kind":"leader"'));
    expect(() => new OutcomeCache(dir).rows('oracle', 'beam-1m')).toThrow('not a sota-cache/1 oracle row for beam-1m');
  });
});

describe('the stale refusal', () => {
  const setup = (rows: Row[]) => {
    const dir = scratch();
    new OutcomeCache(join(dir, 'cache')).put(rows);
    writeFileSync(join(dir, 'spec.json'), JSON.stringify([SPEC]));
    writeFileSync(join(dir, 'items.txt'), 'a\nb\nc\nd\n');
    const out: string[] = [], err: string[] = [];
    const code = main(['check', '--cache', join(dir, 'cache'), '--spec', join(dir, 'spec.json'), '--items', join(dir, 'items.txt')], s => out.push(s), s => err.push(s));
    return { dir, code, out: out.join('\n'), err: err.join('\n') };
  };

  test('exits 6 with SOTA_CACHE_STALE, the changed inputs, the re-buy command and the paid-window request, and lists the items to re-buy', () => {
    const { dir, code, out, err } = setup([row('a', { judge_prompt: 'prompt-0000' }), row('b', { judge_prompt: 'prompt-0000', max_tokens: 4096 }), row('c')]);
    expect(code).toBe(STALE_EXIT);
    expect(out).toBe('oracle beam-1m oracle anthropic:claude-opus-5-5: 1 fresh, 1 unknown, 2 stale');
    const items = join(dir, 'cache', 'rebuy', 'sota-rebuy-oracle-beam-1m-oracle-anthropic_claude-opus-5-5.txt');
    expect(err.split('\n')).toEqual([
      'SOTA_CACHE_STALE: 2 oracle rows for beam-1m, system oracle, reader anthropic:claude-opus-5-5 were measured on other inputs',
      '  changed judge_prompt: prompt-0000 -> prompt-0001 (2 rows)',
      '  changed max_tokens: 4096 -> 8192 (1 rows)',
      `  re-buy: bun eval/runner/sota/oracle.ts run --benchmark beam-1m --reader anthropic:claude-opus-5-5 --items ${items} --cache ${join(dir, 'cache')} --work <work dir> --paid --budget-ledger <window ledger> --budget-run-id <window run>`,
      "  paid window: PAID WINDOW REQUEST SOTA-REBUY-ORACLE-BEAM-1M 0.37 (2 rows; their recorded tokens at today's list prices, plus 25%)",
    ]);
    expect(readFileSync(items, 'utf8')).toBe('a\nb\n');
  });

  test('stale A4 oracle rows point to the keyless re-import, never a re-buy or a paid window', () => {
    const a4: Spec = { ...SPEC, reader: 'openai:gpt-6.1-sol', system_version: 'a4-oracle-gpt61sol' };
    const dir = scratch();
    new OutcomeCache(join(dir, 'cache')).put([{ ...row('a'), ...a4, validator_version: 'answerability-0000' }]);
    writeFileSync(join(dir, 'spec.json'), JSON.stringify([a4]));
    writeFileSync(join(dir, 'items.txt'), 'a\n');
    const err: string[] = [];
    expect(main(['check', '--cache', join(dir, 'cache'), '--spec', join(dir, 'spec.json'), '--items', join(dir, 'items.txt')], () => {}, s => err.push(s))).toBe(STALE_EXIT);
    expect(err.join('\n').split('\n')).toEqual([
      'SOTA_CACHE_STALE: 1 oracle row for beam-1m, system oracle, reader openai:gpt-6.1-sol were measured on other inputs',
      '  changed validator_version: answerability-0000 -> answerability-0001 (1 rows)',
      `  re-import: bun eval/runner/sota/oracle.ts import-a4 --cache ${join(dir, 'cache')} (A4's answers are imported keyless, never bought, so no paid window is needed)`,
    ]);
  });

  test('fresh and unknown rows exit 0: unknown is counted, never bought', () => {
    const { code, out, err } = setup([row('a'), row('b')]);
    expect([code, out, err]).toEqual([0, 'oracle beam-1m oracle anthropic:claude-opus-5-5: 2 fresh, 2 unknown, 0 stale', '']);
  });

  test('the projection prices reader and judge tokens at list prices plus a quarter, rounded up to the cent, and says so when it cannot', () => {
    expect(projectUsd(SPEC, [{ item: 'a', row: row('a'), changed: [] }])).toBe(0.19);
    expect(projectUsd(SPEC, [{ item: 'a', row: row('a', { usage: null }), changed: [] }])).toBeNull();
    expect(projectUsd({ ...SPEC, judge: 'nobody:unpriced' }, [{ item: 'a', row: row('a'), changed: [] }])).toBeNull();
    const { err } = setup([row('a', { dataset: 'beam-old', usage: null })]);
    expect(err).toContain('PAID WINDOW REQUEST SOTA-REBUY-ORACLE-BEAM-1M <cap> (1 rows; no recorded usage or list price to project from, so size the cap with a one-item smoke)');
    expect(rebuyUnit({ ...SPEC, kind: 'leader', benchmark: 'lme-s' })).toBe('SOTA-REBUY-LEADER-LME-S');
  });
});
