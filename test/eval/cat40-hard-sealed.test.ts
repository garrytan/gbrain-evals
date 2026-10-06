/**
 * Cat 40 Hard sealed validation variant (eval/generators/hard-sealed/,
 * docs/benchmarks/cat40-hard/SEALED.md). Hermetic: no network, no paid calls.
 *
 * The seeds below are test seeds. The sealed seed is chosen privately and is
 * never one of them.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_HARD_KNOBS, H5_SESSIONS, HARD_FAMILIES, HARD_V2_KNOB_KEYS, RECORDED, knobDigest, validateKnobs, type HardEntity, type HardKnobs, type HardReference, type HardTask, type HardWorld } from '../../eval/generators/hard/schema.ts';
import { managerKnownOn, managerReadingsOn, managerReference, nameRegistry, type UserStatement, type ValueEvent } from '../../eval/generators/hard/semantics.ts';
import { STAFF } from '../../eval/generators/hard-sealed/pools.ts';
import { hardWorldProblems } from '../../eval/generators/hard/validate.ts';
import { normalizeValue } from '../../eval/runner/cat40/score.ts';
import { scoreHardTask } from '../../eval/runner/cat40/score-hard.ts';
import { HARD_WORLD_GENERATORS, checkHardWorld } from '../../eval/runner/cat40/hard.ts';
import { generateHardWorld } from '../../eval/generators/model-ladder-hard.ts';
import { buildSealed, generateSealedWorld, resolveH5, sealedWorldDigest, SEALED_VERSION, SEALED_VERSION_V2 } from '../../eval/generators/hard-sealed/generate.ts';

const SEEDS = [101, 202, 303];
const SMALL_LARGE: HardKnobs = { ...DEFAULT_HARD_KNOBS, large_extra_accounts: 300, large_nondeciding_per_account: 2 };
/** The main generator's calibration round-3 knobs: the reference-form keys plus larger H2 and H3 knobs. */
const R3 = validateKnobs(JSON.parse(readFileSync(resolve(import.meta.dir, '../../docs/benchmarks/cat40-hard/knobs.round-3.json'), 'utf8')), 'knobs.round-3.json');
/** Round-4 knobs (amendment A2): multi-account H2 to H5 questions with 2 or 3 items, smaller H1. */
const R4 = validateKnobs(JSON.parse(readFileSync(resolve(import.meta.dir, '../../docs/benchmarks/cat40-hard/knobs.round-4.json'), 'utf8')), 'knobs.round-4.json');
const R3_WITHOUT_FORMS = Object.fromEntries(Object.entries(R3).filter(([k]) => !(HARD_V2_KNOB_KEYS as readonly string[]).includes(k))) as unknown as HardKnobs;
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

// ─── Reference forms (knob schema 2, WORLD_SCHEMA.md "Reference forms") ───

/** Digests of the sealed worlds before reference forms existed (commit 1b3020b), at the default knobs. */
const V1_DIGESTS: Record<number, string> = {
  101: '1413fe31f4c62396a49988733e189ae37f0e5dbd69934b8bbdee95b1f5128293',
  202: 'df394a0b4d32add83041a06686d2ecf3e37b0a24c3d09b47ba671f24d5d54023',
  303: '055fe1c2bb323220fda6a51a9162810bc9b7b7131c9bb2208d4caae560c76404',
};
const V1_LARGE_DIGEST_101 = 'dd1dbe0aa77387cfa93419d0cd24fec3d1baecc9eaad35758edd481f66e74472';

const v2Worlds = new Map<number, HardWorld>(SEEDS.map(s => [s, generateSealedWorld(s, R3)]));
const v2 = v2Worlds.get(SEEDS[0])!;

const textOf = (w: HardWorld) => { const m = new Map(w.docs.map(d => [d.id, `${d.title}\n${d.body}`])); return (id: string) => m.get(id)!; };
/** Lookups over one world, built once. Resolution documents are the documents no reference points at. */
const contexts = new WeakMap<HardWorld, ReturnType<typeof makeContext>>();
function makeContext(w: HardWorld) {
  const withRefs = new Set(w.references!.map(r => r.doc));
  return { text: textOf(w), docs: new Map(w.docs.map(d => [d.id, d])), entities: new Map(w.entities.map(e => [e.id, e])), withRefs, resolution: w.docs.filter(d => !withRefs.has(d.id)) };
}
const contextOf = (w: HardWorld) => { if (!contexts.has(w)) contexts.set(w, makeContext(w)); return contexts.get(w)!; };
const managerEvents = (e: HardEntity): ValueEvent[] => e.refs!.managers.map(m => ({ value: m.name, effective: m.effective, recorded: m.recorded, doc: m.doc, kind: 'change' }));
const namesOf = (e: HardEntity) => [e.name, ...e.aliases.filter(a => !e.refs!.codes.includes(a) && !e.refs!.nicknames.includes(a))];
/** What a reader searches for to resolve a reference: the code or handle itself, or `<descriptor> account`. */
const needleOf = (r: HardReference, e: HardEntity) => (r.form === 'manager' ? `${e.refs!.descriptor} account` : r.text);

/**
 * Whether `set` lets a reader tie reference `r` to its customer's canonical name using resolution documents only:
 * the first hop through a resolution document dated on or before the record that holds the needle and a name of the
 * customer, a second hop (rename or merger document) when that name is not the canonical one, and for the lead form
 * every lead-timeline document recorded on or before the record.
 */
function tiedIn(w: HardWorld, set: ReadonlySet<string>, resolution: readonly string[], r: HardReference): boolean {
  const { text, docs, entities } = contextOf(w), e = entities.get(r.entity)!;
  const date = docs.get(r.doc)!.date, names = namesOf(e);
  if (r.form === 'name' && r.text === e.name) return true;
  const first = r.form === 'name' ? [r.text] : resolution.filter(id => docs.get(id)!.date <= date && text(id).includes(needleOf(r, e))).flatMap(id => names.filter(n => text(id).includes(n)));
  const reached = first.includes(e.name) || resolution.some(id => text(id).includes(e.name) && first.some(n => text(id).includes(n)));
  const timeline = r.form !== 'manager' || e.refs!.managers.every(m => m.recorded > date || set.has(m.doc));
  return reached && timeline;
}

/** Every reference resolves to exactly one entity, introduced by a resolution document dated on or before it. */
function checkResolvable(w: HardWorld): void {
  const { docs, text, resolution, entities: ents } = contextOf(w), registry = nameRegistry(w.entities, normalizeValue);
  const byDescriptor = new Map<string, HardEntity[]>();
  for (const x of w.entities) byDescriptor.set(x.refs!.descriptor, [...(byDescriptor.get(x.refs!.descriptor) ?? []), x]);
  for (const e of w.entities) for (const m of e.refs!.managers) expect(docs.get(m.doc)?.date).toBe(m.recorded);
  let checked = 0;
  for (const r of w.references!) {
    const e = ents.get(r.entity)!, date = docs.get(r.doc)!.date;
    if (r.form === 'name') { expect(registry.get(normalizeValue(r.text))).toBe(r.entity); continue; }
    const holders = r.form === 'code' ? w.entities.filter(x => x.refs!.codes.includes(r.text))
      : r.form === 'nickname' ? w.entities.filter(x => x.refs!.nicknames.includes(r.text))
        : [...byDescriptor.values()].flat().filter(x => r.text.endsWith(`'s ${x.refs!.descriptor} account`) && [...managerReadingsOn(managerEvents(x), date)].some(m => r.text === managerReference(m, x.refs!.descriptor)));
    expect(holders.map(x => x.id)).toEqual([r.entity]);
    if (r.form === 'manager') expect(r.text).toBe(managerReference(managerKnownOn(managerEvents(e), date)!, e.refs!.descriptor));
    const intro = resolution.filter(d => d.date <= date && text(d.id).includes(needleOf(r, e)) && namesOf(e).some(n => text(d.id).includes(n)));
    expect(intro.length).toBeGreaterThan(0);
    checked++;
  }
  expect(checked).toBeGreaterThan(1000);
}

/** Oracle `relevant` and `gold.evidence` tie every reference they hold to its entity's canonical name. */
function checkOracle(w: HardWorld): void {
  const byDoc = new Map<string, HardReference[]>();
  for (const r of w.references!) byDoc.set(r.doc, [...(byDoc.get(r.doc) ?? []), r]);
  const { withRefs } = contextOf(w);
  for (const t of w.tasks) for (const ids of [t.relevant, t.gold.evidence]) {
    const set = new Set(ids), resolution = ids.filter(id => !withRefs.has(id));
    const untied = ids.flatMap(id => byDoc.get(id) ?? []).filter(r => !tiedIn(w, set, resolution, r));
    expect({ task: t.id, untied: untied.length }).toEqual({ task: t.id, untied: 0 });
  }
}

describe('sealed generator: reference forms', () => {
  test('knob files without the reference keys reproduce the earlier worlds byte for byte (4k and 50k)', () => {
    for (const s of SEEDS) expect(sealedWorldDigest(worlds.get(s)!.world)).toBe(V1_DIGESTS[s]);
    expect(sealedWorldDigest(generateSealedWorld(101, DEFAULT_HARD_KNOBS, 'large'))).toBe(V1_LARGE_DIGEST_101);
  });

  test('direct_name_share 1 writes the reference-free world apart from version and knob fields', () => {
    const knobs: HardKnobs = { ...DEFAULT_HARD_KNOBS, direct_name_share: 1, code_ref_weight: 1, nickname_ref_weight: 1, manager_ref_weight: 1 };
    const w = generateSealedWorld(101, knobs);
    expect(w).toMatchObject({ version: SEALED_VERSION_V2, knob_schema: 2, knob_digest: knobDigest(knobs) });
    expect(w.references).toBeUndefined();
    const strip = ({ version: _v, knob_schema: _s, knobs: _k, knob_digest: _d, ...rest }: HardWorld) => rest;
    expect(JSON.stringify(strip(w))).toBe(JSON.stringify(strip(world)));
  });

  test('round-3 knobs without the reference keys build a valid reference-free world', () => {
    const w = generateSealedWorld(101, R3_WITHOUT_FORMS);
    expect(w.version).toBe(SEALED_VERSION);
    expect(w.references).toBeUndefined();
    expect(hardWorldProblems(w)).toEqual([]);
  });

  test('worlds carry the v2 version and knob schema, pass every invariant and are accepted by the runner', () => {
    for (const s of SEEDS) {
      const w = v2Worlds.get(s)!;
      expect(w).toMatchObject({ version: SEALED_VERSION_V2, knob_schema: 2, knob_digest: knobDigest(R3) });
      expect(hardWorldProblems(w)).toEqual([]);
      expect(w.entities.every(e => e.refs)).toBe(true);
    }
    expect(typeof HARD_WORLD_GENERATORS[SEALED_VERSION_V2]).toBe('function');
    expect(() => checkHardWorld(v2, 'sealed-v2-test')).not.toThrow();
    const bad: HardWorld = { ...v2, references: v2.references!.map((r, i) => (i === 0 ? { ...r, text: `${r.text}x` } : r)) };
    expect(() => checkHardWorld(bad, 'sealed-v2-test')).toThrow(/HARD_WORLD/);
  });

  test('the same seed and knobs give the same world; seeds differ', () => {
    expect(sealedWorldDigest(generateSealedWorld(SEEDS[0], R3))).toBe(sealedWorldDigest(v2));
    expect(new Set(SEEDS.map(s => sealedWorldDigest(v2Worlds.get(s)!))).size).toBe(SEEDS.length);
  });

  test('all four forms appear, and about direct_name_share of references use the name', () => {
    for (const w of v2Worlds.values()) {
      const n = (f: string) => w.references!.filter(r => r.form === f).length;
      for (const f of ['name', 'code', 'nickname', 'manager']) expect(n(f)).toBeGreaterThan(100);
      expect(n('name') / w.references!.length).toBeGreaterThan(R3.direct_name_share! - 0.05);
      expect(n('name') / w.references!.length).toBeLessThan(R3.direct_name_share! + 0.05);
    }
  });

  test('every reference resolves to exactly one customer from documents dated on or before it', () => {
    for (const w of v2Worlds.values()) checkResolvable(w);
  });

  test('records referring by short-name, handle or lead never name the customer, and handle or lead records never give the short-name', () => {
    const { text, entities: ents } = contextOf(v2);
    for (const r of v2.references!.filter(x => x.form !== 'name')) {
      const e = ents.get(r.entity)!, body = text(r.doc);
      expect(namesOf(e).some(n => body.includes(n))).toBe(false);
      if (r.form !== 'code') expect(e.refs!.codes.some(c => new RegExp(`\\b${c}\\b`).test(body))).toBe(false);
    }
  });

  test('oracle evidence and relevant documents carry every resolution document their references need', () => {
    for (const w of v2Worlds.values()) checkOracle(w);
  });

  test('reference forms change no fact: questions and answer keys match the reference-free world from the same knobs', () => {
    const plain = generateSealedWorld(SEEDS[0], R3_WITHOUT_FORMS);
    expect(v2.tasks.length).toBe(plain.tasks.length);
    v2.tasks.forEach((t, i) => {
      const p = plain.tasks[i];
      expect([t.id, t.question, t.sessions, t.predicate, t.gold.answer, t.gold.wrong, t.gold.count]).toEqual([p.id, p.question, p.sessions, p.predicate, p.gold.answer, p.gold.wrong, p.gold.count]);
      expect(t.gold.members?.map(m => m.id)).toEqual(p.gold.members?.map(m => m.id));
    });
  });

  test('every gold answer scores as a success, including set answers that use desk handles', () => {
    for (const t of v2.tasks) {
      const gold = t.answer_kind === 'set' ? JSON.stringify(t.gold.members!.map(m => m.names.at(-1))) : t.answer_kind === 'count' ? String(t.gold.count) : t.gold.answer![0];
      expect(score(v2, t, gold).success).toBe(true);
    }
  });

  test('desk handles: unique two-word handles that hold no customer name, short-name or first word and sit inside no other identifier', () => {
    const large = generateSealedWorld(SEEDS[0], { ...R3, large_extra_accounts: 300, large_nondeciding_per_account: 2 }, 'large');
    for (const w of [v2, large]) {
      const own = w.entities.map(e => e.refs!.nicknames[0]);
      expect(new Set(own).size).toBe(own.length);
      const handles = w.entities.flatMap(e => e.refs!.nicknames);
      expect(new Set(handles).size).toBe(handles.length);
      expect(handles.every(h => /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(h))).toBe(true);
      const names = w.entities.flatMap(e => namesOf(e)), codes = w.entities.flatMap(e => e.refs!.codes), firsts = names.map(n => n.split(' ')[0].toLowerCase());
      for (const h of handles) {
        const low = h.toLowerCase();
        expect(firsts.some(f => low.includes(f))).toBe(false);
        expect([...names, ...codes].some(x => x.toLowerCase().includes(low) || low.includes(x.toLowerCase()))).toBe(false);
        expect(handles.some(o => o !== h && o.includes(h))).toBe(false);
      }
    }
  });

  test('event records get opaque ids; record cards, profiles and rename or merger documents stay readable', () => {
    const withRefs = new Set(v2.references!.map(r => r.doc));
    const codes = v2.entities.flatMap(e => e.refs!.codes.map(c => c.toLowerCase()));
    for (const id of withRefs) {
      expect(codes.some(c => id.includes(c))).toBe(false);
      expect(/^(paper|mail|minutes|assistant|registry)\/[a-z]{10}$|^support\/hd-\d{5}$|^bulletin\/issue-\d{3}$/.test(id)).toBe(true);
    }
    const resolution = v2.docs.filter(d => !withRefs.has(d.id));
    expect(resolution.every(d => /^(registry|mail)\/[a-z]{3}-\d{2}\/(card|profile|slip-\d{2}|fw-\d{2})$/.test(d.id))).toBe(true);
    expect(resolution.filter(d => d.id.endsWith('/profile')).length).toBe(resolution.filter(d => d.id.endsWith('/card')).length);
    expect(v2.docs.some(d => /\d{4}-\d{2}-\d{2}|20\d{2}[-_/]?\d{2}/.test(d.id))).toBe(false);
  });

  test('50k: appended customers have their own leads, keys stay, base documents and references are kept', () => {
    const knobs = { ...R3, large_extra_accounts: 300, large_nondeciding_per_account: 2 };
    const base = generateSealedWorld(SEEDS[0], knobs), large = generateSealedWorld(SEEDS[0], knobs, 'large');
    expect(hardWorldProblems(large)).toEqual([]);
    expect(large.base_digest).toBe(sealedWorldDigest(base));
    expect(large.docs.slice(0, base.docs.length)).toEqual(base.docs);
    expect(large.references!.slice(0, base.references!.length)).toEqual(base.references!);
    large.tasks.forEach((t, i) => expect(t.gold).toEqual(base.tasks[i].gold));
    const appended = large.entities.slice(base.entities.length);
    expect(appended.flatMap(e => e.refs!.managers.map(m => m.name)).some(m => (STAFF as readonly string[]).includes(m))).toBe(false);
    expect(sealedWorldDigest(generateSealedWorld(SEEDS[0], knobs, 'large'))).toBe(sealedWorldDigest(large));
  });

  test('independence: no sealed reference-form sentence template or six-word run appears in a main-generator v2 world', () => {
    const main = generateHardWorld(undefined, R3);
    expect(main.references?.length).toBeGreaterThan(0);
    const words = (w: HardWorld) => {
      const out = new Set<string>();
      for (const text of w.docs.map(d => d.body)) {
        const ws = text.toLowerCase().replace(/[^a-z' ]+/g, ' ').split(/\s+/).filter(Boolean);
        for (let i = 0; i + 6 <= ws.length; i++) out.add(ws.slice(i, i + 6).join(' '));
      }
      return out;
    };
    const mainGrams = words(main);
    expect([...words(v2)].filter(g => mainGrams.has(g))).toEqual([]);
    const skeleton = (sentence: string) => sentence.replace(/[|>*`#=_"]/g, ' ').split(/\s+/).filter(Boolean)
      .map(x => (/\d/.test(x) ? '#' : /^[A-Z]/.test(x) ? 'N' : x.toLowerCase().replace(/[^a-z'-]/g, ''))).filter(Boolean).join(' ');
    const sentences = (w: HardWorld) => new Set(w.docs.flatMap(d => d.body.split(/\n|(?<=[.!?])\s+/)).map(skeleton).filter(k => k.split(' ').filter(x => x !== 'N' && x !== '#').length >= 4));
    const mainSentences = sentences(main);
    expect([...sentences(v2)].filter(k => mainSentences.has(k))).toEqual([]);
  });
});

// ─── Multi-account questions (knob schema 3, WORLD_SCHEMA.md "Multi-account questions") ───

describe('sealed generator: multi-account questions', () => {
  const r4Worlds = new Map(SEEDS.map(s => [s, buildSealed(s, R4)]));
  const r4 = r4Worlds.get(SEEDS[0])!.world;
  const multi = (w: HardWorld) => w.tasks.filter(t => t.answer_kind === 'values');

  test('multi_account_max 1 writes the reference-form world apart from the knob fields', () => {
    const knobs: HardKnobs = { ...R3, multi_account_min: 1, multi_account_max: 1 };
    const w = generateSealedWorld(SEEDS[0], knobs);
    expect(w).toMatchObject({ version: SEALED_VERSION_V2, knob_schema: 3, knob_digest: knobDigest(knobs) });
    const strip = ({ knob_schema: _s, knobs: _k, knob_digest: _d, ...rest }: HardWorld) => rest;
    expect(JSON.stringify(strip(w))).toBe(JSON.stringify(strip(v2)));
  });

  test('round-4 worlds pass every invariant, are deterministic and are accepted by the runner', () => {
    for (const s of SEEDS) {
      const w = r4Worlds.get(s)!.world;
      expect(w).toMatchObject({ version: SEALED_VERSION_V2, knob_schema: 3, knob_digest: knobDigest(R4) });
      expect(hardWorldProblems(w)).toEqual([]);
    }
    expect(sealedWorldDigest(generateSealedWorld(SEEDS[0], R4))).toBe(sealedWorldDigest(r4));
    expect(new Set(SEEDS.map(s => sealedWorldDigest(r4Worlds.get(s)!.world))).size).toBe(SEEDS.length);
    expect(() => checkHardWorld(r4, 'sealed-r4-test')).not.toThrow();
  });

  test('H2 to H5 questions have k items in the contract wording; H1 stays single and within the smaller member range', () => {
    for (const w of [...r4Worlds.values()].map(x => x.world)) {
      for (const t of w.tasks) {
        if (t.family === 'H1') {
          const n = t.answer_kind === 'set' ? t.gold.members!.length : t.gold.count!;
          expect(n).toBeGreaterThanOrEqual(R4.h1_min_members);
          expect(n).toBeLessThanOrEqual(R4.h1_max_members);
          continue;
        }
        expect(t.answer_kind).toBe('values');
        const items = t.gold.items!, k = items.length;
        expect(k).toBeGreaterThanOrEqual(R4.multi_account_min!);
        expect(k).toBeLessThanOrEqual(R4.multi_account_max!);
        expect(t.gold.answer).toBeUndefined();
        expect(t.gold.wrong).toBeUndefined();
        const lines = t.question.split('\n');
        expect(lines[0]).toBe(`Answer each of these ${k} questions:`);
        expect(lines.slice(1, -1).map((l, n) => l.startsWith(`${n + 1}. `))).toEqual(Array(k).fill(true));
        expect(lines.length).toBe(k + 2);
        expect(lines.at(-1)).toBe(`Answer with a JSON array of the ${k} answers in the order asked, as one string in \`answer\`, for example ["first answer","second answer"].`);
        expect(t.variant.split('|').length).toBe(k);
        for (const it of items) {
          expect(t.accounts).toContain(it.account);
          expect(it.answer.length).toBeGreaterThan(0);
          expect(it.wrong.length).toBeGreaterThan(0);
        }
        expect(new Set(t.accounts).size).toBe(t.accounts.length);
      }
      expect(multi(w).length).toBe(4 * R4.tasks_per_family);
    }
  });

  test('no shortcut: accounts of different items share no descriptor, name first word, short-name prefix or account lead', () => {
    for (const w of [...r4Worlds.values()].map(x => x.world)) {
      const ents = new Map(w.entities.map(e => [e.id, e]));
      for (const t of multi(w)) {
        const keys = t.gold.items!.map(it => {
          const e = ents.get(it.account)!;
          return {
            descriptor: new Set([e.refs!.descriptor]), first: new Set(namesOf(e).map(n => n.split(' ')[0])),
            prefix: new Set(e.refs!.codes.map(c => c.slice(0, 3))), leads: new Set(e.refs!.managers.map(m => m.name)),
          };
        });
        for (let a = 0; a < keys.length; a++) for (let b = a + 1; b < keys.length; b++) for (const f of ['descriptor', 'first', 'prefix', 'leads'] as const) {
          expect({ task: t.id, f, shared: [...keys[a][f]].filter(x => keys[b][f].has(x)) }).toEqual({ task: t.id, f, shared: [] });
        }
      }
    }
  });

  test('every reference resolves to exactly one customer, and every task\'s oracle documents tie each reference to its customer', () => {
    for (const { world: w } of r4Worlds.values()) { checkResolvable(w); checkOracle(w); }
  });

  test('each item carries its own evidence: the evidence holds a record about every item\'s account, and relevant holds the evidence', () => {
    const about = new Map<string, Set<string>>();
    for (const r of r4.references!) about.set(r.doc, (about.get(r.doc) ?? new Set()).add(r.entity));
    for (const t of multi(r4)) {
      for (const id of t.gold.evidence) expect(t.relevant).toContain(id);
      for (const it of t.gold.items!) expect(t.gold.evidence.some(id => about.get(id)?.has(it.account))).toBe(true);
    }
  });

  test('H5: sessions carry every chain\'s statement in item order; each item\'s key follows from its chain and needs two sessions', () => {
    for (const { world: w, h5 } of r4Worlds.values()) {
      for (const t of multi(w).filter(x => x.family === 'H5')) {
        expect(t.sessions!.length).toBe(H5_SESSIONS - 1);
        for (const s of t.sessions!) expect(s).toContain(RECORDED);
        const facts = t.session_facts!;
        expect(facts.map(f => f.session)).toEqual([...facts.map(f => f.session)].sort((x, y) => x - y));
        for (const f of facts) if (f.superseded_by !== undefined) expect(facts.some(x => x.session === f.superseded_by && x.key === f.key)).toBe(true);
        expect(t.oracle_notes![0].body.split('\n')[0]).toBe('Recorded from team updates (sessions 1 to 4):');
        const said = (fs: typeof facts): UserStatement[] => fs.map(f => ({ session: f.session, key: f.key, value: f.value }));
        t.gold.items!.forEach((it, j) => {
          const led = h5.find(x => x.task === t.id && x.item === j)!;
          expect(led.account).toBe(it.account);
          expect(resolveH5(led.account, said(facts), led.directory)).toBe(it.answer[0]);
          const own = facts.filter(f => f.key.includes(it.account));
          expect(new Set(own.filter(f => f.required).map(f => f.session)).size).toBeGreaterThanOrEqual(2);
          for (const f of own.filter(x => x.required)) expect(resolveH5(led.account, said(facts.filter(x => x !== f)), led.directory)).not.toBe(it.answer[0]);
        });
        for (const n of [1, 2, 3, 4]) expect(facts.filter(f => f.session === n).length).toBeGreaterThanOrEqual(t.gold.items!.length);
        const firstSession = t.gold.items!.map(it => facts.findIndex(f => f.session === 1 && f.key.includes(it.account))).filter(x => x >= 0);
        expect(firstSession).toEqual([...firstSession].sort((x, y) => x - y));
      }
    }
  });

  test('scorer: the gold array passes; a swapped, short, prose or wrong-valued answer fails', () => {
    for (const t of multi(r4)) {
      const gold = t.gold.items!.map(it => it.answer[0]);
      expect(score(r4, t, JSON.stringify(gold)).success).toBe(true);
      expect(score(r4, t, gold).success).toBe(true);
      const reversed = [...gold].reverse();
      if (reversed.some((g, n) => !t.gold.items![n].answer.includes(g))) expect(score(r4, t, JSON.stringify(reversed)).success).toBe(false);
      expect(score(r4, t, JSON.stringify(gold.slice(1))).success).toBe(false);
      expect(score(r4, t, gold.join(', ')).unparseable_set).toBe(true);
      expect(score(r4, t, JSON.stringify([t.gold.items![0].wrong[0], ...gold.slice(1)])).success).toBe(false);
    }
  });

  test('50k at the full round-4 knobs: base documents and keys kept, every invariant passes', () => {
    const large = generateSealedWorld(SEEDS[0], R4, 'large');
    expect(hardWorldProblems(large)).toEqual([]);
    expect(large.base_digest).toBe(sealedWorldDigest(r4));
    expect(large.docs.slice(0, r4.docs.length)).toEqual(r4.docs);
    large.tasks.forEach((t, i) => expect(t.gold).toEqual(r4.tasks[i].gold));
    expect(large.entities.length - r4.entities.length).toBe(R4.large_extra_accounts + r4.tasks.filter(t => t.family === 'H3').reduce((n, t) => n + (t.gold.items?.length ?? 1), 0));
    checkOracle(large);
  }, 180_000);
});
