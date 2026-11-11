#!/usr/bin/env bun
/**
 * Writes the predictive-validity reference files from published aggregates.
 *
 *   bun eval/runner/predictive/export-references.ts
 *
 * Reads only public aggregate scorecards already in the repo (live-recall
 * batches 1, 2 and 3) and rewrites eval/data/validity-references/, including the
 * manifest's sha256 digests. Each reference carries its success@5 contrasts (with
 * the simultaneous family band when the scorecard has one), the arm orderings and
 * the per-arm success@5 behind them, for tau-b. References that do not exist yet
 * are listed as pending, so the verdict reads NO_REFERENCE_YET for them instead
 * of failing. Batch 4 (G2's held-out replication) is read from a fixed path,
 * B4_SCORECARD, and listed as pending until a batch4 scorecard with a family
 * block is committed there, so its results add data and no code.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Contrast, ManifestEntry, ReferenceFile } from './validity.ts';

const ROOT = resolve(import.meta.dir, '../../..');
export const REFERENCE_DIR = join(ROOT, 'eval/data/validity-references');
export const MANIFEST = join(REFERENCE_DIR, 'manifest.json');
/** Where batch 4's counted scorecard is committed (predictive-measures amendment of 2026-11-11). */
export const B4_SCORECARD = 'docs/benchmarks/live-recall-batch4/b4-scorecard.json';

interface Comparison { id: string; metric?: string; delta: number; ci95: [number, number]; family_ci95?: [number, number] | null; skipped?: string }
type Arms = Record<string, { overall?: Record<string, { success_at?: { k5?: { rate?: number } } }> }>;

function liveRecall(id: string, source: string, file: string, root = ROOT): ReferenceFile {
  const card = JSON.parse(readFileSync(join(root, file), 'utf8'));
  const comparisons = card.comparisons as Comparison[];
  const contrasts: Contrast[] = comparisons
    .filter((c) => c.metric === 'success_at_5')
    .map((c) => ({ id: c.id, estimate: c.delta, lo: c.ci95[0], hi: c.ci95[1], ...(Array.isArray(c.family_ci95) ? { family_lo: c.family_ci95[0], family_hi: c.family_ci95[1] } : {}) }));
  const skipped = comparisons.filter((c) => c.skipped).map((c) => c.id);
  const orderings: Record<string, string[]> = {};
  const scores: Record<string, Record<string, number>> = {};
  const arms = card.arms as Arms;
  for (const form of ['exact', 'paraphrase']) {
    const scored = Object.entries(arms)
      .filter(([arm]) => arm !== 'configured_window')
      .map(([arm, row]) => [arm, row.overall?.[form]?.success_at?.k5?.rate] as const)
      .filter((pair): pair is readonly [string, number] => typeof pair[1] === 'number');
    if (scored.length < 2) throw new Error(`${file} has no success@5 by arm for ${form}`);
    orderings[`arms_${form}`] = [...scored].sort((a, b) => b[1] - a[1]).map(([arm]) => arm);
    scores[`arms_${form}`] = Object.fromEntries(scored);
  }
  return { id, source, contrasts, orderings, scores, ...(skipped.length ? { skipped } : {}) };
}

/** Batch 4's reference, once its counted scorecard is at B4_SCORECARD: refused unless it is a batch4 scorecard with a family block. */
function batch4(root: string): ReferenceFile | null {
  if (!existsSync(join(root, B4_SCORECARD))) return null;
  const card = JSON.parse(readFileSync(join(root, B4_SCORECARD), 'utf8'));
  if (card.protocol !== 'batch4' || !card.family || card.run?.control !== false) throw new Error(B4_SCORECARD + ' must be a counted batch4 scorecard with a family block');
  return liveRecall('live-recall-b4', B4_SCORECARD + ' (held out, G2 replication)', B4_SCORECARD, root);
}

export function buildReferences(root = ROOT): { files: Array<[string, ReferenceFile]>; pending: ManifestEntry[] } {
  const b4 = batch4(root);
  return {
    files: [
      ['live-recall-b1.json', liveRecall('live-recall-b1', 'docs/benchmarks/2026-11-06-live-recall-batch1/attempt2-scorecard.json (dev reference)', 'docs/benchmarks/2026-11-06-live-recall-batch1/attempt2-scorecard.json')],
      ['live-recall-b2.json', liveRecall('live-recall-b2', 'docs/benchmarks/2026-11-07-live-recall-batch2/b2-593-scorecard.json (held out)', 'docs/benchmarks/2026-11-07-live-recall-batch2/b2-593-scorecard.json')],
      ['live-recall-b3.json', liveRecall('live-recall-b3', 'docs/benchmarks/2026-11-10-live-recall-batch3/b3-641-scorecard.json (held out)', 'docs/benchmarks/2026-11-10-live-recall-batch3/b3-641-scorecard.json')],
      ...(b4 ? [['live-recall-b4.json', b4] as [string, ReferenceFile]] : []),
    ],
    pending: [
      ...(b4 ? [] : [{ id: 'live-recall-b4', file: 'live-recall-b4.json', status: 'pending' as const }]),
      { id: 'phase2-agent', file: 'phase2-agent.json', status: 'pending' },
      { id: 'miss-log-weekly', file: 'miss-log-weekly.json', status: 'pending' },
      { id: 'replay-pins', file: 'replay-pins.json', status: 'pending' },
      { id: 'latency-pins', file: 'latency-pins.json', status: 'pending' },
      { id: 'phase2-freeze-out-of-view', file: 'phase2-freeze-out-of-view.json', status: 'pending' },
    ],
  };
}

if (import.meta.main) {
  mkdirSync(REFERENCE_DIR, { recursive: true });
  const { files, pending } = buildReferences();
  const manifest: ManifestEntry[] = [];
  for (const [name, ref] of files) {
    const body = JSON.stringify(ref, null, 2) + '\n';
    writeFileSync(join(REFERENCE_DIR, name), body);
    manifest.push({ id: ref.id, file: name, sha256: createHash('sha256').update(body).digest('hex'), status: 'available' });
  }
  writeFileSync(MANIFEST, JSON.stringify([...manifest, ...pending], null, 2) + '\n');
  console.log(`wrote ${manifest.length} references and ${pending.length} pending entries to ${REFERENCE_DIR}`);
}
