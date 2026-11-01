#!/usr/bin/env bun
/**
 * skillopt-method-v1: generate and freeze the SkillOpt method task sets
 * (GST-799, plan Phase 1).
 *
 *   bun eval/generators/skillopt-method/gen.ts write   # regenerates the task files and MANIFEST.json
 *   bun eval/generators/skillopt-method/gen.ts check   # exits 1 unless regeneration reproduces the
 *                                                      # committed files and every file matches MANIFEST.json
 *
 * `write` copies each seed skill from node_modules/gbrain only when it is
 * missing and only if its sha256 matches the pin in dataset.ts. The manifest
 * lists the sha256 and size of every data file (task sets, criteria,
 * generation reports, seeds); README.md stays outside it so it can gain
 * changelog entries. The frozen dataset hash is the sha256 of MANIFEST.json.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { CRITERIA, SKILLS, SPLITS, type SkillName } from '../../runner/skillopt-method/score.ts';
import { DATA_DIR, SEED_SHA256, seedPath, sha256 } from '../../runner/skillopt-method/dataset.ts';
import { generateBriefing } from './briefing.ts';
import { splitLeaks, type SkillGeneration } from './common.ts';
import { generateFactCheck } from './fact-check.ts';
import { generateQuery } from './query.ts';

const GENERATORS: Record<SkillName, () => SkillGeneration> = { query: generateQuery, briefing: generateBriefing, 'fact-check': generateFactCheck };

/** Every generated file, relative path to content. Seeds are copied, not generated. */
export function buildFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const skill of SKILLS) {
    const { tasks, report } = GENERATORS[skill]();
    const leaks = splitLeaks(tasks);
    if (leaks.length) throw new Error(`${skill}: ${leaks.join('; ')}`);
    for (const split of SPLITS) files.set(`${skill}/${split}.jsonl`, tasks.filter(t => t.split === split).map(t => JSON.stringify(t)).join('\n') + '\n');
    files.set(`${skill}/criteria.md`, CRITERIA[skill] + '\n');
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
  dataset: 'skillopt-method-v1';
  hash_scheme: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
  counts: Record<string, Record<string, number>>;
  data_sha256: string;
}

export function buildManifest(root = DATA_DIR): Manifest {
  const files = [...SKILLS, 'seeds'].flatMap(d => walk(join(root, d))).map(f => {
    const b = readFileSync(f);
    return { path: relative(root, f), sha256: sha256(b), bytes: b.length };
  });
  const lines = (p: string) => readFileSync(join(root, p), 'utf8').split('\n').filter(Boolean).length;
  return {
    dataset: 'skillopt-method-v1',
    hash_scheme: 'sha256 of each file\'s bytes; data_sha256 is sha256 over "<sha256>  <path>\\n" lines in path order; the dataset hash is sha256 of this file',
    files,
    counts: Object.fromEntries(SKILLS.map(s => [s, Object.fromEntries(SPLITS.map(sp => [sp, lines(`${s}/${sp}.jsonl`)]))])),
    data_sha256: sha256(files.map(f => `${f.sha256}  ${f.path}\n`).join('')),
  };
}

/** Problems with the committed dataset against its manifest; empty when frozen and intact. */
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

/** Files whose committed bytes differ from a fresh generation. */
export function regenerationDiffs(root = DATA_DIR): string[] {
  const out: string[] = [];
  for (const [path, content] of buildFiles()) {
    const full = join(root, path);
    if (!existsSync(full)) out.push(`missing: ${path}`);
    else if (readFileSync(full, 'utf8') !== content) out.push(`differs from a fresh generation: ${path}`);
  }
  return out;
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === 'write') {
    for (const [path, content] of buildFiles()) {
      mkdirSync(dirname(join(DATA_DIR, path)), { recursive: true });
      writeFileSync(join(DATA_DIR, path), content);
    }
    for (const skill of SKILLS) {
      if (existsSync(seedPath(skill))) continue;
      const from = join(import.meta.dir, '../../../node_modules/gbrain/skills', skill, 'SKILL.md');
      if (sha256(readFileSync(from)) !== SEED_SHA256[skill]) throw new Error(`node_modules/gbrain ${skill} seed is not the pinned one; seeds are frozen at gbrain 3ec766c40`);
      mkdirSync(dirname(seedPath(skill)), { recursive: true });
      copyFileSync(from, seedPath(skill));
    }
    const m = buildManifest();
    const text = JSON.stringify(m, null, 2) + '\n';
    writeFileSync(join(DATA_DIR, 'MANIFEST.json'), text);
    console.log(`files=${m.files.length} data_sha256=${m.data_sha256}\nMANIFEST.json sha256=${sha256(text)}`);
  } else if (cmd === 'check') {
    const problems = [...regenerationDiffs(), ...checkManifest()];
    if (problems.length) {
      for (const x of problems.slice(0, 50)) console.log(`  ✗ ${x}`);
      console.log(`${problems.length} problem(s)`);
      process.exit(1);
    }
    console.log(`ok; MANIFEST.json sha256=${sha256(readFileSync(join(DATA_DIR, 'MANIFEST.json')))}`);
  } else {
    console.error('usage: gen.ts write|check');
    process.exit(2);
  }
}
