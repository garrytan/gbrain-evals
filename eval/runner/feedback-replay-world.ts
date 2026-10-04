/**
 * P3 dev-only replay of use-attributed retrieval feedback on BrainBench world-v1
 * (one shared brain, relational template + paraphrase questions, gold from
 * world-v1 _facts). Same arms as p3-feedback-replay-dev.ts. Template and
 * paraphrase forms of one question stay in the same half.
 *
 * Usage: bun eval/runner/feedback-replay-world.ts --gbrain <checkout>@<sha> --output <dir> [--lambdas ...] [--positive-only] --paid --budget-usd N
 */
import './budget-ledger.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { budgetOptionsFrom, startPaidRun, receiptCost } from './budget-ledger.ts';
import { gbrainSpecFrom, importGbrain, resolveGbrainUnderTest } from './gbrain-under-test.ts';
import { uniqueInOrder, ndcgAtK, recallAllAtK } from './metrics.ts';
import { GbrainInlineAdapter } from './adapters/gbrain-inline.ts';
import { buildRelationalQueries, loadWorldCorpus } from './queries/relational.ts';
import { paraphraseQueries, RELATIONAL_PINS } from './relational-ab.ts';
import { sanitizePage } from './types.ts';
import { templateOfText } from '../generators/relational-paraphrase-gen.ts';
import { loadSplit } from './decisions/splits.ts';
import { appendAccessLog } from './sealed-confirmation-lib.ts';

type MemoryQuestion = { id: string; base: string; question: string; gold: string[]; category: string; conversation: string };

// Held-out (custodian) mode: --split sealed --decision-id <id> --purpose <text>. The access is logged before any sealed
// question is read; the implementer never runs this mode.
function sealedAccess(argv: string[], what: string): boolean {
  const i = argv.indexOf('--split');
  const split = i >= 0 ? argv[i + 1] : 'dev';
  if (split === 'dev') return false;
  if (split !== 'sealed') throw new Error('--split must be dev or sealed');
  const d = argv.indexOf('--decision-id'), p = argv.indexOf('--purpose');
  if (d < 0 || p < 0) throw new Error('--split sealed is custodian-only and needs --decision-id and --purpose for the access log');
  const log = process.env.GBRAIN_EVALS_CUSTODY_LOG;
  if (!log) throw new Error('--split sealed needs GBRAIN_EVALS_CUSTODY_LOG (the custodian access-log path)');
  appendAccessLog(log, { action: 'open', purpose: `${what}: ${argv[p + 1]}`, decision_id: argv[d + 1], labels_sha256: 'public-split-file', run_sha256: null });
  return true;
}

const argv = process.argv.slice(2);
const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const output = resolve(one('--output') ?? 'eval/reports/p3-replay-dev');
const lambdas = (one('--lambdas') ?? '0.1,0.2,0.3').split(',').map(Number);
const seed = Number(one('--seed') ?? 42);
const TOP_K = 10;
const POSITIVE_ONLY = argv.includes('--positive-only');
mkdirSync(output, { recursive: true });

const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
const pagesRich = loadWorldCorpus(join(import.meta.dir, '../data/world-v1'));
const templates = buildRelationalQueries(pagesRich);
const allQ = [...templates.map(q => ({ ...q, base: q.id })), ...paraphraseQueries(templates).map(q => ({ ...q, base: q.id.replace(/-p$/, '') }))];
const questions: MemoryQuestion[] = allQ
  .map(q => ({ id: q.id, base: q.base, question: q.text, gold: [...((q.gold as { relevant?: string[] }).relevant ?? [])], category: templateOfText(templates.find(t => t.id === q.base)!.text), conversation: 'world-v1' }))
  .filter(q => q.gold.length > 0);
// Proposed world-v1 E1 split, P0 method (salted sha256 order, first half dev) over base question ids; only dev is read here.
const worldSplit = loadSplit('world-v1-relational');
const sealedRun = sealedAccess(argv, 'feedback-replay world-v1 sealed questions');
const worldDev = new Set(sealedRun ? worldSplit.sealed : worldSplit.dev);
writeFileSync(join(output, 'world-v1-relational-split.json'), JSON.stringify(worldSplit, null, 2) + '\n');
const devQuestions = questions.filter(q => worldDev.has(q.base));
const h = (s: string) => createHash('sha256').update(`${seed}\u0000${s}`).digest('hex');
const isTrain = (q: MemoryQuestion) => parseInt(h(q.base).slice(0, 8), 16) % 2 === 0;

const paid = startPaidRun('p3-feedback-replay-world-dev', { ...budgetOptionsFrom(argv), estimateUsd: 0.5 });
const adapter = new GbrainInlineAdapter({
  topK: TOP_K, extract: true, searchConfig: { ...RELATIONAL_PINS },
  embeddingModel: 'openai:text-embedding-3-large', embeddingDimensions: 1536, expectStubTransport: false, embed: true, productRoot: gut.root,
} as never);
const { hybridSearch } = await importGbrain<any>(gut, 'src/core/search/hybrid.ts');
const { recordAnswer, drainFeedbackQueue, _resetFeedbackRecordingForTests } = await importGbrain<any>(gut, 'src/core/feedback/record.ts');
const { rateAnswer } = await importGbrain<any>(gut, 'src/core/feedback/rate.ts');
const { _resetFeedbackSettingsCacheForTests } = await importGbrain<any>(gut, 'src/core/feedback/settings.ts');
const scoreRetrieval = (retrieved: string[], gold: string[]) => ({
  recall_all_at_5: recallAllAtK(retrieved, new Set(gold), 5), ndcg_at_10: ndcgAtK(retrieved, new Map(gold.map(g => [g, 1])), 10),
});
const PINS: Record<string, string> = { 'feedback.max_ratings_per_hour': '1000000', 'feedback.implicit': 'false' };

type Row = { arm: string; lambda: number; id: string; conversation: string; category: string; recall_all_at_5: number; ndcg_at_10: number; cold: boolean };
const rows: Row[] = [];

async function setCfg(e: any, kv: Record<string, string>) {
  for (const [k, v] of Object.entries(kv)) await e.setConfig(k, v);
  _resetFeedbackSettingsCacheForTests();
}
async function clearFeedback(e: any) {
  await e.executeRaw('DELETE FROM retrieval_weights');
  await e.executeRaw('DELETE FROM retrieval_events');
  _resetFeedbackRecordingForTests();
}
const ctxFor = (e: any) => ({ engine: e, config: {}, remote: false, logger: console });

async function ask(e: any, q: MemoryQuestion, bySlug: Map<string, string>) {
  const results = await hybridSearch(e, q.question, { limit: TOP_K * 3, expansion: false }) as Array<{ slug: string; source_id?: string; content_hash?: string }>;
  const retrieved = uniqueInOrder(results.map(r => bySlug.get(r.slug) ?? `?${r.slug}`)).slice(0, TOP_K);
  return { results, retrieved };
}

async function teach(e: any, q: MemoryQuestion, results: Array<{ slug: string; source_id?: string; content_hash?: string }>, bySlug: Map<string, string>, flip: boolean) {
  const pages = uniqueInOrder(results.map(r => r.slug)).slice(0, TOP_K * 2).map(slug => {
    const r = results.find(x => x.slug === slug)!;
    return { source_id: r.source_id ?? 'default', slug, content_hash: r.content_hash ?? null };
  });
  const meta = await recordAnswer(ctxFor(e), { op: 'search', pages });
  if (!meta?.answer_id) throw new Error(`answer not recorded: ${JSON.stringify(meta)}`);
  await drainFeedbackQueue(10_000);
  const gold = new Set(q.gold);
  const ratings = pages.map(p => {
    let good = gold.has(bySlug.get(p.slug) ?? '');
    if (flip && parseInt(h(`flip:${q.id}:${p.slug}`).slice(0, 8), 16) % 5 === 0) good = !good;
    return { ref: `${p.source_id}:${p.slug}`, rating: good ? 5 : 1 };
  }).filter(r => !POSITIVE_ONLY || r.rating === 5);
  if (ratings.length === 0) return;
  await rateAnswer(ctxFor(e), { answer_id: meta.answer_id, pages: ratings });
}

function push(arm: string, lambda: number, q: MemoryQuestion, retrieved: string[], seen: Set<string>) {
  const s = scoreRetrieval(retrieved, q.gold);
  rows.push({ arm, lambda, id: q.id, conversation: q.conversation, category: q.category,
    recall_all_at_5: s.recall_all_at_5!, ndcg_at_10: s.ndcg_at_10!, cold: !q.gold.some(g => seen.has(g)) });
}

const state = await adapter.init(pagesRich.map(sanitizePage) as never, { name: 'p3-feedback-world' } as never);
const e = adapter.engineOf(state) as any;
{
  const convId = 'world-v1';
  await setCfg(e, { ...PINS, 'feedback.enabled': 'false' });
  const bySlug = { get: (s: string) => s } as unknown as Map<string, string>;
  const qs = devQuestions.filter(q => q.conversation === convId).sort((a, b) => (h(a.id) < h(b.id) ? -1 : 1));
  const train = qs.filter(isTrain);
  const score = qs.filter(q => !isTrain(q));

  // Baseline ranking; exposure counts for the frequency arm and the cold-start subgroup.
  const exposure = new Map<string, number>();
  const trainGoldSeen = new Set<string>();
  for (const q of train) {
    const { results, retrieved } = await ask(e, q, bySlug);
    for (const slug of uniqueInOrder(results.map(r => r.slug)).slice(0, TOP_K)) exposure.set(slug, (exposure.get(slug) ?? 0) + 1);
    for (const s of retrieved) if (q.gold.includes(s)) trainGoldSeen.add(s);
  }
  for (const q of score) push('off', 0, q, (await ask(e, q, bySlug)).retrieved, trainGoldSeen);

  for (const lambda of lambdas) {
    for (const flip of [false, true]) {
      await clearFeedback(e);
      await setCfg(e, { 'feedback.enabled': 'true', 'feedback.learn': 'true', 'feedback.influence': String(lambda) });
      for (const q of train) await teach(e, q, (await ask(e, q, bySlug)).results, bySlug, flip);
      await setCfg(e, { 'feedback.learn': 'false' });
      for (const q of score) push(flip ? 'noisy' : 'frozen', lambda, q, (await ask(e, q, bySlug)).retrieved, trainGoldSeen);
    }

    await clearFeedback(e);
    await setCfg(e, { 'feedback.enabled': 'true', 'feedback.learn': 'true', 'feedback.influence': String(lambda) });
    for (const q of qs) {
      const { results, retrieved } = await ask(e, q, bySlug);
      if (!isTrain(q)) push('online', lambda, q, retrieved, trainGoldSeen);
      await teach(e, q, results, bySlug, false);
    }

    await clearFeedback(e);
    const max = Math.max(1, ...exposure.values());
    for (const [slug, n] of exposure) {
      await e.executeRaw(
        `INSERT INTO retrieval_weights (source_id, element_kind, element_key, weight, content_hash, updates)
         SELECT 'default', 'page', $1, $2, content_hash, 1 FROM pages WHERE slug = $1`, [slug, 0.5 + 0.5 * (n / max)]);
    }
    await setCfg(e, { 'feedback.enabled': 'true', 'feedback.learn': 'false', 'feedback.influence': String(lambda) });
    for (const q of score) push('freq', lambda, q, (await ask(e, q, bySlug)).retrieved, trainGoldSeen);
  }
  process.stderr.write(`[p3-replay] ${convId}: train ${train.length}, score ${score.length}\n`);
}

await adapter.teardown(state);
const summary: Record<string, unknown> = {};
const key = (r: Row) => `${r.arm}@${r.lambda}`;
const groups = new Map<string, Row[]>();
for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
const base = new Map(rows.filter(r => r.arm === 'off').map(r => [r.id, r]));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
for (const [k, rs] of groups) {
  const d = rs.map(r => r.ndcg_at_10 - base.get(r.id)!.ndcg_at_10);
  const cold = rs.filter(r => r.cold);
  const byCat: Record<string, number> = {};
  for (const cat of [...new Set(rs.map(r => r.category))]) byCat[cat] = +mean(rs.filter(r => r.category === cat).map(r => r.ndcg_at_10 - base.get(r.id)!.ndcg_at_10)).toFixed(4);
  // Cluster bootstrap over conversations is too coarse with 3 dev conversations; resample questions for a dev-only interval.
  const draws: number[] = [];
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 2000; i++) { let t = 0; for (let j = 0; j < d.length; j++) t += d[Math.floor(rnd() * d.length)]!; draws.push(t / d.length); }
  draws.sort((a, b) => a - b);
  summary[k] = {
    n: rs.length, ndcg_at_10: +mean(rs.map(r => r.ndcg_at_10)).toFixed(4), recall_all_at_5: +mean(rs.map(r => r.recall_all_at_5)).toFixed(4),
    delta_ndcg: +mean(d).toFixed(4), ci95: [+draws[50]!.toFixed(4), +draws[1949]!.toFixed(4)],
    cold_n: cold.length, cold_delta_ndcg: +mean(cold.map(r => r.ndcg_at_10 - base.get(r.id)!.ndcg_at_10)).toFixed(4), by_category_delta_ndcg: byCat,
  };
}
const costSummary = paid.run.close();
paid.guard.uninstall();
writeFileSync(join(output, 'rows.ndjson'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
writeFileSync(join(output, 'summary.json'), JSON.stringify({ benchmark: 'world-v1 relational (template + paraphrase)', labels: POSITIVE_ONLY ? 'positive-only' : 'gold 5 / non-gold 1', split: 'dev-only halves by base question', gbrain: gut.overlay?.build.commit ?? gut.version, seed, lambdas, cost: receiptCost(costSummary), arms: summary }, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
