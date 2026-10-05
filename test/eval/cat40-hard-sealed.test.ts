/**
 * Cat 40 Hard sealed validation variant (eval/generators/hard-sealed/,
 * docs/benchmarks/cat40-hard/SEALED.md). Hermetic: no network, no paid calls.
 *
 * The seeds below are test seeds. The sealed seed is chosen privately and is
 * never one of them.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_HARD_KNOBS, H5_SESSIONS, HARD_FAMILIES, RECORDED, knobDigest, type HardKnobs, type HardTask, type HardWorld } from '../../eval/generators/hard/schema.ts';
import type { UserStatement } from '../../eval/generators/hard/semantics.ts';
import { hardWorldProblems } from '../../eval/generators/hard/validate.ts';
import { normalizeValue } from '../../eval/runner/cat40/score.ts';
import { scoreHardTask } from '../../eval/runner/cat40/score-hard.ts';
import { HARD_WORLD_GENERATORS, checkHardWorld } from '../../eval/runner/cat40/hard.ts';
import { generateHardWorld } from '../../eval/generators/model-ladder-hard.ts';
import { buildSealed, generateSealedWorld, resolveH5, sealedWorldDigest, SEALED_VERSION } from '../../eval/generators/hard-sealed/generate.ts';

const SEEDS = [101, 202, 303];
const SMALL_LARGE: HardKnobs = { ...DEFAULT_HARD_KNOBS, large_extra_accounts: 300, large_nondeciding_per_account: 2 };
const worlds = new Map<number, ReturnType<typeof buildSealed>>(SEEDS.map(s => [s, buildSealed(s)]));
const world = worlds.get(SEEDS[0])!.world;

function score(w: HardWorld, t: HardTask, answer: unknown) {
  const recording = (t.sessions ?? []).map(() => ({ final: { answer: RECORDED }, stop: 'submitted' as const }));
  return scoreHardTask(w, t, [...recording, { final: { answer } as never, stop: 'submitted' as const }]);
}

describe('sealed generator: determinism and identity', () => {
  test('the same seed and knobs give the same world, byte for byte', () => {
    for (const s of SEEDS) expect(sealedWorldDigest(generateSealedWorld(s))).toBe(sealedWorldDigest(worlds.get(s)!.world));
  });

  test('different seeds give different worlds', () => {
    expect(new Set(SEEDS.map(s => sealedWorldDigest(worlds.get(s)!.world))).size).toBe(SEEDS.length);
  });

  test('a knob change changes the world and its knob digest', () => {
    const w = generateSealedWorld(SEEDS[0], { ...DEFAULT_HARD_KNOBS, emails_per_account: 3 });
    expect(w.knob_digest).toBe(knobDigest({ ...DEFAULT_HARD_KNOBS, emails_per_account: 3 }));
    expect(sealedWorldDigest(w)).not.toBe(sealedWorldDigest(world));
  });

  test('worlds carry the sealed version, the knob turn cap and about 4,000 documents', () => {
    for (const s of SEEDS) {
      const w = worlds.get(s)!.world;
      expect(w.version).toBe(SEALED_VERSION);
      expect(w.version).toBe('hard-sealed');
      expect(w.mode).toBe('hard');
      expect(w.max_turns).toBe(DEFAULT_HARD_KNOBS.max_turns);
      expect(w.docs.length).toBeGreaterThan(3000);
      expect(w.docs.length).toBeLessThan(5000);
      for (const f of HARD_FAMILIES) expect(w.tasks.filter(t => t.family === f).length).toBe(DEFAULT_HARD_KNOBS.tasks_per_family);
    }
  });
});

describe('sealed generator: world invariants', () => {
  test('every validate.ts invariant passes on several seeds', () => {
    for (const s of SEEDS) expect(hardWorldProblems(worlds.get(s)!.world)).toEqual([]);
  });

  test('the runner accepts the world: registered under hard-sealed and regenerated to the same digest', () => {
    expect(typeof HARD_WORLD_GENERATORS['hard-sealed']).toBe('function');
    expect(() => checkHardWorld(world, 'sealed-test')).not.toThrow();
  });

  test('a tampered world is refused by the runner', () => {
    const bad: HardWorld = { ...world, tasks: world.tasks.map((t, i) => (i === 0 ? { ...t, question: `${t.question} ` } : t)) };
    expect(() => checkHardWorld(bad, 'sealed-test')).toThrow(/HARD_WORLD_MISMATCH/);
  });

  test('family shapes follow the specification', () => {
    const k = DEFAULT_HARD_KNOBS;
    for (const t of world.tasks) {
      if (t.family === 'H1') {
        const n = t.answer_kind === 'set' ? t.gold.members!.length : t.gold.count!;
        expect(n).toBeGreaterThanOrEqual(k.h1_min_members);
        expect(n).toBeLessThanOrEqual(k.h1_max_members);
        expect(t.predicate).toBeDefined();
        expect(t.near_miss!.in_evidence).toBeLessThanOrEqual(Math.min(k.h1_near_miss_cap, t.near_miss!.total));
      } else {
        expect(t.answer_kind).toBe('value');
        expect(t.gold.wrong!.length).toBeGreaterThan(0);
      }
      if (t.family === 'H2') expect(t.gold.evidence.length).toBeGreaterThanOrEqual(k.h2_changes_min + 1);
      if (t.family === 'H3') expect(t.accounts.length).toBeGreaterThanOrEqual(1 + k.h3_lookalikes_min);
      if (t.family === 'H4') {
        expect(t.gold.evidence.length).toBeGreaterThanOrEqual(k.h4_sources_min);
        expect(t.gold.evidence.length).toBeLessThanOrEqual(k.h4_sources_max);
      }
      if (t.family === 'H5') {
        expect(t.sessions!.length).toBe(H5_SESSIONS - 1);
        for (const s of t.sessions!) expect(s).toContain(RECORDED);
        expect(t.oracle_notes!.length).toBe(1);
      }
    }
  });

  test('alias conventions: short-names are declared as Ref: and Short-name and lead every alias list', () => {
    const cards = world.docs.filter(d => d.id.endsWith('/card'));
    expect(cards.every(d => /\| Short-name \| [A-Z]{3}-\d{2} \|/.test(d.body))).toBe(true);
    expect(world.docs.filter(d => d.type === 'contract').every(d => /Ref: [A-Z]{3}-\d{2}/.test(d.body))).toBe(true);
    expect(world.entities.every(e => /^[A-Z]{3}-\d{2}$/.test(e.aliases[0]))).toBe(true);
    expect(world.entities.filter(e => e.aliases.length > 1).length).toBeGreaterThanOrEqual(DEFAULT_HARD_KNOBS.tasks_per_family / 2);
  });

  test('document organization: folders by area and short-name, no dates in document ids', () => {
    const areas = new Set(world.docs.map(d => d.id.split('/')[0]));
    expect([...areas].sort()).toEqual(['assistant', 'bulletin', 'mail', 'minutes', 'paper', 'registry', 'support']);
    expect(world.docs.some(d => /\d{4}-\d{2}-\d{2}|20\d{2}[-_/]?\d{2}/.test(d.id))).toBe(false);
  });
});

describe('sealed generator: scorer contract', () => {
  test('every gold answer scores as a success and an empty answer fails', () => {
    for (const t of world.tasks) {
      const gold = t.answer_kind === 'set' ? JSON.stringify(t.gold.members!.map(m => m.names[0])) : t.answer_kind === 'count' ? String(t.gold.count) : t.gold.answer![0];
      expect(score(world, t, gold).success).toBe(true);
      expect(score(world, t, null).success).toBe(false);
    }
  });

  test('value tasks reject every wrong value, a hedge naming one, and accept an array answer', () => {
    for (const t of world.tasks.filter(t => t.answer_kind === 'value')) {
      for (const w of t.gold.wrong!) expect(score(world, t, w).success).toBe(false);
      expect(score(world, t, `${t.gold.answer![0]} (or ${t.gold.wrong![0]})`).success).toBe(false);
      expect(score(world, t, [t.gold.answer![0]]).success).toBe(true);
    }
  });

  test('set tasks: aliases count, a missing, extra or unknown member fails, prose is unparseable', () => {
    const sets = world.tasks.filter(t => t.answer_kind === 'set');
    expect(sets.length).toBeGreaterThan(0);
    for (const t of sets) {
      const m = t.gold.members!;
      expect(score(world, t, JSON.stringify(m.map(x => x.names.at(-1)))).success).toBe(true);
      expect(score(world, t, JSON.stringify(m.slice(1).map(x => x.names[0]))).success).toBe(false);
      const outsider = world.entities.find(e => !m.some(x => x.id === e.id))!;
      expect(score(world, t, JSON.stringify([...m.map(x => x.names[0]), outsider.name])).success).toBe(false);
      expect(score(world, t, JSON.stringify([...m.map(x => x.names[0]), 'Nobody Holdings'])).success).toBe(false);
      expect(score(world, t, m.map(x => x.names[0]).join(', ')).unparseable_set).toBe(true);
    }
  });

  test('count tasks: a leading integer passes, off by one and date digits first fail', () => {
    for (const t of world.tasks.filter(t => t.answer_kind === 'count')) {
      expect(score(world, t, `${t.gold.count} customers`).success).toBe(true);
      expect(score(world, t, String(t.gold.count! + 1)).success).toBe(false);
      expect(score(world, t, `As of ${t.predicate!.as_of}, ${t.gold.count}`).success).toBe(false);
    }
  });

  test('accepted and wrong values never contain one another after normalization', () => {
    for (const t of world.tasks.filter(t => t.answer_kind === 'value')) {
      const acc = t.gold.answer!.map(normalizeValue);
      for (const w of t.gold.wrong!.map(normalizeValue)) for (const a of acc) expect(a.includes(w) || w.includes(a)).toBe(false);
    }
  });
});

describe('sealed generator: H5 dependency', () => {
  for (const s of SEEDS) {
    test(`seed ${s}: the key follows from the chain, depends on two sessions, and each required fact changes or voids it`, () => {
      const { world: w, h5 } = worlds.get(s)!;
      for (const t of w.tasks.filter(t => t.family === 'H5')) {
        const led = h5.find(x => x.task === t.id)!;
        const facts = t.session_facts!;
        const said = (fs: typeof facts): UserStatement[] => fs.map(f => ({ session: f.session, key: f.key, value: f.value }));
        expect(resolveH5(led.account, said(facts), led.directory)).toBe(t.gold.answer![0]);
        const required = facts.filter(f => f.required);
        expect(new Set(required.map(f => f.session)).size).toBeGreaterThanOrEqual(2);
        expect(facts.some(f => f.superseded_by !== undefined)).toBe(true);
        for (const f of facts) {
          const without = resolveH5(led.account, said(facts.filter(x => x !== f)), led.directory);
          if (f.required) expect(without).not.toBe(t.gold.answer![0]);
          else expect(without).toBe(t.gold.answer![0]);
        }
      }
    });
  }
});

describe('sealed generator: 50k scale', () => {
  const large = generateSealedWorld(SEEDS[0], SMALL_LARGE, 'large');
  const base = generateSealedWorld(SEEDS[0], SMALL_LARGE);

  test('extends the 4k world: same tasks and keys, documents appended, base digest recorded', () => {
    expect(hardWorldProblems(large)).toEqual([]);
    expect(large.scale).toBe('large');
    expect(large.base_digest).toBe(sealedWorldDigest(base));
    expect(large.docs.slice(0, base.docs.length)).toEqual(base.docs);
    expect(large.docs.length).toBeGreaterThan(base.docs.length);
    expect(large.entities.slice(0, base.entities.length)).toEqual(base.entities);
    large.tasks.forEach((t, i) => {
      expect(t.gold).toEqual(base.tasks[i].gold);
      expect(t.question).toBe(base.tasks[i].question);
    });
  });

  test('is deterministic and accepted by the runner', () => {
    expect(sealedWorldDigest(generateSealedWorld(SEEDS[0], SMALL_LARGE, 'large'))).toBe(sealedWorldDigest(large));
    expect(() => checkHardWorld(large, 'sealed-large-test')).not.toThrow();
  });

  test('appended accounts add near misses but no H1 members', () => {
    const appended = new Set(large.entities.slice(base.entities.length).map(e => e.id));
    for (const t of large.tasks.filter(t => t.family === 'H1')) {
      for (const m of t.gold.members ?? []) expect(appended.has(m.id)).toBe(false);
      expect(t.near_miss!.total).toBeGreaterThanOrEqual(base.tasks.find(b => b.id === t.id)!.near_miss!.total);
    }
  });
});

describe('sealed generator: independence from the main generator', () => {
  /** A sentence's template: digits and capitalized words become placeholders, punctuation goes. */
  function templates(w: HardWorld): Map<string, string> {
    const out = new Map<string, string>();
    const texts = [...w.docs.map(d => d.body), ...w.tasks.flatMap(t => [t.question, ...(t.sessions ?? [])])];
    for (const text of texts) for (const sentence of text.split(/\n|(?<=[.!?])\s+/)) {
      const toks = sentence.replace(/[|>*`#=_]/g, ' ').split(/\s+/).filter(Boolean)
        .map(x => (/\d/.test(x) ? '#' : /^[A-Z]/.test(x) ? 'N' : x.toLowerCase().replace(/[^a-z'-]/g, ''))).filter(Boolean);
      const sk: string[] = [];
      for (const x of toks) if (!((x === 'N' || x === '#') && sk[sk.length - 1] === x)) sk.push(x);
      if (sk.filter(x => x !== 'N' && x !== '#').length < 4) continue;
      out.set(sk.join(' '), sentence);
    }
    return out;
  }
  function grams(w: HardWorld, n: number): Set<string> {
    const out = new Set<string>();
    for (const text of [...w.docs.map(d => d.body), ...w.tasks.flatMap(t => [t.question, ...(t.sessions ?? [])])]) {
      const words = text.toLowerCase().replace(/[^a-z' ]+/g, ' ').split(/\s+/).filter(Boolean);
      for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
    }
    return out;
  }

  const main = generateHardWorld();
  const sealedTemplates = templates(world);

  test('no sealed sentence template appears in a main-generator world', () => {
    const mainTemplates = templates(main);
    expect(sealedTemplates.size).toBeGreaterThan(300);
    expect(mainTemplates.size).toBeGreaterThan(100);
    expect([...sealedTemplates.keys()].filter(k => mainTemplates.has(k))).toEqual([]);
  });

  test('no six-word run of sealed text appears in a main-generator world', () => {
    const mainGrams = grams(main, 6);
    expect([...grams(world, 6)].filter(g => mainGrams.has(g))).toEqual([]);
  });

  test('company, people and document ids differ from the main world', () => {
    expect(world.principal.name).not.toBe(main.principal.name);
    const mainNames = new Set(main.entities.flatMap(e => [e.name, ...e.aliases]).map(normalizeValue));
    expect(world.entities.filter(e => mainNames.has(normalizeValue(e.name)))).toEqual([]);
    const mainIds = new Set(main.docs.map(d => d.id));
    expect(world.docs.filter(d => mainIds.has(d.id))).toEqual([]);
  });
});
