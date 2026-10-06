import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { campaignGuard, campaignStatus, expandRuns, familyUnits, loadCampaignManifest, readLedger, stepBlockers, type CampaignManifest } from '../../eval/runner/q2/campaign.ts';
import { Q2_EXPORT_ALLOWLIST } from '../../eval/runner/q2/export.ts';
import { exportAggregates } from '../../eval/runner/sealed-confirmation-lib.ts';
import { g5Gates } from '../../eval/runner/q2/g5.ts';

const REPO = resolve(import.meta.dir, '../..');
const root = () => mkdtempSync(join(tmpdir(), 'q2-campaign-'));

const manifest: CampaignManifest = { schema: 'q2-campaign-v1', decision_id: 'd', approved_usd: 2100, alert_usd: 2800, units: ['U1', 'U2'], steps: [
  { id: 'smoke', title: '', after: [], runs: ['a'], estimate_usd: 0, commands: [], expected: '' },
  { id: 'preflight', title: '', after: ['smoke'], runs: ['preflight'], estimate_usd: 0, commands: [], expected: '' },
  { id: 'arms', title: '', after: ['preflight'], requires_pass: ['preflight'], runs: ['te-{unit}'], estimate_usd: 0, commands: [], expected: '' },
  { id: 'c-select', title: '', after: ['arms'], runs: ['decision'], estimate_usd: 0, commands: [], expected: '' },
  { id: 'confirm-arms', title: '', after: ['c-select'], runs: ['te-{package}'], estimate_usd: 0, commands: [], expected: '' },
  { id: 'answers', title: '', after: ['confirm-arms'], runs: ['x'], estimate_usd: 1500, commands: [], expected: '' },
] };

function receipt(dir: string, verdict: string, extra: Record<string, unknown> = {}): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'receipt.json');
  writeFileSync(path, JSON.stringify({ run_status: 'completed', verdict, ...extra }));
  return path;
}
const run = (r: string, step: string, name: string, verdict = 'pass', extra: Record<string, unknown> = {}, more: string[] = []) => {
  const h = campaignGuard(['--campaign', r, '--step', step, '--run', name, ...more], { manifest })!;
  return h.finish(receipt(h.output, verdict, extra), Number(extra.spend ?? 0));
};

describe('campaign manifest order', () => {
  test('a step refuses to start without its predecessors\' receipts, and names what is missing', () => {
    const r = root();
    expect(() => campaignGuard(['--campaign', r, '--step', 'preflight', '--run', 'preflight'], { manifest })).toThrow('step smoke has no completed receipt for a');
    run(r, 'smoke', 'a', 'partial');
    run(r, 'preflight', 'preflight', 'fail');
    expect(() => campaignGuard(['--campaign', r, '--step', 'arms', '--run', 'te-U1'], { manifest })).toThrow('step preflight did not pass');
    run(r, 'preflight', 'preflight', 'pass');
    expect(campaignGuard(['--campaign', r, '--step', 'arms', '--run', 'te-U1'], { manifest })!.output).toBe(join(r, 'arms', 'te-U1'));
  });
  test('{unit} expands over baseline and units; {package} over baseline and P1..Pk from the recorded selection', () => {
    const r = root();
    for (const [s, n] of [['smoke', 'a'], ['preflight', 'preflight'], ['arms', 'te-baseline'], ['arms', 'te-U1'], ['arms', 'te-U2']] as const) run(r, s, n);
    expect(expandRuns(manifest, manifest.steps[2], r, readLedger(r))).toEqual(['te-baseline', 'te-U1', 'te-U2']);
    expect(() => campaignGuard(['--campaign', r, '--step', 'confirm-arms', '--run', 'te-P1'], { manifest })).toThrow('record it first');
    run(r, 'c-select', 'decision', 'fail', { data: { summary: { order: ['U2', 'U1'] } } });
    expect(expandRuns(manifest, manifest.steps[4], r, readLedger(r))).toEqual(['te-baseline', 'te-P1', 'te-P2']);
    expect(() => campaignGuard(['--campaign', r, '--step', 'confirm-arms', '--run', 'te-P3'], { manifest })).toThrow('te-P3 is not one of them');
    run(r, 'confirm-arms', 'te-baseline');
    expect(stepBlockers(manifest, readLedger(r), 'answers', r)).toEqual(['step confirm-arms has no completed receipt for te-P1, te-P2']);
    expect(campaignStatus(manifest, readLedger(r), r).next).toBe('confirm-arms');
  });
  test('the ledger tracks spend; a paid step past the $2,800 alert needs the owner\'s approval', () => {
    const r = root();
    run(r, 'smoke', 'a', 'pass', { spend: 1400 });
    run(r, 'preflight', 'preflight', 'pass');
    for (const n of ['te-baseline', 'te-U1', 'te-U2']) run(r, 'arms', n);
    run(r, 'c-select', 'decision', 'pass', { data: { summary: { order: ['U1'] } } });
    for (const n of ['te-baseline', 'te-P1']) run(r, 'confirm-arms', n);
    expect(() => campaignGuard(['--campaign', r, '--step', 'answers', '--run', 'x'], { manifest })).toThrow('passes the $2800 alert');
    expect(campaignGuard(['--campaign', r, '--step', 'answers', '--run', 'x', '--owner-approved-over-alert', 'owner 2026-10-07'], { manifest })).not.toBeNull();
    expect(campaignStatus(manifest, readLedger(r), r).spent_usd).toBe(1400);
  });
  test('the campaign root must sit outside every git worktree; output is fixed per step and run', () => {
    expect(() => campaignGuard(['--campaign', join(REPO, 'eval/reports/q2'), '--step', 'smoke', '--run', 'a'], { manifest })).toThrow('inside the repository');
    expect(() => campaignGuard(['--campaign', root(), '--step', 'smoke', '--run', 'a', '--output', '/tmp/elsewhere'], { manifest })).toThrow('drop --output');
  });
  test('joint units replace their members: the committed family is U1, U25, U34, U6 and drives the per-unit runs', () => {
    const m = loadCampaignManifest();
    expect(m.joint_units).toEqual({ U34: ['U3', 'U4'], U25: ['U2', 'U5'] });
    expect(familyUnits(m)).toEqual(['U1', 'U25', 'U34', 'U6']);
    expect(familyUnits({ units: ['U1', 'U2', 'U3'], joint_units: {} })).toEqual(['U1', 'U2', 'U3']);
    expect(() => familyUnits({ units: ['U1', 'U2', 'U3'], joint_units: { U12: ['U1', 'U2'], U23: ['U2', 'U3'] } })).toThrow('U2 belongs to both');
    expect(() => familyUnits({ units: ['U1'], joint_units: { U19: ['U1', 'U9'] } })).toThrow('U9, which is not in units');
    const step = m.steps.find(s => s.id === 'c-select-arms')!;
    expect(expandRuns(m, step, null, [])!.filter(r => r.startsWith('w-W1-'))).toEqual(['w-W1-baseline', 'w-W1-U1', 'w-W1-U25', 'w-W1-U34', 'w-W1-U6']);
    const r = root();
    for (const [st, run] of [['smoke', 'dev-junk-audit-N'], ['smoke', 'dev-junk-audit-K'], ['smoke', 'dev-temporal-edges'], ['smoke', 'dev-wta-scripted'], ['preflight', 'preflight']]) {
      const h = campaignGuard(['--campaign', r, '--step', st, '--run', run], { manifest: m })!;
      h.finish(receipt(h.output, 'pass'), 0);
    }
    expect(() => campaignGuard(['--campaign', r, '--step', 'c-select-arms', '--run', 'te-I1-f1-U3'], { manifest: m })).toThrow('te-I1-f1-U3 is not one of them');
    expect(campaignGuard(['--campaign', r, '--step', 'c-select-arms', '--run', 'te-I1-f1-U25'], { manifest: m })).not.toBeNull();
  });
  test('the committed manifest loads, keeps the preregistered order and budget', () => {
    const m = loadCampaignManifest();
    expect([m.approved_usd, m.alert_usd]).toEqual([2100, 2800]);
    const order = m.steps.map(s => s.id);
    for (const [a, b] of [['c-confirm', 'g6-arms'], ['g6-arms', 'g6-ingest'], ['g6-ingest', 'grammar-mint'], ['grammar-score', 'g6-answers'], ['g5', 'g6-answers']]) expect(order.indexOf(a)).toBeLessThan(order.indexOf(b));
    expect(m.steps.find(s => s.id === 'g6-answers')!.requires_pass).toEqual(['grammar-score', 'g5']);
    const doc = readFileSync(join(REPO, 'docs/benchmarks/2026-10-06-q2-parser-gaps-runbook.md'), 'utf8');
    for (const s of m.steps) expect([s.id, doc.includes(`(\`${s.id}\``)]).toEqual([s.id, true]);
  });
});

describe('aggregate export allowlist', () => {
  test('exports gate outcomes and counts from a Q2 receipt, never line text or rows', () => {
    const rec = { category: 'q2-grammar-gates', run_status: 'completed', verdict: 'fail',
      gates: [{ gate: 'G1.wrong_per_100k', outcome: 'fail', threshold: 'Wilson upper <= 2 per 100,000', observed: 2.3, denominators: { planned: 9, attempted: 9, scored: 9, errors: 0 }, failed_threshold: 'Wilson upper 2.3 > 2' }],
      data: { rows: [{ line: '- [Time] - [Event]' }], summary: { g1: { wrong: 4, list_lines: 500000, by_stratum: { stress: { wrong: 1 } } } } } };
    const { aggregate } = exportAggregates(rec, Q2_EXPORT_ALLOWLIST);
    expect(aggregate).toEqual({ category: 'q2-grammar-gates', run_status: 'completed', verdict: 'fail', gates: [{ gate: 'G1.wrong_per_100k', outcome: 'fail', observed: 2.3, denominators: { planned: 9, attempted: 9, scored: 9, errors: 0 } }],
      data: { summary: { g1: { wrong: 4, list_lines: 500000, by_stratum: { stress: { wrong: 1 } } } } } });
  });
});

describe('G5 decision', () => {
  const edges = (n: number, miss: number) => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, kind: 'edge', cluster: `p${i % 40}`, anyTypeMatch: Number(i >= miss) }));
  const inv = (n: number, bad = 0) => Array.from({ length: n }, (_, i) => ({ id: `page:${i}`, kind: 'invariance', cluster: `${i}`, extract_identical: Number(i >= bad) }));
  test('passes on identical arms with full invariance and clean variants; fails on a decoy added by the grammar', () => {
    const variants = [...Array.from({ length: 100 }, (_, i) => ({ id: `r${i}`, kind: 'relation', typed_recall: 1 })), ...Array.from({ length: 20 }, (_, i) => ({ id: `d${i}`, kind: 'decoy', decoy_added_by_grammar: 0 }))];
    const ok = g5Gates([...edges(300, 20), ...inv(240)], [...edges(300, 20), ...inv(240)], variants);
    expect(ok.map(g => g.outcome)).toEqual(['pass', 'pass', 'pass', 'pass']);
    const bad = g5Gates([...edges(300, 20), ...inv(240)], [...edges(300, 20), ...inv(240, 1)], [...variants.slice(0, 100), { id: 'd', kind: 'decoy', decoy_added_by_grammar: 1 }]);
    expect(bad.map(g => g.outcome)).toEqual(['pass', 'fail', 'pass', 'fail']);
  });
});
