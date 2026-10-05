/**
 * Offline checks every workload suite must pass before any paid cell:
 *
 *   schema        every record matches eval/schemas/workload-suite.schema.json;
 *   presence      every needle (the text a question depends on) is in the
 *                 named document of the asking user, and every gold and
 *                 oracle document exists;
 *   solvability   with the stub reader, the oracle memory (gold documents
 *                 only) answers every question, the full history answers
 *                 every question (distractors never make it ambiguous), and
 *                 no memory answers none except questions whose correct
 *                 answer is "none";
 *   corrections   the schedule driver, with the reference memory, answers
 *                 every probe on every arm; with no memory answers none; and
 *                 when corrections are ignored every post-correction probe
 *                 is scored stale.
 *
 * Failures name the seed and the query or item id so they can be reproduced.
 * `storePresenceFailures` is the same presence assertion against a real
 * system's store, for the harness lane to call after ingest and before the
 * first question.
 */
import { renderContext } from './common.ts';
import { CORRECTION_ARMS, ReferenceCorrectionMemory, correctionStubAnswer, runCorrectionArm, type CorrectionItem, type UnrelatedWrite } from './corrections.ts';
import { schemaErrors } from './schema-check.ts';
import type { HarnessDocument, Needle, SuiteBundle, SuiteDefinition } from './types.ts';

export interface ArmTally { n: number; correct: number; failures: string[] }
export interface CheckReport {
  suite: string;
  seed: number;
  smoke: boolean;
  verdict: 'pass' | 'fail';
  schema: { records: number; failures: string[] };
  presence: { needles: number; failures: string[] };
  solvability: {
    oracle: ArmTally;
    full_history: ArmTally | null;
    no_memory: ArmTally & { negatives: number };
  };
  corrections: null | {
    arms: Record<string, { pre: number; after_1: number; after_5: number; n_items: number }>;
    no_memory_correct: number;
    ignore_corrections_stale: number;
    probes_per_checkpoint: number;
    failures: string[];
  };
}

const LIMIT = 20;
const push = (list: string[], msg: string) => { if (list.length < LIMIT) list.push(msg); else if (list.length === LIMIT) list.push('... (more failures truncated)'); };

/** Every document a suite can deliver: base documents plus corrections, edits and writes. */
export function allDocuments(bundle: SuiteBundle): Map<string, HarnessDocument> {
  const docs = new Map(bundle.documents.map(d => [d.id, d]));
  for (const item of (bundle.extra.corrections as CorrectionItem[] | undefined) ?? []) docs.set(item.correction_document.id, item.correction_document);
  for (const w of (bundle.extra.writes as UnrelatedWrite[] | undefined) ?? []) docs.set(w.document.id, w.document);
  return docs;
}

export function checkSchema(bundle: SuiteBundle): CheckReport['schema'] {
  const failures: string[] = [];
  let records = 0;
  const run = (value: unknown, def: string, id: string) => { records++; for (const e of schemaErrors(value, def)) push(failures, `${bundle.suite} seed ${bundle.seed} ${id}: ${e}`); };
  for (const d of bundle.documents) run(d, 'document', d.id);
  for (const q of bundle.queries) run(q, 'query', q.id);
  for (const l of bundle.labels) run(l, 'scorer_label', l.query_id);
  for (const op of (bundle.extra.schedule as unknown[] | undefined) ?? []) run(op, 'schedule_op', `schedule ${(op as { seq: number }).seq}`);
  for (const item of (bundle.extra.corrections as CorrectionItem[] | undefined) ?? []) {
    run(item.edited_document, 'document', item.item_id);
    run(item.correction_document, 'document', item.item_id);
  }
  for (const w of (bundle.extra.writes as UnrelatedWrite[] | undefined) ?? []) run(w.document, 'document', w.document.id);
  return { records, failures };
}

export function checkPresence(bundle: SuiteBundle): CheckReport['presence'] {
  const docs = allDocuments(bundle);
  const queries = new Map(bundle.queries.map(q => [q.id, q]));
  const failures: string[] = [];
  let needles = 0;
  if (queries.size !== bundle.queries.length) push(failures, `${bundle.suite} seed ${bundle.seed}: duplicate query ids`);
  if (new Set(bundle.documents.map(d => d.id)).size !== bundle.documents.length) push(failures, `${bundle.suite} seed ${bundle.seed}: duplicate document ids`);
  for (const l of bundle.labels) {
    const q = queries.get(l.query_id);
    const where = `${bundle.suite} seed ${bundle.seed} query ${l.query_id}`;
    if (!q) { push(failures, `${where}: label has no query`); continue; }
    for (const id of [...q.gold_ids, ...l.oracle_doc_ids]) {
      const d = docs.get(id);
      if (!d) push(failures, `${where}: document ${id} does not exist`);
      else if (d.user_id !== q.user_id) push(failures, `${where}: document ${id} belongs to another user`);
    }
    for (const n of l.needles) {
      needles++;
      const d = docs.get(n.doc_id);
      if (!d || d.user_id !== q.user_id || !d.content.includes(n.text) || !d.content.includes(n.value)) push(failures, `${where}: needle "${n.text.slice(0, 60)}" is not in document ${n.doc_id}`);
    }
  }
  return { needles, failures };
}

export function checkSolvability(bundle: SuiteBundle, suite: SuiteDefinition): CheckReport['solvability'] {
  const docs = allDocuments(bundle);
  const queries = new Map(bundle.queries.map(q => [q.id, q]));
  const fullContext = new Map<string, string>();
  if (bundle.suite !== 'corrections') {
    const byUser = new Map<string, HarnessDocument[]>();
    for (const d of bundle.documents) byUser.set(d.user_id, [...(byUser.get(d.user_id) ?? []), d]);
    for (const [u, ds] of byUser) fullContext.set(u, renderContext(ds));
  }
  const oracle: ArmTally = { n: 0, correct: 0, failures: [] };
  const full: ArmTally = { n: 0, correct: 0, failures: [] };
  const none: ArmTally & { negatives: number } = { n: 0, correct: 0, failures: [], negatives: 0 };
  for (const l of bundle.labels) {
    const q = queries.get(l.query_id)!;
    const where = `${bundle.suite} seed ${bundle.seed} query ${l.query_id}`;
    const tally = (t: ArmTally, context: string, arm: string, expectCorrect: boolean) => {
      t.n++;
      const answer = suite.stubAnswer(l, context);
      const { outcome } = suite.score(l, answer);
      if (outcome === 'correct') t.correct++;
      if ((outcome === 'correct') !== expectCorrect) push(t.failures, `${where} (${arm}): stub answered "${answer.slice(0, 80)}" -> ${outcome}`);
    };
    tally(oracle, renderContext(l.oracle_doc_ids.map(id => docs.get(id)!)), 'oracle', true);
    if (fullContext.size) tally(full, fullContext.get(q.user_id)!, 'full history', true);
    if (l.negative) { none.negatives++; tally(none, '', 'no memory', true); } else tally(none, '', 'no memory', false);
  }
  return { oracle, full_history: fullContext.size ? full : null, no_memory: none };
}

export async function checkCorrections(bundle: SuiteBundle): Promise<CheckReport['corrections']> {
  if (bundle.suite !== 'corrections') return null;
  const reader = async (label: Parameters<typeof correctionStubAnswer>[0], _q: unknown, context: string) => correctionStubAnswer(label, context);
  const failures: string[] = [];
  const arms: NonNullable<CheckReport['corrections']>['arms'] = {};
  const items = (bundle.extra.corrections as CorrectionItem[]).length;
  for (const arm of CORRECTION_ARMS) {
    const r = await runCorrectionArm(new ReferenceCorrectionMemory('faithful'), arm, bundle, reader);
    const m = r.metrics!;
    arms[arm.id] = { pre: m.pre_correction_recall.correct, after_1: m.after_1_write.correct, after_5: m.after_5_writes.correct, n_items: items };
    for (const p of r.probes) if (p.outcome !== 'correct') push(failures, `corrections seed ${bundle.seed} arm ${arm.id} item ${p.item_id} checkpoint ${p.checkpoint}: reference memory answered "${p.answer}" -> ${p.outcome}`);
  }
  const arm = CORRECTION_ARMS[0]!;
  const empty = await runCorrectionArm(new ReferenceCorrectionMemory('no-memory'), arm, bundle, reader);
  const ignored = await runCorrectionArm(new ReferenceCorrectionMemory('ignore-corrections'), arm, bundle, reader);
  const noMemoryCorrect = empty.probes.filter(p => p.outcome === 'correct').length;
  const stale = ignored.probes.filter(p => p.checkpoint !== 0 && p.outcome === 'stale').length;
  if (noMemoryCorrect) push(failures, `corrections seed ${bundle.seed}: ${noMemoryCorrect} probes answered correctly with no memory`);
  if (stale !== 2 * items) push(failures, `corrections seed ${bundle.seed}: only ${stale} of ${2 * items} post-correction probes scored stale when corrections were ignored`);
  return { arms, no_memory_correct: noMemoryCorrect, ignore_corrections_stale: stale, probes_per_checkpoint: items, failures };
}

export async function runChecks(bundle: SuiteBundle, suite: SuiteDefinition): Promise<CheckReport> {
  const schema = checkSchema(bundle);
  const presence = checkPresence(bundle);
  const solvability = checkSolvability(bundle, suite);
  const corrections = await checkCorrections(bundle);
  const failed = schema.failures.length + presence.failures.length + solvability.oracle.failures.length
    + (solvability.full_history?.failures.length ?? 0) + solvability.no_memory.failures.length + (corrections?.failures.length ?? 0);
  return { suite: bundle.suite, seed: bundle.seed, smoke: bundle.smoke, verdict: failed ? 'fail' : 'pass', schema, presence, solvability, corrections };
}

/**
 * Presence against a system's store, after ingest and before any question:
 * `stored(user, needle)` reports whether the store holds the needle's value
 * in a record for that user (raw chunk, page or extracted fact, per lane).
 * A failure makes the cell an error, not a scored miss.
 */
export async function storePresenceFailures(bundle: SuiteBundle, stored: (userId: string, needle: Needle) => Promise<boolean>, checkpointZeroOnly = true): Promise<string[]> {
  const queries = new Map(bundle.queries.map(q => [q.id, q]));
  const failures: string[] = [];
  for (const l of bundle.labels) {
    const q = queries.get(l.query_id)!;
    if (checkpointZeroOnly && bundle.suite === 'corrections' && q.meta.checkpoint !== 0) continue;
    for (const n of l.needles) if (!(await stored(q.user_id, n))) failures.push(`${bundle.suite} seed ${bundle.seed} query ${l.query_id}: "${n.value}" is not in the store for user ${q.user_id}`);
  }
  return failures;
}
