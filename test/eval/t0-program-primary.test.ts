import { describe, expect, test } from 'bun:test';
import { generateWorld, humanDate } from '../../eval/generators/program-primary-gen.ts';
import { revisionOf, scriptedReader, scriptedWriter, systemPrompt, ARMS, COUNTED_READERS, type CellRecord } from '../../eval/runner/t0-program-primary.ts';
import { DELIVERY_CONTRACT, dropped, renderUserTurn, type HookResult } from '../../eval/runner/t0/delivery.ts';
import { scoreAnswer } from '../../eval/runner/t0/score.ts';
import { summarize } from '../../eval/runner/t0/analyze.ts';

const world = generateWorld();
const persona = world.personas[0];
const task = persona.tasks[0];
const g = task.gold;
const pushed = `<!-- retrieved brain context -->\n- **${task.contact_name}** → \`${task.contact}\` — synopsis (use get_page before relying on details)`;

describe('T0 delivery contract', () => {
  test('frozen values match the release under test', () => {
    expect(DELIVERY_CONTRACT.byte_cap.hook_output_chars).toBe(10_000);
    expect(DELIVERY_CONTRACT.timing.user_prompt_self_deadline_ms).toBe(800);
    expect(DELIVERY_CONTRACT.timing.harness_timeout_ms).toEqual({ session_start: 5000, user_prompt_submit: 3000 });
    expect(DELIVERY_CONTRACT.surface).toMatch(/^starter/);
  });

  test('hook context is injected before the prompt; a dropped hook injects nothing', () => {
    const hook: HookResult = { event: 'user-prompt', outcome: 'ok', ms: 10, text: pushed, chars: pushed.length, exit: 0 };
    const turn = renderUserTurn(task.session2, [hook]);
    expect(turn.startsWith('<system-reminder>\nUserPromptSubmit hook additional context:')).toBe(true);
    expect(turn.endsWith(task.session2)).toBe(true);
    expect(renderUserTurn(task.session2, [dropped(hook)])).toBe(task.session2);
  });
});

describe('T0 scripted (hermetic) reader', () => {
  test('revisionOf reads the page revision even behind a notice', () => {
    expect(revisionOf('notice: hello\n{"id":1,"knowledge_revision":"k","revision":"abc-123","x":2}')).toBe('abc-123');
    expect(revisionOf('Error: not found')).toBeUndefined();
  });

  test('the writer reads the page, writes all three facts with its revision, then submits', () => {
    const w = scriptedWriter(persona, task);
    expect(w([])).toEqual({ name: 'get_page', args: { slug: task.contact, include_content: true } });
    const put = w([{ name: 'get_page', args: {}, result: '{"revision":"r1"}' }]);
    expect(put.name).toBe('put_page');
    expect(put.args.expected_revision).toBe('r1');
    const content = String(put.args.content);
    expect(scoreAnswer(task, content).kinds).toEqual([]);
  });

  test('the reader follows only the pushed pointer; without push it finds nothing (a broken channel fails)', () => {
    const updated = `Next meeting ${humanDate(g.date.new_iso)}. ${g.correction.corrected.label}. Open commitment: ${g.commitment.label}.`;
    const r = scriptedReader(task, pushed);
    expect(r([])).toEqual({ name: 'get_page', args: { slug: task.contact } });
    const answer = String(r([{ name: 'get_page', args: {}, result: updated }]).args.answer);
    expect(scoreAnswer(task, answer)).toMatchObject({ failed: false, complete: true });
    const stalePage = `Next meeting ${humanDate(g.date.old_iso)}. ${g.correction.stale.label}.`;
    expect(scoreAnswer(task, String(r([{ name: 'get_page', args: {}, result: stalePage }]).args.answer)).failed).toBe(true);
    const blind = scriptedReader(task, '');
    expect(scoreAnswer(task, String(blind([]).args.answer)).kinds).toContain('missed_commitment');
  });

  test('the system prompt names the persona and the session day, and no answer value', () => {
    const p = systemPrompt(persona, '2026-10-15', 'INSTRUCTIONS');
    expect(p).toContain(persona.principal.name);
    expect(p).toContain('2026-10-15');
    expect(p).toContain('INSTRUCTIONS');
    expect(scoreAnswer(task, p).commitment_hit).toBe(false);
  });

  test('counted readers and arms are the preregistered ones', () => {
    expect([...COUNTED_READERS]).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol']);
    expect([...ARMS]).toEqual(['baseline', 'mutant-forced-drop', 'mutant-stale-correction', 'ablation-push-off']);
  });
});

describe('T0 mutant detection', () => {
  const cell = (persona: string, t: string, arm: string, failed: boolean, kinds: string[] = failed ? ['missed_commitment'] : []): CellRecord => ({
    key: `${t}|r|${arm}|1`, persona, task: t, arm, reader: 'r', repeat: 1, kind: 'prep', correction_kind: 'seats',
    score: { failed, kinds, omissions: { date: false, correction: false }, complete: !failed }, capture: { writes: 1, commitment: true, new_date: true, corrected: true },
    sessions: [{ hooks: [], wall_ms: 1 }, { hooks: [], wall_ms: 1 }], usd: { reader: 0, gbrain_internal: 0, total: 0 }, tokens: { input_total: 0, output_total: 0 }, wall_ms: 1,
  } as unknown as CellRecord);
  test('a mutant that fails where the baseline passes is detected; one that changes nothing is not', () => {
    const cells: CellRecord[] = [];
    for (const p of ['a', 'b', 'c', 'd']) for (const t of ['1', '2', '3']) {
      cells.push(cell(p, `${p}${t}`, 'baseline', t === '3'));
      cells.push(cell(p, `${p}${t}`, 'mutant-forced-drop', true));
      cells.push(cell(p, `${p}${t}`, 'mutant-stale-correction', t === '3'));
    }
    const s = summarize(cells);
    expect(s.mutants.find(m => m.arm === 'mutant-forced-drop')!.detected).toBe(true);
    expect(s.mutants.find(m => m.arm === 'mutant-stale-correction')!.detected).toBe(false);
  });
});

describe('T0 native parity slice', () => {
  test('registers both gbrain hooks with the release timeouts and passes the persona, not the answer', async () => {
    const { hookSettings, personaLine } = await import('../../eval/runner/t0/parity.ts');
    const s = hookSettings('/opt/gbrain');
    expect(s.hooks.SessionStart[0].hooks[0]).toEqual({ type: 'command', command: 'bun /opt/gbrain/src/cli.ts hook session-start', timeout: 5 });
    expect(s.hooks.UserPromptSubmit[0].hooks[0]).toEqual({ type: 'command', command: 'bun /opt/gbrain/src/cli.ts hook user-prompt', timeout: 3 });
    const line = personaLine(persona, '2026-10-15');
    expect(line).toContain(persona.principal.name);
    expect(scoreAnswer(task, line).commitment_hit).toBe(false);
  });
});
