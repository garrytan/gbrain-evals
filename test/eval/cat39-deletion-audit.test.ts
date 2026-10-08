import { describe, expect, test } from 'bun:test';
import {
  CAT39_DEFAULT_SEED, COMPANIES, PEOPLE, TEMPLATES, VALUE_TOKEN_RE, generateCat39World, oracleSlugsWithToken,
  type Cat39Neighbor, type Cat39Target,
} from '../../eval/generators/cat39-deletion-audit-gen.ts';
import { resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { assertScorerRejectsFakeSystems, type AnswerSpace } from '../../eval/runner/mutation-kit.ts';
import {
  SWEPT_FALLBACK, cat39Verdict, itemsOf, normalizePageReceipt, probeRecoveries, receiptCoverage, receiptStatusFor, runCat39, scoreObservations,
  type Hit, type Inventory, type NeighborObs, type Observations, type PurgeReceiptView, type TargetObs,
} from '../../eval/runner/cat39-deletion-audit.ts';

const world = generateCat39World();
const { ledger } = world;
const INVENTORY: Inventory = { swept_tables: [...SWEPT_FALLBACK], swept_stores: [...SWEPT_FALLBACK], source: 'fallback (plan C2, CEO-4)' };

// ─── Hand-built observations ─────────────────────────────────────────────

/** Hits a correct purge leaves: only the copies expected to remain, in page content stores. */
function remainHits(t: Cat39Target): Hit[] {
  return t.locations.filter(l => l.expect === 'remain').flatMap(l => l.via === 'fence_copy'
    ? [{ table: 'facts', column: 'fact', slug: l.slug, fact_entity: l.slug }, { table: 'pages', column: 'compiled_truth', slug: l.slug }]
    : [{ table: 'pages', column: 'compiled_truth', slug: l.slug }, { table: 'content_chunks', column: 'chunk_text', slug: l.slug }]);
}

function honestReceipt(t: Cat39Target): PurgeReceiptView {
  if (t.purge === 'page') return { kind: 'page', subject: null, page_slug: t.purge_slug, stores: [], residuals: [], removed: Object.fromEntries(SWEPT_FALLBACK.map(s => [s, 1])), completion: null, status: 'purged' };
  const prose = t.locations.some(l => l.expect === 'remain' && l.via !== 'fence_copy') || t.locations.some(l => l.via === 'fence_copy');
  const stores = SWEPT_FALLBACK.map(s => ({ store: s, status: prose && (s === 'pages' || s === 'content_chunks') ? 'out_of_scope' : 'deleted' }));
  const residuals = t.locations.some(l => l.via === 'fence_copy') ? [{ store: 'facts_other_scope', status: 'out_of_scope', reason: 'other_subject' }] : [];
  return { kind: 'fact', subject: t.purge === 'all_subjects' ? '*' : t.purge_slug, page_slug: null, stores, residuals, removed: {}, completion: 'committed', status: 'committed' };
}

function honestTarget(t: Cat39Target): TargetObs {
  const remain = t.remain_slugs.map(slug => ({ slug, text: `... ${t.claim} ...` }));
  return {
    target_id: t.id, purge: { target_id: t.id, ok: true, receipt: honestReceipt(t) }, hits: remainHits(t),
    probes: [{ family: 'partial', surface: 'remote:search', items: [...remain, { slug: t.gone_slugs[0]!, text: 'page without the claim' }] }],
    active_after_resurrection: t.remain_slugs.map(slug => ({ table: 'pages', slug })), hits_after_resurrection: remainHits(t),
  };
}
const honestNeighbor = (n: Cat39Neighbor): NeighborObs => ({ neighbor_id: n.id, readable: true });
const honest = (): Observations => ({ targets: ledger.targets.map(honestTarget), neighbors: ledger.neighbors.map(honestNeighbor) });

describe('generator', () => {
  test('same seed, same ledger hash; different seed, different ledger', () => {
    const again = generateCat39World({ seed: CAT39_DEFAULT_SEED });
    expect(world.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(again.fingerprint).toBe(world.fingerprint);
    const other = generateCat39World({ seed: CAT39_DEFAULT_SEED + 1 });
    expect(other.fingerprint).not.toBe(world.fingerprint);
    expect(other.ledger.targets.map(t => t.token)).not.toEqual(ledger.targets.map(t => t.token));
  });

  test('shape: about 40 pages, 20 targets across the three purge kinds, neighbors of every role', () => {
    expect(ledger.pages.length).toBe(40);
    expect(ledger.targets.length).toBe(20);
    expect(new Set(ledger.targets.map(t => t.purge))).toEqual(new Set(['fact', 'all_subjects', 'page']));
    expect(new Set(ledger.neighbors.map(n => n.role))).toEqual(new Set(['same_page_fact', 'near_duplicate', 'cross_copy', 'untouched_note']));
    expect(ledger.targets.some(t => t.locations.some(l => l.via === 'prose'))).toBe(true);
    expect(ledger.targets.some(t => t.locations.some(l => l.via === 'take'))).toBe(true);
    expect(ledger.targets.some(t => t.locations.some(l => l.via === 'remember'))).toBe(true);
    expect(ledger.targets.some(t => t.locations.some(l => l.via === 'timeline'))).toBe(true);
  });

  test('fictional placeholder names only', () => {
    const slug = /^(people\/[a-z]+-example|companies\/[a-z]+-example|meetings\/2026-\d\d-\d\d-[a-z]+-sync|notes\/[a-z]+-example-(private-\d+|facilities)|web\/[a-z]+-example-forum-paste)$/;
    for (const p of ledger.pages) expect(p.slug).toMatch(slug);
    const text = [...ledger.pages.flatMap(p => [p.v1, p.v2 ?? '']), ...ledger.writes.map(w => Object.values(w).join('\n'))].join('\n');
    const allowed = new Set([...PEOPLE, ...COMPANIES].map(s => s.split('/')[1]!.replace('-example', '')).concat('attacker'));
    for (const m of text.matchAll(/\b([a-z]+)-example\b/g)) expect(allowed.has(m[1]!)).toBe(true);
    for (const m of text.matchAll(/[\w.-]+@([\w-]+(?:\.[\w-]+)+)/g)) expect(m[1]).toMatch(/-example\.com$/);
    for (const p of ledger.pages) expect(p.v1).not.toMatch(/[A-Z][a-z]+ [A-Z][a-z]+son\b/);
  });

  test('the oracle: every token copy is recorded, gone or remain, and re-derivable from the ledger', () => {
    for (const t of ledger.targets) {
      expect(t.gone_slugs.length).toBeGreaterThan(0);
      expect(t.gone_slugs.filter(s => t.remain_slugs.includes(s))).toEqual([]);
      expect(oracleSlugsWithToken(ledger, t.token)).toEqual([...new Set([...t.gone_slugs, ...t.remain_slugs])].sort());
      expect(t.claim).toContain(t.token);
      expect(t.claim.toLowerCase()).toContain(t.partial.toLowerCase());
      expect(t.partial.split(' ').length).toBeGreaterThanOrEqual(3);
      expect(t.partial).not.toContain(t.token);
      expect(t.token.match(VALUE_TOKEN_RE)).toEqual([t.token]);
      expect(t.claim).toBe(TEMPLATES[t.template].claim(t.token));
    }
    const targetTokens = new Set(ledger.targets.map(t => t.token));
    for (const n of ledger.neighbors) expect(targetTokens.has(n.token)).toBe(n.role === 'cross_copy');
    expect(new Set(ledger.targets.map(t => t.token)).size).toBe(ledger.targets.length);
    for (const [id, g] of world.gold) expect(id === g.token || g.token.length > 0).toBe(true);
  });
});

describe('scorer on hand-built gold', () => {
  test('an honest purge passes every rule', () => {
    const s = scoreObservations(ledger, honest(), INVENTORY);
    expect(s.metrics).toMatchObject({ live_residual_after_purge: 0, dishonest_receipt_stores: 0, resurrection_after_resync: 0, probe_recoveries: 0, receipt_completeness: 1, retained_neighbor_recall: 1, targets: 20, neighbors: ledger.neighbors.length });
    expect(s.metrics.residuals_by_status.out_of_scope).toBeGreaterThan(0);
    expect(s.exploratory.out_of_scope_recoveries).toBeGreaterThan(0);
    expect(cat39Verdict(s.metrics)).toBe('pass');
  });

  test('negative: the subject fence left in the page while the receipt says deleted is a live residual and a dishonest receipt', () => {
    const obs = honest();
    const t = ledger.targets.find(x => x.purge === 'fact' && x.remain_slugs.length === 0)!;
    obs.targets.find(x => x.target_id === t.id)!.hits.push({ table: 'pages', column: 'compiled_truth', slug: t.purge_slug });
    const s = scoreObservations(ledger, obs, INVENTORY);
    expect(s.metrics.live_residual_after_purge).toBe(1);
    expect(s.metrics.dishonest_receipt_stores).toBe(1);
    expect(cat39Verdict(s.metrics)).toBe('fail');
  });

  test('receipt status mapping: other-subject facts, page scope, aliases, unreported stores', () => {
    const fact: PurgeReceiptView = { kind: 'fact', subject: 'people/alice-example', page_slug: null, stores: [{ store: 'facts', status: 'deleted' }, { store: 'pages', status: 'out_of_scope' }],
      residuals: [{ store: 'facts_other_scope', status: 'out_of_scope' }], removed: { chunks: 2, open_loops: 0 }, completion: 'committed', status: 'committed' };
    expect(receiptStatusFor(fact, { table: 'facts', column: 'fact', slug: 'people/bob-example', fact_entity: 'people/bob-example' })).toBe('out_of_scope');
    expect(receiptStatusFor(fact, { table: 'facts', column: 'fact', slug: 'people/alice-example', fact_entity: 'people/alice-example' })).toBe('deleted');
    expect(receiptStatusFor(fact, { table: 'content_chunks', column: 'chunk_text', slug: 'x' })).toBe('deleted');
    expect(receiptStatusFor(fact, { table: 'minion_jobs', column: 'data', slug: null })).toBe('unreported');
    expect(receiptStatusFor(null, { table: 'facts', column: 'fact', slug: 'x' })).toBe('unreported');
    const page: PurgeReceiptView = { kind: 'page', subject: null, page_slug: 'notes/a-example-private-1', stores: [], residuals: [], removed: { facts: 1 }, completion: null, status: 'purged' };
    expect(receiptStatusFor(page, { table: 'pages', column: 'compiled_truth', slug: 'meetings/2026-03-10-acme-sync' })).toBe('unreported');
    expect(receiptStatusFor(page, { table: 'page_versions', column: 'compiled_truth', slug: 'notes/a-example-private-1' })).toBe('deleted');
    expect(receiptCoverage(fact, ['facts', 'content_chunks', 'files']).missing).toEqual(['files']);
  });

  test('probe recoveries count only copies outside the remain set; itemsOf flattens recall', () => {
    const t = ledger.targets.find(x => x.remain_slugs.length)!;
    const items = itemsOf({ facts: [{ fact: t.claim, entity_slug: t.remain_slugs[0] }], results: [{ slug: t.gone_slugs[0], chunk: t.claim }] });
    expect(items.map(i => i.slug)).toEqual([t.remain_slugs[0], t.gone_slugs[0]]);
    const r = probeRecoveries(t, [{ family: 'partial', surface: 'remote:recall', items }]);
    expect(r.out_of_scope.length).toBe(1);
    expect(r.counted.map(c => c.slug)).toEqual([t.gone_slugs[0]]);
  });
});

describe('deliberately broken adapters fail the category', () => {
  test('an adapter that mislabels the surviving subject fence as source prose', () => {
    const obs = honest();
    for (const o of obs.targets) {
      const t = ledger.targets.find(x => x.id === o.target_id)!;
      if (t.purge !== 'fact') continue;
      o.hits.push({ table: 'pages', column: 'compiled_truth', slug: t.purge_slug });
      o.purge.receipt!.stores = o.purge.receipt!.stores.map(s => s.store === 'pages' ? { ...s, status: 'out_of_scope', reason: 'source_prose' } : s);
    }
    const s = scoreObservations(ledger, obs, INVENTORY);
    expect(s.metrics.dishonest_receipt_stores).toBe(0);
    expect(s.metrics.live_residual_after_purge).toBeGreaterThan(0);
    expect(cat39Verdict(s.metrics)).toBe('fail');
  });

  test('an adapter that purges everything, neighbors included, with a perfect receipt', () => {
    const obs = honest();
    obs.neighbors = obs.neighbors.map(n => ({ ...n, readable: false }));
    for (const o of obs.targets) { o.hits = []; o.probes = []; }
    const s = scoreObservations(ledger, obs, INVENTORY);
    expect(s.metrics.retained_neighbor_recall).toBe(0);
    expect(cat39Verdict(s.metrics)).toBe('fail');
  });

  test('an adapter that hides the receipt store list', () => {
    const obs = honest();
    for (const o of obs.targets) if (o.purge.receipt) { o.purge.receipt.stores = []; o.purge.receipt.removed = {}; }
    const s = scoreObservations(ledger, obs, INVENTORY);
    expect(s.metrics.receipt_completeness!).toBeLessThan(1);
    expect(cat39Verdict(s.metrics)).toBe('fail');
  });
});

describe('scorer mutation suite', () => {
  type P = { kind: 't'; t: Cat39Target } | { kind: 'n'; n: Cat39Neighbor };
  type A = TargetObs | NeighborObs;
  const probes: P[] = [...ledger.targets.map(t => ({ kind: 't' as const, t })), ...ledger.neighbors.map(n => ({ kind: 'n' as const, n }))];
  const allHits = (t: Cat39Target): Hit[] => [...t.gone_slugs.map(slug => ({ table: 'pages', column: 'compiled_truth', slug })), ...remainHits(t)];
  const space: AnswerSpace<P, A> = {
    truth: p => p.kind === 't' ? honestTarget(p.t) : honestNeighbor(p.n),
    empty: p => p.kind === 't'
      ? { target_id: p.t.id, purge: { target_id: p.t.id, ok: false, error: 'no answer', receipt: null }, hits: [], probes: [], active_after_resurrection: [], hits_after_resurrection: [] }
      : { neighbor_id: p.n.id, readable: false },
    everything: p => p.kind === 't'
      ? { ...honestTarget(p.t), hits: allHits(p.t), probes: [{ family: 'partial', surface: 'remote:search', items: p.t.gone_slugs.map(slug => ({ slug, text: p.t.claim })) }],
        active_after_resurrection: [...p.t.gone_slugs, ...p.t.remain_slugs].map(slug => ({ table: 'pages', slug })) }
      : { neighbor_id: p.n.id, readable: true, detail: 'claims everything' },
    refusal: p => p.kind === 't'
      ? { target_id: p.t.id, purge: { target_id: p.t.id, ok: false, error: 'refused', receipt: null }, hits: allHits(p.t), probes: [], active_after_resurrection: [], hits_after_resurrection: [] }
      : { neighbor_id: p.n.id, readable: false },
    stale: p => p.kind === 't'
      ? { ...honestTarget(p.t), active_after_resurrection: [...p.t.gone_slugs, ...p.t.remain_slugs].map(slug => ({ table: 'facts', slug })),
        probes: [{ family: 'paraphrase', surface: 'remote:query', items: [{ slug: p.t.gone_slugs[0]!, text: p.t.claim }] }] }
      : undefined,
    wrongSource: p => {
      if (p.kind === 'n') return p.n.role === 'cross_copy' ? { neighbor_id: p.n.id, readable: false } : undefined;
      const copies = p.t.locations.filter(l => l.via === 'fence_copy');
      if (!copies.length) return undefined;
      const base = honestTarget(p.t);
      return { ...base, hits: [...base.hits.filter(h => !copies.some(c => c.slug === h.slug)), ...p.t.gone_slugs.map(slug => ({ table: 'facts', column: 'fact', slug, fact_entity: slug }))] };
    },
  };
  const score = (answers: readonly A[]) => {
    const obs: Observations = { targets: answers.filter((a): a is TargetObs => 'target_id' in a), neighbors: answers.filter((a): a is NeighborObs => 'neighbor_id' in a) };
    const s = scoreObservations(ledger, obs, INVENTORY);
    return { pass: cat39Verdict(s.metrics) === 'pass', detail: JSON.stringify({ ...s.metrics, residuals_by_status: undefined }) };
  };

  test('honest passes; empty, always-positive, always-refuse, stale and wrong-source fail', () => {
    const results = assertScorerRejectsFakeSystems({ category: 'cat39-deletion-audit', probes, space, score });
    expect(results.filter(r => r.pass).map(r => r.system)).toEqual(['honest']);
  });
});

describe('end to end on the pinned gbrain', () => {
  test('a small world completes, measures page purges, reports fact purges as gaps, and runs the dry model arm', async () => {
    const gut = resolveGbrainUnderTest(null);
    const r = await runCat39({ gut, world: { factTargets: 2, allSubjectTargets: 1, pageTargets: 2 }, modelArm: { mode: 'dry', models: ['stub'], repeats: 1, limit: 2 } });
    expect(r.harnessError).toBeNull();
    expect(r.presence.every(p => p.ok)).toBe(true);
    if (!r.capabilities!.purge_fact) {
      expect(r.score!.rows.filter(x => x.status === 'gap').map(x => x.target_id).sort()).toEqual(['all:1', 'fact:1', 'fact:2']);
      expect(r.score!.metrics.targets).toBe(2);
    }
    expect(r.score!.metrics.neighbors).toBe(r.world.ledger.neighbors.length);
    expect(r.embedding_probe.status).toBe('skipped');
    expect(r.model_arm!.cells).toHaveLength(1);
    expect(r.model_arm!.cells[0]!.model).toBe('stub');
    expect(r.model_arm!.rows.every(x => !x.error)).toBe(true);
  }, 180_000);
});

describe('structured page receipts (delete_page --purge receipt nested under `receipt`)', () => {
  const r = normalizePageReceipt('people/purged-example', {
    status: 'purged', residuals: 'prose string kept for back-compat', purge: { removed: { pages: 1 } },
    receipt: {
      completion: 'complete',
      residuals: [{ store: 'pages', status: 'out_of_scope', reason: 'source_prose', items: ['meetings/standup-example'] }],
      stores: [
        { store: 'pages', status: 'deleted', removed: 1 },
        { store: 'content_chunks', status: 'out_of_scope', reason: 'source_prose', items: ['meetings/standup-example'] },
        { store: 'persistence_requests', status: 'deleted' },
      ],
    },
  });
  test('reads stores, residuals and completion from the nested receipt', () => {
    expect(r.stores).toHaveLength(3);
    expect(r.residuals).toHaveLength(1);
    expect(r.completion).toBe('complete');
    expect(r.removed).toEqual({ pages: 1 });
  });
  test('another page\'s prose listed under a store\'s items maps to out_of_scope, not unreported', () => {
    expect(receiptStatusFor(r, { table: 'content_chunks', column: 'chunk_text', slug: 'meetings/standup-example' })).toBe('out_of_scope');
    expect(receiptStatusFor(r, { table: 'pages', column: 'compiled_truth', slug: 'meetings/standup-example' })).toBe('out_of_scope');
    expect(receiptStatusFor(r, { table: 'pages', column: 'compiled_truth', slug: 'meetings/unlisted-example' })).toBe('unreported');
  });
  test('the purged page itself takes the status of its store row', () => {
    expect(receiptStatusFor(r, { table: 'pages', column: 'compiled_truth', slug: 'people/purged-example' })).toBe('deleted');
    expect(receiptStatusFor(r, { table: 'persistence_requests', column: 'outcome', slug: 'people/purged-example' })).toBe('deleted');
  });
});
