/**
 * Shared helpers: hashing, the spend ledger and the three paid endpoints.
 *
 * Every paid call goes through `paid()`, which refuses once the ledger
 * (results/spend.jsonl, from provider-reported usage) reaches STOP_USD, and
 * appends the call's usage and cost after it returns. Prices are the list
 * prices in eval/runner/budget-ledger.ts (claude-opus-5-5, gpt-6.1-sol) and
 * OpenAI's list price for text-embedding-3-small.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DIR = join(import.meta.dir, '..');
export const CAP_USD = 50;
export const STOP_USD = 45;
export const SPEND = join(DIR, 'results/spend.jsonl');

export const WRITER = { provider: 'openai', model: 'gpt-6.1-sol', effort: 'medium' } as const;
export const JUDGE = { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high' } as const;
export const EMBED_PROVIDER = { provider: 'openai', model: 'text-embedding-3-small' } as const;
export const EMBED_LOCAL = { provider: 'ollama', model: 'nomic-embed-text', url: 'http://127.0.0.1:11434/api/embed' } as const;

const PRICES: Record<string, { input: number; output: number; cache_read: number; cache_write: number }> = {
  'anthropic:claude-opus-5-5': { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
  'openai:gpt-6.1-sol': { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 },
  'openai:text-embedding-3-small': { input: 0.02, output: 0, cache_read: 0.02, cache_write: 0.02 },
};

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const fileSha = (p: string) => sha256(readFileSync(p));
export const readJsonl = <T>(p: string): T[] => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as T);
export const byHash = <T>(seed: string, key: (t: T) => string) => (a: T, b: T) => sha256(seed + key(a)).localeCompare(sha256(seed + key(b)));

/** Token estimate used for every block and listing: ceil(UTF-8 bytes / 4). Named in receipts as tokenizer "bytes/4". */
export const tokens = (s: string) => Math.ceil(Buffer.byteLength(s, 'utf8') / 4);
export const TOKENIZER = 'bytes/4';

export function spent(): number {
  if (!existsSync(SPEND)) return 0;
  return readFileSync(SPEND, 'utf8').split('\n').filter(Boolean).reduce((a, l) => a + JSON.parse(l).cost_usd, 0);
}

interface Usage { input: number; output: number; cache_read: number; cache_write: number }
function cost(key: string, u: Usage): number {
  const p = PRICES[key];
  if (!p) throw new Error(`no price for ${key}`);
  return (u.input * p.input + u.output * p.output + u.cache_read * p.cache_read + u.cache_write * p.cache_write) / 1e6;
}

async function paid<T>(key: string, purpose: string, reserveUsd: number, call: () => Promise<{ result: T; usage: Usage; raw_usage: unknown }>): Promise<T> {
  const before = spent();
  if (before + reserveUsd > STOP_USD) throw new Error(`spend stop: ledger ${before.toFixed(4)} + reservation ${reserveUsd} would pass ${STOP_USD} (cap ${CAP_USD})`);
  const { result, usage, raw_usage } = await call();
  appendFileSync(SPEND, JSON.stringify({ at: new Date().toISOString(), key, purpose, usage: raw_usage, cost_usd: cost(key, usage) }) + '\n');
  return result;
}

async function post(url: string, headers: Record<string, string>, body: unknown, tries = 5): Promise<any> {
  for (let i = 0; ; i++) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    if (r.ok) return r.json();
    const text = await r.text();
    if (i + 1 >= tries || ![408, 409, 429, 500, 502, 503, 504, 529].includes(r.status)) throw new Error(`${url} ${r.status}: ${text.slice(0, 500)}`);
    await Bun.sleep(2000 * 2 ** i);
  }
}

/** OpenAI Responses API with a strict JSON schema; returns the parsed object. */
export function openaiJson(purpose: string, system: string, user: string, schema: object, reserveUsd = 0.5): Promise<any> {
  const key = `openai:${WRITER.model}`;
  return paid(key, purpose, reserveUsd, async () => {
    const j = await post('https://api.openai.com/v1/responses', { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, {
      model: WRITER.model, instructions: system, input: user, reasoning: { effort: WRITER.effort }, max_output_tokens: 20000,
      text: { format: { type: 'json_schema', name: 'out', schema, strict: true } },
    });
    const text = (j.output ?? []).flatMap((o: any) => o.content ?? []).filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('');
    const u = j.usage ?? {};
    const cached = u.input_tokens_details?.cached_tokens ?? 0;
    return { result: { parsed: JSON.parse(text), model: j.model, status: j.status }, usage: { input: (u.input_tokens ?? 0) - cached, output: u.output_tokens ?? 0, cache_read: cached, cache_write: 0 }, raw_usage: u };
  });
}

/** Anthropic Messages API; the system blocks may carry cache_control. Returns the text and the model's stop reason. */
export function anthropicText(purpose: string, system: object[], user: string, reserveUsd = 1.5): Promise<{ text: string; stop_reason: string; model: string }> {
  const key = `anthropic:${JUDGE.model}`;
  return paid(key, purpose, reserveUsd, async () => {
    const j = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01' }, {
      model: JUDGE.model, max_tokens: 24000, output_config: { effort: JUDGE.effort }, system, messages: [{ role: 'user', content: user }],
    });
    const text = (j.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
    const u = j.usage ?? {};
    return { result: { text, stop_reason: j.stop_reason, model: j.model }, usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0 }, raw_usage: u };
  });
}

/** OpenAI embeddings, batched; returns one vector per input. */
export async function openaiEmbed(purpose: string, inputs: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < inputs.length; i += 256) {
    const batch = inputs.slice(i, i + 256);
    out.push(...await paid(`openai:${EMBED_PROVIDER.model}`, purpose, 0.05, async () => {
      const j = await post('https://api.openai.com/v1/embeddings', { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, { model: EMBED_PROVIDER.model, input: batch });
      return { result: j.data.map((d: any) => d.embedding as number[]), usage: { input: j.usage.total_tokens, output: 0, cache_read: 0, cache_write: 0 }, raw_usage: j.usage };
    }));
  }
  return out;
}

/** Local embeddings from an Ollama server on localhost (free; nothing leaves the machine). */
export async function localEmbed(inputs: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < inputs.length; i += 64) {
    const j = await post(EMBED_LOCAL.url, {}, { model: EMBED_LOCAL.model, input: inputs.slice(i, i + 64) });
    out.push(...j.embeddings);
  }
  return out;
}
