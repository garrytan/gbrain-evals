/**
 * Keyless $0 re-score of an A4 S4-on receipt (G8): recomputes the S4-on and
 * S4-off metrics under the revised and frozen rules, the paired tests and the
 * threshold sweep from the stored per-question outcomes and S4 rows.
 *
 *   bun eval/runner/a4-s4-rescore.ts docs/benchmarks/2026-10-06-a4-s4-on/receipt.json
 */
import { readFileSync } from 'node:fs';
import { abstainsUsefully, armMetrics, s4OnOutcomes, s4PairedTests, type AnswerRow, type S4Row } from './a4-abstention.ts';

export function rescore(receipt: { data: { paid: { answers: AnswerRow[] }; s4_on: { rows: S4Row[] } } }) {
  const answers = receipt.data.paid.answers;
  const s4 = receipt.data.s4_on.rows;
  const off = armMetrics(answers.filter(a => a.arm === 'retrieved').map(a => ({ cls: a.cls, outcome: a.outcome_v2 ?? a.outcome })));
  const on = armMetrics(s4OnOutcomes(answers, s4, 'v2'));
  const onFrozen = armMetrics(s4OnOutcomes(answers, s4, 'v1'));
  const pick = (m: ReturnType<typeof armMetrics>) => ({ abstain_recall: m.abstain_recall, false_refusal_rate: m.false_refusal_rate, correct_useful_rate: m.correct_useful_rate, unanswerable_answer_rate: m.unanswerable_answer_rate, decision: abstainsUsefully(m) });
  return { s4_on_revised: pick(on), s4_off_revised: pick(off), s4_on_frozen_rule: pick(onFrozen), paired_vs_s4_off: s4PairedTests(answers, s4) };
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) { console.error('usage: bun eval/runner/a4-s4-rescore.ts <receipt.json>'); process.exit(2); }
  console.log(JSON.stringify(rescore(JSON.parse(readFileSync(path, 'utf8'))), null, 2));
}
