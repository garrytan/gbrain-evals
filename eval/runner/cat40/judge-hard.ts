/**
 * Cat 40 Hard claims judge (ENG-F3). Like the v1 judge it only counts
 * unsupported and contradicted claims in the answer; success is decided by
 * score-hard.ts. Differences from the v1 prompt:
 *   - H5: the user messages of the session chain are trusted evidence (user
 *     statements outrank documents); notes the agent wrote are never evidence.
 *   - H1: member records are included whole; near-miss records are capped
 *     and summarized to one line each, so the prompt stays bounded at 50k.
 *   - Every request is persisted (judge-requests.jsonl) so a failed judgment
 *     can be re-judged without rerunning the agent.
 *   - Malformed judge output is a judge failure (`judge_error`), not zero claims.
 *
 * Re-judge failed cells of a finished run (paid; needs the ledger flags):
 *   bun eval/runner/cat40/judge-hard.ts --rejudge <run --out dir> --judge gpt-6.1-sol --budget-usd <n> --budget-ledger .budget/cat40-hard.sqlite
 * Writes <dir>/rejudged.jsonl (key, attempt_id, claims, judge_usd), beside the original records.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAgentText, type AgentRun } from './loop.ts';
import { submittedSources } from './score.ts';
import { coerceAnswer } from './score-hard.ts';
import { renderDoc } from '../../generators/model-ladder-gen.ts';
import type { HardTask, HardWorld } from '../../generators/hard/schema.ts';
import { budgetOptionsFrom, startPaidRun } from '../budget-ledger.ts';

export const HARD_JUDGE_PROMPT_VERSION = 'cat40-hard-claims-v1';
/** Near-miss records listed (one line each) in an H1 judge prompt. */
export const JUDGE_NEAR_MISS_CAP = 40;

export interface JudgeRequestLog { key?: string; attempt_id?: string; judge: string; prompt_version: string; system: string; user: string }
export interface HardClaims { claims: Array<{ claim: string; verdict: string }>; unsupported: number; contradicted: number; total: number }

const SYSTEM = 'You check an assistant\'s answer against company documents and, when given, statements the user made in earlier sessions. User statements are trusted and outrank documents; a later statement outranks an earlier one. List every factual claim the answer makes about the company, its customers or people (values, dates, names, counts, statuses, who said or decided what). For each claim decide: supported (a document or user statement states it, or it follows directly from them), contradicted (a governing document or statement says otherwise), or unsupported (nothing states it). Claims that only describe what a document says, including documents the answer correctly treats as drafts, summaries, superseded or not yet effective, count as supported. Reply with JSON only: {"claims":[{"claim":"...","verdict":"supported|contradicted|unsupported"}]}';

export function hardJudgePrompt(world: HardWorld, task: HardTask, run: Pick<AgentRun, 'final' | 'text'>): { system: string; user: string } | null {
  const f = run.final;
  const answer = coerceAnswer((f as { answer?: unknown } | null)?.answer);
  const answerText = [answer ? `answer: ${answer}` : '', f?.notes ? `notes: ${f.notes}` : '', run.text ?? ''].filter(Boolean).join('\n');
  if (!answerText.trim()) return null;
  const byId = new Map(world.docs.map(d => [d.id, d]));
  const full = new Set(task.family === 'H1' ? task.gold.evidence : task.relevant);
  for (const s of submittedSources(f)) if (byId.has(s)) full.add(s);
  const docs = [...full].filter(id => byId.has(id)).map(id => `<document id="${id}">\n${renderDoc(byId.get(id)!)}</document>`);
  if (task.family === 'H1') {
    const near = task.relevant.filter(id => !full.has(id) && byId.has(id)).slice(0, JUDGE_NEAR_MISS_CAP);
    if (near.length) docs.push(`<near_miss_records count="${near.length}">\n${near.map(id => { const d = byId.get(id)!; return `- ${id} (${d.date}): ${d.body.replace(/\s+/g, ' ').slice(0, 160)}`; }).join('\n')}\n</near_miss_records>`);
  }
  const statements = task.family === 'H5' ? `\n\nUser statements from earlier sessions (trusted, in order):\n${(task.sessions ?? []).map((s, i) => `${i + 1}. ${s}`).join('\n')}` : '';
  return { system: SYSTEM, user: `Question: ${task.question}${statements}\n\nAnswer under review:\n${answerText}\n\nDocuments:\n${docs.join('\n')}` };
}

/** Parse judge output; null when it is not the requested JSON (a judge failure). */
export function parseHardClaims(text: string): HardClaims | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { claims?: unknown };
    if (!Array.isArray(j.claims) || j.claims.some(c => !c || typeof c !== 'object' || typeof (c as { verdict?: unknown }).verdict !== 'string')) return null;
    const claims = j.claims as Array<{ claim: string; verdict: string }>;
    if (claims.some(c => !['supported', 'contradicted', 'unsupported'].includes(c.verdict))) return null;
    return { claims, unsupported: claims.filter(c => c.verdict === 'unsupported').length, contradicted: claims.filter(c => c.verdict === 'contradicted').length, total: claims.length };
  } catch { return null; }
}

export async function judgeHardClaims(world: HardWorld, task: HardTask, run: Pick<AgentRun, 'final' | 'text'>, judge: string, log: (e: JudgeRequestLog) => void,
  call: typeof runAgentText = runAgentText): Promise<{ claims: HardClaims | null; usd: number; error?: string }> {
  const p = hardJudgePrompt(world, task, run);
  if (!p) return { claims: null, usd: 0 };
  log({ judge, prompt_version: HARD_JUDGE_PROMPT_VERSION, ...p });
  const r = await call(judge, p.system, p.user);
  const claims = parseHardClaims(r.text);
  return claims ? { claims, usd: r.usd } : { claims: null, usd: r.usd, error: `malformed judge output: ${r.text.slice(0, 200)}` };
}

/** Re-judge every attempt whose record has `judge_error`, from the persisted requests. */
export async function rejudge(dir: string, judge: string, call: typeof runAgentText = runAgentText): Promise<number> {
  const requests = new Map<string, JudgeRequestLog>();
  for (const l of readFileSync(join(dir, 'judge-requests.jsonl'), 'utf8').split('\n').filter(Boolean)) { const e = JSON.parse(l) as JudgeRequestLog; requests.set(e.attempt_id!, e); }
  const failed = readFileSync(join(dir, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { key: string; attempt_id: string; judge_error?: string }).filter(r => r.judge_error);
  let n = 0;
  for (const r of failed) {
    const req = requests.get(r.attempt_id);
    if (!req) continue;
    const out = await call(judge, req.system, req.user);
    appendFileSync(join(dir, 'rejudged.jsonl'), JSON.stringify({ key: r.key, attempt_id: r.attempt_id, judge, prompt_version: req.prompt_version, claims: parseHardClaims(out.text), judge_usd: out.usd, ...(parseHardClaims(out.text) ? {} : { judge_error: `malformed judge output: ${out.text.slice(0, 200)}` }) }) + '\n');
    n++;
  }
  return n;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const dir = flag('--rejudge'), judge = flag('--judge');
  if (!dir || !judge || !existsSync(join(dir, 'judge-requests.jsonl'))) { console.error('usage: bun eval/runner/cat40/judge-hard.ts --rejudge <run dir with judge-requests.jsonl> --judge gpt-6.1-sol --budget-usd <n> --budget-ledger <ledger>'); process.exit(2); }
  const { run, guard } = startPaidRun('cat40-hard-rejudge', { ...budgetOptionsFrom(argv), estimateUsd: null });
  let complete = false;
  try { console.log(`re-judged ${await rejudge(dir, judge)} attempts; see ${join(dir, 'rejudged.jsonl')}`); complete = true; }
  finally { run.close({ finish: complete }); guard.uninstall(); }
}
