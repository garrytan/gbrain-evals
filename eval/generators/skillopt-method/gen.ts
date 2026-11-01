#!/usr/bin/env bun
/**
 * skillopt-method: generate and freeze the SkillOpt method task sets
 * (GST-799). v1 is probe 1's data; v2 hardened it once after probe 1
 * saturated and is the default (dataset.ts).
 *
 *   bun eval/generators/skillopt-method/gen.ts write [v1|v2]   # regenerates one version's task files and MANIFEST.json (default v2)
 *   bun eval/generators/skillopt-method/gen.ts check [v1|v2]   # exits 1 unless regeneration reproduces the committed
 *                                                              # files and every file matches MANIFEST.json (default: every version)
 *
 * `write` copies each seed skill only when it is missing and only if its
 * sha256 matches the pin in dataset.ts, from node_modules/gbrain or from
 * another version's committed copy. The manifest lists the sha256 and size of
 * every data file (task sets, criteria, generation reports, seeds); README.md
 * stays outside it so it can gain changelog entries. The frozen dataset hash
 * is the sha256 of MANIFEST.json.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { CRITERIA, CRITERIA_V2, SKILLS, SPLITS, type SkillName } from '../../runner/skillopt-method/score.ts';
import { DATA_DIR, DATASET_VERSIONS, DEFAULT_DATASET, datasetDir, SEED_SHA256, seedPath, sha256, type DatasetVersion } from '../../runner/skillopt-method/dataset.ts';
import { generateBriefing } from './briefing.ts';
import { generateBriefingV2 } from './briefing-v2.ts';
import { splitLeaks, type SkillGeneration } from './common.ts';
import { generateFactCheck } from './fact-check.ts';
import { generateFactCheckV2 } from './fact-check-v2.ts';
import { generateQuery } from './query.ts';
import { generateQueryV2 } from './query-v2.ts';

const GENERATORS: Record<DatasetVersion, Record<SkillName, () => SkillGeneration>> = {
  v1: { query: generateQuery, briefing: generateBriefing, 'fact-check': generateFactCheck },
  v2: { query: generateQueryV2, briefing: generateBriefingV2, 'fact-check': generateFactCheckV2 },
};
const CRITERIA_TEXTS: Record<DatasetVersion, Readonly<Record<SkillName, string>>> = { v1: CRITERIA, v2: CRITERIA_V2 };

/** Every generated file of one version, relative path to content. Seeds are copied, not generated. */
export function buildFiles(version: DatasetVersion = DEFAULT_DATASET): Map<string, string> {
  const files = new Map<string, string>();
  for (const skill of SKILLS) {
    const { tasks, report } = GENERATORS[version][skill]();
    const leaks = splitLeaks(tasks);
    if (leaks.length) throw new Error(`${version} ${skill}: ${leaks.join('; ')}`);
    for (const split of SPLITS) files.set(`${skill}/${split}.jsonl`, tasks.filter(t => t.split === split).map(t => JSON.stringify(t)).join('\n') + '\n');
    files.set(`${skill}/criteria.md`, CRITERIA_TEXTS[version][skill] + '\n');
    files.set(`${skill}/generation-report.json`, JSON.stringify(report, null, 2) + '\n');
  }
  return files;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir).sort()) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

export interface Manifest {
  dataset: string;
  hash_scheme: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
  counts: Record<string, Record<string, number>>;
  data_sha256: string;
}

/** The manifest of the dataset at `root`; its `dataset` field is the directory name. */
export function buildManifest(root = DATA_DIR): Manifest {
  const files = [...SKILLS, 'seeds'].flatMap(d => walk(join(root, d))).map(f => {
    const b = readFileSync(f);
    return { path: relative(root, f), sha256: sha256(b), bytes: b.length };
  });
  const lines = (p: string) => readFileSync(join(root, p), 'utf8').split('\n').filter(Boolean).length;
  return {
    dataset: basename(root),
    hash_scheme: 'sha256 of each file\'s bytes; data_sha256 is sha256 over "<sha256>  <path>\\n" lines in path order; the dataset hash is sha256 of this file',
    files,
    counts: Object.fromEntries(SKILLS.map(s => [s, Object.fromEntries(SPLITS.map(sp => [sp, lines(`${s}/${sp}.jsonl`)]))])),
    data_sha256: sha256(files.map(f => `${f.sha256}  ${f.path}\n`).join('')),
  };
}

/** Problems with a committed dataset against its manifest; empty when frozen and intact. */
export function checkManifest(root = DATA_DIR): string[] {
  const f = join(root, 'MANIFEST.json');
  if (!existsSync(f)) return ['MANIFEST.json is missing'];
  const want = JSON.parse(readFileSync(f, 'utf8')) as Manifest;
  const have = buildManifest(root);
  const byPath = new Map(have.files.map(x => [x.path, x]));
  const problems: string[] = [];
  for (const w of want.files) {
    const h = byPath.get(w.path);
    if (!h) problems.push(`missing: ${w.path}`);
    else if (h.sha256 !== w.sha256) problems.push(`changed: ${w.path}`);
  }
  const listed = new Set(want.files.map(x => x.path));
  for (const h of have.files) if (!listed.has(h.path)) problems.push(`not in manifest: ${h.path}`);
  if (!problems.length && have.data_sha256 !== want.data_sha256) problems.push('data_sha256 does not match the file list');
  return problems;
}

/** Files of one version whose committed bytes differ from a fresh generation. */
export function regenerationDiffs(version: DatasetVersion = DEFAULT_DATASET): string[] {
  const root = datasetDir(version);
  const out: string[] = [];
  for (const [path, content] of buildFiles(version)) {
    const full = join(root, path);
    if (!existsSync(full)) out.push(`${version} missing: ${path}`);
    else if (readFileSync(full, 'utf8') !== content) out.push(`${version} differs from a fresh generation: ${path}`);
  }
  return out;
}

/** Regeneration and manifest problems for one version, each prefixed with it. */
export function datasetProblems(version: DatasetVersion): string[] {
  return [...regenerationDiffs(version), ...checkManifest(datasetDir(version)).map(p => `${version} ${p}`)];
}

function copySeed(skill: SkillName, version: DatasetVersion): void {
  const sources = [join(import.meta.dir, '../../../node_modules/gbrain/skills', skill, 'SKILL.md'), ...DATASET_VERSIONS.filter(v => v !== version).map(v => seedPath(skill, v))];
  const from = sources.find(f => existsSync(f) && sha256(readFileSync(f)) === SEED_SHA256[skill]);
  if (!from) throw new Error(`no copy of the ${skill} seed matches its pin; seeds are frozen at gbrain 3ec766c40`);
  mkdirSync(dirname(seedPath(skill, version)), { recursive: true });
  copyFileSync(from, seedPath(skill, version));
}

function versionArg(arg: string | undefined): DatasetVersion | undefined {
  if (arg === undefined) return undefined;
  if (!(DATASET_VERSIONS as readonly string[]).includes(arg)) {
    console.error(`unknown dataset version ${arg} (have ${DATASET_VERSIONS.join(', ')})`);
    process.exit(2);
  }
  return arg as DatasetVersion;
}

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);
  const version = versionArg(arg);
  if (cmd === 'write') {
    const v = version ?? DEFAULT_DATASET;
    const root = datasetDir(v);
    for (const [path, content] of buildFiles(v)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    for (const skill of SKILLS) if (!existsSync(seedPath(skill, v))) copySeed(skill, v);
    const m = buildManifest(root);
    const text = JSON.stringify(m, null, 2) + '\n';
    writeFileSync(join(root, 'MANIFEST.json'), text);
    console.log(`${m.dataset}: files=${m.files.length} data_sha256=${m.data_sha256}\nMANIFEST.json sha256=${sha256(text)}`);
  } else if (cmd === 'check') {
    const versions = version ? [version] : [...DATASET_VERSIONS];
    const problems = versions.flatMap(datasetProblems);
    if (problems.length) {
      for (const x of problems.slice(0, 50)) console.log(`  ✗ ${x}`);
      console.log(`${problems.length} problem(s)`);
      process.exit(1);
    }
    for (const v of versions) console.log(`ok ${v}; MANIFEST.json sha256=${sha256(readFileSync(join(datasetDir(v), 'MANIFEST.json')))}`);
  } else {
    console.error('usage: gen.ts write|check [v1|v2]');
    process.exit(2);
  }
}
