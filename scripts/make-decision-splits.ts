/**
 * Writes eval/decisions/splits/*.json from conversation ids only (no system
 * output, no labels). Rerunning reproduces the committed files byte for byte
 * except `created_at`; a changed split is a reviewed change, never a rerun.
 *
 *   bun scripts/make-decision-splits.ts [--check]
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { computeSplit, SPLITS_DIR, type SplitFile } from '../eval/runner/decisions/splits.ts';
import { beamManifest, LME_S_FILE, LOCOMO_FILE, readDatasetFile } from '../eval/runner/memory-qa/corpus.ts';
import { buildRelationalQueries, loadWorldCorpus } from '../eval/runner/queries/relational.ts';

const check = process.argv.includes('--check');
const files: SplitFile[] = [];
const locomo = JSON.parse(readDatasetFile(LOCOMO_FILE, 'locomo')) as Array<{ sample_id: string }>;
files.push(computeSplit('locomo', locomo.map(s => s.sample_id), 0.3,
  'Split before any system ran on LoCoMo. 7 sealed conversations are fewer than the comparator default of 10 clusters, so the sealed split is diagnostic evidence, never a primary confirmation.'));
const lme = JSON.parse(readDatasetFile(LME_S_FILE, 'lme-s')) as Array<{ question_id: string }>;
files.push(computeSplit('lme-s', lme.map(q => q.question_id), 1,
  'All development data: the release configuration was chosen on these questions (10x plan amendment 1), so no held-out split exists.'));
const beam = beamManifest();
for (const size of ['100k', '500k', '1m']) {
  files.push(computeSplit(`beam-${size}`, beam.sizes[size].map(c => c.conversation), 0.3,
    'Split before any system ran on BEAM; sealed conversations are supporting evidence at decisions and report aggregates until retired.'));
}
const world = buildRelationalQueries(loadWorldCorpus(join(import.meta.dir, '../eval/data/world-v1')));
files.push(computeSplit('world-v1-relational', world.map(t => t.id), 0.5,
  'Question-level split of the world-v1 relational templates (each paraphrase follows its template). One shared world, so this separates questions, not pages: dev questions may be used to train or tune, sealed questions are scored once at a decision.'));
let drift = 0;
for (const f of files) {
  const path = join(SPLITS_DIR, `${f.benchmark}.json`);
  if (existsSync(path)) {
    const old = JSON.parse(readFileSync(path, 'utf8')) as SplitFile;
    if (JSON.stringify(old.dev) !== JSON.stringify(f.dev) || JSON.stringify(old.sealed) !== JSON.stringify(f.sealed)) {
      drift++;
      process.stderr.write(`${path}: computed split differs from the committed one\n`);
    }
    if (check) continue;
    f.created_at = old.created_at;
  }
  if (!check) writeFileSync(path, JSON.stringify(f, null, 2) + '\n');
  process.stdout.write(`${f.benchmark}: dev ${f.dev.length}, sealed ${f.sealed.length}\n`);
}
process.exit(check && drift ? 1 : 0);
