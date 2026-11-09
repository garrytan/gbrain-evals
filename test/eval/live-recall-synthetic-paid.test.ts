/**
 * Live recall's paid synthetic mode (run --synthetic --paid --budget-run-id):
 * Voyage embeddings and rerank on a synthetic brain, reserved and settled on the
 * budget ledger. Keyless: keys are blanked, the only way out is a fake fetch
 * (a scripted Voyage on api.voyageai.com, or a dead upstream), and the ledger
 * is a temporary file. Nothing here reaches a provider.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateBatch3Synthetic, writeBatch3Synthetic } from '../../eval/generators/batch3-synthetic-gen.ts';
import { BudgetRun, readLedger } from '../../eval/runner/budget-ledger.ts';
import { hashEmbedVector } from '../../eval/runner/cat18-embedding-providers.ts';
import { withHermeticEnv } from '../../eval/runner/hermetic-env.ts';
import { main as liveRecallMain } from '../../eval/runner/live-recall/run.ts';
import { validateScorecard } from '../../eval/runner/live-recall/scorecard.ts';
import { VOYAGE_SYNTHETIC, estimateVoyageUsd } from '../../eval/runner/live-recall/synthetic.ts';
import { main as verdictMain, readSynthetic } from '../../eval/runner/predictive/verdict.ts';

const temps: string[] = [];
const tempDir = (label: string) => { const d = mkdtempSync(join(tmpdir(), 'lr-paid-' + label + '-')); temps.push(d); return d; };
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const setDir = () => { const dir = tempDir('set'); writeBatch3Synthetic(dir, generateBatch3Synthetic({ perType: 3 })); return dir; };

interface Seen { voyage: Array<{ path: string; model: string }>; other: string[] }

/** Swap globalThis.fetch for the test: http(s) goes to the handler, anything else (PGLite's own files) to the real fetch. */
async function withFetch<T>(handler: (url: URL, body: any, seen: Seen) => Response, fn: (seen: Seen) => Promise<T>): Promise<T> {
  const seen: Seen = { voyage: [], other: [] };
  const saved = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return saved(input, init);
    return handler(url, init?.body ? JSON.parse(String(init.body)) : null, seen);
  }) as typeof fetch;
  try { return await fn(seen); } finally { globalThis.fetch = saved; }
}

const dead = (url: URL, _body: unknown, seen: Seen) => { seen.other.push(url.hostname); throw new Error('dead upstream'); };
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
const tokens = (texts: string[]) => texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0);

/** A scripted Voyage: base64 float32 hash embeddings and token-overlap rerank scores, each with usage.total_tokens. */
function fakeVoyage(url: URL, body: any, seen: Seen): Response {
  if (url.hostname !== 'api.voyageai.com') return dead(url, body, seen);
  seen.voyage.push({ path: url.pathname, model: body?.model });
  if (url.pathname.endsWith('/embeddings')) {
    const dims = body.output_dimension ?? VOYAGE_SYNTHETIC.embedding_dimensions;
    const data = (body.input as string[]).map((t, index) => ({ object: 'embedding', index, embedding: Buffer.from(new Float32Array(hashEmbedVector(t, dims)).buffer).toString('base64') }));
    return json({ object: 'list', data, model: body.model, usage: { total_tokens: tokens(body.input) } });
  }
  if (url.pathname.endsWith('/rerank')) {
    const q = new Set(String(body.query).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1));
    const data = (body.documents as string[]).map((d, index) => ({ index, relevance_score: d.toLowerCase().split(/[^a-z0-9]+/).filter(t => q.has(t)).length / Math.max(1, q.size) }))
      .sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index);
    return json({ object: 'list', data, model: body.model, usage: { total_tokens: tokens([body.query, ...body.documents]) } });
  }
  return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
}

const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log, err = console.error, out = process.stdout.write, se = process.stderr.write;
  console.log = console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.error = err; process.stdout.write = out; process.stderr.write = se; }
};

describe('live-recall run --synthetic, paid mode', () => {
  test('without --paid nothing reaches a network host and the scorecard records hash transports', async () => {
    const dir = setDir(), out = join(tempDir('hash'), 'run');
    const seen = await withHermeticEnv('lr-paid-hash', () => withFetch(dead, async seen => {
      expect(await quietly(() => liveRecallMain(['run', '--synthetic', dir, '--protocol', 'batch3', '--out', out]))).toBe(0);
      return seen;
    }));
    expect(seen.other).toEqual([]);
    const card = JSON.parse(readFileSync(join(out, 'scorecard.json'), 'utf8'));
    expect(card.run).toMatchObject({ transports: 'hash', control: true, embedding_model: 'openai:text-embedding-3-small' });
    expect(existsSync(join(out, 'paid-receipt.json'))).toBe(false);
  }, 120_000);

  test('--paid without an open budget run refuses before any request, run directory or ledger exists', async () => {
    const dir = setDir(), base = tempDir('refuse'), out = join(base, 'run'), ledger = join(base, 'ledger.sqlite');
    const seen = await withHermeticEnv('lr-paid-refuse', () => withFetch(fakeVoyage, async seen => {
      process.env.VOYAGE_API_KEY = 'fake-voyage-key';
      expect(await quietly(() => liveRecallMain(['run', '--synthetic', dir, '--paid', '--budget-ledger', ledger, '--out', out]))).toBe(2);
      expect(await quietly(() => liveRecallMain(['run', '--synthetic', dir, '--paid', '--budget-run-id', 'no-such-run', '--budget-ledger', ledger, '--out', out]))).toBe(2);
      expect(await quietly(() => liveRecallMain(['run', '--fixture', '--paid', '--budget-run-id', 'x', '--out', out]))).toBe(2);
      return seen;
    }));
    expect([seen.voyage, seen.other, existsSync(out), existsSync(ledger)]).toEqual([[], [], false, false]);
  });

  test('with a fake Voyage, every request is reserved and reconciled on the ledger, and the scorecard is a voyage scorecard', async () => {
    const dir = setDir(), base = tempDir('voyage'), out = join(base, 'run'), ledgerPath = join(base, 'ledger.sqlite');
    const opener = BudgetRun.open({ runner: 'lr-paid-test', budgetUsd: 1, ledgerPath, programCapUsd: 100 });
    const seen = await withHermeticEnv('lr-paid-voyage', () => withFetch(fakeVoyage, async seen => {
      process.env.VOYAGE_API_KEY = 'fake-voyage-key';
      expect(await quietly(() => liveRecallMain(['run', '--synthetic', dir, '--paid', '--budget-run-id', opener.runId, '--budget-ledger', ledgerPath, '--out', out]))).toBe(0);
      return seen;
    }));
    opener.close();
    expect(seen.other).toEqual([]);
    const paths = new Set(seen.voyage.map(v => v.path));
    expect([...paths].sort()).toEqual(['/v1/embeddings', '/v1/rerank']);
    expect(new Set(seen.voyage.map(v => v.model))).toEqual(new Set(['voyage-4', 'rerank-2.5']));

    const entries = readLedger(ledgerPath).entries.filter(e => e.run_id === opener.runId);
    expect(entries.length).toBe(seen.voyage.length);
    expect(entries.every(e => typeof e.actual_usd === 'number' && e.actual_usd > 0 && e.actual_usd <= e.reserved_usd)).toBe(true);
    const receipt = JSON.parse(readFileSync(join(out, 'paid-receipt.json'), 'utf8'));
    expect(receipt.cost.usd).toBeCloseTo(entries.reduce((s, e) => s + e.actual_usd!, 0), 6);
    expect(receipt.cost.basis).toContain(', 0 charged at their reservation');
    expect(receipt.estimate.usd).toBeCloseTo(estimateVoyageUsd(dir).usd, 12);
    expect(receipt.estimate.usd).toBeGreaterThan(receipt.cost.usd);

    const card = JSON.parse(readFileSync(join(out, 'scorecard.json'), 'utf8'));
    expect(() => validateScorecard(card)).not.toThrow();
    expect(card.run).toMatchObject({ transports: 'voyage', embedding_model: VOYAGE_SYNTHETIC.embedding_model, reranker_model: VOYAGE_SYNTHETIC.reranker_model, search_mode: VOYAGE_SYNTHETIC.search_mode, reranker_enabled: true });
    expect(card.arms.configured.invalid).toBeFalsy();
    const detail = readFileSync(join(out, 'detail.local.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(new Set(detail.filter(r => r.arm === 'configured').map(r => r.status))).toEqual(new Set(['ok']));
    expect(readSynthetic(card)).toMatchObject({ control: false, transports: 'voyage' });
    const log = console.log;
    console.log = () => {};
    try { expect(verdictMain(['--measure', 'G4', '--synthetic', join(out, 'scorecard.json')])).toBe(0); } finally { console.log = log; }
  }, 120_000);
});
