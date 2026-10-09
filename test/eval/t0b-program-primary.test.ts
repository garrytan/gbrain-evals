import { describe, expect, test } from 'bun:test';
import { DEFAULT_KNOBS, generateHardPersona, generateHardWorld, hardDigest, hardSolvabilityProblems, PPH_BASELINE_SEEDS, PPH_CALIBRATION_SEEDS, PPH_DEV_SEEDS, type HardTask } from '../../eval/generators/program-primary-hard-gen.ts';
import { humanDate } from '../../eval/generators/program-primary-gen.ts';
import { scoreItems } from '../../eval/runner/t0/score.ts';
import { scriptedOracle, scriptedSaver, variantDocs } from '../../eval/runner/t0b-program-primary.ts';
import { assertScorerRejectsFakeSystems } from '../../eval/runner/mutation-kit.ts';

const world = generateHardWorld(PPH_BASELINE_SEEDS);
const tasks = world.personas.flatMap(p => p.tasks);
const truth = (t: HardTask) => `Meeting: ${humanDate(t.gold.date.new_iso)}. Current: ${t.gold.corrections.map(c => c.corrected.label).join('; ')}. I owe them ${t.gold.commitments.map(c => c.label).join(' and ')}.`;
const stale = (t: HardTask) => `Meeting: ${humanDate(t.gold.date.old_iso)}. Current: ${t.gold.corrections.map(c => c.stale.label).join('; ')}.`;
const nsValues = (t: HardTask) => t.gold.namesake.map(m => m.label.replace(/^namesake (?:meeting |commitment: )?/, '')).map(v => /^\d{4}-\d\d-\d\d$/.test(v) ? humanDate(v) : v);

describe('program-primary-hard generator', () => {
  test('deterministic, about 1,000 pages per persona, and calibration seeds are disjoint from baseline seeds', () => {
    expect(hardDigest(generateHardPersona(PPH_DEV_SEEDS[0]))).toBe(hardDigest(generateHardPersona(PPH_DEV_SEEDS[0])));
    expect(hardDigest(generateHardPersona(PPH_DEV_SEEDS[0]))).not.toBe(hardDigest(generateHardPersona(PPH_DEV_SEEDS[1])));
    for (const p of world.personas) expect(p.docs.length).toBeGreaterThanOrEqual(700);
    expect(PPH_CALIBRATION_SEEDS.filter(s => PPH_BASELINE_SEEDS.includes(s))).toEqual([]);
    expect(DEFAULT_KNOBS).toEqual({ tasks_per_persona: 3, session1: 'explicit', scale: 1, hop: true, supersession: true });
    expect(tasks.length).toBe(24);
  });

  test('every fact lives off its page: stale values on pages, current values only in item docs, none in session 2', () => {
    for (const p of world.personas) expect([p.id, hardSolvabilityProblems(p)]).toEqual([p.id, []]);
    for (const t of tasks) expect(/brain|memory|notes/i.test(t.session2)).toBe(false);
  });

  test('mutant brains drop exactly the item docs', () => {
    const p = world.personas[0];
    const base = new Set(variantDocs(p, 'base').map(d => d.id));
    const nocorr = new Set(variantDocs(p, 'nocorr').map(d => d.id));
    const noitems = new Set(variantDocs(p, 'noitems').map(d => d.id));
    for (const t of p.tasks) {
      for (const id of t.gold.correction_docs) { expect(base.has(id)).toBe(true); expect(nocorr.has(id)).toBe(false); }
      for (const id of t.gold.item_docs) expect(noitems.has(id)).toBe(false);
      expect(nocorr.has(t.gold.item_docs.find(id => id.includes('technical-review'))!)).toBe(true);
    }
  });
});

describe('T0b scorer (t0b-score-v1)', () => {
  test('rejects the five fake systems on every baseline task', () => {
    assertScorerRejectsFakeSystems<HardTask, string>({
      category: 'program-primary-hard', probes: tasks,
      space: { truth, empty: () => '', everything: t => [truth(t), stale(t), ...nsValues(t)].join(' '), refusal: () => 'I could not find this in your notes.', stale, wrongSource: t => nsValues(t).join('; ') },
      score: answers => { const f = answers.filter((a, i) => scoreItems(tasks[i].gold, a).failed).length; return { pass: f === 0, detail: `${f}/${answers.length} failed` }; },
    });
  });

  test('addressing the superseded procurement contact fails; naming the handoff passes', () => {
    const t = tasks[0];
    const sup = t.gold.corrections.find(c => c.kind === 'superseded')!;
    const old = sup.stale.label.split(' ')[0], cur = sup.corrected.label.split(' ')[0];
    expect(scoreItems(t.gold, `Hi ${t.contact_name.split(' ')[0]}, hi ${old}, ${truth(t).replace(/Current: [^.]*\./, `Current: ${t.gold.corrections[0].corrected.label}.`)}`).kinds).toEqual(['stale_correction']);
    expect(scoreItems(t.gold, `${truth(t)} ${old} moved to the platform team; ${cur} now leads procurement.`).failed).toBe(false);
  });

  test('a missing commitment of two fails and is named', () => {
    const t = tasks[0];
    const one = truth(t).replace(` and ${t.gold.commitments[1].label}`, '');
    expect(scoreItems(t.gold, one)).toMatchObject({ failed: true, kinds: ['missed_commitment'], commitments_missed: [t.gold.commitments[1].label] });
  });
});

describe('T0b scripted plumbing', () => {
  test('the saver writes the session-1 promise; the oracle reads every evidence page and reports what it saw', () => {
    const p = world.personas[0], t = p.tasks[0];
    const s = scriptedSaver(p, t);
    expect(s([]).name).toBe('get_page');
    expect(String(s([{ name: 'get_page', args: {}, result: '{"revision":"r"}' }]).args.content)).toContain(t.gold.commitments[1].label);
    const o = scriptedOracle(t);
    const history = t.gold.evidence.map(id => ({ name: 'get_page', args: { slug: id }, result: p.docs.find(d => d.id === id)?.body ?? 'Error: not found' }));
    expect(o(history.slice(0, 2)).args.slug).toBe(t.gold.evidence[2]);
    const answer = String(o(history).args.answer);
    expect(scoreItems(t.gold, `${answer} I owe them ${t.gold.commitments[1].label}.`).failed).toBe(false);
  });
});
