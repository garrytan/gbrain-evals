#!/usr/bin/env bun
/**
 * Writes the predictive-validity reference files from published aggregates.
 *
 *   bun eval/runner/predictive/export-references.ts
 *
 * Reads only public aggregate scorecards already in the repo (live-recall
 * batches 1 and 2) and rewrites eval/data/validity-references/, including the
 * manifest's sha256 digests. References that do not exist yet are listed as
 * pending, so the verdict reads NO_REFERENCE_YET for them instead of failing.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Contrast, ManifestEntry, ReferenceFile } from './validity.ts';

const ROOT = resolve(import.meta.dir, '../../..');
export const REFERENCE_DIR = join(ROOT, 'eval/data/validity-references');
export const MANIFEST = join(REFERENCE_DIR, 'manifest.json');

interface Comparison { id: string; metric: string; delta: number; ci95: [number, number] }
type Arms = Record<string, { overall?: Record<string, { success_at?: { k5?: { rate?: number } } }> }>;

function liveRecall(id: string, source: string, file: string): ReferenceFile {
  const card = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
  const contrasts: Contrast[] = (card.comparisons as Comparison[])
    .filter((c) => c.metric === 'success_at_5')
    .map((c) => ({ id: c.id, estimate: c.delta, lo: c.ci95[0], hi: c.ci95[1] }));
  const orderings: Record<string, string[]> = {};
  const arms = card.arms as Arms;
  for (const form of ['exact', 'paraphrase']) {
    const scored = Object.entries(arms)
      .filter(([arm]) => arm !== 'configured_window')
      .map(([arm, row]) => [arm, row.overall?.[form]?.success_at?.k5?.rate] as const)
      .filter((pair): pair is readonly [string, number] => typeof pair[1] === 'number')
      .sort((a, b) => b[1] - a[1]);
    if (scored.length < 2) throw new Error(`${file} has no success@5 by arm for ${form}`);
    orderings[`arms_${form}`] = scored.map(([arm]) => arm);
  }
  return { id, source, contrasts, orderings };
}

export function buildReferences(): { files: Array<[string, ReferenceFile]>; pending: ManifestEntry[] } {
  return {
    files: [
      ['live-recall-b1.json', liveRecall('live-recall-b1', 'docs/benchmarks/2026-11-06-live-recall-batch1/attempt2-scorecard.json (dev reference)', 'docs/benchmarks/2026-11-06-live-recall-batch1/attempt2-scorecard.json')],
      ['live-recall-b2.json', liveRecall('live-recall-b2', 'docs/benchmarks/2026-11-07-live-recall-batch2/b2-593-scorecard.json (held out)', 'docs/benchmarks/2026-11-07-live-recall-batch2/b2-593-scorecard.json')],
    ],
    pending: [
      { id: 'live-recall-b3', file: 'live-recall-b3.json', status: 'pending' },
      { id: 'phase2-agent', file: 'phase2-agent.json', status: 'pending' },
      { id: 'miss-log-weekly', file: 'miss-log-weekly.json', status: 'pending' },
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
