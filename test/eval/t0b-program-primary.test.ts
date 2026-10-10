import { describe, expect, test } from 'bun:test';
import { CODE_STOPWORDS, custodianWorld, DEFAULT_KNOBS, generateHardPersona, mintSealedSeeds, sealedSeedsCommitment, shortCode, V2_KNOBS, generateHardWorld, hardDigest, hardSolvabilityProblems, PPH_BASELINE_SEEDS, PPH_CALIBRATION_SEEDS, PPH_DEV_SEEDS, PPH_FRESH_SEEDS_ALIAS, PPH_FRESH_SEEDS_C1, type HardTask } from '../../eval/generators/program-primary-hard-gen.ts';
import { humanDate } from '../../eval/generators/program-primary-gen.ts';
import { scoreItems } from '../../eval/runner/t0/score.ts';
import { main as runT0b, scriptedOracle, scriptedSaver, variantDocs } from '../../eval/runner/t0b-program-primary.ts';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  test('the fresh-seed check seeds are new, distinct and solvable', () => {
    expect(new Set(PPH_FRESH_SEEDS_C1).size).toBe(8);
    expect(PPH_FRESH_SEEDS_C1.filter(s => PPH_DEV_SEEDS.includes(s))).toEqual([]);
    expect(generateHardWorld(PPH_FRESH_SEEDS_C1).personas.flatMap(hardSolvabilityProblems)).toEqual([]);
  });

  test('the alias-stack fresh seeds are new, distinct and solvable', () => {
    expect(new Set(PPH_FRESH_SEEDS_ALIAS).size).toBe(8);
    expect(PPH_FRESH_SEEDS_ALIAS.filter(s => PPH_DEV_SEEDS.includes(s) || PPH_FRESH_SEEDS_C1.includes(s))).toEqual([]);
    expect(generateHardWorld(PPH_FRESH_SEEDS_ALIAS).personas.flatMap(hardSolvabilityProblems)).toEqual([]);
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

describe('program-primary-hard v2 (unique short codes) and custodian worlds', () => {
  const v2 = generateHardWorld(PPH_DEV_SEEDS, V2_KNOBS);
  const v2Tasks = v2.personas.flatMap(p => p.tasks);

  test('version 1 worlds are unchanged: the preregistered baseline digest still reproduces', () => {
    expect(hardDigest(generateHardWorld(PPH_BASELINE_SEEDS))).toBe('dccafc6f7cc28c44ce5f255713762739359f1f76ab526d99975707fedfe8504a');
    expect(generateHardWorld(PPH_BASELINE_SEEDS).version).toBe('program-primary-hard-v1');
  });

  test('every company code is unique within a brain and never a stopword; worlds stay solvable', () => {
    expect(v2.version).toBe('program-primary-hard-v2');
    for (const p of v2.personas) {
      const codes = p.docs.filter(d => d.type === 'company').map(d => shortCode(d.title));
      expect([p.id, codes.length - new Set(codes).size]).toEqual([p.id, 0]);
      expect(codes.filter(c => CODE_STOPWORDS.has(c))).toEqual([]);
      expect([p.id, hardSolvabilityProblems(p)]).toEqual([p.id, []]);
    }
  });

  test('version 1 does collide (why version 2 exists): BRL is declared twice in development persona 20261103', () => {
    const p = generateHardPersona(20261103);
    expect(p.docs.filter(d => d.type === 'company' && shortCode(d.title) === 'BRL').length).toBe(2);
  });

  test('the scorer rejects the five fake systems on version 2 tasks', () => {
    assertScorerRejectsFakeSystems<HardTask, string>({
      category: 'program-primary-hard-v2', probes: v2Tasks,
      space: { truth, empty: () => '', everything: t => [truth(t), stale(t), ...nsValues(t)].join(' '), refusal: () => 'I could not find this in your notes.', stale, wrongSource: t => nsValues(t).join('; ') },
      score: answers => { const f = answers.filter((a, i) => scoreItems(v2Tasks[i].gold, a).failed).length; return { pass: f === 0, detail: `${f}/${answers.length} failed` }; },
    });
  });

  test('a custodian world carries no seed, renames personas and matches its commitment', () => {
    const seeds = [123456789, 987654321];
    const w = custodianWorld(seeds);
    expect(w.custodian).toBe(true);
    expect(w.commitment).toBe(sealedSeedsCommitment(seeds));
    expect(w.personas.map(p => p.id)).toEqual(['sealed-01', 'sealed-02']);
    const text = JSON.stringify(w);
    for (const s of seeds) expect(text.includes(String(s))).toBe(false);
    for (const p of w.personas) for (const t of p.tasks) expect([t.persona, t.seed, t.id.startsWith(p.id)]).toEqual([p.id, 0, true]);
  });

  test('sealed seeds are minted only outside the repository, 0600, once', () => {
    expect(() => mintSealedSeeds(join(import.meta.dir, 'sealed-tmp'), 2)).toThrow(/outside the repository/);
    const dir = mkdtempSync(join(tmpdir(), 't0b-custody-'));
    const { path, commitment } = mintSealedSeeds(dir, 3);
    const file = JSON.parse(readFileSync(path, 'utf8')) as { seeds: number[]; commitment: string };
    expect(file.seeds.length).toBe(3);
    expect(sealedSeedsCommitment(file.seeds)).toBe(commitment);
    expect(Bun.file(path).size).toBeGreaterThan(0);
    expect((statSync(path).mode & 0o777)).toBe(0o600);
    expect(() => mintSealedSeeds(dir, 3)).toThrow(/minted once/);
  });

  test('the runner refuses a world inside the repository, a non-custodian world and a wrong digest before building anything', async () => {
    await expect(runT0b(['--gbrain', 'x@y', '--world', join(import.meta.dir, 'world.json'), '--expect-digest', 'a'])).rejects.toThrow(/outside the repository/);
    const dir = mkdtempSync(join(tmpdir(), 't0b-world-'));
    const plain = join(dir, 'plain.json'), sealed = join(dir, 'sealed.json');
    await Bun.write(plain, JSON.stringify(generateHardWorld([PPH_DEV_SEEDS[0]], V2_KNOBS)));
    await Bun.write(sealed, JSON.stringify(custodianWorld([123456789])));
    await expect(runT0b(['--gbrain', 'x@y', '--world', plain, '--expect-digest', 'a'])).rejects.toThrow(/custodian world/);
    await expect(runT0b(['--gbrain', 'x@y', '--world', sealed, '--expect-digest', 'a'])).rejects.toThrow(/expect-digest/);
    await expect(runT0b(['--gbrain', 'x@y', '--world', sealed, '--seeds', '20261101'])).rejects.toThrow(/drop --seeds/);
  });
});
