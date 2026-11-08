/**
 * Amendment 2: label the gate-stress turns with the same judge, instructions,
 * catalog listing and batch size as judge.ts pass 1, then split them 20/80
 * within each intent by sha256('gbra377-split-v1' + id).
 *
 *   bun scripts/judge-stress.ts   -> results/judge-stress.jsonl, data/stress-dev.jsonl, data/stress-test.jsonl
 */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { attestPreregistration } from '../../../../eval/runner/prereg.ts';
import { PREREG } from './gen-turns.ts';
import { BATCH, JUDGE_INSTRUCTIONS, catalogListing } from './judge.ts';
import { DIR, anthropicText, byHash, fileSha, readJsonl, spent } from './lib.ts';

interface Turn { id: string; intent: string; text: string }
const root = join(DIR, '../../..');
attestPreregistration(PREREG, root);
const skills = readJsonl<{ id: string; description: string }>(join(DIR, 'data/catalog.jsonl'));
const ids = new Set(skills.map(s => s.id));
const turns = readJsonl<Turn>(join(DIR, 'data/stress-turns.jsonl')).sort(byHash<Turn>('gbra377-judge-batch-1', t => t.id));
const out = join(DIR, 'results/judge-stress.jsonl');
const done = new Set(existsSync(out) ? readJsonl<{ turn: string }>(out).map(r => r.turn) : []);
const system = [{ type: 'text', text: JUDGE_INSTRUCTIONS }, { type: 'text', text: `Skill catalog (${skills.length} skills):\n${catalogListing(skills)}`, cache_control: { type: 'ephemeral' } }];
const batches: Turn[][] = [];
for (let i = 0; i < turns.length; i += BATCH) batches.push(turns.slice(i, i + BATCH).filter(t => !done.has(t.id)));
const run = async (batch: Turn[]) => {
  if (!batch.length) return;
  const user = `Label these messages:\n\n${batch.map(t => `turn ${t.id}:\n${t.text}`).join('\n\n')}`;
  for (let attempt = 1; ; attempt++) {
    const r = await anthropicText('judge:stress', system, user);
    try {
      const rows = JSON.parse(/\[[\s\S]*\]/.exec(r.text)![0]) as { turn: string; acceptable: string[]; best: string | null }[];
      const lines = batch.map(t => {
        const row = rows.find(x => x.turn === t.id);
        if (!row) throw new Error(`judge skipped ${t.id}`);
        return JSON.stringify({ turn: t.id, acceptable: row.acceptable.filter(a => ids.has(a)), best: row.best && ids.has(row.best) ? row.best : null, invalid: row.acceptable.filter(a => !ids.has(a)), model: r.model, stop_reason: r.stop_reason, attempt });
      });
      appendFileSync(out, lines.join('\n') + '\n');
      return;
    } catch (e) { if (attempt >= 3) throw e; }
  }
};
await run(batches[0]);
let next = 1;
await Promise.all(Array.from({ length: 4 }, async () => { while (next < batches.length) await run(batches[next++]); }));
const labels = new Map(readJsonl<{ turn: string; acceptable: string[]; best: string | null }>(out).map(l => [l.turn, l]));
const all = readJsonl<Turn>(join(DIR, 'data/stress-turns.jsonl'));
const dev: object[] = [], test: object[] = [];
for (const intent of ['terse_skill', 'long_no_skill', 'long_generic']) {
  const g = all.filter(t => t.intent === intent).sort(byHash<Turn>('gbra377-split-v1', t => t.id));
  const nDev = Math.round(g.length * 0.2);
  g.forEach((t, i) => (i < nDev ? dev : test).push({ ...t, acceptable: [...labels.get(t.id)!.acceptable].sort(), best: labels.get(t.id)!.best }));
}
const w = (name: string, rows: any[]) => writeFileSync(join(DIR, 'data', name), rows.sort((a, b) => a.id.localeCompare(b.id)).map(r => JSON.stringify(r)).join('\n') + '\n');
w('stress-dev.jsonl', dev);
w('stress-test.jsonl', test);
console.log(JSON.stringify({ stress_turns_jsonl: fileSha(join(DIR, 'data/stress-turns.jsonl')), judge_stress_jsonl: fileSha(out), stress_dev_jsonl: fileSha(join(DIR, 'data/stress-dev.jsonl')), stress_test_jsonl: fileSha(join(DIR, 'data/stress-test.jsonl')), dev: dev.length, test: test.length, ledger: spent() }, null, 1));
