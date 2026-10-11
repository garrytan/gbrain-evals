import { describe, expect, test } from 'bun:test';
import { assess, classify, newestByFamily, type ListedModel } from '../../scripts/model-freshness.ts';
import { chatPrice } from '../../eval/runner/budget-ledger.ts';

const m = (provider: ListedModel['provider'], id: string, created = 0): ListedModel => ({ provider, id, created });

describe('model freshness', () => {
  test('classifies family ids and ignores snapshots, minis and small tiers', () => {
    expect(classify(m('anthropic', 'claude-sonnet-5-5'))).toEqual({ family: 'sonnet', version: [5, 5] });
    expect(classify(m('anthropic', 'claude-haiku-4-5-20251001'))).toBeNull();
    expect(classify(m('anthropic', 'claude-opus-4-5-20251101'))).toBeNull();
    expect(classify(m('openai', 'gpt-6.1-sol'))).toEqual({ family: 'gpt', version: [6, 1] });
    expect(classify(m('openai', 'gpt-5.4-mini'))).toBeNull();
    expect(classify(m('openai', 'gpt-6-luna'))).toBeNull();
  });

  test('picks the newest per family', () => {
    const listed = [m('anthropic', 'claude-opus-5'), m('anthropic', 'claude-opus-5-5'), m('anthropic', 'claude-fable-5-1'), m('anthropic', 'claude-sonnet-5-5'), m('openai', 'gpt-6-astra', 1), m('openai', 'gpt-6.1-sol', 2), m('openai', 'gpt-5.5')];
    expect(newestByFamily(listed)).toEqual({ opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', fable: 'claude-fable-5-1', gpt: 'gpt-6.1-sol' });
  });

  test('a newer release warns; an unpriced called model blocks', () => {
    const listed = [m('anthropic', 'claude-opus-6'), m('openai', 'gpt-6.1-sol')];
    const r = assess(['anthropic:claude-opus-5-5', 'openai:gpt-6.1-sol'], listed, id => id !== 'openai:gpt-6.1-sol');
    expect(r.warnings.some(w => w.includes('claude-opus-6'))).toBe(true);
    expect(r.blocking).toHaveLength(1);
  });
});

describe('model rules (CLAUDE.md "Choose models", 2026-10-07)', () => {
  const listed = [m('anthropic', 'claude-opus-5-5'), m('anthropic', 'claude-sonnet-5-5'), m('anthropic', 'claude-fable-5-1'), m('openai', 'gpt-6.1-sol')];
  const all = () => true;

  test('the counted readers pass clean; a newer Fable is not a reason to add Fable to a counted run', () => {
    expect(assess(['anthropic:claude-opus-5-5', 'anthropic:claude-sonnet-5-5', 'openai:gpt-6.1-sol'], listed, all)).toEqual({ warnings: [], blocking: [] });
  });

  test('Fable in a run is flagged smoke-only; gpt-4.1-mini is flagged bridge-only; gpt-5.4-mini blocks', () => {
    const r = assess(['anthropic:claude-opus-5-5', 'anthropic:claude-sonnet-5-5', 'openai:gpt-6.1-sol', 'anthropic:claude-fable-5-1', 'openai:gpt-4.1-mini', 'openai:gpt-5.4-mini'], listed, all);
    expect(r.warnings.some(w => w.includes('claude-fable-5-1') && w.includes('smoke tests only'))).toBe(true);
    expect(r.warnings.some(w => w.includes('gpt-4.1-mini') && w.includes('bridge'))).toBe(true);
    expect(r.blocking).toEqual([expect.stringContaining('gpt-5.4-mini is never run')]);
  });

  test('the current cheap models are priced in the ledger', () => {
    expect(assess(['anthropic:claude-haiku-5-5', 'openai:gpt-6-luna'], listed, id => chatPrice(id) !== undefined).blocking).toEqual([]);
  });
});
