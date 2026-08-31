/**
 * cat5-provenance.ts tests — Day 7 of BrainBench v1 Complete.
 *
 * Uses a stubbed Haiku client (no real LLM calls). Covers:
 *   - classifyClaim happy path: well-formed classify_claim → ClaimScore
 *   - Retry once on malformed → fallback to judge_failed
 *   - BLIND CLASSIFICATION (regression for audit agentic-cats-02 /
 *     tests-audit-04): the prompt never contains the gold label, the
 *     empty-sources note carries no verdict hint, and every claim's
 *     classifier context includes its own source_page (label-independent)
 *   - Gold drift fails loudly: unresolvable slugs are harness errors
 *   - aggregate computes citation_accuracy over classified claims only
 *     (judge_failed excluded from the denominator, never scored 0)
 *   - runCat5 writes a valid receipt (probe accounting + typed errors)
 *   - Verdict is baseline_only by default (no threshold gating in v1)
 *   - Verdict flips to pass/fail when enableThreshold=true
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Anthropic from '@anthropic-ai/sdk';
import {
  classifyClaim,
  aggregate,
  runCat5,
  renderClaimPrompt,
  parseClassification,
  resolveClaimSources,
  CLASSIFY_CLAIM_TOOL,
  CAT5_CATEGORY,
  type Claim,
  type GroundTruthPage,
  type ClaimScore,
} from '../../eval/runner/cat5-provenance.ts';
import { loadReceipt, receiptPath } from '../../eval/runner/receipt.ts';

function tmpReportsRoot(): string {
  return mkdtempSync(join(tmpdir(), 'cat5-test-'));
}

// ─── Stub client ──────────────────────────────────────────────────────

type StubContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

type StubResponse = {
  content: StubContent[];
  usage: { input_tokens: number; output_tokens: number };
};

function stubClient(responses: StubResponse[]): Anthropic {
  let i = 0;
  return {
    messages: {
      create: async () => {
        if (i >= responses.length) throw new Error('stub: out of responses');
        return responses[i++] as Anthropic.Messages.Message;
      },
    },
  } as unknown as Anthropic;
}

function classifyResp(
  label: 'supported' | 'unsupported' | 'over-generalized',
  rationale: string = 'stub rationale',
): StubResponse {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'x',
        name: 'classify_claim',
        input: { label, rationale },
      },
    ],
    usage: { input_tokens: 500, output_tokens: 50 },
  };
}

function malformedResp(): StubResponse {
  return {
    content: [{ type: 'text', text: 'cannot decide' }],
    usage: { input_tokens: 500, output_tokens: 30 },
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────────

const SAMPLE_CLAIM: Claim = {
  id: 'claim-001',
  source_page: 'people/amara',
  claim_text: 'Amara Okafor is a Partner at Halfway Capital.',
  expected_label: 'supported',
  expected_evidence: ['people/amara', 'companies/halfway'],
};

const SAMPLE_PAGES: GroundTruthPage[] = [
  {
    slug: 'people/amara',
    title: 'Amara Okafor',
    content: 'Amara Okafor joined Halfway Capital as a Partner in 2024.',
  },
  {
    slug: 'companies/halfway',
    title: 'Halfway Capital',
    content: 'Halfway Capital is a seed-stage venture firm.',
  },
];

// ─── classifyClaim ────────────────────────────────────────────────────

describe('classifyClaim — happy path', () => {
  test('parses supported label correctly', async () => {
    const client = stubClient([classifyResp('supported', 'directly stated in source')]);
    const result = await classifyClaim(SAMPLE_CLAIM, SAMPLE_PAGES, { client });
    expect(result.predicted_label).toBe('supported');
    expect(result.expected_label).toBe('supported');
    expect(result.matches_expected).toBe(true);
    expect(result.judge_rationale).toBe('directly stated in source');
    expect(result.fallback_used).toBe(false);
  });

  test('parses unsupported label correctly', async () => {
    const client = stubClient([classifyResp('unsupported')]);
    const result = await classifyClaim(
      { ...SAMPLE_CLAIM, expected_label: 'unsupported' },
      SAMPLE_PAGES,
      { client },
    );
    expect(result.predicted_label).toBe('unsupported');
    expect(result.matches_expected).toBe(true);
  });

  test('parses over-generalized label correctly', async () => {
    const client = stubClient([classifyResp('over-generalized')]);
    const result = await classifyClaim(
      { ...SAMPLE_CLAIM, expected_label: 'over-generalized' },
      SAMPLE_PAGES,
      { client },
    );
    expect(result.predicted_label).toBe('over-generalized');
    expect(result.matches_expected).toBe(true);
  });

  test('matches_expected=false when predicted differs from expected', async () => {
    const client = stubClient([classifyResp('unsupported')]);
    const result = await classifyClaim(SAMPLE_CLAIM, SAMPLE_PAGES, { client });
    expect(result.predicted_label).toBe('unsupported');
    expect(result.expected_label).toBe('supported');
    expect(result.matches_expected).toBe(false);
  });

  test('accumulates tokens + cost', async () => {
    const client = stubClient([classifyResp('supported')]);
    const result = await classifyClaim(SAMPLE_CLAIM, SAMPLE_PAGES, { client });
    expect(result.input_tokens).toBe(500);
    expect(result.output_tokens).toBe(50);
    expect(result.cost_usd).toBeGreaterThan(0);
  });
});

// ─── Retry + fallback ────────────────────────────────────────────────

describe('classifyClaim — retry + fallback', () => {
  test('retries once on malformed response and then succeeds', async () => {
    const client = stubClient([malformedResp(), classifyResp('supported')]);
    const result = await classifyClaim(SAMPLE_CLAIM, SAMPLE_PAGES, { client });
    expect(result.predicted_label).toBe('supported');
    expect(result.fallback_used).toBe(false);
    // Tokens from BOTH calls accumulated
    expect(result.input_tokens).toBe(1000);
  });

  test('falls back to judge_failed when both attempts malformed', async () => {
    const client = stubClient([malformedResp(), malformedResp()]);
    const result = await classifyClaim(SAMPLE_CLAIM, SAMPLE_PAGES, { client });
    expect(result.predicted_label).toBe('judge_failed');
    expect(result.matches_expected).toBe(false);
    expect(result.fallback_used).toBe(true);
    expect(result.judge_rationale).toContain('judge_failed');
  });
});

// ─── aggregate ────────────────────────────────────────────────────────

describe('aggregate', () => {
  let scoreSeq = 0;
  function mkScore(
    predicted: 'supported' | 'unsupported' | 'over-generalized' | 'judge_failed',
    expected: 'supported' | 'unsupported' | 'over-generalized',
  ): ClaimScore {
    return {
      claim_id: `c-${scoreSeq++}`,
      predicted_label: predicted,
      expected_label: expected,
      matches_expected: predicted === expected,
      judge_rationale: '',
      input_tokens: 100,
      output_tokens: 20,
      cost_usd: 0.001,
      fallback_used: predicted === 'judge_failed',
    };
  }

  test('citation_accuracy is correct for all-matching scores', () => {
    const claims: Claim[] = [];
    const scores: ClaimScore[] = [
      mkScore('supported', 'supported'),
      mkScore('unsupported', 'unsupported'),
      mkScore('over-generalized', 'over-generalized'),
    ];
    const report = aggregate(claims, scores);
    expect(report.citation_accuracy).toBe(1);
  });

  test('citation_accuracy is correct for mixed scores', () => {
    const scores: ClaimScore[] = [
      mkScore('supported', 'supported'),      // match
      mkScore('supported', 'unsupported'),    // miss
      mkScore('unsupported', 'unsupported'),  // match
      mkScore('over-generalized', 'supported'), // miss
    ];
    const report = aggregate([], scores);
    expect(report.citation_accuracy).toBe(0.5); // 2/4
  });

  test('judge_failure_rate counts fallbacks', () => {
    const scores: ClaimScore[] = [
      mkScore('supported', 'supported'),
      mkScore('judge_failed', 'supported'),
      mkScore('judge_failed', 'unsupported'),
    ];
    const report = aggregate([], scores);
    expect(report.judge_failure_rate).toBeCloseTo(2 / 3, 6);
  });

  // WS0 policy: judge failures are excluded from the accuracy denominator —
  // never averaged in as 0 (that silently deflated citation_accuracy).
  test('citation_accuracy excludes judge_failed claims from the denominator', () => {
    const scores: ClaimScore[] = [
      mkScore('supported', 'supported'),   // classified, match
      mkScore('unsupported', 'supported'), // classified, miss
      mkScore('judge_failed', 'supported'), // NOT in denominator
      mkScore('judge_failed', 'unsupported'), // NOT in denominator
    ];
    const report = aggregate([], scores);
    expect(report.citation_accuracy).toBe(0.5); // 1/2, not 1/4
  });

  test('citation_accuracy is 0 (not NaN) when every claim judge_failed', () => {
    const report = aggregate([], [mkScore('judge_failed', 'supported')]);
    expect(report.citation_accuracy).toBe(0);
    expect(Number.isNaN(report.citation_accuracy)).toBe(false);
  });

  test('verdict is baseline_only by default', () => {
    const scores = [mkScore('supported', 'supported')];
    expect(aggregate([], scores).verdict).toBe('baseline_only');
  });

  test('verdict is pass when enableThreshold + accuracy >= threshold', () => {
    const scores = [
      mkScore('supported', 'supported'),
      mkScore('supported', 'supported'),
      mkScore('supported', 'supported'),
      mkScore('supported', 'supported'),
      mkScore('supported', 'supported'),
    ];
    const report = aggregate([], scores, { enableThreshold: true, threshold: 0.9 });
    expect(report.verdict).toBe('pass');
  });

  test('verdict is fail when enableThreshold + accuracy < threshold', () => {
    const scores = [
      mkScore('supported', 'supported'),
      mkScore('unsupported', 'supported'),
    ];
    const report = aggregate([], scores, { enableThreshold: true, threshold: 0.9 });
    expect(report.verdict).toBe('fail');
  });

  test('by_predicted + by_expected counters are correct', () => {
    const scores = [
      mkScore('supported', 'supported'),
      mkScore('unsupported', 'supported'),
      mkScore('over-generalized', 'unsupported'),
      mkScore('judge_failed', 'unsupported'),
    ];
    const report = aggregate([], scores);
    expect(report.by_predicted.supported).toBe(1);
    expect(report.by_predicted.unsupported).toBe(1);
    expect(report.by_predicted['over-generalized']).toBe(1);
    expect(report.by_predicted.judge_failed).toBe(1);
    expect(report.by_expected.supported).toBe(2);
    expect(report.by_expected.unsupported).toBe(2);
  });
});

// ─── runCat5 ──────────────────────────────────────────────────────────

describe('runCat5', () => {
  test('dispatches each claim with its expected_evidence resolved from pagesBySlug', async () => {
    const claims: Claim[] = [
      {
        id: 'c1',
        source_page: 'people/amara',
        claim_text: 'Amara is a partner.',
        expected_label: 'supported',
        expected_evidence: ['people/amara'],
      },
      {
        id: 'c2',
        source_page: 'people/jordan',
        claim_text: 'Jordan founded NovaMind in 2029 (date hallucinated).',
        expected_label: 'over-generalized',
        expected_evidence: ['people/jordan'],
      },
    ];
    const pagesBySlug = new Map<string, GroundTruthPage>();
    pagesBySlug.set('people/amara', { slug: 'people/amara', title: 'Amara', content: 'Partner at Halfway.' });
    pagesBySlug.set('people/jordan', { slug: 'people/jordan', title: 'Jordan', content: 'Founded NovaMind in 2023.' });

    const client = stubClient([
      classifyResp('supported', 'direct match'),
      classifyResp('over-generalized', 'date is wrong'),
    ]);

    const reportsRoot = tmpReportsRoot();
    const report = await runCat5({ claims, pagesBySlug, client, concurrency: 1, reportsRoot });
    expect(report.total_claims).toBe(2);
    expect(report.citation_accuracy).toBe(1);
    expect(report.per_claim[0].claim_id).toBe('c1');
    expect(report.per_claim[1].claim_id).toBe('c2');

    // Receipt written + valid (shared contract).
    const receipt = loadReceipt(receiptPath(CAT5_CATEGORY, reportsRoot));
    expect(receipt.run_status).toBe('completed');
    expect(receipt.verdict).toBe('partial'); // baseline_only → partial (no real gate yet)
    expect(receipt.n_total).toBe(2);
    expect(receipt.n_scored).toBe(2);
    expect(receipt.judge).toEqual({ model: 'claude-haiku-4-5-20251001', temperature: 0 });
  });

  // Regression: unresolvable gold slugs previously produced an EMPTY source
  // list, which flipped the prompt into the label-leaking shape. Now gold
  // drift is a loud harness error and the claim is never classified.
  test('unresolvable slugs → harness error, claim excluded (was silent empty-context classify)', async () => {
    const claims: Claim[] = [
      {
        id: 'c-ghost',
        source_page: 'people/ghost',
        claim_text: 'Ghost person does stuff.',
        expected_label: 'unsupported',
        expected_evidence: ['people/ghost-not-in-corpus'],
      },
    ];
    const pagesBySlug = new Map<string, GroundTruthPage>(); // empty
    const client = stubClient([]); // classifier must NEVER be called
    const reportsRoot = tmpReportsRoot();
    const report = await runCat5({ claims, pagesBySlug, client, reportsRoot });

    expect(report.per_claim.length).toBe(0);

    const receipt = loadReceipt(receiptPath(CAT5_CATEGORY, reportsRoot));
    expect(receipt.n_total).toBe(1);
    expect(receipt.n_scored).toBe(0);
    expect(receipt.errors.length).toBe(1);
    expect(receipt.errors[0].origin).toBe('harness');
    expect(receipt.errors[0].probe_id).toBe('c-ghost');
    expect(receipt.errors[0].message).toContain('people/ghost');
    expect(receipt.publishable).toBe(false); // smoke run with an infra error
  });

  test('good gold data still classifies (fail-loud gate passes on good input)', async () => {
    const claims: Claim[] = [
      {
        id: 'c-good',
        source_page: 'people/amara',
        claim_text: 'Amara collects vintage submarines.',
        expected_label: 'unsupported',
        expected_evidence: [],
      },
    ];
    const pagesBySlug = new Map<string, GroundTruthPage>([
      ['people/amara', { slug: 'people/amara', title: 'Amara', content: 'Partner at Halfway.' }],
    ]);
    const client = stubClient([classifyResp('unsupported')]);
    const report = await runCat5({ claims, pagesBySlug, client, reportsRoot: tmpReportsRoot() });
    expect(report.per_claim.length).toBe(1);
    expect(report.per_claim[0].matches_expected).toBe(true);
    expect(report.citation_accuracy).toBe(1);
  });

  test('judge_failed claim → typed judge error in the receipt, excluded from accuracy', async () => {
    const claims: Claim[] = [
      {
        id: 'c-jf',
        source_page: 'people/amara',
        claim_text: 'Amara is a partner.',
        expected_label: 'supported',
        expected_evidence: ['people/amara'],
      },
    ];
    const pagesBySlug = new Map<string, GroundTruthPage>([
      ['people/amara', { slug: 'people/amara', title: 'Amara', content: 'Partner at Halfway.' }],
    ]);
    const client = stubClient([malformedResp(), malformedResp()]);
    const reportsRoot = tmpReportsRoot();
    const report = await runCat5({ claims, pagesBySlug, client, reportsRoot });

    expect(report.per_claim[0].predicted_label).toBe('judge_failed');
    expect(report.citation_accuracy).toBe(0); // nothing classified — not a fake miss average

    const receipt = loadReceipt(receiptPath(CAT5_CATEGORY, reportsRoot));
    expect(receipt.errors.length).toBe(1);
    expect(receipt.errors[0].origin).toBe('judge');
  });

  // BLIND CLASSIFICATION regression (agentic-cats-02 / tests-audit-04): the
  // context handed to the classifier is label-independent — an unsupported
  // claim with no expected_evidence still gets its source_page content, and
  // the prompt carries no verdict hint.
  test('unsupported claims get a non-empty, hint-free classifier context', async () => {
    const claims: Claim[] = [
      {
        id: 'c-blind',
        source_page: 'people/amara',
        claim_text: 'Amara collects vintage submarines.',
        expected_label: 'unsupported',
        expected_evidence: [], // gold-unsupported: no evidence pages
      },
    ];
    const pagesBySlug = new Map<string, GroundTruthPage>([
      ['people/amara', { slug: 'people/amara', title: 'Amara', content: 'Partner at Halfway Capital.' }],
    ]);
    const captured: string[] = [];
    const capturingClient = {
      messages: {
        create: async (req: { messages: Array<{ content: string }> }) => {
          captured.push(req.messages[0].content);
          return classifyResp('unsupported') as unknown as Anthropic.Messages.Message;
        },
      },
    } as unknown as Anthropic;

    await runCat5({ claims, pagesBySlug, client: capturingClient, reportsRoot: tmpReportsRoot() });

    expect(captured.length).toBe(1);
    const prompt = captured[0];
    // Label-independent context: the claim's own source page is present.
    expect(prompt).toContain('Partner at Halfway Capital.');
    // No leak: neither the empty-context hint nor the gold label appears.
    expect(prompt).not.toContain('no source pages provided');
    expect(prompt).not.toContain('almost certainly');
    expect(prompt).not.toContain('unsupported');
  });
});

// ─── resolveClaimSources ─────────────────────────────────────────────

describe('resolveClaimSources', () => {
  const PAGES = new Map<string, GroundTruthPage>([
    ['people/amara', { slug: 'people/amara', title: 'Amara', content: 'Partner.' }],
    ['companies/halfway', { slug: 'companies/halfway', title: 'Halfway', content: 'VC firm.' }],
  ]);

  test('always includes source_page first, then evidence, deduped', () => {
    const claim: Claim = {
      id: 'c1',
      source_page: 'people/amara',
      claim_text: 'x',
      expected_label: 'supported',
      expected_evidence: ['companies/halfway', 'people/amara'],
    };
    const { sources, missing } = resolveClaimSources(claim, PAGES);
    expect(missing).toEqual([]);
    expect(sources.map(s => s.slug)).toEqual(['people/amara', 'companies/halfway']);
  });

  test('reports every unresolvable slug', () => {
    const claim: Claim = {
      id: 'c2',
      source_page: 'people/ghost',
      claim_text: 'x',
      expected_label: 'supported',
      expected_evidence: ['doc/missing'],
    };
    const { sources, missing } = resolveClaimSources(claim, PAGES);
    expect(sources).toEqual([]);
    expect(missing).toEqual(['people/ghost', 'doc/missing']);
  });
});

// ─── renderClaimPrompt + parseClassification ──────────────────────────

describe('renderClaimPrompt', () => {
  test('includes claim text, source page slug, and evidence pages', () => {
    const rendered = renderClaimPrompt(SAMPLE_CLAIM, SAMPLE_PAGES);
    expect(rendered).toContain('claim-001');
    expect(rendered).toContain('Amara Okafor is a Partner');
    expect(rendered).toContain('people/amara');
    expect(rendered).toContain('companies/halfway');
    expect(rendered).toContain('Halfway Capital is a seed-stage');
  });

  test('handles empty source list with a NEUTRAL note — no verdict hint (tests-audit-04)', () => {
    const rendered = renderClaimPrompt(SAMPLE_CLAIM, []);
    expect(rendered).toContain('no source pages provided');
    // The old note said "— the claim is almost certainly unsupported",
    // literally handing the judge the gold label for every gold-unsupported
    // claim. The rendered prompt must never contain a label word.
    expect(rendered).not.toContain('almost certainly');
    expect(rendered).not.toContain('unsupported');
    expect(rendered).not.toContain('supported');
    expect(rendered).not.toContain('over-generalized');
  });

  test('rendered prompt never contains the claim expected_label for any class', () => {
    for (const expected_label of ['supported', 'unsupported', 'over-generalized'] as const) {
      const rendered = renderClaimPrompt({ ...SAMPLE_CLAIM, expected_label }, SAMPLE_PAGES);
      expect(rendered).not.toContain('expected_label');
      expect(rendered).not.toContain('almost certainly');
    }
  });
});

describe('parseClassification', () => {
  test('rejects plain-text response', () => {
    const response = {
      content: [{ type: 'text', text: 'I decide supported' }],
    } as unknown as Anthropic.Messages.Message;
    expect(parseClassification(response)).toBeNull();
  });

  test('rejects invalid enum value', () => {
    const response = {
      content: [
        {
          type: 'tool_use',
          id: 'x',
          name: 'classify_claim',
          input: { label: 'maybe', rationale: 'unsure' },
        },
      ],
    } as unknown as Anthropic.Messages.Message;
    expect(parseClassification(response)).toBeNull();
  });

  test('accepts valid classification', () => {
    const response = {
      content: [
        {
          type: 'tool_use',
          id: 'x',
          name: 'classify_claim',
          input: { label: 'supported', rationale: 'match' },
        },
      ],
    } as unknown as Anthropic.Messages.Message;
    const parsed = parseClassification(response);
    expect(parsed).not.toBeNull();
    expect(parsed!.label).toBe('supported');
  });
});

// ─── Tool shape ────────────────────────────────────────────────────────

describe('CLASSIFY_CLAIM_TOOL', () => {
  test('input_schema enum has exactly 3 labels', () => {
    const enumVals = CLASSIFY_CLAIM_TOOL.input_schema.properties.label.enum;
    expect(enumVals).toEqual(['supported', 'unsupported', 'over-generalized']);
  });

  test('requires label + rationale', () => {
    expect(CLASSIFY_CLAIM_TOOL.input_schema.required).toEqual(['label', 'rationale']);
  });
});
