/**
 * The keyless 2-question smoke of every pilot arm (A4): build, read, judge,
 * label and report run end to end against a scripted provider that answers
 * every Anthropic and OpenAI request shape the pilot sends. It proves the
 * plumbing (bodies, grounding, digests, fallback routing, cost and token
 * accounting, the report), never a model's quality.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JUDGED_LABEL_SYSTEM } from '../outcomes/v3.ts';
import { qualityCells } from './cells.ts';
import { pilotSplit } from './evidence.ts';
import { buildReport } from './report.ts';
import { loadBriefModule, labelTexts, runBuild, runJudge, runRead, stores } from './run.ts';

/** A provider stand-in: builders get a grounded one-claim JSON brief, labelers alternate labels, judges say yes, readers answer. */
export function scriptedFetch(): { fetch: typeof fetch; calls: Array<{ host: string; model: string }> } {
  const calls: Array<{ host: string; model: string }> = [];
  let flip = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = JSON.parse(String(init?.body ?? '{}'));
    calls.push({ host: url.hostname, model: body.model });
    const system = typeof body.system === 'string' ? body.system : Array.isArray(body.system) ? body.system.map((b: any) => b.text).join('') : body.messages?.find((m: any) => m.role === 'system')?.content ?? '';
    const userMsg = body.messages?.find((m: any) => m.role === 'user')?.content;
    const user = typeof userMsg === 'string' ? userMsg : Array.isArray(userMsg) ? userMsg.map((b: any) => b.text).join('') : '';
    let text: string;
    if (/evidence brief|digest of one past chat session/i.test(system)) {
      const m = /<chat_session id="([^"]+)"[^>]*>\n[\s\S]*?\*\*user:\*\* ([^\n]{20,90})/.exec(user);
      text = JSON.stringify(m ? { claims: [{ id: 'c1', text: 'The user said this.', quote: m[2].slice(0, 60), session_id: m[1], speaker: 'user', status: 'current' }], answerability: 'answerable' } : { claims: [], answerability: 'no_evidence' });
    } else if (system === JUDGED_LABEL_SYSTEM) {
      text = ['confident', 'hedged', 'abstain'][flip++ % 3];
    } else if (body.model === 'gpt-4o-2024-08-06') {
      text = 'yes';
    } else {
      text = 'Notes: scripted.\n\n**Answer:** scripted answer.';
    }
    const json = url.hostname === 'api.anthropic.com'
      ? { id: 'msg_smoke', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: Math.ceil(JSON.stringify(body).length / 4), output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
      : { id: 'chatcmpl_smoke', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: Math.ceil(JSON.stringify(body).length / 4), completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } } };
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

export async function runSmoke(opts: { questions?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pilot-smoke-'));
  const previous = globalThis.fetch;
  const { fetch: scripted, calls } = scriptedFetch();
  const keys = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  globalThis.fetch = scripted;
  try {
    const ids = pilotSplit().pilot.slice(0, opts.questions ?? 2);
    const s = stores(dir);
    const { mod, identity } = await loadBriefModule();
    const quiet = () => {};
    await runBuild(ids, s, mod, quiet);
    await runRead(qualityCells(), ids, s, mod, quiet);
    await runJudge(s, quiet);
    await labelTexts(s.reads.values().filter(r => !r.error).map(r => r.text), s, undefined, quiet);
    const report = await buildReport(s, identity, { stateDir: dir, ids });
    return { ids, calls: calls.length, hosts: [...new Set(calls.map(c => c.host))], models: [...new Set(calls.map(c => c.model))].sort(), cells: report.rows.length, expected_cells: qualityCells().length, rows: report.rows.map(r => ({ cell: r.cell, n: r.n, correct: r.correct, usd_per_q: r.usd_per_q, delivered: r.delivered_cl100k })) };
  } finally {
    globalThis.fetch = previous;
    if (keys.a !== undefined) process.env.ANTHROPIC_API_KEY = keys.a;
    if (keys.o !== undefined) process.env.OPENAI_API_KEY = keys.o;
    rmSync(dir, { recursive: true, force: true });
  }
}
