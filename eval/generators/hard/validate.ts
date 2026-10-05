/**
 * Structural and answer-key invariants every Hard world must satisfy,
 * whichever generator wrote it. The runner refuses a world that fails them.
 * Problems name only the family, the task index and counts, never document
 * content, so a held-out world can be checked without anyone reading it
 * (DX-F8).
 */
import { normalizeValue } from '../../runner/cat40/score.ts';
import { HARD_FAMILIES, H5_SESSIONS, knobDigest, type HardWorld } from './schema.ts';

export function hardWorldProblems(w: HardWorld): string[] {
  const problems: string[] = [];
  if (w.mode !== 'hard') problems.push('mode is not "hard"');
  if (typeof w.version !== 'string' || !w.version) problems.push('version is missing');
  if (w.knob_digest !== knobDigest(w.knobs)) problems.push('knob_digest does not match knobs');
  if (!Number.isInteger(w.max_turns) || w.max_turns < 1) problems.push('max_turns must be a positive integer');
  const ids = new Set<string>();
  let dupDocs = 0;
  for (const d of w.docs) { if (ids.has(d.id)) dupDocs++; ids.add(d.id); }
  if (dupDocs) problems.push(`${dupDocs} duplicate document ids`);
  const names = new Map<string, string>();
  let clashes = 0;
  for (const e of w.entities) for (const n of [e.name, ...e.aliases]) {
    const k = normalizeValue(n);
    if (names.has(k) && names.get(k) !== e.id) clashes++;
    names.set(k, e.id);
  }
  if (clashes) problems.push(`${clashes} names refer to more than one entity (the name namespace must be injective)`);
  const entityIds = new Set(w.entities.map(e => e.id));
  const taskIds = new Set<string>();
  const index = new Map<string, number>();
  for (const t of w.tasks) {
    const i = index.get(t.family) ?? 0;
    index.set(t.family, i + 1);
    const where = `${t.family} task index ${i}`;
    if (taskIds.has(t.id)) problems.push(`${where}: duplicate task id`);
    taskIds.add(t.id);
    if (!HARD_FAMILIES.includes(t.family) || !new RegExp(`^${t.family}-\\d{2}$`).test(t.id)) problems.push(`${where}: id must look like ${t.family}-01`);
    const missing = [...t.relevant, ...t.gold.evidence].filter(id => !ids.has(id)).length;
    if (missing) problems.push(`${where}: ${missing} referenced documents do not exist`);
    if (t.family === 'H5' ? t.sessions?.length !== H5_SESSIONS - 1 : t.sessions !== undefined) problems.push(`${where}: H5 tasks have ${H5_SESSIONS - 1} recording sessions; other families have none`);
    if (t.answer_kind === 'set') {
      if (!t.gold.members?.length || t.gold.members.some(m => !m.names.length)) problems.push(`${where}: a set task needs members with names`);
      if (t.gold.members?.some(m => !entityIds.has(m.id))) problems.push(`${where}: a member is not an entity`);
    } else if (t.answer_kind === 'count') {
      if (!Number.isInteger(t.gold.count) || t.gold.count! < 0) problems.push(`${where}: a count task needs a non-negative integer count`);
    } else {
      const acc = (t.gold.answer ?? []).map(normalizeValue), wrong = (t.gold.wrong ?? []).map(normalizeValue);
      if (!acc.length || acc.some(a => !a)) problems.push(`${where}: a value task needs accepted answers`);
      const all = [...acc, ...wrong];
      let overlaps = 0;
      for (let a = 0; a < all.length; a++) for (let b = 0; b < all.length; b++) if (a !== b && (all[a] === all[b] || all[a].includes(all[b])) && !(a < acc.length && b < acc.length)) overlaps++;
      if (overlaps) problems.push(`${where}: ${overlaps} accepted/wrong value pairs are equal or substrings of each other after normalization`);
      if (t.family !== 'H1' && !wrong.length) problems.push(`${where}: H2 to H5 tasks fill gold.wrong`);
    }
  }
  return problems;
}

export function assertHardWorld(w: HardWorld): void {
  const p = hardWorldProblems(w);
  if (p.length) throw new Error(`Hard world invariants failed (${p.length}): ${p.join('; ')}`);
}
