/**
 * Aggregate delivery-time quote fence accounting from the Q1 staging logs. A retry replaces its prior row; the
 * latest valid realization of a conversation wins. No questions, retrieval text or IDs go into the summary.
 *
 *   bun eval/runner/bn10/fence-share.ts --root <public dry-run cell output> [--root <shard output>...] --out <file>
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { sha256 } from '../memory-qa/records.ts';
import { gatherStaging, latestBy, type StagedRetrieval } from '../q1/cell.ts';
import { generateBN10DryRunCells } from '../q1/cells/bn10.ts';
import { policyKey, type CellDefinition } from '../q1/cells/definitions.ts';
import { exitCodeOf, refuse, renderMessage, ScoreboardError } from '../q1/scoreboard-errors.ts';

const FRONT = ['bun', 'eval/runner/bn10/fence-share.ts'];
const BUDGET = 5500;
type Delivery = Pick<StagedRetrieval, 'outcome' | 'policy' | 'applied_settings'>;
interface FenceFields { delivered_rows: number; fenced_rows: number; unmatched_quoted_rows?: number; fence_tokens: number; budget_tokens: number; budget_share: number }
const isFence = (x: unknown): x is FenceFields => {
  if (!x || typeof x !== 'object') return false;
  const f = x as FenceFields;
  return [f.delivered_rows, f.fenced_rows, f.fence_tokens].every(n => Number.isSafeInteger(n) && n >= 0)
    && (f.unmatched_quoted_rows === undefined || (Number.isSafeInteger(f.unmatched_quoted_rows) && f.unmatched_quoted_rows >= 0))
    && f.fenced_rows <= f.delivered_rows && (f.fenced_rows > 0 || f.fence_tokens === 0)
    && f.budget_tokens === BUDGET && f.budget_share === f.fence_tokens / BUDGET;
};

export function aggregateFence(def: CellDefinition, deliveries: readonly Delivery[]) {
  return Object.fromEntries(def.arms.map(arm => {
    const policy = policyKey(arm);
    const contexts = deliveries.filter(d => d.policy === policy && (d.outcome === 'scored' || d.outcome === 'ingest_degraded'));
    const overlay = Object.entries(arm.retrieval!.overlay).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const overlayHash = sha256(JSON.stringify(Object.fromEntries(overlay)));
    const overlayMismatches = contexts.filter(d => d.applied_settings.overlay_sha256 !== overlayHash).length;
    const measurements = contexts.map(d => d.applied_settings.fence).filter(isFence);
    const mean = (key: 'delivered_rows' | 'fenced_rows' | 'fence_tokens') =>
      measurements.length ? measurements.reduce((s, f) => s + f[key], 0) / measurements.length : null;
    const tokens = mean('fence_tokens');
    return [arm.id, { delivered_contexts: contexts.length, measured_contexts: measurements.length,
      missing_measurements: contexts.length - measurements.length, overlay_mismatches: overlayMismatches,
      unmatched_quoted_rows: measurements.reduce((s, f) => s + (f.unmatched_quoted_rows ?? 0), 0),
      mean_delivered_rows: mean('delivered_rows'), mean_fenced_rows: mean('fenced_rows'), mean_fence_tokens: tokens,
      reference_budget_tokens: BUDGET, share_of_reference_budget: tokens === null ? null : tokens / BUDGET }];
  }));
}

export function measureFences(def: CellDefinition, roots: string[]) {
  const staging = gatherStaging(def.id, roots.filter(root => existsSync(join(root, 'runs', def.id))));
  return aggregateFence(def, [...staging.values()].flatMap(s =>
    [...latestBy<StagedRetrieval>(join(s.root, 'r', s.rid, 'retrievals.ndjson'), x => x.key).values()]));
}

if (import.meta.main) {
  const usage = [...FRONT, '--root', '<dry-run output>', '--out', '<file>'];
  try {
    const { values } = parseArgs({ options: { root: { type: 'string', multiple: true }, out: { type: 'string' } } });
    const dry = generateBN10DryRunCells()[0]!;
    if (!values.root?.length || !values.out || !values.root.every(path => existsSync(join(path, 'runs', dry.id)))) throw refuse({
      code: 'USAGE', message: 'give --root for each public BN10 dry-run cell output and --out for the aggregate file',
      why: 'the pilot checks fence accounting separately for P, A0 and whole', fix: { next: 'run', argv: usage },
    });
    writeFileSync(values.out, JSON.stringify({ schema: 'gbrain-evals/bn10-fence-share/v1', arms: measureFences(dry, values.root) }, null, 2) + '\n', { flag: 'wx' });
  } catch (e) {
    const op = e instanceof ScoreboardError ? e.op : { code: 'PREFLIGHT_FAILED' as const, message: 'could not write the dry-run fence summary',
      why: 'the pilot requires readable dry-run staging and a writable aggregate destination', fix: { next: 'run' as const, argv: usage } };
    console.error(renderMessage(op));
    process.exitCode = exitCodeOf(op);
  }
}
