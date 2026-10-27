/**
 * Agent retrieval shapes (registry id agent-retrieval-shapes): generator
 * determinism, the oracle's solvability checks, the scorer on hand-built
 * gold (with negatives that must fail), the scorer mutation suite, and
 * deliberately broken adapters the category must fail.
 */
import { describe, expect, test } from 'bun:test';
import { registryEntry } from '../../eval/registry.ts';
import { assertScorerRejectsFakeSystems } from '../../eval/runner/mutation-kit.ts';
import { resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import {
  ARS_CHUNK_CAP_CHARS, ARS_DEFAULT_SEED, deriveArsGold, generateArsLedger, generateArsWorld, pageKey, resolveVariant, parseRendered, renderPage,
  type ArsGold, type ArsProbe, type ArsSurface,
} from '../../eval/generators/agent-retrieval-shapes-gen.ts';
import {
  emptyObservation, parseFamilies, runAgentRetrievalShapes, scoreMonotonic, scoreObservations, scoreProbe,
  type ArsObservation, type ArsRow, type OpWrapper,
} from '../../eval/runner/agent-retrieval-shapes.ts';

const row = (key: string, score = 1, chars = 200): ArsRow => {
  const at = key.indexOf(':');
  return { key, source: key.slice(0, at), slug: key.slice(at + 1), score, chars };
};
const rows = (...keys: string[]) => keys.map((k, i) => row(k, 1 - i / 100));
const obs = (o: Partial<ArsObservation>): ArsObservation => ({ ...emptyObservation(), ...o });
const entity = (found: boolean, key: string | null, suggestions: string[] = [], named: string[] = []) => ({ found, key, suggestions, named });

/** sha256 of the default-seed ledger (agent-retrieval-shapes-gen/1.0.0); a change means the world changed. */
const DEFAULT_LEDGER_SHA = '902d6385664b2096f4da995810e212a9ab0cbf0e20551fc7ccebd53f5c6bbebc';

describe('agent-retrieval-shapes generator', () => {
  test('same seed, same ledger hash; another seed, another ledger', () => {
    const a = generateArsWorld();
    expect(generateArsWorld().fingerprint).toBe(a.fingerprint);
    expect(a.fingerprint).toBe(DEFAULT_LEDGER_SHA);
    expect(generateArsWorld({ seed: ARS_DEFAULT_SEED + 1 }).fingerprint).not.toBe(a.fingerprint);
  });

  test('the oracle derives gold for every probe on several seeds, and every family has probes', () => {
    for (const seed of [1, 2, 3, ARS_DEFAULT_SEED]) {
      const w = generateArsWorld({ seed });
      expect(w.gold.size).toBe(w.ledger.probes.length);
      const families = new Set(w.ledger.probes.map(p => p.family));
      for (const f of ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9', 'E10', 'E11', 'E13', 'E14', 'E15']) expect([seed, f, families.has(f as never)]).toEqual([seed, f, true]);
    }
  });

  test('a --families subset keeps only those families\' pages and probes', () => {
    const l = generateArsLedger({ families: ['E2', 'E10'] });
    expect(new Set(l.pages.map(p => p.family))).toEqual(new Set(['E2', 'E10']));
    expect(new Set(l.probes.map(p => p.family))).toEqual(new Set(['E2', 'E10']));
    expect(l.images).toEqual([]);
  });

  test('the oracle throws when the world breaks its design (solvability control)', () => {
    const l = generateArsLedger();
    const card = l.pages.find(p => p.family === 'E10' && l.probes.some(pr => pr.family === 'E10' && pr.design.slug === p.slug))!;
    const id = l.probes.find(pr => pr.family === 'E10' && pr.design.slug === card.slug)!.text;
    const broken = { ...l, pages: [...l.pages, { ...card, slug: 'contacts/a-copy', body: card.body }] };
    expect(() => deriveArsGold(broken)).toThrow(/exactly one page/);
    expect(id.length).toBeGreaterThan(0);
  });

  test('rendered pages round-trip through the oracle reader', () => {
    const p = generateArsLedger().pages[0];
    const back = parseRendered(p.source, p.slug, renderPage(p));
    expect(back.title).toBe(String(p.frontmatter.title));
    expect(back.body).toBe(p.body);
  });

  test('the E6/E7 oracle strips honorifics and refuses ambiguous surnames', () => {
    const pages = [
      { source: 'default', slug: 'people/katherine-velmo-example', frontmatter: { type: 'person', title: 'Katherine Velmo-Example' }, title: 'Katherine Velmo-Example', type: 'person', body: '' },
      { source: 'default', slug: 'people/mayor-velmo-example', frontmatter: { type: 'person', title: 'Mayor Velmo-Example' }, title: 'Mayor Velmo-Example', type: 'person', body: '' },
      { source: 'default', slug: 'people/ines-drask-example', frontmatter: {}, title: 'Ines Drask-Example', type: 'person', body: '' },
      { source: 'default', slug: 'people/otto-drask-example', frontmatter: {}, title: 'Otto Drask-Example', type: 'person', body: '' },
    ];
    expect(resolveVariant('Mayor Velmo-Example', pages)).toEqual({ kind: 'one', key: 'default:people/katherine-velmo-example', rule: 'surname' });
    expect(resolveVariant('Kate Velmo-Example', pages)).toEqual({ kind: 'one', key: 'default:people/katherine-velmo-example', rule: 'diminutive' });
    expect(resolveVariant('Velmo-Example Katherine', pages)).toMatchObject({ kind: 'one', rule: 'reversed' });
    expect(resolveVariant('Drask-Example', pages)).toEqual({ kind: 'refuse', candidates: ['default:people/ines-drask-example', 'default:people/otto-drask-example'] });
  });
});

describe('agent-retrieval-shapes scorer (hand-built gold)', () => {
  const T = 'default:concepts/t', S = 'default:concepts/t-old', X = 'default:notes/x';

  test('rank: first-place target passes; a stub above it, a miss or an error fails', () => {
    const g: ArsGold = { kind: 'rank', target: T, need: 'above', not_above: [S] };
    expect(scoreProbe(g, obs({ rows: rows(X, T, S) })).pass).toBe(true);
    expect(scoreProbe(g, obs({ rows: rows(S, T) })).pass).toBe(false);
    expect(scoreProbe(g, obs({ rows: rows(X) })).pass).toBe(false);
    expect(scoreProbe(g, obs({ rows: rows(T), error: 'boom' })).pass).toBe(false);
    expect(scoreProbe({ kind: 'rank', target: T, need: 'first' }, obs({ rows: rows(X, T) })).pass).toBe(false);
  });

  test('rank: a document family over its share of the top 5 fails even when the answer is first', () => {
    const fam = ['default:media/a', 'default:media/b', 'default:media/c'];
    const g: ArsGold = { kind: 'rank', target: T, need: 'first', family_pages: fam, family_max_top5: 1 };
    expect(scoreProbe(g, obs({ rows: rows(T, fam[0], X) })).pass).toBe(true);
    expect(scoreProbe(g, obs({ rows: rows(T, fam[0], fam[1]) })).pass).toBe(false);
  });

  test('twin: one slug in two sources inside the top 10 fails although rank 1 is right', () => {
    const g: ArsGold = { kind: 'twin', slug: 'concepts/t', keys: ['source-a:concepts/t', 'source-b:concepts/t'] };
    expect(scoreProbe(g, obs({ rows: rows('source-a:concepts/t', 'source-a:notes/x') })).pass).toBe(true);
    const dup = scoreProbe(g, obs({ rows: rows('source-a:concepts/t', 'source-b:concepts/t') }));
    expect(dup.pass).toBe(false);
    expect(dup.detail).toMatchObject({ hit1: true, duplicated_slugs: ['concepts/t'] });
  });

  test('entity: the right page passes, a wrong page fails; a refusal that suggests an index page fails (negative)', () => {
    const P = 'default:people/a', W = 'default:people/b', I = 'default:indexes/people-index';
    expect(scoreProbe({ kind: 'resolve', key: P, forbidden_suggestions: [I] }, obs({ entity: entity(true, P) })).pass).toBe(true);
    expect(scoreProbe({ kind: 'resolve', key: P, forbidden_suggestions: [I] }, obs({ entity: entity(true, W) })).detail.wrong).toBe(true);
    expect(scoreProbe({ kind: 'refuse', candidates: [P, W], forbidden_suggestions: [I] }, obs({ entity: entity(false, null) })).pass).toBe(true);
    expect(scoreProbe({ kind: 'refuse', candidates: [P, W], forbidden_suggestions: [I] }, obs({ entity: entity(false, null, [I]) })).pass).toBe(false);
    expect(scoreProbe({ kind: 'refuse', candidates: [P, W], forbidden_suggestions: [I] }, obs({ entity: entity(true, P) })).pass).toBe(false);
  });

  test('mentions: naming a mention page passes; a bare miss fails; a nowhere-name that names anything fails', () => {
    const D = 'default:daily/2026-07-01';
    expect(scoreProbe({ kind: 'mentions', keys: [D] }, obs({ entity: entity(false, null, [D], [D]) })).pass).toBe(true);
    expect(scoreProbe({ kind: 'mentions', keys: [D] }, obs({ entity: entity(false, null) })).pass).toBe(false);
    expect(scoreProbe({ kind: 'no-mentions' }, obs({ entity: entity(false, null, [D], [D]) })).pass).toBe(false);
  });

  test('chunk cap, notice scope, empty filter and score monotonicity', () => {
    const M = 'default:meetings/m';
    expect(scoreProbe({ kind: 'chunk-cap', cap: ARS_CHUNK_CAP_CHARS, page: M }, obs({ rows: [row(M, 1, 5000)] })).pass).toBe(true);
    expect(scoreProbe({ kind: 'chunk-cap', cap: ARS_CHUNK_CAP_CHARS, page: M }, obs({ rows: [row(M, 1, 59000)] })).pass).toBe(false);
    expect(scoreProbe({ kind: 'no-stage', stage: 'projection_pending' }, obs({ stages: ['projection_pending'] })).pass).toBe(false);
    expect(scoreProbe({ kind: 'empty' }, obs({ rows: rows(X) })).pass).toBe(false);
    expect(scoreMonotonic([row(T, 0.9), row(X, 0.95)])).toEqual({ ok: false, at: 1 });
    expect(scoreMonotonic([row(T, 0.9), row(X, 0.9)]).ok).toBe(true);
  });

  test('parseFamilies accepts E1 to E15 and rejects anything else', () => {
    expect(parseFamilies('e2, E10')).toEqual(['E2', 'E10']);
    expect(() => parseFamilies('E16')).toThrow(/unknown E16/);
  });
});

describe('agent-retrieval-shapes scorer mutation suite', () => {
  test('the honest system passes; empty, always-positive, always-refuse, stale and wrong-source fakes fail', () => {
    const w = generateArsWorld();
    const allKeys = [...new Set(w.ledger.pages.map(p => pageKey(p.source, p.slug)))].sort();
    const forbidden = w.ledger.pages.filter(p => p.frontmatter.type === 'index' || p.frontmatter.type === 'digest').map(p => pageKey(p.source, p.slug));
    type Item = { probe: ArsProbe; surface: ArsSurface; gold: ArsGold; wrong: string | null };
    const targetOf = (g: ArsGold) => (g.kind === 'rank' || g.kind === 'known-item' ? g.target : g.kind === 'resolve' ? g.key : null);
    const items: Item[] = w.ledger.probes.flatMap(probe => probe.surfaces.map(surface => {
      const gold = w.gold.get(probe.id)!;
      const sibling = w.ledger.probes.find(o => o.family === probe.family && o.id !== probe.id && targetOf(w.gold.get(o.id)!) !== null && targetOf(w.gold.get(o.id)!) !== targetOf(gold));
      return { probe, surface, gold, wrong: sibling ? targetOf(w.gold.get(sibling.id)!) : null };
    }));
    const truth = ({ gold }: Item): ArsObservation => {
      switch (gold.kind) {
        case 'rank': case 'known-item': return obs({ rows: rows(gold.target) });
        case 'twin': return obs({ rows: rows(gold.keys[0]) });
        case 'resolve': return obs({ entity: entity(true, gold.key, [], [gold.key]) });
        case 'refuse': case 'no-mentions': return obs({ entity: entity(false, null) });
        case 'mentions': return obs({ entity: entity(false, null, gold.keys.slice(0, 3), gold.keys.slice(0, 3)) });
        case 'chunk-cap': return obs({ rows: [row(gold.page, 1, 1000)] });
        case 'no-stage': case 'empty': return obs({});
      }
    };
    const results = assertScorerRejectsFakeSystems<Item, ArsObservation>({
      category: 'agent-retrieval-shapes',
      probes: items,
      space: {
        truth,
        empty: () => obs({}),
        everything: () => obs({ rows: allKeys.map((k, i) => row(k, 1 - i / 10000, 70000)), entity: entity(true, allKeys[0], forbidden, allKeys), stages: ['projection_pending'] }),
        refusal: () => obs({ error: 'refused' }),
        stale: ({ probe, gold }) => gold.kind === 'rank' && gold.not_above?.length ? obs({ rows: rows(gold.not_above[0], gold.target) })
          : probe.family === 'E7' && gold.kind === 'resolve' ? obs({ entity: entity(true, pageKey('default', String(probe.design.stub))) }) : undefined,
        wrongSource: ({ gold, wrong }) => gold.kind === 'twin'
          ? obs({ rows: rows(gold.keys[0], gold.keys[0].startsWith('source-a') ? gold.keys[0].replace('source-a', 'source-b') : gold.keys[0].replace('source-b', 'source-a')) })
          : wrong && (gold.kind === 'rank' || gold.kind === 'known-item') ? obs({ rows: rows(wrong) })
            : wrong && gold.kind === 'resolve' ? obs({ entity: entity(true, wrong) }) : undefined,
      },
      score: answers => {
        const map = new Map(items.map((it, i) => [`${it.probe.id}@${it.surface}`, answers[i]!]));
        const s = scoreObservations(w.ledger.probes, id => w.gold.get(id)!, map);
        return { pass: s.verdict === 'pass', detail: s.families.filter(f => Object.values(f.headline).some(t => t!.passed < t!.total) || f.negatives.passed < f.negatives.total).map(f => f.family).join(',') || 'all pass' };
      },
    });
    expect(results.find(r => r.system === 'honest')?.pass).toBe(true);
  });
});

describe('agent-retrieval-shapes against deliberately broken adapters', () => {
  const gut = resolveGbrainUnderTest(null);
  // gbrain v0.60.332.0 (4c208b03a) folds a merge stub into its target's row
  // (listed in `collapsed`), so this adapter unfolds those rows before it
  // reverses the list; otherwise a one-row list reverses to itself.
  type CollapsedRow = { slug: string; source_id: string; collapsed?: Array<{ slug: string; source_id: string }> };
  const reversed: OpWrapper = async (name, params, call) => {
    const r = await call(name, params);
    if ((name !== 'search' && name !== 'query') || !Array.isArray(r)) return r;
    const unfolded = (r as CollapsedRow[]).flatMap(row => [{ ...row, collapsed: undefined }, ...(row.collapsed ?? []).map(c => ({ ...row, slug: c.slug, source_id: c.source_id, collapsed: undefined }))]);
    return unfolded.reverse();
  };
  const blind: OpWrapper = async (name, params, call) => (name === 'search' || name === 'query' ? [] : name === 'entity' ? { found: false, suggestions: [] } : call(name, params));

  const offByOne: OpWrapper = async (name, params, call) => {
    const r = await call(name, params);
    return (name === 'search' || name === 'query') && Array.isArray(r) ? r.slice(1) : r;
  };

  test('an adapter that reverses every result list puts the renamed stub above its target (E2)', async () => {
    const r = await runAgentRetrievalShapes({ gut, families: ['E2'], wrapOp: reversed });
    expect(r.harnessError).toBeNull();
    expect(r.verdict).toBe('fail');
    expect(r.families![0].variants['renamed-stub'].search).toEqual({ passed: 0, total: 5 });
  }, 180_000);

  test('an adapter that drops the top row fails every identifier lookup (E10)', async () => {
    const r = await runAgentRetrievalShapes({ gut, families: ['E10'], wrapOp: offByOne });
    expect(r.harnessError).toBeNull();
    expect(r.families![0].headline).toEqual({ search: { passed: 0, total: 9 }, query: { passed: 0, total: 9 } });
  }, 180_000);

  test('an adapter that returns nothing fails every ranking and entity family instead of passing', async () => {
    const r = await runAgentRetrievalShapes({ gut, families: ['E7', 'E10'], wrapOp: blind });
    expect(r.harnessError).toBeNull();
    expect(r.verdict).toBe('fail');
    for (const f of r.families!) for (const t of Object.values(f.headline)) expect([f.family, t!.passed]).toEqual([f.family, 0]);
  }, 180_000);

  test('an adapter whose search throws is scored as misses, not as a harness error', async () => {
    const throwing: OpWrapper = async (name, params, call) => { if (name === 'search') throw new Error('broken search'); return call(name, params); };
    const r = await runAgentRetrievalShapes({ gut, families: ['E10'], wrapOp: throwing });
    expect(r.harnessError).toBeNull();
    expect(r.families!.find(f => f.family === 'E10')!.headline.search).toEqual({ passed: 0, total: 9 });
    expect(r.acc.summary().errors.filter(e => e.origin === 'sut')).toHaveLength(9);
  }, 180_000);

  test('the registry row is report-only, hermetic and free', () => {
    const e = registryEntry('agent-retrieval-shapes')!;
    expect(e.legacy_alias).toBe('ARS');
    expect([e.tier, e.gate, e.cost_estimate.usd, e.evidence_maturity]).toEqual(['H', 'report-only', 0, 'synthetic-production-path']);
    expect(e.promotion?.safety_contracts).toEqual([]);
    expect(e.promotion?.quality_thresholds).toEqual([]);
  });
});
