/**
 * Output contracts for skillopt-method-v3 (GBEV-30, plan section 3).
 *
 * Every arm's task prompt is the task followed by its skill's contract (the
 * no-skill arm included), except the bare no-skill arm, which sends the task
 * alone (#304's condition). Each contract adopts the shipped seed's own
 * documented output shape and adds only what the scorer needs to bind facts,
 * so a seed that follows its own instructions never fails a form check:
 *
 *   query       the seed asks for a direct response, [Source: slug, ...]
 *               citations and "the brain doesn't have information on X"; the
 *               contract puts the concluded value first and alone
 *   briefing    the seed lists "- [time] [meeting name]" under MEETINGS TODAY
 *               with [Source: slug, updated DATE] citations; the contract puts
 *               each asked fact and its citation inside its meeting's entry
 *   fact-check  the seed writes "[N] CLAIM:" blocks with one STATUS: line and
 *               a Corrections Applied list; the contract asks for one block per
 *               claim or per part, and the correct value of a contradicted part,
 *               and names the seed's six status labels so an arm without the
 *               skill can use them
 *
 * The contracts are frozen with the data as <skill>/contract.md.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { datasetDir } from './dataset.ts';
import type { SkillName } from './score.ts';
import { SEED_STATUS_LABELS } from './score-v3.ts';

export const CONTRACTS: Readonly<Record<SkillName, string>> = {
  query: [
    'Output contract (how your answer is read):',
    '- Put the direct answer first, on an "Answer:" line or as the first sentence of your response. It holds only the value you conclude. Note any other value you found (an earlier or later record, a note, a look-alike) and its source after that, never in the first sentence.',
    '- If the brain has nothing on the person or company the question names, say "the brain doesn\'t have information on <name>" (or write "not in the brain: <name>") and give no value of a near match.',
    '- If the name fits more than one person or company and the question gives nothing to choose between them, write an "ambiguous:" line naming each candidate.',
    '- Cite each page that decides the answer as [Source: slug].',
  ].join('\n'),
  briefing: [
    'Output contract (how your briefing is read):',
    '- Write one entry per external meeting, as your skill\'s "- [time] [meeting name]" item under MEETINGS TODAY or as a heading, starting with the meeting\'s time and title exactly as the task lists them.',
    '- Inside that meeting\'s entry, before the next meeting\'s, state the fact the task asks for in a sentence of its own (mention any other value you found in a later sentence) and cite it as [Source: slug, updated DATE]. If an attendee has no brain page, write "No brain page for <name>" in that entry.',
  ].join('\n'),
  'fact-check': [
    'Output contract (how your report is read):',
    `- Use your skill's claim-by-claim report: one "[N] CLAIM:" block for the claim, or one per part of a claim that states several values, each block with exactly one STATUS: line carrying one of the six labels ${SEED_STATUS_LABELS.slice(0, -1).join(', ')} or ${SEED_STATUS_LABELS.at(-1)}.`,
    '- For each part the brain contradicts, give the value the brain holds, as a "Correct value:" line in that block or in your skill\'s "was X, now Y" correction.',
    '- Cite each page that decides a part by its slug.',
  ].join('\n'),
};

/** The arms of the ceiling attempt's gate and stages (plan sections 4 to 6). */
export const ARMS = ['bare-no-skill', 'no-skill', 'seed', 'one-shot', 'rubric-one-shot', 'kept-rewrite', 'reachability', 'optimized'] as const;
export type Arm = typeof ARMS[number];

/** The prompt an arm sends for a task: the task and the skill's contract, or the task alone for the bare no-skill arm. */
export function armPrompt(task: string, skill: SkillName, arm: Arm): string {
  if (arm === 'bare-no-skill') return task;
  return `${task}\n\n${CONTRACTS[skill]}`;
}

/** The committed contract of a v3 skill; throws if it differs from CONTRACTS. */
export function readContract(skill: SkillName): string {
  const text = readFileSync(join(datasetDir('v3'), skill, 'contract.md'), 'utf8');
  if (text !== CONTRACTS[skill] + '\n') throw new Error(`${skill}/contract.md differs from CONTRACTS`);
  return CONTRACTS[skill];
}
