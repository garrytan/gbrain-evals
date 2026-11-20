/**
 * An entity-scoped exposure check for BG1 (GST-2854), next to exposure.ts, which stays as it is.
 *
 * exposure.ts asks whether a delivered context states a question's gold values anywhere in its text. Outside S5 that
 * works, because the gold values are names, places and numbers. For a withdrawn slot (s5_withdrawn), the gold values
 * are generic words: none, nothing, called off, cancelled, not happening, no longer. Matching those anywhere in an
 * 8,000-token context misses a retraction phrased any other way ("walked away from the merger", "pulled out of the
 * pilot", "it turned out to be false", or a rewritten fact such as "is not running a pilot ... only a rumor"). It also
 * counts another entity's "cancelled". On the three public dev worlds it put S5 delivery at 67% to 83% for four rows,
 * where every one of the 96 contexts held the retraction.
 *
 * scopedExposure(q, contextText, { rawText, entity }) is exposure.ts's exposure() with its gold check replaced by
 * scopedGold; entity is the slot's entity name (slotEntity reads it from the world's plan). scopedGold counts a value
 * only in a sentence that names the slot's entity:
 *   s5_withdrawn  one sentence names the entity, the withdrawn value (the slot's stale value) and a withdrawal word
 *   ordered (s8)  every gold value appears in some sentence that names the entity
 *   otherwise     some sentence names the entity and a gold value
 * Sentences are split at line breaks and at . ! ? before a space; a possessive "'s" is dropped first, so "Halcyon
 * Freight's" names Halcyon Freight. A "Project X" entity is also named by "X". Values match with match.ts's normalised
 * whole-token matcher.
 *
 *   bun eval/runner/bg1/scoped-exposure.ts --worlds <dir> <contexts.ndjson>...
 *     <dir>/<world>/questions.json and plan.json name each question's slot and entity (the dev worlds' layout). Prints,
 *     per stratum, the share of contexts exposure.ts and scopedGold count as delivering the gold, and the questions
 *     where they disagree with the sentence scopedGold matched. Keyless.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryQuestion } from '../memory-qa/corpus.ts';
import { evidenceOf, exposure, type Exposure } from './exposure.ts';
import { findValues } from './match.ts';

/** Words that withdraw a plan or a report: match.ts's s5 gold forms and the other phrasings BG1 worlds and memory rows use. */
export const WITHDRAWAL_WORDS: readonly string[] = ['none', 'no one', 'nothing', 'called off', 'cancelled', 'canceled', 'cancellation', 'not happening',
  'no longer', 'rumour', 'rumor', 'false', 'ignore', 'disregard', 'fell through', 'not holding', 'not true', 'untrue', 'scrapped', 'withdrawn',
  'retracted', 'pulled out', 'walked away', 'backed out', 'is off'];

type Question = Pick<MemoryQuestion, 'id' | 'bg1'>;
const sentences = (text: string) => text.replace(/['\u2019]s\b/g, '').split(/\n+|(?<=[.!?])\s+/).filter(s => s.trim());
const names = (entity: string) => entity.startsWith('Project ') ? [entity, entity.slice('Project '.length)] : [entity];
const states = (text: string, values: readonly string[]) => values.length > 0 && findValues(text, { gold: values, stale: [], decoy: [] }).length > 0;

/** The sentence of a context that delivers the question's gold for its entity, or null. For an ordered question, the first sentence that names the entity and a gold value. */
export function scopedSentence(q: Question, context: string, entity: string): string | null {
  const f = q.bg1;
  if (!f) throw new Error(`question ${q.id} has no BG1 fields`);
  const about = sentences(context).filter(s => states(s, names(entity)));
  if (f.stratum === 's5_withdrawn') return about.find(s => states(s, WITHDRAWAL_WORDS) && (!f.stale_values.length || states(s, f.stale_values))) ?? null;
  if (f.ordered) return f.gold_values.every(v => about.some(s => states(s, [v]))) ? about.find(s => states(s, f.gold_values)) ?? null : null;
  return about.find(s => states(s, f.gold_values)) ?? null;
}

export function scopedGold(q: Question, context: string, entity: string): boolean {
  return scopedSentence(q, context, entity) !== null;
}

/** exposure.ts's exposure() with the gold check scoped to the slot's entity; stale and deciding_line are exposure.ts's own. */
export function scopedExposure(q: Question, contextText: string, opts: { rawText: boolean; entity: string }): Exposure {
  return { ...exposure(q, contextText, { rawText: opts.rawText }), gold: scopedGold(q, contextText, opts.entity) };
}

/** The entity a slot belongs to (`company-05.offsite` is company-05), named from the world's plan. */
export function slotEntity(plan: { entities: ReadonlyArray<{ id: string; name: string }> }, slot: string): string {
  const id = slot.slice(0, slot.indexOf('.'));
  const e = plan.entities.find(x => x.id === id);
  if (!e) throw new Error(`slot ${slot} names entity ${id}, which the plan does not list`);
  return e.name;
}

export interface Rescore { by_stratum: Record<string, { contexts: number; literal: number; scoped: number }>; disagreements: Array<{ question: string; literal: boolean; scoped: boolean; sentence: string | null }> }

/** Literal (exposure.ts) and scoped gold for each frozen context of known questions; contexts of other questions are skipped. */
export function rescore(contexts: Iterable<{ key: string; prompt: string }>, questions: ReadonlyMap<string, Question & { entity: string }>): Rescore {
  const out: Rescore = { by_stratum: {}, disagreements: [] };
  for (const c of contexts) {
    const q = questions.get(c.key.split('|')[1]);
    if (!q) continue;
    const text = evidenceOf(c.prompt);
    const literal = exposure(q, text, { rawText: false }).gold, sentence = scopedSentence(q, text, q.entity), scoped = sentence !== null;
    const s = (out.by_stratum[q.bg1!.stratum] ??= { contexts: 0, literal: 0, scoped: 0 });
    s.contexts++; s.literal += Number(literal); s.scoped += Number(scoped);
    if (literal !== scoped) out.disagreements.push({ question: q.id, literal, scoped, sentence });
  }
  return out;
}

/** Every question under <dir>/<world>/questions.json, with its entity from the world's plan.json. */
export function worldQuestions(dir: string, worlds: readonly string[]): Map<string, Question & { entity: string }> {
  const out = new Map<string, Question & { entity: string }>();
  for (const w of worlds) {
    const plan = JSON.parse(readFileSync(join(dir, w, 'plan.json'), 'utf8'));
    for (const q of JSON.parse(readFileSync(join(dir, w, 'questions.json'), 'utf8'))) out.set(q.id, { id: q.id, bg1: q.bg1, entity: slotEntity(plan, q.bg1.slot) });
  }
  return out;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--worlds');
  const dir = at >= 0 ? argv[at + 1] : undefined;
  const files = argv.filter((_, i) => i !== at && i !== at + 1);
  if (!dir || !files.length) { console.error('usage: bun eval/runner/bg1/scoped-exposure.ts --worlds <dir> <contexts.ndjson>...'); process.exit(2); }
  const { readdirSync } = await import('node:fs');
  const qs = worldQuestions(dir, readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort());
  const contexts = files.flatMap(f => readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { key: string; prompt: string }));
  const r = rescore(contexts, qs);
  const pct = (k: number, n: number) => `${(k / n * 100).toFixed(1)}%`;
  console.log('| Stratum | contexts | exposure.ts | scoped |\n|---|---:|---:|---:|');
  for (const [k, s] of Object.entries(r.by_stratum).sort()) console.log(`| ${k} | ${s.contexts} | ${pct(s.literal, s.contexts)} | ${pct(s.scoped, s.contexts)} |`);
  for (const d of r.disagreements) console.log(`${d.question}: exposure.ts ${d.literal}, scoped ${d.scoped}${d.sentence ? `: ${d.sentence.slice(0, 200)}` : ''}`);
}
