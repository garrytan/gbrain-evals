/**
 * No-gbrain retrieval baselines (eval/runner/retrieval-baselines.ts), keyless: ingestion orders match the
 * published gbrain receipts, the questions and gold match them, BM25 and plain hybrid (hash vectors) run
 * through the same scorer, pairing and the sign test are exact, and live arms refuse without the paid flags.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildQueries, gbrainRows, hashEmbedder, ingestionOrder, pairRows, parseArgs, PlainHybridPageAdapter, runBaseline, signTest, type BaselineRow } from './retrieval-baselines.ts';
import { RipgrepBm25Adapter } from './adapters/grep-only.ts';
import { loadWorldCorpus } from './queries/relational.ts';

const ROOT = resolve(import.meta.dir, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'retrieval-baselines-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const pages = loadWorldCorpus(join(ROOT, 'eval/data/world-v1'));
const receipt = JSON.parse(readFileSync(join(ROOT, 'docs/benchmarks/2026-10-01-n9-multi-hop/relational-ab-3a284ae-paid.receipt.json'), 'utf8'));

describe('retrieval baselines', () => {
  test('ingestion orders hash to the gbrain receipt\'s indices', () => {
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    for (const idx of receipt.data.indices as Array<{ seed: number; ingestion_order_sha256: string }>) {
      const order = ingestionOrder(pages, idx.seed).map(p => p.slug);
      expect(createHash('sha256').update(JSON.stringify(order)).digest('hex')).toBe(idx.ingestion_order_sha256);
    }
  });

  test('paraphrase questions and gold equal the gbrain receipt\'s, id for id', () => {
    const queries = buildQueries(pages, 'paraphrase');
    expect(queries).toHaveLength(145);
    const g = new Map(gbrainRows(receipt).filter(r => r.seed === 1 && r.split === 'paraphrase').map(r => [r.query_id, r]));
    for (const q of queries) {
      expect(g.get(q.id)?.text).toBe(q.text);
      expect([...(g.get(q.id)!.relevant ?? [])].sort()).toEqual([...(q.gold.relevant ?? [])].sort());
    }
  });

  test('BM25 and plain hybrid on hash vectors score five distinct pages per run', async () => {
    const queries = buildQueries(pages, 'template').slice(0, 6);
    for (const adapter of [new RipgrepBm25Adapter(), new PlainHybridPageAdapter(hashEmbedder())]) {
      const { rows, indices } = await runBaseline({ adapter, pages, queries, seeds: [1] });
      expect(indices).toHaveLength(1);
      expect(rows).toHaveLength(6);
      for (const r of rows) {
        expect(r.error).toBeNull();
        expect(new Set(r.pages).size).toBe(r.pages.length);
        expect(r.pages.length).toBeLessThanOrEqual(5);
        expect(r.metrics!.recall_at_5).toBeGreaterThanOrEqual(0);
      }
    }
  }, 120_000);

  test('pairing averages seeds per question and applies an exact two-sided sign test', () => {
    expect(signTest(19, 0)).toBeCloseTo(2 / 2 ** 19, 12);
    expect(signTest(0, 0)).toBe(1);
    expect(signTest(5, 5)).toBe(1);
    const row = (seed: number, id: string, recall: number): BaselineRow => ({ seed, query_id: id, text: id, template: 't', split: 's', relevant: ['a'], pages: [], error: null, metrics: { precision_at_5: 0, recall_at_5: recall, hit_at_1: 0, hit_at_5: 0 } });
    const g = (seed: number, id: string, recall: number) => ({ seed, query_id: id, text: id, split: 's', template: 't', relevant: ['a'], on: { metrics: { recall_at_5: recall } }, off: { recall_at_5: 0 } });
    const pair = pairRows([row(1, 'q1', 0), row(2, 'q1', 1), row(1, 'q2', 0)], [g(1, 'q1', 1), g(2, 'q1', 1), g(1, 'q2', 0)], 'on');
    expect(pair.mismatches).toEqual([]);
    expect([pair.questions, pair.questions_gbrain_better, pair.questions_same, pair.runs_gbrain_better]).toEqual([2, 1, 1, 1]);
    expect(pair.classification).toBe('no measurable difference');
    expect(pairRows([row(1, 'q9', 0)], [g(1, 'q1', 1)], 'on').mismatches).toEqual(['1:q9: no gbrain row']);
    expect(pairRows([{ ...row(1, 'q1', 0), metrics: null, error: 'embed failed' } as never], [g(1, 'q1', 1)], 'on').mismatches).toEqual(['1:q1: baseline row errored']);
  });

  test('live arms refuse without --paid --budget-run-id before any request; the vector arm has no stub', async () => {
    expect(() => parseArgs(['run', '--arm', 'vector', '--split', 'template', '--stub-embed', '--output', join(tmp, 'x.json')])).toThrow(/vector arm needs live/);
    const proc = Bun.spawn([process.execPath, 'eval/runner/retrieval-baselines.ts', 'run', '--arm', 'plain-hybrid', '--split', 'template', '--output', join(tmp, 'refused.json')], {
      cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, OPENAI_API_KEY: '', OPENAI_BASE_URL: 'http://127.0.0.1:9', BRAINBENCH_BUDGET_LEDGER: join(tmp, 'ledger.sqlite') },
    });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).not.toBe(0);
    expect(err).toMatch(/--paid/);
  }, 60_000);
});
