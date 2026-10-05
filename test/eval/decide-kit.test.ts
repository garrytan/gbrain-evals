import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { evaluateFamily, validateFamily, type ComparisonFamily } from '../../eval/runner/stats/gates.ts';
import { clusteredPairedDelta, superiorityP } from '../../eval/runner/stats/paired.ts';
import { newSpec, templateSources, validateSpec, type Plan } from '../../eval/runner/decisions/spec.ts';
import { computeSplit, loadSplit, splitOrder } from '../../eval/runner/decisions/splits.ts';
import { DecideError, exitCodeFor, renderOperatorMessage } from '../../eval/runner/decisions/errors.ts';
import { beamManifest, loadFixture, occurrenceId, renderSessionPage, DATASET_ROOT, LOCOMO_FILE, loadLocomo } from '../../eval/runner/memory-qa/corpus.ts';
import { scoreRetrieval, selectQuestions } from '../../eval/runner/memory-qa/run.ts';
import { combine, main, planJobs } from '../../eval/runner/decide.ts';

const REPO = resolve(import.meta.dir, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'decide-kit-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const family = (comparisons: ComparisonFamily['comparisons'], extra: Partial<ComparisonFamily> = {}): ComparisonFamily => ({
  schema_version: 1, family_id: 'sup', registered_at: '2026-10-04', alpha: 0.05, seed: 7, draws: 5000, id_field: 'id', comparisons, ...extra,
});
const rows = (n: number, value: (i: number) => Record<string, unknown>) => Array.from({ length: n }, (_, i) => ({ id: `q${i}`, conv: `c${Math.floor(i / 10)}`, ...value(i) }));

describe('superiority gate', () => {
  const sup = (minEffect: number) => family([{ id: 'r', metric: 'r', gate: 'superiority', direction: 'higher', min_effect: minEffect, cluster_by: 'conv' }]);
  test('a clear, spread-out improvement passes; the same improvement fails a larger minimum effect', () => {
    const a = rows(300, () => ({ r: 0 }));
    const b = rows(300, i => ({ r: i % 3 === 0 ? 1 : 0 }));
    expect(evaluateFamily(a, b, sup(0)).verdict).toBe('pass');
    expect(evaluateFamily(a, b, sup(0.5)).verdict).not.toBe('pass');
  });
  test('a demonstrated loss fails and no difference is inconclusive', () => {
    const a = rows(300, () => ({ r: 1 }));
    expect(evaluateFamily(a, rows(300, i => ({ r: i % 2 ? 0 : 1 })), sup(0)).verdict).toBe('fail');
    expect(evaluateFamily(a, rows(300, () => ({ r: 1 })), sup(0)).verdict).toBe('inconclusive');
  });
  test('too few clusters can never pass', () => {
    const a = rows(30, () => ({ r: 0 }));
    const b = rows(30, () => ({ r: 1 }));
    expect(evaluateFamily(a, b, sup(0)).comparisons[0].status).toBe('inconclusive');
  });
  test('validation requires a minimum effect and a cluster', () => {
    expect(() => validateFamily(family([{ id: 'r', metric: 'r', gate: 'superiority', direction: 'higher', cluster_by: 'id' } as never]))).toThrow('min_effect');
    expect(() => validateFamily(family([{ id: 'r', metric: 'r', gate: 'superiority', direction: 'higher', min_effect: 0 } as never]))).toThrow('cluster_by');
  });
  test('superiorityP is the share of bootstrap draws at or below the minimum effect', () => {
    const pairs = Array.from({ length: 200 }, (_, i) => ({ id: `q${i}`, cluster: `c${i % 40}`, a: 0, b: i % 2 }));
    const stats = clusteredPairedDelta(pairs, { seed: 1, draws: 2000 });
    expect(superiorityP(stats, 0, 'higher')!).toBeLessThan(0.01);
    expect(superiorityP(stats, 0.9, 'higher')!).toBeGreaterThan(0.99);
  });
});

describe('decision specs', () => {
  test('every plan template is a valid dev spec', () => {
    for (const plan of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'] as Plan[]) {
      const spec = newSpec({ decisionId: `${plan.toLowerCase()}-t`, plan, title: 't', verdictType: 'quality', candidate: null, baseline: null });
      expect(spec.sources.length).toBeGreaterThan(0);
      for (const s of spec.sources) if (s.kind === 'category') expect(existsSync(join(REPO, s.script))).toBe(true);
      expect(templateSources(plan).notes.length).toBeGreaterThan(20);
    }
  });
  test('a dev spec cannot name a sealed split, and errors carry the next command', () => {
    const spec = newSpec({ decisionId: 'x-sealed', plan: 'P6', title: 't', verdictType: 'quality', candidate: null, baseline: null });
    const bad = { ...spec, sources: [{ ...spec.sources[0], split: 'sealed' }] };
    try { validateSpec(bad, 'd.json'); throw new Error('accepted a sealed split'); }
    catch (e) {
      expect(e).toBeInstanceOf(DecideError);
      const op = (e as DecideError).op;
      expect(op.code).toBe('SPEC_INVALID');
      expect(op.message).toContain('dev specs may only name dev splits');
      expect(renderOperatorMessage(op)).toContain('next: run `bun run eval:decide check');
    }
  });
  test('ask_user messages exit 3, run messages exit 2', () => {
    expect(exitCodeFor({ code: 'CUSTODY_MISSING', message: 'm', why: 'w', fix: { next: 'ask_user', user_message: 'u' } })).toBe(3);
    expect(exitCodeFor({ code: 'ROWS_MISSING', message: 'm', why: 'w', fix: { next: 'run', argv: ['x'] } })).toBe(2);
  });
});

describe('splits', () => {
  test('ordering is deterministic and splits never overlap', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `conv-${i}`);
    expect(splitOrder(ids)).toEqual(splitOrder([...ids].reverse()));
    const s = computeSplit('x', ids, 0.3, 'n');
    expect(s.dev.length).toBe(6);
    expect(s.dev.filter(id => s.sealed.includes(id))).toEqual([]);
  });
  test('committed BEAM splits match the manifest ids recomputed', () => {
    const m = beamManifest();
    for (const size of ['100k', '500k', '1m']) {
      const committed = loadSplit(`beam-${size}`);
      const again = computeSplit(`beam-${size}`, m.sizes[size].map(c => c.conversation), 0.3, '');
      expect(committed.dev).toEqual(again.dev);
      expect(committed.sealed).toEqual(again.sealed);
    }
  });
  test('LongMemEval-S is all dev and LoCoMo has seven sealed conversations', () => {
    expect(loadSplit('lme-s').sealed).toEqual([]);
    expect(loadSplit('lme-s').dev.length).toBe(500);
    expect(loadSplit('locomo').dev.length).toBe(3);
    expect(loadSplit('locomo').sealed.length).toBe(7);
  });
});

describe('corpus and scoring', () => {
  test('rendered pages carry dates and turns but no ids', () => {
    const fx = loadFixture();
    const s = fx.conversations[0].sessions[1];
    const page = renderSessionPage(s);
    expect(page).toContain('date: "2026-02-11"');
    expect(page).not.toContain(s.id + '\n');
    expect(occurrenceId('a', 's1')).not.toBe(occurrenceId('b', 's1'));
    expect(occurrenceId('a', 's1')).toMatch(/^[0-9a-f]{16}$/);
  });
  test('LoCoMo categories follow the file, adversarial questions have no gold', () => {
    if (!existsSync(join(DATASET_ROOT, LOCOMO_FILE.path))) return;
    const c = loadLocomo();
    const counts: Record<string, number> = {};
    for (const q of c.questions) counts[q.category] = (counts[q.category] ?? 0) + 1;
    expect(counts).toEqual({ 'multi-hop': 282, temporal: 321, 'open-domain': 96, 'single-hop': 841, adversarial: 446 });
    expect(c.questions.filter(q => q.abstention).every(q => q.gold.length === 0)).toBe(true);
  });
  test('retrieval metrics count distinct sessions', () => {
    expect(scoreRetrieval(['a', 'b', 'c', 'd', 'e', 'f'], ['b', 'f'])).toMatchObject({ recall_all_at_5: 0, recall_any_at_5: 1, recall_all_at_10: 1 });
    expect(scoreRetrieval(['b', 'f'], ['b', 'f']).ndcg_at_10).toBe(1);
  });
  test('question selection is seeded and stratified by category', () => {
    const qs = loadFixture().questions;
    const a = selectQuestions(qs, 4, 1).map(q => q.id);
    expect(selectQuestions(qs, 4, 1).map(q => q.id)).toEqual(a);
    expect(new Set(selectQuestions(qs, 4, 1).map(q => q.category)).size).toBe(4);
  });
});

describe('dev workflow', () => {
  test('paid flags reach only sources that spend money, and only with a budget run', () => {
    const spec = newSpec({ decisionId: 'p7-jobs', plan: 'P7', title: 't', verdictType: 'quality', candidate: null, baseline: null });
    const jobs = planJobs(spec, '/r', { shards: 2, only: null, budgetRunId: 'run-1' });
    const n9 = jobs.filter(j => j.source.id.startsWith('n9'));
    const lme = jobs.filter(j => j.source.id.startsWith('lme-s'));
    expect(n9.every(j => !j.argv.includes('--paid'))).toBe(true);
    expect(lme.length).toBe(4);
    expect(lme.every(j => j.argv.includes('--paid') && j.argv.includes('run-1') && j.argv.includes('--split'))).toBe(true);
    expect(planJobs(spec, '/r', { shards: 1, only: null, budgetRunId: null }).some(j => j.argv.includes('--paid'))).toBe(false);
  });
  test('combine: invalid beats everything, then fail, then inconclusive', () => {
    const v = (verdict: string) => ({ source: 's', verdict, arms: {} }) as never;
    expect(combine([v('pass'), v('invalid')])).toBe('invalid');
    expect(combine([v('pass'), v('fail'), v('inconclusive')])).toBe('fail');
    expect(combine([v('pass'), v('inconclusive')])).toBe('inconclusive');
    expect(combine([v('pass'), v('report_only')])).toBe('pass');
  });
  test('the keyless fixture walkthrough runs init, preflight, dev and verdict', async () => {
    const out = join(tmp, 'fx');
    expect(await main(['init', '--fixture', '--id', 'fx-test', '--out', out])).toBe(0);
    expect(await main(['preflight', '--decision', out])).toBe(0);
    expect(await main(['dev', '--decision', out])).toBe(0);
    expect(await main(['verdict', '--decision', out])).toBe(0);
    const verdict = JSON.parse(readFileSync(join(out, 'runs', 'verdict.json'), 'utf8'));
    expect(verdict.stage).toBe('dev');
    expect(verdict.eligible_for_default).toBe(false);
    expect(verdict.sources[0].family.comparisons[0].n_pairs).toBe(7);
  }, 120_000);
  test('held-out commands are refused until their milestone, with a reason', async () => {
    expect(await main(['seal-run', '--decision', tmp])).toBe(2);
    expect(await main(['nonsense'])).toBe(2);
  });
});

describe('reading lane', () => {
  const { judgePromptsFor, packSessions, repeatsTrap, ChatClient } = require('../../eval/runner/memory-qa/qa.ts') as typeof import('../../eval/runner/memory-qa/qa.ts');
  const q = (over: Record<string, unknown>) => ({ id: 'x', conversation: 'c', question: 'When?', category: 'temporal', gold: ['s1'], abstention: false, answer: 'May 2023', ...over }) as never;
  test('judges follow the benchmark: temporal off-by-one, unanswerable for abstention, one prompt per rubric item', () => {
    expect(judgePromptsFor('locomo', q({}), 'r')[0]).toContain('off-by-one');
    expect(judgePromptsFor('locomo', q({ abstention: true, category: 'adversarial' }), 'r')[0]).toContain('unanswerable');
    expect(judgePromptsFor('lme-s', q({ category: 'knowledge-update' }), 'r')[0]).toContain('updated answer');
    expect(judgePromptsFor('beam-100k', q({ rubric: ['a', 'b', 'c'] }), 'r')).toHaveLength(3);
  });
  test('packing keeps retrieval order, whole sessions, and the token budget', () => {
    const s = (id: string, n: number) => ({ id, date: '2024-01-01', turns: [{ speaker: 'user', content: 'x'.repeat(n) }] });
    const ranked = [s('a', 400), s('b', 4000), s('c', 400)];
    expect(packSessions(ranked, 5, null).sessions.map(x => x.id)).toEqual(['a', 'b', 'c']);
    expect(packSessions(ranked, 5, 300).sessions.map(x => x.id)).toEqual(['a']);
    expect(packSessions(ranked, 2, null).sessions.map(x => x.id)).toEqual(['a', 'b']);
  });
  test('trap detection matches the planted answer, not unrelated text', () => {
    expect(repeatsTrap('She realized that self-care is important.', 'self-care is important')).toBe(true);
    expect(repeatsTrap('The conversation never says.', 'self-care is important')).toBe(false);
  });
  test('replicates are separate provider calls, never one cached answer', async () => {
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: `answer ${calls}` } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 }); }) as never;
    try {
      const c = new ChatClient(join(tmp, 'qa-cache'));
      const a0 = await c.chat('openai:gpt-4o-mini', 'p', { maxTokens: 5, replicate: 0 });
      const a1 = await c.chat('openai:gpt-4o-mini', 'p', { maxTokens: 5, replicate: 1 });
      const again = await c.chat('openai:gpt-4o-mini', 'p', { maxTokens: 5, replicate: 0 });
      expect(calls).toBe(2);
      expect(a0.text).not.toBe(a1.text);
      expect(again.cached).toBe(true);
    } finally { globalThis.fetch = real; }
  });
});

describe('facts lane', () => {
  const { factsReaderPrompt, unresolvedRelativeTime } = require('../../eval/runner/memory-qa/qa.ts') as typeof import('../../eval/runner/memory-qa/qa.ts');
  const { isoSessionDate } = require('../../eval/runner/memory-qa/corpus.ts') as typeof import('../../eval/runner/memory-qa/corpus.ts');
  test('session dates normalize to ISO for both benchmark formats; conversation pages carry type and ISO date', () => {
    expect(isoSessionDate('1:56 pm on 8 May, 2023')).toBe('2023-05-08T13:56:00');
    expect(isoSessionDate('12:05 am on 1 January, 2024')).toBe('2024-01-01T00:05:00');
    expect(isoSessionDate('2023/05/20 (Sat) 02:21')).toBe('2023-05-20T02:21:00');
    expect(isoSessionDate('sometime')).toBeNull();
    const s = { id: 's1', date: '1:56 pm on 8 May, 2023', turns: [{ speaker: 'Ana', content: 'hi' }] };
    expect(renderSessionPage(s, { as: 'conversation' })).toContain('type: conversation\ndate: "2023-05-08T13:56:00"');
    expect(renderSessionPage(s)).toContain('type: note\ndate: "1:56 pm on 8 May, 2023"');
  });
  test('a fact is unresolved only with a relative time word and no absolute date', () => {
    expect(unresolvedRelativeTime('Ana went to a support group yesterday')).toBe(true);
    expect(unresolvedRelativeTime('Ana ran a race last Saturday')).toBe(true);
    expect(unresolvedRelativeTime('Ana moved here 3 years ago')).toBe(true);
    expect(unresolvedRelativeTime('Ana went to a support group on 7 May 2023')).toBe(false);
    expect(unresolvedRelativeTime('Ana likes painting')).toBe(false);
  });
  test('the facts reader sees fact text and stored date, not sessions', () => {
    const p = factsReaderPrompt({ id: 'x', conversation: 'c', question: 'When did Ana run?', category: 'temporal', gold: [], abstention: false } as never,
      [{ fact: 'Ana ran a race', valid_from: '2023-05-06T00:00:00.000Z' }, { fact: 'Ana paints', valid_from: null }], '2023-06-01');
    expect(p).toContain('- [2023-05-06] Ana ran a race');
    expect(p).toContain('- [undated] Ana paints');
    expect(p).toContain('Current Date: 2023-06-01');
  });
  test('facts sources pass --facts and --qa-context, and count as paid', () => {
    const spec = newSpec({ decisionId: 'p2-facts', plan: 'P2', title: 't', verdictType: 'quality', candidate: null, baseline: null });
    spec.sources = [{ ...templateSources('P2').sources.find(s => s.kind === 'memory-qa' && s.benchmark === 'locomo')!, embed: 'hash', facts: 'conversation', qa: { mode: 'reader', runs: 1, sessions: 5, context: 'facts' } } as never];
    const jobs = planJobs(spec, '/r', { shards: 1, only: null, budgetRunId: 'run-1' });
    expect(jobs.every(j => j.argv.includes('--facts') && j.argv.includes('conversation') && j.argv.includes('--qa-context') && j.argv.includes('--paid'))).toBe(true);
    expect(() => validateSpec({ ...spec, sources: [{ ...spec.sources[0], facts: undefined }] })).toThrow(/qa.context facts/);
  });
});

describe('anchor exclusion', () => {
  test('drops dev probes that touch a sealed anchor and reports only a count', async () => {
    const { sealedAnchors, excludeSealedAnchors } = await import('../../eval/runner/decisions/anchors.ts');
    const n9 = await sealedAnchors('n9');
    expect(n9.size).toBeGreaterThan(50);
    const anyAnchor = [...n9].find(a => a.includes('/'))!;
    const r = excludeSealedAnchors([{ a: [anyAnchor] }, { a: ['people/not-in-any-sealed-set-example'] }], p => p.a, n9);
    expect(r.dropped).toBe(1);
    expect(r.kept).toHaveLength(1);
    const world = await sealedAnchors('world-v1-relational');
    expect(world.size).toBeGreaterThan(10);
  });
});
