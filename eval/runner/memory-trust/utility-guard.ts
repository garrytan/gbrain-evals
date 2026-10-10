/**
 * Memory trust utility guard (preregistration amendment 1): LongMemEval-S
 * retrieval and answers at the measured gbrain head, in label mode, compared
 * with the published W10 rows.
 *
 *   capture --gbrain <checkout>@<commit>   gbrain's own `eval longmemeval` with W10a's arguments and the
 *                                          recording stub reader, through the copied overlay; retrieval
 *                                          spend (embeddings, rerank) reserves through the ledger
 *   submit --model <m>                     reader batch per counted model (W10 MODEL_SETTINGS)
 *   judge --model <m>                      official gpt-4o-2024-08-06 judge batch over that reader's rows
 *   poll                                   settle open batches
 *   summary [--out <file>]                 retrieval recall_all@5, answers per model, paired McNemar vs published
 *
 * Every command takes --budget-ledger <path> --budget-run-id <id> and attests
 * the memory trust preregistration. State lives in $MT_GUARD_STATE_DIR
 * (default ~/.capy/work/lane-e/guard).
 */
// First import: the process's fetch before any module wraps it (importing gbrain modules replaces globalThis.fetch,
// and a guard over that wrapper recurses into itself).
import { realFetch } from '../batch/real-fetch.ts';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { BudgetRun, budgetOptionsFrom, installPaidRequestGuard } from '../budget-ledger.ts';
import { gbrainSpecFrom, importGbrain, resolveGbrainUnderTest } from '../gbrain-under-test.ts';
import { attestPreregistration } from '../prereg.ts';
import { exactMcNemar } from '../stats/paired.ts';
import { MODEL_SETTINGS, buildManifest, type ArmManifest } from '../batch/manifest.ts';
import { judgeOutcome, readerRows } from '../batch/receipts.ts';
import { HOUSE_NOTES_PROTOCOL, JUDGE_PROTOCOL, captureClient, judgeBody, loadDataset, readNdjson, readerBody, reportType } from '../batch/sources.ts';
import { BatchLane } from '../batch/submit.ts';
import { anthropicTransport, openAiTransport } from '../batch/transport.ts';
import { W10A_ARGS, refuseReaderFetch } from '../batch/w10a-capture.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const PREREG = 'docs/benchmarks/2026-10-07-memory-trust-preregistration.md';
const STATE = process.env.MT_GUARD_STATE_DIR ?? join(homedir(), '.capy/work/lane-e/guard');
const DATASET = process.env.LME_DATASET ?? join(homedir(), '.capy/work/lane-e/lme/longmemeval_s_cleaned.json');
const CAPTURES = join(STATE, 'captures.ndjson');
const ROWS = join(STATE, 'rows.ndjson');
const READERS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol'] as const;
/** Published per-question rows to pair against: W10a Sonnet 5.5 at c5fb0201, W10b Opus 5.5 and GPT-6.1 Sol on the 2026-09-29 retrieval. */
const PUBLISHED: Record<string, { label: string; rows: string; correct: number }> = {
  'claude-sonnet-5-5': { label: 'W10a Sonnet 5.5 notes reader at c5fb0201', rows: 'docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin/arms/w10a-sonnet55-notes/rows.ndjson', correct: 468 },
  'claude-opus-5-5': { label: 'W10b Opus 5.5 notes reader on the 2026-09-29 retrieval', rows: 'docs/benchmarks/2026-10-07-longmemeval-w10b-reader-replay/arms/w10b-opus55-notes/rows.ndjson', correct: 474 },
  'gpt-6.1-sol': { label: 'W10b GPT-6.1 Sol notes reader on the 2026-09-29 retrieval', rows: 'docs/benchmarks/2026-10-07-longmemeval-w10b-reader-replay/arms/w10b-sol-notes/rows.ndjson', correct: 464 },
};

const flag = (argv: string[], name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const armId = (model: string) => `mt-guard-${model}`;
const judgeArm = (model: string) => `${armId(model)}--official`;

function run(argv: string[]): BudgetRun {
  const opts = budgetOptionsFrom(argv);
  if (!opts.runId) throw new Error('pass --budget-run-id <id> (the shared memory-trust-evals run) and --budget-ledger <path>');
  return BudgetRun.join({ runId: opts.runId, ledgerPath: opts.ledgerPath });
}

function lane(r: BudgetRun): BatchLane {
  return new BatchLane({ statePath: join(STATE, 'batch-state.sqlite'), transports: { openai: openAiTransport(), anthropic: anthropicTransport() }, run: r, parallel: true });
}

const dataset = () => loadDataset(DATASET);

/** Captured reader text by question id, joined through the harness rows (as w10.ts captures()). */
function captures(): Map<string, { system: string; user: string }> {
  const rows = readNdjson(ROWS).filter(r => typeof r.question_id === 'string');
  const byKey = new Map(readNdjson(CAPTURES).map(c => [`${c.question}\u0000${c.question_date}`, c]));
  const ds = dataset();
  const out = new Map<string, { system: string; user: string }>();
  for (const r of rows) {
    const q = ds.get(r.question_id);
    const c = q ? byKey.get(`${q.question}\u0000${q.question_date}`) : undefined;
    if (c) out.set(r.question_id, { system: c.system, user: c.user });
  }
  return out;
}

function readerManifest(model: string): { manifest: ArmManifest; bodies: Map<string, Record<string, unknown>> } {
  const caps = captures();
  const bodies = new Map([...caps].map(([id, text]) => [id, readerBody(model, text)]));
  const manifest = buildManifest({
    arm_id: armId(model), workstream: 'memory-trust-guard', kind: 'reader', provider: MODEL_SETTINGS[model]!.provider, model,
    max_output_tokens: MODEL_SETTINGS[model]!.max_output_tokens, reasoning_effort: MODEL_SETTINGS[model]!.effort,
    protocol: HOUSE_NOTES_PROTOCOL, source: 'memory trust guard capture of gbrain eval longmemeval at the measured head (W10a arguments, label mode); system and user text unchanged',
    denominator: bodies.size, bodies,
  });
  return { manifest, bodies };
}

function judgeManifest(model: string, l: BatchLane): { manifest: ArmManifest; bodies: Map<string, Record<string, unknown>> } {
  const { manifest: reader } = readerManifest(model);
  const ds = dataset();
  const types = new Map([...ds.values()].map(q => [q.question_id, reportType(q)]));
  const rows = readerRows(reader, l.results(reader.arm_id), types).filter(r => !r.error);
  const bodies = new Map(rows.map(r => [r.question_id, judgeBody('official', ds.get(r.question_id)!, r.hypothesis)]));
  const manifest = buildManifest({
    arm_id: judgeArm(model), workstream: 'memory-trust-guard', kind: 'judge', provider: 'openai', model: 'gpt-4o-2024-08-06', max_output_tokens: 10, reasoning_effort: null,
    protocol: JUDGE_PROTOCOL, source: `official gpt-4o-2024-08-06 judge over ${reader.arm_id}'s rows without a reader error`, denominator: bodies.size, bodies,
  });
  return { manifest, bodies };
}

async function capture(argv: string[]): Promise<void> {
  mkdirSync(STATE, { recursive: true });
  const attestation = attestPreregistration(PREREG, ROOT);
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  const r = run(argv);
  const guard = installPaidRequestGuard(r, { fetchImpl: refuseReaderFetch(realFetch) });
  process.env.GBRAIN_EMBEDDING_MODEL = 'openai:text-embedding-3-large';
  process.env.GBRAIN_EMBEDDING_DIMENSIONS = '1536';
  const { configureGateway } = await importGbrain<any>(gut, 'src/core/ai/gateway.ts');
  const { buildGatewayConfig } = await importGbrain<any>(gut, 'src/core/ai/build-gateway-config.ts');
  const { runEvalLongMemEval } = await importGbrain<any>(gut, 'src/commands/eval-longmemeval.ts');
  configureGateway(buildGatewayConfig({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536 }));
  appendFileSync(ROWS, '');
  const started = new Date().toISOString();
  const limit = flag(argv, '--limit');
  const args = [DATASET, ...W10A_ARGS, '--embed-cache', join(STATE, 'embed-cache.sqlite'), '--output', ROWS, '--resume-from', ROWS, ...(limit ? ['--limit', limit] : [])];
  let code = 0;
  try {
    await runEvalLongMemEval(args, {
      client: captureClient(c => appendFileSync(CAPTURES, JSON.stringify({ ts: new Date().toISOString(), question: c.question, question_date: c.question_date, model: c.model, max_tokens: c.max_tokens, system: c.system, user: c.user }) + '\n')),
      exitOnError: false,
    });
  } catch (error) {
    code = 1;
    process.stderr.write(`[guard capture] ${(error as Error).message}\n`);
  } finally {
    guard.uninstall();
  }
  writeFileSync(join(STATE, 'capture-run.json'), JSON.stringify({ started, finished: new Date().toISOString(), args: args.map(a => a.replace(homedir(), '~')), gbrain: { version: gut.version, commit: gut.overlay?.build.commit ?? null }, attestation, exit: code }, null, 1) + '\n');
  process.exit(code);
}

async function submit(argv: string[], kind: 'reader' | 'judge'): Promise<void> {
  attestPreregistration(PREREG, ROOT);
  const model = flag(argv, '--model');
  if (!model || !(READERS as readonly string[]).includes(model)) throw new Error(`--model must be one of ${READERS.join(', ')}`);
  const r = run(argv);
  const l = lane(r);
  const { manifest, bodies } = kind === 'reader' ? readerManifest(model) : judgeManifest(model, l);
  const pending = l.failedQuestionIds(manifest);
  if (!pending.length) { console.log(JSON.stringify({ arm: manifest.arm_id, note: 'nothing left to submit' })); return; }
  const plan = await l.plan(manifest, bodies, { questionIds: pending });
  console.error(`[guard] ${manifest.arm_id}: ${pending.length} requests, worst case $${plan.reserve_usd.toFixed(2)} at factor ${plan.factor}`);
  const intent = await l.submit(manifest, bodies, { questionIds: pending });
  console.log(JSON.stringify({ arm: manifest.arm_id, intent: intent.intent_id, batch: intent.batch_id, requests: intent.items.length, reserved_usd: intent.reserved_usd }));
  l.close();
}

async function poll(argv: string[]): Promise<void> {
  const l = lane(run(argv));
  await l.reconcile();
  for (const o of await l.poll()) console.log(JSON.stringify(o));
  l.close();
}

function summary(argv: string[]): void {
  const l = lane(run(argv));
  const ds = dataset();
  const types = new Map([...ds.values()].map(q => [q.question_id, reportType(q)]));
  const harness = readNdjson(ROWS).filter(r => typeof r.question_id === 'string');
  const answerable = harness.filter(r => !String(r.question_id).endsWith('_abs'));
  const recallAll = answerable.filter(r => {
    const gold: string[] = r.answer_session_ids ?? ds.get(r.question_id)?.answer_session_ids ?? [];
    const got = new Set<string>(r.retrieved_session_ids ?? []);
    return gold.length > 0 && gold.every(g => got.has(g));
  }).length;
  const caps = captures();
  const labeled = [...caps.values()].filter(c => /\[(confirmed by you|your notes|tool data|written by an agent|unverified origin|external, untrusted)/.test(c.user) || c.user.includes('<external-data')).length;
  const readers: Record<string, unknown> = {};
  for (const model of READERS) {
    const { manifest } = readerManifest(model);
    const rows = readerRows(manifest, l.results(manifest.arm_id), types);
    const judged = l.results(judgeArm(model));
    const scored = rows.map(r => ({ question_id: r.question_id, error: r.error, correct: r.error ? 0 : judgeOutcome(judged.get(r.question_id)).verdict ? 1 : 0, judge_error: r.error ? null : judgeOutcome(judged.get(r.question_id)).error }));
    const correct = scored.filter(s => s.correct === 1).length;
    const usd = rows.reduce((s, r) => s + (r.usd ?? 0), 0) + [...judged.values()].reduce((s, r) => s + (r.usd ?? 0), 0);
    const pub = PUBLISHED[model];
    let paired: Record<string, unknown> | null = null;
    if (pub && existsSync(join(ROOT, pub.rows))) {
      const prior = new Map(readNdjson(join(ROOT, pub.rows)).map(r => [r.question_id as string, r.correct_official === 1 || r.correct_official === true || r.official?.verdict === true ? 1 : 0]));
      const pairs = scored.filter(s => prior.has(s.question_id)).map(s => ({ id: s.question_id, cluster: s.question_id, a: prior.get(s.question_id)!, b: s.correct }));
      const mc = exactMcNemar(pairs);
      const priorCorrect = pairs.filter(p => p.a === 1).length;
      paired = { against: pub.label, published_correct: pub.correct, prior_correct_recomputed: priorCorrect, pairs: pairs.length, wins: mc.wins, losses: mc.losses, p_two_sided: mc.p_two_sided,
        within_noise: Math.abs(correct - pub.correct) <= 10 && mc.p_two_sided >= 0.05 };
    }
    readers[model] = { questions: rows.length, correct, reader_errors: scored.filter(s => s.error).length, judge_errors: scored.filter(s => s.judge_error).length, usd: Number(usd.toFixed(4)), paired };
  }
  const out = {
    retrieval: { strict_recall_all_at_5: recallAll, answerable: answerable.length, published: { correct: 451, of: 470, commit: '109b992' }, within_noise: answerable.length === 470 && Math.abs(recallAll - 451) <= 2 },
    reader_requests: caps.size, reader_requests_with_trust_labels: labeled, readers,
  };
  const target = flag(argv, '--out');
  if (target) writeFileSync(target, JSON.stringify(out, null, 1) + '\n');
  console.log(JSON.stringify(out, null, 1));
  l.close();
}

if (import.meta.main) {
  const [cmd, ...argv] = process.argv.slice(2);
  const go = cmd === 'capture' ? capture(argv) : cmd === 'submit' ? submit(argv, 'reader') : cmd === 'judge' ? submit(argv, 'judge') : cmd === 'poll' ? poll(argv) : cmd === 'summary' ? Promise.resolve(summary(argv)) : Promise.reject(new Error('usage: utility-guard.ts capture|submit|judge|poll|summary'));
  go.catch(e => { console.error(e); process.exit(3); });
}
