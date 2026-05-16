import { describe, test, expect } from 'bun:test';
import { assertEvalAdapterConfig, type EvalAdapterConfig } from './eval-adapter-config.ts';

describe('assertEvalAdapterConfig — accepts valid shapes', () => {
  test('minimal valid config', () => {
    const c = { embedder: 'openai:text-embedding-3-large', dim: 1536 };
    expect(() => assertEvalAdapterConfig(c)).not.toThrow();
    const _typed: EvalAdapterConfig = c as EvalAdapterConfig;
    expect(_typed.embedder).toBe('openai:text-embedding-3-large');
  });

  test('with reranker and search mode', () => {
    const c = {
      embedder: 'zeroentropyai:zembed-1',
      dim: 2560,
      reranker: 'zeroentropyai:zerank-2',
      searchMode: 'tokenmax',
      cell: 'C1',
    };
    expect(() => assertEvalAdapterConfig(c)).not.toThrow();
  });
});

describe('assertEvalAdapterConfig — rejects bad shapes', () => {
  test('null', () => {
    expect(() => assertEvalAdapterConfig(null)).toThrow(/expected object/);
  });

  test('embedder missing colon', () => {
    expect(() => assertEvalAdapterConfig({ embedder: 'openai-no-colon', dim: 1536 }))
      .toThrow(/provider:model/);
  });

  test('embedder is not a string', () => {
    expect(() => assertEvalAdapterConfig({ embedder: 42, dim: 1536 }))
      .toThrow(/provider:model/);
  });

  test('dim is not a positive integer', () => {
    expect(() => assertEvalAdapterConfig({ embedder: 'openai:x', dim: 0 })).toThrow(/positive integer/);
    expect(() => assertEvalAdapterConfig({ embedder: 'openai:x', dim: -1 })).toThrow(/positive integer/);
    expect(() => assertEvalAdapterConfig({ embedder: 'openai:x', dim: 1.5 })).toThrow(/positive integer/);
    expect(() => assertEvalAdapterConfig({ embedder: 'openai:x', dim: 'big' })).toThrow(/positive integer/);
  });

  test('reranker without colon (when set)', () => {
    expect(() => assertEvalAdapterConfig({ embedder: 'openai:x', dim: 1536, reranker: 'invalid' }))
      .toThrow(/provider:model/);
  });

  test('reranker undefined is allowed (no-rerank cell)', () => {
    expect(() => assertEvalAdapterConfig({ embedder: 'openai:x', dim: 1536 })).not.toThrow();
  });

  test('searchMode not in allow-list', () => {
    expect(() => assertEvalAdapterConfig({ embedder: 'openai:x', dim: 1536, searchMode: 'wild' }))
      .toThrow(/conservative\|balanced\|tokenmax/);
  });
});
