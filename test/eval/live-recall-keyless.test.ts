import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importGbrain, resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { LiveRecallAbort } from '../../eval/runner/live-recall/brain.ts';
import { FIXTURE_DIR, keylessPages, liveRecall, main, makeKeyless, providerEnvNames, useFixtureTransports } from '../../eval/runner/live-recall/run.ts';
import { FILL_MIN_WINS, FILL_PRIMARY_ID, KEYLESS_ARM, TYPES, compareRuns, keylessBlock, signTestOneSided, type KeylessRecord, type QueryRecord } from '../../eval/runner/live-recall/scorecard.ts';

const gut = resolveGbrainUnderTest(null);
const gold = new Set(['g']);
const row = (slug: string, fill = false) => (fill ? { slug, keyword_fill: true } : { slug });

describe('search_op_keyless pages with and without the fill', () => {
  test('fill off drops exactly the rows gbrain marked keyword_fill, and a gold page only a fill row brought is a fill-on hit', () => {
    const p = keylessPages([row('a'), row('b'), row('a'), row('g', true), row('c', true)], gold);
    expect(p.pages).toEqual(['a', 'b', 'g', 'c']);
    expect(p.page_rank).toBe(3);
    expect(p.fill_off).toEqual({ pages: ['a', 'b'], page_rank: null, all_found_at: { k1: false, k5: false, k10: false, k20: false } });
    expect(p.all_found_at.k5).toBe(true);
    expect(p).toMatchObject({ returned: 4, fill_rows: 2, fill_in_top5: true, prefix_broken: false });
  });

  test('a fill row on a page a normal row returned adds no page, and a fill row before a normal row is counted', () => {
    expect(keylessPages([row('a'), row('a', true)], gold)).toMatchObject({ pages: ['a'], fill_rows: 1, fill_in_top5: false, prefix_broken: false });
    expect(keylessPages([row('c', true), row('g')], gold)).toMatchObject({ prefix_broken: true, page_rank: 2, fill_off: { page_rank: 1 } });
    expect(keylessPages([], gold)).toMatchObject({ pages: [], page_rank: null, fill_rows: 0, fill_in_top5: false, prefix_broken: false });
  });

  test('a fill page past the first five pages stays out of fill_in_top5', () => {
    const p = keylessPages([row('a'), row('b'), row('c'), row('d'), row('e'), row('g', true)], gold);
    expect(p).toMatchObject({ fill_in_top5: false, page_rank: 6, fill_off: { page_rank: null } });
  });
});

describe('the fill primary', () => {
  test('the exact one-sided sign test', () => {
    expect(signTestOneSided(5, 0)).toBe(0.03125);
    expect(signTestOneSided(4, 0)).toBe(0.0625);
    expect(signTestOneSided(5, 1)).toBeCloseTo(7 / 64, 12);
    expect(signTestOneSided(0, 0)).toBe(1);
    expect(signTestOneSided(0, 3)).toBe(1);
  });

  const record = (qid: string, form: 'exact' | 'paraphrase', onRank: number | null, offRank: number | null, status: KeylessRecord['status'] = 'ok'): KeylessRecord => ({
    qid, type: 'topic', form, arm: KEYLESS_ARM, status, pages: [], chunks: [], page_rank: onRank, chunk_rank: null, gold_pages: 1, has_chunk_gold: false,
    all_found_at: {}, ms: 1, returned: 0, calls: {}, degraded_stages: ['embed_unavailable'],
    fill_off: { pages: [], page_rank: offRank, all_found_at: {} }, fill_rows: onRank !== offRank ? 1 : 0, fill_in_top5: onRank !== null && onRank <= 5 && offRank === null, prefix_broken: false,
  });
  const keyword = (qid: string, rows: number): QueryRecord => ({ qid, type: 'topic', form: 'paraphrase', arm: 'keyword', status: 'ok', pages: [], chunks: Array.from({ length: rows }, (_, i) => String(i)), page_rank: null, chunk_rank: null, gold_pages: 1, has_chunk_gold: false, all_found_at: {}, ms: 1, returned: 0, calls: {}, degraded_stages: [] });

  test(FILL_MIN_WINS + ' reworded forms gained with none lost hold; exact forms and other statuses stay out of the pairs', () => {
    const records = [
      ...['q1', 'q2', 'q3', 'q4', 'q5'].map(q => record(q, 'paraphrase', 4, null)),
      record('q6', 'paraphrase', 2, 2), record('q7', 'paraphrase', null, null), record('q8', 'paraphrase', 3, null, 'degraded'),
      record('q1', 'exact', 1, 1), record('q2', 'exact', 5, null),
    ];
    const k = keylessBlock(records, [keyword('q1', 0), keyword('q2', 3), keyword('q3', 19), keyword('q4', 20), keyword('q5', 50)]) as any;
    expect(k.statuses).toEqual({ ok: 9, degraded: 1 });
    expect(k.primary).toMatchObject({ id: FILL_PRIMARY_ID, a: 'fill_off', b: 'fill_on', form: 'paraphrase', n_pairs: 7, wins: 5, losses: 0, p_one_sided: 0.0313, holds: true, alpha: 0.05, min_wins: 5 });
    expect(k.exposure.n).toEqual({ all: 9, exact: 2, paraphrase: 7 });
    expect(k.exposure.fired).toEqual({ all: 6, exact: 1, paraphrase: 5 });
    expect(k.exposure.fill_in_top5).toEqual({ all: 6, exact: 1, paraphrase: 5 });
    expect(k.task_fit).toEqual({ n: 5, keyword_rows_1_to_19: 2 });
    expect(k.fill_on.paraphrase.success_at.k5.rate).toBeCloseTo(6 / 7, 3);
    expect(k.fill_off.paraphrase.success_at.k5.rate).toBeCloseTo(1 / 7, 3);
  });

  test('four wins, or any loss, do not hold; no ok form makes the block invalid', () => {
    const four = keylessBlock(['q1', 'q2', 'q3', 'q4'].map(q => record(q, 'paraphrase', 4, null)), []) as any;
    expect(four.primary).toMatchObject({ wins: 4, losses: 0, holds: false });
    const lost = keylessBlock([...['q1', 'q2', 'q3', 'q4', 'q5', 'q6'].map(q => record(q, 'paraphrase', 4, null)), record('q7', 'paraphrase', null, 3)], []) as any;
    expect(lost.primary).toMatchObject({ wins: 6, losses: 1, holds: false });
    expect(keylessBlock([record('q1', 'paraphrase', 1, 1, 'error')], [])).toEqual({ invalid: 'no_eligible_queries', statuses: { error: 1 } });
  });
});

describe('the keyless process refuses a provider', () => {
  test('with the fixture keys removed and its test transports gone, gbrain reports no provider; a keyless local embedding model is refused', async () => {
    const reset = await useFixtureTransports(gut);
    const gateway = await importGbrain<any>(gut, 'src/core/ai/gateway.ts');
    try {
      const names = await providerEnvNames(gut);
      expect(names.has('OPENAI_API_KEY')).toBe(true);
      expect(names.has('VOYAGE_API_KEY')).toBe(true);
      const check = await makeKeyless(gut, names);
      expect(check).not.toThrow();
      expect(gateway.requireConfig().env).toEqual({});
      gateway.configureGateway({ ...gateway.requireConfig(), embedding_model: 'ollama:nomic-embed-text', embedding_dimensions: 768 });
      const refuse = await makeKeyless(gut, names);
      let code = 'no abort';
      try { refuse(); } catch (e) { code = e instanceof LiveRecallAbort ? e.code : String(e); }
      expect(code).toBe('LR_KEYLESS_PROVIDER');
    } finally {
      reset();
    }
  });

  test('--reference-build is refused on a fixture run', async () => {
    const err = console.error;
    console.error = () => {};
    try { expect(await main(['run', '--fixture', '--reference-build'])).toBe(2); } finally { console.error = err; }
  });
});

describe('a fixture run starts the keyless process and scores it', () => {
  let dir: string;
  let card: any, markdown: string, keyless: KeylessRecord[], detail: QueryRecord[];
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'live-recall-keyless-'));
    const paths = await liveRecall({ fixture: true, databaseUrlEnv: 'UNUSED', out: join(dir, 'run'), gut, protocol: 'batch5' }, () => {});
    card = JSON.parse(readFileSync(paths.scorecard, 'utf8'));
    markdown = readFileSync(paths.markdown, 'utf8');
    keyless = readFileSync(join(dir, 'run', 'keyless.local.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    detail = readFileSync(paths.detail, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('every question form ran keyless and ok, with its fill fields', () => {
    const n = readFileSync(join(FIXTURE_DIR, 'questions.jsonl'), 'utf8').split('\n').filter(Boolean).length;
    expect(keyless.length).toBe(2 * n);
    expect(existsSync(join(dir, 'run', 'keyless.abort.json'))).toBe(false);
    for (const r of keyless) {
      expect(r).toMatchObject({ arm: KEYLESS_ARM, status: 'ok', calls: {} });
      expect(r.degraded_stages).toContain('embed_unavailable');
      expect(r.prefix_broken).toBe(false);
      expect(r.fill_off.pages.every(p => r.pages.includes(p))).toBe(true);
      expect(r.pages.length - r.fill_off.pages.length).toBeLessThanOrEqual(r.fill_rows);
    }
  });

  test('the scorecard carries the keyless block, the gap classes and the schema fields, and the markdown shows them', () => {
    expect(card.keyless_op.statuses).toEqual({ ok: keyless.length });
    expect(card.keyless_op.exposure.n.all).toBe(keyless.length);
    expect(card.keyless_op.exposure.fired.all).toBe(keyless.filter(r => r.fill_rows > 0).length);
    expect(card.keyless_op.primary.id).toBe(FILL_PRIMARY_ID);
    expect(Object.keys(card.gap_failures).sort()).toEqual([...TYPES].sort());
    for (const c of Object.values(card.gap_failures) as Array<Record<string, number>>) expect(c.ranked_6_to_20 + c.not_in_20_hybrid_or_vector_top5 + c.not_in_20_other_arm_top5 + c.not_in_20_no_arm_top5).toBe(c.exact_only);
    expect(card.run).toMatchObject({ reference_build: false, code_schema_version: card.run.schema_version, brain_pages_at_end: card.run.brain_pages_at_start, archive_layout_pages: 0, gold_pages_in_archive_layout: 0 });
    expect(markdown).toContain('Brain during the run: ' + card.run.brain_pages_at_start + ' pages');
    expect(markdown).toContain('Conversation-archive layout, which gbrain #9433 ranks lower unless a question names a chat or a date: 0 live pages, 0 of them gold pages of this run.');
    expect(card.eligibility.common_arms).not.toContain(KEYLESS_ARM);
    expect(markdown).toContain('## Keyless search operation (' + KEYLESS_ARM + ')');
    expect(markdown).toContain('## Gap failure classes');
  });

  test('compare pairs the keyless arm like any other arm', () => {
    const { comparisons } = compareRuns([...detail, ...keyless], [...detail, ...keyless]);
    const c = comparisons.find(x => x.id === 'run_b_vs_run_a_' + KEYLESS_ARM + '_paraphrase' && x.metric === 'success_at_5') as any;
    expect(c).toMatchObject({ arm: KEYLESS_ARM, delta: 0, top5_changed: 0 });
    expect(c.n_pairs).toBe(keyless.length / 2);
  });
});
