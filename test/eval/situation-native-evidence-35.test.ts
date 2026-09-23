import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  confirmDistractorLeaks,
  scoreGrounding,
  scoreSalienceCoverage,
  scoreUsabilityChecklist,
  type Cat35JudgeAttempt,
  type Cat35JudgeCfg,
} from '../../eval/runner/cat35-judges.ts';

const ROOT = resolve(import.meta.dir, '../..');
const MODEL = 'claude-haiku-4-5-20251001';
const RESOLVED = 'hermetic-judge-snapshot';

function response(tool: string, input: unknown, model: string | null = RESOLVED) {
  return {
    ...(model === null ? {} : { model }),
    content: [{ type: 'tool_use', name: tool, input, id: 'stub-tool' }],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function stubClient(responses: Array<unknown | Error>) {
  const calls: unknown[] = [];
  let i = 0;
  return {
    calls,
    client: { messages: { create: async (request: unknown) => {
      calls.push(request);
      if (i >= responses.length) throw new Error('Unexpected extra judge attempt');
      const next = responses[i++];
      if (next instanceof Error) throw next;
      return next;
    } } },
  };
}

describe('Cat35 observed judge attempts', () => {
  test('recording preserves native results, requests, retries, and failed empty batches', async () => {
    const cases: Array<{ run: (cfg: Cat35JudgeCfg) => Promise<unknown>; responses: unknown[] }> = [
      {
        run: (cfg) => scoreGrounding({ label: 'facts:t', claims: ['A factual claim', 'An editorial opinion'], transcript: 'Source' }, cfg),
        responses: [response('grade_claims', { claims: [] }, null), response('grade_claims', { claims: [
          { index: 0, verifiable: true, grounded: false }, { index: 1, verifiable: false, grounded: false },
        ] })],
      },
      {
        run: (cfg) => scoreSalienceCoverage({ lane: 'facts', transcript_id: 't', document: 'Text', items: [
          { item_id: 'i1', statement: 'One' }, { item_id: 'i2', statement: 'Two' },
        ] }, cfg),
        responses: [response('score_salient_items', { items: [{ item_id: 'i1', status: 'ABSENT', evidence: '' }] }),
          response('score_salient_items', { items: [] })],
      },
      {
        run: (cfg) => confirmDistractorLeaks({ document: 'Text', hits: [{ distractor_id: 'd1', statement: 'One' }] }, cfg),
        responses: [response('confirm_leaks', { leaks: [] }), response('confirm_leaks', { leaks: [] })],
      },
      {
        run: (cfg) => scoreUsabilityChecklist({ transcript_id: 't', pages: [{ slug: 'test/page', body: 'Text' }], hasGoldVibes: false }, cfg),
        responses: [response('usability_checklist', { checks: [] }), response('usability_checklist', { checks: [] })],
      },
    ];
    for (const c of cases) {
      const plain = stubClient(c.responses);
      const observed = stubClient(c.responses);
      const evidence: Cat35JudgeAttempt[] = [];
      expect(await c.run({ model: MODEL, client: observed.client, evidence }))
        .toEqual(await c.run({ model: MODEL, client: plain.client }));
      expect(observed.calls).toEqual(plain.calls);
      expect(evidence).toHaveLength(observed.calls.length);
      expect(evidence.map((a) => a.tool_input)).toEqual(c.responses.map((r: any) => r.content[0].input));
      expect(evidence.every((a) => a.requested_model === MODEL)).toBe(true);
    }
  });

  test('transport failures and missing tool output are explicit without persisting error secrets', async () => {
    const error = Object.assign(new Error('not-for-receipts'), { status: 429 });
    const stub = stubClient([error, { content: [], usage: {}, model: RESOLVED }]);
    const evidence: Cat35JudgeAttempt[] = [];
    const result = await scoreGrounding({ label: 'facts:t', claims: ['Claim'], transcript: 'Source' }, { client: stub.client, evidence });
    expect(result).toEqual({ results: [], judge_failed: true, cost_usd: 0, input_tokens: 0, output_tokens: 0 });
    expect(evidence.map((a) => a.status)).toEqual(['transport_error', 'missing_tool_input']);
    expect(evidence[0].error).toEqual({ name: 'Error', status: 429 });
    expect(evidence[0].resolved_model).toBeNull();
    expect(evidence[1].resolved_model).toBe(RESOLVED);
    expect(evidence.map((a) => a.tool_input)).toEqual([null, null]);
    expect(JSON.stringify(evidence)).not.toContain('not-for-receipts');
  });

  test('empty no-call work does not create judge attempts or change false failure flags', async () => {
    const stub = stubClient([]);
    const evidence: Cat35JudgeAttempt[] = [];
    const cfg = { client: stub.client, evidence };
    expect(await scoreGrounding({ label: 'empty', claims: [], transcript: '' }, cfg))
      .toEqual({ results: [], judge_failed: false, cost_usd: 0, input_tokens: 0, output_tokens: 0 });
    expect(await scoreSalienceCoverage({ lane: 'dream', transcript_id: 't', document: '', items: [] }, cfg))
      .toEqual({ verdicts: [], judge_failed_ids: [], input_tokens: 0, output_tokens: 0, cost_usd: 0 });
    expect(await confirmDistractorLeaks({ document: '', hits: [] }, cfg))
      .toEqual({ confirmed: [], judge_failed: false, cost_usd: 0 });
    expect((await scoreUsabilityChecklist({ transcript_id: 't', pages: [], hasGoldVibes: false }, cfg)).judge_failed).toBe(false);
    expect(stub.calls).toEqual([]);
    expect(evidence).toEqual([]);
  });
});

function runnerPreload(): string {
  return `
import { mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const root = ${JSON.stringify(ROOT)};
globalThis.fetch = async () => { throw new Error('Network forbidden in Cat35 evidence test'); };
const tids = ['coding-reflection-01', 'coding-reflection-02', 'pure-routine-01', 'pure-routine-02'];
const gold = Object.fromEntries(tids.map(t => [t, JSON.parse(readFileSync(join(root, 'eval/data/transcript-distill-v1/gold', t + '.json'), 'utf8'))]));
const paraphrase = 'This paraphrased evidence supports our decision';
class Engine {
  pages = new Map();
  async connect() {}
  async initSchema() {}
  async disconnect() {}
  async setConfig() {}
  async getPage(slug) { return this.pages.get(slug) ?? null; }
  async executeRaw() {
    return [
      ...gold[tids[0]].distractors.slice(0, 2).map(d => ({ fact: d.anchor, kind: 'fact', entity_slug: null, notability: 'high', source_markdown_slug: 'session/' + tids[0] })),
      { fact: 'This is only an editorial opinion', kind: 'fact', entity_slug: null, notability: 'low', source_markdown_slug: 'session/' + tids[0] },
      { fact: gold[tids[1]].distractors[0].anchor, kind: 'fact', entity_slug: null, notability: 'high', source_markdown_slug: 'session/' + tids[1] },
    ];
  }
}
mock.module('gbrain/pglite-engine', () => ({ PGLiteEngine: Engine }));
mock.module('gbrain/ai/gateway', () => ({ configureGateway() {} }));
mock.module('gbrain/import-file', () => ({ async importFromContent() {} }));
mock.module(join(root, 'node_modules/gbrain/src/core/transcripts/ingest.ts'), () => ({
  async runTranscriptsIngest(engine) {
    for (const tid of tids) {
      const g = gold[tid];
      engine.pages.set('session/' + tid, { compiled_truth: readFileSync(join(root, 'eval/data/transcript-distill-v1/transcripts-txt', g.base_ts.slice(0, 10) + '-' + tid + '.txt'), 'utf8') });
    }
    return { pages: { imported: 3 }, sessionsImported: 3, sessionsSeen: 4, cleanScan: true,
      files: [{ sessions: tids.map(tid => ({ sessionId: 'cat35-' + tid, baseSlug: 'session/' + tid, parts: 1, ...(tid === tids[3] ? { error: 'stub ingest failure' } : {}) })) }] };
  }
}));
mock.module(join(root, 'node_modules/gbrain/src/commands/extract-conversation-facts.ts'), () => ({
  async runExtractConversationFactsCore() { return { total_cost_usd: 0 }; }
}));
mock.module(join(root, 'node_modules/gbrain/src/core/cycle/synthesize.ts'), () => ({
  async runPhaseSynthesize(engine, opts) {
    const tid = basename(opts.inputFile).slice(11, -4);
    if (tid === tids[3]) throw new Error('stub dream failure');
    const body = tid === tids[0] ? '- ' + paraphrase + '.\\n' + gold[tid].distractors.slice(0, 2).map(d => '- ' + d.anchor + '.').join('\\n')
      : tid === tids[1] ? '# No factual claims\\n> ' + gold[tid].distractors[0].anchor : '';
    engine.pages.set('notes/' + tid, { compiled_truth: body });
    return { status: 'ok', details: { verdicts: [{ score: 0.8 }], written_slugs: ['notes/' + tid] } };
  }
}));
const attempts = new Map();
const client = { messages: { async create(req) {
  const tool = req.tools[0].name;
  const text = req.messages[0].content;
  const key = tool + text;
  const attempt = (attempts.get(key) ?? 0) + 1;
  attempts.set(key, attempt);
  let input;
  if (tool === 'score_salient_items') {
    const ids = [...text.matchAll(/item_id=([^:]+):/g)].map(m => m[1]);
    const isDream = text.includes(paraphrase);
    input = { items: ids.map((id, i) => ({ item_id: id, status: isDream && i === 0 ? 'FULL' : 'ABSENT', evidence: isDream && i === 0 ? paraphrase : '' })) };
  } else if (tool === 'grade_claims') {
    const label = JSON.parse(text.match(/<batch label=(.*)>/)[1]);
    if (label === 'facts:' + tids[1]) {
      if (attempt === 1) throw Object.assign(new Error('stub transport failure'), { status: 529 });
      input = { claims: [] };
    } else if (label === 'hazard:' + gold[tids[1]].hazards[0].hazard_id) {
      return { model: ${JSON.stringify(RESOLVED)}, content: [], usage: { input_tokens: 10, output_tokens: 5 } };
    } else {
      const indexes = [...text.matchAll(/^  (\\d+):/gm)].map(m => Number(m[1]));
      input = { claims: indexes.map(index => ({ index, verifiable: index !== 2, grounded: index === 0 })) };
    }
  } else if (tool === 'confirm_leaks') {
    const ids = [...text.matchAll(/distractor_id=([^:]+):/g)].map(m => m[1]);
    input = { leaks: text.includes('# No factual claims') ? [] : ids.map((id, i) => ({ distractor_id: id, surfaced_as_salient: i === 0 })) };
  } else if (tool === 'usability_checklist') {
    const ids = req.tools[0].input_schema.properties.checks.items.properties.id.enum;
    input = { checks: text.includes('# No factual claims') ? [] : ids.map(id => ({ id, pass: true })) };
  } else throw new Error('Unknown judge tool ' + tool);
  return { model: ${JSON.stringify(RESOLVED)}, content: [{ type: 'tool_use', id: 'stub', name: tool, input }], usage: { input_tokens: 10, output_tokens: 5 } };
} } };
const judges = await import(join(root, 'eval/runner/cat35-judges.ts'));
const exports = { ...judges };
for (const name of ['scoreGrounding', 'scoreSalienceCoverage', 'confirmDistractorLeaks', 'scoreUsabilityChecklist']) {
  const original = judges[name];
  exports[name] = (args, cfg) => original(args, { ...cfg, client });
}
mock.module(join(root, 'eval/runner/cat35-judges.ts'), () => exports);
`;
}

function runHermeticRunner(
  transcripts = 'coding-reflection-01,coding-reflection-02,pure-routine-01,pure-routine-02',
  lanes = 'verbatim,facts,dream',
) {
  const dir = mkdtempSync(join(tmpdir(), 'cat35-native-evidence-'));
  try {
    mkdirSync(join(dir, 'eval/data'), { recursive: true });
    symlinkSync(join(ROOT, 'eval/data/transcript-distill-v1'), join(dir, 'eval/data/transcript-distill-v1'));
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
    symlinkSync(join(ROOT, 'package.json'), join(dir, 'package.json'));
    writeFileSync(join(dir, 'preload.ts'), runnerPreload());
    const proc = Bun.spawnSync([
      process.execPath, '--preload', join(dir, 'preload.ts'),
      join(ROOT, 'eval/runner/cat35-transcript-distill.ts'), '--json', '--transcripts',
      transcripts, '--lanes', lanes,
    ], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir, ANTHROPIC_API_KEY: 'stub-only', OPENAI_API_KEY: 'stub-only', CAT35_JUDGE_MODEL: MODEL },
      timeout: 30_000,
    });
    expect(proc.exitCode, proc.stderr.toString()).toBe(1);
    const receipt = JSON.parse(proc.stdout.toString());
    const reports = join(dir, 'eval/reports/cat35-transcript-distill');
    const saved = readdirSync(reports).find(p => p.endsWith('-cat35-bpre.json'))!;
    expect(JSON.parse(readFileSync(join(reports, saved), 'utf8'))).toEqual(receipt);
    return receipt;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Cat35 native receipt reconstruction', () => {
  test('a no-call run retains empty output without inventing a leakage aggregate or judge denominator', () => {
    const r = runHermeticRunner('pure-routine-01', 'dream');
    expect(r.judge_failed_rate).toBe(0);
    expect(r.native_evidence.judge_calls).toBe(0);
    expect(r.native_evidence.judge_failures).toBe(0);
    expect(r.native_evidence.judge_events).toEqual([]);
    expect(r.native_evidence.judge_attempts).toEqual([]);
    expect(r.hallucination).toEqual({});
    expect(r.distractor_leakage).toEqual({});
    expect(r.native_evidence.grounding).toEqual([{
      transcript_id: 'pure-routine-01', lane: 'dream', status: 'empty_output',
      judge_event_id: null, claims: [], results: [],
    }]);
    expect(r.native_evidence.distractors).toHaveLength(4);
    expect(r.native_evidence.distractors.every((d: any) => d.denominator_eligible && d.scan_status === 'empty_output')).toBe(true);
  }, 30_000);

  test('a completely failed grounding batch retains inputs and an empty result, not synthetic false claims', () => {
    const r = runHermeticRunner('coding-reflection-02', 'facts');
    expect(r.hallucination).toEqual({ facts: { claims: 0, verifiable: 0, ungrounded: 0, rate: 0 } });
    expect(r.judge_failed_rate).toBe(1 / 3);
    expect(r.native_evidence.judge_events).toHaveLength(3);
    expect(r.native_evidence.judge_attempts).toHaveLength(4);
    expect(r.native_evidence.grounding).toHaveLength(1);
    const g = r.native_evidence.grounding[0];
    expect(g.status).toBe('judge_failed');
    expect(g.claims).toHaveLength(1);
    expect(g.results).toEqual([]);
    expect(r.native_evidence.judge_attempts.filter((a: any) => a.event_id === g.judge_event_id)
      .map((a: any) => [a.status, a.tool_input])).toEqual([
      ['transport_error', null], ['tool_input', { claims: [] }],
    ]);
  }, 30_000);

  test('all three native metrics reconstruct from observed evidence with exact denominators', () => {
    const r = runHermeticRunner();
    const e = r.native_evidence;
    expect(e.schema_version).toBe(1);
    expect(e.judge_accounting_unit).toBe('runner_judge_invocation_after_retries');
    expect(e.judge_attempt_unit).toBe('provider_client_messages_create_attempt');
    expect(e.judge_calls).toBe(21);
    expect(e.judge_failures).toBe(4);
    expect(e.judge_events).toHaveLength(21);
    expect(e.judge_attempts).toHaveLength(25);
    expect(e.judge_events.filter((j: any) => j.judge_failed)).toHaveLength(4);
    expect(r.judge_failed_rate).toBe(4 / 21);
    expect(new Set(e.judge_events.map((j: any) => j.event_id)).size).toBe(21);
    expect(new Set(e.judge_events.map((j: any) => j.purpose))).toEqual(new Set([
      'coverage', 'joint_grounding', 'hallucination', 'distractor_confirmation', 'usability', 'hazard',
    ]));
    for (const event of e.judge_events) {
      const attempts = e.judge_attempts.filter((a: any) => a.event_id === event.event_id);
      expect(attempts.map((a: any) => a.attempt)).toEqual(event.judge_failed ? [1, 2] : [1]);
      expect(event.judge_failed).toBe(event.purpose === 'coverage' ? event.result.judge_failed_ids.length > 0 : event.result.judge_failed);
    }
    expect(e.judge_events.some((j: any) => j.transcript_id === 'pure-routine-02')).toBe(false);
    expect(e.judge_events.filter((j: any) => j.transcript_id === 'pure-routine-01').map((j: any) => j.purpose)).toEqual(['usability']);

    const hallucination: Record<string, any> = {};
    for (const g of e.grounding) {
      if (!g.judge_event_id) {
        expect(g.claims).toEqual([]);
        expect(g.results).toEqual([]);
        continue;
      }
      expect(e.judge_events.find((j: any) => j.event_id === g.judge_event_id).result.results).toEqual(g.results);
      const bucket = hallucination[g.lane] ??= { claims: 0, verifiable: 0, ungrounded: 0, rate: 0 };
      if (g.status === 'judge_failed') {
        expect(g.claims.length).toBeGreaterThan(0);
        expect(g.results).toEqual([]);
        continue;
      }
      bucket.claims += g.claims.length;
      expect(g.results.map((c: any) => c.claim)).toEqual(g.claims);
      for (const claim of g.results) {
        if (claim.verifiable) {
          bucket.verifiable++;
          if (!claim.grounded) bucket.ungrounded++;
        }
      }
    }
    for (const b of Object.values(hallucination)) b.rate = b.verifiable ? b.ungrounded / b.verifiable : 0;
    expect(hallucination).toEqual(r.hallucination);
    expect(r.hallucination).toEqual({
      facts: { claims: 3, verifiable: 2, ungrounded: 1, rate: 0.5 },
      dream: { claims: 3, verifiable: 2, ungrounded: 1, rate: 0.5 },
    });
    expect(e.grounding.find((g: any) => g.lane === 'dream' && g.transcript_id === 'coding-reflection-02').status).toBe('no_claims');
    expect(e.grounding.find((g: any) => g.lane === 'dream' && g.transcript_id === 'pure-routine-01').status).toBe('empty_output');
    expect(e.grounding.find((g: any) => g.lane === 'dream' && g.transcript_id === 'pure-routine-02').status).toBe('lane_error');

    const leakage: Record<string, any> = {};
    for (const lane of r.lanes) {
      const rows = e.distractors.filter((d: any) => d.lane === lane);
      if (!rows.some((d: any) => d.scan_status === 'scanned')) continue;
      const hits = rows.filter((d: any) => d.anchor_hit === true).length;
      const confirmed = rows.filter((d: any) => ['verbatim_hit', 'confirmed'].includes(d.confirmation)).length;
      const denominator = rows.filter((d: any) => d.denominator_eligible).length;
      leakage[lane] = { hits, confirmed, denominator, rate: denominator ? confirmed / denominator : 0 };
    }
    expect(leakage).toEqual(r.distractor_leakage);
    expect(r.distractor_leakage).toEqual({
      verbatim: { hits: 12, confirmed: 12, denominator: 12, rate: 1 },
      facts: { hits: 3, confirmed: 2, denominator: 12, rate: 2 / 12 },
      dream: { hits: 3, confirmed: 1, denominator: 12, rate: 1 / 12 },
    });
    expect(e.distractors).toHaveLength(48);
    expect(new Set(e.distractors.map((d: any) => [d.transcript_id, d.lane, d.distractor_id].join(':'))).size).toBe(48);
    const empty = e.distractors.filter((d: any) => d.scan_status === 'empty_output');
    expect(empty).toHaveLength(8);
    expect(empty.every((d: any) => d.denominator_eligible && d.anchor_hit === null && d.confirmation === 'not_scanned' && d.judge_event_id === null)).toBe(true);
    const errors = e.distractors.filter((d: any) => d.scan_status === 'lane_error');
    expect(errors).toHaveLength(12);
    expect(errors.every((d: any) => !d.denominator_eligible && d.anchor_hit === null && d.judge_event_id === null)).toBe(true);
    expect(e.distractors.filter((d: any) => d.confirmation === 'judge_failed')).toHaveLength(1);
    expect(e.distractors.filter((d: any) => d.confirmation === 'rejected')).toHaveLength(2);
    expect(r.judge_models_resolved).toEqual({ [RESOLVED]: 24 });
    expect(r.gates.judge_failed_rate).toBe(false);
    expect(r.gate_pass).toBe(false);
  }, 30_000);
});
