/**
 * Adversarial checks the independent evaluator must catch (plan amendment 6):
 * known rankings, label permutations, metadata removal, duplicate ids, an
 * empty system, wrong answers, and deliberately broken adapters that leak
 * gold, return nothing, or return duplicates.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPayload, checkPayload, InputAllowlistError, withPermitted, type Boundary } from '../../eval/runner/evaluator/allowlist.ts';
import { GoldStore } from '../../eval/runner/evaluator/gold-store.ts';
import { scoreGradedRanking, scoreSessionRecall } from '../../eval/runner/evaluator/reference-scorer.ts';
import {
  buildLongMemEvalGold, lmeForbiddenValues, lmeQuestionMaterial, lmeSessionMaterial, loadLongMemEvalGold, longMemEvalSutView, scoreLmeRetrieval,
  LME_READER_INPUT, LME_SUT_PAGE, LME_SUT_QUERY,
} from '../../eval/runner/evaluator/longmemeval.ts';
import { assertCat13Alignment, cat13ForbiddenValues, cat13GoldFromProbes, CAT13_SUT_PAGE, CAT13_SUT_QUERY } from '../../eval/runner/evaluator/cat13.ts';
import { loadCat13Gold } from '../../eval/runner/evaluator/cat13-gold-loader.ts';
import { normalizeSessions, parseOpts, renderSession, run as runLongMemEval, scoreQuestion, sutPages, type NdjsonRow, type Question } from '../../eval/runner/longmemeval.ts';
import { buildProbes, loadCorpus, scoreAdapter, TOP_K, type Probe } from '../../eval/runner/cat13-conceptual.ts';
import { ndcgAtK, precisionAtK } from '../../eval/runner/metrics.ts';
import { ProbeAccounting } from '../../eval/runner/probe-accounting.ts';
import { seededRandom } from '../../eval/runner/stats/paired.ts';
import { evaluateFamily } from '../../eval/runner/stats/gates.ts';
import { sanitizePage, type Adapter, type Page, type PublicQuery, type RankedDoc } from '../../eval/runner/types.ts';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const lmeQuestions: Question[] = [
  { question_id: 'fixture-q1', question_type: 'single-session-user', question: 'Where did I leave the spare key?', answer: 'Under the blue planter.',
    haystack_session_ids: ['answer_7c1e02aa', 'sharegpt_Lk2pW9x_0', 'e27891d3_2'], haystack_dates: ['2023/05/20 (Sat) 10:00', '2023/05/21 (Sun) 10:00', '2023/05/22 (Mon) 10:00'],
    haystack_sessions: [[{ role: 'user', content: 'I put the spare key under the blue planter.' }], [{ role: 'user', content: 'Recommend a podcast.' }], [{ role: 'user', content: 'The planter is blue.' }]],
    answer_session_ids: ['answer_7c1e02aa'] },
  { question_id: 'fixture-q2', question_type: 'multi-session', question: 'How many cartons did we move in total?', answer: '7',
    haystack_session_ids: ['cartons', 'moving-day-2', 'unrelated-chat'], haystack_dates: ['2023/06/01 (Thu) 09:00', '2023/06/02 (Fri) 09:00', '2023/06/03 (Sat) 09:00'],
    haystack_sessions: [[{ role: 'user', content: 'We moved three cartons today.' }], [{ role: 'user', content: 'Four more cartons went up.' }], [{ role: 'user', content: 'Lunch ideas?' }]],
    answer_session_ids: ['cartons', 'moving-day-2'] },
];

const fixed = (rankings: Record<string, string[]>): Adapter => ({
  name: 'fixed', async init() { return {}; },
  async query(q: PublicQuery): Promise<RankedDoc[]> { return (rankings[q.id] ?? []).map((page_id, i) => ({ page_id, score: 1 - i / 10, rank: i + 1 })); },
});

describe('input allowlist', () => {
  const boundary: Boundary = { name: 'test@1', recipient: 'reader', schema: { type: 'object', fields: {
    text: { type: 'string' }, items: { type: 'array', items: { type: 'object', fields: { slug: { type: 'string', pattern: /^chat\/s-[0-9a-f]{10}$/ } } } }, note: { type: 'string', optional: true },
  } } };
  const good = { text: 'hello', items: [{ slug: 'chat/s-0123456789' }] };

  test('accepts exactly the declared plain-data shape', () => {
    expect(checkPayload(boundary, good)).toEqual([]);
    expect(checkPayload(boundary, { ...good, note: 'optional' })).toEqual([]);
  });

  test('rejects undeclared fields at any depth, not just ones named like answers', () => {
    expect(checkPayload(boundary, { ...good, question_type: 'multi-session' })).toEqual(['$.question_type: field not allowlisted']);
    expect(checkPayload(boundary, { ...good, items: [{ slug: 'chat/s-0123456789', relevant: true }] })).toEqual(['$.items[0].relevant: field not allowlisted']);
    expect(checkPayload(boundary, { text: 'hello' })).toEqual(['$.items: required field missing']);
    expect(checkPayload(boundary, { ...good, items: [{ slug: 'chat/answer_7c1e02aa' }] })[0]).toContain('does not match');
  });

  test('rejects hidden routes back to evaluator state', () => {
    const store = new GoldStore('g', [['q', { secret: 'x' }]]);
    expect(checkPayload(boundary, store)[0]).toContain('expected plain object, got GoldStore');
    expect(checkPayload(boundary, { ...good, text: store })[0]).toBe('$.text: expected string');
    expect(checkPayload(boundary, Object.defineProperty({ ...good }, 'text', { get: () => 'x', enumerable: true }))[0]).toBe('$.text: accessor property');
    expect(checkPayload(boundary, { ...good, [Symbol('gold')]: 1 })[0]).toBe('$: symbol-keyed property');
    expect(checkPayload(boundary, Object.assign(Object.create({ inherited: 1 }), good))[0]).toContain('expected plain object');
    expect(checkPayload(boundary, { ...good, items: Object.assign([{ slug: 'chat/s-0123456789' }], { gold: ['x'] }) })[0]).toContain('extra properties gold');
    expect(checkPayload(boundary, { ...good, items: new Map() as unknown as unknown[] })[0]).toBe('$.items: expected plain array');
  });

  test('evaluator-only values are refused beyond what the source material accounts for', () => {
    const forbidden = [{ value: 'e27891d3_2', label: 'raw session id' }];
    expect(checkPayload(boundary, { ...good, text: 'see E27891D3_2' }, forbidden)[0]).toContain('contains evaluator-only value (raw session id) 1 time(s), source material accounts for 0');
    const permitted = withPermitted(forbidden, ['the user once typed e27891d3_2 in chat']);
    expect(checkPayload(boundary, { ...good, text: 'the user once typed e27891d3_2 in chat' }, permitted)).toEqual([]);
    expect(checkPayload(boundary, { ...good, text: 'the user once typed e27891d3_2 in chat', note: 'e27891d3_2' }, permitted)[0]).toContain('2 time(s)');
    expect(() => checkPayload(boundary, good, [{ value: 'ab', label: 'short' }])).toThrow('shorter than');
    expect(() => assertPayload(boundary, { ...good, extra: 1 })).toThrow(InputAllowlistError);
  });
});

describe('reference scorer: known rankings and agreement with the runners\' historical scorers', () => {
  test('hand-computed session recall', () => {
    const s = scoreSessionRecall(['A', 'x', 'b', 'a'], ['a', 'b'], 5);
    expect(s).toMatchObject({ recall_all: 1, recall_any: 1, abs_noise: 2 / 5, duplicates: 1, returned: 4 });
    expect(s.ndcg_any).toBeCloseTo((1 + 1 / Math.log2(4)) / (1 + 1 / Math.log2(3)), 12);
    expect(scoreSessionRecall(['a', 'x'], ['a', 'b'], 1)).toMatchObject({ recall_all: 0, recall_any: 1 });
    expect(Number.isNaN(scoreSessionRecall(['a'], [], 5).recall_all)).toBe(true);
  });

  test('hand-computed graded ranking; repeated pages keep their slot and earn nothing', () => {
    const grades = { 'concepts/a': 3, 'concepts/n': 1 };
    expect(scoreGradedRanking(['concepts/a', 'concepts/n'], grades, ['concepts/a'], 5)).toMatchObject({ ndcg: 1, precision: 0.4, top1_strict: 1 });
    const dup = scoreGradedRanking(['concepts/a', 'concepts/a', 'concepts/a', 'concepts/a', 'concepts/a'], grades, ['concepts/a'], 5);
    expect(dup).toMatchObject({ precision: 0.2, duplicates: 4, top1_strict: 1 });
    expect(dup.ndcg).toBeCloseTo(3 / (3 + 1 / Math.log2(3)), 12);
    expect(scoreGradedRanking(['concepts/n', 'concepts/a'], grades, ['concepts/a'], 5).top1_strict).toBe(0);
  });

  test('2,000 random cases agree with scoreQuestion and metrics.ts', () => {
    const rng = seededRandom(20260929);
    const pool = Array.from({ length: 12 }, (_, i) => `id-${i}`);
    const pick = (n: number) => Array.from({ length: n }, () => pool[Math.floor(rng() * pool.length)]);
    for (let c = 0; c < 2000; c++) {
      const retrieved = pick(Math.floor(rng() * 9)).map(id => rng() < 0.2 ? id.toUpperCase() : id);
      const gold = [...new Set(pick(1 + Math.floor(rng() * 3)))];
      const k = 1 + Math.floor(rng() * 6);
      const legacy = scoreQuestion(retrieved, gold, k), mine = scoreSessionRecall(retrieved, gold, k);
      for (const key of ['recall_all', 'recall_any', 'ndcg_any', 'abs_noise'] as const) expect(mine[key]).toBeCloseTo(legacy[key], 12);
      const grades = new Map(gold.map((id, i) => [id, i === 0 ? 3 : 1]));
      const ranked = pick(Math.floor(rng() * 8));
      const graded = scoreGradedRanking(ranked, Object.fromEntries(grades), [gold[0]], k);
      expect(graded.ndcg).toBeCloseTo(ndcgAtK(ranked, grades, k), 12);
      expect(graded.precision).toBeCloseTo(precisionAtK(ranked, new Set(gold), k), 12);
    }
  });
});

describe('gold store', () => {
  test('keeps labels private, frozen and out of serialized output', () => {
    const store = buildLongMemEvalGold(lmeQuestions);
    expect(JSON.stringify(store)).not.toContain('answer_7c1e02aa');
    expect(JSON.parse(JSON.stringify(store))).toEqual({ name: 'longmemeval', size: 2, fingerprint: store.fingerprint });
    expect(Object.keys(store)).not.toContain('answer_session_ids');
    const copy = store.read('fixture-q1');
    copy.answer_session_ids.push('tampered');
    expect(store.read('fixture-q1').answer_session_ids).toEqual(['answer_7c1e02aa']);
    expect(() => store.score('fixture-q1', g => { (g.answer_session_ids as string[]).push('x'); })).toThrow();
    expect(() => new GoldStore('dup', [['a', 1], ['a', 2]])).toThrow('duplicate gold id a');
    expect(() => new GoldStore('empty', [])).toThrow('empty gold store');
  });

  test('the separate LongMemEval loader refuses bytes that differ from what the runner read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lme-gold-')); dirs.push(dir);
    const path = join(dir, 'dataset.json');
    writeFileSync(path, JSON.stringify(lmeQuestions));
    const sha = new Bun.CryptoHasher('sha256').update(JSON.stringify(lmeQuestions)).digest('hex');
    expect(loadLongMemEvalGold(path, sha).fingerprint).toBe(buildLongMemEvalGold(lmeQuestions).fingerprint);
    writeFileSync(path, JSON.stringify(lmeQuestions.map(q => ({ ...q, answer_session_ids: ['sharegpt_Lk2pW9x_0'] }))));
    expect(() => loadLongMemEvalGold(path, sha)).toThrow('dataset bytes changed');
  });

  test('the runner\'s question view carries no answer and no evidence labels', () => {
    const view = longMemEvalSutView(lmeQuestions[0]);
    expect(Object.keys(view).sort()).toEqual(['haystack_dates', 'haystack_session_ids', 'haystack_sessions', 'question', 'question_id', 'question_type']);
    expect(JSON.stringify(view)).not.toContain('Under the blue planter');
  });
});

describe('LongMemEval boundaries and broken adapters', () => {
  const gold = buildLongMemEvalGold(lmeQuestions);
  const check = (q: Question, pages: Array<{ slug: string; content: string }>) => {
    const sessions = normalizeSessions(q), forbidden = lmeForbiddenValues(gold, q.question_id);
    return pages.flatMap((page, i) => checkPayload(LME_SUT_PAGE, page, withPermitted(forbidden, lmeSessionMaterial(sessions[i]))));
  };

  test('the real rendering passes, including a session id that is also an ordinary word in the conversation', () => {
    for (const q of lmeQuestions) expect(check(q, sutPages(q).pages)).toEqual([]);
    for (const q of lmeQuestions) expect(checkPayload(LME_SUT_QUERY, { text: q.question }, withPermitted(lmeForbiddenValues(gold, q.question_id), [q.question]))).toEqual([]);
  });

  test('a leaky adapter that renders raw ids is caught whether or not the id starts with answer_', () => {
    const q = lmeQuestions[0];
    const legacy = normalizeSessions(q).map(s => ({ slug: `chat/${s.session_id.toLowerCase()}`, content: renderSession(s) }));
    const violations = check(q, legacy);
    expect(violations.some(v => v.includes('does not match'))).toBe(true);
    expect(violations.some(v => v.includes('raw evidence session id'))).toBe(true);
    expect(violations.some(v => v.includes('raw session id') && !v.includes('evidence'))).toBe(true);
    const { pages } = sutPages(q);
    const quiet = pages.map((p, i) => i === 2 ? { ...p, content: p.content.replace(/session_id: s-[0-9a-f]{10}/, 'session_id: e27891d3_2') } : p);
    expect(check(q, quiet)).toEqual([expect.stringContaining('$.content: contains evaluator-only value (raw session id)')]);
    const tagged = pages.map((p, i) => i === 0 ? { ...p, relevant: true } : p);
    expect(check(q, tagged)).toEqual(['$.relevant: field not allowlisted']);
    const q2 = lmeQuestions[1];
    const rendered = sutPages(q2).pages.map((p, i) => i === 0 ? { ...p, content: p.content.replace(/session_id: s-[0-9a-f]{10}/, 'session_id: cartons') } : p);
    expect(check(q2, rendered)[0]).toContain('2 time(s), source material accounts for 1');
  });

  test('a leaky reader input is refused before any model call', () => {
    const q = lmeQuestions[0];
    const forbidden = withPermitted(lmeForbiddenValues(gold, q.question_id), lmeQuestionMaterial(q));
    const evidence = [{ source_id: 'default', slug: sutPages(q).pages[0].slug, text: 'I put the spare key under the blue planter.' }];
    expect(checkPayload(LME_READER_INPUT, { question: q.question, evidence }, forbidden)).toEqual([]);
    expect(checkPayload(LME_READER_INPUT, { question: q.question, evidence, answer: q.answer }, forbidden)).toEqual(['$.answer: field not allowlisted']);
    expect(checkPayload(LME_READER_INPUT, { question: q.question, evidence: [{ ...evidence[0], slug: 'chat/answer_7c1e02aa' }] }, forbidden).length).toBeGreaterThan(0);
    expect(checkPayload(LME_READER_INPUT, { question: `${q.question} (see answer_7c1e02aa)`, evidence }, forbidden)[0]).toContain('raw evidence session id');
  });

  test('empty, wrong, duplicate and permuted-label outcomes score as they should', () => {
    expect(scoreLmeRetrieval(gold, 'fixture-q1', [], 5)).toMatchObject({ recall_all: 0, recall_any: 0, abs_noise: 0 });
    expect(scoreLmeRetrieval(gold, 'fixture-q1', ['sharegpt_lk2pw9x_0', 'e27891d3_2'], 5)).toMatchObject({ recall_all: 0, recall_any: 0 });
    expect(scoreLmeRetrieval(gold, 'fixture-q2', ['cartons', 'cartons', 'CARTONS', 'unrelated-chat', 'moving-day-2'], 3)).toMatchObject({ recall_all: 1, duplicates: 2, abs_noise: 2 / 3 });
    const perfect = { 'fixture-q1': ['answer_7c1e02aa'], 'fixture-q2': ['cartons', 'moving-day-2'] } as Record<string, string[]>;
    const permuted = buildLongMemEvalGold(lmeQuestions.map((q, i) => ({ ...q, answer_session_ids: lmeQuestions[1 - i].answer_session_ids })));
    expect(Object.entries(perfect).map(([id, r]) => scoreLmeRetrieval(gold, id, r, 5).recall_all)).toEqual([1, 1]);
    expect(Object.entries(perfect).map(([id, r]) => scoreLmeRetrieval(permuted, id, r, 5).recall_all)).toEqual([0, 0]);
    expect(permuted.fingerprint).not.toBe(gold.fingerprint);
  });
});

describe('LongMemEval runner end to end', () => {
  test('scores through the separately loaded gold store and records the evaluator in the receipt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lme-evaluator-')); dirs.push(dir);
    const datasetPath = join(dir, 'dataset.json');
    writeFileSync(datasetPath, JSON.stringify(lmeQuestions));
    const opts = { ...parseOpts([]), datasetPath, datasetName: 'evaluator-fixture', adapters: ['keyword'], keywordOnly: true, topK: 2, noCache: true, minRecallAll: 0,
      output: join(dir, 'report.json'), ndjsonPath: join(dir, 'rows.ndjson'), reportsDir: join(dir, 'reports') };
    const result = await runLongMemEval(opts);
    const evaluator = result.receipt.resolved_config!.evaluator as Record<string, unknown>;
    expect(evaluator.gold_store).toEqual(buildLongMemEvalGold(lmeQuestions).toJSON());
    expect(evaluator.input_allowlist).toEqual([LME_SUT_PAGE.name, LME_SUT_QUERY.name]);
    const rows = readFileSync(opts.ndjsonPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as NdjsonRow);
    expect(rows).toHaveLength(2);
    const gold = buildLongMemEvalGold(lmeQuestions);
    for (const row of rows) {
      expect(row.error).toBeUndefined();
      expect(row.ground_truth).toEqual(gold.read(row.question_id).answer_session_ids);
      expect(row.recall_all).toBe(scoreLmeRetrieval(gold, row.question_id, row.retrieved, 2).recall_all);
    }
  }, 60_000);
});

describe('Cat13 boundaries and broken adapters', () => {
  const corpusDir = join(import.meta.dir, '..', '..', 'eval', 'data', 'world-v1');
  const pages = loadCorpus(corpusDir);
  const { probes, gradesByQuery } = buildProbes(pages, 60);
  const sample = probes.slice(0, 20);
  const sampleGrades = new Map(sample.map(p => [p.q.id, gradesByQuery.get(p.q.id)!]));
  const perfect = Object.fromEntries(sample.map(p => [p.q.id, [...gradesByQuery.get(p.q.id)!.entries()].sort((a, b) => b[1] - a[1]).map(([slug]) => slug).slice(0, TOP_K)]));
  const run = (adapter: Adapter, list: Probe[] = sample, pageList: Page[] = pages, grades = sampleGrades) =>
    scoreAdapter(adapter, pageList, list, grades, new ProbeAccounting(list.length));

  test('the separate gold loader agrees with the runner id for id; permuted labels are refused', () => {
    const gold = loadCat13Gold(corpusDir, 60);
    expect(() => assertCat13Alignment(gold, probes)).not.toThrow();
    expect(gold.fingerprint).toBe(cat13GoldFromProbes(probes, gradesByQuery).fingerprint);
    const permuted = probes.map((p, i) => ({ ...p, q: { ...p.q, text: probes[(i + 1) % probes.length].q.text } }));
    expect(() => assertCat13Alignment(gold, permuted)).toThrow('text differs from its gold');
    const shifted = cat13GoldFromProbes(probes, new Map(probes.map((p, i) => [p.q.id, gradesByQuery.get(probes[(i + 1) % probes.length].q.id)!])));
    expect(shifted.fingerprint).not.toBe(gold.fingerprint);
    expect(() => assertCat13Alignment(gold, [...probes, probes[0]])).toThrow('duplicate probe id');
    expect(() => assertCat13Alignment(gold, probes.slice(1))).toThrow('has no probe');
  });

  test('real pages and probes pass the boundaries; graded slugs never appear in query text', () => {
    const gold = cat13GoldFromProbes(probes, gradesByQuery);
    for (const page of pages) expect(checkPayload(CAT13_SUT_PAGE, sanitizePage(page))).toEqual([]);
    for (const p of probes) expect(checkPayload(CAT13_SUT_QUERY, { id: p.q.id, text: p.q.text }, cat13ForbiddenValues(gold, p.q.id))).toEqual([]);
    expect(checkPayload(CAT13_SUT_PAGE, pages[0])[0]).toContain('field not allowlisted');
    expect(checkPayload(CAT13_SUT_QUERY, probes[0].q).some(v => v.includes('$.gold: field not allowlisted'))).toBe(true);
  });

  test('known perfect ranking scores 1, and wrong answers score 0', async () => {
    expect((await run(fixed(perfect))).ndcg5).toBeCloseTo(1, 12);
    const wrong = Object.fromEntries(sample.map(p => [p.q.id, pages.filter(pg => !gradesByQuery.get(p.q.id)!.has(pg.slug)).slice(0, TOP_K).map(pg => pg.slug)]));
    const r = await run(fixed(wrong));
    expect([r.ndcg5, r.p5_graded, r.p1_strict]).toEqual([0, 0, 0]);
  });

  test('a leaking adapter pipeline is stopped before the system sees the query', async () => {
    const leaky = sample.map((p, i) => i === 3 ? { ...p, q: { ...p.q, text: `${p.q.text} ${p.targetSlugs[0]}` } } : p);
    const seen: string[] = [];
    const spy: Adapter = { name: 'spy', async init() { return {}; }, async query(q) { seen.push(q.id); return []; } };
    await expect(run(spy, leaky)).rejects.toThrow(InputAllowlistError);
    expect(seen).toEqual(sample.slice(0, 3).map(p => p.q.id));
  });

  test('an adapter that returns nothing scores zero on every probe and cannot pass a non-inferiority gate', async () => {
    const empty = await run(fixed({}));
    expect(empty.ndcg5).toBe(0);
    expect(empty.per_query.every(r => r.ranked_pages.length === 0 && r.ndcg5 === 0)).toBe(true);
    const good = await run(fixed(perfect));
    const d = evaluateFamily(good.per_query, empty.per_query, {
      schema_version: 1, family_id: 'empty-system', registered_at: '2026-09-29', alpha: 0.05, seed: 1, draws: 5000, id_field: 'id', min_clusters: 5,
      comparisons: [{ id: 'ndcg5', metric: 'ndcg5', gate: 'noninferiority', direction: 'higher', tolerance: 0.05, cluster_by: 'cluster_id' }],
    });
    expect(d.verdict).toBe('fail');
  });

  test('an adapter that returns duplicates is flagged and gains nothing from them', async () => {
    const target = sample[0].targetSlugs[0];
    const dup = await run(fixed({ [sample[0].q.id]: Array(TOP_K).fill(target) }), [sample[0]]);
    const single = await run(fixed({ [sample[0].q.id]: [target] }), [sample[0]]);
    expect(dup.per_query[0].duplicate_results).toBe(TOP_K - 1);
    expect(dup.per_query[0].p5_graded).toBe(single.per_query[0].p5_graded);
    expect(dup.per_query[0].ndcg5).toBe(single.per_query[0].ndcg5);
  });

  test('removing hidden metadata changes nothing for an honest adapter; a cheating adapter never saw it', async () => {
    const stripped = pages.map(p => { const { _facts: _drop, ...rest } = p; return rest as Page; });
    const withFacts = await run(fixed(perfect));
    const withoutFacts = await run(fixed(perfect), sample, stripped);
    expect(withoutFacts.per_query.map(r => [r.id, r.ndcg5, r.p5_graded, r.p1_strict])).toEqual(withFacts.per_query.map(r => [r.id, r.ndcg5, r.p5_graded, r.p1_strict]));
    let sawFacts = false;
    const cheat: Adapter = { name: 'cheat', async init(received) { sawFacts = (received as unknown as Array<Record<string, unknown>>).some(p => '_facts' in p || 'frontmatter' in p); return {}; }, async query() { return []; } };
    await run(cheat);
    expect(sawFacts).toBe(false);
  });
});
