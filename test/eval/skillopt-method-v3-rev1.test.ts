/**
 * skillopt-method-v3 revision 1 (GBEV-30, plan section 4's one revision): the
 * legal-entity world behind `V3Knobs.revision`, the revision-1 families of the
 * three skills, and the findability control. Keyless; no model call. The
 * parity test opens a PGLite brain over the revision-1 world and re-runs
 * gbrain's search on a sample of the cached queries.
 */
import { describe, expect, test } from 'bun:test';
import { BRIEFING_V3_HELD_OUT_BY_REVISION, BRIEFING_V3_QUOTAS_BY_REVISION, generateBriefingV3 } from '../../eval/generators/skillopt-method/briefing-v3.ts';
import { degenerateAnswers, loadWorldV3, MAX_TASKS_PER_GROUP_V3, SPLIT_SIZES_V3, splitLeaksV3, type MethodTaskV3, type SkillGenerationV3 } from '../../eval/generators/skillopt-method/common-v3.ts';
import { FACT_CHECK_V3_HELD_OUT_BY_REVISION, FACT_CHECK_V3_QUOTAS_BY_REVISION, generateFactCheckV3 } from '../../eval/generators/skillopt-method/fact-check-v3.ts';
import { openSearch, REV1_KNOBS, rev1ProbeQueries } from '../../eval/generators/skillopt-method/findability-v3.ts';
import { generateQueryV3, QUERY_V3_HELD_OUT_BY_REVISION, QUERY_V3_QUOTAS_BY_REVISION } from '../../eval/generators/skillopt-method/query-v3.ts';
import {
  accountsOwnedFromText, FINDABILITY, legalEntityFromText, loadFindabilityCache, neededFor, ownerFromText, partyFromText, worldHash, type FindabilityProbe, type Pattern,
} from '../../eval/generators/skillopt-method/rev1-v3.ts';
import { DEFAULT_V3_KNOBS, generateWorldV3, LEGAL_ENTITY, partyOf, VENDOR } from '../../eval/generators/skillopt-method/world-v3.ts';
import { Rng } from '../../eval/generators/seeded.ts';
import { compileJudgeV3, SPLITS_V3, type GoldV3 } from '../../eval/runner/skillopt-method/score-v3.ts';
import { evaluateLayers, SKILLS, type SkillName } from '../../eval/runner/skillopt-method/score.ts';

/** sha256 of the revision-0 world's pages (rev1-v3.ts `worldHash`): the calibrated world, which revision 1 must leave untouched. */
const REV0_WORLD_SHA256 = 'f8c684dd8e2d644147d5a43ef744b2b00af2bb8fd86df319ffae11cf0a6c7632';

const GENERATE: Record<SkillName, (k: typeof REV1_KNOBS) => SkillGenerationV3> = { query: generateQueryV3, briefing: generateBriefingV3, 'fact-check': generateFactCheckV3 };
const QUOTAS: Record<SkillName, Record<string, readonly number[]>> = { query: QUERY_V3_QUOTAS_BY_REVISION[1], briefing: BRIEFING_V3_QUOTAS_BY_REVISION[1], 'fact-check': FACT_CHECK_V3_QUOTAS_BY_REVISION[1] };
const HELD_OUT: Record<SkillName, readonly string[]> = { query: QUERY_V3_HELD_OUT_BY_REVISION[1], briefing: BRIEFING_V3_HELD_OUT_BY_REVISION[1], 'fact-check': FACT_CHECK_V3_HELD_OUT_BY_REVISION[1] };
const REV0_FAMILIES: Record<SkillName, readonly string[]> = { query: Object.keys(QUERY_V3_QUOTAS_BY_REVISION[0]), briefing: Object.keys(BRIEFING_V3_QUOTAS_BY_REVISION[0]), 'fact-check': Object.keys(FACT_CHECK_V3_QUOTAS_BY_REVISION[0]) };
const gens = Object.fromEntries(SKILLS.map(s => [s, GENERATE[s](REV1_KNOBS)])) as Record<SkillName, SkillGenerationV3>;
const probesOf = (skill: SkillName, family?: string) => gens[skill].report.findability!.tasks.filter(t => !family || t.family === family).flatMap(t => t.probes);
const familyPatterns = (skill: SkillName, family: string) => new Set(probesOf(skill, family).flatMap(p => p.patterns));
const isAbstention = (t: MethodTaskV3) => !t.answerable || t.gold.spec.kind === 'absent' || (t.gold.spec.kind === 'fact-check' && t.gold.spec.status === 'not-supported') || (t.gold.spec.kind === 'briefing' && t.gold.spec.meetings.some(m => m.absent));

describe('skillopt-method-v3 revision 1: the world', () => {
  test('revision 0 regenerates the calibrated world: no legal entity, the pinned page hash', () => {
    const w0 = generateWorldV3({ ...DEFAULT_V3_KNOBS, revision: 0 });
    expect(worldHash(w0.pages)).toBe(REV0_WORLD_SHA256);
    expect(worldHash(generateWorldV3({ ...DEFAULT_V3_KNOBS, revision: undefined }).pages)).toBe(REV0_WORLD_SHA256);
    expect([...w0.orgs.values()].some(o => o.legal)).toBe(false);
    expect([...w0.pages.values()].some(p => p.includes('issued to its legal entity'))).toBe(false);
  });

  test('revision 1 gives two thirds of the long chains a legal entity, and the oracles read it from the pages alone', () => {
    const { world: w, pages } = loadWorldV3(REV1_KNOBS);
    const w0 = generateWorldV3({ ...DEFAULT_V3_KNOBS, revision: 0 });
    expect(pages.size).toBe(w0.pages.size);
    expect(worldHash(pages)).not.toBe(REV0_WORLD_SHA256);
    const accounts = [...w.orgs.values()].filter(o => o.kind === 'account');
    const long = accounts.filter(a => w.chains.get(a.slug)!.length >= 3);
    const legal = accounts.filter(a => a.legal);
    expect(legal.every(a => long.includes(a))).toBe(true);
    expect(Math.abs(legal.length / long.length - LEGAL_ENTITY.share)).toBeLessThan(0.15);
    const names = new Set([...w.orgs.values(), ...w.people.values()].map(e => e.name));
    for (const a of accounts) {
      expect([a.slug, legalEntityFromText(pages, a.slug)]).toEqual([a.slug, a.legal ? { name: a.legal.name, since: a.legal.since } : null]);
      if (!a.legal) continue;
      expect([a.slug, names.has(a.legal.name), a.legal.name.includes(a.stem)]).toEqual([a.slug, false, false]);
      const chain = w.chains.get(a.slug)!;
      expect([a.slug, chain[0]!.signed < a.legal.since, chain.at(-1)!.signed >= a.legal.since]).toEqual([a.slug, true, true]);
    }
    for (const c of w.contracts.values()) {
      const a = w.orgs.get(c.account)!;
      expect([c.slug, partyFromText(pages, c.slug)]).toEqual([c.slug, partyOf(a, c)]);
      if (partyOf(a, c) !== a.name) expect([c.slug, pages.get(c.slug)!.includes(a.name)]).toEqual([c.slug, false]);
    }
    for (const a of accounts) expect([a.slug, ownerFromText(pages, a.slug)?.slug]).toEqual([a.slug, a.owner]);
    for (const [slug, page] of pages) for (const m of page.matchAll(/\]\(([a-z]+\/[a-z0-9-]+)\)/g)) expect([slug, m[1], pages.has(m[1]!)]).toEqual([slug, m[1], true]);
    const p0 = new Map([...w0.people.values()].map(p => [p.slug, p.name]));
    expect(new Map([...w.people.values()].map(p => [p.slug, p.name]))).toEqual(p0);
  });
});

for (const skill of SKILLS) describe(`skillopt-method-v3 revision 1: ${skill}`, () => {
  const { tasks, report } = gens[skill];

  test('24/24/36/96 tasks in the revision-1 family mix, every family new; held-out families only in gate and test; an abstention family is trained', () => {
    expect(SPLITS_V3.map(sp => tasks.filter(t => t.split === sp).length)).toEqual(SPLITS_V3.map(sp => SPLIT_SIZES_V3[sp]));
    for (const [family, q] of Object.entries(QUOTAS[skill])) expect([family, SPLITS_V3.map(sp => tasks.filter(t => t.split === sp && t.family === family).length)]).toEqual([family, [...q]]);
    for (const t of tasks) expect([t.task_id, t.held_out, t.held_out ? ['gate', 'test'].includes(t.split) : true]).toEqual([t.task_id, HELD_OUT[skill].includes(t.family), true]);
    for (const f of Object.keys(QUOTAS[skill])) expect([f, REV0_FAMILIES[skill].includes(f)]).toEqual([f, false]);
    expect(tasks.some(t => t.split === 'train' && isAbstention(t))).toBe(true);
    expect(report.knobs).toEqual(REV1_KNOBS);
  });

  test('one anchor per task, no fact or gold page in two splits, at most three tasks per group inside one split; capacity met with no solvability or degenerate drop', () => {
    expect(splitLeaksV3(tasks)).toEqual([]);
    expect(new Set(tasks.map(t => t.anchor.id)).size).toBe(tasks.length);
    const groups = new Map<string, MethodTaskV3[]>();
    for (const t of tasks) groups.set(t.group_id, [...(groups.get(t.group_id) ?? []), t]);
    for (const [id, g] of groups) expect([id, g.length <= MAX_TASKS_PER_GROUP_V3, new Set(g.map(t => t.split)).size]).toEqual([id, true, 1]);
    for (const row of report.capacity) expect([row.family, row.short]).toEqual([row.family, 0]);
    expect([report.dropped_by_solvability, report.dropped_by_degenerate]).toEqual([0, 0]);
    expect(typeof report.dropped_by_findability).toBe('number');
  });

  test('every judge compiles from its gold; the solvability control passes in full and every degenerate answer fails substance', () => {
    for (const t of tasks) {
      expect([t.task_id, t.judge]).toEqual([t.task_id, compileJudgeV3(skill, t.gold as GoldV3)]);
      expect([t.task_id, evaluateLayers(t.oracle_answer, t.judge).full]).toEqual([t.task_id, true]);
      for (const d of degenerateAnswers(skill, t)) expect([t.task_id, d.kind, evaluateLayers(d.text, t.judge).substance]).toEqual([t.task_id, d.kind, false]);
    }
  });

  test('every placed task obeys the findability rules on every probe, and every family reports its median deciding rank', () => {
    const f = report.findability!;
    expect(f.search.limit).toBe(FINDABILITY.limit);
    expect(f.tasks.map(t => t.task_id).sort()).toEqual(tasks.map(t => t.task_id).sort());
    const inTop = (r: number | null) => r !== null && r <= FINDABILITY.top;
    for (const t of f.tasks) {
      expect([t.task_id, t.probes.length > 0]).toEqual([t.task_id, true]);
      for (const p of t.probes) {
        for (const pat of p.patterns) {
          if (pat === 'indirect' || pat === 'join') expect([t.task_id, pat, p.deciding.every(d => inTop(d.rank))]).toEqual([t.task_id, pat, false]);
          if (pat === 'supersession') expect([t.task_id, pat, p.newest?.rank === 1, !!p.newest]).toEqual([t.task_id, pat, false, true]);
          if (pat === 'aggregation') expect([t.task_id, pat, (p.needed_pages ?? 0) >= FINDABILITY.min_needed_pages]).toEqual([t.task_id, pat, true]);
        }
      }
    }
    expect(f.families.map(r => r.family)).toEqual(Object.keys(QUOTAS[skill]));
    for (const r of f.families) {
      expect([r.family, r.tasks, r.patterns.length > 0]).toEqual([r.family, SPLITS_V3.reduce((n, _, i) => n + QUOTAS[skill][r.family]![i]!, 0), true]);
      if (!r.patterns.includes('abstention')) expect([r.family, typeof r.median_deciding_rank]).toEqual([r.family, 'number']);
    }
  });
});

describe('skillopt-method-v3 revision 1: the patterns', () => {
  test('across the three skills, trained and held-out families both test indirect references, joins, aggregation over 10 or more pages and buried supersession; each skill trains an abstention family', () => {
    const covered = (heldOut: boolean) => new Set(SKILLS.flatMap(skill => Object.keys(QUOTAS[skill]).filter(f => HELD_OUT[skill].includes(f) === heldOut).flatMap(f => [...familyPatterns(skill, f)])));
    for (const p of ['indirect', 'join', 'aggregation', 'supersession'] as Pattern[]) expect([p, covered(false).has(p), covered(true).has(p) || p === 'supersession']).toEqual([p, true, true]);
    for (const skill of SKILLS) expect([skill, Object.keys(QUOTAS[skill]).filter(f => !HELD_OUT[skill].includes(f)).some(f => familyPatterns(skill, f).has('abstention'))]).toEqual([skill, true]);
  });

  test('aggregation probes count the pages an exhaustive reader opens: every page of the rep\'s accounts and every record they list as signed by the date', () => {
    const { pages } = loadWorldV3(REV1_KNOBS);
    const t = gens.query.tasks.find(x => x.family === 'rep-total')!;
    const rep = /accounts (.+) owns at /.exec(t.task)![1]!;
    const repSlug = [...pages.keys()].find(s => s.startsWith('people/') && pages.get(s)!.includes(`# ${rep}\n`))!;
    const members = accountsOwnedFromText(pages, repSlug);
    const probe = gens.query.report.findability!.tasks.find(x => x.task_id === t.task_id)!.probes[0]!;
    expect(members.length).toBeGreaterThanOrEqual(3);
    expect(probe.needed_pages).toBeGreaterThanOrEqual(FINDABILITY.min_needed_pages);
    expect(neededFor(pages, members, '2099-01-01').length).toBeGreaterThanOrEqual(probe.needed_pages!);
    expect(t.task).toContain(VENDOR.name);
  });
});

describe('skillopt-method-v3 revision 1: the findability cache', () => {
  test('was searched on this world and holds every probe of every revision-1 draft', () => {
    const { pages } = loadWorldV3(REV1_KNOBS);
    const { header, hits } = loadFindabilityCache(pages);
    expect(header.world_sha256).toBe(worldHash(pages));
    expect([header.tool, header.limit, header.clock, header.embeddings]).toEqual([FINDABILITY.tool, FINDABILITY.limit, FINDABILITY.clock, 'off']);
    expect(rev1ProbeQueries().filter(q => !hits.has(q))).toEqual([]);
    expect(header.queries).toBe(hits.size);
  });

  test('gbrain\'s search, re-run now, returns the cached hits for a sample of placed tasks\' probes', async () => {
    const { pages } = loadWorldV3(REV1_KNOBS);
    const { hits } = loadFindabilityCache(pages);
    const probes: FindabilityProbe[] = SKILLS.flatMap(s => probesOf(s));
    const sample = new Rng(30_014).shuffle([...new Set(probes.map(p => p.query))]).slice(0, 36);
    const { search, close } = await openSearch(pages);
    try {
      for (const q of sample) expect([q, await search(q)]).toEqual([q, hits.get(q)!]);
    } finally {
      await close();
    }
  }, 180_000);
});
