/**
 * Write the 300 turns with one model (WRITER) that sees only a task area's
 * scenario, never a skill name or description: 5 skill-seeking turns and 1
 * near-miss no-skill turn per area (45 areas), plus 30 generic no-skill turns.
 *
 *   bun scripts/gen-turns.ts   -> data/turns.jsonl, results/writer-raw.jsonl
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { attestPreregistration } from '../../../../eval/runner/prereg.ts';
import { DIR, WRITER, openaiJson, spent } from './lib.ts';

export const PREREG = 'docs/benchmarks/2026-11-07-skill-ranker-offline-preregistration.md';

export const WRITER_SYSTEM = `You write realistic test messages that people send to their AI agent. Write the way real users type: varied length (from a terse one-line command to three or four sentences of context), varied tone and skill level, concrete details. Never name a "skill", "plugin" or "workflow" and never tell the agent which procedure to use; just say what you want. Technology and product names (languages, frameworks, cloud services, file formats, public websites) are fine. For people, companies, customers, investors and projects use invented placeholder names that end in -example (alice-example, acme-example). Output JSON only.`;

const turnsSchema = (n: number) => ({ type: 'object', additionalProperties: false, required: ['messages'], properties: { messages: { type: 'array', minItems: n, maxItems: n, items: { type: 'string' } } } });

const areaPrompt = (setting: string, scenario: string) => `Setting: ${setting}

Task area: ${scenario}

Write 6 messages from different users in this area.
- Messages 1 to 5 each ask for real multi-step work in this area: the kind of recurring job an agent does better by following a tested procedure. Make them distinct from each other (different sub-tasks, people and details).
- Message 6 is a near miss: a short question in the same area that a capable assistant answers directly in one reply from general knowledge, with no multi-step work, no tools, no files and no saved notes.`;

const genericPrompt = (setting: string, kinds: string[]) => `Setting: ${setting}

Write 30 messages a user might send in passing that need no procedure, tool or saved notes: a capable assistant answers each directly in one short reply. Write 3 messages of each kind below, in this order:
${kinds.map((k, i) => `${i + 1}. ${k}`).join('\n')}`;

if (import.meta.main) {
  const root = join(DIR, '../../..');
  const attestation = attestPreregistration(PREREG, root);
  const areas = JSON.parse(readFileSync(join(DIR, 'data/areas.json'), 'utf8'));
  const out = join(DIR, 'data/turns.jsonl');
  if (existsSync(out)) throw new Error('data/turns.jsonl exists; the turn set is written once');
  const raw = join(DIR, 'results/writer-raw.jsonl');
  const results = await Promise.all(areas.areas.map(async (a: { id: string; scenario: string }, i: number) => {
    await Bun.sleep(i * 300);
    const r = await openaiJson(`writer:${a.id}`, WRITER_SYSTEM, areaPrompt(areas.setting, a.scenario), turnsSchema(6));
    appendFileSync(raw, JSON.stringify({ area: a.id, model: r.model, status: r.status, messages: r.parsed.messages }) + '\n');
    return { area: a.id, messages: r.parsed.messages as string[] };
  }));
  const g = await openaiJson('writer:generic', WRITER_SYSTEM, genericPrompt(areas.setting, areas.generic_no_skill), turnsSchema(30));
  appendFileSync(raw, JSON.stringify({ area: 'generic', model: g.model, status: g.status, messages: g.parsed.messages }) + '\n');
  const turns: object[] = [];
  let n = 0;
  const id = () => `t${String(++n).padStart(3, '0')}`;
  for (const r of results) r.messages.forEach((text, i) => turns.push({ id: id(), area: r.area, intent: i < 5 ? 'skill' : 'near_miss', text: text.trim() }));
  (g.parsed.messages as string[]).forEach((text, i) => turns.push({ id: id(), area: 'generic', kind: areas.generic_no_skill[Math.floor(i / 3)], intent: 'generic', text: text.trim() }));
  writeFileSync(out, turns.map(t => JSON.stringify(t)).join('\n') + '\n');
  writeFileSync(join(DIR, 'results/writer-attestation.json'), JSON.stringify({ ...attestation, writer: WRITER, turns: turns.length, ledger_usd_after: spent() }, null, 1) + '\n');
  console.log(`wrote ${turns.length} turns to ${relative(root, out)}; ledger $${spent().toFixed(4)}`);
}
