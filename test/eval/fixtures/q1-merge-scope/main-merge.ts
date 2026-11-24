/**
 * Writes the expected outputs of test/eval/q1-merge-scope.test.ts from main's code before the weekly line split cells
 * across VMs (753393ff): main's `cell.ts merge` body (eval/runner/q1/cell.ts:1926-1934 there), run on the committed shard
 * inputs with the corpus they ran on in place of loadCorpus, which needs custody or a downloaded dataset.
 * Usage: bun test/eval/fixtures/q1-merge-scope/main-merge.ts <checkout of 753393ff> <inputs dir> <out dir>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MERGE_SCOPE_CELLS, mergeScopeCorpus } from './cells.ts';

const [tree, inputs, out] = process.argv.slice(2).map(p => resolve(p));
const cell = await import(join(tree, 'eval/runner/q1/cell.ts'));
const { instrumentFor } = await import(join(tree, 'eval/runner/memory-qa/instruments.ts'));
const { DEFAULT_MAX_ATTEMPTS } = await import(join(tree, 'eval/runner/memory-qa/outcomes.ts'));
const { sha256 } = await import(join(tree, 'eval/runner/memory-qa/records.ts'));
for (const c of MERGE_SCOPE_CELLS) {
  const def = cell.findCell(c.id, undefined, c.manifest);
  const from = [0, 1].map(i => join(inputs, c.set, `shard${i}`));
  const to = join(out, c.set);
  const corpus = mergeScopeCorpus();
  const selected = cell.selectCellQuestions(corpus.questions.filter((q: { conversation: string }) => cell.splitConversations(def.benchmark, def.split, corpus).has(q.conversation)), def.selection);
  const capabilities = JSON.parse(readFileSync(join(from[0], 'cells', def.arms[0].cell_id, 'receipt.json'), 'utf8')).system.capabilities;
  const configs = new Map(def.arms.map((a: { id: string; cell_id: string }) => {
    const t = readFileSync(join(from[0], 'cells', a.cell_id, 'run-config.json'), 'utf8');
    mkdirSync(join(to, 'cells', a.cell_id), { recursive: true });
    writeFileSync(join(to, 'cells', a.cell_id, 'run-config.json'), t);
    return [a.id, { text: t, sha: sha256(t) }];
  }));
  const res = cell.publishCell(def, def.arms, from, to, { instrument: instrumentFor(def.canonical_instrument), selected, invalidReasons: [], configs, capabilities, stopped: null, maxAttempts: DEFAULT_MAX_ATTEMPTS });
  console.log(c.id, res.map((r: { status: string }) => r.status).join(','));
}
