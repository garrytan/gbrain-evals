import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAIMS, generatePinnedQuestionsWorld, type PqCompany, type PqWorld } from '../../eval/generators/pinned-questions-gen.ts';
import { claimSentence } from '../../eval/runner/pinned-questions.ts';
import { gbrainSpecFrom, resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { PaidArmRefusal } from '../../eval/runner/paid-arm.ts';
import { writeReceipt } from '../../eval/runner/receipt.ts';
import {
  PINNED_QUESTIONS_JUDGE_PROMPT, PINNED_QUESTIONS_MODELS_UNDER_TEST, buildReceipt, canonicalModel, cohenKappa, familyOf, judgeAgreement, judgeFor,
  judgeUserMessage, modelRoles, parseJudgeLabels, requirePaidFlags, ruleLabels, runPinnedQuestionsPaid,
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
});

describe('pinned-questions paid arm: models and judges', () => {
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
});

/**
 * A stub at gbrain's chat transport: answers each question from the ledger
 * (before the change while pinning; after it on refresh, except for the
 * companies in `stale`, which repeat the old values), and grades like the rule.
 */
function stubTransport(world: PqWorld, stale: Set<string>, calls: Array<{ model: string; kind: 'question' | 'judge'; graded?: string; chars: number }>): ChatTransport {
  const byQuestion = new Map(world.companies.map(c => [c.question, c]));
  const seen = new Map<string, number>();
  return async (opts) => {
    const user = String(opts.messages[opts.messages.length - 1]?.content ?? '');
    const judge = opts.system === PINNED_QUESTIONS_JUDGE_PROMPT;
    const qline = user.split('\n').find(l => l.startsWith('Question: '))!.slice('Question: '.length);
    const c = byQuestion.get(qline)!;
    calls.push({ model: String(opts.model), kind: judge ? 'judge' : 'question', graded: c.slug, chars: (opts.system?.length ?? 0) + user.length });
    let text: string;
    if (judge) {
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
      const values = n === 1 || stale.has(c.slug) ? c.before : c.after;
      const cite = user.split('\n').filter(l => /^E\d+: /.test(l) && l.includes(c.name)).map(l => l.slice(0, l.indexOf(':'))).slice(0, 1);
      text = JSON.stringify({ sentences: CLAIMS.filter(cl => values[cl] !== null).map(cl => ({ text: claimSentence(c, cl, values[cl]!), cite })), gaps: [] });
    }
    const chars = (opts.system?.length ?? 0) + user.length;
    return { text, blocks: [{ type: 'text', text }], stopReason: 'end', model: String(opts.model), providerId: 'stub',
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
    const receipt = buildReceipt({ gut, models: ['claude-opus-5-5', 'particle:particle-1', 'gpt-6.2-sol'], seeds: [1], companies: 8, result, cost: null, startedAt: new Date().toISOString(), mode: 'keyless' }) as unknown as Record<string, any>;
    writeReceipt(join(out, 'receipt.json'), receipt as never);
    expect(receipt.cost.usd).toBe(0);
    expect(receipt.publishable).toBe(false);
    expect(receipt.verdict).toBe('pass');
    expect(receipt.resolved_config.models.map((m: { model: string; role: string }) => `${m.role}:${m.model}`)).toEqual([
      'model under test:anthropic:claude-opus-5-5', 'model under test:particle:particle-1', 'model under test:openai:gpt-6.2-sol',
      'judge:openai:gpt-6.2-astra', 'judge:anthropic:claude-opus-5-5',
    ]);
    expect(receipt.n_scored).toBe(24);
  });
});
