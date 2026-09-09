import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const preload = join(import.meta.dir, '../../scripts/retrieval-usage.ts');
type Event = Record<string, unknown>;

/** A fresh process isolates the preload's global fetch replacement and budget.
 * The only transport in the child is a local stub installed before import. */
function exercise(code: string, cap = '0.0001'): { result: Record<string, unknown>; events: Event[]; raw: string } {
  const directory = mkdtempSync(join(tmpdir(), 'retrieval-usage-'));
  const logPath = join(directory, 'usage.ndjson');
  try {
    const source = `
      let calls = 0;
      let transport = async () => new Response(JSON.stringify({ usage: { total_tokens: 7 } }), { status: 200 });
      globalThis.fetch = async (...args) => { calls += 1; return transport(...args); };
      await import(${JSON.stringify(preload)});
      const url = 'https://api.openai.com/v1/embeddings';
      const options = {
        method: 'POST',
        headers: { authorization: 'Bearer example-secret-never-log' },
        body: JSON.stringify({ model: 'text-embedding-3-large', input: 'private-example-text' }),
      };
      const failure = async fn => {
        try { await fn(); return null; } catch (error) { return String(error); }
      };
      ${code}
    `;
    const child = Bun.spawnSync([process.execPath, '-e', source], {
      env: { ...process.env, GBRAIN_EVAL_USAGE_LOG: logPath, GBRAIN_EVAL_API_CAP_USD: cap },
      stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
    });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const raw = readFileSync(logPath, 'utf8');
    return {
      result: JSON.parse(child.stdout.toString()),
      events: raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
      raw,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('retrieval API budget preload (stub transport only)', () => {
  test('rejects an over-budget request before transport or an extra reservation', () => {
    const { result, events } = exercise(`
      const response = await fetch(url, options);
      const error = await failure(() => fetch(url, options));
      console.log(JSON.stringify({ calls, status: response.status, error }));
    `);
    expect(result.calls).toBe(1);
    expect(result.status).toBe(200);
    expect(result.error).toContain('Retrieval API cap reached');
    expect(events.map(event => event.event)).toEqual(['reserved', 'completed']);
    expect(events[0].cumulative_reserved_usd).toBe(events[0].reserved_usd);
    expect(events[1].usage_tokens).toBe(7);
  });

  test('a failed transport still consumes budget, and a retry gets its own receipt', () => {
    const { result, events, raw } = exercise(`
      transport = async () => {
        if (calls === 1) throw new Error('example transport failure with private details');
        return new Response(JSON.stringify({ usage: { total_tokens: 11 } }), { status: 200 });
      };
      const first = await failure(() => fetch(url, options));
      await fetch(url, options);
      const third = await failure(() => fetch(url, options));
      console.log(JSON.stringify({ calls, first, third }));
    `, '0.00015');
    expect(result.calls).toBe(2);
    expect(result.first).toContain('example transport failure');
    expect(result.third).toContain('Retrieval API cap reached');
    expect(events.map(event => [event.event, event.id])).toEqual([
      ['reserved', 1], ['failed', 1], ['reserved', 2], ['completed', 2],
    ]);
    expect(events[2].cumulative_reserved_usd).toBe(Number(events[0].reserved_usd) * 2);
    expect(events[3].usage_tokens).toBe(11);
    expect(raw).not.toContain('private details');
  });

  test('records HTTP failures and absent usage without inventing zero-cost tokens', () => {
    const { result, events } = exercise(`
      transport = async () => new Response('upstream service unavailable', { status: 503 });
      const response = await fetch(url, options);
      console.log(JSON.stringify({ calls, status: response.status, body: await response.text() }));
    `);
    expect(result.calls).toBe(1);
    expect(result.status).toBe(503);
    expect(result.body).toBe('upstream service unavailable');
    expect(events.map(event => event.event)).toEqual(['reserved', 'completed']);
    expect(events[1].status).toBe(503);
    expect(events[1].usage_tokens).toBeNull();
    expect(events[1].gross_estimated_usd).toBeNull();
  });

  test('rejects unpriced and non-JSON requests before transport, preserving remaining budget', () => {
    const { result, events } = exercise(`
      const unpriced = await failure(() => fetch('https://api.openai.com/v1/responses', {
        ...options, body: JSON.stringify({ model: 'unknown' }),
      }));
      const malformed = await failure(() => fetch(url, { ...options, body: 'not JSON' }));
      const missingBody = await failure(() => fetch(url));
      await fetch(url, options);
      console.log(JSON.stringify({ calls, unpriced, malformed, missingBody }));
    `);
    expect(result.calls).toBe(1);
    expect(result.unpriced).toContain('Unbudgeted retrieval API');
    expect(result.malformed).toBeString();
    expect(result.missingBody).toContain('expects JSON HTTP requests');
    expect(events.map(event => event.event)).toEqual(['reserved', 'completed']);
  });

  test('accepts Request inputs and never logs request text, credentials, or response bodies', () => {
    const { result, events, raw } = exercise(`
      transport = async input => {
        const requestText = await input.text();
        return new Response(JSON.stringify({
          usage: { prompt_tokens: 13 },
          private_response: 'private-example-response',
          received: requestText,
        }), { status: 200 });
      };
      const response = await fetch(new Request(url, options));
      const body = await response.json();
      console.log(JSON.stringify({ calls, requestSurvived: body.received.includes('private-example-text') }));
    `);
    expect(result.calls).toBe(1);
    expect(result.requestSurvived).toBe(true);
    expect(events[1].usage_tokens).toBe(13);
    expect(events[1].gross_estimated_usd).toBeCloseTo(13 * 0.13 / 1_000_000, 12);
    expect(raw).not.toContain('example-secret-never-log');
    expect(raw).not.toContain('private-example-text');
    expect(raw).not.toContain('private-example-response');
  });
});
