/**
 * cat35-judges.ts tests — stubbed Anthropic client, $0, no network.
 *
 * makeStubClient pattern from judge.test.ts, extended to record every request
 * so tests can assert prompt content, forced tool_choice, cache_control, and
 * retry payloads. NEVER monkeypatches an engine object (repo pitfall) — stub
 * clients only.
 *
 * Covers:
 *   - batched coverage parse + missing-item retry (retry lists ONLY missing
 *     ids) + judge_failed_ids
 *   - malformed tool_use → one retry → structured failure (never throws)
 *   - cost accounting sums usage across calls; sonnet vs haiku pricing;
 *     model resolution precedence (cfg > env > default)
 *   - scoreGrounding verifiable/grounded parse + all-or-nothing failure
 *   - confirmDistractorLeaks benign vs surfaced-as-salient
 *   - scoreUsabilityChecklist incl. hasGoldVibes=false excluding
 *     preserves_tenor from total (auto-pass)
 *   - PERTURBATION: a mechanically degraded page (opening stripped, links
 *     stripped) must score strictly lower than the intact page under a stub
 *     judge driven by the cat35-checks mechanical subset
 */

import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import {
  CAT35_JUDGE_PROMPT_VERSION,
  confirmDistractorLeaks,
  getJudgeModelsResolved,
  resetJudgeModelsResolved,
  scoreGrounding,
  scoreSalienceCoverage,
  scoreUsabilityChecklist,
  singleResolvedModel,
} from '../../eval/runner/cat35-judges.ts';
import { hasWikilink, selfContainedOpening } from '../../eval/runner/cat35-checks.ts';

// ─── Stub client (judge.test.ts pattern + request recording) ──────────────

type StubResponse = {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; name: string; input: unknown; id: string }
  >;
  usage: { input_tokens: number; output_tokens: number };
  /** Server-reported model id (resp.model). Omitted = pre-recording stub / degraded gateway. */
  model?: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RecordedRequest = Record<string, any>;

function makeStubClient(responses: StubResponse[]): { client: Anthropic; calls: RecordedRequest[] } {
  let i = 0;
  const calls: RecordedRequest[] = [];
  const client = {
    messages: {
      create: async (req: RecordedRequest) => {
        calls.push(req);
        if (i >= responses.length) {
          throw new Error(
            `Stub client: out of canned responses (consumed ${i}, configured ${responses.length})`,
          );
        }
        return responses[i++] as unknown as Anthropic.Messages.Message;
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

function toolUse(name: string, input: unknown, usage = { input_tokens: 1000, output_tokens: 100 }): StubResponse {
  return { content: [{ type: 'tool_use', id: 'toolu_01', name, input }], usage };
}

function malformed(usage = { input_tokens: 800, output_tokens: 40 }): StubResponse {
  return { content: [{ type: 'text', text: 'I refuse to use tools today' }], usage };
}

afterEach(() => {
  delete process.env.CAT35_JUDGE_MODEL;
});

// ─── Prompt version pin ───────────────────────────────────────────────────

describe('CAT35_JUDGE_PROMPT_VERSION', () => {
  test('is pinned', () => {
    expect(CAT35_JUDGE_PROMPT_VERSION).toBe('2026-08-16-v1');
  });
});

// ─── scoreSalienceCoverage ────────────────────────────────────────────────

const ITEMS = [
  { item_id: 'i-1', statement: 'The team decided to make the parser fail loudly on duplicate keys.' },
  { item_id: 'i-2', statement: 'The user felt betrayed by the silent failure.' },
  { item_id: 'i-3', statement: 'The retro produced a weekly co-review cadence.' },
];

function coverageArgs() {
  return { lane: 'dream', transcript_id: 't-1', document: 'The distilled page body.', items: ITEMS };
}

describe('scoreSalienceCoverage', () => {
  test('happy path: one batched call scores all items', async () => {
    const { client, calls } = makeStubClient([
      toolUse('score_salient_items', {
        items: [
          { item_id: 'i-1', status: 'FULL', evidence: 'fail loudly on duplicate keys' },
          { item_id: 'i-2', status: 'PARTIAL', evidence: 'felt let down' },
          { item_id: 'i-3', status: 'ABSENT', evidence: '' },
        ],
      }),
    ]);
    const r = await scoreSalienceCoverage(coverageArgs(), { client });
    expect(calls).toHaveLength(1);
    expect(r.verdicts).toEqual([
      { item_id: 'i-1', status: 'FULL', evidence: 'fail loudly on duplicate keys' },
      { item_id: 'i-2', status: 'PARTIAL', evidence: 'felt let down' },
      { item_id: 'i-3', status: 'ABSENT', evidence: '' },
    ]);
    expect(r.judge_failed_ids).toEqual([]);
    expect(r.input_tokens).toBe(1000);
    expect(r.output_tokens).toBe(100);
    // Default haiku pricing: (1000*1 + 100*5)/1e6
    expect(r.cost_usd).toBeCloseTo(0.0015, 10);
  });

  test('request shape: forced tool_choice + cache_control ephemeral system block', async () => {
    const { client, calls } = makeStubClient([
      toolUse('score_salient_items', { items: ITEMS.map((i) => ({ item_id: i.item_id, status: 'ABSENT', evidence: '' })) }),
    ]);
    await scoreSalienceCoverage(coverageArgs(), { client });
    const req = calls[0];
    expect(req.tool_choice).toEqual({ type: 'tool', name: 'score_salient_items' });
    expect(req.tools[0].name).toBe('score_salient_items');
    expect(req.system[0].cache_control).toEqual({ type: 'ephemeral' });
    // Judge sees paraphrase statements, never anchors — no anchor field leaks.
    expect(JSON.stringify(req.messages)).not.toContain('verbatim_anchor');
  });

  test('missing item_id → ONE retry listing only the missing ids', async () => {
    const { client, calls } = makeStubClient([
      toolUse('score_salient_items', {
        items: [
          { item_id: 'i-1', status: 'FULL', evidence: 'e1' },
          { item_id: 'i-3', status: 'ABSENT', evidence: '' },
        ],
      }),
      toolUse('score_salient_items', {
        items: [{ item_id: 'i-2', status: 'PARTIAL', evidence: 'e2' }],
      }),
    ]);
    const r = await scoreSalienceCoverage(coverageArgs(), { client });
    expect(calls).toHaveLength(2);
    const retryContent = calls[1].messages[0].content as string;
    expect(retryContent).toContain('i-2'); // the missing item is listed…
    expect(retryContent).not.toContain('item_id=i-1'); // …and satisfied ones are not
    expect(retryContent).not.toContain('item_id=i-3');
    expect(r.judge_failed_ids).toEqual([]);
    expect(r.verdicts.map((v) => v.item_id).sort()).toEqual(['i-1', 'i-2', 'i-3']);
    // Tokens/cost accumulate across both calls.
    expect(r.input_tokens).toBe(2000);
    expect(r.output_tokens).toBe(200);
    expect(r.cost_usd).toBeCloseTo(0.003, 10);
  });

  test('still missing after the retry → judge_failed_ids for those items only', async () => {
    const { client } = makeStubClient([
      toolUse('score_salient_items', {
        items: [{ item_id: 'i-1', status: 'FULL', evidence: 'e1' }],
      }),
      toolUse('score_salient_items', {
        items: [{ item_id: 'i-2', status: 'FULL', evidence: 'e2' }],
      }),
    ]);
    const r = await scoreSalienceCoverage(coverageArgs(), { client });
    expect(r.verdicts.map((v) => v.item_id).sort()).toEqual(['i-1', 'i-2']);
    expect(r.judge_failed_ids).toEqual(['i-3']);
  });

  test('malformed tool_use → one full retry → structured failure for ALL items', async () => {
    const { client, calls } = makeStubClient([malformed(), malformed()]);
    const r = await scoreSalienceCoverage(coverageArgs(), { client });
    expect(calls).toHaveLength(2);
    expect(r.verdicts).toEqual([]);
    expect(r.judge_failed_ids).toEqual(['i-1', 'i-2', 'i-3']);
    // Both attempts billed.
    expect(r.input_tokens).toBe(1600);
    expect(r.output_tokens).toBe(80);
    expect(r.cost_usd).toBeCloseTo((1600 * 1 + 80 * 5) / 1e6, 10);
  });

  test('malformed then well-formed retry recovers', async () => {
    const { client } = makeStubClient([
      malformed(),
      toolUse('score_salient_items', {
        items: ITEMS.map((i) => ({ item_id: i.item_id, status: 'FULL', evidence: 'ok' })),
      }),
    ]);
    const r = await scoreSalienceCoverage(coverageArgs(), { client });
    expect(r.judge_failed_ids).toEqual([]);
    expect(r.verdicts).toHaveLength(3);
  });

  test('invalid statuses and unknown ids are ignored (count as missing)', async () => {
    const { client } = makeStubClient([
      toolUse('score_salient_items', {
        items: [
          { item_id: 'i-1', status: 'KINDA', evidence: 'x' }, // invalid status
          { item_id: 'i-9', status: 'FULL', evidence: 'x' }, // unknown id
          { item_id: 'i-2', status: 'FULL', evidence: 'y' },
          { item_id: 'i-3', status: 'ABSENT', evidence: '' },
        ],
      }),
      toolUse('score_salient_items', { items: [] }), // retry for i-1 comes back empty
    ]);
    const r = await scoreSalienceCoverage(coverageArgs(), { client });
    expect(r.judge_failed_ids).toEqual(['i-1']);
    expect(r.verdicts.map((v) => v.item_id).sort()).toEqual(['i-2', 'i-3']);
  });

  test('evidence is clamped to 200 chars', async () => {
    const { client } = makeStubClient([
      toolUse('score_salient_items', {
        items: [
          { item_id: 'i-1', status: 'FULL', evidence: 'x'.repeat(500) },
          { item_id: 'i-2', status: 'ABSENT', evidence: '' },
          { item_id: 'i-3', status: 'ABSENT', evidence: '' },
        ],
      }),
    ]);
    const r = await scoreSalienceCoverage(coverageArgs(), { client });
    expect(r.verdicts[0].evidence).toHaveLength(200);
  });

  test('empty item list → no LLM call, zero cost', async () => {
    const { client, calls } = makeStubClient([]);
    const r = await scoreSalienceCoverage({ ...coverageArgs(), items: [] }, { client });
    expect(calls).toHaveLength(0);
    expect(r).toEqual({ verdicts: [], judge_failed_ids: [], input_tokens: 0, output_tokens: 0, cost_usd: 0 });
  });

  test('model precedence: cfg.model > env > default; sonnet pricing applies', async () => {
    process.env.CAT35_JUDGE_MODEL = 'claude-sonnet-4-6';
    const canned = () =>
      toolUse(
        'score_salient_items',
        { items: ITEMS.map((i) => ({ item_id: i.item_id, status: 'FULL', evidence: 'e' })) },
        { input_tokens: 1000, output_tokens: 100 },
      );

    // env wins over default
    const a = makeStubClient([canned()]);
    const rEnv = await scoreSalienceCoverage(coverageArgs(), { client: a.client });
    expect(a.calls[0].model).toBe('claude-sonnet-4-6');
    // Sonnet pricing: (1000*3 + 100*15)/1e6 = 0.0045
    expect(rEnv.cost_usd).toBeCloseTo(0.0045, 10);

    // cfg wins over env
    const b = makeStubClient([canned()]);
    const rCfg = await scoreSalienceCoverage(coverageArgs(), {
      client: b.client,
      model: 'claude-haiku-4-5-20251001',
    });
    expect(b.calls[0].model).toBe('claude-haiku-4-5-20251001');
    expect(rCfg.cost_usd).toBeCloseTo(0.0015, 10);
  });
});

// ─── scoreGrounding ───────────────────────────────────────────────────────

describe('scoreGrounding', () => {
  const CLAIMS = [
    'The parser rejected duplicate keys in staging.',
    'The user felt betrayed by the silent failure.',
    'This idea seems promising.',
  ];

  test('parses verifiable/grounded per claim by index', async () => {
    const { client } = makeStubClient([
      toolUse('grade_claims', {
        claims: [
          { index: 0, verifiable: true, grounded: true },
          { index: 1, verifiable: true, grounded: false }, // invented emotion → verifiable, ungrounded
          { index: 2, verifiable: false, grounded: false }, // editorial voice
        ],
      }),
    ]);
    const r = await scoreGrounding({ label: 'dream:t-1', claims: CLAIMS, transcript: 'the transcript' }, { client });
    expect(r.judge_failed).toBe(false);
    expect(r.results).toEqual([
      { claim: CLAIMS[0], verifiable: true, grounded: true },
      { claim: CLAIMS[1], verifiable: true, grounded: false },
      { claim: CLAIMS[2], verifiable: false, grounded: false },
    ]);
    expect(r.cost_usd).toBeGreaterThan(0);
  });

  test('out-of-order indexes are re-aligned', async () => {
    const { client } = makeStubClient([
      toolUse('grade_claims', {
        claims: [
          { index: 2, verifiable: false, grounded: false },
          { index: 0, verifiable: true, grounded: true },
          { index: 1, verifiable: true, grounded: true },
        ],
      }),
    ]);
    const r = await scoreGrounding({ label: 'x', claims: CLAIMS, transcript: 't' }, { client });
    expect(r.results[0].grounded).toBe(true);
    expect(r.results[2].verifiable).toBe(false);
  });

  test('incomplete index coverage counts as malformed → retry → judge_failed', async () => {
    const { client, calls } = makeStubClient([
      toolUse('grade_claims', { claims: [{ index: 0, verifiable: true, grounded: true }] }),
      toolUse('grade_claims', { claims: [{ index: 0, verifiable: true, grounded: true }] }),
    ]);
    const r = await scoreGrounding({ label: 'x', claims: CLAIMS, transcript: 't' }, { client });
    expect(calls).toHaveLength(2);
    expect(r.judge_failed).toBe(true);
    expect(r.results).toEqual([]);
    // Cost still accounted across both attempts.
    expect(r.cost_usd).toBeCloseTo(2 * ((1000 * 1 + 100 * 5) / 1e6), 10);
  });

  test('malformed → retry → recovered', async () => {
    const { client } = makeStubClient([
      malformed(),
      toolUse('grade_claims', {
        claims: CLAIMS.map((_, i) => ({ index: i, verifiable: true, grounded: true })),
      }),
    ]);
    const r = await scoreGrounding({ label: 'x', claims: CLAIMS, transcript: 't' }, { client });
    expect(r.judge_failed).toBe(false);
    expect(r.results).toHaveLength(3);
  });

  test('empty claims → no LLM call', async () => {
    const { client, calls } = makeStubClient([]);
    const r = await scoreGrounding({ label: 'x', claims: [], transcript: 't' }, { client });
    expect(calls).toHaveLength(0);
    expect(r).toEqual({ results: [], judge_failed: false, cost_usd: 0, input_tokens: 0, output_tokens: 0 });
  });

  test('prompt carries the affect-is-verifiable rule and the transcript', async () => {
    const { client, calls } = makeStubClient([
      toolUse('grade_claims', { claims: [{ index: 0, verifiable: true, grounded: true }] }),
    ]);
    await scoreGrounding({ label: 'x', claims: ['a b c d e f'], transcript: 'THE-TRANSCRIPT-BODY' }, { client });
    expect(calls[0].system[0].text).toContain('the user felt betrayed');
    expect(calls[0].messages[0].content).toContain('THE-TRANSCRIPT-BODY');
  });
});

// ─── confirmDistractorLeaks ───────────────────────────────────────────────

describe('confirmDistractorLeaks', () => {
  const HITS = [
    { distractor_id: 'd-1', statement: 'renewed the parking permit' },
    { distractor_id: 'd-2', statement: 'ordered an HDMI cable' },
  ];

  test('confirms only surfaced-as-salient hits', async () => {
    const { client } = makeStubClient([
      toolUse('confirm_leaks', {
        leaks: [
          { distractor_id: 'd-1', surfaced_as_salient: true },
          { distractor_id: 'd-2', surfaced_as_salient: false }, // benign passing mention
        ],
      }),
    ]);
    const r = await confirmDistractorLeaks({ document: 'doc', hits: HITS }, { client });
    expect(r.judge_failed).toBe(false);
    expect(r.confirmed).toEqual(['d-1']);
    expect(r.cost_usd).toBeGreaterThan(0);
  });

  test('missing a hit id counts as malformed → retry → judge_failed', async () => {
    const { client, calls } = makeStubClient([
      toolUse('confirm_leaks', { leaks: [{ distractor_id: 'd-1', surfaced_as_salient: true }] }),
      malformed(),
    ]);
    const r = await confirmDistractorLeaks({ document: 'doc', hits: HITS }, { client });
    expect(calls).toHaveLength(2);
    expect(r.judge_failed).toBe(true);
    expect(r.confirmed).toEqual([]);
  });

  test('empty hits → no LLM call', async () => {
    const { client, calls } = makeStubClient([]);
    const r = await confirmDistractorLeaks({ document: 'doc', hits: [] }, { client });
    expect(calls).toHaveLength(0);
    expect(r).toEqual({ confirmed: [], judge_failed: false, cost_usd: 0 });
  });
});

// ─── scoreUsabilityChecklist ──────────────────────────────────────────────

const INTACT_PAGE = {
  slug: 'wiki/personal/reflections/2026-08-01-deploy-retro',
  body: [
    '# Deploy retro',
    '',
    'This page captures the outcome of the staging deploy retro from early August. ' +
      'The team decided to make the config parser fail loudly on duplicate keys after a silent failure cost a day.',
    '',
    'Decision (decided): parser fails loudly on duplicate keys. See [[projects/parser-rewrite]].',
  ].join('\n'),
};

describe('scoreUsabilityChecklist', () => {
  test('hasGoldVibes=true: all 6 checks judged, total 6', async () => {
    const allPass = [
      'self_contained_opening',
      'has_wikilink',
      'states_decisions_with_status',
      'preserves_tenor',
      'no_transcript_dump',
      'coherent_organization',
    ].map((id) => ({ id, pass: true }));
    const { client, calls } = makeStubClient([toolUse('usability_checklist', { checks: allPass })]);
    const r = await scoreUsabilityChecklist(
      { transcript_id: 't-1', pages: [INTACT_PAGE], hasGoldVibes: true },
      { client },
    );
    expect(r.judge_failed).toBe(false);
    expect(r.total).toBe(6);
    expect(r.satisfied).toBe(6);
    // The judge was actually asked for preserves_tenor.
    const toolEnum = calls[0].tools[0].input_schema.properties.checks.items.properties.id.enum;
    expect(toolEnum).toContain('preserves_tenor');
  });

  test('hasGoldVibes=false: preserves_tenor auto-passes and is EXCLUDED from total', async () => {
    const judged = [
      { id: 'self_contained_opening', pass: true },
      { id: 'has_wikilink', pass: false },
      { id: 'states_decisions_with_status', pass: true },
      { id: 'no_transcript_dump', pass: true },
      { id: 'coherent_organization', pass: true },
    ];
    const { client, calls } = makeStubClient([toolUse('usability_checklist', { checks: judged })]);
    const r = await scoreUsabilityChecklist(
      { transcript_id: 't-1', pages: [INTACT_PAGE], hasGoldVibes: false },
      { client },
    );
    expect(r.total).toBe(5); // tenor excluded
    expect(r.satisfied).toBe(4); // only judged passes count
    // tenor never sent to the judge…
    const toolEnum = calls[0].tools[0].input_schema.properties.checks.items.properties.id.enum;
    expect(toolEnum).not.toContain('preserves_tenor');
    expect(calls[0].messages[0].content).not.toContain('preserves_tenor');
    // …but appears in checks as an auto-pass for receipt visibility.
    const tenor = r.checks.find((c) => c.id === 'preserves_tenor');
    expect(tenor).toEqual({ id: 'preserves_tenor', pass: true });
  });

  test('malformed twice → structured failure: all applicable checks fail', async () => {
    const { client, calls } = makeStubClient([malformed(), malformed()]);
    const r = await scoreUsabilityChecklist(
      { transcript_id: 't-1', pages: [INTACT_PAGE], hasGoldVibes: false },
      { client },
    );
    expect(calls).toHaveLength(2);
    expect(r.judge_failed).toBe(true);
    expect(r.satisfied).toBe(0);
    expect(r.total).toBe(5);
    expect(r.cost_usd).toBeGreaterThan(0);
  });

  test('empty page set → mechanical zero, no LLM call', async () => {
    const { client, calls } = makeStubClient([]);
    const r = await scoreUsabilityChecklist({ transcript_id: 't-1', pages: [], hasGoldVibes: true }, { client });
    expect(calls).toHaveLength(0);
    expect(r.judge_failed).toBe(false);
    expect(r.satisfied).toBe(0);
    expect(r.total).toBe(6);
    expect(r.cost_usd).toBe(0);
  });

  test('judge grades the page SET: all pages appear in one prompt', async () => {
    const pages = [INTACT_PAGE, { slug: 'people/jane-doe', body: 'Jane cross-ref body.' }];
    const allPass = ['self_contained_opening', 'has_wikilink', 'states_decisions_with_status', 'no_transcript_dump', 'coherent_organization'].map(
      (id) => ({ id, pass: true }),
    );
    const { client, calls } = makeStubClient([toolUse('usability_checklist', { checks: allPass })]);
    await scoreUsabilityChecklist({ transcript_id: 't-1', pages, hasGoldVibes: false }, { client });
    expect(calls).toHaveLength(1);
    const content = calls[0].messages[0].content as string;
    expect(content).toContain('wiki/personal/reflections/2026-08-01-deploy-retro');
    expect(content).toContain('people/jane-doe');
    expect(content).toContain('Jane cross-ref body.');
  });
});

// ─── PERTURBATION: degraded page must score strictly lower ────────────────

describe('usability perturbation (Abridge pattern)', () => {
  // Stub judge whose behavior is DRIVEN by the mechanical subset from
  // cat35-checks: it fails exactly the checks whose mechanical ground truth
  // fails, and passes the rest. This keeps the perturbation test honest —
  // no hand-tuned canned verdicts.
  function mechanicalStubFor(pages: Array<{ slug: string; body: string }>) {
    const combined = pages.map((p) => p.body).join('\n\n');
    const mechanical: Record<string, boolean> = {
      self_contained_opening: pages.some((p) => selfContainedOpening(p.body)),
      has_wikilink: hasWikilink(combined),
      // Non-mechanical checks pass in both arms so only the perturbed
      // dimensions can move the score.
      states_decisions_with_status: true,
      no_transcript_dump: true,
      coherent_organization: true,
    };
    return makeStubClient([
      toolUse('usability_checklist', {
        checks: Object.entries(mechanical).map(([id, pass]) => ({ id, pass })),
      }),
    ]);
  }

  test('stripping the opening and the links strictly lowers the score', async () => {
    // Degrade: drop the self-contained opening paragraph, strip wikilinks.
    const degradedBody = INTACT_PAGE.body
      .split('\n')
      .filter((l) => !l.startsWith('This page captures'))
      .join('\n')
      .replace(/\[\[[^\]]*\]\]/g, '');
    const degradedPage = { slug: INTACT_PAGE.slug, body: degradedBody };

    // Sanity: the mechanical ground truth actually distinguishes the two arms.
    expect(selfContainedOpening(INTACT_PAGE.body)).toBe(true);
    expect(hasWikilink(INTACT_PAGE.body)).toBe(true);
    expect(selfContainedOpening(degradedBody)).toBe(false);
    expect(hasWikilink(degradedBody)).toBe(false);

    const intactStub = mechanicalStubFor([INTACT_PAGE]);
    const intact = await scoreUsabilityChecklist(
      { transcript_id: 't-1', pages: [INTACT_PAGE], hasGoldVibes: false },
      { client: intactStub.client },
    );

    const degradedStub = mechanicalStubFor([degradedPage]);
    const degraded = await scoreUsabilityChecklist(
      { transcript_id: 't-1', pages: [degradedPage], hasGoldVibes: false },
      { client: degradedStub.client },
    );

    expect(intact.total).toBe(degraded.total); // same denominator
    expect(intact.satisfied).toBe(5);
    expect(degraded.satisfied).toBe(3);
    expect(degraded.satisfied).toBeLessThan(intact.satisfied); // strictly lower
  });

  test('single perturbation (links only) also drops the score monotonically', async () => {
    const linkless = { slug: INTACT_PAGE.slug, body: INTACT_PAGE.body.replace(/\[\[[^\]]*\]\]/g, '') };
    const a = mechanicalStubFor([INTACT_PAGE]);
    const b = mechanicalStubFor([linkless]);
    const intact = await scoreUsabilityChecklist(
      { transcript_id: 't-1', pages: [INTACT_PAGE], hasGoldVibes: false },
      { client: a.client },
    );
    const degraded = await scoreUsabilityChecklist(
      { transcript_id: 't-1', pages: [linkless], hasGoldVibes: false },
      { client: b.client },
    );
    expect(degraded.satisfied).toBe(intact.satisfied - 1);
  });
});

// ─── judge_models_resolved — server-reported model accounting ──────────────
//
// generators-19 propagated to the judges (issue #26 gap 4): the requested
// judge_model can be a movable alias; resp.model is what the server says
// actually ran. Every judge response is counted per resolved model; the
// runner writes the map into the receipt and the comparability guard
// (singleResolvedModel) refuses cross-run deltas on absent/mixed/null-keyed
// evidence.

describe('judge_models_resolved accounting', () => {
  const SNAPSHOT = 'claude-haiku-4-5-20251001';

  function withModel(resp: StubResponse, model: string): StubResponse {
    return { ...resp, model };
  }

  beforeEach(() => {
    resetJudgeModelsResolved();
  });

  test('resp.model present: counted once per call, accumulating across a retry', async () => {
    // First call misses i-2 → one retry → 2 calls total, both under SNAPSHOT.
    const { client } = makeStubClient([
      withModel(
        toolUse('score_salient_items', {
          items: [
            { item_id: 'i-1', status: 'FULL', evidence: 'e1' },
            { item_id: 'i-3', status: 'ABSENT', evidence: '' },
          ],
        }),
        SNAPSHOT,
      ),
      withModel(
        toolUse('score_salient_items', { items: [{ item_id: 'i-2', status: 'PARTIAL', evidence: 'e2' }] }),
        SNAPSHOT,
      ),
    ]);
    await scoreSalienceCoverage(coverageArgs(), { client });
    expect(getJudgeModelsResolved()).toEqual({ [SNAPSHOT]: 2 });
  });

  test('accumulates across different judge functions and models', async () => {
    const cov = makeStubClient([
      withModel(
        toolUse('score_salient_items', {
          items: ITEMS.map((i) => ({ item_id: i.item_id, status: 'FULL', evidence: 'e' })),
        }),
        SNAPSHOT,
      ),
    ]);
    await scoreSalienceCoverage(coverageArgs(), { client: cov.client });

    const leaks = makeStubClient([
      withModel(
        toolUse('confirm_leaks', { leaks: [{ distractor_id: 'd-1', surfaced_as_salient: false }] }),
        'claude-sonnet-4-6-20260115',
      ),
    ]);
    await confirmDistractorLeaks(
      { document: 'doc', hits: [{ distractor_id: 'd-1', statement: 's' }] },
      { client: leaks.client },
    );

    expect(getJudgeModelsResolved()).toEqual({
      [SNAPSHOT]: 1,
      'claude-sonnet-4-6-20260115': 1,
    });
  });

  test('resp.model absent: tolerated, counted under the null key', async () => {
    const { client } = makeStubClient([
      toolUse('grade_claims', { claims: [{ index: 0, verifiable: true, grounded: true }] }),
    ]);
    const r = await scoreGrounding({ label: 'x', claims: ['a claim'], transcript: 't' }, { client });
    expect(r.judge_failed).toBe(false); // recording never breaks the verdict path
    expect(getJudgeModelsResolved()).toEqual({ null: 1 });
  });

  test('transport failure produces no resolved-model evidence', async () => {
    // Zero canned responses → every create() throws → both attempts land in
    // the transport-error branch, which never reaches recording.
    const { client } = makeStubClient([]);
    const r = await scoreGrounding({ label: 'x', claims: ['a claim'], transcript: 't' }, { client });
    expect(r.judge_failed).toBe(true);
    expect(getJudgeModelsResolved()).toEqual({});
  });

  test('reset clears the per-run map', async () => {
    const { client } = makeStubClient([
      withModel(
        toolUse('score_salient_items', {
          items: ITEMS.map((i) => ({ item_id: i.item_id, status: 'ABSENT', evidence: '' })),
        }),
        SNAPSHOT,
      ),
    ]);
    await scoreSalienceCoverage(coverageArgs(), { client });
    expect(getJudgeModelsResolved()).toEqual({ [SNAPSHOT]: 1 });
    resetJudgeModelsResolved();
    expect(getJudgeModelsResolved()).toEqual({});
  });
});

describe('singleResolvedModel — the delta comparability guard', () => {
  test('exactly one real model key → that model (deltas allowed when both sides agree)', () => {
    expect(singleResolvedModel({ 'claude-haiku-4-5-20251001': 412 })).toBe(
      'claude-haiku-4-5-20251001',
    );
  });

  test('absent map (all pre-2026-09 receipts) → null → non-comparable', () => {
    expect(singleResolvedModel(undefined)).toBeNull();
    expect(singleResolvedModel(null)).toBeNull();
  });

  test('empty or non-object evidence → null', () => {
    expect(singleResolvedModel({})).toBeNull();
    expect(singleResolvedModel('claude-haiku-4-5-20251001')).toBeNull();
    expect(singleResolvedModel(['claude-haiku-4-5-20251001'])).toBeNull();
    expect(singleResolvedModel(42)).toBeNull();
  });

  test('mixed models within one run → null (a mid-run repoint is exactly the hazard)', () => {
    expect(
      singleResolvedModel({ 'claude-sonnet-4-6-20260115': 3, 'claude-sonnet-4-6-20260301': 9 }),
    ).toBeNull();
  });

  test('null-keyed map (responses without model fields) → null', () => {
    expect(singleResolvedModel({ null: 12 })).toBeNull();
    expect(singleResolvedModel({ '': 2 })).toBeNull();
  });
});
