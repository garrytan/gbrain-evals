/**
 * BrainBench: PrecisionMemBench (faithful external-benchmark adapter)
 *
 * Runs gbrain's REAL retrieval against tenurehq/precisionmembench using the
 * vendored upstream scorer (MIT, see eval/precisionmembench/ATTRIBUTION.md).
 * The scorer is byte-identical to upstream except the ava wrapper was removed;
 * gbrain's adapter overrides only `searchText`, so we are measured on exactly
 * the searchText categories (alias, scope, fuzzy, supersession, ranking).
 * Structural categories (pinned facts, relation expansion, open questions) are
 * harness-computed and identical for every provider on the leaderboard.
 *
 * Honesty: no benchmark-gaming. Beliefs feed gbrain the way real content
 * arrives; scope uses gbrain's real multi-source isolation; superseded beliefs
 * use gbrain's real soft-delete. Every mode's number is reported as-is.
 *
 * Run:
 *   bun eval/runner/precisionmembench.ts --mode gbrain-hybrid
 *   bun eval/runner/precisionmembench.ts --mode gbrain-keyword   # no embed key
 *   bun eval/runner/precisionmembench.ts --mode gbrain-hybrid --limit 10
 *   bun eval/runner/precisionmembench.ts --mode gbrain-hybrid --json
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { buildReportPayload } from '../precisionmembench/scorer/buildRetrievalReport.ts';
import {
  scoreCases,
  pinnedInSeedSet,
  coerceBelief,
  type RetrievalCase,
} from '../precisionmembench/scorer/runCases.ts';
import type { Belief } from '../precisionmembench/scorer/belief.ts';
import { GbrainBeliefAdapter } from '../precisionmembench/gbrainAdapter.ts';
import { GbrainThinkAdapter } from '../precisionmembench/gbrainThinkAdapter.ts';
import {
  createBenchEngine,
  seedGbrainEngine,
  configureGatewayForBench,
  type SeedFidelity,
} from '../precisionmembench/seed.ts';

const PMB_DIR = join(import.meta.dir, '..', 'precisionmembench');
const FIXTURE_BELIEFS = join(PMB_DIR, 'fixtures', 'beliefs.seed.json');
const FIXTURE_CASES = join(PMB_DIR, 'fixtures', 'retrieval.cases.json');
const REPORT_DIR = join(import.meta.dir, '..', 'reports', 'precisionmembench');

// Published leaderboard (from upstream test-results/baseline/, c9689ca) for context.
const LEADERBOARD: Array<{ name: string; precision: number; active: number; pass: string }> = [
  { name: 'tenure (author)', precision: 1.0, active: 43, pass: '77/77' },
  { name: 'supermemory', precision: 0.43, active: 17, pass: '44/77' },
  { name: 'agentmemory', precision: 0.17, active: 0, pass: '7/77' },
  { name: 'yourmemory', precision: 0.17, active: 0, pass: '21/77' },
  { name: 'atomicmemory', precision: 0.15, active: 0, pass: '9/77' },
  { name: 'zep', precision: 0.09, active: 0, pass: '9/77' },
  { name: 'vector baseline', precision: 0.088, active: 0, pass: '9/77' },
  { name: 'mem0', precision: 0.056, active: 0, pass: '9/77' },
];

interface Opts {
  mode: 'gbrain-hybrid' | 'gbrain-keyword' | 'gbrain-think' | 'gbrain-adaptive';
  fidelity: SeedFidelity;
  limit: number | null;
  json: boolean;
  noEmbed: boolean;
  entityMax: number | null;
  otherMax: number | null;
}

function parseOpts(): Opts {
  const a = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const mode = (get('--mode') ?? 'gbrain-hybrid') as Opts['mode'];
  return {
    mode,
    fidelity: (get('--fidelity') ?? 'body-text') as SeedFidelity,
    limit: get('--limit') ? Number(get('--limit')) : null,
    json: a.includes('--json'),
    noEmbed: a.includes('--no-embed') || mode === 'gbrain-keyword',
    entityMax: get('--entity-max') ? Number(get('--entity-max')) : null,
    otherMax: get('--other-max') ? Number(get('--other-max')) : null,
  };
}

async function main(): Promise<void> {
  const opts = parseOpts();

  const rawBeliefs = JSON.parse(readFileSync(FIXTURE_BELIEFS, 'utf8')) as Record<string, unknown>[];
  const beliefs: Belief[] = rawBeliefs.map(coerceBelief);
  let cases = JSON.parse(readFileSync(FIXTURE_CASES, 'utf8')) as RetrievalCase[];
  if (opts.limit) cases = cases.slice(0, opts.limit);

  // hybrid + adaptive + think all need embeddings (think's gather uses hybridSearch).
  const needsEmbed = opts.mode !== 'gbrain-keyword';
  if (needsEmbed) configureGatewayForBench();

  // Silence gbrain's chatty import/extract logs so the scorecard is readable.
  const origLog = console.log;
  const origErr = console.error;
  if (!opts.json) {
    console.log = () => {};
    console.error = () => {};
  }
  const engine = await createBenchEngine();
  let seedStats: { imported: number; softDeleted: number };
  try {
    seedStats = await seedGbrainEngine(engine, beliefs, {
      fidelity: opts.fidelity,
      noEmbed: opts.noEmbed,
    });
  } finally {
    if (!opts.json) {
      console.log = origLog;
      console.error = origErr;
    }
  }

  let adapter;
  if (opts.mode === 'gbrain-think') {
    adapter = new GbrainThinkAdapter(engine);
  } else if (opts.mode === 'gbrain-adaptive') {
    // Drive gbrain's REAL adaptive-return core feature via hybridSearch opts.
    // Default to the shipped recall-preserving caps unless overridden.
    const adaptiveReturn: Record<string, unknown> = { enabled: true };
    if (opts.entityMax != null) adaptiveReturn.entityMax = opts.entityMax;
    if (opts.otherMax != null) adaptiveReturn.otherMax = opts.otherMax;
    adapter = new GbrainBeliefAdapter(engine, 'hybrid', { extraHybridOpts: { adaptiveReturn } });
  } else {
    adapter = new GbrainBeliefAdapter(engine, opts.mode === 'gbrain-keyword' ? 'keyword' : 'hybrid');
  }
  adapter.loadFixture(beliefs);

  const pinnedInSeed = pinnedInSeedSet(beliefs);
  const report = await scoreCases(adapter, cases, pinnedInSeed);

  const provider = `${opts.mode}-${opts.fidelity}`;
  const payload = buildReportPayload(
    { provider, entries: report, caseCount: cases.length },
    report,
  );
  const r = (payload as any).retrieval;

  mkdirSync(REPORT_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const reportPath = join(REPORT_DIR, `${date}-${provider}.json`);
  writeFileSync(reportPath, JSON.stringify(payload, null, 2));

  await engine.disconnect();

  if (opts.json) {
    origLog(JSON.stringify(payload, null, 2));
    return;
  }

  // Scorecard
  origLog(`\n# PrecisionMemBench — gbrain (${provider})\n`);
  origLog(`Seeded: ${seedStats.imported} beliefs (${seedStats.softDeleted} superseded → soft-deleted)`);
  origLog(`Cases:  ${r.totalCases}  |  embed: ${opts.noEmbed ? 'OFF (keyword-only)' : 'ON'}\n`);
  origLog(`  mean precision : ${r.meanPrecision}`);
  origLog(`  mean recall    : ${r.meanRecall}`);
  origLog(`  pass rate      : ${r.totalPassed}/${r.totalCases} (${r.passRate})`);
  origLog(`  active passes  : ${r.activeRetrievalPasses}`);
  origLog(`  passTypes      : active=${r.passTypes.activeRetrieval} structural=${r.passTypes.structural} triviallyEmpty=${r.passTypes.triviallyEmpty}`);
  origLog(`  p50 latency    : ${r.p50LatencyMs}ms\n`);

  origLog(`## vs published leaderboard (mean precision)\n`);
  const rows = [
    ...LEADERBOARD,
    { name: `>> gbrain (${provider})`, precision: r.meanPrecision ?? 0, active: r.activeRetrievalPasses, pass: `${r.totalPassed}/${r.totalCases}` },
  ].sort((x, y) => y.precision - x.precision);
  origLog('| System | Precision | Active | Pass |');
  origLog('|--------|-----------|--------|------|');
  for (const row of rows) {
    origLog(`| ${row.name.padEnd(20)} | ${row.precision.toFixed(3)} | ${String(row.active).padStart(2)} | ${row.pass} |`);
  }

  origLog(`\n## per-category mean precision\n`);
  for (const c of r.categories) {
    origLog(`  ${c.category.padEnd(34)} ${c.passed}/${c.caseCount}  prec=${c.meanPrecision ?? '—'}  recall=${c.meanRecall ?? '—'}`);
  }
  origLog(`\nReport: ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
