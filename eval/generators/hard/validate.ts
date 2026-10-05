/**
 * Structural and answer-key invariants every Hard world must satisfy,
 * whichever generator wrote it. The runner refuses a world that fails them.
 * Problems name only the family, the task index and counts, never document
 * content, so a held-out world can be checked without anyone reading it
 * (DX-F8).
 */
import { normalizeValue } from '../../runner/cat40/score.ts';
import { HARD_FAMILIES, H5_SESSIONS, knobDigest, type HardEntity, type HardWorld } from './schema.ts';
import { managerKnownOn, managerReadingsOn, managerReference, type ValueEvent } from './semantics.ts';

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
  return [...problems, ...referenceProblems(w)];
}

const managerEvents = (e: HardEntity): ValueEvent[] => (e.refs?.managers ?? []).map(m => ({ value: m.name, effective: m.effective, recorded: m.recorded, doc: m.doc, kind: 'change' }));
/** Names of an entity: its canonical name, former names and merged accounts' names (aliases that are neither codes nor nicknames). */
const nameStrings = (e: HardEntity) => [e.name, ...e.aliases.filter(a => !e.refs?.codes.includes(a) && !e.refs?.nicknames.includes(a))];

/**
 * Reference forms (generator v2, WORLD_SCHEMA.md "Reference forms"): every listed reference resolves to exactly one
 * entity using documents dated on or before it, a reference that is not by name does not name the account, and every
 * task's oracle documents tie each of their references to the entity's canonical name in at most two hops.
 */
function referenceProblems(w: HardWorld): string[] {
  if (!w.references) return (w.knobs.direct_name_share ?? 1) < 1 ? ['direct_name_share is below 1 but the world lists no references'] : [];
  const problems: string[] = [];
  const docs = new Map(w.docs.map(d => [d.id, d]));
  const entities = new Map(w.entities.map(e => [e.id, e]));
  if (w.entities.some(e => !e.refs)) problems.push(`${w.entities.filter(e => !e.refs).length} entities lack refs`);
  const textOf = (id: string) => { const d = docs.get(id)!; return `${d.title}\n${d.body}`; };
  const byDoc = new Map<string, typeof w.references>();
  for (const r of w.references) byDoc.set(r.doc, [...(byDoc.get(r.doc) ?? []), r]);
  const resolution = w.docs.filter(d => !byDoc.has(d.id));
  const index = new Map<string, Set<string>>();
  const words = (s: string) => s.split(/[^A-Za-z0-9]+/).filter(Boolean);
  for (const d of resolution) for (const x of words(`${d.title}\n${d.body}`)) { if (!index.has(x)) index.set(x, new Set()); index.get(x)!.add(d.id); }
  const containing = (needle: string) => {
    const lists = words(needle).map(x => index.get(x) ?? new Set<string>());
    const smallest = lists.reduce((a, b) => (b.size < a.size ? b : a), lists[0] ?? new Set<string>());
    return [...smallest].filter(id => textOf(id).includes(needle));
  };
  const byDescriptor = new Map<string, HardEntity[]>();
  for (const e of w.entities) if (e.refs) byDescriptor.set(e.refs.descriptor, [...(byDescriptor.get(e.refs.descriptor) ?? []), e]);
  const count: Record<string, number> = {};
  const bad = (what: string) => { count[what] = (count[what] ?? 0) + 1; };
  for (const r of w.references) {
    const d = docs.get(r.doc), e = entities.get(r.entity);
    if (!d || !e?.refs) { bad('point at a missing document or entity'); continue; }
    const body = textOf(r.doc), names = nameStrings(e);
    if (!body.includes(r.text)) bad('are not in their document');
    if (r.form === 'name') { if (!names.includes(r.text)) bad('by name use no name of their entity'); continue; }
    if (names.some(n => body.includes(n))) bad('not by name still name their account');
    if (r.form !== 'code' && e.refs.codes.some(c => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(body))) bad('by nickname or manager still give the account code');
    if (r.form === 'code' && !e.refs.codes.includes(r.text)) bad('by code use no code of their entity');
    if (r.form === 'nickname' && !e.refs.nicknames.includes(r.text)) bad('by nickname use no nickname of their entity');
    if (r.form === 'manager') {
      const m = managerKnownOn(managerEvents(e), d.date);
      if (!m || r.text !== managerReference(m, e.refs.descriptor)) bad('by manager do not name the manager known on their date');
      else if (byDescriptor.get(e.refs.descriptor)!.some(o => o !== e && managerReadingsOn(managerEvents(o), d.date).has(m))) bad('by manager fit more than one account on their date');
    }
    const needle = r.form === 'manager' ? `${e.refs.descriptor} account` : r.text;
    if (!containing(needle).some(id => docs.get(id)!.date <= d.date && names.some(n => textOf(id).includes(n)))) bad('are introduced by no resolution document dated on or before them');
  }
  for (const [what, n] of Object.entries(count)) problems.push(`${n} references ${what}`);
  const index2 = new Map<string, number>();
  for (const t of w.tasks) {
    const i = index2.get(t.family) ?? 0;
    index2.set(t.family, i + 1);
    const rel = t.relevant.filter(id => docs.has(id));
    const memo = new Map<string, string[]>();
    const inRel = (needle: string) => { if (!memo.has(needle)) memo.set(needle, rel.filter(id => textOf(id).includes(needle))); return memo.get(needle)!; };
    const relSet = new Set(rel);
    let untied = 0, timeline = 0;
    for (const id of rel) for (const r of byDoc.get(id) ?? []) {
      const e = entities.get(r.entity);
      if (!e?.refs || (r.form === 'name' && r.text === e.name)) continue;
      const names = nameStrings(e);
      const hop = (needles: string[]) => new Set(needles.flatMap(n => inRel(n).filter(x => x !== id)).flatMap(x => names.filter(n => textOf(x).includes(n))));
      const first = hop([r.form === 'manager' ? `${e.refs.descriptor} account` : r.text]);
      if (!first.has(e.name) && !hop([...first]).has(e.name)) untied++;
      if (r.form === 'manager' && e.refs.managers.some(m => m.recorded <= docs.get(id)!.date && !relSet.has(m.doc))) timeline++;
    }
    if (untied) problems.push(`${t.family} task index ${i}: ${untied} references in the oracle documents do not reach the account's name within two hops of other oracle documents`);
    if (timeline) problems.push(`${t.family} task index ${i}: ${timeline} manager references lack their manager timeline in the oracle documents`);
  }
  return problems;
}

export function assertHardWorld(w: HardWorld): void {
  const p = hardWorldProblems(w);
  if (p.length) throw new Error(`Hard world invariants failed (${p.length}): ${p.join('; ')}`);
}
