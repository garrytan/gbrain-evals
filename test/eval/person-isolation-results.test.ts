import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const D = 'docs/benchmarks/2026-11-24-person-isolation';
const page = readFileSync('docs/benchmarks/2026-11-24-person-isolation.md', 'utf8');
const SEEDS = ['20261124', '20261125', '20261126'];
const CELLS = ['mcp-dispatch-pglite', 'mcp-dispatch-postgres', 'http-pglite', 'http-postgres', 'cli-pglite', 'cli-postgres'];
type R = { verdict: string; publishable: boolean; n_total: number; gbrain_version: string; execution: { source_tree: { dirty: boolean; git_head: string } }; data: { gate_total: number; cells?: Array<{ ops_with_signal: string[]; mandatory: Record<string, { probes: number }> }> } };
const load = (build: string, cell: string) => SEEDS.map(s => JSON.parse(readFileSync(join(D, build, s, cell + '.json'), 'utf8')) as R);
const fmt = (n: number) => n.toLocaleString('en-US');

describe('person-isolation results page matches its receipts', () => {
  // Value: protects=every number on the results page against the raw receipts, since review skips the receipts; fails_when=a receipt or a page number changes without the other, or a failing receipt carries more than its total; why_new=the receipts are excluded from review (#643); seam=docs/benchmarks/2026-11-24-person-isolation/**; no_claim=how the runner computes a leak
  test('the folder holds exactly the 36 receipts the page cites', () => {
    for (const build of ['v0.60.771.0', 'v0.60.769.0']) {
      expect(readdirSync(join(D, build)).sort()).toEqual(SEEDS);
      for (const s of SEEDS) expect(readdirSync(join(D, build, s)).sort()).toEqual(CELLS.map(c => c + '.json').sort());
    }
  });

  test('v0.60.771.0: every cell passes at zero from a clean tree, and the page states its probes and signal', () => {
    let total = 0;
    for (const cell of CELLS) {
      const rs = load('v0.60.771.0', cell);
      for (const r of rs) {
        expect([cell, r.verdict, r.data.gate_total, r.gbrain_version, r.execution.source_tree.dirty]).toEqual([cell, 'pass', 0, '0.60.771.0', false]);
        expect([r.execution.source_tree.git_head.slice(0, 9), r.publishable]).toEqual(['360b8d838', true]);
      }
      const probes = rs.reduce((n, r) => n + r.n_total, 0);
      total += probes;
      const sig = new Set(rs.map(r => r.data.cells![0]!.ops_with_signal.length));
      expect(sig.size).toBe(1);
      const ops = cell.startsWith('cli') ? 5 : 117;
      expect(page).toContain(`| ${fmt(probes)} | **0** | ${[...sig][0]} of ${ops} |`);
    }
    expect(total).toBe(1_492_098);
    expect(page).toContain(fmt(total) + ' probes');
  });

  test('v0.60.771.0: the per-operation table is the sum of each mandatory operation over the three seeds', () => {
    for (const [cell, col] of [['mcp-dispatch-pglite', 0], ['http-pglite', 1], ['cli-pglite', 2]] as const) {
      const rs = load('v0.60.771.0', cell);
      const pg = load('v0.60.771.0', cell.replace('pglite', 'postgres'));
      for (const op of Object.keys(rs[0]!.data.cells![0]!.mandatory)) {
        const n = rs.reduce((a, r) => a + r.data.cells![0]!.mandatory[op]!.probes, 0);
        expect(pg.reduce((a, r) => a + r.data.cells![0]!.mandatory[op]!.probes, 0)).toBe(n);
        const row = page.split('\n').find(l => l.startsWith('| `' + op + '` |'))!;
        expect([op, row.split(' | ')[col + 1]!.replace(/ \|$/, '').split(' (')[0]]).toEqual([op, fmt(n)]);
      }
    }
  });

  test('v0.60.769.0: the CLI cells fail with 413 leaks each and publish only their verdict and total', () => {
    for (const cell of CELLS) {
      const rs = load('v0.60.769.0', cell);
      if (cell.startsWith('cli')) {
        for (const r of rs) expect(Object.keys(r.data).sort()).toEqual(['gate_total', 'verdict']);
        expect(rs.reduce((n, r) => n + r.data.gate_total, 0)).toBe(413);
      } else {
        for (const r of rs) expect([cell, r.verdict, r.data.gate_total]).toEqual([cell, 'pass', 0]);
        expect(page).toContain(fmt(rs.reduce((n, r) => n + r.n_total, 0)) + ' each');
      }
    }
    expect(page).toContain('**413** each');
  });
});
