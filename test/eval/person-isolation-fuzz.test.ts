import { describe, expect, test } from 'bun:test';
import { generatePersonWorld, canariesOf, PI_CHANNELS, PI_DEFAULT_SEED } from '../../eval/generators/person-isolation-gen.ts';
import {
  containsSlug, factIdsInText, mustRefuse, nearMisses, normalizeForOracle, outcomeOf, publicData, scan, writeIdsIn, callersFor,
  type Outcome,
} from '../../eval/runner/person-isolation-fuzz.ts';

const world = generatePersonWorld(PI_DEFAULT_SEED);

describe('person-isolation generator', () => {
  test('same seed gives the same ledger, another seed another', () => {
    expect(generatePersonWorld(PI_DEFAULT_SEED).ledger_hash).toBe(world.ledger_hash);
    expect(generatePersonWorld(PI_DEFAULT_SEED + 1).ledger_hash).not.toBe(world.ledger_hash);
  });

  test('every member holds one canary per channel, and no canary is shared or public', () => {
    const all = world.holdings.flatMap(h => PI_CHANNELS.map(ch => h.canaries[ch]));
    expect(new Set(all).size).toBe(all.length);
    for (const h of world.holdings) expect(Object.keys(h.canaries).sort()).toEqual([...PI_CHANNELS].sort());
    const publicText = [...world.pages.filter(p => p.protected_for === null).map(p => p.content), world.public_fact.fact, ...world.public_markers].join('\n');
    for (const c of all) expect(publicText.includes(c)).toBe(false);
    for (const m of world.public_markers) expect(all.includes(m)).toBe(false);
  });

  test('the world plants a prefix collision and an external id that only a case change separates', () => {
    const ids = world.members.map(m => m.id);
    expect(ids.some(a => ids.some(b => a !== b && b.startsWith(a)))).toBe(true);
    const collides = world.members.some(t => nearMisses(t, world).some(v => v.reads_as !== null && v.reads_as !== t.id));
    expect(collides).toBe(true);
  });

  test('the ghost member is a member who never writes a canary anyone else can read', () => {
    expect(world.members.map(m => m.id)).toContain(world.ghost_member);
    expect(canariesOf(world, 'nobody')).toEqual([]);
  });
});

describe('person-isolation callers', () => {
  const target = world.members.find(m => m.role === 'p1')!;
  test('HTTP drops the leading-space variant, because HTTP trims header whitespace; dispatch keeps it', () => {
    expect(nearMisses(target, world).map(v => v.label)).toContain('leading-space');
    expect(nearMisses(target, world, true).map(v => v.label)).not.toContain('leading-space');
    expect(callersFor(world, target, 0, 'http').map(c => c.label)).not.toContain('attested-variant:leading-space');
    expect(callersFor(world, target, 0, 'mcp-dispatch').map(c => c.label)).toContain('attested-variant:leading-space');
  });

  test('no probe caller is the target, and callers that act for nobody must be refused', () => {
    for (const t of ['mcp-dispatch', 'http', 'cli'] as const) for (const c of callersFor(world, target, 0, t)) expect(c.as).not.toBe(target.id);
    expect(mustRefuse({ kind: 'unbound', as: null, client: 'unbound', label: 'unbound' })).toBe(true);
    expect(mustRefuse({ kind: 'member-key', as: 'x', client: 'key:x', label: 'member-key' })).toBe(false);
  });
});

describe('person-isolation scanning', () => {
  const gold = { canaries: ['pizzzcanary'], slugs: ['memory/members/ann'], request_ids: ['req-1'], fact_ids: ['7'] };

  test('slugs match as whole tokens only', () => {
    expect(containsSlug('see memory/members/ann.', 'memory/members/ann')).toBe(true);
    expect(containsSlug('see memory/members/ann-lee', 'memory/members/ann')).toBe(false);
  });

  test('a canary or identifier the probe itself sent is not a leak', () => {
    expect(scan('x pizzzcanary y', gold, '{"query":"pizzzcanary"}').content).toEqual([]);
    expect(scan('x pizzzcanary y', gold, '{}').content).toEqual(['pizzzcanary']);
    expect(scan('memory/members/ann', gold, '{"slug":"memory/members/ann"}').identifier).toEqual([]);
  });

  test('fact ids count only in fact-shaped places', () => {
    expect([...factIdsInText('{"facts":[{"id":7}]}')]).toEqual(['7']);
    expect([...factIdsInText('{"policy_rev":{"team":7},"page_id":7}')]).toEqual([]);
    expect(scan('{"fact_id":7}', gold, '{}').identifier).toEqual(['fact_id']);
    expect(scan('{"fact_id":7}', gold, '{"id":7}').identifier).toEqual([]);
  });

  test('write receipts yield their fact ids and request id', () => {
    expect(writeIdsIn('{"status":"committed","fact_ids":[3,4],"request_id":"r-9"}')).toEqual({ fact_ids: ['3', '4'], request_id: 'r-9' });
  });

  test('outcomeOf keys on ok, status and error code', () => {
    const o = (x: Partial<Outcome>): Outcome => ({ exposed: true, ok: true, text: '', ...x });
    expect(outcomeOf(o({ text: '{"status":"committed"}' }))).toBe('ok|committed|-');
    expect(outcomeOf(o({ ok: false, error_code: 'permission_denied' }))).toBe('refused|-|permission_denied');
  });
});

describe('person-isolation oracle normalizer', () => {
  test('strips notices, masks volatile fields and masks target values as whole tokens', () => {
    const a = '[gbrain notice x] slow\n{"took_ms":12,"at":"2026-11-24T19:00:53.734Z","slug":"memory/members/ann","gbrain_notices":[{"code":"a"}],"n":1}';
    const b = '[gbrain notice y] other\n{"took_ms":99,"at":"2026-11-25T01:02:03.000Z","slug":"memory/members/hugo","gbrain_notices":[],"n":1}';
    expect(normalizeForOracle(a, ['memory/members/ann'])).toBe(normalizeForOracle(b, ['memory/members/hugo']));
    expect(normalizeForOracle('memory/members/ann-lee', ['memory/members/ann'])).toBe('memory/members/ann-lee');
  });

  test('decodes opaque base64 cursors so only their timestamps are masked', () => {
    const cur = (iso: string, slug: string) => Buffer.from(JSON.stringify({ v: 1, p: [iso, slug] })).toString('base64url');
    const x = normalizeForOracle('{"cursor":"' + cur('2026-11-24T19:00:53.734000Z', '') + '"}', []);
    expect(x).toBe(normalizeForOracle('{"cursor":"' + cur('2026-11-24T19:00:53.764000Z', '') + '"}', []));
    expect(x).not.toBe(normalizeForOracle('{"cursor":"' + cur('2026-11-24T19:00:53.764000Z', 'private/ann/plan') + '"}', []));
  });

  test('HTTP date headers do not separate two answers', () => {
    expect(normalizeForOracle('date: Tue, 24 Nov 2026 19:41:01 GMT\nx', [])).toBe(normalizeForOracle('date: Tue, 24 Nov 2026 19:41:02 GMT\nx', []));
  });
});

describe('person-isolation public receipt', () => {
  test('a failed run publishes only its verdict and total', () => {
    expect(publicData([], ['PI_LEAK'])).toEqual({ verdict: 'fail', gate_total: 0 });
  });
});
