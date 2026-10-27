import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { generatePersona, PP_BRIEF_DEV_SEEDS, PP_BRIEF_V2_DEV_SEEDS, PP_D7_DEV_SEEDS, PP_DEV_SEEDS, solvabilityProblems } from '../../eval/generators/program-primary-gen.ts';
import { truthfulAnswer } from '../../eval/runner/t0/score.ts';
import { D7_ARMS, D7_FIXTURE_FILE, D7_SCENARIOS, parseD7Id } from '../../eval/runner/cat41/brief-scenarios.ts';
import { negativePrompt, renderFixture, taskStartPrompt, taskStartPromptPlain } from '../../eval/runner/cat41/brief-worlds.ts';
import { correctOn, d7Spec, injectedText, sessionTimeline } from '../../eval/runner/cat41/brief-d7.ts';
import { SCENARIOS, scenarioById } from '../../eval/runner/cat41/scenarios.ts';

describe('D7 Cat 41 brief scenarios', () => {
  test('the committed worlds are the generator output for the D7 seeds', () => {
    expect(JSON.parse(readFileSync(D7_FIXTURE_FILE, 'utf8'))).toEqual(JSON.parse(JSON.stringify(renderFixture())));
  });

  test('D7 seeds render, are solvable, have every moved meeting on or after 2026-10-22 and no seed of an earlier run', () => {
    for (const s of PP_D7_DEV_SEEDS) {
      expect([...PP_DEV_SEEDS, ...PP_BRIEF_DEV_SEEDS, ...PP_BRIEF_V2_DEV_SEEDS]).not.toContain(s);
      const p = generatePersona(s);
      expect(solvabilityProblems(p)).toEqual([]);
      expect(p.tasks.every(t => t.gold.date.new_iso >= '2026-10-22')).toBe(true);
    }
  });

  test('48 sessions: 32 Claude Code hooks cells (two models), 8 Codex hooks cells, 8 Claude Code pull cells', () => {
    const claude = D7_SCENARIOS.filter(s => s.harnesses!.includes('claude'));
    const codex = D7_SCENARIOS.filter(s => s.harnesses!.includes('codex'));
    expect(claude.filter(s => parseD7Id(s.id)!.arm !== 'pull')).toHaveLength(16);
    expect(claude.filter(s => parseD7Id(s.id)!.arm === 'pull')).toHaveLength(8);
    expect(codex).toHaveLength(8);
    expect(codex.every(s => parseD7Id(s.id)!.arm !== 'pull')).toBe(true);
    expect(16 * 2 + codex.length + 8).toBe(48);
    expect(D7_ARMS).toEqual(['off', 'on', 'pull']);
  });

  test('D7 scenarios stay out of the gate set but resolve by id, opt-in and harness-wired', () => {
    expect(SCENARIOS.some(s => s.id.startsWith('d7_'))).toBe(false);
    for (const s of D7_SCENARIOS) {
      expect(scenarioById(s.id)).toBe(s);
      expect(s.optIn && s.wiresHarness).toBe(true);
    }
  });

  test('prompts: reply and prep are the T0 session-2 prompts; task_start uses the lexicon word, its gate check does not', () => {
    for (const s of D7_SCENARIOS.filter(x => x.id.endsWith('_on'))) {
      const { spec, task, world } = d7Spec(s.id);
      if (spec.kind === 'reply' || spec.kind === 'prep') expect(spec.prompt).toBe(task.session2);
      if (spec.kind === 'task_start') {
        expect(spec.prompt).toBe(taskStartPrompt(task.contact_name));
        expect(spec.gate_check_prompt).toBe(taskStartPromptPlain(task.contact_name));
        expect(/follow[ -]up/i.test(spec.gate_check_prompt!)).toBe(false);
      }
      if (spec.kind === 'negative') {
        expect(spec.prompt).toBe(negativePrompt(spec.counterparty.name, world.principal.first));
        expect(spec.counterparty.slug).not.toBe(task.contact);
        expect(spec.counterparty.name.split(' ')[0]).toBe(task.contact_name.split(' ')[0]);
      }
    }
  });

  test('correctness: the truthful answer is correct; the stale answer is confident-wrong; the negative fails on the other contact\'s values', () => {
    const { task } = d7Spec(D7_SCENARIOS.find(s => s.id.startsWith('d7_prep_'))!.id);
    const truth = truthfulAnswer(task, { date: task.gold.date.new_iso, correction: task.gold.correction.corrected.label, commitment: task.gold.commitment.label });
    expect(correctOn('prep', task, truth)).toMatchObject({ success: true, complete: true, confident_wrong: false });
    const stale = truthfulAnswer(task, { date: task.gold.date.old_iso, correction: task.gold.correction.stale.label, commitment: task.gold.commitment.label });
    expect(correctOn('prep', task, stale)).toMatchObject({ success: false, confident_wrong: true });
    expect(correctOn('task_start', task, `${task.gold.commitment.label} is due before ${task.gold.date.new_iso}.`).success).toBe(true);
    expect(correctOn('task_start', task, `${task.gold.commitment.label}, no date.`).success).toBe(false);
    expect(correctOn('negative', task, 'Hi, nothing new here; happy to talk next week.')).toMatchObject({ success: true, confident_wrong: false });
    expect(correctOn('negative', task, `I'll send ${task.gold.commitment.label} soon.`)).toMatchObject({ success: false, confident_wrong: true });
  });

  test('timeline: outputs carry arrival time, model turns and tool calls; model waits come from arrival gaps', () => {
    const raw = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', name: 'mcp__gbrain__search', input: { query: 'x' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }] } }),
      JSON.stringify({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'first' }] } }),
      JSON.stringify({ type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'a.md', content: 'body' } }] } }),
      JSON.stringify({ type: 'result', duration_api_ms: 900 }),
      '',
    ].join('\n');
    const tl = sessionTimeline('claude', raw, [100, 400, 500, 1200, 1300, 1400]);
    expect(tl.outputs).toEqual([{ ms: 1200, text: 'first', turns: 2, tool_calls: 1 }, { ms: 1300, text: 'a.md\nbody', turns: 2, tool_calls: 2 }]);
    expect(tl.model_waits).toEqual([300, 700]);
    expect(tl.api_ms).toBe(900);
    const codex = [
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'gbrain search x' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'gbrain search x' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
      '',
    ].join('\n');
    const ct = sessionTimeline('codex', codex, [0, 250, 600, 1000]);
    expect(ct.outputs).toEqual([{ ms: 600, text: 'gbrain search x', turns: 1, tool_calls: 1 }, { ms: 1000, text: 'done', turns: 2, tool_calls: 1 }]);
    expect(ct.model_waits).toEqual([250, 400]);
  });

  test('injected text: user-prompt JSON additionalContext, session-start plain text', () => {
    expect(injectedText('{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"ctx"}}\n')).toBe('ctx');
    expect(injectedText('Backup check: ok\n')).toBe('Backup check: ok');
  });
});
