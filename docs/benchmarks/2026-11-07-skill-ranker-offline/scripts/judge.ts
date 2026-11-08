/**
 * Label every turn with its acceptable skills. The judge (JUDGE, a different
 * model family from the writer) reads the full 1,500-skill catalog (id and
 * description, in a hash order unrelated to any arm) and sees no arm output.
 * Pass 1 is the label set; pass 2 re-labels every turn in different batches
 * and is used only to report label stability.
 *
 *   bun scripts/judge.ts 1   -> results/judge-pass1.jsonl
 *   bun scripts/judge.ts 2   -> results/judge-pass2.jsonl
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { attestPreregistration } from '../../../../eval/runner/prereg.ts';
import { PREREG } from './gen-turns.ts';
import { DIR, JUDGE, anthropicText, byHash, readJsonl, spent } from './lib.ts';

export const BATCH = 5;

export const JUDGE_INSTRUCTIONS = `You label test data for a skill-routing benchmark. An AI agent has the skill catalog below installed. A skill is a written procedure the agent can load before acting. For each user message you are given, decide which catalog skills the agent should load to handle that message well.

A skill is acceptable when its procedure directly applies to the main thing the user asked for, so loading it would materially improve how the agent does the job. Do not include skills that are only loosely related, that cover a different step than the one asked for, or that would merely be nice to know. Prefer a short, precise list; never list more than 8. If no skill's procedure applies, and a capable agent should simply answer or act without one, return an empty list. Also name the single best skill, or null when the list is empty.

Use the exact skill ids from the catalog. Answer with JSON only, no prose, in this shape:
[{"turn": "<turn id>", "acceptable": ["<skill id>", ...], "best": "<skill id>" | null}, ...]`;

interface Turn { id: string; text: string }
interface Skill { id: string; description: string }

export function catalogListing(skills: Skill[]): string {
  return [...skills].sort(byHash<Skill>('gbra377-judge-order', s => s.id)).map(s => `- ${s.id}: ${s.description}`).join('\n');
}

function parse(text: string): { turn: string; acceptable: string[]; best: string | null }[] {
  const m = /\[[\s\S]*\]/.exec(text);
  if (!m) throw new Error(`no JSON array in judge reply: ${text.slice(0, 200)}`);
  return JSON.parse(m[0]);
}

if (import.meta.main) {
  const pass = Number(process.argv[2]);
  if (pass !== 1 && pass !== 2) throw new Error('usage: judge.ts 1|2');
  const root = join(DIR, '../../..');
  attestPreregistration(PREREG, root);
  const skills = readJsonl<Skill>(join(DIR, 'data/catalog.jsonl'));
  const ids = new Set(skills.map(s => s.id));
  const turns = readJsonl<Turn>(join(DIR, 'data/turns.jsonl')).sort(byHash<Turn>(`gbra377-judge-batch-${pass}`, t => t.id));
  const out = join(DIR, `results/judge-pass${pass}.jsonl`);
  const done = new Set(existsSync(out) ? readJsonl<{ turn: string }>(out).map(r => r.turn) : []);
  const system = [{ type: 'text', text: JUDGE_INSTRUCTIONS }, { type: 'text', text: `Skill catalog (${skills.length} skills):\n${catalogListing(skills)}`, cache_control: { type: 'ephemeral' } }];
  const batches: Turn[][] = [];
  for (let i = 0; i < turns.length; i += BATCH) batches.push(turns.slice(i, i + BATCH).filter(t => !done.has(t.id)));
  const run = async (batch: Turn[]) => {
    if (batch.length === 0) return;
    const user = `Label these messages:\n\n${batch.map(t => `turn ${t.id}:\n${t.text}`).join('\n\n')}`;
    for (let attempt = 1; ; attempt++) {
      const r = await anthropicText(`judge:pass${pass}`, system, user);
      try {
        const rows = parse(r.text);
        for (const t of batch) {
          const row = rows.find(x => x.turn === t.id);
          if (!row) throw new Error(`judge skipped ${t.id}`);
          const invalid = row.acceptable.filter(a => !ids.has(a));
          appendFileSync(out, JSON.stringify({ turn: t.id, acceptable: row.acceptable.filter(a => ids.has(a)), best: row.best && ids.has(row.best) ? row.best : null, invalid, model: r.model, stop_reason: r.stop_reason, attempt }) + '\n');
        }
        return;
      } catch (e) {
        if (attempt >= 3) throw e;
      }
    }
  };
  await run(batches[0]);
  let next = 1;
  await Promise.all(Array.from({ length: 4 }, async () => { while (next < batches.length) await run(batches[next++]); }));
  console.log(`pass ${pass}: ${readJsonl(out).length} rows; ledger $${spent().toFixed(4)}`);
}
