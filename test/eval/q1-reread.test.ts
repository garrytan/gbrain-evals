/**
 * The particle-1 add-on's re-read (eval/runner/q1/reread-cell.ts), keyless: a packed source cell (the fake system,
 * scripted Opus and Sol readers and a scripted judge, on the invented LoCoMo-shaped fixture) re-read by particle-1
 * through the real lease proxy, in front of eval/systems/_shim/fake_provider.py or a scripted upstream.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCell, scheduledQuestions } from '../../eval/runner/q1/cell.ts';
import { estimateCell, type ArmDefinition, type CellDefinition } from '../../eval/runner/q1/cells/definitions.ts';
import { prepareReread, rereadArm, rereadCellId, runReread, REREAD_VERIFY_SCHEMA, type PreparedReread } from '../../eval/runner/q1/reread-cell.ts';
import { ScoreboardError } from '../../eval/runner/q1/scoreboard-errors.ts';
import { instrumentFor } from '../../eval/runner/memory-qa/instruments.ts';
import type { Corpus, MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';
import type { ChatLike, ChatResult } from '../../eval/runner/memory-qa/qa-v2.ts';
import { answerProblems, judgmentProblems, sha256 } from '../../eval/runner/memory-qa/records.ts';
import { FakeMemorySystem } from '../../eval/runner/systems/fake.ts';
import type { PublicQuestion, RetrievalPolicy } from '../../eval/runner/systems/types.ts';
import { BudgetRun, closeLedgers } from '../../eval/runner/budget-ledger.ts';
import { DEFAULT_ROUTE_CAPS, MeteringProxy } from '../../eval/runner/metering-proxy.ts';
import { DEFAULT_ROUTE_CLASSES } from '../../eval/runner/shootout-cell.ts';

const ROOT = resolve(import.meta.dir, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'q1-reread-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const raw = JSON.parse(readFileSync(join(ROOT, 'test/eval/fixtures/q1-cell/locomo-shaped.json'), 'utf8')) as { conversations: Corpus['conversations']; questions: MemoryQuestion[] };
const corpus: Corpus = { benchmark: 'fixture', conversations: raw.conversations, questions: raw.questions, source: { name: 'LoCoMo-shaped fixture (invented)', files: [{ path: 'test/eval/fixtures/q1-cell/locomo-shaped.json', sha256: 'fixture' }], revision: 'repo', license: 'MIT' } };
const byText = new Map(raw.questions.map(q => [q.question, q]));
const OPUS = 'anthropic:claude-opus-5-5', SOL = 'openai:gpt-6.1-sol', PARTICLE = 'particle:particle-1';
const NO_META = { finish: null, usage: null, response_model: null, attempt_errors: [] as string[] };
const ndjson = (path: string) => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const quiet = { probeIntervalMs: 5, probeTimeoutMs: 2000 };

/** Answers with the reference when the prompt carries it verbatim, else says the history does not say. */
const scriptedReader = (): ChatLike => ({
  async chat(_model, prompt): Promise<ChatResult> {
    const q = byText.get(/Question: (.*)\n/.exec(prompt)?.[1] ?? '');
    const text = q && !q.abstention && prompt.includes(q.answer!) ? `From the history: ${q.answer}.` : 'The history does not say.';
    return { text, input_tokens: Math.ceil(prompt.length / 4), output_tokens: 12, cached: false, ...NO_META };
  },
});

/** LongMemEval's verdict prompts: yes when the response contains the reference, or (abstention) declines. */
function scriptedJudge(): ChatLike & { judges: string[] } {
  const judges: string[] = [];
  return {
    judges,
    async chat(model, prompt): Promise<ChatResult> {
      judges.push(model);
      const response = /Model Response: ([\s\S]*?)\n\n/.exec(prompt)?.[1] ?? '';
      const reference = /Correct Answer: ([\s\S]*?)\n\n/.exec(prompt)?.[1];
      const yes = reference !== undefined ? response.toLowerCase().includes(reference.toLowerCase()) : /does not say/.test(response);
      return { text: yes ? 'yes' : 'no', input_tokens: 100, output_tokens: 1, cached: false, ...NO_META };
    },
  };
}

/** The fake system, with every retrieval of one question failing (a retrieval_error the source cell records). */
class FailsOneQuestion extends FakeMemorySystem {
  constructor(private failing: string) { super(); }
  async retrieve(ns: string, q: PublicQuestion, policy: RetrievalPolicy) {
    if (q.text === this.failing) throw new Error('store unavailable');
    return super.retrieve(ns, q, policy);
  }
}

function cellDef(arms: Array<Partial<ArmDefinition> & Pick<ArmDefinition, 'id' | 'mode'>>): CellDefinition {
  const id = 's3.ext-graph-pipeline.recipe';
  const base: Omit<CellDefinition, 'estimate'> = {
    schema: 'gbrain-evals/q1-cell/v1', id, set: 'S3', block: 'T2-S3', benchmark: 'locomo', split: 'dev', selection: { kind: 'shootout-slice', limit: 6, seed: 42 }, exclusions: [], system: 'ext-graph-pipeline',
    configuration: 'recipe', runner: 'shim', ingest_replicate: 1, effort: 'medium', canonical_instrument: 'locomo', probes: { sample: 2, seed: 'test' }, shards: 1, expected_hours: 1,
    arms: arms.map(a => ({ cell_id: `${id}.${a.id}`, set: 'S3', arm: a.mode === 'packed' ? 'component' : 'whole-system', policy: a.mode === 'packed' ? 'fixed-evidence' : a.mode === 'native-default' ? 'vendor-default' : null,
      budget: null, questions: null, readers: [OPUS, SOL], reader_replicates: {}, frontier: null, judge_repeats: null, label: a.id, ...a })),
  };
  return { ...base, estimate: estimateCell(base) };
}

const def = cellDef([{ id: 'component-b8000', mode: 'packed', budget: 8000 }]);
const arm = def.arms[0];
const source = join(tmp, 'source');
const staging = join(source, 'runs', def.id);
const scheduled = scheduledQuestions(def, corpus, null);

/** The real lease proxy (Q1's route caps and classes) in front of `upstream` (a fake_provider.py base URL) or a scripted fetch. */
function leaseProxy(n: string, via: { upstream: string } | { fetchImpl: typeof fetch }, leaseUsd = 1) {
  const usageLog = join(tmp, `usage-${n}.ndjson`);
  const lease = BudgetRun.openLease({ runId: `reread-${n}`, leaseUsd, ledgerPath: join(tmp, `ledger-${n}.sqlite`) });
  const proxy = new MeteringProxy({ ...('upstream' in via ? { upstream: { openai: via.upstream, anthropic: via.upstream, voyage: via.upstream, particle: `${via.upstream}/particle` } } : { fetchImpl: via.fetchImpl }),
    policy: { lease, usageLog, env: { OPENAI_API_KEY: 'dummy', ANTHROPIC_API_KEY: 'dummy', VOYAGE_API_KEY: 'dummy', PARTICLE_API_KEY: 'dummy-particle' }, routeCaps: { caps: { ...DEFAULT_ROUTE_CAPS }, slots: { ...DEFAULT_ROUTE_CLASSES }, defaultClass: 'extraction' } } });
  proxy.start();
  return { url: `http://127.0.0.1:${proxy.port}`, usageLog, lines: () => ndjson(usageLog), stop: () => proxy.stop() };
}

/** A copy of the source run with `edit` applied to its files, as a re-read's --source. */
function tampered(n: string, edit: (out: string) => void): string {
  const out = join(tmp, `tampered-${n}`);
  cpSync(source, out, { recursive: true });
  edit(out);
  return join(out, 'runs', def.id);
}

/** Rewrite the first frozen context of the arm with `f`. */
const editFirstContext = (f: (c: { key: string; prompt: string; prompt_sha256: string; meta: Record<string, unknown> }) => void) => (out: string) => {
  const path = join(out, 'runs', def.id, 'contexts.ndjson');
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  f(lines.find(c => c.key.endsWith(`|${arm.id}`)));
  writeFileSync(path, lines.map(l => JSON.stringify(l) + '\n').join(''));
};

const refusal = (fn: () => unknown) => {
  try { fn(); } catch (e) { if (e instanceof ScoreboardError) return e.op; throw e; }
  throw new Error('expected a refusal');
};

let fake: ReturnType<typeof Bun.spawn>;
let fakeBase = '';
const fakeLog = join(tmp, 'fake-provider.jsonl');
const particleChats = () => ndjson(fakeLog).filter(l => l.route === 'chat' && String(l.path).includes('/particle/v1/'));

let saved: NodeJS.ProcessEnv = {};
beforeEach(() => { saved = { ...process.env }; });
afterEach(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); closeLedgers(); });

beforeAll(async () => {
  const res = await runCell(def, { out: source, ...quiet }, { corpus, system: new FailsOneQuestion(scheduled[1].question), reader: scriptedReader(), judge: scriptedJudge() });
  expect(res.status).toBe('complete');
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const port = probe.port as number;
  probe.stop(true);
  fake = Bun.spawn(['python3', 'eval/systems/_shim/fake_provider.py', '--port', String(port), '--log', fakeLog], { cwd: ROOT, stdout: 'ignore', stderr: 'pipe' });
  fakeBase = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) { try { await fetch(`${fakeBase}/particle/v1/models`, { keepalive: false }); break; } catch { await Bun.sleep(50); } }
}, 60_000);
afterAll(() => fake?.kill());

describe('re-read: verification before any request', () => {
  // Value: protects=a re-read reads exactly the source cell's bytes and schedule; fails_when=a frozen context, the schedule or the stored answers are taken on trust; why_new=reread-cell.ts is new; seam=none; no_claim=a sealed source (custody is runCell's gate, reused)
  test('every frozen context of the arm hashes to its prompt and to the answers\' context_sha256; the plan keeps the failed retrieval without a context; verify.json carries counts and hashes, never a question', () => {
    const out = join(tmp, 'verify');
    const p = prepareReread(def, arm, { sources: [staging], reader: PARTICLE, out }, { corpus });
    expect(p.verify).toMatchObject({ schema: REREAD_VERIFY_SCHEMA, ok: true, arm_cell_id: arm.cell_id, problems: [] });
    expect(p.verify.counts).toEqual({ contexts_checked: 5, contexts_matched: 5, scheduled_questions: 6, questions_with_context: 5, questions_without_context: 1, stored_answers_cross_checked: 12, published_answers: 12, contexts_not_read: 0 });
    expect(p.plan.map(x => x.question.id)).toEqual(scheduled.map(q => q.id));
    expect(p.plan.filter(x => !x.context).map(x => x.outcome)).toEqual(['retrieval_error']);
    expect(p.verify.sources[0].contexts_sha256).toBe(sha256(readFileSync(join(staging, 'contexts.ndjson'))));
    const text = readFileSync(join(out, 'verify.json'), 'utf8');
    for (const q of corpus.questions) { expect(text).not.toContain(q.id); expect(text).not.toContain(q.question); }
  });

  // Value: protects=byte-for-byte reading; fails_when=a changed prompt, prompt hash or context hash is read (or partly read) instead of refusing the run; why_new=new; seam=none; no_claim=none
  test('a prompt changed by one byte, a forged prompt_sha256, a re-hashed substitute prompt or a missing context refuses the whole run before any request', async () => {
    const seen: string[] = [];
    const lp = leaseProxy('tampered', { fetchImpl: (async (url: string) => { seen.push(String(url)); return new Response('{}', { status: 500 }); }) as unknown as typeof fetch });
    try {
      const cases: Array<[string, (out: string) => void, string]> = [
        ['byte', editFirstContext(c => { c.prompt += ' '; }), 'do not hash to their prompt_sha256 and context_sha256'],
        ['sha', editFirstContext(c => { c.prompt_sha256 = sha256('another prompt'); }), 'do not hash to their prompt_sha256 and context_sha256'],
        ['substitute', editFirstContext(c => { c.prompt = c.prompt.replace('Question:', 'Question (edited):'); c.prompt_sha256 = sha256(c.prompt); }), 'do not hash to their prompt_sha256 and context_sha256'],
        ['missing', out => { const path = join(out, 'runs', def.id, 'contexts.ndjson'); writeFileSync(path, readFileSync(path, 'utf8').split('\n').filter(Boolean).slice(1).map(l => l + '\n').join('')); }, 'have no frozen context matching'],
        ['published', out => { const path = join(out, 'cells', arm.cell_id, 'answers.ndjson'); writeFileSync(path, readFileSync(path, 'utf8').split('\n').filter(Boolean).slice(1).map(l => l + '\n').join('')); }, 'are not its staged answers'],
      ];
      for (const [n, edit, why] of cases) {
        const out = join(tmp, `refused-${n}`);
        const op = refusal(() => prepareReread(def, arm, { sources: [tampered(n, edit)], reader: PARTICLE, out }, { corpus }));
        expect([n, op.code]).toEqual([n, 'PREFLIGHT_FAILED']);
        expect(op.message).toContain(why);
        const v = JSON.parse(readFileSync(join(out, 'verify.json'), 'utf8'));
        expect(v.ok).toBe(false);
        expect(existsSync(join(out, 'cells'))).toBe(false);
      }
      expect(seen).toEqual([]);
      expect(lp.lines()).toEqual([]);
    } finally { lp.stop(); }
  });

  // Value: protects=a re-read never reads another schedule; fails_when=a source run with a different selection or --limit is re-read as if it were the cell; why_new=new; seam=none; no_claim=none
  test('a source whose run-config froze another schedule is refused', () => {
    const src = tampered('schedule', out => {
      const path = join(out, 'cells', arm.cell_id, 'run-config.json');
      writeFileSync(path, readFileSync(path, 'utf8').replace(/"scheduled_sha256": "[0-9a-f]+"/, `"scheduled_sha256": "${sha256('another schedule')}"`));
    });
    const op = refusal(() => prepareReread(def, arm, { sources: [src], reader: PARTICLE, out: join(tmp, 'refused-schedule') }, { corpus }));
    expect(op.message).toContain('not the schedule its run-config.json froze');
  });

  // Value: protects=particle-1 never judges (plan GST-605, GST-767); fails_when=a re-read is judged by an OpenAI-compatible model; why_new=the re-read judges on its own path; seam=an instrument naming particle as its judge; no_claim=none
  test('particle-1 as the judge, a reader with no chat route and an arm that freezes no context are refused', () => {
    const asJudge = refusal(() => prepareReread(def, arm, { sources: [staging], reader: PARTICLE, out: join(tmp, 'refused-judge') }, { corpus, instrument: { ...instrumentFor('locomo'), canonical_judge: PARTICLE } }));
    expect(asJudge.message).toContain('never judges with an OpenAI-compatible model');
    expect(existsSync(join(tmp, 'refused-judge'))).toBe(false);
    expect(refusal(() => prepareReread(def, arm, { sources: [staging], reader: 'no-provider-model', out: join(tmp, 'refused-route') }, { corpus })).message).toContain('has no chat route');
    const retrievalOnly = cellDef([{ id: 'retrieval', mode: 'retrieval-only' }]);
    expect(refusal(() => rereadArm(retrievalOnly, 'retrieval')).message).toContain('has no packed arm retrieval');
    expect(rereadArm(def, 'component-b8000')).toBe(arm);
  });
});

describe('re-read: particle-1 through the lease proxy', () => {
  // Value: protects=the add-on measures particle-1 on exactly the contexts Opus and Sol read, metered and judged as Q1 is; fails_when=a prompt differs by a byte from the frozen one, a reading skips the proxy or its 16,000-token cap, an answer id meets the source cell's, the failed retrieval is sent or rescored, or a resume sends a reading again; why_new=new; seam=fake_provider.py as Particle; no_claim=Particle's own answers or billing
  test('each frozen prompt reaches fake Particle byte for byte, once per question with a context, at its cap; answers carry their own ids; the failed retrieval keeps its outcome; a resume sends nothing', async () => {
    const lp = leaseProxy('fake', { upstream: fakeBase });
    const out = join(tmp, 'reread');
    try {
      const p = prepareReread(def, arm, { sources: [staging], reader: PARTICLE, out }, { corpus });
      const before = particleChats().length;
      const judge = scriptedJudge();
      const res = await runReread(p, { providerProxy: lp.url, lease: { usd: 1, usageLog: lp.usageLog } }, { judge });
      expect(res.status).toBe('complete');
      expect(res.cell_id).toBe(`${arm.cell_id}.reread-particle-particle-1`);
      expect(rereadCellId(arm.cell_id, PARTICLE)).toBe(res.cell_id);
      const sent = particleChats().slice(before);
      const frozen = p.plan.filter(x => x.context).map(x => x.context!.prompt_sha256);
      expect(sent.map(l => l.user_sha256)).toEqual(frozen);
      expect(sent.every(l => l.model === 'particle-1' && l.max_completion_tokens === 16_000 && l.effort === 'medium' && l.auth_is_dummy)).toBe(true);
      expect(lp.lines().map(l => [l.provider, l.slot, l.route_class, l.output_cap, l.outcome])).toEqual(Array(5).fill(['particle', 'harness', 'reader', 16_000, 'forwarded']));

      const answers = ndjson(join(res.dir, 'answers.ndjson'));
      expect(answers.flatMap(a => answerProblems(a))).toEqual([]);
      expect(answers.map(a => [a.cell_id, a.reader, a.replicate, a.effort])).toEqual(Array(6).fill([res.cell_id, PARTICLE, 0, 'medium']));
      const sourceAnswers = ndjson(join(source, 'cells', arm.cell_id, 'answers.ndjson'));
      const sourceIds = new Set(sourceAnswers.map(a => a.answer_id));
      expect(answers.some(a => sourceIds.has(a.answer_id))).toBe(false);
      expect(new Set(answers.map(a => a.answer_id)).size).toBe(6);
      for (const a of answers) expect(a.context_sha256).toBe(sourceAnswers.find(s => s.question_id === a.question_id).context_sha256);
      expect(answers.map(a => a.outcome).sort()).toEqual(['retrieval_error', 'scored', 'scored', 'scored', 'scored', 'scored']);
      expect(answers.filter(a => a.outcome === 'scored').every(a => a.attempts.length === 1 && a.attempts[0].output_limit === 16_000 && a.attempts[0].response_model === 'particle-ai/particle-1')).toBe(true);

      const judgments = ndjson(join(res.dir, 'judgments.ndjson'));
      expect(judgments.flatMap(j => judgmentProblems(j))).toEqual([]);
      expect(judgments).toHaveLength(5);
      expect(new Set(judge.judges)).toEqual(new Set([instrumentFor('locomo').canonical_judge]));
      const rec = JSON.parse(readFileSync(join(res.dir, 'receipt.json'), 'utf8'));
      expect(rec).toMatchObject({ run_status: 'complete', readers: [PARTICLE], max_tokens: 16_000, effort: 'medium', source: { cell: def.id, arm: arm.id, arm_cell_id: arm.cell_id },
        counts: { answers: 6, answers_promised: 6, judgments: 5, unjudged: 0, outcomes: { scored: 5, retrieval_error: 1 } }, verify: p.verify.counts });
      expect(rec.spend.reader_usd).toBeGreaterThan(0);
      expect(rec.lease.requests).toBe(5);

      const again = await runReread(prepareReread(def, arm, { sources: [staging], reader: PARTICLE, out }, { corpus }), { providerProxy: lp.url }, { judge });
      expect(again.status).toBe('complete');
      expect(particleChats().length).toBe(before + 5);
      expect(ndjson(join(res.dir, 'answers.ndjson'))).toEqual(answers);
    } finally { lp.stop(); }
  });

  // Value: protects=a possibly-billed particle reading is never resent (#250, #287); fails_when=a reading that timed out at the proxy is retried in the pass loop or on resume; why_new=the re-read has its own pass loop; seam=a scripted upstream that times out; no_claim=Particle's billing of an aborted request
  test('a reading that times out upstream reaches Particle once, is a final reader_error, and a resume never sends it again', async () => {
    let calls = 0;
    const lp = leaseProxy('timeout', { fetchImpl: (async () => { calls++; throw new DOMException('The operation timed out.', 'TimeoutError'); }) as unknown as typeof fetch });
    const out = join(tmp, 'reread-timeout');
    try {
      const p: PreparedReread = prepareReread(def, arm, { sources: [staging], reader: PARTICLE, out }, { corpus });
      const res = await runReread(p, { providerProxy: lp.url }, { judge: scriptedJudge() });
      expect(calls).toBe(5);
      const answers = ndjson(join(res.dir, 'answers.ndjson'));
      expect(answers.map(a => a.outcome).sort()).toEqual(['reader_error', 'reader_error', 'reader_error', 'reader_error', 'reader_error', 'retrieval_error']);
      expect(answers.filter(a => a.outcome === 'reader_error').every(a => a.attempts.length === 1)).toBe(true);
      expect(res.status).toBe('complete');
      await runReread(prepareReread(def, arm, { sources: [staging], reader: PARTICLE, out }, { corpus }), { providerProxy: lp.url }, { judge: scriptedJudge() });
      expect(calls).toBe(5);
    } finally { lp.stop(); }
  });

  // Value: protects=a lease refusal stops the re-read without spending a try, and a resume finishes it; fails_when=a budget refusal is recorded as a final reader_error, the run keeps sending after it, or a resume skips the refused readings; why_new=the re-read's own pass loop; seam=a lease too small for one reservation; no_claim=none
  test('a lease too small for a reading stops the run partial before anything reaches Particle; a resume with room reads every question once', async () => {
    const out = join(tmp, 'reread-budget');
    const small = leaseProxy('budget-small', { upstream: fakeBase }, 0.0001);
    const before = particleChats().length;
    try {
      const res = await runReread(prepareReread(def, arm, { sources: [staging], reader: PARTICLE, out }, { corpus }), { providerProxy: small.url }, { judge: scriptedJudge() });
      expect([res.status, res.stopped?.startsWith('budget')]).toEqual(['partial', true]);
      expect(particleChats().length).toBe(before);
      expect(ndjson(join(res.dir, 'answers.ndjson')).filter(a => a.outcome === 'reader_error')).toEqual([]);
      expect(JSON.parse(readFileSync(join(res.dir, 'receipt.json'), 'utf8')).run_status).toBe('partial');
    } finally { small.stop(); }
    const room = leaseProxy('budget-room', { upstream: fakeBase });
    try {
      const res = await runReread(prepareReread(def, arm, { sources: [staging], reader: PARTICLE, out }, { corpus }), { providerProxy: room.url }, { judge: scriptedJudge() });
      expect(res.status).toBe('complete');
      expect(particleChats().length).toBe(before + 5);
      expect(ndjson(join(res.dir, 'answers.ndjson')).map(a => a.outcome).sort()).toEqual(['retrieval_error', 'scored', 'scored', 'scored', 'scored', 'scored']);
    } finally { room.stop(); }
  });
});
