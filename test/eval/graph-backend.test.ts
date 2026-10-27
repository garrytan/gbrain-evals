import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate, callsFor } from '../../eval/runner/graph-backend/generate.ts';
import { HydraWalker, relFwd, relRev, type HydraClient } from '../../eval/runner/graph-backend/hydra.ts';
import { LINK_TYPES } from '../../eval/runner/graph-backend/generate.ts';

const DIR = 'docs/benchmarks/2026-10-17-graph-backend';

describe('graph-backend fixture', () => {
  test('the Personal graph is reproducible from its seed', () => {
    const g = generate('personal');
    const recorded = JSON.parse(readFileSync(`${DIR}/personal/load-pg.json`, 'utf8'));
    expect(g.edgeSha256).toBe(recorded.edgeSha256);
    expect(g.from.length).toBe(60_000);
    expect(g.starts.length).toBe(500);
    expect(callsFor(g.starts).length).toBe(11_000);
  });
});

/** In-memory stand-in for HydraDB's batched one-hop read and per-depth query. */
function fakeHydra(edges: Array<[number, number, string]>): HydraClient {
  const adj = new Map<string, Map<number, number[]>>();
  const add = (rel: string, a: number, b: number) => {
    if (!adj.has(rel)) adj.set(rel, new Map());
    const m = adj.get(rel)!;
    m.set(a, [...(m.get(a) ?? []), b]);
  };
  for (const [f, t, type] of edges) {
    const ti = (LINK_TYPES as readonly string[]).indexOf(type);
    add(relFwd(ti), f, t); add(relRev(ti), t, f); add('LINK', f, t); add('LINK_R', t, f);
  }
  return {
    requests: 0,
    async expand(ids: number[], rels: string[]) {
      const out: Array<[number, number, number]> = [];
      rels.forEach((rel, ri) => { for (const id of ids) for (const d of adj.get(rel)?.get(id) ?? []) out.push([id, d, ri]); });
      return out;
    },
    async perDepth(seed: number, maxDepth: number, rel: string) {
      const res: Set<number>[] = [];
      let cur = new Set([seed]);
      for (let d = 1; d <= maxDepth; d++) {
        const next = new Set<number>();
        for (const id of cur) for (const n of adj.get(rel)?.get(id) ?? []) next.add(n);
        res.push(next); cur = next;
      }
      return res;
    },
  } as unknown as HydraClient;
}

const hydrate = async (ids: number[]) => new Map(ids.map(id => [id, { slug: `p/${String(id).padStart(7, '0')}`, source_id: 'src-alpha', title: 't', type: 'note' }]));
const cycle: Array<[number, number, string]> = [[1, 2, 'works_with'], [2, 3, 'works_with'], [3, 1, 'works_with'], [3, 4, 'mentions']];

describe('HydraDB adapter semantics (gbrain breadth-first rules)', () => {
  for (const strategy of ['layer', 'perdepth'] as const) {
    test(`traverseGraph keeps each page once at its shortest depth (${strategy})`, async () => {
      const rows = await new HydraWalker(fakeHydra(cycle), hydrate, strategy).traverseGraph(1, 5);
      expect(rows.map(r => [r.slug, r.depth])).toEqual([['p/0000001', 0], ['p/0000002', 1], ['p/0000003', 2], ['p/0000004', 3]]);
      expect(rows[2].links.map(l => `${l.to_slug}:${l.link_type}`).sort()).toEqual(['p/0000001:works_with', 'p/0000004:mentions']);
    });
  }

  test('both-direction edges are returned once, one past the shallower walked endpoint', async () => {
    const res = await new HydraWalker(fakeHydra(cycle), hydrate).traversePaths(1, 2, 'both', null);
    expect(res.truncated).toBe(false);
    expect(res.paths.map(p => [p.from_slug.slice(-1), p.to_slug.slice(-1), p.depth])).toEqual([['1', '2', 1], ['3', '1', 1], ['2', '3', 2], ['3', '4', 2]]);
  });

  test('a link-type filter walks only that relationship, incoming through the reversed type', async () => {
    const res = await new HydraWalker(fakeHydra(cycle), hydrate).traversePaths(4, 3, 'in', 'mentions');
    expect(res.paths.map(p => [p.from_slug.slice(-1), p.to_slug.slice(-1), p.link_type, p.depth])).toEqual([['3', '4', 'mentions', 1]]);
  });
});

describe('published 2026-10-17 graph-backend receipts recount', () => {
  test('percentiles, correctness and the decision recompute from the committed rows', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'graph-backend-'));
    try {
      for (const tier of ['personal', 'team', 'company']) {
        cpSync(`${DIR}/${tier}/rows.ndjson.gz`, join(tmp, tier, 'rows.ndjson.gz'));
        cpSync(`${DIR}/${tier}/worker-runs.ndjson`, join(tmp, tier, 'worker-runs.ndjson'));
      }
      const run = spawnSync('bun', ['eval/runner/graph-backend/analyze.ts', tmp], { encoding: 'utf8' });
      expect(run.status).toBe(0);
      const fresh = JSON.parse(readFileSync(join(tmp, 'summary.json'), 'utf8')).tiers;
      const published = JSON.parse(readFileSync(`${DIR}/summary.json`, 'utf8')).tiers;
      for (const tier of ['personal', 'team', 'company']) {
        expect(fresh[tier].pooled).toEqual(published[tier].pooled);
        expect(fresh[tier].cells).toEqual(published[tier].cells);
        expect(fresh[tier].correctness).toEqual(published[tier].correctness);
        expect(fresh[tier].throughput).toEqual(published[tier].throughput);
        expect(fresh[tier].decision).toEqual(published[tier].decision);
        expect(fresh[tier].ab.compared).toBe(published[tier].ab.compared);
        expect(fresh[tier].ab.agree).toBe(published[tier].ab.agree);
      }
      expect(published.team.decision.meets_rule).toBe(false);
      expect(published.company.decision.meets_rule).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});
