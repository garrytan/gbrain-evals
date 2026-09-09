import { describe, expect, test } from 'bun:test';
import { retrievalPins, rerankerFailures } from '../../eval/runner/retrieval-pins.ts';
import { parseOpts, reportFileName } from '../../eval/runner/precisionmembench.ts';
import { createBenchEngine } from '../../eval/precisionmembench/seed.ts';
import { requestBudget } from '../../scripts/retrieval-usage.ts';

describe('explicit retrieval experiments', () => {
  test('pins reach a real engine before ingestion', async () => {
    const pins = retrievalPins(true, false);
    const engine = await createBenchEngine(pins);
    try {
      for (const [key, value] of Object.entries(pins)) expect(await engine.getConfig(key)).toBe(value);
    } finally { await engine.disconnect(); }
  });
  test('precision configurations have distinct output names and invalid switches fail', () => {
    const off = parseOpts(['--mode', 'gbrain-adaptive', '--entity-max', '1', '--other-max', '1', '--min-keep', '1']);
    const on = parseOpts(['--mode', 'gbrain-adaptive', '--reranker', 'on']);
    expect(reportFileName('2026-09-09', off)).not.toBe(reportFileName('2026-09-09', on));
    expect(off.embeddingModel).toBe('openai:text-embedding-3-large');
    expect(() => parseOpts(['--reranker', 'maybe'])).toThrow();
    expect(() => parseOpts(['--mode', 'gbrain-keyword', '--reranker', 'on'])).toThrow();
  });
  test('reranker fail-open is distinguishable from ordinary retrieval', () => {
    expect(rerankerFailures({ degraded: [{ stage: 'rerank_passthrough', reason: 'timeout' }] })).toEqual(['rerank_passthrough:timeout']);
    expect(rerankerFailures({ degraded: [{ stage: 'reranker_skipped', reason: 'no_key' }] })).toEqual(['reranker_skipped:no_key']);
    expect(rerankerFailures({})).toEqual([]);
  });
  test('API budget counts query tokens for every reranked document and refuses unpriced calls', () => {
    const q = requestBudget('https://api.voyageai.com/v1/rerank', { model: 'rerank-2.5', query: 'abc', documents: ['123', '456'] });
    expect(q.upper_tokens).toBe(1036);
    expect(() => requestBudget('https://api.openai.com/v1/responses', { model: 'unknown' })).toThrow(/Unbudgeted/);
  });
});
