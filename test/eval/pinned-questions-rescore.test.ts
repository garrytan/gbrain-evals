import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAIMS, generatePinnedQuestionsWorld, type PqCompany, type PqWorld } from '../../eval/generators/pinned-questions-gen.ts';
import { gbrainSpecFrom, overlaySummary, resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { PaidArmRefusal } from '../../eval/runner/paid-arm.ts';
import { claimSentence } from '../../eval/runner/pinned-questions.ts';
import {
  CATEGORY, PINNED_QUESTIONS_JUDGES, PINNED_QUESTIONS_JUDGE_PROMPT, PINNED_QUESTIONS_MODELS_UNDER_TEST, canonicalModel, judgeFor, ruleLabels, scoredCorrect,
  type ChatTransport, type GradedAnswer, type PaidRow, type StaleProbe,
} from '../../eval/runner/pinned-questions-paid.ts';
import {
  BOTH_VALUE_TEMPLATES, PINNED_QUESTIONS_RESCORE_PROMPT, RESCORE_SOURCE_SHA256, bothValueItems, buildRescoreReceipt, readRescoreInputs, rescoreEstimateUsd, rescorePlan,
  rescorePromptSha256, runRescore, type RescoreInputName, type RescoreResult,
} from '../../eval/runner/pinned-questions-rescore.ts';
import { writeReceipt } from '../../eval/runner/receipt.ts';

const KEY_NAMES = /(_API_KEY|_API_TOKEN|_BEARER_TOKEN)$|^(TYPESAFE|JEV)_/;
const keylessEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !KEY_NAMES.test(k)));
const wordIn = (v: string, t: string) => t.split(/[^A-Za-z0-9]+/).join(' ').includes(v.split(/[^A-Za-z0-9]+/).join(' '));
const gut = resolveGbrainUnderTest(gbrainSpecFrom([]));
const MODELS = PINNED_QUESTIONS_MODELS_UNDER_TEST.map(canonicalModel);
const JC_SEEDS = [21, 22, 23], COUNTED_SEEDS = [11];
const worldsOf = (seeds: number[]) => new Map(seeds.map(seed => [seed, generatePinnedQuestionsWorld({ seed })] as const));
const said = (c: PqCompany, values: PqCompany['after']) => CLAIMS.filter(cl => values[cl] !== null).map(cl => claimSentence(c, cl, values[cl]!));
const template = (id: string) => [...BOTH_VALUE_TEMPLATES.city.correct, ...BOTH_VALUE_TEMPLATES.city.not_correct].find(t => t.id === id)!;
const withCity = (c: PqCompany, id: string) => CLAIMS.map(k => (k === 'city' ? template(id).text(c, c.before.city, c.after.city!) : claimSentence(c, k, c.after[k]!)));
const CONTRADICTIONS = ['contradict_new_page', 'contradict_existing_page'];

function graded(c: PqCompany, kind: 'first' | 'refreshed', sentences: string[], judgeCorrect?: boolean): GradedAnswer {
  const rule = ruleLabels(c, kind, sentences);
  const rc = Object.values(rule).includes('ambiguous') ? null : Object.values(rule).every(l => l === 'correct');
  return { sentences, judge_labels: null, judge_error: null, answer_correct: judgeCorrect ?? rc ?? true, rule_labels: rule, rule_correct: rc, judge_usage: { calls: 1, input_tokens: 450, output_tokens: 30, cache_read_tokens: 0, cache_write_tokens: 0 } };
}
const call = (model: string, status = 'published') => ({ status, mode: 'full' as const, error: status === 'published' ? null : 'refresh_failed:invalid_output', failure_message: null, safety_finish: null, cost_usd: null, usage: { calls: 1, input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, models: [model] } });
function row(model: string, seed: number, c: PqCompany, refreshed: string[], judgeCorrect?: boolean, status = 'published'): PaidRow {
  const r = { model, seed, company: c.slug, mutation: c.mutation, affected: [...c.affected], judge_model: judgeFor(model), pin: call(model), refresh: { ...call(model, status), freshness: 'fresh', stale_sentences: 0 },
    first: graded(c, 'first', said(c, c.before)), refreshed: { ...graded(c, 'refreshed', refreshed, judgeCorrect), stale: [] as boolean[] }, outcome: status === 'published' ? 'published' as const : 'not_published' as const, answer_model: model };
  return { ...r, correct: scoredCorrect(r) } as PaidRow;
}
const receiptOf = (stage: string, worlds: Map<number, PqWorld>, data: object, extra: object = {}) => ({
  category: CATEGORY, run_status: 'completed', publishable: true, gbrain_version: gut.version,
  hashes: Object.fromEntries([...worlds.values()].map(w => [`ledger_seed_${w.seed}`, w.fingerprint])),
  resolved_config: { mode: 'paid', stage, seeds: [...worlds.keys()], companies_per_seed: 24, gbrain_overlay: overlaySummary(gut) },
  data, ...extra,
});

/**
 * Counted rows on seed 11: every answer correct, except that Opus states a contradicted city by its sources only (the
 * frozen judge called it correct), particle-1 orders the two cities in its own words (the frozen judge called it wrong),
 * and one Sol refresh did not publish.
 */
function fixtures(dir: string) {
  const jcWorlds = worldsOf(JC_SEEDS), countedWorlds = worldsOf(COUNTED_SEEDS);
  const jcRows = MODELS.flatMap(m => [...jcWorlds.values()].flatMap(w => w.companies.map(c => row(m, w.seed, c, said(c, c.after)))));
  const probes: StaleProbe[] = jcRows.filter(r => r.affected.length > 0).map(r => ({ model: r.model, seed: r.seed, company: r.company, mutation: r.mutation, judge_model: r.judge_model, graded: graded(jcWorlds.get(r.seed)!.companies.find(c => c.slug === r.company)!, 'refreshed', r.first.sentences) }));
  const w = countedWorlds.get(11)!;
  const unpublished = w.companies.find(c => c.affected.length === 0)!.slug;
  const countedRows = MODELS.flatMap(m => w.companies.map(c => {
    if (m === 'anthropic:claude-opus-5-5' && CONTRADICTIONS.includes(c.mutation)) return row(m, 11, c, withCity(c, 'city-sources-only'), true);
    if (m === 'particle:particle-1' && CONTRADICTIONS.includes(c.mutation)) return row(m, 11, c, withCity(c, 'city-moved-from'), false);
    if (m === 'openai:gpt-6.2-sol' && c.slug === unpublished) return row(m, 11, c, said(c, c.before), false, 'failed');
    return row(m, 11, c, said(c, c.after));
  }));
  const write = (name: string, r: object) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(r)); return p; };
  const paths = { 'judge-check': write('jc.json', receiptOf('judge-check', jcWorlds, { rows: jcRows })) } as Record<RescoreInputName, string>;
  const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
  paths['stale-probes'] = write('probes.json', { ...receiptOf('stale-probes', new Map(), { probes }), resolved_config: { mode: 'paid', stage: 'stale-probes', gbrain_overlay: overlaySummary(gut), judge_check_receipt_sha256: sha(paths['judge-check']) } });
  paths.counted = write('counted.json', receiptOf('counted', countedWorlds, { rows: countedRows }));
  const expected = Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, sha(p)])) as Record<RescoreInputName, string>;
  return { jcWorlds, countedWorlds, countedRows, paths, expected, write, sha, contradictions: w.companies.filter(c => CONTRADICTIONS.includes(c.mutation)).length };
}

/**
 * A judge that applies the both-value rule: an answer sentence built from a template takes that template's label on its
 * claim (not correct as wrong, or stale when it keeps the previous value); every other claim is graded by its tokens.
 * blind: every both-value sentence is called correct.
 */
function ruleJudge(worlds: PqWorld[], calls: Array<{ model: string; system: string }>, blind = false): ChatTransport {
  const known = new Map<string, { claim: string; label: string }>();
  for (const w of worlds) for (const c of w.companies) for (const claim of ['city', 'founded'] as const) {
    if (c.before[claim] === c.after[claim]) continue;
    for (const t of [...BOTH_VALUE_TEMPLATES[claim].correct, ...BOTH_VALUE_TEMPLATES[claim].not_correct]) {
      known.set(t.text(c, c.before[claim], c.after[claim]!), { claim, label: blind || t.label ? 'correct' : t.id.endsWith('keeps-previous') ? 'stale' : 'wrong' });
    }
  }
  return async opts => {
    const user = String(opts.messages[opts.messages.length - 1]?.content ?? '');
    calls.push({ model: String(opts.model), system: String(opts.system) });
    const answer = user.slice(user.indexOf('\nAnswer:\n') + '\nAnswer:\n'.length).split('\n');
    const labels: Record<string, string> = {};
    for (const line of user.split('\n').filter(l => /^- (city|flagship|ceo|founded): current/.test(l))) {
      const claim = line.slice(2, line.indexOf(':'));
      const [now, was] = [...line.matchAll(/"([^"]*)"/g)].map(m => m[1]!);
      const removed = line.includes('(none: removed)');
      const cur = removed ? null : now!, prev = removed ? now : was;
      const text = answer.join(' ');
      labels[claim] = cur === null ? (wordIn(prev!, text) ? 'stale' : 'correct') : wordIn(cur, text) ? 'correct' : prev && wordIn(prev, text) ? 'stale' : 'missing';
    }
    for (const s of answer) { const k = known.get(s); if (k) labels[k.claim] = k.label; }
    const text = JSON.stringify(labels);
    return { text, blocks: [{ type: 'text', text }], stopReason: 'end', model: String(opts.model), providerId: 'stub', usage: { input_tokens: Math.ceil(user.length / 4), output_tokens: Math.ceil(text.length / 4), cache_read_tokens: 0, cache_creation_tokens: 0 } };
  };
}

describe('pinned-questions rescore: the rule and the both-value set', () => {
  test('the rescore prompt is the frozen prompt with only its correct and wrong lines replaced', () => {
    const frozen = PINNED_QUESTIONS_JUDGE_PROMPT.split('\n'), rescore = PINNED_QUESTIONS_RESCORE_PROMPT.split('\n');
    expect(rescore).toHaveLength(frozen.length);
    expect(rescore.map((l, i) => l === frozen[i])).toEqual([true, true, false, true, false, true, true, true]);
    expect(rescore[2]).toStartWith('- correct: ');
    expect(rescore[4]).toStartWith('- wrong: ');
    expect(rescorePromptSha256()).not.toBe(createHash('sha256').update(PINNED_QUESTIONS_JUDGE_PROMPT).digest('hex'));
  });

  test('the both-value set holds four answers per changed city or founding year on the judge-check seeds, half labelled correct, each naming both values and using every template', () => {
    const worlds = [...worldsOf(JC_SEEDS).values()];
    const items = bothValueItems(worlds);
    const companies = worlds.flatMap(w => w.companies.filter(c => ['edit_claim_page', 'contradict_new_page', 'contradict_existing_page', 'edit_claim_fact'].includes(c.mutation)));
    expect(companies).toHaveLength(36);
    expect(items).toHaveLength(144);
    expect(items.filter(x => x.label)).toHaveLength(72);
    for (const x of items) {
      const c = companies.find(k => k.slug === x.company)!;
      const text = x.sentences.join(' ');
      expect([x.company, wordIn(c.before[x.claim], text), wordIn(c.after[x.claim]!, text)]).toEqual([x.company, true, true]);
      expect(Object.values(ruleLabels(c, 'refreshed', x.sentences))).toContain('ambiguous');
    }
    for (const c of companies) expect(items.filter(x => x.company === c.slug).map(x => x.label)).toEqual([true, true, false, false]);
    const used = new Set(items.map(x => x.template));
    for (const t of Object.values(BOTH_VALUE_TEMPLATES).flatMap(v => [...v.correct, ...v.not_correct])) expect([t.id, used.has(t.id)]).toEqual([t.id, true]);
  });
});

describe('pinned-questions rescore: the published inputs', () => {
  const d = mkdtempSync(join(tmpdir(), 'pq-rescore-in-'));
  afterAll(() => rmSync(d, { recursive: true, force: true }));

  test('each input must be the published receipt by sha256, paid, completed and publishable, on the build under test, with its worlds and the family rule intact', () => {
    const f = fixtures(d);
    const read = (paths: Record<RescoreInputName, string>, expected = f.expected) => () => readRescoreInputs(paths, { gut, expected });
    const inputs = read(f.paths)();
    expect([inputs.counted.rows.length, inputs.judgeCheck.rows.length, inputs.probes.length]).toEqual([72, 216, 135]);
    expect(read(f.paths, { ...f.expected, counted: 'x'.repeat(64) })).toThrow(/not the published x+/);
    expect(read({ ...f.paths, counted: join(d, 'none.json') })).toThrow(/does not exist/);
    const swap = (name: RescoreInputName, r: object) => { const p = f.write(`${name}-bad.json`, r); return read({ ...f.paths, [name]: p }, { ...f.expected, [name]: f.sha(p) }); };
    const counted = JSON.parse(readFileSync(f.paths.counted, 'utf8'));
    expect(swap('counted', { ...counted, resolved_config: { ...counted.resolved_config, stage: 'pilot' } })).toThrow(/not a paid pinned-questions-paid counted receipt/);
    expect(swap('counted', { ...counted, publishable: false })).toThrow(/publishable false/);
    expect(swap('counted', { ...counted, gbrain_version: '0.0.1' })).toThrow(/not the build under test/);
    expect(swap('counted', { ...counted, hashes: { ledger_seed_11: 'x' } })).toThrow(/does not regenerate/);
    expect(swap('counted', { ...counted, data: { rows: counted.data.rows.map((r: PaidRow, i: number) => (i === 0 ? { ...r, judge_model: 'anthropic:claude-opus-5-5' } : r)) } })).toThrow(/was judged by anthropic:claude-opus-5-5, not openai:gpt-6.2-astra/);
    const probes = JSON.parse(readFileSync(f.paths['stale-probes'], 'utf8'));
    expect(swap('stale-probes', { ...probes, resolved_config: { ...probes.resolved_config, judge_check_receipt_sha256: 'other' } })).toThrow(/different judge-check receipt/);
    expect(read(f.paths, { ...f.expected, 'judge-check': 'y'.repeat(64) })).toThrow(PaidArmRefusal);
  });

  test('the estimate prices every planned judge call: both judges on each both-value answer, each recheck item and each re-judged counted row', () => {
    const f = fixtures(d);
    const plan = rescorePlan(readRescoreInputs(f.paths, { gut, expected: f.expected }));
    expect([plan.bothValue.length, plan.counted.length]).toEqual([144, 71]);
    expect(plan.recheck).toHaveLength(216 * 2 + 135);
    const one = rescoreEstimateUsd({ bothValue: [], recheck: [], counted: plan.counted.slice(0, 1) }, { outputTokens: 100, callsPerAnswer: 1 });
    expect(one).toBeGreaterThan(0);
    expect(rescoreEstimateUsd(plan, null)).toBeGreaterThan(rescoreEstimateUsd(plan, { outputTokens: 100, callsPerAnswer: 1 }));
  });

  test('the CLI refuses an input that is not the published receipt, and a directory where a rescore already started, before any request', () => {
    const f = fixtures(d);
    const out = join(d, 'out');
    const cli = () => spawnSync('bun', ['eval/runner/pinned-questions-rescore.ts', '--counted', f.paths.counted, '--judge-check', f.paths['judge-check'], '--stale-probes', f.paths['stale-probes'], '--output', out, '--paid', '--budget-run-id', 'none'], { env: keylessEnv(), encoding: 'utf8' });
    const first = cli();
    expect([first.status, first.stderr]).toEqual([2, expect.stringContaining('not the published')]);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'rescore.started'), 'x\n');
    const second = cli();
    expect([second.status, second.stderr]).toEqual([2, expect.stringContaining('a rescore already started')]);
  });
});

describe("pinned-questions rescore: keyless run through gbrain's gateway", () => {
  const d = mkdtempSync(join(tmpdir(), 'pq-rescore-run-'));
  const realFetch = globalThis.fetch;
  const savedKeys: Record<string, string | undefined> = {};
  let fetches = 0;
  let f: ReturnType<typeof fixtures>;
  let result: RescoreResult;
  let blind: RescoreResult;
  const calls: Array<{ model: string; system: string }> = [];
  const blindCalls: Array<{ model: string; system: string }> = [];

  beforeAll(async () => {
    for (const k of Object.keys(process.env).filter(k => KEY_NAMES.test(k))) { savedKeys[k] = process.env[k]; delete process.env[k]; }
    globalThis.fetch = (async () => { fetches++; throw new Error('no network in this test'); }) as unknown as typeof fetch;
    f = fixtures(d);
    const inputs = readRescoreInputs(f.paths, { gut, expected: f.expected });
    const worlds = [...f.jcWorlds.values(), ...f.countedWorlds.values()];
    result = await runRescore({ gut, inputs, mode: { kind: 'keyless', transport: ruleJudge(worlds, calls) } });
    blind = await runRescore({ gut, inputs, mode: { kind: 'keyless', transport: ruleJudge(worlds, blindCalls, true) } });
  }, 300_000);

  afterAll(() => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(savedKeys)) if (v !== undefined) process.env[k] = v;
    rmSync(d, { recursive: true, force: true });
  });

  test('no request leaves the process, only the two judges are asked, always with the rescore prompt', () => {
    expect(fetches).toBe(0);
    expect(result.harnessErrors).toEqual([]);
    expect(new Set(calls.map(c => c.model.split(':').pop()))).toEqual(new Set(PINNED_QUESTIONS_JUDGES.map(j => j.split(':').pop())));
    expect(calls.every(c => c.system === PINNED_QUESTIONS_RESCORE_PROMPT)).toBe(true);
    expect(calls).toHaveLength(144 * 2 + 216 * 2 + 135 + 71);
  });

  test("both judges pass the gate on the both-value set and the recheck, and each counted row goes to its own family's judge", () => {
    expect(result.gate!.pass).toBe(true);
    for (const j of PINNED_QUESTIONS_JUDGES) {
      expect(result.gate!.both_value[j]).toMatchObject({ n: 144, kappa: 1 });
      expect(result.gate!.recheck[j]!.kappa).toBe(1);
      expect(result.gate!.recheck[j]!.n).toBeGreaterThanOrEqual(100);
    }
    expect(result.counted.every(x => x.judge_model === judgeFor(x.model))).toBe(true);
  });

  test('the rescored column sits beside the preregistered one: unordered answers the frozen judge passed flip to not correct, ordered ones it failed flip to correct, and an unpublished refresh stays not correct', () => {
    const inputs = readRescoreInputs(f.paths, { gut, expected: f.expected });
    const receipt = buildRescoreReceipt({ gut, inputs, result, cost: null, startedAt: new Date().toISOString(), mode: 'keyless' }) as unknown as Record<string, any>;
    writeReceipt(join(d, 'receipt.rescore.json'), receipt as never);
    const s = receipt.data.summary.by_model;
    const n = f.contradictions;
    expect(s['anthropic:claude-opus-5-5']).toMatchObject({ preregistered: { correct: 24, scored: 24 }, rescored: { correct: 24 - n }, flipped_to_not_correct: n, flipped_to_correct: 0 });
    expect(s['particle:particle-1']).toMatchObject({ preregistered: { correct: 24 - n }, rescored: { correct: 24 }, flipped_to_correct: n, flipped_to_not_correct: 0 });
    expect(s['openai:gpt-6.2-sol']).toMatchObject({ preregistered: { correct: 23, scored: 24 }, rescored: { correct: 23, scored: 24 }, rejudged: 23 });
    expect(Object.keys(receipt.data.summary.comparisons_rescored)).toEqual(['particle:particle-1', 'openai:gpt-6.2-sol']);
    expect(Object.keys(receipt.data.summary.comparisons_preregistered)).toEqual(['particle:particle-1', 'openai:gpt-6.2-sol']);
    expect(receipt.verdict).toBe('pass');
    expect(receipt.run_status).toBe('completed');
    expect(receipt.publishable).toBe(false);
    expect(receipt.cost.usd).toBe(0);
    expect(receipt.resolved_config).toMatchObject({ stage: 'rescore', runner_source_sha256: RESCORE_SOURCE_SHA256, inputs_sha256: f.expected, judge: { prompt_sha256: rescorePromptSha256() } });
    expect(receipt.resolved_config.models.map((m: { model: string; role: string }) => m.role)).toEqual(['judge', 'judge']);
  });

  test('a judge that calls every both-value answer correct fails the gate, and no counted row is re-judged', () => {
    expect(blind.gate!.pass).toBe(false);
    expect(blind.gate!.both_value['openai:gpt-6.2-astra']!.kappa).toBe(0);
    expect(blind.counted).toEqual([]);
    expect(blindCalls).toHaveLength(144 * 2 + 216 * 2 + 135);
    const receipt = buildRescoreReceipt({ gut, inputs: readRescoreInputs(f.paths, { gut, expected: f.expected }), result: blind, cost: null, startedAt: new Date().toISOString(), mode: 'paid' }) as unknown as Record<string, any>;
    expect([receipt.verdict, receipt.publishable]).toEqual(['fail', false]);
    expect(receipt.data.summary.by_model['anthropic:claude-opus-5-5'].rescored.scored).toBe(0);
  });
});
