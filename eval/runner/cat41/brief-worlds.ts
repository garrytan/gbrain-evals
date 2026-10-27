#!/usr/bin/env bun
/**
 * Renders the D7 worlds (brief-worlds.json) from the program-primary generator, so the in-container driver needs no
 * generator. `bun eval/runner/cat41/brief-worlds.ts --write` rewrites the file; the test checks it is current.
 *
 * Per world (PP_D7_DEV_SEEDS): the notes, the four contacts with what the user said after each call, and the four
 * scenarios. Reply is the first reply task, prep the first prep task, task_start the second reply task's contact
 * (a new prompt about what the user owes them), and the negative a reply to the namesake of the second prep task's
 * contact. The first world ages reply and task_start and crowds prep and the negative; the second world swaps them.
 */
import { writeFileSync } from 'node:fs';
import { generatePersona, PP_D7_DEV_SEEDS, PP_GENERATOR_VERSION, renderPPDoc, type PPPersona, type PPTask } from '../../generators/program-primary-gen.ts';
import { crowdFacts } from '../t0/brief.ts';
import { D7_FIXTURE_FILE, type D7Condition, type D7Contact, type D7Fixture, type D7Kind, type D7ScenarioSpec, type D7World } from './brief-scenarios.ts';

export const D7_FIXTURE_VERSION = 'd7-worlds-v1';

/** The start-of-task prompt: names the contact and calls the work a follow-up (the reply lexicon's `follow-up`). */
export const taskStartPrompt = (name: string) => `Help me get started on my follow-up for ${name}: work out what I owe them and by when, then write the short cover email I'll send with it.`;
/** The same request without the lexicon word; the smoke checks the gate stays silent on it. */
export const taskStartPromptPlain = (name: string) => `Help me get started on what I owe ${name}: work out what it is and by when, then write the short cover email I'll send with it.`;
export const negativePrompt = (name: string, first: string) => `${name} just emailed me: "Hi ${first}, quick check-in: anything new on your side since we last spoke?" Draft my reply.`;

function contactOf(t: PPTask): D7Contact {
  const lines = t.session1.split('\n').slice(1).map(l => l.replace(/^\d+\.\s*/, '').trim()).filter(Boolean).map(text => ({
    what: /^I promised/.test(text) ? 'commitment' as const : /moved from/.test(text) ? 'date' as const : 'correction' as const,
    text,
  }));
  const g = t.gold;
  return { task: t.id, slug: t.contact, name: t.contact_name, kind: t.kind as 'reply' | 'prep', lines,
    gold: { commitment: g.commitment, new_date: g.date.new, old_date: g.date.old, corrected: g.correction.corrected, stale: g.correction.stale, namesake: g.namesake } };
}

function namesakeOf(p: PPPersona, t: PPTask): { slug: string; name: string } {
  const first = t.contact_name.split(' ')[0];
  const d = p.docs.find(x => x.id.startsWith('people/') && x.id !== t.contact && x.title.startsWith(`${first} `));
  if (!d) throw new Error(`no namesake for ${t.contact}`);
  return { slug: d.id, name: d.title };
}

export function renderWorld(seed: number, index: number): D7World {
  const p = generatePersona(seed);
  const replies = p.tasks.filter(t => t.kind === 'reply');
  const preps = p.tasks.filter(t => t.kind === 'prep');
  const cond = (aged: boolean): D7Condition => (aged === (index % 2 === 0) ? 'aged' : 'crowded');
  const spec = (kind: D7Kind, t: PPTask, aged: boolean, prompt: string, counterparty: { slug: string; name: string }): D7ScenarioSpec => ({
    kind, task: t.id, counterparty, condition: cond(aged), prompt,
    crowd: crowdFacts(p, kind === 'negative' ? { contact: t.contact, contact_name: t.contact_name } : t),
  });
  const [reply, taskStart] = replies;
  const [prep, negativeOf] = preps;
  const namesake = namesakeOf(p, negativeOf);
  return {
    seed, persona: p.id, principal: { name: p.principal.name, first: p.principal.first },
    docs: Object.fromEntries(p.docs.map(d => [d.id, renderPPDoc(d)])),
    contacts: p.tasks.map(contactOf),
    scenarios: [
      spec('reply', reply, true, reply.session2, { slug: reply.contact, name: reply.contact_name }),
      spec('prep', prep, false, prep.session2, { slug: prep.contact, name: prep.contact_name }),
      { ...spec('task_start', taskStart, true, taskStartPrompt(taskStart.contact_name), { slug: taskStart.contact, name: taskStart.contact_name }), gate_check_prompt: taskStartPromptPlain(taskStart.contact_name) },
      spec('negative', negativeOf, false, negativePrompt(namesake.name, p.principal.first), namesake),
    ],
  };
}

export function renderFixture(): D7Fixture {
  return { version: D7_FIXTURE_VERSION, generator: PP_GENERATOR_VERSION, seeds: [...PP_D7_DEV_SEEDS], worlds: PP_D7_DEV_SEEDS.map(renderWorld) };
}

if (import.meta.main) {
  const text = JSON.stringify(renderFixture(), null, 1) + '\n';
  if (process.argv.includes('--write')) { writeFileSync(D7_FIXTURE_FILE, text); console.log(`wrote ${D7_FIXTURE_FILE}`); }
  else process.stdout.write(text);
}
