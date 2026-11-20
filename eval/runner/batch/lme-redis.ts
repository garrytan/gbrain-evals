#!/usr/bin/env bun
/**
 * LongMemEval on Redis's open harness: reader and judge requests through the batch lane
 * (preregistration docs/benchmarks/2026-11-20-longmemeval-redis-harness-preregistration.md).
 *
 *   bun eval/runner/batch/lme-redis.ts build --frozen <freeze dir>               manifests and bodies ($0)
 *   bun eval/runner/batch/lme-redis.ts plan <arm>                                worst case per arm (counts tokens)
 *   bun eval/runner/batch/lme-redis.ts run <arm> --stage <id> [--ids pilot|first-half|second-half|all]
 *   bun eval/runner/batch/lme-redis.ts judge <arm> protocol|cross --stage <id> [--ids ...]
 *   bun eval/runner/batch/lme-redis.ts particle particle--<memories> --stage <id> [--ids ...]
 *   bun eval/runner/batch/lme-redis.ts poll --stage <id>
 *   bun eval/runner/batch/lme-redis.ts status
 *
 * An arm is `<reader>--<memories>`, for example `opus--off`. The bodies wrap the frozen messages the vendored Python
 * wrote (eval/runner/lme-redis/lme_redis.py freeze) in each provider's request shape and change no byte of them. A
 * reader answers each distinct prompt once: where a question's messages hash the same as in an earlier arm for that
 * reader (most often off and on when autocut keeps five conversations), the later arm holds no request and reuses the
 * earlier arm's answer and judgments (`reuse.json`). particle-1 has no batch endpoint: its requests go one at a time
 * through qa-v2's ChatClient, each reserved in the ledger by the paid-request guard, and its judges use the lane.
 *
 * Every paid command runs under a budget run per stage (judge check, pilots, counted first half, counted second half),
 * opened with --budget-usd when the stage first runs, with the paid-request guard installed. Dollar figures live in the
 * ledger and the tracking issue, never in this repository.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { BudgetRun, installPaidRequestGuard, ledgerStatus } from '../budget-ledger.ts';
import { attestPreregistration } from '../prereg.ts';
import { buildManifest, freezeManifest, readManifest, sha256, type ArmManifest, type Provider } from './manifest.ts';
import { ChatClient, chatWithReceipts } from '../memory-qa/qa-v2.ts';
import { BatchLane, type StoredResult } from './submit.ts';
import { anthropicTransport, openAiTransport } from './transport.ts';

const ROOT = resolve(import.meta.dir, '../../..');
export const PREREG = 'docs/benchmarks/2026-11-20-longmemeval-redis-harness-preregistration.md';
export const STATE_DIR = process.env.LME_REDIS_STATE_DIR ?? join(homedir(), '.capy/work/lme-redis');
export const MANIFEST_DIR = process.env.LME_REDIS_MANIFEST_DIR ? resolve(process.env.LME_REDIS_MANIFEST_DIR) : join(ROOT, 'docs/benchmarks/2026-11-20-longmemeval-redis-harness/manifests');
export const WORKSTREAM = 'lme-redis-harness';
export const MEMORIES = ['off', 'on', 'agent-default', 'full', 'oracle'] as const;
export type Memories = (typeof MEMORIES)[number];
export const STAGES = ['judge-check', 'pilot', 'counted-first-half', 'counted-second-half'] as const;
export const PILOT_SIZE = 25;
export const HALF = 250;

type Messages = [{ role: 'system'; content: string }, { role: 'user'; content: string }];
type JudgeMessages = [{ role: 'user'; content: string }];

interface Request { provider: Provider; model: string; max_output_tokens: number; effort: string | null; describe: string }

/** The readers that go through the batch lane, with the request settings the preregistration's reader table fixes. */
export const READERS: Record<'gpt4o' | 'opus' | 'sol', Request & { memories: readonly Memories[]; body: (m: Messages) => Record<string, unknown> }> = {
  gpt4o: {
    provider: 'openai', model: 'gpt-4o-2024-08-06', max_output_tokens: 2048, effort: null, memories: MEMORIES,
    describe: 'OpenAI chat completions, temperature 0, 2,048 output tokens',
    body: m => ({ model: 'gpt-4o-2024-08-06', messages: m, temperature: 0, max_tokens: 2048 }),
  },
  opus: {
    provider: 'anthropic', model: 'claude-opus-5-5', max_output_tokens: 8192, effort: null, memories: ['off', 'on', 'full', 'oracle'],
    describe: 'Anthropic messages, the harness system prompt and question, no temperature (adaptive thinking), default effort, 8,192 output tokens',
    body: m => ({ model: 'claude-opus-5-5', max_tokens: 8192, system: m[0].content, messages: [{ role: 'user', content: m[1].content }] }),
  },
  sol: {
    provider: 'openai', model: 'gpt-6.2-sol', max_output_tokens: 16000, effort: null, memories: ['off', 'on', 'full', 'oracle'],
    describe: 'OpenAI chat completions, default reasoning effort, 16,000 output tokens, no temperature and no n',
    body: m => ({ model: 'gpt-6.2-sol', messages: m, max_completion_tokens: 16000 }),
  },
};
export type Reader = keyof typeof READERS;

/** particle-1 has no batch endpoint: each request goes through qa-v2's ChatClient, under the paid-request guard that reserves it in the ledger. */
export const PARTICLE = {
  model: 'particle:particle-1', memories: ['off', 'on', 'full', 'oracle'] as readonly Memories[], effort: 'high', max_output_tokens: 32000, concurrency: 8, timeout_ms: 900_000,
  describe: 'Particle chat completions, reasoning_effort high, 32,000 output tokens (its default cap)',
};
export type AnyReader = Reader | 'particle';

/** The judges (preregistration, "Judges"): the protocol judge for every row, and the cross-family judge by reader family. */
export const JUDGES: Record<'protocol' | 'opus' | 'astra', Request & { body: (m: JudgeMessages) => Record<string, unknown> }> = {
  protocol: {
    provider: 'openai', model: 'gpt-4o-2024-08-06', max_output_tokens: 10, effort: null,
    describe: "Redis's judge request: temperature 0, seed 42, 10 output tokens",
    body: m => ({ model: 'gpt-4o-2024-08-06', messages: m, temperature: 0, seed: 42, max_tokens: 10 }),
  },
  opus: {
    provider: 'anthropic', model: 'claude-opus-5-5', max_output_tokens: 2000, effort: 'low',
    describe: 'claude-opus-5-5 at low effort, no temperature, 2,000 output tokens',
    body: m => ({ model: 'claude-opus-5-5', max_tokens: 2000, output_config: { effort: 'low' }, messages: m }),
  },
  astra: {
    provider: 'openai', model: 'gpt-6.2-astra', max_output_tokens: 2000, effort: 'low',
    describe: 'gpt-6.2-astra at low reasoning effort, 2,000 output tokens',
    body: m => ({ model: 'gpt-6.2-astra', messages: m, max_completion_tokens: 2000, reasoning_effort: 'low' }),
  },
};
/** R78: Claude Opus judges the GPT rows, GPT Astra the Claude and particle-1 rows. */
export const crossJudge = (reader: Reader | 'particle'): keyof typeof JUDGES => (reader === 'gpt4o' || reader === 'sol' ? 'opus' : 'astra');

export interface FrozenLine { question_id: string; question_type: string; arm: Memories; messages: Messages; messages_sha256: string; context_sha256: string }

export function readJsonl<T>(path: string): T[] {
  const text = path.endsWith('.gz') ? gunzipSync(readFileSync(path)).toString('utf8') : readFileSync(path, 'utf8');
  return text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as T);
}

/** The frozen messages of every arm, by question id, checked against their recorded hashes. */
export function loadFrozen(dir: string): { order: string[]; lines: Record<Memories, Map<string, FrozenLine>> } {
  const order = JSON.parse(readFileSync(join(dir, 'order.json'), 'utf8')) as string[];
  const lines = {} as Record<Memories, Map<string, FrozenLine>>;
  for (const arm of MEMORIES) {
    lines[arm] = new Map();
    for (const l of readJsonl<FrozenLine>(join(dir, 'messages', `${arm}.jsonl`))) {
      if (l.arm !== arm) throw new Error(`${arm}.jsonl holds a line for ${l.arm}`);
      if (lines[arm].has(l.question_id)) throw new Error(`${arm}: ${l.question_id} frozen twice`);
      if (l.messages.length !== 2 || l.messages[0].role !== 'system' || l.messages[1].role !== 'user') throw new Error(`${arm}/${l.question_id}: not the harness's two messages`);
      lines[arm].set(l.question_id, l);
    }
    const missing = order.filter(q => !lines[arm].has(q));
    if (missing.length) throw new Error(`${arm}: ${missing.length} questions in order.json have no frozen messages (first ${missing[0]})`);
  }
  return { order, lines };
}

/**
 * One reader's bodies per memories arm, one request per distinct prompt: a question whose messages hash the same as
 * in an earlier arm for this reader has no request in the later arm, and `reuse` names the arm that answers it.
 */
export function distinctPrompts(memories: readonly Memories[], frozen: ReturnType<typeof loadFrozen>) {
  const keep = new Map<Memories, FrozenLine[]>();
  const reuse: Record<string, Record<string, Memories>> = {};
  const seen = new Map<string, Map<string, Memories>>();
  for (const arm of memories) {
    const lines: FrozenLine[] = [];
    for (const q of frozen.order) {
      const line = frozen.lines[arm].get(q)!;
      const earlier = seen.get(q)?.get(line.messages_sha256);
      if (earlier) { (reuse[arm] ??= {})[q] = earlier; continue; }
      if (!seen.has(q)) seen.set(q, new Map());
      seen.get(q)!.set(line.messages_sha256, arm);
      lines.push(line);
    }
    keep.set(arm, lines);
  }
  return { keep, reuse };
}

export function readerBodies(reader: Reader, frozen: ReturnType<typeof loadFrozen>) {
  const r = READERS[reader];
  const { keep, reuse } = distinctPrompts(r.memories, frozen);
  const bodies = new Map([...keep].map(([arm, lines]) => [arm, new Map(lines.map(l => [l.question_id, r.body(l.messages)]))] as const));
  return { bodies, reuse };
}

export const armId = (reader: AnyReader, memories: Memories) => `${reader}--${memories}`;
export const judgeArmId = (arm: string, role: 'protocol' | 'cross') => `${arm}--${role}`;

export function parseArm(arm: string): { reader: AnyReader; memories: Memories } {
  const [reader, memories] = (arm ?? '').split('--') as [AnyReader, Memories];
  const allowed = reader === 'particle' ? PARTICLE.memories : READERS[reader as Reader]?.memories;
  if (!allowed?.includes(memories)) throw new Error(`unknown arm ${arm}`);
  return { reader, memories };
}

/** Question ids of a stage: the pilot is the last 25 in seed-42 order; the counted halves split all 500 at 250 (R113). */
export function stageIds(order: string[], which: string): string[] {
  if (which === 'pilot') return order.slice(-PILOT_SIZE);
  if (which === 'first-half') return order.slice(0, HALF);
  if (which === 'second-half') return order.slice(HALF);
  if (which === 'all') return [...order];
  throw new Error(`--ids must be pilot, first-half, second-half or all, got ${which}`);
}

const manifestPath = (id: string) => join(MANIFEST_DIR, `${id}.json`);
const bodiesPath = (id: string) => join(STATE_DIR, 'bodies', `${id}.ndjson.gz`);
function saveBodies(id: string, bodies: Map<string, Record<string, unknown>>) {
  mkdirSync(join(STATE_DIR, 'bodies'), { recursive: true });
  writeFileSync(bodiesPath(id), gzipSync([...bodies].map(([question_id, body]) => JSON.stringify({ question_id, body })).join('\n') + '\n'));
}
function loadBodies(id: string): Map<string, Record<string, unknown>> {
  if (!existsSync(bodiesPath(id))) throw new Error(`no saved bodies for ${id}`);
  return new Map(readJsonl<{ question_id: string; body: Record<string, unknown> }>(bodiesPath(id)).map(r => [r.question_id, r.body]));
}
const jsonFile = <T>(path: string, fallback: T): T => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : fallback);
const writeJson = (path: string, value: unknown) => { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 1) + '\n'); };

export function build(frozenDir: string): { arm: string; requests: number; reused: number }[] {
  const frozen = loadFrozen(frozenDir);
  const out: { arm: string; requests: number; reused: number }[] = [];
  const reuseAll: Record<string, Record<string, Record<string, Memories>>> = {};
  for (const reader of Object.keys(READERS) as Reader[]) {
    const r = READERS[reader];
    const { bodies, reuse } = readerBodies(reader, frozen);
    reuseAll[reader] = reuse;
    for (const [memories, b] of bodies) {
      const id = armId(reader, memories);
      const manifest = buildManifest({
        arm_id: id, workstream: WORKSTREAM, kind: 'reader', provider: r.provider, model: r.model, max_output_tokens: r.max_output_tokens,
        reasoning_effort: r.effort, protocol: { name: 'redis-agent-memory-benchmark build_prompt (vendored memory/llm.py)', sha256: sha256(readFileSync(join(ROOT, 'eval/redis-agent-memory-benchmark/src/agent_memory_benchmark/memory/llm.py'))) },
        source: `${r.describe}; the vendored harness's messages for the ${memories} arm, frozen in ${frozenDir.split('/').pop()}`, denominator: b.size, bodies: b, outputFloor: r.max_output_tokens,
      });
      freezeManifest(manifestPath(id), manifest);
      saveBodies(id, b);
      out.push({ arm: id, requests: b.size, reused: Object.keys(reuse[memories] ?? {}).length });
    }
  }
  const { keep, reuse } = distinctPrompts(PARTICLE.memories, frozen);
  reuseAll.particle = reuse;
  mkdirSync(join(STATE_DIR, 'particle'), { recursive: true });
  for (const [memories, lines] of keep) {
    writeFileSync(join(STATE_DIR, 'particle', `${memories}.texts.ndjson.gz`), gzipSync(lines.map(l => JSON.stringify({ question_id: l.question_id, system: l.messages[0].content, user: l.messages[1].content })).join('\n') + '\n'));
    out.push({ arm: armId('particle', memories), requests: lines.length, reused: Object.keys(reuse[memories] ?? {}).length });
  }
  writeJson(join(MANIFEST_DIR, 'reuse.json'), reuseAll);
  writeJson(join(STATE_DIR, 'order.json'), frozen.order);
  return out;
}

/** Judge bodies for an arm's answers, from the vendored judge prompt (lme_redis.py judge-messages). */
export function judgeBodies(role: 'protocol' | 'cross', reader: AnyReader, lines: { item_id: string; messages: JudgeMessages }[]) {
  const j = JUDGES[role === 'protocol' ? 'protocol' : crossJudge(reader)];
  return { judge: j, bodies: new Map(lines.map(l => [l.item_id, j.body(l.messages)])) };
}

/** Reader rows as the preregistration counts them: a truncated or refused answer is an answer and is judged. */
export function answerRows(manifest: ArmManifest, results: Map<string, StoredResult>) {
  return manifest.requests.map(({ question_id }) => {
    const r = results.get(question_id);
    if (!r) return { question_id, answer: null, status: 'not_run', finish: null, truncated: false };
    const answer = r.status === 'succeeded' ? (r.text ?? '') : null;
    return { question_id, answer, status: r.status, finish: r.finish, truncated: r.finish === 'max_tokens' || r.finish === 'length', usage: r.usage };
  });
}

export interface ParticleRow { question_id: string; answer: string | null; status: string; finish: string | null; truncated: boolean; usage: unknown; response_model: string | null; cached: boolean; error: string | null }

/**
 * One particle-1 arm, eight questions at a time: each question whose prompt this arm holds and that has no row yet
 * gets one request with the frozen system and user text. A row records the answer (a truncated one is kept), and a
 * budget stop ends the arm after the question in flight, with no new question started.
 */
export async function runParticle(memories: Memories, ids: string[], client: { chat: ChatClient['chat'] }, dir = join(STATE_DIR, 'particle')): Promise<{ ran: number; stopped: string | null }> {
  const texts = readJsonl<{ question_id: string; system: string; user: string }>(join(dir, `${memories}.texts.ndjson.gz`));
  const rowsPath = join(dir, `${memories}.rows.jsonl`);
  const done = new Set(existsSync(rowsPath) ? readJsonl<ParticleRow>(rowsPath).map(r => r.question_id) : []);
  const wanted = new Set(ids);
  const queue = texts.filter(t => wanted.has(t.question_id) && !done.has(t.question_id));
  let stopped: string | null = null;
  let ran = 0;
  const receipts: unknown[] = [];
  const worker = async () => {
    for (let t = queue.shift(); t && !stopped; t = queue.shift()) {
      let row: ParticleRow;
      try {
        const r = await chatWithReceipts(client, { role: 'reader', question_id: t.question_id, replicate: 0, model: PARTICLE.model, delivered: null } as never, t.user,
          { maxTokens: PARTICLE.max_output_tokens, replicate: 0, effort: PARTICLE.effort, system: t.system }, receipts as never);
        row = { question_id: t.question_id, answer: r.text ?? '', status: 'succeeded', finish: r.finish ?? null, truncated: r.finish === 'length' || r.finish === 'max_tokens', usage: r.usage ?? null, response_model: r.response_model ?? null, cached: r.cached, error: null };
      } catch (e) {
        const message = String((e as Error).message ?? e).slice(0, 500);
        if ((e as Error).name === 'BudgetExceededError' || /BudgetExceeded|402/.test(message)) stopped = message;
        row = { question_id: t.question_id, answer: null, status: 'errored', finish: null, truncated: false, usage: null, response_model: null, cached: false, error: message };
      }
      appendFileSync(rowsPath, JSON.stringify(row) + '\n');
      ran++;
    }
  };
  await Promise.all(Array.from({ length: PARTICLE.concurrency }, worker));
  appendFileSync(join(dir, `${memories}.receipts.jsonl`), receipts.map(r => JSON.stringify(r)).join('\n') + (receipts.length ? '\n' : ''));
  return { ran, stopped };
}

/** The strict cross-family parse: the reply's first word, lowercased and stripped of punctuation, must be yes or no. */
export function strictVerdict(raw: string | null): 0 | 1 | -1 {
  const first = (raw ?? '').trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
  return first === 'yes' ? 1 : first === 'no' ? 0 : -1;
}

/** Redis's scorer (benchmark/judge.py _score): "yes" anywhere is 1, else "no" anywhere is 0, else unparsable. */
export function redisVerdict(raw: string | null): 0 | 1 | -1 {
  const t = (raw ?? '').trim().toLowerCase();
  return t.includes('yes') ? 1 : t.includes('no') ? 0 : -1;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function stageRun(stage: string, ledgerPath: string, budgetUsd?: number): BudgetRun {
  if (!(STAGES as readonly string[]).includes(stage)) throw new Error(`--stage must be one of ${STAGES.join(', ')}`);
  const path = join(STATE_DIR, 'runs.json');
  const runs = jsonFile<Record<string, string>>(path, {});
  if (runs[stage]) return BudgetRun.join({ runId: runs[stage], ledgerPath });
  if (!budgetUsd) throw new Error(`stage ${stage} has no budget run yet: pass --budget-usd <dollars> the first time it runs`);
  const run = BudgetRun.open({ runner: `${WORKSTREAM}-${stage}`, budgetUsd, ledgerPath });
  runs[stage] = run.runId;
  writeJson(path, runs);
  return run;
}

const lane = (run: BudgetRun) => new BatchLane({ statePath: join(STATE_DIR, 'batch-state.sqlite'), transports: { openai: openAiTransport(), anthropic: anthropicTransport() }, run, parallel: true });

async function submit(l: BatchLane, run: BudgetRun, manifest: ArmManifest, bodies: Map<string, Record<string, unknown>>, ids: string[], listPrice: boolean) {
  const inManifest = new Set(manifest.requests.map(r => r.question_id));
  const done = new Set([...l.results(manifest.arm_id)].filter(([, r]) => r.status === 'succeeded').map(([q]) => q));
  const attempts = new Map<string, number>();
  for (const i of l.intents({ arm_id: manifest.arm_id })) for (const x of i.items) attempts.set(x.question_id, (attempts.get(x.question_id) ?? 0) + 1);
  const want = ids.filter(q => inManifest.has(q) && !done.has(q));
  const spent = want.find(q => (attempts.get(q) ?? 0) >= 2);
  if (spent) throw new Error(`${manifest.arm_id}: the one retry is used up for ${spent}; it stays unscored in this cell`);
  if (!want.length) { console.log(JSON.stringify({ arm: manifest.arm_id, note: 'nothing left to submit' })); return; }
  const known = l.factorFor(manifest.provider, manifest.model);
  const plan = await l.plan(manifest, bodies, { questionIds: want, pilot: !known.confirmed });
  const left = ledgerStatus({ ledgerPath: run.ledgerPath, runId: run.runId }).run?.remaining_usd ?? run.budgetUsd;
  if (plan.reserve_usd > left) throw new Error(`${manifest.arm_id}: the worst case does not fit the stage's cap; extend the cap before submitting`);
  const intent = await l.submit(manifest, bodies, { questionIds: want, pilot: !known.confirmed, ...(known.confirmed && !listPrice ? { requireFactor: 0.5 } : {}) });
  console.log(JSON.stringify({ arm: manifest.arm_id, intent: intent.intent_id, batch: intent.batch_id, requests: intent.items.length, factor: intent.factor, pilot: intent.pilot }));
}

async function main(argv: string[]) {
  const [cmd, arm, role] = argv;
  const ledgerPath = flag(argv, '--budget-ledger') ?? join(STATE_DIR, 'ledger.sqlite');
  if (cmd === 'build') {
    const frozen = flag(argv, '--frozen');
    if (!frozen) throw new Error('build needs --frozen <freeze dir>');
    for (const row of build(resolve(frozen))) console.log(JSON.stringify(row));
    return;
  }
  if (cmd === 'status') {
    console.log(JSON.stringify({ runs: jsonFile(join(STATE_DIR, 'runs.json'), {}) }, null, 1));
    return;
  }
  if (cmd === 'plan') {
    parseArm(arm);
    const l = lane({ runId: 'plan-only', ledgerPath } as unknown as BudgetRun);
    console.log(JSON.stringify({ arm, ...(await l.plan(readManifest(manifestPath(arm)), loadBodies(arm))) }));
    return;
  }
  const stage = flag(argv, '--stage');
  if (!stage) throw new Error(`${cmd} needs --stage <${STAGES.join('|')}>`);
  attestPreregistration(PREREG, ROOT);
  const run = stageRun(stage, ledgerPath, flag(argv, '--budget-usd') ? Number(flag(argv, '--budget-usd')) : undefined);
  const guard = installPaidRequestGuard(run);
  try {
    const l = lane(run);
    if (cmd === 'poll') { for (const o of await l.poll()) console.log(JSON.stringify(o)); return; }
    const order = jsonFile<string[]>(join(STATE_DIR, 'order.json'), []);
    const ids = stageIds(order, flag(argv, '--ids') ?? 'all');
    if (cmd === 'particle') {
      const { reader, memories } = parseArm(arm);
      if (reader !== 'particle') throw new Error('particle runs a particle--<memories> arm');
      const out = await runParticle(memories, ids, new ChatClient(join(STATE_DIR, 'particle', 'cache'), undefined, PARTICLE.timeout_ms));
      console.log(JSON.stringify({ arm, ...out }));
      if (out.stopped) process.exitCode = 3;
    } else if (cmd === 'run') {
      if (parseArm(arm).reader === 'particle') throw new Error('particle-1 has no batch endpoint; use the particle command');
      await submit(l, run, readManifest(manifestPath(arm)), loadBodies(arm), ids, argv.includes('--list-price'));
    } else if (cmd === 'judge') {
      const { reader } = parseArm(arm);
      if (role !== 'protocol' && role !== 'cross') throw new Error('judge role must be protocol or cross');
      const id = judgeArmId(arm, role);
      if (!existsSync(manifestPath(id))) {
        const answers = reader === 'particle'
          ? readJsonl<ParticleRow>(join(STATE_DIR, 'particle', `${parseArm(arm).memories}.rows.jsonl`)).filter(a => a.answer !== null)
          : answerRows(readManifest(manifestPath(arm)), l.results(arm)).filter(a => a.answer !== null);
        const answersPath = join(STATE_DIR, 'answers', `${arm}.jsonl`);
        mkdirSync(join(STATE_DIR, 'answers'), { recursive: true });
        writeFileSync(answersPath, answers.map(a => JSON.stringify({ item_id: a.question_id, question_id: a.question_id, answer: a.answer })).join('\n') + '\n');
        const messagesPath = join(STATE_DIR, 'judge-messages', `${arm}.jsonl`);
        const py = spawnSync('uv', ['run', '-q', '--project', join(ROOT, 'eval/redis-agent-memory-benchmark'), 'python', join(ROOT, 'eval/runner/lme-redis/lme_redis.py'), 'judge-messages',
          '--cache-dir', flag(argv, '--cache-dir') ?? join(homedir(), '.cache/memory-bench'), '--answers', answersPath, '--out', messagesPath], { stdio: 'inherit' });
        if (py.status !== 0) throw new Error('judge-messages failed');
        const { judge, bodies } = judgeBodies(role, reader, readJsonl<{ item_id: string; messages: JudgeMessages }>(messagesPath));
        const manifest = buildManifest({
          arm_id: id, workstream: WORKSTREAM, kind: 'judge', provider: judge.provider, model: judge.model, max_output_tokens: judge.max_output_tokens, reasoning_effort: judge.effort,
          protocol: { name: 'LongMemEval official judge prompts (vendored prompts/judge.py)', sha256: sha256(readFileSync(join(ROOT, 'eval/redis-agent-memory-benchmark/src/agent_memory_benchmark/prompts/judge.py'))) },
          source: `${judge.describe}, over ${arm}'s answers`, denominator: bodies.size, bodies, ...(judge.effort ? { outputFloor: judge.max_output_tokens } : {}),
        });
        freezeManifest(manifestPath(id), manifest);
        saveBodies(id, bodies);
      }
      await submit(l, run, readManifest(manifestPath(id)), loadBodies(id), ids, argv.includes('--list-price'));
    } else throw new Error(`unknown command ${cmd}`);
  } finally {
    guard.uninstall();
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(() => process.exit(0)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}
