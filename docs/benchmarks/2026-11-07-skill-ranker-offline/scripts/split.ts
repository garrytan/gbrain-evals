/**
 * Join turns with pass-1 labels and split 20% dev / 80% test within each
 * written intent, by sha256('gbra377-split-v1' + id). Writes data/dev.jsonl,
 * data/test.jsonl and results/freeze.json with every hash.
 *
 *   bun scripts/split.ts
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIR, byHash, fileSha, readJsonl } from './lib.ts';

interface Turn { id: string; area: string; intent: string; text: string }
interface Label { turn: string; acceptable: string[]; best: string | null; invalid: string[] }

const turns = readJsonl<Turn>(join(DIR, 'data/turns.jsonl'));
const labels = new Map(readJsonl<Label>(join(DIR, 'results/judge-pass1.jsonl')).map(l => [l.turn, l]));
const missing = turns.filter(t => !labels.has(t.id)).map(t => t.id);
if (missing.length) throw new Error(`no pass-1 label for ${missing.join(', ')}`);
if (existsSync(join(DIR, 'data/test.jsonl'))) throw new Error('data/test.jsonl exists; the split is frozen');
const dev: object[] = [];
const test: object[] = [];
for (const intent of ['skill', 'near_miss', 'generic']) {
  const group = turns.filter(t => t.intent === intent).sort(byHash<Turn>('gbra377-split-v1', t => t.id));
  const nDev = Math.round(group.length * 0.2);
  group.forEach((t, i) => {
    const l = labels.get(t.id)!;
    (i < nDev ? dev : test).push({ ...t, acceptable: [...l.acceptable].sort(), best: l.best });
  });
}
const byId = (a: any, b: any) => a.id.localeCompare(b.id);
const write = (name: string, rows: object[]) => writeFileSync(join(DIR, 'data', name), rows.sort(byId).map(r => JSON.stringify(r)).join('\n') + '\n');
write('dev.jsonl', dev);
write('test.jsonl', test);
const freeze = {
  turns_jsonl: fileSha(join(DIR, 'data/turns.jsonl')),
  judge_pass1_jsonl: fileSha(join(DIR, 'results/judge-pass1.jsonl')),
  dev_jsonl: fileSha(join(DIR, 'data/dev.jsonl')),
  test_jsonl: fileSha(join(DIR, 'data/test.jsonl')),
  catalog_jsonl: fileSha(join(DIR, 'data/catalog.jsonl')),
  dev: dev.length, test: test.length,
};
writeFileSync(join(DIR, 'results/freeze.json'), JSON.stringify(freeze, null, 1) + '\n');
console.log(JSON.stringify(freeze, null, 1));
