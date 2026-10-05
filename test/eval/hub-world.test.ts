import { describe, expect, test } from 'bun:test';
import { generateHubWorld, SaltedRng, targetDegree } from '../../eval/generators/hub-world-gen.ts';
import { scoreHubRow } from '../../eval/runner/hub-world.ts';

describe('hub-world generator', () => {
  const w = generateHubWorld({ seed: 1, scale: 0.05 });
  test('deterministic for the dev seed; held-out seeds need the custodian salt', () => {
    expect(generateHubWorld({ seed: 1, scale: 0.05 }).summary).toEqual(w.summary);
    expect(() => generateHubWorld({ seed: 2, scale: 0.05 })).toThrow(/held out/);
    const a = generateHubWorld({ seed: 2, salt: 'x', scale: 0.05 }), b = generateHubWorld({ seed: 2, salt: 'y', scale: 0.05 });
    expect(a.probes.map(p => p.text)).not.toEqual(b.probes.map(p => p.text));
  });
  test('hubs reach their scaled targets and dominate the degree tail', () => {
    for (const h of w.summary.hubs) expect(h.realized).toBeGreaterThanOrEqual(h.target);
    expect(w.summary.inbound_quantiles.max).toBe(Math.max(...w.summary.hubs.map(h => h.realized)));
  });
  test('probe gold is stated by exactly the pages the generator wrote', () => {
    const text = new Map(w.pages.map(p => [p.slug, String(p.compiled_truth)]));
    for (const p of w.probes.filter(x => x.kind === 'hub-answer')) {
      const program = /runs the (.+) program/.exec(p.text)![1];
      const holders = [...text].filter(([, t]) => t.includes(`${program} program`)).map(([s]) => s);
      expect(holders).toEqual(p.gold);
    }
    for (const p of w.probes.filter(x => x.kind === 'bridge')) {
      expect(text.get(p.support[0])).toContain(p.gold[0]);
      expect(text.get(p.support[0])).toContain(p.hub);
    }
  });
  test('degree targets follow a heavy tail', () => {
    const r = new SaltedRng('t');
    const xs = Array.from({ length: 4000 }, () => targetDegree(r)).sort((a, b) => a - b);
    expect(xs[2000]).toBeGreaterThanOrEqual(3);
    expect(xs[2000]).toBeLessThanOrEqual(8);
    expect(xs[3600]).toBeGreaterThan(50);
  });
});

describe('hub-world scoring', () => {
  test('nDCG, recall, support and first place over distinct pages', () => {
    const s = scoreHubRow(['notes/b', 'people/a', 'people/a', 'x'], ['people/a'], ['notes/b']);
    expect(s.recall_at_5).toBe(1);
    expect(s.support_at_5).toBe(1);
    expect(s.hit_at_1).toBe(0);
    expect(s.ndcg_at_5).toBeCloseTo(1 / Math.log2(3), 5);
  });
});
