/**
 * No-gbrain baseline arms for README's judgment rows
 * (docs/plans/2026-11-17-readme-baselines/PREREG.md): the same model as the
 * gbrain row, one direct provider call per input with a plain prompt. No
 * gbrain code writes or judges anything here (the budget ledger reads gbrain's
 * model price table to price requests). Requests go through
 * globalThis.fetch, which the budget ledger's paid-request guard wraps, so
 * every call is reserved and settled to provider-reported usage.
 *
 *   N2 contradiction pairs   n2-judge-replay.ts judge --prompt plain
 *   chronicle events         chronicle-lift.ts plain
 *   Cat 35 memory pages      bun eval/runner/plain-baseline.ts cat35-write --out <dir> --receipt <file>
 *                              --model anthropic:claude-sonnet-4-6 --budget-usd <n> [--budget-ledger <path>]
 *                            then cat35-transcript-distill.ts --lanes none --external-lane plain
 *                              --external-dir <dir> --external-writer-receipt <file>
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { budgetOptionsFrom, receiptCost, startPaidRun } from './budget-ledger.ts';

export interface PlainReply { text: string; finish: string | null; input_tokens: number; output_tokens: number; response_model: string | null; error: string | null; attempts: number }

const RETRYABLE = /\b(429|500|502|503|504|529|overloaded|timeout|ECONNRESET|socket)\b/i;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const truncated = (maxTokens: number) => 'truncated at the ' + maxTokens + '-token output limit';

/** One user message to provider:model (anthropic or openai), at provider-default sampling, retrying transient failures. */
export async function plainCall(model: string, prompt: string, maxTokens: number, opts: { fetchImpl?: typeof fetch; retries?: number; backoffMs?: number } = {}): Promise<PlainReply> {
  const [provider, id] = model.split(':', 2) as [string, string];
  if (!id || (provider !== 'anthropic' && provider !== 'openai')) throw new Error('plainCall needs anthropic:<model> or openai:<model>, got ' + model);
  const f = opts.fetchImpl ?? ((u, i) => globalThis.fetch(u, i)) as typeof fetch;
  const retries = opts.retries ?? 2;
  let last: PlainReply = { text: '', finish: null, input_tokens: 0, output_tokens: 0, response_model: null, error: 'not sent', attempts: 0 };
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      if (provider === 'anthropic') {
        const res = await f('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model: id, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
        });
        const json = await res.json().catch(() => null) as Record<string, any> | null;
        if (!res.ok || !json) last = { ...last, error: res.status + ' ' + JSON.stringify(json?.error ?? json).slice(0, 300), attempts: attempt };
        else {
          const text = (json.content ?? []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('');
          const finish = json.stop_reason === 'max_tokens' ? 'length' : json.stop_reason ?? null;
          const u = json.usage ?? {};
          return { text, finish, input_tokens: Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0),
            output_tokens: Number(u.output_tokens ?? 0), response_model: json.model ?? null, error: finish === 'length' ? truncated(maxTokens) : finish === 'refusal' ? 'refusal' : text ? null : 'empty reply', attempts: attempt };
        }
      } else {
        const res = await f('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + (process.env.OPENAI_API_KEY ?? ''), 'content-type': 'application/json' },
          body: JSON.stringify({ model: id, max_completion_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
        });
        const json = await res.json().catch(() => null) as Record<string, any> | null;
        if (!res.ok || !json || !Array.isArray(json.choices)) last = { ...last, error: res.status + ' ' + JSON.stringify(json?.error ?? json).slice(0, 300), attempts: attempt };
        else {
          const choice = json.choices[0] ?? {};
          const finish = choice.finish_reason ?? null;
          const text = typeof choice.message?.content === 'string' ? choice.message.content : '';
          return { text, finish, input_tokens: Number(json.usage?.prompt_tokens ?? 0),
            output_tokens: Number(json.usage?.completion_tokens ?? 0), response_model: json.model ?? null, error: finish === 'length' ? truncated(maxTokens) : finish === 'content_filter' ? 'content_filter' : text ? null : 'empty reply', attempts: attempt };
        }
      }
    } catch (e) {
      last = { ...last, error: String((e as Error).message ?? e).slice(0, 300), attempts: attempt };
    }
    if (!RETRYABLE.test(last.error ?? '') || attempt > retries) break;
    await sleep((opts.backoffMs ?? 2000) * attempt);
  }
  return last;
}

// ─── N2 contradiction pairs ─────────────────────────────────────────

export const N2_PLAIN_QUESTION = "Do these two notes contradict each other? Each note's date is shown. Answer yes or no.";

export function n2PlainPrompt(a: { text: string; effective_date?: string | null }, b: { text: string; effective_date?: string | null }): string {
  const note = (n: number, s: typeof a) => 'Note ' + n + ' (date: ' + (s.effective_date ?? 'none') + '):\n' + s.text;
  return N2_PLAIN_QUESTION + '\n\n' + note(1, a) + '\n\n' + note(2, b);
}

/** The verdict a plain yes/no reply gives in N2's terms, or null when the reply opens with neither word. */
export function parseYesNo(text: string): 'contradiction' | 'no_contradiction' | null {
  const first = /^[\s*"'_#>-]*([a-z]+)/i.exec(text)?.[1]?.toLowerCase();
  return first === 'yes' ? 'contradiction' : first === 'no' ? 'no_contradiction' : null;
}

// ─── Chronicle events ───────────────────────────────────────────────

export const CHRONICLE_PLAIN_INSTRUCTION = 'List the events that happened, one per line, as: YYYY-MM-DD | what';

export const chroniclePlainPrompt = (page: string) => CHRONICLE_PLAIN_INSTRUCTION + '\n\n' + page;

/** Lines of the form "YYYY-MM-DD | what" (list markers and bold allowed); anything else is ignored. */
export function parseEventLines(text: string): Array<{ day: string; what: string }> {
  return text.split('\n').flatMap(line => {
    const m = /^\s*(?:[-*•]|\d+[.)])?\s*\**(\d{4}-\d{2}-\d{2})\**\s*\|\s*(.+?)\s*$/.exec(line);
    return m ? [{ day: m[1]!, what: m[2]! }] : [];
  });
}

// ─── Cat 35 memory pages ────────────────────────────────────────────

export const CAT35_PLAIN_INSTRUCTION = 'Here is the transcript of a session between a user and an AI agent. Write one memory page in Markdown that keeps what is worth remembering from it.';

const REPO = resolve(import.meta.dir, '../..');
const TRANSCRIPTS_TXT = join(REPO, 'eval/data/transcript-distill-v1/transcripts-txt');
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

/** <date>-<transcript_id>.txt to transcript id; the writer reads only these renderings, never gold files. */
export const transcriptIdOf = (file: string) => file.replace(/\.txt$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '');

export const cat35PlainPrompt = (transcript: string) => CAT35_PLAIN_INSTRUCTION + '\n\n<transcript>\n' + transcript + '\n</transcript>';

async function cat35Write(argv: string[]) {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const out = flag('--out'), receiptPath = flag('--receipt'), model = flag('--model') ?? 'anthropic:claude-sonnet-4-6';
  if (!out || !receiptPath) throw new Error('cat35-write needs --out <dir> --receipt <file> (the receipt goes outside --out)');
  if (resolve(dirname(receiptPath)) === resolve(out)) throw new Error('--receipt must be outside --out: the external lane reads every file in --out');
  const maxTokens = Number(flag('--max-tokens') ?? 8192);
  const concurrency = Number(flag('--concurrency') ?? 4);
  mkdirSync(out, { recursive: true });
  const files = readdirSync(TRANSCRIPTS_TXT).filter(f => f.endsWith('.txt')).sort();
  const { run, guard } = startPaidRun('plain-baseline-cat35-write', { ...budgetOptionsFrom(argv), estimateUsd: Number(flag('--estimate-usd') ?? 2) });
  const started = new Date().toISOString();
  const rows: Array<Record<string, unknown>> = [];
  const queue = [...files];
  try {
    await Promise.all(Array.from({ length: concurrency }, async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        const tid = transcriptIdOf(f);
        if (guard.exhausted) { rows.push({ transcript_id: tid, error: 'budget exhausted: not written' }); continue; }
        const transcript = readFileSync(join(TRANSCRIPTS_TXT, f), 'utf8');
        const r = await plainCall(model, cat35PlainPrompt(transcript), maxTokens);
        if (!r.error) writeFileSync(join(out, tid + '.md'), r.text);
        rows.push({ transcript_id: tid, transcript_sha256: sha256(transcript), sha256: r.error ? null : sha256(r.text), bytes: r.error ? 0 : Buffer.byteLength(r.text),
          input_tokens: r.input_tokens, output_tokens: r.output_tokens, finish: r.finish, response_model: r.response_model, attempts: r.attempts, error: r.error });
        process.stderr.write('[plain-cat35] ' + tid + ': ' + (r.error ?? r.output_tokens + ' tokens') + '\n');
      }
    }));
  } finally {
    guard.uninstall();
  }
  const cost = receiptCost(run.close());
  rows.sort((a, b) => String(a.transcript_id).localeCompare(String(b.transcript_id)));
  const git = (...a: string[]) => { try { return execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8' }).trim(); } catch { return null; } };
  const receipt = { kind: 'plain-baseline-cat35-write', model, instruction: CAT35_PLAIN_INSTRUCTION, instruction_sha256: sha256(CAT35_PLAIN_INSTRUCTION), max_tokens: maxTokens,
    sampling: 'provider default', input: 'eval/data/transcript-distill-v1/transcripts-txt (the rendering the dream lane reads); no gold file is read', started, finished: new Date().toISOString(),
    gbrain_evals: { git_head: git('rev-parse', 'HEAD'), dirty: (git('status', '--porcelain') ?? '') !== '' }, gbrain: 'no gbrain code called; the budget ledger reads its model price table', written: rows.filter(r => !r.error).length, errors: rows.filter(r => r.error).length, cost, files: rows };
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 1) + '\n');
  return receipt;
}

if (import.meta.main) {
  const [cmd, ...argv] = process.argv.slice(2);
  if (cmd !== 'cat35-write') { console.error('usage: plain-baseline.ts cat35-write --out <dir> --receipt <file> [--model anthropic:claude-sonnet-4-6] --budget-usd <n>'); process.exit(2); }
  const r = await cat35Write(argv);
  console.log(JSON.stringify({ written: r.written, errors: r.errors, cost: r.cost }, null, 1));
}
