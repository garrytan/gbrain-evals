/**
 * BrainBench: PrecisionMemBench — instrumentation sweep (A5).
 *
 * Phase-1 "instrument before build" evidence (decision A5). Seeds gbrain once,
 * then:
 *   1. Sweeps return-sizing policies (topk / fixed:N / cliff) through the
 *      vendored scorer and reports precision / recall / active-passes for each
 *      — answers "can a tight/cliff gate clear supermemory's 0.43?"
 *   2. Reads the per-query score distribution to answer "does a stable cliff
 *      exist?" — for single-expected cases, how often is the right belief at
 *      rank 1, and how big is the gap to rank 2 (the separatrix)?
 *
 * Run: bun eval/runner/precisionmembench-instrument.ts [--keyword]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { buildReportPayload } from '../precisionmembench/scorer/buildRetrievalReport.ts';
import { scoreCases, pinnedInSeedSet, coerceBelief, type RetrievalCase } from '../precisionmembench/scorer/runCases.ts';
import type { Belief } from '../precisionmembench/scorer/belief.ts';
import { GbrainBeliefAdapter, type AdapterReturnPolicy } from '../precisionmembench/gbrainAdapter.ts';
import { createBenchEngine, seedGbrainEngine, configureGatewayForBench } from '../precisionmembench/seed.ts';

const PMB = join(import.meta.dir, '..', 'precisionmembench');
const beliefs: Belief[] = (JSON.parse(readFileSync(join(PMB, 'fixtures', 'beliefs.seed.json'), 'utf8')) as any[]).map(coerceBelief);
const cases = JSON.parse(readFileSync(join(PMB, 'fixtures', 'retrieval.cases.json'), 'utf8')) as RetrievalCase[];
const pinnedInSeed = pinnedInSeedSet(beliefs);
const keyword = process.argv.includes('--keyword');

function summarize(report: any[]) {
  const r = (buildReportPayload({ provider: 'x', entries: report, caseCount: report.length }, report) as any).retrieval;
  return { precision: r.meanPrecision, recall: r.meanRecall, active: r.activeRetrievalPasses, pass: `${r.totalPassed}/${r.totalCases}` };
}

const POLICIES: Array<{ label: string; policy: AdapterReturnPolicy }> = [
  { label: 'topk (baseline)', policy: { kind: 'topk' } },
  { label: 'fixed:1', policy: { kind: 'fixed', n: 1 } },
  { label: 'fixed:2', policy: { kind: 'fixed', n: 2 } },
  { label: 'cliff minKeep1 gap0.20', policy: { kind: 'cliff', minKeep: 1, minGapRatio: 0.20 } },
  { label: 'intent: entity=1 / else=3', policy: { kind: 'intent', single: { kind: 'fixed', n: 1 }, multi: { kind: 'fixed', n: 3 } } },
  { label: 'intent: entity=1 / else=2', policy: { kind: 'intent', single: { kind: 'fixed', n: 1 }, multi: { kind: 'fixed', n: 2 } } },
  { label: 'intent: entity=1 / else=cliff.20', policy: { kind: 'intent', single: { kind: 'fixed', n: 1 }, multi: { kind: 'cliff', minKeep: 1, minGapRatio: 0.20 } } },
];

const origLog = console.log, origErr = console.error;
console.log = () => {}; console.error = () => {};
if (!keyword) configureGatewayForBench();
const engine = await createBenchEngine();
await seedGbrainEngine(engine, beliefs, { fidelity: 'body-text', noEmbed: keyword });
console.log = origLog; console.error = origErr;

// ── 1. Policy sweep ────────────────────────────────────────────────
const sweep: Array<{ label: string; precision: number | null; recall: number | null; active: number; pass: string }> = [];
for (const { label, policy } of POLICIES) {
  const adapter = new GbrainBeliefAdapter(engine, keyword ? 'keyword' : 'hybrid', { returnPolicy: policy });
  adapter.loadFixture(beliefs);
  const report = await scoreCases(adapter, cases, pinnedInSeed);
  sweep.push({ label, ...summarize(report) });
}

// ── 2. Separatrix read (topk pass, capture per-query ranked scores) ──
const perQuery = new Map<string, { scores: number[]; rankedIds: string[] }>();
const probe = new GbrainBeliefAdapter(engine, keyword ? 'keyword' : 'hybrid', {
  returnPolicy: { kind: 'topk' },
  onScores: ({ query, scores, keptIds }) => perQuery.set(query, { scores, rankedIds: keptIds }),
});
probe.loadFixture(beliefs);
await scoreCases(probe, cases, pinnedInSeed);

// For each case with exactly one expected relevant belief, find its rank + the
// gap between rank1 and rank2 (the cliff). Split by whether the expected belief
// IS rank 1.
let single = 0, rank1 = 0;
const gapWhenRank1: number[] = [], gapWhenNot: number[] = [];
for (const tc of cases) {
  const rb = tc.expect.relevantBeliefs ?? {};
  const expected = rb.shouldOnlyInclude ?? rb.mustInclude ?? [];
  const exp = expected.filter((id) => !pinnedInSeed.has(id));
  if (exp.length !== 1) continue;
  const pq = perQuery.get(tc.query);
  if (!pq || pq.scores.length < 1) continue;
  single++;
  const idx = pq.rankedIds.indexOf(exp[0]);
  const top = pq.scores[0] || 1e-9;
  const gap = pq.scores.length >= 2 ? (pq.scores[0] - pq.scores[1]) / top : 1;
  if (idx === 0) { rank1++; gapWhenRank1.push(gap); } else { gapWhenNot.push(gap); }
}
const med = (a: number[]) => a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;

// ── Output ─────────────────────────────────────────────────────────
origLog(`\n# PrecisionMemBench instrumentation (${keyword ? 'keyword' : 'hybrid'})\n`);
origLog(`## Policy sweep (can a tight/cliff gate clear supermemory 0.43?)\n`);
origLog('| policy | precision | recall | active | pass |');
origLog('|--------|-----------|--------|--------|------|');
for (const s of sweep) {
  origLog(`| ${s.label.padEnd(24)} | ${(s.precision ?? 0).toFixed(3)} | ${(s.recall ?? 0).toFixed(3)} | ${String(s.active).padStart(2)} | ${s.pass} |`);
}
origLog(`\n## Separatrix read (does a stable cliff exist?)\n`);
origLog(`single-expected cases analyzed : ${single}`);
origLog(`expected belief IS rank-1      : ${rank1}/${single} (${(rank1 / Math.max(1, single) * 100).toFixed(0)}%)`);
origLog(`median rank1→rank2 gap (correct@1): ${med(gapWhenRank1)?.toFixed(3) ?? '—'}`);
origLog(`median rank1→rank2 gap (wrong@1)  : ${med(gapWhenNot)?.toFixed(3) ?? '—'}`);
origLog(`\n(if correct@1 is high AND its gap >> wrong@1 gap, a cliff gate wins cleanly)`);

const outDir = join(import.meta.dir, '..', 'reports', 'precisionmembench');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `${new Date().toISOString().slice(0, 10)}-instrument-${keyword ? 'keyword' : 'hybrid'}.json`);
writeFileSync(out, JSON.stringify({ sweep, separatrix: { single, rank1, medGapCorrect: med(gapWhenRank1), medGapWrong: med(gapWhenNot) }, perQuery: [...perQuery.entries()].map(([q, v]) => ({ q, scores: v.scores.slice(0, 8) })) }, null, 2));
origLog(`\nReport: ${out}`);
await engine.disconnect();
