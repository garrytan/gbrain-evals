/**
 * The public copy of a live-recall task scorecard. gbrain-evals is public, and its committed scorecards don't show what
 * a run cost (R79), so this drops the run's cap fields, the run's cost totals and each cell's spend, and keeps each
 * cell's answer cost per correct answer. The full scorecard stays private, named by its hash.
 *
 *   bun eval/runner/live-recall/redact-scorecard.ts <scorecard.json> <scorecard.md> <out dir>
 *
 * The box's Markdown must equal what this repository renders from the JSON, so the public Markdown is the box's own
 * with the spend column and the cost paragraph taken out. Both public files pass the same checks as the originals.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderTaskMarkdown, validateTaskScorecard } from './task-scorecard.ts';

const RUN_SPEND = ['budget_usd', 'final_cap_usd', 'cap_extensions'];
const KEPT = 'answer_cost_per_correct_usd';
const CELL_TABLE = '## Every cell';
const PER_CORRECT_TABLE = '## Primary models, paraphrase form';
export const PUBLIC_NOTE = "Public copy: the run's cap, its cost totals and each cell's spend are removed by `eval/runner/live-recall/redact-scorecard.ts`; each cell's answer cost per correct answer is kept.";

const spendKeys = (value: unknown, path = '$'): string[] => {
  if (Array.isArray(value)) return value.flatMap((v, i) => spendKeys(v, path + '[' + i + ']'));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => [...((k.endsWith('_usd') && k !== KEPT) || RUN_SPEND.includes(k) ? [path + '.' + k] : []), ...spendKeys(v, path + '.' + k)]);
};

export function redactTaskScorecard(card: any): any {
  const out = structuredClone(card);
  for (const k of RUN_SPEND) delete out.run[k];
  delete out.cost;
  for (const byArm of Object.values<any>(out.cells)) for (const byModel of Object.values<any>(byArm)) for (const c of Object.values<any>(byModel)) delete c.cost_usd;
  const left = spendKeys(out);
  if (left.length) throw new Error('spend left in the public scorecard at ' + left.join(', '));
  validateTaskScorecard(out);
  return out;
}

export function redactTaskMarkdown(md: string): string {
  const out: string[] = [];
  let section = '';
  for (const line of md.split('\n')) {
    if (line.startsWith('## ')) section = line;
    if (line.startsWith('Model calls ')) { if (out.at(-1) === '') out.pop(); continue; }
    if (section === CELL_TABLE && line.startsWith('|')) { out.push(line.replace(/[^|]*\|$/, '')); continue; }
    out.push(line === '## Judges and cost' ? '## Judges' : line);
  }
  out.splice(2, 0, PUBLIC_NOTE, '');
  section = '';
  for (const line of out) {
    if (line.startsWith('## ')) section = line;
    if (line.includes('$') && section !== PER_CORRECT_TABLE) throw new Error('a dollar figure is left outside the cost-per-correct table: ' + line.slice(0, 40));
  }
  return out.join('\n');
}

if (import.meta.main) {
  const [jsonPath, mdPath, outDir] = process.argv.slice(2);
  if (!jsonPath || !mdPath || !outDir) { console.error('usage: redact-scorecard.ts <scorecard.json> <scorecard.md> <out dir>'); process.exit(2); }
  const text = readFileSync(jsonPath, 'utf8'), boxMd = readFileSync(mdPath, 'utf8');
  const card = JSON.parse(text);
  validateTaskScorecard(card);
  if (renderTaskMarkdown(card) !== boxMd) { console.error('the Markdown is not what this repository renders from the JSON'); process.exit(1); }
  const json = JSON.stringify(redactTaskScorecard(card), null, 2) + '\n', md = redactTaskMarkdown(boxMd);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'scorecard.json'), json);
  writeFileSync(join(outDir, 'scorecard.md'), md);
  const sha = (t: string) => createHash('sha256').update(t).digest('hex');
  console.log(['source scorecard.json ' + sha(text), 'source scorecard.md ' + sha(boxMd), 'public scorecard.json ' + sha(json), 'public scorecard.md ' + sha(md)].join('\n'));
}
