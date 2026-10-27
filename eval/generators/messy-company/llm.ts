/**
 * Minimal OpenAI Responses and Gemini generateContent clients with a hard
 * spend cap. Every call appends one row to the dataset's cost ledger before
 * returning; a call that could push spend past the cap is refused.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';

export type ModelId = 'openai:gpt-6.1-sol' | 'gemini:gemini-4-argon';

/** USD per million tokens. Input is charged at the full rate even when cached (conservative). */
export const PRICES: Record<ModelId, { input: number; output: number; source: string }> = {
  'openai:gpt-6.1-sol': { input: 2, output: 10, source: 'eval/runner/budget-ledger.ts HARNESS_CHAT_PRICES (2026-10)' },
  'gemini:gemini-4-argon': { input: 2, output: 10, source: 'ai.google.dev/gemini-api/docs/pricing, Standard tier, introductory price through 2026-11-30 (output includes thinking tokens)' },
};

export const HARD_CAP_USD = 150;
export const STOP_AT_USD = 140;

export interface CallResult { text: string; input_tokens: number; output_tokens: number; thinking_tokens: number; cost_usd: number; raw: unknown; model: ModelId; ms: number }

export function spent(ledgerPath: string): number {
  if (!existsSync(ledgerPath)) return 0;
  return readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).reduce((s, l) => s + (JSON.parse(l).cost_usd ?? 0), 0);
}

export interface CallOpts { system: string; user: string; json?: boolean; maxOutput?: number; effort?: 'low' | 'medium' | 'high'; purpose: string; key: string; ledger: string }

export async function call(model: ModelId, o: CallOpts): Promise<CallResult> {
  const maxOutput = o.maxOutput ?? 12000;
  const estIn = Math.ceil((o.system.length + o.user.length) / 3.2);
  const worst = (estIn * PRICES[model].input + maxOutput * PRICES[model].output) / 1e6;
  const already = spent(o.ledger);
  if (already + worst > STOP_AT_USD) throw new Error(`budget: spent $${already.toFixed(2)} + worst case $${worst.toFixed(2)} would pass the $${STOP_AT_USD} stop line (hard cap $${HARD_CAP_USD})`);
  const t0 = Date.now();
  let res: CallResult;
  for (let attempt = 1; ; attempt++) {
    try {
      res = model.startsWith('openai:') ? await callOpenAI(model, o, maxOutput) : await callGemini(model, o, maxOutput);
      break;
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise(r => setTimeout(r, 2000 * attempt * attempt));
    }
  }
  res.ms = Date.now() - t0;
  mkdirSync(dirname(o.ledger), { recursive: true });
  appendFileSync(o.ledger, JSON.stringify({ at: new Date().toISOString(), model, purpose: o.purpose, key: o.key, input_tokens: res.input_tokens, output_tokens: res.output_tokens, thinking_tokens: res.thinking_tokens, cost_usd: Number(res.cost_usd.toFixed(6)), ms: res.ms }) + '\n');
  return res;
}

async function callOpenAI(model: ModelId, o: CallOpts, maxOutput: number): Promise<CallResult> {
  const body: Record<string, unknown> = {
    model: model.slice('openai:'.length), instructions: o.system, input: o.user, max_output_tokens: maxOutput,
    reasoning: { effort: o.effort ?? 'low' }, store: false,
  };
  if (o.json) body.text = { format: { type: 'json_object' } };
  const r = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify(body) });
  const j = await r.json() as any;
  if (!r.ok) throw new Error(`openai ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);
  const text = (j.output ?? []).filter((x: any) => x.type === 'message').flatMap((x: any) => x.content ?? []).filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('');
  const inT = j.usage?.input_tokens ?? 0, outT = j.usage?.output_tokens ?? 0;
  const thinking = j.usage?.output_tokens_details?.reasoning_tokens ?? 0;
  if (j.status === 'incomplete' && !text) throw new Error(`openai incomplete: ${JSON.stringify(j.incomplete_details)}`);
  return { text, input_tokens: inT, output_tokens: outT, thinking_tokens: thinking, cost_usd: (inT * PRICES[model].input + outT * PRICES[model].output) / 1e6, raw: { id: j.id, status: j.status, usage: j.usage, model: j.model }, model, ms: 0 };
}

async function callGemini(model: ModelId, o: CallOpts, maxOutput: number): Promise<CallResult> {
  const name = model.slice('gemini:'.length);
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: o.system }] },
    contents: [{ role: 'user', parts: [{ text: o.user }] }],
    generationConfig: { maxOutputTokens: maxOutput, thinkingConfig: { thinkingLevel: o.effort ?? 'low' }, ...(o.json ? { responseMimeType: 'application/json' } : {}) },
  };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${name}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY! }, body: JSON.stringify(body) });
  const j = await r.json() as any;
  if (!r.ok) throw new Error(`gemini ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);
  const cand = j.candidates?.[0];
  const text = (cand?.content?.parts ?? []).filter((p: any) => !p.thought).map((p: any) => p.text ?? '').join('');
  const u = j.usageMetadata ?? {};
  const inT = u.promptTokenCount ?? 0, outT = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
  if (!text) throw new Error(`gemini empty (${cand?.finishReason})`);
  return { text, input_tokens: inT, output_tokens: outT, thinking_tokens: u.thoughtsTokenCount ?? 0, cost_usd: (inT * PRICES[model].input + outT * PRICES[model].output) / 1e6, raw: { finishReason: cand?.finishReason, usage: u, modelVersion: j.modelVersion }, model, ms: 0 };
}
