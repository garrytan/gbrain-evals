import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { LiveRecallAbort } from '../../eval/runner/live-recall/brain.ts';
import { BATCH3_FIXTURE_QUESTIONS, FIXTURE_DIR, freezeSummary, freezeSummaryBatch3, liveRecall, parseQuestions } from '../../eval/runner/live-recall/run.ts';
import { COMPARISONS, PROTOCOL_TYPES, TYPES, decoyFirst, staleFirst, validateScorecard, type QueryRecord } from '../../eval/runner/live-recall/scorecard.ts';
import { GBRA_398, visibilityEpoch } from '../../eval/runner/live-recall/visibility-epoch.ts';

const gut = resolveGbrainUnderTest(null);
const batch3Text = readFileSync(BATCH3_FIXTURE_QUESTIONS, 'utf8');
const batch3Questions = parseQuestions(batch3Text, 'batch3');
const abortCode = async (p: Promise<unknown>) => {
  try { await p; return 'no abort'; } catch (e) { return e instanceof LiveRecallAbort ? e.code : String(e); }
};
const line = (q: Record<string, unknown>) => JSON.stringify({ id: 'q1', forms: { exact: 'x', paraphrase: 'y' }, gold: [{ slug: 'p/gold' }], gold_found_by: 'page_first', ...q });

describe('live-recall batch3 fixture control (keyless)', () => {
  let dir: string;
  let card: any;
  let outbound: string;
  const terminal: string[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'live-recall-b3-'));
    const paths = await liveRecall({ fixture: true, databaseUrlEnv: 'UNUSED', out: join(dir, 'run'), gut, protocol: 'batch3' }, l => terminal.push(l));
    card = JSON.parse(readFileSync(paths.scorecard, 'utf8'));
    outbound = readFileSync(paths.scorecard, 'utf8') + readFileSync(paths.markdown, 'utf8') + terminal.join('\n');
  }, 180_000);
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test('scores the public freshness and entity questions under batch3 and passes custody', () => {
    expect(() => validateScorecard(card)).not.toThrow();
    expect(card.protocol).toBe('batch3');
    expect(card.run.control).toBe(true);
    expect(card.run.visibility_epoch).toBe(visibilityEpoch(gut.version));
    expect(card.run.freeze_visibility_epoch).toBeNull();
    expect(card.questions.by_type.freshness).toBe(4);
    expect(card.questions.by_type.entity).toBe(4);
    expect(card.eligibility.eligible_question_forms).toBe(16);
    for (const arm of ['keyword', 'vector', 'hybrid_lexical', 'hybrid', 'configured']) {
      expect(card.arms[arm].by_type.freshness.all.n).toBe(8);
      expect(card.arms[arm].stale_first.all.n).toBe(8);
      expect(card.arms[arm].stale_first.exact.n).toBe(4);
      expect(card.arms[arm].decoy_first.all.n).toBe(8);
      expect(card.arms[arm].decoy_first.paraphrase.n).toBe(4);
    }
    expect(card.comparisons.filter((c: any) => c.primary).map((c: any) => c.id + ':' + c.metric + ':' + c.n_pairs)).toEqual([
      'p1_configured_vs_hybrid_lexical_freshness:success_at_5:8', 'p1_configured_vs_hybrid_lexical_freshness:mrr:8',
      'p2_configured_vs_hybrid_lexical_entity:success_at_5:8', 'p2_configured_vs_hybrid_lexical_entity:mrr:8',
    ]);
    expect(outbound).toContain('Freshness: stale page ranked above the gold');
    expect(outbound).toContain('Entity: look-alike page ranked above the gold');
  });

  test('no question form, gold slug or stale slug reaches the outbound files or the terminal', () => {
    for (const q of batch3Questions) {
      for (const needle of [...Object.values(q.forms), ...q.gold.map(g => g.slug), ...(q.stale ?? []).map(s => s.slug), ...(q.decoy ?? []).map(s => s.slug)]) expect(outbound).not.toContain(needle);
    }
  });
});

describe('live-recall batch3 questions, freeze and epoch', () => {
  test('batch1 and batch2 still refuse the new types; batch3 accepts all seven', () => {
    expect(() => parseQuestions(batch3Text)).toThrow('line 1 field type');
    expect(() => parseQuestions(batch3Text, 'batch2')).toThrow('line 1 field type');
    expect(PROTOCOL_TYPES.batch1).toEqual(TYPES);
    expect(PROTOCOL_TYPES.batch3).toEqual([...TYPES, 'freshness', 'entity']);
    const original = readFileSync(join(FIXTURE_DIR, 'questions.jsonl'), 'utf8');
    expect(parseQuestions(original, 'batch3').length).toBe(parseQuestions(original).length);
  });

  test('a freshness question must name stale pages that are not gold, and no other type may', () => {
    expect(() => parseQuestions(line({ type: 'freshness' }), 'batch3')).toThrow('line 1 field stale');
    expect(() => parseQuestions(line({ type: 'freshness', stale: [] }), 'batch3')).toThrow('line 1 field stale');
    expect(() => parseQuestions(line({ type: 'freshness', stale: [{ slug: 'p/gold' }] }), 'batch3')).toThrow('line 1 field stale[0].slug');
    expect(() => parseQuestions(line({ type: 'entity', stale: [{ slug: 'p/old' }] }), 'batch3')).toThrow('line 1 field stale');
    expect(parseQuestions(line({ type: 'freshness', stale: [{ slug: 'p/old' }] }), 'batch3')[0]!.stale).toEqual([{ slug: 'p/old' }]);
    expect(parseQuestions(line({ type: 'topic', stale: [{ slug: 'p/old' }] }))[0]!.stale).toBeUndefined();
  });

  test('the batch3 freeze records the gbrain version and visibility epoch; earlier freezes do not', () => {
    const f = freezeSummaryBatch3(batch3Text, batch3Questions, { version: '0.60.557.0' });
    expect(f.protocol).toBe('batch3');
    expect(f.gbrain_version).toBe('0.60.557.0');
    expect(f.visibility_epoch).toBe('pre_gbra_398');
    expect(f.freshness_stale_pages).toBe(4);
    expect(f.by_type).toMatchObject({ freshness: 4, entity: 4, topic: 0 });
    expect(f.mde_success_at_5.p1_freshness_both_forms_range.pd20).toHaveLength(2);
    expect(freezeSummaryBatch3('', [], { version: '0.60.557.0' }).mde_success_at_5.p2_entity_both_forms_range.pd20).toBeNull();
    expect(JSON.stringify(f)).not.toContain('Ines');
    const b2 = freezeSummary(batch3Text, batch3Questions, 'batch2');
    expect('visibility_epoch' in b2).toBe(false);
  });

  test('the visibility epoch reads pre below the known ceiling, unknown above it, and post from the first release once set', () => {
    expect(visibilityEpoch('0.60.557.0')).toBe('pre_gbra_398');
    expect(visibilityEpoch(GBRA_398.pre_ceiling)).toBe('pre_gbra_398');
    expect(visibilityEpoch('0.60.621.0')).toBe('unknown');
    expect(visibilityEpoch('not-a-version')).toBe('unknown');
    const shipped = { first_version: '0.60.630.0', pre_ceiling: GBRA_398.pre_ceiling };
    expect(visibilityEpoch('0.60.629.0', shipped)).toBe('pre_gbra_398');
    expect(visibilityEpoch('0.60.630.0', shipped)).toBe('post_gbra_398');
    expect(visibilityEpoch('0.61.0.0', shipped)).toBe('post_gbra_398');
  });

  test('a counted batch3 run refuses a freeze with no epoch or the other epoch, before opening any database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'live-recall-b3-freeze-'));
    try {
      writeFileSync(join(dir, 'q.jsonl'), batch3Text);
      const run = (freeze: unknown) => {
        writeFileSync(join(dir, 'freeze.json'), JSON.stringify(freeze));
        return abortCode(liveRecall({ fixture: false, questionsPath: join(dir, 'q.jsonl'), freezePath: join(dir, 'freeze.json'), databaseUrlEnv: 'LIVE_RECALL_TEST_UNSET', out: join(dir, 'out'), gut }, () => {}));
      };
      const f = freezeSummaryBatch3(batch3Text, batch3Questions, gut);
      expect(await run(f)).toBe('LR_NO_DATABASE_URL');
      expect(await run({ ...f, visibility_epoch: 'post_gbra_398' })).toBe('LR_FREEZE_MISMATCH');
      const { visibility_epoch: _e, ...noEpoch } = f;
      expect(await run(noEpoch)).toBe('LR_FREEZE_MISMATCH');
      const later = { ...gut, version: '9.0.0.0' };
      const runLater = (freeze: unknown) => {
        writeFileSync(join(dir, 'freeze.json'), JSON.stringify(freeze));
        return abortCode(liveRecall({ fixture: false, questionsPath: join(dir, 'q.jsonl'), freezePath: join(dir, 'freeze.json'), databaseUrlEnv: 'LIVE_RECALL_TEST_UNSET', out: join(dir, 'out'), gut: later }, () => {}));
      };
      expect(await runLater({ ...f, visibility_epoch: 'unknown', gbrain_version: '8.0.0.0' })).toBe('LR_FREEZE_MISMATCH');
      expect(await runLater({ ...f, visibility_epoch: 'unknown', gbrain_version: '9.0.0.0' })).toBe('LR_NO_DATABASE_URL');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('stale-first counts a stale page above the gold, or a stale page with no gold', () => {
    const r = (page_rank: number | null, stale_rank: number | null | undefined) => staleFirst({ page_rank, stale_rank } as Pick<QueryRecord, 'page_rank' | 'stale_rank'>);
    expect([r(3, 1), r(null, 2), r(1, 3), r(null, null), r(2, undefined)]).toEqual([1, 1, 0, 0, 0]);
  });

  test('decoy-first counts a look-alike page above the gold, or one with no gold', () => {
    const r = (page_rank: number | null, decoy_rank: number | null | undefined) => decoyFirst({ page_rank, decoy_rank } as Pick<QueryRecord, 'page_rank' | 'decoy_rank'>);
    expect([r(3, 1), r(null, 2), r(1, 3), r(null, null), r(2, undefined)]).toEqual([1, 1, 0, 0, 0]);
  });

  test('a decoy is optional on entity questions, refused on any other type, and never gold', () => {
    const entity = (q: Record<string, unknown>) => line({ type: 'entity', ...q });
    expect(parseQuestions(entity({ decoy: [{ slug: 'p/other' }] }), 'batch3')[0]!.decoy).toEqual([{ slug: 'p/other' }]);
    expect(parseQuestions(entity({}), 'batch3')[0]!.decoy).toBeUndefined();
    const refused = (text: string) => { try { parseQuestions(text, 'batch3'); return 'parsed'; } catch (e) { return e instanceof LiveRecallAbort ? e.code + ':' + e.message : String(e); } };
    expect(refused(entity({ decoy: [{ slug: 'p/gold' }] }))).toContain('decoy[0].slug');
    expect(refused(entity({ decoy: [] }))).toContain('decoy');
    expect(refused(line({ type: 'freshness', stale: [{ slug: 'p/old' }], decoy: [{ slug: 'p/other' }] }))).toContain('decoy');
  });

  test('batch1 and batch2 comparison lists are unchanged', () => {
    expect(COMPARISONS.batch1.map(c => c.id).slice(0, 2)).toEqual(['p1_hybrid_vs_hybrid_lexical', 'p2_configured_vs_hybrid_lexical_paraphrase']);
    expect(COMPARISONS.batch1.some(c => c.type)).toBe(false);
    expect(COMPARISONS.batch2.some(c => c.type)).toBe(false);
  });
});
