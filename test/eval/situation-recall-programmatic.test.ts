import { afterEach, describe, expect, test } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configPath, loadConfig } from 'gbrain/config';
import {
  parseProgrammaticArgs,
  runSituationRecallProgrammatic,
  validateProgrammaticCatalog,
  type ProgrammaticCatalog,
  type ProgrammaticCategory,
  type ProgrammaticDependencies,
} from '../../eval/runner/situation-recall-programmatic.ts';
import type { AgentAdapterState } from '../../eval/runner/adapters/claude-sonnet-with-tools.ts';
import type { Cat5Report } from '../../eval/runner/cat5-provenance.ts';
import type { Cat8Report } from '../../eval/runner/cat8-skill-compliance.ts';
import type { Cat9Report } from '../../eval/runner/cat9-workflows.ts';
import { loadReceipt } from '../../eval/runner/receipt.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function catalog(category: ProgrammaticCategory): ProgrammaticCatalog {
  const base = {
    schema_version: 1 as const,
    corpus_id: 'programmatic-test-only-v1',
    catalog_status: 'test-only' as const,
    provenance: 'Hermetic fictional fixture; not reviewed capability gold',
    pages: [{ slug: 'notes/fictional', type: 'note' as const, title: 'Fictional constraints', compiled_truth: 'The fictional team meets after ten.', timeline: '- 2026-01-01: confirmed.' }],
    enable_thresholds: false,
  };
  if (category === 'cat5') return { ...base, category, claims: [{ id: 'claim-1', source_page: 'notes/fictional', claim_text: 'The fictional team meets after ten.', expected_label: 'supported', expected_evidence: ['notes/fictional'] }] };
  if (category === 'cat8') return { ...base, category, probes: [{ id: 'probe-1', text: 'When does the fictional team meet?', tier: 'simple' }], poison_fixtures: [] };
  return { ...base, category, scenarios: [{ id: 'scenario-1', workflow: 'briefing', text: 'Brief me on the fictional team schedule.', ground_truth_slugs: ['notes/fictional'], rubric: [{ id: 'time', criterion: 'Gives the recorded time', weight: 1 }] }], poison_fixtures: [] };
}

function inputs(value: ProgrammaticCatalog) {
  const directory = mkdtempSync(join(tmpdir(), 'situation-programmatic-'));
  directories.push(directory);
  const inputPath = join(directory, 'input.json');
  writeFileSync(inputPath, JSON.stringify(value));
  return { category: value.category, inputPath, outputDir: join(directory, 'output') };
}

function client(create: (request: Record<string, unknown>) => unknown): Anthropic {
  return { messages: { create: async (request: Record<string, unknown>) => create(request) } } as unknown as Anthropic;
}

function response(content: unknown[], stop_reason = 'end_turn') {
  return { content, stop_reason, usage: { input_tokens: 100, output_tokens: 20 } };
}

function agent(answer = 'See `notes/fictional`.'): Anthropic {
  return client(() => response([{ type: 'text', text: answer }]));
}

function judge(verdict = 'pass'): Anthropic {
  return client(() => response([{ type: 'tool_use', id: 'judge', name: 'score_answer', input: { scores: [{ criterion_id: 'time', score: verdict === 'pass' ? 5 : 0, rationale: 'Fixture score.' }], verdict, overall_rationale: 'Fixture judgement.' } }]));
}

function inertState(): AgentAdapterState {
  return { engine: {}, poisonFixtures: [] } as unknown as AgentAdapterState;
}

function dependencies(extra: ProgrammaticDependencies = {}): ProgrammaticDependencies {
  return { agentClient: agent(), judgeClient: judge(), createState: async () => inertState(), disposeState: async () => {}, ...extra };
}

describe('programmatic runtime input contract', () => {
  test.each(['cat5', 'cat8', 'cat9'] as const)('%s accepts explicit, nonempty category data', category => {
    expect(validateProgrammaticCatalog(catalog(category), category).category).toBe(category);
  });

  test('the committed template gold is not a runnable catalog', () => {
    const template = JSON.parse(readFileSync('eval/data/gold/citations.json', 'utf8'));
    expect(() => validateProgrammaticCatalog(template, 'cat5')).toThrow('Template/example');
    const value = catalog('cat5');
    (value as unknown as Record<string, unknown>).claims = template.claims;
    expect(() => validateProgrammaticCatalog(value, 'cat5')).toThrow('Template/example');
  });

  test('rejects empty, duplicate and foreign input identities before execution', () => {
    const value = catalog('cat8');
    if (value.category !== 'cat8') throw new Error('fixture');
    expect(() => validateProgrammaticCatalog({ ...value, probes: [] }, 'cat8')).toThrow('nonempty');
    expect(() => validateProgrammaticCatalog({ ...value, probes: [value.probes[0], value.probes[0]] }, 'cat8')).toThrow('duplicates');
    expect(() => validateProgrammaticCatalog({ ...value, pages: [value.pages[0], value.pages[0]] }, 'cat8')).toThrow('duplicates');
    expect(() => validateProgrammaticCatalog(value, 'cat9')).toThrow('mismatch');
  });

  test('rejects unresolved claim, evidence, scenario and poison pages', () => {
    const claims = catalog('cat5');
    const scenarios = catalog('cat9');
    if (claims.category !== 'cat5' || scenarios.category !== 'cat9') throw new Error('fixture');
    for (const field of ['source_page', 'expected_evidence']) {
      const claim = { ...claims.claims[0], [field]: field === 'source_page' ? 'missing' : ['missing'] };
      expect(() => validateProgrammaticCatalog({ ...claims, claims: [claim] }, 'cat5')).toThrow('missing page');
    }
    expect(() => validateProgrammaticCatalog({ ...scenarios, scenarios: [{ ...scenarios.scenarios[0], ground_truth_slugs: ['missing'] }] }, 'cat9')).toThrow('missing page');
    expect(() => validateProgrammaticCatalog({ ...scenarios, poison_fixtures: [{ fixture_id: 'poison-1', slug: 'missing' }] }, 'cat9')).toThrow('missing page');
  });

  test('rejects malformed labels, tiers, rubrics, workflows and threshold activation', () => {
    expect(() => validateProgrammaticCatalog({ ...catalog('cat5'), claims: [{ id: 'x', source_page: 'notes/fictional', claim_text: 'x', expected_label: 'maybe', expected_evidence: [] }] }, 'cat5')).toThrow('expected_label');
    expect(() => validateProgrammaticCatalog({ ...catalog('cat8'), probes: [{ id: 'x', text: 'x', tier: 'maybe' }] }, 'cat8')).toThrow('tier');
    const value = catalog('cat9');
    if (value.category !== 'cat9') throw new Error('fixture');
    expect(() => validateProgrammaticCatalog({ ...value, scenarios: [{ ...value.scenarios[0], workflow: 'other' }] }, 'cat9')).toThrow('workflow');
    expect(() => validateProgrammaticCatalog({ ...value, scenarios: [{ ...value.scenarios[0], rubric: [{ id: 'r', criterion: 'x', weight: 0 }] }] }, 'cat9')).toThrow('weight');
    expect(() => validateProgrammaticCatalog({ ...value, enable_thresholds: true }, 'cat9')).toThrow('calibration_reference');
    expect(() => validateProgrammaticCatalog({ ...value, catalog_status: ['reviewed'] }, 'cat9')).toThrow('catalog_status');
  });
});

describe('safe programmatic admission and artifacts', () => {
  test('CLI defaults to validation and rejects ambiguous or accidental paid flags', () => {
    const args = ['--category', 'cat5', '--input', 'catalog.json', '--output', 'new-run'];
    expect(parseProgrammaticArgs(args).mode).toBe('validate');
    expect(() => parseProgrammaticArgs([...args, '--allow-paid'])).toThrow('require --live');
    expect(() => parseProgrammaticArgs([...args, '--category', 'cat9'])).toThrow('Duplicate');
    expect(() => parseProgrammaticArgs([...args, '--offline'])).toThrow('Unknown');
    expect(() => parseProgrammaticArgs(['--category', 'toString'])).toThrow('cat5');
    expect(() => parseProgrammaticArgs([...args, '--home', '/isolated/home'])).toThrow('supplied together');
  });

  test('validation and missing inputs never call injected clients or adapters', async () => {
    let calls = 0;
    const deps = dependencies({ agentClient: client(() => { calls++; throw new Error('unexpected'); }), createState: async () => { calls++; return inertState(); } });
    const options = inputs(catalog('cat8'));
    const validated = await runSituationRecallProgrammatic(options, deps);
    expect(validated.status).toBe('validated');
    expect(validated.publishable).toBe(false);
    expect(validated.exit_code).toBe(2);
    expect(loadReceipt(validated.receipt_path).run_status).toBe('skipped');
    const missing = await runSituationRecallProgrammatic({ ...options, inputPath: `${options.inputPath}.missing`, outputDir: `${options.outputDir}-missing`, mode: 'live', allowPaid: true }, deps);
    expect(missing.status).toBe('blocked');
    expect(calls).toBe(0);
  });

  test('the real CLI records missing input as blocked and exits nonzero', () => {
    const options = inputs(catalog('cat5'));
    const child = Bun.spawnSync([process.execPath, 'eval/runner/situation-recall-programmatic.ts', '--category', options.category, '--input', `${options.inputPath}.missing`, '--output', options.outputDir], {
      env: { PATH: process.env.PATH },
    });
    expect(child.exitCode).toBe(2);
    const result = JSON.parse(child.stdout.toString());
    expect(result.status).toBe('blocked');
    expect(result.publishable).toBe(false);
    expect(result.result_path).toBe(join(options.outputDir, 'result.json'));
    expect(loadReceipt(result.receipt_path).run_status).toBe('skipped');
  });

  test('live consent, budget and real-catalog guards precede paid execution', async () => {
    const value = { ...catalog('cat5'), catalog_status: 'reviewed' as const };
    const noConsent = await runSituationRecallProgrammatic({ ...inputs(value), mode: 'live' });
    expect(noConsent.reason).toContain('--allow-paid');
    const noBudget = await runSituationRecallProgrammatic({ ...inputs(value), mode: 'live', allowPaid: true });
    expect(noBudget.reason).toContain('externally enforced');
    const synthetic = await runSituationRecallProgrammatic({ ...inputs(catalog('cat5')), mode: 'live', allowPaid: true, maxUsd: 1, isolatedProviderBudgetReference: 'test-reference' });
    expect(synthetic.reason).toContain('reviewed real input');
    const unidentified = await runSituationRecallProgrammatic({ ...inputs(value), mode: 'live', allowPaid: true, maxUsd: 1, isolatedProviderBudgetReference: 'test-reference' });
    expect(unidentified.reason).toContain('--expected-product-sha');
    const injected = await runSituationRecallProgrammatic({ ...inputs(value), mode: 'live', allowPaid: true }, dependencies());
    expect(injected.reason).toContain('Injected dependencies');
  });

  test('offline mode cannot silently fall back to paid clients', async () => {
    const result = await runSituationRecallProgrammatic({ ...inputs(catalog('cat9')), mode: 'offline' }, { createState: async () => { throw new Error('must not run'); } });
    expect(result.status).toBe('blocked');
    expect(result.reason).toContain('agentClient');
  });

  test('refuses to overwrite a previous run directory', async () => {
    const options = inputs(catalog('cat5'));
    const first = await runSituationRecallProgrammatic(options);
    const original = readFileSync(first.receipt_path, 'utf8');
    await expect(runSituationRecallProgrammatic(options)).rejects.toThrow();
    expect(readFileSync(first.receipt_path, 'utf8')).toBe(original);
  });

  test('explicit isolation uses the public config path and rejects ignored overrides', async () => {
    const options = inputs(catalog('cat5'));
    const home = `${options.outputDir}-home`;
    const isolatedRuntime = { home, config: join(home, '.gbrain', 'config.json'), database: `${options.outputDir}-database` };
    let calls = 0;
    const judgeClient = client(() => {
      calls++;
      expect(configPath()).toBe(isolatedRuntime.config);
      expect(loadConfig()?.engine).toBe('pglite');
      return response([{ type: 'tool_use', name: 'classify_claim', input: { label: 'supported', rationale: 'Offline fixture.' } }]);
    });
    const valid = await runSituationRecallProgrammatic({ ...options, isolatedRuntime, mode: 'offline' }, { judgeClient });
    expect(valid.status).toBe('completed');
    expect(calls).toBe(1);
    const invalidOptions = inputs(catalog('cat5'));
    const invalid = await runSituationRecallProgrammatic({ ...invalidOptions, mode: 'offline', isolatedRuntime: {
      home: `${invalidOptions.outputDir}-home`, config: `${invalidOptions.outputDir}-ignored-config.json`, database: `${invalidOptions.outputDir}-database`,
    } }, { judgeClient });
    expect(invalid.status).toBe('blocked');
    expect(invalid.reason).toContain('public resolver');
    expect(calls).toBe(1);
  });
});

describe('native category routing and accounting, offline nonpublishable', () => {
  test('Cat5 routes claims plus source text to the existing blind classifier', async () => {
    let prompt = '';
    let stateCalls = 0;
    const result = await runSituationRecallProgrammatic({ ...inputs(catalog('cat5')), mode: 'offline' }, {
      judgeClient: client(request => { prompt = JSON.stringify(request); return response([{ type: 'tool_use', name: 'classify_claim', input: { label: 'supported', rationale: 'Test.' } }]); }),
      createState: async () => { stateCalls++; return inertState(); },
      disposeState: async () => {},
    });
    const report = result.report as Cat5Report;
    expect(stateCalls).toBe(0);
    expect(prompt).toContain('confirmed.');
    expect(prompt).toContain('fictional team meets after ten');
    expect(prompt).not.toContain('expected_label');
    expect(report.citation_accuracy).toBe(1);
    expect(report.per_claim[0].claim_id).toBe('claim-1');
    expect(report.verdict).toBe('baseline_only');
    expect(result.publishable).toBe(false);
    expect(loadReceipt(result.native_receipt_path).publishable).toBe(false);
    expect(loadReceipt(result.receipt_path).hashes?.catalog).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(readFileSync(result.result_path, 'utf8')).report).toEqual(report);
  });

  test('Cat5 dependency errors remain excluded errors, not replacement scores', async () => {
    const result = await runSituationRecallProgrammatic({ ...inputs(catalog('cat5')), mode: 'offline' }, { judgeClient: client(() => { throw new Error('Provider unavailable in fixture'); }) });
    const receipt = loadReceipt(result.receipt_path);
    expect(receipt.n_total).toBe(1);
    expect(receipt.n_scored).toBe(0);
    expect(receipt.errors[0].origin).toBe('dependency');
    expect(receipt.run_status).toBe('completed');
    expect(receipt.publishable).toBe(false);
    expect(result.exit_code).toBe(2);
  });

  test('even a native pass with enabled thresholds cannot publish injected results', async () => {
    const value = { ...catalog('cat5'), enable_thresholds: true, calibration_reference: 'offline-test-not-real-calibration' };
    const result = await runSituationRecallProgrammatic({ ...inputs(value), mode: 'offline' }, { judgeClient: client(() => response([{ type: 'tool_use', name: 'classify_claim', input: { label: 'supported', rationale: 'Offline.' } }])) });
    expect(result.report?.verdict).toBe('pass');
    expect(loadReceipt(result.receipt_path).verdict).toBe('pass');
    expect(loadReceipt(result.receipt_path).publishable).toBe(false);
    expect(loadReceipt(result.native_receipt_path).publishable).toBe(false);
    expect(result.exit_code).toBe(2);
  });

  test('Cat8 initializes sanitized corpus only, preserves SUT misses and tears down state', async () => {
    const value = catalog('cat8');
    value.pages[0].frontmatter = { _facts: 'gold sentinel' };
    let disposed = false;
    let initialized = false;
    const state = inertState();
    const result = await runSituationRecallProgrammatic({ ...inputs(value), mode: 'offline' }, dependencies({
      agentClient: agent(''),
      createState: async (pages, poison) => {
        initialized = true;
        expect(pages[0].frontmatter).toBeUndefined();
        expect(JSON.stringify(pages)).not.toContain('gold sentinel');
        expect(poison).toEqual([]);
        return state;
      },
      disposeState: async actual => { expect(actual).toBe(state); disposed = true; },
    }));
    const report = result.report as Cat8Report;
    expect(initialized && disposed).toBe(true);
    expect(report.total_probes).toBe(1);
    expect(report.scored_probes).toBe(1);
    expect(report.back_link_compliance).toBe(0);
    expect(report.citation_format).toBe(0);
    expect(report.per_probe[0].probe_id).toBe('probe-1');
    expect(report.errors).toEqual([]);
    expect(report.publishable).toBe(false);
  });

  test('Cat9 passes scenario rubrics and resolved evidence to the native judge', async () => {
    let seen = '';
    const result = await runSituationRecallProgrammatic({ ...inputs(catalog('cat9')), mode: 'offline' }, dependencies({ judgeClient: client(request => {
      seen = JSON.stringify(request);
      return response([{ type: 'tool_use', name: 'score_answer', input: { scores: [{ criterion_id: 'time', score: 0, rationale: 'Fixture failure.' }], verdict: 'fail', overall_rationale: 'Fixture failure.' } }]);
    }) }));
    const report = result.report as Cat9Report;
    expect(seen).toContain('Gives the recorded time');
    expect(seen).toContain('fictional team meets after ten');
    expect(report.total_scenarios).toBe(1);
    expect(report.scored_scenarios).toBe(1);
    expect(report.overall_pass_rate).toBe(0);
    expect(report.per_scenario[0].scenario_id).toBe('scenario-1');
    expect(report.errors).toEqual([]);
    expect(report.publishable).toBe(false);
  });

  test('Cat9 judge failures retain the native error denominator', async () => {
    const result = await runSituationRecallProgrammatic({ ...inputs(catalog('cat9')), mode: 'offline' }, dependencies({ judgeClient: client(() => response([])) }));
    expect((result.report as Cat9Report).scored_scenarios).toBe(0);
    expect(loadReceipt(result.receipt_path).errors[0].origin).toBe('judge');
    expect(result.exit_code).toBe(2);
  });

  test('adapter failures and teardown failures produce nonpassing receipts', async () => {
    const init = await runSituationRecallProgrammatic({ ...inputs(catalog('cat8')), mode: 'offline' }, dependencies({ createState: async () => { throw new Error('Init failed'); } }));
    expect(init.status).toBe('error');
    expect(loadReceipt(init.receipt_path).errors[0].origin).toBe('harness');
    const teardown = await runSituationRecallProgrammatic({ ...inputs(catalog('cat8')), mode: 'offline' }, dependencies({ disposeState: async () => { throw new Error('Teardown failed'); } }));
    expect(teardown.status).toBe('error');
    expect(loadReceipt(teardown.receipt_path).run_status).toBe('error');
    expect(teardown.report).toBeDefined();
    expect(teardown.publishable).toBe(false);
  });

  test('real adapter state serves corpus content through the production operation bridge', async () => {
    let calls = 0;
    let observedToolResult = '';
    const ambient = { GBRAIN_HOME: '/not-the-test-brain', GBRAIN_SRC: '/not-the-product', DATABASE_URL: 'not-a-database', OPENAI_API_KEY: 'offline-test-placeholder', ANTHROPIC_API_KEY: 'offline-test-placeholder' };
    const previous = Object.fromEntries(Object.keys(ambient).map(key => [key, process.env[key]]));
    const home = process.env.HOME;
    Object.assign(process.env, ambient);
    let result;
    try {
      result = await runSituationRecallProgrammatic({ ...inputs(catalog('cat8')), mode: 'offline' }, { agentClient: client(request => {
        expect(process.env.HOME).not.toBe(home);
        expect(process.env.GBRAIN_HOME).toBe(process.env.HOME);
        expect(configPath()).toBe(join(process.env.HOME!, '.gbrain', 'config.json'));
        expect(loadConfig()?.engine).toBe('pglite');
        expect(process.env.DATABASE_URL).toBeUndefined();
        expect(process.env.GBRAIN_SRC).toBeUndefined();
        expect(process.env.OPENAI_API_KEY).toBeUndefined();
        expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
        if (calls++ === 0) return response([{ type: 'tool_use', id: 'read-corpus', name: 'get_page', input: { slug: 'notes/fictional' } }], 'tool_use');
        observedToolResult = JSON.stringify((request.messages as unknown[]).at(-1));
        return response([{ type: 'text', text: 'The fictional team meets after ten. See `notes/fictional`.' }]);
      }) });
      expect(process.env.HOME).toBe(home);
      for (const [key, value] of Object.entries(ambient)) expect(process.env[key]).toBe(value);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(result.status).toBe('completed');
    expect(calls).toBe(2);
    expect(observedToolResult).toContain('fictional team meets after ten');
    expect((result.report as Cat8Report).brain_first_compliance).toBe(1);
    const receipt = loadReceipt(result.receipt_path);
    expect(receipt.resolved_config?.search_config).toMatchObject({ 'search.reranker.enabled': 'false', 'memory.cues.read': 'off' });
    expect(receipt.resolved_config?.feature_exposure).toBe('candidate_off_only');
    expect(receipt.resolved_config?.isolated_runtime).toMatchObject({ engine: 'fresh in-memory PGLite', approved_provider_keys: [] });
    expect(receipt.publishable).toBe(false);
  }, 60_000);
});
