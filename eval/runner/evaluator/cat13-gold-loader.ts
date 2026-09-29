/**
 * Separate Cat13 gold loader. It reads the corpus from disk itself, so the
 * page objects the gold is derived from are never the objects the runner
 * sanitizes for the system under test, and derives the graded labels with
 * the benchmark's own generator.
 */
import { buildProbes, loadCorpus, PROBE_SEED } from '../cat13-conceptual.ts';
import { cat13GoldFromProbes, type Cat13Gold } from './cat13.ts';
import type { GoldStore } from './gold-store.ts';

export function loadCat13Gold(corpusDir: string, targetProbes: number, seed: number = PROBE_SEED): GoldStore<Cat13Gold> {
  const { probes, gradesByQuery } = buildProbes(loadCorpus(corpusDir), targetProbes, seed);
  return cat13GoldFromProbes(probes, gradesByQuery);
}
