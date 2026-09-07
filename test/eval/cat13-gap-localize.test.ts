/**
 * Cat 13 Phase E1 — hermetic pins for the gap localizer
 * (eval/runner/cat13-gap-localize.ts).
 *
 * The pure parts carry the classification rule, so they are pinned exactly:
 *   1. page collapse + gold rank (best chunk per slug; best-ranked target).
 *   2. gap / gain predicates and the delta buckets.
 *   3. classifyGap: relaxed rows win outright; among fixing single stages the
 *      one lifting gold furthest wins, ties fall to the fixed priority; the
 *      both-lexical-arms fallback; vector_arm_mismatch vs unexplained with a
 *      best-partial pointer.
 *   4. intruders: only non-gold pages the vector arm did NOT already rank
 *      above gold; gold-absent probes take hybrid's whole top-5.
 *   5. rollups: class counts, intruder table, mechanism ranking (fixed /
 *      collateral / net / nDCG), CLI parsing, markdown smoke.
 *   6. GOOD INPUT: one PGLite brain with stub embeds — every measured probe
 *      has a stamped meta, the `full` re-simulation reproduces the live
 *      hybrid page order (the fidelity the ablations rest on), and the
 *      report files land.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SearchResult } from 'gbrain/types';
import {
  collapsePages,
  goldRank,
  isGap,
  isGain,
  deltaBucket,
  deltaDistribution,
  classifyGap,
  findIntruders,
  stampPages,
  boostsOf,
  countClasses,
  topIntruders,
  rankMechanisms,
  parseLocalizeArgv,
  renderMarkdown,
  summarize,
  runLocalize,
  stageFlags,
  ABLATIONS,
  SINGLE_STAGE_ABLATIONS,
  FINE_BOOST_ABLATIONS,
  PROPOSAL_CANDIDATES,
  policyProjections,
  rerenderReport,
  HYBRID_LIMIT,
  type AblationName,
  type ProbeGapRecord,
  type PageStamp,
  type LocalizeReport,
} from '../../eval/runner/cat13-gap-localize.ts';

function row(slug: string, score: number, extra: Partial<SearchResult> = {}): SearchResult {
  return {
    slug, page_id: 1, title: slug, type: 'concept', chunk_text: 'x', chunk_source: 'compiled_truth',
    chunk_id: 1, chunk_index: 0, score, stale: false, ...extra,
  } as SearchResult;
}

type Ranks = Partial<Record<AblationName, number | null>>;
function ablations(ranks: Ranks): Record<AblationName, { gold_rank: number | null; ndcg5: number }> {
  const out = {} as Record<AblationName, { gold_rank: number | null; ndcg5: number }>;
  for (const a of ABLATIONS) {
    const g = ranks[a] === undefined ? 9 : ranks[a];
    out[a] = { gold_rank: g, ndcg5: g === null ? 0 : g === 1 ? 1 : 1 / Math.log2(g + 1) };
  }
  return out;
}

let counter = 0;
function rec(o: {
  v: number | null; h: number | null; ranks?: Ranks; template?: string; relaxed?: boolean;
  intruders?: ProbeGapRecord['intruders']; kw?: number; title?: number;
}): ProbeGapRecord {
  counter += 1;
  const ab = ablations(o.ranks ?? {});
  const cls = classifyGap({
    vector_gold_rank: o.v, hybrid_gold_rank: o.h, ablations: ab,
    relaxed_rows_fused: o.relaxed ?? false, detail_resolved: null, token_budget_dropped: 0,
  });
  const nd = (r: number | null) => (r === null ? 0 : r === 1 ? 1 : 1 / Math.log2(r + 1));
  return {
    probe_id: `t-${counter}`, template: o.template ?? 'synonym', text: `probe ${counter}`, targets: ['concepts/gold'],
    intent: 'concept', detail_resolved: null, vector_enabled: true,
    live: {
      vector_gold_rank: o.v, vector_ndcg5: nd(o.v), hybrid_gold_rank: o.h, hybrid_ndcg5: nd(o.h),
      page_vector_docside_gold_rank: null, page_vector_docside_ndcg5: null,
      page_vector_queryside_gold_rank: null, page_vector_queryside_ndcg5: null,
    },
    arms: {
      vector_rows: 10, keyword_strict_rows: o.kw ?? 0, keyword_relaxed_rows: 0, title_strict_rows: o.title ?? 0, title_relaxed_rows: 0,
      keyword_gold_rank: null, title_gold_rank: null, keyword_top_slug: null, title_top_slug: null,
    },
    meta: { degraded: [], relaxed_dropped: 0, token_budget_dropped: 0, keyword_arm_margin: 0, embedding_column: 'embedding' },
    hybrid_top: [], vector_top: [], ablations: ab,
    simulation: { top5_match: true, full_match: true, live_pages: 10, sim_pages: 10 },
    gap: isGap(o.v, o.h), gain: isGain(o.v, o.h),
    intruders: o.intruders ?? [],
    gap_class: cls.gap_class, class_detail: cls.class_detail, best_partial: cls.best_partial,
  };
}

describe('gap collapse + gold rank', () => {
  test('best chunk per slug; ties break on slug; gold rank is the best-ranked target', () => {
    const rows = [row('b', 0.5), row('a', 0.9), row('b', 0.95), row('c', 0.9)];
    expect(collapsePages(rows).map(p => p.slug)).toEqual(['b', 'a', 'c']);
    expect(goldRank(['b', 'a', 'c'], ['c', 'a'])).toBe(2);
    expect(goldRank(['b', 'a', 'c'], ['z'])).toBeNull();
    expect(goldRank([], ['a'])).toBeNull();
  });
});

describe('gap / gain predicates + delta buckets', () => {
  test('gap needs vector top-5 and hybrid lower or absent; gain is the mirror inside top-5', () => {
    expect(isGap(1, 2)).toBe(true);
    expect(isGap(3, null)).toBe(true);
    expect(isGap(2, 2)).toBe(false);
    expect(isGap(6, 9)).toBe(false);   // vector itself missed top-5
    expect(isGap(null, 1)).toBe(false);
    expect(isGain(3, 1)).toBe(true);
    expect(isGain(null, 4)).toBe(true);
    expect(isGain(1, 1)).toBe(false);
    expect(isGain(2, 7)).toBe(false);  // hybrid outside top-5 is never a gain
  });

  test('delta buckets', () => {
    expect(deltaBucket(3, 1)).toBe('improved');
    expect(deltaBucket(2, 2)).toBe('same');
    expect(deltaBucket(1, 4)).toBe('worse_in_top5');
    expect(deltaBucket(2, 7)).toBe('pushed_out_of_top5');
    expect(deltaBucket(2, null)).toBe('pushed_out_of_top5');
    expect(deltaBucket(8, 3)).toBe('vector_missed_top5');
    expect(deltaBucket(null, null)).toBe('both_outside_top5');
    const d = deltaDistribution([rec({ v: 1, h: 3 }), rec({ v: 2, h: 2 }), rec({ v: 4, h: null }), rec({ v: 3, h: 1 })]);
    expect(d.buckets).toEqual({ improved: 1, same: 1, worse_in_top5: 1, pushed_out_of_top5: 1, vector_missed_top5: 0, both_outside_top5: 0 });
    expect(d.both_present).toBe(3);
    expect(d.mean_delta_both_present).toBeCloseTo((2 + 0 - 2) / 3, 12);
    expect(d.delta_hist['+2']).toBe(1);
    expect(d.delta_hist['-2']).toBe(1);
    expect(d.delta_hist['0']).toBe(1);
  });
});

describe('classifyGap', () => {
  const base = { detail_resolved: null as string | null, token_budget_dropped: 0, relaxed_rows_fused: false };

  test('non-gap probes classify to null', () => {
    expect(classifyGap({ ...base, vector_gold_rank: 2, hybrid_gold_rank: 1, ablations: ablations({}) }).gap_class).toBeNull();
    expect(classifyGap({ ...base, vector_gold_rank: 7, hybrid_gold_rank: null, ablations: ablations({}) }).gap_class).toBeNull();
  });

  test('a relaxed row in the returned set wins outright (class 5)', () => {
    const r = classifyGap({ ...base, relaxed_rows_fused: true, vector_gold_rank: 1, hybrid_gold_rank: 3, ablations: ablations({ no_title_arm: 1 }) });
    expect(r.gap_class).toBe('relaxed_keyword_fused');
  });

  test('the single stage that lifts gold furthest wins; ties fall to priority order', () => {
    // title fixes to rank 1, boosts fix to rank 2 (vector had 2): title lifts further.
    expect(classifyGap({ ...base, vector_gold_rank: 2, hybrid_gold_rank: 4, ablations: ablations({ no_title_arm: 1, no_post_fusion_boosts: 2 }) }).gap_class)
      .toBe('title_arm_injection');
    // boosts lift further than title.
    expect(classifyGap({ ...base, vector_gold_rank: 2, hybrid_gold_rank: 4, ablations: ablations({ no_title_arm: 2, no_post_fusion_boosts: 1 }) }).gap_class)
      .toBe('post_fusion_boost_reorder');
    // tie at the same rank: priority order (title > keyword > boosts > compiled > cosine > dedup).
    expect(classifyGap({ ...base, vector_gold_rank: 1, hybrid_gold_rank: 2, ablations: ablations({ no_cosine_blend: 1, no_keyword_arm: 1 }) }).gap_class)
      .toBe('keyword_arm_injection');
    expect(classifyGap({ ...base, vector_gold_rank: 1, hybrid_gold_rank: 2, ablations: ablations({ no_cosine_blend: 1, no_dedup: 1 }) }).gap_class)
      .toBe('cosine_blend_reorder');
    const compiled = classifyGap({ ...base, detail_resolved: 'low', vector_gold_rank: 1, hybrid_gold_rank: 2, ablations: ablations({ no_compiled_truth_boost: 1 }) });
    expect(compiled.gap_class).toBe('post_fusion_boost_reorder');
    expect(compiled.class_detail).toMatch(/compiled_truth 2x/);
    expect(classifyGap({ ...base, vector_gold_rank: 1, hybrid_gold_rank: null, ablations: ablations({ no_dedup: 1 }), token_budget_dropped: 3 }).class_detail)
      .toMatch(/token_budget dropped 3/);
  });

  test('"fixes" means at or above the vector rank — a partial lift does not count', () => {
    const r = classifyGap({ ...base, vector_gold_rank: 1, hybrid_gold_rank: 5, ablations: ablations({ no_title_arm: 2, vector_only: 1 }) });
    expect(r.gap_class).toBe('unexplained');
    expect(r.best_partial).toEqual({ ablation: 'no_title_arm', gold_rank: 2 });
  });

  test('both lexical arms together is its own named class; pure-vector disagreement is vector_arm_mismatch', () => {
    expect(classifyGap({ ...base, vector_gold_rank: 1, hybrid_gold_rank: 3, ablations: ablations({ no_lexical_arms: 1, vector_only: 1 }) }).gap_class)
      .toBe('lexical_arms_combined');
    const mm = classifyGap({ ...base, vector_gold_rank: 1, hybrid_gold_rank: 3, ablations: ablations({ vector_only: 4 }) });
    expect(mm.gap_class).toBe('vector_arm_mismatch');
    expect(mm.class_detail).toMatch(/ranks gold at 4 vs live arm 1/);
    expect(classifyGap({ ...base, vector_gold_rank: 1, hybrid_gold_rank: 3, ablations: ablations({ vector_only: null }) }).class_detail).toMatch(/absent/);
  });
});

describe('stamps + intruders', () => {
  test('boostsOf keeps only multipliers != 1; stampPages records arms from list membership', () => {
    const r = row('a', 1, { backlink_boost: 1.035, salience_boost: 1, title_match_boost: 1.25, keyword_hit: true } as Partial<SearchResult>);
    expect(boostsOf(r)).toEqual({ backlink_boost: 1.035, title_match_boost: 1.25 });
    const stamps = stampPages(
      [row('a', 0.9, { keyword_hit: true } as Partial<SearchResult>), row('b', 0.8), row('a', 0.7)],
      { vector: new Set(['a', 'b']), keyword: new Set(['a']), title: new Set() },
    );
    expect(stamps.map(s => [s.slug, s.rank, s.arms])).toEqual([['a', 1, ['vector', 'keyword']], ['b', 2, ['vector']]]);
    expect(stamps[0].keyword_hit).toBe(true);
  });

  test('intruders are non-gold pages above gold that vector did not already rank above gold', () => {
    const top: PageStamp[] = ['x', 'y', 'concepts/gold', 'z'].map((slug, i) => ({
      slug, rank: i + 1, score: 1 - i / 10, base_score: null, cosine: null, chunk_source: 'compiled_truth',
      arms: slug === 'y' ? ['vector', 'title'] : ['vector'], boosts: slug === 'x' ? { backlink_boost: 1.03 } : {},
      keyword_hit: slug === 'y', keyword_relaxed: false, alias_hit: false, exact_lookup: null, relational: false, evidence: null,
    }));
    // vector order: x above gold already (rank 1 vs gold 2); y is below gold in vector (rank 5).
    const intr = findIntruders(top, ['x', 'concepts/gold', 'q', 'r', 'y'], ['concepts/gold'], 3, 2);
    expect(intr.map(i => i.slug)).toEqual(['y']);
    expect(intr[0]).toMatchObject({ hybrid_rank: 2, vector_rank: 5, arms: ['vector', 'title'] });
    // gold absent from hybrid: everything in the top-5 that vector had below gold intrudes.
    const absent = findIntruders(top.filter(t => t.slug !== 'concepts/gold').map((t, i) => ({ ...t, rank: i + 1 })), ['concepts/gold', 'x', 'y', 'z'], ['concepts/gold'], null, 1);
    expect(absent.map(i => i.slug)).toEqual(['x', 'y', 'z']);
  });
});

describe('rollups', () => {
  test('class counts per template, intruder table, mechanism ranking', () => {
    const intr = (slug: string, arms: PageStamp['arms'], boosts: PageStamp['boosts'] = {}) =>
      ({ slug, hybrid_rank: 1, vector_rank: 4, arms, boosts, keyword_relaxed: false, exact_lookup: null, relational: false });
    const records = [
      rec({ v: 1, h: 3, ranks: { no_title_arm: 1 }, template: 'synonym', intruders: [intr('companies/acme', ['vector', 'title'])] }),
      rec({ v: 1, h: 2, ranks: { no_title_arm: 1 }, template: 'synonym', intruders: [intr('companies/acme', ['vector', 'title'])] }),
      rec({ v: 2, h: 4, ranks: { no_post_fusion_boosts: 2, no_title_arm: 3 }, template: 'body-fuzzy', intruders: [intr('people/bob', ['vector'], { backlink_boost: 1.03 })] }),
      // gain; only removing the title arm loses it (every other ablation keeps gold at its live rank 1)
      rec({ v: 3, h: 1, template: 'synonym', ranks: {
        full: 1, no_title_arm: 4, no_keyword_arm: 1, no_lexical_arms: 4, no_cosine_blend: 1,
        no_post_fusion_boosts: 1, no_compiled_truth_boost: 1, no_dedup: 1, vector_only: 3,
      } }),
      rec({ v: 2, h: 2, template: 'body-fuzzy' }),                            // neutral
    ];
    const c = countClasses(records);
    expect(c.gap_probes).toBe(3);
    expect(c.classes.title_arm_injection).toBe(2);
    expect(c.classes.post_fusion_boost_reorder).toBe(1);
    const s = summarize(records, null);
    expect(s.classes_by_template.synonym.classes.title_arm_injection).toBe(2);
    expect(s.classes_by_template['body-fuzzy'].classes.post_fusion_boost_reorder).toBe(1);
    expect(s.gap_probes).toBe(3);
    expect(s.gain_probes).toBe(1);
    expect(s.neutral_probes).toBe(1);
    expect(s.boost_breakdown.gap_probes_with_any_intruder_boost).toBe(1);
    expect(s.boost_breakdown.gap_probes_with_intruder_stamp).toEqual({ backlink_boost: 1 });
    expect(s.boost_breakdown.gap_probes_by_intent).toEqual({ concept: 3 });

    const t = topIntruders(records);
    expect(t[0]).toMatchObject({ slug: 'companies/acme', count: 2, via_title_arm: 2, via_keyword_arm: 0, vector_only: 0, boosted: 0 });
    expect(t[1]).toMatchObject({ slug: 'people/bob', count: 1, vector_only: 1, boosted: 1, boost_kinds: { backlink_boost: 1 } });

    const m = rankMechanisms(records);
    expect(m[0].ablation).toBe('no_title_arm');
    expect(m[0].fixed).toBe(2);
    expect(m[0].improved_only).toBe(1);  // the body-fuzzy probe: 4 → 3, not back to 2
    expect(m[0].collateral).toBe(1);     // the gain probe loses its gain
    expect(m[0].net).toBe(1);
    const boosts = m.find(x => x.ablation === 'no_post_fusion_boosts')!;
    expect(boosts.fixed).toBe(1);
    expect(boosts.collateral).toBe(0);
    expect(s.proposal?.ablation).toBe('no_title_arm');
    expect(s.proposal?.fixed).toBe(2);
    expect(s.proposal?.block).toEqual({ fixed: 1, collateral: 0, tuning_ndcg5: boosts.tuning_ndcg5 });
    // compounds and references are never proposed
    expect(PROPOSAL_CANDIDATES).not.toContain('no_post_fusion_boosts');
    expect(PROPOSAL_CANDIDATES).not.toContain('no_lexical_arms');
    expect(PROPOSAL_CANDIDATES).not.toContain('no_lexical_no_boosts');
    expect(PROPOSAL_CANDIDATES).not.toContain('vector_only');
    // policy projections: every fixture probe has empty lexical arms, so the
    // vector-only gate equals the whole-block ablation; the entity gate applies to all (intent 'concept').
    const pol = policyProjections(records);
    const byName = Object.fromEntries(pol.map(p => [p.policy, p]));
    expect(byName.skip_metadata_boosts_when_vector_only.applies_to_probes).toBe(5);
    expect(byName.skip_metadata_boosts_when_vector_only.fixed).toBe(1);
    expect(byName.skip_metadata_boosts_when_vector_only.tuning_ndcg5).toBeCloseTo(boosts.tuning_ndcg5, 12);
    expect(byName.skip_metadata_boosts_always.fixed).toBe(1);
    expect(byName.skip_backlink_boost_unless_entity_intent.applies_to_probes).toBe(5);
    expect(s.proposal?.best_policy?.policy).toBe(pol[0].policy);
    // ablation rows never include the two reference passes
    expect(m.map(x => x.ablation)).not.toContain('full');
    expect(m.map(x => x.ablation)).not.toContain('vector_only');
  });

  test('stage flags: every single-stage ablation turns off exactly one stage; vector_only turns off all but dedup', () => {
    const full = stageFlags('full');
    expect(Object.values(full).every(Boolean)).toBe(true);
    for (const a of SINGLE_STAGE_ABLATIONS) {
      const off = Object.entries(stageFlags(a)).filter(([, v]) => v === false);
      expect(off.length).toBe(1);
    }
    for (const a of FINE_BOOST_ABLATIONS) {
      const off = Object.entries(stageFlags(a)).filter(([, v]) => v === false).map(([k]) => k);
      expect(off.length).toBe(1);
      expect(stageFlags(a).postFusionBoosts).toBe(true); // fine stages only matter while the block runs
    }
    expect(Object.entries(stageFlags('no_lexical_arms')).filter(([, v]) => v === false).map(([k]) => k).sort()).toEqual(['keywordArm', 'titleArm']);
    expect(Object.entries(stageFlags('no_lexical_no_boosts')).filter(([, v]) => v === false).map(([k]) => k).sort()).toEqual(['keywordArm', 'postFusionBoosts', 'titleArm']);
    const vo = stageFlags('vector_only');
    expect([vo.titleArm, vo.keywordArm, vo.cosineBlend, vo.postFusionBoosts, vo.compiledTruthBoost, vo.dedup]).toEqual([false, false, false, false, false, true]);
    expect(HYBRID_LIMIT).toBe(30);
  });
});

describe('CLI + markdown', () => {
  test('flags map in both forms; unknown flags and bad values throw', () => {
    expect(parseLocalizeArgv([
      '--stub-embed', '--no-page-vector', '--embedding-model=voyage:voyage-4', '--embedding-dims', '1024',
      '--tuning-concepts', '20', '--holdout-concepts=10', '--seed', '42', '--max-probes', '8', '--reports-dir', '/tmp/x', '--e0-receipt', '/tmp/r.json',
      '--rerender', '/tmp/l.json',
    ], {})).toEqual({
      stubEmbed: true, noPageVector: true, embeddingModel: 'voyage:voyage-4', embeddingDims: '1024',
      tuningConcepts: 20, holdoutConcepts: 10, seed: 42, maxProbes: 8, reportsDir: '/tmp/x', e0Receipt: '/tmp/r.json', rerender: '/tmp/l.json',
    });
    expect(() => parseLocalizeArgv(['--reranker', 'off'], {})).toThrow(/unknown argument/);
    expect(() => parseLocalizeArgv(['--max-probes', '0'], {})).toThrow(/>= 1/);
    expect(() => parseLocalizeArgv(['--seed', 'x'], {})).toThrow(/non-negative integer/);
    expect(() => parseLocalizeArgv(['--embedding-model'], {})).toThrow(/requires a value/);
    expect(parseLocalizeArgv([], { CAT13_STUB_EMBED: '1' }).stubEmbed).toBe(true);
  });

  test('markdown names the ladder, the classes, the proposal and the stub banner', () => {
    const records = [rec({ v: 1, h: 3, ranks: { no_title_arm: 1 } }), rec({ v: 2, h: 1 })];
    const report: LocalizeReport = {
      generated_at: 'now', gbrain_version: 'x', gbrain_pin: 'y', stub_embed: true,
      embedder: { model: 'voyage:voyage-4', dims: 1024 }, embedding_transport: 'stub',
      search_pins: { 'search.mode': 'balanced' },
      knobs: { limit: 30, innerLimit: 60, intentWeighting: true, keywordOrFallback: true, tokenBudget: 12000, titleBoost: 1.25, graphSignals: true, floorRatio: undefined, mode: 'balanced' },
      concept_split: { seed: 42, tuning_n: 20, holdout_n: 10, tuning: [], holdout: [] },
      probes: { generated: 10, tuning: 2, measured: 2, max_probes: null },
      e0_receipt: { path: '/x', vector_tuning_ndcg5: 0.596, gbrain_tuning_ndcg5: 0.506, vector_tuning_p1: 0.7, gbrain_tuning_p1: 0.5 },
      summary: summarize(records, { path: '/x', vector_tuning_ndcg5: 0.596, gbrain_tuning_ndcg5: 0.506, vector_tuning_p1: 0.7, gbrain_tuning_p1: 0.5 }),
      records,
    };
    const md = renderMarkdown(report);
    expect(md).toContain('STUB EMBEDDINGS');
    expect(md).toContain('E0-V1 `vector` adapter (receipt, tuning) | 59.6');
    expect(md).toContain('| title_arm_injection | 1 | 1 |');
    expect(md).toContain('**Single stage: title arm');
    expect(md).toContain('fixes 1 of 1 gap probes');
    expect(md).toContain('## Implementable gates');
    expect(md).toContain('skip_metadata_boosts_when_vector_only');
    expect(md).toContain('reproduced the live hybrid page order on 2 / 2 probes');
  });
});

describe('gap localization e2e (hermetic, stub embeds, one PGLite brain)', () => {
  test('the full re-simulation reproduces the live hybrid order on every measured probe; report files land', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cat13-gap-'));
    const { report, files } = await runLocalize({
      stubEmbed: true,
      embeddingModel: 'voyage:voyage-4',
      embeddingDims: 1024,
      targetProbes: 60,
      maxProbes: 6,
      reportsDir: dir,
      e0Receipt: join(dir, 'missing-receipt.json'),
      quiet: true,
    });
    expect(existsSync(files.json)).toBe(true);
    expect(existsSync(files.md)).toBe(true);
    expect(report.stub_embed).toBe(true);
    expect(report.e0_receipt).toBeNull();
    expect(report.probes.measured).toBe(6);
    expect(report.records.length).toBe(6);
    expect(report.knobs.mode).toBe('balanced');
    expect(report.knobs.limit).toBe(HYBRID_LIMIT);
    // The live call must run the UNGATED boost pipeline the re-simulation models.
    expect(report.search_pins['search.metadata_boost_gate']).toBe('always');
    for (const r of report.records) {
      expect(r.vector_enabled).toBe(true);
      expect(r.meta.embedding_column).not.toBeNull();
      expect(r.meta.metadata_boost_gate?.reason).toBe('gate_always');
      expect(r.meta.metadata_boost_gate?.boosts_applied).toBe(true);
      expect(Object.keys(r.ablations).sort()).toEqual([...ABLATIONS].sort());
      expect(r.arms.vector_rows).toBeGreaterThan(0);
      expect(r.simulation.top5_match).toBe(true);
      expect(r.live.page_vector_docside_ndcg5).not.toBeNull();
      if (r.gap) expect(r.gap_class).not.toBeNull();
      else expect(r.gap_class).toBeNull();
    }
    expect(report.summary.simulation.top5_mismatches).toBe(0);
    const parsed = JSON.parse(readFileSync(files.json, 'utf8')) as LocalizeReport;
    expect(parsed.summary.ladder.some(l => l.ranking.startsWith('gbrain hybrid live'))).toBe(true);
    expect(readFileSync(files.md, 'utf8')).toContain('# Cat 13 — Phase E1 gap localization');
    // --rerender recomputes the same summary from the recorded records (no brain, no embeds)
    const re = rerenderReport(files.json, join(dir, 'rerender'));
    expect(re.report.rerendered_at).toBeDefined();
    expect(re.report.summary.classes).toEqual(parsed.summary.classes);
    expect(re.report.summary.mechanisms.map(m => [m.ablation, m.fixed])).toEqual(parsed.summary.mechanisms.map(m => [m.ablation, m.fixed]));
    expect(existsSync(re.files.md)).toBe(true);
  }, 300_000);
});
