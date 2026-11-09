/**
 * Pinned per-reader judges (definitions.ts PER_READER_JUDGE_SETTINGS) and the judge cache, for any manifest whose
 * per-reader arms carry a judge map: every pinned judge call is sent at the pinned effort and output cap, a truncated
 * reply is a judge_error, truncated and refused replies never reach the cache, and each judgment records its settings,
 * calls, cache hits and view. Judges without pinned settings send exactly what they sent before. Keyless: every
 * provider is a mocked fetch or a scripted client.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BudgetRun, closeLedgers } from '../../eval/runner/budget-ledger.ts';
import type { MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';
import { instrumentFor } from '../../eval/runner/memory-qa/instruments.ts';
import { ChatClient, judgeAnswer, type ChatLike, type ChatOptions, type ChatResultV2 } from '../../eval/runner/memory-qa/qa-v2.ts';
import { DEFAULT_ROUTE_CAPS, MeteringProxy } from '../../eval/runner/metering-proxy.ts';
import { campaignManifest, requiredJudges } from '../../eval/runner/q1/cell.ts';
import { definitionProblems, frontierJudgesFor, loadManifest, PER_READER_JUDGE_SETTINGS, pinnedJudgeRouteCaps, type ArmDefinition, type CellDefinition } from '../../eval/runner/q1/cells/definitions.ts';
import { loadF6Manifest } from '../../eval/runner/q1/cells/f6.ts';

const ROOT = resolve(import.meta.dir, '../..');
const realFetch = globalThis.fetch;
const dirs: string[] = [];
afterEach(() => { globalThis.fetch = realFetch; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'pinned-judge-')); dirs.push(d); return d; };

const BEAM = instrumentFor('beam-1m');
const Q = { id: 'q1', conversation: 'c', question: 'Q?', category: 'information_extraction', gold: [], abstention: false, answer: 'A', rubric: ['r1', 'r2'] } as unknown as MemoryQuestion;
const SETTINGS = { effort: 'medium', max_tokens: 8000 };
const ASTRA = 'openai:gpt-6-astra';
const OPUS = 'anthropic:claude-opus-5-5';
const PARTICLE = 'particle:particle-1';
const MAP = { [OPUS]: ASTRA, [PARTICLE]: OPUS, 'openai:gpt-6.1-sol': OPUS };
const pinned = (over: Partial<NonNullable<ArmDefinition['frontier']>> = {}): Pick<ArmDefinition, 'frontier'> =>
  ({ frontier: { judges: [ASTRA, OPUS], readers: null, sample: null, per_reader: true, judge_by_reader: { ...MAP }, settings: { ...SETTINGS }, ...over } });

/** A mocked OpenAI chat endpoint serving `replies` in order (the last repeats); returns the request bodies it saw. */
function serve(replies: Array<{ content: string; finish: string }>) {
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const r = replies[Math.min(bodies.length - 1, replies.length - 1)];
    return new Response(JSON.stringify({ model: 'gpt-6-astra-2026-10-01', choices: [{ message: { content: r.content }, finish_reason: r.finish }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return bodies;
}

/** A judge client that records each call's options and answers from a script of finishes and cache flags. */
function scripted(script: Array<{ finish?: string; cached?: boolean; text?: string }>): ChatLike & { opts: ChatOptions[] } {
  const opts: ChatOptions[] = [];
  return {
    opts,
    async chat(_model: string, _prompt: string, o: ChatOptions): Promise<ChatResultV2> {
      const s = script[Math.min(opts.length, script.length - 1)];
      opts.push(o);
      return { text: s.text ?? '{"score": 1.0, "reason": "ok"}', input_tokens: 1, output_tokens: 1, cached: s.cached ?? false, finish: s.finish ?? 'stop', usage: null, response_model: 'gpt-6-astra-2026-10-01', attempt_errors: [] } as ChatResultV2;
    },
  };
}

describe('the judge cache', () => {
  // Value: protects=a truncated or refused judge reply is asked again on resume instead of being replayed from the cache; fails_when=ChatClient writes a reply whose finish is listed in uncachedFinishes; why_new=uncachedFinishes is new; seam=globalThis.fetch; no_claim=Anthropic's request shape
  test('a reply whose finish is listed in uncachedFinishes is returned but never cached; the next call asks again', async () => {
    const bodies = serve([{ content: '{"score": 1', finish: 'length' }, { content: '{"score": 1.0}', finish: 'stop' }]);
    const root = tmp();
    const c = new ChatClient(root, () => 0);
    const o = { maxTokens: 8000, replicate: 0, effort: 'medium', uncachedFinishes: ['length', 'refusal'] };
    const first = await c.chat(ASTRA, 'p', o);
    expect([first.finish, first.cached]).toEqual(['length', false]);
    expect(readdirSync(root)).toEqual([]);
    const second = await c.chat(ASTRA, 'p', o);
    expect([second.finish, second.cached, bodies.length]).toEqual(['stop', false, 2]);
    expect(readdirSync(root)).toHaveLength(1);
    const third = await c.chat(ASTRA, 'p', o);
    expect([third.cached, bodies.length]).toEqual([true, 2]);
  });
});

describe('judgeAnswer with pinned settings', () => {
  // Value: protects=every pinned judge call goes out at the pinned effort and cap and its judgment records what was sent; fails_when=judgeAnswer sends the instrument's own cap, retries a truncation, or drops settings, calls, hits or view from the record; why_new=judgeAnswer's settings and view options are new; seam=a scripted ChatLike; no_claim=a provider honouring the effort
  test('every call is sent at the pinned effort and cap, failures stay out of the cache, and the record carries settings, calls and hits', async () => {
    const judge = scripted([{ cached: true }, { cached: false }]);
    const j = await judgeAnswer(judge, BEAM, Q, 'answer', { judge: ASTRA, judgeReplicate: 0, settings: SETTINGS });
    expect(judge.opts.map(o => [o.maxTokens, o.effort])).toEqual([[8000, 'medium'], [8000, 'medium']]);
    for (const o of judge.opts) expect(o.uncachedFinishes).toEqual(['length', 'max_tokens', 'refusal', 'content_filter']);
    expect([j.outcome, j.score, j.settings, j.calls, j.cache_hits]).toEqual(['scored', 1, SETTINGS, 2, 1]);
  });

  test('a truncated reply is a judge_error at once, never retried', async () => {
    for (const finish of ['length', 'max_tokens']) {
      const judge = scripted([{ finish, text: '{"score": 1.0' }]);
      const j = await judgeAnswer(judge, BEAM, Q, 'answer', { judge: ASTRA, judgeReplicate: 0, settings: SETTINGS, maxAttempts: 3 });
      expect([finish, j.outcome, j.score, j.calls, (j.detail as { truncated?: boolean }).truncated]).toEqual([finish, 'judge_error', null, 1, true]);
      expect(String((j.detail as { error: string }).error)).toContain('8000-token output cap');
    }
  });

  test('a judgment with a view records it and the model versions the provider returned', async () => {
    const gating = await judgeAnswer(scripted([{}]), BEAM, Q, 'answer', { judge: ASTRA, judgeReplicate: 0, settings: SETTINGS, view: 'gating' });
    expect([gating.view, gating.judge_versions, gating.judge]).toEqual(['gating', ['gpt-6-astra-2026-10-01'], ASTRA]);
    const bridge = await judgeAnswer(scripted([{}]), BEAM, Q, 'answer', { judge: 'openai:gpt-4.1-mini', judgeReplicate: 0, view: 'descriptive' });
    expect([bridge.view, bridge.judge_versions, 'settings' in bridge]).toEqual(['descriptive', ['gpt-6-astra-2026-10-01'], false]);
  });

  test('a judge without pinned settings sends what it sent before and records none of the new fields', async () => {
    const judge = scripted([{ finish: 'length' }]);
    const j = await judgeAnswer(judge, BEAM, Q, 'answer', { judge: 'openai:gpt-4.1-mini', judgeReplicate: 0 });
    expect(judge.opts).toEqual([{ maxTokens: 1024, replicate: 0, temperature: 0 }, { maxTokens: 1024, replicate: 0, temperature: 0 }]);
    expect(j.outcome).toBe('scored');
    expect(['settings', 'calls', 'cache_hits', 'view', 'judge_versions'].filter(k => k in j)).toEqual([]);
  });

  test('through the chat client, a truncated pinned reply is not cached, so a resume asks again', async () => {
    const bodies = serve([{ content: '{"score": 1.0', finish: 'length' }]);
    const root = tmp();
    const c = new ChatClient(root, () => 0);
    const j = await judgeAnswer(c, BEAM, Q, 'answer', { judge: ASTRA, judgeReplicate: 0, settings: SETTINGS });
    expect(j.outcome).toBe('judge_error');
    expect(readdirSync(root)).toEqual([]);
    expect(bodies[0]).toMatchObject({ model: 'gpt-6-astra', max_completion_tokens: 8000, reasoning_effort: 'medium' });
    await judgeAnswer(c, BEAM, Q, 'answer', { judge: ASTRA, judgeReplicate: 0, settings: SETTINGS });
    expect(bodies).toHaveLength(2);
  });
});

describe('an arm\'s own per-reader judge map', () => {
  // Value: protects=a per-reader arm with its own map judges each reader with the mapped judge at the pinned settings, and a manifest that maps badly is refused; fails_when=frontierJudgesFor ignores the map, requiredJudges drops settings or views, or definitionProblems passes a map without the pinned settings or one that lets a family judge itself; why_new=judge_by_reader and settings are new; seam=none; no_claim=any committed manifest's map
  test('frontierJudgesFor reads the map, and refuses a reader the map leaves out', () => {
    expect(frontierJudgesFor(pinned(), PARTICLE)).toEqual([OPUS]);
    expect(frontierJudgesFor(pinned(), OPUS)).toEqual([ASTRA]);
    expect(() => frontierJudgesFor(pinned(), 'openai:gpt-6-luna')).toThrow(/no per-reader judge is mapped for openai:gpt-6-luna/);
    expect(frontierJudgesFor({ frontier: { judges: ['openai:gpt-6.1-sol'], readers: null, sample: null, per_reader: true } }, PARTICLE)).toEqual(['openai:gpt-6.1-sol']);
  });

  test('requiredJudges names the canonical judge descriptive and the mapped judge gating at the pinned settings', () => {
    const inst = { id: BEAM.id, canonical_judge: BEAM.canonical_judge };
    expect(requiredJudges(pinned(), { reader: PARTICLE, replicate: 0 }, inst)).toEqual([
      { judge: BEAM.canonical_judge, instrument_id: BEAM.id, view: 'descriptive' },
      { judge: OPUS, instrument_id: `${BEAM.id}@${OPUS}`, view: 'gating', settings: SETTINGS },
    ]);
    expect(requiredJudges(pinned(), { reader: PARTICLE, replicate: 1 }, inst)).toEqual([{ judge: BEAM.canonical_judge, instrument_id: BEAM.id, view: 'descriptive' }]);
    expect(requiredJudges({ frontier: null }, { reader: PARTICLE, replicate: 0 }, inst)).toEqual([{ judge: BEAM.canonical_judge, instrument_id: BEAM.id }]);
  });

  test('definitionProblems needs a mapped arm pinned to PER_READER_JUDGE_SETTINGS and still refuses a family judging itself', () => {
    const kinds = new Set((JSON.parse(readFileSync(join(ROOT, 'eval/systems/kinds.json'), 'utf8')) as { kinds: Array<{ id: string }> }).kinds.map(k => k.id));
    const base = loadManifest().cells[0];
    const withArm = (frontier: ArmDefinition['frontier'], readers = [OPUS, PARTICLE]): CellDefinition => ({ ...base, arms: [{ ...base.arms[0], readers, frontier }, ...base.arms.slice(1)] });
    const mapped = (f: ArmDefinition['frontier']) => definitionProblems(withArm(f), kinds).filter(p => /frontier|GST-767/.test(p));
    expect(mapped(pinned().frontier)).toEqual([]);
    expect(SETTINGS).toEqual({ ...PER_READER_JUDGE_SETTINGS });
    expect(mapped(pinned({ settings: undefined }).frontier).join()).toContain('frontier.settings must pin the per-reader judges to {"effort":"medium","max_tokens":8000}, not null');
    expect(mapped(pinned({ settings: { effort: 'high', max_tokens: 8000 } }).frontier).join()).toContain('frontier.settings must pin');
    expect(mapped(pinned({ judge_by_reader: { ...MAP, [OPUS]: OPUS }, judges: [OPUS] }).frontier).join()).toContain('would judge anthropic:claude-opus-5-5, a reader of its own family (GST-767)');
  });
});

describe('the judge route admits the pinned cap', () => {
  async function admitted(outputCaps: Record<string, number>) {
    const seen: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => { seen.push(JSON.parse(String(init?.body))); return Response.json({ usage: { prompt_tokens: 10, completion_tokens: 5, input_tokens: 10, output_tokens: 5 } }); }) as unknown as typeof fetch;
    const lease = BudgetRun.openLease({ runId: 'judge-cap', leaseUsd: 5, ledgerPath: join(tmp(), 'lease.sqlite') });
    const proxy = new MeteringProxy({ fetchImpl, policy: { lease, env: { OPENAI_API_KEY: 'placeholder-openai', ANTHROPIC_API_KEY: 'placeholder-anthropic' }, usageLog: join(tmp(), 'usage.ndjson'),
      routeCaps: { caps: outputCaps, slots: { judge: 'judge' }, defaultClass: 'extraction' } } });
    proxy.start();
    const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${proxy.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try {
      const astra = await post('/judge/openai/v1/chat/completions', { model: 'gpt-6-astra', messages: [{ role: 'user', content: 'grade' }], max_completion_tokens: 8000, reasoning_effort: 'medium' });
      const opus = await post('/judge/anthropic/v1/messages', { model: 'claude-opus-5-5', max_tokens: 8000, output_config: { effort: 'medium' }, messages: [{ role: 'user', content: 'grade' }] });
      const bridge = await post('/judge/openai/v1/chat/completions', { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'grade' }], max_tokens: 8000 });
      return { astra: astra.status, opus: opus.status, bridge: bridge.status, forwarded: seen.length };
    } finally { proxy.stop(); closeLedgers(); }
  }

  // Value: protects=a pinned judge's 8,000-token call reaches its provider through the metering proxy while every other judge keeps the default cap; fails_when=pinnedJudgeRouteCaps omits a pinned judge or adds one without settings, or Q1 and F6 campaigns gain judge caps; why_new=pinnedJudgeRouteCaps is new; seam=the proxy's fetchImpl; no_claim=the provider's own limit
  test('each pinned judge gets a route cap at its pinned output cap, and only those judges', async () => {
    const caps = pinnedJudgeRouteCaps([pinned(), { frontier: null }, { frontier: { judges: ['openai:gpt-6.1-sol'], readers: null, sample: null, per_reader: true } }]);
    expect(caps).toEqual({ [`judge@${ASTRA}`]: 8000, [`judge@${OPUS}`]: 8000 });
    expect(await admitted({ ...DEFAULT_ROUTE_CAPS, ...caps })).toEqual({ astra: 200, opus: 200, bridge: 400, forwarded: 2 });
  });

  test('Q1 and F6 campaigns keep the default caps, under which a pinned judge call is refused before it is sent', async () => {
    expect(campaignManifest(loadManifest()).output_caps).toEqual({ ...DEFAULT_ROUTE_CAPS });
    expect(campaignManifest(loadF6Manifest()).output_caps).toEqual({ ...DEFAULT_ROUTE_CAPS });
    expect(await admitted({ ...DEFAULT_ROUTE_CAPS })).toEqual({ astra: 400, opus: 400, bridge: 400, forwarded: 0 });
  });
});
