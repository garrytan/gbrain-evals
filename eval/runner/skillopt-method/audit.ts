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
 * Any of these disqualifies the skill from the preregistered bar; the report
 * lists it. Single-word names (Acme, Delta, Pulse) are listed as
 * `entity-single-word` for review but do not disqualify alone, because they
 * are ordinary words too. The test split is not read: an optimizer never saw
 * it, so its gold cannot be pasted.
 *
 * Usage: bun eval/runner/skillopt-method/audit.ts <skill> <frozen SKILL.md>   # exits 1 when disqualified
 */
import { readFileSync } from 'node:fs';
import { accountNames, loadCorpora } from '../../generators/skillopt-method/common.ts';
import { readSeed, readTasks } from './dataset.ts';
import { citedSlugs, SKILLS, valuePattern, type GoldValue, type SkillName } from './score.ts';

export type AuditFlagKind = 'slug' | 'entity' | 'entity-single-word' | 'gold-value' | 'date';
export interface AuditFlag { kind: AuditFlagKind; token: string; line: string }
export interface AuditResult { skill: SkillName; added_lines: number; removed_lines: number; flags: AuditFlag[]; disqualified: boolean }

const DISQUALIFYING: ReadonlySet<AuditFlagKind> = new Set(['slug', 'entity', 'gold-value', 'date']);
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

let vocabulary: { names: string[]; values: Map<SkillName, GoldValue[]> } | null = null;

function vocab() {
  if (vocabulary) return vocabulary;
  const corpus = loadCorpora();
  const names = [...new Set([...accountNames().values(), ...[...corpus.world.values()].filter(p => p.type === 'person' || p.type === 'company').map(p => p.title)])];
  const values = new Map(SKILLS.map(s => {
    const tasks = [...readTasks(s, 'train'), ...readTasks(s, 'sel')];
    const all = tasks.flatMap(t => [...t.gold.values, ...t.distractors.values]).filter(v => v.kind !== 'name' && !(v.kind === 'number' && !v.unit && v.value < 100) && !(v.kind === 'number' && v.unit === 'days' && v.value < 100));
    const seen = new Set<string>();
    return [s, all.filter(v => { const k = JSON.stringify(v); return !seen.has(k) && !!seen.add(k); })] as const;
  }));
  vocabulary = { names, values };
  return vocabulary;
}

/** Diff a frozen skill against its seed and flag corpus-specific tokens in the added lines. */
export function auditSkill(skill: SkillName, frozen: string, seed: string = readSeed(skill)): AuditResult {
  const added = unmatchedLines(frozen, seed);
  const removed = unmatchedLines(seed, frozen);
  const { names, values } = vocab();
  const pages = loadCorpora().pages;
  const flags: AuditFlag[] = [];
  const flag = (kind: AuditFlagKind, token: string, line: string) => {
    if (!flags.some(f => f.kind === kind && f.token === token)) flags.push({ kind, token, line });
  };
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
  const [skill, path] = process.argv.slice(2);
  if (!skill || !path || !(SKILLS as readonly string[]).includes(skill)) {
    console.error(`usage: audit.ts <${SKILLS.join('|')}> <frozen SKILL.md>`);
    process.exit(2);
  }
  const result = auditSkill(skill as SkillName, readFileSync(path, 'utf8'));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.disqualified ? 1 : 0);
}
