import { describe, expect, test } from 'bun:test';
import {
  N4_DEFAULT_SEED, deriveGold, entityByPage, generateLedger, ledgerFingerprint, levenshtein, oracleResolve,
  pageKey, parseWrittenPage, renderPage, type Gold, type Ledger, type LedgerPage,
} from '../../eval/generators/n4-entity-gen.ts';
import { GoldStore } from '../../eval/runner/evaluator/gold-store.ts';
import { resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { ProbeAccounting } from '../../eval/runner/probe-accounting.ts';
import {
  baselinePrediction, bcubed, outcomeOf, plannedProbes, runN4, scoreSurface, verdictOf, writtenPages,
  type Prediction, type ScoredProbe, type ScoringContext,
} from '../../eval/runner/n4-entity-resolution.ts';

const page = (over: Partial<LedgerPage> & Pick<LedgerPage, 'slug' | 'title'>): LedgerPage => ({
  source: 'default', entity: over.slug, type: 'person', aliases: [], declarations: [], body: 'body', ...over,
});
const written = (p: LedgerPage) => parseWrittenPage(p.source, p.slug, renderPage(p));
const noGroups = (k: string) => k;

describe('N4 generator', () => {
  test('same seed gives the identical ledger fingerprint; a different seed gives a different ledger', () => {
    const a = generateLedger(N4_DEFAULT_SEED);
    const b = generateLedger(N4_DEFAULT_SEED);
    expect(ledgerFingerprint(a)).toBe(ledgerFingerprint(b));
    const c = generateLedger(N4_DEFAULT_SEED + 1);
    expect(ledgerFingerprint(c)).not.toBe(ledgerFingerprint(a));
    expect(c.pages.map(p => p.title)).not.toEqual(a.pages.map(p => p.title));
  });

  test('the oracle agrees with the ledger design on many seeds and covers every family and refusal design', () => {
    for (let seed = 1; seed <= 60; seed++) expect(() => deriveGold(generateLedger(seed))).not.toThrow();
    const ledger = generateLedger();
    const families = new Set(ledger.mentions.map(m => m.family));
    for (const f of ['exact-slug', 'exact-name', 'nickname', 'typo', 'handle', 'initials', 'changed-name', 'first-name', 'namesake', 'no-referent']) expect(families.has(f as never)).toBe(true);
    const designs = new Set(ledger.mentions.map(m => m.design));
    for (const d of ['solvable', 'ambiguous', 'no-referent', 'unreadable']) expect(designs.has(d as never)).toBe(true);
  });

  test('every solvable gold names the evidence line that appears in a readable rendered page', () => {
    const ledger = generateLedger();
    const gold = deriveGold(ledger);
    for (const m of ledger.mentions) {
      const g = gold.get(m.id)!;
      if (g.kind !== 'entity') continue;
      const readable = ledger.pages.filter(p => m.caller.sources.includes(p.source) && g.pages.includes(pageKey(p)));
      // A slug is the import key, not page text; every other rule quotes a written line.
      if (g.rule === 'exact-slug') expect(readable.map(p => `slug ${p.slug}`)).toContain(g.evidence);
      else expect(readable.map(renderPage).join('\n')).toContain(g.evidence.replace(/^title: /, '').replace(/^aliases: - /, ''));
    }
  });

  test('names are fictional placeholders', () => {
    for (const p of generateLedger().pages) expect(p.title).toMatch(/Example$/);
  });
});

describe('N4 oracle on hand-built cases', () => {
  const alice = page({ slug: 'people/alice-harbor-example', title: 'Alice Harbor-Example', aliases: ['Ally', '@aharbor'] });
  const bob = page({ slug: 'people/bob-quill-example', title: 'Bob Quill-Example', declarations: ['Goes by Bobby.'] });
  const formerAlice = page({ slug: 'people/alice-stone-example', title: 'Alice Stone-Example', aliases: ['Alice Harbor-Example'] });

  test('exact slug and exact name resolve, with evidence', () => {
    const pages = [alice, bob].map(written);
    expect(oracleResolve('people/alice-harbor-example', pages, noGroups).rule).toBe('exact-slug');
    const byName = oracleResolve('alice harbor-example', pages, noGroups);
    expect([byName.rule, byName.hits.map(h => h.page.slug)]).toEqual(['exact-name', ['people/alice-harbor-example']]);
  });

  test('the exact canonical name beats another page\'s alias (the floor)', () => {
    const r = oracleResolve('Alice Harbor-Example', [alice, formerAlice].map(written), noGroups);
    expect([r.rule, r.hits.map(h => h.page.slug)]).toEqual(['exact-name', ['people/alice-harbor-example']]);
  });

  test('aliases and prose declarations are both declared names; a shared one is ambiguous', () => {
    expect(oracleResolve('Bobby', [alice, bob].map(written), noGroups).hits[0].evidence).toBe('Goes by Bobby.');
    const twin = page({ slug: 'people/alice-birch-example', title: 'Alice Birch-Example', aliases: ['Ally'] });
    expect(oracleResolve('Ally', [alice, twin].map(written), noGroups).hits).toHaveLength(2);
  });

  test('a one-edit typo resolves only with a two-edit margin', () => {
    expect(oracleResolve('Alce Harbor-Example', [alice, bob].map(written), noGroups).hits.map(h => h.page.slug)).toEqual([alice.slug]);
    const near = page({ slug: 'people/alice-harber-example', title: 'Alice Harber-Example' });
    expect(levenshtein('alce harbor-example', 'alice harber-example')).toBe(2);
    expect(oracleResolve('Alce Harbor-Example', [alice, near].map(written), noGroups).hits).toHaveLength(2);
  });

  test('initials and first names use person titles; no evidence is a refusal', () => {
    const pages = [alice, bob].map(written);
    expect(oracleResolve('A. Harbor-Example', pages, noGroups).rule).toBe('initials');
    expect(oracleResolve('Bob', pages, noGroups).rule).toBe('first-name');
    expect(oracleResolve('Carol Nobody-Example', pages, noGroups)).toEqual({ rule: null, hits: [] });
  });

  test('pages linked by an identity group count as one entity; unreadable sources give no evidence', () => {
    const teamAlice = page({ source: 'team', slug: 'people/aharbor-example', title: 'Alice Harbor-Example', entity: alice.slug });
    const groups = (k: string) => (k === pageKey(alice) || k === pageKey(teamAlice) ? 'identity:alice' : k);
    const r = oracleResolve('Alice Harbor-Example', [alice, teamAlice].map(written), groups);
    expect(new Set(r.hits.map(h => groups(h.page.key))).size).toBe(1);
    expect(oracleResolve('people/aharbor-example', [alice].map(written), noGroups).hits).toHaveLength(0);
  });

  test('deriveGold throws when the ledger design disagrees with the written evidence', () => {
    const ledger = generateLedger();
    const ambiguous = ledger.mentions.find(m => m.design === 'ambiguous')!;
    const broken: Ledger = { ...ledger, mentions: ledger.mentions.map(m => (m.id === ambiguous.id ? { ...m, design: 'solvable' as const } : m)) };
    expect(() => deriveGold(broken)).toThrow(/oracle disagrees/);
  });
});

describe('N4 metrics', () => {
  test('B-cubed on hand-computed cases', () => {
    expect(bcubed(['a', 'a', 'b'], ['x', 'x', 'y'])).toEqual({ precision: 1, recall: 1, f1: 1 });
    const allOne = bcubed(['a', 'a', 'b', 'b'], ['x', 'x', 'x', 'x']);
    expect(allOne.precision).toBeCloseTo(0.5);
    expect(allOne.recall).toBeCloseTo(1);
    const singletons = bcubed(['a', 'a', 'b', 'b'], [null, null, null, null]);
    expect(singletons.precision).toBeCloseTo(1);
    expect(singletons.recall).toBeCloseTo(0.5);
    // Refusal gold is a singleton: merging two refusals costs precision.
    expect(bcubed([null, null], ['x', 'x']).precision).toBeCloseTo(0.5);
  });

  const ledger = generateLedger();
  const gold = new GoldStore<Gold>('n4-test', deriveGold(ledger));
  const entityOfPage = entityByPage(ledger);
  const ctx: ScoringContext = { entityOfPage, clusterOfPage: k => `c:${entityOfPage.get(k)}` };
  const single = ledger.mentions.filter(m => m.caller.sources.length === 1 && !m.caller.remote);
  const probes = (fn: (g: Gold, m: typeof single[number]) => Prediction): ScoredProbe[] =>
    single.map(m => ({ id: m.id, family: m.family, documented: m.documented, floor: m.family.startsWith('exact'), pred: gold.score(m.id, g => fn(g, m)) }));

  test('a perfect resolver scores 1 everywhere', () => {
    const m = scoreSurface(probes(g => (g.kind === 'entity' ? { kind: 'pages', pages: [g.pages[0]] } : { kind: 'unresolved' })), gold, ctx);
    expect([m.b3.f1, m.accuracy, m.correct_refusal_rate, m.wrong_merge_rate, m.unresolved_rate]).toEqual([1, 1, 1, 0, 0]);
    expect(verdictOf({ surfaces: { resolver: m, recall: m, remember: m, resolve_on_save: m }, search_floor: { n: 1, correct: 1, rate: 1, errors: 0 },
      identity: { n: 1, expected_members: 1, found_members: 1, recall: 1, leaks: 0, foreign_rows: 0, foreign_by_scope: {} } }).verdict).toBe('pass');
  });

  test('refuse-everything and merge-everything both score badly', () => {
    const pages = writtenPages(ledger);
    const refuse = scoreSurface(single.map(m => ({ id: m.id, family: m.family, documented: m.documented, floor: false, pred: baselinePrediction('singleton-everything', m, pages) })), gold, ctx);
    expect(refuse.correct_refusal_rate).toBe(1);
    expect(refuse.unresolved_rate).toBe(1);
    expect(refuse.b3.f1).toBeLessThan(0.6);
    const merge = scoreSurface(single.map(m => ({ id: m.id, family: m.family, documented: m.documented, floor: false, pred: baselinePrediction('merge-everything', m, pages) })), gold, ctx);
    expect(merge.wrong_merge_rate).toBe(1);
    expect(merge.correct_refusal_rate).toBe(0);
    expect(merge.b3.f1).toBeLessThan(0.3);
    const exact = scoreSurface(single.map(m => ({ id: m.id, family: m.family, documented: m.documented, floor: false, pred: baselinePrediction('exact-only', m, pages) })), gold, ctx);
    expect(exact.wrong_merges).toBe(0);
    expect(exact.accuracy).toBeLessThan(0.6);
  });

  test('errors are misses, phantoms are fragmentation, and neither counts as a wrong merge', () => {
    const solvable = single.find(m => m.design === 'solvable')!;
    const refusal = single.find(m => m.design === 'ambiguous')!;
    const g = gold.read(solvable.id);
    const r = gold.read(refusal.id);
    expect(outcomeOf(g, { kind: 'error', message: 'boom' }, ctx)).toBe('error');
    expect(outcomeOf(r, { kind: 'error', message: 'boom' }, ctx)).toBe('error');
    expect(outcomeOf(g, { kind: 'phantom', slug: 'default:ally' }, ctx)).toBe('fragmented');
    expect(outcomeOf(r, { kind: 'phantom', slug: 'default:ally' }, ctx)).toBe('correct-refusal');
    const other = ledger.pages.find(p => g.kind === 'entity' && p.entity !== g.entity)!;
    expect(outcomeOf(g, { kind: 'pages', pages: [pageKey(other)] }, ctx)).toBe('wrong-merge');
  });
});

describe('N4 end to end against the pinned gbrain', () => {
  test('a trimmed world lands, passes presence, and scores every planned probe', async () => {
    const full = generateLedger();
    const keep = new Set<string>();
    for (const family of ['exact-slug', 'exact-name', 'handle', 'namesake', 'no-referent', 'nickname']) {
      for (const m of full.mentions.filter(x => x.family === family).slice(0, 4)) keep.add(m.id);
    }
    const ledger: Ledger = { ...full, mentions: full.mentions.filter(m => keep.has(m.id)) };
    const gold = new GoldStore<Gold>('n4-e2e', deriveGold(ledger));
    const acc = new ProbeAccounting(plannedProbes(ledger));
    const result = await runN4(resolveGbrainUnderTest(null), ledger, gold, { seed: ledger.seed, acc });
    expect(result.presence.every(p => p.ok)).toBe(true);
    const summary = acc.summary();
    expect(summary.n_scored).toBe(summary.n_total);
    expect(summary.errors).toEqual([]);
    const exactSlug = result.surfaces.resolver.by_family['exact-slug'];
    expect(exactSlug.correct).toBe(exactSlug.n);
    expect(result.search_floor.n).toBeGreaterThan(0);
    expect(result.identity.leaks).toBe(0);
    expect(result.baselines['merge-everything'].wrong_merge_rate).toBe(1);
  }, 60_000);
});
