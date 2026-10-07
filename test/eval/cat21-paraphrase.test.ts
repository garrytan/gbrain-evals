/**
 * W5 additions to Cat 21: the frozen paraphrase split, split metrics, the
 * voyage-code-4 cell, the named-split verdict gate and the keyless paired
 * re-score. Hermetic; no keys.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PARAPHRASE_QUERIES_PATH, QUERIES, cellConfig, computeVerdict, loadQueryFile, optionsFromEnv, queriesForSplit, resolveGoldFiles, splitMetrics, walkTs, SRC_ROOT,
  type ProviderCell,
} from '../../eval/runner/cat21-code-retrieval.ts';
import { hitAt5, pairCells, reciprocal, rescore } from '../../eval/runner/cat21-paired.ts';

const SYMBOLS = ['runThink', 'PGLiteEngine', 'hybridSearch', 'importFromContent', 'extractEntityRefs', 'resolveEmbeddingColumn', 'applyGraphSignals',
  'runBrainstorm', 'configureGateway', 'resolvePhantomCanonical', 'computeRecommendations', 'MinionQueue'];

describe('cat21 paraphrase split', () => {
  test('the frozen file matches its published hash and has two questions per gold file', () => {
    expect(createHash('sha256').update(readFileSync(PARAPHRASE_QUERIES_PATH)).digest('hex')).toBe('63f8401d69a7d920f794584a5afce0540fa7b9342f8ce0f444da2f794fa9e713');
    const qs = loadQueryFile(PARAPHRASE_QUERIES_PATH);
    expect(qs).toHaveLength(24);
    const perFile = new Map<string, number>();
    for (const q of qs) perFile.set(q.expected_file, (perFile.get(q.expected_file) ?? 0) + 1);
    expect([...perFile.keys()].sort()).toEqual(QUERIES.map(q => q.expected_file).sort());
    expect([...perFile.values()].every(n => n === 2)).toBe(true);
  });

  test('no paraphrase question names its symbol or file', () => {
    for (const q of loadQueryFile(PARAPHRASE_QUERIES_PATH)) {
      for (const s of SYMBOLS) expect(q.text.toLowerCase()).not.toContain(s.toLowerCase());
      expect(q.text).not.toContain('.ts');
    }
  });

  test('every paraphrase gold file resolves to exactly one walked file at the pin', () => {
    const gold = resolveGoldFiles(walkTs(SRC_ROOT), loadQueryFile(PARAPHRASE_QUERIES_PATH));
    expect(gold.size).toBe(24);
  });

  test('queriesForSplit labels named questions only when combined, and rejects unknown splits', () => {
    expect(queriesForSplit('named')).toBe(QUERIES);
    const both = queriesForSplit('both');
    expect(both).toHaveLength(36);
    expect(both.filter(q => q.split === 'named')).toHaveLength(12);
    expect(both.filter(q => q.split === 'paraphrase')).toHaveLength(24);
    expect(() => queriesForSplit('held-out')).toThrow(/unknown split/);
  });

  test('loadQueryFile refuses an empty or malformed file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cat21-q-'));
    writeFileSync(join(dir, 'empty.json'), JSON.stringify({ questions: [] }));
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ questions: [{ id: 'x', text: 1, expected_file: 'a.ts' }] }));
    expect(() => loadQueryFile(join(dir, 'empty.json'))).toThrow(/no questions/);
    expect(() => loadQueryFile(join(dir, 'bad.json'))).toThrow(/malformed/);
  });

  test('voyage-code-4 is a 1,024-dimension cell', () => {
    expect(cellConfig('voyage-code-4')).toEqual({ embedder: 'voyage:voyage-code-4', dim: 1024 });
  });

  test('flags: --split and --cells parse, ledger flags are read', () => {
    const o = optionsFromEnv(['--split', 'both', '--cells', 'voyage-code-4,openai-default', '--budget-usd', '2', '--budget-ledger', '/tmp/x.sqlite', '--preregistration', 'p.md']);
    expect(o.split).toBe('both');
    expect(o.queries).toHaveLength(36);
    expect(o.cells).toEqual(['voyage-code-4', 'openai-default']);
    expect(o.budget?.budgetUsd).toBe(2);
    expect(o.preregistration).toBe('p.md');
  });
});

describe('cat21 split metrics and verdict', () => {
  const queries = [
    { id: 'a', text: '', expected_file: 'f1', split: 'named' }, { id: 'b', text: '', expected_file: 'f2', split: 'named' },
    { id: 'c', text: '', expected_file: 'f1', split: 'paraphrase' }, { id: 'd', text: '', expected_file: 'f2', split: 'paraphrase' },
  ];
  const perQuery = [
    { id: 'a', rank: 1, top1: true, ms: 1 }, { id: 'b', rank: 2, top1: false, ms: 1 },
    { id: 'c', rank: null, top1: false, ms: 1 }, { id: 'd', rank: 6, top1: false, ms: 1 },
  ];

  test('splitMetrics computes MRR, recall at 5 and first-place hits per split', () => {
    const m = splitMetrics(perQuery, queries);
    expect(m.named).toEqual({ queries: 2, scored: 2, top1_hits: 1, mrr: 0.75, recall_at_5: 1 });
    expect(m.paraphrase!.mrr).toBeCloseTo((0 + 1 / 6) / 2, 10);
    expect(m.paraphrase!.recall_at_5).toBe(0);
  });

  test('splitMetrics keeps an unscored query in the count but not the mean', () => {
    const m = splitMetrics(perQuery.slice(0, 1), queries.slice(0, 2));
    expect(m.named).toEqual({ queries: 2, scored: 1, top1_hits: 1, mrr: 1, recall_at_5: 1 });
  });

  test('the verdict gates on the named split when splits are present', () => {
    const cell = { cell: 'x', valid: true, mrr: 0.3, per_query: [], splits: splitMetrics(perQuery, queries), invalid_reasons: [] } as unknown as ProviderCell;
    expect(computeVerdict([cell], 1, 0.5).verdict).toBe('pass');
    const noSplits = { ...cell, splits: undefined } as ProviderCell;
    expect(computeVerdict([noSplits], 1, 0.5).verdict).toBe('fail');
  });
});

describe('cat21 keyless paired re-score', () => {
  test('metric helpers', () => {
    expect(reciprocal(null)).toBe(0);
    expect(reciprocal(4)).toBe(0.25);
    expect(hitAt5(5)).toBe(1);
    expect(hitAt5(6)).toBe(0);
    expect(hitAt5(null)).toBe(0);
  });

  test('pairCells joins by id and counts a missing query as 0', () => {
    const qs = [{ id: 'q1', expected_file: 'f1', split: 'p' }, { id: 'q2', expected_file: 'f2', split: 'p' }];
    const pairs = pairCells({ cell: 'a', valid: true, per_query: [{ id: 'q2', rank: 2 }, { id: 'q1', rank: 1 }] }, { cell: 'b', valid: true, per_query: [{ id: 'q1', rank: 1 }] }, qs, reciprocal);
    expect(pairs).toEqual([{ id: 'q1', cluster: 'f1', a: 1, b: 1 }, { id: 'q2', cluster: 'f2', a: 0.5, b: 0 }]);
  });

  test('rescore reports cells per split and Holm-adjusted pairwise comparisons', () => {
    const files = Array.from({ length: 6 }, (_, i) => `f${i}`);
    const queries = files.flatMap(f => [{ id: `${f}a`, expected_file: f, split: 'paraphrase' }, { id: `${f}b`, expected_file: f, split: 'paraphrase' }]);
    const cell = (name: string, rank: number) => ({ cell: name, valid: true, per_query: queries.map(q => ({ id: q.id, rank })) });
    const out = rescore({ data: { cells: [cell('a', 1), cell('b', 2), cell('c', 1)] }, resolved_config: { queries } });
    const ab = out.comparisons.find(c => c.metric === 'mrr' && c.a === 'a' && c.b === 'b')!;
    expect(ab.delta).toBeCloseTo(-0.5, 10);
    expect(ab.n_clusters).toBe(6);
    expect(ab.p_two_sided).toBeCloseTo(2 / 64, 10);
    expect(ab.p_holm).toBeGreaterThanOrEqual(ab.p_two_sided);
    expect(out.comparisons.filter(c => c.metric === 'mrr')).toHaveLength(3);
    const ac = out.comparisons.find(c => c.metric === 'mrr' && c.a === 'a' && c.b === 'c')!;
    expect(ac.p_two_sided).toBe(1);
  });
});
