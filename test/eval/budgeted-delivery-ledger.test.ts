/**
 * Spending rules for the budgeted delivery E1, keyless: the preregistered
 * drop order, budget sizing from recorded counts, and a fake meter that
 * refuses reader calls like an exhausted lease (402), then resume.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DROP_ORDER, planReads, type Step } from '../../eval/runner/budgeted-delivery/drop-order.ts';
import { sizeBudget, type SizingPoint } from '../../eval/runner/budgeted-delivery/budget-sizing.ts';

const ROOT = resolve(import.meta.dir, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'bd-ledger-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('drop order', () => {
  const steps: Step[] = [
    { id: 'steering', estimate_usd: 30, protected: true }, { id: 'controls', estimate_usd: 4, protected: true },
    { id: 'facts-probe', estimate_usd: 3, protected: false }, { id: 'locomo-query-auto-default', estimate_usd: 4, protected: false }, { id: 'locomo-pseudo-arms', estimate_usd: 2, protected: false }];
  test('everything runs when it fits', () => {
    expect(planReads(steps, 100).dropped).toEqual([]);
  });
  test('drops LoCoMo pseudo-session arms first, then query-auto-default on LoCoMo, then the facts probe', () => {
    expect(DROP_ORDER).toEqual(['locomo-pseudo-arms', 'locomo-query-auto-default', 'facts-probe']);
    expect(planReads(steps, 41).dropped.map(s => s.id)).toEqual(['locomo-pseudo-arms']);
    expect(planReads(steps, 38).dropped.map(s => s.id)).toEqual(['locomo-pseudo-arms', 'locomo-query-auto-default']);
    expect(planReads(steps, 36).dropped.map(s => s.id)).toEqual(['locomo-pseudo-arms', 'locomo-query-auto-default', 'facts-probe']);
    expect(planReads(steps, 36).run.map(s => s.id)).toEqual(['steering', 'controls']);
  });
  test('never drops a protected step: refuses instead', () => {
    expect(() => planReads(steps, 33)).toThrow(/never dropped/);
    expect(() => planReads([...steps, { id: 'other', estimate_usd: 1, protected: false }], 100)).toThrow(/outside the preregistered drop order/);
  });
});

describe('budget sizing', () => {
  const point = (b: number, native: number, pseudo: number, used: number, prefixPseudo = pseudo / 2, prefixUsed = used / 2): SizingPoint =>
    ({ budget: b, full: { budget_used: used, blocks: 10, over_budget: used > b, native, pseudo }, prefix: { budget_used: prefixUsed, blocks: 5, over_budget: false, pseudo: prefixPseudo } });
  const grid = (ratioNative: number, ratioPseudo: number) => Array.from({ length: 41 }, (_, k) => 4000 + 100 * k).map(b => point(b, Math.round(b * ratioNative), Math.round(b * ratioPseudo), b));
  test('applies floor_100(8000 / (r_max x 1.02)) at the measured ratio until stable, per rendering', () => {
    const rows = [grid(1.1, 1.25), grid(1.15, 1.27)];
    const n = sizeBudget(rows, 'native'), p = sizeBudget(rows, 'pseudo');
    expect(n.budget).toBe(Math.floor(8000 / (1.15 * 1.02) / 100) * 100);
    expect(p.budget).toBe(Math.floor(8000 / (1.27 * 1.02) / 100) * 100);
    expect(n.verification.passed).toBe(true);
    expect(p.verification.overflow).toBe(0);
  });
  test('an overflow caused by gbrain delivering more than B is counted, not a sizing failure', () => {
    const over = Array.from({ length: 41 }, (_, k) => 4000 + 100 * k).map(b => point(b, Math.round(b * 1.5 * 1.1), Math.round(b * 1.5 * 1.2), Math.round(b * 1.5)));
    const r = sizeBudget([grid(1.1, 1.2), over], 'native');
    expect(r.verification.overflow).toBeGreaterThan(0);
    expect(r.verification.overflow_within_budget).toBe(0);
    expect(r.verification.passed).toBe(true);
    expect(r.verification.gbrain_over_budget).toBe(1);
  });
});

describe('fake meter: an exhausted lease refuses readers, resume finishes without duplicates', () => {
  test('402 refusals are harness failures retried on resume; the canonical rows hold one row per question', async () => {
    let allow = 3;
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async req => {
      const path = new URL(req.url).pathname;
      const body = await req.json().catch(() => ({})) as any;
      if (path === '/__proxy/bind' || path === '/__proxy/unbind') return Response.json({ ok: true });
      if (path === '/__proxy/finalize') return Response.json({ usd: 0.001, requests: 1, unpriced: 0, byModel: {} });
      if (path.endsWith('/chat/completions')) {
        const prompt = String(body.messages?.[0]?.content ?? '');
        const judge = prompt.includes('Is the model response correct') || prompt.includes('Answer yes or no') || prompt.includes('I will give you a question') || prompt.includes('unanswerable question');
        if (!judge && allow-- <= 0) return Response.json({ error: { type: 'budget', message: 'lease exhausted: refused before forwarding' } }, { status: 402 });
        return Response.json({ choices: [{ message: { content: judge ? 'yes' : `answer ${Math.random()}` } }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
      }
      return Response.json({ error: 'no route' }, { status: 404 });
    } });
    try {
      const arms = join(tmp, 'arms.json');
      writeFileSync(arms, JSON.stringify({ policies: { 'fixed-evidence': { budget_tokens: 8000 } }, contexts: ['native'], readers: [{ id: 'main', model: 'openai:gpt-4o-mini' }], judge: 'openai:gpt-4o-mini' }));
      const out = join(tmp, 'cell');
      const run = async () => {
        const p = Bun.spawn([process.execPath, 'eval/runner/memory-qa/run.ts', '--benchmark', 'fixture', '--embed', 'hash', '--system', 'gbrain-shootout', '--arms', arms, '--output', out, '--provider-proxy', `http://127.0.0.1:${server.port}`, '--max-attempts', '3'],
          { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GBRAIN_EVALS_QA_CACHE: join(tmp, 'qa-cache') } });
        const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
        if (code !== 0) throw new Error(err.slice(-2000));
      };
      await run();
      const dir = join(out, 'arms/fixed-evidence.native.b8000.main');
      const read = (f: string) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
      const first = read('outcomes.ndjson');
      expect(first.filter((o: any) => o.outcome === 'scored').length).toBe(3);
      expect(first.filter((o: any) => o.outcome === 'reader_error').length).toBe(first.length - 3);
      allow = 1000;
      await run();
      const second = read('outcomes.ndjson');
      expect(second.every((o: any) => o.outcome === 'scored')).toBe(true);
      expect(read('rows.ndjson').length).toBe(first.length);
      expect(second.filter((o: any) => o.attempts === 2).length).toBe(first.length - 3);
    } finally { server.stop(true); }
  }, 120_000);
});
