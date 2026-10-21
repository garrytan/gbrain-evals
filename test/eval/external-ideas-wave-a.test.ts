/**
 * External ideas wave A (GBRA-162): the freeze's per-arm config passthrough,
 * the affected set, answer cells over the batch lane (identity, reconcile,
 * failure rows, judge-only recovery), the analysis and its decision rule, the
 * bracket audit's insertion finder, the keyless preflight, and the synthetic
 * relative-date generator. No network, no money.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetRun, closeLedgers, initLedger } from '../../eval/runner/budget-ledger.ts';
import { freeze, productArmSpecs, withArmConfig } from '../../eval/runner/evidence-delivery/freeze.ts';
import type { GbrainModules } from '../../eval/runner/evidence-delivery/gbrain.ts';
import type { FrozenQuestion } from '../../eval/runner/evidence-delivery/store.ts';
import type { Renderer } from '../../eval/runner/evidence-delivery/arms.ts';
import { bodySha, buildManifest } from '../../eval/runner/batch/manifest.ts';
import { readerBody } from '../../eval/runner/batch/sources.ts';
import { anthropicTransport, openAiTransport } from '../../eval/runner/batch/transport.ts';
import { BatchLane } from '../../eval/runner/batch/submit.ts';
import { answerStep } from '../../eval/runner/external-ideas-wave-a/answer.ts';
import {
  analyze, auditCandidates, bracketInsertions, computeAffected, decide, loadStudyManifest, preflightProblems, readRows, validateStudyManifest, verdicts,
  type AffectedReport, type AnswerRow, type PreflightFacts,
} from '../../eval/runner/external-ideas-wave-a/lib.ts';
import { addDays, diffDays, exactPastPhrases, generate, KINDS, longDate, serialize, SYNTHETIC_PATH, weekday } from '../../eval/runner/external-ideas-wave-a/synthetic-dates.ts';
import { FakeProvider } from './batch-fake-provider.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'xia-')); dirs.push(d); return d; };
const lanes: BatchLane[] = [];
afterEach(() => {
  for (const l of lanes.splice(0)) l.close();
  closeLedgers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// ─── Freeze config passthrough ──────────────────────────────────────

class FakeEngine {
  config = new Map<string, string>();
  calls: string[] = [];
  pages = new Map<string, string>();
  ids = new Map<string, number>();
  async getConfig(k: string) { this.calls.push(`get ${k}`); return this.config.get(k) ?? null; }
  async setConfig(k: string, v: string) { this.calls.push(`set ${k}=${v}`); this.config.set(k, v); }
  async unsetConfig(k: string) { this.calls.push(`unset ${k}`); return this.config.delete(k) ? 1 : 0; }
  async getChunks(slug: string) { return [{ id: this.ids.get(slug)!, page_id: this.ids.get(slug)!, chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: this.pages.get(slug)! }]; }
  async disconnect() {}
}

function fakeGbrain(dir: string, engine: FakeEngine, assembled: Array<{ unit: string; flag: string | null }>): GbrainModules {
  return {
    dir,
    harness: { createBenchmarkBrain: async () => engine, resetTables: async (e: FakeEngine) => { e.pages.clear(); e.ids.clear(); } },
    adapter: { haystackToPages: (q: any) => q.haystack_sessions.map((s: any[], i: number) => ({ slug: `chat/s${i}`, content: s.map(t => `**${t.role}:** ${t.content}`).join('\n\n') })) },
    importFile: { importFromContent: async (e: FakeEngine, slug: string, content: string) => { e.pages.set(slug, content); e.ids.set(slug, e.ids.size + 1); return null; } },
    hybrid: { hybridSearch: async (e: FakeEngine, _q: string, o: { limit: number }) => [...e.pages.keys()].slice(0, o.limit).map((slug, i) => ({ slug, page_id: e.ids.get(slug), chunk_id: e.ids.get(slug), chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: e.pages.get(slug), rerank_score: 1 - i / 10, score: 1 })) },
    embedCache: { EmbeddingCache: class { withTransaction(fn: () => unknown) { return fn(); } stats() { return { misses: 0 }; } close() {} } as any, installEmbedCache: () => ({ uninstall() {}, model: 'm', dims: 1 }) },
    tokens: { estimateTokens: (s: string) => Math.ceil(s.length / 4) },
    gateway: { configureGateway: () => {}, chat: async () => { throw new Error('no chat in tests'); } },
    buildGatewayConfig: (c: unknown) => c,
    evidence: {
      assembleEvidenceForHits: async (e: any, input: any) => {
        const flag = (await e.getConfig('search.evidence_resolve_dates')) ?? null;
        assembled.push({ unit: input.return_unit, flag });
        const on = flag === 'true';
        const results = input.hits.map((h: any) => ({ slug: h.slug, chunk_id: h.chunk_id, page_id: h.chunk_id, chunk_text: e.pages.get(h.slug) + (on && input.return_unit === 'auto' ? ' [≈2023-05-07]' : ''), delivered: { unit: input.return_unit, tokens: 10 } }));
        return { results, delivery: { budget_tokens: 24000, fallbacks: [], ...(on ? { relative_dates: { insertions: results.length } } : {}) }, unresolved: [] };
      },
      evidenceFingerprint: (r: unknown[]) => sha(JSON.stringify(r)),
    },
  } as unknown as GbrainModules;
}

function gitRepo(): string {
  const d = tmp();
  mkdirSync(join(d, 'src'));
  writeFileSync(join(d, 'src/x.ts'), 'export {};\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'pipe' });
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'init');
  return d;
}

const question = (id: string) => ({
  question_id: id, question: 'When did I adopt the dog?', question_date: '2023/05/30 (Tue) 10:00', question_type: 'temporal-reasoning',
  haystack_dates: ['2023/05/20 (Sat) 10:00', '2023/05/25 (Thu) 10:00'], haystack_session_ids: ['a', 'b'],
  haystack_sessions: [[{ role: 'user', content: 'I adopted the dog two weeks ago.' }, { role: 'assistant', content: 'Nice.' }], [{ role: 'user', content: 'Vet visit was yesterday.' }]],
});

async function runFreeze(arms: any[]) {
  const engine = new FakeEngine();
  const assembled: Array<{ unit: string; flag: string | null }> = [];
  const g = fakeGbrain(gitRepo(), engine, assembled);
  const outDir = tmp();
  const manifest = { arms, candidate_commits: { gbrain: null }, retrieval: { mode: 'balanced' } } as any;
  const res = await freeze({ g, manifest, manifestSha: 'm', outDir, inputs: ['q1', 'q2'].map(id => ({ question: question(id) as any, set: 'confirmatory' as const })), embedCachePath: join(outDir, 'cache.sqlite'), datasetSha: 'd', smoke: true, log: () => {} });
  expect(res.errors).toEqual([]);
  const lines = readFileSync(join(outDir, 'frozen-manifest.jsonl'), 'utf8').trim().split('\n');
  const header = JSON.parse(readFileSync(join(outDir, 'frozen-header.json'), 'utf8'));
  return { lines, header, engine, assembled };
}

const AUTO = { id: 'auto', source: 'product', unit: 'auto', budget_tokens: null, sets: ['all'] };
const AUTO_DATES = { ...AUTO, id: 'auto_dates', config: { 'search.evidence_resolve_dates': 'true' } };

describe('freeze: per-arm config passthrough', () => {
  test('an arm without config freezes byte-identically whether or not a config arm runs beside it', async () => {
    const a = await runFreeze([AUTO]);
    const b = await runFreeze([AUTO_DATES, AUTO]);
    expect(a.lines.length).toBe(2);
    for (let i = 0; i < a.lines.length; i++) {
      const lineB = JSON.parse(b.lines[i]);
      const { auto_dates, ...rest } = lineB.arms;
      expect(auto_dates.blocks.length).toBeGreaterThan(0);
      expect(JSON.stringify({ ...lineB, arms: rest })).toBe(a.lines[i]);
    }
    expect(JSON.stringify(b.header.product_arms.auto)).toBe(JSON.stringify(a.header.product_arms.auto));
    expect('config' in a.header.product_arms.auto).toBe(false);
    expect(b.header.product_arms.auto_dates.config).toEqual({ 'search.evidence_resolve_dates': 'true' });
  });

  test('the config is on only during its own arm and the key is unset afterwards', async () => {
    const b = await runFreeze([AUTO_DATES, AUTO]);
    const autoCalls = b.assembled.filter(x => x.unit === 'auto');
    expect(autoCalls.map(x => x.flag)).toEqual(['true', null, 'true', null]);
    expect(b.assembled.filter(x => x.unit === 'chunk').every(x => x.flag === null)).toBe(true);
    expect(b.engine.config.has('search.evidence_resolve_dates')).toBe(false);
    const a = await runFreeze([AUTO]);
    expect(a.engine.calls.some(c => c.includes('evidence_resolve_dates') && !c.startsWith('get'))).toBe(false);
  });

  test('withArmConfig restores a prior value, unsets a new key, survives a throw, and leaves the engine alone without config', async () => {
    const e = new FakeEngine();
    await e.setConfig('k', 'old');
    e.calls = [];
    expect(await withArmConfig(e, undefined, async () => 7)).toBe(7);
    expect(e.calls).toEqual([]);
    await withArmConfig(e, { k: 'new', j: '1' }, async () => { expect(e.config.get('k')).toBe('new'); expect(e.config.get('j')).toBe('1'); });
    expect(e.config.get('k')).toBe('old');
    expect(e.config.has('j')).toBe(false);
    await expect(withArmConfig(e, { k: 'boom' }, async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(e.config.get('k')).toBe('old');
  });

  test('productArmSpecs carries config only where the manifest sets it', () => {
    const specs = productArmSpecs({ arms: [AUTO, AUTO_DATES] } as any);
    expect(specs[0]).toEqual({ id: 'auto', unit: 'auto', budget_tokens: null });
    expect(specs[1].config).toEqual({ 'search.evidence_resolve_dates': 'true' });
  });
});

// ─── Affected set ───────────────────────────────────────────────────

const renderer: Renderer = {
  system: 'SYS', maxSessionChars: 60000, sessionIdFromSlug: s => s.replace('chat/', ''),
  renderChatBlock: (s) => ({ rendered: s.map(x => `<chat_session id="${x.session_id}" date="${x.date}">\n${x.body}\n</chat_session>`).join('\n\n'), truncatedCount: 0 }),
  buildReaderUserText: i => `Question:\n${i.question}\n\nCurrent Date: ${i.questionDate}\n\nRetrieved sessions:\n${i.rendered}`,
};

function frozenFixture(spec: Array<{ id: string; type?: string; base: string; dated: string; insertions?: number; fallbacks?: string[] }>) {
  const blobs = new Map<string, string>();
  const put = (t: string) => { const h = sha(t); blobs.set(h, t); return h; };
  const questions: FrozenQuestion[] = spec.map(s => ({
    question_id: s.id, set: 'confirmatory', question_type: s.type ?? 'temporal-reasoning', question_sha256: '', question_date: '2023/05/30 (Tue) 10:00', index_sha256: '', search_meta: { reranked: true, degraded: [] },
    hits5: [], hits10: [], r1: null, pages: [{ slug: 'chat/s1', page_id: 1, date: '2023/05/20 (Sat) 10:00', harness_body: '', chunks: [] }],
    arms: {
      auto: { source: 'product', blocks: [{ slug: 'chat/s1', text: put(s.base) }], evidence_sha256: sha(s.base), product_encoding_tokens: 1, serialized_tool_tokens: 1, duplicate_bodies: 0, delivery: {} },
      auto_dates: { source: 'product', blocks: [{ slug: 'chat/s1', text: put(s.dated) }], evidence_sha256: sha(s.dated), product_encoding_tokens: 1, serialized_tool_tokens: 1, duplicate_bodies: 0, delivery: { fallbacks: s.fallbacks ?? [], relative_dates: { insertions: s.insertions ?? 0 } } },
    },
  }));
  const store = { get: (h: string) => blobs.get(h)! };
  const dataset = new Map(spec.map(s => [s.id, { question: `question ${s.id}`, question_date: '2023/05/30 (Tue) 10:00', question_type: s.type ?? 'temporal-reasoning', answer: 'x' }]));
  return { questions, store, dataset };
}

describe('affected set', () => {
  test('a question is affected exactly when the two requests differ; counts, insertions and fallbacks are reported', () => {
    const f = frozenFixture([
      { id: 'q1', base: '**user:** I adopted the dog two weeks ago.', dated: '**user:** I adopted the dog two weeks ago [≈2023-05-06].', insertions: 1 },
      { id: 'q2', base: '**user:** nothing relative here', dated: '**user:** nothing relative here' },
      { id: 'q3_abs', type: 'multi-session', base: '**user:** last week', dated: '**user:** last week', fallbacks: ['relative_dates_over_budget'] },
    ]);
    const r = computeAffected(f.questions, f.store, renderer, f.dataset, 'F', 'G');
    expect(r.rows.map(x => [x.question_id, x.affected])).toEqual([['q1', true], ['q2', false], ['q3_abs', false]]);
    expect(r.affected).toBe(1);
    expect(r.by_type).toEqual({ 'temporal-reasoning': { questions: 2, affected: 1 }, abstention: { questions: 1, affected: 0 } });
    expect(r.relative_dates).toEqual({ insertions_total: 1, questions_with_insertions: 1, fallbacks: { relative_dates_over_budget: 1, relative_dates_unavailable: 0 } });
    expect(r.rows[1].reader_request_sha256.auto).toBe(r.rows[1].reader_request_sha256.auto_dates);
  });

  test('the audit finds each inserted bracket with its session date', () => {
    const f = frozenFixture([{ id: 'q1', base: '**user:** I adopted the dog two weeks ago and ran last Friday.', dated: '**user:** I adopted the dog two weeks ago [≈2023-05-06] and ran last Friday [2023-05-19].', insertions: 2 }]);
    const { items, unaligned_blocks } = auditCandidates(f.questions, f.store, 300);
    expect(unaligned_blocks).toBe(0);
    expect(items.map(i => i.bracket)).toEqual(['[≈2023-05-06]', '[2023-05-19]']);
    expect(items[0].session_date).toBe('2023/05/20 (Sat) 10:00');
    expect(items[1].context.endsWith('[2023-05-19].')).toBe(true);
  });

  test('bracketInsertions: plain insertions, a pre-existing bracket, and text that is not the original plus brackets', () => {
    expect(bracketInsertions('a b', 'a [2023] b')).toEqual([{ at: 1, bracket: '[2023]' }]);
    expect(bracketInsertions('see [2023] x', 'see [2023] x')).toEqual([]);
    expect(bracketInsertions('x ago.', 'x ago [2023-01-01/2023-01-07].')).toEqual([{ at: 5, bracket: '[2023-01-01/2023-01-07]' }]);
    expect(bracketInsertions('abc', 'abd')).toBeNull();
  });
});

// ─── Analysis and decision rule ─────────────────────────────────────

function affectedReport(ids: Array<[string, boolean]>, type = 'temporal-reasoning'): AffectedReport {
  return {
    schema: 'gbrain-evals/external-ideas-wave-a-affected/v1', frozen_manifest_sha256: 'F', gbrain_commit: 'cfa1a006b64c5baa199142bf0f0b56a0e3fc6c06', reader_system_sha256: 'S', questions: ids.length,
    affected: ids.filter(([, a]) => a).length, by_type: {}, relative_dates: { insertions_total: 0, questions_with_insertions: 0, fallbacks: {} },
    rows: ids.map(([id, affected]) => ({ question_id: id, question_type: type, affected, insertions: affected ? 1 : 0, reader_request_sha256: { auto: 'a', auto_dates: affected ? 'b' : 'a' }, evidence_sha256: { auto: 'a', auto_dates: 'b' } })),
  };
}

function row(id: string, arm: 'auto' | 'auto_dates', sample: number, official: 0 | 1 | null, extra: Partial<AnswerRow> = {}): AnswerRow {
  return {
    schema: 'gbrain-evals/external-ideas-wave-a-row/v1', question_id: id, question_type: 'temporal-reasoning', arm, sample, model: 'claude-sonnet-5-5', set: 'all',
    request_sha256: 'r', reader_request_sha256: 'r', evidence_sha256: 'e', product_fingerprint: null,
    batch: { arm_id: 'x', intent_id: 'i', status: 'succeeded', finish: 'stop', response_model: null, service_tier: 'batch' }, usage: null, usd: 0, list_usd: 0,
    hypothesis: 'h', reader_error: null, official_correct: official, official: {}, framed_correct: official, framed: {}, primary_judge: 'official_correct', identity: {}, ts: '', ...extra,
  };
}

const run = (rows: AnswerRow[], aff: AffectedReport, samples = [1]) => analyze({ rows, affected: aff, model: 'claude-sonnet-5-5', samples, seed: 20261021, draws: 10000, alpha: 0.05, suite: 'longmemeval' });

/** n questions; the first ‘wins’ go 0 -> 1, the next ‘losses’ go 1 -> 0, the rest stay at ‘base’. Every question is affected. */
function scenario(n: number, wins: number, losses: number, base: 0 | 1 = 1) {
  const ids = Array.from({ length: n }, (_, i) => `q${String(i).padStart(3, '0')}`);
  const rows = ids.flatMap((id, i) => {
    const [a, b] = i < wins ? [0, 1] : i < wins + losses ? [1, 0] : [base, base];
    return [row(id, 'auto', 1, a as 0 | 1), row(id, 'auto_dates', 1, b as 0 | 1)];
  });
  return { rows, aff: affectedReport(ids.map(id => [id, true])) };
}

describe('analysis', () => {
  test('unaffected questions reuse auto exactly; the score is the mean of two samples', () => {
    const aff = affectedReport([['q1', true], ['q2', false]]);
    const rows = [row('q1', 'auto', 1, 0), row('q1', 'auto', 2, 1), row('q1', 'auto_dates', 1, 1), row('q1', 'auto_dates', 2, 1), row('q2', 'auto', 1, 1), row('q2', 'auto', 2, 0)];
    const a = run(rows, aff, [1, 2]);
    expect(a.complete).toBe(true);
    expect(a.per_question).toMatchObject([{ question_id: 'q1', auto: 0.5, auto_dates: 1 }, { question_id: 'q2', auto: 0.5, auto_dates: 0.5 }]);
    expect(a.primary.net_gain).toBeCloseTo(0.5, 12);
    expect(a.reader_noise).toMatchObject({ questions: 2, discordant: 2 });
  });

  test('when the judges disagree, the official verdict drives the score', () => {
    const aff = affectedReport([['q1', true]]);
    const rows = [row('q1', 'auto', 1, 1, { framed_correct: 0 }), row('q1', 'auto_dates', 1, 0, { framed_correct: 1 })];
    const a = run(rows, aff);
    expect(a.primary.net_gain).toBe(-1);
    expect(a.framed_judge.net_gain).toBe(1);
    expect(a.judge_agreement).toMatchObject({ rows: 2, agree: 0, official_yes_framed_no: 1, official_no_framed_yes: 1 });
  });

  const failureCases: Array<[string, (rows: AnswerRow[]) => AnswerRow[], string]> = [
    ['a reader error (batch item errored)', rs => [rs[0], row('q1', 'auto_dates', 1, null, { reader_error: 'reader_errored', hypothesis: '' })], 'reader_errored'],
    ['an expired batch item', rs => [rs[0], row('q1', 'auto_dates', 1, null, { reader_error: 'reader_expired', hypothesis: '' })], 'reader_expired'],
    ['a result missing from the batch', rs => [rs[0], row('q1', 'auto_dates', 1, null, { reader_error: 'reader_missing', hypothesis: '' })], 'reader_missing'],
    ['an output-limit stop', rs => [rs[0], row('q1', 'auto_dates', 1, null, { reader_error: 'reader_max_tokens', hypothesis: '' })], 'reader_max_tokens'],
    ['an official judge error', rs => [rs[0], row('q1', 'auto_dates', 1, null, { framed_correct: 1 })], 'official_judge_error'],
    ['a framed judge error', rs => [rs[0], row('q1', 'auto_dates', 1, 1, { framed_correct: null })], 'framed_judge_error'],
    ['a missing cell', rs => [rs[0]], 'missing_cell'],
  ];
  for (const [name, mutate, kind] of failureCases) {
    test(`${name} makes the run incomplete, never success-shaped`, () => {
      const aff = affectedReport([['q1', true]]);
      const a = run(mutate([row('q1', 'auto', 1, 1), row('q1', 'auto_dates', 1, 1)]), aff);
      expect(a.complete).toBe(false);
      expect(a.verdict).toBe('incomplete');
      expect(a.failures.counts[kind]).toBe(1);
    });
  }

  test('decision: a clear gain passes', () => {
    const { rows, aff } = scenario(100, 12, 0);
    const a = run(rows, aff);
    expect(a.primary.net_gain).toBe(12);
    expect(a.primary.p_one_sided_greater).toBeLessThan(0.01);
    expect(a.primary.lower_bound_one_sided_net_gain!).toBeGreaterThan(0);
    expect(a.verdict).toBe('pass');
  });

  test('decision: a positive point estimate whose test and bound fail reads inconclusive', () => {
    const { rows, aff } = scenario(100, 3, 1);
    const a = run(rows, aff);
    expect(a.primary.net_gain).toBe(2);
    expect(a.primary.p_one_sided_greater).toBeGreaterThan(0.05);
    expect(a.verdict).toBe('inconclusive');
    expect(decide(true, { net_gain: 2, p_one_sided_greater: 0.04, p_one_sided_less: 0.99, lower_bound_one_sided_net_gain: -0.5 }, 0.05)).toBe('inconclusive');
  });

  test('decision: a significant loss is a regression', () => {
    const { rows, aff } = scenario(100, 0, 10);
    expect(run(rows, aff).verdict).toBe('regression');
  });

  test('the per-type table and affected-only line add up', () => {
    const { rows, aff } = scenario(10, 2, 1);
    const a = run(rows, aff);
    expect(a.by_type['temporal-reasoning']).toMatchObject({ questions: 10, affected: 10, net_gain: 1 });
    expect(a.affected_only?.net_gain).toBe(1);
  });
});

// ─── Answer cells over the batch lane ───────────────────────────────

function cellSetup(n = 3, statePath?: string, fake = new FakeProvider(), ledgerPath?: string) {
  const dir = tmp();
  if (!ledgerPath) { ledgerPath = join(dir, 'ledger.sqlite'); initLedger({ ledgerPath, programCapUsd: 10, reason: 'test' }); }
  const runB = BudgetRun.open({ runner: 'xia-test', budgetUsd: 5, ledgerPath });
  const transports = { openai: openAiTransport({ fetchImpl: fake.fetch, apiKey: 't' }), anthropic: anthropicTransport({ fetchImpl: fake.fetch, apiKey: 't' }) };
  const lane = new BatchLane({ statePath: statePath ?? join(dir, 'state.sqlite'), transports, run: runB, parallel: true, now: () => fake.clock, log: () => {} });
  lanes.push(lane);
  const bodies = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < n; i++) bodies.set(`q${i}`, readerBody('claude-sonnet-5-5', { system: 'SYS', user: `Question:\nq${i}\n\nRetrieved sessions:\n` }, 3500, 3500));
  const manifest = buildManifest({ arm_id: 'auto_dates-all-s1-claude-sonnet-5-5', workstream: 't', kind: 'reader', provider: 'anthropic', model: 'claude-sonnet-5-5', max_output_tokens: 3500, reasoning_effort: 'low', protocol: { name: 'p', sha256: 's' }, source: 't', denominator: n, bodies, outputFloor: 3500 });
  const judged: string[] = [];
  let judgeFails = false;
  const ctx = {
    lane, manifest, bodies, expected: new Map([...bodies].map(([id, b]) => [id, bodySha(b)])),
    meta: new Map([...bodies.keys()].map(id => [id, { question_type: 'temporal-reasoning', reader_request_sha256: 'r', evidence_sha256: 'e', product_fingerprint: null }])),
    cell: { arm: 'auto_dates' as const, sample: 1, model: 'claude-sonnet-5-5' }, set: 'all' as const, rowsFile: join(dir, 'rows', 'auto_dates__s1__claude-sonnet-5-5.ndjson'), identity: {},
    judge: async (id: string) => { judged.push(id); return judgeFails ? verdicts({ off_judge_error: 'http_500' }, { judge_correct: true }) : verdicts({ off_judge_correct: true }, { judge_correct: false }); },
  };
  return { dir, ledgerPath, fake, lane, ctx, judged, failJudges: (v: boolean) => { judgeFails = v; } };
}

describe('answer cells', () => {
  test('errored and expired batch items become error rows that are not judged, and the analysis is incomplete', async () => {
    const s = cellSetup(3);
    const first = await answerStep(s.ctx);
    expect(first.submitted?.pilot).toBe(true);
    s.fake.finish(first.submitted!.batch_id!, (_c, _b, i) => (i === 0 ? { kind: 'ok' } : i === 1 ? { kind: 'error' } : { kind: 'expired' }));
    const second = await answerStep(s.ctx);
    expect(second.written).toBe(3);
    expect(second.done).toBe(true);
    expect(second.failed.sort()).toEqual(['q1', 'q2']);
    const rows = readRows(s.ctx.rowsFile).sort((a, b) => a.question_id.localeCompare(b.question_id));
    expect(rows.map(r => r.reader_error)).toEqual([null, 'reader_errored', 'reader_expired']);
    expect(s.judged).toEqual(['q0']);
    const aff = affectedReport([['q0', true], ['q1', true], ['q2', true]]);
    const autoRows = ['q0', 'q1', 'q2'].map(id => row(id, 'auto', 1, 1));
    const a = run([...autoRows, ...rows.map(r => ({ ...r, model: 'claude-sonnet-5-5' }))], aff);
    expect(a.complete).toBe(false);
    expect(a.failures.counts).toMatchObject({ reader_errored: 1, reader_expired: 1 });
  });

  test('a batch submitted but never collected is reconciled by its batch id; nothing is resubmitted', async () => {
    const fake = new FakeProvider();
    const statePath = join(tmp(), 'state.sqlite');
    const s1 = cellSetup(3, statePath, fake);
    const first = await answerStep(s1.ctx);
    expect(fake.submissions.length).toBe(1);
    s1.lane.close(); lanes.splice(lanes.indexOf(s1.lane), 1);
    const s2 = cellSetup(3, statePath, fake, s1.ledgerPath);
    const again = await answerStep({ ...s2.ctx, rowsFile: s1.ctx.rowsFile });
    expect(again.open).toBe(1);
    expect(again.submitted).toBeNull();
    expect(fake.submissions.length).toBe(1);
    fake.finish(first.submitted!.batch_id!);
    const collected = await answerStep({ ...s2.ctx, rowsFile: s1.ctx.rowsFile });
    expect(collected.written).toBe(3);
    expect(collected.done).toBe(true);
    expect(fake.submissions.length).toBe(1);
  });

  test('judge-only recovery re-judges settled answers from their stored text without a new reader request', async () => {
    const s = cellSetup(2);
    const first = await answerStep(s.ctx);
    s.fake.finish(first.submitted!.batch_id!);
    s.failJudges(true);
    await answerStep(s.ctx);
    expect(readRows(s.ctx.rowsFile).every(r => r.official_correct === null)).toBe(true);
    s.failJudges(false);
    const rec = await answerStep({ ...s.ctx, judgeOnly: true });
    expect(rec.rejudged).toBe(2);
    expect(s.fake.submissions.length).toBe(1);
    const rows = readRows(s.ctx.rowsFile);
    expect(rows.length).toBe(4);
    expect(rows.slice(2).map(r => [r.official_correct, r.framed_correct, r.hypothesis])).toEqual([[1, 0, rows[0].hypothesis], [1, 0, rows[1].hypothesis]]);
  });

  test('resume refuses a row from another cell or another request', async () => {
    const s = cellSetup(2);
    mkdirSync(join(s.dir, 'rows'), { recursive: true });
    appendFileSync(s.ctx.rowsFile, JSON.stringify(row('q0', 'auto_dates', 1, 1, { request_sha256: 'deadbeef' })) + '\n');
    await expect(answerStep(s.ctx)).rejects.toThrow('row_identity_mismatch');
    writeFileSync(s.ctx.rowsFile, JSON.stringify(row('q0', 'auto_dates', 2, 1, { request_sha256: s.ctx.expected.get('q0')! })) + '\n');
    await expect(answerStep(s.ctx)).rejects.toThrow('row_identity_mismatch');
    expect(s.fake.submissions.length).toBe(0);
  });
});

// ─── Preflight ──────────────────────────────────────────────────────

describe('preflight', () => {
  const { manifest } = loadStudyManifest();
  const header = { gbrain: { commit: manifest.candidate_commits.gbrain }, dataset_sha256: manifest.data.longmemeval_s.sha256, smoke: false } as any;
  const ok: PreflightFacts = {
    header, gbrainHead: manifest.candidate_commits.gbrain!, gbrainStatus: '', datasetSha: manifest.data.longmemeval_s.sha256, env: { ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'y' }, keys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    smoke: false, manifest, readerSystemSha: manifest.reader.system_sha256, codeSha: { ...manifest.pinned_code_sha256 }, needsPrereg: true, attest: () => ({}),
  };
  test('the committed study manifest is valid and a clean setup passes', () => {
    expect(validateStudyManifest(manifest)).toEqual([]);
    expect(preflightProblems(ok)).toEqual([]);
  });
  const cases: Array<[string, Partial<PreflightFacts>]> = [
    ['gbrain_commit_mismatch', { gbrainHead: '0'.repeat(40) }],
    ['gbrain_tree_dirty', { gbrainStatus: ' M src/x.ts' }],
    ['dataset_sha_mismatch', { datasetSha: 'f'.repeat(64) }],
    ['missing_api_key', { env: { OPENAI_API_KEY: 'y' } }],
    ['reader_prompt_changed', { readerSystemSha: 'e'.repeat(64) }],
    ['pinned_code_mismatch', { codeSha: { ...manifest.pinned_code_sha256, 'src/core/temporal-grammar.ts': null } }],
    ['smoke_freeze', { header: { ...header, smoke: true } }],
    ['prereg_not_attested', { attest: () => { throw new Error('preregistration is not committed'); } }],
  ];
  for (const [code, patch] of cases) {
    test(`${code} is reported with a fix and names keys, never values`, () => {
      const problems = preflightProblems({ ...ok, ...patch });
      const p = problems.find(x => x.code === code);
      expect(p?.fix.length).toBeGreaterThan(0);
      if (code === 'missing_api_key') { expect(p!.message).toBe('ANTHROPIC_API_KEY is not set'); expect(JSON.stringify(problems)).not.toContain('"y"'); }
    });
  }
  test('smoke runs skip the preregistration and pin checks only', () => {
    const p = preflightProblems({ ...ok, smoke: true, header: { ...header, smoke: true }, attest: () => { throw new Error('no'); } });
    expect(p).toEqual([]);
  });
});

// ─── Synthetic generator ────────────────────────────────────────────

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYNAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const NUM: Record<string, number> = { two: 2, three: 3, four: 4, five: 5 };

/** Test-side oracle: resolve the one relative phrase in a sentence against its session day, without the generator's tables. */
function resolveSentence(sentence: string, sessionDay: string): string {
  const s = sentence.toLowerCase();
  let m: RegExpExecArray | null;
  if (/\byesterday\b/.test(s)) return addDays(sessionDay, -1);
  if ((m = /\b(two|three|four|five) days ago\b/.exec(s))) return addDays(sessionDay, -NUM[m[1]]);
  if (/\ba week ago\b/.test(s)) return addDays(sessionDay, -7);
  if ((m = /\b(two|three) weeks ago\b/.exec(s))) return addDays(sessionDay, -7 * NUM[m[1]]);
  if ((m = /\blast (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.exec(s))) {
    let d = addDays(sessionDay, -1);
    while (DAYNAMES[weekday(d)] !== m[1]) d = addDays(d, -1);
    return d;
  }
  throw new Error(`no phrase in ${sentence}`);
}

const isoOf = (lme: string) => lme.slice(0, 10).replace(/\//g, '-');
const fromLong = (s: string) => { const m = /(\w+) (\d+), (\d{4})/.exec(s)!; return `${m[3]}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`; };

describe('synthetic relative-date generator', () => {
  const qs = generate();
  test('is deterministic and matches the committed file byte for byte', () => {
    expect(serialize(generate())).toBe(serialize(qs));
    const committed = readFileSync(SYNTHETIC_PATH, 'utf8');
    expect(serialize(qs)).toBe(committed);
    expect(sha(committed)).toBe(loadStudyManifest().manifest.data.synthetic.sha256);
  });

  test('shape: 60 questions, 15 per kind, 6 to 10 sessions on distinct days, gold sessions labeled, year boundaries present', () => {
    expect(qs.length).toBe(60);
    for (const k of KINDS) expect(qs.filter(q => q.question_id.startsWith(`synth-${k}-`)).length).toBe(15);
    for (const q of qs) {
      expect(q.haystack_sessions.length).toBeGreaterThanOrEqual(6);
      expect(q.haystack_sessions.length).toBeLessThanOrEqual(10);
      expect(new Set(q.haystack_dates.map(isoOf)).size).toBe(q.haystack_dates.length);
      expect(q.answer_session_ids.every(id => id.startsWith('answer_') && q.haystack_session_ids.includes(id))).toBe(true);
      expect(diffDays(isoOf(q.haystack_dates.at(-1)!), isoOf(q.question_date))).toBeGreaterThan(0);
    }
    expect(qs.filter(q => q.haystack_dates[0].slice(0, 4) !== q.haystack_dates.at(-1)!.slice(0, 4)).length).toBeGreaterThanOrEqual(10);
  });

  test('hand-checked items', () => {
    const by = new Map(qs.map(q => [q.question_id, q]));
    // 2024-01-21 "four days ago" = Jan 17; 2024-02-09 "three weeks ago" = Jan 19.
    expect(by.get('synth-between-01')!.answer).toBe('2 days (January 17, 2024 to January 19, 2024)');
    // 2023-07-06 is a Thursday; "last Saturday" = July 1.
    expect(by.get('synth-date-02')!.answer).toBe('July 1, 2023');
    // 2024-04-30 "two days ago" = Apr 28; question date 2024-09-05 is 130 days later.
    expect(by.get('synth-ago-02')!.answer).toBe('130 days (April 28, 2024)');
    // 2023-08-25 "five days ago" = Aug 20; 2023-09-04 "three weeks ago" = Aug 14, mentioned later but 6 days earlier.
    expect(by.get('synth-order-02')!.answer).toBe('Baking the lemon cake came first (August 14, 2023), 6 days before fixing the kitchen faucet (August 20, 2023).');
  });

  test('every gold answer matches an independent resolution of the gold sentences', () => {
    for (const q of qs) {
      const events = q.haystack_sessions.flatMap((s, i) => s.filter(t => t.has_answer).map(t => ({ day: resolveSentence(t.content.split(/(?<=[.!])\s/)[0], isoOf(q.haystack_dates[i])), session: i })));
      const kind = q.question_id.split('-')[1];
      if (kind === 'between') {
        expect(events.length).toBe(2);
        const [a, b] = events;
        expect(q.answer).toBe(`${diffDays(a.day, b.day)} days (${longDate(a.day)} to ${longDate(b.day)})`.replace(/^1 days/, '1 day'));
        expect(diffDays(a.day, b.day)).toBeGreaterThan(0);
      } else if (kind === 'date') {
        expect(events.length).toBe(1);
        expect(fromLong(q.answer)).toBe(events[0].day);
      } else if (kind === 'ago') {
        expect(events.length).toBe(1);
        expect(q.answer.startsWith(`${diffDays(events[0].day, isoOf(q.question_date))} day`)).toBe(true);
      } else {
        expect(events.length).toBe(2);
        const [earlierSession, laterSession] = events;
        expect(diffDays(laterSession.day, earlierSession.day)).toBeGreaterThan(0);
        expect(q.answer).toContain(`(${longDate(laterSession.day)}), ${diffDays(laterSession.day, earlierSession.day)} day`);
      }
    }
  });

  test('"last <weekday>" is offered only inside the previous calendar week and at least two days back', () => {
    for (let i = 0; i < 14; i++) {
      const day = addDays('2024-01-01', i);
      for (const p of exactPastPhrases(day).filter(x => x.text.startsWith('last '))) {
        expect(-p.offset).toBeGreaterThanOrEqual(2);
        expect(weekday(addDays(day, p.offset))).toBeGreaterThan(weekday(day));
      }
    }
  });
});
