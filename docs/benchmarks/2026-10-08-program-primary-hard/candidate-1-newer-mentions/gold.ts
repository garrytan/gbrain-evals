/**
 * The analysis gold (champion, correcting pages, stale-value patterns, session-1 commitment) for any T0b seeds, in the
 * shape of ../root-cause/gold.json, read from the generator. analyze.py uses it for the fresh-seed check.
 *
 *   bun docs/benchmarks/2026-10-08-program-primary-hard/candidate-1-newer-mentions/gold.ts <seed,seed,...> > gold-fresh.json
 */
import { DEFAULT_KNOBS, generateHardWorld } from '../../../../eval/generators/program-primary-hard-gen.ts';

const seeds = (process.argv[2] ?? '').split(',').filter(Boolean).map(Number);
const world = generateHardWorld(seeds, DEFAULT_KNOBS);
const gold: Record<string, unknown> = {};
for (const p of world.personas) for (const t of p.tasks) {
  const [moveId, callId, handoffId] = t.gold.correction_docs;
  const terms = t.gold.corrections.find(c => c.kind === 'terms')!;
  const sup = t.gold.corrections.find(c => c.kind === 'superseded')!;
  gold[t.id] = {
    persona: p.id, champion: t.contact_name, champion_slug: t.contact, company: t.company,
    docs: { contact: handoffId, date: moveId, terms: callId },
    stale: { contact: sup.stale, terms: terms.stale, date: t.gold.date.old },
    session1: t.session1, session1_commitment: t.gold.commitments.at(-1)!.label,
  };
}
console.log(JSON.stringify(gold, null, 1));
