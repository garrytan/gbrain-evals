import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAIMS, generatePinnedQuestionsWorld, type PqCompany, type PqWorld } from '../../eval/generators/pinned-questions-gen.ts';
import { claimSentence } from '../../eval/runner/pinned-questions.ts';
import { gbrainSpecFrom, overlaySummary, resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { createHash } from 'node:crypto';
import { BudgetExceededError } from '../../eval/runner/budget-ledger.ts';
import { PaidArmRefusal } from '../../eval/runner/paid-arm.ts';
import { writeReceipt } from '../../eval/runner/receipt.ts';
import {
  JUDGE_MIN_LABELS, PINNED_QUESTIONS_JUDGE_PROMPT, PINNED_QUESTIONS_MODELS_UNDER_TEST, STAGE_SEEDS, TRUNCATION_BAR, buildReceipt, canonicalModel, cohenKappa,
  familyOf, judgeAgreement, judgeCheckPasses, judgeFor, judgeUserMessage, modelRoles, parseJudgeLabels, requirePaidFlags, ruleLabels,
  checkpointKey, combinedCost, harnessBlocked, outcomeOf, pendingUnits, readCheckpoint, recordingGenerateText, redactProviderText, requireJudgeCheck, requireProviderKeys, runPinnedQuestionsPaid, scoredCorrect, summarizePaid,
  type ChatTransport, type GradedAnswer, type PaidRow, type PaidRunResult,
} from '../../eval/runner/pinned-questions-paid.ts';

const KEY_NAMES = /(_API_KEY|_API_TOKEN|_BEARER_TOKEN)$|^(TYPESAFE|JEV)_/;
const keylessEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !KEY_NAMES.test(k)));
const wordIn = (v: string, t: string) => t.split(/[^A-Za-z0-9]+/).join(' ').includes(v.split(/[^A-Za-z0-9]+/).join(' '));

describe('pinned-questions paid arm: refusal', () => {
  test('the CLI refuses without --paid before any gbrain or provider code runs', () => {
    const out = mkdtempSync(join(tmpdir(), 'pq-paid-refuse-'));
    try {
      const r = spawnSync('bun', ['eval/runner/pinned-questions-paid.ts', '--models', 'claude-opus-5-5', '--seeds', '1', '--companies', '8', '--output', out, '--budget-usd', '1'], { env: keylessEnv(), encoding: 'utf8' });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('--paid is missing');
      expect(existsSync(join(out, 'checkpoint.ndjson'))).toBe(false);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test('requirePaidFlags throws PaidArmRefusal without --paid, and checks a --budget-run-id against the ledger', () => {
    expect(() => requirePaidFlags(['--budget-usd', '5'], 1)).toThrow(PaidArmRefusal);
    const ledger = join(mkdtempSync(join(tmpdir(), 'pq-paid-ledger-')), 'ledger.sqlite');
    expect(() => requirePaidFlags(['--paid', '--budget-run-id', 'no-such-run', '--budget-ledger', ledger], 1)).toThrow(PaidArmRefusal);
  });

  test('--paid with only a dollar cap is refused: every paid launch needs an open ledger run, as in the other paid runners', () => {
    const ledger = join(mkdtempSync(join(tmpdir(), 'pq-paid-ledger-')), 'ledger.sqlite');
    expect(() => requirePaidFlags(['--paid', '--budget-usd', '5', '--budget-ledger', ledger], 1)).toThrow(PaidArmRefusal);
    const out = mkdtempSync(join(tmpdir(), 'pq-paid-refuse-'));
    try {
      const r = spawnSync('bun', ['eval/runner/pinned-questions-paid.ts', '--models', 'claude-opus-5-5', '--seeds', '1', '--companies', '8', '--output', out, '--paid', '--budget-usd', '1', '--budget-ledger', ledger], { env: keylessEnv(), encoding: 'utf8' });
      expect(r.status).toBe(2);
      expect(existsSync(join(out, 'checkpoint.ndjson'))).toBe(false);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('pinned-questions paid arm: the exported runner', () => {
  test('paid mode refuses before any request when no budget-ledger request guard is installed', async () => {
    const out = mkdtempSync(join(tmpdir(), 'pq-paid-noguard-'));
    const realFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => { fetches++; throw new Error('no network in this test'); }) as unknown as typeof fetch;
    try {
      const gut = resolveGbrainUnderTest(gbrainSpecFrom([]));
      await expect(runPinnedQuestionsPaid({ gut, models: ['particle:particle-1'], seeds: [1], companies: 8, output: out, mode: { kind: 'paid', keys: { PARTICLE_API_KEY: 'not-a-real-key-000' } } })).rejects.toThrow(PaidArmRefusal);
      expect(fetches).toBe(0);
      expect(existsSync(join(out, 'checkpoint.ndjson'))).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('pinned-questions paid arm: models and judges', () => {
  test('a paid launch is refused when a model under test or its judge has no provider key', () => {
    const all = { ANTHROPIC_API_KEY: 'a'.repeat(12), OPENAI_API_KEY: 'o'.repeat(12), PARTICLE_API_KEY: 'p'.repeat(12) };
    const models = [...PINNED_QUESTIONS_MODELS_UNDER_TEST];
    expect(() => requireProviderKeys(models, all)).not.toThrow();
    expect(() => requireProviderKeys(models, { ...all, PARTICLE_API_KEY: undefined })).toThrow(/particle:particle-1 \(PARTICLE_API_KEY\)/);
    expect(() => requireProviderKeys(['anthropic:claude-opus-5-5'], { ANTHROPIC_API_KEY: all.ANTHROPIC_API_KEY })).toThrow(/openai:gpt-6.2-astra \(OPENAI_API_KEY\)/);
    expect(() => requireProviderKeys(['openai:gpt-6.2-sol'], { OPENAI_API_KEY: all.OPENAI_API_KEY })).toThrow(PaidArmRefusal);
  });

  test('a question gbrain blocked for a setup reason is a harness error, not a scored wrong answer', () => {
    const call = (status: string, error: string | null) => ({ status, mode: null, error, failure_message: null, cost_usd: null, usage: { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 } });
    const graded = { sentences: [], judge_labels: null, judge_error: null, answer_correct: null, rule_labels: {}, rule_correct: null, judge_usage: call('x', null).usage, stale: [] } as unknown as PaidRow['refreshed'];
    for (const reason of ['no_model_key', 'awaiting_consent', 'no_worker', 'budget_exhausted']) {
      expect(harnessBlocked(call('blocked', reason))).toBe(true);
      expect(scoredCorrect({ pin: call('blocked', reason), refresh: { ...call('blocked', reason), freshness: 'stale', stale_sentences: 0 }, refreshed: graded })).toBeNull();
    }
    expect(harnessBlocked(call('failed', 'refresh_failed:model_output_not_json'))).toBe(false);
    expect(scoredCorrect({ pin: call('published', null), refresh: { ...call('failed', 'refresh_failed:model_output_not_json'), freshness: 'stale', stale_sentences: 0 }, refreshed: graded })).toBe(false);
  });

  test('bare ids get their provider prefix, and no judge grades its own family or is particle-1', () => {
    expect(['claude-opus-5-5', 'particle:particle-1', 'gpt-6.2-sol'].map(canonicalModel)).toEqual([...PINNED_QUESTIONS_MODELS_UNDER_TEST]);
    expect(judgeFor('anthropic:claude-opus-5-5')).toBe('openai:gpt-6.2-astra');
    expect(judgeFor('particle:particle-1')).toBe('openai:gpt-6.2-astra');
    expect(judgeFor('openai:gpt-6.2-sol')).toBe('anthropic:claude-opus-5-5');
    for (const m of PINNED_QUESTIONS_MODELS_UNDER_TEST) {
      expect(familyOf(judgeFor(m))).not.toBe(familyOf(m));
      expect(familyOf(judgeFor(m))).not.toBe('particle');
    }
    expect(modelRoles(PINNED_QUESTIONS_MODELS_UNDER_TEST).filter(r => r.role === 'judge')).toEqual([
      { model: 'openai:gpt-6.2-astra', role: 'judge', grades: ['anthropic:claude-opus-5-5', 'particle:particle-1'] },
      { model: 'anthropic:claude-opus-5-5', role: 'judge', grades: ['openai:gpt-6.2-sol'] },
    ]);
  });
});

describe('pinned-questions paid arm: rule labels and judge parsing', () => {
  const w = generatePinnedQuestionsWorld({ seed: 1, companies: 8 });
  const of = (m: string) => w.companies.find(c => c.mutation === m)!;
  const say = (c: PqCompany, v: Record<string, string | null>) => CLAIMS.filter(cl => v[cl] !== null).map(cl => claimSentence(c, cl, v[cl]!));

  test('current value only is correct, previous only is stale, neither is missing, both is ambiguous', () => {
    const c = of('edit_claim_page');
    expect(ruleLabels(c, 'refreshed', say(c, c.after))).toEqual({ city: 'correct', flagship: 'correct', ceo: 'correct', founded: 'correct' });
    expect(ruleLabels(c, 'refreshed', say(c, c.before)).city).toBe('stale');
    expect(ruleLabels(c, 'refreshed', say(c, { ...c.after, city: null })).city).toBe('missing');
    expect(ruleLabels(c, 'refreshed', [...say(c, c.after), `It used to build in ${c.before.city}.`]).city).toBe('ambiguous');
    expect(ruleLabels(c, 'first', say(c, c.before)).city).toBe('correct');
  });

  test('a removed CEO is correct when not named and stale when still named', () => {
    const c = of('remove_source_page');
    expect(c.after.ceo).toBeNull();
    expect(ruleLabels(c, 'refreshed', say(c, c.after)).ceo).toBe('correct');
    expect(ruleLabels(c, 'refreshed', say(c, c.before)).ceo).toBe('stale');
    expect(judgeUserMessage(c, 'refreshed', [])).toContain(`- ceo: current (none: removed); previous (no longer true) ${JSON.stringify(c.before.ceo)}`);
  });

  test('judge output parses from JSON with prose around it and refuses unknown labels', () => {
    expect(parseJudgeLabels('ok: {"city":"correct","flagship":"Stale","ceo":"missing","founded":"wrong"} done')).toEqual({ city: 'correct', flagship: 'stale', ceo: 'missing', founded: 'wrong' });
    expect(parseJudgeLabels('{"city":"right","flagship":"stale","ceo":"missing","founded":"wrong"}')).toBeNull();
    expect(parseJudgeLabels('no json')).toBeNull();
  });
});

describe('pinned-questions paid arm: kappa', () => {
  const g = (judge: boolean | null, rule: boolean | null): GradedAnswer => ({ sentences: [], judge_labels: null, judge_error: null, answer_correct: judge, rule_labels: { city: 'correct', flagship: 'correct', ceo: 'correct', founded: 'correct' }, rule_correct: rule, judge_usage: { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 } });

  test('hand-built table: 20 both, 5 judge only, 10 rule only, 15 neither gives kappa 0.4', () => {
    expect(cohenKappa({ both: 20, judge_only: 5, rule_only: 10, neither: 15 })).toBeCloseTo(0.4, 10);
    expect(cohenKappa({ both: 4, judge_only: 0, rule_only: 0, neither: 0 })).toBeNull();
    expect(cohenKappa({ both: 3, judge_only: 0, rule_only: 0, neither: 3 })).toBe(1);
  });

  test('judgeAgreement counts per judge, skips ambiguous rule labels and missing judge labels', () => {
    const cells: Array<[boolean, boolean, number]> = [[true, true, 20], [true, false, 5], [false, true, 10], [false, false, 15]];
    const answers = cells.flatMap(([j, r, n]) => Array.from({ length: n }, () => g(j, r)));
    answers.push(g(true, null), g(null, true));
    const rows: Array<Pick<PaidRow, 'judge_model' | 'first' | 'refreshed'>> = [];
    for (let i = 0; i < answers.length; i += 2) rows.push({ judge_model: 'openai:gpt-6.2-astra', first: answers[i]!, refreshed: { ...answers[i + 1]!, stale: [] } });
    rows.push({ judge_model: 'anthropic:claude-opus-5-5', first: g(true, true), refreshed: { ...g(false, false), stale: [] } });
    const a = judgeAgreement(rows);
    expect(a['openai:gpt-6.2-astra']).toMatchObject({ n: 50, both: 20, judge_only: 5, rule_only: 10, neither: 15, excluded_ambiguous: 1, excluded_no_judge: 1, agreement: 0.7 });
    expect(a['openai:gpt-6.2-astra']!.kappa).toBeCloseTo(0.4, 10);
    expect(a['anthropic:claude-opus-5-5']).toMatchObject({ n: 2, agreement: 1, kappa: 1 });
  });

  test('the judge check needs at least 100 labelled outputs per judge, not only a high kappa', () => {
    const rowsOf = (judge: string, answers: number) => Array.from({ length: answers / 2 }, (_, i): Pick<PaidRow, 'judge_model' | 'first' | 'refreshed'> => ({
      judge_model: judge, first: g(i % 2 === 0, i % 2 === 0), refreshed: { ...g(i % 3 === 0, i % 3 === 0), stale: [] },
    }));
    expect(JUDGE_MIN_LABELS).toBe(100);
    expect(judgeCheckPasses([...rowsOf('openai:gpt-6.2-astra', 100), ...rowsOf('anthropic:claude-opus-5-5', 100)])).toBe(true);
    expect(judgeCheckPasses([...rowsOf('openai:gpt-6.2-astra', 100), ...rowsOf('anthropic:claude-opus-5-5', 98)])).toBe(false);
    const ambiguous = rowsOf('openai:gpt-6.2-astra', 100).map((r, i) => (i === 0 ? { ...r, first: g(true, null) } : r));
    expect(judgeCheckPasses(ambiguous)).toBe(false);
  });

  test('an undefined kappa or a missing judge fails the judge check', () => {
    const unanimous = Array.from({ length: 50 }, (): Pick<PaidRow, 'judge_model' | 'first' | 'refreshed'> => ({ judge_model: 'openai:gpt-6.2-astra', first: g(true, true), refreshed: { ...g(true, true), stale: [] } }));
    expect(judgeAgreement(unanimous)['openai:gpt-6.2-astra']).toMatchObject({ n: 100, agreement: 1, kappa: null });
    expect(judgeCheckPasses(unanimous)).toBe(false);
    const good = Array.from({ length: 50 }, (_, i): Pick<PaidRow, 'judge_model' | 'first' | 'refreshed'> => ({ judge_model: 'openai:gpt-6.2-astra', first: g(i % 2 === 0, i % 2 === 0), refreshed: { ...g(i % 3 === 0, i % 3 === 0), stale: [] } }));
    expect(judgeCheckPasses(good)).toBe(true);
    expect(judgeCheckPasses(good, ['openai:gpt-6.2-astra', 'anthropic:claude-opus-5-5'])).toBe(false);
    expect(judgeCheckPasses([], [])).toBe(false);
  });

  test('a counted launch needs a matching judge-check receipt whose rows pass for every judge it needs', () => {
    const gut = resolveGbrainUnderTest(gbrainSpecFrom([]));
    const models = [...PINNED_QUESTIONS_MODELS_UNDER_TEST];
    const rowsOf = (judge: string) => Array.from({ length: 60 }, (_, i): Pick<PaidRow, 'judge_model' | 'first' | 'refreshed'> => ({ judge_model: judge, first: g(i % 2 === 0, i % 2 === 0), refreshed: { ...g(i % 3 === 0, i % 3 === 0), stale: [] } }));
    const receipt = { category: 'pinned-questions-paid', run_status: 'completed', gbrain_version: gut.version,
      resolved_config: { mode: 'paid', stage: 'judge-check', models: modelRoles(models), judge: { prompt_sha256: createHash('sha256').update(PINNED_QUESTIONS_JUDGE_PROMPT).digest('hex') }, gbrain_overlay: overlaySummary(gut) },
      data: { rows: [...rowsOf('openai:gpt-6.2-astra'), ...rowsOf('anthropic:claude-opus-5-5')] } };
    const d = mkdtempSync(join(tmpdir(), 'pq-judge-check-'));
    const at = (name: string, r: unknown) => { const p = join(d, name); writeFileSync(p, JSON.stringify(r)); return p; };
    try {
      expect(() => requireJudgeCheck(at('ok.json', receipt), { gut, models })).not.toThrow();
      expect(() => requireJudgeCheck(undefined, { gut, models })).toThrow(PaidArmRefusal);
      expect(() => requireJudgeCheck(join(d, 'missing.json'), { gut, models })).toThrow(/does not exist/);
      expect(() => requireJudgeCheck(at('pilot.json', { ...receipt, resolved_config: { ...receipt.resolved_config, stage: 'pilot' } }), { gut, models })).toThrow(/not a paid/);
      expect(() => requireJudgeCheck(at('error.json', { ...receipt, run_status: 'error' }), { gut, models })).toThrow(/run_status is error/);
      expect(() => requireJudgeCheck(at('build.json', { ...receipt, gbrain_version: '0.0.1' }), { gut, models })).toThrow(/not the build under test/);
      expect(() => requireJudgeCheck(at('prompt.json', { ...receipt, resolved_config: { ...receipt.resolved_config, judge: { prompt_sha256: 'x' } } }), { gut, models })).toThrow(/judge prompt differs/);
      expect(() => requireJudgeCheck(at('models.json', { ...receipt, resolved_config: { ...receipt.resolved_config, models: modelRoles(['claude-opus-5-5']) } }), { gut, models })).toThrow(/did not run particle:particle-1, openai:gpt-6.2-sol/);
      expect(() => requireJudgeCheck(at('one-judge.json', { ...receipt, data: { rows: rowsOf('openai:gpt-6.2-astra') } }), { gut, models })).toThrow(/judge check fails/);
      expect(() => requireJudgeCheck(at('one-judge.json', { ...receipt, data: { rows: rowsOf('openai:gpt-6.2-astra') } }), { gut, models: ['claude-opus-5-5', 'particle-1'] })).not.toThrow();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('the judge-check stage gives each judge at least 100 outputs from the rows it grades; the pilot alone does not', () => {
    const outputs = (judge: string, seeds: readonly number[]) => PINNED_QUESTIONS_MODELS_UNDER_TEST.filter(m => judgeFor(m) === judge).length * seeds.length * 24 * 2;
    expect(outputs('openai:gpt-6.2-astra', STAGE_SEEDS['judge-check'])).toBe(288);
    expect(outputs('anthropic:claude-opus-5-5', STAGE_SEEDS['judge-check'])).toBe(144);
    expect(outputs('anthropic:claude-opus-5-5', STAGE_SEEDS.pilot)).toBeLessThan(JUDGE_MIN_LABELS);
    expect(STAGE_SEEDS.pilot).toEqual([21]);
    expect(STAGE_SEEDS['judge-check'][0]).toBe(STAGE_SEEDS.pilot[0]);
    expect(STAGE_SEEDS.pilot.length * 10).toBe(STAGE_SEEDS.counted.length);
    expect(STAGE_SEEDS.counted).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  });
});

/**
 * A stub at gbrain's chat transport: answers each question from the ledger
 * (before the change while pinning; after it on refresh, except for the
 * companies in `stale`, which repeat the old values), and grades like the rule.
 */
type Failure = Error | { stopReason: string; text: string } | null;

function stubTransport(world: PqWorld, stale: Set<string>, calls: Array<{ model: string; kind: 'question' | 'judge'; graded?: string; chars: number; maxTokens?: number }>, truncate = new Set<string>(),
  fail: (slug: string, n: number, model: string) => Failure = () => null): ChatTransport {
  const byQuestion = new Map(world.companies.map(c => [c.question, c]));
  const seen = new Map<string, number>();
  return async (opts) => {
    const user = String(opts.messages[opts.messages.length - 1]?.content ?? '');
    const judge = opts.system === PINNED_QUESTIONS_JUDGE_PROMPT;
    const qline = user.split('\n').find(l => l.startsWith('Question: '))!.slice('Question: '.length);
    const c = byQuestion.get(qline)!;
    calls.push({ model: String(opts.model), kind: judge ? 'judge' : 'question', graded: c.slug, chars: (opts.system?.length ?? 0) + user.length, maxTokens: opts.maxTokens });
    let text: string;
    let stopReason = 'end';
    if (judge) {
      const judgeFailure = fail(c.slug, 0, String(opts.model));
      if (judgeFailure instanceof Error) throw judgeFailure;
      const answer = user.slice(user.indexOf('\nAnswer:\n') + '\nAnswer:\n'.length);
      const labels: Record<string, string> = {};
      for (const line of user.split('\n').filter(l => /^- (city|flagship|ceo|founded): current/.test(l))) {
        const claim = line.slice(2, line.indexOf(':'));
        const [now, was] = [...line.matchAll(/"([^"]*)"/g)].map(m => m[1]!);
        const removed = line.includes('(none: removed)');
        const cur = removed ? null : now!, prev = removed ? now : was;
        labels[claim] = cur === null ? (wordIn(prev!, answer) ? 'stale' : 'correct')
          : wordIn(cur, answer) ? 'correct' : prev && wordIn(prev, answer) ? 'stale' : 'missing';
      }
      text = JSON.stringify(labels);
    } else {
      const unit = `${opts.model}|${c.slug}`;
      const n = (seen.get(unit) ?? 0) + 1;
      seen.set(unit, n);
      const failure = fail(c.slug, n, String(opts.model));
      if (failure instanceof Error) throw failure;
      const values = n === 1 || stale.has(c.slug) ? c.before : c.after;
      if (n > 1 && truncate.has(c.slug) && (opts.maxTokens ?? 0) <= 2_000) stopReason = 'length';
      const cite = user.split('\n').filter(l => /^E\d+: /.test(l) && l.includes(c.name)).map(l => l.slice(0, l.indexOf(':'))).slice(0, 1);
      text = failure ? failure.text : JSON.stringify({ sentences: CLAIMS.filter(cl => values[cl] !== null).map(cl => ({ text: claimSentence(c, cl, values[cl]!), cite })), gaps: [] });
      if (failure) stopReason = failure.stopReason;
    }
    const chars = (opts.system?.length ?? 0) + user.length;
    return { text, blocks: [{ type: 'text', text }], stopReason, model: String(opts.model), providerId: 'stub',
      usage: { input_tokens: Math.ceil(chars / 4), output_tokens: Math.ceil(text.length / 4), cache_read_tokens: 0, cache_creation_tokens: 0 } };
  };
}

describe('pinned-questions paid arm: keyless run through gbrain\'s product path', () => {
  const gut = resolveGbrainUnderTest(gbrainSpecFrom([]));
  const world = generatePinnedQuestionsWorld({ seed: 1, companies: 8 });
  const stale = new Set(world.companies.filter((_, i) => i % 2 === 1).map(c => c.slug));
  const calls: Array<{ model: string; kind: 'question' | 'judge'; graded?: string; chars: number }> = [];
  const out = mkdtempSync(join(tmpdir(), 'pq-paid-run-'));
  const realFetch = globalThis.fetch;
  const savedKeys: Record<string, string | undefined> = {};
  let fetches = 0;
  let result: PaidRunResult;
  let second: PaidRunResult;
  let secondCalls = 0;

  beforeAll(async () => {
    for (const k of Object.keys(process.env).filter(k => KEY_NAMES.test(k))) { savedKeys[k] = process.env[k]; delete process.env[k]; }
    globalThis.fetch = (async () => { fetches++; throw new Error('no network in this test'); }) as unknown as typeof fetch;
    const transport = stubTransport(world, stale, calls);
    result = await runPinnedQuestionsPaid({ gut, models: ['claude-opus-5-5', 'particle:particle-1', 'gpt-6.2-sol'], seeds: [1], companies: 8, output: out, mode: { kind: 'keyless', transport } });
    const before = calls.length;
    second = await runPinnedQuestionsPaid({ gut, models: ['claude-opus-5-5', 'particle:particle-1', 'gpt-6.2-sol'], seeds: [1], companies: 8, output: out, mode: { kind: 'keyless', transport } });
    secondCalls = calls.length - before;
  }, 240_000);

  afterAll(() => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(savedKeys)) if (v !== undefined) process.env[k] = v;
    rmSync(out, { recursive: true, force: true });
  });

  test('no request leaves the process and no harness error occurs', () => {
    expect(fetches).toBe(0);
    expect(result.harnessErrors).toEqual([]);
    expect(result.rows).toHaveLength(24);
  });

  test('pins and refreshes go through the gateway with the model under test, and each publishes', () => {
    const questionCalls = calls.filter(c => c.kind === 'question');
    expect(questionCalls).toHaveLength(48);
    expect(new Set(questionCalls.map(c => familyOf(c.model)))).toEqual(new Set(['claude', 'particle', 'gpt']));
    for (const r of result.rows) {
      expect([r.pin.status, r.refresh.status]).toEqual(['published', 'published']);
      expect(['full', 'incremental']).toContain(r.refresh.mode!);
      expect(r.pin.usage.calls).toBe(1);
      expect(r.refresh.usage.calls).toBe(1);
      expect(r.pin.usage.input_tokens).toBeGreaterThan(0);
      expect(r.refreshed.stale).toHaveLength(r.refreshed.sentences.length);
    }
  });

  test('judges are routed by family: Astra for Claude and Particle rows, Opus for GPT rows', () => {
    const judgeCalls = calls.filter(c => c.kind === 'judge');
    expect(judgeCalls).toHaveLength(48);
    for (const r of result.rows) {
      expect(r.judge_model).toBe(judgeFor(r.model));
      expect(r.first.judge_usage.calls).toBe(1);
      expect(r.refreshed.judge_usage.calls).toBe(1);
    }
    const judgeModels = new Set(judgeCalls.map(c => c.model.split(':').pop()));
    expect(judgeModels).toEqual(new Set(['gpt-6.2-astra', 'claude-opus-5-5']));
    expect(judgeCalls.filter(c => familyOf(c.model) === 'gpt')).toHaveLength(32);
    expect(judgeCalls.filter(c => familyOf(c.model) === 'claude')).toHaveLength(16);
  });

  test('first answers are correct; refreshed answers are correct unless the stub repeated an affected old value', () => {
    for (const r of result.rows) {
      const c = world.companies.find(x => x.slug === r.company)!;
      expect([r.company, r.first.answer_correct, r.first.rule_correct]).toEqual([r.company, true, true]);
      const wrong = stale.has(r.company) && c.affected.length > 0;
      expect([r.company, r.refreshed.answer_correct, r.refreshed.rule_correct]).toEqual([r.company, !wrong, !wrong]);
      for (const claim of c.affected) expect([r.company, claim, r.refreshed.rule_labels[claim]]).toEqual([r.company, claim, stale.has(r.company) ? 'stale' : 'correct']);
    }
    expect(result.rows.some(r => r.refreshed.answer_correct === false)).toBe(true);
    const a = judgeAgreement(result.rows);
    expect(a['openai:gpt-6.2-astra']).toMatchObject({ n: 32, agreement: 1 });
    expect(a['anthropic:claude-opus-5-5']).toMatchObject({ n: 16, agreement: 1 });
  });

  test('a rerun resumes from the checkpoint and asks nothing again', () => {
    expect(secondCalls).toBe(0);
    expect(second.resumedUnits).toBe(3);
    expect(second.rows).toEqual(result.rows);
    expect(readFileSync(join(out, 'checkpoint.ndjson'), 'utf8').trim().split('\n')).toHaveLength(3);
  });

  test('the receipt validates, lists every model with its role and spends nothing', () => {
    const receipt = buildReceipt({ gut, models: ['claude-opus-5-5', 'particle:particle-1', 'gpt-6.2-sol'], seeds: [1], companies: 8, stage: 'dev', result, cost: null, startedAt: new Date().toISOString(), mode: 'keyless' }) as unknown as Record<string, any>;
    writeReceipt(join(out, 'receipt.json'), receipt as never);
    expect(receipt.cost.usd).toBe(0);
    expect(receipt.publishable).toBe(false);
    expect(receipt.verdict).toBe('fail');
    expect(receipt.data.summary.judge_agreement['openai:gpt-6.2-astra']).toMatchObject({ n: 32, agreement: 1 });
    expect(receipt.resolved_config).toMatchObject({ stage: 'dev', max_output_tokens: null });
    expect(receipt.data.summary.truncation).toEqual({ bar: TRUNCATION_BAR, models_over_bar: [] });
    expect(receipt.resolved_config.models.map((m: { model: string; role: string }) => `${m.role}:${m.model}`)).toEqual([
      'model under test:anthropic:claude-opus-5-5', 'model under test:particle:particle-1', 'model under test:openai:gpt-6.2-sol',
      'judge:openai:gpt-6.2-astra', 'judge:anthropic:claude-opus-5-5',
    ]);
    expect(receipt.n_scored).toBe(24);
  });
});

describe('pinned-questions paid arm: refresh output cap', () => {
  const gut = resolveGbrainUnderTest(gbrainSpecFrom([]));
  const world = generatePinnedQuestionsWorld({ seed: 1, companies: 8 });
  const truncate = new Set(world.companies.filter(c => c.mutation.startsWith('unrelated')).slice(0, 2).map(c => c.slug));
  const outs = [mkdtempSync(join(tmpdir(), 'pq-paid-cap-')), mkdtempSync(join(tmpdir(), 'pq-paid-raised-'))];
  const realFetch = globalThis.fetch;
  const savedKeys: Record<string, string | undefined> = {};
  const calls: Array<Array<{ model: string; kind: 'question' | 'judge'; graded?: string; chars: number; maxTokens?: number }>> = [[], []];
  let fetches = 0;
  let atDefault: PaidRunResult;
  let raised: PaidRunResult;

  beforeAll(async () => {
    for (const k of Object.keys(process.env).filter(k => KEY_NAMES.test(k))) { savedKeys[k] = process.env[k]; delete process.env[k]; }
    globalThis.fetch = (async () => { fetches++; throw new Error('no network in this test'); }) as unknown as typeof fetch;
    const run = (i: number, maxOutputTokens?: number) => runPinnedQuestionsPaid({ gut, models: ['particle:particle-1'], seeds: [1], companies: 8, maxOutputTokens, output: outs[i]!, mode: { kind: 'keyless', transport: stubTransport(world, new Set(), calls[i]!, truncate) } });
    atDefault = await run(0);
    raised = await run(1, 4_000);
  }, 240_000);

  afterAll(() => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(savedKeys)) if (v !== undefined) process.env[k] = v;
    for (const o of outs) rmSync(o, { recursive: true, force: true });
  });

  test('a refresh cut off at the default cap is counted as answer_too_long and puts the model over the bar', () => {
    expect(fetches).toBe(0);
    expect(atDefault.harnessErrors).toEqual([]);
    expect(calls[0]!.filter(c => c.kind === 'question').every(c => c.maxTokens === 2_000)).toBe(true);
    const tooLong = atDefault.rows.filter(r => r.refresh.error?.includes('answer_too_long')).map(r => r.company).sort();
    expect(tooLong).toEqual([...truncate].sort());
    for (const r of atDefault.rows.filter(x => truncate.has(x.company))) {
      expect([r.company, r.refresh.status, r.outcome]).toEqual([r.company, 'failed', 'answer_too_long']);
      expect([r.company, r.refreshed.answer_correct, r.correct]).toEqual([r.company, true, false]);
    }
    const s = summarizePaid(atDefault.rows);
    expect(s.by_model['particle:particle-1']!.answer_too_long).toEqual({ pin: 0, refresh: 2, share: 2 / 16, over_bar: true });
    expect(s.by_model['particle:particle-1']!.refreshed_correct).toBe(6 / 8);
    expect(s.by_model['particle:particle-1']!.refresh_outcome).toEqual({ published: 6, answer_too_long: 2 });
    expect(s.truncation).toEqual({ bar: TRUNCATION_BAR, models_over_bar: ['particle:particle-1'] });
  });

  test('the raised-cap arm sends the raised cap, records it, and the same replies fit', () => {
    expect(raised.harnessErrors).toEqual([]);
    expect(calls[1]!.filter(c => c.kind === 'question').every(c => c.maxTokens === 4_000)).toBe(true);
    const s = summarizePaid(raised.rows);
    expect(s.by_model['particle:particle-1']!.answer_too_long).toEqual({ pin: 0, refresh: 0, share: 0, over_bar: false });
    expect(raised.rows.every(r => r.refresh.status === 'published')).toBe(true);
    const receipt = buildReceipt({ gut, models: ['particle:particle-1'], seeds: [1], companies: 8, stage: 'dev', maxOutputTokens: 4_000, result: raised, cost: null, startedAt: new Date().toISOString(), mode: 'keyless' }) as unknown as Record<string, any>;
    expect(receipt.resolved_config.max_output_tokens).toBe(4_000);
    expect(receipt.resolved_config.model_config).toContain('cycle.standing_questions.max_output_tokens raised to 4000');
  });
});

describe('pinned-questions paid arm: provider errors, safety stops and budget refusals', () => {
  const gut = resolveGbrainUnderTest(gbrainSpecFrom([]));
  const world = generatePinnedQuestionsWorld({ seed: 1, companies: 8 });
  const [a, b] = [world.companies[0]!.slug, world.companies[1]!.slug];
  const realFetch = globalThis.fetch;
  const savedKeys: Record<string, string | undefined> = {};
  const dirs: string[] = [];
  let fetches = 0;
  const run = (out: string, fail: (slug: string, n: number, model: string) => Failure, models = ['particle:particle-1'], calls: Array<{ model: string; kind: 'question' | 'judge'; chars: number }> = []) =>
    runPinnedQuestionsPaid({ gut, models, seeds: [1], companies: 8, output: out, mode: { kind: 'keyless', transport: stubTransport(world, new Set(), calls, new Set(), fail) } });
  const dir = () => { const d = mkdtempSync(join(tmpdir(), 'pq-paid-err-')); dirs.push(d); return d; };

  beforeAll(() => {
    for (const k of Object.keys(process.env).filter(k => KEY_NAMES.test(k))) { savedKeys[k] = process.env[k]; delete process.env[k]; }
    globalThis.fetch = (async () => { fetches++; throw new Error('no network in this test'); }) as unknown as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(savedKeys)) if (v !== undefined) process.env[k] = v;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test('a provider error leaves the question out, and a resumed run asks the unit once more', async () => {
    const out = dir();
    const first = await run(out, (slug, n) => (slug === a && n === 2 ? new Error('503 Service Unavailable: upstream provider_error') : null));
    const row = first.rows.find(r => r.company === a)!;
    expect([row.outcome, row.correct]).toEqual(['provider_error', null]);
    expect(first.acc.summary().errors).toEqual([{ probe_id: `particle:particle-1|s1|${a}`, origin: 'dependency', message: '503 Service Unavailable: upstream provider_error' }]);
    expect(summarizePaid(first.rows).by_model['particle:particle-1']).toMatchObject({ refreshed_excluded: 1, refreshed_correct: 1 });
    expect(first.harnessErrors).toEqual([expect.stringContaining('the run is incomplete until a rerun')]);
    const pending = buildReceipt({ gut, models: ['particle:particle-1'], seeds: [1], companies: 8, stage: 'dev', result: first, cost: null, startedAt: new Date().toISOString(), mode: 'paid' }) as unknown as { run_status: string; publishable: boolean };
    expect([pending.run_status, pending.publishable]).toEqual(['error', false]);
    const calls: Array<{ model: string; kind: 'question' | 'judge'; chars: number }> = [];
    const second = await run(out, () => null, undefined, calls);
    expect(second.resumedUnits).toBe(0);
    expect(calls.length).toBeGreaterThan(0);
    expect(second.rows.find(r => r.company === a)).toMatchObject({ outcome: 'published', correct: true });
    expect(second.harnessErrors).toEqual([]);
    const third: Array<{ model: string; kind: 'question' | 'judge'; chars: number }> = [];
    expect((await run(out, () => null, undefined, third)).resumedUnits).toBe(1);
    expect(third).toHaveLength(0);
  }, 120_000);

  test('a unit that fails again on its second attempt is kept, with the question left out', async () => {
    const out = dir();
    const failA = (slug: string, n: number) => (slug === a && n === 2 ? new Error('fetch failed: network socket hang up') : null);
    await run(out, failA);
    const second = await run(out, failA);
    expect(second.rows.find(r => r.company === a)).toMatchObject({ outcome: 'provider_error', correct: null });
    expect(second.harnessErrors).toEqual([]);
    const calls: Array<{ model: string; kind: 'question' | 'judge'; chars: number }> = [];
    expect((await run(out, () => null, undefined, calls)).resumedUnits).toBe(1);
    expect(calls).toHaveLength(0);
  }, 120_000);

  test('a safety stop is its own outcome, counts as not correct and is not retried', async () => {
    const out = dir();
    const r = await run(out, (slug, n) => (slug === b && n === 2 ? new Error('Output blocked by content filtering policy (safety)') : null));
    const row = r.rows.find(x => x.company === b)!;
    expect([row.outcome, row.correct, row.refresh.failure_message]).toEqual(['safety_stop', false, expect.stringContaining('content filtering')]);
    const calls: Array<{ model: string; kind: 'question' | 'judge'; chars: number }> = [];
    expect((await run(out, () => null, undefined, calls)).resumedUnits).toBe(1);
    expect(calls).toHaveLength(0);
  }, 120_000);

  test('provider failure text and judge errors are kept with every key and credential redacted', async () => {
    const out = dir();
    const tokens = [['sk', 'ant', 'api03', 'Zq9Xw2Lm8Pv4Rt6Yn1Bc3Df5Gh7'].join('-'), ['sk', 'proj', 'Qw3Er5Ty7Ui9Op1As2Df4Gh6Jk8'].join('-'), ['Hj2Kl4Zx6Cv8Bn0', 'Mq1Wr3Et5'].join('')];
    const r = await run(out, (slug, n) => (slug === a && n === 2 ? new Error(`401 invalid x-api-key ${tokens[0]} (Authorization: Bearer ${tokens[2]}) provider_error`)
      : slug === b && n === 0 ? new Error(`judge 400: key ${tokens[1]} rejected`) : null));
    const rowA = r.rows.find(x => x.company === a)!, rowB = r.rows.find(x => x.company === b)!;
    expect(rowA.refresh.failure_message).toContain('[redacted]');
    expect(rowB.first.judge_error).toStartWith('judge_call_failed: ');
    expect(rowB.first.judge_error).toContain('[redacted]');
    const kept = [JSON.stringify(r.rows), JSON.stringify(r.acc.summary()), r.harnessErrors.join('\n'), readFileSync(join(out, 'checkpoint.ndjson'), 'utf8')].join('\n');
    for (const t of tokens) expect(kept).not.toContain(t);
  }, 120_000);

  test('redactProviderText removes key values set under key names, key-shaped tokens, credentials and URL passwords, before any cut', () => {
    const value = ['pv', 'Lk8Jh6Gf4Ds2Aq9Wz7'].join('');
    const text = `refused for ${value}; sk-${'ant-'}${'Rt5Yu7Io9Pa1Sd3Fg5Hj7Kl'} Basic ${'dXNlcjpwYXNzd29yZA'} api_key=${'Zx9Cv7Bn5Mm3Qq1Ww'} postgres://u:${'hunter2secret'}@db/x`;
    const red = redactProviderText(text, { PARTICLE_API_KEY: value, HOME: '/home/someone-long' });
    for (const s of [value, 'Rt5Yu7Io9Pa1Sd3Fg5Hj7Kl', 'dXNlcjpwYXNzd29yZA', 'Zx9Cv7Bn5Mm3Qq1Ww', 'hunter2secret']) expect(red).not.toContain(s);
    expect(red).toStartWith('refused for [redacted];');
    expect(redactProviderText('no secrets here: 503 upstream', {})).toBe('no secrets here: 503 upstream');
  });

  test('a structured refusal or content-filter finish is a safety stop even when gbrain reports only invalid output', async () => {
    const out = dir();
    const r = await run(out, (slug, n) => (slug === b && n >= 2 ? { stopReason: 'content_filter', text: 'I can not help with that request.' } : null));
    const row = r.rows.find(x => x.company === b)!;
    expect([row.outcome, row.correct, row.refresh.safety_finish]).toEqual(['safety_stop', false, 'content_filter']);
    expect(r.rows.filter(x => x.company !== b).every(x => x.refresh.safety_finish === null)).toBe(true);
  }, 120_000);

  test('the paid arm reads the safety finish from each AI SDK result and passes the result through unchanged', async () => {
    const seen: Array<string | null> = [];
    const results = [{ finishReason: 'content-filter' }, { finishReason: 'other', rawFinishReason: 'refusal' }, { finishReason: 'content-filter', providerMetadata: { anthropic: { stopReason: 'refusal' } } }, { finishReason: 'stop', text: 'ok' }];
    for (const res of results) expect(await recordingGenerateText(async () => res, f => seen.push(f))({})).toBe(res);
    expect(seen).toEqual(['content_filter', 'refusal', 'refusal', null]);
  });

  test('a torn final checkpoint line is cut off and the run resumes every intact unit; a corrupt earlier line refuses', async () => {
    const out = dir();
    const models = ['particle:particle-1', 'gpt-6.2-sol'];
    await run(out, () => null, models);
    const ck = join(out, 'checkpoint.ndjson');
    const intact = readFileSync(ck, 'utf8');
    appendFileSync(ck, intact.split('\n')[0]!.slice(0, 200));
    const calls: Array<{ model: string; kind: 'question' | 'judge'; chars: number }> = [];
    const resumed = await run(out, () => null, models, calls);
    expect([resumed.resumedUnits, calls.length]).toEqual([2, 0]);
    expect(readFileSync(ck, 'utf8')).toBe(intact);
    expect(readCheckpoint(ck)).toHaveLength(2);
    writeFileSync(ck, `{"torn\n${intact}`);
    expect(() => readCheckpoint(ck)).toThrow(/line 1 is not valid JSON/);
  }, 120_000);

  test('a resume estimates only the units still to ask, and its receipt sums the spend of every process behind its rows', async () => {
    const out = dir();
    const models = ['particle:particle-1', 'gpt-6.2-sol'].map(canonicalModel);
    const key = checkpointKey({ mode: 'keyless', gut, companies: 8 });
    expect(pendingUnits(out, key, models, [1, 2])).toHaveLength(4);
    await run(out, (slug, n, model) => (model.includes('gpt-6.2-sol') && slug === a && n === 2 ? new Error('503 Service Unavailable: upstream provider_error') : null), models);
    expect(pendingUnits(out, key, models, [1, 2])).toEqual([{ model: 'particle:particle-1', seed: 2 }, { model: 'openai:gpt-6.2-sol', seed: 1 }, { model: 'openai:gpt-6.2-sol', seed: 2 }]);
    expect(pendingUnits(out, checkpointKey({ mode: 'keyless', gut, companies: 8, maxOutputTokens: 8000 }), models, [1])).toHaveLength(2);
    const summary = (run_id: string, usd: number, requests: number) => ({ run_id, budget_usd: 50, reserved_usd: usd, actual_usd: usd, charged_reservations: 0, requests, input_tokens: requests * 10, output_tokens: requests * 5, overshoot_usd: 0, ledger_path: 'l', program_cap_usd: 500, event_loop_lag_ms: null });
    combinedCost(out, 'other-key', summary('r0', 9, 9));
    combinedCost(out, key, summary('r1', 1.5, 3));
    const both = combinedCost(out, key, summary('r1', 0, 0));
    expect([both.processes, both.actual_usd, both.requests, both.input_tokens, both.run_id]).toEqual([2, 1.5, 3, 30, 'r1']);
  }, 120_000);

  test('a refused connection is a provider error, not a safety stop', async () => {
    const out = dir();
    const r = await run(out, (slug, n) => (slug === b && n === 2 ? new Error('connect ECONNREFUSED 127.0.0.1:443') : null));
    expect(r.rows.find(x => x.company === b)).toMatchObject({ outcome: 'provider_error', correct: null });
    expect(outcomeOf({ status: 'failed', error: 'refresh_failed:provider_error', failure_message: 'upstream connection refused' })).toBe('provider_error');
    expect(outcomeOf({ status: 'failed', error: 'refresh_failed:provider_error', failure_message: 'the model refused to answer under its usage policy' })).toBe('safety_stop');
  }, 120_000);

  test('a budget refusal pauses the run at the unit boundary and checkpoints nothing for that unit', async () => {
    const out = dir();
    const models = ['particle:particle-1', 'gpt-6.2-sol'];
    const r = await run(out, (slug, n, model) => (model.includes('gpt-6.2-sol') && slug === b && n === 2 ? new BudgetExceededError('run cap reached') : null), models);
    expect(r.rows.map(x => x.model)).toEqual(Array(8).fill('particle:particle-1'));
    expect(r.harnessErrors).toEqual([expect.stringContaining('paused at the unit boundary')]);
    const lines = readFileSync(join(out, 'checkpoint.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as { model: string });
    expect(lines.map(l => l.model)).toEqual(['particle:particle-1']);
    const resumed = await run(out, () => null, models);
    expect(resumed.resumedUnits).toBe(1);
    expect(resumed.rows).toHaveLength(16);
    expect(resumed.harnessErrors).toEqual([]);
    expect(fetches).toBe(0);
  }, 120_000);
});
