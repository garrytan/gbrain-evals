/**
 * N5 forgetting residue: generator determinism and group invariants, the
 * scorer on hand-built observations (negatives must fail), the scorer
 * mutation suite graded by the preregistered promotion rules, and a
 * deliberately broken adapter (an in-memory gbrain whose forget is a no-op)
 * that the category must fail.
 */
import { describe, expect, test } from 'bun:test';
import { registryEntry } from '../../eval/registry.ts';
import { evaluatePromotion } from '../../eval/runner/promotion.ts';
import { assertScorerRejectsFakeSystems, type AnswerSpace } from '../../eval/runner/mutation-kit.ts';
import {
  ACTIVE_TIERS, CHECKPOINTS, N5_DEFAULT_SEED, generateN5World, isForgottenAt, privateTokens, renderInitialPage, writtenBy,
  type ActiveTier, type Canary, type N5Checkpoint, type N5Ledger,
} from '../../eval/generators/n5-forget-residue-gen.ts';
import { fenceRowTokens, pairKey, scoreN5, type CheckpointObs, type N5ScoreInput, type TierObs } from '../../eval/runner/lifecycle/n5-score.ts';
import { observeN5 } from '../../eval/runner/n5-forget-residue.ts';
import type { CallResult, Driver } from '../../eval/runner/lifecycle/drivers.ts';

const world = generateN5World({ seed: N5_DEFAULT_SEED });
const { ledger } = world;
const SURFACING: readonly ActiveTier[] = ['recall_facts', 'recall_query', 'search', 'query', 'context_pack', 'fence_active'];

describe('N5 generator', () => {
  test('same seed, same ledger hash; another seed differs', () => {
    expect(generateN5World({ seed: N5_DEFAULT_SEED }).fingerprint).toBe(world.fingerprint);
    expect(generateN5World({ seed: 99 }).fingerprint).not.toBe(world.fingerprint);
  });

  test('groups: hard-negative twins share text with a forgotten claim, every entity keeps a retained neighbor', () => {
    const forgotten = ledger.canaries.filter(c => c.role === 'forgotten');
    expect(forgotten.length).toBeGreaterThanOrEqual(6);
    for (const t of ledger.canaries.filter(c => c.twin_of)) {
      const src = ledger.canaries.find(c => c.id === t.twin_of)!;
      expect(src.role).toBe('forgotten');
      expect(t.claim).toBe(src.claim);
      expect(t.entity).not.toBe(src.entity);
    }
    for (const e of ledger.entities) expect(ledger.canaries.some(c => c.entity === e.slug && c.role === 'retained')).toBe(true);
    expect(ledger.canaries.filter(c => c.visibility === 'private').map(c => c.role).sort()).toEqual(['forgotten', 'retained']);
    expect(privateTokens(ledger)).toHaveLength(2);
    expect(ledger.canaries.filter(c => c.in_prose)).toHaveLength(1);
  });

  test('the initial page carries fence-authored canaries as unstruck rows and the prose canary in prose', () => {
    for (const e of ledger.entities) {
      const body = renderInitialPage(ledger, e);
      const rows = fenceRowTokens(body);
      for (const c of ledger.canaries.filter(x => x.entity === e.slug && x.via === 'fence')) expect(rows.unstruck.has(c.token)).toBe(true);
      expect(rows.struck.size).toBe(0);
    }
  });
});

// ─── Hand-built observations ──────────────────────────────────────────────

type Behavior = (c: Canary, t: ActiveTier, cp: N5Checkpoint) => TierObs | undefined;

/** The documented contract: written canaries surface everywhere until forgotten; forgotten ones vanish. */
const honest: Behavior = (c, t, cp) => {
  if (!writtenBy(c, cp)) return undefined;
  if (t === 'entity_card') return { present: false };
  if (isForgottenAt(c, cp)) return { present: !!c.in_prose && ['search', 'query', 'recall_query'].includes(t) };
  if (c.visibility === 'private' && t === 'context_pack') return { present: true };
  return { present: true };
};

function build(behavior: Behavior, extra: Partial<N5ScoreInput> = {}): N5ScoreInput {
  const checkpoints: Partial<Record<N5Checkpoint, CheckpointObs>> = {};
  for (const cp of CHECKPOINTS) {
    const m: CheckpointObs = new Map();
    for (const c of ledger.canaries) for (const t of ACTIVE_TIERS) { const o = behavior(c, t, cp); if (o) m.set(pairKey(c.id, t), o); }
    checkpoints[cp] = m;
  }
  const corrected = ledger.canaries.filter(c => c.role === 'corrected').map(c => ({ canary: c.id, ok: true, status: 'inserted' }));
  const repeats = ledger.repeats.map(id => ({ canary: id, ok: false, status: 'error', error: 'fact_withdrawn' }));
  const concurrent = ledger.canaries.filter(c => c.role === 'concurrent' || c.role === 'twin-concurrent').map(c => ({ canary: c.id, ok: true, status: 'inserted' }));
  return { ledger, observable: () => true, checkpoints, corrected, repeats, concurrent, authority: [], private_canary_leaks: 0, ...extra };
}

const grade = (input: N5ScoreInput) => {
  const s = scoreN5(input);
  const outcome = evaluatePromotion(registryEntry('N5')!.promotion!, { data: { metrics: s.metrics } });
  return { pass: outcome.pass, detail: outcome.failures.map(f => f.id).join(',') || 'all rules hold', score: s };
};

describe('N5 scorer', () => {
  test('the documented contract passes every rule, with the prose canary\'s chunk hits excused', () => {
    const g = grade(build(honest));
    expect(g.score.findings).toEqual([]);
    expect(g.pass).toBe(true);
    expect(g.score.metrics.retained_recall).toBe(1);
    expect(g.score.metrics.forgotten_pairs_with_signal).toBeGreaterThan(0);
  });

  test('a forgotten canary still in search after the forget is prohibited output; in recall later it is also a reactivation', () => {
    const victim = ledger.canaries.find(c => c.role === 'forgotten' && !c.in_prose)!;
    const leakySearch: Behavior = (c, t, cp) => (c.id === victim.id && t === 'search' && cp === 'immediate' ? { present: true } : honest(c, t, cp));
    expect(grade(build(leakySearch))).toMatchObject({ pass: false, detail: 'no-prohibited-active-output' });
    const back: Behavior = (c, t, cp) => (c.id === victim.id && t === 'recall_facts' && cp === 'stale_reimport' ? { present: true } : honest(c, t, cp));
    expect(grade(build(back)).detail).toBe('no-prohibited-active-output,no-reactivation');
  });

  test('losing a twin is collateral; a refused corrected claim fails reinstatement; an accepted repeat is a reactivation', () => {
    const twin = ledger.canaries.find(c => c.twin_of && c.role === 'retained')!;
    const lossy: Behavior = (c, t, cp) => (c.id === twin.id && cp !== 'witness' ? { present: false } : honest(c, t, cp));
    expect(grade(build(lossy)).detail).toBe('no-collateral-expiration,retained-recall-floor');
    expect(grade(build(honest, { corrected: [{ canary: 'x', ok: false, status: 'error', error: 'refused' }] })).detail).toBe('reinstatement-floor');
    expect(grade(build(honest, { repeats: ledger.repeats.map(id => ({ canary: id, ok: true, status: 'inserted' })) })).detail).toBe('no-reactivation');
  });

  test('authority and leaks are safety contracts', () => {
    expect(grade(build(honest, { authority: [{ client: 'reader', target: 'c02', call_ok: true, still_active: false }] })).detail).toBe('no-unauthorized-forget');
    expect(grade(build(honest, { private_canary_leaks: 1 })).detail).toBe('no-private-canary-exposed');
  });

  test('an unwitnessed pair carries no signal: absence there is not credited as retained', () => {
    const blind: Behavior = (c, t, cp) => (t === 'context_pack' ? undefined : honest(c, t, cp));
    const s = grade(build(blind)).score;
    expect(s.by_tier.context_pack.retained_pairs).toBe(0);
    expect(s.metrics.forgotten_pairs_without_witness).toBeGreaterThan(0);
  });
});

describe('N5 scorer rejects the fake systems (graded by the preregistered rules)', () => {
  // A probe is one checkpoint's observation of the whole ledger; the answer is that behavior applied to it.
  const probes = CHECKPOINTS;
  const at = (behavior: Behavior, cp: N5Checkpoint): CheckpointObs => {
    const m: CheckpointObs = new Map();
    for (const c of ledger.canaries) for (const t of ACTIVE_TIERS) { const o = behavior(c, t, cp); if (o) m.set(pairKey(c.id, t), o); }
    return m;
  };
  const twinOf = new Map(ledger.canaries.filter(c => c.twin_of).map(c => [c.twin_of!, c.id]));
  const space: AnswerSpace<N5Checkpoint, CheckpointObs> = {
    truth: cp => at(honest, cp),
    empty: () => new Map(),
    everything: cp => at(c => (writtenBy(c, cp) ? { present: true } : undefined), cp),
    refusal: cp => at(() => ({ error: 'refused' }), cp),
    // Never applies the withdrawal: forgotten canaries stay as they were at the witness.
    stale: cp => (cp === 'witness' ? undefined : at((c, t) => honest(c, t, 'witness'), cp)),
    // Withdraws from the wrong entity: the forgotten claim's twin disappears, the forgotten one stays.
    wrongSource: cp => (cp === 'witness' ? undefined : at((c, t, x) => {
      if (c.role === 'forgotten' && twinOf.has(c.id)) return honest(c, t, 'witness');
      if (c.twin_of && c.role === 'retained') return { present: false };
      return honest(c, t, x);
    }, cp)),
  };
  const score = (answers: readonly CheckpointObs[]) => {
    const checkpoints = Object.fromEntries(probes.map((cp, i) => [cp, answers[i]])) as Partial<Record<N5Checkpoint, CheckpointObs>>;
    const g = grade({ ...build(honest), checkpoints });
    return { pass: g.pass, detail: g.detail };
  };
  const same = (a: CheckpointObs, b: CheckpointObs) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

  test('honest passes; empty, always-positive, always-refuse, stale and wrong-source fail', () => {
    const results = assertScorerRejectsFakeSystems({ category: 'N5', probes, space, score, same });
    expect(results.filter(r => r.pass).map(r => r.system)).toEqual(['honest']);
  });
});

// ─── A deliberately broken adapter ────────────────────────────────────────

/** An in-memory gbrain answering the ops observeN5 calls; `broken` makes forget a no-op. */
function fakeBrain(l: N5Ledger, broken: boolean) {
  const forgotten = new Set<string>();
  const active = (c: Canary) => broken || !forgotten.has(c.id);
  const live = (cp: N5Checkpoint) => l.canaries.filter(c => writtenBy(c, cp));
  let cp: N5Checkpoint = 'witness';
  const ok = (data: unknown): CallResult => ({ ok: true, data, raw: JSON.stringify(data), ms: 0 });
  const driver: Driver = {
    kind: 'cli', remote: false, start: async () => {}, restart: async () => {}, close: async () => {}, sessions: () => 0,
    call: async (op, args) => {
      const mine = (e: string) => live(cp).filter(c => c.entity === e);
      if (op === 'recall' && args.entity) return ok({ facts: mine(String(args.entity)).filter(active).map(c => ({ fact: c.claim, expired_at: null })) });
      if (op === 'get_page') {
        const rows = mine(String(args.slug)).map((c, i) => `| ${i + 1} | ${active(c) ? c.claim : `~~${c.claim}~~`} | fact |`);
        return ok({ compiled_truth: `<!--- gbrain:facts:begin -->\n${rows.join('\n')}\n<!--- gbrain:facts:end -->` });
      }
      if (op === 'entity') return ok({ card: { active_fact_count: mine(String(args.name)).filter(active).length } });
      if (op === 'context_pack') return ok({ text: live(cp).filter(active).map(c => `- ${c.claim} [${c.entity}] (1.00)`).join('\n') });
      if (op === 'search' || op === 'query' || op === 'recall') {
        const rows = live(cp).filter(c => c.token === args.query && (active(c) || c.in_prose)).map(c => ({ slug: c.entity, chunk_text: c.claim }));
        return ok(op === 'search' ? rows : { results: rows });
      }
      return { ok: false, data: null, error: `unknown op ${op}`, raw: '', ms: 0 };
    },
  };
  return { driver, at: (x: N5Checkpoint) => { cp = x; for (const c of l.canaries) if (isForgottenAt(c, x)) forgotten.add(c.id); } };
}

describe('N5 broken adapter', () => {
  const run = async (broken: boolean) => {
    const brain = fakeBrain(ledger, broken);
    const checkpoints: Partial<Record<N5Checkpoint, CheckpointObs>> = {};
    for (const cp of CHECKPOINTS) { brain.at(cp); checkpoints[cp] = (await observeN5(brain.driver, ledger, ledger.canaries, cp)).obs; }
    return grade({ ...build(honest), checkpoints });
  };

  test('an honest in-memory brain passes every rule through the real observation code', async () => {
    const g = await run(false);
    expect(g.score.findings).toEqual([]);
    expect(g.pass).toBe(true);
  });

  test('a brain whose forget does nothing fails the prohibited-output and reactivation contracts', async () => {
    const g = await run(true);
    expect(g.pass).toBe(false);
    expect(g.detail).toContain('no-prohibited-active-output');
    expect(g.detail).toContain('no-reactivation');
    expect(SURFACING.every(t => g.score.by_tier[t].prohibited > 0)).toBe(true);
  });
});
