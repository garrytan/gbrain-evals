import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePersona, generateWorld, humanDate, mintSealedSeed, PP_DEV_SEEDS, sealedCommitment, solvabilityProblems, worldDigest, dateMatcher, seatsMatcher, priceMatcher, roleMatcher, type PPTask } from '../../eval/generators/program-primary-gen.ts';
import { scoreAnswer, truthfulAnswer, matches, aggregate } from '../../eval/runner/t0/score.ts';
import { assertScorerRejectsFakeSystems } from '../../eval/runner/mutation-kit.ts';

const world = generateWorld();
const tasks = world.personas.flatMap(p => p.tasks);
const truthValues = (t: PPTask) => ({ date: `${humanDate(t.gold.date.new_iso)} at ${t.gold.date.time}`, correction: t.gold.correction.corrected.label, commitment: t.gold.commitment.label });
const truth = (t: PPTask) => truthfulAnswer(t, truthValues(t));
/** The namesake's values as an answer would state them (labels without their `namesake` prefix). */
const nsValues = (t: PPTask) => t.gold.namesake.map(m => m.label.replace(/^namesake (?:meeting |commitment: )?/, '')).map(v => /^\d{4}-\d\d-\d\d$/.test(v) ? humanDate(v) : v);
const staleAnswer = (t: PPTask) => truthfulAnswer(t, { date: humanDate(t.gold.date.old_iso), correction: t.gold.correction.stale.label, commitment: null });

describe('program-primary generator', () => {
  test('same seed, same world; different seeds differ', () => {
    expect(worldDigest(generatePersona(PP_DEV_SEEDS[0]))).toBe(worldDigest(generatePersona(PP_DEV_SEEDS[0])));
    expect(worldDigest(generatePersona(PP_DEV_SEEDS[0]))).not.toBe(worldDigest(generatePersona(PP_DEV_SEEDS[1])));
    expect(worldDigest(world)).toBe(worldDigest(generateWorld()));
  });

  test('every development task is solvable only through session 1, and session 2 names none of the facts', () => {
    for (const p of world.personas) expect([p.id, solvabilityProblems(p)]).toEqual([p.id, []]);
    expect(tasks.length).toBe(32);
    expect(tasks.filter(t => t.kind === 'prep').length).toBe(16);
    expect(tasks.filter(t => t.kind === 'reply' && t.correction_kind === 'role').length).toBe(0);
  });

  test('matchers recognize the written forms and nothing adjacent', () => {
    const d = dateMatcher('2026-10-21');
    for (const s of ['Oct 21', 'October 21st', 'oct. 21', '21 October', '10/21', '2026-10-21', 'Wednesday, October 21 at 10:00']) expect([s, matches(d, s)]).toEqual([s, true]);
    for (const s of ['Oct 2', 'October 211', '10/2', '2026-10-22', 'Oct 12']) expect([s, matches(d, s)]).toEqual([s, false]);
    expect(matches(seatsMatcher(40), '40-seat plan')).toBe(true);
    expect(matches(seatsMatcher(40), '140 seats')).toBe(false);
    expect(matches(priceMatcher(22), '$22/seat')).toBe(true);
    expect(matches(priceMatcher(22), '$22 per user per month')).toBe(true);
    expect(matches(priceMatcher(22), '$122 per seat')).toBe(false);
    expect(matches(roleMatcher('VP of Procurement'), 'she is Vice President of Procurement')).toBe(true);
    expect(matches(roleMatcher('CISO'), 'the CISOs')).toBe(false);
  });

  test('a sealed seed is minted only outside the repository, 0600, and only its commitment leaves', () => {
    expect(() => mintSealedSeed(join(process.cwd(), 'eval/data/sealed-here'))).toThrow(/outside the repository/);
    const dir = mkdtempSync(join(tmpdir(), 'pp-custody-'));
    try {
      const { path, commitment } = mintSealedSeed(dir);
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(sealedCommitment(saved.seed)).toBe(commitment);
      expect(() => mintSealedSeed(dir)).toThrow(/minted once/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('program-primary scorer', () => {
  const t = tasks.find(x => x.correction_kind === 'seats')!;
  const g = t.gold;
  const oldH = humanDate(g.date.old_iso), newH = humanDate(g.date.new_iso);

  test('the truthful deliverable passes and is complete', () => {
    for (const x of tasks) expect([x.id, scoreAnswer(x, truth(x)).failed, scoreAnswer(x, truth(x)).complete]).toEqual([x.id, false, true]);
  });

  test('a change stated as a change is not stale; the old value asserted as current is', () => {
    const ok = `Meeting moved from ${oldH} to ${newH}. Quote: ${g.correction.corrected.label} (not ${g.correction.stale.label}). I owe them ${g.commitment.label}.`;
    expect(scoreAnswer(t, ok)).toMatchObject({ failed: false, complete: true });
    const stale = `Meeting: ${oldH}. Quote: ${g.correction.corrected.label}. I owe them ${g.commitment.label}.`;
    expect(scoreAnswer(t, stale).kinds).toEqual(['stale_date']);
    const staleOnly = `Meeting: ${newH}. Quote: ${g.correction.stale.label}. I owe them ${g.commitment.label}.`;
    expect(scoreAnswer(t, staleOnly).kinds).toEqual(['stale_correction']);
    // v2 tolerates a stale mention when the current value is also stated (amendment 1); v1 failed it.
    const both = `Meeting: ${newH}. Quote: ${g.correction.stale.label}, or maybe ${g.correction.corrected.label}. I owe them ${g.commitment.label}.`;
    expect(scoreAnswer(t, both).failed).toBe(false);
    expect(scoreAnswer(t, both, { version: 't0-score-v1' }).kinds).toEqual(['stale_correction']);
  });

  test('v2 reads prose: an outdated record cited, a page slug and a disambiguation are not failures', () => {
    const ns = g.namesake.find(m => m.label.startsWith('namesake meeting'))!;
    const nsDate = humanDate(ns.label.replace('namesake meeting ', ''));
    const prose = [
      `**Pilot kickoff: ${newH}.** Your daily note still says "kickoff ${oldH}." That note is out of date.`,
      `[Meeting record](meetings/${g.date.old_iso}-x-kickoff). Terms: ${g.correction.corrected.label}; earlier notes say ${g.correction.stale.label}, which is wrong.`,
      `Not to be confused with the other contact of the same first name, whose meeting is ${nsDate}.`,
      `I owe them ${g.commitment.label}.`,
    ].join('\n');
    expect(scoreAnswer(t, prose)).toMatchObject({ failed: false, complete: true });
    expect(scoreAnswer(t, prose, { version: 't0-score-v1' }).failed).toBe(true);
    expect(scoreAnswer(t, `${truth(t)} Their meeting is ${nsDate}.`).kinds).toEqual(['unsupported']);
  });

  test('a missed commitment, a namesake value, an empty answer and an execution error each fail', () => {
    expect(scoreAnswer(t, `Meeting: ${newH}. Quote: ${g.correction.corrected.label}.`).kinds).toEqual(['missed_commitment']);
    const ns = g.namesake.find(m => m.label.startsWith('namesake commitment'))!;
    expect(scoreAnswer(t, `${truth(t)} Also ${ns.label.replace('namesake commitment: ', '')}.`).kinds).toEqual(['unsupported']);
    expect(scoreAnswer(t, '').kinds).toContain('execution_error');
    expect(scoreAnswer(t, truth(t), { executionError: 'provider error 500' }).kinds).toEqual(['execution_error']);
  });

  test('omissions are reported, not failures; complete needs every fact', () => {
    const s = scoreAnswer(t, `Next meeting is on the calendar. I owe them ${g.commitment.label}.`);
    expect(s).toMatchObject({ failed: false, complete: false, omissions: { date: true, correction: true } });
    expect(aggregate([s, scoreAnswer(t, '')])).toMatchObject({ runs: 2, failures: 1, complete: 0 });
  });

  test('the scorer rejects the five fake systems on every development task', () => {
    assertScorerRejectsFakeSystems<PPTask, string>({
      category: 'program-primary',
      probes: tasks,
      space: {
        truth,
        empty: () => '',
        everything: x => [truth(x), staleAnswer(x), ...nsValues(x)].join(' '),
        refusal: () => 'I could not find anything about this meeting in your notes.',
        stale: staleAnswer,
        wrongSource: x => nsValues(x).join('; '),
      },
      score: answers => {
        const failures = answers.filter((a, i) => scoreAnswer(tasks[i], a).failed).length;
        return { pass: failures === 0, detail: `${failures}/${answers.length} runs failed` };
      },
    });
  });
});
