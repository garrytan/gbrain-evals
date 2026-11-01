/**
 * Cat 40's model ladder with particle-1, keyless (plan GST-605 Phase 3, unit U8): a fake Particle server on loopback
 * answers every request, and the ladder runs as its own process, as a paid step would. No test reaches a network.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cellAttemptsPath } from '../../eval/runner/cat40-model-ladder.ts';

const ROOT = join(import.meta.dir, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'cat40-particle-ladder-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const lines = (path: string) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

const usage = { prompt_tokens: 2000, completion_tokens: 60, prompt_tokens_details: { cached_tokens: 1500 }, completion_tokens_details: { reasoning_tokens: 40 } };
const submit = { id: 'c', model: 'particle-ai/particle-1', service_tier: 'default', metadata: { weight_version: 'default' }, usage,
  choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'submit_answer', arguments: JSON.stringify({ answer: 'Net 45', sources: ['contracts/thalari-systems-msa'] }) } }] } }] };

/** Runs the ladder on task A01's oracle cell with particle-1 against a fake that answers each request with the next reply. */
async function ladder(name: string, replies: Array<{ status: number; body: unknown; headers?: Record<string, string> }>, extra: string[] = ['--judge', 'none']) {
  const seen: Array<{ path: string; body: Record<string, any> }> = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    seen.push({ path: new URL(req.url).pathname, body: await req.json() as Record<string, any> });
    const r = replies[Math.min(seen.length, replies.length) - 1];
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json', ...r.headers } });
  } });
  const out = join(tmp, name);
  const ledger = join(tmp, `${name}.sqlite`);
  if (!existsSync(ledger)) expect(Bun.spawnSync(['bun', 'eval/runner/budget-ledger.ts', 'init', '--budget-ledger', ledger, '--program-cap-usd', '1', '--reason', 'keyless test'], { cwd: ROOT }).exitCode).toBe(0);
  try {
    const proc = Bun.spawn(['bun', 'eval/runner/cat40-model-ladder.ts', '--models', 'particle-1', '--arms', 'oracle', '--tasks', 'A01', ...extra,
      '--budget-usd', '1', '--budget-ledger', ledger, '--out', out], {
      cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, PARTICLE_API_KEY: 'test-key', PARTICLE_BASE_URL: `http://127.0.0.1:${server.port}/particle/v1`, BRAINBENCH_BUDGET_USD: '' },
    });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    return { code, stderr, out, seen };
  } finally { server.stop(true); }
}

describe('model ladder with particle-1 (fake Particle on loopback)', () => {
  test('one keyless oracle task passes, and its one provider attempt is one receipt in the cell\'s attempts.ndjson', async () => {
    const { code, stderr, out, seen } = await ladder('pass', [{ status: 200, body: submit }]);
    expect({ code, stderr: code ? stderr.slice(-2000) : '' }).toEqual({ code: 0, stderr: '' });
    expect(seen).toHaveLength(1);
    expect(seen[0].path).toBe('/particle/v1/chat/completions');
    expect(seen[0].body).toMatchObject({ model: 'particle-1', reasoning_effort: 'high', max_completion_tokens: 16_000, tool_choice: 'auto' });
    expect(typeof seen[0].body.prompt_cache_key).toBe('string');
    const [cell] = lines(join(out, 'results.jsonl'));
    expect(cell).toMatchObject({ model: 'particle-1', provider: 'particle', arm: 'oracle', task: 'A01', score: { success: true }, run: { stop: 'submitted', usage: { input: 500, cache_read: 1500, output: 60, requests: 1 } } });
    const receipts = lines(cellAttemptsPath(out, cell.key));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ lane: 'cat40-model-ladder', model: 'particle:particle-1', question_id: `${cell.key}|s2`, status: 'ok', turn: 1,
      response_model: 'particle-ai/particle-1', usage: { input_total: 2000, cache_read: 1500, reasoning: 40 }, response_meta: { weight_version: 'default', service_tier: 'default' },
      request: { effort_sent: 'high', effort_effective: 'high', output_limit_field: 'max_completion_tokens', output_limit: 16_000 } });
  }, 60_000);

  test('a credit 402 stops the ladder after its attempt\'s receipt, with no cell recorded; a rerun numbers its attempts on from the stopped run\'s', async () => {
    const { code, stderr, out, seen } = await ladder('credit', [{ status: 402, body: { error: { message: 'Insufficient credits' } } }]);
    expect(code).not.toBe(0);
    expect(stderr).toContain('budget: Particle credit exhausted');
    expect(seen).toHaveLength(1);
    expect(existsSync(join(out, 'results.jsonl')) ? lines(join(out, 'results.jsonl')) : []).toEqual([]);
    const receipts = lines(cellAttemptsPath(out, 'particle-1|oracle|A01|0'));
    expect(receipts.map(r => [r.status, r.error?.slice(0, 4)])).toEqual([['error', '402:']]);

    const resumed = await ladder('credit', [{ status: 200, body: submit }]);
    expect({ code: resumed.code, stderr: resumed.code ? resumed.stderr.slice(-2000) : '' }).toEqual({ code: 0, stderr: '' });
    expect(lines(join(out, 'results.jsonl')).map(r => r.score.success)).toEqual([true]);
    const all = lines(cellAttemptsPath(out, 'particle-1|oracle|A01|0'));
    expect(all.map(r => [r.question_id, r.attempt, r.status])).toEqual([['particle-1|oracle|A01|0|s2', 0, 'error'], ['particle-1|oracle|A01|0|s2', 1, 'ok']]);
  }, 60_000);

  test('a rerun counts past a line a killed run left half-written and starts its receipt on a new line', async () => {
    const path = cellAttemptsPath(join(tmp, 'killed'), 'particle-1|oracle|A01|0');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ question_id: 'particle-1|oracle|A01|0|s2', attempt: 0, status: 'error' })}\n{"question_id":"particle-1|oracle|A01|0|s2",`);
    const { code, stderr } = await ladder('killed', [{ status: 200, body: submit }]);
    expect({ code, stderr: code ? stderr.slice(-2000) : '' }).toEqual({ code: 0, stderr: '' });
    const raw = readFileSync(path, 'utf8').trim().split('\n');
    expect(raw).toHaveLength(3);
    expect(JSON.parse(raw[2])).toMatchObject({ question_id: 'particle-1|oracle|A01|0|s2', attempt: 1, status: 'ok' });
  }, 60_000);

  test('particle-1 never judges, and a run with it names its judge (the v1 default is gpt-5.4-mini)', async () => {
    for (const [extra, says] of [[['--judge', 'particle-1'], 'particle-1 never judges a cell'], [[], 'needs its claims judge passed explicitly'], [['--judge', 'gpt-5.4-mini'], 'needs its claims judge passed explicitly']] as const) {
      const { code, stderr, seen } = await ladder(`refuse-${extra.join('-') || 'default'}`, [{ status: 200, body: submit }], [...extra]);
      expect(code).toBe(2);
      expect(stderr).toContain(says);
      expect(seen).toEqual([]);
    }
  }, 60_000);
});
