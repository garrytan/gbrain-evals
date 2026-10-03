/**
 * N8 proactive-recall: generator determinism and gold, the delivery scorer
 * with hand-built negatives, the associative scorer with the adjudicated
 * negatives, a deliberately broken adapter, and the scorer mutation suite.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registryEntry } from '../../eval/registry.ts';
import { assertScorerRejectsFakeSystems } from '../../eval/runner/mutation-kit.ts';
import { N8_DEFAULT_SEED, NEGATIVE_KINDS, TRIGGER_KINDS, generateN8World, windowAt, type TurnGold } from '../../eval/generators/n8-proactive-recall-gen.ts';
import { n8Targets, prAuc, scoreAssociative, scoreMode, type TurnDelivery } from '../../eval/runner/n8-proactive-recall.ts';

const world = generateN8World();
const userTurns = [...world.gold.entries()];
const deliver = (fn: (id: string, g: TurnGold) => string[]): TurnDelivery[] => userTurns.map(([id, g]) => ({ turn: id, delivered: fn(id, g), tokens: 10, latency_ms: 1 }));

describe('N8 generator', () => {
  test('same seed, same ledger hash; another seed differs', () => {
    expect(generateN8World().fingerprint).toBe(generateN8World({ seed: N8_DEFAULT_SEED }).fingerprint);
    expect(generateN8World({ seed: 3 }).fingerprint).not.toBe(world.fingerprint);
  });

  test('no user turn asks the brain for recall, every trigger names its target, negatives mention nothing in the brain', () => {
    for (const [id, g] of userTurns) {
      const turn = world.ledger.sessions.flatMap(s => s.turns).find(t => t.id === id)!;
      expect(turn.text).not.toMatch(/\b(remember|recall|what do (you|we) know|look up|remind me who)\b/i);
      if (TRIGGER_KINDS.includes(g.kind)) expect(g.target).toHaveLength(1);
      if (NEGATIVE_KINDS.includes(g.kind)) expect(turn.mentions).toEqual([]);
    }
  });

  test('allowed pages are the live pages mentioned in the window; soft-deleted pages are never allowed', () => {
    const withdrawn = new Set(world.ledger.entities.filter(e => e.withdrawn).map(e => e.slug));
    for (const s of world.ledger.sessions) s.turns.forEach((t, i) => {
      if (t.role !== 'user') return;
      const g = world.gold.get(t.id)!;
      const mentioned = new Set(windowAt(s, i).flatMap(w => w.mentions));
      for (const a of g.allowed) { expect(mentioned.has(a)).toBe(true); expect(withdrawn.has(a)).toBe(false); }
    });
  });
});

const truth = (_id: string, g: TurnGold) => g.target;

describe('N8 delivery scorer', () => {
  test('delivering exactly the targets meets every frozen target', () => {
    const m = scoreMode(world, deliver(truth));
    expect(m.recall).toBe(1);
    expect(m.false_alarm_rate).toBe(0);
    expect(n8Targets(m)).toEqual({ pass: true, failed: [] });
  });

  test('a page the window never mentions is a false alarm; a second delivery in a session is redundant, not a false alarm', () => {
    const neg = userTurns.find(([, g]) => g.kind === 'innocuous')![0];
    const one = scoreMode(world, deliver((id, g) => id === neg ? [world.ledger.entities[0].slug] : g.target));
    expect(one.negative_turns_with_false_alarm).toBe(1);
    const many = scoreMode(world, deliver((_id, g) => g.kind === 'innocuous' ? [world.ledger.entities[0].slug] : g.target));
    expect(many.innocuous_and_no_mention_false_alarm_rate).toBeGreaterThan(0.05);
    expect(n8Targets(many).pass).toBe(false);
    const rep = userTurns.find(([, g]) => g.kind === 'repeat')!;
    const red = scoreMode(world, deliver((id, g) => id === rep[0] ? rep[1].allowed : g.target));
    expect(red.redundant_deliveries).toBeGreaterThan(0);
    expect(red.negative_turns_with_false_alarm).toBe(0);
  });

  test('private and soft-deleted deliveries are counted wherever they happen', () => {
    const priv = world.ledger.entities.find(e => e.visibility === 'private')!.slug;
    const gone = world.ledger.entities.find(e => e.withdrawn)!.slug;
    const m = scoreMode(world, deliver((_id, g) => g.kind === 'private_mention' ? [priv] : g.kind === 'withdrawn_mention' ? [gone] : g.target));
    expect(m.private_deliveries).toBeGreaterThan(0);
    expect(m.withdrawn_deliveries).toBeGreaterThan(0);
  });

  test('a deliberately broken adapter that pushes every mentioned page every turn, ignoring visibility and the session, fails', () => {
    const all = world.ledger.entities.map(e => e.slug);
    const broken = deliver((id) => {
      const s = world.ledger.sessions.find(x => x.turns.some(t => t.id === id))!;
      const i = s.turns.findIndex(t => t.id === id);
      return [...new Set([...windowAt(s, i).flatMap(w => w.mentions), all[0]])];
    });
    const t = n8Targets(scoreMode(world, broken));
    expect(t.pass).toBe(false);
    expect(t.failed.join(' ')).toMatch(/redundant|private|withdrawn|false_alarm/);
  });

  test('PR-AUC over sweep points', () => {
    expect(prAuc([{ recall: 1, precision: 1 }])).toBe(1);
    expect(prAuc([{ recall: 0.5, precision: 1 }, { recall: 1, precision: 0.5 }])).toBeCloseTo(0.875, 6);
    expect(prAuc([{ recall: 0, precision: null }])).toBeNull();
  });

  test('the category is report-only: no rule gates it', () => {
    const e = registryEntry('N8')!;
    expect(e.gate).toBe('report-only');
    expect([...e.promotion!.safety_contracts, ...e.promotion!.quality_thresholds]).toEqual([]);
  });
});

describe('N8 associative scorer with the adjudicated negatives', () => {
  const root = join(import.meta.dir, '../../eval/data');
  const probes = JSON.parse(readFileSync(join(root, 'associative-recall-v1/probes.json'), 'utf8')).probes;
  const spans = JSON.parse(readFileSync(join(root, 'associative-recall-v1/qrels.json'), 'utf8')).spans;
  const sources = JSON.parse(readFileSync(join(root, 'associative-recall-v1/sources.json'), 'utf8')).sources;
  const adjudication = JSON.parse(readFileSync(join(root, 'n8-proactive-recall/associative-negatives-adjudication-v1.json'), 'utf8'));

  test('the adjudication covers exactly the three disputed negatives and names real public pages', () => {
    expect(adjudication.decisions.map((d: { probe_id: string }) => d.probe_id).sort()).toEqual(['causal-context/ink-smear/negative', 'changing-decisions/concert-recording/negative', 'changing-decisions/library-fines/negative']);
    for (const d of adjudication.decisions) for (const p of d.permissible_pages) {
      expect(sources.find((s: { source_id: string; slug: string; visibility: string }) => s.source_id === p.source_id && s.slug === p.slug)?.visibility).toBe('public');
    }
  });

  test('a permissible association on a disputed negative is a strict false alarm but not an adjudicated one; a distractor is both', () => {
    const d = adjudication.decisions[0];
    const ok = scoreAssociative(probes, spans, sources, adjudication, [{ probe: d.probe_id, delivered: d.permissible_pages }]);
    expect([ok.strict_false_alarms, ok.adjudicated_false_alarms]).toEqual([1, 0]);
    const bad = scoreAssociative(probes, spans, sources, adjudication, [{ probe: d.probe_id, delivered: [{ source_id: 'causal-context/ink-smear/other-party', slug: 'ink-smear/episode-1' }] }]);
    expect([bad.strict_false_alarms, bad.adjudicated_false_alarms]).toEqual([1, 1]);
  });

  test('a same-slug page from the distractor source does not count as recall', () => {
    const p = probes.find((x: { kind: string }) => x.kind === 'indirect');
    const span = spans.find((s: { id: string }) => s.id === p.required_span_ids[0]);
    const right = scoreAssociative(probes, spans, sources, adjudication, [{ probe: p.id, delivered: [{ source_id: span.source_id, slug: span.slug }] }]) as { indirect: { any: number } };
    const wrong = scoreAssociative(probes, spans, sources, adjudication, [{ probe: p.id, delivered: [{ source_id: `${p.family_id}/other-party`, slug: span.slug }] }]) as { indirect: { any: number } };
    expect([right.indirect.any, wrong.indirect.any]).toEqual([1, 0]);
  });
});

describe('N8 scorer mutation suite', () => {
  test('the frozen targets pass the honest system and fail every fake', () => {
    const order = world.ledger.sessions.flatMap(s => s.turns.filter(t => t.role === 'user').map(t => t.id));
    const previousTarget = new Map<string, string[]>();
    for (const s of world.ledger.sessions) {
      let prev: string[] | undefined;
      for (const t of s.turns) {
        if (t.role !== 'user') continue;
        const g = world.gold.get(t.id)!;
        if (TRIGGER_KINDS.includes(g.kind) && prev) previousTarget.set(t.id, prev);
        if (TRIGGER_KINDS.includes(g.kind)) prev = g.target;
      }
    }
    const sameType = (slug: string) => {
      const e = world.ledger.entities.find(x => x.slug === slug)!;
      return world.ledger.entities.find(x => x.kind === e.kind && x.slug !== slug)!.slug;
    };
    const live = world.ledger.entities.filter(e => !e.withdrawn).map(e => e.slug);
    const results = assertScorerRejectsFakeSystems<string, string[]>({
      category: 'N8',
      probes: order,
      space: {
        truth: id => world.gold.get(id)!.target,
        empty: () => [],
        everything: () => live,
        refusal: () => [],
        stale: id => previousTarget.get(id),
        wrongSource: id => { const t = world.gold.get(id)!.target; return t.length ? t.map(sameType) : undefined; },
      },
      score: answers => {
        const t = n8Targets(scoreMode(world, order.map((id, i) => ({ turn: id, delivered: answers[i], tokens: 0, latency_ms: 0 }))));
        return { pass: t.pass, detail: t.failed.join(',') || 'pass' };
      },
    });
    expect(results.filter(r => r.pass).map(r => r.system)).toEqual(['honest']);
  });
});
