/**
 * Plan P3 E2: use-attributed retrieval feedback from the implicit citation
 * signal only, measured on gbrain's own answer path. Every answer goes through
 * the `think` OPERATION with a trusted local context, so each answer is
 * recorded and the pages its synthesis cites feed the ranking (the memory-qa
 * think lane calls runThink directly and records nothing).
 *
 * LoCoMo, one fresh brain per conversation. Questions inside the chosen
 * conversations are split into a train half and a score half by
 * sha256(seed, id). Arms, each on a clean copy of the conversation's feedback
 * state (pages and vectors are shared, feedback tables are emptied):
 *   off     feedback.influence=0 and feedback.learn=false: the shipped ranking with answers still recorded,
 *           so the gather is readable (influence 0 leaves the list untouched)
 *   frozen  `think` on the train half with learning on, then the score half with feedback.learn=false
 *   sparse  frozen, trained on a seeded 25% of the train half (a brain that makes few think calls)
 *   online  one seeded stream of every question with learning on (each answer is scored before its
 *           own citations apply); metrics over score-half questions only
 * Score half: one `think` answer per question per arm, judged `--judge-runs` times (P0 LoCoMo judge
 * prompts; adversarial questions use the unanswerable prompt and record trap repeats), plus the
 * judge-free Recall@5 of the gather (the answer's recorded pages in rank order, reduced to sessions).
 * Reported per arm: judge mean, the SD of the per-replicate arm means, Δ against off with a question
 * bootstrap interval (dev) and per-conversation means for the custodian's cluster bootstrap, gather
 * Recall@5, trap rate, and implicit (cited) events per 100 answers.
 *
 * Dev:       bun eval/runner/feedback-think-replay.ts --gbrain <checkout>@<sha> --output <dir> --paid --budget-usd N
 *            [--train-limit N --score-limit N per conversation] [--judge-runs 3] [--think-model M] [--lambda 0.1]
 * Custodian: add --split sealed --decision-id <id> --purpose <text> with GBRAIN_EVALS_CUSTODY_LOG set; the
 *            access is logged before any sealed question is read. Implementers never run this mode.
 */
import './budget-ledger.ts';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { budgetOptionsFrom, startPaidRun, receiptCost } from './budget-ledger.ts';
import { gbrainSpecFrom, importGbrain, productIdentityFor, resolveGbrainUnderTest } from './gbrain-under-test.ts';
import { EmbeddingCache, makeCachingTransport } from './longmemeval-cache.ts';
import { recallAllAtK, uniqueInOrder } from './metrics.ts';
import { loadCorpus, occurrenceId, renderSessionPage, type MemoryQuestion } from './memory-qa/corpus.ts';
import { ChatClient, DEFAULT_JUDGE, judgePromptsFor, judgeYes, repeatsTrap } from './memory-qa/qa.ts';
import { devConversations, loadSplit } from './decisions/splits.ts';
import { appendAccessLog } from './sealed-confirmation-lib.ts';

const argv = process.argv.slice(2);
const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const num = (n: string, d: number | null) => (one(n) === undefined ? d : Number(one(n)));
const output = resolve(one('--output') ?? 'eval/reports/feedback-think-replay');
const lambda = Number(one('--lambda') ?? 0.1);
const seed = Number(one('--seed') ?? 42);
const judgeRuns = Number(one('--judge-runs') ?? 10);
const judgeTemperature = Number(one('--judge-temperature') ?? 0.7);
const trainLimit = num('--train-limit', null);
const scoreLimit = num('--score-limit', null);
const thinkModel = one('--think-model') ?? 'anthropic:claude-sonnet-5-5';
const judgeModel = one('--judge') ?? DEFAULT_JUDGE.locomo!;
const arms = (one('--arms') ?? 'off,frozen,sparse,online').split(',');
const TOP_K = 5;
mkdirSync(output, { recursive: true });

function sealedAccess(): boolean {
  const split = one('--split') ?? 'dev';
  if (split === 'dev') return false;
  if (split !== 'sealed') throw new Error('--split must be dev or sealed');
  const decision = one('--decision-id'), purpose = one('--purpose');
  if (!decision || !purpose) throw new Error('--split sealed is custodian-only and needs --decision-id and --purpose for the access log');
  const log = process.env.GBRAIN_EVALS_CUSTODY_LOG;
  if (!log) throw new Error('--split sealed needs GBRAIN_EVALS_CUSTODY_LOG (the custodian access-log path)');
  appendAccessLog(log, { action: 'open', purpose: `feedback-think-replay locomo sealed conversations: ${purpose}`, decision_id: decision, labels_sha256: 'public-split-file', run_sha256: null });
  return true;
}

const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
const corpus = loadCorpus('locomo');
const sealed = sealedAccess();
const chosen = sealed ? new Set(loadSplit('locomo').sealed) : devConversations('locomo')!;
const h = (s: string) => createHash('sha256').update(`${seed}\u0000${s}`).digest('hex');
const byHash = (a: MemoryQuestion, b: MemoryQuestion) => (h(a.id) < h(b.id) ? -1 : 1);
const isTrain = (q: MemoryQuestion) => parseInt(h(q.id).slice(0, 8), 16) % 2 === 0;
const inSparse = (q: MemoryQuestion) => parseInt(h(`sparse:${q.id}`).slice(0, 8), 16) % 4 === 0;

const plan = [...chosen].sort().map(conv => {
  const qs = corpus.questions.filter(q => q.conversation === conv).sort(byHash);
  const train = qs.filter(q => isTrain(q) && !q.abstention && q.gold.length > 0).slice(0, trainLimit ?? undefined);
  const score = qs.filter(q => !isTrain(q)).slice(0, scoreLimit ?? undefined);
  return { conv, train, score, stream: [...train, ...score].sort(byHash) };
});
const thinkCalls = plan.reduce((n, p) => n + p.score.length * arms.length
  + (arms.includes('frozen') ? p.train.length : 0) + (arms.includes('sparse') ? p.train.filter(inSparse).length : 0)
  + (arms.includes('online') ? p.train.length : 0), 0);
const scored = plan.reduce((n, p) => n + p.score.length, 0) * arms.length;
const estimate = Math.round((thinkCalls * Number(one('--usd-per-think') ?? 0.04) + scored * judgeRuns * 0.003 + 0.5) * 100) / 100;
const paid = startPaidRun('feedback-think-replay', { ...budgetOptionsFrom(argv), estimateUsd: estimate });

const gateway = await importGbrain<any>(gut, 'src/core/ai/gateway.ts');
gateway.configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: process.env });
const { embedMany } = await import(Bun.resolveSync('ai', gut.root)) as { embedMany: (p: unknown) => Promise<unknown> };
const cacheDir = process.env.GBRAIN_EVALS_EMBED_CACHE ?? join(homedir(), '.cache', 'gbrain-evals', 'embed-cache');
const embedCache = new EmbeddingCache(join(cacheDir, 'embed-cache-openai_text-embedding-3-large@1536.sqlite'), 'openai:text-embedding-3-large@1536');
gateway.__setEmbedTransportForTests(makeCachingTransport(async (p: any) => embedMany(p) as never, embedCache));

const { PGLiteEngine } = await importGbrain<any>(gut, 'src/core/pglite-engine.ts');
const { importFromContent } = await importGbrain<any>(gut, 'src/core/import-file.ts');
const { operations } = await importGbrain<any>(gut, 'src/core/operations.ts');
const { drainFeedbackQueue, _resetFeedbackRecordingForTests } = await importGbrain<any>(gut, 'src/core/feedback/record.ts');
const { _resetFeedbackSettingsCacheForTests } = await importGbrain<any>(gut, 'src/core/feedback/settings.ts');
const thinkOp = (operations as Array<{ name: string; handler: (ctx: unknown, p: unknown) => Promise<any> }>).find(o => o.name === 'think')!;
const chat = new ChatClient(process.env.GBRAIN_EVALS_QA_CACHE ?? join(homedir(), '.cache', 'gbrain-evals', 'qa-cache'));

const PINS: Record<string, string> = { 'search.mode': 'balanced', 'search.reranker.enabled': 'false', 'search.autocut': 'false', 'feedback.rating_prompt': 'false' };

interface Row {
  arm: string; id: string; conversation: string; category: string; abstention: boolean;
  judge: number[]; trap: number | null; gather_recall_at_5: number | null; synthesis_status: string | null; answer: string; error?: string;
}
const rowsPath = join(output, 'rows.ndjson');
writeFileSync(rowsPath, '');
const rows: Row[] = [];
const implicit = new Map<string, { answers: number; cited: number }>();

async function setCfg(e: any, kv: Record<string, string>) {
  for (const [k, v] of Object.entries(kv)) await e.setConfig(k, v);
  _resetFeedbackSettingsCacheForTests();
}
async function clearFeedback(e: any) {
  await drainFeedbackQueue(30_000);
  await e.executeRaw('DELETE FROM retrieval_weights');
  await e.executeRaw('DELETE FROM retrieval_events');
  _resetFeedbackRecordingForTests();
}
const ctxFor = (e: any) => ({ engine: e, config: { engine: 'pglite' }, remote: false, dryRun: false, sourceId: 'default', logger: { info: () => {}, warn: () => {}, error: () => {} } });

async function answer(e: any, arm: string, q: MemoryQuestion) {
  const res = await thinkOp.handler(ctxFor(e), { question: q.question, model: thinkModel });
  await drainFeedbackQueue(30_000);
  const t = implicit.get(arm) ?? { answers: 0, cited: 0 };
  t.answers++;
  let gathered: string[] = [];
  if (res.answer_id) {
    const pages = await e.executeRaw(`SELECT slug FROM retrieval_event_pages WHERE event_id = $1 ORDER BY rank`, [res.answer_id]) as Array<{ slug: string }>;
    gathered = pages.map(p => p.slug);
    const [c] = await e.executeRaw(`SELECT count(*)::int AS n FROM retrieval_feedback WHERE event_id = $1 AND signal = 'cited'`, [res.answer_id]) as Array<{ n: number }>;
    t.cited += Number(c?.n ?? 0);
  }
  implicit.set(arm, t);
  return { text: String(res.answer ?? ''), status: (res.synthesis_status as string | undefined) ?? null, gathered };
}

async function scoreQuestion(e: any, arm: string, q: MemoryQuestion, bySlug: Map<string, string>) {
  const base = { arm, id: q.id, conversation: q.conversation, category: q.category, abstention: q.abstention };
  try {
    const a = await answer(e, arm, q);
    const judge: number[] = [];
    for (let r = 0; r < judgeRuns; r++) {
      const prompts = judgePromptsFor('locomo', q, a.text);
      let yes = 0;
      for (const p of prompts) if (judgeYes((await chat.chat(judgeModel, p, { maxTokens: 10, replicate: r, temperature: judgeTemperature })).text)) yes++;
      judge.push(yes / prompts.length);
    }
    const sessions = uniqueInOrder(a.gathered.map(s => bySlug.get(s) ?? `?${s}`)).slice(0, TOP_K);
    const row: Row = { ...base, judge, trap: q.abstention && q.trap ? (repeatsTrap(a.text, q.trap) ? 1 : 0) : null,
      gather_recall_at_5: q.gold.length ? recallAllAtK(sessions, new Set(q.gold), TOP_K) : null, synthesis_status: a.status, answer: a.text.slice(0, 1500) };
    rows.push(row);
    appendFileSync(rowsPath, JSON.stringify(row) + '\n');
  } catch (err) {
    const row: Row = { ...base, judge: [], trap: null, gather_recall_at_5: null, synthesis_status: null, answer: '', error: (err as Error).message.slice(0, 300) };
    rows.push(row);
    appendFileSync(rowsPath, JSON.stringify(row) + '\n');
  }
}

for (const p of plan) {
  const conv = corpus.conversations.find(c => c.id === p.conv)!;
  const e = new PGLiteEngine();
  await e.connect({});
  await e.initSchema();
  await setCfg(e, { ...PINS, 'feedback.enabled': 'false' });
  const bySlug = new Map<string, string>();
  for (const s of conv.sessions) {
    const slug = `chat/${occurrenceId(conv.id, s.id)}`;
    bySlug.set(slug, s.id);
    await importFromContent(e, slug, renderSessionPage(s), {});
  }
  const learning = { 'feedback.enabled': 'true', 'feedback.learn': 'true', 'feedback.implicit': 'true', 'feedback.influence': String(lambda) };
  for (const arm of arms) {
    await clearFeedback(e);
    if (arm === 'off') {
      await setCfg(e, { 'feedback.enabled': 'true', 'feedback.learn': 'false', 'feedback.influence': '0' });
      for (const q of p.score) await scoreQuestion(e, arm, q, bySlug);
    } else if (arm === 'frozen' || arm === 'sparse') {
      await setCfg(e, learning);
      for (const q of p.train) if (arm === 'frozen' || inSparse(q)) await answer(e, `${arm}:train`, q);
      await setCfg(e, { 'feedback.learn': 'false' });
      for (const q of p.score) await scoreQuestion(e, arm, q, bySlug);
    } else if (arm === 'online') {
      await setCfg(e, learning);
      const scoreIds = new Set(p.score.map(q => q.id));
      for (const q of p.stream) {
        if (scoreIds.has(q.id)) await scoreQuestion(e, arm, q, bySlug);
        else await answer(e, `${arm}:train`, q);
      }
    } else {
      throw new Error(`unknown arm ${arm}`);
    }
  }
  await e.disconnect();
  process.stderr.write(`[feedback-think-replay] ${p.conv}: train ${p.train.length}, score ${p.score.length}\n`);
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x - m) ** 2))); };
const ok = rows.filter(r => !r.error && r.judge.length);
const offById = new Map(ok.filter(r => r.arm === 'off').map(r => [r.id, mean(r.judge)]));
const summary: Record<string, unknown> = {};
for (const arm of arms) {
  const rs = ok.filter(r => r.arm === arm);
  const perReplicate = Array.from({ length: judgeRuns }, (_, i) => mean(rs.map(r => r.judge[i] ?? 0)));
  const d = rs.filter(r => offById.has(r.id)).map(r => mean(r.judge) - offById.get(r.id)!);
  const draws: number[] = [];
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 2000 && d.length; i++) { let t = 0; for (let j = 0; j < d.length; j++) t += d[Math.floor(rnd() * d.length)]!; draws.push(t / d.length); }
  draws.sort((a, b) => a - b);
  const answerable = rs.filter(r => !r.abstention && r.gather_recall_at_5 !== null);
  const traps = rs.filter(r => r.trap !== null);
  const imp = implicit.get(`${arm}:train`) ?? implicit.get(arm);
  summary[arm] = {
    n: rs.length, errors: rows.filter(r => r.arm === arm && r.error).length,
    judge_mean: +mean(rs.map(r => mean(r.judge))).toFixed(4), judge_sd_across_replicates: +sd(perReplicate).toFixed(4),
    delta_vs_off: arm === 'off' ? 0 : +mean(d).toFixed(4), delta_ci95_question_bootstrap: arm === 'off' || !draws.length ? null : [+draws[50]!.toFixed(4), +draws[1949]!.toFixed(4)],
    by_conversation: Object.fromEntries([...new Set(rs.map(r => r.conversation))].map(c => [c, +mean(rs.filter(r => r.conversation === c).map(r => mean(r.judge))).toFixed(4)])),
    answerable_judge_mean: +mean(rs.filter(r => !r.abstention).map(r => mean(r.judge))).toFixed(4),
    adversarial_abstention_mean: traps.length || rs.some(r => r.abstention) ? +mean(rs.filter(r => r.abstention).map(r => mean(r.judge))).toFixed(4) : null,
    trap_repeat_rate: traps.length ? +mean(traps.map(r => r.trap!)).toFixed(4) : null,
    gather_recall_at_5: +mean(answerable.map(r => r.gather_recall_at_5!)).toFixed(4),
    implicit_cited_events_per_100_answers: imp && imp.answers ? +((100 * imp.cited) / imp.answers).toFixed(2) : null,
  };
}
const cost = paid.run.close();
paid.guard.uninstall();
embedCache.close();
writeFileSync(join(output, 'summary.json'), JSON.stringify({
  plan: 'P3 E2', benchmark: 'locomo', split: sealed ? 'sealed' : 'dev', product: productIdentityFor(gut), seed, lambda, think_model: thinkModel,
  judge: { model: judgeModel, runs: judgeRuns, temperature: judgeTemperature }, limits: { train: trainLimit, score: scoreLimit },
  conversations: plan.map(p => ({ id: p.conv, train: p.train.length, score: p.score.length })), cost: receiptCost(cost), arms: summary,
}, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
