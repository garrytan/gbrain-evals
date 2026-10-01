/**
 * N1 knowledge update: generator determinism, the fence and ontology
 * oracles on hand-built cases, the scorer (including negatives that must
 * fail), the scorer mutation suite graded by the preregistered promotion
 * rules, and a deliberately broken adapter (an in-memory gbrain that ignores
 * struck rows) that the category must fail.
 */
import { describe, expect, test } from 'bun:test';
import { registryEntry } from '../../eval/registry.ts';
import { evaluatePromotion } from '../../eval/runner/promotion.ts';
import { assertScorerRejectsFakeSystems, type AnswerSpace } from '../../eval/runner/mutation-kit.ts';
import {
  N1_DEFAULT_SEED, fenceRowsAt, generateN1World, n1ExposureProbes, n1Probes, ontologyValueAt, privateTokens, renderFence,
  type N1Ledger, type N1Probe, type OntologyObservation,
} from '../../eval/generators/n1-knowledge-update-gen.ts';
import { n1Metrics, scoreExposure, scoreN1Probe, searchRowTokens, recallTokens, type N1Answer } from '../../eval/runner/lifecycle/n1-score.ts';
import { observeN1, scoreCheckpoint, writePlan } from '../../eval/runner/n1-knowledge-update.ts';
import type { CallResult, Driver } from '../../eval/runner/lifecycle/drivers.ts';

const world = generateN1World({ seed: N1_DEFAULT_SEED });
const { ledger } = world;

describe('N1 generator', () => {
  test('same seed, same ledger hash; another seed differs', () => {
    expect(generateN1World({ seed: N1_DEFAULT_SEED }).fingerprint).toBe(world.fingerprint);
    expect(generateN1World({ seed: N1_DEFAULT_SEED + 1 }).fingerprint).not.toBe(world.fingerprint);
  });

  test('depths 1 to 4 three times each over the fence chains, with three reverts and two private chains', () => {
    const depths = ledger.fence.map(c => c.depth).sort();
    expect(depths).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]);
    expect(ledger.fence.filter(c => c.kind === 'revert').map(c => c.depth).sort()).toEqual([2, 3, 4]);
    expect(ledger.fence.filter(c => c.visibility === 'private')).toHaveLength(2);
    for (const c of ledger.fence.filter(x => x.kind === 'revert')) expect(c.values.at(-1)!.token).toBe(c.values[c.depth - 2].token);
  });

  test('fence rows strike the previous value with "superseded by #N" and keep one active row per chain', () => {
    for (const e of ledger.entities) {
      const rows = fenceRowsAt(ledger, e.slug, 'C');
      for (const [i, r] of rows.entries()) expect(r.row).toBe(i + 1);
      for (const r of rows.filter(x => !x.active)) expect(r.context).toMatch(/^superseded by #\d+$/);
      const fenceChains = ledger.fence.filter(c => c.entity === e.slug);
      for (const c of fenceChains) expect(rows.filter(r => r.chain === c.id && r.active)).toHaveLength(1);
    }
    const fence = renderFence(fenceRowsAt(ledger, ledger.entities[0].slug, 4));
    expect(fence).toContain('<!--- gbrain:facts:begin -->');
    expect(fence).toMatch(/~~[^|]+~~ \| fact/);
  });

  test('every private token stays out of world chains', () => {
    const secret = new Set(privateTokens(ledger));
    for (const c of ledger.fence.filter(x => x.visibility === 'world')) for (const v of c.values) expect(secret.has(v.token)).toBe(false);
    expect(n1ExposureProbes(ledger, 'sequential')).toHaveLength(4);
    // The chunker strips private fence rows for every caller, so no search probe targets a private chain.
    expect(n1Probes(ledger, 'sequential').filter(p => p.private && p.type === 'fence_current' && p.surface === 'search')).toEqual([]);
  });

  test('write plan: round 0 writes every entity and every ontology chain; later rounds only what changed', () => {
    expect(writePlan(ledger, 0).filter(i => i.op === 'put_page')).toHaveLength(ledger.entities.length);
    expect(writePlan(ledger, 0).filter(i => i.op === 'ontology_propose')).toHaveLength(ledger.ontology.length);
    const r4 = writePlan(ledger, 4).flatMap(i => i.chains);
    expect(r4.every(id => [...ledger.fence, ...ledger.trajectory, ...ledger.ontology].find(c => c.id === id)!.depth >= 4)).toBe(true);
  });
});

describe('N1 ontology oracle (valid time, N3 semantics)', () => {
  const o = (value: string, valid_from: string): OntologyObservation => ({ value, token: value, valid_from, source: 'manual' });
  test('a revert returns to the earlier value; a backdated value wins only inside its window', () => {
    const revert = [o('A', '2020-01-01'), o('B', '2022-01-01'), o('A', '2024-01-01')];
    expect(ontologyValueAt(revert, null)).toBe('A');
    expect(ontologyValueAt(revert, '2023-01-01')).toBe('B');
    expect(ontologyValueAt(revert, '2019-01-01')).toBeNull();
    const backdated = [o('v0', '2020-01-01'), o('v1', '2023-01-01'), o('v2', '2021-06-01')];
    expect(ontologyValueAt(backdated, null)).toBe('v1');
    expect(ontologyValueAt(backdated, '2022-01-01')).toBe('v2');
    expect(ontologyValueAt(backdated, '2020-06-01')).toBe('v0');
  });
});

describe('N1 scorer', () => {
  const probes = n1Probes(ledger, 'sequential');
  const fc = probes.find(p => p.type === 'fence_current' && p.surface === 'recall' && p.depth >= 2 && !p.private) as Extract<N1Probe, { type: 'fence_current' }>;

  test('the current value alone passes; a stale value is flagged; current plus stale fails', () => {
    expect(scoreN1Probe(fc, { tokens: [fc.gold!] })).toMatchObject({ pass: true, stale: false });
    expect(scoreN1Probe(fc, { tokens: [fc.stale[0]] })).toMatchObject({ pass: false, stale: true });
    expect(scoreN1Probe(fc, { tokens: [fc.gold!, fc.stale[0]] })).toMatchObject({ pass: false, stale: true });
    expect(scoreN1Probe(fc, { error: 'boom' })).toMatchObject({ pass: false, error: 'boom' });
  });

  test('negative control: the ghost key passes only when nothing is served', () => {
    const ghost = probes.find(p => p.chain === 'ghost')!;
    expect(scoreN1Probe(ghost, { tokens: [] }).pass).toBe(true);
    expect(scoreN1Probe(ghost, { tokens: ['cnryaaaaaaaa'] }).pass).toBe(false);
  });

  test('search: a struck row is history, an unstruck old value is stale', () => {
    const key = fc.key;
    const chunk = `| 1 | ~~Home city is X ${key} ${fc.stale[0]}~~ | fact |\n| 2 | Home city is Y ${key} ${fc.gold} | fact |`;
    const rows = searchRowTokens([chunk], key);
    expect(rows).toEqual({ unstruck: [fc.gold!], struck: [fc.stale[0]] });
    const sp = probes.find(p => p.type === 'fence_current' && p.surface === 'search' && p.chain === fc.chain)!;
    expect(scoreN1Probe(sp, rows)).toMatchObject({ pass: true, stale: false });
    expect(scoreN1Probe(sp, searchRowTokens([chunk.replace('~~', '').replace('~~', '')], key))).toMatchObject({ pass: false, stale: true });
  });

  test('exposure: a leak is a private token in a remote response; signal needs the trusted control and the world twin', () => {
    const traj = n1ExposureProbes(ledger, 'sequential').find(p => p.surface === 'find_trajectory')!;
    expect(traj.twin_metric).toBe('mrr');
    const clean = scoreExposure(traj, '{"points":[]}', `{"points":[{"text":"${traj.private_tokens[0]}"}]}`, `{"points":[{"text":"${traj.twin_token}"}]}`);
    expect(clean).toMatchObject({ leak: false, control_trusted: true, control_twin: true, signal: true });
    expect(scoreExposure(traj, traj.private_tokens[0], null).leak).toBe(true);
    expect(scoreExposure(traj, '{}', '{}', '{}').signal).toBe(false);
  });

  test('recall token extraction keeps active and expired apart', () => {
    const facts = [{ fact: `Works at A ${fc.key} cnryaaaaaaaa`, expired_at: '2021-01-01' }, { fact: `Works at B ${fc.key} cnrybbbbbbbb`, expired_at: null }, { fact: 'other cnrycccccccc', expired_at: null }];
    expect(recallTokens(facts, fc.key, 'active')).toEqual(['cnrybbbbbbbb']);
    expect(recallTokens(facts, fc.key, 'expired')).toEqual(['cnryaaaaaaaa']);
  });
});

// ─── Mutation suite, graded by the preregistered promotion rules ──────────

function goldAnswer(p: N1Probe): N1Answer {
  switch (p.type) {
    case 'fence_current': return p.surface === 'recall' ? { tokens: p.gold ? [p.gold] : [] } : { unstruck: p.gold ? [p.gold] : [], struck: p.stale };
    case 'fence_history': return { expired: p.gold };
    case 'ontology_current': return { value: p.gold };
    case 'ontology_asof': return { value: p.gold };
    case 'trajectory_current': return { latest: p.gold };
    case 'trajectory_history': return { points: p.gold };
  }
}

const promotionPasses = (answers: readonly N1Answer[], probes: readonly N1Probe[]) => {
  const rows = probes.map((p, i) => scoreN1Probe(p, answers[i]));
  const metrics = n1Metrics(rows, { private_value_leaks: 0, exposure: [], acknowledged_writes_lost: 0 });
  const outcome = evaluatePromotion(registryEntry('N1')!.promotion!, { data: { metrics } });
  return { pass: outcome.pass, detail: outcome.failures.map(f => f.id).join(',') || 'all rules hold' };
};

describe('N1 scorer rejects the fake systems (graded by the preregistered rules)', () => {
  const probes = n1Probes(ledger, 'sequential').filter(p => !p.private);
  const others = (p: N1Probe) => probes.find(q => q.type === p.type && q.chain !== p.chain && q.chain !== 'ghost' && JSON.stringify(goldAnswer(q)) !== JSON.stringify(goldAnswer(p)));
  const space: AnswerSpace<N1Probe, N1Answer> = {
    truth: goldAnswer,
    empty: p => p.type === 'fence_current' ? (p.surface === 'recall' ? { tokens: [] } : { unstruck: [], struck: [] }) : p.type === 'fence_history' ? { expired: [] } : p.type.startsWith('ontology') ? { value: null } : p.type === 'trajectory_current' ? { latest: null } : { points: [] },
    everything: p => {
      if (p.type === 'fence_current') return p.surface === 'recall' ? { tokens: [...p.all, 'cnryzzzzzzzz'] } : { unstruck: [...p.all, 'cnryzzzzzzzz'], struck: [] };
      if (p.type === 'fence_history') return { expired: [...p.gold, ...p.gold] };
      if (p.type === 'ontology_current' || p.type === 'ontology_asof') return { value: p.all.join(' | ') || 'everything' };
      if (p.type === 'trajectory_current') return { latest: -1 };
      return { points: [...p.gold, ...p.superseded, ['1999-01', 1]] };
    },
    refusal: () => ({ error: 'refused' }),
    stale: p => {
      if (p.type === 'fence_current' && p.stale.length) return p.surface === 'recall' ? { tokens: [p.stale.at(-1)!] } : { unstruck: [p.stale.at(-1)!], struck: [] };
      if (p.type === 'fence_history' && p.gold.length) return { expired: [] };
      if (p.type === 'ontology_current' && p.stale.length) return { value: p.stale.at(-1)! };
      if (p.type === 'trajectory_current' && p.stale.length) return { latest: p.stale.at(-1)! };
      if (p.type === 'trajectory_history' && p.superseded.length) return { points: p.superseded };
      return undefined;
    },
    wrongSource: p => { const q = others(p); return q ? goldAnswer(q) : undefined; },
  };

  test('honest passes; empty, always-positive, always-refuse, stale and wrong-source fail', () => {
    const results = assertScorerRejectsFakeSystems({ category: 'N1', probes, space, score: answers => promotionPasses(answers, probes) });
    expect(results.filter(r => r.pass).map(r => r.system)).toEqual(['honest']);
  });
});

// ─── A deliberately broken adapter ────────────────────────────────────────

/** An in-memory gbrain over the ledger: honest serves the fence as written; broken ignores strikes. */
function fakeDriver(l: N1Ledger, broken: boolean): Driver {
  const round = 'C' as const;
  const call = async (op: string, args: Record<string, unknown>): Promise<CallResult> => {
    const ok = (data: unknown): CallResult => ({ ok: true, data, raw: JSON.stringify(data), ms: 0 });
    if (op === 'recall') {
      const rows = fenceRowsAt(l, String(args.entity), round);
      const facts = rows.map(r => ({ fact: r.claim, expired_at: r.active || broken ? null : r.valid_until }));
      return ok({ facts: args.include_expired ? facts : facts.filter(f => f.expired_at === null) });
    }
    if (op === 'search') {
      const e = l.entities.find(x => fenceRowsAt(l, x.slug, round).some(r => r.claim.includes(String(args.query))));
      return ok(e ? [{ slug: e.slug, chunk_text: renderFence(fenceRowsAt(l, e.slug, round).map(r => broken ? { ...r, active: true } : r)) }] : []);
    }
    if (op === 'ontology_get') {
      const asof = typeof args.asof === 'string' ? args.asof : null;
      return ok(l.ontology.filter(c => c.entity === args.entity).map(c => {
        const obs = [...c.observations, c.concurrent];
        return { dimension: c.dimension, value: broken ? obs[0].value : ontologyValueAt(obs, asof) };
      }).filter(r => r.value !== null));
    }
    if (op === 'find_trajectory') {
      const c = l.trajectory.find(x => x.entity === args.entity_slug && x.metric === args.metric);
      if (!c) return ok({ points: [] });
      const rows = fenceRowsAt(l, c.entity, round).filter(r => r.chain === c.id && (r.active || broken)).sort((a, b) => a.valid_from.localeCompare(b.valid_from));
      return ok({ points: rows.map(r => ({ valid_from: r.valid_from, value: r.metric!.value })) });
    }
    return { ok: false, data: null, error: `unknown op ${op}`, raw: '', ms: 0 };
  };
  return { kind: 'cli', remote: false, start: async () => {}, restart: async () => {}, close: async () => {}, sessions: () => 0, call };
}

describe('N1 broken adapter', () => {
  const probes = n1Probes(ledger, 'concurrent');
  const exposure = n1ExposureProbes(ledger, 'concurrent');
  const grade = async (d: Driver) => {
    const obs = await observeN1(d, ledger, probes);
    const { rows } = scoreCheckpoint(probes, exposure, obs, null, false);
    return { rows, ...promotionPasses(rows.map(r => r.answer as N1Answer), probes.filter(p => rows.some(r => r.probe_id === p.id))) };
  };

  test('an honest in-memory adapter passes every rule', async () => {
    const g = await grade(fakeDriver(ledger, false));
    expect(g.rows.filter(r => !r.pass).map(r => r.probe_id)).toEqual([]);
    expect(g.pass).toBe(true);
  });

  test('an adapter that ignores strikes and supersession fails the stale-served contract', async () => {
    const g = await grade(fakeDriver(ledger, true));
    expect(g.pass).toBe(false);
    expect(g.rows.some(r => r.stale)).toBe(true);
    expect(g.detail).toContain('no-stale-served');
  });
});
