/**
 * Amendment 2: a gate-stress set that breaks the length confound in the main
 * turns (skill turns are long, no-skill turns short). Same writer and rules.
 * Per area: 1 terse skill-seeking turn (at most 12 words) and 1 long no-skill
 * turn (3 to 6 sentences of context, answerable directly in one reply); plus
 * 10 long generic no-skill turns. 100 turns.
 *
 *   bun scripts/gen-stress.ts   -> data/stress-turns.jsonl, results/writer-stress-raw.jsonl
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { attestPreregistration } from '../../../../eval/runner/prereg.ts';
import { PREREG, WRITER_SYSTEM } from './gen-turns.ts';
import { DIR, openaiJson, spent } from './lib.ts';

const schema = (n: number) => ({ type: 'object', additionalProperties: false, required: ['messages'], properties: { messages: { type: 'array', minItems: n, maxItems: n, items: { type: 'string' } } } });

const areaPrompt = (setting: string, scenario: string) => `Setting: ${setting}

Task area: ${scenario}

Write 2 messages from different users in this area.
- Message 1 asks for real multi-step work in this area (the kind of recurring job an agent does better by following a tested procedure), but is terse: at most 12 words, the way people type a quick command.
- Message 2 needs no procedure, tool, file or saved notes: a capable assistant answers it directly in one reply from general knowledge. But it is long: 3 to 6 sentences of background about the user's situation before a simple question.`;

const genericPrompt = (setting: string) => `Setting: ${setting}

Write 10 long, chatty messages (3 to 6 sentences each) that need no procedure, tool, file or saved notes: a capable assistant answers each directly in one short reply. Mix small talk, everyday questions, a quick opinion, a definition and a simple calculation, each wrapped in personal background.`;

if (import.meta.main) {
  const root = join(DIR, '../../..');
  attestPreregistration(PREREG, root);
  const out = join(DIR, 'data/stress-turns.jsonl');
  if (existsSync(out)) throw new Error('data/stress-turns.jsonl exists; written once');
  const areas = JSON.parse(readFileSync(join(DIR, 'data/areas.json'), 'utf8'));
  const raw = join(DIR, 'results/writer-stress-raw.jsonl');
  const res = await Promise.all(areas.areas.map(async (a: { id: string; scenario: string }, i: number) => {
    await Bun.sleep(i * 300);
    const r = await openaiJson(`writer-stress:${a.id}`, WRITER_SYSTEM, areaPrompt(areas.setting, a.scenario), schema(2));
    appendFileSync(raw, JSON.stringify({ area: a.id, model: r.model, status: r.status, messages: r.parsed.messages }) + '\n');
    return { area: a.id, messages: r.parsed.messages as string[] };
  }));
  const g = await openaiJson('writer-stress:generic', WRITER_SYSTEM, genericPrompt(areas.setting), schema(10));
  appendFileSync(raw, JSON.stringify({ area: 'generic', model: g.model, status: g.status, messages: g.parsed.messages }) + '\n');
  const turns: object[] = [];
  let n = 0;
  const id = () => `s${String(++n).padStart(3, '0')}`;
  for (const r of res) r.messages.forEach((text, i) => turns.push({ id: id(), area: r.area, intent: i === 0 ? 'terse_skill' : 'long_no_skill', text: text.trim() }));
  (g.parsed.messages as string[]).forEach(text => turns.push({ id: id(), area: 'generic', intent: 'long_generic', text: text.trim() }));
  writeFileSync(out, turns.map(t => JSON.stringify(t)).join('\n') + '\n');
  console.log(`wrote ${turns.length} stress turns; ledger $${spent().toFixed(4)}`);
}
