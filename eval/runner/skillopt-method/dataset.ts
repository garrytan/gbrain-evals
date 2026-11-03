/**
 * The frozen skillopt-method datasets (GST-799; v3 for GBEV-30): task sets,
 * criteria texts and seed skills, read by the n15 runner, the probes, the
 * headroom gate and the audit.
 *
 *   eval/data/skillopt-method-<version>/<skill>/<split>.jsonl            tasks, one file per split of the version
 *   eval/data/skillopt-method-<version>/<skill>/criteria.md              the criteria text every arm gets
 *   eval/data/skillopt-method-<version>/<skill>/generation-report.json   candidates, oracle and solvability drops
 *   eval/data/skillopt-method-<version>/seeds/<skill>/SKILL.md           the seed skill, verbatim from gbrain at its pin
 *   eval/data/skillopt-method-v3/<skill>/contract.md                     v3: the output contract appended to task prompts (contract.ts)
 *   eval/data/skillopt-method-v3/world/pages.jsonl                       v3: the rollout brain's pages (world-v3)
 *
 * v1 is what probe 1 ran on; it saturated (the seed and one rewrite reached
 * the ceiling), so v2 hardened the tasks once and is the default the N15 path
 * reads. v3 is the ceiling attempt's (GBEV-30, plan section 2): its own world,
 * held-out families and a gate split. Every reader names v3 explicitly; v1 and
 * v2 stay frozen and regenerable.
 *
 * Each version has its own split list, and its sealed splits have their own
 * reader: `readSealedTasks` (v1 and v2: test; v3: gate and test), which
 * nothing before a stage's sealed read calls.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MethodTask } from '../../generators/skillopt-method/common.ts';
import type { MethodTaskV3 } from '../../generators/skillopt-method/common-v3.ts';
import { SPLITS, type SkillName } from './score.ts';
import { SPLITS_V3 } from './score-v3.ts';

export const DATASET_VERSIONS = ['v1', 'v2', 'v3'] as const;
export type DatasetVersion = typeof DATASET_VERSIONS[number];
/** The versions over messy-company-v1 and world-v1 with train, sel and test splits. */
export const LEGACY_VERSIONS = ['v1', 'v2'] as const;
export type LegacyVersion = typeof LEGACY_VERSIONS[number];
/** The dataset the N15 runner and the probes read. */
export const DEFAULT_DATASET: LegacyVersion = 'v2';

/** Each version's splits, and the ones only `readSealedTasks` reads. */
export const DATASET_SPLITS: Readonly<Record<DatasetVersion, readonly string[]>> = { v1: SPLITS, v2: SPLITS, v3: SPLITS_V3 };
export const SEALED_SPLITS: Readonly<Record<DatasetVersion, readonly string[]>> = { v1: ['test'], v2: ['test'], v3: ['gate', 'test'] };

/** A version's task type: v3 adds the gate split, group ids, held-out flags and near-miss pages. */
export type TaskOf<V extends DatasetVersion> = V extends 'v3' ? MethodTaskV3 : MethodTask;

export const datasetName = (version: DatasetVersion) => `skillopt-method-${version}`;
export const datasetDir = (version: DatasetVersion = DEFAULT_DATASET) => join(import.meta.dir, '../../data', datasetName(version));
/** The default dataset's directory. */
export const DATA_DIR = datasetDir();

/** gbrain commit and version the v1 and v2 seed skills were copied from. */
export const SEED_GBRAIN_COMMIT = '3ec766c40664b652b14e39788d177139f5a7b105';
export const SEED_GBRAIN_VERSION = '0.60.531.0';
/** sha256 of each seed SKILL.md at SEED_GBRAIN_COMMIT. */
export const SEED_SHA256: Readonly<Record<SkillName, string>> = {
  query: 'afe2a88394bb78bb651ebd5434415dfa1a96cbc3c52848e134be16b3e8d36f08',
  briefing: '551c2f308c27b8a0823e2dfbbcdf7e8ace78ff6498afaa3ac21da852c7cf0d16',
  'fact-check': '49f0d356eee44541eddbc9cd501dc36707d417d84ca10446c0d315321f259674',
};

export interface SeedPin { commit: string; version: string; sha256: Readonly<Record<SkillName, string>> }
/**
 * Each version's seed pin. v3's seeds are the skills gbrain ships at
 * 311a83bbe (v0.60.553.0); the three files are byte-identical to v1's and
 * v2's, because none changed between 3ec766c40 and 311a83bbe.
 */
export const SEED_PINS: Readonly<Record<DatasetVersion, SeedPin>> = {
  v1: { commit: SEED_GBRAIN_COMMIT, version: SEED_GBRAIN_VERSION, sha256: SEED_SHA256 },
  v2: { commit: SEED_GBRAIN_COMMIT, version: SEED_GBRAIN_VERSION, sha256: SEED_SHA256 },
  v3: { commit: '311a83bbefb127118acb252fe827cb047126aa4d', version: '0.60.553.0', sha256: SEED_SHA256 },
};

export const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
export const seedPath = (skill: SkillName, version: DatasetVersion = DEFAULT_DATASET) => join(datasetDir(version), 'seeds', skill, 'SKILL.md');

/** The seed skill text; throws if the committed copy no longer matches its pinned sha256. */
export function readSeed(skill: SkillName, version: DatasetVersion = DEFAULT_DATASET): string {
  const text = readFileSync(seedPath(skill, version), 'utf8');
  const pin = SEED_PINS[version];
  if (sha256(text) !== pin.sha256[skill]) throw new Error(`seed ${skill} does not match its sha256 at gbrain ${pin.commit.slice(0, 9)}`);
  return text;
}

export const readCriteria = (skill: SkillName, version: DatasetVersion = DEFAULT_DATASET) => readFileSync(join(datasetDir(version), skill, 'criteria.md'), 'utf8');

function readJsonl<V extends DatasetVersion>(skill: SkillName, split: string, version: V): TaskOf<V>[] {
  if (!DATASET_SPLITS[version].includes(split)) throw new Error(`${datasetName(version)} has no ${split} split (have ${DATASET_SPLITS[version].join(', ')})`);
  return readFileSync(join(datasetDir(version), skill, `${split}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as TaskOf<V>);
}

/** Train or selection tasks. Sealed splits have their own reader. */
export function readTasks<V extends DatasetVersion = LegacyVersion>(skill: SkillName, split: 'train' | 'sel', version: V = DEFAULT_DATASET as V): TaskOf<V>[] {
  if (SEALED_SPLITS[version].includes(split)) throw new Error(`the ${split} split is sealed; use readSealedTasks at its stage's sealed read only`);
  return readJsonl(skill, split, version);
}

/** A sealed split (v1 and v2: test; v3: gate and test), for the stage that reads it only. */
export function readSealedTasks<V extends DatasetVersion>(skill: SkillName, split: 'gate' | 'test', version: V): TaskOf<V>[] {
  if (!SEALED_SPLITS[version].includes(split)) throw new Error(`${datasetName(version)} has no sealed ${split} split`);
  return readJsonl(skill, split, version);
}

/** The sealed test split of v1 or v2, for a stage's final scoring only. */
export const readSealedTestTasks = (skill: SkillName, version: LegacyVersion = DEFAULT_DATASET) => readSealedTasks(skill, 'test', version);

/** A skill's frontmatter block (between the opening `---` lines), or '' when it has none. */
export const frontmatter = (skillText: string) => /^---\n([\s\S]*?)\n---/.exec(skillText)?.[1] ?? '';

/** A skill's frontmatter `tools:` list. */
export function frontmatterTools(skillText: string): string[] {
  const block = /^tools:\s*\n((?:[ \t]+-[^\n]*\n?)*)/m.exec(frontmatter(skillText))?.[1] ?? '';
  return block.split('\n').map(l => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
}
