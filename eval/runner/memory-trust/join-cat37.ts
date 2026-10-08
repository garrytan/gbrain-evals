/**
 * Join per-model Cat 37 paid receipts into the counted set and apply the
 * preregistered defaults decision (preregistration, "Commands": the report may
 * join the per-model cells instead of rerunning; the decision reads rows).
 *
 *   bun eval/runner/memory-trust/join-cat37.ts <receipt.json>... [--out <file>]
 *
 * Refuses receipts whose hermetic metrics, gbrain commit or scenario ledger
 * differ, and any receipt that is not a completed paid run.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { aggregateModelRows, decideDefaults, type ModelRow, type ModeMetrics } from '../cat37-memory-poisoning.ts';
import type { ModeName } from './sut.ts';
import { COUNTED_MODELS } from './models.ts';

interface Loaded { path: string; commit: string | null; ledger: string; byMode: Partial<Record<ModeName, ModeMetrics>>; rows: ModelRow[]; models: string[]; usd: number }

function load(path: string): Loaded {
  const r = JSON.parse(readFileSync(path, 'utf8'));
  if (r.run_status !== 'completed' || r.data?.model_arm?.mode !== 'paid') throw new Error(`${path}: not a completed paid Cat 37 run`);
  return { path, commit: r.execution?.product?.loaded_git_head ?? null, ledger: r.hashes?.ledger_sha256, byMode: r.data.by_mode, rows: r.data.model_arm.rows, models: r.data.model_arm.models, usd: r.cost?.usd ?? 0 };
}

export function joinCat37(paths: readonly string[]) {
  const all = paths.map(load);
  const [first] = all;
  if (!first) throw new Error('no receipts');
  for (const x of all) {
    if (x.commit !== first.commit) throw new Error(`${x.path}: gbrain ${x.commit} differs from ${first.commit}`);
    if (x.ledger !== first.ledger) throw new Error(`${x.path}: scenario ledger differs`);
    if (JSON.stringify(x.byMode) !== JSON.stringify(first.byMode)) throw new Error(`${x.path}: hermetic metrics differ from ${first.path}`);
  }
  const rows = all.flatMap(x => x.rows);
  const models = [...new Set(all.flatMap(x => x.models))];
  const counted = models.filter(m => (COUNTED_MODELS as readonly string[]).includes(m));
  return {
    gbrain_commit: first.commit, scenario_ledger: first.ledger, receipts: paths, models, counted_models: counted,
    usd: Number(all.reduce((s, x) => s + x.usd, 0).toFixed(4)),
    cells: aggregateModelRows(rows),
    defaults_decision: decideDefaults(first.byMode, rows, counted),
    hermetic_default: first.byMode.default, hermetic_by_mode: first.byMode,
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const outAt = argv.indexOf('--out');
  const paths = argv.filter((_, i) => outAt < 0 || (i !== outAt && i !== outAt + 1));
  const joined = joinCat37(paths);
  const text = JSON.stringify(joined, null, 1) + '\n';
  if (outAt >= 0) writeFileSync(argv[outAt + 1]!, text);
  console.log(JSON.stringify({ counted: joined.counted_models, usd: joined.usd, decision: joined.defaults_decision }, null, 1));
}
