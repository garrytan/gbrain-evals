/**
 * N9 multi-hop paraphrase: scorer, mutation suite, capability classifier,
 * paired summary, and a real keyword run on a small world-v1 slice with an
 * honest and a deliberately broken search.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hybridSearch } from 'gbrain/search/hybrid';
import { assertScorerRejectsFakeSystems, FAKE_SYSTEM_KINDS } from '../../eval/runner/mutation-kit.ts';
import {
  classifyParse, composedRate, pagesOfFirstRows, parseN9Args, runN9, scoreComposed, shuffledGold, summarizeComposed,
  type ComposedRow,
} from '../../eval/runner/n9-multi-hop-paraphrase.ts';
import { N9_QUESTIONS_PATH, type N9Question, type N9QuestionFile } from '../../eval/generators/n9-multihop-paraphrase-gen.ts';
import { loadWorldCorpus } from '../../eval/runner/queries/relational.ts';
import { PaidArmRefusal } from '../../eval/runner/paid-arm.ts';
import type { RelationalSearch } from '../../eval/runner/relational-ab.ts';

const rows = (...slugs: string[]) => slugs.map(slug => ({ slug }));
const gold = { required: ['companies/a', 'people/b', 'people/c'], answers: ['people/b', 'people/c'], support: ['companies/a'] };

describe('strict supporting-fact all-hit scorer', () => {
  test('every required page within the first k rows scores 1; one missing scores 0', () => {
    expect(scoreComposed(rows('companies/a', 'x/1', 'people/b', 'people/c'), gold).strict_all_hit).toBe(1);
    const missing = scoreComposed(rows('companies/a', 'x/1', 'people/c'), gold);
    expect(missing.strict_all_hit).toBe(0);
    expect(missing.support_all_hit).toBe(1);
    expect(missing.answer_all_hit).toBe(0);
    expect(missing.answer_recall).toBe(0.5);
  });

  test('pages past row k do not count, duplicates count once, and @5 uses only the first five rows', () => {
    const late = rows('x/1', 'x/2', 'x/3', 'x/4', 'x/5', 'companies/a', 'people/b', 'people/c');
    expect(scoreComposed(late, gold)).toMatchObject({ strict_all_hit: 1, strict_all_hit_at_5: 0 });
    const tooLate = rows(...Array.from({ length: 10 }, (_, i) => `x/${i}`), 'companies/a', 'people/b', 'people/c');
    expect(scoreComposed(tooLate, gold).strict_all_hit).toBe(0);
    expect(pagesOfFirstRows(rows('a/1', 'a/1', 'a/2'), 3)).toEqual(['a/1', 'a/2']);
  });

  test('negative: answers alone, support alone, or an empty gold never pass strict all-hit', () => {
    expect(scoreComposed(rows('people/b', 'people/c'), gold).strict_all_hit).toBe(0);
    expect(scoreComposed(rows('companies/a'), gold).strict_all_hit).toBe(0);
    expect(scoreComposed(rows('companies/a'), { required: [], answers: [], support: [] }).strict_all_hit).toBe(0);
  });
});

describe('scorer mutation suite on the committed question set', () => {
  const file = JSON.parse(readFileSync(N9_QUESTIONS_PATH, 'utf8')) as N9QuestionFile;
  const probes = file.questions;
  const corpus = loadWorldCorpus(join(import.meta.dir, '../../eval/data/world-v1')).map(p => p.slug).sort();
  const twin = shuffledGold(probes);
  test('the honest system passes; empty, always-positive, always-refuse and wrong-source fail', () => {
    const results = assertScorerRejectsFakeSystems<N9Question, { slug: string }[]>({
      category: 'multi-hop-paraphrase',
      probes,
      space: {
        truth: q => rows(...q.required),
        empty: () => [],
        everything: () => rows(...corpus),
        refusal: () => [],
        wrongSource: q => { const t = twin.get(q.id); return t ? rows(...t.required) : undefined; },
      },
      notApplicable: { stale: 'world-v1 relations carry no history: there is no earlier value to answer with' },
      score: answers => {
        const rate = composedRate(answers, probes);
        return { pass: rate >= 0.5, detail: `strict all-hit@10 ${rate.toFixed(3)}` };
      },
    });
    expect(results.filter(r => r.pass).map(r => r.system)).toEqual(['honest']);
    expect(results.map(r => r.system)).toEqual(['honest', ...FAKE_SYSTEM_KINDS]);
  });
});

describe('composed-query capability check', () => {
  const q = { relations: ['invested_in', 'founded_by'] as N9Question['relations'], anchor_name: 'Alice Example' };
  test('no parse, last-hop relation with a nested seed, and a first-hop relation on the anchor', () => {
    expect(classifyParse(q, null)).toEqual({ relation_sets: 0, composed_plan: false, relation_match: 'no_parse', seed_match: 'no_parse' });
    expect(classifyParse(q, { kind: 'who_rel', seeds: ['companies that Alice Example invested in'], linkTypes: ['founded'], direction: 'in' }))
      .toEqual({ relation_sets: 1, composed_plan: false, relation_match: 'last_hop', seed_match: 'phrase_containing_anchor' });
    expect(classifyParse(q, { kind: 'who_rel', seeds: ['Alice Example'], linkTypes: ['invested_in', 'led_round'], direction: 'out' }))
      .toMatchObject({ relation_match: 'first_hop', seed_match: 'anchor' });
    expect(classifyParse(q, { kind: 'connects', seeds: ['Alice Example', 'Beta'], linkTypes: null, direction: 'both' }).relation_match).toBe('untyped');
  });
});

describe('paired summary', () => {
  const s = (v: number) => ({ strict_all_hit: v, answer_all_hit: v, support_all_hit: v, answer_recall: v, strict_all_hit_at_5: v });
  const row = (id: string, seed: number, off: number, on: number): ComposedRow => ({
    seed, question_id: id, split: 'composed-template', family: 'investor_founders', hops: 2, shortcut: false, edges_stated: true,
    off: s(off), on: s(on), off_shuffled: 0, on_shuffled: 0, funnel: { parsed: true, seed_resolved: false, fired: false, candidates: 0, all_support: on === 1 }, error: null,
  });
  test('ties are ties, and the sign test runs over distinct questions', () => {
    const sum = summarizeComposed([row('a', 1, 0, 0), row('a', 2, 0, 0), row('b', 1, 0, 1), row('b', 2, 0, 1), row('c', 1, 1, 0), row('c', 2, 0, 0)]);
    expect(sum.paired_questions).toMatchObject({ n: 3, gains: 1, losses: 1, ties: 1, sign_test_p_two_sided: 1 });
    expect(sum.paired_runs).toEqual({ n: 6, gains: 2, losses: 1, ties: 3 });
    expect(sum.on.strict_all_hit).toBeCloseTo(2 / 6);
  });
});

describe('flags and the paid guard', () => {
  test('parses the shared flags and refuses paid work without both flags', async () => {
    expect(parseN9Args(['--seed', '7', '--output', '/tmp/x'])).toMatchObject({ seeds: [7], outputDir: '/tmp/x', paidArgv: null });
    expect(() => parseN9Args(['--bogus'])).toThrow('unknown option');
    await expect(runN9({ paidArgv: ['--paid'] })).rejects.toThrow(PaidArmRefusal);
  });
});

describe('real keyword run on a world-v1 slice', () => {
  let temp: string;
  let corpus: string;
  beforeAll(() => {
    temp = mkdtempSync(join(tmpdir(), 'n9-'));
    corpus = join(temp, 'corpus');
    mkdirSync(corpus);
    const world = loadWorldCorpus(join(import.meta.dir, '../../eval/data/world-v1'));
    const bySlug = new Map(world.map(p => [p.slug, p]));
    const keep = new Set(['companies/acme-0', 'companies/gravity-17', 'companies/meridian-40']);
    for (const c of [...keep]) for (const s of Object.values(bySlug.get(c)!._facts).flat()) if (typeof s === 'string' && bySlug.has(s)) keep.add(s);
    for (const p of world) if (p._facts.type === 'meeting' && keep.has(String((p._facts as { topic_company?: string }).topic_company))) keep.add(p.slug);
    for (const [i, slug] of [...keep].sort().entries()) writeFileSync(join(corpus, `${String(i).padStart(3, '0')}.json`), JSON.stringify(bySlug.get(slug)));
  });
  afterAll(() => { rmSync(temp, { recursive: true, force: true }); });

  test('an honest run completes with presence held and composed questions scored', async () => {
    const r = await runN9({ corpusDir: corpus, seeds: [1], outputDir: join(temp, 'honest'), quiet: true });
    expect(r.receipt.run_status).toBe('completed');
    expect(r.receipt.verdict).toBe('partial');
    const data = r.receipt.data as { composed: { by_split: Record<string, { off: { n: number } }> }; controls: { presence: Array<{ rate: number }> }; capability: { summary: Record<string, { composed_plans: number }> } };
    expect(data.composed.by_split['composed-template']!.off.n).toBeGreaterThan(0);
    expect(data.controls.presence[0]!.rate).toBeGreaterThanOrEqual(0.5);
    expect(data.capability.summary['composed-template']!.composed_plans).toBe(0);
    expect(r.findings.map(f => f.id)).toEqual(['N9-1']);
  }, 120_000);

  test('a broken search that returns the wrong pages fails: presence voids the run and nothing scores', async () => {
    const broken: RelationalSearch = async (engine, text, opts) => {
      const real = await hybridSearch(engine, 'zzz unrelated filler', { ...opts, relationalRetrieval: opts.relationalRetrieval });
      return real.map(row => ({ ...row, slug: `wrong/${row.slug}` }));
    };
    const r = await runN9({ corpusDir: corpus, seeds: [1], outputDir: join(temp, 'broken'), quiet: true, search: broken });
    expect(r.receipt.run_status).toBe('error');
    expect(r.exitCode).toBe(3);
    const data = r.receipt.data as { composed: { by_split: Record<string, { on: { strict_all_hit: number | null } }> } };
    expect(data.composed.by_split['composed-template']!.on.strict_all_hit ?? 0).toBe(0);
  }, 120_000);
});
