/**
 * The frozen skillopt-method datasets (GST-799): task sets, criteria texts and
 * seed skills, read by the n15 runner, the A1 probe and the audit.
 *
 *   eval/data/skillopt-method-<version>/<skill>/{train,sel,test}.jsonl   tasks
 *   eval/data/skillopt-method-<version>/<skill>/criteria.md              the criteria text every arm gets
 *   eval/data/skillopt-method-<version>/<skill>/generation-report.json   candidates, oracle and solvability drops
 *   eval/data/skillopt-method-<version>/seeds/<skill>/SKILL.md           the seed skill, verbatim from gbrain 3ec766c40
 *
 * v1 is what probe 1 ran on; it saturated (the seed and one rewrite reached
 * the ceiling), so v2 hardened the tasks once and is the default every reader
 * uses. v1 stays frozen and regenerable.
 *
 * The test split is sealed: only `readSealedTestTasks` reads it, and nothing
 * before a stage's final scoring calls that.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MethodTask } from '../../generators/skillopt-method/common.ts';
import type { SkillName } from './score.ts';

export const DATASET_VERSIONS = ['v1', 'v2'] as const;
export type DatasetVersion = typeof DATASET_VERSIONS[number];
/** The dataset the runner and the probe read. */
export const DEFAULT_DATASET: DatasetVersion = 'v2';

export const datasetName = (version: DatasetVersion) => `skillopt-method-${version}`;
export const datasetDir = (version: DatasetVersion = DEFAULT_DATASET) => join(import.meta.dir, '../../data', datasetName(version));
/** The default dataset's directory. */
export const DATA_DIR = datasetDir();

/** gbrain commit and version the seed skills were copied from. */
export const SEED_GBRAIN_COMMIT = '3ec766c40664b652b14e39788d177139f5a7b105';
export const SEED_GBRAIN_VERSION = '0.60.531.0';
/** sha256 of each seed SKILL.md at SEED_GBRAIN_COMMIT. */
export const SEED_SHA256: Readonly<Record<SkillName, string>> = {
  query: 'afe2a88394bb78bb651ebd5434415dfa1a96cbc3c52848e134be16b3e8d36f08',
  briefing: '551c2f308c27b8a0823e2dfbbcdf7e8ace78ff6498afaa3ac21da852c7cf0d16',
  'fact-check': '49f0d356eee44541eddbc9cd501dc36707d417d84ca10446c0d315321f259674',
};

export const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
export const seedPath = (skill: SkillName, version: DatasetVersion = DEFAULT_DATASET) => join(datasetDir(version), 'seeds', skill, 'SKILL.md');

/** The seed skill text; throws if the committed copy no longer matches its pinned sha256. */
export function readSeed(skill: SkillName, version: DatasetVersion = DEFAULT_DATASET): string {
  const text = readFileSync(seedPath(skill, version), 'utf8');
  if (sha256(text) !== SEED_SHA256[skill]) throw new Error(`seed ${skill} does not match its sha256 at gbrain ${SEED_GBRAIN_COMMIT.slice(0, 9)}`);
  return text;
}

export const readCriteria = (skill: SkillName, version: DatasetVersion = DEFAULT_DATASET) => readFileSync(join(datasetDir(version), skill, 'criteria.md'), 'utf8');

function readJsonl(skill: SkillName, split: string, version: DatasetVersion): MethodTask[] {
  return readFileSync(join(datasetDir(version), skill, `${split}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as MethodTask);
}

/** Train or selection tasks. The test split has its own reader. */
export function readTasks(skill: SkillName, split: 'train' | 'sel', version: DatasetVersion = DEFAULT_DATASET): MethodTask[] {
  if ((split as string) === 'test') throw new Error('the test split is sealed; use readSealedTestTasks at final scoring only');
  return readJsonl(skill, split, version);
}

/** The sealed test split, for a stage's final scoring only. */
export const readSealedTestTasks = (skill: SkillName, version: DatasetVersion = DEFAULT_DATASET) => readJsonl(skill, 'test', version);

/** A skill's frontmatter `tools:` list. */
export function frontmatterTools(skillText: string): string[] {
  const front = /^---\n([\s\S]*?)\n---/.exec(skillText)?.[1] ?? '';
  const block = /^tools:\s*\n((?:[ \t]+-[^\n]*\n?)*)/m.exec(front)?.[1] ?? '';
  return block.split('\n').map(l => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
}
