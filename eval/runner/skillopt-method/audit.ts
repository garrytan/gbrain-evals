/**
 * Frozen-skill audit for the SkillOpt method benchmark (GST-799, plan Phase 1).
 *
 * An optimizer that pastes what it saw in train into a skill can look like it
 * learned something. The audit diffs a frozen skill against its seed by line
 * and flags corpus-specific tokens in the lines the optimizer added:
 *
 *   slug       a page slug the rollout brain holds
 *   entity     a multi-word person, company or account name from either corpus
 *   gold-value a value a train or selection task's gold or distractors carry
 *              (numbers under 100 without a unit are skipped: "30 days" is a
 *              figure a generic skill can state)
 *   date       a calendar date with a year (ISO or written out)
 *
 * It also compares the frontmatter: a frozen skill whose `tools:` list
 * differs from the seed's is flagged `tools`, and one whose frontmatter
 * changes otherwise is flagged `frontmatter` (GBEV-30, plan section 2).
 *
 * The vocabulary is the dataset's own (dataset-context.ts): v3's world and v3's
 * train and selection gold for a v3 audit, the shared corpora and v2's (or
 * v1's) gold otherwise, cached per dataset hash.
 *
 * Any of these disqualifies the skill from the preregistered bar; the report
 * lists it. Single-word names (Acme, Delta, Pulse) are listed as
 * `entity-single-word` for review but do not disqualify alone, because they
 * are ordinary words too. The test split is not read: an optimizer never saw
 * it, so its gold cannot be pasted.
 *
 * Usage: bun eval/runner/skillopt-method/audit.ts <skill> <frozen SKILL.md> [v1|v2|v3]   # exits 1 when disqualified (default dataset v2)
 */
import { readFileSync } from 'node:fs';
import { DATASET_VERSIONS, DEFAULT_DATASET, frontmatter, frontmatterTools, readSeed, readTasks, type DatasetVersion } from './dataset.ts';
import { datasetContext } from './dataset-context.ts';
import { citedSlugs, SKILLS, valuePattern, type GoldValue, type SkillName } from './score.ts';

export type AuditFlagKind = 'slug' | 'entity' | 'entity-single-word' | 'gold-value' | 'date' | 'frontmatter' | 'tools';
export interface AuditFlag { kind: AuditFlagKind; token: string; line: string }
export interface AuditResult { skill: SkillName; added_lines: number; removed_lines: number; flags: AuditFlag[]; disqualified: boolean }

const DISQUALIFYING: ReadonlySet<AuditFlagKind> = new Set(['slug', 'entity', 'gold-value', 'date', 'frontmatter', 'tools']);
const DATE_RE = /\b(?:\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?,?\s+\d{4})\b/g;

/** Lines of `a` not matched one-for-one by a line of `b` (trimmed, blank lines ignored). */
function unmatchedLines(a: string, b: string): string[] {
  const pool = new Map<string, number>();
  for (const l of b.split('\n').map(x => x.trim()).filter(Boolean)) pool.set(l, (pool.get(l) ?? 0) + 1);
  const out: string[] = [];
  for (const l of a.split('\n').map(x => x.trim()).filter(Boolean)) {
    const n = pool.get(l) ?? 0;
    if (n > 0) pool.set(l, n - 1);
    else out.push(l);
  }
  return out;
}

const vocabularies = new Map<string, { names: readonly string[]; pages: ReadonlyMap<string, string>; values: Map<SkillName, GoldValue[]> }>();

function vocab(dataset: DatasetVersion) {
  const ctx = datasetContext(dataset);
  const key = `${ctx.root}\n${ctx.manifest_sha256}`;
  const hit = vocabularies.get(key);
  if (hit) return hit;
  const values = new Map(SKILLS.map(s => {
    const tasks = [...readTasks(s, 'train', dataset), ...readTasks(s, 'sel', dataset)];
    const all = tasks.flatMap(t => [...t.gold.values, ...t.distractors.values]).filter(v => v.kind !== 'name' && !(v.kind === 'number' && !v.unit && v.value < 100) && !(v.kind === 'number' && v.unit === 'days' && v.value < 100));
    const seen = new Set<string>();
    return [s, all.filter(v => { const k = JSON.stringify(v); return !seen.has(k) && !!seen.add(k); })] as const;
  }));
  const vocabulary = { names: ctx.names, pages: ctx.pages, values };
  vocabularies.set(key, vocabulary);
  return vocabulary;
}

const normalizedLines = (s: string) => s.split('\n').map(l => l.trim()).filter(Boolean).join('\n');

/** Diff a frozen skill against its seed, compare their frontmatter, and flag the dataset's tokens in the added lines. */
export function auditSkill(skill: SkillName, frozen: string, seed: string = readSeed(skill), dataset: DatasetVersion = DEFAULT_DATASET): AuditResult {
  const added = unmatchedLines(frozen, seed);
  const removed = unmatchedLines(seed, frozen);
  const { names, values, pages } = vocab(dataset);
  const flags: AuditFlag[] = [];
  const flag = (kind: AuditFlagKind, token: string, line: string) => {
    if (!flags.some(f => f.kind === kind && f.token === token)) flags.push({ kind, token, line });
  };
  const [tools, seedTools] = [frontmatterTools(frozen), frontmatterTools(seed)];
  if (tools.join('\n') !== seedTools.join('\n')) flag('tools', tools.join(', ') || '(none)', `tools: ${seedTools.join(', ')} -> ${tools.join(', ')}`);
  else if (normalizedLines(frontmatter(frozen)) !== normalizedLines(frontmatter(seed))) flag('frontmatter', 'frontmatter', unmatchedLines(frontmatter(frozen), frontmatter(seed))[0] ?? unmatchedLines(frontmatter(seed), frontmatter(frozen))[0] ?? '');
  for (const line of added) {
    for (const s of citedSlugs(line)) if (pages.has(s)) flag('slug', s, line);
    for (const name of names) {
      const re = new RegExp(`(?<![A-Za-z0-9])${name.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`);
      if (re.test(line)) flag(name.includes(' ') ? 'entity' : 'entity-single-word', name, line);
    }
    for (const v of values.get(skill) ?? []) if (new RegExp(valuePattern(v), 'm').test(line)) flag('gold-value', v.kind === 'number' ? `${v.value}${v.unit ? ' ' + v.unit : ''}` : v.value, line);
    for (const m of line.matchAll(DATE_RE)) flag('date', m[0], line);
  }
  return { skill, added_lines: added.length, removed_lines: removed.length, flags, disqualified: flags.some(f => DISQUALIFYING.has(f.kind)) };
}

if (import.meta.main) {
  const [skill, path, dataset = DEFAULT_DATASET] = process.argv.slice(2);
  if (!skill || !path || !(SKILLS as readonly string[]).includes(skill) || !(DATASET_VERSIONS as readonly string[]).includes(dataset)) {
    console.error(`usage: audit.ts <${SKILLS.join('|')}> <frozen SKILL.md> [${DATASET_VERSIONS.join('|')}]`);
    process.exit(2);
  }
  const version = dataset as DatasetVersion;
  const result = auditSkill(skill as SkillName, readFileSync(path, 'utf8'), readSeed(skill as SkillName, version), version);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.disqualified ? 1 : 0);
}
