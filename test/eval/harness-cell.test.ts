import { describe, expect, test } from 'bun:test';
import { cellId, cellIdentity, chatPrice, estimateCell, harnessCredentials, identityDiff, validateSpec, type CellSpec, type ResolvedCell } from '../../eval/runner/harness-cell.ts';
import { cpuRequirements } from '../../eval/runner/harness-env.ts';
import { findNeedles } from '../../scripts/check-comparator-name.ts';

const spec: CellSpec = {
  dataset: 'beam', split: '100k', provider: 'gbrain', mode: 'rag', lane: 'raw', seal: 'dev',
  target_tokens: 8000, models: { answer: 'gemini:gemini-3.6-flash', judge: 'gemini:gemini-3.5-flash' },
  budget_usd: 5, questions: { limit: 10 }, provider_config: { token_budget: 7600 },
};
const resolved: ResolvedCell = {
  dataset: 'beam', split: '100k', task_type: 'open', isolation_unit: 'conversation', schedule: ['q1', 'q2'],
  schedule_sha256: 'a'.repeat(64), dataset_manifest_sha256: 'b'.repeat(64), questions: 2, units: ['1'], documents: 3,
  document_tokens_cl100k: 100000, document_tokens_by_unit: { 1: 100000 }, timestamp_provenance: {},
  dataset_judge_model: 'gemini:gemini-3.5-flash', judge_calls: 7,
  prompt_revision: 'c'.repeat(64), scorer_revision: 'd'.repeat(64), wrapper_revision: 'e'.repeat(64),
};
const pins = { harness_commit: 'f'.repeat(40), gbrain: { version: '0.60.59.0' } };

describe('cell identity', () => {
  test('is deterministic and readable', () => {
    const a = cellId(spec, cellIdentity(spec, resolved, pins));
    expect(a).toBe(cellId(spec, cellIdentity({ ...spec }, { ...resolved }, { ...pins })));
    expect(a).toMatch(/^beam-100k-gbrain-rag-[0-9a-f]{12}$/);
  });

  test.each([
    ['budget', { ...spec, budget_usd: 6 }, resolved, pins],
    ['model', { ...spec, models: { ...spec.models, answer: 'openai:gpt-6-sol' } }, resolved, pins],
    ['target', { ...spec, target_tokens: 16000 }, resolved, pins],
    ['lane', { ...spec, lane: 'facts' as const }, resolved, pins],
    ['mode', { ...spec, mode: 'agentic-rag' as const }, resolved, pins],
    ['knob', { ...spec, provider_config: { token_budget: 7000 } }, resolved, pins],
    ['dataset manifest', spec, { ...resolved, dataset_manifest_sha256: '0'.repeat(64) }, pins],
    ['scorer revision', spec, { ...resolved, scorer_revision: '0'.repeat(64) }, pins],
    ['prompt revision', spec, { ...resolved, prompt_revision: '0'.repeat(64) }, pins],
    ['gbrain pin', spec, resolved, { ...pins, gbrain: { version: '0.60.60.0' } }],
  ])('changes when the %s changes', (_name, s, r, p) => {
    const base = cellIdentity(spec, resolved, pins);
    const other = cellIdentity(s as CellSpec, r as ResolvedCell, p);
    expect(cellId(s as CellSpec, other)).not.toBe(cellId(spec, base));
    expect(identityDiff(base, other).length).toBeGreaterThan(0);
  });

  test('identityDiff names the changed fields', () => {
    const a = cellIdentity(spec, resolved, pins);
    const b = cellIdentity({ ...spec, budget_usd: 9 }, resolved, { ...pins, gbrain: { version: 'x' } });
    expect(identityDiff(a, b).sort()).toEqual(['budget_usd', 'pins.gbrain.version']);
  });
});

describe('spec validation', () => {
  test('accepts a complete spec', () => expect(validateSpec(spec)).toBe(spec));
  test('rejects bad fields with one message', () => {
    expect(() => validateSpec({ ...spec, mode: 'magic', budget_usd: 0, lane: 'x' })).toThrow(/mode must be.*lane must be.*budget_usd/);
  });
});

describe('estimates and credentials', () => {
  test('prices every stage from the ledger tables', () => {
    expect(chatPrice('gemini:gemini-3.5-flash')).toEqual({ input: 1.5, output: 9 });
    const e = estimateCell(spec, resolved);
    expect(e.unpriced).toEqual([]);
    expect(e.lines.map(l => l.stage)).toEqual(['ingest: gbrain embeddings', 'retrieve: gbrain query embeddings', 'answer', 'judge']);
    expect(e.lines.find(l => l.stage === 'judge')!.basis).toContain('7 judge calls');
    expect(e.usd).toBeGreaterThan(0);
  });

  test('an unpriced model is reported, not counted as free', () => {
    const e = estimateCell({ ...spec, models: { answer: 'gemini:gemini-99-ultra', judge: null } }, resolved);
    expect(e.unpriced).toContain('answer: gemini:gemini-99-ultra');
    expect(e.lines.find(l => l.stage === 'answer')!.usd).toBeNull();
  });

  test('the harness process gets only the credentials its models need', () => {
    expect(harnessCredentials(spec, resolved)).toEqual(['gemini']);
    expect(harnessCredentials({ ...spec, models: { answer: 'anthropic:claude-sonnet-5-5', judge: null } }, resolved).sort()).toEqual(['anthropic', 'gemini']);
  });
});

describe('harness install', () => {
  test('drops CUDA-only wheels', () => {
    const out = cpuRequirements('torch==2.10.0\nnvidia-cublas-cu12==1 ; x\ntriton==3 ; y\ncuda-bindings==12\nnumpy==2', ['nvidia-', 'cuda-', 'triton']);
    expect(out.split('\n')).toEqual(['torch==2.10.0', 'numpy==2']);
  });
});

describe('comparator name guard', () => {
  // The names are built from character codes so this file does not contain them either.
  const product = String.fromCharCode(104, 105, 110, 100, 115, 105, 103, 104, 116);
  const maker = String.fromCharCode(118, 101, 99, 116, 111, 114, 105, 122, 101);
  test('finds the product name in any case or glued form', () => {
    for (const text of [product, product.toUpperCase(), `x_${product}_api`, `${product[0].toUpperCase()}${product.slice(1)}HTTP`]) {
      expect(findNeedles(text).map(h => h.needle)).toEqual(['product']);
    }
  });
  test('finds the maker only as an organisation name', () => {
    expect(findNeedles(`${maker}-io`).map(h => h.needle)).toEqual(['maker']);
    expect(findNeedles(`${maker[0].toUpperCase()}${maker.slice(1)} builds`).map(h => h.needle)).toEqual(['maker']);
    expect(findNeedles(`tfidf ${maker}r and ${maker}d arrays`)).toEqual([]);
  });
  test('skips the English idiom', () => expect(findNeedles(`but in ${product}, I would`)).toEqual([]));
  test('skips the "bias" idiom', () => expect(findNeedles(`avoid ${product} bias here`)).toEqual([]));
  test('still flags the name before other words', () => expect(findNeedles(`the ${product} server`)).toHaveLength(1));
  test('reports line numbers', () => expect(findNeedles(`a\nb\n${product}`)).toEqual([{ needle: 'product', line: 3 }]));
});
