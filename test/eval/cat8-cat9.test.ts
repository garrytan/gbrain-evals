/**
 * Cat 8 + Cat 9 runner tests — Day 8 of BrainBench v1 Complete.
 *
 * Uses stubbed Sonnet (agent) + Haiku (judge) clients. No real LLM calls,
 * no PGLite engine initialization — tests the scoring and aggregation
 * layers over synthetic agent run results.
 *
 * Covers:
 *   - Cat 8 per-metric scorers (brain_first, back_link, citation_format, tier_escalation)
 *   - Cat 8 no-answer probes are NOT vacuously compliant (regression for
 *     audit agentic-cats-08 — previously an unfailable gate)
 *   - Cat 8 simple-tier over-tooling fails tier_escalation (agentic-cats-19)
 *   - Cat 8 runCat8 end-to-end: probe accounting + receipt + bundle
 *   - Cat 9 buildEvidence contract shape (no raw tool_result text,
 *     assertNoRawToolOutput clean)
 *   - Cat 9 buildEvidence FAILS LOUDLY on unresolvable gold slugs
 *     (regression for agentic-cats-09 — previously silently dropped)
 *   - Cat 9 runCat9 end-to-end with stubbed agent + judge + receipt
 *   - Cat 9 judge_failed is a typed 'judge' error, never scored as fail
 *   - Cat 9 per-workflow rollup
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Anthropic from '@anthropic-ai/sdk';
import type { AgentRunResult } from '../../eval/runner/adapters/claude-sonnet-with-tools.ts';
import type { ToolBridgeState } from '../../eval/runner/tool-bridge.ts';
import {
  scoreBrainFirst,
  scoreBackLinkCompliance,
  scoreCitationFormat,
  scoreTierEscalation,
  finalAnswerCiteCount,
  runCat8,
  CAT8_CATEGORY,
  type SkillComplianceProbe,
} from '../../eval/runner/cat8-skill-compliance.ts';
import {
  buildEvidence,
  GroundTruthResolutionError,
  CAT9_CATEGORY,
  type WorkflowScenario,
} from '../../eval/runner/cat9-workflows.ts';
import { assertNoRawToolOutput, type GroundTruthPage } from '../../eval/runner/judge.ts';
import { loadReceipt, receiptPath } from '../../eval/runner/receipt.ts';

function tmpReportsRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ─── Mock AgentRunResult builder ──────────────────────────────────────

function mockRunResult(overrides: Partial<AgentRunResult> & {
  brainCalls?: number;
  writes?: Array<{
    tool_name: 'dry_run_put_page' | 'dry_run_add_link' | 'dry_run_add_timeline_entry';
    slug?: string;
    has_back_links?: boolean;
    citation_format_ok?: boolean;
  }>;
  poisonHits?: string[];
  finalAnswer?: string;
  evidenceRefs?: string[];
}): AgentRunResult {
  const {
    brainCalls = 0,
    writes = [],
    poisonHits = [],
    // Default is an ANSWERING run (stop_reason end_turn + non-empty text):
    // the no-answer regression tests set final_answer/stop_reason explicitly.
    finalAnswer = 'Done. Recorded.',
    evidenceRefs = [],
    ...rest
  } = overrides;

  const count_by_tool: Record<string, number> = {};
  if (brainCalls > 0) count_by_tool.search = brainCalls;
  for (const w of writes) {
    count_by_tool[w.tool_name] = (count_by_tool[w.tool_name] ?? 0) + 1;
  }

  const state: ToolBridgeState = {
    count_by_tool,
    call_order: [
      ...Array(brainCalls).fill('search'),
      ...writes.map(w => w.tool_name),
    ],
    made_dry_run_writes: writes.map(w => ({
      tool_name: w.tool_name,
      input: {},
      ts: '2026-04-20T00:00:00Z',
      slug: w.slug,
      has_back_links: w.has_back_links,
      citation_format_ok: w.citation_format_ok,
    })),
    saw_poison_items: poisonHits,
  };

  return {
    transcript: {
      schema_version: 1,
      probe_id: 'p1',
      adapter: { name: 'claude-sonnet-with-tools', stack_id: 'gbrain' },
      started_at: '2026-04-20T00:00:00Z',
      ended_at: '2026-04-20T00:00:01Z',
      turns: [],
      total_input_tokens: 100,
      total_output_tokens: 50,
      elapsed_ms: 1000,
    },
    final_answer: finalAnswer,
    evidence_refs: evidenceRefs,
    tool_bridge_state: state,
    brain_first_ordering: brainCalls > 0 ? 'brain_before_answer' : 'no_brain_calls',
    stop_reason: 'end_turn',
    total_input_tokens: 100,
    total_output_tokens: 50,
    total_cost_usd: 0.01,
    ...rest,
  };
}

// ─── Cat 8 per-metric scorers ────────────────────────────────────────

describe('Cat 8 scoreBrainFirst', () => {
  test('compliant when brain_before_answer', () => {
    const r = mockRunResult({ brainCalls: 2 });
    r.brain_first_ordering = 'brain_before_answer';
    expect(scoreBrainFirst(r)).toBe(true);
  });

  test('non-compliant when no_brain_calls', () => {
    const r = mockRunResult({});
    r.brain_first_ordering = 'no_brain_calls';
    expect(scoreBrainFirst(r)).toBe(false);
  });

  test('non-compliant when answer_before_brain', () => {
    const r = mockRunResult({ brainCalls: 1 });
    r.brain_first_ordering = 'answer_before_brain';
    expect(scoreBrainFirst(r)).toBe(false);
  });
});

describe('Cat 8 scoreBackLinkCompliance', () => {
  test('vacuously true when no dry_run writes (answering run)', () => {
    expect(scoreBackLinkCompliance(mockRunResult({}))).toBe(true);
  });

  test('true when all put_page writes have back_links', () => {
    const r = mockRunResult({
      writes: [
        { tool_name: 'dry_run_put_page', slug: 'people/x', has_back_links: true, citation_format_ok: true },
      ],
    });
    expect(scoreBackLinkCompliance(r)).toBe(true);
  });

  test('false when any put_page write has has_back_links=false', () => {
    const r = mockRunResult({
      writes: [
        { tool_name: 'dry_run_put_page', slug: 'people/x', has_back_links: true, citation_format_ok: true },
        { tool_name: 'dry_run_put_page', slug: 'people/y', has_back_links: false, citation_format_ok: true },
      ],
    });
    expect(scoreBackLinkCompliance(r)).toBe(false);
  });

  test('add_link writes are always back-link compliant (by definition)', () => {
    const r = mockRunResult({
      writes: [{ tool_name: 'dry_run_add_link', has_back_links: false, citation_format_ok: true }],
    });
    expect(scoreBackLinkCompliance(r)).toBe(true);
  });
});

describe('Cat 8 scoreCitationFormat', () => {
  test('short final answers skip the citation requirement', () => {
    const r = mockRunResult({ finalAnswer: 'I do not know.' });
    expect(scoreCitationFormat(r)).toBe(true);
  });

  test('long final answer without any slug citation is non-compliant', () => {
    const text =
      'Amara Okafor is a Partner at Halfway Capital and has been working in venture for several years now. ' +
      'She focuses primarily on climate and AI infrastructure investments at the seed and Series A stages.';
    const r = mockRunResult({ finalAnswer: text });
    expect(scoreCitationFormat(r)).toBe(false);
  });

  test('long final answer with markdown slug citation passes', () => {
    const text =
      'Amara Okafor is a Partner at Halfway Capital. ' +
      'She focuses on climate + AI infrastructure investments. See [Amara](people/amara-okafor) for background.';
    const r = mockRunResult({ finalAnswer: text });
    expect(scoreCitationFormat(r)).toBe(true);
  });

  test('write with bad citation_format_ok=false flags non-compliant', () => {
    const r = mockRunResult({
      writes: [
        { tool_name: 'dry_run_add_timeline_entry', citation_format_ok: false },
      ],
    });
    expect(scoreCitationFormat(r)).toBe(false);
  });
});

// Regression for audit agentic-cats-08: a probe that burned its turn cap
// and emitted nothing previously PASSED citation_format and
// back_link_compliance vacuously — the gates were unfailable for
// no-output runs. They must fail on no answer AND still pass on good input.
describe('Cat 8 no-answer probes are never vacuously compliant (agentic-cats-08)', () => {
  function noAnswerRun(extra: Parameters<typeof mockRunResult>[0] = {}): AgentRunResult {
    const r = mockRunResult({ brainCalls: 2, finalAnswer: '', ...extra });
    r.stop_reason = 'turn_cap_exceeded';
    r.brain_first_ordering = 'no_answer';
    return r;
  }

  test('turn-capped run with no writes fails back_link_compliance (was vacuous pass)', () => {
    expect(scoreBackLinkCompliance(noAnswerRun())).toBe(false);
  });

  test('turn-capped run with empty final answer fails citation_format (was vacuous pass)', () => {
    expect(scoreCitationFormat(noAnswerRun())).toBe(false);
  });

  test('end_turn with EMPTY final answer also counts as no answer', () => {
    const r = mockRunResult({ brainCalls: 1, finalAnswer: '' });
    expect(scoreBackLinkCompliance(r)).toBe(false);
    expect(scoreCitationFormat(r)).toBe(false);
  });

  test('good input still passes both metrics', () => {
    const r = mockRunResult({
      brainCalls: 1,
      finalAnswer: 'Amara is a Partner. Source: `people/amara`.',
      writes: [
        { tool_name: 'dry_run_put_page', slug: 'people/x', has_back_links: true, citation_format_ok: true },
      ],
    });
    expect(scoreBackLinkCompliance(r)).toBe(true);
    expect(scoreCitationFormat(r)).toBe(true);
  });
});

describe('Cat 8 scoreTierEscalation', () => {
  const simpleProbe: SkillComplianceProbe = { id: 'p1', text: 'x', tier: 'simple' };
  const complexProbe: SkillComplianceProbe = { id: 'p2', text: 'x', tier: 'complex' };
  const writeyProbe: SkillComplianceProbe = {
    id: 'p3',
    text: 'x',
    tier: 'complex',
    expects_dry_run_write: true,
  };

  test('simple probe passes with 1-2 brain calls and no writes', () => {
    expect(scoreTierEscalation(simpleProbe, mockRunResult({ brainCalls: 1 }))).toBe(true);
    expect(scoreTierEscalation(simpleProbe, mockRunResult({ brainCalls: 2 }))).toBe(true);
  });

  test('simple probe fails with 0 brain calls', () => {
    expect(scoreTierEscalation(simpleProbe, mockRunResult({}))).toBe(false);
  });

  // Regression for audit agentic-cats-19: the simple tier previously had no
  // upper bound, so over-tooling could never fail the metric.
  test('simple probe fails on over-tooling: >2 brain calls (was unfailable)', () => {
    expect(scoreTierEscalation(simpleProbe, mockRunResult({ brainCalls: 3 }))).toBe(false);
    expect(scoreTierEscalation(simpleProbe, mockRunResult({ brainCalls: 40 }))).toBe(false);
  });

  test('simple probe fails when it performs dry_run writes (was unfailable)', () => {
    expect(
      scoreTierEscalation(
        simpleProbe,
        mockRunResult({
          brainCalls: 1,
          writes: [{ tool_name: 'dry_run_put_page', has_back_links: true, citation_format_ok: true }],
        }),
      ),
    ).toBe(false);
  });

  test('complex probe requires ≥2 brain calls when no write expected', () => {
    expect(scoreTierEscalation(complexProbe, mockRunResult({ brainCalls: 1 }))).toBe(false);
    expect(scoreTierEscalation(complexProbe, mockRunResult({ brainCalls: 2 }))).toBe(true);
  });

  test('complex + expects_dry_run_write requires brain call + write', () => {
    expect(scoreTierEscalation(writeyProbe, mockRunResult({ brainCalls: 1 }))).toBe(false);
    expect(
      scoreTierEscalation(
        writeyProbe,
        mockRunResult({
          brainCalls: 1,
          writes: [{ tool_name: 'dry_run_put_page', has_back_links: true, citation_format_ok: true }],
        }),
      ),
    ).toBe(true);
  });
});

describe('Cat 8 finalAnswerCiteCount', () => {
  test('counts unique slugs across markdown + backtick syntax', () => {
    const text =
      'See [Amara](people/amara) and `people/amara` and [Halfway](companies/halfway).';
    expect(finalAnswerCiteCount(text)).toBe(2);
  });

  test('returns 0 on text with no slug references', () => {
    expect(finalAnswerCiteCount('no slugs here at all.')).toBe(0);
  });
});

// ─── Cat 9 buildEvidence ──────────────────────────────────────────────

describe('Cat 9 buildEvidence', () => {
  const SCENARIO: WorkflowScenario = {
    id: 's1',
    workflow: 'briefing',
    text: 'Give me a briefing',
    ground_truth_slugs: ['people/amara', 'companies/halfway'],
    rubric: [{ id: 'names_person', criterion: 'Names Amara', weight: 1 }],
  };

  const PAGES = new Map<string, GroundTruthPage>([
    ['people/amara', { slug: 'people/amara', title: 'Amara', content: 'Partner.' }],
    ['companies/halfway', { slug: 'companies/halfway', title: 'Halfway', content: 'VC firm.' }],
  ]);

  test('resolves ground_truth_slugs to full pages', () => {
    const run = mockRunResult({ brainCalls: 1, finalAnswer: 'Amara is a Partner.' });
    run.brain_first_ordering = 'brain_before_answer';
    const evidence = buildEvidence(SCENARIO, run, PAGES);
    expect(evidence.ground_truth_pages.length).toBe(2);
    expect(evidence.ground_truth_pages[0].content).toBe('Partner.');
  });

  // Regression for audit agentic-cats-09: unresolvable gold slugs were
  // silently dropped, shrinking the judge's world-of-facts so it scored
  // correct answers as hallucinations. Now: fail loudly.
  test('throws GroundTruthResolutionError on unresolvable gold slugs (was silent drop)', () => {
    const scenarioWithGhost: WorkflowScenario = {
      ...SCENARIO,
      ground_truth_slugs: ['people/amara', 'people/ghost'],
    };
    let err: unknown = null;
    try {
      buildEvidence(scenarioWithGhost, mockRunResult({}), PAGES);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GroundTruthResolutionError);
    expect((err as GroundTruthResolutionError).missingSlugs).toEqual(['people/ghost']);
    expect((err as Error).message).toContain('people/ghost');
  });

  test('fully-resolvable gold slugs still build evidence (good input passes)', () => {
    const evidence = buildEvidence(SCENARIO, mockRunResult({}), PAGES);
    expect(evidence.ground_truth_pages.length).toBe(2);
  });

  test("'no_answer' ordering passes through to the judge summary as a first-class label", () => {
    // judge.ts ToolCallSummary + evidence-contract schema both carry
    // 'no_answer' now — the judge should see that the run produced no
    // final answer, never a mislabel and never a silent omission.
    const run = mockRunResult({ brainCalls: 2, finalAnswer: '' });
    run.stop_reason = 'turn_cap_exceeded';
    run.brain_first_ordering = 'no_answer';
    const evidence = buildEvidence(SCENARIO, run, PAGES);
    expect(evidence.tool_call_summary.brain_first_ordering).toBe('no_answer');
    expect(evidence.final_answer_text).toBe('');
  });

  test('assertNoRawToolOutput is clean on real buildEvidence output', () => {
    const run = mockRunResult({
      brainCalls: 2,
      poisonHits: ['poison-001'],
      writes: [
        { tool_name: 'dry_run_put_page', slug: 'people/jane', has_back_links: true, citation_format_ok: true },
      ],
      finalAnswer: 'See [Amara](people/amara).',
    });
    const evidence = buildEvidence(SCENARIO, run, PAGES);
    // The strict judge-input contract check: no raw tool_result content can
    // reach the judge (prompt-injection defense). Must be empty.
    expect(assertNoRawToolOutput(evidence)).toEqual([]);
  });

  test('includes tool_call_summary without raw tool_result content', () => {
    const run = mockRunResult({
      brainCalls: 3,
      poisonHits: ['poison-001'],
      writes: [
        { tool_name: 'dry_run_put_page', slug: 'people/jane', has_back_links: true, citation_format_ok: true },
      ],
    });
    run.brain_first_ordering = 'brain_before_answer';
    const evidence = buildEvidence(SCENARIO, run, PAGES);
    expect(evidence.tool_call_summary.count_by_tool.search).toBe(3);
    expect(evidence.tool_call_summary.saw_poison_items).toEqual(['poison-001']);
    expect(evidence.tool_call_summary.brain_first_ordering).toBe('brain_before_answer');
    expect(evidence.tool_call_summary.made_dry_run_writes[0].slug).toBe('people/jane');
    // CRITICAL: the evidence contract must NOT carry a raw tool_result or
    // raw_content field. assertNoRawToolOutput from judge.ts is the strict
    // check; here we just spot-check.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect('tool_result' in (evidence as any)).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect('raw_transcript' in (evidence as any)).toBe(false);
  });

  test('final_answer_text + evidence_refs flow from agent run', () => {
    const run = mockRunResult({
      finalAnswer: 'See [Amara](people/amara).',
      evidenceRefs: ['people/amara'],
    });
    const evidence = buildEvidence(SCENARIO, run, PAGES);
    expect(evidence.final_answer_text).toBe('See [Amara](people/amara).');
    expect(evidence.evidence_refs).toEqual(['people/amara']);
  });
});

// ─── Cat 9 runCat9 end-to-end ─────────────────────────────────────────

describe('Cat 9 runCat9 integration', () => {
  // Stub clients for agent + judge.
  function makeAgentClient(): Anthropic {
    return {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: 'Amara Okafor is a Partner at [Halfway](companies/halfway).' }],
          usage: { input_tokens: 100, output_tokens: 40 },
          stop_reason: 'end_turn',
        }),
      },
    } as unknown as Anthropic;
  }

  function makeJudgeClient(verdict: 'pass' | 'partial' | 'fail' = 'pass'): Anthropic {
    return {
      messages: {
        create: async () => ({
          content: [
            {
              type: 'tool_use',
              id: 'x',
              name: 'score_answer',
              input: {
                scores: [
                  { criterion_id: 'names_person', score: verdict === 'pass' ? 5 : 1, rationale: '.' },
                ],
                verdict,
                overall_rationale: 'ok',
              },
            },
          ],
          usage: { input_tokens: 500, output_tokens: 100 },
        }),
      },
    } as unknown as Anthropic;
  }

  test('end-to-end agent+judge run produces per_workflow rollup', async () => {
    // We need an AgentAdapterState but the stub agent never hits the engine
    // since its response has stop_reason=end_turn and no tool_use blocks.
    // Provide a no-op state.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state: any = { engine: {}, poisonFixtures: [] };

    const scenarios: WorkflowScenario[] = [
      {
        id: 's-briefing-1',
        workflow: 'briefing',
        text: 'Give me a briefing',
        ground_truth_slugs: ['companies/halfway'],
        rubric: [{ id: 'names_person', criterion: 'Names Amara', weight: 1 }],
      },
      {
        id: 's-sync-1',
        workflow: 'sync',
        text: 'Sync my brain',
        ground_truth_slugs: ['companies/halfway'],
        rubric: [{ id: 'names_person', criterion: 'Names Amara', weight: 1 }],
      },
    ];
    const pages = new Map<string, GroundTruthPage>([
      ['companies/halfway', { slug: 'companies/halfway', title: 'Halfway', content: 'VC firm.' }],
    ]);

    const reportsRoot = tmpReportsRoot('cat9-e2e-');
    const { runCat9 } = await import('../../eval/runner/cat9-workflows.ts');
    const report = await runCat9({
      scenarios,
      state,
      pagesBySlug: pages,
      agentClient: makeAgentClient(),
      judgeClient: makeJudgeClient('pass'),
      concurrency: 1,
      reportsRoot,
    });

    expect(report.total_scenarios).toBe(2);
    expect(report.scored_scenarios).toBe(2);
    expect(report.overall_pass_rate).toBe(1);
    expect(report.per_workflow.find(w => w.workflow === 'briefing')!.pass_rate).toBe(1);
    expect(report.per_workflow.find(w => w.workflow === 'sync')!.pass_rate).toBe(1);
    expect(report.verdict).toBe('baseline_only');
    expect(report.errors).toEqual([]);

    // Receipt written + valid (shared contract).
    const receipt = loadReceipt(receiptPath(CAT9_CATEGORY, reportsRoot));
    expect(receipt.run_status).toBe('completed');
    expect(receipt.verdict).toBe('partial'); // baseline_only → partial (no real gate yet)
    expect(receipt.n_total).toBe(2);
    expect(receipt.n_scored).toBe(2);
    expect(receipt.judge).toEqual({ model: 'claude-haiku-4-5-20251001', temperature: 0 });
    // WS5: search config provenance recorded (stub state built outside adapter.init).
    expect(receipt.resolved_config!.search_config).toContain('not_pinned');

    // Flight-recorder bundle emitted (agentic-cats-17): transcripts + judge notes.
    const bundleDirs = readdirSync(reportsRoot).filter(d => d.includes('-cat9-'));
    expect(bundleDirs.length).toBe(1);
    const bundleFiles = readdirSync(join(reportsRoot, bundleDirs[0]));
    expect(bundleFiles).toContain('transcript.md');
    expect(bundleFiles).toContain('scorecard.json');
    expect(bundleFiles).toContain('judge-notes.md');
  });

  test('mixed verdicts produce a fractional pass rate', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state: any = { engine: {}, poisonFixtures: [] };
    const scenarios: WorkflowScenario[] = [
      { id: 's1', workflow: 'briefing', text: 't', ground_truth_slugs: [], rubric: [{ id: 'c', criterion: 'x', weight: 1 }] },
      { id: 's2', workflow: 'briefing', text: 't', ground_truth_slugs: [], rubric: [{ id: 'c', criterion: 'x', weight: 1 }] },
    ];
    // Alternating pass/fail verdicts — make judge client return different responses per call
    let call = 0;
    const mixedJudge = {
      messages: {
        create: async () => {
          const v = call++ === 0 ? 'pass' : 'fail';
          return {
            content: [
              {
                type: 'tool_use',
                id: 'x',
                name: 'score_answer',
                input: {
                  scores: [{ criterion_id: 'c', score: v === 'pass' ? 5 : 0, rationale: '.' }],
                  verdict: v,
                  overall_rationale: '.',
                },
              },
            ],
            usage: { input_tokens: 100, output_tokens: 20 },
          };
        },
      },
    } as unknown as Anthropic;
    const { runCat9 } = await import('../../eval/runner/cat9-workflows.ts');
    const report = await runCat9({
      scenarios,
      state,
      pagesBySlug: new Map(),
      agentClient: makeAgentClient(),
      judgeClient: mixedJudge,
      concurrency: 1, // sequential so call order is deterministic
      reportsRoot: tmpReportsRoot('cat9-mixed-'),
    });
    expect(report.overall_pass_rate).toBe(0.5);
  });

  // Regression for audit agentic-cats-09 at the runner level: a gold slug
  // that cannot be resolved is a loud HARNESS error, excluded from pass
  // rates — the judge never scores against a silently-shrunken world.
  test('unresolvable gold slug → harness error in accounting, scenario excluded', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state: any = { engine: {}, poisonFixtures: [] };
    const scenarios: WorkflowScenario[] = [
      {
        id: 's-good',
        workflow: 'briefing',
        text: 'Give me a briefing',
        ground_truth_slugs: ['companies/halfway'],
        rubric: [{ id: 'names_person', criterion: 'Names Amara', weight: 1 }],
      },
      {
        id: 's-ghost',
        workflow: 'briefing',
        text: 'Prep me',
        ground_truth_slugs: ['people/does-not-exist'],
        rubric: [{ id: 'names_person', criterion: 'Names Amara', weight: 1 }],
      },
    ];
    const pages = new Map<string, GroundTruthPage>([
      ['companies/halfway', { slug: 'companies/halfway', title: 'Halfway', content: 'VC firm.' }],
    ]);

    const reportsRoot = tmpReportsRoot('cat9-ghost-');
    const { runCat9 } = await import('../../eval/runner/cat9-workflows.ts');
    const report = await runCat9({
      scenarios,
      state,
      pagesBySlug: pages,
      agentClient: makeAgentClient(),
      judgeClient: makeJudgeClient('pass'),
      concurrency: 1,
      reportsRoot,
    });

    expect(report.total_scenarios).toBe(2);
    expect(report.scored_scenarios).toBe(1); // ghost scenario excluded, not scored as fail
    expect(report.overall_pass_rate).toBe(1); // the good scenario passed
    expect(report.errors.length).toBe(1);
    expect(report.errors[0].origin).toBe('harness');
    expect(report.errors[0].probe_id).toBe('s-ghost');
    expect(report.errors[0].message).toContain('people/does-not-exist');

    // Smoke-sized run with an infra error is never publishable.
    const receipt = loadReceipt(receiptPath(CAT9_CATEGORY, reportsRoot));
    expect(receipt.publishable).toBe(false);
    expect(receipt.errors.length).toBe(1);
  });

  // WS0: judge_failed is a typed 'judge' error — excluded + capped, never
  // averaged in as a fail.
  test('judge_failed verdict → judge error, excluded from pass rates', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state: any = { engine: {}, poisonFixtures: [] };
    const scenarios: WorkflowScenario[] = [
      { id: 's1', workflow: 'sync', text: 't', ground_truth_slugs: [], rubric: [{ id: 'c', criterion: 'x', weight: 1 }] },
      { id: 's2', workflow: 'sync', text: 't', ground_truth_slugs: [], rubric: [{ id: 'c', criterion: 'x', weight: 1 }] },
    ];
    // First scenario judged pass; second scenario's judge returns malformed
    // output on BOTH attempts → judge_failed.
    let call = 0;
    const flakyJudge = {
      messages: {
        create: async () => {
          call++;
          if (call === 1) {
            return {
              content: [
                {
                  type: 'tool_use', id: 'x', name: 'score_answer',
                  input: { scores: [{ criterion_id: 'c', score: 5, rationale: '.' }], verdict: 'pass', overall_rationale: '.' },
                },
              ],
              usage: { input_tokens: 100, output_tokens: 20 },
            };
          }
          return { content: [{ type: 'text', text: 'no tool use' }], usage: { input_tokens: 100, output_tokens: 20 } };
        },
      },
    } as unknown as Anthropic;

    const { runCat9 } = await import('../../eval/runner/cat9-workflows.ts');
    const report = await runCat9({
      scenarios,
      state,
      pagesBySlug: new Map(),
      agentClient: makeAgentClient(),
      judgeClient: flakyJudge,
      concurrency: 1,
      reportsRoot: tmpReportsRoot('cat9-judge-'),
    });

    expect(report.scored_scenarios).toBe(1);
    // The judge-failed scenario must NOT deflate the pass rate to 0.5.
    expect(report.overall_pass_rate).toBe(1);
    expect(report.errors.length).toBe(1);
    expect(report.errors[0].origin).toBe('judge');
    expect(report.errors[0].probe_id).toBe('s2');
  });
});

// ─── Cat 8 runCat8 end-to-end ─────────────────────────────────────────

describe('Cat 8 runCat8 integration', () => {
  function makeCat8AgentClient(finalText: string): Anthropic {
    return {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: finalText }],
          usage: { input_tokens: 100, output_tokens: 40 },
          stop_reason: 'end_turn',
        }),
      },
    } as unknown as Anthropic;
  }

  test('runCat8 scores probes, writes a valid receipt and a transcript bundle', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state: any = { engine: {}, poisonFixtures: [] };
    const probes: SkillComplianceProbe[] = [
      { id: 'sig-0001', text: 'Who is Amara?', tier: 'simple' },
      { id: 'sig-0002', text: 'Who is Jordan?', tier: 'simple' },
    ];
    const reportsRoot = tmpReportsRoot('cat8-e2e-');
    const report = await runCat8({
      probes,
      state,
      client: makeCat8AgentClient('Amara is a Partner. Source: `people/amara`.'),
      concurrency: 1,
      reportsRoot,
    });

    expect(report.total_probes).toBe(2);
    expect(report.scored_probes).toBe(2);
    expect(report.verdict).toBe('baseline_only');
    // The stub agent answered without any brain call → brain_first fails.
    expect(report.brain_first_compliance).toBe(0);
    expect(report.errors).toEqual([]);

    const receipt = loadReceipt(receiptPath(CAT8_CATEGORY, reportsRoot));
    expect(receipt.run_status).toBe('completed');
    expect(receipt.verdict).toBe('partial'); // baseline_only → partial
    expect(receipt.n_total).toBe(2);
    expect(receipt.n_scored).toBe(2);
    expect(receipt.gbrain_version).not.toBe('');

    const bundleDirs = readdirSync(reportsRoot).filter(d => d.includes('-cat8-'));
    expect(bundleDirs.length).toBe(1);
    expect(readdirSync(join(reportsRoot, bundleDirs[0]))).toContain('transcript.md');
  });

  test('a probe whose agent loop throws is a typed infra error, not a run-killer', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state: any = { engine: {}, poisonFixtures: [] };
    const probes: SkillComplianceProbe[] = [
      { id: 'sig-ok', text: 'Who is Amara?', tier: 'simple' },
      { id: 'sig-boom', text: 'explode', tier: 'simple' },
    ];
    let call = 0;
    const flakyClient = {
      messages: {
        create: async () => {
          call++;
          if (call === 2) throw new Error('harness stub exploded');
          return {
            content: [{ type: 'text', text: 'Amara is a Partner. Source: `people/amara`.' }],
            usage: { input_tokens: 100, output_tokens: 40 },
            stop_reason: 'end_turn',
          };
        },
      },
    } as unknown as Anthropic;

    const reportsRoot = tmpReportsRoot('cat8-boom-');
    const report = await runCat8({
      probes,
      state,
      client: flakyClient,
      concurrency: 1, // sequential: call 2 = second probe
      reportsRoot,
    });

    // Previously this rejected Promise.all and destroyed the whole run.
    expect(report.total_probes).toBe(2);
    expect(report.scored_probes).toBe(1);
    expect(report.errors.length).toBe(1);
    expect(report.errors[0].probe_id).toBe('sig-boom');
    expect(report.errors[0].origin).toBe('harness');

    const receipt = loadReceipt(receiptPath(CAT8_CATEGORY, reportsRoot));
    expect(receipt.publishable).toBe(false); // smoke run with an infra error
  });
});
