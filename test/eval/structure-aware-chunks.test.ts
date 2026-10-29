import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chunkHits, contrast, displayPath, mcnemar, readRows, rrf, type Row } from '../../eval/runner/structure-aware-chunks.ts';

const row = (qid: string, hit3: boolean): Row => ({ corpus: 'b', arm: 'base', qid, slug: 's', n_chunks: 4, reachable: true, lead_hit: hit3, lead_chunk: 0, top3: [], hit1: hit3, hit3 });

describe('structure-aware-chunks scoring', () => {
  test('exact McNemar matches the binomial tail', () => {
    expect(mcnemar(0, 0)).toBe(1);
    expect(mcnemar(5, 0)).toBeCloseTo(0.0625, 10);
    expect(mcnemar(56, 36)).toBeLessThan(0.05);
    expect(mcnemar(52, 40)).toBeGreaterThan(0.05);
  });

  test('rrf ranks shared items first and breaks ties by id', () => {
    expect(rrf([[3, 1, 2], [1, 3, 2]])).toEqual([1, 3, 2]);
    expect(rrf([[7], [9]])).toEqual([7, 9]);
  });

  test('gold matches through markdown and quote noise', () => {
    expect(chunkHits('| Term | **Net 45** from the “amended” order |', { kind: 'contains', needles: ['net 45 from the "amended" order'] })).toBe(true);
    const words = Array.from({ length: 30 }, (_, i) => 'w' + i);
    expect(chunkHits('prefix ' + words.slice(5, 25).join(' ') + ' suffix', { kind: 'shingle', needles: [words.join(' ')] })).toBe(true);
    expect(chunkHits(words.slice(5, 24).join(' '), { kind: 'shingle', needles: [words.join(' ')] })).toBe(false);
  });

  test('display path drops a leading page-title heading only', () => {
    expect(displayPath('Acme Example › Terms › Renewal', 'acme example')).toBe('Terms › Renewal');
    expect(displayPath('Terms', 'Acme Example')).toBe('Terms');
    expect(displayPath(undefined, 'Acme Example')).toBe('');
  });

  test('contrast pairs by question and refuses mismatched sets', () => {
    const c = contrast([row('q1', true), row('q2', true), row('q3', false)], [row('q1', false), row('q2', true), row('q3', true)], 'hit3');
    expect(c).toMatchObject({ n: 3, wins: 1, losses: 1, net: 0 });
    expect(() => contrast([row('q1', true)], [row('q1', true), row('q2', false)], 'hit3')).toThrow('different question sets');
  });

  test('report refuses a cell with errored queries or rows that disagree with its summary', () => {
    const out = mkdtempSync(join(tmpdir(), 'sac-cells-'));
    const cell = (name: string, rows: Row[], summary: { questions: number; errors: number }) => {
      writeFileSync(join(out, 'rows.' + name + '.jsonl'), rows.map(r => JSON.stringify(r) + '\n').join(''));
      writeFileSync(join(out, 'summary.' + name + '.json'), JSON.stringify(summary));
    };
    cell('b.base', [row('q1', true), row('q2', false)], { questions: 2, errors: 0 });
    expect(readRows(out, 'b.base')).toHaveLength(2);
    cell('b.errored', [row('q1', true), { ...row('q2', false), error: 'embed timeout' }], { questions: 2, errors: 1 });
    expect(() => readRows(out, 'b.errored')).toThrow('errored');
    cell('b.truncated', [row('q1', true)], { questions: 2, errors: 0 });
    expect(() => readRows(out, 'b.truncated')).toThrow('summary');
    writeFileSync(join(out, 'rows.b.nosummary.jsonl'), JSON.stringify(row('q1', true)) + '\n');
    expect(() => readRows(out, 'b.nosummary')).toThrow('summary');
    expect(readRows(out, 'b.missing')).toBeNull();
  });
});
