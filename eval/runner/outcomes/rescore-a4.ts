#!/usr/bin/env bun
/**
 * $0 rescoring of committed A4 receipts under outcome-v3 beside their frozen
 * scoreAnswerV2 outcomes (A10). The frozen outcomes are recomputed first and
 * must match the stored ones, so the comparison runs on identical inputs.
 *
 *   bun eval/runner/outcomes/rescore-a4.ts <receipt.json>...
 */
import { readFileSync } from 'node:fs';
import { generateA4World, isAnswerable } from '../../generators/a4-abstention-gen.ts';
import { scoreAnswerV2, type AnswerRow } from '../a4-abstention.ts';
import { axes, category, scoreA4V3, summarize, v2CategoryOf, type Category, type OutcomeAxes } from './v3.ts';

export function rescoreA4Receipt(receipt: { resolved_config: { seed: number }; data: { paid: { answers: AnswerRow[] } } }) {
  const world = generateA4World({ seed: receipt.resolved_config.seed }).ledger;
  const byId = new Map(world.questions.map(q => [q.id, q]));
  const out: Record<string, { v2: Record<Category, number>; v3: ReturnType<typeof summarize>; changed: Array<{ id: string; v2: Category; v3: Category; final: string }> }> = {};
  for (const arm of [...new Set(receipt.data.paid.answers.map(a => a.arm))]) {
    const v2: Record<Category, number> = { correct: 0, committed_wrong: 0, abstained: 0, execution_error: 0 };
    const rows: OutcomeAxes[] = [];
    const changed: Array<{ id: string; v2: Category; v3: Category; final: string }> = [];
    for (const a of receipt.data.paid.answers.filter(x => x.arm === arm)) {
      const q = byId.get(a.id)!;
      const answerable = isAnswerable(q.cls);
      if (a.outcome === 'error') {
        v2.execution_error++;
        rows.push(axes({ answerable, executionError: a.error ?? 'error' }));
        continue;
      }
      const frozen = scoreAnswerV2(q, a.final, world.values).outcome;
      if (a.outcome_v2 && frozen !== a.outcome_v2) throw new Error(`${a.id}/${arm}: scoreAnswerV2 gives ${frozen}, receipt stored ${a.outcome_v2}`);
      const c2 = v2CategoryOf(frozen, answerable);
      v2[c2]++;
      const r = scoreA4V3(q, a.final, world.values, answerable);
      rows.push(r);
      if (category(r) !== c2) changed.push({ id: a.id, v2: c2, v3: category(r), final: a.final });
    }
    out[arm] = { v2, v3: summarize(rows), changed };
  }
  return out;
}

if (import.meta.main) {
  const paths = process.argv.slice(2);
  if (!paths.length) { console.error('usage: bun eval/runner/outcomes/rescore-a4.ts <receipt.json>...'); process.exit(2); }
  console.log(JSON.stringify(Object.fromEntries(paths.map(p => [p, rescoreA4Receipt(JSON.parse(readFileSync(p, 'utf8')))])), null, 1));
}
