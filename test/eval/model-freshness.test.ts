import { describe, expect, test } from 'bun:test';
import { assess, classify, newestByFamily, type ListedModel } from '../../scripts/model-freshness.ts';

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
