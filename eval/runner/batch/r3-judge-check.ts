#!/usr/bin/env bun
/**
 * R3's judge check (R78; W10 preregistration, amendment of 2026-11-16, "Judges"). Before an R3 co-judge's verdicts
 * count, it is checked against labels on stored LongMemEval answers that no counted R3 cell grades.
 *
 *   bun eval/runner/batch/r3-judge-check.ts plan --out <dir>                                                  ($0)
 *   bun eval/runner/batch/r3-judge-check.ts run --out <dir> --budget-ledger <ledger> --paid --budget-run-id <id> --paid-window R3-B
 *   bun eval/runner/batch/r3-judge-check.ts report --out <dir>                                                ($0)
 *
 * Pool    stored answers to the house notes prompt, as committed before R3. Set S: 50 GPT-6.1 Sol answers (W10b's
 *         w10b-sol-notes and W10c's two Sol arms), which check the Opus co-judge. Set N: Opus 5.5 answers
 *         (w10b-opus55-notes) and particle-1 answers (the particle replay's three house-notes arms), half each where
 *         the rows allow, which check the gpt-6.1-sol co-judge. Each set is a seeded sample with 28 answers the official
 *         judge called wrong and 22 it called right, because wrong answers are rare and kappa needs both classes. W10c's
 *         Sol rows are also graded by the Opus co-judge in a counted R3 cell; the check reads the same rows, which moves
 *         no counted verdict.
 * Labels  gpt-6-astra and claude-opus-5-5, each at effort high with 8,000 output tokens, grade every item with
 *         LongMemEval's official prompt; an item's label is their verdict where they agree.
 * Judges  each co-judge grades its own set with its counted request: claude-opus-5-5 (effort low, 2,000 tokens) on set
 *         S, gpt-6.1-sol (effort low, 2,000 tokens) on set N.
 * Gates   (i) the labellers' kappa over every item both graded, at least 0.6; (ii) per set, at least 40 items where the
 *         labellers agree, at least 15 in each class; (iii) each co-judge's kappa against those labels, at least 0.6;
 *         (iv) no co-judge error. `report` exits 0 when every gate passes and 3 otherwise; a co-judge that fails (ii),
 *         (iii) or (iv), or any co-judge when (i) fails, stays descriptive in R3.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { budgetOptionsFrom, priceRequest, receiptCost, startPaidRun, usageCost } from '../budget-ledger.ts';
import { ChatClient, chatWithReceipts } from '../memory-qa/qa-v2.ts';
import { requirePaidArm } from '../paid-arm.ts';
import type { UsageReceipt } from '../usage-receipt.ts';
import { sha256 } from './manifest.ts';
import { JUDGE_PROTOCOL, judgeVerdict, officialJudgePrompt, readNdjson, seededSample } from './sources.ts';
import { R3_UNITS, r1, requireR3Window } from './w10.ts';

const ROOT = resolve(import.meta.dir, '../../..');
export const SEED = 20261116;
const W10B = 'docs/benchmarks/2026-10-07-longmemeval-w10b-reader-replay/arms';
const W10C = 'docs/benchmarks/2026-10-07-longmemeval-w10c-full-context/arms';
const REPLAY = 'docs/benchmarks/2026-11-01-longmemeval-particle-replay/arms';
export const SOURCES = {
  sol: [`${W10B}/w10b-sol-notes/rows.ndjson`, `${W10C}/w10c-sol-full/rows.ndjson`, `${W10C}/w10c-sol-currentpin/rows.ndjson`],
  opus: [`${W10B}/w10b-opus55-notes/rows.ndjson`],
  particle: [`${REPLAY}/w10b-particle-notes/rows.ndjson`, `${REPLAY}/w10c-particle-full/rows.ndjson`, `${REPLAY}/w10c-particle-currentpin/rows.ndjson`],
} as const;
/** Per set: answers the official judge called wrong, then right. */
export const PER_SET = { wrong: 28, right: 22 } as const;

export const GRADERS = {
  'label-astra': { model: 'openai:gpt-6-astra', effort: 'high', maxTokens: 8000, sets: ['S', 'N'] },
  'label-opus': { model: 'anthropic:claude-opus-5-5', effort: 'high', maxTokens: 8000, sets: ['S', 'N'] },
  'cojudge-opus': { model: 'anthropic:claude-opus-5-5', effort: 'low', maxTokens: 2000, sets: ['S'] },
  'cojudge-sol': { model: 'openai:gpt-6.1-sol', effort: 'low', maxTokens: 2000, sets: ['N'] },
} as const;
type Grader = keyof typeof GRADERS;
const URLS = { openai: 'https://api.openai.com/v1/chat/completions', anthropic: 'https://api.anthropic.com/v1/messages' } as const;
const CONCURRENCY = 8;

export interface PoolItem { item_id: string; set: 'S' | 'N'; reader: keyof typeof SOURCES; arm: string; question_id: string; official: 0 | 1; hypothesis: string }
interface Candidate { key: string; arm: string; question_id: string; official: 0 | 1; hypothesis: string }

const flag = (argv: string[], name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

/** The seeded pool: every candidate is a stored answer with no reader error and a non-empty hypothesis. */
export function plan(): { seed: number; sources: Record<string, string>; items: PoolItem[] } {
  const candidates = (reader: keyof typeof SOURCES): Candidate[] => SOURCES[reader].flatMap(path => {
    const arm = path.split('/').at(-2)!;
    return readNdjson(join(ROOT, path))
      .filter(r => !r.error && typeof r.hypothesis === 'string' && r.hypothesis.trim() !== '')
      .map(r => ({ key: arm + '/' + r.question_id, arm, question_id: r.question_id as string, official: (r.correct_official === 1 ? 1 : 0) as 0 | 1, hypothesis: r.hypothesis as string }));
  });
  const draw = (rows: Candidate[], official: 0 | 1, n: number, seed: number) => {
    const pool = rows.filter(r => r.official === official);
    const keys = new Set(seededSample(pool.map(r => r.key).sort(), Math.min(n, pool.length), seed));
    return pool.filter(r => keys.has(r.key));
  };
  const items: PoolItem[] = [];
  const add = (set: 'S' | 'N', reader: keyof typeof SOURCES, rows: Candidate[]) => {
    for (const { key, ...r } of rows) items.push({ item_id: set + '-' + key, set, reader, ...r });
  };
  const sol = candidates('sol');
  add('S', 'sol', draw(sol, 0, PER_SET.wrong, SEED));
  add('S', 'sol', draw(sol, 1, PER_SET.right, SEED + 1));
  const opus = candidates('opus'), particle = candidates('particle');
  for (const [official, n, seed] of [[0, PER_SET.wrong, SEED + 2], [1, PER_SET.right, SEED + 3]] as const) {
    const fromOpus = draw(opus, official, Math.ceil(n / 2), seed);
    const fromParticle = draw(particle, official, n - fromOpus.length, seed + 10);
    add('N', 'opus', fromOpus);
    add('N', 'particle', fromParticle);
  }
  for (const set of ['S', 'N'] as const) {
    const n = items.filter(i => i.set === set);
    if (n.filter(i => i.official === 0).length !== PER_SET.wrong || n.filter(i => i.official === 1).length !== PER_SET.right) throw new Error('set ' + set + ': the stored rows hold too few answers for ' + PER_SET.wrong + ' wrong and ' + PER_SET.right + ' right');
  }
  const sources = Object.fromEntries(Object.values(SOURCES).flat().map(p => [p, sha256(readFileSync(join(ROOT, p)))]));
  return { seed: SEED, sources, items };
}

export interface GradeRow { grader: Grader; item_id: string; verdict: boolean | null; raw: string | null; error: string | null; finish: string | null; response_model: string | null; usage: Record<string, unknown> | null; usd: number }

function loadPool(out: string): { seed: number; sources: Record<string, string>; items: PoolItem[] } {
  const saved = JSON.parse(readFileSync(join(out, 'pool.json'), 'utf8'));
  if (JSON.stringify(plan()) !== JSON.stringify(saved)) throw new Error(join(out, 'pool.json') + ' no longer matches the seeded plan from the committed rows; plan into a fresh --out');
  return saved;
}

async function run(argv: string[]): Promise<number> {
  const out = flag(argv, '--out');
  if (!out) throw new Error('pass --out <dir> holding pool.json from plan');
  requireR3Window(argv, R3_UNITS.batch);
  const pool = loadPool(out);
  const rowsPath = join(out, 'grades.ndjson');
  const done = new Set(existsSync(rowsPath) ? readNdjson(rowsPath).filter(r => r.error === null).map(r => r.grader + '\u0000' + r.item_id) : []);
  const questions = r1();
  const prompt = (it: PoolItem) => { const q = questions.get(it.question_id)!; return officialJudgePrompt(q.question_type, q.question, q.answer, it.hypothesis, it.question_id.includes('_abs')); };
  const work = (Object.keys(GRADERS) as Grader[]).flatMap(g => pool.items.filter(it => (GRADERS[g].sets as readonly string[]).includes(it.set) && !done.has(g + '\u0000' + it.item_id)).map(it => ({ g, it })));
  const estimate = work.reduce((a, { g, it }) => a + (prompt(it).length / 4) * 10e-6 + GRADERS[g].maxTokens * (g === 'label-astra' ? 50e-6 : 20e-6) * 0.25, 0);
  requirePaidArm(argv, { arm: 'R3 judge check', estimateUsd: estimate });
  const { run: budget, guard } = startPaidRun('r3-judge-check', { ...budgetOptionsFrom(argv), estimateUsd: estimate });
  const client = new ChatClient(flag(argv, '--cache') ?? join(out, 'cache'));
  let stopped: string | null = null;
  try {
    const queue = [...work];
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (!stopped && queue.length) {
        const { g, it } = queue.shift()!;
        const { model, effort, maxTokens } = GRADERS[g];
        const receipts: UsageReceipt[] = [];
        let row: GradeRow;
        try {
          const r = await chatWithReceipts(client, { role: 'judge', question_id: it.question_id, replicate: 0, model, delivered: null }, prompt(it), { maxTokens, replicate: 0, effort }, receipts);
          const provider = model.split(':')[0] as keyof typeof URLS;
          const usd = r.usage && !r.cached ? usageCost(priceRequest(URLS[provider], { model: model.slice(model.indexOf(':') + 1), messages: [] })!, { usage: r.usage })?.usd ?? 0 : 0;
          const raw = (r.text ?? '').trim();
          row = { grader: g, item_id: it.item_id, verdict: raw ? judgeVerdict(raw) : null, raw, error: raw ? null : 'empty reply (finish ' + r.finish + ')', finish: r.finish, response_model: r.response_model, usage: r.usage, usd };
        } catch (e) {
          const message = String((e as Error)?.message ?? e).slice(0, 500);
          row = { grader: g, item_id: it.item_id, verdict: null, raw: null, error: message, finish: null, response_model: null, usage: null, usd: 0 };
          if ((e as Error)?.name === 'BudgetExceededError') stopped ??= message;
        }
        appendFileSync(rowsPath, JSON.stringify(row) + '\n');
        if (receipts.length) appendFileSync(join(out, 'receipts.ndjson'), receipts.map(x => JSON.stringify({ ...x, lane: 'r3-judge-check', grader: g })).join('\n') + '\n');
      }
    }));
  } finally {
    guard.uninstall();
  }
  const summary = budget.close();
  writeFileSync(join(out, 'run.json'), JSON.stringify({ at: new Date().toISOString(), graders: GRADERS, protocol: JUDGE_PROTOCOL, stopped, ledger: receiptCost(summary) }, null, 1).replaceAll(homedir(), '~') + '\n');
  console.log(JSON.stringify({ graded: work.length, stopped }));
  return stopped ? 1 : 0;
}

/** Cohen's kappa for two binary raters over the same items; null when there are no items or chance agreement is total. */
export function kappa(pairs: [boolean, boolean][]): number | null {
  const n = pairs.length;
  if (!n) return null;
  const po = pairs.filter(([a, b]) => a === b).length / n;
  const pa = pairs.filter(([a]) => a).length / n, pb = pairs.filter(([, b]) => b).length / n;
  const pe = pa * pb + (1 - pa) * (1 - pb);
  return pe === 1 ? null : Number(((po - pe) / (1 - pe)).toFixed(4));
}

/** The gates, over the last successful grade per grader and item. */
export function score(items: PoolItem[], grades: GradeRow[]) {
  const last = new Map<string, GradeRow>();
  for (const g of grades) if (g.error === null || !last.has(g.grader + '\u0000' + g.item_id)) last.set(g.grader + '\u0000' + g.item_id, g);
  const verdict = (g: Grader, id: string) => last.get(g + '\u0000' + id)?.verdict ?? null;
  const both = items.filter(it => verdict('label-astra', it.item_id) !== null && verdict('label-opus', it.item_id) !== null);
  const labellerKappa = kappa(both.map(it => [verdict('label-astra', it.item_id)!, verdict('label-opus', it.item_id)!]));
  const labellerGate = labellerKappa !== null && labellerKappa >= 0.6;
  const labels = new Map(both.filter(it => verdict('label-astra', it.item_id) === verdict('label-opus', it.item_id)).map(it => [it.item_id, verdict('label-astra', it.item_id)!]));
  const judges = { 'cojudge-opus': 'S', 'cojudge-sol': 'N' } as const;
  const perJudge = Object.fromEntries((Object.keys(judges) as (keyof typeof judges)[]).map(g => {
    const set = items.filter(it => it.set === judges[g]);
    const labelled = set.filter(it => labels.has(it.item_id));
    const errors = set.filter(it => verdict(g, it.item_id) === null).length;
    const pairs = labelled.filter(it => verdict(g, it.item_id) !== null).map(it => [verdict(g, it.item_id)!, labels.get(it.item_id)!] as [boolean, boolean]);
    const k = kappa(pairs);
    const right = labelled.filter(it => labels.get(it.item_id)).length, wrong = labelled.length - right;
    const gates = { labelled_items: labelled.length >= 40 && right >= 15 && wrong >= 15, kappa: k !== null && k >= 0.6, no_errors: errors === 0 };
    return [g, {
      set: judges[g], items: set.length, labelled: labelled.length, labelled_right: right, labelled_wrong: wrong, errors,
      agree_with_labels: pairs.filter(([a, b]) => a === b).length, kappa: k, gates, pass: labellerGate && Object.values(gates).every(Boolean),
      official_gpt4o_kappa_descriptive: kappa(labelled.map(it => [it.official === 1, labels.get(it.item_id)!] as [boolean, boolean])),
    }];
  })) as unknown as Record<keyof typeof judges, { pass: boolean; kappa: number | null; [k: string]: unknown }>;
  return { items: items.length, labelled_by_both: both.length, labellers_agree: labels.size, labeller_kappa: labellerKappa, labeller_gate: labellerGate, judges: perJudge, pass: labellerGate && Object.values(perJudge).every(j => j.pass) };
}

async function main(argv: string[]): Promise<number> {
  const [cmd] = argv;
  const out = flag(argv, '--out');
  if (!out) throw new Error('pass --out <dir>');
  if (cmd === 'plan') {
    if (existsSync(join(out, 'pool.json'))) { loadPool(out); console.log(join(out, 'pool.json') + ' matches the plan'); return 0; }
    mkdirSync(out, { recursive: true });
    const p = plan();
    writeFileSync(join(out, 'pool.json'), JSON.stringify(p, null, 1) + '\n');
    console.log(JSON.stringify({ items: p.items.length, by_reader: p.items.reduce((m, i) => ({ ...m, [i.set + '-' + i.reader]: (m[i.set + '-' + i.reader] ?? 0) + 1 }), {} as Record<string, number>) }));
    return 0;
  }
  if (cmd === 'run') return run(argv);
  if (cmd === 'report') {
    const pool = loadPool(out);
    const report = score(pool.items, readNdjson(join(out, 'grades.ndjson')) as GradeRow[]);
    writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 1) + '\n');
    console.log(JSON.stringify(report, null, 1));
    return report.pass ? 0 : 3;
  }
  throw new Error('usage: r3-judge-check.ts plan | run | report --out <dir>');
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
}
