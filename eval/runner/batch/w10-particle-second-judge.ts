#!/usr/bin/env bun
/**
 * Second-judge sensitivity for the particle-1 W10b finding (docs/findings/2026-11-01-particle-1-longmemeval-w10b.md).
 * Re-judges the stored W10b answers with LongMemEval's official prompt (sources.ts officialJudgePrompt) on a judge from
 * a lab with no arm in the pair it judges: gpt-6.1-sol judges particle-1, Opus 5.5 and Sonnet 5.5;
 * claude-sonnet-5-5 judges particle-1 and GPT-6.1 Sol. Nothing is counted: the protocol judge stays gpt-4o-2024-08-06,
 * and scripts/finding-particle-w10b.py reads these rows for agreement, flips and each pair's interval. No reader is
 * called again. Both judges run at reasoning effort low with W10's secondary-judge output room (2,000 tokens); neither
 * provider offers a dated snapshot of these models, so the receipt records each model listing's own date and every
 * response's model.
 *
 *   bun eval/runner/budget-ledger.ts init --budget-ledger <ledger> --program-cap-usd 25
 *   RUN=$(bun eval/runner/budget-ledger.ts open --budget-ledger <ledger> --runner w10-particle-second-judge --budget-usd 20 --estimate-usd 10 | jq -r .run_id)
 *   bun eval/runner/batch/w10-particle-second-judge.ts run --out <fresh dir> --budget-ledger <ledger> --paid --budget-run-id $RUN
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { budgetOptionsFrom, priceRequest, receiptCost, startPaidRun, usageCost } from '../budget-ledger.ts';
import { ChatClient, chatWithReceipts } from '../memory-qa/qa-v2.ts';
import { requirePaidArm } from '../paid-arm.ts';
import type { UsageReceipt } from '../usage-receipt.ts';
import { JUDGE_PROTOCOL, judgeVerdict, officialJudgePrompt, readNdjson } from './sources.ts';
import { r1 } from './w10.ts';
import { REPLAY_DIR, scrubErrorText } from './w10-particle.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const W10B = join(ROOT, 'docs/benchmarks/2026-10-07-longmemeval-w10b-reader-replay/arms');

/** The stored answers each arm gave on the 500 W10b prompts. */
export const ANSWERS: Record<string, string> = {
  'particle-1': join(ROOT, REPLAY_DIR, 'arms/w10b-particle-notes/rows.ndjson'),
  'claude-opus-5-5': join(W10B, 'w10b-opus55-notes/rows.ndjson'),
  'claude-sonnet-5-5': join(W10B, 'w10b-sonnet55-notes/rows.ndjson'),
  'gpt-6.1-sol': join(W10B, 'w10b-sol-notes/rows.ndjson'),
};

/** Each judge, the arms it reads, and where its provider lists the model. Its own family's arm is never among them. */
export const JUDGES: Record<string, { model: string; arms: string[]; url: string; listing: string }> = {
  'gpt-6.1-sol': { model: 'openai:gpt-6.1-sol', arms: ['particle-1', 'claude-opus-5-5', 'claude-sonnet-5-5'], url: 'https://api.openai.com/v1/chat/completions', listing: 'https://api.openai.com/v1/models/gpt-6.1-sol' },
  'claude-sonnet-5-5': { model: 'anthropic:claude-sonnet-5-5', arms: ['particle-1', 'gpt-6.1-sol'], url: 'https://api.anthropic.com/v1/messages', listing: 'https://api.anthropic.com/v1/models/claude-sonnet-5-5' },
};
export const JUDGE_OPTIONS = { maxTokens: 10, replicate: 0, effort: 'low' } as const;
const CONCURRENCY = 8;

export interface SecondJudgeRow {
  judge: string; arm: string; question_id: string; question_type: string; verdict: boolean | null; raw: string | null; error: string | null;
  skipped?: string; response_model: string | null; finish: string | null; usage: Record<string, unknown> | null; usd: number; from_cache: boolean;
}

/** Every judgment one judge owes: one per question for each arm it reads, in a fixed order. */
export function tasks(judge: string): { arm: string; question_id: string; hypothesis: string; reader_error: string | null }[] {
  const out = [];
  for (const arm of JUDGES[judge].arms) {
    const rows = readNdjson(ANSWERS[arm]);
    if (rows.length !== 500) throw new Error(arm + ': ' + rows.length + ' stored answers, expected 500');
    for (const r of rows.sort((a, b) => (a.question_id < b.question_id ? -1 : 1))) out.push({ arm, question_id: r.question_id as string, hypothesis: String(r.hypothesis ?? ''), reader_error: r.error ?? null });
  }
  return out;
}

const flag = (argv: string[], name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const message = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 500);

async function listing(url: string): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = url.includes('anthropic') ? { 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01' } : { authorization: 'Bearer ' + (process.env.OPENAI_API_KEY ?? '') };
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(url + ': model listing returned HTTP ' + res.status);
  const j = await res.json() as Record<string, any>;
  return { id: j.id ?? null, created: j.created ?? null, created_at: j.created_at ?? null };
}

async function run(argv: string[]): Promise<number> {
  const out = flag(argv, '--out');
  if (!out) throw new Error('pass --out <fresh directory>');
  const judges = (flag(argv, '--judges') ?? Object.keys(JUDGES).join(',')).split(',');
  for (const j of judges) if (!JUDGES[j]) throw new Error('unknown judge ' + j + '; judges: ' + Object.keys(JUDGES).join(', '));
  for (const j of judges) if (existsSync(join(out, j, 'rows.ndjson'))) throw new Error(join(out, j) + ' already holds rows; a rerun goes to a fresh --out');
  const limit = flag(argv, '--limit');
  const work = judges.map(j => ({ judge: j, items: tasks(j).slice(0, limit ? Number(limit) : undefined) }));
  const questions = r1();
  const prompt = (id: string, hypothesis: string) => { const q = questions.get(id)!; return officialJudgePrompt(q.question_type, q.question, q.answer, hypothesis, id.includes('_abs')); };
  const estimate = work.reduce((a, w) => a + w.items.reduce((s, t) => s + (prompt(t.question_id, t.hypothesis).length / 4) * 2e-6 + 400 * 10e-6, 0), 0);
  const listings = Object.fromEntries(await Promise.all(judges.map(async j => [j, await listing(JUDGES[j].listing)] as const)));
  requirePaidArm(argv, { arm: 'W10b second judge (' + judges.join(', ') + ')', estimateUsd: estimate });
  const { run: budget, guard } = startPaidRun('w10-particle-second-judge', { ...budgetOptionsFrom(argv), estimateUsd: estimate });
  const client = new ChatClient(flag(argv, '--cache') ?? join(homedir(), '.capy/work/w10-particle-second-judge/cache'));
  const startedAt = new Date().toISOString();
  const results: Record<string, SecondJudgeRow[]> = Object.fromEntries(judges.map(j => [j, []]));
  let stopped: string | null = null;
  try {
    await Promise.all(work.map(async ({ judge, items }) => {
      const dir = join(out, judge);
      mkdirSync(dir, { recursive: true });
      const { model, url } = JUDGES[judge];
      const queue = [...items];
      await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        while (!stopped && queue.length) {
          const t = queue.shift()!;
          const q = questions.get(t.question_id);
          if (!q) throw new Error(t.question_id + ' has no W10 replay row');
          const base = { judge, arm: t.arm, question_id: t.question_id, question_type: t.question_id.endsWith('_abs') ? 'abstention' : q.question_type };
          const receipts: UsageReceipt[] = [];
          let row: SecondJudgeRow;
          if (t.reader_error || t.hypothesis.trim() === '') row = { ...base, verdict: false, raw: null, error: null, skipped: t.reader_error ? 'reader error: wrong without a judge call' : 'empty answer: wrong without a judge call', response_model: null, finish: null, usage: null, usd: 0, from_cache: false };
          else {
            try {
              const r = await chatWithReceipts(client, { role: 'judge', question_id: t.question_id, replicate: 0, model, delivered: null }, prompt(t.question_id, t.hypothesis), JUDGE_OPTIONS, receipts);
              const usd = r.usage && !r.cached ? usageCost(priceRequest(url, { model: model.slice(model.indexOf(':') + 1), messages: [] })!, { usage: r.usage })?.usd ?? 0 : 0;
              row = { ...base, verdict: judgeVerdict(r.text), raw: r.text, error: null, response_model: r.response_model, finish: r.finish, usage: r.usage, usd, from_cache: r.cached };
            } catch (e) {
              row = { ...base, verdict: null, raw: null, error: message(e), response_model: null, finish: null, usage: null, usd: 0, from_cache: false };
              if ((e as Error)?.name === 'BudgetExceededError' || /budget/i.test(message(e))) stopped ??= row.error;
            }
          }
          results[judge].push(row);
          appendFileSync(join(dir, 'rows.ndjson'), JSON.stringify(row, scrubErrorText) + '\n');
          if (receipts.length) appendFileSync(join(dir, 'receipts.ndjson'), receipts.map(r => JSON.stringify({ ...r, lane: 'w10-particle-second-judge', arm: t.arm }, scrubErrorText)).join('\n') + '\n');
        }
      }));
    }));
  } finally {
    guard.uninstall();
  }
  const summary = budget.close();
  const tally = (xs: (string | null)[]) => xs.reduce((m, x) => ({ ...m, [String(x)]: (m[String(x)] ?? 0) + 1 }), {} as Record<string, number>);
  const receipt = {
    schema_version: 1, purpose: 'second-judge sensitivity for docs/findings/2026-11-01-particle-1-longmemeval-w10b.md (not counted)',
    protocol: JUDGE_PROTOCOL, verdict_rule: '"yes" in the lowercased reply; a reader error or empty answer is wrong without a judge call',
    options: { ...JUDGE_OPTIONS, sent_as: { openai: 'reasoning_effort low, max_completion_tokens 2000, no temperature', anthropic: 'output_config.effort low, max_tokens 2000, no temperature (adaptive thinking cannot be turned off)' } },
    judges: Object.fromEntries(judges.map(j => [j, {
      model: JUDGES[j].model, arms: JUDGES[j].arms, listing: listings[j], judged: results[j].length, of: work.find(w => w.judge === j)!.items.length,
      errors: results[j].filter(r => r.error).length, skipped: results[j].filter(r => r.skipped).length, yes: results[j].filter(r => r.verdict === true).length,
      response_models: tally(results[j].map(r => r.response_model)), finish: tally(results[j].map(r => r.finish)), from_cache: results[j].filter(r => r.from_cache).length,
      usd: Number(results[j].reduce((a, r) => a + r.usd, 0).toFixed(6)),
    }])),
    stopped, ledger: receiptCost(summary), started_at: startedAt, finished_at: new Date().toISOString(),
  };
  writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 1).replaceAll(homedir() + '/.capy/work/', '<work>/') + '\n');
  console.log(JSON.stringify({ judges: receipt.judges, stopped, ledger_usd: receipt.ledger.usd }, null, 1));
  return stopped || Object.values(receipt.judges).some(j => j.errors || j.judged !== j.of) ? 1 : 0;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== 'run') { console.error('usage: w10-particle-second-judge.ts run --out <dir> [--judges gpt-6.1-sol,claude-sonnet-5-5] [--limit n] --paid --budget-run-id <id>'); process.exit(2); }
  run(rest).then(code => process.exit(code)).catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
}
