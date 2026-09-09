/** Preload for the fixed retrieval refresh. Logs usage, never credentials or request text.
 * Prices checked 2026-09-09: OpenAI text-embedding-3-large $0.13/M;
 * Voyage voyage-4 $0.06/M; rerank-2.5 $0.05/M. Gross estimates ignore free credits.
 * A conservative byte-based reservation is charged BEFORE every HTTP attempt,
 * including SDK retries. Unknown model/API calls are refused in this experiment.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function requestBudget(url: string, body: Record<string, unknown>) {
  const model = String(body.model ?? '');
  const route = new URL(url);
  const bytes = (x: unknown): number => Buffer.byteLength(typeof x === 'string' ? x : JSON.stringify(x ?? ''));
  let rate: number;
  let upperTokens: number;
  if (route.hostname === 'api.openai.com' && route.pathname === '/v1/embeddings' && model === 'text-embedding-3-large') {
    rate = 0.13;
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    upperTokens = inputs.reduce<number>((n, x) => n + bytes(x) + 512, 0);
  } else if (route.hostname === 'api.voyageai.com' && route.pathname === '/v1/embeddings' && model === 'voyage-4') {
    rate = 0.06;
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    upperTokens = inputs.reduce<number>((n, x) => n + bytes(x) + 512, 0);
  } else if (route.hostname === 'api.voyageai.com' && route.pathname === '/v1/rerank' && model === 'rerank-2.5') {
    rate = 0.05;
    const docs = Array.isArray(body.documents) ? body.documents : [];
    upperTokens = docs.reduce<number>((n, x) => n + bytes(x) + bytes(body.query) + 512, 0);
  } else {
    throw new Error(`Unbudgeted retrieval API: ${route.hostname}${route.pathname} model=${model}`);
  }
  return { model, rate_per_million: rate, upper_tokens: upperTokens, reserved_usd: upperTokens * rate / 1e6 };
}

const logPath = process.env.GBRAIN_EVAL_USAGE_LOG;
if (logPath) {
  const cap = Number(process.env.GBRAIN_EVAL_API_CAP_USD ?? '25');
  if (!Number.isFinite(cap) || cap <= 0) throw new Error('Invalid retrieval API cap');
  mkdirSync(dirname(logPath), { recursive: true });
  const originalFetch = globalThis.fetch;
  let reserved = 0;
  let sequence = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const raw = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : null;
    if (raw === null) throw new Error('Retrieval budget expects JSON HTTP requests');
    const quote = requestBudget(url, JSON.parse(raw));
    if (reserved + quote.reserved_usd > cap) throw new Error(`Retrieval API cap reached ($${cap})`);
    reserved += quote.reserved_usd;
    const id = ++sequence;
    const start = Date.now();
    appendFileSync(logPath, JSON.stringify({ event: 'reserved', id, ...quote, cumulative_reserved_usd: reserved }) + '\n');
    try {
      const response = await originalFetch(input, init);
      const json = await response.clone().json().catch(() => ({})) as { usage?: { total_tokens?: number; prompt_tokens?: number } };
      const tokens = json.usage?.total_tokens ?? json.usage?.prompt_tokens ?? null;
      appendFileSync(logPath, JSON.stringify({ event: 'completed', id, model: quote.model, status: response.status,
        wall_ms: Date.now() - start, usage_tokens: tokens,
        gross_estimated_usd: tokens === null ? null : tokens * quote.rate_per_million / 1e6 }) + '\n');
      return response;
    } catch (error) {
      appendFileSync(logPath, JSON.stringify({ event: 'failed', id, model: quote.model, wall_ms: Date.now() - start }) + '\n');
      throw error;
    }
  }) as typeof fetch;
}
