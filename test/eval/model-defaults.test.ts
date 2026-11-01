/**
 * Live categories' default models follow CLAUDE.md "Choose models" (R4, GST-611; frontier first, 2026-11-01): every
 * registered default is a current-generation model, and no model under test is a Sonnet or Haiku model, unless
 * eval/runner/model-defaults.ts names it as an exception with a reason. A new category registers its defaults in
 * DEFAULTS below, models under test apart from judges.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { configureGateway, getChatModel, resetGateway } from 'gbrain/ai/gateway';
import { TIER_DEFAULTS } from '../../node_modules/gbrain/src/core/model-config.ts';
import { CURRENT_GENERATION, DEFAULT_MODEL_EXCEPTIONS, bareModelId, defaultModelProblem, underTestModelProblem } from '../../eval/runner/model-defaults.ts';
import { DEFAULT_JUDGE_MODEL as SHARED_JUDGE } from '../../eval/runner/judge.ts';
import { DEFAULT_JUDGE_MODEL as CAT5_JUDGE } from '../../eval/runner/cat5-provenance.ts';
import { DEFAULT_AGENT_MODEL } from '../../eval/runner/adapters/claude-sonnet-with-tools.ts';
import { DEFAULT_JUDGE_MODEL as CAT9_JUDGE } from '../../eval/runner/cat9-workflows.ts';
import { DEFAULT_JUDGE_MODEL as CAT14_JUDGE, DEFAULT_THINK_MODEL as CAT14_THINK } from '../../eval/runner/cat14-calibration.ts';
import { DEFAULT_EXTRACT_MODEL as CAT15_EXTRACT, DEFAULT_JUDGE_MODEL as CAT15_JUDGE } from '../../eval/runner/cat15-propose-takes.ts';
import { DEFAULT_CHAT_MODEL as CAT20_CHAT } from '../../eval/runner/cat20-brainstorm.ts';
import { DEFAULT_THINK_MODEL as CAT25_THINK, JUDGE_MODEL as CAT25_JUDGE } from '../../eval/runner/cat25-trajectory-routing.ts';
import { JUDGE_MODEL as CAT29_JUDGE, THINK_MODEL as CAT29_THINK } from '../../eval/runner/cat29-think-vs-search.ts';
import { SKILLOPT_MODELS } from '../../eval/runner/cat30-skillopt-improvement.ts';
import { DISTILL_MODEL as CAT35_DISTILL } from '../../eval/runner/cat35-transcript-distill.ts';
import { CAT35_DEFAULT_JUDGE_MODEL } from '../../eval/runner/cat35-judges.ts';
import { GROUNDED_JUDGE_MODEL } from '../../eval/runner/cat36-grounded-answers.ts';
import { JUDGE_MODEL as LME_ANSWERS_JUDGE } from '../../eval/runner/longmemeval-answers.ts';
import { READER_MODEL as A4_READER } from '../../eval/runner/a4-abstention.ts';
import { DEFAULT_AGENT_MODEL as CHRONICLE_AGENT } from '../../eval/runner/chronicle-lift.ts';
import { DEFAULT_DEV_MODEL as TEMPORAL_CONTRADICTIONS_DEV } from '../../eval/runner/temporal-contradictions.ts';
import { DEFAULT_THINK_MODEL as PRECISIONMEMBENCH_THINK } from '../../eval/precisionmembench/gbrainThinkAdapter.ts';
import { DEFAULT_JUDGE as QA_JUDGE, DEFAULT_READER as QA_READER } from '../../eval/runner/memory-qa/qa.ts';
import { DEFAULT_QA as LIFECYCLE_QA } from '../../eval/runner/lifecycle-lite/run.ts';
import { JUDGE_MODEL as N2_JUDGE } from '../../eval/runner/n2-contradiction-surfacing.ts';
import { EXTRACTOR_MODEL as N7_EXTRACTOR } from '../../eval/runner/n7-open-loops-email.ts';
import { JUDGE_MODEL as SEALED_JUDGE, READER_MODEL as SEALED_READER } from '../../eval/runner/sealed-confirmation.ts';
import { JUDGE_MODEL as PILOT_JUDGE } from '../../eval/runner/pilot/run.ts';
import { SHIPPED_DEFAULT_MODEL } from '../../eval/runner/facts-absorb-gate.ts';
import { GPT4O as E1_GPT4O, SONNET as E1_SONNET } from '../../eval/runner/evidence-delivery/e1.ts';
import { DEV_ANSWER, DEV_JUDGE } from '../../eval/runner/harness-dev.ts';

/** `test` holds the models under test: agents, readers, answer, think and extraction models, optimizers and optimization targets. */
interface Registered { test?: readonly string[]; judge?: readonly string[] }
const { judge: SKILLOPT_JUDGE, ...SKILLOPT_UNDER_TEST } = SKILLOPT_MODELS;

const DEFAULTS: Record<string, Registered> = {
  'shared judge (judge.ts)': { judge: [SHARED_JUDGE] },
  'Cat 5 judge': { judge: [CAT5_JUDGE] },
  'Cat 8/9 agent': { test: [DEFAULT_AGENT_MODEL] },
  'Cat 9 judge': { judge: [CAT9_JUDGE] },
  'Cat 14 think and judge': { test: [CAT14_THINK], judge: [CAT14_JUDGE] },
  'Cat 15 extractor and judge': { test: [CAT15_EXTRACT], judge: [CAT15_JUDGE] },
  'Cat 20 generation': { test: [CAT20_CHAT] },
  'Cat 25 think and judge': { test: [CAT25_THINK], judge: [CAT25_JUDGE] },
  'Cat 29 think and judge': { test: [CAT29_THINK], judge: [CAT29_JUDGE] },
  'Cats 30-33 SkillOpt': { test: Object.values(SKILLOPT_UNDER_TEST), judge: [SKILLOPT_JUDGE] },
  'Cat 35 distill, triage and judge': { test: [CAT35_DISTILL], judge: [CAT35_DEFAULT_JUDGE_MODEL] },
  'Cat 36 grounded-answer judge': { judge: [GROUNDED_JUDGE_MODEL] },
  'LongMemEval answer-grounding judge': { judge: [LME_ANSWERS_JUDGE] },
  'A4 house reader': { test: [A4_READER] },
  'chronicle-lift agent': { test: [CHRONICLE_AGENT] },
  'temporal-contradictions dev model': { test: [TEMPORAL_CONTRADICTIONS_DEV] },
  'PrecisionMemBench think model': { test: [PRECISIONMEMBENCH_THINK] },
  ...Object.fromEntries(Object.keys(QA_READER).map(b => [`memory-qa ${b} reader and judge`, { test: [QA_READER[b]!], judge: [QA_JUDGE[b]!] }])),
  'lifecycle-lite reader and judge': { test: [LIFECYCLE_QA.reader], judge: [LIFECYCLE_QA.judge] },
  'sealed confirmation reader and judge': { test: [SEALED_READER], judge: [SEALED_JUDGE] },
  'pilot judge': { judge: [PILOT_JUDGE] },
  'facts-absorb gate baseline': { test: [SHIPPED_DEFAULT_MODEL] },
  'evidence-delivery E1 readers': { test: [E1_SONNET, E1_GPT4O] },
  'N2 contradiction judge': { test: [N2_JUDGE] },
  'N7 open-loop extractor': { test: [N7_EXTRACTOR] },
  'harness dev lane reader and judge': { test: [DEV_ANSWER], judge: [DEV_JUDGE.default!] },
  'harness dev lane BEAM judge': { judge: [DEV_JUDGE.beam!] },
};
const models = (r: Registered): string[] => [...(r.test ?? []), ...(r.judge ?? [])];

afterAll(() => resetGateway());

describe('default models (CLAUDE.md "Choose models")', () => {
  test('every registered default outside the named exceptions is a current-generation model', () => {
    const problems = Object.entries(DEFAULTS)
      .filter(([name]) => !DEFAULT_MODEL_EXCEPTIONS[name])
      .flatMap(([name, r]) => models(r).map(defaultModelProblem).filter(p => p !== null).map(p => `${name}: ${p}`));
    expect(problems).toEqual([]);
  });

  test('no model under test outside the named exceptions is a Sonnet or Haiku model', () => {
    const problems = Object.entries(DEFAULTS)
      .filter(([name]) => !DEFAULT_MODEL_EXCEPTIONS[name])
      .flatMap(([name, r]) => (r.test ?? []).map(underTestModelProblem).filter(p => p !== null).map(p => `${name}: ${p}`));
    expect(problems).toEqual([]);
  });

  test('each exception names the models the code uses, and at least one of them breaks a rule', () => {
    for (const [name, exception] of Object.entries(DEFAULT_MODEL_EXCEPTIONS)) {
      const registered = DEFAULTS[name] ?? {};
      expect([name, models(registered)]).toEqual([name, [...exception.models]]);
      const breaks = models(registered).some(m => defaultModelProblem(m) !== null) || (registered.test ?? []).some(m => underTestModelProblem(m) !== null);
      expect([name, breaks]).toEqual([name, true]);
      expect(exception.reason.length).toBeGreaterThan(20);
    }
  });

  test("product-default mirrors equal gbrain's own defaults at the installed pin", () => {
    configureGateway({ env: {} });
    const gbrainDefault: Record<string, string> = {
      'N2 contradiction judge': TIER_DEFAULTS.utility,
      'N7 open-loop extractor': getChatModel(),
    };
    const mirrors = Object.entries(DEFAULT_MODEL_EXCEPTIONS).filter(([, e]) => e.kind === 'product-default-mirror');
    expect(mirrors.map(([name]) => name).sort()).toEqual(Object.keys(gbrainDefault).sort());
    for (const [name, exception] of mirrors) expect([name, exception.models]).toEqual([name, [gbrainDefault[name]]]);
  });

  test('the rule: current ids pass with or without provider prefix and snapshot date; older, Fable and gpt-5.4-mini fail', () => {
    for (const id of CURRENT_GENERATION) expect([id, defaultModelProblem(id), defaultModelProblem(`anthropic:${id}`)]).toEqual([id, null, null]);
    expect(bareModelId('anthropic:claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    for (const older of ['claude-haiku-4-5-20251001', 'anthropic:claude-sonnet-4-6', 'claude-opus-4-7', 'claude-sonnet-5', 'claude-opus-5', 'openai:gpt-4o-mini', 'gpt-4o-2024-08-06', 'openai:gpt-4.1-mini', 'gpt-5.4', 'gpt-6-sol']) {
      expect([older, defaultModelProblem(older)]).toEqual([older, `${older} is not a current-generation model`]);
    }
    expect(defaultModelProblem('openai:gpt-5.4-mini')).toBe('openai:gpt-5.4-mini: gpt-5.4-mini is never run');
    expect(defaultModelProblem('anthropic:claude-fable-5-1')).toContain('smoke tests');
  });

  test('the frontier rule: a Sonnet or Haiku model of any generation fails as a model under test; Opus and GPT pass', () => {
    for (const m of ['anthropic:claude-sonnet-5-5', 'claude-haiku-5-5', 'anthropic:claude-sonnet-4-6', 'claude-haiku-4-5-20251001']) {
      expect([m, underTestModelProblem(m)]).toEqual([m, `${m}: Sonnet and Haiku are never models under test`]);
    }
    for (const m of ['anthropic:claude-opus-5-5', 'claude-opus-5-5', 'openai:gpt-6.1-sol', 'gpt-6.1-sol']) expect([m, underTestModelProblem(m)]).toEqual([m, null]);
  });
});
