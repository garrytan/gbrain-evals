/**
 * Live categories' default models follow CLAUDE.md "Choose models" (R4, GST-611): every registered default is a
 * current-generation model unless eval/runner/model-defaults.ts names it as an exception with a reason. A new
 * category registers its defaults in DEFAULTS below.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { configureGateway, getChatModel, resetGateway } from 'gbrain/ai/gateway';
import { TIER_DEFAULTS } from '../../node_modules/gbrain/src/core/model-config.ts';
import { CURRENT_GENERATION, DEFAULT_MODEL_EXCEPTIONS, bareModelId, defaultModelProblem } from '../../eval/runner/model-defaults.ts';
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
import { BPRE_MODEL as CAT35_BPRE, FULL_MODEL as CAT35_FULL } from '../../eval/runner/cat35-transcript-distill.ts';
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
import { DEFAULT_PROPOSER_MODEL as N15_PROPOSER, DEFAULT_TARGET_MODELS as N15_TARGETS } from '../../eval/runner/n15-skillopt-method.ts';

const DEFAULTS: Record<string, readonly string[]> = {
  'shared judge (judge.ts)': [SHARED_JUDGE],
  'Cat 5 judge': [CAT5_JUDGE],
  'Cat 8/9 agent': [DEFAULT_AGENT_MODEL],
  'Cat 9 judge': [CAT9_JUDGE],
  'Cat 14 think and judge': [CAT14_THINK, CAT14_JUDGE],
  'Cat 15 extractor and judge': [CAT15_EXTRACT, CAT15_JUDGE],
  'Cat 20 generation': [CAT20_CHAT],
  'Cat 25 think and judge': [CAT25_THINK, CAT25_JUDGE],
  'Cat 29 think and judge': [CAT29_THINK, CAT29_JUDGE],
  'Cats 30-33 SkillOpt': Object.values(SKILLOPT_MODELS),
  'Cat 35 distill, triage and judge': [CAT35_FULL, CAT35_BPRE, CAT35_DEFAULT_JUDGE_MODEL],
  'Cat 36 grounded-answer judge': [GROUNDED_JUDGE_MODEL],
  'LongMemEval answer-grounding judge': [LME_ANSWERS_JUDGE],
  'A4 house reader': [A4_READER],
  'chronicle-lift agent': [CHRONICLE_AGENT],
  'temporal-contradictions dev model': [TEMPORAL_CONTRADICTIONS_DEV],
  'PrecisionMemBench think model': [PRECISIONMEMBENCH_THINK],
  ...Object.fromEntries(Object.keys(QA_READER).map(b => [`memory-qa ${b} reader and judge`, [QA_READER[b]!, QA_JUDGE[b]!]])),
  'lifecycle-lite reader and judge': [LIFECYCLE_QA.reader, LIFECYCLE_QA.judge],
  'sealed confirmation reader and judge': [SEALED_READER, SEALED_JUDGE],
  'pilot judge': [PILOT_JUDGE],
  'facts-absorb gate baseline': [SHIPPED_DEFAULT_MODEL],
  'evidence-delivery E1 readers': [E1_SONNET, E1_GPT4O],
  'N2 contradiction judge': [N2_JUDGE],
  'N7 open-loop extractor': [N7_EXTRACTOR],
  'N15 SkillOpt method targets and proposer': [...N15_TARGETS, N15_PROPOSER],
  'harness dev lane reader and judge': [DEV_ANSWER, DEV_JUDGE.default!],
  'harness dev lane BEAM judge': [DEV_JUDGE.beam!],
};

afterAll(() => resetGateway());

describe('default models (CLAUDE.md "Choose models")', () => {
  test('every registered default outside the named exceptions is a current-generation model', () => {
    const problems = Object.entries(DEFAULTS)
      .filter(([name]) => !DEFAULT_MODEL_EXCEPTIONS[name])
      .flatMap(([name, models]) => models.map(defaultModelProblem).filter(p => p !== null).map(p => `${name}: ${p}`));
    expect(problems).toEqual([]);
  });

  test('each exception names the models the code uses, and at least one of them is not current', () => {
    for (const [name, exception] of Object.entries(DEFAULT_MODEL_EXCEPTIONS)) {
      expect([name, DEFAULTS[name]]).toEqual([name, exception.models]);
      expect([name, exception.models.some(m => defaultModelProblem(m) !== null)]).toEqual([name, true]);
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
});
