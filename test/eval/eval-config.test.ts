import { describe, expect, test } from 'bun:test';
import { applyEvalConfig, evalConfigRecord, parseEvalConfig, type ConfigEngine } from '../../eval/runner/eval-config.ts';
import { planJobs } from '../../eval/runner/decide.ts';
import { newSpec, validateSpec, type CategorySource, type DecisionSpec } from '../../eval/runner/decisions/spec.ts';

function fakeEngine(opts: { pages?: number; mangle?: string } = {}): ConfigEngine & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    setConfig: async (k, v) => { store.set(k, k === opts.mangle ? `${v}-changed` : v); },
    getConfig: async k => store.get(k) ?? null,
    executeRaw: async <T>() => [{ n: opts.pages ?? 0 }] as T[],
  };
}

describe('GBRAIN_EVAL_CONFIG parsing', () => {
  test('empty and unset mean no config', () => {
    expect(parseEvalConfig(undefined)).toEqual({});
    expect(parseEvalConfig('')).toEqual({});
  });
  test('any gbrain config key, not only search pins', () => {
    expect(parseEvalConfig('wanted_pages.enabled=true, line_grammar.enabled=false,search.mode=balanced'))
      .toEqual({ 'wanted_pages.enabled': 'true', 'line_grammar.enabled': 'false', 'search.mode': 'balanced' });
  });
  test('malformed parts and conflicting duplicates fail loudly', () => {
    expect(() => parseEvalConfig('wanted_pages.enabled')).toThrow('is not <config key>=<value>');
    expect(() => parseEvalConfig('=true')).toThrow();
    expect(() => parseEvalConfig('Bad Key=1')).toThrow();
    expect(() => parseEvalConfig('a.b=1,a.b=2')).toThrow('set twice');
    expect(parseEvalConfig('a.b=1,a.b=1')).toEqual({ 'a.b': '1' });
  });
});

describe('applyEvalConfig', () => {
  test('sets every key and records the readback', async () => {
    const engine = fakeEngine();
    const applied = await applyEvalConfig(engine, { 'line_grammar.enabled': 'true', 'put_page.similar_pages': 'false' });
    expect(engine.store.get('line_grammar.enabled')).toBe('true');
    expect(applied.readback).toEqual({ 'line_grammar.enabled': 'true', 'put_page.similar_pages': 'false' });
  });
  test('a value that does not read back throws', async () => {
    await expect(applyEvalConfig(fakeEngine({ mangle: 'wanted_pages.enabled' }), { 'wanted_pages.enabled': 'true' })).rejects.toThrow('did not read back');
  });
  test('refuses a brain that already holds pages', async () => {
    await expect(applyEvalConfig(fakeEngine({ pages: 3 }), { 'wanted_pages.enabled': 'true' })).rejects.toThrow('before the first write');
    await expect(applyEvalConfig(fakeEngine({ pages: 3 }), {})).resolves.toEqual({ requested: {}, readback: {} });
  });
  test('the receipt record names keys the build does not know', async () => {
    const applied = await applyEvalConfig(fakeEngine(), { 'wanted_pages.enabled': 'true', 'search.mode': 'balanced' });
    expect(evalConfigRecord(applied, ['search.mode'])).toMatchObject({ channel: 'GBRAIN_EVAL_CONFIG', unknown_to_build: ['wanted_pages.enabled'] });
    expect(evalConfigRecord(applied, null).unknown_to_build).toBeNull();
  });
});

function spec(source: Partial<CategorySource>): DecisionSpec {
  return {
    schema_version: 1, decision_id: 'p5-config-test', plan: 'P5', title: 't', verdict_type: 'quality', stage: 'dev',
    candidate: { gbrain: null, config: { 'line_grammar.enabled': 'true', 'search.mode': 'balanced' } },
    baseline: { gbrain: null, config: { 'line_grammar.enabled': 'false' } },
    sources: [{ id: 'h1-typing', kind: 'category', category: 'line-grammar-typing', script: 'eval/runner/line-grammar-typing.ts', args: [], paid: false,
      rows_path: 'data.rows', id_field: 'id', comparisons: [], ...source } as CategorySource],
    alpha: 0.05, seed: 42, draws: 10000, budget_usd: 0, created_at: '2026-10-05T00:00:00.000Z',
  };
}

describe('decision kit config channel', () => {
  test('a source with config_channel gets the non-search arm config in GBRAIN_EVAL_CONFIG', () => {
    const jobs = planJobs(spec({ config_channel: true }), '/r', { shards: 1, only: null, budgetRunId: null });
    const cand = jobs.find(j => j.arm === 'candidate')!;
    const base = jobs.find(j => j.arm === 'baseline')!;
    expect(cand.env).toEqual({ GBRAIN_EVAL_SEARCH_PINS: 'search.mode=balanced', GBRAIN_EVAL_CONFIG: 'line_grammar.enabled=true' });
    expect(base.env).toEqual({ GBRAIN_EVAL_SEARCH_PINS: '', GBRAIN_EVAL_CONFIG: 'line_grammar.enabled=false' });
  });
  test('without config_channel the channel is empty, so an inherited value never reaches the arm', () => {
    const jobs = planJobs(spec({}), '/r', { shards: 1, only: null, budgetRunId: null });
    expect(jobs.every(j => j.env?.GBRAIN_EVAL_CONFIG === '')).toBe(true);
    expect(jobs.find(j => j.arm === 'candidate')!.env!.GBRAIN_EVAL_SEARCH_PINS).toBe('search.mode=balanced');
  });
  test('spec validation: config_channel must be boolean and the runner must read the channel', () => {
    expect(() => validateSpec(spec({ config_channel: true }))).not.toThrow();
    expect(() => validateSpec(spec({ config_channel: 'yes' as never }))).toThrow('config_channel must be true or false');
    expect(() => validateSpec(spec({ config_channel: true, script: 'eval/runner/n3-temporal-asof.ts' }))).toThrow('never reads GBRAIN_EVAL_CONFIG');
  });
  test('every P5 runner reads the channel', () => {
    for (const script of ['eval/runner/line-grammar-typing.ts', 'eval/runner/relation-line-variants.ts', 'eval/runner/forward-reference-heal.ts', 'eval/runner/n4-similar-pages.ts', 'eval/runner/temporal-edges.ts']) {
      expect(() => validateSpec(spec({ config_channel: true, script }))).not.toThrow();
    }
  });
  test('the P5 template runs the four deterministic sources through the channel', () => {
    const p5 = newSpec({ decisionId: 'p5-template', plan: 'P5', title: 't', verdictType: 'quality', candidate: null, baseline: null });
    const channel = p5.sources.filter(s => s.kind === 'category' && s.config_channel).map(s => s.id);
    expect(channel).toEqual(['line-grammar-typing', 'relation-line-variants', 'forward-reference-heal', 'n4-similar-pages']);
    for (const s of p5.sources) if (s.kind === 'category' && s.config_channel) expect(s.args).toEqual([]);
  });
});
